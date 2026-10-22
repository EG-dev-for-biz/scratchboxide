/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Generated entries of the surface texture library (surface-texture-library.ts). An image model paints the colour map from
 * a free-text description of the surface and the real-world patch it spans; it is quilted onto itself along the
 * least-different cut so it tiles with its own content. Its relief is the depth model's (Depth Anything V2, the app's one
 * depth model) reading of the colour map wrap-padded, its trend removed and made periodic: the image model cannot paint a
 * height map that keeps its colour map's features in place (asked separately or side by side, the setts were laid out
 * anew, 2026-10-22). Normals come from the relief at the depth and real size a vision reading gives; roughness is the
 * reading's mean, rougher in the hollows. Everything here is labelled generated, with the models and prompt that made it.
 */

import { linearToLab, SRGB_TO_LINEAR } from './staged-location/texel-exposure';
import type { SurfaceTextureColour, SurfaceTextureEntry } from '../../common/spatial/surface-texture-library';

/** One material to generate: what it looks like and how much of it one tile shows. Data, never branched on. */
export interface SurfaceTextureSpec {
    id: string;
    /** What the surface is and looks like, in words (the image model reads it). */
    prompt: string;
    /** Real-world patch one tile spans (x, y), metres. */
    realSizeM: [number, number];
}

export const SURFACE_TEXTURE_PARAMS = {
    /** Pixels on a side of the stored maps. */
    sizePx: 1024,
    /** Width of the strips each edge is quilted over, as a share of the side. */
    quiltBand: 0.12,
    /** Pixels either side of a quilting cut that are blended. */
    quiltFeatherPx: 2,
    /** Wrap context given to the depth model on every side, as a share of the side. */
    depthPad: 0.25,
    /** Width of the box mean taken out of the depth as its trend, as a share of the side. */
    reliefHighPass: 0.125,
    /** The fine band (each quarter read on its own) keeps detail finer than this share of a quarter's side. */
    fineBandFrac: 0.03,
    /** The fine band's weight against the whole reading's, in units of the whole reading's spread. */
    fineWeight: 0.6,
    /** Roughness added in the deepest hollow (the mean is the reading's). */
    hollowRoughness: 0.12
};

export function surfaceColourPrompt(spec: SurfaceTextureSpec): string {
    return `A seamless tileable texture photograph of ${spec.prompt}. The image shows a ${spec.realSizeM[0]} m by ${spec.realSizeM[1]} m patch, `
        + 'seen straight on (orthographic, no perspective), filling the whole frame edge to edge with the surface only: no border, no horizon, '
        + 'no objects, no people, no text. Even overcast light: no cast shadows, no highlights, no vignette. True colours.';
}

/** The image wrapped by `pad` pixels on every side (so a model reading it sees each edge's continuation). */
export function wrapPad(rgba: Uint8Array, n: number, pad: number): Uint8Array {
    const m = n + 2 * pad, out = new Uint8Array(m * m * 4);
    for (let y = 0; y < m; y++) for (let x = 0; x < m; x++) {
        const sx = (((x - pad) % n) + n) % n, sy = (((y - pad) % n) + n) % n;
        out.set(rgba.subarray((sy * n + sx) * 4, (sy * n + sx) * 4 + 4), (y * m + x) * 4);
    }
    return out;
}

