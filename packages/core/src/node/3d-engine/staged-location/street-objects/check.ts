/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Street objects, step 6 (check): is the rebuild closer to what Street View saw than the scan's blob?
 *
 * At each registered view the rebuild and the scan's own triangles of the member are drawn whole from the view's camera
 * (not behind the rest of the scan: the scan and the photo can disagree about what stands in front, and the photo's mask
 * already leaves out what really hid the object) and compared with the photo's mask of the object (read.ts):
 *   - silhouette IoU: drawn pixels against the mask;
 *   - colour: per height band (the rows the band spans on the member's axis), the CIE76 distance between the photo's median
 *     colour inside the mask and the rebuild's band colour, and between it and the scan's own photo texture as drawn.
 * Each drawn silhouette is first moved onto the photo's mask by whole pixels (its foot's middle onto the mask's foot when
 * the foot shows, else its top onto the mask's top): the views' poses can be off by a metre or two where the registration
 * could not pose them, and both arms stand at the scan's own place, so the score is of shape, not of the pose's error. The
 * shifts are reported. The reference is the Street View crop: the rebuild is kept when, over its views, it beats the scan's
 * blob on both scores (its IoU higher, and at least minIou; its colour distance smaller, both measured); else the scan stays, with the numbers as the reason. The photo is decoded in memory for the colour medians
 * and dropped.
 */

import type { FrameCamera } from '../../../spatial/StreetViewPoseRegistrar';
import { projectToFrame } from '../../../spatial/StreetViewPoseRegistrar';
import type { RenderMesh3D } from '../../../spatial/HeadlessMeshSilhouetteRenderer';
import { renderTriangles } from '../photo-match-eval';
import type { RgbaImage8, TileTriangles } from '../tile-texture-transfer';
import { deltaE76, srgbToLab, type ObjectLook } from './object-spec';
import type { V3 } from './families';

export const CHECK_PARAMS = {
    /** The views are drawn at this share of the photo's size. */
    renderScale: 0.5,
    /** Bands under this many photo pixels are not compared. */
    minBandPixels: 20,
    /**
     * And a rebuild must match the photos at least this well (silhouette IoU) to be kept, whatever the scan scores, and by
     * at least minIouGain more than the scan's blob (MAIN, 2026-11-09: at 0.3 a green cylinder on a grey disc passed for a
     * planter, a kiosk kept an orange bracket, bins barely read).
     */
    minIou: 0.5,
    minIouGain: 0.15
};

export interface ViewCheck {
    view: string;
    photoPixels: number;
    iouRebuild: number;
    iouScan: number;
    /** Pixel-weighted mean over bands of the colour distances; NaN when no band had pixels enough. */
    deltaERebuild: number;
    deltaEScan: number;
    /** The whole-pixel shifts (at the render's size) that moved each drawn silhouette onto the photo's mask. */
    shiftRebuildPx?: [number, number];
    shiftScanPx?: [number, number];
    /** With `keepMasks`: the three silhouettes at the render's size (the photo's mask, the rebuild's, the scan's), for overlays. */
    masks?: { width: number; height: number; photo: Uint8Array; rebuild: Uint8Array; scan: Uint8Array };
}

export interface FamilyCheck {
    views: ViewCheck[];
    iouRebuild: number;
    iouScan: number;
    deltaERebuild: number;
    deltaEScan: number;
    keep: boolean;
    reason: string;
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const r1 = (v: number) => Math.round(v * 10) / 10;

/**
 * An overlay of one view's check, holding no photo pixel: `background` (the scene's own render at the view's pose, sRGB8 RGBA
 * at the masks' size) with the outlines of the photo's mask (green), the scan's blob (red) and the rebuild (cyan).
 */
export function overlayOutlines(background: Uint8Array, masks: NonNullable<ViewCheck['masks']>): Uint8Array {
    const { width: W, height: H } = masks;
    const out = Uint8Array.from(background);
    const edge = (m: Uint8Array, k: number) => { const x = k % W, y = (k - x) / W; return m[k] && (x === 0 || y === 0 || x === W - 1 || y === H - 1 || !m[k - 1] || !m[k + 1] || !m[k - W] || !m[k + W]); };
    const paint = (m: Uint8Array, c: [number, number, number]) => { for (let k = 0; k < W * H; k++) if (edge(m, k)) for (const d of [0, 1, W, W + 1]) { const j = k + d; if (j < W * H) { out[j * 4] = c[0]; out[j * 4 + 1] = c[1]; out[j * 4 + 2] = c[2]; out[j * 4 + 3] = 255; } } };
    paint(masks.scan, [235, 60, 50]);
    paint(masks.rebuild, [40, 220, 240]);
    paint(masks.photo, [60, 230, 70]);
    return out;
}

/** The camera at `s` times the resolution. */
export function scaledCamera(cam: FrameCamera, s: number): FrameCamera {
    return { ...cam, fx: cam.fx * s, fy: cam.fy * s, cx: cam.cx * s, cy: cam.cy * s, width: Math.max(1, Math.round(cam.width * s)), height: Math.max(1, Math.round(cam.height * s)) };
}

/** A full-size mask downsampled by majority (the share of each target pixel's source pixels set, at least half). */
export function downsampleMask(mask: Uint8Array, width: number, height: number, w: number, h: number): Uint8Array {
    const out = new Uint8Array(w * h), cnt = new Uint16Array(w * h), tot = new Uint16Array(w * h);
    for (let y = 0; y < height; y++) {
        const ty = Math.min(h - 1, Math.floor((y * h) / height));
        for (let x = 0; x < width; x++) { const k = ty * w + Math.min(w - 1, Math.floor((x * w) / width)); tot[k]++; if (mask[y * width + x]) cnt[k]++; }
    }
    for (let k = 0; k < out.length; k++) out[k] = tot[k] && cnt[k] * 2 >= tot[k] ? 1 : 0;
    return out;
}

export function iou(a: Uint8Array, b: Uint8Array): number {
    let i = 0, u = 0;
    for (let k = 0; k < a.length; k++) { if (a[k] && b[k]) i++; if (a[k] || b[k]) u++; }
    return u ? i / u : 0;
}

/** A mask's anchor: the middle of its lowest rows (foot) or of its highest rows (top), in pixels; undefined when empty. */
export function maskAnchor(m: Uint8Array, W: number, H: number, at: 'foot' | 'top'): [number, number] | undefined {
    let y0 = -1, y1 = -1;
    for (let y = 0; y < H && y0 < 0; y++) for (let x = 0; x < W; x++) if (m[y * W + x]) { y0 = y; break; }
    for (let y = H - 1; y >= 0 && y1 < 0; y--) for (let x = 0; x < W; x++) if (m[y * W + x]) { y1 = y; break; }
    if (y0 < 0) return undefined;
    const band = Math.max(1, Math.round((y1 - y0 + 1) * 0.05));
    const xs: number[] = [];
    const ys = at === 'foot' ? [y1 - band + 1, y1] : [y0, y0 + band - 1];
    for (let y = ys[0]; y <= ys[1]; y++) for (let x = 0; x < W; x++) if (m[y * W + x]) xs.push(x);
    xs.sort((a, b) => a - b);
    return [xs[xs.length >> 1], at === 'foot' ? y1 : y0];
}

/** A mask moved by whole pixels. */
export function shiftMask(m: Uint8Array, W: number, H: number, dx: number, dy: number): Uint8Array {
    const o = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) { const sy = y - dy; if (sy < 0 || sy >= H) continue; for (let x = 0; x < W; x++) { const sx = x - dx; if (sx >= 0 && sx < W && m[sy * W + sx]) o[y * W + x] = 1; } }
    return o;
}

/** Median of Lab colours. */
function medianLab(xs: Array<[number, number, number]>): [number, number, number] {
    const m = (k: number) => { const s = xs.map(x => x[k]).sort((p, q) => p - q); return s[s.length >> 1]; };
    return [m(0), m(1), m(2)];
}

/**
 * One view's check. `photo` is the view's image decoded in memory (full size), `mask` the read's mask of the object
 * (full size). `rebuild` and `scan` are triangle soups in the tile frame (readTileTriangles); `context` (the tile mesh
 * without the member) is not drawn in the scores.
 */
export function checkView(input: {
    id: string; cam: FrameCamera; photo: RgbaImage8; mask: Uint8Array; rebuild: TileTriangles; scan: TileTriangles; context: RenderMesh3D;
    axis: { foot: V3; heightM: number }; bands: NonNullable<ObjectLook['bands']>; keepMasks?: boolean;
    /** What the silhouettes are aligned by (default 'foot'; 'top' when the photo hides the foot). */
    anchor?: 'foot' | 'top';
}, P = CHECK_PARAMS): ViewCheck {
    const cam = scaledCamera(input.cam, P.renderScale);
    const W = cam.width, H = cam.height;
    const photoMask = downsampleMask(input.mask, input.photo.width, input.photo.height, W, H);
    // both arms drawn whole: what the scan has in front can be gone in the photo, or the reverse (a different era), and the
    // photo's mask already leaves out what really hid the object; so neither arm is hidden by the scan's occluders
    const draw = (m: TileTriangles, clay: boolean) => renderTriangles([m], cam, { supersample: 1, ...(clay ? { clay: true } : {}) });
    const rb = draw(input.rebuild, true), sc = draw(input.scan, false);
    const sil = (r: { coverage: Float32Array }) => { const o = new Uint8Array(W * H); for (let k = 0; k < o.length; k++) o[k] = r.coverage[k] >= 0.5 ? 1 : 0; return o; };
    const anchor = input.anchor ?? 'foot';
    const target = maskAnchor(photoMask, W, H, anchor);
    const align = (m: Uint8Array): { mask: Uint8Array; shift: [number, number] } => {
        const a = target && maskAnchor(m, W, H, anchor);
        if (!target || !a) return { mask: m, shift: [0, 0] };
        const d: [number, number] = [target[0] - a[0], target[1] - a[1]];
        return { mask: shiftMask(m, W, H, d[0], d[1]), shift: d };
    };
    const rbA = align(sil(rb)), scA = align(sil(sc));
    const rbM = rbA.mask, scM = scA.mask;
    const scanRgbAt = (k: number) => { const x = (k % W) - scA.shift[0], y = Math.floor(k / W) - scA.shift[1]; const j = y * W + x; return x >= 0 && y >= 0 && x < W && y < H ? j : -1; };
    // t along the height, from the photo's mask itself (t 0 at its foot, 1 at its top; from its top when the foot is hidden,
    // scaled by the member's projected height), so the bands do not slide with the pose's error
    const pf = projectToFrame(cam, input.axis.foot), pt = projectToFrame(cam, [input.axis.foot[0], input.axis.foot[1] + input.axis.heightM, input.axis.foot[2]]);
    const rowsTall = pf && pt ? Math.max(1, pf[1] - pt[1]) : H;
    let my0 = -1, my1 = -1;
    for (let k = 0; k < photoMask.length; k++) if (photoMask[k]) { const y = Math.floor(k / W); if (my0 < 0) my0 = y; my1 = y; }
    const tOf = (y: number) => (my0 < 0 ? 0.5 : anchor === 'foot' ? (my1 + 1 - y) / Math.max(1, my1 + 1 - my0) : 1 - (y - my0) / rowsTall);
    const bands = input.bands.length ? input.bands : [];
    const sx = input.photo.width / W, sy = input.photo.height / H;
    const photoBy: Array<Array<[number, number, number]>> = bands.map(() => []), scanBy: Array<Array<[number, number, number]>> = bands.map(() => []);
    let photoPixels = 0;
    for (let y = 0; y < H; y++) {
        const t = tOf(y + 0.5);
        const b = bands.findIndex(x => t >= x.fromT && t < x.toT);
        for (let x = 0; x < W; x++) {
            const k = y * W + x;
            if (photoMask[k]) {
                photoPixels++;
                if (b >= 0) { const i = (Math.min(input.photo.height - 1, Math.floor((y + 0.5) * sy)) * input.photo.width + Math.min(input.photo.width - 1, Math.floor((x + 0.5) * sx))) * 4; photoBy[b].push(srgbToLab([input.photo.rgba[i], input.photo.rgba[i + 1], input.photo.rgba[i + 2]])); }
            }
            if (scM[k] && b >= 0) { const j = scanRgbAt(k); if (j >= 0) scanBy[b].push(srgbToLab([sc.rgba[j * 4], sc.rgba[j * 4 + 1], sc.rgba[j * 4 + 2]])); }
        }
    }
    let wR = 0, sR = 0, wS = 0, sS = 0;
    bands.forEach((band, b) => {
        if (photoBy[b].length < P.minBandPixels) return;
        const ph = medianLab(photoBy[b]);
        const w = photoBy[b].length;
        wR += w; sR += w * deltaE76(ph, srgbToLab(band.srgb));
        if (scanBy[b].length >= P.minBandPixels) { wS += w; sS += w * deltaE76(ph, medianLab(scanBy[b])); }
    });
    return {
        view: input.id, photoPixels, iouRebuild: r3(iou(rbM, photoMask)), iouScan: r3(iou(scM, photoMask)), deltaERebuild: wR ? r1(sR / wR) : NaN, deltaEScan: wS ? r1(sS / wS) : NaN,
        shiftRebuildPx: rbA.shift, shiftScanPx: scA.shift,
        ...(input.keepMasks ? { masks: { width: W, height: H, photo: photoMask, rebuild: rbM, scan: scM } } : {})
    };
}

/** The family's verdict over its views (pixel-weighted means). */
export function judgeFamily(all: ViewCheck[], P = CHECK_PARAMS): FamilyCheck {
    const views = all.map(({ masks: _m, ...v }) => v);
    const w = views.reduce((s, v) => s + v.photoPixels, 0) || 1;
    const mean = (f: (v: ViewCheck) => number) => { let s = 0, n = 0; for (const v of views) { const x = f(v); if (Number.isFinite(x)) { s += x * v.photoPixels; n += v.photoPixels; } } return n ? s / n : NaN; };
    const iouR = mean(v => v.iouRebuild), iouS = mean(v => v.iouScan), dR = mean(v => v.deltaERebuild), dS = mean(v => v.deltaEScan);
    if (!views.length || !Number.isFinite(iouR)) return { views, iouRebuild: NaN, iouScan: NaN, deltaERebuild: NaN, deltaEScan: NaN, keep: false, reason: 'no view had a mask of the object to check against' };
    // the reference is the Street View crop: the rebuild must beat the scan's blob on both scores, each measured
    const shapeBetter = iouR > iouS;
    const colourMeasured = Number.isFinite(dR) && Number.isFinite(dS);
    const colourBetter = colourMeasured && dR < dS;
    const fits = iouR >= P.minIou && iouR - iouS >= P.minIouGain;
    const keep = shapeBetter && colourBetter && fits;
    const say = `silhouette IoU ${r3(iouR)} rebuilt against ${r3(iouS)} scanned; colour ΔE ${Number.isFinite(dR) ? r1(dR) : 'n/a'} rebuilt against ${Number.isFinite(dS) ? r1(dS) : 'n/a'} scanned, over ${views.length} view${views.length === 1 ? '' : 's'} (${w} photo pixels)`;
    return {
        views, iouRebuild: r3(iouR), iouScan: r3(iouS), deltaERebuild: r1(dR), deltaEScan: r1(dS), keep,
        reason: keep ? `kept: ${say}` : `the scan stays: ${!shapeBetter ? 'the rebuild\'s silhouette is no closer to the photos' : !fits ? (iouR < P.minIou ? `the rebuild matches the photos under IoU ${P.minIou}` : `the rebuild's silhouette is less than ${P.minIouGain} closer to the photos than the scan's`) : !colourMeasured ? 'the colours could not both be measured against the photos' : 'the rebuild\'s colour is no closer to the photos'} (${say})`
    };
}
