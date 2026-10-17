/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A detail layer wound inside out that gets its textured twin AFTER the viewport switched to real textures: the live
 * arch's l4 panel on the right pier, which read as see-through in textured mode. The native detail solids include
 * inside-out primitives (negative signed volume, measured on the live run's detail.glb); the clay draws double-sided, so
 * clay hid it, but the twin drew front faces only and showed the solid's far inner faces, the wall behind, through the
 * panel. Headless Chrome, the real viewport: the fit body l3b has a red twin, the inside-out detail layer l4 a blue one.
 * After l4's twin arrives late, it must draw opaque: wherever l4 covers the screen it shows its own blue, never the red
 * body through it, and its swap reveal ends fully present.
 * Screenshot: test-results/screenshots/staged_late_twin_*.png (gitignored).
 */

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
import { COMPONENT_BYTES, parseGlbBytes } from '../src/node/3d-engine/staged-location/glb-bytes';
import { REPO_ROOT } from './helpers/requirements';

const SHOTS = path.join(REPO_ROOT, 'test-results', 'screenshots');
const STEP = 16;

/** The same GLB with every indexed triangle wound the other way (inside out). */
function insideOut(glb: Buffer): Buffer {
    const out = Buffer.from(glb);
    const { json, bin } = parseGlbBytes(out);
    const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
    const done = new Set<number>();
    for (const mesh of json.meshes ?? []) for (const prim of mesh.primitives ?? []) {
        if (prim.indices === undefined || done.has(prim.indices)) continue;
        done.add(prim.indices);
        const acc = json.accessors[prim.indices], view = json.bufferViews[acc.bufferView];
        const size = COMPONENT_BYTES[acc.componentType], base = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
        const get = (i: number) => (size === 4 ? dv.getUint32(base + i * 4, true) : size === 2 ? dv.getUint16(base + i * 2, true) : dv.getUint8(base + i));
        const set = (i: number, v: number) => (size === 4 ? dv.setUint32(base + i * 4, v, true) : size === 2 ? dv.setUint16(base + i * 2, v, true) : dv.setUint8(base + i, v));
        for (let t = 0; t + 2 < acc.count; t += 3) { const b = get(t + 1); set(t + 1, get(t + 2)); set(t + 2, b); }
    }
    return out;
}

async function uniformTwin(clay: Buffer, rgb: [number, number, number], key: string): Promise<Buffer> {
    const atlas = await buildUvAtlas({ layerKey: key, clayGlb: clay, densityTexelsPerMeter: 12, maxSide: 1024, islandNormalToleranceDeg: 30, surfaces: [] });
    const { width: W, height: H } = atlas;
    const albedo = new Uint8Array(W * H * 4), confidence = emptyConfidencePlane(W, H);
    for (let i = 0; i < W * H; i++) if (atlas.texels.covered[i]) { albedo.set([...rgb, 255], i * 4); packConfidenceTexel(confidence, i, 0, 1, 0); }
    const planes: BakedTexturePlanes = { layerKey: key, width: W, height: H, albedo, confidence, degradations: [],
        provenance: [{ source: 'synthetic-test', label: 'generated', method: 'uniform colour for the late-twin test (test only)', coverage: 1 }] };
    return writeTexturedTwinGlb({ clayGlb: clay, atlas, planes }).glb;
}

/** Where the l4 twin draws (pixels that change when it is hidden), and how many of those show red (the body through it). */
const FOOTPRINT = (twinId: string) => `(() => {
    const st = window.__SB_3D_STACK__, sc = window.__SB_3D_SCENE__, cam = window.__SB_3D_CAMERA__;
    const root = window.__SB_3D_EXTERNAL_OBJECTS__.get(${JSON.stringify(twinId)});
    const grab = () => { st.renderer.render(sc, cam); const gl = st.renderer.getContext(); const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight; const d = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, d); return d; };
    const withL4 = grab();
    root.visible = false;
    const without = grab();
    root.visible = true;
    let footprint = 0, blue = 0, red = 0;
    for (let i = 0; i < withL4.length; i += 4) {
        if (Math.abs(withL4[i] - without[i]) + Math.abs(withL4[i + 1] - without[i + 1]) + Math.abs(withL4[i + 2] - without[i + 2]) < 12) continue;
        footprint++;
        const r = withL4[i], b = withL4[i + 2];
        if (b > r + 40) blue++; else if (r > b + 40) red++;
    }
    return { footprint, blue, red };
})()`;

describe.skipIf(!stagedChrome.ok)('staged viewport: a textured twin that arrives after the switch draws opaque (headless Chrome, real viewport)', () => {
    let fixture: StagedFixtureGlbs;
    let red: Buffer, blue: Buffer;
    let page: StagedPage;
    const L = (l: FixtureLayerId, extra: Partial<StagedLayer> = {}) => fixtureLayer(l, fixture.counts, '/models', extra);
    const textured = (l: FixtureLayerId, glb: Buffer) => ({ textured: { url: `/models/${objectIdOf(l)}.textured.glb`, bytes: glb.length, ladderRung: 0, rungShares: [1, 0, 0, 0, 0, 0], provenance: [{ source: 'synthetic-test', label: 'generated', method: 'test', coverage: 1 }], confidenceChannels: 'R index, G weight, B rung, A produced', builtAtMs: 1, cached: false } });

    beforeAll(async () => {
        fixture = buildStagedFixture();
        fixture.glbs.l4 = insideOut(fixture.glbs.l4);
        red = await uniformTwin(fixture.glbs.l3b, [200, 40, 40], 'l3b');
        blue = await uniformTwin(fixture.glbs.l4, [40, 60, 210], 'l4');
        page = await openStagedPage({ manualFrames: true, shotDir: SHOTS });
        serveFixture(page, fixture.glbs, objectIdOf, fixture.sidecar);
        page.serve(`${objectIdOf('l3b')}.textured.glb`, red);
        page.serve(`${objectIdOf('l4')}.textured.glb`, blue);
    }, 180_000);
    afterAll(async () => { await page?.close(); });

    async function stepUntil(what: string, cond: () => Promise<boolean>, max = 900): Promise<void> {
        for (let i = 0; i < max; i++) { if (await cond()) return; await page.step(1, STEP); }
        throw new Error(`never: ${what}`);
    }
    const phase = (id: string) => page.eval<{ phase: string; progress: number; hidden: boolean } | null>(`sbHarness.layer(${JSON.stringify(id)})`);

    test('the late, inside-out l4 twin is fully present and shows its own colour, not the body behind it', async () => {
        const first = fixtureState([L('l2'), L('l3a'), L('l3b', textured('l3b', red)), L('l4')], { runState: 'running', running: ['textures'] });
        await page.eval(`sbHarness.mount(${JSON.stringify(stagedSceneData(first))})`);
        await page.waitFor('sbHarness.ready()');
        for (const l of ['l3b', 'l4'] as const) await page.waitFor(`sbHarness.attached(${JSON.stringify(objectIdOf(l))})`, 30_000, `${l} attached`);
        await stepUntil('l4 revealed', async () => (await phase(objectIdOf('l4')))?.phase === 'revealed');
        await page.eval(`sbHarness.setCameraView([0, 7, 0], { theta: 0.3, phi: 1.25, distance: 30 })`);
        // switch to real textures while l4 has no twin yet
        await page.eval(`sbHarness.click('[data-testid="sb-staged-materials-toggle"]')`);
        await stepUntil('l3b twin revealed', async () => (await phase(`${objectIdOf('l3b')}~tex#1`))?.phase === 'revealed');
        // l4's twin arrives now
        const late = fixtureState([L('l2'), L('l3a'), L('l3b', textured('l3b', red)), L('l4', textured('l4', blue))], { runState: 'finished' });
        await page.eval(`sbHarness.update(${JSON.stringify(stagedSceneData(late))})`);
        await page.waitFor(`sbHarness.attached(${JSON.stringify(`${objectIdOf('l4')}~tex`)})`, 30_000, 'l4 twin attached');
        await stepUntil('l4 twin revealed', async () => (await phase(`${objectIdOf('l4')}~tex#1`))?.phase === 'revealed');
        await page.step(30, STEP);
        await page.screenshot('staged_late_twin_textured');
        const swap = await phase(`${objectIdOf('l4')}~tex#1`);
        const meshes = await page.eval<Array<{ visible: boolean; uniforms: { progress: number; fade: number; presence: number } | null }>>(`sbHarness.meshStates(${JSON.stringify(`${objectIdOf('l4')}~tex`)})`);
        const fp = await page.eval<{ footprint: number; blue: number; red: number }>(FOOTPRINT(`${objectIdOf('l4')}~tex`));
        const report = JSON.stringify({ swap, fp, meshes: meshes.slice(0, 4) });
        expect(swap?.progress, report).toBe(1);
        expect(fp.footprint, report).toBeGreaterThan(500);
        // where l4 draws, it draws itself: blue, not the red body through it
        expect(fp.blue / fp.footprint, report).toBeGreaterThan(0.9);
        expect(fp.red / fp.footprint, report).toBeLessThan(0.02);
    }, 240_000);
});
