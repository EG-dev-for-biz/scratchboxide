/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * `streetview_survey`: the staged build's Street View survey of one structure, as a tool of its own.
 *
 * Nothing here is new machinery; it wires what the staged build already runs, unchanged:
 * - the structure and its street from the staged caches (geocode, the request-sized extraction, the structure pick:
 *   extraction-sizing.ts), so a place already built is not extracted again;
 * - pano discovery on the free metadata endpoint, Google captures only, with the shared metadata and refusal caches
 *   (streetview-evidence.ts), on the ground and surface models of StreetViewSurveyPlanner;
 * - one wide view per face (face-survey.ts selectSurveyViews / surveyCandidates / surveyViewFor), more views per face
 *   when more are asked for, all fetched through StreetViewGroundingImageService (the Maps Imagery Grounding API) and
 *   nothing else;
 * - the grounding API's 403 refusals: the refused pano is recorded and the face's next eligible pano asked instead,
 *   SURVEY_REFUSAL_RETRIES rounds, exactly as runFaceSurvey does;
 * - the edge then joint registration against the full tile mesh (pano-registration-run.ts, in its worker thread);
 * - optionally, the texture pass's pixel ownership and occluder masks (streetview-ownership.ts).
 *
 * Images. The staged build never writes grounding images (docs/processes/staged-location-builds.md). This tool hands
 * images to the user, so it follows the one existing path that does, `streetview_grounding_image`: the JPEG bytes exactly
 * as the API returned them (never decoded and re-encoded, so their content credentials stay), written under
 * <workspace>/build/streetview-grounding/ with that tool's file names. Masks are written as PNGs beside them (they hold no
 * photo pixel). Pano ids, locations and dates go to the shared metadata cache as before; nothing else is cached.
 */

import * as fs from 'fs';
import * as path from 'path';
import { scanToGeodetic, buildGroundModel, type GeodeticOrigin, type GroundModel, type ScanMesh } from '../../../spatial/StreetViewSurveyPlanner';
import { groundingPitchForElevation, type GroundingAspectRatio } from '../../../spatial/StreetViewGroundingImageService';
import {
    groundingFocalPx, groundingHorizontalFovDeg, projectToFrame, readGlbScene, sceneToRenderMesh, type FrameCamera, type PoseCorrection
} from '../../../spatial/StreetViewPoseRegistrar';
import type { RenderMesh3D } from '../../../spatial/HeadlessMeshSilhouetteRenderer';
import { castCamera } from '../../../3d-engine/staged-location/survey-casting';
import {
    discoverPanos, facadeGeometry, knownRefusals, missingCredentials, type StreetViewEvidenceDeps
} from '../../../3d-engine/staged-location/streetview-evidence';
import type { SurveyFaceTarget, SurveyView } from '../../../3d-engine/staged-location/face-survey';
import { pointHidden } from '../../../3d-engine/staged-location/evidence-aim';
import { runPanoRegistrationOffThread, type PanoRegistrationJob, type PanoRegistrationOutcome } from '../../../3d-engine/staged-location/pano-registration-run';
import { EDGE_REG_MAX_WIDTH_PX, type HeldImage } from '../../../3d-engine/staged-location/pano-edge-registration';
import { JOINT_METRIC_WIDTH_PX, JOINT_WIDTHS_PX } from '../../../3d-engine/staged-location/pano-joint-registration';
import { projectionViewFromRegistered } from '../../../3d-engine/staged-location/texture-projection-views';
import { objectSegmenter, ownViews, type OwnershipSegmenter, type ViewOwnershipRecord } from '../../../3d-engine/staged-location/streetview-ownership';
import { encodePng } from '../../../3d-engine/staged-location/png-encode';
import { canopyLookup, maskCanopy, pickStructure, sizeExtraction, type StructurePickResult } from '../../../3d-engine/staged-location/extraction-sizing';
import { evidenceLookup } from '../../../3d-engine/staged-location/vector-footprints';
import { EXTRACTION_TTL_MS, GEOCODE_TTL_MS, type ResolvedPlace, type StagedExtraction, type StagedLocationDeps } from '../../../3d-engine/staged-location/orchestrator';
import { stageKey, stagedWorkspaceRoot } from '../../../3d-engine/staged-location/stage-cache';
import { createStagedLocationDeps } from '../../../3d-engine/staged-location/staged-location-tool';
import type { Vec3 } from '../../../../common/spatial/staged-location-contracts';
import type { ToolDeclaration, ToolHandler, ToolResultPayload } from '../types';
import {
    FACE_MATCH_TOLERANCE_DEG, facesToCover, fetchWithRefusalRetry, planSurveyViews, structureFaces, type SurveyFetchFailure, type SurveyRefusal
} from '../../../3d-engine/staged-location/streetview-registered-views';

export { FACE_MATCH_TOLERANCE_DEG, facesToCover, fetchWithRefusalRetry, planSurveyViews, structureFaces, type SurveyFetchFailure, type SurveyRefusal };

const DEG = Math.PI / 180;

export const STREETVIEW_SURVEY_TOOL_NAME = 'streetview_survey';
/** Views asked for when the call does not say: one per face, as the staged survey takes. */
export const STREETVIEW_SURVEY_DEFAULT_VIEWS = 4;
/** Most views one call fetches (each is one grounding request, and the registration's time grows with them). */
export const STREETVIEW_SURVEY_MAX_VIEWS = 12;
/** Where the images go, under the workspace: the folder `streetview_grounding_image` writes to. */
export const STREETVIEW_IMAGE_DIR = path.join('build', 'streetview-grounding');

// ---------------------------------------------------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------------------------------------------------

/** A credential the survey needs is missing: the Maps key (pano discovery) or the service account (grounding images). */
export class StreetViewSurveyCredentialsError extends Error {
    readonly code = 'missing_credentials';
    constructor(readonly missing: string) {
        super(`${missing}. Add the Google Maps API key and the Google Cloud service account in Settings.`);
        this.name = 'StreetViewSurveyCredentialsError';
    }
}

