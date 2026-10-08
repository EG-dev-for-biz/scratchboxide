/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { Request, Response, Router } from 'express';
import {
    GeminiService,
    GoogleMediaCredentialsService,
    DeepWriteService,
    LongRunningAgentService,
    SubagentPoolService,
    UserMemoriesService,
    MediaGenerationJobService,
    ProjectContextGraphService,
    LspDiagnosticFeedbackService,
    TaskCapabilityResolver,
    resolveTaskCapability
} from '../../../packages/core/src/node';
import {
    classifyMediaGenerationError,
    MediaGenerationRequest
} from '../../../packages/core/src/common';
import { RouteContext } from './types';
import { createMemoriesRouter } from './memoriesRoutes';

export interface GeminiRouterServices {
    geminiService: GeminiService;
    mediaCredentials: GoogleMediaCredentialsService;
    deepWriteService: DeepWriteService;
    longRunningAgentService: LongRunningAgentService;
    subagentPoolService: SubagentPoolService;
    memoriesService: UserMemoriesService;
    contextGraphService: ProjectContextGraphService;
    lspFeedbackService: LspDiagnosticFeedbackService;
    mediaJobs: MediaGenerationJobService;
    taskCapabilityResolver?: TaskCapabilityResolver;
}

/** Safely writes an SSE payload, guarding against closed, destroyed, or aborted connections. */
const safeWriteSse = (targetRes: Response, payload: string, signal?: AbortSignal): boolean => {
    if (targetRes.destroyed || targetRes.writableEnded || signal?.aborted) return false;
    try {
        targetRes.write(payload);
        return true;
    } catch {
        return false;
    }
};

/** Safely terminates an SSE stream if not already closed or destroyed. */
const safeEndSse = (targetRes: Response): void => {
    if (!targetRes.destroyed && !targetRes.writableEnded) {
        try {
            targetRes.end();
        } catch {
            /* ignore */
        }
    }
};

