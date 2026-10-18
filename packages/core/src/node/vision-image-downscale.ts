/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { decodeImageToRgba, readImageDimensions } from './image-codec-ffmpeg';
import { encodePng } from './texture-processing';

/** Long edge a vision model needs to read an image's content (it tiles larger inputs itself, at more upload and latency). */
export const VISION_MAX_LONG_EDGE_PX = 1024;

/** An area-average (box) downscale: every source pixel counts once, so a large reduction does not alias. */
export function areaDownscaleRgba(rgba: Uint8Array, width: number, height: number, outW: number, outH: number): Buffer {
    const out = Buffer.alloc(outW * outH * 4);
    const sx = width / outW, sy = height / outH;
    for (let oy = 0; oy < outH; oy++) {
        const y0 = Math.floor(oy * sy), y1 = Math.max(y0 + 1, Math.floor((oy + 1) * sy));
        for (let ox = 0; ox < outW; ox++) {
            const x0 = Math.floor(ox * sx), x1 = Math.max(x0 + 1, Math.floor((ox + 1) * sx));
            let r = 0, g = 0, b = 0, a = 0;
            for (let y = y0; y < y1; y++) {
                for (let x = x0; x < x1; x++) {
                    const i = (y * width + x) * 4;
                    r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2]; a += rgba[i + 3];
                }
            }
            const n = (y1 - y0) * (x1 - x0), o = (oy * outW + ox) * 4;
            out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n); out[o + 2] = Math.round(b / n); out[o + 3] = Math.round(a / n);
        }
    }
    return out;
}

export interface VisionImage {
    data: Buffer;
    mimeType: string;
    width: number;
    height: number;
    originalWidth: number;
    originalHeight: number;
    downscaled: boolean;
}

/**
 * The image to send to a vision (understanding, not editing) model: unchanged when its long edge is within
 * maxLongEdge, else area-downscaled to that long edge and sent as PNG. Throws when the image does not decode.
 */
export async function downscaleForVision(image: Buffer, mimeType: string, maxLongEdge = VISION_MAX_LONG_EDGE_PX): Promise<VisionImage> {
    const dims = readImageDimensions(image);
    if (dims && Math.max(dims.width, dims.height) <= maxLongEdge) {
        return { data: image, mimeType, width: dims.width, height: dims.height, originalWidth: dims.width, originalHeight: dims.height, downscaled: false };
    }
    const decoded = await decodeImageToRgba(image);
    const long = Math.max(decoded.width, decoded.height);
    if (long <= maxLongEdge) {
        return { data: image, mimeType, width: decoded.width, height: decoded.height, originalWidth: decoded.width, originalHeight: decoded.height, downscaled: false };
    }
    const scale = maxLongEdge / long;
    const w = Math.max(1, Math.round(decoded.width * scale)), h = Math.max(1, Math.round(decoded.height * scale));
    return {
        data: encodePng(w, h, areaDownscaleRgba(decoded.rgba, decoded.width, decoded.height, w, h)),
        mimeType: 'image/png',
        width: w,
        height: h,
        originalWidth: decoded.width,
        originalHeight: decoded.height,
        downscaled: true
    };
}
