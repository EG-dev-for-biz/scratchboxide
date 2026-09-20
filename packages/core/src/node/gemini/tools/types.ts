/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { GeminiGenerateRequest, SubagentRequest, SubagentResponse } from '../../../common/gemini-protocol';
import type { McpExecutionState } from '../../../browser/generative-canvas/canvas-types';
import type { ContainerSandboxService } from '../../container-sandbox-service';
import type { LspDiagnosticFeedbackService } from '../../lsp-diagnostic-feedback-service';
import type { ProjectContextGraphService } from '../../project-context-graph-service';
import type { BrowserProxyService } from '../../browser-proxy-service';
import type { LensBridge } from '../lens-bridge';

export type ToolParameterType = 'STRING' | 'NUMBER' | 'BOOLEAN' | 'OBJECT' | 'ARRAY';

export interface ToolParameterSchema {
    type: ToolParameterType;
    description?: string;
    properties?: Record<string, ToolParameterSchema>;
    required?: string[];
    items?: ToolParameterSchema;
    enum?: string[];
}

export interface ToolDeclaration {
    name: string;
    description: string;
    parameters?: ToolParameterSchema;
}

export interface GeminiFunctionCall {
    id?: string;
    name: string;
    args?: Record<string, unknown>;
}

export type GeminiToolConfig =
    | { googleSearch: Record<string, never> }
    | { codeExecution: Record<string, never> }
    | { functionDeclarations: ToolDeclaration[] };

export type ToolGroup = 'workspace' | 'lens' | 'browser' | 'comfyui' | 'mcp';

export type ToolResultPayload = Record<string, unknown>;

export interface ToolExecutionResult {
    exec: McpExecutionState;
    resultPayload: ToolResultPayload;
}

/** What a handler returns; the registry wraps it into `McpExecutionState` telemetry. */
export interface ToolHandlerOutcome {
    resultPayload: ToolResultPayload;
    status?: 'completed' | 'failed';
    summaryResult?: string;
}

/** Services a tool handler may need. Passed explicitly instead of reaching into `GeminiService`. */
export interface ToolContext {
    request: GeminiGenerateRequest;
    workspaceRoot: string;
    sandbox: ContainerSandboxService;
    lsp: LspDiagnosticFeedbackService;
    contextGraph: ProjectContextGraphService;
    browserProxy: BrowserProxyService;
    lens: LensBridge;
    executeSubagent?: (request: SubagentRequest) => Promise<SubagentResponse>;
}

export type ToolHandler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolHandlerOutcome> | ToolHandlerOutcome;

export type ToolFallbackHandler = (call: GeminiFunctionCall, ctx: ToolContext) => Promise<ToolExecutionResult> | ToolExecutionResult;
