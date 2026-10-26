/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline G's facades: the walls a footprint's outline makes, grouped into the facades the survey and the reading see.
 * A footprint that traces piers, bays or a sawtooth (The Rookery: about 50 edges per street front, most under 2 m) gives a
 * wall per edge; surveyed one by one, each is a narrow half-seen sliver and its reading a guess. Here each outline loop is
 * simplified to its corners (Douglas-Peucker, FACADE_TOLERANCE_M): the edges between two corners are one facade, given a
 * face of its own (the corners' line, the members' mean plane, their whole height), surveyed and read whole. What is read on
 * it is then laid back onto its member walls, which stay exactly as the footprint gives them: an opening onto the member it
 * mostly lies on, clipped to it; a horizontal profile onto every member facing the same side, each over its own span; a
 * vertical member onto the member holding its centre. Nothing here knows what the building is: it reads outline geometry.
 */

import type { FaceSweepItem, OpeningItem } from '../pipeline-e/massing-spec';
import type { MassingFace } from '../pipeline-e/native-massing';
import type { ProgramItems } from './read';

type V3 = [number, number, number];

/** A corner is where the outline leaves the line between its neighbours by more than this. */
export const FACADE_TOLERANCE_M = 1.2;
/** A facade is grouped from at least this many walls and is at least this long. */
export const FACADE_MIN_MEMBERS = 3;
export const FACADE_MIN_LENGTH_M = 6;
/** An opening goes onto the member it lies on for at least this share of its width (else it is dropped, and said so). */
export const OPENING_MIN_SHARE = 0.6;
/** Members whose direction along the facade is at least this (cosine) take a horizontal profile; a vertical one needs MEMBER_ALIGN. */
export const PROFILE_ALIGN = 0.25;
export const MEMBER_ALIGN = 0.7;
/** Openings are kept this far inside their member's ends. */
const EDGE_MARGIN_M = 0.02;

export interface FacadeGroup { face: MassingFace; members: MassingFace[] }
export interface GroupedFacades {
    /** The faces surveyed and read: each facade's own face, and every wall not in a facade unchanged. */
    surveyFaces: MassingFace[];
    groups: FacadeGroup[];
    /** Member wall key -> its facade's key. */
    groupOf: Map<string, string>;
}

const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const at = (f: Pick<MassingFace, 'origin' | 'axisS' | 'axisT'>, s: number, t: number): V3 => [0, 1, 2].map(k => f.origin[k] + s * f.axisS[k] + t * f.axisT[k]) as V3;

/** The indices of `pts` Douglas-Peucker keeps on a closed loop at tolerance `tol` (x, z). */
export function loopCorners(pts: Array<[number, number]>, tol: number): number[] {
    const n = pts.length;
    if (n <= 3) return pts.map((_, i) => i);
    // split the loop at its two farthest-apart vertices
    let a = 0, b = 0, best = -1;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
        const d = (pts[i][0] - pts[j][0]) ** 2 + (pts[i][1] - pts[j][1]) ** 2;
        if (d > best) { best = d; a = i; b = j; }
    }
    const keep = new Set<number>([a, b]);
    const dp = (i: number, j: number) => {
        // the vertices strictly between i and j going forward round the loop
        const [x0, z0] = pts[i], [x1, z1] = pts[j], L = Math.hypot(x1 - x0, z1 - z0) || 1e-9;
        let far = -1, fd = tol;
        for (let k = (i + 1) % n; k !== j; k = (k + 1) % n) {
            const d = Math.abs((x1 - x0) * (z0 - pts[k][1]) - (x0 - pts[k][0]) * (z1 - z0)) / L;
            if (d > fd) { fd = d; far = k; }
        }
        if (far < 0) return;
        keep.add(far);
        dp(i, far); dp(far, j);
    };
    dp(a, b); dp(b, a);
    return [...keep].sort((x, y) => x - y);
}

