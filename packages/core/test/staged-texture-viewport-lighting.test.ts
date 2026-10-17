/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The staged viewport's neutral studio light (AGENTS.md: skybox and lighting 'studio', neutral key plus ambient fill) on a
 * geo-anchored scene, as the live staged artifact is (headless Chrome, real WebGL, the real Scene3DPrimitive). On the live
 * Washington Square Arch the clay drew navy and the photo textures dark and blue: the large-scale branch of the studio rig
 * swapped its neutral ambient for a light steel blue (0xb0c4de) and the key/fill levels left most faces at a quarter of
 * their albedo. Pixels: a uniform mid-grey (sRGB 128) textured twin renders near mid-grey and not blue; the clay renders
 * light and no bluer than its own albedo. Screenshots: test-results/screenshots/staged_lighting_*.png (gitignored).
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

const SHOTS = path.join(REPO_ROOT, 'test-results', 'screenshots');
const STEP = 16;
const GREY = 128;

/** Mean colour of the canvas pixels the model covers (differ from the corner background), right of the overlay panel. */
const MODEL_MEAN = `(() => {
    const gl = window.__SB_3D_STACK__.renderer.getContext();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const d = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, d);
    // the backdrop: the top-right corner (row 0 of the buffer is the bottom, where the ground can reach the corner)
    const c0 = ((h - 1) * w + w - 1) * 4;
    const bg = [d[c0], d[c0 + 1], d[c0 + 2]];
    const isBg = (i) => Math.max(Math.abs(d[i * 4] - bg[0]), Math.abs(d[i * 4 + 1] - bg[1]), Math.abs(d[i * 4 + 2] - bg[2])) <= 6;
    let n = 0, r = 0, g = 0, b = 0;
    for (let i = 0; i < w * h; i++) {
        const px = i % w, py = h - 1 - Math.floor(i / w);
        if (px < 400 || py < 60 || py > h - 80) continue;
        // model pixels at least 3 px from the background, so anti-aliased silhouette edges (mixed with the blue-grey
        // backdrop) do not count as the model's colour
        let edge = false;
        for (let dy = -3; dy <= 3 && !edge; dy += 3) for (let dx = -3; dx <= 3 && !edge; dx += 3) { const j = i + dy * w + dx; if (j < 0 || j >= w * h || isBg(j)) edge = true; }
        if (edge) continue;
        const o = i * 4;
        n++; r += d[o]; g += d[o + 1]; b += d[o + 2];
    }
    return { n, mean: [r / Math.max(1, n), g / Math.max(1, n), b / Math.max(1, n)] };
})()`;

