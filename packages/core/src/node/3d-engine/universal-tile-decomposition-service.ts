/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * U.S. PATENT APPLICATION NO. 64/168,583 (PATENT PENDING)
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC and Elias John Green. Unauthorized copying, modification,
 * distribution, or use of this file, via any medium, is strictly prohibited
 * without explicit written permission.
 ********************************************************************************/

import * as fs from 'fs';
import * as path from 'path';
import { NativeCppCompilerService } from './native-compiler-service';
import { carryOverInputMaterial, ensurePipelineBinary, parseTelemetryLine, rawMeshReadIssues, runPipelineBinary } from './native-pipeline-binary';
import { GeneratorFailedError, MissingInputError } from '../../common/errors/pipeline-errors';

export type UtdraPipelineMode = 'probe' | 'slicer' | 'bridge';

/**
 * The footprint of an elevated deck and the heights of the ground under it and of the deck, in the tile's own
 * coordinates (metres). The bridge carver removes the near-vertical triangles inside this box; it does not find
 * bridges itself.
 */
export interface UtdraSpanBox {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
    groundY: number;
    deckY: number;
}

export interface UtdraServiceOptions {
    /** The tile to process. Required: no stand-in mesh is built. */
    inputGlbPath: string;
    outputGlbPath?: string;
    /** Required: what to do with the tile. */
    mode: UtdraPipelineMode;
    /** Required for mode 'slicer': the part of the tile above this elevation is kept. */
    sliceElevationCutoff?: number;
    /** Required for mode 'bridge'. */
    span?: UtdraSpanBox;
    /** Mode 'bridge': refuse a span whose clearance (deckY - groundY) is below this. */
    minVoidHeightMeters?: number;
}

/**
 * What the pipeline measured on the mesh it wrote (the input, for a probe). Fractions are of the surface area, by
 * the slope of each triangle's face normal. Nothing here is a classification or a confidence.
 */
export interface UtdraTelemetry {
    mode: UtdraPipelineMode;
    boundsMin: [number, number, number];
    boundsMax: [number, number, number];
    /** maxY - minY, metres. */
    reliefMeters: number;
    /** Total triangle area, square metres. */
    surfaceAreaM2: number;
    slopeAreaFractions: {
        /** Slope under 15 degrees. */
        horizontal: number;
        /** 15 to 45 degrees. */
        inclined: number;
        /** 45 to 75 degrees. */
        steep: number;
        /** 75 degrees and steeper. */
        vertical: number;
    };
    /**
     * Area-weighted mean (2G - R - B) / (2G + R + B) of the vertex colours; absent when the input has no vertex colours
     * (the value would describe the reader's white default, not the tile).
     */
    vertexGreenIndex?: number;
    /** The most common horizontal orientation of the vertical faces, degrees modulo 90; absent when there are none. */
    dominantWallYawDeg?: number;
    degenerateTriangles: number;
    inputTriangles: number;
    outputTriangles: number;
    /** Mode 'bridge': triangles removed inside the span. */
    removedTriangles: number;
    processingTimeMs: number;
}

export interface UtdraResult {
    success: boolean;
    mode: UtdraPipelineMode;
    /** Absent for a probe, which writes no GLB. */
    outputGlbPath?: string;
    glbBuffer?: Buffer;
    glbBase64?: string;
    telemetry: UtdraTelemetry;
    stdout: string;
    stderr?: string;
}

function hasVertexColors(glb: Buffer): boolean {
    try {
        const json = JSON.parse(glb.toString('utf8', 20, 20 + glb.readUInt32LE(12)));
        return (json.meshes || []).some((m: any) => (m?.primitives || []).some((p: any) => p?.attributes?.COLOR_0 !== undefined));
    } catch {
        return false;
    }
}

function parseVec3(value: string | undefined, key: string): [number, number, number] {
    const parts = (value || '').split(',').map(Number);
    if (parts.length !== 3 || parts.some(n => !Number.isFinite(n))) {
        throw new GeneratorFailedError('cpp', `the UTDRA pipeline reported no valid ${key}`);
    }
    return parts as [number, number, number];
}

/**
 * UTDRA on a given tile: measure it (probe), keep what lies above an elevation (slicer), or remove the near-vertical
 * triangles inside a span box the caller gives (bridge). It classifies nothing: the probe reports measurements only.
 * The output keeps the input's own material. A missing input, a failed native run, or telemetry without a value is
 * an error.
 */
