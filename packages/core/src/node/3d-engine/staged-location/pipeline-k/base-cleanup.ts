/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K's base cleanup: the stray scan around the bottom of an isolated building taken away by its footprint (the
 * Google vector footprint, else the scan's own outline), and the base closed where that leaves the wall short of the ground.
 *
 *  1. Pieces: the remesh's triangles welded by position into connected pieces.
 *  2. Strays: a piece that is not the building (the largest piece standing over the footprint), lies almost wholly outside
 *     the footprint plus the projection allowance, and stays low (sidewalk patches, kerbs, street furniture, a neighbour's
 *     scraps) is removed.
 *  3. Apron: the building's own triangles low down (within apronHeightM of the ground) and outside the footprint by more
 *     than apronMarginM are removed (ground at grade when any corner stands outside by groundMarginM), the sidewalk the isolate's ground apron kept
 *     attached. Nothing higher is cut from the
 *     building (canopies, cornices, a wing the footprint misses stay).
 *  3a. Grade: the street itself (surfaces facing up within gradeBandM of the ground) goes everywhere; the scene's own ground
 *     stands in for it, so no strip of sidewalk with a cut edge stays along the base.
 *  3b. Wall line: walking inward from each footprint edge to where the building's walls stand gives the edge's inset; the
 *     ground (low, facing up) between the footprint edge and that wall line is trimmed too, so a footprint drawn wider
 *     than the walls keeps no sidewalk strip.
 *  4. Skirt: along each edge's wall line, where the lowest kept surface within skirtSearchM of the edge stands more than
 *     skirtMinGapM above the ground, a strip from the ground up to it closes the base (labelled generated). Where no
 *     surface stands near the edge at all, nothing is added by the skirt: it only closes a short gap.
 *  5. Party wall: along each edge's wall line the building is looked at from outside (cells of partyCellM along the edge and
 *     up); a cell whose first surface is the back of one (the inside of the building: the scan has no outer wall there,
 *     typically a wall shared with a neighbour, removed with it) is closed by a generated wall on the wall line, in spans of
 *     at least partyMinSpanM, above the skirt and no higher than the building stands at the line (partyReachM). A real wall set back behind the line shows its front and is left as it is.
 *
 * When the footprint does not fit the building above the apron (more than footprintMisfit of that area outside it), it is
 * not used at all: nothing is removed, trimmed or added, and the report says why.
 *
 * The clay and its textured twin get the same edits: triangles removed by their centres (the twin's are the same
 * triangles split by photo), the skirt appended to both (clay in the twin: it has no photo).
 */

import type { Vec2 } from '../../../../common/spatial/staged-location-contracts';
import { FOOTPRINT_MAX_PROJECTION_M } from '../footprint-lock';
import { accessorLayout, assembleGlb, parseGlbBytes, readAccessor } from '../glb-bytes';

export const BASE_CLEANUP_VERSION = 'base-cleanup/5';

export const BASE_CLEANUP_PARAMS = {
    /** Vertices closer than this weld into one (m). */
    weldM: 0.01,
    /** A piece is stray when at least this share of its area lies outside the footprint plus allowanceM, and its top is below strayMaxHeightM. */
    strayOutsideShare: 0.9, strayMaxHeightM: 8, allowanceM: FOOTPRINT_MAX_PROJECTION_M,
    /** The apron: the building's triangles below this height above the ground and outside the footprint by more than this margin (m). */
    apronHeightM: 3, apronMarginM: 0.3,
    /** Ground at grade (within groundBandM, facing up) goes when any corner stands this far outside the footprint (m): a scan-noise margin only. */
    groundMarginM: 0.05,
    /**
     * Ground at grade: surfaces within gradeBandM of the ground facing up (normal y at least gradeNy) are the street, not the
     * building; they go everywhere (the scene's own ground stands in), so no strip of sidewalk with a cut edge stays along
     * the base. Steps, plinths and terraces above the band stay.
     */
    gradeBandM: 0.6, gradeNy: 0.85,
    /** No apron is trimmed when more than this share of the building above the apron stands outside the footprint plus allowanceM. */
    footprintMisfit: 0.2,
    /**
     * The wall line: along each footprint edge, the building's walls (vertical surfaces wallMinM..wallMaxM up) found by walking
     * inward from the edge (every wallStepM, up to maxInsetM); an edge's inset is the median where a wall was found (on at
     * least wallFoundShare of its samples). Ground (surfaces within groundBandM of the ground, facing up more than groundNy)
     * between the footprint edge and its wall line is trimmed too: a footprint drawn a little wider than the walls keeps no
     * sidewalk strip.
     */
    wallMinM: 1, wallMaxM: 8, wallStepM: 1, maxInsetM: 4, wallFoundShare: 0.3, groundBandM: 1.5, groundNy: 0.5,
    /** Skirt: sampled along each footprint edge every step (m); a surface within search (m) of the edge; closed when its lowest point stands more than minGap above the ground, up to maxGap. */
    skirtStepM: 0.5, skirtSearchM: 0.6, skirtMinGapM: 0.3, skirtMaxGapM: 6,
    /** Party wall: the cell (m) the edge is looked at in, from outside; a missing span shorter than partyMinSpanM (m) is left. */
    partyCellM: 0.5, partyMinSpanM: 1,
    /** Party wall: never higher than the building stands at the wall line (its highest surface within this (m) inside it). */
    partyReachM: 1.5
};
export type BaseCleanupParams = typeof BASE_CLEANUP_PARAMS;

