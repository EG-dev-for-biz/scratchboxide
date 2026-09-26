/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'http';
import {
    MatchmoveApi,
    createMatchmoveNodeHttpHandler
} from '../src/node/spatial/matchmove-router';

describe('Matchmove HTTP API (/api/spatial/matchmove)', () => {
    let server: http.Server;
    let base = '';

    beforeAll(async () => {
        const api = new MatchmoveApi();
        server = http.createServer(createMatchmoveNodeHttpHandler(api, '/api/spatial/matchmove'));
        await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
        base = `http://127.0.0.1:${(server.address() as any).port}/api/spatial/matchmove`;
    });

    afterAll(() => server?.close());

    const post = async (path: string, body: any) => {
        const r = await fetch(base + path, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body)
        });
        return { status: r.status, json: await r.json() };
    };

    it('GET /capabilities reports available matchmove solvers and default configuration', async () => {
        const res = await (await fetch(base + '/capabilities')).json();
        expect(res.success).toBe(true);
        expect(res.solvers).toContain('continuous-spline');
        expect(res.solvers).toContain('hermite-slerp');
        expect(res.defaultConfig.fps).toBe(24);
        expect(res.defaultConfig.durationSec).toBe(10.0);
    });

    it('POST /spline-fusion rejects missing knots', async () => {
        const res = await post('/spline-fusion', {});
        expect(res.status).toBe(400);
        expect(res.json.success).toBe(false);
        expect(res.json.error).toContain('knots');
    });

    it('POST /spline-fusion optimizes knots and returns dense trajectory', async () => {
        const knots = [
            { timeSec: 0.0, position: [46.0, 65.0, 5.0], target: [32.0, 68.0, 6.0], up: [0, 1, 0], fovYDeg: 46.0 },
            { timeSec: 2.0, position: [44.0, 40.0, 14.0], target: [35.0, 42.0, 15.0], up: [0, 1, 0], fovYDeg: 46.0 },
            { timeSec: 4.0, position: [42.6, 15.0, 22.0], target: [42.6, 0.0, 22.0], up: [-0.87, 0, -0.48], fovYDeg: 46.0 }
        ];

        const tracks = [
            {
                trackId: 'track_test_1',
                worldPoint3D: [32.0, 68.0, 5.0],
                observations: [
                    { frameNumber: 0, timeSec: 0.0, pixel2D: [640, 360], confidence: 1.0 },
                    { frameNumber: 48, timeSec: 2.0, pixel2D: [600, 380], confidence: 1.0 }
                ]
            }
        ];

        const res = await post('/spline-fusion', {
            knots,
            tracks,
            fps: 24,
            durationSec: 4.0,
            options: { maxIterations: 10 },
            exportSolveTrack: true
        });

        expect(res.status).toBe(200);
        expect(res.json.success).toBe(true);
        expect(res.json.optimizedKnots).toHaveLength(3);
        expect(res.json.initialRmsPx).toBeGreaterThanOrEqual(0);
        expect(res.json.denseTrajectory).toHaveLength(97); // 4s * 24fps + 1
        expect(res.json.solveTrack).toBeDefined();
        expect(res.json.solveTrack.isSolved).toBe(true);
    });

    it('POST /synthesize returns dense trajectory frames', async () => {
        const knots = [
            { timeSec: 0.0, position: [46.0, 65.0, 5.0], target: [32.0, 68.0, 6.0], up: [0, 1, 0], fovYDeg: 46.0 },
            { timeSec: 2.0, position: [42.6, 15.0, 22.0], target: [42.6, 0.0, 22.0], up: [0, 1, 0], fovYDeg: 46.0 }
        ];

        const res = await post('/synthesize', {
            knots,
            fps: 24,
            durationSec: 2.0,
            exportSolveTrack: true
        });

        expect(res.status).toBe(200);
        expect(res.json.success).toBe(true);
        expect(res.json.totalFrames).toBe(49);
        expect(res.json.denseTrajectory).toHaveLength(49);
        expect(res.json.denseTrajectory[0].position).toHaveLength(3);
        expect(res.json.denseTrajectory[0].rotationQuaternion).toHaveLength(4);
    });
});
