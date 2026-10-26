/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The roof prior read from Google's modelled 3D volume of a building (vector-footprints.ts VectorBuilding.volumes), for
 * pipeline E's roof decisions when the footprint is massed (the volume is then not the massing: it is coarse and splits walls
 * into slivers, as the Flatiron showed on 2026-10-22, so it never places a wall).
 *
 *   - Planes: the volume's top surface as planes. Its upward-facing triangles (normal y above cos UP_FACING_DEG) that are the
 *     highest surface where they lie are grouped by coplanarity (normals within COPLANAR_NORMAL_DEG, offsets within
 *     COPLANAR_OFFSET_M); each group is one plane y = a + b x + c z with its pitch, the compass direction it falls toward,
 *     its area and the plan polygon(s) its triangles cover (their boundary edges chained).
 *   - Tiers: the volume's distinct top heights over the plan, as detectHeightTiers (massing-spec.ts) finds them from the
 *     scan: its near-flat planes (pitched under MIN_PITCHED_DEG), merged where their heights lie within TIER_MERGE_M, each
 *     with the outer outline of the plan at that height (what rises above it included).
 *
 * The prior is guidance: the scan decides (user decision 2026-10-23, "scan leads; vector and Solar are guidance").
 * reconcileTiers takes a volume tier's clean outline for a scan tier only where the two agree (height within
 * TIER_HEIGHT_TOLERANCE_M, plan overlap at least TIER_MIN_IOU); where they disagree the scan's tiers stand and a note says so.
 * roof-infer.ts decideRoof treats a volume plane as a second source for the reading, and as a candidate of its own, kept
 * only where it lowers the roof's error against the scan. No roof is typed: planes are numbers, tiers are heights and outlines.
 */

import type { Vec2 } from '../../../../common/spatial/staged-location-contracts';
import type { VectorBuilding } from '../vector-footprints';
import { cellsFootprint, inLoops, inRing, MIN_PITCHED_DEG, ringArea, simplifyRing, type HeightTier, type RoofPlaneSpec } from './massing-spec';

/** A triangle faces up when its normal's y exceeds the cosine of this. */
export const UP_FACING_DEG = 60;
export const COPLANAR_NORMAL_DEG = 5;
export const COPLANAR_OFFSET_M = 0.3;
/**
 * A triangle is part of the top surface unless, over most of it (TOP_SAMPLES, barycentric), another upward triangle's plane
 * stands more than this above it: a floor under a roof goes, a roof a tower stands on stays (it is the top round the tower).
 */
export const TOP_SURFACE_BAND_M = 0.25;
const TOP_SAMPLES: Array<[number, number]> = [[1 / 3, 1 / 3], [0.7, 0.15], [0.15, 0.7], [0.15, 0.15], [0.45, 0.45], [0.45, 0.1], [0.1, 0.45]];
/** Planes with less plan area than this are not a roof part (a bevel, a sliver of the modelling). */
export const MIN_PLANE_AREA_M2 = 2;
/** Flat planes whose heights lie within this are one tier. */
export const TIER_MERGE_M = 1.0;
/** A volume tier and a scan tier agree when their heights lie within this and their plans overlap by at least TIER_MIN_IOU. */
export const TIER_HEIGHT_TOLERANCE_M = 1.5;
export const TIER_MIN_IOU = 0.6;
/** A volume outline taken for a tier may stand out of the tier below it by at most this (the modelling's own slack). */
export const TIER_NEST_SLACK_M = 0.5;

export interface VolumeRoofPlane {
    /** y = a + b x + c z, in the tile frame (y absolute). */
    a: number; b: number; c: number;
    pitchDeg: number;
    /** Compass direction the plane falls toward (downslope), degrees clockwise from north (north = -z, east = +x). */
    azimuthDeg: number;
    /** The plane's surface area and its plan area. */
    areaM2: number; planAreaM2: number;
    /** Plane height at the plan centroid of its triangles. */
    centreY: number;
    /** The plan polygons its triangles cover (boundary edges chained, simplified), largest first. */
    loops: Vec2[][];
    /** The 1 m cells ("floor(x),floor(z)") inside its loops (even-odd). */
    cells: string[];
    triangles: number;
}

export interface VolumeTier {
    topY: number;
    /** The outer outline of the plan at this height, what rises above it included (the largest outer loop of its planes). */
    loop?: Vec2[];
    /** The 1 m cells inside the outline. */
    cells: string[];
    planAreaM2: number;
    planes: number;
}

