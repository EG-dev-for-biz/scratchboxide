/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A real photograph of one object as the reference of an object build (reference-object-builder.ts), in place of a
 * drawn one:
 *   1. Find: the chat's vision model gives a box and points on the described object (SegmentTargetLocator). It never
 *      draws the mask: models asked for masks were measured to invent them.
 *   2. Cut out: the app's segmenter turns those prompts into the object's mask (ObjectSegmenterService.segmentBytes:
 *      the MediaPipe Interactive Segmenter refined by GrabCut, the photo decoded inside the worker).
 *   3. Lay out: the object's own pixels on the plain #808080 backdrop the spec read and the comparisons expect, in a
 *      square cropped round it (cutOutReference); everything else, including what stood in front of it, is backdrop.
 * Nothing is written: the photo, its mask and the cut-out stay Buffers in this process. A described object that is
 * not in the photo fails; nothing is drawn instead.
 *
 * partsSeenFrom answers which of a build's parts a camera at the photo's viewpoint sees, so the parts the photo cannot
 * show (its back, what is behind) are labelled generated rather than photo-inferred.
 */

import { encodePng } from '../texture-processing';
import { decodeImageInMemory, type RgbaImage8 } from './staged-location/tile-texture-transfer';
import { ObjectSegmenterService } from '../video/ObjectSegmenterService';
import { SegmentTargetLocator, type LocatorModelSource, type NormBox } from '../video/segment-target-locator';
import type { TriangleSoup } from './part-connectivity';

/** sRGB grey of the backdrop: #808080, the drawn reference's. */
export const CUTOUT_BACKDROP = 128;
/** Backdrop round the object on every side, as a share of its larger side. */
export const CUTOUT_MARGIN = 0.08;
/** Long edge of the cut-out at most (the spec read downscales larger references to this anyway). */
export const CUTOUT_MAX_SIDE = 1024;

/** The object's mask in the photo, and what found and cut it. */
export interface PhotoMask {
    /** One byte a pixel over the whole photo, 1 for the object. */
    mask: Uint8Array;
    width: number;
    height: number;
    /** The object's share of the photo. */
    areaFraction: number;
    /** What found the object: the vision model and its own words for what it found. */
    locator?: { model: string; label: string };
    /** What cut the mask. */
    segmenter: string;
}

/**
 * Finds `target` in the photo and returns its mask; throws when it is not there. With `hint.box` (normalised
 * [x0, y0, x1, y1]) the object is known to be there: it is cut from that box and nobody is asked to find it.
 */
export type PhotoCutter = (photo: { data: Buffer; mimeType: string }, target: string, signal?: AbortSignal, hint?: { box?: NormBox }) => Promise<PhotoMask>;

/** The app's cutter: the chat's vision model boxes the object (unless the box is given), the segmenter cuts it (both in memory). */
export function segmenterPhotoCutter(source: LocatorModelSource, requestedModel?: string, segmenter: Pick<ObjectSegmenterService, 'segmentBytes'> = new ObjectSegmenterService()): PhotoCutter {
    return async (photo, target, signal, hint) => {
        if (hint?.box) {
            const cut = await segmenter.segmentBytes({ bytes: photo.data, box: hint.box, ...(signal ? { signal } : {}) });
            return { mask: cut.mask, width: cut.width, height: cut.height, areaFraction: cut.areaFraction, segmenter: cut.model };
        }
        const located = await new SegmentTargetLocator(source, requestedModel).locate({ imageBytes: photo.data, mimeType: photo.mimeType, target, ...(signal ? { signal } : {}) });
        const cut = await segmenter.segmentBytes({ bytes: photo.data, box: located.box, positive: located.positive, negative: located.negative, ...(signal ? { signal } : {}) });
        return { mask: cut.mask, width: cut.width, height: cut.height, areaFraction: cut.areaFraction, locator: { model: located.model, label: located.label }, segmenter: cut.model };
    };
}

export interface CutOutReference {
    /** The cut-out as a PNG. */
    data: Buffer;
    mimeType: 'image/png';
    /** Its side in pixels (it is square). */
    sizePx: number;
    /** The object's box in the photo, normalised [x0, y0, x1, y1]. */
    bbox: NormBox;
    /** Object pixels in the photo. */
    objectPixels: number;
}

/**
 * The object's pixels on the #808080 backdrop: a square round the mask's box with CUTOUT_MARGIN on every side, at the
 * photo's own resolution up to CUTOUT_MAX_SIDE (sampled bilinearly inside the object, never across its edge). A mask
 * of another size than the photo is read at the nearest pixel.
 */