/** The least-squares quadratic surface (1, x, y, x^2, xy, y^2; x, y in -0.5..0.5) through an m x m field, sampled on a grid. */
function fitQuadratic(f: Float32Array, m: number): (x: number, y: number) => number {
    const basis = (x: number, y: number) => [1, x, y, x * x, x * y, y * y];
    const A = Array.from({ length: 6 }, () => new Float64Array(6)), b = new Float64Array(6);
    const step = Math.max(1, Math.floor(m / 128));
    for (let y = 0; y < m; y += step) for (let x = 0; x < m; x += step) {
        const v = f[y * m + x];
        if (!Number.isFinite(v)) continue;
        const p = basis(x / m - 0.5, y / m - 0.5);
        for (let i = 0; i < 6; i++) { b[i] += p[i] * v; for (let j = 0; j < 6; j++) A[i][j] += p[i] * p[j]; }
    }
    // Gaussian elimination with partial pivoting
    for (let c = 0; c < 6; c++) {
        let piv = c;
        for (let r = c + 1; r < 6; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
        [A[c], A[piv]] = [A[piv], A[c]]; [b[c], b[piv]] = [b[piv], b[c]];
        for (let r = c + 1; r < 6; r++) { const k = A[r][c] / (A[c][c] || 1e-12); for (let j = c; j < 6; j++) A[r][j] -= k * A[c][j]; b[r] -= k * b[c]; }
    }
    const w = new Float64Array(6);
    for (let r = 5; r >= 0; r--) { let s = b[r]; for (let j = r + 1; j < 6; j++) s -= A[r][j] * w[j]; w[r] = s / (A[r][r] || 1e-12); }
    return (x, y) => basis(x, y).reduce((s, p, i) => s + p * w[i], 0);
}

/**
 * The fine band of a depth reading of a padded crop (`depth`, (size + 2 pad)^2, larger is further): height (nearer is
 * higher) less its box mean over `radius` pixels (the pad gives the mean its context), the centre `size`^2 cropped, over
 * its own standard deviation (each reading has its own unknown scale).
 */
export function fineReliefBand(depth: Float32Array, size: number, pad: number, radius: number): Float32Array {
    const m = size + 2 * pad;
    const clamp = (v: number) => Math.min(m - 1, Math.max(0, v));
    const pass = (src: Float32Array, horizontal: boolean) => {
        const out = new Float32Array(m * m);
        for (let a = 0; a < m; a++) {
            const at = (b: number) => (horizontal ? src[a * m + clamp(b)] : src[clamp(b) * m + a]);
            let s = 0;
            for (let b = -radius; b <= radius; b++) s += at(b);
            for (let b = 0; b < m; b++) {
                if (horizontal) out[a * m + b] = s / (2 * radius + 1); else out[b * m + a] = s / (2 * radius + 1);
                s += at(b + radius + 1) - at(b - radius);
            }
        }
        return out;
    };
    const mean = pass(pass(depth, true), false);
    const out = new Float32Array(size * size);
    let ss = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const i = (y + pad) * m + x + pad, v = -(depth[i] - mean[i]);
        out[y * size + x] = v; ss += v * v;
    }
    const sd = Math.sqrt(ss / out.length) || 1;
    for (let i = 0; i < out.length; i++) out[i] /= sd;
    return out;
}

/**
 * The surface's relief from the depth model's reading of the wrap-padded colour map (`depth`, (n + 2 pad)^2, larger is
 * further): the centre cropped, turned to height (nearer is higher), its slow trend taken out (a box mean over
 * `highPassFrac` of the side, wrapped, after a quadratic fitted over the whole padded reading: the model's sense of a
 * receding plane is not relief), the wrap's remaining jump
 * spread linearly across each row and column, and stretched over its robust 2.5-97.5 % range to 0..1.
 */
