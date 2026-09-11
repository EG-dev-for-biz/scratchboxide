/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { inject, injectable, optional } from '@theia/core/shared/inversify';
import { BackendApplicationContribution } from '@theia/core/lib/node/backend-application';
import { Application, Router, Request, Response } from '@theia/core/shared/express';
import { json } from 'body-parser';
import { ILogger } from '@theia/core/lib/common';
import { WorkspaceConfigService } from './workspace-config-service';
import { WorkspaceFileWatcherService } from './workspace-file-watcher-service';
import { CanvasArtifact } from '../browser/generative-canvas/canvas-types';
import { ProjectArtifactStore } from './project-artifact-store';
import { ProjectArtifactGraph, createEmptyProjectGraph } from '../common/project-artifact-graph-protocol';

@injectable()
export class WorkspaceEndpoint implements BackendApplicationContribution {
    protected static PATH = '/workspace';

    @inject(ILogger)
    protected readonly logger: ILogger;

    @inject(WorkspaceConfigService)
    protected readonly workspaceConfigService: WorkspaceConfigService;

    @inject(WorkspaceFileWatcherService) @optional()
    protected readonly workspaceFileWatcherService?: WorkspaceFileWatcherService;

    @inject(ProjectArtifactStore)
    protected readonly projectArtifactStore: ProjectArtifactStore;

    configure(app: Application): void {
        const router = Router();

        router.get('/config', (req, res) => this.handleGetConfig(req, res));
        router.post('/config', (req, res) => this.handleSaveConfig(req, res));
        router.post('/sync-artifact', (req, res) => this.handleSyncArtifact(req, res));
        router.post('/write-lens-files', (req, res) => this.handleWriteLensFiles(req, res));
        router.post('/register-hash', (req, res) => this.handleRegisterHash(req, res));
        router.get('/external-mcp', (req, res) => this.handleDiscoverExternalMcp(req, res));
        router.get('/external-mcp-configs', (req, res) => this.handleDiscoverExternalMcp(req, res));
        router.post('/import-mcp', (req, res) => this.handleImportExternalMcp(req, res));
        router.get('/events/file-change', (req, res) => this.handleFileChangeEvents(req, res));
        router.get('/project-artifacts', (req, res) => this.handleGetProjectArtifacts(req, res));
        router.post('/project-artifacts', (req, res) => this.handleSaveProjectArtifacts(req, res));

        app.use(json({ limit: '10mb' }));
        app.use(WorkspaceEndpoint.PATH, router);
    }

    private async handleGetProjectArtifacts(req: Request, res: Response): Promise<void> {
        try {
            const workspaceRoot = (req.query.root as string) || process.cwd();
            const projectId = (req.query.projectId as string) || 'default-project';
            const graph = await this.projectArtifactStore.load(workspaceRoot, projectId)
                || createEmptyProjectGraph(projectId);
            res.json(graph);
        } catch (err: any) {
            this.logger.error(`Failed to load project artifact graph: ${err.message}`, err);
            res.status(500).json({ error: err.message || 'Failed to load project artifact graph' });
        }
    }

    private async handleSaveProjectArtifacts(req: Request, res: Response): Promise<void> {
        try {
            const { workspaceRoot, graph } = req.body || {} as {
                workspaceRoot?: string;
                graph?: ProjectArtifactGraph;
            };
            if (!graph?.project?.id) {
                res.status(400).json({ error: 'Missing project artifact graph' });
                return;
            }
            await this.projectArtifactStore.save(workspaceRoot || process.cwd(), graph);
            res.json({ success: true });
        } catch (err: any) {
            this.logger.error(`Failed to save project artifact graph: ${err.message}`, err);
            res.status(500).json({ error: err.message || 'Failed to save project artifact graph' });
        }
    }

    private async handleGetConfig(req: Request, res: Response): Promise<void> {
        try {
            const workspaceRoot = (req.query.root as string) || process.cwd();
            const config = await this.workspaceConfigService.loadFullWorkspaceConfig(workspaceRoot);
            res.json(config);
        } catch (err: any) {
            this.logger.error(`Failed to get workspace config: ${err.message}`, err);
            res.status(500).json({ error: err.message || 'Failed to load workspace config' });
        }
    }

