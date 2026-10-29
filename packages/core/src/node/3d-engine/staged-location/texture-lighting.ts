/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Model-estimated lighting correction for the texture pass's photos, detail-locked.
 *
 * An image model (Nano Banana: gemini-3.1-flash-image, or the Lite gemini-3.1-flash-lite-image) is asked for the same image
 * under uniform, shadowless, diffuse light. Its pixels are never used. What is taken from it is only a smooth per-channel
 * gain field in linear light,
 *
 *     C = blur(answer) / blur(original),   blur sigma = BLUR_FRACTION of the image's longest side (lighting, not detail),
 *
 * clamped to [GAIN_MIN, GAIN_MAX], and the photo is corrected as original x C. Every edge, letter and ornament is the photo's
 * own; the model only says how much brighter or bluer each region should be. An answer whose framing changed (another
 * aspect ratio) or whose edges do not sit on the photo's (Sobel NCC at zero shift, and the best integer shift within a few
 * pixels) is rejected, so a gain field is never taken from a misregistered image.
 *
 * The field is computed on a coarse grid (FIELD_GRID cells on the longest side, masked box means of the two images, then a
 * masked Gaussian), and upsampled bilinearly: blurring at full resolution with a sigma of 3 percent of the width is wasted work
 * for a field that smooth. `mask` keeps what is not the subject (the sky of a Street View photo, the fill outside a chart)
 * out of both blurs, so it neither dilutes nor bleeds into the correction near a silhouette.
 *
 * The model client is the texture-enhance client (texture-enhance.ts EnhanceModelClient, generateImageWithModels); calls
 * run in parallel. Images stay in memory; SCRATCHBOX_TEXTURE_LIGHTING_DUMP=<dir> (dev only) writes each original, answer and
 * corrected image as PNG for inspection.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Vec3 } from '../../../common/spatial/staged-location-contracts';
import type { TexelProvenance } from '../../../common/spatial/texture-pass-contracts';
import { linearToSrgb255, SRGB8_TO_LINEAR } from '../../../common/spatial/photogrammetric-delight';
import { MediaModelUnavailableError } from '../../../common/errors/pipeline-errors';
import { encodePng } from '../../texture-processing';
import { blur1 } from '../../spatial/StreetViewStage3Metrics';
import { deltaE00, linearToLab } from './texel-exposure';
import { padToModelAspect, resizeRgba, type EnhanceModelClient } from './texture-enhance';
import { decodeImageInMemory, type RgbaImage8 } from './tile-texture-transfer';

/** Nano Banana Lite and Nano Banana (Vertex AI ids; media-generation-protocol.ts IMAGE_MODEL_ALIASES). */
export const LIGHTING_MODEL_LITE = 'gemini-3.1-flash-lite-image';
export const LIGHTING_MODEL_FULL = 'gemini-3.1-flash-image';

/**
 * On by default (user decision, 2026-10-21: the photo-tile scan should inform texture, not be presented as-is - the
 * same now applies to its baked lighting, which this is the detail-locked way to remove: the model's own pixels are
 * never used, only a smoothed lighting-ratio field measured against the real photo). SCRATCHBOX_TEXTURE_LIGHTING=0
 * turns it back off.
 */
export const lightingCorrectionEnabled = (): boolean => process.env.SCRATCHBOX_TEXTURE_LIGHTING !== '0';

/**
 * Experiment arm (photo-match bake-off): the tile correction forced on. Every map of the layer's atlas is sent (a scan's island
 * atlas too) and each answer that passes the detail lock is applied without the Street View agreement gate. Off by default;
 * SCRATCHBOX_TEXTURE_LIGHTING_TILE_FORCE=1 turns it on, with SCRATCHBOX_TEXTURE_LIGHTING=1.
 */
export const lightingTileForced = (): boolean => process.env.SCRATCHBOX_TEXTURE_LIGHTING_TILE_FORCE === '1';

/**
 * Experiment knobs of the texture stage for bake-off arms (never set in production; each is part of the texture cache key):
 * SCRATCHBOX_TEXTURE_STREET_VIEW=off textures from the tile photo alone, =keep keeps the no-fit rung's Street View without its
 * held-out gate; SCRATCHBOX_TEXTURE_TARGET_LAYERS=l2,l2g textures exactly those layers, superseded or not.
 */
export function textureArmOptions(): { streetView?: 'off' | 'keep'; targetLayers?: string[]; key?: string } {
    const sv = process.env.SCRATCHBOX_TEXTURE_STREET_VIEW;
    const streetView = sv === 'off' || sv === 'keep' ? sv : undefined;
    const targetLayers = (process.env.SCRATCHBOX_TEXTURE_TARGET_LAYERS ?? '').split(',').map(x => x.trim()).filter(Boolean);
    const parts = [streetView ? `sv:${streetView}` : '', targetLayers.length ? `layers:${targetLayers.join(',')}` : '', lightingTileForced() ? 'tile-force/2' : ''].filter(Boolean);
    return { ...(streetView ? { streetView } : {}), ...(targetLayers.length ? { targetLayers } : {}), ...(parts.length ? { key: `arm:${parts.join(';')}` } : {}) };
}

/** The models asked, in order (SCRATCHBOX_TEXTURE_LIGHTING_MODELS, comma separated); default Nano Banana Lite (cost and speed; the full model is a comparison arm). */
export function lightingModels(): string[] {
    const env = (process.env.SCRATCHBOX_TEXTURE_LIGHTING_MODELS ?? '').split(',').map(s => s.trim()).filter(Boolean);
    return env.length ? env : [LIGHTING_MODEL_LITE];
}

/** Blur sigma of the field, as a share of the image's longest side. */
export const BLUR_FRACTION = 0.03;
/** Cells on the longest side of the grid the field is computed on. */
export const FIELD_GRID = 128;
/** Gain clamp, linear: a sunlit-to-shade ratio on stone reaches 4 to 6. */
export const GAIN_MIN = 1 / 6;
export const GAIN_MAX = 6;

export interface LightingLockThresholds {
    /** Largest |log| difference between the answer's aspect ratio and the image sent. */
    maxAspectLogError: number;
    /** Least Sobel-magnitude NCC between answer and original at zero shift (the check resolution). */
    minEdgeNcc: number;
    /** Largest best-match shift, px at the check resolution. */
    maxShiftPx: number;
    /** Largest share of the subject whose gain hit the clamp. */
    maxClampedShare: number;
    /** Longest side of the edge check, px. */
    checkSide: number;
    /** Shift search half-width at the check resolution, px. */
    searchPx: number;
}

/**
 * Removing a cast shadow removes its edge, so the zero-shift NCC of a good answer is below the enhancement gate's 0.95; what
 * a misregistered answer cannot do is keep its best match at zero shift.
 */
