/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A ring of views per face, and the same elements found in them.
 *
 * The survey reads one pano per face. This takes up to RING_VIEWS_PER_FACE more wide views of the same face from other
 * panos (different spots, at least a few metres apart) and asks the vision model, shown the survey's image and the new
 * ones together, where each surveyed element is in each new image (or that it cannot tell). Each answer is a pair of
 * boxes of one physical element in two views, which is what pose registration (pano-registration.ts) is solved from.
 * Nothing here names what an element is: it carries the survey's own words and boxes.
 */

import type { Content, Part } from '@google/genai';
import type { SurveyElement } from '../../../common/spatial/staged-location-contracts';
import type { VisionModelChain } from '../../gemini/vision-model-chain';
import { ORNAMENT_MAX_OUTPUT_TOKENS, ORNAMENT_THINKING_BUDGET } from './ornament-vision';
import { surveyAim, surveyImageBytes, type SurveyCandidate, type SurveyFaceTarget, type SurveyResult, type SurveyView } from './face-survey';
import { fetchViews, type EvidenceImage, type StreetViewEvidenceDeps } from './streetview-evidence';
import type { Box1000, Correspondence, RegView } from './pano-registration';
import { callTimeout } from './call-timer';

export const RING_VIEWS_PER_FACE = 5;
/** A ring view stands at least this far from the survey's own pano (otherwise it adds nothing to triangulate with). */
export const RING_MIN_BASELINE_M = 4;
export const MATCH_PROMPT_VERSION = 'view-match/v1';
export const MATCH_TIMEOUT_MS = 120_000;

const DEG = Math.PI / 180;
const angleBetween = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

export interface RingView extends SurveyView { primaryPanoId: string }

/** Up to `perFace` further views of each surveyed face, from distinct panos, spread in bearing and at least RING_MIN_BASELINE_M from the survey's pano. */
export function planRingViews(
    faces: SurveyFaceTarget[],
    candidates: Map<string, SurveyCandidate[]>,
    survey: Pick<SurveyResult, 'faces' | 'read'>,
    perFace = RING_VIEWS_PER_FACE,
    /** False plans for every face with a survey image, elements or not (the prefetch while the survey is read: a superset). */
    requireElements = true
): RingView[] {
    const out: RingView[] = [];
    for (const face of faces) {
        const rec = survey.faces.find(f => f.faceId === face.faceId);
        const primary = survey.read.find(r => r.view.faceId === face.faceId);
        if (!rec || rec.skipped || !primary || (requireElements && !rec.elements.length)) continue;
        const list = (candidates.get(face.faceId) ?? []).filter(c => c.pano.panoId !== primary.view.panoId);
        const chosen: SurveyCandidate[] = [];
        const bearings = [bearingOf(primary.view.eye, face)];
        for (const c of list) {
            if (chosen.length >= perFace) break;
            if (Math.hypot(c.eye[0] - primary.view.eye[0], c.eye[2] - primary.view.eye[2]) < RING_MIN_BASELINE_M) continue;
            if (chosen.some(o => Math.hypot(c.eye[0] - o.eye[0], c.eye[2] - o.eye[2]) < RING_MIN_BASELINE_M)) continue;
            // spread the bearings where the candidates allow: a view from a new direction first, then the best of what is left
            if (bearings.some(b => angleBetween(b, c.bearing) < 8)) continue;
            chosen.push(c); bearings.push(c.bearing);
        }
        for (const c of list) {
            if (chosen.length >= perFace) break;
            if (chosen.includes(c)) continue;
            if (Math.hypot(c.eye[0] - primary.view.eye[0], c.eye[2] - primary.view.eye[2]) < RING_MIN_BASELINE_M) continue;
            if (chosen.some(o => Math.hypot(c.eye[0] - o.eye[0], c.eye[2] - o.eye[2]) < RING_MIN_BASELINE_M)) continue;
            chosen.push(c);
        }
        for (const c of chosen) {
            const aim = surveyAim(c.eye, face);
            out.push({
                faceId: face.faceId, primaryPanoId: primary.view.panoId, panoId: c.pano.panoId, date: c.pano.date, copyright: c.pano.copyright, eye: c.eye, facadeHeadingDeg: Math.round(face.headingDeg),
                headingDeg: aim.headingDeg, pitchDeg: aim.elevationDeg, fovDeg: aim.fovDeg, aspectRatio: 'RATIO_4X3', distanceM: aim.distanceM, score: Math.round(c.score * 1000) / 1000, aimedSlotIds: [], coveredSlotIds: []
            });
        }
    }
    return out;
}

