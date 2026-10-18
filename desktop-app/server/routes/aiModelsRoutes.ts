/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { Request, Response, Router } from 'express';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs-extra';
import {
    TrainedModelRegistryService,
    VideoTo4DPerformerPipelineService,
    resolveTaskCapability
} from '../../../packages/core/src/node';
import {
    PerformerInputUnreadableError,
    HeroFrameExtractionError,
    PerformerMotionUnavailableError
} from '../../../packages/core/src/node/spatial/VideoTo4DPerformerPipelineService';
import { InvalidInputError, MissingInputError, PipelineError } from '../../../packages/core/src/common/errors/pipeline-errors';

/**
 * HTTP status for a typed input error: 400 when the request is missing or carries an unusable input, 422 when the
 * input arrived but holds nothing the pipeline can use (no decodable frame, no trackable motion). Undefined otherwise.
 */
export function inputErrorStatus(err: unknown): 400 | 422 | undefined {
    if (err instanceof MissingInputError || err instanceof InvalidInputError || err instanceof PerformerInputUnreadableError) return 400;
    if (err instanceof HeroFrameExtractionError || err instanceof PerformerMotionUnavailableError) return 422;
    return undefined;
}

function sendRouteError(res: Response, err: any): void {
    const status = inputErrorStatus(err) ?? 500;
    res.status(status).json({ success: false, error: err?.message || String(err), ...(err instanceof PipelineError ? { code: err.code } : {}) });
}

export interface ExportedToolRecord {
    id: string;
    title: string;
    html: string;
    updatedAt: number;
}

export type ExportedToolsStore = Map<string, ExportedToolRecord>;

export function createToolsRouter(store: ExportedToolsStore, toolsHost: string, toolsPort: number): Router {
    const router = Router();

    router.post('/export', (req: Request, res: Response) => {
        const { toolId, title, html } = req.body || {};
        const id = typeof toolId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(toolId) ? toolId : `tool-${Date.now()}`;
        store.set(id, {
            id,
            title: typeof title === 'string' && title ? title : 'Scratchbox Standalone Tool',
            html: typeof html === 'string' ? html : '',
            updatedAt: Date.now()
        });
        res.json({
            success: true,
            toolId: id,
            url: `http://${toolsHost}:${toolsPort}/${id}`
        });
    });

    return router;
}

export function createModelsRouter(): Router {
    const router = Router();
    const modelRegistry = new TrainedModelRegistryService();

    router.get('/', (_req: Request, res: Response) => {
        try {
            const models = modelRegistry.discoverAllModels();
            const summary = modelRegistry.getCatalogSummary();
            res.json({
                success: true,
                summary,
                models
            });
        } catch (err: any) {
            sendRouteError(res, err);
        }
    });

    router.get('/status', (_req: Request, res: Response) => {
        try {
            const summary = modelRegistry.getCatalogSummary();
            res.json({
                success: true,
                status: summary.totalModels > 0 ? 'ready' : 'empty',
                summary
            });
        } catch (err: any) {
            sendRouteError(res, err);
        }
    });

    router.get('/performer/demos', (_req: Request, res: Response) => {
        try {
            const demos = modelRegistry.getModelsByFamily('performer_4dgs');
            res.json({
                success: true,
                count: demos.length,
                demos
            });
        } catch (err: any) {
            sendRouteError(res, err);
        }
    });

    router.get('/performer/demos/:id', (req: Request, res: Response) => {
        try {
            const avatar = modelRegistry.get4DGSAvatar(req.params.id);
            if (!avatar) {
                res.status(404).json({ success: false, error: `Avatar ${req.params.id} not found` });
                return;
            }
            res.json({
                success: true,
                avatar
            });
        } catch (err: any) {
            sendRouteError(res, err);
        }
    });

    router.get('/sbhuman', (_req: Request, res: Response) => {
        try {
            const models = modelRegistry.discoverSbHumanModels();
            res.json({
                success: true,
                models
            });
        } catch (err: any) {
            sendRouteError(res, err);
        }
    });

    router.get('/geobox', (_req: Request, res: Response) => {
        try {
            const models = modelRegistry.discoverGeoBoxModels();
            res.json({
                success: true,
                models
            });
        } catch (err: any) {
            sendRouteError(res, err);
        }
    });

    return router;
}

