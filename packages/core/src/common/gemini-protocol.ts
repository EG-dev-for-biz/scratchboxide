/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import type {
    CanvasArtifact,
    GroundingChunk,
    GroundingMetadata,
    GroundingSupport,
    McpExecutionState
} from '../browser/generative-canvas/canvas-types';
import type { StageEvent } from './spatial/staged-location-contracts';

export type {
    GroundingChunk,
    GroundingMetadata,
    GroundingSupport
};

export interface GeminiStatus {
    connected: boolean;
    serviceAccount?: string;
    projectId?: string;
    activeModel: string;
    availableModels: string[];
    subagentModel?: string;
    availableSubagentModels?: string[];
    thinkingBudget: number;
    authMethod: 'service-account' | 'api-key' | 'unauthenticated';
    error?: string;
}

export interface AttachedSkillContext {
    id: string;
    name: string;
    description: string;
    rawContent?: string;
    tags?: string[];
    category?: string;
}

export interface AttachedMcpToolContext {
    id: string;
    serverName: string;
    name: string;
    humanTitle: string;
    description: string;
    samplePrompt?: string;
    category?: string;
}

export type SubagentTaskType =
    | 'preprocess'
    | 'skill_match'
    | 'tool_args'
    | 'summarize'
    | 'research'
    | 'code_snippet';

export interface SubagentRequest {
    taskType: SubagentTaskType;
    prompt: string;
    context?: string;
    model?: string;
    enableGoogleSearch?: boolean;
    attachedSkills?: AttachedSkillContext[];
    attachedMcpTools?: AttachedMcpToolContext[];
}

export interface SubagentResponse {
    success: boolean;
    result: string;
    data?: Record<string, any>;
    groundingMetadata?: GroundingMetadata;
    modelUsed: string;
    /** Which model and credential answered, and why when not the requested model or the service account. */
    modelProvenance?: ModelAnswerProvenance;
    error?: string;
}

export type InteractionMode = 'agent' | 'plan' | 'ask' | 'studio';

export interface GeminiGenerateRequest {
    prompt: string;
    model?: string;
    agent?: string;
    environment?: 'remote' | string;
    previousInteractionId?: string;
    subagentModel?: string;
    enableSubagentPreprocess?: boolean;
    enableGoogleSearch?: boolean;
    /** @web: this turn must carry Google Search grounding; the run fails when the model cannot take the search tool. */
    requireGoogleSearch?: boolean;
    enableCodeExecution?: boolean;
    enableBrowserTools?: boolean;
    enableLensTools?: boolean;
    thinkingBudget?: number;
    temperature?: number;
    systemInstruction?: string;
    attachedSkills?: AttachedSkillContext[];
    attachedMcpTools?: AttachedMcpToolContext[];
    activeArtifact?: CanvasArtifact;
    chatHistory?: Array<{ role: 'user' | 'model'; text: string }>;
    /** Set on requests made by a subagent run, so it cannot start further subagents. */
    isSubagentRun?: boolean;
    enableSemanticGraph?: boolean;
    enableFewShotPatterns?: boolean;
    enableLspDiagnostics?: boolean;
    enableDiffMemory?: boolean;
    enableWorkspaceTools?: boolean;
    maxTurns?: number;
    workspaceRoot?: string;
    targetFiles?: string[];
    turnId?: string;
    mode?: InteractionMode;
    requirePlanApproval?: boolean;
    autoVerify?: boolean;
    toolPacks?: Array<'core_workspace' | 'geospatial_3d' | 'mesh_surface' | 'vfx_video' | 'lens' | 'browser'>;
    /**
     * Tools the model loaded with load_tools earlier in this conversation (sent back on `done` as loadedTools); they
     * are offered again after the entry set (tool-catalog.ts).
     */
    loadedTools?: string[];
    domainHint?: 'auto' | '3d' | 'vfx' | 'generative' | 'code' | 'general';
}

