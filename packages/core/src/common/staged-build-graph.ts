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

import type { StagedBuildState, StageStatus, StageSummary, StageStepSummary } from './spatial/staged-location-contracts';
import { BUILD_RESULTS, BUILD_STEPS, TOGGLEABLE_STEPS, WRAPPER_STEPS } from './staged-build-steps';

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
const stepNodeId = (key: string) => `step-${key}`;

/**
 * The tool call that builds this place again into the same scene: the same query, isolated when the run isolated a
 * structure, staged into the scene the view reads (its earlier location layers are replaced, its other objects kept).
 */
export function stagedBuildToolArgs(sb: StagedBuildState, toggles?: StepToggles): Record<string, unknown> {
    const steps = Object.fromEntries(Object.entries(toggles ?? {}).filter(([k, v]) => TOGGLEABLE_STEPS.has(k) && typeof v === 'boolean'));
    return { query: sb.place.query, ...(sb.structure ? { isolate: true } : {}), stageIntoActiveScene: true, ...(Object.keys(steps).length ? { steps } : {}) };
}

/** The node graph's step switches for the next build, by step key (Scene3DData.stagedStepToggles): true on, false off. */
export type StepToggles = Record<string, boolean>;

function stageDetails(s: StageSummary, degradations: number): string {
    const parts = [`Status: ${s.status}${s.timings.cached ? ' (cached)' : ''}`];
    if (s.timings.ms !== undefined) parts.push(`Time: ${(s.timings.ms / 1000).toFixed(1)} s`);
    if (s.layerIds.length) parts.push(`Layers: ${s.layerIds.length}`);
    if (degradations) parts.push(`Degraded parts: ${degradations}`);
    if (s.cost) parts.push(`Cost: ${JSON.stringify(s.cost)}`);
    if (s.reason) parts.push(`Reason: ${s.reason}`);
    return parts.join('\n');
}

function buildNode(sb: StagedBuildState, toggles?: StepToggles): StageGraphNode {
    return {
        id: BUILD_NODE_ID,
        label: `Build: ${sb.place.resolvedAddress || sb.place.query}`,
        subtitle: 'google_3d_tiles_get_clay',
        category: 'tool',
        color: 'cyan',
        x: 60,
        y: 120,
        status: sb.runState === 'finished' ? 'completed' : sb.runState === 'running' ? 'running' : 'error',
        notes: `Run ${sb.runId}, ${sb.runState}. Re-running builds the place again into this scene with the same query; the run's other options are not in the scene record.`,
        parameters: { toolName: 'google_3d_tiles_get_clay', toolArgs: stagedBuildToolArgs(sb, toggles), targetArtifactId: sb.artifactId },
        outputData: { resultPayload: { runId: sb.runId, runState: sb.runState, resolvedAddress: sb.place.resolvedAddress, lat: sb.place.lat, lng: sb.place.lng }, recorded: true }
    };
}
const STEP_STATUS: Record<StageStepSummary['status'], StageGraphNode['status']> = { running: 'running', done: 'completed', failed: 'error', skipped: 'pending' };
const STEP_COLOR: Record<StageStepSummary['status'], StageGraphNode['color']> = { running: 'indigo', done: 'emerald', failed: 'rose', skipped: 'blue' };

/**
 * The build as its steps (a run that recorded them): each stage that runs timed steps is drawn as those steps, the rest
 * as their stage, and a step is wired to the steps that made what it reads (staged-build-steps.ts). Columns by how
 * many steps lie before a step; a step that changed the model carries its snapshot, shown in the viewport on its flag.
 */
