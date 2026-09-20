/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { NativeCppCompilerService } from './native-compiler-service';

const execAsync = promisify(exec);

export type BotanicalMode = 'tree' | 'shrub' | 'auto' | 'streetscape';
export type LeafMorphologyType = 'ovate' | 'serrated' | 'lobed';

export interface BotanicalPipelineOptions {
    inputGlbPath?: string;
    outputGlbPath?: string;
    mode?: BotanicalMode;
    leafMorphology?: LeafMorphologyType;
    leafSize?: number;
    leafDensityScale?: number;
    enableIvy?: boolean;
    includeGhostOverlay?: boolean;
    streamStdout?: boolean;
}

export interface BotanicalPipelineTelemetry {
    vegetationType: string;
    mode: BotanicalMode;
    leafMorphology: LeafMorphologyType;
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
        if (fs.existsSync(this.binaryPath)) {
            return this.binaryPath;
        }

        const sourcePath = path.resolve(process.cwd(), 'scripts/run_botanical_pipeline.cpp');
        const includePath = this.compiler.getSdkIncludePath();
        const outputDir = path.dirname(this.binaryPath);

        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        const compileCmd = `clang++ -std=c++20 -O3 -march=native -I "${includePath}" "${sourcePath}" -o "${this.binaryPath}"`;
        await execAsync(compileCmd);
        return this.binaryPath;
    }

    /**
     * Synthesizes botanical geometry from an input scan or benchmark.
     */
    async synthesizeVegetation(options: BotanicalPipelineOptions = {}): Promise<BotanicalPipelineResult> {
        const bin = await this.ensureBinary();
        const artifactsDir = path.resolve(process.cwd(), '.scratchbox', 'artifacts');
        if (!fs.existsSync(artifactsDir)) {
            fs.mkdirSync(artifactsDir, { recursive: true });
        }
        const tmpOutput = options.outputGlbPath || path.join(artifactsDir, `botanical_${Date.now()}.glb`);
        const mode = options.mode ?? 'auto';
        const leaf = options.leafMorphology ?? 'lobed';
        const leafSize = options.leafSize ?? 0.32;
        const density = options.leafDensityScale ?? 1.0;
        const ivy = (options.enableIvy ?? false) ? 1 : 0;
        const ghost = (options.includeGhostOverlay ?? false) ? 1 : 0;

        const args = [
            `--output "${tmpOutput}"`,
            `--mode ${mode}`,
            `--leaf ${leaf}`,
            `--leaf-size ${leafSize}`,
            `--density ${density}`,
            `--ivy ${ivy}`,
            `--ghost ${ghost}`
        ];

        if (options.inputGlbPath) {
            args.push(`--input "${options.inputGlbPath}"`);
        }

        const cmd = `"${bin}" ${args.join(' ')}`;
        const { stdout, stderr } = await execAsync(cmd, { maxBuffer: 1024 * 1024 * 64 });

        // Parse structured telemetry lines
        const getNum = (pattern: RegExp, defaultVal = 0): number => {
            const m = stdout.match(pattern);
            return m ? parseFloat(m[1]) : defaultVal;
        };

        const totalHeightMeters = getNum(/Total Height:\s*([0-9.]+)\s*m/, 0);
        const clearTrunkHeightMeters = getNum(/Clear Trunk Height:\s*([0-9.]+)\s*m/, 0);
        const crownBaseHeightMeters = getNum(/Crown Base Height:\s*([0-9.]+)\s*m/, 0);
        const crownHeightMeters = getNum(/Crown Height:\s*([0-9.]+)\s*m/, 0);
        const volumetricDensity = getNum(/Volumetric Density:\s*([0-9.]+)/, 0);
        const baseCaliperCm = getNum(/Base Caliper:\s*([0-9.]+)\s*cm/, 0);
        const leavesPerTip = Math.round(getNum(/Leaves Per Tip:\s*([0-9]+)/, 12));
        const outputVertices = Math.round(getNum(/Output Vertices:\s*([0-9]+)/, 0));
        const outputTriangles = Math.round(getNum(/Output Triangles:\s*([0-9]+)/, 0));
        const processingTimeMs = getNum(/Processing Runtime:\s*([0-9.]+)\s*ms/, 0);

        const isShrubMatch = stdout.match(/Vegetation Type:\s*(.+)/);
        const vegetationType = isShrubMatch ? isShrubMatch[1].trim() : (mode === 'shrub' ? 'Multi-Stem Shrub / Hedge' : 'Arborescent Street/Park Tree');

        const telemetry: BotanicalPipelineTelemetry = {
            vegetationType,
            mode,
            leafMorphology: leaf,
            totalHeightMeters,
            clearTrunkHeightMeters,
            crownBaseHeightMeters,
            crownHeightMeters,
            volumetricDensity,
            baseCaliperCm,
            leavesPerTip,
            outputVertices,
            outputTriangles,
            processingTimeMs
        };

        let glbBuffer: Buffer | undefined;
        let glbBase64: string | undefined;

        if (fs.existsSync(tmpOutput)) {
            glbBuffer = fs.readFileSync(tmpOutput);
            glbBase64 = glbBuffer.toString('base64');
        }

        return {
            success: stdout.includes('STATUS: SUCCESS') || outputTriangles > 0,
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
