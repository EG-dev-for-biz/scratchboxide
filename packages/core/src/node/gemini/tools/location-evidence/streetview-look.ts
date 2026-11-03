/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * streetview_look: Street View of one real spot, from the Google captures around it, each aimed at it and dated, with an
 * optional question about it answered per view.
 *
 * The spot is a point or an outline (lat/lng), with an optional height. Nothing else is needed: no extraction, no
 * structure pick, no registration. It is the quick check for anything the tiles show but cannot explain (a sidewalk
 * structure, a kiosk, a sign, a lump in the scan), and for what stood there when (the capture months around it).
 *
 * - Discovery: the free metadata endpoint on a grid over everything within maxRangeM of the spot (discoverPanosAt), Google
 *   captures only. The newest capture at each place and the older ones beside it (its superseded list) both count. It is
 *   no time machine: the endpoint answers with one capture per place, so an older capture another has replaced at the
 *   same place is not found, and the result says so.
 * - Choice: greedily the capture that adds a month not yet seen, then a side of the spot not yet seen, then the nearer;
 *   at most maxViews.
 * - Aim: the heading to the middle of the arc the spot spans from the camera; the elevation to its mid-height from the
 *   2.5 m eye on a level street (level when no height is given); the field of view sized to the arc and the height
 *   (30-90°). `framed` says whether the spot fits.
 * - Images only from the Maps Imagery Grounding API, written exactly as returned; a pano the API refuses is replaced by
 *   the next choice and reported.
 * - The question (optional, open vocabulary): one vision call per view, answering whether the place is in view
 *   (whatever stands there in that capture: a thing gone by then leaves its place in view), the answer in words, yes or
 *   no when the question is a yes-or-no one, and a confidence (photo-inferred). A failed answer is recorded with its
 *   error, never guessed. The answers are tallied per capture month.
 *
 * Real-data only (AGENTS.md, the location evidence tools): nothing is estimated or filled.
 */

import * as fs from 'fs';
import * as path from 'path';
import { geodeticToScan, scanToGeodetic, type GeodeticOrigin } from '../../../spatial/StreetViewSurveyPlanner';
import { groundingPitchForElevation, type GroundingAspectRatio } from '../../../spatial/StreetViewGroundingImageService';
import {
    bearingDeg, discoverPanosAt, fetchViews, knownRefusals, missingCredentials, STREET_VIEW_EYE_HEIGHT_M,
    type EvidenceImage, type PanoCandidate, type SelectedView, type StreetViewEvidenceDeps
} from '../../../3d-engine/staged-location/streetview-evidence';
import { callTimeout, type CallTimer } from '../../../3d-engine/staged-location/call-timer';
import { capImageSide } from '../../../3d-engine/staged-location/ornament-batches';
import { ORNAMENT_THINKING_BUDGET } from '../../../3d-engine/staged-location/ornament-vision';
import { SURVEY_IMAGE_TIMEOUT_MS } from '../../../3d-engine/staged-location/face-survey';
import { mapConcurrent, type TemporaryImage } from '../../../3d-engine/staged-location/temporary-structures';
import { stagedReplyCache, stagedWorkspaceRoot } from '../../../3d-engine/staged-location/stage-cache';
import { createStagedLocationDeps } from '../../../3d-engine/staged-location/staged-location-tool';
import { VISION_HEDGE_AFTER_MS } from '../../../3d-engine/staged-location/orchestrator';
import { VisionModelChain } from '../../vision-model-chain';
import { groundingImageFileName, resolveQueryPlace, StreetViewSurveyCredentialsError, STREETVIEW_IMAGE_DIR } from './streetview-survey';
import type { ToolDeclaration, ToolHandler, ToolResultPayload } from '../types';

const DEG = Math.PI / 180;

export const STREETVIEW_LOOK_TOOL_NAME = 'streetview_look';
export const STREETVIEW_LOOK_DEFAULT_VIEWS = 6;
export const STREETVIEW_LOOK_MAX_VIEWS = 12;
export const STREETVIEW_LOOK_DEFAULT_RANGE_M = 50;
export const STREETVIEW_LOOK_MAX_RANGE_M = 100;
/** Spacing of the discovery grid: under the metadata search's 8 m radius times √2, so every street point is reached. */
export const LOOK_PROBE_SPACING_M = 11;
export const LOOK_ASPECT: GroundingAspectRatio = 'RATIO_4X3';
const LOOK_ASPECT_H_OVER_W = 3 / 4;
export const LOOK_MIN_FOV_DEG = 30;
export const LOOK_MAX_FOV_DEG = 90;
/** Rounds of replacement for panos the grounding API refuses. */
const LOOK_REFUSAL_RETRIES = 2;
const LOOK_SEND_MAX_SIDE_PX = 1024;
const LOOK_CALL_TIMEOUT_MS = 90_000;
const LOOK_MAX_OUTPUT_TOKENS = 4096;
/** Vision calls in flight at once. */
const LOOK_ASK_CONCURRENCY = 4;

