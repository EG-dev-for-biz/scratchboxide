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
    /** COLMAP / GLOMAP sparse model directory (cameras, images, points3D as .txt or .bin). Required. */
    sparseDir: string;
    outGlbPath?: string;
    frustumScale?: number;
    pointRadius?: number;
}

/** Raised when no COLMAP sparse model is supplied; there is no built-in sample reconstruction. */
export class ColmapSparseModelRequiredError extends Error {
    readonly code = 'COLMAP_SPARSE_MODEL_REQUIRED';
    constructor(message: string) {
        super(message);
        this.name = 'ColmapSparseModelRequiredError';
    }
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

export class ColmapReconstructionService {
    private binaryPath: string;
    private compilerService: NativeCppCompilerService;

    constructor(customBinaryPath?: string) {
        this.compilerService = new NativeCppCompilerService();
        this.binaryPath = customBinaryPath || path.resolve(process.cwd(), 'build/run_colmap_glb_pipeline');
    }

    /**
     * Ensures the native C++20 COLMAP -> GLB converter is compiled and not older
     * than its source or the COLMAP header (a stale binary would run old behaviour).
     */
    async ensureBinary(): Promise<string> {
        const includePath = this.compilerService.getSdkIncludePath();
        const sourcePath = path.resolve(process.cwd(), 'scripts/run_colmap_glb_pipeline.cpp');
        const headerPath = path.join(includePath, 'scratchbox_colmap.hpp');

        if (fs.existsSync(this.binaryPath)) {
            const binTime = fs.statSync(this.binaryPath).mtimeMs;
            const inputs = [sourcePath, headerPath].filter(p => fs.existsSync(p));
            if (inputs.every(p => fs.statSync(p).mtimeMs <= binTime)) {
                return this.binaryPath;
            }
        }

        const binDir = path.dirname(this.binaryPath);
        if (!fs.existsSync(binDir)) {
            fs.mkdirSync(binDir, { recursive: true });
        }

        if (!fs.existsSync(sourcePath)) {
            throw new Error(`COLMAP CLI pipeline source not found at: ${sourcePath}`);
        }

        const compileCmd = `clang++ -std=c++20 -O3 -I "${includePath}" "${sourcePath}" -o "${this.binaryPath}"`;
        await execAsync(compileCmd);
        return this.binaryPath;
    }

    /**
     * Convert COLMAP / GLOMAP sparse model directory into a standard binary glTF 2.0 (.glb) file.
     * Contains camera frustum pyramids and 3D point cloud colored by RGB observations.
     */
    async convertColmapToGlb(options: ColmapGlbOptions): Promise<ColmapReconstructionSummary> {
        if (!options?.sparseDir) {
            throw new ColmapSparseModelRequiredError(
                'convertColmapToGlb needs sparseDir: a COLMAP / GLOMAP sparse model directory (cameras, images, points3D). Run COLMAP or GLOMAP outside the app to produce one.'
            );
        }
        if (!fs.existsSync(options.sparseDir)) {
            throw new ColmapSparseModelRequiredError(`sparseDir does not exist: ${options.sparseDir}`);
        }
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
            `--json`,
            `--sparse-dir "${options.sparseDir}"`
        ];

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
            // The converter prints a JSON error and exits 1 when the model cannot be read.
            const stdout = typeof err?.stdout === 'string' ? err.stdout.trim() : '';
            let reported: string | undefined;
            try { reported = stdout ? (JSON.parse(stdout) as { error?: string }).error : undefined; } catch { /* not JSON */ }
            return {
                success: false,
                numCameras: 0,
                numImages: 0,
                numPoints3D: 0,
                glbBytes: 0,
                glbPath: '',
                error: reported || err.message || String(err)
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
}
