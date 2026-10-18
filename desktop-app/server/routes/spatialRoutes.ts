/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { Request, Response, Router } from 'express';
import * as fs from 'fs-extra';
import * as path from 'path';
import {
    PhotorealTileCleanupService,
    Google360PanoramaPipelineService,
    GoogleMediaCredentialsService,
    DeploymentManifestCompiler,
    ImageToSplatService
} from '../../../packages/core/src/node';
import { PanoramaDepthService } from '../../../packages/core/src/node/spatial/PanoramaDepthService';
import type { VideoKeyframeInput } from '../../../packages/core/src/node/3d-engine/image-to-splat-service';
import { GeoFrame } from '../../../packages/core/src/common/coordinate/GeoFrame';
import { getGoogle3DTilesClay } from '../../../packages/core/src/node/spatial/Google3DTileBlockoutPipelineService';
import { LocationUnresolvedError, MediaModelUnavailableError, MissingInputError } from '../../../packages/core/src/common/errors/pipeline-errors';
import { resolveWithinRoot } from '../../../packages/core/src/node/security/path-guard';
import { RouteContext } from './types';
import * as os from 'os';
import { mapsKeyStatus, saveMapsKeySetting } from '../../../packages/core/src/node/spatial/maps-key-settings';
import { geoidUndulation } from '../../../packages/core/src/node/spatial/egm96-geoid';
import { ModelAnswerResolutionError } from '../../../packages/core/src/node/spatial/Google360PanoramaPipelineService';

