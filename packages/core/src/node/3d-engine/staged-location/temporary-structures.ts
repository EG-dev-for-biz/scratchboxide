/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Temporary structures in Street View photos: whatever covers or stands in front of the building for a while and is not
 * part of it (the prompt names scaffolding, netting, cranes, sidewalk sheds, barriers, construction equipment and event
 * structures as examples only; there is no list in code). A capture taken while it stood paints it onto the texture.
 *
 * - One open-vocabulary question per photo to the repo's vision model chain: is anything temporary covering or in front
 *   of the target building, how sure, what it is (free text, recorded, never branched on), and its outline(s) in the photo
 *   ([y, x] in 0..1000, as the mask vote's outlines). A reply is flagged when present with confidence at least
 *   TEMPORARY_MIN_CONFIDENCE.
 * - streetview_survey (checkTemporary): a face whose view is flagged gets the best eligible pano of the same face from
 *   another capture month (one per month, up to TEMPORARY_ALTERNATIVES_MAX), the first clear one replacing it; with none
 *   clear the view is kept and flagged. Every swap and every kept view is recorded with why.
 * - The texture pass (SCRATCHBOX_SURVEY_TEMPORARY=1 only): the flagged regions are taken out of each view's ownership
 *   mask, so those pixels texture nothing (they are treated as occluders).
 *
 * A view whose question fails is recorded as unchecked with the error, never as clear.
 */

import * as jpegJs from 'jpeg-js';
import type { VisionModelChain } from '../../gemini/vision-model-chain';
import type { ProjectionView } from '../../../common/spatial/texture-pass-contracts';
import { callTimeout, type CallTimer } from './call-timer';
import { capImageSide } from './ornament-batches';
import { ORNAMENT_THINKING_BUDGET } from './ornament-vision';
import { rasterizeOutlines, type OutlinePolygon } from './ownership-masks';
import { dilateMask } from './streetview-ownership';
import { fetchViews, type EvidenceImage, type PanoCandidate, type StreetViewEvidenceDeps } from './streetview-evidence';
import { surveyCandidates, surveyViewFor, SURVEY_IMAGE_TIMEOUT_MS, type SurveyCandidate, type SurveyFaceTarget, type SurveyView } from './face-survey';

/** Part of the texture cache key: a change to the check is a new version. */
export const TEMPORARY_CHECK_VERSION = 1;
/** The env flag that turns the check on for the staged texture pass (and is streetview_survey's default when set). */
export const TEMPORARY_ENV_FLAG = 'SCRATCHBOX_SURVEY_TEMPORARY';
/** A reading flags its view at or above this confidence. */
export const TEMPORARY_MIN_CONFIDENCE = 0.5;
/** Other capture months tried for a flagged view. */
export const TEMPORARY_ALTERNATIVES_MAX = 3;
/** Longest side of the image sent (the outlines are in 0..1000 of the image, so the size sent does not change them). */
export const TEMPORARY_SEND_MAX_SIDE_PX = 1024;
export const TEMPORARY_CALL_TIMEOUT_MS = 90_000;
const TEMPORARY_MAX_OUTPUT_TOKENS = 8192;
/** A flagged view whose outlines hold less than this share on its own face is not replaced (the thing stands elsewhere). */
export const TEMPORARY_ON_FACE_MIN_SHARE = 0.2;
/**
 * A clear alternative must show the building: at least this share of its photo, and at least
 * TEMPORARY_ALT_MIN_SHARE_RATIO of the share the flagged view showed (an indoor pano, or one looking mostly at a neighbour,
 * is not a replacement).
 */
export const TEMPORARY_ALT_MIN_BUILDING_SHARE = 0.15;
export const TEMPORARY_ALT_MIN_SHARE_RATIO = 0.5;
/** Pixels (share of the longest side) the flagged regions are grown by before they are taken out of a mask. */
export const TEMPORARY_DILATE_SHARE = 0.006;

export function temporaryCheckEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return env[TEMPORARY_ENV_FLAG] === '1';
}

export interface TemporaryRegion {
    /** The outline in image pixels at the delivered size, [x, y]. */
    polygon: Array<[number, number]>;
    /** What the model says this region is (free text). */
    description?: string;
}

