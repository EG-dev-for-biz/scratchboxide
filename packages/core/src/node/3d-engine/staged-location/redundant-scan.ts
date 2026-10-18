/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pass-through scan pieces that are redundant with the fitted surface: the parts of the as-scanned layer (the scan kept
 * where the fit did not explain it) that lie on a fitted face, within the scan tolerance of it. Drawn over the fitted
 * wall they show as a second, differently exposed skin (round 9: the wedge on the back spandrel, the keystone square);
 * hidden, the fitted wall with its photo texture shows.
 *
 * The rule is measured, never a category: a point of a pass-through triangle is REDUNDANT when some fitted triangle lies
 * directly behind it, that is the point's projection along that triangle's normal lands inside the triangle, and the
 * offset along the normal is within the tolerance (|offset| <= tol, on either side). The redundant set of one fitted
 * triangle is a prism (two slab planes at +-tol, three planes through its edges along its normal), so each pass-through
 * triangle is clipped exactly (Sutherland-Hodgman) against the prisms of the fitted triangles near it: the parts inside a
 * prism are hidden, the rest is kept as convex pieces with straight edges. A triangle no prism reaches stays as it is.
 * Anything with no fitted face behind it is kept, so hiding never opens a hole: every hidden point has a fitted face
 * within the tolerance directly behind it.
 *
 * The tolerance is per fitted surface: `rmsScale` x the surface's own scan residual, clamped to [min, max]; a fit that
 * explains its scan to 2 cm hides less than one that explains it to 5 cm.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { FittedSurface, StructureFit } from '../../../common/spatial/staged-location-contracts';
import { readGlbNodes, type GlbNode } from './glb-nodes';
import { writeStagedGlbFile } from './staged-glb-writer';

export interface RedundantScanOptions {
    /** Lower bound of the per-surface tolerance (m). */
    minToleranceM?: number;
    /** Upper bound of the per-surface tolerance (m). */
    maxToleranceM?: number;
    /** The tolerance is this many times the surface's scan rms, clamped. */
    rmsScale?: number;
    /** Clipped pieces smaller than this are dropped from the hidden side (they stay drawn): m². */
    minPieceAreaM2?: number;
}

export const REDUNDANT_SCAN_DEFAULTS: Required<RedundantScanOptions> = { minToleranceM: 0.10, maxToleranceM: 0.15, rmsScale: 3, minPieceAreaM2: 1e-6 };

/** What one pass-through node (region) kept and hid. */
export interface RedundantRegionReport {
    name: string;
    trianglesIn: number;
    /** Input triangles hidden whole. */
    trianglesHidden: number;
    /** Input triangles clipped at the edge of a fitted face or of the tolerance slab (part hidden, part kept). */
    trianglesSplit: number;
    areaInM2: number;
    areaHiddenM2: number;
    /** Area-weighted median and largest |offset| from the fitted face over the hidden pieces (m, at their centroids). */
    offsetMedianM?: number;
    offsetMaxM?: number;
    /** The fitted surfaces behind the hidden part, by hidden area. */
    surfaceIds: string[];
}

export interface RedundantScanReport {
    schema: 'scratchbox.passthrough-hidden/1';
    trianglesIn: number; trianglesHidden: number; trianglesSplit: number;
    areaInM2: number; areaHiddenM2: number; areaKeptM2: number;
    /** The tolerances used (per surface, after the clamp). */
    toleranceM: { min: number; max: number; bySurface: Record<string, number> };
    options: Required<RedundantScanOptions>;
    regions: RedundantRegionReport[];
    ms: number;
}

export interface RedundantScanResult {
    /** The pass-through nodes with the redundant parts removed (nodes left empty are dropped). */
    visible: GlbNode[];
    /** The redundant parts, one node per region that had any. */
    hidden: GlbNode[];
    report: RedundantScanReport;
}

type V3 = [number, number, number];
type Poly = V3[];
/** A half-space n.p + d >= 0. */
type Plane = [number, number, number, number];

interface FittedTri { id: number; a: V3; n: V3; planes: Plane[]; lo: V3; hi: V3; tol: number; surface: string }