export function createGeminiRouter(services: GeminiRouterServices, ctx: RouteContext): Router {
    const {
        geminiService,
        mediaCredentials,
        deepWriteService,
        longRunningAgentService,
        subagentPoolService,
        memoriesService,
        contextGraphService,
        lspFeedbackService,
        mediaJobs
    } = services;
    const { requireWorkspaceRoot, sendError, isPathError } = ctx;

    const router = Router();

    router.get('/models', (_req: Request, res: Response) => {
        res.json({
            models: [
                { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', maxTokens: 1048576, description: 'Primary model with Native Reasoning & Fast Multimodal capabilities' },
                { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash Lite', maxTokens: 524288, description: 'High-efficiency Subagent Swarm worker' },
                { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite', maxTokens: 262144, description: 'Fallback worker agent' }
            ]
        });
    });

    router.get('/status', async (_req: Request, res: Response) => {
        try {
            const status = await geminiService.getStatus();
            res.json(status);
        } catch (err: any) {
            res.status(503).json({
                initialized: false,
                hasKey: false,
                connected: false,
                error: err?.message || 'Gemini service unavailable'
            });
        }
    });

    router.post('/generate', async (req: Request, res: Response) => {
        try {
            const response = await geminiService.generateArtifact(req.body);
            res.json(response);
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });

    /** Opens an SSE response and returns an AbortController tied to the client connection. */
    const openSse = (_req: Request, res: Response): AbortController => {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive'
        });
        res.flushHeaders?.();
        res.write(': connected\n\n');
        const controller = new AbortController();
        res.on('close', () => {
            if (!res.writableEnded) {
                controller.abort();
            }
        });
        return controller;
    };

    const handleStream = async (req: Request, res: Response) => {
        const controller = openSse(req, res);

        try {
            await geminiService.streamGenerate(req.body, event => {
                safeWriteSse(res, `data: ${JSON.stringify(event)}\n\n`, controller.signal);
            }, controller.signal);
            safeWriteSse(res, 'data: [DONE]\n\n', controller.signal);
            safeEndSse(res);
        } catch (err: any) {
            if (controller.signal.aborted) {
                safeEndSse(res);
                return;
            }
            safeWriteSse(res, `data: ${JSON.stringify({ type: 'error', error: err.message || 'Streaming failed' })}\n\n`, controller.signal);
            safeWriteSse(res, 'data: [DONE]\n\n', controller.signal);
            safeEndSse(res);
        }
    };

    router.post('/stream', handleStream);
    router.post('/generate-stream', handleStream);

    router.post('/subagent', async (req: Request, res: Response) => {
        try {
            const response = await geminiService.executeSubagentTask(req.body);
            res.json(response);
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/fim', async (req: Request, res: Response) => {
        try {
            const response = await geminiService.completeFim(req.body);
            res.json(response);
        } catch (err: any) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.post('/quick-edit', async (req: Request, res: Response) => {
        try {
            const response = await geminiService.quickEditCode(req.body);
            res.json(response);
        } catch (err: any) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // `gemini-client.ts` calls `/mcp/ping`; `/ping-mcp` is kept for older callers.
    const pingMcp = async (req: Request, res: Response): Promise<void> => {
        try {
            const response = await geminiService.pingMcpServer(req.body);
            res.json(response);
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    };
    router.post('/ping-mcp', pingMcp);
    router.post('/mcp/ping', pingMcp);

    const saveCredentials = async (req: Request, res: Response): Promise<void> => {
        try {
            const { apiKey, credentialsJson } = req.body || {};
            const rawApiKey = typeof apiKey === 'string' ? apiKey.trim() : '';
            const rawJson = typeof credentialsJson === 'string' ? credentialsJson.trim() : '';
            if (!rawApiKey && !rawJson) {
                res.status(400).json({ success: false, authMethod: 'unauthenticated', error: 'apiKey or credentialsJson is required' });
                return;
            }
            if (rawJson && rawJson.startsWith('{')) {
                const saved = await mediaCredentials.saveServiceAccount(rawJson);
                res.status(saved.success ? 200 : 400).json(saved);
                return;
            }
            // Persist through the encrypted key store; only the running process keeps the env copy.
            const key = rawApiKey || rawJson;
            const saved = await mediaCredentials.saveApiKey(key);
            if (!saved.success) {
                res.status(400).json({ success: false, authMethod: 'unauthenticated', error: saved.error || 'Invalid API key' });
                return;
            }
            process.env.GEMINI_API_KEY = key;
            res.json({
                success: true,
                authMethod: saved.authMethod,
                message: 'Credentials updated successfully'
            });
        } catch (err: any) {
            res.status(500).json({ success: false, authMethod: 'unauthenticated', error: err.message });
        }
    };
    router.post('/credentials', saveCredentials);
    router.post('/save-credentials', saveCredentials);

    router.post('/tts', async (req: Request, res: Response) => {
        try {
            const { text } = req.body || {};
            if (typeof text !== 'string' || !text.trim()) {
                res.status(400).json({ success: false, error: 'text is required' });
                return;
            }
            res.json(await geminiService.synthesizeSpeech(req.body));
        } catch (err: any) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.post('/verify-visual', async (req: Request, res: Response) => {
        try {
            const request = req.body;
            if (!request || !request.image || !request.prompt) {
                res.status(400).json({ success: false, error: 'image and prompt are required' });
                return;
            }
            const audit = await geminiService.verifyVisual(request);
            res.json({ success: true, ...audit });
        } catch (err: any) {
            res.status(500).json({ success: false, error: err.message || 'Visual verification failed' });
        }
    });

    router.post('/verify-and-repair', async (req: Request, res: Response) => {
        try {
            const { request, artifact } = req.body || {};
            if (!request || !request.image || !request.prompt) {
                res.status(400).json({ success: false, error: 'request.image and request.prompt are required' });
                return;
            }
            const verifier = geminiService.getVisualVerificationService();
            const audit = await verifier.verifyVisual(request);
            let repairedArtifact = artifact;
            if (artifact && audit.visualFixes && audit.fidelityScore < 80) {
                repairedArtifact = verifier.applyVisualAutoRepair(artifact, audit);
            }
            res.json({ success: true, audit, repairedArtifact });
        } catch (err: any) {
            res.status(500).json({ success: false, error: err.message || 'Visual verify and repair failed' });
        }
    });

    // Codebase Lens Endpoints
    router.post('/lens/project', async (req: Request, res: Response) => {
        try {
            const { filePath, sourceContent, options } = req.body || {};
            if (!filePath) {
                res.status(400).json({ success: false, error: 'filePath is required' });
                return;
            }
            const result = await geminiService.executeLensProject(filePath, sourceContent, options);
            res.json(result);
        } catch (err: any) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.post('/lens/unproject', async (req: Request, res: Response) => {
        try {
            const { artifactId, primitiveData, currentDiskContent, context } = req.body || {};
            if (!artifactId || !primitiveData) {
                res.status(400).json({ success: false, error: 'artifactId and primitiveData are required' });
                return;
            }
            const result = await geminiService.executeLensUnproject(artifactId, primitiveData, currentDiskContent, context);
            res.json(result);
        } catch (err: any) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.get('/lens/bindings', (_req: Request, res: Response) => {
        try {
            const bindings = geminiService.executeLensListBindings();
            res.json({ success: true, bindings });
        } catch (err: any) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.post('/lens/sync', (req: Request, res: Response) => {
        try {
            const { artifactId, direction, diskContent, primitiveData, context } = req.body || {};
            if (!artifactId || !direction) {
                res.status(400).json({ success: false, error: 'artifactId and direction are required' });
                return;
            }
            const result = geminiService.executeLensSync(
                artifactId,
                direction,
                { diskContent, primitiveData },
                context
            );
            res.json(result);
        } catch (err: any) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // Deep-Write & Intelligent Planning Pipelines
    router.post('/deep-write/pipeline', async (req: Request, res: Response) => {
        const { prompt, sessionId, workspaceRoot, activeArtifact, useGoogleSearch } = req.body || {};
        if (!prompt) {
            res.status(400).json({ success: false, error: 'Prompt is required' });
            return;
        }
        let safeRoot: string;
        try {
            safeRoot = requireWorkspaceRoot(workspaceRoot);
        } catch (err: any) {
            sendError(res, err);
            return;
        }

        const controller = openSse(req, res);
        try {
            await deepWriteService.runPipeline(
                { prompt, sessionId, workspaceRoot: safeRoot, activeArtifact, useGoogleSearch },
                event => {
                    safeWriteSse(res, `data: ${JSON.stringify(event)}\n\n`, controller.signal);
                },
                controller.signal
            );
            safeWriteSse(res, 'data: [DONE]\n\n', controller.signal);
            safeEndSse(res);
        } catch (err: any) {
            if (!controller.signal.aborted) {
                safeWriteSse(res, `data: ${JSON.stringify({ type: 'error', error: err.message || 'Streaming failed' })}\n\n`, controller.signal);
                safeWriteSse(res, 'data: [DONE]\n\n', controller.signal);
            }
            safeEndSse(res);
        }
    });

    router.post('/deep-write/resume', async (req: Request, res: Response) => {
        try {
            const { sessionId, feedback, workspaceRoot } = req.body || {};
            if (!sessionId || feedback === undefined) {
                res.status(400).json({ success: false, error: 'sessionId and feedback are required' });
                return;
            }

            const safeRoot = workspaceRoot ? requireWorkspaceRoot(workspaceRoot) : undefined;
            await deepWriteService.resumePipeline(sessionId, feedback, safeRoot);
            res.json({ success: true });
        } catch (err: any) {
            if (isPathError(err)) {
                sendError(res, err);
                return;
            }
            res.status(500).json({ success: false, error: err.message || 'Failed to resume pipeline' });
        }
    });

    // Autonomous Long-Running Agent Loop Endpoints
    router.post('/agent/session', async (req: Request, res: Response) => {
        try {
            const { goal, maxIterations, maxDurationMs } = req.body || {};
            if (!goal) {
                res.status(400).json({ success: false, error: 'goal is required' });
                return;
            }
            const session = await longRunningAgentService.createSession(goal, maxIterations, maxDurationMs);
            res.json({ success: true, session });
        } catch (err: any) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.get('/agent/session/:id', (req: Request, res: Response) => {
        try {
            const session = longRunningAgentService.getSessionState(req.params.id);
            if (!session) {
                res.status(404).json({ success: false, error: `Session ${req.params.id} not found` });
                return;
            }
            res.json({ success: true, session });
        } catch (err: any) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.post('/agent/action', async (req: Request, res: Response) => {
        try {
            const { sessionId, action, description, fileSnapshots } = req.body || {};
            if (!sessionId || !action) {
                res.status(400).json({ success: false, error: 'sessionId and action are required' });
                return;
            }
            switch (action) {
                case 'pause':
                    await longRunningAgentService.pauseSession(sessionId);
                    res.json({ success: true, message: `Session ${sessionId} paused` });
                    break;
                case 'resume':
                    await longRunningAgentService.resumeSession(sessionId);
                    res.json({ success: true, message: `Session ${sessionId} resumed` });
                    break;
                case 'cancel':
                    await longRunningAgentService.cancelSession(sessionId);
                    res.json({ success: true, message: `Session ${sessionId} cancelled` });
                    break;
                case 'checkpoint':
                    const checkpoint = await longRunningAgentService.createCheckpoint(
                        sessionId,
                        description || 'Manual checkpoint',
                        fileSnapshots || {}
                    );
                    res.json({ success: true, checkpoint });
                    break;
                case 'rollback':
                    const rolledBackState = await longRunningAgentService.rollbackToLastCheckpoint(sessionId);
                    res.json({ success: true, session: rolledBackState });
                    break;
                default:
                    res.status(400).json({ success: false, error: `Unknown action: ${action}` });
            }
        } catch (err: any) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.post('/agent/stream', async (req: Request, res: Response) => {
        const { sessionId } = req.body || {};
        if (!sessionId) {
            res.status(400).json({ success: false, error: 'sessionId is required' });
            return;
        }

        const controller = openSse(req, res);
        try {
            await longRunningAgentService.runAutonomousLoop(sessionId, event => {
                safeWriteSse(res, `data: ${JSON.stringify(event)}\n\n`, controller.signal);
            }, controller.signal);
            safeWriteSse(res, 'data: [DONE]\n\n', controller.signal);
            safeEndSse(res);
        } catch (err: any) {
            if (controller.signal.aborted) {
                safeEndSse(res);
                return;
            }
            safeWriteSse(res, `data: ${JSON.stringify({ type: 'error', error: err.message || 'Autonomous agent execution failed' })}\n\n`, controller.signal);
            safeWriteSse(res, 'data: [DONE]\n\n', controller.signal);
            safeEndSse(res);
        }
    });

    // Subagent Pool & DAG Swarm Endpoints
    router.get('/subagent/pool-status', (_req: Request, res: Response) => {
        try {
            const metrics = subagentPoolService.getPoolMetrics();
            res.json({ success: true, metrics });
        } catch (err: any) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.post('/subagent/swarm', async (req: Request, res: Response) => {
        try {
            const dagPlan = req.body;
            if (!dagPlan || !Array.isArray(dagPlan.tasks)) {
                res.status(400).json({ success: false, error: 'Valid SubagentDAGPlan with tasks is required' });
                return;
            }
            const result = await subagentPoolService.executeDAG(dagPlan);
            res.json({ success: true, result });
        } catch (err: any) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // User Memories Endpoints (Decoupled Sub-Router)
    router.use('/memories', createMemoriesRouter(memoriesService, ctx));

    // Symbol Graph & AST Query Endpoints
    router.get('/symbols', async (req: Request, res: Response) => {
        try {
            const query = (req.query.query as string) || '';
            const kind = req.query.kind as string;
            const minScore = req.query.minScore ? parseFloat(req.query.minScore as string) : 0.1;
            const maxSymbols = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;

            const graph = await contextGraphService.retrieveSymbolGraph({
                query,
                kinds: kind ? [kind as any] : undefined,
                minRelevanceScore: minScore,
                maxSymbols
            });
            res.json({ success: true, graph });
        } catch (err: any) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // Diagnostics & Self-Healing Endpoints
    router.get('/diagnostics', (_req: Request, res: Response) => {
        try {
            const summary = lspFeedbackService.getSummary();
            res.json({ success: true, summary });
        } catch (err: any) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.post('/diagnostics/compiler', (req: Request, res: Response) => {
        try {
            const { output, workspaceRoot } = req.body || {};
            if (!output) {
                res.status(400).json({ success: false, error: 'output is required' });
                return;
            }
            const ingested = lspFeedbackService.ingestCompilerOutput(output, workspaceRoot);
            res.json({ success: true, count: ingested.diagnostics?.length || 0, diagnostics: ingested });
        } catch (err: any) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    const startMediaJob = async (
        request: MediaGenerationRequest,
        res: Response,
        waitForCompletion: boolean
    ): Promise<void> => {
        try {
            const workspaceRoot = requireWorkspaceRoot(request?.workspaceRoot);
            const job = await mediaJobs.create({ ...request, workspaceRoot });
            if (waitForCompletion) {
                const completed = await mediaJobs.process(job.id, workspaceRoot);
                res.status(completed.status === 'completed' ? 200 : 422).json({
                    success: completed.status === 'completed',
                    job: completed,
                    error: completed.error
                });
                return;
            }
            mediaJobs.process(job.id, workspaceRoot).catch(() => undefined);
            res.status(202).json({ success: true, job });
        } catch (error) {
            if (isPathError(error)) {
                sendError(res, error);
                return;
            }
            const detail = (error as any)?.mediaError || classifyMediaGenerationError(error);
            const status = detail.code === 'unauthorized' ? 401
                : detail.code === 'quota' ? 429
                    : detail.code === 'invalid_request' ? 400
                        : detail.code === 'unsupported' ? 422 : 500;
            res.status(status).json({ success: false, error: detail });
        }
    };

    router.post('/image/generate', async (req: Request, res: Response) => {
        await startMediaJob({ ...req.body, kind: 'image' }, res, true);
    });

    router.post('/video/generate', async (req: Request, res: Response) => {
        await startMediaJob({ ...req.body, kind: 'video' }, res, false);
    });

    // Media Generation Job Status Endpoints
    const getMediaJob = async (req: Request, res: Response): Promise<void> => {
        try {
            const raw = (req.query.workspaceRoot as string | undefined) || (req.body && req.body.workspaceRoot);
            let workspaceRoot: string;
            try {
                workspaceRoot = requireWorkspaceRoot(raw);
            } catch (err: any) {
                if (isPathError(err)) {
                    sendError(res, err);
                    return;
                }
                res.status(400).json({ success: false, error: 'workspaceRoot query parameter is required to look up media jobs' });
                return;
            }
            const job = await mediaJobs.get(req.params.id, workspaceRoot);
            if (!job) {
                res.status(404).json({ success: false, error: `Job ${req.params.id} not found` });
                return;
            }
            res.json({ success: true, job });
        } catch (err: any) {
            res.status(500).json({ success: false, error: err?.message || 'Failed to retrieve media job' });
        }
    };
    router.get('/jobs/:id', getMediaJob);
    router.get('/media/jobs/:id', getMediaJob);

    // Two-Tier Task Capability Resolution Endpoints
    const resolveCapability = (req: Request, res: Response): void => {
        try {
            const { userGoal, goal, taskGoal, promptContext, domainHint, targetEnvironment } = req.body || {};
            const effectiveGoal = userGoal || goal || taskGoal;
            if (!effectiveGoal || typeof effectiveGoal !== 'string') {
                res.status(400).json({ success: false, error: 'userGoal (or goal/taskGoal) is required' });
                return;
            }
            const resolution = resolveTaskCapability({
                userGoal: effectiveGoal,
                promptContext: typeof promptContext === 'string' ? promptContext : undefined,
                domainHint,
                targetEnvironment
            });
            res.json({ success: true, resolution });
        } catch (err: any) {
            res.status(500).json({ success: false, error: err?.message || 'Failed to resolve task capability' });
        }
    };
    router.post('/capability/resolve', resolveCapability);
    router.post('/resolve-capability', resolveCapability);

    return router;
}
