/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Tier 1 of the staged-location texture pass: Street View projection bake (design section 4; contract
 * BakeStreetViewProjection in common/spatial/texture-pass-contracts.ts).
 *
 * For every atlas texel (world point P, normal n, size s from the UvAtlas) and every registered view k:
 *  1. project P with the view's pinhole camera; reject behind the camera or outside the image;
 *  2. visibility against the occluder depth (`depthFor`: scan plus fitted solid, camera-z metres): keep when
 *     z <= depth + (0.20 m + 0.02 z); drop within 3 px of a depth discontinuity, judged against the depth the texel's own
 *     tangent plane predicts at those pixels (so a tilted wall is not an edge and anything proud of it is);
 *  3. weight w = cos^2(incidence) * min(1, s / GSD) * poseQuality * edgeFeather * poseSigmaTerm, zero inside
 *     redaction rects and below cos 0.15; GSD = z / (fx cos) is the view's ground sample distance on the surface, so a
 *     view resolving finer than the texel gains nothing more; poseSigmaTerm = 1 / (1 + (sigma_m / 2 m)^2), sigma_m the pose error on the surface;
 *  4. de-light each view's samples (optional, needs a place and a capture time): divide by the solar irradiance E(n) of
 *     the view's own sun relative to its mean (AlgorithmicUvEngine's NOAA ephemeris + SH9 sky helpers), then after the blend
 *     lift shadows / compress highlights with the shared photogrammetric de-light function (delightLinearRgb);
 *  5. exposure: per-view log-gains by least squares over overlap texels, anchored per group to the median view, then
 *     the measured-palette gate (texel-exposure.ts);
 *  6. blend in linear RGB: per-texel normalised weights, Huber reweighting (CIE76 residual) at >= 3 views, then a 4-band
 *     Laplacian-stack seam blend of each view's residual against that mean (fine band with the sharp weights, coarser bands
 *     with Gaussian-spread weights, never across atlas charts), which leaves consistent views exactly at their mean and
 *     spreads any remaining disagreement smoothly instead of as a step at a weight boundary.
 *
 * Texels no view sees stay uncovered (alpha 0, confidence covered 0) for the next ladder rung; nothing is invented.
 * Every produced texel is labelled 'street-view-projection' / 'photo-inferred' with the pano ids that made it (one
 * provenance entry per distinct set of contributing panos). Images arrive decoded in memory and nothing is written.
 */

import type { Vec3 } from '../../../common/spatial/staged-location-contracts';
import {
    packConfidenceTexel,
    type BakedTexturePlanes, type ConfidencePlane, type DepthMap, type ProjectionBakeInput, type ProjectionView,
    type TexelProvenance, type TexturePassDegradation
} from '../../../common/spatial/texture-pass-contracts';
import { delightLinearPlane, PHOTOGRAMMETRIC_DELIGHT, TEXTURE_LIFT_CAP, type DelightPlaneReport } from '../../../common/spatial/photogrammetric-delight';
import { AlgorithmicUvEngine } from '../../spatial/AlgorithmicUvEngine';
import { refinePosesFromAlignment, type PanoRefinement, type PoseRefineOptions } from './texture-pose-refine';
import { blurWithinMaps, chartLocalGains, poissonBlendRegions, selectViewsPerRegion, type PoissonBlendOptions, type PoissonBlendReport, type RegionSelectOptions } from './texture-seams';
import { alignViewsPerChart, type AlignmentOptions, type AlignmentReport } from './texture-alignment';
import {
    SRGB_TO_LINEAR, deltaE00, linearToLab, linearToSrgb255, paletteGate, solveRelativeGains,
    type PaletteGateReport, type TexelSampleIndex, type ViewSamples
} from './texel-exposure';

export const PROJECTION_SOURCE = 'street-view-projection';
export const PROJECTION_LABEL = 'photo-inferred';
/** Depth beyond this is "nothing there" (PLATE_EMPTY_DEPTH is 1e9). */
const EMPTY_DEPTH = 1e8;

export interface ProjectionDelightOptions {
    latitude: number;
    longitude: number;
    /** Shared de-light numbers; defaults are applyPhotogrammetricDelightShader's. */
    shadowLift?: number;
    highlightCompress?: number;
    /** Layer-frame normal -> ENU (x east, y up, z south, the solar helper's frame). Identity by default (the tile frame is Y-up ENU). */
    layerToEnu?: (n: Vec3) => Vec3;
    /**
     * Cap of the shadow lift by local contrast (photogrammetric-delight.ts delightLinearPlane), so a genuinely dark
     * surface (a window opening) is not lifted toward grey. Default TEXTURE_LIFT_CAP (1.5 m, gain 2); false = uncapped.
     */
    liftCap?: { radiusM: number; contrastGain: number } | false;
}

export interface ProjectionBakeOptions {
    /** Edge feather width, px (weight ramps 0..1 over it from the image border). Default 6. */
    featherPx?: number;
    /** Incidence floor: views with cos below it are dropped. Default 0.15. */
    minCosIncidence?: number;
    /** Occlusion tolerance tol = baseM + perMeter * z. Default 0.20 m + 0.02 z. */
    depthToleranceBaseM?: number;
    depthTolerancePerMeter?: number;
    /** Distance to a depth discontinuity under which a sample is dropped, px. Default 3. */
    edgeGuardPx?: number;
    /**
     * Require the occluder to show a surface at the texel: drop a sample when the occluder depth at its pixel is empty
     * or farther than z + baseM + perMeter * z (the camera sees past the texel). Use with a scan-only occluder, so a
     * fitted face over an opening is not painted with the sky or the background seen through it. Off by default.
     */
    observedSurface?: { baseM: number; perMeter: number };
    /**
     * Widen the depth-edge guard to this share of the view's pose uncertainty in pixels at the texel's depth
     * (poseSigmaPx / z), capped at 64 px. Off by default (only edgeGuardPx).
     */
    poseEdgeGuardShare?: number;
    /** Huber threshold (CIE76 Delta E) and the view count it starts at. Default 10 and 3. */
    huberDeltaE?: number;
    huberMinViews?: number;
    /** Gaussian sigmas (texels) between the bands of the seam blend. Default [1, 2, 4, 12, 32]. Empty disables the band blend. */
    bandSigmasTexels?: number[];
    /**
     * One view per region instead of a per-texel weighted mean (texture-seams.ts): per (chart, view) exposure gains, then a
     * block MRF picks each region's view so boundaries run where the views agree; the band blend then blends the chosen
     * views at those boundaries only. Default on; false blends every view by weight (the old behaviour).
     */
    regionSelect?: boolean | RegionSelectOptions;
    /**
     * With one view per region: blend the regions in the gradient domain (texture-seams.ts poissonBlendRegions) instead of
     * the band blend, so a step between views is spread smoothly instead of shown. Default on; false uses the band blend.
     */
    poisson?: boolean | PoissonBlendOptions;
    /** Relative per-view exposure gains. Default true. */
    exposure?: boolean;
    /** Palette gate distance (CIEDE2000). Default 6. */
    paletteGateDeltaE?: number;
    /** Solar de-lighting and shadow lift; off unless given (a place is never assumed). */
    delight?: ProjectionDelightOptions;
    /**
     * Per-view, per-chart image alignment before blending (texture-alignment.ts): each view's projection of each chart
     * is moved by the image shift that best matches the other views' gradients, within the pose uncertainty. Default on;
     * false disables it.
     */
    align?: boolean | AlignmentOptions;
    /**
     * After the alignment, refine each pano's pose from its correspondences (texture-pose-refine.ts) and project and align
     * again from the refined poses. Default on (needs the alignment); false keeps the registered poses.
     */
    refinePose?: boolean | PoseRefineOptions;
    /** The photo-textured tile's linear RGB at a world point (the alignment's geometry-registered reference). */
    alignReference?: (position: Vec3, normal: Vec3) => Vec3 | undefined;
}

