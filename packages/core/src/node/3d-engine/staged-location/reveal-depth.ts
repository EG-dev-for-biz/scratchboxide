/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * How deep a facade's windows sit, read from Street View (© Google): a window recessed by d behind its wall, seen at an angle
 * whose tangent to the wall's normal is x along one axis, shows its glass narrowed by d·x along that axis (the reveal on the
 * far side covers it), whichever side the camera stands. Rectified onto the wall plane, every fitted window gives one
 * (x, apparent size) pair per view and axis; across a view's windows, storeys and columns x varies, so a line through the
 * pairs, apparent = size - d·x, gives d as its slope and the opening's true size as its intercept. Only size ratios inside
 * one image are read, so a pose a metre or two off (nominal Street View poses) changes x by a few percent, not d's sign.
 *
 * Per facade, the windows of one size share a depth; a facade with no reading of its own takes the building's median,
 * said so. Depths are photo-inferred (read from photographs, with the fit's standard error as confidence).
 */

import * as fs from 'fs';
import * as path from 'path';
import { projectToFrame, type FrameCamera } from '../../spatial/StreetViewPoseRegistrar';
import { encodePng } from './png-encode';

export const REVEAL_DEPTH_VERSION = 'reveal-depth/1';

export const REVEAL_DEPTH_PARAMS = {
    /** Rectified sample spacing on the wall (m). */
    sampleM: 0.04,
    /** The patch read around a window, as a share of its size each side. */
    marginShare: 0.5,
    /** A window is read only where it projects at least this many pixels across and up. */
    minWindowPx: 12,
    /** A view is used on a wall it sees at most this far off its normal (deg), and stands at least this far in front of it (m). */
    maxObliqueDeg: 78, minFrontM: 2,
    /** A window's middle must differ from the wall by at least this (share of the wall's luminance, at least 12 grey levels) to show glass. */
    glassContrast: 0.18,
    /** A size group is fitted from at least this many pairs, over at least this spread of tangents. */
    minSamples: 8, minTanSpread: 0.25,
    /** An accepted depth lies in [0, maxDepthM], its intercept within sizeTol of the fitted size, its slope at least minT standard errors from 0 or within noiseM of it. */
    maxDepthM: 0.8, sizeTol: 0.35, minT: 2, noiseM: 0.05,
    /** A window much taller than wide (a bay ribbon) is read across only: its glass and spandrels both differ from the wall. */
    ribbonAspect: 2.5,
    /** A read depth replaces the photo-contrast rule only with a standard error at most this (m) and at least minT standard errors
     * deep: a reading within its noise of flush says nothing (ESB a4366afc read 0.008 +- 0.038 m and flattened every window). */
    trustSeM: 0.05,
    /** Something nearer than the window by more than this (m, plus this share of its distance) hides it. */
    occlusionM: 1.5, occlusionShare: 0.02
};
export type RevealDepthParams = typeof REVEAL_DEPTH_PARAMS;

/** A facade's frame (tile frame) and its fitted windows [s0, t0, s1, t1] in the plane's metres. */
export interface RevealFacade { facadeId: number; centroid: number[]; normal: number[]; axisS: number[]; axisT: number[]; windows: Array<[number, number, number, number]> }
/**
 * A Street View photo and its camera (tile frame); `depth`, when given, is the whole tile mesh (neighbours, trees, the building
 * itself) rendered from the camera (renderFrameDepth, along its forward axis): a window is read only where it is what the
 * photo sees first.
 */
export interface RevealView { id: string; camera: FrameCamera; rgba: ArrayLike<number>; width: number; height: number; depth?: Float32Array }

interface Pair { facadeId: number; view: string; axis: 's' | 't'; group: number; tan: number; apparent: number; size: number }
export interface RevealGroupFit { facadeId: number; axis: 's' | 't'; groupM: number; n: number; views: number; depthM: number; sizeM: number; seM: number; tanSpread: number; accepted: boolean; why?: string }
export interface RevealDepthFile {
    version: string; params: RevealDepthParams; views: number; pairs: number;
    facades: Record<string, { depthM: number; seM: number; n: number; from: 'own' | 'building'; label: 'photo-inferred'; reason: string }>;
    building?: { depthM: number; seM: number; pairs: number; groups: number };
    fits: RevealGroupFit[];
}

const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const at = (f: RevealFacade, s: number, t: number): [number, number, number] => [0, 1, 2].map(k => f.centroid[k] + s * f.axisS[k] + t * f.axisT[k]) as [number, number, number];
const median = (a: number[]) => { if (!a.length) return NaN; const v = [...a].sort((x, y) => x - y), m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };

/** The photo's colour at a pixel (bilinear), or undefined off the image. */
function sample(v: RevealView, x: number, y: number): [number, number, number] | undefined {
    if (!(x >= 0 && y >= 0 && x < v.width - 1 && y < v.height - 1)) return undefined;
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, out: [number, number, number] = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
        const p = (xx: number, yy: number) => v.rgba[(yy * v.width + xx) * 4 + c];
        out[c] = (p(x0, y0) * (1 - fx) + p(x0 + 1, y0) * fx) * (1 - fy) + (p(x0, y0 + 1) * (1 - fx) + p(x0 + 1, y0 + 1) * fx) * fy;
    }
    return out;
}

