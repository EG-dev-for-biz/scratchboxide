/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K's street band (pipeline-k/street-band.ts). A twin with one rebuilt facade, a 20 x 30 m wall at z = 0 whose
 * tile photo is an aperiodic pattern at 15 cm a texel, and a Street View photo rendered from a registered pose 18 m in
 * front of it at about 50 px/m, darker than the tile photo. The wall is cut at 12 m: the band below gets its own primitive
 * and a 6x finer base colour that follows the fine pattern far better than the tile photo did, matched to the tile photo's
 * exposure and joined to it at the top; the part above keeps the facade's photo. The labels name the pano and its date.
 * A photo whose pose is off by 3 m is refused by its structure, one with a nominal pose is never used, the texels a bus
 * hides come from the photo's obstruction-free copy (generated), and a second run reads the band back from the store
 * with no image asked.
 */

import { describe, expect, it } from 'vitest';
import { BUILD_STEPS, TOGGLEABLE_STEPS } from '../src/common/staged-build-steps';
import { compactGlb, cutAtHeight, STREET_BAND_EXTRA_MS, streetBandAsked, textureStreetBand, type StreetBandView } from '../src/node/3d-engine/staged-location/pipeline-k/street-band';
import { memoryReadingStore } from '../src/node/3d-engine/staged-location/pipeline-k/model-readings';
import { assembleGlb, parseGlbBytes, readAccessor } from '../src/node/3d-engine/staged-location/glb-bytes';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';
import { decodeImageInMemory } from '../src/node/3d-engine/staged-location/tile-texture-transfer';
import { resolveToolTimeBudget } from '../src/node/gemini/tool-time-budgets';

const WALL_W = 20, WALL_H = 30, TILE_M = 0.15;

/** Value noise (bilinear between hashed nodes) on a 0.5 m lattice and, finer than the tile photo resolves, a 0.08 m one: structure at every shift, no repeat. */
function pattern(x: number, y: number): [number, number, number] {
    const noise = (cell: number, seed: number) => {
        const h = (i: number, j: number) => { const s = Math.sin(i * 127.1 + j * 311.7 + seed) * 43758.5453; return s - Math.floor(s); };
        const fx = x / cell, fy = y / cell, i = Math.floor(fx), j = Math.floor(fy), a = fx - i, b = fy - j;
        return (h(i, j) * (1 - a) + h(i + 1, j) * a) * (1 - b) + (h(i, j + 1) * (1 - a) + h(i + 1, j + 1) * a) * b;
    };
    const v = 0.6 * noise(0.5, 0) + 0.4 * noise(0.08, 17.3);
    return [60 + 150 * v, 50 + 130 * v, 40 + 110 * v];
}

/** The tile photo: the pattern box-averaged over 15 cm texels (u along x, v down from the top). */
function tilePhoto(): { W: number; H: number; png: Buffer } {
    const W = Math.round(WALL_W / TILE_M), H = Math.round(WALL_H / TILE_M), rgba = new Uint8Array(W * H * 4);
    for (let py = 0; py < H; py++) for (let px = 0; px < W; px++) {
        const acc = [0, 0, 0];
        for (let sy = 0; sy < 3; sy++) for (let sx = 0; sx < 3; sx++) { const p = pattern((px + (sx + 0.5) / 3) * TILE_M, WALL_H - (py + (sy + 0.5) / 3) * TILE_M); for (let c = 0; c < 3; c++) acc[c] += p[c] / 9; }
        rgba.set([...acc.map(Math.round), 255], (py * W + px) * 4);
    }
    return { W, H, png: encodePng(W, H, rgba, 4) };
}

