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
 *
 * Then by source tile (one node per chunk, as the crawler writes a leaf, with its stated geometric error):
 *   8. a 15 cm gap between two coplanar tiles of different resolution, beyond the fixed passes, is closed by the adaptive
 *      close and measured by the seam audit (before, after the fixed passes, after);
 *   9. pairs whose surfaces do not agree (a step, a wall standing at the border) and a gap beyond the tiles' stated error
 *      are left as they are;
 *  10. agreed gaps no close may move are bridged by the strip fill, drawn with a material labelled generated;
 *  11. the node -> tile file the service writes for the CLI;
 *  12. the tone feather: two tiles' photos of one wall, cut across by their boxes, levelled toward each other at the cut,
 *      faded out away from it, labelled, and left alone without boxes or when not asked for;
 *  13. the cap trim: the strips two tiles carry back to back in their shared cut plane go, the walls stay;
 *  14. the step blend and the per-cut scores: two walls 6 cm apart in depth at their cut meet on one surface there, each
 *      moved half way and not at all 1.5 m from the cut, and the weld then closes them.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { type Chunk, quad, flat, writeGlb, readGlb, encodePng } from './helpers/synthetic-scan-glb';
import { runTileSeamWeld, TileSeamWeldError, tileSeamTilesFile, type TileSeamWeldRequest } from '../src/node/3d-engine/tile-seam-weld-service';
import { parseGlb, serializeGlb } from '../src/node/3d-engine/glb-geometry-patcher';
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

    it('carries the scan\'s frame (document extras) onto the welded scan and its clay', async () => {
        const input = path.join(WORK, 'framed.glb'), output = path.join(WORK, 'framed_welded.glb'), clay = path.join(WORK, 'framed_clay.glb');
        writeGlb(input, [wall(0, 2), wall(2.02, 4)]);
        const localToEcef = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1334000.5, -4654000.25, 4138000.75, 1];
        const doc = parseGlb(fs.readFileSync(input));
        doc.json.extras = { frame: 'enu', anchor: { lat: 40.748545, lng: -73.985763 }, localToEcef };
        fs.writeFileSync(input, serializeGlb(doc));
        await runTileSeamWeld({ inputGlb: input, outputGlb: output, outputClayGlb: clay, threads: 2, repoRoot: REPO });
        for (const out of [output, clay]) {
            const extras = parseGlb(fs.readFileSync(out)).json.extras as any;
            expect(extras.localToEcef).toEqual(localToEcef);
            expect(extras.anchor).toEqual({ lat: 40.748545, lng: -73.985763 });
        }
        expect(positions(output).length).toBeGreaterThan(0);
    });
});