/** No Google-captured Street View looks at the structure, or every image the survey asked for was refused or failed. */
export class StreetViewSurveyNoCoverageError extends Error {
    readonly code = 'no_coverage';
    constructor(readonly reason: string, readonly details: { panosFound: number; refusals?: SurveyRefusal[]; fetchFailures?: SurveyFetchFailure[] } = { panosFound: 0 }) {
        super(`No Street View coverage of the structure: ${reason}`);
        this.name = 'StreetViewSurveyNoCoverageError';
    }
}

/** No structure stands at the place (or the one given does not lie on the extraction), so there is nothing to survey. */
export class StreetViewSurveyNoStructureError extends Error {
    readonly code = 'no_structure';
    constructor(readonly reason: string) {
        super(`No structure to survey: ${reason}`);
        this.name = 'StreetViewSurveyNoStructureError';
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// the site: what the survey is run against
// ---------------------------------------------------------------------------------------------------------------------

export interface SurveySite {
    /** The tile frame's origin (x east, y up, z south, metres). */
    origin: GeodeticOrigin;
    label: string;
    structure: StructurePickResult;
    /** The (canopy-masked) ground model the structure was picked on. */
    ground: GroundModel;
    /** The unmasked surface model: trees do block a photo. */
    unmaskedTop: Float32Array;
    /** GLB files of the full tile mesh the views are registered against (the extraction's geometry). */
    tileMeshFiles: string[];
    /** The structure itself, tile frame: the ownership masks' target and the coverage's judge. */
    structureMesh: RenderMesh3D;
    structureMeshSource: 'given' | 'scan-crop' | (string & {});
}


export interface StreetViewSurveyOptions {
    maxViews?: number;
    /** Compass headings (outward, clockwise from north) of the faces to cover; absent: every facade of the structure. */
    faceHeadingsDeg?: number[];
    /** Cut the structure out of each view (and what stands in front of it) and write the masks. */
    ownershipMasks?: boolean;
    /** What the structure is, in words: the segmenter then finds it by what it is and cuts out occluders too. */
    target?: string;
    /** Absolute folder the images and masks are written to. */
    outDir: string;
    /** Paths in the result are relative to this. */
    workspaceRoot: string;
}

export interface StreetViewSurveyDeps {
    streetView: StreetViewEvidenceDeps;
    /** The ownership segmenter (default: the repo's MediaPipe interactive segmenter + GrabCut, objectSegmenter()). */
    segmenter?: OwnershipSegmenter;
    /** The edge + joint registration (default: runPanoRegistrationOffThread). */
    register?: (job: PanoRegistrationJob, opts: { signal?: AbortSignal; log?: (m: string) => void }) => Promise<PanoRegistrationOutcome>;
    signal?: AbortSignal;
    onProgress?: (message: string) => void;
}

export interface SurveyedViewResult {
    index: number;
    panoId: string;
    /** "YYYY-MM", the month the panorama was captured (the metadata's date). */
    captureMonth?: string;
    copyright?: string;
    faceId: string;
    faceHeadingDeg: number;
    imagePath: string;
    mimeType: string;
    widthPx: number;
    heightPx: number;
    /** sha256 of the image content (the JPEG without its metadata segments: the API re-signs every answer). */
    contentSha256: string;
    /** What the grounding API was asked. `pitchDeg` is in the API's own sign: POSITIVE looks DOWN. */
    request: { headingDeg: number; pitchDeg: number; elevationDeg: number; fovDeg: number; aspectRatio: GroundingAspectRatio };
    camera: {
        /** Tile frame, metres. */
        position: { x: number; y: number; z: number };
        geodetic: { lat: number; lng: number; ellipsoidalHeightM: number };
        orientation: {
            /** Of the optical axis, clockwise from north. */
            headingDeg: number;
            /** Of the optical axis, UP positive (the app's convention). */
            elevationDeg: number;
            /** The same tilt in the grounding API's sign (down positive): -elevationDeg. */
            apiPitchDeg: number;
            /** Positive: the camera's right side lowered. */
            rollDeg: number;
            /** Camera basis in the tile frame: x right, y up, the view direction (OpenGL-style, the camera looks along +forward). */
            right: Vec3; up: Vec3; forward: Vec3;
        };
        intrinsics: {
            /** Pixels at the delivered image size: fx = fy = (width / crop width) × 960 / tan(requested fov / 2). */
            fx: number; fy: number; cx: number; cy: number; widthPx: number; heightPx: number;
            requestedFovDeg: number;
            /** The image's true horizontal field of view (a crop of the 1920 × 1280 frame). */
            horizontalFovDeg: number;
        };
        /**
         * The registered pose's offset from the nominal one (the pano position, 2.5 m above the street): pitch and roll are
         * about the axes of `referenceHeadingDeg` (the pano's own reference when registered as a whole).
         */
        correction: { dxM: number; dyM: number; dzM: number; dyawDeg: number; dpitchDeg: number; drollDeg: number; referenceHeadingDeg: number };
    };
    registration: {
        /** 'joint', 'joint+warp', 'edges', or 'nominal' (not registered: good to about ±2 m and ±2°). */
        method: string;
        /** The residual the method reports, px at `residualAtWidthPx`, and scaled to the delivered image. Null when not measured. */
        residualPx: number | null;
        residualAtWidthPx: number | null;
        residualImagePx: number | null;
        residualM: number | null;
        reason: string;
        /** The joint registration kept a non-rigid per-pano warp: the pinhole above is the rigid part of the pose. */
        warpKept: boolean;
        /** Joint only: the median residual of this pano's cross-view matches after the fit, px at 640 wide (null: no match held). */
        crossViewMatchPx?: number | null;
    };
    ownership?: {
        status: ViewOwnershipRecord['status'] | 'not-run';
        reason?: string;
        iou?: number;
        ownerMaskPath?: string;
        occluderMaskPath?: string;
        ownerPixels?: number;
        occluderPixels?: number;
    };
}

export interface FaceCoverage {
    faceId: string;
    headingDeg: number;
    requested: boolean;
    widthM: number;
    heightM: number;
    /** Share of 25 points on the face (5 across × 5 up) at least one view sees, and with masks, at least one view owns. */
    coveredFraction: number;
    ownedFraction?: number;
    views: Array<{ index: number; seenFraction: number; ownedFraction?: number }>;
    bestViewIndex?: number;
    /** Why no view was aimed at this face (the planner's reason). */
    skipped?: string;
}

export interface StreetViewSurveyResult {
    views: SurveyedViewResult[];
    refusals: SurveyRefusal[];
    fetchFailures: SurveyFetchFailure[];
    coverage: FaceCoverage[];
    unmatchedFaceHeadingsDeg: Array<{ headingDeg: number; reason: string }>;
    discovery: { panosFound: number; metadataCalls: number; cachedCalls: number; rejectedNotGoogle: number; rejectedRefused: number };
    registration: { frames: number; panos: number; edge?: string; joint?: { chosen: string; reason: string }; error?: string };
    elapsedMs: number;
}

// ---------------------------------------------------------------------------------------------------------------------
// the survey
// ---------------------------------------------------------------------------------------------------------------------

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;


/** Heading, elevation (up positive) and roll of a camera basis. */
export function cameraAngles(cam: Pick<FrameCamera, 'fwd' | 'up' | 'right'>): { headingDeg: number; elevationDeg: number; rollDeg: number } {
    const f = cam.fwd;
    const headingDeg = ((Math.atan2(f[0], -f[2]) / DEG) + 360) % 360;
    const elevationDeg = Math.asin(Math.max(-1, Math.min(1, f[1]))) / DEG;
    // the level right axis of this forward; roll is how far the camera's right axis dips below it
    const lr = [-f[2], 0, f[0]], l = Math.hypot(lr[0], lr[2]) || 1;
    const levelRight = [lr[0] / l, 0, lr[2] / l];
    const cosR = cam.right[0] * levelRight[0] + cam.right[2] * levelRight[2];
    const rollDeg = Math.atan2(-cam.right[1], cosR) / DEG;
    return { headingDeg: r3(headingDeg), elevationDeg: r3(elevationDeg), rollDeg: r3(rollDeg) };
}

/** The 25 face points (5 across × 5 up, 0.3 m proud of the face). */
function facePoints(face: SurveyFaceTarget, groundY: number): Vec3[] {
    const t: Vec3 = [-face.outward[2], 0, face.outward[0]];
    const pts: Vec3[] = [];
    for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) {
        const along = (i / 4 - 0.5) * face.widthM * 0.9;
        const y = groundY + face.heightM * (0.1 + 0.8 * (j / 4));
        pts.push([face.centre[0] + t[0] * along + face.outward[0] * 0.3, y, face.centre[2] + t[2] * along + face.outward[2] * 0.3]);
    }
    return pts;
}

/** Coverage of each face by the registered views: points in the frame, on the face's outward side, not hidden over the surface model. */
export function faceCoverage(
    faces: SurveyFaceTarget[], requested: Set<string>, cams: Array<{ index: number; cam: FrameCamera; owner?: Uint8Array }>,
    site: Pick<SurveySite, 'structure' | 'ground' | 'unmaskedTop'>, skipped: Array<{ faceId: string; reason: string }>
): FaceCoverage[] {
    return faces.map(face => {
        const pts = facePoints(face, site.structure.groundY);
        const seenAny = new Uint8Array(pts.length), ownedAny = new Uint8Array(pts.length);
        const anyMask = cams.some(c => c.owner);
        const views: FaceCoverage['views'] = [];
        for (const { index, cam, owner } of cams) {
            let seen = 0, owned = 0;
            pts.forEach((p, k) => {
                const toEye: Vec3 = [cam.eye[0] - p[0], cam.eye[1] - p[1], cam.eye[2] - p[2]];
                if (toEye[0] * face.outward[0] + toEye[2] * face.outward[2] <= 0) return;
                const q = projectToFrame(cam, p);
                if (!q || q[0] < 0 || q[1] < 0 || q[0] >= cam.width || q[1] >= cam.height) return;
                if (pointHidden(cam.eye as Vec3, p, site.structure, site.ground, site.unmaskedTop)) return;
                seen++; seenAny[k] = 1;
                if (owner && owner[Math.floor(q[1]) * cam.width + Math.floor(q[0])]) { owned++; ownedAny[k] = 1; }
            });
            if (seen) views.push({ index, seenFraction: r3(seen / pts.length), ...(owner ? { ownedFraction: r3(owned / pts.length) } : {}) });
        }
        views.sort((a, b) => b.seenFraction - a.seenFraction || a.index - b.index);
        const skip = skipped.find(s => s.faceId === face.faceId);
        return {
            faceId: face.faceId, headingDeg: r3(face.headingDeg), requested: requested.has(face.faceId), widthM: r3(face.widthM), heightM: r3(face.heightM),
            coveredFraction: r3(seenAny.reduce((s, v) => s + v, 0) / pts.length),
            ...(anyMask ? { ownedFraction: r3(ownedAny.reduce((s, v) => s + v, 0) / pts.length) } : {}),
            views, ...(views.length ? { bestViewIndex: views[0].index } : {}), ...(skip ? { skipped: skip.reason } : {})
        };
    });
}

/** The file name `streetview_grounding_image` gives an image (heading, the API's pitch and fov, rounded). */
export function groundingImageFileName(panoId: string, headingDeg: number, apiPitchDeg: number, fovDeg: number, mimeType: string): string {
    const ext = mimeType.includes('png') ? 'png' : 'jpg';
    return `${panoId.replace(/[^A-Za-z0-9_-]/g, '_')}_h${Math.round(headingDeg)}_p${Math.round(apiPitchDeg)}_f${Math.round(fovDeg)}.${ext}`;
}

function writeMask(file: string, mask: Uint8Array, W: number, H: number): number {
    const g = new Uint8Array(W * H);
    let n = 0;
    for (let i = 0; i < g.length; i++) if (mask[i]) { g[i] = 255; n++; }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, encodePng(W, H, g, 1));
    return n;
}

