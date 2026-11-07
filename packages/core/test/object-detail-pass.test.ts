/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The per-part detail pass (object-detail-pass.ts over the native scratchbox_object_detail.hpp), on synthetic meshes:
 * - every part keeps its own material: a zero-strength pass returns each material's own colour, roughness and metalness
 *   on every texel, and a weathered one keeps names, extensions, emission and the factors it had (in its extras);
 * - edge wear follows convexity, the same on a 12-triangle box as on a finely tessellated one, and none on a sphere;
 * - grime follows occlusion (a floor against a wall), dust lies on what faces the sky, streaks run under an overhang;
 * - the mesh-measured maps steer it: a knob rounder than the curvature radius wears though it has no sharp edge, cavity
 *   alone puts grime in the crease where two parts meet, and a thin plate is lightened while a thick block is not;
 * - a decal lands on the part it names and on no other, and only on the part's surface that faces it;
 * - SB-Veggie trees are left as they are.
 * Masks are read at points on the surface through the output's own UVs. A before/after render goes to
 * test-results/screenshots/uv_rewrap/object_detail_materials_kept.png.
 */

import { describe, expect, it } from 'vitest';
import { runObjectDetailPass, type ObjectDetailMasks, type ObjectDetailOptions } from '../src/node/3d-engine/object-detail-pass';
import { parseGlbBytes, readAccessor } from '../src/node/3d-engine/staged-location/glb-bytes';
import { decodeImageInMemory } from '../src/node/3d-engine/staged-location/tile-texture-transfer';
import { buildFixtureGlb, icosphereMesh, orbitCamera, renderGlb, saveSideBySide, type FixturePrimitive } from './helpers/uv-rewrap-fixtures';

type V3 = [number, number, number];
const TIMEOUT = 900_000;
const SMALL: Partial<ObjectDetailOptions> = { targetTexels: 512 * 512, imageFormat: 'png', masks: true };
const OFF = { edgeWear: 0, grime: 0, streaks: 0, dust: 0, sunFade: 0, variation: 0, thinLight: 0 };

/** An axis-aligned box, each face split into n x n quads, hard edges (normals per face). */
function box(name: string, size: V3, center: V3, n = 1, material = 0): FixturePrimitive {
    const faces: Array<{ nrm: V3; u: V3; v: V3 }> = [
        { nrm: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] }, { nrm: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
        { nrm: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] }, { nrm: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
        { nrm: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, { nrm: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] }
    ];
    const positions: number[] = [], normals: number[] = [], indices: number[] = [];
    for (const f of faces) {
        const base = positions.length / 3;
        for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
            const su = -1 + (2 * i) / n, sv = -1 + (2 * j) / n;
            for (let c = 0; c < 3; c++) positions.push(center[c] + (size[c] / 2) * (f.nrm[c] + su * f.u[c] + sv * f.v[c]));
            normals.push(...f.nrm);
        }
        for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
            const a = base + j * (n + 1) + i;
            indices.push(a, a + 1, a + n + 2, a, a + n + 2, a + n + 1);
        }
    }
    return { positions, normals, indices, material, name };
}

const material = (name: string, baseColorFactor: number[], roughnessFactor: number, metallicFactor: number, extra: Record<string, unknown> = {}) =>
    ({ name, pbrMetallicRoughness: { baseColorFactor, roughnessFactor, metallicFactor }, ...extra });

interface Tri { part: string; material: number; p: V3[]; uv: Array<[number, number]> }

function trianglesOf(glb: Buffer): Tri[] {
    const g = parseGlbBytes(new Uint8Array(glb));
    const out: Tri[] = [];
    for (const node of g.json.nodes) {
        if (node.mesh === undefined) continue;
        for (const prim of g.json.meshes[node.mesh].primitives) {
            const pos = readAccessor(g, prim.attributes.POSITION).data, uv = readAccessor(g, prim.attributes.TEXCOORD_0).data;
            const idx = readAccessor(g, prim.indices).data;
            for (let k = 0; k < idx.length; k += 3) {
                const c = [idx[k], idx[k + 1], idx[k + 2]];
                out.push({ part: node.name, material: prim.material, p: c.map(v => [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]] as V3), uv: c.map(v => [uv[v * 2], uv[v * 2 + 1]] as [number, number]) });
            }
        }
    }
    return out;
}

