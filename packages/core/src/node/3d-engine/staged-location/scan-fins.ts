/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Fins: the scan's thin pieces left standing off a rebuilt facade (user ask, 2026-10-30: plates sticking out of a wall, a
 * crumpled flap across a notch, the photo smeared over them). The remesh cleanup takes loose scraps and one-vertex spikes,
 * and a scan triangle goes under the lattice only where a rebuilt facade covers it from the front, so a strip of the scan
 * joined to the wall and standing edge-on to it stays to the end.
 *
 * After the lattice, per rebuilt facade plane (facades.json), the scan triangles in front of it within its extent that
 * stand edge-on to it (their normal mostly along the plane) and lie on no fitted plane of their own are joined by shared
 * edges into pieces. A piece is a fin when it stands off the plane by little (FIN_PARAMS.maxStandoffM: a real return wall
 * of a setback or a notch spans its whole depth) and is small; it is removed, the rebuilt facade behind it standing in.
 * The removal is reported piece by piece (where, how far out, its area): what it took was measured scan, and it is gone.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseGlbBytes, readAccessor, type ParsedGlb } from './glb-bytes';
import { applyRemeshEdits, REMESH_CLEANUP_PARAMS, type RemeshEdits } from './remesh-cleanup';

export const SCAN_FINS_VERSION = 'scan-fins/1';

export const FIN_PARAMS = {
    /** A triangle stands edge-on to a plane when its normal's component along the plane's is under this. */
    edgeOnCos: 0.5,
    /** It is in front of the plane by at least this (closer is the wall itself) and at most searchM, metres. */
    minStandoffM: 0.04, searchM: 3,
    /** A triangle within this of a fitted plane it is parallel to lies on that plane: a wall, not a fin. */
    onPlaneM: 0.15, onPlaneCos: 0.85,
    /** A fin stands off its wall by at most this, metres, and covers at most maxAreaM2. */
    maxStandoffM: 1.2, maxAreaM2: 25,
    /** The plane's extent is grown by this, metres, so a fin at a facade's edge is still in front of it. */
    edgeMarginM: 0.3
} as const;

interface Plane { facadeId: number; c: number[]; n: number[]; s: number[]; t: number[]; sMin: number; sMax: number; tMin: number; tMax: number }

export interface FinPiece { facadeId: number; triangles: number; areaM2: number; maxStandoffM: number; centre: [number, number, number]; /** 1 - |area-weighted mean normal|: 0 for a flat piece, toward 1 for a twisted one. */ twist: number; /** Area-weighted mean of each triangle's longest edge over its height to that edge (1.15 equilateral; a sliver is long and thin). */ skinny: number }
export interface ScanFinsReport { version: string; candidates: number; pieces: number; removed: FinPiece[]; removedAreaM2: number; kept: { pieces: number; why: string } }

const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** The scan's triangles (every mesh but the lattice's), welded by position, with each triangle's key for the edits. */
function scanMesh(glb: ParsedGlb, q: number): { P: number[]; T: number[]; keys: string[] } {
    const lattice = new Set<number>((glb.json.nodes ?? []).filter((n: any) => n.extras?.sbFacadeLattice && n.mesh !== undefined).map((n: any) => n.mesh));
    const at = new Map<string, number>(), P: number[] = [], T: number[] = [], keys: string[] = [];
    (glb.json.meshes ?? []).forEach((m: any, mi: number) => {
        if (lattice.has(mi)) return;
        for (const p of m.primitives ?? []) {
            if ((p.mode ?? 4) !== 4 || p.attributes?.POSITION === undefined) continue;
            const X = readAccessor(glb, p.attributes.POSITION).data, n = X.length / 3, local = new Int32Array(n);
            for (let v = 0; v < n; v++) {
                const k = `${Math.round(X[v * 3] / q)},${Math.round(X[v * 3 + 1] / q)},${Math.round(X[v * 3 + 2] / q)}`;
                let w = at.get(k);
                if (w === undefined) { w = P.length / 3; at.set(k, w); P.push(X[v * 3], X[v * 3 + 1], X[v * 3 + 2]); keys.push(k); }
                local[v] = w;
            }
            const I = p.indices !== undefined ? readAccessor(glb, p.indices).data : Float64Array.from({ length: n }, (_, i) => i);
            for (let t = 0; t + 2 < I.length; t += 3) { const a = local[I[t]], b = local[I[t + 1]], c = local[I[t + 2]]; if (a !== b && b !== c && a !== c) T.push(a, b, c); }
        }
    });
    return { P, T, keys };
}

