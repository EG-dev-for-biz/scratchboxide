/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import type { GoogleAuth } from 'google-auth-library';
import {
    FimCompletionRequest,
    FimCompletionResponse,
    GeminiGenerateRequest,
    GeminiGenerateResponse,
    GeminiStatus,
    GeminiStreamEvent,
    GroundingMetadata,
    McpPingResponse,
    QuickEditRequest,
    QuickEditResponse,
    SaveCredentialsResponse,
    SubagentRequest,
    SubagentResponse,
    GeminiTtsRequest,
    GeminiTtsResponse
} from '../common/gemini-protocol';
import { MediaModelUnavailableError, MissingInputError } from '../common/errors/pipeline-errors';
import { resolveTtsModel } from '../common/media-generation-protocol';
import { FimCompletionService } from './fim-completion-service';
import { QuickEditService } from './quick-edit-service';
import {
    CanvasArtifact,
    MarkdownSection,
    McpExecutionState
} from '../browser/generative-canvas/canvas-types';
import { ProjectContextGraphService } from './project-context-graph-service';
import { UserMemoriesService } from './user-memories-service';
import { WorkspaceConfigService } from './workspace-config-service';
import type { SubagentRunResult } from './gemini/tools/types';
import type { ToolNodeCatalogEntry, ToolNodeRunEvent, ToolNodeRunRequest, ToolNodeRunResponse } from '../common/tool-node-protocol';
import type { StageEvent } from '../common/spatial/staged-location-contracts';
import { buildToolNodeCatalog } from './gemini/tool-node-catalog';

const SUBAGENT_BRIEF = `You are a research subagent working for another agent. You cannot see its conversation; everything you need is in the task below. Use read-only tools to investigate, then reply with a concise report: the answer first, then the evidence (file paths with line numbers, exact names and values). Say plainly what you could not find or verify. Do not ask questions; if the task is ambiguous, state your assumption and proceed.`;
import { BrowserProxyService } from './browser-proxy-service';
import { CodebasePatternEngine } from './codebase-pattern-engine';
import { LspDiagnosticFeedbackService } from './lsp-diagnostic-feedback-service';
import { ConversationDiffMemoryService } from './conversation-diff-memory-service';
import { ContainerSandboxService } from './container-sandbox-service';
import { FileKeyStore, defaultCredentialsPath } from './key-store';
import {
    SubagentPoolService,
    SubagentDAGPlan,
    SubagentDAGResult,
    SubagentPoolMetrics
} from './subagent-pool-service';
import {
    CodebaseLensRegistry,
    CodebaseLensController,
    CodebaseLensBinding,
    LensUnprojectionResult
} from '../browser/generative-canvas/lenses';
import {
    VisualVerificationRequest,
    VisualVerificationOutcome,
    VisualAuditUnavailable,
    MultiAngleAuditOptions,
    MultiAngleVisualAuditResult,
    VisualSelfCorrection3DOptions,
    VisualSelfCorrection3DLoopResult
} from '../common/visual-verification-protocol';
import { VisualVerificationService } from './visual-verification-service';
import {
    GeminiClient,
    DEFAULT_CHAT_MODEL,
    DEFAULT_GEMINI_MODEL,
    FALLBACK_GEMINI_MODELS,
    DEFAULT_SUBAGENT_MODEL,
    FALLBACK_SUBAGENT_MODELS,
    KEY_STORE_SERVICE,
    KEY_STORE_GEMINI_ACCOUNT,
    isServiceAccountJson,
    maskEmail,
    errorMessage
} from './gemini/gemini-client';
import { warmChatPrompt, type ChatPromptWarmupOptions, type ChatPromptWarmupReport } from './gemini/chat-prompt-warmup';
import { LensBridge, type LensContext, type LensSyncMode } from './gemini/lens-bridge';
import { McpBridge } from './gemini/mcp-bridge';
import {
    createDefaultToolRegistry,
    type GeminiFunctionCall,
    type GeminiToolConfig,
    type ToolContext,
    type ToolRegistry
} from './gemini/tool-registry';
import { SwarmBridge } from './gemini/swarm-bridge';
import { StreamingEngine } from './gemini/streaming';
import { buildContents, buildSystemInstruction, type PromptContextServices } from './gemini/prompt-builder';
import {
    extractCodeSandboxArtifact,
    extractDocumentTitle,
    markdownStringToSections,
    parseOrSynthesizeArtifact,
    withOpenArtifactRule
} from './gemini/artifact-synthesis';

