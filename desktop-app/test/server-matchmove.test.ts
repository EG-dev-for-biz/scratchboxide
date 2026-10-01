/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import { createStandaloneServer } from '../server/app';

interface MockResponse {
    statusCode: number;
    data: any;
}

function handleGet(app: any, path: string, token: string): Promise<MockResponse> {
    return new Promise((resolve) => {
        const req: any = {
            method: 'GET',
            url: path,
            headers: {
                'x-scratchbox-token': token
            }
        };

        const res: any = {
            statusCode: 200,
            status(code: number) {
                this.statusCode = code;
                return this;
            },
            json(data: any) {
                this.data = data;
                resolve({ statusCode: this.statusCode, data });
                return this;
            },
            send(data: any) {
                this.data = data;
                resolve({ statusCode: this.statusCode, data });
                return this;
            },
            setHeader() {
                return this;
            }
        };

        app.handle(req, res);
    });
}

function handlePost(app: any, path: string, body: any, token: string): Promise<MockResponse> {
    return new Promise((resolve) => {
        const req: any = {
            method: 'POST',
            url: path,
            headers: {
                'x-scratchbox-token': token,
                'content-type': 'application/json'
            },
            body
        };

        const res: any = {
            statusCode: 200,
            status(code: number) {
                this.statusCode = code;
                return this;
            },
            json(data: any) {
                this.data = data;
                resolve({ statusCode: this.statusCode, data });
                return this;
            },
            send(data: any) {
                this.data = data;
                resolve({ statusCode: this.statusCode, data });
                return this;
            },
            setHeader() {
                return this;
            }
        };

        app.handle(req, res);
    });
}

describe('Standalone Server Matchmove REST Endpoints (/api/spatial/matchmove)', () => {
    const app = createStandaloneServer({ port: 0, toolsPort: 3997 });
    const token = app.locals.launchToken;

    it('returns solver capabilities and supported interpolation methods on GET /capabilities', async () => {
        const result = await handleGet(app, '/api/spatial/matchmove/capabilities', token);

        expect(result.statusCode).toBe(200);
        expect(result.data.success).toBe(true);
        expect(result.data.solvers).toContain('continuous-spline');
        expect(result.data.solvers).toContain('hermite-slerp');
        expect(result.data.defaultConfig).toBeDefined();
        expect(result.data.defaultConfig.fps).toBe(24);
    });

    it('rejects POST /spline-fusion without valid knots', async () => {
        const result = await handlePost(app, '/api/spatial/matchmove/spline-fusion', {}, token);

        expect(result.statusCode).toBe(400);
        expect(result.data.success).toBe(false);
        expect(result.data.error).toContain('knots');
    });

    it('optimizes spline knots and synthesizes dense trajectory on POST /spline-fusion', async () => {
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

        const payload = {
            knots,
            tracks,
            fps: 24,
            durationSec: 4.0,
            options: {
                maxIterations: 10,
                kinematicSmoothnessWeight: 1.0
            },
            exportSolveTrack: true
        };

        const result = await handlePost(app, '/api/spatial/matchmove/spline-fusion', payload, token);

        expect(result.statusCode).toBe(200);
        expect(result.data.success).toBe(true);
        expect(result.data.optimizedKnots).toHaveLength(3);
        expect(result.data.initialRmsPx).toBeGreaterThanOrEqual(0);
        expect(result.data.finalRmsPx).toBeDefined();
        expect(result.data.denseTrajectory).toBeDefined();
        expect(result.data.solveTrack).toBeDefined();
        expect(result.data.solveTrack.isSolved).toBe(true);
    });

    it('synthesizes dense trajectory on POST /synthesize', async () => {
        const knots = [
            { timeSec: 0.0, position: [46.0, 65.0, 5.0], target: [32.0, 68.0, 6.0], up: [0, 1, 0], fovYDeg: 46.0 },
            { timeSec: 2.0, position: [42.6, 15.0, 22.0], target: [42.6, 0.0, 22.0], up: [0, 1, 0], fovYDeg: 46.0 }
        ];

        const result = await handlePost(app, '/api/spatial/matchmove/synthesize', {
            knots,
            fps: 24,
            durationSec: 2.0,
            exportSolveTrack: true
        }, token);

        expect(result.statusCode).toBe(200);
        expect(result.data.success).toBe(true);
        expect(result.data.totalFrames).toBe(49); // 2s * 24fps + 1
        expect(result.data.denseTrajectory).toHaveLength(49);
        expect(result.data.solveTrack).toBeDefined();
    });
});
