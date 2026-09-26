/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { Request, Response, Router } from 'express';
import { exec } from 'child_process';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import {
    assertWorkspaceRoot,
    PathTraversalError,
    resolveWithinRoot
} from '../../../packages/core/src/node/security/path-guard';
import { createEmptyProjectGraph } from '../../../packages/core/src/common';
import {
    WorkspaceConfigService,
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

    router.get('/branches', async (req: Request, res: Response) => {
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

    return router;
}
