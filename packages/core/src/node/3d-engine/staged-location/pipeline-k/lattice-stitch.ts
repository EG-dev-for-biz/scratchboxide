/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K's watertight facade rebuild: the scan cut exactly to the rebuilt cells, the rebuilt walls stitched to the cut,
 * and the holes left closed, so the finished building is one shell.
 *
 *  1. Cut (cutScanToLattice): every scan triangle reaching into a rebuilt facade's slab (within depthBandM of its plane,
 *     over its lattice) is split along the facade's lattice lines and the slab's two depth planes; the pieces inside rebuilt
 *     cells go, the rest stay. A point made on an edge is computed from the edge's ends in one fixed order, so the pieces on
 *     both sides of a cut share it exactly. Every vertex attribute is carried: continuous ones interpolated (normals
 *     renormalised), flag-like ones (named with a leading underscore) taken from the nearer end.
 *  2. Stitch (stitchLattice): along every edge of a rebuilt facade's outline (a rebuilt cell next to one that is not), the
 *     scan's cut points on that line and the rebuilt wall's edge are joined by a strip in the line's own vertical plane,
 *     like the step faces between cells.
 *  3. Fill (fillOpenLoops, last, after the base cleanup): every loop of open edges left (the scan's own holes, the corners
 *     where strips and steps meet, the cut at the slab's depth planes behind the wall, and the base, which caps the bottom)
 *     is triangulated in its best-fitting plane, or, when it does not lie flat, in 3D by cutting off the ear with the shortest
 *     closing edge again and again (greedy Liepa). A rebuilt wall's own outer outline is never filled (that would double the
 *     wall). Open means an edge of an odd number of triangles: such edges always form closed loops, so every one is closed.
 *
 * Every added triangle uses existing vertices exactly (plus a fan's centre), so the result welds shut. The open edges
 * left are counted on the welded result and reported.
 */

import { ShapeUtils, Vector2 } from 'three';
import { accessorLayout, assembleGlb, parseGlbBytes, readAccessor } from '../glb-bytes';
import type { FacadeLatticeResult, ReliefFacade } from '../facade-lattice';

export const LATTICE_STITCH_VERSION = 'lattice-stitch/1';

export const LATTICE_STITCH_PARAMS = {
    /** The slab of a rebuilt facade cut from the scan: within this of its plane (m). */
    depthBandM: 2,
    /** Vertices closer than this are one (m), for the stitch and the fill. */
    weldM: 0.001,
    /** A point lies on a lattice line within this (m). */
    onLineM: 0.002,
    /** Two facades' open outline edges this close side by side (m) are zipped together: walls meeting at a corner. */
    cornerGapM: 2.5
};
export type LatticeStitchParams = typeof LATTICE_STITCH_PARAMS;

type Facade = { f: ReliefFacade; r: FacadeLatticeResult };
const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** A vertex: position and every other attribute, flattened. */
interface Vx { p: [number, number, number]; a: Float64Array; key: string }
const keyOf = (p: ArrayLike<number>) => `${p[0]},${p[1]},${p[2]}`;

interface PrimRead { mesh: number; prim: number; names: string[]; comps: number[]; flags: boolean[]; data: Float64Array[]; I: ArrayLike<number>; idxBase: number; idxStride: number; idxSize: number }

function readPrims(glb: ReturnType<typeof parseGlbBytes>): PrimRead[] {
    const out: PrimRead[] = [];
    (glb.json.meshes ?? []).forEach((m: any, mi: number) => (m.primitives ?? []).forEach((p: any, pi: number) => {
        if ((p.mode ?? 4) !== 4 || p.attributes?.POSITION === undefined || p.indices === undefined) return;
        const names = Object.keys(p.attributes).filter(k => k !== 'POSITION');
        const data = [readAccessor(glb, p.attributes.POSITION).data, ...names.map(k => readAccessor(glb, p.attributes[k]).data)];
        const comps = [3, ...names.map(k => readAccessor(glb, p.attributes[k]).comps)];
        const li = accessorLayout(glb.json, p.indices);
        out.push({ mesh: mi, prim: pi, names, comps, flags: names.map(k => k.startsWith('_')), data, I: readAccessor(glb, p.indices).data, idxBase: li.base, idxStride: li.stride, idxSize: li.componentType === 5125 ? 4 : li.componentType === 5123 ? 2 : 1 });
    }));
    return out;
}

function vertexOf(pr: PrimRead, i: number): Vx {
    const p: [number, number, number] = [pr.data[0][i * 3], pr.data[0][i * 3 + 1], pr.data[0][i * 3 + 2]];
    const a: number[] = [];
    for (let k = 1; k < pr.data.length; k++) for (let c = 0; c < pr.comps[k]; c++) a.push(pr.data[k][i * pr.comps[k] + c]);
    return { p, a: Float64Array.from(a), key: keyOf(p) };
}

/** The point on edge (u, v) where g changes sign, computed from the ends in key order so both sides of a cut share it. */
function cutPoint(u: Vx, v: Vx, gu: number, gv: number, pr: PrimRead): Vx {
    const [a, b, ga, gb] = u.key < v.key ? [u, v, gu, gv] : [v, u, gv, gu];
    const l = ga / (ga - gb);
    const p: [number, number, number] = [a.p[0] + (b.p[0] - a.p[0]) * l, a.p[1] + (b.p[1] - a.p[1]) * l, a.p[2] + (b.p[2] - a.p[2]) * l];
    const at = new Float64Array(a.a.length);
    let o = 0;
    for (let k = 1; k < pr.comps.length; k++) {
        const flag = pr.flags[k - 1], c = pr.comps[k];
        for (let j = 0; j < c; j++, o++) at[o] = flag ? (l < 0.5 ? a.a[o] : b.a[o]) : a.a[o] + (b.a[o] - a.a[o]) * l;
        if (pr.names[k - 1] === 'NORMAL') { const n = Math.hypot(at[o - 3], at[o - 2], at[o - 1]) || 1; at[o - 3] /= n; at[o - 2] /= n; at[o - 1] /= n; }
    }
    return { p, a: at, key: keyOf(p) };
}

/** Splits a convex polygon by g (a plane): the parts with g <= 0 and g >= 0 (a vertex on the plane goes to both). */
function split(poly: Vx[], g: (v: Vx) => number, plane: string, pr: PrimRead, cache: Map<string, Vx>): [Vx[], Vx[]] {
    const neg: Vx[] = [], pos: Vx[] = [], gs = poly.map(v => { const x = g(v); return Math.abs(x) < 1e-9 ? 0 : x; });
    for (let i = 0; i < poly.length; i++) {
        const u = poly[i], v = poly[(i + 1) % poly.length], gu = gs[i], gv = gs[(i + 1) % poly.length];
        if (gu <= 0) neg.push(u);
        if (gu >= 0) pos.push(u);
        if ((gu < 0 && gv > 0) || (gu > 0 && gv < 0)) {
            const ck = u.key < v.key ? `${u.key}|${v.key}|${plane}` : `${v.key}|${u.key}|${plane}`;
            let c = cache.get(ck);
            if (!c) { c = cutPoint(u, v, gu, gv, pr); cache.set(ck, c); }
            neg.push(c); pos.push(c);
        }
    }
    return [neg.length >= 3 ? neg : [], pos.length >= 3 ? pos : []];
}

const cellIndex = (v: number, edges: number[]) => { let lo = 0, hi = edges.length - 1; while (hi - lo > 1) { const k = (lo + hi) >> 1; if (edges[k] <= v) lo = k; else hi = k; } return lo; };

/**
 * A rebuilt facade's surface made watertight inside itself: one face per rebuilt cell at its depth, and a step face between
 * every two neighbouring rebuilt cells whose depths differ at all (the plain rebuild skips steps under a few centimetres,
 * leaving slits). Each step's two end edges are split at every other depth meeting at that corner, so the steps around a
 * corner share their edges exactly (no pinhole where four cells of different depths meet). Same frame, UVs and normals as
 * the plain rebuild (facade-lattice.ts latticeFacade); only the outline is left open, for the stitch.
 */
export function watertightLatticeMesh(f: ReliefFacade, r: FacadeLatticeResult): Pick<FacadeLatticeResult, 'positions' | 'normals' | 'uv' | 'indices'> {
    const ns = r.s.length - 1, nt = r.t.length - 1, W = f.width * f.pixel, H = f.height * f.pixel;
    const built = (a: number, b: number) => a >= 0 && b >= 0 && a < ns && b < nt && !!r.built[b * ns + a];
    const depthAt = (a: number, b: number) => r.depth[b][a];
    const pos: number[] = [], nrm: number[] = [], uv: number[] = [], idx: number[] = [];
    const vert = (sv: number, tv: number, d: number, n: ArrayLike<number>) => {
        for (let k = 0; k < 3; k++) pos.push(f.centroid[k] + sv * f.axisS[k] + tv * f.axisT[k] + d * f.normal[k]);
        nrm.push(n[0], n[1], n[2]); uv.push((sv - f.orthoSMin) / W, (f.orthoTMax - tv) / H);
        return pos.length / 3 - 1;
    };
    // the depths of the rebuilt cells touching grid corner (a, b) (corner a in 0..ns, b in 0..nt)
    const cornerDepths = (a: number, b: number) => [[a - 1, b - 1], [a, b - 1], [a - 1, b], [a, b]].filter(([x, y]) => built(x, y)).map(([x, y]) => depthAt(x, y));
    const neg = (v: number[]) => v.map(x => -x);
    for (let b = 0; b < nt; b++) for (let a = 0; a < ns; a++) {
        if (!built(a, b)) continue;
        const d = depthAt(a, b);
        const q = [vert(r.s[a], r.t[b], d, f.normal), vert(r.s[a + 1], r.t[b], d, f.normal), vert(r.s[a + 1], r.t[b + 1], d, f.normal), vert(r.s[a], r.t[b + 1], d, f.normal)];
        idx.push(q[0], q[1], q[2], q[0], q[2], q[3]);
    }
    // a step between two cells along one grid line: corners P (pa, pb) and Q (qa, qb), depths lo..hi, every corner depth between kept
    const step = (P: [number, number], Q: [number, number], d: number, e: number, n: number[]) => {
        const lo = Math.min(d, e), hi = Math.max(d, e);
        const chain = (c: [number, number]) => [lo, ...cornerDepths(c[0], c[1]).filter(x => x > lo && x < hi).sort((x, y) => x - y), hi].filter((x, i, arr) => i === 0 || x !== arr[i - 1]);
        const cp = chain(P), cq = chain(Q);
        const vp = cp.map(x => vert(r.s[P[0]], r.t[P[1]], x, n)), vq = cq.map(x => vert(r.s[Q[0]], r.t[Q[1]], x, n));
        // zip the two chains by depth
        let i = 0, j = 0;
        while (i < vp.length - 1 || j < vq.length - 1) {
            if (j >= vq.length - 1 || (i < vp.length - 1 && cp[i + 1] <= cq[j + 1])) { idx.push(vp[i], vq[j], vp[i + 1]); i++; }
            else { idx.push(vp[i], vq[j], vq[j + 1]); j++; }
        }
    };
    for (let b = 0; b < nt; b++) for (let a = 0; a < ns; a++) {
        if (!built(a, b)) continue;
        const d = depthAt(a, b);
        if (built(a + 1, b) && depthAt(a + 1, b) !== d) { const e = depthAt(a + 1, b); step([a + 1, b], [a + 1, b + 1], d, e, d > e ? [...f.axisS] : neg([...f.axisS])); }
        if (built(a, b + 1) && depthAt(a, b + 1) !== d) { const e = depthAt(a, b + 1); step([a, b + 1], [a + 1, b + 1], d, e, d > e ? [...f.axisT] : neg([...f.axisT])); }
    }
    return { positions: Float32Array.from(pos), normals: Float32Array.from(nrm), uv: Float32Array.from(uv), indices: Uint32Array.from(idx) };
}

export interface CutReport { cutTriangles: number; removedPieces: number; keptPieces: number }

/** The scan cut to the rebuilt cells: pieces inside them removed, the rest kept (exact cut edges, attributes carried). */
export function cutScanToLattice(bytes: Uint8Array, facades: Facade[], P: LatticeStitchParams = LATTICE_STITCH_PARAMS): { glb: Buffer; report: CutReport } {
    const glb = parseGlbBytes(bytes);
    const json = glb.json;
    const dv = new DataView(glb.bin.buffer, glb.bin.byteOffset, glb.bin.byteLength);
    const report: CutReport = { cutTriangles: 0, removedPieces: 0, keptPieces: 0 };
    const frames = facades.map(({ f, r }) => ({ f, r, ns: r.s.length - 1, s0: r.s[0], s1: r.s[r.s.length - 1], t0: r.t[0], t1: r.t[r.t.length - 1] }));
    const appended: Array<{ pr: PrimRead; polys: Vx[][] }> = [];
    for (const pr of readPrims(glb)) {
        const kept: Vx[][] = [];
        const cache = new Map<string, Vx>();
        for (let t = 0; t + 2 < pr.I.length; t += 3) {
            const ids = [pr.I[t], pr.I[t + 1], pr.I[t + 2]];
            if (ids[0] === ids[1] || ids[1] === ids[2] || ids[0] === ids[2]) continue;
            const tri = ids.map(i => vertexOf(pr, i));
            let polys: Vx[][] = [tri], touched = false;
            for (const fr of frames) {
                const { f, r } = fr;
                const st = (v: Vx) => { const m = [v.p[0] - f.centroid[0], v.p[1] - f.centroid[1], v.p[2] - f.centroid[2]]; return [dot(m, f.axisS), dot(m, f.axisT), dot(m, f.normal)]; };
                const all = polys.flat().map(st);
                const smin = Math.min(...all.map(c => c[0])), smax = Math.max(...all.map(c => c[0])), tmin = Math.min(...all.map(c => c[1])), tmax = Math.max(...all.map(c => c[1])), dmin = Math.min(...all.map(c => c[2])), dmax = Math.max(...all.map(c => c[2]));
                if (smax <= fr.s0 || smin >= fr.s1 || tmax <= fr.t0 || tmin >= fr.t1 || dmax <= -P.depthBandM || dmin >= P.depthBandM) continue;
                // does it reach a rebuilt cell at all
                const a0 = cellIndex(Math.max(smin, fr.s0), r.s), a1 = cellIndex(Math.min(smax, fr.s1), r.s), b0 = cellIndex(Math.max(tmin, fr.t0), r.t), b1 = cellIndex(Math.min(tmax, fr.t1), r.t);
                let any = false;
                for (let b = b0; b <= b1 && !any; b++) for (let a = a0; a <= a1 && !any; a++) if (r.built[b * fr.ns + a]) any = true;
                if (!any) continue;
                touched = true;
                const planes: Array<[string, (v: Vx) => number]> = [];
                for (const sv of r.s) if (sv > smin && sv < smax) planes.push([`${f.facadeId}s${sv}`, v => st(v)[0] - sv]);
                for (const tv of r.t) if (tv > tmin && tv < tmax) planes.push([`${f.facadeId}t${tv}`, v => st(v)[1] - tv]);
                for (const dvv of [-P.depthBandM, P.depthBandM]) if (dvv > dmin && dvv < dmax) planes.push([`${f.facadeId}d${dvv}`, v => st(v)[2] - dvv]);
                for (const [key, g] of planes) polys = polys.flatMap(poly => split(poly, g, key, pr, cache)).filter(q => q.length >= 3);
                polys = polys.filter(poly => {
                    const c = poly.map(st), cs = c.reduce((s, x) => s + x[0], 0) / c.length, ct = c.reduce((s, x) => s + x[1], 0) / c.length, cd = c.reduce((s, x) => s + x[2], 0) / c.length;
                    const inside = cs > fr.s0 && cs < fr.s1 && ct > fr.t0 && ct < fr.t1 && Math.abs(cd) < P.depthBandM && r.built[cellIndex(ct, r.t) * fr.ns + cellIndex(cs, r.s)];
                    if (inside) report.removedPieces++;
                    return !inside;
                });
            }
            if (!touched) continue;
            report.cutTriangles++;
            // the original goes; its kept pieces are appended
            for (const e of [t + 1, t + 2]) { const o = pr.idxBase + e * pr.idxStride; if (pr.idxSize === 4) dv.setUint32(o, pr.I[t], true); else if (pr.idxSize === 2) dv.setUint16(o, pr.I[t], true); else dv.setUint8(o, pr.I[t]); }
            kept.push(...polys);
            report.keptPieces += polys.length;
        }
        if (kept.length) appended.push({ pr, polys: kept });
    }
    // the kept pieces: one new primitive per source primitive, same material and attributes
    const chunks: Uint8Array[] = [glb.bin];
    let len = glb.bin.length;
    const push = (bytesArr: Uint8Array, target: number) => { const pad = (4 - (len % 4)) % 4; if (pad) { chunks.push(new Uint8Array(pad)); len += pad; } json.bufferViews.push({ buffer: 0, byteOffset: len, byteLength: bytesArr.length, target }); chunks.push(bytesArr); len += bytesArr.length; return json.bufferViews.length - 1; };
    for (const { pr, polys } of appended) {
        const index = new Map<string, number>(), verts: Vx[] = [], tris: number[] = [];
        const idOf = (v: Vx) => { const k = `${v.key}|${Array.from(v.a).join(',')}`; let i = index.get(k); if (i === undefined) { i = verts.length; index.set(k, i); verts.push(v); } return i; };
        for (const poly of polys) for (let k = 1; k + 1 < poly.length; k++) tris.push(idOf(poly[0]), idOf(poly[k]), idOf(poly[k + 1]));
        const src = json.meshes[pr.mesh].primitives[pr.prim];
        const attributes: Record<string, number> = {};
        const names = ['POSITION', ...pr.names];
        names.forEach((name, k) => {
            const c = pr.comps[k], arr = new Float32Array(verts.length * c);
            let off = 0;
            for (let j = 0; j < k; j++) off += j === 0 ? 0 : pr.comps[j];
            verts.forEach((v, i) => { for (let q = 0; q < c; q++) arr[i * c + q] = k === 0 ? v.p[q] : v.a[off + q]; });
            const acc: any = { bufferView: push(new Uint8Array(arr.buffer), 34962), componentType: 5126, count: verts.length, type: c === 1 ? 'SCALAR' : `VEC${c}` };
            if (k === 0) { const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity]; for (const v of verts) for (let q = 0; q < 3; q++) { mn[q] = Math.min(mn[q], v.p[q]); mx[q] = Math.max(mx[q], v.p[q]); } acc.min = mn; acc.max = mx; }
            json.accessors.push(acc);
            attributes[name] = json.accessors.length - 1;
        });
        const idx = Uint32Array.from(tris);
        json.accessors.push({ bufferView: push(new Uint8Array(idx.buffer), 34963), componentType: 5125, count: idx.length, type: 'SCALAR' });
        json.meshes[pr.mesh].primitives.push({ attributes, indices: json.accessors.length - 1, mode: 4, ...(src.material !== undefined ? { material: src.material } : {}), extras: { sbLatticeCut: { version: LATTICE_STITCH_VERSION, provenance: 'as-scanned: the scan cut exactly to the rebuilt cells' } } });
    }
    const pad = (4 - (len % 4)) % 4;
    if (pad) { chunks.push(new Uint8Array(pad)); len += pad; }
    const bin = new Uint8Array(len);
    let o = 0;
    for (const c of chunks) { bin.set(c, o); o += c.length; }
    json.buffers = [{ ...(json.buffers?.[0] ?? {}), byteLength: len }];
    return { glb: assembleGlb(json, bin), report };
}

