/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Generative infill of the holes in an image: the pixels a mask marks, or the flat regions of one colour (a warp's white
 * disocclusion, an unseen plate's grey) at least HOLE_MIN_PIXELS large. The holes and the real pixels around them go
 * through the inpaint lock (texture-inpaint.ts inpaintImage: the image model sees the holes in magenta, its answer is kept
 * only when it reproduces the real pixels and joins them at the rim); only hole pixels are replaced, and the fill is
 * labelled generated. A rejected answer leaves the image as it was, with the reason.
 */

import { inpaintImage, type InpaintImageOutcome } from './3d-engine/staged-location/texture-inpaint';
import type { EnhanceModelClient } from './3d-engine/staged-location/texture-enhance';
import type { RgbaImage8 } from './3d-engine/staged-location/tile-texture-transfer';

/** A flat-colour region counts as a hole from this many pixels (smaller ones are highlights, glints, real flat paint). */
export const HOLE_MIN_PIXELS = 64;
/** Per-channel distance from the hole colour that still counts as the hole. */
export const HOLE_COLOUR_TOLERANCE = 6;
/** Holes grow by this much before the fill, so a hole's anti-aliased edge is filled too. */
export const HOLE_GROW_PX = 2;
/** The crop sent around the holes: their bounding box grown by this share of its size (at least HOLE_MARGIN_MIN_PX). */
export const HOLE_MARGIN_SHARE = 0.25;
export const HOLE_MARGIN_MIN_PX = 32;

export const photoInfillPrompt = (w: number, h: number): string =>
    `This ${w} x ${h} image is part of a photograph. The flat magenta (#FF00FF) regions are holes where the picture has no content. ` +
    'Fill only the magenta regions with what continues from around them: the same surfaces, materials, colours, lighting and perspective, any regular pattern (windows, courses, panels) carried through at the same scale and alignment. ' +
    'Do not change any pixel outside the magenta regions, do not add objects, people, vehicles, text or signs, and leave no magenta. Answer with the full image at the same framing.';

/** The hole pixels of `image` (1 = hole): the mask's set pixels, else the flat regions of `colour` of at least `minPixels`. */
export function findHoles(image: RgbaImage8, opts: { mask?: Uint8Array; colour?: [number, number, number]; tolerance?: number; minPixels?: number } = {}): Uint8Array {
    const { width: w, height: h, rgba } = image;
    const hole = new Uint8Array(w * h);
    if (opts.mask) {
        for (let i = 0; i < w * h; i++) hole[i] = opts.mask[i] ? 1 : 0;
        return hole;
    }
    const c = opts.colour ?? [255, 255, 255], tol = opts.tolerance ?? HOLE_COLOUR_TOLERANCE, minPx = opts.minPixels ?? HOLE_MIN_PIXELS;
    const flat = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) if (Math.abs(rgba[i * 4] - c[0]) <= tol && Math.abs(rgba[i * 4 + 1] - c[1]) <= tol && Math.abs(rgba[i * 4 + 2] - c[2]) <= tol) flat[i] = 1;
    // connected regions (4-neighbour) of the flat colour, kept when large enough
    const seen = new Uint8Array(w * h);
    for (let s = 0; s < w * h; s++) {
        if (!flat[s] || seen[s]) continue;
        const region: number[] = [], stack = [s];
        seen[s] = 1;
        while (stack.length) {
            const i = stack.pop()!;
            region.push(i);
            const x = i % w, y = (i - x) / w;
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const xx = x + dx, yy = y + dy;
                if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
                const j = yy * w + xx;
                if (flat[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
            }
        }
        if (region.length >= minPx) for (const i of region) hole[i] = 1;
    }
    return hole;
}

export interface HoleInfillResult {
    /** The image with its hole pixels filled (the input unchanged when nothing was accepted). */
    image: RgbaImage8;
    holePixels: number;
    filledPixels: number;
    decision: 'accepted' | 'rejected' | 'model_failed' | 'no_holes' | 'nothing_around';
    reason?: string;
    modelUsed?: string;
    metrics?: InpaintImageOutcome['metrics'];
    /** The crop sent: x, y, width, height. */
    crop?: [number, number, number, number];
    provenance?: { label: 'generated'; method: string };
}

/** Fills the holes of `image` (findHoles) through the inpaint lock; only hole pixels change. */
export async function infillImageHoles(input: {
    image: RgbaImage8; client: EnhanceModelClient; models: string[];
    mask?: Uint8Array; colour?: [number, number, number]; tolerance?: number; minPixels?: number; signal?: AbortSignal;
}): Promise<HoleInfillResult> {
    const { width: w, height: h } = input.image;
    const found = findHoles(input.image, input);
    // grown by HOLE_GROW_PX so the hole's soft edge goes too
    const hole = new Uint8Array(w * h);
    let holePixels = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let on = 0;
        for (let dy = -HOLE_GROW_PX; dy <= HOLE_GROW_PX && !on; dy++) for (let dx = -HOLE_GROW_PX; dx <= HOLE_GROW_PX && !on; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx >= 0 && yy >= 0 && xx < w && yy < h && found[yy * w + xx]) on = 1;
        }
        if (!on) continue;
        hole[y * w + x] = 1; holePixels++;
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
    if (!holePixels) return { image: input.image, holePixels: 0, filledPixels: 0, decision: 'no_holes' };
    const mx = Math.max(HOLE_MARGIN_MIN_PX, Math.round((x1 - x0 + 1) * HOLE_MARGIN_SHARE)), my = Math.max(HOLE_MARGIN_MIN_PX, Math.round((y1 - y0 + 1) * HOLE_MARGIN_SHARE));
    const cx = Math.max(0, x0 - mx), cy = Math.max(0, y0 - my), cw = Math.min(w, x1 + mx + 1) - cx, ch = Math.min(h, y1 + my + 1) - cy;
    const crop = new Uint8Array(cw * ch * 4), isHole = new Uint8Array(cw * ch), useKeep = new Uint8Array(cw * ch);
    let kept = 0;
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
        const i = (cy + y) * w + cx + x, o = y * cw + x;
        crop.set(input.image.rgba.subarray(i * 4, i * 4 + 4), o * 4);
        crop[o * 4 + 3] = 255;
        if (hole[i]) isHole[o] = 1; else { useKeep[o] = 1; kept++; }
    }
    if (kept < cw * ch * 0.1) return { image: input.image, holePixels, filledPixels: 0, decision: 'nothing_around', reason: `only ${kept} of ${cw * ch} pixels around the holes are real, too little to continue from`, crop: [cx, cy, cw, ch] };
    const out = await inpaintImage({ crop, w: cw, h: ch, isHole, useKeep, client: input.client, models: input.models, label: `infill ${holePixels} hole pixels`, prompt: photoInfillPrompt, ...(input.signal ? { signal: input.signal } : {}) });
    const base = { holePixels, crop: [cx, cy, cw, ch] as [number, number, number, number], ...(out.modelUsed ? { modelUsed: out.modelUsed } : {}), ...(out.metrics ? { metrics: out.metrics } : {}) };
    if (out.decision !== 'accepted' || !out.rgba) return { image: input.image, filledPixels: 0, decision: out.decision, ...(out.reason ? { reason: out.reason } : {}), ...base };
    const rgba = Uint8Array.from(input.image.rgba);
    let filled = 0;
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
        const o = y * cw + x;
        if (!isHole[o]) continue;
        const i = (cy + y) * w + cx + x;
        rgba.set(out.rgba.subarray(o * 4, o * 4 + 3), i * 4);
        rgba[i * 4 + 3] = 255;
        filled++;
    }
    return {
        image: { width: w, height: h, rgba }, filledPixels: filled, decision: 'accepted', ...base,
        provenance: { label: 'generated', method: `holes filled by ${out.modelUsed} from the pixels around them, kept only where the answer reproduced the real pixels and joined them at the rim; no real view of these pixels exists` }
    };
}
