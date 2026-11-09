/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Street objects, step 1 (find): the district residual audit's clusters (district-residual-audit.ts) that stand on the
 * street, each measured as an upright member (its foot, height, plan and plan heading, all from the scan), and grouped
 * into families: members alike in height and plan that repeat along a fitted line at a measured pitch (a bollard row, a
 * line of lamps, planters along a kerb). Every other street object is a family of one.
 *
 * Everything here is measured: positions, heights and plans are the scan's; the pitch is fitted to the members' own spacing
 * (a gap of k pitches is k - 1 members the scan does not have, reported with where they would stand, never added: presence
 * follows the scan). Nothing reads a label or a type code; a family is a row because its members are alike and evenly
 * spaced, whatever they are.
 */

import type { AuditedCluster } from '../residual-audit';

export const STREET_OBJECTS_VERSION = 'street-objects/1';

export type V3 = [number, number, number];
export type V2 = [number, number];

export const STREET_FAMILY_PARAMS = {
    /** A street object stands at most this tall over what supports it, over at most this plan (larger is a building part or a canopy). */
    maxHeightM: 12,
    maxPlanM: 14,
    /** And at least this tall: lower is kerb, paving or a scan ripple. */
    minHeightM: 0.3,
    /** Two members are alike when their heights, and their plan sizes, are within these ratios of each other. */
    heightRatio: 1.4,
    planRatio: 1.8,
    /** Neighbours in a row stand at least / at most this far apart. */
    minPitchM: 0.5,
    maxPitchM: 12,
    /** A member is on its row's line when its centre lies within this of it, plus this share of its larger plan extent. */
    lateralTolM: 0.35,
    lateralPerPlan: 0.25,
    /** A gap within this share of a pitch of k pitches counts as k pitches (k - 1 members missing); otherwise the row ends there. */
    pitchTol: 0.15,
    /** At most this many members missing in one gap. */
    maxMissingRun: 2,
    minMembers: 3,
    /** The row's regularity: 1 - (median absolute deviation of the gaps, each over its number of pitches) / pitch. */
    minRegularity: 0.8
};
export type StreetFamilyParams = typeof STREET_FAMILY_PARAMS;

/** One street object as the scan measures it (tile frame: x east, y up, z south; metres). */
export interface StreetObjectMember {
    clusterId: number;
    /** Set when the photos split the cluster into separate pieces (split.ts): which piece, along the cluster's line. */
    piece?: number;
    /** Where its axis meets what supports it: the plan centre at the support's height. */
    foot: V3;
    /** Its top above the support. */
    heightM: number;
    /** Plan extents along its plan axis and across it. */
    planM: V2;
    /** Its plan axis (the cluster frame's x axis), as a heading clockwise from north, 0..180. */
    planHeadingDeg: number;
    triangles: number;
    /** Radial symmetry of its horizontal slices and their median radius (residual audit), for the profile step. */
    radialSymmetry: number;
    radiusMedianM: number;
    /** Along its row (metres from the row's first member) and off the row's line, when it is in one. */
    alongM?: number;
    lateralM?: number;
}

export interface StreetObjectRow {
    /** The fitted line: a point on it and its unit direction (plan, x and z). */
    origin: V2;
    direction: V2;
    pitchM: number;
    regularity: number;
    lateralRmsM: number;
    lengthM: number;
    /** Where the pitch says a member should stand and the scan has none (each reported, none added). */
    missing: Array<{ alongM: number; at: V2 }>;
}

export interface StreetObjectFamily {
    id: string;
    members: StreetObjectMember[];
    row?: StreetObjectRow;
    /** The members' medians: what one of them measures. */
    heightM: number;
    planM: V2;
    /** Why the members are one family, or why this is a family of one, in words from the numbers. */
    reason: string;
}

export interface StreetFamilies {
    version: string;
    families: StreetObjectFamily[];
    /** Clusters left out, with why. */
    skipped: Array<{ clusterId: number; reason: string }>;
    params: StreetFamilyParams;
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const median = (a: number[]) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN; };

