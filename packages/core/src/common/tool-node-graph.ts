/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Graph rules for canvas tool nodes. A tool node is any node whose parameters name a tool (`toolName`); its own
 * inputs are `toolArgs`. When it runs, an argument it leaves empty is taken from the nearest upstream node's output
 * that carries a field of the same name, so a GLB path, a station list or an image one tool returns feeds the next
 * tool by name alone, with no per-tool wiring.
 */

import type { ToolNodeCatalogEntry, ToolNodeParameterSchema } from './tool-node-protocol';

export interface ToolGraphNode {
    id: string;
    parameters?: Record<string, any>;
    outputData?: any;
}

export interface ToolGraphEdge {
    source: string;
    target: string;
    /** Target input -> source output field, for an input whose name differs from the field that feeds it. */
    fieldMap?: Record<string, string>;
}

export interface ToolNodeParameters {
    toolName: string;
    toolArgs: Record<string, unknown>;
}

export function isToolNode(node: ToolGraphNode): boolean {
    return typeof node.parameters?.toolName === 'string' && node.parameters.toolName.length > 0;
}

/** A new tool node's parameters: every argument starts empty, so upstream outputs or the user fill it. */
export function toolNodeParameters(tool: ToolNodeCatalogEntry): ToolNodeParameters {
    return { toolName: tool.name, toolArgs: {} };
}

/** "google_3d_tiles_get_clay" -> "Google 3d tiles get clay". */
export function toolNodeLabel(name: string): string {
    const words = name.split('_').filter(Boolean).join(' ');
    return words ? words[0].toUpperCase() + words.slice(1) : name;
}

const isEmpty = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

/** A node's output fields, from its tool result (resultPayload, and a `data` object inside it) or its media output. */
export function outputFields(node: ToolGraphNode): Record<string, unknown> {
    const out = node.outputData;
    if (!out || typeof out !== 'object') return {};
    const payload = out.resultPayload && typeof out.resultPayload === 'object' ? out.resultPayload : out;
    const data = payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data) ? payload.data : {};
    return { ...data, ...payload };
}

/** Upstream nodes, nearest first (breadth-first against the edges). */
export function upstreamNodes(nodeId: string, nodes: ToolGraphNode[], edges: ToolGraphEdge[]): ToolGraphNode[] {
    const byId = new Map(nodes.map(n => [n.id, n]));
    const seen = new Set([nodeId]);
    const order: ToolGraphNode[] = [];
    let frontier = [nodeId];
    while (frontier.length) {
        const next: string[] = [];
        for (const id of frontier) for (const e of edges) {
            if (e.target !== id || seen.has(e.source)) continue;
            seen.add(e.source);
            const n = byId.get(e.source);
            if (n) { order.push(n); next.push(e.source); }
        }
        frontier = next;
    }
    return order;
}

export interface ResolvedToolArgs {
    args: Record<string, unknown>;
    /** Which upstream node filled each argument the node left empty. */
    filledFrom: Record<string, string>;
    /** Required arguments still empty after the upstream fill. */
    missingRequired: string[];
}

/**
 * The node's own arguments, with empty ones filled from upstream: first through an incoming edge's field map, then by
 * name from the nearest upstream output that has the field.
 */
export function resolveToolNodeArgs(node: ToolGraphNode, nodes: ToolGraphNode[], edges: ToolGraphEdge[], schema?: ToolNodeParameterSchema): ResolvedToolArgs {
    const own: Record<string, unknown> = { ...(node.parameters?.toolArgs || {}) };
    for (const k of Object.keys(own)) if (isEmpty(own[k])) delete own[k];
    const names = new Set([...Object.keys(schema?.properties || {}), ...Object.keys(own)]);
    const filledFrom: Record<string, string> = {};
    const byId = new Map(nodes.map(n => [n.id, n]));
    for (const e of edges) {
        if (e.target !== node.id || !e.fieldMap) continue;
        const src = byId.get(e.source);
        if (!src) continue;
        const fields = outputFields(src);
        for (const [input, field] of Object.entries(e.fieldMap)) {
            names.add(input);
            if (isEmpty(own[input]) && !isEmpty(fields[field])) { own[input] = fields[field]; filledFrom[input] = e.source; }
        }
    }
    const ups = upstreamNodes(node.id, nodes, edges).map(n => ({ id: n.id, fields: outputFields(n) }));
    for (const name of names) {
        if (!isEmpty(own[name])) continue;
        const hit = ups.find(u => !isEmpty(u.fields[name]));
        if (hit) { own[name] = hit.fields[name]; filledFrom[name] = hit.id; }
    }
    const missingRequired = (schema?.required || []).filter(r => isEmpty(own[r]));
    return { args: own, filledFrom, missingRequired };
}

