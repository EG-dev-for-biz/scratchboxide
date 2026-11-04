/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { chunkTerritory, joinChunkGlb, planDistrictChunks } from '../src/node/3d-engine/staged-location/pipeline-k/district-chunks';
import { addSeamEdges, applySeamGain, cutChunkLayer, sampleSeamColour, seamCoverage, seamFieldAt, seamOwner, solveSeamGains, type SeamEdges } from '../src/node/3d-engine/staged-location/pipeline-k/district-seams';
import { parseGlbBytes, readAccessor } from '../src/node/3d-engine/staged-location/glb-bytes';
import { writeStagedGlb } from '../src/node/3d-engine/staged-location/staged-glb-writer';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';
import { decodeImageInMemory } from '../src/node/3d-engine/staged-location/tile-texture-transfer';

/** A grid of ground over x0..x1, z0..z1 at `step`, its height y(x, z), uv over the grid, drawn with one flat grey photo. */
function ground(x0: number, x1: number, z0: number, z1: number, step: number, y: (x: number, z: number) => number, grey: number | [number, number, number] | ((row: number) => number)): Buffer {
    const nx = Math.round((x1 - x0) / step), nz = Math.round((z1 - z0) / step);
    const pos: number[] = [], uv: number[] = [], idx: number[] = [];
    for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) { const x = x0 + i * step, z = z0 + j * step; pos.push(x, y(x, z), z); uv.push(i / nx, j / nz); }
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) { const a = j * (nx + 1) + i; idx.push(a, a + nx + 1, a + 1, a + 1, a + nx + 1, a + nx + 2); }
    // a 4 x 4 photo: one grey, or a grey per row (its rows run along z)
    const px = Uint8Array.from({ length: 48 }, (_, i) => (typeof grey === 'number' ? grey : Array.isArray(grey) ? grey[i % 3] : grey(Math.floor(i / 12))));
    return writeStagedGlb([{ name: 'ground', positions: Float32Array.from(pos), indices: Uint32Array.from(idx), uv: Float32Array.from(uv) }], { texture: { bytes: encodePng(4, 4, px, 3), mimeType: 'image/png' } });
}

/** Every live triangle of a GLB (degenerate ones, the cut's dropped originals, left out). */
function triangles(bytes: Uint8Array): number[][][] {
    const g = parseGlbBytes(bytes), out: number[][][] = [];
    for (const m of g.json.meshes) for (const p of m.primitives) {
        const X = readAccessor(g, p.attributes.POSITION).data, I = readAccessor(g, p.indices).data;
        for (let t = 0; t + 2 < I.length; t += 3) {
            if (I[t] === I[t + 1] || I[t + 1] === I[t + 2] || I[t] === I[t + 2]) continue;
            out.push([0, 1, 2].map(k => [X[I[t + k] * 3], X[I[t + k] * 3 + 1], X[I[t + k] * 3 + 2]]));
        }
    }
    return out;
}
const planArea = (tris: number[][][]) => tris.reduce((s, [a, b, c]) => s + Math.abs((b[0] - a[0]) * (c[2] - a[2]) - (c[0] - a[0]) * (b[2] - a[2])) / 2, 0);
const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

