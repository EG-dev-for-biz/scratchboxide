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
 *     wall). Open means an edge of an odd number of triangles: such edges always form closed loops. A large loop is first
 *     split where it comes closest to itself, and no fill triangle may poke out of the building (above its top-down height
 *     map or past its footprint): a loop with no such ear left stays open and is counted. Closed where it is safe: a loop
 *     whose rim strays off its own plane around a cap of any size (rimPlanarM, offRimCapM2) stays open and is counted too.
 *
 * Cut and stitch hold together (facade-lattice.ts): a rebuilt cell with an outline edge the stitch joins to nothing (no
 * strip, no corner zip) is left as scan, and the cut and stitch run again, so the fill never has to cap a seam.
 *
 * Every added triangle uses existing vertices exactly (plus a fan's centre), so the result welds shut. The open edges
 * left are counted on the welded result and reported.
 *
 * The cut, the stitch's strips and the fill run natively by default (scratchbox_lattice_cut.hpp, scratchbox_lattice_stitch.hpp,
 * scratchbox_open_loop_fill.hpp, through remesh-polish-native.ts), giving these functions' results bit for bit;
 * SCRATCHBOX_K_NATIVE without `cut`, `stitch` or `infill` runs them here.
 */

import { ShapeUtils, Vector2 } from 'three';
import type { Vec2 } from '../../../../common/spatial/staged-location-contracts';
import { outsideFootprint, signedFootprintDistance } from './base-cleanup';
import { accessorLayout, assembleGlb, parseGlbBytes, readAccessor } from '../glb-bytes';
import type { FacadeLatticeResult, ReliefFacade } from '../facade-lattice';
import { nativePolishThreads, runNativeCut, runNativeFill, runNativeStitch, type NativeFillPrim } from '../remesh-polish-native';
import { kNative } from './native/native-switch';

export const LATTICE_STITCH_VERSION = 'lattice-stitch/21';

export const LATTICE_STITCH_PARAMS = {
    /** The slab of a rebuilt facade cut from the scan: within this of its plane (m). */
    depthBandM: 2,
    /** Vertices closer than this are one (m), for the stitch and the fill. */
    weldM: 0.001,
    /** A point lies on a lattice line within this (m). */
    onLineM: 0.002,
    /** Two facades' open outline edges this close side by side (m) are zipped together: walls meeting at a corner. */
    cornerGapM: 2.5,
    /** Fill: a loop longer than this (m) is split where two of its points are closer than splitRatio of their distance along it. */
    splitPerimeterM: 8, splitRatio: 0.35,
    /** Cut: only scan triangles facing along a facade (|cos| of their normal to its normal at least this) are wall it replaces; roofs, ledges and terraces meeting it stay. */
    cutFacingMin: 0.5,
    /** Cut: keep the pieces over the rebuilt cells too (the scan only split at the cells' lines), for a caller that removes them itself (facade-lattice.ts, under its tear audit). */
    cutKeepInside: false,
    /** Cut: only the scan facing the way the rebuilt wall faces (not a parapet's or a thin wall's other side behind it, which the rebuild does not replace). */
    cutSameFacing: false,
    /** Fill lying on a surface the scan already has (its centre, corners and points along its edges within this (m) of it, facing alike) is a second skin, not a hole: dropped. */
    doubledM: 0.02,
    /** Fill a rebuilt wall already stands in for (parallel to it, within this of it (m), over it at every probe) is dropped: the scan
     *  removed over the rebuilt cells leaves loops around them, and capping those would draw the old flat scan back in front of the
     *  recessed rebuild. Probed on a grid of coveredByWallCellM (m). */
    coveredByWallM: 1, coveredByWallCellM: 2,
    /** The building's envelope for the fill: its top-down height map at this cell (m); a fill triangle past it or the footprint by the margin (m) pokes out. */
    envelopeCellM: 1, envelopeMarginM: 0.3,
    /** Fill texturing: a triangle facing along a rebuilt facade (|cos| at least this), within wallBandM (m) of its depth range and over its ortho (UVs within the margin of 0..1), is that wall's infill. */
    wallFacingMin: 0.9, wallBandM: 0.5, wallUvMargin: 0.002,
    /** Fill texturing elsewhere: corner UVs only when their mapping is sheared no more than this (larger over smaller stretch). */
    maxShear: 2,
    /** Fill no photo reached: continued from the nearest rebuilt facade facing within this |cos|, no further than continueMaxM (m). */
    continueFacingMin: 0.9, continueMaxM: 12,
    /** A facade's repeat cell (bay by storey pitch) is read from at least this many fitted windows; with fewer it has none. */
    repeatMinWindows: 4,
    /** Confidence of each infill route (sbSeal _CONFIDENCE): on the wall's own photo, the photo at the corners, continued from
     *  a facade's repeat cell, continued with no repeat cell (the photo folded whole); a continued piece's falls with its
     *  distance, to confidenceFloor of its route's at continueMaxM. */
    confidenceWall: 0.8, confidenceCorner: 0.6, confidenceRepeat: 0.5, confidenceNoRepeat: 0.25, confidenceFloor: 0.4,
    /** Fill over a surface already there: at least skinShare of its probes within skinM (m) of one facing alike (a scan with relief under it is not flat). Shown only in the clay, not the textured twin. */
    skinM: 0.5, skinShare: 0.75,
    /** A loop whose rim strays off its best-fit plane by more than rimPlanarM (m) is left open when its cap would exceed offRimCapM2 (m²). */
    rimPlanarM: 0.25, offRimCapM2: 1,
    /** A cap faces outward when a ray from it, the way it faces, meets no surface of the building within capRayM (m), started
     *  capRayStartM off it; judged from up to capRaySamples of its largest triangles, the majority deciding. */
    capRayM: 120, capRayStartM: 0.05, capRaySamples: 5,
    /** The textured twin judges the fill in pieces no longer than this (m) along any edge. */
    pieceM: 2
};
export type LatticeStitchParams = typeof LATTICE_STITCH_PARAMS;

type Facade = { f: ReliefFacade; r: FacadeLatticeResult };
const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** A vertex: position and every other attribute, flattened. */
export interface Vx { p: [number, number, number]; a: Float64Array; key: string }
const keyOf = (p: ArrayLike<number>) => `${p[0]},${p[1]},${p[2]}`;

export interface PrimRead { mesh: number; prim: number; names: string[]; comps: number[]; flags: boolean[]; data: Float64Array[]; I: ArrayLike<number>; idxBase: number; idxStride: number; idxSize: number }

export function readPrims(glb: ReturnType<typeof parseGlbBytes>): PrimRead[] {
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

export function vertexOf(pr: PrimRead, i: number): Vx {
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
export function split(poly: Vx[], g: (v: Vx) => number, plane: string, pr: PrimRead, cache: Map<string, Vx>): [Vx[], Vx[]] {
    const neg: Vx[] = [], pos: Vx[] = [], gs = poly.map(v => { const x = g(v); return Math.abs(x) < 1e-9 ? 0 : x; });
    for (let i = 0; i < poly.length; i++) {
        const u = poly[i], v = poly[(i + 1) % poly.length], gu = gs[i], gv = gs[(i + 1) % poly.length];
        if (gu <= 0) neg.push(u);
        if (gu >= 0) pos.push(u);
        if ((gu < 0 && gv > 0) || (gu > 0 && gv < 0)) {
            // keyed by the ends' attributes too: across a UV seam two triangles share an edge's positions but not its UVs, and
            // must not share its cut point (its position is the same either way: cutPoint orders the ends by position)
            const ek = (x: Vx) => `${x.key}#${x.a.join(',')}`;
            const ck = u.key < v.key ? `${ek(u)}|${ek(v)}|${plane}` : `${ek(v)}|${ek(u)}|${plane}`;
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

/** The native cut's parameters (scratchbox_lattice_cut.hpp Params). */
export function cutParamVector(P: LatticeStitchParams): number[] {
    return [P.depthBandM, P.cutFacingMin, P.cutKeepInside ? 1 : 0, P.cutSameFacing ? 1 : 0];
}

/** A removed triangle made degenerate in place: its last two indices set to its first. */
function degenerate(dv: DataView, pr: PrimRead, t: number): void {
    for (const e of [t + 1, t + 2]) { const o = pr.idxBase + e * pr.idxStride; if (pr.idxSize === 4) dv.setUint32(o, pr.I[t], true); else if (pr.idxSize === 2) dv.setUint16(o, pr.I[t], true); else dv.setUint8(o, pr.I[t]); }
}

/** The scan cut to the rebuilt cells: pieces inside them removed, the rest kept (exact cut edges, attributes carried). */
export function cutScanToLattice(bytes: Uint8Array, facades: Facade[], P: LatticeStitchParams = LATTICE_STITCH_PARAMS, opts: { /** The native cut's threads (every core when none). */ threads?: number } = {}): { glb: Buffer; report: CutReport } {
    const glb = parseGlbBytes(bytes);
    const json = glb.json;
    const dv = new DataView(glb.bin.buffer, glb.bin.byteOffset, glb.bin.byteLength);
    const extras = { sbLatticeCut: { version: LATTICE_STITCH_VERSION, provenance: 'as-scanned: the scan cut exactly to the rebuilt cells' } };
    if (kNative('cut')) {
        // natively: the same pieces, welded as appendPieces welds them
        const prims = readPrims(glb);
        const r = runNativeCut(cutParamVector(P), facades.map(({ f, r: x }) => ({ facadeId: f.facadeId, centroid: f.centroid, normal: f.normal, axisS: f.axisS, axisT: f.axisT, s: x.s, t: x.t, built: x.built })), prims.map(pr => ({ comps: pr.comps.slice(1), flags: pr.flags, normals: pr.names.map(n => n === 'NORMAL'), pos: pr.data[0], attr: pr.data.slice(1), I: pr.I })), opts.threads ?? nativePolishThreads());
        const welded: WeldedPieces[] = [];
        prims.forEach((pr, i) => {
            const o = r.prims[i];
            for (const t of o.cut) degenerate(dv, pr, t);
            if (o.tris.length) welded.push({ pr, arrays: o.arrays, count: o.verts, min: o.min, max: o.max, tris: o.tris });
        });
        return { glb: appendWelded(glb, welded, extras), report: { cutTriangles: r.report.cutTriangles, removedPieces: r.report.removedPieces, keptPieces: r.report.keptPieces } };
    }
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
            const e1 = [tri[1].p[0] - tri[0].p[0], tri[1].p[1] - tri[0].p[1], tri[1].p[2] - tri[0].p[2]], e2 = [tri[2].p[0] - tri[0].p[0], tri[2].p[1] - tri[0].p[1], tri[2].p[2] - tri[0].p[2]];
            const tn = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]], tl = Math.hypot(tn[0], tn[1], tn[2]);
            let polys: Vx[][] = [tri], touched = false;
            for (const fr of frames) {
                const { f, r } = fr;
                // the rebuilt cells replace wall only: a roof, ledge or terrace meeting the wall is no part of them
                if (!(tl > 0) || (P.cutSameFacing ? dot(tn, f.normal) : Math.abs(dot(tn, f.normal))) < P.cutFacingMin * tl) continue;
                const st = (v: Vx) => { const m = [v.p[0] - f.centroid[0], v.p[1] - f.centroid[1], v.p[2] - f.centroid[2]]; return [dot(m, f.axisS), dot(m, f.axisT), dot(m, f.normal)]; };
                const all = polys.flat().map(st);
                let smin = Infinity, smax = -Infinity, tmin = Infinity, tmax = -Infinity, dmin = Infinity, dmax = -Infinity;
                for (const c of all) { smin = Math.min(smin, c[0]); smax = Math.max(smax, c[0]); tmin = Math.min(tmin, c[1]); tmax = Math.max(tmax, c[1]); dmin = Math.min(dmin, c[2]); dmax = Math.max(dmax, c[2]); }
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
                    return !inside || P.cutKeepInside;
                });
            }
            if (!touched) continue;
            report.cutTriangles++;
            // the original goes; its kept pieces are appended
            degenerate(dv, pr, t);
            kept.push(...polys);
            report.keptPieces += polys.length;
        }
        if (kept.length) appended.push({ pr, polys: kept });
    }
    return { glb: appendPieces(glb, appended, extras), report };
}