/** The longest run of `on` in a profile that holds index `centre` or lies nearest it; undefined when it touches either end. */
function runAround(on: boolean[], centre: number): number | undefined {
    let best: [number, number] | undefined, bestDist = Infinity;
    for (let i = 0; i < on.length;) {
        if (!on[i]) { i++; continue; }
        let j = i; while (j + 1 < on.length && on[j + 1]) j++;
        const dist = centre < i ? i - centre : centre > j ? centre - j : 0;
        if (dist < bestDist || (dist === bestDist && best && j - i > best[1] - best[0])) { best = [i, j]; bestDist = dist; }
        i = j + 1;
    }
    if (!best || best[0] === 0 || best[1] === on.length - 1) return undefined;
    return best[1] - best[0] + 1;
}

/** One window seen in one view: its glass's apparent width and height on the wall (m), with the tangents of the view to the normal. */
function readWindow(f: RevealFacade, v: RevealView, w: [number, number, number, number], P: RevealDepthParams): Array<Omit<Pair, 'facadeId' | 'view' | 'group'>> {
    const [s0, t0, s1, t1] = w, W = s1 - s0, H = t1 - t0, sc = (s0 + s1) / 2, tc = (t0 + t1) / 2;
    const c = at(f, sc, tc), eye = v.camera.eye;
    const rel = [eye[0] - c[0], eye[1] - c[1], eye[2] - c[2]], rn = dot(rel, f.normal);
    if (!(rn >= P.minFrontM) || Math.acos(Math.min(1, rn / Math.hypot(rel[0], rel[1], rel[2]))) > (P.maxObliqueDeg * Math.PI) / 180) return [];
    const proj = (s: number, t: number) => projectToFrame(v.camera, at(f, s, t));
    const ends = [proj(s0, tc), proj(s1, tc), proj(sc, t0), proj(sc, t1)];
    if (ends.some(e => !e)) return [];
    const pxW = Math.hypot(ends[1]![0] - ends[0]![0], ends[1]![1] - ends[0]![1]), pxH = Math.hypot(ends[3]![0] - ends[2]![0], ends[3]![1] - ends[2]![1]);
    if (pxW < P.minWindowPx || pxH < P.minWindowPx) return [];
    // seen, not hidden: at the window's middle and each edge's middle the first surface is no nearer than the window (the
    // scan's wall may stand proud of its fitted plane by a little)
    if (v.depth) {
        for (const q of [proj(sc, tc), ...ends]) {
            const x = Math.floor(q![0]), y = Math.floor(q![1]);
            if (x < 0 || y < 0 || x >= v.width || y >= v.height) return [];
            if (v.depth[y * v.width + x] < q![2] - (P.occlusionM + P.occlusionShare * q![2])) return [];
        }
    }
    // the patch on the wall plane around the window, sampled from the photo
    const ms = P.marginShare * W, mt = P.marginShare * H, step = P.sampleM;
    const ns = Math.round((W + 2 * ms) / step), nt = Math.round((H + 2 * mt) / step);
    const rgb = new Float32Array(ns * nt * 3).fill(NaN);
    for (let j = 0; j < nt; j++) for (let i = 0; i < ns; i++) {
        const p = proj(s0 - ms + (i + 0.5) * step, t1 + mt - (j + 0.5) * step);
        const col = p ? sample(v, p[0], p[1]) : undefined;
        if (col) rgb.set(col, (j * ns + i) * 3);
    }
    // the wall's colour: the patch outside the window (and a little band around it)
    const inWin = (i: number, j: number) => { const s = s0 - ms + (i + 0.5) * step, t = t1 + mt - (j + 0.5) * step; return s > s0 - 0.15 * W && s < s1 + 0.15 * W && t > t0 - 0.15 * H && t < t1 + 0.15 * H; };
    const wall: number[][] = [[], [], []];
    for (let j = 0; j < nt; j++) for (let i = 0; i < ns; i++) if (!inWin(i, j) && Number.isFinite(rgb[(j * ns + i) * 3])) for (let k = 0; k < 3; k++) wall[k].push(rgb[(j * ns + i) * 3 + k]);
    if (wall[0].length < 20) return [];
    const ref = wall.map(median), lum = 0.2126 * ref[0] + 0.7152 * ref[1] + 0.0722 * ref[2];
    const i0 = Math.round(ms / step), i1 = Math.round((ms + W) / step), j0 = Math.round(mt / step), j1 = Math.round((mt + H) / step);
    // the glass's colour: the window's middle (a reveal only ever covers its edges)
    const mid: number[][] = [[], [], []];
    const ci = (i0 + i1) / 2, cj = (j0 + j1) / 2, hi = Math.max(1, (i1 - i0) * 0.15), hj = Math.max(1, (j1 - j0) * 0.15);
    for (let j = Math.floor(cj - hj); j <= Math.ceil(cj + hj); j++) for (let i = Math.floor(ci - hi); i <= Math.ceil(ci + hi); i++) if (i >= 0 && j >= 0 && i < ns && j < nt && Number.isFinite(rgb[(j * ns + i) * 3])) for (let k = 0; k < 3; k++) mid[k].push(rgb[(j * ns + i) * 3 + k]);
    if (mid[0].length < 4) return [];
    const gref = mid.map(median);
    // a window whose middle is the wall's colour shows no glass to read
    if (Math.hypot(gref[0] - ref[0], gref[1] - ref[1], gref[2] - ref[2]) < Math.max(12, P.glassContrast * lum)) return [];
    // glass: nearer the window's middle than the wall (a reveal, stone lit or shaded, is nearer the wall)
    const glass = (i: number, j: number) => { const k = (j * ns + i) * 3; if (!Number.isFinite(rgb[k])) return false; return Math.hypot(rgb[k] - gref[0], rgb[k + 1] - gref[1], rgb[k + 2] - gref[2]) < Math.hypot(rgb[k] - ref[0], rgb[k + 1] - ref[1], rgb[k + 2] - ref[2]); };
    const out: Array<Omit<Pair, 'facadeId' | 'view' | 'group'>> = [];
    // across the wall: the middle half of the window's rows, per column the share of glass
    {
        const ja = j0 + Math.floor((j1 - j0) / 4), jb = j1 - Math.floor((j1 - j0) / 4);
        const on = Array.from({ length: ns }, (_, i) => { let g = 0, n = 0; for (let j = ja; j < jb; j++) { n++; if (glass(i, j)) g++; } return n > 0 && g / n >= 0.5; });
        const run = runAround(on, Math.round((i0 + i1) / 2));
        if (run !== undefined) out.push({ axis: 's', tan: Math.abs(dot(rel, f.axisS)) / rn, apparent: run * step, size: W });
    }
    // up the wall, for a window (not a ribbon of glass and spandrels): the middle half of its columns, per row
    if (H <= P.ribbonAspect * W) {
        const ia = i0 + Math.floor((i1 - i0) / 4), ib = i1 - Math.floor((i1 - i0) / 4);
        const on = Array.from({ length: nt }, (_, j) => { let g = 0, n = 0; for (let i = ia; i < ib; i++) { n++; if (glass(i, j)) g++; } return n > 0 && g / n >= 0.5; });
        const run = runAround(on, Math.round((j0 + j1) / 2));
        if (run !== undefined) out.push({ axis: 't', tan: Math.abs(dot(rel, f.axisT)) / rn, apparent: run * step, size: H });
    }
    return out;
}

