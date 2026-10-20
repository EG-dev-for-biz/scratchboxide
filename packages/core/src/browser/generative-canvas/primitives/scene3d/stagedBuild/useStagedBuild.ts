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
 *
 * Clay or textured (texturedTwins.ts): a layer with a textured twin keeps its clay model; in textured mode the twin is
 * added as a second scene object and swapped in by the same reveal (a crossfade, material only), and back again. The
 * scene's stagedBuild.materialMode is the model's request; the overlay's toggle overrides it until the next request.
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
import { StagedBuildOverlay, type DegradationPlacementNote, type MaterialsSummary } from './StagedBuildOverlay';
import { placeDegradations, type Placement, type PlacementRoot } from './degradationPlacement';
import { nodeProgress, nodeRevealWindow, stepRevealSchedule, type LayerLoadState, type LayerRevealFrame, type RevealFrame, type RevealSchedule } from './revealScheduler';
import { REVEAL_ATTRIBUTE, StagedMaterialRegistry, installRenderGuard, type MeshStagedLook, type PartLook } from './revealMaterial';
import { mergedPartsOf } from './mergeStagedParts';
import { FACADE_MATERIAL_SOURCE } from './facadeMaterialLook';
import { TEXTURE_RUNG_COLORS, classUniforms, legendRows, patternCode, provenanceBackground, resolveLegend, shadingClasses, styleFor, textureRungLegendRows, uncertaintyCoverage, type LegendStyle } from './provenanceShading';
import { EVICT_AFTER_MS, evictionCandidates, evictionEnabled, sameSet, stepEviction } from './layerEviction';
import { isInterrupted, isRunSettled, stageEventsFor, streamedProgress, subscribeStageEvents, withStreamedEvents, type StageProgress } from './stagedBuildState';
import {
    INITIAL_SWITCH, deriveMaterialLayers, isMaterialSwapLayer, materialModeOf, modelIdOf, nextSwitch, parseSwapId, twinObjectFor, twinObjectId, twinSourceOf,
    type DerivedMaterialState, type EngagedTwin, type MaterialMode, type MaterialSwitch
} from './texturedTwins';

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
    /** Layers whose object carries an explicit material: they draw it, never the provenance shading or degradation marks. */
    overriddenIds?: ReadonlySet<string>;
    /** Scene3DPrimitive's per-object load status (only `phase` is read). */
    loadStatus: Readonly<Record<string, { phase: string } | undefined>>;
    mutateSceneData: (mutator: (prev: Scene3DData) => Scene3DData, opInfo?: { operator: string; params?: unknown }, options?: { history?: false }) => void;
    onPromptAction?: (prompt: string) => void;
    /** The scene's objects: textured twins are added to it (and removed) as the material mode needs them. */
    sceneObjects?: readonly Media4DObject[];
    /** The scene's view request beside stagedBuild (staged_location_material_mode's provenance flag). */
    view?: { provenance?: boolean };
    /**
     * Superseded layers whose models the viewport should release (layerEviction.ts), each time the set changes. The loader
     * leaves these unloaded until they leave the set (an opt-in view needs them again), then loads them from their URL.
     */
    onEvictedChange?: (objectIds: ReadonlySet<string>) => void;
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
    /** A part of a merged mesh (mergeStagedParts.ts): its look goes into the mesh's per-part arrays, `meshes` is empty. */
    part?: { mesh: THREE.Mesh; index: number };
    degradationIds: string[];
    prov?: { key: string; look: NonNullable<MeshStagedLook['provenance']> };
}

/** Every mesh a layer's nodes draw with: their own, and the merged meshes their parts live in. */
export function meshesOfNodes(nodes: readonly NodeInfo[]): THREE.Object3D[] {
    const out = new Set<THREE.Object3D>();
    for (const n of nodes) {
        for (const m of n.meshes) out.add(m);
        if (n.part) out.add(n.part.mesh);
    }
    return [...out];
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
        // a tree (all three levels, wood and instanced leaf clusters) is one node: one reveal, one label at every level
        if ((o.userData as { sbTree?: unknown })?.sbTree) return o;
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
        // a merged mesh: one node per part, from its range table (the parts' own extras, in their order)
        const table = m.isMesh ? mergedPartsOf(m) : undefined;
        if (table) {
            for (const p of table.parts) {
                const key = new THREE.Object3D();
                key.name = p.name;
                key.userData = { sb: p.sb };
                byNode.set(key, {
                    node: key, extras: p.sb, provenance: p.sb.provenance ?? layer.provenance, fitRmsM: p.sb.fitError?.rmsM, order: 0, count: 0,
                    durationShare: p.sb.reveal?.durationShare, perVertex: false, itemStart: 0, window: { start: 0, span: 1 },
                    ids: p.sb.ids ?? {}, replaces: p.sb.replacesSurfaceIds ?? [], meshes: [], part: { mesh: m, index: p.index }, degradationIds: []
                });
                order.push(key);
            }
            return;
        }
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
    /** The layer's object has an explicit material: no provenance shading or mark over it. */
    overridden?: boolean;
    /** A material swap layer (clay <-> textured twin): the geometry is final, nothing is displaced in. */
    swap?: boolean;
    /** Provenance on a textured twin: per-texel rungs instead of the node's label. */
    rungs?: MeshStagedLook['rungs'];
}