export interface VolumeRoofPrior {
    planes: VolumeRoofPlane[];
    /** Ascending by height. */
    tiers: VolumeTier[];
    /** Triangles read (after the double-sided copies are folded), and those on the top surface. */
    triangles: number; topTriangles: number;
    notes: string[];
}

type V3 = [number, number, number];
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const DEG = 180 / Math.PI;

/** The 1 m cells whose centres lie inside loops (even-odd). */
function cellsInLoops(loops: Vec2[][]): string[] {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const l of loops) for (const [x, z] of l) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    const out: string[] = [];
    if (!Number.isFinite(x0)) return out;
    for (let z = Math.floor(z0); z < z1; z++) for (let x = Math.floor(x0); x < x1; x++) if (inLoops(x + 0.5, z + 0.5, loops)) out.push(`${x},${z}`);
    return out;
}

/** The boundary loops of a set of plan triangles: edges used once, chained head to tail. Each triangle wound positive first. */
function boundaryLoops(tris: Array<[Vec2, Vec2, Vec2]>): Vec2[][] {
    const key = (p: Vec2) => `${Math.round(p[0] * 1000)},${Math.round(p[1] * 1000)}`;
    const count = new Map<string, number>();
    const directed = new Map<string, { from: Vec2; to: Vec2 }>();
    for (const t of tris) {
        const [a, b, c] = ringArea(t) >= 0 ? t : [t[0], t[2], t[1]];
        for (const [p, q] of [[a, b], [b, c], [c, a]] as Array<[Vec2, Vec2]>) {
            const kp = key(p), kq = key(q);
            if (kp === kq) continue;
            const u = kp < kq ? `${kp}|${kq}` : `${kq}|${kp}`;
            count.set(u, (count.get(u) ?? 0) + 1);
            directed.set(`${kp}>${kq}`, { from: p, to: q });
        }
    }
    const next = new Map<string, Array<{ from: Vec2; to: Vec2 }>>();
    for (const [k, e] of directed) {
        const [kp, kq] = k.split('>');
        const u = kp < kq ? `${kp}|${kq}` : `${kq}|${kp}`;
        if ((count.get(u) ?? 0) !== 1) continue;  // shared by two triangles: interior
        if (!next.has(kp)) next.set(kp, []);
        next.get(kp)!.push(e);
    }
    const used = new Set<string>();
    const loops: Vec2[][] = [];
    for (const [start, edges] of next) for (const first of edges) {
        const k0 = `${start}>${key(first.to)}`;
        if (used.has(k0)) continue;
        const ring: Vec2[] = [];
        let e: { from: Vec2; to: Vec2 } | undefined = first;
        let closed = false;
        for (let guard = 0; e && guard < directed.size + 2; guard++) {
            const k = `${key(e.from)}>${key(e.to)}`;
            if (used.has(k)) break;
            used.add(k);
            ring.push(e.from);
            if (key(e.to) === start) { closed = true; break; }
            e = (next.get(key(e.to)) ?? []).find(c => !used.has(`${key(c.from)}>${key(c.to)}`));
        }
        if (closed && ring.length >= 3) {
            const s = simplifyRing(ring);
            if (s.length >= 3 && Math.abs(ringArea(s)) >= 0.5) loops.push(s);
        }
    }
    return loops.sort((p, q) => Math.abs(ringArea(q)) - Math.abs(ringArea(p)));
}

/**
 * The roof prior of a building's modelled volumes (vertices [x, height above base, z], triangles), with `groundY` the base's
 * height in the tile frame. Undefined when the volumes hold no upward surface.
 */
