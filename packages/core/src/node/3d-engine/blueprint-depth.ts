/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Where a blueprint drawing's surface sinks inside its outline, read by the app's one depth model (Depth Anything V2
 * Small, PanoramaDepthService): intakes, a recessed grille, glass set behind its frame. The model gives relative depth
 * with no scale, so only the shape of the sinks is kept: each pixel's depth less the masked local average around it,
 * the positive part (farther than its surroundings), normalised so the deepest sinks are 1, and pooled into a grid
 * over the silhouette's box (row 0 at the top). A lofted part may then take it as relief within a few centimetres of
 * its surface (fromBlueprint.reliefMeters); it never moves the outline. Labelled photo-inferred.
 */

import type { ReliefGrid } from '../../common/spatial/blueprint-loft';
import type { Silhouette } from './blueprint-outlines';

/** Grid size over a view's silhouette box: across x rows. */
export const RELIEF_GRID: Record<'front' | 'side', [number, number]> = { front: [48, 36], side: [96, 36] };
/** The local average's radius, as a share of the silhouette box's larger side. */
const BLUR_SHARE = 0.04;
/** Sinks are scaled so this percentile of them is 1 (the few deepest saturate). */
const SINK_PERCENTILE = 0.98;

/** Box blur of `v` over pixels where `mask` is set, two passes each way (about a Gaussian), normalised by the mask. */
function maskedBlur(v: Float32Array, mask: Uint8Array, w: number, h: number, r: number): Float32Array {
    let num: Float32Array = new Float32Array(w * h), den: Float32Array = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) if (mask[i]) { num[i] = v[i]; den[i] = 1; }
    const pass = (src: Float32Array, horizontal: boolean): Float32Array<ArrayBufferLike> => {
        const out = new Float32Array(w * h);
        const [outer, inner] = horizontal ? [h, w] : [w, h];
        for (let o = 0; o < outer; o++) {
            let acc = 0;
            const at = (k: number) => horizontal ? o * w + k : k * w + o;
            for (let k = -r; k <= r; k++) if (k >= 0 && k < inner) acc += src[at(k)];
            for (let k = 0; k < inner; k++) {
                out[at(k)] = acc;
                const add = k + r + 1, drop = k - r;
                if (add < inner) acc += src[at(add)];
                if (drop >= 0) acc -= src[at(drop)];
            }
        }
        return out;
    };
    for (let p = 0; p < 2; p++) {
        num = pass(pass(num, true), false);
        den = pass(pass(den, true), false);
    }
    const out = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) out[i] = den[i] > 0 ? num[i] / den[i] : 0;
    return out;
}

/** Pixels at least r from the mask's edge (every pixel of the (2r+1)^2 square around them set), by a summed-area table. */
function interior(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
    const sat = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
        let row = 0;
        for (let x = 0; x < w; x++) {
            row += mask[y * w + x];
            sat[(y + 1) * (w + 1) + x + 1] = sat[y * (w + 1) + x + 1] + row;
        }
    }
    const out = new Uint8Array(w * h);
    const full = (2 * r + 1) * (2 * r + 1);
    for (let y = r; y < h - r; y++) {
        for (let x = r; x < w - r; x++) {
            const x0 = x - r, y0 = y - r, x1 = x + r + 1, y1 = y + r + 1;
            const sum = sat[y1 * (w + 1) + x1] - sat[y0 * (w + 1) + x1] - sat[y1 * (w + 1) + x0] + sat[y0 * (w + 1) + x0];
            if (sum === full) out[y * w + x] = 1;
        }
    }
    return out;
}

/**
 * The relief grid of one view: depths (row-major, the drawing's size) and its silhouette. Values are 0 (flush) to
 * -1 (the deepest sinks), one per grid cell over the silhouette box; cells outside the silhouette are 0.
 */
export function reliefGrid(depths: Float32Array, s: Silhouette, cols: number, rows: number): ReliefGrid {
    const { width: w, height: h, mask, box } = s;
    if (depths.length !== w * h) throw new Error(`the depth map is ${depths.length} values for a ${w} x ${h} drawing`);
    const r = Math.max(2, Math.round(BLUR_SHARE * Math.max(box.x1 - box.x0 + 1, box.y1 - box.y0 + 1)));
    const local = maskedBlur(depths, mask, w, h, r);
    // at the outline the depth jumps to the background, which reads as a deep sink: a band as wide as the blur radius
    // inside the outline is left out, so the relief never eats into the outline itself
    const inner = interior(mask, w, h, r);
    const sink = new Float32Array(w * h);
    const positives: number[] = [];
    for (let i = 0; i < w * h; i++) {
        if (!inner[i]) continue;
        const d = depths[i] - local[i];
        if (d > 0) { sink[i] = d; positives.push(d); }
    }
    positives.sort((a, b) => a - b);
    const scale = positives.length ? positives[Math.min(positives.length - 1, Math.floor(SINK_PERCENTILE * positives.length))] : 0;
    const values: number[] = [];
    const bw = box.x1 - box.x0 + 1, bh = box.y1 - box.y0 + 1;
    for (let gy = 0; gy < rows; gy++) {
        for (let gx = 0; gx < cols; gx++) {
            const x0 = box.x0 + Math.floor(gx * bw / cols), x1 = box.x0 + Math.floor((gx + 1) * bw / cols);
            const y0 = box.y0 + Math.floor(gy * bh / rows), y1 = box.y0 + Math.floor((gy + 1) * bh / rows);
            let sum = 0, n = 0;
            for (let y = y0; y < Math.max(y1, y0 + 1); y++) for (let x = x0; x < Math.max(x1, x0 + 1); x++) {
                const i = y * w + x;
                if (!mask[i]) continue;
                sum += scale > 0 ? Math.min(1, sink[i] / scale) : 0;
                n++;
            }
            values.push(n ? -Math.round(sum / n * 1000) / 1000 + 0 : 0);
        }
    }
    return { cols, rows, values };
}
