/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A library set's maps without their tile-scale modes (MAIN's verdict on PR #191, 2026-11-08: Travertine007's 1.2 m tile
 * repeated across the ESB's shaded base as a checker of light and dark squares the eye caught at once). A set's normal,
 * roughness and height maps carry, beside the grain, slow variation the size of the tile (a lighter half, a darker
 * corner: the one slab the publisher photographed); tiled over a wall at the set's real size, that variation repeats
 * at the tile's period and reads as a pattern no real wall has. So before a set is drawn its maps lose every Fourier
 * mode whose wavelength is TILE_FILTER.minWavelengthM or longer (the modes with at most K cycles across the tile,
 * K = floor(tile size / minWavelengthM); a tile shorter than that keeps all its modes): the normal's x and y around flat,
 * its z recomputed; the roughness and the height around their means, which stay. Grain, pores, joints and edges are
 * shorter than that and stay whole. The filter is periodic (the tile repeats), so it leaves no seam of its own.
 */

import type { RgbaImage8 } from '../tile-texture-transfer';

/** The version of how a set's maps are drawn: this filter and the photo cap on the grain (material-sets.ts capGrain); in the twin's stage key. */
export const TILE_FILTER_VERSION = 'tile-filter/2';

/** Modes of this wavelength and longer are removed; a tile shorter than it keeps its maps as they are. */
export const TILE_FILTER = { minWavelengthM: 0.5 } as const;

/** The highest number of cycles across the tile (its longer side) that is removed; 0 for nothing. */
export const tileFilterCycles = (realSizeM: readonly [number, number], R = TILE_FILTER) => Math.floor(Math.max(realSizeM[0], realSizeM[1]) / R.minWavelengthM);

/**
 * One channel's low modes (every (kx, ky) with kx² + ky² ≤ K², the mean among them) as a field over the image, by direct
 * projection: (2K + 1)² modes over the pixels, which for a 256 px tile and K ≤ 4 is a few million multiplications.
 */
export function lowModes(img: RgbaImage8, channel: number, K: number): Float64Array {
    const { width: W, height: H, rgba } = img, N = W * H, low = new Float64Array(N);
    if (K < 0) return low;
    const cosX = new Float64Array((2 * K + 1) * W), sinX = new Float64Array((2 * K + 1) * W), cosY = new Float64Array((2 * K + 1) * H), sinY = new Float64Array((2 * K + 1) * H);
    for (let k = -K; k <= K; k++) {
        for (let x = 0; x < W; x++) { const a = (2 * Math.PI * k * x) / W; cosX[(k + K) * W + x] = Math.cos(a); sinX[(k + K) * W + x] = Math.sin(a); }
        for (let y = 0; y < H; y++) { const a = (2 * Math.PI * k * y) / H; cosY[(k + K) * H + y] = Math.cos(a); sinY[(k + K) * H + y] = Math.sin(a); }
    }
    for (let ky = -K; ky <= K; ky++) for (let kx = -K; kx <= K; kx++) {
        if (kx * kx + ky * ky > K * K) continue;
        // the coefficient: c = (1/N) Σ f · e^{-i(ax + by)}; e^{-i(ax+by)} = (cx cy - sx sy) - i (sx cy + cx sy)
        let re = 0, im = 0;
        for (let y = 0; y < H; y++) {
            const cy = cosY[(ky + K) * H + y], sy = sinY[(ky + K) * H + y];
            for (let x = 0; x < W; x++) {
                const f = rgba[(y * W + x) * 4 + channel], cx = cosX[(kx + K) * W + x], sx = sinX[(kx + K) * W + x];
                re += f * (cx * cy - sx * sy); im -= f * (sx * cy + cx * sy);
            }
        }
        re /= N; im /= N;
        // the mode's field: Re(c · e^{+i(ax+by)}) = re cos - im sin
        for (let y = 0; y < H; y++) {
            const cy = cosY[(ky + K) * H + y], sy = sinY[(ky + K) * H + y];
            for (let x = 0; x < W; x++) {
                const cx = cosX[(kx + K) * W + x], sx = sinX[(kx + K) * W + x];
                low[y * W + x] += re * (cx * cy - sx * sy) - im * (sx * cy + cx * sy);
            }
        }
    }
    return low;
}

const clamp8 = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

/** The image with the channel's modes up to K cycles removed, the channel then centred on `centre` (its mean when undefined). */
export function removeTileModes(img: RgbaImage8, channel: number, K: number, centre?: number): RgbaImage8 {
    if (K < 1) return img;
    const { width: W, height: H } = img, N = W * H, low = lowModes(img, channel, K);
    let mean = 0;
    for (let k = 0; k < N; k++) mean += img.rgba[k * 4 + channel];
    mean /= N;
    const c = centre ?? mean, rgba = img.rgba.slice();
    for (let k = 0; k < N; k++) rgba[k * 4 + channel] = clamp8(img.rgba[k * 4 + channel] - low[k] + c);
    return { width: W, height: H, rgba };
}

/** A tangent-space normal map without its tile-scale tilt: x and y around flat (128), z recomputed as the unit length. */
export function filterNormal(normal: RgbaImage8, realSizeM: readonly [number, number]): RgbaImage8 {
    const K = tileFilterCycles(realSizeM);
    if (K < 1) return normal;
    const out = removeTileModes(removeTileModes(normal, 0, K, 128), 1, K, 128);
    const N = out.width * out.height;
    for (let k = 0; k < N; k++) {
        const x = out.rgba[k * 4] / 127.5 - 1, y = out.rgba[k * 4 + 1] / 127.5 - 1;
        out.rgba[k * 4 + 2] = clamp8((Math.sqrt(Math.max(0, 1 - x * x - y * y)) + 1) * 127.5);
    }
    return out;
}

/** A packed occlusion/roughness/metalness map whose roughness (green) keeps its mean but loses its tile-scale variation. */
export const filterOrm = (orm: RgbaImage8, realSizeM: readonly [number, number]): RgbaImage8 => removeTileModes(orm, 1, tileFilterCycles(realSizeM));

/** A grey height map (red read) that keeps its mean but loses its tile-scale undulation. */
export const filterHeight = (height: RgbaImage8, realSizeM: readonly [number, number]): RgbaImage8 => removeTileModes(height, 0, tileFilterCycles(realSizeM));