export function cutOutReference(photo: RgbaImage8, cut: Pick<PhotoMask, 'mask' | 'width' | 'height'>): CutOutReference {
    const { width: W, height: H, rgba } = photo;
    const inMask = (x: number, y: number): boolean => {
        const mx = Math.min(cut.width - 1, Math.floor(((x + 0.5) * cut.width) / W));
        const my = Math.min(cut.height - 1, Math.floor(((y + 0.5) * cut.height) / H));
        return cut.mask[my * cut.width + mx] === 1;
    };
    let x0 = W, y0 = H, x1 = -1, y1 = -1, pixels = 0;
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            if (!inMask(x, y)) continue;
            pixels++;
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
        }
    }
    if (pixels === 0) throw new Error('the mask is empty: the segmenter cut nothing out of the photo');
    const side = Math.max(x1 - x0 + 1, y1 - y0 + 1) * (1 + 2 * CUTOUT_MARGIN);
    const cx = (x0 + x1 + 1) / 2, cy = (y0 + y1 + 1) / 2;
    const out = Math.max(1, Math.min(CUTOUT_MAX_SIDE, Math.round(side)));
    const scale = side / out;
    const left = cx - side / 2, top = cy - side / 2;
    const px = Buffer.alloc(out * out * 4);
    for (let oy = 0; oy < out; oy++) {
        for (let ox = 0; ox < out; ox++) {
            const o = (oy * out + ox) * 4;
            // the photo position of this output pixel's centre
            const sx = left + (ox + 0.5) * scale - 0.5, sy = top + (oy + 0.5) * scale - 0.5;
            const nx = Math.round(sx), ny = Math.round(sy);
            if (nx < 0 || ny < 0 || nx >= W || ny >= H || !inMask(nx, ny)) {
                px[o] = px[o + 1] = px[o + 2] = CUTOUT_BACKDROP;
                px[o + 3] = 255;
                continue;
            }
            // bilinear over the object's own neighbours only, so the backdrop never bleeds into its edge
            const fx = Math.floor(sx), fy = Math.floor(sy);
            const acc = [0, 0, 0];
            let wsum = 0;
            for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
                const x = fx + dx, y = fy + dy;
                if (x < 0 || y < 0 || x >= W || y >= H || !inMask(x, y)) continue;
                const w = (dx ? sx - fx : 1 - (sx - fx)) * (dy ? sy - fy : 1 - (sy - fy));
                if (w <= 0) continue;
                const i = (y * W + x) * 4;
                for (let k = 0; k < 3; k++) acc[k] += rgba[i + k] * w;
                wsum += w;
            }
            const i = (ny * W + nx) * 4;
            for (let k = 0; k < 3; k++) px[o + k] = wsum > 0 ? Math.round(acc[k] / wsum) : rgba[i + k];
            px[o + 3] = 255;
        }
    }
    return {
        data: encodePng(out, out, px),
        mimeType: 'image/png',
        sizePx: out,
        bbox: [x0 / W, y0 / H, (x1 + 1) / W, (y1 + 1) / H].map(v => +v.toFixed(4)) as NormBox,
        objectPixels: pixels
    };
}

/** Decodes a photo for cutOutReference; only PNG and JPEG decode in memory here. */
export function decodePhoto(data: Buffer): RgbaImage8 {
    try {
        return decodeImageInMemory(data);
    } catch (err) {
        throw new Error(`the photo could not be decoded (${(err as Error).message}); give it as a PNG or JPEG`);
    }
}

/** Where a camera stands, seen from the object: around +Y from its front (+Z) toward its right (+X), and above level. */
export interface PhotoView {
    azimuthDeg: number;
    elevationDeg: number;
}

/**
 * How many pixels of each part a camera at `view` sees, framed as the review renders frame a build (the whole build,
 * a 40 degree field of view): each part's triangles rasterised into one depth buffer, nearest wins. A part with no
 * pixel is hidden from that viewpoint, by the build itself or by facing away.
 */
