/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Joint depth and camera poses for the views of one Street View drive (Depth Anything 3 Small, tools/depth/rig_depth_da3.py),
 * the input of rig-depth-registration.ts.
 *
 * Depth Anything 3 Small (or Base; both Apache-2.0) is allowed for Street View registration (user decision, 2026-11-08)
 * and as the reference SHARP's street splats are scaled onto (SharpStreetSplatService; 2026-11-09): scene depth and geometry still come from the scan, the tiles or Depth Anything V2 Small (AGENTS.md
 * section 2). The views are sent to the worker inline and never written to disk (Street View imagery is not stored);
 * only the derived depth comes back through a temporary file, removed after reading.
 *
 * The interpreter: SCRATCHBOX_DA3_PYTHON, else SCRATCHBOX_PYTHON, else the project's .venv, with depth_anything_3
 * importable (its xformers dependency is CUDA-only and not needed: install it with `pip install --no-deps`).
 */

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { getPythonWorkerPool } from '../process/persistent-python-worker';
import { repoPath, resolveRepoPython } from '../process/repo-python';
import type { RigDepthView } from './rig-depth-registration';

export interface RigViewImage {
    panoId: string;
    /** Yaw of the view from its panorama's reference direction, degrees, turning right. */
    yawDeg: number;
    /** The view's encoded image (JPEG or PNG), kept in memory. */
    image: Buffer;
    /** The view's known horizontal field of view (degrees, principal point centred): conditions the model when every view has one. */
    horizontalFovDeg?: number;
}

export interface Da3RigDepthOptions {
    model?: 'depth-anything/DA3-SMALL' | 'depth-anything/DA3-BASE';
    /** Keep every `stride`-th depth pixel in each direction (default 2). */
    stride?: number;
    timeoutMs?: number;
    pythonExecutable?: string;
}

export interface Da3RigDepthResult {
    views: RigDepthView[];
    device: string;
    inferenceMs: number;
}

export class Da3RigDepthService {
    constructor(private readonly sidecarPath = repoPath('tools', 'depth', 'rig_depth_da3.py')) { }

    private python(override?: string): string {
        return override ?? resolveRepoPython({
            overrideVars: ['SCRATCHBOX_DA3_PYTHON'],
            modules: ['numpy', 'torch', 'cv2', 'depth_anything_3'],
            purpose: 'Street View registration depth (tools/depth/rig_depth_da3.py)'
        });
    }

    /** One joint run over all the views (they should be one drive: one capture date). */
    async estimate(images: RigViewImage[], opts: Da3RigDepthOptions = {}): Promise<Da3RigDepthResult> {
        if (!images.length) throw new Error('Da3RigDepthService.estimate needs at least one view');
        const outPath = path.join(os.tmpdir(), `sb_rig_depth_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.f32`);
        const request = {
            model: opts.model ?? 'depth-anything/DA3-SMALL',
            stride: opts.stride ?? 2,
            outPath,
            views: images.map(v => ({ panoId: v.panoId, yawDeg: v.yawDeg, jpegBase64: v.image.toString('base64'), horizontalFovDeg: v.horizontalFovDeg }))
        };
        const pool = getPythonWorkerPool({
            pythonBinary: this.python(opts.pythonExecutable),
            scriptPath: this.sidecarPath,
            label: 'the Street View registration depth sidecar',
            env: { ...process.env, KMP_DUPLICATE_LIB_OK: 'TRUE' }
        });
        try {
            const res = await pool.run({ stdin: JSON.stringify(request), timeoutMs: opts.timeoutMs ?? 900_000 });
            if (res.exitCode !== 0) throw new Error(`the depth sidecar failed (exit ${res.exitCode}): ${res.stderr.trim().split('\n').slice(-6).join(' | ')}`);
            const line = res.stdout.trim().split('\n').filter(l => l.startsWith('{')).pop();
            if (!line) throw new Error('the depth sidecar returned no answer');
            const answer = JSON.parse(line) as {
                device: string; ms: number;
                views: Array<{ width: number; height: number; w2c: number[]; fx: number; fy: number; cx: number; cy: number; offset: number }>;
            };
            const raw = await fs.readFile(outPath);
            const all = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
            const views: RigDepthView[] = answer.views.map((v, i) => {
                const n = v.width * v.height;
                return {
                    panoId: images[i].panoId, yawDeg: images[i].yawDeg, w2c: v.w2c,
                    fx: v.fx, fy: v.fy, cx: v.cx, cy: v.cy, width: v.width, height: v.height,
                    depth: all.slice(v.offset, v.offset + n), conf: all.slice(v.offset + n, v.offset + 2 * n)
                };
            });
            return { views, device: answer.device, inferenceMs: answer.ms };
        } finally {
            await fs.remove(outPath).catch(() => undefined);
        }
    }
}
