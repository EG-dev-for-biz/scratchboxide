/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * useStagedBuild: the viewport side of a staged location build (design §7).
 *
 * It reads Scene3DData.stagedBuild plus the StageEvents streamed since (stagedBuildState.ts), runs the reveal
 * scheduler every frame from a guard on scene.onBeforeRender, gives each staged mesh the look the frame asks for
 * (revealMaterial.ts), shades by provenance when asked (provenanceShading.ts), re-adds retired layers for replay or
 * comparison, and renders the overlay. With nothing revealing, nothing pending and provenance off, the guard comes off
 * and the original materials are back: the steady state costs nothing.
 *
 * Performance (§7.7): unstarted nodes are hidden (not drawn at all) until their window opens, so a 1.4 M-triangle
 * tree layer is drawn in growing chunks; three's per-mesh frustum culling applies to every tree node; at most
 * MAX_NEW_MATERIALS_PER_FRAME staged materials are built per frame (the rest stay hidden a frame longer); a reveal is
 * skipped to its end state when frames take over 40 ms ten times in a row, when the page is hidden, or for a layer
 * over 3 M vertices. The overlay refreshes on its own (a small store), so a running stage's clock never re-renders the
 * whole viewport.
 */

import * as React from 'react';
import * as THREE from 'three';
import type { Media4DObject, Scene3DData } from '../../../canvas-types';
import type {
    DegradationRecord,
    ProvenanceLabel,
    ProvenanceRecord,
    StageEvent,
    StagedBuildState,
    StagedLayer,
    StagedNodeExtras
} from '../../../../../common/spatial/staged-location-contracts';
import type { RendererStack } from '../types';
import { StagedBuildOverlay, type DegradationPlacementNote } from './StagedBuildOverlay';
import { placeDegradations, type Placement, type PlacementRoot } from './degradationPlacement';
import { nodeProgress, nodeRevealWindow, stepRevealSchedule, type LayerLoadState, type LayerRevealFrame, type RevealFrame, type RevealSchedule } from './revealScheduler';
import { REVEAL_ATTRIBUTE, StagedMaterialRegistry, installRenderGuard, type MeshStagedLook } from './revealMaterial';
import { classUniforms, legendRows, patternCode, provenanceBackground, resolveLegend, shadingClasses, styleFor, uncertaintyCoverage, type LegendStyle } from './provenanceShading';
import { isInterrupted, isRunSettled, stageEventsFor, streamedProgress, subscribeStageEvents, withStreamedEvents, type StageProgress } from './stagedBuildState';

/** Staged materials built per frame at most; meshes past the budget stay hidden one more frame. */
export const MAX_NEW_MATERIALS_PER_FRAME = 256;
/** Original materials put back per frame at most (each disposes a staged one); the rest keep their fully revealed staged material a frame longer. */
export const MAX_RESTORES_PER_FRAME = 256;
/** A frame slower than this, ten frames in a row while revealing, skips the remaining reveals to their end. */
export const SLOW_FRAME_MS = 40;
export const SLOW_FRAME_RUN = 10;
/** A layer above this many vertices shows its end state at once. */
export const SKIP_REVEAL_ABOVE_VERTICES = 3_000_000;
/** How long a degraded part stays highlighted after the user picks it in the overlay. */
export const HIGHLIGHT_MS = 4000;
/** Presence of a superseded layer under "Show replaced layers". */
export const GHOST_PRESENCE = 0.25;
/** The overlay's clock refresh while a stage runs or a layer reveals. */
const OVERLAY_REFRESH_MS = 250;

/** Per-frame cost of the guard itself (ms of JS) and what it did, for the performance check; ring buffers. */
export const stagedRevealStats = {
    guardMs: [] as number[], newMaterials: [] as number[], restored: [] as number[], drawnStagedMeshes: [] as number[], max: 600,
    /** The last frame's layers, for diagnostics: phase, progress and presence per object id. */
    layers: [] as Array<{ objectId: string; phase: string; progress: number; presence: number; hidden: boolean }>
};
function recordStat(list: number[], v: number): void {
    list.push(v);
    if (list.length > stagedRevealStats.max) list.shift();
}

export interface UseStagedBuildOptions {
    state: StagedBuildState | undefined;
    stackRef: React.MutableRefObject<RendererStack | null>;
    /** Loaded model roots by object id (Scene3DPrimitive's externalObjectsMapRef). */
    objectRootsRef: React.MutableRefObject<Map<string, THREE.Object3D>>;
    /** Scene3DPrimitive's per-object load status (only `phase` is read). */
    loadStatus: Readonly<Record<string, { phase: string } | undefined>>;
    mutateSceneData: (mutator: (prev: Scene3DData) => Scene3DData) => void;
    onPromptAction?: (prompt: string) => void;
}