export function partsSeenFrom(meshes: Map<string, TriangleSoup>, view: PhotoView, size = 256): Map<string, number> {
    const parts = [...meshes].filter(([, s]) => s.indices.length > 0);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const [, s] of parts) {
        const p = s.positions;
        for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[i + k]); max[k] = Math.max(max[k], p[i + k]); }
    }
    const seen = new Map<string, number>(parts.map(([id]) => [id, 0]));
    if (!Number.isFinite(min[0])) return seen;
    const center = [0, 1, 2].map(k => (min[k] + max[k]) / 2);
    const radius = Math.max(1e-3, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2);
    const fov = 40;
    const distance = (radius / Math.sin((fov * Math.PI) / 360)) * 1.15;
    const az = (view.azimuthDeg * Math.PI) / 180, el = (view.elevationDeg * Math.PI) / 180;
    const eye = [center[0] + distance * Math.cos(el) * Math.sin(az), center[1] + distance * Math.sin(el), center[2] + distance * Math.cos(el) * Math.cos(az)];
    const f = [center[0] - eye[0], center[1] - eye[1], center[2] - eye[2]];
    const fl = Math.hypot(f[0], f[1], f[2]);
    const fwd = f.map(v => v / fl);
    // straight down or up has no horizontal right: take the object's +X
    const rl = Math.hypot(fwd[0], fwd[2]);
    const right = rl > 1e-6 ? [-fwd[2] / rl, 0, fwd[0] / rl] : [1, 0, 0];
    const up = [right[1] * fwd[2] - right[2] * fwd[1], right[2] * fwd[0] - right[0] * fwd[2], right[0] * fwd[1] - right[1] * fwd[0]];
    const focal = 1 / Math.tan((fov * Math.PI) / 360);
    const depth = new Float32Array(size * size).fill(Infinity);
    const owner = new Int32Array(size * size).fill(-1);
    parts.forEach(([, s], partIndex) => {
        const p = s.positions, idx = s.indices, n = p.length / 3;
        const sx = new Float32Array(n), sy = new Float32Array(n), sz = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            const dx = p[i * 3] - eye[0], dy = p[i * 3 + 1] - eye[1], dz = p[i * 3 + 2] - eye[2];
            const z = dx * fwd[0] + dy * fwd[1] + dz * fwd[2];
            sz[i] = z;
            sx[i] = ((focal * (dx * right[0] + dy * right[1] + dz * right[2])) / z + 1) * 0.5 * size;
            sy[i] = (1 - (focal * (dx * up[0] + dy * up[1] + dz * up[2])) / z) * 0.5 * size;
        }
        for (let t = 0; t < idx.length; t += 3) {
            const a = idx[t], b = idx[t + 1], c = idx[t + 2];
            if (sz[a] <= 1e-6 || sz[b] <= 1e-6 || sz[c] <= 1e-6) continue;
            const area = (sx[b] - sx[a]) * (sy[c] - sy[a]) - (sx[c] - sx[a]) * (sy[b] - sy[a]);
            if (Math.abs(area) < 1e-12) continue;
            const minX = Math.max(0, Math.floor(Math.min(sx[a], sx[b], sx[c]))), maxX = Math.min(size - 1, Math.ceil(Math.max(sx[a], sx[b], sx[c])));
            const minY = Math.max(0, Math.floor(Math.min(sy[a], sy[b], sy[c]))), maxY = Math.min(size - 1, Math.ceil(Math.max(sy[a], sy[b], sy[c])));
            for (let y = minY; y <= maxY; y++) {
                const cy = y + 0.5;
                for (let x = minX; x <= maxX; x++) {
                    const cx = x + 0.5;
                    const w0 = ((sx[b] - cx) * (sy[c] - cy) - (sx[c] - cx) * (sy[b] - cy)) / area;
                    const w1 = ((sx[c] - cx) * (sy[a] - cy) - (sx[a] - cx) * (sy[c] - cy)) / area;
                    const w2 = 1 - w0 - w1;
                    if (w0 < 0 || w1 < 0 || w2 < 0) continue;
                    const z = 1 / (w0 / sz[a] + w1 / sz[b] + w2 / sz[c]);
                    const i = y * size + x;
                    if (z < depth[i]) { depth[i] = z; owner[i] = partIndex; }
                }
            }
        }
    });
    for (let i = 0; i < owner.length; i++) {
        if (owner[i] < 0) continue;
        const id = parts[owner[i]][0];
        seen.set(id, (seen.get(id) ?? 0) + 1);
    }
    return seen;
}

/** A part counts as seen when it covers at least this share of the build's pixels from the photo's viewpoint (and 2 pixels). */
export const SEEN_MIN_SHARE = 0.002;

/** The parts a camera at `view` does not see (a sliver under SEEN_MIN_SHARE of the build's pixels counts as unseen). */
export function partsOutOfView(meshes: Map<string, TriangleSoup>, view: PhotoView): string[] {
    const seen = partsSeenFrom(meshes, view);
    const total = [...seen.values()].reduce((a, b) => a + b, 0);
    const min = Math.max(2, SEEN_MIN_SHARE * total);
    return [...seen].filter(([, n]) => n < min).map(([id]) => id);
}