export function reliefFromDepth(depth: Float32Array, n: number, pad: number, highPassFrac = 0.125): Float32Array {
    const m = n + 2 * pad, h = new Float32Array(n * n);
    const plane = fitQuadratic(depth, m);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) h[y * n + x] = -(depth[(y + pad) * m + x + pad] - plane((x + pad) / m - 0.5, (y + pad) / m - 0.5));
    // wrapped box mean, separable
    const r = Math.max(1, Math.round(highPassFrac * n / 2));
    const blur = (src: Float32Array, horizontal: boolean) => {
        const out = new Float32Array(n * n);
        for (let a = 0; a < n; a++) {
            let s = 0;
            const at = (b: number) => { const k = ((b % n) + n) % n; return horizontal ? src[a * n + k] : src[k * n + a]; };
            for (let b = -r; b <= r; b++) s += at(b);
            for (let b = 0; b < n; b++) {
                if (horizontal) out[a * n + b] = s / (2 * r + 1); else out[b * n + a] = s / (2 * r + 1);
                s += at(b + r + 1) - at(b - r);
            }
        }
        return out;
    };
    const trend = blur(blur(h, true), false);
    for (let i = 0; i < h.length; i++) h[i] -= trend[i];
    // each row's left-right jump and each column's top-bottom jump spread across it
    for (let y = 0; y < n; y++) { const j = h[y * n + n - 1] - h[y * n]; for (let x = 0; x < n; x++) h[y * n + x] -= j * (x / (n - 1) - 0.5); }
    for (let x = 0; x < n; x++) { const j = h[(n - 1) * n + x] - h[x]; for (let y = 0; y < n; y++) h[y * n + x] -= j * (y / (n - 1) - 0.5); }
    const sorted = Float32Array.from(h).sort();
    const lo = sorted[Math.floor(sorted.length * 0.025)], hi = sorted[Math.floor(sorted.length * 0.975)];
    for (let i = 0; i < h.length; i++) h[i] = hi > lo ? Math.min(1, Math.max(0, (h[i] - lo) / (hi - lo))) : 0.5;
    return h;
}

/**
 * Quilts images onto themselves so they tile, the cut found on the first and applied to all: the last `band` columns are
 * laid over the first along the vertical path where the two strips differ least (and the same for rows), so each wrapped
 * edge continues the image's own content. The result is `band` smaller each way.
 */
export function quiltToTile(maps: Uint8Array[], w: number, h: number, band: number, featherPx: number): { maps: Uint8Array[]; width: number; height: number } {
    const horizontal = (imgs: Uint8Array[], W: number, H: number) => {
        const b = Math.max(2, Math.round(band * W)), ref = imgs[0];
        const cost = new Float64Array(H * b);
        for (let y = 0; y < H; y++) for (let j = 0; j < b; j++) {
            const ia = (y * W + W - b + j) * 4, ib = (y * W + j) * 4;
            let e = 0;
            for (let c = 0; c < 3; c++) e += (ref[ia + c] - ref[ib + c]) ** 2;
            cost[y * b + j] = e;
        }
        // cheapest top-to-bottom path, one column step a row at most
        const acc = Float64Array.from(cost);
        for (let y = 1; y < H; y++) for (let j = 0; j < b; j++) {
            let m = acc[(y - 1) * b + j];
            if (j > 0) m = Math.min(m, acc[(y - 1) * b + j - 1]);
            if (j < b - 1) m = Math.min(m, acc[(y - 1) * b + j + 1]);
            acc[y * b + j] += m;
        }
        const seam = new Int32Array(H);
        let best = 0;
        for (let j = 1; j < b; j++) if (acc[(H - 1) * b + j] < acc[(H - 1) * b + best]) best = j;
        seam[H - 1] = best;
        for (let y = H - 2; y >= 0; y--) {
            const j0 = seam[y + 1];
            let jb = j0;
            for (const j of [j0 - 1, j0 + 1]) if (j >= 0 && j < b && acc[y * b + j] < acc[y * b + jb]) jb = j;
            seam[y] = jb;
        }
        const OW = W - b;
        const out = imgs.map(() => new Uint8Array(OW * H * 4));
        for (let y = 0; y < H; y++) for (let x = 0; x < OW; x++) {
            const own = (y * W + x) * 4, o = (y * OW + x) * 4;
            if (x >= b) { imgs.forEach((img, k) => out[k].set(img.subarray(own, own + 4), o)); continue; }
            // left of the cut: the image's last strip (it continues from the far edge); right of it: the image itself
            const over = (y * W + W - b + x) * 4, t = Math.min(1, Math.max(0, (x - seam[y] + featherPx) / (2 * featherPx + 1)));
            imgs.forEach((img, k) => { for (let c = 0; c < 4; c++) out[k][o + c] = Math.round(img[over + c] * (1 - t) + img[own + c] * t); });
        }
        return { imgs: out, W: OW };
    };
    const transpose = (imgs: Uint8Array[], W: number, H: number) => imgs.map(img => {
        const t = new Uint8Array(img.length);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) t.set(img.subarray((y * W + x) * 4, (y * W + x) * 4 + 4), (x * H + y) * 4);
        return t;
    });
    const a = horizontal(maps, w, h);
    const b = horizontal(transpose(a.imgs, a.W, h), h, a.W);
    return { maps: transpose(b.imgs, b.W, a.W), width: a.W, height: b.W };
}

