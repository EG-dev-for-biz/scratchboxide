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
import { ensurePipelineBinary, parseTelemetryLine, rawMeshReadIssues, runPipelineBinary } from './native-pipeline-binary';
import { GeneratorFailedError, MissingInputError } from '../../common/errors/pipeline-errors';

export type GeographicDomain =
    | 'UrbanHighRiseCore'
    | 'SuburbanResidential'
    | 'IndustrialLogisticsPort'
    | 'CivilInfrastructure'
    | 'MountainAlpineCanyon'
    | 'ForestWoodlandCanopy'
    | 'AquaticCoastalFluvial'
    | 'AridDesertBadlands'
    | 'HybridInterface'
    | (string & {});

export type UtdraPipelineMode = 'full' | 'probe' | 'slicer' | 'bridge' | 'terrain';

export interface UtdraServiceOptions {
    /** The tile to process. Required: no stand-in mesh is built. */
    inputGlbPath: string;
    outputGlbPath?: string;
    mode?: UtdraPipelineMode;
    anchorCoord?: {
        latitude: number;
        longitude: number;
        altitudeMeters?: number;
    };
    /** Required for mode 'slicer'. */
    sliceElevationCutoff?: number;
    minVoidHeightMeters?: number;
    streamStdout?: boolean;
}

export interface UtdraTelemetry {
    dominantDomain: GeographicDomain;
    confidence: number;
    totalReliefDeltaY: number;
    planarityScore: number;
    verticalityScore: number;
    vegetationIndexNdvi: number;
    pitchedRoofRatio: number;
    waterSurfaceRatio: number;
    underpassVoidRatio: number;
    dominantStreetYawDeg: number;
    inputTriangles: number;
    outputTriangles: number;
    processingTimeMs: number;
}

export interface UtdraResult {
    success: boolean;
    mode: UtdraPipelineMode;
    outputGlbPath: string;
    glbBuffer?: Buffer;
    glbBase64?: string;
    telemetry: UtdraTelemetry;
    stdout: string;
    stderr?: string;
}