export { DEFAULT_CHAT_MODEL, DEFAULT_GEMINI_MODEL, FALLBACK_GEMINI_MODELS, DEFAULT_SUBAGENT_MODEL, FALLBACK_SUBAGENT_MODELS };

/**
 * Gemini TTS returns raw 16-bit little-endian PCM (audio/L16;codec=pcm;rate=24000); browsers decode WAV, so the PCM is
 * wrapped in a RIFF header. Audio that already has a container is returned as is.
 */
export function pcmToWavBase64(base64: string, mimeType: string): string {
    if (!/l16|pcm/i.test(mimeType)) return base64;
    const pcm = Buffer.from(base64, 'base64');
    const rate = Number(/rate=(\d+)/i.exec(mimeType)?.[1] ?? 24000);
    const channels = Number(/channels=(\d+)/i.exec(mimeType)?.[1] ?? 1);
    const header = Buffer.alloc(44);
    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(36 + pcm.length, 4);
    header.write('WAVE', 8, 'ascii');
    header.write('fmt ', 12, 'ascii');
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(rate, 24);
    header.writeUInt32LE(rate * channels * 2, 28);
    header.writeUInt16LE(channels * 2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36, 'ascii');
    header.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([header, pcm]).toString('base64');
}

/**
 * Facade over the Gemini stack. Owns the collaborating modules under `./gemini/` and the
 * fallback workspace-intelligence services, and exposes the public API consumed by the
 * desktop server, deep-write pipeline, long-running agents and the subagent pool.
 */
export class GeminiService {
    private readonly client: GeminiClient = new GeminiClient({ defaultModel: DEFAULT_CHAT_MODEL });
    private readonly lens: LensBridge = new LensBridge();
    private readonly mcp: McpBridge = new McpBridge();
    private readonly toolRegistry: ToolRegistry = createDefaultToolRegistry();
    private readonly fimService: FimCompletionService = new FimCompletionService(this.client);
    private readonly quickEditService: QuickEditService = new QuickEditService(this.client);
    private readonly swarm: SwarmBridge = new SwarmBridge({
        client: this.client,
        subagentExecutor: this
    });
    private readonly streaming: StreamingEngine = new StreamingEngine({
        client: this.client,
        registry: this.toolRegistry,
        mcp: this.mcp,
        lens: this.lens,
        promptServices: () => this.getPromptContextServices(),
        toolContext: request => this.createToolContext(request),
        executeSubagentTask: request => this.executeSubagentTask(request)
    });

    // ------------------------------------------------------------------
    // Auth state proxies (tests and callers set these directly on the service)
    // ------------------------------------------------------------------

    private get auth(): GoogleAuth | undefined {
        return this.client.auth;
    }
    private set auth(value: GoogleAuth | undefined) {
        this.client.auth = value;
    }

    private get cachedServiceAccountPath(): string | undefined {
        return this.client.cachedServiceAccountPath;
    }
    private set cachedServiceAccountPath(value: string | undefined) {
        this.client.cachedServiceAccountPath = value;
    }

    private get cachedProjectId(): string | undefined {
        return this.client.cachedProjectId;
    }
    private set cachedProjectId(value: string | undefined) {
        this.client.cachedProjectId = value;
    }

    private get cachedClientEmail(): string | undefined {
        return this.client.cachedClientEmail;
    }
    private set cachedClientEmail(value: string | undefined) {
        this.client.cachedClientEmail = value;
    }