describe.skipIf(!stagedChrome.ok)('staged viewport lighting: neutral studio on a geo-anchored scene (headless Chrome, real viewport)', () => {
    let fixture: StagedFixtureGlbs;
    let twinGlb: Buffer;
    let page: StagedPage;
    const L = (l: FixtureLayerId, extra: Partial<StagedLayer> = {}) => fixtureLayer(l, fixture.counts, '/models', extra);
    const L2 = () => objectIdOf('l2');

    beforeAll(async () => {
        fixture = buildStagedFixture();
        const atlas = await buildUvAtlas({ layerKey: 'remesh', clayGlb: fixture.glbs.l2, densityTexelsPerMeter: 12, maxSide: 1024, islandNormalToleranceDeg: 30, surfaces: [] });
        const { width: W, height: H } = atlas;
        const albedo = new Uint8Array(W * H * 4), confidence = emptyConfidencePlane(W, H);
        for (let i = 0; i < W * H; i++) if (atlas.texels.covered[i]) { albedo.set([GREY, GREY, GREY, 255], i * 4); packConfidenceTexel(confidence, i, 0, 1, 0); }
        const planes: BakedTexturePlanes = { layerKey: 'remesh', width: W, height: H, albedo, confidence, degradations: [],
            provenance: [{ source: 'synthetic-test', label: 'generated', method: 'uniform mid-grey for the lighting test (test only)', coverage: 1 }] };
        twinGlb = writeTexturedTwinGlb({ clayGlb: fixture.glbs.l2, atlas, planes }).glb;
        page = await openStagedPage({ manualFrames: true, shotDir: SHOTS });
        serveFixture(page, fixture.glbs, objectIdOf, fixture.sidecar);
        page.serve(`${L2()}.textured.glb`, twinGlb);
    }, 180_000);
    afterAll(async () => { await page?.close(); });

    test('a mid-grey texture renders near mid-grey and not blue; the clay renders light and no bluer than its albedo', async () => {
        const state = fixtureState([L('l2', { textured: { url: `/models/${L2()}.textured.glb`, bytes: twinGlb.length, ladderRung: 0, rungShares: [1, 0, 0, 0, 0, 0], provenance: [{ source: 'synthetic-test', label: 'generated', method: 'test', coverage: 1 }], confidenceChannels: 'R index, G weight, B rung, A produced', builtAtMs: 1, cached: false } })], { runState: 'finished' });
        await page.eval(`sbHarness.mount(${JSON.stringify(stagedSceneData(state, { geoAnchor: { lat: 40.7312, lng: -73.9971, elevation: 9 } }))})`);
        await page.waitFor('sbHarness.ready()');
        await page.waitFor(`sbHarness.attached(${JSON.stringify(L2())})`, 30_000, 'l2 attached');
        for (let i = 0; i < 600 && (await page.eval<{ phase: string } | null>(`sbHarness.layer(${JSON.stringify(L2())})`))?.phase !== 'revealed'; i++) await page.step(1, STEP);
        await page.step(4, STEP);
        await page.eval(`sbHarness.setCameraView([0, 7, 0], { theta: 0.5, phi: 1.1, distance: 34 })`);
        await page.step(2, STEP);
        const lights = await page.eval<Array<{ type: string; color: string }>>(`(() => { const out = []; window.__SB_3D_SCENE__.traverse(o => { if (o.isLight) out.push({ type: o.type, color: o.color.getHexString() }); }); return out; })()`);
        const clay = await page.eval<{ n: number; mean: number[] }>(MODEL_MEAN);
        await page.screenshot('staged_lighting_1_clay');
        await page.eval(`sbHarness.click('[data-testid="sb-staged-materials-toggle"]')`);
        await page.waitFor(`sbHarness.attached(${JSON.stringify(`${L2()}~tex`)})`, 30_000, 'twin attached');
        for (let i = 0; i < 120; i++) await page.step(1, STEP);
        const tex = await page.eval<{ n: number; mean: number[] }>(MODEL_MEAN);
        const visible = await page.eval<Record<string, number>>(`(() => { const m = {}; window.__SB_3D_SCENE__.traverse(o => { if (!o.isMesh) return; let v = true; for (let p = o; p; p = p.parent) if (!p.visible) v = false; if (!v) return; const mt = Array.isArray(o.material) ? o.material[0] : o.material; const k = mt.type + '|' + (mt.map ? 'map' : 'nomap') + '|' + mt.color.getHexString() + '|' + mt.opacity + '|' + (mt.userData.isClayMaterial ? 'clay' : ''); m[k] = (m[k] || 0) + 1; }); return m; })()`);
        await page.screenshot('staged_lighting_2_mid_grey_texture');
        const renderer = await page.eval<{ toneMapping: number; exposure: number; colorSpace: string }>(`(() => { const r = window.__SB_3D_STACK__.renderer; const sc = window.__SB_3D_SCENE__; let env = null; sc.traverse(o => { if (o.isMesh && o.material.map) env = { envMap: !!o.material.envMap, envI: o.material.envMapIntensity, sceneEnv: !!sc.environment, mapCs: o.material.map.colorSpace, img: (() => { const im = o.material.map.image; if (!im) return null; const c = document.createElement('canvas'); c.width = 8; c.height = 8; const x = c.getContext('2d'); x.drawImage(im, 0, 0, 8, 8); return Array.from(x.getImageData(0, 0, 8, 8).data.slice(0, 32)); })() }; }); return { toneMapping: r.toneMapping, exposure: r.toneMappingExposure, colorSpace: r.outputColorSpace, env }; })()`);
        const report = JSON.stringify({ lights, clay, tex, renderer, visible });
        fs.mkdirSync(SHOTS, { recursive: true });
        fs.writeFileSync(path.join(SHOTS, 'staged_lighting_report.json'), report);
        // every light of the neutral studio is white
        for (const l of lights) expect(l.color, report).toBe('ffffff');
        expect(clay.n, report).toBeGreaterThan(20_000);
        expect(tex.n, report).toBeGreaterThan(20_000);
        const [tr, tg, tb] = tex.mean;
        // the neutral texture stays neutral...
        expect(Math.abs(tb - tr), report).toBeLessThanOrEqual(4);
        expect(Math.abs(tg - tr), report).toBeLessThanOrEqual(4);
        // ...and near the mid-grey it is (sRGB 128) on average over the lit and the shaded faces
        expect((tr + tg + tb) / 3, report).toBeGreaterThanOrEqual(GREY - 20);
        expect((tr + tg + tb) / 3, report).toBeLessThanOrEqual(GREY + 25);
        // the clay (sRGB about 142, 146, 155) renders light grey, no bluer than its own albedo's 13 levels
        const [cr, cg, cb] = clay.mean;
        expect((cr + cg + cb) / 3, report).toBeGreaterThanOrEqual(120);
        expect(cb - cr, report).toBeLessThanOrEqual(16);
    }, 240_000);
});
