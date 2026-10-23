/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline G, the check: a wall's reading drawn back into its own survey plate's metric frame and compared with what the
 * stations saw there. The reading becomes a label raster (wall, opening, projecting element), its outlines the build's
 * edges; the plate's luminance gradients over the texels a station saw are the photo's edges. Precision is the share of the
 * build's edges within CHECK_TOL_M of a photo edge (what was built is where the photo shows something), recall the share of
 * the photo's strong edges within CHECK_TOL_M of a built one (what the photo shows was built). Opening contrast says whether
 * the openings sit on what the photo shows darker than the wall around them, in pooled standard deviations. Explained is the
 * share of the plate's luminance variance the labels account for: on repeating facades it separates a reading in place from
 * the same reading displaced far better than the edge scores do (CONTROL_SHIFTS), so it decides a re-read. Deterministic,
 * no model call: it scores a reading, picks between two readings of one wall, and gives every change to the reading a number.
 * Nothing here knows what the wall is: it compares outlines and luminance.
 */

import type { FacadeProgram } from './read';

/** Plate resolution (plates.ts PLATE_PIXEL_M). */
const PX = 0.05;
/** An edge of the build counts as found when a photo edge lies this close (and the other way round). */
export const CHECK_TOL_M = 0.15;
/** The photo's edges: the strongest share of the seen texels' luminance gradients, above an absolute floor. */
export const PHOTO_EDGE_SHARE = 0.2;
export const PHOTO_EDGE_MIN = 12;
/**
 * The control: the same reading moved out of place by these (du, dh) metres. A reading in place explains clearly more of the
 * plate than its displaced copies; measured on the cached plates of five G runs (2026-10-22): readings that built well
 * explained 0.11 to 0.30 against 0.03 to 0.07 displaced, and the reading of a wall that built as a blank box 0.001 to 0.04.
 */
export const CONTROL_SHIFTS: ReadonlyArray<readonly [number, number]> = [[0.6, 0], [1.3, 0], [0, 0.8], [0.9, 1.5], [-0.7, -0.6]];
/** A reading is read again when it explains less than this share of its plate, or no more than LIFT_MIN times its displaced copies. */
export const REREAD_BELOW_EXPLAINED = 0.05;
export const LIFT_MIN = 1.5;

/** One shape of a reading in the plate's frame: u metres from its left edge, h metres up from its bottom. */
export interface CheckShape { kind: 'opening' | 'member'; u0: number; u1: number; h0: number; h1: number; archRise?: number }

export interface WallCheck {
    precision: number;
    recall: number;
    /** Harmonic mean of precision and recall. */
    f: number;
    /** (wall luminance - opening luminance) / pooled std over seen texels; NaN with no seen opening or wall texel. */
    openingContrast: number;
    /** Share of the seen texels' luminance variance the reading's labels (wall, member, opening) explain. */
    explained: number;
    buildEdges: number;
    photoEdges: number;
    /** Share of the plate a station saw. */
    seen: number;
}

/** The plate as the check reads it: RGB rows from the top, and which texels a station saw. */
export interface CheckPlate { w: number; h: number; rgb: Uint8Array; seen: Uint8Array }

/** The shapes a reading draws: every opening (seen or continued) and every projecting member's footprint. */
export function programShapes(prog: FacadeProgram): CheckShape[] {
    const out: CheckShape[] = [];
    for (const row of prog.openings ?? []) {
        const h0 = Number(row.h0), h1 = Number(row.h1);
        if (!(h1 > h0)) continue;
        for (const c of [...(row.cols ?? []), ...(row.filledCols ?? [])]) {
            const u0 = Number(c?.[0]), u1 = Number(c?.[1]);
            if (!(u1 > u0)) continue;
            out.push({ kind: 'opening', u0, u1, h0, h1, archRise: Math.max(0, Math.min(Number(row.archRise) || 0, (u1 - u0) / 2)) });
            // a sill and a surround's jambs are projecting members beside the opening
            const sOut = Number(row.sill?.out), sH = Number(row.sill?.height ?? 0.1), ov = Number(row.sill?.overhang ?? 0.05);
            if (sOut > 0 && sH > 0) out.push({ kind: 'member', u0: u0 - ov, u1: u1 + ov, h0: h0 - sH, h1: h0 });
            const jw = Number(row.surround?.width);
            if (jw > 0 && Number(row.surround?.out) > 0) out.push({ kind: 'member', u0: u0 - jw, u1: u0, h0, h1: h1 - (Number(row.archRise) || 0) }, { kind: 'member', u0: u1, u1: u1 + jw, h0, h1: h1 - (Number(row.archRise) || 0) });
        }
    }
    const span = (prof: number[][] | undefined): [number, number] | undefined => {
        const ds = (prof ?? []).filter(q => Array.isArray(q) && q.length >= 2 && Number.isFinite(+q[0])).map(q => +q[0]);
        return ds.length >= 2 && (prof ?? []).some(q => +q[1] > 0.005) ? [Math.min(...ds), Math.max(...ds)] : undefined;
    };
    for (const b of prog.horizontal ?? []) {
        const s = span(b.profile);
        if (s && Number(b.u1) > Number(b.u0)) out.push({ kind: 'member', u0: Number(b.u0), u1: Number(b.u1), h0: Number(b.h) + s[0], h1: Number(b.h) + s[1] });
    }
    for (const v of prog.vertical ?? []) {
        const s = span(v.profile);
        if (!s || !(Number(v.h1) > Number(v.h0))) continue;
        for (const u of [...(v.u ?? []), ...(v.filledU ?? [])].map(Number).filter(Number.isFinite)) out.push({ kind: 'member', u0: u + s[0], u1: u + s[1], h0: Number(v.h0), h1: Number(v.h1) });
    }
    return out;
}