/** Barycentrics of q in triangle t when q lies on it (within 0.1 mm of its plane), else undefined. */
function baryOn(t: Tri, q: V3): [number, number, number] | undefined {
    const [a, b, c] = t.p;
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]], d = [q[0] - a[0], q[1] - a[1], q[2] - a[2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const nl = Math.hypot(n[0], n[1], n[2]);
    if (nl < 1e-12 || Math.abs((d[0] * n[0] + d[1] * n[1] + d[2] * n[2]) / nl) > 1e-4) return undefined;
    const dot = (x: number[], y: number[]) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
    const d00 = dot(e1, e1), d01 = dot(e1, e2), d11 = dot(e2, e2), d20 = dot(d, e1), d21 = dot(d, e2);
    const den = d00 * d11 - d01 * d01;
    const v = (d11 * d20 - d01 * d21) / den, w = (d00 * d21 - d01 * d20) / den;
    return v >= -1e-6 && w >= -1e-6 && v + w <= 1 + 1e-6 ? [1 - v - w, v, w] : undefined;
}

/** The masks (0..1) of part `part` at surface point q, through the output's UVs. */
function maskAt(glb: Buffer, masks: ObjectDetailMasks[], part: string, q: V3) {
    for (const t of trianglesOf(glb)) {
        if (t.part !== part) continue;
        const b = baryOn(t, q);
        if (!b) continue;
        const m = masks.find(x => x.material === t.material)!;
        const u = b[0] * t.uv[0][0] + b[1] * t.uv[1][0] + b[2] * t.uv[2][0], v = b[0] * t.uv[0][1] + b[1] * t.uv[1][1] + b[2] * t.uv[2][1];
        const i = (Math.min(m.height - 1, Math.floor(v * m.height)) * m.width + Math.min(m.width - 1, Math.floor(u * m.width))) * 4;
        return { edge: m.wear[i] / 255, grime: m.wear[i + 1] / 255, streak: m.wear[i + 2] / 255, dust: m.wear[i + 3] / 255, exposure: m.light[i] / 255, decal: m.light[i + 1] / 255, cavity: m.light[i + 2] / 255, convexity: m.light[i + 3] / 255,
            curvature: m.maps[i] / 255 * 2 - 1, cavityMap: m.maps[i + 1] / 255, thickness: m.maps[i + 2] / 255, ao: m.maps[i + 3] / 255 };
    }
    throw new Error(`no surface of ${part} at ${q.join(', ')}`);
}

/** The material's maps as written, sampled at surface point q of part `part`. */
function mapsAt(glb: Buffer, part: string, q: V3): { rgb: V3; rough: number; metal: number } {
    const g = parseGlbBytes(new Uint8Array(glb));
    const image = (tex: number) => {
        const bv = g.json.bufferViews[g.json.images[g.json.textures[tex].source].bufferView];
        return decodeImageInMemory(g.bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength));
    };
    for (const t of trianglesOf(glb)) {
        if (t.part !== part) continue;
        const b = baryOn(t, q);
        if (!b) continue;
        const pbr = g.json.materials[t.material].pbrMetallicRoughness;
        const base = image(pbr.baseColorTexture.index), mr = image(pbr.metallicRoughnessTexture.index);
        const u = b[0] * t.uv[0][0] + b[1] * t.uv[1][0] + b[2] * t.uv[2][0], v = b[0] * t.uv[0][1] + b[1] * t.uv[1][1] + b[2] * t.uv[2][1];
        const i = (Math.min(base.height - 1, Math.floor(v * base.height)) * base.width + Math.min(base.width - 1, Math.floor(u * base.width))) * 4;
        return { rgb: [base.rgba[i], base.rgba[i + 1], base.rgba[i + 2]], rough: mr.rgba[i + 1] / 255, metal: mr.rgba[i + 2] / 255 };
    }
    throw new Error(`no surface of ${part} at ${q.join(', ')}`);
}

