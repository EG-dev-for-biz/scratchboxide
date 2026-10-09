/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import express, { Express, NextFunction, Request, Response } from 'express';
import bodyParser from 'body-parser';
import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs-extra';
import { assertWorkspaceRoot, PathTraversalError } from '../../packages/core/src/node/security/path-guard';
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
    SurveyApi,
    createSurveyRouter,
    createMatchmoveRouter,
    registerBeautifyHandlers,
    createGoogleStationImageGenerator,
    getGoogle3DTilesClay
} from '../../packages/core/src/node';

import { isPathError, RouteContext } from './routes/types';
import { createBrowserRouter } from './routes/browserRoutes';
import { createGeminiRouter } from './routes/geminiRoutes';
import { createMemoriesRouter } from './routes/memoriesRoutes';
import { createWorkspaceRouter, createGitRouter } from './routes/workspaceRoutes';
import { createCppRouter } from './routes/cppRoutes';
import { createMediaRouter, createVideoRouter } from './routes/mediaVideoRoutes';
import {
    createTileCleanupRouter,
    createPbrRouter,
    createArRouter,
    createDepthbox360Router,
    createPanoramaRouter,
    createSplatStudioRouter
} from './routes/spatialRoutes';
import {
    createToolsRouter,
    createModelsRouter,
    createPerformerRouter,
    createComfyRouter,
    handleCapabilitiesResolve,
    ExportedToolsStore,
    ExportedToolRecord
} from './routes/aiModelsRoutes';

export interface StandaloneServerOptions {
    port?: number;
    staticDir?: string;
    /** Port the isolated tools origin listens on; used to build export URLs. Defaults to `SCRATCHBOX_TOOLS_PORT` or 3002. */
    toolsPort?: number;
    /** Host the tools origin is reachable at from the renderer. Defaults to 127.0.0.1. */
    toolsHost?: string;
}

export type ExportedTool = ExportedToolRecord;
export type { ExportedToolsStore };

/** Environment variables the server is allowed to hydrate from secrets files. */
export const SERVER_SECRET_ALLOWLIST = [
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'GOOGLE_AI_API_KEY',
    'GOOGLE_CLOUD_API_KEY',
    'GOOGLE_MAPS_API_KEY',
    'MAP_TILES_API_KEY',
    'GOOGLE_SEARCH_ENGINE_ID',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GOOGLE_CLOUD_PROJECT',
    'GOOGLE_CLOUD_LOCATION',
    'GOOGLE_SERVICE_ACCOUNT_JSON',
    'GOOGLE_OAUTH_CLIENT_ID'
];

