/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K's outside closure, last in the polish: the finished building closed from outside, then looked at and repaired
 * where it still shows a hole.
 *
 *  1. Joins (corner-join.ts): rebuilt facades that stop short of each other where they meet are joined.
 *  2. The inner core (inner-core.ts): a closed solid behind every surface, so a hole shows a textured face, not the inside.
 *  3. The gate (visible-defects.ts): the building seen from its twelve views. While it shows hole regions of at least
 *     repairMinM2, each region is repaired by what it can trace to, all three tried, each acting only where its own rule
 *     holds, then measured again; a round is kept only when the holes fall by at least minGainShare of them, and at most maxRounds are run:
 *      - the scan put back: scan triangles the polish removed (cleanup kept them; the lattice, clip or base took them)
 *        within the region, only those wholly behind a rebuilt wall (every corner's outward ray meets one within
 *        restoreBehindM), so the measured surface closes the hole from behind and never stands in front of anything;
 *      - the core extended: within the region the core may come closer to the surface (inner-core.ts minInsetM) and
 *        reach where the building's winding number is lower (behind a large opening);
 *      - a joint widened: two facades whose meeting line passes through the region are joined across a wider gap.
 * What is left is reported (the share, the worst view, the largest regions and what each round did); nothing fails here:
 * the orchestrator degrades a build past the hole limits with this report.
 */

import type { Vec2 } from '../../../../common/spatial/staged-location-contracts';
import { parseGlbBytes } from '../glb-bytes';
import { addInnerCore, appendNode, describeInnerCore, readSoup, type AppendPrim, type CoreRegion, type InnerCoreReport } from './inner-core';
import { describeCornerJoin, joinFacadeCorners, type CornerJoinReport } from './corner-join';
import { rayIndex } from './lattice-stitch';
import { outsideFootprint } from './base-cleanup';
import { measureVisibleDefects, VISIBLE_DEFECTS_PARAMS, type HoleRegion, type VisibleDefectsReport } from './visible-defects';

export const OUTSIDE_CLOSURE_VERSION = 'outside-closure/1';

export const OUTSIDE_CLOSURE_PARAMS = {
    /** Repair rounds at most. */
    maxRounds: 2,
    /** A round is kept only when it takes at least this share off the holes (what it adds must earn its place). */
    minGainShare: 0.03,
    /** Hole regions of at least this (m²) are repaired. */
    repairMinM2: 1,
    /** Hole regions read per measurement (largest first, one per place). */
    regionsRead: 64,
    /** A region's repair sphere: half its length plus this (m). */
    regionPadM: 3,
    /** A scan triangle put back must have a rebuilt wall within this (m) in front of each of its corners. */
    restoreBehindM: 2,
    /** ...and lie within the footprint plus this (m), when there is one. */
    restoreMarginM: 0.3
};
export type OutsideClosureParams = typeof OUTSIDE_CLOSURE_PARAMS;

/** The outside check, as the closure reports it. */
export interface HolesSummary { holeShare: number; maxViewHoleShare: number; worstView: string; largestHoleRegionM2: number; regions: number; holesFlagged: boolean; why: string }

export interface ClosureRound { round: number; regions: number; restoredTriangles: number; restoredAreaM2: number; coreRegions: number; jointsWidened: number; before: HolesSummary; after: HolesSummary; kept: boolean }

export interface OutsideClosureReport {
    version: string;
    joins?: CornerJoinReport; core?: InnerCoreReport;
    /** The building as it came (before), after the joins and the core (closed), and as handed on (after). */
    before?: HolesSummary; closed?: HolesSummary; after?: HolesSummary;
    rounds: ClosureRound[];
    /** The largest hole regions left, with what the last round could do about them. */
    remaining: HoleRegion[];
    restoredTriangles: number;
}

export function holesSummary(r: VisibleDefectsReport): HolesSummary {
    const worst = r.views.reduce((a, v) => (v.holeShare > a.holeShare ? v : a), r.views[0]);
    return { holeShare: r.holeShare, maxViewHoleShare: r.maxViewHoleShare, worstView: worst ? `${worst.azimuthDeg}°/${worst.elevationDeg}°` : '-', largestHoleRegionM2: r.largestHoleRegionM2, regions: r.holeRegions.length, holesFlagged: r.holesFlagged, why: r.why.slice(Math.max(0, r.why.indexOf('% through holes') - 5)) };
}

/**
 * The scan triangles of `pre` (the polish's input, cleaned) that `cur` no longer has, within the regions and behind a rebuilt
 * wall at every corner, appended to the clay and textured copies (ScanRestored, labelled measured: the scan's own surface).
 */
