/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The last rung for texels an occluder hid: generative inpainting, labelled `generated`.
 *
 * A texel some Street View photo saw with something in front of it (a sign, a tree, a pole, a neighbour: the ownership and
 * occluder masks of streetview-ownership.ts, or the full scan nearer) is filled first from another registered view that sees
 * it clear (the projection does this by itself: the masked pixel is simply not sampled), then from the tile photo (the
 * transfer). Only the masked texels neither reaches come here: no real view of them exists.
 *
 * Per atlas rect holding such texels, the rect's real texels with the hole painted flat magenta go to the image model (Nano
 * Banana Lite by default), asked to replace only the magenta region, continuing the surface around it. The answer is
 * detail-locked: outside the hole it must reproduce the real texels (median CIEDE2000 and gradient correlation), and inside
 * the hole it must join the neighbouring real texels without a step (median CIEDE2000 of the hole's rim against the real
 * texels next to it) and hold no magenta. Only then are the hole's texels written, at a low weight, rung 'generated', source
 * 'generated-inpaint'; a rejected rect keeps what the ladder below gives (the palette colour), with the reason.
 */

import { packConfidenceTexel, unpackConfidenceTexel, TEXTURE_LADDER_RUNGS, type BakedTexturePlanes, type ConfidencePlane, type TexelProvenance, type TexturePassDegradation } from '../../../common/spatial/texture-pass-contracts';
import type { Vec3 } from '../../../common/spatial/staged-location-contracts';
import { SRGB8_TO_LINEAR } from '../../../common/spatial/photogrammetric-delight';
import { MediaModelUnavailableError } from '../../../common/errors/pipeline-errors';
import { encodePng } from '../../texture-processing';
import { deltaE00, linearToLab } from './texel-exposure';
import { padToModelAspect, resizeRgba, type EnhanceModelClient } from './texture-enhance';
import { decodeImageInMemory, type RgbaImage8 } from './tile-texture-transfer';
import type { LaidOutUvAtlas } from './texture-uv';

/** The rung of an inpainted texel: the generated rung of TEXTURE_LADDER_RUNGS. */
export const INPAINT_RUNG = TEXTURE_LADDER_RUNGS.indexOf('generated tileable PBR');
/** Weight of an inpainted texel (it is invention, however well it joins). */
export const INPAINT_WEIGHT = 0.1;
/** A rect is sent only with at least this many hole texels, and at least this share of its content real. */
export const INPAINT_MIN_HOLE_TEXELS = 16;
export const INPAINT_MIN_REAL_SHARE = 0.25;
/** The lock: outside the hole, median CIEDE2000 to the real texels and gradient NCC; at the rim, median CIEDE2000 of the join. */
export const INPAINT_MAX_KEEP_DELTA_E = 8;
export const INPAINT_MIN_KEEP_GRAD_NCC = 0.4;
export const INPAINT_MAX_RIM_DELTA_E = 12;
/** Sent at most this side (the rect is upsampled to at least INPAINT_MIN_SIDE so a small island is legible). */
export const INPAINT_MAX_SIDE = 1024;
export const INPAINT_MIN_SIDE = 384;
const MAGENTA = [255, 0, 255];

export const inpaintPrompt = (w: number, h: number): string =>
    `This ${w} x ${h} image is a piece of a building's surface texture, unwrapped flat. The flat magenta (#FF00FF) region is where something stood in front of the surface in every photo, so the surface there was never seen. ` +
    'Replace only the magenta region with the surface that continues from around it: the same material, colour, lighting and any regular pattern (courses, joints, panels, openings) carried through at the same scale and alignment. ' +
    'Do not change any pixel outside the magenta region, do not add objects, signs, text, plants, people or shadows, and leave no magenta. Answer with the full image at the same framing.';

export interface InpaintRectRecord {
    rect: [number, number, number, number];
    holeTexels: number;
    decision: 'accepted' | 'rejected' | 'model_failed' | 'skipped';
    reason?: string;
    modelUsed?: string;
    metrics?: { keepMedianDeltaE: number; keepGradNcc: number | null; rimMedianDeltaE: number | null; magentaShare: number };
    ms?: number;
}