export function volumeRoofPrior(volumes: NonNullable<VectorBuilding['volumes']>, groundY: number): VolumeRoofPrior | undefined {
    const notes: string[] = [];
    // triangles once (Google carries each twice, both windings), with their normals turned up
    type Tri = { p: [V3, V3, V3]; n: V3; c: V3; area: number; planArea: number };
    const tris: Tri[] = [];
    const seen = new Set<string>();
    for (const v of volumes) {
        const V = v.vertices.map(([x, h, z]): V3 => [x, groundY + h, z]);
        const vkey = (i: number) => V[i].map(c => Math.round(c * 1e4)).join(',');
        for (let t = 0; t + 2 < v.indices.length; t += 3) {
            const ia = v.indices[t], ib = v.indices[t + 1], ic = v.indices[t + 2];
            if (!V[ia] || !V[ib] || !V[ic]) continue;
            const k = [vkey(ia), vkey(ib), vkey(ic)].sort().join('|');
            if (seen.has(k)) continue;
            seen.add(k);
            const a = V[ia], b = V[ib], c = V[ic];
            const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
            let n: V3 = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
            const len = Math.hypot(...n);
            if (len < 1e-9) continue;
            n = n.map(x => x / len) as V3;
            if (n[1] < 0) n = n.map(x => -x) as V3;
            tris.push({ p: [a, b, c], n, c: [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3], area: len / 2, planArea: Math.abs(ringArea([[a[0], a[2]], [b[0], b[2]], [c[0], c[2]]])) });
        }
    }
    if (!tris.length) return undefined;
    const up = tris.filter(t => t.n[1] >= Math.cos((UP_FACING_DEG / DEG)) && t.planArea > 1e-6);
    // the top surface: a triangle most of whose sample points lie under another upward triangle's plane is not it
    const planeY = (t: Tri, x: number, z: number) => t.c[1] - (t.n[0] * (x - t.c[0]) + t.n[2] * (z - t.c[2])) / t.n[1];
    const plan = (t: Tri): Vec2[] => [[t.p[0][0], t.p[0][2]], [t.p[1][0], t.p[1][2]], [t.p[2][0], t.p[2][2]]];
    const covered = (t: Tri): number => {
        let n = 0;
        for (const [l1, l2] of TOP_SAMPLES) {
            const l3 = 1 - l1 - l2;
            const q: V3 = [0, 1, 2].map(k => l1 * t.p[0][k] + l2 * t.p[1][k] + l3 * t.p[2][k]) as V3;
            if (up.some(o => o !== t && inRing(q[0], q[2], plan(o)) && planeY(o, q[0], q[2]) > q[1] + TOP_SURFACE_BAND_M)) n++;
        }
        return n;
    };
    const top = up.filter(t => covered(t) * 2 <= TOP_SAMPLES.length);
    if (!top.length) { notes.push(`the modelled volume (${tris.length} triangles) has no upward surface within ${UP_FACING_DEG} deg of level`); return undefined; }
    // groups by coplanarity, largest triangle seeding each
    const cosTol = Math.cos(COPLANAR_NORMAL_DEG / DEG);
    const order = [...top].sort((p, q) => q.area - p.area);
    const grouped = new Set<Tri>();
    const planes: VolumeRoofPlane[] = [];
    for (const seed of order) {
        if (grouped.has(seed)) continue;
        const d0 = seed.n[0] * seed.c[0] + seed.n[1] * seed.c[1] + seed.n[2] * seed.c[2];
        const group = order.filter(t => !grouped.has(t) && t.n[0] * seed.n[0] + t.n[1] * seed.n[1] + t.n[2] * seed.n[2] >= cosTol && Math.abs(seed.n[0] * t.c[0] + seed.n[1] * t.c[1] + seed.n[2] * t.c[2] - d0) <= COPLANAR_OFFSET_M);
        group.forEach(t => grouped.add(t));
        const area = group.reduce((s, t) => s + t.area, 0), planArea = group.reduce((s, t) => s + t.planArea, 0);
        if (planArea < MIN_PLANE_AREA_M2) continue;
        // the plane refit: area-weighted normal and centroid
        let n: V3 = [0, 0, 0];
        const c: V3 = [0, 0, 0];
        for (const t of group) { for (let k = 0; k < 3; k++) { n[k] += t.n[k] * t.area; c[k] += t.c[k] * t.area / area; } }
        const nl = Math.hypot(...n) || 1;
        n = n.map(x => x / nl) as V3;
        const b = -n[0] / n[1], cc = -n[2] / n[1];
        const a = c[1] - b * c[0] - cc * c[2];
        const pitchDeg = Math.acos(Math.min(1, n[1])) * DEG;
        const azimuthDeg = pitchDeg < 0.5 ? 0 : ((Math.atan2(n[0], -n[2]) * DEG) + 360) % 360;
        const loops = boundaryLoops(group.map(t => [[t.p[0][0], t.p[0][2]], [t.p[1][0], t.p[1][2]], [t.p[2][0], t.p[2][2]]] as [Vec2, Vec2, Vec2]));
        planes.push({ a, b, c: cc, pitchDeg: r3(pitchDeg), azimuthDeg: r3(azimuthDeg), areaM2: r3(area), planAreaM2: r3(planArea), centreY: r3(c[1]), loops, cells: cellsInLoops(loops), triangles: group.length });
    }
    planes.sort((p, q) => q.planAreaM2 - p.planAreaM2);
    // tiers: the flat planes by height, merged within TIER_MERGE_M
    const flat = planes.filter(p => p.pitchDeg < MIN_PITCHED_DEG).sort((p, q) => p.centreY - q.centreY);
    const tiers: VolumeTier[] = [];
    for (const p of flat) {
        const last = tiers[tiers.length - 1];
        const members: VolumeRoofPlane[] = last && Math.abs(p.centreY - last.topY) <= TIER_MERGE_M ? (last as VolumeTier & { members: VolumeRoofPlane[] }).members : [];
        members.push(p);
        const planArea = members.reduce((s, m) => s + m.planAreaM2, 0);
        const topY = members.reduce((s, m) => s + m.centreY * m.planAreaM2, 0) / planArea;
        // the outer outline at this height: the largest loop over the members' loops; the cells inside it
        const outer = members.flatMap(m => m.loops).sort((u, v) => Math.abs(ringArea(v)) - Math.abs(ringArea(u)))[0];
        const cells = outer ? cellsInLoops([outer]) : members.flatMap(m => m.cells);
        const tier = { topY: r3(topY), ...(outer ? { loop: outer } : {}), cells: [...new Set(cells)], planAreaM2: r3(planArea), planes: members.length, members } as VolumeTier & { members: VolumeRoofPlane[] };
        if (members.length > 1) tiers[tiers.length - 1] = tier; else tiers.push(tier);
    }
    for (const t of tiers) delete (t as Partial<VolumeTier & { members: unknown }>).members;
    notes.push(`modelled volume: ${tris.length} triangles, ${top.length} on the top surface, ${planes.length} roof planes (${planes.filter(p => p.pitchDeg >= MIN_PITCHED_DEG).length} pitched), ${tiers.length} flat tier${tiers.length === 1 ? '' : 's'} at ${tiers.map(t => (t.topY - groundY).toFixed(1)).join(', ')} m`);
    return { planes, tiers, triangles: tris.length, topTriangles: top.length, notes };
}

