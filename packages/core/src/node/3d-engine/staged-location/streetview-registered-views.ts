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
import type { Registration } from './pano-registration';
import type { EdgePanoOutcome, HeldImage } from './pano-edge-registration';
import { projectionViewFromRegistered } from './texture-projection-views';
import { occluderVerifier, ownViews, type OwnershipSegmenter, type ViewOwnershipRecord } from './streetview-ownership';
import { cleanStreetViewImage, registrationNcc, streetViewCleanEnabled, type StreetViewCleanResult } from './streetview-clean';
import type { EnhanceModelClient } from './texture-enhance';

const angleBetween = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
/** A requested face heading is matched to the structure's nearest facade within this angle. */
export const FACE_MATCH_TOLERANCE_DEG = 45;
/**
 * A view posed against the tile mesh (edges or jointly) to at most this residual needs no vision call to place the
 * structure in its photo: the geometry prompts the segmenter, and the cut-out's agreement with the projection still
 * judges it (streetview-ownership.ts `describe`). The Haughwout survey registered every pano jointly at 0.25-0.35 m.
 */
export const OWNERSHIP_TRUST_RESIDUAL_M = 0.6;

/** Whether `registration` posed the pano against the tile mesh (edges or jointly) to at most `maxResidualM`. */
export function trustedRegisteredPose(registration: Pick<Registration, 'perPano'> | undefined, panoId: string, maxResidualM = OWNERSHIP_TRUST_RESIDUAL_M): boolean {
    const per = registration?.perPano.find(p => p.panoId === panoId);
    return !!per && (per.method === 'edges' || per.method === 'joint') && per.edgeResidualM !== undefined && Number.isFinite(per.edgeResidualM) && per.edgeResidualM <= maxResidualM;
}

/**
 * The context mesh for the ownership and occluder masks of a structure that is not itself part of the tile mesh (pipeline
 * E's clean massing): the tile mesh without the structure's own scan. With the scan left in, every cornice and arch hood
 * the melted scan bulges past the massing plane counted as "something in front" (the Haughwout's ornament rows were cut out
 * of its owned pixels in stripes, and a frontal street-level view lost its target region and was refused). Triangles are
 * matched by centroid within `cellM` (the isolate is written from the tile's own triangles, so they coincide).
 */
export function contextWithoutStructure(context: RenderMesh3D, structure: RenderMesh3D, cellM = 0.02): RenderMesh3D {
    const key = (V: ArrayLike<number>, a: number, b: number, c: number) => {
        const x = (V[a] + V[b] + V[c]) / 3, y = (V[a + 1] + V[b + 1] + V[c + 1]) / 3, z = (V[a + 2] + V[b + 2] + V[c + 2]) / 3;
        return `${Math.round(x / cellM)},${Math.round(y / cellM)},${Math.round(z / cellM)}`;
    };
    const own = new Set<string>();
    const SV = structure.vertices, SI = structure.indices;
    for (let t = 0; t + 2 < SI.length; t += 3) own.add(key(SV, SI[t] * 3, SI[t + 1] * 3, SI[t + 2] * 3));
    if (!own.size) return context;
    const CV = context.vertices, CI = context.indices;
    const kept: number[] = [];
    for (let t = 0; t + 2 < CI.length; t += 3) {
        if (own.has(key(CV, CI[t] * 3, CI[t + 1] * 3, CI[t + 2] * 3))) continue;
        kept.push(CI[t], CI[t + 1], CI[t + 2]);
    }
    return { vertices: CV, indices: Uint32Array.from(kept) };
}

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

/** Height above the structure's foot a street-level view is aimed at (the middle of a ground storey and the one above it). */
export const STREET_LEVEL_AIM_M = 4.5;

/**
 * The same pano and heading as a survey view, aimed lower: at STREET_LEVEL_AIM_M above the structure's foot, so the lower
 * storeys (which a view framing the whole face from a narrow street leaves below its frame) are in the photo. Registered
 * with its pano's other view, as one pano.
 */
export function streetLevelView(v: SurveyView, face: SurveyFaceTarget, groundY: number): SurveyView {
    const d = Math.max(1, Math.hypot(face.centre[0] - v.eye[0], face.centre[2] - v.eye[2]));
    const elevationDeg = Math.max(-20, Math.min(30, (Math.atan2(groundY + STREET_LEVEL_AIM_M - v.eye[1], d) * 180) / Math.PI));
    return { ...v, pitchDeg: Math.round(elevationDeg * 10) / 10 };
}

/** How a view's pose was had: 'joint', 'edges' (registered against the tile mesh) or 'nominal' (good to about ±2 m and ±2°). */
export interface ViewRegistration { method: 'joint' | 'edges' | 'nominal' | (string & {}); residualM: number | null }