export function surfaceReadingPrompt(spec: SurfaceTextureSpec): string {
    return `This tileable texture was asked for as: ${spec.prompt}, a ${spec.realSizeM[0]} m by ${spec.realSizeM[1]} m patch. `
        + 'Read it as a materials artist. Reply with JSON only: {"spanM": [width, height] the real-world size in metres the image actually '
        + 'shows, judged from its own features (a brick, a sett, a slab, a blade of grass, an aggregate stone); "reliefM": the depth in metres '
        + 'from the highest to the deepest part of the surface (a joint, a furrow, a pore); "roughness": the mean PBR roughness 0..1; '
        + '"metallic": 0..1; "appearance": one sentence describing it (material, colour, condition, pattern and its size)}.';
}

export interface SurfaceReading { spanM: [number, number]; reliefM: number; roughness: number; metallic: number; appearance: string }

export function parseSurfaceReading(text: string): SurfaceReading | undefined {
    let j: any;
    try { j = JSON.parse(text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()); } catch { return undefined; }
    const num = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined);
    const span = Array.isArray(j?.spanM) ? j.spanM.map((v: unknown) => num(v, 0.05, 50)) : [];
    const relief = num(j?.reliefM, 0, 0.5), rough = num(j?.roughness, 0, 1), metal = num(j?.metallic, 0, 1);
    if (span.length !== 2 || span.some((v: number | undefined) => v === undefined) || relief === undefined || rough === undefined || metal === undefined || typeof j.appearance !== 'string') return undefined;
    return { spanM: span as [number, number], reliefM: relief, roughness: rough, metallic: metal, appearance: j.appearance.trim() };
}

/**
 * The jump across the wrap (left edge against right, top against bottom, the larger) over the image's own mean step
 * between neighbouring pixels: about 1 when the wrap is no different from anywhere else in the image.
 */
export function wrapMismatch(rgba: Uint8Array, w: number, h: number): number {
    let d = 0, dn = 0;
    for (let y = 0; y < h; y++) for (let x = 1; x < w; x++) for (let c = 0; c < 3; c++) { d += Math.abs(rgba[(y * w + x) * 4 + c] - rgba[(y * w + x - 1) * 4 + c]); dn++; }
    for (let y = 1; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) { d += Math.abs(rgba[(y * w + x) * 4 + c] - rgba[((y - 1) * w + x) * 4 + c]); dn++; }
    const step = Math.max(1e-6, d / dn);
    let s = 0, n = 0;
    for (let y = 0; y < h; y++) for (let c = 0; c < 3; c++) { s += Math.abs(rgba[(y * w) * 4 + c] - rgba[(y * w + w - 1) * 4 + c]); n++; }
    let t = 0, m = 0;
    for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) { t += Math.abs(rgba[x * 4 + c] - rgba[((h - 1) * w + x) * 4 + c]); m++; }
    return Math.max(s / n, t / m) / step;
}

const lum = (rgba: Uint8Array, i: number) => 0.2126 * SRGB_TO_LINEAR[rgba[i]] + 0.7152 * SRGB_TO_LINEAR[rgba[i + 1]] + 0.0722 * SRGB_TO_LINEAR[rgba[i + 2]];