/** A welded view of a GLB's live triangles: positions, faces, and which faces belong to rebuilt walls. */
function welded(bytes: Uint8Array, P: LatticeStitchParams): { pos: number[][]; tris: number[][]; wall: number[]; idOf: (p: ArrayLike<number>) => number | undefined } {
    const g = parseGlbBytes(bytes);
    const wallMesh = new Map<number, number>();
    for (const n of g.json.nodes ?? []) if (n.mesh !== undefined && n.extras?.sbFacadeLattice) wallMesh.set(n.mesh, n.extras.sbFacadeLattice.facadeId);
    const id = new Map<string, number>(), pos: number[][] = [], tris: number[][] = [], wall: number[] = [];
    const k = (x: number, y: number, z: number) => `${Math.round(x / P.weldM)},${Math.round(y / P.weldM)},${Math.round(z / P.weldM)}`;
    const q = (x: number, y: number, z: number) => { const kk = k(x, y, z); let v = id.get(kk); if (v === undefined) { v = pos.length; id.set(kk, v); pos.push([x, y, z]); } return v; };
    (g.json.meshes ?? []).forEach((m: any, mi: number) => {
        for (const p of m.primitives ?? []) {
            if ((p.mode ?? 4) !== 4 || p.attributes?.POSITION === undefined) continue;
            const X = readAccessor(g, p.attributes.POSITION).data, I = p.indices !== undefined ? readAccessor(g, p.indices).data : undefined;
            const n = I ? I.length : X.length / 3;
            for (let t = 0; t + 2 < n; t += 3) {
                const f = [0, 1, 2].map(j => { const i = I ? I[t + j] : t + j; return q(X[i * 3], X[i * 3 + 1], X[i * 3 + 2]); });
                if (f[0] === f[1] || f[1] === f[2] || f[0] === f[2]) continue;
                tris.push(f); wall.push(wallMesh.get(mi) ?? -1);
            }
        }
    });
    return { pos, tris, wall, idOf: p => id.get(k(p[0], p[1], p[2])) };
}