/** apparent = a - d·tan, fitted with two rounds of trimming residuals past 2.5 MAD; d, a and d's standard error. */
function fitLine(ps: Pair[]): { d: number; a: number; se: number; n: number; spread: number } | undefined {
    let pts = ps;
    for (let round = 0; round < 3; round++) {
        const n = pts.length;
        if (n < 3) return undefined;
        const mx = pts.reduce((s, p) => s + p.tan, 0) / n, my = pts.reduce((s, p) => s + p.apparent, 0) / n;
        let sxx = 0, sxy = 0;
        for (const p of pts) { sxx += (p.tan - mx) ** 2; sxy += (p.tan - mx) * (p.apparent - my); }
        if (!(sxx > 0)) return undefined;
        const b = sxy / sxx, a = my - b * mx, res = pts.map(p => p.apparent - (a + b * p.tan));
        const sse = res.reduce((s, r) => s + r * r, 0), se = Math.sqrt(sse / Math.max(1, n - 2) / sxx);
        const tans = pts.map(p => p.tan);
        if (round === 2) return { d: -b, a, se, n, spread: Math.max(...tans) - Math.min(...tans) };
        const mad = median(res.map(r => Math.abs(r - median(res)))) || 1e-6;
        const kept = pts.filter((_, k) => Math.abs(res[k]) <= 2.5 * 1.4826 * mad);
        if (kept.length === pts.length) return { d: -b, a, se, n, spread: Math.max(...tans) - Math.min(...tans) };
        pts = kept;
    }
    return undefined;
}