/** A source primitive's kept pieces welded: per attribute (POSITION first) its values, the positions' bounds, the triangles. */
interface WeldedPieces { pr: PrimRead; arrays: Float32Array[]; count: number; min: number[]; max: number[]; tris: Uint32Array }

/** The GLB with each source primitive's kept pieces appended as a new primitive (same material and attributes, `extras`). */
export function appendPieces(glb: ReturnType<typeof parseGlbBytes>, appended: Array<{ pr: PrimRead; polys: Vx[][] }>, extras: Record<string, unknown>): Buffer {
    // each primitive's pieces welded: one vertex per position and attributes
    const welded = appended.map(({ pr, polys }): WeldedPieces => {
        const index = new Map<string, number>(), verts: Vx[] = [], tris: number[] = [];
        const idOf = (v: Vx) => { const k = `${v.key}|${Array.from(v.a).join(',')}`; let i = index.get(k); if (i === undefined) { i = verts.length; index.set(k, i); verts.push(v); } return i; };
        for (const poly of polys) for (let k = 1; k + 1 < poly.length; k++) tris.push(idOf(poly[0]), idOf(poly[k]), idOf(poly[k + 1]));
        const arrays = pr.comps.map((c, k) => {
            const arr = new Float32Array(verts.length * c);
            let off = 0;
            for (let j = 0; j < k; j++) off += j === 0 ? 0 : pr.comps[j];
            verts.forEach((v, i) => { for (let q = 0; q < c; q++) arr[i * c + q] = k === 0 ? v.p[q] : v.a[off + q]; });
            return arr;
        });
        const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
        for (const v of verts) for (let q = 0; q < 3; q++) { mn[q] = Math.min(mn[q], v.p[q]); mx[q] = Math.max(mx[q], v.p[q]); }
        return { pr, arrays, count: verts.length, min: mn, max: mx, tris: Uint32Array.from(tris) };
    });
    return appendWelded(glb, welded, extras);
}

/** The GLB with each primitive's welded pieces appended as a new primitive (same material and attributes, `extras`). */
function appendWelded(glb: ReturnType<typeof parseGlbBytes>, welded: WeldedPieces[], extras: Record<string, unknown>): Buffer {
    const json = glb.json;
    // the kept pieces: one new primitive per source primitive, same material and attributes
    const chunks: Uint8Array[] = [glb.bin];
    let len = glb.bin.length;
    const push = (bytesArr: Uint8Array, target: number) => { const pad = (4 - (len % 4)) % 4; if (pad) { chunks.push(new Uint8Array(pad)); len += pad; } json.bufferViews.push({ buffer: 0, byteOffset: len, byteLength: bytesArr.length, target }); chunks.push(bytesArr); len += bytesArr.length; return json.bufferViews.length - 1; };
    for (const { pr, arrays, count, min, max, tris } of welded) {
        const src = json.meshes[pr.mesh].primitives[pr.prim];
        const attributes: Record<string, number> = {};
        const names = ['POSITION', ...pr.names];
        names.forEach((name, k) => {
            const c = pr.comps[k], arr = arrays[k];
            const acc: any = { bufferView: push(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength), 34962), componentType: 5126, count, type: c === 1 ? 'SCALAR' : `VEC${c}` };
            if (k === 0) { acc.min = min; acc.max = max; }
            json.accessors.push(acc);
            attributes[name] = json.accessors.length - 1;
        });
        json.accessors.push({ bufferView: push(new Uint8Array(tris.buffer, tris.byteOffset, tris.byteLength), 34963), componentType: 5125, count: tris.length, type: 'SCALAR' });
        json.meshes[pr.mesh].primitives.push({ attributes, indices: json.accessors.length - 1, mode: 4, ...(src.material !== undefined ? { material: src.material } : {}), extras });
    }
    const pad = (4 - (len % 4)) % 4;
    if (pad) { chunks.push(new Uint8Array(pad)); len += pad; }
    const bin = new Uint8Array(len);
    let o = 0;
    for (const c of chunks) { bin.set(c, o); o += c.length; }
    json.buffers = [{ ...(json.buffers?.[0] ?? {}), byteLength: len }];
    return assembleGlb(json, bin);
}

/**
 * The building clipped to its footprint (pipeline K, after the base cleanup): every surface, at any height, cut where it
 * crosses the footprint's outline pushed out by marginM, and the pieces outside dropped. A triangle with a corner outside is
 * split along each outline edge's offset line it crosses (the line's zero found on each triangle edge from the ends in one
 * fixed order, so neighbours share the cut), and each piece is kept or dropped by where its centre stands. Every vertex
 * attribute is carried (UVs, normals), so the textured twin is clipped the same way. The openings the cut leaves are for the
 * fill (fillOpenLoops) to close.
 */
export function clipToFootprint(bytes: Uint8Array, loops: Vec2[][], marginM: number): { glb: Buffer; report: ClipReport } {
    const glb = parseGlbBytes(bytes);
    const dv = new DataView(glb.bin.buffer, glb.bin.byteOffset, glb.bin.byteLength);
    const report: ClipReport = { cutTriangles: 0, removedTriangles: 0, removedAreaM2: 0, marginM };
    const outside = (x: number, z: number) => signedFootprintDistance(x, z, loops) - marginM;
    // each outline edge's line, pushed out by the margin: its outward normal is the side a point just off its middle stands outside
    const lines: Array<{ key: string; g: (v: Vx) => number }> = [];
    loops.forEach((loop, li) => loop.forEach((a, i) => {
        const b = loop[(i + 1) % loop.length], dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz);
        if (!(l > 0)) return;
        let nx = dz / l, nz = -dx / l;
        const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
        if (signedFootprintDistance(mx + nx * 1e-3, mz + nz * 1e-3, loops) < 0) { nx = -nx; nz = -nz; }
        lines.push({ key: `fp${li}.${i}`, g: v => (v.p[0] - a[0]) * nx + (v.p[2] - a[1]) * nz - marginM });
    }));
    const area = (poly: Vx[]) => { let s = 0; for (let k = 1; k + 1 < poly.length; k++) s += Math.hypot(...cross3(sub3(poly[k].p, poly[0].p), sub3(poly[k + 1].p, poly[0].p)) as [number, number, number]) / 2; return s; };
    const centreOutside = (poly: Vx[]) => outside(poly.reduce((a, v) => a + v.p[0], 0) / poly.length, poly.reduce((a, v) => a + v.p[2], 0) / poly.length) > 0;
    const appended: Array<{ pr: PrimRead; polys: Vx[][] }> = [];
    for (const pr of readPrims(glb)) {
        const kept: Vx[][] = [];
        const cache = new Map<string, Vx>();
        for (let t = 0; t + 2 < pr.I.length; t += 3) {
            const ids = [pr.I[t], pr.I[t + 1], pr.I[t + 2]];
            if (ids[0] === ids[1] || ids[1] === ids[2] || ids[0] === ids[2]) continue;
            const tri = ids.map(i => vertexOf(pr, i));
            if (tri.every(v => outside(v.p[0], v.p[2]) < 0)) continue;
            let polys: Vx[][] = [tri];
            for (const { key, g } of lines) {
                if (!polys.some(poly => { const gs = poly.map(g); return Math.min(...gs) < -1e-9 && Math.max(...gs) > 1e-9; })) continue;
                polys = polys.flatMap(poly => split(poly, g, key, pr, cache)).filter(q => q.length >= 3);
            }
            const inside = polys.filter(poly => !centreOutside(poly));
            if (inside.length === 1 && polys.length === 1) continue;
            // the original goes; what lies inside is appended
            for (const e of [t + 1, t + 2]) { const o = pr.idxBase + e * pr.idxStride; if (pr.idxSize === 4) dv.setUint32(o, pr.I[t], true); else if (pr.idxSize === 2) dv.setUint16(o, pr.I[t], true); else dv.setUint8(o, pr.I[t]); }
            for (const poly of polys) if (centreOutside(poly)) report.removedAreaM2 += area(poly);
            if (inside.length) { report.cutTriangles++; kept.push(...inside); } else report.removedTriangles++;
        }
        if (kept.length) appended.push({ pr, polys: kept });
    }
    report.removedAreaM2 = Math.round(report.removedAreaM2);
    return { glb: appendPieces(glb, appended, { sbFootprintClip: { version: LATTICE_STITCH_VERSION, provenance: `as-scanned: the scan cut at the footprint's outline plus ${marginM} m` } }), report };
}

export interface ClipReport { cutTriangles: number; removedTriangles: number; removedAreaM2: number; marginM: number }

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

