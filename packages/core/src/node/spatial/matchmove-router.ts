/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as path from 'path';
import * as fs from 'fs-extra';
import {
    ContinuousSplineMatchmoveService,
    SplineKnot,
    PersistentTrack3D2D,
    SplineAnchorConstraint,
    ContinuousSplineSolveOptions
} from './ContinuousSplineMatchmoveService';

export interface MatchmoveCapabilitiesResponse {
    success: boolean;
    solvers: string[];
    defaultConfig: {
        fps: number;
        durationSec: number;
        width: number;
        height: number;
        maxIterations: number;
        tolerancePx: number;
        kinematicSmoothnessWeight: number;
        huberLossThresholdPx: number;
    };
}

export class MatchmoveApi {
    private readonly service: ContinuousSplineMatchmoveService;

    constructor(service?: ContinuousSplineMatchmoveService) {
        this.service = service ?? new ContinuousSplineMatchmoveService();
    }

    /** GET /capabilities */
    capabilities(): MatchmoveCapabilitiesResponse {
        return {
            success: true,
            solvers: ['continuous-spline', 'hermite-slerp', 'catmull-rom'],
            defaultConfig: {
                fps: 24,
                durationSec: 10.0,
                width: 1920,
                height: 1080,
                maxIterations: 25,
                tolerancePx: 0.05,
                kinematicSmoothnessWeight: 1.0,
                huberLossThresholdPx: 4.0
            }
        };
    }

    /** POST /spline-fusion */
    splineFusion(body: any): any {
        let knots: SplineKnot[] = Array.isArray(body?.knots) ? body.knots : [];
        if (knots.length === 0 && body?.knotsPath) {
            const absPath = path.resolve(body.knotsPath);
            if (fs.existsSync(absPath)) {
                const parsed = fs.readJSONSync(absPath);
                knots = Array.isArray(parsed) ? parsed : (parsed.knots || parsed.frames || []);
            }
        }

        if (!knots || knots.length === 0) {
            throw new Error('Missing or invalid knots array. Provide at least 2 SplineKnot items.');
        }

        let tracks: PersistentTrack3D2D[] = Array.isArray(body?.tracks) ? body.tracks : [];
        if (tracks.length === 0 && body?.tracksPath) {
            const absPath = path.resolve(body.tracksPath);
            if (fs.existsSync(absPath)) {
                const parsed = fs.readJSONSync(absPath);
                tracks = Array.isArray(parsed) ? parsed : (parsed.tracks || []);
            }
        }

        const anchors: SplineAnchorConstraint[] = Array.isArray(body?.anchors) ? body.anchors : [];
        const width = typeof body?.width === 'number' && body.width > 0 ? body.width : 1920;
        const height = typeof body?.height === 'number' && body.height > 0 ? body.height : 1080;
        const fps = typeof body?.fps === 'number' && body.fps > 0 ? body.fps : 24;
        const durationSec = typeof body?.durationSec === 'number' && body.durationSec > 0 ? body.durationSec : 10.0;
        const exportSolveTrack = !!body?.exportSolveTrack;

        const options: ContinuousSplineSolveOptions = {
            maxIterations: body?.options?.maxIterations ?? body?.maxIterations ?? 25,
            tolerancePx: body?.options?.tolerancePx ?? body?.tolerancePx ?? 0.05,
            kinematicSmoothnessWeight: body?.options?.kinematicSmoothnessWeight ?? body?.kinematicSmoothnessWeight ?? 1.0,
            huberLossThresholdPx: body?.options?.huberLossThresholdPx ?? body?.huberLossThresholdPx ?? 4.0,
            enforceMonotonicDescent: body?.options?.enforceMonotonicDescent ?? body?.enforceMonotonicDescent ?? false
        };

        const optimization = this.service.optimizeSplineTrajectory(knots, tracks, anchors, width, height, options);
        const denseTrajectory = this.service.synthesizeDenseTrajectory(optimization.optimizedKnots, fps, durationSec);
        const solveTrack = exportSolveTrack
            ? this.service.toCameraSolveTrack(optimization.optimizedKnots, fps, durationSec)
            : undefined;

        if (body?.outputPath) {
            const absOut = path.resolve(body.outputPath);
            fs.mkdirpSync(path.dirname(absOut));
            const dataToSave = exportSolveTrack ? solveTrack : {
                totalFrames: denseTrajectory.length,
                fps,
                durationSec,
                optimization,
                frames: denseTrajectory
            };
            fs.writeJSONSync(absOut, dataToSave, { spaces: 2 });
        }

        return {
            success: true,
            initialRmsPx: optimization.initialRmsPx,
            finalRmsPx: optimization.finalRmsPx,
            iterations: optimization.iterations,
            optimizedKnots: optimization.optimizedKnots,
            totalFrames: denseTrajectory.length,
            fps,
            durationSec,
            denseTrajectory,
            solveTrack,
            outputPath: body?.outputPath
        };
    }