function inShape(o: CheckShape, u: number, h: number): boolean {
    if (u < o.u0 || u > o.u1 || h < o.h0 || h > o.h1) return false;
    const half = (o.u1 - o.u0) / 2, rise = Math.min(o.archRise ?? 0, half, 0.95 * (o.h1 - o.h0));
    if (rise < 0.01 || h <= o.h1 - rise) return true;
    const r = (half * half + rise * rise) / (2 * rise), cu = (o.u0 + o.u1) / 2, ch = o.h1 - r;
    return (u - cu) ** 2 + (h - ch) ** 2 <= r * r;
}

/** Label raster: 0 wall, 1 projecting member, 2 opening (openings drawn last: a hole through a band is still a hole). */
export function labelRaster(w: number, h: number, shapes: CheckShape[]): Uint8Array {
    const lab = new Uint8Array(w * h);
    for (const pass of ['member', 'opening'] as const) {
        for (const o of shapes) {
            if (o.kind !== pass) continue;
            const x0 = Math.max(0, Math.floor(o.u0 / PX)), x1 = Math.min(w - 1, Math.ceil(o.u1 / PX));
            const y0 = Math.max(0, Math.floor(h - o.h1 / PX)), y1 = Math.min(h - 1, Math.ceil(h - o.h0 / PX));
            for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
                if (inShape(o, (x + 0.5) * PX, (h - y - 0.5) * PX)) lab[y * w + x] = pass === 'opening' ? 2 : 1;
            }
        }
    }
    return lab;
}

/** City-block-ish chamfer distance (3-4 weights, in texels) to the nearest set texel. */
export function distanceTo(mask: Uint8Array, w: number, h: number): Float32Array {
    const INF = 1e9, d = new Float32Array(w * h);
    for (let i = 0; i < d.length; i++) d[i] = mask[i] ? 0 : INF;
    const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? INF : d[y * w + x]);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!d[i]) continue;
        d[i] = Math.min(d[i], at(x - 1, y) + 3, at(x, y - 1) + 3, at(x - 1, y - 1) + 4, at(x + 1, y - 1) + 4);
    }
    for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
        const i = y * w + x;
        if (!d[i]) continue;
        d[i] = Math.min(d[i], at(x + 1, y) + 3, at(x, y + 1) + 3, at(x + 1, y + 1) + 4, at(x - 1, y + 1) + 4);
    }
    for (let i = 0; i < d.length; i++) d[i] /= 3;
    return d;
}

/** The photo's edges: strong luminance gradients where the texel and its neighbours were all seen. */
export function photoEdges(p: CheckPlate): Uint8Array {
    const { w, h } = p;
    const L = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) L[i] = 0.299 * p.rgb[i * 3] + 0.587 * p.rgb[i * 3 + 1] + 0.114 * p.rgb[i * 3 + 2];
    const g = new Float32Array(w * h);
    const vals: number[] = [];
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (!p.seen[i] || !p.seen[i - 1] || !p.seen[i + 1] || !p.seen[i - w] || !p.seen[i + w]) continue;
        const gx = L[i - w + 1] + 2 * L[i + 1] + L[i + w + 1] - L[i - w - 1] - 2 * L[i - 1] - L[i + w - 1];
        const gy = L[i + w - 1] + 2 * L[i + w] + L[i + w + 1] - L[i - w - 1] - 2 * L[i - w] - L[i - w + 1];
        g[i] = Math.hypot(gx, gy) / 4;
        vals.push(g[i]);
    }
    const out = new Uint8Array(w * h);
    if (!vals.length) return out;
    vals.sort((a, b) => a - b);
    const thr = Math.max(PHOTO_EDGE_MIN, vals[Math.floor(vals.length * (1 - PHOTO_EDGE_SHARE))]);
    for (let i = 0; i < w * h; i++) if (g[i] >= thr) out[i] = 1;
    return out;
}