const sub = (p: V3, q: V3): V3 => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
const dot = (p: V3, q: V3) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
const cross = (p: V3, q: V3): V3 => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
const evalPlane = (h: Plane, p: V3) => h[0] * p[0] + h[1] * p[1] + h[2] * p[2] + h[3];

function polyArea(poly: Poly): number {
    let x = 0, y = 0, z = 0;
    for (let i = 1; i + 1 < poly.length; i++) { const c = cross(sub(poly[i], poly[0]), sub(poly[i + 1], poly[0])); x += c[0]; y += c[1]; z += c[2]; }
    return Math.hypot(x, y, z) / 2;
}

function centroid(poly: Poly): V3 {
    const c: V3 = [0, 0, 0];
    for (const p of poly) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
    return [c[0] / poly.length, c[1] / poly.length, c[2] / poly.length];
}

/** The part of a convex polygon where h >= 0 (Sutherland-Hodgman, one plane). */
function clip(poly: Poly, h: Plane, sign: 1 | -1): Poly {
    const out: Poly = [];
    for (let i = 0; i < poly.length; i++) {
        const p = poly[i], q = poly[(i + 1) % poly.length];
        const fp = sign * evalPlane(h, p), fq = sign * evalPlane(h, q);
        if (fp >= 0) out.push(p);
        if ((fp >= 0) !== (fq >= 0)) {
            const t = fp / (fp - fq);
            out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1]), p[2] + t * (q[2] - p[2])]);
        }
    }
    return out;
}

/** A convex polygon split by a prism (an intersection of half-spaces): the part inside, and the convex pieces outside. */
function subtract(poly: Poly, planes: Plane[]): { inside: Poly | undefined; outside: Poly[] } {
    const outside: Poly[] = [];
    let cur = poly;
    for (const h of planes) {
        let allIn = true, allOut = true;
        for (const p of cur) { const f = evalPlane(h, p); if (f < 0) allIn = false; else allOut = false; }
        if (allOut) { outside.push(cur); return { inside: undefined, outside }; }
        if (allIn) continue;
        const o = clip(cur, h, -1);
        if (o.length >= 3) outside.push(o);
        cur = clip(cur, h, 1);
        if (cur.length < 3) return { inside: undefined, outside };
    }
    return { inside: cur, outside };
}

/** A uniform grid over the fitted triangles, each registered in the cells its box (grown by its tolerance) touches. */
class FittedIndex {
    private cells = new Map<string, FittedTri[]>();
    constructor(tris: FittedTri[], private cell: number) {
        for (const t of tris) {
            const lo = [0, 1, 2].map(k => Math.floor(t.lo[k] / cell)), hi = [0, 1, 2].map(k => Math.floor(t.hi[k] / cell));
            for (let i = lo[0]; i <= hi[0]; i++) for (let j = lo[1]; j <= hi[1]; j++) for (let k = lo[2]; k <= hi[2]; k++) {
                const key = `${i},${j},${k}`;
                let list = this.cells.get(key);
                if (!list) this.cells.set(key, list = []);
                list.push(t);
            }
        }
    }
    /** The fitted triangles whose prism box overlaps the box [lo, hi], each once, in a fixed order. */
    near(lo: V3, hi: V3): FittedTri[] {
        const c = this.cell, seen = new Set<number>(), out: FittedTri[] = [];
        for (let i = Math.floor(lo[0] / c); i <= Math.floor(hi[0] / c); i++) for (let j = Math.floor(lo[1] / c); j <= Math.floor(hi[1] / c); j++) for (let k = Math.floor(lo[2] / c); k <= Math.floor(hi[2] / c); k++) {
            for (const t of this.cells.get(`${i},${j},${k}`) ?? []) {
                if (seen.has(t.id)) continue;
                seen.add(t.id);
                if (t.lo[0] > hi[0] || t.hi[0] < lo[0] || t.lo[1] > hi[1] || t.hi[1] < lo[1] || t.lo[2] > hi[2] || t.hi[2] < lo[2]) continue;
                out.push(t);
            }
        }
        return out.sort((x, y) => x.id - y.id);
    }
}