/** Tool nodes in dependency order (Kahn's order over the whole graph); nodes on a cycle come last, in graph order. */
export function toolRunOrder(nodes: ToolGraphNode[], edges: ToolGraphEdge[]): ToolGraphNode[] {
    const ids = new Set(nodes.map(n => n.id));
    const indeg = new Map(nodes.map(n => [n.id, 0]));
    for (const e of edges) if (ids.has(e.source) && ids.has(e.target)) indeg.set(e.target, (indeg.get(e.target) || 0) + 1);
    const queue = nodes.filter(n => indeg.get(n.id) === 0).map(n => n.id);
    const ordered: string[] = [];
    while (queue.length) {
        const id = queue.shift()!;
        ordered.push(id);
        for (const e of edges) if (e.source === id && ids.has(e.target)) {
            indeg.set(e.target, indeg.get(e.target)! - 1);
            if (indeg.get(e.target) === 0) queue.push(e.target);
        }
    }
    for (const n of nodes) if (!ordered.includes(n.id)) ordered.push(n.id);
    const byId = new Map(nodes.map(n => [n.id, n]));
    return ordered.map(id => byId.get(id)!).filter(isToolNode);
}

/** A form value typed for the parameter's schema; '' clears it. Throws on JSON that does not parse for an object or list. */
export function coerceToolArgInput(raw: string | boolean, schema: ToolNodeParameterSchema): unknown {
    if (typeof raw === 'boolean') return raw;
    if (raw.trim() === '') return undefined;
    switch (schema.type) {
        case 'NUMBER': { const n = Number(raw); if (!Number.isFinite(n)) throw new Error(`"${raw}" is not a number`); return n; }
        case 'BOOLEAN': return raw === 'true';
        case 'OBJECT': case 'ARRAY': {
            const v = JSON.parse(raw);
            if (schema.type === 'ARRAY' ? !Array.isArray(v) : (typeof v !== 'object' || v === null || Array.isArray(v))) throw new Error(`expected ${schema.type === 'ARRAY' ? 'a JSON list' : 'a JSON object'}`);
            return v;
        }
        default: return raw;
    }
}

const SHORT_TEXT = 400;
const isShort = (v: unknown): boolean =>
    typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && v.length <= SHORT_TEXT);

/** A tool result's short fields (top level and its `data` object), small enough to keep with the chat's record of the call. */
export function compactResultFields(resultPayload: Record<string, unknown> | undefined, maxFields = 40): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (!resultPayload || typeof resultPayload !== 'object') return out;
    const data = resultPayload.data && typeof resultPayload.data === 'object' && !Array.isArray(resultPayload.data) ? resultPayload.data as Record<string, unknown> : {};
    for (const [k, v] of Object.entries({ ...data, ...resultPayload })) {
        if (Object.keys(out).length >= maxFields) break;
        if (isShort(v)) out[k] = v;
        else if (Array.isArray(v) && v.length <= 20 && v.every(isShort)) out[k] = v;
    }
    return out;
}

/** One finished chat tool call, as the chat keeps it (McpExecutionState's fields this needs). */
export interface RecordedToolCall {
    id: string;
    toolName: string;
    status: 'running' | 'completed' | 'failed';
    args?: Record<string, unknown>;
    resultFields?: Record<string, unknown>;
    summaryResult?: string;
    durationMs?: number;
}

export interface ToolCallGraphNode extends ToolGraphNode {
    label: string;
    subtitle: string;
    category: 'tool';
    color: 'cyan' | 'rose';
    x: number;
    y: number;
    status: 'completed' | 'error' | 'pending';
    executionDurationMs?: number;
    errorMessage?: string;
}

export interface ToolCallGraph {
    nodes: ToolCallGraphNode[];
    edges: Array<{ id: string; source: string; target: string; label: string; style: 'solid'; fieldMap: Record<string, string> }>;
    /** Calls left out: still running, recorded without arguments, or not runnable from a node. */
    skipped: Array<{ toolName: string; reason: string }>;
}

/** Equal, or for numbers equal to 12 significant digits: the model often passes a returned number back rounded. */
const sameValue = (a: unknown, b: unknown) => a === b
    || (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= 1e-12 * Math.max(Math.abs(a), Math.abs(b)) * 1e3);
const linkable = (v: unknown) => (typeof v === 'string' && v.trim().length >= 3) || (typeof v === 'number' && Number.isFinite(v) && !Number.isInteger(v));

/**
 * A chat turn's tool calls as a tool node graph, in call order: each call is a node carrying the arguments it ran
 * with, and an edge runs from an earlier call to a later one wherever the later call's argument is a value the earlier
 * call returned (a path, an id, a fractional measurement), labelled with the field it came from. Re-running the graph
 * re-runs the build; an argument the user empties is filled from upstream by name (resolveToolNodeArgs).
 */