export interface StagedBuildHandle {
    active: boolean;
    overlay: (opts: { bottomInsetPx: number }) => React.ReactNode;
}

interface NodeInfo {
    node: THREE.Object3D;
    extras?: StagedNodeExtras['sb'];
    provenance: ProvenanceRecord;
    fitRmsM?: number;
    order: number;
    count: number;
    durationShare?: number;
    perVertex: boolean;
    /** Smallest _REVEAL.x in the node: its first item appears once the node's progress passes itemStart × stagger. */
    itemStart: number;
    window: { start: number; span: number };
    ids: StagedNodeExtras['sb']['ids'];
    replaces: string[];
    meshes: Array<THREE.Mesh | THREE.LineSegments>;
    degradationIds: string[];
    prov?: { key: string; look: NonNullable<MeshStagedLook['provenance']> };
}

interface RootInfo {
    objectId: string;
    root: THREE.Object3D;
    key: string;
    /** The structure this layer is one of (root extras), when it is one structure's. */
    buildingId?: string;
    /** Changes whenever the layer's nodes are rebuilt (a new model root, new ranks): what placement was computed for. */
    serial: number;
    nodes: NodeInfo[];
}

let rootSerial = 0;

interface Sidecar { status: 'loading' | 'ok' | 'failed'; ranks?: Record<string, number> }

type Legend = { state?: StagedBuildState; labels: string; legend: Map<ProvenanceLabel, LegendStyle>; classes: ReturnType<typeof shadingClasses> };

function nodeOf(mesh: THREE.Object3D, root: THREE.Object3D): THREE.Object3D {
    for (let o: THREE.Object3D | null = mesh; o && o !== root; o = o.parent) {
        if ((o.userData as { sb?: unknown })?.sb) return o;
    }
    // Without extras: a multi-primitive glTF node is a Group of meshes; a single-primitive node is the mesh itself.
    const p = mesh.parent;
    if (p && p !== root && p.children.length > 0 && p.children.every(c => (c as THREE.Mesh).isMesh || (c as THREE.Line).isLine)) return p;
    return mesh;
}

function readExtras(o: THREE.Object3D): StagedNodeExtras['sb'] | undefined {
    const sb = (o.userData as { sb?: StagedNodeExtras['sb'] })?.sb;
    return sb && sb.schema === 'scratchbox.staged-node/2' ? sb : undefined;
}

/**
 * The smallest `_REVEAL.x` of a mesh: its first item starts once the node's progress passes this × stagger. A layer of a
 * million vertices is read from the raw typed array in one pass (BufferAttribute.getX converts and bounds-checks every
 * call, which was the one multi-millisecond step when a district's trees attach); an interleaved attribute is read item by item.
 */
export function smallestRevealX(a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): number {
    if ((a as THREE.BufferAttribute).isBufferAttribute) {
        const arr = (a as THREE.BufferAttribute).array;
        const step = Math.max(1, a.itemSize);
        let m = Infinity;
        for (let i = 0; i < arr.length; i += step) if (arr[i] < m) m = arr[i];
        return Number.isFinite(m) ? (a.normalized ? THREE.MathUtils.denormalize(m, arr as Parameters<typeof THREE.MathUtils.denormalize>[1]) : m) : 1;
    }
    let m = Infinity;
    for (let i = 0; i < a.count; i++) m = Math.min(m, a.getX(i));
    return Number.isFinite(m) ? m : 1;
}

