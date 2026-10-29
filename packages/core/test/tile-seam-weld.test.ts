/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Tile-chunk seam weld (scratchbox_tile_seam_weld.hpp behind scripts/tile_seam_weld.cpp, run through
 * runTileSeamWeld) on synthetic scans written as a photogrammetric tile arrives: one primitive per chunk, the
 * chunks' borders a centimetre or two apart instead of coinciding.
 *
 *   1. a 2 cm gap between two wall chunks is closed: the moving chunk's border lands exactly on the other's,
 *      nothing else moves, the texture passes through;
 *   2. the strip that bridged a gap collapses with the weld and is dropped; the walls stay;
 *   3. distinct surfaces near each other are left alone: a parallel patch beyond the tolerance, a patch whose
 *      edge stands 1 cm in front of a wall's interior (not its border), a closed box (no border at all);
 *   4. a move that would turn a kept triangle inside out is taken back and counted;
 *   5. a bad tolerance and a missing input are refused before anything runs;
 *   6. T-junctions: two chunks whose border points interleave are split into each other's edges, so no seam edge is left open;
 *   7. overlap trim: the column of a chunk lying over its neighbour goes, and the rest is welded.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { type Chunk, quad, writeGlb, readGlb, encodePng } from './helpers/synthetic-scan-glb';
import { runTileSeamWeld, TileSeamWeldError } from '../src/node/3d-engine/tile-seam-weld-service';
import { parseGlbBytes, readAccessor } from '../src/node/3d-engine/staged-location/glb-bytes';

const REPO = path.resolve(__dirname, '../../..');
const WORK = path.join(REPO, 'test-results', 'tile_seam_weld');
const BIN = path.join(REPO, 'build', '3d-native', 'tile_seam_weld_test');

/** Compiles scripts/tile_seam_weld.cpp to BIN unless it is newer than the CLI and every engine header. */
function buildDriver(): void {
    const include = path.join(REPO, 'packages/core/src/native/3d-engine/include');
    const sources = [path.join(REPO, 'scripts/tile_seam_weld.cpp'), ...fs.readdirSync(include).map(f => path.join(include, f))];
    const newest = Math.max(...sources.map(f => fs.statSync(f).mtimeMs));
    if (fs.existsSync(BIN) && fs.statSync(BIN).mtimeMs >= newest) return;
    fs.mkdirSync(path.dirname(BIN), { recursive: true });
    execFileSync(process.env.CXX || 'clang++', ['-std=c++20', '-O2', '-pthread', '-I', include, path.join(REPO, 'scripts/tile_seam_weld.cpp'), '-o', BIN, '-lz'], { stdio: 'pipe', timeout: 600_000 });
}

/** Every output position as [x, y, z] (across primitives). */
function positions(file: string): Array<[number, number, number]> {
    const out: Array<[number, number, number]> = [];
    for (const col of readGlb(file).attribute('POSITION')) for (let i = 0; i + 2 < col.length; i += 3) out.push([col[i], col[i + 1], col[i + 2]]);
    return out;
}

function triangleCount(file: string): number {
    const g = readGlb(file);
    let n = 0;
    for (const m of g.json.meshes) for (const p of m.primitives) n += g.json.accessors[p.indices].count / 3;
    return n;
}

const near = (a: number, b: number, tol = 1e-5) => Math.abs(a - b) <= tol;

/** Triangles of the output as corner positions (across primitives). */
function triangles(file: string): Array<Array<[number, number, number]>> {
    const g = parseGlbBytes(fs.readFileSync(file)), out: Array<Array<[number, number, number]>> = [];
    for (const m of g.json.meshes) for (const pr of m.primitives) {
        const P = readAccessor(g, pr.attributes.POSITION).data, I = readAccessor(g, pr.indices).data;
        for (let t = 0; t + 2 < I.length; t += 3) out.push([0, 1, 2].map(k => [P[I[t + k] * 3], P[I[t + k] * 3 + 1], P[I[t + k] * 3 + 2]] as [number, number, number]));
    }
    return out;
}

/** Edges used by exactly one triangle, positions welded at 0.01 mm. */
function openEdges(tris: Array<Array<[number, number, number]>>): Array<[[number, number, number], [number, number, number]]> {
    const k = (p: [number, number, number]) => p.map(v => Math.round(v * 1e5)).join(',');
    const count = new Map<string, { n: number; a: [number, number, number]; b: [number, number, number] }>();
    for (const t of tris) for (let i = 0; i < 3; i++) {
        const a = t[i], b = t[(i + 1) % 3], ka = k(a), kb = k(b);
        if (ka === kb) continue;
        const e = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
        const c = count.get(e) ?? { n: 0, a, b };
        c.n++; count.set(e, c);
    }
    return [...count.values()].filter(c => c.n === 1).map(c => [c.a, c.b]);
}