/**
 * Service exposing the Universal Tile Decomposition & Rectification Algorithm (UTDRA / ULDRA) on a given tile.
 *
 * Core Capabilities:
 * - Macro-Domain Telemetry & Ingestion Classification across 9 Canonical Geographic Domains
 * - Sutherland-Hodgman Non-Destructive Triangle-Plane Elevation Slicing
 * - Multi-Level Bridge, Viaduct, & Flyover Void Underpass Clearance
 * - Slope-Stratified Natural Biomes (Bedrock Triplanar, Talus Scree, Alpine Turf)
 * - Cohesive Hybrid Decomposition: Rectified Extruded Shafts & Preserved Sculptural Crowns
 *
 * Every run needs an input GLB; a missing input, a failed native run, or telemetry without a value is an error.
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

    /**
     * Decomposes and rectifies the given tile (or only probes, slices or carves it, by mode).
     */
    async decomposeTile(options: UtdraServiceOptions): Promise<UtdraResult> {
        const inputGlbPath = options?.inputGlbPath;
        if (!inputGlbPath) {
            throw new MissingInputError('UTDRA', 'inputGlbPath', 'give the tile to process; no stand-in mesh is built');
        }
        if (!fs.existsSync(inputGlbPath)) {
            throw new MissingInputError('UTDRA', 'inputGlbPath', `${inputGlbPath} does not exist`);
        }
        const mode = options.mode ?? 'full';
        // The native reader ignores node transforms (so measurements and output would be misplaced) and the writer
        // drops textures (so a written tile would come back untextured): refuse such a tile instead.
        const issues = rawMeshReadIssues(fs.readFileSync(inputGlbPath));
        const blocking = [...issues.geometry, ...(mode === 'probe' ? [] : issues.content)];
        if (blocking.length) {
            throw new MissingInputError('UTDRA', 'inputGlbPath',
                `${inputGlbPath} cannot be processed faithfully: ${blocking.join('; ')}. Use a tile with baked transforms and no textures (the clay extraction).`);
        }
        if (mode === 'slicer' && (typeof options.sliceElevationCutoff !== 'number' || !Number.isFinite(options.sliceElevationCutoff))) {
            throw new MissingInputError('UTDRA', 'sliceElevationCutoff', 'the elevation to slice at is required');
        }
        const bin = await this.ensureBinary();
        const artifactsDir = path.resolve(process.cwd(), '.scratchbox', 'artifacts');
        fs.mkdirSync(artifactsDir, { recursive: true });
        const outputGlbPath = options.outputGlbPath || path.join(artifactsDir, `utdra_${Date.now()}.glb`);

        const args = ['--input', inputGlbPath, '--output', outputGlbPath, '--mode', mode];
        if (options.sliceElevationCutoff !== undefined) args.push('--sliceY', String(options.sliceElevationCutoff));
        if (options.minVoidHeightMeters !== undefined) args.push('--minVoidHeight', String(options.minVoidHeightMeters));
        if (options.anchorCoord) args.push('--lat', String(options.anchorCoord.latitude), '--lon', String(options.anchorCoord.longitude));

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
        const dominantDomain = values.get('DOMAIN');
        if (!dominantDomain) throw new GeneratorFailedError('cpp', 'the UTDRA pipeline reported no DOMAIN');
        const telemetry: UtdraTelemetry = {
            dominantDomain,
            confidence: num('CONFIDENCE'),
            totalReliefDeltaY: num('RELIEF'),
            planarityScore: num('PLANARITY'),
            verticalityScore: num('VERTICALITY'),
            vegetationIndexNdvi: num('VEG_NDVI'),
            pitchedRoofRatio: num('PITCHED_ROOF'),
            waterSurfaceRatio: num('WATER'),
            underpassVoidRatio: num('VOID'),
            dominantStreetYawDeg: num('YAW'),
            inputTriangles: num('INPUT_TRIS'),
            outputTriangles: num('OUTPUT_TRIS'),
            processingTimeMs: num('RUNTIME_MS')
        };
        if (!fs.existsSync(outputGlbPath)) {
            throw new GeneratorFailedError('cpp', `the UTDRA pipeline wrote no GLB to ${outputGlbPath}`);
        }
        const glbBuffer = fs.readFileSync(outputGlbPath);
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

    /**
     * Probes the macro-domain metrics of a tile without mesh decomposition.
     */
    async probeTile(
        inputGlbPath: string,
        optionsOrAnchor?: { latitude: number; longitude: number } | Partial<UtdraServiceOptions>
    ): Promise<UtdraTelemetry> {
        let opts: UtdraServiceOptions = { inputGlbPath, mode: 'probe' };
        if (optionsOrAnchor) {
            if ('latitude' in optionsOrAnchor && 'longitude' in optionsOrAnchor) {
                opts.anchorCoord = optionsOrAnchor as { latitude: number; longitude: number };
            } else {
                opts = { ...opts, ...(optionsOrAnchor as Partial<UtdraServiceOptions>), inputGlbPath, mode: 'probe' };
            }
        }
        const result = await this.decomposeTile(opts);
        return result.telemetry;
    }

    /**
     * Carves out false photogrammetric underpass curtain walls beneath bridges, viaducts, and flyovers.
     */
    async carveBridgeUnderpass(
        inputGlbPath: string,
        options: Partial<UtdraServiceOptions> = {}
    ): Promise<UtdraResult> {
        return this.decomposeTile({ ...options, inputGlbPath, mode: 'bridge' });
    }

    /**
     * Applies non-destructive Sutherland-Hodgman clipping across an elevation plane threshold.
     */
    async sliceElevation(
        inputGlbPath: string,
        sliceElevationCutoff: number,
        options: Partial<UtdraServiceOptions> = {}
    ): Promise<UtdraResult> {
        return this.decomposeTile({ ...options, inputGlbPath, mode: 'slicer', sliceElevationCutoff });
    }

    /**
     * Convenience method to decompose an existing on-disk GLB file.
     */
    async decomposeGlbFile(
        inputGlbPath: string,
        options: Partial<UtdraServiceOptions> = {}
    ): Promise<UtdraResult> {
        return this.decomposeTile({ ...options, inputGlbPath, mode: options.mode ?? 'full' });
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
