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
import type { JointRegistrationResult } from './pano-joint-registration';
import type { EnhanceModelClient } from './texture-enhance';
import type { RgbaImage8 } from './tile-texture-transfer';
import { encodePng } from '../../texture-processing';
import { decodeImageInMemory } from './tile-texture-transfer';

export const STREETVIEW_CLEAN_VERSION = 3;
/** After a fill, an occluder still found on more than this share of the filled pixels fails the check (retry once, then reject). */
export const CLEAN_MAX_RESIDUAL_SHARE = 0.03;
/** Fewer occluder pixels than this is nothing worth a model call. */
export const CLEAN_MIN_PIXELS = 64;
/** Most of the structure a fill may redraw: filled pixels over the structure's owned + occluded pixels in the view. */
export const CLEAN_MAX_FILL_SHARE = 0.3;
/**
 * Least held-out gradient NCC of the view's registration for a clean-up when its outline comes from the pose (geometry prompts;
 * a described cut-out is located pose-free and needs no registration): the occluders are located inside the structure's
 * projected silhouette, and below this the projection does not say where the structure is (the 488 Broadway survey's
 * views registered at 0.02, where the silhouette sat on the neighbours).
 */
export const CLEAN_MIN_REGISTRATION_NCC = 0.1;
/** A filled pixel the model left in the hole colour (magenta) is not filled: it goes back to the photo as captured. */
const holeColourLeft = (p: Uint8Array, o: number) => p[o] > 200 && p[o + 2] > 200 && p[o + 1] < 90;

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

/** The retry after a fill left an occluder standing: the same request, said harder. */
export const occluderRemovalRetryPrompt = (w: number, h: number): string =>
    occluderRemovalPrompt(w, h) + ' A previous attempt redrew part of the removed object (a pole, banner, sign, branch or vehicle) inside the magenta regions: that is wrong. ' +
    'Inside the magenta regions there must be ONLY the building surface (or ground) that is behind it, nothing standing in front of it.';

