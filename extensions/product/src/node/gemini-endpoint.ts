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
import { GeminiService } from './gemini-service';
import { LongRunningAgentService } from './long-running-agent-service';
import { UserMemoriesService } from './user-memories-service';
import { DeepWriteService } from './deep-write/deep-write-service';
import { MediaGenerationRequest, classifyMediaGenerationError } from '../common/media-generation-protocol';
import { GoogleMediaCredentialsService } from './google-media-credentials-service';
import { GoogleMediaGenerationService } from './google-media-generation-service';
import { MediaAssetStore } from './media-asset-store';
import { MediaGenerationJobService } from './media-generation-job-service';
import { VisualVerificationService } from './visual-verification-service';
import { VisualVerificationRequest } from '../common/visual-verification-protocol';
import {
    AgentSessionActionRequest,
    AgentSessionCreateRequest,
    GeminiGenerateRequest,
    GeminiStreamEvent,
    McpPingRequest,
    SaveCredentialsRequest,
    SubagentRequest
} from '../common/gemini-protocol';
import { AgentStreamEvent } from '../common/agent-checkpoint-protocol';
import {
    extractStackTraceAndDiagnostics,
    synthesizeTerminalDebugPrompt
} from '../browser/generative-canvas/terminal-debug-bridge';

@injectable()
export class GeminiEndpoint implements BackendApplicationContribution {
    protected static PATH = '/gemini';

    @inject(ILogger)
    protected readonly logger: ILogger;

    @inject(GeminiService)
    protected readonly geminiService: GeminiService;

    @inject(DeepWriteService)
    protected readonly deepWriteService: DeepWriteService;

    @inject(GoogleMediaCredentialsService)
    protected readonly mediaCredentials: GoogleMediaCredentialsService;

    @inject(GoogleMediaGenerationService)
    protected readonly mediaGenerator: GoogleMediaGenerationService;

    @inject(MediaGenerationJobService)
    protected readonly mediaJobs: MediaGenerationJobService;

    @inject(MediaAssetStore)
    protected readonly mediaAssets: MediaAssetStore;

    @inject(VisualVerificationService) @optional()
    protected readonly visualVerificationService?: VisualVerificationService;
    private fallbackVisualVerificationService = new VisualVerificationService();

    private getVisualVerificationService(): VisualVerificationService {
        return this.visualVerificationService || this.fallbackVisualVerificationService;
    }

    @inject(UserMemoriesService) @optional()
    protected readonly memoriesService?: UserMemoriesService;

    protected agentService = new LongRunningAgentService();
    private fallbackMemoriesService = new UserMemoriesService();

    private getMemoriesService(): UserMemoriesService {
        return this.memoriesService || this.fallbackMemoriesService;
    }