// ---------------------------------------------------------------------------------------------------------------------
// the spot and the views: pure geometry in a local frame (x east, z south, metres; origin at the spot's middle)
// ---------------------------------------------------------------------------------------------------------------------

export interface LookSpot {
    /** The outline in the local frame, or one point. */
    points: Array<{ x: number; z: number }>;
    /** Height of the spot's top above the street; absent: aimed level. */
    heightM?: number;
}

const norm360 = (d: number) => ((d % 360) + 360) % 360;
function angleDiff(a: number, b: number): number {
    const d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
}

function inside(p: { x: number; z: number }, poly: Array<{ x: number; z: number }>): boolean {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i], b = poly[j];
        if ((a.z > p.z) !== (b.z > p.z) && p.x < (b.x - a.x) * (p.z - a.z) / (b.z - a.z) + a.x) c = !c;
    }
    return c;
}

/** Plan distance from p to the spot: to the point, or to the outline (0 inside it). */
export function spotDistance(p: { x: number; z: number }, spot: LookSpot): number {
    const pts = spot.points;
    if (pts.length === 1) return Math.hypot(p.x - pts[0].x, p.z - pts[0].z);
    if (pts.length >= 3 && inside(p, pts)) return 0;
    let best = Infinity;
    for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        const dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz;
        const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2)) : 0;
        best = Math.min(best, Math.hypot(p.x - a.x - t * dx, p.z - a.z - t * dz));
    }
    return best;
}

/** The smallest arc of compass bearings holding them all: its middle and its span. */
export function bearingArc(bearings: number[]): { middleDeg: number; spanDeg: number } {
    const s = bearings.map(norm360).sort((a, b) => a - b);
    if (s.length <= 1) return { middleDeg: s[0] ?? 0, spanDeg: 0 };
    // the widest gap between neighbours is the part of the circle the arc leaves out
    let gap = s[0] + 360 - s[s.length - 1], start = s[0];
    for (let i = 1; i < s.length; i++) if (s[i] - s[i - 1] > gap) { gap = s[i] - s[i - 1]; start = s[i]; }
    const span = 360 - gap;
    return { middleDeg: norm360(start + span / 2), spanDeg: span };
}

export interface LookAim {
    headingDeg: number;
    /** Up positive. */
    elevationDeg: number;
    fovDeg: number;
    /** The spot's width as the camera sees it, degrees (360 when the camera stands inside the outline). */
    spanDeg: number;
    /** Plan distance to the spot's nearest point, metres. */
    distanceM: number;
    /** The whole spot fits in the frame (its arc and, with a height, its street-to-top). */
    framed: boolean;
}

/** The view from a camera at `cam` (eye STREET_VIEW_EYE_HEIGHT_M above a level street) that frames the spot. */
export function aimAt(cam: { x: number; z: number }, spot: LookSpot): LookAim {
    const distanceM = spotDistance(cam, spot);
    const within = spot.points.length >= 3 && distanceM === 0;
    const middle = spot.points.reduce((m, p) => ({ x: m.x + p.x / spot.points.length, z: m.z + p.z / spot.points.length }), { x: 0, z: 0 });
    const arc = within ? { middleDeg: bearingDeg(cam.x, cam.z, middle.x, middle.z), spanDeg: 360 } : bearingArc(spot.points.map(p => bearingDeg(cam.x, cam.z, p.x, p.z)));
    const needH = arc.spanDeg * 1.15 + 8;
    let elevationDeg = 0, needV = 0;
    if (spot.heightM !== undefined && spot.heightM > 0) {
        const d = Math.max(1, distanceM);
        const lo = Math.atan2(-STREET_VIEW_EYE_HEIGHT_M, d) / DEG, hi = Math.atan2(spot.heightM - STREET_VIEW_EYE_HEIGHT_M, d) / DEG;
        elevationDeg = (lo + hi) / 2;
        needV = (hi - lo) * 1.15 + 6;
    }
    // the horizontal field a vertical one needs at the 4:3 aspect
    const hForV = needV > 0 ? 2 * Math.atan(Math.tan(Math.min(needV, 170) / 2 * DEG) / LOOK_ASPECT_H_OVER_W) / DEG : 0;
    const want = Math.max(LOOK_MIN_FOV_DEG, needH, hForV);
    const fovDeg = Math.round(Math.min(LOOK_MAX_FOV_DEG, want));
    return {
        headingDeg: Math.round(arc.middleDeg * 10) / 10, elevationDeg: Math.round(elevationDeg * 10) / 10, fovDeg,
        spanDeg: Math.round(arc.spanDeg * 10) / 10, distanceM: Math.round(distanceM * 10) / 10, framed: want <= LOOK_MAX_FOV_DEG
    };
}

