/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline G's roof: what stands on the massing's roof, built procedurally from what the scan measures there. Pipeline E
 * keeps the scan standing proud of its solid as raw triangles (its residual); G builds nothing from the scan, so its roof
 * was a flat lid without the skylights, bulkheads, penthouses and tanks the real one carries. Here the residual audit
 * (residual-audit.ts, run on a copy of E's run) sorts the residual into clusters with their measures and a verdict; every
 * cluster that is not a scan artefact and stands on the roof becomes a massing part:
 *   - its outline: the convex hull of its points in plan, simplified (Douglas-Peucker, OUTLINE_TOLERANCE_M), so a box
 *     stays a box and a round tank stays round;
 *   - its base: the support the audit measured under it; its top: a high percentile of its points (a stray spike is not
 *     the top);
 *   - its roof: flat when its upward faces are level, else up to MAX_ROOF_PLANES planes fitted (weighted least squares)
 *     to its sloping upward faces grouped by the direction they face; the part's roof is the lowest of them (the native
 *     tool's rule), which makes a pyramid, a hip, a gable or a shed from the measurements alone.
 * The parts are built by the native tool like the rest of the massing and painted like any roof; their provenance says
 * they are fitted to the scan. Nothing here knows what an object is: outlines, heights and planes only.
 */

import * as path from 'path';
import { roofAt, type MassingPart, type RoofPlaneSpec } from '../pipeline-e/massing-spec';
import type { MassingRun } from '../pipeline-e/native-massing';
import { auditMassingRun } from '../pipeline-e/residual-audit-e';
import type { AuditedCluster, ResidualAuditResult } from '../residual-audit';

/** The outline's simplification tolerance in plan. */
export const OUTLINE_TOLERANCE_M = 0.25;
/** A cluster is built when its outline covers at least this and it stands at least MIN_HEIGHT_M above its support. */
export const MIN_OUTLINE_M2 = 1.0;
export const MIN_HEIGHT_M = 0.6;
/** On the roof: what it stands on (the audit's support) at least this far above the ground (not the street, not a wall's foot)... */
export const MIN_SUPPORT_ABOVE_GROUND_M = 3;
/** ...and its plan centre inside a massing part whose roof there is within this of that support (not a balcony or a stair on a wall). */
export const ROOF_SUPPORT_TOLERANCE_M = 1.0;

/** Whether (x, z) lies inside a part's outline (its first loop outer, the rest holes; even-odd). */
export function insidePart(part: Pick<MassingPart, 'loops'>, x: number, z: number): boolean {
    let inside = false;
    for (const loop of part.loops) for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
        const [xi, zi] = loop[i], [xj, zj] = loop[j];
        if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
    return inside;
}
/** The top is this percentile of the cluster's heights. */
export const TOP_PERCENTILE = 0.98;
/** Upward faces at least this level count as a flat top; a flat top is this share of the upward area. */
export const LEVEL_NORMAL_Y = 0.97;
export const FLAT_SHARE = 0.6;
/** Sloping upward faces are grouped into at most this many planes, each holding at least MIN_PLANE_SHARE of the sloping area. */
export const MAX_ROOF_PLANES = 4;
export const MIN_PLANE_SHARE = 0.12;
/** Two planes face directions at least this far apart in plan. */
export const PEAK_SEPARATION = Math.PI / 4;
/** The part's provenance token (passed through to its nodes). */
export const ROOF_OBJECT_PROVENANCE = 'scan-fitted';

type P2 = [number, number];
type P3 = [number, number, number];

/** Convex hull (monotone chain), counter-clockwise. */
export function hull2(pts: P2[]): P2[] {
    const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (p.length < 3) return p;
    const cross = (o: P2, a: P2, b: P2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo: P2[] = [], hi: P2[] = [];
    for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
    for (const q of [...p].reverse()) { while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop(); hi.push(q); }
    return [...lo.slice(0, -1), ...hi.slice(0, -1)];
}

/** Douglas-Peucker on a closed ring. */
export function simplifyRing2(ring: P2[], tol: number): P2[] {
    if (ring.length <= 4) return ring;
    const dp = (pts: P2[]): P2[] => {
        const [a, b] = [pts[0], pts[pts.length - 1]], L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1e-9;
        let far = -1, fd = tol;
        for (let i = 1; i < pts.length - 1; i++) {
            const d = Math.abs((b[0] - a[0]) * (a[1] - pts[i][1]) - (a[0] - pts[i][0]) * (b[1] - a[1])) / L;
            if (d > fd) { fd = d; far = i; }
        }
        return far < 0 ? [a, b] : [...dp(pts.slice(0, far + 1)).slice(0, -1), ...dp(pts.slice(far))];
    };
    // split at the vertex farthest from the first
    let k = 0, best = -1;
    for (let i = 1; i < ring.length; i++) { const d = Math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1]); if (d > best) { best = d; k = i; } }
    const out = [...dp(ring.slice(0, k + 1)).slice(0, -1), ...dp([...ring.slice(k), ring[0]]).slice(0, -1)];
    return out.length >= 3 ? out : ring;
}

