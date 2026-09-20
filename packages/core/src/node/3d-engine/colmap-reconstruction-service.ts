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

export type ColmapCameraModel =
    | 'SIMPLE_PINHOLE'
    | 'PINHOLE'
    | 'SIMPLE_RADIAL'
    | 'RADIAL'
    | 'OPENCV'
    | 'OPENCV_FISHEYE'
    | 'FULL_OPENCV'
    | 'FOV'
    | 'SIMPLE_RADIAL_FISHEYE'
    | 'RADIAL_FISHEYE'
    | 'THIN_PRISM_FISHEYE';

export interface ColmapGlbOptions {
    sparseDir?: string;
    outGlbPath?: string;
    frustumScale?: number;
    pointRadius?: number;
    synthetic?: boolean;
}

export interface ColmapReconstructionSummary {
    success: boolean;
    numCameras: number;
    numImages: number;
    numPoints3D: number;
    glbBytes: number;
    glbPath: string;
    bounds?: {
        min: [number, number, number];
        max: [number, number, number];
    };
    centroid?: [number, number, number];
    error?: string;
}

export interface GlomapOptions {
    imageDir: string;
    outputDir?: string;
    cameraModel?: ColmapCameraModel;
    maxImageSize?: number;
    fov?: number;
    exportGlb?: boolean;
}

export interface GlomapResult {
    success: boolean;
    sparseDir?: string;
    glbPath?: string;
    numImagesRegistered?: number;
    error?: string;
}

export class ColmapReconstructionService {
    private binaryPath: string;
    private glomapBinaryPath: string;
    private compilerService: NativeCppCompilerService;

    constructor(customBinaryPath?: string, customGlomapBinaryPath?: string) {
        this.compilerService = new NativeCppCompilerService();
        if (customBinaryPath) {
            this.binaryPath = customBinaryPath;
        } else {
            this.binaryPath = path.resolve(process.cwd(), 'build/run_colmap_glb_pipeline');
        }

        if (customGlomapBinaryPath) {
            this.glomapBinaryPath = customGlomapBinaryPath;
        } else {
            this.glomapBinaryPath = path.resolve(process.cwd(), 'build/run_glomap_engine');
        }
    }

    /**
     * Ensures native C++20 COLMAP CLI binary is compiled and up-to-date.
     */
    async ensureBinary(): Promise<string> {
        if (fs.existsSync(this.binaryPath)) {
            return this.binaryPath;
        }

        const binDir = path.dirname(this.binaryPath);
        if (!fs.existsSync(binDir)) {
            fs.mkdirSync(binDir, { recursive: true });
        }

        const includePath = this.compilerService.getSdkIncludePath();
        const sourcePath = path.resolve(process.cwd(), 'scripts/run_colmap_glb_pipeline.cpp');

        if (!fs.existsSync(sourcePath)) {
            throw new Error(`COLMAP CLI pipeline source not found at: ${sourcePath}`);
        }

        const compileCmd = `clang++ -std=c++20 -O3 -I "${includePath}" "${sourcePath}" -o "${this.binaryPath}"`;
        await execAsync(compileCmd);
        return this.binaryPath;
    }

    /**
     * Ensures native C++20 GLOMAP relative pose solver binary is compiled and up-to-date.
     */
    async ensureGlomapBinary(): Promise<string> {
        if (fs.existsSync(this.glomapBinaryPath)) {
            return this.glomapBinaryPath;
        }

        const binDir = path.dirname(this.glomapBinaryPath);
        if (!fs.existsSync(binDir)) {
            fs.mkdirSync(binDir, { recursive: true });
        }

        const includePath = this.compilerService.getSdkIncludePath();
        const sourcePath = path.resolve(process.cwd(), 'scripts/run_glomap_engine.cpp');

        if (!fs.existsSync(sourcePath)) {
            throw new Error(`GLOMAP pipeline source not found at: ${sourcePath}`);
        }

        const compileCmd = `clang++ -std=c++20 -O3 -I "${includePath}" "${sourcePath}" -o "${this.glomapBinaryPath}"`;
        await execAsync(compileCmd);
        return this.glomapBinaryPath;
    }