export function createTileCleanupRouter(tileCleanupService: PhotorealTileCleanupService, ctx: RouteContext): Router {
    const router = Router();

    // The tile to clean comes from the request: an uploaded GLB (glbBase64) or a path inside an allowed workspace root
    // (inputGlbPath, relative to workspaceRoot). There is no built-in model.
    const withInputTile = async <T>(body: any, run: (inputGlbPath: string) => Promise<T>): Promise<T> => {
        if (typeof body?.glbBase64 === 'string' && body.glbBase64.length > 0) {
            const buf = Buffer.from(body.glbBase64, 'base64');
            if (buf.length < 12 || buf.toString('utf8', 0, 4) !== 'glTF') {
                throw new MissingInputError('tile cleanup', 'glbBase64', 'the upload is not a binary glTF (.glb)');
            }
            const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sbx-tile-cleanup-'));
            const file = path.join(dir, 'input.glb');
            try {
                await fs.writeFile(file, buf);
                return await run(file);
            } finally {
                await fs.remove(dir);
            }
        }
        if (typeof body?.inputGlbPath === 'string' && body.inputGlbPath.trim()) {
            const root = ctx.requireWorkspaceRoot(body.workspaceRoot);
            return run(resolveWithinRoot(root, body.inputGlbPath.trim()));
        }
        throw new MissingInputError('tile cleanup', 'glbBase64 or inputGlbPath', 'send the photogrammetric tile (.glb) to clean');
    };

    const sendCleanupError = (res: Response, err: any): void => {
        if (err instanceof MissingInputError) {
            res.status(400).json({ success: false, error: err.code, message: err.message });
            return;
        }
        ctx.sendError(res, err);
    };

    router.get('/status', (_req: Request, res: Response) => {
        res.json({
            success: true,
            service: 'scratchbox-tile-cleanup',
            engine: 'C++20 Native Photogrammetry Engine',
            pipeline: [
                'PlanarDecimation',
                'CornerStraightener',
                'TextureDeLighter',
                'SemanticMeshSeparator',
                'ElevationConformer'
            ],
            cloudRunReady: true,
            timestamp: Date.now()
        });
    });

    router.post('/cleanup', async (req: Request, res: Response) => {
        try {
            const {
                angleThresholdDegrees,
                snapToleranceMeters,
                roadWidthMeters
            } = req.body || {};

            const result = await withInputTile(req.body, inputGlbPath => tileCleanupService.cleanPhotogrammetryTile({
                inputGlbPath,
                angleThresholdDegrees: typeof angleThresholdDegrees === 'number' ? angleThresholdDegrees : 4.0,
                snapToleranceMeters: typeof snapToleranceMeters === 'number' ? snapToleranceMeters : 0.85,
                roadWidthMeters: typeof roadWidthMeters === 'number' ? roadWidthMeters : 8.0
            }));

            res.json({
                success: true,
                metrics: result.metrics,
                glbBase64: result.glbBase64,
                byteLength: result.glbBuffer ? result.glbBuffer.length : 0
            });
        } catch (err: any) {
            sendCleanupError(res, err);
        }
    });

    router.post('/cleanup-raw', async (req: Request, res: Response) => {
        try {
            const {
                angleThresholdDegrees,
                snapToleranceMeters,
                roadWidthMeters
            } = req.body || {};

            const result = await withInputTile(req.body, inputGlbPath => tileCleanupService.cleanPhotogrammetryTile({
                inputGlbPath,
                angleThresholdDegrees: typeof angleThresholdDegrees === 'number' ? angleThresholdDegrees : 4.0,
                snapToleranceMeters: typeof snapToleranceMeters === 'number' ? snapToleranceMeters : 0.85,
                roadWidthMeters: typeof roadWidthMeters === 'number' ? roadWidthMeters : 8.0
            }));

            if (!result.glbBuffer) {
                res.status(500).json({ success: false, error: 'Failed to generate GLB buffer' });
                return;
            }

            res.setHeader('Content-Type', 'model/gltf-binary');
            res.setHeader('Content-Disposition', 'attachment; filename="cleaned_tile.glb"');
            res.send(result.glbBuffer);
        } catch (err: any) {
            sendCleanupError(res, err);
        }
    });

    // Resolves the query with Google Places (or as coordinates) and extracts fresh clay tiles there. There is no
    // place table and no default model: an unresolvable place or a failed extraction is an error response.
    router.all('/query', async (req: Request, res: Response) => {
        const query = (req.body?.query || req.query?.q || req.query?.query || '').toString().trim();
        if (!query) {
            res.status(400).json({ success: false, error: 'Query parameter is required' });
            return;
        }
        try {
            const result = await getGoogle3DTilesClay(query, {
                outputGlbPath: path.resolve(process.cwd(), 'public/models', `tile_${Date.now()}.glb`)
            });
            const glbFile = path.basename(result.glbPath);
            res.json({
                success: true,
                query,
                landmarkName: result.resolvedAddress,
                glbUrl: `/models/${glbFile}`,
                glbPath: `public/models/${glbFile}`,
                mesh: {
                    vertexCount: result.mesh.vertexCount,
                    triangleCount: result.mesh.triangleCount,
                    reliefDeltaY: result.mesh.boundingBox.max[1] - result.mesh.boundingBox.min[1]
                },
                geoAnchor: {
                    lat: result.geoAnchor.lat,
                    lng: result.geoAnchor.lng,
                    landmarkName: result.resolvedAddress
                }
            });
        } catch (err: any) {
            res.status(err instanceof LocationUnresolvedError ? 422 : 502).json({
                success: false,
                error: err?.message || 'Tile query failed',
                ...(typeof err?.code === 'string' ? { code: err.code } : {})
            });
        }
    });

    return router;
}

export function createPbrRouter(): Router {
    const router = Router();

    router.post('/colosseum/rerun', async (_req: Request, res: Response) => {
        try {
            const { runColosseum1kPbrPipeline } = require(path.resolve(process.cwd(), 'scripts/apply_colosseum_1k_pbr_suite.cjs'));
            const result = await runColosseum1kPbrPipeline();
            res.json({ success: true, ...result });
        } catch (err: any) {
            res.status(500).json({ success: false, error: err?.message || 'Colosseum PBR synthesis failed' });
        }
    });

    router.get('/colosseum/status', async (_req: Request, res: Response) => {
        const glbPath = path.resolve(process.cwd(), 'public/models/colosseum_rome_1k_pbr.glb');
        if (fs.existsSync(glbPath)) {
            const stat = fs.statSync(glbPath);
            res.json({
                exists: true,
                fileSizeBytes: stat.size,
                fileSizeMb: (stat.size / (1024 * 1024)).toFixed(2),
                lastModified: stat.mtime.toISOString(),
                glbUrl: '/models/colosseum_rome_1k_pbr.glb'
            });
        } else {
            res.json({ exists: false });
        }
    });

    return router;
}