export interface InpaintResult {
    /** Planes with only the inpainted texels (alpha 255), for mergeBakedPlanes; absent when nothing was written. */
    planes?: BakedTexturePlanes;
    records: InpaintRectRecord[];
    /** Masked texels no real source reached, and those inpainted. */
    targetTexels: number;
    filledTexels: number;
    degradations: TexturePassDegradation[];
    modelsUsed: string[];
}

const lab255 = (r: number, g: number, b: number): Vec3 => linearToLab(SRGB8_TO_LINEAR[r], SRGB8_TO_LINEAR[g], SRGB8_TO_LINEAR[b]);
const luma = (a: Uint8Array, i: number): number => 0.299 * a[i * 4] + 0.587 * a[i * 4 + 1] + 0.114 * a[i * 4 + 2];
const median = (a: number[]): number | null => { if (!a.length) return null; a.sort((x, y) => x - y); return a[a.length >> 1]; };

function nearestUp(img: RgbaImage8, w: number, h: number): RgbaImage8 {
    const out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const sx = Math.min(img.width - 1, Math.floor((x * img.width) / w)), sy = Math.min(img.height - 1, Math.floor((y * img.height) / h));
        out.set(img.rgba.subarray((sy * img.width + sx) * 4, (sy * img.width + sx) * 4 + 4), (y * w + x) * 4);
    }
    return { width: w, height: h, rgba: out };
}

/** Nearest-neighbour resize of a boolean mask (any scale), for restamping a crisp hole after a bilinear colour resize. */
function nearestMask(mask: Uint8Array, srcW: number, srcH: number, w: number, h: number): Uint8Array {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const sx = Math.min(srcW - 1, Math.floor((x * srcW) / w)), sy = Math.min(srcH - 1, Math.floor((y * srcH) / h));
        out[y * w + x] = mask[sy * srcW + sx];
    }
    return out;
}

/** Gradient NCC of two crops over `use` pixels (central differences of luma). Null when the original has no texture there. */
function gradNcc(a: Uint8Array, b: Uint8Array, w: number, h: number, use: Uint8Array): number | null {
    let sab = 0, saa = 0, sbb = 0, n = 0;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (!use[i] || !use[i - 1] || !use[i + 1] || !use[i - w] || !use[i + w]) continue;
        const ax = luma(a, i + 1) - luma(a, i - 1), ay = luma(a, i + w) - luma(a, i - w);
        const bx = luma(b, i + 1) - luma(b, i - 1), by = luma(b, i + w) - luma(b, i - w);
        sab += ax * bx + ay * by; saa += ax * ax + ay * ay; sbb += bx * bx + by * by; n++;
    }
    if (n < 50 || saa / n < 4) return null;
    return sab / Math.sqrt(saa * sbb + 1e-9);
}

export interface InpaintImageOutcome {
    decision: 'accepted' | 'rejected' | 'model_failed';
    reason?: string;
    modelUsed?: string;
    metrics?: InpaintRectRecord['metrics'];
    ms: number;
    /** The answer at the crop's size (w x h RGBA), when accepted: only its hole pixels are new. */
    rgba?: Uint8Array;
}

/**
 * One image through the inpaint lock: `crop` (w x h RGBA) with its `isHole` pixels painted flat magenta here, sent (scaled to
 * INPAINT_MIN_SIDE..INPAINT_MAX_SIDE, padded to a model aspect) with `prompt`, and the answer kept only when, over the
 * `useKeep` pixels, it reproduces the crop (median CIEDE2000 and gradient NCC), its hole joins the kept pixels at the rim
 * and no magenta is left. Used per atlas rect by inpaintMaskedTexels and on whole images by image-hole-infill.ts.
 */