/** Runs the survey of `site` (see the file comment). Throws the typed errors above. */
export async function runStreetViewSurvey(site: SurveySite, options: StreetViewSurveyOptions, deps: StreetViewSurveyDeps): Promise<StreetViewSurveyResult> {
    const started = Date.now();
    const sv = deps.streetView;
    const missing = missingCredentials(sv);
    if (missing) throw new StreetViewSurveyCredentialsError(missing);
    const maxViews = Math.max(1, Math.min(STREETVIEW_SURVEY_MAX_VIEWS, Math.floor(options.maxViews ?? STREETVIEW_SURVEY_DEFAULT_VIEWS)));
    const progress = deps.onProgress ?? (() => undefined);

    const allFaces = structureFaces(site.structure);
    const { faces, unmatched } = facesToCover(allFaces, options.faceHeadingsDeg);
    if (!faces.length) throw new StreetViewSurveyNoCoverageError(`none of the requested faces is a facade of the structure (${unmatched.map(u => u.reason).join('; ')})`);

    progress('finding Google Street View panoramas around the structure');
    const found = await discoverPanos(site.origin, facadeGeometry(site.structure), sv, deps.signal, site.structure.centroid);
    const refused = knownRefusals(sv);
    const panos = found.panos.filter(p => !refused.has(p.panoId));
    const discovery = { panosFound: found.panos.length, metadataCalls: found.metadataCalls, cachedCalls: found.cachedCalls, rejectedNotGoogle: found.rejectedNotGoogle, rejectedRefused: found.rejectedRefused };
    const plan = planSurveyViews(panos, faces, site, maxViews);
    if (!plan.views.length) {
        throw new StreetViewSurveyNoCoverageError(found.panos.length
            ? `${found.panos.length} Google panoramas were found nearby, but none looks at ${faces.length === 1 ? 'the face' : 'any of the faces'} asked for from its outward side (${plan.skipped.map(s => s.reason).join('; ')})`
            : `no Google-captured Street View panorama was found around the structure (${found.rejectedNotGoogle} user photospheres, which the grounding API does not serve)`, { panosFound: found.panos.length });
    }

    progress(`requesting ${plan.views.length} view${plan.views.length === 1 ? '' : 's'} through the Maps Imagery Grounding API`);
    const got = await fetchWithRefusalRetry(plan, faces, sv, deps.signal, progress);
    if (deps.signal?.aborted) throw deps.signal.reason ?? new Error('stopped');
    if (!got.images.length) {
        throw new StreetViewSurveyNoCoverageError(`every image failed or was refused (${[...got.refusals.map(r => `${r.panoId}: ${r.error}`), ...got.failures.map(f => `${f.panoId}: ${f.error}`)].slice(0, 3).join('; ')})`,
            { panosFound: found.panos.length, refusals: got.refusals, fetchFailures: got.failures });
    }

    // registration: edges, then jointly, against the full tile mesh (the evidence stage's job, no prior, no box pairs)
    let reg: PanoRegistrationOutcome | undefined;
    let regError: string | undefined;
    const held: HeldImage[] = got.images.map(im => ({ id: im.id, bytes: im.bytes, widthPx: im.widthPx, heightPx: im.heightPx, view: im.view }));
    try {
        reg = await (deps.register ?? runPanoRegistrationOffThread)({ images: held, meshFiles: site.tileMeshFiles, correspondences: [], faces: [] }, { signal: deps.signal, log: progress });
    } catch (err) {
        if (deps.signal?.aborted) throw err;
        regError = err instanceof Error ? err.message : String(err);
        progress(`registration failed (${regError}); the nominal poses stand`);
    }
    const registration = reg?.registration;

    fs.mkdirSync(options.outDir, { recursive: true });
    const rel = (p: string) => path.relative(options.workspaceRoot, p);
    const views: SurveyedViewResult[] = got.images.map((im, index) => {
        const v = im.view as SurveyView;
        const correction: PoseCorrection | undefined = registration?.corrections.get(v.panoId);
        const cam = castCamera({ eye: v.eye, headingDeg: v.headingDeg, pitchDeg: v.pitchDeg, fovDeg: v.fovDeg, widthPx: im.widthPx, heightPx: im.heightPx, ...(correction ? { correction } : {}) });
        const apiPitch = groundingPitchForElevation(v.pitchDeg);
        const file = path.join(options.outDir, groundingImageFileName(v.panoId, v.headingDeg, apiPitch, v.fovDeg, im.mimeType));
        // the bytes exactly as the grounding API returned them
        fs.writeFileSync(file, im.bytes);
        const angles = cameraAngles(cam);
        const g = scanToGeodetic(site.origin, cam.eye[0], cam.eye[1], cam.eye[2]);
        const per = registration?.perPano.find(p => p.panoId === v.panoId);
        const edge = reg?.edge?.panos.find(p => p.panoId === v.panoId);
        const joint = reg?.joint?.panos.find(p => p.panoId === v.panoId);
        const regWidth = Math.min(im.widthPx, EDGE_REG_MAX_WIDTH_PX);
        let method = 'nominal', residualPx: number | null = null, atWidth: number | null = null, reason: string;
        if (per?.method === 'joint' && joint) {
            method = reg!.joint!.chosen === 'joint+warp' ? 'joint+warp' : 'joint';
            // the held-out fit of the kept poses: the tile mesh's own edges against this pano's photo edges (chamfer), else the
            // median cross-view match residual of the pano
            const fit = method === 'joint+warp' ? reg!.joint!.fit.warped : reg!.joint!.fit.joint;
            const clay = (fit?.views ?? []).filter(fv => fv.panoId === v.panoId).map(fv => fv.clayChamferPx).filter((x): x is number => x !== null).sort((x, y) => x - y);
            if (clay.length) {
                residualPx = clay[clay.length >> 1]; atWidth = Math.min(im.widthPx, JOINT_METRIC_WIDTH_PX);
                reason = `${reg!.joint!.reason}; residual: the tile mesh's edges against this photo's edges (held-out chamfer)`;
            } else {
                residualPx = joint.medianPx; atWidth = joint.medianPx === null ? null : JOINT_WIDTHS_PX[JOINT_WIDTHS_PX.length - 1];
                reason = `${reg!.joint!.reason}; residual: the median cross-view match residual of this pano${joint.medianPx === null ? ' (no match held, not measured)' : ''}`;
            }
        } else if (per?.method === 'edges' && edge) {
            method = 'edges';
            residualPx = edge.edgeResidualPx.edge; atWidth = regWidth;
            reason = `${edge.reason}; residual: median silhouette/edge distance against the tile mesh`;
        } else {
            residualPx = edge?.edgeResidualPx.prior ?? null; atWidth = edge ? regWidth : null;
            reason = regError ? `registration failed (${regError}); the nominal pose stands, good to about ±2 m and ±2°`
                : edge ? `${edge.reason}; the nominal pose stands (residual at the nominal pose shown)`
                : (reg && reg.frames < 2) ? 'one image only: the registration needs two or more; the nominal pose stands, good to about ±2 m and ±2°'
                : 'not registered; the nominal pose stands, good to about ±2 m and ±2°';
        }
        const c: PoseCorrection = correction ?? { dx: 0, dy: 0, dz: 0, dyawDeg: 0, dpitchDeg: 0, drollDeg: 0 };
        return {
            index, panoId: v.panoId, ...(v.date ? { captureMonth: v.date.slice(0, 7) } : {}), ...(v.copyright ? { copyright: v.copyright } : {}),
            faceId: v.faceId, faceHeadingDeg: v.facadeHeadingDeg,
            imagePath: rel(file), mimeType: im.mimeType, widthPx: im.widthPx, heightPx: im.heightPx, contentSha256: im.sha256,
            request: { headingDeg: v.headingDeg, pitchDeg: apiPitch, elevationDeg: v.pitchDeg, fovDeg: v.fovDeg, aspectRatio: v.aspectRatio },
            camera: {
                position: { x: r3(cam.eye[0]), y: r3(cam.eye[1]), z: r3(cam.eye[2]) },
                geodetic: { lat: Math.round(g.lat * 1e8) / 1e8, lng: Math.round(g.lng * 1e8) / 1e8, ellipsoidalHeightM: r3(g.alt) },
                orientation: {
                    headingDeg: angles.headingDeg, elevationDeg: angles.elevationDeg, apiPitchDeg: r3(groundingPitchForElevation(angles.elevationDeg)), rollDeg: angles.rollDeg,
                    right: cam.right.map(r6) as Vec3, up: cam.up.map(r6) as Vec3, forward: cam.fwd.map(r6) as Vec3
                },
                intrinsics: {
                    fx: r3(groundingFocalPx(v.fovDeg, im.widthPx, im.heightPx)), fy: r3(groundingFocalPx(v.fovDeg, im.widthPx, im.heightPx)), cx: cam.cx, cy: cam.cy,
                    widthPx: im.widthPx, heightPx: im.heightPx, requestedFovDeg: v.fovDeg, horizontalFovDeg: r3(groundingHorizontalFovDeg(v.fovDeg, im.widthPx, im.heightPx))
                },
                correction: { dxM: r3(c.dx), dyM: r3(c.dy), dzM: r3(c.dz), dyawDeg: r3(c.dyawDeg), dpitchDeg: r3(c.dpitchDeg), drollDeg: r3(c.drollDeg), referenceHeadingDeg: r3(c.referenceHeadingDeg ?? v.headingDeg) }
            },
            registration: {
                method, residualPx, residualAtWidthPx: atWidth, residualImagePx: residualPx !== null && atWidth ? r3(residualPx * im.widthPx / atWidth) : null,
                residualM: per?.edgeResidualM ?? null, reason, warpKept: !!registration?.warps?.has(v.panoId),
                ...(method.startsWith('joint') && joint ? { crossViewMatchPx: joint.medianPx } : {})
            }
        };
    });

    // ownership and occluder masks (the texture pass's step), optional
    const owners = new Map<number, Uint8Array>();
    if (options.ownershipMasks) {
        progress(`cutting the structure out of ${views.length} view${views.length === 1 ? '' : 's'}`);
        const pviews = got.images.map(im => projectionViewFromRegistered({
            view: { panoId: im.view.panoId, eye: im.view.eye, headingDeg: im.view.headingDeg, pitchDeg: im.view.pitchDeg, fovDeg: im.view.fovDeg, widthPx: im.widthPx, heightPx: im.heightPx },
            jpeg: im.bytes, ...(registration ? { registration } : {}), ...(im.view.date ? { captureDate: im.view.date } : {})
        }));
        const context = sceneToRenderMesh(site.tileMeshFiles.filter(f => fs.existsSync(f)).flatMap(f => readGlbScene(f)));
        const maskDir = path.join(options.outDir, 'masks');
        const masks = new Map<number, { owner: Uint8Array; occluders: Uint8Array }>();
        const own = await ownViews({
            views: pviews, structure: site.structureMesh, ...(context.indices.length ? { context } : {}), segment: deps.segmenter ?? objectSegmenter(),
            ...(options.target ? { target: options.target } : {}), signal: deps.signal, onProgress: progress, onMasks: (k, m) => masks.set(k, m)
        });
        own.records.forEach((rec, k) => {
            const view = views[k], W = view.widthPx, H = view.heightPx;
            const stem = path.basename(view.imagePath).replace(/\.[a-z]+$/i, '');
            const m = masks.get(k);
            if (rec.status === 'segmented' && m) {
                const ownerFile = path.join(maskDir, `${stem}_owner.png`), occFile = path.join(maskDir, `${stem}_occluders.png`);
                const ownerPixels = writeMask(ownerFile, m.owner, W, H), occluderPixels = writeMask(occFile, m.occluders, W, H);
                owners.set(k, m.owner);
                view.ownership = { status: rec.status, ...(rec.iou !== undefined ? { iou: rec.iou } : {}), ownerMaskPath: rel(ownerFile), occluderMaskPath: rel(occFile), ownerPixels, occluderPixels };
            } else {
                view.ownership = { status: rec.status, ...(rec.reason ? { reason: rec.reason } : {}), ...(rec.iou !== undefined ? { iou: rec.iou } : {}) };
            }
        });
    }

    const requested = new Set(faces.map(f => f.faceId));
    const cams = views.map(v => ({
        index: v.index,
        cam: castCamera({ ...(got.images[v.index].view), widthPx: v.widthPx, heightPx: v.heightPx, ...(registration?.corrections.get(v.panoId) ? { correction: registration.corrections.get(v.panoId)! } : {}) }),
        ...(owners.has(v.index) ? { owner: owners.get(v.index)! } : {})
    }));
    const coverage = faceCoverage(allFaces, requested, cams, site, plan.skipped);
    return {
        views, refusals: got.refusals, fetchFailures: got.failures, coverage, unmatchedFaceHeadingsDeg: unmatched, discovery,
        registration: {
            frames: reg?.frames ?? 0, panos: reg?.panos ?? 0,
            ...(reg?.edge ? { edge: `${reg.edge.panos.filter(p => p.chosen === 'edges').length} of ${reg.edge.panos.length} panos took their edge pose` } : {}),
            ...(reg?.joint ? { joint: { chosen: reg.joint.chosen, reason: reg.joint.reason } } : {}),
            ...(regError ? { error: regError } : {})
        },
        elapsedMs: Date.now() - started
    };
}

