/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Facades rebuilt on their photo's lines (facade-lattice.ts): a facade photo with a grid of dark windows and a noisy scan
 * in which those windows are recessed 0.3 m; the lattice finds the window edges in the photo, the windows take one recess
 * averaged over the storey (not each window's noise), the wall stays on the plane, the scan's facade triangles are made
 * degenerate and the rebuilt facade appended (textured with the facade photo in the twin).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { applyFacadeLattices, facadeSamples, latticeFacade, photoLattice, rebuildFacadesOnLattice, STRUCTURE, structureExtras, windowBays, windowGrid, windowStrips, WINDOW_STRIPS, type ReliefFacade } from '../src/node/3d-engine/staged-location/facade-lattice';
import { assembleGlb, parseGlbBytes, readAccessor } from '../src/node/3d-engine/staged-location/glb-bytes';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';
import { cutScanToLattice, LATTICE_STITCH_PARAMS } from '../src/node/3d-engine/staged-location/pipeline-k/lattice-stitch';
import { WINDOW_FIT_VERSION } from '../src/node/3d-engine/staged-location/window-fit';
import { writeStagedGlbFile } from '../src/node/3d-engine/staged-location/staged-glb-writer';
import { readGlbTriangles } from './helpers/clay-glb-render';
import { ensureRemeshPolishBinary } from '../src/node/3d-engine/staged-location/remesh-polish-native';

// the lattice's audit and rebuild run natively by default (SCRATCHBOX_K_NATIVE): its binary built once for the file
beforeAll(async () => { await ensureRemeshPolishBinary(); }, 900_000);

// a facade in the plane z = 0 facing +z: s along +x (0..12 m), t up (0..9 m); windows 1.2 m wide every 3 m, 1.6 m tall on 3 storeys
const PX = 0.1, W = 120, H = 90;
const f: ReliefFacade = { facadeId: 7, image: 'f.png', centroid: [0, 0, 0], normal: [0, 0, 1], axisS: [1, 0, 0], axisT: [0, 1, 0], sMin: 0, sMax: 12, tMin: 0, tMax: 9, pixel: PX, width: W, height: H, orthoSMin: 0, orthoTMax: 9, coverage: 1 };
const isWindow = (s: number, t: number) => { const ss = s % 3, tt = t % 3; return ss > 0.9 && ss < 2.1 && tt > 0.7 && tt < 2.3; };

function photo(): { rgba: Uint8Array; width: number; height: number } {
    const rgba = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const s = (x + 0.5) * PX, t = 9 - (y + 0.5) * PX, v = isWindow(s, t) ? 40 : 200;
        rgba.set([v, v, v, 255], (y * W + x) * 4);
    }
    return { rgba, width: W, height: H };
}

/** The scan: a 0.25 m grid surface at depth -0.3 (or `windowZ`) in the windows and 0 elsewhere, plus +-6 cm noise, as triangle soup. */
function scan(windowZ = -0.3): Float32Array {
    const out: number[] = [];
    let seed = 11;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.12;
    const z = (s: number, t: number) => (isWindow(s, t) ? windowZ : 0) + rnd();
    for (let s = 0; s < 12; s += 0.25) for (let t = 0; t < 9; t += 0.25) {
        const a = [s, t, z(s, t)], b = [s + 0.25, t, z(s + 0.25, t)], c = [s + 0.25, t + 0.25, z(s + 0.25, t + 0.25)], d = [s, t + 0.25, z(s, t + 0.25)];
        out.push(...a, ...b, ...c, ...a, ...c, ...d);
    }
    return Float32Array.from(out);
}

