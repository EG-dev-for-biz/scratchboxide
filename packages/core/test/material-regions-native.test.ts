/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K's material regions on the native kernel (pipeline-k/native/material-regions-native.ts over
 * scratchbox_material_regions.hpp): the same classes, pieces and plan as the TypeScript (material-regions.ts), bit for
 * bit, on synthetic facades of stone piers, brown spandrels and glass (some reflecting the sky), and a scan piece; and the
 * TypeScript and native timings at a realistic size (four 2048 x 2048 photos).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { ParsedGlb } from '../src/node/3d-engine/staged-location/glb-bytes';
import type { RgbaImage8 } from '../src/node/3d-engine/staged-location/tile-texture-transfer';
import { SRGB8_TO_LINEAR } from '../src/common/spatial/photogrammetric-delight';
import { linearRgbToLab } from '../src/common/spatial/texture-library-index';
import {
    MATERIAL_REGIONS_PARAMS, materialPlanContext, materialPlanJobs, planMaterialJob, planMaterialRegions, readRegionClasses,
    type MaterialPlanPiece, type MaterialRegionsPlan, type RegionClass, type RegionSet
} from '../src/node/3d-engine/staged-location/pipeline-k/material-regions';
import {
    ensureMaterialRegionsNativeBinary, materialRegionsNativeColourTables, planMaterialJobNative, planMaterialRegionsNative, readRegionClassesNative
} from '../src/node/3d-engine/staged-location/pipeline-k/native/material-regions-native';

/** A facade photo: light stone piers every 5 m (1.5 m wide), brown spandrels, two 1 x 1.8 m panes per bay a storey (3.5 m), every third storey's panes the sky's colour; +-12 of seeded noise; a few transparent texels. */
function facadePhoto(W: number, H: number, px: number, seed: number): RgbaImage8 {
    const rgba = new Uint8Array(W * H * 4);
    let s = seed >>> 0;
    const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const xm = (x * px) % 5, ym = (y * px) % 3.5, storey = Math.floor((y * px) / 3.5);
        let c = [70, 55, 50];
        if (xm < 1.5) c = [190, 185, 175];
        else if (((xm >= 1.9 && xm < 2.9) || (xm >= 3.6 && xm < 4.6)) && ym >= 0.8 && ym < 2.6) c = storey % 3 === 2 ? [120, 150, 160] : [25, 30, 40];
        const n = Math.floor(rnd() * 24) - 12, clamp = (v: number) => Math.max(0, Math.min(255, v + n));
        rgba.set([clamp(c[0]), clamp(c[1]), clamp(c[2]), x < 3 && y < 3 ? 0 : 255], (y * W + x) * 4);
    }
    return { width: W, height: H, rgba };
}

/** A wall facing +z from (x0, 0) to (x0 + w, h), n x n quads rippled a centimetre about depth z, UVs (0,0) at its top left. */
function wallGrid(x0: number, w: number, h: number, z: number, n: number) {
    const pos: number[] = [], uv: number[] = [], idx: number[] = [];
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) { pos.push(x0 + (w * i) / n, h - (h * j) / n, z + 0.01 * Math.sin(i * 0.7 + j)); uv.push(i / n, j / n); }
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const a = j * (n + 1) + i; idx.push(a, a + n + 1, a + n + 2, a, a + n + 2, a + 1); }
    return { pos, uv, idx };
}

interface Prim { name: string; pos: number[]; uv: number[]; idx: number[]; material: number; extras?: unknown }

/** A parsed GLB of the prims, material k showing image k. */
function glbOf(prims: Prim[], imageCount: number): ParsedGlb {
    const chunks: Uint8Array[] = [], views: any[] = [], accessors: any[] = [];
    let length = 0;
    const push = (b: Uint8Array) => { views.push({ buffer: 0, byteOffset: length, byteLength: b.length }); chunks.push(b); length += b.length; const pad = (4 - (length % 4)) % 4; if (pad) { chunks.push(new Uint8Array(pad)); length += pad; } return views.length - 1; };
    const acc = (view: number, count: number, type: string, componentType = 5126) => { accessors.push({ bufferView: view, componentType, count, type }); return accessors.length - 1; };
    const meshes = prims.map(q => ({
        name: q.name, primitives: [{
            attributes: { POSITION: acc(push(new Uint8Array(new Float32Array(q.pos).buffer)), q.pos.length / 3, 'VEC3'), TEXCOORD_0: acc(push(new Uint8Array(new Float32Array(q.uv).buffer)), q.uv.length / 2, 'VEC2') },
            indices: acc(push(new Uint8Array(new Uint32Array(q.idx).buffer)), q.idx.length, 'SCALAR', 5125), material: q.material, mode: 4
        }]
    }));
    const bin = new Uint8Array(length);
    let o = 0;
    for (const c of chunks) { bin.set(c, o); o += c.length; }
    const json = {
        asset: { version: '2.0' }, nodes: prims.map((q, k) => ({ mesh: k, ...(q.extras ? { extras: q.extras } : {}) })), meshes,
        materials: Array.from({ length: imageCount }, (_, k) => ({ name: `m${k}`, pbrMetallicRoughness: { baseColorTexture: { index: k } } })),
        textures: Array.from({ length: imageCount }, (_, k) => ({ source: k })), images: Array.from({ length: imageCount }, () => ({})), accessors, bufferViews: views, buffers: [{ byteLength: bin.length }]
    };
    return { json, bin };
}