// ---------------------------------------------------------------------------------------------------------------------
// the site from the staged caches
// ---------------------------------------------------------------------------------------------------------------------

/** The triangles of the scan standing on the structure's cells (its footprint grown by one cell) above the street (0.3 m), tile frame. */
export function cropScanToStructure(scan: ScanMesh, structure: Pick<StructurePickResult, 'cells' | 'groundY'>): RenderMesh3D {
    const keep = (x: number, z: number) => {
        const cx = Math.floor(x), cz = Math.floor(z);
        for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) if (structure.cells.has(`${cx + dx},${cz + dz}`)) return true;
        return false;
    };
    const src = scan.mesh, idx: number[] = [];
    for (let t = 0; t < scan.triCount; t++) {
        const cx = scan.triCentroid[t * 3], cy = scan.triCentroid[t * 3 + 1], cz = scan.triCentroid[t * 3 + 2];
        if (cy > structure.groundY + 0.3 && keep(cx, cz)) idx.push(src.indices[t * 3], src.indices[t * 3 + 1], src.indices[t * 3 + 2]);
    }
    return { vertices: src.vertices, indices: Uint32Array.from(idx) };
}

/** Share of a mesh's footprint cells (1 m) that lie on the structure's cells. */
export function footprintOverlap(mesh: RenderMesh3D, cells: Set<string>): number {
    const mine = new Set<string>();
    for (let i = 0; i < mesh.vertices.length; i += 3) mine.add(`${Math.floor(mesh.vertices[i])},${Math.floor(mesh.vertices[i + 2])}`);
    if (!mine.size) return 0;
    let on = 0;
    for (const c of mine) if (cells.has(c)) on++;
    return on / mine.size;
}