const ekey = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
/**
 * The open edges: those of an odd number of triangles. Around any vertex the triangle counts of its edges sum to twice its
 * faces, so a vertex always has an even number of odd edges: they always walk into closed loops, and filling each loop once
 * makes every count even (closed, even where the scan is not manifold). `once` keeps only edges of exactly one triangle.
 */
function openEdges(tris: number[][], owner?: Map<string, number>, once = false): Array<[number, number]> {
    const c = new Map<string, number>();
    tris.forEach((f, t) => { for (let k = 0; k < 3; k++) { const e = ekey(f[k], f[(k + 1) % 3]); c.set(e, (c.get(e) ?? 0) + 1); owner?.set(e, t); } });
    const out: Array<[number, number]> = [];
    for (const [k, n] of c) if (once ? n === 1 : n % 2 === 1) { const [a, b] = k.split(',').map(Number); out.push([a, b]); }
    return out;
}

/** Earcut of loops (outer + holes) given 2D coordinates per vertex; undefined when it crosses itself or drops a loop edge. */
function triangulate(outer: number[], holes: number[][], xy: (v: number) => Vector2): number[][] | undefined {
    const contour = outer.map(xy), hs = holes.map(h => h.map(xy));
    const area = (p: Vector2[]) => p.reduce((s, a, i) => s + a.x * p[(i + 1) % p.length].y - p[(i + 1) % p.length].x * a.y, 0);
    let o = outer;
    if (area(contour) < 0) { contour.reverse(); o = [...outer].reverse(); }
    const hh = holes.map((h, k) => (area(hs[k]) > 0 ? (hs[k].reverse(), [...h].reverse()) : h));
    const ids = [...o, ...hh.flat()];
    let faces: number[][];
    try { faces = ShapeUtils.triangulateShape(contour, hs); } catch { return undefined; }
    const out = faces.map(f => [ids[f[0]], ids[f[1]], ids[f[2]]]);
    const got = new Set<string>();
    for (const f of out) for (let k = 0; k < 3; k++) got.add(ekey(f[k], f[(k + 1) % 3]));
    for (const l of [outer, ...holes]) for (let k = 0; k < l.length; k++) if (!got.has(ekey(l[k], l[(k + 1) % l.length]))) return undefined;
    return out;
}

