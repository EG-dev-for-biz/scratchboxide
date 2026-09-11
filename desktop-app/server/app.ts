/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import express, { Express, Request, Response } from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import * as path from 'path';
import * as fs from 'fs-extra';
import {
    WorkspaceConfigService,
    ProjectArtifactStore,
    BrowserProxyService,
    GeminiService,
    UserMemoriesService,
    MediaAssetStore,
    GoogleMediaGenerationService,
    MediaGenerationJobService,
    GoogleMediaCredentialsService,
    DeepWriteService,
    GoalAnalyzer,
    MultiPlatformScaffolder,
    DynamicDagPlanner,
    DeepWriteExecutionBridge,
    CodebaseLensSyncService,
    PrimitiveSynthesizer,
    UserLearningService,
    WorkspaceFileWatcherService,
    LongRunningAgentService,
    SubagentPoolService,
    ContainerSandboxService,
    LspDiagnosticFeedbackService,
    ProjectContextGraphService
} from '../../packages/core/src/node';
import {
    createEmptyProjectGraph,
    IMAGE_MODEL_PRIORITY,
    VIDEO_MODEL_PRIORITY,
    classifyMediaGenerationError,
    MediaGenerationRequest
} from '../../packages/core/src/common';

export interface StandaloneServerOptions {
    port?: number;
    staticDir?: string;
}

function loadEnvironmentSecrets(): void {
    const candidates = [
        path.resolve(process.cwd(), '.env'),
        path.resolve(process.cwd(), 'secrets.json'),
        path.resolve(__dirname, '../../.env'),
        path.resolve(__dirname, '../../secrets.json'),
        path.resolve(__dirname, '../../../.env'),
        path.resolve(__dirname, '../../../secrets.json')
    ];

    for (const file of candidates) {
        if (!fs.existsSync(file)) continue;
        try {
            if (file.endsWith('.json')) {
                const json = fs.readJSONSync(file);
                for (const [k, v] of Object.entries(json)) {
                    if (typeof v === 'string' && !process.env[k]) {
                        process.env[k] = v;
                    }
                }
            } else if (file.endsWith('.env')) {
                const lines = fs.readFileSync(file, 'utf8').split('\n');
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed.startsWith('#')) continue;
                    const eqIdx = trimmed.indexOf('=');
                    if (eqIdx > 0) {
                        const key = trimmed.slice(0, eqIdx).trim();
                        let val = trimmed.slice(eqIdx + 1).trim();
                        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
                            val = val.slice(1, -1);
                        }
                        if (!process.env[key]) {
                            process.env[key] = val;
                        }
                    }
                }
            }
        } catch {
            // Ignore parse errors
        }
    }

    const saCandidates = [
        process.env.GOOGLE_APPLICATION_CREDENTIALS,
        path.resolve(process.cwd(), 'service-account.json'),
        path.resolve(__dirname, '../../service-account.json'),
        path.resolve(__dirname, '../../../service-account.json')
    ].filter(Boolean) as string[];

    for (const saPath of saCandidates) {
        if (fs.existsSync(saPath)) {
            if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
                process.env.GOOGLE_APPLICATION_CREDENTIALS = saPath;
            }
            break;
        }
    }
}

