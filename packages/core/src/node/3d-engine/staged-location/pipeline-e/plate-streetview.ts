/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline E, enhanced mode: a Street View photo as the reference and the check of a wall's redraw at street level.
 *
 * The scan's photo is aerial: a wall's lower storeys are what it sees worst, and what an image model is most tempted to
 * invent. A street-level photo shows them. For each wall:
 *
 *   - the views are the Street View survey's, registered against the tile mesh (edges, then jointly) and cut out by the
 *     ownership and occluder masks (streetview-registered-views.ts); a view whose pose stayed nominal (about ±2 m) is not used;
 *   - rectifyViewOntoWall: every wall texel is projected into the photo through its pose (and the joint registration's
 *     warp); a texel takes the photo's pixel where the pixel is owned (the structure, nothing in front of it) and the
 *     massing is the nearest surface there;
 *   - bestStreetViewForWall: the view that sees most of the wall's street-level band (STREET_LEVEL_M above its foot), each
 *     texel weighted by how square-on and how sharp the photo sees it;
 *   - streetViewCrop: the photo cropped to the wall, what is not owned set to grey: the model's extra reference image;
 *   - verifyAgainstPhoto: in the street-level band, the rectified photo (moved by the shift, within MAX_PHOTO_SHIFT_M, that
 *     best correlates its structure with the plate's) against the plate and against the input, per cell over a window of
 *     PHOTO_HALO cells each side. Where the input agrees with the photo clearly better than the plate does, structurally or
 *     in colour, the plate contradicts the photo there; where the plate agrees with the photo at least as well as the input
 *     and well in absolute terms, the photo supports it.
 */

import type { ProjectionView } from '../../../../common/spatial/texture-pass-contracts';
import { encodePng } from '../png-encode';
import { resizeRgba } from '../texture-enhance';
import { project } from './colour-transfer';
import { maskedBlur } from './image-ops';
import { bandPass, cellGrid, labPlanes, robustAffine, windowStructure, MAX_TONE_DE, MIN_CONTRAST_L, type CellGrid } from './plate-audit';
import type { MassingFace } from './native-massing';

/** The street-level band: texels up to this height above the wall's foot. */
export const STREET_LEVEL_M = 9;
/** A view must show at least this share of the band to guide or check the wall. */
export const MIN_BAND_COVER = 0.2;
/** The rectified photo may move this far against the plate before the comparison (the registered pose's residual). */
export const MAX_PHOTO_SHIFT_M = 1;
/** Cells each side of a cell in the photo comparison's window (the pose is rougher than the plate's alignment). */
export const PHOTO_HALO = 2;
/** The input agrees with the photo's structure this much better (NCC) than the plate: the plate contradicts the photo. */
export const CONTRADICT_NCC_MARGIN = 0.25;
/** ... or its colour this much better (CIELAB distance, after a global colour map each): the plate contradicts the photo. */
export const CONTRADICT_TONE_MARGIN = 10;
/** The plate's structure correlates at least this well with the photo's (and no worse than the input's): the photo supports it. */
export const SUPPORT_NCC = 0.3;
/** The depth test: the massing must be the nearest surface within this, metres. */
export const DEPTH_TOLERANCE_M = 1.2;

export type GuideView = ProjectionView & { registration?: { method: string; residualM: number | null }; depth?: Float32Array };

export interface RectifiedPhoto {
    panoId: string;
    rgba: Uint8Array;
    /** 1 where the photo shows the wall (owned, nearest surface, in frame). */
    valid: Uint8Array;
    /** Median photo pixels per metre on the wall where valid. */
    pxPerM: number;
    /** Share of the street-level band's texels valid. */
    bandCover: number;
    /** Sum over valid band texels of (cos incidence x min(1, pxPerM / 40)): the view's worth for this wall. */
    score: number;
    /** The photo's pixel box of the valid texels [x0, y0, x1, y1). */
    photoBox: [number, number, number, number];
}

/** Rows [0, y) of the wall's texture at most STREET_LEVEL_M above its foot: returns the first such row (the band is rows >= it). */
export function streetBandTop(face: MassingFace): number {
    const foot = Number.isFinite(face.tBottom) ? Math.min(face.tBottom, face.tMin) : face.tMin;
    const tTop = foot + STREET_LEVEL_M;
    return Math.max(0, Math.min(face.height, Math.floor((face.orthoTMax - tTop) / face.pixel)));
}

function warpAt(w: NonNullable<ProjectionView['warp']>, W: number, H: number, x: number, y: number): [number, number] {
    const fx = Math.max(0, Math.min(w.gw - 1, (x / W) * (w.gw - 1))), fy = Math.max(0, Math.min(w.gh - 1, (y / H) * (w.gh - 1)));
    const i0 = Math.min(w.gw - 2, Math.floor(fx)), j0 = Math.min(w.gh - 2, Math.floor(fy)), a = fx - i0, b = fy - j0;
    const at = (arr: Float32Array, i: number, j: number) => arr[j * w.gw + i];
    const lerp = (arr: Float32Array) => (1 - a) * (1 - b) * at(arr, i0, j0) + a * (1 - b) * at(arr, i0 + 1, j0) + (1 - a) * b * at(arr, i0, j0 + 1) + a * b * at(arr, i0 + 1, j0 + 1);
    return [lerp(w.dx), lerp(w.dy)];
}

/** The photo resampled onto the wall's texture grid (W x H = the face's ortho), see the file comment. */
export function rectifyViewOntoWall(face: MassingFace, v: GuideView, bandTop = streetBandTop(face)): RectifiedPhoto {
    const W = face.width, H = face.height, cam = v.camera, img = v.image;
    const rgba = new Uint8Array(W * H * 4), valid = new Uint8Array(W * H);
    const ppm: number[] = [];
    let score = 0, bandValid = 0, bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const s = face.orthoSMin + (x + 0.5) * face.pixel, t = face.orthoTMax - (y + 0.5) * face.pixel;
        const p: [number, number, number] = [face.origin[0] + face.axisS[0] * s + face.axisT[0] * t, face.origin[1] + face.axisS[1] * s + face.axisT[1] * t, face.origin[2] + face.axisS[2] * s + face.axisT[2] * t];
        const toCam = [cam.eye[0] - p[0], cam.eye[1] - p[1], cam.eye[2] - p[2]];
        const dist = Math.hypot(toCam[0], toCam[1], toCam[2]);
        const cos = (toCam[0] * face.normal[0] + toCam[1] * face.normal[1] + toCam[2] * face.normal[2]) / dist;
        if (cos <= 0.15) continue;
        const q = project(cam, p);
        if (!q) continue;
        let u = q.u, w = q.v;
        if (u < 1 || w < 1 || u >= cam.width - 2 || w >= cam.height - 2) continue;
        const pi = Math.floor(w) * cam.width + Math.floor(u);
        if (v.ownerMask && !v.ownerMask[pi]) continue;
        if (v.depth && !(Math.abs(v.depth[pi] - q.z) < DEPTH_TOLERANCE_M)) continue;
        if (v.warp) { const d = warpAt(v.warp, cam.width, cam.height, u, w); u = Math.max(0, Math.min(cam.width - 1.001, u + d[0])); w = Math.max(0, Math.min(cam.height - 1.001, w + d[1])); }
        const x0 = Math.floor(u), y0 = Math.floor(w), fx = u - x0, fy = w - y0, iw = img.width;
        const i = y * W + x;
        for (let c = 0; c < 3; c++) {
            const val = (1 - fx) * (1 - fy) * img.rgba[(y0 * iw + x0) * 4 + c] + fx * (1 - fy) * img.rgba[(y0 * iw + x0 + 1) * 4 + c] + (1 - fx) * fy * img.rgba[((y0 + 1) * iw + x0) * 4 + c] + fx * fy * img.rgba[((y0 + 1) * iw + x0 + 1) * 4 + c];
            rgba[i * 4 + c] = Math.round(val);
        }
        rgba[i * 4 + 3] = 255;
        valid[i] = 1;
        const pxPerM = (cam.fx / q.z) * cos;
        if ((x + y) % 7 === 0) ppm.push(pxPerM);
        bx0 = Math.min(bx0, u); by0 = Math.min(by0, w); bx1 = Math.max(bx1, u + 1); by1 = Math.max(by1, w + 1);
        if (y >= bandTop) { bandValid++; score += cos * Math.min(1, pxPerM / 40); }
    }
    ppm.sort((a, b) => a - b);
    const bandTexels = W * Math.max(0, H - bandTop);
    return {
        panoId: v.panoId, rgba, valid, pxPerM: ppm.length ? ppm[ppm.length >> 1] : 0, bandCover: bandTexels ? bandValid / bandTexels : 0, score: score * face.pixel * face.pixel,
        photoBox: Number.isFinite(bx0) ? [Math.floor(bx0), Math.floor(by0), Math.ceil(bx1), Math.ceil(by1)] : [0, 0, 0, 0]
    };
}

