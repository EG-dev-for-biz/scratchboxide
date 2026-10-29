/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Seam census of a scene: how its pieces meet. A piece is a node's mesh (a tile leaf when nodes carry a leaf id in
 * extras.sb.provenance.sources, every node of one leaf one piece), its vertices welded at 0.1 mm inside it. Per open-edge
 * vertex (an edge used once inside its own piece), the nearest open edge or vertex of another piece within reachM:
 *  - the gap, histogrammed;
 *  - a T-junction when that nearest point lies inside the other piece's edge, more than 1 mm nearer than its vertices;
 *  - the vertical part of the offset (a step).
 * Overlaps: a top-down raster; a cell where two pieces both have an up-facing surface within 1 m in height.
 * Measures only; nothing is changed. Node transforms are applied; y is up.
 */

import { nodeWorldMatrices, parseGlbBytes, readAccessor, transformPoint } from './staged-location/glb-bytes';

export const SCENE_SEAM_CENSUS_VERSION = 'scene-seam-census/1';

export interface SceneSeamCensus {
    version: string;
    pieces: number; vertices: number; triangles: number;
    openEdges: number; openVertices: number;
    /** Open-edge vertices with another piece within reachM (seam points), and those facing nothing (the scene's border or holes). */
    seamPoints: number; freePoints: number;
    gapEdgesM: number[]; gapHistogram: number[];
    tJunctions: number; tJunctionsWithin3cm: number;
    stepEdgesM: number[]; stepHistogram: number[];
    overlapM2: number; overlapEdgesM: number[]; overlapHistogram: number[];
    ms: number;
}

