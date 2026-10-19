/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The Street View survey's planning, fetching and registration, shared by the `streetview_survey` tool
 * (gemini/tools/location-evidence/streetview-survey.ts) and pipeline E's enhanced mode: the faces of a structure, the views
 * that look at them (one wide view per face, then each face's next best pano), the fetch with the grounding API's refusals
 * replaced by the next eligible pano, and registeredSurveyViews: those views posed against the full tile mesh (edges, then
 * jointly) and cut out by the ownership and occluder masks, in memory.
 */

import type { GroundModel } from '../../spatial/StreetViewSurveyPlanner';
import type { RenderMesh3D } from '../../spatial/HeadlessMeshSilhouetteRenderer';
import { sceneToRenderMesh, readGlbScene } from '../../spatial/StreetViewPoseRegistrar';
import type { ProjectionView } from '../../../common/spatial/texture-pass-contracts';
import { fetchViews, knownRefusals, type EvidenceImage, type PanoCandidate, type StreetViewEvidenceDeps } from './streetview-evidence';
import { footprintSurveyFaces, selectSurveyViews, surveyCandidates, surveyViewFor, SURVEY_IMAGE_TIMEOUT_MS, SURVEY_REFUSAL_RETRIES, type SurveyFaceTarget, type SurveyView } from './face-survey';
import type { StructurePickResult } from './extraction-sizing';
import { runPanoRegistrationOffThread, type PanoRegistrationJob, type PanoRegistrationOutcome } from './pano-registration-run';
import type { HeldImage } from './pano-edge-registration';
import { projectionViewFromRegistered } from './texture-projection-views';
import { ownViews, type OwnershipSegmenter, type ViewOwnershipRecord } from './streetview-ownership';

const angleBetween = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
/** A requested face heading is matched to the structure's nearest facade within this angle. */
export const FACE_MATCH_TOLERANCE_DEG = 45;

export interface SurveyRefusal { faceId: string; panoId: string; error: string; replacedBy?: string }
export interface SurveyFetchFailure { faceId: string; panoId: string; error: string; transient: boolean }

/** What the survey runs against: the structure, its ground model and the unmasked surface model (trees do block a photo). */
export interface SurveyGround { structure: StructurePickResult; ground: GroundModel; unmaskedTop: Float32Array }

/**
 * Every facade of the structure as a survey face. footprintSurveyFaces keeps the first four (the staged survey's budget);
 * a structure whose outline has more sides (a corner lot, a chamfered block) would lose faces that way, so the faces are
 * taken four headings at a time through it and all kept.
 */
export function structureFaces(structure: StructurePickResult): SurveyFaceTarget[] {
    const out: SurveyFaceTarget[] = [];
    for (let k = 0; k < structure.facadeHeadingsDeg.length; k += 4) out.push(...footprintSurveyFaces({ ...structure, facadeHeadingsDeg: structure.facadeHeadingsDeg.slice(k, k + 4) }));
    return out;
}

/** The structure's faces to cover: those nearest each requested heading (within FACE_MATCH_TOLERANCE_DEG), else all. */
export function facesToCover(all: SurveyFaceTarget[], headingsDeg?: number[]): { faces: SurveyFaceTarget[]; unmatched: Array<{ headingDeg: number; reason: string }> } {
    if (!headingsDeg?.length) return { faces: all, unmatched: [] };
    const picked = new Set<string>();
    const unmatched: Array<{ headingDeg: number; reason: string }> = [];
    for (const h of headingsDeg) {
        const best = [...all].sort((a, b) => angleBetween(a.headingDeg, h) - angleBetween(b.headingDeg, h))[0];
        if (best && angleBetween(best.headingDeg, h) <= FACE_MATCH_TOLERANCE_DEG) picked.add(best.faceId);
        else unmatched.push({ headingDeg: h, reason: `no facade of the structure faces within ${FACE_MATCH_TOLERANCE_DEG}° of ${Math.round(h)}° (its facades face ${all.map(f => `${Math.round(f.headingDeg)}°`).join(', ') || 'nowhere measurable'})` });
    }
    return { faces: all.filter(f => picked.has(f.faceId)), unmatched };
}

/**
 * The views: the staged survey's one wide view per face (selectSurveyViews), then, while more are asked for, each face's
 * next best pano in turn (the faces with the fewest candidates first), never a pano twice.
 */
export function planSurveyViews(
    panos: PanoCandidate[], faces: SurveyFaceTarget[], site: SurveyGround, maxViews: number
): { views: SurveyView[]; skipped: Array<{ faceId: string; headingDeg: number; reason: string }>; candidates: ReturnType<typeof surveyCandidates> } {
    const base = selectSurveyViews(panos, faces, site.structure, site.ground, site.unmaskedTop, maxViews);
    const candidates = surveyCandidates(panos, faces, site.structure, site.ground, site.unmaskedTop);
    const views = [...base.views];
    const used = new Set(views.map(v => v.panoId));
    const order = [...faces].sort((a, b) => candidates.get(a.faceId)!.length - candidates.get(b.faceId)!.length || a.headingDeg - b.headingDeg);
    for (let added = true; added && views.length < maxViews;) {
        added = false;
        for (const face of order) {
            if (views.length >= maxViews) break;
            const next = candidates.get(face.faceId)!.find(c => !used.has(c.pano.panoId));
            if (!next) continue;
            used.add(next.pano.panoId);
            views.push(surveyViewFor(face, next));
            added = true;
        }
    }
    // a face skipped only because the staged survey's budget of four was spent, but given a view here, is not skipped; one
    // still without a view says so in this call's terms
    const skipped = base.skipped.filter(s => !views.some(v => v.faceId === s.faceId))
        .map(s => (/image budget/.test(s.reason) ? { ...s, reason: `the ${maxViews} view${maxViews === 1 ? '' : 's'} asked for went to other faces first (the faces with the fewest panoramas choose first)` } : s));
    return { views, skipped, candidates };
}

/**
 * Fetches the views through the grounding service; a pano the API refuses (403, "not published or eligible") is recorded
 * and the face's next eligible pano asked instead, up to SURVEY_REFUSAL_RETRIES rounds (runFaceSurvey's rule).
 */
export async function fetchWithRefusalRetry(
    plan: { views: SurveyView[]; candidates: ReturnType<typeof surveyCandidates> }, faces: SurveyFaceTarget[], deps: StreetViewEvidenceDeps, signal?: AbortSignal,
    onProgress?: (m: string) => void
): Promise<{ images: EvidenceImage[]; refusals: SurveyRefusal[]; failures: SurveyFetchFailure[]; views: SurveyView[] }> {
    const refusedBefore = knownRefusals(deps);
    const faceOf = new Map(faces.map(f => [f.faceId, f]));
    let views = plan.views;
    const first = await fetchViews(views, deps, signal, SURVEY_IMAGE_TIMEOUT_MS);
    const images: EvidenceImage[] = [...first.images];
    const refusals: SurveyRefusal[] = [];
    const notFetched: typeof first.failures = [];
    let pending = first.failures;
    for (let round = 0; round < SURVEY_REFUSAL_RETRIES && pending.length; round++) {
        if (signal?.aborted) break;
        notFetched.push(...pending.filter(f => !f.refused));
        const used = new Set(views.map(v => v.panoId));
        const retry: SurveyView[] = [];
        for (const f of pending.filter(x => x.refused)) {
            const old = f.view as SurveyView;
            const next = (plan.candidates.get(old.faceId) ?? []).find(c => !used.has(c.pano.panoId) && !deps.refusedPanos?.has(c.pano.panoId) && !refusedBefore.has(c.pano.panoId));
            refusals.push({ faceId: old.faceId, panoId: old.panoId, error: f.error, ...(next ? { replacedBy: next.pano.panoId } : {}) });
            if (!next) { notFetched.push(f); continue; }
            used.add(next.pano.panoId);
            const view = surveyViewFor(faceOf.get(old.faceId)!, next);
            views = views.map(v => (v === old ? view : v));
            retry.push(view);
        }
        pending = [];
        if (!retry.length) break;
        onProgress?.(`the grounding API refused ${retry.length} pano${retry.length === 1 ? '' : 's'}; asking the next eligible one`);
        const again = await fetchViews(retry, deps, signal, SURVEY_IMAGE_TIMEOUT_MS);
        images.push(...again.images);
        pending = again.failures;
    }
    notFetched.push(...pending);
    // a refused view that found no replacement is in notFetched and in refusals; report it once, as a refusal
    const failures = notFetched.filter(f => !(f.refused && refusals.some(r => r.panoId === f.view.panoId)))
        .map(f => ({ faceId: (f.view as SurveyView).faceId, panoId: f.view.panoId, error: f.error, transient: f.transient }));
    return { images, refusals, failures, views };
}

/** How a view's pose was had: 'joint', 'edges' (registered against the tile mesh) or 'nominal' (good to about ±2 m and ±2°). */
export interface ViewRegistration { method: 'joint' | 'edges' | 'nominal' | (string & {}); residualM: number | null }

/** A Street View view in memory with its registered pose, ownership mask and how it was registered. */
export type RegisteredView = ProjectionView & { registration: ViewRegistration; faceId: string; ownership?: ViewOwnershipRecord };

/**
 * The survey's views of a structure, registered and cut out, in memory (nothing written): planSurveyViews over `panos`
 * (at most maxViews), fetchWithRefusalRetry, the edge then joint registration against `tileMeshFiles` (in its worker),
 * projectionViewFromRegistered, and the ownership and occluder masks (ownViews). A registration that fails leaves the
 * nominal poses, said per view.
 */
export async function registeredSurveyViews(input: {
    site: SurveyGround; panos: PanoCandidate[]; maxViews: number; sv: StreetViewEvidenceDeps; tileMeshFiles: string[];
    structureMesh: RenderMesh3D; context?: RenderMesh3D; segment: OwnershipSegmenter; target?: string;
    register?: (job: PanoRegistrationJob, opts: { signal?: AbortSignal; log?: (m: string) => void }) => Promise<PanoRegistrationOutcome>;
    signal?: AbortSignal; onProgress?: (m: string) => void;
}): Promise<{ views: RegisteredView[]; images: EvidenceImage[]; refusals: SurveyRefusal[]; failures: SurveyFetchFailure[]; registrationError?: string; ms: { fetch: number; register: number; own: number } }> {
    const progress = input.onProgress ?? (() => undefined);
    const faces = structureFaces(input.site.structure);
    const plan = planSurveyViews(input.panos, faces, input.site, input.maxViews);
    if (!plan.views.length) return { views: [], images: [], refusals: [], failures: [], ms: { fetch: 0, register: 0, own: 0 } };
    let t = Date.now();
    progress(`requesting ${plan.views.length} Street View views of the structure's faces`);
    const got = await fetchWithRefusalRetry(plan, faces, input.sv, input.signal, progress);
    const fetchMs = Date.now() - t;
    if (!got.images.length) return { views: [], images: [], refusals: got.refusals, failures: got.failures, ms: { fetch: fetchMs, register: 0, own: 0 } };
    t = Date.now();
    let outcome: PanoRegistrationOutcome | undefined, registrationError: string | undefined;
    const held: HeldImage[] = got.images.map(im => ({ id: im.id, bytes: im.bytes, widthPx: im.widthPx, heightPx: im.heightPx, view: im.view }));
    try {
        outcome = await (input.register ?? runPanoRegistrationOffThread)({ images: held, meshFiles: input.tileMeshFiles, correspondences: [], faces: [] }, { signal: input.signal, log: progress });
    } catch (err) {
        if (input.signal?.aborted) throw err;
        registrationError = err instanceof Error ? err.message : String(err);
        progress(`registration failed (${registrationError}); the nominal poses stand`);
    }
    const registerMs = Date.now() - t;
    const registration = outcome?.registration;
    const pviews = got.images.map(im => projectionViewFromRegistered({
        view: { panoId: im.view.panoId, eye: im.view.eye, headingDeg: im.view.headingDeg, pitchDeg: im.view.pitchDeg, fovDeg: im.view.fovDeg, widthPx: im.widthPx, heightPx: im.heightPx },
        jpeg: im.bytes, ...(registration ? { registration } : {}), ...(im.view.date ? { captureDate: im.view.date } : {})
    }));
    t = Date.now();
    const own = await ownViews({ views: pviews, structure: input.structureMesh, ...(input.context ? { context: input.context } : {}), segment: input.segment, ...(input.target ? { target: input.target } : {}), signal: input.signal, onProgress: progress });
    const views: RegisteredView[] = own.views.map((v, k) => {
        const per = registration?.perPano.find(p => p.panoId === v.panoId);
        const method = per?.method ?? 'nominal';
        return { ...v, faceId: (got.images[k].view as SurveyView).faceId, registration: { method, residualM: per?.edgeResidualM ?? null }, ownership: own.records[k] };
    });
    return { views, images: got.images, refusals: got.refusals, failures: got.failures, ...(registrationError ? { registrationError } : {}), ms: { fetch: fetchMs, register: registerMs, own: Date.now() - t } };
}

export { sceneToRenderMesh, readGlbScene };