    private get preferredModel(): string {
        return this.client.preferredModel;
    }
    private set preferredModel(value: string) {
        this.client.preferredModel = value;
    }

    private get preferredSubagentModel(): string {
        return this.client.preferredSubagentModel;
    }
    private set preferredSubagentModel(value: string) {
        this.client.preferredSubagentModel = value;
    }

    // ------------------------------------------------------------------
    // Collaborating services (injectable by subclasses, with local fallbacks)
    // ------------------------------------------------------------------

    getCodebaseLensRegistry(): CodebaseLensRegistry {
        return this.lens.registry;
    }

    getCodebaseLensController(): CodebaseLensController {
        return this.lens.controller;
    }

    protected readonly contextGraphService?: ProjectContextGraphService;
    private fallbackContextGraphService = new ProjectContextGraphService();

    public getContextGraphService(): ProjectContextGraphService {
        return this.contextGraphService || this.fallbackContextGraphService;
    }

    protected readonly patternEngine?: CodebasePatternEngine;
    private fallbackPatternEngine = new CodebasePatternEngine();

    public getPatternEngine(): CodebasePatternEngine {
        return this.patternEngine || this.fallbackPatternEngine;
    }

    protected readonly lspFeedbackService?: LspDiagnosticFeedbackService;
    private fallbackLspFeedbackService = new LspDiagnosticFeedbackService();

    public getLspFeedbackService(): LspDiagnosticFeedbackService {
        return this.lspFeedbackService || this.fallbackLspFeedbackService;
    }

    protected readonly diffMemoryService?: ConversationDiffMemoryService;
    private fallbackDiffMemoryService = new ConversationDiffMemoryService();

    public getDiffMemoryService(): ConversationDiffMemoryService {
        return this.diffMemoryService || this.fallbackDiffMemoryService;
    }

    protected readonly memoriesService?: UserMemoriesService;
    private fallbackMemoriesService = new UserMemoriesService();

    public getMemoriesService(): UserMemoriesService {
        return this.memoriesService || this.fallbackMemoriesService;
    }

    private readonly workspaceConfigService = new WorkspaceConfigService();

    protected readonly browserProxy?: BrowserProxyService;
    private fallbackBrowserProxy = new BrowserProxyService();

    private getBrowserProxy(): BrowserProxyService {
        return this.browserProxy || this.fallbackBrowserProxy;
    }

    protected readonly visualVerificationService?: VisualVerificationService;
    private fallbackVisualVerificationService = new VisualVerificationService(this.client);

    public getVisualVerificationService(): VisualVerificationService {
        return this.visualVerificationService || this.fallbackVisualVerificationService;
    }

    protected readonly sandboxService?: ContainerSandboxService;
    private fallbackSandboxService = new ContainerSandboxService();

    public getSandboxService(): ContainerSandboxService {
        return this.sandboxService || this.fallbackSandboxService;
    }

    private getPromptContextServices(): PromptContextServices {
        return {
            contextGraph: this.getContextGraphService(),
            patternEngine: this.getPatternEngine(),
            lsp: this.getLspFeedbackService(),
            diffMemory: this.getDiffMemoryService(),
            memories: this.getMemoriesService(),
            workspaceConfig: this.workspaceConfigService
        };
    }

    private createToolContext(request: GeminiGenerateRequest): ToolContext {
        return {
            request,
            workspaceRoot: request.workspaceRoot || process.cwd(),
            sandbox: this.getSandboxService(),
            lsp: this.getLspFeedbackService(),
            contextGraph: this.getContextGraphService(),
            browserProxy: this.getBrowserProxy(),
            lens: this.lens,
            executeSubagent: req => this.executeSubagentTask(req),
            runSubagent: (task, parent, signal) => this.runSubagent(task, parent, signal)
        };
    }

    /** Every tool the chat can call, for the canvas node library (tool nodes). */
    listToolNodeCatalog(): ToolNodeCatalogEntry[] {
        return buildToolNodeCatalog(this.toolRegistry);
    }