const srgb8 = (lin: number) => Math.round(255 * (lin <= 0.0031308 ? 12.92 * lin : 1.055 * Math.pow(lin, 1 / 2.4) - 0.055));

describe('object detail pass: every part keeps its own material', () => {
    const scene = () => buildFixtureGlb({
        primitives: [box('body', [0.6, 0.6, 0.6], [0, 0.4, 0], 8, 0), box('plinth', [1, 0.1, 1], [0, 0.05, 0], 8, 1)],
        materials: [
            material('gold_foil', [0.9, 0.55, 0.12, 1], 0.3, 1, { emissiveFactor: [0.02, 0.01, 0], extensions: { KHR_materials_clearcoat: { clearcoatFactor: 0.5 } } }),
            material('white_paint', [0.8, 0.8, 0.78, 1], 0.6, 0)
        ],
        extensionsUsed: ['KHR_materials_clearcoat']
    });

    it('returns each material\'s own colour, roughness and metalness on every texel when every strength is zero', async () => {
        const glb = scene();
        const r = await runObjectDetailPass(glb, { ...SMALL, wear: OFF });
        const out = parseGlbBytes(new Uint8Array(r.glb)).json;
        expect(out.materials.map((m: any) => m.name)).toEqual(['gold_foil', 'white_paint']);
        const want = { body: { rgb: [0.9, 0.55, 0.12], rough: 0.3, metal: 1 }, plinth: { rgb: [0.8, 0.8, 0.78], rough: 0.6, metal: 0 } };
        for (const [part, w] of Object.entries(want)) {
            for (const tri of trianglesOf(r.glb).filter(t => t.part === part).filter((_, k) => k % 7 === 0)) {
                const c: V3 = [0, 1, 2].map(k => (tri.p[0][k] + tri.p[1][k] + tri.p[2][k]) / 3) as V3;
                const got = mapsAt(r.glb, part, c);
                for (let k = 0; k < 3; k++) expect(Math.abs(got.rgb[k] - srgb8(w.rgb[k])), `${part} channel ${k}`).toBeLessThanOrEqual(1);
                expect(Math.abs(got.rough - w.rough)).toBeLessThanOrEqual(1.5 / 255);
                expect(Math.abs(got.metal - w.metal)).toBeLessThanOrEqual(1.5 / 255);
            }
        }
    }, TIMEOUT);

    it('keeps names, extensions, emission and the factors it had when it weathers', async () => {
        const glb = scene();
        const r = await runObjectDetailPass(glb, { ...SMALL, wear: { edgeWear: 1, grime: 1, variation: 0, sunFade: 0 } });
        const out = parseGlbBytes(new Uint8Array(r.glb)).json;
        expect(out.materials).toHaveLength(2);
        const [gold, white] = out.materials;
        expect(gold.name).toBe('gold_foil');
        expect(gold.extensions.KHR_materials_clearcoat.clearcoatFactor).toBe(0.5);
        expect(gold.emissiveFactor).toEqual([0.02, 0.01, 0]);
        expect(gold.pbrMetallicRoughness.baseColorFactor).toEqual([1, 1, 1, 1]);
        expect(gold.extras.sbDetailPass.label).toBe('generated');
        expect(gold.extras.sbDetailPass.before).toMatchObject({ baseColorFactor: [0.9, 0.55, 0.12, 1], roughnessFactor: 0.3, metallicFactor: 1 });
        expect(white.extras.sbDetailPass.before).toMatchObject({ baseColorFactor: [0.8, 0.8, 0.78, 1], roughnessFactor: 0.6, metallicFactor: 0 });
        // separate maps: the two materials never share an image
        expect(gold.pbrMetallicRoughness.baseColorTexture.index).not.toBe(white.pbrMetallicRoughness.baseColorTexture.index);
        expect(out.extras.sbDetailPass.label).toBe('generated');
        // the gold body's face centre is still gold, the plinth's top still white
        const gc = mapsAt(r.glb, 'body', [0.3, 0.4, 0]), wc = mapsAt(r.glb, 'plinth', [0.45, 0.1, 0.45]);
        expect(gc.rgb[0]).toBeGreaterThan(gc.rgb[2] + 80);
        expect(Math.abs(wc.rgb[0] - wc.rgb[2])).toBeLessThan(20);
        expect(gc.metal).toBeGreaterThan(0.7);
        expect(wc.metal).toBeLessThan(0.1);
        expect(r.report.parts.map(p => p.part).sort()).toEqual(['body', 'plinth']);
        const shots = [0, 1].map(k => orbitCamera(glb, 35 + 90 * k, 25, 360));
        saveSideBySide('object_detail_materials_kept', shots.flatMap(cam => [renderGlb(glb, cam, 'lit'), renderGlb(r.glb, cam, 'lit')]));
    }, TIMEOUT);
});