/** A twin with one rebuilt facade (FacadeLattice_7) over the whole wall, two triangles, textured with the tile photo. */
function twin(): Buffer {
    const json: any = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [], meshes: [], accessors: [], bufferViews: [], buffers: [{}], materials: [], textures: [], images: [], samplers: [{ magFilter: 9729, minFilter: 9987 }] };
    const chunks: Uint8Array[] = [];
    let len = 0;
    const view = (b: Uint8Array, target?: number) => { const pad = (4 - (len % 4)) % 4; if (pad) { chunks.push(new Uint8Array(pad)); len += pad; } json.bufferViews.push({ buffer: 0, byteOffset: len, byteLength: b.byteLength, ...(target ? { target } : {}) }); chunks.push(b); len += b.byteLength; return json.bufferViews.length - 1; };
    const f32 = (a: number[]) => new Uint8Array(Float32Array.from(a).buffer), u32 = (a: number[]) => new Uint8Array(Uint32Array.from(a).buffer);
    json.accessors.push({ bufferView: view(f32([0, 0, 0, WALL_W, 0, 0, WALL_W, WALL_H, 0, 0, WALL_H, 0]), 34962), componentType: 5126, count: 4, type: 'VEC3', min: [0, 0, 0], max: [WALL_W, WALL_H, 0] });
    json.accessors.push({ bufferView: view(f32([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), 34962), componentType: 5126, count: 4, type: 'VEC3' });
    json.accessors.push({ bufferView: view(f32([0, 1, 1, 1, 1, 0, 0, 0]), 34962), componentType: 5126, count: 4, type: 'VEC2' });
    json.accessors.push({ bufferView: view(u32([0, 1, 2, 0, 2, 3]), 34963), componentType: 5125, count: 6, type: 'SCALAR' });
    json.images.push({ bufferView: view(tilePhoto().png), mimeType: 'image/png' });
    json.textures.push({ source: 0, sampler: 0 });
    json.materials.push({ name: 'FacadeLattice_7', pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0 } });
    json.meshes.push({ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0, mode: 4 }] });
    json.nodes.push({ name: 'FacadeLattice_7', mesh: 0, extras: { sbFacadeLattice: { facadeId: 7 } } });
    const bin = new Uint8Array(len);
    let o = 0;
    for (const c of chunks) { bin.set(c, o); o += c.length; }
    json.buffers = [{ byteLength: len }];
    return assembleGlb(json, bin);
}

/**
 * A Street View photo of the wall from (ex, 2.5, 18) looking along -z (1600 x 1200, fx 900), the wall at `exposure` of the
 * pattern and sky elsewhere; `claimedEx` is where the pose says the camera stood. A bus (a red box over x 4..10, y 0..3)
 * hides the wall when `bus`: its pixels are not the structure's, and the obstruction-free copy shows the wall there.
 */
function photo(ex: number, opts: { claimedEx?: number; exposure?: number; bus?: boolean; method?: string; date?: string; panoId?: string } = {}): StreetBandView {
    const W = 1600, H = 1200, fx = 900, eye: [number, number, number] = [ex, 2.5, 18], exposure = opts.exposure ?? 0.8;
    const rgba = new Uint8Array(W * H * 4), owner = new Uint8Array(W * H), clean = new Uint8Array(W * H * 4), filled = new Uint8Array(W * H);
    for (let py = 0; py < H; py++) for (let px = 0; px < W; px++) {
        const x = eye[0] + ((px + 0.5 - W / 2) / fx) * 18, y = eye[1] - ((py + 0.5 - H / 2) / fx) * 18, i = py * W + px;
        const onWall = x >= 0 && x <= WALL_W && y >= 0 && y <= WALL_H;
        const wall = pattern(x, y).map(v => Math.round(255 * Math.pow(Math.pow(v / 255, 2.2) * exposure, 1 / 2.2)));
        const hidden = !!opts.bus && x >= 4 && x <= 10 && y >= 0 && y <= 3;
        rgba.set(onWall ? (hidden ? [200, 20, 20, 255] : [...wall, 255]) : [150, 190, 230, 255], i * 4);
        clean.set(onWall ? [...wall, 255] : [150, 190, 230, 255], i * 4);
        owner[i] = onWall && !hidden ? 1 : 0;
        filled[i] = hidden ? 1 : 0;
    }
    const camEye: [number, number, number] = [opts.claimedEx ?? ex, 2.5, 18];
    return {
        panoId: opts.panoId ?? `pano_${ex}`, camera: { eye: camEye, right: [1, 0, 0], up: [0, 1, 0], fwd: [0, 0, -1], fx, fy: fx, cx: W / 2, cy: H / 2, width: W, height: H },
        image: { width: W, height: H, rgba } as never, poseQuality: 1, poseSigmaPx: 1, ownerMask: owner, captureDate: opts.date ?? '2024-05',
        registration: { method: opts.method ?? 'joint', residualM: 0.3 },
        ...(opts.bus ? { cleanImage: { width: W, height: H, rgba: clean } as never, cleanFilledMask: filled } : {})
    };
}