export const DEFAULT_LIGHTING_LOCK: LightingLockThresholds = {
    maxAspectLogError: 0.02, minEdgeNcc: 0.5, maxShiftPx: 1, maxClampedShare: 0.2, checkSide: 512, searchPx: 4
};

export interface LightingLockMetrics {
    aspectLogError: number;
    edgeNcc: number | null;
    /** Best-match shift (x, y), px at the check resolution. */
    shiftPx: [number, number];
    /** Share of masked field cells whose gain was clamped (any channel). */
    clampedShare: number;
    /** Mask-weighted mean gain per channel. */
    meanGain: Vec3;
    /** Blur sigma, px of the image. */
    sigmaPx: number;
}

export interface LightingLockResult {
    accepted: boolean;
    reasonCode?: string;
    reason?: string;
    metrics: LightingLockMetrics;
    /** Gain field on the grid (gw x gh x 3, linear), present when accepted. */
    field?: { gw: number; gh: number; gain: Float32Array };
}

/**
 * The prompt variants of the lighting request (the prompt study, docs/processes/staged_location_texture_lighting.md). Written
 * from Google's own guidance for editing with Gemini image models:
 *  - https://developers.googleblog.com/en/how-to-prompt-gemini-2-5-flash-image-generation-for-the-best-results/ :
 *    describe, don't list keywords; "change only the ..."; "Keep everything else in the image exactly the same, preserving the
 *    original style, lighting, and composition" (here: everything but the lighting); provide context and intent; use semantic
 *    negative prompts (say what should be there, not what should not); "Do not change the input aspect ratio".
 *  - https://ai.google.dev/gemini-api/docs/image-generation : "Do not change any other elements of the image"; the output
 *    size is set by imageConfig aspectRatio / imageSize, and Gemini 3.1 Flash Lite Image supports only 1K.
 *  - https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/3-1-flash-image : the Vertex model and its config.
 * JSON-structured prompts (a JSON object as the text prompt) are not in Google's guides; they are tested as variants
 * 'json' and 'json-preserve'. Each variant is a function of the size sent.
 */
export const LIGHTING_PROMPTS: Record<string, (width: number, height: number) => string> = {
    'plain-short': () => 'Relight this photo with soft, even, overcast daylight: no cast shadows, no sun hot spots, neutral white balance. '
        + 'Keep everything else in the image exactly the same, preserving the original composition. Do not change the input aspect ratio.',
    'plain-detailed': (width, height) => [
        `Return this same ${width} x ${height} px photo with uniform, shadowless, diffuse lighting, as if under an evenly overcast sky.`,
        'Remove the cast shadows, the sun hot spots and any colour cast of the light, so every surface shows its own colour evenly lit.',
        'Change nothing else: no new detail, no sharpening, no cleaning or repainting. Keep every object, edge, letter and ornament exactly where it is, at the same size.',
        'Same framing: no crop, zoom, rotation, border or change of aspect ratio.'
    ].join(' '),
    'google-template': () => [
        'Using the provided photo of a building, change only the lighting.',
        'The result is used to measure the true surface colour of the stone and brick, so the light must be the same everywhere:',
        'every surface is evenly lit by a bright, overcast sky, the areas that were in shadow are as bright as the areas that were in sun, and the colours are a neutral daylight white balance.',
        'Keep everything else in the image exactly the same, preserving the original composition, perspective, texture and every edge, letter and ornament in its place.',
        'Do not change the input aspect ratio.'
    ].join(' '),
    'json': () => JSON.stringify({
        task: 'relight the provided photo',
        lighting: { target: 'uniform diffuse overcast daylight', cast_shadows: 'none', sun_hot_spots: 'none', white_balance: 'neutral daylight' },
        keep: 'everything else exactly as in the input',
        output: { framing: 'identical to the input', aspect_ratio: 'same as the input' }
    }),
    'json-preserve': () => JSON.stringify({
        task: 'relight the provided photo; change only the lighting',
        purpose: 'measure the true surface colour (albedo) of the building',
        lighting: { target: 'uniform diffuse overcast daylight, the same brightness on every surface', cast_shadows: 'remove', sun_hot_spots: 'remove', colour_cast: 'remove, neutral white balance' },
        preserve: ['camera position, perspective and framing', 'every object, edge, joint, letter and ornament, in place and at the same size', 'surface texture, weathering, stains and dirt', 'the colours of the materials themselves', 'the sky, trees, people and vehicles as they are'],
        do_not: ['add or invent detail', 'sharpen or clean', 'crop, zoom, rotate or add a border', 'change the aspect ratio'],
        output: { aspect_ratio: 'same as the input', content: 'the same photo, relit' }
    }),
    'google-template-negative': () => [
        'Using the provided photo of a building, change only the lighting.',
        'The result is used to measure the true surface colour of the stone and brick, so the light must be the same everywhere:',
        'every surface is evenly lit by a bright, overcast sky, the areas that were in shadow are as bright as the areas that were in sun, and the colours are a neutral daylight white balance.',
        'Keep everything else in the image exactly the same, preserving the original composition, perspective, texture and every edge, letter and ornament in its place.',
        'Do not add, sharpen, clean, move or repaint anything. Do not crop, zoom or rotate. Do not change the input aspect ratio.'
    ].join(' ')
};

/** The variant the pass uses (SCRATCHBOX_TEXTURE_LIGHTING_PROMPT overrides it for the study). */
export const LIGHTING_PROMPT_DEFAULT = 'plain-detailed';
export function lightingPromptVariant(): string {
    const v = process.env.SCRATCHBOX_TEXTURE_LIGHTING_PROMPT;
    return v && LIGHTING_PROMPTS[v] ? v : LIGHTING_PROMPT_DEFAULT;
}

/** The instruction sent with each image (the variant in use). */
export function lightingPrompt(width: number, height: number, variant: string = lightingPromptVariant()): string {
    return (LIGHTING_PROMPTS[variant] ?? LIGHTING_PROMPTS[LIGHTING_PROMPT_DEFAULT])(width, height);
}

const lumaOf = (img: RgbaImage8): Float32Array => {
    const n = img.width * img.height, out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = 0.2126 * img.rgba[i * 4] + 0.7152 * img.rgba[i * 4 + 1] + 0.0722 * img.rgba[i * 4 + 2];
    return out;
};

function sobel(L: Float32Array, W: number, H: number): Float32Array {
    const out = new Float32Array(W * H);
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        const gx = L[i - W + 1] + 2 * L[i + 1] + L[i + W + 1] - L[i - W - 1] - 2 * L[i - 1] - L[i + W - 1];
        const gy = L[i + W - 1] + 2 * L[i + W] + L[i + W + 1] - L[i - W - 1] - 2 * L[i - W] - L[i - W + 1];
        out[i] = Math.hypot(gx, gy);
    }
    return out;
}

