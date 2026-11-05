/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The height a class's library set is drawn with (user ask, 2026-11-05: "real height, it moves the actual geometry"),
 * beside its roughness and normal (material-sets.ts, material-regions.ts): the set's height map at its real depth
 * (texture-library-heights.ts: the publisher's, else the labelled estimate), as a recess below the surface the class
 * lies on.
 *
 *  - Inward only. The surface a set is drawn on (a rebuilt facade's plane, a generated object's skin) is the set's
 *    highest level (its height map's `topPercentile`, so one bright speck does not sink the whole tile); everything else
 *    is recessed below it. Nothing ever stands out past the surface: a facade stays inside its footprint, and a joint is a
 *    groove, as built.
 *  - Scaled as the grain is. The recess is the set's depth times the share of its normal relief that is drawn
 *    (material-finish.ts finishMaps `relief`: the pick's confidence, the tile's fit to the class's repeat, the photo's
 *    texture energy, and the read roughness), so a set whose pattern was not confirmed, or a surface read smooth, gets as
 *    little height as it gets normal relief.
 *  - Capped at HEIGHT_RELIEF.capM, a few centimetres: surface relief, never massing.
 *
 * The result is one 8-bit map a set, 255 the surface and 0 a recess of capM, which the regions tile at the set's real
 * size exactly as they tile its occlusion and roughness. Labelled generated (a library set's relief, at an estimated
 * depth); it never moves a measured surface (AGENTS.md section 2): the scan's own pieces take none.
 */

import type { RgbaImage8 } from '../tile-texture-transfer';

export const MATERIAL_HEIGHT_VERSION = 'material-height/1';

export const HEIGHT_RELIEF = {
    /** The deepest recess drawn, metres: what a height map's 0 means everywhere it is written. */
    capM: 0.03,
    /** The share of a set's height texels at or below its surface level (see the file comment). */
    topPercentile: 0.98,
    /** A set whose deepest drawn recess is under this (metres) is drawn without a height: nothing a pixel could show. */
    minDepthM: 0.0005,
    /** The map's size, pixels a side at most (the regions' other prepared maps are this size). */
    size: 256
} as const;

/** What a set's height was drawn at, for the report and the GLB extras. */
export interface DrawnHeight {
    /** The set's real depth, black to white, metres, and where it comes from. */
    depthM: number; source: string;
    /** The share of that depth drawn (the normal relief's share). */
    relief: number;
    /** The deepest recess drawn, metres (at most HEIGHT_RELIEF.capM), and the mean. */
    maxRecessM: number; meanRecessM: number;
    label: 'generated';
}

/**
 * A set's height map (its red channel, any size) as the recess map the regions tile (see the file comment): box-filtered
 * to at most `size` a side, each texel 255 x (1 - recess / capM). Undefined when the drawn relief is too shallow to show.
 */
export function heightRecessMap(height: RgbaImage8, depthM: number, relief: number, source: string, R: typeof HEIGHT_RELIEF = HEIGHT_RELIEF): { map: RgbaImage8; drawn: DrawnHeight } | undefined {
    if (!(depthM > 0) || !(relief > 0)) return undefined;
    const scale = Math.min(1, R.size / Math.max(height.width, height.height));
    const w = Math.max(2, Math.round(height.width * scale)), h = Math.max(2, Math.round(height.height * scale));
    const v = new Float64Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const x0 = Math.floor((x * height.width) / w), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * height.width) / w));
        const y0 = Math.floor((y * height.height) / h), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height.height) / h));
        let s = 0;
        for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) s += height.rgba[(yy * height.width + xx) * 4];
        v[y * w + x] = s / ((x1 - x0) * (y1 - y0) * 255);
    }
    const sorted = Float64Array.from(v).sort();
    const top = sorted[Math.min(sorted.length - 1, Math.floor(R.topPercentile * (sorted.length - 1)))];
    const rgba = new Uint8Array(w * h * 4);
    let max = 0, sum = 0;
    for (let k = 0; k < w * h; k++) {
        const recess = Math.min(R.capM, Math.max(0, top - v[k]) * depthM * relief);
        if (recess > max) max = recess;
        sum += recess;
        const g = Math.round(255 * (1 - recess / R.capM));
        rgba[k * 4] = g; rgba[k * 4 + 1] = g; rgba[k * 4 + 2] = g; rgba[k * 4 + 3] = 255;
    }
    if (max < R.minDepthM) return undefined;
    const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
    return { map: { width: w, height: h, rgba }, drawn: { depthM: r4(depthM), source, relief: Math.round(relief * 100) / 100, maxRecessM: r4(max), meanRecessM: r4(sum / (w * h)), label: 'generated' } };
}