/** The discovery probes: a grid over every point within rangeM (plus the search radius) of the spot. */
export function lookProbePoints(spot: LookSpot, rangeM: number, spacingM = LOOK_PROBE_SPACING_M): Array<{ x: number; z: number }> {
    const reach = rangeM + 8;
    const xs = spot.points.map(p => p.x), zs = spot.points.map(p => p.z);
    const x0 = Math.min(...xs) - reach, x1 = Math.max(...xs) + reach, z0 = Math.min(...zs) - reach, z1 = Math.max(...zs) + reach;
    const out: Array<{ x: number; z: number }> = [];
    for (let x = x0; x <= x1 + 1e-9; x += spacingM) {
        for (let z = z0; z <= z1 + 1e-9; z += spacingM) if (spotDistance({ x, z }, spot) <= reach) out.push({ x, z });
    }
    return out;
}

const monthOf = (date?: string): string => (/^\d{4}-\d{2}/.test(date ?? '') ? date!.slice(0, 7) : 'undated');

export interface LookCandidate {
    pano: PanoCandidate;
    distanceM: number;
    /** Compass bearing from the spot's middle to the camera: the side of the spot the view sees. */
    sideDeg: number;
}

export function lookCandidates(panos: PanoCandidate[], spot: LookSpot, rangeM: number): LookCandidate[] {
    const n = spot.points.length;
    const middle = spot.points.reduce((m, p) => ({ x: m.x + p.x / n, z: m.z + p.z / n }), { x: 0, z: 0 });
    return panos.map(pano => ({ pano, distanceM: spotDistance(pano, spot), sideDeg: bearingDeg(middle.x, middle.z, pano.x, pano.z) }))
        .filter(c => c.distanceM <= rangeM)
        .sort((a, b) => a.distanceM - b.distanceM || a.pano.panoId.localeCompare(b.pano.panoId));
}

/**
 * Up to `count` more views, greedily: a capture month not yet among the chosen counts most, then the side of the spot
 * farthest from the chosen ones' (up to 90°), then nearness. Deterministic: ties go to the nearer, then the pano id.
 */
export function chooseLookViews(cands: LookCandidate[], count: number, rangeM: number, already: LookCandidate[] = []): LookCandidate[] {
    const chosen = [...already];
    const picked: LookCandidate[] = [];
    const rest = cands.filter(c => !already.some(a => a.pano.panoId === c.pano.panoId));
    while (picked.length < count && rest.length) {
        const months = new Set(chosen.map(c => monthOf(c.pano.date)));
        let best = 0, bestScore = -Infinity;
        for (let i = 0; i < rest.length; i++) {
            const c = rest[i];
            const sep = chosen.length ? Math.min(...chosen.map(o => angleDiff(o.sideDeg, c.sideDeg))) : 90;
            const score = (months.has(monthOf(c.pano.date)) ? 0 : 2) + Math.min(sep, 90) / 90 - 0.5 * c.distanceM / Math.max(1, rangeM);
            if (score > bestScore) { bestScore = score; best = i; }
        }
        const [c] = rest.splice(best, 1);
        picked.push(c);
        chosen.push(c);
    }
    return picked;
}

// ---------------------------------------------------------------------------------------------------------------------
// the question
// ---------------------------------------------------------------------------------------------------------------------

export interface LookAnswer {
    /**
     * The place the camera was aimed at is in the photo, whatever stands there in this capture (not hidden behind
     * something, not out of frame). It is the place, not what the question asks about: a thing gone by this capture
     * leaves its place in view, and the answer then says it is not there.
     */
    placeInView: boolean;
    answer: string;
    /** The yes-or-no answer when the question is one and the photo settles it; else null. */
    yes: boolean | null;
    confidence: number;
    model?: string;
    cached?: boolean;
    /** The question failed: no answer (never counted either way). */
    error?: string;
}

export type LookAsker = (image: TemporaryImage, ask: { target: string; question: string; distanceM: number; spanDeg: number; fovDeg: number; signal?: AbortSignal }) => Promise<LookAnswer>;

export function lookPrompt(target: string, question: string, distanceM: number, spanDeg: number, fovDeg: number): string {
    const span = spanDeg >= 360 ? ' The camera stands within it.' : spanDeg > 1 ? ` It spans about ${Math.round(Math.min(spanDeg, fovDeg))}° of the photo's ${fovDeg}° width.` : '';
    return `This is a street-level photograph taken about ${Math.round(distanceM)} m from a place: ${target}. The camera was aimed at that place: its middle is near the centre of the photo.${span} ` +
        `Question about it: ${question.trim()} ` +
        'Answer from what this photo shows only; what stands at the place may differ from photo to photo (they were taken in different years). Blurred patches are privacy redaction. ' +
        'Answer with JSON only: {"placeInView": boolean (whether the place itself is in view in this photo, whatever stands there now: true even when what the question asks about is absent; ' +
        'false only when the place is hidden behind something such as a bus or truck, or out of frame), ' +
        '"answer": "your answer, in a sentence", "yes": true or false when the question is a yes-or-no question and the photo settles it, otherwise null, ' +
        '"confidence": number from 0 to 1}.';
}

