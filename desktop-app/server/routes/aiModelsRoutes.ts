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
    ComfyUiBridgeService,
    ComfyUiPipelineAgent,
    ComfyUiCloudRunService
} from '../../../packages/core/src/node';

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
            res.status(500).json({ success: false, error: err?.message || String(err) });
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
            res.status(500).json({ success: false, error: err?.message || String(err) });
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
            res.status(500).json({ success: false, error: err?.message || String(err) });
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
            res.status(500).json({ success: false, error: err?.message || String(err) });
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
            res.status(500).json({ success: false, error: err?.message || String(err) });
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
            res.status(500).json({ success: false, error: err?.message || String(err) });
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
            res.status(500).json({ success: false, error: err?.message || String(err) });
        }
    });

    return router;
}

export async function handleCapabilitiesResolve(req: Request, res: Response): Promise<void> {
    try {
        const { taskGoal, goal, domainHint, hasInputImage, hasInputVideo, targetEnvironment } = req.body;
        const targetGoal = taskGoal || goal;
        if (!targetGoal) {
            res.status(400).json({ success: false, error: 'taskGoal is required' });
            return;
        }
        const agent = new ComfyUiPipelineAgent();
        const result = agent.assessTaskCapability(targetGoal, {
            domainHint,
            hasInputImage,
            hasInputVideo,
            targetEnvironment
        });
        res.json({ success: true, ...result });
    } catch (err: any) {
        res.status(500).json({ success: false, error: err?.message || String(err) });
    }
}