export interface BaseCleanupReport {
    pieces: number; strayPieces: number; strayTriangles: number; strayAreaM2: number;
    apronTriangles: number; apronAreaM2: number; apronSkipped?: string;
    /** Ground between the footprint edge and the measured wall line, trimmed; and the edges' insets (m). */
    groundTriangles: number; groundAreaM2: number; insetsM: number[];
    /** Ground at grade (the street) taken out everywhere. */
    gradeTriangles: number; gradeAreaM2: number;
    /** Share of the building above the apron that stands outside the footprint plus allowance (the footprint's fit). */
    misfitShare: number;
    skirt: { segments: number; areaM2: number; edgesClosed: number };
    /** Where the scan has no outer wall on the footprint's wall line (the inside shows): closed by a generated wall. */
    partyWall: { areaM2: number; edges: number };
}

const dist2Seg = (px: number, pz: number, a: Vec2, b: Vec2) => {
    const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (pz - a[1]) * dz) / l2)) : 0;
    return Math.hypot(px - a[0] - t * dx, pz - a[1] - t * dz);
};

/** How far a plan point stands outside the footprint (0 inside any loop). */
export function outsideFootprint(x: number, z: number, loops: Vec2[][]): number {
    let inside = false, best = Infinity;
    for (const loop of loops) {
        let inLoop = false;
        for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
            const a = loop[i], b = loop[j];
            if ((a[1] > z) !== (b[1] > z) && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) inLoop = !inLoop;
            best = Math.min(best, dist2Seg(x, z, a, b));
        }
        if (inLoop) inside = true;
    }
    return inside ? 0 : best;
}

interface Tri { prim: number; t: number; a: number[]; b: number[]; c: number[]; area: number }

function triangles(bytes: Uint8Array): { glb: ReturnType<typeof parseGlbBytes>; tris: Tri[]; prims: Array<{ I: ArrayLike<number>; base: number; stride: number; size: number }> } {
    const glb = parseGlbBytes(bytes);
    const tris: Tri[] = [], prims: Array<{ I: ArrayLike<number>; base: number; stride: number; size: number }> = [];
    for (const m of glb.json.meshes ?? []) for (const p of m.primitives ?? []) {
        if ((p.mode ?? 4) !== 4 || p.attributes?.POSITION === undefined || p.indices === undefined) continue;
        const P = readAccessor(glb, p.attributes.POSITION).data, I = readAccessor(glb, p.indices).data;
        const li = accessorLayout(glb.json, p.indices);
        const pi = prims.length;
        prims.push({ I, base: li.base, stride: li.stride, size: li.componentType === 5125 ? 4 : li.componentType === 5123 ? 2 : 1 });
        for (let t = 0; t + 2 < I.length; t += 3) {
            if (I[t] === I[t + 1] || I[t + 1] === I[t + 2] || I[t] === I[t + 2]) continue;
            const v = (k: number) => [P[I[t + k] * 3], P[I[t + k] * 3 + 1], P[I[t + k] * 3 + 2]];
            const a = v(0), b = v(1), c = v(2);
            const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], wx = c[0] - a[0], wy = c[1] - a[1], wz = c[2] - a[2];
            tris.push({ prim: pi, t, a, b, c, area: 0.5 * Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx) });
        }
    }
    return { glb, tris, prims };
}