/** Groups the walls of each outline loop into facades (see the module comment); walls not grouped are surveyed as they are. */
export function groupFacades(faces: MassingFace[]): GroupedFacades {
    const groups: FacadeGroup[] = [], groupOf = new Map<string, string>(), grouped = new Set<string>();
    const loops = new Map<string, MassingFace[]>();
    for (const f of faces) {
        // only whole edges: a wall split in pieces (key:k) keeps its own survey
        if (f.kind !== 'wall' || f.key.split(':').length !== 4) continue;
        const k = `${f.part}|${f.loop}`;
        loops.set(k, [...(loops.get(k) ?? []), f]);
    }
    for (const walls of loops.values()) {
        walls.sort((x, y) => x.edge - y.edge);
        if (walls.length < FACADE_MIN_MEMBERS) continue;
        const start = (f: MassingFace) => at(f, f.sMin, f.tMin), end = (f: MassingFace) => at(f, f.sMax, f.tMin);
        const pts = walls.map(f => [start(f)[0], start(f)[2]] as [number, number]);
        const corners = loopCorners(pts, FACADE_TOLERANCE_M);
        for (let c = 0; c < corners.length; c++) {
            const i0 = corners[c], i1 = corners[(c + 1) % corners.length];
            const members: MassingFace[] = [];
            for (let k = i0; ; k = (k + 1) % walls.length) { members.push(walls[k]); if ((k + 1) % walls.length === i1) break; }
            const p0 = start(walls[i0]), p1 = end(members[members.length - 1]);
            const len = Math.hypot(p1[0] - p0[0], p1[2] - p0[2]);
            if (members.length < FACADE_MIN_MEMBERS || len < FACADE_MIN_LENGTH_M) continue;
            const d: V3 = [(p1[0] - p0[0]) / len, 0, (p1[2] - p0[2]) / len];
            // outward: the corners' line's normal on the side the members face, then refined to the area-weighted mean normal of
            // the members facing within 30 degrees of it (the front's own direction: a pier at one end tilts the corners' line,
            // and piers' sides are left out rather than trusted to cancel)
            const all = members.reduce((acc, m) => [acc[0] + m.normal[0] * m.area, 0, acc[2] + m.normal[2] * m.area] as V3, [0, 0, 0] as V3);
            let n: V3 = [d[2], 0, -d[0]];
            if (dot(n, all) < 0) n = [-n[0], 0, -n[2]];
            const facing = members.filter(m => dot(m.normal, n) > Math.cos(Math.PI / 6));
            const wn = facing.reduce((acc, m) => [acc[0] + m.normal[0] * m.area, 0, acc[2] + m.normal[2] * m.area] as V3, [0, 0, 0] as V3);
            const wl = Math.hypot(wn[0], wn[2]);
            if (wl > 1e-6) n = [wn[0] / wl, 0, wn[2] / wl];
            // s along the corners' line with t up and s x t = n: s = up x n
            const axisS: V3 = [n[2], 0, -n[0]], axisT: V3 = [0, 1, 0];
            // the plane through the members' mean offset from the corners' line (area-weighted)
            let off = 0, area = 0;
            for (const m of members) { const mid = at(m, (m.sMin + m.sMax) / 2, m.tMin); off += dot([mid[0] - p0[0], 0, mid[2] - p0[2]], n) * m.area; area += m.area; }
            off /= area || 1;
            const origin: V3 = [p0[0] + n[0] * off, 0, p0[2] + n[2] * off];
            let sMin = Infinity, sMax = -Infinity, tMin = Infinity, tMax = -Infinity;
            for (const m of members) for (const s of [m.sMin, m.sMax]) for (const t of [m.tMin, m.tMax]) {
                const p = at(m, s, t), q = [p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]];
                sMin = Math.min(sMin, dot(q, axisS)); sMax = Math.max(sMax, dot(q, axisS)); tMin = Math.min(tMin, dot(q, axisT)); tMax = Math.max(tMax, dot(q, axisT));
            }
            const key = `fg:${members[0].part}:${members[0].loop}:${members[0].edge}`;
            const face: MassingFace = {
                index: -1 - groups.length, key, kind: 'wall', part: members[0].part, loop: members[0].loop, edge: members[0].edge, wall: true,
                normal: n, axisS, axisT, origin, sMin, sMax, tMin, tMax, tBottom: tMin, area: (sMax - sMin) * (tMax - tMin),
                pixel: 0, orthoSMin: sMin, orthoTMax: tMax, width: 0, height: 0, coverage: 0, openings: [], top: []
            };
            groups.push({ face, members });
            for (const m of members) { groupOf.set(m.key, key); grouped.add(m.key); }
        }
    }
    return { surveyFaces: [...faces.filter(f => !grouped.has(f.key)), ...groups.map(g => g.face)], groups, groupOf };
}