export type ProjectionBakeRequest = ProjectionBakeInput & { options?: ProjectionBakeOptions };

export interface ProjectionViewReport {
    panoId: string;
    samples: number;
    /** Linear gain per channel applied for exposure (relative solve and palette gate). */
    gain: Vec3;
    anchor: boolean;
    paletteGate?: PaletteGateReport;
    /** True when this view's samples were divided by its solar irradiance. */
    solarDelit: boolean;
}

export interface ProjectionBakeReport {
    /** Covered, non-gutter texels of the atlas (the ones projected). */
    targetTexels: number;
    /** Covered texels of the atlas, gutters included: the denominator of provenance coverage. */
    coveredTexels: number;
    bakedTexels: number;
    multiViewTexels: number;
    overlapPairs: number;
    views: ProjectionViewReport[];
    /**
     * Seam measurement: where neighbouring texels have different dominant views, the CIEDE2000 between those two views'
     * exposure-corrected colours (5 x 5 texel means) at the same place. Max and 95th percentile over all such boundary samples.
     */
    maxSeamDeltaE: number;
    p95SeamDeltaE: number;
    seamSamples: number;
    /**
     * The seam the output shows: across each boundary between dominant (chosen) views, CIEDE2000 between the final colour's
     * 5 x 5 means centred 2 texels back on either side (6 apart); `interiorP95DeltaE` is the same measure between neighbours inside one
     * view's region (the texture's own contrast), so a seam is invisible when its p95 is near that.
     */
    outputSeam: {
        p95DeltaE: number; maxDeltaE: number; samples: number; interiorP95DeltaE: number;
        /** The same across boundaries and inside regions on 9 x 9 means 10 texels apart: the low-frequency step a patch shows. */
        lowFreqP95DeltaE: number; lowFreqMedianDeltaE: number; lowFreqInteriorP95DeltaE: number; lowFreqInteriorMedianDeltaE: number;
    };
    /** One view per region (present when it ran): per-chart gains applied, MRF blocks labelled, label changes between neighbouring texels. */
    regions?: { chartGains: number; meanAbsLogGain: number; blocks: number; boundaryTexels: number; refinedTexels: number; sunShadedViews: number; /** Blocks left on a view that is in shadow there while another view is not. */ shadowedBlocks: number };
    /** The gradient-domain blend (present when it ran). */
    poisson?: PoissonBlendReport;
    /**
     * The second pose registration (present when it ran): surface RMS of the alignment's correspondences with the registered
     * and the refined poses, per pano, and the first pass's inter-view gradient NCC (the `alignment` report is then the
     * pass from the refined poses).
     */
    poseRefine?: {
        rmsBeforeM: number; rmsAfterM: number; points: number; applied: number; perPano: PanoRefinement[];
        firstPassGradNcc?: { before: number; after: number }; secondPassGradNcc?: { before: number; after: number };
        /** Whether the refined poses were kept (they must raise the views' agreement), and why not. */
        kept?: boolean; reason?: string;
    };
    /** The per-chart image alignment (present when it ran): shifts kept and the inter-view gradient NCC before and after. */
    alignment?: AlignmentReport;
    /** The shadow lift as applied: how much of it the local-contrast cap kept. Present when de-lit. */
    delight?: DelightPlaneReport;
    timingsMs: Record<string, number>;
}

export type ProjectionBakeResult = BakedTexturePlanes & { report: ProjectionBakeReport };

/**
 * Pose-uncertainty term of the weight, measured on the surface and saturating (Cauchy), never collapsing.
 *
 * sigma_px = poseSigmaPx / max(1, z) is the pose error in image pixels at the texel; times the view's ground sample
 * distance (z / (fx cos)) it is the shift on the surface in metres, ~ residual / cos. The design's exp(-(sigma_px / 3)^2)
 * measured that shift in image pixels, where the real ~1.3 m registration residual is 60 to 110 px at 20 m: every view's
 * term underflowed to ~0, so each single-view texel's confidence was ~0 and the tile transfer overwrote it. Here
 * term = 1 / (1 + (sigma_m / POSE_SIGMA_SCALE_M)^2) with POSE_SIGMA_SCALE_M = 2 m, the registration's pose prior sigma
 * (POSE_PRIOR_SIGMA.meters): a pose error equal to what a pano is expected to be off by halves the weight. Frontal, the live
 * 1.3 m residual gives 0.70; at 60 degrees incidence (2.6 m on the surface) 0.37; a 4 m error 0.20; the tail keeps the
 * relative ranking between views and the absolute confidence comparable with the tile's (capped at 0.5).
 */
export const POSE_SIGMA_SCALE_M = 2;
/** Least inter-view gradient NCC after the alignment for its correspondences to re-pose the views (texture-pose-refine.ts). */
export const MIN_NCC_FOR_POSE_REFINE = 0.35;
export function poseSigmaTerm(poseSigmaPx: number, z: number, gsdM: number): number {
    const sigmaM = (poseSigmaPx / Math.max(1, z)) * gsdM;
    if (!Number.isFinite(sigmaM)) return 0;
    return 1 / (1 + (sigmaM / POSE_SIGMA_SCALE_M) ** 2);
}

interface RawSamples { texel: number[]; rgb: number[]; logW: number[]; wAbs: number[]; x: number[]; y: number[] }

function checkAbort(signal?: AbortSignal): void {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Street View projection bake aborted');
}

function sampleLinear(view: ProjectionView, x: number, y: number, out: Float64Array): void {
    const { width: W, height: H, rgba } = view.image;
    const fx = Math.min(W - 1, Math.max(0, x - 0.5)), fy = Math.min(H - 1, Math.max(0, y - 0.5));
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1);
    const ax = fx - x0, ay = fy - y0;
    const i00 = (y0 * W + x0) * 4, i10 = (y0 * W + x1) * 4, i01 = (y1 * W + x0) * 4, i11 = (y1 * W + x1) * 4;
    for (let c = 0; c < 3; c++) {
        const top = SRGB_TO_LINEAR[rgba[i00 + c]] * (1 - ax) + SRGB_TO_LINEAR[rgba[i10 + c]] * ax;
        const bot = SRGB_TO_LINEAR[rgba[i01 + c]] * (1 - ax) + SRGB_TO_LINEAR[rgba[i11 + c]] * ax;
        out[c] = top * (1 - ay) + bot * ay;
    }
}

const smoothstep01 = (t: number): number => { const x = Math.min(1, Math.max(0, t)); return x * x * (3 - 2 * x); };

