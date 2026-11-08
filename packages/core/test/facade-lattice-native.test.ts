/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The native lattice (scratchbox_facade_lattice.hpp, SCRATCHBOX_K_NATIVE's `lattice`) against facade-lattice.ts on a small
 * synthetic building: four facades read four ways (the photo's own grid; window strips with a raw scan's relief, an
 * uncovered patch and the repeat texture; one row of fitted windows partly over transparent texels, recessed by the
 * contrast rule; the wall grammar's bays with a depth read from Street View), as rebuildFacadesOnLattice runs it whole,
 * cut and stitched, two torn rebuilds through applyFacadeLattices, and its audit over deep recesses seen from the side and
 * over flat walls of two large triangles (whole, and with a hole only scan in front of the rebuild could close). Both give the same stats, the same GLB JSON (the provenance extras included) bar
 * the image byte lengths, the same vertices, normals, UVs and indices to 1e-6, and the same texture pixels.
 * The binary is compiled with the real clang++; nothing here reaches a network or a credential.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { applyFacadeLattices, facadeSamples, latticeFacade, rebuildFacadesOnLattice, type ReliefFacade } from '../src/node/3d-engine/staged-location/facade-lattice';
import { parseGlbBytes, readAccessor } from '../src/node/3d-engine/staged-location/glb-bytes';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';
import { REVEAL_DEPTH_PARAMS } from '../src/node/3d-engine/staged-location/reveal-depth';
import { ensureRemeshPolishBinary } from '../src/node/3d-engine/staged-location/remesh-polish-native';
import { writeStagedGlbFile } from '../src/node/3d-engine/staged-location/staged-glb-writer';
import { WINDOW_FIT_VERSION } from '../src/node/3d-engine/staged-location/window-fit';
import { decodePng } from '../src/node/texture-processing';

const PX = 0.1;
type V3 = [number, number, number];

/** A box 16 m by 12 m and 15 m tall (five 3 m storeys), each face a facade facing out. */
function facadeOf(id: number, centroid: V3, normal: V3, axisS: V3, half: number): ReliefFacade {
    return { facadeId: id, image: `facade_${id}.png`, centroid, normal, axisS, axisT: [0, 1, 0], sMin: -half, sMax: half, tMin: -7.5, tMax: 7.5, pixel: PX, width: Math.round((2 * half) / PX), height: Math.round(15 / PX), orthoSMin: -half, orthoTMax: 7.5, coverage: 1 };
}
const FACADES = [facadeOf(0, [8, 7.5, 12], [0, 0, 1], [1, 0, 0], 8), facadeOf(1, [16, 7.5, 6], [1, 0, 0], [0, 0, -1], 6), facadeOf(2, [8, 7.5, 0], [0, 0, -1], [-1, 0, 0], 8), facadeOf(3, [0, 7.5, 6], [-1, 0, 0], [0, 0, 1], 6)];

/** Windows 1.2 m wide every 3 m along the wall, 1.6 m tall in every storey, in a facade's own (s - sMin, t - tMin). */
const inWindow = (u: number, v: number) => { const a = u % 3, b = v % 3; return a > 0.9 && a < 2.1 && b > 0.7 && b < 2.3; };
const windowRects = (f: ReliefFacade, rows: number[]) => {
    const out: Array<[number, number, number, number]> = [];
    for (const r of rows) for (let c = 0; c * 3 + 2.1 <= f.sMax - f.sMin; c++) {
        const s0 = f.sMin + c * 3 + 0.9, s1 = s0 + 1.2, t0 = f.tMin + r * 3 + 0.7, t1 = t0 + 1.6;
        out.push([(s0 - f.orthoSMin) / PX, (f.orthoTMax - t1) / PX, (s1 - f.orthoSMin) / PX, (f.orthoTMax - t0) / PX]);
    }
    return out;
};

let seed = 7;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

function photo(f: ReliefFacade): { rgba: Uint8Array; mask?: Uint8Array } {
    const { width: W, height: H } = f, rgba = new Uint8Array(W * H * 4);
    const mask = f.facadeId === 0 ? new Uint8Array(W * H) : undefined;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const u = (x + 0.5) * PX, v = 15 - (y + 0.5) * PX, k = (y * W + x) * 4, n = Math.floor(rnd() * 12);
        const glass = inWindow(u, v), spandrel = f.facadeId === 0 && u % 3 > 0.9 && u % 3 < 2.1;
        rgba.set(glass ? [40 + n, 55 + n, 80 + n, 255] : spandrel ? [120 + n, 104 + n, 90 + n, 255] : [205 + n, 188 + n, 165 + n, 255], k);
        // the front's lower right corner the photo never reached (filled, its mask set); the back's left storeys transparent
        if (mask && u > 11 && v < 4) { mask[y * W + x] = 255; rgba.set([150, 150, 150, 255], k); }
        if (f.facadeId === 2 && u < 4 && v > 3 && v < 6) rgba[k + 3] = 0;
    }
    return { rgba, ...(mask ? { mask } : {}) };
}

/** The box's surfaces as triangles: each face on a 0.25 m grid at depth(u, v) off its plane, plus the roof. */
function boxSoup(depth: (f: ReliefFacade, u: number, v: number) => number): Float32Array {
    const out: number[] = [];
    for (const f of FACADES) {
        const at = (u: number, v: number): number[] => { const s = f.sMin + u, t = f.tMin + v, d = depth(f, u, v); return [0, 1, 2].map(k => f.centroid[k] + s * f.axisS[k] + t * f.axisT[k] + d * f.normal[k]); };
        for (let u = 0; u < f.sMax - f.sMin; u += 0.25) for (let v = 0; v < 15; v += 0.25) {
            const a = at(u, v), b = at(u + 0.25, v), c = at(u + 0.25, v + 0.25), d = at(u, v + 0.25);
            out.push(...a, ...b, ...c, ...a, ...c, ...d);
        }
    }
    for (let x = 0; x < 16; x += 2) for (let z = 0; z < 12; z += 2) out.push(x, 15, z, x, 15, z + 2, x + 2, 15, z + 2, x, 15, z, x + 2, 15, z + 2, x + 2, 15, z);
    return Float32Array.from(out);
}
const noise = () => (rnd() - 0.5) * 0.08;
// the scan tile_refine flattened: its walls on their planes, the windows recessed
const flatScan = () => boxSoup((_f, u, v) => (inWindow(u, v) ? -0.25 : 0) + noise());
// the scan before: the front's window columns (its bays) 0.2 m behind its piers, and the right wall's top storey a crown of
// fins 0.7 m proud every 0.5 m (KEEP_MEASURED leaves those cells to the scan)
const rawScan = () => boxSoup((f, u, v) => (f.facadeId === 1 && v > 12 ? (Math.floor(u / 0.5) % 2 ? 0 : -0.7) : inWindow(u, v) ? -0.35 : f.facadeId === 0 && u % 3 > 0.9 && u % 3 < 2.1 ? -0.2 : 0) + noise());
// the windows 0.9 m deep
const deepScan = () => boxSoup((_f, u, v) => (inWindow(u, v) ? -0.9 : 0) + noise());
/** The box's walls flat, each as two large triangles (as the tiles draw a plain wall), and its roof. */
function coarseSoup(): Float32Array {
    const out: number[] = [];
    for (const f of FACADES) {
        const at = (s: number, t: number) => [0, 1, 2].map(k => f.centroid[k] + s * f.axisS[k] + t * f.axisT[k]);
        const a = at(f.sMin, f.tMin), b = at(f.sMax, f.tMin), c = at(f.sMax, f.tMax), d = at(f.sMin, f.tMax);
        out.push(...a, ...b, ...c, ...a, ...c, ...d);
    }
    out.push(0, 15, 0, 0, 15, 12, 16, 15, 12, 0, 15, 0, 16, 15, 12, 16, 15, 0);
    return Float32Array.from(out);
}

function writeGlb(file: string, soup: Float32Array) {
    writeStagedGlbFile(file, [{ name: 'scan', positions: soup, indices: Uint32Array.from({ length: soup.length / 3 }, (_, i) => i) }], {});
}

/** Runs `fn` with SCRATCHBOX_K_NATIVE set to `mode`, restoring it after. */
function withNative<T>(mode: '0' | '1', fn: () => T): { out: T; ms: number } {
    const was = process.env.SCRATCHBOX_K_NATIVE;
    process.env.SCRATCHBOX_K_NATIVE = mode;
    try { const t0 = performance.now(); const out = fn(); return { out, ms: performance.now() - t0 }; }
    finally { if (was === undefined) delete process.env.SCRATCHBOX_K_NATIVE; else process.env.SCRATCHBOX_K_NATIVE = was; }
}

/** Two GLBs the same: JSON (bar the buffers' byte lengths), every attribute and index to 1e-6, and every PNG's pixels. */
function expectSameGlb(a: Uint8Array, b: Uint8Array) {
    const ga = parseGlbBytes(a), gb = parseGlbBytes(b);
    const json = (g: typeof ga) => ({ ...g.json, bufferViews: undefined, buffers: undefined });
    expect(json(gb)).toEqual(json(ga));
    let values = 0;
    (ga.json.meshes ?? []).forEach((m: any, mi: number) => m.primitives.forEach((p: any, pi: number) => {
        const q = gb.json.meshes[mi].primitives[pi];
        for (const k of Object.keys(p.attributes)) {
            const A = readAccessor(ga, p.attributes[k]).data, B = readAccessor(gb, q.attributes[k]).data;
            expect(B.length).toBe(A.length);
            let worst = 0;
            for (let i = 0; i < A.length; i++) worst = Math.max(worst, Math.abs(A[i] - B[i]));
            expect(worst).toBeLessThanOrEqual(1e-6);
            values += A.length;
        }
        if (p.indices !== undefined) expect(Array.from(readAccessor(gb, q.indices).data)).toEqual(Array.from(readAccessor(ga, p.indices).data));
    }));
    (ga.json.images ?? []).forEach((im: any, i: number) => {
        const bytes = (g: typeof ga, bv: number) => { const v = g.json.bufferViews[bv]; return Buffer.from(g.bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength)); };
        expect(Buffer.compare(decodePng(bytes(gb, gb.json.images[i].bufferView)).rgba, decodePng(bytes(ga, im.bufferView)).rgba)).toBe(0);
    });
    return values;
}

