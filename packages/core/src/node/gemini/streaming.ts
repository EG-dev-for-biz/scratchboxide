/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/
import type { Content, FunctionCall, Part } from '@google/genai';
import type {
    GeminiGenerateRequest,
    GeminiGenerateResponse,
    GeminiStreamEvent,
    GroundingMetadata,
    ModelAnswerProvenance,
    SubagentRequest,
    SubagentResponse
} from '../../common/gemini-protocol';
import type { CanvasArtifact, McpExecutionState } from '../../browser/generative-canvas/canvas-types';
import type { StageEvent } from '../../common/spatial/staged-location-contracts';
import {
    DEFAULT_SUBAGENT_MODEL,
    GeminiClient,
    isModelNotFoundError,
    resolveFetch,
    summarizeModelError,
    type FetchLike,
    type GeminiThinkingConfig,
    type VertexGenerateContentJson
} from './gemini-client';
import { compactChatHistory, HISTORY_SUMMARY_INSTRUCTION } from './history-compaction';
import { toolBlockedReason } from './tool-permissions';
import { resolveToolTimeBudget } from './tool-time-budgets';
import {
    buildToolDeclarations,
    inferToolGroup,
    type GeminiFunctionCall,
    type GeminiToolConfig,
    type ToolContext,
    type ToolExecutionResult,
    type ToolRegistry
} from './tool-registry';
import type { McpBridge } from './mcp-bridge';
import type { LensBridge } from './lens-bridge';
import { buildContents, buildSystemInstruction, type PromptContextServices } from './prompt-builder';
import { buildPendingPythonGenerator, continueTurnArtifact, parseOrSynthesizeArtifact, withOpenArtifactRule } from './artifact-synthesis';
import { AgentVerificationService } from './agent-verification-service';

export type StreamEventSink = (event: GeminiStreamEvent) => void;

/** The artifact the model wrote in its reply (tag or JSON envelope), or undefined; never built from the prompt. */
export type ArtifactSynthesizer = (
    prompt: string,
    modelText: string,
    request: GeminiGenerateRequest,
    mcpExecutions: McpExecutionState[],
    groundingMetadata?: GroundingMetadata
) => CanvasArtifact | undefined;

export interface StreamingEngineOptions {
    client: GeminiClient;
    registry: ToolRegistry;
    mcp: McpBridge;
    lens: LensBridge;
    /** Resolved lazily so facade subclasses that inject services after construction are honoured. */
    promptServices: () => PromptContextServices;
    /** Builds the per-request `ToolContext` handed to tool handlers. */
    toolContext: (request: GeminiGenerateRequest) => ToolContext;
    /** Runs subagent preprocessing; normally the facade so overrides are honoured. */
    executeSubagentTask: (request: SubagentRequest) => Promise<SubagentResponse>;
    /** Override for artifact synthesis (defaults to `parseOrSynthesizeArtifact`). */
    synthesizeArtifact?: ArtifactSynthesizer;
}

type UsageMetadata = NonNullable<GeminiStreamEvent['usage']> & Record<string, unknown>;

interface VertexStreamPayload {
    contents: Content[];
    systemInstruction: Content;
    generationConfig: {
        temperature: number;
        maxOutputTokens: number;
        thinkingConfig: GeminiThinkingConfig;
    };
    tools?: GeminiToolConfig[];
}

interface AgentInteractionPayload {
    input: string;
    stream: boolean;
    environment: string;
    previous_interaction_id?: string;
    system_instruction?: string;
    generation_config?: { temperature: number };
}

/** Loosely-typed step emitted by the Vertex agent `interact` SSE stream. */
interface AgentStep {
    type?: string;
    id?: string;
    text?: string;
    summary?: { text?: string };
    arguments?: Record<string, unknown> & { code?: string };
    content?: unknown;
}

interface AgentInteractionChunk {
    id?: string;
    environment_id?: string;
    environmentId?: string;
    steps?: AgentStep[];
    interaction?: {
        id?: string;
        environment_id?: string;
        environmentId?: string;
        steps?: AgentStep[];
    };
}

interface AgentStreamState {
    interactionId: string;
    environmentId: string;
    accumulatedText: string;
    accumulatedThoughts: string[];
    emittedTextPerStep: Map<string, string>;
    emittedThoughtsPerStep: Map<string, string>;
}

/** Minimal view of a fetch response body: WHATWG stream, Node stream, or neither. */
interface WebReadableLike {
    getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> };
}
interface NodeReadableLike {
    on(event: 'data', listener: (chunk: Buffer) => void): unknown;
    on(event: 'end', listener: () => void): unknown;
    on(event: 'error', listener: (err: Error) => void): unknown;
}

type StreamResponse = Awaited<ReturnType<FetchLike>>;

export function createAbortError(): Error {
    const err = new Error('Request aborted by client');
    err.name = 'AbortError';
    return err;
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
        throw createAbortError();
    }
}

// The default limit for one tool call; tools that legitimately run longer declare a budget in tool-time-budgets.ts.
const DEFAULT_TOOL_TIMEOUT_MS = 5 * 60_000;
const TOOL_HEARTBEAT_MS = 15_000;

export function resolveToolTimeoutMs(): number {
    const fromEnv = Number(process.env.SCRATCHBOX_TOOL_TIMEOUT_MS);
    return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_TOOL_TIMEOUT_MS;
}

/** "45s" under two minutes, else "11 min". */
function formatDuration(ms: number): string {
    return ms < 120_000 ? `${Number((ms / 1000).toFixed(1))}s` : `${Math.round(ms / 60_000)} min`;
}

/** The card shown while a tool runs; the finished result replaces it (same id). */
function runningExecution(id: string, toolName: string, args: Record<string, unknown> | undefined, progress: string): McpExecutionState {
    return {
        id,
        mcpServerId: 'scratchbox-tool-progress',
        mcpName: 'Scratchbox',
        toolName,
        humanTitle: toolName,
        status: 'running',
        timestamp: new Date().toLocaleTimeString(),
        steps: [{ id: 's1', title: `Run ${toolName}`, status: 'running' }],
        summaryResult: progress,
        args: args as Record<string, any> | undefined
    };
}

/** User-facing explanation for a model turn that ended with no text, tool result or artifact. */
export function describeEmptyModelReply(finishReason?: string): string {
    const reason = finishReason ? ` (finish reason: ${finishReason})` : '';
    if (finishReason === 'MAX_TOKENS') {
        return `The model ran out of output space before it finished its reply${reason}. Try a smaller request or break it into steps.`;
    }
    if (finishReason && /SAFETY|PROHIBITED_CONTENT|BLOCKLIST|SPII|RECITATION/.test(finishReason)) {
        return `Google's safety filters blocked the model's reply${reason}. Try rephrasing the request.`;
    }
    if (finishReason && /FUNCTION_CALL|TOOL_CALL/.test(finishReason)) {
        return `The model produced a tool call the app could not run${reason}. Try sending the request again.`;
    }
    return `The model returned an empty reply${reason}. Try sending the request again.`;
}