/** Parses the model's answer (JSON, possibly fenced). Throws when it is not the asked shape. */
export function parseLookReply(text: string): Omit<LookAnswer, 'model' | 'cached'> {
    const body = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
    let j: Record<string, unknown>;
    try { j = JSON.parse(body); } catch { throw new Error(`the answer is not JSON: ${text.slice(0, 120)}`); }
    if (typeof j !== 'object' || j === null || typeof j.placeInView !== 'boolean') throw new Error('the answer has no "placeInView" boolean');
    const c = Number(j.confidence);
    return {
        placeInView: j.placeInView, answer: typeof j.answer === 'string' ? j.answer.trim() : '',
        yes: typeof j.yes === 'boolean' ? j.yes : null, confidence: Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : 0.5
    };
}

/** The repo's vision model chain as a LookAsker: one call per image, the image capped at LOOK_SEND_MAX_SIDE_PX. */
export function visionLookAsker(chain: VisionModelChain<string>, opts: { timeoutMs?: number } = {}): LookAsker {
    const timeoutMs = opts.timeoutMs ?? LOOK_CALL_TIMEOUT_MS;
    return async (image, ask) => {
        const own = new AbortController();
        const signal = ask.signal ? AbortSignal.any([ask.signal, own.signal]) : own.signal;
        let timer: CallTimer | undefined;
        try {
            const sent = await capImageSide(image.bytes, image.mimeType, image.widthPx, image.heightPx, LOOK_SEND_MAX_SIDE_PX);
            timer = callTimeout(() => own.abort(Object.assign(new Error(`the vision call took longer than ${Math.round(timeoutMs / 1000)} s`), { name: 'TimeoutError' })), timeoutMs);
            const r = await chain.generate({
                contents: [{ role: 'user', parts: [{ inlineData: { mimeType: sent.mimeType, data: sent.bytes.toString('base64') } }, { text: lookPrompt(ask.target, ask.question, ask.distanceM, ask.spanDeg, ask.fovDeg) }] }],
                config: { responseMimeType: 'application/json', temperature: 0, maxOutputTokens: LOOK_MAX_OUTPUT_TOKENS, abortSignal: signal }
            }, { stage: 'streetview-look', thinkingBudget: ORNAMENT_THINKING_BUDGET });
            const text = (r.response.candidates?.[0]?.content?.parts ?? []).filter(p => !(p as { thought?: boolean }).thought).map(p => p.text ?? '').join('');
            const reading = parseLookReply(text);
            r.remember();
            return { ...reading, model: r.model, ...(r.cached ? { cached: true } : {}) };
        } catch (err) {
            if (ask.signal?.aborted) throw err;
            const message = own.signal.aborted ? `the vision call took longer than ${Math.round(timeoutMs / 1000)} s` : err instanceof Error ? err.message : String(err);
            return { placeInView: false, answer: '', yes: null, confidence: 0, error: message };
        } finally {
            timer?.clear();
        }
    };
}

// ---------------------------------------------------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------------------------------------------------

export interface LookTarget {
    /** The spot's middle (an outline's: the mean of its corners). */
    lat: number;
    lng: number;
    outline?: Array<{ lat: number; lng: number }>;
    heightM?: number;
    /** The place, in words (the question names it so): the place, not the thing asked about, which may be gone in some captures. */
    description?: string;
}

export interface LookOptions {
    maxViews?: number;
    maxRangeM?: number;
    question?: string;
    /** Absolute folder the images are written to. */
    outDir: string;
    /** Paths in the result are relative to this. */
    workspaceRoot: string;
}

export interface LookDeps {
    streetView: StreetViewEvidenceDeps;
    /** Answers the question per view; without it a question is not asked (questionSkipped says so). */
    asker?: LookAsker;
    /** Why there is no asker, when a question was given. */
    askerUnavailable?: string;
    signal?: AbortSignal;
    onProgress?: (message: string) => void;
}

