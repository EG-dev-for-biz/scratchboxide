/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { Request, Response, Router } from 'express';
import { getNativeSkyMsService, NativeSkyMsService } from '../../../packages/core/src/node/3d-engine/native-sky-ms-service';
import { RouteContext } from './types';

/**
 * The scene weather's sky (native-sky-ms-service.ts).
 *
 * GET /multiple-scattering?sunElevationDeg&turbidity[&azimuthResolution&elevationResolution]
 *   -> { success, table: { dataBase64 (Float32 little-endian RGB), azimuthResolution, elevationResolution,
 *        horizontalIrradiance, sunTransmittance, aerosolOpticalDepth550, aerosolDensity, model } }
 */
export function createSkyRouter(ctx: RouteContext, deps: { sky?: NativeSkyMsService } = {}): Router {
    const router = Router();
    const sky = deps.sky ?? getNativeSkyMsService();
    router.get('/multiple-scattering', async (req: Request, res: Response) => {
        const sunElevationDeg = Number(req.query.sunElevationDeg);
        const turbidity = Number(req.query.turbidity);
        if (!Number.isFinite(sunElevationDeg) || !Number.isFinite(turbidity)) {
            res.status(400).json({ success: false, error: 'sunElevationDeg and turbidity are required numbers' });
            return;
        }
        const opt = (v: unknown) => (v === undefined ? undefined : Number(v));
        try {
            const t = await sky.skyViewTable({
                sunElevationDeg,
                turbidity,
                azimuthResolution: opt(req.query.azimuthResolution),
                elevationResolution: opt(req.query.elevationResolution)
            });
            const { data, ...rest } = t;
            res.setHeader('Cache-Control', 'no-store');
            res.json({ success: true, table: { ...rest, dataBase64: Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64') } });
        } catch (err) {
            if (err instanceof RangeError) { res.status(400).json({ success: false, error: err.message }); return; }
            ctx.sendError(res, err);
        }
    });
    return router;
}
