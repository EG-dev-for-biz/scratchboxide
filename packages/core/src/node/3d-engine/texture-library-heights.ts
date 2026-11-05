/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The real depth of the texture library's height maps. A height map is stored black to white with no unit; to move
 * geometry by it, or to march a parallax ray through it, the app needs the metres between its black and its white.
 * Neither publisher states it (ambientCG's third dimension is 0 and Poly Haven gives two dimensions for every set, checked
 * 2026-11-05), so it is estimated from what each set does give: its normal map, which holds the surface's true slopes,
 * and its tile's real size. The depth is the one number D at which the height map's slopes equal the normal map's:
 *
 *     slope from the normal:  (-nx / nz, -+ny / nz)                 metres per metre
 *     slope from the height:  D x (dh/dx x W / sizeX, dh/dy x H / sizeY)
 *     D = sum(normal slope . height slope) / sum(height slope . height slope)      (least squares)
 *
 * measured on the publishers' small preview maps, both box-filtered to at most FIT_SIZE a side (so JPEG noise and relief
 * finer than the grid stay out of it). The normal's green axis is taken in whichever sense follows the height (ambientCG
 * previews are DirectX, Poly Haven's OpenGL). An estimate is kept only when the two slope fields agree (their correlation
 * at least MIN_FIT) and it is a plausible depth for its tile (MAX_DEPTH_OF_TILE); a set without one draws no height.
 *
 * Made once by scripts/measure_texture_library_heights.ts (`npm run library:heights`) and committed beside the index
 * (assets/textures/library/heights.json); the index loader gives each set its depth, labelled an estimate (generated). A
 * publisher's own depth, should one appear in the index, always wins.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { TextureLibraryEntry } from '../../common/spatial/texture-library-index';

export const LIBRARY_HEIGHTS_FILE = 'heights.json';
export const LIBRARY_HEIGHTS_VERSION = 1;

export const HEIGHT_FIT = {
    /** The grid both previews are box-filtered to before the fit, pixels a side at most. */
    size: 256,
    /** The least correlation of the height map's slopes with the normal map's for the estimate to be kept. */
    minFit: 0.35,
    /** The deepest a tile's relief may be estimated, as a share of its shorter real side (a 2 m tile: 0.3 m). */
    maxDepthOfTile: 0.15,
    /** Normals tilted past this (nz below it) are left out of the fit: their slope runs away, and they are few. */
    minNz: 0.2
} as const;

export interface LibraryHeightEstimate {
    /** Metres between the height map's black and white. */
    depthM: number;
    /** The correlation of the two slope fields, 0..1. */
    fit: number;
    /** The height map's standard deviation, as a share of its black-to-white range (0..1). */
    spread: number;
    /** The sense the normal map's green axis was read in: 1 OpenGL, -1 DirectX. */
    green: 1 | -1;
}

export interface LibraryHeights {
    schema: 'scratchbox.texture-library-heights/1';
    version: number;
    about: string;
    measuredAt: string;
    /** Per set: its estimate, or why there is none. */
    sets: Record<string, LibraryHeightEstimate | { error: string }>;
}

interface Rgba { width: number; height: number; rgba: Uint8Array }

/** One channel of an image box-filtered to at most `size` a side: values 0..1, row-major. */
function shrink(img: Rgba, channel: number, w: number, h: number): Float64Array {
    const out = new Float64Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const x0 = Math.floor((x * img.width) / w), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * img.width) / w));
        const y0 = Math.floor((y * img.height) / h), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * img.height) / h));
        let s = 0;
        for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) s += img.rgba[(yy * img.width + xx) * 4 + channel];
        out[y * w + x] = s / ((x1 - x0) * (y1 - y0) * 255);
    }
    return out;
}

/**
 * The depth of a set's height map from its normal map and its tile's real size (see the file comment). `height` is read
 * from its red channel. Returns the estimate, or the reason there is none.
 */