export type StreamAuth =
    | { type: 'vertex'; token: string; projectId: string }
    | { type: 'api-key'; apiKey: string };

/**
 * One line for a helper call (e.g. skill preprocessing) that was not answered by its requested model or by the
 * service account, naming what answered instead and why; undefined when it ran as requested.
 */
export function describeHelperProvenance(role: string, p: ModelAnswerProvenance | undefined): string | undefined {
    if (!p) return undefined;
    const parts: string[] = [];
    if (p.modelUsed !== p.requestedModel) parts.push(`answered by ${p.modelUsed} — ${p.fallbackReason || `${p.requestedModel} unavailable`}`);
    if (p.credentialNote) parts.push(`answered with the Gemini API key — ${p.credentialNote}`);
    return parts.length > 0 ? `${role} ${parts.join('; ')}` : undefined;
}

/**
 * Adds which model and credential answered to the turn's closing events (`done`, `error`). Read when the event is
 * sent, so helper notes added during the turn (history summary) are on it.
 */
function withProvenance(onEvent: StreamEventSink, provenance: () => ModelAnswerProvenance): StreamEventSink {
    return event => onEvent(event.type === 'done' || event.type === 'error' ? { ...event, modelProvenance: provenance() } : event);
}

/** A turn's error that says which model and credential it came from (forwarded on the stream's error event). */
export type ErrorWithProvenance = Error & { modelProvenance?: ModelAnswerProvenance };

/** The provenance attached to a turn's thrown error, if any. */
export function provenanceOfError(err: unknown): ModelAnswerProvenance | undefined {
    return err && typeof err === 'object' ? (err as ErrorWithProvenance).modelProvenance : undefined;
}

/** State shared by the attempts of one turn (one attempt per model in the fallback list). */
interface TurnAttemptState {
    /** Set once a model streamed anything: a later "not found" ends the turn instead of replaying it. */
    modelResponded: boolean;
    /** The model of the attempt running now (or that failed last). */
    currentModel?: string;
    /** Helper calls of the turn that fell back or failed (shown on the reply). */
    helperNotes: string[];
}

/**
 * The `streamGenerate` core: Vertex SSE consumption, event shaping, the multi-turn tool-call
 * (ReAct) loop, grounding-metadata merging, agent interactions, and final artifact synthesis.
 */
export class StreamingEngine {
    private readonly client: GeminiClient;
    private readonly registry: ToolRegistry;
    private readonly mcp: McpBridge;
    private readonly lens: LensBridge;
    private readonly promptServices: () => PromptContextServices;
    private readonly toolContext: (request: GeminiGenerateRequest) => ToolContext;
    private readonly executeSubagentTask: (request: SubagentRequest) => Promise<SubagentResponse>;
    private readonly synthesizeArtifact: ArtifactSynthesizer;

    constructor(options: StreamingEngineOptions) {
        this.client = options.client;
        this.registry = options.registry;
        this.mcp = options.mcp;
        this.lens = options.lens;
        this.promptServices = options.promptServices;
        this.toolContext = options.toolContext;
        this.executeSubagentTask = options.executeSubagentTask;
        this.synthesizeArtifact = options.synthesizeArtifact || parseOrSynthesizeArtifact;
    }

    /** Vertex `tools` payload for a request (built-in suites, attached MCP tools, search, code execution). */
    buildToolDeclarations(request: GeminiGenerateRequest): GeminiToolConfig[] | undefined {
        return buildToolDeclarations(request, this.registry, this.mcp.buildFunctionDeclarations(request.attachedMcpTools));
    }

    /**
     * Streaming generation supporting live thoughts, subagent preprocessing, tool execution
     * and artifact synthesis. `signal` aborts between turns and is forwarded to fetch.
     */
    async streamGenerate(
        request: GeminiGenerateRequest,
        onEvent: StreamEventSink,
        signal?: AbortSignal
    ): Promise<GeminiGenerateResponse> {
        throwIfAborted(signal);

        // Vertex (service account) is preferred; the Gemini API key answers when there is no service account, or when
        // one is configured but cannot issue a token. The second case is a credential fallback, so it is recorded
        // and shown on the reply (credentialNote) rather than taken silently.
        let streamAuth: StreamAuth | undefined;
        let credentialNote: string | undefined;
        // ensureAuth re-runs discovery, as getAccessToken does: a service account added since startup is found here
        // too, so a token failure on it is reported rather than the API key answering silently.
        const serviceAccountConfigured = this.client.ensureAuth();
        try {
            const { token, projectId } = await this.client.getAccessToken();
            if (token && projectId) {
                streamAuth = { type: 'vertex', token, projectId };
            }
        } catch (err) {
            if (serviceAccountConfigured) {
                credentialNote = `the Vertex AI service account could not get an access token (${summarizeModelError(err)})`;
            }
        }

        if (!streamAuth) {
            const apiKey = await this.client.resolveApiKey();
            if (apiKey) {
                streamAuth = { type: 'api-key', apiKey };
            } else {
                throw new Error(credentialNote
                    ? `No Gemini API key is configured, and ${credentialNote}.`
                    : 'No Google Cloud service account or Gemini API key configured.');
            }
        }

        // If agent is specified, route to Agentic Interaction
        if (request.agent) {
            if (streamAuth.type !== 'vertex') {
                throw new Error(`Vertex agent interaction (${request.agent}) requires a Google Cloud service account.`);
            }
            return this.executeVertexAgentInteraction(request.agent, streamAuth.projectId, streamAuth.token, request, onEvent, signal);
        }

        // Helper calls of this turn that did not run on their requested model or on the service account (shown on the reply).
        const helperNotes: string[] = [];

        // Run subagent preprocessing if requested and there are complex multi-skills attached
        if (request.enableSubagentPreprocess && request.attachedSkills && request.attachedSkills.length > 1) {
            try {
                onEvent({
                    type: 'subagent_start',
                    text: 'Subagent analyzing attached skills and formulating strategic approach...'
                });
                const subagentRes = await this.executeSubagentTask({
                    taskType: 'preprocess',
                    prompt: `Prioritize skills and structure initial guidance for prompt: "${request.prompt}"`,
                    attachedSkills: request.attachedSkills,
                    attachedMcpTools: request.attachedMcpTools
                });
                onEvent({
                    type: 'subagent_done',
                    text: subagentRes.result,
                    subagentResult: subagentRes
                });
                const note = describeHelperProvenance('Skill preprocessing', subagentRes.modelProvenance);
                if (note) {
                    helperNotes.push(note);
                    onEvent({ type: 'status', text: note });
                }
            } catch (err) {
                // Preprocessing is advisory; the turn goes on without it, and the reply says so.
                const note = `Skill preprocessing failed (${summarizeModelError(err)}); answered without it`;
                helperNotes.push(note);
                onEvent({ type: 'subagent_done', text: `${note}.` });
                onEvent({ type: 'status', text: `${note}.` });
            }
        }

        throwIfAborted(signal);
        const attempt: TurnAttemptState = { modelResponded: false, helperNotes };
        // The fallback list stays, but every turn starts from the requested (or configured) model again: a model that
        // answered once is not made the default for later turns. Each skipped model is reported with its reason.
        const candidates = this.client.getModelCandidates(request.model);
        const skipped: Array<{ model: string; reason: string }> = [];
        const auth = streamAuth;
        const provenanceFor = (modelUsed: string): ModelAnswerProvenance => ({
            requestedModel: candidates[0],
            modelUsed,
            ...(modelUsed !== candidates[0] && skipped.length > 0
                ? { fallbackReason: skipped.map(s => `${s.model} unavailable: ${s.reason}`).join('; ') }
                : {}),
            credential: auth.type,
            ...(credentialNote ? { credentialNote } : {}),
            ...(helperNotes.length > 0 ? { helperNotes } : {})
        });
        let response: GeminiGenerateResponse;
        try {
            response = await this.client.withModelFallback(
                candidates,
                targetModel => {
                    attempt.currentModel = targetModel;
                    return this.executeVertexGeneration(targetModel, auth, request, withProvenance(onEvent, () => provenanceFor(targetModel)), signal, attempt);
                },
                {
                    onFallback: (model, reason, nextModel) => {
                        skipped.push({ model, reason });
                        // The status carries the provenance of the model now asked, so a reply stopped or cut short
                        // from here on still says that another model is answering, and why.
                        onEvent({ type: 'status', text: `${model} is not available (${reason}); trying ${nextModel}.`, modelProvenance: provenanceFor(nextModel) });
                    },
                    // Partial output may already have been streamed; never replay a turn.
                    retryTransient: false,
                    // A missing model fails its first request. Once a model has answered, tools may have run (some for
                    // many minutes): a later "not found" must end the turn, not replay it on the next model.
                    canFallback: () => !attempt.modelResponded
                }
            );
        } catch (err) {
            // A turn that fails (an HTTP error from a fallback model, a dropped stream, the API key refusing after a
            // token failure) still says which model and credential it was on; the route forwards this on its error event.
            if (err instanceof Error && !provenanceOfError(err)) {
                const everyModelUnavailable = !attempt.modelResponded && skipped.length === candidates.length - 1 && isModelNotFoundError((err as Error & { cause?: unknown }).cause ?? err);
                const last = attempt.currentModel || candidates[0];
                (err as ErrorWithProvenance).modelProvenance = {
                    ...provenanceFor(last),
                    ...(everyModelUnavailable ? { noModelAnswered: true } : {})
                };
            }
            throw err;
        }
        return { ...response, modelProvenance: provenanceFor(response.modelUsed) };
    }