describe('object detail pass: wear follows the geometry', () => {
    it('wears convex edges and not faces, the same however finely the box is tessellated, and not a smooth sphere', async () => {
        const one = (n: number) => buildFixtureGlb({ primitives: [box('box', [1, 1, 1], [0, 0.5, 0], n)], materials: [material('paint', [0.2, 0.3, 0.6, 1], 0.5, 0)] });
        const opts = { ...SMALL, wear: { ...OFF, edgeWear: 1, edgeWidthM: 0.05 } };
        const coarse = await runObjectDetailPass(one(1), opts), fine = await runObjectDetailPass(one(16), opts);
        for (const r of [coarse, fine]) {
            // +x face: 5 mm under the top edge, and 20 cm from every edge
            const near = maskAt(r.glb, r.masks!, 'box', [0.5, 0.995, 0.1]), far = maskAt(r.glb, r.masks!, 'box', [0.5, 0.7, 0.1]);
            expect(near.edge).toBeGreaterThan(0.7);
            expect(near.convexity).toBeGreaterThan(0.85);
            expect(far.edge).toBeLessThan(0.02);
            expect(far.convexity).toBeLessThan(0.02);
        }
        for (const q of [[0.5, 0.99, -0.3], [0.5, 0.97, 0.2], [0.2, 1, 0.48], [-0.49, 0.5, 0.5]] as V3[]) {
            expect(Math.abs(maskAt(coarse.glb, coarse.masks!, 'box', q).convexity - maskAt(fine.glb, fine.masks!, 'box', q).convexity)).toBeLessThan(0.08);
        }
        const sphere = await runObjectDetailPass(buildFixtureGlb({ primitives: [{ ...icosphereMesh(0.5, 4), name: 'ball', material: 0 }], materials: [material('paint', [0.2, 0.3, 0.6, 1], 0.5, 0)] }), { ...SMALL, wear: { ...OFF, edgeWear: 1, edgeWidthM: 0.05 } });
        expect(sphere.report.parts[0].edgeWear).toBeLessThan(0.01);
        expect(coarse.report.parts[0].edgeWear).toBeGreaterThan(0.08);
    }, TIMEOUT);

    it('gathers grime where another part occludes: a floor against a wall', async () => {
        const glb = buildFixtureGlb({
            primitives: [box('floor', [1, 0.05, 1], [0, 0.025, 0], 12, 0), box('wall', [1, 1, 0.05], [0, 0.55, -0.475], 12, 1)],
            materials: [material('floor', [0.6, 0.6, 0.6, 1], 0.7, 0), material('wall', [0.6, 0.6, 0.6, 1], 0.7, 0)]
        });
        const r = await runObjectDetailPass(glb, { ...SMALL, wear: { ...OFF, grime: 1, aoRadiusM: 0.3 } });
        const near = maskAt(r.glb, r.masks!, 'floor', [0.1, 0.05, -0.43]), far = maskAt(r.glb, r.masks!, 'floor', [0.1, 0.05, 0.35]);
        expect(near.cavity).toBeGreaterThan(far.cavity + 0.15);
        expect(near.grime).toBeGreaterThan(far.grime + 0.2);
        // the wall's foot, against the floor, more than its top
        expect(maskAt(r.glb, r.masks!, 'wall', [0.1, 0.1, -0.45]).grime).toBeGreaterThan(maskAt(r.glb, r.masks!, 'wall', [0.1, 0.95, -0.45]).grime + 0.15);
        // and the grime darkens the colour there, not elsewhere
        expect(mapsAt(r.glb, 'floor', [0.1, 0.05, -0.43]).rgb[0]).toBeLessThan(mapsAt(r.glb, 'floor', [0.1, 0.05, 0.35]).rgb[0] - 20);
    }, TIMEOUT);

    it('lays dust on what faces the sky and runs streaks down under an overhang', async () => {
        const glb = buildFixtureGlb({
            primitives: [box('block', [0.5, 0.5, 0.5], [0, 0.25, 0], 10, 0), box('ledge', [0.6, 0.04, 0.2], [0, 0.45, 0.35], 4, 1)],
            materials: [material('stone', [0.5, 0.48, 0.45, 1], 0.8, 0), material('slab', [0.5, 0.48, 0.45, 1], 0.8, 0)]
        });
        const r = await runObjectDetailPass(glb, { ...SMALL, wear: { ...OFF, dust: 1, streaks: 1, streakReachM: 0.3 } });
        expect(maskAt(r.glb, r.masks!, 'block', [0.15, 0.5, -0.15]).dust).toBeGreaterThan(0.4);
        expect(maskAt(r.glb, r.masks!, 'block', [0.25, 0.25, 0]).dust).toBeLessThan(0.02);
        expect(maskAt(r.glb, r.masks!, 'block', [0, 0, 0.1]).dust).toBeLessThan(0.02);
        expect(maskAt(r.glb, r.masks!, 'ledge', [0.1, 0.47, 0.35]).dust).toBeGreaterThan(0.4);
        // the block's +z face 5 cm under the ledge, and the -z face (nothing overhead) at the same height
        expect(maskAt(r.glb, r.masks!, 'block', [0.05, 0.38, 0.25]).streak).toBeGreaterThan(0.25);
        expect(maskAt(r.glb, r.masks!, 'block', [0.05, 0.38, -0.25]).streak).toBeLessThan(0.02);
        // the top under the open sky sees more of it than a side, and the bottom none
        expect(maskAt(r.glb, r.masks!, 'block', [0.15, 0.5, -0.15]).exposure).toBeGreaterThan(maskAt(r.glb, r.masks!, 'block', [0.25, 0.25, -0.1]).exposure + 0.3);
        expect(maskAt(r.glb, r.masks!, 'block', [0, 0, 0.1]).exposure).toBeLessThan(0.02);
    }, TIMEOUT);
});