// an edge's key, its two vertex ids in one number (ids under 2^26): Map and Set keep insertion order whatever the key,
// and a number key costs no string per edge (a build's infill counts millions)
const EDGE_BASE = 2 ** 26;
const ekey = (a: number, b: number) => (a < b ? a * EDGE_BASE + b : b * EDGE_BASE + a);
/**
 * The open edges: those of an odd number of triangles. Around any vertex the triangle counts of its edges sum to twice its
 * faces, so a vertex always has an even number of odd edges: they always walk into closed loops, and filling each loop once
 * makes every count even (closed, even where the scan is not manifold). `once` keeps only edges of exactly one triangle.
 */
function openEdges(tris: number[][], owner?: Map<number, number>, once = false): Array<[number, number]> {
    const c = new Map<number, number>();
    tris.forEach((f, t) => { for (let k = 0; k < 3; k++) { const e = ekey(f[k], f[(k + 1) % 3]); c.set(e, (c.get(e) ?? 0) + 1); owner?.set(e, t); } });
    const out: Array<[number, number]> = [];
    for (const [k, n] of c) if (once ? n === 1 : n % 2 === 1) out.push([Math.floor(k / EDGE_BASE), k % EDGE_BASE]);
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
    const got = new Set<number>();
    for (const f of out) for (let k = 0; k < 3; k++) got.add(ekey(f[k], f[(k + 1) % 3]));
    for (const l of [outer, ...holes]) for (let k = 0; k < l.length; k++) if (!got.has(ekey(l[k], l[(k + 1) % l.length]))) return undefined;
    return out;
}

const sub3 = (a: ArrayLike<number>, b: ArrayLike<number>) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const uvArea = (t: number[][]) => Math.abs((t[1][0] - t[0][0]) * (t[2][1] - t[0][1]) - (t[2][0] - t[0][0]) * (t[1][1] - t[0][1]));
const dist3 = (a: ArrayLike<number>, b: ArrayLike<number>) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const cross3 = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** A grid cell's key: three cell indices in one number while each is under 2^16 from the origin, else a string (never shared). */
const CELL_OFF = 2 ** 16, CELL_BASE = 2 ** 17;
const cellKey = (x: number, y: number, z: number): number | string => (Math.abs(x) < CELL_OFF && Math.abs(y) < CELL_OFF && Math.abs(z) < CELL_OFF ? ((x + CELL_OFF) * CELL_BASE + (y + CELL_OFF)) * CELL_BASE + (z + CELL_OFF) : `${x},${y},${z}`);
/** (u x v) . m, in the order dot(cross3(u, v), m) computes it. */
const crossDot = (ux: number, uy: number, uz: number, vx: number, vy: number, vz: number, m0: number, m1: number, m2: number) => (uy * vz - uz * vy) * m0 + (uz * vx - ux * vz) * m1 + (ux * vy - uy * vx) * m2;

/**
 * The cells of size C any point of these triangles can fall in: each triangle sampled on a barycentric grid no coarser than C,
 * every sample's cell and its neighbours (a point of the triangle lies within C of a sample, so within one cell of its cell).
 */
function cellsUnder(tris: number[][][], C: number): Set<number | string> {
    const seen = new Set<number | string>(), out = new Set<number | string>();
    for (const [a, b, c] of tris) {
        const div = Math.max(1, Math.ceil(Math.max(dist3(a, b), dist3(b, c), dist3(c, a)) / C));
        for (let i = 0; i <= div; i++) for (let j = 0; i + j <= div; j++) {
            const u = i / div, v = j / div;
            const x = Math.floor((a[0] + (b[0] - a[0]) * u + (c[0] - a[0]) * v) / C), y = Math.floor((a[1] + (b[1] - a[1]) * u + (c[1] - a[1]) * v) / C), z = Math.floor((a[2] + (b[2] - a[2]) * u + (c[2] - a[2]) * v) / C);
            const k = cellKey(x, y, z);
            if (seen.has(k)) continue;
            seen.add(k);
            for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) out.add(cellKey(x + dx, y + dy, z + dz));
        }
    }
    return out;
}

/**
 * Whether a point lies on one of these triangles (within tol, inside it, facing like n within about 25°), none touching the
 * vertices `not`. Each triangle's corners, normal and its length are computed once, and a query allocates nothing: the
 * infill asks this millions of times. With `near`, only points on those triangles are asked about: the grid holds only the
 * cells under them.
 */
function surfaceProbe(pos: number[][], tris: number[][], tol: number, C = 1, near?: number[][][]): (q: number[], n: number[], not?: number[]) => boolean {
    const focus = near ? cellsUnder(near, C) : undefined;
    const grid = new Map<number | string, number[]>();
    // per triangle: a, b, c, the normal m = (b - a) x (c - a) and |m|
    const T = new Float64Array(tris.length * 13);
    if (!focus || focus.size) tris.forEach((f, t) => {
        const [a, b, c] = f.map(v => pos[v]);
        const m = cross3(sub3(b, a), sub3(c, a));
        T.set([a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], m[0], m[1], m[2], Math.hypot(m[0], m[1], m[2])], t * 13);
        const lo = [0, 1, 2].map(k => Math.floor((Math.min(a[k], b[k], c[k]) - tol) / C)), hi = [0, 1, 2].map(k => Math.floor((Math.max(a[k], b[k], c[k]) + tol) / C));
        if ((hi[0] - lo[0] + 1) * (hi[1] - lo[1] + 1) * (hi[2] - lo[2] + 1) > 4000) return;
        for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) {
            const k = cellKey(x, y, z);
            if (focus && !focus.has(k)) continue;
            const l = grid.get(k);
            if (l) l.push(t); else grid.set(k, [t]);
        }
    });
    return (q, n, not = []) => {
        const nl = Math.hypot(n[0], n[1], n[2]);
        if (!(nl > 0)) return false;
        const list = grid.get(cellKey(Math.floor(q[0] / C), Math.floor(q[1] / C), Math.floor(q[2] / C)));
        if (!list) return false;
        for (const t of list) {
            if (not.length) { const f = tris[t]; if (not.includes(f[0]) || not.includes(f[1]) || not.includes(f[2])) continue; }
            const o = t * 13, m0 = T[o + 9], m1 = T[o + 10], m2 = T[o + 11], ml = T[o + 12];
            if (!(ml > 0) || Math.abs(m0 * n[0] + m1 * n[1] + m2 * n[2]) < 0.9 * ml * nl) continue;
            const ax = T[o], ay = T[o + 1], az = T[o + 2], bx = T[o + 3], by = T[o + 4], bz = T[o + 5], cx = T[o + 6], cy = T[o + 7], cz = T[o + 8];
            const d = ((q[0] - ax) * m0 + (q[1] - ay) * m1 + (q[2] - az) * m2) / ml;
            if (Math.abs(d) > tol) continue;
            const r0 = q[0] - (m0 * d) / ml, r1 = q[1] - (m1 * d) / ml, r2 = q[2] - (m2 * d) / ml;
            const s1 = crossDot(bx - ax, by - ay, bz - az, r0 - ax, r1 - ay, r2 - az, m0, m1, m2);
            const s2 = crossDot(cx - bx, cy - by, cz - bz, r0 - bx, r1 - by, r2 - bz, m0, m1, m2);
            const s3 = crossDot(ax - cx, ay - cy, az - cz, r0 - cx, r1 - cy, r2 - cz, m0, m1, m2);
            if (s1 >= 0 && s2 >= 0 && s3 >= 0) return true;
        }
        return false;
    };
}

/** The infill's routes, by the code each piece carries in _PROVENANCE. */
const ROUTES = ['clay: no photo', "the rebuilt wall's own photo at that spot", "the photo at the triangle's corners", 'continued from the nearest rebuilt facade facing the same way'];

/**
 * Does a ray meet a triangle of the mesh: from o along unit d, within maxM. The triangles are binned in a grid of cells and the
 * ray walks the cells it passes (Amanatides-Woo), testing each cell's triangles once (Moller-Trumbore).
 */
function rayIndex(pos: number[][], tris: number[][], C = 2): (o: number[], d: number[], maxM: number) => boolean {
    const grid = new Map<string, number[]>();
    tris.forEach((f, t) => {
        const [a, b, c] = f.map(v => pos[v]);
        const lo = [0, 1, 2].map(k => Math.floor(Math.min(a[k], b[k], c[k]) / C)), hi = [0, 1, 2].map(k => Math.floor(Math.max(a[k], b[k], c[k]) / C));
        if ((hi[0] - lo[0] + 1) * (hi[1] - lo[1] + 1) * (hi[2] - lo[2] + 1) > 20000) return;
        for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) { const k = `${x},${y},${z}`; const l = grid.get(k); if (l) l.push(t); else grid.set(k, [t]); }
    });
    const hit = (t: number, o: number[], d: number[], maxM: number) => {
        const [a, b, c] = tris[t].map(v => pos[v]), e1 = sub3(b, a), e2 = sub3(c, a), p = cross3(d, e2), det = dot(e1, p);
        if (Math.abs(det) < 1e-12) return false;
        const s = sub3(o, a), u = dot(s, p) / det;
        if (u < 0 || u > 1) return false;
        const q = cross3(s, e1), v = dot(d, q) / det;
        if (v < 0 || u + v > 1) return false;
        const tt = dot(e2, q) / det;
        return tt > 0 && tt <= maxM;
    };
    return (o, d, maxM) => {
        const cell = o.map(x => Math.floor(x / C)), step = d.map(x => (x > 0 ? 1 : x < 0 ? -1 : 0));
        const tMax = [0, 1, 2].map(k => (d[k] === 0 ? Infinity : ((cell[k] + (d[k] > 0 ? 1 : 0)) * C - o[k]) / d[k]));
        const tDelta = [0, 1, 2].map(k => (d[k] === 0 ? Infinity : C / Math.abs(d[k])));
        const seen = new Set<number>();
        for (let guard = 0; guard < 10000; guard++) {
            for (const t of grid.get(`${cell[0]},${cell[1]},${cell[2]}`) ?? []) { if (seen.has(t)) continue; seen.add(t); if (hit(t, o, d, maxM)) return true; }
            const k = tMax[0] < tMax[1] ? (tMax[0] < tMax[2] ? 0 : 2) : tMax[1] < tMax[2] ? 1 : 2;
            if (tMax[k] > maxM) return false;
            cell[k] += step[k]; tMax[k] += tDelta[k];
        }
        return false;
    };
}