export interface LookViewResult {
    index: number;
    panoId: string;
    captureMonth: string;
    copyright?: string;
    /** Plan distance from the camera to the spot's nearest point. */
    distanceM: number;
    /** Compass bearing from the spot's middle to the camera. */
    sideDeg: number;
    camera: { lat: number; lng: number; eyeAboveStreetM: number };
    /** What the grounding API was asked; `pitchDeg` in its own sign: POSITIVE looks DOWN. */
    request: { headingDeg: number; pitchDeg: number; elevationDeg: number; fovDeg: number; aspectRatio: GroundingAspectRatio };
    spanDeg: number;
    framed: boolean;
    imagePath: string;
    mimeType: string;
    widthPx: number;
    heightPx: number;
    contentSha256: string;
    answer?: LookAnswer;
}

export interface LookMonth {
    month: string;
    /** Google captures of this month within range. */
    capturesInRange: number;
    /** The views of this month (indices into views). */
    views: number[];
    /**
     * Answer tallies (with a question): yes / no where the spot was visible; open: visible, the answer in words only (not a
     * yes-or-no question, or the photo does not settle it); notInView; failed: the question failed.
     */
    yes?: number;
    no?: number;
    open?: number;
    notInView?: number;
    failed?: number;
}

export interface StreetViewLookResult {
    target: { lat: number; lng: number; outline?: Array<{ lat: number; lng: number }>; heightM?: number; description: string };
    question?: string;
    questionSkipped?: string;
    views: LookViewResult[];
    months: LookMonth[];
    discovery: { probes: number; metadataCalls: number; cachedCalls: number; capturesInRange: number; rejectedNotGoogle: number; rejectedRefused: number; note: string };
    refusals: Array<{ panoId: string; error: string; replacedBy?: string }>;
    failures: Array<{ panoId: string; error: string; transient: boolean }>;
    summary: string;
}

/** No Google capture within range of the spot, or every image asked for was refused or failed. */
export class StreetViewLookNoCoverageError extends Error {
    readonly code = 'no_coverage';
    constructor(readonly reason: string) {
        super(`No Street View of the spot: ${reason}`);
        this.name = 'StreetViewLookNoCoverageError';
    }
}

const DISCOVERY_NOTE = 'The metadata endpoint answers with one capture per place: captures of other months appear where the cars drove a different line or the endpoint keeps them beside a newer one; a capture replaced at the same place is not found.';

function viewOf(c: LookCandidate, spot: LookSpot): SelectedView & { aim: LookAim; sideDeg: number } {
    const aim = aimAt(c.pano, spot);
    return {
        panoId: c.pano.panoId, ...(c.pano.date ? { date: c.pano.date } : {}), ...(c.pano.copyright ? { copyright: c.pano.copyright } : {}),
        eye: [c.pano.x, STREET_VIEW_EYE_HEIGHT_M, c.pano.z], facadeHeadingDeg: c.sideDeg, headingDeg: aim.headingDeg, pitchDeg: aim.elevationDeg,
        fovDeg: aim.fovDeg, aspectRatio: LOOK_ASPECT, distanceM: aim.distanceM, score: 0, aim, sideDeg: c.sideDeg
    };
}