export type GeminiStreamEventType =
    | 'status'
    | 'thought'
    | 'delta'
    | 'grounding'
    | 'audio_delta'
    | 'image_delta'
    | 'mcp_call'
    | 'mcp_result'
    | 'tool_call'
    | 'tool_result'
    | 'subagent_start'
    | 'subagent_thought'
    | 'subagent_done'
    | 'artifact_start'
    | 'artifact_complete'
    | 'plan_ready'
    | 'verification_start'
    | 'verification_result'
    | 'question_card'
    | 'execution_plan_card'
    | 'task_list'
    | 'done'
    | 'error';

export interface VerificationDiagnostic {
    file: string;
    filePath?: string;
    line?: number;
    message: string;
    severity: 'error' | 'warning';
    source?: string;
}

export interface VisualVerificationResult {
    overallScore: number;
    passed: boolean;
    screenshotPath?: string;
    dimensionAudits: Record<string, { score: number; passed: boolean; notes?: string }>;
    remediationRecipe?: {
        suggestedFfmpegFilters?: string[];
        actionDirectives: string[];
    };
}

export interface GeometryVerificationResult {
    passed: boolean;
    vertexCount: number;
    triangleCount: number;
    isManifold?: boolean;
    boundingBoxValid?: boolean;
    warnings: string[];
}

export interface VerificationOutcome {
    passed: boolean;
    summary?: string;
    command?: string;
    diagnostics?: VerificationDiagnostic[];
    testOutput?: string;
    durationMs?: number;
    visualVerification?: VisualVerificationResult;
    geometryVerification?: GeometryVerificationResult;
    commandResult?: {
        exitCode: number;
        stdout: string;
        stderr: string;
    };
}

export interface GeminiStreamEvent {
    type: GeminiStreamEventType;
    text?: string;
    thought?: string;
    interactionId?: string;
    environmentId?: string;
    audioContent?: string;
    imageContent?: string;
    subagentResult?: SubagentResponse;
    toolCall?: {
        id: string;
        name: string;
        args: Record<string, any>;
    };
    toolResult?: {
        id: string;
        name: string;
        result: Record<string, any>;
    };
    artifact?: CanvasArtifact;
    mcpExecution?: McpExecutionState;
    groundingMetadata?: GroundingMetadata;
    usage?: {
        promptTokens?: number;
        candidateTokens?: number;
        totalTokens?: number;
    };
    modelUsed?: string;
    /** On `done` and `error`: which model and credential answered, and why not the requested ones. */
    modelProvenance?: ModelAnswerProvenance;
    /** On `done`: every tool loaded with load_tools so far in the conversation (send it back as request.loadedTools). */
    loadedTools?: string[];
    error?: string;
    verification?: VerificationOutcome;
    planApprovalRequired?: boolean;
    questionCard?: import('../browser/generative-canvas/canvas-types').InteractiveQuestionCardData;
    executionPlanCard?: import('../browser/generative-canvas/canvas-types').ExecutionPlanCardData;
    taskList?: AgentTaskListItem[];
    /** A staged build's stage changed status (on a `status` event; a commit, degrade or finish also carries `artifact`). */
    stageEvent?: StageEvent;
}

/**
 * Which model and credential answered a chat turn. The model fallback list is kept, but never silent: when the
 * model that answered is not the one requested (or configured), `fallbackReason` says why, and when the Vertex
 * service account is configured but the Gemini API key answered, `credentialNote` says why.
 */
export interface ModelAnswerProvenance {
    /** The model the request asked for (Settings > Models), or the server default when it named none. */
    requestedModel: string;
    /** The model that answered. */
    modelUsed: string;
    /** Set when modelUsed differs from requestedModel: each model that was skipped and why. */
    fallbackReason?: string;
    /** 'vertex' (Google Cloud service account, Vertex AI) or 'api-key' (Gemini API key, AI Studio). */
    credential: 'vertex' | 'api-key';
    /** Set when a service account is configured but the API key answered: why Vertex was not used. */
    credentialNote?: string;
    /**
     * Calls made for this turn by other models (skill preprocessing) that did not run on the requested model or the
     * service account, each saying which model and credential answered instead and why.
     */
    helperNotes?: string[];
    /**
     * Set on a failed turn when no model in the list was available (each answered "not found"); modelUsed is then
     * the last model tried, not one that answered.
     */
    noModelAnswered?: boolean;
    /**
     * Set when a router model took part in the turn's first model call (fast-router.ts): which model chose the first
     * tool call, or that the requested model answered it and why the router handed off.
     */
    routing?: string;
}