/** A piece of a generated triangle (its parent), shown in the textured twin: its corners and their barycentric weights in the parent. */
interface Piece { parent: number; p: number[][]; w: number[][]; /** How many pieces the parent was cut into. */ of: number }

/**
 * A rebuilt facade's photo mapping, read back from its own mesh: uv = U·p + u0, V·p + v0 (linear on its plane), its normal and
 * depth range, and its repeat cell when its fitted windows give one: the bay and storey pitch in UV (pu, pv).
 */
interface WallMap { material: number; U: number[]; u0: number; V: number[]; v0: number; n: number[]; dLo: number; dHi: number; pu?: number; pv?: number }

/**
 * A facade's bay and storey pitch in its photo's UV, from its fitted windows (sbFacadeLattice.windows.uv, u0 v0 u1 v1 each):
 * the median step to the next window along a row (windows overlapping in v), and to the next along a column (overlapping in u).
 */
export function repeatPitch(uv: ArrayLike<number> | undefined, minWindows = LATTICE_STITCH_PARAMS.repeatMinWindows): { pu?: number; pv?: number } {
    if (!uv || uv.length < 4 * minWindows) return {};
    const r: number[][] = [];
    for (let i = 0; i + 3 < uv.length; i += 4) r.push([Math.min(uv[i], uv[i + 2]), Math.min(uv[i + 1], uv[i + 3]), Math.max(uv[i], uv[i + 2]), Math.max(uv[i + 1], uv[i + 3])]);
    const step = (axis: 0 | 1) => {
        const o = 1 - axis, gaps: number[] = [];
        for (const a of r) {
            let best = Infinity;
            for (const b of r) {
                const d = b[axis] - a[axis];
                if (d <= 1e-6 || Math.min(a[o + 2], b[o + 2]) - Math.max(a[o], b[o]) <= 0.5 * Math.min(a[o + 2] - a[o], b[o + 2] - b[o])) continue;
                best = Math.min(best, d);
            }
            if (Number.isFinite(best)) gaps.push(best);
        }
        if (gaps.length < minWindows) return undefined;
        gaps.sort((x, y) => x - y);
        const m = gaps[Math.floor(gaps.length / 2)];
        return m > 0 && m < 0.5 ? m : undefined;
    };
    const pu = step(0), pv = step(1);
    return { ...(pu ? { pu } : {}), ...(pv ? { pv } : {}) };
}

/**
 * A continued piece's UVs moved into the photo by whole repeat cells: along each axis with a pitch, shifted by the fewest whole
 * pitches that bring the piece inside 0..1 (the facade's nearest repeats, at their own bay and storey); along an axis without
 * one, by whole photos (the photo folded whole, as a wrapping sampler shows it).
 */
export function foldIntoRepeats(uv: number[][], pu?: number, pv?: number): number[][] {
    const shift = (vals: number[], pitch: number) => {
        const lo = Math.min(...vals), hi = Math.max(...vals);
        if (hi > 1) return -Math.ceil((hi - 1) / pitch - 1e-9) * pitch;
        if (lo < 0) return Math.ceil(-lo / pitch - 1e-9) * pitch;
        return 0;
    };
    const su = shift(uv.map(x => x[0]), pu ?? 1), sv = shift(uv.map(x => x[1]), pv ?? 1);
    return uv.map(([u, v]) => [u + su, v + sv]);
}

/**
 * Each textured rebuilt facade's (FacadeLattice node's) mapping from position to its ortho, fitted to its own vertices by
 * least squares (exact: the lattice's UVs are linear in the wall's s and t). A wall of one depth gives no information along
 * its normal, so the fit is ridged: that component stays zero.
 */