/** The registered view that shows most of the wall's street-level band (or undefined, with the reason). */
export function bestStreetViewForWall(face: MassingFace, views: GuideView[]): { view?: GuideView; rect?: RectifiedPhoto; why: string; considered: number } {
    const registered = views.filter(v => v.registration && v.registration.method !== 'nominal' && v.ownerMask?.some(x => x));
    if (!views.length) return { why: 'no Street View photo of the structure', considered: 0 };
    if (!registered.length) return { why: `none of the ${views.length} Street View photos has a registered pose and an ownership mask`, considered: 0 };
    const bandTop = streetBandTop(face);
    let best: { view: GuideView; rect: RectifiedPhoto } | undefined;
    for (const v of registered) {
        const rect = rectifyViewOntoWall(face, v, bandTop);
        if (rect.bandCover < MIN_BAND_COVER) continue;
        if (!best || rect.score > best.rect.score) best = { view: v, rect };
    }
    if (!best) return { why: `no registered photo shows ${(100 * MIN_BAND_COVER).toFixed(0)}% of the wall's street-level band`, considered: registered.length };
    return { ...best, why: `Street View ${best.view.panoId} (${best.view.registration!.method} pose) shows ${(100 * best.rect.bandCover).toFixed(0)}% of the street-level band at ${best.rect.pxPerM.toFixed(0)} px/m`, considered: registered.length };
}