/** The fins of a polished model, given the rebuilt facades' planes (facades.json frames of the facades the lattice drew). */
export function findFins(glb: ParsedGlb, planes: Plane[], R = FIN_PARAMS, q = REMESH_CLEANUP_PARAMS.weldM): { report: ScanFinsReport; edits: RemeshEdits } {
    const { P, T, keys } = scanMesh(glb, q);
    const F = T.length / 3, owner = new Int32Array(F).fill(-1), standoff = new Float64Array(F), area = new Float64Array(F), fn = new Float64Array(F * 3);
    for (let f = 0; f < F; f++) {
        const a = T[f * 3] * 3, b = T[f * 3 + 1] * 3, c = T[f * 3 + 2] * 3;
        const u = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], v = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
        const nx = u[1] * v[2] - u[2] * v[1], ny = u[2] * v[0] - u[0] * v[2], nz = u[0] * v[1] - u[1] * v[0], l = Math.hypot(nx, ny, nz);
        area[f] = l / 2;
        if (!(l > 0)) continue;
        const n = [nx / l, ny / l, nz / l]; fn[f * 3] = n[0]; fn[f * 3 + 1] = n[1]; fn[f * 3 + 2] = n[2];
        const m = [(P[a] + P[b] + P[c]) / 3, (P[a + 1] + P[b + 1] + P[c + 1]) / 3, (P[a + 2] + P[b + 2] + P[c + 2]) / 3];
        let best = -1, bestD = Infinity, onPlane = false;
        for (let k = 0; k < planes.length; k++) {
            const pl = planes[k], r = [m[0] - pl.c[0], m[1] - pl.c[1], m[2] - pl.c[2]], d = dot(r, pl.n), cosN = Math.abs(dot(n, pl.n));
            const s = dot(r, pl.s), t = dot(r, pl.t), inside = s >= pl.sMin - R.edgeMarginM && s <= pl.sMax + R.edgeMarginM && t >= pl.tMin - R.edgeMarginM && t <= pl.tMax + R.edgeMarginM;
            if (!inside) continue;
            if (Math.abs(d) < R.onPlaneM && cosN >= R.onPlaneCos) { onPlane = true; break; }
            if (cosN < R.edgeOnCos && d >= R.minStandoffM && d <= R.searchM && d < bestD) { best = k; bestD = d; }
        }
        if (!onPlane && best >= 0) { owner[f] = best; standoff[f] = bestD; }
    }
    // pieces: candidate triangles of one plane sharing an edge
    const edgeFaces = new Map<string, number[]>();
    for (let f = 0; f < F; f++) if (owner[f] >= 0) for (let e = 0; e < 3; e++) {
        const x = T[f * 3 + e], y = T[f * 3 + ((e + 1) % 3)], k = x < y ? `${x}_${y}` : `${y}_${x}`;
        const list = edgeFaces.get(k); if (list) list.push(f); else edgeFaces.set(k, [f]);
    }
    const seen = new Uint8Array(F), removed: FinPiece[] = [], removedKeys = new Set<string>();
    let pieces = 0, candidates = 0, keptPieces = 0;
    for (let f0 = 0; f0 < F; f0++) {
        if (owner[f0] < 0 || seen[f0]) continue;
        const stack = [f0], members: number[] = [];
        seen[f0] = 1;
        while (stack.length) {
            const f = stack.pop()!;
            members.push(f);
            for (let e = 0; e < 3; e++) {
                const x = T[f * 3 + e], y = T[f * 3 + ((e + 1) % 3)];
                for (const g of edgeFaces.get(x < y ? `${x}_${y}` : `${y}_${x}`) ?? []) if (!seen[g] && owner[g] === owner[f0]) { seen[g] = 1; stack.push(g); }
            }
        }
        pieces++; candidates += members.length;
        let A = 0, maxD = 0, sk = 0; const ctr = [0, 0, 0], mn = [0, 0, 0];
        for (const f of members) {
            A += area[f]; maxD = Math.max(maxD, standoff[f]);
            const a = T[f * 3] * 3, b = T[f * 3 + 1] * 3, c = T[f * 3 + 2] * 3, e = [Math.hypot(P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]), Math.hypot(P[c] - P[b], P[c + 1] - P[b + 1], P[c + 2] - P[b + 2]), Math.hypot(P[a] - P[c], P[a + 1] - P[c + 1], P[a + 2] - P[c + 2])];
            const L = Math.max(...e); sk += area[f] > 0 ? area[f] * (L * L) / (2 * area[f]) : 0;
            for (let k = 0; k < 3; k++) mn[k] += area[f] * fn[f * 3 + k];
            for (let k = 0; k < 3; k++) ctr[k] += area[f] * (P[T[f * 3] * 3 + k] + P[T[f * 3 + 1] * 3 + k] + P[T[f * 3 + 2] * 3 + k]) / 3;
        }
        if (maxD > R.maxStandoffM || A > R.maxAreaM2) { keptPieces++; continue; }
        removed.push({ facadeId: planes[owner[f0]].facadeId, triangles: members.length, areaM2: Math.round(A * 100) / 100, maxStandoffM: Math.round(maxD * 100) / 100, centre: ctr.map(v => Math.round((v / (A || 1)) * 100) / 100) as [number, number, number], twist: Math.round((1 - Math.hypot(mn[0], mn[1], mn[2]) / (A || 1)) * 1000) / 1000, skinny: Math.round((sk / (A || 1)) * 10) / 10 });
        for (const f of members) removedKeys.add([keys[T[f * 3]], keys[T[f * 3 + 1]], keys[T[f * 3 + 2]]].sort().join('|'));
    }
    const removedAreaM2 = Math.round(removed.reduce((s, p) => s + p.areaM2, 0) * 100) / 100;
    const report: ScanFinsReport = {
        version: SCAN_FINS_VERSION, candidates, pieces, removed: removed.sort((a, b) => b.areaM2 - a.areaM2), removedAreaM2,
        kept: { pieces: keptPieces, why: `standing off their wall by more than ${R.maxStandoffM} m or larger than ${R.maxAreaM2} m²: a return wall or a real projection` }
    };
    return { report, edits: { shift: new Map(), removed: removedKeys, stats: { vertices: P.length / 3, triangles: F, pieces, piecesRemoved: removed.length, trianglesRemoved: removedKeys.size, areaRemovedM2: removedAreaM2, meanShiftM: 0, p95ShiftM: 0, maxShiftM: 0, clampedVertices: 0 } } };
}