/** The per-surface tolerance: rmsScale x the surface's scan rms, clamped to [min, max]. */
export function surfaceToleranceM(surface: Pick<FittedSurface, 'fit'> | undefined, o: Required<RedundantScanOptions>): number {
    const rms = surface?.fit?.rmsM;
    const t = Number.isFinite(rms) ? o.rmsScale * (rms as number) : o.minToleranceM;
    return Math.min(o.maxToleranceM, Math.max(o.minToleranceM, t));
}

/** The prism of one fitted triangle: the slab |offset| <= tol, and the three planes through its edges along its normal. */
function prism(id: number, a: V3, b: V3, c: V3, tol: number, surface: string): FittedTri | undefined {
    const nn = cross(sub(b, a), sub(c, a)), len = Math.hypot(nn[0], nn[1], nn[2]);
    if (len < 1e-9) return undefined;
    const n: V3 = [nn[0] / len, nn[1] / len, nn[2] / len];
    // 1 mm of slack at the edges, so the prisms of neighbouring triangles of one face leave no seam between them
    const slack = 1e-3;
    const planes: Plane[] = [
        [-n[0], -n[1], -n[2], dot(n, a) + tol],
        [n[0], n[1], n[2], -dot(n, a) + tol]
    ];
    for (const [p, q] of [[a, b], [b, c], [c, a]] as Array<[V3, V3]>) {
        const m = cross(n, sub(q, p)), ml = Math.hypot(m[0], m[1], m[2]);
        if (ml < 1e-12) return undefined;
        const u: V3 = [m[0] / ml, m[1] / ml, m[2] / ml]; // points into the triangle (counter-clockwise about n)
        planes.push([u[0], u[1], u[2], -dot(u, p) + slack]);
    }
    const lo: V3 = [0, 1, 2].map(k => Math.min(a[k], b[k], c[k]) - tol) as V3, hi: V3 = [0, 1, 2].map(k => Math.max(a[k], b[k], c[k]) + tol) as V3;
    return { id, a, n, planes, lo, hi, tol, surface };
}

/**
 * Splits the pass-through nodes into what stays drawn and what a fitted face within the tolerance already shows.
 * `fittedNodes` are the fitted body's nodes, named by surface id (the fit's own GLB); `surfaces` give each its tolerance.
 */
