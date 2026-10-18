/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Edge alignment renders split across worker threads: each worker rasterizes a triangle shard and the depth buffers
 * merge by per-pixel minimum, so the fields (and the poses the search picks) equal single-thread renders exactly.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HeadlessMeshSilhouetteRenderer } from '../src/node/spatial/HeadlessMeshSilhouetteRenderer';
import { HeadlessEdgeRenderPool } from '../src/node/spatial/HeadlessEdgeRenderPool';
import { SubPixelEdgeAlignmentOptimizer, type CameraPose6DOF } from '../src/node/spatial/SubPixelEdgeAlignmentOptimizer';
import { skyscraperMesh, writeFixtureGlb } from './helpers/mesh-glb-fixtures';

const truth: CameraPose6DOF = { x: 0, y: 10, z: -40, targetX: 0, targetY: 10, targetZ: 0, fov: 45 };
const initialPose: CameraPose6DOF = { x: 2.5, y: 11, z: -38, targetX: 0.5, targetY: 10, targetZ: 0, fov: 47 };

describe('HeadlessEdgeRenderPool', () => {
    let mesh: ReturnType<typeof HeadlessMeshSilhouetteRenderer.loadMeshFromGlb>;
    let pool: HeadlessEdgeRenderPool;

    beforeAll(async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-edge-pool-'));
        mesh = HeadlessMeshSilhouetteRenderer.loadMeshFromGlb(writeFixtureGlb(path.join(dir, 'tower.glb'), skyscraperMesh(10, 15, 20)));
        pool = await HeadlessEdgeRenderPool.create(mesh, 160, 120, 3);
    }, 60_000);
    afterAll(async () => { await pool?.close(); });

    it('renders the same edge fields as one thread, bit for bit, including views that leave the model partly off screen', async () => {
        expect(pool.size).toBe(3);
        const poses: CameraPose6DOF[] = [truth, initialPose, { ...truth, x: 25, targetX: 18 }, { ...truth, z: -12, fov: 80 }];
        const fields = await pool.render(poses);
        poses.forEach((pose, i) => {
            const ref = HeadlessMeshSilhouetteRenderer.renderEdgeField(mesh, pose, 160, 120);
            expect(Buffer.from(fields[i].magnitudes.buffer).equals(Buffer.from(ref.magnitudes.buffer))).toBe(true);
            expect(Buffer.from(fields[i].gradX.buffer).equals(Buffer.from(ref.gradX.buffer))).toBe(true);
            expect(fields[i].meanMagnitude).toBe(ref.meanMagnitude);
        });
    });

    it('a pooled search reaches the same pose as the one-render-at-a-time search', async () => {
        const query = HeadlessMeshSilhouetteRenderer.renderEdgeField(mesh, truth, 160, 120);
        const render = (p: CameraPose6DOF) => HeadlessMeshSilhouetteRenderer.renderEdgeField(mesh, p, 160, 120);
        const opts = { maxIterations: 4, targetOverlapScore: 99.9, subpixelTolerancePx: Number.POSITIVE_INFINITY, stepSizes: { pos: 0.8, target: 0.4, fov: 1.0 } };
        const sync = SubPixelEdgeAlignmentOptimizer.optimizePoseTo100Percent(initialPose, query, render, opts);
        const pooled = await SubPixelEdgeAlignmentOptimizer.optimizePoseAsync(initialPose, query, render, { ...opts, renderBatch: poses => pool.render(poses) });
        expect(pooled.finalPose).toEqual(sync.finalPose);
        expect(pooled.overlapScorePercent).toBe(sync.overlapScorePercent);
        expect(pooled.subpixelResidualPx).toBe(sync.subpixelResidualPx);
        expect(pooled.overlapScorePercent).toBeGreaterThan(SubPixelEdgeAlignmentOptimizer.optimizePoseTo100Percent(initialPose, query, render, { ...opts, maxIterations: 0 }).overlapScorePercent);
    });

    it('a worker that dies makes renders fail with the reason instead of hanging', async () => {
        const doomed = await HeadlessEdgeRenderPool.create(mesh, 64, 48, 2);
        await (doomed as any).workers[1].terminate();
        await expect(doomed.render([truth])).rejects.toThrow(/exited/);
        await doomed.close();
    }, 30_000);
});
