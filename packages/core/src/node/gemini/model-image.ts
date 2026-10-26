/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * An image a tool shows the chat model, made small enough to send: decoded, scaled so its longer side is at most
 * MODEL_IMAGE_MAX_SIDE (an area average), and encoded as a JPEG. Survey renders and plates come off disk as PNGs of half a
 * megabyte or more; eight of them in one turn made a request Vertex refused, and the model reads a 1024 px image as well.
 */

import * as jpegJs from 'jpeg-js';
import { decodeImageInMemory } from '../3d-engine/staged-location/tile-texture-transfer';

export const MODEL_IMAGE_MAX_SIDE = 1024;
export const MODEL_IMAGE_JPEG_QUALITY = 85;

/** The image as a JPEG at most MODEL_IMAGE_MAX_SIDE on its longer side, with its size; undefined when it does not decode. */
export function modelImage(bytes: Uint8Array, maxSide = MODEL_IMAGE_MAX_SIDE): { data: Buffer; width: number; height: number } | undefined {
    let img;
    try { img = decodeImageInMemory(bytes); } catch { return undefined; }
    const k = Math.min(1, maxSide / Math.max(img.width, img.height));
    const W = Math.max(1, Math.round(img.width * k)), H = Math.max(1, Math.round(img.height * k));
    const out = Buffer.alloc(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        // the source pixels this one covers, averaged
        const x0 = Math.floor(x / k), x1 = Math.max(x0 + 1, Math.floor((x + 1) / k)), y0 = Math.floor(y / k), y1 = Math.max(y0 + 1, Math.floor((y + 1) / k));
        let r = 0, g = 0, b = 0, n = 0;
        for (let sy = y0; sy < Math.min(y1, img.height); sy++) for (let sx = x0; sx < Math.min(x1, img.width); sx++) {
            const i = (sy * img.width + sx) * 4;
            r += img.rgba[i]; g += img.rgba[i + 1]; b += img.rgba[i + 2]; n++;
        }
        const o = (y * W + x) * 4;
        out[o] = n ? r / n : 0; out[o + 1] = n ? g / n : 0; out[o + 2] = n ? b / n : 0; out[o + 3] = 255;
    }
    return { data: Buffer.from(jpegJs.encode({ data: out, width: W, height: H }, MODEL_IMAGE_JPEG_QUALITY).data), width: W, height: H };
}