/** Nearest-neighbour resize of a 0/1 mask. */
function resizeMask(mask: Uint8Array, W: number, H: number, w: number, h: number): Uint8Array {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
        const sy = Math.min(H - 1, Math.floor(((y + 0.5) * H) / h));
        for (let x = 0; x < w; x++) out[y * w + x] = mask[sy * W + Math.min(W - 1, Math.floor(((x + 0.5) * W) / w))] ? 1 : 0;
    }
    return out;
}

/** NCC of a and b shifted by (dx, dy) over `mask` (a's pixels). */
function shiftedNcc(a: Float32Array, b: Float32Array, W: number, H: number, mask: Uint8Array, dx: number, dy: number): number | null {
    let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
    for (let y = Math.max(0, -dy); y < Math.min(H, H - dy); y++) for (let x = Math.max(0, -dx); x < Math.min(W, W - dx); x++) {
        const i = y * W + x;
        if (!mask[i]) continue;
        const va = a[i], vb = b[(y + dy) * W + x + dx];
        n++; sa += va; sb += vb; saa += va * va; sbb += vb * vb; sab += va * vb;
    }
    if (n < 64) return null;
    const cov = sab - (sa * sb) / n, va = saa - (sa * sa) / n, vb = sbb - (sb * sb) / n;
    return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : null;
}

/** Sub-pixel peak of three samples (parabola), offset in [-0.5, 0.5]. */
const parabola = (l: number, c: number, r: number): number => { const d = l - 2 * c + r; return d < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (l - r)) / d)) : 0; };

/**
 * Edge registration of the answer against the original: Sobel magnitudes of the luma (blurred 1.5 px) at the check
 * resolution, NCC at zero shift and the best integer shift (refined to sub-pixel) within +-searchPx, over the mask eroded
 * by the search width.
 */
export function edgeRegistration(original: RgbaImage8, answer: RgbaImage8, mask: Uint8Array | undefined, t: LightingLockThresholds = DEFAULT_LIGHTING_LOCK):
    { edgeNcc: number | null; shiftPx: [number, number] } {
    const s = Math.min(1, t.checkSide / Math.max(original.width, original.height));
    const w = Math.max(8, Math.round(original.width * s)), h = Math.max(8, Math.round(original.height * s));
    const o = resizeRgba(original, w, h), a = resizeRgba(answer, w, h);
    const So = sobel(blur1(lumaOf(o), w, h, 1.5), w, h), Sa = sobel(blur1(lumaOf(a), w, h, 1.5), w, h);
    const m0 = mask ? resizeMask(mask, original.width, original.height, w, h) : new Uint8Array(w * h).fill(1);
    // erode: the search never compares a pixel the shift brought in from outside the subject
    const R = t.searchPx + 1, m = new Uint8Array(w * h);
    for (let y = R; y < h - R; y++) for (let x = R; x < w - R; x++) {
        let ok = 1;
        for (let d = -R; d <= R && ok; d += R) for (let e = -R; e <= R; e += R) if (!m0[(y + d) * w + x + e]) { ok = 0; break; }
        m[y * w + x] = ok;
    }
    const S = t.searchPx, grid = new Float64Array((2 * S + 1) ** 2).fill(-Infinity);
    let best = -Infinity, bx = 0, by = 0;
    for (let dy = -S; dy <= S; dy++) for (let dx = -S; dx <= S; dx++) {
        const v = shiftedNcc(So, Sa, w, h, m, dx, dy);
        if (v === null) continue;
        grid[(dy + S) * (2 * S + 1) + dx + S] = v;
        if (v > best) { best = v; bx = dx; by = dy; }
    }
    const zero = grid[S * (2 * S + 1) + S];
    if (!Number.isFinite(best)) return { edgeNcc: null, shiftPx: [0, 0] };
    const at = (dx: number, dy: number) => (Math.abs(dx) <= S && Math.abs(dy) <= S && Number.isFinite(grid[(dy + S) * (2 * S + 1) + dx + S]) ? grid[(dy + S) * (2 * S + 1) + dx + S] : best);
    const sx = bx + (Math.abs(bx) < S ? parabola(at(bx - 1, by), best, at(bx + 1, by)) : 0);
    const sy = by + (Math.abs(by) < S ? parabola(at(bx, by - 1), best, at(bx, by + 1)) : 0);
    return { edgeNcc: Number.isFinite(zero) ? zero : null, shiftPx: [sx, sy] };
}

/** Masked box means of an image's linear RGB on a gw x gh grid; weight = mask share of each cell. */
function gridMeans(img: RgbaImage8, mask: Uint8Array | undefined, gw: number, gh: number): { rgb: Float32Array; w: Float32Array } {
    const W = img.width, H = img.height, rgb = new Float32Array(gw * gh * 3), w = new Float32Array(gw * gh), cnt = new Float32Array(gw * gh);
    for (let y = 0; y < H; y++) {
        const gy = Math.min(gh - 1, Math.floor((y * gh) / H));
        for (let x = 0; x < W; x++) {
            const g = gy * gw + Math.min(gw - 1, Math.floor((x * gw) / W)), i = y * W + x;
            cnt[g]++;
            if (mask && !mask[i]) continue;
            w[g]++;
            for (let c = 0; c < 3; c++) rgb[g * 3 + c] += SRGB8_TO_LINEAR[img.rgba[i * 4 + c]];
        }
    }
    for (let g = 0; g < gw * gh; g++) { if (w[g]) for (let c = 0; c < 3; c++) rgb[g * 3 + c] /= w[g]; w[g] = cnt[g] ? w[g] / cnt[g] : 0; }
    return { rgb, w };
}

/**
 * The detail lock: checks an answer (any size) against the original it was asked about, and returns the smooth gain field.
 * `answer` must already be cropped to the original's region (and is resized to it here).
 */