describe('object detail pass: the mesh-measured maps steer the wear', () => {
    it('wears a knob rounder than the curvature radius, though no edge of it is sharp, and only when curvature is asked to', async () => {
        const glb = buildFixtureGlb({
            primitives: [box('base', [1, 0.2, 1], [0, 0.1, 0], 8, 0), { ...icosphereMesh(0.04, 4), positions: icosphereMesh(0.04, 4).positions.map((v, k) => v + (k % 3 === 1 ? 0.24 : 0)), name: 'knob', material: 1 }],
            materials: [material('base', [0.2, 0.3, 0.6, 1], 0.5, 0), material('knob', [0.2, 0.3, 0.6, 1], 0.5, 0)]
        });
        const wear = { ...OFF, edgeWear: 1, edgeWidthM: 0.004, curvatureRadiusM: 0.05 };
        const on = await runObjectDetailPass(glb, { ...SMALL, wear: { ...wear, curvatureWear: 1 } });
        const off = await runObjectDetailPass(glb, { ...SMALL, wear: { ...wear, curvatureWear: 0 } });
        const knob = (r: typeof on) => r.report.parts.find(p => p.part === 'knob')!;
        expect(maskAt(on.glb, on.masks!, 'knob', [0, 0.28, 0]).curvature).toBeGreaterThan(0.6);
        expect(knob(on).edgeWear).toBeGreaterThan(0.3);
        expect(knob(off).edgeWear).toBeLessThan(0.02);
        // the base's flat top reads flat and stays unworn
        expect(Math.abs(maskAt(on.glb, on.masks!, 'base', [0.3, 0.2, 0.3]).curvature)).toBeLessThan(0.05);
        expect(maskAt(on.glb, on.masks!, 'base', [0.3, 0.2, 0.3]).edge).toBeLessThan(0.02);
        expect(on.report.meshMaps.label).toBe('generated');
    }, TIMEOUT);

    it('puts grime in the crease where two parts meet from cavity alone', async () => {
        const glb = buildFixtureGlb({
            primitives: [box('floor', [1, 0.05, 1], [0, 0.025, 0], 12, 0), box('wall', [1, 1, 0.05], [0, 0.55, -0.475], 12, 1)],
            materials: [material('floor', [0.6, 0.6, 0.6, 1], 0.7, 0), material('wall', [0.6, 0.6, 0.6, 1], 0.7, 0)]
        });
        // occlusion reaches less than the 3 cm from the wall the point stands: what is left is the cavity map
        const wear = { ...OFF, grime: 1, aoRadiusM: 0.005, cavityRadiusM: 0.08 };
        const r = await runObjectDetailPass(glb, { ...SMALL, wear: { ...wear, cavityGrime: 1 } });
        const without = await runObjectDetailPass(glb, { ...SMALL, wear: { ...wear, cavityGrime: 0 } });
        const at = (x: typeof r, z: number) => maskAt(x.glb, x.masks!, 'floor', [0.1, 0.05, z]);
        expect(at(r, -0.42).cavityMap).toBeGreaterThan(0.4);
        expect(at(r, 0.35).cavityMap).toBe(0);
        expect(at(r, -0.42).grime).toBeGreaterThan(at(r, 0.35).grime + 0.3);
        expect(at(without, -0.42).grime).toBeLessThan(at(without, 0.35).grime + 0.15);
    }, TIMEOUT);

    it('lightens a thin plate, light passing through it, and not a thick block of the same colour nor a thin metal sheet', async () => {
        const glb = buildFixtureGlb({
            primitives: [box('plate', [0.6, 0.004, 0.6], [-0.4, 0.3, 0], 6, 0), box('block', [0.4, 0.4, 0.4], [0.4, 0.2, 0], 6, 1), box('sheet', [0.4, 0.004, 0.4], [0.4, 0.6, 0], 6, 2)],
            materials: [material('plate', [0.15, 0.25, 0.1, 1], 0.6, 0), material('block', [0.15, 0.25, 0.1, 1], 0.6, 0), material('sheet', [0.15, 0.25, 0.1, 1], 0.4, 1)]
        });
        const r = await runObjectDetailPass(glb, { ...SMALL, wear: { ...OFF, thinLight: 1, thinM: 0.02 } });
        const plate = maskAt(r.glb, r.masks!, 'plate', [-0.4, 0.302, 0.1]), block = maskAt(r.glb, r.masks!, 'block', [0.4, 0.4, 0.1]);
        expect(plate.thickness).toBeLessThan(0.15);           // 4 mm of a 40 mm cap
        expect(block.thickness).toBeGreaterThan(0.99);
        expect(r.report.parts.find(p => p.part === 'plate')!.thin).toBeGreaterThan(0.9);
        expect(r.report.parts.find(p => p.part === 'block')!.thin).toBeLessThan(0.01);
        const lit = mapsAt(r.glb, 'plate', [-0.4, 0.302, 0.1]).rgb, solid = mapsAt(r.glb, 'block', [0.4, 0.4, 0.1]).rgb;
        expect(lit[1]).toBeGreaterThan(solid[1] + 25);
        expect(Math.abs(solid[1] - srgb8(0.25))).toBeLessThan(3);
        // the metal sheet is as thin as the plate, but no light passes through metal
        expect(maskAt(r.glb, r.masks!, 'sheet', [0.4, 0.602, 0.1]).thickness).toBeLessThan(0.15);
        expect(Math.abs(mapsAt(r.glb, 'sheet', [0.4, 0.602, 0.1]).rgb[1] - srgb8(0.25))).toBeLessThan(3);
    }, TIMEOUT);
});