export interface TemporaryReading {
    present: boolean;
    /** 0..1, the model's own. */
    confidence: number;
    /** Free text: what it is and where on the building. Recorded, never branched on. */
    description: string;
    regions: TemporaryRegion[];
    /** Share of the photo (0..1) the outside of the building occupies, anything temporary on it included; 0 when it is not in the photo or the photo is indoors. */
    buildingShare?: number;
    /** present and confidence >= TEMPORARY_MIN_CONFIDENCE. */
    flagged: boolean;
    model?: string;
    /** The answer was the recorded reply of an identical earlier request. */
    cached?: boolean;
    /** The question failed: the view is unchecked (never counted clear). */
    error?: string;
}

export interface TemporaryImage { bytes: Buffer; mimeType: string; widthPx: number; heightPx: number }
export type TemporaryChecker = (image: TemporaryImage, ask: { target: string; faceHeadingDeg?: number; signal?: AbortSignal }) => Promise<TemporaryReading>;

/** The question: open vocabulary, the examples are for the model's sake only. */
export function temporaryPrompt(target: string, faceHeadingDeg?: number): string {
    const face = faceHeadingDeg !== undefined && Number.isFinite(faceHeadingDeg) ? ` (its side facing ${Math.round(((faceHeadingDeg % 360) + 360) % 360)}° from north)` : '';
    return `This is a street-level photograph of ${target}${face}, the building or structure at the centre of the photo. ` +
        'Is anything TEMPORARY covering it or standing in front of it here: something that is not part of the building itself and will be gone after a while, ' +
        'for example scaffolding, construction netting or wrap, a crane, a sidewalk shed, barriers or fencing, construction equipment, or an event structure, or anything else of that nature. ' +
        'Ordinary passing or parked cars, people, trees, street lights, signs, awnings and permanent street furniture do not count. Blurred patches are privacy redaction and do not count. ' +
        'Also say how much of the photo the outside of that building occupies (anything temporary on it included): 0 when the building is not in the photo or the photo is taken indoors. ' +
        'Answer with JSON only: {"buildingShare": number from 0 to 1, "present": boolean, "confidence": number from 0 to 1, "description": "what it is and where on the building, in a few words", ' +
        '"regions": [{"description": "what this region is", "outline": [[y, x], ...]}]}. ' +
        'Outline each temporary thing as it appears in the photo, following its silhouette with at least 6 points; coordinates normalised to 0-1000 ([y, x] order, like box_2d). ' +
        'When present is false, regions is an empty list and description says what you checked.';
}

const isPoint = (p: unknown): p is [number, number] => Array.isArray(p) && p.length >= 2 && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1]));
const clamp01k = (v: number) => Math.max(0, Math.min(1000, v));

/**
 * Parses the model's answer (JSON, possibly fenced) into a reading at a W x H image. Throws when it is not the asked shape.
 * Outlines with fewer than three points are dropped; a present reading with no usable outline keeps its flag (the view is
 * still flagged, it just has no region to mask).
 */
export function parseTemporaryReply(text: string, widthPx: number, heightPx: number): Omit<TemporaryReading, 'model' | 'cached'> {
    const body = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
    let j: Record<string, unknown>;
    try { j = JSON.parse(body); } catch { throw new Error(`the temporary-structure answer is not JSON: ${text.slice(0, 120)}`); }
    if (typeof j !== 'object' || j === null || typeof j.present !== 'boolean') throw new Error('the temporary-structure answer has no "present" boolean');
    const confidence = Number.isFinite(Number(j.confidence)) ? Math.max(0, Math.min(1, Number(j.confidence))) : (j.present ? 0.5 : 0);
    const regions: TemporaryRegion[] = [];
    if (j.present && Array.isArray(j.regions)) {
        for (const r of j.regions as Array<Record<string, unknown>>) {
            const ring = Array.isArray(r?.outline) ? (r.outline as unknown[]).filter(isPoint) : [];
            if (ring.length < 3) continue;
            regions.push({
                polygon: ring.map(([y, x]) => [Math.round(clamp01k(Number(x)) / 1000 * widthPx * 10) / 10, Math.round(clamp01k(Number(y)) / 1000 * heightPx * 10) / 10] as [number, number]),
                ...(typeof r.description === 'string' && r.description.trim() ? { description: r.description.trim() } : {})
            });
        }
    }
    const present = j.present === true;
    const share = Number(j.buildingShare);
    return {
        present, confidence, description: typeof j.description === 'string' ? j.description.trim() : '', regions,
        ...(j.buildingShare !== undefined && Number.isFinite(share) ? { buildingShare: Math.max(0, Math.min(1, share)) } : {}),
        flagged: present && confidence >= TEMPORARY_MIN_CONFIDENCE
    };
}