export function restoreScan(cur: { clay: Uint8Array; tex?: Uint8Array }, pre: { clay: Uint8Array; tex?: Uint8Array }, regions: CoreRegion[], footprint: Vec2[][] | undefined, P: OutsideClosureParams = OUTSIDE_CLOSURE_PARAMS): { clay: Buffer; tex?: Buffer; triangles: number; areaM2: number } {
    const curSoup = readSoup(parseGlbBytes(cur.tex ?? cur.clay)), preSoup = readSoup(parseGlbBytes(pre.tex ?? pre.clay));
    const key = (p: ArrayLike<number>, o: number) => [0, 1, 2].map(k => `${Math.round(p[o + k * 3] * 1000)},${Math.round(p[o + k * 3 + 1] * 1000)},${Math.round(p[o + k * 3 + 2] * 1000)}`).sort().join('|');
    const have = new Set<string>();
    for (let t = 0; t < curSoup.node.length; t++) have.add(key(curSoup.pos, t * 9));
    // the rebuilt walls, for what stands in front of a triangle
    const wPos: number[][] = [], wTris: number[][] = [];
    for (let t = 0; t < curSoup.node.length; t++) if (curSoup.wall[t]) { const b = wPos.length; for (let k = 0; k < 3; k++) wPos.push([curSoup.pos[t * 9 + k * 3], curSoup.pos[t * 9 + k * 3 + 1], curSoup.pos[t * 9 + k * 3 + 2]]); wTris.push([b, b + 1, b + 2]); }
    const empty = { clay: Buffer.from(cur.clay), ...(cur.tex ? { tex: Buffer.from(cur.tex) } : {}), triangles: 0, areaM2: 0 };
    if (!wTris.length || !regions.length) return empty;
    const ray = rayIndex(wPos, wTris);
    const picked: number[] = [];
    let area = 0;
    for (let t = 0; t < preSoup.node.length; t++) {
        if (preSoup.wall[t]) continue;
        const p = preSoup.pos.subarray(t * 9, t * 9 + 9), c = [(p[0] + p[3] + p[6]) / 3, (p[1] + p[4] + p[7]) / 3, (p[2] + p[5] + p[8]) / 3];
        if (!regions.some(g => Math.hypot(c[0] - g.c[0], c[1] - g.c[1], c[2] - g.c[2]) <= g.r)) continue;
        if (have.has(key(preSoup.pos, t * 9))) continue;
        if (footprint?.length && outsideFootprint(c[0], c[2], footprint) > P.restoreMarginM) continue;
        const e1 = [p[3] - p[0], p[4] - p[1], p[5] - p[2]], e2 = [p[6] - p[0], p[7] - p[1], p[8] - p[2]];
        const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]], nl = Math.hypot(n[0], n[1], n[2]);
        if (!(nl > 1e-9)) continue;
        const d = n.map(x => x / nl);
        // every corner (pulled a little toward the middle) and the middle: a rebuilt wall in front of it
        const pts = [c, ...[0, 3, 6].map(o => [0, 1, 2].map(k => p[o + k] * 0.9 + c[k] * 0.1))];
        if (!pts.every(q => ray([q[0] + d[0] * 0.01, q[1] + d[1] * 0.01, q[2] + d[2] * 0.01], d, P.restoreBehindM))) continue;
        picked.push(t);
        area += nl / 2;
    }
    if (!picked.length) return empty;
    const extras = { sbScanRestored: { version: OUTSIDE_CLOSURE_VERSION, provenance: { label: 'measured', method: "the scan's own triangles put back where the building showed a hole from outside: only those the polish had removed, within the hole's region and wholly behind a rebuilt wall (each corner's outward ray meets one), so they close it from behind" }, triangles: picked.length } };
    const flat = (list: number[]) => { const a = new Float32Array(list.length * 9); list.forEach((t, i) => a.set(preSoup.pos.subarray(t * 9, t * 9 + 9), i * 9)); return a; };
    const clay = appendNode(cur.clay, [{ positions: flat(picked), material: { name: 'ScanRestored', pbrMetallicRoughness: { baseColorFactor: [0.55, 0.53, 0.5, 1], metallicFactor: 0, roughnessFactor: 0.9 }, doubleSided: true } }], 'ScanRestored', extras);
    let tex: Buffer | undefined;
    if (cur.tex) {
        const byMat = new Map<number, number[]>();
        for (const t of picked) { const m = preSoup.kind[t] ? preSoup.material[t] : -1; const l = byMat.get(m); if (l) l.push(t); else byMat.set(m, [t]); }
        const prims: AppendPrim[] = [...byMat].map(([m, list]) => {
            if (m < 0) return { positions: flat(list), material: { name: 'ScanRestored', pbrMetallicRoughness: { baseColorFactor: [0.55, 0.53, 0.5, 1], metallicFactor: 0, roughnessFactor: 0.9 }, doubleSided: true } };
            const uv = new Float32Array(list.length * 6);
            list.forEach((t, i) => uv.set(preSoup.uv.subarray(t * 6, t * 6 + 6), i * 6));
            return { positions: flat(list), uv, material: m };
        });
        tex = appendNode(cur.tex, prims, 'ScanRestored', extras);
    }
    return { clay, ...(tex ? { tex } : {}), triangles: picked.length, areaM2: Math.round(area * 100) / 100 };
}

