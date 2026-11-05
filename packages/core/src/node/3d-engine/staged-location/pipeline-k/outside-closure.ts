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
 *  0. Shards: scan pieces left floating once the walls they hung from were rebuilt or clipped (small, touching no wall,
 *     roof, fill or the ground) are dropped; the core then shows where they hung.
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
import { accessorLayout, assembleGlb, nodeWorldMatrices, parseGlbBytes, readAccessor, transformPoint } from '../glb-bytes';
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
    restoreMarginM: 0.3,
    /** Shards: a scan piece (edge-connected) under this area (m²) touching no other surface, nor the ground, within shardContactM (m) floats: it goes. */
    shardMaxM2: 40, shardContactM: 0.05
};
export type OutsideClosureParams = typeof OUTSIDE_CLOSURE_PARAMS;

/** The outside check, as the closure reports it. */
export interface HolesSummary { holeShare: number; maxViewHoleShare: number; worstView: string; largestHoleRegionM2: number; regions: number; holesFlagged: boolean; why: string }

export interface ClosureRound { round: number; regions: number; restoredTriangles: number; restoredAreaM2: number; coreRegions: number; jointsWidened: number; before: HolesSummary; after: HolesSummary; kept: boolean }

export interface OutsideClosureReport {
    version: string;
    /** Floating scan pieces dropped: how many, their triangles and area (m²). */
    shards?: { pieces: number; triangles: number; areaM2: number };
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

const isScanNode = (n: any) => n?.mesh !== undefined && !Object.keys(n.extras ?? {}).some(k => k.startsWith('sb'));

/**
 * Scan pieces that float: edge-connected scan triangles (nodes no later step made) under shardMaxM2 whose every corner is
 * further than shardContactM from any other surface and from the ground. Returned as triangle keys (corners rounded to 1 mm).
 */
export function findShards(bytes: Uint8Array, groundY: number | undefined, P: OutsideClosureParams = OUTSIDE_CLOSURE_PARAMS): { keys: Set<string>; pieces: number; triangles: number; areaM2: number } {
    const g = parseGlbBytes(bytes), names = (g.json.nodes ?? []).map((n: any) => n);
    const soup = readSoup(g);
    const k3 = (x: number, y: number, z: number) => `${Math.round(x * 1000)},${Math.round(y * 1000)},${Math.round(z * 1000)}`;
    const nT = soup.node.length, scan = new Uint8Array(nT);
    for (let t = 0; t < nT; t++) scan[t] = isScanNode(names[soup.node[t]]) ? 1 : 0;
    // edge-connected pieces of the scan
    const parent = Int32Array.from({ length: nT }, (_, i) => i);
    const find = (a: number): number => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
    const edgeOwner = new Map<string, number>();
    const corner = (t: number, k: number) => k3(soup.pos[t * 9 + k * 3], soup.pos[t * 9 + k * 3 + 1], soup.pos[t * 9 + k * 3 + 2]);
    for (let t = 0; t < nT; t++) {
        if (!scan[t]) continue;
        const c = [corner(t, 0), corner(t, 1), corner(t, 2)];
        for (let k = 0; k < 3; k++) {
            const a = c[k], b = c[(k + 1) % 3], e = a < b ? `${a}|${b}` : `${b}|${a}`;
            const o = edgeOwner.get(e);
            if (o === undefined) edgeOwner.set(e, t); else parent[find(t)] = find(o);
        }
    }
    const area = new Map<number, number>(), members = new Map<number, number[]>();
    for (let t = 0; t < nT; t++) {
        if (!scan[t]) continue;
        const p = soup.pos.subarray(t * 9, t * 9 + 9), e1 = [p[3] - p[0], p[4] - p[1], p[5] - p[2]], e2 = [p[6] - p[0], p[7] - p[1], p[8] - p[2]];
        const r = find(t);
        area.set(r, (area.get(r) ?? 0) + Math.hypot(e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]) / 2);
        (members.get(r) ?? members.set(r, []).get(r)!).push(t);
    }
    const small = [...area].filter(([, a]) => a < P.shardMaxM2).map(([r]) => r);
    const out = { keys: new Set<string>(), pieces: 0, triangles: 0, areaM2: 0 };
    if (!small.length) return out;
    // every triangle in a 1 m grid, for what lies near a piece's corners
    const C = 1, grid = new Map<string, number[]>();
    for (let t = 0; t < nT; t++) {
        const p = soup.pos.subarray(t * 9, t * 9 + 9);
        const lo = [0, 1, 2].map(k => Math.floor((Math.min(p[k], p[k + 3], p[k + 6]) - P.shardContactM) / C)), hi = [0, 1, 2].map(k => Math.floor((Math.max(p[k], p[k + 3], p[k + 6]) + P.shardContactM) / C));
        if ((hi[0] - lo[0] + 1) * (hi[1] - lo[1] + 1) * (hi[2] - lo[2] + 1) > 2000) continue;
        for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) { const k = `${x},${y},${z}`; const l = grid.get(k); if (l) l.push(t); else grid.set(k, [t]); }
    }
    const near = (q: number[], t: number) => {
        const p = soup.pos.subarray(t * 9, t * 9 + 9), a = [p[0], p[1], p[2]], b = [p[3], p[4], p[5]], c = [p[6], p[7], p[8]];
        const sub = (u: number[], v: number[]) => [u[0] - v[0], u[1] - v[1], u[2] - v[2]], d3 = (u: number[], v: number[]) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
        const ab = sub(b, a), ac = sub(c, a), n = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]], nl = Math.hypot(n[0], n[1], n[2]);
        if (nl > 0) {
            const u = n.map(x => x / nl), dd = d3(sub(q, a), u), r = sub(q, u.map(x => x * dd));
            if (Math.abs(dd) <= P.shardContactM && [[a, b], [b, c], [c, a]].every(([x, y]) => { const cr = sub(y, x), rr = sub(r, x); return d3([cr[1] * rr[2] - cr[2] * rr[1], cr[2] * rr[0] - cr[0] * rr[2], cr[0] * rr[1] - cr[1] * rr[0]], u) >= 0; })) return true;
        }
        for (const [x, y] of [[a, b], [b, c], [c, a]]) { const e = sub(y, x), s = Math.max(0, Math.min(1, d3(sub(q, x), e) / (d3(e, e) || 1))); if (Math.hypot(...sub(q, [x[0] + e[0] * s, x[1] + e[1] * s, x[2] + e[2] * s])) <= P.shardContactM) return true; }
        return false;
    };
    for (const r of small) {
        const list = members.get(r)!, mine = new Set(list);
        let touches = false;
        for (const t of list) {
            for (let k = 0; k < 3 && !touches; k++) {
                const q = [soup.pos[t * 9 + k * 3], soup.pos[t * 9 + k * 3 + 1], soup.pos[t * 9 + k * 3 + 2]];
                if (groundY !== undefined && q[1] - groundY <= P.shardContactM) { touches = true; break; }
                for (const o of grid.get(`${Math.floor(q[0] / C)},${Math.floor(q[1] / C)},${Math.floor(q[2] / C)}`) ?? []) if (!mine.has(o) && near(q, o)) { touches = true; break; }
            }
            if (touches) break;
        }
        if (touches) continue;
        out.pieces++; out.triangles += list.length; out.areaM2 += area.get(r)!;
        for (const t of list) out.keys.add([corner(t, 0), corner(t, 1), corner(t, 2)].sort().join('|'));
    }
    out.areaM2 = Math.round(out.areaM2 * 100) / 100;
    return out;
}

