/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline E, step 1: the building's massing as continuous numbers, from Google's own data, checked against the scan.
 *
 *   - Plan: each extruded part of the building's vector footprint (its loops simplified to clean corners: Douglas-Peucker
 *     at SIMPLIFY_TOLERANCE_M, near-collinear corners dropped), or the modelled 3D volume where Google has one (used as
 *     given: its triangles, on the building's base).
 *   - Height per part: the Solar API's flat roof facets inside it, else the vector height, each taken only when it lies within
 *     HEIGHT_AGREEMENT_M of the scan's roof there; otherwise the scan's roof (median) stands, and the record says so.
 *   - Roof: pitched Solar facets inside a part are planes y = a + b x + c z; the roof is the lower envelope of the kept planes
 *     capped at the top. A facet is kept only when adding it lowers the part's roof error against the scan (greedy, by area).
 *   - The check: the massing's plan against the scan's structure cells (intersection over union) and its roof against the
 *     scan's top (median absolute error). A massing below MIN_MASSING_IOU, or further off than the height limit, is not used:
 *     the build falls back to the current pipeline with these numbers as the reason.
 *
 * No part is named or classified: a part is loops and numbers.
 */

import type { Vec2 } from '../../../../common/spatial/staged-location-contracts';
import type { VectorBuilding } from '../vector-footprints';
import type { SolarRoofSegment } from './solar-roof';

export const SIMPLIFY_TOLERANCE_M = 0.25;
export const COLLINEAR_DEG = 6;
export const HEIGHT_AGREEMENT_M = 2.5;
export const MIN_PITCHED_DEG = 10;
export const MIN_MASSING_IOU = 0.6;
/** The roof's median absolute error may be at most this, or this share of the building's height when that is larger. */
export const MAX_HEIGHT_ERROR_M = 3;
export const MAX_HEIGHT_ERROR_SHARE = 0.15;

export interface RoofPlaneSpec { a: number; b: number; c: number; tag: string }

export interface MassingPart {
    id: string;
    baseY: number;
    topY: number;
    loops: Vec2[][];
    planes: RoofPlaneSpec[];
    heightSource: 'solar' | 'vector' | 'scan' | (string & {});
    heights: { vectorY?: number; solarY?: number; scanY?: number };
    /** The provenance token the native tool passes through to the part's nodes (default: the spec's). */
    provenance?: string;
}

export interface MassingMesh { id: string; vertices: Array<[number, number, number]>; indices: number[] }

export interface MassingCheck {
    iou: number;
    heightErrMedianM: number;
    heightErrP90M: number;
    massingCells: number;
    scanCells: number;
    ok: boolean;
    reason?: string;
}

export interface Massing {
    parts: MassingPart[];
    meshes: MassingMesh[];
    check: MassingCheck;
    solar: { segments: number; inside: number; pitchedKept: number; pitchedRejected: number; flatUsed: number };
    notes: string[];
}

export interface MassingInputs {
    /** The target building's vector features (the pick's feature ids). */
    buildings: VectorBuilding[];
    /** Street level at the structure (the pick's ground). */
    groundY: number;
    /** The scan's top surface at (x, z) (NaN without data): the ground model's top, canopy masked. */
    scanTop: (x: number, z: number) => number;
    /** The structure's cells in the scan ("floor(x),floor(z)", 1 m). */
    cells: ReadonlySet<string>;
    /** Solar roof facets with their centres and plane heights already in the tile frame. */
    solar?: Array<SolarRoofSegment & { x: number; z: number; y: number }>;
}

// ------------------------------------------------------------------------------------------------
// plan geometry
// ------------------------------------------------------------------------------------------------

export function ringArea(r: Vec2[]): number {
    let a = 0;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
    return a / 2;
}

export function inRing(x: number, z: number, r: Vec2[]): boolean {
    let inside = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const [xi, zi] = r[i], [xj, zj] = r[j];
        if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
    return inside;
}

export function inLoops(x: number, z: number, loops: Vec2[][]): boolean {
    let inside = false;
    for (const l of loops) if (l.length >= 3 && inRing(x, z, l)) inside = !inside;
    return inside;
}

function segDist(p: Vec2, a: Vec2, b: Vec2): number {
    const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz || 1e-12;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2));
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dz));
}