/** The flagged regions filled into a W x H mask (1 inside), optionally grown by `dilatePx`. */
export function temporaryMask(regions: TemporaryRegion[], widthPx: number, heightPx: number, dilatePx = 0): Uint8Array {
    const polys: OutlinePolygon[] = regions.map(r => ({ outer: r.polygon.map(([x, y]) => [y / heightPx * 1000, x / widthPx * 1000] as [number, number]), holes: [] }));
    const m = rasterizeOutlines(polys, widthPx, heightPx);
    for (let i = 0; i < m.length; i++) m[i] = m[i] ? 1 : 0;
    return dilatePx > 0 ? dilateMask(m, widthPx, heightPx, dilatePx) : m;
}

/** The repo's vision model chain as a TemporaryChecker: one call per image, the image capped at TEMPORARY_SEND_MAX_SIDE_PX. */
export function visionTemporaryChecker(chain: VisionModelChain<string>, opts: { timeoutMs?: number } = {}): TemporaryChecker {
    const timeoutMs = opts.timeoutMs ?? TEMPORARY_CALL_TIMEOUT_MS;
    return async (image, ask) => {
        const own = new AbortController();
        const signal = ask.signal ? AbortSignal.any([ask.signal, own.signal]) : own.signal;
        let timer: CallTimer | undefined;
        try {
            const sent = await capImageSide(image.bytes, image.mimeType, image.widthPx, image.heightPx, TEMPORARY_SEND_MAX_SIDE_PX);
            timer = callTimeout(() => own.abort(Object.assign(new Error(`the vision call took longer than ${Math.round(timeoutMs / 1000)} s`), { name: 'TimeoutError' })), timeoutMs);
            const r = await chain.generate({
                contents: [{ role: 'user', parts: [{ inlineData: { mimeType: sent.mimeType, data: sent.bytes.toString('base64') } }, { text: temporaryPrompt(ask.target, ask.faceHeadingDeg) }] }],
                config: { responseMimeType: 'application/json', temperature: 0, maxOutputTokens: TEMPORARY_MAX_OUTPUT_TOKENS, abortSignal: signal }
            }, { stage: 'temporary', thinkingBudget: ORNAMENT_THINKING_BUDGET });
            const text = (r.response.candidates?.[0]?.content?.parts ?? []).filter(p => !(p as { thought?: boolean }).thought).map(p => p.text ?? '').join('');
            const reading = parseTemporaryReply(text, image.widthPx, image.heightPx);
            r.remember();
            return { ...reading, model: r.model, ...(r.cached ? { cached: true } : {}) };
        } catch (err) {
            if (ask.signal?.aborted) throw err;
            const message = own.signal.aborted ? `the vision call took longer than ${Math.round(timeoutMs / 1000)} s` : err instanceof Error ? err.message : String(err);
            return { present: false, confidence: 0, description: '', regions: [], flagged: false, error: message };
        } finally {
            timer?.clear();
        }
    };
}

/** Runs `fn` over `items`, `limit` at a time, results in order. */
export async function mapConcurrent<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
        for (let i; (i = next++) < items.length;) out[i] = await fn(items[i], i);
    }));
    return out;
}

/** A decoded view as JPEG bytes for the question (the texture pass holds decoded pixels only). */
function viewJpeg(view: ProjectionView): TemporaryImage {
    const { width, height, rgba } = view.image;
    const enc = jpegJs.encode({ data: Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength), width, height }, 90);
    return { bytes: Buffer.from(enc.data), mimeType: 'image/jpeg', widthPx: width, heightPx: height };
}

export interface TemporaryViewRecord {
    panoId: string;
    captureDate?: string;
    present: boolean;
    confidence: number;
    description: string;
    flagged: boolean;
    regions: number;
    /** Pixels taken out of the view's ownership mask. */
    maskedPixels: number;
    error?: string;
}