/** The scan's triangles with these keys made degenerate (as the cleanup removes them), in one GLB. */
export function dropTriangles(bytes: Uint8Array, keys: Set<string>): Buffer {
    if (!keys.size) return Buffer.from(bytes);
    const g = parseGlbBytes(Buffer.from(bytes)), json = g.json, world = nodeWorldMatrices(json), dv = new DataView(g.bin.buffer, g.bin.byteOffset, g.bin.byteLength);
    const k3 = (p: number[]) => `${Math.round(p[0] * 1000)},${Math.round(p[1] * 1000)},${Math.round(p[2] * 1000)}`;
    (json.nodes ?? []).forEach((n: any, ni: number) => {
        if (!isScanNode(n)) return;
        for (const p of json.meshes[n.mesh]?.primitives ?? []) {
            if ((p.mode ?? 4) !== 4 || p.attributes?.POSITION === undefined || p.indices === undefined) continue;
            const X = readAccessor(g, p.attributes.POSITION).data, il = accessorLayout(json, p.indices);
            const size = il.componentType === 5125 ? 4 : il.componentType === 5123 ? 2 : 1;
            const rd = (i: number) => size === 4 ? dv.getUint32(il.base + i * il.stride, true) : size === 2 ? dv.getUint16(il.base + i * il.stride, true) : dv.getUint8(il.base + i * il.stride);
            const wr = (i: number, v: number) => { if (size === 4) dv.setUint32(il.base + i * il.stride, v, true); else if (size === 2) dv.setUint16(il.base + i * il.stride, v, true); else dv.setUint8(il.base + i * il.stride, v); };
            for (let t = 0; t + 2 < il.count; t += 3) {
                const v = [rd(t), rd(t + 1), rd(t + 2)];
                const key = v.map(i => k3(transformPoint(world[ni], X[i * 3], X[i * 3 + 1], X[i * 3 + 2]))).sort().join('|');
                if (keys.has(key)) { wr(t + 1, v[0]); wr(t + 2, v[0]); }
            }
        }
    });
    return assembleGlb(json, g.bin);
}