    // ------------------------------------------------------------------
    // Vertex agent interactions
    // ------------------------------------------------------------------

    private async executeVertexAgentInteraction(
        agent: string,
        projectId: string,
        token: string,
        request: GeminiGenerateRequest,
        onEvent: StreamEventSink,
        signal?: AbortSignal
    ): Promise<GeminiGenerateResponse> {
        const url = this.client.vertexAgentUrl(projectId, agent);

        const payload: AgentInteractionPayload = {
            input: request.prompt,
            stream: true,
            environment: request.environment || 'remote'
        };
        if (request.previousInteractionId) {
            payload.previous_interaction_id = request.previousInteractionId;
        }
        if (request.systemInstruction) {
            payload.system_instruction = request.systemInstruction;
        }
        if (request.temperature !== undefined) {
            payload.generation_config = { temperature: request.temperature };
        }

        onEvent({
            type: 'status',
            text: `Initiating agentic interaction with ${agent}...`,
            modelUsed: agent
        });

        const fetchFn = resolveFetch();
        const response = await fetchFn(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'Api-Revision': '2026-05-20'
            },
            body: JSON.stringify(payload),
            signal
        });

        if (!response.ok) {
            const errBody = await response.text();
            throw new Error(`Agent interaction failed (${response.status}): ${errBody}`);
        }

        const state: AgentStreamState = {
            interactionId: request.previousInteractionId || '',
            environmentId: typeof request.environment === 'string' ? request.environment : '',
            accumulatedText: '',
            accumulatedThoughts: [],
            emittedTextPerStep: new Map<string, string>(),
            emittedThoughtsPerStep: new Map<string, string>()
        };

        await this.consumeSseLines(response, line => {
            const parsed = parseSseDataLine(line);
            if (parsed) {
                this.processAgentChunk(parsed as AgentInteractionChunk, state, agent, onEvent);
            }
        });

        const artifact = await buildPendingPythonGenerator(this.synthesizeArtifact(request.prompt, state.accumulatedText, request, []), signal);

        const summary = {
            text: state.accumulatedText,
            artifact,
            interactionId: state.interactionId,
            environmentId: state.environmentId,
            modelUsed: agent
        };
        // A reply in prose yields no artifact; there is nothing to announce as complete.
        if (artifact) {
            onEvent({ type: 'artifact_complete', ...summary });
        }
        const modelProvenance: ModelAnswerProvenance = { requestedModel: agent, modelUsed: agent, credential: 'vertex' };
        onEvent({ type: 'done', ...summary, modelProvenance });

        return {
            success: true,
            thoughts: state.accumulatedThoughts,
            ...summary,
            modelProvenance
        };
    }

    private processAgentChunk(
        chunk: AgentInteractionChunk,
        state: AgentStreamState,
        agent: string,
        onEvent: StreamEventSink
    ): void {
        if (!chunk) return;

        // Extract and update interaction/environment IDs
        const currentId = chunk.id || chunk.interaction?.id || '';
        const currentEnvId = chunk.environment_id || chunk.environmentId || chunk.interaction?.environment_id || chunk.interaction?.environmentId || '';
        if (currentId) state.interactionId = currentId;
        if (currentEnvId) state.environmentId = currentEnvId;

        const { interactionId, environmentId } = state;
        const steps = chunk.steps || chunk.interaction?.steps || [];
        if (!Array.isArray(steps) || steps.length === 0) return;

        for (let i = 0; i < steps.length; i++) {
            const step = steps[i];
            if (!step || !step.type) continue;

            const stepKey = `${i}-${step.type}`;

            if (step.type === 'thought') {
                const previouslyEmittedThought = state.emittedThoughtsPerStep.get(stepKey) || '';
                const currentThought = step.summary?.text || step.text || '';
                if (currentThought.length > previouslyEmittedThought.length) {
                    const deltaThought = currentThought.slice(previouslyEmittedThought.length);
                    state.emittedThoughtsPerStep.set(stepKey, currentThought);
                    state.accumulatedThoughts.push(deltaThought);
                    onEvent({ type: 'thought', thought: deltaThought, interactionId, environmentId, modelUsed: agent });
                }
            } else if (step.type === 'google_search_call' || step.type === 'code_execution_call') {
                if (!state.emittedTextPerStep.has(stepKey)) {
                    state.emittedTextPerStep.set(stepKey, 'processed');
                    const isSearch = step.type === 'google_search_call';
                    onEvent({
                        type: 'mcp_call',
                        toolCall: {
                            id: step.id || `call-${isSearch ? 'search' : 'code'}-${i}-${Date.now()}`,
                            name: step.type,
                            args: step.arguments || {}
                        },
                        interactionId,
                        environmentId,
                        modelUsed: agent
                    });
                    onEvent({
                        type: 'status',
                        text: isSearch
                            ? `Google Search active: ${JSON.stringify(step.arguments || {})}`
                            : `Code Execution active: ${step.arguments?.code || ''}`,
                        interactionId,
                        environmentId,
                        modelUsed: agent
                    });
                }
            } else if (step.type === 'model_output') {
                const stepText = extractAgentStepText(step);
                const previouslyEmitted = state.emittedTextPerStep.get(stepKey) || '';
                if (stepText.length > previouslyEmitted.length) {
                    const deltaText = stepText.slice(previouslyEmitted.length);
                    state.emittedTextPerStep.set(stepKey, stepText);
                    state.accumulatedText += deltaText;
                    onEvent({ type: 'delta', text: deltaText, interactionId, environmentId, modelUsed: agent });
                }
            }
        }
    }

    // ------------------------------------------------------------------
    // Vertex model generation (multi-turn ReAct loop)
    // ------------------------------------------------------------------

    private async executeVertexGeneration(
        model: string,
        auth: StreamAuth,
        request: GeminiGenerateRequest,
        onEvent: StreamEventSink,
        signal?: AbortSignal,
        attempt: TurnAttemptState = { modelResponded: false, helperNotes: [] }
    ): Promise<GeminiGenerateResponse> {
        const url = auth.type === 'vertex'
            ? this.client.vertexModelUrl(auth.projectId, model, 'streamGenerateContent')
            : `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(auth.apiKey)}`;

        // While an artifact is open, the model is told how to continue it or start a new one (the reply's tag or
        // envelope is read that way by artifact synthesis).
        const systemInstructionText = withOpenArtifactRule(await buildSystemInstruction(request, this.promptServices()), request.activeArtifact);
        // The summary of older turns is a helper call: when the API key answered it, or it failed and the older
        // turns were dropped, the reply says so (helperNotes), not only a passing status line.
        const addHelperNote = (note: string) => {
            if (!attempt.helperNotes.includes(note)) attempt.helperNotes.push(note);
            onEvent({ type: 'status', text: `${note}.` });
        };
        request.chatHistory = await compactChatHistory(request.chatHistory, transcript =>
            this.client.generateContent({
                model: DEFAULT_SUBAGENT_MODEL,
                systemInstruction: HISTORY_SUMMARY_INSTRUCTION,
                prompt: transcript,
                temperature: 0.2,
                maxOutputTokens: 8192
            }).then(r => {
                if (r.credentialNote) {
                    addHelperNote(`Earlier messages were summarized by ${DEFAULT_SUBAGENT_MODEL} with the Gemini API key — ${r.credentialNote}`);
                }
                return r.text;
            }),
            undefined,
            undefined,
            (dropped, error) => addHelperNote(`${dropped} earlier message${dropped === 1 ? ' was' : 's were'} left out of the context: summarizing them with ${DEFAULT_SUBAGENT_MODEL} failed (${summarizeModelError(error)})`)
        );
        const contents = buildContents(request);
        const tools = this.buildToolDeclarations(request);

        const payload: VertexStreamPayload = {
            contents,
            systemInstruction: {
                role: 'system',
                parts: [{ text: systemInstructionText }]
            },
            generationConfig: {
                temperature: request.temperature !== undefined ? request.temperature : 0.7,
                // Tool calls that carry a whole generated app run ~5k tokens; at 8192 they were cut off (MAX_TOKENS).
                maxOutputTokens: 32768,
                thinkingConfig: this.client.getThinkingConfig(request, model)
            }
        };
        if (tools && tools.length > 0) {
            // Gemini 3+ accepts googleSearch alongside functionDeclarations; earlier models reject the combination.
            const hasFunctionDeclarations = tools.some(t => 'functionDeclarations' in t && Array.isArray(t.functionDeclarations) && t.functionDeclarations.length > 0);
            const supportsMixedTools = Number(/^gemini-(\d+)/.exec(model)?.[1] ?? 0) >= 3;
            if (hasFunctionDeclarations && !supportsMixedTools) {
                if (request.requireGoogleSearch) {
                    throw new Error(`@web needs Google Search grounding, but ${model} cannot take the search tool together with function tools; choose a Gemini 3 model or remove @web`);
                }
                payload.tools = tools.filter(t => 'functionDeclarations' in t);
            } else {
                payload.tools = tools;
            }
        }

        onEvent({
            type: 'status',
            text: 'Connected to Studio AI Engine with Thinking active...',
            modelUsed: model
        });

        const fetchFn = resolveFetch();
        // Rounds of tool calls before the run stops and asks to continue.
        const maxTurns = request.maxTurns || 40;
        let hitTurnLimit = false;
        let awaitingUser = false;
        let currentTurn = 0;
        const modifiedFiles = new Set<string>();
        let verificationAttempts = 0;
        const maxVerificationAttempts = 2;

        let accumulatedText = '';
        const accumulatedThoughts: string[] = [];
        const mcpExecutions: McpExecutionState[] = [];
        let accumulatedGroundingMetadata: GroundingMetadata | undefined;
        let finalUsage: UsageMetadata | undefined;
        let streamMountedArtifact: CanvasArtifact | undefined = undefined;
        let streamQuestionCard: any = undefined;
        let streamExecutionPlanCard: any = undefined;
        let lastFinishReason: string | undefined;

        const mergeGrounding = (g: GroundingMetadata): void => {
            accumulatedGroundingMetadata = mergeGroundingMetadata(accumulatedGroundingMetadata, g);
        };

        const headers: Record<string, string> = {
            'Content-Type': 'application/json'
        };
        if (auth.type === 'vertex') {
            headers['Authorization'] = `Bearer ${auth.token}`;
        }

        while (currentTurn < maxTurns) {
            throwIfAborted(signal);
            currentTurn++;
            const turnDetectedToolCalls: FunctionCall[] = [];
            let turnText = '';

            if (auth.type === 'vertex' && currentTurn > 1) {
                // The token was taken when the turn started and lasts about an hour; a long tool call can outlive it.
                // getAccessToken returns the cached token, refreshing it when it is close to expiry.
                try {
                    headers['Authorization'] = `Bearer ${(await this.client.getAccessToken()).token}`;
                } catch {
                    // Keep the current token; if it has expired the request below reports the 401.
                }
            }

            const response = await fetchFn(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload),
                signal
            });

            if (!response.ok) {
                const errBody = await response.text();
                throw new Error(`AI request failed (${response.status}): ${errBody}`);
            }
            attempt.modelResponded = true;

            await this.consumeSseLines(response, line => {
                const parsed = parseSseDataLine(line);
                if (parsed) {
                    this.processChunk(
                        parsed as VertexGenerateContentJson,
                        accumulatedThoughts,
                        turnDetectedToolCalls,
                        model,
                        onEvent,
                        chunkText => {
                            accumulatedText += chunkText;
                            turnText += chunkText;
                        },
                        usage => { finalUsage = usage; },
                        mergeGrounding,
                        reason => { lastFinishReason = reason; }
                    );
                }
            });

            // If no tools requested this turn, check for planning completion or verification
            if (turnDetectedToolCalls.length === 0) {
                // In plan mode, emit plan_ready event
                if (request.mode === 'plan') {
                    onEvent({
                        type: 'plan_ready',
                        planApprovalRequired: request.requirePlanApproval !== false,
                        text: turnText || accumulatedText,
                        modelUsed: model
                    });
                    break;
                }

                // In agent mode (or if autoVerify is explicitly requested), verify modified files and self-heal
                const shouldVerify = (request.mode === 'agent' || request.autoVerify) && modifiedFiles.size > 0;
                if (shouldVerify && verificationAttempts < maxVerificationAttempts) {
                    verificationAttempts++;
                    onEvent({
                        type: 'verification_start',
                        modelUsed: model
                    });

                    const toolCtx = this.toolContext(request);
                    const verifier = new AgentVerificationService(toolCtx.lsp, toolCtx.sandbox);
                    const outcome = await verifier.verify({
                        workspaceRoot: toolCtx.workspaceRoot,
                        modifiedFiles: Array.from(modifiedFiles),
                        // A full test run per edit is too slow for chat; the typecheck runs every time.
                        runTests: false
                    });

                    onEvent({
                        type: 'verification_result',
                        verification: outcome,
                        modelUsed: model
                    });

                    if (!outcome.passed) {
                        // Diagnostic errors detected: initiate self-healing turn
                        payload.contents.push({ role: 'model', parts: [{ text: turnText || accumulatedText }] });
                        payload.contents.push({
                            role: 'user',
                            parts: [{
                                text: `[AUTOMATED VERIFICATION FEEDBACK]\n${outcome.summary || ''}\n\nRead the failing lines, find the cause, and fix it with workspace tools.`
                            }]
                        });
                        continue;
                    }
                }

                break;
            }

            // Execute all requested tools
            const toolResponseParts: Part[] = [];
            const modelParts: Part[] = [];
            if (turnText) {
                modelParts.push({ text: turnText });
            }

            for (const toolCall of turnDetectedToolCalls) {
                throwIfAborted(signal);
                const toolName = toolCall.name || '';
                const rawToolCall = toolCall as any;
                const sig = rawToolCall.thought_signature ||
                            rawToolCall.thoughtSignature ||
                            'skip_thought_signature_validator';
                modelParts.push({
                    functionCall: {
                        name: toolName,
                        args: toolCall.args || {}
                    },
                    thought_signature: sig
                } as any);

                if (toolName === 'workspace_write_file' || toolName === 'workspace_apply_diff') {
                    const fp = (toolCall.args as any)?.filePath;
                    if (typeof fp === 'string') {
                        modifiedFiles.add(fp);
                    }
                }

                const { exec, resultPayload } = await this.executeToolCallWithDeadline({ id: toolCall.id, name: toolName, args: toolCall.args }, request, onEvent, model, signal);
                mcpExecutions.push(exec);

                if (toolName === 'mount_canvas_primitive' || (resultPayload && (resultPayload as any).artifact)) {
                    const mountedArtifact: CanvasArtifact | undefined = (resultPayload as any)?.artifact
                        ? continueTurnArtifact(streamMountedArtifact, (resultPayload as any).artifact as CanvasArtifact)
                        : undefined;
                    if (mountedArtifact) {
                        // The model reads the result too: it names the artifact by the id the canvas shows.
                        (resultPayload as any).artifact = mountedArtifact;
                        request.activeArtifact = mountedArtifact;
                        streamMountedArtifact = mountedArtifact;
                        onEvent({ type: 'artifact_start', artifact: mountedArtifact, modelUsed: model });
                        onEvent({ type: 'artifact_complete', artifact: mountedArtifact, modelUsed: model });
                    }
                }

                if (toolName === 'ask_user_question' || (resultPayload && (resultPayload as any).questionCard)) {
                    const questionCard = (resultPayload as any).questionCard;
                    if (questionCard) {
                        streamQuestionCard = questionCard;
                        onEvent({ type: 'question_card', questionCard, modelUsed: model });
                    }
                }

                if (toolName === 'present_execution_plan' || (resultPayload && (resultPayload as any).executionPlanCard)) {
                    const executionPlanCard = (resultPayload as any).executionPlanCard;
                    if (executionPlanCard) {
                        streamExecutionPlanCard = executionPlanCard;
                        onEvent({ type: 'execution_plan_card', executionPlanCard, modelUsed: model });
                    }
                }

                if (resultPayload && Array.isArray((resultPayload as any).taskList)) {
                    onEvent({ type: 'task_list', taskList: (resultPayload as any).taskList, modelUsed: model });
                }

                if ((resultPayload as any)?.questionCard || (resultPayload as any)?.executionPlanCard) {
                    awaitingUser = true;
                }

                const callId = toolCall.id || `call-${Date.now()}`;
                const toolResult = { id: callId, name: toolName, result: resultPayload };
                onEvent({ type: 'tool_result', mcpExecution: exec, toolResult, modelUsed: model });

                toolResponseParts.push({
                    functionResponse: {
                        name: toolName,
                        response: {
                            name: toolName,
                            content: toolResultForModel(toolName, exec, resultPayload)
                        }
                    }
                });
            }

            // Append assistant model turn with functionCalls and user turn with functionResponses
            payload.contents.push({ role: 'model', parts: modelParts });
            payload.contents.push({ role: 'user', parts: toolResponseParts });

            // A question or plan card is a request for the user's decision: stop and wait for it.
            if (awaitingUser) {
                onEvent({ type: 'status', text: 'Waiting for your answer...', modelUsed: model });
                break;
            }
            if (currentTurn >= maxTurns) {
                hitTurnLimit = true;
                break;
            }

            onEvent({
                type: 'status',
                text: `Executed ${turnDetectedToolCalls.length} tool(s). Reasoning on turn ${currentTurn + 1}/${maxTurns}...`,
                modelUsed: model
            });
        }

        if (hitTurnLimit) {
            const notice = `\n\n---\nI stopped after ${maxTurns} rounds of tool calls before finishing. Reply "continue" to pick up where I left off.`;
            accumulatedText += notice;
            onEvent({ type: 'delta', text: notice, modelUsed: model });
        }

        // Building an artifact from the prompt alone would present a template as if the model had made it.
        if (!accumulatedText.trim() && !streamMountedArtifact && !streamQuestionCard && !streamExecutionPlanCard) {
            const error = describeEmptyModelReply(lastFinishReason);
            onEvent({ type: 'error', error, modelUsed: model });
            return { success: false, error, text: '', thoughts: accumulatedThoughts, mcpExecutions, modelUsed: model, usage: finalUsage };
        }

        // Canvas artifacts come from mount_canvas_primitive or from a tag / JSON envelope the model wrote, in every
        // mode. Synthesizing from prompt keywords (e.g. "World Cup" -> "world") invented documents and scenes the model
        // never wrote, so a prose reply leaves the canvas as it is.
        const artifact = streamMountedArtifact
            || await buildPendingPythonGenerator(this.synthesizeArtifact(request.prompt, accumulatedText, request, mcpExecutions, accumulatedGroundingMetadata), signal);

        if (request.requireGoogleSearch) {
            const g = accumulatedGroundingMetadata as { webSearchQueries?: string[]; groundingChunks?: unknown[] } | undefined;
            const searched = (g?.webSearchQueries?.length ?? 0) > 0 || (g?.groundingChunks?.length ?? 0) > 0;
            if (!searched) {
                onEvent({ type: 'status', text: '@web: the model answered without running a Google Search (no search grounding came back), so this reply is not web-grounded.', modelUsed: model });
            }
        }

        const summary = {
            text: accumulatedText,
            artifact,
            mcpExecution: mcpExecutions[0],
            groundingMetadata: accumulatedGroundingMetadata,
            usage: finalUsage,
            modelUsed: model
        };
        if (artifact) {
            onEvent({ type: 'artifact_complete', ...summary });
        }
        onEvent({ type: 'done', ...summary });

        return {
            success: true,
            text: accumulatedText,
            thoughts: accumulatedThoughts,
            artifact,
            mcpExecutions,
            groundingMetadata: accumulatedGroundingMetadata,
            modelUsed: model,
            questionCard: streamQuestionCard,
            executionPlanCard: streamExecutionPlanCard,
            usage: finalUsage
        };
    }

    /**
     * Runs one tool call under its time budget (tool-time-budgets.ts) while the chat shows it as running: a card
     * with the elapsed time and the tool's latest progress report, replaced in place by the result. The call ends
     * when the tool finishes; when it reaches its budget or goes too long without reporting progress (reported to
     * the model as failed, so the turn continues); or when the user stops the chat (the turn ends). In the last two
     * cases the tool's ctx.signal is aborted so tools that watch it stop working.
     */
    private async executeToolCallWithDeadline(
        toolCall: GeminiFunctionCall,
        request: GeminiGenerateRequest,
        onEvent: StreamEventSink,
        model: string,
        signal?: AbortSignal
    ): Promise<ToolExecutionResult> {
        throwIfAborted(signal);
        const toolName = toolCall.name || 'tool';
        const budget = resolveToolTimeBudget(toolName, toolCall.args, resolveToolTimeoutMs());
        const startedAt = Date.now();
        // The model often omits call ids, and one turn can call the same tool several times within a millisecond.
        const execId = `exec-${toolCall.id || `${toolName}-${startedAt}-${Math.random().toString(36).slice(2, 8)}`}`;
        const controller = new AbortController();

        let progressText = '';
        let lastProgressAt = startedAt;
        let lastEmitAt = 0;
        const elapsedS = () => Math.round((Date.now() - startedAt) / 1000);
        const emitRunning = () => {
            lastEmitAt = Date.now();
            const text = `${progressText || 'Running'} (${elapsedS()}s)`;
            onEvent({ type: 'status', text: `${toolName}: ${text}`, modelUsed: model, mcpExecution: runningExecution(execId, toolName, toolCall.args, text) });
        };

        // Once the call has ended (result, time limit or Stop), late progress reports from a tool that is still
        // winding down must not reopen its card or restart the idle timer.
        let settled = false;
        let settle: (outcome: 'max' | 'idle' | 'aborted') => void = () => undefined;
        const stopped = new Promise<'max' | 'idle' | 'aborted'>(resolve => { settle = resolve; });
        const maxTimer = setTimeout(() => settle('max'), budget.maxMs);
        let idleTimer: ReturnType<typeof setTimeout> | undefined;
        const armIdle = () => {
            if (settled || budget.idleMs >= budget.maxMs) return;
            clearTimeout(idleTimer);
            idleTimer = setTimeout(() => settle('idle'), budget.idleMs);
        };
        armIdle();
        const onAbort = () => settle('aborted');
        signal?.addEventListener('abort', onAbort, { once: true });
        const heartbeat = setInterval(emitRunning, TOOL_HEARTBEAT_MS);

        const reportProgress = (message: string, fraction?: number) => {
            if (settled) return;
            lastProgressAt = Date.now();
            const pct = typeof fraction === 'number' && Number.isFinite(fraction) ? ` - ${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%` : '';
            progressText = `${String(message).slice(0, 200)}${pct}`;
            armIdle();
            if (Date.now() - lastEmitAt >= 1000) emitRunning();
        };

        // A staged build's stage changed status: a status event carrying the running card and the stageEvent, plus
        // the scene artifact on a commit, degrade or finish (which mounts it). Restarts the idle limit like progress.
        const emitStage = (stage: StageEvent, artifact?: CanvasArtifact) => {
            if (settled) return;
            lastProgressAt = Date.now();
            progressText = `${stage.title} — ${stage.status}`.slice(0, 200);
            armIdle();
            lastEmitAt = Date.now();
            onEvent({
                type: 'status', text: `${toolName}: ${progressText}`, modelUsed: model,
                mcpExecution: runningExecution(execId, toolName, toolCall.args, `${progressText} (${elapsedS()}s)`),
                stageEvent: stage, ...(artifact ? { artifact } : {})
            });
        };

        emitRunning();
        const work = this.executeToolCall(toolCall, request, { signal: controller.signal, reportProgress, emitStage });
        work.catch(() => undefined);

        try {
            const outcome = await Promise.race([work, stopped]);
            if (outcome === 'aborted') {
                // the reason travels: a tool that outlives a dropped connection tells it from the user's Stop
                controller.abort(signal?.reason instanceof Error ? signal.reason : createAbortError());
                throw createAbortError();
            }
            if (outcome === 'max' || outcome === 'idle') {
                const why = outcome === 'max'
                    ? `did not finish within ${formatDuration(budget.maxMs)}, its time limit`
                    : `did not finish: it reported no progress for ${formatDuration(Date.now() - lastProgressAt)} (after ${formatDuration(Date.now() - startedAt)} in all)`;
                const message = `${toolName} ${why}, so the chat continued without its result and asked the tool to stop. It may still be finishing its current step; do not call it again unless the user asks.`;
                controller.abort(new Error(message));
                const exec: McpExecutionState = {
                    id: execId,
                    mcpServerId: 'scratchbox-tool-deadline',
                    mcpName: 'Scratchbox',
                    toolName,
                    humanTitle: toolName,
                    status: 'failed',
                    timestamp: new Date().toLocaleTimeString(),
                    steps: [{ id: 's1', title: `Run ${toolName}`, status: 'failed', durationMs: Date.now() - startedAt }],
                    summaryResult: message,
                    durationMs: Date.now() - startedAt
                };
                return { exec, resultPayload: { success: false, error: message, timedOut: true } };
            }
            // Same id as the running card, so the result replaces it; the real duration rather than a nominal one.
            return { ...outcome, exec: { ...outcome.exec, id: execId, durationMs: Date.now() - startedAt } };
        } finally {
            settled = true;
            clearTimeout(maxTimer);
            clearTimeout(idleTimer);
            clearInterval(heartbeat);
            signal?.removeEventListener('abort', onAbort);
        }
    }

    /** Route a model tool call to the registry. Calls that cannot run are reported as failures, never as success. */
    async executeToolCall(
        toolCall: GeminiFunctionCall,
        request: GeminiGenerateRequest,
        extras: Pick<ToolContext, 'signal' | 'reportProgress' | 'emitStage'> = {}
    ): Promise<ToolExecutionResult> {
        const toolName = toolCall.name || '';
        const blocked = toolBlockedReason(request.mode, toolName);
        if (blocked) {
            return failedToolResult(toolName, blocked, 'scratchbox-permissions');
        }
        const ctx: ToolContext = { ...this.toolContext(request), ...extras };
        if (this.registry.has(toolName) || inferToolGroup(toolName) !== 'mcp') {
            return this.registry.dispatch(toolName, toolCall.args, ctx);
        }
        return failedToolResult(
            toolName,
            `${toolName} is not connected to a live MCP server in this app, so nothing was executed. Tell the user it could not run; do not describe a result.`,
            'mcp-unconnected'
        );
    }

    private processChunk(
        chunk: VertexGenerateContentJson,
        accumulatedThoughts: string[],
        detectedToolCalls: FunctionCall[],
        model: string,
        onEvent: StreamEventSink,
        appendChunkText: (text: string) => void,
        setUsage: (usage: UsageMetadata) => void,
        setGroundingMetadata?: (metadata: GroundingMetadata) => void,
        setFinishReason?: (reason: string) => void
    ): void {
        if (chunk.usageMetadata) {
            setUsage(chunk.usageMetadata as UsageMetadata);
        }

        const candidates = chunk.candidates || [];
        for (const cand of candidates) {
            if (cand.finishReason) {
                setFinishReason?.(cand.finishReason);
            }
            // Grounding Metadata from the Google Search Grounding tool
            const groundingMeta = cand.groundingMetadata || chunk.groundingMetadata;
            if (groundingMeta) {
                setGroundingMetadata?.(groundingMeta);
                onEvent({ type: 'grounding', groundingMetadata: groundingMeta, modelUsed: model });
                if (groundingMeta.webSearchQueries && groundingMeta.webSearchQueries.length > 0) {
                    onEvent({
                        type: 'status',
                        text: `Google Search Grounding active: ${groundingMeta.webSearchQueries.join(', ')}`,
                        modelUsed: model
                    });
                }
            }

            const parts = cand.content?.parts || [];
            for (const part of parts) {
                if (part.thought) {
                    accumulatedThoughts.push(part.text || '');
                    onEvent({ type: 'thought', thought: part.text || '', modelUsed: model });
                } else if (part.functionCall) {
                    const rawPart = part as any;
                    const sig = rawPart.thought_signature ||
                                rawPart.thoughtSignature ||
                                rawPart.functionCall?.thought_signature ||
                                rawPart.functionCall?.thoughtSignature ||
                                (cand as any)?.thought_signature ||
                                (cand as any)?.thoughtSignature ||
                                (chunk as any)?.thought_signature ||
                                (chunk as any)?.thoughtSignature ||
                                'skip_thought_signature_validator';
                    detectedToolCalls.push({
                        ...part.functionCall,
                        thought_signature: sig
                    } as any);
                    const callObj = {
                        id: part.functionCall.id || `call-${Date.now()}`,
                        name: part.functionCall.name || '',
                        args: part.functionCall.args || {}
                    };
                    onEvent({ type: 'tool_call', toolCall: callObj, modelUsed: model });
                    onEvent({ type: 'mcp_call', toolCall: callObj, modelUsed: model });
                } else if (part.text) {
                    appendChunkText(part.text);
                    onEvent({ type: 'delta', text: part.text, modelUsed: model });
                }
            }
        }
    }

    // ------------------------------------------------------------------
    // SSE transport
    // ------------------------------------------------------------------

    /** Feed each SSE line to `handleLine`, supporting WHATWG streams, Node streams and buffered bodies. */
    private async consumeSseLines(response: StreamResponse, handleLine: (line: string) => void): Promise<void> {
        const body = response.body;

        if (isWebReadable(body)) {
            const reader = body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                for (const line of lines) handleLine(line);
            }
            if (buffer) handleLine(buffer);
            return;
        }

        if (isNodeReadable(body)) {
            await new Promise<void>((resolve, reject) => {
                let buffer = '';
                body.on('data', (chunk: Buffer) => {
                    buffer += chunk.toString('utf8');
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';
                    for (const line of lines) handleLine(line);
                });
                body.on('end', () => {
                    if (buffer) handleLine(buffer);
                    resolve();
                });
                body.on('error', (err: Error) => reject(err));
            });
            return;
        }

        const fullText = await response.text();
        for (const line of fullText.split('\n')) handleLine(line);
    }
}

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------