function bearingOf(eye: [number, number, number] | number[], face: SurveyFaceTarget): number {
    return (Math.atan2(eye[0] - face.centre[0], -(eye[2] - face.centre[2])) / DEG + 360) % 360;
}

export function matchPrompt(faceHeadingDeg: number, others: number, elements: Array<{ id: string; element: SurveyElement }>): { preamble: string; closing: string } {
    const preamble = `You are matching things between ${others + 1} Google Street View photographs of one face of a structure (the face whose outward direction is ${Math.round(faceHeadingDeg)}°, clockwise from north), taken from different spots. Image 0 comes first; images 1 to ${others} show the same face from other positions, nearer or farther and from the left or the right.`;
    const list = elements.map(e => `${e.id}: "${e.element.kind}" (${e.element.material}), box in image 0 = [${e.element.box.join(', ')}]${e.element.repeat ? `, a row of ${e.element.repeat.count}` : ''}`).join('\n');
    const rules = [
        '1. For each listed element, say where the SAME physical element is in each of the other images: "box" is [y0, x0, y1, x1] in 0..1000 of that image (y down), tight around it.',
        '2. For a row or a band that runs along the face, box exactly the stretch of it that lies between the same two recognisable features as in image 0 (the same two ends, the same two vertical joints), not the whole of the row that is visible.',
        '3. If the element is hidden, cut off by the frame, or you are not sure it is the same one and not a similar one beside it, give "box": null. A wrong match is worse than none.',
        '4. "confidence" is 0..100: how sure you are that the two boxes are the same physical thing.',
        '5. Do not invent elements that are not in the list and do not describe anything else.'
    ];
    const closing = `Elements found in image 0:\n${list}\n\nRules:\n${rules.join('\n')}\n\nReply with JSON only: {"matches":[{"element":"<id>","views":[{"image":<1..${others}>,"box":[y0,x0,y1,x1] or null,"confidence":<0-100>}]}]}, one entry per listed element, one "views" entry per other image.`;
    return { preamble, closing };
}

export interface ParsedMatches { matches: Array<{ element: string; image: number; box: Box1000; confidence: number }>; problems: string[] }

