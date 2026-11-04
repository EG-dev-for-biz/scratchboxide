/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The tree strip's caps and skirts textured by the surface infill (surface-infill.ts).
 *
 * The strip (scratchbox_tile_vegetation.hpp) closes the ground and the walls where it cut a crown with caps (the ground or
 * roof under a removed tree, seen from above) and skirts (a vertical panel continuing a hole edge down), and colours them
 * itself: the nearest real texel's mirror, else the tile's mean colour of such surfaces (`strip_fill_generated`). Here
 * each piece (the fill triangles joined by shared corners, a cap where it faces up, a skirt where it does not) is a region
 * of the surface it closes: its ring the kept scan's own corners within reach of it and near its level (a cap) or its
 * plane (a skirt); the infill paints it from that surface's own photo by the first rung of its ladder whose fill passes
 * the seam gate. The geometry is the strip's own and is not moved. Each fill mesh's provenance is rewritten from the
 * infill's labels; the root extras carry `sbInfill` per piece.
 *
 * Nothing here knows what a tree, a wall or a roof is: the fill flag, a normal and continuous reaches.
 */

import type { Vec3 } from '../../../common/spatial/staged-location-contracts';
import { parseGlbBytes, assembleGlb } from './glb-bytes';
import { readTileTriangles, type TileTriangles } from './tile-texture-transfer';
import { applyInfillToGlb, infillExtras, infillRegions, type InfillRegionSpec, type RegionInfill } from './surface-infill';

export const STRIP_INFILL_VERSION = 'strip-infill/1';

export const STRIP_INFILL_PARAMS = {
    /** A fill triangle facing up at least this (|n.y|) is a cap; else a skirt. */
    capNy: 0.7,
    /** Pieces smaller than this (m²) keep the strip's own fill (too small for the ladder to read a structure). */
    minAreaM2: 0.5,
    /** The ring: kept corners within this (m, plan for a cap, in the skirt's plane for a skirt) of the piece. */
    ringM: 1.5,
    /** ... and within this of the piece's level (a cap) or its plane (a skirt) (m). */
    ringLevelM: 0.6,
    /** At most this many ring points a piece (evenly thinned). */
    ringMax: 2000,
    /** Corners closer than this are one corner when pieces are joined (m). */
    weldM: 0.005
};
export type StripInfillParams = typeof STRIP_INFILL_PARAMS;

/** On by default; SCRATCHBOX_STRIP_INFILL=0 keeps the strip's own fill. */
export function stripInfillEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.SCRATCHBOX_STRIP_INFILL?.trim() !== '0';
}

export interface StripPiece {
    kind: 'cap' | 'skirt';
    /** Triangle indices into the soup. */
    triangles: number[];
    areaM2: number;
    /** Area-weighted normal (unit), facing the way the piece was laid. */
    normal: Vec3;
}