    /**
     * Runs one tool outside a chat turn, for a canvas tool node: the same registry, argument coercion and handler the
     * chat uses, with a context that carries no conversation (an empty prompt in `workspaceRoot`).
     */
    async runToolNode(request: ToolNodeRunRequest, signal?: AbortSignal, onEvent?: (event: ToolNodeRunEvent) => void): Promise<ToolNodeRunResponse> {
        if (!this.toolRegistry.has(request.name)) throw new Error(`No tool named "${request.name}" is registered`);
        const started = Date.now();
        // the same hooks a chat turn gives a tool: progress, and each staged commit with its scene (the canvas applies it)
        const ctx = {
            ...this.createToolContext({ prompt: '', workspaceRoot: request.workspaceRoot, activeArtifact: request.activeArtifact }),
            signal,
            ...(onEvent ? {
                reportProgress: (message: string, fraction?: number) => onEvent({ type: 'progress', message, fraction }),
                emitStage: (stage: StageEvent, artifact?: CanvasArtifact) => onEvent({ type: 'stage', stage, artifact })
            } : {})
        };
        const { exec, resultPayload } = await this.toolRegistry.dispatch(request.name, request.args, ctx);
        const status = exec.status === 'failed' ? 'failed' : 'completed';
        const error = status === 'failed' ? (typeof resultPayload.error === 'string' ? resultPayload.error : exec.summaryResult || `${request.name} failed`) : undefined;
        return { success: status === 'completed', status, resultPayload, summary: exec.summaryResult, durationMs: Date.now() - started, error: error ? { message: error } : undefined };
    }

    /**
     * A subagent is a full agent run in Ask mode (read-only tools, enforced) with a fresh context: it
     * sees only the task, not the parent conversation, and only its final report returns to the parent.
     */
    async runSubagent(task: string, parent: GeminiGenerateRequest, signal?: AbortSignal): Promise<SubagentRunResult> {
        const toolsUsed: string[] = [];
        try {
            const response = await this.streaming.streamGenerate({
                prompt: `${SUBAGENT_BRIEF}\n\nTASK:\n${task}`,
                model: parent.subagentModel || DEFAULT_SUBAGENT_MODEL,
                mode: 'ask',
                isSubagentRun: true,
                workspaceRoot: parent.workspaceRoot,
                activeArtifact: parent.activeArtifact,
                enableWorkspaceTools: true,
                enableGoogleSearch: parent.enableGoogleSearch,
                maxTurns: 20
            }, event => {
                if (event.type === 'tool_result' && event.mcpExecution?.toolName) toolsUsed.push(event.mcpExecution.toolName);
            }, signal);
            if (!response.success) {
                return { success: false, report: '', toolsUsed, modelUsed: response.modelUsed, error: response.error || 'Subagent run failed' };
            }
            return { success: true, report: response.text, toolsUsed, modelUsed: response.modelUsed };
        } catch (err: any) {
            return { success: false, report: '', toolsUsed, error: err?.message || String(err) };
        }
    }

    // ------------------------------------------------------------------
    // Visual verification
    // ------------------------------------------------------------------

    /** Multimodal Vision QA verification across Scratchbox visual surfaces ({status: 'unavailable'} when it cannot run). */
    async verifyVisual(request: VisualVerificationRequest): Promise<VisualVerificationOutcome> {
        return this.getVisualVerificationService().verifyVisual(request);
    }

    /** Multi-angle visual audit across canonical viewport camera angles. */
    async audit3DSceneMultiAngle(options: MultiAngleAuditOptions): Promise<MultiAngleVisualAuditResult | VisualAuditUnavailable> {
        return this.getVisualVerificationService().audit3DSceneMultiAngle(options);
    }

    /** Iterative multi-turn 3D self-correction loop using DirectDispatchOperatorEngine. */
    async run3DVisualSelfCorrectionLoop(options: VisualSelfCorrection3DOptions): Promise<VisualSelfCorrection3DLoopResult> {
        return this.getVisualVerificationService().run3DVisualSelfCorrectionLoop(options);
    }

