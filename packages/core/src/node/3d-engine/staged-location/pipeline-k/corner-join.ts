/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K's corner joins: two rebuilt facades (FacadeLattice nodes) that meet at a corner of the building, or side by
 * side on one wall, are joined along the edge they share, so no slot stays open between them (a full-height slot shows the
 * building's inside, or the sky, from the street). Each facade's own open outline near the other is read (the edges of its
 * welded surface used by one triangle, upright, within cornerGapM of where the two meet):
 *  - where the two outlines' corners lie within weldM of each other, they are welded: both moved to their midpoint;
 *  - where a facade stops short, a return strip carries it on in its own plane to the line where the two meet (the two
 *    planes' intersection at a corner; on one wall, the vertical plane midway between the two ends), the other facade's
 *    strip meeting it there on the same points, so the joint is closed whatever the two outlines' heights.
 * A strip is drawn only where nothing facing out stands behind it within behindM (no scan or other wall already closing the
 * gap, which it would then stand in front of; the inside of a wall seen through the gap does not count), only on the heights the other facade's outline also reaches, and only where the gap
 * is no wider than cornerGapM. Strips take their facade's straightened photo, its mapping carried on (labelled generated,
 * sbCornerJoin in the node's extras); the clay gets the same strips untextured.
 */

import { assembleGlb, nodeWorldMatrices, parseGlbBytes, readAccessor, accessorLayout, isIdentity, transformPoint, type ParsedGlb } from '../glb-bytes';
import { rayIndex } from './lattice-stitch';
import { appendNode, extendMapping, readSoup, type AppendPrim } from './inner-core';

export const CORNER_JOIN_VERSION = 'corner-join/1';

export const CORNER_JOIN_PARAMS = {
    /** Two facades' outlines this close (m) where they meet are joined (a seam); wider gaps are left (a real setback or a
     *  recess) unless the outside check traced a hole there (regionGapFactor). */
    cornerGapM: 0.5,
    /** Outline corners of the two facades this close (m) are welded to one point. */
    weldM: 0.05,
    /** A facade stopping shorter than this (m) needs no strip. */
    minGapM: 0.01,
    /** An outline edge is upright when its vertical extent is at least this share of its length. */
    uprightMin: 0.7,
    /** Facades facing within this |cos| of each other are side by side on one wall, not at a corner. */
    parallelMin: 0.94,
    /** On one wall: the two facades' planes no further apart than this (m). */
    coplanarM: 0.6,
    /** A strip is left out where any other surface facing out stands behind it within this (m): the gap is then closed already
     *  (a rounded or chamfered scan corner) and the strip would stand in front of it. Probed at the strip's middle and ends. */
    behindM: 3,
    /** Within a repair region (a hole the outside check traced to a joint), gaps up to this many times cornerGapM are joined. */
    regionGapFactor: 6,
    /** The strips' confidence: the facade's photo carried on a short way, generated. */
    confidence: 0.5
};
export type CornerJoinParams = typeof CORNER_JOIN_PARAMS;

export interface CornerJoinReport {
    version: string;
    facades: number; pairs: number; corners: number; sideBySide: number;
    welded: number; strips: number; stripTriangles: number; stripAreaM2: number;
    /** Strip pieces left out because a surface already stands behind them (they would stand in front of it). */
    coveredSegments: number;
    /** Per joint: the two facades and what was done. */
    joints: Array<{ a: string; b: string; kind: 'corner' | 'wall'; welded: number; segments: number; areaM2: number; /** Joined with the wider gap a reported hole allowed. */ repair?: boolean }>;
}

type V3 = [number, number, number];
const sub = (a: ArrayLike<number>, b: ArrayLike<number>): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: ArrayLike<number>, b: ArrayLike<number>): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

interface Wall {
    name: string; node: number;
    /** Welded vertices (world), open outline edges (pairs of welded indices), the outward normal. */
    pos: V3[]; open: Array<[number, number]>; n: V3;
    /** Per open edge, the far corner of the one triangle it belongs to: the facade lies on that side of it. */
    inner: number[];
    lo: V3; hi: V3;
    /** Its largest front-facing triangle in the textured copy: material, corners, uv (to carry its mapping on). */
    front?: { material: number; tri: Float64Array; uv: Float64Array };
}

/** The rebuilt facades of a GLB, welded at 1 mm, with their open outlines. */
function readWalls(g: ParsedGlb, textured?: ParsedGlb): Wall[] {
    const json = g.json, world = nodeWorldMatrices(json), out: Wall[] = [];
    const texSoup = textured ? readSoup(textured, (_, extras) => !extras?.sbFacadeLattice) : undefined;
    const texNodes = textured ? (textured.json.nodes ?? []).map((n: any) => n.name) : [];
    (json.nodes ?? []).forEach((node: any, ni: number) => {
        if (node.mesh === undefined || !node.extras?.sbFacadeLattice) return;
        const m = world[ni];
        const ids = new Map<string, number>(), pos: V3[] = [], tris: number[][] = [];
        const id = (p: V3) => { const k = `${Math.round(p[0] * 1000)},${Math.round(p[1] * 1000)},${Math.round(p[2] * 1000)}`; let i = ids.get(k); if (i === undefined) { i = pos.length; ids.set(k, i); pos.push(p); } return i; };
        let vec: V3 = [0, 0, 0];
        for (const p of json.meshes[node.mesh]?.primitives ?? []) {
            if ((p.mode ?? 4) !== 4 || p.attributes?.POSITION === undefined) continue;
            const X = readAccessor(g, p.attributes.POSITION).data;
            const I = p.indices !== undefined ? readAccessor(g, p.indices).data : Float64Array.from({ length: X.length / 3 }, (_, i) => i);
            for (let t = 0; t + 2 < I.length; t += 3) {
                const f = [0, 1, 2].map(k => id(transformPoint(m, X[I[t + k] * 3], X[I[t + k] * 3 + 1], X[I[t + k] * 3 + 2]) as V3));
                if (f[0] === f[1] || f[1] === f[2] || f[0] === f[2]) continue;
                tris.push(f);
                const c = cross(sub(pos[f[1]], pos[f[0]]), sub(pos[f[2]], pos[f[0]]));
                vec = [vec[0] + c[0], vec[1] + c[1], vec[2] + c[2]];
            }
        }
        if (!tris.length) return;
        const count = new Map<number, number>(), third = new Map<number, number>();
        const ek = (a: number, b: number) => (a < b ? a * 4194304 + b : b * 4194304 + a);
        for (const f of tris) for (let k = 0; k < 3; k++) { const e = ek(f[k], f[(k + 1) % 3]); count.set(e, (count.get(e) ?? 0) + 1); third.set(e, f[(k + 2) % 3]); }
        const open: Array<[number, number]> = [], inner: number[] = [];
        for (const [e, c] of count) if (c % 2 === 1) { open.push([Math.floor(e / 4194304), e % 4194304]); inner.push(third.get(e)!); }
        const lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity];
        for (const p of pos) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
        const n = norm(vec);
        let front: Wall['front'];
        const ti = texNodes.indexOf(node.name);
        if (texSoup && ti >= 0) {
            let best = 0;
            for (let t = 0; t < texSoup.node.length; t++) {
                if (texSoup.node[t] !== ti || texSoup.kind[t] !== 2) continue;
                const P = texSoup.pos.subarray(t * 9, t * 9 + 9), c = cross(sub(P.subarray(3, 6), P.subarray(0, 3)), sub(P.subarray(6, 9), P.subarray(0, 3))), a = Math.hypot(c[0], c[1], c[2]);
                if (a > best && dot(c, n) > 0.98 * a) { best = a; front = { material: texSoup.material[t], tri: Float64Array.from(P), uv: Float64Array.from(texSoup.uv.subarray(t * 6, t * 6 + 6)) }; }
            }
        }
        out.push({ name: node.name ?? `node ${ni}`, node: ni, pos, open, inner, n, lo, hi, ...(front ? { front } : {}) });
    });
    return out;
}

