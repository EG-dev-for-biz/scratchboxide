/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * An obstruction-free copy of a real Street View photograph (the standing rule: references are clean of trees, vehicles,
 * people and street furniture; trees come back separately, grown by SB-Veggie). The occluder mask streetview-ownership.ts
 * already makes (what stands between the camera and the structure's own surface) goes through the inpaint lock
 * (image-hole-infill.ts -> texture-inpaint.ts: the model sees the occluders as magenta holes, its answer is kept only when it
 * reproduces the real pixels around them and joins them at the rim), so only occluder pixels change and they are labelled
 * generated. A rejected or failed fill leaves the photograph as it was, with the reason: the occluders stay masked out, as
 * before this step existed.
 *
 * The clean copy is a REFERENCE (what an image model is shown), never a measurement: texels projected from a photo and the
 * real-data-only evidence tools keep the raw capture; a clean copy only sits alongside it.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { infillImageHoles, type HoleInfillResult } from '../../image-hole-infill';
import type { EnhanceModelClient } from './texture-enhance';
import type { RgbaImage8 } from './tile-texture-transfer';
import { encodePng } from '../../texture-processing';
import { decodeImageInMemory } from './tile-texture-transfer';

export const STREETVIEW_CLEAN_VERSION = 1;
/** Fewer occluder pixels than this is nothing worth a model call. */
export const CLEAN_MIN_PIXELS = 64;

/** On unless SCRATCHBOX_STREETVIEW_CLEAN=0. */
export function streetViewCleanEnabled(): boolean {
    return process.env.SCRATCHBOX_STREETVIEW_CLEAN !== '0';
}

/** The instruction sent with the occluders painted magenta. */
export const occluderRemovalPrompt = (w: number, h: number): string =>
    `This ${w} x ${h} image is part of a street-level photograph of a building. The flat magenta (#FF00FF) regions are where something stood in front of the building ` +
    '(a tree, a vehicle, a person, a pole, a sign, a wire or scaffolding) and has been removed. Fill only the magenta regions with what is behind it: the building\'s own surface ' +
    'continuing from around the hole (the same walls, windows, frames, courses, materials and colours, any regular pattern carried through at the same scale and alignment, ' +
    'in the same perspective and light), or the ground and street continuing where the hole reaches below the building. ' +
    'Do not change any pixel outside the magenta regions. Draw no trees, foliage, vehicles, people, poles, signs, wires or scaffolding, and leave no magenta. Answer with the full image at the same framing.';

export interface StreetViewCleanResult {
    /** The clean copy (the input itself when nothing was filled). */
    image: RgbaImage8;
    /** 1 where a pixel is generated (an occluder filled), at the image's size; all 0 when nothing was filled. */
    filledMask: Uint8Array;
    occluderPixels: number;
    filledPixels: number;
    decision: HoleInfillResult['decision'] | 'disabled' | 'too_few_occluders';
    reason?: string;
    modelUsed?: string;
    /** Filled pixels: generated, with why; every other pixel is the photograph's own. */
    provenance: { label: 'generated'; method: string } | { label: 'as-captured'; method: string };
    cached?: boolean;
}

/** Identity of one clean request (photo, mask, version): the cache key. */
export function cleanKey(image: RgbaImage8, occluders: Uint8Array): string {
    return crypto.createHash('sha256').update(`v${STREETVIEW_CLEAN_VERSION}|${image.width}x${image.height}|`).update(image.rgba).update(occluders).digest('hex');
}

/**
 * The obstruction-free copy of `image`: the `occluders` pixels (1 = something in front of the structure) filled through the
 * inpaint lock. `cacheDir` keeps answers by cleanKey (an accepted fill as PNG + its mask; a refusal as its reason).
 */
export async function cleanStreetViewImage(input: {
    image: RgbaImage8; occluders: Uint8Array; client: EnhanceModelClient; models: string[]; cacheDir?: string; signal?: AbortSignal;
}): Promise<StreetViewCleanResult> {
    const { image, occluders } = input;
    const n = image.width * image.height;
    let occ = 0;
    for (let i = 0; i < n; i++) if (occluders[i]) occ++;
    const none = new Uint8Array(n);
    const asCaptured = { label: 'as-captured' as const, method: 'the Street View photograph as captured' };
    if (!streetViewCleanEnabled()) return { image, filledMask: none, occluderPixels: occ, filledPixels: 0, decision: 'disabled', reason: 'SCRATCHBOX_STREETVIEW_CLEAN=0', provenance: asCaptured };
    if (occ < CLEAN_MIN_PIXELS) return { image, filledMask: none, occluderPixels: occ, filledPixels: 0, decision: 'too_few_occluders', reason: `${occ} occluder pixels, nothing worth filling`, provenance: asCaptured };
    const key = input.cacheDir ? cleanKey(image, occluders) : undefined;
    const hit = key ? readCached(input.cacheDir!, key, image, occ) : undefined;
    if (hit) return hit;
    let out: HoleInfillResult;
    try {
        out = await infillImageHoles({ image, mask: occluders, client: input.client, models: input.models, prompt: occluderRemovalPrompt, ...(input.signal ? { signal: input.signal } : {}) });
    } catch (err) {
        if (input.signal?.aborted) throw err;
        out = { image, holePixels: occ, filledPixels: 0, decision: 'model_failed', reason: `the image model did not answer (${err instanceof Error ? err.message : String(err)}); the occluders stay masked out` };
    }
    const result: StreetViewCleanResult = out.decision === 'accepted' && out.filledMask
        ? {
            image: out.image, filledMask: out.filledMask, occluderPixels: occ, filledPixels: out.filledPixels, decision: 'accepted', ...(out.modelUsed ? { modelUsed: out.modelUsed } : {}),
            provenance: { label: 'generated', method: `occluders in front of the structure (trees, vehicles, people, street furniture) removed: ${out.provenance?.method ?? 'filled through the inpaint lock'}` }
        }
        : {
            image, filledMask: none, occluderPixels: occ, filledPixels: 0, decision: out.decision, ...(out.modelUsed ? { modelUsed: out.modelUsed } : {}),
            reason: out.reason ?? `the fill was not kept (${out.decision}); the occluders stay masked out`, provenance: asCaptured
        };
    if (key) writeCached(input.cacheDir!, key, result);
    return result;
}

function readCached(dir: string, key: string, image: RgbaImage8, occ: number): StreetViewCleanResult | undefined {
    const meta = path.join(dir, `${key}.json`);
    if (!fs.existsSync(meta)) return undefined;
    try {
        const m = JSON.parse(fs.readFileSync(meta, 'utf8'));
        if (m.decision !== 'accepted') return { image, filledMask: new Uint8Array(image.width * image.height), occluderPixels: occ, filledPixels: 0, decision: m.decision, reason: m.reason, provenance: m.provenance, cached: true };
        const img = decodeImageInMemory(fs.readFileSync(path.join(dir, `${key}.png`)));
        const mask = new Uint8Array(fs.readFileSync(path.join(dir, `${key}.mask`)));
        if (img.width !== image.width || img.height !== image.height || mask.length !== image.width * image.height) return undefined;
        return { image: img, filledMask: mask, occluderPixels: occ, filledPixels: m.filledPixels, decision: 'accepted', ...(m.modelUsed ? { modelUsed: m.modelUsed } : {}), provenance: m.provenance, cached: true };
    } catch { return undefined; }
}

function writeCached(dir: string, key: string, r: StreetViewCleanResult): void {
    fs.mkdirSync(dir, { recursive: true });
    if (r.decision === 'accepted') {
        fs.writeFileSync(path.join(dir, `${key}.png`), encodePng(r.image.width, r.image.height, Buffer.from(r.image.rgba)));
        fs.writeFileSync(path.join(dir, `${key}.mask`), r.filledMask);
    }
    // a model failure is transient: not cached, so the next build asks again
    if (r.decision === 'model_failed') return;
    fs.writeFileSync(path.join(dir, `${key}.json`), JSON.stringify({ decision: r.decision, reason: r.reason, filledPixels: r.filledPixels, modelUsed: r.modelUsed, provenance: r.provenance }));
}
