/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Street objects, step 4 (measure): an upright object's profile from its silhouette in registered Street View views, scaled
 * by the scan.
 *
 * The scan says where the object's axis stands and how tall it is (measured, families.ts); a view's mask says how wide it is
 * at each height. Per mask row, the run nearest the axis (the axis as the camera sees it, shifted onto the mask's own base
 * to take up the pose's lateral error) gives a width in pixels; the pixel ray's closest point to the vertical axis gives
 * the row's height on the axis and its distance from the camera, so width and offset come out in metres at the pano's
 * measured distance. The profile's shape is the photo's, its size is the scan's: heights and widths are scaled together
 * by the scan's height over the photo's (a distance error scales both, so it cancels; the ratio is reported as the
 * agreement of the two).
 *
 * Views are combined per height by a median weighted by how many pixels tall the object is in each; the spread of the
 * widths across views from different sides is the measured roundness. A width that changes with the view angle as a
 * rectangle's projection does is read as a plan section scale (the scan's plan times the photo's taper).
 *
 * Nothing here decodes, keeps or writes a photo: it reads masks (one byte a pixel, from whatever segmented the view).
 */

import type { FrameCamera } from '../../../spatial/StreetViewPoseRegistrar';
import { projectToFrame } from '../../../spatial/StreetViewPoseRegistrar';
import { pixelRay } from '../survey-casting';
import type { V2, V3 } from './families';

export const SILHOUETTE_PARAMS = {
    /** Height samples of a profile (foot to top). */
    bins: 48,
    /** The mask is searched this far either side of the axis (metres at the object), at least twice its plan half-extent. */
    searchM: 1.0,
    /** Rows this far (share of the object's projected height) above its top and below its foot are searched too. */
    marginShare: 0.3,
    /** The lowest share of the mask's rows its base is read from (the axis shift). */
    baseShare: 0.25,
    /** The mask's lowest row this share of the projected height above the foot means the foot is hidden. */
    footHiddenShare: 0.08,
    /** Rows narrower than this many pixels are not read (below what the view resolves). */
    minRunPx: 2,
    /** A component must cover at least this share of the projected axis's rows. */
    minCover: 0.3,
    /** A profile needs at least this many pixels of height. */
    minPixelHeight: 24
};
export type SilhouetteParams = typeof SILHOUETTE_PARAMS;

/** A registered view's mask of one object: 1 where the object is. */
export interface ViewSilhouette { mask: Uint8Array; width: number; height: number; cam: FrameCamera; id?: string }

/** The scan's measure of the object: its foot on the support and its height (families.ts StreetObjectMember). */
export interface UprightAxis { foot: V3; heightM: number; planM?: V2; planHeadingDeg?: number }

export interface ProfileSample {
    /** 0 at the foot, 1 at the top. */
    t: number;
    /** Half the width across the view, and how far the run's middle is off the axis (to the view's right), scan-scaled metres. NaN where no row was read. */
    halfWidthM: number;
    offsetM: number;
    rows: number;
}

export interface SilhouetteProfile {
    id?: string;
    samples: ProfileSample[];
    /** The object's height as the photo measures it at the registered distance, and the scan's. */
    photoHeightM: number;
    scanHeightM: number;
    /** scan / photo: what the photo's metres are multiplied by. */
    scale: number;
    /** How tall the mask is, and how far the axis stands from the camera (plan). */
    pixelHeight: number;
    rangeM: number;
    /** The view's heading toward the object, clockwise from north. */
    viewHeadingDeg: number;
    footVisible: boolean;
    /** How far the mask's base stands beside the axis the scan put there (pose error plus the scan's own), photo metres. */
    lateralShiftM: number;
    /** Share of the profile's height read from the mask. */
    coverage: number;
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const median = (a: number[]) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN; };

/** Height on the vertical axis through `foot` where the ray through pixel (px, py) passes it closest, and that point's view depth. */
export function heightOnAxis(cam: FrameCamera, px: number, py: number, foot: V3): { z: number; depth: number } {
    const ray = pixelRay(cam, px, py);
    const u = ray.dir, w0 = [ray.origin[0] - foot[0], ray.origin[1] - foot[1], ray.origin[2] - foot[2]];
    const b = u[1], d = u[0] * w0[0] + u[1] * w0[1] + u[2] * w0[2], e = w0[1];
    const D = Math.max(1e-9, 1 - b * b);
    const t = (e - b * d) / D;
    const q = [foot[0] - cam.eye[0], foot[1] + t - cam.eye[1], foot[2] - cam.eye[2]];
    return { z: t, depth: q[0] * cam.fwd[0] + q[1] * cam.fwd[1] + q[2] * cam.fwd[2] };
}

/** The connected parts (4-neighbour) of a mask inside a window: each one's pixel list, row by row. */
function components(m: ViewSilhouette, x0: number, y0: number, x1: number, y1: number): Array<{ pixels: number; ys: number; ye: number; rows: Map<number, number[]> }> {
    const W = m.width;
    const seen = new Uint8Array(m.width * m.height);
    const out: Array<{ pixels: number; ys: number; ye: number; rows: Map<number, number[]> }> = [];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const i = y * W + x;
        if (!m.mask[i] || seen[i]) continue;
        const stack = [i];
        seen[i] = 1;
        const rows = new Map<number, number[]>();
        let pixels = 0, ys = y, ye = y;
        while (stack.length) {
            const k = stack.pop()!;
            const kx = k % W, ky = (k - kx) / W;
            pixels++;
            ys = Math.min(ys, ky); ye = Math.max(ye, ky);
            (rows.get(ky) ?? rows.set(ky, []).get(ky)!).push(kx);
            for (const [nx, ny] of [[kx - 1, ky], [kx + 1, ky], [kx, ky - 1], [kx, ky + 1]]) {
                if (nx < x0 || ny < y0 || nx > x1 || ny > y1) continue;
                const n = ny * W + nx;
                if (m.mask[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
            }
        }
        out.push({ pixels, ys, ye, rows });
    }
    return out;
}

/** The runs [x0, x1] of a row's pixels. */
function runsOf(xs: number[]): Array<[number, number]> {
    const s = xs.slice().sort((a, b) => a - b);
    const runs: Array<[number, number]> = [];
    for (const x of s) { const last = runs[runs.length - 1]; if (last && x <= last[1] + 1) last[1] = Math.max(last[1], x); else runs.push([x, x]); }
    return runs;
}

/** One view's profile of the object standing on `axis`, or why it cannot be read. */
export function profileFromSilhouette(view: ViewSilhouette, axis: UprightAxis, P: SilhouetteParams = SILHOUETTE_PARAMS): SilhouetteProfile | { failed: string } {
    const cam = view.cam;
    const top: V3 = [axis.foot[0], axis.foot[1] + axis.heightM, axis.foot[2]];
    const pf = projectToFrame(cam, axis.foot), pt = projectToFrame(cam, top);
    if (!pf || !pt) return { failed: 'the object is behind the camera' };
    const axisRows = pf[1] - pt[1];
    if (axisRows < P.minPixelHeight) return { failed: `the object spans ${Math.round(axisRows)} px of height, under ${P.minPixelHeight}` };
    const halfPlan = axis.planM ? Math.max(axis.planM[0], axis.planM[1]) / 2 : 0;
    const searchPx = (Math.max(P.searchM, 2 * halfPlan) * cam.fx) / pf[2];
    const margin = axisRows * P.marginShare;
    const uAt = (y: number) => pt[0] + ((pf[0] - pt[0]) * (y - pt[1])) / Math.max(1e-6, pf[1] - pt[1]);
    const y0 = Math.max(0, Math.floor(pt[1] - margin)), y1 = Math.min(view.height - 1, Math.ceil(pf[1] + margin));
    const x0 = Math.max(0, Math.floor(Math.min(pt[0], pf[0]) - searchPx)), x1 = Math.min(view.width - 1, Math.ceil(Math.max(pt[0], pf[0]) + searchPx));
    if (x1 < x0 || y1 < y0) return { failed: 'the object is out of the frame' };
    const comps = components(view, x0, y0, x1, y1);
    // the part of the mask standing on the axis: covering the most of the axis's rows near it
    let best: (typeof comps)[number] | undefined, bestScore = 0;
    for (const c of comps) {
        let near = 0;
        for (const [y, xs] of c.rows) { const u = uAt(y); if (xs.some(x => Math.abs(x - u) <= searchPx)) near++; }
        // its own height against the axis's (the pose can be off by a metre: the mask need not overlap the projected rows)
        const cover = (c.ye - c.ys + 1) / axisRows;
        const score = near * (cover >= P.minCover ? 1 : 0);
        if (score > bestScore) { bestScore = score; best = c; }
    }
    if (!best) return { failed: `no part of the mask near the axis (within ${Math.round(searchPx)} px of it) is at least ${Math.round(P.minCover * 100)}% of its height tall` };
    const rowsSorted = [...best.rows.keys()].sort((a, b) => a - b);
    // the run nearest the axis in each row; the axis shifted onto the mask's own base
    const pick = (y: number, u: number) => {
        const runs = runsOf(best!.rows.get(y)!);
        let r = runs[0], dbest = Infinity;
        for (const q of runs) { const d = u < q[0] ? q[0] - u : u > q[1] ? u - q[1] : 0; if (d < dbest) { dbest = d; r = q; } }
        return r;
    };
    const baseRows = rowsSorted.slice(Math.floor(rowsSorted.length * (1 - P.baseShare)));
    const shiftPx = median(baseRows.map(y => { const r = pick(y, uAt(y)); return (r[0] + r[1]) / 2 - uAt(y); }));
    const footVisible = best.ye >= pf[1] - axisRows * P.footHiddenShare;
    const readRows: Array<{ z: number; half: number; off: number }> = [];
    for (const y of rowsSorted) {
        const ua = uAt(y) + shiftPx;
        const r = pick(y, ua);
        const wpx = r[1] - r[0] + 1;
        if (wpx < P.minRunPx) continue;
        const h = heightOnAxis(cam, ua, y + 0.5, axis.foot);
        if (!(h.depth > 0)) continue;
        readRows.push({ z: h.z, half: ((wpx / 2) * h.depth) / cam.fx, off: (((r[0] + r[1]) / 2 - ua) * h.depth) / cam.fx });
    }
    if (readRows.length < P.minPixelHeight / 2) return { failed: `only ${readRows.length} mask rows could be read` };
    // The ends are rims, not points on the axis: seen from above, the silhouette's lowest pixel is the base's near rim and
    // its highest the top's far rim (the near rim when the eye is below the top), each r tan(angle) off the axis's height.
    // Each end is read on the vertical through its rim, and the rows the rims' ellipses cover are left out (they are narrower
    // than the body: the rim's curve, not its width).
    const range = Math.max(0.1, Math.hypot(cam.eye[0] - axis.foot[0], cam.eye[2] - axis.foot[2]));
    const toCam: [number, number] = [(cam.eye[0] - axis.foot[0]) / range, (cam.eye[2] - axis.foot[2]) / range];
    const rBottom = median(readRows.slice(Math.floor(readRows.length * 0.9)).map(r => r.half)), rTop = median(readRows.slice(0, Math.max(1, Math.ceil(readRows.length * 0.05))).map(r => r.half));
    const above = cam.eye[1] > axis.foot[1] + axis.heightM;
    const rimLine = (r: number, side: number): V3 => [axis.foot[0] + toCam[0] * r * side, axis.foot[1], axis.foot[2] + toCam[1] * r * side];
    const zTop = heightOnAxis(cam, uAt(best.ys) + shiftPx, best.ys, rimLine(rTop, above ? -1 : 1)).z;
    const zBase = footVisible ? heightOnAxis(cam, uAt(best.ye) + shiftPx, best.ye + 1, rimLine(rBottom, 1)).z : 0;
    const photoHeightM = zTop - zBase;
    if (!(photoHeightM > 0.05)) return { failed: 'the mask has no height on the axis' };
    const scale = axis.heightM / photoHeightM;
    const baseRim = footVisible ? (rBottom * Math.abs(cam.eye[1] - axis.foot[1])) / range : 0;
    const topRim = (rTop * Math.abs(cam.eye[1] - (axis.foot[1] + zTop))) / range;
    const N = P.bins;
    const bins: Array<{ half: number[]; off: number[] }> = Array.from({ length: N }, () => ({ half: [], off: [] }));
    for (const r of readRows) {
        if (r.z < zBase + baseRim || r.z > zTop - topRim) continue;
        const t = (r.z - zBase) / photoHeightM;
        const k = Math.min(N - 1, Math.max(0, Math.floor(t * N)));
        if (t < -0.02 || t > 1.02) continue;
        bins[k].half.push(r.half); bins[k].off.push(r.off);
    }
    const samples: ProfileSample[] = bins.map((b, k) => ({ t: (k + 0.5) / N, halfWidthM: b.half.length ? r3(median(b.half) * scale) : NaN, offsetM: b.off.length ? r3(median(b.off) * scale) : NaN, rows: b.half.length }));
    const dir = cam.fwd;
    const ff = projectToFrame(cam, axis.foot)!;
    return {
        ...(view.id ? { id: view.id } : {}), samples, photoHeightM: r3(photoHeightM), scanHeightM: axis.heightM, scale: r3(scale),
        pixelHeight: best.ye - best.ys + 1, rangeM: r3(Math.hypot(axis.foot[0] - cam.eye[0], axis.foot[2] - cam.eye[2])),
        viewHeadingDeg: Math.round(((((Math.atan2(dir[0], -dir[2]) * 180) / Math.PI) % 360) + 360) % 360 * 10) / 10, footVisible,
        lateralShiftM: r3((shiftPx * ff[2]) / cam.fx), coverage: r3(samples.filter(s => s.rows > 0).length / N)
    };
}

export interface CombinedProfile {
    samples: Array<{ t: number; halfWidthM: number; offsetM: number; views: number; spread: number }>;
    /** Median over heights of the widths' spread across views (max - min over median): 0 when every side shows the same width. */
    viewSpread: number;
    /** Views from directions at least 30 degrees apart (a spread needs them). */
    distinctSides: number;
    /** The photo's height over the scan's, per view (the agreement of the two). */
    photoOverScan: number[];
    views: number;
}

const angleBetween = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

/**
 * The views' profiles as one: per height, the median width weighted by the pixel height of each view (a weighted median:
 * the width at which half the weight is on either side), and the spread across views. The offset is kept from the view
 * that sees the object tallest (it is a side of that view, so it is not combined across views).
 */
export function combineProfiles(profiles: SilhouetteProfile[]): CombinedProfile {
    const N = profiles[0]?.samples.length ?? 0;
    const lead = profiles.slice().sort((a, b) => b.pixelHeight - a.pixelHeight)[0];
    const samples = Array.from({ length: N }, (_, k) => {
        const got = profiles.map(p => ({ v: p.samples[k].halfWidthM, w: p.pixelHeight * (p.footVisible ? 1 : 0.7) })).filter(x => Number.isFinite(x.v)).sort((a, b) => a.v - b.v);
        let half = NaN;
        if (got.length) {
            const total = got.reduce((s, x) => s + x.w, 0);
            let acc = 0;
            for (const x of got) { acc += x.w; if (acc >= total / 2) { half = x.v; break; } }
        }
        const spread = got.length >= 2 && half > 0 ? (got[got.length - 1].v - got[0].v) / half : 0;
        return { t: (k + 0.5) / N, halfWidthM: r3(half), offsetM: lead ? lead.samples[k].offsetM : NaN, views: got.length, spread: r3(spread) };
    });
    const heads: number[] = [];
    for (const p of profiles) if (heads.every(h => angleBetween(h, p.viewHeadingDeg) >= 30)) heads.push(p.viewHeadingDeg);
    return {
        samples, viewSpread: r3(median(samples.filter(s => s.views >= 2).map(s => s.spread))) || 0, distinctSides: heads.length,
        photoOverScan: profiles.map(p => r3(p.photoHeightM / p.scanHeightM)), views: profiles.length
    };
}

/** Fills each unread height from the nearest read one (the profile is read where the mask is; the rest continues it). */
export function filledHalfWidths(samples: Array<{ halfWidthM: number }>): number[] {
    const v = samples.map(s => s.halfWidthM);
    const read = v.map((x, i) => (Number.isFinite(x) ? i : -1)).filter(i => i >= 0);
    if (!read.length) return v.map(() => NaN);
    return v.map((x, i) => (Number.isFinite(x) ? x : v[read.reduce((b, j) => (Math.abs(j - i) < Math.abs(b - i) ? j : b), read[0])]));
}

/** Douglas-Peucker on a polyline of [z, r] points: the points within `tol` metres of the simplified line are dropped. */
export function simplifyPolyline(pts: Array<[number, number]>, tol: number): Array<[number, number]> {
    if (pts.length <= 2) return pts.slice();
    const keep = new Uint8Array(pts.length);
    keep[0] = keep[pts.length - 1] = 1;
    const stack: Array<[number, number]> = [[0, pts.length - 1]];
    while (stack.length) {
        const [a, b] = stack.pop()!;
        const [ax, ay] = pts[a], [bx, by] = pts[b];
        const L = Math.hypot(bx - ax, by - ay) || 1e-9;
        let far = -1, dmax = tol;
        for (let i = a + 1; i < b; i++) {
            const d = Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / L;
            if (d > dmax) { dmax = d; far = i; }
        }
        if (far >= 0) { keep[far] = 1; stack.push([a, far], [far, b]); }
    }
    return pts.filter((_, i) => keep[i]);
}

/**
 * The meridian of a solid of revolution from half-widths per height: [height, radius] points from the foot (radius 0 at
 * the axis) to the top (back to the axis), simplified to within `tolM`, at most `maxPoints` long.
 */
export function meridianOf(halfWidths: number[], heightM: number, opts: { tolM?: number; maxPoints?: number } = {}): Array<[number, number]> {
    const N = halfWidths.length;
    const rMax = Math.max(...halfWidths.filter(Number.isFinite), 0.01);
    const body: Array<[number, number]> = halfWidths.map((r, k) => [((k + 0.5) / N) * heightM, Math.max(0.002, r)]);
    let tol = opts.tolM ?? Math.max(0.004, rMax * 0.02);
    const maxPoints = opts.maxPoints ?? 40;
    let line = simplifyPolyline([[0, body[0][1]], ...body, [heightM, body[N - 1][1]]], tol);
    while (line.length + 2 > maxPoints) { tol *= 1.5; line = simplifyPolyline(line, tol); }
    return [[0, 0], ...line.map(([z, r]) => [r3(z), r3(r)] as [number, number]), [r3(heightM), 0]];
}
