/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Undo / redo for a node graph's edits (move, connect, unlink, add, delete, inspector fields). Each step is the graph
 * as it was before one edit. A step brings back the graph's structure only: a node that is still there keeps its run
 * state as it is now (status, error, output), so undoing a move never brings back an old error or loses a result.
 * Histories live outside the component, keyed by graph, so they survive the graph tab being left and reopened.
 */

import type { GraphNode, NodeGraphData } from './canvas-types';

export interface GraphEditHistory {
    past: NodeGraphData[];
    future: NodeGraphData[];
    /** The last recorded edit's merge key and time: repeated edits of one field (typing a label) are one step. */
    lastKey?: string;
    lastAtMs?: number;
}

export const GRAPH_HISTORY_LIMIT = 100;
const MERGE_WINDOW_MS = 1200;

export const emptyGraphHistory = (): GraphEditHistory => ({ past: [], future: [] });

/** The history after one edit, given the graph as it was before it. An edit that changes nothing is not a step. */
export function recordGraphEdit(h: GraphEditHistory, before: NodeGraphData, after: NodeGraphData, mergeKey?: string, nowMs = Date.now()): GraphEditHistory {
    if (sameStructure(before, after)) return h;
    const merges = !!mergeKey && mergeKey === h.lastKey && h.lastAtMs !== undefined && nowMs - h.lastAtMs < MERGE_WINDOW_MS && h.past.length > 0;
    const past = merges ? h.past : [...h.past, before].slice(-GRAPH_HISTORY_LIMIT);
    return { past, future: [], lastKey: mergeKey, lastAtMs: nowMs };
}

/** One step back: the graph to show and the history after it, or undefined when there is nothing to undo. */
export function undoGraphEdit(h: GraphEditHistory, current: NodeGraphData): { graph: NodeGraphData; history: GraphEditHistory } | undefined {
    const target = h.past[h.past.length - 1];
    if (!target) return undefined;
    return { graph: withRunState(target, current), history: { past: h.past.slice(0, -1), future: [current, ...h.future] } };
}

/** One step forward again, or undefined when there is nothing to redo. */
export function redoGraphEdit(h: GraphEditHistory, current: NodeGraphData): { graph: NodeGraphData; history: GraphEditHistory } | undefined {
    const target = h.future[0];
    if (!target) return undefined;
    return { graph: withRunState(target, current), history: { past: [...h.past, current].slice(-GRAPH_HISTORY_LIMIT), future: h.future.slice(1) } };
}

const RUN_FIELDS = ['status', 'errorMessage', 'outputData', 'executionDurationMs'] as const;

/** The step's graph, with the run state its nodes have now. */
function withRunState(step: NodeGraphData, current: NodeGraphData): NodeGraphData {
    const now = new Map(current.nodes.map(n => [n.id, n]));
    return {
        ...current,
        nodes: step.nodes.map(n => {
            const live = now.get(n.id);
            if (!live) return n;
            const next: GraphNode = { ...n };
            for (const f of RUN_FIELDS) (next as any)[f] = live[f];
            return next;
        }),
        edges: step.edges
    };
}

/** Same nodes (ignoring run state) and same edges. */
function sameStructure(a: NodeGraphData, b: NodeGraphData): boolean {
    if (a.edges.length !== b.edges.length || a.nodes.length !== b.nodes.length) return false;
    const strip = (n: GraphNode) => { const c: any = { ...n }; for (const f of RUN_FIELDS) delete c[f]; return JSON.stringify(c); };
    return a.nodes.every((n, i) => strip(n) === strip(b.nodes[i])) && a.edges.every((e, i) => JSON.stringify(e) === JSON.stringify(b.edges[i]));
}

const histories = new Map<string, GraphEditHistory>();

/** The edit history of one graph (by its artifact id), kept for as long as the page is open. */
export const graphHistories = {
    get: (key: string): GraphEditHistory => histories.get(key) ?? emptyGraphHistory(),
    set: (key: string, h: GraphEditHistory): void => { histories.set(key, h); }
};