/** Three rebuilt facades and a scan piece 0.3 m in front of the first, size x size photos at px m. */
function scene(size: number, px: number, grid: number) {
    const m = size * px;
    const photos = [1, 2, 3, 4].map(s => facadePhoto(size, size, px, s));
    // facade 1's fitted windows (sbFacadeLattice.windows.uv): its panes, so the classes are read inside and outside them
    const windows: number[] = [];
    for (let b = 0; b * 5 < m; b++) for (let st = 0; st * 3.5 < m; st++) for (const x0 of [1.9, 3.6]) windows.push((b * 5 + x0) / m, (st * 3.5 + 0.8) / m, Math.min(1, (b * 5 + x0 + 1) / m), Math.min(1, (st * 3.5 + 2.6) / m));
    const g = glbOf([
        { name: 'facade_lattice_1', ...wallGrid(0, m, m, 0, 2), material: 0, extras: { sbFacadeLattice: { facadeId: 1, windows: { uv: windows, panes: windows } } } },
        { name: 'facade_lattice_2', ...wallGrid(m + 5, m, m, 0, 2), material: 1 },
        { name: 'facade_lattice_3', ...wallGrid(2 * m + 10, m, m, 0, 2), material: 2 },
        { name: 'scan_piece', ...wallGrid(0, m, m, -0.3, grid), material: 3 }
    ], 4);
    return { g, json: g.json, images: new Map(photos.map((p, i) => [i, p])) };
}

/** Library sets: textured occlusion, roughness and metalness and tilted normals (so the box filter and renormalisation are exercised), each tile its own real size. */
function sets(classes: RegionClass[], S: number): RegionSet[] {
    return classes.map((c, k) => {
        const orm = { width: S, height: S, rgba: new Uint8Array(S * S * 4) }, normal = { width: S, height: S, rgba: new Uint8Array(S * S * 4) };
        for (let i = 0; i < S * S; i++) { orm.rgba.set([200 + (i % 5) * 9, 90 + k * 35 + (i % 7) * 3, k * 50 + (i % 9) * 4, 255], i * 4); normal.rgba.set([118 + (i % 23), 140 - (i % 17), 230 + (i % 11), 255], i * 4); }
        // every other set with a recess map (material-height.ts), of its own size: a facade mixes classes with and without
        const H = S + 3, height = { width: H, height: H, rgba: new Uint8Array(H * H * 4) };
        for (let i = 0; i < H * H; i++) { const v = 255 - ((i * 7 + k * 13) % 97); height.rgba.set([v, v, v, 255], i * 4); }
        return { name: `TestSet${c.index}`, realSizeM: [0.8 + k * 0.45, 1.1 + k * 0.3], normal, orm, distance: k, ...(k % 2 ? { height } : {}) };
    });
}

/** The first byte where two images differ, or -1. */
const firstDiff = (a: Uint8Array, b: Uint8Array) => { if (a.length !== b.length) return 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i; return -1; };

function expectSamePiece(native: MaterialPlanPiece, ts: MaterialPlanPiece): void {
    const strip = (p: MaterialPlanPiece) => ({ ...p, planned: p.planned && { ...p.planned, orm: undefined, normal: undefined, classes: undefined } });
    expect(strip(native)).toEqual(strip(ts));
    for (const key of ['orm', 'normal', 'classes'] as const) {
        const a = native.planned?.[key], b = ts.planned?.[key];
        expect(!!a).toBe(!!b);
        if (a && b) { expect([a.width, a.height]).toEqual([b.width, b.height]); expect(firstDiff(a.rgba, b.rgba)).toBe(-1); }
    }
}

function expectSamePlan(native: MaterialRegionsPlan, ts: MaterialRegionsPlan): void {
    expect({ ...native.report, ms: 0 }).toEqual({ ...ts.report, ms: 0 });
    expect(native.materials.length).toBe(ts.materials.length);
    native.materials.forEach((m, i) => expectSamePiece({ planned: m } as MaterialPlanPiece, { planned: ts.materials[i] } as MaterialPlanPiece));
}

