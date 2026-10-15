/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Closed-loop edge alignment renders the whole model once per trial pose in JS, on the server's event loop. On a
 * real tile GLB that took minutes with the loop blocked (no Stop, no tool time limit, no other requests). The search
 * now yields between renders, stops when the chat stops it, honours a time budget, and refuses unbounded limits.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { encodePng } from '../src/node/texture-processing';
import { HeadlessMeshSilhouetteRenderer } from '../src/node/spatial/HeadlessMeshSilhouetteRenderer';
import { SubPixelEdgeAlignmentOptimizer, computeSobelField, type CameraPose6DOF } from '../src/node/spatial/SubPixelEdgeAlignmentOptimizer';
import { skyscraperMesh, writeFixtureGlb } from './helpers/mesh-glb-fixtures';
import { createDefaultToolRegistry } from '../src/node/gemini/tool-registry';

const truth: CameraPose6DOF = { x: 0, y: 10, z: -40, targetX: 0, targetY: 10, targetZ: 0, fov: 45 };
const initialPose = { x: 2.5, y: 11, z: -38, targetX: 0.5, targetY: 10, targetZ: 0, fov: 47 };

describe('Closed-loop edge alignment does not hold the server', () => {
    const registry = createDefaultToolRegistry();
    let dir = '';
    let glbPath = '';
    let imagePath = '';
    let mesh: ReturnType<typeof HeadlessMeshSilhouetteRenderer.loadMeshFromGlb>;

    beforeAll(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-edge-coop-'));
        glbPath = writeFixtureGlb(path.join(dir, 'tower.glb'), skyscraperMesh(10, 15, 20));
        mesh = HeadlessMeshSilhouetteRenderer.loadMeshFromGlb(glbPath);
        const photo = HeadlessMeshSilhouetteRenderer.renderShadedMesh(mesh, truth, 320, 240, { clayColor: [200, 196, 188] });
        imagePath = path.join(dir, 'photo.png');
        fs.writeFileSync(imagePath, encodePng(320, 240, photo.rgba));
    });

    afterAll(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('timers keep firing while it searches, and it reports progress per render', async () => {
        let ticks = 0;
        let progress = 0;
        const timer = setInterval(() => { ticks++; }, 1);
        try {
            const res = await registry.dispatch('spatial_closed_loop_edge_align', {
                imagePath, glbPath, initialPose, maxIterations: 6, analysisMaxSide: 200
            }, { reportProgress: () => { progress++; } } as any);
            expect(res.exec.status).toBe('completed');
            const payload = res.resultPayload as any;
            expect(payload.renders).toBeGreaterThan(10);
            expect(progress).toBe(payload.renders);
            expect(['target reached', 'no further improvement', 'iteration limit']).toContain(payload.stoppedBy);
            expect(res.exec.summaryResult).toContain(`stopped: ${payload.stoppedBy}`);
        } finally {
            clearInterval(timer);
        }
        // A synchronous search would let no timer run until it returned.
        expect(ticks).toBeGreaterThan(3);
    });

    it('stops when the chat stops the call, without rendering on', async () => {
        const controller = new AbortController();
        let renders = 0;
        const res = await registry.dispatch('spatial_closed_loop_edge_align', {
            imagePath, glbPath, initialPose, maxIterations: 40, analysisMaxSide: 200
        }, { signal: controller.signal, reportProgress: () => { if (++renders === 3) controller.abort(); } } as any);
        expect(res.exec.status).toBe('failed');
        expect(String((res.resultPayload as any).error)).toMatch(/stopped before it finished/);
        expect(renders).toBe(3);
    });

    it('refuses unbounded limits instead of running for hours', async () => {
        for (const [arg, value, pattern] of [
            ['maxIterations', 500, /maxIterations: must be a number from 1 to 50/],
            ['analysisMaxSide', 4096, /analysisMaxSide: must be a number from 32 to 640/],
            ['timeBudgetSeconds', 3600, /timeBudgetSeconds: must be a number from 5 to 240/]
        ] as const) {
            const res = await registry.dispatch('spatial_closed_loop_edge_align', { imagePath, glbPath, initialPose, [arg]: value }, {} as any);
            expect(res.exec.status, arg).toBe('failed');
            expect(String((res.resultPayload as any).error), arg).toMatch(pattern);
        }
    });

    it('a time budget ends the search with the best pose it measured, and says so', async () => {
        const width = 160, height = 120;
        const photo = HeadlessMeshSilhouetteRenderer.renderEdgeField(mesh, truth, width, height);
        const query = computeSobelField(width, height, photo.magnitudes);
        const slowRender = async (pose: CameraPose6DOF) => {
            await new Promise(r => setTimeout(r, 15));
            return HeadlessMeshSilhouetteRenderer.renderEdgeField(mesh, pose, width, height);
        };
        const res = await SubPixelEdgeAlignmentOptimizer.optimizePoseAsync(initialPose, query, slowRender, {
            maxIterations: 40, targetOverlapScore: 99.99, subpixelTolerancePx: Infinity, timeBudgetMs: 120,
            stepSizes: { pos: 0.8, target: 0.4, fov: 1 }
        });
        expect(res.stoppedBy).toBe('time budget');
        expect(res.renders).toBeGreaterThan(0);
        expect(res.renders).toBeLessThan(15);
        expect(res.finalField.width).toBe(width);
        expect(res.converged).toBe(false);
    });

    it('the cooperative search finds the same pose as the synchronous one', async () => {
        const width = 120, height = 90;
        const query = computeSobelField(width, height, HeadlessMeshSilhouetteRenderer.renderEdgeField(mesh, truth, width, height).magnitudes);
        const render = (pose: CameraPose6DOF) => HeadlessMeshSilhouetteRenderer.renderEdgeField(mesh, pose, width, height);
        const options = { maxIterations: 8, targetOverlapScore: 99.5, subpixelTolerancePx: Infinity, stepSizes: { pos: 0.8, target: 0.4, fov: 1 } };
        const sync = SubPixelEdgeAlignmentOptimizer.optimizePoseTo100Percent(initialPose, query, render, options);
        const coop = await SubPixelEdgeAlignmentOptimizer.optimizePoseAsync(initialPose, query, render, options);
        expect(coop.finalPose).toEqual(sync.finalPose);
        expect(coop.iterations).toBe(sync.iterations);
        expect(coop.overlapScorePercent).toBe(sync.overlapScorePercent);
    });
});