/** One item of the agent's visible checklist (`update_task_list`). */
export interface AgentTaskListItem {
    title: string;
    status: 'pending' | 'in_progress' | 'completed';
}

export interface GeminiGenerateResponse {
    success: boolean;
    text: string;
    thoughts?: string[];
    interactionId?: string;
    environmentId?: string;
    subagentResult?: SubagentResponse;
    artifact?: CanvasArtifact;
    mcpExecutions?: McpExecutionState[];
    groundingMetadata?: GroundingMetadata;
    modelUsed: string;
    modelProvenance?: ModelAnswerProvenance;
    /** Every tool loaded with load_tools so far in the conversation. */
    loadedTools?: string[];
    questionCard?: import('../browser/generative-canvas/canvas-types').InteractiveQuestionCardData;
    executionPlanCard?: import('../browser/generative-canvas/canvas-types').ExecutionPlanCardData;
    usage?: {
        promptTokens?: number;
        candidateTokens?: number;
        totalTokens?: number;
    };
    error?: string;
}

export interface SaveCredentialsRequest {
    credentialsJson?: string;
    apiKey?: string;
    targetPath?: string;
}

export interface SaveCredentialsResponse {
    success: boolean;
    authMethod: 'service-account' | 'api-key' | 'unauthenticated';
    projectId?: string;
    serviceAccount?: string;
    savedPath?: string;
    error?: string;
}

export interface McpPingRequest {
    server: {
        id: string;
        name: string;
        url?: string;
        command?: string;
        transport: 'sse' | 'stdio' | 'pipe' | 'stream';
        tools?: Array<{
            id: string;
            name: string;
            humanTitle: string;
            description: string;
        }>;
    };
}

export interface McpPingResponse {
    serverId: string;
    status: 'online' | 'offline' | 'degraded';
    latencyMs: number;
    availableToolsCount: number;
    error?: string;
}

export interface AgentSessionCreateRequest {
    goal: string;
    maxIterations?: number;
    maxDurationMs?: number;
    workspaceRoot?: string;
}

export interface AgentSessionActionRequest {
    sessionId: string;
    action: 'pause' | 'resume' | 'cancel';
}

export interface GeminiTtsRequest {
    text: string;
    voice?: string;
    speed?: number;
    stylePrompt?: string;
}

export interface GeminiTtsResponse {
    success: boolean;
    audioContent?: string; // Base64 PCM / MP3
    error?: string;
}

export interface GeminiImageGenerateRequest {
    prompt: string;
    aspectRatio?: '1:1' | '16:9' | '9:16' | '4:3';
    style?: string;
}

export interface FimCompletionRequest {
    prefix: string;
    suffix: string;
    fileName?: string;
    language?: string;
    maxTokens?: number;
    temperature?: number;
    stopSequences?: string[];
    workspaceRoot?: string;
}

export interface FimCompletionResponse {
    success: boolean;
    completion: string;
    modelUsed: string;
    /** The credential that answered: 'vertex' (service account) or 'api-key' (Gemini API key). */
    credential?: 'vertex' | 'api-key';
    /** Set when a service account is configured but the API key answered: why. */
    credentialNote?: string;
    latencyMs?: number;
    error?: string;
}

export interface QuickEditRequest {
    originalCode: string;
    instruction: string;
    selection?: {
        startLine: number;
        endLine: number;
        selectedText?: string;
    };
    fileName?: string;
    language?: string;
    workspaceRoot?: string;
}

export interface QuickEditResponse {
    success: boolean;
    proposedCode: string;
    diffSummary?: string;
    additions?: number;
    deletions?: number;
    modelUsed?: string;
    /** The credential that answered: 'vertex' (service account) or 'api-key' (Gemini API key). */
    credential?: 'vertex' | 'api-key';
    /** Set when a service account is configured but the API key answered: why. */
    credentialNote?: string;
    error?: string;
}

export * from './deep-write/deep-write-protocol';