export function createComfyRouter(): Router {
    const router = Router();

    router.get('/status', async (req: Request, res: Response) => {
        try {
            const hostUrl = typeof req.query.hostUrl === 'string' ? req.query.hostUrl : undefined;
            const bridge = new ComfyUiBridgeService({ hostUrl });
            const available = await bridge.isAvailable();
            if (!available) {
                res.json({
                    success: true,
                    status: 'offline',
                    available: false,
                    hostUrl: bridge.getHostUrl(),
                    message: 'ComfyUI server is offline.'
                });
                return;
            }
            const stats = await bridge.getSystemStats();
            const models = await bridge.getModels();
            res.json({
                success: true,
                status: 'online',
                available: true,
                hostUrl: bridge.getHostUrl(),
                stats,
                models
            });
        } catch (err: any) {
            res.status(500).json({ success: false, error: err?.message || String(err) });
        }
    });

    router.get('/nodes', async (req: Request, res: Response) => {
        try {
            const hostUrl = typeof req.query.hostUrl === 'string' ? req.query.hostUrl : undefined;
            const nodeClass = typeof req.query.nodeClass === 'string' ? req.query.nodeClass : undefined;
            const bridge = new ComfyUiBridgeService({ hostUrl });
            const info = await bridge.getObjectInfo(nodeClass);
            res.json({ success: true, nodes: info });
        } catch (err: any) {
            res.status(500).json({ success: false, error: err?.message || String(err) });
        }
    });

    router.post('/research', async (req: Request, res: Response) => {
        try {
            const { goal, hostUrl, mockExecution } = req.body;
            if (!goal) {
                res.status(400).json({ success: false, error: 'Goal is required.' });
                return;
            }
            const isMock = mockExecution === true || mockExecution === 'true';
            const agent = new ComfyUiPipelineAgent({ hostUrl, mockExecution: isMock });
            const blueprint = await agent.researchPipeline(goal);
            const prompt = agent.authorApiPrompt(blueprint);
            const nodeGraphData = agent.convertToNodeGraphData(blueprint, prompt);
            res.json({ success: true, blueprint, prompt, nodeGraphData });
        } catch (err: any) {
            res.status(500).json({ success: false, error: err?.message || String(err) });
        }
    });

    router.get('/cloudrun/status', async (req: Request, res: Response) => {
        try {
            const serviceUrl = typeof req.query.serviceUrl === 'string' ? req.query.serviceUrl : undefined;
            const mock = req.query.mockExecution === 'true';
            const crService = new ComfyUiCloudRunService({ serviceUrl, mockExecution: mock });
            const status = await crService.getServiceStatus();
            res.json({ success: true, ...status });
        } catch (err: any) {
            res.status(500).json({ success: false, error: err?.message || String(err) });
        }
    });

    router.get('/cloudrun/upstream', async (req: Request, res: Response) => {
        try {
            const serviceUrl = typeof req.query.serviceUrl === 'string' ? req.query.serviceUrl : undefined;
            const mock = req.query.mockExecution === 'true';
            const crService = new ComfyUiCloudRunService({ serviceUrl, mockExecution: mock });
            const info = await crService.getUpstreamVersionInfo();
            res.json({ success: true, ...info });
        } catch (err: any) {
            res.status(500).json({ success: false, error: err?.message || String(err) });
        }
    });

    router.post('/cloudrun/sync', async (req: Request, res: Response) => {
        try {
            const { serviceUrl, mockExecution } = req.body || {};
            const isMock = mockExecution === true || mockExecution === 'true';
            const crService = new ComfyUiCloudRunService({ serviceUrl, mockExecution: isMock });
            const syncResult = await crService.syncUpstream();
            res.json({ ...syncResult, success: syncResult.success });
        } catch (err: any) {
            res.status(500).json({ success: false, error: err?.message || String(err) });
        }
    });

    router.post('/cloudrun/inject-code', async (req: Request, res: Response) => {
        try {
            const { moduleName, code, nodeClasses, requirements, serviceUrl, mockExecution } = req.body || {};
            if (!moduleName || !code) {
                res.status(400).json({ success: false, error: 'moduleName and code are required.' });
                return;
            }
            const isMock = mockExecution === true || mockExecution === 'true';
            const crService = new ComfyUiCloudRunService({ serviceUrl, mockExecution: isMock });
            const injectResult = await crService.injectDynamicCode({
                moduleName,
                code,
                nodeClasses: nodeClasses || [],
                requirements: requirements || []
            });
            res.json({ ...injectResult, success: true });
        } catch (err: any) {
            res.status(500).json({ success: false, error: err?.message || String(err) });
        }
    });

    router.post('/workflow/prepare', async (req: Request, res: Response) => {
        try {
            const { workflow, dynamicCode, serviceUrl, mockExecution } = req.body || {};
            if (!workflow) {
                res.status(400).json({ success: false, error: 'workflow is required.' });
                return;
            }
            const isMock = mockExecution === true || mockExecution === 'true';
            const crService = new ComfyUiCloudRunService({ serviceUrl, mockExecution: isMock });
            const report = await crService.prepareWorkflowDependencies(workflow, dynamicCode);
            res.json({ success: true, report });
        } catch (err: any) {
            res.status(500).json({ success: false, error: err?.message || String(err) });
        }
    });

    router.post('/execute', async (req: Request, res: Response) => {
        try {
            const { goal, workflow, workflowJson, hostUrl, mockExecution, maxFixAttempts, targetEnvironment, cloudRun, autoSyncUpstream } = req.body;
            if (!goal && !workflow && !workflowJson) {
                res.status(400).json({ success: false, error: 'Goal or workflow is required.' });
                return;
            }
            const isMock = mockExecution === true || mockExecution === 'true';
            const agent = new ComfyUiPipelineAgent({
                hostUrl,
                mockExecution: isMock,
                maxFixAttempts,
                targetEnvironment,
                cloudRun
            });

            let result;
            if (workflow || workflowJson) {
                const parsed = workflow || (typeof workflowJson === 'string' ? JSON.parse(workflowJson) : workflowJson);
                result = await agent.executeWorkflowPrompt(parsed, goal || 'Execute workflow', {
                    targetEnvironment,
                    cloudRun,
                    autoSyncUpstream
                });
            } else {
                result = await agent.executeAndHeal(goal, {
                    targetEnvironment,
                    cloudRun,
                    autoSyncUpstream
                });
            }

            res.json({ ...result });
        } catch (err: any) {
            res.status(500).json({ success: false, error: err?.message || String(err) });
        }
    });

    router.post('/capabilities/resolve', handleCapabilitiesResolve);

    return router;
}
