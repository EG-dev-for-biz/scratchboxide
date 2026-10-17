/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Inputs of the Street View projection bake from what the staged-location pipeline already holds: a registered
 * grounding view (RegView + the pano's PoseCorrection from registerPanos), its JPEG bytes in memory, and the scan mesh
 * the registration renders depth from (renderFrameDepth). Nothing is written to disk.
 *
 * Pose quality and pose sigma come from the registration's own measurements: a pano the registration set aside gets
 * quality 0 (not projected); otherwise quality = exp(-0.5 (rms / 2 m)^2) of its after-fit pair RMS (the registration's
 * overall RMS when the pano had no pairs; the nominal 2 m when there is no registration at all), and the pose sigma in
 * pixels at 1 m is fx times that RMS.
 */

import type { DecodedImage, DepthMap, PinholeCamera, ProjectionView } from '../../../common/spatial/texture-pass-contracts';
import { renderFrameDepth } from '../../spatial/StreetViewPoseRegistrar';
import type { RenderMesh3D } from '../../spatial/HeadlessMeshSilhouetteRenderer';
import type { Registration, RegView } from './pano-registration';
import { decodeJpegInMemory } from './photo-palette';
import { NOMINAL_POSE_UNCERTAINTY } from './streetview-evidence';
import { castCamera } from './survey-casting';

export interface RegisteredViewInput {
    view: RegView;
    /** Grounding JPEG bytes (redacted Street View), decoded in memory. */
    jpeg: Uint8Array;
    registration?: Registration;
    /** ISO capture date; a time of day is needed for solar de-lighting. */
    captureDate?: string;
    /** Redaction blur rects in pixels of this image, when the grounding output reports them. */
    redactionRects?: Array<[number, number, number, number]>;
}

/** The registration's residual for a pano, metres, or undefined when the pano was set aside. */
export function registeredResidualM(panoId: string, registration?: Registration): number | undefined {
    if (!registration) return NOMINAL_POSE_UNCERTAINTY.meters;
    if (registration.setAside.some((s) => s.panoId === panoId)) return undefined;
    const p = registration.perPano.find((q) => q.panoId === panoId);
    // a pano posed against the scan's edges is as good as its edge residual, not as the boxes it was not fitted to
    if (p?.method === 'edges' && p.edgeResidualM !== undefined && Number.isFinite(p.edgeResidualM)) return p.edgeResidualM;
    const rms = p && p.pairs > 0 && Number.isFinite(p.afterRmsM) ? p.afterRmsM : registration.afterRmsM;
    return Number.isFinite(rms) ? rms : NOMINAL_POSE_UNCERTAINTY.meters;
}

export function poseQualityFromResidual(residualM: number | undefined): number {
    if (residualM === undefined) return 0;
    return Math.exp(-0.5 * (residualM / NOMINAL_POSE_UNCERTAINTY.meters) ** 2);
}

/** Alignment search half-width, in pose sigmas, of a view posed against the scan's edges (its residual, not two of it). */
export const EDGE_POSE_ALIGN_SIGMAS = 1;

/** A ProjectionView of a registered grounding view; the camera is sized to the decoded image. */
export function projectionViewFromRegistered(input: RegisteredViewInput): ProjectionView {
    const frame = decodeJpegInMemory(input.jpeg);
    const image: DecodedImage = { width: frame.width, height: frame.height, rgba: frame.data };
    const camera = castCamera({ ...input.view, widthPx: frame.width, heightPx: frame.height });
    const residual = registeredResidualM(input.view.panoId, input.registration);
    return {
        panoId: input.view.panoId,
        camera,
        image,
        poseQuality: poseQualityFromResidual(residual),
        poseSigmaPx: residual === undefined ? 0 : camera.fx * residual,
        ...(input.registration?.perPano.find((p) => p.panoId === input.view.panoId)?.method === 'edges' ? { alignSigmas: EDGE_POSE_ALIGN_SIGMAS } : {}),
        captureDate: input.captureDate,
        redactionRects: input.redactionRects
    };
}

/** depthFor of the bake: the occluder mesh (scan plus fitted solid, tile frame) rendered from each view, cached per view. */
export function depthForMesh(mesh: RenderMesh3D): (view: { camera: PinholeCamera }) => DepthMap {
    const cache = new WeakMap<{ camera: PinholeCamera }, DepthMap>();
    return (view) => {
        let d = cache.get(view);
        if (!d) {
            d = { width: view.camera.width, height: view.camera.height, depthM: renderFrameDepth(mesh, view.camera) };
            cache.set(view, d);
        }
        return d;
    };
}