/** Steps 1 to 3 for one view: its visible samples with weights. */
function projectView(input: ProjectionBakeInput, view: ProjectionView, depth: DepthMap, opts: Required<Pick<ProjectionBakeOptions,
    'featherPx' | 'minCosIncidence' | 'depthToleranceBaseM' | 'depthTolerancePerMeter' | 'edgeGuardPx'>> & Pick<ProjectionBakeOptions, 'observedSurface' | 'poseEdgeGuardShare'>): RawSamples {
    const { atlas } = input;
    const cam = view.camera;
    const out: RawSamples = { texel: [], rgb: [], logW: [], wAbs: [], x: [], y: [] };
    if (!(view.poseQuality > 0)) return out;
    if (depth.width !== cam.width || depth.height !== cam.height) {
        throw new Error(`depthFor(${view.panoId}) returned ${depth.width}x${depth.height}, the camera is ${cam.width}x${cam.height}`);
    }
    if (view.image.width !== cam.width || view.image.height !== cam.height) {
        throw new Error(`image of ${view.panoId} is ${view.image.width}x${view.image.height}, the camera is ${cam.width}x${cam.height}`);
    }
    const n = atlas.width * atlas.height;
    const { covered, gutter, position, normal, sizeM } = atlas.texels;
    const W = cam.width, H = cam.height, D = depth.depthM;
    const rects = (view.redactionRects ?? []).map(([x0, y0, x1, y1]) => [x0 - 1, y0 - 1, x1 + 1, y1 + 1]);
    const col = new Float64Array(3);
    const g = opts.edgeGuardPx;
    /** Probe offsets of the depth-edge guard: the 4 axes and the 4 diagonals (a corner is diagonal from the pixel). */
    const EDGE_PROBES = [[g, 0], [-g, 0], [0, g], [0, -g], [g, g], [g, -g], [-g, g], [-g, -g]];
    const depthAt = (px: number, py: number): number => {
        const v = D[Math.min(H - 1, Math.max(0, py)) * W + Math.min(W - 1, Math.max(0, px))];
        return Number.isFinite(v) ? v : Infinity;
    };
    for (let t = 0; t < n; t++) {
        if (!covered[t] || gutter[t]) continue;
        const o = t * 3;
        const dx = position[o] - cam.eye[0], dy = position[o + 1] - cam.eye[1], dz = position[o + 2] - cam.eye[2];
        const z = dx * cam.fwd[0] + dy * cam.fwd[1] + dz * cam.fwd[2];
        if (z <= 1e-3) continue;
        const x = cam.cx + (cam.fx * (dx * cam.right[0] + dy * cam.right[1] + dz * cam.right[2])) / z;
        const y = cam.cy - (cam.fy * (dx * cam.up[0] + dy * cam.up[1] + dz * cam.up[2])) / z;
        const edgeDist = Math.min(x, y, W - x, H - y);
        if (!(edgeDist > 0)) continue;
        const dist = Math.hypot(dx, dy, dz);
        const cos = -(normal[o] * dx + normal[o + 1] * dy + normal[o + 2] * dz) / dist;
        if (cos < opts.minCosIncidence) continue;
        let redacted = false;
        for (const r of rects) if (x >= r[0] && x < r[2] && y >= r[1] && y < r[3]) { redacted = true; break; }
        if (redacted) continue;
        // visibility
        const px = Math.floor(x), py = Math.floor(y);
        const tol = opts.depthToleranceBaseM + opts.depthTolerancePerMeter * z;
        const dc = depthAt(px, py);
        if (dc < EMPTY_DEPTH && dc < z - tol) continue;
        // observed surface: the photo must show a surface where the texel is. When the occluder (the scan) at this pixel is
        // much farther than the texel, or there is nothing (sky), the camera sees PAST the texel: a face the fit placed
        // where the scan has no surface (an arch opening, a gap), and the pixel holds the sky or what stands behind it.
        if (opts.observedSurface) {
            const far = opts.observedSurface.baseM + opts.observedSurface.perMeter * z;
            if (!(dc < EMPTY_DEPTH) || dc > z + far) continue;
        }
        // depth-edge guard: the occluder depth at +-g px must be where the texel's own tangent plane predicts it
        // (so a steeply tilted wall is not an edge, and a thing standing proud of it is, whatever the angle)
        const cHas = dc < EMPTY_DEPTH;
        const nP = normal[o] * dx + normal[o + 1] * dy + normal[o + 2] * dz; // n . (P - eye)
        let edge = false;
        // with poseEdgeGuardShare the guard also covers a share of the pose uncertainty at this depth: a sample a
        // misregistered pose could carry across a silhouette may hold the background (seen at the arch's inner walls)
        const gp = opts.poseEdgeGuardShare ? Math.min(64, Math.round((opts.poseEdgeGuardShare * view.poseSigmaPx) / Math.max(1, z))) : 0;
        const probes = gp > g ? [[gp, 0], [-gp, 0], [0, gp], [0, -gp], [gp, gp], [gp, -gp], [-gp, gp], [-gp, -gp], ...EDGE_PROBES] : EDGE_PROBES;
        for (const [ex, ey] of probes) {
            const qx = px + ex, qy = py + ey;
            const dn = depthAt(qx, qy);
            const nHas = dn < EMPTY_DEPTH;
            if (nHas !== cHas) { edge = true; break; }
            if (!nHas) continue;
            const sx = (Math.min(W - 1, Math.max(0, qx)) + 0.5 - cam.cx) / cam.fx, sy = (Math.min(H - 1, Math.max(0, qy)) + 0.5 - cam.cy) / cam.fy;
            const rd = [cam.fwd[0] + sx * cam.right[0] - sy * cam.up[0], cam.fwd[1] + sx * cam.right[1] - sy * cam.up[1], cam.fwd[2] + sx * cam.right[2] - sy * cam.up[2]];
            const nd = normal[o] * rd[0] + normal[o + 1] * rd[1] + normal[o + 2] * rd[2];
            const expected = nd < -1e-6 ? nP / nd : Infinity; // camera z of the tangent plane along that pixel's ray
            if (!Number.isFinite(expected) || Math.abs(dn - expected) > opts.depthToleranceBaseM + opts.depthTolerancePerMeter * expected) { edge = true; break; }
        }
        if (edge) continue;
        // weight
        const gsd = z / (cam.fx * cos);
        const res = Math.min(1, sizeM[t] / gsd);
        const feather = smoothstep01(edgeDist / opts.featherPx);
        if (!(feather > 0)) continue;
        const logW = Math.log(cos * cos * res * view.poseQuality * feather * poseSigmaTerm(view.poseSigmaPx, z, gsd));
        if (!Number.isFinite(logW)) continue;
        sampleLinear(view, x, y, col);
        out.texel.push(t);
        out.rgb.push(col[0], col[1], col[2]);
        out.logW.push(logW);
        out.wAbs.push(Math.min(1, Math.exp(logW)));
        out.x.push(x); out.y.push(y);
    }
    return out;
}