/** The point at height y on both planes (n.p = d), or undefined when they do not cross there. */
function meet(nA: V3, dA: number, nB: V3, dB: number, y: number): V3 | undefined {
    const a = nA[0], b = nA[2], c = nB[0], d = nB[2], det = a * d - b * c;
    if (Math.abs(det) < 1e-6) return undefined;
    const r1 = dA - nA[1] * y, r2 = dB - nB[1] * y;
    return [(r1 * d - b * r2) / det, y, (a * r2 - c * r1) / det];
}

const median = (v: number[]) => { const s = [...v].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

/**
 * One facade's return toward the meeting line: its upright open outline edges within gapM of the line, each with the line's
 * points over its height. `line(y)` gives the meeting point at height y.
 */
function chain(w: Wall, line: (y: number) => V3 | undefined, P: CornerJoinParams): Array<{ a: number; b: number }> {
    const out: Array<{ a: number; b: number }> = [];
    for (const [ei, [i, j]] of w.open.entries()) {
        const p = w.pos[i], q = w.pos[j], e = sub(q, p), l = Math.hypot(e[0], e[1], e[2]);
        if (!(l > 0) || Math.abs(e[1]) < P.uprightMin * l) continue;
        const mp = line(p[1]), mq = line(q[1]);
        if (!mp || !mq) continue;
        // the facade must stop short of the line: the line lies beyond the edge, away from the facade's own triangle
        const ed: V3 = [e[0] / l, e[1] / l, e[2] / l], toIn = sub(w.pos[w.inner[ei]], p), across = sub(toIn, [ed[0] * dot(toIn, ed), ed[1] * dot(toIn, ed), ed[2] * dot(toIn, ed)]);
        if (dot(sub(mp, p), across) >= 0 || dot(sub(mq, q), across) >= 0) continue;
        const dp = Math.hypot(...sub(mp, p)), dq = Math.hypot(...sub(mq, q));
        if (dp > P.cornerGapM || dq > P.cornerGapM) continue;
        // the line must lie along the facade (in its plane, not in front of it or behind it)
        if (Math.abs(dot(sub(mp, p), w.n)) > Math.max(0.3, 0.5 * dp) || Math.abs(dot(sub(mq, q), w.n)) > Math.max(0.3, 0.5 * dq)) continue;
        out.push(p[1] <= q[1] ? { a: i, b: j } : { a: j, b: i });
    }
    // overlapping heights: the edge nearer the line kept
    out.sort((x, y) => w.pos[x.a][1] - w.pos[y.a][1]);
    const kept: Array<{ a: number; b: number }> = [];
    const gap = (s: { a: number; b: number }) => { const m = line((w.pos[s.a][1] + w.pos[s.b][1]) / 2)!; const c = [(w.pos[s.a][0] + w.pos[s.b][0]) / 2, (w.pos[s.a][1] + w.pos[s.b][1]) / 2, (w.pos[s.a][2] + w.pos[s.b][2]) / 2]; return Math.hypot(...sub(m, c)); };
    for (const s of out) {
        const last = kept[kept.length - 1];
        if (last && w.pos[s.a][1] < w.pos[last.b][1] - 1e-6) { if (gap(s) < gap(last)) kept[kept.length - 1] = s; continue; }
        kept.push(s);
    }
    return kept;
}

/** Joins the rebuilt facades at the edges they share: welds and return strips, added to the clay and its textured copies. */
export function joinFacadeCorners(clay: Uint8Array, others: Uint8Array[], P: CornerJoinParams = CORNER_JOIN_PARAMS, opts: { /** Holes the outside check traced here: a joint whose meeting line passes through one takes gaps up to regionGapFactor x cornerGapM. */ regions?: Array<{ c: number[]; r: number }> } = {}): { clay: Buffer; others: Buffer[]; report: CornerJoinReport } {
    const g = parseGlbBytes(others[0] ?? clay);
    const walls = readWalls(g, others[0] ? g : undefined);
    const report: CornerJoinReport = { version: CORNER_JOIN_VERSION, facades: walls.length, pairs: 0, corners: 0, sideBySide: 0, welded: 0, strips: 0, stripTriangles: 0, stripAreaM2: 0, coveredSegments: 0, joints: [] };
    // every other surface, for what stands behind a strip
    const soup = readSoup(g);
    const sPos: number[][] = [], sTris: number[][] = [], sNode: number[] = [];
    for (let t = 0; t < soup.node.length; t++) { const b = sPos.length; for (let k = 0; k < 3; k++) sPos.push([soup.pos[t * 9 + k * 3], soup.pos[t * 9 + k * 3 + 1], soup.pos[t * 9 + k * 3 + 2]]); sTris.push([b, b + 1, b + 2]); sNode.push(soup.node[t]); }
    // welds: per facade, its outline corners moved (world position key -> new position)
    const moves = new Map<string, V3>();
    const key = (p: ArrayLike<number>) => `${Math.round(p[0] * 1000)},${Math.round(p[1] * 1000)},${Math.round(p[2] * 1000)}`;
    // strips: per facade (node index), triangles in world space
    const strips = new Map<number, V3[][]>();
    // the widest gap any joint may take (a reported hole widens its own)
    const reach = P.cornerGapM * (opts.regions?.length ? P.regionGapFactor : 1);
    const pairsSeen: Array<[Wall, Wall, (y: number) => V3 | undefined, (y: number) => V3 | undefined, 'corner' | 'wall']> = [];
    for (let i = 0; i < walls.length; i++) for (let j = i + 1; j < walls.length; j++) {
        const A = walls[i], B = walls[j];
        if ([0, 1, 2].some(k => A.lo[k] > B.hi[k] + reach || B.lo[k] > A.hi[k] + reach)) continue;
        const c = dot(A.n, B.n);
        // each facade's plane where it meets the other: the median depth of its outline within reach of the other
        const near = (w: Wall, o: Wall) => w.open.flatMap(([a, b]) => [a, b]).filter(v => { const p = w.pos[v]; return p[0] > o.lo[0] - reach && p[0] < o.hi[0] + reach && p[2] > o.lo[2] - reach && p[2] < o.hi[2] + reach; });
        const nA = near(A, B), nB = near(B, A);
        if (!nA.length || !nB.length) continue;
        const dA = median(nA.map(v => dot(A.pos[v], A.n))), dB = median(nB.map(v => dot(B.pos[v], B.n)));
        if (Math.abs(c) < P.parallelMin) {
            if (Math.abs(A.n[1]) > 0.3 || Math.abs(B.n[1]) > 0.3) continue;
            const line = (y: number) => meet(A.n, dA, B.n, dB, y);
            pairsSeen.push([A, B, line, line, 'corner']);
        } else if (c > 0 && Math.abs(dA - dB) <= P.coplanarM) {
            // side by side on one wall: the vertical plane midway between the two facing ends
            const s = norm(cross([0, 1, 0], A.n));
            const sA = nA.map(v => dot(A.pos[v], s)), sB = nB.map(v => dot(B.pos[v], s));
            const aToB = median(sB) > median(sA);
            const endA = aToB ? Math.max(...sA) : Math.min(...sA), endB = aToB ? Math.min(...sB) : Math.max(...sB);
            if ((aToB ? endB - endA : endA - endB) < -reach || Math.abs(endB - endA) > reach) continue;
            const mid = (endA + endB) / 2, d = (dA + dB) / 2, nn = norm([(A.n[0] + B.n[0]) / 2, 0, (A.n[2] + B.n[2]) / 2]);
            const line = (y: number) => meet(nn, d, s, mid, y);
            pairsSeen.push([A, B, line, line, 'wall']);
        }
    }
    report.pairs = pairsSeen.length;
    const used = new Set<string>();
    const rayAll = rayIndex(sPos, sTris);
    const sN = new Float64Array(sTris.length * 3);
    sTris.forEach((f, t) => { const n = norm(cross(sub(sPos[f[1]], sPos[f[0]]), sub(sPos[f[2]], sPos[f[0]]))); sN.set(n, t * 3); });
    for (const [A, B, lineA, lineB, kind] of pairsSeen) {
        // a joint a reported hole lies on takes wider gaps
        const inRegion = (opts.regions ?? []).some(g => { const m = lineA(g.c[1]); return !!m && Math.hypot(m[0] - g.c[0], m[2] - g.c[2]) <= g.r; });
        const PJ = inRegion ? { ...P, cornerGapM: P.cornerGapM * P.regionGapFactor } : P;
        const cA = chain(A, lineA, PJ), cB = chain(B, lineB, PJ);
        if (!cA.length || !cB.length) continue;
        const joint = { a: A.name, b: B.name, kind, welded: 0, segments: 0, areaM2: 0, ...(inRegion ? { repair: true } : {}) };
        // welds: outline corners of the two within weldM
        const vA = [...new Set(cA.flatMap(s => [s.a, s.b]))], vB = [...new Set(cB.flatMap(s => [s.a, s.b]))];
        for (const a of vA) for (const b of vB) {
            const pa = A.pos[a], pb = B.pos[b], d = Math.hypot(...sub(pa, pb));
            if (d > P.weldM || d === 0 || moves.has(key(pa)) || moves.has(key(pb))) continue;
            const m: V3 = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2];
            moves.set(key(pa), m); moves.set(key(pb), m);
            joint.welded++;
        }
        const moved = (p: V3): V3 => moves.get(key(p)) ?? p;
        // the heights both outlines reach
        const covers = (c: Array<{ a: number; b: number }>, w: Wall, y: number) => c.some(s => w.pos[s.a][1] - 1e-6 <= y && y <= w.pos[s.b][1] + 1e-6);
        const ys = [...new Set([...cA.flatMap(s => [A.pos[s.a][1], A.pos[s.b][1]]), ...cB.flatMap(s => [B.pos[s.a][1], B.pos[s.b][1]])].map(y => Math.round(y * 1e4) / 1e4))].sort((x, y) => x - y);
        // only a surface facing out the way the strip does closes the gap (the inside of a wall seen through it does not)
        const ray = (o: number[], d: number[], maxM: number, n: V3) => rayAll(o, d, maxM, t => sNode[t] === A.node || sNode[t] === B.node || sN[t * 3] * n[0] + sN[t * 3 + 1] * n[1] + sN[t * 3 + 2] * n[2] < 0.3);
        for (const [w, c, line] of [[A, cA, lineA], [B, cB, lineB]] as const) {
            const other = w === A ? cB : cA, ow = w === A ? B : A;
            for (const s of c) {
                const p = moved(w.pos[s.a]), q = moved(w.pos[s.b]);
                const mid = (p[1] + q[1]) / 2;
                if (!covers(other, ow, mid)) continue;
                const inner = ys.filter(y => y > p[1] + 1e-6 && y < q[1] - 1e-6);
                const L = [p[1], ...inner, q[1]].map(y => line(y)!);
                if (L.some(x => !x)) continue;
                const gapP = Math.hypot(...sub(L[0], p)), gapQ = Math.hypot(...sub(L[L.length - 1], q));
                if (gapP < P.minGapM && gapQ < P.minGapM) continue;
                // something already behind the strip's middle: the gap is closed there, a strip would stand in front of it
                const probes = [[0.5, 0.5], [0.15, 0.5], [0.85, 0.5], [0.5, 0.15], [0.5, 0.85]].map(([a, b]) => { const lo = L[0], hi = L[L.length - 1]; return [0, 1, 2].map(k => (1 - b) * ((1 - a) * p[k] + a * lo[k]) + b * ((1 - a) * q[k] + a * hi[k])); });
                if (probes.some(cm => ray([cm[0] + w.n[0] * 0.02, cm[1] + w.n[1] * 0.02, cm[2] + w.n[2] * 0.02], [-w.n[0], -w.n[1], -w.n[2]], P.behindM + 0.02, w.n))) { report.coveredSegments++; continue; }
                // the strip: from the facade's edge (p, q) to the line's points, fanned from p, facing as the facade does
                const tris: V3[][] = [[p, q, L[L.length - 1]]];
                for (let k = L.length - 1; k > 0; k--) tris.push([p, L[k], L[k - 1]]);
                const list = strips.get(w.node) ?? strips.set(w.node, []).get(w.node)!;
                for (const t of tris) {
                    const nrm = cross(sub(t[1], t[0]), sub(t[2], t[0])), a = Math.hypot(nrm[0], nrm[1], nrm[2]) / 2;
                    if (!(a > 1e-8)) continue;
                    list.push(dot(nrm, w.n) >= 0 ? t : [t[0], t[2], t[1]]);
                    joint.areaM2 += a;
                }
                joint.segments++;
                used.add(`${w.node}:${s.a}:${s.b}`);
            }
        }
        if (joint.welded || joint.segments) {
            report.joints.push({ ...joint, areaM2: Math.round(joint.areaM2 * 100) / 100 });
            if (kind === 'corner') report.corners++; else report.sideBySide++;
        }
    }
    report.welded = report.joints.reduce((a, j) => a + j.welded, 0);
    report.stripAreaM2 = Math.round(report.joints.reduce((a, j) => a + j.areaM2, 0) * 100) / 100;
    const weld = (bytes: Uint8Array) => moves.size ? moveVertices(bytes, moves, key) : Buffer.from(bytes);
    let clayOut = weld(clay), othersOut = others.map(weld);
    // a strip lies in its facade's plane: its photo is its own place's, the facade's mapping carried on
    const all: Array<[number, Array<{ tri: V3[]; unfold: V3[] }>]> = [...strips].map(([ni, l]) => [ni, l.map(t => ({ tri: t, unfold: t }))]);
    report.strips = strips.size;
    report.stripTriangles = [...strips.values()].reduce((a, l) => a + l.length, 0);
    if (!all.length) return { clay: clayOut, others: othersOut, report };
    const method = `the rebuilt facades joined where they meet (${CORNER_JOIN_VERSION}): a facade stopping short of the line where it meets its neighbour (their planes' intersection at a corner, the plane midway between them on one wall), within ${P.cornerGapM} m, is carried on in its own plane to that line, both sides on the same points; nothing drawn where a surface already stands behind within ${P.behindM} m; each strip takes its facade's straightened photo, its mapping carried on.`;
    const extras = { sbCornerJoin: { version: CORNER_JOIN_VERSION, provenance: { label: 'generated', confidence: P.confidence, method }, joints: report.joints.length, welded: report.welded, areaM2: report.stripAreaM2 } };
    const flat = (tris: V3[][]) => { const a = new Float32Array(tris.length * 9); tris.forEach((t, i) => t.forEach((p, k) => a.set(p, i * 9 + k * 3))); return a; };
    const normalsOf = (tris: V3[][]) => { const a = new Float32Array(tris.length * 9); tris.forEach((t, i) => { const n = norm(cross(sub(t[1], t[0]), sub(t[2], t[0]))); for (let k = 0; k < 3; k++) a.set(n, i * 9 + k * 3); }); return a; };
    const allTris = all.flatMap(([, l]) => l.map(x => x.tri));
    clayOut = appendNode(clayOut, [{ positions: flat(allTris), normals: normalsOf(allTris), material: { name: 'CornerJoin', pbrMetallicRoughness: { baseColorFactor: [0.55, 0.53, 0.5, 1], metallicFactor: 0, roughnessFactor: 0.9 } } }], 'CornerJoin', extras);
    const texPrims: AppendPrim[] = all.map(([ni, items]) => {
        const w = walls.find(x => x.node === ni)!, list = items.map(x => x.tri);
        const RT = new Float32Array(list.length * 3).fill(1), CF = new Float32Array(list.length * 3).fill(P.confidence);
        if (!w.front) return { positions: flat(list), normals: normalsOf(list), attributes: { _PROVENANCE: RT.fill(0), _CONFIDENCE: CF.fill(0) }, material: { name: 'CornerJoin', pbrMetallicRoughness: { baseColorFactor: [0.55, 0.53, 0.5, 1], metallicFactor: 0, roughnessFactor: 0.9 } } };
        const uv = new Float32Array(list.length * 6);
        items.forEach((t, i) => { const m = extendMapping(w.front!.tri, w.front!.uv, t.unfold); m?.forEach((x, k) => { uv[i * 6 + k * 2] = x[0]; uv[i * 6 + k * 2 + 1] = x[1]; }); });
        return { positions: flat(list), normals: normalsOf(list), uv, attributes: { _PROVENANCE: RT, _CONFIDENCE: CF }, material: w.front.material };
    });
    othersOut = othersOut.map(b => appendNode(b, texPrims, 'CornerJoin', extras));
    return { clay: clayOut, others: othersOut, report };
}