/**
 * The texture pass's use: asks about every view and takes each flagged view's regions (grown by TEMPORARY_DILATE_SHARE)
 * out of its ownership mask, so the projection treats them as occluders. A view without an ownership mask gets one that
 * holds every pixel but the regions. Views not flagged, or whose question failed, are returned unchanged.
 */
export async function maskTemporaryInViews(input: {
    views: ProjectionView[]; check: TemporaryChecker; target: string; concurrency?: number; signal?: AbortSignal; onProgress?: (m: string) => void;
}): Promise<{ views: ProjectionView[]; records: TemporaryViewRecord[] }> {
    let done = 0;
    const readings = await mapConcurrent(input.views, input.concurrency ?? 4, async v => {
        try {
            return await input.check(viewJpeg(v), { target: input.target, ...(input.signal ? { signal: input.signal } : {}) });
        } finally {
            input.onProgress?.(`checking the Street View photos for temporary structures: ${++done} of ${input.views.length}`);
        }
    });
    const records: TemporaryViewRecord[] = [];
    const views = input.views.map((v, k) => {
        const r = readings[k];
        const W = v.camera.width, H = v.camera.height;
        let masked = 0;
        let out = v;
        if (r.flagged && r.regions.length && v.image.width === W && v.image.height === H) {
            const tm = temporaryMask(r.regions, W, H, Math.max(2, Math.round(TEMPORARY_DILATE_SHARE * Math.max(W, H))));
            const owner = v.ownerMask ? v.ownerMask.slice() : new Uint8Array(W * H).fill(1);
            for (let i = 0; i < owner.length; i++) if (tm[i] && owner[i]) { owner[i] = 0; masked++; }
            out = { ...v, ownerMask: owner };
        }
        records.push({ panoId: v.panoId, ...(v.captureDate ? { captureDate: v.captureDate } : {}), present: r.present, confidence: r.confidence, description: r.description, flagged: r.flagged, regions: r.regions.length, maskedPixels: masked, ...(r.error ? { error: r.error } : {}) });
        return out;
    });
    return { views, records };
}

// ---------------------------------------------------------------------------------------------------------------------
// the survey's use: replace a flagged view by a clear capture from another month
// ---------------------------------------------------------------------------------------------------------------------

const monthOf = (date?: string): string | undefined => (/^\d{4}-\d{2}/.test(date ?? '') ? date!.slice(0, 7) : undefined);

export interface TemporaryAlternativeTried { panoId: string; captureMonth?: string; outcome: string }

export interface TemporarySwap {
    faceId: string;
    faceHeadingDeg: number;
    from: { panoId: string; captureMonth?: string };
    to: { panoId: string; captureMonth?: string };
    /** What the replaced view showed (the model's words) and how sure it was. */
    reason: string;
    /** Other months tried first that were not clear. */
    tried: TemporaryAlternativeTried[];
}

export interface TemporaryKept {
    faceId: string;
    faceHeadingDeg: number;
    panoId: string;
    captureMonth?: string;
    description: string;
    confidence: number;
    /** Why it was kept: no eligible pano of the face from another month, or none of them clear. */
    reason: string;
    tried: TemporaryAlternativeTried[];
}

/** Every eligible pano of each face over `pool` (the discovered and the superseded panos), best first. */
export function temporaryCandidates(pool: PanoCandidate[], faces: SurveyFaceTarget[], site: { structure: Parameters<typeof surveyCandidates>[2]; ground: Parameters<typeof surveyCandidates>[3]; unmaskedTop: Float32Array }): Map<string, SurveyCandidate[]> {
    return surveyCandidates(pool, faces, site.structure, site.ground, site.unmaskedTop);
}

export interface TemporaryReplacement {
    /** The images in their original order, a swapped one in its place. */
    images: EvidenceImage[];
    /** The reading of each image above. */
    readings: TemporaryReading[];
    swaps: TemporarySwap[];
    kept: TemporaryKept[];
    /** The images swapped out, with their readings, in swap order (swaps[k] replaced replaced[k]). */
    replaced: Array<{ image: EvidenceImage; reading: TemporaryReading }>;
    /**
     * Flagged views whose outlines lie on none of their own face's points (seen obliquely on another side of the building):
     * not replaced, recorded here; the face they do lie on is judged by its coverage.
     */
    offFace: Array<{ faceId: string; faceHeadingDeg: number; panoId: string; captureMonth?: string; description: string }>;
    /** Alternatives the grounding API refused while being tried. */
    refusals: Array<{ faceId: string; panoId: string; error: string }>;
    /** Grounding calls and vision questions this step made. */
    cost: { images: number; questions: number };
}