describe('facades on their photo lattice', () => {
    it('finds the window edges in the photo', () => {
        const { s, t } = photoLattice(photo(), f);
        for (const edge of [0.9, 2.1, 3.9, 5.1]) expect(s.some(v => Math.abs(v - edge) <= 0.15)).toBe(true);
        for (const edge of [0.7, 2.3, 3.7, 5.3]) expect(t.some(v => Math.abs(v - edge) <= 0.15)).toBe(true);
    });

    it('gives the windows one averaged recess and keeps the wall on the plane', () => {
        const r = latticeFacade(f, photo(), facadeSamples(scan(), f))!;
        expect(r).toBeDefined();
        expect(r.measuredShare).toBeGreaterThan(0.9);
        // the cell holding the centre of the window at s 1.5, t 1.5, and a wall cell at s 0.4, t 2.8
        const cell = (sv: number, tv: number) => r.depth[r.t.findIndex((x, i) => tv >= x && tv < r.t[i + 1])][r.s.findIndex((x, i) => sv >= x && sv < r.s[i + 1])];
        expect(cell(1.5, 1.5)).toBeCloseTo(-0.3, 1);
        expect(cell(7.5, 4.5)).toBeCloseTo(-0.3, 1);
        expect(Math.abs(cell(0.4, 2.8))).toBeLessThan(0.05);
        // every window in a storey has the same depth (averaged, not each window's noise)
        const storey = [1.5, 4.5, 7.5, 10.5].map(sv => cell(sv, 1.5));
        expect(new Set(storey).size).toBe(1);
        expect(r.indices.length).toBeGreaterThan(0);
    });

    it('marks the windows as window cells and writes them, in the photo\'s UVs, into the rebuilt facade\'s extras', () => {
        const r = latticeFacade(f, photo(), facadeSamples(scan(), f))!;
        const at = (sv: number, tv: number) => r.t.findIndex((x, i) => tv >= x && tv < r.t[i + 1]) * (r.s.length - 1) + r.s.findIndex((x, i) => sv >= x && sv < r.s[i + 1]);
        // the window centres are window cells, the wall between them is not
        for (const [sv, tv] of [[1.5, 1.5], [4.5, 4.5], [10.5, 7.5]]) expect(r.windows[at(sv, tv)]).toBe(1);
        expect(r.windows[at(0.4, 2.8)]).toBe(0);
        expect(r.windows[at(3, 1.5)]).toBe(0);
        // the cell lines in the photo's UVs: u from s, v down from the top
        expect(r.cellU[0]).toBeCloseTo((r.s[0] - f.orthoSMin) / (W * PX), 6);
        expect(r.cellV[0]).toBeCloseTo((f.orthoTMax - r.t[0]) / (H * PX), 6);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-'));
        const soup = scan(), file = path.join(dir, 'clay.glb');
        writeStagedGlbFile(file, [{ name: 'scan', positions: soup, indices: Uint32Array.from({ length: soup.length / 3 }, (_, i) => i) }], {});
        const twin = applyFacadeLattices(fs.readFileSync(file), [{ f, r, png: Buffer.from('89504e470d0a1a0a', 'hex') }], true);
        const wc = parseGlbBytes(twin.glb).json.nodes.at(-1).extras.sbFacadeLattice.windowCells;
        expect(wc.label).toBe('photo-inferred');
        expect(wc.u).toHaveLength(r.s.length);
        expect(wc.cells).toContain(at(1.5, 1.5));
        expect(wc.cells.length).toBe(r.windows.reduce((a: number, v: number) => a + v, 0));
    });

    it("draws the lattice on the window fit's windows: their edges are its lines, they alone are its window cells, recessed", () => {
        // the fit found the windows of the first two bays only (the third left to the photo's own reading of nothing)
        const fitted: Array<[number, number, number, number]> = [];
        for (const s0 of [0.9, 3.9]) for (const t0 of [0.7, 3.7, 6.7]) fitted.push([s0, t0, s0 + 1.2, t0 + 1.6]);
        const r = latticeFacade(f, photo(), facadeSamples(scan(), f), undefined, undefined, true, fitted)!;
        for (const e of [0.9, 2.1, 3.9, 5.1]) expect(r.s.some(v => Math.abs(v - e) < 1e-9)).toBe(true);
        for (const e of [0.7, 2.3, 3.7, 5.3, 6.7, 8.3]) expect(r.t.some(v => Math.abs(v - e) < 1e-9)).toBe(true);
        const cellAt = (sv: number, tv: number) => [r.t.findIndex((x, i) => tv >= x && tv < r.t[i + 1]), r.s.findIndex((x, i) => sv >= x && sv < r.s[i + 1])];
        const ns = r.s.length - 1;
        const isWin = (sv: number, tv: number) => { const [b, a] = cellAt(sv, tv); return r.windows[b * ns + a] === 1; };
        const depthAt = (sv: number, tv: number) => { const [b, a] = cellAt(sv, tv); return r.depth[b][a]; };
        expect(isWin(1.5, 1.5)).toBe(true);
        expect(isWin(4.5, 7.5)).toBe(true);
        // the third bay's windows were not fitted: not window cells
        expect(isWin(7.5, 1.5)).toBe(false);
        // the fitted windows recess (at least the scan's 0.3 m); the wall beside them stays on the plane
        expect(depthAt(1.5, 1.5)).toBeLessThan(-0.15);
        expect(Math.abs(depthAt(3, 1.5))).toBeLessThan(0.1);
    });

    it('groups the fitted windows into columns and splits a column where its windows stand far apart (a band, a setback)', () => {
        const w: Array<[number, number, number, number]> = [];
        for (const s0 of [0.9, 3.9]) for (const t0 of [0.7, 3.7, 6.7]) w.push([s0, t0, s0 + 1.2, t0 + 1.6]);
        // a third column whose top window stands 5 m above the others: two strips' worth of windows below, one alone above
        w.push([6.9, 0.7, 8.1, 2.3], [6.95, 3.7, 8.05, 5.3], [6.9, 10.3, 8.1, 11.9]);
        const strips = windowStrips(w);
        // the column's edges are its windows' medians (of two, the upper)
        const want = [[0.9, 0.7, 2.1, 8.3], [3.9, 0.7, 5.1, 8.3], [6.95, 0.7, 8.1, 5.3]];
        expect(strips).toHaveLength(3);
        strips.forEach((st, i) => st.forEach((v, k) => expect(v).toBeCloseTo(want[i][k], 9)));
        // one window is no strip
        expect(windowStrips([[0.9, 0.7, 2.1, 2.3]])).toEqual([]);
    });

    it('joins window columns across a mullion into one bay, and leaves columns with equal gaps (piers) apart', () => {
        // the ESB's tower faces: columns 1.4 m wide, 0.7 m mullions inside a bay, 2 m piers between bays
        const cols: Array<[number, number, number, number]> = [[0, 0, 1.4, 30], [2.1, 0, 3.5, 30], [5.5, 0, 6.9, 30], [7.6, 0, 9, 30]];
        const bays = windowBays(cols);
        expect(bays).toHaveLength(2);
        bays.forEach((b, i) => b.forEach((v, k) => expect(v).toBeCloseTo([[0, 0, 3.5, 30], [5.5, 0, 9, 30]][i][k], 9)));
        // one column per bay (every gap a pier): nothing joins
        expect(windowBays([[0, 0, 1.4, 30], [3.4, 0, 4.8, 30], [6.8, 0, 8.2, 30]])).toHaveLength(3);
        // a wide gap at a corner or setback makes no pier a mullion
        expect(windowBays([[0, 0, 1.4, 30], [2.1, 0, 3.5, 30], [5.5, 0, 6.9, 30], [7.6, 0, 9, 30], [19, 0, 20.4, 30], [21.1, 0, 22.5, 30]])).toHaveLength(3);
        // a column the fit read as one tall opening is a strip of its own
        expect(windowStrips([[0, 0, 1.4, 30], [3.4, 0, 4.8, 30]])).toHaveLength(2);
        expect(windowStrips([[0, 0, 1.4, 2]])).toHaveLength(0);
        // columns that do not stand side by side up the wall never join
        expect(windowBays([[0, 0, 1.4, 10], [2.1, 20, 3.5, 30], [5.5, 0, 6.9, 10]])).toHaveLength(3);
    });

    it('recesses each window column as one strip between proud piers, the windows a little deeper, the piers chamfered', () => {
        // pipeline K: the scan uncarved (flat), every bay's windows fitted on all three storeys
        const flat = scan().map((v, i) => (i % 3 === 2 ? 0 : v));
        const fitted: Array<[number, number, number, number]> = [];
        for (const s0 of [0.9, 3.9, 6.9, 9.9]) for (const t0 of [0.7, 3.7, 6.7]) fitted.push([s0, t0, s0 + 1.2, t0 + 1.6]);
        const r = latticeFacade(f, photo(), facadeSamples(flat, f), undefined, undefined, true, fitted)!;
        expect(r.strips).toHaveLength(4);
        const cell = (sv: number, tv: number) => r.depth[r.t.findIndex((x, i) => tv >= x && tv < r.t[i + 1])][r.s.findIndex((x, i) => sv >= x && sv < r.s[i + 1])];
        const spandrel = cell(1.5, 3.0), window = cell(1.5, 1.5), pier = cell(3.0, 3.0);
        // the spandrel between two windows is recessed with the strip; the pier stays on the wall
        expect(Math.abs(pier)).toBeLessThan(0.05);
        expect(spandrel).toBeLessThan(-0.1);
        expect(window).toBeCloseTo(spandrel - WINDOW_STRIPS.windowInsetM, 5);
        // above the strips (the parapet, t 8.3..9) the wall is not recessed
        expect(Math.abs(cell(1.5, 8.7))).toBeLessThan(0.05);
        // the structure: the piers and the parapet, standing proud by the photo's recess (the flat scan resolves none)
        expect(r.structure!.reliefFrom).toBe('photo-inferred');
        expect(r.structure!.reliefM).toBeCloseTo(pier - spandrel, 5);
        const at = (sv: number, tv: number) => r.structure!.cells[r.t.findIndex((x, i) => tv >= x && tv < r.t[i + 1]) * (r.s.length - 1) + r.s.findIndex((x, i) => sv >= x && sv < r.s[i + 1])];
        expect(at(3.0, 3.0)).toBe(1);
        expect(at(1.5, 8.7)).toBe(1);
        expect(at(1.5, 3.0)).toBe(0);
        expect(at(1.5, 1.5)).toBe(0);
        // the piers' arrises: faces leaning 45 degrees between the facade's normal and its s axis, chamferM deep
        let bevels = 0;
        for (let i = 0; i < r.indices.length; i += 3) {
            const k = r.indices[i], n = [r.normals[k * 3], r.normals[k * 3 + 1], r.normals[k * 3 + 2]];
            if (Math.abs(Math.abs(n[0]) - Math.SQRT1_2) < 1e-3 && Math.abs(n[2] - Math.SQRT1_2) < 1e-3) bevels++;
        }
        expect(bevels).toBeGreaterThan(0);
        // every face, bevels included, winds to face its normal
        for (let i = 0; i < r.indices.length; i += 3) {
            const [a, b, c] = [r.indices[i], r.indices[i + 1], r.indices[i + 2]];
            const u = [0, 1, 2].map(k => r.positions[b * 3 + k] - r.positions[a * 3 + k]), v = [0, 1, 2].map(k => r.positions[c * 3 + k] - r.positions[a * 3 + k]);
            const g = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
            expect(g[0] * r.normals[a * 3] + g[1] * r.normals[a * 3 + 1] + g[2] * r.normals[a * 3 + 2]).toBeGreaterThan(0);
        }
    });

    it("stands the structure proud by the scan's own pier-to-bay depth when it resolves one, else a plausible depth, and writes it to the extras", () => {
        const fitted: Array<[number, number, number, number]> = [];
        for (const s0 of [0.9, 3.9, 6.9, 9.9]) for (const t0 of [0.7, 3.7, 6.7]) fitted.push([s0, t0, s0 + 1.2, t0 + 1.6]);
        // the scan: the bays (s 0.9-2.1 mod 3, t 0.7-8.3) 0.18 m behind the piers, +-6 cm noise
        let seed = 5;
        const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.12;
        const out: number[] = [];
        const z = (sv: number, tv: number) => (sv % 3 > 0.9 && sv % 3 < 2.1 && tv > 0.7 && tv < 8.3 ? -0.18 : 0) + rnd();
        for (let sv = 0; sv < 12; sv += 0.25) for (let tv = 0; tv < 9; tv += 0.25) {
            const a = [sv, tv, z(sv, tv)], b = [sv + 0.25, tv, z(sv + 0.25, tv)], c = [sv + 0.25, tv + 0.25, z(sv + 0.25, tv + 0.25)], d = [sv, tv + 0.25, z(sv, tv + 0.25)];
            out.push(...a, ...b, ...c, ...a, ...c, ...d);
        }
        const r = latticeFacade(f, photo(), facadeSamples(Float32Array.from(out), f), undefined, undefined, true, fitted)!;
        expect(r.structure!.reliefFrom).toBe('measured');
        expect(r.structure!.reliefM).toBeGreaterThan(0.12);
        expect(r.structure!.reliefM).toBeLessThan(0.24);
        // no photo contrast (an even grey photo) and a flat scan: a plausible depth, labelled generated
        const grey = photo(); grey.rgba.fill(150);
        for (let k = 3; k < grey.rgba.length; k += 4) grey.rgba[k] = 255;
        const g = latticeFacade(f, grey, facadeSamples(scan().map((v, i) => (i % 3 === 2 ? 0 : v)), f), undefined, undefined, true, fitted)!;
        expect(g.structure!.reliefFrom).toBe('generated');
        expect(g.structure!.reliefM).toBe(STRUCTURE.defaultReliefM);
        // the extras: runs in the photo's UVs inside [0, 1], with the relief's source and the chamfer
        const ex = structureExtras(r)!;
        expect(ex.uv.length % 4).toBe(0);
        expect(ex.uv.length).toBeGreaterThan(0);
        expect(ex.uv.every(v => v >= 0 && v <= 1)).toBe(true);
        expect(ex.reliefFrom).toBe('measured');
        expect(ex.chamferM).toBe(STRUCTURE.chamferM);
        // the pier at s 2.1-3.9 in its middle storey (t 3.0, v 0.667) is in a run; the bay at s 1.5 is not
        const inRun = (u: number, v: number) => { for (let i = 0; i < ex.uv.length; i += 4) if (u >= ex.uv[i] && u <= ex.uv[i + 2] && v >= ex.uv[i + 1] && v <= ex.uv[i + 3]) return true; return false; };
        expect(inRun(3.0 / 12, 1 - 3.0 / 9)).toBe(true);
        expect(inRun(1.5 / 12, 1 - 3.0 / 9)).toBe(false);
    });

    it('leaves cells to the scan where the raw scan measures relief deeper or finer than a cell can draw (a band of fins), and draws no window there', () => {
        // the windows in the lower and upper storeys; the middle storey (t 3.6-5.4) a band of fins 0.7 m proud every 0.5 m
        const fitted: Array<[number, number, number, number]> = [];
        for (const s0 of [0.9, 3.9, 6.9, 9.9]) for (const t0 of [0.7, 6.7]) fitted.push([s0, t0, s0 + 1.2, t0 + 1.6]);
        let seed = 11;
        const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.06;
        const soupOf = (z: (sv: number, tv: number) => number) => {
            const out: number[] = [];
            for (let sv = 0; sv < 12; sv += 0.125) for (let tv = 0; tv < 9; tv += 0.125) {
                const q = (a: number, b: number) => [a, b, z(a, b) + rnd()];
                out.push(...q(sv, tv), ...q(sv + 0.125, tv), ...q(sv + 0.125, tv + 0.125), ...q(sv, tv), ...q(sv + 0.125, tv + 0.125), ...q(sv, tv + 0.125));
            }
            return Float32Array.from(out);
        };
        const inBand = (tv: number) => tv > 3.6 && tv < 5.4;
        const fins = soupOf((sv, tv) => (inBand(tv) ? (Math.floor(sv / 0.5) % 2 ? 0 : -0.7) : isWindow(sv, tv) && !inBand(tv) ? -0.25 : 0));
        const r = latticeFacade(f, photo(), facadeSamples(scan(), f), undefined, undefined, true, fitted, undefined, undefined, facadeSamples(fins, f))!;
        expect(r.scanKept).toBeDefined();
        expect(r.scanKept!.count).toBeGreaterThan(0);
        expect(r.scanKept!.reliefM).toBeGreaterThan(0.6);
        const ns = r.s.length - 1;
        let inside = 0;
        for (let b = 0; b < r.t.length - 1; b++) for (let a = 0; a < ns; a++) {
            const k = b * ns + a;
            if (!r.scanKept!.cells[k]) continue;
            // every kept cell lies in the band (a cell straddling its edge is in it too), is not built, and draws no window
            expect(r.t[b + 1]).toBeGreaterThan(3.6 - 1e-6);
            expect(r.t[b]).toBeLessThan(5.4 + 1e-6);
            expect(r.built[k]).toBe(0);
            expect(r.windows[k]).toBe(0);
            if (r.t[b] >= 3.6 - 1e-6 && r.t[b + 1] <= 5.4 + 1e-6) inside++;
        }
        expect(inside).toBeGreaterThan(0);
        expect(r.scanKept!.areaM2).toBeGreaterThan(4);
        // the same walls without the band: nothing kept, more cells rebuilt
        const flat = latticeFacade(f, photo(), facadeSamples(scan(), f), undefined, undefined, true, fitted, undefined, undefined, facadeSamples(soupOf((sv, tv) => (isWindow(sv, tv) ? -0.25 : 0)), f))!;
        expect(flat.scanKept).toBeUndefined();
        expect(flat.cells).toBeGreaterThan(r.cells);
        // a smooth bulge of the same depth (photogrammetry on glass) slopes through every depth between: no step, nothing kept
        const bulge = latticeFacade(f, photo(), facadeSamples(scan(), f), undefined, undefined, true, fitted, undefined, undefined, facadeSamples(soupOf((sv, tv) => (inBand(tv) ? -0.8 * Math.sin((Math.PI * (sv % 4)) / 4) ** 2 : isWindow(sv, tv) ? -0.25 : 0)), f))!;
        expect(bulge.scanKept).toBeUndefined();
    });

    it('recesses the fitted windows by a depth read from Street View when one is given, never shallower than the scan', () => {
        const fitted: Array<[number, number, number, number]> = [[0.9, 0.7, 2.1, 2.3], [3.9, 0.7, 5.1, 2.3], [6.9, 0.7, 8.1, 2.3]];
        const read = latticeFacade(f, photo(), facadeSamples(scan(), f), undefined, undefined, true, fitted, 0.5)!;
        const cell = (r: typeof read, sv: number, tv: number) => r.depth[r.t.findIndex((x, i) => tv >= x && tv < r.t[i + 1])][r.s.findIndex((x, i) => sv >= x && sv < r.s[i + 1])];
        expect(cell(read, 1.5, 1.5)).toBeLessThan(-0.45);
        // a read depth shallower than the scan's 0.3 m keeps the scan's
        const shallow = latticeFacade(f, photo(), facadeSamples(scan(), f), undefined, undefined, true, fitted, 0.1)!;
        expect(cell(shallow, 1.5, 1.5)).toBeLessThan(-0.2);
    });

    it("writes the window fit's windows, in the photo's UVs, into the rebuilt facade's extras", () => {
        const r = latticeFacade(f, photo(), facadeSamples(scan(), f))!;
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-'));
        const soup = scan(), file = path.join(dir, 'clay.glb');
        writeStagedGlbFile(file, [{ name: 'scan', positions: soup, indices: Uint32Array.from({ length: soup.length / 3 }, (_, i) => i) }], {});
        const fitted = [0.075, 0.1, 0.175, 0.3, 0.325, 0.1, 0.425, 0.3];
        const twin = applyFacadeLattices(fs.readFileSync(file), [{ f, r: { ...r, fittedWindows: fitted }, png: Buffer.from('89504e470d0a1a0a', 'hex') }], true);
        const ex = parseGlbBytes(twin.glb).json.nodes.at(-1).extras.sbFacadeLattice;
        expect(ex.windows).toEqual({ uv: fitted, label: 'photo-inferred', source: WINDOW_FIT_VERSION });
        // without a fit, no windows entry (the window cells stay)
        const plain = applyFacadeLattices(fs.readFileSync(file), [{ f, r, png: Buffer.from('89504e470d0a1a0a', 'hex') }], true);
        expect(parseGlbBytes(plain.glb).json.nodes.at(-1).extras.sbFacadeLattice.windows).toBeUndefined();
    });

    it('reads windows in rows and columns: weathered stone bands and a shaded pier are not windows', () => {
        // 7 columns x 6 rows of cells: wall 200; windows (40) where columns 1, 3, 5 cross rows 1, 3; row 4 weathered stone
        // (150 in every column), column 6 a shaded pier (150 in every row), row 0 a dark band of stone in one direction only
        const ns = 7, nt = 6, lum = new Float64Array(ns * nt).fill(200);
        for (const b of [1, 3]) for (const a of [1, 3, 5]) lum[b * ns + a] = 40;
        for (let a = 0; a < ns; a++) lum[4 * ns + a] = 150;
        for (let b = 0; b < nt; b++) if (lum[b * ns + 6] === 200) lum[b * ns + 6] = 150;
        const w = windowGrid(lum, ns, nt);
        const on = [...w].map((v, k) => (v ? k : -1)).filter(k => k >= 0);
        expect(on.sort((x, y) => x - y)).toEqual([1 * ns + 1, 1 * ns + 3, 1 * ns + 5, 3 * ns + 1, 3 * ns + 3, 3 * ns + 5]);
        // a uniform stone wall with patchy weathering has no windows
        const stone = Float64Array.from({ length: ns * nt }, (_, k) => (k % 5 === 0 ? 160 : 200));
        expect(windowGrid(stone, ns, nt).some(v => v)).toBe(false);
    });

    it('winds every face, the cells and their reveals, to face the way its normal says', () => {
        const r = latticeFacade(f, photo(), facadeSamples(scan(), f))!;
        let reveals = 0;
        for (let i = 0; i < r.indices.length; i += 3) {
            const [a, b, c] = [r.indices[i], r.indices[i + 1], r.indices[i + 2]];
            const u = [0, 1, 2].map(k => r.positions[b * 3 + k] - r.positions[a * 3 + k]), v = [0, 1, 2].map(k => r.positions[c * 3 + k] - r.positions[a * 3 + k]);
            const g = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
            const n = [r.normals[a * 3], r.normals[a * 3 + 1], r.normals[a * 3 + 2]];
            expect(g[0] * n[0] + g[1] * n[1] + g[2] * n[2]).toBeGreaterThan(0);
            if (Math.abs(n[2]) < 0.5) reveals++;
        }
        expect(reveals).toBeGreaterThan(0);
    });

    it('closes a photo-recessed cell toward a cell left as scan, and draws no face past the lattice\'s outer edge', () => {
        // pipeline K: the scan is uncarved (flat), the windows recessed from the photo; the facade starts inside a window (s 1.5)
        const flat = scan().map((v, i) => (i % 3 === 2 ? 0 : v));
        const g: ReliefFacade = { ...f, sMin: 1.5 };
        const mask = new Uint8Array(W * H);
        // the photo never reached the wall between the second and third window columns (s 5.1..6.9): those cells stay as scan
        for (let y = 0; y < H; y++) for (let x = 51; x < 69; x++) mask[y * W + x] = 1;
        const r = latticeFacade(g, photo(), facadeSamples(flat, g), undefined, mask, true)!;
        expect(r.photoRecessCells).toBeGreaterThan(0);
        // a recess's reveals face into its opening: at its left side +s, at its right side -s
        const revealAt = (sv: number, dir: number) => {
            for (let i = 0; i < r.indices.length; i += 3) {
                const ids = [r.indices[i], r.indices[i + 1], r.indices[i + 2]];
                if (r.normals[ids[0] * 3] * dir < 0.99) continue;
                if (ids.every(k => Math.abs(r.positions[k * 3] - sv) < 0.15) && ids.some(k => r.positions[k * 3 + 2] < -0.1) && ids.some(k => Math.abs(r.positions[k * 3 + 2]) < 0.03)) return true;
            }
            return false;
        };
        // the window cut by the lattice's edge at s 1.5: nothing past the edge (the neighbouring facade or the scan closes it; a
        // face back to the cell's own depth would stand on the neighbour's plane, a one-texel smear over its pier)
        expect(revealAt(1.5, 1)).toBe(false);
        // the window at s 3.9..5.1 beside the wall cells left as scan
        const edge = r.s.find(v => Math.abs(v - 5.1) <= 0.15)!;
        expect(edge).toBeDefined();
        const ns = r.s.length - 1, right = r.s.indexOf(edge);
        expect(r.built.some((v, k) => k % ns === right && !v)).toBe(true);
        expect(revealAt(edge, -1)).toBe(true);
    });

    it("unfolds every reveal's texels into the recessed cell's photo, never one line of texels across it", () => {
        const r = latticeFacade(f, photo(), facadeSamples(scan(), f), undefined, undefined, true)!;
        let reveals = 0;
        for (let i = 0; i < r.indices.length; i += 3) {
            const ids = [r.indices[i], r.indices[i + 1], r.indices[i + 2]];
            if (Math.abs(r.normals[ids[0] * 3 + 2]) > 0.5) continue;
            reveals++;
            // u and v both vary over the face (the face is unfolded), and every texel lies on the photo
            const u = ids.map(k => r.uv[k * 2]), v = ids.map(k => r.uv[k * 2 + 1]);
            expect(Math.max(...u) - Math.min(...u) + Math.max(...v) - Math.min(...v)).toBeGreaterThan(0);
            const sideS = Math.abs(r.normals[ids[0] * 3]) > 0.5;
            const spread = sideS ? Math.max(...u) - Math.min(...u) : Math.max(...v) - Math.min(...v);
            const depth = Math.max(...ids.map(k => r.positions[k * 3 + 2])) - Math.min(...ids.map(k => r.positions[k * 3 + 2]));
            expect(spread * (sideS ? W * PX : H * PX)).toBeCloseTo(depth, 5);
            for (const x of [...u, ...v]) { expect(x).toBeGreaterThanOrEqual(-1e-6); expect(x).toBeLessThanOrEqual(1 + 1e-6); }
        }
        expect(reveals).toBeGreaterThan(0);
    });

    it('replaces the scan facade in the clay and the twin, the twin textured with the facade photo', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-'));
        const soup = scan();
        const file = path.join(dir, 'clay.glb');
        writeStagedGlbFile(file, [{ name: 'scan', positions: soup, indices: Uint32Array.from({ length: soup.length / 3 }, (_, i) => i) }], {});
        const bytes = fs.readFileSync(file);
        const r = latticeFacade(f, photo(), facadeSamples(soup, f))!;
        const png = Buffer.from('89504e470d0a1a0a', 'hex');
        const clay = applyFacadeLattices(bytes, [{ f, r }], false), twin = applyFacadeLattices(bytes, [{ f, r, png }], true);
        expect(clay.removed).toBe(soup.length / 9);
        const t = readGlbTriangles(clay.glb);
        let live = 0;
        for (let i = 0; i < t.indices.length; i += 3) if (!(t.indices[i] === t.indices[i + 1] && t.indices[i + 1] === t.indices[i + 2])) live++;
        expect(live).toBe(r.indices.length / 3);
        const tj = parseGlbBytes(twin.glb).json;
        expect(tj.materials.at(-1).name).toBe('FacadeLattice_7');
        expect(tj.images.at(-1).mimeType).toBe('image/png');
        expect(tj.nodes.at(-1).extras.sbFacadeLattice.provenance.lines).toBe('photo-inferred');
    });

    it('keeps the scan where the photo does not cover the facade, instead of a face painted uncovered grey', () => {
        // the right third of the photo uncovered (exact grey 128, as tile_refine writes it)
        const img = photo();
        for (let y = 0; y < H; y++) for (let x = 80; x < W; x++) img.rgba.set([128, 128, 128, 255], (y * W + x) * 4);
        const soup = scan();
        const r = latticeFacade(f, img, facadeSamples(soup, f))!;
        expect(r).toBeDefined();
        // no rebuilt vertex stands in the uncovered third (s beyond 8 m, a lattice line's width of slack)
        let maxS = -Infinity;
        for (let v = 0; v < r.positions.length; v += 3) maxS = Math.max(maxS, r.positions[v]);
        expect(maxS).toBeLessThanOrEqual(8.5);
        expect(r.built.some(v => !v)).toBe(true);
        // the scan's triangles there stay live; the covered ones are replaced
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-'));
        const file = path.join(dir, 'clay.glb');
        writeStagedGlbFile(file, [{ name: 'scan', positions: soup, indices: Uint32Array.from({ length: soup.length / 3 }, (_, i) => i) }], {});
        const out = applyFacadeLattices(fs.readFileSync(file), [{ f, r }], false);
        const t = readGlbTriangles(out.glb);
        let liveUncovered = 0, liveCovered = 0;
        for (let i = 0; i < soup.length / 3; i += 3) {
            if (t.indices[i] === t.indices[i + 1] && t.indices[i + 1] === t.indices[i + 2]) continue;
            const cs = (soup[i * 3] + soup[i * 3 + 3] + soup[i * 3 + 6]) / 3;
            if (cs > 8.5) liveUncovered++; else if (cs < 7.5) liveCovered++;
        }
        expect(liveUncovered).toBeGreaterThan(0);
        expect(liveCovered).toBe(0);
        expect(out.tears.left).toBe(0);
        expect(out.tears.droppedFacades).toEqual([]);
    });

    it("builds a row's end cells at their own scan depth where the wall turns away behind the plane (a prow, a corner), but not an end window", () => {
        // the wall curves inward over its last 1.5 m (s > 10.5): 0 to 1 m behind the plane; windows as in the photo
        let seed = 3;
        const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.06;
        const out: number[] = [];
        const z = (sv: number, tv: number) => (sv > 10.5 ? -((sv - 10.5) / 1.5) : isWindow(sv, tv) ? -0.25 : 0) + rnd();
        for (let sv = 0; sv < 12; sv += 0.25) for (let tv = 0; tv < 9; tv += 0.25) {
            const a = [sv, tv, z(sv, tv)], b = [sv + 0.25, tv, z(sv + 0.25, tv)], c = [sv + 0.25, tv + 0.25, z(sv + 0.25, tv + 0.25)], d = [sv, tv + 0.25, z(sv, tv + 0.25)];
            out.push(...a, ...b, ...c, ...a, ...c, ...d);
        }
        const r = latticeFacade(f, photo(), facadeSamples(Float32Array.from(out), f))!;
        const ns = r.s.length - 1;
        // the last column (its cell past s 10.5) is built, at its own scan depth, well behind the plane; the first column on it
        for (let b = 0; b < r.t.length - 1; b++) { if (r.s[ns] - r.s[ns - 1] > 0.5) { expect(r.built[b * ns + ns - 1]).toBe(1); expect(r.depth[b][ns - 1]).toBeLessThan(-0.3); } expect(r.built[b * ns]).toBe(1); expect(Math.abs(r.depth[b][0])).toBeLessThan(0.1); }
        const flat = latticeFacade(f, photo(), facadeSamples(scan(), f))!;
        expect(Math.abs(flat.depth[0][flat.s.length - 2])).toBeLessThan(0.1);
    });

    it('removes a scan sliver standing across a rebuilt cell (a reveal or a fin side), whichever way the claim faces, and leaves one outside the rebuild', () => {
        const front = scan();
        const r = latticeFacade(f, photo(), facadeSamples(front, f))!;
        // two slivers perpendicular to the wall, 0.4 m deep and a metre tall: one inside a rebuilt cell (s 4.5), one past the rectangle (s -1)
        const sliver = (sv: number): number[] => [sv, 4, 0, sv, 5, 0, sv, 5, -0.4, sv, 4, 0, sv, 5, -0.4, sv, 4, -0.4];
        const extra = [...sliver(4.5), ...sliver(-1)];
        const soup = new Float32Array(front.length + extra.length); soup.set(front); soup.set(extra, front.length);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-'));
        const file = path.join(dir, 'clay.glb');
        writeStagedGlbFile(file, [{ name: 'scan', positions: soup, indices: Uint32Array.from({ length: soup.length / 3 }, (_, i) => i) }], {});
        for (const sameFacing of [false, true]) {
            const t = readGlbTriangles(applyFacadeLattices(fs.readFileSync(file), [{ f, r }], false, undefined, { sameFacing }).glb);
            const gone = (k: number) => t.indices[k * 3] === t.indices[k * 3 + 1] && t.indices[k * 3 + 1] === t.indices[k * 3 + 2];
            const first = front.length / 9;
            expect(gone(first)).toBe(true); expect(gone(first + 1)).toBe(true);
            expect(gone(first + 2)).toBe(false); expect(gone(first + 3)).toBe(false);
        }
    });

    it('with sameFacing, keeps the scan of a thin wall\'s other side lying in the rebuilt cells', () => {
        // the wall's back face 5 cm behind its front, wound the other way (a parapet's street side behind its rebuilt terrace side)
        const img = photo();
        for (let y = 0; y < H; y++) for (let x = 80; x < W; x++) img.rgba.set([128, 128, 128, 255], (y * W + x) * 4);
        const front = scan();
        const r = latticeFacade(f, img, facadeSamples(front, f))!;
        const back = new Float32Array(front.length);
        for (let i = 0; i < front.length; i += 9) for (let j = 0; j < 3; j++) { const k = [0, 2, 1][j]; back.set([front[i + 3 * k], front[i + 3 * k + 1], front[i + 3 * k + 2] - 0.05], i + 3 * j); }
        const soup = new Float32Array(front.length * 2); soup.set(front); soup.set(back, front.length);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-'));
        const file = path.join(dir, 'clay.glb');
        writeStagedGlbFile(file, [{ name: 'scan', positions: soup, indices: Uint32Array.from({ length: soup.length / 3 }, (_, i) => i) }], {});
        const live = (sameFacing: boolean) => {
            const t = readGlbTriangles(applyFacadeLattices(fs.readFileSync(file), [{ f, r }], false, undefined, { sameFacing }).glb);
            const n = { front: 0, back: 0 }, half = front.length / 9;
            for (let k = 0; k < soup.length / 9; k++) {
                const i = k * 3;
                if (t.indices[i] === t.indices[i + 1] && t.indices[i + 1] === t.indices[i + 2]) continue;
                if ((soup[k * 9] + soup[k * 9 + 3] + soup[k * 9 + 6]) / 3 < 7.5) n[k < half ? 'front' : 'back']++;
            }
            return n;
        };
        // facing either way, both sides go alike; facing the same way, the back stays whole and the front goes as before
        const either = live(false), same = live(true);
        expect(either.back).toBe(either.front);
        expect(same.front).toBeLessThanOrEqual(either.front);
        expect(same.back).toBeGreaterThan(either.back + 500);
    });

    it('with the cut (pipeline K), takes the scan off the rebuilt cells even where its triangles reach past them, and keeps it beyond', () => {
        // the scan as a tile mesh is: each storey band one pair of long triangles across the whole facade, the photo's right third uncovered
        const img = photo();
        for (let y = 0; y < H; y++) for (let x = 80; x < W; x++) img.rgba.set([128, 128, 128, 255], (y * W + x) * 4);
        const pos: number[] = [];
        for (let t = 0; t < 9; t += 3) pos.push(0, t, 0, 12, t, 0, 12, t + 3, 0, 0, t, 0, 12, t + 3, 0, 0, t + 3, 0);
        const soup = Float32Array.from(pos);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-cut-'));
        try {
            fs.writeFileSync(path.join(dir, 'facades.json'), JSON.stringify({ facades: [f] }));
            fs.writeFileSync(path.join(dir, f.image), encodePng(W, H, img.rgba, 4));
            const file = path.join(dir, 'clay.glb');
            writeStagedGlbFile(file, [{ name: 'scan', positions: soup, indices: Uint32Array.from({ length: soup.length / 3 }, (_, i) => i) }], {});
            // the scan's live area left of s = 7.5 (over the rebuilt cells) and right of s = 8.5 (beyond them), its lattice nodes aside
            const scanArea = (bytes: Uint8Array) => {
                const g = parseGlbBytes(bytes), lattice = new Set((g.json.nodes ?? []).filter((n: any) => n.extras?.sbFacadeLattice).map((n: any) => n.mesh));
                const area = { over: 0, beyond: 0 };
                (g.json.meshes ?? []).forEach((m: any, mi: number) => { if (lattice.has(mi)) return; for (const p of m.primitives) {
                    const X = readAccessor(g, p.attributes.POSITION).data, I = readAccessor(g, p.indices).data;
                    for (let i = 0; i + 2 < I.length; i += 3) {
                        const a = I[i] * 3, b = I[i + 1] * 3, c = I[i + 2] * 3;
                        const A = Math.abs((X[b] - X[a]) * (X[c + 1] - X[a + 1]) - (X[c] - X[a]) * (X[b + 1] - X[a + 1])) / 2, cs = (X[a] + X[b] + X[c]) / 3;
                        if (cs < 7.5) area.over += A; else if (cs > 8.5) area.beyond += A;
                    }
                } });
                return area;
            };
            const whole = rebuildFacadesOnLattice(fs.readFileSync(file), undefined, dir);
            const cut = rebuildFacadesOnLattice(fs.readFileSync(file), undefined, dir, undefined, undefined, { cut: true });
            expect(cut.stats.rebuilt).toBe(1);
            // whole triangles: every one reaches past the rebuilt cells, so all stay, lying on the wall over the rebuild
            expect(whole.stats.removedTriangles).toBe(0);
            expect(scanArea(whole.clay).over).toBeGreaterThan(50);
            // the cut: the scan split at the cells' lines and its pieces over them gone, but for the few the tear audit puts back at
            // the rebuild's open edge (not storey-long triangles); the uncovered third kept as scanned
            const over = scanArea(whole.clay).over, a = scanArea(cut.clay);
            expect(a.over).toBeLessThan(over * 0.1);
            expect(a.beyond).toBeGreaterThan(9 * 3.4);
            expect(cut.stats.cut!.cutTriangles).toBe(6);
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    it('keeps each piece of the cut on its own photo where two triangles meet at a texture seam', () => {
        // one quad of scan as two triangles from two atlas charts (u under 0.4, and over 0.6): the diagonal's positions shared, not its UVs
        const img = photo();
        for (let y = 0; y < H; y++) for (let x = 80; x < W; x++) img.rgba.set([128, 128, 128, 255], (y * W + x) * 4);
        const r = latticeFacade(f, img, facadeSamples(scan(), f))!;
        const positions = Float32Array.from([0, 0, 0, 12, 0, 0, 12, 3, 0, 0, 0, 0, 12, 3, 0, 0, 3, 0]);
        const uv = Float32Array.from([0, 0, 0.4, 0, 0.4, 0.4, 0.6, 0, 1, 0.4, 0.6, 0.4]);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-seam-'));
        try {
            const file = path.join(dir, 'twin.glb');
            writeStagedGlbFile(file, [{ name: 'scan', positions, indices: Uint32Array.from([0, 1, 2, 3, 4, 5]), uv }], { texture: { bytes: encodePng(W, H, img.rgba, 4), mimeType: 'image/png' } });
            const out = cutScanToLattice(fs.readFileSync(file), [{ f, r }], { ...LATTICE_STITCH_PARAMS, cutKeepInside: true });
            expect(out.report.cutTriangles).toBe(2);
            const g = parseGlbBytes(out.glb);
            const pieces = g.json.meshes.flatMap((m: any) => m.primitives).filter((p: any) => p.extras?.sbLatticeCut);
            expect(pieces.length).toBe(1);
            const U = readAccessor(g, pieces[0].attributes.TEXCOORD_0).data, I = readAccessor(g, pieces[0].indices).data;
            let mixed = 0;
            for (let i = 0; i + 2 < I.length; i += 3) { const us = [I[i], I[i + 1], I[i + 2]].map(v => U[v * 2]); if (Math.min(...us) < 0.5 && Math.max(...us) > 0.5) mixed++; }
            expect(I.length / 3).toBeGreaterThan(4);
            expect(mixed).toBe(0);
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    it('reads coverage from the uncovered mask when the image\'s holes were filled (pipeline K): a filled cell the photo never reached is not rebuilt', () => {
        const mask = new Uint8Array(W * H);
        for (let y = 0; y < H; y++) for (let x = 80; x < W; x++) mask[y * W + x] = 1;
        const r = latticeFacade(f, photo(), facadeSamples(scan(), f), undefined, mask)!;
        let maxS = -Infinity;
        for (let v = 0; v < r.positions.length; v += 3) maxS = Math.max(maxS, r.positions[v]);
        expect(maxS).toBeLessThanOrEqual(8.5);
        // without the mask the same filled image builds the whole facade
        const all = latticeFacade(f, photo(), facadeSamples(scan(), f))!;
        expect(all.built.every(v => v === 1)).toBe(true);
    });

    it('keeps the scan where it lies further behind the plane than any recess (the wall behind a setback), building no deep box there', () => {
        // the top storey's scan stands 1.6 m behind the plane: another wall, not a window
        const deep = scan().map((v, i) => (i % 3 === 2 && scan()[i - 1] >= 6.25 ? v - 1.6 : v));
        const r = latticeFacade(f, photo(), facadeSamples(deep, f))!;
        const row = (tv: number) => r.t.findIndex((x, i) => tv >= x && tv < r.t[i + 1]);
        const ns = r.s.length - 1;
        const builtIn = (tv: number) => r.built.slice(row(tv) * ns, row(tv) * ns + ns);
        expect(builtIn(7.5).every(v => v === 0)).toBe(true);
        expect(builtIn(1.5).every(v => v === 1)).toBe(true);
        // nothing the rebuild drew lies at the clamp's depth
        let minZ = Infinity;
        for (let v = 2; v < r.positions.length; v += 3) minZ = Math.min(minZ, r.positions[v]);
        expect(minZ).toBeGreaterThan(-1.0);
    });

    it('never leaves a tear: what the rebuild claims but does not build is found by the audit, and the scan is put back', () => {
        const soup = scan();
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-'));
        const file = path.join(dir, 'clay.glb');
        writeStagedGlbFile(file, [{ name: 'scan', positions: soup, indices: Uint32Array.from({ length: soup.length / 3 }, (_, i) => i) }], {});
        const good = latticeFacade(f, photo(), facadeSamples(soup, f))!;
        // a rebuild that says every cell is built but carries the faces of only the left half (a hole where its right half should be)
        const keep: number[] = [];
        for (let q = 0; q < good.indices.length; q += 3) {
            const xs = [0, 1, 2].map(j => good.positions[good.indices[q + j] * 3]);
            if (Math.max(...xs) <= 6) keep.push(good.indices[q], good.indices[q + 1], good.indices[q + 2]);
        }
        const torn = { ...good, built: new Uint8Array(good.built.length).fill(1), indices: Uint32Array.from(keep) };
        const out = applyFacadeLattices(fs.readFileSync(file), [{ f, r: torn }], false);
        expect(out.tears.found).toBeGreaterThan(0);
        // the scan's triangles are back over the missing half and nothing stays torn
        expect(out.tears.left).toBe(0);
        const t = readGlbTriangles(out.glb);
        let liveRight = 0;
        for (let i = 0; i < soup.length / 3; i += 3) {
            if (t.indices[i] === t.indices[i + 1] && t.indices[i + 1] === t.indices[i + 2]) continue;
            if ((soup[i * 3] + soup[i * 3 + 3] + soup[i * 3 + 6]) / 3 > 6.5) liveRight++;
        }
        expect(liveRight).toBeGreaterThan(0);
        // closed by the scan the rebuild does not draw over, not by giving the facade up
        expect(out.tears.droppedFacades).toEqual([]);
    });

    /** The live scan triangles in `glb` (the scan written first, as `soup`) whose centre lies in a window. */
    const liveInWindows = (glb: Uint8Array, soup: Float32Array) => {
        const t = readGlbTriangles(glb);
        let n = 0;
        for (let i = 0; i < soup.length / 3; i += 3) {
            if (t.indices[i] === t.indices[i + 1] && t.indices[i + 1] === t.indices[i + 2]) continue;
            if (isWindow((soup[i * 3] + soup[i * 3 + 3] + soup[i * 3 + 6]) / 3, (soup[i * 3 + 1] + soup[i * 3 + 4] + soup[i * 3 + 7]) / 3)) n++;
        }
        return n;
    };
    const glbOf = (soup: Float32Array) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-')), file = path.join(dir, 'clay.glb');
        writeStagedGlbFile(file, [{ name: 'scan', positions: soup, indices: Uint32Array.from({ length: soup.length / 3 }, (_, i) => i) }], {});
        const bytes = fs.readFileSync(file);
        fs.rmSync(dir, { recursive: true, force: true });
        return bytes;
    };
    // the flat scan tile_refine leaves: the wall as two large triangles, as the tiles draw a plain wall
    const coarse = Float32Array.from([0, 0, 0, 12, 0, 0, 12, 9, 0, 0, 0, 0, 12, 9, 0, 0, 9, 0]);

    it('seen from an angle, the rebuild\'s own recesses are no tears, and no flat scan comes back in front of them', () => {
        // windows recessed 0.9 m (seen at 45 degrees their backs lie 0.64 m deeper than the flat scan there), over a flat scan
        const deep = latticeFacade(f, photo(), facadeSamples(scan(-0.9), f))!;
        const flat = scan(0), out = applyFacadeLattices(glbOf(flat), [{ f, r: deep }], false);
        expect(out.removed).toBeGreaterThan(0.95 * (flat.length / 9));
        expect(liveInWindows(out.glb, flat)).toBe(0);
        expect(out.tears.left).toBe(0);
        expect(out.tears.droppedFacades).toEqual([]);
        // the wall's two large triangles against the rebuild's many small ones: the angled views see the whole facade, so the
        // rebuild's far end is not missing from them while the scan's large triangles still reach in
        const r = latticeFacade(f, photo(), facadeSamples(scan(), f))!;
        const big = applyFacadeLattices(glbOf(coarse), [{ f, r }], false);
        expect(big.removed).toBe(2);
        expect(big.tears.restoredTriangles).toBe(0);
        expect(big.tears.oblique ?? 0).toBe(0);
    });

    it('from an angle, never puts the scan back in front of the rebuild: a slit only such scan could close stays reported', () => {
        const good = latticeFacade(f, photo(), facadeSamples(scan(), f))!;
        // the reveals of the window at s 0.9-2.1, t 0.7-2.3 left out: seen from an angle, a slit beside its recessed back
        const keep: number[] = [];
        for (let q = 0; q < good.indices.length; q += 3) {
            const p = [0, 1, 2].map(j => [0, 1, 2].map(k => good.positions[good.indices[q + j] * 3 + k]));
            const n = [(p[1][1] - p[0][1]) * (p[2][2] - p[0][2]) - (p[1][2] - p[0][2]) * (p[2][1] - p[0][1]), (p[1][2] - p[0][2]) * (p[2][0] - p[0][0]) - (p[1][0] - p[0][0]) * (p[2][2] - p[0][2]), (p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) - (p[1][1] - p[0][1]) * (p[2][0] - p[0][0])];
            const cs = (p[0][0] + p[1][0] + p[2][0]) / 3, ct = (p[0][1] + p[1][1] + p[2][1]) / 3;
            const side = Math.abs(n[2]) < 0.1 * Math.hypot(n[0], n[1], n[2]);
            if (!(side && cs > 0.8 && cs < 2.2 && ct > 0.6 && ct < 2.4)) keep.push(good.indices[q], good.indices[q + 1], good.indices[q + 2]);
        }
        expect(keep.length).toBeLessThan(good.indices.length);
        const slit = { ...good, indices: Uint32Array.from(keep) };
        const out = applyFacadeLattices(glbOf(coarse), [{ f, r: slit }], false);
        expect(out.tears.oblique).toBeGreaterThan(0);
        expect(out.tears.keptInFront).toBeGreaterThan(0);
        expect(out.tears.obliqueLeft).toBeGreaterThan(0);
        expect(out.removed).toBe(2);
        expect(out.tears.left).toBe(0);
        expect(out.tears.droppedFacades).toEqual([]);
    });

    it('measures scan standing proud of the rebuilt surface, and removes it only where the rebuilt cells cover its footprint', () => {
        // the photo's right third uncovered: the cells there stay scan; the wall as storey-long whole triangles reaching past them
        const img = photo();
        for (let y = 0; y < H; y++) for (let x = 80; x < W; x++) img.rgba.set([128, 128, 128, 255], (y * W + x) * 4);
        const pos: number[] = [];
        for (let t = 0; t < 9; t += 3) pos.push(0, t, 0, 12, t, 0, 12, t + 3, 0, 0, t, 0, 12, t + 3, 0, 0, t + 3, 0);
        const soup = Float32Array.from(pos);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-proud-'));
        try {
            fs.writeFileSync(path.join(dir, 'facades.json'), JSON.stringify({ facades: [f] }));
            fs.writeFileSync(path.join(dir, f.image), encodePng(W, H, img.rgba, 4));
            const file = path.join(dir, 'clay.glb');
            writeStagedGlbFile(file, [{ name: 'scan', positions: soup, indices: Uint32Array.from({ length: soup.length / 3 }, (_, i) => i) }], {});
            // the windows recessed as the photo shows them (the scan here is flat): 0.15 to 0.25 m, past the tolerance
            const whole = rebuildFacadesOnLattice(fs.readFileSync(file), undefined, dir, undefined, undefined, { photoRecess: true });
            const p = whole.stats.proud!;
            // the windows are recessed and the whole triangles lie on the plane over them: proud by more than the tolerance
            // (restoreFrontM plus the chamfer), over about eight metres of wall with 1.2 x 1.6 m windows every 3 m on three storeys
            expect(p.tolM).toBeCloseTo(0.10, 6);
            expect(p.m2).toBeGreaterThan(8);
            expect(p.m2).toBeLessThan(8 * 9);
            expect(p.obliqueM2).toBeGreaterThan(0);
            // nothing is removed: every triangle reaches past the rebuilt cells, into the third left as scan
            expect(p.removedTriangles).toBe(0);
            expect(p.afterM2).toBe(p.m2);
            expect(whole.stats.removedTriangles).toBe(0);
            // the measure is in the rebuilt facade's extras too, labelled measured
            const node = parseGlbBytes(whole.clay).json.nodes.find((n: any) => n.extras?.sbFacadeLattice);
            expect(node.extras.sbFacadeLattice.proud).toMatchObject({ m2: p.m2, afterM2: p.afterM2, tolM: p.tolM, label: 'measured' });
            // the cut (pipeline K) splits the wall at the cells' lines, so the pieces over the recessed windows go and little stands proud
            const cut = rebuildFacadesOnLattice(fs.readFileSync(file), undefined, dir, undefined, undefined, { cut: true, photoRecess: true });
            expect(cut.stats.proud!.afterM2).toBeLessThan(p.m2 * 0.25);
            expect(cut.stats.tears.left).toBe(0);
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    it('a proud triangle the rebuilt cells cover is removed, and put back where that opens a tear, so the removal opens nothing', () => {
        // the torn rebuild over the coarse wall: the audit puts the two whole triangles back over the hole, in front of the rebuild;
        // the proud audit then sees them proud, removes them (the cells cover them whole), the hole reopens, and they come back
        const r = latticeFacade(f, photo(), facadeSamples(scan(), f))!;
        const keep: number[] = [];
        for (let q = 0; q < r.indices.length; q += 3) if (Math.max(...[0, 1, 2].map(j => r.positions[r.indices[q + j] * 3])) <= 6) keep.push(r.indices[q], r.indices[q + 1], r.indices[q + 2]);
        const torn = { ...r, built: new Uint8Array(r.built.length).fill(1), indices: Uint32Array.from(keep) };
        const out = applyFacadeLattices(glbOf(coarse), [{ f, r: torn }], false);
        expect(out.tears.restoredInFront).toBeGreaterThan(0);
        expect(out.proud.m2).toBeGreaterThan(0);
        expect(out.proud.removedTriangles).toBeGreaterThan(0);
        expect(out.proud.restoredTriangles).toBe(out.proud.removedTriangles);
        expect(out.proud.afterM2).toBe(out.proud.m2);
        expect(out.tears.left).toBe(0);
        expect(out.tears.droppedFacades).toEqual([]);
        // the scan's two triangles are live at the end
        const t = readGlbTriangles(out.glb);
        expect([0, 3].filter(i => !(t.indices[i] === t.indices[i + 1] && t.indices[i + 1] === t.indices[i + 2])).length).toBe(2);
    });

    it('puts the scan back over a hole seen straight on even where it stands in front of the rebuild, and counts it', () => {
        const good = latticeFacade(f, photo(), facadeSamples(scan(), f))!;
        // the rebuild's right half missing; the wall's two large triangles each span its recessed windows on the left
        const keep: number[] = [];
        for (let q = 0; q < good.indices.length; q += 3) if (Math.max(...[0, 1, 2].map(j => good.positions[good.indices[q + j] * 3])) <= 6) keep.push(good.indices[q], good.indices[q + 1], good.indices[q + 2]);
        const torn = { ...good, built: new Uint8Array(good.built.length).fill(1), indices: Uint32Array.from(keep) };
        const out = applyFacadeLattices(glbOf(coarse), [{ f, r: torn }], false);
        expect(out.tears.found).toBeGreaterThan(0);
        expect(out.tears.restoredTriangles).toBe(2);
        expect(out.tears.restoredInFront).toBe(2);
        expect(out.tears.droppedFacades).toEqual([]);
        expect(out.tears.left).toBe(0);
        expect(out.removed).toBe(0);
    });
});

describe('facade lattices on a district-sized remesh', () => {
    it('edits a GLB whose binary chunk is larger than a plain JS array can hold (~134 M elements)', () => {
        // one triangle, then 140 MB of other data in the same buffer (a district remesh's positions, normals and textures)
        const N = 140 * 1024 * 1024;
        const bin = new Uint8Array(N);
        const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
        bin.set(new Uint8Array(pos.buffer), 0);
        bin.set(new Uint8Array(new Uint32Array([0, 1, 2]).buffer), 36);
        bin[N - 1] = 7;
        const json = {
            asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
            meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: 4 }] }],
            buffers: [{ byteLength: N }],
            bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 12 }, { buffer: 0, byteOffset: 48, byteLength: N - 48 }],
            accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }, { bufferView: 1, componentType: 5125, count: 3, type: 'SCALAR' }]
        };
        const r = { s: [0, 1], t: [0, 1], positions: new Float32Array([0, 0, 0.01, 1, 0, 0.01, 1, 1, 0.01, 0, 1, 0.01]), normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), uv: new Float32Array(8), indices: new Uint32Array([0, 1, 2, 0, 2, 3]), cells: 1, measuredShare: 1, built: new Uint8Array([1]) };
        const out = applyFacadeLattices(assembleGlb(json as never, bin), [{ f, r: r as never }], false);
        expect(out.removed).toBe(1);                                   // the scan's triangle in the facade, made degenerate
        const back = parseGlbBytes(out.glb);
        expect(back.bin.length).toBeGreaterThanOrEqual(N + 36 + 36 + 12);
        expect(back.bin[N - 1]).toBe(7);                                // the original bytes kept, the rebuilt facade after them
        expect(back.json.meshes).toHaveLength(2);
        const idx = new Uint32Array(back.bin.buffer.slice(back.bin.byteOffset + 36, back.bin.byteOffset + 48));
        expect(Array.from(idx)).toEqual([0, 0, 0]);
    });
});

