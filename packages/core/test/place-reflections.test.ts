/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Place reflections (scene3d/placeReflections.ts) in the REAL viewport (headless Chrome, real WebGL, the real
 * Scene3DPrimitive loader and render loop): a chrome sphere stands at a geo-anchored place between a red wall and a green
 * building. With the probe its metal shows the green building on the side facing it, the fallback sky above and the
 * ground below; without it (the opt-out) the metal is near black. The place itself, clay mode and studio scenes are
 * pixel-identical with and without the probe; the background is never the fallback sky; probes are re-rendered when the
 * object moves, not every frame. Screenshots: test-results/screenshots/place_reflections/ (gitignored).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import * as THREE from 'three';
import { openStagedPage, stagedChrome, type StagedPage } from './helpers/staged-build-chrome';
import { rewriteGlbJson, writeFixtureGlb, type FixtureMesh } from './helpers/mesh-glb-fixtures';
import { REPO_ROOT } from './helpers/requirements';
import { classifyAtmosphere, type AtmosphereInput } from '../src/browser/generative-canvas/primitives/scene3d/syncAtmosphere';
import { createFallbackSkyTexture, fallbackSkyScale, PLACE_REFLECTION_FALLBACK_SOURCE } from '../src/browser/generative-canvas/primitives/scene3d/reflectionProbe';

const SHOTS = path.join(REPO_ROOT, 'test-results', 'screenshots', 'place_reflections');
const STEP = 16;
const HERO = 'hero-chrome-sphere';
const PLACE = 'place-street';

type V3 = [number, number, number];

/** Quads with flat normals and one colour each. */
class Quads {
    positions: number[] = []; normals: number[] = []; colors: number[] = []; indices: number[] = [];
    quad(a: V3, b: V3, c: V3, d: V3, rgb: V3): void {
        const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
        const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        const l = Math.hypot(n[0], n[1], n[2]) || 1;
        const base = this.positions.length / 3;
        for (const p of [a, b, c, d]) { this.positions.push(...p); this.normals.push(n[0] / l, n[1] / l, n[2] / l); this.colors.push(...rgb, 1); }
        this.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    box([x0, y0, z0]: V3, [x1, y1, z1]: V3, rgb: V3): void {
        this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], rgb);
        this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], rgb);
        this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], rgb);
        this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], rgb);
        this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], rgb);
    }
    mesh(): FixtureMesh { return { positions: this.positions, normals: this.normals, colors: this.colors, indices: this.indices }; }
}

/** The place: a grey street, a red wall behind the object, a green building to its right (+x). */
function placeMesh(): FixtureMesh {
    const q = new Quads();
    q.quad([-60, 0, 60], [60, 0, 60], [60, 0, -60], [-60, 0, -60], [0.32, 0.32, 0.32]);
    q.box([-14, 0, -10], [14, 9, -8], [0.75, 0.08, 0.06]);
    q.box([4.5, 0, -5], [9, 12, 7], [0.06, 0.62, 0.12]);
    return q.mesh();
}

/** A UV sphere of radius 1 resting on y = 0. */
function sphereMesh(seg = 64): FixtureMesh {
    const positions: number[] = [], normals: number[] = [], indices: number[] = [];
    for (let j = 0; j <= seg; j++) {
        const th = (j / seg) * Math.PI;
        for (let i = 0; i <= seg; i++) {
            const ph = (i / seg) * Math.PI * 2;
            const n = [Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)];
            positions.push(n[0], n[1] + 1, n[2]);
            normals.push(...n);
        }
    }
    for (let j = 0; j < seg; j++) for (let i = 0; i < seg; i++) {
        const a = j * (seg + 1) + i, b = a + seg + 1;
        indices.push(a, a + 1, b, a + 1, b + 1, b);
    }
    return { positions, normals, indices };
}

function glbs(): { place: Buffer; hero: Buffer } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-place-refl-'));
    const placeFile = writeFixtureGlb(path.join(dir, 'place.glb'), placeMesh());
    const heroFile = writeFixtureGlb(path.join(dir, 'hero.glb'), sphereMesh());
    rewriteGlbJson(heroFile, g => {
        g.materials = [{ name: 'polished chrome', pbrMetallicRoughness: { baseColorFactor: [0.95, 0.95, 0.95, 1], metallicFactor: 1, roughnessFactor: 0.06 } }];
        g.meshes[0].primitives[0].material = 0;
    });
    const out = { place: fs.readFileSync(placeFile), hero: fs.readFileSync(heroFile) };
    fs.rmSync(dir, { recursive: true, force: true });
    return out;
}