function wallMaps(g: ReturnType<typeof parseGlbBytes>): WallMap[] {
    const json = g.json, out: WallMap[] = [];
    for (const node of json.nodes ?? []) {
        if (node.mesh === undefined || !node.extras?.sbFacadeLattice) continue;
        for (const p of json.meshes[node.mesh]?.primitives ?? []) {
            if (p.material === undefined || p.attributes?.TEXCOORD_0 === undefined || !json.materials?.[p.material]?.pbrMetallicRoughness?.baseColorTexture) continue;
            const X = readAccessor(g, p.attributes.POSITION).data, T = readAccessor(g, p.attributes.TEXCOORD_0).data, nv = X.length / 3;
            if (nv < 4) continue;
            const c = [0, 0, 0];
            for (let i = 0; i < nv; i++) for (let k = 0; k < 3; k++) c[k] += X[i * 3 + k] / nv;
            // normal equations of [p - c, 1] -> (u, v)
            const A = Array.from({ length: 4 }, () => new Float64Array(4)), bu = new Float64Array(4), bv = new Float64Array(4);
            for (let i = 0; i < nv; i++) {
                const r = [X[i * 3] - c[0], X[i * 3 + 1] - c[1], X[i * 3 + 2] - c[2], 1];
                for (let a = 0; a < 4; a++) { for (let b = 0; b < 4; b++) A[a][b] += r[a] * r[b]; bu[a] += r[a] * T[i * 2]; bv[a] += r[a] * T[i * 2 + 1]; }
            }
            const ridge = 1e-9 * (A[0][0] + A[1][1] + A[2][2] + 1e-12);
            for (let k = 0; k < 3; k++) A[k][k] += ridge;
            const solve = (b: Float64Array) => {
                const M = A.map((row, i) => [...row, b[i]]);
                for (let col = 0; col < 4; col++) {
                    let piv = col;
                    for (let r = col + 1; r < 4; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
                    [M[col], M[piv]] = [M[piv], M[col]];
                    if (Math.abs(M[col][col]) < 1e-300) return undefined;
                    for (let r = 0; r < 4; r++) if (r !== col) { const f = M[r][col] / M[col][col]; for (let k = col; k < 5; k++) M[r][k] -= f * M[col][k]; }
                }
                return M.map((row, i) => row[4] / M[i][i]);
            };
            const su = solve(bu), sv = solve(bv);
            if (!su || !sv) continue;
            const U = su.slice(0, 3), V = sv.slice(0, 3), n0 = cross3(U, V), nl = Math.hypot(n0[0], n0[1], n0[2]);
            if (!(nl > 0)) continue;
            const n = n0.map(x => x / nl);
            let dLo = Infinity, dHi = -Infinity;
            for (let i = 0; i < nv; i++) { const d = X[i * 3] * n[0] + X[i * 3 + 1] * n[1] + X[i * 3 + 2] * n[2]; dLo = Math.min(dLo, d); dHi = Math.max(dHi, d); }
            out.push({ material: p.material, U, u0: su[3] - dot(U, c), V, v0: sv[3] - dot(V, c), n, dLo, dHi, ...repeatPitch(node.extras.sbFacadeLattice.windows?.uv) });
        }
    }
    return out;
}

/**
 * How far a triangle's corner UVs are from a plain, evenly scaled copy of its shape: the ratio of the larger to the smaller
 * stretch of its 3D-to-UV map (1 for a similarity; a sheared or smeared mapping, the photo seen from the wrong angle, is high).
 */
function uvShear(p: number[][], uv: number[][]): number {
    const e1 = sub3(p[1], p[0]), e2 = sub3(p[2], p[0]), l1 = Math.hypot(e1[0], e1[1], e1[2]);
    if (!(l1 > 0)) return Infinity;
    const x = e1.map(v => v / l1), m = cross3(e1, e2), ml = Math.hypot(m[0], m[1], m[2]);
    if (!(ml > 0)) return Infinity;
    const y = cross3(m.map(v => v / ml), x);
    // the 2D frame of the triangle -> uv: J = [du dv] [x2 y2]^-1
    const a = [l1, 0], b = [dot(e2, x), dot(e2, y)], du = [uv[1][0] - uv[0][0], uv[2][0] - uv[0][0]], dv = [uv[1][1] - uv[0][1], uv[2][1] - uv[0][1]];
    const det = a[0] * b[1] - b[0] * a[1];
    if (Math.abs(det) < 1e-12) return Infinity;
    const j = [(du[0] * b[1] - du[1] * a[1]) / det, (du[1] * a[0] - du[0] * b[0]) / det, (dv[0] * b[1] - dv[1] * a[1]) / det, (dv[1] * a[0] - dv[0] * b[0]) / det];
    const s = j[0] ** 2 + j[1] ** 2 + j[2] ** 2 + j[3] ** 2, d = Math.abs(j[0] * j[3] - j[1] * j[2]);
    const r = Math.sqrt(Math.max(0, s * s / 4 - d * d)), hi = Math.sqrt(s / 2 + r), lo = Math.sqrt(Math.max(0, s / 2 - r));
    return lo > 0 ? hi / lo : Infinity;
}

/**
 * Generated triangles textured as the surface they close, judged piece by piece (the pieces given, else each triangle whole).
 * A piece lying on a rebuilt facade (facing along it, within the wall's depth range plus wallBandM, wholly over its ortho) is
 * infill: it takes that facade's straightened photo at that very spot, through the wall's own planar mapping (the photo where
 * it reached, the facade's repeats where it did not). Any other takes the photo at its triangle's corners (a material all
 * three share, their own UVs, interpolated over the piece), only when that mapping is a plain copy of the triangle's shape
 * (texels per metre within a few times its material's own, no more than maxShear sheared). The rest, where no photo reached
 * (a wall a neighbour hid, user decision 2026-10-28), continues the nearest rebuilt facade facing the same way (facing within
 * continueFacingMin; nearest by its distance outside that facade's photo in the plane plus the planes' distance apart, at most
 * continueMaxM): that facade's own planar mapping carried on across it, the photo repeating past its edges (the facade's
 * material with a repeating sampler); labelled generated. Clay only where no such facade stands. Undefined when the GLB has
 * no textured triangle.
 */
function appendTexturedTriangles(bytes: Uint8Array, tris: number[][][], name: string, method: string, pieces?: Piece[], P: LatticeStitchParams = LATTICE_STITCH_PARAMS): Buffer | undefined {
    if (!tris.length) return undefined;
    let parts: Piece[] = pieces ?? tris.map((f, parent) => ({ parent, p: f, w: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], of: 1 }));
    const g = parseGlbBytes(bytes);
    const json = g.json;
    const walls = wallMaps(g);
    const wk = (p: ArrayLike<number>) => `${Math.round(p[0] * 1000)},${Math.round(p[1] * 1000)},${Math.round(p[2] * 1000)}`;
    const uvOf = new Map<string, Map<number, number[]>>();
    const density = new Map<number, number[]>();
    for (const pr of readPrims(g)) {
        const prim = json.meshes[pr.mesh].primitives[pr.prim];
        const ti = pr.names.indexOf('TEXCOORD_0');
        if (prim.material === undefined || ti < 0 || !json.materials?.[prim.material]?.pbrMetallicRoughness?.baseColorTexture) continue;
        const X = pr.data[0], U = pr.data[ti + 1], mat: number = prim.material;
        const dens = density.get(mat) ?? density.set(mat, []).get(mat)!;
        for (let t = 0; t + 2 < pr.I.length; t += 3) {
            const ids = [pr.I[t], pr.I[t + 1], pr.I[t + 2]];
            for (const i of ids) { const k = wk([X[i * 3], X[i * 3 + 1], X[i * 3 + 2]]); const m = uvOf.get(k) ?? uvOf.set(k, new Map()).get(k)!; if (!m.has(mat)) m.set(mat, [U[i * 2], U[i * 2 + 1]]); }
            if (t % 30 === 0) { const [a, b, c] = ids.map(i => [X[i * 3], X[i * 3 + 1], X[i * 3 + 2]]), A = Math.hypot(...cross3(sub3(b, a), sub3(c, a))); if (A > 1e-6) dens.push(uvArea(ids.map(i => [U[i * 2], U[i * 2 + 1]])) / A); }
        }
    }
    if (!uvOf.size) return undefined;
    const limit = new Map<number, number>();
    for (const [m, l] of density) { l.sort((x, y) => x - y); limit.set(m, (l[Math.floor(l.length / 2)] ?? 0) * 4); }
    // the photo at a whole triangle's corners, when that mapping is a plain copy of its shape
    const cornerMap: Array<{ material: number; uv: number[][] } | undefined> = tris.map(f => {
        const A = Math.hypot(...cross3(sub3(f[1], f[0]), sub3(f[2], f[0])));
        if (!(A > 1e-9)) return undefined;
        const at = f.map(p => uvOf.get(wk(p)));
        if (at.some(x => !x)) return undefined;
        for (const mat of at[0]!.keys()) {
            if (!at[1]!.has(mat) || !at[2]!.has(mat)) continue;
            const uv = at.map(x => x!.get(mat)!);
            if (uvArea(uv) / A <= (limit.get(mat) ?? 0) && uvShear(f, uv) <= P.maxShear) return { material: mat, uv };
        }
        return undefined;
    });
    // a facade's material drawn repeating (its photo carried on past its edges), made once per facade material
    const repeating = new Map<number, number>();
    const repeatOf = (mat: number) => {
        let r = repeating.get(mat);
        if (r !== undefined) return r;
        const src = json.materials[mat], tex = json.textures[src.pbrMetallicRoughness.baseColorTexture.index];
        json.samplers ??= [];
        json.samplers.push({ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 });
        json.textures.push({ ...tex, sampler: json.samplers.length - 1 });
        json.materials.push({ ...src, name: `${src.name ?? 'facade'}_continued`, pbrMetallicRoughness: { ...src.pbrMetallicRoughness, baseColorTexture: { ...src.pbrMetallicRoughness.baseColorTexture, index: json.textures.length - 1 } }, doubleSided: true });
        r = json.materials.length - 1;
        repeating.set(mat, r);
        return r;
    };
    // where no photo reached: the nearest rebuilt facade facing the same way, its mapping continued
    const continued = (f: number[][], m: number[], A: number): { material: number; uv: number[][]; continued: true; confidence: number } | undefined => {
        let best: { material: number; uv: number[][]; continued: true; confidence: number } | undefined, bestD = P.continueMaxM;
        for (const wm of walls) {
            if (Math.abs(dot(m, wm.n)) < P.continueFacingMin * A) continue;
            const uv = f.map(p => [dot(wm.U, p) + wm.u0, dot(wm.V, p) + wm.v0]);
            // how far outside the photo, in metres along each axis (uv per metre is the axis's length), and the planes apart
            const du = Math.max(0, -Math.min(...uv.map(x => x[0])), Math.max(...uv.map(x => x[0])) - 1) / (Math.hypot(wm.U[0], wm.U[1], wm.U[2]) || 1);
            const dvv = Math.max(0, -Math.min(...uv.map(x => x[1])), Math.max(...uv.map(x => x[1])) - 1) / (Math.hypot(wm.V[0], wm.V[1], wm.V[2]) || 1);
            const dd = f.map(p => dot(p, wm.n)), off = Math.max(0, wm.dLo - Math.min(...dd), Math.max(...dd) - wm.dHi);
            const d = Math.hypot(du, dvv) + off;
            if (d < bestD) {
                bestD = d;
                // the facade's nearest repeats at its own bay and storey pitch, its confidence falling with the distance
                const base = wm.pu !== undefined && wm.pv !== undefined ? P.confidenceRepeat : P.confidenceNoRepeat;
                best = { material: repeatOf(wm.material), uv: foldIntoRepeats(uv, wm.pu, wm.pv), continued: true, confidence: base * (1 - (1 - P.confidenceFloor) * (d / P.continueMaxM)) };
            }
        }
        return best;
    };
    let maps: Array<{ material: number; uv: number[][]; wall?: boolean; continued?: boolean; confidence?: number } | undefined> = parts.map(({ parent, p: f, w }) => {
        const m = cross3(sub3(f[1], f[0]), sub3(f[2], f[0])), A = Math.hypot(m[0], m[1], m[2]);
        if (!(A > 1e-12)) return undefined;
        // infill on a rebuilt facade: the nearest wall it lies on
        let best: { material: number; uv: number[][]; wall: boolean } | undefined, bestD = Infinity;
        for (const wm of walls) {
            if (Math.abs(dot(m, wm.n)) < P.wallFacingMin * A) continue;
            const d = f.map(p => dot(p, wm.n)), off = Math.max(0, wm.dLo - Math.min(...d), Math.max(...d) - wm.dHi);
            if (off > P.wallBandM || off >= bestD) continue;
            const uv = f.map(p => [dot(wm.U, p) + wm.u0, dot(wm.V, p) + wm.v0]);
            if (uv.some(([u, v]) => u < -P.wallUvMargin || u > 1 + P.wallUvMargin || v < -P.wallUvMargin || v > 1 + P.wallUvMargin)) continue;
            best = { material: wm.material, uv, wall: true }; bestD = off;
        }
        if (best) return best;
        const c = cornerMap[parent];
        return c ? { material: c.material, uv: w.map(b => [0, 1].map(k => b[0] * c.uv[0][k] + b[1] * c.uv[1][k] + b[2] * c.uv[2][k])) } : continued(f, m, A);
    });
    // a triangle all of whose pieces are kept and clay (most are inside the shell) goes back whole
    const kept = new Map<number, { n: number; clay: number }>();
    parts.forEach((q, i) => { const k = kept.get(q.parent) ?? { n: 0, clay: 0 }; k.n++; if (!maps[i]) k.clay++; kept.set(q.parent, k); });
    const whole = (q: Piece) => { const k = kept.get(q.parent)!; return q.of > 1 && k.n === q.of && k.clay === q.of; };
    const merged = new Set<number>();
    const keep = parts.map((q, i) => { if (!whole(q)) return i; if (merged.has(q.parent)) return -1; merged.add(q.parent); return i; }).filter(i => i >= 0);
    parts = keep.map(i => whole(parts[i]) ? { parent: parts[i].parent, p: tris[parts[i].parent], w: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], of: 1 } : parts[i]);
    maps = keep.map(i => maps[i]);
    const groups = new Map<number, number[]>();
    parts.forEach((_, i) => { const mat = maps[i]?.material ?? -1; const l = groups.get(mat); if (l) l.push(i); else groups.set(mat, [i]); });
    const chunks: Uint8Array[] = [g.bin];
    let len = g.bin.length;
    const push = (arr: Float32Array | Uint32Array, target: number) => { const pad = (4 - (len % 4)) % 4; if (pad) { chunks.push(new Uint8Array(pad)); len += pad; } json.bufferViews.push({ buffer: 0, byteOffset: len, byteLength: arr.byteLength, target }); chunks.push(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength)); len += arr.byteLength; return json.bufferViews.length - 1; };
    json.bufferViews ??= []; json.accessors ??= []; json.meshes ??= []; json.nodes ??= []; json.materials ??= [];
    const primitives: any[] = [];
    const routeN = [0, 0, 0, 0], confSum = [0, 0, 0, 0];
    for (const [mat, list] of groups) {
        const Pp = new Float32Array(list.length * 9), N = new Float32Array(list.length * 9), UV = new Float32Array(list.length * 6);
        // each piece's route (its code in ROUTES) and confidence, on every vertex
        const RT = new Float32Array(list.length * 3), CF = new Float32Array(list.length * 3);
        list.forEach((ti, i) => {
            const f = parts[ti].p, n = cross3(sub3(f[1], f[0]), sub3(f[2], f[0])), nl = Math.hypot(n[0], n[1], n[2]) || 1, mp = maps[ti];
            const route = !mp ? 0 : mp.wall ? 1 : mp.continued ? 3 : 2, conf = !mp ? 0 : mp.wall ? P.confidenceWall : mp.continued ? mp.confidence ?? P.confidenceNoRepeat : P.confidenceCorner;
            routeN[route]++; confSum[route] += conf;
            for (let k = 0; k < 3; k++) {
                Pp.set(f[k], i * 9 + k * 3); N.set([n[0] / nl, n[1] / nl, n[2] / nl], i * 9 + k * 3);
                if (mp) UV.set(mp.uv[k], i * 6 + k * 2);
                RT[i * 3 + k] = route; CF[i * 3 + k] = conf;
            }
        });
        const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        for (let v = 0; v < Pp.length; v += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], Pp[v + k]); max[k] = Math.max(max[k], Pp[v + k]); }
        json.accessors.push({ bufferView: push(Pp, 34962), componentType: 5126, count: Pp.length / 3, type: 'VEC3', min, max });
        const attributes: Record<string, number> = { POSITION: json.accessors.length - 1 };
        json.accessors.push({ bufferView: push(N, 34962), componentType: 5126, count: N.length / 3, type: 'VEC3' }); attributes.NORMAL = json.accessors.length - 1;
        json.accessors.push({ bufferView: push(RT, 34962), componentType: 5126, count: RT.length, type: 'SCALAR' }); attributes._PROVENANCE = json.accessors.length - 1;
        json.accessors.push({ bufferView: push(CF, 34962), componentType: 5126, count: CF.length, type: 'SCALAR' }); attributes._CONFIDENCE = json.accessors.length - 1;
        let material = mat;
        if (mat >= 0) { json.accessors.push({ bufferView: push(UV, 34962), componentType: 5126, count: UV.length / 2, type: 'VEC2' }); attributes.TEXCOORD_0 = json.accessors.length - 1; }
        else { json.materials.push({ name, pbrMetallicRoughness: { baseColorFactor: [0.55, 0.53, 0.5, 1], metallicFactor: 0, roughnessFactor: 0.9 }, doubleSided: true }); material = json.materials.length - 1; }
        const idx = Uint32Array.from({ length: list.length * 3 }, (_, i) => i);
        json.accessors.push({ bufferView: push(idx, 34963), componentType: 5125, count: idx.length, type: 'SCALAR' });
        primitives.push({ attributes, indices: json.accessors.length - 1, material, mode: 4 });
    }
    const onWall = maps.filter(x => x?.wall).length, carried = maps.filter(x => x?.continued).length, textured = maps.filter(x => x && !x.wall && !x.continued).length;
    json.meshes.push({ name, primitives });
    json.nodes.push({ name, mesh: json.meshes.length - 1, extras: { sbSeal: { version: LATTICE_STITCH_VERSION, provenance: { label: 'generated', method: `${method}; ${onWall} of ${parts.length} pieces lie on a rebuilt facade and take its straightened photo there (its repeats where the photo did not reach), ${textured} the photo at their triangle's corners, ${carried} where no photo reached continue the nearest rebuilt facade facing the same way, no further than ${P.continueMaxM} m (its own repeat cell at its bay and storey pitch, read from its fitted windows; the photo folded whole where it has none), the rest clay` }, wallInfill: onWall, cornerTextured: textured, continued: carried, clay: parts.length - onWall - textured - carried, routes: ROUTES.map((label, code) => ({ code, label, pieces: routeN[code], meanConfidence: routeN[code] ? Math.round((confSum[code] / routeN[code]) * 100) / 100 : 0 })), attributes: { _PROVENANCE: "each piece's route code (routes), on its vertices", _CONFIDENCE: "each piece's confidence 0..1, on its vertices" } } } });
    json.scenes?.[json.scene ?? 0]?.nodes?.push(json.nodes.length - 1);
    const pad = (4 - (len % 4)) % 4;
    if (pad) { chunks.push(new Uint8Array(pad)); len += pad; }
    const bin = new Uint8Array(len);
    let o = 0;
    for (const c of chunks) { bin.set(c, o); o += c.length; }
    json.buffers = [{ ...(json.buffers?.[0] ?? {}), byteLength: len }];
    return assembleGlb(json, bin);
}

