/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Clay (when chosen) → real textures → texture provenance → clay, and the textured default (clay first, then the twin
 * crossfades in on its own), in the REAL viewport (headless Chrome, real WebGL, the real
 * Scene3DPrimitive loader and staged-build hook). The remeshed layer of the synthetic arch fixture gets a textured twin
 * built by the real texture-pass writers (buildUvAtlas + writeTexturedTwinGlb) from synthetic baked planes: a brick and
 * sandstone albedo, and a confidence plane whose rung (B) changes in five height bands. The overlay's own buttons drive
 * every switch. Pixels: clay is grey; textured is the albedo's colours; provenance shows the five rung colours in their
 * bands; back to clay is grey again. Screenshots: test-results/screenshots/staged_texture_viewport_*.png (gitignored).
 */

import * as path from 'path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { StagedLayer } from '../src/common/spatial/staged-location-contracts';
import { packConfidenceTexel, TEXTURE_LADDER_RUNGS, type BakedTexturePlanes } from '../src/common/spatial/texture-pass-contracts';
import { buildUvAtlas, type LaidOutUvAtlas } from '../src/node/3d-engine/staged-location/texture-uv';
import { writeTexturedTwinGlb } from '../src/node/3d-engine/staged-location/staged-glb-writer';
import { TEXTURE_RUNG_COLORS } from '../src/browser/generative-canvas/primitives/scene3d/stagedBuild/provenanceShading';
import { buildStagedFixture, fixtureLayer, fixtureState, objectIdOf, type FixtureLayerId, type StagedFixtureGlbs } from './helpers/staged-glb-fixture';
import { openStagedPage, serveFixture, stagedChrome, type StagedPage } from './helpers/staged-build-chrome';
import { stagedSceneData } from './helpers/staged-build-scene';
import { emptyConfidencePlane } from './helpers/texture-pass-fixtures';
import { REPO_ROOT } from './helpers/requirements';

const SHOTS = path.join(REPO_ROOT, 'test-results', 'screenshots');
const STEP = 16;
const RUNG_BANDS = 5;

/** Brick (rows of courses) and sandstone (alternating every other metre) by texel world position; the rung by height band. */
function syntheticPlanes(atlas: LaidOutUvAtlas): BakedTexturePlanes {
    const { width: W, height: H } = atlas;
    const { covered, position } = atlas.texels;
    let y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < W * H; i++) if (covered[i]) { y0 = Math.min(y0, position[i * 3 + 1]); y1 = Math.max(y1, position[i * 3 + 1]); }
    const albedo = new Uint8Array(W * H * 4), confidence = emptyConfidencePlane(W, H);
    for (let i = 0; i < W * H; i++) {
        if (!covered[i]) continue;
        const x = position[i * 3], y = position[i * 3 + 1], z = position[i * 3 + 2];
        const course = Math.floor(y / 0.6), brick = (Math.floor((x + z) / 1.2 + (course % 2) * 0.5) + course) % 2 === 0;
        const rgb = brick ? [168, 74, 52] : [214, 176, 112];
        albedo.set([...rgb, 255], i * 4);
        const rung = Math.min(RUNG_BANDS - 1, Math.floor(((y - y0) / Math.max(1e-6, y1 - y0)) * RUNG_BANDS));
        packConfidenceTexel(confidence, i, 0, 1, rung);
    }
    return {
        layerKey: atlas.layerKey, width: W, height: H, albedo, confidence,
        provenance: [{ source: 'synthetic-test', label: 'generated', method: 'synthetic brick and sandstone for the viewport test (test only)', coverage: 1 }],
        degradations: []
    };
}

/**
 * Canvas pixels the model covers (differ from the corner background) right of the overlay panel and clear of the HUD and
 * the scrubber: count, grey and warm counts, and counts by nearest rung hue.
 */
