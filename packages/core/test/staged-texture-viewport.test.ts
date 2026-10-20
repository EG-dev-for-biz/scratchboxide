/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Clay or textured in the staged-build viewport (texture pass design §9, task F), without a browser: which layers get a
 * twin object, how the swap reveal layers are wired into the existing scheduler (crossfade from clay, back again, the
 * owner of each model), that a finished run still animates a swap the viewer asked for, the overlay's words, and the
 * staged_location_material_mode tool / sb_set_staged_material_mode operator (scene data only).
 */

import { describe, expect, test } from 'vitest';
import { validateContract, type StagedBuildState, type StagedLayer, type StagedTexturedVariant } from '../src/common/spatial/staged-location-contracts';
import { TEXTURE_LADDER_RUNGS } from '../src/common/spatial/texture-pass-contracts';
import { stepRevealSchedule, type LayerLoadState, type RevealSchedule } from '../src/browser/generative-canvas/primitives/scene3d/stagedBuild/revealScheduler';
import {
    DEFAULT_MATERIAL_MODE, INITIAL_SWITCH, MATERIAL_SWAP_REVEAL_MS, carryMaterialMode, carryTwinObjects, deriveMaterialLayers, isMaterialSwapLayer, modelIdOf, nextSwitch, parseSwapId, twinObjectFor, twinObjectId, withStagedMaterialMode,
    type EngagedTwin, type MaterialSwitch
} from '../src/browser/generative-canvas/primitives/scene3d/stagedBuild/texturedTwins';
import { TEXTURE_RUNG_COLORS, textureRungLegendRows } from '../src/browser/generative-canvas/primitives/scene3d/stagedBuild/provenanceShading';
import { materialsSentence } from '../src/browser/generative-canvas/primitives/scene3d/stagedBuild/StagedBuildOverlay';
import { materialsSummary } from '../src/browser/generative-canvas/primitives/scene3d/stagedBuild/useStagedBuild';
import { applyStagedMaterialMode } from '../src/browser/generative-canvas/services/operators/material-pbr-operators';
import { runStagedMaterialModeTool, STAGED_MATERIAL_MODE_DECLARATION } from '../src/node/gemini/tools/staged-material-mode-tool';
import { GOOGLE_3D_TILES_TOOL_DECLARATIONS, google3DTilesHandlers } from '../src/node/gemini/tools/spatial-tools';
import type { Media4DObject, Scene3DData } from '../src/browser/generative-canvas/canvas-types';
import { fixtureLayer, fixtureState, objectIdOf, type FixtureLayerId } from './helpers/staged-glb-fixture';

const COUNTS = Object.fromEntries((['l1', 'l2', 'l3a', 'l3b', 'l4', 'l5', 'l5x'] as const).map(l => [l, { vertices: 1000, triangles: 1800, nodes: 3 }])) as Record<FixtureLayerId, { vertices: number; triangles: number; nodes: number }>;
const layer = (l: FixtureLayerId, extra: Partial<StagedLayer> = {}) => fixtureLayer(l, COUNTS, '/models', extra);
const twin = (l: FixtureLayerId, extra: Partial<StagedTexturedVariant> = {}): StagedTexturedVariant => ({
    url: `/models/${objectIdOf(l)}.textured.glb`, bytes: 1000, ladderRung: 1, rungShares: [0.5, 0.2, 0.2, 0.05, 0.05, 0],
    provenance: [{ source: 'street-view-projection', label: 'photo-inferred', method: 'weighted mean, 3 views', coverage: 0.7 }],
    confidenceChannels: 'R = index, G = weight, B = rung, A = produced', builtAtMs: 1, cached: false, ...extra
});

/** A viewer who chose clay before anything was textured (the default, DEFAULT_MATERIAL_MODE, is textured). */
const CLAY: MaterialSwitch = INITIAL_SWITCH;

const L2 = objectIdOf('l2'), L1 = objectIdOf('l1'), L5 = objectIdOf('l5');