/** A closed ring simplified: duplicate points out, Douglas-Peucker at `tol`, near-collinear corners dropped. */
export function simplifyRing(ring: Vec2[], tol = SIMPLIFY_TOLERANCE_M, collinearDeg = COLLINEAR_DEG): Vec2[] {
    let r = ring.filter((p, i) => i === 0 || Math.hypot(p[0] - ring[i - 1][0], p[1] - ring[i - 1][1]) > 1e-3);
    if (r.length > 1 && Math.hypot(r[0][0] - r[r.length - 1][0], r[0][1] - r[r.length - 1][1]) < 1e-3) r = r.slice(0, -1);
    if (r.length < 4) return r;
    // Douglas-Peucker on the open chain from the vertex furthest from the first
    let far = 0, fd = -1;
    for (let i = 1; i < r.length; i++) { const d = Math.hypot(r[i][0] - r[0][0], r[i][1] - r[0][1]); if (d > fd) { fd = d; far = i; } }
    const dp = (pts: Vec2[]): Vec2[] => {
        if (pts.length <= 2) return pts;
        let idx = 0, dmax = 0;
        for (let i = 1; i < pts.length - 1; i++) { const d = segDist(pts[i], pts[0], pts[pts.length - 1]); if (d > dmax) { dmax = d; idx = i; } }
        if (dmax <= tol) return [pts[0], pts[pts.length - 1]];
        return [...dp(pts.slice(0, idx + 1)).slice(0, -1), ...dp(pts.slice(idx))];
    };
    const a = dp(r.slice(0, far + 1)), b = dp([...r.slice(far), r[0]]);
    const out = [...a.slice(0, -1), ...b.slice(0, -1)];
    // near-collinear corners out (repeat until stable)
    for (let changed = true; changed && out.length > 3;) {
        changed = false;
        for (let i = 0; i < out.length && out.length > 3; i++) {
            const p = out[(i + out.length - 1) % out.length], q = out[i], s = out[(i + 1) % out.length];
            const u: Vec2 = [q[0] - p[0], q[1] - p[1]], v: Vec2 = [s[0] - q[0], s[1] - q[1]];
            const lu = Math.hypot(...u), lv = Math.hypot(...v);
            if (lu < 0.05 || lv < 0.05) { out.splice(i, 1); changed = true; break; }
            const ang = Math.abs(Math.atan2(u[0] * v[1] - u[1] * v[0], u[0] * v[0] + u[1] * v[1])) * 180 / Math.PI;
            if (ang < collinearDeg) { out.splice(i, 1); changed = true; break; }
        }
    }
    return out;
}

const median = (v: number[]): number => { if (!v.length) return NaN; const s = [...v].sort((a, b) => a - b); return s[s.length >> 1]; };
const quantile = (v: number[], q: number): number => { if (!v.length) return NaN; const s = [...v].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))]; };

/** Grid sample points (cell centres, 1 m) inside loops. */
function samplesIn(loops: Vec2[][], step = 1): Vec2[] {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of loops[0] ?? []) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    const out: Vec2[] = [];
    for (let z = Math.floor(z0) + 0.5; z < z1; z += step) for (let x = Math.floor(x0) + 0.5; x < x1; x += step) if (inLoops(x, z, loops)) out.push([x, z]);
    return out;
}

/** A Solar facet as a plane y = a + b x + c z: through its centre, rising against its azimuth (north = -z, east = +x). */
export function solarPlane(s: { pitchDeg: number; azimuthDeg: number; x: number; z: number; y: number }): RoofPlaneSpec {
    const k = Math.tan((s.pitchDeg * Math.PI) / 180), az = (s.azimuthDeg * Math.PI) / 180;
    const dx = Math.sin(az), dz = -Math.cos(az);  // downslope direction in the frame
    const b = -k * dx, c = -k * dz;
    return { a: s.y - b * s.x - c * s.z, b, c, tag: `solar:${s.pitchDeg.toFixed(1)}deg@${s.azimuthDeg.toFixed(0)}` };
}

export function roofAt(part: Pick<MassingPart, 'topY' | 'baseY' | 'planes'>, x: number, z: number): number {
    let y = part.topY;
    for (const p of part.planes) y = Math.min(y, p.a + p.b * x + p.c * z);
    return Math.max(y, part.baseY + 0.25);
}