    constructor() {
        // `GeminiClient` performs credential discovery on construction; nothing else to wire here.
    }

    // ------------------------------------------------------------------
    // Auth & status
    // ------------------------------------------------------------------

    /** Re-discover service-account credentials, e.g. after a new key file was written to disk. */
    reloadAuth(): void {
        this.client.initAuth();
    }

    getActiveModel(): string {
        return this.preferredModel;
    }

    /** Real-time connection status of the Gemini service. */
    async getStatus(): Promise<GeminiStatus> {
        return this.client.getStatus();
    }

    /** Save dynamic service account JSON or API key credentials to disk and reload auth. */
    async saveCredentialsDirectly(credentialsRaw: string, targetPath?: string): Promise<SaveCredentialsResponse> {
        try {
            const destPath = targetPath || path.join(os.homedir(), '.scratchbox-ide/service-account.json');
            fs.ensureDirSync(path.dirname(destPath));

            let parsedJson: unknown;
            try {
                parsedJson = JSON.parse(credentialsRaw);
            } catch {
                // If not raw JSON, check if it is an API key string
                const trimmedKey = credentialsRaw.trim();
                if (/^(AIza[0-9A-Za-z_-]{20,}|AQ\.[0-9A-Za-z_-]{20,}|[0-9A-Za-z_.-]{20,})$/.test(trimmedKey)) {
                    // Persist through the encrypted key store instead of plaintext ~/.scratchbox-ide/config.json.
                    const apiKey = trimmedKey;
                    await new FileKeyStore().setPassword(KEY_STORE_SERVICE, KEY_STORE_GEMINI_ACCOUNT, apiKey);
                    process.env.GEMINI_API_KEY = apiKey;

                    // Remove any legacy plaintext copy left by older builds.
                    const legacyConfigPath = path.join(os.homedir(), '.scratchbox-ide', 'config.json');
                    if (fs.existsSync(legacyConfigPath)) {
                        try {
                            const legacy = fs.readJSONSync(legacyConfigPath);
                            if (legacy && legacy.apiKey) {
                                delete legacy.apiKey;
                                fs.writeJSONSync(legacyConfigPath, legacy, { spaces: 2, mode: 0o600 });
                            }
                        } catch {
                            // Ignore unreadable legacy config
                        }
                    }

                    return {
                        success: true,
                        authMethod: 'api-key',
                        savedPath: defaultCredentialsPath()
                    };
                }
                throw new Error('Invalid JSON format. Expected Google Cloud Service Account JSON object.');
            }

            if (!isServiceAccountJson(parsedJson)) {
                throw new Error('Missing required fields: project_id and private_key in service account JSON.');
            }

            fs.writeJSONSync(destPath, parsedJson, { spaces: 2 });
            this.client.applyServiceAccount(parsedJson, destPath);

            return {
                success: true,
                authMethod: 'service-account',
                projectId: parsedJson.project_id,
                serviceAccount: parsedJson.client_email ? this.maskEmail(parsedJson.client_email) : undefined,
                savedPath: destPath
            };
        } catch (err: unknown) {
            return {
                success: false,
                authMethod: 'unauthenticated',
                error: errorMessage(err) || 'Failed to save credentials'
            };
        }
    }

    // ------------------------------------------------------------------
    // MCP
    // ------------------------------------------------------------------

    /** Test roundtrip latency and connectivity to an MCP server. */
    async pingMcpServer(server: {
        id: string;
        name: string;
        url?: string;
        command?: string;
        transport: 'sse' | 'stdio' | 'pipe' | 'stream';
        tools?: any[];
    }): Promise<McpPingResponse> {
        return this.mcp.pingMcpServer(server);
    }

    // ------------------------------------------------------------------
    // Subagent swarm
    // ------------------------------------------------------------------