describe('tile_seam_weld by source tile: the seam audit, the adaptive close and the strip fill', () => {
    beforeAll(() => {
        fs.mkdirSync(WORK, { recursive: true });
        buildDriver();
        process.env.SCRATCHBOX_TILE_SEAM_WELD_BIN = BIN;
    });

    /** Each chunk its own tile (node), stating `errorM`; the passes as asked. */
    async function weldTiles(name: string, chunks: Chunk[], errorM: number | undefined, opts: Partial<TileSeamWeldRequest> = {}) {
        const input = path.join(WORK, `${name}.glb`), output = path.join(WORK, `${name}_welded.glb`);
        writeGlb(input, chunks, [], chunks.map((_, i) => ({ leafId: `leaf-${i}`, geometricErrorM: errorM })));
        const r = await runTileSeamWeld({ inputGlb: input, outputGlb: output, threads: 2, repoRoot: REPO, adaptive: true, ...opts });
        return { r, output };
    }
    // two ground tiles meeting at x = 10, B starting 15 cm on: A in 0.5 m cells, B in 0.758 m cells (their border points interleave)
    const groundA = () => flat(0, 10, 0, 10, 0, 20);
    const groundB = (x0 = 10.15, y = 0) => flat(x0, 20, 0, 10, y, 13);
    const onSeam = (e: [[number, number, number], [number, number, number]]) =>
        e.every(p => p[0] > 9.99 && p[0] < 10.16) && e.every(p => p[2] > 0.01 && p[2] < 9.99);
    const seamBands = (a: { bandLengthM: number[] }) => a.bandLengthM.slice(0, 4).reduce((x, y) => x + y, 0);

    it('closes a 15 cm gap between coplanar tiles up to their stated error, and the audit measures it', async () => {
        const { r, output } = await weldTiles('adaptive_gap', [groundA(), groundB()], 2.0);
        expect(r.tiles).toEqual({ count: 2, nodesNamed: 2, withStatedError: 2 });
        const au = r.seamAudit!;
        // the seam's open edges inside the cut border (2 m in from the scan's edge), 10-30 cm from the other tile's
        expect(au.before.bandLengthM[2]).toBeGreaterThan(8);
        expect(au.before.bandLengthM[0] + au.before.bandLengthM[1] + au.before.bandLengthM[3]).toBe(0);
        expect(au.before.atCutM).toBeGreaterThan(30);   // the scan's own outline
        // the fixed 3 cm passes do not reach it; the adaptive close does
        expect(au.afterFixed.bandLengthM[2]).toBeCloseTo(au.before.bandLengthM[2], 1);
        expect(seamBands(au.after)).toBe(0);
        const ad = r.adaptive!;
        expect(ad.capM).toBeCloseTo(0.3, 6);
        expect(ad.maxToleranceM).toBeCloseTo(0.3, 6);   // min(2, 2) capped at 30 cm
        expect(ad.agreed).toBe(ad.candidates);
        expect(ad.refusedNormal + ad.refusedParallel + ad.refusedStep + ad.refusedNoSurface).toBe(0);
        expect(ad.normalAngleHist[0]).toBe(ad.candidates);
        expect(ad.agreedByGap[2]).toBeGreaterThan(0);
        expect(ad.splitsClosed).toBeGreaterThan(0);
        expect(ad.guardRefused).toBe(0);
        expect(ad.maxMoveM).toBeLessThanOrEqual(0.16);
        expect(r.stripFill).toEqual({ edgesFilled: 0, triangles: 0, areaM2: 0, refused: 0 });
        // no seam edge is left open, and every position stays in the ground plane (the closes only slid along it)
        const tris = triangles(output);
        expect(openEdges(tris).filter(onSeam)).toHaveLength(0);
        for (const t of tris) for (const p of t) expect(Math.abs(p[1])).toBeLessThan(1e-6);
        // without the adaptive close the gap stays
        const off = await weldTiles('adaptive_gap_off', [groundA(), groundB()], 2.0, { adaptive: false });
        expect(off.r.adaptive).toBeUndefined();
        expect(off.r.seamAudit!.after.bandLengthM[2]).toBeCloseTo(au.before.bandLengthM[2], 1);
        expect(openEdges(triangles(off.output)).filter(onSeam).length).toBeGreaterThan(0);
    });

    it('leaves a step, a wall at the border and a gap beyond the stated error as they are', async () => {
        // B 10 cm higher than A: the surfaces face alike but do not continue each other
        const step = await weldTiles('adaptive_step', [groundA(), groundB(10.1, 0.1)], 2.0);
        expect(step.r.adaptive!.candidates).toBeGreaterThan(0);
        expect(step.r.adaptive!.refusedStep).toBe(step.r.adaptive!.candidates);
        expect(step.r.adaptive!.splitsClosed + step.r.adaptive!.vertexMoves).toBe(0);
        // a wall standing 10 cm beyond A's border: the surfaces meet at a right angle
        const wallB = quad([10.1, 0, 10], [0, 0, -10], [0, 3, 0], 13, 4);
        const corner = await weldTiles('adaptive_corner', [groundA(), wallB], 2.0);
        expect(corner.r.adaptive!.refusedNormal).toBe(corner.r.adaptive!.candidates);
        expect(corner.r.adaptive!.normalAngleHist[5] + corner.r.adaptive!.normalAngleHist[6]).toBe(corner.r.adaptive!.candidates);   // about 90 degrees
        expect(corner.r.adaptive!.splitsClosed + corner.r.adaptive!.vertexMoves).toBe(0);
        // tiles stating a 5 cm error: a 15 cm gap is beyond them, nothing is even a contact
        const tight = await weldTiles('adaptive_tight', [groundA(), groundB()], 0.05);
        expect(tight.r.adaptive!.candidates).toBe(0);
        expect(tight.r.adaptive!.maxToleranceM).toBe(0);
        expect(tight.r.seamAudit!.after.bandLengthM[2]).toBeCloseTo(tight.r.seamAudit!.before.bandLengthM[2], 1);
        // no stated error: the pair is held to the fixed tolerance (3 cm), and a 15 cm gap stays
        const none = await weldTiles('adaptive_unstated', [groundA(), groundB()], undefined);
        expect(none.r.tiles!.withStatedError).toBe(0);
        expect(none.r.adaptive!.candidates).toBe(0);
    });

    it('bridges the agreed gaps no close may move with strip triangles labelled generated', async () => {
        // maxTurnDeg 0: every close is taken back, so the strip fill bridges the whole agreed seam
        const { r, output } = await weldTiles('adaptive_fill', [groundA(), groundB()], 2.0, { maxTurnDeg: 0 });
        expect(r.adaptive!.splitsClosed + r.adaptive!.vertexMoves).toBe(0);
        expect(r.adaptive!.guardRefused).toBeGreaterThan(0);
        const sf = r.stripFill!;
        expect(sf.triangles).toBeGreaterThan(0);
        expect(sf.areaM2).toBeGreaterThan(1.2);   // the 15 cm x 10 m gap, less its ends
        expect(sf.areaM2).toBeLessThan(1.55);
        expect(seamBands(r.seamAudit!.after)).toBe(0);
        const tris = triangles(output);
        expect(openEdges(tris).filter(onSeam)).toHaveLength(0);
        // the bridge is drawn with a material of its own, labelled generated, and lies in the gap
        const g = readGlb(output);
        const labelled = (g.json.materials as any[]).map((m, i) => ({ m, i })).filter(({ m }) => m.extras?.scratchbox?.provenance === 'generated');
        expect(labelled).toHaveLength(1);
        expect(labelled[0].m.extras.scratchbox).toEqual({ photoInferredFill: true, provenance: 'generated', method: 'tile seam strip fill' });
        const doc = parseGlbBytes(fs.readFileSync(output));
        let fillTris = 0;
        for (const m of doc.json.meshes) for (const pr of m.primitives) {
            if (pr.material !== labelled[0].i) continue;
            const P = readAccessor(doc, pr.attributes.POSITION).data, I = readAccessor(doc, pr.indices).data;
            fillTris += I.length / 3;
            for (const v of I) { expect(P[v * 3]).toBeGreaterThan(9.99); expect(P[v * 3]).toBeLessThan(10.16); }
        }
        expect(fillTris).toBe(sf.triangles);
    });

    it('names each node\'s tile by its leaf and its stated error for the CLI', () => {
        const json = { nodes: [
            { name: 'root', children: [1, 2, 3, 4] },
            { mesh: 0, extras: { sb: { ids: { leafId: 'x' }, tile: { geometricErrorM: 2.01 } } } },
            { mesh: 1, extras: { sb: { ids: { leafId: 'y' } } } },
            { mesh: 2, extras: { sb: { ids: { leafId: 'x' }, tile: { geometricErrorM: 2.01 } } } },
            { mesh: 3 }
        ] };
        expect(tileSeamTilesFile(json)).toBe('5\n0 0\n1 2.01\n2 0\n1 2.01\n3 0\n');
        expect(tileSeamTilesFile(json, 4)).toBe('5\n0 4\n1 2.01\n2 4\n1 2.01\n3 4\n');
        // a box comes in the scan's frame: ECEF -> local by the document's localToEcef (here a quarter turn about y and a shift)
        const framed = { extras: { localToEcef: [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 100, 200, 300, 1] }, nodes: [{ mesh: 0, extras: { sb: { ids: { leafId: 'x' }, tile: { box: [101, 202, 303, 2, 0, 0, 0, 3, 0, 0, 0, 4] } } } }] };
        const line = tileSeamTilesFile(framed).split('\n')[1].split(' ').map(Number);
        expect(line.slice(0, 2)).toEqual([0, 0]);
        // local = R^T (ecef - t): R's columns are local x -> (0, 0, -1), y -> (0, 1, 0), z -> (1, 0, 0)
        expect(line.slice(2)).toEqual([-3, 2, 1, 0, 0, 2, 0, 3, 0, -4, 0, 0]);
    });
});