export function hideRedundantScan(passNodes: GlbNode[], fittedNodes: GlbNode[], surfaces: Array<Pick<FittedSurface, 'id' | 'fit'>>, options: RedundantScanOptions = {}): RedundantScanResult {
    const started = performance.now();
    const o: Required<RedundantScanOptions> = { ...REDUNDANT_SCAN_DEFAULTS, ...options };
    const surfaceOf = new Map(surfaces.map(s => [s.id, s]));
    const bySurface: Record<string, number> = {};
    const tris: FittedTri[] = [];
    const at = (P: Float32Array, i: number): V3 => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
    for (const node of fittedNodes) {
        const tol = surfaceToleranceM(surfaceOf.get(node.name), o);
        bySurface[node.name] = tol;
        const P = node.positions, I = node.indices ?? Uint32Array.from({ length: P.length / 3 }, (_, i) => i);
        for (let t = 0; t + 2 < I.length; t += 3) {
            const pr = prism(tris.length, at(P, I[t]), at(P, I[t + 1]), at(P, I[t + 2]), tol, node.name);
            if (pr) tris.push(pr);
        }
    }
    const tols = Object.values(bySurface);
    const maxTol = tols.length ? Math.max(...tols) : o.maxToleranceM;
    const index = new FittedIndex(tris, 1.0);

    const visible: GlbNode[] = [], hidden: GlbNode[] = [], regions: RedundantRegionReport[] = [];
    let tIn = 0, tHid = 0, tSplit = 0, aIn = 0, aHid = 0;
    for (const node of passNodes) {
        const P = node.positions, I = node.indices ?? Uint32Array.from({ length: P.length / 3 }, (_, i) => i);
        const keptOut = new Builder(), hidOut = new Builder();
        const offsets: Array<[number, number]> = [];
        const surfArea = new Map<string, number>();
        let nHid = 0, nSplit = 0, areaIn = 0, areaHid = 0;
        for (let t = 0; t + 2 < I.length; t += 3) {
            const a = at(P, I[t]), b = at(P, I[t + 1]), c = at(P, I[t + 2]);
            const tri: Poly = [a, b, c];
            const area = polyArea(tri);
            areaIn += area;
            const lo: V3 = [0, 1, 2].map(k => Math.min(a[k], b[k], c[k])) as V3, hi: V3 = [0, 1, 2].map(k => Math.max(a[k], b[k], c[k])) as V3;
            let remaining: Poly[] = [tri];
            const hidPieces: Array<{ poly: Poly; f: FittedTri }> = [];
            for (const f of index.near(lo, hi)) {
                const next: Poly[] = [];
                for (const poly of remaining) {
                    const r = subtract(poly, f.planes);
                    if (r.inside && polyArea(r.inside) >= o.minPieceAreaM2) { hidPieces.push({ poly: r.inside, f }); next.push(...r.outside); }
                    else if (r.inside) next.push(poly); // a speck inside: the piece stays whole
                    else next.push(...r.outside);
                }
                remaining = next;
                if (!remaining.length) break;
            }
            if (!hidPieces.length) { keptOut.tri(a, b, c); continue; }
            const keptArea = remaining.reduce((s, x) => s + polyArea(x), 0);
            if (keptArea < o.minPieceAreaM2) { nHid++; hidOut.tri(a, b, c); remaining = []; } else { nSplit++; for (const poly of remaining) keptOut.poly(poly); }
            for (const { poly, f } of hidPieces) {
                const pa = polyArea(poly);
                if (remaining.length) hidOut.poly(poly);
                areaHid += pa;
                offsets.push([Math.abs(dot(sub(centroid(poly), f.a), f.n)), pa]);
                surfArea.set(f.surface, (surfArea.get(f.surface) ?? 0) + pa);
            }
        }
        const triangles = I.length / 3;
        tIn += triangles; tHid += nHid; tSplit += nSplit; aIn += areaIn; aHid += areaHid;
        const withCounts = (extras: unknown, b: Builder) => {
            const sb = (extras as { sb?: { counts?: unknown } } | undefined)?.sb;
            return sb && typeof sb === 'object' ? { ...(extras as object), sb: { ...sb, counts: { vertices: b.vertices(), triangles: b.triangles() } } } : extras;
        };
        if (keptOut.triangles()) visible.push({ name: node.name, positions: keptOut.positions(), indices: keptOut.indices(), ...(node.extras !== undefined ? { extras: withCounts(node.extras, keptOut) } : {}) });
        if (hidOut.triangles()) hidden.push({ name: node.name, positions: hidOut.positions(), indices: hidOut.indices(), ...(node.extras !== undefined ? { extras: withCounts(node.extras, hidOut) } : {}) });
        offsets.sort((x, y) => x[0] - y[0]);
        let median: number | undefined;
        const total = offsets.reduce((s, x) => s + x[1], 0);
        for (let k = 0, acc = 0; k < offsets.length; k++) { acc += offsets[k][1]; if (acc >= total / 2) { median = offsets[k][0]; break; } }
        regions.push({
            name: node.name, trianglesIn: triangles, trianglesHidden: nHid, trianglesSplit: nSplit, areaInM2: round(areaIn), areaHiddenM2: round(areaHid),
            ...(offsets.length ? { offsetMedianM: round(median ?? 0, 3), offsetMaxM: round(offsets[offsets.length - 1][0], 3) } : {}),
            surfaceIds: [...surfArea.entries()].sort((x, y) => y[1] - x[1]).map(x => x[0])
        });
    }
    return {
        visible, hidden,
        report: {
            schema: 'scratchbox.passthrough-hidden/1', trianglesIn: tIn, trianglesHidden: tHid, trianglesSplit: tSplit,
            areaInM2: round(aIn), areaHiddenM2: round(aHid), areaKeptM2: round(aIn - aHid),
            toleranceM: { min: tols.length ? Math.min(...tols) : o.minToleranceM, max: maxTol, bySurface },
            options: o, regions, ms: Math.round(performance.now() - started)
        }
    };
}