/** Intersection over union of two cell sets. */
export function cellsIou(a: Iterable<string>, b: Iterable<string>): number {
    const A = new Set(a), B = new Set(b);
    let inter = 0;
    for (const k of A) if (B.has(k)) inter++;
    const union = A.size + B.size - inter;
    return union ? inter / union : 0;
}

function segDist(p: Vec2, a: Vec2, b: Vec2): number {
    const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz || 1e-12;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2));
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dz));
}
const ringDist = (p: Vec2, ring: Vec2[]) => { let d = Infinity; for (let i = 0; i < ring.length; i++) d = Math.min(d, segDist(p, ring[i], ring[(i + 1) % ring.length])); return d; };

/** A height tier with where its plan came from. */
export type HeightTierWithSource = HeightTier & { planSource?: 'scan-inset' | 'modelled-volume' | (string & {}); note?: string };

/**
 * The scan's tiers reconciled with the volume's: an upper scan tier whose height and plan agree with a volume tier
 * (TIER_HEIGHT_TOLERANCE_M, TIER_MIN_IOU) takes the volume's clean outline as its plan (the scan keeps the height); the
 * lowest tier's plan is the footprint's and is never moved. Where the two disagree the scan's tiers stand, and the notes say
 * what the volume showed. `groundY` is for the notes' heights.
 */
