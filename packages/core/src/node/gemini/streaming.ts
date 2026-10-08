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
    SubagentRequest,
    SubagentResponse
} from '../../common/gemini-protocol';
import type { CanvasArtifact, McpExecutionState } from '../../browser/generative-canvas/canvas-types';
import {
    GeminiClient,
    isModelNotFoundError,
    resolveFetch,
    type FetchLike,
    type VertexGenerateContentJson
} from './gemini-client';
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
import { parseOrSynthesizeArtifact } from './artifact-synthesis';
import { AgentVerificationService } from './agent-verification-service';

export type StreamEventSink = (event: GeminiStreamEvent) => void;

export type ArtifactSynthesizer = (
    prompt: string,
    modelText: string,
    request: GeminiGenerateRequest,
    mcpExecutions: McpExecutionState[],
    groundingMetadata?: GroundingMetadata
) => CanvasArtifact;

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
        thinkingConfig: { thinkingBudget: number };
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

export type StreamAuth =
    | { type: 'vertex'; token: string; projectId: string }
    | { type: 'api-key'; apiKey: string };

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

        let streamAuth: StreamAuth | undefined;
        try {
            const { token, projectId } = await this.client.getAccessToken();
            if (token && projectId) {
                streamAuth = { type: 'vertex', token, projectId };
            }
        } catch {
            const apiKey = await this.client.resolveApiKey();
            if (apiKey) {
                streamAuth = { type: 'api-key', apiKey };
            }
        }

        if (!streamAuth) {
            const apiKey = await this.client.resolveApiKey();
            if (apiKey) {
                streamAuth = { type: 'api-key', apiKey };
            } else {
                throw new Error('No Google Cloud service account or Gemini API key configured.');
            }
        }

        // If agent is specified, route to Agentic Interaction
        if (request.agent) {
            if (streamAuth.type !== 'vertex') {
                throw new Error(`Vertex agent interaction (${request.agent}) requires a Google Cloud service account.`);
            }
            return this.executeVertexAgentInteraction(request.agent, streamAuth.projectId, streamAuth.token, request, onEvent, signal);
        }

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
            } catch {
                // If subagent preprocessing fails, seamlessly proceed with primary model
            }
        }

        throwIfAborted(signal);
        return this.client.withModelFallback(
            this.client.getModelCandidates(request.model),
            targetModel => this.executeVertexGeneration(targetModel, streamAuth!, request, onEvent, signal),
            {
                onSuccess: model => { this.client.preferredModel = model; },
                // Partial output may already have been streamed; never replay a turn.
                retryTransient: false
            }
        );
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

        const artifact = this.synthesizeArtifact(request.prompt, state.accumulatedText, request, []);

        const summary = {
            text: state.accumulatedText,
            artifact,
            interactionId: state.interactionId,
            environmentId: state.environmentId,
            modelUsed: agent
        };
        onEvent({ type: 'artifact_complete', ...summary });
        onEvent({ type: 'done', ...summary });

        return {
            success: true,
            thoughts: state.accumulatedThoughts,
            ...summary
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
        signal?: AbortSignal
    ): Promise<GeminiGenerateResponse> {
        const url = auth.type === 'vertex'
            ? this.client.vertexModelUrl(auth.projectId, model, 'streamGenerateContent')
            : `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(auth.apiKey)}`;

        const systemInstructionText = await buildSystemInstruction(request, this.promptServices());
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
                maxOutputTokens: 8192,
                thinkingConfig: this.client.getThinkingConfig(request)
            }
        };
        if (tools && tools.length > 0) {
            // Vertex AI constraint: Cannot combine googleSearch or other tools with functionDeclarations
            const hasFunctionDeclarations = tools.some(t => 'functionDeclarations' in t && Array.isArray(t.functionDeclarations) && t.functionDeclarations.length > 0);
            if (hasFunctionDeclarations) {
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
        const maxTurns = request.maxTurns || 15;
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
                        mergeGrounding
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
                        runTests: !!request.autoVerify
                    });

                    onEvent({
                        type: 'verification_result',
                        verification: outcome,
                        modelUsed: model
                    });

                    if (!outcome.passed) {
                        // Diagnostic errors detected: initiate self-healing turn
                        const diagSummary = toolCtx.lsp.synthesizeDiagnosticFixPrompt(Array.from(modifiedFiles));
                        payload.contents.push({ role: 'model', parts: [{ text: turnText || accumulatedText }] });
                        payload.contents.push({
                            role: 'user',
                            parts: [{
                                text: `[AUTOMATED COMPILER & VERIFICATION FEEDBACK]\n${outcome.summary || ''}\n${diagSummary.promptContext}\n\nPlease autonomously investigate and fix these errors using workspace tools.`
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

                const { exec, resultPayload } = await this.executeToolCall({ id: toolCall.id, name: toolName, args: toolCall.args }, request);
                mcpExecutions.push(exec);

                if (toolName === 'mount_canvas_primitive' || (resultPayload && (resultPayload as any).artifact)) {
                    const mountedArtifact = (resultPayload as any).artifact as CanvasArtifact;
                    if (mountedArtifact) {
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

                const callId = toolCall.id || `call-${Date.now()}`;
                const toolResult = { id: callId, name: toolName, result: resultPayload };
                onEvent({ type: 'tool_result', mcpExecution: exec, toolResult, modelUsed: model });

                toolResponseParts.push({
                    functionResponse: {
                        name: toolName,
                        response: {
                            name: toolName,
                            content: sanitizeToolResultForModel(resultPayload)
                        }
                    }
                });
            }

            // Append assistant model turn with functionCalls and user turn with functionResponses
            payload.contents.push({ role: 'model', parts: modelParts });
            payload.contents.push({ role: 'user', parts: toolResponseParts });

            onEvent({
                type: 'status',
                text: `Executed ${turnDetectedToolCalls.length} tool(s). Reasoning on turn ${currentTurn + 1}/${maxTurns}...`,
                modelUsed: model
            });
        }

        const isCodingMode = request.mode === 'agent' || request.mode === 'plan' || request.mode === 'ask';
        const hasJsonBlock = /```json\s*\{[\s\S]*\}\s*```/.test(accumulatedText);
        const hasArtifactTag = /<scratchboxPrimitive[\s\S]*?>/i.test(accumulatedText);
        const isCanvasCreationPrompt = /3d|scene|world|model|asteroid|flight|plane|spatial|terrain|mesh|sandbox|app\b|component|widget|calculator|preview|landing\s*page|doc\b|document|spec\b|proposal|paper|essay|report|board|kanban|graph\b|flow\b|pipeline|diagram|dashboard|picture|video|generate|create|render|build\s+(?:a|an)|design\s+(?:a|an)|clip|timeline|playhead|ripple|razor|nle|audio\s*mix|track/i.test(request.prompt);

        const shouldSynthesize = !isCodingMode || hasJsonBlock || hasArtifactTag || isCanvasCreationPrompt || !!request.activeArtifact;
        const artifact = streamMountedArtifact || (shouldSynthesize
            ? this.synthesizeArtifact(request.prompt, accumulatedText, request, mcpExecutions, accumulatedGroundingMetadata)
            : undefined);

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

    /** Route a model tool call to the registry, falling back to synthesised MCP telemetry. */
    async executeToolCall(toolCall: GeminiFunctionCall, request: GeminiGenerateRequest): Promise<ToolExecutionResult> {
        const toolName = toolCall.name || '';
        const ctx = this.toolContext(request);
        if (this.registry.has(toolName) || inferToolGroup(toolName) !== 'mcp') {
            return this.registry.dispatch(toolName, toolCall.args, ctx);
        }
        const exec = this.mcp.synthesizeExecution({ name: toolName, args: toolCall.args }, this.lens);
        const resultPayload = (exec.humanFriendlyOutput as Record<string, unknown> | undefined) || { status: 'success' };
        return { exec, resultPayload };
    }

    private processChunk(
        chunk: VertexGenerateContentJson,
        accumulatedThoughts: string[],
        detectedToolCalls: FunctionCall[],
        model: string,
        onEvent: StreamEventSink,
        appendChunkText: (text: string) => void,
        setUsage: (usage: UsageMetadata) => void,
        setGroundingMetadata?: (metadata: GroundingMetadata) => void
    ): void {
        if (chunk.usageMetadata) {
            setUsage(chunk.usageMetadata as UsageMetadata);
        }

        const candidates = chunk.candidates || [];
        for (const cand of candidates) {
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
export function sanitizeToolResultForModel(obj: any): any {
    if (obj === null || obj === undefined) return obj;
    if (typeof obj === 'string') {
        if (obj.length > 512 && (obj.startsWith('data:') || /^[A-Za-z0-9+/=]{256,}$/.test(obj.substring(0, 256)))) {
            return `[binary data omitted, length: ${obj.length} bytes]`;
        }
        return obj;
    }
    if (Array.isArray(obj)) {
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