/** Appends triangles (vertex positions) as one node labelled generated (clay in the twin: no photo). */
function appendTriangles(bytes: Uint8Array, tris: number[][][], name: string, method: string, textured: boolean): Buffer {
    const g = parseGlbBytes(bytes);
    const json = g.json;
    if (!tris.length) return assembleGlb(json, g.bin);
    const P = new Float32Array(tris.length * 9);
    tris.forEach((f, i) => { for (let k = 0; k < 3; k++) P.set(f[k], i * 9 + k * 3); });
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let v = 0; v < P.length; v += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], P[v + k]); max[k] = Math.max(max[k], P[v + k]); }
    const off = (g.bin.length + 3) & ~3;
    const bin = new Uint8Array((off + P.byteLength + 3) & ~3);
    bin.set(g.bin, 0); bin.set(new Uint8Array(P.buffer), off);
    json.bufferViews ??= []; json.accessors ??= []; json.meshes ??= []; json.nodes ??= []; json.materials ??= [];
    json.bufferViews.push({ buffer: 0, byteOffset: off, byteLength: P.byteLength, target: 34962 });
    json.accessors.push({ bufferView: json.bufferViews.length - 1, componentType: 5126, count: P.length / 3, type: 'VEC3', min, max });
    let material = 0;
    if (textured || !json.materials.length) { json.materials.push({ name, pbrMetallicRoughness: { baseColorFactor: [0.55, 0.53, 0.5, 1], metallicFactor: 0, roughnessFactor: 0.9 }, doubleSided: true }); material = json.materials.length - 1; }
    json.meshes.push({ name, primitives: [{ attributes: { POSITION: json.accessors.length - 1 }, material, mode: 4 }] });
    json.nodes.push({ name, mesh: json.meshes.length - 1, extras: { sbSeal: { version: LATTICE_STITCH_VERSION, provenance: { label: 'generated', method } } } });
    json.scenes?.[json.scene ?? 0]?.nodes?.push(json.nodes.length - 1);
    json.buffers = [{ ...(json.buffers?.[0] ?? {}), byteLength: bin.length }];
    return assembleGlb(json, bin);
}