export function createArRouter(): Router {
    const router = Router();

    router.post('/compile', async (req: Request, res: Response) => {
        try {
            const { anchor, entities, scene, targetBranchId, timestamp, vectorMap, splatConfig, defaultAltitudeMode, weather } = req.body || {};
            if (!anchor || typeof anchor.lat !== 'number' || typeof anchor.lng !== 'number') {
                res.status(400).json({ success: false, error: 'Missing or invalid geodetic anchor { lat, lng }' });
                return;
            }

            const geoFrame = new GeoFrame({
                lat: anchor.lat,
                lng: anchor.lng,
                alt: anchor.alt ?? 0,
                geoidHeight: anchor.geoidHeight ?? 0
            });

            const targetScene = scene || entities || [];
            const contract = await DeploymentManifestCompiler.compile({
                geoFrame,
                scene: targetScene,
                targetBranchId: targetBranchId || 'earth/main',
                timestamp: timestamp ? new Date(timestamp) : undefined,
                vectorMap,
                splatConfig,
                defaultAltitudeMode,
                weather: weather !== undefined ? weather : false
            });

            const validation = DeploymentManifestCompiler.validateContract(contract);
            res.json({
                success: true,
                contract,
                validation
            });
        } catch (err: any) {
            res.status(500).json({
                success: false,
                error: err?.message || 'Geospatial manifest compilation failed'
            });
        }
    });

    return router;
}

/**
 * A failed panorama step: a missing input is the caller's error (422), a model that could not produce the image is
 * a bad gateway (502), anything else a server error. The typed error's code goes with the message.
 */
function sendPanoramaFailure(res: Response, err: any, fallbackMessage: string): void {
    // A panorama too large for the allowed enlargement is refused before any model call (the caller's request, 422);
    // a model answer that came back too small or re-framed is the model's (502).
    const status = err instanceof MissingInputError ? 422
        : err instanceof ModelAnswerResolutionError ? (err.beforeCall ? 422 : 502)
            : err instanceof MediaModelUnavailableError ? 502 : 500;
    res.status(status).json({
        success: false,
        error: err?.message || fallbackMessage,
        ...(typeof err?.code === 'string' ? { code: err.code } : {})
    });
}

/**
 * Panorama model steps over HTTP. Request bodies cannot switch a step into a mock run: every step runs the image
 * model (or the explicitly requested procedural mode) and the response names the model that answered.
 */