/** Drives the real scheduler over the derived state, with models (by object id) ready as the test says. */
class Viewport {
    sw: MaterialSwitch = CLAY;
    engaged = new Map<string, EngagedTwin>();
    schedule: RevealSchedule | undefined;
    models = new Set<string>();
    now = 0;
    settled = false;
    mountEpoch = 0;
    constructor(public state: StagedBuildState) {}
    mode(m: 'clay' | 'textured') { this.sw = nextSwitch(this.sw, m); return this; }
    derive() { return deriveMaterialLayers(this.state, this.sw, this.engaged, { started: id => !!this.schedule?.layers[id], live: true }); }
    step(dt = 0) {
        this.now += dt;
        const d = this.derive();
        const loads: Record<string, LayerLoadState> = {};
        for (const l of d.state.layers) loads[l.objectId] = { ready: this.models.has(modelIdOf(l.objectId)), readyAtMs: 0 };
        const r = stepRevealSchedule(this.schedule, {
            state: d.state, loads, nowMs: this.now, reducedMotion: false, settled: this.settled, replayEpoch: 0,
            exemptFromSettled: lay => { const p = parseSwapId(lay.objectId); return !!p && p.epoch > this.mountEpoch; }
        });
        this.schedule = r.schedule;
        return { d, frame: r.frame, f: (id: string) => r.frame.layers.find(x => x.objectId === id) };
    }
}