export function detailLock(original: RgbaImage8, answer: RgbaImage8, opts: { mask?: Uint8Array; sentAspect?: number; answerAspect?: number; thresholds?: Partial<LightingLockThresholds>; blurFraction?: number } = {}): LightingLockResult {
    const t = { ...DEFAULT_LIGHTING_LOCK, ...(opts.thresholds ?? {}) };
    const W = original.width, H = original.height, mask = opts.mask;
    const sigmaFrac = opts.blurFraction ?? BLUR_FRACTION;
    const aspectLogError = opts.sentAspect && opts.answerAspect ? Math.abs(Math.log(opts.answerAspect / opts.sentAspect)) : Math.abs(Math.log((answer.width / answer.height) / (W / H)));
    const metrics: LightingLockMetrics = { aspectLogError, edgeNcc: null, shiftPx: [0, 0], clampedShare: 0, meanGain: [1, 1, 1], sigmaPx: sigmaFrac * Math.max(W, H) };
    if (aspectLogError > t.maxAspectLogError) {
        return { accepted: false, metrics, reasonCode: 'lighting_framing_changed', reason: `the answer's aspect ratio differs from the image sent by ${(100 * (Math.exp(aspectLogError) - 1)).toFixed(1)} percent (limit ${(100 * (Math.exp(t.maxAspectLogError) - 1)).toFixed(1)}): its framing changed` };
    }
    const ans = resizeRgba(answer, W, H);
    const reg = edgeRegistration(original, ans, mask, t);
    metrics.edgeNcc = reg.edgeNcc; metrics.shiftPx = reg.shiftPx;
    const shift = Math.hypot(reg.shiftPx[0], reg.shiftPx[1]);
    if (reg.edgeNcc === null || reg.edgeNcc < t.minEdgeNcc) {
        return { accepted: false, metrics, reasonCode: 'lighting_edges_moved', reason: `the answer's edges do not sit on the photo's (Sobel NCC ${reg.edgeNcc === null ? 'n/a' : reg.edgeNcc.toFixed(3)} < ${t.minEdgeNcc})` };
    }
    if (shift > t.maxShiftPx) {
        return { accepted: false, metrics, reasonCode: 'lighting_misaligned', reason: `the answer is shifted against the photo by ${shift.toFixed(2)} px at ${t.checkSide} px (limit ${t.maxShiftPx})` };
    }
    const f = gainField(original, ans, mask, sigmaFrac);
    metrics.clampedShare = f.clampedShare;
    metrics.meanGain = f.meanGain;
    if (metrics.clampedShare > t.maxClampedShare) {
        return { accepted: false, metrics, reasonCode: 'lighting_out_of_range', reason: `${(100 * metrics.clampedShare).toFixed(0)} percent of the subject would need a gain outside ${GAIN_MIN.toFixed(2)}..${GAIN_MAX} (limit ${(100 * t.maxClampedShare).toFixed(0)} percent): the answer is not a relighting of this photo` };
    }
    return { accepted: true, metrics, field: f.field };
}

/**
 * The smooth gain field blur(answer) / blur(original) of two registered images of one size: masked grid means, a masked
 * Gaussian on the grid, the ratio, clamped. Outside the mask the field is the masked neighbours' smooth continuation.
 */
export function gainField(original: RgbaImage8, ans: RgbaImage8, mask: Uint8Array | undefined, sigmaFrac: number = BLUR_FRACTION): { field: NonNullable<LightingLockResult['field']>; clampedShare: number; meanGain: Vec3 } {
    const W = original.width, H = original.height;
    const s = FIELD_GRID / Math.max(W, H);
    const gw = Math.max(2, Math.round(W * s)), gh = Math.max(2, Math.round(H * s));
    const go = gridMeans(original, mask, gw, gh), ga = gridMeans(ans, mask, gw, gh);
    const sigmaCells = sigmaFrac * Math.max(gw, gh);
    const wB = blur1(go.w, gw, gh, sigmaCells);
    const gain = new Float32Array(gw * gh * 3);
    const chan = new Float32Array(gw * gh);
    const blurred = (src: Float32Array, c: number) => { for (let g = 0; g < gw * gh; g++) chan[g] = src[g * 3 + c] * go.w[g]; return blur1(chan, gw, gh, sigmaCells); };
    let clamped = 0, masked = 0;
    const sum: Vec3 = [0, 0, 0];
    let wsum = 0;
    const isClamped = new Uint8Array(gw * gh);
    for (let c = 0; c < 3; c++) {
        const bo = blurred(go.rgb, c), ba = blurred(ga.rgb, c);
        for (let g = 0; g < gw * gh; g++) {
            const den = bo[g] / Math.max(1e-6, wB[g]), num = ba[g] / Math.max(1e-6, wB[g]);
            let r = wB[g] > 1e-4 && den > 1e-5 ? num / den : 1;
            if (!Number.isFinite(r)) r = 1;
            if (r < GAIN_MIN || r > GAIN_MAX) { r = Math.min(GAIN_MAX, Math.max(GAIN_MIN, r)); if (go.w[g] > 0) isClamped[g] = 1; }
            gain[g * 3 + c] = r;
            if (go.w[g] > 0) { sum[c] += r * go.w[g]; if (c === 0) wsum += go.w[g]; }
        }
    }
    for (let g = 0; g < gw * gh; g++) if (go.w[g] > 0) { masked++; clamped += isClamped[g]; }
    return { field: { gw, gh, gain }, clampedShare: masked ? clamped / masked : 0, meanGain: wsum ? [sum[0] / wsum, sum[1] / wsum, sum[2] / wsum] : [1, 1, 1] };
}

/** The field's gain at image pixel (x, y) of a W x H image (bilinear between cell centres). */
export function fieldAt(f: NonNullable<LightingLockResult['field']>, W: number, H: number, x: number, y: number, out: Float64Array): void {
    const fx = Math.min(f.gw - 1, Math.max(0, ((x + 0.5) * f.gw) / W - 0.5)), fy = Math.min(f.gh - 1, Math.max(0, ((y + 0.5) * f.gh) / H - 0.5));
    const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(f.gw - 1, x0 + 1), y1 = Math.min(f.gh - 1, y0 + 1), ax = fx - x0, ay = fy - y0;
    for (let c = 0; c < 3; c++) {
        const g = f.gain;
        out[c] = (g[(y0 * f.gw + x0) * 3 + c] * (1 - ax) + g[(y0 * f.gw + x1) * 3 + c] * ax) * (1 - ay) + (g[(y1 * f.gw + x0) * 3 + c] * (1 - ax) + g[(y1 * f.gw + x1) * 3 + c] * ax) * ay;
    }
}

/** original x C in linear light, on the mask's pixels (all of them without a mask); the rest is the original. */
export function applyLightingField(original: RgbaImage8, field: NonNullable<LightingLockResult['field']>, mask?: Uint8Array): RgbaImage8 {
    const W = original.width, H = original.height, out = Uint8Array.from(original.rgba), g = new Float64Array(3);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (mask && !mask[i]) continue;
        fieldAt(field, W, H, x, y, g);
        for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.round(linearToSrgb255(SRGB8_TO_LINEAR[original.rgba[i * 4 + c]] * g[c]));
    }
    return { width: W, height: H, rgba: out };
}

/** The same correction on linear RGB samples (a texel plane), 3 floats per pixel, sRGB 0..255 in and out. */
export function applyLightingFieldSrgbFloat(rgb: Float32Array, W: number, H: number, field: NonNullable<LightingLockResult['field']>, at: (x: number, y: number) => number): void {
    const g = new Float64Array(3);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = at(x, y);
        if (i < 0) continue;
        fieldAt(field, W, H, x, y, g);
        for (let c = 0; c < 3; c++) {
            const v = Math.max(0, Math.min(255, rgb[i * 3 + c]));
            const lo = Math.floor(v), hi = Math.min(255, lo + 1), a = v - lo;
            rgb[i * 3 + c] = linearToSrgb255((SRGB8_TO_LINEAR[lo] * (1 - a) + SRGB8_TO_LINEAR[hi] * a) * g[c]);
        }
    }
}