const centreKey = (t: Tri) => `${Math.round(((t.a[0] + t.b[0] + t.c[0]) / 3) * 1000)},${Math.round(((t.a[1] + t.b[1] + t.c[1]) / 3) * 1000)},${Math.round(((t.a[2] + t.b[2] + t.c[2]) / 3) * 1000)}`;

/** Decides, on the clay, which triangles go (by centre key) and where the skirt stands. */
function decide(tris: Tri[], loops: Vec2[][], groundY: number, P: BaseCleanupParams): { remove: Set<string>; skirt: number[][]; party: number[][]; report: BaseCleanupReport } {
    const n = tris.length;
    // 1. pieces: union-find over welded vertices
    const parent = new Int32Array(n).map((_, i) => i);
    const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    const owner = new Map<string, number>();
    const q = (v: number[]) => `${Math.round(v[0] / P.weldM)},${Math.round(v[1] / P.weldM)},${Math.round(v[2] / P.weldM)}`;
    tris.forEach((t, i) => { for (const v of [t.a, t.b, t.c]) { const k = q(v), o = owner.get(k); if (o === undefined) owner.set(k, i); else { const ra = find(i), rb = find(o); if (ra !== rb) parent[ra] = rb; } } });
    const out = tris.map(t => outsideFootprint((t.a[0] + t.b[0] + t.c[0]) / 3, (t.a[2] + t.b[2] + t.c[2]) / 3, loops));
    const height = tris.map(t => (t.a[1] + t.b[1] + t.c[1]) / 3 - groundY);
    const pieces = new Map<number, { area: number; outside: number; inside: number; top: number; tris: number[] }>();
    tris.forEach((t, i) => {
        const r = find(i);
        let p = pieces.get(r); if (!p) pieces.set(r, (p = { area: 0, outside: 0, inside: 0, top: -Infinity, tris: [] }));
        p.area += t.area; p.tris.push(i);
        if (out[i] > P.allowanceM) p.outside += t.area;
        if (out[i] === 0) p.inside += t.area;
        p.top = Math.max(p.top, t.a[1] - groundY, t.b[1] - groundY, t.c[1] - groundY);
    });
    // the building: the piece with the most area over the footprint
    let main = -1, mainInside = -1;
    for (const [r, p] of pieces) if (p.inside > mainInside) { mainInside = p.inside; main = r; }
    const remove = new Set<string>();
    const report: BaseCleanupReport = { pieces: pieces.size, strayPieces: 0, strayTriangles: 0, strayAreaM2: 0, apronTriangles: 0, apronAreaM2: 0, groundTriangles: 0, groundAreaM2: 0, insetsM: [], gradeTriangles: 0, gradeAreaM2: 0, misfitShare: 0, skirt: { segments: 0, areaM2: 0, edgesClosed: 0 }, partyWall: { areaM2: 0, edges: 0 } };
    // the footprint's fit: the share of the building above the apron standing outside it (plus the allowance); a footprint
    // that does not fit the scan is not used for anything (no stray removed, no apron trimmed, no skirt)
    let above = 0, aboveOut = 0;
    for (const i of pieces.get(main)?.tris ?? []) if (height[i] >= P.apronHeightM) { above += tris[i].area; if (out[i] > P.allowanceM) aboveOut += tris[i].area; }
    report.misfitShare = above > 0 ? +(aboveOut / above).toFixed(3) : 1;
    if (!(mainInside > 0) || report.misfitShare > P.footprintMisfit) {
        report.apronSkipped = `${Math.round(report.misfitShare * 100)}% of the building above ${P.apronHeightM} m stands outside its footprint (plus ${P.allowanceM} m): the footprint does not fit the scan, so nothing is cleaned by it`;
        return { remove, skirt: [], party: [], report };
    }
    // 2. strays
    for (const [r, p] of pieces) {
        if (r === main || !(p.outside >= P.strayOutsideShare * p.area) || !(p.top < P.strayMaxHeightM)) continue;
        report.strayPieces++; report.strayTriangles += p.tris.length; report.strayAreaM2 += p.area;
        for (const i of p.tris) remove.add(centreKey(tris[i]));
    }
    // 3. the apron
    for (const [r, p] of pieces) {
        if (r !== main && remove.has(centreKey(tris[p.tris[0]]))) continue;
        for (const i of p.tris) {
            const t = tris[i];
            let cut = height[i] < P.apronHeightM && out[i] > P.apronMarginM;
            // low down, a triangle goes when any corner stands outside the margin (ground facing up: any corner past the noise
            // margin): a large triangle whose centre is just inside would otherwise leave a sawtooth of sidewalk along the base
            if (!cut && height[i] < P.groundBandM) {
                const reach = Math.max(...[t.a, t.b, t.c].map(v => outsideFootprint(v[0], v[2], loops)));
                // a wall's foot flaring out into the sidewalk goes past the margin; a wall standing on the edge stays within it
                if (reach > P.apronMarginM) cut = true;
                else if (reach > P.groundMarginM) {
                    const ux = t.b[0] - t.a[0], uy = t.b[1] - t.a[1], uz = t.b[2] - t.a[2], vx = t.c[0] - t.a[0], vy = t.c[1] - t.a[1], vz = t.c[2] - t.a[2];
                    const ny = uz * vx - ux * vz, nl = Math.hypot(uy * vz - uz * vy, ny, ux * vy - uy * vx);
                    cut = nl > 0 && Math.abs(ny / nl) >= P.groundNy;
                }
            }
            if (!cut && height[i] < P.gradeBandM) {
                const ux = t.b[0] - t.a[0], uy = t.b[1] - t.a[1], uz = t.b[2] - t.a[2], vx = t.c[0] - t.a[0], vy = t.c[1] - t.a[1], vz = t.c[2] - t.a[2];
                const ny = uz * vx - ux * vz, nl = Math.hypot(uy * vz - uz * vy, ny, ux * vy - uy * vx);
                if (nl > 0 && ny / nl >= P.gradeNy) { remove.add(centreKey(t)); report.gradeTriangles++; report.gradeAreaM2 += t.area; continue; }
            }
            if (cut) { remove.add(centreKey(t)); report.apronTriangles++; report.apronAreaM2 += t.area; }
        }
    }
    // the wall line: the building's walls found walking inward from each footprint edge
    const wallCell = 0.25, walls = new Set<string>();
    for (const i of pieces.get(main)!.tris) {
        const t = tris[i];
        const ux = t.b[0] - t.a[0], uy = t.b[1] - t.a[1], uz = t.b[2] - t.a[2], vx = t.c[0] - t.a[0], vy = t.c[1] - t.a[1], vz = t.c[2] - t.a[2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, nl = Math.hypot(nx, ny, nz);
        if (!(nl > 0) || Math.abs(ny / nl) > 0.3 || height[i] < P.wallMinM || height[i] > P.wallMaxM) continue;
        const steps = Math.min(20, Math.max(1, Math.ceil(Math.max(Math.hypot(ux, uz), Math.hypot(vx, vz)) / wallCell)));
        for (let p = 0; p <= steps; p++) for (let q = 0; p + q <= steps; q++) walls.add(`${Math.floor((t.a[0] + ux * p / steps + vx * q / steps) / wallCell)},${Math.floor((t.a[2] + uz * p / steps + vz * q / steps) / wallCell)}`);
    }
    const edges: Array<{ a: Vec2; b: Vec2; inN: Vec2; inset: number }> = [];
    for (const loop of loops) {
        let area2 = 0;
        for (let i = 0; i < loop.length; i++) { const a = loop[i], b = loop[(i + 1) % loop.length]; area2 += a[0] * b[1] - b[0] * a[1]; }
        for (let i = 0; i < loop.length; i++) {
            const a = loop[i], b = loop[(i + 1) % loop.length], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
            if (!(len > 0)) continue;
            const tx = (b[0] - a[0]) / len, tz = (b[1] - a[1]) / len;
            // inward: the left normal of a counter-clockwise loop (in x, z), the right one otherwise
            const inN: Vec2 = area2 > 0 ? [-tz, tx] : [tz, -tx];
            const found: number[] = [];
            let samples = 0;
            for (let s = P.wallStepM / 2; s < len; s += P.wallStepM) {
                samples++;
                const x0 = a[0] + tx * s, z0 = a[1] + tz * s;
                for (let d = -0.5; d <= P.maxInsetM; d += 0.1) if (walls.has(`${Math.floor((x0 + inN[0] * d) / wallCell)},${Math.floor((z0 + inN[1] * d) / wallCell)}`)) { found.push(Math.max(0, d)); break; }
            }
            const inset = samples && found.length >= P.wallFoundShare * samples ? found.sort((x, y) => x - y)[found.length >> 1] : 0;
            edges.push({ a, b, inN, inset });
        }
    }
    report.insetsM = edges.map(e => +e.inset.toFixed(2));
    // the ground between each footprint edge and its wall line
    for (const [r, p] of pieces) {
        if (r !== main && remove.has(centreKey(tris[p.tris[0]]))) continue;
        for (const i of p.tris) {
            if (height[i] >= P.groundBandM || out[i] > 0) continue;
            const t = tris[i];
            const ux = t.b[0] - t.a[0], uy = t.b[1] - t.a[1], uz = t.b[2] - t.a[2], vx = t.c[0] - t.a[0], vy = t.c[1] - t.a[1], vz = t.c[2] - t.a[2];
            const ny = uz * vx - ux * vz, nl = Math.hypot(uy * vz - uz * vy, ny, ux * vy - uy * vx);
            if (!(nl > 0) || Math.abs(ny / nl) < P.groundNy) continue;
            const cx = (t.a[0] + t.b[0] + t.c[0]) / 3, cz = (t.a[2] + t.b[2] + t.c[2]) / 3;
            let best: { d: number; inset: number } | undefined;
            for (const e of edges) { const d = dist2Seg(cx, cz, e.a, e.b); if (!best || d < best.d) best = { d, inset: e.inset }; }
            if (best && best.inset > P.apronMarginM && best.d < best.inset - P.apronMarginM) { remove.add(centreKey(t)); report.groundTriangles++; report.groundAreaM2 += t.area; }
        }
    }
    // 4. the skirt: the lowest kept surface near each footprint edge sample
    const cell = P.skirtSearchM;
    const grid = new Map<string, number>();
    const put = (x: number, y: number, z: number) => { const k = `${Math.floor(x / cell)},${Math.floor(z / cell)}`; const o = grid.get(k); if (o === undefined || y < o) grid.set(k, y); };
    tris.forEach(t => {
        if (remove.has(centreKey(t))) return;
        const e = Math.max(Math.hypot(t.b[0] - t.a[0], t.b[2] - t.a[2], t.b[1] - t.a[1]), Math.hypot(t.c[0] - t.a[0], t.c[2] - t.a[2], t.c[1] - t.a[1]));
        const steps = Math.min(20, Math.max(1, Math.ceil(e / (cell / 2))));
        for (let p = 0; p <= steps; p++) for (let s = 0; p + s <= steps; s++) {
            const u = p / steps, v = s / steps;
            put(t.a[0] + (t.b[0] - t.a[0]) * u + (t.c[0] - t.a[0]) * v, t.a[1] + (t.b[1] - t.a[1]) * u + (t.c[1] - t.a[1]) * v, t.a[2] + (t.b[2] - t.a[2]) * u + (t.c[2] - t.a[2]) * v);
        }
    });
    const lowestNear = (x: number, z: number) => {
        let best = Infinity;
        const cx = Math.floor(x / cell), cz = Math.floor(z / cell);
        for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) { const y = grid.get(`${cx + dx},${cz + dz}`); if (y !== undefined && y < best) best = y; }
        return best;
    };
    // along each edge's wall line (the footprint edge moved inward by its measured inset)
    const skirt: number[][] = [];
    // per edge, the skirt's top at each sample (ground where it adds none), for the party wall above it
    const skirtTops: number[][] = [];
    {
        for (const e of edges) {
            const tops: number[] = [];
            skirtTops.push(tops);
            const a = e.a, b = e.b, len = Math.hypot(b[0] - a[0], b[1] - a[1]);
            const steps = Math.max(1, Math.ceil(len / P.skirtStepM));
            let closed = false;
            let prev: { x: number; z: number; top: number } | undefined;
            for (let k = 0; k <= steps; k++) {
                const x = a[0] + ((b[0] - a[0]) * k) / steps + e.inN[0] * e.inset, z = a[1] + ((b[1] - a[1]) * k) / steps + e.inN[1] * e.inset;
                const low = lowestNear(x, z), gap = low - groundY;
                const cur = gap > P.skirtMinGapM && gap <= P.skirtMaxGapM ? { x, z, top: low } : undefined;
                tops.push(cur ? low : groundY);
                if (prev && cur) {
                    skirt.push([prev.x, groundY, prev.z, cur.x, groundY, cur.z, cur.x, cur.top, cur.z, prev.x, prev.top, prev.z]);
                    report.skirt.segments++; report.skirt.areaM2 += Math.hypot(cur.x - prev.x, cur.z - prev.z) * 0.5 * (prev.top + cur.top - 2 * groundY);
                    closed = true;
                }
                prev = cur;
            }
            if (closed) report.skirt.edgesClosed++;
        }
    }
    // 5. the party wall: each edge looked at from outside, on its wall line; a cell whose first surface is a back face shows
    // the inside, where the scan has no outer wall
    const party: number[][] = [];
    const kept = tris.filter(t => !remove.has(centreKey(t)));
    const topY = kept.reduce((m, t) => Math.max(m, t.a[1], t.b[1], t.c[1]), groundY);
    edges.forEach((e, ei) => {
        const len = Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]), tx = (e.b[0] - e.a[0]) / len, tz = (e.b[1] - e.a[1]) / len, cs = P.partyCellM;
        const nu = Math.ceil(len / cs), ny = Math.ceil((topY - groundY) / cs);
        if (nu < 1 || ny < 1) return;
        const bestW = new Float32Array(nu * ny).fill(Infinity), front = new Uint8Array(nu * ny);
        // how high the building stands at the wall line, per column: the highest surface within partyReachM inside it
        const standTop = new Float32Array(nu).fill(-Infinity);
        for (const t of kept) {
            const loc = [t.a, t.b, t.c].map(v => { const dx = v[0] - e.a[0], dz = v[2] - e.a[1]; return [dx * tx + dz * tz, v[1], dx * e.inN[0] + dz * e.inN[1]]; });
            if (Math.max(loc[0][2], loc[1][2], loc[2][2]) < e.inset - 0.5) continue;
            const u0 = Math.min(loc[0][0], loc[1][0], loc[2][0]), u1 = Math.max(loc[0][0], loc[1][0], loc[2][0]);
            if (u1 < 0 || u0 > len) continue;
            // a triangle reaching the band inside the wall line raises every column it spans to its top
            if (Math.min(loc[0][2], loc[1][2], loc[2][2]) <= e.inset + P.partyReachM) {
                const top = Math.max(loc[0][1], loc[1][1], loc[2][1]);
                for (let i = Math.max(0, Math.floor(u0 / cs)); i <= Math.min(nu - 1, Math.floor(u1 / cs)); i++) if (top > standTop[i]) standTop[i] = top;
            }
            const area = (loc[1][0] - loc[0][0]) * (loc[2][1] - loc[0][1]) - (loc[2][0] - loc[0][0]) * (loc[1][1] - loc[0][1]);
            if (Math.abs(area) < 1e-9) continue;
            // the triangle's normal against the inward direction: a front face looks out
            const ux = t.b[0] - t.a[0], uy = t.b[1] - t.a[1], uz = t.b[2] - t.a[2], vx = t.c[0] - t.a[0], vy = t.c[1] - t.a[1], vz = t.c[2] - t.a[2];
            const isFront = (uy * vz - uz * vy) * e.inN[0] + (ux * vy - uy * vx) * e.inN[1] < 0;
            const i0 = Math.max(0, Math.ceil(u0 / cs - 0.5)), i1 = Math.min(nu - 1, Math.floor(u1 / cs - 0.5));
            const yl = Math.min(loc[0][1], loc[1][1], loc[2][1]), yh = Math.max(loc[0][1], loc[1][1], loc[2][1]);
            const j0 = Math.max(0, Math.ceil((yl - groundY) / cs - 0.5)), j1 = Math.min(ny - 1, Math.floor((yh - groundY) / cs - 0.5));
            for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
                const pu = (i + 0.5) * cs, py = groundY + (j + 0.5) * cs;
                const w1 = ((pu - loc[0][0]) * (loc[2][1] - loc[0][1]) - (loc[2][0] - loc[0][0]) * (py - loc[0][1])) / area;
                const w2 = ((loc[1][0] - loc[0][0]) * (py - loc[0][1]) - (pu - loc[0][0]) * (loc[1][1] - loc[0][1])) / area;
                if (w1 < 0 || w2 < 0 || w1 + w2 > 1) continue;
                const w = (1 - w1 - w2) * loc[0][2] + w1 * loc[1][2] + w2 * loc[2][2], o = j * nu + i;
                if (w < e.inset - 0.5 || w >= bestW[o]) continue;
                bestW[o] = w; front[o] = isFront ? 1 : 0;
            }
        }
        const tops = skirtTops[ei], steps = Math.max(1, tops.length - 1);
        const at = (u: number, y: number): number[] => [e.a[0] + tx * u + e.inN[0] * e.inset, y, e.a[1] + tz * u + e.inN[1] * e.inset];
        const skirtTop = (i: number) => tops[Math.min(tops.length - 1, Math.round(((i + 0.5) * cs / len) * steps))] ?? groundY;
        const inRange = (i: number, k: number) => { const y = groundY + (k + 0.5) * cs; return y > skirtTop(i) && y < standTop[i]; };
        const open0 = (i: number, k: number) => i >= 0 && i < nu && bestW[k * nu + i] < Infinity && !front[k * nu + i] && inRange(i, k);
        // a single column a sliver kept between two open ones is open too (else the wall would stand in strips)
        const open = (i: number, k: number) => open0(i, k) || (i > 0 && i < nu - 1 && inRange(i, k) && open0(i - 1, k) && open0(i + 1, k));
        let added = false;
        for (let i = 0; i < nu; i++) {
            let j = 0;
            while (j < ny) {
                if (!open(i, j)) { j++; continue; }
                let k = j;
                while (k < ny && open(i, k)) k++;
                if ((k - j) * cs >= P.partyMinSpanM) {
                    const ua = i * cs, ub = Math.min(len, (i + 1) * cs), ya = Math.max(skirtTop(i), groundY + j * cs), yb = Math.min(standTop[i], groundY + k * cs);
                    const A = at(ua, ya), B = at(ub, ya), C = at(ub, yb), D = at(ua, yb);
                    // wound to face out of the building (its normal against the inward direction)
                    const outward = -tz * e.inN[0] + tx * e.inN[1] < 0;
                    party.push(outward ? [...A, ...B, ...C, ...D] : [...B, ...A, ...D, ...C]);
                    report.partyWall.areaM2 += (ub - ua) * (yb - ya); added = true;
                }
                j = k;
            }
        }
        if (added) report.partyWall.edges++;
    });
    report.partyWall.areaM2 = Math.round(report.partyWall.areaM2);
    report.strayAreaM2 = Math.round(report.strayAreaM2); report.apronAreaM2 = Math.round(report.apronAreaM2); report.groundAreaM2 = Math.round(report.groundAreaM2); report.gradeAreaM2 = Math.round(report.gradeAreaM2); report.skirt.areaM2 = Math.round(report.skirt.areaM2);
    return { remove, skirt, party, report };
}