/** Nodes and meshes of one loaded layer, in their real build order (extras), download order (sidecar) or file order. */
export function buildRootInfo(layer: StagedLayer, root: THREE.Object3D, ranks: Record<string, number> | undefined): RootInfo {
    const byNode = new Map<THREE.Object3D, NodeInfo>();
    const order: THREE.Object3D[] = [];
    root.traverse(obj => {
        const m = obj as THREE.Mesh;
        if (!(m.isMesh || (obj as THREE.Line).isLine)) return;
        const node = nodeOf(obj, root);
        let info = byNode.get(node);
        if (!info) {
            const extras = readExtras(node);
            info = {
                node, extras,
                provenance: extras?.provenance ?? layer.provenance,
                fitRmsM: extras?.fitError?.rmsM,
                order: 0, count: 0,
                durationShare: extras?.reveal.durationShare,
                perVertex: false,
                itemStart: 1,
                window: { start: 0, span: 1 },
                ids: extras?.ids ?? {},
                replaces: extras?.replacesSurfaceIds ?? [],
                meshes: [],
                degradationIds: []
            };
            byNode.set(node, info);
            order.push(node);
        }
        info.meshes.push(obj as THREE.Mesh);
        const reveal = (m.geometry as THREE.BufferGeometry | undefined)?.getAttribute(REVEAL_ATTRIBUTE) as THREE.BufferAttribute | undefined;
        if (reveal) {
            info.perVertex = true;
            info.itemStart = Math.min(info.itemStart, smallestRevealX(reveal));
        } else {
            info.itemStart = 0;
        }
    });
    const nodes = order.map(n => byNode.get(n)!);
    const allExtras = nodes.length > 0 && nodes.every(n => n.extras);
    if (ranks) {
        const ranked = nodes.map((n, i) => ({ n, r: n.ids.leafId !== undefined && ranks[n.ids.leafId] !== undefined ? ranks[n.ids.leafId] : Number.MAX_SAFE_INTEGER, i }));
        ranked.sort((a, b) => a.r - b.r || a.i - b.i).forEach((x, k) => { x.n.order = k; x.n.count = nodes.length; });
    } else if (allExtras) {
        nodes.forEach(n => { n.order = n.extras!.buildOrder; n.count = Math.max(1, n.extras!.buildCount); });
    } else {
        nodes.forEach((n, i) => { n.order = i; n.count = nodes.length; });
    }
    const rootBuilding = (root.userData as { sb?: { buildingId?: string } })?.sb?.buildingId;
    // A refit animates only the primitives vision corrected. They fade in together across the whole reveal, in step with the
    // layer they replace fading out (its presence falls with the layer's progress), so no corrected part ever has a hole;
    // every other node is drawn whole from the first frame (lookFor).
    const only = layer.reveal.only ? new Set(layer.reveal.only.primitiveIds) : undefined;
    for (const n of nodes) {
        n.window = only && n.ids.primitiveId !== undefined && only.has(n.ids.primitiveId)
            ? { start: 0, span: 1 }
            : nodeRevealWindow({ order: n.order, count: n.count, stagger: layer.reveal.stagger, durationShare: n.durationShare, perVertex: n.perVertex });
    }
    return { objectId: layer.objectId, root, key: '', serial: ++rootSerial, ...(rootBuilding !== undefined ? { buildingId: rootBuilding } : {}), nodes };
}