export type LightingDecision = 'accepted' | 'rejected' | 'model_failed' | (string & {});

export interface LightingImageRecord {
    label: string;
    decision: LightingDecision;
    reasonCode?: string;
    reason?: string;
    modelUsed?: string;
    modelNote?: string;
    /** Wall clock of the model call, ms. */
    ms?: number;
    metrics?: LightingLockMetrics;
    /** 0..1: the zero-shift edge NCC times the unclamped share (how surely the field is a relighting of this very image). */
    confidence?: number;
    /** Size sent to the model. */
    sentPx?: [number, number];
    /** The prompt variant asked (LIGHTING_PROMPTS). */
    prompt?: string;
}

export interface LightingImageResult { record: LightingImageRecord; field?: NonNullable<LightingLockResult['field']>; answer?: RgbaImage8 }

/** Largest side sent to the model: the field needs only the low band of the answer. */
export const LIGHTING_MAX_SIDE = 1024;

function boxDown(img: RgbaImage8, maxSide: number): RgbaImage8 {
    const s = Math.max(img.width, img.height) / maxSide;
    return s <= 1 ? img : resizeRgba(img, Math.max(1, Math.round(img.width / s)), Math.max(1, Math.round(img.height / s)));
}

function cropImage(img: RgbaImage8, x0: number, y0: number, w: number, h: number): RgbaImage8 {
    const out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) out.set(img.rgba.subarray(((y0 + y) * img.width + x0) * 4, ((y0 + y) * img.width + x0 + w) * 4), y * w * 4);
    return { width: w, height: h, rgba: out };
}

const png = (img: RgbaImage8): Uint8Array => new Uint8Array(encodePng(img.width, img.height, Buffer.from(img.rgba.buffer, img.rgba.byteOffset, img.rgba.byteLength)));

function dump(label: string, model: string, parts: Record<string, RgbaImage8>): void {
    const dir = process.env.SCRATCHBOX_TEXTURE_LIGHTING_DUMP;
    if (!dir) return;
    try {
        fs.mkdirSync(dir, { recursive: true });
        const base = `${label.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 80)}__${model}`;
        for (const [k, img] of Object.entries(parts)) fs.writeFileSync(path.join(dir, `${base}__${k}.png`), png(img));
    } catch { /* a debug dump never fails the pass */ }
}

/**
 * One image through the model and the detail lock. The image is padded to the model's nearest aspect ratio and sent at most
 * LIGHTING_MAX_SIDE; the answer is resized to the padded image, cropped back and judged at the sent resolution, where the field
 * is computed (it is resolution free: applyLightingField reads it at any size of the same framing).
 */
export async function lightingCorrectImage(input: { label: string; image: RgbaImage8; mask?: Uint8Array; client: EnhanceModelClient; models: string[]; signal?: AbortSignal; thresholds?: Partial<LightingLockThresholds> }): Promise<LightingImageResult> {
    const { label, image, client, models } = input;
    const { padded, offset } = padToModelAspect(image);
    const sent = boxDown(padded, LIGHTING_MAX_SIDE);
    const sx = sent.width / padded.width, sy = sent.height / padded.height;
    // the region of the original inside what was sent, at the sent resolution
    const rx = Math.round(offset[0] * sx), ry = Math.round(offset[1] * sy);
    const rw = Math.max(1, Math.min(sent.width - rx, Math.round(image.width * sx))), rh = Math.max(1, Math.min(sent.height - ry, Math.round(image.height * sy)));
    const t0 = Date.now();
    let answer;
    try {
        answer = await client({ label, models, prompt: lightingPrompt(sent.width, sent.height), image: { mimeType: 'image/png', bytes: png(sent), width: sent.width, height: sent.height }, references: [], ...(input.signal ? { signal: input.signal } : {}) });
    } catch (error) {
        // a model failure crosses from the main thread as a plain error with its code (texture-worker-protocol.ts errorFromWire)
        const modelFailure = error instanceof MediaModelUnavailableError || (error as { code?: string })?.code === 'media_model_unavailable';
        if (input.signal?.aborted || !modelFailure) throw error;
        return { record: { label, decision: 'model_failed', reasonCode: 'lighting_model_failed', reason: `the image model did not answer for ${label}: ${(error as Error).message}`, ms: Date.now() - t0 } };
    }
    const ms = Date.now() - t0;
    const base: LightingImageRecord = { label, decision: 'rejected', modelUsed: answer.modelUsed, modelNote: answer.modelNote, ms, sentPx: [sent.width, sent.height], prompt: lightingPromptVariant() };
    let decoded: RgbaImage8;
    try {
        decoded = decodeImageInMemory(answer.bytes);
    } catch (error) {
        return { record: { ...base, decision: 'model_failed', reasonCode: 'lighting_answer_undecodable', reason: `${answer.modelUsed} answered ${label} with an image that cannot be decoded (${(error as Error).message})` } };
    }
    const full = resizeRgba(decoded, sent.width, sent.height);
    const ans = cropImage(full, rx, ry, rw, rh);
    const orig = cropImage(sent, rx, ry, rw, rh);
    const mask = input.mask ? resizeMask(input.mask, image.width, image.height, rw, rh) : undefined;
    const lock = detailLock(orig, ans, { ...(mask ? { mask } : {}), sentAspect: sent.width / sent.height, answerAspect: decoded.width / decoded.height, ...(input.thresholds ? { thresholds: input.thresholds } : {}) });
    const confidence = lock.metrics.edgeNcc === null ? 0 : Math.max(0, Math.min(1, lock.metrics.edgeNcc)) * (1 - lock.metrics.clampedShare);
    const record: LightingImageRecord = { ...base, decision: lock.accepted ? 'accepted' : 'rejected', metrics: lock.metrics, confidence: Math.round(confidence * 1000) / 1000,
        ...(lock.accepted ? {} : { reasonCode: lock.reasonCode, reason: `${answer.modelUsed} relit ${label} but ${lock.reason}; the photo keeps its own lighting` }) };
    if (process.env.SCRATCHBOX_TEXTURE_LIGHTING_DUMP) dump(label, answer.modelUsed, { original: orig, answer: ans, ...(lock.field ? { corrected: applyLightingField(orig, lock.field, mask) } : {}) });
    return { record, ...(lock.field ? { field: lock.field } : {}), answer: ans };
}

/** Runs `jobs` with at most `concurrency` in flight; results in job order. */
export async function mapConcurrent<T, R>(jobs: T[], concurrency: number, fn: (job: T, index: number) => Promise<R>, signal?: AbortSignal): Promise<R[]> {
    const out = new Array<R>(jobs.length);
    let next = 0;
    const worker = async () => {
        while (next < jobs.length) {
            if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : Object.assign(new Error('stopped'), { name: 'AbortError' });
            const k = next++;
            out[k] = await fn(jobs[k], k);
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, jobs.length)) }, worker));
    return out;
}