export interface StreetViewCleanResult {
    /** The clean copy (the input itself when nothing was filled). */
    image: RgbaImage8;
    /** 1 where a pixel is generated (an occluder filled), at the image's size; all 0 when nothing was filled. */
    filledMask: Uint8Array;
    occluderPixels: number;
    filledPixels: number;
    decision: HoleInfillResult['decision'] | 'disabled' | 'too_few_occluders' | 'rejected_residual' | 'weak_registration' | 'fill_too_large';
    /** The check after the fill (verify given): occluder pixels still found inside the filled area, per attempt. */
    verify?: { attempts: Array<{ residualPixels: number; residualShare: number }>; verdict: 'accepted' | 'retried' | 'rejected' };
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
    /**
     * The check after a fill: the occluder detection run on the cleaned copy (1 = still something standing in front),
     * judged inside the filled pixels only. Absent: no check.
     */
    verify?: (cleaned: RgbaImage8, filledMask: Uint8Array) => Promise<Uint8Array>;
    /** The view's registration (held-out gradient NCC); below CLEAN_MIN_REGISTRATION_NCC nothing is cleaned. Absent: not judged. */
    registrationNcc?: number | null;
    /** The structure's owned + occluded pixels in the view; a fill over CLEAN_MAX_FILL_SHARE of them is refused. Absent: no cap. */
    structurePixels?: number;
}): Promise<StreetViewCleanResult> {
    const { image, occluders } = input;
    const n = image.width * image.height;
    let occ = 0;
    for (let i = 0; i < n; i++) if (occluders[i]) occ++;
    const none = new Uint8Array(n);
    const asCaptured = { label: 'as-captured' as const, method: 'the Street View photograph as captured' };
    if (!streetViewCleanEnabled()) return { image, filledMask: none, occluderPixels: occ, filledPixels: 0, decision: 'disabled', reason: 'SCRATCHBOX_STREETVIEW_CLEAN=0', provenance: asCaptured };
    if (occ < CLEAN_MIN_PIXELS) return { image, filledMask: none, occluderPixels: occ, filledPixels: 0, decision: 'too_few_occluders', reason: `${occ} occluder pixels, nothing worth filling`, provenance: asCaptured };
    if (input.registrationNcc !== undefined && (input.registrationNcc === null || input.registrationNcc < CLEAN_MIN_REGISTRATION_NCC))
        return { image, filledMask: none, occluderPixels: occ, filledPixels: 0, decision: 'weak_registration', reason: `registration too weak to locate occluders (held-out gradient NCC ${input.registrationNcc ?? 'n/a'}, at least ${CLEAN_MIN_REGISTRATION_NCC} needed); the photograph is kept as captured`, provenance: asCaptured };
    const tooLarge = (px: number) => input.structurePixels !== undefined && px > CLEAN_MAX_FILL_SHARE * input.structurePixels;
    const tooLargeReason = (px: number) => `the fill would redraw ${px} of the structure's ${input.structurePixels} pixels in this view (more than ${100 * CLEAN_MAX_FILL_SHARE} percent): too much of the reference would be generated; the photograph is kept as captured`;
    if (tooLarge(occ)) return { image, filledMask: none, occluderPixels: occ, filledPixels: 0, decision: 'fill_too_large', reason: tooLargeReason(occ), provenance: asCaptured };
    const key = input.cacheDir ? cleanKey(image, occluders) : undefined;
    const hit = key ? readCached(input.cacheDir!, key, image, occ) : undefined;
    if (hit) return hit;
    const fill = async (prompt: (w: number, h: number) => string): Promise<HoleInfillResult> => {
        try {
            return restoreUnfilled(await infillImageHoles({ image, mask: occluders, client: input.client, models: input.models, prompt, ...(input.signal ? { signal: input.signal } : {}) }), image);
        } catch (err) {
            if (input.signal?.aborted) throw err;
            return { image, holePixels: occ, filledPixels: 0, decision: 'model_failed', reason: `the image model did not answer (${err instanceof Error ? err.message : String(err)}); the occluders stay masked out` };
        }
    };
    // the check: what the occluder detection still finds inside the filled pixels of a cleaned copy
    const residual = async (r: HoleInfillResult) => {
        const found = await input.verify!(r.image, r.filledMask!);
        let n = 0, f = 0;
        for (let i = 0; i < found.length; i++) if (r.filledMask![i]) { f++; if (found[i]) n++; }
        return { residualPixels: n, residualShare: f ? Math.round((n / f) * 1000) / 1000 : 0 };
    };
    let out = await fill(occluderRemovalPrompt);
    let verify: StreetViewCleanResult['verify'];
    if (out.decision === 'accepted' && out.filledMask && input.verify) {
        const attempts = [await residual(out)];
        if (attempts[0].residualShare > CLEAN_MAX_RESIDUAL_SHARE) {
            const again = await fill(occluderRemovalRetryPrompt);
            if (again.decision === 'accepted' && again.filledMask) attempts.push(await residual(again));
            const ok = attempts.length > 1 && attempts[1].residualShare <= CLEAN_MAX_RESIDUAL_SHARE;
            verify = { attempts, verdict: ok ? 'retried' : 'rejected' };
            if (ok) out = again;
            else out = { image, holePixels: occ, filledPixels: 0, decision: 'rejected_residual' as HoleInfillResult['decision'],
                reason: `the fill left something standing in front of the structure (${(100 * attempts[attempts.length - 1].residualShare).toFixed(1)} percent of the filled pixels still read as an occluder after ${attempts.length} attempt(s)); the photograph is kept as captured, its occluders masked out` };
        } else verify = { attempts, verdict: 'accepted' };
    }
    if (out.decision === 'accepted' && tooLarge(out.filledPixels))
        out = { image, holePixels: occ, filledPixels: 0, decision: 'fill_too_large' as HoleInfillResult['decision'], reason: tooLargeReason(out.filledPixels) };
    const result: StreetViewCleanResult = out.decision === 'accepted' && out.filledMask
        ? {
            image: out.image, filledMask: out.filledMask, occluderPixels: occ, filledPixels: out.filledPixels, decision: 'accepted', ...(out.modelUsed ? { modelUsed: out.modelUsed } : {}), ...(verify ? { verify } : {}),
            provenance: { label: 'generated', method: `occluders in front of the structure (trees, vehicles, people, street furniture) removed: ${out.provenance?.method ?? 'filled through the inpaint lock'}${verify ? `; checked after the fill (${verify.verdict}, residual ${(100 * verify.attempts[verify.attempts.length - 1].residualShare).toFixed(1)} percent)` : ''}` }
        }
        : {
            image, filledMask: none, occluderPixels: occ, filledPixels: 0, decision: out.decision as StreetViewCleanResult['decision'], ...(out.modelUsed ? { modelUsed: out.modelUsed } : {}), ...(verify ? { verify } : {}),
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
        if (m.decision !== 'accepted') return { image, filledMask: new Uint8Array(image.width * image.height), occluderPixels: occ, filledPixels: 0, decision: m.decision, reason: m.reason, provenance: m.provenance, ...(m.verify ? { verify: m.verify } : {}), cached: true };
        const img = decodeImageInMemory(fs.readFileSync(path.join(dir, `${key}.png`)));
        const mask = new Uint8Array(fs.readFileSync(path.join(dir, `${key}.mask`)));
        if (img.width !== image.width || img.height !== image.height || mask.length !== image.width * image.height) return undefined;
        return { image: img, filledMask: mask, occluderPixels: occ, filledPixels: m.filledPixels, decision: 'accepted', ...(m.modelUsed ? { modelUsed: m.modelUsed } : {}), ...(m.verify ? { verify: m.verify } : {}), provenance: m.provenance, cached: true };
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
    fs.writeFileSync(path.join(dir, `${key}.json`), JSON.stringify({ decision: r.decision, reason: r.reason, filledPixels: r.filledPixels, modelUsed: r.modelUsed, provenance: r.provenance, verify: r.verify }));
}

/** Filled pixels the model left in the hole colour (it does at the frame edge) go back to the photo as captured and out of the filled mask. */
function restoreUnfilled(r: HoleInfillResult, photo: RgbaImage8): HoleInfillResult {
    if (r.decision !== 'accepted' || !r.filledMask) return r;
    let back = 0;
    for (let i = 0; i < r.filledMask.length; i++) if (r.filledMask[i] && holeColourLeft(r.image.rgba, i * 4)) {
        r.image.rgba.set(photo.rgba.subarray(i * 4, i * 4 + 4), i * 4);
        r.filledMask[i] = 0; back++;
    }
    return back ? { ...r, filledPixels: r.filledPixels - back } : r;
}

/** The held-out gradient NCC of the registration in force for one pano (its frames' mean); null when no joint fit measured it. */
export function registrationNcc(reg: { joint?: JointRegistrationResult } | undefined, panoId: string): number | null {
    const j = reg?.joint;
    if (!j) return null;
    const fit = j.chosen === 'joint+warp' ? (j.fit.warped ?? j.fit.joint) : j.chosen === 'joint' ? j.fit.joint : j.fit.current;
    const v = (fit?.views ?? []).filter(x => x.panoId === panoId && x.gradNcc !== null).map(x => x.gradNcc!);
    return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 1000) / 1000 : null;
}