/** The band primitive's base colour and its texel at a point of the wall (x, y). */
function bandOf(glb: Buffer) {
    const g = parseGlbBytes(glb), json = g.json, node = json.nodes.find((n: any) => n.name === 'FacadeLattice_7'), prims = json.meshes[node.mesh].primitives;
    const entry = node.extras.sbStreetBand?.[0];
    const prim = entry ? prims[entry.primitive] : undefined;
    const img = (tex: number) => { const bv = json.bufferViews[json.images[json.textures[tex].source].bufferView]; return decodeImageInMemory(g.bin.subarray(bv.byteOffset, bv.byteOffset + bv.byteLength)); };
    const mat = prim ? json.materials[prim.material] : undefined;
    return { g, json, node, prims, entry, prim, mat, base: mat ? img(mat.pbrMetallicRoughness.baseColorTexture.index) : undefined, labels: entry ? img(entry.sourceTexture) : undefined };
}

/** Mean absolute difference (8-bit, over the channels) between an image's texels and the fine pattern, over wall rows y0..y1 (m). */
function errorAgainstPattern(img: { width: number; height: number; rgba: Uint8Array }, uvRect: number[], y0: number, y1: number, exposure = 1): number {
    let s = 0, n = 0;
    for (let py = 0; py < img.height; py += 3) for (let px = 0; px < img.width; px += 3) {
        const u = uvRect[0] + ((px + 0.5) / img.width) * (uvRect[2] - uvRect[0]), v = uvRect[1] + ((py + 0.5) / img.height) * (uvRect[3] - uvRect[1]);
        const x = u * WALL_W, y = (1 - v) * WALL_H;
        if (y < y0 || y > y1 || x < 1 || x > WALL_W - 1) continue;
        const p = pattern(x, y).map(q => 255 * Math.pow(Math.pow(q / 255, 2.2) * exposure, 1 / 2.2));
        for (let c = 0; c < 3; c++) s += Math.abs(img.rgba[(py * img.width + px) * 4 + c] - p[c]);
        n += 3;
    }
    return s / n;
}

describe('street band: the cut', () => {
    it('splits triangles at the height exactly, keeping the area on each side', () => {
        const attrs = [{ name: 'POSITION', comps: 3, data: [0, 0, 0, 20, 0, 0, 20, 30, 0, 0, 30, 0] }, { name: 'TEXCOORD_0', comps: 2, data: [0, 1, 1, 1, 1, 0, 0, 0] }];
        const cut = cutAtHeight(attrs, 4, [0, 1, 2, 0, 2, 3], 12);
        const pos = cut.attrs[0].data, uv = cut.attrs[1].data;
        const area = (t: number[]) => { let a = 0; for (let k = 0; k < t.length; k += 3) { const [i, j, l] = [t[k], t[k + 1], t[k + 2]]; a += 0.5 * Math.abs((pos[j * 3] - pos[i * 3]) * (pos[l * 3 + 1] - pos[i * 3 + 1]) - (pos[l * 3] - pos[i * 3]) * (pos[j * 3 + 1] - pos[i * 3 + 1])); } return a; };
        expect(area(cut.band)).toBeCloseTo(20 * 12, 6);
        expect(area(cut.above)).toBeCloseTo(20 * 18, 6);
        for (const i of cut.band) expect(pos[i * 3 + 1]).toBeLessThanOrEqual(12 + 1e-9);
        for (const i of cut.above) expect(pos[i * 3 + 1]).toBeGreaterThanOrEqual(12 - 1e-9);
        // every cut vertex's UV is interpolated with its position (v = 1 - y / 30)
        for (let i = 4; i < cut.count; i++) expect(uv[i * 2 + 1]).toBeCloseTo(1 - pos[i * 3 + 1] / 30, 9);
    });
});

