/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline J's kept model (Trellis) can come back with real holes in its own generated texture: surfaces its four
 * input views never saw bake as flat black in the atlas (measured on a live Haughwout Building run: 7.8% of the
 * 2048x2048 texture, visible on the built facade as hard black tears -- the visual check scored that build 48/100 for
 * "severe tearing and missing faces... harsh black artifacts"). AGENTS.md's "believability first" default (a plausible
 * fill, never a blank gap) applies here the same as anywhere else the app paints a surface; today nothing fills these.
 *
 * Reuses image-hole-infill.ts's generic, already-proven hole detector and detail-locked inpaint (texture-inpaint.ts)
 * instead of new plumbing -- it already handles a warp's white disocclusion and an unseen plate's grey; this is the same
 * shape of problem with black as the hole colour instead.
 */

import { assembleGlb, parseGlbBytes } from '../glb-bytes';
import { decodeImageInMemory } from '../tile-texture-transfer';
import { encodePng } from '../../../texture-processing';
import { HOLE_MIN_PIXELS, infillImageHoles, type HoleInfillResult } from '../../../image-hole-infill';
import type { EnhanceModelClient } from '../texture-enhance';

/** A model texel this close to pure black (per channel) is a hole, not a genuinely dark real material. */
export const MODEL_TEXTURE_HOLE_COLOUR: [number, number, number] = [0, 0, 0];
export const MODEL_TEXTURE_HOLE_TOLERANCE = 4;

export interface ModelTextureInfillResult {
    /** Images carrying a baseColorTexture a material of the GLB uses. */
    images: number;
    holePixels: number;
    filledPixels: number;
    decision: HoleInfillResult['decision'] | 'no_images';
    reason?: string;
    modelUsed?: string;
}

/**
 * Fills the black holes (image-hole-infill.ts's findHoles, coloured `MODEL_TEXTURE_HOLE_COLOUR`) of every image a GLB's
 * materials use as a baseColorTexture; a GLB with none, or none holed, comes back byte-identical. Only the hole texels of
 * each image change -- the same per-image parse/patch/reserialize shape as refine.ts's `projectPlatesOntoGlb`.
 */
export async function infillModelTextureHoles(glbBytes: Buffer, opts: { client: EnhanceModelClient; models: string[]; minPixels?: number; signal?: AbortSignal }): Promise<{ glb: Buffer; result: ModelTextureInfillResult }> {
    const parsed = parseGlbBytes(glbBytes);
    const { json, bin } = parsed;
    const used = new Set<number>();
    for (const m of json.materials ?? []) {
        const texIdx = m.pbrMetallicRoughness?.baseColorTexture?.index;
        if (texIdx === undefined) continue;
        const src = json.textures?.[texIdx]?.source;
        if (src !== undefined && json.images?.[src]?.bufferView !== undefined) used.add(src);
    }
    if (!used.size) return { glb: glbBytes, result: { images: 0, holePixels: 0, filledPixels: 0, decision: 'no_images' } };

    let holePixels = 0, filledPixels = 0, modelUsed: string | undefined, reason: string | undefined, changed = false;
    let decision: ModelTextureInfillResult['decision'] = 'no_holes';
    let extra = Buffer.alloc(0);
    const base = bin.byteLength + ((4 - (bin.byteLength % 4)) % 4);
    for (const idx of used) {
        const img = json.images[idx];
        const bv = json.bufferViews[img.bufferView];
        const off = bv.byteOffset ?? 0;
        const bytes = Buffer.from(bin.buffer, bin.byteOffset + off, bv.byteLength);
        const decoded = decodeImageInMemory(bytes);
        const r = await infillImageHoles({
            image: decoded, client: opts.client, models: opts.models, colour: MODEL_TEXTURE_HOLE_COLOUR, tolerance: MODEL_TEXTURE_HOLE_TOLERANCE,
            minPixels: opts.minPixels ?? HOLE_MIN_PIXELS, ...(opts.signal ? { signal: opts.signal } : {})
        });
        holePixels += r.holePixels;
        if (r.decision === 'accepted') {
            filledPixels += r.filledPixels; modelUsed = r.modelUsed; decision = 'accepted'; changed = true;
            const png = encodePng(r.image.width, r.image.height, Buffer.from(r.image.rgba));
            json.bufferViews.push({ buffer: 0, byteOffset: base + extra.length, byteLength: png.length });
            img.bufferView = json.bufferViews.length - 1;
            img.mimeType = 'image/png';
            extra = Buffer.concat([extra, png, Buffer.alloc((4 - (png.length % 4)) % 4)]);
        } else if (r.holePixels && decision !== 'accepted') { decision = r.decision; reason = r.reason; }
    }
    if (!changed) return { glb: glbBytes, result: { images: used.size, holePixels, filledPixels: 0, decision, ...(reason ? { reason } : {}) } };
    const all = Buffer.concat([Buffer.from(bin.buffer, bin.byteOffset, bin.byteLength), Buffer.alloc(base - bin.byteLength), extra]);
    json.buffers = [{ ...(json.buffers?.[0] ?? {}), byteLength: all.length }];
    return { glb: assembleGlb(json, all), result: { images: used.size, holePixels, filledPixels, decision: 'accepted', ...(modelUsed ? { modelUsed } : {}) } };
}