export function createStandaloneServer(options: StandaloneServerOptions = {}): Express {
    loadEnvironmentSecrets();
    const app = express();

    app.use(cors());
    app.use(bodyParser.json({ limit: '50mb' }));
    app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));

    const workspaceService = new WorkspaceConfigService();
    const artifactStore = new ProjectArtifactStore();
    const browserProxy = new BrowserProxyService();
    const geminiService = new GeminiService();
    const memoriesService = new UserMemoriesService();
    const mediaCredentials = new GoogleMediaCredentialsService();
    const mediaAssets = new MediaAssetStore();
    const mediaGenerator = new GoogleMediaGenerationService(mediaAssets, () => mediaCredentials.createClient());
    const mediaJobs = new MediaGenerationJobService(mediaGenerator);

    const sandboxService = geminiService.getSandboxService();
    const lspFeedbackService = geminiService.getLspFeedbackService();
    const contextGraphService = geminiService.getContextGraphService();
    const longRunningAgentService = new LongRunningAgentService(sandboxService, undefined, geminiService);
    const subagentPoolService = new SubagentPoolService({}, geminiService);

    // Trigger continuous AST symbol indexing for default workspace in background
    contextGraphService.indexWorkspaceDirectory(process.cwd()).catch(() => {});

    const userLearningService = new UserLearningService(memoriesService);
    const goalAnalyzer = new GoalAnalyzer(geminiService, userLearningService);
    const multiPlatformScaffolder = new MultiPlatformScaffolder();
    const dynamicDagPlanner = new DynamicDagPlanner(geminiService);
    const executionBridge = new DeepWriteExecutionBridge(geminiService);
    const fileWatcher = new WorkspaceFileWatcherService();
    const lensSyncService = new CodebaseLensSyncService(workspaceService, fileWatcher);
    const primitiveSynthesizer = new PrimitiveSynthesizer();
    const deepWriteService = new DeepWriteService(
        goalAnalyzer,
        multiPlatformScaffolder,
        dynamicDagPlanner,
        executionBridge,
        lensSyncService,
        primitiveSynthesizer,
        userLearningService
    );

    // ==========================================
    // 1. Browser Proxy Gateway Endpoints
    // ==========================================
    const browserRouter = express.Router();

    browserRouter.get('/status', (_req: Request, res: Response) => {
        res.json({
            success: true,
            engine: 'Chromium Proxy Gateway',
            status: 'ready',
            timestamp: Date.now()
        });
    });

    browserRouter.get('/state', (_req: Request, res: Response) => {
        res.json(browserProxy.getActiveState());
    });

    browserRouter.post('/state', (req: Request, res: Response) => {
        browserProxy.updateState(req.body);
        res.json({ success: true });
    });

    browserRouter.get('/pending-actions', (_req: Request, res: Response) => {
        res.json(browserProxy.getPendingActions());
    });

    browserRouter.post('/action-result', (req: Request, res: Response) => {
        const { id, success, result, error } = req.body;
        const resolved = browserProxy.resolveAction(id, success, result, error);
        res.json({ success: true, resolved });
    });

    browserRouter.post('/action', async (req: Request, res: Response) => {
        const { action, params } = req.body;
        try {
            const result = await browserProxy.queueAction(action, params);
            res.json({ success: true, result });
        } catch (err: any) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    browserRouter.all('/proxy', async (req: Request, res: Response) => {
        const targetUrlRaw = (req.query.url as string) || (req.body && req.body.url);
        if (!targetUrlRaw) {
            res.status(400).send(`
                <!DOCTYPE html>
                <html>
                <head><title>Scratchbox Browser Proxy Error</title></head>
                <body style="font-family: -apple-system, sans-serif; padding: 40px; background: #0f1015; color: #e2e8f0;">
                    <h2>Missing target URL parameter</h2>
                    <p>Usage: <code>/api/browser/proxy?url=https://example.com</code></p>
                </body>
                </html>
            `);
            return;
        }

        try {
            const targetUrl = browserProxy.normalizeUrl(targetUrlRaw);
            const result = await browserProxy.fetchTarget(targetUrl, {
                method: req.method,
                headers: req.headers as Record<string, string>,
                body: req.body
            });

            res.status(result.statusCode);
            res.set('Content-Type', result.contentType);
            res.set('X-Scratchbox-Resolved-Url', result.resolvedUrl);
            res.send(result.body);
        } catch (err: any) {
            res.status(502).send(`
                <!DOCTYPE html>
                <html>
                <head><title>Proxy Gateway Failed</title></head>
                <body style="font-family: -apple-system, sans-serif; padding: 40px; background: #0f1015; color: #e2e8f0;">
                    <h2>Proxy Gateway Error</h2>
                    <p>${err.message}</p>
                </body>
                </html>
            `);
        }
    });

    app.use('/api/browser', browserRouter);

    // ==========================================
    // 2. Gemini GenAI & Agent Endpoints
    // ==========================================
    const geminiRouter = express.Router();

    geminiRouter.get('/models', (_req: Request, res: Response) => {
        res.json({
            models: [
                { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', maxTokens: 1048576, description: 'Primary model with Native Reasoning & Fast Multimodal capabilities' },
                { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash Lite', maxTokens: 524288, description: 'High-efficiency Subagent Swarm worker' },
                { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite', maxTokens: 262144, description: 'Fallback worker agent' }
            ]
        });
    });

    geminiRouter.get('/status', async (_req: Request, res: Response) => {
        try {
            const status = await geminiService.getStatus();
            res.json(status);
        } catch (err: any) {
            res.json({
                initialized: true,
                hasKey: true,
                primaryModel: 'gemini-3.7-flash',
                subagentModels: ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'],
                builtInToolsAvailable: ['googleSearch', 'codeExecution']
            });
        }
    });

    geminiRouter.post('/generate', async (req: Request, res: Response) => {
        try {
            const response = await geminiService.generateArtifact(req.body);
            res.json(response);
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });

    const handleStream = async (req: Request, res: Response) => {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        });

        try {
            await geminiService.streamGenerate(req.body, event => {
                res.write(`data: ${JSON.stringify(event)}\n\n`);
            });
            res.write('data: [DONE]\n\n');
            res.end();
        } catch (err: any) {
            res.write(`data: ${JSON.stringify({ type: 'error', error: err.message || 'Streaming failed' })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
        }
    };

    geminiRouter.post('/stream', handleStream);
    geminiRouter.post('/generate-stream', handleStream);

    geminiRouter.post('/subagent', async (req: Request, res: Response) => {
        try {
            const response = await geminiService.executeSubagentTask(req.body);
            res.json(response);
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });

    geminiRouter.post('/ping-mcp', async (req: Request, res: Response) => {
        try {
            const response = await geminiService.pingMcpServer(req.body);
            res.json(response);
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });

    geminiRouter.post('/credentials', async (req: Request, res: Response) => {
        try {
            const { apiKey } = req.body || {};
            if (apiKey) {
                process.env.GEMINI_API_KEY = apiKey;
                process.env.GOOGLE_API_KEY = apiKey;
                await mediaCredentials.saveApiKey(apiKey).catch(() => {});
            }
            res.json({
                success: true,
                message: 'Credentials updated successfully'
            });
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });

    // Codebase Lens Endpoints
    geminiRouter.post('/lens/project', async (req: Request, res: Response) => {
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

    geminiRouter.post('/lens/unproject', async (req: Request, res: Response) => {
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

    geminiRouter.get('/lens/bindings', (_req: Request, res: Response) => {
        try {
            const bindings = geminiService.executeLensListBindings();
            res.json({ success: true, bindings });
        } catch (err: any) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    geminiRouter.post('/lens/sync', (req: Request, res: Response) => {
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
    geminiRouter.post('/deep-write/pipeline', async (req: Request, res: Response) => {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        });

        try {
            const { prompt, sessionId, workspaceRoot, activeArtifact, useGoogleSearch } = req.body || {};
            if (!prompt) {
                res.write(`data: ${JSON.stringify({ type: 'error', error: 'Prompt is required' })}\n\n`);
                res.end();
                return;
            }

            await deepWriteService.runPipeline(
                { prompt, sessionId, workspaceRoot, activeArtifact, useGoogleSearch },
                event => {
                    res.write(`data: ${JSON.stringify(event)}\n\n`);
                }
            );
            res.end();
        } catch (err: any) {
            res.write(`data: ${JSON.stringify({ type: 'error', error: err.message || 'Streaming failed' })}\n\n`);
            res.end();
        }
    });

    geminiRouter.post('/deep-write/resume', async (req: Request, res: Response) => {
        try {
            const { sessionId, feedback, workspaceRoot } = req.body || {};
            if (!sessionId || feedback === undefined) {
                res.status(400).json({ success: false, error: 'sessionId and feedback are required' });
                return;
            }

            await deepWriteService.resumePipeline(sessionId, feedback, workspaceRoot);
            res.json({ success: true });
        } catch (err: any) {
            res.status(500).json({ success: false, error: err.message || 'Failed to resume pipeline' });
        }
    });

    // Autonomous Long-Running Agent Loop Endpoints
    geminiRouter.post('/agent/session', async (req: Request, res: Response) => {
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

    geminiRouter.get('/agent/session/:id', (req: Request, res: Response) => {
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

    geminiRouter.post('/agent/action', async (req: Request, res: Response) => {
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

    geminiRouter.post('/agent/stream', async (req: Request, res: Response) => {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        });

        try {
            const { sessionId } = req.body || {};
            if (!sessionId) {
                res.write(`data: ${JSON.stringify({ type: 'error', error: 'sessionId is required' })}\n\n`);
                res.end();
                return;
            }
            await longRunningAgentService.runAutonomousLoop(sessionId, event => {
                res.write(`data: ${JSON.stringify(event)}\n\n`);
            });
            res.write('data: [DONE]\n\n');
            res.end();
        } catch (err: any) {
            res.write(`data: ${JSON.stringify({ type: 'error', error: err.message || 'Autonomous agent execution failed' })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
        }
    });

    // Subagent Pool & DAG Swarm Endpoints
    geminiRouter.get('/subagent/pool-status', (_req: Request, res: Response) => {
        try {
            const metrics = subagentPoolService.getPoolMetrics();
            res.json({ success: true, metrics });
        } catch (err: any) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    geminiRouter.post('/subagent/swarm', async (req: Request, res: Response) => {
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

    // User Memories Endpoints
    geminiRouter.get('/memories', async (req: Request, res: Response) => {
        try {
            const { scope, category, categoryGroup, workspaceRoot } = req.query as Record<string, string>;
            const memories = await memoriesService.listMemories({
                scope: scope as any,
                category: category as any,
                categoryGroup: categoryGroup as any,
                workspaceRoot
            });
            res.json({ success: true, memories });
        } catch (err: any) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    geminiRouter.post('/memories', async (req: Request, res: Response) => {
        try {
            const { category, key, value, scope, workspaceId, workspaceRoot } = req.body || {};
            if (!category || !key || !value) {
                res.status(400).json({ success: false, error: 'category, key, and value are required' });
                return;
            }
            const memory = await memoriesService.createMemory({
                category,
                key,
                value,
                scope,
                workspaceId,
                workspaceRoot
            });
            res.json({ success: true, memory });
        } catch (err: any) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // Symbol Graph & AST Query Endpoints
    geminiRouter.get('/symbols', async (req: Request, res: Response) => {
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
    geminiRouter.get('/diagnostics', (_req: Request, res: Response) => {
        try {
            const summary = lspFeedbackService.getSummary();
            res.json({ success: true, summary });
        } catch (err: any) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    geminiRouter.post('/diagnostics/compiler', (req: Request, res: Response) => {
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
            const job = await mediaJobs.create(request);
            if (waitForCompletion) {
                const completed = await mediaJobs.process(job.id, request.workspaceRoot || process.cwd());
                res.status(completed.status === 'completed' ? 200 : 422).json({
                    success: completed.status === 'completed',
                    job: completed,
                    error: completed.error
                });
                return;
            }
            mediaJobs.process(job.id, request.workspaceRoot || process.cwd()).catch(() => undefined);
            res.status(202).json({ success: true, job });
        } catch (error) {
            const detail = (error as any)?.mediaError || classifyMediaGenerationError(error);
            const status = detail.code === 'unauthorized' ? 401
                : detail.code === 'quota' ? 429
                    : detail.code === 'invalid_request' ? 400
                        : detail.code === 'unsupported' ? 422 : 500;
            res.status(status).json({ success: false, error: detail });
        }
    };

    geminiRouter.post('/image/generate', async (req: Request, res: Response) => {
        await startMediaJob({ ...req.body, kind: 'image' }, res, true);
    });

    geminiRouter.post('/video/generate', async (req: Request, res: Response) => {
        await startMediaJob({ ...req.body, kind: 'video' }, res, false);
    });

    app.use('/gemini', geminiRouter);

    // ==========================================
    // 3. Workspace Endpoints
    // ==========================================
    const workspaceRouter = express.Router();

    workspaceRouter.get('/config', async (req: Request, res: Response) => {
        try {
            const root = (req.query.root as string) || process.cwd();
            const config = await workspaceService.loadFullWorkspaceConfig(root);
            res.json(config);
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });

    workspaceRouter.post('/config', async (req: Request, res: Response) => {
        try {
            const { workspaceRoot, settings } = req.body;
            await workspaceService.saveWorkspaceConfig(workspaceRoot || process.cwd(), { settings });
            res.json({ success: true });
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });

    workspaceRouter.post('/sync-artifact', async (req: Request, res: Response) => {
        try {
            const { workspaceRoot, artifact } = req.body;
            const result = await workspaceService.syncArtifactToWorkspace(workspaceRoot || process.cwd(), artifact);
            res.json(result);
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });

    workspaceRouter.get('/project-artifacts', async (req: Request, res: Response) => {
        const projectId = (req.query.projectId as string) || 'default-project';
        try {
            const root = (req.query.root as string) || process.cwd();
            const graph = await artifactStore.loadOrCreate(root, projectId);
            res.json(graph);
        } catch (err: any) {
            res.json(createEmptyProjectGraph(projectId));
        }
    });

    workspaceRouter.post('/project-artifacts', async (req: Request, res: Response) => {
        try {
            const { workspaceRoot, graph } = req.body || {};
            if (!graph) {
                res.status(400).json({ error: 'Missing graph body' });
                return;
            }
            await artifactStore.save(workspaceRoot || process.cwd(), graph);
            res.json({ success: true });
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });

    workspaceRouter.post('/create', async (req: Request, res: Response) => {
        try {
            const { name, path: targetPath, template } = req.body || {};
            const cleanName = (name || 'new-workspace').trim();
            const devHome = process.env.HOME ? path.join(process.env.HOME, 'dev') : '/Users/eligreen/dev';
            const resolvedPath = targetPath 
                ? path.resolve(targetPath.replace(/^~/, process.env.HOME || '/Users/eligreen'))
                : path.resolve(devHome, cleanName.toLowerCase().replace(/[^a-z0-9_-]/g, '-'));
            
            await fs.ensureDir(resolvedPath);
            await fs.ensureDir(path.join(resolvedPath, '.scratchbox', 'rules'));
            await fs.ensureDir(path.join(resolvedPath, '.scratchbox', 'skills'));
            await fs.ensureDir(path.join(resolvedPath, 'src'));

            const configPath = path.join(resolvedPath, '.scratchbox', 'config.json');
            if (!await fs.pathExists(configPath)) {
                await fs.writeJSON(configPath, {
                    workspaceName: cleanName,
                    theme: 'obsidian',
                    defaultModel: 'gemini-3.7-flash',
                    thinkingBudget: 1024,
                    template: template || 'blank'
                }, { spaces: 2 });
            }

            const readmePath = path.join(resolvedPath, 'README.md');
            if (!await fs.pathExists(readmePath)) {
                await fs.writeFile(readmePath, `# ${cleanName}\n\nCreated with Scratchbox IDE.\n`);
            }

            res.json({
                success: true,
                workspace: {
                    id: `proj-${Date.now()}`,
                    name: cleanName,
                    path: resolvedPath,
                    lastActive: 'Just now',
                    tags: ['Custom', 'Workspace'],
                    isActive: true
                }
            });
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });

    workspaceRouter.get('/events/file-change', (req: Request, res: Response) => {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders?.();

        res.write('event: ping\ndata: {"status":"connected"}\n\n');

        const keepAlive = setInterval(() => {
            res.write('event: ping\ndata: {"status":"ping"}\n\n');
        }, 30000);

        req.on('close', () => {
            clearInterval(keepAlive);
        });
    });

    workspaceRouter.get('/external-mcp', async (_req: Request, res: Response) => {
        try {
            const sources = await workspaceService.discoverExternalMcpConfigs();
            res.json(sources);
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });

    app.use('/workspace', workspaceRouter);

    // ==========================================
    // 4. Google Media Endpoints (Nano Banana 2, Omni 1.1, Imagen, Veo)
    // ==========================================
    const mediaRouter = express.Router();

    mediaRouter.get('/capabilities', async (_req: Request, res: Response) => {
        try {
            const caps = await mediaGenerator.detectCapabilities();
            res.json({
                ...caps,
                image: {
                    supported: true,
                    models: IMAGE_MODEL_PRIORITY,
                    primaryModel: 'nano-banana-2'
                },
                video: {
                    supported: true,
                    models: VIDEO_MODEL_PRIORITY,
                    primaryModel: 'google/omni-1.1'
                },
                audio: {
                    supported: true,
                    models: ['gemini-2.5-flash-tts']
                }
            });
        } catch {
            res.json({
                image: {
                    supported: true,
                    models: IMAGE_MODEL_PRIORITY,
                    primaryModel: 'nano-banana-2'
                },
                video: {
                    supported: true,
                    models: VIDEO_MODEL_PRIORITY,
                    primaryModel: 'google/omni-1.1'
                },
                audio: {
                    supported: true,
                    models: ['gemini-2.5-flash-tts']
                }
            });
        }
    });

    mediaRouter.post('/image/generate', async (req: Request, res: Response) => {
        await startMediaJob({ ...req.body, kind: 'image' }, res, true);
    });

    mediaRouter.post('/video/generate', async (req: Request, res: Response) => {
        await startMediaJob({ ...req.body, kind: 'video' }, res, false);
    });

    mediaRouter.post('/jobs', async (req: Request, res: Response) => {
        await startMediaJob(req.body as MediaGenerationRequest, res, false);
    });

    mediaRouter.get('/jobs/:id', async (req: Request, res: Response) => {
        const workspaceRoot = String(req.query.workspaceRoot || process.cwd());
        const job = await mediaJobs.get(req.params.id, workspaceRoot);
        if (!job) {
            res.status(404).json({
                success: false,
                error: { code: 'invalid_request', message: 'Media job not found', retryable: false }
            });
            return;
        }
        res.json({ success: true, job });
    });

    mediaRouter.post('/jobs/:id/cancel', async (req: Request, res: Response) => {
        try {
            const workspaceRoot = String(req.body?.workspaceRoot || process.cwd());
            const job = await mediaJobs.cancel(req.params.id, workspaceRoot);
            res.json({ success: true, job });
        } catch (error) {
            const detail = classifyMediaGenerationError(error);
            res.status(400).json({ success: false, error: detail });
        }
    });

    mediaRouter.get('/jobs/:id/content', async (req: Request, res: Response) => {
        try {
            const workspaceRoot = String(req.query.workspaceRoot || process.cwd());
            const job = await mediaJobs.get(req.params.id, workspaceRoot);
            if (!job?.result?.asset || job.status !== 'completed') {
                res.status(404).json({
                    success: false,
                    error: { code: 'invalid_request', message: 'Completed media asset not found', retryable: false }
                });
                return;
            }
            const filePath = mediaAssets.resolve(workspaceRoot, job.result.asset);
            res.type(job.result.asset.mimeType);
            res.setHeader('Cache-Control', 'private, immutable, max-age=31536000');
            res.sendFile(filePath);
        } catch (error) {
            const detail = classifyMediaGenerationError(error);
            res.status(400).json({ success: false, error: detail });
        }
    });

    app.use('/media', mediaRouter);
    app.use('/gemini/media', mediaRouter);

    // ==========================================
    // 5. Standalone Vibe-Coded Tools & Micro-Studios Hub
    // ==========================================
    const toolsRouter = express.Router();
    const exportedToolsStore = new Map<string, { id: string; title: string; html: string; updatedAt: number }>();

    toolsRouter.post('/export', (req: Request, res: Response) => {
        const { toolId, title, html } = req.body;
        const id = toolId || `tool-${Date.now()}`;
        exportedToolsStore.set(id, {
            id,
            title: title || 'Scratchbox Standalone Tool',
            html: html || '',
            updatedAt: Date.now()
        });
        res.json({
            success: true,
            toolId: id,
            url: `/tools/${id}`
        });
    });

    toolsRouter.get('/:toolId', (req: Request, res: Response) => {
        const { toolId } = req.params;
        const tool = exportedToolsStore.get(toolId);
        if (!tool) {
            return res.status(404).send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Tool Not Found - Scratchbox IDE</title>
    <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-zinc-950 text-zinc-100 flex items-center justify-center min-h-screen font-sans p-4">
    <div class="text-center p-8 bg-zinc-900 border border-zinc-800 rounded-2xl max-w-md shadow-2xl">
        <div class="w-12 h-12 rounded-full bg-amber-500/10 text-amber-400 flex items-center justify-center mx-auto mb-4 font-mono font-bold text-lg">!</div>
        <h1 class="text-xl font-bold mb-2">Standalone Tool Not Found</h1>
        <p class="text-sm text-zinc-400 mb-6">The requested vibe-coded tool "${toolId}" was not found or has expired.</p>
        <a href="/" class="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs rounded-lg transition font-medium">Return to Scratchbox IDE</a>
    </div>
</body>
</html>`);
        }
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(tool.html);
    });

    app.use('/api/tools', toolsRouter);
    app.use('/tools', toolsRouter);

    // Serve static files if in production
    if (options.staticDir && fs.existsSync(options.staticDir)) {
        app.use(express.static(options.staticDir));
        app.get('*', (_req: Request, res: Response) => {
            res.sendFile(path.join(options.staticDir!, 'index.html'));
        });
    }

    return app;
}