/** Origins allowed to call the API when an Origin header is present. */
export function resolveAllowedOrigins(): Set<string> {
    const origins = new Set<string>([
        'http://127.0.0.1:3000',
        'http://localhost:3000',
        'http://127.0.0.1:3030',
        'http://localhost:3030'
    ]);
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

    // Default to the service-account file at ~/.scratchbox/service-account.json or repo-root
    const saCandidates = [
        process.env.GOOGLE_APPLICATION_CREDENTIALS,
        path.join(os.homedir(), '.scratchbox', 'service-account.json'),
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
    { method: 'GET', path: '/api/models/status' },
    { method: 'GET', path: '/api/auth/token' }
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

function createLaunchTokenMiddleware(token: string, allowedOrigins: Set<string>) {
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

        // In dev mode, permit requests from allowed origins (e.g. Vite dev server on :3030)
        const origin = req.headers.origin;
        if (process.env.NODE_ENV !== 'production' && typeof origin === 'string' && allowedOrigins.has(origin)) {
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
    const publicRoot = path.resolve(process.cwd(), 'public');
    if (fs.existsSync(publicRoot)) {
        app.use(express.static(publicRoot));
        const demosShowcase = path.join(publicRoot, 'demos', 'showcase');
        if (fs.existsSync(demosShowcase)) {
            app.use(express.static(demosShowcase));
        }
        const demosExperiments = path.join(publicRoot, 'demos', 'experiments');
        if (fs.existsSync(demosExperiments)) {
            app.use(express.static(demosExperiments));
        }
    }
    const repoPublicRoot = path.resolve(process.cwd(), '..', 'public');
    if (fs.existsSync(repoPublicRoot)) {
        app.use(express.static(repoPublicRoot));
        const demosShowcase = path.join(repoPublicRoot, 'demos', 'showcase');
        if (fs.existsSync(demosShowcase)) {
            app.use(express.static(demosShowcase));
        }
        const demosExperiments = path.join(repoPublicRoot, 'demos', 'experiments');
        if (fs.existsSync(demosExperiments)) {
            app.use(express.static(demosExperiments));
        }
    }

    const build3dPython = path.resolve(process.cwd(), 'build', '3d-python');
    const repoBuild3dPython = path.resolve(process.cwd(), '..', 'build', '3d-python');
    if (fs.existsSync(build3dPython)) {
        app.use('/build/3d-python', express.static(build3dPython));
    }
    if (fs.existsSync(repoBuild3dPython)) {
        app.use('/build/3d-python', express.static(repoBuild3dPython));
    }

    // Trigger asynchronous background asset hydration for showcase demos
    const hydratorScript = path.resolve(process.cwd(), 'scripts', 'hydrate_demo_assets.cjs');
    if (fs.existsSync(hydratorScript)) {
        try {
            const { fork } = require('child_process');
            fork(hydratorScript, ['--quiet'], { stdio: 'ignore' });
        } catch {}
    }

    app.use(createLaunchTokenMiddleware(launchToken, allowedOrigins));
    app.use(bodyParser.json({ limit: '50mb' }));
    app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));

    app.get('/health', (_req: Request, res: Response) => {
        res.json({ ok: true, service: 'scratchbox-api', timestamp: Date.now() });
    });

    app.get('/api/auth/token', (req: Request, res: Response) => {
        const origin = req.headers.origin;
        if (origin && !allowedOrigins.has(origin)) {
            res.status(403).json({ error: 'forbidden', message: 'Origin not allowed' });
            return;
        }
        res.json({ success: true, token: launchToken });
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

    const routeContext: RouteContext = {
        allowedWorkspaceRoots,
        requireWorkspaceRoot,
        sendError,
        isPathError
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

    // 1. Browser Proxy Gateway Endpoints
    app.use('/api/browser', createBrowserRouter(browserProxy));

    // 2. Gemini GenAI & Agent Endpoints
    app.use('/gemini', createGeminiRouter({
        geminiService,
        mediaCredentials,
        deepWriteService,
        longRunningAgentService,
        subagentPoolService,
        memoriesService,
        contextGraphService,
        lspFeedbackService,
        mediaJobs
    }, routeContext));
    app.use('/memories', createMemoriesRouter(memoriesService, routeContext));

    // 3. Workspace & Git Endpoints
    const workspaceRouter = createWorkspaceRouter({
        workspaceService,
        artifactStore,
        fileWatcher,
        lensSyncService
    }, routeContext);
    app.use('/workspace', workspaceRouter);

    const gitRouter = createGitRouter(routeContext);
    app.use('/git', gitRouter);
    app.use('/workspace/git', gitRouter);

    // 4. Native C++20 Astro 3D Engine Endpoints
    const cppRouter = createCppRouter(cppCompiler, routeContext);
    app.use('/3d', cppRouter);
    app.use('/compiler', cppRouter);

    // 5. Media & Video Compositor Endpoints
    const mediaRouter = createMediaRouter({
        mediaGenerator,
        mediaJobs,
        mediaAssets
    }, routeContext);
    app.use('/media', mediaRouter);
    app.use('/gemini/media', mediaRouter);

    const videoRouter = createVideoRouter(videoCompositor, routeContext);
    app.use('/video', videoRouter);
    app.use('/api/video', videoRouter);
    app.use('/media/video', videoRouter);

    // 6. 3D Photogrammetry, Tiles, PBR, Survey & Matchmove
    app.use('/api/3d/tiles', createTileCleanupRouter(tileCleanupService));
    app.use('/api/3d/cleanup-tiles', createTileCleanupRouter(tileCleanupService));
    app.use('/api/3d/pbr', createPbrRouter());

    // Survey Synthesis API
    const surveyWorkspaceRoot = process.cwd();
    const surveyDeps = registerBeautifyHandlers(
        {},
        createGoogleStationImageGenerator({ mediaService: mediaGenerator, assetStore: mediaAssets, workspaceRoot: surveyWorkspaceRoot }),
        surveyWorkspaceRoot
    );
    const surveyApi = new SurveyApi({
        ...surveyDeps,
        workspaceRoot: surveyWorkspaceRoot,
        fetchClayGlb: async (query, options) => {
            const res = await getGoogle3DTilesClay(query as any, { ...(options || {}), outputDir: path.join(surveyWorkspaceRoot, 'public/tiles') });
            if (!res.success) throw new Error(res.error || 'Clay ingestion failed');
            const publicRootAbs = path.join(surveyWorkspaceRoot, 'public');
            const rel = path.relative(publicRootAbs, res.glbPath || '');
            return {
                glbPath: res.glbPath || '',
                glbUrl: rel && !rel.startsWith('..') ? `/${rel}` : undefined,
                triangleCount: res.mesh?.triangleCount,
                vertexCount: res.mesh?.vertexCount,
            };
        },
    });
    app.use('/api/3d/survey', createSurveyRouter(express, surveyApi));

    const matchmoveRouter = createMatchmoveRouter(express);
    app.use('/api/spatial/matchmove', matchmoveRouter);
    app.use('/api/matchmove', matchmoveRouter);

    app.use('/api/3d/ar', createArRouter());
    app.use('/api/3d-engine/depthbox-360', createDepthbox360Router());
    app.use('/api/panorama', createPanoramaRouter(mediaCredentials));
    app.use('/api/3d-engine/splat-studio', createSplatStudioRouter());

    // 7. Standalone Tools, Models, 4D Performer, ComfyUI & Capabilities
    app.use('/api/tools', createToolsRouter(exportedToolsStore, toolsHost, toolsPort));
    app.use('/api/models', createModelsRouter());
    app.use('/api/performer/pipeline', createPerformerRouter(allowedWorkspaceRoots));
    app.use('/api/models/performer/pipeline', createPerformerRouter(allowedWorkspaceRoots));
    app.use('/api/comfyui', createComfyRouter());
    app.post('/api/capabilities/resolve', handleCapabilitiesResolve);

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
