/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The remeshed scan cleaned before it is textured (the default staged path: the photo-tile scan smoothed, not replaced;
 * user direction 2026-10-22, "work with vector tile data as a base and smooth the planes of the 3d photo tile data"):
 *
 * - scraps: edge-connected pieces smaller than `minPieceAreaM2` go (a sliver hanging by one vertex is its own piece), the
 *   melted bits a photogrammetric scan leaves on edges and roofs;
 * - feature-preserving smoothing: bilateral filtering of the face normals (neighbours weighted by distance and by how
 *   alike their normals are, so a corner or a cornice is not averaged away), then the vertices moved to agree with the
 *   filtered normals (each vertex toward the planes of its faces). Flat walls come out flat, edges stay sharp. A vertex
 *   never moves more than `maxShiftM` from where the scan put it: the result stays a measurement, smoothed.
 *
 * The edits are computed once on the clay mesh, welded by position, and applied to every GLB of the same remesh (the clay
 * and tile_refine's textured twin, which holds the same vertices split by photo material): positions and normals are
 * rewritten in place, removed triangles made degenerate, every other attribute left as it is.
 */

import { accessorLayout, assembleGlb, parseGlbBytes, readAccessor, type ParsedGlb } from './glb-bytes';

export const REMESH_CLEANUP_VERSION = 'remesh-cleanup/1';

/** On unless SCRATCHBOX_STAGED_REMESH_CLEANUP=0. */
export function remeshCleanupEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.SCRATCHBOX_STAGED_REMESH_CLEANUP?.trim() !== '0';
}

export const REMESH_CLEANUP_PARAMS = {
    /** Edge-connected pieces with less area than this go (m²). */
    minPieceAreaM2: 3,
    /** Bilateral normal filtering: iterations, spatial sigma in mean edge lengths, normal sigma (|n_i - n_j|). */
    normalIterations: 4, spatialSigmaEdges: 1.5, normalSigma: 0.35,
    /** Vertex updates toward the filtered normals' planes. */
    vertexIterations: 8,
    /** No vertex moves further than this from the scan (m). */
    maxShiftM: 0.3,
    /** Positions within this are one vertex (m). */
    weldM: 0.001
};

export interface RemeshCleanupStats {
    vertices: number; triangles: number;
    pieces: number; piecesRemoved: number; trianglesRemoved: number; areaRemovedM2: number;
    meanShiftM: number; p95ShiftM: number; maxShiftM: number; clampedVertices: number;
}

/** The edits: a displacement per welded vertex (keyed by its original position) and the removed triangles (keyed by their three positions). */
export interface RemeshEdits {
    shift: Map<string, [number, number, number]>;
    removed: Set<string>;
    stats: RemeshCleanupStats;
}

const keyOf = (x: number, y: number, z: number, q: number) => `${Math.round(x / q)},${Math.round(y / q)},${Math.round(z / q)}`;
const triKey = (a: string, b: string, c: string) => [a, b, c].sort().join('|');

interface Prim { pos: number; nrm?: number; idx?: number }

function primitives(glb: ParsedGlb): Prim[] {
    return (glb.json.meshes ?? []).flatMap((m: any) => (m.primitives ?? []).filter((p: any) => (p.mode ?? 4) === 4 && p.attributes?.POSITION !== undefined).map((p: any) => ({ pos: p.attributes.POSITION, ...(p.attributes.NORMAL !== undefined ? { nrm: p.attributes.NORMAL } : {}), ...(p.indices !== undefined ? { idx: p.indices } : {}) })));
}

/** A mesh welded by position: its vertices, triangles and each vertex's key. */
export function weldGlb(glb: ParsedGlb, q = REMESH_CLEANUP_PARAMS.weldM): { positions: Float64Array; triangles: Uint32Array; keys: string[] } {
    const at = new Map<string, number>(), pos: number[] = [], tris: number[] = [], keys: string[] = [];
    for (const p of primitives(glb)) {
        const P = readAccessor(glb, p.pos).data;
        const n = P.length / 3;
        const local = new Int32Array(n);
        for (let v = 0; v < n; v++) {
            const k = keyOf(P[v * 3], P[v * 3 + 1], P[v * 3 + 2], q);
            let w = at.get(k);
            if (w === undefined) { w = pos.length / 3; at.set(k, w); pos.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]); keys.push(k); }
            local[v] = w;
        }
        const I = p.idx !== undefined ? readAccessor(glb, p.idx).data : Float64Array.from({ length: n }, (_, i) => i);
        for (let t = 0; t + 2 < I.length; t += 3) {
            const a = local[I[t]], b = local[I[t + 1]], c = local[I[t + 2]];
            if (a !== b && b !== c && a !== c) tris.push(a, b, c);
        }
    }
    return { positions: Float64Array.from(pos), triangles: Uint32Array.from(tris), keys };
}

