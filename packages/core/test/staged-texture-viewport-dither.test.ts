/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * After "Show real textures" the clay <-> textured crossfade must reach its end state: every fragment of the textured
 * twin drawn (no screen-space dither left on it), the clay copy hidden. The live Washington Square Arch showed the whole
 * scene in a stipple, each pixel either clay or twin. Headless Chrome, the real viewport: the fixture's l2 (arch and
 * ground) gets a flat green twin, so any dither left over shows as clay-grey pixels inside the twin's footprint.
 * Screenshots: test-results/screenshots/staged_dither_*.png (gitignored).
 */

import * as fs from 'fs';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { StagedLayer } from '../src/common/spatial/staged-location-contracts';
import { packConfidenceTexel, type BakedTexturePlanes } from '../src/common/spatial/texture-pass-contracts';
import { buildUvAtlas } from '../src/node/3d-engine/staged-location/texture-uv';
import { writeTexturedTwinGlb } from '../src/node/3d-engine/staged-location/staged-glb-writer';
import { buildStagedFixture, fixtureLayer, fixtureState, objectIdOf, type FixtureLayerId, type StagedFixtureGlbs } from './helpers/staged-glb-fixture';
import { openStagedPage, serveFixture, stagedChrome, type StagedPage } from './helpers/staged-build-chrome';
import { stagedSceneData } from './helpers/staged-build-scene';
import { emptyConfidencePlane } from './helpers/texture-pass-fixtures';
import { REPO_ROOT } from './helpers/requirements';
import { decodePng } from './helpers/png-decode';

const SHOTS = path.join(REPO_ROOT, 'test-results', 'screenshots');
const STEP = 16;

async function uniformTwin(clay: Buffer, rgb: [number, number, number], key: string): Promise<Buffer> {
    const atlas = await buildUvAtlas({ layerKey: key, clayGlb: clay, densityTexelsPerMeter: 12, maxSide: 1024, islandNormalToleranceDeg: 30, surfaces: [] });
    const { width: W, height: H } = atlas;
    const albedo = new Uint8Array(W * H * 4), confidence = emptyConfidencePlane(W, H);
    for (let i = 0; i < W * H; i++) if (atlas.texels.covered[i]) { albedo.set([...rgb, 255], i * 4); packConfidenceTexel(confidence, i, 0, 1, 0); }
    const planes: BakedTexturePlanes = { layerKey: key, width: W, height: H, albedo, confidence, degradations: [],
        provenance: [{ source: 'synthetic-test', label: 'generated', method: 'uniform colour for the dither test (test only)', coverage: 1 }] };
    return writeTexturedTwinGlb({ clayGlb: clay, atlas, planes }).glb;
}

/**
 * The stipple, read from the page as shown (the CDP screenshot): over the canvas right of the overlay panel and clear of
 * the HUD and scrubber, every 2x2 pixel block that holds the twin's flat green, and the share of those blocks that also
 * hold something else. A twin drawn whole is green inside and mixes only along its silhouette (about 1%); a twin with
 * any dither (its own fade, or a copy of the clay drawn through it) mixes in about half of its blocks.
 */
function stippleOf(pngFile: string): { greenBlocks: number; mixedShare: number } {
    const { width: w, height: h, channels: c, pixels: p } = decodePng(fs.readFileSync(pngFile));
    const green = (i: number) => p[i + 1] > p[i] + 25 && p[i + 1] > p[i + 2] + 25;
    let blocks = 0, mixed = 0;
    for (let y = 60; y < h - 81; y++) for (let x = 400; x < w - 1; x++) {
        const g = [(y * w + x) * c, (y * w + x + 1) * c, ((y + 1) * w + x) * c, ((y + 1) * w + x + 1) * c].filter(green).length;
        if (g === 0) continue;
        blocks++;
        if (g < 4) mixed++;
    }
    return { greenBlocks: blocks, mixedShare: blocks ? mixed / blocks : 0 };
}