function sceneData(opts: { renderMode: 'pbr' | 'clay'; geo: boolean }): Record<string, unknown> {
    return {
        title: 'chrome sphere at a place',
        renderMode: opts.renderMode,
        cameraMode: 'orbit',
        environment: { skybox: 'studio', lighting: 'studio', ground: false },
        groundTileMode: 'photoreal-clay',
        camera: { position: [0, 1.5, 4.2], target: [0, 1, 0] },
        objects: [
            { id: PLACE, content: { type: '3d-model', durableUri: `/models/${PLACE}.glb`, mimeType: 'model/gltf-binary', metadata: { role: 'environment', source: 'google3dtilesclay', isGround: true } }, space: { spatial3d: { x: 0, y: 0, z: 0 } } },
            { id: HERO, content: { type: '3d-model', durableUri: `/models/${HERO}.glb`, mimeType: 'model/gltf-binary', metadata: { role: 'hero', description: 'chrome sphere' } }, space: { spatial3d: { x: 0, y: 0, z: 0 } } }
        ],
        ...(opts.geo ? { geoAnchor: { lat: 40.7216, lng: -73.9997, elevation: 10 } } : {})
    };
}

/** The sphere's pixels (inside 0.92 of its projected radius) and the rest of the frame, split into halves and bands. */
const SPHERE_STATS = `(() => {
    const stack = window.__SB_3D_STACK__;
    const hero = window.__SB_3D_EXTERNAL_OBJECTS__.get(${JSON.stringify(HERO)});
    const T = window.__SB_THREE__;
    const box = new T.Box3().setFromObject(hero);
    const c = box.getCenter(new T.Vector3());
    const r = box.getSize(new T.Vector3()).x / 2;
    const cam = stack.camera;
    const gl = stack.renderer.getContext();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const p = c.clone().project(cam);
    const right = new T.Vector3().setFromMatrixColumn(cam.matrixWorld, 0).multiplyScalar(r);
    const pe = c.clone().add(right).project(cam);
    const cx = (p.x + 1) / 2 * w, cy = (p.y + 1) / 2 * h, rad = Math.abs(pe.x - p.x) / 2 * w;
    const d = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, d);
    let n = 0, lum = 0, green = 0, greenRight = 0, top = 0, topBlue = 0, sr = 0, sg = 0, sb = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
        if (dx * dx + dy * dy > (rad * 0.92) ** 2) continue;
        const o = (y * w + x) * 4, R = d[o], G = d[o + 1], B = d[o + 2];
        n++; lum += 0.2126 * R + 0.7152 * G + 0.0722 * B; sr += R; sg += G; sb += B;
        if (G > R + 25 && G > B + 25) { green++; if (dx > 0) greenRight++; }
        if (dy > rad * 0.45) { top++; if (B > R + 6) topBlue++; }
    }
    return { cx, cy, rad, n, meanLum: lum / Math.max(1, n), mean: [sr / n, sg / n, sb / n], green, greenRight, top, topBlue };
})()`;

type SphereStats = { cx: number; cy: number; rad: number; n: number; meanLum: number; mean: number[]; green: number; greenRight: number; top: number; topBlue: number };

/** Pixels outside the sphere (beyond 1.15 of its projected radius) that differ between two kept frames. */
const OUTSIDE_DIFF = (a: string, b: string, s: SphereStats) => `(() => {
    const A = window.__sbKept[${JSON.stringify(a)}], B = window.__sbKept[${JSON.stringify(b)}];
    const gl = window.__SB_3D_STACK__.renderer.getContext();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    let differing = 0, max = 0, total = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const dx = x + 0.5 - ${s.cx}, dy = y + 0.5 - ${s.cy};
        if (dx * dx + dy * dy <= (${s.rad} * 1.15) ** 2) continue;
        const o = (y * w + x) * 4; total++;
        const dd = Math.max(Math.abs(A[o] - B[o]), Math.abs(A[o + 1] - B[o + 1]), Math.abs(A[o + 2] - B[o + 2]));
        if (dd > max) max = dd;
        if (dd > 2) differing++;
    }
    return { differing, max, total };
})()`;
const KEEP = (name: string) => `(() => { const gl = window.__SB_3D_STACK__.renderer.getContext(); const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight; const d = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, d); window.__sbKept = window.__sbKept || {}; window.__sbKept[${JSON.stringify(name)}] = d; sbHarness.keepFrame(${JSON.stringify(name)}); return d.length; })()`;