export function reconcileTiers(scanTiers: HeightTier[] | undefined, prior: Pick<VolumeRoofPrior, 'tiers'> | undefined, groundY: number): { tiers: HeightTierWithSource[] | undefined; notes: string[] } {
    const notes: string[] = [];
    if (!prior || !prior.tiers.length) return { tiers: scanTiers, notes };
    const h = (y: number) => (y - groundY).toFixed(1);
    // the volume's upper tiers (its lowest is the whole plan, which the footprint already is)
    const upper = prior.tiers.slice(1);
    if (!scanTiers) {
        if (upper.length) notes.push(`the modelled volume shows ${prior.tiers.length} tiers (tops at ${prior.tiers.map(t => h(t.topY)).join(', ')} m) but the scan's heightfield gives no tier stack (no step, or one the scan does not support where it would stand); the scan wins`);
        return { tiers: scanTiers, notes };
    }
    const out: HeightTierWithSource[] = scanTiers.map(t => ({ ...t, planSource: 'scan-inset' }));
    const matched = new Set<VolumeTier>();
    for (let i = 1; i < out.length; i++) {
        const tier = out[i];
        let best: { vt: VolumeTier; iou: number } | undefined;
        for (const vt of upper) {
            if (matched.has(vt) || !vt.loop || Math.abs(vt.topY - tier.topY) > TIER_HEIGHT_TOLERANCE_M) continue;
            const iou = cellsIou(vt.cells, tier.cells);
            if (iou >= TIER_MIN_IOU && (!best || iou > best.iou)) best = { vt, iou };
        }
        if (!best) continue;
        const below = out[i - 1].loop;
        const loop = best.vt.loop!;
        // the outline must still nest in the tier below (the volume never moves a wall out of the footprint)
        const nests = Math.abs(ringArea(loop)) < Math.abs(ringArea(below)) && loop.every(q => inRing(q[0], q[1], below) || ringDist(q, below) <= TIER_NEST_SLACK_M);
        if (!nests) { notes.push(`tier ${i}: the modelled volume's outline at ${h(best.vt.topY)} m agrees with the scan (IoU ${best.iou.toFixed(2)}) but stands out of the tier below; the scan's inset plan stands`); continue; }
        matched.add(best.vt);
        const note = `plan from the modelled volume's outline at ${h(best.vt.topY)} m (${loop.length} corners, plan IoU with the scan ${best.iou.toFixed(2)}); height from the scan (${h(tier.topY)} m)`;
        out[i] = { ...tier, loop, planSource: 'modelled-volume', note };
        notes.push(`tier ${i}: ${note}`);
    }
    for (const vt of upper) {
        if (matched.has(vt)) continue;
        const nearest = out.slice(1).map(t => ({ t, dh: Math.abs(t.topY - vt.topY), iou: cellsIou(vt.cells, t.cells) })).sort((p, q) => p.dh - q.dh)[0];
        notes.push(`the modelled volume's tier at ${h(vt.topY)} m (${Math.round(vt.planAreaM2)} m2)${nearest ? ` is not the scan's (nearest scan tier ${h(nearest.t.topY)} m, plan IoU ${nearest.iou.toFixed(2)})` : ' has no scan tier'}; the scan wins`);
    }
    return { tiers: out, notes };
}

/** The volume planes lying in a part's plan (most of a plane's cells inside the loops), pitched at least `minPitchDeg`. */
export function volumePlanesIn(prior: Pick<VolumeRoofPrior, 'planes'> | undefined, loops: Vec2[][], minPitchDeg: number): VolumeRoofPlane[] {
    if (!prior) return [];
    return prior.planes.filter(p => {
        if (p.pitchDeg < minPitchDeg || !p.cells.length) return false;
        let inside = 0;
        for (const k of p.cells) { const [x, z] = k.split(',').map(Number); if (inLoops(x + 0.5, z + 0.5, loops)) inside++; }
        return inside >= 0.5 * p.cells.length;
    });
}

/** A volume plane as a massing roof plane. */
export function volumePlaneSpec(p: VolumeRoofPlane): RoofPlaneSpec {
    return { a: p.a, b: p.b, c: p.c, tag: `volume:${p.pitchDeg.toFixed(1)}deg@${p.azimuthDeg.toFixed(0)}` };
}

/** Area-weighted median pitch of planes (NaN for none). */
export function medianPitch(planes: Array<{ pitchDeg: number; areaM2: number }>): number {
    const total = planes.reduce((s, p) => s + p.areaM2, 0);
    if (!(total > 0)) return NaN;
    let acc = 0;
    for (const p of [...planes].sort((u, v) => u.pitchDeg - v.pitchDeg)) { acc += p.areaM2; if (acc >= total / 2) return p.pitchDeg; }
    return NaN;
}

/** The smallest angle between a downslope azimuth and the two directions perpendicular to a ridge (where eave planes fall). */
export function azimuthOffRidge(azimuthDeg: number, ridgeAzimuthDeg: number): number {
    const d = ((azimuthDeg - ridgeAzimuthDeg - 90) % 180 + 360) % 180;  // 0 when perpendicular to the ridge either way
    return Math.min(d, 180 - d);
}
