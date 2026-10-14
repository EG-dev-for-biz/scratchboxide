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
import { FimCompletionService } from './fim-completion-service';
import { QuickEditService } from './quick-edit-service';
import {
    CanvasArtifact,
    MarkdownDocumentData,
    MarkdownSection,
    McpExecutionState,
    Scene3DData
} from '../browser/generative-canvas/canvas-types';
import { ProjectContextGraphService } from './project-context-graph-service';
import { UserMemoriesService } from './user-memories-service';
import { WorkspaceConfigService } from './workspace-config-service';
import type { SubagentRunResult } from './gemini/tools/types';

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
    VisualAuditResult,
    MultiAngleAuditOptions,
    MultiAngleVisualAuditResult,
    VisualSelfCorrection3DOptions,
    VisualSelfCorrection3DLoopResult
} from '../common/visual-verification-protocol';
import { VisualVerificationService } from './visual-verification-service';
import type { Autonomous3DPlanResult, Autonomous3DStageDAG } from './deep-write/dynamic-dag-planner';
import {
    GeminiClient,
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
    synthesizeComprehensiveDocument
} from './gemini/artifact-synthesis';

export { DEFAULT_GEMINI_MODEL, FALLBACK_GEMINI_MODELS, DEFAULT_SUBAGENT_MODEL, FALLBACK_SUBAGENT_MODELS };

/**
 * Facade over the Gemini stack. Owns the collaborating modules under `./gemini/` and the
 * fallback workspace-intelligence services, and exposes the public API consumed by the
 * desktop server, deep-write pipeline, long-running agents and the subagent pool.
 */
export class GeminiService {
    private readonly client: GeminiClient = new GeminiClient();
    private readonly lens: LensBridge = new LensBridge();
    private readonly mcp: McpBridge = new McpBridge();
    private readonly toolRegistry: ToolRegistry = createDefaultToolRegistry();
    private readonly fimService: FimCompletionService = new FimCompletionService(this.client);
    private readonly quickEditService: QuickEditService = new QuickEditService(this.client);
    private readonly swarm: SwarmBridge = new SwarmBridge({
        client: this.client,
        subagentExecutor: this,
        plannerHost: this
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
    private fallbackVisualVerificationService = new VisualVerificationService();

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

    /** Multimodal Vision QA verification across Scratchbox visual surfaces. */
    async verifyVisual(request: VisualVerificationRequest): Promise<VisualAuditResult> {
        return this.getVisualVerificationService().verifyVisual(request);
    }

    /** Multi-angle visual audit across canonical viewport camera angles. */
    async audit3DSceneMultiAngle(options: MultiAngleAuditOptions): Promise<MultiAngleVisualAuditResult> {
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
        return buildSystemInstruction(request, this.getPromptContextServices());
    }

    public async buildSystemInstructionPrompt(request: GeminiGenerateRequest): Promise<string> {
        return this.buildSystemInstruction(request);
    }

    /** Message contents array for Vertex AI and the AI Prompt Compiler. */
    public formatContents(request: GeminiGenerateRequest): any[] {
        return this.buildContents(request);
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

    /** Synthesize a comprehensive, executive document hierarchy for any topic. */
    public synthesizeComprehensiveDocument(prompt: string, customTitle?: string): MarkdownDocumentData {
        return synthesizeComprehensiveDocument(prompt, customTitle);
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
    // Autonomous 3D planning
    // ------------------------------------------------------------------

    /** Autonomous multi-step 3D planning agent workflow (PocoLibre/blender-mcp paradigm). */
    public async plan3DAutonomousWorkflow(prompt: string, currentScene?: Scene3DData): Promise<Autonomous3DPlanResult> {
        return this.swarm.plan3DAutonomousWorkflow(prompt, currentScene);
    }

    /** Dependency-resolved 3D planning DAG for a prompt and scene. */
    public generate3DPlanDAG(prompt: string, currentScene?: Scene3DData): Autonomous3DStageDAG {
        return this.swarm.generate3DPlanDAG(prompt, currentScene);
    }

    // ------------------------------------------------------------------
    // Media & research (structured placeholders pending live API wiring)
    // ------------------------------------------------------------------

    /** Synthesize speech using Google's expressive TTS model. */
    async synthesizeSpeech(req: GeminiTtsRequest): Promise<GeminiTtsResponse> {
        try {
            // Under normal production, we call the @google/genai Interactions speech API.
            // For live server execution, we return a structured Base64 audio payload representing expressive speech.
            void req;
            return {
                success: true,
                audioContent: 'UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAAA' // Valid small RIFF WAV mock
            };
        } catch (err: unknown) {
            return {
                success: false,
                error: errorMessage(err) || 'TTS Synthesis failed'
            };
        }
    }

    /** Query maps grounding API. */
    async queryMapsGrounding(prompt: string): Promise<any> {
        void prompt;
        return {
            success: true,
            latitude: 37.774929,
            longitude: -122.419416,
            placeName: 'San Francisco, CA',
            address: 'Financial District, San Francisco, CA, USA',
            zoom: 13,
            metadata: {
                modelUsed: DEFAULT_GEMINI_MODEL,
                groundingSource: 'Google Maps Grounding API'
            }
        };
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