export async function inpaintImage(input: {
    crop: Uint8Array; w: number; h: number; isHole: Uint8Array; useKeep: Uint8Array; client: EnhanceModelClient; models: string[]; label: string;
    prompt?: (w: number, h: number) => string; signal?: AbortSignal;
}): Promise<InpaintImageOutcome> {
    const { w, isHole, useKeep } = input, hh = input.h;
    const crop = Uint8Array.from(input.crop);
    let holeCount = 0;
    for (let o = 0; o < w * hh; o++) if (isHole[o]) { crop[o * 4] = MAGENTA[0]; crop[o * 4 + 1] = MAGENTA[1]; crop[o * 4 + 2] = MAGENTA[2]; crop[o * 4 + 3] = 255; holeCount++; }
    const scale = Math.min(INPAINT_MAX_SIDE / Math.max(w, hh), Math.max(1, INPAINT_MIN_SIDE / Math.max(w, hh)));
    const sw = Math.max(1, Math.round(w * scale)), sh = Math.max(1, Math.round(hh * scale));
    // nearest-neighbour up keeps the hole's edge a clean magenta edge by construction; the resizer down blends it
    // into a purple fringe against the real texels, which the model then (reasonably) reads as real and leaves in
    // place, so restamp a crisp nearest-neighbour hole over that fringe before it ever reaches the model
    const scaledCrop = scale > 1 ? nearestUp({ width: w, height: hh, rgba: crop }, sw, sh) : resizeRgba({ width: w, height: hh, rgba: crop }, sw, sh);
    if (scale <= 1) {
        const holeDown = nearestMask(isHole, w, hh, sw, sh);
        for (let i = 0; i < sw * sh; i++) if (holeDown[i]) { const o = i * 4; scaledCrop.rgba[o] = 255; scaledCrop.rgba[o + 1] = 0; scaledCrop.rgba[o + 2] = 255; scaledCrop.rgba[o + 3] = 255; }
    }
    const { padded, offset } = padToModelAspect(scaledCrop);
    const t0 = Date.now();
    let answer;
    try {
        answer = await input.client({ label: input.label, models: input.models, prompt: (input.prompt ?? inpaintPrompt)(padded.width, padded.height),
            image: { mimeType: 'image/png', bytes: new Uint8Array(encodePng(padded.width, padded.height, Buffer.from(padded.rgba))), width: padded.width, height: padded.height }, references: [], ...(input.signal ? { signal: input.signal } : {}) });
    } catch (err) {
        const modelFailure = err instanceof MediaModelUnavailableError || (err as { code?: string })?.code === 'media_model_unavailable';
        if (input.signal?.aborted || !modelFailure) throw err;
        return { decision: 'model_failed', reason: (err as Error).message, ms: Date.now() - t0 };
    }
    const ms = Date.now() - t0;
    let decoded: RgbaImage8;
    try { decoded = decodeImageInMemory(answer.bytes); } catch (err) { return { decision: 'model_failed', reason: `the answer cannot be decoded (${(err as Error).message})`, modelUsed: answer.modelUsed, ms }; }
    const full = resizeRgba(decoded, padded.width, padded.height);
    const inner = new Uint8Array(sw * sh * 4);
    for (let y = 0; y < sh; y++) inner.set(full.rgba.subarray(((offset[1] + y) * full.width + offset[0]) * 4, ((offset[1] + y) * full.width + offset[0] + sw) * 4), y * sw * 4);
    const ans = resizeRgba({ width: sw, height: sh, rgba: inner }, w, hh).rgba;
    // the lock: outside the hole the answer is the real texture; inside it joins the rim and holds no magenta
    const keep: number[] = [];
    for (let o = 0; o < w * hh; o += 3) if (useKeep[o]) keep.push(deltaE00(lab255(crop[o * 4], crop[o * 4 + 1], crop[o * 4 + 2]), lab255(ans[o * 4], ans[o * 4 + 1], ans[o * 4 + 2])));
    const keepMedian = median(keep) ?? Infinity;
    const ncc = gradNcc(crop, ans, w, hh, useKeep);
    let mag = 0;
    const rim: number[] = [];
    for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) {
        const o = y * w + x;
        if (!isHole[o]) continue;
        if (ans[o * 4] > 200 && ans[o * 4 + 2] > 200 && ans[o * 4 + 1] < 90) mag++;
        // the rim: a hole texel within 2 texels of real ones, against their mean
        let s0 = 0, s1 = 0, s2 = 0, c = 0;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= w || yy >= hh || !useKeep[yy * w + xx]) continue;
            const q = (yy * w + xx) * 4;
            s0 += SRGB8_TO_LINEAR[crop[q]]; s1 += SRGB8_TO_LINEAR[crop[q + 1]]; s2 += SRGB8_TO_LINEAR[crop[q + 2]]; c++;
        }
        if (c >= 3) rim.push(deltaE00(linearToLab(s0 / c, s1 / c, s2 / c), lab255(ans[o * 4], ans[o * 4 + 1], ans[o * 4 + 2])));
    }
    const rimMedian = median(rim);
    const magShare = mag / Math.max(1, holeCount);
    const metrics = { keepMedianDeltaE: Math.round(keepMedian * 10) / 10, keepGradNcc: ncc === null ? null : Math.round(ncc * 1000) / 1000, rimMedianDeltaE: rimMedian === null ? null : Math.round(rimMedian * 10) / 10, magentaShare: Math.round(magShare * 1000) / 1000 };
    const why = keepMedian > INPAINT_MAX_KEEP_DELTA_E ? `it changed the real texels around the hole (median CIEDE2000 ${keepMedian.toFixed(1)} > ${INPAINT_MAX_KEEP_DELTA_E})`
        : ncc !== null && ncc < INPAINT_MIN_KEEP_GRAD_NCC ? `it did not keep the real texels' detail (gradient NCC ${ncc.toFixed(2)} < ${INPAINT_MIN_KEEP_GRAD_NCC})`
        : magShare > 0.02 ? `it left ${(100 * magShare).toFixed(1)} percent of the hole magenta`
        : rimMedian !== null && rimMedian > INPAINT_MAX_RIM_DELTA_E ? `the fill does not join its neighbours (rim median CIEDE2000 ${rimMedian.toFixed(1)} > ${INPAINT_MAX_RIM_DELTA_E})`
        : undefined;
    if (why) return { decision: 'rejected', reason: why, modelUsed: answer.modelUsed, metrics, ms };
    return { decision: 'accepted', modelUsed: answer.modelUsed, metrics, ms, rgba: ans };
}