    private async handleSaveConfig(req: Request, res: Response): Promise<void> {
        try {
            const { workspaceRoot, settings, customSkills, customMcpServers } = req.body || {};
            const root = workspaceRoot || process.cwd();
            await this.workspaceConfigService.saveWorkspaceConfig(root, {
                settings,
                customSkills,
                customMcpServers
            });
            res.json({ success: true, message: 'Workspace configuration saved successfully' });
        } catch (err: any) {
            this.logger.error(`Failed to save workspace config: ${err.message}`, err);
            res.status(500).json({ error: err.message || 'Failed to save workspace config' });
        }
    }

    private async handleSyncArtifact(req: Request, res: Response): Promise<void> {
        try {
            const { workspaceRoot, artifact, targetSubdir } = req.body || {};
            if (!artifact || !artifact.type) {
                res.status(400).json({ error: 'Missing artifact payload' });
                return;
            }

            const root = workspaceRoot || process.cwd();
            const result = await this.workspaceConfigService.syncArtifactToWorkspace(
                root,
                artifact as CanvasArtifact,
                targetSubdir
            );

            res.json(result);
        } catch (err: any) {
            this.logger.error(`Failed to sync artifact to workspace: ${err.message}`, err);
            res.status(500).json({ error: err.message || 'Failed to sync artifact' });
        }
    }

    private async handleWriteLensFiles(req: Request, res: Response): Promise<void> {
        try {
            const { workspaceRoot, files } = req.body || {};
            if (!files || typeof files !== 'object') {
                res.status(400).json({ error: 'Missing files payload' });
                return;
            }

            const root = workspaceRoot || process.cwd();
            const result = await this.workspaceConfigService.writeLensFiles(
                root,
                files,
                this.workspaceFileWatcherService
            );

            res.json(result);
        } catch (err: any) {
            this.logger.error(`Failed to write lens files: ${err.message}`, err);
            res.status(500).json({ error: err.message || 'Failed to write lens files' });
        }
    }

    private async handleRegisterHash(req: Request, res: Response): Promise<void> {
        try {
            const { filePath, hash } = req.body || {};
            if (filePath && hash && this.workspaceFileWatcherService) {
                this.workspaceFileWatcherService.registerKnownHash(filePath, hash);
            }
            res.json({ success: true });
        } catch (err: any) {
            res.status(500).json({ error: err.message || 'Failed to register hash' });
        }
    }

    private async handleDiscoverExternalMcp(_req: Request, res: Response): Promise<void> {
        try {
            const sources = await this.workspaceConfigService.discoverExternalMcpConfigs();
            res.json({ success: true, sources });
        } catch (err: any) {
            this.logger.error(`Failed to discover external MCP configs: ${err.message}`, err);
            res.status(500).json({ success: false, error: err.message || 'Discovery failed' });
        }
    }

    private async handleImportExternalMcp(req: Request, res: Response): Promise<void> {
        try {
            const { workspaceRoot, servers } = req.body || {};
            const root = workspaceRoot || process.cwd();
            if (!Array.isArray(servers) || servers.length === 0) {
                res.status(400).json({ error: 'No servers provided to import' });
                return;
            }

            const imported = await this.workspaceConfigService.importExternalMcpServers(root, servers);
            res.json({ success: true, count: imported.length, servers: imported });
        } catch (err: any) {
            this.logger.error(`Failed to import external MCP servers: ${err.message}`, err);
            res.status(500).json({ error: err.message || 'Import failed' });
        }
    }

    private handleFileChangeEvents(req: Request, res: Response): void {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders?.();

        if (this.workspaceFileWatcherService) {
            const workspaceRoot = (req.query.root as string) || process.cwd();
            this.workspaceFileWatcherService.startWatching(workspaceRoot);
            this.workspaceFileWatcherService.addSSEClient(res);

            req.on('close', () => {
                this.workspaceFileWatcherService?.removeSSEClient(res);
            });
        } else {
            res.write(`event: error\ndata: ${JSON.stringify({ error: 'WorkspaceFileWatcherService not available' })}\n\n`);
            res.end();
        }
    }
}