export function estimateHeightDepth(height: Rgba, normal: Rgba, realSizeM: [number, number], F: typeof HEIGHT_FIT = HEIGHT_FIT): LibraryHeightEstimate | { error: string } {
    if (!(realSizeM[0] > 0 && realSizeM[1] > 0)) return { error: 'the set has no real size' };
    const scale = Math.min(1, F.size / Math.max(height.width, height.height));
    const w = Math.max(4, Math.round(height.width * scale)), h = Math.max(4, Math.round(height.height * scale));
    const H = shrink(height, 0, w, h);
    const N = [0, 1, 2].map(c => shrink(normal, c, w, h));
    let mean = 0;
    for (const v of H) mean += v;
    mean /= H.length;
    let varH = 0;
    for (const v of H) varH += (v - mean) ** 2;
    const spread = Math.sqrt(varH / H.length);
    if (spread < 1e-3) return { error: 'the height map is flat' };
    // central differences, the tile wrapping (a library set is seamless)
    let xx = 0, xy = 0, hh = 0, nn = 0, n = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const k = y * w + x;
        const nx = N[0][k] * 2 - 1, ny = N[1][k] * 2 - 1, nz = N[2][k] * 2 - 1, l = Math.hypot(nx, ny, nz) || 1;
        if (nz / l < F.minNz) continue;
        const hx = ((H[y * w + ((x + 1) % w)] - H[y * w + ((x + w - 1) % w)]) / 2) * (w / realSizeM[0]);
        // image rows run down: a height rising down the image rises toward -y of the tile
        const hy = ((H[((y + h - 1) % h) * w + x] - H[((y + 1) % h) * w + x]) / 2) * (h / realSizeM[1]);
        const sx = -nx / nz, sy = -ny / nz;
        xx += sx * hx; xy += sy * hy; hh += hx * hx + hy * hy; nn += sx * sx + sy * sy; n++;
    }
    if (n < 64 || !(hh > 0) || !(nn > 0)) return { error: 'too little relief to fit a depth' };
    // the green axis in whichever sense follows the height
    const green: 1 | -1 = xy >= 0 ? 1 : -1;
    const dot = xx + Math.abs(xy);
    const depthM = dot / hh, fit = dot / Math.sqrt(hh * nn);
    if (!(depthM > 0)) return { error: 'the height map runs against its normal map' };
    if (fit < F.minFit) return { error: `the height map's slopes do not follow its normal map's (correlation ${fit.toFixed(2)})` };
    const cap = F.maxDepthOfTile * Math.min(realSizeM[0], realSizeM[1]);
    if (depthM > cap) return { error: `the estimated depth (${depthM.toFixed(3)} m) is implausible for a ${Math.min(realSizeM[0], realSizeM[1])} m tile` };
    return { depthM: Math.round(depthM * 1e5) / 1e5, fit: Math.round(fit * 1000) / 1000, spread: Math.round(spread * 1e4) / 1e4, green };
}

let cache: { file: string; mtimeMs: number; doc: LibraryHeights } | undefined;
/** The committed depth estimates (see the file comment), when they have been made. */
export function loadLibraryHeights(repoRoot: string): LibraryHeights | undefined {
    const file = path.join(repoRoot, 'assets', 'textures', 'library', LIBRARY_HEIGHTS_FILE);
    let mtimeMs: number;
    try { mtimeMs = fs.statSync(file).mtimeMs; } catch { return undefined; }
    if (cache?.file !== file || cache.mtimeMs !== mtimeMs) {
        try { cache = { file, mtimeMs, doc: JSON.parse(fs.readFileSync(file, 'utf8')) as LibraryHeights }; } catch { return undefined; }
    }
    return cache.doc.version === LIBRARY_HEIGHTS_VERSION ? cache.doc : undefined;
}

/** A set with a height map and no publisher depth given its estimated depth, labelled so. */
export function withHeightDepth(e: TextureLibraryEntry, doc: LibraryHeights | undefined): TextureLibraryEntry {
    const est = doc?.sets[e.id];
    if (!e.maps.height || e.heightDepthM || !est || 'error' in est) return e;
    return { ...e, heightDepthM: est.depthM, heightDepthFit: est.fit, heightDepthSource: `estimated from its normal map and its tile's real size${/^estimated/.test(e.sizeSource) ? ' (itself an estimate)' : ''} (slope fit, correlation ${est.fit.toFixed(2)}; generated)` };
}