export function createPanoramaRouter(mediaCredentials: GoogleMediaCredentialsService): Router {
    const router = Router();
    const panoramaService = new Google360PanoramaPipelineService(mediaCredentials);

    router.post('/heal-seam', async (req: Request, res: Response) => {
        try {
            const { inputImagePath, inputImageBase64, prompt, seamWidth, outputImagePath, model, maxModelUpscale } = req.body || {};
            const inputBuffer = inputImageBase64 ? Buffer.from(inputImageBase64, 'base64') : undefined;

            const result = await panoramaService.healPanoramaSeam({
                inputImagePath,
                inputImageBuffer: inputBuffer,
                prompt,
                seamWidth,
                outputImagePath,
                model,
                maxModelUpscale: typeof maxModelUpscale === 'number' ? maxModelUpscale : undefined
            });

            res.json({
                success: true,
                width: result.width,
                height: result.height,
                seamWidth: result.seamWidth,
                outputImagePath: result.outputImagePath,
                outputImageBase64: result.outputBuffer.toString('base64'),
                modelUsed: result.modelUsed,
                skippedModels: result.skippedModels,
                modelNote: result.modelNote,
                summary: result.summary
            });
        } catch (err: any) {
            sendPanoramaFailure(res, err, 'Failed to heal panorama seam');
        }
    });

    router.post('/inpaint', async (req: Request, res: Response) => {
        try {
            const { inputImagePath, inputImageBase64, maskImagePath, maskImageBase64, nadirOnly, nadirRatio, prompt, outputImagePath, model, maxModelUpscale } = req.body || {};
            const inputBuffer = inputImageBase64 ? Buffer.from(inputImageBase64, 'base64') : undefined;
            const maskBuffer = maskImageBase64 ? Buffer.from(maskImageBase64, 'base64') : undefined;

            const result = await panoramaService.inpaintPanorama({
                inputImagePath,
                inputImageBuffer: inputBuffer,
                maskImagePath,
                maskImageBuffer: maskBuffer,
                nadirOnly,
                nadirRatio,
                prompt,
                outputImagePath,
                model,
                maxModelUpscale: typeof maxModelUpscale === 'number' ? maxModelUpscale : undefined
            });

            res.json({
                success: true,
                width: result.width,
                height: result.height,
                outputImagePath: result.outputImagePath,
                outputImageBase64: result.outputBuffer.toString('base64'),
                modelUsed: result.modelUsed,
                skippedModels: result.skippedModels,
                modelNote: result.modelNote,
                summary: result.summary
            });
        } catch (err: any) {
            sendPanoramaFailure(res, err, 'Failed to inpaint panorama');
        }
    });

    router.post('/generate', async (req: Request, res: Response) => {
        try {
            const { prompt, style, width, height, healSeam, inpaintNadir, outputImagePath, model, maxModelUpscale } = req.body || {};
            if (!prompt) {
                res.status(400).json({ success: false, error: 'prompt is required to generate 360 panorama' });
                return;
            }

            const result = await panoramaService.generate360Panorama({
                prompt,
                style,
                width,
                height,
                healSeam,
                inpaintNadir,
                outputImagePath,
                model,
                maxModelUpscale: typeof maxModelUpscale === 'number' ? maxModelUpscale : undefined
            });

            res.json({
                success: true,
                width: result.width,
                height: result.height,
                seamHealed: result.seamHealed,
                outputImagePath: result.outputImagePath,
                outputImageBase64: result.outputBuffer.toString('base64'),
                modelUsed: result.modelUsed,
                skippedModels: result.skippedModels,
                modelNote: result.modelNote,
                summary: result.summary
            });
        } catch (err: any) {
            sendPanoramaFailure(res, err, 'Failed to generate 360 panorama');
        }
    });

    router.post('/upscale-16k', async (req: Request, res: Response) => {
        try {
            const { inputImagePath, inputImageBase64, engine, outputImagePath, seamWidth } = req.body || {};
            const inputBuffer = inputImageBase64 ? Buffer.from(inputImageBase64, 'base64') : undefined;

            const result = await panoramaService.upscalePanorama16K({
                inputImagePath,
                inputImageBuffer: inputBuffer,
                engine,
                outputImagePath,
                seamWidth
            });

            res.json({
                success: true,
                inputWidth: result.inputWidth,
                inputHeight: result.inputHeight,
                outputWidth: result.outputWidth,
                outputHeight: result.outputHeight,
                outputImagePath: result.outputImagePath,
                outputImageBase64: result.outputBuffer.toString('base64'),
                engineUsed: result.engineUsed,
                seamHealed: result.seamHealed,
                durationMs: result.durationMs,
                summary: result.summary
            });
        } catch (err: any) {
            sendPanoramaFailure(res, err, 'Failed to upscale panorama to 16K');
        }
    });

    return router;
}