/**
 * Asks about every image; for each flagged one, tries the face's best eligible pano from each other capture month (best
 * first, one per month, up to TEMPORARY_ALTERNATIVES_MAX, never a pano already in the survey) and swaps in the first clear
 * one. A flagged view with no clear alternative is kept, and the reason recorded.
 */
export async function replaceTemporaryViews(input: {
    images: EvidenceImage[];
    faces: SurveyFaceTarget[];
    /** Every eligible pano of a face, best first (surveyCandidates over the discovered and the superseded panos). */
    candidatesFor: (face: SurveyFaceTarget) => SurveyCandidate[];
    streetView: StreetViewEvidenceDeps;
    check: TemporaryChecker;
    target: string;
    /** Panos known refused: never tried. */
    refused: Set<string>;
    /**
     * Share of the reading's outlines that lies on the view's own face. A flagged view below TEMPORARY_ON_FACE_MIN_SHARE is
     * not replaced (offFace). Absent: every flagged view is treated as showing its own face covered.
     */
    regionOnFace?: (image: EvidenceImage, reading: TemporaryReading) => number;
    signal?: AbortSignal;
    onProgress?: (m: string) => void;
}): Promise<TemporaryReplacement> {
    const ask = (im: EvidenceImage) => input.check({ bytes: im.bytes, mimeType: im.mimeType, widthPx: im.widthPx, heightPx: im.heightPx },
        { target: input.target, faceHeadingDeg: (im.view as SurveyView).facadeHeadingDeg, ...(input.signal ? { signal: input.signal } : {}) });
    input.onProgress?.(`checking ${input.images.length} view${input.images.length === 1 ? '' : 's'} for temporary structures in front of the building`);
    const readings = await mapConcurrent(input.images, 4, im => ask(im));
    const images = input.images.slice();
    const cost = { images: 0, questions: input.images.length };
    const offFace: TemporaryReplacement['offFace'] = [];
    const swaps: TemporarySwap[] = [], kept: TemporaryKept[] = [], replaced: TemporaryReplacement['replaced'] = [], refusals: TemporaryReplacement['refusals'] = [];
    const used = new Set(images.map(im => im.view.panoId));
    const tried = new Set<string>();
    for (let k = 0; k < images.length; k++) {
        if (input.signal?.aborted) break;
        const r = readings[k];
        if (!r.flagged) continue;
        const view = images[k].view as SurveyView;
        const face = input.faces.find(f => f.faceId === view.faceId);
        const month = monthOf(view.date);
        if (r.regions.length && input.regionOnFace && input.regionOnFace(images[k], r) < TEMPORARY_ON_FACE_MIN_SHARE) {
            offFace.push({ faceId: view.faceId, faceHeadingDeg: view.facadeHeadingDeg, panoId: view.panoId, ...(month ? { captureMonth: month } : {}), description: r.description });
            continue;
        }
        const triedHere: TemporaryAlternativeTried[] = [];
        const months = new Set<string>();
        const alternatives = (face ? input.candidatesFor(face) : []).filter(c => {
            const m = monthOf(c.pano.date);
            if (!m || m === month || months.has(m) || used.has(c.pano.panoId) || tried.has(c.pano.panoId) || input.refused.has(c.pano.panoId) || input.streetView.refusedPanos?.has(c.pano.panoId)) return false;
            months.add(m);
            return true;
        }).slice(0, TEMPORARY_ALTERNATIVES_MAX);
        let swapped = false;
        for (const alt of alternatives) {
            if (input.signal?.aborted) break;
            tried.add(alt.pano.panoId);
            const altMonth = monthOf(alt.pano.date);
            input.onProgress?.(`the ${Math.round(view.facadeHeadingDeg)}° face's view (${month ?? 'undated'}) shows something temporary; trying the ${altMonth} capture ${alt.pano.panoId}`);
            const next = surveyViewFor(face!, alt);
            const got = await fetchViews([next], input.streetView, input.signal, SURVEY_IMAGE_TIMEOUT_MS);
            cost.images++;
            if (!got.images.length) {
                const f = got.failures[0];
                if (f?.refused) refusals.push({ faceId: view.faceId, panoId: alt.pano.panoId, error: f.error });
                triedHere.push({ panoId: alt.pano.panoId, ...(altMonth ? { captureMonth: altMonth } : {}), outcome: f?.refused ? `refused by the grounding API (${f.error})` : `not fetched (${f?.error ?? 'no image'})` });
                continue;
            }
            const im = got.images[0];
            const reading = await ask(im);
            cost.questions++;
            const needShare = Math.max(TEMPORARY_ALT_MIN_BUILDING_SHARE, TEMPORARY_ALT_MIN_SHARE_RATIO * (r.buildingShare ?? 0));
            if (!reading.error && !((reading.buildingShare ?? 0) >= needShare)) {
                triedHere.push({ panoId: alt.pano.panoId, ...(altMonth ? { captureMonth: altMonth } : {}), outcome: `shows too little of the building (${reading.buildingShare === undefined ? 'share not given' : `${Math.round(reading.buildingShare * 100)} percent of the photo`}, at least ${Math.round(needShare * 100)} needed): ${reading.description || 'no description'}` });
                continue;
            }
            if (reading.error) { triedHere.push({ panoId: alt.pano.panoId, ...(altMonth ? { captureMonth: altMonth } : {}), outcome: `not checked (${reading.error})` }); continue; }
            // an alternative flagged only for something on another side of the building is clear for this face
            if (reading.flagged && !(reading.regions.length && input.regionOnFace && input.regionOnFace(im, reading) < TEMPORARY_ON_FACE_MIN_SHARE)) { triedHere.push({ panoId: alt.pano.panoId, ...(altMonth ? { captureMonth: altMonth } : {}), outcome: `also shows something temporary: ${reading.description || 'no description'} (confidence ${reading.confidence})` }); continue; }
            replaced.push({ image: images[k], reading: r });
            swaps.push({
                faceId: view.faceId, faceHeadingDeg: view.facadeHeadingDeg,
                from: { panoId: view.panoId, ...(month ? { captureMonth: month } : {}) }, to: { panoId: alt.pano.panoId, ...(altMonth ? { captureMonth: altMonth } : {}) },
                reason: `${r.description || 'something temporary'} (confidence ${r.confidence})`, tried: triedHere
            });
            used.delete(view.panoId);
            used.add(alt.pano.panoId);
            images[k] = im;
            readings[k] = reading;
            swapped = true;
            break;
        }
        if (!swapped) {
            kept.push({
                faceId: view.faceId, faceHeadingDeg: view.facadeHeadingDeg, panoId: view.panoId, ...(month ? { captureMonth: month } : {}), description: r.description, confidence: r.confidence,
                reason: alternatives.length ? `none of the ${alternatives.length} capture${alternatives.length === 1 ? '' : 's'} of this face from another month is clear` : 'no eligible pano of this face from another capture month',
                tried: triedHere
            });
        }
    }
    return { images, readings, swaps, kept, offFace, replaced, refusals, cost };
}

/** One line per flagged face: what, where and when, and what became of it; or that nothing was seen. */
export function describeTemporary(r: Pick<TemporaryReplacement, 'swaps' | 'kept' | 'readings'>): string {
    const lines = [
        ...r.swaps.map(s => `${s.reason.replace(/ \(confidence [\d.]+\)$/, '')} on the ${Math.round(s.faceHeadingDeg)}° face in ${s.from.captureMonth ?? 'an undated capture'}; replaced with a ${s.to.captureMonth ?? 'differently dated'} capture`),
        ...r.kept.map(k => `${k.description || 'something temporary'} on the ${Math.round(k.faceHeadingDeg)}° face in ${k.captureMonth ?? 'an undated capture'}; kept and flagged (${k.reason})`)
    ];
    const unchecked = r.readings.filter(x => x.error).length;
    if (!lines.length) lines.push(`no temporary structure seen in ${r.readings.length - unchecked} view${r.readings.length - unchecked === 1 ? '' : 's'}`);
    if (unchecked) lines.push(`${unchecked} view${unchecked === 1 ? '' : 's'} could not be checked`);
    return lines.join('; ');
}