/** The photo cropped to the wall's pixels (padded 4 %), what the ownership mask does not keep set to mid-grey, at most maxSide px; PNG. */
export function streetViewCrop(v: GuideView, rect: RectifiedPhoto, maxSide = 768): Uint8Array {
    const cam = v.camera, img = v.image;
    const [bx0, by0, bx1, by1] = rect.photoBox;
    const padX = Math.round(0.04 * (bx1 - bx0)), padY = Math.round(0.04 * (by1 - by0));
    const x0 = Math.max(0, bx0 - padX), y0 = Math.max(0, by0 - padY), x1 = Math.min(cam.width, bx1 + padX), y1 = Math.min(cam.height, by1 + padY);
    const w = Math.max(8, x1 - x0), h = Math.max(8, y1 - y0);
    const out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const sx = Math.min(img.width - 1, x0 + x), sy = Math.min(img.height - 1, y0 + y), si = sy * img.width + sx, o = (y * w + x) * 4;
        const owned = !v.ownerMask || v.ownerMask[sy * cam.width + sx];
        for (let c = 0; c < 3; c++) out[o + c] = owned ? img.rgba[si * 4 + c] : 128;
        out[o + 3] = 255;
    }
    const k = Math.min(1, maxSide / Math.max(w, h));
    const r = resizeRgba({ width: w, height: h, rgba: out }, Math.max(8, Math.round(w * k)), Math.max(8, Math.round(h * k)));
    return new Uint8Array(encodePng(r.width, r.height, Buffer.from(r.rgba), 4));
}

function shifted<T extends Uint8Array | Float32Array>(a: T, W: number, H: number, dx: number, dy: number, ch: number, fill: number): T {
    const out = new (a.constructor as new (n: number) => T)(a.length);
    if (fill) out.fill(fill as never);
    for (let y = 0; y < H; y++) {
        const sy = y - dy;
        if (sy < 0 || sy >= H) continue;
        for (let x = 0; x < W; x++) {
            const sx = x - dx;
            if (sx < 0 || sx >= W) continue;
            for (let c = 0; c < ch; c++) out[(y * W + x) * ch + c] = a[(sy * W + sx) * ch + c];
        }
    }
    return out;
}

export interface PhotoCheck {
    panoId: string;
    shiftPx: [number, number];
    /** Per cell: 'contradicts-photo', 'supported' or '' (not covered, or no verdict). */
    verdict: string[];
    grid: CellGrid;
    /** Mean NCC over the compared cells: the plate's and the input's structure against the photo's. */
    nccPlate: number;
    nccInput: number;
    comparedCells: number;
    supportedCells: number;
    contradictedCells: number;
}

/** CIELAB distance per pixel of `a` (mapped onto `ref` by one robust affine map per channel) from `ref`, low-passed. */
function toneDistance(a: Uint8Array, ref: Uint8Array, W: number, H: number, use: Uint8Array, r: number): Float32Array {
    const A = labPlanes(a, W * H), R = labPlanes(ref, W * H);
    const al = A.map(p => maskedBlur(p, use, W, H, r)), rl = R.map(p => maskedBlur(p, use, W, H, r));
    const maps = [0, 1, 2].map(c => robustAffine(al[c], rl[c], use));
    const d = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) { let s = 0; for (let c = 0; c < 3; c++) { const x = maps[c].a * al[c][i] + maps[c].b - rl[c][i]; s += x * x; } d[i] = Math.sqrt(s); }
    return d;
}

/**
 * The plate against the rectified photo in the street-level band (see the file comment). `input` and `plate` are the
 * wall's texture before and after the redraw (W x H RGBA8), `use` the texels the tile covers.
 */