/** Appends triangles (vertex positions) as one node labelled generated (clay in the twin: no photo). */
function appendTriangles(bytes: Uint8Array, tris: number[][][], name: string, method: string, textured: boolean, pieces?: Piece[]): Buffer {
    if (textured) { const t = appendTexturedTriangles(bytes, tris, name, method, pieces); if (t) return t; }
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

export interface StitchReport { segments: number; stitched: number; stripTriangles: number; cornersZipped: number; why: Record<string, number>; /** Outline edges joined to nothing (no strip, no corner zip): the cells beside them are left as scan (facade-lattice.ts). */ unjoined: number }

/** The native stitch's parameters (scratchbox_lattice_stitch.hpp Params). */
export function stitchParamVector(P: LatticeStitchParams): number[] {
    return [P.weldM, P.onLineM, P.cornerGapM, P.depthBandM];
}

const STITCH_METHOD = 'the rebuilt walls stitched to the scan cut to them (a strip along each edge of a rebuilt outline, in its vertical plane) and to each other at the building\'s corners';

/** The rebuilt walls' outlines stitched to the scan's cut, segment by segment, in each segment's vertical plane. */
export function stitchLattice(clay: Uint8Array, others: Uint8Array[], facades: Facade[], P: LatticeStitchParams = LATTICE_STITCH_PARAMS, opts: { /** The native stitch's threads (every core when none). */ threads?: number } = {}): { clay: Buffer; others: Buffer[]; report: StitchReport; /** The rebuilt cells with an outline edge joined to nothing, per facade id: [a, b]. */ unjoinedCells: Map<number, Array<[number, number]>> } {
    if (kNative('stitch')) {
        // natively: the same strips and zips, the same report; appended here
        const g = parseGlbBytes(clay);
        const wallMesh = new Map<number, number>();
        for (const n of g.json.nodes ?? []) if (n.mesh !== undefined && n.extras?.sbFacadeLattice) wallMesh.set(n.mesh, n.extras.sbFacadeLattice.facadeId);
        const prims: NativeFillPrim[] = [];
        (g.json.meshes ?? []).forEach((m: any, mi: number) => {
            for (const p of m.primitives ?? []) {
                if ((p.mode ?? 4) !== 4 || p.attributes?.POSITION === undefined) continue;
                prims.push({ wall: wallMesh.get(mi) ?? -1, X: readAccessor(g, p.attributes.POSITION).data, ...(p.indices !== undefined ? { I: readAccessor(g, p.indices).data } : {}) });
            }
        });
        const r = runNativeStitch(stitchParamVector(P), facades.map(({ f, r: x }) => ({ facadeId: f.facadeId, centroid: f.centroid, normal: f.normal, axisS: f.axisS, axisT: f.axisT, s: x.s, t: x.t, built: x.built, depth: x.depth.flat() })), prims, opts.threads ?? nativePolishThreads());
        return { clay: appendTriangles(clay, r.out, 'LatticeStitch', STITCH_METHOD, false), others: others.map(o => appendTriangles(o, r.out, 'LatticeStitch', STITCH_METHOD, true)), report: r.report, unjoinedCells: r.unjoinedCells };
    }
    const w = welded(clay, P);
    const open = openEdges(w.tris, undefined, true);
    const openVerts = new Set(open.flat());
    const report: StitchReport = { segments: 0, stitched: 0, stripTriangles: 0, cornersZipped: 0, why: {}, unjoined: 0 };
    // every segment that found no strip, with its wall edge (when found) and its cell, checked again after the corner zip
    const failed: Array<{ facadeId: number; cell: [number, number]; edge?: [number, number] }> = [];
    let at: { facadeId: number; cell: [number, number] } = { facadeId: -1, cell: [0, 0] };
    let atEdge: [number, number] | undefined;
    const miss = (k: string) => { report.why[k] = (report.why[k] ?? 0) + 1; failed.push({ ...at, ...(atEdge ? { edge: atEdge } : {}) }); };
    const out: number[][][] = [];
    // open scan vertices per facade frame, for the lookup along each outline segment
    for (const { f, r } of facades) {
        const ns = r.s.length - 1, nt = r.t.length - 1;
        const world = (sv: number, tv: number, d: number) => [0, 1, 2].map(k => f.centroid[k] + sv * f.axisS[k] + tv * f.axisT[k] + d * f.normal[k]);
        const local = [...openVerts].map(v => { const m = [w.pos[v][0] - f.centroid[0], w.pos[v][1] - f.centroid[1], w.pos[v][2] - f.centroid[2]]; return { v, s: dot(m, f.axisS), t: dot(m, f.axisT), d: dot(m, f.normal) }; }).filter(x => Math.abs(x.d) <= P.depthBandM + 0.01 && x.s >= r.s[0] - 0.01 && x.s <= r.s[ns] + 0.01 && x.t >= r.t[0] - 0.01 && x.t <= r.t[nt] + 0.01);
        const segment = (s0: number, t0: number, s1: number, t1: number, d: number) => {
            report.segments++;
            const A = w.idOf(Float32Array.from(world(s0, t0, d))), B = w.idOf(Float32Array.from(world(s1, t1, d)));
            atEdge = A !== undefined && B !== undefined ? [A, B] : undefined;
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
            at = { facadeId: f.facadeId, cell: [a, b] };
            if (a === 0 || !r.built[b * ns + a - 1]) segment(r.s[a], r.t[b], r.s[a], r.t[b + 1], d);
            if (a === ns - 1 || !r.built[b * ns + a + 1]) segment(r.s[a + 1], r.t[b], r.s[a + 1], r.t[b + 1], d);
            if (b === 0 || !r.built[(b - 1) * ns + a]) segment(r.s[a], r.t[b], r.s[a + 1], r.t[b], d);
            if (b === nt - 1 || !r.built[(b + 1) * ns + a]) segment(r.s[a], r.t[b + 1], r.s[a + 1], r.t[b + 1], d);
        }
    }
    // walls meeting at a building corner: the open edges of each facade's outline that found no scan (their vertices are that
    // wall's only), walked into chains, zipped by height to another facade's chain running beside them within cornerGapM
    const usedEdge = new Set<number>();
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
    // a failed segment is joined after all when the corner zip (or another strip) used its wall edge; the rest are holes
    const joined = new Set<number>();
    for (const t of out) { const ids = t.map(p => w.idOf(Float32Array.from(p))); for (let k = 0; k < 3; k++) if (ids[k] !== undefined && ids[(k + 1) % 3] !== undefined) joined.add(ekey(ids[k]!, ids[(k + 1) % 3]!)); }
    const unjoinedCells = new Map<number, Array<[number, number]>>();
    for (const x of failed) {
        if (x.edge && (joined.has(ekey(x.edge[0], x.edge[1])) || !openVerts.has(x.edge[0]))) continue;
        report.unjoined++;
        const l = unjoinedCells.get(x.facadeId) ?? unjoinedCells.set(x.facadeId, []).get(x.facadeId)!;
        if (!l.some(c => c[0] === x.cell[0] && c[1] === x.cell[1])) l.push(x.cell);
    }
    return { clay: appendTriangles(clay, out, 'LatticeStitch', STITCH_METHOD, false), others: others.map(o => appendTriangles(o, out, 'LatticeStitch', STITCH_METHOD, true)), report, unjoinedCells };
}

/** openBefore / openAfter: edges of an odd number of triangles (open); nonManifoldAfter: closed edges of four or more. */
export interface FillReport { openBefore: number; kinds: Record<string, number>; loops: number; split: number; filled: number; clipped3d: number; skippedWallOnly: number; /** Loops left open because no ear stayed inside the building. */ rejectedTriangles: number; unclosedLoops: number; /** Loops left open because their rim strays off its plane (rimPlanarM) around a cap over offRimCapM2: count and cap area (m²). */ refusedCaps: number; refusedCapM2: number; /** Fill dropped because it lay on a surface the scan already has (m²). */ droppedDoubledM2: number; /** Fill dropped because a rebuilt wall stands in for it (coveredByWallM; m²). */ droppedCoveredM2: number; /** Caps turned to face out of the building (capRayM). */ turnedCaps: number; /** Fill lying wholly over a surface already there (within skinM): kept in the clay, left out of the textured twin (m²). */ skinHiddenM2: number; openPathEdges: number; openAfter: number; nonManifoldAfter: number; addedAreaM2: number }

const SEAL_METHOD = 'the shell closed: every open loop left (the scan\'s own holes, corners, the base, which caps the bottom) triangulated in its best-fitting plane';

/** The fill's GLBs: the clay with every fill triangle, the textured twins with the pieces not lying over a surface already there. */
function sealed(clay: Uint8Array, others: Uint8Array[], out: number[][][], pieces: Piece[], report: FillReport): { clay: Buffer; others: Buffer[]; report: FillReport } {
    return { clay: appendTriangles(clay, out, 'Seal', SEAL_METHOD, false), others: others.map(o => appendTriangles(o, out, 'Seal', `${SEAL_METHOD}; fill lying over a surface already there (${report.skinHiddenM2} m²) left out of the textured twin`, true, pieces)), report };
}

/** LATTICE_STITCH_PARAMS' fill fields in the order of scratchbox_open_loop_fill.hpp's Params. */
export function fillParamVector(P: LatticeStitchParams): number[] {
    return [P.weldM, P.splitPerimeterM, P.splitRatio, P.doubledM, P.coveredByWallM, P.coveredByWallCellM, P.envelopeCellM, P.envelopeMarginM, P.skinM, P.skinShare, P.rimPlanarM, P.offRimCapM2, P.capRayM, P.capRayStartM, P.capRaySamples, P.pieceM];
}

/**
 * The fill's geometry natively (scratchbox_open_loop_fill.hpp through remesh-polish-native.ts, a pool of `threads`): the
 * clay's triangle primitives handed over as welded() reads them, the fill's triangles, pieces and report handed back, the
 * GLBs written here as the TypeScript fill writes them.
 */
function fillOpenLoopsNative(clay: Uint8Array, others: Uint8Array[], opts: { footprint?: Vec2[][]; threads?: number }, P: LatticeStitchParams): { clay: Buffer; others: Buffer[]; report: FillReport } {
    const g = parseGlbBytes(clay);
    const wallMesh = new Map<number, number>();
    for (const n of g.json.nodes ?? []) if (n.mesh !== undefined && n.extras?.sbFacadeLattice) wallMesh.set(n.mesh, n.extras.sbFacadeLattice.facadeId);
    const prims: NativeFillPrim[] = [];
    (g.json.meshes ?? []).forEach((m: any, mi: number) => {
        for (const p of m.primitives ?? []) {
            if ((p.mode ?? 4) !== 4 || p.attributes?.POSITION === undefined) continue;
            prims.push({ wall: wallMesh.get(mi) ?? -1, X: readAccessor(g, p.attributes.POSITION).data, ...(p.indices !== undefined ? { I: readAccessor(g, p.indices).data } : {}) });
        }
    });
    const r = runNativeFill(fillParamVector(P), opts.footprint ?? [], prims, opts.threads ?? nativePolishThreads());
    return sealed(clay, others, r.out, r.pieces, r.report as unknown as FillReport);
}

/**
 * The open loops left closed (the scan's holes, corners, the base: the bottom capped), counted again after. Natively on a
 * pool of `threads` (every core when none is given) unless SCRATCHBOX_K_NATIVE leaves `infill` out; the binary must be built first
 * (remesh-polish-native.ts ensureRemeshPolishBinary).
 */
export function fillOpenLoops(clay: Uint8Array, others: Uint8Array[], opts: { /** The structure's footprint (plan loops [x, z]): a fill past it pokes out of the building. */ footprint?: Vec2[][]; /** The native fill's threads: a chunked district's share of the cores. */ threads?: number } = {}, P: LatticeStitchParams = LATTICE_STITCH_PARAMS): { clay: Buffer; others: Buffer[]; report: FillReport } {
    if (kNative('infill')) return fillOpenLoopsNative(clay, others, opts, P);
    const w = welded(clay, P);
    if (w.pos.length >= EDGE_BASE) throw new Error(`the infill keys edges by vertex ids under ${EDGE_BASE}; this mesh has ${w.pos.length} vertices`);
    const owner = new Map<number, number>();
    const open = openEdges(w.tris, owner);
    const wallFacade = new Map<number, number>();
    w.tris.forEach((f, i) => { if (w.wall[i] >= 0) for (const v of f) wallFacade.set(v, w.wall[i]); });
    const scanVert = new Set<number>();
    w.tris.forEach((f, i) => { if (w.wall[i] < 0) for (const v of f) scanVert.add(v); });
    // loops: trails over the open edges, split where a walk comes back to a vertex, turning to the nearest edge at a junction
    const adj = new Map<number, number[]>();
    for (const [a, b] of open) { (adj.get(a) ?? adj.set(a, []).get(a)!).push(b); (adj.get(b) ?? adj.set(b, []).get(b)!).push(a); }
    const used = new Set<number>(), loops: number[][] = [];
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
    const report: FillReport = { openBefore: open.length, kinds, loops: loops.length, split: 0, filled: 0, clipped3d: 0, skippedWallOnly: 0, rejectedTriangles: 0, unclosedLoops: 0, refusedCaps: 0, refusedCapM2: 0, droppedDoubledM2: 0, droppedCoveredM2: 0, turnedCaps: 0, skinHiddenM2: 0, openPathEdges, openAfter: 0, nonManifoldAfter: 0, addedAreaM2: 0 };
    const out: number[][][] = [], addedFaces: number[][] = [];
    // the building's envelope before the fill: its top-down height map (the highest surface per cell) and its footprint;
    // a fill triangle above the one or outside the other (past envelopeMarginM) would poke out of the building
    const cell = P.envelopeCellM, top = new Map<number | string, number>();
    const ck = (x: number, z: number) => cellKey(Math.floor(x / cell), Math.floor(z / cell), 0);
    const raise = (x: number, y: number, z: number) => { const k = ck(x, z), o = top.get(k); if (o === undefined || y > o) top.set(k, y); };
    for (const f of w.tris) {
        const [a, b, c] = f.map(v => w.pos[v]);
        const steps = Math.min(30, Math.max(1, Math.ceil(Math.max(Math.hypot(b[0] - a[0], b[2] - a[2]), Math.hypot(c[0] - a[0], c[2] - a[2])) / cell)));
        for (let p = 0; p <= steps; p++) for (let q = 0; p + q <= steps; q++) { const u = p / steps, v = q / steps; raise(a[0] + (b[0] - a[0]) * u + (c[0] - a[0]) * v, a[1] + (b[1] - a[1]) * u + (c[1] - a[1]) * v, a[2] + (b[2] - a[2]) * u + (c[2] - a[2]) * v); }
    }
    const topNear = (x: number, z: number) => { let m = -Infinity; const cx = Math.floor(x / cell), cz = Math.floor(z / cell); for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) { const y = top.get(cellKey(cx + dx, cz + dz, 0)); if (y !== undefined && y > m) m = y; } return m; };
    // past the footprint is measured from the triangle's own corners: a hole among scan pieces already standing past it may
    // close at their distance, never further out
    const past = (p: ArrayLike<number>) => (opts.footprint?.length ? Math.max(0, outsideFootprint(p[0], p[2], opts.footprint)) : 0);
    const outsidePt = (p: ArrayLike<number>, allowed = 0) => !(p[1] <= topNear(p[0], p[2]) + P.envelopeMarginM) || past(p) > allowed + P.envelopeMarginM;
    const inside = (t: number[]) => {
        const [a, b, c] = t.map(v => w.pos[v]);
        const allowed = Math.max(past(a), past(b), past(c));
        const mid = (p: number[], q: number[]) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2];
        return ![[(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3], mid(a, b), mid(b, c), mid(c, a)].some(p => outsidePt(p, allowed));
    };
    // each fill triangle remembers the cap (loop) it belongs to, so the cap can be turned to face out of the building
    const capOf: number[] = [];
    let capNo = -1;
    const emit = (t: number[]) => { addedFaces.push(t); out.push(t.map(v => w.pos[v])); capOf.push(capNo); };
    const dist = (a: number, b: number) => Math.sqrt(d2(a, b));
    const queue = [...loops];
    while (queue.length) {
        const l = queue.pop()!;
        capNo++;
        // a loop of one rebuilt wall's vertices only is either a hole the wall surrounds (filled) or the wall's own outer
        // outline (filling it would double the wall): seen in the loop's plane, the wall lies outside a hole and inside an outline
        const facadesOf = new Set(l.map(v => wallFacade.get(v) ?? -1));
        const wallOnly = !l.some(v => scanVert.has(v)) && facadesOf.size === 1 && !facadesOf.has(-1);
        // a large loop is split where it comes closest to itself (two points near in space, far apart along it): a loop
        // wrapping a tier corner or a roof edge becomes flatter pieces, the chord shared by both (so it stays closed)
        const cum = [0];
        for (let i = 0; i < l.length; i++) cum.push(cum[i] + dist(l[i], l[(i + 1) % l.length]));
        const perim = cum[l.length];
        if (perim > P.splitPerimeterM && l.length >= 6) {
            const stepI = Math.max(1, Math.ceil(l.length / 1500));
            let bi = -1, bj = -1, br = Infinity;
            for (let i = 0; i < l.length; i += stepI) for (let j = i + 2; j < l.length; j += stepI) {
                const along = Math.min(cum[j] - cum[i], perim - (cum[j] - cum[i]));
                if (along < 3 * perim / l.length || (i === 0 && j === l.length - 1)) continue;
                const r = dist(l[i], l[j]) / along;
                if (r < br) { br = r; bi = i; bj = j; }
            }
            if (bi >= 0 && br < P.splitRatio) {
                const m = w.pos[l[bi]].map((x, k) => (x + w.pos[l[bj]][k]) / 2);
                if (!outsidePt(m, Math.max(past(w.pos[l[bi]]), past(w.pos[l[bj]])))) { queue.push(l.slice(bi, bj + 1), [...l.slice(bj), ...l.slice(0, bi + 1)]); report.split++; continue; }
            }
        }
        const n = [0, 0, 0];
        for (let i = 0; i < l.length; i++) { const a = w.pos[l[i]], b = w.pos[l[(i + 1) % l.length]]; n[0] += (a[1] - b[1]) * (a[2] + b[2]); n[1] += (a[2] - b[2]) * (a[0] + b[0]); n[2] += (a[0] - b[0]) * (a[1] + b[1]); }
        const nl = Math.hypot(n[0], n[1], n[2]);
        // closed where it is safe: a loop whose rim strays off its own plane by more than rimPlanarM around more than
        // offRimCapM2 is no hole in one surface (a recess spanned, a corner wrapped, a torn seam): a cap there would be a
        // large surface nothing measured, so the loop is left open and counted
        if (nl > 1e-12) {
            const N = n.map(x => x / nl), c = [0, 1, 2].map(k => l.reduce((s, v) => s + w.pos[v][k], 0) / l.length);
            const off = Math.max(...l.map(v => Math.abs(dot(sub3(w.pos[v], c), N))));
            if (off > P.rimPlanarM && nl / 2 > P.offRimCapM2) { report.refusedCaps++; report.refusedCapM2 += nl / 2; continue; }
        }
        let tri: number[][] | undefined;
        if (nl > 1e-12) {
            const N = n.map(x => x / nl), ref = Math.abs(N[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
            const U0 = [ref[1] * N[2] - ref[2] * N[1], ref[2] * N[0] - ref[0] * N[2], ref[0] * N[1] - ref[1] * N[0]], ul = Math.hypot(U0[0], U0[1], U0[2]);
            const U = U0.map(x => x / ul), V = [N[1] * U[2] - N[2] * U[1], N[2] * U[0] - N[0] * U[2], N[0] * U[1] - N[1] * U[0]];
            const xy = (p: ArrayLike<number>) => new Vector2(dot(p, U), dot(p, V));
            if (wallOnly) {
                // the wall beside the loop: a triangle owning one of its edges (a split loop's chord has none)
                const ownerIdx = l.map((v, i) => owner.get(ekey(v, l[(i + 1) % l.length]))).find(x => x !== undefined);
                if (ownerIdx === undefined) { report.skippedWallOnly++; continue; }
                const t = w.tris[ownerIdx], c = [0, 1, 2].map(k => (w.pos[t[0]][k] + w.pos[t[1]][k] + w.pos[t[2]][k]) / 3);
                const poly = l.map(v => xy(w.pos[v])), q = xy(c);
                let within = false;
                for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a.y > q.y) !== (b.y > q.y) && q.x < ((b.x - a.x) * (q.y - a.y)) / (b.y - a.y) + a.x) within = !within; }
                if (within) { report.skippedWallOnly++; continue; }
            }
            tri = triangulate(l, [], v => xy(w.pos[v]));
        } else if (wallOnly) { report.skippedWallOnly++; continue; }
        // flat: kept only when no triangle pokes out of the building
        if (tri && tri.every(inside)) { report.filled++; for (const t of tri) emit(t); continue; }
        // not flat, or poking out: closed in 3D by cutting off, again and again, the ear with the shortest closing edge among
        // those inside the building (greedy Liepa); when no ear is inside, the rest stays open and is counted
        const ring = [...l];
        let closed = true;
        while (ring.length >= 3) {
            let bi = -1, bd = Infinity;
            for (let k = 0; k < ring.length; k++) {
                const t = [ring[(k - 1 + ring.length) % ring.length], ring[k], ring[(k + 1) % ring.length]];
                const d = d2(t[0], t[2]);
                if (d < bd && inside(t)) { bd = d; bi = k; }
            }
            if (bi < 0) { closed = false; report.rejectedTriangles++; break; }
            emit([ring[(bi - 1 + ring.length) % ring.length], ring[bi], ring[(bi + 1) % ring.length]]);
            if (ring.length === 3) { ring.length = 0; break; }
            ring.splice(bi, 1);
        }
        if (closed) report.clipped3d++; else report.unclosedLoops++;
    }
    // each cap faced out of the building, as the orient step judges the scan: a ray from it, the way it faces, that meets the
    // building's own surface means it faces in, and the cap is turned (its triangles reversed). The cap's neighbours are no
    // guide: before the orient step many of them face in themselves
    const meets = rayIndex(w.pos, w.tris);
    const caps = new Map<number, number[]>();
    capOf.forEach((k, i) => (caps.get(k) ?? caps.set(k, []).get(k)!).push(i));
    for (const list of caps.values()) {
        const area = (i: number) => { const [a, b, c] = out[i]; return Math.hypot(...cross3(sub3(b, a), sub3(c, a))); };
        const samples = [...list].sort((x, y) => area(y) - area(x)).slice(0, P.capRaySamples).filter(i => area(i) > 1e-9);
        let inward = 0;
        for (const i of samples) {
            const [a, b, c] = out[i], n = cross3(sub3(b, a), sub3(c, a)), nl = Math.hypot(n[0], n[1], n[2]), d = n.map(x => x / nl);
            const o = [0, 1, 2].map(k => (a[k] + b[k] + c[k]) / 3 + d[k] * P.capRayStartM);
            if (meets(o, d, P.capRayM)) inward++;
        }
        if (2 * inward <= samples.length) continue;
        for (const i of list) { const t = addedFaces[i]; addedFaces[i] = [t[0], t[2], t[1]]; out[i] = addedFaces[i].map(v => w.pos[v]); }
        report.turnedCaps++;
    }
    // a fill triangle lying on a surface already there (an odd count where the scan is doubled, not a hole) is dropped:
    // it would be a second, photo-less skin over the real one
    // every probe below lies on a fill triangle: the grids hold only the cells under them
    const onSurface = surfaceProbe(w.pos, w.tris, P.doubledM, 1, out);
    const onWall = surfaceProbe(w.pos, w.tris.filter((_, i) => w.wall[i] >= 0), P.coveredByWallM, P.coveredByWallCellM, out);
    let kept = 0;
    for (let i = 0; i < out.length; i++) {
        const [a, b, c] = out[i];
        const at = (p: number[], q: number[], l: number) => [p[0] + (q[0] - p[0]) * l, p[1] + (q[1] - p[1]) * l, p[2] + (q[2] - p[2]) * l];
        const n = cross3(sub3(b, a), sub3(c, a));
        // every edge must lie on the surface too, or dropping the triangle would open it
        const probes = [[(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3], ...[[a, b], [b, c], [c, a]].flatMap(([p, q]) => [0, 0.25, 0.5, 0.75].map(l => at(p, q, l)))];
        // on a separate layer only: fill folded back over the scan triangle beside its hole lies on that triangle, and the hole is real
        if (probes.every(q => onSurface(q, n, addedFaces[i]))) { report.droppedDoubledM2 += Math.hypot(n[0], n[1], n[2]) / 2; continue; }
        if (probes.every(q => onWall(q, n))) { report.droppedCoveredM2 += Math.hypot(n[0], n[1], n[2]) / 2; continue; }
        out[kept] = out[i]; addedFaces[kept] = addedFaces[i]; kept++;
    }
    out.length = kept; addedFaces.length = kept;
    report.droppedDoubledM2 = Math.round(report.droppedDoubledM2);
    report.droppedCoveredM2 = Math.round(report.droppedCoveredM2);
    report.refusedCapM2 = Math.round(report.refusedCapM2);
    // the textured twin judges the fill in pieces of at most pieceM: a piece lying over a surface already there (most of it
    // within skinM, its own neighbours included) closes no visible hole and is left out (it would show over the photo); the
    // clay keeps every triangle whole, so the shell stays closed
    const overSurface = surfaceProbe(w.pos, w.tris, P.skinM, 1, out);
    const pieces: Piece[] = [];
    out.forEach((t, parent) => {
        const [a, b, c] = t, n = cross3(sub3(b, a), sub3(c, a));
        const div = Math.max(1, Math.ceil(Math.max(dist3(a, b), dist3(b, c), dist3(c, a)) / P.pieceM));
        const bary = (i: number, j: number) => [i / div, j / div, (div - i - j) / div];
        const point = (q: number[]) => [0, 1, 2].map(k => a[k] * q[0] + b[k] * q[1] + c[k] * q[2]);
        for (let i = 0; i < div; i++) for (let j = 0; i + j < div; j++) {
            const sub = [[bary(i, j), bary(i + 1, j), bary(i, j + 1)]];
            if (i + j + 1 < div) sub.push([bary(i + 1, j), bary(i + 1, j + 1), bary(i, j + 1)]);
            for (const wq of sub) {
                const p = wq.map(point);
                // the centroid and a barycentric grid over the piece (its corners left out)
                const probes: number[][] = [];
                for (let x = 0; x <= 4; x++) for (let y = 0; x + y <= 4; y++) if (Math.max(x, y, 4 - x - y) < 4) probes.push([0, 1, 2].map(k => (p[0][k] * x + p[1][k] * y + p[2][k] * (4 - x - y)) / 4));
                probes.push([0, 1, 2].map(k => (p[0][k] + p[1][k] + p[2][k]) / 3));
                const area = Math.hypot(...cross3(sub3(p[1], p[0]), sub3(p[2], p[0]))) / 2;
                if (probes.filter(q => overSurface(q, n)).length >= P.skinShare * probes.length) report.skinHiddenM2 += area;
                else pieces.push({ parent, p, w: wq, of: div * div });
            }
        }
    });
    report.skinHiddenM2 = Math.round(report.skinHiddenM2);
    const counts = new Map<number, number>();
    for (const f of [...w.tris, ...addedFaces]) for (let k = 0; k < 3; k++) { const e = ekey(f[k], f[(k + 1) % 3]); counts.set(e, (counts.get(e) ?? 0) + 1); }
    for (const c of counts.values()) { if (c % 2 === 1) report.openAfter++; else if (c > 2) report.nonManifoldAfter++; }
    for (const t of out) { const a = t[0], b = t[1], c = t[2]; const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2]; report.addedAreaM2 += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx); }
    report.addedAreaM2 = Math.round(report.addedAreaM2);
    return sealed(clay, others, out, pieces, report);
}
