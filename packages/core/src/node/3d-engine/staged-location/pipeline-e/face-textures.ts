/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The face textures of pipeline E before inference: each face's orthophoto of the photo tile, as rendered, and the texels
 * the tile does not cover filled from the nearest texel it does (labelled as such), or, on a face the tile does not see at
 * all (a party wall), the building's own median facade colour. The legend says where each texel came from.
 */

import { TEXTURE_LADDER_RUNGS } from '../../../../common/spatial/texture-pass-contracts';
import type { FaceTexture, TexelSource } from './massing-glb';
import type { FaceOrtho } from './native-massing';

const rung = (name: (typeof TEXTURE_LADDER_RUNGS)[number]) => TEXTURE_LADDER_RUNGS.indexOf(name);

/** Legend indices (TexelSource order); further entries are appended by the inference steps. */
export const SRC = { tileOrtho: 0, nearestFill: 1, facadeMedian: 2 } as const;

export function baseLegend(): TexelSource[] {
    return [
        { source: 'tile-ortho', label: 'as-scanned', method: 'the photo tile rendered orthographically through a thin slab about the face (the outermost surface facing out of it); on a wall the slab about its plane hardly sees, through the same slab about the depth where the tile\'s photo surface facing it lies, up to 4 m off (the face\'s textureOffsetM)', rung: rung('tile photo transfer'), weight: 0.5 },
        { source: 'nearest-observed', label: 'filled', method: 'a texel the tile does not cover on this face, given the colour of the nearest texel it does', rung: rung('measured palette colour'), weight: 0.15 },
        { source: 'facade-median', label: 'filled', method: "a face the tile does not see at all (against a neighbour, inside the block), given the building's median facade colour", rung: rung('measured palette colour'), weight: 0.05 }
    ];
}

/** Copies the ortho into a texture: covered texels as rendered (source tileOrtho), the rest 255-marked as not yet produced. */
export function textureFromOrtho(o: FaceOrtho): FaceTexture {
    const N = o.width * o.height;
    const rgba = new Uint8Array(o.rgba);
    const source = new Uint8Array(N).fill(255);
    for (let i = 0; i < N; i++) if (o.rgba[i * 4 + 3] === 255) source[i] = SRC.tileOrtho;
    return { width: o.width, height: o.height, rgba, source };
}

/**
 * Fills every texel without a source from the nearest texel with one (breadth-first, 8-connected), tagging it
 * `fillSource`; a texture with no source at all is set to `fallback` (tagged `fallbackSource`). Returns the count filled.
 */
export function fillNearest(t: FaceTexture, fillSource: number = SRC.nearestFill, fallback?: [number, number, number], fallbackSource: number = SRC.facadeMedian): number {
    const W = t.width, H = t.height, N = W * H;
    const queue = new Int32Array(N);
    const from = new Int32Array(N).fill(-1);
    let head = 0, tail = 0;
    for (let i = 0; i < N; i++) if (t.source[i] !== 255) { from[i] = i; queue[tail++] = i; }
    if (!tail) {
        if (!fallback) return 0;
        for (let i = 0; i < N; i++) { t.rgba.set(fallback, i * 4); t.rgba[i * 4 + 3] = 255; t.source[i] = fallbackSource; }
        return N;
    }
    let filled = 0;
    while (head < tail) {
        const i = queue[head++];
        const x = i % W, y = (i / W) | 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
            const j = yy * W + xx;
            if (from[j] >= 0) continue;
            from[j] = from[i];
            queue[tail++] = j;
        }
    }
    for (let i = 0; i < N; i++) {
        if (t.source[i] !== 255) continue;
        const s = from[i];
        t.rgba[i * 4] = t.rgba[s * 4]; t.rgba[i * 4 + 1] = t.rgba[s * 4 + 1]; t.rgba[i * 4 + 2] = t.rgba[s * 4 + 2]; t.rgba[i * 4 + 3] = 255;
        t.source[i] = fillSource;
        filled++;
    }
    return filled;
}

/** Median colour of the covered texels of several textures (subsampled). */
export function medianColour(textures: FaceTexture[]): [number, number, number] | undefined {
    const ch: number[][] = [[], [], []];
    for (const t of textures) {
        const step = Math.max(1, Math.floor((t.width * t.height) / 20000));
        for (let i = 0; i < t.width * t.height; i += step) if (t.source[i] === SRC.tileOrtho) for (let c = 0; c < 3; c++) ch[c].push(t.rgba[i * 4 + c]);
    }
    if (!ch[0].length) return undefined;
    return ch.map(v => { v.sort((a, b) => a - b); return v[v.length >> 1]; }) as [number, number, number];
}