export function verifyAgainstPhoto(input: Uint8Array, plate: Uint8Array, rect: RectifiedPhoto, W: number, H: number, use: Uint8Array, pixelM: number, bandTop: number): PhotoCheck {
    const g = cellGrid(W, H, use, pixelM);
    // the shift that best correlates the photo's band structure with the plate's, on the band
    const both = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) both[i] = use[i] && rect.valid[i] && Math.floor(i / W) >= bandTop ? 1 : 0;
    const Lp = labPlanes(plate, W * H)[0], Li = labPlanes(input, W * H)[0], Lf = labPlanes(rect.rgba, W * H)[0];
    const bpPlate = bandPass(Lp, use, W, H, pixelM), bpInput = bandPass(Li, use, W, H, pixelM), bpPhoto0 = bandPass(Lf, rect.valid, W, H, pixelM);
    const R = Math.round(MAX_PHOTO_SHIFT_M / pixelM), step = Math.max(1, Math.round(R / 8));
    const corr = (dx: number, dy: number) => {
        let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
        for (let y = bandTop; y < H; y += 2) {
            const sy = y - dy;
            if (sy < 0 || sy >= H) continue;
            for (let x = 0; x < W; x += 2) {
                const sx = x - dx;
                if (sx < 0 || sx >= W) continue;
                const j = sy * W + sx, i = y * W + x;
                if (!use[i] || !rect.valid[j]) continue;
                const a = bpPlate[i], b = bpPhoto0[j];
                n++; sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b;
            }
        }
        if (n < 64) return -1;
        const va = saa / n - (sa / n) ** 2, vb = sbb / n - (sb / n) ** 2;
        return va > 1e-6 && vb > 1e-6 ? (sab / n - (sa / n) * (sb / n)) / Math.sqrt(va * vb) : -1;
    };
    let best = { dx: 0, dy: 0, v: corr(0, 0) };
    for (let dy = -R; dy <= R; dy += step) for (let dx = -R; dx <= R; dx += step) { const v = corr(dx, dy); if (v > best.v + 1e-6) best = { dx, dy, v }; }
    const photo = shifted(rect.rgba, W, H, best.dx, best.dy, 4, 0), valid = shifted(rect.valid, W, H, best.dx, best.dy, 1, 0);
    const bpPhoto = shifted(bpPhoto0, W, H, best.dx, best.dy, 1, 0);
    const cmp = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) cmp[i] = use[i] && valid[i] && Math.floor(i / W) >= bandTop ? 1 : 0;
    const sp = windowStructure(bpPlate, bpPhoto, cmp, W, H, g, PHOTO_HALO), si = windowStructure(bpInput, bpPhoto, cmp, W, H, g, PHOTO_HALO);
    const r = Math.max(2, Math.round(0.4 / pixelM));
    const dPlate = toneDistance(plate, photo, W, H, cmp, r), dInput = toneDistance(input, photo, W, H, cmp, r);
    const verdict: string[] = new Array(g.cw * g.ch).fill('');
    let compared = 0, supported = 0, contradicted = 0, sumP = 0, sumI = 0;
    for (let cy = 0; cy < g.ch; cy++) for (let cx = 0; cx < g.cw; cx++) {
        const k = cy * g.cw + cx;
        let n = 0, tp = 0, ti = 0;
        for (let y = cy * g.cellPx; y < Math.min(H, (cy + 1) * g.cellPx); y++) for (let x = cx * g.cellPx; x < Math.min(W, (cx + 1) * g.cellPx); x++) {
            const i = y * W + x;
            if (!cmp[i]) continue;
            n++; tp += dPlate[i]; ti += dInput[i];
        }
        if (n < 0.5 * g.cellPx * g.cellPx) continue;
        tp /= n; ti /= n;
        const np = sp.ncc[k], ni = si.ncc[k];
        if (!Number.isFinite(np) || !Number.isFinite(ni)) continue;
        compared++; sumP += np; sumI += ni;
        const structural = sp.contrastB[k] >= MIN_CONTRAST_L && ni - np >= CONTRADICT_NCC_MARGIN;
        const tonal = tp > MAX_TONE_DE && tp - ti >= CONTRADICT_TONE_MARGIN;
        if (structural || tonal) { verdict[k] = 'contradicts-photo'; contradicted++; }
        else if (np >= SUPPORT_NCC && np >= ni && tp <= ti + 4) { verdict[k] = 'supported'; supported++; }
    }
    return {
        panoId: rect.panoId, shiftPx: [best.dx, best.dy], verdict, grid: g, comparedCells: compared, supportedCells: supported, contradictedCells: contradicted,
        nccPlate: compared ? Math.round((sumP / compared) * 100) / 100 : NaN, nccInput: compared ? Math.round((sumI / compared) * 100) / 100 : NaN
    };
}