describe('facade lattice: native against TypeScript', () => {
    let dir = '';
    beforeAll(async () => {
        await ensureRemeshPolishBinary();
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-native-'));
        for (const f of FACADES) {
            const { rgba, mask } = photo(f);
            fs.writeFileSync(path.join(dir, f.image), encodePng(f.width, f.height, rgba, 4));
            if (mask) { f.uncoveredMask = `facade_${f.facadeId}_uncovered.png`; fs.writeFileSync(path.join(dir, f.uncoveredMask), encodePng(f.width, f.height, mask, 1)); }
        }
        fs.writeFileSync(path.join(dir, 'facades.json'), JSON.stringify({ facades: FACADES }));
        // the window fit: every storey on the front (strips), one row on the back (the windows over its transparent patch included)
        // and every storey on the left; the right read from its photo's own grid
        const fit = (f: ReliefFacade, rows: number[]) => ({ facadeId: f.facadeId, width: f.width, height: f.height, rects: windowRects(f, rows), panes: windowRects(f, rows).map(([x0, y0, x1, y1]) => [x0 + 1, y0 + 1, x1 - 1, y1 - 1]), bands: [], ms: 0 });
        fs.writeFileSync(path.join(dir, 'window_fit.json'), JSON.stringify({ version: WINDOW_FIT_VERSION, params: {}, ms: 0, facades: [fit(FACADES[0], [0, 1, 2, 3, 4]), { ...fit(FACADES[2], [1]), generated: windowRects(FACADES[2], [1]).slice(0, 1) }, fit(FACADES[3], [0, 1, 2, 3, 4])] }));
        // the left wall's bays from the wall grammar (two window columns as one bay across a mullion, and one alone)
        fs.writeFileSync(path.join(dir, 'wall_grammar.json'), JSON.stringify({ version: 'test', params: {}, walls: [], facades: { 3: [[-5.2, -7.0, -0.8, 7.0, 0], [0.8, -7.0, 2.2, 7.0, 1]] } }));
        // a depth read from Street View for the left (the back's recess from its contrast, over cells some of them dark NaN)
        fs.writeFileSync(path.join(dir, 'reveal_depth.json'), JSON.stringify({ version: 'test', params: REVEAL_DEPTH_PARAMS, views: 4, pairs: 8, facades: { 3: { depthM: 0.18, seM: 0.01, n: 8, from: 'own', label: 'photo-inferred', reason: 'a test reading' } }, fits: [] }));
        // no sheets: every facade still rebuilt whole where the scan measures its wall
        fs.writeFileSync(path.join(dir, 'walls.json'), JSON.stringify({ version: 'test', sheets: [] }));
        writeGlb(path.join(dir, 'clay.glb'), flatScan());
        writeGlb(path.join(dir, 'raw.glb'), rawScan());
    }, 900_000);

    const opts = () => ({ photoRecess: true, windowFit: path.join(dir, 'window_fit.json'), wallGrammar: path.join(dir, 'wall_grammar.json'), revealDepth: path.join(dir, 'reveal_depth.json'), walls: path.join(dir, 'walls.json'), rawScan: path.join(dir, 'raw.glb') });
    const run = (mode: '0' | '1', extra: Record<string, unknown> = {}) => {
        // the lattice edits the bytes it is given: each run reads its own
        const clay = fs.readFileSync(path.join(dir, 'clay.glb'));
        return withNative(mode, () => rebuildFacadesOnLattice(Uint8Array.from(clay), Uint8Array.from(clay), dir, undefined, undefined, { ...opts(), ...extra }));
    };

    it('rebuilds the facades as the TypeScript does: the stats, the clay and the textured twin', () => {
        const ts = run('0'), nat = run('1');
        expect(ts.out.stats.rebuilt).toBe(4);
        expect(nat.out.stats).toEqual(ts.out.stats);
        // every reading the cases are for was taken
        const nodes = parseGlbBytes(ts.out.textured!).json.nodes.filter((n: any) => n.extras?.sbFacadeLattice).map((n: any) => n.extras.sbFacadeLattice);
        const byId = new Map(nodes.map((x: any) => [x.facadeId, x]));
        expect((byId.get(0) as any).structure.reliefFrom).toBe('measured');
        expect((byId.get(0) as any).provenance.texture.repeats.texels).toBeGreaterThan(0);
        expect((byId.get(3) as any).provenance.depth).toMatch(/Street View/);
        expect((byId.get(2) as any).provenance.depth).toMatch(/photo-inferred/);
        expect((byId.get(2) as any).windows.generated.label).toBe('generated');
        expect((byId.get(3) as any).structure).toBeDefined();
        expect((byId.get(1) as any).windowCells.cells.length).toBeGreaterThan(0);
        expect((byId.get(1) as any).scanKept.cells).toBeGreaterThan(0);
        expect((byId.get(1) as any).scanKept.label).toBe('measured');
        expect((byId.get(0) as any).scanKept).toBeUndefined();
        expect(ts.out.stats.scanKeptCells).toBe((byId.get(1) as any).scanKept.cells);
        const values = expectSameGlb(ts.out.clay, nat.out.clay) + expectSameGlb(ts.out.textured!, nat.out.textured!);
        console.log(`facade lattice, 4 facades (160 x 150 and 120 x 150 texels), ${values} vertex values compared: TypeScript ${ts.ms.toFixed(0)} ms, native ${nat.ms.toFixed(0)} ms`);
    }, 300_000);

    it('cuts and stitches the same', () => {
        for (const extra of [{ cut: true }, { stitch: true }]) {
            const ts = run('0', extra), nat = run('1', extra);
            expect(nat.out.stats).toEqual(ts.out.stats);
            expectSameGlb(ts.out.clay, nat.out.clay);
            expectSameGlb(ts.out.textured!, nat.out.textured!);
        }
    }, 300_000);

    it('audits torn rebuilds the same: the tears found, straight on and from the side, and the scan put back', () => {
        const f = FACADES[0], soup = flatScan(), file = path.join(dir, 'torn.glb');
        writeGlb(file, soup);
        const img = decodePng(fs.readFileSync(path.join(dir, f.image)));
        const good = latticeFacade(f, { rgba: new Uint8Array(img.rgba), width: img.width, height: img.height }, facadeSamples(soup, f))!;
        // a rebuild that says every cell is built but carries the faces of only its left half
        const keep: number[] = [];
        for (let q = 0; q < good.indices.length; q += 3) if (Math.max(...[0, 1, 2].map(j => good.positions[good.indices[q + j] * 3])) <= 8) keep.push(good.indices[q], good.indices[q + 1], good.indices[q + 2]);
        const torn = { ...good, built: new Uint8Array(good.built.length).fill(1), indices: Uint32Array.from(keep) };
        // and one with no faces at all over cells it says are built, on the right wall
        const g1 = FACADES[1], img1 = decodePng(fs.readFileSync(path.join(dir, g1.image)));
        const good1 = latticeFacade(g1, { rgba: new Uint8Array(img1.rgba), width: img1.width, height: img1.height }, facadeSamples(soup, g1))!;
        const empty = { ...good1, built: new Uint8Array(good1.built.length).fill(1), indices: new Uint32Array(0) };
        for (const sameFacing of [false, true]) {
            const ts = withNative('0', () => applyFacadeLattices(fs.readFileSync(file), [{ f, r: torn }, { f: g1, r: empty }], false, undefined, { sameFacing }));
            const nat = withNative('1', () => applyFacadeLattices(fs.readFileSync(file), [{ f, r: torn }, { f: g1, r: empty }], false, undefined, { sameFacing }));
            expect(ts.out.tears.found).toBeGreaterThan(0);
            expect(ts.out.tears.restoredTriangles).toBeGreaterThan(0);
            expect(nat.out.tears).toEqual(ts.out.tears);
            expect(nat.out.removed).toBe(ts.out.removed);
            expect(Buffer.compare(nat.out.glb, ts.out.glb)).toBe(0);
        }
    }, 300_000);

    it('audits the same where the rebuild\'s recesses are seen from the side and where the scan would come back in front of it', () => {
        const f = FACADES[0], img = decodePng(fs.readFileSync(path.join(dir, f.image)));
        const lattice = (soup: Float32Array) => latticeFacade(f, { rgba: new Uint8Array(img.rgba), width: img.width, height: img.height }, facadeSamples(soup, f))!;
        const deep = lattice(deepScan()), good = lattice(flatScan());
        const keep: number[] = [];
        for (let q = 0; q < good.indices.length; q += 3) if (Math.max(...[0, 1, 2].map(j => good.positions[good.indices[q + j] * 3])) <= 8) keep.push(good.indices[q], good.indices[q + 1], good.indices[q + 2]);
        const torn = { ...good, built: new Uint8Array(good.built.length).fill(1), indices: Uint32Array.from(keep) };
        // and with the faces at right angles to the wall left out over its lower left storey: slits seen only from an angle
        const s0 = f.centroid[0] + f.sMin * f.axisS[0], keepSides: number[] = [];
        for (let q = 0; q < good.indices.length; q += 3) {
            const p = [0, 1, 2].map(j => [0, 1, 2].map(k => good.positions[good.indices[q + j] * 3 + k]));
            const nz = (p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) - (p[1][1] - p[0][1]) * (p[2][0] - p[0][0]), nl = Math.hypot((p[1][1] - p[0][1]) * (p[2][2] - p[0][2]) - (p[1][2] - p[0][2]) * (p[2][1] - p[0][1]), (p[1][2] - p[0][2]) * (p[2][0] - p[0][0]) - (p[1][0] - p[0][0]) * (p[2][2] - p[0][2]), nz);
            const cx = (p[0][0] + p[1][0] + p[2][0]) / 3, cy = (p[0][1] + p[1][1] + p[2][1]) / 3;
            if (!(Math.abs(nz) < 0.1 * nl && cx < s0 + 6 && cy < 3)) keepSides.push(good.indices[q], good.indices[q + 1], good.indices[q + 2]);
        }
        const slit = { ...good, indices: Uint32Array.from(keepSides) };
        // the deep recesses over the flat scan; the rebuild over the flat walls' large triangles: whole, with a hole seen straight
        // on (the scan comes back, in front), and with slits seen only from an angle (it does not)
        const cases: Array<[string, Float32Array, typeof good]> = [['deep', boxSoup(() => noise()), deep], ['coarse', coarseSoup(), good], ['coarse-torn', coarseSoup(), torn], ['coarse-slit', coarseSoup(), slit]];
        for (const [name, soup, r] of cases) {
            const file = path.join(dir, `${name}.glb`);
            writeGlb(file, soup);
            const ts = withNative('0', () => applyFacadeLattices(fs.readFileSync(file), [{ f, r }], false));
            const nat = withNative('1', () => applyFacadeLattices(fs.readFileSync(file), [{ f, r }], false));
            expect(nat.out.tears).toEqual(ts.out.tears);
            expect(nat.out.removed).toBe(ts.out.removed);
            expect(Buffer.compare(nat.out.glb, ts.out.glb)).toBe(0);
            expect(ts.out.tears.droppedFacades).toEqual([]);
            if (name === 'coarse-torn') expect(ts.out.tears.restoredInFront).toBeGreaterThan(0);
            if (name === 'coarse-slit') expect(ts.out.tears.keptInFront).toBeGreaterThan(0);
        }
    }, 300_000);
});