describe('street band: a facade textured from a registered photo', () => {
    it('cuts the band into a finer primitive whose texels follow the photo, matched to the tile photo and labelled', async () => {
        const store = memoryReadingStore();
        let asked = 0;
        const views = [photo(10, { panoId: 'good', date: '2024-05' }), photo(7, { claimedEx: 4, panoId: 'off3m' }), photo(12, { method: 'nominal', panoId: 'nominal' })];
        const { glb, report } = await textureStreetBand(twin(), { groundY: 0, panoSet: ['good', 'off3m', 'nominal'], views: async () => { asked++; return views; }, store });
        expect(asked).toBe(1);
        expect(report.banded).toBe(1);
        const b = bandOf(glb);
        // the wall's original primitive now holds only what is above 12 m; the band is a second primitive
        expect(b.prims.length).toBe(2);
        const above = b.prims.find((p: any) => p !== b.prim);
        const ys = readAccessor(b.g, above.attributes.POSITION).data, ia = readAccessor(b.g, above.indices).data;
        for (const i of ia) expect(ys[i * 3 + 1]).toBeGreaterThanOrEqual(12 - 1e-4);
        const ib = readAccessor(b.g, b.prim.indices).data;
        for (const i of ib) expect(ys[i * 3 + 1]).toBeLessThanOrEqual(12 + 1e-4);
        // 6x finer than the tile photo (15 cm / 2.5 cm), over the band's rows of the photo
        expect(b.entry.size[0]).toBe(Math.round(WALL_W / TILE_M) * 6 + 0);
        expect(b.base!.width).toBe(b.entry.size[0]);
        // the good photo gives most of the band; the photo whose pose is 3 m off is refused by its structure; the nominal one never used
        expect(report.photoShare).toBeGreaterThan(0.85);
        expect(b.entry.panos.map((p: any) => p.panoId)).toEqual(['good']);
        expect(b.entry.panos[0].date).toBe('2024-05');
        expect(b.entry.captured).toBe('2024-05');
        expect(b.entry.refused.map((r: any) => r.panoId).sort()).toEqual(['nominal', 'off3m']);
        expect(b.entry.refused.find((r: any) => r.panoId === 'off3m').why).toMatch(/correlates|limit/);
        // exposure matched: the band follows the fine pattern at the tile photo's exposure, far closer than the tile photo itself
        const tileErr = (() => { const g = parseGlbBytes(twin()); const bv = g.json.bufferViews[g.json.images[0].bufferView]; const t = decodeImageInMemory(g.bin.subarray(bv.byteOffset, bv.byteOffset + bv.byteLength)); return errorAgainstPattern(t, [0, 0, 1, 1], 1, 8); })();
        const bandErr = errorAgainstPattern(b.base!, b.entry.uvRect, 1, 8);
        expect(bandErr).toBeLessThan(tileErr * 0.6);
        // the labels: pano 1, one photo, over the band's middle
        const L = b.labels!, mid = (Math.floor(L.height * 0.7) * L.width + Math.floor(L.width / 2)) * 4;
        expect([L.rgba[mid], L.rgba[mid + 1]]).toEqual([1, 1]);
        expect(b.entry.label).toBe('photo-inferred');
        // the top of the band is the tile photo itself (faded over 0.5 m), so no seam with the part above
        const top = b.base!, row0 = 1;
        let d = 0;
        const tileImg = (() => { const g = parseGlbBytes(twin()); const bv = g.json.bufferViews[g.json.images[0].bufferView]; return decodeImageInMemory(g.bin.subarray(bv.byteOffset, bv.byteOffset + bv.byteLength)); })();
        const py0 = Math.round(b.entry.uvRect[1] * tileImg.height);
        for (let x = 30; x < top.width - 30; x += 7) {
            const tx = Math.floor(x / 6), ty = py0 + Math.floor(row0 / 6);
            d += Math.abs(top.rgba[(row0 * top.width + x) * 4] - tileImg.rgba[(ty * tileImg.width + tx) * 4]);
        }
        expect(d / Math.floor((top.width - 60) / 7)).toBeLessThan(25);
        // a second run: the band read back from the store, no image asked
        const again = await textureStreetBand(twin(), { groundY: 0, panoSet: ['good', 'off3m', 'nominal'], views: async () => { asked++; return views; }, store });
        expect(asked).toBe(1);
        expect(again.report.stored).toBe(1);
        expect(again.report.photoShare).toBeCloseTo(report.photoShare, 6);
    }, 60_000);

    it('fills what a bus hides from the photo\'s obstruction-free copy, labelled generated', async () => {
        const { glb, report } = await textureStreetBand(twin(), { groundY: 0, panoSet: ['bus'], views: async () => [photo(10, { panoId: 'bus', bus: true })] });
        expect(report.cleanShare).toBeGreaterThan(0.05);
        const b = bandOf(glb), L = b.labels!;
        // a texel behind the bus (x 7 m, y 1.5 m): kind 3
        const px = Math.floor(((7 / WALL_W - b.entry.uvRect[0]) / (b.entry.uvRect[2] - b.entry.uvRect[0])) * L.width), py = Math.floor(((1 - 1.5 / WALL_H - b.entry.uvRect[1]) / (b.entry.uvRect[3] - b.entry.uvRect[1])) * L.height);
        expect(L.rgba[(py * L.width + px) * 4 + 1]).toBe(3);
        expect(b.entry.shares.generated).toBeGreaterThan(0);
    }, 60_000);

    it('leaves the twin unchanged when no photo is refined, and says why', async () => {
        const src = twin();
        const { glb, report } = await textureStreetBand(src, { groundY: 0, panoSet: [], views: async () => [photo(10, { method: 'nominal' })] });
        expect(report.banded).toBe(0);
        expect(Buffer.compare(glb, src)).toBe(0);
        expect(report.perFacade[0].refused?.[0].why).toMatch(/not refined/);
    }, 60_000);
});