/** Scores the shapes of one reading against its plate. */
export function checkWall(p: CheckPlate, shapes: CheckShape[]): WallCheck {
    const { w, h } = p;
    const lab = labelRaster(w, h, shapes);
    const built = new Uint8Array(w * h);
    let seen = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (p.seen[i]) seen++;
        if (!p.seen[i]) continue;
        if ((x + 1 < w && lab[i + 1] !== lab[i]) || (y + 1 < h && lab[i + w] !== lab[i])) built[i] = 1;
    }
    const photo = photoEdges(p);
    const dPhoto = distanceTo(photo, w, h), dBuilt = distanceTo(built, w, h);
    const tol = CHECK_TOL_M / PX + 1e-6;
    let nb = 0, hitB = 0, np = 0, hitP = 0;
    for (let i = 0; i < w * h; i++) {
        if (built[i]) { nb++; if (dPhoto[i] <= tol) hitB++; }
        if (photo[i]) { np++; if (dBuilt[i] <= tol) hitP++; }
    }
    const precision = nb ? hitB / nb : 0, recall = np ? hitP / np : 0;
    // opening contrast: are the openings where the photo is darker than the wall? and how much of the photo's luminance the
    // labels explain (between-label variance over total: a reading out of place explains less)
    let sw = 0, sw2 = 0, cw = 0, so = 0, so2 = 0, co = 0;
    const gs = [0, 0, 0], gn = [0, 0, 0];
    let tot = 0, tot2 = 0, nt = 0;
    for (let i = 0; i < w * h; i++) {
        if (!p.seen[i]) continue;
        const l = 0.299 * p.rgb[i * 3] + 0.587 * p.rgb[i * 3 + 1] + 0.114 * p.rgb[i * 3 + 2];
        gs[lab[i]] += l; gn[lab[i]]++; tot += l; tot2 += l * l; nt++;
        if (lab[i] === 2) { so += l; so2 += l * l; co++; } else if (lab[i] === 0) { sw += l; sw2 += l * l; cw++; }
    }
    const mean = nt ? tot / nt : 0, totVar = nt ? tot2 / nt - mean * mean : 0;
    let between = 0;
    for (let k = 0; k < 3; k++) if (gn[k]) between += (gn[k] / nt) * (gs[k] / gn[k] - mean) ** 2;
    const explained = totVar > 1e-6 ? between / totVar : 0;
    let openingContrast = NaN;
    if (co && cw) {
        const mo = so / co, mw = sw / cw;
        const pooled = Math.sqrt(Math.max(1e-6, (so2 / co - mo * mo + sw2 / cw - mw * mw) / 2));
        openingContrast = (mw - mo) / pooled;
    }
    const r3 = (v: number) => Math.round(v * 1000) / 1000;
    return {
        precision: r3(precision), recall: r3(recall), f: r3(precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0),
        openingContrast: Number.isNaN(openingContrast) ? NaN : r3(openingContrast), explained: r3(explained), buildEdges: nb, photoEdges: np, seen: r3(seen / (w * h))
    };
}

export interface ReadingCheck extends WallCheck {
    /** Mean explained share of the reading's displaced copies (CONTROL_SHIFTS). */
    displaced: number;
    /** explained / displaced (Infinity when the copies explain nothing). */
    lift: number;
    /** The reading should be read again. */
    weak: boolean;
}

/** Scores a reading against its plate and against its own displaced copies. */
export function checkReading(p: CheckPlate, prog: FacadeProgram): ReadingCheck {
    const shapes = programShapes(prog);
    const c = checkWall(p, shapes);
    const displaced = CONTROL_SHIFTS.reduce((a, [du, dh]) => a + checkWall(p, shapes.map(s => ({ ...s, u0: s.u0 + du, u1: s.u1 + du, h0: s.h0 + dh, h1: s.h1 + dh }))).explained, 0) / CONTROL_SHIFTS.length;
    const lift = displaced > 1e-6 ? c.explained / displaced : c.explained > 0 ? Infinity : 0;
    return { ...c, displaced: Math.round(displaced * 1000) / 1000, lift: Number.isFinite(lift) ? Math.round(lift * 100) / 100 : lift, weak: c.explained < REREAD_BELOW_EXPLAINED || lift <= LIFT_MIN };
}

/** The check's view of a survey plate: a texel was seen when its relief was measured. */
export function checkPlate(pl: { w: number; h: number; rgb: Uint8Array; relief: Float32Array }): CheckPlate {
    const seen = new Uint8Array(pl.w * pl.h);
    for (let i = 0; i < seen.length; i++) if (!Number.isNaN(pl.relief[i])) seen[i] = 1;
    return { w: pl.w, h: pl.h, rgb: pl.rgb, seen };
}
