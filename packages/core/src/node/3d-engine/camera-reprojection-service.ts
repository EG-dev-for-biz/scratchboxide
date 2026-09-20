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

const execAsync = promisify(exec);

export interface CameraParams {
    yaw: number;       // Azimuth in degrees
    pitch: number;     // Elevation in degrees
    roll?: number;     // Camera roll in degrees
    distance?: number; // Dolly zoom distance
    fov?: number;      // Field of view in degrees
    tau?: number;      // Discontinuity threshold (default 0.075)
    gridStep?: number; // Grid downsampling step
}

export interface CameraReprojectionResult {
    success: boolean;
    yaw: number;
    pitch: number;
    roll: number;
    distance: number;
    fov: number;
    tau: number;
    totalTriangles: number;
    severedTriangles: number;
    retainedTriangles: number;
    disocclusionPercent: number;
    glbBytes: number;
    glbPath: string;
    reprojectedPath: string;
    maskPath: string;
    normalPath: string;
    error?: string;
}

export class CameraReprojectionService {
    private binaryPath: string;

    constructor(customBinaryPath?: string) {
        if (customBinaryPath) {
            this.binaryPath = customBinaryPath;
        } else {
            this.binaryPath = path.resolve(process.cwd(), 'build/reproject_camera_space');
        }
    }

    /**
     * Executes native C++20 camera reprojection pipeline on input image + parameters.
     */
    async reproject(
        params: CameraParams,
        options: {
            imagePath?: string;
            depthPath?: string;
            outDir?: string;
        } = {}
    ): Promise<CameraReprojectionResult> {
        const outDir = options.outDir || path.resolve(process.cwd(), 'build/reproject_output');
        if (!fs.existsSync(outDir)) {
            fs.mkdirSync(outDir, { recursive: true });
        }

        const outGlb = path.join(outDir, `reproject_${Date.now()}.glb`);
        const outRepro = path.join(outDir, `reproject_${Date.now()}.png`);
        const outMask = path.join(outDir, `mask_${Date.now()}.png`);
        const outNormal = path.join(outDir, `normal_${Date.now()}.png`);

        const args = [
            `--yaw ${params.yaw}`,
            `--pitch ${params.pitch}`,
            `--roll ${params.roll ?? 0}`,
            `--dist ${params.distance ?? 2.5}`,
            `--fov ${params.fov ?? 60}`,
            `--tau ${params.tau ?? 0.075}`,
            `--step ${params.gridStep ?? 2}`,
            `--out-glb "${outGlb}"`,
            `--out-reprojected "${outRepro}"`,
            `--out-mask "${outMask}"`,
            `--out-normal "${outNormal}"`,
            `--json`
        ];

        if (options.imagePath) {
            args.push(`--image "${options.imagePath}"`);
        }
        if (options.depthPath) {
            args.push(`--depth "${options.depthPath}"`);
        }

        const cmd = `"${this.binaryPath}" ${args.join(' ')}`;

        try {
            const { stdout, stderr } = await execAsync(cmd, {
                cwd: process.cwd(),
                timeout: 30000,
                maxBuffer: 20 * 1024 * 1024
            });

            const parsed = JSON.parse(stdout.trim());
            return parsed as CameraReprojectionResult;
        } catch (err: any) {
            return {
                success: false,
                yaw: params.yaw,
                pitch: params.pitch,
                roll: params.roll ?? 0,
                distance: params.distance ?? 2.5,
                fov: params.fov ?? 60,
                tau: params.tau ?? 0.075,
                totalTriangles: 0,
                severedTriangles: 0,
                retainedTriangles: 0,
                disocclusionPercent: 0,
                glbBytes: 0,
                glbPath: '',
                reprojectedPath: '',
                maskPath: '',
                normalPath: '',
                error: err.message || String(err)
            };
        }
    }
}