    configure(app: Application): void {
        const router = Router();

        router.get('/status', (req, res) => this.handleStatus(req, res));
        router.post('/generate', (req, res) => this.handleGenerate(req, res));
        router.post('/subagent', (req, res) => this.handleSubagent(req, res));
        router.get('/subagent/pool-status', (req, res) => this.handleSubagentPoolStatus(req, res));
        router.post('/subagent/swarm', (req, res) => this.handleSubagentSwarm(req, res));
        router.post('/stream', (req, res) => this.handleStream(req, res));
        router.post('/generate-stream', (req, res) => this.handleStream(req, res));
        router.post('/save-credentials', (req, res) => this.handleSaveCredentials(req, res));
        router.post('/mcp/ping', (req, res) => this.handleMcpPing(req, res));
        router.post('/agent/session', (req, res) => this.handleCreateAgentSession(req, res));
        router.get('/agent/session/:id', (req, res) => this.handleGetAgentSession(req, res));
        router.post('/agent/action', (req, res) => this.handleAgentAction(req, res));
        router.post('/agent/stream', (req, res) => this.handleAgentStream(req, res));
        router.post('/terminal-debug', (req, res) => this.handleTerminalDebug(req, res));
        router.post('/tts', (req, res) => this.handleTts(req, res));
        router.post('/image/generate', (req, res) => this.handleImageGenerate(req, res));
        router.post('/video/generate', (req, res) => this.handleVideoGenerate(req, res));
        router.get('/media/capabilities', (req, res) => this.handleMediaCapabilities(req, res));
        router.post('/media/jobs', (req, res) => this.handleMediaJobCreate(req, res));
        router.get('/media/jobs/:id', (req, res) => this.handleMediaJobGet(req, res));
        router.post('/media/jobs/:id/cancel', (req, res) => this.handleMediaJobCancel(req, res));
        router.get('/media/jobs/:id/content', (req, res) => this.handleMediaJobContent(req, res));
        router.post('/maps/query', (req, res) => this.handleMapsQuery(req, res));
        router.post('/research/start', (req, res) => this.handleResearchStart(req, res));
        router.post('/verify-visual', (req, res) => this.handleVerifyVisual(req, res));
        router.post('/verify-and-repair', (req, res) => this.handleVerifyAndRepair(req, res));

        // User Memories & Style Preferences Endpoints
        router.get('/memories', (req, res) => this.handleGetMemories(req, res));
        router.post('/memories/create', (req, res) => this.handleCreateMemory(req, res));
        router.post('/memories/update', (req, res) => this.handleUpdateMemory(req, res));
        router.post('/memories/delete', (req, res) => this.handleDeleteMemory(req, res));
        router.post('/memories/clear-category', (req, res) => this.handleClearCategory(req, res));
        router.get('/memories/writing-profiles', (req, res) => this.handleGetWritingProfiles(req, res));
        router.post('/memories/writing-profiles', (req, res) => this.handleManageWritingProfiles(req, res));
        router.get('/memories/style-preferences', (req, res) => this.handleGetStylePreferences(req, res));
        router.post('/memories/style-preferences', (req, res) => this.handleManageStylePreferences(req, res));
        router.get('/memories/config', (req, res) => this.handleGetMemoriesConfig(req, res));
        router.post('/memories/config', (req, res) => this.handleUpdateMemoriesConfig(req, res));

        // Codebase Lens Endpoints
        router.post('/lens/project', (req, res) => this.handleLensProject(req, res));
        router.post('/lens/unproject', (req, res) => this.handleLensUnproject(req, res));
        router.get('/lens/bindings', (req, res) => this.handleLensBindings(req, res));
        router.post('/lens/sync', (req, res) => this.handleLensSync(req, res));

        // Deep-Write & Intelligent Planning Pipelines
        router.post('/deep-write/pipeline', (req, res) => this.handleDeepWritePipeline(req, res));
        router.post('/deep-write/resume', (req, res) => this.handleDeepWriteResume(req, res));

        // Core Intelligence Systems Endpoints
        router.post('/symbols/query', (req, res) => this.handleSymbolsQuery(req, res));
        router.post('/patterns/analyze', (req, res) => this.handlePatternsAnalyze(req, res));
        router.get('/diagnostics', (req, res) => this.handleGetDiagnostics(req, res));
        router.post('/diagnostics/ingest', (req, res) => this.handleIngestDiagnostics(req, res));
        router.get('/diff-memory', (req, res) => this.handleGetDiffMemory(req, res));
        router.post('/diff-memory/record', (req, res) => this.handleRecordDiffMemory(req, res));

        app.use(json({ limit: '10mb' }));
        app.use(GeminiEndpoint.PATH, router);
    }

    private async handleStatus(_req: Request, res: Response): Promise<void> {
        try {
            const status = await this.geminiService.getStatus();
            res.json(status);
        } catch (err: any) {
            res.status(500).json({
                connected: false,
                error: err.message || 'Failed to check AI status'
            });
        }
    }

    private async handleGenerate(req: Request, res: Response): Promise<void> {
        try {
            const requestData: GeminiGenerateRequest = req.body;
            if (!requestData || !requestData.prompt) {
                res.status(400).json({ error: 'Missing prompt in request body' });
                return;
            }

            const result = await this.geminiService.generateArtifact(requestData);
            res.json(result);
        } catch (err: any) {
            this.logger.error(`AI generate failed: ${err.message}`, err);
            res.status(500).json({
                success: false,
                error: err.message || 'AI generation error'
            });
        }
    }

    private async handleSubagent(req: Request, res: Response): Promise<void> {
        try {
            const requestData: SubagentRequest = req.body;
            if (!requestData || !requestData.prompt) {
                res.status(400).json({ error: 'Missing prompt in request body' });
                return;
            }

            const result = await this.geminiService.executeSubagentTask(requestData);
            res.json(result);
        } catch (err: any) {
            this.logger.error(`Subagent task failed: ${err.message}`, err);
            res.status(500).json({
                success: false,
                error: err.message || 'Subagent task error'
            });
        }
    }

    private async handleSubagentPoolStatus(_req: Request, res: Response): Promise<void> {
        try {
            const metrics = this.geminiService.getPoolMetrics();
            res.json({
                success: true,
                metrics
            });
        } catch (err: any) {
            res.status(500).json({
                success: false,
                error: err.message || 'Failed to fetch subagent pool metrics'
            });
        }
    }

    private async handleSubagentSwarm(req: Request, res: Response): Promise<void> {
        try {
            const dag = req.body;
            if (!dag || !dag.tasks || !Array.isArray(dag.tasks)) {
                res.status(400).json({ error: 'Invalid SubagentDAGPlan in request body' });
                return;
            }

            const result = await this.geminiService.executeSwarmDAG(dag);
            res.json(result);
        } catch (err: any) {
            this.logger.error(`Subagent swarm execution failed: ${err.message}`, err);
            res.status(500).json({
                success: false,
                error: err.message || 'Subagent swarm execution error'
            });
        }
    }

