/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import type { CanvasArtifact, McpExecutionState, NodeGraphData } from './canvas-types';
import { toolCallsToNodeGraph, type ToolCallGraph } from '../../common/tool-node-graph';
import { ToolNodeClient } from './tool-node-client';

/**
 * Chat-UI meta tools that steer the chat interface itself (mount/morph a card, ask a clarifying question,
 * update the task checklist, present a plan card, or dynamically load tools/skills) rather than executing
 * an inspectable pipeline step. Executable 3D/VFX tools declared in the Canvas pack (such as
 * execute_3d_python_script, scene_3d_dispatch_operators, and audit_3d_scene_viewport) remain runnable
 * node-graph steps.
 */
export const CHAT_UI_META_TOOLS: ReadonlySet<string> = new Set([
    'mount_canvas_primitive',
    'morph_canvas_primitive',
    'ask_user_question',
    'update_task_list',
    'present_execution_plan',
    'load_tools',
    'load_skill'
]);

/** Whether a tool name from a chat turn is a runnable pipeline node rather than a chat-UI meta call. */
export function isRunnableChatToolName(name: string, catalogNames?: ReadonlySet<string>): boolean {
    if (CHAT_UI_META_TOOLS.has(name)) {
        return false;
    }
    return catalogNames ? catalogNames.has(name) : true;
}

/** Recorded calls that can become nodes: they finished, kept their arguments, and are not chat-only meta calls. */
export function hasGraphableToolCalls(execs: McpExecutionState[] | undefined): boolean {
    return !!execs?.some(e => e.status !== 'running' && e.args && !CHAT_UI_META_TOOLS.has(e.toolName));
}

/**
 * A chat reply's tool calls as a node-graph artifact. Chat-UI meta tools (mount a card, ask a question,
 * load tools) are left out while executable 3D/VFX/spatial tools (including execute_3d_python_script,
 * scene_3d_dispatch_operators, and audit_3d_scene_viewport) are preserved as runnable nodes.
 */
export async function buildToolCallGraphArtifact(execs: McpExecutionState[], title: string): Promise<{ artifact: CanvasArtifact; graph: ToolCallGraph }> {
    const catalog = await ToolNodeClient.getInstance().listTools();
    const catalogNames = new Set(catalog.map(t => t.name));
    const graph = toolCallsToNodeGraph(execs, name => isRunnableChatToolName(name, catalogNames));
    const data: NodeGraphData = {
        title: `${title} — tool calls`,
        subtitle: `${graph.nodes.length} tool call${graph.nodes.length === 1 ? '' : 's'} from the chat, as runnable nodes${graph.skipped.length ? ` (${graph.skipped.length} left out)` : ''}`,
        nodes: graph.nodes,
        edges: graph.edges
    };
    const artifact: CanvasArtifact = {
        id: `art-toolcalls-${Date.now()}`,
        type: 'node-graph',
        title: data.title,
        summary: data.subtitle || '',
        version: 1,
        createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        data
    };
    return { artifact, graph };
}