export function createPerformerRouter(allowedWorkspaceRoots: string[]): Router {
    const router = Router();
    const performerPipeline = new VideoTo4DPerformerPipelineService();

    router.post('/run', async (req: Request, res: Response) => {
        try {
            const {
                videoPath,
                characterId,
                outputDir,
                targetHeightMeters,
                numGaussians,
                fps,
                exportNerfstudioDataset,
                imageData,
                videoData,
                landmarks2D
            } = req.body || {};

            const effectiveRoot = allowedWorkspaceRoots[0] || process.cwd();
            let resolvedVideoPath = videoPath;

            if (imageData && typeof imageData === 'string') {
                const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
                const tmpImg = path.join(os.tmpdir(), `performer_input_img_${Date.now()}.png`);
                fs.writeFileSync(tmpImg, Buffer.from(base64Data, 'base64'));
                resolvedVideoPath = tmpImg;
            } else if (videoData && typeof videoData === 'string') {
                const base64Data = videoData.replace(/^data:video\/\w+;base64,/, '');
                const tmpVid = path.join(os.tmpdir(), `performer_input_vid_${Date.now()}.mp4`);
                fs.writeFileSync(tmpVid, Buffer.from(base64Data, 'base64'));
                resolvedVideoPath = tmpVid;
            }

            if (!resolvedVideoPath && characterId) {
                const demoDir = path.join(effectiveRoot, 'public/models/performer_4dgs/demos', String(characterId));
                const sourceVideo = path.join(demoDir, 'source_video.mp4');
                const defaultHero = path.join(demoDir, 'canonical_frame.jpg');
                if (fs.existsSync(sourceVideo)) {
                    resolvedVideoPath = sourceVideo;
                } else if (fs.existsSync(defaultHero)) {
                    resolvedVideoPath = defaultHero;
                }
            }

            if (resolvedVideoPath && !path.isAbsolute(resolvedVideoPath)) {
                const candidate1 = path.resolve(effectiveRoot, resolvedVideoPath);
                const candidate2 = path.resolve(effectiveRoot, 'public', resolvedVideoPath);
                if (fs.existsSync(candidate1)) {
                    resolvedVideoPath = candidate1;
                } else if (fs.existsSync(candidate2)) {
                    resolvedVideoPath = candidate2;
                } else {
                    resolvedVideoPath = candidate1;
                }
            }

            if (!resolvedVideoPath) {
                res.status(400).json({ success: false, error: 'Missing required videoPath, imageData, videoData, or characterId' });
                return;
            }

            const resolvedOutDir = outputDir
                ? (path.isAbsolute(outputDir) ? outputDir : path.resolve(effectiveRoot, outputDir))
                : path.resolve(effectiveRoot, 'public/models/performer_4dgs/demos', String(characterId || 'custom'));

            const result = await performerPipeline.executePipeline({
                videoPath: resolvedVideoPath,
                characterId: characterId ? String(characterId) : undefined,
                outputDir: resolvedOutDir,
                targetHeightMeters: typeof targetHeightMeters === 'number' ? targetHeightMeters : undefined,
                numGaussians: typeof numGaussians === 'number' ? numGaussians : undefined,
                fps: typeof fps === 'number' ? fps : undefined,
                exportNerfstudioDataset: exportNerfstudioDataset !== false,
                landmarks2D: Array.isArray(landmarks2D) ? landmarks2D : undefined
            });

            res.json({
                success: true,
                result
            });
        } catch (err: any) {
            sendRouteError(res, err);
        }
    });

    return router;
}

export async function handleCapabilitiesResolve(req: Request, res: Response): Promise<void> {
    try {
        const { taskGoal, goal, domainHint, hasInputImage, hasInputVideo } = req.body;
        const targetGoal = taskGoal || goal;
        if (!targetGoal) {
            res.status(400).json({ success: false, error: 'taskGoal is required' });
            return;
        }
        const result = resolveTaskCapability(targetGoal, {
            domainHint,
            hasInputImage,
            hasInputVideo
        });
        res.json({ success: true, ...result });
    } catch (err: any) {
        sendRouteError(res, err);
    }
}