function isWebReadable(body: unknown): body is WebReadableLike {
    return !!body && typeof (body as WebReadableLike).getReader === 'function';
}

function isNodeReadable(body: unknown): body is NodeReadableLike {
    return !!body && typeof (body as NodeReadableLike).on === 'function';
}

/** Parse a `data: {...}` SSE line into JSON; returns undefined for blanks, `[DONE]` and partial chunks. */
export function parseSseDataLine(line: string): unknown {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return undefined;
    const jsonStr = trimmed.replace(/^data:\s*/, '');
    if (!jsonStr || jsonStr === '[DONE]') return undefined;
    try {
        return JSON.parse(jsonStr);
    } catch {
        return undefined;
    }
}

function extractAgentStepText(step: AgentStep): string {
    if (step.content) {
        let stepText = '';
        const contentArray = Array.isArray(step.content) ? step.content : [step.content];
        for (const contentObj of contentArray as unknown[]) {
            if (typeof contentObj === 'string') {
                stepText += contentObj;
            } else if (contentObj && typeof contentObj === 'object') {
                const obj = contentObj as { text?: string; parts?: unknown };
                if (obj.text) {
                    stepText += obj.text;
                } else if (obj.parts) {
                    const partsArray = Array.isArray(obj.parts) ? obj.parts : [obj.parts];
                    for (const part of partsArray as unknown[]) {
                        if (typeof part === 'string') {
                            stepText += part;
                        } else if (part && typeof part === 'object' && (part as { text?: string }).text) {
                            stepText += (part as { text: string }).text;
                        }
                    }
                }
            }
        }
        return stepText;
    }
    return step.text || '';
}