/** The rung colours as the shader takes them. */
const RUNG_LOOK: NonNullable<MeshStagedLook['rungs']> = { colors: TEXTURE_RUNG_COLORS.map(c => new THREE.Color(c)) };

/**
 * Whether "Show replaced layers" draws this hidden layer as a ghost. A layer a clay <-> textured swap hid (the clay copy
 * under its twin, or the model a later swap left) is the same geometry as the one drawn: ghosting it puts a 25% dither
 * of the other material over the whole of it (the stipple seen on the live arch). Only layers another layer replaced are
 * ghosts; an engaged layer is never replaced by one (twinEligible), so it and its swap layers are skipped.
 */
export function ghostOf(f: Pick<LayerRevealFrame, 'objectId' | 'hidden' | 'phase'>, showReplaced: boolean, engaged: ReadonlyMap<string, unknown>): boolean {
    if (!showReplaced || !(f.hidden || f.phase === 'retired')) return false;
    return !isMaterialSwapLayer(f) && !engaged.has(f.objectId);
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
        if (ctx.swap) reveal.noDisp = true;
    } else if (presence < 1) {
        reveal = { progress: 1, stagger, fade: 1, presence };
    }
    const rungs = ctx.provenanceOn && !ctx.overridden ? ctx.rungs : undefined;
    const shaded = ctx.provenanceOn && !ctx.overridden && !rungs;
    const mark = !ctx.overridden && ((!!ctx.highlightOn && n.degradationIds.includes(ctx.highlightOn)) || (ctx.provenanceOn && n.degradationIds.length > 0));
    let provenance: MeshStagedLook['provenance'];
    if (shaded) {
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
    if (!reveal && !provenance && !mark && !rungs) return null;
    return { ...(reveal ? { reveal } : {}), ...(provenance ? { provenance } : {}), ...(rungs ? { rungs } : {}), ...(mark ? { mark } : {}) };
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
    const { state, stackRef, objectRootsRef, loadStatus, mutateSceneData, onPromptAction, overriddenIds, sceneObjects, view, onEvictedChange } = opts;
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

    // Clay or textured. The scene's request (stagedBuild.materialMode, set by staged_location_material_mode) holds until
    // the overlay's toggle overrides it; a new request from the scene drops the override. A state streamed later without
    // the field keeps the last request.
    const sceneMode = materialModeOf(state?.materialMode);
    const lastSceneMode = React.useRef<{ runId?: string; mode?: MaterialMode }>({});
    if (lastSceneMode.current.runId !== runId) lastSceneMode.current = { runId };
    if (sceneMode) lastSceneMode.current.mode = sceneMode;
    const [userMode, setUserMode] = React.useState<MaterialMode | undefined>(undefined);
    React.useEffect(() => { if (sceneMode) setUserMode(undefined); }, [sceneMode, runId]);
    const wantedMode: MaterialMode = userMode ?? lastSceneMode.current.mode ?? 'clay';
    const twinRef = React.useRef<{ runId?: string; sw: MaterialSwitch; engaged: Map<string, EngagedTwin>; seen: boolean; mountEpoch: number }>({ sw: INITIAL_SWITCH, engaged: new Map(), seen: false, mountEpoch: 0 });
    if (twinRef.current.runId !== runId) twinRef.current = { runId, sw: INITIAL_SWITCH, engaged: new Map(), seen: false, mountEpoch: 0 };
    twinRef.current.sw = nextSwitch(twinRef.current.sw, wantedMode);
    const sw = twinRef.current.sw;

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

    const scheduleRef = React.useRef<RevealSchedule | undefined>(undefined);

    // The scheduler's view: the build's layers plus the swap layers of the current clay/textured switch.
    const derived: DerivedMaterialState | undefined = React.useMemo(() => {
        if (!effective) return undefined;
        const t = twinRef.current;
        if (!t.seen) t.mountEpoch = sw.epoch;
        const out = deriveMaterialLayers(effective, sw, t.engaged, { started: id => !!scheduleRef.current?.layers[id], live: t.seen });
        t.seen = true;
        return out;
    }, [effective, sw]);
    const stagedState = derived?.state;
    /** A swap the viewer asked for now plays even over a finished run; one saved with the scene shows at once. */
    const exemptFromSettled = React.useCallback((layer: StagedLayer): boolean => {
        const p = parseSwapId(layer.objectId);
        if (!p) return false;
        const t = twinRef.current;
        return p.epoch > t.mountEpoch || !!t.engaged.get(p.layerId)?.live;
    }, []);

    // Everything the per-frame guard reads, kept current without re-installing it.
    const live = React.useRef({ overriddenIds, state: stagedState, owner: derived?.owner, settled, reducedMotion, provenanceOn, showReplaced, replayEpoch, highlight, loadStatus, replaying });
    live.current = { overriddenIds, state: stagedState, owner: derived?.owner, settled, reducedMotion, provenanceOn, showReplaced, replayEpoch, highlight, loadStatus, replaying };

    // The twins the switch needs are scene objects (loaded by the viewport like any layer); twins no longer needed go.
    React.useEffect(() => {
        if (!sceneObjects || !derived) return;
        const byId = new Map(sceneObjects.map(o => [o.id, o]));
        const wanted = derived.twins;
        const missing = wanted.filter(l => (byId.get(twinObjectId(l.objectId))?.content as { durableUri?: string } | undefined)?.durableUri !== l.textured!.url);
        const stale = sceneObjects.filter(o => { const src = twinSourceOf(o); return !!src && !wanted.some(l => l.objectId === src); });
        if (missing.length === 0 && stale.length === 0) return;
        const drop = new Set([...stale.map(o => o.id), ...missing.map(l => twinObjectId(l.objectId))]);
        mutateSceneData(prev => {
            const objs = prev.objects ?? [];
            const add = missing.map(l => twinObjectFor(l, objs.find(o => o.id === l.objectId)));
            return { ...prev, objects: [...objs.filter(o => !drop.has(o.id)), ...add] };
        }, { operator: 'staged_material_mode_twins' }, { history: false });
    }, [derived, sceneObjects, mutateSceneData]);
    const frameRef = React.useRef<RevealFrame | undefined>(undefined);
    const readyAtRef = React.useRef(new Map<string, number>());
    const registryRef = React.useRef(new StagedMaterialRegistry());
    const rootsRef = React.useRef(new Map<string, RootInfo>());
    const sidecarsRef = React.useRef(new Map<string, Sidecar>());
    /** `ghosts`: layers the last guard frame drew as ghosts; the guard stays up until a frame has concealed them again. */
    const statsRef = React.useRef({ lastFrameAt: 0, slowRun: 0, skipReason: undefined as string | undefined, frames: 0, ghosts: 0 });
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

    /** Superseded layers released by the loader (reported ready to the scheduler: they stay revealed and hidden). */
    const evictedRef = React.useRef<ReadonlySet<string>>(new Set());
    const evictSinceRef = React.useRef(new Map<string, number>());
    const onEvictedRef = React.useRef(onEvictedChange);
    onEvictedRef.current = onEvictedChange;
    /** Sets the evicted layers: their meshes leave the registry and the node table, and the viewport is told. */
    const setEvicted = React.useCallback((next: ReadonlySet<string>) => {
        if (sameSet(next, evictedRef.current)) return;
        const gone = [...next].filter(id => !evictedRef.current.has(id));
        evictedRef.current = next;
        if (gone.length > 0) {
            const meshes = new Set<THREE.Object3D>();
            for (const id of gone) {
                const info = rootsRef.current.get(id);
                if (info) for (const m of meshesOfNodes(info.nodes)) meshes.add(m);
                rootsRef.current.delete(id);
            }
            if (meshes.size > 0) registryRef.current.prune(m => !meshes.has(m));
        }
        onEvictedRef.current?.(next);
    }, []);

    // A new run starts from a clean slate.
    React.useEffect(() => {
        scheduleRef.current = undefined;
        frameRef.current = undefined;
        readyAtRef.current.clear();
        rootsRef.current.clear();
        statsRef.current = { lastFrameAt: 0, slowRun: 0, skipReason: undefined, frames: 0, ghosts: 0 };
        registryRef.current.restoreAll();
        placementRef.current = { sig: '', placements: new Map(), version: placementRef.current.version + 1 };
        setProvenanceOn(false);
        setShowReplaced(false);
        setHighlight(undefined);
        lastStatuses.current.clear();
        evictSinceRef.current.clear();
        setEvicted(new Set());
    }, [runId, setEvicted]);

    // The scene's provenance request (staged_location_material_mode's provenance flag), applied when it changes.
    const requestedProvenance = view?.provenance;
    React.useEffect(() => {
        if (typeof requestedProvenance === 'boolean') setProvenanceOn(requestedProvenance);
    }, [requestedProvenance, runId]);

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
            const old = new Set<THREE.Object3D>(meshesOfNodes(cached.nodes));
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
            const model = modelIdOf(layer.objectId);
            const root = objectRootsRef.current.get(model);
            const attached = !!root && !!root.parent;
            const sidecar = layer.reveal.orderUrl ? sidecarFor(layer.reveal.orderUrl) : undefined;
            // an evicted layer is released on purpose: it stays ready (revealed, hidden under what replaced it)
            const ready = evictedRef.current.has(model) || (attached && (!sidecar || sidecar.status !== 'loading'));
            if (ready && !readyAtRef.current.has(layer.objectId)) readyAtRef.current.set(layer.objectId, t0);
            if (!ready) readyAtRef.current.delete(layer.objectId);
            loads[layer.objectId] = { ready, readyAtMs: readyAtRef.current.get(layer.objectId), failed: L.loadStatus[model]?.phase === 'error' };
        }
        const wasAnimating = !!frameRef.current?.animating;
        const { schedule, frame } = stepRevealSchedule(scheduleRef.current, {
            state: scheduleState, loads, nowMs: t0, pace: true, reducedMotion: L.reducedMotion, settled: L.settled && !L.replaying,
            skipReason: stats.skipReason, replayEpoch: L.replayEpoch, exemptFromSettled,
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
            // a model two layers stand for (a layer and its swap back to clay) is driven by the newest of them
            if ((L.owner?.get(f.objectId) ?? f.objectId) !== f.objectId) continue;
            const root = objectRootsRef.current.get(modelIdOf(f.objectId));
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
        stats.ghosts = 0;
        const highlightOn = L.highlight && L.highlight.untilMs > Date.now() ? L.highlight.id : undefined;
        for (const [f, info] of infos) {
            const ghost = ghostOf(f, L.showReplaced, twinRef.current.engaged);
            if (ghost) stats.ghosts++;
            const only = f.layer.reveal.only ? new Set(f.layer.reveal.only.primitiveIds) : undefined;
            const swap = parseSwapId(f.objectId);
            const overridden = !!L.overriddenIds?.has(modelIdOf(f.objectId));
            const partLooks = new Map<THREE.Mesh, PartLook[]>();
            for (const n of info.nodes) {
                const replaced = n.ids.surfaceId !== undefined && n.replaces.length === 0 ? replacedPresence.get(n.ids.surfaceId) : undefined;
                const look = lookFor(f, n, { ghost, only, replaced, highlightOn, provenanceOn: L.provenanceOn, lg, overridden, swap: !!swap, ...(swap?.kind === 'tex' ? { rungs: RUNG_LOOK } : {}) });
                if (n.part) {
                    const list = partLooks.get(n.part.mesh) ?? partLooks.set(n.part.mesh, []).get(n.part.mesh)!;
                    list[n.part.index] = look;
                    continue;
                }
                for (const mesh of n.meshes) {
                    if (look === 'conceal') registry.conceal(mesh);
                    else if (look === 'hide') registry.hide(mesh);
                    else {
                        if (registry.apply(mesh, look, { allowCreate: budget > 0, pxScale, classCount: lg.classes.length, restores })) budget--;
                        if (mesh.visible) drawn++;
                    }
                }
            }
            for (const [mesh, looks] of partLooks) {
                const table = mergedPartsOf(mesh);
                const all: PartLook[] = Array.from({ length: table?.parts.length ?? looks.length }, (_, i) => looks[i] ?? null);
                if (registry.applyParts(mesh, all, { allowCreate: budget > 0, pxScale, classCount: lg.classes.length, restores })) budget--;
                if (mesh.visible) drawn++;
            }
        }
        // Forget meshes of models the loader released (every 30 frames; the check walks the registry).
        if (stats.frames % 30 === 0) {
            const liveMeshes = new Set<THREE.Object3D>();
            for (const [id, info] of [...rootsRef.current]) {
                // layers gone from the schedule (an earlier swap) no longer hold their meshes
                if (!st.layers.some(l => l.objectId === id)) { rootsRef.current.delete(id); continue; }
                if (objectRootsRef.current.get(modelIdOf(info.objectId)) !== info.root) continue;
                for (const m of meshesOfNodes(info.nodes)) liveMeshes.add(m);
            }
            registry.prune(m => liveMeshes.has(m));
        }
        stagedRevealStats.layers = frame.layers.map(f => ({ objectId: f.objectId, phase: f.phase, progress: f.progress, presence: f.presence, hidden: f.hidden }));
        recordStat(stagedRevealStats.guardMs, performance.now() - t0);
        recordStat(stagedRevealStats.newMaterials, MAX_NEW_MATERIALS_PER_FRAME - budget);
        recordStat(stagedRevealStats.restored, MAX_RESTORES_PER_FRAME - restores.left);
        recordStat(stagedRevealStats.drawnStagedMeshes, drawn);
    }, [objectRootsRef, legendFor, sidecarFor, rootInfoFor, exemptFromSettled]);

    // The guard is on while anything reveals or waits to, while provenance, a highlight or ghosts are on; it follows
    // the renderer stack if that is re-created (StrictMode / HMR). This rAF loop keeps the guard and the overlay
    // current, and stops once the steady state is reached (no guard needed, run over).
    const guardRef = React.useRef<{ scene: THREE.Scene; uninstall: () => void } | undefined>(undefined);
    React.useEffect(() => {
        if (!stagedState) return;
        // The last frame was computed for the previous state: until the guard computes one for this state, assume work.
        if (frameRef.current && (frameRef.current.layers.length !== stagedState.layers.length || frameRef.current.layers.some(x => !stagedState.layers.some(l => l.objectId === x.objectId)))) frameRef.current = undefined;
        let raf = 0;
        let evictTimer: ReturnType<typeof setTimeout> | undefined;
        let lastOverlay = 0;
        let lastSig = '';
        let lastHighlightOn = false;
        const tick = () => {
            const scene = stackRef.current?.scene;
            const f = frameRef.current;
            const L = live.current;
            const highlightOn = !!L.highlight && L.highlight.untilMs > Date.now();
            const ghosts = !!f?.layers.some(x => ghostOf(x, L.showReplaced, twinRef.current.engaged));
            const stale = !!f && !!L.state && (f.layers.length !== L.state.layers.length || f.layers.some(x => !L.state!.layers.some(l => l.objectId === x.objectId)));
            // "Replay build" is consumed by the next scheduled frame, so it needs the guard even when everything is revealed.
            const replayPending = !!scheduleRef.current && scheduleRef.current.epoch !== L.replayEpoch;
            // A ghost drawn last frame must be concealed by a frame of the guard before it goes: restoring materials alone
            // would leave the replaced layer unhidden, drawn whole over (and z-fighting with) the layer that replaced it.
            const needsGuard = !f || stale || replayPending || f.animating || f.pending || L.provenanceOn || highlightOn || ghosts || statsRef.current.ghosts > 0 || registryRef.current.deferredRestores > 0;
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
            // Superseded layers: released once hidden for a while, loaded again as soon as an opt-in view needs them.
            if (f && L.state) {
                const candidates = evictionEnabled() ? evictionCandidates({ state: L.state, frame: f, engaged: twinRef.current.engaged, showReplaced: L.showReplaced, replaying: L.replaying }) : new Set<string>();
                const { evict, nextCheckMs } = stepEviction(candidates, evictSinceRef.current, now, EVICT_AFTER_MS);
                // a layer leaves the evicted set as soon as it stops being a candidate; one joins only after its delay
                const next = new Set([...evictedRef.current].filter(id => candidates.has(id)));
                for (const id of evict) next.add(id);
                setEvicted(next);
                if (nextCheckMs !== undefined && evictTimer === undefined) {
                    evictTimer = setTimeout(() => { evictTimer = undefined; if (!raf) tick(); }, Math.max(16, nextCheckMs - now));
                }
            }
            if (needsGuard || running || !f) raf = requestAnimationFrame(loop);
        };
        const loop = () => { raf = 0; tick(); };
        // Synchronously: a layer the loader attaches before the next animation frame must already meet the guard.
        tick();
        return () => { cancelAnimationFrame(raf); if (evictTimer !== undefined) clearTimeout(evictTimer); };
    }, [stagedState, provenanceOn, showReplaced, replaying, replayEpoch, highlight, onFrame, stackRef, store, pageLoadedAtMs, setEvicted]);

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
        if (!st || !effective) return null;
        const labels = provenanceOn ? [...rootsRef.current.values()].flatMap(i => i.nodes.map(n => n.provenance.label)) : [];
        const lg = legendFor(st, labels);
        // Where each record is, once every layer that is going to show has loaded (before that, a part may only be unplaced yet).
        const placements = new Map<string, DegradationPlacementNote>();
        if (frame && !frame.pending && frame.layers.length > 0) {
            for (const [id, pl] of placementRef.current.placements) placements.set(id, { scope: pl.scope, layerIds: pl.layerIds });
        }
        const hasOutlines = [...rootsRef.current.values()].some(i => i.nodes.some(n => n.meshes.some(m => (m as THREE.LineSegments).isLine && !!(m.geometry as THREE.BufferGeometry).getAttribute('color'))));
        const materials = materialsSummary(effective, frame, sw, derived);
        return React.createElement(StagedBuildOverlay, {
            state: effective,
            interrupted: isInterrupted(effective, pageLoadedAtMs),
            // swap reveals are reported by the materials line, not as build notes
            layers: (frame?.layers ?? []).filter(l => !isMaterialSwapLayer(l)),
            materials,
            onToggleMaterials: () => setUserMode(materials.mode === 'textured' ? 'clay' : 'textured'),
            rungLegend: provenanceOn && materials.mode === 'textured' && materials.shown > 0 ? textureRungLegendRows(materials.rungShares, materials.materialShare) : undefined,
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
    }, [legendFor, provenanceOn, showReplaced, highlight, announcement, progress, onPromptAction, pageLoadedAtMs, effective, sw, derived]);

    const overlay = React.useCallback((o: { bottomInsetPx: number }) => {
        if (!live.current.state) return null;
        return React.createElement(OverlayHost, { store, render: (frame, skipNote) => render(frame, skipNote, o.bottomInsetPx) });
    }, [store, render]);

    return { active: !!effective, overlay };
}