export interface StitchReport { segments: number; stitched: number; stripTriangles: number; cornersZipped: number; why: Record<string, number> }

/** The rebuilt walls' outlines stitched to the scan's cut, segment by segment, in each segment's vertical plane. */
export function stitchLattice(clay: Uint8Array, others: Uint8Array[], facades: Facade[], P: LatticeStitchParams = LATTICE_STITCH_PARAMS): { clay: Buffer; others: Buffer[]; report: StitchReport } {
    const w = welded(clay, P);
    const open = openEdges(w.tris, undefined, true);
    const openVerts = new Set(open.flat());
    const report: StitchReport = { segments: 0, stitched: 0, stripTriangles: 0, cornersZipped: 0, why: {} };
    const miss = (k: string) => { report.why[k] = (report.why[k] ?? 0) + 1; };
    const out: number[][][] = [];
    // open scan vertices per facade frame, for the lookup along each outline segment
    for (const { f, r } of facades) {
        const ns = r.s.length - 1, nt = r.t.length - 1;
        const world = (sv: number, tv: number, d: number) => [0, 1, 2].map(k => f.centroid[k] + sv * f.axisS[k] + tv * f.axisT[k] + d * f.normal[k]);
        const local = [...openVerts].map(v => { const m = [w.pos[v][0] - f.centroid[0], w.pos[v][1] - f.centroid[1], w.pos[v][2] - f.centroid[2]]; return { v, s: dot(m, f.axisS), t: dot(m, f.axisT), d: dot(m, f.normal) }; }).filter(x => Math.abs(x.d) <= P.depthBandM + 0.01 && x.s >= r.s[0] - 0.01 && x.s <= r.s[ns] + 0.01 && x.t >= r.t[0] - 0.01 && x.t <= r.t[nt] + 0.01);
        const segment = (s0: number, t0: number, s1: number, t1: number, d: number) => {
            report.segments++;
            const A = w.idOf(Float32Array.from(world(s0, t0, d))), B = w.idOf(Float32Array.from(world(s1, t1, d)));
            if (A === undefined || B === undefined) return miss('wall edge not found');
            if (!openVerts.has(A) || !openVerts.has(B)) return miss('wall edge not open');
            const vertical = s0 === s1, len = vertical ? t1 - t0 : s1 - s0;
            const on = local.filter(x => x.v !== A && x.v !== B && (vertical ? Math.abs(x.s - s0) <= P.onLineM && x.t >= Math.min(t0, t1) - P.onLineM && x.t <= Math.max(t0, t1) + P.onLineM : Math.abs(x.t - t0) <= P.onLineM && x.s >= Math.min(s0, s1) - P.onLineM && x.s <= Math.max(s0, s1) + P.onLineM));
            if (!on.length) return miss('no scan cut on the line');
            const u = (x: { s: number; t: number }) => ((vertical ? x.t - t0 : x.s - s0) / len);
            // the scan's cut along the line: the open edges between points on it, walked into paths; the one spanning most of
            // the segment is the cut of the surface this wall replaced (other layers deeper in the slab are left to the fill)
            const onSet = new Set(on.map(x => x.v)), uOf = new Map(on.map(x => [x.v, u(x)]));
            const ladj = new Map<number, number[]>();
            for (const [a, b] of open) if (onSet.has(a) && onSet.has(b)) { (ladj.get(a) ?? ladj.set(a, []).get(a)!).push(b); (ladj.get(b) ?? ladj.set(b, []).get(b)!).push(a); }
            const seen = new Set<number>();
            let best: number[] | undefined, bestSpan = -1;
            for (const start of ladj.keys()) {
                if (seen.has(start) || (ladj.get(start)!.length !== 1)) continue;
                const path = [start];
                seen.add(start);
                let prev = -1, cur = start;
                for (;;) { const nx = ladj.get(cur)!.find(x => x !== prev && !seen.has(x)); if (nx === undefined) break; path.push(nx); seen.add(nx); prev = cur; cur = nx; }
                const span = Math.abs(uOf.get(path[path.length - 1])! - uOf.get(path[0])!);
                if (span > bestSpan) { bestSpan = span; best = path; }
            }
            if (!best || bestSpan < 0.05) return miss('no cut path along the line');
            // from B's end back to A's end
            const chain = uOf.get(best[0])! < uOf.get(best[best.length - 1])! ? [...best].reverse() : best;
            const loop = [A, B, ...chain];
            const coord = new Map<number, Vector2>([[A, new Vector2(0, d)], [B, new Vector2(1, d)], ...on.map(x => [x.v, new Vector2(u(x), x.d)] as [number, Vector2])]);
            const tri = triangulate(loop, [], v => coord.get(v)!);
            if (!tri) return miss('strip did not triangulate');
            report.stitched++;
            for (const t of tri) out.push(t.map(v => w.pos[v]));
        };
        for (let b = 0; b < nt; b++) for (let a = 0; a < ns; a++) {
            if (!r.built[b * ns + a]) continue;
            const d = r.depth[b][a];
            if (a === 0 || !r.built[b * ns + a - 1]) segment(r.s[a], r.t[b], r.s[a], r.t[b + 1], d);
            if (a === ns - 1 || !r.built[b * ns + a + 1]) segment(r.s[a + 1], r.t[b], r.s[a + 1], r.t[b + 1], d);
            if (b === 0 || !r.built[(b - 1) * ns + a]) segment(r.s[a], r.t[b], r.s[a + 1], r.t[b], d);
            if (b === nt - 1 || !r.built[(b + 1) * ns + a]) segment(r.s[a], r.t[b + 1], r.s[a + 1], r.t[b + 1], d);
        }
    }
    // walls meeting at a building corner: the open edges of each facade's outline that found no scan (their vertices are that
    // wall's only), walked into chains, zipped by height to another facade's chain running beside them within cornerGapM
    const usedEdge = new Set<string>();
    for (const t of out) { const ids = t.map(p => w.idOf(Float32Array.from(p))!); for (let k = 0; k < 3; k++) usedEdge.add(ekey(ids[k], ids[(k + 1) % 3])); }
    const wallOf = new Map<number, number>();
    w.tris.forEach((f, i) => { if (w.wall[i] >= 0) for (const v of f) wallOf.set(v, w.wall[i]); });
    const free = open.filter(([a, b]) => !usedEdge.has(ekey(a, b)) && wallOf.has(a) && wallOf.get(a) === wallOf.get(b) && Math.abs(w.pos[a][1] - w.pos[b][1]) > 1e-6);
    // chains: per facade, the near-vertical open wall edges joined end to end, ordered by height
    const byFacade = new Map<number, Array<[number, number]>>();
    for (const e of free) { const k = wallOf.get(e[0])!; (byFacade.get(k) ?? byFacade.set(k, []).get(k)!).push(e); }
    const chains: Array<{ facade: number; vs: number[] }> = [];
    for (const [facade, es] of byFacade) {
        const adj = new Map<number, number[]>();
        for (const [a, b] of es) { (adj.get(a) ?? adj.set(a, []).get(a)!).push(b); (adj.get(b) ?? adj.set(b, []).get(b)!).push(a); }
        const seen = new Set<number>();
        for (const start of adj.keys()) {
            if (seen.has(start) || adj.get(start)!.length !== 1) continue;
            const vs = [start]; seen.add(start);
            let prev = -1, cur = start;
            for (;;) { const nx = adj.get(cur)!.find(x => x !== prev && !seen.has(x)); if (nx === undefined) break; vs.push(nx); seen.add(nx); prev = cur; cur = nx; }
            if (vs.length >= 2) chains.push({ facade, vs: w.pos[vs[0]][1] <= w.pos[vs[vs.length - 1]][1] ? vs : vs.reverse() });
        }
    }
    const horiz = (a: number, b: number) => Math.hypot(w.pos[a][0] - w.pos[b][0], w.pos[a][2] - w.pos[b][2]);
    const taken = new Set<number>();
    chains.forEach((c1, i) => {
        if (taken.has(i)) return;
        let best = -1, bestGap = Infinity;
        chains.forEach((c2, j) => {
            if (j === i || taken.has(j) || c2.facade === c1.facade) return;
            const lo = Math.max(w.pos[c1.vs[0]][1], w.pos[c2.vs[0]][1]), hi = Math.min(w.pos[c1.vs[c1.vs.length - 1]][1], w.pos[c2.vs[c2.vs.length - 1]][1]);
            if (!(hi - lo > 0.5)) return;
            const gap = horiz(c1.vs[0], c2.vs[0]) + horiz(c1.vs[c1.vs.length - 1], c2.vs[c2.vs.length - 1]);
            if (gap / 2 <= P.cornerGapM && gap < bestGap) { bestGap = gap; best = j; }
        });
        if (best < 0) return;
        taken.add(i); taken.add(best);
        const a = c1.vs, b = chains[best].vs, y = (v: number) => w.pos[v][1];
        let x = 0, z = 0;
        while (x < a.length - 1 || z < b.length - 1) {
            if (z >= b.length - 1 || (x < a.length - 1 && y(a[x + 1]) <= y(b[z + 1]))) { out.push([w.pos[a[x]], w.pos[b[z]], w.pos[a[x + 1]]]); x++; }
            else { out.push([w.pos[a[x]], w.pos[b[z]], w.pos[b[z + 1]]]); z++; }
        }
        report.cornersZipped++;
    });
    report.stripTriangles = out.length;
    const method = 'the rebuilt walls stitched to the scan cut to them (a strip along each edge of a rebuilt outline, in its vertical plane) and to each other at the building\'s corners';
    return { clay: appendTriangles(clay, out, 'LatticeStitch', method, false), others: others.map(o => appendTriangles(o, out, 'LatticeStitch', method, true)), report };
}