describe('street band: switches and compaction', () => {
    it('is asked by the node graph or SCRATCHBOX_K_STREET_BAND=1, and adds its time to the build\'s', () => {
        const before = process.env.SCRATCHBOX_K_STREET_BAND;
        delete process.env.SCRATCHBOX_K_STREET_BAND;
        expect(streetBandAsked(undefined)).toBe(false);
        expect(streetBandAsked({ 'twin.streetBand': true })).toBe(true);
        process.env.SCRATCHBOX_K_STREET_BAND = '1';
        expect(streetBandAsked(undefined)).toBe(true);
        expect(streetBandAsked({ 'twin.streetBand': false })).toBe(false);
        if (before === undefined) delete process.env.SCRATCHBOX_K_STREET_BAND; else process.env.SCRATCHBOX_K_STREET_BAND = before;
        expect(BUILD_STEPS.find(s => s.key === 'twin.streetBand')?.stage).toBe('textures');
        expect(TOGGLEABLE_STEPS.has('twin.streetBand')).toBe(true);
        const plain = resolveToolTimeBudget('google_3d_tiles_get_clay', { isolate: true }, 5 * 60_000).maxMs;
        expect(resolveToolTimeBudget('google_3d_tiles_get_clay', { isolate: true, steps: { 'twin.streetBand': true } }, 5 * 60_000).maxMs).toBe(plain + STREET_BAND_EXTRA_MS);
    });

    it('drops the accessors and views nothing references', () => {
        const g = parseGlbBytes(twin());
        const before = g.bin.byteLength;
        g.json.meshes[0].primitives[0].attributes = { POSITION: 0, TEXCOORD_0: 2 };
        const out = parseGlbBytes(compactGlb(g.json, g.bin, []));
        expect(out.json.accessors.length).toBe(3);
        expect(out.bin.byteLength).toBe(before - 48);
        expect(readAccessor(out, out.json.meshes[0].primitives[0].attributes.POSITION).data[3]).toBe(WALL_W);
    });
});