/** Highest surface of a triangle mesh per 1 m cell (the cells its triangles' plan covers). */
export function meshTopCells(m: MassingMesh): Map<string, number> {
    const out = new Map<string, number>();
    const V = m.vertices;
    for (let t = 0; t + 2 < m.indices.length; t += 3) {
        const a = V[m.indices[t]], b = V[m.indices[t + 1]], c = V[m.indices[t + 2]];
        const x0 = Math.floor(Math.min(a[0], b[0], c[0])), x1 = Math.floor(Math.max(a[0], b[0], c[0]));
        const z0 = Math.floor(Math.min(a[2], b[2], c[2])), z1 = Math.floor(Math.max(a[2], b[2], c[2]));
        const d = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]);
        if (Math.abs(d) < 1e-9) continue;  // vertical
        for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
            const px = x + 0.5, pz = z + 0.5;
            const l1 = ((b[2] - c[2]) * (px - c[0]) + (c[0] - b[0]) * (pz - c[2])) / d, l2 = ((c[2] - a[2]) * (px - c[0]) + (a[0] - c[0]) * (pz - c[2])) / d, l3 = 1 - l1 - l2;
            if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
            const y = l1 * a[1] + l2 * b[1] + l3 * c[1];
            const k = `${x},${z}`;
            if (!(out.get(k)! >= y)) out.set(k, y);
        }
    }
    return out;
}

/**
 * A modelled volume as one closed surface: Google's volumes carry each triangle twice (both windings, drawn double-sided);
 * of a triangle repeated on the same three corners the copy facing away from the volume's centre is kept.
 */
export function singleSided(m: MassingMesh): MassingMesh {
    const V = m.vertices;
    const key = (i: number) => V[i].map(c => Math.round(c * 1e5)).join(',');
    const c = [0, 0, 0];
    for (const v of V) for (let k = 0; k < 3; k++) c[k] += v[k] / Math.max(1, V.length);
    const best = new Map<string, { tri: [number, number, number]; out: number }>();
    for (let t = 0; t + 2 < m.indices.length; t += 3) {
        const tri: [number, number, number] = [m.indices[t], m.indices[t + 1], m.indices[t + 2]];
        const [a, b, d] = tri.map(i => V[i]);
        const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
        const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
        const ctr = [(a[0] + b[0] + d[0]) / 3 - c[0], (a[1] + b[1] + d[1]) / 3 - c[1], (a[2] + b[2] + d[2]) / 3 - c[2]];
        const out = n[0] * ctr[0] + n[1] * ctr[1] + n[2] * ctr[2];
        const k = tri.map(key).sort().join('|');
        const cur = best.get(k);
        if (!cur || out > cur.out) best.set(k, { tri, out });
    }
    return { ...m, indices: [...best.values()].flatMap(x => x.tri) };
}

// ------------------------------------------------------------------------------------------------
// the massing
// ------------------------------------------------------------------------------------------------