/** The cluster fields a member is measured from. */
export type MemberCluster = Pick<AuditedCluster, 'id' | 'lo' | 'hi' | 'frame' | 'attachment' | 'symmetry' | 'triangles' | 'verdict' | 'slices'>;

/**
 * A cluster as a street object member, or why it is not one. The plan centre is the median centre of its lower slices'
 * circle fits when it is round in plan (the scan's own axis), else its gravity frame's footprint centre; the foot stands
 * on its support (the ground or whatever it rests on, residual audit).
 */
export function memberOf(c: MemberCluster, P: StreetFamilyParams = STREET_FAMILY_PARAMS): StreetObjectMember | { skip: string } {
    if (c.verdict === 'scan-artefact') return { skip: 'a scan artefact' };
    const at = c.attachment;
    const support = Number.isFinite(at.supportY) ? at.supportY : c.lo[1];
    const heightM = c.hi[1] - support;
    const [L, , W] = c.frame.extentsM;
    if (!(heightM >= P.minHeightM)) return { skip: `${r2(heightM)} m tall, under ${P.minHeightM} m` };
    if (heightM > P.maxHeightM) return { skip: `${r2(heightM)} m tall, over ${P.maxHeightM} m: a building part or a canopy` };
    if (Math.max(L, W) > P.maxPlanM) return { skip: `${r2(Math.max(L, W))} m across, over ${P.maxPlanM} m` };
    let cx = c.frame.origin[0], cz = c.frame.origin[2];
    if (c.symmetry.radialSymmetry >= 0.5) {
        const low = c.slices.filter(s => s.r > 0 && s.y <= support + heightM * 0.5);
        if (low.length) { cx = median(low.map(s => s.cx)); cz = median(low.map(s => s.cz)); }
    }
    const ax = c.frame.xAxis;
    let heading = (Math.atan2(ax[0], -ax[2]) * 180) / Math.PI;
    heading = ((heading % 180) + 180) % 180;
    return {
        clusterId: c.id, foot: [r3(cx), r3(support), r3(cz)], heightM: r3(heightM), planM: [r3(L), r3(W)], planHeadingDeg: r2(heading), triangles: c.triangles,
        radialSymmetry: c.symmetry.radialSymmetry, radiusMedianM: c.symmetry.radiusMedianM
    };
}

const alike = (a: StreetObjectMember, b: StreetObjectMember, P: StreetFamilyParams) => {
    const hr = Math.max(a.heightM, b.heightM) / Math.max(1e-3, Math.min(a.heightM, b.heightM));
    const pa = Math.max(a.planM[0], a.planM[1], 0.05), pb = Math.max(b.planM[0], b.planM[1], 0.05);
    return hr <= P.heightRatio && Math.max(pa, pb) / Math.min(pa, pb) <= P.planRatio;
};

/** A least-squares line through plan points: its centroid and unit direction (the principal axis). */
export function fitLine(pts: V2[]): { origin: V2; direction: V2 } {
    const n = pts.length;
    const mx = pts.reduce((s, p) => s + p[0], 0) / n, mz = pts.reduce((s, p) => s + p[1], 0) / n;
    let sxx = 0, sxz = 0, szz = 0;
    for (const p of pts) { const dx = p[0] - mx, dz = p[1] - mz; sxx += dx * dx; sxz += dx * dz; szz += dz * dz; }
    const theta = 0.5 * Math.atan2(2 * sxz, sxx - szz);
    return { origin: [mx, mz], direction: [Math.cos(theta), Math.sin(theta)] };
}

interface RowCandidate { members: StreetObjectMember[]; row: StreetObjectRow }

/**
 * The gaps of members sorted along a line, read as whole numbers of one pitch: the pitch (least squares over the gaps
 * that fit), the number of pitches per gap, and where the run breaks (a gap that is not within pitchTol of a whole
 * number of pitches, or misses more than maxMissingRun members).
 */