function faceData(P: Float64Array, T: Uint32Array): { n: Float64Array; c: Float64Array; area: Float64Array } {
    const F = T.length / 3, n = new Float64Array(F * 3), c = new Float64Array(F * 3), area = new Float64Array(F);
    for (let f = 0; f < F; f++) {
        const a = T[f * 3] * 3, b = T[f * 3 + 1] * 3, d = T[f * 3 + 2] * 3;
        const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[d] - P[a], vy = P[d + 1] - P[a + 1], vz = P[d + 2] - P[a + 2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, l = Math.hypot(nx, ny, nz);
        area[f] = l / 2;
        if (l > 0) { n[f * 3] = nx / l; n[f * 3 + 1] = ny / l; n[f * 3 + 2] = nz / l; }
        for (let k = 0; k < 3; k++) c[f * 3 + k] = (P[a + k] + P[b + k] + P[d + k]) / 3;
    }
    return { n, c, area };
}

/** Computes the edits on a welded mesh. */
export function cleanupEdits(mesh: { positions: Float64Array; triangles: Uint32Array; keys: string[] }, R = REMESH_CLEANUP_PARAMS): RemeshEdits {
    const P0 = mesh.positions, T = mesh.triangles, V = P0.length / 3, F = T.length / 3;
    // ---- pieces: faces joined by a shared edge
    const edgeFaces = new Map<string, number[]>();
    for (let f = 0; f < F; f++) for (let k = 0; k < 3; k++) {
        const a = T[f * 3 + k], b = T[f * 3 + ((k + 1) % 3)];
        const e = a < b ? `${a}_${b}` : `${b}_${a}`;
        const l = edgeFaces.get(e); if (l) l.push(f); else edgeFaces.set(e, [f]);
    }
    const parent = Int32Array.from({ length: F }, (_, i) => i);
    const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    for (const fs of edgeFaces.values()) for (let i = 1; i < fs.length; i++) { const a = find(fs[0]), b = find(fs[i]); if (a !== b) parent[a] = b; }
    const fd0 = faceData(P0, T);
    const pieceArea = new Map<number, number>();
    for (let f = 0; f < F; f++) { const r = find(f); pieceArea.set(r, (pieceArea.get(r) ?? 0) + fd0.area[f]); }
    const keepFace = new Uint8Array(F);
    let trianglesRemoved = 0, areaRemoved = 0, piecesRemoved = 0;
    for (const [, a] of pieceArea) if (a < R.minPieceAreaM2) piecesRemoved++;
    for (let f = 0; f < F; f++) { if ((pieceArea.get(find(f)) ?? 0) >= R.minPieceAreaM2) keepFace[f] = 1; else { trianglesRemoved++; areaRemoved += fd0.area[f]; } }
    // ---- face neighbours (sharing a vertex), kept faces only
    const vertFaces: number[][] = Array.from({ length: V }, () => []);
    for (let f = 0; f < F; f++) if (keepFace[f]) for (let k = 0; k < 3; k++) vertFaces[T[f * 3 + k]].push(f);
    let edgeSum = 0, edgeN = 0;
    for (let f = 0; f < F; f++) if (keepFace[f]) for (let k = 0; k < 3; k++) { const a = T[f * 3 + k] * 3, b = T[f * 3 + ((k + 1) % 3)] * 3; edgeSum += Math.hypot(P0[a] - P0[b], P0[a + 1] - P0[b + 1], P0[a + 2] - P0[b + 2]); edgeN++; }
    const sigmaS = Math.max(1e-3, (edgeSum / Math.max(1, edgeN)) * R.spatialSigmaEdges), sigmaR = R.normalSigma;
    // ---- bilateral normal filtering
    let { n, c, area } = faceData(P0, T);
    for (let it = 0; it < R.normalIterations; it++) {
        const out = new Float64Array(F * 3);
        for (let f = 0; f < F; f++) {
            if (!keepFace[f]) continue;
            let sx = 0, sy = 0, sz = 0;
            const seen = new Set<number>();
            for (let k = 0; k < 3; k++) for (const g of vertFaces[T[f * 3 + k]]) {
                if (seen.has(g)) continue; seen.add(g);
                const dc = Math.hypot(c[f * 3] - c[g * 3], c[f * 3 + 1] - c[g * 3 + 1], c[f * 3 + 2] - c[g * 3 + 2]);
                const dn = Math.hypot(n[f * 3] - n[g * 3], n[f * 3 + 1] - n[g * 3 + 1], n[f * 3 + 2] - n[g * 3 + 2]);
                const w = area[g] * Math.exp(-(dc * dc) / (2 * sigmaS * sigmaS)) * Math.exp(-(dn * dn) / (2 * sigmaR * sigmaR));
                sx += w * n[g * 3]; sy += w * n[g * 3 + 1]; sz += w * n[g * 3 + 2];
            }
            const l = Math.hypot(sx, sy, sz) || 1;
            out[f * 3] = sx / l; out[f * 3 + 1] = sy / l; out[f * 3 + 2] = sz / l;
        }
        n = out;
    }
    // ---- vertices moved toward their faces' filtered planes (within maxShiftM of the scan)
    const P = Float64Array.from(P0);
    for (let it = 0; it < R.vertexIterations; it++) {
        const cur = faceData(P, T);
        c = cur.c;
        for (let v = 0; v < V; v++) {
            const fs = vertFaces[v];
            if (!fs.length) continue;
            let dx = 0, dy = 0, dz = 0;
            for (const f of fs) {
                const d = n[f * 3] * (c[f * 3] - P[v * 3]) + n[f * 3 + 1] * (c[f * 3 + 1] - P[v * 3 + 1]) + n[f * 3 + 2] * (c[f * 3 + 2] - P[v * 3 + 2]);
                dx += n[f * 3] * d; dy += n[f * 3 + 1] * d; dz += n[f * 3 + 2] * d;
            }
            P[v * 3] += dx / fs.length; P[v * 3 + 1] += dy / fs.length; P[v * 3 + 2] += dz / fs.length;
            // clamp to the scan
            const ox = P[v * 3] - P0[v * 3], oy = P[v * 3 + 1] - P0[v * 3 + 1], oz = P[v * 3 + 2] - P0[v * 3 + 2], o = Math.hypot(ox, oy, oz);
            if (o > R.maxShiftM) { const s = R.maxShiftM / o; P[v * 3] = P0[v * 3] + ox * s; P[v * 3 + 1] = P0[v * 3 + 1] + oy * s; P[v * 3 + 2] = P0[v * 3 + 2] + oz * s; }
        }
    }
    const shift = new Map<string, [number, number, number]>(), shifts: number[] = [];
    let clamped = 0;
    for (let v = 0; v < V; v++) {
        const s: [number, number, number] = [P[v * 3] - P0[v * 3], P[v * 3 + 1] - P0[v * 3 + 1], P[v * 3 + 2] - P0[v * 3 + 2]];
        const m = Math.hypot(...s);
        if (vertFaces[v].length) shifts.push(m);
        if (m >= R.maxShiftM - 1e-6) clamped++;
        if (m > 1e-6) shift.set(mesh.keys[v], s);
    }
    const removed = new Set<string>();
    for (let f = 0; f < F; f++) if (!keepFace[f]) removed.add(triKey(mesh.keys[T[f * 3]], mesh.keys[T[f * 3 + 1]], mesh.keys[T[f * 3 + 2]]));
    shifts.sort((a, b) => a - b);
    const r3 = (x: number) => Math.round(x * 1000) / 1000;
    return {
        shift, removed,
        stats: {
            vertices: V, triangles: F, pieces: pieceArea.size, piecesRemoved, trianglesRemoved, areaRemovedM2: Math.round(areaRemoved * 10) / 10,
            meanShiftM: r3(shifts.reduce((a, b) => a + b, 0) / Math.max(1, shifts.length)), p95ShiftM: r3(shifts[Math.floor(shifts.length * 0.95)] ?? 0), maxShiftM: r3(shifts[shifts.length - 1] ?? 0), clampedVertices: clamped
        }
    };
}

/** Applies the edits to a GLB of the same remesh (positions and normals rewritten in place, removed triangles degenerate).
 * `extras` overrides the default `asset.extras.sbRemeshCleanup` stamp -- another pass (e.g. footprint-lock's clamp) that
 * reuses this same parse/patch/reserialize path stamps its own key instead, so the extras honestly name what ran. */
export function applyRemeshEdits(bytes: Uint8Array, edits: RemeshEdits, q = REMESH_CLEANUP_PARAMS.weldM, extras?: { key: string; value: unknown }): { glb: Buffer; moved: number; degenerated: number } {
    const glb = parseGlbBytes(bytes);
    const bin = new Uint8Array(glb.bin);
    const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
    const out: ParsedGlb = { json: glb.json, bin };
    let moved = 0, degenerated = 0;
    for (const p of primitives(glb)) {
        const P = readAccessor(glb, p.pos).data;
        const n = P.length / 3;
        const keys: string[] = new Array(n);
        const lp = accessorLayout(glb.json, p.pos);
        if (lp.componentType !== 5126) continue;
        const NP = new Float64Array(P.length);
        for (let v = 0; v < n; v++) {
            keys[v] = keyOf(P[v * 3], P[v * 3 + 1], P[v * 3 + 2], q);
            const s = edits.shift.get(keys[v]);
            for (let k = 0; k < 3; k++) {
                NP[v * 3 + k] = P[v * 3 + k] + (s ? s[k] : 0);
                dv.setFloat32(lp.base + v * lp.stride + k * 4, NP[v * 3 + k], true);
            }
            if (s) moved++;
        }
        const I = p.idx !== undefined ? readAccessor(glb, p.idx).data : Float64Array.from({ length: n }, (_, i) => i);
        // removed triangles made degenerate (all three corners on the first)
        if (p.idx !== undefined && edits.removed.size) {
            const li = accessorLayout(glb.json, p.idx);
            const size = li.componentType === 5125 ? 4 : li.componentType === 5123 ? 2 : 1;
            const put = (e: number, v: number) => { const o = li.base + e * li.stride; if (size === 4) dv.setUint32(o, v, true); else if (size === 2) dv.setUint16(o, v, true); else dv.setUint8(o, v); };
            for (let t = 0; t + 2 < I.length; t += 3) if (edits.removed.has(triKey(keys[I[t]], keys[I[t + 1]], keys[I[t + 2]]))) { put(t + 1, I[t]); put(t + 2, I[t]); degenerated++; }
        }
        // normals from the moved positions (area-weighted), over the triangles that remain
        if (p.nrm !== undefined) {
            const ln = accessorLayout(glb.json, p.nrm);
            if (ln.componentType === 5126) {
                const N = new Float64Array(n * 3);
                const Iq = p.idx !== undefined ? readAccessor(out, p.idx).data : I;
                for (let t = 0; t + 2 < Iq.length; t += 3) {
                    const a = Iq[t] * 3, b = Iq[t + 1] * 3, c = Iq[t + 2] * 3;
                    if (a === b || b === c) continue;
                    const ux = NP[b] - NP[a], uy = NP[b + 1] - NP[a + 1], uz = NP[b + 2] - NP[a + 2], vx = NP[c] - NP[a], vy = NP[c + 1] - NP[a + 1], vz = NP[c + 2] - NP[a + 2];
                    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
                    for (const w of [a, b, c]) { N[w] += nx; N[w + 1] += ny; N[w + 2] += nz; }
                }
                const old = readAccessor(glb, p.nrm).data;
                for (let v = 0; v < n; v++) {
                    const l = Math.hypot(N[v * 3], N[v * 3 + 1], N[v * 3 + 2]);
                    for (let k = 0; k < 3; k++) dv.setFloat32(ln.base + v * ln.stride + k * 4, l > 0 ? N[v * 3 + k] / l : old[v * 3 + k], true);
                }
            }
        }
        // the position accessor's bounds follow the moved vertices
        const acc = glb.json.accessors[p.pos];
        if (acc.min && acc.max) for (let k = 0; k < 3; k++) { let lo = Infinity, hi = -Infinity; for (let v = 0; v < n; v++) { lo = Math.min(lo, NP[v * 3 + k]); hi = Math.max(hi, NP[v * 3 + k]); } acc.min[k] = lo; acc.max[k] = hi; }
    }
    const stampKey = extras?.key ?? 'sbRemeshCleanup';
    const stampValue = extras?.value ?? { version: REMESH_CLEANUP_VERSION, stats: edits.stats };
    glb.json.asset = { ...(glb.json.asset ?? {}), extras: { ...(glb.json.asset?.extras ?? {}), [stampKey]: stampValue } };
    return { glb: assembleGlb(glb.json, bin), moved, degenerated };
}

/** Cleans a remesh: the edits from its clay, applied to the clay and to each other GLB given (its textured twin). */
export function cleanRemesh(clayBytes: Uint8Array, others: Uint8Array[], R = REMESH_CLEANUP_PARAMS): { clay: Buffer; others: Buffer[]; stats: RemeshCleanupStats } {
    const edits = cleanupEdits(weldGlb(parseGlbBytes(clayBytes), R.weldM), R);
    return { clay: applyRemeshEdits(clayBytes, edits, R.weldM).glb, others: others.map(b => applyRemeshEdits(b, edits, R.weldM).glb), stats: edits.stats };
}