describe.skipIf(!stagedChrome.ok)('staged viewport: the clay <-> textured crossfade ends with no dither (headless Chrome, real viewport)', () => {
    let fixture: StagedFixtureGlbs;
    let green: Buffer;
    let page: StagedPage;
    const L = (l: FixtureLayerId, extra: Partial<StagedLayer> = {}) => fixtureLayer(l, fixture.counts, '/models', extra);
    const textured = (l: FixtureLayerId, glb: Buffer) => ({ textured: { url: `/models/${objectIdOf(l)}.textured.glb`, bytes: glb.length, ladderRung: 0, rungShares: [1, 0, 0, 0, 0, 0], provenance: [{ source: 'synthetic-test', label: 'generated', method: 'test', coverage: 1 }], confidenceChannels: 'R index, G weight, B rung, A produced', builtAtMs: 1, cached: false } });
    const L2 = () => objectIdOf('l2');

    beforeAll(async () => {
        fixture = buildStagedFixture();
        green = await uniformTwin(fixture.glbs.l2, [40, 190, 60], 'l2');
        page = await openStagedPage({ manualFrames: true, shotDir: SHOTS });
        serveFixture(page, fixture.glbs, objectIdOf, fixture.sidecar);
        page.serve(`${L2()}.textured.glb`, green);
    }, 180_000);
    afterAll(async () => { await page?.close(); });

    async function stepUntil(what: string, cond: () => Promise<boolean>, max = 900): Promise<void> {
        for (let i = 0; i < max; i++) { if (await cond()) return; await page.step(1, STEP); }
        throw new Error(`never: ${what}`);
    }
    const phase = (id: string) => page.eval<{ phase: string; progress: number; presence: number; hidden: boolean } | null>(`sbHarness.layer(${JSON.stringify(id)})`);
    type Mesh = { name: string; visible: boolean; staged: string | null; uniforms: { progress: number; fade: number; presence: number } | null };
    const meshes = (id: string) => page.eval<Mesh[]>(`sbHarness.meshStates(${JSON.stringify(id)})`);

    async function expectTexturedEnd(label: string): Promise<void> {
        await page.step(30, STEP);
        const shot = stippleOf(await page.screenshot(`staged_dither_${label}`));
        const twin = await meshes(`${L2()}~tex`);
        const clay = await meshes(L2());
        const report = JSON.stringify({ label, shot, twin: twin.slice(0, 3), clay: clay.slice(0, 3) });
        expect(twin.length, report).toBeGreaterThan(0);
        // every twin mesh drawn on its own (photo) material, or on a staged one with no dither at all
        for (const m of twin) {
            expect(m.visible, report).toBe(true);
            if (m.uniforms) { expect(m.uniforms.fade, report).toBe(1); expect(m.uniforms.presence, report).toBe(1); }
        }
        // the clay copy hidden
        expect(clay.every(m => !m.visible), report).toBe(true);
        // pixels: the flat green twin covers the view with no halftone
        expect(shot.greenBlocks, report).toBeGreaterThan(50_000);
        expect(shot.mixedShare, report).toBeLessThan(0.03);
    }

    test('after a degraded finish, a live run, Stop, back to clay and to textures again, provenance on and off', async () => {
        const state = fixtureState([L('l1'), L('l2', textured('l2', green))], { runState: 'finished', stageStatus: { detail: 'degraded' }, degradations: [] });
        await page.eval(`sbHarness.mount(${JSON.stringify(stagedSceneData(state))})`);
        await page.waitFor('sbHarness.ready()');
        await page.waitFor(`sbHarness.attached(${JSON.stringify(L2())})`, 30_000, 'l2 attached');
        await stepUntil('l2 revealed', async () => (await phase(L2()))?.phase === 'revealed');
        await page.eval(`sbHarness.setCameraView([0, 7, 0], { theta: 0.5, phi: 1.1, distance: 34 })`);
        await page.step(4, STEP);

        await page.eval(`sbHarness.click('[data-testid="sb-staged-materials-toggle"]')`);
        await page.waitFor(`sbHarness.attached(${JSON.stringify(`${L2()}~tex`)})`, 30_000, 'twin attached');
        await stepUntil('twin revealed', async () => (await phase(`${L2()}~tex#1`))?.phase === 'revealed');
        await expectTexturedEnd('1_textured');

        await page.eval(`sbHarness.click('[data-testid="sb-staged-provenance-toggle"]')`);
        await page.step(6, STEP);
        await page.eval(`sbHarness.click('[data-testid="sb-staged-provenance-toggle"]')`);
        await expectTexturedEnd('2_provenance_off');

        await page.eval(`sbHarness.click('[data-testid="sb-staged-materials-toggle"]')`);
        await stepUntil('clay back', async () => (await phase(`${L2()}~clay#2`))?.phase === 'revealed');
        await page.step(30, STEP);
        await page.eval(`sbHarness.click('[data-testid="sb-staged-materials-toggle"]')`);
        await stepUntil('twin again', async () => (await phase(`${L2()}~tex#3`))?.phase === 'revealed');
        await expectTexturedEnd('3_textured_again');

        // Stop (the run is settled): the textured end state holds
        await page.eval(`sbHarness.update(${JSON.stringify(stagedSceneData({ ...state, runState: 'stopped' }))})`);
        await expectTexturedEnd('4_stopped');
    }, 300_000);

    test('the scene data asks for textures (staged_location_material_mode) on a scene with a clay preset', async () => {
        const data = (st: object, extra: object = {}) => JSON.stringify({ ...stagedSceneData(st as never), clayPreset: 'studio-grey', ...extra });
        const state = fixtureState([L('l1'), L('l2', textured('l2', green))], { runState: 'finished', stageStatus: { detail: 'degraded' }, degradations: [] });
        await page.eval(`sbHarness.mount(${data(state)})`);
        await page.waitFor('sbHarness.ready()');
        await page.waitFor(`sbHarness.attached(${JSON.stringify(L2())})`, 30_000, 'l2 attached');
        await stepUntil('l2 revealed', async () => (await phase(L2()))?.phase === 'revealed');
        await page.eval(`sbHarness.setCameraView([0, 7, 0], { theta: 0.5, phi: 1.1, distance: 34 })`);
        await page.step(4, STEP);
        await page.eval(`sbHarness.update(${data({ ...state, materialMode: 'textured' })})`);
        await page.waitFor(`sbHarness.attached(${JSON.stringify(`${L2()}~tex`)})`, 30_000, 'twin attached');
        await stepUntil('twin revealed', async () => (await phase(`${L2()}~tex#1`))?.phase === 'revealed');
        await expectTexturedEnd('5_scene_data_textured');
        await page.eval(`sbHarness.update(${data({ ...state, materialMode: 'textured' }, { stagedBuildView: { provenance: true } })})`);
        await page.step(6, STEP);
        await page.eval(`sbHarness.update(${data({ ...state, materialMode: 'textured' }, { stagedBuildView: { provenance: false } })})`);
        await expectTexturedEnd('6_scene_data_provenance_off');
    }, 300_000);

    test('"Show replaced layers" never ghosts the clay copy a swap hid (the live stipple), and still ghosts what a layer replaced', async () => {
        // l2 alone (its tiles are not in this scene), so nothing in view is a replaced layer: any ghost is the swap's copy
        const state = fixtureState([L('l2', textured('l2', green))], { runState: 'finished', stageStatus: { detail: 'degraded' }, degradations: [] });
        await page.eval(`sbHarness.mount(${JSON.stringify(stagedSceneData(state))})`);
        await page.waitFor('sbHarness.ready()');
        await page.waitFor(`sbHarness.attached(${JSON.stringify(L2())})`, 30_000, 'l2 attached');
        await stepUntil('l2 revealed', async () => (await phase(L2()))?.phase === 'revealed');
        await page.eval(`sbHarness.setCameraView([0, 7, 0], { theta: 0.5, phi: 1.1, distance: 34 })`);
        // the viewer turned "Show replaced layers" on in clay, then asks for real textures
        await page.eval(`sbHarness.click('[data-testid="sb-staged-show-replaced"]')`);
        await page.step(4, STEP);
        await page.eval(`sbHarness.click('[data-testid="sb-staged-materials-toggle"]')`);
        await page.waitFor(`sbHarness.attached(${JSON.stringify(`${L2()}~tex`)})`, 30_000, 'twin attached');
        await stepUntil('twin revealed', async () => (await phase(`${L2()}~tex#1`))?.phase === 'revealed');
        await expectTexturedEnd('5_show_replaced_textured');

        // Stop, then back to clay: the twin is not ghosted over the clay either
        await page.eval(`sbHarness.update(${JSON.stringify(stagedSceneData({ ...state, runState: 'stopped' }))})`);
        await expectTexturedEnd('6_show_replaced_stopped');
        await page.eval(`sbHarness.click('[data-testid="sb-staged-materials-toggle"]')`);
        await stepUntil('clay back', async () => (await phase(`${L2()}~clay#2`))?.phase === 'revealed');
        await page.step(30, STEP);
        await page.screenshot('staged_dither_7_show_replaced_clay');
        const twin = await meshes(`${L2()}~tex`);
        expect(twin.every(m => !m.visible), JSON.stringify(twin.slice(0, 2))).toBe(true);
        const clay = await meshes(L2());
        expect(clay.every(m => m.visible && (!m.uniforms || m.uniforms.presence === 1)), JSON.stringify(clay.slice(0, 2))).toBe(true);

        // textures again, provenance on and off
        await page.eval(`sbHarness.click('[data-testid="sb-staged-materials-toggle"]')`);
        await stepUntil('twin again', async () => (await phase(`${L2()}~tex#3`))?.phase === 'revealed');
        await expectTexturedEnd('8_show_replaced_textured_again');
        await page.eval(`sbHarness.click('[data-testid="sb-staged-provenance-toggle"]')`);
        await page.step(6, STEP);
        await page.eval(`sbHarness.click('[data-testid="sb-staged-provenance-toggle"]')`);
        await expectTexturedEnd('9_show_replaced_provenance_off');

        // the tiles l2 replaced come into the scene: they are a replaced layer, drawn as a ghost (a quarter of their pixels)
        await page.eval(`sbHarness.update(${JSON.stringify(stagedSceneData({ ...state, runState: 'stopped', layers: [L('l1'), ...state.layers] }))})`);
        await page.waitFor(`sbHarness.attached(${JSON.stringify(objectIdOf('l1'))})`, 30_000, 'l1 attached');
        await page.step(30, STEP);
        await page.screenshot('staged_dither_10_show_replaced_tiles_ghost');
        const l1 = await meshes(objectIdOf('l1'));
        expect(l1.length).toBeGreaterThan(0);
        expect(l1.every(m => m.visible && m.uniforms?.presence === 0.25), JSON.stringify(l1.slice(0, 2))).toBe(true);
        // "Show replaced layers" off: the tiles are hidden again (not left drawn whole over the twin) and the twin is clean
        await page.eval(`sbHarness.click('[data-testid="sb-staged-show-replaced"]')`);
        await expectTexturedEnd('11_show_replaced_off');
        const l1After = await meshes(objectIdOf('l1'));
        expect(l1After.every(m => !m.visible), JSON.stringify(l1After.slice(0, 2))).toBe(true);
    }, 300_000);
});
