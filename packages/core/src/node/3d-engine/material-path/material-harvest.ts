/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A tile-only material harvest for pipeline K's material regions: no Street View, no renders, no image model. What a wall
 * material looks like is measured where the tiles already show it, on the straightened, de-lit, harmonised facade photos
 * (metric: one texel is a known size), and a library set is chosen by the same measurement taken on the set at that size.
 *
 *  - Texture energy: how much the photo varies at a few scales (bands centred on TEXTURE_BANDS_M), the luma's departure
 *    from its local mean over a box of half the band minus over a box of the band, squared, over the squared mean luma (so a
 *    dark and a light stone of one grain read alike). A band under two texels is not resolved by the photo and is left out.
 *  - A library set measured the same way: its colour preview shrunk to the tile's texel at the set's real size and tiled,
 *    so it is compared as the tiles would show it. Its grain finer than the tile texel is the set's own (generated).
 *
 * The measurements are photo-inferred; nothing here draws.
 */

/** Band centres (m): the scales a ~8-15 cm tile texel can show on a wall (a block's joints, a course, a bay's grain). */
export const TEXTURE_BANDS_M = [0.3, 0.6, 1.2];

export interface TextureEnergy {
    /** The texel (m) the energy was measured at. */
    texelM: number;
    /** Per band of TEXTURE_BANDS_M: the relative energy, NaN where the band is under two texels or nothing was measured. */
    energy: number[];
}

/** Box means of a weighted image by integral images (radius r texels): the mean of the valid texels in each box, NaN with none. */
function boxMean(L: Float32Array, valid: Uint8Array | undefined, W: number, H: number, r: number): Float32Array {
    const S = new Float64Array((W + 1) * (H + 1)), C = new Float64Array((W + 1) * (H + 1));
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x, k = (y + 1) * (W + 1) + x + 1, v = valid ? valid[i] : 1;
        S[k] = (v ? L[i] : 0) + S[k - 1] + S[k - W - 1] - S[k - W - 2];
        C[k] = v + C[k - 1] + C[k - W - 1] - C[k - W - 2];
    }
    const out = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const x0 = Math.max(0, x - r), y0 = Math.max(0, y - r), x1 = Math.min(W, x + r + 1), y1 = Math.min(H, y + r + 1);
        const at = (A: Float64Array) => A[y1 * (W + 1) + x1] - A[y0 * (W + 1) + x1] - A[y1 * (W + 1) + x0] + A[y0 * (W + 1) + x0];
        const n = at(C);
        out[y * W + x] = n > 0 ? at(S) / n : NaN;
    }
    return out;
}

/**
 * Per band, each texel's band response (the box mean over half the band less the box mean over the band), NaN where the
 * band is not resolved at this texel or the texel is not valid.
 */
export function bandResponses(L: Float32Array, W: number, H: number, texelM: number, valid?: Uint8Array): Float32Array[] {
    return TEXTURE_BANDS_M.map(s => {
        const r1 = Math.round(s / 4 / texelM), r2 = Math.round(s / 2 / texelM);
        const out = new Float32Array(W * H).fill(NaN);
        if (r1 < 1 || r2 <= r1) return out;
        const a = boxMean(L, valid, W, H, r1), b = boxMean(L, valid, W, H, r2);
        for (let i = 0; i < W * H; i++) if (!valid || valid[i]) out[i] = a[i] - b[i];
        return out;
    });
}

/** The relative energy per band over the texels `take` selects (all valid ones when absent). */
export function energyOver(L: Float32Array, responses: Float32Array[], take: (i: number) => boolean): number[] {
    return responses.map(r => {
        let s = 0, m = 0, n = 0;
        for (let i = 0; i < r.length; i++) if (Number.isFinite(r[i]) && take(i)) { s += r[i] * r[i]; m += L[i]; n++; }
        if (!n || !(m > 0)) return NaN;
        const mean = m / n;
        return s / n / (mean * mean);
    });
}

/** How far two texture energies are: the mean over the bands both resolve of |ln a/b|; NaN when they share none. */
export function textureDistance(a: number[], b: number[]): number {
    let s = 0, n = 0;
    for (let k = 0; k < Math.min(a.length, b.length); k++) {
        if (!Number.isFinite(a[k]) || !Number.isFinite(b[k])) continue;
        s += Math.abs(Math.log((a[k] + 1e-6) / (b[k] + 1e-6)));
        n++;
    }
    return n ? s / n : NaN;
}

const srgbToLinear = (v: number) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };

/**
 * A library set's texture energy as the tiles would show it: its colour map box-filtered to `texelM` at its real size
 * (realSizeM, x by y), tiled to cover several of the largest band, then measured like a facade photo.
 */
export function libraryTextureEnergy(img: { rgba: Uint8Array; width: number; height: number }, realSizeM: [number, number], texelM: number): TextureEnergy {
    const tw = Math.max(2, Math.round(realSizeM[0] / texelM)), th = Math.max(2, Math.round(realSizeM[1] / texelM));
    // the tile at the tile texel: each output texel the mean of the source texels under it (linear luma)
    const tile = new Float32Array(tw * th);
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
        const sx0 = Math.floor((x / tw) * img.width), sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) / tw) * img.width));
        const sy0 = Math.floor((y / th) * img.height), sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) / th) * img.height));
        let s = 0, n = 0;
        for (let yy = sy0; yy < sy1; yy++) for (let xx = sx0; xx < sx1; xx++) {
            const p = (yy * img.width + xx) * 4;
            s += 0.2126 * srgbToLinear(img.rgba[p]) + 0.7152 * srgbToLinear(img.rgba[p + 1]) + 0.0722 * srgbToLinear(img.rgba[p + 2]);
            n++;
        }
        tile[y * tw + x] = s / n;
    }
    // tiled over several of the largest band, so each band sees many of its own scale
    const span = 4 * TEXTURE_BANDS_M[TEXTURE_BANDS_M.length - 1];
    const nx = Math.max(1, Math.ceil(span / realSizeM[0])) * tw, ny = Math.max(1, Math.ceil(span / realSizeM[1])) * th;
    const L = new Float32Array(nx * ny);
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) L[y * nx + x] = tile[(y % th) * tw + (x % tw)];
    const r = bandResponses(L, nx, ny, texelM);
    // the middle, away from where the boxes clip at the edges
    const m = Math.round(TEXTURE_BANDS_M[TEXTURE_BANDS_M.length - 1] / 2 / texelM);
    return { texelM, energy: energyOver(L, r, i => { const x = i % nx, y = (i - x) / nx; return x >= m && y >= m && x < nx - m && y < ny - m; }) };
}
