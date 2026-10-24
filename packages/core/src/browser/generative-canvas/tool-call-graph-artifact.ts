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

/** Recorded calls that can become nodes: they finished and kept their arguments. */
export function hasGraphableToolCalls(execs: McpExecutionState[] | undefined): boolean {
    return !!execs?.some(e => e.status !== 'running' && e.args);
}

/**
 * A chat reply's tool calls as a node-graph artifact. Tools the catalog lists under Canvas, and load_tools, steer the
 * chat itself (mount a card, ask a question, load tools) and are left out; so is anything the catalog does not list.
 */
export async function buildToolCallGraphArtifact(execs: McpExecutionState[], title: string): Promise<{ artifact: CanvasArtifact; graph: ToolCallGraph }> {
    const catalog = await ToolNodeClient.getInstance().listTools();
    const runnable = new Set(catalog.filter(t => t.pack !== 'Canvas' && t.name !== 'load_tools').map(t => t.name));
    const graph = toolCallsToNodeGraph(execs, name => runnable.has(name));
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
