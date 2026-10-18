/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { Request, Response, Router } from 'express';
import { exec, execFile } from 'child_process';
import * as util from 'util';
import * as fs from 'fs-extra';
import * as path from 'path';

const execFileAsync = util.promisify(execFile);
import * as os from 'os';
import {
    assertWorkspaceRoot,
    PathTraversalError,
    resolveWithinRoot
} from '../../../packages/core/src/node/security/path-guard';
import { createEmptyProjectGraph } from '../../../packages/core/src/common';
import { ContainerSandboxService } from '../../../packages/core/src/node/container-sandbox-service';
import { DEFAULT_GEMINI_MODEL } from '../../../packages/core/src/node/gemini/gemini-client';
import {
    WorkspaceConfigService,
    ChatSessionStore,
    ProjectArtifactStore,
    WorkspaceFileWatcherService,
    CodebaseLensSyncService
} from '../../../packages/core/src/node';
import { RouteContext } from './types';

export interface WorkspaceRouterServices {
    workspaceService: WorkspaceConfigService;
    artifactStore: ProjectArtifactStore;
    fileWatcher: WorkspaceFileWatcherService;
    lensSyncService: CodebaseLensSyncService;
}

export function createWorkspaceRouter(services: WorkspaceRouterServices, ctx: RouteContext): Router {
    const { workspaceService, artifactStore, fileWatcher } = services;
    const { allowedWorkspaceRoots, requireWorkspaceRoot, sendError } = ctx;

    const router = Router();
    const resolveWorkspaceRoot = (req: Request): string | undefined =>
        (req.query?.root as string) || (req.query?.workspaceRoot as string) || (req.body?.workspaceRoot as string) || undefined;

    router.get('/config', async (req: Request, res: Response) => {
        try {
            const root = requireWorkspaceRoot(req.query.root);
            const config = await workspaceService.loadFullWorkspaceConfig(root);
            res.json(config);
        } catch (err: any) {
            sendError(res, err);
        }
    });

    // Chat sessions on disk (<workspace>/.scratchbox/sessions) and the recent-project list.
    const sessionStore = new ChatSessionStore();

    router.get('/sessions', async (req: Request, res: Response) => {
        try {
            res.json({ sessions: await sessionStore.list(requireWorkspaceRoot(req.query.root)) });
        } catch (err: any) {
            sendError(res, err);
        }
    });

    router.put('/sessions/:id', async (req: Request, res: Response) => {
        try {
            const { workspaceRoot, session } = req.body || {};
            if (!session || session.id !== req.params.id) {
                res.status(400).json({ success: false, error: 'body.session.id must match the URL' });
                return;
            }
            const stored = await sessionStore.save(requireWorkspaceRoot(workspaceRoot), session);
            res.json({ success: true, savedAt: stored.savedAt });
        } catch (err: any) {
            sendError(res, err);
        }
    });

    router.delete('/sessions/:id', async (req: Request, res: Response) => {
        try {
            await sessionStore.remove(requireWorkspaceRoot(req.query.root), req.params.id);
            res.json({ success: true });
        } catch (err: any) {
            sendError(res, err);
        }
    });

    router.get('/projects', async (_req: Request, res: Response) => {
        try {
            res.json({ projects: await sessionStore.listProjects() });
        } catch (err: any) {
            sendError(res, err);
        }
    });

    router.put('/projects', async (req: Request, res: Response) => {
        try {
            const projects = Array.isArray(req.body?.projects) ? req.body.projects : [];
            await sessionStore.saveProjects(projects);
            res.json({ success: true });
        } catch (err: any) {
            sendError(res, err);
        }
    });

    router.post('/config', async (req: Request, res: Response) => {
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

    router.post('/sync-artifact', async (req: Request, res: Response) => {
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

    router.post('/write-lens-files', async (req: Request, res: Response) => {
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

    router.post('/register-hash', (req: Request, res: Response) => {
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

    router.post('/import-mcp', async (req: Request, res: Response) => {
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

    router.get('/project-artifacts', async (req: Request, res: Response) => {
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

    router.post('/project-artifacts', async (req: Request, res: Response) => {
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

    router.post('/create', async (req: Request, res: Response) => {
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
                    defaultModel: DEFAULT_GEMINI_MODEL,
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

    router.get('/events/file-change', (req: Request, res: Response) => {
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

    /**
     * @terminal: runs one command in the workspace sandbox (the same process jail, command policy and scrubbed
     * environment as the agent's workspace_run_command) and returns its real stdout, stderr and exit code. A command
     * the policy refuses comes back as an error, not as empty output.
     */
    const commandSandbox = new ContainerSandboxService();
    router.post('/run-command', async (req: Request, res: Response) => {
        const command = typeof req.body?.command === 'string' ? req.body.command.trim() : '';
        if (!command) {
            res.status(400).json({ success: false, error: 'command is required' });
            return;
        }
        const envId = `terminal-mention-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        try {
            const workspaceRoot = resolveWorkspaceRoot(req);
            const targetRoot = workspaceRoot ? requireWorkspaceRoot(workspaceRoot) : allowedWorkspaceRoots[0];
            const timeoutMs = Math.min(Math.max(Number(req.body?.timeoutMs) || 30000, 1000), 120000);
            await commandSandbox.createEnvironment({ environmentId: envId, isolationLevel: 'process-jail', workspaceRoot: targetRoot, timeoutMs });
            const result = await commandSandbox.executeCommand(envId, { command, cwd: targetRoot, timeoutMs });
            res.json({ success: true, command, cwd: targetRoot, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, timedOut: result.timedOut, durationMs: result.durationMs });
        } catch (err: any) {
            res.status(err?.code === 'command_not_allowed' || err?.code === 'path_traversal' ? 403 : 500)
                .json({ success: false, command, error: err?.message || String(err), code: err?.code });
        } finally {
            await commandSandbox.destroyEnvironment(envId).catch(() => false);
        }
    });

    router.get(['/files', '/tree'], async (req: Request, res: Response) => {
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

    router.get(['/file-content', '/file'], async (req: Request, res: Response) => {
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

    router.post(['/file-content', '/file'], async (req: Request, res: Response) => {
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

    router.post('/create-file', async (req: Request, res: Response) => {
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

    router.get('/external-mcp', async (_req: Request, res: Response) => {
        try {
            const sources = await workspaceService.discoverExternalMcpConfigs();
            res.json(sources);
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });

    return router;
}

export function createGitRouter(ctx: RouteContext): Router {
    const { allowedWorkspaceRoots, requireWorkspaceRoot, sendError } = ctx;
    const router = Router();
    const resolveWorkspaceRoot = (req: Request): string | undefined =>
        (req.query?.root as string) || (req.query?.workspaceRoot as string) || (req.body?.workspaceRoot as string) || undefined;

    const runGit = (args: string[], cwd: string, options: { maxBuffer?: number } = {}) => {
        const env = {
            ...process.env,
            GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL || '/dev/null',
            GIT_CONFIG_NOSYSTEM: '1'
        };
        return execFileAsync('git', args, {
            cwd,
            env,
            maxBuffer: options.maxBuffer || 50 * 1024 * 1024
        });
    };

    router.get('/branches', async (req: Request, res: Response) => {
        try {
            const workspaceRoot = resolveWorkspaceRoot(req);
            const targetRoot = workspaceRoot ? requireWorkspaceRoot(workspaceRoot) : allowedWorkspaceRoots[0];
            try {
                const { stdout } = await runGit(['branch', '-a'], targetRoot);
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
            } catch {
                res.json({ success: true, current: 'main', branches: ['main'] });
            }
        } catch (err: any) {
            sendError(res, err);
        }
    });

    router.get('/status', async (req: Request, res: Response) => {
        try {
            const workspaceRoot = resolveWorkspaceRoot(req);
            const targetRoot = workspaceRoot ? requireWorkspaceRoot(workspaceRoot) : allowedWorkspaceRoots[0];

            // One git call: porcelain v2 with --branch carries the branch header and every entry.
            const { stdout } = await runGit(['status', '--porcelain=v2', '--branch', '-u'], targetRoot);
            const parsed = parsePorcelainV2Status(stdout);
            const currentBranch = parsed.branch;
            const { staged, unstaged, untracked } = parsed;

            res.json({
                success: true,
                branch: currentBranch,
                clean: staged.length === 0 && unstaged.length === 0 && untracked.length === 0,
                staged,
                unstaged,
                untracked
            });
        } catch (err: any) {
            sendError(res, err);
        }
    });

    router.get('/diff', async (req: Request, res: Response) => {
        try {
            const workspaceRoot = resolveWorkspaceRoot(req);
            const targetRoot = workspaceRoot ? requireWorkspaceRoot(workspaceRoot) : allowedWorkspaceRoots[0];
            const cached = req.query.cached === 'true' || req.query.staged === 'true';
            const file = typeof req.query.file === 'string' ? req.query.file.trim() : undefined;
            const commit = typeof req.query.commit === 'string' ? req.query.commit.trim() : undefined;

            const gitArgs = ['diff'];
            if (cached) {
                gitArgs.push('--cached');
            }
            if (commit) {
                const cleanCommit = commit.replace(/[^a-zA-Z0-9_\-.~^]/g, '');
                // A leading '-' would be parsed by git as an option (e.g. --output, --ext-diff).
                if (cleanCommit.startsWith('-')) {
                    res.status(400).json({ error: 'Invalid commit parameter' });
                    return;
                }
                if (cleanCommit) gitArgs.push(cleanCommit);
            }
            if (file) {
                const safeFile = resolveWithinRoot(targetRoot, file);
                const relFile = path.relative(targetRoot, safeFile);
                gitArgs.push('--', relFile);
            }

            const { stdout: diffOutput } = await runGit(gitArgs, targetRoot);

            const changedFiles: string[] = [];
            let additions = 0;
            let deletions = 0;
            const lines = diffOutput.split('\n');

            for (const line of lines) {
                if (line.startsWith('diff --git a/')) {
                    const match = line.match(/^diff --git a\/(.*?) b\/(.*?)$/);
                    if (match) {
                        changedFiles.push(match[2]);
                    }
                } else if (line.startsWith('+') && !line.startsWith('+++')) {
                    additions++;
                } else if (line.startsWith('-') && !line.startsWith('---')) {
                    deletions++;
                }
            }

            res.json({
                success: true,
                cached,
                changedFiles,
                stats: { additions, deletions, totalChanges: additions + deletions },
                rawDiff: diffOutput
            });
        } catch (err: any) {
            sendError(res, err);
        }
    });

    router.post('/stage', async (req: Request, res: Response) => {
        try {
            const workspaceRoot = resolveWorkspaceRoot(req);
            const targetRoot = workspaceRoot ? requireWorkspaceRoot(workspaceRoot) : allowedWorkspaceRoots[0];
            const { files, file, all } = req.body || {};

            const requestedFiles: string[] = Array.isArray(files) ? files : (typeof file === 'string' && file ? [file] : []);

            if (all === true || (requestedFiles.length === 0 && !files && !file)) {
                await runGit(['add', '-A'], targetRoot);
                res.json({ success: true, stagedAll: true });
                return;
            }

            if (requestedFiles.length === 0) {
                res.status(400).json({ error: 'files must be a non-empty array of file paths or specify all: true' });
                return;
            }

            const existingRelPaths: string[] = [];
            const missingRelPaths: string[] = [];
            for (const f of requestedFiles) {
                const safeAbs = resolveWithinRoot(targetRoot, String(f));
                const rel = path.relative(targetRoot, safeAbs);
                if (fs.existsSync(safeAbs)) {
                    existingRelPaths.push(rel);
                } else {
                    missingRelPaths.push(rel);
                }
            }

            if (existingRelPaths.length > 0) {
                await runGit(['add', '--', ...existingRelPaths], targetRoot);
            }
            if (missingRelPaths.length > 0) {
                try {
                    await runGit(['rm', '--cached', '--ignore-unmatch', '--', ...missingRelPaths], targetRoot);
                } catch {
                    // Ignore unmatch
                }
            }
            res.json({ success: true, staged: existingRelPaths, removed: missingRelPaths });
        } catch (err: any) {
            sendError(res, err);
        }
    });

    router.post('/unstage', async (req: Request, res: Response) => {
        try {
            const workspaceRoot = resolveWorkspaceRoot(req);
            const targetRoot = workspaceRoot ? requireWorkspaceRoot(workspaceRoot) : allowedWorkspaceRoots[0];
            const { files, file, all } = req.body || {};

            const requestedFiles: string[] = Array.isArray(files) ? files : (typeof file === 'string' && file ? [file] : []);

            if (all === true || (requestedFiles.length === 0 && !files && !file)) {
                await runGit(['reset', 'HEAD'], targetRoot);
                res.json({ success: true, unstagedAll: true });
                return;
            }

            if (requestedFiles.length === 0) {
                res.status(400).json({ error: 'files must be a non-empty array of file paths or specify all: true' });
                return;
            }

            const safeRelPaths = requestedFiles.map((f: string) => {
                const safeAbs = resolveWithinRoot(targetRoot, String(f));
                return path.relative(targetRoot, safeAbs);
            });

            await runGit(['reset', 'HEAD', '--', ...safeRelPaths], targetRoot);
            res.json({ success: true, unstaged: safeRelPaths });
        } catch (err: any) {
            sendError(res, err);
        }
    });

    router.post('/commit', async (req: Request, res: Response) => {
        try {
            const workspaceRoot = resolveWorkspaceRoot(req);
            const targetRoot = workspaceRoot ? requireWorkspaceRoot(workspaceRoot) : allowedWorkspaceRoots[0];
            const { message } = req.body || {};

            if (!message || typeof message !== 'string' || !message.trim()) {
                res.status(400).json({ error: 'Commit message is required' });
                return;
            }

            const { stdout } = await runGit(['commit', '-m', message.trim()], targetRoot);
            res.json({ success: true, output: stdout });
        } catch (err: any) {
            sendError(res, err);
        }
    });

    router.post('/checkout', async (req: Request, res: Response) => {
        try {
            const workspaceRoot = resolveWorkspaceRoot(req);
            const targetRoot = workspaceRoot ? requireWorkspaceRoot(workspaceRoot) : allowedWorkspaceRoots[0];
            const { branch } = req.body || {};
            if (!branch || typeof branch !== 'string') {
                res.status(400).json({ error: 'Missing branch parameter' });
                return;
            }
            const cleanBranch = branch.trim().replace(/[^a-zA-Z0-9_\-\.\/]/g, '');
            // Reject option-like or empty names so git never parses the value as a flag.
            if (!cleanBranch || cleanBranch.startsWith('-')) {
                res.status(400).json({ error: 'Invalid branch parameter' });
                return;
            }
            // Trailing '--' forces git to treat cleanBranch as a revision, never a pathspec/option.
            const { stdout } = await runGit(['checkout', cleanBranch, '--'], targetRoot);
            res.json({ success: true, branch: cleanBranch, output: stdout });
        } catch (err: any) {
            sendError(res, err);
        }
    });

    router.post('/clone', async (req: Request, res: Response) => {
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

            const { stdout, stderr } = await runGit(['clone', '--', cleanUrl, resolvedDest], path.dirname(resolvedDest));
            res.json({
                success: true,
                path: resolvedDest,
                output: stdout || stderr
            });
        } catch (err: any) {
            sendError(res, err);
        }
    });

    return router;
}

/**
 * `git status --porcelain=v2 --branch -u` as the /status route reports it: the branch ('HEAD' when detached, as
 * `rev-parse --abbrev-ref` says; 'main' when git names none), index (X) and work-tree (Y) changes with their v1
 * status letters, renames as "orig -> path" (the v1 spelling), and untracked paths.
 */
export function parsePorcelainV2Status(stdout: string): {
    branch: string;
    staged: Array<{ path: string; status: string }>;
    unstaged: Array<{ path: string; status: string }>;
    untracked: string[];
} {
    let branch = 'main';
    const staged: Array<{ path: string; status: string }> = [];
    const unstaged: Array<{ path: string; status: string }> = [];
    const untracked: string[] = [];
    // Field counts before the path: ordinary "1 XY sub mH mI mW hH hI", rename "2 ... X<score>", unmerged "u ... h3".
    const fieldsBeforePath: Record<string, number> = { '1': 8, '2': 9, u: 10 };
    for (const line of stdout.split('\n')) {
        if (!line) continue;
        if (line.startsWith('# branch.head ')) {
            const head = line.slice('# branch.head '.length).trim();
            branch = head === '(detached)' ? 'HEAD' : head || 'main';
            continue;
        }
        if (line.startsWith('#')) continue;
        if (line.startsWith('? ')) { untracked.push(line.slice(2)); continue; }
        const n = fieldsBeforePath[line[0]];
        if (n === undefined) continue;
        let at = 0;
        for (let k = 0; k < n && at >= 0; k++) at = line.indexOf(' ', at) + 1 || -1;
        if (at <= 0) continue;
        let filePath = line.slice(at);
        if (line[0] === '2') {
            const [to, from] = filePath.split('\t');
            filePath = from !== undefined ? `${from} -> ${to}` : to;
        }
        const x = line[2] === '.' ? ' ' : line[2];
        const y = line[3] === '.' ? ' ' : line[3];
        if (x !== ' ') staged.push({ path: filePath, status: x });
        if (y !== ' ') unstaged.push({ path: filePath, status: y });
    }
    return { branch, staged, unstaged, untracked };
}