/** The joins, the core and the gate with its repair rounds (see the file's comment). */
export function closeOutside(input: { clay: Uint8Array; tex?: Uint8Array; pre?: { clay: Uint8Array; tex?: Uint8Array }; footprint?: Vec2[][]; groundY?: number; threads?: number; joins?: boolean; core?: boolean; repair?: boolean }, P: OutsideClosureParams = OUTSIDE_CLOSURE_PARAMS): { clay: Buffer; tex?: Buffer; report: OutsideClosureReport } {
    const report: OutsideClosureReport = { version: OUTSIDE_CLOSURE_VERSION, rounds: [], remaining: [], restoredTriangles: 0 };
    const VP = { ...VISIBLE_DEFECTS_PARAMS, holeRegionsReported: P.regionsRead };
    const measure = (b: Uint8Array) => measureVisibleDefects(b, VP);
    // the gate needs the textured copy: the clay has no inside to show
    const gate = input.repair !== false && !!input.tex;
    if (gate) report.before = holesSummary(measure(input.tex!));
    // one pass of the closure from the input, with what the repair rounds have found so far
    const build = (regions: CoreRegion[], restore: CoreRegion[]) => {
        let clay: Buffer = Buffer.from(input.clay), tex: Buffer | undefined = input.tex ? Buffer.from(input.tex) : undefined;
        let joins: CornerJoinReport | undefined, core: InnerCoreReport | undefined, restored = { triangles: 0, areaM2: 0 };
        if (input.joins !== false) { const j = joinFacadeCorners(clay, tex ? [tex] : [], undefined, { regions }); clay = j.clay; tex = j.others[0]; joins = j.report; }
        if (restore.length && input.pre) { const r = restoreScan({ clay, ...(tex ? { tex } : {}) }, input.pre, restore, input.footprint, P); clay = r.clay; tex = r.tex ?? tex; restored = r; }
        if (input.core !== false) { const c = addInnerCore(clay, tex ? [tex] : [], { ...(input.footprint ? { footprint: input.footprint } : {}), ...(input.groundY !== undefined ? { groundY: input.groundY } : {}), regions, ...(input.threads ? { threads: input.threads } : {}) }); clay = c.clay; tex = c.others[0]; core = c.report; }
        return { clay, tex, joins, core, restored };
    };
    let best = build([], []);
    report.joins = best.joins; report.core = best.core;
    if (!gate) return { clay: best.clay, ...(best.tex ? { tex: best.tex } : {}), report };
    let seen = measure(best.tex!);
    report.closed = holesSummary(seen);
    const regions: CoreRegion[] = [];
    for (let round = 1; round <= P.maxRounds; round++) {
        const found = seen.holeRegions.filter(g => g.areaM2 >= P.repairMinM2);
        if (!found.length) break;
        const before = holesSummary(seen);
        const next = [...regions, ...found.map(g => ({ c: g.center, r: g.lengthM / 2 + P.regionPadM }))];
        const tried = build(next, next);
        const after = measure(tried.tex!);
        const kept = after.holeShare < seen.holeShare * (1 - P.minGainShare);
        report.rounds.push({ round, regions: found.length, restoredTriangles: tried.restored.triangles, restoredAreaM2: tried.restored.areaM2, coreRegions: next.length, jointsWidened: tried.joins?.joints.filter(j => j.repair).length ?? 0, before, after: holesSummary(after), kept });
        if (!kept) break;
        best = tried; seen = after; regions.splice(0, regions.length, ...next);
        report.joins = tried.joins; report.core = tried.core; report.restoredTriangles = tried.restored.triangles;
    }
    report.after = holesSummary(seen);
    report.remaining = seen.holeRegions.slice(0, VISIBLE_DEFECTS_PARAMS.holeRegionsReported);
    return { clay: best.clay, ...(best.tex ? { tex: best.tex } : {}), report };
}

const pct = (x: number) => `${(x * 100).toFixed(2)}%`;

/** One line for the build's notes. */
export function describeOutsideClosure(r: OutsideClosureReport): string {
    const parts: string[] = [];
    if (r.joins) parts.push(describeCornerJoin(r.joins));
    if (r.core) parts.push(describeInnerCore(r.core));
    if (r.before && r.after) {
        const kept = r.rounds.filter(x => x.kept);
        parts.push(`holes seen from outside ${pct(r.before.holeShare)} → ${pct(r.closed?.holeShare ?? r.after.holeShare)} closed → ${pct(r.after.holeShare)} after ${kept.length} repair round${kept.length === 1 ? '' : 's'} (worst view ${pct(r.before.maxViewHoleShare)} at ${r.before.worstView} → ${pct(r.after.maxViewHoleShare)} at ${r.after.worstView}; ${r.restoredTriangles} scan triangles put back behind rebuilt walls)${r.after.holesFlagged ? `; still over a limit: ${r.after.why}` : ''}`);
    }
    return parts.join('; ');
}