/** A generated closure appended as its own node: quads (four corners each, wound to face out), with its provenance. */
interface Closure { name: string; mesh: string; quads: number[][]; method: string }

/** Applies the decision to one GLB: removed triangles made degenerate, each closure appended as its own node (generated, no photo). */
function apply(bytes: Uint8Array, remove: Set<string>, closures: Closure[], textured: boolean): Buffer {
    const { glb, tris, prims } = triangles(bytes);
    const json = glb.json;
    const dv = new DataView(glb.bin.buffer, glb.bin.byteOffset, glb.bin.byteLength);
    for (const t of tris) {
        if (!remove.has(centreKey(t))) continue;
        const p = prims[t.prim];
        for (const e of [t.t + 1, t.t + 2]) { const o = p.base + e * p.stride; if (p.size === 4) dv.setUint32(o, p.I[t.t], true); else if (p.size === 2) dv.setUint16(o, p.I[t.t], true); else dv.setUint8(o, p.I[t.t]); }
    }
    const used = closures.filter(c => c.quads.length);
    if (!used.length) return assembleGlb(json, glb.bin);
    const align = (n: number) => (n + 3) & ~3;
    const chunks: Uint8Array[] = [glb.bin];
    let len = glb.bin.length;
    json.bufferViews ??= []; json.accessors ??= []; json.meshes ??= []; json.nodes ??= []; json.materials ??= [];
    const view = (arr: Float32Array | Uint32Array, target: number) => { const pad = align(len) - len; if (pad) { chunks.push(new Uint8Array(pad)); len += pad; } json.bufferViews.push({ buffer: 0, byteOffset: len, byteLength: arr.byteLength, target }); chunks.push(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength)); len += arr.byteLength; return json.bufferViews.length - 1; };
    for (const c of used) {
        const pos = new Float32Array(c.quads.length * 12), idx = new Uint32Array(c.quads.length * 6);
        c.quads.forEach((q, s) => { pos.set(q, s * 12); idx.set([s * 4, s * 4 + 1, s * 4 + 2, s * 4, s * 4 + 2, s * 4 + 3], s * 6); });
        const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        for (let v = 0; v < pos.length; v += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], pos[v + k]); max[k] = Math.max(max[k], pos[v + k]); }
        json.accessors.push({ bufferView: view(pos, 34962), componentType: 5126, count: pos.length / 3, type: 'VEC3', min, max });
        json.accessors.push({ bufferView: view(idx, 34963), componentType: 5125, count: idx.length, type: 'SCALAR' });
        // the clay keeps its own first material; the twin gets a plain one (no photo: the twin labels it clay)
        let material = 0;
        if (textured || !json.materials.length) { json.materials.push({ name: c.name, pbrMetallicRoughness: { baseColorFactor: [0.55, 0.53, 0.5, 1], metallicFactor: 0, roughnessFactor: 0.9 }, doubleSided: true }); material = json.materials.length - 1; }
        json.meshes.push({ name: c.mesh, primitives: [{ attributes: { POSITION: json.accessors.length - 2 }, indices: json.accessors.length - 1, material, mode: 4 }] });
        json.nodes.push({ name: c.name, mesh: json.meshes.length - 1, extras: { sbBaseSkirt: { version: BASE_CLEANUP_VERSION, provenance: { label: 'generated', method: c.method } } } });
        json.scenes?.[json.scene ?? 0]?.nodes?.push(json.nodes.length - 1);
    }
    const pad = align(len) - len;
    if (pad) { chunks.push(new Uint8Array(pad)); len += pad; }
    const bin = new Uint8Array(len);
    let o = 0;
    for (const ch of chunks) { bin.set(ch, o); o += ch.length; }
    json.buffers = [{ ...(json.buffers?.[0] ?? {}), byteLength: len }];
    return assembleGlb(json, bin);
}