export function createSplatStudioRouter(): Router {
    const router = Router();

    router.get('/sources', (_req: Request, res: Response) => {
        try {
            const catalog = ImageToSplatService.getPublicSourceCatalog();
            res.json({ success: true, catalog });
        } catch (err: any) {
            res.status(500).json({ success: false, error: err?.message || 'Failed to retrieve public sources catalog' });
        }
    });

    /** Pixels sent as base64 (or a byte array) become a Uint8Array. */
    const toPixels = (v: any): Uint8Array => Buffer.isBuffer(v) ? v : (typeof v === 'string' ? Buffer.from(v, 'base64') : new Uint8Array(v || []));
    const depthService = new PanoramaDepthService();
    /**
     * Each view without a depth map gets one from the depth model (Depth Anything V2 Small). The depth is relative
     * (median 1 per view) unless the request gives the scene's median depth in metres (per view or for all views).
     */
    async function withModelDepth<T extends { rgbPixels: Uint8Array; width: number; height: number; channels?: number; fovDegrees?: number; metricDepths?: any; medianDepthMeters?: number }>(
        views: T[], medianDepthMeters: number | undefined
    ): Promise<{ views: T[]; depthUnits: string[]; depthModel: string }> {
        const units: string[] = [];
        let depthModel = '';
        const out: T[] = [];
        for (const v of views) {
            if (v.metricDepths) { out.push(v); units.push('caller'); continue; }
            const depth = await depthService.generatePixelBufferDepth(v.rgbPixels, v.width, v.height, {
                channels: v.channels ?? 3,
                fovDegrees: v.fovDegrees ?? 65.0,
                medianDepthMeters: typeof v.medianDepthMeters === 'number' ? v.medianDepthMeters : medianDepthMeters
            });
            depthModel = depth.modelUsed;
            units.push(depth.depthUnits);
            out.push({ ...v, metricDepths: depth.rayDepths });
        }
        return { views: out, depthUnits: units, depthModel };
    }
    const sendSplatFailure = (res: Response, err: any, fallback: string) => {
        const status = err instanceof MissingInputError || err?.name === 'InvalidInputError' ? 400 : 500;
        res.status(status).json({ success: false, error: err?.message || fallback, errorType: err?.name });
    };
    const medianOf = (body: any): number | undefined => {
        const m = body?.medianDepthMeters;
        if (m === undefined || m === null) return undefined;
        if (!(typeof m === 'number' && m > 0)) throw new MissingInputError('splat-studio', 'medianDepthMeters', `must be a positive distance in metres (got ${JSON.stringify(m)})`);
        return m;
    };

    /**
     * Depth for one image's pixels from the depth model: { rgbPixels (base64), width, height, channels, fovDegrees,
     * medianDepthMeters? } -> { rayDepths (base64 float32, depth along each pixel's pinhole ray), depthUnits, depthModel }.
     */
    router.post('/depth', async (req: Request, res: Response) => {
        try {
            const { rgbPixels, width, height, channels = 4, fovDegrees } = req.body || {};
            if (!rgbPixels || !(width > 0) || !(height > 0)) throw new MissingInputError('depth', 'rgbPixels', 'rgbPixels, width and height are required');
            if (!(typeof fovDegrees === 'number' && fovDegrees > 1 && fovDegrees < 179)) throw new MissingInputError('depth', 'fovDegrees', 'the vertical field of view in degrees is required');
            const depth = await depthService.generatePixelBufferDepth(toPixels(rgbPixels), width, height, {
                channels, fovDegrees, medianDepthMeters: medianOf(req.body)
            });
            res.json({
                success: true,
                width, height,
                rayDepths: Buffer.from(depth.rayDepths.buffer, depth.rayDepths.byteOffset, depth.rayDepths.byteLength).toString('base64'),
                depthUnits: depth.depthUnits,
                depthModel: depth.modelUsed,
                farPlanePixels: depth.farPlanePixels,
                minDepth: depth.minDepth,
                maxDepth: depth.maxDepth
            });
        } catch (err: any) {
            sendSplatFailure(res, err, 'Depth measurement failed');
        }
    });

    router.post('/single-to-splat', async (req: Request, res: Response) => {
        try {
            const { view, stride = 1, edgeTau = 0.08, minDepth = 0.2, maxDepth = 200.0 } = req.body || {};
            if (!view?.rgbPixels || !view.width || !view.height) throw new MissingInputError('single-to-splat', 'view', 'rgbPixels, width and height are required');
            const { views, depthUnits, depthModel } = await withModelDepth([{ ...view, rgbPixels: toPixels(view.rgbPixels) }], medianOf(req.body));
            let floatersPruned = 0;
            const splats = ImageToSplatService.convertSingleImageToSplat({ ...views[0], channels: views[0].channels ?? 3, stride, edgeTau, minDepth, maxDepth, onFloaterReport: r => { floatersPruned = r.pruned; } });
            res.json({ success: true, splatCount: splats.length, floatersPruned, splats, depthModel, depthUnits: depthUnits[0] });
        } catch (err: any) {
            sendSplatFailure(res, err, 'Single image splat conversion failed');
        }
    });

    router.post('/multiview-to-splat', async (req: Request, res: Response) => {
        try {
            const { views = [], voxelSize = 0.05, densifyMaxScale = 0, stride = 1, edgeTau = 0.08, minDepth = 0.2, maxDepth = 200.0 } = req.body || {};
            const withDepth = await withModelDepth(views.map((v: any) => ({ ...v, rgbPixels: toPixels(v.rgbPixels) })), medianOf(req.body));
            const splats = ImageToSplatService.convertMultiViewImagesToSplat({
                views: withDepth.views,
                voxelSize,
                densifyMaxScale,
                stride,
                edgeTau,
                minDepth,
                maxDepth
            });
            res.json({ success: true, splatCount: splats.length, splats, depthModel: withDepth.depthModel, depthUnits: withDepth.depthUnits });
        } catch (err: any) {
            sendSplatFailure(res, err, 'Multi-view splat conversion failed');
        }
    });

    router.post('/video-to-splat', async (req: Request, res: Response) => {
        try {
            const {
                keyframes = [],
                trajectoryType = 'orbit',
                orbitRadius = 12.0,
                orbitSweepDegrees = 90.0,
                dollyDistance = 8.0,
                panDistance = 6.0,
                voxelSize = 0.04,
                densifyMaxScale = 0,
                stride = 1,
                edgeTau = 0.08,
                minDepth = 0.2,
                maxDepth = 200.0
            } = req.body || {};

            const withDepth = await withModelDepth<VideoKeyframeInput>(keyframes.map((kf: any, i: number) => ({ ...kf, frameIndex: typeof kf.frameIndex === 'number' ? kf.frameIndex : i, rgbPixels: toPixels(kf.rgbPixels) })), medianOf(req.body));
            const splats = ImageToSplatService.convertVideoKeyframesToSplat({
                keyframes: withDepth.views,
                trajectoryType,
                orbitRadius,
                orbitSweepDegrees,
                dollyDistance,
                panDistance,
                voxelSize,
                densifyMaxScale,
                stride,
                edgeTau,
                minDepth,
                maxDepth
            });

            res.json({ success: true, splatCount: splats.length, splats, depthModel: withDepth.depthModel, depthUnits: withDepth.depthUnits });
        } catch (err: any) {
            sendSplatFailure(res, err, 'Video keyframe splat conversion failed');
        }
    });

    router.post('/export-splat', (req: Request, res: Response) => {
        try {
            const { splats = [] } = req.body || {};
            const buffer = ImageToSplatService.serializeToSplatBuffer(splats);
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Content-Disposition', 'attachment; filename="depthbox_environment.splat"');
            res.send(buffer);
        } catch (err: any) {
            res.status(500).json({ success: false, error: err?.message || 'Splat serialization failed' });
        }
    });

    return router;
}