export function readPitch(along: number[], P: StreetFamilyParams = STREET_FAMILY_PARAMS): { pitchM: number; steps: number[]; breaks: number[]; regularity: number } {
    const gaps = along.slice(1).map((a, i) => a - along[i]);
    if (!gaps.length) return { pitchM: NaN, steps: [], breaks: [], regularity: 0 };
    // the pitch: the median of the gaps within the tolerance band above the shortest one that is not too short
    const usable = gaps.filter(g => g >= P.minPitchM);
    if (!usable.length) return { pitchM: NaN, steps: gaps.map(() => 0), breaks: gaps.map((_, i) => i), regularity: 0 };
    const shortest = Math.min(...usable);
    let pitch = median(usable.filter(g => g <= shortest * (1 + 2 * P.pitchTol)));
    const stepOf = (g: number) => {
        const k = Math.round(g / pitch);
        return k >= 1 && k <= P.maxMissingRun + 1 && Math.abs(g - k * pitch) <= P.pitchTol * pitch ? k : 0;
    };
    let steps = gaps.map(stepOf);
    const fit = gaps.map((g, i) => ({ g, k: steps[i] })).filter(x => x.k > 0);
    if (fit.length) {
        pitch = fit.reduce((s, x) => s + x.g, 0) / fit.reduce((s, x) => s + x.k, 0);
        steps = gaps.map(stepOf);
    }
    const breaks = steps.map((k, i) => (k ? -1 : i)).filter(i => i >= 0);
    const per = gaps.map((g, i) => (steps[i] ? g / steps[i] : NaN)).filter(Number.isFinite);
    const mad = median(per.map(x => Math.abs(x - pitch)));
    const regularity = per.length >= 2 && pitch > 0 ? Math.max(0, 1 - mad / pitch) : 0;
    return { pitchM: pitch, steps, breaks, regularity };
}

/** The best row seeded by member i (the longest evenly spaced run of alike members on a line through it and a neighbour). */
function bestRowFrom(i: number, pool: StreetObjectMember[], P: StreetFamilyParams): RowCandidate | undefined {
    const a = pool[i];
    let best: RowCandidate | undefined;
    for (let j = 0; j < pool.length; j++) {
        if (j === i) continue;
        const b = pool[j];
        const d = Math.hypot(b.foot[0] - a.foot[0], b.foot[2] - a.foot[2]);
        if (d < P.minPitchM || d > P.maxPitchM || !alike(a, b, P)) continue;
        const dir: V2 = [(b.foot[0] - a.foot[0]) / d, (b.foot[2] - a.foot[2]) / d];
        // every alike member near the line through a and b
        const near = pool.filter(m => {
            if (!alike(a, m, P)) return false;
            const px = m.foot[0] - a.foot[0], pz = m.foot[2] - a.foot[2];
            const lat = Math.abs(px * dir[1] - pz * dir[0]);
            return lat <= P.lateralTolM + P.lateralPerPlan * Math.max(m.planM[0], m.planM[1]);
        });
        if (near.length < P.minMembers) continue;
        const line = fitLine(near.map(m => [m.foot[0], m.foot[2]] as V2));
        const along = (m: StreetObjectMember) => (m.foot[0] - line.origin[0]) * line.direction[0] + (m.foot[2] - line.origin[1]) * line.direction[1];
        const sorted = near.slice().sort((p, q) => along(p) - along(q));
        const pos = sorted.map(along);
        const pitch = readPitch(pos, P);
        if (!Number.isFinite(pitch.pitchM)) continue;
        // the run through a: from the break before it to the break after it
        const ia = sorted.indexOf(a);
        let lo = ia, hi = ia;
        while (lo > 0 && pitch.steps[lo - 1] > 0) lo--;
        while (hi < sorted.length - 1 && pitch.steps[hi] > 0) hi++;
        const run = sorted.slice(lo, hi + 1);
        if (run.length < P.minMembers) continue;
        const runPos = pos.slice(lo, hi + 1);
        const rp = readPitch(runPos, P);
        if (!(rp.regularity >= P.minRegularity) || rp.breaks.length) continue;
        const fitted = fitLine(run.map(m => [m.foot[0], m.foot[2]] as V2));
        const al = (m: StreetObjectMember) => (m.foot[0] - fitted.origin[0]) * fitted.direction[0] + (m.foot[2] - fitted.origin[1]) * fitted.direction[1];
        const la = (m: StreetObjectMember) => (m.foot[0] - fitted.origin[0]) * fitted.direction[1] - (m.foot[2] - fitted.origin[1]) * fitted.direction[0];
        const ordered = run.slice().sort((p, q) => al(p) - al(q));
        const a0 = al(ordered[0]);
        const steps = readPitch(ordered.map(al), P);
        const missing: StreetObjectRow['missing'] = [];
        ordered.forEach((m, k) => {
            if (k === ordered.length - 1) return;
            for (let s = 1; s < steps.steps[k]; s++) {
                const t = al(m) + s * steps.pitchM;
                missing.push({ alongM: r2(t - a0), at: [r2(fitted.origin[0] + fitted.direction[0] * t), r2(fitted.origin[1] + fitted.direction[1] * t)] });
            }
        });
        const lats = ordered.map(la);
        const row: StreetObjectRow = {
            origin: [r3(fitted.origin[0] + fitted.direction[0] * a0), r3(fitted.origin[1] + fitted.direction[1] * a0)], direction: [r3(fitted.direction[0]), r3(fitted.direction[1])],
            pitchM: r3(steps.pitchM), regularity: r3(steps.regularity), lateralRmsM: r3(Math.sqrt(lats.reduce((s, v) => s + v * v, 0) / lats.length)),
            lengthM: r2(al(ordered[ordered.length - 1]) - a0), missing
        };
        const cand: RowCandidate = { members: ordered.map(m => ({ ...m, alongM: r2(al(m) - a0), lateralM: r3(la(m)) })), row };
        const better = !best || cand.members.length > best.members.length || (cand.members.length === best.members.length && cand.row.regularity > best.row.regularity);
        if (better) best = cand;
    }
    return best;
}

