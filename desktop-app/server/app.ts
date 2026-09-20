/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import express, { Express, NextFunction, Request, Response } from 'express';
import bodyParser from 'body-parser';
import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs-extra';
import { exec } from 'child_process';
import { assertWorkspaceRoot, PathTraversalError, resolveWithinRoot } from '../../packages/core/src/node/security/path-guard';
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
    NativeCppCompilerService,
    HeadlessVideoCompositorService,
    PhotorealTileCleanupService,
    DeploymentManifestCompiler,
    TrainedModelRegistryService,
    ComfyUiBridgeService,
    ComfyUiPipelineAgent,
    ComfyUiCloudRunService,
    Depthbox360UniverseService,
    ImageToSplatService,
    Google360PanoramaPipelineService,
    SurveyApi,
    createSurveyRouter,
    registerBeautifyHandlers,
    createGoogleStationImageGenerator,
    getGoogle3DTilesClay
} from '../../packages/core/src/node';
import { GeoFrame } from '../../packages/core/src/common/coordinate/GeoFrame';
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
    /** Port the isolated tools origin listens on; used to build export URLs. Defaults to `SCRATCHBOX_TOOLS_PORT` or 3002. */
    toolsPort?: number;
    /** Host the tools origin is reachable at from the renderer. Defaults to 127.0.0.1. */
    toolsHost?: string;
}

export interface ExportedTool {
    id: string;
    title: string;
    html: string;
    updatedAt: number;
}

export type ExportedToolsStore = Map<string, ExportedTool>;

/** Environment variables the server is allowed to hydrate from secrets files. */
export const SERVER_SECRET_ALLOWLIST = [
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'GOOGLE_AI_API_KEY',
    'GOOGLE_CLOUD_API_KEY',
    'GOOGLE_MAPS_API_KEY',
    'GOOGLE_SEARCH_ENGINE_ID',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GOOGLE_CLOUD_PROJECT',
    'GOOGLE_CLOUD_LOCATION',
    'GOOGLE_SERVICE_ACCOUNT_JSON',
    'GOOGLE_OAUTH_CLIENT_ID'
];

/** Origins allowed to call the API when an Origin header is present. */
export function resolveAllowedOrigins(): Set<string> {
    const origins = new Set<string>(['http://127.0.0.1:3000', 'http://localhost:3000']);
    for (const entry of (process.env.SCRATCHBOX_ALLOWED_ORIGINS || '').split(',')) {
        const trimmed = entry.trim();
        if (trimmed) origins.add(trimmed);
    }
    return origins;
}

/** Workspace roots the API may read from / write to. */
export function resolveAllowedWorkspaceRoots(): string[] {
    const roots = [
        process.cwd(),
        path.join(os.homedir(), 'dev'),
        path.join(os.homedir(), 'Documents')
    ];
    for (const entry of (process.env.SCRATCHBOX_WORKSPACE_ROOTS || '').split(/[,:]/)) {
        const trimmed = entry.trim();
        if (trimmed) roots.push(path.resolve(trimmed));
    }
    return roots;
}