/** Reads the reveal depth of each facade's fitted windows from the views; optionally writes an overlay per view (projected windows). */
export function measureRevealDepth(facades: RevealFacade[], views: RevealView[], P: RevealDepthParams = REVEAL_DEPTH_PARAMS, debugDir?: string): RevealDepthFile {
    const pairs: Pair[] = [];
    for (const v of views) for (const f of facades) for (const w of f.windows) {
        for (const r of readWindow(f, v, w, P)) pairs.push({ ...r, facadeId: f.facadeId, view: v.id, group: Math.round(r.size / 0.2) * 0.2 });
    }
    const fits: RevealGroupFit[] = [];
    const groups = new Map<string, Pair[]>();
    for (const p of pairs) { const k = `${p.facadeId}|${p.axis}|${p.group.toFixed(1)}`; const l = groups.get(k); if (l) l.push(p); else groups.set(k, [p]); }
    for (const [, ps] of groups) {
        const fl = fitLine(ps), base = { facadeId: ps[0].facadeId, axis: ps[0].axis, groupM: ps[0].group, views: new Set(ps.map(p => p.view)).size };
        if (!fl) { fits.push({ ...base, n: ps.length, depthM: NaN, sizeM: NaN, seM: NaN, tanSpread: 0, accepted: false, why: 'no line' }); continue; }
        const why = judge(fl, ps[0].size, P);
        fits.push({ ...base, n: fl.n, depthM: Math.max(0, fl.d), sizeM: fl.a, seM: fl.se, tanSpread: fl.spread, accepted: !why, ...(why ? { why } : {}) });
    }
    // the building: windows of one size share a depth across its facades, so their pairs are fitted together as well
    const pooled = new Map<string, Pair[]>();
    for (const p of pairs) { const k = `${p.axis}|${p.group.toFixed(1)}`; const l = pooled.get(k); if (l) l.push(p); else pooled.set(k, [p]); }
    const buildingFits: RevealGroupFit[] = [];
    for (const [, ps] of pooled) {
        const fl = fitLine(ps);
        if (!fl) continue;
        const why = judge(fl, ps[0].size, P);
        buildingFits.push({ facadeId: -1, axis: ps[0].axis, groupM: ps[0].group, views: new Set(ps.map(p => p.view)).size, n: fl.n, depthM: Math.max(0, fl.d), sizeM: fl.a, seM: fl.se, tanSpread: fl.spread, accepted: !why, ...(why ? { why } : {}) });
    }
    fits.push(...buildingFits);
    const out: RevealDepthFile['facades'] = {};
    const own = new Map<number, RevealGroupFit[]>();
    for (const g of fits.filter(x => x.accepted)) { const l = own.get(g.facadeId); if (l) l.push(g); else own.set(g.facadeId, [g]); }
    for (const [id, gs] of own) {
        // the facade's depth: its groups' depths weighted by their pairs (a weighted median)
        const sorted = [...gs].sort((a, b) => a.depthM - b.depthM), total = gs.reduce((s, g) => s + g.n, 0);
        let acc = 0, pick = sorted[0];
        for (const g of sorted) { acc += g.n; if (acc >= total / 2) { pick = g; break; } }
        out[String(id)] = { depthM: round3(pick.depthM), seM: round3(pick.seM), n: total, from: 'own', label: 'photo-inferred', reason: `${total} window readings in ${new Set(pairs.filter(p => p.facadeId === id).map(p => p.view)).size} Street View views (© Google): the glass narrows by depth x the view's tangent` };
    }
    // the building's depth: its pooled size groups' accepted depths, weighted by their pairs (a weighted median)
    const okB = buildingFits.filter(g => g.accepted).sort((a, b) => a.depthM - b.depthM), totalB = okB.reduce((s, g) => s + g.n, 0);
    let pickB: RevealGroupFit | undefined, accB = 0;
    for (const g of okB) { accB += g.n; if (accB >= totalB / 2) { pickB = g; break; } }
    const building = pickB ? { depthM: round3(pickB.depthM), seM: round3(pickB.seM), pairs: totalB, groups: okB.length } : undefined;
    if (building) for (const f of facades) if (!out[String(f.facadeId)] && f.windows.length) out[String(f.facadeId)] = { depthM: building.depthM, seM: building.seM, n: 0, from: 'building', label: 'photo-inferred', reason: `no Street View reading of its own: the building's windows of one size read together (${building.pairs} readings in ${building.groups} size groups)` };
    if (debugDir) writeOverlays(facades, views, debugDir);
    return { version: REVEAL_DEPTH_VERSION, params: P, views: views.length, pairs: pairs.length, facades: out, ...(building ? { building } : {}), fits };
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** Why a fitted line is not taken as a depth (undefined: taken). */
function judge(fl: { d: number; a: number; se: number; n: number; spread: number }, size: number, P: RevealDepthParams): string | undefined {
    return fl.n < P.minSamples ? `${fl.n} pairs` : fl.spread < P.minTanSpread ? `tangents spread ${fl.spread.toFixed(2)}` : !(fl.d >= -P.noiseM && fl.d <= P.maxDepthM) ? `slope gives ${fl.d.toFixed(2)} m`
        : Math.abs(fl.a - size) > P.sizeTol * size ? `intercept ${fl.a.toFixed(2)} m against ${size.toFixed(2)} m fitted` : !(Math.abs(fl.d) <= P.noiseM || Math.abs(fl.d) >= P.minT * fl.se) ? `slope ${fl.d.toFixed(2)} ± ${fl.se.toFixed(2)} m` : undefined;
}

/** Diagnostics: each view with the fitted windows it sees drawn on it (red), to check the frames agree. */
function writeOverlays(facades: RevealFacade[], views: RevealView[], dir: string): void {
    fs.mkdirSync(dir, { recursive: true });
    for (const v of views) {
        const px = Buffer.from(Uint8Array.from(v.rgba));
        const dotAt = (x: number, y: number) => { const xi = Math.round(x), yi = Math.round(y); if (xi < 0 || yi < 0 || xi >= v.width || yi >= v.height) return; px.set([255, 0, 0, 255], (yi * v.width + xi) * 4); };
        for (const f of facades) {
            if (!(dot([v.camera.eye[0] - f.centroid[0], v.camera.eye[1] - f.centroid[1], v.camera.eye[2] - f.centroid[2]], f.normal) > 0)) continue;
            for (const [s0, t0, s1, t1] of f.windows) {
                const corners: Array<[number, number]> = [[s0, t0], [s1, t0], [s1, t1], [s0, t1]];
                for (let e = 0; e < 4; e++) {
                    const [a, b] = [corners[e], corners[(e + 1) % 4]];
                    for (let k = 0; k <= 20; k++) { const p = projectToFrame(v.camera, at(f, a[0] + (b[0] - a[0]) * k / 20, a[1] + (b[1] - a[1]) * k / 20)); if (p) dotAt(p[0], p[1]); }
                }
            }
        }
        fs.writeFileSync(path.join(dir, `${v.id.replace(/[^\w-]/g, '_')}.png`), encodePng(v.width, v.height, px, 4));
    }
}

/** Whether a reveal reading is confident enough to replace the photo-contrast rule: a small standard error, and a depth resolved from flush. */
export function trustedReveal(read: { depthM: number; seM: number } | undefined, P: Pick<RevealDepthParams, 'trustSeM' | 'minT'> = REVEAL_DEPTH_PARAMS): boolean {
    return !!read && Number.isFinite(read.depthM) && Number.isFinite(read.seM) && read.seM <= P.trustSeM && read.depthM >= P.minT * read.seM;
}