/** Wrapped central-difference gradient magnitude. */
function gradient(f: (x: number, y: number) => number, w: number, h: number): Float32Array {
    const g = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const gx = f((x + 1) % w, y) - f((x + w - 1) % w, y), gy = f(x, (y + 1) % h) - f(x, (y + h - 1) % h);
        g[y * w + x] = Math.hypot(gx, gy);
    }
    return g;
}

/** How closely the height map's edges follow the colour map's: normalised cross-correlation of their gradient magnitudes. */
export function heightAlignment(colour: Uint8Array, height: Float32Array, w: number, h: number): number {
    const a = gradient((x, y) => lum(colour, (y * w + x) * 4), w, h), b = gradient((x, y) => height[y * w + x], w, h);
    let ma = 0, mb = 0;
    for (let i = 0; i < a.length; i++) { ma += a[i]; mb += b[i]; }
    ma /= a.length; mb /= b.length;
    let sab = 0, saa = 0, sbb = 0;
    for (let i = 0; i < a.length; i++) { const da = a[i] - ma, db = b[i] - mb; sab += da * db; saa += da * da; sbb += db * db; }
    return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
}

/** Tangent-space normal map (RGBA, OpenGL convention, +y up the image) of a wrapping height field spanning `reliefM` over `sizeM`. */
export function normalFromHeight(height: Float32Array, w: number, h: number, sizeM: [number, number], reliefM: number): { rgba: Uint8Array; slopeMean: number } {
    const out = new Uint8Array(w * h * 4);
    const px = sizeM[0] / w, py = sizeM[1] / h;
    let slope = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const dx = (height[y * w + (x + 1) % w] - height[y * w + (x + w - 1) % w]) * reliefM / (2 * px);
        // image rows run down; +y of the normal map runs up
        const dy = (height[((y + h - 1) % h) * w + x] - height[((y + 1) % h) * w + x]) * reliefM / (2 * py);
        const len = Math.hypot(dx, dy, 1), nx = -dx / len, ny = -dy / len, nz = 1 / len;
        slope += Math.hypot(nx, ny);
        const i = (y * w + x) * 4;
        out[i] = Math.round((nx * 0.5 + 0.5) * 255); out[i + 1] = Math.round((ny * 0.5 + 0.5) * 255); out[i + 2] = Math.round((nz * 0.5 + 0.5) * 255); out[i + 3] = 255;
    }
    return { rgba: out, slopeMean: slope / (w * h) };
}

/** Roughness map (RGBA grey): the reading's mean, up to `hollow` more in the deepest parts. Returns its mean and spread too. */
export function roughnessFromHeight(height: Float32Array, w: number, h: number, mean: number, hollow: number): { rgba: Uint8Array; mean: number; spread: number } {
    let hm = 0;
    for (const v of height) hm += v;
    hm /= height.length;
    const out = new Uint8Array(w * h * 4);
    let s = 0, ss = 0;
    for (let i = 0; i < height.length; i++) {
        const r = Math.min(1, Math.max(0, mean + hollow * (hm - height[i])));
        s += r; ss += r * r;
        const b = Math.round(r * 255);
        out[i * 4] = b; out[i * 4 + 1] = b; out[i * 4 + 2] = b; out[i * 4 + 3] = 255;
    }
    const m = s / height.length;
    return { rgba: out, mean: m, spread: Math.sqrt(Math.max(0, ss / height.length - m * m)) };
}

