/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Clay or textured: which model of a staged layer the viewport shows (texture pass design §9). Pure.
 *
 * A layer with a textured twin (StagedLayer.textured: the same nodes and byte-identical positions, plus UVs, a de-lit
 * photo albedo and the per-texel confidence plane) keeps its clay model mounted; the twin is a second scene object.
 * Switching is a material swap played by the EXISTING staged reveal: each switch adds, per layer, one reveal layer on
 * the model being switched to, which crossfades from the one being left (`crossfadeFrom` + `supersedes`), so the
 * scheduler, the reveal material and the overlay treat it like any other reveal. Nothing here regenerates geometry.
 *
 * Every switch is an epoch. For a layer L first shown textured at epoch f ("engaged" at f), the reveal layer of epoch
 * k >= f is `L~tex#k` (drawn by the twin model) when epoch k is textured and `L~clay#k` (drawn by L's clay model) when
 * it is clay; before f it is L itself. At epoch e the scheduler sees L (always: it keeps the build's own reveal and what
 * L supersedes), the reveal layer of epoch e-1 (the source) and that of e (the front). Two layers can then share one
 * model (L and `L~clay#k`): the newest one on a model drives its meshes (`owner`).
 */

import type { Media4DObject } from '../../../canvas-types';
import type { StagedBuildState, StagedLayer } from '../../../../../common/spatial/staged-location-contracts';

export type MaterialMode = 'clay' | 'textured';

/** The current mode and how many times it has changed (the epoch). */
export interface MaterialSwitch { mode: MaterialMode; epoch: number }

/**
 * The mode a staged build is shown in when nobody chose one: textured (user decision 2026-10-19, textured by default,
 * clay on request). The clay layers still come first; each layer crossfades to its twin when the texture pass commits it.
 */
export const DEFAULT_MATERIAL_MODE: MaterialMode = 'textured';

/**
 * The switch before the viewport's first request: clay, the look every layer is built and revealed in. The first
 * render switches it to the wanted mode (DEFAULT_MATERIAL_MODE unless clay was chosen), so a textured view is epoch 1.
 */
export const INITIAL_SWITCH: MaterialSwitch = { mode: 'clay', epoch: 0 };

/** A swap reveal's length: long enough to read as a crossfade, short enough to never feel like a wait. */
export const MATERIAL_SWAP_REVEAL_MS = 1600;
/** Stagger of a swap over a layer whose own reveal is uniform (stagger 0): node by node, in front of the source. */
export const MATERIAL_SWAP_DEFAULT_STAGGER = 0.5;

const TWIN_OBJECT_SUFFIX = '~tex';
const SWAP_ID = /^(.*)~(tex|clay)#(\d+)$/;

/** Reads a scene's requested mode; anything but 'textured' or 'clay' is no request. */
export function materialModeOf(value: unknown): MaterialMode | undefined {
    return value === 'textured' || value === 'clay' ? value : undefined;
}

/** The scene fields a clay/textured choice on a staged build writes (withStagedMaterialMode). */
export interface StagedMaterialModeFields {
    renderMode?: string;
    stagedBuild?: { materialMode?: string };
    /** The viewer's view of the staged build; renderModeBeforeClay is the render mode a clay choice replaced. */
    stagedBuildView?: { provenance?: boolean; renderModeBeforeClay?: string };
}

/**
 * A staged scene shown in clay or textured: stagedBuild.materialMode and the matching renderMode. The staged layers
 * follow materialMode, but everything else in the scene (an object built at the place, trees, the generated root)
 * follows renderMode, so a clay view is renderMode 'clay'; the mode it replaced is kept in stagedBuildView and textured
 * puts it back (a place staged on its own stays 'clay', an object built there gets its 'pbr' again). What the overlay's
 * toggle and staged_location_material_mode (sb_set_staged_material_mode) both write, so either choice is saved with the
 * scene the same way and survives a reload. A scene without a staged build comes back unchanged.
 */
export function withStagedMaterialMode<D extends StagedMaterialModeFields>(data: D, mode: MaterialMode): D {
    if (!data.stagedBuild) return data;
    const { renderModeBeforeClay, ...view } = data.stagedBuildView ?? {};
    const stagedBuild = { ...data.stagedBuild, materialMode: mode };
    if (mode === 'clay') {
        const before = data.renderMode === 'clay' ? renderModeBeforeClay : data.renderMode;
        return { ...data, stagedBuild, renderMode: 'clay', stagedBuildView: { ...view, ...(before !== undefined ? { renderModeBeforeClay: before } : {}) } };
    }
    const renderMode = data.renderMode === 'clay' && renderModeBeforeClay !== undefined ? renderModeBeforeClay : data.renderMode;
    const out = { ...data, stagedBuild, ...(renderMode !== undefined ? { renderMode } : {}) };
    if (data.stagedBuildView) out.stagedBuildView = view;
    return out;
}

export function nextSwitch(prev: MaterialSwitch, mode: MaterialMode): MaterialSwitch {
    return prev.mode === mode ? prev : { mode, epoch: prev.epoch + 1 };
}

/** The scene object id of a layer's textured twin model. */
export function twinObjectId(layerObjectId: string): string {
    return `${layerObjectId}${TWIN_OBJECT_SUFFIX}`;
}

/** A swap reveal layer's parts, or undefined for any other layer id. */
export function parseSwapId(objectId: string): { layerId: string; kind: 'tex' | 'clay'; epoch: number } | undefined {
    const m = SWAP_ID.exec(objectId);
    return m ? { layerId: m[1], kind: m[2] as 'tex' | 'clay', epoch: Number(m[3]) } : undefined;
}

export function isMaterialSwapLayer(layer: Pick<StagedLayer, 'objectId'>): boolean {
    return SWAP_ID.test(layer.objectId);
}

/** The scene object whose model draws a (possibly swap) layer. */
export function modelIdOf(objectId: string): string {
    const p = parseSwapId(objectId);
    if (!p) return objectId;
    return p.kind === 'tex' ? twinObjectId(p.layerId) : p.layerId;
}

/** Whether an object is a twin this viewport added (it is never part of the server's objects[]). */
export function twinSourceOf(o: Pick<Media4DObject, 'content'> | undefined): string | undefined {
    const v = (o?.content as { metadata?: { texturedTwinOf?: unknown } } | undefined)?.metadata?.texturedTwinOf;
    return typeof v === 'string' ? v : undefined;
}

/** The twin as a scene object: loaded like its clay layer, with its own textures kept (metadata.texturedTwinOf). */
export function twinObjectFor(layer: StagedLayer, clayObject?: Media4DObject): Media4DObject {
    const meta = ((clayObject?.content as { metadata?: Record<string, unknown> } | undefined)?.metadata) ?? { role: 'environment', source: 'staged-location', stage: layer.stage };
    return {
        id: twinObjectId(layer.objectId),
        content: {
            type: '3d-model',
            durableUri: layer.textured!.url,
            mimeType: 'model/gltf-binary',
            metadata: { ...meta, texturedTwinOf: layer.objectId, texturedRung: layer.textured!.ladderRung }
        },
        space: clayObject?.space ?? { spatial3d: { x: 0, y: 0, z: 0 } }
    } as Media4DObject;
}

/**
 * A staged state streamed later from the server without a material mode keeps the one chosen on the open scene (the
 * overlay toggle or staged_location_material_mode), for the same run, so a clay choice made while the build is still
 * running survives its later commits and is saved with the scene.
 */
export function carryMaterialMode<S extends { runId?: string; materialMode?: string }>(prev: S | undefined, next: S | undefined): S | undefined {
    if (!next || !prev || prev === next || next.materialMode !== undefined || prev.materialMode === undefined) return next;
    if (prev.runId !== next.runId) return next;
    return { ...next, materialMode: prev.materialMode };
}

/**
 * A scene streamed later from a running staged build (composeStagedArtifact always sends renderMode 'clay' and no
 * material mode) keeps the clay/textured choice made on the open scene for the same run: stagedBuild.materialMode
 * (carryMaterialMode) together with the renderMode and stagedBuildView.renderModeBeforeClay withStagedMaterialMode
 * wrote with it, so a textured choice on a place with an object standing there is not reset to clay by the next commit.
 * Without such a choice, or for another run, the streamed scene comes back unchanged.
 */
export function carryStagedChoice<D extends StagedMaterialModeFields>(prev: StagedMaterialModeFields | undefined, next: D): D {
    const stagedBuild = carryMaterialMode(prev?.stagedBuild as { runId?: string; materialMode?: string } | undefined, next.stagedBuild as { runId?: string; materialMode?: string } | undefined);
    if (!prev || !stagedBuild || stagedBuild === next.stagedBuild) return next;
    const view = { ...next.stagedBuildView };
    delete view.renderModeBeforeClay;
    const before = prev.stagedBuildView?.renderModeBeforeClay;
    const out = { ...next, stagedBuild };
    if (prev.renderMode !== undefined) out.renderMode = prev.renderMode; else delete out.renderMode;
    if (next.stagedBuildView || before !== undefined) out.stagedBuildView = { ...view, ...(before !== undefined ? { renderModeBeforeClay: before } : {}) };
    return out;
}

/**
 * Twins the viewport added keep their place when an agent update replaces objects[] (the stream does not know them),
 * as long as their clay layer is still in it; otherwise every streamed commit would unload and reload them.
 */
export function carryTwinObjects(prev: readonly Media4DObject[] | undefined, next: Media4DObject[] | undefined): Media4DObject[] | undefined {
    if (!next || !prev || prev === next) return next;
    const ids = new Set(next.map(o => o.id));
    const carried = prev.filter(o => { const src = twinSourceOf(o); return !!src && ids.has(src) && !ids.has(o.id); });
    return carried.length > 0 ? [...next, ...carried] : next;
}

/** A layer that can show a twin: it has one, it is in the scene, and no other layer in the scene replaces it. */
export function twinEligible(layer: StagedLayer, state: StagedBuildState): boolean {
    if (!layer.textured || layer.retired) return false;
    return !state.layers.some(o => o !== layer && !o.retired && (o.supersedes.includes(layer.objectId) || o.reveal.crossfadeFrom.includes(layer.objectId)));
}

export interface EngagedTwin {
    /** Epoch the layer was first shown textured. */
    epoch: number;
    /** Engaged after the viewport opened the run (a change made now, not one saved with the scene). */
    live: boolean;
}

export interface DerivedMaterialState {
    /** What the scheduler and the guard see: the build's layers plus the swap layers of the current switch. */
    state: StagedBuildState;
    /** Layer id -> the layer that drives its model's meshes this epoch (the newest on that model). */
    owner: ReadonlyMap<string, string>;
    /** Twin objects the scene must hold (engaged layers). */
    twins: StagedLayer[];
    /** Engaged layers by id (the input map, updated). */
    engaged: Map<string, EngagedTwin>;
}

export interface DeriveOptions {
    /** Whether a layer has started its reveal (has a timeline in the current schedule). */
    started?: (objectId: string) => boolean;
    /** The viewport has already shown this run (engagements from now on are live changes). */
    live?: boolean;
}

function modeAt(sw: MaterialSwitch, epoch: number): MaterialMode {
    return (sw.epoch - epoch) % 2 === 0 ? sw.mode : sw.mode === 'clay' ? 'textured' : 'clay';
}

/** The reveal layer of epoch `k` for a layer engaged at `f`. */
export function swapLayerId(layerId: string, k: number, f: number, sw: MaterialSwitch): string {
    if (k < f) return layerId;
    return `${layerId}~${modeAt(sw, k) === 'textured' ? 'tex' : 'clay'}#${k}`;
}

function swapLayer(layer: StagedLayer, id: string, sourceId: string, durationMs: number): StagedLayer {
    const kind = parseSwapId(id)!.kind;
    const inherited = [...layer.supersedes, ...layer.reveal.crossfadeFrom];
    return {
        ...layer,
        objectId: id,
        layer: `${layer.layer}~${kind}`,
        url: kind === 'tex' ? layer.textured!.url : layer.url,
        bytes: kind === 'tex' ? layer.textured!.bytes : layer.bytes,
        // what L replaced stays replaced whichever model draws L
        supersedes: [...new Set([sourceId, ...inherited])].filter(s => s !== id),
        // the twin waits for the clay it swaps from to have revealed (the build's own reveal first); going back to clay never waits
        revealAfter: kind === 'tex' ? [sourceId] : [],
        reveal: {
            durationMs,
            stagger: layer.reveal.stagger > 0 ? layer.reveal.stagger : MATERIAL_SWAP_DEFAULT_STAGGER,
            crossfadeFrom: [sourceId],
            ...(layer.reveal.orderUrl ? { orderUrl: layer.reveal.orderUrl } : {})
        },
        cached: false,
        retired: undefined,
        textured: undefined
    };
}

/**
 * The scheduler's view of `state` under the switch `sw`. `engaged` (by layer id) is updated in place: a layer that can
 * show a twin is engaged at the current epoch the first time the mode is textured, and stays engaged while it has a twin.
 */
export function deriveMaterialLayers(state: StagedBuildState, sw: MaterialSwitch, engaged: Map<string, EngagedTwin>, opts: DeriveOptions = {}): DerivedMaterialState {
    const owner = new Map<string, string>();
    const twins: StagedLayer[] = [];
    const out: StagedLayer[] = [];
    /** Every id that stands for a layer this epoch (the layer and its swap layers), for references from other layers. */
    const family = new Map<string, string[]>();
    for (const layer of state.layers) {
        const id = layer.objectId;
        if (!twinEligible(layer, state)) {
            engaged.delete(id);
            out.push(layer);
            continue;
        }
        let e = engaged.get(id);
        if (!e && sw.mode === 'textured') {
            e = { epoch: sw.epoch, live: !!opts.live };
            engaged.set(id, e);
        }
        out.push(layer);
        if (!e) continue;
        twins.push(layer);
        const f = e.epoch;
        const frontId = swapLayerId(id, sw.epoch, f, sw);
        const sourceId = swapLayerId(id, sw.epoch - 1, f, sw);
        const members = [id];
        if (sourceId !== id) {
            const before = swapLayerId(id, sw.epoch - 2, f, sw);
            out.push(swapLayer(layer, sourceId, before, MATERIAL_SWAP_REVEAL_MS));
            members.push(sourceId);
        }
        // Back to clay from a twin that never started showing: nothing to crossfade from, so the clay is back at once.
        const front = parseSwapId(frontId)!;
        const sourceShown = sourceId === id || !opts.started || opts.started(sourceId);
        out.push(swapLayer(layer, frontId, sourceId, front.kind === 'clay' && !sourceShown ? 0 : MATERIAL_SWAP_REVEAL_MS));
        members.push(frontId);
        family.set(id, members);
        // the newest layer on each model drives its meshes
        for (const m of members) {
            const model = modelIdOf(m);
            const cur = owner.get(model);
            const epochOf = (x: string) => parseSwapId(x)?.epoch ?? -1;
            if (cur === undefined || epochOf(m) > epochOf(cur)) owner.set(model, m);
        }
    }
    const ownerByLayer = new Map<string, string>();
    for (const l of out) ownerByLayer.set(l.objectId, owner.get(modelIdOf(l.objectId)) ?? l.objectId);
    // Other layers that replace or wait for an engaged layer refer to every layer standing for it.
    const expand = (ids: string[]) => (ids.some(x => family.has(x)) ? [...new Set(ids.flatMap(x => family.get(x) ?? [x]))] : ids);
    const layers = family.size === 0 ? out : out.map(l => {
        if (isMaterialSwapLayer(l)) return l;
        const supersedes = expand(l.supersedes);
        const crossfadeFrom = expand(l.reveal.crossfadeFrom);
        if (supersedes === l.supersedes && crossfadeFrom === l.reveal.crossfadeFrom) return l;
        return { ...l, supersedes, reveal: { ...l.reveal, crossfadeFrom } };
    });
    const derived = family.size === 0 ? state : { ...state, layers };
    return { state: derived, owner: ownerByLayer, twins, engaged };
}