export function parseMatchReply(text: string, finishReason: string | undefined, ids: string[], others: number): ParsedMatches {
    if (finishReason && finishReason !== 'STOP') throw new Error(finishReason === 'MAX_TOKENS' ? 'the reply was cut off (MAX_TOKENS)' : `the reply ended with ${finishReason}, not STOP`);
    let value: any;
    try { value = JSON.parse(text.trim()); } catch (err) { throw new Error(`the reply is not valid JSON (${(err as Error).message})`); }
    if (!value || !Array.isArray(value.matches)) throw new Error('the reply has no "matches" list');
    const problems: string[] = [];
    const matches: ParsedMatches['matches'] = [];
    const seen = new Set<string>();
    for (const m of value.matches) {
        if (!m || typeof m.element !== 'string' || !ids.includes(m.element)) { problems.push(`a match names ${JSON.stringify(m?.element)}, which is not a listed element`); continue; }
        for (const v of Array.isArray(m.views) ? m.views : []) {
            if (!v || !Number.isInteger(v.image) || v.image < 1 || v.image > others) { problems.push(`${m.element}: image ${v?.image} is not one of the ${others} other images`); continue; }
            if (v.box === null || v.box === undefined) continue;
            const b = v.box;
            const ok = Array.isArray(b) && b.length === 4 && b.every((n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1000) && b[0] < b[2] && b[1] < b[3];
            if (!ok) { problems.push(`${m.element}: the box in image ${v.image} is not [y0, x0, y1, x1] in 0..1000`); continue; }
            const key = `${m.element}|${v.image}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const confidence = typeof v.confidence === 'number' ? v.confidence : 50;
            if (confidence < 50) { problems.push(`${m.element}: image ${v.image} match set aside (confidence ${confidence})`); continue; }
            matches.push({ element: m.element, image: v.image, box: b as Box1000, confidence });
        }
    }
    return { matches, problems };
}

export interface MatchInput {
    faces: SurveyFaceTarget[];
    survey: SurveyResult;
    candidates: Map<string, SurveyCandidate[]>;
    deps: StreetViewEvidenceDeps;
    chain: VisionModelChain<string>;
    signal?: AbortSignal;
    onProgress?: (message: string) => void;
    perFace?: number;
}

export interface MatchResult {
    correspondences: Correspondence[];
    /** The ring images that were fetched (no bytes). */
    ringViews: Array<{ faceId: string; view: RingView; widthPx: number; heightPx: number }>;
    images: number;
    visionCalls: number;
    seconds: number;
    problems: string[];
    failures: string[];
}

const responseText = (r: { candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }> }): string =>
    (r.candidates?.[0]?.content?.parts ?? []).filter(p => !p.thought).map(p => p.text ?? '').join('');

/** The ring images of a match, held in memory beside it (never in the result's own fields, so they are never serialised). */
const RING_IMAGES = new WeakMap<MatchResult, EvidenceImage[]>();
export function matchRingImages(result: MatchResult): EvidenceImage[] { return RING_IMAGES.get(result) ?? []; }

/** Fetches the ring views and asks, per face, where the surveyed elements are in them. A face whose call fails costs only its own correspondences. */
export async function runViewMatch(input: MatchInput): Promise<MatchResult> {
    const started = Date.now();
    const result: MatchResult = { correspondences: [], ringViews: [], images: 0, visionCalls: 0, seconds: 0, problems: [], failures: [] };
    const ring = planRingViews(input.faces, input.candidates, input.survey, input.perFace);
    if (!ring.length) return result;
    input.onProgress?.(`fetching ${ring.length} more views of the surveyed faces from other panoramas`);
    const got = await fetchViews(ring, input.deps, input.signal, 30_000);
    for (const f of got.failures) result.failures.push(`${f.view.panoId}: ${f.error}`);
    result.images = got.images.length;
    RING_IMAGES.set(result, got.images);
    const byFace = new Map<string, EvidenceImage[]>();
    for (const im of got.images) {
        const fid = (im.view as RingView).faceId;
        byFace.set(fid, [...(byFace.get(fid) ?? []), im]);
        result.ringViews.push({ faceId: fid, view: im.view as RingView, widthPx: im.widthPx, heightPx: im.heightPx });
    }
    input.onProgress?.(`matching the surveyed elements across ${got.images.length} views`);
    await Promise.all([...byFace.entries()].map(async ([faceId, images]) => {
        const rec = input.survey.faces.find(f => f.faceId === faceId)!;
        const primary = input.survey.read.find(r => r.view.faceId === faceId)!;
        const bytes = surveyImageBytes(input.survey, primary.imageIndex);
        if (!bytes) { result.problems.push(`${faceId}: the survey image is no longer held`); return; }
        const els = rec.elements.map((element, k) => ({ id: `e${k}`, element }));
        const { preamble, closing } = matchPrompt(rec.headingDeg, images.length, els);
        const parts: Part[] = [{ text: preamble }, { inlineData: { mimeType: 'image/jpeg', data: bytes.toString('base64') } }, { text: `[0] Google Street View image (© Google) the elements are listed from, ${primary.widthPx} × ${primary.heightPx} px.` }];
        images.forEach((im, k) => {
            parts.push({ inlineData: { mimeType: im.mimeType, data: im.bytes.toString('base64') } });
            parts.push({ text: `[${k + 1}] Google Street View image (© Google), the same face from another position, ${im.widthPx} × ${im.heightPx} px.` });
        });
        parts.push({ text: closing });
        const contents: Content[] = [{ role: 'user', parts }];
        const own = new AbortController();
        const timer = callTimeout(() => own.abort(Object.assign(new Error(`the matching call took longer than ${Math.round(MATCH_TIMEOUT_MS / 1000)} s`), { name: 'TimeoutError' })), MATCH_TIMEOUT_MS);
        const signal = input.signal ? AbortSignal.any([input.signal, own.signal]) : own.signal;
        try {
            result.visionCalls++;
            const r = await input.chain.generate({ contents, config: { responseMimeType: 'application/json', temperature: 0.1, maxOutputTokens: ORNAMENT_MAX_OUTPUT_TOKENS, abortSignal: signal } },
                { stage: 'survey', thinkingBudget: ORNAMENT_THINKING_BUDGET, stream: true });
            const parsed = parseMatchReply(responseText(r.response), r.response.candidates?.[0]?.finishReason as string | undefined, els.map(e => e.id), images.length);
            r.remember();
            result.problems.push(...parsed.problems.map(p => `${faceId}: ${p}`));
            const regPrimary: RegView = { eye: primary.view.eye, headingDeg: primary.view.headingDeg, pitchDeg: primary.view.pitchDeg, fovDeg: primary.view.fovDeg, widthPx: primary.widthPx, heightPx: primary.heightPx, panoId: primary.view.panoId };
            const viewOf = (im: EvidenceImage): RegView => ({ eye: im.view.eye, headingDeg: im.view.headingDeg, pitchDeg: im.view.pitchDeg, fovDeg: im.view.fovDeg, widthPx: im.widthPx, heightPx: im.heightPx, panoId: im.view.panoId });
            // the same element found in two ring views is a pair between those two as well: the ring panos then constrain one another, not only the survey's pano
            const byElement = new Map<string, Array<{ im: EvidenceImage; box: Box1000 }>>();
            for (const m of parsed.matches) byElement.set(m.element, [...(byElement.get(m.element) ?? []), { im: images[m.image - 1], box: m.box }]);
            for (const [elementId, found] of byElement) for (let i = 0; i < found.length; i++) for (let j = i + 1; j < found.length; j++) {
                if (found[i].im.view.panoId === found[j].im.view.panoId) continue;
                result.correspondences.push({ id: `${faceId}.${elementId}@${found[i].im.view.panoId}~${found[j].im.view.panoId}`, a: { view: viewOf(found[i].im), box: found[i].box }, b: { view: viewOf(found[j].im), box: found[j].box } });
            }
            for (const m of parsed.matches) {
                const im = images[m.image - 1];
                const el = els.find(e => e.id === m.element)!;
                result.correspondences.push({
                    id: `${faceId}.${m.element}@${im.view.panoId}`,
                    a: { view: regPrimary, box: el.element.box as Box1000 },
                    b: { view: { eye: im.view.eye, headingDeg: im.view.headingDeg, pitchDeg: im.view.pitchDeg, fovDeg: im.view.fovDeg, widthPx: im.widthPx, heightPx: im.heightPx, panoId: im.view.panoId }, box: m.box }
                });
            }
        } catch (err) {
            if (input.signal?.aborted) throw err;
            result.failures.push(`${faceId}: ${(err as Error).message}`);
        } finally {
            timer.clear();
        }
    }));
    result.seconds = Math.round(((Date.now() - started) / 1000) * 10) / 10;
    return result;
}