describe('tile_seam_weld tone feather: two tiles\' photos levelled toward each other across the cut their boxes share', () => {
    beforeAll(() => {
        fs.mkdirSync(WORK, { recursive: true });
        buildDriver();
        process.env.SCRATCHBOX_TILE_SEAM_WELD_BIN = BIN;
    });

    // a wall in z = 0 facing +z, x 0..10: tile A below y = 5, tile B above, each with its own uniform photo (64 x 64 texels)
    const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const wallTile = (y0: number, image: number): Chunk => {
        const c: Chunk = { ...quad([0, y0, 0], [10, 0, 0], [0, 5, 0], 10, 5), image };
        c.uvs = [];
        for (let i = 0; i < c.positions.length; i += 3) c.uvs.push(c.positions[i] / 10, 1 - (c.positions[i + 1] - y0) / 5);
        return c;
    };
    const grey = (v: number) => encodePng(64, 64, new Uint8Array(64 * 64 * 3).fill(v));
    const boxOf = (y0: number) => [5, y0 + 2.5, 0, 5, 0, 0, 0, 2.5, 0, 0, 0, 1];
    /** The mean grey of each tile's photo in rows of texels, by the row's distance from the cut (m). */
    function rowMeans(file: string) {
        const doc = parseGlbBytes(fs.readFileSync(file));
        const out: Array<{ material: any; rows: Array<{ d: number; v: number }> }> = [];
        for (const m of doc.json.meshes) for (const pr of m.primitives) {
            const mat = doc.json.materials[pr.material];
            const img = doc.json.images[doc.json.textures[mat.pbrMetallicRoughness.baseColorTexture.index].source];
            const view = doc.json.bufferViews[img.bufferView];
            const bytes = Buffer.from(doc.bin.buffer, doc.bin.byteOffset + (view.byteOffset ?? 0), view.byteLength);
            const P = readAccessor(doc, pr.attributes.POSITION).data;
            let ySum = 0;
            for (let i = 1; i < P.length; i += 3) ySum += P[i];
            const below = ySum / (P.length / 3) < 5;   // tile A lies below the cut, B above it
            const px = decodePngRgb(bytes);
            const rows: Array<{ d: number; v: number }> = [];
            for (let y = 0; y < px.height; y++) {
                let sum = 0;
                for (let x = 0; x < px.width; x++) sum += px.data[(y * px.width + x) * 3];
                // v = 1 - (wy - y0) / 5: A's row y sits at world y = 5 (1 - (y + 0.5) / 64); its distance from the cut is 5 - that
                const wy = 5 * (1 - (y + 0.5) / px.height);
                rows.push({ d: below ? 5 - wy : wy, v: sum / px.width });
            }
            out.push({ material: mat, rows });
        }
        return out;
    }
    function decodePngRgb(png: Buffer): { width: number; height: number; data: Uint8Array } {
        const zlibMod = require('zlib') as typeof import('zlib');
        let o = 8, w = 0, h = 0; const idat: Buffer[] = [];
        while (o < png.length) {
            const len = png.readUInt32BE(o), type = png.toString('ascii', o + 4, o + 8), data = png.subarray(o + 8, o + 8 + len);
            if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); }
            if (type === 'IDAT') idat.push(data);
            o += 12 + len;
        }
        const raw = zlibMod.inflateSync(Buffer.concat(idat)), stride = w * 3, out = new Uint8Array(w * h * 3);
        for (let y = 0; y < h; y++) {
            const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
            for (let i = 0; i < stride; i++) {
                const a = i >= 3 ? out[y * stride + i - 3] : 0, b = y > 0 ? out[(y - 1) * stride + i] : 0, c = i >= 3 && y > 0 ? out[(y - 1) * stride + i - 3] : 0;
                const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
                const pred = f === 1 ? a : f === 2 ? b : f === 3 ? ((a + b) >> 1) : f === 4 ? (pa <= pb && pa <= pc ? a : pb <= pc ? b : c) : 0;
                out[y * stride + i] = (line[i] + pred) & 255;
            }
        }
        return { width: w, height: h, data: out };
    }

    it('levels the two photos toward each other at the cut, fades out over the band, and labels them', async () => {
        const input = path.join(WORK, 'tone.glb'), output = path.join(WORK, 'tone_welded.glb');
        writeGlb(input, [wallTile(0, 0), wallTile(5, 1)], [grey(110), grey(150)],
            [{ leafId: 'a', geometricErrorM: 2, box: boxOf(0) }, { leafId: 'b', geometricErrorM: 2, box: boxOf(5) }], { localToEcef: IDENTITY });
        const r = await runTileSeamWeld({ inputGlb: input, outputGlb: output, tone: true, threads: 2, repoRoot: REPO });
        const t = r.tone!;
        expect(t.tilesBoxed).toBe(2);
        expect(t.cuts).toBe(1);
        expect(t.binsMatched).toBeGreaterThanOrEqual(4);
        expect(t.imagesChanged).toBe(2);
        expect(t.dEBefore[0]).toBeGreaterThan(12);   // grey 110 against grey 150 (within the gain cap of either side)
        expect(t.dEAfter[0]).toBeLessThan(t.dEBefore[0] * 0.5);
        const [a, b] = rowMeans(output).sort((p, q) => p.rows[0].v - q.rows[0].v);
        const near = (rows: Array<{ d: number; v: number }>) => rows.filter(x => x.d < 0.3).reduce((s, x) => s + x.v, 0) / rows.filter(x => x.d < 0.3).length;
        const far = (rows: Array<{ d: number; v: number }>) => rows.filter(x => x.d > 3).reduce((s, x) => s + x.v, 0) / rows.filter(x => x.d > 3).length;
        // at the cut the two meet near the middle (the geometric mean in linear light, about grey 131); 3 m away each is as it was
        expect(near(b.rows) - near(a.rows)).toBeLessThan(6);
        expect(near(a.rows)).toBeGreaterThan(124);
        expect(near(b.rows)).toBeLessThan(138);
        expect(Math.abs(far(a.rows) - 110)).toBeLessThanOrEqual(1);
        expect(Math.abs(far(b.rows) - 150)).toBeLessThanOrEqual(1);
        // the photos rise monotonically toward each other across the band (no step inside a tile)
        const ascending = [...a.rows].sort((p, q) => q.d - p.d).map(x => x.v);
        for (let i = 1; i < ascending.length; i++) expect(ascending[i]).toBeGreaterThanOrEqual(ascending[i - 1] - 0.5);
        for (const m of [a.material, b.material]) expect(m.extras?.scratchbox?.method).toBe('tile seam tone feather (fitted levels, generated)');
        // not asked for, or with no boxes, the photos are left as they came
        const off = await runTileSeamWeld({ inputGlb: input, outputGlb: path.join(WORK, 'tone_off.glb'), threads: 2, repoRoot: REPO });
        expect(off.tone).toBeUndefined();
        const noBox = path.join(WORK, 'tone_nobox.glb');
        writeGlb(noBox, [wallTile(0, 0), wallTile(5, 1)], [grey(110), grey(150)], [{ leafId: 'a' }, { leafId: 'b' }], { localToEcef: IDENTITY });
        const nb = await runTileSeamWeld({ inputGlb: noBox, outputGlb: path.join(WORK, 'tone_nobox_welded.glb'), tone: true, threads: 2, repoRoot: REPO });
        expect(nb.tone).toBeUndefined();
        for (const { rows } of rowMeans(path.join(WORK, 'tone_off.glb'))) expect(new Set(rows.map(x => Math.round(x.v))).size).toBe(1);
    });

    it('removes the caps two tiles carry back to back in their shared cut plane, and keeps the walls', async () => {
        // tile A: the wall below y = 5 and its cap (facing up, 2 m back from the wall); tile B: the wall above and its cap (facing down)
        const join = (a: Chunk, b: Chunk): Chunk => ({ positions: [...a.positions, ...b.positions], indices: [...a.indices, ...b.indices.map(i => i + a.positions.length / 3)] });
        const a = join(quad([0, 0, 0], [10, 0, 0], [0, 5, 0], 10, 5), flat(0, 10, -2, 0, 5, 4));
        const b = join(quad([0, 5, 0], [10, 0, 0], [0, 5, 0], 10, 5), quad([0, 5, -2], [10, 0, 0], [0, 0, 2], 4, 4));
        const tiles = [{ leafId: 'a', geometricErrorM: 2, box: [5, 2.5, -1, 5, 0, 0, 0, 2.5, 0, 0, 0, 1] }, { leafId: 'b', geometricErrorM: 2, box: [5, 7.5, -1, 5, 0, 0, 0, 2.5, 0, 0, 0, 1] }];
        const input = path.join(WORK, 'caps.glb'), output = path.join(WORK, 'caps_welded.glb');
        writeGlb(input, [a, b], [], tiles, { localToEcef: IDENTITY });
        const horizontal = (file: string) => triangles(file).filter(t => t.every(p => Math.abs(p[1] - 5) < 1e-4)).length;
        expect(horizontal(input)).toBe(64);
        const r = await runTileSeamWeld({ inputGlb: input, outputGlb: output, caps: true, threads: 2, repoRoot: REPO });
        expect(r.capTrim).toMatchObject({ sharedFaces: 2, candidates: 64, trianglesDropped: 64 });
        expect(r.capTrim!.areaM2).toBeCloseTo(40, 3);
        expect(horizontal(output)).toBe(0);
        expect(triangles(output).length).toBe(200);   // the two walls, whole
        expect(r.cuts).toHaveLength(1);
        expect(r.cuts![0]).toMatchObject({ o: 5 });
        // not asked for, the caps stay
        const off = await runTileSeamWeld({ inputGlb: input, outputGlb: path.join(WORK, 'caps_off.glb'), threads: 2, repoRoot: REPO });
        expect(off.capTrim).toBeUndefined();
        expect(horizontal(path.join(WORK, 'caps_off.glb'))).toBeGreaterThan(0);
    });

    it('fades the step between two tiles\' walls out either side of their cut, scores the cut before and after, and the weld closes it', async () => {
        // tile A: a wall in z = 0 below y = 5; tile B: the wall above, standing 6 cm proud (z = 0.06); 0.5 m cells
        const a = quad([0, 0, 0], [10, 0, 0], [0, 5, 0], 20, 10), b = quad([0, 5, 0.06], [10, 0, 0], [0, 5, 0], 20, 10);
        const tiles = [{ leafId: 'a', geometricErrorM: 2, box: [5, 2.5, 0, 5, 0, 0, 0, 2.5, 0, 0, 0, 1] }, { leafId: 'b', geometricErrorM: 2, box: [5, 7.5, 0, 5, 0, 0, 0, 2.5, 0, 0, 0, 1] }];
        const input = path.join(WORK, 'blend.glb'), output = path.join(WORK, 'blend_welded.glb');
        writeGlb(input, [a, b], [], tiles, { localToEcef: IDENTITY });
        const r = await runTileSeamWeld({ inputGlb: input, outputGlb: output, blend: true, threads: 2, repoRoot: REPO });
        const cs = r.cutScores!;
        expect(cs.afterCaps.cuts).toBe(1);
        expect(cs.afterCaps.meanStepM).toBeCloseTo(0.06, 3);
        expect(cs.afterCaps.rimLengthM).toBeCloseTo(20, 1);       // both rims, 10 m each
        expect(cs.afterBlend!.meanStepM).toBeLessThan(0.002);
        expect(r.stepBlend).toMatchObject({ cutsMatched: 1, reverted: 0 });
        expect(r.stepBlend!.maxMoveM).toBeCloseTo(0.03, 3);        // each side half the step
        // at the cut both walls stand at z = 0.03; 1.5 m and more from it each stands where it was; in between it fades
        const P = distinct(positions(output));
        for (const p of P.filter(q => near(q[1], 5))) expect(p[2]).toBeCloseTo(0.03, 3);
        for (const p of P.filter(q => q[1] <= 3.5 + 1e-6)) expect(Math.abs(p[2])).toBeLessThan(1e-5);
        for (const p of P.filter(q => q[1] >= 6.5 - 1e-6)) expect(p[2]).toBeCloseTo(0.06, 5);
        const mid = P.filter(q => near(q[1], 4.5)).map(q => q[2]);
        expect(Math.min(...mid)).toBeGreaterThan(0.015);
        expect(Math.max(...mid)).toBeLessThan(0.03);
        // the two rims now coincide, so the weld joins them: no open edge is left along the cut
        expect(openEdges(triangles(output)).filter(e => e.every(q => near(q[1], 5)))).toHaveLength(0);
        expect(cs.final.rimLengthM).toBe(0);
        // not asked for: the step stays and the cut stays open
        const off = await runTileSeamWeld({ inputGlb: input, outputGlb: path.join(WORK, 'blend_off.glb'), threads: 2, repoRoot: REPO });
        expect(off.stepBlend).toBeUndefined();
        expect(off.cutScores!.final.meanStepM).toBeCloseTo(0.06, 3);
        expect(openEdges(triangles(path.join(WORK, 'blend_off.glb'))).filter(e => e.every(q => near(q[1], 5) )).length).toBeGreaterThan(0);
    });
});