function loadEnvironmentSecrets(): void {
    const homeSecrets = path.join(os.homedir(), '.scratchbox', 'secrets.json');
    const repoSecrets = [
        path.resolve(process.cwd(), 'secrets.json'),
        path.resolve(__dirname, '../../secrets.json'),
        path.resolve(__dirname, '../../../secrets.json')
    ];
    const envFiles = [
        path.resolve(process.cwd(), '.env'),
        path.resolve(__dirname, '../../.env'),
        path.resolve(__dirname, '../../../.env')
    ];

    const allowed = new Set(SERVER_SECRET_ALLOWLIST);
    const applyJson = (file: string): void => {
        const json = fs.readJSONSync(file);
        if (!json || typeof json !== 'object') return;
        for (const [k, v] of Object.entries(json)) {
            if (!allowed.has(k)) continue;
            if (typeof v === 'string' && !process.env[k]) {
                process.env[k] = v;
            } else if (v && typeof v === 'object' && k === 'GOOGLE_SERVICE_ACCOUNT_JSON' && !process.env[k]) {
                process.env[k] = JSON.stringify(v);
            }
        }
    };

    // Prefer the per-user secrets file; fall back to a repo-root file (with a warning).
    let loadedJson = false;
    if (fs.existsSync(homeSecrets)) {
        try { applyJson(homeSecrets); loadedJson = true; } catch { /* ignore parse errors */ }
    }
    if (!loadedJson) {
        for (const file of repoSecrets) {
            if (!fs.existsSync(file)) continue;
            try {
                applyJson(file);
                console.warn(`[Scratchbox] Loaded API secrets from repo-local ${file}; move them to ${homeSecrets} to keep them out of the source tree.`);
                break;
            } catch {
                // Ignore parse errors
            }
        }
    }

    for (const file of envFiles) {
        if (!fs.existsSync(file)) continue;
        try {
            {
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
                        if (allowed.has(key) && !process.env[key]) {
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

/** Routes reachable without the launch token. */
const OPEN_ROUTES: Array<{ method: string; path: string }> = [
    { method: 'GET', path: '/health' },
    { method: 'GET', path: '/api/browser/status' },
    { method: 'GET', path: '/api/models' },
    { method: 'GET', path: '/api/models/status' }
];

/** GET routes consumed by EventSource, which cannot set headers: accept `?token=`. */
const SSE_QUERY_TOKEN_ROUTES = new Set<string>(['/workspace/events/file-change']);

/** Path prefixes that make up the authenticated API surface. */
const PROTECTED_PREFIXES = ['/gemini', '/workspace', '/media', '/api'];

function safeEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) {
        return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
}

export function resolveLaunchToken(): string {
    const fromEnv = (process.env.SCRATCHBOX_LAUNCH_TOKEN || '').trim();
    return fromEnv || crypto.randomBytes(32).toString('hex');
}

function createCorsMiddleware(allowedOrigins: Set<string>) {
    return (req: Request, res: Response, next: NextFunction): void => {
        const origin = req.headers.origin;
        if (!origin) {
            // Same-origin, curl, Electron file:// without CORS mode, or server-to-server.
            next();
            return;
        }
        if (!allowedOrigins.has(origin)) {
            res.status(403).json({ error: 'origin_not_allowed', message: `Origin ${origin} is not allowed` });
            return;
        }
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Scratchbox-Token, Accept');
        res.setHeader('Access-Control-Expose-Headers', 'X-Scratchbox-Resolved-Url');
        res.setHeader('Access-Control-Max-Age', '600');
        if (req.method === 'OPTIONS') {
            res.status(204).end();
            return;
        }
        next();
    };
}

function createLaunchTokenMiddleware(token: string) {
    return (req: Request, res: Response, next: NextFunction): void => {
        if (req.method === 'OPTIONS') {
            next();
            return;
        }
        const routePath = req.path.replace(/\/+$/, '') || '/';
        if (!PROTECTED_PREFIXES.some(prefix => routePath === prefix || routePath.startsWith(`${prefix}/`))) {
            // Static assets / SPA fallback are public application code.
            next();
            return;
        }
        if (OPEN_ROUTES.some(route => route.method === req.method && route.path === routePath)) {
            next();
            return;
        }

        let presented: string | undefined;
        const authorization = req.headers.authorization;
        if (typeof authorization === 'string' && /^Bearer\s+/i.test(authorization)) {
            presented = authorization.replace(/^Bearer\s+/i, '').trim();
        }
        const headerToken = req.headers['x-scratchbox-token'];
        if (!presented && typeof headerToken === 'string') {
            presented = headerToken.trim();
        }
        if (!presented && req.method === 'GET' && SSE_QUERY_TOKEN_ROUTES.has(routePath) && typeof req.query.token === 'string') {
            presented = req.query.token;
        }

        if (presented && safeEqual(presented, token)) {
            next();
            return;
        }
        res.status(401).json({ error: 'unauthorized', message: 'Missing or invalid Scratchbox launch token' });
    };
}

function isPathError(err: unknown): err is PathTraversalError {
    return err instanceof PathTraversalError || (err as any)?.code === 'path_traversal';
}

/**
 * Creates the authenticated API application. The per-launch token is exposed
 * as `app.locals.launchToken`; the exported-tool store shared with
 * {@link createToolsServer} as `app.locals.exportedToolsStore`.
 */
export function createStandaloneServer(options: StandaloneServerOptions = {}): Express {
    loadEnvironmentSecrets();
    const app = express();

    const launchToken = resolveLaunchToken();
    const allowedOrigins = resolveAllowedOrigins();
    const allowedWorkspaceRoots = resolveAllowedWorkspaceRoots();
    const exportedToolsStore: ExportedToolsStore = new Map();
    const toolsPort = options.toolsPort ?? parseInt(process.env.SCRATCHBOX_TOOLS_PORT || '3002', 10);
    const toolsHost = options.toolsHost || '127.0.0.1';

    app.locals.launchToken = launchToken;
    app.locals.exportedToolsStore = exportedToolsStore;
    app.locals.allowedWorkspaceRoots = allowedWorkspaceRoots;
    app.disable('x-powered-by');

    app.use(createCorsMiddleware(allowedOrigins));

    // Static assets (production, browser mode) are public application code and
    // are served before the token gate. API prefixes below always require it.
    if (options.staticDir && fs.existsSync(options.staticDir)) {
        app.use(express.static(options.staticDir, { index: 'index.html' }));
    }

    const publicRoot = path.resolve(__dirname, '../../public');
    if (fs.existsSync(publicRoot)) {
        app.use(express.static(publicRoot));
    }

    app.use(createLaunchTokenMiddleware(launchToken));
    app.use(bodyParser.json({ limit: '50mb' }));
    app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));

    app.get('/health', (_req: Request, res: Response) => {
        res.json({ ok: true, service: 'scratchbox-api', timestamp: Date.now() });
    });

    /**
     * Validates a caller-supplied workspace root against the allowlist.
     * Returns the canonical root or throws PathTraversalError.
     */
    const requireWorkspaceRoot = (candidate: unknown): string => {
        const root = typeof candidate === 'string' && candidate.trim() ? candidate.trim() : process.cwd();
        return assertWorkspaceRoot(root, allowedWorkspaceRoots);
    };

    const sendError = (res: Response, err: any, fallbackStatus = 500): void => {
        if (isPathError(err)) {
            res.status(403).json({ success: false, error: 'workspace_root_not_allowed', message: err.message });
            return;
        }
        res.status(fallbackStatus).json({ success: false, error: err?.message || 'Internal server error' });
    };

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
    const cppCompiler = new NativeCppCompilerService();
    const tileCleanupService = new PhotorealTileCleanupService(cppCompiler);
    const videoCompositor = new HeadlessVideoCompositorService();
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
            res.status(503).json({
                initialized: false,
                hasKey: false,
                connected: false,
                error: err?.message || 'Gemini service unavailable'
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

    /** Opens an SSE response and returns an AbortController tied to the client connection. */
    const openSse = (req: Request, res: Response): AbortController => {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive'
        });
        res.flushHeaders?.();
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
                if (!controller.signal.aborted) {
                    res.write(`data: ${JSON.stringify(event)}\n\n`);
                }
            }, controller.signal);
            res.write('data: [DONE]\n\n');
            res.end();
        } catch (err: any) {
            if (controller.signal.aborted) {
                res.end();
                return;
            }
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

    geminiRouter.post('/fim', async (req: Request, res: Response) => {
        try {
            const response = await geminiService.completeFim(req.body);
            res.json(response);
        } catch (err: any) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    geminiRouter.post('/quick-edit', async (req: Request, res: Response) => {
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
    geminiRouter.post('/ping-mcp', pingMcp);
    geminiRouter.post('/mcp/ping', pingMcp);

    // `gemini-client.ts` calls `/save-credentials` with `{ apiKey?, credentialsJson? }`;
    // `/credentials` is the older API-key-only form. Service-account JSON is always
    // written to the default per-user location; a caller-supplied `targetPath` is ignored.
    const saveCredentials = async (req: Request, res: Response): Promise<void> => {
        try {
            const { apiKey, credentialsJson } = req.body || {};
            const rawApiKey = typeof apiKey === 'string' ? apiKey.trim() : '';
            const rawJson = typeof credentialsJson === 'string' ? credentialsJson.trim() : '';
            if (!rawApiKey && !rawJson) {
                res.status(400).json({ success: false, authMethod: 'unauthenticated', error: 'apiKey or credentialsJson is required' });
                return;
            }
            if (rawJson && !rawJson.startsWith('AIza')) {
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
    geminiRouter.post('/credentials', saveCredentials);
    geminiRouter.post('/save-credentials', saveCredentials);

    geminiRouter.post('/tts', async (req: Request, res: Response) => {
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

    geminiRouter.post('/verify-visual', async (req: Request, res: Response) => {
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

    geminiRouter.post('/verify-and-repair', async (req: Request, res: Response) => {
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
                    if (!controller.signal.aborted) {
                        res.write(`data: ${JSON.stringify(event)}\n\n`);
                    }
                },
                controller.signal
            );
            res.end();
        } catch (err: any) {
            if (!controller.signal.aborted) {
                res.write(`data: ${JSON.stringify({ type: 'error', error: err.message || 'Streaming failed' })}\n\n`);
            }
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
        const { sessionId } = req.body || {};
        if (!sessionId) {
            res.status(400).json({ success: false, error: 'sessionId is required' });
            return;
        }

        const controller = openSse(req, res);
        try {
            await longRunningAgentService.runAutonomousLoop(sessionId, event => {
                if (!controller.signal.aborted) {
                    res.write(`data: ${JSON.stringify(event)}\n\n`);
                }
            }, controller.signal);
            res.write('data: [DONE]\n\n');
            res.end();
        } catch (err: any) {
            if (controller.signal.aborted) {
                res.end();
                return;
            }
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
                workspaceRoot: workspaceRoot ? requireWorkspaceRoot(workspaceRoot) : undefined
            });
            res.json({ success: true, memories });
        } catch (err: any) {
            sendError(res, err);
        }
    });

    // Contract mirrors packages/core/src/browser/generative-canvas/user-memories-client.ts.
    // `POST /memories` is kept as an alias of `/memories/create` for older callers.
    const createMemory = async (req: Request, res: Response): Promise<void> => {
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
                workspaceRoot: workspaceRoot ? requireWorkspaceRoot(workspaceRoot) : undefined
            });
            res.json({ success: true, memory });
        } catch (err: any) {
            sendError(res, err);
        }
    };
    geminiRouter.post('/memories', createMemory);
    geminiRouter.post('/memories/create', createMemory);

    geminiRouter.post('/memories/update', async (req: Request, res: Response) => {
        try {
            const { id, category, key, value, workspaceRoot } = req.body || {};
            if (!id) {
                res.status(400).json({ success: false, error: 'id is required' });
                return;
            }
            const updated = await memoriesService.updateMemory(id, {
                category,
                key,
                value,
                workspaceRoot: workspaceRoot ? requireWorkspaceRoot(workspaceRoot) : undefined
            });
            if (!updated) {
                res.status(404).json({ success: false, error: 'Memory not found' });
                return;
            }
            res.json({ success: true, memory: updated });
        } catch (err: any) {
            sendError(res, err);
        }
    });

    geminiRouter.post('/memories/delete', async (req: Request, res: Response) => {
        try {
            const { id, workspaceRoot } = req.body || {};
            if (!id) {
                res.status(400).json({ success: false, error: 'id is required' });
                return;
            }
            const deleted = await memoriesService.deleteMemory(id, workspaceRoot ? requireWorkspaceRoot(workspaceRoot) : undefined);
            res.json({ success: deleted });
        } catch (err: any) {
            sendError(res, err);
        }
    });

    geminiRouter.post('/memories/clear-category', async (req: Request, res: Response) => {
        try {
            const { category, workspaceRoot } = req.body || {};
            if (!category) {
                res.status(400).json({ success: false, error: 'category is required' });
                return;
            }
            const clearedCount = await memoriesService.clearCategory(category, workspaceRoot ? requireWorkspaceRoot(workspaceRoot) : undefined);
            res.json({ success: true, clearedCount });
        } catch (err: any) {
            sendError(res, err);
        }
    });

    geminiRouter.get('/memories/writing-profiles', async (req: Request, res: Response) => {
        try {
            const raw = req.query.workspaceRoot as string | undefined;
            const workspaceRoot = raw ? requireWorkspaceRoot(raw) : undefined;
            const profiles = await memoriesService.listWritingProfiles(workspaceRoot);
            const activeProfile = await memoriesService.getActiveWritingProfile(workspaceRoot);
            res.json({ success: true, profiles, activeProfile });
        } catch (err: any) {
            sendError(res, err);
        }
    });

    geminiRouter.post('/memories/writing-profiles', async (req: Request, res: Response) => {
        try {
            const { action, id, name, stylePrompt, samples, isActive, scope, workspaceRoot: raw } = req.body || {};
            const workspaceRoot = raw ? requireWorkspaceRoot(raw) : undefined;
            if (action === 'set-active' && id) {
                res.json({ success: await memoriesService.setActiveWritingProfile(id, workspaceRoot) });
                return;
            }
            if (action === 'delete' && id) {
                res.json({ success: await memoriesService.deleteWritingProfile(id, workspaceRoot) });
                return;
            }
            if ((action === 'create' || !action) && name && stylePrompt) {
                const profile = await memoriesService.createWritingProfile({ name, stylePrompt, samples, isActive, scope, workspaceRoot });
                res.json({ success: true, profile });
                return;
            }
            res.status(400).json({ success: false, error: 'Invalid action or parameters for writing profiles' });
        } catch (err: any) {
            sendError(res, err);
        }
    });

    geminiRouter.get('/memories/style-preferences', async (req: Request, res: Response) => {
        try {
            const raw = req.query.workspaceRoot as string | undefined;
            const preferences = await memoriesService.listStylePreferences({
                category: req.query.category as string | undefined,
                workspaceRoot: raw ? requireWorkspaceRoot(raw) : undefined
            });
            res.json({ success: true, preferences });
        } catch (err: any) {
            sendError(res, err);
        }
    });

    geminiRouter.post('/memories/style-preferences', async (req: Request, res: Response) => {
        try {
            const { action, id, name, description, stylePrompt, category, isDefault, sortOrder, scope, workspaceRoot: raw } = req.body || {};
            const workspaceRoot = raw ? requireWorkspaceRoot(raw) : undefined;
            if (action === 'delete' && id) {
                res.json({ success: await memoriesService.deleteStylePreference(id, workspaceRoot) });
                return;
            }
            if ((action === 'create' || !action) && name && stylePrompt) {
                const preference = await memoriesService.createStylePreference({
                    name, description, stylePrompt, category, isDefault, sortOrder, scope, workspaceRoot
                });
                res.json({ success: true, preference });
                return;
            }
            res.status(400).json({ success: false, error: 'Invalid action or parameters for style preferences' });
        } catch (err: any) {
            sendError(res, err);
        }
    });

    geminiRouter.get('/memories/config', async (_req: Request, res: Response) => {
        try {
            res.json({ success: true, config: await memoriesService.getConfig() });
        } catch (err: any) {
            sendError(res, err);
        }
    });

    geminiRouter.post('/memories/config', async (req: Request, res: Response) => {
        try {
            res.json({ success: true, config: await memoriesService.updateConfig(req.body || {}) });
        } catch (err: any) {
            sendError(res, err);
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
    const resolveWorkspaceRoot = (req: Request): string | undefined =>
        (req.query?.root as string) || (req.query?.workspaceRoot as string) || (req.body?.workspaceRoot as string) || undefined;

    workspaceRouter.get('/config', async (req: Request, res: Response) => {
        try {
            const root = requireWorkspaceRoot(req.query.root);
            const config = await workspaceService.loadFullWorkspaceConfig(root);
            res.json(config);
        } catch (err: any) {
            sendError(res, err);
        }
    });

    workspaceRouter.post('/config', async (req: Request, res: Response) => {
        try {
            const { workspaceRoot, settings, customSkills, customMcpServers } = req.body || {};
            await workspaceService.saveWorkspaceConfig(requireWorkspaceRoot(workspaceRoot), {
                settings,
                customSkills,
                customMcpServers
            });
            res.json({ success: true });
        } catch (err: any) {
            sendError(res, err);
        }
    });

    workspaceRouter.post('/sync-artifact', async (req: Request, res: Response) => {
        try {
            const { workspaceRoot, artifact } = req.body || {};
            if (!artifact || typeof artifact !== 'object') {
                res.status(400).json({ success: false, error: 'artifact is required' });
                return;
            }
            const result = await workspaceService.syncArtifactToWorkspace(requireWorkspaceRoot(workspaceRoot), artifact);
            res.json(result);
        } catch (err: any) {
            sendError(res, err);
        }
    });

    /** Resolves an absolute file path that must sit inside one of the allowed workspace roots. */
    const requireFileWithinRoots = (candidate: unknown): string => {
        if (typeof candidate !== 'string' || !candidate.trim()) {
            throw new PathTraversalError('A file path is required');
        }
        for (const root of allowedWorkspaceRoots) {
            try {
                return resolveWithinRoot(root, candidate);
            } catch {
                // try the next root
            }
        }
        throw new PathTraversalError('Path is outside every allowed workspace root', undefined, candidate);
    };

    workspaceRouter.post('/write-lens-files', async (req: Request, res: Response) => {
        try {
            const { workspaceRoot, files } = req.body || {};
            if (!files || typeof files !== 'object' || Array.isArray(files)) {
                res.status(400).json({ success: false, writtenFiles: [], error: 'files payload is required' });
                return;
            }
            const root = requireWorkspaceRoot(workspaceRoot);
            // Reject the whole batch up-front (403) rather than relying on the service's soft failure.
            for (const relPath of Object.keys(files)) {
                resolveWithinRoot(root, relPath);
            }
            const result = await workspaceService.writeLensFiles(root, files, fileWatcher);
            res.status(result.success ? 200 : 500).json(result);
        } catch (err: any) {
            sendError(res, err);
        }
    });

    workspaceRouter.post('/register-hash', (req: Request, res: Response) => {
        try {
            const { filePath, hash } = req.body || {};
            if (typeof hash !== 'string' || !hash) {
                res.status(400).json({ success: false, error: 'hash is required' });
                return;
            }
            fileWatcher.registerKnownHash(requireFileWithinRoots(filePath), hash);
            res.json({ success: true });
        } catch (err: any) {
            sendError(res, err);
        }
    });

    workspaceRouter.post('/import-mcp', async (req: Request, res: Response) => {
        try {
            const { workspaceRoot, servers } = req.body || {};
            if (!Array.isArray(servers) || servers.length === 0) {
                res.status(400).json({ success: false, error: 'No servers provided to import' });
                return;
            }
            const imported = await workspaceService.importExternalMcpServers(requireWorkspaceRoot(workspaceRoot), servers);
            res.json({ success: true, count: imported.length, servers: imported });
        } catch (err: any) {
            sendError(res, err);
        }
    });

    workspaceRouter.get('/project-artifacts', async (req: Request, res: Response) => {
        const projectId = (req.query.projectId as string) || 'default-project';
        let root: string;
        try {
            root = requireWorkspaceRoot(req.query.root);
        } catch (err: any) {
            sendError(res, err);
            return;
        }
        try {
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
            await artifactStore.save(requireWorkspaceRoot(workspaceRoot), graph);
            res.json({ success: true });
        } catch (err: any) {
            sendError(res, err);
        }
    });

    workspaceRouter.post('/create', async (req: Request, res: Response) => {
        try {
            const { name, path: targetPath, template } = req.body || {};
            const cleanName = String(name || 'new-workspace').trim();
            const home = os.homedir();
            const devHome = path.join(home, 'dev');
            const requestedPath = typeof targetPath === 'string' && targetPath.trim()
                ? path.resolve(targetPath.trim().replace(/^~(?=$|[\\/])/, home))
                : path.resolve(devHome, cleanName.toLowerCase().replace(/[^a-z0-9_-]/g, '-'));

            // The new workspace must live under an allowed root; once created it becomes one itself.
            const resolvedPath = assertWorkspaceRoot(requestedPath, allowedWorkspaceRoots);
            if (!allowedWorkspaceRoots.includes(resolvedPath)) {
                allowedWorkspaceRoots.push(resolvedPath);
            }

            await fs.ensureDir(resolvedPath);
            await fs.ensureDir(path.join(resolvedPath, '.scratchbox', 'rules'));
            await fs.ensureDir(path.join(resolvedPath, '.scratchbox', 'skills'));
            await fs.ensureDir(path.join(resolvedPath, 'src'));

            const configPath = path.join(resolvedPath, '.scratchbox', 'config.json');
            if (!await fs.pathExists(configPath)) {
                await fs.writeJSON(configPath, {
                    workspaceName: cleanName,
                    theme: 'dark',
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
            sendError(res, err);
        }
    });

    workspaceRouter.get('/events/file-change', (req: Request, res: Response) => {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders?.();

        res.write('event: ping\ndata: {"status":"connected"}\n\n');

        // Stream real file-change events from the watcher to this client.
        fileWatcher.addSSEClient(res);

        const keepAlive = setInterval(() => {
            res.write('event: ping\ndata: {"status":"ping"}\n\n');
        }, 30000);

        req.on('close', () => {
            clearInterval(keepAlive);
            fileWatcher.removeSSEClient(res);
        });
    });

    workspaceRouter.get(['/files', '/tree'], async (req: Request, res: Response) => {
        try {
            const workspaceRoot = resolveWorkspaceRoot(req);
            const targetRoot = workspaceRoot ? requireWorkspaceRoot(workspaceRoot) : allowedWorkspaceRoots[0];
            const maxDepth = parseInt(req.query.maxDepth as string, 10) || 6;
            const tree = await workspaceService.getDirectoryTree(targetRoot, maxDepth);
            res.json({ success: true, root: targetRoot, files: tree, tree });
        } catch (err: any) {
            sendError(res, err);
        }
    });

    workspaceRouter.get(['/file-content', '/file'], async (req: Request, res: Response) => {
        try {
            const workspaceRoot = resolveWorkspaceRoot(req);
            const targetRoot = workspaceRoot ? requireWorkspaceRoot(workspaceRoot) : allowedWorkspaceRoots[0];
            const filePath = String(req.query.path || '').trim();
            if (!filePath) {
                res.status(400).json({ error: 'Missing "path" query parameter' });
                return;
            }
            const fileData = await workspaceService.readFileContent(targetRoot, filePath);
            res.json({ success: true, path: filePath, ...fileData });
        } catch (err: any) {
            sendError(res, err);
        }
    });

    workspaceRouter.post(['/file-content', '/file'], async (req: Request, res: Response) => {
        try {
            const { workspaceRoot, path: filePath, content } = req.body || {};
            const resolvedRoot = workspaceRoot ? requireWorkspaceRoot(workspaceRoot) : allowedWorkspaceRoots[0];
            const cleanPath = String(filePath || '').trim();
            if (!cleanPath) {
                res.status(400).json({ error: 'Missing "path" body parameter' });
                return;
            }
            if (typeof content !== 'string') {
                res.status(400).json({ error: 'Missing "content" body parameter' });
                return;
            }
            const result = await workspaceService.writeFileContent(resolvedRoot, cleanPath, content, fileWatcher);
            res.json(result);
        } catch (err: any) {
            sendError(res, err);
        }
    });

    workspaceRouter.post('/create-file', async (req: Request, res: Response) => {
        try {
            const { workspaceRoot, path: filePath, isFolder, content } = req.body || {};
            const resolvedRoot = workspaceRoot ? requireWorkspaceRoot(workspaceRoot) : allowedWorkspaceRoots[0];
            const cleanPath = String(filePath || '').trim();
            if (!cleanPath) {
                res.status(400).json({ error: 'Missing "path" body parameter' });
                return;
            }
            const safePath = resolveWithinRoot(resolvedRoot, cleanPath);
            if (isFolder) {
                await fs.ensureDir(safePath);
            } else {
                await fs.ensureDir(path.dirname(safePath));
                if (!await fs.pathExists(safePath)) {
                    await fs.writeFile(safePath, typeof content === 'string' ? content : '', 'utf-8');
                }
            }
            res.json({ success: true, path: cleanPath, isFolder: !!isFolder });
        } catch (err: any) {
            sendError(res, err);
        }
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
    // Git Operations Endpoints
    // ==========================================
    const gitRouter = express.Router();

    gitRouter.get('/branches', async (req: Request, res: Response) => {
        try {
            const workspaceRoot = resolveWorkspaceRoot(req);
            const targetRoot = workspaceRoot ? requireWorkspaceRoot(workspaceRoot) : allowedWorkspaceRoots[0];
            exec('git branch -a', { cwd: targetRoot }, (err, stdout, _stderr) => {
                if (err) {
                    res.json({ success: true, current: 'main', branches: ['main'] });
                    return;
                }
                const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean);
                let current = 'main';
                const branches: string[] = [];
                for (const line of lines) {
                    if (line.startsWith('*')) {
                        current = line.replace(/^\*\s*/, '').trim();
                        branches.push(current);
                    } else {
                        const bName = line.replace(/^remotes\/origin\//, '').trim();
                        if (!branches.includes(bName) && !bName.includes('HEAD ->')) {
                            branches.push(bName);
                        }
                    }
                }
                res.json({ success: true, current, branches: branches.length ? branches : ['main'] });
            });
        } catch (err: any) {
            sendError(res, err);
        }
    });

    gitRouter.post('/checkout', async (req: Request, res: Response) => {
        try {
            const workspaceRoot = resolveWorkspaceRoot(req);
            const targetRoot = workspaceRoot ? requireWorkspaceRoot(workspaceRoot) : allowedWorkspaceRoots[0];
            const { branch } = req.body || {};
            if (!branch || typeof branch !== 'string') {
                res.status(400).json({ error: 'Missing branch parameter' });
                return;
            }
            const cleanBranch = branch.trim().replace(/[^a-zA-Z0-9_\-\.\/]/g, '');
            exec(`git checkout "${cleanBranch}"`, { cwd: targetRoot }, (err, stdout, stderr) => {
                if (err) {
                    res.status(400).json({ error: stderr || err.message });
                    return;
                }
                res.json({ success: true, branch: cleanBranch, output: stdout });
            });
        } catch (err: any) {
            sendError(res, err);
        }
    });

    gitRouter.post('/clone', async (req: Request, res: Response) => {
        try {
            const { repoUrl, destinationDir, name } = req.body || {};
            if (!repoUrl || typeof repoUrl !== 'string') {
                res.status(400).json({ error: 'Missing repoUrl parameter' });
                return;
            }
            const cleanUrl = repoUrl.trim();
            if (!cleanUrl.startsWith('https://') && !cleanUrl.startsWith('git@')) {
                res.status(400).json({ error: 'Invalid repository URL protocol' });
                return;
            }

            const home = os.homedir();
            const devHome = path.join(home, 'dev');
            let targetDest: string;
            if (destinationDir && typeof destinationDir === 'string') {
                targetDest = path.resolve(destinationDir.replace(/^~(?=$|[\\/])/, home));
            } else {
                const repoName = name || cleanUrl.split('/').pop()?.replace(/\.git$/, '') || 'cloned-repo';
                targetDest = path.resolve(devHome, repoName);
            }

            const resolvedDest = assertWorkspaceRoot(targetDest, allowedWorkspaceRoots);
            if (!allowedWorkspaceRoots.includes(resolvedDest)) {
                allowedWorkspaceRoots.push(resolvedDest);
            }

            await fs.ensureDir(path.dirname(resolvedDest));

            exec(`git clone ${cleanUrl} "${resolvedDest}"`, { maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
                if (err) {
                    res.status(500).json({ error: stderr || err.message });
                    return;
                }
                res.json({
                    success: true,
                    path: resolvedDest,
                    output: stdout || stderr
                });
            });
        } catch (err: any) {
            sendError(res, err);
        }
    });

    app.use('/git', gitRouter);
    app.use('/workspace/git', gitRouter);

    // ==========================================
    // Native C++20 Astra 3D Engine Endpoints
    // ==========================================
    const cppRouter = express.Router();

    cppRouter.post('/compile', async (req: Request, res: Response) => {
        try {
            const { sourceCode, optimization, args, assets, geoAnchor, tileGlbBase64, tileAssetId } = req.body || {};
            if (!sourceCode || typeof sourceCode !== 'string') {
                res.status(400).json({ error: 'Missing "sourceCode" parameter' });
                return;
            }

            const stagedAssets: Array<{ name: string; content: string; encoding?: 'utf8' | 'base64' }> = [];

            if (Array.isArray(assets)) {
                stagedAssets.push(...assets);
            }

            if (geoAnchor) {
                stagedAssets.push({
                    name: 'geo_anchor.json',
                    content: JSON.stringify(geoAnchor, null, 2),
                    encoding: 'utf8'
                });
            }

            if (tileGlbBase64) {
                stagedAssets.push({
                    name: 'tile_payload.glb',
                    content: tileGlbBase64,
                    encoding: 'base64'
                });
            } else if (tileAssetId) {
                const cacheFile = path.resolve(process.cwd(), '.scratchbox/tiles_cache', `${tileAssetId}.glb`);
                if (fs.existsSync(cacheFile)) {
                    stagedAssets.push({
                        name: 'tile_payload.glb',
                        content: fs.readFileSync(cacheFile).toString('base64'),
                        encoding: 'base64'
                    });
                }
            }

            const compileRes = await cppCompiler.compileSource(sourceCode, {
                optimization: optimization || '-O3',
                assets: stagedAssets
            });

            if (!compileRes.success || !compileRes.binaryPath) {
                res.json({
                    success: false,
                    compilerOutput: compileRes.compilerOutput,
                    diagnostics: compileRes.diagnostics,
                    compilationTimeMs: compileRes.compilationTimeMs
                });
                return;
            }

            const execRes = await cppCompiler.executeBinary(compileRes.binaryPath, args || []);

            res.json({
                success: execRes.success,
                compilerOutput: compileRes.compilerOutput,
                diagnostics: compileRes.diagnostics,
                compilationTimeMs: compileRes.compilationTimeMs,
                executionTimeMs: execRes.executionTimeMs,
                glbBase64: execRes.glbBase64,
                glbPath: execRes.glbPath,
                chunks: execRes.chunks,
                stdout: execRes.stdout,
                stderr: execRes.stderr
            });
        } catch (err: any) {
            sendError(res, err);
        }
    });

    app.use('/3d', cppRouter);
    app.use('/compiler', cppRouter);

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
        } catch (err: any) {
            res.status(503).json({
                success: false,
                error: err?.message || 'Media capabilities unavailable'
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
        try {
            const workspaceRoot = requireWorkspaceRoot(req.query.workspaceRoot);
            const job = await mediaJobs.get(req.params.id, workspaceRoot);
            if (!job) {
                res.status(404).json({
                    success: false,
                    error: { code: 'invalid_request', message: 'Media job not found', retryable: false }
                });
                return;
            }
            res.json({ success: true, job });
        } catch (error) {
            if (isPathError(error)) {
                sendError(res, error);
                return;
            }
            const detail = classifyMediaGenerationError(error);
            res.status(500).json({ success: false, error: detail });
        }
    });

    mediaRouter.post('/jobs/:id/cancel', async (req: Request, res: Response) => {
        try {
            const workspaceRoot = requireWorkspaceRoot(req.body?.workspaceRoot);
            const job = await mediaJobs.cancel(req.params.id, workspaceRoot);
            res.json({ success: true, job });
        } catch (error) {
            if (isPathError(error)) {
                sendError(res, error);
                return;
            }
            const detail = classifyMediaGenerationError(error);
            res.status(400).json({ success: false, error: detail });
        }
    });

    mediaRouter.get('/jobs/:id/content', async (req: Request, res: Response) => {
        try {
            const workspaceRoot = requireWorkspaceRoot(req.query.workspaceRoot);
            const job = await mediaJobs.get(req.params.id, workspaceRoot);
            if (!job?.result?.asset || job.status !== 'completed') {
                res.status(404).json({
                    success: false,
                    error: { code: 'invalid_request', message: 'Completed media asset not found', retryable: false }
                });
                return;
            }
            // Asset paths are derived from stored job data; keep them inside the workspace regardless.
            const filePath = resolveWithinRoot(workspaceRoot, mediaAssets.resolve(workspaceRoot, job.result.asset));
            res.type(job.result.asset.mimeType);
            res.setHeader('Cache-Control', 'private, immutable, max-age=31536000');
            res.sendFile(filePath);
        } catch (error) {
            if (isPathError(error)) {
                sendError(res, error);
                return;
            }
            const detail = classifyMediaGenerationError(error);
            res.status(400).json({ success: false, error: detail });
        }
    });

    app.use('/media', mediaRouter);
    app.use('/gemini/media', mediaRouter);

    // ==========================================
    // 5. Headless Video Compositor Endpoints
    // ==========================================
    const videoRouter = express.Router();

    videoRouter.get('/capabilities', async (_req: Request, res: Response) => {
        const available = await videoCompositor.isFfmpegAvailable();
        res.json({
            success: true,
            ffmpegAvailable: available,
            features: {
                chromaKeying: true,
                despillSuppression: true,
                spatialTransform2D: true,
                opticalLightWrap: true,
                lutColorGrading: true,
                audioMix: true
            },
            supportedFormats: ['mp4', 'mov', 'webm', 'gif']
        });
    });

    videoRouter.post('/filtergraph', (req: Request, res: Response) => {
        try {
            const { timeline, resolution, customInputs } = req.body || {};
            if (!timeline) {
                res.status(400).json({ success: false, error: 'Missing timeline data' });
                return;
            }
            const graph = videoCompositor.buildFilterGraph(timeline, resolution, customInputs);
            res.json({ success: true, graph });
        } catch (err: any) {
            res.status(500).json({ success: false, error: err?.message || 'Filtergraph generation failed' });
        }
    });

    videoRouter.post('/composite', async (req: Request, res: Response) => {
        try {
            const { timeline, outputPath, workspaceRoot, resolution, format, crf, preset, dryRun, customInputs } = req.body || {};
            if (!timeline) {
                res.status(400).json({ success: false, error: 'Missing timeline data' });
                return;
            }
            if (!outputPath) {
                res.status(400).json({ success: false, error: 'Missing outputPath' });
                return;
            }

            let resolvedOutputPath = outputPath;
            if (workspaceRoot) {
                const safeRoot = requireWorkspaceRoot(workspaceRoot);
                resolvedOutputPath = resolveWithinRoot(safeRoot, outputPath);
            }

            const result = await videoCompositor.execute({
                timeline,
                outputPath: resolvedOutputPath,
                workspaceRoot,
                resolution,
                format,
                crf,
                preset,
                dryRun,
                customInputs
            });

            res.json(result);
        } catch (err: any) {
            if (isPathError(err)) {
                sendError(res, err);
                return;
            }
            res.status(500).json({ success: false, error: err?.message || 'Video compositing failed' });
        }
    });

    app.use('/video', videoRouter);
    app.use('/api/video', videoRouter);
    app.use('/media/video', videoRouter);

    // ==========================================
    // 6. 3D Photogrammetry & Tile Cleanup Pipeline (In-App / Cloud Run)
    // ==========================================
    const tileCleanupRouter = express.Router();

    tileCleanupRouter.get('/status', (_req: Request, res: Response) => {
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

    tileCleanupRouter.post('/cleanup', async (req: Request, res: Response) => {
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

    tileCleanupRouter.post('/cleanup-raw', async (req: Request, res: Response) => {
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

    app.use('/api/3d/tiles', tileCleanupRouter);
    app.use('/api/3d/cleanup-tiles', tileCleanupRouter);

    // ==========================================
    // Survey Synthesis API: station cameras for blockout render, AI Beautify, splat tiles.
    // Backs the Vector Dock "Survey Synthesis" panel (clay ingestion, rank, render, export).
    // ==========================================
    const surveyWorkspaceRoot = process.cwd();
    const surveyDeps = registerBeautifyHandlers({}, createGoogleStationImageGenerator({ mediaService: mediaGenerator, assetStore: mediaAssets, workspaceRoot: surveyWorkspaceRoot }), surveyWorkspaceRoot);
    const surveyApi = new SurveyApi({
        ...surveyDeps,
        workspaceRoot: surveyWorkspaceRoot,
        fetchClayGlb: async (query, options) => {
            const res = await getGoogle3DTilesClay(query as any, { ...(options || {}), outputDir: path.join(surveyWorkspaceRoot, 'public/tiles') });
            if (!res.success) throw new Error(res.error || 'Clay ingestion failed');
            const publicRootAbs = path.join(surveyWorkspaceRoot, 'public');
            const rel = path.relative(publicRootAbs, res.glbPath);
            const glbUrl = rel && !rel.startsWith('..') ? '/' + rel.split(path.sep).join('/') : undefined;
            return { glbPath: res.glbPath, glbUrl, mesh: res.mesh, geoAnchor: res.geoAnchor, resolvedAddress: res.resolvedAddress, quality: res.quality, mode: res.mode };
        }
    });
    app.use('/api/3d/survey', createSurveyRouter(express, surveyApi));

    // ==========================================
    // 6b. Mobile ARCore Geospatial Manifest Compiler
    // ==========================================
    const arRouter = express.Router();

    arRouter.post('/compile', async (req: Request, res: Response) => {
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

    app.use('/api/3d/ar', arRouter);

    // ==========================================
    // 6c. Depthbox 360 Omnidirectional Spatial Engine
    // ==========================================
    const depthbox360Router = express.Router();

    depthbox360Router.get('/presets', (_req: Request, res: Response) => {
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

    depthbox360Router.post('/generate', (req: Request, res: Response) => {
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

    depthbox360Router.post('/export-glb', (req: Request, res: Response) => {
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

    app.use('/api/3d-engine/depthbox-360', depthbox360Router);

    // Google 360 Panorama Pipeline: Seam Healing, Nadir Removal & Generation
    const panoramaRouter = express.Router();
    const panoramaService = new Google360PanoramaPipelineService(mediaCredentials);

    panoramaRouter.post('/heal-seam', async (req: Request, res: Response) => {
        try {
            const { inputImagePath, inputImageBase64, prompt, seamWidth, outputImagePath, mockExecution, model } = req.body || {};
            const inputBuffer = inputImageBase64 ? Buffer.from(inputImageBase64, 'base64') : undefined;

            const result = await panoramaService.healPanoramaSeam({
                inputImagePath,
                inputImageBuffer: inputBuffer,
                prompt,
                seamWidth,
                outputImagePath,
                mockExecution,
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

    panoramaRouter.post('/inpaint', async (req: Request, res: Response) => {
        try {
            const { inputImagePath, inputImageBase64, maskImagePath, maskImageBase64, nadirOnly, nadirRatio, prompt, outputImagePath, mockExecution, model } = req.body || {};
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
                mockExecution,
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

    panoramaRouter.post('/generate', async (req: Request, res: Response) => {
        try {
            const { prompt, style, width, height, healSeam, inpaintNadir, outputImagePath, mockExecution, model } = req.body || {};
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
                mockExecution,
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

    panoramaRouter.post('/upscale-16k', async (req: Request, res: Response) => {
        try {
            const { inputImagePath, inputImageBase64, engine, outputImagePath, mockExecution, seamWidth } = req.body || {};
            const inputBuffer = inputImageBase64 ? Buffer.from(inputImageBase64, 'base64') : undefined;

            const result = await panoramaService.upscalePanorama16K({
                inputImagePath,
                inputImageBuffer: inputBuffer,
                engine,
                outputImagePath,
                mockExecution,
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

    app.use('/api/panorama', panoramaRouter);

    // 3DGS Studio: Single Image, Related Images Group, and Video Trajectory Endpoints
    const splatStudioRouter = express.Router();

    splatStudioRouter.get('/sources', (_req: Request, res: Response) => {
        try {
            const catalog = ImageToSplatService.getPublicSourceCatalog();
            res.json({ success: true, catalog });
        } catch (err: any) {
            res.status(500).json({ success: false, error: err?.message || 'Failed to retrieve public sources catalog' });
        }
    });

    splatStudioRouter.post('/multiview-to-splat', (req: Request, res: Response) => {
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

    splatStudioRouter.post('/video-to-splat', (req: Request, res: Response) => {
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

    splatStudioRouter.post('/export-splat', (req: Request, res: Response) => {
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

    app.use('/api/3d-engine/splat-studio', splatStudioRouter);

    // ==========================================
    // 7. Standalone Vibe-Coded Tools & Micro-Studios Hub
    //    Export stays on the (token-protected) API; the HTML itself is served
    //    by the isolated tools origin (see createToolsServer) so a generated
    //    tool can never read the launch token or call the API as the user.
    // ==========================================
    const toolsRouter = express.Router();

    toolsRouter.post('/export', (req: Request, res: Response) => {
        const { toolId, title, html } = req.body || {};
        const id = typeof toolId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(toolId) ? toolId : `tool-${Date.now()}`;
        exportedToolsStore.set(id, {
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

    app.use('/api/tools', toolsRouter);

    // Trained Neural Models & 4DGS Avatars API
    const modelsRouter = express.Router();
    const modelRegistry = new TrainedModelRegistryService();

    modelsRouter.get('/', (_req: Request, res: Response) => {
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

    modelsRouter.get('/status', (_req: Request, res: Response) => {
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

    modelsRouter.get('/4danyone/demos', (_req: Request, res: Response) => {
        try {
            const demos = modelRegistry.getModelsByFamily('4danyone_4dgs');
            res.json({
                success: true,
                count: demos.length,
                demos
            });
        } catch (err: any) {
            res.status(500).json({ success: false, error: err?.message || String(err) });
        }
    });

    modelsRouter.get('/4danyone/demos/:id', (req: Request, res: Response) => {
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

    modelsRouter.get('/smplx', (_req: Request, res: Response) => {
        try {
            const models = modelRegistry.discoverSmplxModels();
            res.json({
                success: true,
                models
            });
        } catch (err: any) {
            res.status(500).json({ success: false, error: err?.message || String(err) });
        }
    });

    modelsRouter.get('/omniroam', (_req: Request, res: Response) => {
        try {
            const models = modelRegistry.discoverOmniRoamModels();
            res.json({
                success: true,
                models
            });
        } catch (err: any) {
            res.status(500).json({ success: false, error: err?.message || String(err) });
        }
    });

    modelsRouter.get('/geobox', (_req: Request, res: Response) => {
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

    app.use('/api/models', modelsRouter);

    const comfyRouter = express.Router();

    comfyRouter.get('/status', async (req: Request, res: Response) => {
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

    comfyRouter.get('/nodes', async (req: Request, res: Response) => {
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

    comfyRouter.post('/research', async (req: Request, res: Response) => {
        try {
            const { goal, hostUrl, mockExecution } = req.body;
            if (!goal) {
                res.status(400).json({ success: false, error: 'Goal is required.' });
                return;
            }
            const agent = new ComfyUiPipelineAgent({ hostUrl, mockExecution: mockExecution ?? true });
            const blueprint = await agent.researchPipeline(goal);
            const prompt = agent.authorApiPrompt(blueprint);
            const nodeGraphData = agent.convertToNodeGraphData(blueprint, prompt);
            res.json({ success: true, blueprint, prompt, nodeGraphData });
        } catch (err: any) {
            res.status(500).json({ success: false, error: err?.message || String(err) });
        }
    });

    comfyRouter.get('/cloudrun/status', async (req: Request, res: Response) => {
        try {
            const serviceUrl = typeof req.query.serviceUrl === 'string' ? req.query.serviceUrl : undefined;
            const mock = req.query.mockExecution === 'true' || req.query.mockExecution === undefined;
            const crService = new ComfyUiCloudRunService({ serviceUrl, mockExecution: mock });
            const status = await crService.getServiceStatus();
            res.json({ success: true, ...status });
        } catch (err: any) {
            res.status(500).json({ success: false, error: err?.message || String(err) });
        }
    });

    comfyRouter.get('/cloudrun/upstream', async (req: Request, res: Response) => {
        try {
            const serviceUrl = typeof req.query.serviceUrl === 'string' ? req.query.serviceUrl : undefined;
            const mock = req.query.mockExecution === 'true' || req.query.mockExecution === undefined;
            const crService = new ComfyUiCloudRunService({ serviceUrl, mockExecution: mock });
            const info = await crService.getUpstreamVersionInfo();
            res.json({ success: true, ...info });
        } catch (err: any) {
            res.status(500).json({ success: false, error: err?.message || String(err) });
        }
    });

    comfyRouter.post('/cloudrun/sync', async (req: Request, res: Response) => {
        try {
            const { serviceUrl, mockExecution } = req.body || {};
            const crService = new ComfyUiCloudRunService({ serviceUrl, mockExecution: mockExecution ?? true });
            const syncResult = await crService.syncUpstream();
            res.json({ ...syncResult, success: syncResult.success });
        } catch (err: any) {
            res.status(500).json({ success: false, error: err?.message || String(err) });
        }
    });

    comfyRouter.post('/cloudrun/inject-code', async (req: Request, res: Response) => {
        try {
            const { moduleName, code, nodeClasses, requirements, serviceUrl, mockExecution } = req.body || {};
            if (!moduleName || !code) {
                res.status(400).json({ success: false, error: 'moduleName and code are required.' });
                return;
            }
            const crService = new ComfyUiCloudRunService({ serviceUrl, mockExecution: mockExecution ?? true });
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

    comfyRouter.post('/workflow/prepare', async (req: Request, res: Response) => {
        try {
            const { workflow, dynamicCode, serviceUrl, mockExecution } = req.body || {};
            if (!workflow) {
                res.status(400).json({ success: false, error: 'workflow is required.' });
                return;
            }
            const crService = new ComfyUiCloudRunService({ serviceUrl, mockExecution: mockExecution ?? true });
            const report = await crService.prepareWorkflowDependencies(workflow, dynamicCode);
            res.json({ success: true, report });
        } catch (err: any) {
            res.status(500).json({ success: false, error: err?.message || String(err) });
        }
    });

    comfyRouter.post('/execute', async (req: Request, res: Response) => {
        try {
            const { goal, workflow, workflowJson, hostUrl, mockExecution, maxFixAttempts, targetEnvironment, cloudRun, autoSyncUpstream } = req.body;
            if (!goal && !workflow && !workflowJson) {
                res.status(400).json({ success: false, error: 'Goal or workflow is required.' });
                return;
            }
            const agent = new ComfyUiPipelineAgent({
                hostUrl,
                mockExecution: mockExecution ?? true,
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

    comfyRouter.post('/capabilities/resolve', async (req: Request, res: Response) => {
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
    });

    app.use('/api/comfyui', comfyRouter);

    app.post('/api/capabilities/resolve', async (req: Request, res: Response) => {
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
    });

    // SPA fallback for production browser mode (after all API routes).
    if (options.staticDir && fs.existsSync(options.staticDir)) {
        app.get('*', (req: Request, res: Response, next: NextFunction) => {
            if (PROTECTED_PREFIXES.some(prefix => req.path === prefix || req.path.startsWith(`${prefix}/`))) {
                next();
                return;
            }
            res.sendFile(path.join(options.staticDir!, 'index.html'));
        });
    }

    return app;
}

/** Content-Security-Policy applied to every exported tool document. */
export const TOOLS_CONTENT_SECURITY_POLICY =
    "sandbox allow-scripts; default-src 'self' https://cdn.tailwindcss.com https://esm.sh https://unpkg.com 'unsafe-inline' 'unsafe-eval'";

/**
 * Creates the isolated origin that serves exported vibe-coded tools.
 * Must be listened on a different port than the API (default 3002).
 */
export function createToolsServer(store: ExportedToolsStore): Express {
    const toolsApp = express();
    toolsApp.disable('x-powered-by');

    toolsApp.get('/:toolId', (req: Request, res: Response) => {
        const { toolId } = req.params;
        const tool = store.get(toolId);
        res.setHeader('Content-Security-Policy', TOOLS_CONTENT_SECURITY_POLICY);
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cache-Control', 'no-store');
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
        <p class="text-sm text-zinc-400 mb-6">The requested vibe-coded tool "${escapeHtml(toolId)}" was not found or has expired.</p>
    </div>
</body>
</html>`);
        }
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(tool.html);
    });

    return toolsApp;
}

function escapeHtml(value: string): string {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