const PIXEL_STATS = (rungHexes: readonly string[]) => `(() => {
    const stack = window.__SB_3D_STACK__;
    const gl = stack.renderer.getContext();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const d = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, d);
    const bg = [d[0], d[1], d[2]];
    const hueOf = (r, g, b) => { const mx = Math.max(r, g, b), mn = Math.min(r, g, b), c = mx - mn; if (c < 1e-6) return -1; let x = mx === r ? ((g - b) / c) % 6 : mx === g ? (b - r) / c + 2 : (r - g) / c + 4; return (x * 60 + 360) % 360; };
    const rungs = ${JSON.stringify(rungHexes)}.map(hx => { const n = parseInt(hx.slice(1), 16); return hueOf((n >> 16) & 255, (n >> 8) & 255, n & 255); });
    const byRung = rungs.map(() => 0);
    let model = 0, grey = 0, warm = 0, sr = 0, sg = 0, sb = 0;
    for (let i = 0; i < w * h; i++) {
        const px = i % w, py = h - 1 - Math.floor(i / w);
        if (px < 400 || py < 60 || py > h - 80) continue;
        const o = i * 4, r = d[o], g = d[o + 1], b = d[o + 2];
        if (Math.max(Math.abs(r - bg[0]), Math.abs(g - bg[1]), Math.abs(b - bg[2])) <= 10) continue;
        model++; sr += r; sg += g; sb += b;
        const sat = Math.max(r, g, b) - Math.min(r, g, b);
        if (sat < 22) { grey++; continue; }
        if (r > b + 30 && r >= g) warm++;
        const hu = hueOf(r, g, b);
        let best = -1, bd = 1e9;
        rungs.forEach((rh, k) => { const dd = Math.min(Math.abs(hu - rh), 360 - Math.abs(hu - rh)); if (dd < bd) { bd = dd; best = k; } });
        if (bd <= 8) byRung[best]++;
    }
    return { model, grey, warm, byRung, mean: [sr / Math.max(1, model), sg / Math.max(1, model), sb / Math.max(1, model)] };
})()`;

type PixelStats = { model: number; grey: number; warm: number; byRung: number[]; mean: [number, number, number] };