    /** POST /synthesize */
    synthesize(body: any): any {
        let knots: SplineKnot[] = Array.isArray(body?.knots) ? body.knots : [];
        if (knots.length === 0 && body?.knotsPath) {
            const absPath = path.resolve(body.knotsPath);
            if (fs.existsSync(absPath)) {
                const parsed = fs.readJSONSync(absPath);
                knots = Array.isArray(parsed) ? parsed : (parsed.knots || parsed.frames || []);
            }
        }

        if (!knots || knots.length === 0) {
            throw new Error('Missing or invalid knots array. Provide at least 2 SplineKnot items.');
        }

        const fps = typeof body?.fps === 'number' && body.fps > 0 ? body.fps : 24;
        const durationSec = typeof body?.durationSec === 'number' && body.durationSec > 0 ? body.durationSec : 10.0;
        const exportSolveTrack = !!body?.exportSolveTrack;

        const denseTrajectory = this.service.synthesizeDenseTrajectory(knots, fps, durationSec);
        const solveTrack = exportSolveTrack
            ? this.service.toCameraSolveTrack(knots, fps, durationSec)
            : undefined;

        if (body?.outputPath) {
            const absOut = path.resolve(body.outputPath);
            fs.mkdirpSync(path.dirname(absOut));
            const dataToSave = exportSolveTrack ? solveTrack : { totalFrames: denseTrajectory.length, fps, durationSec, frames: denseTrajectory };
            fs.writeJSONSync(absOut, dataToSave, { spaces: 2 });
        }

        return {
            success: true,
            totalFrames: denseTrajectory.length,
            fps,
            durationSec,
            denseTrajectory,
            solveTrack,
            outputPath: body?.outputPath
        };
    }
}

/**
 * Builds an Express router for matchmove endpoints.
 * Keeps express decoupled so the module works across runtimes.
 */
export function createMatchmoveRouter(express: any, api: MatchmoveApi = new MatchmoveApi()) {
    const router = express.Router();

    const wrap = (fn: (body: any, req: any) => any) => async (req: any, res: any) => {
        try {
            res.json(await fn(req.body || {}, req));
        } catch (e: any) {
            res.status(400).json({ success: false, error: e?.message || String(e) });
        }
    };

    router.get('/capabilities', (_req: any, res: any) => res.json(api.capabilities()));
    router.post('/spline-fusion', wrap(b => api.splineFusion(b)));
    router.post('/synthesize', wrap(b => api.synthesize(b)));

    return router;
}

/**
 * Minimal Node http adapter with the same routes as createMatchmoveRouter (used by tests and by
 * environments without express).
 */
export function createMatchmoveNodeHttpHandler(api: MatchmoveApi = new MatchmoveApi(), prefix = '/api/spatial/matchmove') {
    const send = (res: any, status: number, body: any) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
    };
    return async (req: any, res: any) => {
        const url = new URL(req.url || '/', 'http://local');
        if (!url.pathname.startsWith(prefix)) return send(res, 404, { success: false, error: 'not found' });
        const route = url.pathname.slice(prefix.length) || '/';
        let body: any = {};
        if (req.method === 'POST') {
            const chunks: Buffer[] = [];
            for await (const c of req) chunks.push(c);
            try {
                body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
            } catch {
                return send(res, 400, { success: false, error: 'invalid JSON' });
            }
        }
        try {
            if (req.method === 'GET' && route === '/capabilities') return send(res, 200, api.capabilities());
            if (req.method === 'POST') {
                switch (route) {
                    case '/spline-fusion': return send(res, 200, api.splineFusion(body));
                    case '/synthesize': return send(res, 200, api.synthesize(body));
                }
            }
            return send(res, 404, { success: false, error: 'not found' });
        } catch (e: any) {
            return send(res, 400, { success: false, error: e?.message || String(e) });
        }
    };
}
