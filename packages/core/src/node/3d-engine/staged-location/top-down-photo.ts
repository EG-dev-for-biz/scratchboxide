/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A top-down render of a photo-textured tile over a ground rectangle: the tile photo as an orthophoto of the place, read
 * by the software rasteriser from a pinhole far above it (3 km up: a surface 30 m above the ground is drawn 1 % too
 * large, a kerb not at all), unlit (full ambient), one texel per `texelM`. Row 0 is the rectangle's minimum z, column 0
 * its minimum x, so a planar UV ((x - x0) / width, (z - z0) / height) reads the photo straight off it.
 */

import * as jpegJs from 'jpeg-js';
import type { PinholeCamera } from '../../../common/spatial/texture-pass-contracts';
import { renderTriangles } from './photo-match-eval';
import { readTileTriangles, type TileTriangles } from './tile-texture-transfer';

export interface TopDownFrame { x0: number; z0: number; widthM: number; heightM: number }

export interface TopDownPhoto {
    width: number;
    height: number;
    /** sRGB8 RGBA. */
    rgba: Uint8Array;
    texelM: number;
    triangles: number;
    ms: number;
}

export const TOP_DOWN_EYE_ABOVE_M = 3000;

/** The pinhole that sees `frame` from TOP_DOWN_EYE_ABOVE_M above `topY` at `texelM` per pixel (image rows toward +z). */
export function topDownCamera(frame: TopDownFrame, topY: number, texelM: number): PinholeCamera {
    const width = Math.max(1, Math.ceil(frame.widthM / texelM)), height = Math.max(1, Math.ceil(frame.heightM / texelM));
    const D = TOP_DOWN_EYE_ABOVE_M;
    const f = D / texelM;
    return {
        eye: [frame.x0 + frame.widthM / 2, topY + D, frame.z0 + frame.heightM / 2],
        right: [1, 0, 0], up: [0, 0, -1], fwd: [0, -1, 0],
        fx: f, fy: f, cx: width / 2, cy: height / 2, width, height
    };
}

/** Renders the tile (GLB bytes or its triangles) over `frame`. `maxPx` caps each side: the texel grows to fit. */
export function renderTopDownPhoto(tile: Uint8Array | TileTriangles, frame: TopDownFrame, opts: { texelM?: number; maxPx?: number } = {}): TopDownPhoto {
    const tris = tile instanceof Uint8Array ? readTileTriangles(tile) : tile;
    const maxPx = opts.maxPx ?? 4096;
    let texelM = opts.texelM ?? 0.1;
    texelM = Math.max(texelM, frame.widthM / maxPx, frame.heightM / maxPx);
    let topY = -Infinity;
    for (let i = 1; i < tris.positions.length; i += 3) topY = Math.max(topY, tris.positions[i]);
    if (topY === -Infinity) topY = 0;
    const camera = topDownCamera(frame, topY, texelM);
    const r = renderTriangles([tris], camera, { supersample: 1, ambient: 1, background: [128, 128, 128] });
    return { width: r.width, height: r.height, rgba: r.rgba, texelM, triangles: r.triangles, ms: r.ms };
}

/** The photo as a JPEG (quality 0..100). */
export function topDownJpeg(photo: TopDownPhoto, quality = 88): Buffer {
    const out = jpegJs.encode({ data: Buffer.from(photo.rgba.buffer, photo.rgba.byteOffset, photo.rgba.byteLength), width: photo.width, height: photo.height }, quality);
    return Buffer.from(out.data);
}