function stepGraph(sb: StagedBuildState, toggles: StepToggles = {}): StageGraph {
    const stageOf = new Map(sb.stages.filter(s => !s.outOfScope).map(s => [s.stage, s] as const));
    const latest = new Map<string, StageStepSummary>();
    for (const st of sb.steps ?? []) if (!WRAPPER_STEPS.has(st.key)) latest.set(st.key, st);
    const steppedStages = new Set([...latest.values()].map(st => st.stage));
    const spec = new Map(BUILD_STEPS.map(b => [b.key, b] as const));

    interface Item { id: string; key: string; stage: string; title: string; needs: string[]; makes: string[]; off?: boolean; node: Omit<StageGraphNode, 'x' | 'y'> }
    const items: Item[] = [];
    const stageItem = (s: StageSummary, needs: string[], makes: string[]): Item => ({
        id: stageNodeId(s.stage), key: s.stage, stage: s.stage, title: spec.get(s.stage)?.title ?? s.title, needs, makes,
        node: {
            id: stageNodeId(s.stage), label: s.title, subtitle: s.source || s.stage, category: 'stage', color: NODE_COLOR[s.status] ?? 'blue',
            status: NODE_STATUS[s.status] ?? 'pending', executionDurationMs: s.timings.ms,
            errorMessage: s.status === 'failed' || s.status === 'stopped' ? s.reason : undefined, details: stageDetails(s, s.degradationIds.length), notes: s.reason,
            parameters: { stage: s.stage, status: s.status, layers: s.layerIds.length, degradations: s.degradationIds.length, cached: s.timings.cached, readOnly: true }
        }
    });
    // a toggleable step is on for the next build when its switch says so, else as it ran (a skipped step stays off)
    const nextOn = (key: string, ran?: StageStepSummary['status']) => toggles[key] ?? ran !== 'skipped';
    const stepItem = (st: StageStepSummary, title: string, needs: string[], makes: string[]): Item => {
        const toggle = TOGGLEABLE_STEPS.has(st.key) ? { key: st.key, on: nextOn(st.key, st.status), whenOff: TOGGLEABLE_STEPS.get(st.key)! } : undefined;
        const off = toggle ? !toggle.on : false;
        return {
        id: stepNodeId(st.key), key: st.key, stage: st.stage, title, needs, makes, off,
        node: {
            id: stepNodeId(st.key), label: title, subtitle: `${stageOf.get(st.stage)?.title ?? st.stage} · ${st.key}`, category: 'step', color: STEP_COLOR[st.status],
            status: STEP_STATUS[st.status], executionDurationMs: st.ms,
            details: [`Status: ${st.status}`, ...(st.ms !== undefined ? [`Time: ${(st.ms / 1000).toFixed(1)} s`] : []), st.snapshot ? 'Snapshot: the model after this step' : 'No snapshot: shows its stage\'s result', ...(off ? [`Off for the next build: ${toggle!.whenOff}`] : [])].join('\n'),
            parameters: { stage: st.stage, step: st.key, status: st.status, readOnly: true, ...(st.snapshot ? { snapshot: st.snapshot } : {}), ...(toggle ? { toggle } : {}), ...(off ? { off: true } : {}) }
        }
        };
    };
    // in run order: the listed steps first, then anything recorded that the list does not name (drawn unwired)
    for (const b of BUILD_STEPS) {
        const st = latest.get(b.key) ?? (TOGGLEABLE_STEPS.has(b.key) && steppedStages.has(b.stage) ? { key: b.key, stage: b.stage, status: 'skipped' as const, startedAtMs: 0 } : undefined);
        if (st) { items.push(stepItem(st, b.title, b.needs, b.makes)); continue; }
        const s = b.key === b.stage ? stageOf.get(b.stage) : undefined;
        if (s && s.status !== 'skipped' && !steppedStages.has(s.stage)) items.push(stageItem(s, b.needs, b.makes));
    }
    for (const st of latest.values()) if (!spec.has(st.key)) items.push(stepItem(st, st.key, [], []));
    for (const s of stageOf.values()) {
        if (s.status === 'skipped' || steppedStages.has(s.stage) || spec.has(s.stage)) continue;
        items.push(stageItem(s, [], []));
    }

    // wires: from the latest earlier item that made each result an item reads
    const edges: StageGraphEdge[] = [];
    const byPair = new Map<string, StageGraphEdge>();
    const depth = new Map<string, number>();
    // what an item reads for a result: the latest earlier item that makes it, or, past a step turned off, what that step
    // would have read (cleanup off: the lattice reads tile_refine's remesh); `via` names the off steps passed
    const sources = (need: string, before: number, via: string[] = []): Array<{ from: Item; need: string; via: string[] }> => {
        const k = items.slice(0, before).map((o, j) => [o, j] as const).reverse().find(([o]) => o.makes.includes(need));
        if (!k) return [];
        const [from, j] = k;
        if (!from.off) return [{ from, need, via }];
        return from.needs.flatMap(n => sources(n, j, [...via, from.title]));
    };
    items.forEach((it, i) => {
        let d = 0;
        const reads = it.needs.flatMap(need => sources(need, i));
        for (const { from, need, via } of reads) {
            d = Math.max(d, (depth.get(from.id) ?? 0) + 1);
            const pair = `${from.id}>${it.id}`;
            const label = `${BUILD_RESULTS[need] ?? need}${via.length ? ` (${via.join(', ')} off)` : ''}`;
            const prev = byPair.get(pair);
            if (prev) { if (!prev.label?.split(', ').includes(label)) prev.label = `${prev.label}, ${label}`; continue; }
            const e: StageGraphEdge = { id: `e-${pair}`, source: from.id, target: it.id, label, style: it.off || via.length ? 'dashed' : 'solid' };
            byPair.set(pair, e);
            edges.push(e);
        }
        depth.set(it.id, d);
    });
    const rows = new Map<number, number>();
    const nodes: StageGraphNode[] = items.map(it => {
        const d = depth.get(it.id) ?? 0;
        const row = rows.get(d) ?? 0;
        rows.set(d, row + 1);
        return { ...it.node, x: 360 + d * 290, y: 60 + row * 200 };
    });
    const targets = new Set(edges.map(e => e.target));
    for (const n of nodes) if (!targets.has(n.id)) edges.push({ id: `e-build-${n.id}`, source: BUILD_NODE_ID, target: n.id, style: 'dashed' });

    const cols = Math.max(0, ...depth.values()) + 1;
    const final = finalLayers(sb);
    const outputNode: StageGraphNode = {
        id: OUTPUT_NODE_ID, label: 'Output: viewport',
        subtitle: `${final.length} layer${final.length === 1 ? '' : 's'} in the scene${sb.materialMode ? `, ${sb.materialMode}` : ''}`,
        category: 'output', color: 'emerald', x: 360 + cols * 290, y: 120,
        status: sb.runState === 'running' ? 'running' : 'completed',
        details: final.map(l => `${l.stage}: ${l.layer}`).join('\n'),
        parameters: { output: true, finalObjectIds: final.map(l => l.objectId), readOnly: true }
    };
    // the output reads the last item of each stage whose layer the scene shows
    for (const st of new Set(final.map(l => l.stage))) {
        const last = [...items].reverse().find(it => it.stage === st && !it.off);
        if (last) edges.push({ id: `e-out-${last.id}`, source: last.id, target: OUTPUT_NODE_ID, label: 'final layer', style: 'solid' });
    }
    const done = [...latest.values()].filter(st => st.status === 'done').length;
    return {
        title: `${sb.place.resolvedAddress || sb.place.query} — build steps`,
        subtitle: `Run ${sb.runId} (${sb.runState}): ${items.length} steps, ${done} timed steps done. Wires carry what a step reads; click a step's flag to see the model as it stood after it.`,
        nodes: [buildNode(sb, toggles), ...nodes, outputNode],
        edges,
        stageViewOf: { artifactId: sb.artifactId, updatedAtMs: sb.updatedAtMs }
    };
}

export function stagedBuildToNodeGraph(sb: StagedBuildState, toggles?: StepToggles): StageGraph {
    if (sb.steps?.length) return stepGraph(sb, toggles);
    const stages = sb.stages
        .filter(s => !s.outOfScope)
        .slice()
        .sort((a, b) => (a.timings.startedAtMs || Infinity) - (b.timings.startedAtMs || Infinity) || a.order - b.order);

    const node = buildNode(sb);

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
        nodes: [node, ...stageNodes, outputNode],
        edges,
        stageViewOf: { artifactId: sb.artifactId, updatedAtMs: sb.updatedAtMs }
    };
}

/**
 * The view rebuilt from a newer run record, keeping what the user did to it: where each node was dragged, and the
 * build node's own run state while it is running or after it ran here (its card shows that run, not the record's).
 */
export function refreshStageGraph<N extends { id: string; x: number; y: number; status?: string; outputData?: unknown; errorMessage?: string; executionDurationMs?: number }>(
    prev: N[], sb: StagedBuildState, toggles?: StepToggles
): StageGraph {
    const next = stagedBuildToNodeGraph(sb, toggles);
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