/** The rebuilt facades' planes: facades.json frames of the facades the lattice drew in `glb`. */
export function rebuiltPlanes(glb: ParsedGlb, orthosDir: string): Plane[] {
    const drawn = new Set<number>((glb.json.nodes ?? []).map((n: any) => n.extras?.sbFacadeLattice?.facadeId).filter((x: unknown): x is number => typeof x === 'number'));
    const frames = JSON.parse(fs.readFileSync(path.join(orthosDir, 'facades.json'), 'utf8')).facades as any[];
    return frames.filter(f => drawn.has(f.facadeId)).map(f => ({ facadeId: f.facadeId, c: f.centroid, n: f.normal, s: f.axisS, t: f.axisT, sMin: f.sMin, sMax: f.sMax, tMin: f.tMin, tMax: f.tMax }));
}

/** The fins removed from the clay and its textured twin (the same remesh). */
export function removeScanFins(clay: Uint8Array, others: Uint8Array[], orthosDir: string, R = FIN_PARAMS): { clay: Buffer; others: Buffer[]; report: ScanFinsReport } {
    const g = parseGlbBytes(clay);
    const { report, edits } = findFins(g, rebuiltPlanes(g, orthosDir), R);
    const stamp = { key: 'sbScanFins', value: { version: SCAN_FINS_VERSION, removed: report.removed.length, removedAreaM2: report.removedAreaM2 } };
    if (!edits.removed.size) return { clay: Buffer.from(clay), others: others.map(b => Buffer.from(b)), report };
    return { clay: applyRemeshEdits(clay, edits, REMESH_CLEANUP_PARAMS.weldM, stamp).glb, others: others.map(b => applyRemeshEdits(b, edits, REMESH_CLEANUP_PARAMS.weldM, stamp).glb), report };
}