/** What the overlay says about clay and textures: the mode, how many layers show their twin, the pass's progress. */
export function materialsSummary(state: StagedBuildState, frame: RevealFrame | undefined, sw: MaterialSwitch, derived: DerivedMaterialState | undefined): MaterialsSummary {
    const available = state.layers.filter(l => !l.retired && l.textured).length;
    const engaged = derived?.twins.length ?? 0;
    let shown = 0;
    const failed: string[] = [];
    for (const f of frame?.layers ?? []) {
        const p = parseSwapId(f.objectId);
        if (!p || p.kind !== 'tex' || p.epoch !== sw.epoch) continue;
        if (f.phase === 'revealing' || f.phase === 'revealed') shown++;
        if (f.loadFailed) failed.push(p.layerId);
    }
    // the pass's own measured shares, else the layers' (weighted by their bytes as a proxy for texels)
    let rungShares = state.texturePass?.rungShares;
    if (!rungShares) {
        const ls = state.layers.filter(l => !l.retired && l.textured?.rungShares?.length);
        const w = ls.reduce((a, l) => a + Math.max(1, l.textured!.bytes), 0);
        if (ls.length > 0) {
            rungShares = TEXTURE_RUNG_COLORS.map((_, i) => ls.reduce((a, l) => a + (l.textured!.rungShares[i] ?? 0) * Math.max(1, l.textured!.bytes), 0) / w);
        }
    }
    // texels the facade material reading wrote (its provenance entries' coverage), weighted like the rungs
    const read = state.layers.filter(l => !l.retired && l.textured?.provenance?.some(p => p.source === FACADE_MATERIAL_SOURCE));
    const rw = state.layers.filter(l => !l.retired && l.textured).reduce((a, l) => a + Math.max(1, l.textured!.bytes), 0);
    const materialShare = read.length && rw ? read.reduce((a, l) => a + l.textured!.provenance.filter(p => p.source === FACADE_MATERIAL_SOURCE).reduce((x, p) => x + p.coverage, 0) * Math.max(1, l.textured!.bytes), 0) / rw : undefined;
    return { mode: sw.mode, available, engaged, shown, failedLayerIds: failed, ...(state.texturePass ? { pass: state.texturePass } : {}), ...(rungShares ? { rungShares } : {}), ...(materialShare !== undefined ? { materialShare } : {}) };
}