function round(v: number, d = 2): number { const k = 10 ** d; return Math.round(v * k) / k; }

/** Triangles as a soup (three vertices each, like the scan_fit pass-through layer: flat-shaded, nothing shared). */
class Builder {
    private pos: number[] = [];
    tri(a: number[], b: number[], c: number[]): void { this.pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]); }
    /** A convex polygon as a fan (its winding kept). */
    poly(p: number[][]): void { for (let i = 1; i + 1 < p.length; i++) this.tri(p[0], p[i], p[i + 1]); }
    triangles(): number { return this.pos.length / 9; }
    vertices(): number { return this.pos.length / 3; }
    positions(): Float32Array { return Float32Array.from(this.pos); }
    indices(): Uint32Array { return Uint32Array.from({ length: this.pos.length / 3 }, (_, i) => i); }
}

/** What the fit stage keeps of the split: the two layer files (absent when empty) and the report. */
export interface PassThroughSplit {
    visibleFile?: string;
    hiddenFile?: string;
    reportPath: string;
    report: RedundantScanReport;
}

/** The root (scene) node extras of a staged GLB, to carry over to its recut. */
function rootExtrasOf(file: string): Record<string, unknown> | undefined {
    const buf = fs.readFileSync(file);
    const json = JSON.parse(buf.toString('utf8', 20, 20 + buf.readUInt32LE(12)));
    const root = (json.nodes ?? []).find((n: { mesh?: number; children?: number[] }) => n.mesh === undefined && n.children?.length);
    return root?.extras;
}

/**
 * Splits the fit's pass-through GLB into the part that stays drawn and the part a fitted face already shows, written to
 * `dir` (passthrough_visible.glb, passthrough_hidden.glb, passthrough_hidden.json). Undefined when the fit kept no scan as
 * scanned or its body cannot be read (then nothing is hidden).
 */
export function splitPassThroughFile(fit: Pick<StructureFit, 'surfaces' | 'outputs'>, dir: string, options: RedundantScanOptions = {}): PassThroughSplit | undefined {
    const passFile = fit.outputs.passThroughGlb;
    if (!passFile || !fs.existsSync(passFile) || !fit.outputs.fittedGlb || !fs.existsSync(fit.outputs.fittedGlb)) return undefined;
    let pass: GlbNode[], body: GlbNode[];
    try { pass = readGlbNodes(passFile); body = readGlbNodes(fit.outputs.fittedGlb); } catch { return undefined; }
    // every node of the body is a fitted face; one named after a fitted surface takes that surface's tolerance, any other the lower bound
    if (!body.length || !pass.length) return undefined;
    const r = hideRedundantScan(pass, body, fit.surfaces, options);
    fs.mkdirSync(dir, { recursive: true });
    const rootExtras = rootExtrasOf(passFile);
    const write = (name: string, nodes: GlbNode[]) => {
        if (!nodes.length) return undefined;
        const file = path.join(dir, name);
        writeStagedGlbFile(file, nodes.map(n => ({ name: n.name, positions: n.positions, ...(n.indices ? { indices: n.indices } : {}), ...(n.extras !== undefined ? { extras: n.extras } : {}) })), { ...(rootExtras ? { rootExtras } : {}), copyright: 'Google' });
        return file;
    };
    // nothing hidden: the fit's own file stays the drawn layer, byte for byte
    const visibleFile = r.hidden.length ? write('passthrough_visible.glb', r.visible) : passFile;
    const hiddenFile = write('passthrough_hidden.glb', r.hidden);
    const reportPath = path.join(dir, 'passthrough_hidden.json');
    fs.writeFileSync(reportPath, JSON.stringify(r.report, null, 1));
    return { ...(visibleFile ? { visibleFile } : {}), ...(hiddenFile ? { hiddenFile } : {}), reportPath, report: r.report };
}