export function buildMassing(inp: MassingInputs): Massing {
    const notes: string[] = [];
    const parts: MassingPart[] = [];
    const meshes: MassingMesh[] = [];
    const solar = inp.solar ?? [];
    const solarReport = { segments: solar.length, inside: 0, pitchedKept: 0, pitchedRejected: 0, flatUsed: 0 };
    const usedSolar = new Set<number>();
    for (const b of inp.buildings) {
        // the modelled volume, where Google has one, is the massing as given
        for (const [vi, v] of (b.volumes ?? []).entries()) {
            if (v.vertices.length < 4 || v.indices.length < 12) continue;
            meshes.push(singleSided({ id: `${b.id}/v${vi}`, vertices: v.vertices.map(([x, h, z]) => [x, inp.groundY + h, z]), indices: v.indices.slice() }));
        }
        const extruded = (b.extruded ?? []).filter(p => !(p.planOnly && (b.volumes?.length ?? 0) > 0));
        for (const [pi, p] of extruded.entries()) {
            const loops = p.loops.map(l => simplifyRing(l)).filter(l => l.length >= 3 && Math.abs(ringArea(l)) >= 1);
            if (!loops.length) continue;
            const id = `${b.id}/e${pi}`;
            const baseY = inp.groundY + (p.minHeightM ?? 0);
            const samples = samplesIn(loops);
            const tops = samples.map(([x, z]) => inp.scanTop(x, z)).filter(Number.isFinite);
            const scanY = tops.length >= 4 ? median(tops) : undefined;
            const vectorY = p.heightM !== undefined ? inp.groundY + p.heightM : undefined;
            // Solar facets inside the part
            const inside = solar.map((s, k) => ({ s, k })).filter(({ s }) => inLoops(s.x, s.z, loops));
            solarReport.inside += inside.length;
            const flat = inside.filter(({ s }) => s.pitchDeg < MIN_PITCHED_DEG);
            const flatArea = flat.reduce((a, { s }) => a + s.areaM2, 0);
            let solarY: number | undefined;
            if (flat.length) {
                // area-weighted median of the flat facets' heights
                const sorted = [...flat].sort((u, v) => u.s.y - v.s.y);
                let acc = 0;
                for (const { s } of sorted) { acc += s.areaM2; if (acc >= flatArea / 2) { solarY = s.y; break; } }
            }
            const agree = (y: number | undefined) => y !== undefined && scanY !== undefined && Math.abs(y - scanY) <= HEIGHT_AGREEMENT_M;
            let topY: number, heightSource: MassingPart['heightSource'];
            if (agree(solarY)) { topY = solarY!; heightSource = 'solar'; solarReport.flatUsed += flat.length; flat.forEach(f => usedSolar.add(f.k)); }
            else if (agree(vectorY)) { topY = vectorY!; heightSource = 'vector'; }
            else if (scanY !== undefined) {
                topY = scanY; heightSource = 'scan';
                notes.push(`part ${id}: height from the scan (${(scanY - inp.groundY).toFixed(1)} m); vector ${vectorY !== undefined ? (vectorY - inp.groundY).toFixed(1) + ' m' : 'none'}, Solar ${solarY !== undefined ? (solarY - inp.groundY).toFixed(1) + ' m' : 'none'} disagreed by more than ${HEIGHT_AGREEMENT_M} m`);
            } else if (vectorY !== undefined) { topY = vectorY; heightSource = 'vector'; }
            else if (solarY !== undefined) { topY = solarY; heightSource = 'solar'; }
            else { notes.push(`part ${id}: no height from the vector data, Solar or the scan; left out`); continue; }
            const part: MassingPart = { id, baseY, topY, loops, planes: [], heightSource, heights: { ...(vectorY !== undefined ? { vectorY } : {}), ...(solarY !== undefined ? { solarY } : {}), ...(scanY !== undefined ? { scanY } : {}) } };
            // pitched facets: kept one by one (largest first) while each lowers the roof's error against the scan
            const pitched = inside.filter(({ s }) => s.pitchDeg >= MIN_PITCHED_DEG).sort((u, v) => v.s.areaM2 - u.s.areaM2);
            if (pitched.length) {
                const pts = samples.filter(([x, z]) => Number.isFinite(inp.scanTop(x, z)));
                const ridge = quantile(pts.map(([x, z]) => inp.scanTop(x, z)), 0.97);
                const capped = { ...part, topY: Number.isFinite(ridge) ? Math.max(ridge, part.topY) : part.topY };
                const err = (q: Pick<MassingPart, 'topY' | 'baseY' | 'planes'>) => median(pts.map(([x, z]) => Math.abs(roofAt(q, x, z) - inp.scanTop(x, z))));
                let cur = err(part);
                for (const { s, k } of pitched) {
                    const trial = { ...capped, planes: [...capped.planes, solarPlane(s)] };
                    const e = err(trial);
                    if (e < cur * 0.95 && e < 1.5) { capped.planes = trial.planes; cur = e; solarReport.pitchedKept++; usedSolar.add(k); }
                    else solarReport.pitchedRejected++;
                }
                if (capped.planes.length) { part.planes = capped.planes; part.topY = capped.topY; }
            }
            parts.push(part);
        }
    }
    // the check against the scan
    const massingTop = new Map<string, number>();
    for (const p of parts) {
        for (const [x, z] of samplesIn(p.loops)) {
            const k = `${Math.floor(x)},${Math.floor(z)}`;
            massingTop.set(k, Math.max(massingTop.get(k) ?? -Infinity, roofAt(p, x, z)));
        }
    }
    for (const m of meshes) for (const [k, y] of meshTopCells(m)) massingTop.set(k, Math.max(massingTop.get(k) ?? -Infinity, y));
    let inter = 0;
    const errs: number[] = [];
    const heights: number[] = [];
    for (const k of massingTop.keys()) {
        if (!inp.cells.has(k)) continue;
        inter++;
        const [x, z] = k.split(',').map(Number);
        const top = inp.scanTop(x + 0.5, z + 0.5);
        if (Number.isFinite(top)) { errs.push(Math.abs(massingTop.get(k)! - top)); heights.push(top - inp.groundY); }
    }
    const union = massingTop.size + inp.cells.size - inter;
    const iou = union ? inter / union : 0;
    const hMed = median(errs), hP90 = quantile(errs, 0.9);
    const limit = Math.max(MAX_HEIGHT_ERROR_M, MAX_HEIGHT_ERROR_SHARE * (Number.isFinite(median(heights)) ? median(heights) : 0));
    const r2 = (v: number) => Math.round(v * 100) / 100;
    let reason: string | undefined;
    if (!massingTop.size) reason = 'the vector data hold no extruded part or modelled volume for the building';
    else if (iou < MIN_MASSING_IOU) reason = `the massing's plan agrees with the scan's structure on ${r2(iou)} (intersection over union; at least ${MIN_MASSING_IOU} needed)`;
    else if (!(hMed <= limit)) reason = `the massing's roof is ${r2(hMed)} m off the scan's (median; at most ${r2(limit)} m allowed)`;
    return {
        parts, meshes, notes,
        solar: solarReport,
        check: { iou: r2(iou), heightErrMedianM: r2(hMed), heightErrP90M: r2(hP90), massingCells: massingTop.size, scanCells: inp.cells.size, ok: !reason, ...(reason ? { reason } : {}) }
    };
}