/** A Street View view's corrected photo, by the view's index in the stage's view list (crosses to a texture worker as data). */
export interface LightingCorrectedView {
    index: number;
    panoId: string;
    image: { width: number; height: number; rgba: Uint8Array };
    modelUsed: string;
    confidence: number;
}

/** Calls in flight at once (a call takes 4 to 15 s; the wall clock, not the cost, is the limit). */
export const LIGHTING_CONCURRENCY = 16;

/**
 * Every Street View view through the model and the detail lock (lightingCorrectImage), in parallel. `maskFor` gives the
 * view's subject pixels (anything solid; not the sky), computed as the calls go out.
 */
export async function correctViewsLighting(input: {
    views: Array<{ panoId: string; image: { width: number; height: number; rgba: Uint8Array } }>;
    client: EnhanceModelClient; models: string[]; maskFor?: (index: number) => Uint8Array | undefined; signal?: AbortSignal; concurrency?: number;
}): Promise<{ corrected: LightingCorrectedView[]; records: LightingImageRecord[] }> {
    const results = await mapConcurrent(input.views, input.concurrency ?? LIGHTING_CONCURRENCY, async (v, k) => {
        const mask = input.maskFor?.(k);
        await new Promise(r => setImmediate(r));
        const image: RgbaImage8 = { width: v.image.width, height: v.image.height, rgba: v.image.rgba };
        const r = await lightingCorrectImage({ label: `view ${k} ${v.panoId.slice(0, 8)}`, image, ...(mask ? { mask } : {}), client: input.client, models: input.models, ...(input.signal ? { signal: input.signal } : {}) });
        await new Promise(res => setImmediate(res));
        const corrected = r.field ? applyLightingField(image, r.field, mask) : undefined;
        return { record: r.record, corrected };
    }, input.signal);
    const corrected: LightingCorrectedView[] = [];
    results.forEach((r, k) => {
        if (r.corrected && r.record.modelUsed) corrected.push({ index: k, panoId: input.views[k].panoId, image: r.corrected, modelUsed: r.record.modelUsed, confidence: r.record.confidence ?? 0 });
    });
    return { corrected, records: results.map(r => r.record) };
}

// =============================================================================
// The tile photo: frontal crops of the transferred tile texture per atlas chart
// =============================================================================

/** Agreement of two colourings of the same texels (the tile and the Street View bake). */
export interface PlaneAgreement { texels: number; medianDeltaE: number | null; p95DeltaE: number | null }

export interface TileLightingReport {
    charts: number;
    sent: number;
    accepted: number;
    /** Charts the detail lock rejected or the model did not answer. */
    rejected: number;
    failed: number;
    /** Accepted charts set back because they agreed less with the Street View texels after the correction. */
    reverted: number;
    /** Accepted charts with too little Street View overlap to be judged on their own (kept only when the layer passes). */
    unmeasured: number;
    /** Tile against Street View, before and after (on the overlap texels, 9 x 9 texel means, exposure matched). */
    before?: PlaneAgreement;
    after?: PlaneAgreement;
    applied: boolean;
    reason?: string;
    records: LightingImageRecord[];
}

/** Least overlap texels for a chart to be judged on its own. */
export const TILE_CHART_MIN_OVERLAP = 50;
/** Radius of the texel means the tile is compared with the Street View bake at (lighting, not misregistered detail). */
export const PLANE_COMPARE_RADIUS = 4;

interface TileChartJob { mapIndex: number; label: string; x0: number; y0: number; w: number; h: number; mask: Uint8Array; texelIndex: Int32Array; crop: RgbaImage8; count: number; gateable: number; fill: number }

function tileChartJobs(atlas: { width: number; height: number; maps: Array<{ nodeName: string; chartId?: string; atlasRect: [number, number, number, number] }>; texels: { mapIndex: Uint16Array; gutter: Uint8Array } }, rgb: Float32Array, has: Uint8Array, islands = false): TileChartJob[] {
    const W = atlas.width, H = atlas.height;
    const jobs: TileChartJob[] = [];
    atlas.maps.forEach((m, mapIndex) => {
        // only fitted faces (a chart: its crop is a frontal render of the face); a scan island atlas is fragments of many
        // surfaces at once, which no image model can relight as one photo
        // (a rebuilt layer's islands are whole planar faces or the ground from above: each relights as one photo)
        if (m.chartId === undefined && !lightingTileForced() && !islands) return;
        const [u0, v0, u1, v1] = m.atlasRect;
        const X0 = Math.max(0, Math.floor(u0 * W)), Y0 = Math.max(0, Math.floor(v0 * H)), X1 = Math.min(W, Math.ceil(u1 * W)), Y1 = Math.min(H, Math.ceil(v1 * H));
        let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
        for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) {
            const i = y * W + x;
            if (atlas.texels.mapIndex[i] !== mapIndex || atlas.texels.gutter[i] || !has[i]) continue;
            if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y;
        }
        if (!(bx1 >= bx0)) return;
        const x0 = bx0, y0 = by0, w = bx1 - bx0 + 1, h = by1 - by0 + 1;
        const mask = new Uint8Array(w * h), texelIndex = new Int32Array(w * h).fill(-1), rgba = new Uint8Array(w * h * 4);
        let count = 0; const sum = [0, 0, 0];
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const i = (y0 + y) * W + x0 + x, j = y * w + x;
            if (atlas.texels.mapIndex[i] !== mapIndex || atlas.texels.gutter[i] || !has[i]) continue;
            mask[j] = 1; texelIndex[j] = i; count++;
            for (let c = 0; c < 3; c++) { const v = Math.round(Math.max(0, Math.min(255, rgb[i * 3 + c]))); rgba[j * 4 + c] = v; sum[c] += v; }
            rgba[j * 4 + 3] = 255;
        }
        // outside the chart: its mean colour (never read back, masked out of the field), so the crop has no false edges
        for (let j = 0; j < w * h; j++) if (!mask[j]) rgba.set([Math.round(sum[0] / count), Math.round(sum[1] / count), Math.round(sum[2] / count), 255], j * 4);
        let gateable = 0;
        for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
            let ok = 1;
            for (let dy = -2; dy <= 2 && ok; dy++) for (let dx = -2; dx <= 2; dx++) if (!mask[(y + dy) * w + x + dx]) { ok = 0; break; }
            gateable += ok;
        }
        jobs.push({ mapIndex, label: `${m.nodeName}${m.chartId ? `/${m.chartId}` : ''}`, x0, y0, w, h, mask, texelIndex, crop: { width: w, height: h, rgba }, count, gateable, fill: count / (w * h) });
    });
    return jobs;
}