/** A Street View view in memory with its registered pose, ownership mask and how it was registered. */
export type RegisteredView = ProjectionView & {
    registration: ViewRegistration; faceId: string; ownership?: ViewOwnershipRecord;
    /**
     * The obstruction-free copy of `image` (streetview-clean.ts): the pixels in front of the structure filled, `cleanFilledMask`
     * 1 where a pixel is generated. A reference for image models only; `image` and `ownerMask` stay the photograph as captured.
     */
    cleanImage?: ProjectionView['image']; cleanFilledMask?: Uint8Array;
    clean?: Pick<StreetViewCleanResult, 'decision' | 'occluderPixels' | 'filledPixels' | 'reason' | 'modelUsed' | 'cached' | 'verify'>;
};

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
    /** Also a street-level view (streetLevelView) of each planned view's pano (default false). */
    streetLevel?: boolean;
    /** Diagnostics: one ownership overlay PNG per view is written here (ownViews). */
    debugDir?: string;
    /**
     * A view registered (edges or jointly) to at most this residual is cut out from the geometry alone, without the vision
     * call that places the structure in the photo (default OWNERSHIP_TRUST_RESIDUAL_M; 0 never trusts a pose).
     */
    trustRegisteredM?: number;
    /** Make each view's obstruction-free copy (cleanImage) through this image client (streetview-clean.ts); absent: none made. */
    clean?: { client: EnhanceModelClient; models: string[]; cacheDir?: string };
    signal?: AbortSignal; onProgress?: (m: string) => void;
}): Promise<{
    views: RegisteredView[]; images: EvidenceImage[]; refusals: SurveyRefusal[]; failures: SurveyFetchFailure[]; registrationError?: string;
    /** How the registration went, per pano: the edge pose taken or not and why, and the joint fit's verdict (why a view stayed nominal). */
    registration?: { panos: Array<{ panoId: string; chosen: string; reason: string; edgeResidualPx: EdgePanoOutcome['edgeResidualPx'] }>; joint?: { chosen: string; reason: string } };
    ms: { fetch: number; register: number; own: number };
}> {
    const progress = input.onProgress ?? (() => undefined);
    const faces = structureFaces(input.site.structure);
    const planned = planSurveyViews(input.panos, faces, input.site, input.maxViews);
    const faceOf = new Map(faces.map(f => [f.faceId, f]));
    const lower = input.streetLevel ? planned.views.map(v => streetLevelView(v, faceOf.get(v.faceId)!, input.site.structure.groundY)).filter((v, k) => Math.abs(v.pitchDeg - planned.views[k].pitchDeg) >= 3) : [];
    const plan = { ...planned, views: [...planned.views, ...lower] };
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
    const trust = input.trustRegisteredM ?? OWNERSHIP_TRUST_RESIDUAL_M;
    const occluderMasks = new Map<number, Uint8Array>();
    const own = await ownViews({
        views: pviews, structure: input.structureMesh, concurrency: 4, ...(input.context ? { context: input.context } : {}), segment: input.segment, ...(input.target ? { target: input.target } : {}),
        describe: v => !trustedRegisteredPose(registration, v.panoId, trust), ...(input.debugDir ? { debugDir: input.debugDir } : {}), signal: input.signal, onProgress: progress,
        onMasks: (k, m) => occluderMasks.set(k, m.occluders)
    });
    const views: RegisteredView[] = own.views.map((v, k) => {
        const per = registration?.perPano.find(p => p.panoId === v.panoId);
        const method = per?.method ?? 'nominal';
        return { ...v, faceId: (got.images[k].view as SurveyView).faceId, registration: { method, residualM: per?.edgeResidualM ?? null }, ownership: own.records[k] };
    });
    if (input.clean && streetViewCleanEnabled()) {
        const c = input.clean;
        const jobs = views.map((v, k) => ({ v, occ: occluderMasks.get(k) })).filter(j => j.occ && j.v.ownership?.status === 'segmented');
        if (jobs.length) progress(`removing what stands in front of the structure from ${jobs.length} Street View photo(s)`);
        await pool(jobs, 4, async ({ v, occ }) => {
            try {
                let structurePixels = 0;
                for (let i = 0; i < occ!.length; i++) if (occ![i] || v.ownerMask?.[i]) structurePixels++;
                const r = await cleanStreetViewImage({ image: v.image, occluders: occ!, client: c.client, models: c.models, ...(v.ownership?.prompts === 'description' ? {} : { registrationNcc: registrationNcc(outcome, v.panoId) }), structurePixels, ...(input.target ? { verify: occluderVerifier(input.segment, input.target, input.signal) } : {}), ...(c.cacheDir ? { cacheDir: c.cacheDir } : {}), ...(input.signal ? { signal: input.signal } : {}) });
                v.clean = { decision: r.decision, occluderPixels: r.occluderPixels, filledPixels: r.filledPixels, ...(r.verify ? { verify: r.verify } : {}), ...(r.reason ? { reason: r.reason } : {}), ...(r.modelUsed ? { modelUsed: r.modelUsed } : {}), ...(r.cached ? { cached: true } : {}) };
                if (r.filledPixels) { v.cleanImage = r.image; v.cleanFilledMask = r.filledMask; }
            } catch (err) {
                if (input.signal?.aborted) throw err;
                v.clean = { decision: 'model_failed', occluderPixels: 0, filledPixels: 0, reason: err instanceof Error ? err.message : String(err) };
            }
        });
    }
    const how = outcome ? {
        panos: (outcome.edge?.panos ?? []).map(p => ({ panoId: p.panoId, chosen: p.chosen, reason: p.reason, edgeResidualPx: p.edgeResidualPx })),
        ...(outcome.joint ? { joint: { chosen: outcome.joint.chosen, reason: outcome.joint.reason } } : {})
    } : undefined;
    return { views, images: got.images, refusals: got.refusals, failures: got.failures, ...(registrationError ? { registrationError } : {}), ...(how ? { registration: how } : {}), ms: { fetch: fetchMs, register: registerMs, own: Date.now() - t } };
}

/** Runs `fn` over `xs` with at most `n` in flight. */
async function pool<T>(xs: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, xs.length) }, async () => { while (i < xs.length) await fn(xs[i++]); }));
}

export { sceneToRenderMesh, readGlbScene };
