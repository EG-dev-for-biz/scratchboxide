/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { NodeGraphData } from '../browser/generative-canvas/canvas-types';

/**
 * ComfyUI Raw API Node Input value.
 * Primitives (string, number, boolean) or port connection tuple [nodeId, outputIndex].
 */
export type ComfyApiNodeInput = string | number | boolean | null | [string, number] | Array<string | number>;

/**
 * Raw ComfyUI Node format submitted to the /prompt endpoint.
 */
export interface ComfyApiNode {
    class_type: string;
    inputs: Record<string, ComfyApiNodeInput>;
    _meta?: {
        title?: string;
    };
}

/**
 * Complete ComfyUI API Prompt payload.
 * Maps node IDs to node declarations.
 */
export type ComfyApiPrompt = Record<string, ComfyApiNode>;

/**
 * ComfyUI Schema specification for an individual node input/output contract from /object_info.
 */
export interface ComfyNodeInputSpec {
    required?: Record<string, any[]>;
    optional?: Record<string, any[]>;
    hidden?: Record<string, any[]>;
}

export interface ComfyNodeObjectInfo {
    name: string;
    display_name?: string;
    category?: string;
    description?: string;
    input: ComfyNodeInputSpec;
    output: string[];
    output_is_list?: boolean[];
    output_name?: string[];
}

export type ComfyObjectInfoCatalog = Record<string, ComfyNodeObjectInfo>;

/**
 * ComfyUI Hardware and VRAM telemetry from /system_stats.
 */
export interface ComfySystemDevice {
    name: string;
    type: string;
    index: number;
    vram_total: number;
    vram_free: number;
    torch_vram_total: number;
    torch_vram_free: number;
}

export interface ComfySystemStats {
    system: {
        os: string;
        python_version: string;
        embedded_python: boolean;
    };
    devices: ComfySystemDevice[];
}

/**
 * Pipeline Categories synthesized by the ComfyUI Agent.
 */
export type ComfyPipelineCategory =
    | 'text-to-image'
    | 'image-to-image'
    | 'inpainting'
    | 'pbr-texture-matrix'
    | 'pbr-texture-synthesis'
    | 'image-to-3d'
    | 'depth-estimation'
    | 'video-generation'
    | 'upscaling'
    | 'custom';

export interface ComfyPipelineNodeDef {
    id: string;
    classType: string;
    title: string;
    category: string;
    inputs: Record<string, any>;
    outputs: Array<{ name: string; type: string }>;
}

export interface ComfyPipelineConnection {
    fromNodeId: string;
    fromOutputIndex: number;
    toNodeId: string;
    toInputName: string;
}

export interface ComfyRequiredModel {
    type: 'checkpoint' | 'lora' | 'controlnet' | 'vae' | 'embedding' | 'clip_vision';
    name: string;
    fallback?: string;
}

/**
 * Structured Researched Blueprint produced in the Research Phase.
 */
export interface ComfyPipelineBlueprint {
    id: string;
    goal: string;
    category: ComfyPipelineCategory;
    targetResolution?: [number, number];
    nodes: ComfyPipelineNodeDef[];
    connections: ComfyPipelineConnection[];
    requiredModels: ComfyRequiredModel[];
    requiredCustomNodes: string[];
    rationale: string;
    suggestedParameters?: Record<string, any>;
}

/**
 * Real-time progress event emitted during research, formulation, queueing, and node execution.
 */
export type ComfyExecutionPhase =
    | 'research'
    | 'validation'
    | 'queueing'
    | 'executing'
    | 'asset_fetching'
    | 'completed'
    | 'failed'
    | 'self_healing';

export interface ComfyExecutionProgressEvent {
    phase: ComfyExecutionPhase;
    promptId?: string;
    nodeId?: string;
    nodeType?: string;
    step?: number;
    maxSteps?: number;
    progressPercent: number;
    message: string;
    previewUrl?: string;
    timestamp: number;
}

export interface ComfyGeneratedAsset {
    filename: string;
    subfolder?: string;
    type: 'output' | 'temp';
    mediaKind: 'image' | 'video' | 'audio' | 'model-3d' | 'texture-set' | 'other';
    localPath?: string;
    url?: string;
    byteLength?: number;
    mimeType?: string;
}

export interface ComfyDiagnosticRecord {
    attempt: number;
    error: string;
    fixApplied?: string;
    repairedNodeIds?: string[];
}

export interface ComfyCloudRunConfig {
    serviceUrl?: string;
    projectId?: string;
    region?: string;
    serviceName?: string;
    authToken?: string;
    mockExecution?: boolean;
}

export interface ComfyCloudRunServiceStatus {
    [key: string]: unknown;
    serviceUrl: string;
    status: 'ready' | 'starting' | 'unreachable' | 'degraded';
    region: string;
    projectId?: string;
    gpuAccelerated: boolean;
    gpuType?: string;
    availableModels: string[];
    latencyMs: number;
    activeRevisions?: string;
    details?: string;
}

export interface ComfyUpstreamVersionInfo {
    [key: string]: unknown;
    currentCommit: string;
    upstreamCommit: string;
    upToDate: boolean;
    branch: string;
    repositoryUrl: string;
    commitsBehind: number;
    lastChecked: number;
    lastSynced?: number;
    details?: string;
}

export interface ComfyDynamicCodeModule {
    moduleName: string;
    code: string;
    nodeClasses: string[];
    description?: string;
    requirements?: string[];
    author?: string;
}

export interface ComfyWorkflowDependencyReport {
    requiredNodes: string[];
    availableNodes: string[];
    missingNodes: string[];
    injectedModules: string[];
    ready: boolean;
}

export interface ComfyExecutionOptions {
    hostUrl?: string;
    clientId?: string;
    timeoutMs?: number;
    workspaceRoot?: string;
    outputDir?: string;
    mockExecution?: boolean;
    maxFixAttempts?: number;
    onProgress?: (event: ComfyExecutionProgressEvent) => void;
    targetEnvironment?: 'local' | 'cloud-run' | 'auto';
    cloudRun?: ComfyCloudRunConfig;
    dynamicCode?: ComfyDynamicCodeModule[];
    autoInstallDependencies?: boolean;
    autoSyncUpstream?: boolean;
}

export interface ComfyExecutionResult {
    success: boolean;
    promptId?: string;
    blueprint: ComfyPipelineBlueprint;
    apiPrompt: ComfyApiPrompt;
    nodeGraphData?: NodeGraphData;
    assets: ComfyGeneratedAsset[];
    executionDurationMs: number;
    diagnostics: ComfyDiagnosticRecord[];
    capabilityResolution?: any;
    error?: string;
}