/**
 * Tile colours against the Street View bake's (`existing`, rung <= 1 texels) where both cover: one exposure gain per channel
 * (the median linear ratio, as the transfer's own exposure match), then per overlap texel the CIEDE2000 between the two
 * planes' means over the overlap texels of the same chart within PLANE_COMPARE_RADIUS. Per chart medians too.
 */
export function tileAgreement(rgb: Float32Array, overlap: Uint8Array, existing: { albedo: Uint8Array }, mapIndex: Uint16Array, W: number, H: number):
    { all: PlaneAgreement; perChart: Map<number, { texels: number; median: number }> } {
    const lin = (v: number) => { const x = Math.max(0, Math.min(255, v)), lo = Math.floor(x), hi = Math.min(255, lo + 1), a = x - lo; return SRGB8_TO_LINEAR[lo] * (1 - a) + SRGB8_TO_LINEAR[hi] * a; };
    const ratios: number[][] = [[], [], []];
    for (let i = 0; i < W * H; i++) if (overlap[i]) for (let c = 0; c < 3; c++) { const t = lin(rgb[i * 3 + c]); if (t > 0.02) ratios[c].push(SRGB8_TO_LINEAR[existing.albedo[i * 4 + c]] / t); }
    const med = (a: number[]) => { if (!a.length) return 1; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
    const gain = ratios.map(r => Math.min(2, Math.max(0.5, med(r))));
    const R = PLANE_COMPARE_RADIUS;
    const all: number[] = [];
    const byChart = new Map<number, number[]>();
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (!overlap[i]) continue;
        const m = mapIndex[i];
        const a = [0, 0, 0], b = [0, 0, 0];
        let n = 0;
        for (let dy = -R; dy <= R; dy++) {
            const yy = y + dy;
            if (yy < 0 || yy >= H) continue;
            for (let dx = -R; dx <= R; dx++) {
                const xx = x + dx;
                if (xx < 0 || xx >= W) continue;
                const j = yy * W + xx;
                if (!overlap[j] || mapIndex[j] !== m) continue;
                for (let c = 0; c < 3; c++) { a[c] += lin(rgb[j * 3 + c]) * gain[c]; b[c] += SRGB8_TO_LINEAR[existing.albedo[j * 4 + c]]; }
                n++;
            }
        }
        const d = deltaE00(linearToLab(a[0] / n, a[1] / n, a[2] / n), linearToLab(b[0] / n, b[1] / n, b[2] / n));
        all.push(d);
        let list = byChart.get(m);
        if (!list) { list = []; byChart.set(m, list); }
        list.push(d);
    }
    const q = (a: number[], f: number): number | null => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return Math.round(s[Math.min(s.length - 1, Math.floor(f * s.length))] * 1000) / 1000; };
    const perChart = new Map<number, { texels: number; median: number }>();
    byChart.forEach((v, k) => perChart.set(k, { texels: v.length, median: q(v, 0.5)! }));
    return { all: { texels: all.length, medianDeltaE: q(all, 0.5), p95DeltaE: q(all, 0.95) }, perChart };
}

/**
 * The tile's transferred texture, chart by chart (each chart's crop is a frontal render of the tile photo on that fitted face),
 * through the model and the detail lock; then judged against the Street View bake: a chart that agrees less with the views
 * after its correction is set back, and the correction stands only when the tile as a whole agrees better with them (median
 * and 95th percentile). Edits `plane.rgb` in place when it stands. For transferTilePhoto's correctCandidates.
 */