/** Geodesy helpers for the renderer: EGM96 geoid undulation (MSL -> WGS84 ellipsoid offset). */
export function createGeoRouter(): Router {
    const router = Router();
    router.get('/geoid', (req: Request, res: Response) => {
        const lat = Number(req.query.lat), lng = Number(req.query.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90) {
            res.status(400).json({ error: 'lat and lng are required numbers' });
            return;
        }
        try {
            res.json({ lat, lng, undulationMeters: geoidUndulation(lat, lng), model: 'EGM96 15-minute grid' });
        } catch (err: any) {
            res.status(500).json({ error: err?.message || String(err) });
        }
    });
    /** Whether the server has a Maps key and whether one is saved in Settings: { configured, savedInSettings }. Never the key. */
    router.get('/maps-key', (_req: Request, res: Response) => {
        try {
            res.json(mapsKeyStatus());
        } catch (err: any) {
            res.status(500).json({ error: err?.message || String(err) });
        }
    });
    /**
     * The Google Maps key saved in Settings: the chat tools (Places lookups, 3D Tiles) run here, so the key the user
     * saves must reach this process. Body { apiKey }; an empty key clears it and puts back the environment's or secrets
     * file's key, if any. The key is never echoed back.
     */
    router.post('/maps-key', async (req: Request, res: Response) => {
        const apiKey = req.body?.apiKey;
        if (typeof apiKey !== 'string') {
            res.status(400).json({ success: false, error: 'apiKey must be a string (empty to clear the saved key)' });
            return;
        }
        try {
            const { configured } = await saveMapsKeySetting(apiKey);
            res.json({ success: true, configured });
        } catch (err: any) {
            res.status(500).json({ success: false, error: err?.message || String(err) });
        }
    });
    return router;
}