describe('place reflections: classification and the fallback sky (no WebGL)', () => {
    const base: AtmosphereInput = { skybox: 'studio', lighting: 'studio', worldBranch: 'procedural/object-from-reference', renderMode: 'pbr', hasGeoCoordinates: false, has3DTiles: false };
    test('on at real places outside clay; off in studios and in clay', () => {
        expect(classifyAtmosphere(base).placeReflections).toBe(false);
        expect(classifyAtmosphere({ ...base, hasGeoCoordinates: true }).placeReflections).toBe(true);
        expect(classifyAtmosphere({ ...base, has3DTiles: true }).placeReflections).toBe(true);
        expect(classifyAtmosphere({ ...base, has3DTiles: true, atmosphericScattering: { enabled: true } }).placeReflections).toBe(true);
        expect(classifyAtmosphere({ ...base, has3DTiles: true, renderMode: 'clay' }).placeReflections).toBe(false);
        // the studio room stays off at places, as before
        expect(classifyAtmosphere({ ...base, hasGeoCoordinates: true }).studioReflections).toBe(false);
    });
    test('the fallback sky is labelled, blue above, bright at the horizon, dark below, and scaled to the scene lights', () => {
        const tex = createFallbackSkyTexture(1);
        expect(tex.name).toBe(PLACE_REFLECTION_FALLBACK_SOURCE);
        expect(tex.userData.sbProvenance).toBe(PLACE_REFLECTION_FALLBACK_SOURCE);
        const d = tex.image.data as Float32Array, W = tex.image.width, H = tex.image.height;
        const row = (j: number) => [d[j * W * 4], d[j * W * 4 + 1], d[j * W * 4 + 2]];
        const zenith = row(H - 1), horizon = row(H / 2), nadir = row(0);
        expect(zenith[2]).toBeGreaterThan(zenith[0] + 0.3);
        expect(horizon[0]).toBeGreaterThan(zenith[0]);
        expect(nadir[0] + nadir[1] + nadir[2]).toBeLessThan((horizon[0] + horizon[1] + horizon[2]) / 3);
        tex.dispose();
        const scene = new THREE.Scene();
        expect(fallbackSkyScale(scene)).toBe(0.25);
        scene.add(new THREE.DirectionalLight(0xffffff, Math.PI), new THREE.AmbientLight(0xffffff, 0.5));
        expect(fallbackSkyScale(scene)).toBeCloseTo(1.5, 5);
    });
});