export async function correctTilePlaneLighting(input: {
    atlas: Parameters<typeof tileChartJobs>[0];
    plane: { rgb: Float32Array; has: Uint8Array; width: number; height: number; existing?: { albedo: Uint8Array; confidence: { data: Uint8Array } } };
    unpackRung: (i: number) => { covered: boolean; rung: number };
    client: EnhanceModelClient; models: string[]; signal?: AbortSignal; concurrency?: number; minGateable?: number; minFill?: number;
    /**
     * A rebuilt surface no Street View reaches: every detail-locked answer stands, with no Street View agreement gate, and
     * the atlas's islands are relit as well as fitted charts (a rebuilt layer's islands are whole planar faces); labelled so.
     */
    ungated?: boolean;
}): Promise<{ texels?: Uint8Array; provenance?: Omit<TexelProvenance, 'coverage'>; report: TileLightingReport }> {
    const { atlas, plane } = input;
    const W = plane.width, H = plane.height;
    const all = tileChartJobs(atlas, plane.rgb, plane.has, !!input.ungated);
    const forced = lightingTileForced() || !!input.ungated;
    const jobs = all.filter(j => j.gateable >= (input.minGateable ?? 256) && j.fill >= (input.minFill ?? (forced ? 0 : 0.3)));
    const report: TileLightingReport = { charts: all.length, sent: jobs.length, accepted: 0, rejected: 0, failed: 0, reverted: 0, unmeasured: 0, applied: false, records: [] };
    const results = await mapConcurrent(jobs, input.concurrency ?? LIGHTING_CONCURRENCY, job => lightingCorrectImage({ label: `tile ${job.label}`, image: job.crop, mask: job.mask, client: input.client, models: input.models, ...(input.signal ? { signal: input.signal } : {}) }), input.signal);
    report.records = results.map(r => r.record);
    report.failed = results.filter(r => r.record.decision === 'model_failed').length;
    report.rejected = results.filter(r => r.record.decision === 'rejected').length;
    const accepted = results.map((r, k) => ({ r, job: jobs[k] })).filter(x => x.r.field);
    report.accepted = accepted.length;
    if (!accepted.length) { report.reason = 'no chart came back as a usable relighting'; return { report }; }
    const after = Float32Array.from(plane.rgb);
    for (const { r, job } of accepted) applyLightingFieldSrgbFloat(after, job.w, job.h, r.field!, (x, y) => job.texelIndex[y * job.w + x]);
    const ex = plane.existing;
    if (forced) {
        // the experiment arm, or a surface no Street View reaches: every answer the detail lock passed is applied, with no Street View agreement gate
        plane.rgb.set(after);
        report.applied = true;
        report.reason = input.ungated && !lightingTileForced() ? 'ungated (no Street View reaches the surface): every detail-locked answer applied' : 'forced on (experiment arm): applied without the Street View agreement gate';
        const texels = new Uint8Array(W * H);
        for (const { job } of accepted) for (let j = 0; j < job.texelIndex.length; j++) if (job.texelIndex[j] >= 0) texels[job.texelIndex[j]] = 1;
        const models = [...new Set(accepted.map(k => k.r.record.modelUsed!).filter(Boolean))];
        const conf = accepted.reduce((s, k) => s + (k.r.record.confidence ?? 0) * k.job.count, 0) / Math.max(1, accepted.reduce((s, k) => s + k.job.count, 0));
        const note = `photo, lighting corrected by ${models.join(', ')} (${input.ungated && !lightingTileForced() ? 'ungated: no Street View reaches the surface to judge it' : 'forced, ungated experiment'})`;
        return {
            texels, report,
            provenance: {
                source: 'tile-photo-transfer', label: 'photo-inferred',
                method: `tile photo transfer, ${note}: the tile photo's own texels times a smooth gain field from the model's shadowless relighting, detail-locked; ${accepted.length} of ${jobs.length} maps; not gated on Street View agreement`,
                lightingCorrection: { models, note, confidence: Math.round(conf * 1000) / 1000, images: accepted.length }
            }
        };
    }
    if (!ex) { report.reason = 'there are no Street View texels to judge the tile correction against'; return { report }; }
    const overlap = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) if (plane.has[i] && ex.albedo[i * 4 + 3]) { const c = input.unpackRung(i); if (c.covered && c.rung <= 1) overlap[i] = 1; }
    const before = tileAgreement(plane.rgb, overlap, ex, atlas.texels.mapIndex, W, H);
    let afterA = tileAgreement(after, overlap, ex, atlas.texels.mapIndex, W, H);
    // per chart: set back the charts that agree less with the views after
    const kept: typeof accepted = [];
    for (const a of accepted) {
        const b0 = before.perChart.get(a.job.mapIndex), b1 = afterA.perChart.get(a.job.mapIndex);
        if (!b0 || !b1 || b0.texels < TILE_CHART_MIN_OVERLAP) { report.unmeasured++; kept.push(a); continue; }
        if (b1.median > b0.median) { report.reverted++; a.r.record.decision = 'reverted'; a.r.record.reasonCode = 'lighting_disagrees_more'; a.r.record.reason = `after the correction ${a.job.label} agrees less with the Street View texels (median CIEDE2000 ${b0.median} -> ${b1.median}); the tile keeps its own lighting there`; continue; }
        kept.push(a);
    }
    if (kept.length !== accepted.length) {
        after.set(plane.rgb);
        for (const { r, job } of kept) applyLightingFieldSrgbFloat(after, job.w, job.h, r.field!, (x, y) => job.texelIndex[y * job.w + x]);
        afterA = tileAgreement(after, overlap, ex, atlas.texels.mapIndex, W, H);
    }
    report.before = before.all; report.after = afterA.all;
    const b = before.all, a = afterA.all;
    if (!kept.length || b.medianDeltaE === null || a.medianDeltaE === null || !(a.medianDeltaE < b.medianDeltaE) || (a.p95DeltaE ?? Infinity) > (b.p95DeltaE ?? Infinity)) {
        report.reason = `the corrected tile does not agree better with the Street View texels (CIEDE2000 median ${b.medianDeltaE} -> ${a.medianDeltaE}, p95 ${b.p95DeltaE} -> ${a.p95DeltaE} over ${b.texels} texels)`;
        return { report };
    }
    plane.rgb.set(after);
    report.applied = true;
    const texels = new Uint8Array(W * H);
    for (const { job } of kept) for (let j = 0; j < job.texelIndex.length; j++) if (job.texelIndex[j] >= 0) texels[job.texelIndex[j]] = 1;
    const models = [...new Set(kept.map(k => k.r.record.modelUsed!).filter(Boolean))];
    const conf = kept.reduce((s, k) => s + (k.r.record.confidence ?? 0) * k.job.count, 0) / Math.max(1, kept.reduce((s, k) => s + k.job.count, 0));
    const note = `photo, lighting corrected by ${models.join(', ')}`;
    return {
        texels, report,
        provenance: {
            source: 'tile-photo-transfer', label: 'photo-inferred',
            method: `tile photo transfer, ${note}: the tile photo's own texels times a smooth gain field (blur ${BLUR_FRACTION * 100} percent of the chart) from the model's shadowless relighting of each chart's frontal crop, detail-locked (edge NCC >= ${DEFAULT_LIGHTING_LOCK.minEdgeNcc}, shift <= ${DEFAULT_LIGHTING_LOCK.maxShiftPx} px); ${kept.length} of ${jobs.length} charts; agreement with the Street View texels CIEDE2000 median ${b.medianDeltaE} -> ${a.medianDeltaE}, p95 ${b.p95DeltaE} -> ${a.p95DeltaE}`,
            lightingCorrection: { models, note, confidence: Math.round(conf * 1000) / 1000, images: kept.length }
        }
    };
}

/**
 * The seam between the two photo sources on the final texture: across each pair of neighbouring texels of one chart where one
 * is a Street View texel (rung 0 or 1) and the other a tile texel (rung 2), CIEDE2000 between the 5 x 5 means of each side's
 * own source around them. Median and 95th percentile over the boundary pairs.
 */
export function measureSourceSeam(atlas: { width: number; height: number; texels: { mapIndex: Uint16Array } }, planes: { albedo: Uint8Array }, rungOf: (i: number) => number | undefined):
    { pairs: number; medianDeltaE: number | null; p95DeltaE: number | null } {
    const W = atlas.width, H = atlas.height, cls = new Int8Array(W * H).fill(-1);
    for (let i = 0; i < W * H; i++) { if (!planes.albedo[i * 4 + 3]) continue; const r = rungOf(i); if (r === undefined) continue; cls[i] = r <= 1 ? 0 : r === 2 ? 1 : -1; }
    const meanAround = (x: number, y: number, k: number, m: number): Vec3 | undefined => {
        const s = [0, 0, 0]; let n = 0;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
            const j = yy * W + xx;
            if (cls[j] !== k || atlas.texels.mapIndex[j] !== m) continue;
            for (let c = 0; c < 3; c++) s[c] += SRGB8_TO_LINEAR[planes.albedo[j * 4 + c]];
            n++;
        }
        return n ? [s[0] / n, s[1] / n, s[2] / n] : undefined;
    };
    const d: number[] = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (cls[i] < 0) continue;
        for (const [nx, ny] of [[x + 1, y], [x, y + 1]]) {
            if (nx >= W || ny >= H) continue;
            const j = ny * W + nx;
            if (cls[j] < 0 || cls[j] === cls[i] || atlas.texels.mapIndex[j] !== atlas.texels.mapIndex[i]) continue;
            const a = meanAround(x, y, cls[i], atlas.texels.mapIndex[i]), b = meanAround(nx, ny, cls[j], atlas.texels.mapIndex[i]);
            if (a && b) d.push(deltaE00(linearToLab(a[0], a[1], a[2]), linearToLab(b[0], b[1], b[2])));
        }
    }
    d.sort((p, q) => p - q);
    const q = (f: number) => (d.length ? Math.round(d[Math.min(d.length - 1, Math.floor(f * d.length))] * 1000) / 1000 : null);
    return { pairs: d.length, medianDeltaE: q(0.5), p95DeltaE: q(0.95) };
}