export interface SurveySiteRequest {
    /** A place name or address (geocoded through the staged cache). */
    query?: string;
    lat?: number;
    lng?: number;
    /** A GLB of the structure in the staged tile frame of the same place (x east, y up, z south, origin at the place). */
    structureGlbPath?: string;
}

/**
 * The structure and its street, from the staged caches: the geocode (30 days), the request-sized extraction at the same
 * keys the staged build uses (7 days), the canopy mask and vector footprints, and the structure pick. With a structure
 * GLB the pick is the structure that mesh stands on.
 */
export async function prepareSurveySite(req: SurveySiteRequest, deps: StagedLocationDeps, io: { signal?: AbortSignal; onProgress?: (m: string) => void } = {}): Promise<SurveySite & { place: ResolvedPlace; extraction: StagedExtraction }> {
    const cache = deps.cache, now = Date.now;
    let place: ResolvedPlace;
    if (Number.isFinite(req.lat) && Number.isFinite(req.lng)) {
        place = { lat: req.lat!, lng: req.lng!, formattedAddress: req.query?.trim() || `${req.lat!.toFixed(6)}, ${req.lng!.toFixed(6)}` };
    } else {
        const query = (req.query ?? '').trim();
        const key = stageKey('geocode/v1', query.toLowerCase().replace(/\s+/g, ' '));
        const hit = cache.get<ResolvedPlace>('resolve', key);
        if (hit && now() - hit.builtAtMs < GEOCODE_TTL_MS) place = hit.value;
        else place = (await cache.run('resolve', key, async () => ({ value: await deps.geocode(query, io.signal) }), { bypass: true })).value;
    }
    const extractCached = async (radiusM: number): Promise<StagedExtraction> => {
        const key = stageKey('extract/v2', place.lat.toFixed(6), place.lng.toFixed(6), Math.round(radiusM));
        const inEntry = (dir: string, v: StagedExtraction): StagedExtraction => ({ ...v, texturedGlb: path.join(dir, v.texturedGlb), geometryGlb: path.join(dir, v.geometryGlb) });
        const hit = cache.get<StagedExtraction>('tiles', key);
        if (hit && now() - hit.builtAtMs < EXTRACTION_TTL_MS) {
            const v = inEntry(hit.dir, hit.value);
            if (fs.existsSync(v.texturedGlb) && fs.existsSync(v.geometryGlb)) return v;
        }
        const entry = await cache.run('tiles', key, async dir => {
            const x = await deps.extract({ lat: place.lat, lng: place.lng, radiusM, outDir: dir, place, signal: io.signal, onProgress: io.onProgress });
            return { value: { ...x, texturedGlb: path.relative(dir, x.texturedGlb), geometryGlb: path.relative(dir, x.geometryGlb) } };
        }, { bypass: true });
        return inEntry(entry.dir, entry.value);
    };
    const sizing = await sizeExtraction<StagedExtraction>({
        extract: extractCached,
        ...(deps.vegetation.canopy ? { canopy: async (tile: string) => (await deps.vegetation.canopy!({ tilePath: tile, signal: io.signal })).mask } : {}),
        ...(deps.vectorEvidence ? { vector: async (radiusM: number) => evidenceLookup(await deps.vectorEvidence!({ lat: place.lat, lng: place.lng, radiusM }), radiusM) } : {}),
        ...(io.onProgress ? { onProgress: io.onProgress } : {}), ...(io.signal ? { signal: io.signal } : {})
    });
    if (sizing.sizedTo !== 'structure' || !sizing.structure || !sizing.ground || !sizing.scan || !sizing.unmaskedTop) {
        throw new StreetViewSurveyNoStructureError(sizing.notes.map(n => n.reason).join('; ') || `no structure could be isolated at ${place.formattedAddress}`);
    }
    let structure = sizing.structure, ground = sizing.ground;
    let structureMesh: RenderMesh3D, structureMeshSource: SurveySite['structureMeshSource'];
    if (req.structureGlbPath) {
        if (!fs.existsSync(req.structureGlbPath)) throw new StreetViewSurveyNoStructureError(`the structure GLB ${req.structureGlbPath} does not exist`);
        structureMesh = sceneToRenderMesh(readGlbScene(req.structureGlbPath));
        structureMeshSource = 'given';
        if (footprintOverlap(structureMesh, structure.cells) < 0.3) {
            // the mesh stands on another structure than the one at the place: pick the one it stands on
            let sx = 0, sz = 0;
            const n = structureMesh.vertices.length / 3;
            for (let i = 0; i < structureMesh.vertices.length; i += 3) { sx += structureMesh.vertices[i]; sz += structureMesh.vertices[i + 2]; }
            let g = buildGroundModel(sizing.scan, { cellMeters: 1, ...(sizing.canopy ? { exclude: canopyLookup(sizing.canopy) } : {}), ...(sizing.vector ? { water: sizing.vector.waterAt, road: sizing.vector.roadAt } : {}) });
            let masked = 0;
            if (sizing.canopy) { const m = maskCanopy(g, sizing.canopy); g = m.masked; masked = m.cells; }
            const repick = n ? pickStructure(sizing.scan, g, { anchor: { x: sx / n, z: sz / n }, canopyCellsMasked: masked, ...(sizing.vector ? { footprints: { buildingAt: sizing.vector.buildingAt, buildings: sizing.vector.raster.buildings } } : {}) }) : undefined;
            if (!repick || footprintOverlap(structureMesh, repick.cells) < 0.3) {
                throw new StreetViewSurveyNoStructureError(`the structure GLB does not stand on a structure of the extraction at ${place.formattedAddress}; it must be in the staged tile frame of that place (x east, y up, z south, metres)`);
            }
            structure = repick; ground = g;
        }
    } else {
        structureMesh = cropScanToStructure(sizing.scan, structure);
        structureMeshSource = 'scan-crop';
    }
    return {
        place, extraction: sizing.extraction,
        origin: { lat: place.lat, lng: place.lng, heightMeters: sizing.extraction.originEllipsoidalHeightM },
        label: place.formattedAddress, structure, ground, unmaskedTop: sizing.unmaskedTop, tileMeshFiles: [sizing.extraction.geometryGlb],
        structureMesh, structureMeshSource
    };
}

