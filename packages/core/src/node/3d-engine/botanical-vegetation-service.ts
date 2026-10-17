/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { GeneratorFailedError } from '../../common/errors/pipeline-errors';
import { NativeCppCompilerService } from './native-compiler-service';
import { buildNativeIfStale } from './native-build';

const execFileAsync = promisify(execFile);

export type BotanicalMode = 'tree' | 'shrub' | 'auto' | 'streetscape';
/**
 * A leaf blade's outline as continuous numbers (the half width along the blade is gain * width * t^rise * (1 - t)^fall, times a
 * tooth term and a lobe term, blended toward a heart-shaped base by `cordate`). Any blade lies somewhere in this space; the
 * default is the lobed blade the pipeline has always grown.
 */
export interface LeafOutlineParams {
    gain: number;
    riseExponent: number;
    fallExponent: number;
    serrationCount: number;
    serrationDepth: number;
    lobeDepth: number;
    lobeHalfCycles: number;
    cordate: number;
}
export const DEFAULT_LEAF_OUTLINE: LeafOutlineParams = { gain: 1.95, riseExponent: 0.45, fallExponent: 0.55, serrationCount: 14, serrationDepth: 0, lobeDepth: 0.42, lobeHalfCycles: 5, cordate: 0 };

export interface BotanicalPipelineOptions {
    /** The scan (.glb) to rebuild, or 'benchmark' for the built-in synthetic benchmark scan; required by the CLI. */
    inputGlbPath?: string;
    outputGlbPath?: string;
    mode?: BotanicalMode;
    leafOutline?: Partial<LeafOutlineParams>;
    leafSize?: number;
    leafDensityScale?: number;
    enableIvy?: boolean;
    includeGhostOverlay?: boolean;
    streamStdout?: boolean;
}

export interface BotanicalPipelineTelemetry {
    vegetationType: string;
    mode: BotanicalMode;
    leafOutline: LeafOutlineParams;
    totalHeightMeters: number;
    clearTrunkHeightMeters: number;
    crownBaseHeightMeters: number;
    crownHeightMeters: number;
    volumetricDensity: number;
    baseCaliperCm: number;
    leavesPerTip: number;
    outputVertices: number;
    outputTriangles: number;
    processingTimeMs: number;
}

export interface BotanicalPipelineResult {
    success: boolean;
    glbBuffer?: Buffer;
    glbBase64?: string;
    outputGlbPath: string;
    telemetry: BotanicalPipelineTelemetry;
    stdout: string;
    stderr?: string;
}

/**
 * Service exposing the Unified Botanical & Vegetation Synthesis Pipeline (Stages 11-15).
 *
 * Features:
 * - ExG vegetation identification and ground anchor pin isolation
 * - Strategy B direct mesh-conformal attractor seeding
 * - Outward-arching space colonization with 120-deg scaffold bifurcation
 * - Detailed 3D botanical leaves (OvateSimple, SerratedBirch, LobedOakMaple)
 * - Leonardo da Vinci allometric base caliper calculation
 * - Multi-tier Fibonacci twig sprays & transferred envelope normal shading
 * - Clinging facade ivy generation (IvyGen)
 * - Complete rectified streetscape replacement
 */
export class BotanicalVegetationService {
    private compiler: NativeCppCompilerService;
    private binaryPath: string;

    constructor(compiler?: NativeCppCompilerService) {
        this.compiler = compiler || new NativeCppCompilerService();
        const candidateBinaries = [
            path.resolve(process.cwd(), 'build/run_botanical_pipeline'),
            path.resolve(process.cwd(), 'scripts/run_botanical_pipeline'),
            path.resolve(__dirname, '../../../../scripts/run_botanical_pipeline'),
            path.resolve(process.cwd(), 'build/3d-native/run_botanical_pipeline')
        ];
        this.binaryPath = candidateBinaries.find(p => fs.existsSync(p)) || candidateBinaries[0];
    }

    /**
     * Ensures the native C++20 botanical synthesis binary is compiled and available.
     */
    async ensureBinary(): Promise<string> {
        const sourcePath = [path.resolve(process.cwd(), 'scripts/run_botanical_pipeline.cpp'), path.resolve(__dirname, '../../../../scripts/run_botanical_pipeline.cpp')]
            .find(p => fs.existsSync(p));
        if (!sourcePath) throw new Error('scripts/run_botanical_pipeline.cpp not found');
        // rebuilt when missing or older than a file it was compiled from, one build at a time across processes, so an
        // old binary never runs
        return buildNativeIfStale({ source: sourcePath, binary: this.binaryPath, includeDir: this.compiler.getSdkIncludePath() });
    }