const ringArea = (r: P2[]) => Math.abs(r.reduce((a, p, i) => { const q = r[(i + 1) % r.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;

/** Weighted least-squares plane y = a + b x + c z through points with weights. */
export function fitPlane(pts: Array<{ p: P3; w: number }>): { a: number; b: number; c: number } | undefined {
    // normal equations for [1, x, z]
    const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], v = [0, 0, 0];
    for (const { p: [x, y, z], w } of pts) {
        const r = [1, x, z];
        for (let i = 0; i < 3; i++) { v[i] += w * r[i] * y; for (let j = 0; j < 3; j++) M[i][j] += w * r[i] * r[j]; }
    }
    const det = (m: number[][]) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    const D = det(M);
    if (Math.abs(D) < 1e-9) return undefined;
    const col = (k: number) => M.map((row, i) => row.map((x, j) => (j === k ? v[i] : x)));
    return { a: det(col(0)) / D, b: det(col(1)) / D, c: det(col(2)) / D };
}

export interface RoofObject { clusterId: number; verdict: string; part: MassingPart; outlineM2: number; heightM: number; planes: number; reason: string }

/** The triangles of a cluster, from the run's original residual nodes (the audit's global ids through its sources). */
export function clusterTriangles(run: Pick<MassingRun, 'nodes'>, audit: Pick<ResidualAuditResult, 'sources'>, c: Pick<AuditedCluster, 'triangleIds'>): P3[][] {
    const out: P3[][] = [];
    for (const id of c.triangleIds) {
        const s = audit.sources.find(x => id >= x.firstTriangle && id < x.firstTriangle + x.triangles);
        if (!s) continue;
        const n = run.nodes.find(x => x.name === s.node);
        if (!n) continue;
        const local = s.localTriangles ? s.localTriangles[id - s.firstTriangle] : id - s.firstTriangle;
        out.push([0, 1, 2].map(j => { const v = n.indices[local * 3 + j]; return [n.positions[v * 3], n.positions[v * 3 + 1], n.positions[v * 3 + 2]] as P3; }));
    }
    return out;
}

/** One cluster's part, or why it is not built. */
export function roofObjectPart(c: AuditedCluster, tris: P3[][], id: string, groundY: number, parts: Array<Pick<MassingPart, 'loops' | 'topY' | 'baseY' | 'planes'>>): RoofObject | { clusterId: number; skipped: string } {
    if (c.verdict === 'scan-artefact') return { clusterId: c.id, skipped: 'a scan artefact' };
    const above = c.attachment.supportY - groundY;
    if (!(above >= MIN_SUPPORT_ABOVE_GROUND_M)) return { clusterId: c.id, skipped: `not on the roof (it stands on something ${above.toFixed(1)} m above the ground)` };
    if (!tris.length) return { clusterId: c.id, skipped: 'no triangles' };
    const pts = tris.flat();
    const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length, cz = pts.reduce((s, p) => s + p[2], 0) / pts.length;
    const under = parts.filter(p => insidePart(p, cx, cz) && Math.abs(roofAt(p, cx, cz) - c.attachment.supportY) <= ROOF_SUPPORT_TOLERANCE_M);
    if (!under.length) return { clusterId: c.id, skipped: 'not on the roof (no massing roof under its centre at the height it stands on)' };
    const outline = simplifyRing2(hull2(pts.map(p => [p[0], p[2]] as P2)), OUTLINE_TOLERANCE_M);
    const outlineM2 = ringArea(outline);
    if (outline.length < 3 || outlineM2 < MIN_OUTLINE_M2) return { clusterId: c.id, skipped: `too small in plan (${outlineM2.toFixed(2)} m2)` };
    const ys = pts.map(p => p[1]).sort((a, b) => a - b);
    const base = c.attachment.supportY - 0.05, top = ys[Math.min(ys.length - 1, Math.floor(TOP_PERCENTILE * ys.length))];
    if (top - base < MIN_HEIGHT_M) return { clusterId: c.id, skipped: `too low (${(top - base).toFixed(2)} m above its support)` };
    // its upward faces: level ones make a flat top, sloping ones are grouped by the direction they face and fitted
    const up: Array<{ n: P3; area: number; centre: P3; corners: P3[] }> = [];
    for (const [a, b, d] of tris) {
        const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
        let n: P3 = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        const L = Math.hypot(...n);
        if (L < 1e-12) continue;
        n = [n[0] / L, n[1] / L, n[2] / L];
        if (n[1] < 0) n = [-n[0], -n[1], -n[2]];  // the scan's winding is not trusted: the upper side
        if (n[1] < 0.3) continue;
        up.push({ n, area: L / 2, centre: [(a[0] + b[0] + d[0]) / 3, (a[1] + b[1] + d[1]) / 3, (a[2] + b[2] + d[2]) / 3], corners: [a, b, d] });
    }
    const upArea = up.reduce((s, x) => s + x.area, 0);
    const level = up.filter(x => x.n[1] >= LEVEL_NORMAL_Y), sloping = up.filter(x => x.n[1] < LEVEL_NORMAL_Y);
    const planes: RoofPlaneSpec[] = [];
    let topY = top;
    if (upArea > 0 && level.reduce((s, x) => s + x.area, 0) / upArea >= FLAT_SHARE) {
        // a flat top: the area-weighted median height of its level faces
        const lv = [...level].sort((a, b) => a.centre[1] - b.centre[1]);
        const half = lv.reduce((s, x) => s + x.area, 0) / 2;
        let acc = 0;
        for (const x of lv) { acc += x.area; if (acc >= half) { topY = x.centre[1]; break; } }
    } else if (sloping.length) {
        // group the sloping faces by the azimuth they face: the peaks of their area-weighted azimuth histogram (at least
        // PEAK_SEPARATION apart, up to MAX_ROOF_PLANES), each face to its nearest peak
        const az = sloping.map(x => Math.atan2(x.n[2], x.n[0]));
        const diff = (a: number, b: number) => { const d = Math.abs(a - b) % (2 * Math.PI); return d > Math.PI ? 2 * Math.PI - d : d; };
        const BINS = 72, hist = new Float64Array(BINS);
        az.forEach((a, i) => { hist[Math.floor(((a + Math.PI) / (2 * Math.PI)) * BINS) % BINS] += sloping[i].area; });
        // smoothed over three bins, so a face straddling two bins is one peak
        const smooth = Array.from(hist, (_, b) => hist[(b + BINS - 1) % BINS] + hist[b] + hist[(b + 1) % BINS]);
        const order = smooth.map((v, b) => ({ v, a: -Math.PI + ((b + 0.5) / BINS) * 2 * Math.PI })).filter(x => x.v > 0).sort((p, q) => q.v - p.v);
        const centres: number[] = [];
        for (const pk of order) if (centres.length < MAX_ROOF_PLANES && centres.every(c2 => diff(c2, pk.a) >= PEAK_SEPARATION)) centres.push(pk.a);
        const assign = az.map(a => centres.reduce((best, c2, k) => (diff(a, c2) < diff(a, centres[best]) ? k : best), 0));
        const slopeArea = sloping.reduce((s, x) => s + x.area, 0);
        for (let k = 0; k < centres.length; k++) {
            const members = sloping.filter((_, i) => assign[i] === k);
            if (members.reduce((s, x) => s + x.area, 0) < MIN_PLANE_SHARE * slopeArea) continue;
            // fitted through the faces' corners (a fan of triangles from one edge to an apex has its centres on a line)
            const pl = fitPlane(members.flatMap(x => x.corners.map(p => ({ p, w: x.area / 3 }))));
            if (pl) planes.push({ ...pl, tag: `scan-fit:${k}` });
        }
    }
    const part: MassingPart = {
        id, baseY: base, topY, loops: [outline], planes, heightSource: 'scan', heights: { scanY: topY }, provenance: ROOF_OBJECT_PROVENANCE
    };
    return {
        clusterId: c.id, verdict: c.verdict, part, outlineM2: +outlineM2.toFixed(2), heightM: +(topY - base).toFixed(2), planes: planes.length,
        reason: `cluster ${c.id} (${c.verdict}${c.verdict === 'unsure' ? ', kept as built: neither artefact nor sure' : ''}): ${outline.length}-sided outline ${outlineM2.toFixed(1)} m2, ${(topY - base).toFixed(1)} m above its support, ${planes.length ? `${planes.length} roof planes fitted to its sloping faces` : 'a flat top'}`
    };
}

/**
 * The roof objects of E's run: the residual audit on a copy of the run (E's run is not changed), then a part per cluster
 * on the roof (roofObjectPart). Returns the parts and a line per cluster.
 */
export async function roofObjects(run: MassingRun, parts: Array<Pick<MassingPart, 'loops' | 'topY' | 'baseY' | 'planes'>>, opts: { groundY?: number; dir: string; signal?: AbortSignal }): Promise<{ parts: MassingPart[]; objects: RoofObject[]; notes: string[]; audit?: ResidualAuditResult }> {
    if (!run.nodes.some(n => n.kind === 'residual')) return { parts: [], objects: [], notes: ['no scan stands proud of the massing'] };
    const copy: MassingRun = { ...run, nodes: run.nodes.map(n => ({ ...n })) };
    const audit = await auditMassingRun(copy, { ...(opts.groundY !== undefined ? { groundY: opts.groundY } : {}), outDir: path.join(opts.dir, 'roof_audit'), ...(opts.signal ? { signal: opts.signal } : {}) });
    const objects: RoofObject[] = [], notes: string[] = [];
    const groundY = opts.groundY ?? audit.groundY ?? Math.min(...run.report.parts.map(p => p.baseY));
    for (const c of audit.clusters) {
        const r = roofObjectPart(c, clusterTriangles(run, audit, c), `roof-object-${c.id}`, groundY, parts);
        if ('part' in r) { objects.push(r); notes.push(r.reason); } else if (!/not on the roof|scan artefact/.test(r.skipped)) notes.push(`cluster ${c.id}: not built, ${r.skipped}`);
    }
    return { parts: objects.map(o => o.part), objects, notes, audit };
}
