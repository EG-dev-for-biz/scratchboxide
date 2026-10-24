/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A staged location build (the 3D Building button, google_3d_tiles_get_clay) as a node graph, read from the run the
 * scene carries (Scene3DData.stagedBuild): one runnable tool node for the whole build, then one read-only node per
 * stage with its status, reason, time, cost, layers and degradations. Stage edges come from the record itself: a stage
 * whose layer supersedes another stage's layer builds on it. The stages are not separate tools (they share one run's
 * state in runStagedLocation); the build node re-runs all of them.
 */

import type { StagedBuildState, StageStatus, StageSummary } from './spatial/staged-location-contracts';

export interface StageGraphNode {
    id: string;
    label: string;
    subtitle: string;
    category: string;
    color: 'cyan' | 'emerald' | 'amber' | 'rose' | 'indigo' | 'blue';
    x: number;
    y: number;
    status: 'completed' | 'error' | 'pending' | 'running' | 'active';
    executionDurationMs?: number;
    errorMessage?: string;
    details?: string;
    notes?: string;
    parameters: Record<string, unknown>;
    outputData?: unknown;
}

export interface StageGraphEdge {
    id: string;
    source: string;
    target: string;
    label?: string;
    style: 'solid' | 'dashed';
}

export interface StageGraph {
    title: string;
    subtitle: string;
    nodes: StageGraphNode[];
    edges: StageGraphEdge[];
    /** The scene this view reads: refreshed from it whenever its run record changes (refreshStageGraph). */
    stageViewOf: { artifactId: string; updatedAtMs: number };
}

const NODE_STATUS: Record<StageStatus, StageGraphNode['status']> = {
    pending: 'pending', running: 'running', committed: 'completed', degraded: 'completed', skipped: 'pending', failed: 'error', stopped: 'error'
};
const NODE_COLOR: Record<StageStatus, StageGraphNode['color']> = {
    pending: 'blue', running: 'indigo', committed: 'emerald', degraded: 'amber', skipped: 'blue', failed: 'rose', stopped: 'rose'
};

export const BUILD_NODE_ID = 'staged-build';
export const OUTPUT_NODE_ID = 'scene-output';

/** The layers the finished scene shows: every layer no other layer replaced (supersedes). */
export function finalLayers(sb: StagedBuildState): StagedBuildState['layers'] {
    const replaced = new Set(sb.layers.flatMap(l => l.supersedes || []));
    return sb.layers.filter(l => !replaced.has(l.objectId));
}

/** A stage's own layers, by objects[].id: what the viewport shows while that stage holds the display flag. */
export function stageLayerIds(sb: StagedBuildState, stage: string): string[] {
    const fromSummary = sb.stages.find(s => s.stage === stage)?.layerIds ?? [];
    return [...new Set([...fromSummary, ...sb.layers.filter(l => l.stage === stage).map(l => l.objectId)])];
}
const stageNodeId = (stage: string) => `stage-${stage}`;

/**
 * The tool call that builds this place again into the same scene: the same query, isolated when the run isolated a
 * structure, staged into the scene the view reads (its earlier location layers are replaced, its other objects kept).
 */
export function stagedBuildToolArgs(sb: StagedBuildState): Record<string, unknown> {
    return { query: sb.place.query, ...(sb.structure ? { isolate: true } : {}), stageIntoActiveScene: true };
}

function stageDetails(s: StageSummary, degradations: number): string {
    const parts = [`Status: ${s.status}${s.timings.cached ? ' (cached)' : ''}`];
    if (s.timings.ms !== undefined) parts.push(`Time: ${(s.timings.ms / 1000).toFixed(1)} s`);
    if (s.layerIds.length) parts.push(`Layers: ${s.layerIds.length}`);
    if (degradations) parts.push(`Degraded parts: ${degradations}`);
    if (s.cost) parts.push(`Cost: ${JSON.stringify(s.cost)}`);
    if (s.reason) parts.push(`Reason: ${s.reason}`);
    return parts.join('\n');
}