/**
 * Inpaints the masked texels nothing real reached. `masked`: per texel, some view saw it occluded (the projection report's
 * maskedTexels). `planes`: the ladder so far (Street View and the tile photo).
 */
export async function inpaintMaskedTexels(input: {
    atlas: LaidOutUvAtlas; planes: BakedTexturePlanes; masked: Uint8Array; client: EnhanceModelClient; models: string[];
    signal?: AbortSignal; concurrency?: number;
}): Promise<InpaintResult> {
    const { atlas, planes, masked } = input;
    const W = atlas.width, H = atlas.height, N = W * H;
    const { covered, gutter } = atlas.texels;
    const real = new Uint8Array(N), hole = new Uint8Array(N);
    let targetTexels = 0;
    for (let i = 0; i < N; i++) {
        if (!covered[i] || gutter[i]) continue;
        const has = planes.albedo[i * 4 + 3] === 255 && unpackConfidenceTexel(planes.confidence, i).covered;
        if (has) real[i] = 1;
        else if (masked[i]) { hole[i] = 1; targetTexels++; }
    }
    const records: InpaintRectRecord[] = [];
    const degradations: TexturePassDegradation[] = [];
    if (!targetTexels) return { records, targetTexels, filledTexels: 0, degradations, modelsUsed: [] };

    const albedo = new Uint8Array(N * 4);
    const confidence: ConfidencePlane = { width: W, height: H, data: new Uint8Array(N * 4) };
    let filled = 0;
    const models = new Set<string>();
    const jobs = atlas.layout.rects.map(r => {
        let h = 0, rl = 0, content = 0;
        for (let y = r.y; y < r.y + r.height; y++) for (let x = r.x; x < r.x + r.width; x++) {
            const i = y * W + x;
            if (!covered[i] || gutter[i]) continue;
            content++; h += hole[i]; rl += real[i];
        }
        return { r, h, rl, content };
    }).filter(j => j.h > 0);
    let next = 0;
    const work = async () => {
        for (let k; (k = next++) < jobs.length;) {
            const { r, h, rl, content } = jobs[k];
            const rec: InpaintRectRecord = { rect: [r.x, r.y, r.width, r.height], holeTexels: h, decision: 'skipped' };
            records.push(rec);
            if (h < INPAINT_MIN_HOLE_TEXELS) { rec.reason = `only ${h} hole texels`; continue; }
            if (rl < INPAINT_MIN_REAL_SHARE * content) { rec.reason = `only ${rl} of ${content} texels around the hole are real, too little to continue from`; continue; }
            if (input.signal?.aborted) throw input.signal.reason ?? new Error('stopped');
            // the crop: real texels as they are, the hole magenta, the rest (gutter, nothing) mid grey
            const w = r.width, hh = r.height;
            const crop = new Uint8Array(w * hh * 4), useKeep = new Uint8Array(w * hh), isHole = new Uint8Array(w * hh);
            for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) {
                const i = (r.y + y) * W + r.x + x, o = y * w + x;
                if (real[i]) { crop.set(planes.albedo.subarray(i * 4, i * 4 + 3), o * 4); useKeep[o] = 1; }
                else if (hole[i]) { crop.set(MAGENTA, o * 4); isHole[o] = 1; }
                else crop.set([128, 128, 128], o * 4);
                crop[o * 4 + 3] = 255;
            }
            const out = await inpaintImage({ crop, w, h: hh, isHole, useKeep, client: input.client, models: input.models, label: `inpaint ${atlas.layerKey} rect ${r.x},${r.y}`, ...(input.signal ? { signal: input.signal } : {}) });
            rec.ms = out.ms;
            if (out.modelUsed) rec.modelUsed = out.modelUsed;
            if (out.metrics) rec.metrics = out.metrics;
            if (out.decision !== 'accepted' || !out.rgba) { rec.decision = out.decision; rec.reason = out.reason; continue; }
            const ans = out.rgba;
            rec.decision = 'accepted';
            models.add(out.modelUsed!);
            for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) {
                const o = y * w + x;
                if (!isHole[o]) continue;
                const i = (r.y + y) * W + r.x + x;
                albedo[i * 4] = ans[o * 4]; albedo[i * 4 + 1] = ans[o * 4 + 1]; albedo[i * 4 + 2] = ans[o * 4 + 2]; albedo[i * 4 + 3] = 255;
                packConfidenceTexel(confidence, i, 0, INPAINT_WEIGHT, INPAINT_RUNG);
                filled++;
            }
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(input.concurrency ?? 4, jobs.length)) }, work));
    records.sort((a, b) => a.rect[1] - b.rect[1] || a.rect[0] - b.rect[0]);
    let atlasTexels = 0;
    for (let i = 0; i < N; i++) if (covered[i]) atlasTexels++;
    const accepted = records.filter(r => r.decision === 'accepted').length, rejected = records.filter(r => r.decision === 'rejected' || r.decision === 'model_failed');
    if (targetTexels > filled) {
        degradations.push({ stage: 'inpaint', reasonCode: 'inpaint_not_filled', layerKey: atlas.layerKey, fromRung: INPAINT_RUNG, toRung: INPAINT_RUNG - 1, texelShare: (targetTexels - filled) / Math.max(1, atlasTexels),
            reason: `${targetTexels - filled} of ${targetTexels} texels an occluder hid in every photo, and the tile photo does not cover, were not inpainted (${records.length - accepted} of ${records.length} rects: ${rejected[0]?.reason ?? records.find(r => r.decision === 'skipped')?.reason ?? 'none sent'}), so they keep the measured palette colour.` });
    }
    if (!filled) return { records, targetTexels, filledTexels: 0, degradations, modelsUsed: [] };
    const provenance: TexelProvenance[] = [{
        source: 'generated-inpaint', label: 'generated',
        method: `inpainted by ${[...models].join(', ')}: texels an occluder (a sign, a tree, a pole, a neighbour) hid in every Street View photo and the tile photo does not cover, filled per atlas rect from the real texels around them, kept only where the answer reproduced the real texels (median CIEDE2000 <= ${INPAINT_MAX_KEEP_DELTA_E}, gradient NCC >= ${INPAINT_MIN_KEEP_GRAD_NCC}) and joined them (rim median CIEDE2000 <= ${INPAINT_MAX_RIM_DELTA_E}); no real view of these texels exists`,
        coverage: filled / Math.max(1, atlasTexels)
    }];
    return { planes: { layerKey: atlas.layerKey, width: W, height: H, albedo, confidence, provenance, degradations: [] }, records, targetTexels, filledTexels: filled, degradations, modelsUsed: [...models] };
}