export async function runStreetViewLook(target: LookTarget, options: LookOptions, deps: LookDeps): Promise<StreetViewLookResult> {
    const missing = missingCredentials(deps.streetView);
    if (missing) throw new StreetViewSurveyCredentialsError(missing);
    const progress = (m: string) => deps.onProgress?.(m);
    const maxViews = Math.max(1, Math.min(STREETVIEW_LOOK_MAX_VIEWS, Math.round(options.maxViews ?? STREETVIEW_LOOK_DEFAULT_VIEWS)));
    const rangeM = Math.max(5, Math.min(STREETVIEW_LOOK_MAX_RANGE_M, options.maxRangeM ?? STREETVIEW_LOOK_DEFAULT_RANGE_M));
    const origin: GeodeticOrigin = { lat: target.lat, lng: target.lng, heightMeters: 0 };
    const outline = target.outline && target.outline.length >= 2 ? target.outline : undefined;
    const spot: LookSpot = {
        points: outline ? outline.map(p => geodeticToScan(origin, p.lat, p.lng)) : [{ x: 0, z: 0 }],
        ...(target.heightM !== undefined && target.heightM > 0 ? { heightM: target.heightM } : {})
    };
    const description = target.description?.trim() || (outline ? 'the outlined spot' : 'the spot at the given point');

    const probes = lookProbePoints(spot, rangeM);
    progress(`looking for Street View captures within ${rangeM} m (${probes.length} free metadata queries)`);
    const found = await discoverPanosAt(origin, probes, deps.streetView, deps.signal, { x: 0, z: 0 }, Number.MAX_SAFE_INTEGER);
    const cands = lookCandidates([...found.panos, ...found.superseded], spot, rangeM);
    if (!cands.length) throw new StreetViewLookNoCoverageError(`no Google-captured panorama within ${rangeM} m (${found.rejectedNotGoogle} non-Google, ${found.rejectedRefused} refused before)`);

    // fetch, replacing refused panos by the next choice
    let chosen = chooseLookViews(cands, maxViews, rangeM);
    progress(`${cands.length} captures in range; fetching ${chosen.length} view${chosen.length === 1 ? '' : 's'}`);
    const refusedBefore = knownRefusals(deps.streetView);
    const refusals: StreetViewLookResult['refusals'] = [];
    const notFetched: Array<{ panoId: string; error: string; transient: boolean }> = [];
    const images: EvidenceImage[] = [];
    let ask = chosen.map(c => viewOf(c, spot));
    for (let round = 0; ask.length; round++) {
        const got = await fetchViews(ask, deps.streetView, deps.signal, SURVEY_IMAGE_TIMEOUT_MS);
        images.push(...got.images);
        const refused = got.failures.filter(f => f.refused);
        for (const f of got.failures.filter(x => !x.refused)) notFetched.push({ panoId: f.view.panoId, error: f.error, transient: f.transient });
        if (!refused.length || round >= LOOK_REFUSAL_RETRIES || deps.signal?.aborted) {
            for (const f of refused) refusals.push({ panoId: f.view.panoId, error: f.error });
            break;
        }
        const kept = chosen.filter(c => !refused.some(f => f.view.panoId === c.pano.panoId));
        const usable = cands.filter(c => !deps.streetView.refusedPanos?.has(c.pano.panoId) && !refusedBefore.has(c.pano.panoId) && !refused.some(f => f.view.panoId === c.pano.panoId));
        const tried = new Set([...chosen.map(c => c.pano.panoId), ...refusals.map(r => r.panoId)]);
        const next = chooseLookViews(usable.filter(c => !tried.has(c.pano.panoId)), refused.length, rangeM, kept);
        refused.forEach((f, i) => refusals.push({ panoId: f.view.panoId, error: f.error, ...(next[i] ? { replacedBy: next[i].pano.panoId } : {}) }));
        if (next.length) progress(`the grounding API refused ${refused.length} pano${refused.length === 1 ? '' : 's'}; asking the next eligible one`);
        chosen = [...kept, ...next];
        ask = next.map(c => viewOf(c, spot));
    }
    if (!images.length) throw new StreetViewLookNoCoverageError(`every image asked for was refused or failed (${[...refusals.map(r => r.error), ...notFetched.map(f => f.error)].slice(0, 3).join('; ')})`);

    // the images, exactly as returned, in the order chosen
    const order = new Map(chosen.map((c, i) => [c.pano.panoId, i]));
    images.sort((a, b) => (order.get(a.view.panoId) ?? 0) - (order.get(b.view.panoId) ?? 0));
    fs.mkdirSync(options.outDir, { recursive: true });
    const question = options.question?.trim() || undefined;
    const asker = question ? deps.asker : undefined;
    if (question && asker) progress(`asking the question of ${images.length} view${images.length === 1 ? '' : 's'}`);
    const views: LookViewResult[] = await mapConcurrent(images, LOOK_ASK_CONCURRENCY, async (im, index) => {
        const v = im.view as ReturnType<typeof viewOf>;
        const apiPitch = groundingPitchForElevation(v.pitchDeg);
        const file = path.join(options.outDir, groundingImageFileName(v.panoId, v.headingDeg, apiPitch, v.fovDeg, im.mimeType));
        fs.writeFileSync(file, im.bytes);
        const g = scanToGeodetic(origin, v.eye[0], 0, v.eye[2]);
        const answer = asker ? await asker({ bytes: im.bytes, mimeType: im.mimeType, widthPx: im.widthPx, heightPx: im.heightPx }, { target: description, question: question!, distanceM: v.aim.distanceM, spanDeg: v.aim.spanDeg, fovDeg: v.fovDeg, signal: deps.signal }) : undefined;
        return {
            index, panoId: v.panoId, captureMonth: monthOf(v.date), ...(v.copyright ? { copyright: v.copyright } : {}),
            distanceM: v.aim.distanceM, sideDeg: Math.round(v.sideDeg * 10) / 10,
            camera: { lat: Math.round(g.lat * 1e8) / 1e8, lng: Math.round(g.lng * 1e8) / 1e8, eyeAboveStreetM: STREET_VIEW_EYE_HEIGHT_M },
            request: { headingDeg: v.headingDeg, pitchDeg: apiPitch, elevationDeg: v.pitchDeg, fovDeg: v.fovDeg, aspectRatio: v.aspectRatio },
            spanDeg: v.aim.spanDeg, framed: v.aim.framed,
            imagePath: path.relative(options.workspaceRoot, file), mimeType: im.mimeType, widthPx: im.widthPx, heightPx: im.heightPx, contentSha256: im.sha256,
            ...(answer ? { answer } : {})
        };
    });

    // per capture month, newest first
    const monthNames = [...new Set([...cands.map(c => monthOf(c.pano.date)), ...views.map(v => v.captureMonth)])].sort((a, b) => (a === 'undated' ? 1 : b === 'undated' ? -1 : b.localeCompare(a)));
    const months: LookMonth[] = monthNames.map(month => {
        const mine = views.filter(v => v.captureMonth === month);
        const m: LookMonth = { month, capturesInRange: cands.filter(c => monthOf(c.pano.date) === month).length, views: mine.map(v => v.index) };
        if (asker) {
            const a = mine.map(v => v.answer!);
            m.yes = a.filter(x => !x.error && x.placeInView && x.yes === true).length;
            m.no = a.filter(x => !x.error && x.placeInView && x.yes === false).length;
            m.open = a.filter(x => !x.error && x.placeInView && x.yes === null).length;
            m.notInView = a.filter(x => !x.error && !x.placeInView).length;
            m.failed = a.filter(x => x.error).length;
        }
        return m;
    });
    const questionSkipped = question && !asker ? (deps.askerUnavailable || 'no vision model configured') : undefined;

    const seen = months.filter(m => m.views.length);
    const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
    let summary = `Street View look at ${description}: ${plural(views.length, 'view')} (© Google) from ${plural(seen.length, 'capture month')} (${seen.map(m => m.month).join(', ')}), ` +
        `of ${plural(cands.length, 'capture')} within ${rangeM} m (months: ${months.map(m => `${m.month} ×${m.capturesInRange}`).join(', ')})`;
    if (refusals.length) summary += `; ${plural(refusals.length, 'pano')} refused by the grounding API`;
    if (question && asker) {
        summary += `. "${question}": ` + seen.map(m => {
            const parts = [m.yes ? `yes ${m.yes}` : '', m.no ? `no ${m.no}` : '', m.open ? `open ${m.open}` : '', m.notInView ? `not visible ${m.notInView}` : '', m.failed ? `failed ${m.failed}` : ''].filter(Boolean);
            return `${m.month} ${parts.join(', ')}`;
        }).join('; ');
    } else if (questionSkipped) summary += `. The question was not asked: ${questionSkipped}`;
    summary += `. Images in ${STREETVIEW_IMAGE_DIR}/.`;

    return {
        target: { lat: target.lat, lng: target.lng, ...(outline ? { outline } : {}), ...(spot.heightM !== undefined ? { heightM: spot.heightM } : {}), description },
        ...(question ? { question } : {}), ...(questionSkipped ? { questionSkipped } : {}),
        views, months,
        discovery: { probes: probes.length, metadataCalls: found.metadataCalls, cachedCalls: found.cachedCalls, capturesInRange: cands.length, rejectedNotGoogle: found.rejectedNotGoogle, rejectedRefused: found.rejectedRefused, note: DISCOVERY_NOTE },
        refusals, failures: notFetched, summary
    };
}