/**
 * Sanitizes tool results before returning to Gemini's prompt context.
 * Strips huge binary base64 strings (like GLBs or images) so they do not exhaust the 1M token limit.
 */
const MAX_MODEL_NUMERIC_ARRAY = 64;
/** Per-tool-result cap (~50k tokens) so a few large results cannot overflow the model's 1M-token context. */
const MAX_MODEL_TOOL_RESULT_CHARS = 200_000;

/** Sanitize a tool result for the model, then cap its serialized size. */
export function prepareToolResultForModel(toolName: string, obj: any): any {
    const clean = sanitizeToolResultForModel(obj);
    const serialized = JSON.stringify(clean) ?? '';
    if (serialized.length <= MAX_MODEL_TOOL_RESULT_CHARS) {
        return clean;
    }
    console.warn(`[Gemini] ${toolName} result is ${serialized.length} chars; truncating to ${MAX_MODEL_TOOL_RESULT_CHARS} for the model.`);
    return `${serialized.slice(0, MAX_MODEL_TOOL_RESULT_CHARS)}… [truncated, ${serialized.length - MAX_MODEL_TOOL_RESULT_CHARS} more chars]`;
}

/**
 * Told to the model with a failed tool's result. One instruction for every tool: the model judges whether the error is
 * about its own input (which it can fix) or not (which it reports), rather than the app guessing from the arguments.
 */
