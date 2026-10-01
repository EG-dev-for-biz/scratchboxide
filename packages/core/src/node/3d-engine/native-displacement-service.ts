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
import { NativeCppCompilerService } from './native-compiler-service';
import { TileDisplacementSpec } from './native-tile-path-tracer-service';

const execFileAsync = promisify(execFile);

const CLI_SOURCE_NAME = 'displace_glb.cpp';

export interface DisplacementResult {
    success: boolean;
    inputGlbPath: string;
    outputGlbPath: string;
    originalTriangles: number;
    displacedTriangles: number;
    originalVertices: number;
    displacedVertices: number;
    expansionRatio: number;
    executionMs: number;
}

export class NativeDisplacementService {
    private readonly compiler: NativeCppCompilerService;
    private readonly buildDir: string;

    constructor(compiler?: NativeCppCompilerService, buildDir?: string) {
        this.compiler = compiler ?? new NativeCppCompilerService();
        this.buildDir = buildDir ?? path.resolve(process.cwd(), 'build/3d-native');
    }

    /**
     * Subdivides and physically displaces an input GLB mesh along its vertex normals
     * using baked texture heightmaps and C++20 procedural FastNoise3D micro-relief.
     */
    async displaceGlb(
        inputGlbPath: string,
        outputGlbPath: string,
        options: TileDisplacementSpec = {}
    ): Promise<DisplacementResult> {
        if (!fs.existsSync(inputGlbPath)) {
            throw new Error(`Input GLB not found: ${inputGlbPath}`);
        }

        const outDir = path.dirname(outputGlbPath);
        if (!fs.existsSync(outDir)) {
            fs.mkdirSync(outDir, { recursive: true });
        }

        const optionsFile = path.join(outDir, `disp_config_${Date.now()}.json`);
        fs.writeFileSync(optionsFile, JSON.stringify(options, null, 2), 'utf8');

        try {
            const binaryPath = await this.ensureBinary();
            const { stdout } = await execFileAsync(binaryPath, [inputGlbPath, outputGlbPath, optionsFile], {
                timeout: 5 * 60 * 1000,
                maxBuffer: 16 * 1024 * 1024
            });

            const result = JSON.parse(stdout.trim()) as DisplacementResult;
            return result;
        } finally {
            if (fs.existsSync(optionsFile)) {
                try { fs.unlinkSync(optionsFile); } catch {}
            }
        }
    }

    private async ensureBinary(): Promise<string> {
        const candidates = [
            path.resolve(process.cwd(), 'scripts', CLI_SOURCE_NAME),
            path.resolve(__dirname, '../../../../../scripts', CLI_SOURCE_NAME),
            path.resolve(__dirname, '../../../../scripts', CLI_SOURCE_NAME)
        ];
        const sourcePath = candidates.find(p => fs.existsSync(p));
        if (!sourcePath) {
            throw new Error(`Cannot find ${CLI_SOURCE_NAME} (looked in ${candidates.join(', ')})`);
        }

        const extraFlags = ['-pthread', '-lz'];
        if (process.env.SCRATCHBOX_NATIVE_ARCH === '1') {
            extraFlags.push('-march=native');
        }

        const compiled = await this.compiler.compileSource(fs.readFileSync(sourcePath, 'utf8'), {
            outputDir: this.buildDir,
            outputBinaryName: 'displace_glb',
            optimization: '-O3',
            extraFlags
        });
        if (!compiled.success || !compiled.binaryPath) {
            throw new Error(`Failed to compile ${CLI_SOURCE_NAME}:\n${compiled.compilerOutput}`);
        }
        return compiled.binaryPath;
    }
}