export function toolCallsToNodeGraph(calls: RecordedToolCall[], runnable: (toolName: string) => boolean): ToolCallGraph {
    const nodes: ToolCallGraphNode[] = [];
    const edges: ToolCallGraph['edges'] = [];
    const skipped: ToolCallGraph['skipped'] = [];
    const COLS = 4, DX = 300, DY = 230;
    for (const call of calls) {
        if (call.status === 'running') { skipped.push({ toolName: call.toolName, reason: 'still running' }); continue; }
        if (!runnable(call.toolName)) { skipped.push({ toolName: call.toolName, reason: 'a chat-only tool, not runnable from a node' }); continue; }
        if (!call.args) { skipped.push({ toolName: call.toolName, reason: 'recorded before calls kept their arguments' }); continue; }
        const i = nodes.length;
        const id = `call-${i + 1}-${call.toolName}`;
        nodes.push({
            id,
            label: `${i + 1}. ${toolNodeLabel(call.toolName)}`,
            subtitle: call.toolName,
            category: 'tool',
            color: call.status === 'failed' ? 'rose' : 'cyan',
            x: 80 + (i % COLS) * DX,
            y: 80 + Math.floor(i / COLS) * DY,
            status: call.status === 'failed' ? 'error' : 'completed',
            executionDurationMs: call.durationMs,
            errorMessage: call.status === 'failed' ? call.summaryResult : undefined,
            parameters: { toolName: call.toolName, toolArgs: { ...call.args } },
            outputData: { resultPayload: call.resultFields || {}, summary: call.summaryResult, recorded: true, recordedArgs: { ...call.args } }
        });
        // the latest earlier call that returned this argument's value feeds it: the input comes off the node and onto the
        // edge, so a re-run takes the fresh value from upstream instead of the recorded one
        for (const [arg, value] of Object.entries(call.args)) {
            if (!linkable(value)) continue;
            for (let j = i - 1; j >= 0; j--) {
                const fields = nodes[j].outputData.resultPayload as Record<string, unknown>;
                const field = Object.keys(fields).find(k => sameValue(fields[k], value));
                if (!field) continue;
                let edge = edges.find(e => e.source === nodes[j].id && e.target === id);
                if (!edge) { edge = { id: `e-${nodes[j].id}-${id}`, source: nodes[j].id, target: id, label: '', style: 'solid', fieldMap: {} }; edges.push(edge); }
                edge.fieldMap[arg] = field;
                edge.label = Object.entries(edge.fieldMap).map(([a, f]) => a === f ? a : `${f} → ${a}`).join(', ');
                delete (nodes[i].parameters!.toolArgs as Record<string, unknown>)[arg];
                nodes[i].outputData.filledFrom = { ...(nodes[i].outputData.filledFrom || {}), [arg]: nodes[j].id };
                break;
            }
        }
    }
    return { nodes, edges, skipped };
}

export interface ToolOutputSummary {
    /** Short scalar fields, for the card. */
    fields: Array<{ key: string; value: string }>;
    /** Every file path in the output (any depth), e.g. GLBs and images a later node or the viewer can open. */
    files: string[];
}

const FILE_PATH = /^(?:\/|\.{0,2}\/|[A-Za-z]:\\|public\/|build\/)?[^\s"'<>|]*\.[A-Za-z0-9]{2,5}$/;

export function summarizeToolOutput(resultPayload: Record<string, unknown> | undefined, maxFields = 6): ToolOutputSummary {
    const fields: ToolOutputSummary['fields'] = [];
    const files = new Set<string>();
    const walk = (v: unknown, depth: number) => {
        if (depth > 6 || v === null || v === undefined) return;
        if (typeof v === 'string') { if (v.length < 400 && /[\\/]/.test(v) && FILE_PATH.test(v)) files.add(v); return; }
        if (Array.isArray(v)) { v.slice(0, 200).forEach(x => walk(x, depth + 1)); return; }
        if (typeof v === 'object') for (const x of Object.values(v as Record<string, unknown>)) walk(x, depth + 1);
    };
    walk(resultPayload, 0);
    const flat = { ...((resultPayload?.data && typeof resultPayload.data === 'object' && !Array.isArray(resultPayload.data)) ? resultPayload.data as Record<string, unknown> : {}), ...(resultPayload || {}) };
    for (const [key, value] of Object.entries(flat)) {
        if (fields.length >= maxFields) break;
        if (key === 'data') continue;
        if (typeof value === 'number' || typeof value === 'boolean' || (typeof value === 'string' && value.length <= 120)) fields.push({ key, value: String(value) });
    }
    return { fields, files: [...files] };
}