describe('textured twins: which objects load and how they crossfade', () => {
    test('clay (on request) adds nothing: the scheduler sees the build state itself, no twin object', () => {
        const state = fixtureState([layer('l1'), layer('l2', { textured: twin('l2') })]);
        const d = deriveMaterialLayers(state, CLAY, new Map());
        expect(d.state).toBe(state);
        expect(d.twins).toEqual([]);
    });

    test('textured: one swap layer per layer with a twin, from its clay, on the twin model; layers without a twin stay as they are', () => {
        const state = fixtureState([layer('l1'), layer('l2', { textured: twin('l2') }), layer('l5')]);
        const sw = nextSwitch(CLAY, 'textured');
        const d = deriveMaterialLayers(state, sw, new Map());
        expect(d.twins.map(l => l.objectId)).toEqual([L2]);
        const tex = d.state.layers.find(l => l.objectId === `${L2}~tex#1`)!;
        expect(tex).toBeDefined();
        expect(modelIdOf(tex.objectId)).toBe(twinObjectId(L2));
        expect(tex.url).toBe(twin('l2').url);
        expect(tex.reveal.crossfadeFrom).toEqual([L2]);
        expect(tex.supersedes).toEqual(expect.arrayContaining([L2, L1]));   // and what l2 replaced stays replaced
        expect(tex.revealAfter).toEqual([L2]);
        expect(tex.reveal.durationMs).toBe(MATERIAL_SWAP_REVEAL_MS);
        expect(tex.reveal.stagger).toBeGreaterThan(0);   // drawn in front of the clay node by node: no z-fight, no hole
        expect(tex.textured).toBeUndefined();
        expect(tex.counts).toEqual(state.layers[1].counts);
        // the build layers are untouched objects
        for (const id of [L1, L2, L5]) expect(d.state.layers.find(l => l.objectId === id)).toBe(state.layers.find(l => l.objectId === id));
        expect(d.state.layers.filter(isMaterialSwapLayer)).toHaveLength(1);
        expect(d.owner.get(L2)).toBe(L2);
        expect(d.owner.get(`${L2}~tex#1`)).toBe(`${L2}~tex#1`);
    });

    test('textured is the default: clay reveals first, then the twin the texture pass commits crossfades in on its own', () => {
        expect(DEFAULT_MATERIAL_MODE).toBe('textured');
        expect(nextSwitch(INITIAL_SWITCH, DEFAULT_MATERIAL_MODE)).toEqual({ mode: 'textured', epoch: 1 });
        // the build commits clay first (no twin yet): nothing to swap, the clay reveals as before
        const v = new Viewport(fixtureState([layer('l1'), layer('l2')]));
        v.sw = nextSwitch(INITIAL_SWITCH, DEFAULT_MATERIAL_MODE);
        v.models.add(L1); v.models.add(L2);
        let s = v.step();
        for (let i = 0; i < 40; i++) s = v.step(100);
        expect(s.f(L2)!.phase).toBe('revealed');
        expect(s.d.twins).toEqual([]);
        // the texture stage commits l2's twin: it is engaged at once, with no switch, and crossfades over the clay
        v.state = fixtureState([layer('l1'), layer('l2', { textured: twin('l2') })]);
        s = v.step(16);
        const T = `${L2}~tex#1`;
        expect(s.d.twins.map(l => l.objectId)).toEqual([L2]);
        expect(s.f(T)!.phase).toBe('loading');
        expect(s.f(L2)!.hidden).toBe(false);
        v.models.add(twinObjectId(L2));
        s = v.step(16);
        expect(s.f(T)!.phase).toBe('revealing');
        expect(s.f(T)!.overSource).toBe(true);
        s = v.step(MATERIAL_SWAP_REVEAL_MS + 50);
        expect(s.f(T)!.phase).toBe('revealed');
        expect(s.f(L2)!.hidden).toBe(true);
        // the viewer's clay choice crossfades back and holds
        v.mode('clay');
        s = v.step(16);
        s = v.step(MATERIAL_SWAP_REVEAL_MS + 50);
        expect(s.f(`${L2}~clay#2`)!.phase).toBe('revealed');
        expect(s.f(T)!.hidden).toBe(true);
    });

    test('a clay choice made on the open scene holds over a later commit of the same run, not over a new run', () => {
        const prev = { ...fixtureState([layer('l1')]), materialMode: 'clay' };
        const later = fixtureState([layer('l1'), layer('l2', { textured: twin('l2') })]);
        expect(carryMaterialMode(prev, later)!.materialMode).toBe('clay');
        expect(carryMaterialMode(prev, { ...later, materialMode: 'textured' })!.materialMode).toBe('textured');   // a new request wins
        expect(carryMaterialMode(prev, { ...later, runId: 'another-run' })!.materialMode).toBeUndefined();
        expect(carryMaterialMode(undefined, later)).toBe(later);
    });

    test('a layer another layer replaces (and a retired one) gets no twin', () => {
        const state = fixtureState([layer('l1', { textured: twin('l1') }), layer('l2'), layer('l3a'), layer('l3b', { textured: twin('l3b'), supersedes: [L2] }), layer('l5', { textured: twin('l5'), retired: true })]);
        const d = deriveMaterialLayers(state, nextSwitch(CLAY, 'textured'), new Map());
        expect(d.twins.map(l => l.layer)).toEqual(['l3b']);
    });

    test('a refit that later replaces an engaged layer also replaces its swap layers', () => {
        const base = [layer('l1'), layer('l2', { textured: twin('l2') })];
        const engaged = new Map<string, EngagedTwin>();
        const sw = nextSwitch(CLAY, 'textured');
        deriveMaterialLayers(fixtureState(base), sw, engaged);
        expect(engaged.has(L2)).toBe(true);
        // l3b (supersedes l2) arrives: l2 is no longer eligible, its twin goes
        const d = deriveMaterialLayers(fixtureState([...base, layer('l3a'), layer('l3b')]), sw, engaged);
        expect(d.twins).toEqual([]);
        expect(engaged.has(L2)).toBe(false);
    });

    test('the scheduler: clay reveals, the twin crossfades in over it, clay is hidden; back to clay crossfades the clay in over the twin', () => {
        const state = fixtureState([layer('l1'), layer('l2', { textured: twin('l2') })], { runState: 'finished', updatedAtMs: 0 });
        const v = new Viewport(state);
        v.models.add(L1); v.models.add(L2);
        let s = v.step();
        for (let i = 0; i < 40; i++) s = v.step(100);
        expect(s.f(L2)!.phase).toBe('revealed');
        expect(s.f(L1)!.hidden).toBe(true);

        // textured: the twin model is still loading, so the clay stays and nothing waits on it
        v.mode('textured');
        s = v.step(16);
        const T = `${L2}~tex#1`;
        expect(s.f(T)!.phase).toBe('loading');
        expect(s.f(L2)!.hidden).toBe(false);
        expect(s.frame.pending).toBe(true);
        v.models.add(twinObjectId(L2));
        s = v.step(16);
        expect(s.f(T)!.phase).toBe('revealing');
        expect(s.f(T)!.overSource).toBe(true);
        expect(s.f(L2)!.hidden).toBe(false);     // the clay stays whole under the twin until the twin has revealed
        s = v.step(MATERIAL_SWAP_REVEAL_MS / 2);
        expect(s.f(T)!.progress).toBeGreaterThan(0.4);
        s = v.step(MATERIAL_SWAP_REVEAL_MS);
        expect(s.f(T)!.phase).toBe('revealed');
        expect(s.f(L2)!.hidden).toBe(true);
        expect(s.f(L1)!.hidden).toBe(true);
        expect(s.frame.animating).toBe(false);

        // back to clay: a clay swap layer on l2's own model (it now drives those meshes), crossfading over the twin
        v.mode('clay');
        s = v.step(16);
        const C = `${L2}~clay#2`;
        expect(s.d.owner.get(L2)).toBe(C);
        expect(s.d.owner.get(C)).toBe(C);
        expect(s.d.owner.get(T)).toBe(T);
        expect(modelIdOf(C)).toBe(L2);
        expect(s.f(C)!.phase).toBe('revealing');
        expect(s.f(T)!.hidden).toBe(false);
        s = v.step(MATERIAL_SWAP_REVEAL_MS + 50);
        expect(s.f(C)!.phase).toBe('revealed');
        expect(s.f(T)!.hidden).toBe(true);
        expect(s.f(L1)!.hidden).toBe(true);      // what l2 replaced stays replaced while its swap layers draw it
        // the twin stays engaged (its object stays loaded, hidden) so switching again needs no download
        expect(s.d.twins.map(l => l.objectId)).toEqual([L2]);

        // textured again: from the clay swap layer, on the twin model
        v.mode('textured');
        s = v.step(16);
        const T3 = `${L2}~tex#3`;
        expect(s.d.state.layers.map(l => l.objectId)).toEqual(expect.arrayContaining([L1, L2, C, T3]));
        expect(s.d.state.layers.some(l => l.objectId === T)).toBe(false);
        expect(s.d.owner.get(T3)).toBe(T3);
        expect(s.d.owner.get(L2)).toBe(C);
        s = v.step(MATERIAL_SWAP_REVEAL_MS + 50);
        expect(s.f(T3)!.phase).toBe('revealed');
        expect(s.f(C)!.hidden).toBe(true);
    });

    test('back to clay before the twin ever showed: the clay is back at once (no reveal from nothing)', () => {
        const state = fixtureState([layer('l1'), layer('l2', { textured: twin('l2') })], { runState: 'finished', updatedAtMs: 0 });
        const v = new Viewport(state);
        v.models.add(L1); v.models.add(L2);
        for (let i = 0; i < 40; i++) v.step(100);
        v.mode('textured');
        v.step(16);                       // twin still loading
        v.mode('clay');
        const s = v.step(16);
        const C = `${L2}~clay#2`;
        expect(s.d.state.layers.find(l => l.objectId === C)!.reveal.durationMs).toBe(0);
        expect(s.f(C)!.phase).toBe('revealed');
    });

    test('a finished (settled) run still animates a swap the viewer asked for now; one saved with the scene shows at once', () => {
        const state = fixtureState([layer('l1'), layer('l2', { textured: twin('l2') })], { runState: 'finished', updatedAtMs: 0 });
        const v = new Viewport(state);
        v.settled = true;
        v.models.add(L1); v.models.add(L2); v.models.add(twinObjectId(L2));
        v.step();
        v.mode('textured');
        let s = v.step(16);
        expect(s.f(`${L2}~tex#1`)!.phase).toBe('revealing');
        // saved textured: the epoch at mount is the swap's own epoch, so it is not exempt and shows its end state
        const w = new Viewport(state);
        w.settled = true;
        w.models = v.models;
        w.mode('textured');
        w.mountEpoch = 1;
        s = w.step();
        expect(s.f(`${L2}~tex#1`)!.phase).toBe('revealed');
    });

    test('twin objects: built from the clay object, carried over agent updates while their layer is in the scene', () => {
        const l2 = layer('l2', { textured: twin('l2') });
        const clayObj = { id: L2, content: { type: '3d-model', durableUri: l2.url, metadata: { role: 'environment', source: 'google3dtilesclay' } }, space: { spatial3d: { x: 1, y: 0, z: 2 } } } as unknown as Media4DObject;
        const t = twinObjectFor(l2, clayObj);
        expect(t.id).toBe(twinObjectId(L2));
        expect((t.content as { durableUri: string }).durableUri).toBe(l2.textured!.url);
        expect((t.content as { metadata: Record<string, unknown> }).metadata).toMatchObject({ role: 'environment', source: 'google3dtilesclay', texturedTwinOf: L2 });
        expect(t.space).toEqual(clayObj.space);
        const next = [clayObj];
        expect(carryTwinObjects([clayObj, t], next)!.map(o => o.id)).toEqual([L2, twinObjectId(L2)]);
        expect(carryTwinObjects([clayObj, t], [])).toEqual([]);   // its layer left: the twin goes too
    });
});