// ---------------------------------------------------------------------------------------------------------------------
// the tool
// ---------------------------------------------------------------------------------------------------------------------

export const STREETVIEW_SURVEY_DECLARATION: ToolDeclaration = {
    name: STREETVIEW_SURVEY_TOOL_NAME,
    description:
        'Survey one real structure with Google Street View: finds Google-captured panoramas around it, takes wide views of the faces asked for through the Maps Imagery ' +
        'Grounding API (redacted images, permitted for generative use; a pano the API refuses is replaced by the next eligible one and reported), registers every view ' +
        'against the Google 3D Tiles mesh (silhouette/edge registration, then jointly across views), and returns per view the pano id, capture month, the registered ' +
        'camera (position in the tile frame and as lat/lng, heading, elevation, the API pitch where POSITIVE looks down, roll, and pinhole intrinsics with ' +
        'fx = fy = 960 / tan(fov / 2) at full size), the registration method and residual, and the image path; plus refusals and coverage per face. Optionally cuts the ' +
        'structure out of each view (ownership mask) with what stands in front of it (occluder mask). Uses the same caches as google_3d_tiles_get_clay, so a place already ' +
        'built is not downloaded again. Images are saved exactly as the API returned them under build/streetview-grounding/.',
    parameters: {
        type: 'OBJECT',
        properties: {
            query: { type: 'STRING', description: 'The place: a name or address (e.g. "Haughwout Building, 488 Broadway, New York"). Or give lat and lng.' },
            lat: { type: 'NUMBER', description: 'Latitude of the structure (with lng, instead of query).' },
            lng: { type: 'NUMBER', description: 'Longitude of the structure (with lat, instead of query).' },
            structureGlbPath: { type: 'STRING', description: 'Optional GLB of the structure in the staged tile frame of the same place (as google_3d_tiles_get_clay writes it). Without it the structure is isolated from the 3D Tiles here.' },
            maxViews: { type: 'NUMBER', description: `Most views to fetch (default ${STREETVIEW_SURVEY_DEFAULT_VIEWS}, at most ${STREETVIEW_SURVEY_MAX_VIEWS}): one wide view per face first, then more views of the faces in turn from other panoramas.` },
            faceHeadingsDeg: { type: 'ARRAY', items: { type: 'NUMBER' }, description: 'Outward compass headings (degrees clockwise from north) of the faces to cover, e.g. [270] for the west face. Default: every facade of the structure.' },
            ownershipMasks: { type: 'BOOLEAN', description: 'Also cut the structure out of each view and write its ownership and occluder masks (PNG, 255 = the structure / what stands in front of it). Default false.' }
        }
    }
};