describe('pipeline K material regions, native kernel', () => {
    beforeAll(async () => { await ensureMaterialRegionsNativeBinary(); }, 300_000);

    it('computes the colour tables exactly as the TypeScript does', async () => {
        const t = await materialRegionsNativeColourTables();
        expect(Array.from(t.srgb8ToLinear)).toEqual(Array.from(SRGB8_TO_LINEAR));
        let mismatches = 0;
        for (let key = 0; key < 32768; key++) {
            const r = (((key >> 10) & 31) << 3) | 4, g = (((key >> 5) & 31) << 3) | 4, b = ((key & 31) << 3) | 4;
            const lab = linearRgbToLab([SRGB8_TO_LINEAR[r], SRGB8_TO_LINEAR[g], SRGB8_TO_LINEAR[b]]);
            for (let c = 0; c < 3; c++) if (!Object.is(lab[c], t.lab[key * 3 + c])) mismatches++;
        }
        expect(mismatches).toBe(0);
    });

    it('reads the same appearance classes, with and without the tile-only harvest', async () => {
        const sc = scene(384, 0.06, 24);
        const ts = readRegionClasses(sc.json, sc.images)!;
        // four classes outside the openings and two inside them
        expect(ts.map(c => c.openings)).toEqual([false, false, false, false, true, true]);
        expect(await readRegionClassesNative(sc.json, sc.images)).toEqual(ts);
        const tsH = readRegionClasses(sc.json, sc.images, MATERIAL_REGIONS_PARAMS, { g: sc.g })!;
        expect(tsH.some(c => c.texture)).toBe(true);
        expect(await readRegionClassesNative(sc.json, sc.images, MATERIAL_REGIONS_PARAMS, { g: sc.g })).toEqual(tsH);
        // too few samples: no classes, as in the TypeScript
        const few = { ...MATERIAL_REGIONS_PARAMS, samplesPerPhoto: 3 };
        expect(readRegionClasses(sc.json, sc.images, few)).toBeUndefined();
        expect(await readRegionClassesNative(sc.json, sc.images, few)).toBeUndefined();
    });

    it('plans every job to the same bytes and the same report', async () => {
        const sc = scene(384, 0.06, 24);
        const classes = readRegionClasses(sc.json, sc.images)!, st = sets(classes, 64);
        const ctx = materialPlanContext(sc.g, sc.json, sc.images, classes, st);
        const jobs = materialPlanJobs(sc.json, sc.images);
        expect(jobs.map(j => j.kind)).toEqual(['rebuilt', 'rebuilt', 'rebuilt', 'scan']);
        for (const job of jobs) {
            const ts = planMaterialJob(job, ctx), native = await planMaterialJobNative(job, ctx);
            expectSamePiece(native, ts);
            // the facade with openings reaches the opening classes; the others and the scan piece only the outside ones
            if (job.mesh === 'facade_lattice_1') expect(ts.classTexels.slice(4).some(n => n > 0)).toBe(true);
            if (job.mesh === 'facade_lattice_1') expect(ts.facade!.foldedShare).toBeGreaterThan(0);
            // the panes are drawn as glass on the facade that has them, with any on stone counted
            if (job.mesh === 'facade_lattice_1') expect(ts.glass).toBeGreaterThan(0);
            else { expect(ts.glass).toBe(0); expect(ts.classTexels.slice(4).every(n => n === 0)).toBe(true); }
        }
        expectSamePlan(await planMaterialRegionsNative(sc.g, sc.json, sc.images, classes, st), planMaterialRegions(sc.g, sc.json, sc.images, classes, st));
        // a wider square (a finer texel's radius): the same majority
        const wide = { ...MATERIAL_REGIONS_PARAMS, regionSmoothM: 0.5 };
        const wctx = materialPlanContext(sc.g, sc.json, sc.images, classes, st, wide);
        for (const job of jobs) expectSamePiece(await planMaterialJobNative(job, wctx), planMaterialJob(job, wctx));
    }, 120_000);

    it('matches at a realistic size (four 2048 x 2048 photos) and reports the timings', async () => {
        const sc = scene(2048, 0.03, 100);
        let t = performance.now();
        const ts = readRegionClasses(sc.json, sc.images)!;
        const tsClassesMs = performance.now() - t;
        t = performance.now();
        const native = await readRegionClassesNative(sc.json, sc.images);
        const nativeClassesMs = performance.now() - t;
        expect(native).toEqual(ts);
        const st = sets(ts, 512);
        t = performance.now();
        const tsPlan = planMaterialRegions(sc.g, sc.json, sc.images, ts, st);
        const tsPlanMs = performance.now() - t;
        t = performance.now();
        const nativePlan = await planMaterialRegionsNative(sc.g, sc.json, sc.images, ts, st);
        const nativePlanMs = performance.now() - t;
        t = performance.now();
        await planMaterialRegionsNative(sc.g, sc.json, sc.images, ts, st, MATERIAL_REGIONS_PARAMS, { threads: 1 });
        const nativePlan1Ms = performance.now() - t;
        expectSamePlan(nativePlan, tsPlan);
        const f = (v: number) => `${Math.round(v)} ms`;
        console.log(`[material-regions-native] 4 x 2048^2: readRegionClasses TS ${f(tsClassesMs)}, native ${f(nativeClassesMs)}; ` +
            `planMaterialRegions TS (one thread) ${f(tsPlanMs)}, native ${f(nativePlanMs)} (all cores), ${f(nativePlan1Ms)} (one thread)`);
    }, 600_000);
});