/** A member's span along its facade: the facade s of its two ends, and how its own s maps (s_facade = c0 + k * s_member). */
function memberSpan(g: MassingFace, m: MassingFace): { a: number; b: number; c0: number; k: number } {
    const k = dot(m.axisS, g.axisS);
    const c0 = dot([m.origin[0] - g.origin[0], m.origin[1] - g.origin[1], m.origin[2] - g.origin[2]], g.axisS);
    const ea = c0 + k * m.sMin, eb = c0 + k * m.sMax;
    return { a: Math.min(ea, eb), b: Math.max(ea, eb), c0, k };
}
/** A facade t on a member (both have t up: their origins' heights differ at most). */
const tOn = (g: MassingFace, m: MassingFace, t: number) => t + g.origin[1] - m.origin[1];

export interface LaidBack { byMember: Map<string, ProgramItems>; droppedOpenings: string[] }

/**
 * What was read on a facade laid back onto its members (see the module comment). Each member gets its own items (the
 * facade's colours and wall colour); the facade's counts stay with its first member, so totals add up.
 */
export function layBack(group: FacadeGroup, items: ProgramItems): LaidBack {
    const g = group.face;
    const byMember = new Map<string, ProgramItems>();
    const own = (m: MassingFace, first: boolean): ProgramItems => {
        let x = byMember.get(m.key);
        if (!x) {
            x = { openings: [], faceSweeps: [], wallColour: items.wallColour, colours: items.colours, counts: first ? items.counts : { openings: 0, filledOpenings: 0, horizontal: 0, vertical: 0, filledVertical: 0, paned: 0, sills: 0, surrounds: 0 } };
            byMember.set(m.key, x);
        }
        return x;
    };
    group.members.forEach((m, i) => own(m, i === 0));
    const spans = group.members.map(m => ({ m, ...memberSpan(g, m) }));
    const droppedOpenings: string[] = [];
    for (const o of items.openings) {
        // the facing member it lies on most
        let best: (typeof spans)[number] | undefined, bestOv = 0;
        for (const sp of spans) {
            if (sp.k < MEMBER_ALIGN) continue;
            const ov = Math.min(o.s1, sp.b) - Math.max(o.s0, sp.a);
            if (ov > bestOv) { bestOv = ov; best = sp; }
        }
        if (!best || bestOv < OPENING_MIN_SHARE * (o.s1 - o.s0)) { droppedOpenings.push(o.id); continue; }
        const g0 = Math.max(o.s0, best.a + EDGE_MARGIN_M), g1 = Math.min(o.s1, best.b - EDGE_MARGIN_M);
        if (!(g1 > g0)) { droppedOpenings.push(o.id); continue; }
        const m0 = (g0 - best.c0) / best.k, m1 = (g1 - best.c0) / best.k;
        const laid: OpeningItem = { ...o, face: best.m.key, s0: Math.min(m0, m1), s1: Math.max(m0, m1), t0: tOn(g, best.m, o.t0), t1: tOn(g, best.m, o.t1) };
        // an arch narrowed by the clip keeps a rise it can hold
        if (laid.archRiseM) laid.archRiseM = Math.min(laid.archRiseM, (laid.s1 - laid.s0) / 2);
        own(best.m, false).openings.push(laid);
    }
    for (const w of items.faceSweeps) {
        if (w.axis === 0) {
            // a horizontal profile: onto every member facing the facade's side, over its own span
            for (const sp of spans) {
                if (sp.k < PROFILE_ALIGN) continue;
                const placements = w.placements.flatMap(([a0, a1, dc]) => {
                    const g0 = Math.max(a0, sp.a), g1 = Math.min(a1, sp.b);
                    if (!(g1 > g0 + 1e-3)) return [];
                    const m0 = (g0 - sp.c0) / sp.k, m1 = (g1 - sp.c0) / sp.k;
                    return [[Math.min(m0, m1), Math.max(m0, m1), tOn(g, sp.m, dc)] as [number, number, number]];
                });
                if (placements.length) own(sp.m, false).faceSweeps.push({ ...w, face: sp.m.key, placements } as FaceSweepItem);
            }
        } else {
            // a vertical member: onto the facing member holding its centre
            const per = new Map<string, Array<[number, number, number]>>();
            for (const [a0, a1, dc] of w.placements) {
                const sp = spans.find(x => x.k >= MEMBER_ALIGN && dc >= x.a && dc <= x.b);
                if (!sp) continue;
                per.set(sp.m.key, [...(per.get(sp.m.key) ?? []), [tOn(g, sp.m, a0), tOn(g, sp.m, a1), (dc - sp.c0) / sp.k]]);
            }
            for (const [key, placements] of per) own(group.members.find(m => m.key === key)!, false).faceSweeps.push({ ...w, face: key, placements });
        }
    }
    return { byMember, droppedOpenings };
}