/** The rebuilt facades' vertices at these world positions moved (their nodes' transforms identity; others are left). */
function moveVertices(bytes: Uint8Array, moves: Map<string, V3>, key: (p: ArrayLike<number>) => string): Buffer {
    const g = parseGlbBytes(bytes), json = g.json, world = nodeWorldMatrices(json);
    const bin = Uint8Array.from(g.bin), dv = new DataView(bin.buffer);
    const done = new Set<number>();
    (json.nodes ?? []).forEach((node: any, ni: number) => {
        if (node.mesh === undefined || !node.extras?.sbFacadeLattice || !isIdentity(world[ni])) return;
        for (const p of json.meshes[node.mesh]?.primitives ?? []) {
            const acc = p.attributes?.POSITION;
            if (acc === undefined || done.has(acc)) continue;
            done.add(acc);
            const L = accessorLayout(json, acc);
            if (L.componentType !== 5126) continue;
            for (let i = 0; i < L.count; i++) {
                const o = L.base + i * L.stride;
                const at = [dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true)];
                const m = moves.get(key(at));
                if (!m) continue;
                dv.setFloat32(o, m[0], true); dv.setFloat32(o + 4, m[1], true); dv.setFloat32(o + 8, m[2], true);
            }
            // the accessor's bounds kept true
            const a = json.accessors[acc];
            if (a.min && a.max) {
                for (let i = 0; i < L.count; i++) { const o = L.base + i * L.stride; for (let k = 0; k < 3; k++) { const v = dv.getFloat32(o + k * 4, true); a.min[k] = Math.min(a.min[k], v); a.max[k] = Math.max(a.max[k], v); } }
            }
        }
    });
    return assembleGlb(json, bin);
}

/** One line for the build's notes. */
export function describeCornerJoin(r: CornerJoinReport): string {
    if (!r.joints.length) return `no rebuilt facades left a gap where they meet (${r.pairs} meeting pairs read)`;
    return `${r.joints.length} joints between rebuilt facades closed (${r.corners} at corners, ${r.sideBySide} side by side on one wall): ${r.welded} outline corners welded, ${r.stripTriangles} triangles of return strips (${r.stripAreaM2} m², generated, the facade's photo carried on)${r.coveredSegments ? `; ${r.coveredSegments} strip pieces left out where a surface already stands behind` : ''}`;
}