/** The base of an isolated building cleaned by its footprint (plan loops [x, z] in the tile frame) above the ground at groundY. */
export function cleanBase(clay: Uint8Array, others: Uint8Array[], loops: Vec2[][], groundY: number, P: BaseCleanupParams = BASE_CLEANUP_PARAMS): { clay: Buffer; others: Buffer[]; report: BaseCleanupReport } {
    const usable = loops.filter(l => l.length >= 3);
    const { tris } = triangles(clay);
    if (!usable.length || !tris.length) return { clay: Buffer.from(clay), others: others.map(o => Buffer.from(o)), report: { pieces: 0, strayPieces: 0, strayTriangles: 0, strayAreaM2: 0, apronTriangles: 0, apronAreaM2: 0, groundTriangles: 0, groundAreaM2: 0, insetsM: [], gradeTriangles: 0, gradeAreaM2: 0, misfitShare: 0, apronSkipped: 'no footprint or no triangles', skirt: { segments: 0, areaM2: 0, edgesClosed: 0 }, partyWall: { areaM2: 0, edges: 0 } } };
    const d = decide(tris, usable, groundY, P);
    const closures: Closure[] = [
        { name: 'BaseSkirt', mesh: 'base_skirt', quads: d.skirt, method: 'the base closed from the ground up to the lowest scanned surface along the footprint edge, where the stray apron was taken away' },
        { name: 'PartyWall', mesh: 'party_wall', quads: d.party, method: 'a wall on the footprint\'s wall line where the scan has none (the inside of the building showed from outside: typically a wall shared with a neighbour, removed with it)' }
    ];
    return { clay: apply(clay, d.remove, closures, false), others: others.map(o => apply(o, d.remove, closures, true)), report: d.report };
}