const sub = (P: Float32Array, a: number, b: number): Vec3 => [P[a] - P[b], P[a + 1] - P[b + 1], P[a + 2] - P[b + 2]];
const crossV = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** The strip's fill triangles joined by shared corners into pieces, each a cap or a skirt by its normal. */
export function stripFillPieces(t: TileTriangles, P: StripInfillParams = STRIP_INFILL_PARAMS): StripPiece[] {
    const n = t.texture.length, Pp = t.positions;
    const parent = Int32Array.from({ length: n }, (_, i) => i);
    const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const q = 1 / P.weldM;
    const corner = new Map<string, number>();
    const fill: number[] = [];
    for (let tr = 0; tr < n; tr++) {
        if (!t.fill?.[tr]) continue;
        fill.push(tr);
        for (let k = 0; k < 3; k++) {
            const o = tr * 9 + k * 3, key = `${Math.round(Pp[o] * q)},${Math.round(Pp[o + 1] * q)},${Math.round(Pp[o + 2] * q)}`;
            const other = corner.get(key);
            if (other === undefined) corner.set(key, tr); else parent[find(tr)] = find(other);
        }
    }
    const groups = new Map<number, number[]>();
    for (const tr of fill) {
        // a cap and a skirt sharing an edge are two pieces: split by kind before joining
        const r = find(tr), cap = Math.abs(t.normals[tr * 3 + 1]) >= P.capNy;
        const key = r * 2 + (cap ? 1 : 0);
        let l = groups.get(key);
        if (!l) groups.set(key, l = []);
        l.push(tr);
    }
    const out: StripPiece[] = [];
    for (const [key, tris] of groups) {
        let area = 0;
        const nrm: Vec3 = [0, 0, 0];
        for (const tr of tris) {
            const o = tr * 9, c = crossV(sub(Pp, o + 3, o), sub(Pp, o + 6, o)), a = Math.hypot(c[0], c[1], c[2]) / 2;
            area += a;
            // the triangle's own (winding) normal, weighted by area
            for (let j = 0; j < 3; j++) nrm[j] += a * t.normals[tr * 3 + j];
        }
        const L = Math.hypot(nrm[0], nrm[1], nrm[2]) || 1;
        out.push({ kind: key % 2 ? 'cap' : 'skirt', triangles: tris, areaM2: area, normal: [nrm[0] / L, nrm[1] / L, nrm[2] / L] });
    }
    return out.sort((a, b) => b.areaM2 - a.areaM2);
}

/** The kept scan's corners (not a fill), deduplicated, in a plan grid of `cell` metres: what every piece's ring is read from. */
export interface KeptCorners { x: Float32Array; y: Float32Array; z: Float32Array; cell: number; grid: Map<string, number[]> }

export function keptCorners(t: TileTriangles, cell = 2): KeptCorners {
    const Pp = t.positions, n = t.texture.length;
    const seen = new Map<string, number>();
    const xs: number[] = [], ys: number[] = [], zs: number[] = [];
    const grid = new Map<string, number[]>();
    for (let tr = 0; tr < n; tr++) {
        if (t.fill?.[tr]) continue;
        for (let k = 0; k < 3; k++) {
            const c = tr * 9 + k * 3, x = Pp[c], y = Pp[c + 1], z = Pp[c + 2];
            const key = `${Math.round(x * 200)},${Math.round(y * 200)},${Math.round(z * 200)}`;
            if (seen.has(key)) continue;
            seen.set(key, xs.length);
            const g = `${Math.floor(x / cell)},${Math.floor(z / cell)}`;
            let l = grid.get(g);
            if (!l) grid.set(g, l = []);
            l.push(xs.length);
            xs.push(x); ys.push(y); zs.push(z);
        }
    }
    return { x: Float32Array.from(xs), y: Float32Array.from(ys), z: Float32Array.from(zs), cell, grid };
}

