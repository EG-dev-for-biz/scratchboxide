/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Unit tests for Continuous Spline Matchmove HTTP REST Router.
 ********************************************************************************/

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'http';
import {
    ContinuousSplineApi,
    createContinuousSplineRouter,
    createContinuousSplineHttpHandler
} from '../src/node/spatial/continuous-spline-router';

describe('Continuous Spline Matchmove HTTP API (/api/3d/matchmove/continuous-spline)', () => {
    let server: http.Server;
    let base = '';

    beforeAll(async () => {
        const api = new ContinuousSplineApi();
        expect(typeof createContinuousSplineRouter).toBe('function');
        server = http.createServer(createContinuousSplineHttpHandler(api, '/api/3d/matchmove/continuous-spline'));
        await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
        base = `http://127.0.0.1:${(server.address() as any).port}/api/3d/matchmove/continuous-spline`;
    });

    afterAll(() => server?.close());

    const post = async (p: string, body: any) => {
        const r = await fetch(base + p, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body)
        });
        return { status: r.status, json: await r.json() };
    };

    it('GET /status reports service capabilities', async () => {
        const res = await fetch(base + '/status');
        const json = await res.json();
        expect(res.status).toBe(200);
        expect(json.success).toBe(true);
        expect(json.service).toBe('ContinuousSplineMatchmoveService');
    });

    it('POST /optimize minimizes reprojection error and regularizes trajectory', async () => {
        const knots = [
            { timeSec: 0.0, position: [46.0, 65.0, 5.0], target: [32.0, 68.0, 6.0], up: [0, 1, 0], fovYDeg: 46.0 },
            { timeSec: 2.0, position: [45.0, 42.0, 13.0], target: [35.0, 42.0, 15.0], up: [0, 1, 0], fovYDeg: 46.0 },
            { timeSec: 4.0, position: [42.6, 15.0, 22.0], target: [42.6, 0.0, 22.0], up: [-0.87, 0, -0.48], fovYDeg: 46.0 }
        ];

        const tracks = [
            {
                trackId: 'track_1',
                worldPoint3D: [32.0, 68.0, 5.0],
                observations: [
                    { frameNumber: 0, timeSec: 0.0, pixel2D: [640, 360], confidence: 1.0 },
                    { frameNumber: 48, timeSec: 2.0, pixel2D: [600, 380], confidence: 1.0 }
                ]
            }
        ];

        const anchors = [
            { timeSec: 0.0, position: [46.0, 65.0, 5.0], weight: 100.0 }
        ];

        const res = await post('/optimize', {
            knots,
            tracks,
            anchors,
            options: {
                maxIterations: 10,
                kinematicSmoothnessWeight: 1.0,
                enforceMonotonicDescent: true
            }
        });

        expect(res.status).toBe(200);
        expect(res.json.success).toBe(true);
        expect(res.json.optimizedKnots).toHaveLength(3);
        expect(res.json.finalRmsPx).toBeDefined();
    });

    it('POST /optimize rejects requests without valid knots with HTTP 400', async () => {
        const res = await post('/optimize', {
            knots: []
        });

        expect(res.status).toBe(400);
        expect(res.json.error).toMatch(/knots/i);
    });

    it('POST /synthesize returns dense 6-DOF frames, kinematics telemetry, and solveTrack', async () => {
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
        expect(res.json.denseTrajectory[0].velocityMps).toBeDefined();
        expect(res.json.denseTrajectory[0].accelerationMps2).toBeDefined();
        expect(res.json.denseTrajectory[0].jerkMps3).toBeDefined();
        expect(res.json.solveTrack).toBeDefined();
        expect(res.json.solveTrack.isSolved).toBe(true);
    });

    it('POST /synthesize rejects invalid duration or fps with HTTP 400', async () => {
        const res = await post('/synthesize', {
            knots: [{ timeSec: 0.0, position: [0, 0, 0], target: [0, 0, -1], up: [0, 1, 0], fovYDeg: 45 }],
            fps: -5
        });

        expect(res.status).toBe(400);
        expect(res.json.error).toMatch(/fps|duration/i);
    });
});