export class UniversalTileDecompositionService {
    private compiler: NativeCppCompilerService;
    private binaryPath: string;

    constructor(compiler?: NativeCppCompilerService) {
        this.compiler = compiler || new NativeCppCompilerService();
        const candidateBinaries = [
            path.resolve(process.cwd(), 'build/run_utdra_pipeline'),
            path.resolve(__dirname, '../../../../build/run_utdra_pipeline'),
            path.resolve(process.cwd(), 'build/3d-native/run_utdra_pipeline'),
            path.resolve(__dirname, '../../../../build/3d-native/run_utdra_pipeline')
        ];
        this.binaryPath = candidateBinaries.find(p => fs.existsSync(p)) || candidateBinaries[0];
    }

    /** The native UTDRA binary, rebuilt when it is missing or older than its source. */
    async ensureBinary(): Promise<string> {
        const candidateSources = [
            path.resolve(process.cwd(), 'scripts/run_utdra_pipeline.cpp'),
            path.resolve(__dirname, '../../../../scripts/run_utdra_pipeline.cpp')
        ];
        return ensurePipelineBinary({
            binaryPath: this.binaryPath,
            sourcePath: candidateSources.find(p => fs.existsSync(p)) || candidateSources[0],
            includeDir: this.compiler.getSdkIncludePath()
        });
    }

    /** Runs one mode on the given tile. */
    async run(options: UtdraServiceOptions): Promise<UtdraResult> {
        const inputGlbPath = options?.inputGlbPath;
        if (!inputGlbPath) {
            throw new MissingInputError('UTDRA', 'inputGlbPath', 'give the tile to process; no stand-in mesh is built');
        }
        if (!fs.existsSync(inputGlbPath)) {
            throw new MissingInputError('UTDRA', 'inputGlbPath', `${inputGlbPath} does not exist`);
        }
        const mode = options.mode;
        if (mode !== 'probe' && mode !== 'slicer' && mode !== 'bridge') {
            throw new MissingInputError('UTDRA', 'mode', `must be probe, slicer or bridge (got ${JSON.stringify(mode)})`);
        }
        // The native reader ignores node transforms (so measurements and output would be misplaced) and the writer
        // writes one material and no textures (so a written tile would lose them): refuse such a tile instead.
        const inputGlb = fs.readFileSync(inputGlbPath);
        const issues = rawMeshReadIssues(inputGlb);
        const blocking = [...issues.geometry, ...(mode === 'probe' ? [] : issues.content)];
        if (blocking.length) {
            throw new MissingInputError('UTDRA', 'inputGlbPath',
                `${inputGlbPath} cannot be processed faithfully: ${blocking.join('; ')}. Use a tile with baked transforms, one material and no textures (the clay extraction).`);
        }
        const args = ['--input', inputGlbPath, '--mode', mode];
        let outputGlbPath: string | undefined;
        if (mode === 'slicer') {
            if (typeof options.sliceElevationCutoff !== 'number' || !Number.isFinite(options.sliceElevationCutoff)) {
                throw new MissingInputError('UTDRA', 'sliceElevationCutoff', 'the elevation to slice at is required');
            }
            args.push('--sliceY', String(options.sliceElevationCutoff));
        }
        if (mode === 'bridge') {
            const span = options.span;
            const keys: Array<keyof UtdraSpanBox> = ['minX', 'maxX', 'minZ', 'maxZ', 'groundY', 'deckY'];
            if (!span || keys.some(k => typeof span[k] !== 'number' || !Number.isFinite(span[k]))) {
                throw new MissingInputError('UTDRA', 'span', 'give the deck footprint and heights {minX, maxX, minZ, maxZ, groundY, deckY} in the tile\'s coordinates; the carver does not find bridges itself');
            }
            args.push('--span', keys.map(k => String(span[k])).join(','));
            if (options.minVoidHeightMeters !== undefined) args.push('--minVoidHeight', String(options.minVoidHeightMeters));
        }
        if (mode !== 'probe') {
            const artifactsDir = path.resolve(process.cwd(), '.scratchbox', 'artifacts');
            fs.mkdirSync(artifactsDir, { recursive: true });
            outputGlbPath = options.outputGlbPath || path.join(artifactsDir, `utdra_${mode}_${Date.now()}.glb`);
            args.push('--output', outputGlbPath);
        }

        const bin = await this.ensureBinary();
        let run: { stdout: string; stderr: string };
        try {
            run = await runPipelineBinary(bin, args);
        } catch (err: any) {
            const detail = String(err?.stderr || err?.message || err).trim().replace(/^Error:\s*/, '');
            if (err?.code === 2) throw new MissingInputError('UTDRA', 'a valid input', detail);
            throw new GeneratorFailedError('cpp', `UTDRA (${mode}) failed on ${inputGlbPath}: ${detail}`);
        }

        const values = parseTelemetryLine(run.stdout, 'the UTDRA pipeline');
        const num = (key: string): number => {
            const n = Number(values.get(key));
            if (!values.has(key) || !Number.isFinite(n)) {
                throw new GeneratorFailedError('cpp', `the UTDRA pipeline reported no ${key}`);
            }
            return n;
        };
        const wallYaw = values.get('WALL_YAW');
        const telemetry: UtdraTelemetry = {
            mode,
            boundsMin: parseVec3(values.get('BOUNDS_MIN'), 'BOUNDS_MIN'),
            boundsMax: parseVec3(values.get('BOUNDS_MAX'), 'BOUNDS_MAX'),
            reliefMeters: num('RELIEF'),
            surfaceAreaM2: num('AREA'),
            slopeAreaFractions: {
                horizontal: num('HORIZONTAL'),
                inclined: num('INCLINED'),
                steep: num('STEEP'),
                vertical: num('VERTICAL')
            },
            vertexGreenIndex: hasVertexColors(inputGlb) ? num('GREEN_INDEX') : undefined,
            dominantWallYawDeg: wallYaw === undefined || wallYaw === 'none' ? undefined : num('WALL_YAW'),
            degenerateTriangles: num('DEGENERATE_TRIS'),
            inputTriangles: num('INPUT_TRIS'),
            outputTriangles: num('OUTPUT_TRIS'),
            removedTriangles: num('REMOVED_TRIS'),
            processingTimeMs: num('RUNTIME_MS')
        };
        if (!(telemetry.inputTriangles > 0)) {
            throw new GeneratorFailedError('cpp', `the UTDRA pipeline read no triangles from ${inputGlbPath}`);
        }
        if (!outputGlbPath) {
            return { success: true, mode, telemetry, stdout: run.stdout, stderr: run.stderr };
        }
        if (!fs.existsSync(outputGlbPath)) {
            throw new GeneratorFailedError('cpp', `the UTDRA pipeline wrote no GLB to ${outputGlbPath}`);
        }
        // The writer's stock material is replaced with the input's own (clay stays clay).
        const glbBuffer = carryOverInputMaterial(inputGlb, outputGlbPath);
        return {
            success: true,
            mode,
            outputGlbPath,
            glbBuffer,
            glbBase64: glbBuffer.toString('base64'),
            telemetry,
            stdout: run.stdout,
            stderr: run.stderr
        };
    }