/** Colour statistics of every pixel of an sRGB image. */
export function surfaceColourStats(rgba: Uint8Array): SurfaceTextureColour {
    const n = rgba.length / 4;
    const lin = [0, 0, 0], lin2 = [0, 0, 0], lab = [0, 0, 0], lab2 = [0, 0, 0];
    let y = 0;
    for (let i = 0; i < n; i++) {
        const r = SRGB_TO_LINEAR[rgba[i * 4]], g = SRGB_TO_LINEAR[rgba[i * 4 + 1]], b = SRGB_TO_LINEAR[rgba[i * 4 + 2]];
        const L = linearToLab(r, g, b);
        [r, g, b].forEach((v, k) => { lin[k] += v; lin2[k] += v * v; });
        L.forEach((v, k) => { lab[k] += v; lab2[k] += v * v; });
        y += 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }
    const mean = (s: number[]) => s.map(v => v / n) as [number, number, number];
    const spread = (s: number[], s2: number[]) => s.map((v, k) => Math.sqrt(Math.max(0, s2[k] / n - (v / n) ** 2))) as [number, number, number];
    const r4 = (v: number[]) => v.map(x => Math.round(x * 1e4) / 1e4) as [number, number, number];
    const r2 = (v: number[]) => v.map(x => Math.round(x * 100) / 100) as [number, number, number];
    return { meanLinearRgb: r4(mean(lin)), spreadLinearRgb: r4(spread(lin, lin2)), meanLab: r2(mean(lab)), spreadLab: r2(spread(lab, lab2)), meanLuminance: Math.round(y / n * 1e4) / 1e4 };
}

/** The image model, depth model and vision reader a generation run uses (injectable). */
export interface SurfaceTextureModels {
    /** Paints an image from a prompt at an aspect ratio; returns RGBA at its own size. */
    paint(prompt: string, aspectRatio: string): Promise<{ rgba: Uint8Array; width: number; height: number; model: string }>;
    /** Relative planar depth of a photo (row-major, larger is further). */
    depth(image: { rgba: Uint8Array; width: number; height: number }): Promise<{ depths: Float32Array; model: string }>;
    /** Reads an image and answers in text. */
    read(prompt: string, image: { rgba: Uint8Array; width: number; height: number }): Promise<string>;
    /** Resamples RGBA from w x h to size x size. */
    resize(rgba: Uint8Array, w: number, h: number, size: number): Uint8Array;
}

export interface GeneratedSurface {
    entry: Omit<SurfaceTextureEntry, 'maps'>;
    color: Uint8Array;
    normal: Uint8Array;
    roughness: Uint8Array;
    height: Uint8Array;
    size: number;
    /** The colour map's jump across the wrap over its own neighbour step, before and after quilting (about 1 is seamless). */
    wrapBefore: number;
    wrapAfter: number;
}

