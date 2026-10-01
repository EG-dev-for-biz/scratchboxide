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
    enableSemanticGraph?: boolean;
    enableFewShotPatterns?: boolean;
    enableLspDiagnostics?: boolean;
    enableDiffMemory?: boolean;
    enableWorkspaceTools?: boolean;
    enableComfyUiTools?: boolean;
    maxTurns?: number;
    workspaceRoot?: string;
    targetFiles?: string[];
    turnId?: string;
    mode?: InteractionMode;
    requirePlanApproval?: boolean;
    autoVerify?: boolean;
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
    error?: string;
    verification?: VerificationOutcome;
    planApprovalRequired?: boolean;
    questionCard?: import('../browser/generative-canvas/canvas-types').InteractiveQuestionCardData;
    executionPlanCard?: import('../browser/generative-canvas/canvas-types').ExecutionPlanCardData;
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
    error?: string;
}

export * from './deep-write/deep-write-protocol';