describe('overlay words and legend', () => {
    test('rung legend rows carry the ladder names, colours and shares', () => {
        const rows = textureRungLegendRows([0.5, 0.25, 0.2, 0.05, 0, 0]);
        expect(rows.map(r => r.label)).toEqual([...TEXTURE_LADDER_RUNGS]);
        expect(rows.map(r => r.color)).toEqual([...TEXTURE_RUNG_COLORS]);
        expect(rows[0].text).toBe('street-view multi-view blend (50% of texels)');
        expect(new Set(TEXTURE_RUNG_COLORS).size).toBe(TEXTURE_RUNG_COLORS.length);
    });

    test('the materials line: mode, layers shown, the pass in progress, layers whose textures failed to load', () => {
        const state = { ...fixtureState([layer('l1'), layer('l2', { textured: twin('l2') }), layer('l5')]), texturePass: { status: 'running' as const, layersDone: 1, layersTotal: 3, message: 'baking street view' } };
        expect(validateContract('StagedBuildState', state)).toEqual([]);
        const sw = nextSwitch(CLAY, 'textured');
        const d = deriveMaterialLayers(state, sw, new Map());
        const frame = { layers: [{ objectId: `${L2}~tex#1`, phase: 'revealing' }, { objectId: L1, phase: 'revealed' }], animating: true, pending: false } as never;
        const m = materialsSummary(state, frame, sw, d);
        expect(m).toMatchObject({ mode: 'textured', available: 1, engaged: 1, shown: 1, failedLayerIds: [] });
        expect(m.rungShares).toHaveLength(TEXTURE_LADDER_RUNGS.length);
        expect(materialsSentence(state, m)).toBe('Real textures on 1 of 1 layer (photo-inferred, labelled per texel); the rest stay clay. texture pass running: 1 of 3 layers · baking street view; each layer switches as its textures arrive.');
        const failed = materialsSummary(state, { layers: [{ objectId: `${L2}~tex#1`, phase: 'loading', loadFailed: true }], animating: false, pending: false } as never, sw, d);
        expect(materialsSentence(state, failed)).toMatch(/textures of Remeshed scan could not be loaded, so it stays clay\.$/);
        expect(materialsSentence(state, materialsSummary(state, undefined, CLAY, undefined))).toMatch(/^Clay\. Real textures ready for 1 layer/);
    });
});