export function sceneSeamCensus(bytes: Uint8Array, opts: { reachM?: number; overlapCellM?: number } = {}): SceneSeamCensus {
    const t0 = Date.now(), reach = opts.reachM ?? 0.5, PX = opts.overlapCellM ?? 0.25;
    const glb = parseGlbBytes(bytes), json = glb.json, world = nodeWorldMatrices(json);
    const pieceOf = new Map<string, number>(), welds: Map<string, number>[] = [];
    const P: number[] = [], L: number[] = [], T: number[] = [];
    const key = (x: number, y: number, z: number) => `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
    (json.nodes ?? []).forEach((n: any, ni: number) => {
        if (n.mesh === undefined) return;
        const id = n.extras?.sb?.provenance?.sources?.[0]?.id ?? `node${ni}`;
        let piece = pieceOf.get(id);
        if (piece === undefined) { piece = pieceOf.size; pieceOf.set(id, piece); welds.push(new Map()); }
        const m = world[ni];
        for (const pr of json.meshes[n.mesh]?.primitives ?? []) {
            if ((pr.mode ?? 4) !== 4 || pr.attributes?.POSITION === undefined) continue;
            const X = readAccessor(glb, pr.attributes.POSITION).data;
            const I = pr.indices !== undefined ? readAccessor(glb, pr.indices).data : Float64Array.from({ length: X.length / 3 }, (_, i) => i);
            const ids = new Int32Array(X.length / 3);
            for (let v = 0; v < ids.length; v++) {
                const p = transformPoint(m, X[v * 3], X[v * 3 + 1], X[v * 3 + 2]), k = key(p[0], p[1], p[2]), w = welds[piece];
                let g = w.get(k);
                if (g === undefined) { g = P.length / 3; P.push(p[0], p[1], p[2]); L.push(piece); w.set(k, g); }
                ids[v] = g;
            }
            for (let t = 0; t + 2 < I.length; t += 3) { const a = ids[I[t]], b = ids[I[t + 1]], c = ids[I[t + 2]]; if (a !== b && b !== c && a !== c) T.push(a, b, c); }
        }
    });
    const NV = P.length / 3, NT = T.length / 3;
    // open edges inside each piece
    const count = new Map<string, number>();
    const ek = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`);
    for (let t = 0; t < NT; t++) for (let k = 0; k < 3; k++) { const e = ek(T[t * 3 + k], T[t * 3 + (k + 1) % 3]); count.set(e, (count.get(e) ?? 0) + 1); }
    const open: Array<[number, number]> = [];
    for (const [e, c] of count) if (c === 1) { const [a, b] = e.split('_').map(Number); open.push([a, b]); }
    const isOpen = new Uint8Array(NV);
    for (const [a, b] of open) { isOpen[a] = 1; isOpen[b] = 1; }
    let openVertices = 0;
    for (let v = 0; v < NV; v++) openVertices += isOpen[v];
    // grids of open vertices and open edges (cell = reach)
    const C = reach, ck = (x: number, y: number, z: number) => `${Math.floor(x / C)},${Math.floor(y / C)},${Math.floor(z / C)}`;
    const vGrid = new Map<string, number[]>(), eGrid = new Map<string, number[]>();
    for (let v = 0; v < NV; v++) if (isOpen[v]) { const k = ck(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]); (vGrid.get(k) ?? vGrid.set(k, []).get(k)!).push(v); }
    open.forEach(([a, b], i) => {
        const lo = [0, 1, 2].map(k => Math.floor(Math.min(P[a * 3 + k], P[b * 3 + k]) / C)), hi = [0, 1, 2].map(k => Math.floor(Math.max(P[a * 3 + k], P[b * 3 + k]) / C));
        if ((hi[0] - lo[0] + 1) * (hi[1] - lo[1] + 1) * (hi[2] - lo[2] + 1) > 200) return;
        for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) { const k = `${x},${y},${z}`; (eGrid.get(k) ?? eGrid.set(k, []).get(k)!).push(i); }
    });
    const gapEdges = [0, 1e-4, 1e-3, 5e-3, 0.01, 0.03, 0.1, 0.3], stepEdges = [0, 0.005, 0.01, 0.03, 0.1, 0.3];
    const gapHist = new Array(gapEdges.length).fill(0), stepHist = new Array(stepEdges.length).fill(0);
    const bucket = (edges: number[], v: number) => { let i = 0; for (let k = 0; k < edges.length; k++) if (v >= edges[k]) i = k; return i; };
    let seam = 0, free = 0, tj = 0, tj3 = 0;
    for (let v = 0; v < NV; v++) {
        if (!isOpen[v]) continue;
        const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2], lv = L[v];
        let dv = Infinity, bv = -1, de = Infinity, cp: number[] = [], inner = false;
        const cx = Math.floor(x / C), cy = Math.floor(y / C), cz = Math.floor(z / C), seen = new Set<number>();
        for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
            const k = `${cx + a},${cy + b},${cz + c}`;
            for (const u of vGrid.get(k) ?? []) { if (L[u] === lv) continue; const d = Math.hypot(P[u * 3] - x, P[u * 3 + 1] - y, P[u * 3 + 2] - z); if (d < dv) { dv = d; bv = u; } }
            for (const i of eGrid.get(k) ?? []) {
                if (seen.has(i)) continue; seen.add(i);
                const [p, q] = open[i]; if (L[p] === lv) continue;
                const ex = P[q * 3] - P[p * 3], ey = P[q * 3 + 1] - P[p * 3 + 1], ez = P[q * 3 + 2] - P[p * 3 + 2], ll = ex * ex + ey * ey + ez * ez;
                if (!(ll > 0)) continue;
                const s = Math.max(0, Math.min(1, ((x - P[p * 3]) * ex + (y - P[p * 3 + 1]) * ey + (z - P[p * 3 + 2]) * ez) / ll));
                const qx = P[p * 3] + ex * s, qy = P[p * 3 + 1] + ey * s, qz = P[p * 3 + 2] + ez * s, d = Math.hypot(qx - x, qy - y, qz - z);
                if (d < de) { de = d; cp = [qx, qy, qz]; inner = s > 0.02 && s < 0.98; }
            }
        }
        const g = Math.min(dv, de);
        if (!(g <= reach)) { free++; continue; }
        seam++;
        gapHist[bucket(gapEdges, g)]++;
        const isT = inner && de + 1e-3 < dv;
        if (isT) { tj++; if (g <= 0.03) tj3++; }
        const to = isT || de <= dv ? cp : [P[bv * 3], P[bv * 3 + 1], P[bv * 3 + 2]];
        stepHist[bucket(stepEdges, Math.abs(to[1] - y))]++;
    }
    // overlaps: top-down raster of up-facing surface per piece
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let v = 0; v < NV; v++) { x0 = Math.min(x0, P[v * 3]); x1 = Math.max(x1, P[v * 3]); z0 = Math.min(z0, P[v * 3 + 2]); z1 = Math.max(z1, P[v * 3 + 2]); }
    const W = NV ? Math.ceil((x1 - x0) / PX) + 1 : 0, H = NV ? Math.ceil((z1 - z0) / PX) + 1 : 0;
    const firstPiece = new Int32Array(W * H).fill(-1), firstH = new Float32Array(W * H), overlapDh = new Float32Array(W * H).fill(NaN);
    for (let t = 0; t < NT; t++) {
        const a = T[t * 3], b = T[t * 3 + 1], c = T[t * 3 + 2];
        const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2], vx = P[c * 3] - P[a * 3], vy = P[c * 3 + 1] - P[a * 3 + 1], vz = P[c * 3 + 2] - P[a * 3 + 2];
        const ny = uz * vx - ux * vz, nl = Math.hypot(uy * vz - uz * vy, ny, ux * vy - uy * vx);
        if (!(nl > 0) || Math.abs(ny) / nl < 0.7) continue;
        const S = [a, b, c].map(i => (P[i * 3] - x0) / PX), Z = [a, b, c].map(i => (P[i * 3 + 2] - z0) / PX), Y = [a, b, c].map(i => P[i * 3 + 1]);
        const area = (S[1] - S[0]) * (Z[2] - Z[0]) - (S[2] - S[0]) * (Z[1] - Z[0]);
        if (Math.abs(area) < 1e-12) continue;
        const sx0 = Math.max(0, Math.ceil(Math.min(...S))), sx1 = Math.min(W - 1, Math.floor(Math.max(...S))), sz0 = Math.max(0, Math.ceil(Math.min(...Z))), sz1 = Math.min(H - 1, Math.floor(Math.max(...Z)));
        for (let zz = sz0; zz <= sz1; zz++) for (let xx = sx0; xx <= sx1; xx++) {
            const w1 = ((xx - S[0]) * (Z[2] - Z[0]) - (S[2] - S[0]) * (zz - Z[0])) / area, w2 = ((S[1] - S[0]) * (zz - Z[0]) - (xx - S[0]) * (Z[1] - Z[0])) / area, w0 = 1 - w1 - w2;
            if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
            const h = w0 * Y[0] + w1 * Y[1] + w2 * Y[2], o = zz * W + xx;
            if (firstPiece[o] < 0) { firstPiece[o] = L[a]; firstH[o] = h; }
            else if (firstPiece[o] !== L[a] && Math.abs(h - firstH[o]) < 1) { const d = Math.abs(h - firstH[o]); if (!(overlapDh[o] >= d)) overlapDh[o] = d; }
        }
    }
    const overlapEdges = [0, 0.01, 0.03, 0.1, 0.3], overlapHist = new Array(overlapEdges.length).fill(0);
    let overlapCells = 0;
    for (let o = 0; o < W * H; o++) if (Number.isFinite(overlapDh[o])) { overlapCells++; overlapHist[bucket(overlapEdges, overlapDh[o])]++; }
    return {
        version: SCENE_SEAM_CENSUS_VERSION, pieces: pieceOf.size, vertices: NV, triangles: NT, openEdges: open.length, openVertices,
        seamPoints: seam, freePoints: free, gapEdgesM: gapEdges, gapHistogram: gapHist, tJunctions: tj, tJunctionsWithin3cm: tj3,
        stepEdgesM: stepEdges, stepHistogram: stepHist, overlapM2: Math.round(overlapCells * PX * PX), overlapEdgesM: overlapEdges, overlapHistogram: overlapHist,
        ms: Date.now() - t0
    };
}
