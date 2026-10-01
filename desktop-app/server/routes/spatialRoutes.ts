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
    Depthbox360UniverseService,
    ImageToSplatService
} from '../../../packages/core/src/node';
import { GeoFrame } from '../../../packages/core/src/common/coordinate/GeoFrame';

export function createTileCleanupRouter(tileCleanupService: PhotorealTileCleanupService): Router {
    const router = Router();

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

            const result = await tileCleanupService.cleanPhotogrammetryTile({
                angleThresholdDegrees: typeof angleThresholdDegrees === 'number' ? angleThresholdDegrees : 4.0,
                snapToleranceMeters: typeof snapToleranceMeters === 'number' ? snapToleranceMeters : 0.85,
                roadWidthMeters: typeof roadWidthMeters === 'number' ? roadWidthMeters : 8.0
            });

            res.json({
                success: true,
                metrics: result.metrics,
                glbBase64: result.glbBase64,
                byteLength: result.glbBuffer ? result.glbBuffer.length : 0
            });
        } catch (err: any) {
            res.status(500).json({
                success: false,
                error: err?.message || 'Tile cleanup pipeline execution failed'
            });
        }
    });

    router.post('/cleanup-raw', async (req: Request, res: Response) => {
        try {
            const {
                angleThresholdDegrees,
                snapToleranceMeters,
                roadWidthMeters
            } = req.body || {};

            const result = await tileCleanupService.cleanPhotogrammetryTile({
                angleThresholdDegrees: typeof angleThresholdDegrees === 'number' ? angleThresholdDegrees : 4.0,
                snapToleranceMeters: typeof snapToleranceMeters === 'number' ? snapToleranceMeters : 0.85,
                roadWidthMeters: typeof roadWidthMeters === 'number' ? roadWidthMeters : 8.0
            });

            if (!result.glbBuffer) {
                res.status(500).json({ success: false, error: 'Failed to generate GLB buffer' });
                return;
            }

            res.setHeader('Content-Type', 'model/gltf-binary');
            res.setHeader('Content-Disposition', 'attachment; filename="cleaned_tile.glb"');
            res.send(result.glbBuffer);
        } catch (err: any) {
            res.status(500).json({
                success: false,
                error: err?.message || 'Tile cleanup pipeline execution failed'
            });
        }
    });

    router.all('/query', async (req: Request, res: Response) => {
        try {
            const query = (req.body?.query || req.query?.q || req.query?.query || '').toString().trim();
            if (!query) {
                res.status(400).json({ success: false, error: 'Query parameter is required' });
                return;
            }

            const lower = query.toLowerCase();
            let glbFile = 'sf_ferry_raw.glb';
            let landmarkName = 'San Francisco Ferry Building';
            let lat = 37.7955;
            let lng = -122.3937;
            let vertexCount = 28004;
            let triangleCount = 13920;
            let reliefDeltaY = 191.2;

            if (lower.includes('colosseum') || lower.includes('rome') || lower.includes('amphitheat')) {
                glbFile = 'colosseum_clay.glb';
                landmarkName = 'Colosseum, Rome';
                lat = 41.8902;
                lng = 12.4922;
                vertexCount = 234679;
                triangleCount = 170802;
                reliefDeltaY = 84.12;
            } else if (lower.includes('empire') || lower.includes('esb') || lower.includes('state building')) {
                glbFile = 'esb_clay.glb';
                landmarkName = 'Empire State Building, New York';
                lat = 40.7484;
                lng = -73.9857;
                vertexCount = 28004;
                triangleCount = 13920;
                reliefDeltaY = 443.95;
            } else if (lower.includes('ferry') || lower.includes('san francisco') || lower.includes('embarcadero')) {
                glbFile = 'sf_ferry_raw.glb';
                landmarkName = 'San Francisco Ferry Building';
                lat = 37.7955;
                lng = -122.3937;
                vertexCount = 28004;
                triangleCount = 13920;
                reliefDeltaY = 191.2;
            } else {
                try {
                    const { getGoogle3DTilesClay } = require('../../../packages/core/src/node/spatial/Google3DTileBlockoutPipelineService');
                    const targetGlb = path.resolve(process.cwd(), 'public/models', `tile_${Date.now()}.glb`);
                    const result = await getGoogle3DTilesClay(query, {
                        outputGlbPath: targetGlb,
                        offlineMock: !process.env.GOOGLE_MAPS_API_KEY
                    });
                    if (result && result.success && fs.existsSync(result.glbPath)) {
                        glbFile = path.basename(result.glbPath);
                        landmarkName = result.resolvedAddress || query;
                        lat = result.geoAnchor?.lat || lat;
                        lng = result.geoAnchor?.lng || lng;
                        vertexCount = result.mesh?.vertexCount || vertexCount;
                        triangleCount = result.mesh?.triangleCount || triangleCount;
                    }
                } catch (e) {
                    // Fallback to default
                }
            }

            res.json({
                success: true,
                query,
                landmarkName,
                glbUrl: `/models/${glbFile}`,
                glbPath: `public/models/${glbFile}`,
                mesh: {
                    vertexCount,
                    triangleCount,
                    reliefDeltaY
                },
                geoAnchor: {
                    lat,
                    lng,
                    landmarkName
                }
            });
        } catch (err: any) {
            res.status(500).json({
                success: false,
                error: err?.message || 'Tile query failed'
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

export function createDepthbox360Router(): Router {
    const router = Router();

    router.get('/presets', (_req: Request, res: Response) => {
        res.json({
            success: true,
            presets: [
                { id: 'san_marco', name: 'Piazza San Marco, Venice', description: 'Historic Venetian square with marble colonnades, St. Mark Basilica, and Campanile belfry.' },
                { id: 'alpine_summit', name: 'Alpine Glacial Sanctuary', description: 'Crystalline turquoise lake surrounded by soaring snow-capped granite ridges and pine trees.' },
                { id: 'cyber_shibuya', name: 'Cyber Shibuya Crossing', description: 'Wet reflective asphalt, towering holographic billboards, neon rain, and cybernetic infrastructure.' },
                { id: 'roman_forum', name: 'Ancient Roman Forum', description: 'Corinthian travertine columns, triumphal arches, and golden hour Mediterranean illumination.' },
                { id: 'martian_biodome', name: 'Martian Bio-Dome Colony', description: 'Pressurized geodesic glass domes, red iron oxide regolith, rover docks, and terraforming atmosphere.' }
            ]
        });
    });

    router.post('/generate', (req: Request, res: Response) => {
        try {
            const config = req.body || {};
            const universe = Depthbox360UniverseService.generate360Universe(config);
            res.json({
                success: true,
                splats: universe.splats,
                colliders: universe.colliders,
                atmosphere: universe.atmosphere,
                statistics: universe.statistics
            });
        } catch (err: any) {
            res.status(500).json({ success: false, error: err?.message || '360 universe synthesis failed' });
        }
    });

    router.post('/export-glb', (req: Request, res: Response) => {
        try {
            const { preset = 'san_marco', eyeHeight = 1.7 } = req.body || {};
            const colliders = Depthbox360UniverseService.extractUniverseColliders(preset, eyeHeight);
            const glbBuffer = ImageToSplatService.generatePhysicsColliderGlb(colliders);
            res.setHeader('Content-Type', 'model/gltf-binary');
            res.setHeader('Content-Disposition', `attachment; filename="depthbox_${preset}_colliders.glb"`);
            res.send(Buffer.from(glbBuffer));
        } catch (err: any) {
            res.status(500).json({ success: false, error: err?.message || 'GLB physics collider export failed' });
        }
    });

    return router;
}

export function createPanoramaRouter(mediaCredentials: GoogleMediaCredentialsService): Router {
    const router = Router();
    const panoramaService = new Google360PanoramaPipelineService(mediaCredentials);

    router.post('/heal-seam', async (req: Request, res: Response) => {
        try {
            const { inputImagePath, inputImageBase64, prompt, seamWidth, outputImagePath, mockExecution, model } = req.body || {};
            const inputBuffer = inputImageBase64 ? Buffer.from(inputImageBase64, 'base64') : undefined;
            const isMock = mockExecution === true || mockExecution === 'true';

            const result = await panoramaService.healPanoramaSeam({
                inputImagePath,
                inputImageBuffer: inputBuffer,
                prompt,
                seamWidth,
                outputImagePath,
                mockExecution: isMock,
                model
            });

            res.json({
                success: true,
                width: result.width,
                height: result.height,
                seamWidth: result.seamWidth,
                outputImagePath: result.outputImagePath,
                outputImageBase64: result.outputBuffer.toString('base64'),
                modelUsed: result.modelUsed,
                summary: result.summary
            });
        } catch (err: any) {
            res.status(500).json({ success: false, error: err?.message || 'Failed to heal panorama seam' });
        }
    });

    router.post('/inpaint', async (req: Request, res: Response) => {
        try {
            const { inputImagePath, inputImageBase64, maskImagePath, maskImageBase64, nadirOnly, nadirRatio, prompt, outputImagePath, mockExecution, model } = req.body || {};
            const inputBuffer = inputImageBase64 ? Buffer.from(inputImageBase64, 'base64') : undefined;
            const maskBuffer = maskImageBase64 ? Buffer.from(maskImageBase64, 'base64') : undefined;
            const isMock = mockExecution === true || mockExecution === 'true';

            const result = await panoramaService.inpaintPanorama({
                inputImagePath,
                inputImageBuffer: inputBuffer,
                maskImagePath,
                maskImageBuffer: maskBuffer,
                nadirOnly,
                nadirRatio,
                prompt,
                outputImagePath,
                mockExecution: isMock,
                model
            });

            res.json({
                success: true,
                width: result.width,
                height: result.height,
                outputImagePath: result.outputImagePath,
                outputImageBase64: result.outputBuffer.toString('base64'),
                modelUsed: result.modelUsed,
                summary: result.summary
            });
        } catch (err: any) {
            res.status(500).json({ success: false, error: err?.message || 'Failed to inpaint panorama' });
        }
    });

    router.post('/generate', async (req: Request, res: Response) => {
        try {
            const { prompt, style, width, height, healSeam, inpaintNadir, outputImagePath, mockExecution, model } = req.body || {};
            if (!prompt) {
                res.status(400).json({ success: false, error: 'prompt is required to generate 360 panorama' });
                return;
            }
            const isMock = mockExecution === true || mockExecution === 'true';

            const result = await panoramaService.generate360Panorama({
                prompt,
                style,
                width,
                height,
                healSeam,
                inpaintNadir,
                outputImagePath,
                mockExecution: isMock,
                model
            });

            res.json({
                success: true,
                width: result.width,
                height: result.height,
                seamHealed: result.seamHealed,
                outputImagePath: result.outputImagePath,
                outputImageBase64: result.outputBuffer.toString('base64'),
                modelUsed: result.modelUsed,
                summary: result.summary
            });
        } catch (err: any) {
            res.status(500).json({ success: false, error: err?.message || 'Failed to generate 360 panorama' });
        }
    });

    router.post('/upscale-16k', async (req: Request, res: Response) => {
        try {
            const { inputImagePath, inputImageBase64, engine, outputImagePath, mockExecution, seamWidth } = req.body || {};
            const inputBuffer = inputImageBase64 ? Buffer.from(inputImageBase64, 'base64') : undefined;
            const isMock = mockExecution === true || mockExecution === 'true';

            const result = await panoramaService.upscalePanorama16K({
                inputImagePath,
                inputImageBuffer: inputBuffer,
                engine,
                outputImagePath,
                mockExecution: isMock,
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
            res.status(500).json({ success: false, error: err?.message || 'Failed to upscale panorama to 16K' });
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

    router.post('/multiview-to-splat', (req: Request, res: Response) => {
        try {
            const { views = [], voxelSize = 0.05, densifyMaxScale = 0, stride = 1, edgeTau = 0.08, minDepth = 0.2, maxDepth = 200.0 } = req.body || {};
            const convertedViews = views.map((v: any) => ({
                ...v,
                rgbPixels: Buffer.isBuffer(v.rgbPixels) ? v.rgbPixels : (typeof v.rgbPixels === 'string' ? Buffer.from(v.rgbPixels, 'base64') : new Uint8Array(v.rgbPixels || []))
            }));
            const splats = ImageToSplatService.convertMultiViewImagesToSplat({
                views: convertedViews,
                voxelSize,
                densifyMaxScale,
                stride,
                edgeTau,
                minDepth,
                maxDepth
            });
            res.json({ success: true, splatCount: splats.length, splats });
        } catch (err: any) {
            res.status(500).json({ success: false, error: err?.message || 'Multi-view splat conversion failed' });
        }
    });

    router.post('/video-to-splat', (req: Request, res: Response) => {
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

            const convertedKeyframes = keyframes.map((kf: any) => ({
                ...kf,
                rgbPixels: Buffer.isBuffer(kf.rgbPixels) ? kf.rgbPixels : (typeof kf.rgbPixels === 'string' ? Buffer.from(kf.rgbPixels, 'base64') : new Uint8Array(kf.rgbPixels || []))
            }));

            const splats = ImageToSplatService.convertVideoKeyframesToSplat({
                keyframes: convertedKeyframes,
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

            res.json({ success: true, splatCount: splats.length, splats });
        } catch (err: any) {
            res.status(500).json({ success: false, error: err?.message || 'Video keyframe splat conversion failed' });
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