/** Generates one entry; throws with the reason when a step fails. */
export async function generateSurfaceTexture(spec: SurfaceTextureSpec, models: SurfaceTextureModels, P = SURFACE_TEXTURE_PARAMS): Promise<GeneratedSurface> {
    const N = P.sizePx;
    const prompt = surfaceColourPrompt(spec);
    const painted = await models.paint(prompt, '1:1');
    const wrapBefore = wrapMismatch(painted.rgba, painted.width, painted.height);
    const q = quiltToTile([painted.rgba], painted.width, painted.height, P.quiltBand, P.quiltFeatherPx);
    const color = models.resize(q.maps[0], q.width, q.height, N);
    const pad = Math.round(N * P.depthPad);
    const d = await models.depth({ rgba: wrapPad(color, N, pad), width: N + 2 * pad, height: N + 2 * pad });
    const coarse = reliefFromDepth(d.depths, N, pad, P.reliefHighPass);
    // the fine band: each quarter read on its own (the model sees it at twice the detail), with its wrap context
    const Q = N >> 1, qp = Math.round(Q * P.depthPad), padded = wrapPad(color, N, N >> 1), PM = N + 2 * (N >> 1);
    const fine = new Float32Array(N * N), fineW = new Float32Array(N * N);
    for (const [qx, qy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const side = Q + 2 * qp, crop = new Uint8Array(side * side * 4);
        const ox = (N >> 1) + qx * Q - qp, oy = (N >> 1) + qy * Q - qp;
        for (let y = 0; y < side; y++) crop.set(padded.subarray(((oy + y) * PM + ox) * 4, ((oy + y) * PM + ox + side) * 4), y * side * 4);
        // each quarter's band reaches `e` past its quarter, and neighbours are feathered over that overlap
        const e = qp >> 1, B = Q + 2 * e;
        const band = fineReliefBand((await models.depth({ rgba: crop, width: side, height: side })).depths, B, qp - e, Math.max(1, Math.round(Q * P.fineBandFrac)));
        const ramp = (t: number) => Math.min(1, (t + 0.5) / (2 * e), (B - t - 0.5) / (2 * e));
        for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) {
            const gx = (((qx * Q + x - e) % N) + N) % N, gy = (((qy * Q + y - e) % N) + N) % N, w = ramp(x) * ramp(y);
            fine[gy * N + gx] += w * band[y * B + x]; fineW[gy * N + gx] += w;
        }
    }
    for (let i = 0; i < fine.length; i++) fine[i] /= fineW[i] || 1;
    let cm = 0, cs = 0;
    for (const v of coarse) cm += v;
    cm /= coarse.length;
    for (const v of coarse) cs += (v - cm) ** 2;
    cs = Math.sqrt(cs / coarse.length);
    const mixed = new Float32Array(N * N);
    for (let i = 0; i < mixed.length; i++) mixed[i] = coarse[i] + P.fineWeight * cs * fine[i];
    const ms = Float32Array.from(mixed).sort();
    const mlo = ms[Math.floor(ms.length * 0.025)], mhi = ms[Math.floor(ms.length * 0.975)];
    const height = mixed.map(v => Math.min(1, Math.max(0, (v - mlo) / Math.max(1e-6, mhi - mlo))));
    const alignment = heightAlignment(color, height, N, N);
    const reading = parseSurfaceReading(await models.read(surfaceReadingPrompt(spec), { rgba: color, width: N, height: N }));
    if (!reading) throw new Error(`${spec.id}: the surface reading did not parse`);
    const normal = normalFromHeight(height, N, N, reading.spanM, reading.reliefM);
    const rough = roughnessFromHeight(height, N, N, reading.roughness, P.hollowRoughness);
    const sorted = Float32Array.from(height).sort();
    const lo = sorted[Math.floor(sorted.length * 0.025)], hi = sorted[Math.floor(sorted.length * 0.975)];
    const heightRgba = new Uint8Array(N * N * 4);
    for (let i = 0; i < height.length; i++) { const b = Math.round(height[i] * 255); heightRgba[i * 4] = b; heightRgba[i * 4 + 1] = b; heightRgba[i * 4 + 2] = b; heightRgba[i * 4 + 3] = 255; }
    const r3 = (v: number) => Math.round(v * 1000) / 1000;
    return {
        entry: {
            id: spec.id, pixels: [N, N], realSizeM: reading.spanM, sizeSource: `vision reading of the texture's own features (asked for ${spec.realSizeM.join(' x ')} m)`,
            colour: surfaceColourStats(color),
            surface: { normalSlopeMean: r3(normal.slopeMean), heightRange: r3(hi - lo), reliefM: reading.reliefM, roughnessMean: r3(rough.mean), roughnessSpread: r3(rough.spread), metallic: reading.metallic },
            appearance: reading.appearance, provenance: 'generated',
            source: { model: painted.model, prompt, heightModel: d.model, method: 'colour painted by the image model and quilted onto itself along the least-different cut so it tiles; relief from the depth model\'s reading of the wrap-padded colour map (trend removed, made periodic) plus the fine band of its readings of each quarter (overlapped and feathered); normals from it at the read relief and size; roughness the read mean, rougher in hollows' },
            heightAlignment: r3(alignment)
        },
        color, normal: normal.rgba, roughness: rough.rgba, height: heightRgba, size: N, wrapBefore, wrapAfter: wrapMismatch(color, N, N)
    };
}