// ---------------------------------------------------------------------------------------------------------------------
// the tool
// ---------------------------------------------------------------------------------------------------------------------

export const STREETVIEW_LOOK_DECLARATION: ToolDeclaration = {
    name: STREETVIEW_LOOK_TOOL_NAME,
    description:
        'Look at one real spot (a point, or an outline of lat/lng corners) in Google Street View, with no 3D Tiles download: finds the Google-captured panoramas within range, ' +
        'picks views from as many capture months and sides of the spot as it can, aims each at the spot (heading to its middle, elevation to its mid-height when heightM is given, ' +
        'field of view sized to it) and fetches it through the Maps Imagery Grounding API (redacted, permitted for generative use; a refused pano is replaced and reported). ' +
        'With a question (open, in words, e.g. "Is a temporary structure such as a sidewalk shed or scaffolding here, or is this part of the building?"), the vision model ' +
        'answers it per view (whether the place is in view, the answer, yes/no when it is a yes-or-no question, a confidence; photo-inferred), tallied per capture month. ' +
        'Returns per view the pano id, capture month, distance, camera lat/lng, the request (heading, the API pitch where POSITIVE looks down, fov), whether the spot fits ' +
        'the frame, the image path and the answer; the capture months found within range; refusals. Use it for anything at street level the tiles show but cannot explain, ' +
        'and to see what stood at a place in different years. Images are saved exactly as returned under build/streetview-grounding/.',
    parameters: {
        type: 'OBJECT',
        properties: {
            lat: { type: 'NUMBER', description: 'Latitude of the spot (with lng). With an outline it defaults to the outline\'s middle.' },
            lng: { type: 'NUMBER', description: 'Longitude of the spot (with lat).' },
            query: { type: 'STRING', description: 'Or a place name or address to look at, when no lat/lng or outline is given.' },
            outline: {
                type: 'ARRAY', description: 'Optional outline of the spot in plan, its corners in order (at least 2: a line such as a stretch of sidewalk, or a polygon). The views are sized to show all of it.',
                items: { type: 'OBJECT', properties: { lat: { type: 'NUMBER' }, lng: { type: 'NUMBER' } }, required: ['lat', 'lng'] }
            },
            heightM: { type: 'NUMBER', description: 'Height of the spot\'s top above the street, metres, to aim at its mid-height and fit it top to bottom. Without it the views are level.' },
            target: { type: 'STRING', description: 'The place, in words (e.g. "the west sidewalk of 7th Avenue between W 31st and W 33rd St"): the question names it so. Describe the place, not the thing asked about, which may be absent from some captures.' },
            question: { type: 'STRING', description: 'Optional question about the spot, answered per view by the vision model. Without it only the images are fetched.' },
            maxViews: { type: 'NUMBER', description: `Most views to fetch (default ${STREETVIEW_LOOK_DEFAULT_VIEWS}, at most ${STREETVIEW_LOOK_MAX_VIEWS}).` },
            maxRangeM: { type: 'NUMBER', description: `Farthest a camera may stand from the spot, metres (default ${STREETVIEW_LOOK_DEFAULT_RANGE_M}, at most ${STREETVIEW_LOOK_MAX_RANGE_M}).` }
        }
    }
};