function asNumbers(v: unknown): number[] | undefined {
    if (!Array.isArray(v)) return undefined;
    const out = v.map(Number).filter(Number.isFinite).map(h => ((h % 360) + 360) % 360);
    return out.length ? out : undefined;
}

export const streetviewSurveyHandler: ToolHandler = async (args, ctx) => {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    const lat = typeof args.lat === 'number' ? args.lat : Number.NaN, lng = typeof args.lng === 'number' ? args.lng : Number.NaN;
    const hasCoords = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
    if (!query && !hasCoords) throw new Error('streetview_survey needs a query (a place name or address), or lat and lng.');
    const glbArg = typeof args.structureGlbPath === 'string' ? args.structureGlbPath.trim() : '';
    const structureGlbPath = glbArg ? (path.isAbsolute(glbArg) ? glbArg : path.resolve(ctx.workspaceRoot, glbArg)) : undefined;
    const report = (m: string) => ctx.reportProgress?.(m);

    const stagedDeps = await createStagedLocationDeps(stagedWorkspaceRoot(), { signal: ctx.signal });
    const sv = stagedDeps.streetView ?? {};
    // the credentials first: an extraction is not worth downloading for a survey that cannot fetch an image
    const missing = missingCredentials(sv);
    if (missing) throw new StreetViewSurveyCredentialsError(missing);
    const site = await prepareSurveySite({ ...(query ? { query } : {}), ...(hasCoords ? { lat, lng } : {}), ...(structureGlbPath ? { structureGlbPath } : {}) }, stagedDeps, { signal: ctx.signal, onProgress: report });
    const vision = stagedDeps.vision && 'client' in stagedDeps.vision ? stagedDeps.vision : undefined;
    const ownership = args.ownershipMasks === true;
    const result = await runStreetViewSurvey(site, {
        maxViews: typeof args.maxViews === 'number' ? args.maxViews : undefined,
        faceHeadingsDeg: asNumbers(args.faceHeadingsDeg),
        ownershipMasks: ownership,
        // with a vision model the segmenter finds the structure by what it is (and cuts out occluders), as the texture pass does
        ...(ownership && vision ? { target: query || site.label } : {}),
        outDir: path.join(ctx.workspaceRoot, STREETVIEW_IMAGE_DIR),
        workspaceRoot: ctx.workspaceRoot
    }, {
        streetView: { ...sv, refusedPanos: sv.refusedPanos ?? new Map<string, string>() },
        ...(ownership ? { segmenter: objectSegmenter(vision ? { modelSource: { getGenAIClient: async () => vision.client, getModelCandidates: () => vision.candidates } } : {}) } : {}),
        signal: ctx.signal, onProgress: report
    });
    const registered = result.views.filter(v => v.registration.method !== 'nominal').length;
    const covered = result.coverage.filter(c => c.requested);
    const summary = `Street View survey of ${site.label}: ${result.views.length} view${result.views.length === 1 ? '' : 's'} (© Google), ${registered} registered against the 3D Tiles` +
        `${result.refusals.length ? `, ${result.refusals.length} pano${result.refusals.length === 1 ? '' : 's'} refused by the grounding API` : ''}; ` +
        `faces covered: ${covered.map(c => `${Math.round(c.headingDeg)}° ${Math.round(c.coveredFraction * 100)}%`).join(', ')}. Images in ${STREETVIEW_IMAGE_DIR}/.`;
    return {
        resultPayload: {
            success: true,
            summary,
            place: { ...(query ? { query } : {}), resolvedAddress: site.place.formattedAddress, lat: site.place.lat, lng: site.place.lng },
            frame: {
                description: 'tile frame: x east, y up, z south, metres; origin at the place at the extraction origin\'s ellipsoidal height',
                origin: { lat: site.origin.lat, lng: site.origin.lng, ellipsoidalHeightM: r3(site.origin.heightMeters) }
            },
            structure: {
                seed: site.structure.seed, centroid: site.structure.centroid, heightM: r3(site.structure.heightM), areaM2: r3(site.structure.areaM2), groundY: r3(site.structure.groundY),
                facadeHeadingsDeg: site.structure.facadeHeadingsDeg.map(r3), footprintSource: site.structure.footprintSource, mesh: site.structureMeshSource,
                meshTriangles: site.structureMesh.indices.length / 3
            },
            ...result,
            imageHandling: `Images come only from the Maps Imagery Grounding API (Google captures; people and vehicles redacted) and are written exactly as returned, never re-encoded, under ${STREETVIEW_IMAGE_DIR}/ (as streetview_grounding_image does). Only pano ids, locations and dates are cached.`,
            attribution: 'Street View © Google'
        } as unknown as ToolResultPayload,
        summaryResult: summary
    };
};
