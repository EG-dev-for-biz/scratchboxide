/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The scan carved under the streets the kerbs' sweep drew (road-kerbs.ts), so nothing of it pokes through them. The
 * footprint is the plan of every up-facing surface the sweep drew (carriageway, gutters, nosings, kerb tops), triangle by
 * triangle with their levels. Every scan triangle over it is cut exactly at the footprint's triangles' edges (every vertex
 * attribute carried, the cut points shared by neighbours), and each piece inside is removed when it lies within a band
 * about the new surface there: the scan's own street, its bumps and dips. A piece reaching higher stands on the street (a
 * post, a hydrant, a bin) and is kept; one far below is hidden under it and kept.
 *
 * The pieces kept outside meet the new surfaces on the footprint's outline: each cut point there is set onto the outline's
 * own edge (height only, so the photo stays where it was), so the scan's rim and the new surface's edge are one line. Where
 * the scan stands too far from the outline for that (more than `pinM`), or the outline steps (a kerb's end), a curtain
 * closes the gap from the scan's rim to the outline, labelled generated. The streets SB-Roadie measured just outside are
 * settled beforehand by road-flatten.ts.
 */

import { accessorLayout, assembleGlb, isIdentity, nodeWorldMatrices, parseGlbBytes } from './glb-bytes';
import { appendPieces, readPrims, split, vertexOf, type PrimRead, type Vx } from './pipeline-k/lattice-stitch';
import type { FootprintTri } from './road-kerbs';

export const ROAD_CARVE_VERSION = 'road-carve/1';

export const ROAD_CARVE_PARAMS = {
    /** The scan within this far below (m) ... */
    belowM: 0.6,
    /** ... and above the new surface is carved (m); a piece reaching higher stands on the street and is kept. */
    aboveM: 0.5,
    /** A cut point on the outline is set onto it when within this (m); further, a curtain closes the step. */
    pinM: 0.25,
    /** The footprint's lookup grid (m). */
    cellM: 2
};
export type RoadCarveParams = typeof ROAD_CARVE_PARAMS;

export interface RoadCarveReport {
    trianglesIn: number;
    /** Scan triangles wholly removed; cut at the outline (their pieces outside kept); pieces kept standing on the new surface (above the band) or under it (below). */
    removed: number; cut: number; keptPieces: number; standing: number; below: number;
    removedAreaM2: number;
    /** Cut points on the outline set onto its edge, and how far at most (m); left where they were (too far); the curtain's triangles. */
    pinned: number; maxPinM: number; unpinned: number; curtainTriangles: number;
    /** Whole triangles beside the cut given a neighbour's cut point on an edge (so the two stay joined). */
    joined: number;
    /** Primitives not carved: placed by a node transform. */
    skippedPrimitives: number;
}

/** The footprint prepared: its triangles counter-clockwise in plan, a grid over them, its outline's edges with their levels. */
export interface CarveFootprint {
    tris: Float64Array;
    count: number;
    cellM: number;
    cells: Map<string, number[]>;
    /** Outline edges (in no other footprint triangle): ax, ay, az, bx, by, bz. */
    outline: Float64Array;
    outlineCells: Map<string, number[]>;
}

const cellKey = (i: number, k: number) => `${i},${k}`;
const vkey = (x: number, z: number) => `${x},${z}`;

export function prepareFootprint(footprint: FootprintTri[], cellM = ROAD_CARVE_PARAMS.cellM): CarveFootprint {
    const tris = new Float64Array(footprint.length * 9);
    const cells = new Map<string, number[]>();
    const edgeUse = new Map<string, { n: number; a: number[]; b: number[] }>();
    footprint.forEach((t, f) => {
        let [ax, ay, az, bx, by, bz, cx, cy, cz] = t;
        if ((bx - ax) * (cz - az) - (bz - az) * (cx - ax) < 0) [bx, by, bz, cx, cy, cz] = [cx, cy, cz, bx, by, bz];
        tris.set([ax, ay, az, bx, by, bz, cx, cy, cz], f * 9);
        for (let i = Math.floor(Math.min(ax, bx, cx) / cellM); i <= Math.floor(Math.max(ax, bx, cx) / cellM); i++) for (let k = Math.floor(Math.min(az, bz, cz) / cellM); k <= Math.floor(Math.max(az, bz, cz) / cellM); k++) {
            const l = cells.get(cellKey(i, k));
            if (l) l.push(f); else cells.set(cellKey(i, k), [f]);
        }
        // an edge by its plan ends: one triangle's is the outline, two's (a face's foot and top share theirs in plan) inside it
        for (const [p, q] of [[[ax, ay, az], [bx, by, bz]], [[bx, by, bz], [cx, cy, cz]], [[cx, cy, cz], [ax, ay, az]]]) {
            const kp = vkey(p[0], p[2]), kq = vkey(q[0], q[2]), k = kp < kq ? `${kp}|${kq}` : `${kq}|${kp}`;
            const e = edgeUse.get(k);
            if (e) e.n++; else edgeUse.set(k, { n: 1, a: p, b: q });
        }
    });
    const out: number[] = [];
    for (const e of edgeUse.values()) if (e.n === 1) out.push(...e.a, ...e.b);
    const outline = Float64Array.from(out), outlineCells = new Map<string, number[]>();
    for (let e = 0; e * 6 < outline.length; e++) {
        const o = e * 6;
        for (let i = Math.floor(Math.min(outline[o], outline[o + 3]) / cellM); i <= Math.floor(Math.max(outline[o], outline[o + 3]) / cellM); i++) for (let k = Math.floor(Math.min(outline[o + 2], outline[o + 5]) / cellM); k <= Math.floor(Math.max(outline[o + 2], outline[o + 5]) / cellM); k++) {
            const l = outlineCells.get(cellKey(i, k));
            if (l) l.push(e); else outlineCells.set(cellKey(i, k), [e]);
        }
    }
    return { tris, count: footprint.length, cellM, cells, outline, outlineCells };
}

/** The footprint triangle's level at a plan point (barycentric, extrapolated off it). */
function levelOn(F: Float64Array, f: number, x: number, z: number): number {
    const o = f * 9, ax = F[o], az = F[o + 2], bx = F[o + 3] - ax, bz = F[o + 5] - az, cx = F[o + 6] - ax, cz = F[o + 8] - az;
    const det = bx * cz - bz * cx, px = x - ax, pz = z - az;
    const u = (px * cz - pz * cx) / det, v = (bx * pz - bz * px) / det;
    return F[o + 1] + u * (F[o + 4] - F[o + 1]) + v * (F[o + 7] - F[o + 1]);
}

/** Whether a convex plan polygon and a footprint triangle overlap with area (separating axes; touching is not overlap). */
function overlaps(poly: Vx[], F: Float64Array, f: number): boolean {
    const o = f * 9, T = [[F[o], F[o + 2]], [F[o + 3], F[o + 5]], [F[o + 6], F[o + 8]]];
    const Q = poly.map(v => [v.p[0], v.p[2]]);
    for (const shape of [T, Q]) for (let i = 0; i < shape.length; i++) {
        const a = shape[i], b = shape[(i + 1) % shape.length], nx = b[1] - a[1], nz = a[0] - b[0];
        if (!(Math.abs(nx) + Math.abs(nz) > 0)) continue;
        let t0 = Infinity, t1 = -Infinity, q0 = Infinity, q1 = -Infinity;
        for (const p of T) { const d = p[0] * nx + p[1] * nz; t0 = Math.min(t0, d); t1 = Math.max(t1, d); }
        for (const p of Q) { const d = p[0] * nx + p[1] * nz; q0 = Math.min(q0, d); q1 = Math.max(q1, d); }
        const eps = 1e-9 * (Math.abs(nx) + Math.abs(nz));
        if (t1 <= q0 + eps || q1 <= t0 + eps) return false;
    }
    return true;
}

const area3 = (poly: Vx[]) => {
    let s = 0;
    for (let k = 1; k + 1 < poly.length; k++) {
        const [a, b, c] = [poly[0].p, poly[k].p, poly[k + 1].p];
        const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
        s += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
    }
    return s;
};

/** The outline's levels at a plan point on it (each outline edge through it, within `tol`), or none. */
function outlineLevels(fp: CarveFootprint, x: number, z: number, tol = 1e-6): number[] {
    const L = fp.outline, out: number[] = [];
    for (const e of fp.outlineCells.get(cellKey(Math.floor(x / fp.cellM), Math.floor(z / fp.cellM))) ?? []) {
        const o = e * 6, dx = L[o + 3] - L[o], dz = L[o + 5] - L[o + 2], l2 = dx * dx + dz * dz;
        if (!(l2 > 0)) continue;
        const t = ((x - L[o]) * dx + (z - L[o + 2]) * dz) / l2;
        if (t < -1e-9 || t > 1 + 1e-9) continue;
        if (Math.hypot(L[o] + t * dx - x, L[o + 2] + t * dz - z) > tol) continue;
        out.push(L[o + 1] + Math.max(0, Math.min(1, t)) * (L[o + 4] - L[o + 1]));
    }
    return out;
}

/** The outline's own vertices strictly between two plan points on it, by their distance from the first, each with its levels. */
function outlineCornersBetween(fp: CarveFootprint, ax: number, az: number, bx: number, bz: number, tol = 1e-6): Array<{ t: number; x: number; z: number; levels: number[] }> {
    const L = fp.outline, dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
    if (!(l2 > 0)) return [];
    const seen = new Map<string, { t: number; x: number; z: number; levels: number[] }>();
    const i0 = Math.floor(Math.min(ax, bx) / fp.cellM), i1 = Math.floor(Math.max(ax, bx) / fp.cellM), k0 = Math.floor(Math.min(az, bz) / fp.cellM), k1 = Math.floor(Math.max(az, bz) / fp.cellM);
    for (let i = i0; i <= i1; i++) for (let k = k0; k <= k1; k++) for (const e of fp.outlineCells.get(cellKey(i, k)) ?? []) {
        for (const end of [0, 3]) {
            const o = e * 6 + end, x = L[o], z = L[o + 2];
            const t = ((x - ax) * dx + (z - az) * dz) / l2;
            if (t <= 1e-9 || t >= 1 - 1e-9) continue;
            if (Math.hypot(ax + t * dx - x, az + t * dz - z) > tol) continue;
            const k = vkey(x, z), y = L[o + 1];
            const c = seen.get(k);
            if (!c) seen.set(k, { t, x, z, levels: [y] }); else if (!c.levels.some(v => Math.abs(v - y) < 1e-9)) c.levels.push(y);
        }
    }
    return [...seen.values()].sort((p, q) => p.t - q.t);
}

/** The GLB with every triangle primitive drawn without an index list given one (0, 1, 2, ...), so it can be cut like the rest. */
export function withIndexLists(bytes: Uint8Array): Uint8Array {
    const glb = parseGlbBytes(bytes);
    const json = glb.json;
    const missing: any[] = [];
    for (const m of json.meshes ?? []) for (const p of m.primitives ?? []) if ((p.mode ?? 4) === 4 && p.attributes?.POSITION !== undefined && p.indices === undefined) missing.push(p);
    if (!missing.length) return bytes;
    const chunks: Uint8Array[] = [glb.bin];
    let len = glb.bin.byteLength;
    for (const p of missing) {
        const n = json.accessors[p.attributes.POSITION].count, idx = new Uint32Array(n - (n % 3));
        for (let i = 0; i < idx.length; i++) idx[i] = i;
        const pad = (4 - (len % 4)) % 4;
        if (pad) { chunks.push(new Uint8Array(pad)); len += pad; }
        json.bufferViews.push({ buffer: 0, byteOffset: len, byteLength: idx.byteLength, target: 34963 });
        chunks.push(new Uint8Array(idx.buffer));
        len += idx.byteLength;
        json.accessors.push({ bufferView: json.bufferViews.length - 1, componentType: 5125, count: idx.length, type: 'SCALAR' });
        p.indices = json.accessors.length - 1;
    }
    const bin = new Uint8Array(len + ((4 - (len % 4)) % 4));
    let o = 0;
    for (const c of chunks) { bin.set(c, o); o += c.byteLength; }
    json.buffers = [{ ...(json.buffers?.[0] ?? {}), byteLength: bin.byteLength }];
    return assembleGlb(json, bin);
}

/**
 * The scan GLB carved under `footprint` (prepareFootprint), its rim set onto the outline and closed by curtains where it
 * could not be. Positions are read as the frame (a primitive placed by a node transform is left as it is, and counted).
 */
export function carveUnderRoads(bytes: Uint8Array, footprint: CarveFootprint, P: RoadCarveParams = ROAD_CARVE_PARAMS): { glb: Buffer; report: RoadCarveReport } {
    const glb = parseGlbBytes(Uint8Array.from(withIndexLists(bytes)));
    const dv = new DataView(glb.bin.buffer, glb.bin.byteOffset, glb.bin.byteLength);
    const report: RoadCarveReport = { trianglesIn: 0, removed: 0, cut: 0, keptPieces: 0, standing: 0, below: 0, removedAreaM2: 0, pinned: 0, maxPinM: 0, unpinned: 0, curtainTriangles: 0, joined: 0, skippedPrimitives: 0 };
    const world = nodeWorldMatrices(glb.json);
    const placed = new Set<number>();
    (glb.json.nodes ?? []).forEach((n: any, i: number) => { if (n.mesh !== undefined && !isIdentity(world[i])) placed.add(n.mesh); });
    for (const m of glb.json.meshes ?? []) for (const p of m.primitives ?? []) if ((p.mode ?? 4) === 4 && p.attributes?.POSITION !== undefined && p.indices === undefined) report.skippedPrimitives++;
    const F = footprint.tris, stamp = new Int32Array(footprint.count).fill(-1);
    const kill = (pr: PrimRead, t: number) => {
        for (const e of [t + 1, t + 2]) { const o = pr.idxBase + e * pr.idxStride; if (pr.idxSize === 4) dv.setUint32(o, pr.I[t], true); else if (pr.idxSize === 2) dv.setUint16(o, pr.I[t], true); else dv.setUint8(o, pr.I[t]); }
    };
    const appended: Array<{ pr: PrimRead; polys: Vx[][] }> = [];
    const nearest = (levels: number[], y: number) => levels.reduce((a, b) => (Math.abs(b - y) < Math.abs(a - y) ? b : a));
    for (const pr of readPrims(glb)) {
        if (placed.has(pr.mesh)) { report.skippedPrimitives++; continue; }
        const X = pr.data[0];
        const kept: Vx[][] = [];
        const cache = new Map<string, Vx>();
        // the scan's own vertices on the outline (where it runs along a scan edge, nothing is cut there): set onto it in the
        // vertex buffer, height only, so every triangle using one meets the new surface's edge; each remembered with its levels
        const own = new Map<number, { levels: number[]; pinned: boolean }>();
        {
            const prim = glb.json.meshes[pr.mesh].primitives[pr.prim], lay = accessorLayout(glb.json, prim.attributes.POSITION);
            let moved = false;
            for (let v = 0; v * 3 < X.length; v++) {
                const x = X[v * 3], z = X[v * 3 + 2];
                if (!footprint.outlineCells.has(cellKey(Math.floor(x / footprint.cellM), Math.floor(z / footprint.cellM)))) continue;
                const levels = outlineLevels(footprint, x, z);
                if (!levels.length) continue;
                const y = nearest(levels, X[v * 3 + 1]), pinned = Math.abs(y - X[v * 3 + 1]) <= P.pinM;
                // a vertex well above (a wall's, a post's) or below the outline's level is no part of the street's rim
                if (X[v * 3 + 1] - y > P.aboveM || y - X[v * 3 + 1] > P.belowM) continue;
                own.set(v, { levels, pinned });
                if (!pinned) { report.unpinned++; continue; }
                report.maxPinM = Math.max(report.maxPinM, Math.abs(y - X[v * 3 + 1]));
                X[v * 3 + 1] = y;
                dv.setFloat32(lay.base + v * lay.stride + 4, y, true);
                report.pinned++;
                moved = true;
            }
            if (moved) {
                const acc = glb.json.accessors[prim.attributes.POSITION];
                let lo = Infinity, hi = -Infinity;
                for (let v = 0; v * 3 < X.length; v++) { lo = Math.min(lo, X[v * 3 + 1]); hi = Math.max(hi, X[v * 3 + 1]); }
                if (Array.isArray(acc.min)) acc.min[1] = Math.min(acc.min[1], Math.fround(lo));
                if (Array.isArray(acc.max)) acc.max[1] = Math.max(acc.max[1], Math.fround(hi));
            }
        }
        // a whole triangle's edges lying on the outline: the rim where nothing was cut (closed below, as the cut pieces' are)
        const wholeRim: Array<[Vx, Vx]> = [];
        // triangles near the footprint kept whole: a neighbour's cut point may lie on one of their edges (repaired below)
        const whole: Array<{ t: number; tri: Vx[] }> = [];
        for (let t = 0; t + 2 < pr.I.length; t += 3) {
            const ia = pr.I[t], ib = pr.I[t + 1], ic = pr.I[t + 2];
            if (ia === ib || ib === ic || ia === ic) continue;
            report.trianglesIn++;
            const xs = [X[ia * 3], X[ib * 3], X[ic * 3]], zs = [X[ia * 3 + 2], X[ib * 3 + 2], X[ic * 3 + 2]];
            const cands: number[] = [];
            for (let i = Math.floor(Math.min(...xs) / footprint.cellM); i <= Math.floor(Math.max(...xs) / footprint.cellM); i++) for (let k = Math.floor(Math.min(...zs) / footprint.cellM); k <= Math.floor(Math.max(...zs) / footprint.cellM); k++) {
                for (const f of footprint.cells.get(cellKey(i, k)) ?? []) if (stamp[f] !== t) { stamp[f] = t; cands.push(f); }
            }
            if (!cands.length) continue;
            const tri = [vertexOf(pr, ia), vertexOf(pr, ib), vertexOf(pr, ic)];
            const hits = cands.filter(f => overlaps(tri, F, f));
            if (!hits.length) {
                for (const [p, q] of [[0, 1], [1, 2], [2, 0]]) if (own.has(pr.I[t + p]) && own.has(pr.I[t + q])) wholeRim.push([tri[p], tri[q]]);
                whole.push({ t, tri });
                continue;
            }
            // the pieces outside every footprint triangle are kept; inside one, a piece within the band about its surface goes
            type Piece = { poly: Vx[]; settled?: boolean };
            let pieces: Piece[] = [{ poly: tri }];
            let removedHere = 0, footed = false;
            for (const f of hits) {
                const next: Piece[] = [];
                for (const pc of pieces) {
                    if (pc.settled || !overlaps(pc.poly, F, f)) { next.push(pc); continue; }
                    let rest: Vx[] = pc.poly;
                    const o = f * 9;
                    for (let e = 0; e < 3 && rest.length; e++) {
                        const ax = F[o + e * 3], az = F[o + e * 3 + 2], bx = F[o + ((e + 1) % 3) * 3], bz = F[o + ((e + 1) % 3) * 3 + 2];
                        // the edge's line, keyed by its plan ends in one order, so the two triangles sharing it share its cut points
                        const ka = vkey(ax, az), kb = vkey(bx, bz), plane = ka < kb ? `${ka}>${kb}` : `${kb}>${ka}`;
                        const [outside, inside] = split(rest, v => (bx - ax) * (v.p[2] - az) - (bz - az) * (v.p[0] - ax), plane, pr, cache);
                        if (outside.length) next.push({ poly: outside });
                        rest = inside;
                    }
                    if (!rest.length) continue;
                    const dys = rest.map(v => v.p[1] - levelOn(F, f, v.p[0], v.p[2]));
                    if (dys.every(d => d >= -P.belowM && d <= P.aboveM)) { removedHere++; report.removedAreaM2 += area3(rest); continue; }
                    if (dys.some(d => d > P.aboveM)) {
                        // it stands on the new surface: its foot (the corners within the band) set onto it, so no slit opens under it
                        report.standing++;
                        // in place: every piece sharing a corner (a cut point, or this scan vertex's copies) keeps one height for it
                        rest.forEach((v, q) => { if (dys[q] >= -P.belowM && dys[q] <= P.aboveM) { v.p[1] = levelOn(F, f, v.p[0], v.p[2]); footed = true; } });
                    } else report.below++;
                    next.push({ poly: rest, settled: true });
                }
                pieces = next;
            }
            // nothing under the new surface went and nothing stands on it: the triangle stays whole (a wall the outline merely
            // crosses is not cut)
            if (!removedHere && !footed) {
                for (const [p, q] of [[0, 1], [1, 2], [2, 0]]) if (own.has(pr.I[t + p]) && own.has(pr.I[t + q])) wholeRim.push([tri[p], tri[q]]);
                whole.push({ t, tri: [vertexOf(pr, ia), vertexOf(pr, ib), vertexOf(pr, ic)] });
                continue;
            }
            kill(pr, t);
            if (!pieces.length) { report.removed++; continue; }
            report.cut++;
            report.keptPieces += pieces.length;
            kept.push(...pieces.map(p => p.poly));
        }
        // T-junctions: a cut line runs on past the footprint's corner through a piece without a vertex there, while the piece
        // beside it has one (and the rim moves it); every cut point a kept piece uses that lies on another kept piece's edge, or
        // on the edge of a whole triangle beside the cut, is put into that edge, so the pieces stay joined when it moves
        {
            const cutSet = new Set(cache.values()), points: Vx[] = [];
            for (const poly of kept) for (const v of poly) if (cutSet.has(v)) points.push(v);
            const cell = 0.5, grid = new Map<string, Vx[]>();
            for (const v of new Set(points)) { const k = cellKey(Math.floor(v.p[0] / cell), Math.floor(v.p[2] / cell)); const l = grid.get(k); if (l) l.push(v); else grid.set(k, [v]); }
            const insert = (poly: Vx[]): Vx[] => {
                let changed = false;
                const out: Vx[] = [];
                poly.forEach((u, k) => {
                    out.push(u);
                    const w = poly[(k + 1) % poly.length], dx = w.p[0] - u.p[0], dz = w.p[2] - u.p[2], l2 = dx * dx + dz * dz;
                    if (!(l2 > 1e-12)) return;
                    const on: Array<{ t: number; v: Vx }> = [];
                    for (let i = Math.floor(Math.min(u.p[0], w.p[0]) / cell); i <= Math.floor(Math.max(u.p[0], w.p[0]) / cell); i++) for (let j = Math.floor(Math.min(u.p[2], w.p[2]) / cell); j <= Math.floor(Math.max(u.p[2], w.p[2]) / cell); j++) {
                        for (const v of grid.get(cellKey(i, j)) ?? []) {
                            if (v === u || v === w || poly.includes(v)) continue;
                            const t = ((v.p[0] - u.p[0]) * dx + (v.p[2] - u.p[2]) * dz) / l2;
                            if (t <= 1e-7 || t >= 1 - 1e-7) continue;
                            if (Math.abs((v.p[0] - u.p[0]) * dz - (v.p[2] - u.p[2]) * dx) / Math.sqrt(l2) > 1e-6) continue;
                            on.push({ t, v });
                        }
                    }
                    if (!on.length) return;
                    changed = true;
                    on.sort((a, b) => a.t - b.t);
                    for (const { v } of on) if (out[out.length - 1] !== v) out.push(v);
                });
                return changed ? out : poly;
            };
            for (let q = 0; q < kept.length; q++) kept[q] = insert(kept[q]);
            for (const { t, tri } of whole) {
                const poly = insert(tri);
                if (poly === tri) continue;
                kill(pr, t);
                kept.push(poly);
                report.joined++;
            }
        }
        // the rim: each cut point on the outline set onto it (the nearest of its levels there), when near enough; the scan's own
        // vertices on it were set already (their copies in the pieces carry the new height)
        const onRim = new Map<Vx, { levels: number[]; pinned: boolean }>();
        for (const v of cache.values()) {
            const levels = outlineLevels(footprint, v.p[0], v.p[2]);
            if (!levels.length) continue;
            const y = nearest(levels, v.p[1]);
            if (v.p[1] - y > P.aboveM || y - v.p[1] > P.belowM) continue;
            const shift = Math.abs(y - v.p[1]);
            const pinned = shift <= P.pinM;
            if (pinned) { v.p[1] = y; report.pinned++; report.maxPinM = Math.max(report.maxPinM, shift); } else report.unpinned++;
            onRim.set(v, { levels, pinned });
        }
        const rimOf = (v: Vx) => onRim.get(v) ?? (() => {
            const levels = outlineLevels(footprint, v.p[0], v.p[2]);
            if (!levels.length) return undefined;
            const y = nearest(levels, v.p[1]);
            return v.p[1] - y > P.aboveM || y - v.p[1] > P.belowM ? undefined : { levels, pinned: Math.abs(y - v.p[1]) < 1e-6 };
        })();
        // the curtains: along every kept rim edge lying on the outline, from the scan's rim down (or up) to the outline itself,
        // through the outline's own corners between its ends (a kerb's end steps there)
        const curtains: Vx[][] = [];
        const at = (from: Vx, x: number, y: number, z: number): Vx => ({ p: [x, y, z], a: from.a, key: `${x},${y},${z}` });
        const rimEdges: Array<[Vx, Vx]> = [...wholeRim];
        for (const poly of kept) for (let k = 0; k < poly.length; k++) rimEdges.push([poly[k], poly[(k + 1) % poly.length]]);
        for (const [u, w] of rimEdges) {
            const ru = rimOf(u), rw = rimOf(w);
            if (!ru || !rw) continue;
            const mx = (u.p[0] + w.p[0]) / 2, mz = (u.p[2] + w.p[2]) / 2;
            if (!outlineLevels(footprint, mx, mz).length) continue;
            const corners = outlineCornersBetween(footprint, u.p[0], u.p[2], w.p[0], w.p[2]);
            if (ru.pinned && rw.pinned && !corners.length) continue;
            // the outline under the rim edge: its level at u (the nearest to u), each corner's levels in the order that runs from
            // u's side to w's, its level at w
            const line: Vx[] = [at(u, u.p[0], nearest(ru.levels, u.p[1]), u.p[2])];
            let last = line[0].p[1];
            for (const c of corners) {
                const ordered = [...c.levels].sort((a, b) => Math.abs(a - last) - Math.abs(b - last));
                for (const y of ordered) line.push(at(Math.abs(c.t) < 0.5 ? u : w, c.x, y, c.z));
                last = ordered[ordered.length - 1];
            }
            line.push(at(w, w.p[0], nearest(rw.levels, w.p[1]), w.p[2]));
            // the loop u, w, then the outline back from w to u, fanned from u
            const loop = [u, w, ...line.reverse()].filter((v, i, arr) => i === 0 || Math.hypot(v.p[0] - arr[i - 1].p[0], v.p[1] - arr[i - 1].p[1], v.p[2] - arr[i - 1].p[2]) > 1e-7);
            for (let q = 1; q + 1 < loop.length; q++) {
                const tri = [loop[0], loop[q], loop[q + 1]];
                if (area3(tri) < 1e-8) continue;
                curtains.push(tri);
                report.curtainTriangles++;
            }
        }
        if (kept.length) appended.push({ pr, polys: kept });
        if (curtains.length) appended.push({ pr, polys: curtains });
    }
    report.removedAreaM2 = Math.round(report.removedAreaM2 * 10) / 10;
    report.maxPinM = Math.round(report.maxPinM * 1000) / 1000;
    const out = appendPieces(glb, appended, { sbRoadCarve: { version: ROAD_CARVE_VERSION, provenance: 'as-scanned: the scan cut at the streets\' new surfaces and removed under them; its rim set onto their edge (height only); curtains between rim and edge generated' } });
    return { glb: out, report };
}

/** Whether a GLB was carved here already (its appended pieces carry the marker). */
export function isRoadCarved(bytes: Uint8Array): boolean {
    try {
        const g = parseGlbBytes(bytes);
        return (g.json.meshes ?? []).some((m: any) => (m.primitives ?? []).some((p: any) => p.extras?.sbRoadCarve));
    } catch {
        return false;
    }
}