/** A piece's ring: the kept corners within ringM of the piece (in plan for a cap, in 3D for a skirt) and near its level or plane. */
export function stripPieceRing(t: TileTriangles, piece: StripPiece, kept: KeptCorners, P: StripInfillParams = STRIP_INFILL_PARAMS): Float32Array {
    const Pp = t.positions;
    // the piece's corners in a fine plan grid, and its plane
    const fine = Math.max(0.25, P.ringM / 2);
    const mine = new Map<string, number[]>();
    let cx = 0, cy = 0, cz = 0, m = 0, x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const tr of piece.triangles) for (let k = 0; k < 3; k++) {
        const o = tr * 9 + k * 3;
        const key = `${Math.floor(Pp[o] / fine)},${Math.floor(Pp[o + 2] / fine)}`;
        let l = mine.get(key);
        if (!l) mine.set(key, l = []);
        l.push(o);
        cx += Pp[o]; cy += Pp[o + 1]; cz += Pp[o + 2]; m++;
        x0 = Math.min(x0, Pp[o]); x1 = Math.max(x1, Pp[o]); z0 = Math.min(z0, Pp[o + 2]); z1 = Math.max(z1, Pp[o + 2]);
    }
    cx /= m; cy /= m; cz /= m;
    const N = piece.normal, d0 = cx * N[0] + cy * N[1] + cz * N[2];
    const cap = piece.kind === 'cap', r2 = P.ringM * P.ringM, reach = Math.ceil(P.ringM / fine);
    const out: number[] = [];
    const g0x = Math.floor((x0 - P.ringM) / kept.cell), g1x = Math.floor((x1 + P.ringM) / kept.cell), g0z = Math.floor((z0 - P.ringM) / kept.cell), g1z = Math.floor((z1 + P.ringM) / kept.cell);
    for (let gx = g0x; gx <= g1x; gx++) for (let gz = g0z; gz <= g1z; gz++) for (const i of kept.grid.get(`${gx},${gz}`) ?? []) {
        const x = kept.x[i], y = kept.y[i], z = kept.z[i];
        if (!cap && Math.abs(x * N[0] + y * N[1] + z * N[2] - d0) > P.ringLevelM) continue;
        const ci = Math.floor(x / fine), ck = Math.floor(z / fine);
        let best = Infinity, by = NaN;
        for (let di = -reach; di <= reach; di++) for (let dk = -reach; dk <= reach; dk++) for (const q of mine.get(`${ci + di},${ck + dk}`) ?? []) {
            const d2 = cap ? (Pp[q] - x) ** 2 + (Pp[q + 2] - z) ** 2 : (Pp[q] - x) ** 2 + (Pp[q + 1] - y) ** 2 + (Pp[q + 2] - z) ** 2;
            if (d2 < best) { best = d2; by = Pp[q + 1]; }
        }
        if (best > r2) continue;
        if (cap && Math.abs(y - by) > P.ringLevelM) continue;
        out.push(x, y, z);
    }
    const k = out.length / 3;
    if (k <= P.ringMax) return Float32Array.from(out);
    const thin: number[] = [];
    const stride = k / P.ringMax;
    for (let j = 0; j < P.ringMax; j++) { const i = Math.floor(j * stride) * 3; thin.push(out[i], out[i + 1], out[i + 2]); }
    return Float32Array.from(thin);
}

export interface StripInfillReport {
    schema: 'scratchbox.strip-infill/1';
    version: string;
    pieces: { cap: number; skirt: number };
    /** Pieces the infill painted, and their area (m²); the rest (smaller than minAreaM2) keep the strip's own fill. */
    refilled: { cap: number; skirt: number; areaM2: { cap: number; skirt: number } };
    /** Area-weighted shares of the refilled area by label, per kind. */
    shares: { cap: Record<string, number>; skirt: Record<string, number> };
    /** Refilled pieces whose fill no rung passed the seam gate for (the least bad kept, generated), with their area (m²). */
    gateFailed: { cap: number; skirt: number; areaM2: number };
    paintedTexels: number;
    ms: number;
}

/**
 * Refills a devegetated tile's caps and skirts (GLB bytes in, GLB bytes out) through the surface infill, and rewrites each
 * fill mesh's provenance from the infill's labels.
 */