describe('object detail pass: decals per part', () => {
    it('lands a decal on the part it names, on the surface facing it, and on no other part', async () => {
        const glb = buildFixtureGlb({
            primitives: [box('left', [0.4, 0.4, 0.4], [-0.3, 0.2, 0], 6, 0), box('right', [0.4, 0.4, 0.4], [0.3, 0.2, 0], 6, 1)],
            materials: [material('left', [0.1, 0.5, 0.1, 1], 0.5, 0), material('right', [0.1, 0.1, 0.5, 1], 0.5, 0)]
        });
        const red = { width: 8, height: 8, rgba: new Uint8Array(8 * 8 * 4).map((_, i) => (i % 4 === 0 || i % 4 === 3 ? 255 : 0)) };
        const r = await runObjectDetailPass(glb, {
            ...SMALL, wear: null,
            decals: [{ parts: ['left'], image: red, facing: [0, 0, 1], centerM: [0, 0.2, 0.2], sizeM: [1.2, 0.3], roughness: 0.9, metalness: 0, label: 'generated', method: 'test' }]
        });
        const onLeft = mapsAt(r.glb, 'left', [-0.3, 0.2, 0.2]), onRight = mapsAt(r.glb, 'right', [0.3, 0.2, 0.2]), leftBack = mapsAt(r.glb, 'left', [-0.3, 0.2, -0.2]);
        expect(onLeft.rgb[0]).toBeGreaterThan(240);
        expect(onLeft.rgb[1]).toBeLessThan(15);
        expect(onLeft.rough).toBeGreaterThan(0.85);
        expect(maskAt(r.glb, r.masks!, 'left', [-0.3, 0.2, 0.2]).decal).toBeGreaterThan(0.9);
        expect(maskAt(r.glb, r.masks!, 'right', [0.3, 0.2, 0.2]).decal).toBe(0);
        expect(onRight.rgb).toEqual([srgb8(0.1), srgb8(0.1), srgb8(0.5)]);
        expect(maskAt(r.glb, r.masks!, 'left', [-0.3, 0.2, -0.2]).decal).toBe(0);
        expect(leftBack.rgb).toEqual([srgb8(0.1), srgb8(0.5), srgb8(0.1)]);
        expect(r.report.decals[0].texels).toBeGreaterThan(100);
        await expect(runObjectDetailPass(glb, { ...SMALL, wear: null, decals: [{ parts: ['nose'], image: red, facing: [0, 0, 1], sizeM: [1, 1], label: 'generated', method: 'test' }] }))
            .rejects.toThrow(/no part "nose".*left, right/);
    }, TIMEOUT);
});

describe('object detail pass: what it leaves alone', () => {
    it('leaves an SB-Veggie tree node and its material exactly as they were', async () => {
        const glb = buildFixtureGlb({
            primitives: [box('pot', [0.3, 0.3, 0.3], [0, 0.15, 0], 4, 0), box('sb_veggie_crown_0_lod3', [0.4, 0.4, 0.4], [0, 0.6, 0], 2, 1)],
            materials: [material('clay_pot', [0.6, 0.3, 0.2, 1], 0.8, 0), material('leaves', [0.1, 0.4, 0.1, 1], 0.9, 0)]
        });
        const r = await runObjectDetailPass(glb, SMALL);
        const out = parseGlbBytes(new Uint8Array(r.glb)).json;
        expect(out.materials[1]).toEqual(material('leaves', [0.1, 0.4, 0.1, 1], 0.9, 0));
        expect(out.materials[0].pbrMetallicRoughness.baseColorTexture).toBeDefined();
        expect(r.report.left.some(l => /tree/.test(l.reason))).toBe(true);
        expect(r.report.parts.map(p => p.part)).toEqual(['pot']);
    }, TIMEOUT);
});
