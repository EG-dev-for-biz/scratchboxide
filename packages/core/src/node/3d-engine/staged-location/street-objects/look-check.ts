/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The last keep bar for a rebuilt street object (MAIN, 2026-11-09): after the measured bars (check.ts: silhouette and
 * colour against the Street View mask), a fast vision check is shown the object's Street View crop beside the rebuild
 * drawn from the same pose and crop, and answers whether they are the same kind of object and the rebuild is believable as
 * it; anything short of yes to both keeps the scan. The crops are made in memory from the photo the read already holds;
 * nothing is written. The answer is the model's (labels and a reason in words; nothing branches on the words).
 */

import * as jpegJs from 'jpeg-js';

export const LOOK_CHECK_PARAMS = {
    /** The crop is the photo mask's box grown by this share of its size on each side. */
    margin: 0.25,
    /** Crops are scaled so their longer side is at most this (px). */
    maxPx: 512,
    timeoutMs: 60_000,
    maxOutputTokens: 1024
};

export interface LookCheck { sameKind: boolean; believable: boolean; why: string }

export interface RgbaImage { width: number; height: number; rgba: Uint8Array }

/** The box (pixels, x0 y0 x1 y1, end exclusive) of a mask (one byte a pixel, non-zero: the object), grown by the margin and clamped. */
export function maskCropBox(mask: Uint8Array, width: number, height: number, margin = LOOK_CHECK_PARAMS.margin): [number, number, number, number] | undefined {
    let x0 = width, y0 = height, x1 = -1, y1 = -1;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (mask[y * width + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 < 0) return undefined;
    const mx = Math.round((x1 - x0 + 1) * margin), my = Math.round((y1 - y0 + 1) * margin);
    return [Math.max(0, x0 - mx), Math.max(0, y0 - my), Math.min(width, x1 + 1 + mx), Math.min(height, y1 + 1 + my)];
}

/** A crop of an image (nearest resample to at most maxPx on its longer side) as JPEG bytes, in memory. */
export function cropJpeg(img: RgbaImage, box: [number, number, number, number], maxPx = LOOK_CHECK_PARAMS.maxPx): Buffer {
    const [x0, y0, x1, y1] = box, w = x1 - x0, h = y1 - y0;
    const s = Math.min(1, maxPx / Math.max(w, h)), W = Math.max(1, Math.round(w * s)), H = Math.max(1, Math.round(h * s));
    const out = Buffer.alloc(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const sx = Math.min(img.width - 1, x0 + Math.floor(x / s)), sy = Math.min(img.height - 1, y0 + Math.floor(y / s));
        const i = (sy * img.width + sx) * 4, o = (y * W + x) * 4;
        out[o] = img.rgba[i]; out[o + 1] = img.rgba[i + 1]; out[o + 2] = img.rgba[i + 2]; out[o + 3] = 255;
    }
    return Buffer.from(jpegJs.encode({ data: out, width: W, height: H }, 88).data);
}

export function lookCheckPrompt(description: string): string {
    return [
        `Image 1 is a crop of a Google Street View photo showing ${description ? `"${description}"` : 'an object standing in a street'}.`,
        'Image 2 is a simple 3D rebuild of that object, drawn from the same viewpoint and cropped the same way, so it should stand where the object stands in image 1.',
        'Answer two questions about the rebuild in image 2, judged against the object in image 1:',
        '- "sameKind": is it the same kind of object (true or false)?',
        '- "believable": would a person looking at it take it for that object, in shape, proportions and colour, with nothing on it that the object does not have (true or false)?',
        '- "why": a few words.',
        'Reply with JSON only: {"sameKind": true, "believable": false, "why": "..."}'
    ].join('\n');
}

/** The reply as a check; a reply that cannot be read is an error, never a pass. */
export function parseLookCheck(text: string): LookCheck | { error: string } {
    let j: Record<string, unknown>;
    try { j = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')) as Record<string, unknown>; } catch (e) { return { error: `the reply is not JSON (${(e as Error).message})` }; }
    if (!j || typeof j.sameKind !== 'boolean' || typeof j.believable !== 'boolean') return { error: 'the reply has no sameKind and believable answers' };
    return { sameKind: j.sameKind, believable: j.believable, why: typeof j.why === 'string' ? j.why.trim() : '' };
}