describe('staged_location_material_mode (tool) and sb_set_staged_material_mode (operator)', () => {
    const scene = (state: StagedBuildState): Scene3DData => ({ title: 'staged', renderMode: 'clay', objects: [{ id: L2 } as Media4DObject], stagedBuild: state } as Scene3DData);

    test('the operator sets materialMode, the matching render mode (and the provenance view) and nothing else', () => {
        const state = fixtureState([layer('l1'), layer('l2', { textured: twin('l2') })]);
        const data = scene(state);
        const before = JSON.stringify({ layers: state.layers, objects: data.objects });
        const r = applyStagedMaterialMode(data, { mode: 'textured', provenance: true });
        expect(r).toMatchObject({ mode: 'textured', renderMode: 'clay', provenance: true, texturedLayers: 1, layers: 2 });
        expect(data.stagedBuild!.materialMode).toBe('textured');
        expect(data.renderMode).toBe('clay');   // a place staged on its own keeps its render mode
        expect((data as { stagedBuildView?: unknown }).stagedBuildView).toEqual({ provenance: true });
        expect(JSON.stringify({ layers: data.stagedBuild!.layers, objects: data.objects })).toBe(before);
        expect(validateContract('StagedBuildState', data.stagedBuild!)).toEqual([]);
        expect(() => applyStagedMaterialMode(data, { mode: 'photo' })).toThrow(/clay" or "textured/);
        expect(() => applyStagedMaterialMode({ title: 'x' } as Scene3DData, { mode: 'clay' })).toThrow(/not a staged location build/);
    });

    test('the tool is declared in the Google 3D Tiles pack and returns the active scene with only the mode changed', async () => {
        expect(GOOGLE_3D_TILES_TOOL_DECLARATIONS.some(d => d.name === 'staged_location_material_mode')).toBe(true);
        expect(typeof google3DTilesHandlers.staged_location_material_mode).toBe('function');
        expect(STAGED_MATERIAL_MODE_DECLARATION.description).toMatch(/Textured is the default: clay shows first/);
        expect(STAGED_MATERIAL_MODE_DECLARATION.description).toMatch(/"clay" shows the whole scene in studio clay \(the staged layers and any object built at the place: it sets the scene render mode to clay\) and stays, across reloads/);
        expect(STAGED_MATERIAL_MODE_DECLARATION.description).toContain('"Show clay"');
        expect(STAGED_MATERIAL_MODE_DECLARATION.description).toMatch(/photo-inferred/);
        expect(STAGED_MATERIAL_MODE_DECLARATION.parameters!.properties!.mode.enum).toEqual(['textured', 'clay']);
        const state = { ...fixtureState([layer('l1'), layer('l2', { textured: twin('l2') }), layer('l5')]), texturePass: { status: 'running' as const, layersDone: 1, layersTotal: 2 } };
        const active = { id: state.artifactId, type: '3d-scene', title: 'x', version: 3, data: scene(state) };
        const ctx = { request: { activeArtifact: active } } as never;
        const out = await runStagedMaterialModeTool({ mode: 'textured' }, ctx);
        const art = out.resultPayload.artifact as { id: string; version: number; data: Scene3DData };
        expect(art.id).toBe(state.artifactId);
        expect(art.version).toBe(4);
        expect(art.data.stagedBuild!.materialMode).toBe('textured');
        expect(art.data.stagedBuild!.layers).toEqual(state.layers);
        expect(art.data.objects).toEqual(active.data.objects);
        expect(out.summaryResult).toMatch(/^Showing photo-inferred textures on 1 of 3 layers \(labelled per texel\); the rest stay clay\. Texels by source: street-view multi-view blend 50%/);
        expect(out.summaryResult).toMatch(/still running \(1 of 2 layers\)/);
        expect(active.data.stagedBuild!.materialMode).toBeUndefined();   // the request's scene is not mutated
        const back = await runStagedMaterialModeTool({ mode: 'clay', provenance: false }, { request: { activeArtifact: { ...active, data: art.data } } } as never);
        expect((back.resultPayload.artifact as { data: Scene3DData }).data.stagedBuild!.materialMode).toBe('clay');
        expect((back.resultPayload.artifact as { data: Scene3DData }).data.renderMode).toBe('clay');
        expect(back.summaryResult).toMatch(/studio clay .*Scene render mode: clay\. Provenance shading is off\.$/);
        await expect(runStagedMaterialModeTool({ mode: 'textured' }, { request: {} } as never)).rejects.toThrow(/no 3D scene is open/);
        await expect(runStagedMaterialModeTool({ mode: 'sepia' }, ctx)).rejects.toThrow(/clay" or "textured/);
    });

    test('an object built at the place: a clay view from the tool is renderMode clay, saved with the scene like the overlay toggle', async () => {
        // build_3d_object_from_reference stages its object on the place's layers with renderMode 'pbr'
        const state = fixtureState([layer('l1'), layer('l2', { textured: twin('l2') })], { runState: 'finished' });
        const placeScene = { ...scene(state), renderMode: 'pbr', objects: [{ id: L2 } as Media4DObject, { id: 'hero-object' } as Media4DObject] } as Scene3DData;
        const active = { id: state.artifactId, type: '3d-scene', title: 'chrome hydrant at a place', version: 5, data: placeScene };
        const out = await runStagedMaterialModeTool({ mode: 'clay' }, { request: { activeArtifact: active } } as never);
        const saved = (out.resultPayload.artifact as { data: Scene3DData }).data;
        expect(out.resultPayload).toMatchObject({ mode: 'clay', renderMode: 'clay' });
        expect(saved.renderMode).toBe('clay');
        expect(saved.stagedBuild!.materialMode).toBe('clay');
        expect(out.summaryResult).toMatch(/Scene render mode: clay\.$/);
        // what a reload reads back (the saved session's JSON) still says clay
        const reloaded = JSON.parse(JSON.stringify(saved)) as Scene3DData;
        expect([reloaded.renderMode, reloaded.stagedBuild!.materialMode]).toEqual(['clay', 'clay']);
        // the overlay toggle writes exactly the same fields
        const shown = (d: Scene3DData) => ({ renderMode: d.renderMode, stagedBuild: d.stagedBuild, view: (d as { stagedBuildView?: unknown }).stagedBuildView, objects: d.objects });
        expect(shown(withStagedMaterialMode(placeScene, 'clay'))).toEqual(shown(saved));
        // and back: textured puts back the render mode clay replaced, so the object shows its own materials again
        const back = await runStagedMaterialModeTool({ mode: 'textured' }, { request: { activeArtifact: { ...active, data: saved } } } as never);
        const textured = (back.resultPayload.artifact as { data: Scene3DData }).data;
        expect([textured.renderMode, textured.stagedBuild!.materialMode]).toEqual(['pbr', 'textured']);
        expect(shown(withStagedMaterialMode(saved, 'textured'))).toEqual(shown(textured));
    });

    test('the render mode that goes with each choice: clay remembers the mode it replaced, textured puts it back', () => {
        const staged = { stagedBuild: { materialMode: undefined as string | undefined } };
        const clayed = withStagedMaterialMode({ ...staged, renderMode: 'pbr' }, 'clay');
        expect(clayed).toMatchObject({ renderMode: 'clay', stagedBuild: { materialMode: 'clay' }, stagedBuildView: { renderModeBeforeClay: 'pbr' } });
        expect(withStagedMaterialMode(clayed, 'clay')).toEqual(clayed);   // asked twice: the remembered mode stays
        const back = withStagedMaterialMode(clayed, 'textured');
        expect(back).toMatchObject({ renderMode: 'pbr', stagedBuild: { materialMode: 'textured' } });
        expect(back.stagedBuildView).toEqual({});
        // a place staged on its own is renderMode 'clay' with textured layers: both choices keep it
        expect(withStagedMaterialMode(withStagedMaterialMode({ ...staged, renderMode: 'clay' }, 'clay'), 'textured').renderMode).toBe('clay');
        expect(withStagedMaterialMode({ ...staged, renderMode: 'shaded', stagedBuildView: { provenance: true } }, 'clay').stagedBuildView).toEqual({ provenance: true, renderModeBeforeClay: 'shaded' });
        expect(withStagedMaterialMode({ ...staged }, 'textured')).not.toHaveProperty('renderMode');   // no mode: the viewport's textured default
        const plain = { title: 'not staged', renderMode: 'pbr' };
        expect(withStagedMaterialMode(plain, 'clay')).toBe(plain);
    });
});