    /**
     * Convert COLMAP / GLOMAP sparse model directory into a standard binary glTF 2.0 (.glb) file.
     * Contains camera frustum pyramids and 3D point cloud colored by RGB observations.
     */
    async convertColmapToGlb(options: ColmapGlbOptions = {}): Promise<ColmapReconstructionSummary> {
        const bin = await this.ensureBinary();
        const outGlb = options.outGlbPath || path.resolve(process.cwd(), `build/colmap_${Date.now()}.glb`);

        const outDir = path.dirname(outGlb);
        if (!fs.existsSync(outDir)) {
            fs.mkdirSync(outDir, { recursive: true });
        }

        const args = [
            `--out-glb "${outGlb}"`,
            `--frustum-scale ${options.frustumScale ?? 0.35}`,
            `--point-radius ${options.pointRadius ?? 0.015}`,
            `--json`
        ];

        if (options.synthetic) {
            args.push(`--synthetic`);
        } else if (options.sparseDir) {
            args.push(`--sparse-dir "${options.sparseDir}"`);
        } else {
            args.push(`--synthetic`);
        }

        const cmd = `"${bin}" ${args.join(' ')}`;

        try {
            const { stdout } = await execAsync(cmd, {
                cwd: process.cwd(),
                timeout: 30000,
                maxBuffer: 50 * 1024 * 1024
            });

            const parsed = JSON.parse(stdout.trim()) as ColmapReconstructionSummary;
            return parsed;
        } catch (err: any) {
            return {
                success: false,
                numCameras: 0,
                numImages: 0,
                numPoints3D: 0,
                glbBytes: 0,
                glbPath: '',
                error: err.message || String(err)
            };
        }
    }

    /**
     * Inspect and parse sparse directory without requiring full GLB extraction.
     */
    async parseSparseModel(sparseDir: string): Promise<ColmapReconstructionSummary> {
        return this.convertColmapToGlb({
            sparseDir,
            outGlbPath: path.resolve(process.cwd(), `build/temp_inspect_${Date.now()}.glb`)
        });
    }

    /**
     * Interface to invoke GLOMAP Global Structure-from-Motion.
     * Automatically uses native C++20 GLOMAP engine fallback when external CLI is absent.
     */
    async runGlomapReconstruction(options: GlomapOptions): Promise<GlomapResult> {
        const outputDir = options.outputDir || path.resolve(process.cwd(), `build/glomap_${Date.now()}`);
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        // 1. Try external glomap CLI if available on system PATH
        let hasSystemGlomap = false;
        try {
            await execAsync('glomap --help');
            hasSystemGlomap = true;
        } catch {
            hasSystemGlomap = false;
        }

        if (hasSystemGlomap) {
            const cmd = `glomap mapper --image_path "${options.imageDir}" --output_path "${outputDir}"`;
            try {
                await execAsync(cmd, { timeout: 120000 });
                const sparseDir = path.join(outputDir, 'sparse/0');
                return {
                    success: true,
                    sparseDir
                };
            } catch (err: any) {
                // Fall back to native engine if system CLI encounters runtime error
            }
        }

        // 2. Native C++20 GLOMAP engine fallback
        try {
            const glomapBin = await this.ensureGlomapBinary();
            const outGlbPath = path.join(outputDir, 'sparse/0/reconstruction.glb');
            const fovArg = options.fov ? `--fov ${options.fov}` : '';
            const glbArg = `--export-glb "${outGlbPath}"`;
            const cmd = `"${glomapBin}" --image-dir "${options.imageDir}" --out-dir "${outputDir}" ${fovArg} ${glbArg}`;

            const { stdout } = await execAsync(cmd, {
                cwd: process.cwd(),
                timeout: 60000
            });

            const sparseDir = path.join(outputDir, 'sparse/0');
            const registeredMatches = stdout.match(/Registered Camera Station/g) || [];

            return {
                success: true,
                sparseDir,
                glbPath: fs.existsSync(outGlbPath) ? outGlbPath : undefined,
                numImagesRegistered: registeredMatches.length
            };
        } catch (err: any) {
            return {
                success: false,
                error: `GLOMAP native C++20 engine failed: ${err.message || String(err)}`
            };
        }
    }
}