export const TOOL_FAILURE_INSTRUCTION = 'This tool call failed. If the error is about something you wrote in the call (code, an expression, a script, a payload, a misspelled or invalid value), fix it and retry once. Otherwise stop and tell the user which tool failed and quote its error; do not work around it with other tools (shell commands, scripts, file copies, another pipeline) unless the user asks.';

/**
 * What the model receives for a tool call. A failure comes wrapped with TOOL_FAILURE_INSTRUCTION, except for
 * workspace_* tools (the model is editing code and fixes what fails) and timed-out calls, whose payload already says
 * not to call the tool again.
 */
export function toolResultForModel(toolName: string, exec: Pick<McpExecutionState, 'status'> | undefined, resultPayload: any): any {
    const prepared = prepareToolResultForModel(toolName, resultPayload);
    const failed = exec?.status === 'failed' || resultPayload?.success === false || resultPayload?.status === 'error' || resultPayload?.status === 'failed';
    if (!failed || resultPayload?.timedOut === true || toolName.startsWith('workspace_')) {
        return prepared;
    }
    return { toolFailed: true, result: prepared, instruction: TOOL_FAILURE_INSTRUCTION };
}

export function sanitizeToolResultForModel(obj: any): any {
    if (obj === null || obj === undefined) return obj;
    if (typeof obj === 'string') {
        if (obj.length > 512 && (obj.startsWith('data:') || /^[A-Za-z0-9+/=]{256,}$/.test(obj.substring(0, 256)))) {
            return `[binary data omitted, length: ${obj.length} bytes]`;
        }
        return obj;
    }
    if (Array.isArray(obj)) {
        // Vertex, index and UV buffers are useless to the model and can run to millions of tokens.
        if (obj.length > MAX_MODEL_NUMERIC_ARRAY && obj.every(v => typeof v === 'number')) {
            return `[numeric array omitted, length: ${obj.length}]`;
        }
        return obj.map(sanitizeToolResultForModel);
    }
    if (typeof obj === 'object') {
        const clean: Record<string, any> = {};
        for (const [k, v] of Object.entries(obj)) {
            if (k === 'glbBase64' || k === 'base64' || k === 'imageBytes' || k === 'rawBuffer') {
                clean[k] = typeof v === 'string' ? `[binary data omitted, length: ${v.length} bytes]` : undefined;
            } else {
                clean[k] = sanitizeToolResultForModel(v);
            }
        }
        return clean;
    }
    return obj;
}