// ------------------------------------------------------------------------------------------------
// the native spec
// ------------------------------------------------------------------------------------------------

export interface SweepItem { id: string; confidence: number; provenance: string; profile: Array<[number, number]>; faces: string[] }
export interface OpeningItem { id: string; face: string; s0: number; s1: number; t0: number; t1: number; depth: number; scanned: boolean; confidence: number; provenance: string }
/**
 * A profile swept along one axis of a face's own frame (scratchbox_staged_massing.hpp FaceSweepSpec): axis 0 along s with the
 * profile in (offset, t), 1 along t with it in (offset, s); offset(c) >= 0 at increasing c; each placement [a0, a1, dc]
 * sweeps it from a0 to a1 with c shifted by dc, capped.
 */
export interface FaceSweepItem { id: string; confidence: number; provenance: string; face: string; axis: 0 | 1; profile: Array<[number, number]>; placements: Array<[number, number, number]> }

const tok = (s: string) => s.replace(/\s+/g, '_') || '_';
const n6 = (v: number) => (Number.isFinite(v) ? Number(v.toFixed(6)).toString() : '0');

/** The spec text scripts/staged_massing.cpp reads (scratchbox_staged_massing.hpp readSpec). */
export function massingSpecText(m: Pick<Massing, 'parts' | 'meshes'>, opts: {
    outDir: string; tile?: string; isolate?: string; params?: Record<string, number>;
    sweeps?: SweepItem[]; openings?: OpeningItem[]; faceSweeps?: FaceSweepItem[]; provenance?: string;
}): string {
    const L: string[] = ['# scratchbox staged massing spec v1'];
    if (opts.tile) L.push(`tile ${opts.tile}`);
    if (opts.isolate) L.push(`isolate ${opts.isolate}`);
    L.push(`out ${opts.outDir}`);
    for (const [k, v] of Object.entries(opts.params ?? {})) L.push(`param ${k} ${n6(v)}`);
    const prov = tok(opts.provenance ?? 'massing');
    for (const p of m.parts) {
        L.push(`part ${tok(p.id)} ${n6(p.baseY)} ${n6(p.topY)} ${p.provenance ? tok(p.provenance) : prov}`);
        for (const l of p.loops) L.push(`loop ${l.length} ${l.map(([x, z]) => `${n6(x)} ${n6(z)}`).join(' ')}`);
        for (const pl of p.planes) L.push(`plane ${n6(pl.a)} ${n6(pl.b)} ${n6(pl.c)} ${tok(pl.tag)}`);
    }
    for (const mesh of m.meshes) {
        L.push(`mesh ${tok(mesh.id)} ${mesh.vertices.length} ${mesh.indices.length / 3} ${prov}`);
        for (const [x, y, z] of mesh.vertices) L.push(`v ${n6(x)} ${n6(y)} ${n6(z)}`);
        for (let i = 0; i + 2 < mesh.indices.length; i += 3) L.push(`t ${mesh.indices[i]} ${mesh.indices[i + 1]} ${mesh.indices[i + 2]}`);
    }
    for (const s of opts.sweeps ?? []) L.push(`sweep ${tok(s.id)} ${n6(s.confidence)} ${tok(s.provenance)} ${s.profile.length} ${s.profile.map(([o, y]) => `${n6(o)} ${n6(y)}`).join(' ')} ${s.faces.length} ${s.faces.map(tok).join(' ')}`);
    for (const w of opts.faceSweeps ?? []) L.push(`facesweep ${tok(w.id)} ${n6(w.confidence)} ${tok(w.provenance)} ${tok(w.face)} ${w.axis} ${w.profile.length} ${w.profile.map(([o, c]) => `${n6(o)} ${n6(c)}`).join(' ')} ${w.placements.length} ${w.placements.map(q => q.map(n6).join(' ')).join(' ')}`);
    for (const o of opts.openings ?? []) L.push(`opening ${tok(o.id)} ${tok(o.face)} ${n6(o.s0)} ${n6(o.s1)} ${n6(o.t0)} ${n6(o.t1)} ${n6(o.depth)} ${o.scanned ? 1 : 0} ${n6(o.confidence)} ${tok(o.provenance)}`);
    return L.join('\n') + '\n';
}