export async function refillStripPieces(bytes: Uint8Array, opts: { P?: StripInfillParams; signal?: AbortSignal; log?: (m: string) => void } = {}): Promise<{ glb: Buffer; report: StripInfillReport; regions: RegionInfill[] }> {
    const t0 = Date.now();
    const P = opts.P ?? STRIP_INFILL_PARAMS;
    const tris = readTileTriangles(bytes);
    const pieces = stripFillPieces(tris, P);
    const chosen = pieces.filter(p => p.areaM2 >= P.minAreaM2);
    const kept = keptCorners(tris);
    const specs: InfillRegionSpec[] = chosen.map((p, id) => {
        const hole = new Float32Array(p.triangles.length * 9);
        p.triangles.forEach((tr, j) => hole.set(tris.positions.subarray(tr * 9, tr * 9 + 9), j * 9));
        const ring = stripPieceRing(tris, p, kept, P);
        return p.kind === 'cap'
            ? { id, what: `the ${p.areaM2.toFixed(1)} m² of ground or roof the tree strip closed where it cut a crown`, hole, ring, plan: true }
            : { id, what: `the ${p.areaM2.toFixed(1)} m² of wall or side the tree strip closed down where it cut a crown`, hole, ring, normalHint: p.normal };
    });
    opts.log?.(`strip infill: ${pieces.length} fill pieces, ${chosen.length} of at least ${P.minAreaM2} m²`);
    const inf = chosen.length ? await infillRegions({ scan: tris, regions: specs, ...(opts.signal ? { signal: opts.signal } : {}), ...(opts.log ? { log: opts.log } : {}) }) : { regions: [], ms: 0 };
    const report: StripInfillReport = {
        schema: 'scratchbox.strip-infill/1', version: STRIP_INFILL_VERSION,
        pieces: { cap: pieces.filter(p => p.kind === 'cap').length, skirt: pieces.filter(p => p.kind === 'skirt').length },
        refilled: { cap: 0, skirt: 0, areaM2: { cap: 0, skirt: 0 } }, shares: { cap: {}, skirt: {} }, gateFailed: { cap: 0, skirt: 0, areaM2: 0 }, paintedTexels: 0, ms: 0
    };
    for (const r of inf.regions) {
        const p = chosen[r.id as number], k = p.kind;
        report.refilled[k]++;
        report.refilled.areaM2[k] += p.areaM2;
        for (const [label, share] of Object.entries(r.shares)) report.shares[k][label] = (report.shares[k][label] ?? 0) + share * p.areaM2;
        if (!r.gatePassed) { report.gateFailed[k]++; report.gateFailed.areaM2 += p.areaM2; }
    }
    for (const k of ['cap', 'skirt'] as const) {
        const a = report.refilled.areaM2[k] || 1;
        for (const label of Object.keys(report.shares[k])) report.shares[k][label] = Math.round((report.shares[k][label] / a) * 1000) / 1000;
        report.refilled.areaM2[k] = Math.round(report.refilled.areaM2[k] * 10) / 10;
    }
    report.gateFailed.areaM2 = Math.round(report.gateFailed.areaM2 * 10) / 10;
    if (!inf.regions.length) { report.ms = Date.now() - t0; return { glb: Buffer.from(bytes), report, regions: [] }; }
    const painted = applyInfillToGlb(bytes, inf.regions, { paint: true, extras: infillExtras(inf.regions, 'tree strip') });
    report.paintedTexels = painted.stats.paintedTexels;
    // each fill mesh's provenance: the infill's, by the shares of the kind it holds
    const g = parseGlbBytes(painted.glb);
    for (const mesh of g.json.meshes ?? []) {
        const sf = mesh?.extras?.scratchbox?.stripFill;
        if (!sf) continue;
        const k = sf.kind === 'skirt' ? 'skirt' : 'cap', sh = report.shares[k], pi = sh['photo-inferred'] ?? 0, gen = sh.generated ?? 0, me = sh.measured ?? 0;
        if (!report.refilled[k]) continue;
        sf.refilledBy = STRIP_INFILL_VERSION;
        sf.provenance = {
            ...(sf.provenance ?? {}),
            label: pi + me >= gen ? 'photo-inferred' : 'generated',
            method: `the surface infill (${report.refilled[k]} ${k === 'cap' ? 'caps' : 'skirts'} of at least ${P.minAreaM2} m²): continued from the closed surface's own photo along its measured direction or repeat (photo-inferred), else synthesised from its grain (generated), behind a seam gate; smaller pieces keep the strip's own fill`,
            note: `${Math.round(pi * 100)} % photo-inferred, ${Math.round(gen * 100)} % generated by area; ${report.gateFailed[k]} pieces where no rung passed the seam gate (the least bad kept, generated)`
        };
    }
    report.ms = Date.now() - t0;
    g.json.extras = { ...(g.json.extras ?? {}), sbStripInfill: report };
    return { glb: assembleGlb(g.json, g.bin), report, regions: inf.regions };
}