/** Distinct positions (the GLB writer may repeat a position per primitive or across a crease). */
function distinct(P: Array<[number, number, number]>): Array<[number, number, number]> {
    const seen = new Map<string, [number, number, number]>();
    for (const p of P) seen.set(`${p[0].toFixed(5)}_${p[1].toFixed(5)}_${p[2].toFixed(5)}`, p);
    return [...seen.values()];
}

/** A vertical wall in the plane z = 0 from x0 to x1, 3 m high, 0.5 m cells (normal +z). */
const wall = (x0: number, x1: number) => quad([x0, 0, 0], [x1 - x0, 0, 0], [0, 3, 0], Math.round((x1 - x0) / 0.5), 6);

async function weld(name: string, chunks: Chunk[], opts: { images?: Buffer[]; toleranceM?: number; dropSlivers?: boolean; overlapTrim?: boolean; tJunctions?: boolean } = {}) {
    const input = path.join(WORK, `${name}.glb`), output = path.join(WORK, `${name}_welded.glb`);
    writeGlb(input, chunks, opts.images ?? []);
    const r = await runTileSeamWeld({ inputGlb: input, outputGlb: output, toleranceM: opts.toleranceM, dropSlivers: opts.dropSlivers, overlapTrim: opts.overlapTrim, tJunctions: opts.tJunctions, threads: 2, repoRoot: REPO });
    const b = fs.readFileSync(output);
    expect(b.readUInt32LE(0)).toBe(0x46546c67);  // 'glTF'
    return { r, input, output, positions: positions(output) };
}