export function stagedBuildToNodeGraph(sb: StagedBuildState): StageGraph {
    const stages = sb.stages
        .filter(s => !s.outOfScope)
        .slice()
        .sort((a, b) => (a.timings.startedAtMs || Infinity) - (b.timings.startedAtMs || Infinity) || a.order - b.order);

    const buildNode: StageGraphNode = {
        id: BUILD_NODE_ID,
        label: `Build: ${sb.place.resolvedAddress || sb.place.query}`,
        subtitle: 'google_3d_tiles_get_clay',
        category: 'tool',
        color: 'cyan',
        x: 60,
        y: 120,
        status: sb.runState === 'finished' ? 'completed' : sb.runState === 'running' ? 'running' : 'error',
        notes: `Run ${sb.runId}, ${sb.runState}. Re-running builds the place again into this scene with the same query; the run's other options are not in the scene record.`,
        parameters: { toolName: 'google_3d_tiles_get_clay', toolArgs: stagedBuildToolArgs(sb), targetArtifactId: sb.artifactId },
        outputData: { resultPayload: { runId: sb.runId, runState: sb.runState, resolvedAddress: sb.place.resolvedAddress, lat: sb.place.lat, lng: sb.place.lng }, recorded: true }
    };

    // stage columns by canonical order (no-layer stages, order -1, first); rows by start time within a column
    const cols = [...new Set(stages.map(s => s.order))].sort((a, b) => a - b);
    const rowInCol = new Map<number, number>();
    const stageNodes: StageGraphNode[] = stages.map(s => {
        const col = cols.indexOf(s.order);
        const row = rowInCol.get(s.order) ?? 0;
        rowInCol.set(s.order, row + 1);
        const degradations = s.degradationIds.length;
        return {
            id: stageNodeId(s.stage),
            label: s.title,
            subtitle: s.source || s.stage,
            category: 'stage',
            color: NODE_COLOR[s.status] ?? 'blue',
            x: 360 + col * 290,
            y: 60 + row * 200,
            status: NODE_STATUS[s.status] ?? 'pending',
            executionDurationMs: s.timings.ms,
            errorMessage: s.status === 'failed' || s.status === 'stopped' ? s.reason : undefined,
            details: stageDetails(s, degradations),
            notes: s.reason,
            parameters: { stage: s.stage, status: s.status, layers: s.layerIds.length, degradations, cached: s.timings.cached, readOnly: true }
        };
    });

    // a stage builds on another when one of its layers must reveal after that stage's layer (a recorded data dependency)
    // or replaces it
    const shown = new Set(stages.map(s => s.stage));
    const stageOfLayer = new Map<string, string>();
    for (const l of sb.layers) stageOfLayer.set(l.objectId, l.stage);
    for (const s of stages) for (const id of s.layerIds) stageOfLayer.set(id, s.stage);
    const edges: StageGraphEdge[] = [];
    const byKey = new Map<string, StageGraphEdge>();
    for (const layer of sb.layers) {
        const to = layer.stage;
        const deps: Array<[string[] | undefined, string]> = [[layer.revealAfter, 'builds on'], [layer.supersedes, 'replaces layer']];
        for (const [ids, label] of deps) for (const id of ids || []) {
            const from = stageOfLayer.get(id);
            if (!from || from === to || !shown.has(from) || !shown.has(to)) continue;
            const key = `${from}>${to}`;
            const prev = byKey.get(key);
            if (prev) { if (!prev.label?.includes(label)) prev.label = `${prev.label}, ${label}`; continue; }
            const edge: StageGraphEdge = { id: `e-${key}`, source: stageNodeId(from), target: stageNodeId(to), label, style: 'solid' };
            byKey.set(key, edge);
            edges.push(edge);
        }
    }
    // the build starts every stage that builds on no other
    const targets = new Set(edges.map(e => e.target));
    for (const n of stageNodes) if (!targets.has(n.id)) edges.push({ id: `e-build-${n.id}`, source: BUILD_NODE_ID, target: n.id, style: 'dashed' });

    // the end of the graph: what the viewport shows. Its inputs are the stages whose layers no later layer replaced
    const final = finalLayers(sb);
    const finalStages = [...new Set(final.map(l => l.stage))].filter(st => shown.has(st));
    const outputNode: StageGraphNode = {
        id: OUTPUT_NODE_ID,
        label: 'Output: viewport',
        subtitle: `${final.length} layer${final.length === 1 ? '' : 's'} in the scene${sb.materialMode ? `, ${sb.materialMode}` : ''}`,
        category: 'output',
        color: 'emerald',
        x: 360 + cols.length * 290,
        y: 120,
        status: sb.runState === 'running' ? 'running' : 'completed',
        details: final.map(l => `${l.stage}: ${l.layer}`).join('\n'),
        parameters: { output: true, finalObjectIds: final.map(l => l.objectId), readOnly: true }
    };
    for (const st of finalStages) edges.push({ id: `e-out-${st}`, source: stageNodeId(st), target: OUTPUT_NODE_ID, label: 'final layer', style: 'solid' });

    const counts = stages.reduce<Record<string, number>>((m, s) => { m[s.status] = (m[s.status] || 0) + 1; return m; }, {});
    return {
        title: `${sb.place.resolvedAddress || sb.place.query} — build stages`,
        subtitle: `Run ${sb.runId} (${sb.runState}): ${stages.length} stages, ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}. Stages are read-only; the build node re-runs the whole build.`,
        nodes: [buildNode, ...stageNodes, outputNode],
        edges,
        stageViewOf: { artifactId: sb.artifactId, updatedAtMs: sb.updatedAtMs }
    };
}

/**
 * The view rebuilt from a newer run record, keeping what the user did to it: where each node was dragged, and the
 * build node's own run state while it is running or after it ran here (its card shows that run, not the record's).
 */
export function refreshStageGraph<N extends { id: string; x: number; y: number; status?: string; outputData?: unknown; errorMessage?: string; executionDurationMs?: number }>(
    prev: N[], sb: StagedBuildState
): StageGraph {
    const next = stagedBuildToNodeGraph(sb);
    const old = new Map(prev.map(n => [n.id, n]));
    next.nodes = next.nodes.map(n => {
        const p = old.get(n.id);
        if (!p) return n;
        const moved = { ...n, x: p.x, y: p.y };
        const ranHere = n.id === BUILD_NODE_ID && (p.status === 'running' || (p.outputData as { recorded?: boolean } | undefined)?.recorded === false);
        return ranHere ? { ...moved, status: p.status as StageGraphNode['status'], outputData: p.outputData, errorMessage: p.errorMessage, executionDurationMs: p.executionDurationMs } : moved;
    });
    return next;
}
