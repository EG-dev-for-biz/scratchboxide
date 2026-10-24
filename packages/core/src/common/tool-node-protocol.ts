/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Tool nodes: every tool the in-app chat can call, offered as a node on the canvas node graph and run through the same
 * registry and handlers (GET /gemini/tools/catalog, POST /gemini/tools/run). The parameter schema is the tool's own
 * declaration, so a node's form never drifts from what the tool accepts.
 */

import type { CanvasArtifact } from '../browser/generative-canvas/canvas-types';
import type { StageEvent } from './spatial/staged-location-contracts';

/** A tool parameter schema as the tool declares it (mirrors node/gemini/tools/types ToolParameterSchema). */
export interface ToolNodeParameterSchema {
    type: 'STRING' | 'NUMBER' | 'BOOLEAN' | 'OBJECT' | 'ARRAY';
    description?: string;
    properties?: Record<string, ToolNodeParameterSchema>;
    required?: string[];
    items?: ToolNodeParameterSchema;
    enum?: string[];
}

export interface ToolNodeCatalogEntry {
    name: string;
    description: string;
    parameters?: ToolNodeParameterSchema;
    /** The declaration list the tool comes from, as a readable title (e.g. "Google 3D Tiles"). */
    pack: string;
    /** False for tools the chat runs only when a request names them; they run the same from a node. */
    offeredByDefault: boolean;
}

export interface ToolNodeCatalogResponse {
    success: boolean;
    tools: ToolNodeCatalogEntry[];
    error?: { message: string };
}

export interface ToolNodeRunRequest {
    name: string;
    args: Record<string, unknown>;
    workspaceRoot: string;
    /** The scene the node belongs to (a stage view's source scene), as the chat's active artifact would be. */
    activeArtifact?: CanvasArtifact;
}

/**
 * One line of POST /gemini/tools/run-stream (newline-delimited JSON): progress while the tool works, each stage a
 * staged build commits with the scene as it then stands (the same events the chat streams), then the result.
 */
export type ToolNodeRunEvent =
    | { type: 'progress'; message: string; fraction?: number }
    | { type: 'stage'; stage: StageEvent; artifact?: CanvasArtifact }
    | { type: 'done'; result: ToolNodeRunResponse };

export interface ToolNodeRunResponse {
    success: boolean;
    status: 'completed' | 'failed';
    resultPayload: Record<string, unknown>;
    summary?: string;
    durationMs: number;
    error?: { message: string };
}