describe('tile_seam_weld on synthetic tile chunks', () => {
    beforeAll(() => {
        fs.mkdirSync(WORK, { recursive: true });
        buildDriver();
        process.env.SCRATCHBOX_TILE_SEAM_WELD_BIN = BIN;
    });

    it('closes a 2 cm chunk gap onto the neighbour border, moves nothing else and keeps the texture', async () => {
        // chunk A: x in [0, 2]; chunk B: x in [2.02, 4] (a 2 cm seam gap); A textured
        const a: Chunk = { ...wall(0, 2), image: 0 };
        a.uvs = [];
        for (let i = 0; i < a.positions.length; i += 3) a.uvs.push(a.positions[i] / 2, a.positions[i + 1] / 3);
        const png = encodePng(4, 4, new Uint8Array(4 * 4 * 3).fill(200));
        const { r, positions: Pall, output } = await weld('gap', [a, wall(2.02, 4)], { images: [png] });
        const P = distinct(Pall);
        expect(r.seamWeld.pieces).toBe(2);
        expect(r.seamWeld.contactsFound).toBe(14);         // 7 border positions on each side see the other
        expect(r.seamWeld.groupsWelded).toBe(7);           // exactly one side moves
        expect(r.seamWeld.vertsWelded).toBe(7);
        expect(r.seamWeld.groupsReverted).toBe(0);
        expect(r.seamWeld.trianglesDropped).toBe(0);
        expect(near(r.seamWeld.maxWeldDisplacementM, 0.02, 1e-4)).toBe(true);
        expect(r.seamWeld.gapHistogram).toEqual([0, 0, 0, 14, 0, 0]);
        expect(r.inputTriangles).toBe(96);
        expect(r.outputTriangles).toBe(96);
        expect(triangleCount(output)).toBe(96);
        // nothing left in the gap; both borders now share x = 2 exactly; B's interior column is where it was
        expect(P.filter(p => p[0] > 2.0001 && p[0] < 2.0199).length).toBe(0);
        expect(P.filter(p => near(p[0], 2)).length).toBe(7);          // the two borders are one line of points now
        expect(P.filter(p => near(p[0], 2.515, 1e-4)).length).toBe(7);
        expect(P.filter(p => near(p[0], 0.5)).length).toBe(7);
        // the welded border keeps its height and plane
        for (const p of P.filter(p => near(p[0], 2))) { expect(near(p[2], 0)).toBe(true); expect(p[1] % 0.5).toBeCloseTo(0, 5); }
        // the texture passed through
        const g = readGlb(output);
        expect(g.json.images?.length).toBe(1);
        expect(g.attribute('TEXCOORD_0').length).toBeGreaterThan(0);
    });

    it('drops the strip that bridged the gap once the weld collapses it, and keeps both walls', async () => {
        // a separate 1.8 cm strip lies in the 2 cm seam (2.001..2.019), 1 mm from each wall's border: a piece that is a
        // sliver everywhere is dropped whole, and the walls it stood between are then welded to each other
        const strip = quad([2.001, 0, 0], [0.018, 0, 0], [0, 3, 0], 1, 6);
        const { r, positions: Pall, output } = await weld('strip', [wall(0, 2), wall(2.02, 4), strip]);
        const P = distinct(Pall);
        expect(r.seamWeld.pieces).toBe(3);
        expect(r.seamWeld.stripPiecesDropped).toBe(1);
        expect(r.seamWeld.stripTrianglesDropped).toBe(12);  // the strip: 1 x 6 cells x 2
        expect(r.seamWeld.trianglesDropped).toBe(12);
        expect(r.seamWeld.groupsWelded).toBe(7);           // B's border onto A, the strip no longer in the way
        expect(near(r.seamWeld.maxWeldDisplacementM, 0.02, 1e-4)).toBe(true);
        expect(r.inputTriangles).toBe(108);
        expect(r.outputTriangles).toBe(96);
        expect(triangleCount(output)).toBe(96);
        expect(P.filter(p => p[0] > 2.0001 && p[0] < 2.0199).length).toBe(0);
        expect(P.filter(p => near(p[0], 2)).length).toBe(7);
        expect(P.filter(p => near(p[0], 2.515, 1e-4)).length).toBe(7);  // B's first interior column: 2.02 + 1.98 / 4
    });

    it('does not weld distinct surfaces that merely stand near each other', async () => {
        const a = wall(0, 2);
        // (i) a parallel open patch 5 cm in front of A, same extent: beyond the tolerance (+ pad), not even a contact
        const parallel = quad([0, 0, 0.05], [2, 0, 0], [0, 3, 0], 4, 6);
        // (ii) a shelf whose edge stands 1 cm in front of A's interior (A's interior positions are not border positions)
        const shelf = quad([1, 1, 0.01], [0.5, 0, 0], [0, 0, 0.5], 1, 1);
        // (iii) a closed box 1 cm from A's border: no border of its own, nothing to weld
        const box: Chunk = { positions: [], indices: [] };
        const faces = [
            quad([2.01, 0, 0], [0.5, 0, 0], [0, 0.5, 0], 1, 1), quad([2.01, 0, -0.5], [0, 0.5, 0], [0.5, 0, 0], 1, 1),
            quad([2.01, 0, -0.5], [0.5, 0, 0], [0, 0, 0.5], 1, 1), quad([2.01, 0.5, 0], [0.5, 0, 0], [0, 0, -0.5], 1, 1),
            quad([2.01, 0, 0], [0, 0.5, 0], [0, 0, -0.5], 1, 1), quad([2.51, 0, -0.5], [0, 0.5, 0], [0, 0, 0.5], 1, 1)
        ];
        for (const f of faces) { const base = box.positions.length / 3; box.positions.push(...f.positions); box.indices.push(...f.indices.map(i => i + base)); }
        const before = [a, parallel, shelf, box].flatMap(c => c.positions);
        const { r, positions: P } = await weld('distinct', [a, parallel, shelf, box]);
        expect(r.seamWeld.contactsFound).toBe(0);
        expect(r.seamWeld.groupsWelded).toBe(0);
        expect(r.seamWeld.trianglesDropped).toBe(0);
        expect(r.outputTriangles).toBe(r.inputTriangles);
        // every input position is still present (the writer welds coincident positions, so compare as a set)
        const key = (x: number, y: number, z: number) => `${Math.fround(x).toFixed(5)}_${Math.fround(y).toFixed(5)}_${Math.fround(z).toFixed(5)}`;
        const out = new Set(P.map(p => key(p[0], p[1], p[2])));
        for (let i = 0; i < before.length; i += 3) expect(out.has(key(before[i], before[i + 1], before[i + 2]))).toBe(true);
    });

    it('takes back a move that would turn a kept triangle inside out', async () => {
        // B's border position at (2.02, 1.5) is the apex of a small triangle whose opposite edge stands at x = 2.018: the
        // 2 cm move onto A would cross that edge (the triangle turns), and the turned triangle is no sliver (its
        // altitude would be 1.8 cm, above the 1.5 cm sliver floor), so the move is reverted
        const b = wall(2.02, 4);
        const apex = 3 * 5;  // j = 3 (y = 1.5), i = 0 (the border column) in a 5-wide grid
        const n = b.positions.length / 3;
        b.positions.push(2.018, 1.56, 0, 2.018, 1.44, 0);
        b.indices.push(apex, n, n + 1);
        // the T-junction pass would then close the small triangle's corners onto A's border edges (its own case, below)
        const { r, positions: Pall } = await weld('turn', [wall(0, 2), b], { tJunctions: false });
        const P = distinct(Pall);
        expect(r.seamWeld.groupsReverted).toBe(1);
        expect(r.seamWeld.groupsWelded).toBe(6);
        expect(r.seamWeld.trianglesDropped).toBe(0);
        expect(P.filter(p => near(p[0], 2.02, 1e-4) && near(p[1], 1.5)).length).toBe(1);  // the apex stayed
        expect(P.filter(p => near(p[0], 2) && near(p[1], 1.5)).length).toBe(1);            // A's own border point only
        expect(P.filter(p => near(p[0], 2)).length).toBe(7);                                // A's border; B's 6 welded points coincide with it
    });

    it('keeps the strip when sliver dropping is off, and refuses a bad tolerance or a missing input', async () => {
        const strip = quad([2.001, 0, 0], [0.018, 0, 0], [0, 3, 0], 1, 6);
        const { r } = await weld('nodrop', [wall(0, 2), wall(2.02, 4), strip], { dropSlivers: false });
        expect(r.dropSlivers).toBe(false);
        expect(r.seamWeld.stripPiecesDropped).toBe(0);
        expect(r.seamWeld.groupsWelded).toBe(14);          // the strip stays: its edges weld onto A and onto B's border
        expect(r.seamWeld.trianglesDropped).toBe(0);
        expect(r.outputTriangles).toBe(108);
        // a tolerance below the gap welds nothing
        const tight = await weld('tight', [wall(0, 2), wall(2.02, 4)], { toleranceM: 0.01 });
        expect(tight.r.seamWeld.groupsWelded).toBe(0);
        expect(tight.r.seamWeld.contactsFound).toBe(14);  // still seen within tolerance + pad
        await expect(runTileSeamWeld({ inputGlb: path.join(WORK, 'gap.glb'), toleranceM: 0, repoRoot: REPO })).rejects.toMatchObject({ code: 'bad_request' });
        await expect(runTileSeamWeld({ inputGlb: path.join(WORK, 'nope.glb'), repoRoot: REPO })).rejects.toBeInstanceOf(TileSeamWeldError);
    });

    it('splits each chunk\'s border edges at the other\'s points where they interleave, so no seam edge is left open', async () => {
        // A: 0.5 m rows (border points at y = 0, 0.5 .. 3); B, 2 cm on: 0.75 m rows (y = 0, 0.75 .. 3). The weld joins the
        // shared heights (0, 1.5, 3); the rest each lie on the other's border edge: A's 0.5, 1, 2, 2.5 on B's, B's 0.75, 2.25 on A's
        const b = quad([2.02, 0, 0], [1.98, 0, 0], [0, 3, 0], 4, 4);
        const onSeam = (e: [[number, number, number], [number, number, number]]) => near(e[0][0], 2, 1e-4) && near(e[1][0], 2, 1e-4);
        const off = await weld('tjunction_off', [wall(0, 2), b], { tJunctions: false });
        expect(off.r.tJunctions).toBeUndefined();
        expect(openEdges(triangles(off.output)).filter(onSeam).length).toBeGreaterThan(0);
        const { r, output } = await weld('tjunction', [wall(0, 2), b]);
        expect(r.tJunctions!.closed).toBe(6);
        expect(r.tJunctions!.reverted).toBe(0);
        expect(r.tJunctions!.maxMoveM).toBeLessThanOrEqual(0.03);
        expect(r.outputTriangles).toBe(r.inputTriangles + 6);   // each split adds one triangle
        // every seam edge is now shared by both chunks: the only open edges left are the scan's outer border
        const open = openEdges(triangles(output));
        expect(open.filter(onSeam)).toHaveLength(0);
        for (const [p, q] of open) expect(near(p[1], 0) && near(q[1], 0) || near(p[1], 3) && near(q[1], 3) || near(p[0], 0) && near(q[0], 0) || near(p[0], 4) && near(q[0], 4)).toBe(true);
    });

    it('trims the column of a chunk that lies over its neighbour, then welds the rest', async () => {
        // B starts 10 cm before A ends, 1 cm in front of it: its first 0.1 m column lies over A and goes; its next border welds onto A's
        const b = quad([1.9, 0, 0.01], [2.1, 0, 0], [0, 3, 0], 21, 6);
        const { r, output } = await weld('overlap', [wall(0, 2), b]);
        expect(r.overlapTrim!.trianglesDropped).toBe(12);
        expect(r.overlapTrim!.areaM2).toBeCloseTo(0.3, 2);
        const tris = triangles(output);
        expect(tris.filter(t => { const cx = (t[0][0] + t[1][0] + t[2][0]) / 3, cz = (t[0][2] + t[1][2] + t[2][2]) / 3; return cx > 1.9 && cx < 2 && cz > 0.005; })).toHaveLength(0);
        expect(r.seamWeld.groupsWelded).toBe(7);
        // without the trim both surfaces stay
        const keep = await weld('overlap_off', [wall(0, 2), b], { overlapTrim: false });
        expect(keep.r.overlapTrim).toBeUndefined();
        expect(keep.r.outputTriangles).toBeGreaterThan(r.outputTriangles);
    });
});
