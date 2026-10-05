/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { CanvasArtifact, PrimitiveType } from '../../browser/generative-canvas/canvas-types';

export type PlatformDomain =
    | 'web'
    | 'mobile'
    | 'desktop'
    | 'cloud_backend'
    | 'native_systems'
    | 'spatial_3d'
    | 'cross_platform'
    | 'universal'
    | (string & {});

export type BuildToolchain =
    | 'npm'
    | 'yarn'
    | 'pnpm'
    | 'cmake'
    | 'makefile'
    | 'cargo'
    | 'gradle'
    | 'swiftpm'
    | 'go'
    | 'pip'
    | 'poetry'
    | 'docker'
    | 'none';

export type ExecutionEnvironment =
    | 'sandbox'
    | 'wasm'
    | 'container'
    | 'webgpu'
    | 'none';

export interface MultiPlatformDeliverableConfig {
    platforms: PlatformDomain[];
    languages: string[];
    toolchain: BuildToolchain;
    environment: ExecutionEnvironment;
    entryPoint?: string;
    dependencies?: Record<string, string>;
    bindingFFI?: {
        type: 'jni' | 'wasm-bindgen' | 'napi-rs' | 'c-ffi' | 'objc-bridge' | 'none';
        headerPath?: string;
    };
}

export interface DynamicAgentStage {
    id: string;
    name: string;
    stage: string;
    description: string;
    assignedAgentRole: string;
    isCheckpoint: boolean;
    requiredInputs?: string[];
    expectedOutputs?: string[];
}

export interface DiscoveredGoalPlan {
    goal: string;
    domains: PlatformDomain[];
    deliverables: {
        filePaths: string[];
        primitives: PrimitiveType[];
        config: MultiPlatformDeliverableConfig;
    };
    stages: DynamicAgentStage[];
    analysisReasoning: string;
}

export interface AdaptiveGoalRequest {
    prompt: string;
    activeSessionId?: string;
    workspaceRoot?: string;
    activeArtifact?: CanvasArtifact;
    selectedFilePaths?: string[];
    userPreferredPlatforms?: PlatformDomain[];
    userPreferredLanguages?: string[];
}

export interface DeepWriteCheckpointEvent {
    sessionId: string;
    stageId: string;
    stageName: string;
    status: 'awaiting_feedback' | 'resumed' | 'approved';
    intermediateArtifacts: CanvasArtifact[];
    decisionPoints: string[];
    userFeedback?: string;
    suggestedAdjustments?: string[];
}

export interface MultiArtifactPlanBundle {
    title: string;
    summary: string;
    artifacts: Array<{
        type: PrimitiveType;
        title: string;
        data: any;
    }>;
    files: Record<string, string>; // Path -> Contents for CodebaseLens sync
}

export type DeepWriteStreamEventType =
    | 'pipeline_start'
    | 'goal_analyzed'
    | 'deliverables_planned'
    | 'stage_start'
    | 'stage_complete'
    | 'research_query_sent'
    | 'research_thinking'
    | 'checkpoint_paused'
    | 'checkpoint_resumed'
    | 'artifact_spawned'
    | 'file_scaffold_ready'
    | 'execution_output'
    | 'execution_error'
    | 'auto_repair_attempt'
    | 'pipeline_complete'
    | 'error';

export interface DeepWriteStreamEvent {
    type: DeepWriteStreamEventType;
    sessionId: string;
    title?: string;
    message?: string;
    progressPercent?: number;
    currentStageId?: string;
    currentStageName?: string;
    totalStages?: number;
    plan?: DiscoveredGoalPlan;
    artifact?: CanvasArtifact;
    query?: string;
    thinking?: string;
    checkpoint?: DeepWriteCheckpointEvent;
    bundle?: MultiArtifactPlanBundle;
    executionLog?: {
        output: string;
        exitCode?: number;
        success: boolean;
    };
    error?: string;
}

export interface DeepWriteGoalRequest {
    prompt: string;
    sessionId?: string;
    workspaceRoot?: string;
    activeArtifact?: CanvasArtifact;
    useGoogleSearch?: boolean;
}