describe.skipIf(!stagedChrome.ok)('staged build: clay, real textures, texture provenance (headless Chrome, real viewport)', () => {
    let fixture: StagedFixtureGlbs;
    let twinGlb: Buffer;
    let page: StagedPage;
    const L = (l: FixtureLayerId, extra: Partial<StagedLayer> = {}) => fixtureLayer(l, fixture.counts, '/models', extra);
    const L2 = () => objectIdOf('l2');

    beforeAll(async () => {
        fixture = buildStagedFixture();
        const atlas = await buildUvAtlas({ layerKey: 'remesh', clayGlb: fixture.glbs.l2, densityTexelsPerMeter: 24, maxSide: 2048, islandNormalToleranceDeg: 30, surfaces: [] });
        twinGlb = writeTexturedTwinGlb({ clayGlb: fixture.glbs.l2, atlas, planes: syntheticPlanes(atlas) }).glb;
        page = await openStagedPage({ manualFrames: true, shotDir: SHOTS });
        serveFixture(page, fixture.glbs, objectIdOf, fixture.sidecar);
        page.serve(`${L2()}.textured.glb`, twinGlb);
    }, 180_000);
    afterAll(async () => { await page?.close(); });

    const stats = () => page.eval<PixelStats>(PIXEL_STATS(TEXTURE_RUNG_COLORS));
    const swapFrame = (epoch: number, kind: 'tex' | 'clay') => page.eval<{ phase: string; progress: number; hidden: boolean } | null>(`sbHarness.layer(${JSON.stringify(`${L2()}~${kind}#${epoch}`)})`);
    async function stepUntil(what: string, cond: () => Promise<boolean>, max = 600): Promise<void> {
        for (let i = 0; i < max; i++) {
            if (await cond()) return;
            await page.step(1, STEP);
        }
        throw new Error(`never: ${what}`);
    }

    test('clay when chosen; the overlay switches to the textured twin (crossfade), shows rungs per texel, and back to clay', async () => {
        const rungShares = [0.2, 0.2, 0.2, 0.2, 0.2, 0];
        // the viewer chose clay (saved with the scene): the twin is not shown until they ask for textures
        const state = { ...fixtureState([L('l1'), L('l2', { textured: { url: `/models/${L2()}.textured.glb`, bytes: twinGlb.length, ladderRung: 4, rungShares, provenance: [{ source: 'synthetic-test', label: 'generated', method: 'test', coverage: 1 }], confidenceChannels: 'R index, G weight, B rung, A produced', builtAtMs: 1, cached: false } })], { runState: 'finished' }), materialMode: 'clay' as const };
        await page.eval(`sbHarness.mount(${JSON.stringify(stagedSceneData(state))})`);
        await page.waitFor('sbHarness.ready()');
        for (const l of ['l1', 'l2'] as const) await page.waitFor(`sbHarness.attached(${JSON.stringify(objectIdOf(l))})`, 30_000, `${l} attached`);
        await stepUntil('l2 revealed', async () => (await page.eval<{ phase: string } | null>(`sbHarness.layer(${JSON.stringify(L2())})`))?.phase === 'revealed');
        await page.step(4, STEP);
        await page.eval(`sbHarness.setCameraView([0, 7, 0], { theta: 0.5, phi: 1.1, distance: 34 })`);
        await page.step(2, STEP);
        // clay was chosen: the twin is not even loaded
        expect(await page.eval<boolean>(`sbHarness.attached(${JSON.stringify(`${L2()}~tex`)})`)).toBe(false);
        expect(await page.eval<string>(`sbHarness.text('[data-testid="sb-staged-materials-toggle"]')`)).toBe('Show real textures');
        expect(await page.eval<string>(`sbHarness.text('[data-testid="sb-staged-texture-status"]')`)).toMatch(/^Clay\. Real textures ready for 1 layer/);
        const clay = await stats();
        await page.screenshot('staged_texture_viewport_1_clay');
        expect(clay.model).toBeGreaterThan(20_000);
        expect(clay.warm / clay.model, 'clay has no albedo colour').toBeLessThan(0.02);

        // Show real textures: the twin is added as a scene object, loads, and crossfades in over the clay
        await page.eval(`sbHarness.click('[data-testid="sb-staged-materials-toggle"]')`);
        await page.step(1, STEP);
        await page.waitFor(`sbHarness.attached(${JSON.stringify(`${L2()}~tex`)})`, 30_000, 'twin attached');
        await stepUntil('the twin is half revealed', async () => { const f = await swapFrame(1, 'tex'); return !!f && f.phase === 'revealing' && f.progress >= 0.5; });
        await page.screenshot('staged_texture_viewport_2_crossfade');
        const mid = await stats();
        await stepUntil('the twin revealed', async () => (await swapFrame(1, 'tex'))?.phase === 'revealed');
        await page.step(4, STEP);
        const textured = await stats();
        await page.screenshot('staged_texture_viewport_3_textured');
        expect((await page.eval<{ hidden: boolean } | null>(`sbHarness.layer(${JSON.stringify(L2())})`))!.hidden, 'the clay is hidden under its twin').toBe(true);
        expect(await page.eval<string>(`sbHarness.text('[data-testid="sb-staged-materials-toggle"]')`)).toBe('Show clay');
        expect(await page.eval<string>(`sbHarness.text('[data-testid="sb-staged-texture-status"]')`)).toMatch(/^Real textures on 1 of 1 layer \(photo-inferred, labelled per texel\)/);
        // the toggle saved the choice with the scene
        expect(await page.eval<string | undefined>(`sbHarness.lastUpdate()?.stagedBuild?.materialMode`)).toBe('textured');
        // the twin is the same geometry, placed where the clay is: equal world bounds, mesh by mesh name
        const bounds = await page.eval<Array<Record<string, number[]>>>(`(() => {
            const box = id => { const r = window.__SB_3D_EXTERNAL_OBJECTS__.get(id); r.updateMatrixWorld(true); const out = {};
                r.traverse(o => { if (!o.isMesh) return; o.geometry.computeBoundingBox(); const b = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld); out[o.name] = [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z]; });
                return out; };
            return [box(${JSON.stringify(L2())}), box(${JSON.stringify(`${L2()}~tex`)})];
        })()`);
        expect(Object.keys(bounds[1]).sort()).toEqual(Object.keys(bounds[0]).sort());
        for (const [name, b] of Object.entries(bounds[0])) bounds[1][name].forEach((v, k) => expect(v, `${name} bound ${k}`).toBeCloseTo(b[k], 5));
        expect(textured.warm / textured.model, 'textured shows the brick and sandstone albedo').toBeGreaterThan(0.6);
        expect(textured.grey / textured.model).toBeLessThan(clay.grey / clay.model);
        expect(mid.warm, 'mid-crossfade: part textured').toBeGreaterThan(0);
        // the twin's meshes keep their photo material (the clay pass skipped them)
        const twinMeshes = await page.eval<Array<{ material: string; staged: string | null; visible: boolean }>>(`sbHarness.meshStates(${JSON.stringify(`${L2()}~tex`)})`);
        expect(twinMeshes.length).toBeGreaterThan(0);
        expect(twinMeshes.every(m => m.staged === null && m.visible)).toBe(true);

        // Provenance in textured mode: each texel in its rung's colour, five bands; the rung legend names the ladder
        await page.eval(`sbHarness.click('[data-testid="sb-staged-provenance-toggle"]')`);
        await page.step(4, STEP);
        const prov = await stats();
        await page.screenshot('staged_texture_viewport_4_provenance_rungs');
        const legend = await page.eval<string>(`sbHarness.text('[data-testid="sb-staged-rung-legend"]')`);
        for (const name of TEXTURE_LADDER_RUNGS) expect(legend).toContain(name);
        expect(legend).toContain('street-view multi-view blend (20% of texels)');
        for (let r = 0; r < RUNG_BANDS; r++) expect(prov.byRung[r], `rung ${r} (${TEXTURE_LADDER_RUNGS[r]}) drawn in ${TEXTURE_RUNG_COLORS[r]}: ${JSON.stringify(prov.byRung)}`).toBeGreaterThan(prov.model * 0.02);
        expect(prov.byRung.slice(0, RUNG_BANDS).reduce((a, b) => a + b, 0) / prov.model, 'most model pixels are in a rung colour (the rest: edges, the dark soffit)').toBeGreaterThan(0.5);
        const twinStaged = await page.eval<Array<{ staged: string | null }>>(`sbHarness.meshStates(${JSON.stringify(`${L2()}~tex`)})`);
        expect(twinStaged.every(m => m.staged === 'rungs')).toBe(true);

        // Provenance off, then back to clay: the clay crossfades back in over the twin
        await page.eval(`sbHarness.click('[data-testid="sb-staged-provenance-toggle"]')`);
        await page.step(2, STEP);
        await page.eval(`sbHarness.click('[data-testid="sb-staged-materials-toggle"]')`);
        await page.step(1, STEP);
        await stepUntil('clay back', async () => (await swapFrame(2, 'clay'))?.phase === 'revealed');
        await page.step(4, STEP);
        const back = await stats();
        await page.screenshot('staged_texture_viewport_5_back_to_clay');
        expect(back.warm / back.model, 'back to grey clay').toBeLessThan(0.02);
        expect(Math.max(...back.mean.map((c, i) => Math.abs(c - clay.mean[i])))).toBeLessThan(6);
        expect((await page.eval<{ hidden: boolean } | null>(`sbHarness.layer(${JSON.stringify(`${L2()}~tex#1`)})`))!.hidden).toBe(true);
        expect(await page.eval<string>(`sbHarness.text('[data-testid="sb-staged-materials-toggle"]')`)).toBe('Show real textures');
        expect(await page.eval<string | undefined>(`sbHarness.lastUpdate()?.stagedBuild?.materialMode`)).toBe('clay');
        // reopened from what was saved: the clay choice holds, the twin is not loaded again
        const saved = await page.eval<Record<string, unknown>>(`sbHarness.lastUpdate()`);
        await page.eval(`sbHarness.mount(${JSON.stringify({ ...saved, objects: (saved.objects as Array<{ id: string }>).filter(o => !o.id.endsWith('~tex')) })})`);
        await page.waitFor('sbHarness.ready()');
        await page.waitFor(`sbHarness.attached(${JSON.stringify(L2())})`, 30_000, 'l2 attached after reopening');
        await stepUntil('l2 revealed after reopening', async () => (await page.eval<{ phase: string } | null>(`sbHarness.layer(${JSON.stringify(L2())})`))?.phase === 'revealed');
        await page.step(8, STEP);
        expect(await page.eval<boolean>(`sbHarness.attached(${JSON.stringify(`${L2()}~tex`)})`)).toBe(false);
        expect(await page.eval<string>(`sbHarness.text('[data-testid="sb-staged-materials-toggle"]')`)).toBe('Show real textures');
        expect(page.consoleErrors().filter(e => !/favicon/.test(e))).toEqual([]);
    }, 240_000);

    test('textured by default: clay reveals first, then the twin crossfades in on its own; "Show clay" goes back', async () => {
        const textured = { url: `/models/${L2()}.textured.glb`, bytes: twinGlb.length, ladderRung: 4, rungShares: [0.2, 0.2, 0.2, 0.2, 0.2, 0], provenance: [{ source: 'synthetic-test', label: 'generated', method: 'test', coverage: 1 }], confidenceChannels: 'R index, G weight, B rung, A produced', builtAtMs: 1, cached: false };
        // a live run: the clay layers commit first, without a material mode
        const live = fixtureState([L('l1'), L('l2')], { runState: 'running' });
        await page.eval(`sbHarness.mount(${JSON.stringify(stagedSceneData(live))})`);
        await page.waitFor('sbHarness.ready()');
        for (const l of ['l1', 'l2'] as const) await page.waitFor(`sbHarness.attached(${JSON.stringify(objectIdOf(l))})`, 30_000, `${l} attached`);
        await stepUntil('l2 revealed', async () => (await page.eval<{ phase: string } | null>(`sbHarness.layer(${JSON.stringify(L2())})`))?.phase === 'revealed');
        await page.eval(`sbHarness.setCameraView([0, 7, 0], { theta: 0.5, phi: 1.1, distance: 34 })`);
        await page.step(4, STEP);
        const clay = await stats();
        await page.screenshot('staged_texture_viewport_8_default_clay_first');
        expect(clay.warm / clay.model, 'the first result is clay').toBeLessThan(0.02);
        // the texture stage commits l2's twin: no click, the viewport crossfades to it
        await page.eval(`sbHarness.update(${JSON.stringify(stagedSceneData(fixtureState([L('l1'), L('l2', { textured })], { runState: 'finished' })))})`);
        await page.step(1, STEP);
        await page.waitFor(`sbHarness.attached(${JSON.stringify(`${L2()}~tex`)})`, 30_000, 'twin attached');
        await stepUntil('the twin revealed', async () => (await swapFrame(1, 'tex'))?.phase === 'revealed');
        await page.step(4, STEP);
        const tex = await stats();
        await page.screenshot('staged_texture_viewport_9_default_textured');
        expect(tex.warm / tex.model, 'textured on its own').toBeGreaterThan(0.6);
        expect(await page.eval<string>(`sbHarness.text('[data-testid="sb-staged-materials-toggle"]')`)).toBe('Show clay');
        // "Show clay": the clay crossfades back and the choice is saved
        await page.eval(`sbHarness.click('[data-testid="sb-staged-materials-toggle"]')`);
        await page.step(1, STEP);
        await stepUntil('clay back', async () => (await swapFrame(2, 'clay'))?.phase === 'revealed');
        await page.step(4, STEP);
        const back = await stats();
        await page.screenshot('staged_texture_viewport_10_default_show_clay');
        expect(back.warm / back.model).toBeLessThan(0.02);
        expect(await page.eval<string | undefined>(`sbHarness.lastUpdate()?.stagedBuild?.materialMode`)).toBe('clay');
        // a later commit of the same run without a mode keeps the clay choice
        await page.eval(`sbHarness.update(${JSON.stringify(stagedSceneData(fixtureState([L('l1'), L('l2', { textured })], { runState: 'finished' })))})`);
        await page.step(8, STEP);
        expect(await page.eval<string>(`sbHarness.text('[data-testid="sb-staged-materials-toggle"]')`)).toBe('Show real textures');
        expect((await page.eval<{ hidden: boolean } | null>(`sbHarness.layer(${JSON.stringify(`${L2()}~tex#1`)})`))!.hidden).toBe(true);
        expect(page.consoleErrors().filter(e => !/favicon/.test(e))).toEqual([]);
    }, 240_000);

    test('the scene data switches it too (what staged_location_material_mode writes): materialMode and the provenance view', async () => {
        const textured = { url: `/models/${L2()}.textured.glb`, bytes: twinGlb.length, ladderRung: 4, rungShares: [0.2, 0.2, 0.2, 0.2, 0.2, 0], provenance: [{ source: 'synthetic-test', label: 'generated', method: 'test', coverage: 1 }], confidenceChannels: 'R index, G weight, B rung, A produced', builtAtMs: 1, cached: false };
        const state = { ...fixtureState([L('l1'), L('l2', { textured })], { runState: 'finished' }), materialMode: 'textured' as const };
        await page.eval(`sbHarness.mount(${JSON.stringify({ ...stagedSceneData(state), stagedBuildView: { provenance: true } })})`);
        await page.waitFor('sbHarness.ready()');
        await page.waitFor(`sbHarness.attached(${JSON.stringify(`${L2()}~tex`)})`, 30_000, 'twin attached');
        await page.step(2, STEP);   // the reveal stats are global: let this viewport's guard write its own frame first
        await stepUntil('the twin revealed', async () => (await swapFrame(1, 'tex'))?.phase === 'revealed');
        expect((await page.eval<{ hidden: boolean } | null>(`sbHarness.layer(${JSON.stringify(L2())})`))!.hidden).toBe(true);
        await page.eval(`sbHarness.setCameraView([0, 7, 0], { theta: 0.5, phi: 1.1, distance: 34 })`);
        await page.step(4, STEP);
        const prov = await stats();
        await page.screenshot('staged_texture_viewport_6_scene_data_textured_provenance');
        for (let r = 0; r < RUNG_BANDS; r++) expect(prov.byRung[r], `rung ${r}: ${JSON.stringify(prov.byRung)}`).toBeGreaterThan(prov.model * 0.02);
        expect(await page.eval<string>(`sbHarness.text('[data-testid="sb-staged-provenance-toggle"]')`)).toBe('Provenance');
        // the model asks for clay (provenance off): the clay crossfades back
        await page.eval(`sbHarness.update(${JSON.stringify({ ...stagedSceneData({ ...state, materialMode: 'clay' }), stagedBuildView: { provenance: false } })})`);
        await page.step(1, STEP);
        await stepUntil('clay back', async () => (await swapFrame(2, 'clay'))?.phase === 'revealed');
        await page.step(4, STEP);
        const back = await stats();
        await page.screenshot('staged_texture_viewport_7_scene_data_clay');
        expect(back.warm / back.model).toBeLessThan(0.02);
        expect(back.byRung.slice(0, RUNG_BANDS).reduce((a, b) => a + b, 0) / back.model).toBeLessThan(0.05);
    }, 240_000);
});