/** The bake. Implements BakeStreetViewProjection; extra options ride on the input. */
export async function bakeStreetViewProjection(input: ProjectionBakeRequest): Promise<ProjectionBakeResult> {
    const t0 = Date.now();
    const timingsMs: Record<string, number> = {};
    const o = input.options ?? {};
    const opts = {
        featherPx: o.featherPx ?? 6,
        minCosIncidence: o.minCosIncidence ?? 0.15,
        depthToleranceBaseM: o.depthToleranceBaseM ?? 0.20,
        depthTolerancePerMeter: o.depthTolerancePerMeter ?? 0.02,
        edgeGuardPx: o.edgeGuardPx ?? 3,
        ...(o.observedSurface ? { observedSurface: o.observedSurface } : {}),
        ...(o.poseEdgeGuardShare ? { poseEdgeGuardShare: o.poseEdgeGuardShare } : {})
    };
    const huberK = o.huberDeltaE ?? 10, huberMin = o.huberMinViews ?? 3;
    const bandSigmas = o.bandSigmasTexels ?? [1, 2, 4, 12, 32];
    const { atlas } = input;
    const W = atlas.width, H = atlas.height, n = W * H;
    const { covered, gutter, mapIndex, normal } = atlas.texels;
    const degradations: TexturePassDegradation[] = [];
    let targetTexels = 0, coveredTexels = 0;
    for (let t = 0; t < n; t++) { if (covered[t]) coveredTexels++; if (covered[t] && !gutter[t]) targetTexels++; }

    // ---- 1-3: project every view; 3b: align; 3c: a second pose registration from the alignment's correspondences
    // (texture-pose-refine.ts), then project and align once more from the refined poses ---------------------------
    let views = input.views;
    let raw: RawSamples[] = [];
    let samples: ViewSamples[] = [];
    let logW: Float64Array[] = [];
    let alignment: AlignmentReport | undefined;
    let poseRefine: ProjectionBakeReport['poseRefine'];
    let pass0: { views: ProjectionView[]; raw: RawSamples[]; samples: ViewSamples[]; logW: Float64Array[]; alignment: AlignmentReport | undefined; degradations: TexturePassDegradation[] } | undefined;
    const passDegradations: TexturePassDegradation[] = [];
    for (let pass = 0; pass < 2; pass++) {
        passDegradations.length = 0;
        raw = [];
        const tProj = Date.now();
        for (const view of views) {
            checkAbort(input.signal);
            if (!(view.poseQuality > 0)) {
                passDegradations.push({ stage: 'bake-projection', reasonCode: 'pano_set_aside', layerKey: atlas.layerKey,
                    reason: `Pano ${view.panoId} has no usable registered pose (pose quality 0), so it was not projected.` });
                raw.push({ texel: [], rgb: [], logW: [], wAbs: [], x: [], y: [] });
                continue;
            }
            if (view.image.rgba.length !== view.image.width * view.image.height * 4 || view.image.width !== view.camera.width || view.image.height !== view.camera.height) {
                passDegradations.push({ stage: 'bake-projection', reasonCode: 'pano_image_invalid', layerKey: atlas.layerKey,
                    reason: `Pano ${view.panoId}'s image is not the ${view.camera.width}x${view.camera.height} RGBA its camera expects, so it was not projected.` });
                raw.push({ texel: [], rgb: [], logW: [], wAbs: [], x: [], y: [] });
                continue;
            }
            const s = projectView(input, view, input.depthFor(view), opts);
            if (!s.texel.length) {
                passDegradations.push({ stage: 'bake-projection', reasonCode: 'pano_sees_nothing', layerKey: atlas.layerKey,
                    reason: `Pano ${view.panoId} sees none of this layer's texels unoccluded at a usable angle.` });
            }
            raw.push(s);
        }
        timingsMs[pass ? 'reproject' : 'project'] = Date.now() - tProj;

        samples = raw.map((r) => ({ texel: Int32Array.from(r.texel), rgb: Float32Array.from(r.rgb) }));
        logW = raw.map((r) => Float64Array.from(r.logW));

        // ---- 3b: per-view, per-chart alignment, then each shifted sample re-reads its colour from the photo -------------
        alignment = undefined;
        let al: ReturnType<typeof alignViewsPerChart> | undefined;
        if (o.align !== false && views.length >= 2) {
            const tAlign = Date.now();
            const res = alignViewsPerChart(atlas, views, raw.map((r, k) => ({ texel: samples[k].texel, x: Float32Array.from(r.x), y: Float32Array.from(r.y), logW: logW[k] })),
                {
                    ...(typeof o.align === 'object' ? o.align : {}), ...(input.signal ? { signal: input.signal } : {}),
                    ...(o.alignReference ? { reference: (t: number) => o.alignReference!([atlas.texels.position[t * 3], atlas.texels.position[t * 3 + 1], atlas.texels.position[t * 3 + 2]], [normal[t * 3], normal[t * 3 + 1], normal[t * 3 + 2]]) } : {})
                });
            al = res;
            alignment = res.report;
            if (res.report.timedOut) {
                passDegradations.push({ stage: 'bake-projection', reasonCode: 'alignment_timeout', layerKey: atlas.layerKey,
                    reason: `The per-chart image alignment used its time budget after ${Math.round(res.report.ms / 1000)} s; the charts it had not reached keep their registered poses.` });
            }
            const col = new Float64Array(3);
            samples.forEach((s, k) => {
                const r = raw[k];
                for (let i = 0; i < s.texel.length; i++) {
                    if (!res.dx[k][i] && !res.dy[k][i]) continue;
                    sampleLinear(views[k], r.x[i] + res.dx[k][i], r.y[i] + res.dy[k][i], col);
                    s.rgb[i * 3] = col[0]; s.rgb[i * 3 + 1] = col[1]; s.rgb[i * 3 + 2] = col[2];
                }
            });
            timingsMs[pass ? 'realign' : 'align'] = Date.now() - tAlign;
        }
        if (pass || !al || o.refinePose === false) break;
        const tRefine = Date.now();
        const ref = refinePosesFromAlignment(atlas, views, raw.map((r, k) => ({ texel: samples[k].texel, x: Float32Array.from(r.x), y: Float32Array.from(r.y) })), al.dx, al.dy, al.shifts,
            typeof o.refinePose === 'object' ? o.refinePose : {});
        timingsMs.poseRefine = Date.now() - tRefine;
        poseRefine = {
            rmsBeforeM: ref.rmsBeforeM, rmsAfterM: ref.rmsAfterM, points: ref.points, applied: ref.applied, perPano: ref.perPano,
            ...(alignment ? { firstPassGradNcc: { before: alignment.interViewGradNccBefore, after: alignment.interViewGradNccAfter } } : {})
        };
        if (!ref.applied) break;
        // the alignment's correspondences say something about the pose only where the alignment itself is trustworthy:
        // below this agreement its shifts are mostly whole-course jumps on repeated coursing (measured on the live arch: at
        // 0.07 to 0.23 the refined poses always lowered the views' agreement), so the second pass is not spent
        if ((alignment?.interViewGradNccAfter ?? 0) < MIN_NCC_FOR_POSE_REFINE) {
            poseRefine.kept = false;
            poseRefine.reason = `the alignment's own agreement (inter-view gradient NCC ${(alignment?.interViewGradNccAfter ?? 0).toFixed(3)}) is below ${MIN_NCC_FOR_POSE_REFINE}, too weak to re-pose the views from`;
            break;
        }
        pass0 = { views, raw, samples, logW, alignment, degradations: passDegradations.slice() };
        views = ref.views;
    }
    // the refined poses stand only if they explain the agreement (the views agree better from the poses alone, before any
    // shift, than from the registered poses) and the final agreement is no worse; else the registered poses' pass is kept
    if (pass0 && poseRefine) {
        const before0 = pass0.alignment?.interViewGradNccBefore ?? 0, after0 = pass0.alignment?.interViewGradNccAfter ?? 0;
        const before1 = alignment?.interViewGradNccBefore ?? 0, after1 = alignment?.interViewGradNccAfter ?? 0;
        poseRefine.secondPassGradNcc = { before: before1, after: after1 };
        if (!(before1 >= before0 + 0.05 && after1 >= after0 - 0.005)) {
            poseRefine.kept = false;
            poseRefine.reason = `the refined poses did not bring the views into better agreement (inter-view gradient NCC from the poses alone ${before0.toFixed(3)} -> ${before1.toFixed(3)}, after the alignment ${after0.toFixed(3)} -> ${after1.toFixed(3)}), so the registered poses were kept`;
            ({ views, raw, samples, logW, alignment } = pass0);
            passDegradations.length = 0;
            passDegradations.push(...pass0.degradations);
        } else poseRefine.kept = true;
    }
    degradations.push(...passDegradations);
    const wAbs = raw.map((r) => Float32Array.from(r.wAbs));
    raw.length = 0;

    // ---- per-texel index (CSR) with weights normalised per texel ------------------------------------------------
    const count = new Int32Array(n + 1);
    samples.forEach((s) => { for (const t of s.texel) count[t + 1]++; });
    for (let t = 0; t < n; t++) count[t + 1] += count[t];
    const total = count[n];
    const index: TexelSampleIndex = { start: count, view: new Int32Array(total), sample: new Int32Array(total), weight: new Float64Array(total) };
    const fill = count.slice(0, n);
    samples.forEach((s, k) => { s.texel.forEach((t, i) => { const p = fill[t]++; index.view[p] = k; index.sample[p] = i; }); });
    for (let t = 0; t < n; t++) {
        const a = index.start[t], b = index.start[t + 1];
        if (a === b) continue;
        let mx = -Infinity;
        for (let p = a; p < b; p++) mx = Math.max(mx, logW[index.view[p]][index.sample[p]]);
        let s = 0;
        for (let p = a; p < b; p++) { index.weight[p] = Math.exp(logW[index.view[p]][index.sample[p]] - mx); s += index.weight[p]; }
        for (let p = a; p < b; p++) index.weight[p] /= s;
    }

    // ---- 4a: solar de-light per view (needs a place and a capture time of day) -------------------------------------
    const solarDelit = views.map(() => false);
    if (o.delight) {
        const toEnu = o.delight.layerToEnu ?? ((v: Vec3) => v);
        views.forEach((view, k) => {
            const s = samples[k];
            if (!s.texel.length) return;
            const date = view.captureDate;
            if (!date || !/T\d{2}:\d{2}/.test(date) || Number.isNaN(Date.parse(date))) {
                degradations.push({ stage: 'bake-projection', reasonCode: 'capture_time_unknown', layerKey: atlas.layerKey,
                    reason: `Pano ${view.panoId} has no capture time of day (${date ?? 'no date'}), so its sun is unknown and its texels were not solar de-lit.` });
                return;
            }
            const sun = AlgorithmicUvEngine.resolveSolarSunVector({ latitude: o.delight!.latitude, longitude: o.delight!.longitude, timestampIso: date });
            const E = new Float64Array(s.texel.length);
            let mean = 0;
            for (let i = 0; i < s.texel.length; i++) {
                const q = s.texel[i] * 3;
                const nn = toEnu([normal[q], normal[q + 1], normal[q + 2]]);
                E[i] = AlgorithmicUvEngine.computeSolarIrradiance(nn, sun);
                mean += E[i];
            }
            mean /= s.texel.length;
            for (let i = 0; i < s.texel.length; i++) { const g = mean / E[i]; for (let c = 0; c < 3; c++) s.rgb[i * 3 + c] *= g; }
            solarDelit[k] = true;
        });
    }

    // ---- 5: exposure ---------------------------------------------------------------------------------------------
    const tExp = Date.now();
    const gains: Vec3[] = views.map(() => [1, 1, 1]);
    const anchors = new Set<number>();
    let overlapPairs = 0;
    const gateReports: Array<PaletteGateReport | undefined> = views.map(() => undefined);
    if (o.exposure !== false && views.length) {
        const rel = solveRelativeGains(samples, index, n);
        overlapPairs = rel.pairs;
        views.forEach((_, k) => {
            gains[k] = [Math.exp(rel.logGain[k * 3]), Math.exp(rel.logGain[k * 3 + 1]), Math.exp(rel.logGain[k * 3 + 2])];
            if (rel.anchorOf[k] === k && samples[k].texel.length) anchors.add(k);
        });
    }
    if (input.paletteLab?.length) {
        views.forEach((_, k) => {
            if (!samples[k].texel.length) return;
            const rep = paletteGate(samples[k].rgb, gains[k], input.paletteLab!, o.paletteGateDeltaE ?? 6);
            gateReports[k] = rep;
            if (rep.triggered) for (let c = 0; c < 3; c++) gains[k][c] *= Math.exp(rep.pull[c]);
        });
    }
    samples.forEach((s, k) => { const g = gains[k]; for (let i = 0; i < s.texel.length; i++) for (let c = 0; c < 3; c++) s.rgb[i * 3 + c] *= g[c]; });
    timingsMs.exposure = Date.now() - tExp;

    // ---- 6: blend: weighted mean, Huber at >= huberMin views ------------------------------------------------------
    const tBlend = Date.now();
    const mean = new Float64Array(n * 3);
    for (let t = 0; t < n; t++) {
        const a = index.start[t], b = index.start[t + 1];
        if (a === b) continue;
        const iters = b - a >= huberMin ? 3 : 0;
        const h = new Float64Array(b - a).fill(1);
        for (let it = 0; it <= iters; it++) {
            let s = 0, r = 0, g = 0, bl = 0;
            for (let p = a; p < b; p++) {
                const w = index.weight[p] * h[p - a];
                const q = index.sample[p] * 3, rgb = samples[index.view[p]].rgb;
                r += w * rgb[q]; g += w * rgb[q + 1]; bl += w * rgb[q + 2]; s += w;
            }
            mean[t * 3] = r / s; mean[t * 3 + 1] = g / s; mean[t * 3 + 2] = bl / s;
            if (it === iters) break;
            const m = linearToLab(mean[t * 3], mean[t * 3 + 1], mean[t * 3 + 2]);
            for (let p = a; p < b; p++) {
                const q = index.sample[p] * 3, rgb = samples[index.view[p]].rgb;
                const l = linearToLab(rgb[q], rgb[q + 1], rgb[q + 2]);
                const res = Math.hypot(l[0] - m[0], l[1] - m[1], l[2] - m[2]);
                h[p - a] = res <= huberK ? 1 : huberK / res;
            }
        }
        if (iters) {
            let s = 0;
            for (let p = a; p < b; p++) { index.weight[p] *= h[p - a]; s += index.weight[p]; }
            for (let p = a; p < b; p++) index.weight[p] /= s;
        }
    }

    // ---- 6a: one view per region (per-chart gains, block MRF); the band blend below then blends at region boundaries ------
    let label: Int32Array | undefined;
    let regions: ProjectionBakeReport['regions'];
    const tRegions = Date.now();
    if (o.regionSelect !== false && views.length >= 2) {
        const g = chartLocalGains(atlas, samples, index, mean);
        if (g.pairs) {
            // the mean again, with the gained colours (same weights)
            for (let t = 0; t < n; t++) {
                const a = index.start[t], b = index.start[t + 1];
                if (a === b) continue;
                let r = 0, gg = 0, bl = 0;
                for (let p = a; p < b; p++) { const w = index.weight[p], q = index.sample[p] * 3, rgb = samples[index.view[p]].rgb; r += w * rgb[q]; gg += w * rgb[q + 1]; bl += w * rgb[q + 2]; }
                mean[t * 3] = r; mean[t * 3 + 1] = gg; mean[t * 3 + 2] = bl;
            }
        }
        // known solar shading: a view whose capture time is known saw the texels facing away from its sun in shadow
        const sunOf: Array<Vec3 | undefined> = views.map(() => undefined);
        if (o.delight) {
            views.forEach((view, k) => {
                const date = view.captureDate;
                if (!date || !/T\d{2}:\d{2}/.test(date) || Number.isNaN(Date.parse(date))) return;
                sunOf[k] = AlgorithmicUvEngine.resolveSolarSunVector({ latitude: o.delight!.latitude, longitude: o.delight!.longitude, timestampIso: date }) as Vec3;
            });
        }
        const toEnu = o.delight?.layerToEnu ?? ((v: Vec3) => v);
        const sunShadedViews = sunOf.filter(Boolean).length;
        const sunShaded = sunShadedViews ? (k: number, t: number): boolean => {
            const sv = sunOf[k];
            if (!sv) return false;
            const nn = toEnu([normal[t * 3], normal[t * 3 + 1], normal[t * 3 + 2]]);
            return sv[1] <= 0 || nn[0] * sv[0] + nn[1] * sv[1] + nn[2] * sv[2] <= 0.05;
        } : undefined;
        const sel = selectViewsPerRegion(atlas, samples, index, { ...(sunShaded ? { sunShaded } : {}), ...(typeof o.regionSelect === 'object' ? o.regionSelect : {}) });
        label = sel.label;
        regions = { chartGains: g.pairs, meanAbsLogGain: g.meanAbsLogGain, blocks: sel.blocks, boundaryTexels: sel.changes, refinedTexels: sel.refined, sunShadedViews, shadowedBlocks: sel.shadowedBlocks };
        timingsMs.regions = Date.now() - tRegions;
    }
    const tBands = Date.now();

    // ---- 6b: band seam blend of each view's residual against the mean: the views by weight, or the chosen view per region ----
    const final = Float64Array.from(mean);
    let multiViewTexels = 0;
    for (let t = 0; t < n; t++) if (index.start[t + 1] - index.start[t] >= 2) multiViewTexels++;
    let poisson: PoissonBlendReport | undefined;
    if (label && o.poisson !== false) {
        poisson = poissonBlendRegions(atlas, samples, index, label, final, { ...(typeof o.poisson === 'object' ? o.poisson : {}), ...(input.signal ? { signal: input.signal } : {}) });
        timingsMs.poisson = poisson.ms;
    } else if (bandSigmas.length && multiViewTexels > 0) {
        const bands = bandSigmas.length + 1;
        const num = Array.from({ length: bands }, () => new Float64Array(n * 3));
        const den = Array.from({ length: bands }, () => new Float64Array(n));
        // map by map (blurs never cross atlas maps), in the map's own rectangle; a map with no texel two views see, or (one
        // view per region) no boundary between chosen views, has nothing to blend and is skipped
        const rectOf = (m: number): [number, number, number, number] => {
            const [u0, v0, u1, v1] = atlas.maps[m].atlasRect;
            return [Math.max(0, Math.floor(u0 * W)), Math.max(0, Math.floor(v0 * H)), Math.min(W, Math.ceil(u1 * W)), Math.min(H, Math.ceil(v1 * H))];
        };
        const blended = new Uint8Array(atlas.maps.length);
        for (let m = 0; m < atlas.maps.length; m++) {
            checkAbort(input.signal);
            const [x0, y0, x1, y1] = rectOf(m);
            const w = x1 - x0, h = y1 - y0;
            if (w <= 0 || h <= 0) continue;
            const inMap = (t: number) => mapIndex[t] === m && covered[t];
            let needed = false;
            const viewsHere = new Set<number>();
            for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
                const t = y * W + x;
                if (!inMap(t)) continue;
                const a = index.start[t], b = index.start[t + 1];
                for (let p = a; p < b; p++) viewsHere.add(index.view[p]);
                if (b - a < 2) continue;
                if (!label) needed = true;
                else if ((x + 1 < x1 && inMap(t + 1) && label[t + 1] >= 0 && label[t + 1] !== label[t]) || (y + 1 < y1 && inMap(t + W) && label[t + W] >= 0 && label[t + W] !== label[t])) needed = true;
            }
            if (!needed || viewsHere.size < 2) continue;
            blended[m] = 1;
            const nl = w * h;
            const covL = new Uint8Array(nl), mapL = new Uint16Array(nl), ones = new Float64Array(nl);
            for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const t = (y0 + y) * W + x0 + x; if (inMap(t)) { covL[y * w + x] = 1; ones[y * w + x] = 1; } }
            for (const k of viewsHere) {
                const M = new Float64Array(nl), Dr = new Float64Array(nl), Dg = new Float64Array(nl), Db = new Float64Array(nl), Wk = new Float64Array(nl);
                const local: number[] = [];
                let anyW = false;
                for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
                    const l = y * w + x;
                    if (!covL[l]) continue;
                    const t = (y0 + y) * W + x0 + x;
                    for (let p = index.start[t]; p < index.start[t + 1]; p++) {
                        if (index.view[p] !== k) continue;
                        const q = index.sample[p] * 3, rgb = samples[k].rgb;
                        M[l] = 1; local.push(l);
                        Dr[l] = rgb[q] - mean[t * 3]; Dg[l] = rgb[q + 1] - mean[t * 3 + 1]; Db[l] = rgb[q + 2] - mean[t * 3 + 2];
                        Wk[l] = label ? (label[t] === k ? 1 : 0) : index.weight[p];
                        if (Wk[l] > 0) anyW = true;
                        break;
                    }
                }
                if (!anyW) continue; // chosen nowhere on this map: it adds nothing to any band
                // Gaussian stack of the residual (normalised over the view's support) and of the weight (over the map),
                // normalised only where they are read (the view's own texels)
                const bd = bandSigmas.map(sg => blurWithinMaps([Dr, Dg, Db], M, sg, w, h, mapL, covL));
                const bw = bandSigmas.map(sg => blurWithinMaps([Wk], ones, sg, w, h, mapL, covL));
                const resid = (bnd: number, c: number, l: number): number => {
                    if (bnd === 0) return c === 0 ? Dr[l] : c === 1 ? Dg[l] : Db[l];
                    const b = bd[bnd - 1];
                    return b.m[l] > 1e-12 ? b.f[c][l] / b.m[l] : 0;
                };
                const weight = (bnd: number, l: number): number => {
                    if (bnd === 0) return Wk[l];
                    const b = bw[bnd - 1];
                    return b.m[l] > 1e-12 ? b.f[0][l] / b.m[l] : 0;
                };
                for (const l of local) {
                    const t = (y0 + Math.floor(l / w)) * W + x0 + (l % w);
                    for (let bnd = 0; bnd < bands; bnd++) {
                        const wt = weight(bnd, l);
                        if (!(wt > 0)) continue;
                        for (let c = 0; c < 3; c++) {
                            const band = bnd < bands - 1 ? resid(bnd, c, l) - resid(bnd + 1, c, l) : resid(bnd, c, l);
                            num[bnd][t * 3 + c] += wt * band;
                        }
                        den[bnd][t] += wt;
                    }
                }
            }
        }
        // one view per region on a map with no boundary: every texel is its chosen view's colour (the bands would add
        // exactly the difference to the mean)
        if (label) {
            for (let t = 0; t < n; t++) {
                if (index.start[t + 1] - index.start[t] < 2 || !(mapIndex[t] < blended.length) || blended[mapIndex[t]]) continue;
                for (let p = index.start[t]; p < index.start[t + 1]; p++) {
                    if (index.view[p] !== label[t]) continue;
                    const q = index.sample[p] * 3, rgb = samples[label[t]].rgb;
                    final[t * 3] = rgb[q]; final[t * 3 + 1] = rgb[q + 1]; final[t * 3 + 2] = rgb[q + 2];
                    break;
                }
            }
        }
        for (let t = 0; t < n; t++) {
            if (index.start[t + 1] - index.start[t] < 2) continue;
            for (let bnd = 0; bnd < bands; bnd++) {
                if (!(den[bnd][t] > 0)) continue;
                for (let c = 0; c < 3; c++) final[t * 3 + c] += num[bnd][t * 3 + c] / den[bnd][t];
            }
        }
    }
    timingsMs.bands = Date.now() - tBands;
    timingsMs.blend = Date.now() - tBlend;

    // ---- outputs: albedo, confidence, provenance -----------------------------------------------------------------
    const albedo = new Uint8Array(n * 4);
    const confidence: ConfidencePlane = { width: W, height: H, data: new Uint8Array(n * 4) };
    const delightParams = {
        shadowLift: o.delight?.shadowLift ?? PHOTOGRAMMETRIC_DELIGHT.defaults.shadowLift,
        highlightCompress: o.delight?.highlightCompress ?? PHOTOGRAMMETRIC_DELIGHT.defaults.highlightCompress
    };
    const setKey = new Int32Array(n).fill(-1);
    const keys: string[] = [];
    const keyId = new Map<string, number>();
    const dominant = new Int32Array(n).fill(-1);
    let baked = 0, single = 0;
    // shadow lift / highlight compression over the whole plane, the lift capped by local contrast (delightLinearPlane)
    let delightReport: DelightPlaneReport | undefined;
    if (o.delight) {
        const has = new Uint8Array(n);
        const sizes: number[] = [];
        for (let t = 0; t < n; t++) if (index.start[t + 1] > index.start[t]) { has[t] = 1; if ((t & 63) === 0) sizes.push(atlas.texels.sizeM[t]); }
        sizes.sort((x, y) => x - y);
        const texelM = sizes.length ? sizes[sizes.length >> 1] : 0.05;
        const capOpt = o.delight.liftCap === undefined ? TEXTURE_LIFT_CAP : o.delight.liftCap;
        delightReport = delightLinearPlane(final, has, W, H, delightParams,
            capOpt ? { radiusTexels: capOpt.radiusM / Math.max(1e-3, texelM), contrastGain: capOpt.contrastGain } : undefined);
    }
    for (let t = 0; t < n; t++) {
        const a = index.start[t], b = index.start[t + 1];
        if (a === b) continue;
        baked++;
        if (b - a === 1) single++;
        const rgb: Vec3 = [final[t * 3], final[t * 3 + 1], final[t * 3 + 2]];
        albedo[t * 4] = Math.round(linearToSrgb255(rgb[0]));
        albedo[t * 4 + 1] = Math.round(linearToSrgb255(rgb[1]));
        albedo[t * 4 + 2] = Math.round(linearToSrgb255(rgb[2]));
        albedo[t * 4 + 3] = 255;
        const vs: number[] = [];
        let best = -1, bw = -1;
        for (let p = a; p < b; p++) { vs.push(index.view[p]); if (index.weight[p] > bw) { bw = index.weight[p]; best = index.view[p]; } }
        dominant[t] = label && label[t] >= 0 ? label[t] : best;
        vs.sort((x, y) => x - y);
        const key = vs.join(',');
        let id = keyId.get(key);
        if (id === undefined) { id = keys.length; keys.push(key); keyId.set(key, id); }
        setKey[t] = id;
    }
    // per-texel union confidence 1 - prod(1 - w_abs)
    const conf = new Float64Array(n).fill(1);
    samples.forEach((s, k) => { for (let i = 0; i < s.texel.length; i++) conf[s.texel[i]] *= 1 - wAbs[k][i]; });

    // provenance: one entry per distinct set of contributing panos; collapsed per rung past 250 sets
    const provenance: TexelProvenance[] = [];
    const entryOfKey = new Int32Array(keys.length);
    const counts = new Map<number, number>();
    for (let t = 0; t < n; t++) if (setKey[t] >= 0) counts.set(setKey[t], (counts.get(setKey[t]) ?? 0) + 1);
    const methodOf = (views: number): string => views >= 2
        ? `weighted linear-RGB mean of ${views} registered Street View views (cos^2 incidence x resolution x pose quality x edge feather), ${views >= huberMin ? 'Huber-reweighted, ' : ''}4-band seam blend, per-view exposure log-gain${input.paletteLab?.length ? ' with palette gate' : ''}${o.delight ? ', de-lit' : ''}`
        : `one registered Street View view, depth-tested projection, exposure log-gain${input.paletteLab?.length ? ' with palette gate' : ''}${o.delight ? ', de-lit' : ''}`;
    // coverage is a share of the atlas's covered texels (gutters included), the convention all rungs share so entries add to 1
    const denomTexels = Math.max(1, coveredTexels);
    if (keys.length <= 250) {
        keys.forEach((key, id) => {
            const vs = key.split(',').map(Number);
            entryOfKey[id] = provenance.length;
            provenance.push({ source: PROJECTION_SOURCE, label: PROJECTION_LABEL, method: methodOf(vs.length),
                panoIds: vs.map((v) => views[v].panoId), coverage: (counts.get(id) ?? 0) / denomTexels });
        });
    } else {
        const byRung = [new Set<number>(), new Set<number>()];
        const cover = [0, 0];
        keys.forEach((key, id) => {
            const vs = key.split(',').map(Number);
            const r = vs.length >= 2 ? 0 : 1;
            vs.forEach((v) => byRung[r].add(v));
            cover[r] += counts.get(id) ?? 0;
            entryOfKey[id] = r;
        });
        for (let r = 0; r < 2; r++) {
            provenance.push({ source: PROJECTION_SOURCE, label: PROJECTION_LABEL, method: r === 0 ? methodOf(2) : methodOf(1),
                panoIds: [...byRung[r]].sort((x, y) => x - y).map((v) => views[v].panoId), coverage: cover[r] / denomTexels });
        }
    }
    for (let t = 0; t < n; t++) {
        if (setKey[t] < 0) continue;
        const nv = index.start[t + 1] - index.start[t];
        packConfidenceTexel(confidence, t, entryOfKey[setKey[t]], 1 - conf[t], nv >= 2 ? 0 : 1);
    }

    // ---- measurements: seams, palette distance, degradations -------------------------------------------------------
    // seam: where the dominant view changes between neighbours, how far apart the two views' corrected colours are at
    // the same place (what a hard switch would show). Measured on 5 x 5 texel means over the texels both views see, so a seam
    // is a low-frequency step; mortar lines resampled at two resolutions are detail, not a seam.
    const seams: number[] = [];
    const SEAM_R = 2;
    const sampleAt = (v: number, u: number): number => {
        for (let p = index.start[u]; p < index.start[u + 1]; p++) if (index.view[p] === v) return index.sample[p] * 3;
        return -1;
    };
    /** Both views' mean colours over the texels near t that both of them see. */
    const pairLabs = (va: number, vb: number, t: number): [Vec3, Vec3] | undefined => {
        const tx = t % W, ty = (t - tx) / W;
        const A = [0, 0, 0], B = [0, 0, 0];
        let m = 0;
        for (let yy = Math.max(0, ty - SEAM_R); yy <= Math.min(H - 1, ty + SEAM_R); yy++) {
            for (let xx = Math.max(0, tx - SEAM_R); xx <= Math.min(W - 1, tx + SEAM_R); xx++) {
                const u = yy * W + xx;
                if (mapIndex[u] !== mapIndex[t]) continue;
                const qa = sampleAt(va, u), qb = sampleAt(vb, u);
                if (qa < 0 || qb < 0) continue;
                for (let c = 0; c < 3; c++) { A[c] += samples[va].rgb[qa + c]; B[c] += samples[vb].rgb[qb + c]; }
                m++;
            }
        }
        return m ? [linearToLab(A[0] / m, A[1] / m, A[2] / m), linearToLab(B[0] / m, B[1] / m, B[2] / m)] : undefined;
    };
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const t = y * W + x;
            if (dominant[t] < 0) continue;
            for (const u of [x + 1 < W ? t + 1 : -1, y + 1 < H ? t + W : -1]) {
                if (u < 0 || dominant[u] < 0 || dominant[u] === dominant[t] || mapIndex[u] !== mapIndex[t]) continue;
                const pl = pairLabs(dominant[t], dominant[u], t);
                if (pl) seams.push(deltaE00(pl[0], pl[1]));
            }
        }
    }
    seams.sort((a, b) => a - b);
    // the seam as the output shows it: across each boundary between chosen views, the final colour's low frequency (5 x 5
    // means centred 3 texels back) on each side, against the same measure between neighbours inside one view's region
    const outA: number[] = [], outI: number[] = [], lowA: number[] = [], lowI: number[] = [];
    {
        const mean3 = (c: number, R = 2): Vec3 | undefined => {
            const cx = c % W, cy = (c - cx) / W;
            let r = 0, g = 0, b = 0, m = 0;
            for (let yy = Math.max(0, cy - R); yy <= Math.min(H - 1, cy + R); yy++) for (let xx = Math.max(0, cx - R); xx <= Math.min(W - 1, cx + R); xx++) {
                const u = yy * W + xx;
                if (dominant[u] < 0 || mapIndex[u] !== mapIndex[c]) continue;
                r += final[u * 3]; g += final[u * 3 + 1]; b += final[u * 3 + 2]; m++;
            }
            return m ? linearToLab(Math.max(0, r / m), Math.max(0, g / m), Math.max(0, b / m)) : undefined;
        };
        let k = 0;
        for (let y = 4; y < H - 4; y++) for (let x = 4; x < W - 4; x++) {
            const t = y * W + x;
            if (dominant[t] < 0) continue;
            for (const d of [1, W]) {
                const u = t + d;
                if (dominant[u] < 0 || mapIndex[u] !== mapIndex[t]) continue;
                const boundary = dominant[u] !== dominant[t];
                if (!boundary && (k++ % 13)) continue;
                if (mapIndex[t - 2 * d] !== mapIndex[t] || mapIndex[u + 2 * d] !== mapIndex[t]) continue;
                const a = mean3(t - 2 * d), b = mean3(u + 2 * d);
                if (a && b) (boundary ? outA : outI).push(deltaE00(a, b));
                // the low-frequency step (9 x 9 means centred 4 texels back): an exposure patch, not detail
                if (x >= 8 && y >= 8 && x < W - 8 && y < H - 8 && mapIndex[t - 4 * d] === mapIndex[t] && mapIndex[u + 4 * d] === mapIndex[t]) {
                    const la = mean3(t - 4 * d, 4), lb = mean3(u + 4 * d, 4);
                    if (la && lb) (boundary ? lowA : lowI).push(deltaE00(la, lb));
                }
            }
        }
        outA.sort((a, b) => a - b); outI.sort((a, b) => a - b); lowA.sort((a, b) => a - b); lowI.sort((a, b) => a - b);
    }
    const pct = (v: number[], q: number) => (v.length ? v[Math.min(v.length - 1, Math.floor(v.length * q))] : 0);
    const maxSeam = seams.length ? seams[seams.length - 1] : 0;
    const p95Seam = seams.length ? seams[Math.min(seams.length - 1, Math.floor(seams.length * 0.95))] : 0;
    const labOf = (t: number): Vec3 => linearToLab(SRGB_TO_LINEAR[albedo[t * 4]], SRGB_TO_LINEAR[albedo[t * 4 + 1]], SRGB_TO_LINEAR[albedo[t * 4 + 2]]);
    let paletteDeltaE: number | undefined;
    if (input.paletteLab?.length && baked) {
        let s = 0, m = 0;
        const stride = Math.max(1, Math.floor(baked / 5000));
        let seen = 0;
        for (let t = 0; t < n; t++) {
            if (setKey[t] < 0) continue;
            if (seen++ % stride) continue;
            const l = labOf(t);
            let best = Infinity;
            for (const p of input.paletteLab) best = Math.min(best, deltaE00(l, p.lab));
            s += best; m++;
        }
        paletteDeltaE = s / m;
    }
    const uncovered = targetTexels - baked;
    if (uncovered > 0) {
        degradations.push({ stage: 'bake-projection', reasonCode: 'no_view_sees_texel', layerKey: atlas.layerKey, fromRung: 1, toRung: 2,
            texelShare: uncovered / denomTexels,
            reason: `${(100 * uncovered / denomTexels).toFixed(1)} percent of the layer's texels are seen by no registered Street View view (occluded, out of frame, too oblique or redacted); they are left for the next rung.` });
    }
    if (single > 0) {
        degradations.push({ stage: 'bake-projection', reasonCode: 'single_view_only', layerKey: atlas.layerKey, fromRung: 0, toRung: 1,
            texelShare: single / denomTexels,
            reason: `${(100 * single / denomTexels).toFixed(1)} percent of the layer's texels are seen by only one view, so they carry that view's colour unblended.` });
    }
    timingsMs.total = Date.now() - t0;

    return {
        layerKey: atlas.layerKey, width: W, height: H, albedo, confidence, provenance, degradations, paletteDeltaE,
        report: {
            targetTexels, coveredTexels, bakedTexels: baked, multiViewTexels, overlapPairs, maxSeamDeltaE: maxSeam, p95SeamDeltaE: p95Seam, seamSamples: seams.length, timingsMs,
            outputSeam: { p95DeltaE: pct(outA, 0.95), maxDeltaE: outA.length ? outA[outA.length - 1] : 0, samples: outA.length, interiorP95DeltaE: pct(outI, 0.95), lowFreqP95DeltaE: pct(lowA, 0.95), lowFreqMedianDeltaE: pct(lowA, 0.5), lowFreqInteriorP95DeltaE: pct(lowI, 0.95), lowFreqInteriorMedianDeltaE: pct(lowI, 0.5) },
            ...(delightReport ? { delight: delightReport } : {}),
            ...(alignment ? { alignment } : {}),
            ...(poseRefine ? { poseRefine } : {}),
            ...(regions ? { regions } : {}),
            ...(poisson ? { poisson } : {}),
            views: views.map((v, k) => ({ panoId: v.panoId, samples: samples[k].texel.length, gain: gains[k], anchor: anchors.has(k), paletteGate: gateReports[k], solarDelit: solarDelit[k] }))
        }
    };
}