/**
 * The street objects of a district audit, in families: rows first (the longest, then the most regular, taken greedily and
 * their members removed), then every other street object on its own.
 */
export function streetObjectFamilies(clusters: MemberCluster[], P: StreetFamilyParams = STREET_FAMILY_PARAMS): StreetFamilies {
    const skipped: StreetFamilies['skipped'] = [];
    let pool: StreetObjectMember[] = [];
    for (const c of clusters) {
        const m = memberOf(c, P);
        if ('skip' in m) skipped.push({ clusterId: c.id, reason: m.skip });
        else pool.push(m);
    }
    const families: StreetObjectFamily[] = [];
    for (;;) {
        let best: RowCandidate | undefined;
        for (let i = 0; i < pool.length; i++) {
            const c = bestRowFrom(i, pool, P);
            if (c && (!best || c.members.length > best.members.length || (c.members.length === best.members.length && c.row.regularity > best.row.regularity))) best = c;
        }
        if (!best) break;
        const ids = new Set(best.members.map(m => m.clusterId));
        pool = pool.filter(m => !ids.has(m.clusterId));
        const h = median(best.members.map(m => m.heightM)), pl: V2 = [r3(median(best.members.map(m => m.planM[0]))), r3(median(best.members.map(m => m.planM[1])))];
        const r = best.row;
        families.push({
            id: `row/${best.members.map(m => m.clusterId).sort((x, y) => x - y)[0]}`, members: best.members, row: r, heightM: r3(h), planM: pl,
            reason: `${best.members.length} alike members (heights within ${P.heightRatio}x, plans within ${P.planRatio}x) on a line over ${r.lengthM} m at a pitch of ${r.pitchM} m (regularity ${r.regularity}, ${Math.round(r.lateralRmsM * 100)} cm off the line RMS)${r.missing.length ? `; ${r.missing.length} place${r.missing.length === 1 ? '' : 's'} on the pitch the scan has nothing at` : ''}`
        });
    }
    for (const m of pool) families.push({ id: `one/${m.clusterId}`, members: [m], heightM: m.heightM, planM: m.planM, reason: 'no alike member repeats beside it at a steady pitch' });
    return { version: STREET_OBJECTS_VERSION, families, skipped, params: P };
}