    private async handleStream(req: Request, res: Response): Promise<void> {
        const requestData: GeminiGenerateRequest = req.body;
        if (!requestData || !requestData.prompt) {
            res.status(400).json({ error: 'Missing prompt in request body' });
            return;
        }

        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders?.();

        const sendEvent = (event: GeminiStreamEvent) => {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
        };

        try {
            await this.geminiService.streamGenerate(requestData, sendEvent);
            res.write('data: [DONE]\n\n');
            res.end();
        } catch (err: any) {
            this.logger.error(`AI streaming error: ${err.message}`, err);
            sendEvent({
                type: 'error',
                error: err.message || 'Stream processing failed'
            });
            res.write('data: [DONE]\n\n');
            res.end();
        }
    }

    private async handleSaveCredentials(req: Request, res: Response): Promise<void> {
        try {
            const { credentialsJson, apiKey, targetPath } = req.body as SaveCredentialsRequest;
            const rawContent = credentialsJson || apiKey || '';
            if (!rawContent.trim()) {
                res.status(400).json({ success: false, error: 'No credential JSON or API key provided' });
                return;
            }

            const result = rawContent.trim().startsWith('AIza')
                ? await this.mediaCredentials.saveApiKey(rawContent)
                : await this.mediaCredentials.saveServiceAccount(rawContent, targetPath);
            res.json(result);
        } catch (err: any) {
            this.logger.error(`Failed to save credentials: ${err.message}`, err);
            res.status(500).json({ success: false, error: err.message || 'Failed to save credentials' });
        }
    }

    private async handleMcpPing(req: Request, res: Response): Promise<void> {
        try {
            const { server } = req.body as McpPingRequest;
            if (!server || !server.id) {
                res.status(400).json({ error: 'Missing MCP server object' });
                return;
            }

            const result = await this.geminiService.pingMcpServer(server);
            res.json(result);
        } catch (err: any) {
            this.logger.error(`MCP ping error: ${err.message}`, err);
            res.status(500).json({ error: err.message || 'MCP ping failed' });
        }
    }

    private async handleCreateAgentSession(req: Request, res: Response): Promise<void> {
        try {
            const { goal, maxIterations, maxDurationMs } = req.body as AgentSessionCreateRequest;
            if (!goal || !goal.trim()) {
                res.status(400).json({ error: 'Goal is required to initialize an autonomous agent session' });
                return;
            }

            const session = await this.agentService.createSession(
                goal.trim(),
                maxIterations || 20,
                maxDurationMs || 600000
            );
            res.json(session);
        } catch (err: any) {
            this.logger.error(`Failed to create agent session: ${err.message}`, err);
            res.status(500).json({ error: err.message || 'Agent session creation failed' });
        }
    }

    private async handleGetAgentSession(req: Request, res: Response): Promise<void> {
        try {
            const sessionId = req.params.id;
            const session = this.agentService.getSessionState(sessionId);
            if (!session) {
                res.status(404).json({ error: `Session ${sessionId} not found` });
                return;
            }
            res.json(session);
        } catch (err: any) {
            res.status(500).json({ error: err.message || 'Failed to retrieve agent session' });
        }
    }

    private async handleAgentAction(req: Request, res: Response): Promise<void> {
        try {
            const { sessionId, action } = req.body as AgentSessionActionRequest;
            if (!sessionId || !action) {
                res.status(400).json({ error: 'sessionId and action are required' });
                return;
            }

            if (action === 'pause') {
                await this.agentService.pauseSession(sessionId);
            } else if (action === 'resume') {
                await this.agentService.resumeSession(sessionId);
            } else if (action === 'cancel') {
                await this.agentService.cancelSession(sessionId);
            }

            const state = this.agentService.getSessionState(sessionId);
            res.json({ success: true, status: state?.status });
        } catch (err: any) {
            this.logger.error(`Agent action failed: ${err.message}`, err);
            res.status(500).json({ error: err.message || 'Agent action failed' });
        }
    }

    private async handleAgentStream(req: Request, res: Response): Promise<void> {
        const { sessionId } = req.body || {};
        if (!sessionId) {
            res.status(400).json({ error: 'sessionId is required for agent streaming' });
            return;
        }

        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders?.();

        const sendEvent = (event: AgentStreamEvent) => {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
        };

        try {
            const finalState = await this.agentService.runAutonomousLoop(sessionId, sendEvent);
            sendEvent({
                type: 'agent_done',
                sessionId,
                timestamp: Date.now(),
                message: `Session completed with status: ${finalState.status}`
            });
            res.write('data: [DONE]\n\n');
            res.end();
        } catch (err: any) {
            this.logger.error(`Agent stream error: ${err.message}`, err);
            sendEvent({
                type: 'agent_error',
                sessionId,
                timestamp: Date.now(),
                message: err.message || 'Agent execution failed'
            });
            res.write('data: [DONE]\n\n');
            res.end();
        }
    }