/** openBefore / openAfter: edges of an odd number of triangles (open); nonManifoldAfter: closed edges of four or more. */
export interface FillReport { openBefore: number; kinds: Record<string, number>; loops: number; filled: number; clipped3d: number; skippedWallOnly: number; openPathEdges: number; openAfter: number; nonManifoldAfter: number; addedAreaM2: number }

/** The open loops left closed (the scan's holes, corners, the base: the bottom capped), counted again after. */
export function fillOpenLoops(clay: Uint8Array, others: Uint8Array[], P: LatticeStitchParams = LATTICE_STITCH_PARAMS): { clay: Buffer; others: Buffer[]; report: FillReport } {
    const w = welded(clay, P);
    const owner = new Map<string, number>();
    const open = openEdges(w.tris, owner);
    const wallFacade = new Map<number, number>();
    w.tris.forEach((f, i) => { if (w.wall[i] >= 0) for (const v of f) wallFacade.set(v, w.wall[i]); });
    const scanVert = new Set<number>();
    w.tris.forEach((f, i) => { if (w.wall[i] < 0) for (const v of f) scanVert.add(v); });
    // loops: trails over the open edges, split where a walk comes back to a vertex, turning to the nearest edge at a junction
    const adj = new Map<number, number[]>();
    for (const [a, b] of open) { (adj.get(a) ?? adj.set(a, []).get(a)!).push(b); (adj.get(b) ?? adj.set(b, []).get(b)!).push(a); }
    const used = new Set<string>(), loops: number[][] = [];
    let openPathEdges = 0;
    const d2 = (a: number, b: number) => (w.pos[a][0] - w.pos[b][0]) ** 2 + (w.pos[a][1] - w.pos[b][1]) ** 2 + (w.pos[a][2] - w.pos[b][2]) ** 2;
    for (const [a0, b0] of open) {
        if (used.has(ekey(a0, b0))) continue;
        used.add(ekey(a0, b0));
        const path = [a0], at = new Map<number, number>([[a0, 0]]);
        let prev = a0, cur = b0;
        for (let guard = 0; guard < 500000; guard++) {
            const k = at.get(cur);
            if (k !== undefined) {
                const loop = path.splice(k);
                for (const v of loop) at.delete(v);
                if (loop.length >= 3) loops.push(loop); else openPathEdges += loop.length - 1;
                if (!path.length) break;
            }
            at.set(cur, path.length); path.push(cur);
            let nx = -1, bd = Infinity;
            for (const x of adj.get(cur)!) if (!used.has(ekey(cur, x)) && x !== prev) { const d = d2(cur, x); if (d < bd) { bd = d; nx = x; } }
            if (nx < 0) for (const x of adj.get(cur)!) if (!used.has(ekey(cur, x))) { nx = x; break; }
            if (nx < 0) break;
            used.add(ekey(cur, nx));
            prev = cur; cur = nx;
        }
        openPathEdges += Math.max(0, path.length - 1);
    }
    const kinds: Record<string, number> = {};
    for (const [a, b] of open) {
        const fa = wallFacade.get(a), fb = wallFacade.get(b);
        const k = fa !== undefined && fb !== undefined ? (fa === fb ? 'inside one wall' : 'between two walls') : fa !== undefined || fb !== undefined ? 'wall to scan' : 'scan';
        kinds[k] = (kinds[k] ?? 0) + 1;
    }
    const report: FillReport = { openBefore: open.length, kinds, loops: loops.length, filled: 0, clipped3d: 0, skippedWallOnly: 0, openPathEdges, openAfter: 0, nonManifoldAfter: 0, addedAreaM2: 0 };
    const out: number[][][] = [], addedFaces: number[][] = [];
    for (const l of loops) {
        // a loop of one rebuilt wall's vertices only is either a hole the wall surrounds (filled) or the wall's own outer
        // outline (filling it would double the wall): seen in the loop's plane, the wall lies outside a hole and inside an outline
        const facadesOf = new Set(l.map(v => wallFacade.get(v) ?? -1));
        const wallOnly = !l.some(v => scanVert.has(v)) && facadesOf.size === 1 && !facadesOf.has(-1);
        const n = [0, 0, 0];
        for (let i = 0; i < l.length; i++) { const a = w.pos[l[i]], b = w.pos[l[(i + 1) % l.length]]; n[0] += (a[1] - b[1]) * (a[2] + b[2]); n[1] += (a[2] - b[2]) * (a[0] + b[0]); n[2] += (a[0] - b[0]) * (a[1] + b[1]); }
        const nl = Math.hypot(n[0], n[1], n[2]);
        let tri: number[][] | undefined;
        if (nl > 1e-12) {
            const N = n.map(x => x / nl), ref = Math.abs(N[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
            const U0 = [ref[1] * N[2] - ref[2] * N[1], ref[2] * N[0] - ref[0] * N[2], ref[0] * N[1] - ref[1] * N[0]], ul = Math.hypot(U0[0], U0[1], U0[2]);
            const U = U0.map(x => x / ul), V = [N[1] * U[2] - N[2] * U[1], N[2] * U[0] - N[0] * U[2], N[0] * U[1] - N[1] * U[0]];
            const xy = (p: ArrayLike<number>) => new Vector2(dot(p, U), dot(p, V));
            if (wallOnly) {
                const t = w.tris[owner.get(ekey(l[0], l[1]))!], c = [0, 1, 2].map(k => (w.pos[t[0]][k] + w.pos[t[1]][k] + w.pos[t[2]][k]) / 3);
                const poly = l.map(v => xy(w.pos[v])), q = xy(c);
                let inside = false;
                for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a.y > q.y) !== (b.y > q.y) && q.x < ((b.x - a.x) * (q.y - a.y)) / (b.y - a.y) + a.x) inside = !inside; }
                if (inside) { report.skippedWallOnly++; continue; }
            }
            tri = triangulate(l, [], v => xy(w.pos[v]));
        } else if (wallOnly) { report.skippedWallOnly++; continue; }
        if (tri) { report.filled++; for (const t of tri) { addedFaces.push(t); out.push(t.map(v => w.pos[v])); } continue; }
        // a loop that does not lie flat: closed in 3D by cutting off, again and again, the ear whose closing edge is shortest
        // (greedy Liepa): every loop edge used once, the triangles kept local, no fan from a far centre
        const ring = [...l];
        while (ring.length > 3) {
            let bi = 0, bd = Infinity;
            for (let k = 0; k < ring.length; k++) { const d = d2(ring[(k - 1 + ring.length) % ring.length], ring[(k + 1) % ring.length]); if (d < bd) { bd = d; bi = k; } }
            const t = [ring[(bi - 1 + ring.length) % ring.length], ring[bi], ring[(bi + 1) % ring.length]];
            addedFaces.push(t); out.push(t.map(v => w.pos[v]));
            ring.splice(bi, 1);
        }
        addedFaces.push(ring); out.push(ring.map(v => w.pos[v]));
        report.clipped3d++;
    }
    const counts = new Map<string, number>();
    for (const f of [...w.tris, ...addedFaces]) for (let k = 0; k < 3; k++) { const e = ekey(f[k], f[(k + 1) % 3]); counts.set(e, (counts.get(e) ?? 0) + 1); }
    for (const c of counts.values()) { if (c % 2 === 1) report.openAfter++; else if (c > 2) report.nonManifoldAfter++; }
    for (const t of out) { const a = t[0], b = t[1], c = t[2]; const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2]; report.addedAreaM2 += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx); }
    report.addedAreaM2 = Math.round(report.addedAreaM2);
    const method = 'the shell closed: every open loop left (the scan\'s own holes, corners, the base, which caps the bottom) triangulated in its best-fitting plane';
    return { clay: appendTriangles(clay, out, 'Seal', method, false), others: others.map(o => appendTriangles(o, out, 'Seal', method, true)), report };
}