    /**
     * Synthesizes botanical geometry from an input scan (or the built-in benchmark scan, asked for by name). The CLI
     * runs without a shell; a failed run, or one that does not report its telemetry, throws GeneratorFailedError.
     */
    async synthesizeVegetation(options: BotanicalPipelineOptions = {}): Promise<BotanicalPipelineResult> {
        const bin = await this.ensureBinary();
        const artifactsDir = path.resolve(process.cwd(), '.scratchbox', 'artifacts');
        if (!fs.existsSync(artifactsDir)) {
            fs.mkdirSync(artifactsDir, { recursive: true });
        }
        const tmpOutput = options.outputGlbPath || path.join(artifactsDir, `botanical_${Date.now()}.glb`);
        const mode = options.mode ?? 'auto';
        const leaf: LeafOutlineParams = { ...DEFAULT_LEAF_OUTLINE, ...options.leafOutline };
        for (const [k, v] of Object.entries(leaf)) if (!Number.isFinite(v)) throw new GeneratorFailedError('cpp', `leafOutline.${k} must be a finite number`);
        const leafSize = options.leafSize ?? 0.32;
        const density = options.leafDensityScale ?? 1.0;
        const ivy = (options.enableIvy ?? false) ? 1 : 0;
        const ghost = (options.includeGhostOverlay ?? false) ? 1 : 0;

        // an argument list (no shell): paths may hold any character
        const args = ['--output', tmpOutput, '--mode', mode, '--leaf-outline', [leaf.gain, leaf.riseExponent, leaf.fallExponent, leaf.serrationCount, leaf.serrationDepth, leaf.lobeDepth, leaf.lobeHalfCycles, leaf.cordate].join(','), '--leaf-size', String(leafSize), '--density', String(density), '--ivy', String(ivy), '--ghost', String(ghost)];
        if (options.inputGlbPath) args.push('--input', options.inputGlbPath);

        let stdout: string, stderr: string;
        try {
            ({ stdout, stderr } = await execFileAsync(bin, args, { maxBuffer: 1024 * 1024 * 64, windowsHide: true }));
        } catch (err) {
            const e = err as { stderr?: string; stdout?: string; message?: string };
            throw new GeneratorFailedError('cpp', `${path.basename(bin)}: ${String(e.stderr || e.stdout || e.message || err)}`);
        }
        if (!stdout.includes('STATUS: SUCCESS') || !fs.existsSync(tmpOutput)) {
            throw new GeneratorFailedError('cpp', `${path.basename(bin)} did not report success or write ${tmpOutput}: ${stderr || stdout.slice(-2000)}`);
        }

        // Telemetry is read from what the pipeline printed; a value it did not print fails the call (none is assumed)
        const read = (label: string, pattern: RegExp): number => {
            const m = stdout.match(pattern);
            const v = m ? parseFloat(m[1]) : NaN;
            if (!Number.isFinite(v)) throw new GeneratorFailedError('cpp', `${path.basename(bin)} printed no ${label}`);
            return v;
        };
        const typeMatch = stdout.match(/Vegetation Type:\s*(.+)/);
        if (!typeMatch) throw new GeneratorFailedError('cpp', `${path.basename(bin)} printed no vegetation type`);
        const telemetry: BotanicalPipelineTelemetry = {
            vegetationType: typeMatch[1].trim(),
            mode,
            leafOutline: leaf,
            totalHeightMeters: read('total height', /Total Height:\s*([0-9.]+)\s*m/),
            clearTrunkHeightMeters: read('clear trunk height', /Clear Trunk Height:\s*([0-9.]+)\s*m/),
            crownBaseHeightMeters: read('crown base height', /Crown Base Height:\s*([0-9.]+)\s*m/),
            crownHeightMeters: read('crown height', /Crown Height:\s*([0-9.]+)\s*m/),
            volumetricDensity: read('volumetric density', /Volumetric Density:\s*([0-9.]+)/),
            baseCaliperCm: read('base caliper', /Base Caliper:\s*([0-9.]+)\s*cm/),
            leavesPerTip: Math.round(read('leaves per tip', /Leaves Per Tip:\s*([0-9]+)/)),
            outputVertices: Math.round(read('output vertex count', /Output Vertices:\s*([0-9]+)/)),
            outputTriangles: Math.round(read('output triangle count', /Output Triangles:\s*([0-9]+)/)),
            processingTimeMs: read('processing time', /Processing Runtime:\s*([0-9.]+)\s*ms/)
        };

        const glbBuffer = fs.readFileSync(tmpOutput);
        const glbBase64 = glbBuffer.toString('base64');

        return {
            success: true,
            glbBuffer,
            glbBase64,
            outputGlbPath: tmpOutput,
            telemetry,
            stdout,
            stderr
        };
    }

    /**
     * Executes the complete streetscape replacement pipeline: removes raw vegetation blobs,
     * cleanses roadway/sidewalk/facade, installs cobblestone tree pit collar, and plants procedural tree.
     */
    async synthesizeStreetscape(streetscapeGlbPath?: string, options: BotanicalPipelineOptions = {}): Promise<BotanicalPipelineResult> {
        return this.synthesizeVegetation({
            ...options,
            inputGlbPath: streetscapeGlbPath,
            mode: 'streetscape'
        });
    }

    /**
     * Convenience method to run the pipeline against an existing GLB file on disk.
     */
    async synthesizeFromGlbFile(inputGlbPath: string, options: BotanicalPipelineOptions = {}): Promise<BotanicalPipelineResult> {
        return this.synthesizeVegetation({
            ...options,
            inputGlbPath
        });
    }
}