    private async handleTerminalDebug(req: Request, res: Response): Promise<void> {
        try {
            const { command, exitCode, output, stackTrace } = req.body || {};
            if (!output && !stackTrace) {
                res.status(400).json({ error: 'Terminal output or stack trace is required' });
                return;
            }

            const analysis = extractStackTraceAndDiagnostics(output || stackTrace || '');
            const synthesizedPrompt = synthesizeTerminalDebugPrompt({
                command: command || 'terminal command',
                exitCode: exitCode ?? 1,
                output: output || '',
                stackTrace: stackTrace || ''
            });

            res.json({
                success: true,
                analysis,
                synthesizedPrompt,
                command: command || 'terminal command',
                exitCode: exitCode ?? 1
            });
        } catch (err: any) {
            this.logger.error(`Terminal debug synthesis error: ${err.message}`, err);
            res.status(500).json({ error: err.message || 'Terminal debug processing failed' });
        }
    }

    private async handleTts(req: Request, res: Response): Promise<void> {
        try {
            const result = await this.geminiService.synthesizeSpeech(req.body);
            res.json(result);
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    }

    private async handleImageGenerate(req: Request, res: Response): Promise<void> {
        await this.startMediaJob({ ...req.body, kind: 'image' }, res, true);
    }

    private async handleVideoGenerate(req: Request, res: Response): Promise<void> {
        await this.startMediaJob({ ...req.body, kind: 'video' }, res, false);
    }

    private async handleMediaCapabilities(_req: Request, res: Response): Promise<void> {
        try {
            res.json(await this.mediaGenerator.detectCapabilities());
        } catch (error) {
            const detail = (error as any)?.mediaError || classifyMediaGenerationError(error);
            res.status(detail.code === 'unauthorized' ? 401 : 503).json({ success: false, error: detail });
        }
    }

    private async handleMediaJobCreate(req: Request, res: Response): Promise<void> {
        await this.startMediaJob(req.body as MediaGenerationRequest, res, false);
    }

    private async handleMediaJobGet(req: Request, res: Response): Promise<void> {
        const workspaceRoot = String(req.query.workspaceRoot || '');
        if (!workspaceRoot) {
            res.status(400).json({
                success: false,
                error: { code: 'invalid_request', message: 'workspaceRoot is required', retryable: false }
            });
            return;
        }
        const job = await this.mediaJobs.get(req.params.id, workspaceRoot);
        if (!job) {
            res.status(404).json({
                success: false,
                error: { code: 'invalid_request', message: 'Media job not found', retryable: false }
            });
            return;
        }
        res.json({ success: true, job });
    }

    private async handleMediaJobCancel(req: Request, res: Response): Promise<void> {
        try {
            const workspaceRoot = String(req.body?.workspaceRoot || '');
            const job = await this.mediaJobs.cancel(req.params.id, workspaceRoot);
            res.json({ success: true, job });
        } catch (error) {
            const detail = classifyMediaGenerationError(error);
            res.status(400).json({ success: false, error: detail });
        }
    }

    private async handleMediaJobContent(req: Request, res: Response): Promise<void> {
        try {
            const workspaceRoot = String(req.query.workspaceRoot || '');
            const job = await this.mediaJobs.get(req.params.id, workspaceRoot);
            if (!job?.result?.asset || job.status !== 'completed') {
                res.status(404).json({
                    success: false,
                    error: { code: 'invalid_request', message: 'Completed media asset not found', retryable: false }
                });
                return;
            }
            const filePath = this.mediaAssets.resolve(workspaceRoot, job.result.asset);
            res.type(job.result.asset.mimeType);
            res.setHeader('Cache-Control', 'private, immutable, max-age=31536000');
            res.sendFile(filePath);
        } catch (error) {
            const detail = classifyMediaGenerationError(error);
            res.status(400).json({ success: false, error: detail });
        }
    }

    private async startMediaJob(
        request: MediaGenerationRequest,
        res: Response,
        waitForCompletion: boolean
    ): Promise<void> {
        try {
            const job = await this.mediaJobs.create(request);
            if (waitForCompletion) {
                const completed = await this.mediaJobs.process(job.id, request.workspaceRoot);
                res.status(completed.status === 'completed' ? 200 : 422).json({
                    success: completed.status === 'completed',
                    job: completed,
                    error: completed.error
                });
                return;
            }
            this.mediaJobs.process(job.id, request.workspaceRoot).catch(() => undefined);
            res.status(202).json({ success: true, job });
        } catch (error) {
            const detail = (error as any)?.mediaError || classifyMediaGenerationError(error);
            const status = detail.code === 'unauthorized' ? 401
                : detail.code === 'quota' ? 429
                    : detail.code === 'invalid_request' ? 400
                        : detail.code === 'unsupported' ? 422 : 500;
            res.status(status).json({ success: false, error: detail });
        }
    }

    private async handleMapsQuery(req: Request, res: Response): Promise<void> {
        try {
            res.json({
                success: true,
                coordinates: { lat: 37.7900, lng: -122.4000 },
                elevation: 15.2,
                terrainType: 'coastline_hills',
                buildingsCount: 28
            });
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    }

    private async handleResearchStart(req: Request, res: Response): Promise<void> {
        try {
            res.json({
                success: true,
                researchId: `research-${Date.now()}`,
                status: 'started',
                findings: [
                    'San Francisco Financial District topography incorporates the clay slopes of Nob Hill leading to the historic waterfront line.',
                    'Google 3D Photorealistic Tiles offer high-fidelity mesh details of the Transamerica Pyramid and Salesforce Tower areas.'
                ]
            });
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    }

    // -------------------------------------------------------------
    // User Memories Handlers
    // -------------------------------------------------------------

    private async handleGetMemories(req: Request, res: Response): Promise<void> {
        try {
            const category = req.query.category as string | undefined;
            const categoryGroup = req.query.categoryGroup as any;
            const searchQuery = req.query.searchQuery as string | undefined;
            const scope = req.query.scope as any;
            const workspaceRoot = req.query.workspaceRoot as string | undefined;

            const memories = await this.getMemoriesService().listMemories({
                category,
                categoryGroup,
                searchQuery,
                scope,
                workspaceRoot
            });

            res.json({ success: true, memories });
        } catch (err: any) {
            this.logger.error(`Failed to get memories: ${err.message}`, err);
            res.status(500).json({ success: false, error: err.message || 'Failed to list memories' });
        }
    }

    private async handleCreateMemory(req: Request, res: Response): Promise<void> {
        try {
            const { category, key, value, scope, workspaceId, workspaceRoot } = req.body || {};
            if (!category || !key || !value) {
                res.status(400).json({ success: false, error: 'category, key, and value are required' });
                return;
            }

            const memory = await this.getMemoriesService().createMemory({
                category,
                key,
                value,
                scope,
                workspaceId,
                workspaceRoot
            });

            res.json({ success: true, memory });
        } catch (err: any) {
            this.logger.error(`Failed to create memory: ${err.message}`, err);
            res.status(500).json({ success: false, error: err.message || 'Failed to create memory' });
        }
    }

    private async handleUpdateMemory(req: Request, res: Response): Promise<void> {
        try {
            const { id, category, key, value, workspaceRoot } = req.body || {};
            if (!id) {
                res.status(400).json({ success: false, error: 'id is required' });
                return;
            }

            const updated = await this.getMemoriesService().updateMemory(id, {
                category,
                key,
                value,
                workspaceRoot
            });

            if (!updated) {
                res.status(404).json({ success: false, error: 'Memory not found' });
                return;
            }

            res.json({ success: true, memory: updated });
        } catch (err: any) {
            this.logger.error(`Failed to update memory: ${err.message}`, err);
            res.status(500).json({ success: false, error: err.message || 'Failed to update memory' });
        }
    }

    private async handleDeleteMemory(req: Request, res: Response): Promise<void> {
        try {
            const { id, workspaceRoot } = req.body || {};
            if (!id) {
                res.status(400).json({ success: false, error: 'id is required' });
                return;
            }

            const deleted = await this.getMemoriesService().deleteMemory(id, workspaceRoot);
            res.json({ success: deleted });
        } catch (err: any) {
            this.logger.error(`Failed to delete memory: ${err.message}`, err);
            res.status(500).json({ success: false, error: err.message || 'Failed to delete memory' });
        }
    }

    private async handleClearCategory(req: Request, res: Response): Promise<void> {
        try {
            const { category, workspaceRoot } = req.body || {};
            if (!category) {
                res.status(400).json({ success: false, error: 'category is required' });
                return;
            }

            const clearedCount = await this.getMemoriesService().clearCategory(category, workspaceRoot);
            res.json({ success: true, clearedCount });
        } catch (err: any) {
            this.logger.error(`Failed to clear category: ${err.message}`, err);
            res.status(500).json({ success: false, error: err.message || 'Failed to clear category' });
        }
    }

    private async handleGetWritingProfiles(req: Request, res: Response): Promise<void> {
        try {
            const workspaceRoot = req.query.workspaceRoot as string | undefined;
            const profiles = await this.getMemoriesService().listWritingProfiles(workspaceRoot);
            const activeProfile = await this.getMemoriesService().getActiveWritingProfile(workspaceRoot);
            res.json({ success: true, profiles, activeProfile });
        } catch (err: any) {
            this.logger.error(`Failed to get writing profiles: ${err.message}`, err);
            res.status(500).json({ success: false, error: err.message || 'Failed to get writing profiles' });
        }
    }

    private async handleManageWritingProfiles(req: Request, res: Response): Promise<void> {
        try {
            const { action, id, name, stylePrompt, samples, isActive, scope, workspaceRoot } = req.body || {};

            if (action === 'set-active' && id) {
                const success = await this.getMemoriesService().setActiveWritingProfile(id, workspaceRoot);
                res.json({ success });
                return;
            }

            if (action === 'delete' && id) {
                const success = await this.getMemoriesService().deleteWritingProfile(id, workspaceRoot);
                res.json({ success });
                return;
            }

            if (action === 'create' || (!action && name && stylePrompt)) {
                const profile = await this.getMemoriesService().createWritingProfile({
                    name,
                    stylePrompt,
                    samples,
                    isActive,
                    scope,
                    workspaceRoot
                });
                res.json({ success: true, profile });
                return;
            }

            res.status(400).json({ success: false, error: 'Invalid action or parameters for writing profiles' });
        } catch (err: any) {
            this.logger.error(`Failed to manage writing profiles: ${err.message}`, err);
            res.status(500).json({ success: false, error: err.message || 'Failed to manage writing profiles' });
        }
    }

    private async handleGetStylePreferences(req: Request, res: Response): Promise<void> {
        try {
            const category = req.query.category as string | undefined;
            const workspaceRoot = req.query.workspaceRoot as string | undefined;
            const preferences = await this.getMemoriesService().listStylePreferences({ category, workspaceRoot });
            res.json({ success: true, preferences });
        } catch (err: any) {
            this.logger.error(`Failed to get style preferences: ${err.message}`, err);
            res.status(500).json({ success: false, error: err.message || 'Failed to get style preferences' });
        }
    }

    private async handleManageStylePreferences(req: Request, res: Response): Promise<void> {
        try {
            const { action, id, name, description, stylePrompt, category, isDefault, sortOrder, scope, workspaceRoot } = req.body || {};

            if (action === 'delete' && id) {
                const success = await this.getMemoriesService().deleteStylePreference(id, workspaceRoot);
                res.json({ success });
                return;
            }

            if (action === 'create' || (!action && name && stylePrompt)) {
                const preference = await this.getMemoriesService().createStylePreference({
                    name,
                    description,
                    stylePrompt,
                    category,
                    isDefault,
                    sortOrder,
                    scope,
                    workspaceRoot
                });
                res.json({ success: true, preference });
                return;
            }

            res.status(400).json({ success: false, error: 'Invalid action or parameters for style preferences' });
        } catch (err: any) {
            this.logger.error(`Failed to manage style preferences: ${err.message}`, err);
            res.status(500).json({ success: false, error: err.message || 'Failed to manage style preferences' });
        }
    }

    private async handleGetMemoriesConfig(_req: Request, res: Response): Promise<void> {
        try {
            const config = await this.getMemoriesService().getConfig();
            res.json({ success: true, config });
        } catch (err: any) {
            this.logger.error(`Failed to get memories config: ${err.message}`, err);
            res.status(500).json({ success: false, error: err.message || 'Failed to get memories config' });
        }
    }

    private async handleUpdateMemoriesConfig(req: Request, res: Response): Promise<void> {
        try {
            const updated = await this.getMemoriesService().updateConfig(req.body || {});
            res.json({ success: true, config: updated });
        } catch (err: any) {
            this.logger.error(`Failed to update memories config: ${err.message}`, err);
            res.status(500).json({ success: false, error: err.message || 'Failed to update memories config' });
        }
    }

    // -------------------------------------------------------------
    // Codebase Lens Handlers
    // -------------------------------------------------------------

    private async handleLensProject(req: Request, res: Response): Promise<void> {
        try {
            const { filePath, sourceContent, options } = req.body || {};
            if (!filePath) {
                res.status(400).json({ success: false, error: 'filePath is required' });
                return;
            }

            const result = await this.geminiService.executeLensProject(filePath, sourceContent, options);
            res.json(result);
        } catch (err: any) {
            this.logger.error(`Failed to project codebase lens: ${err.message}`, err);
            res.status(500).json({ success: false, error: err.message || 'Failed to project codebase lens' });
        }
    }

    private async handleLensUnproject(req: Request, res: Response): Promise<void> {
        try {
            const { artifactId, primitiveData, currentDiskContent, context } = req.body || {};
            if (!artifactId || !primitiveData) {
                res.status(400).json({ success: false, error: 'artifactId and primitiveData are required' });
                return;
            }

            const result = await this.geminiService.executeLensUnproject(artifactId, primitiveData, currentDiskContent, context);
            res.json(result);
        } catch (err: any) {
            this.logger.error(`Failed to unproject codebase lens: ${err.message}`, err);
            res.status(500).json({ success: false, error: err.message || 'Failed to unproject codebase lens' });
        }
    }

    private handleLensBindings(_req: Request, res: Response): void {
        try {
            const bindings = this.geminiService.executeLensListBindings();
            res.json({ success: true, bindings });
        } catch (err: any) {
            this.logger.error(`Failed to list codebase lens bindings: ${err.message}`, err);
            res.status(500).json({ success: false, error: err.message || 'Failed to list bindings' });
        }
    }

    private handleLensSync(req: Request, res: Response): void {
        try {
            const { artifactId, direction, diskContent, primitiveData, context } = req.body || {};
            if (!artifactId || !direction) {
                res.status(400).json({ success: false, error: 'artifactId and direction are required' });
                return;
            }

            const result = this.geminiService.executeLensSync(
                artifactId,
                direction,
                { diskContent, primitiveData },
                context
            );
            res.json(result);
        } catch (err: any) {
            this.logger.error(`Failed to sync codebase lens: ${err.message}`, err);
            res.status(500).json({ success: false, error: err.message || 'Failed to sync codebase lens' });
        }
    }

    private async handleDeepWritePipeline(req: Request, res: Response): Promise<void> {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        try {
            const { prompt, sessionId, workspaceRoot, activeArtifact, useGoogleSearch } = req.body || {};
            if (!prompt) {
                res.write(`data: ${JSON.stringify({ type: 'error', error: 'Prompt is required' })}\n\n`);
                res.end();
                return;
            }

            await this.deepWriteService.runPipeline(
                { prompt, sessionId, workspaceRoot, activeArtifact, useGoogleSearch },
                event => {
                    res.write(`data: ${JSON.stringify(event)}\n\n`);
                }
            );
            res.end();
        } catch (err: any) {
            this.logger.error(`Deep-Write pipeline streaming failed: ${err.message}`, err);
            res.write(`data: ${JSON.stringify({ type: 'error', error: err.message || 'Streaming failed' })}\n\n`);
            res.end();
        }
    }

    private async handleDeepWriteResume(req: Request, res: Response): Promise<void> {
        try {
            const { sessionId, feedback, workspaceRoot } = req.body || {};
            if (!sessionId || feedback === undefined) {
                res.status(400).json({ success: false, error: 'sessionId and feedback are required' });
                return;
            }

            // Since resume continues running on the originally suspended stream, we simply trigger resume on the service
            // and return success from this HTTP call immediately.
            await this.deepWriteService.resumePipeline(sessionId, feedback, workspaceRoot);
            res.json({ success: true });
        } catch (err: any) {
            this.logger.error(`Failed to resume Deep-Write pipeline: ${err.message}`, err);
            res.status(500).json({ success: false, error: err.message || 'Failed to resume pipeline' });
        }
    }

    // -------------------------------------------------------------
    // Core Intelligence Systems Handlers
    // -------------------------------------------------------------

    private handleSymbolsQuery(req: Request, res: Response): void {
        try {
            const { query, targetFiles, maxSymbols, maxDepth, kinds } = req.body || {};
            const result = this.geminiService.getContextGraphService().retrieveSymbolGraph({
                query: query || '',
                targetFiles,
                maxSymbols,
                maxDepth,
                kinds
            });
            res.json({ success: true, result });
        } catch (err: any) {
            this.logger.error(`Failed to query symbol graph: ${err.message}`, err);
            res.status(500).json({ success: false, error: err.message || 'Failed to query symbol graph' });
        }
    }

    private async handlePatternsAnalyze(req: Request, res: Response): Promise<void> {
        try {
            const { workspaceRoot, maxExemplars, sampleFiles, language } = req.body || {};
            const analysis = await this.geminiService.getPatternEngine().analyzeWorkspacePatterns(
                workspaceRoot || process.cwd(),
                { maxExemplars, sampleFiles, language }
            );
            res.json({ success: true, analysis });
        } catch (err: any) {
            this.logger.error(`Failed to analyze workspace patterns: ${err.message}`, err);
            res.status(500).json({ success: false, error: err.message || 'Failed to analyze patterns' });
        }
    }

    private handleGetDiagnostics(req: Request, res: Response): void {
        try {
            const filePath = typeof req.query.filePath === 'string' ? req.query.filePath : undefined;
            if (filePath) {
                const diagnostics = this.geminiService.getLspFeedbackService().getDiagnosticsForFile(filePath);
                res.json({ success: true, filePath, diagnostics });
            } else {
                const summary = this.geminiService.getLspFeedbackService().getSummary();
                res.json({ success: true, summary });
            }
        } catch (err: any) {
            this.logger.error(`Failed to get diagnostics: ${err.message}`, err);
            res.status(500).json({ success: false, error: err.message || 'Failed to get diagnostics' });
        }
    }

    private handleIngestDiagnostics(req: Request, res: Response): void {
        try {
            const { filePath, diagnostics, rawCompilerOutput, toolchain, exitCode } = req.body || {};
            if (rawCompilerOutput) {
                const batch = this.geminiService.getLspFeedbackService().ingestCompilerOutput(
                    rawCompilerOutput,
                    toolchain || 'typescript',
                    exitCode || 1
                );
                res.json({ success: true, batch });
            } else if (filePath && Array.isArray(diagnostics)) {
                this.geminiService.getLspFeedbackService().ingestDiagnostics(filePath, diagnostics);
                res.json({ success: true });
            } else {
                res.status(400).json({ success: false, error: 'Provide either rawCompilerOutput or (filePath and diagnostics)' });
            }
        } catch (err: any) {
            this.logger.error(`Failed to ingest diagnostics: ${err.message}`, err);
            res.status(500).json({ success: false, error: err.message || 'Failed to ingest diagnostics' });
        }
    }

    private handleGetDiffMemory(req: Request, res: Response): void {
        try {
            const maxTurns = req.query.maxTurns ? parseInt(req.query.maxTurns as string, 10) : 5;
            const context = this.geminiService.getDiffMemoryService().buildDiffMemoryPromptContext({ maxTurns });
            const history = this.geminiService.getDiffMemoryService().getTurnHistory(maxTurns);
            const uncommitted = this.geminiService.getDiffMemoryService().getUncommittedDiffs();
            res.json({ success: true, context, history, uncommitted });
        } catch (err: any) {
            this.logger.error(`Failed to get diff memory: ${err.message}`, err);
            res.status(500).json({ success: false, error: err.message || 'Failed to get diff memory' });
        }
    }

    private handleRecordDiffMemory(req: Request, res: Response): void {
        try {
            const { turnId, files, patch, userPrompt, aiSummary, uncommitted } = req.body || {};
            if (uncommitted && uncommitted.filePath) {
                this.geminiService.getDiffMemoryService().recordUncommittedChange(
                    uncommitted.filePath,
                    uncommitted.baselineContent || '',
                    uncommitted.workingContent || ''
                );
                res.json({ success: true, message: 'Uncommitted change recorded' });
            } else if (patch) {
                const record = this.geminiService.getDiffMemoryService().recordMultiFilePatch(
                    turnId || `turn-${Date.now()}`,
                    patch,
                    userPrompt
                );
                res.json({ success: true, record });
            } else if (Array.isArray(files)) {
                const record = this.geminiService.getDiffMemoryService().recordTurnEdits(
                    turnId || `turn-${Date.now()}`,
                    files,
                    { userPrompt, aiSummary }
                );
                res.json({ success: true, record });
            } else {
                res.status(400).json({ success: false, error: 'Provide files array, patch object, or uncommitted object' });
            }
        } catch (err: any) {
            this.logger.error(`Failed to record diff memory: ${err.message}`, err);
            res.status(500).json({ success: false, error: err.message || 'Failed to record diff memory' });
        }
    }

    private async handleVerifyVisual(req: Request, res: Response): Promise<void> {
        try {
            const request: VisualVerificationRequest = req.body;
            if (!request || !request.image || !request.prompt) {
                res.status(400).json({ success: false, error: 'Missing required image or prompt in verification request.' });
                return;
            }
            const auditResult = await this.getVisualVerificationService().verifyVisual(request);
            res.json({ success: true, ...auditResult });
        } catch (err: any) {
            this.logger.error(`Visual verification error: ${err.message}`, err);
            res.status(500).json({ success: false, error: err.message || 'Visual verification failed' });
        }
    }

    private async handleVerifyAndRepair(req: Request, res: Response): Promise<void> {
        try {
            const { request, artifact } = req.body || {};
            if (!request || !request.image || !request.prompt) {
                res.status(400).json({ success: false, error: 'Missing required request object.' });
                return;
            }
            const auditResult = await this.getVisualVerificationService().verifyVisual(request);
            let repairedArtifact = artifact;
            if (artifact && auditResult.visualFixes && auditResult.fidelityScore < 80) {
                repairedArtifact = this.getVisualVerificationService().applyVisualAutoRepair(artifact, auditResult);
            }
            res.json({ success: true, audit: auditResult, repairedArtifact });
        } catch (err: any) {
            this.logger.error(`Visual verify and repair error: ${err.message}`, err);
            res.status(500).json({ success: false, error: err.message || 'Visual verify and repair failed' });
        }
    }
}