function asOutline(v: unknown): Array<{ lat: number; lng: number }> | undefined {
    if (!Array.isArray(v)) return undefined;
    const pts = v.map(p => (Array.isArray(p) ? { lat: Number(p[0]), lng: Number(p[1]) } : { lat: Number((p as { lat?: unknown })?.lat), lng: Number((p as { lng?: unknown })?.lng) }))
        .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180);
    return pts.length >= 2 ? pts : undefined;
}

export const streetviewLookHandler: ToolHandler = async (args, ctx) => {
    const outline = asOutline(args.outline);
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    let lat = typeof args.lat === 'number' ? args.lat : Number.NaN, lng = typeof args.lng === 'number' ? args.lng : Number.NaN;
    if (!(Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) && outline) {
        lat = outline.reduce((s, p) => s + p.lat, 0) / outline.length;
        lng = outline.reduce((s, p) => s + p.lng, 0) / outline.length;
    }
    const hasCoords = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
    if (!hasCoords && !query) throw new Error('streetview_look needs lat and lng, an outline, or a query (a place name or address).');
    const report = (m: string) => ctx.reportProgress?.(m);

    const stagedDeps = await createStagedLocationDeps(stagedWorkspaceRoot(), { signal: ctx.signal });
    const sv = stagedDeps.streetView ?? {};
    const missing = missingCredentials(sv);
    if (missing) throw new StreetViewSurveyCredentialsError(missing);
    if (!hasCoords) {
        const place = await resolveQueryPlace(query, stagedDeps, ctx.signal);
        lat = place.lat; lng = place.lng;
    }
    const question = typeof args.question === 'string' && args.question.trim() ? args.question.trim() : undefined;
    const vision = stagedDeps.vision && 'client' in stagedDeps.vision ? stagedDeps.vision : undefined;
    const result = await runStreetViewLook({
        lat, lng, ...(outline ? { outline } : {}),
        ...(typeof args.heightM === 'number' && args.heightM > 0 ? { heightM: args.heightM } : {}),
        ...(typeof args.target === 'string' && args.target.trim() ? { description: args.target.trim() } : query ? { description: query } : {})
    }, {
        ...(typeof args.maxViews === 'number' ? { maxViews: args.maxViews } : {}),
        ...(typeof args.maxRangeM === 'number' ? { maxRangeM: args.maxRangeM } : {}),
        ...(question ? { question } : {}),
        outDir: path.join(ctx.workspaceRoot, STREETVIEW_IMAGE_DIR),
        workspaceRoot: ctx.workspaceRoot
    }, {
        streetView: { ...sv, refusedPanos: sv.refusedPanos ?? new Map<string, string>() },
        ...(question && vision ? {
            asker: visionLookAsker(new VisionModelChain<string>({ client: vision.client, candidates: vision.candidates, signal: ctx.signal, hedgeAfterMs: VISION_HEDGE_AFTER_MS, replyCache: stagedReplyCache(stagedDeps.cache) }))
        } : {}),
        signal: ctx.signal, onProgress: report
    });
    return {
        resultPayload: {
            success: true,
            ...result,
            imageHandling: `Images come only from the Maps Imagery Grounding API (Google captures; people and vehicles redacted) and are written exactly as returned, never re-encoded, under ${STREETVIEW_IMAGE_DIR}/. Only pano ids, locations and dates are cached.`,
            attribution: 'Street View © Google'
        } as unknown as ToolResultPayload,
        summaryResult: result.summary
    };
};