    getSubagentPoolService(): SubagentPoolService {
        return this.swarm.getSubagentPoolService();
    }

    getPoolMetrics(): SubagentPoolMetrics {
        return this.swarm.getPoolMetrics();
    }

    async executeSwarmDAG(dag: SubagentDAGPlan): Promise<SubagentDAGResult> {
        return this.swarm.executeSwarmDAG(dag);
    }

    /** Candidate models for subagent tasks (gemini-3.5-flash-lite first, then fallbacks). */
    getSubagentModelCandidates(requestedModel?: string): string[] {
        return this.swarm.getSubagentModelCandidates(requestedModel);
    }

    /** Targeted system prompt for lightweight subagent tasks. */
    buildSubagentInstruction(request: SubagentRequest): string {
        return this.swarm.buildSubagentInstruction(request);
    }

    /** Execute a subagent background task using Gemini 3.5 Flash Lite / 3.1 Flash Lite. */
    async executeSubagentTask(request: SubagentRequest): Promise<SubagentResponse> {
        return this.swarm.executeSubagentTask(request);
    }

    // ------------------------------------------------------------------
    // Generation
    // ------------------------------------------------------------------

    /** Generate a structured canvas artifact with the primary model and optional subagent preprocessing. */
    async generateArtifact(request: GeminiGenerateRequest): Promise<GeminiGenerateResponse> {
        let finalResponse: GeminiGenerateResponse | undefined;
        const result = await this.streamGenerate(request, event => {
            if (event.type === 'done' || event.type === 'artifact_complete') {
                if (event.artifact) {
                    finalResponse = {
                        success: true,
                        text: event.text || '',
                        artifact: event.artifact,
                        mcpExecutions: event.mcpExecution ? [event.mcpExecution] : undefined,
                        modelUsed: event.modelUsed || this.preferredModel,
                        modelProvenance: event.modelProvenance,
                        usage: event.usage
                    };
                }
            }
        });

        if (finalResponse) {
            return finalResponse;
        }

        // A turn changes the canvas only through what the model wrote, in every mode. A reply in prose leaves the
        // open artifact as it is, so that is the artifact this turn produced (nothing is merged into it).
        if (result.success && request.activeArtifact) {
            return {
                ...result,
                text: result.text || '',
                artifact: request.activeArtifact,
                modelUsed: result.modelUsed || this.preferredModel
            };
        }

        throw new Error(result.success === false && result.error ? result.error : 'AI generation completed without producing an artifact');
    }

    /**
     * Streaming generation supporting live thoughts, subagent preprocessing, MCP tool execution,
     * and artifact synthesis. Pass `signal` to abort between turns.
     */
    async streamGenerate(
        request: GeminiGenerateRequest,
        onEvent: (event: GeminiStreamEvent) => void,
        signal?: AbortSignal
    ): Promise<GeminiGenerateResponse> {
        if (signal?.aborted) {
            throw new Error('Request aborted by client');
        }
        return this.streaming.streamGenerate(request, onEvent, signal);
    }

    /**
     * Complete code in-line using Fill-In-The-Middle (Scratchbox Tab Autocomplete).
     */
    async completeFim(request: FimCompletionRequest): Promise<FimCompletionResponse> {
        return this.fimService.complete(request);
    }

    /**
     * Transform in-editor code via instruction and return diff (Scratchbox ⌘K Studio Refactor).
     */
    async quickEditCode(request: QuickEditRequest): Promise<QuickEditResponse> {
        return this.quickEditService.executeQuickEdit(request);
    }

    // ------------------------------------------------------------------
    // Prompt compilation
    // ------------------------------------------------------------------

    /** Rich system instruction injecting canvas primitives, superpowers, workspace context and schemas. */
    private async buildSystemInstruction(request: GeminiGenerateRequest): Promise<string> {
        // As streamed turns get it: with the open-artifact rule while an artifact is open.
        return withOpenArtifactRule(await buildSystemInstruction(request, this.getPromptContextServices()), request.activeArtifact);
    }