    /** Measures a tile without changing it (no GLB is written). */
    async probeTile(inputGlbPath: string): Promise<UtdraTelemetry> {
        return (await this.run({ inputGlbPath, mode: 'probe' })).telemetry;
    }

    /** Removes the near-vertical triangles inside the given span box (see UtdraSpanBox). */
    async carveBridgeUnderpass(
        inputGlbPath: string,
        span: UtdraSpanBox,
        options: { minVoidHeightMeters?: number; outputGlbPath?: string } = {}
    ): Promise<UtdraResult> {
        return this.run({ ...options, inputGlbPath, mode: 'bridge', span });
    }

    /** Keeps the part of the tile above the elevation, clipping straddling triangles (Sutherland-Hodgman). */
    async sliceElevation(
        inputGlbPath: string,
        sliceElevationCutoff: number,
        options: { outputGlbPath?: string } = {}
    ): Promise<UtdraResult> {
        return this.run({ ...options, inputGlbPath, mode: 'slicer', sliceElevationCutoff });
    }
}

/**
 * UTDRA Service alias for UniversalTileDecompositionService.
 */
export const UtdraService = UniversalTileDecompositionService;
export type UtdraService = UniversalTileDecompositionService;

/**
 * ULDRA Service alias for UniversalTileDecompositionService (supporting user request naming).
 */
export const UldraService = UniversalTileDecompositionService;
export type UldraService = UniversalTileDecompositionService;