describe.skipIf(!stagedChrome.ok)('place reflections in the real viewport (headless Chrome)', () => {
    let page: StagedPage;
    beforeAll(async () => {
        const g = glbs();
        page = await openStagedPage({ manualFrames: true, shotDir: SHOTS, width: 1000, height: 700 });
        page.serve(`${PLACE}.glb`, g.place);
        page.serve(`${HERO}.glb`, g.hero);
    }, 180_000);
    afterAll(async () => { await page?.close(); });

    async function mount(data: Record<string, unknown>, optOut: boolean): Promise<void> {
        await page.eval(`(() => { ${optOut ? "localStorage.setItem('sb.placeReflections', '0')" : "localStorage.removeItem('sb.placeReflections')"}; sbHarness.mount(${JSON.stringify(data)}); })()`);
        await page.waitFor('sbHarness.ready()');
        for (const id of [PLACE, HERO]) await page.waitFor(`sbHarness.attached(${JSON.stringify(id)})`, 30_000, `${id} attached`);
        await page.step(4, STEP);
        await page.eval(`sbHarness.setCameraView([0, 1, 0], { theta: 0, phi: 1.47, distance: 4.2 })`);
        // past the settle time and the minimum interval, so the probe has been rendered once the change held still
        await page.step(90, STEP);
    }
    const stats = () => page.eval<{ active: boolean; probes: number; captures: number; lastCaptureMs: number; textureBytes: number }>('window.__SB_PLACE_REFLECTIONS__.stats()');
    const heroEnv = () => page.eval<{ envMap: string | null; intensity: number; clay: boolean }>(`(() => { let out = null; window.__SB_3D_EXTERNAL_OBJECTS__.get(${JSON.stringify(HERO)}).traverse(o => { if (o.isMesh && !out) out = { envMap: o.material.envMap ? o.material.envMap.name : null, intensity: o.material.envMapIntensity, clay: !!o.material.userData.sbClay }; }); return out; })()`);
    const backgroundName = () => page.eval<string>(`(() => { const b = window.__SB_3D_STACK__.scene.background; return b ? (b.isColor ? 'color:' + b.getHexString() : 'texture:' + (b.name || '')) : 'none'; })()`);

    test('metal at a place reflects the place (green building on its side, sky above); the place itself is unchanged', async () => {
        await mount(sceneData({ renderMode: 'pbr', geo: true }), true);
        expect((await stats()).active).toBe(false);
        expect((await heroEnv()).envMap).toBeNull();
        const off = await page.eval<SphereStats>(SPHERE_STATS);
        await page.eval(KEEP('pbr_off'));
        await page.screenshot('place_reflections_1_chrome_without_probe');

        await mount(sceneData({ renderMode: 'pbr', geo: true }), false);
        const s = await stats();
        expect(s.active).toBe(true);
        expect(s.probes).toBe(1);
        expect(s.captures).toBeGreaterThanOrEqual(1);
        expect(await heroEnv()).toEqual({ envMap: 'sb-place-reflection-probe', intensity: 1, clay: false });
        // never a background: the scene keeps its own colour
        expect(await backgroundName()).toMatch(/^color:/);
        const on = await page.eval<SphereStats>(SPHERE_STATS);
        await page.eval(KEEP('pbr_on'));
        await page.screenshot('place_reflections_2_chrome_with_probe');

        expect(on.n).toBeGreaterThan(5000);
        expect(Math.abs(on.n - off.n)).toBeLessThan(on.n * 0.02);
        // without the probe the polished metal is near black; with it, it carries the place
        expect(off.meanLum).toBeLessThan(45);
        expect(on.meanLum).toBeGreaterThan(off.meanLum * 1.8);
        // the green building stands at +x: its reflection is on the sphere's right side
        expect(off.green).toBeLessThan(50);
        expect(on.green).toBeGreaterThan(400);
        expect(on.greenRight / on.green).toBeGreaterThan(0.9);
        // the upper band reflects the fallback sky (blue over red)
        expect(on.topBlue / Math.max(1, on.top)).toBeGreaterThan(0.6);
        // nothing but the sphere changed: the street and buildings keep exactly their light
        const outside = await page.eval<{ differing: number; max: number; total: number }>(OUTSIDE_DIFF('pbr_off', 'pbr_on', on));
        expect(outside.differing).toBe(0);
        expect(page.consoleErrors()).toEqual([]);
    }, 180_000);

    test('re-rendered when the object moves, not every frame', async () => {
        const before = (await stats()).captures;
        await page.step(150, STEP);
        expect((await stats()).captures).toBe(before);
        await page.eval(`(() => { const h = window.__SB_3D_EXTERNAL_OBJECTS__.get(${JSON.stringify(HERO)}); h.position.x -= 2.5; h.updateMatrixWorld(true); })()`);
        await page.step(10, STEP);
        expect((await stats()).captures, 'not while the change is settling').toBe(before);
        await page.step(80, STEP);
        expect((await stats()).captures).toBe(before + 1);
        await page.step(150, STEP);
        expect((await stats()).captures).toBe(before + 1);
    }, 120_000);

    test('clay at a place and studio scenes are pixel-identical with and without the probe', async () => {
        for (const [name, data] of [['clay_place', sceneData({ renderMode: 'clay', geo: true })], ['pbr_studio', sceneData({ renderMode: 'pbr', geo: false })]] as const) {
            await mount(data, true);
            await page.eval(KEEP(`${name}_off`));
            await mount(data, false);
            const s = await stats();
            expect(s.active, name).toBe(false);
            expect(s.probes, name).toBe(0);
            const env = await heroEnv();
            expect(env.envMap, name).toBeNull();
            if (name === 'clay_place') expect(env.clay).toBe(true);
            await page.eval(KEEP(`${name}_on`));
            await page.screenshot(`place_reflections_3_${name}`);
            const diff = await page.eval<{ differing: number; max: number }>(`sbHarness.frameDiff(${JSON.stringify(`${name}_off`)}, ${JSON.stringify(`${name}_on`)}, 0)`);
            expect(diff.differing, name).toBe(0);
        }
        // the clay toggle at a place takes the probe off and back on
        await mount(sceneData({ renderMode: 'pbr', geo: true }), false);
        expect((await heroEnv()).envMap).toBe('sb-place-reflection-probe');
        await page.eval(`sbHarness.update(${JSON.stringify(sceneData({ renderMode: 'clay', geo: true }))})`);
        await page.step(6, STEP);
        expect((await stats()).active).toBe(false);
        await page.eval(`sbHarness.update(${JSON.stringify(sceneData({ renderMode: 'pbr', geo: true }))})`);
        await page.step(90, STEP);
        expect((await stats()).probes).toBe(1);
        expect(await heroEnv()).toEqual({ envMap: 'sb-place-reflection-probe', intensity: 1, clay: false });
        expect(page.consoleErrors()).toEqual([]);
    }, 240_000);
});