/** The joins, the core and the gate with its repair rounds (see the file's comment). */
export function closeOutside(input: { clay: Uint8Array; tex?: Uint8Array; pre?: { clay: Uint8Array; tex?: Uint8Array }; footprint?: Vec2[][]; groundY?: number; threads?: number; joins?: boolean; core?: boolean; repair?: boolean }, P: OutsideClosureParams = OUTSIDE_CLOSURE_PARAMS): { clay: Buffer; tex?: Buffer; report: OutsideClosureReport } {
    const report: OutsideClosureReport = { version: OUTSIDE_CLOSURE_VERSION, rounds: [], remaining: [], restoredTriangles: 0 };
    const VP = { ...VISIBLE_DEFECTS_PARAMS, holeRegionsReported: P.regionsRead };
    // floating scan pieces go first, from the clay and the textured copy alike (the gate's before is the building as it came)
    const shardKeys = findShards(input.tex ?? input.clay, input.groundY, P);
    report.shards = { pieces: shardKeys.pieces, triangles: shardKeys.triangles, areaM2: shardKeys.areaM2 };
    const measure = (b: Uint8Array) => measureVisibleDefects(b, VP);
    // the gate needs the textured copy: the clay has no inside to show
    const gate = input.repair !== false && !!input.tex;
    if (gate) report.before = holesSummary(measure(input.tex!));
    // one pass of the closure from the input, with what the repair rounds have found so far
    const build = (regions: CoreRegion[], restore: CoreRegion[]) => {
        let clay: Buffer = dropTriangles(input.clay, shardKeys.keys), tex: Buffer | undefined = input.tex ? dropTriangles(input.tex, shardKeys.keys) : undefined;
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
    if (r.shards?.pieces) parts.push(`${r.shards.pieces} floating scan pieces dropped (${r.shards.triangles} triangles, ${r.shards.areaM2} m²: touching no wall, roof, fill or the ground)`);
    if (r.joins) parts.push(describeCornerJoin(r.joins));
    if (r.core) parts.push(describeInnerCore(r.core));
    if (r.before && r.after) {
        const kept = r.rounds.filter(x => x.kept);
        parts.push(`holes seen from outside ${pct(r.before.holeShare)} → ${pct(r.closed?.holeShare ?? r.after.holeShare)} closed → ${pct(r.after.holeShare)} after ${kept.length} repair round${kept.length === 1 ? '' : 's'} (worst view ${pct(r.before.maxViewHoleShare)} at ${r.before.worstView} → ${pct(r.after.maxViewHoleShare)} at ${r.after.worstView}; ${r.restoredTriangles} scan triangles put back behind rebuilt walls)${r.after.holesFlagged ? `; still over a limit: ${r.after.why}` : ''}`);
    }
    return parts.join('; ');
}