describe('pipeline K-D: the seam stage, one chunk at a time', () => {
    // no buildings: ownership is the cells alone; the centre (0, 0) and its east neighbour meet at x = 60
    const plan = planDistrictChunks(350, [])!;
    const centre = plan.chunks.find(c => c.centre)!.index, east = plan.chunks.find(c => c.cx === 120 && c.cz === 0)!.index;
    // two remeshes of one street, each past its own edge: the centre's at 1 m, flat; the east one's at 0.7 m, 5-9 cm higher
    const a = ground(50, 64, -5, 5, 1, () => 0, 100);
    const b = ground(56, 70, -5, 5.5, 0.5, (x, z) => 0.05 + 0.004 * (z + 5), 130);

    it('cuts each ground exactly at the cell line and moves the later one onto the earlier one', () => {
        const edges: SeamEdges = new Map();
        const ca = cutChunkLayer(a, plan, centre, { snapTo: edges });
        addSeamEdges(edges, ca.edges);
        const ta = triangles(ca.glb);
        // the centre keeps x 50..60 and nothing past the line, its area exactly the 10 x 10 m it owns
        expect(Math.max(...ta.flat().map(p => p[0]))).toBeLessThanOrEqual(60 + 1e-9);
        expect(planArea(ta)).toBeCloseTo(100, 6);
        // the edge it left on the line runs the whole street
        const segs = ca.edges.get('x60')!;
        expect(segs.length).toBeGreaterThan(0);
        expect(Math.min(...segs.filter((_, i) => i % 2 === 0))).toBeCloseTo(-5, 6);
        expect(Math.max(...segs.filter((_, i) => i % 2 === 0))).toBeCloseTo(5, 6);
        const cb = cutChunkLayer(b, plan, east, { snapTo: edges });
        const tb = triangles(cb.glb);
        expect(Math.min(...tb.flat().map(p => p[0]))).toBeGreaterThanOrEqual(60 - 1e-9);
        // the east ground keeps x 60..70 over z -5..5.5: the half metre past the centre's street is its own
        expect(planArea(tb)).toBeCloseTo(105, 6);
        // its corners on the line now stand on the centre's edge (flat at 0): the step of 5-9 cm is closed where the centre reaches
        const onLine = tb.flat().filter(p => Math.abs(p[0] - 60) < 1e-9);
        const reached = onLine.filter(p => p[2] <= 5 + 1e-9);
        expect(reached.length).toBeGreaterThan(10);
        for (const p of reached) expect(Math.abs(p[1])).toBeLessThan(1e-6);
        expect(cb.report.snapped).toBeGreaterThan(10);
        expect(cb.report.maxSnapM).toBeLessThan(0.1);
        // past the centre's street (z > 5) nothing was within reach: those corners kept their own height
        for (const p of onLine.filter(q => q[2] > 5.3)) expect(p[1]).toBeGreaterThan(0.05);
    });

    it("leaves no hole where a building reaches across the line into its neighbour's cell, only a sliver of overlap", () => {
        // a building owned by the east chunk (its middle at x 70) reaching 5 m into the centre's cell (x 55..60, z -2..2)
        const rect = (x0: number, z0: number, x1: number, z1: number): Array<[number, number]> => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
        const p = planDistrictChunks(350, [{ id: 'hall', centroid: [70, 0], loops: [rect(55, -2, 85, 2)] }])!;
        const c0 = p.chunks.find(c => c.centre)!.index, c1 = p.chunks.find(c => c.cx === 120 && c.cz === 0)!.index;
        // two remeshes at steps that line up with neither the outline nor each other
        const ga = ground(50, 60.2, -5.1, 5.4, 0.7, () => 0, 100), gb = ground(53.9, 70.1, -5.3, 5.5, 0.9, () => 0, 100);
        const ta = triangles(cutChunkLayer(ga, p, c0).glb), tb = triangles(cutChunkLayer(gb, p, c1).glb);
        // nothing of the centre's crosses the cell line outside the building
        for (const [x, , z] of ta.flat()) if (Math.abs(z) > 2.8) expect(x).toBeLessThanOrEqual(60 + 1e-9);
        // every point of the street and the building's part is covered by one ground or the other
        const inTri = (x: number, z: number, [a, b, c]: number[][]) => {
            const d = (b[0] - a[0]) * (c[2] - a[2]) - (c[0] - a[0]) * (b[2] - a[2]);
            const l1 = ((b[0] - x) * (c[2] - z) - (c[0] - x) * (b[2] - z)) / d, l2 = ((c[0] - x) * (a[2] - z) - (a[0] - x) * (c[2] - z)) / d;
            return l1 >= -1e-9 && l2 >= -1e-9 && l1 + l2 <= 1 + 1e-9;
        };
        let holes = 0;
        for (let x = 50.05; x < 70; x += 0.1) for (let z = -4.95; z < 5; z += 0.1) if (!ta.some(t => inTri(x, z, t)) && !tb.some(t => inTri(x, z, t))) holes++;
        expect(holes).toBe(0);
        // the overlap is only the triangles across the building's outline (14 m of it in the centre's cell, a triangle wide)
        const overlap = planArea(ta) + planArea(tb) - (105 + 10.1 * 10.8);
        expect(overlap).toBeGreaterThan(0);
        expect(overlap).toBeLessThan(14 * 0.9);
    });

    it("ends the district on its circle: ground across the edge cut exactly on it, nothing past it, nothing torn", () => {
        // a chunk's ground running 20 m past the 350 m edge, at a step that lines up with nothing
        const p = planDistrictChunks(350, [])!;
        const cell = p.chunks.find(c => c.cx === 360 && c.cz === 0)!.index;
        const g = ground(320.3, 370.1, -12.1, 12.4, 0.7, (x, z) => 0.01 * x + 0.02 * z, 100);
        const cut = cutChunkLayer(g, p, cell);
        const tris = triangles(cut.glb);
        const r = (v: number[]) => Math.hypot(v[0], v[2]);
        // nothing past the circle, and the edge it leaves lies on it
        expect(Math.max(...tris.flat().map(r))).toBeLessThanOrEqual(350 + 1e-4); // positions are float32: 350 m holds to about 3e-5
        const onCircle = tris.flat().filter(v => Math.abs(r(v) - 350) < 1e-4);
        expect(onCircle.length).toBeGreaterThan(20);
        // they span the ground's width, and each stands on the surface it was cut from (the height carried across the cut)
        expect(Math.min(...onCircle.map(v => v[2]))).toBeLessThan(-11.5);
        expect(Math.max(...onCircle.map(v => v[2]))).toBeGreaterThan(11.8);
        for (const v of onCircle) expect(Math.abs(v[1] - (0.01 * v[0] + 0.02 * v[2]))).toBeLessThan(1e-3);
        // the area kept is the ground's inside the circle
        let inside = 0;
        for (let x = 320.3 + 0.025; x < 370.1; x += 0.05) for (let z = -12.1 + 0.025; z < 12.4; z += 0.05) if (Math.hypot(x, z) <= 350) inside += 0.0025;
        expect(planArea(tris)).toBeCloseTo(inside, 0);
        expect(cut.report.edgeCut).toBeGreaterThan(20);
    });

    it("keeps a building planned whole past the circle, ground and all, and cuts only the street beside it", () => {
        const rect = (x0: number, z0: number, x1: number, z1: number): Array<[number, number]> => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
        const p = planDistrictChunks(350, [{ id: 'edge', centroid: [375, 0], loops: [rect(330, -6, 420, 6)] }])!;
        const cell = p.chunks.find(c => c.buildings.includes('edge'))!.index;
        const tris = triangles(cutChunkLayer(ground(330.2, 370.1, -12.1, 12.4, 0.7, () => 0, 100), p, cell).glb);
        const mid = (t: number[][]) => [0, 2].map(k => (t[0][k] + t[1][k] + t[2][k]) / 3);
        // inside the footprint the ground runs on to 370 m, the whole extraction
        expect(Math.max(...tris.filter(t => Math.abs(mid(t)[1]) < 5).flat().map(v => v[0]))).toBeGreaterThan(369.9);
        // beside it, the street stops on the circle
        for (const t of tris.filter(t => Math.abs(mid(t)[1]) > 7)) for (const v of t) expect(Math.hypot(v[0], v[2])).toBeLessThanOrEqual(350 + 1e-4);
    });

    it("keeps ground the owner's build never reached with a chunk whose build did", () => {
        const rect = (x0: number, z0: number, x1: number, z1: number): Array<[number, number]> => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
        const p = planDistrictChunks(350, [{ id: 'hall', centroid: [70, 0], loops: [rect(55, -2, 85, 2)] }])!;
        const c0 = p.chunks.find(c => c.centre)!.index, c1 = p.chunks.find(c => c.cx === 120 && c.cz === 0)!.index;
        // the east chunk's ground stops at x 60: its extraction never reached the part of its building across the line
        const ga = ground(50, 60.2, -5.1, 5.4, 0.7, () => 0, 100), gb = ground(60, 70, -5, 5, 1, () => 0, 100);
        const coverage = new Map([[c0, seamCoverage(ga)], [c1, seamCoverage(gb)]]);
        const owner = seamOwner(p, coverage, [c0, c1]);
        expect(owner(57, 0)).toBe(c0);
        expect(owner(65, 0)).toBe(c1);
        // the centre keeps its whole 10 x 10.5 m, the building's part over the line included: no hole there (and the slivers
        // of its band past the line where the east ground has none, under a square metre)
        const kept = planArea(triangles(cutChunkLayer(ga, p, c0, { owner }).glb));
        expect(kept).toBeGreaterThan(105 - 1e-3);
        expect(kept).toBeLessThan(106);
        expect(planArea(triangles(cutChunkLayer(gb, p, c1, { owner }).glb))).toBeCloseTo(100, 3);
        // the plan's owner alone would have dropped all of it but the triangles across the building's outline
        expect(planArea(triangles(cutChunkLayer(ga, p, c0).glb))).toBeLessThan(85 + 14 * 0.7);
    });

    it("cuts two chunks' streets across a cell line by who keeps the ground: none drawn twice, none lost", () => {
        const identity = Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
        const y = (x: number, z: number) => 0.01 * x + 0.002 * z;
        // each chunk's build drew the same street (z -4..4) on the same tiles, at its own tessellation, past its own cell
        const sa = ground(40, 80, -4, 4, 0.5, y, 90), sb = ground(40.2, 80.2, -4, 4, 0.8, y, 90);
        // each carved its own ground under it (the street's band of the grid left out), the ground joined with the seam band
        const carved = (g: Buffer) => joinChunkGlb(g, identity, (x, z) => Math.abs(z) > 4).glb;
        const ga = carved(ground(40, 63, -10, 10, 0.5, y, 100)), gb = carved(ground(57, 80, -10, 10, 0.5, y, 100));
        const owner = seamOwner(plan, new Map([[centre, seamCoverage(ga)], [east, seamCoverage(gb)]]), [centre, east]);
        // joined as the chunks stage joins a layer that is not a tree: with the seam band past each cell, so drawn twice there
        const ja = joinChunkGlb(sa, identity, chunkTerritory(plan, centre, 3)).glb, jb = joinChunkGlb(sb, identity, chunkTerritory(plan, east, 3)).glb;
        const street = (80.2 - 40) * 8;
        expect(planArea(triangles(ja)) + planArea(triangles(jb)) - street).toBeGreaterThan(5 * 8);
        const subject = "as measured: the chunk's streets";
        const ca = cutChunkLayer(ja, plan, centre, { owner, subject }), cb = cutChunkLayer(jb, plan, east, { owner, subject });
        const ta = triangles(ca.glb), tb = triangles(cb.glb);
        // each ends exactly on the cell line: the centre keeps x 40..60, the east chunk 60..80.2, the whole street between them
        expect(Math.max(...ta.flat().map(p => p[0]))).toBeLessThanOrEqual(60 + 1e-9);
        expect(Math.min(...tb.flat().map(p => p[0]))).toBeGreaterThanOrEqual(60 - 1e-9);
        expect(planArea(ta)).toBeCloseTo(20 * 8, 3);
        expect(planArea(tb)).toBeCloseTo(20.2 * 8, 3);
        // every point of the street drawn by exactly one chunk
        const inTri = (x: number, z: number, [a, b, c]: number[][]) => {
            const d = (b[0] - a[0]) * (c[2] - a[2]) - (c[0] - a[0]) * (b[2] - a[2]);
            const l1 = ((b[0] - x) * (c[2] - z) - (c[0] - x) * (b[2] - z)) / d, l2 = ((c[0] - x) * (a[2] - z) - (a[0] - x) * (c[2] - z)) / d;
            return l1 >= -1e-9 && l2 >= -1e-9 && l1 + l2 <= 1 + 1e-9;
        };
        let twice = 0, lost = 0, points = 0;
        for (let x = 54.05; x < 66; x += 0.1) for (let z = -3.95; z < 4; z += 0.1) {
            const n = Number(ta.some(t => inTri(x, z, t))) + Number(tb.some(t => inTri(x, z, t)));
            points++;
            if (n === 2) twice++;
            if (n === 0) lost++;
        }
        expect(points).toBeGreaterThan(9000);
        expect(twice).toBe(0);
        expect(lost).toBe(0);
        // both cut edges run the street's width on the line, every cut corner on the surface it was cut from: no snap
        for (const t of [ta, tb]) {
            const onLine = t.flat().filter(p => Math.abs(p[0] - 60) < 1e-9);
            expect(Math.min(...onLine.map(p => p[2]))).toBeCloseTo(-4, 6);
            expect(Math.max(...onLine.map(p => p[2]))).toBeCloseTo(4, 6);
            for (const p of t.flat()) expect(Math.abs(p[1] - y(p[0], p[2]))).toBeLessThan(1e-4);
        }
        expect(ca.report.cut).toBeGreaterThan(0);
        expect(cb.report.cut).toBeGreaterThan(0);
        expect(ca.report.snapped + cb.report.snapped).toBe(0);
        // the cut pieces say what they are: the streets as measured, cut, nothing moved
        const notes = parseGlbBytes(cb.glb).json.meshes.flatMap((m: any) => m.primitives).map((p: any) => p.extras?.sbDistrictSeam?.provenance).filter(Boolean);
        expect(notes.length).toBeGreaterThan(0);
        for (const n of notes) expect(n).toBe("as measured: the chunk's streets cut at its cell lines");
    });

    it("gives each triangle's cut corner that triangle's own UVs across a UV seam", () => {
        // two triangles sharing the edge (62, -1)-(58, 1) by position only: each its own vertices, its own photo island
        const pos = [58, 0, -1, 62, 0, -1, 58, 0, 1, 62, 0, -1, 62, 0, 1, 58, 0, 1];
        const island = (x: number, z: number, k: number) => [x / 100 + k * 0.5, z / 100 + k * 0.5];
        const uv = [0, 1, 2].flatMap(i => island(pos[i * 3], pos[i * 3 + 2], 0)).concat([3, 4, 5].flatMap(i => island(pos[i * 3], pos[i * 3 + 2], 1)));
        const glb = writeStagedGlb([{ name: 'g', positions: Float32Array.from(pos), indices: Uint32Array.from([0, 1, 2, 3, 4, 5]), uv: Float32Array.from(uv) }], { texture: { bytes: encodePng(4, 4, new Uint8Array(48).fill(90), 3), mimeType: 'image/png' } });
        const g = parseGlbBytes(cutChunkLayer(glb, plan, centre).glb);
        let checked = 0;
        for (const m of g.json.meshes) for (const p of m.primitives) {
            const X = readAccessor(g, p.attributes.POSITION).data, T = readAccessor(g, p.attributes.TEXCOORD_0).data, I = readAccessor(g, p.indices).data;
            for (let t = 0; t + 2 < I.length; t += 3) {
                if (I[t] === I[t + 1] || I[t + 1] === I[t + 2]) continue;
                // every corner of a kept triangle maps by one island, the same for all three
                const k = Math.round((T[I[t] * 2] - X[I[t] * 3] / 100) / 0.5);
                for (let j = 0; j < 3; j++) {
                    const v = I[t + j], want = island(X[v * 3], X[v * 3 + 2], k);
                    expect(T[v * 2]).toBeCloseTo(want[0], 5);
                    expect(T[v * 2 + 1]).toBeCloseTo(want[1], 5);
                }
                checked++;
            }
        }
        expect(checked).toBeGreaterThanOrEqual(2);
    });

    it("levels the two chunks' photos to each other, halfway each, where they show the same street", () => {
        const samples = new Map([[centre, sampleSeamColour(a, plan)], [east, sampleSeamColour(b, plan)]]);
        // both sampled the shared 6 m band either side of the line on the one grid
        expect(samples.get(centre)!.size).toBeGreaterThan(200);
        const { gains, fields, report } = solveSeamGains(samples, plan);
        const ratio = srgbToLinear(130 / 255) / srgbToLinear(100 / 255);
        const ga = gains.get(centre)!, gb = gains.get(east)!;
        for (let q = 0; q < 3; q++) {
            expect(ga[q] / gb[q]).toBeCloseTo(ratio, 3);
            expect(ga[q] * gb[q]).toBeCloseTo(1, 6);
        }
        expect(report.pairs).toHaveLength(1);
        expect(report.pairs[0].stepBeforePct).toBeGreaterThan(30);
        expect(report.pairs[0].stepAfterPct).toBeLessThan(0.5);
        // one even step: the gains take all of it, the fields nothing
        expect(report.pairs[0].stepAfterFieldPct).toBeLessThan(0.5);
        expect(Math.max(...seamFieldAt(fields.get(centre), 60, 0).map(Math.abs))).toBeLessThan(0.01);
    });

    it("levels the chunks' brightness in full but their hue only a little, so no chunk is tinted", () => {
        // the east chunk's photo is brighter and bluer than the centre's
        const a3 = ground(50, 64, -5, 5, 1, () => 0, 100), b3 = ground(56, 70, -5, 5.5, 0.5, () => 0.05, [120, 125, 170]);
        const { gains, report } = solveSeamGains(new Map([[centre, sampleSeamColour(a3, plan)], [east, sampleSeamColour(b3, plan)]]), plan);
        const ga = gains.get(centre)!, gb = gains.get(east)!;
        // each gain changes one channel against the others by at most 3% (maxHueShift)
        for (const g of [ga, gb]) expect(Math.max(...g) / Math.min(...g)).toBeLessThanOrEqual(Math.exp(0.06) + 1e-9);
        // the brightness step between them is gone
        const lum = (v: number[]) => 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
        const ca = lum([0, 1, 2].map(q => srgbToLinear(100 / 255) * ga[q])), cb = lum([0, 1, 2].map(q => srgbToLinear([120, 125, 170][q] / 255) * gb[q]));
        expect(Math.abs(Math.log(cb / ca))).toBeLessThan(0.01);
        expect(report.pairs[0].stepAfterPct).toBeLessThan(1);
    });

    it('meets on one colour all along a line whose step changes along it, and leaves each chunk\'s inside as it was', () => {
        // the east chunk's photo is 40 levels brighter for z < 0 than the centre's, and the same for z > 0
        const long = (x0: number, x1: number, grey: number | ((row: number) => number)) => ground(x0, x1, -60, 60, 1, () => 0, grey);
        const a2 = long(50, 64, 100), b2 = long(56, 70, row => (row < 2 ? 140 : 100));
        const samples = new Map([[centre, sampleSeamColour(a2, plan)], [east, sampleSeamColour(b2, plan)]]);
        const { gains, fields, report } = solveSeamGains(samples, plan);
        const p = report.pairs[0];
        // one gain per chunk leaves the step on one half or the other; the fields close it along the whole line
        expect(p.stepAfterPct).toBeGreaterThan(5);
        expect(p.stepAfterFieldPct!).toBeLessThan(3);
        const lin = (c: number) => srgbToLinear(c / 255), lum = (v: number[]) => 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
        for (const z of [-40, -20, 20, 40]) {
            const fa = seamFieldAt(fields.get(centre), 60, z), fb = seamFieldAt(fields.get(east), 60, z);
            const ga = gains.get(centre)!, gb = gains.get(east)!;
            const ca = lum([0, 1, 2].map(q => lin(100) * ga[q] * Math.exp(fa[q]))), cb = lum([0, 1, 2].map(q => lin(z < 0 ? 140 : 100) * gb[q] * Math.exp(fb[q])));
            expect(Math.abs(Math.log(cb / ca))).toBeLessThan(0.03);
        }
        // 30 m inside each chunk its correction is gone
        expect(seamFieldAt(fields.get(centre), 25, -40)).toEqual([0, 0, 0]);
        expect(seamFieldAt(fields.get(east), 95, -40)).toEqual([0, 0, 0]);
        // applied: vertex colours carry it (darkening, lossless) or texels and vertex colours (brightening)
        const out = applySeamGain(b2, gains.get(east)!, fields.get(east));
        expect(['vertex', 'texels+vertex']).toContain(out.mode);
        const g = parseGlbBytes(out.glb), prim = g.json.meshes[0].primitives[0];
        expect(prim.attributes.COLOR_0).toBeDefined();
        const col = readAccessor(g, prim.attributes.COLOR_0).data;
        expect(Math.max(...col)).toBeLessThanOrEqual(1);
    });

    it('puts a darkening gain in the material factor and a brightening one in the photo texels', () => {
        const dark = applySeamGain(b, [0.9, 0.8, 0.95]);
        expect(dark.mode).toBe('factor');
        const dm = parseGlbBytes(dark.glb).json.materials.find((m: any) => m.pbrMetallicRoughness?.baseColorTexture);
        expect(dm.pbrMetallicRoughness.baseColorFactor.slice(0, 3).map((x: number) => Math.round(x * 1000) / 1000)).toEqual([0.9, 0.8, 0.95]);
        const bright = applySeamGain(a, [1.2, 1.2, 1.2]);
        expect(parseGlbBytes(bright.glb).json.meshes[0].primitives[0].attributes.COLOR_0).toBeUndefined();
        expect(bright.mode).toBe('texels');
        expect(bright.images).toBe(1);
        const g = parseGlbBytes(bright.glb), v = g.json.bufferViews[g.json.images[0].bufferView];
        const img = decodeImageInMemory(g.bin.subarray(v.byteOffset, v.byteOffset + v.byteLength));
        const want = srgbToLinear(100 / 255) * 1.2, got = srgbToLinear(img.rgba[0] / 255);
        expect(Math.abs(got - want) / want).toBeLessThan(0.01);
        expect(g.json.extras.sbDistrictSeamGain.provenance).toMatch(/^generated/);
        // a gain within the epsilon of 1 leaves the file as it was
        expect(applySeamGain(a, [1, 1.001, 0.999]).mode).toBe('none');
    });
});

describe('pipeline K-D: the join keeps what reaches the chunk', () => {
    it('keeps a long triangle whose middle lies past the band but which covers ground the chunk keeps', () => {
        // one thin triangle from x 59 (kept ground) out to x 80 (past the band): its middle at x 72
        const glb = writeStagedGlb([{ name: 'g', positions: Float32Array.from([59, 0, 0, 80, 0, 1, 80, 0, -1]), indices: Uint32Array.from([0, 1, 2]) }]);
        const identity = Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
        expect(joinChunkGlb(glb, identity, x => x < 63).keptTriangles).toBe(1);
        expect(joinChunkGlb(glb, identity, x => x < 58).keptTriangles).toBe(0);
    });
});