    public async buildSystemInstructionPrompt(request: GeminiGenerateRequest): Promise<string> {
        return this.buildSystemInstruction(request);
    }

    /** Message contents array for Vertex AI and the AI Prompt Compiler. */
    public formatContents(request: GeminiGenerateRequest): any[] {
        return this.buildContents(request);
    }

    /**
     * Builds a first agent turn's payload for the workspace root once and throws it away (chat-prompt-warmup.ts), so the
     * first real turn after a start does not pay for the prompt builder's first run and the workspace pattern scan. No
     * model is called. Never rejects; start it without awaiting it once the server listens.
     */
    public warmChatPrompt(options: ChatPromptWarmupOptions = {}): Promise<ChatPromptWarmupReport> {
        return warmChatPrompt(request => this.streaming.buildFirstCallPayload(request, DEFAULT_CHAT_MODEL), options);
    }

    public async compilePrompt(request: GeminiGenerateRequest): Promise<{ systemInstruction?: string; contents: any[] }> {
        return {
            systemInstruction: await this.buildSystemInstruction(request),
            contents: this.buildContents(request)
        };
    }

    public buildContents(request: GeminiGenerateRequest): any[] {
        return buildContents(request);
    }

    /** Vertex `tools` payload (Google Search, code execution, function declarations) for a request. */
    private buildToolDeclarations(request: GeminiGenerateRequest): GeminiToolConfig[] | undefined {
        return this.streaming.buildToolDeclarations(request);
    }

    /** Synthesize live MCP tool execution telemetry for tools without a native handler. */
    private synthesizeMcpExecution(toolCall: GeminiFunctionCall, _request?: GeminiGenerateRequest): McpExecutionState {
        return this.mcp.synthesizeExecution(toolCall, this.lens);
    }

    // ------------------------------------------------------------------
    // Artifact synthesis
    // ------------------------------------------------------------------

    /** Convert a markdown string to structured MarkdownSection items. */
    public markdownStringToSections(md: string): MarkdownSection[] {
        return markdownStringToSections(md);
    }

    /** Turn the runnable code blocks in a reply into a live sandbox artifact; null when it has none. */
    public extractCodeSandboxArtifact(
        prompt: string,
        cleanContent: string,
        activeArtifact?: CanvasArtifact
    ): { artifact: CanvasArtifact; hasRunnableCode: boolean } | null {
        return extractCodeSandboxArtifact(prompt, cleanContent, activeArtifact);
    }

    /** Extract a rich, specific document title from prompt context, avoiding generic strings. */
    public extractDocumentTitle(prompt: string, fallback: string = 'Strategic Specification & Notes'): string {
        return extractDocumentTitle(prompt, fallback);
    }

    /** The canvas artifact the model wrote in its reply (primitive tag or JSON envelope), or undefined. */
    private parseOrSynthesizeArtifact(
        prompt: string,
        modelText: string,
        request: GeminiGenerateRequest,
        mcpExecutions: McpExecutionState[],
        groundingMetadata?: GroundingMetadata
    ): CanvasArtifact | undefined {
        return parseOrSynthesizeArtifact(prompt, modelText, request, mcpExecutions, groundingMetadata);
    }

    // ------------------------------------------------------------------
    // Media & research (structured placeholders pending live API wiring)
    // ------------------------------------------------------------------