/** Merge grounding metadata across streamed chunks, de-duplicating queries and chunk URIs. */
export function mergeGroundingMetadata(
    accumulated: GroundingMetadata | undefined,
    incoming: GroundingMetadata | undefined
): GroundingMetadata | undefined {
    if (!incoming) return accumulated;
    if (!accumulated) return { ...incoming };

    const merged: GroundingMetadata = { ...accumulated };
    if (incoming.webSearchQueries && incoming.webSearchQueries.length > 0) {
        merged.webSearchQueries = Array.from(new Set([
            ...(accumulated.webSearchQueries || []),
            ...incoming.webSearchQueries
        ]));
    }
    if (incoming.groundingChunks && incoming.groundingChunks.length > 0) {
        const existingUris = new Set((accumulated.groundingChunks || []).map(c => c.web?.uri).filter(Boolean));
        const newChunks = incoming.groundingChunks.filter(c => !c.web?.uri || !existingUris.has(c.web.uri));
        merged.groundingChunks = [...(accumulated.groundingChunks || []), ...newChunks];
    }
    if (incoming.searchEntryPoint) {
        merged.searchEntryPoint = incoming.searchEntryPoint;
    }
    if (incoming.groundingSupports && incoming.groundingSupports.length > 0) {
        merged.groundingSupports = [...(accumulated.groundingSupports || []), ...incoming.groundingSupports];
    }
    return merged;
}

export { isModelNotFoundError };

/** A tool result that tells both the model and the chat UI the call did not run. */
function failedToolResult(toolName: string, message: string, serverId: string): ToolExecutionResult {
    const exec: McpExecutionState = {
        id: `exec-failed-${Date.now()}`,
        mcpServerId: serverId,
        mcpName: 'Scratchbox',
        toolName,
        humanTitle: toolName,
        status: 'failed',
        timestamp: new Date().toLocaleTimeString(),
        steps: [{ id: 's1', title: `Run ${toolName}`, status: 'failed', durationMs: 0 }],
        summaryResult: message
    };
    return { exec, resultPayload: { success: false, error: message } };
}