function prefersReducedMotion(): boolean {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const PROV_BG = provenanceBackground();

/** A retired layer as a scene object again (it loads like the layer did when it was committed). */
function retiredObject(layer: StagedLayer): Media4DObject {
    return {
        id: layer.objectId,
        content: {
            type: '3d-model',
            durableUri: layer.url,
            mimeType: 'model/gltf-binary',
            metadata: { role: 'environment', source: 'staged-location', stage: layer.stage, readdedForComparison: true }
        },
        space: { spatial3d: { x: 0, y: 0, z: 0 } }
    } as Media4DObject;
}

interface LookContext {
    ghost: boolean;
    only?: Set<string>;
    replaced?: number;
    highlightOn?: string;
    provenanceOn: boolean;
    lg: Legend;
}

/** The look of one node of an attached layer this frame: a staged look, hidden (not started), concealed (superseded) or untouched (null). */
export function lookFor(f: LayerRevealFrame, n: NodeInfo, ctx: LookContext): MeshStagedLook | 'hide' | 'conceal' | null {
    // Attached but not ready yet (its download-order sidecar is still loading): hidden, never drawn unpatched.
    if (f.phase === 'loading') return 'hide';
    if ((f.hidden || f.phase === 'retired') && !ctx.ghost) return 'conceal';
    if (f.phase === 'held' || f.phase === 'queued') return 'hide';
    if (ctx.replaced !== undefined && ctx.replaced <= 0 && !ctx.ghost) return 'conceal';
    let reveal: MeshStagedLook['reveal'];
    const stagger = f.layer.reveal.stagger;
    let presence = ctx.ghost ? GHOST_PRESENCE : f.presence;
    if (ctx.replaced !== undefined) presence = Math.min(presence, Math.max(0, ctx.replaced));
    if (f.phase === 'revealing') {
        const inOnly = !ctx.only || (n.ids.primitiveId !== undefined && ctx.only.has(n.ids.primitiveId));
        const p = inOnly ? nodeProgress(f.progress, n.window) : 1;
        // Nothing of the node shows yet (no item has started): skip drawing it at all, so a large layer is drawn in
        // growing chunks instead of discarding every fragment of every node from the first frame.
        if (p <= 0 || (n.perVertex && p < 1 && p <= n.itemStart * stagger)) return 'hide';
        reveal = n.perVertex ? { progress: p, stagger, fade: 1, presence, overSource: f.overSource } : { progress: 1, stagger, fade: p, presence, overSource: f.overSource };
    } else if (presence < 1) {
        reveal = { progress: 1, stagger, fade: 1, presence };
    }
    const mark = (!!ctx.highlightOn && n.degradationIds.includes(ctx.highlightOn)) || (ctx.provenanceOn && n.degradationIds.length > 0);
    let provenance: MeshStagedLook['provenance'];
    if (ctx.provenanceOn) {
        const style = styleFor(n.provenance.label, ctx.lg.legend);
        const key = `${style.color}|${style.pattern}|${ctx.lg.classes.length}`;
        if (!n.prov || n.prov.key !== key) {
            const coverage = uncertaintyCoverage(n.provenance, n.fitRmsM);
            const pc = patternCode(style.pattern);
            const { colors, patterns } = classUniforms(ctx.lg.classes, ctx.lg.legend, style.color, coverage, pc);
            n.prov = { key, look: { nodeColor: style.color, nodePattern: pc, nodeCoverage: coverage, classCount: ctx.lg.classes.length, classColors: colors, classPatterns: patterns } };
        }
        provenance = n.prov.look;
    }
    if (!reveal && !provenance && !mark) return null;
    return { ...(reveal ? { reveal } : {}), ...(provenance ? { provenance } : {}), ...(mark ? { mark } : {}) };
}

/** What the overlay host reads; it re-renders itself when notified, not the viewport. */
interface OverlayStore {
    version: number;
    listeners: Set<() => void>;
    notify: () => void;
    frame?: RevealFrame;
    skipNote?: string;
}

const OverlayHost: React.FC<{ store: OverlayStore; render: (frame: RevealFrame | undefined, skipNote: string | undefined) => React.ReactNode }> = ({ store, render }) => {
    const [, setVersion] = React.useState(store.version);
    React.useEffect(() => {
        const l = () => setVersion(store.version);
        store.listeners.add(l);
        return () => { store.listeners.delete(l); };
    }, [store]);
    return React.createElement(React.Fragment, null, render(store.frame, store.skipNote));
};

export function useStagedBuild(opts: UseStagedBuildOptions): StagedBuildHandle {
    const { state, stackRef, objectRootsRef, loadStatus, mutateSceneData, onPromptAction } = opts;
    const runId = state?.runId;
    const pageLoadedAtMs = React.useRef(typeof performance !== 'undefined' ? performance.timeOrigin : 0).current;

    const [events, setEvents] = React.useState<readonly StageEvent[]>(() => (runId ? stageEventsFor(runId) : []));
    React.useEffect(() => {
        if (!runId) return;
        setEvents(stageEventsFor(runId));
        return subscribeStageEvents(e => { if (e.runId === runId) setEvents(stageEventsFor(runId)); });
    }, [runId]);

    const effective = React.useMemo(() => (state ? withStreamedEvents(state, events) : undefined), [state, events]);
    const progress = React.useMemo(() => streamedProgress(events), [events]);

    const [provenanceOn, setProvenanceOn] = React.useState(false);
    const [showReplaced, setShowReplaced] = React.useState(false);
    const [replayEpoch, setReplayEpoch] = React.useState(0);
    const [replaying, setReplaying] = React.useState(false);
    const [highlight, setHighlight] = React.useState<{ id: string; untilMs: number } | undefined>();
    const [reducedMotion, setReducedMotion] = React.useState(prefersReducedMotion);
    const [announcement, setAnnouncement] = React.useState('');

    React.useEffect(() => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
        const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
        const on = () => setReducedMotion(mq.matches);
        mq.addEventListener?.('change', on);
        return () => mq.removeEventListener?.('change', on);
    }, []);

    // Announce stage transitions (never progress ticks) in the polite live region.
    const lastStatuses = React.useRef(new Map<string, string>());
    React.useEffect(() => {
        if (!effective) return;
        const said: string[] = [];
        for (const s of effective.stages) {
            const prev = lastStatuses.current.get(s.stage);
            if (prev !== undefined && prev !== s.status && s.status !== 'pending') {
                said.push(`${s.title} ${s.status}${s.reason && s.status !== 'committed' && s.status !== 'running' ? `: ${s.reason}` : ''}`);
            }
            lastStatuses.current.set(s.stage, s.status);
        }
        if (said.length > 0) setAnnouncement(said.join('. '));
    }, [effective]);

    const settled = effective ? isRunSettled(effective, pageLoadedAtMs) : false;

    // Retired layers re-added for "Show replaced layers" or "Replay build", removed again when neither needs them.
    const readded = React.useRef(new Set<string>());
    const wantRetired = showReplaced || replaying;
    React.useEffect(() => {
        if (!effective) return;
        const retired = effective.layers.filter(l => l.retired);
        if (wantRetired) {
            const missing = retired.filter(l => !readded.current.has(l.objectId));
            if (missing.length === 0) return;
            missing.forEach(l => readded.current.add(l.objectId));
            mutateSceneData(prev => ({
                ...prev,
                objects: [...(prev.objects ?? []).filter(o => !missing.some(l => l.objectId === o.id)), ...missing.map(retiredObject)]
            }));
        } else if (readded.current.size > 0) {
            const ids = new Set(readded.current);
            readded.current.clear();
            mutateSceneData(prev => ({ ...prev, objects: (prev.objects ?? []).filter(o => !ids.has(o.id)) }));
        }
    }, [effective, wantRetired, mutateSceneData]);

    // Everything the per-frame guard reads, kept current without re-installing it.
    const live = React.useRef({ state: effective, settled, reducedMotion, provenanceOn, showReplaced, replayEpoch, highlight, loadStatus, replaying });
    live.current = { state: effective, settled, reducedMotion, provenanceOn, showReplaced, replayEpoch, highlight, loadStatus, replaying };

    const scheduleRef = React.useRef<RevealSchedule | undefined>(undefined);
    const frameRef = React.useRef<RevealFrame | undefined>(undefined);
    const readyAtRef = React.useRef(new Map<string, number>());
    const registryRef = React.useRef(new StagedMaterialRegistry());
    const rootsRef = React.useRef(new Map<string, RootInfo>());
    const sidecarsRef = React.useRef(new Map<string, Sidecar>());
    const statsRef = React.useRef({ lastFrameAt: 0, slowRun: 0, skipReason: undefined as string | undefined, frames: 0 });
    const backgroundRef = React.useRef<{ saved: THREE.Scene['background']; scene: THREE.Scene } | undefined>(undefined);
    const legendRef = React.useRef<Legend | undefined>(undefined);
    /** Where each degraded part is on the loaded nodes (degradationPlacement.ts), recomputed when the nodes or the records change. */
    const placementRef = React.useRef({ sig: '', placements: new Map<string, Placement<NodeInfo>>(), version: 0 });
    const storeRef = React.useRef<OverlayStore | null>(null);
    if (!storeRef.current) {
        const store: OverlayStore = { version: 0, listeners: new Set(), notify: () => { store.version++; store.listeners.forEach(l => l()); } };
        storeRef.current = store;
    }
    const store = storeRef.current;

    // A new run starts from a clean slate.
    React.useEffect(() => {
        scheduleRef.current = undefined;
        frameRef.current = undefined;
        readyAtRef.current.clear();
        rootsRef.current.clear();
        statsRef.current = { lastFrameAt: 0, slowRun: 0, skipReason: undefined, frames: 0 };
        registryRef.current.restoreAll();
        placementRef.current = { sig: '', placements: new Map(), version: placementRef.current.version + 1 };
        setProvenanceOn(false);
        setShowReplaced(false);
        setHighlight(undefined);
        lastStatuses.current.clear();
    }, [runId]);

    const legendFor = React.useCallback((st: StagedBuildState, extra: Iterable<ProvenanceLabel>): Legend => {
        const extraList = [...extra];
        const labels = [...new Set(extraList)].sort().join('|');
        const cached = legendRef.current;
        if (cached && cached.state === st && cached.labels === labels) return cached;
        const legend = resolveLegend(st, extraList);
        const next = { state: st, labels, legend, classes: shadingClasses(legend) };
        legendRef.current = next;
        return next;
    }, []);

    const sidecarFor = React.useCallback((url: string): Sidecar => {
        const known = sidecarsRef.current.get(url);
        if (known) return known;
        const entry: Sidecar = { status: 'loading' };
        sidecarsRef.current.set(url, entry);
        fetch(url).then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))).then((ranks: Record<string, number>) => {
            entry.status = 'ok';
            entry.ranks = ranks;
        }).catch(() => { entry.status = 'failed'; });
        return entry;
    }, []);

    const rootInfoFor = React.useCallback((layer: StagedLayer, root: THREE.Object3D): RootInfo => {
        const ranks = layer.reveal.orderUrl ? sidecarsRef.current.get(layer.reveal.orderUrl)?.ranks : undefined;
        const key = `${layer.reveal.stagger}|${ranks ? 'r' : ''}|${layer.provenance.label}`;
        const cached = rootsRef.current.get(layer.objectId);
        if (cached && cached.root === root && cached.key === key) return cached;
        if (cached && cached.root !== root) {
            const old = new Set<THREE.Object3D>(cached.nodes.flatMap(n => n.meshes));
            registryRef.current.prune(m => !old.has(m));
        }
        const info = buildRootInfo(layer, root, ranks);
        info.key = key;
        rootsRef.current.set(layer.objectId, info);
        return info;
    }, []);

    /** One frame: schedule, then the look of every staged mesh. Runs inside scene.onBeforeRender, before projection. */
    const onFrame = React.useCallback((renderer: THREE.WebGLRenderer, scene: THREE.Scene) => {
        const t0 = performance.now();
        const L = live.current;
        const st = L.state;
        if (!st) return;
        const stats = statsRef.current;
        stats.frames++;
        if (frameRef.current?.animating && stats.lastFrameAt > 0) {
            stats.slowRun = t0 - stats.lastFrameAt > SLOW_FRAME_MS ? stats.slowRun + 1 : 0;
            if (stats.slowRun >= SLOW_FRAME_RUN) stats.skipReason = 'frame time';
        }
        if (typeof document !== 'undefined' && document.hidden) stats.skipReason = 'hidden document';
        stats.lastFrameAt = t0;

        // Layers in the scene (retired ones re-added for replay or comparison reveal like any other).
        const layers = st.layers.map(l => (l.retired && readded.current.has(l.objectId) ? { ...l, retired: false } : l));
        const scheduleState: StagedBuildState = layers.every((l, i) => l === st.layers[i]) ? st : { ...st, layers };
        const loads: Record<string, LayerLoadState> = {};
        for (const layer of layers) {
            const root = objectRootsRef.current.get(layer.objectId);
            const attached = !!root && !!root.parent;
            const sidecar = layer.reveal.orderUrl ? sidecarFor(layer.reveal.orderUrl) : undefined;
            const ready = attached && (!sidecar || sidecar.status !== 'loading');
            if (ready && !readyAtRef.current.has(layer.objectId)) readyAtRef.current.set(layer.objectId, t0);
            if (!ready) readyAtRef.current.delete(layer.objectId);
            loads[layer.objectId] = { ready, readyAtMs: readyAtRef.current.get(layer.objectId), failed: L.loadStatus[layer.objectId]?.phase === 'error' };
        }
        const wasAnimating = !!frameRef.current?.animating;
        const { schedule, frame } = stepRevealSchedule(scheduleRef.current, {
            state: scheduleState, loads, nowMs: t0, pace: true, reducedMotion: L.reducedMotion, settled: L.settled && !L.replaying,
            skipReason: stats.skipReason, replayEpoch: L.replayEpoch,
            skipLayer: layer => (layer.counts.vertices > SKIP_REVEAL_ABOVE_VERTICES ? `over ${SKIP_REVEAL_ABOVE_VERTICES / 1e6} M vertices` : undefined)
        });
        scheduleRef.current = schedule;
        frameRef.current = frame;
        if (wasAnimating && !frame.animating) { stats.skipReason = undefined; stats.slowRun = 0; }

        // Provenance: the legend (with the labels the loaded nodes carry) and the background.
        const nodeLabels: ProvenanceLabel[] = [];
        if (L.provenanceOn) for (const info of rootsRef.current.values()) for (const n of info.nodes) nodeLabels.push(n.provenance.label);
        const lg = legendFor(st, nodeLabels);
        if (L.provenanceOn) {
            if (!backgroundRef.current || backgroundRef.current.scene !== scene) backgroundRef.current = { saved: scene.background, scene };
            const bg = scene.background as THREE.Color | null;
            if (!bg || !bg.isColor || !bg.equals(PROV_BG)) scene.background = PROV_BG.clone();
        } else if (backgroundRef.current) {
            if (backgroundRef.current.scene === scene) scene.background = backgroundRef.current.saved;
            backgroundRef.current = undefined;
        }

        // Node-level replacements: a recut surface fades the surface it replaces out as it reveals.
        const replacedPresence = new Map<string, number>();
        const infos: Array<[LayerRevealFrame, RootInfo]> = [];
        for (const f of frame.layers) {
            const root = objectRootsRef.current.get(f.objectId);
            if (!root || !root.parent) continue;
            const info = rootInfoFor(f.layer, root);
            infos.push([f, info]);
            if (f.phase !== 'revealing' && f.phase !== 'revealed') continue;
            for (const n of info.nodes) {
                if (n.replaces.length === 0) continue;
                const q = f.phase === 'revealed' ? 1 : nodeProgress(f.progress, n.window);
                for (const sid of n.replaces) replacedPresence.set(sid, Math.min(replacedPresence.get(sid) ?? 1, 1 - q));
            }
        }
        // Where each degraded part is: placed on the loaded nodes by the most specific thing they share, again when the
        // loaded nodes, what is showing or the records change.
        const placeKey = `${st.degradations.map(d => d.id).join(',')}#${infos.map(([f, i]) => `${f.objectId}:${i.serial}:${f.hidden || f.phase === 'retired' ? 0 : 1}`).join(',')}`;
        if (placementRef.current.sig !== placeKey) {
            const roots: Array<PlacementRoot<NodeInfo>> = infos.map(([f, i]) => ({ layer: f.layer, buildingId: i.buildingId, showing: !f.hidden && f.phase !== 'retired', nodes: i.nodes }));
            for (const [, i] of infos) for (const n of i.nodes) n.degradationIds = [];
            const placements = placeDegradations(roots, st.degradations);
            for (const [id, pl] of placements) for (const n of pl.nodes) n.degradationIds.push(id);
            placementRef.current = { sig: placeKey, placements, version: placementRef.current.version + 1 };
        }
        const registry = registryRef.current;
        registry.beginFrame();
        const restores = { left: MAX_RESTORES_PER_FRAME };
        const pxScale = renderer.getPixelRatio();
        registry.updateSharedPixelScale(pxScale);
        let budget = MAX_NEW_MATERIALS_PER_FRAME;
        let drawn = 0;
        const highlightOn = L.highlight && L.highlight.untilMs > Date.now() ? L.highlight.id : undefined;
        for (const [f, info] of infos) {
            const ghost = L.showReplaced && (f.hidden || f.phase === 'retired');
            const only = f.layer.reveal.only ? new Set(f.layer.reveal.only.primitiveIds) : undefined;
            for (const n of info.nodes) {
                const replaced = n.ids.surfaceId !== undefined && n.replaces.length === 0 ? replacedPresence.get(n.ids.surfaceId) : undefined;
                const look = lookFor(f, n, { ghost, only, replaced, highlightOn, provenanceOn: L.provenanceOn, lg });
                for (const mesh of n.meshes) {
                    if (look === 'conceal') registry.conceal(mesh);
                    else if (look === 'hide') registry.hide(mesh);
                    else {
                        if (registry.apply(mesh, look, { allowCreate: budget > 0, pxScale, classCount: lg.classes.length, restores })) budget--;
                        if (mesh.visible) drawn++;
                    }
                }
            }
        }
        // Forget meshes of models the loader released (every 30 frames; the check walks the registry).
        if (stats.frames % 30 === 0) {
            const liveMeshes = new Set<THREE.Object3D>();
            for (const info of rootsRef.current.values()) {
                if (objectRootsRef.current.get(info.objectId) !== info.root) continue;
                for (const n of info.nodes) for (const m of n.meshes) liveMeshes.add(m);
            }
            registry.prune(m => liveMeshes.has(m));
        }
        stagedRevealStats.layers = frame.layers.map(f => ({ objectId: f.objectId, phase: f.phase, progress: f.progress, presence: f.presence, hidden: f.hidden }));
        recordStat(stagedRevealStats.guardMs, performance.now() - t0);
        recordStat(stagedRevealStats.newMaterials, MAX_NEW_MATERIALS_PER_FRAME - budget);
        recordStat(stagedRevealStats.restored, MAX_RESTORES_PER_FRAME - restores.left);
        recordStat(stagedRevealStats.drawnStagedMeshes, drawn);
    }, [objectRootsRef, legendFor, sidecarFor, rootInfoFor]);

    // The guard is on while anything reveals or waits to, while provenance, a highlight or ghosts are on; it follows
    // the renderer stack if that is re-created (StrictMode / HMR). This rAF loop keeps the guard and the overlay
    // current, and stops once the steady state is reached (no guard needed, run over).
    const guardRef = React.useRef<{ scene: THREE.Scene; uninstall: () => void } | undefined>(undefined);
    React.useEffect(() => {
        if (!effective) return;
        // The last frame was computed for the previous state: until the guard computes one for this state, assume work.
        if (frameRef.current && frameRef.current.layers.length !== effective.layers.length) frameRef.current = undefined;
        let raf = 0;
        let lastOverlay = 0;
        let lastSig = '';
        let lastHighlightOn = false;
        const tick = () => {
            const scene = stackRef.current?.scene;
            const f = frameRef.current;
            const L = live.current;
            const highlightOn = !!L.highlight && L.highlight.untilMs > Date.now();
            const ghosts = L.showReplaced && !!f?.layers.some(x => x.hidden || x.phase === 'retired');
            const stale = !!f && !!L.state && (f.layers.length !== L.state.layers.length || f.layers.some(x => !L.state!.layers.some(l => l.objectId === x.objectId)));
            // "Replay build" is consumed by the next scheduled frame, so it needs the guard even when everything is revealed.
            const replayPending = !!scheduleRef.current && scheduleRef.current.epoch !== L.replayEpoch;
            const needsGuard = !f || stale || replayPending || f.animating || f.pending || L.provenanceOn || highlightOn || ghosts || registryRef.current.deferredRestores > 0;
            if (scene && needsGuard && guardRef.current?.scene !== scene) {
                guardRef.current?.uninstall();
                guardRef.current = { scene, uninstall: installRenderGuard(scene, renderer => onFrame(renderer as THREE.WebGLRenderer, scene)) };
            } else if (!needsGuard && guardRef.current) {
                guardRef.current.uninstall();
                guardRef.current = undefined;
                // Original materials and background back; superseded layers stay hidden (their roots stay loaded).
                registryRef.current.restoreMaterials();
                const bg = backgroundRef.current;
                if (bg) { bg.scene.background = bg.saved; backgroundRef.current = undefined; }
                if (L.replaying) setReplaying(false);
            }
            const now = performance.now();
            const sig = (f ? f.layers.map(x => `${x.objectId}:${x.phase}:${x.hidden ? 1 : 0}`).join('|') : '') + `#${placementRef.current.version}`;
            const running = L.state?.runState === 'running' && !isInterrupted(L.state, pageLoadedAtMs);
            if (!highlightOn && lastHighlightOn) lastSig = '';
            lastHighlightOn = highlightOn;
            if (sig !== lastSig || ((running || f?.animating) && now - lastOverlay > OVERLAY_REFRESH_MS)) {
                lastSig = sig;
                lastOverlay = now;
                store.frame = f;
                store.skipNote = statsRef.current.skipReason;
                store.notify();
            }
            if (needsGuard || running || !f) raf = requestAnimationFrame(tick);
        };
        // Synchronously: a layer the loader attaches before the next animation frame must already meet the guard.
        tick();
        return () => cancelAnimationFrame(raf);
    }, [effective, provenanceOn, showReplaced, replayEpoch, highlight, onFrame, stackRef, store, pageLoadedAtMs]);

    // Off for good on unmount: the guard, the staged materials, the background.
    React.useEffect(() => () => {
        guardRef.current?.uninstall();
        guardRef.current = undefined;
        registryRef.current.restoreAll();
        const bg = backgroundRef.current;
        if (bg) bg.scene.background = bg.saved;
    }, []);

    const render = React.useCallback((frame: RevealFrame | undefined, skipNote: string | undefined, bottomInsetPx: number) => {
        const st = live.current.state;
        if (!st) return null;
        const labels = provenanceOn ? [...rootsRef.current.values()].flatMap(i => i.nodes.map(n => n.provenance.label)) : [];
        const lg = legendFor(st, labels);
        // Where each record is, once every layer that is going to show has loaded (before that, a part may only be unplaced yet).
        const placements = new Map<string, DegradationPlacementNote>();
        if (frame && !frame.pending && frame.layers.length > 0) {
            for (const [id, pl] of placementRef.current.placements) placements.set(id, { scope: pl.scope, layerIds: pl.layerIds });
        }
        const hasOutlines = [...rootsRef.current.values()].some(i => i.nodes.some(n => n.meshes.some(m => (m as THREE.LineSegments).isLine && !!(m.geometry as THREE.BufferGeometry).getAttribute('color'))));
        return React.createElement(StagedBuildOverlay, {
            state: st,
            interrupted: isInterrupted(st, pageLoadedAtMs),
            layers: frame?.layers ?? [],
            progress: progress as Map<string, StageProgress>,
            nowMs: performance.now(),
            wallNowMs: Date.now(),
            announcement,
            provenanceOn,
            onToggleProvenance: () => setProvenanceOn(v => !v),
            legend: legendRows(st, lg.legend, { hasOutlines }),
            showReplaced,
            onToggleShowReplaced: () => setShowReplaced(v => !v),
            onReplay: () => { setReplaying(true); setReplayEpoch(e => e + 1); },
            onRetry: (d: DegradationRecord) => {
                if (!d.retry) return;
                const title = st.stages.find(s => s.stage === d.stage)?.title || d.stage;
                onPromptAction?.(`Retry the ${title} stage: call ${d.retry.tool} with ${JSON.stringify(d.retry.args)}`);
            },
            onHighlight: (d: DegradationRecord) => setHighlight(h => (h?.id === d.id && h.untilMs > Date.now() ? undefined : { id: d.id, untilMs: Date.now() + HIGHLIGHT_MS })),
            highlightedId: highlight && highlight.untilMs > Date.now() ? highlight.id : undefined,
            placements,
            bottomInsetPx,
            skipNote
        });
    }, [legendFor, provenanceOn, showReplaced, highlight, announcement, progress, onPromptAction, pageLoadedAtMs]);

    const overlay = React.useCallback((o: { bottomInsetPx: number }) => {
        if (!live.current.state) return null;
        return React.createElement(OverlayHost, { store, render: (frame, skipNote) => render(frame, skipNote, o.bottomInsetPx) });
    }, [store, render]);

    return { active: !!effective, overlay };
}