    /**
     * Synthesizes speech with the Gemini TTS model named by SCRATCHBOX_TTS_MODEL, or DEFAULT_TTS_MODEL
     * (gemini-2.5-flash-preview-tts) when that is unset, through the same credentials as chat. Returns base64 WAV.
     * Throws MediaModelUnavailableError when the model returns no audio; there is no canned audio.
     */
    async synthesizeSpeech(req: GeminiTtsRequest): Promise<GeminiTtsResponse> {
        const { model } = resolveTtsModel(process.env.SCRATCHBOX_TTS_MODEL);
        const text = String(req.text ?? '').trim();
        if (!text) throw new MissingInputError('text-to-speech', 'text');
        // Gemini TTS is steered in natural language: style and pace go in the prompt.
        const directions = [
            req.stylePrompt?.trim(),
            typeof req.speed === 'number' && Number.isFinite(req.speed) && req.speed > 0 && req.speed !== 1 ? `Speak at ${req.speed}x normal pace.` : undefined
        ].filter(Boolean);
        const prompt = directions.length ? `${directions.join(' ')}\n\n${text}` : text;
        const { json } = await this.client.requestGenerateContent(model, [{ role: 'user', parts: [{ text: prompt }] }], undefined, {
            temperature: 1,
            maxOutputTokens: 8192,
            responseModalities: ['AUDIO'],
            ...(req.voice ? { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: req.voice } } } } : {})
        });
        const part = json.candidates?.[0]?.content?.parts?.find(p => p.inlineData?.data && /^audio\//i.test(p.inlineData.mimeType || ''));
        if (!part?.inlineData?.data) {
            const why = json.promptFeedback?.blockReason || json.candidates?.[0]?.finishReason || 'no audio part in the reply';
            throw new MediaModelUnavailableError(model, `the model returned no audio (${why})`);
        }
        return { success: true, audioContent: pcmToWavBase64(part.inlineData.data, part.inlineData.mimeType || '') };
    }

    /** Run deep research agent session. */
    async startDeepResearchSession(topic: string): Promise<any> {
        return {
            success: true,
            sessionId: `res-${Date.now()}`,
            topic,
            status: 'completed',
            findings: [
                'Model Context Protocol (MCP) is a standard protocol for connecting AI models to client-side data and tool APIs.',
                'Scratchbox Studio exposes a 63-tool suite across 3D, video, image, audio, maps, and document writing domains.',
                'The 4-Dimensional Media compositional architecture (Content, Space, Time, Lineage) ensures unified cross-app synchronization.'
            ],
            citations: [
                { title: 'Google GenAI Interactions API Specification', url: 'https://ai.google.dev/gemini-api/docs/interactions' },
                { title: 'Scratchbox Studio MCP Canvas Server docs', url: 'https://scratchbox.ai/docs/mcp-canvas' }
            ]
        };
    }

    // ------------------------------------------------------------------
    // Codebase lens
    // ------------------------------------------------------------------

    /** Project disk file or workspace content into a visual canvas primitive artifact. */
    async executeLensProject(
        filePath: string,
        sourceContent?: Record<string, string> | string,
        options?: { artifactId?: string; syncMode?: any; context?: any }
    ): Promise<{
        success: boolean;
        binding: CodebaseLensBinding;
        artifact: CanvasArtifact;
        error?: string;
    }> {
        return this.lens.executeLensProject(filePath, sourceContent, options as { artifactId?: string; syncMode?: LensSyncMode; context?: LensContext } | undefined);
    }

    /** Unproject visual canvas primitive data back into exact disk files. */
    async executeLensUnproject(
        artifactId: string,
        primitiveData: any,
        currentDiskContent?: Record<string, string> | string,
        context?: any
    ): Promise<{
        success: boolean;
        unprojection?: LensUnprojectionResult;
        error?: string;
    }> {
        return this.lens.executeLensUnproject(artifactId, primitiveData, currentDiskContent, context as LensContext | undefined);
    }

    /** List all active codebase lens bindings. */
    executeLensListBindings(): CodebaseLensBinding[] {
        return this.lens.executeLensListBindings();
    }

    /** Force bidirectional synchronization on a binding. */
    executeLensSync(
        artifactId: string,
        direction: 'in' | 'out',
        payload: { diskContent?: Record<string, string> | string; primitiveData?: any },
        context?: any
    ): { success: boolean; result?: any; error?: string } {
        return this.lens.executeLensSync(artifactId, direction, payload, context as LensContext | undefined);
    }

    private maskEmail(email: string): string {
        return maskEmail(email);
    }
}
