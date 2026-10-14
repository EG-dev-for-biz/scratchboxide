/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Feature-based Street View registration against the TEXTURED scan (plan E6, translation-pinning variant).
 *
 * Why: a sky-silhouette fit pins rotation against a far tower but is blind to translation, so frames accepted that
 * way were misregistered by several pixels on interior detail (window grids doubled when projected). What texturing
 * needs is that photo content lands on the same mesh texels as the scan's own texture shows it, so the photo is
 * registered against a render of the textured scan.
 *
 * Similarity measure: the doubled-angle gradient field (orientation modulo 180 deg, magnitude weighted). Street photos
 * and the aerial tile texture often disagree on contrast polarity (windows dark in the tile, bright with sky
 * reflections in the photo), which drives a luminance NCC to ~0 even at the true pose; edge orientations agree.
 * Matching runs on an image pyramid, each render pixel at the level where its projected texel spans about two pixels
 * (the tile texture is 5-15x blurrier than a street photo).
 *
 *   A. Dense coarse alignment (per seed: the GPS pose, caller seeds, +-2.5 m along / across the view): a (yaw, pitch)
 *      grid, then bounded Nelder-Mead over the six correction parameters, maximising the dense orientation
 *      correlation of photo and textured render at pyramid levels 3 and 2.
 *   B. Local features from the best dense seeds: Shi-Tomasi corners of the render are block-matched into the photo
 *      (orientation correlation) within 16, then 6 px; ratio test (peak above the best other local maximum) and
 *      mutual check (the photo patch searched back in the render lands on the keypoint); in the first stage an
 *      ambiguous keypoint (periodic grid) keeps up to four candidate peaks and RANSAC picks the consistent one. Render
 *      keypoints are lifted to 3D through the render depth (depth steps dropped). RANSAC-PnP with the fixed Street View
 *      intrinsics (fx = W / 2 / tan(fov / 2)): EPnP hypotheses (SpatialPoseEstimatorService.solvePnP) plus
 *      prior-regularised minimal hypotheses, then a Huber MAP refinement of the pano's rigid correction (all frames
 *      of a pano share the camera centre) with weak Gaussian priors around the GPS pose.
 *   C. Interior-edge refinement: straight edges of the textured render (window heads, ledges, setbacks, building-
 *      against-building contours; never the sky silhouette), in pieces of ~48 px, are located in the photo by a 1-D
 *      profile search along their normal (|gradient . n| NCC, polarity free, ratio test and mutual check); the pose
 *      minimises point-to-line distances together with the point matches. A round is kept only when it lowers the
 *      truncated edge cost re-measured at the new pose. The seed whose final pose has the lowest edge cost wins.
 *
 * Measurements per frame at the final pose (re-rendered): interior edge median offset (px), PnP inliers and
 * residuals, orientation NCC of photo vs textured render at the final and at the GPS pose (finer levels than the
 * dense stage), luminance NCC (reported only), and for multi-frame panos a held-out check: the pano pose re-fitted
 * without the frame and the frame's interior edges under it. Cross-view consistency between panos is measured by
 * the caller (StreetViewCrossViewRefiner.measure) and folded in through evaluateFeatureGates / featurePoseQuality.
 *
 * Generic: nothing here knows the location or what is in the frame; every threshold is an option.
 * Conventions: those of StreetViewPoseRegistrar (scan frame x = East, y = Up, z = South; pixel i covers [i, i + 1)).
 */

import {
    frameCamera, projectToFrame, renderTexturedView, luminance, gaussianBlur, detectLineSegments, PLATE_EMPTY_DEPTH, ZERO_CORRECTION,
    type FrameCamera, type PoseCorrection, type RgbaImage, type TexturedPrimitive, type LineSegment2D
} from './StreetViewPoseRegistrar';
import { SpatialPoseEstimatorService, type Point2D, type Point3D } from './SpatialPoseEstimatorService';

type V3 = [number, number, number];
const DEG = Math.PI / 180;
const EMPTY = PLATE_EMPTY_DEPTH * 0.5;

// ============================================================================================
// Inputs, options, results
// ============================================================================================

export interface FeatureFrameInput {
    key: string;
    image: RgbaImage;
    /** 1 = usable photo pixel (watermark strip and occluders are 0). */
    valid: Uint8Array;
    headingDeg: number;
    pitchDeg: number;
    /** Street View fov (horizontal, deg). */
    fovDeg: number;
}

export interface FeaturePanoInput {
    panoId: string;
    /** GPS eye in the scan frame (ENU of the pano lat/lng, y = local street + camera height). */
    nominalEye: V3;
    /** Reference heading of the pano correction model (see frameCamera). */
    referenceHeadingDeg: number;
    frames: FeatureFrameInput[];
    /** Extra start corrections (e.g. an earlier rigid registration). The GPS pose and +-perturbations are always tried. */
    extraSeeds?: PoseCorrection[];
}

export interface FeaturePriors { horizontalSigmaMeters: number; verticalSigmaMeters: number; angleSigmaDeg: number }
export interface FeatureBounds { horizontalMeters: number; verticalMeters: number; yawDeg: number; pitchDeg: number; rollDeg: number }

export interface FeatureRegistrationOptions {
    /** Supersampling of the textured render. Default 2. */
    supersample?: number;
    /** Coarsest pyramid level used for matching (level l = 2^l px per sample). Default 4. */
    maxLevel?: number;
    /** A render pixel whose texel spans T px is matched at pyramid level round(log2(T * f)). Default 0.5. */
    textureBlurTexels?: number;
    /**
     * Patch size (full-resolution px) of each feature stage; the radius at level l is
     * clamp(round(size / 2 / 2^l), minPatchRadius, maxPatchRadius). Large early patches span unique structure
     * (corners, cornices) and break the periodicity of window grids. Default [96, 64].
     */
    stagePatchPx?: number[];
    minPatchRadius?: number;
    maxPatchRadius?: number;
    /** Minimum RMS gradient magnitude of a render patch (luminance / level px). Default 1.5. */
    minPatchStd?: number;
    /** Minimum orientation correlation of a point match. Default 0.4. */
    minNcc?: number;
    /** Minimum margin of a peak over the best other local maximum (>= 2 level px away). Default 0.08. */
    minMargin?: number;
    /** Keypoints per level and frame. Default 220. */
    keypointsPerLevel?: number;
    /** Keypoint grid cell (full-resolution px); at most `perCell` keypoints per cell. Defaults 48 / 4. */
    gridCellPx?: number;
    perCell?: number;
    /** Search radii (full-resolution px) of the feature stages after the dense alignment. Default [16, 6]. */
    searchSchedulePx?: number[];
    /** RANSAC hypotheses per frame (half EPnP, half prior-regularised). Default 240. */
    ransacIterations?: number;
    /** Inlier threshold (px at level 0; a level-l match gets max(this, 1.25 * 2^l)). Default 2.5. */
    inlierThresholdPx?: number;
    /** Huber threshold in units of a match's sigma. Default 1.5. */
    huber?: number;
    priors?: Partial<FeaturePriors>;
    bounds?: Partial<FeatureBounds>;
    /** Seed perturbation (m) along and across the pano's mean horizontal view direction. 0 disables. Default 2.5. */
    seedOffsetMeters?: number;
    /** Dense coarse alignment levels [coarse, finer]. Default [3, 2]. */
    denseLevels?: [number, number];
    /** Half range and step (deg) of the dense (yaw, pitch) grid at the coarse level. Defaults 1.5 / 0.5. */
    denseGridDeg?: number;
    denseGridStepDeg?: number;
    /** Nelder-Mead evaluations per dense level. Default 120. */
    denseMaxEvals?: number;
    /** Weight of the Gaussian prior penalty (per sigma^2) against the dense correlation. Default 0.002. */
    densePriorWeight?: number;
    /** Dense seeds carried through the feature and edge stages (the lowest final edge cost wins). Default 3. */
    featureSeeds?: number;
    /** Search radius (full-resolution px) of the 1-D edge offset measurement. Default 8. */
    edgeSearchPx?: number;
    /** Maximum edge + point refinement rounds after the point-only stages (each must lower the edge cost). Default 4. */
    edgeIterations?: number;
    /** Minimum length (px at the detection level) of a render edge segment. Default 10. */
    edgeMinLengthPx?: number;
    /** Long edges are measured in pieces of about this length (full-resolution px). Default 48. */
    edgeChunkPx?: number;
    /** Gradient threshold (luminance / level px) of render edge detection. Default 2. */
    edgeMagnitudeThreshold?: number;
    /** Half width (px at the level) of the edge profile. Default 4. */
    edgeProfileHalfWidth?: number;
    /** Minimum NCC of an edge profile match. Default 0.5. */
    edgeMinNcc?: number;
    /** Mesh points nearer than this (m) are not used. Default 4. */
    minDepthMeters?: number;
    /** PRNG seed of RANSAC (deterministic). Default 1. */
    randomSeed?: number;
    log?: (msg: string) => void;
}

const DEF = {
    supersample: 2, maxLevel: 4, textureBlurTexels: 0.5, stagePatchPx: [96, 64], minPatchRadius: 4, maxPatchRadius: 8, minPatchStd: 1.5, minNcc: 0.4, minMargin: 0.08,
    keypointsPerLevel: 220, gridCellPx: 48, perCell: 4, searchSchedulePx: [16, 6], ransacIterations: 240, inlierThresholdPx: 2.5,
    huber: 1.5, seedOffsetMeters: 2.5, denseLevels: [3, 2] as [number, number], denseGridDeg: 1.5, denseGridStepDeg: 0.5, denseMaxEvals: 120, densePriorWeight: 0.002, featureSeeds: 3, edgeSearchPx: 8, edgeIterations: 4, edgeMinLengthPx: 10, edgeChunkPx: 48, edgeMagnitudeThreshold: 2, edgeProfileHalfWidth: 4, edgeMinNcc: 0.5,
    minDepthMeters: 4, randomSeed: 1
};
export const DEFAULT_FEATURE_PRIORS: Readonly<FeaturePriors> = Object.freeze({ horizontalSigmaMeters: 3, verticalSigmaMeters: 1, angleSigmaDeg: 2 });
/**
 * Search box around the GPS pose. The vertical range is wide: the nominal eye is the scan's local street height plus a
 * nominal camera height, and on photogrammetric tiles the "street" under a pano often includes baked vehicles, so
 * registered eyes 1-2 m below the nominal one are common.
 */
export const DEFAULT_FEATURE_BOUNDS: Readonly<FeatureBounds> = Object.freeze({ horizontalMeters: 6, verticalMeters: 2.5, yawDeg: 4, pitchDeg: 3, rollDeg: 3 });

/** A photo <-> textured-scan point correspondence. */
export interface FeatureMatch {
    /** Frame index within the pano input. */
    frame: number;
    /** Scan point (world) under the render keypoint. */
    X: V3;
    /** Photo location (continuous full-resolution px). */
    u: number; v: number;
    /** Render keypoint location (continuous full-resolution px) at the pose the match was made with. */
    ur: number; vr: number;
    level: number;
    ncc: number;
    margin: number;
    /**
     * Candidate photo locations of an ambiguous keypoint (periodic structure; coarse stage only), best first; the
     * first equals (u, v). Robust estimation uses the candidate nearest to each hypothesis' projection.
     */
    alts?: Array<{ u: number; v: number; ncc: number }>;
}

/** A render edge located in the photo by a 1-D search along its normal. */
export interface EdgeMeasurement {
    frame: number;
    level: number;
    /** Segment end points in the render (continuous full-resolution px). */
    x0: number; y0: number; x1: number; y1: number;
    /** Unit image normal. */
    nx: number; ny: number;
    lengthPx: number;
    /** Photo edge offset along the normal (full-resolution px); null when not located (weak / ambiguous / at the search border). */
    offsetPx: number | null;
    ncc: number;
    margin: number;
    /** Scan points along the edge (foreground side of a depth step) and their render pixel locations. */
    points: Array<{ X: V3; u: number; v: number }>;
}

export interface EdgeStats {
    /** Length-weighted median |offset| of located pieces (px); null when fewer than `minSegments` were located. */
    medianPx: number | null;
    p75Px: number | null;
    located: number;
    tested: number;
    locatedLengthPx: number;
    /** Truncated edge cost (see edgeCost): unlocated pieces count as the search radius. */
    truncatedCostPx: number;
}

export interface FeatureFrameReport {
    key: string;
    /** Point matches at the final pose (fresh, fine search) and the PnP inliers among them. */
    matches: number;
    inliers: number;
    inlierMedianPx: number | null;
    /** Median residual over all matches (not only inliers). */
    matchMedianPx: number | null;
    /** Interior edges at the final pose and, for comparison, at the GPS pose. */
    edges: EdgeStats;
    edgesPrior: EdgeStats;
    /**
     * NCC of the photo's and the textured render's orientation fields (polarity free; levels 0-1, interior pixels)
     * at the final and at the GPS pose. This is the gated photometric measure.
     */
    nccFinal: number | null;
    nccPrior: number | null;
    nccPixels: number;
    /** Band-passed multi-scale luminance NCC at the final and at the GPS pose (reported, not gated). */
    lumNccFinal: number | null;
    lumNccPrior: number | null;
    /**
     * Held-out consistency with the other frames of the pano (null for single-frame panos): the pano pose re-fitted
     * WITHOUT this frame (fine stage + edges from the joint solution), and this frame's interior edges, PnP residual
     * and image displacement (px, over its inlier points) under that pose.
     */
    heldOut: { correction: PoseCorrection; edges: EdgeStats; inlierMedianPx: number | null; displacementPx: number | null } | null;
    camera: FrameCamera;
}

export interface FeaturePanoResult {
    panoId: string;
    nominalEye: V3;
    referenceHeadingDeg: number;
    correction: PoseCorrection;
    moveMeters: number;
    moveBearingDeg: number;
    atBound: string[];
    seed: { index: number; label: string; denseScore: number; tried: Array<{ label: string; denseScore: number; edgeCostPx: number | null; inliers: number }> };
    /** Inliers / matches of the joint (all frames) solution at the last point stage. */
    inliers: number;
    matches: number;
    frames: FeatureFrameReport[];
    timingsMs: Record<string, number>;
}

// ============================================================================================
// Small helpers
// ============================================================================================

function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function median(v: number[]): number | null {
    if (!v.length) return null;
    const a = v.slice().sort((x, y) => x - y);
    const m = a.length >> 1;
    return a.length % 2 ? a[m] : 0.5 * (a[m - 1] + a[m]);
}

function weightedQuantile(values: number[], weights: number[], q: number): number | null {
    if (!values.length) return null;
    const idx = values.map((_, i) => i).sort((a, b) => values[a] - values[b]);
    let total = 0;
    for (const w of weights) total += w;
    let acc = 0;
    for (const i of idx) { acc += weights[i]; if (acc >= q * total) return values[i]; }
    return values[idx[idx.length - 1]];
}

const corrArr = (c: PoseCorrection): number[] => [c.dx, c.dy, c.dz, c.dyawDeg, c.dpitchDeg, c.drollDeg];
const arrCorr = (a: ArrayLike<number>): PoseCorrection => ({ dx: a[0], dy: a[1], dz: a[2], dyawDeg: a[3], dpitchDeg: a[4], drollDeg: a[5] });

/** Solves the symmetric positive system A x = b (n x n, row-major) by Cholesky; null when not positive definite. */
function solveSpd(A: Float64Array, b: Float64Array, n: number): Float64Array | null {
    const L = new Float64Array(n * n);
    for (let i = 0; i < n; i++) {
        for (let j = 0; j <= i; j++) {
            let s = A[i * n + j];
            for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
            if (i === j) { if (!(s > 1e-15)) return null; L[i * n + i] = Math.sqrt(s); } else L[i * n + j] = s / L[j * n + j];
        }
    }
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= L[i * n + k] * y[k]; y[i] = s / L[i * n + i]; }
    const x = new Float64Array(n);
    for (let i = n - 1; i >= 0; i--) { let s = y[i]; for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k]; x[i] = s / L[i * n + i]; }
    return x;
}

// ============================================================================================
// Images: pyramids, integral images
// ============================================================================================

interface Integral { s: Float64Array; s2: Float64Array; w: number; h: number }

function integral(v: Float32Array, w: number, h: number): Integral {
    const W = w + 1;
    const s = new Float64Array(W * (h + 1)), s2 = new Float64Array(W * (h + 1));
    for (let y = 0; y < h; y++) {
        let a = 0, a2 = 0;
        for (let x = 0; x < w; x++) {
            const q = v[y * w + x];
            a += q; a2 += q * q;
            s[(y + 1) * W + x + 1] = s[y * W + x + 1] + a;
            s2[(y + 1) * W + x + 1] = s2[y * W + x + 1] + a2;
        }
    }
    return { s, s2, w, h };
}

/** Sum and sum of squares over [x0, x1) x [y0, y1). */
function boxSums(I: Integral, x0: number, y0: number, x1: number, y1: number): [number, number] {
    const W = I.w + 1;
    const a = y0 * W + x0, b = y0 * W + x1, c = y1 * W + x0, d = y1 * W + x1;
    return [I.s[d] - I.s[b] - I.s[c] + I.s[a], I.s2[d] - I.s2[b] - I.s2[c] + I.s2[a]];
}

/** 2x reduction: Gaussian pre-blur (sigma 0.8) and 2x2 average. */
function reduce2(src: Float32Array, w: number, h: number): { data: Float32Array; w: number; h: number } {
    const b = gaussianBlur(src, w, h, 0.8);
    const w2 = w >> 1, h2 = h >> 1;
    const o = new Float32Array(w2 * h2);
    for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) {
        const i = 2 * y * w + 2 * x;
        o[y * w2 + x] = 0.25 * (b[i] + b[i + 1] + b[i + w] + b[i + w + 1]);
    }
    return { data: o, w: w2, h: h2 };
}

/** 2x reduction of a 0/1 mask: 1 only where all four children are 1. */
function reduceMaskAll(m: Uint8Array, w: number, h: number): Uint8Array {
    const w2 = w >> 1, h2 = h >> 1;
    const o = new Uint8Array(w2 * h2);
    for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) {
        const i = 2 * y * w + 2 * x;
        o[y * w2 + x] = m[i] && m[i + 1] && m[i + w] && m[i + w + 1] ? 1 : 0;
    }
    return o;
}

/** 2x reduction of a 0/1 mask: 1 where any child is 1. */
function reduceMaskAny(m: Uint8Array, w: number, h: number): Uint8Array {
    const w2 = w >> 1, h2 = h >> 1;
    const o = new Uint8Array(w2 * h2);
    for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) {
        const i = 2 * y * w + 2 * x;
        o[y * w2 + x] = m[i] || m[i + 1] || m[i + w] || m[i + w + 1] ? 1 : 0;
    }
    return o;
}

function centralGradients(L: Float32Array, w: number, h: number): { gx: Float32Array; gy: Float32Array } {
    const gx = new Float32Array(w * h), gy = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        gx[i] = 0.5 * (L[i + 1] - L[i - 1]);
        gy[i] = 0.5 * (L[i + w] - L[i - w]);
    }
    return { gx, gy };
}

function bilinear(img: Float32Array, w: number, h: number, x: number, y: number): number {
    // continuous coordinates, pixel centres at +0.5
    const fx = x - 0.5, fy = y - 0.5;
    if (fx < 0 || fy < 0 || fx > w - 1 || fy > h - 1) return NaN;
    const x0 = fx | 0, y0 = fy | 0;
    const x1 = x0 + 1 < w ? x0 + 1 : x0, y1 = y0 + 1 < h ? y0 + 1 : y0;
    const ax = fx - x0, ay = fy - y0;
    return (img[y0 * w + x0] * (1 - ax) + img[y0 * w + x1] * ax) * (1 - ay) + (img[y1 * w + x0] * (1 - ax) + img[y1 * w + x1] * ax) * ay;
}

interface PhotoLevel {
    w: number; h: number; lum: Float32Array; valid: Uint8Array;
    /** Orientation-tensor descriptor (interleaved a, b per pixel) and the integral of its energy. */
    ori: Float32Array; oE: Integral; invalidI: Integral; gx: Float32Array; gy: Float32Array;
}

/**
 * Matching descriptor: the doubled-angle gradient field (gx + i gy)^2 / |g|, i.e. magnitude-weighted orientation
 * modulo 180 deg. Correlating it is invariant to contrast polarity and exposure: the scan texture and a street photo
 * often disagree on whether a window is darker or brighter than the stone around it (aerial capture vs sky
 * reflections), which drives a luminance NCC to ~0 even at the true pose, while edge orientations agree.
 * Returns the interleaved field and its per-pixel energy |g|^2.
 */
function orientationField(L: Float32Array, w: number, h: number, sigma = 1.0): { ori: Float32Array; energy: Float32Array } {
    const Lb = gaussianBlur(L, w, h, sigma);
    const ori = new Float32Array(2 * w * h), energy = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const gx = 0.5 * (Lb[i + 1] - Lb[i - 1]), gy = 0.5 * (Lb[i + w] - Lb[i - w]);
        const m = Math.hypot(gx, gy);
        if (m < 1e-6) continue;
        ori[2 * i] = (gx * gx - gy * gy) / m; ori[2 * i + 1] = 2 * gx * gy / m;
        energy[i] = m * m;
    }
    return { ori, energy };
}

/** Photo pyramid (luminance, validity, integrals, gradients) for matching. */
export interface PhotoPyramid { levels: PhotoLevel[] }

export function buildPhotoPyramid(image: RgbaImage, valid: Uint8Array, maxLevel: number): PhotoPyramid {
    const levels: PhotoLevel[] = [];
    let lum = luminance(image.rgba, image.width, image.height), v = valid, w = image.width, h = image.height;
    for (let l = 0; l <= maxLevel; l++) {
        if (l > 0) { const r = reduce2(lum, w, h); v = reduceMaskAll(v, w, h); lum = r.data; w = r.w; h = r.h; }
        const inv = new Float32Array(w * h);
        for (let i = 0; i < w * h; i++) inv[i] = v[i] ? 0 : 1;
        const g = centralGradients(gaussianBlur(lum, w, h, 0.7), w, h);
        const of = orientationField(lum, w, h);
        levels.push({ w, h, lum, valid: v, ori: of.ori, oE: integral(of.energy, w, h), invalidI: integral(inv, w, h), gx: g.gx, gy: g.gy });
    }
    return { levels };
}

// ============================================================================================
// Textured render for matching
// ============================================================================================

interface RenderLevel {
    w: number; h: number; lum: Float32Array; ori: Float32Array; oE: Integral;
    /** 1 where every full-resolution pixel below hit geometry. */
    geom: Uint8Array; geomI: Integral;
    /** 1 where a depth step lies under the pixel. */
    step: Uint8Array;
    /** Preferred matching level of the pixel (continuous, from the texel size). */
    pref: Float32Array;
    gx: Float32Array; gy: Float32Array;
}

export interface MatchRender {
    cam: FrameCamera;
    /** Camera-z depth at pixel centres (PLATE_EMPTY_DEPTH where no geometry). */
    depth: Float32Array;
    /** Projected texel size (px) of the scan texture; 0 where untextured / empty. */
    texelPx: Float32Array;
    levels: RenderLevel[];
    /** Render RGBA (full resolution), for overlays. */
    rgba: Buffer;
}

/** Supersampled textured render with depth, depth-step and texel-size maps and a matching pyramid. */
export function renderForMatching(prims: TexturedPrimitive[], cam: FrameCamera, opts: { supersample?: number; maxLevel?: number; textureBlurTexels?: number } = {}): MatchRender {
    const ss = Math.max(1, Math.round(opts.supersample ?? DEF.supersample));
    const W = cam.width, H = cam.height;
    const sc: FrameCamera = { ...cam, width: W * ss, height: H * ss, fx: cam.fx * ss, fy: cam.fy * ss, cx: cam.cx * ss, cy: cam.cy * ss };
    const r = renderTexturedView(prims, sc, [0, 0, 0], true);
    const SW = W * ss;
    const rgba = Buffer.alloc(W * H * 4);
    const lum = new Float32Array(W * H), depth = new Float32Array(W * H).fill(PLATE_EMPTY_DEPTH), texelPx = new Float32Array(W * H);
    const geom = new Uint8Array(W * H), step = new Uint8Array(W * H);
    const n = ss * ss;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        let R = 0, G = 0, B = 0, hits = 0, dmin = Infinity, dmax = 0, dsum = 0, tsum = 0;
        for (let j = 0; j < ss; j++) for (let i = 0; i < ss; i++) {
            const k = (y * ss + j) * SW + x * ss + i;
            R += r.rgba[k * 4]; G += r.rgba[k * 4 + 1]; B += r.rgba[k * 4 + 2];
            const d = r.depth[k];
            if (d < EMPTY) { hits++; dsum += d; if (d < dmin) dmin = d; if (d > dmax) dmax = d; tsum += r.texelMeters![k]; }
        }
        const p = y * W + x;
        rgba[p * 4] = R / n; rgba[p * 4 + 1] = G / n; rgba[p * 4 + 2] = B / n; rgba[p * 4 + 3] = 255;
        lum[p] = (0.299 * R + 0.587 * G + 0.114 * B) / n;
        if (hits === n) {
            geom[p] = 1;
            if (dmax > dmin * 1.02 + 0.05) { step[p] = 1; depth[p] = dmin; } else depth[p] = dsum / hits;
        } else if (hits > 0) { step[p] = 1; depth[p] = dmin; }
        if (hits > 0) texelPx[p] = (tsum / hits) * cam.fx / (dsum / hits);
    }
    // depth steps between neighbouring pixels
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const p = y * W + x;
        if (!geom[p]) continue;
        const d = depth[p];
        if (x + 1 < W && geom[p + 1] && Math.abs(depth[p + 1] - d) > 0.03 * Math.min(d, depth[p + 1]) + 0.05) { step[p] = 1; step[p + 1] = 1; }
        if (y + 1 < H && geom[p + W] && Math.abs(depth[p + W] - d) > 0.03 * Math.min(d, depth[p + W]) + 0.05) { step[p] = 1; step[p + W] = 1; }
    }
    const maxLevel = opts.maxLevel ?? DEF.maxLevel, blurT = opts.textureBlurTexels ?? DEF.textureBlurTexels;
    const pref0 = new Float32Array(W * H);
    for (let p = 0; p < W * H; p++) pref0[p] = texelPx[p] > 0 ? Math.max(0, Math.log2(Math.max(1, texelPx[p] * blurT))) : -1;
    const levels: RenderLevel[] = [];
    let L: Float32Array = lum, g: Uint8Array = geom, s: Uint8Array = step, pr: Float32Array = pref0, w = W, h = H;
    for (let l = 0; l <= maxLevel; l++) {
        if (l > 0) {
            const red = reduce2(L, w, h);
            const g2 = reduceMaskAll(g, w, h), s2 = reduceMaskAny(s, w, h);
            const w2 = red.w, h2 = red.h;
            const p2 = new Float32Array(w2 * h2);
            for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) {
                const i = 2 * y * w + 2 * x;
                p2[y * w2 + x] = Math.min(pr[i], pr[i + 1], pr[i + w], pr[i + w + 1]);
            }
            L = red.data; g = g2; s = s2; pr = p2; w = w2; h = h2;
        }
        const gf = new Float32Array(w * h);
        for (let i = 0; i < w * h; i++) gf[i] = g[i];
        const gr = centralGradients(gaussianBlur(L, w, h, 0.7), w, h);
        const of = orientationField(L, w, h);
        levels.push({ w, h, lum: L, ori: of.ori, oE: integral(of.energy, w, h), geom: g, geomI: integral(gf, w, h), step: s, pref: pr, gx: gr.gx, gy: gr.gy });
    }
    return { cam, depth, texelPx, levels, rgba };
}

/** World point under a render pixel location (continuous full-res px), or null (empty / depth step / too near). */
function liftRender(rd: MatchRender, u: number, v: number, minDepth: number, relTol = 0.02): V3 | null {
    const W = rd.cam.width, H = rd.cam.height;
    const fx = u - 0.5, fy = v - 0.5;
    if (fx < 0 || fy < 0 || fx > W - 1 || fy > H - 1) return null;
    const x0 = fx | 0, y0 = fy | 0, x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1);
    const d00 = rd.depth[y0 * W + x0], d10 = rd.depth[y0 * W + x1], d01 = rd.depth[y1 * W + x0], d11 = rd.depth[y1 * W + x1];
    if (!(d00 < EMPTY && d10 < EMPTY && d01 < EMPTY && d11 < EMPTY)) return null;
    const lo = Math.min(d00, d10, d01, d11), hi = Math.max(d00, d10, d01, d11);
    if (hi > lo * (1 + relTol) + 0.05) return null;
    const ax = fx - x0, ay = fy - y0;
    const d = (d00 * (1 - ax) + d10 * ax) * (1 - ay) + (d01 * (1 - ax) + d11 * ax) * ay;
    if (d < minDepth) return null;
    return rayPoint(rd.cam, u, v, d);
}

function rayPoint(cam: FrameCamera, u: number, v: number, depth: number): V3 {
    const a = (u - cam.cx) / cam.fx, b = (v - cam.cy) / cam.fy;
    return [
        cam.eye[0] + depth * (cam.fwd[0] + a * cam.right[0] - b * cam.up[0]),
        cam.eye[1] + depth * (cam.fwd[1] + a * cam.right[1] - b * cam.up[1]),
        cam.eye[2] + depth * (cam.fwd[2] + a * cam.right[2] - b * cam.up[2])
    ];
}

function depthAt(rd: MatchRender, u: number, v: number): number {
    const x = Math.floor(u), y = Math.floor(v);
    if (x < 0 || y < 0 || x >= rd.cam.width || y >= rd.cam.height) return PLATE_EMPTY_DEPTH;
    return rd.depth[y * rd.cam.width + x];
}

// ============================================================================================
// Point matching (render keypoints -> photo)
// ============================================================================================

interface Peak { dx: number; dy: number; c1: number; c2: number; atBorder: boolean }

/**
 * Orientation-correlation block search: template `t` (interleaved orientation tensor of (2r+1)^2 pixels, norm tn)
 * against the field `img` around integer centre (cx, cy), offsets in [-R, R]^2. Score = cosine similarity
 * (sum t . o) / (|t| |o|), in [-1, 1]. Positions whose patch leaves the image or has more than `maxInvalid` masked
 * pixels score -2.
 */
function nccSearch(
    t: Float32Array, tn: number, img: Float32Array, E: Integral, invI: Integral | null, w: number, h: number,
    cx: number, cy: number, r: number, R: number, maxInvalid: number
): Float32Array {
    const S = 2 * R + 1, P = 2 * r + 1;
    const out = new Float32Array(S * S).fill(-2);
    for (let oy = -R; oy <= R; oy++) {
        const py = cy + oy;
        if (py - r < 0 || py + r >= h) continue;
        for (let ox = -R; ox <= R; ox++) {
            const px = cx + ox;
            if (px - r < 0 || px + r >= w) continue;
            if (invI) { const [bad] = boxSums(invI, px - r, py - r, px + r + 1, py + r + 1); if (bad > maxInvalid) continue; }
            const [e] = boxSums(E, px - r, py - r, px + r + 1, py + r + 1);
            if (!(e > 1e-6)) continue;
            let cross = 0, k = 0;
            for (let j = -r; j <= r; j++) {
                let q = 2 * ((py + j) * w + px - r);
                for (let i = 0; i < 2 * P; i++) cross += t[k++] * img[q++];
            }
            out[(oy + R) * S + ox + R] = cross / (tn * Math.sqrt(e));
        }
    }
    return out;
}

function analysePeak(sc: Float32Array, R: number, exclusion = 2): Peak | null {
    const S = 2 * R + 1;
    let bi = -1, bv = -Infinity;
    for (let i = 0; i < sc.length; i++) if (sc[i] > bv) { bv = sc[i]; bi = i; }
    if (bi < 0 || bv <= -1.5) return null;
    const bx = bi % S, by = (bi / S) | 0;
    let c2 = -1;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        if (Math.max(Math.abs(x - bx), Math.abs(y - by)) < exclusion) continue;
        const v = sc[y * S + x];
        if (v <= c2) continue;
        let isMax = true;
        for (let j = -1; j <= 1 && isMax; j++) for (let i = -1; i <= 1; i++) {
            if (!i && !j) continue;
            const xx = x + i, yy = y + j;
            if (xx < 0 || yy < 0 || xx >= S || yy >= S) continue;
            if (sc[yy * S + xx] > v) { isMax = false; break; }
        }
        if (isMax) c2 = v;
    }
    const atBorder = bx === 0 || by === 0 || bx === S - 1 || by === S - 1;
    let sx = 0, sy = 0;
    if (!atBorder) {
        const l = sc[by * S + bx - 1], rr = sc[by * S + bx + 1], u = sc[(by - 1) * S + bx], d = sc[(by + 1) * S + bx];
        const denx = l - 2 * bv + rr, deny = u - 2 * bv + d;
        if (l > -1.5 && rr > -1.5 && denx < 0) sx = Math.max(-0.5, Math.min(0.5, 0.5 * (l - rr) / denx));
        if (u > -1.5 && d > -1.5 && deny < 0) sy = Math.max(-0.5, Math.min(0.5, 0.5 * (u - d) / deny));
    }
    return { dx: bx - R + sx, dy: by - R + sy, c1: bv, c2, atBorder };
}

/** All 3x3 local maxima of a score map with value >= minVal (subpixel offsets), best first. */
function localMaxima(sc: Float32Array, R: number, minVal: number): Array<{ dx: number; dy: number; v: number; atBorder: boolean }> {
    const S = 2 * R + 1;
    const out: Array<{ dx: number; dy: number; v: number; atBorder: boolean }> = [];
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        const v = sc[y * S + x];
        if (v < minVal) continue;
        let isMax = true;
        for (let j = -1; j <= 1 && isMax; j++) for (let i = -1; i <= 1; i++) {
            if (!i && !j) continue;
            const xx = x + i, yy = y + j;
            if (xx < 0 || yy < 0 || xx >= S || yy >= S) continue;
            if (sc[yy * S + xx] > v) { isMax = false; break; }
        }
        if (!isMax) continue;
        const atBorder = x === 0 || y === 0 || x === S - 1 || y === S - 1;
        let sx = 0, sy = 0;
        if (!atBorder) {
            const l = sc[y * S + x - 1], rr = sc[y * S + x + 1], u = sc[(y - 1) * S + x], d = sc[(y + 1) * S + x];
            const denx = l - 2 * v + rr, deny = u - 2 * v + d;
            if (l > -1.5 && rr > -1.5 && denx < 0) sx = Math.max(-0.5, Math.min(0.5, 0.5 * (l - rr) / denx));
            if (u > -1.5 && d > -1.5 && deny < 0) sy = Math.max(-0.5, Math.min(0.5, 0.5 * (u - d) / deny));
        }
        out.push({ dx: x - R + sx, dy: y - R + sy, v, atBorder });
    }
    return out.sort((a, b) => b.v - a.v);
}

/** Orientation-tensor template (interleaved) of the (2r+1)^2 patch at (cx, cy); `rms` is the RMS gradient magnitude. */
function extractTemplate(ori: Float32Array, w: number, cx: number, cy: number, r: number): { t: Float32Array; norm: number; rms: number } {
    const P = 2 * r + 1;
    const t = new Float32Array(2 * P * P);
    let k = 0, n2 = 0;
    for (let j = -r; j <= r; j++) {
        let q = 2 * ((cy + j) * w + cx - r);
        for (let i = 0; i < 2 * P; i++) { const v = ori[q++]; t[k++] = v; n2 += v * v; }
    }
    return { t, norm: Math.sqrt(n2), rms: Math.sqrt(n2 / (P * P)) };
}

/**
 * 1-D edge profile search. Template: |grad . n| of the source image sampled across the edge (points `pts`, offsets
 * t in [-hw, hw], shifted by `srcShift` along n). Scores: NCC against the destination's |grad . n| at shifts d in
 * [-D, D] (step 0.5 level px). Positions with more than 20 % masked destination samples score -2.
 */
function profileSearch(
    sgx: Float32Array, sgy: Float32Array, sw: number, sh: number, srcShift: number,
    dgx: Float32Array, dgy: Float32Array, dw: number, dh: number, dValid: Uint8Array | null,
    pts: Array<[number, number]>, nx: number, ny: number, hw: number, D: number
): { scores: Float64Array; invalidFrac: number } | null {
    const prof: number[] = [];
    for (const [x, y] of pts) for (let t = -hw; t <= hw; t++) {
        const px = x + (t + srcShift) * nx, py = y + (t + srcShift) * ny;
        const gx = bilinear(sgx, sw, sh, px, py), gy = bilinear(sgy, sw, sh, px, py);
        if (!(gx === gx)) return null;
        prof.push(Math.abs(gx * nx + gy * ny));
    }
    let pm = 0; for (const v of prof) pm += v; pm /= prof.length;
    let pn = 0; for (let i = 0; i < prof.length; i++) { prof[i] -= pm; pn += prof[i] * prof[i]; }
    if (!(pn > 1e-6)) return null;
    const nd = 4 * D + 1;
    const scores = new Float64Array(nd).fill(-2);
    let invalidFrac = 0;
    const q = new Float64Array(prof.length);
    for (let di = 0; di < nd; di++) {
        const d = -D + di * 0.5;
        let k = 0, inval = 0, out = false;
        for (const [x, y] of pts) {
            for (let t = -hw; t <= hw; t++) {
                const px = x + (t + d) * nx, py = y + (t + d) * ny;
                const gx = bilinear(dgx, dw, dh, px, py), gy = bilinear(dgy, dw, dh, px, py);
                if (!(gx === gx)) { out = true; break; }
                if (dValid && !dValid[Math.floor(py) * dw + Math.floor(px)]) inval++;
                q[k++] = Math.abs(gx * nx + gy * ny);
            }
            if (out) break;
        }
        if (out) continue;
        if (di === 2 * D) invalidFrac = inval / k;
        if (inval > 0.2 * k) continue;
        let qm = 0; for (let i = 0; i < k; i++) qm += q[i]; qm /= k;
        let cross = 0, qn = 0;
        for (let i = 0; i < k; i++) { const c = q[i] - qm; cross += prof[i] * c; qn += c * c; }
        if (qn > 1e-9) scores[di] = cross / Math.sqrt(pn * qn);
    }
    return { scores, invalidFrac };
}

/** Best position (sub-step refined) of a 1-D score array, its value and the best other local maximum >= 3 steps away. */
function profilePeak(sc: Float64Array): { pos: number; v: number; second: number; interior: boolean } | null {
    const nd = sc.length;
    let bi = -1, bv = -Infinity;
    for (let i = 0; i < nd; i++) if (sc[i] > bv) { bv = sc[i]; bi = i; }
    if (bi < 0 || bv < -1.5) return null;
    let c2 = -1;
    for (let i = 0; i < nd; i++) {
        if (Math.abs(i - bi) < 3) continue;
        const v = sc[i];
        if ((i === 0 || sc[i - 1] <= v) && (i === nd - 1 || sc[i + 1] <= v) && v > c2) c2 = v;
    }
    const interior = bi > 0 && bi < nd - 1;
    let sub = 0;
    if (interior) {
        const a = sc[bi - 1], c = sc[bi + 1], den = a - 2 * bv + c;
        if (a > -1.5 && c > -1.5 && den < 0) sub = Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / den));
    }
    return { pos: bi + sub, v: bv, second: c2, interior };
}

/** Shi-Tomasi corner response (min eigenvalue of the smoothed structure tensor). */
function cornerResponse(lv: RenderLevel): Float32Array {
    const { w, h, gx, gy } = lv;
    const a = new Float32Array(w * h), b = new Float32Array(w * h), c = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) { a[i] = gx[i] * gx[i]; b[i] = gx[i] * gy[i]; c[i] = gy[i] * gy[i]; }
    const A = gaussianBlur(a, w, h, 1.2), B = gaussianBlur(b, w, h, 1.2), C = gaussianBlur(c, w, h, 1.2);
    const out = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) { const tr = 0.5 * (A[i] + C[i]); out[i] = tr - Math.sqrt(Math.max(0, 0.25 * (A[i] - C[i]) ** 2 + B[i] * B[i])); }
    return out;
}

export interface MatchFrameOptions { searchPx: number }

// ============================================================================================
// Pose model helpers
// ============================================================================================

function camFor(input: FeaturePanoInput, f: number, corr: PoseCorrection): FrameCamera {
    const fr = input.frames[f];
    return frameCamera(input.nominalEye, fr.headingDeg, fr.pitchDeg, fr.fovDeg, fr.image.width, fr.image.height, corr, input.referenceHeadingDeg);
}

/** Pano correction whose camera for frame `f` best reproduces an absolute camera (eye + axes). */
function correctionFromCamera(input: FeaturePanoInput, f: number, eye: V3, right: V3, up: V3, fwd: V3): PoseCorrection {
    const t = [eye[0] - input.nominalEye[0], eye[1] - input.nominalEye[1], eye[2] - input.nominalEye[2]];
    let a = [0, 0, 0];
    const res = (ang: number[]) => {
        const c = camFor(input, f, { dx: 0, dy: 0, dz: 0, dyawDeg: ang[0], dpitchDeg: ang[1], drollDeg: ang[2] });
        return [...c.right.map((v, i) => v - right[i]), ...c.up.map((v, i) => v - up[i]), ...c.fwd.map((v, i) => v - fwd[i])];
    };
    for (let it = 0; it < 12; it++) {
        const r0 = res(a);
        const J: number[][] = [];
        for (let k = 0; k < 3; k++) { const b = a.slice(); b[k] += 1e-4; const r1 = res(b); J.push(r1.map((v, i) => (v - r0[i]) / 1e-4)); }
        const A = new Float64Array(9), g = new Float64Array(3);
        for (let i = 0; i < 3; i++) { for (let j = 0; j < 3; j++) { let s = 0; for (let k = 0; k < 9; k++) s += J[i][k] * J[j][k]; A[i * 3 + j] = s + (i === j ? 1e-9 : 0); } let s = 0; for (let k = 0; k < 9; k++) s += J[i][k] * r0[k]; g[i] = -s; }
        const d = solveSpd(A, g, 3);
        if (!d) break;
        a = a.map((v, i) => v + d[i]);
        if (Math.hypot(d[0], d[1], d[2]) < 1e-6) break;
    }
    return { dx: t[0], dy: t[1], dz: t[2], dyawDeg: a[0], dpitchDeg: a[1], drollDeg: a[2] };
}

/** Image displacement (px) between two cameras over a set of world points (RMS); null when none project. */
function displacementRms(c1: FrameCamera, c2: FrameCamera, pts: V3[]): number | null {
    let s = 0, n = 0;
    for (const X of pts) {
        const a = projectToFrame(c1, X), b = projectToFrame(c2, X);
        if (!a || !b) continue;
        s += (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2; n++;
    }
    return n ? Math.sqrt(s / n) : null;
}

/** Bounded Nelder-Mead (vertices clamped into the box); minimises f. */
function nelderMead(f: (x: number[]) => number, x0: number[], step: number[], lo: number[], hi: number[], maxEvals: number, tol = 1e-5): { x: number[]; fx: number; evals: number } {
    const n = x0.length;
    const clamp = (x: number[]) => x.map((v, i) => Math.min(hi[i], Math.max(lo[i], v)));
    let simplex: number[][] = [clamp(x0)];
    for (let i = 0; i < n; i++) { const v = x0.slice(); v[i] += step[i]; if (v[i] > hi[i]) v[i] = x0[i] - step[i]; simplex.push(clamp(v)); }
    let values = simplex.map(f);
    let evals = simplex.length;
    while (evals < maxEvals) {
        const order = values.map((_, i) => i).sort((a, b) => values[a] - values[b]);
        simplex = order.map(i => simplex[i]); values = order.map(i => values[i]);
        if (Math.abs(values[n] - values[0]) <= tol) break;
        const c = new Array(n).fill(0);
        for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) c[j] += simplex[i][j] / n;
        const along = (t: number) => clamp(c.map((cj, j) => cj + t * (simplex[n][j] - cj)));
        const xr = along(-1), fr = f(xr); evals++;
        if (fr < values[0]) {
            const xe = along(-2), fe = f(xe); evals++;
            if (fe < fr) { simplex[n] = xe; values[n] = fe; } else { simplex[n] = xr; values[n] = fr; }
        } else if (fr < values[n - 1]) { simplex[n] = xr; values[n] = fr; }
        else {
            const outside = fr < values[n];
            const xc = along(outside ? -0.5 : 0.5), fc = f(xc); evals++;
            if (fc < (outside ? fr : values[n])) { simplex[n] = xc; values[n] = fc; }
            else for (let i = 1; i <= n; i++) { simplex[i] = clamp(simplex[i].map((v, j) => simplex[0][j] + 0.5 * (v - simplex[0][j]))); values[i] = f(simplex[i]); evals++; }
        }
    }
    let b = 0;
    for (let i = 1; i < values.length; i++) if (values[i] < values[b]) b = i;
    return { x: simplex[b], fx: values[b], evals };
}

/** Camera of a frame at pyramid level l (pixel j of level l covers full-resolution [j 2^l, (j + 1) 2^l)). */
function cameraAtLevel(cam: FrameCamera, l: number): FrameCamera {
    const k = 1 / (1 << l);
    return { ...cam, width: cam.width >> l, height: cam.height >> l, fx: cam.fx * k, fy: cam.fy * k, cx: cam.cx * k, cy: cam.cy * k };
}

// ============================================================================================
// The registrar
// ============================================================================================

interface Stage { searchPx: number; patchPx: number }
interface Residualizable { pts: FeatureMatch[]; edges: Array<{ frame: number; X: V3; nx: number; ny: number; u: number; v: number; sigma: number }> }

export class StreetViewFeatureRegistrar {
    readonly prims: TexturedPrimitive[];
    readonly opts: FeatureRegistrationOptions;
    readonly priors: FeaturePriors;
    readonly bounds: FeatureBounds;
    /** Counters of the last matchFrame call (diagnostics). */
    lastMatchStats: Record<string, number> = {};

    constructor(prims: TexturedPrimitive[], opts: FeatureRegistrationOptions = {}) {
        this.prims = prims;
        this.opts = opts;
        this.priors = { ...DEFAULT_FEATURE_PRIORS, ...(opts.priors ?? {}) };
        this.bounds = { ...DEFAULT_FEATURE_BOUNDS, ...(opts.bounds ?? {}) };
    }

    private o<K extends keyof typeof DEF>(k: K): (typeof DEF)[K] {
        return ((this.opts as any)[k] ?? DEF[k]) as (typeof DEF)[K];
    }
    private log(m: string) { this.opts.log?.(m); }

    camera(input: FeaturePanoInput, f: number, corr: PoseCorrection): FrameCamera { return camFor(input, f, corr); }

    render(cam: FrameCamera): MatchRender {
        return renderForMatching(this.prims, cam, { supersample: this.o('supersample'), maxLevel: this.o('maxLevel'), textureBlurTexels: this.o('textureBlurTexels') });
    }

    photoPyramid(fr: FeatureFrameInput): PhotoPyramid { return buildPhotoPyramid(fr.image, fr.valid, this.o('maxLevel')); }

    /**
     * Matches render keypoints into the photo within `searchPx` (full resolution) of their rendered location.
     * Each keypoint is matched at its preferred pyramid level; ratio test and mutual check as described above.
     */
    matchFrame(frameIndex: number, rd: MatchRender, ph: PhotoPyramid, searchPx: number, patchPx = 64, multiPeak = false): FeatureMatch[] {
        const minStd = this.o('minPatchStd'), minNcc = this.o('minNcc'), minMargin = this.o('minMargin');
        const perLevel = this.o('keypointsPerLevel'), cell = this.o('gridCellPx'), perCell = this.o('perCell'), minDepth = this.o('minDepthMeters');
        const out: FeatureMatch[] = [];
        const st: Record<string, number> = { candidates: 0, keypoints: 0, lowStd: 0, noLift: 0, noPeak: 0, border: 0, lowNcc: 0, ambiguous: 0, mutual: 0, ok: 0 };
        this.lastMatchStats = st;
        const maxLevel = Math.min(rd.levels.length, ph.levels.length) - 1;
        for (let l = 0; l <= maxLevel; l++) {
            const lv = rd.levels[l], pl = ph.levels[l];
            const w = lv.w, h = lv.h, sc = 1 << l;
            const R = Math.max(2, Math.ceil(searchPx / sc));
            const r = Math.max(this.o('minPatchRadius'), Math.min(this.o('maxPatchRadius'), Math.round(patchPx / 2 / sc)));
            const P = 2 * r + 1, np = P * P;
            const resp = cornerResponse(lv);
            // candidates: local maxima at their preferred level, fully on geometry, away from depth steps
            const cand: Array<{ x: number; y: number; s: number }> = [];
            const margin = r + 1;
            for (let y = margin; y < h - margin; y++) for (let x = margin; x < w - margin; x++) {
                const i = y * w + x;
                const pf = lv.pref[i];
                if (pf < 0) continue;
                const lvlOk = l === 0 ? pf < 0.5 : l === maxLevel ? pf >= l - 0.5 : pf >= l - 0.5 && pf < l + 0.5;
                if (!lvlOk || !lv.geom[i] || lv.step[i]) continue;
                const v = resp[i];
                if (!(v > 1)) continue;
                let isMax = true;
                for (let j = -2; j <= 2 && isMax; j++) for (let k = -2; k <= 2; k++) { if ((j || k) && resp[i + j * w + k] > v) { isMax = false; break; } }
                if (!isMax) continue;
                const [g] = boxSums(lv.geomI, x - r, y - r, x + r + 1, y + r + 1);
                if (g < 0.9 * np) continue;
                cand.push({ x, y, s: v });
            }
            cand.sort((a, b) => b.s - a.s);
            st.candidates += cand.length;
            const cellL = Math.max(4, Math.round(cell / sc));
            const cells = new Map<number, number>();
            let used = 0;
            for (const c of cand) {
                if (used >= perLevel) break;
                const key = Math.floor(c.y / cellL) * 10000 + Math.floor(c.x / cellL);
                const n = cells.get(key) ?? 0;
                if (n >= perCell) continue;
                const tmpl = extractTemplate(lv.ori, w, c.x, c.y, r);
                if (tmpl.rms < minStd) { st.lowStd++; continue; }
                // 3D point under the keypoint (full-res location of the level pixel centre)
                const ur = (c.x + 0.5) * sc, vr = (c.y + 0.5) * sc;
                const X = liftRender(rd, ur, vr, minDepth);
                if (!X) { st.noLift++; continue; }
                cells.set(key, n + 1); used++; st.keypoints++;
                const s1 = nccSearch(tmpl.t, tmpl.norm, pl.ori, pl.oE, pl.invalidI, pl.w, pl.h, c.x, c.y, r, R, 0.1 * np);
                const pk = analysePeak(s1, R);
                if (!pk) { st.noPeak++; continue; }
                if (pk.atBorder) { st.border++; continue; }
                if (pk.c1 < minNcc) { st.lowNcc++; continue; }
                if (pk.c1 - pk.c2 < minMargin) {
                    st.ambiguous++;
                    if (!multiPeak) continue;
                    // keep every comparable peak; RANSAC picks the candidate consistent with one pose
                    const alts = localMaxima(s1, R, Math.max(minNcc, pk.c1 - 0.15)).filter(a => !a.atBorder).slice(0, 4)
                        .map(a => ({ u: (c.x + a.dx + 0.5) * sc, v: (c.y + a.dy + 0.5) * sc, ncc: a.v }));
                    if (!alts.length) continue;
                    st.multi = (st.multi ?? 0) + 1;
                    out.push({ frame: frameIndex, X, u: alts[0].u, v: alts[0].v, ur, vr, level: l, ncc: alts[0].ncc, margin: pk.c1 - pk.c2, alts });
                    continue;
                }
                // mutual check: the photo patch searched back in the render lands on the keypoint
                const qx = c.x + Math.round(pk.dx), qy = c.y + Math.round(pk.dy);
                if (qx - r < 0 || qy - r < 0 || qx + r >= pl.w || qy + r >= pl.h) continue;
                const back = extractTemplate(pl.ori, pl.w, qx, qy, r);
                if (!(back.norm > 1e-6)) continue;
                const s2 = nccSearch(back.t, back.norm, lv.ori, lv.oE, null, w, h, qx, qy, r, R, np);
                const pk2 = analysePeak(s2, R);
                if (!pk2 || Math.hypot(qx + pk2.dx - c.x, qy + pk2.dy - c.y) > 1.5) { st.mutual++; continue; }
                st.ok++;
                out.push({ frame: frameIndex, X, u: (c.x + pk.dx + 0.5) * sc, v: (c.y + pk.dy + 0.5) * sc, ur, vr, level: l, ncc: pk.c1, margin: pk.c1 - pk.c2 });
            }
        }
        return out;
    }

    // ----------------------------------------------------------------------------------------
    // Robust pose estimation
    // ----------------------------------------------------------------------------------------

    private thresholdPx(level: number): number { return Math.max(this.o('inlierThresholdPx'), 1.25 * (1 << level)); }
    private sigmaPx(level: number): number { return Math.max(0.6, 0.5 * (1 << level)); }

    private inBounds(c: PoseCorrection, slack = 1): boolean {
        const b = this.bounds;
        return Math.hypot(c.dx, c.dz) <= b.horizontalMeters * slack && Math.abs(c.dy) <= b.verticalMeters * slack &&
            Math.abs(c.dyawDeg) <= b.yawDeg * slack && Math.abs(c.dpitchDeg) <= b.pitchDeg * slack && Math.abs(c.drollDeg) <= b.rollDeg * slack;
    }

    /** Projects a correction into the search box. */
    clampToBounds(c: PoseCorrection): PoseCorrection {
        const b = this.bounds;
        const h = Math.hypot(c.dx, c.dz), k = h > b.horizontalMeters ? b.horizontalMeters / h : 1;
        const cl = (v: number, m: number) => Math.max(-m, Math.min(m, v));
        return { dx: c.dx * k, dy: cl(c.dy, b.verticalMeters), dz: c.dz * k, dyawDeg: cl(c.dyawDeg, b.yawDeg), dpitchDeg: cl(c.dpitchDeg, b.pitchDeg), drollDeg: cl(c.drollDeg, b.rollDeg) };
    }

    atBound(c: PoseCorrection): string[] {
        const b = this.bounds, out: string[] = [];
        if (Math.hypot(c.dx, c.dz) >= b.horizontalMeters * 0.98) out.push('horizontal');
        if (Math.abs(c.dy) >= b.verticalMeters * 0.98) out.push('vertical');
        if (Math.abs(c.dyawDeg) >= b.yawDeg * 0.98) out.push('yaw');
        if (Math.abs(c.dpitchDeg) >= b.pitchDeg * 0.98) out.push('pitch');
        if (Math.abs(c.drollDeg) >= b.rollDeg * 0.98) out.push('roll');
        return out;
    }

    /**
     * Point residuals (px) of matches under a correction (Infinity when behind the camera); an ambiguous match uses
     * its candidate nearest to the projection.
     */
    residualsPx(input: FeaturePanoInput, matches: FeatureMatch[], corr: PoseCorrection): number[] {
        const cams = input.frames.map((_, f) => camFor(input, f, corr));
        return matches.map(m => {
            const p = projectToFrame(cams[m.frame], m.X);
            if (!p) return Infinity;
            if (!m.alts) return Math.hypot(p[0] - m.u, p[1] - m.v);
            let best = Infinity;
            for (const a of m.alts) { const e = Math.hypot(p[0] - a.u, p[1] - a.v); if (e < best) best = e; }
            return best;
        });
    }

    /** Ambiguous matches resolved to the candidate nearest to their projection under `corr`. */
    resolve(input: FeaturePanoInput, matches: FeatureMatch[], corr: PoseCorrection): FeatureMatch[] {
        const cams = input.frames.map((_, f) => camFor(input, f, corr));
        return matches.map(m => {
            if (!m.alts) return m;
            const p = projectToFrame(cams[m.frame], m.X);
            if (!p) return { ...m, alts: undefined };
            let best = m.alts[0], be = Infinity;
            for (const a of m.alts) { const e = Math.hypot(p[0] - a.u, p[1] - a.v); if (e < be) { be = e; best = a; } }
            return { ...m, u: best.u, v: best.v, ncc: best.ncc, alts: undefined };
        });
    }

    private countInliers(input: FeaturePanoInput, matches: FeatureMatch[], corr: PoseCorrection): number {
        const res = this.residualsPx(input, matches, corr);
        let n = 0;
        for (let i = 0; i < matches.length; i++) if (res[i] <= this.thresholdPx(matches[i].level)) n++;
        return n;
    }

    /**
     * Robust MAP refinement of a pano correction: Huber-weighted point and edge residuals (in units of their sigma)
     * plus Gaussian priors on the correction; Levenberg-Marquardt with numeric derivatives.
     */
    refine(input: FeaturePanoInput, data: Residualizable, start: PoseCorrection, iterations = 25, priorWeight = 1): { corr: PoseCorrection; cost: number } {
        const huber = this.o('huber');
        const pr = this.priors;
        const sig = [pr.horizontalSigmaMeters, pr.verticalSigmaMeters, pr.horizontalSigmaMeters, pr.angleSigmaDeg, pr.angleSigmaDeg, pr.angleSigmaDeg];
        const nPts = data.pts.length, nEdge = data.edges.length;
        const resid = (p: number[]): Float64Array => {
            const c = arrCorr(p);
            const cams = input.frames.map((_, f) => camFor(input, f, c));
            const r = new Float64Array(2 * nPts + nEdge + 6);
            for (let i = 0; i < nPts; i++) {
                const m = data.pts[i];
                const q = projectToFrame(cams[m.frame], m.X);
                const s = this.sigmaPx(m.level);
                if (!q) { r[2 * i] = 1e3; r[2 * i + 1] = 1e3; continue; }
                r[2 * i] = (q[0] - m.u) / s; r[2 * i + 1] = (q[1] - m.v) / s;
            }
            for (let k = 0; k < nEdge; k++) {
                const e = data.edges[k];
                const q = projectToFrame(cams[e.frame], e.X);
                r[2 * nPts + k] = q ? (e.nx * (q[0] - e.u) + e.ny * (q[1] - e.v)) / e.sigma : 1e3;
            }
            for (let k = 0; k < 6; k++) r[2 * nPts + nEdge + k] = Math.sqrt(priorWeight) * p[k] / sig[k];
            return r;
        };
        const weights = (r: Float64Array): Float64Array => {
            const w = new Float64Array(r.length).fill(1);
            for (let i = 0; i < nPts; i++) { const e = Math.hypot(r[2 * i], r[2 * i + 1]); const wi = e <= huber ? 1 : huber / e; w[2 * i] = wi; w[2 * i + 1] = wi; }
            for (let k = 0; k < nEdge; k++) { const e = Math.abs(r[2 * nPts + k]); w[2 * nPts + k] = e <= huber ? 1 : huber / e; }
            return w;
        };
        const costOf = (r: Float64Array): number => {
            let c = 0;
            for (let i = 0; i < nPts; i++) { const e = Math.hypot(r[2 * i], r[2 * i + 1]); c += e <= huber ? e * e : 2 * huber * e - huber * huber; }
            for (let k = 0; k < nEdge; k++) { const e = Math.abs(r[2 * nPts + k]); c += e <= huber ? e * e : 2 * huber * e - huber * huber; }
            for (let k = 0; k < 6; k++) c += r[2 * nPts + nEdge + k] ** 2;
            return c;
        };
        let p = corrArr(start);
        let r = resid(p), cost = costOf(r), lambda = 1e-3;
        const steps = [1e-3, 1e-3, 1e-3, 1e-3, 1e-3, 1e-3];
        for (let it = 0; it < iterations; it++) {
            const w = weights(r);
            const J: Float64Array[] = [];
            for (let k = 0; k < 6; k++) { const q = p.slice(); q[k] += steps[k]; const r1 = resid(q); const col = new Float64Array(r.length); for (let i = 0; i < r.length; i++) col[i] = (r1[i] - r[i]) / steps[k]; J.push(col); }
            const A = new Float64Array(36), g = new Float64Array(6);
            for (let a = 0; a < 6; a++) {
                for (let b = a; b < 6; b++) { let s = 0; for (let i = 0; i < r.length; i++) s += w[i] * J[a][i] * J[b][i]; A[a * 6 + b] = s; A[b * 6 + a] = s; }
                let s = 0; for (let i = 0; i < r.length; i++) s += w[i] * J[a][i] * r[i]; g[a] = -s;
            }
            let improved = false;
            for (let tries = 0; tries < 8; tries++) {
                const Ad = A.slice();
                for (let a = 0; a < 6; a++) Ad[a * 6 + a] = A[a * 6 + a] * (1 + lambda) + 1e-9;
                const d = solveSpd(Ad, g, 6);
                if (!d) { lambda *= 10; continue; }
                const q = p.map((v, i) => v + d[i]);
                const rq = resid(q), cq = costOf(rq);
                if (cq < cost) {
                    const rel = (cost - cq) / Math.max(1e-12, cost);
                    p = q; r = rq; cost = cq; lambda = Math.max(1e-7, lambda * 0.3); improved = true;
                    if (rel < 1e-7) it = iterations;
                    break;
                }
                lambda *= 10;
            }
            if (!improved) break;
        }
        return { corr: arrCorr(p), cost };
    }

    /**
     * RANSAC over a pano's matches: EPnP hypotheses (solvePnP, fixed intrinsics) from 6-point samples of one frame and
     * prior-regularised hypotheses from 4-point samples, plus the current correction; scored by inlier count; the
     * best is refined robustly on its inliers (and re-scored).
     */
    robustSolve(input: FeaturePanoInput, matches: FeatureMatch[], current: PoseCorrection, rng: () => number): { corr: PoseCorrection; inliers: number; inlierMask: Uint8Array } {
        const iters = this.o('ransacIterations');
        const byFrame = new Map<number, number[]>();
        matches.forEach((m, i) => { if (!byFrame.has(m.frame)) byFrame.set(m.frame, []); byFrame.get(m.frame)!.push(i); });
        let best = current, bestN = this.countInliers(input, matches, current);
        const consider = (c: PoseCorrection | null) => {
            if (!c || !this.inBounds(c, 1.0)) return;
            const n = this.countInliers(input, matches, c);
            if (n > bestN) { bestN = n; best = c; }
        };
        const frames = [...byFrame.keys()];
        for (let it = 0; it < iters && frames.length; it++) {
            const f = frames[Math.floor(rng() * frames.length)];
            const idx = byFrame.get(f)!;
            const k = it % 2 === 0 ? 6 : 4;
            if (idx.length < k) continue;
            const sample: number[] = [];
            let guard = 0;
            while (sample.length < k && guard++ < 50) { const j = idx[Math.floor(rng() * idx.length)]; if (!sample.includes(j)) sample.push(j); }
            if (sample.length < k) continue;
            // an ambiguous match enters a sample with one of its candidates, drawn at random
            const pick = (j: number): FeatureMatch => {
                const m = matches[j];
                if (!m.alts) return m;
                const a = m.alts[Math.floor(rng() * m.alts.length)];
                return { ...m, u: a.u, v: a.v, alts: undefined };
            };
            const sub = sample.map(pick);
            if (k === 6) {
                const cam = camFor(input, f, current);
                try {
                    const pose = SpatialPoseEstimatorService.solvePnP(
                        sub.map(m => m.X as Point3D), sub.map(m => [m.u, m.v] as Point2D),
                        { fx: cam.fx, fy: cam.fy, cx: cam.cx, cy: cam.cy, width: cam.width, height: cam.height }, { maxIterations: 10 });
                    const R = pose.rotationMatrix;
                    const right: V3 = [R[0][0], R[0][1], R[0][2]], down: V3 = [R[1][0], R[1][1], R[1][2]], fwd: V3 = [R[2][0], R[2][1], R[2][2]];
                    consider(correctionFromCamera(input, f, pose.cameraCenterWorld as V3, right, [-down[0], -down[1], -down[2]], fwd));
                } catch { /* degenerate sample */ }
            } else {
                consider(this.refine(input, { pts: sub, edges: [] }, current, 8, 1).corr);
            }
        }
        // robust refinement on the inliers of the best hypothesis (generous threshold), then re-score
        const resolved = this.resolve(input, matches, best);
        const res = this.residualsPx(input, resolved, best);
        const sel = resolved.filter((m, i) => res[i] <= 3 * this.thresholdPx(m.level));
        let corr = best;
        if (sel.length >= 6) {
            const ref = this.refine(input, { pts: sel, edges: [] }, best).corr;
            if (this.inBounds(ref, 1.0) && this.countInliers(input, matches, ref) >= bestN * 0.98) corr = ref;
        }
        const fin = this.residualsPx(input, matches, corr);
        const inlierMask = new Uint8Array(matches.length);
        let n = 0;
        for (let i = 0; i < matches.length; i++) if (fin[i] <= this.thresholdPx(matches[i].level)) { inlierMask[i] = 1; n++; }
        return { corr, inliers: n, inlierMask };
    }

    // ----------------------------------------------------------------------------------------
    // Interior edges: 1-D location of render edges in the photo
    // ----------------------------------------------------------------------------------------

    measureEdges(frameIndex: number, rd: MatchRender, ph: PhotoPyramid, searchPx = this.o('edgeSearchPx')): EdgeMeasurement[] {
        const minLen = this.o('edgeMinLengthPx'), hw = this.o('edgeProfileHalfWidth'), minNcc = this.o('edgeMinNcc'), minMargin = this.o('minMargin');
        const minDepth = this.o('minDepthMeters');
        const out: EdgeMeasurement[] = [];
        const maxLevel = Math.min(rd.levels.length, ph.levels.length) - 1;
        for (let l = 0; l <= maxLevel; l++) {
            const lv = rd.levels[l], pl = ph.levels[l];
            const w = lv.w, h = lv.h, sc = 1 << l;
            // interior: geometry with a 2 px margin (never the sky silhouette)
            const interior = new Uint8Array(w * h);
            for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
                let ok = 1;
                for (let j = -2; j <= 2 && ok; j++) for (let i = -2; i <= 2; i++) if (!lv.geom[(y + j) * w + x + i]) { ok = 0; break; }
                interior[y * w + x] = ok;
            }
            const segs: LineSegment2D[] = detectLineSegments(gaussianBlur(lv.lum, w, h, 1.0), w, h, interior, { minLength: minLen, magnitudeThreshold: this.o('edgeMagnitudeThreshold'), maxWidth: 6, angleToleranceDeg: 22.5 });
            const D = Math.max(3, Math.ceil(searchPx / sc));
            // long segments are measured in pieces: the offset varies along an edge under a rotation error or a local
            // mesh error, and each piece is one sample of the edge statistic
            const chunk = Math.max(minLen, Math.round(this.o('edgeChunkPx') / sc));
            const pieces: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
            for (const sg of segs) {
                const L = Math.hypot(sg.x1 - sg.x0, sg.y1 - sg.y0);
                const k = Math.max(1, Math.round(L / chunk));
                for (let i = 0; i < k; i++) pieces.push({
                    x0: sg.x0 + (sg.x1 - sg.x0) * i / k, y0: sg.y0 + (sg.y1 - sg.y0) * i / k,
                    x1: sg.x0 + (sg.x1 - sg.x0) * (i + 1) / k, y1: sg.y0 + (sg.y1 - sg.y0) * (i + 1) / k
                });
            }
            for (const s of pieces) {
                const mx = 0.5 * (s.x0 + s.x1), my = 0.5 * (s.y0 + s.y1);
                const pf = lv.pref[Math.min(h - 1, Math.max(0, Math.floor(my))) * w + Math.min(w - 1, Math.max(0, Math.floor(mx)))];
                const lvlOk = pf >= 0 && (l === 0 ? pf < 0.5 : l === maxLevel ? pf >= l - 0.5 : pf >= l - 0.5 && pf < l + 0.5);
                if (!lvlOk) continue;
                const len = Math.hypot(s.x1 - s.x0, s.y1 - s.y0);
                const tx = (s.x1 - s.x0) / len, ty = (s.y1 - s.y0) / len, nx = -ty, ny = tx;
                const K = Math.max(4, Math.floor(len - 2));
                const pts: Array<[number, number]> = [];
                for (let k = 0; k < K; k++) { const t = (k + 0.5) / K; pts.push([s.x0 + (s.x1 - s.x0) * t, s.y0 + (s.y1 - s.y0) * t]); }
                // 1-D search: render profile (|gradient . n| across the edge) against the photo shifted along n
                const fwd = profileSearch(lv.gx, lv.gy, w, h, 0, pl.gx, pl.gy, pl.w, pl.h, pl.valid, pts, nx, ny, hw, D);
                if (!fwd || fwd.invalidFrac > 0.2) continue;
                const pk = profilePeak(fwd.scores);
                if (!pk) continue;
                let off: number | null = null;
                if (pk.interior && pk.v >= minNcc && pk.v - pk.second >= minMargin) {
                    const d1 = -D + pk.pos * 0.5;
                    // mutual check: the photo profile at the located edge, searched back in the render, lands on the edge
                    const back = profileSearch(pl.gx, pl.gy, pl.w, pl.h, d1, lv.gx, lv.gy, w, h, null, pts, nx, ny, hw, D);
                    const bk = back ? profilePeak(back.scores) : null;
                    if (bk && Math.abs(-D + bk.pos * 0.5) <= 1) off = d1 * sc;
                }
                const bv = pk.v, c2 = pk.second;
                // scan points along the edge: foreground side of a depth step
                const points: Array<{ X: V3; u: number; v: number }> = [];
                const stride = Math.max(1, Math.floor(pts.length / 12));
                for (let k = 0; k < pts.length; k += stride) {
                    const u = (pts[k][0]) * sc, v = (pts[k][1]) * sc;
                    const a = 1.5 * sc;
                    const dA = depthAt(rd, u - a * nx, v - a * ny), dB = depthAt(rd, u + a * nx, v + a * ny);
                    if (!(dA < EMPTY) || !(dB < EMPTY)) continue;
                    const d = Math.abs(dA - dB) > 0.02 * Math.min(dA, dB) + 0.05 ? Math.min(dA, dB) : depthAt(rd, u, v);
                    if (!(d < EMPTY) || d < minDepth) continue;
                    points.push({ X: rayPoint(rd.cam, u, v, d), u, v });
                }
                out.push({ frame: frameIndex, level: l, x0: s.x0 * sc, y0: s.y0 * sc, x1: s.x1 * sc, y1: s.y1 * sc, nx, ny, lengthPx: len * sc, offsetPx: off, ncc: bv, margin: bv - c2, points });
            }
        }
        return out;
    }

    /**
     * Truncated edge cost (px): weighted mean over every tested piece of min(|offset|, cap), an unlocated piece
     * counting as `cap`; weights as in edgeStats. Lower is better; it rewards both alignment and located edges.
     */
    static edgeCost(edges: EdgeMeasurement[], capPx: number): number {
        let s = 0, w = 0;
        for (const e of edges) {
            const wt = e.lengthPx / (1 << e.level);
            s += wt * (e.offsetPx === null ? capPx : Math.min(capPx, Math.abs(e.offsetPx)));
            w += wt;
        }
        return w > 0 ? s / w : capPx;
    }

    /**
     * Edge statistic: median of |offset| over located pieces, weighted by length in level pixels (lengthPx / 2^level),
     * i.e. by the number of independent samples at the precision the piece was measured with.
     */
    static edgeStats(edges: EdgeMeasurement[], minSegments = 12, capPx = DEF.edgeSearchPx): EdgeStats {
        const loc = edges.filter(e => e.offsetPx !== null);
        const vals = loc.map(e => Math.abs(e.offsetPx!)), wts = loc.map(e => e.lengthPx / (1 << e.level));
        const ok = loc.length >= minSegments;
        return {
            medianPx: ok ? weightedQuantile(vals, wts, 0.5) : null, p75Px: ok ? weightedQuantile(vals, wts, 0.75) : null,
            located: loc.length, tested: edges.length, locatedLengthPx: loc.reduce((a, e) => a + e.lengthPx, 0),
            truncatedCostPx: StreetViewFeatureRegistrar.edgeCost(edges, capPx)
        };
    }

    // ----------------------------------------------------------------------------------------
    // Photometric agreement: band-passed multi-scale NCC (photo vs textured render)
    // ----------------------------------------------------------------------------------------

    photometricNcc(rd: MatchRender, ph: PhotoPyramid): { ncc: number | null; pixels: number } {
        const maxLevel = Math.min(rd.levels.length, ph.levels.length) - 1;
        let sab = 0, n = 0;
        for (let l = 0; l <= maxLevel; l++) {
            const lv = rd.levels[l], pl = ph.levels[l];
            const w = lv.w, h = lv.h;
            const bp = (L: Float32Array) => { const a = gaussianBlur(L, w, h, 0.8), b = gaussianBlur(L, w, h, 3); const o = new Float32Array(w * h); for (let i = 0; i < o.length; i++) o[i] = a[i] - b[i]; return o; };
            const sel: number[] = [];
            for (let i = 0; i < w * h; i++) {
                const pf = lv.pref[i];
                if (pf < 0 || !lv.geom[i] || lv.step[i] || !pl.valid[i]) continue;
                if (l === 0 ? pf >= 0.5 : l === maxLevel ? pf < l - 0.5 : pf < l - 0.5 || pf >= l + 0.5) continue;
                sel.push(i);
            }
            if (sel.length < 200) continue;
            const A = bp(lv.lum), B = bp(pl.lum);
            let ma = 0, mb = 0;
            for (const i of sel) { ma += A[i]; mb += B[i]; }
            ma /= sel.length; mb /= sel.length;
            let va = 0, vb = 0;
            for (const i of sel) { va += (A[i] - ma) ** 2; vb += (B[i] - mb) ** 2; }
            const sa = Math.sqrt(va / sel.length), sb = Math.sqrt(vb / sel.length);
            if (!(sa > 1e-6 && sb > 1e-6)) continue;
            for (const i of sel) sab += ((A[i] - ma) / sa) * ((B[i] - mb) / sb);
            n += sel.length;
        }
        return { ncc: n ? sab / n : null, pixels: n };
    }

    /**
     * NCC of the photo's and the textured render's orientation fields (doubled-angle gradient, 2 channels, mean
     * subtracted) over interior pixels at pyramid levels `levels` (finer than the dense alignment's). Polarity free:
     * this is the photometric agreement measure used by the gates; the luminance NCC (photometricNcc) is reported
     * alongside but is ill-posed against a scan texture whose windows are dark where the photo's reflect the sky.
     */
    orientationNcc(rd: MatchRender, ph: PhotoPyramid, levels: number[] = [0, 1]): { ncc: number | null; pixels: number } {
        let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, n = 0;
        for (const l of levels) {
            if (l >= rd.levels.length || l >= ph.levels.length) continue;
            const lv = rd.levels[l], pl = ph.levels[l];
            for (let i = 0; i < lv.w * lv.h; i++) {
                if (!lv.geom[i] || lv.step[i] || !pl.valid[i]) continue;
                for (let c = 0; c < 2; c++) {
                    const a = lv.ori[2 * i + c], b = pl.ori[2 * i + c];
                    sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b;
                }
                n += 2;
            }
        }
        if (n < 400) return { ncc: null, pixels: n / 2 };
        const va = saa - sa * sa / n, vb = sbb - sb * sb / n;
        return { ncc: va > 0 && vb > 0 ? (sab - sa * sb / n) / Math.sqrt(va * vb) : null, pixels: n / 2 };
    }

    // ----------------------------------------------------------------------------------------
    // Dense coarse alignment: orientation correlation of photo and textured render over the whole frame
    // ----------------------------------------------------------------------------------------

    /**
     * Dense orientation correlation of a pano correction at pyramid level l over the given frames: the cosine
     * similarity of the photo's and the textured render's doubled-angle gradient fields, summed over every pixel that is
     * on scan geometry (no depth step) and usable in the photo. Polarity free (see orientationField). Also returns
     * the pixel count.
     */
    denseScore(input: FeaturePanoInput, photos: PhotoPyramid[], corr: PoseCorrection, l: number, frames: number[]): { score: number; pixels: number } {
        let dot = 0, er = 0, ep = 0, n = 0;
        for (const f of frames) {
            const pl = photos[f].levels[Math.min(l, photos[f].levels.length - 1)];
            const rd = renderForMatching(this.prims, cameraAtLevel(camFor(input, f, corr), l), { supersample: 2, maxLevel: 0, textureBlurTexels: this.o('textureBlurTexels') });
            const lv = rd.levels[0];
            if (lv.w !== pl.w || lv.h !== pl.h) continue;
            for (let i = 0; i < lv.w * lv.h; i++) {
                if (!lv.geom[i] || lv.step[i] || !pl.valid[i]) continue;
                const ra = lv.ori[2 * i], rb = lv.ori[2 * i + 1], pa = pl.ori[2 * i], pb = pl.ori[2 * i + 1];
                dot += ra * pa + rb * pb; er += ra * ra + rb * rb; ep += pa * pa + pb * pb; n++;
            }
        }
        return { score: er > 0 && ep > 0 ? dot / Math.sqrt(er * ep) : 0, pixels: n };
    }

    /**
     * Coarse dense alignment from a seed: a (yaw, pitch) grid at the coarse level, then bounded Nelder-Mead over the
     * six correction parameters at the coarse and the next finer level. Maximises denseScore minus a weak Gaussian
     * prior penalty. Returns the correction and its score at the finer level.
     */
    denseAlign(input: FeaturePanoInput, photos: PhotoPyramid[], seed: PoseCorrection, frames: number[]): { corr: PoseCorrection; score: number; evals: number } {
        const b = this.bounds, pr = this.priors;
        const lo = [-b.horizontalMeters, -b.verticalMeters, -b.horizontalMeters, -b.yawDeg, -b.pitchDeg, -b.rollDeg];
        const hi = lo.map(v => -v);
        const sig = [pr.horizontalSigmaMeters, pr.verticalSigmaMeters, pr.horizontalSigmaMeters, pr.angleSigmaDeg, pr.angleSigmaDeg, pr.angleSigmaDeg];
        const pw = this.o('densePriorWeight');
        let evals = 0;
        const cost = (x: number[], l: number) => {
            evals++;
            if (Math.hypot(x[0], x[2]) > b.horizontalMeters) return 1e3;
            let pen = 0;
            for (let k = 0; k < 6; k++) pen += (x[k] / sig[k]) ** 2;
            return -this.denseScore(input, photos, arrCorr(x), l, frames).score + pw * pen;
        };
        const [lc, lf] = this.o('denseLevels');
        // rotation grid at the coarse level
        const g = this.o('denseGridDeg'), st = this.o('denseGridStepDeg');
        let best = corrArr(seed), bestC = cost(best, lc);
        for (let dy = -g; dy <= g + 1e-9; dy += st) for (let dp = -g; dp <= g + 1e-9; dp += st) {
            if (!dy && !dp) continue;
            const x = corrArr(seed); x[3] += dy; x[4] += dp;
            const c = cost(x, lc);
            if (c < bestC) { bestC = c; best = x; }
        }
        const s1 = nelderMead(x => cost(x, lc), best, [0.75, 0.25, 0.75, 0.4, 0.4, 0.3], lo, hi, this.o('denseMaxEvals'));
        const s2 = nelderMead(x => cost(x, lf), s1.x, [0.4, 0.12, 0.4, 0.2, 0.2, 0.15], lo, hi, this.o('denseMaxEvals'));
        return { corr: arrCorr(s2.x), score: -s2.fx, evals };
    }

    // ----------------------------------------------------------------------------------------
    // Pano registration
    // ----------------------------------------------------------------------------------------

    private matchAll(input: FeaturePanoInput, photos: PhotoPyramid[], corr: PoseCorrection, stage: Stage, frames?: number[], multiPeak = false): FeatureMatch[] {
        const out: FeatureMatch[] = [];
        for (const f of frames ?? input.frames.map((_, i) => i)) {
            const rd = this.render(camFor(input, f, corr));
            for (const m of this.matchFrame(f, rd, photos[f], stage.searchPx, stage.patchPx, multiPeak)) out.push(m);
        }
        return out;
    }

    private edgeData(input: FeaturePanoInput, photos: PhotoPyramid[], corr: PoseCorrection, frames: number[]): { edges: Residualizable['edges']; measured: EdgeMeasurement[] } {
        const edges: Residualizable['edges'] = [];
        const measured: EdgeMeasurement[] = [];
        for (const f of frames) {
            const rd = this.render(camFor(input, f, corr));
            for (const e of this.measureEdges(f, rd, photos[f])) {
                measured.push(e);
                if (e.offsetPx === null) continue;
                const sigma = Math.max(0.6, 0.5 * (1 << e.level));
                for (const p of e.points) edges.push({ frame: f, X: p.X, nx: e.nx, ny: e.ny, u: p.u + e.offsetPx * e.nx, v: p.v + e.offsetPx * e.ny, sigma });
            }
        }
        return { edges, measured };
    }

    /** Coarse-to-fine stages (search radius, patch size). */
    stages(): Stage[] {
        const s = this.o('searchSchedulePx'), p = this.o('stagePatchPx');
        return s.map((v, i) => ({ searchPx: v, patchPx: p[Math.min(i, p.length - 1)] }));
    }

    /** Point stages (coarse-to-fine) and edge refinement for a subset of frames, from `start`. */
    private solveFrom(input: FeaturePanoInput, photos: PhotoPyramid[], start: PoseCorrection, frames: number[], stages: Stage[], rng: () => number): { corr: PoseCorrection; inliers: number; matches: FeatureMatch[]; inlierMask: Uint8Array } {
        let corr = start, matches: FeatureMatch[] = [], inl = 0, mask: Uint8Array = new Uint8Array(0);
        for (let si = 0; si < stages.length; si++) {
            const st = stages[si];
            matches = this.matchAll(input, photos, corr, st, frames, si === 0);
            if (matches.length < 6) { mask = new Uint8Array(matches.length); inl = 0; continue; }
            const s = this.robustSolve(input, matches, corr, rng);
            corr = s.corr; inl = s.inliers; mask = s.inlierMask;
            matches = this.resolve(input, matches, corr);
        }
        const fine = stages[stages.length - 1];
        // Edge rounds are accepted only while they lower the truncated edge cost (re-measured at the new pose), so the
        // refinement is monotone and cannot drift between grid aliases.
        let ed = this.edgeData(input, photos, corr, frames);
        let cost = StreetViewFeatureRegistrar.edgeCost(ed.measured, this.o('edgeSearchPx'));
        for (let it = 0; it < this.o('edgeIterations'); it++) {
            const pts = matches.filter((_, i) => mask[i]);
            const ref = this.clampToBounds(this.refine(input, { pts, edges: ed.edges }, corr).corr);
            const ed2 = this.edgeData(input, photos, ref, frames);
            const cost2 = StreetViewFeatureRegistrar.edgeCost(ed2.measured, this.o('edgeSearchPx'));
            const es = StreetViewFeatureRegistrar.edgeStats(ed2.measured);
            const accept = cost2 < cost - 1e-3;
            this.log(`[feature] ${input.panoId} frames ${frames.join(',')} edge round ${it}: ${pts.length} point inliers; truncated edge cost ${cost.toFixed(3)} -> ${cost2.toFixed(3)} px (median ${es.medianPx?.toFixed(2) ?? 'n/a'} px, ${es.located}/${es.tested} located) ${accept ? 'accepted' : 'rejected, stop'}`);
            if (!accept) break;
            corr = ref; ed = ed2; cost = cost2;
            matches = this.matchAll(input, photos, corr, fine, frames);
            const res = this.residualsPx(input, matches, corr);
            mask = new Uint8Array(matches.length);
            inl = 0;
            for (let i = 0; i < matches.length; i++) if (res[i] <= this.thresholdPx(matches[i].level)) { mask[i] = 1; inl++; }
        }
        return { corr, inliers: inl, matches, inlierMask: mask };
    }

    seeds(input: FeaturePanoInput): Array<{ label: string; corr: PoseCorrection }> {
        const out: Array<{ label: string; corr: PoseCorrection }> = [{ label: 'gps', corr: { ...ZERO_CORRECTION } }];
        (input.extraSeeds ?? []).forEach((c, i) => out.push({ label: `extra${i}`, corr: c }));
        const s = this.o('seedOffsetMeters');
        if (s > 0) {
            // mean horizontal view direction of the pano's frames
            let fx = 0, fz = 0;
            for (const fr of input.frames) { fx += Math.sin(fr.headingDeg * DEG); fz += -Math.cos(fr.headingDeg * DEG); }
            const l = Math.hypot(fx, fz) || 1; fx /= l; fz /= l;
            for (const [lab, ax, az] of [['fwd', fx, fz], ['back', -fx, -fz], ['left', fz, -fx], ['right', -fz, fx]] as Array<[string, number, number]>) {
                out.push({ label: lab, corr: { ...ZERO_CORRECTION, dx: ax * s, dz: az * s } });
            }
        }
        return out;
    }

    registerPano(input: FeaturePanoInput): FeaturePanoResult {
        const t0 = Date.now();
        const timings: Record<string, number> = {};
        const rng = mulberry32(this.o('randomSeed'));
        const photos = input.frames.map(f => this.photoPyramid(f));
        const all = input.frames.map((_, i) => i);
        const stages = this.stages();
        const fine = stages[stages.length - 1];
        // Stage A: dense coarse alignment from every seed (textured render at the seed pose)
        const tried: Array<{ label: string; score: number; corr: PoseCorrection; inliers: number; matches: number }> = [];
        for (const sd of this.seeds(input)) {
            const d = this.denseAlign(input, photos, sd.corr, all);
            tried.push({ label: sd.label, score: d.score, corr: d.corr, inliers: 0, matches: 0 });
            this.log(`[feature] ${input.panoId} seed ${sd.label}: dense score ${d.score.toFixed(4)} (${d.evals} evaluations)`);
        }
        timings.dense = Date.now() - t0;
        // Stages B + C (local features + RANSAC-PnP, interior-edge refinement) from the best dense seeds; the winner has
        // the lowest truncated interior-edge cost at its final pose
        const order = tried.map((_, i) => i).sort((a, b) => tried[b].score - tried[a].score).slice(0, Math.max(1, this.o('featureSeeds')));
        const t1 = Date.now();
        let bi = order[0], joint: ReturnType<StreetViewFeatureRegistrar['solveFrom']> | null = null, bestCost = Infinity;
        for (const i of order) {
            const sol = this.solveFrom(input, photos, tried[i].corr, all, stages, rng);
            const cost = StreetViewFeatureRegistrar.edgeCost(this.edgeData(input, photos, sol.corr, all).measured, this.o('edgeSearchPx'));
            tried[i].inliers = sol.inliers; tried[i].matches = sol.matches.length; (tried[i] as any).edgeCost = cost;
            this.log(`[feature] ${input.panoId} seed ${tried[i].label}: features + edges -> ${sol.inliers} inliers, truncated edge cost ${cost.toFixed(3)} px`);
            if (cost < bestCost) { bestCost = cost; bi = i; joint = sol; }
        }
        timings.joint = Date.now() - t1;
        const corr = joint!.corr;
        // per-frame reports
        const t2 = Date.now();
        const frames: FeatureFrameReport[] = input.frames.map((fr, f) => {
            const cam = camFor(input, f, corr);
            const rd = this.render(cam);
            const ms = this.matchFrame(f, rd, photos[f], fine.searchPx, fine.patchPx);
            const res = this.residualsPx(input, ms, corr);
            const inl = res.filter((r, i) => r <= this.thresholdPx(ms[i].level));
            const edges = StreetViewFeatureRegistrar.edgeStats(this.measureEdges(f, rd, photos[f]));
            const ncc = this.orientationNcc(rd, photos[f]), lum = this.photometricNcc(rd, photos[f]);
            const rd0 = this.render(camFor(input, f, ZERO_CORRECTION));
            const edges0 = StreetViewFeatureRegistrar.edgeStats(this.measureEdges(f, rd0, photos[f]));
            const ncc0 = this.orientationNcc(rd0, photos[f]), lum0 = this.photometricNcc(rd0, photos[f]);
            let heldOut: FeatureFrameReport['heldOut'] = null;
            if (input.frames.length > 1) {
                const others = all.filter(k => k !== f);
                const loo = this.solveFrom(input, photos, corr, others, [fine], rng);
                const camL = camFor(input, f, loo.corr);
                const rdL = this.render(camL);
                const msL = this.matchFrame(f, rdL, photos[f], fine.searchPx, fine.patchPx);
                const resL = this.residualsPx(input, msL, loo.corr);
                const pts = ms.filter((_, i) => res[i] <= this.thresholdPx(ms[i].level)).map(m => m.X);
                heldOut = {
                    correction: loo.corr, edges: StreetViewFeatureRegistrar.edgeStats(this.measureEdges(f, rdL, photos[f])),
                    inlierMedianPx: median(resL.filter((r, i) => r <= this.thresholdPx(msL[i].level))), displacementPx: displacementRms(cam, camL, pts)
                };
            }
            return {
                key: fr.key, matches: ms.length, inliers: inl.length, inlierMedianPx: median(inl), matchMedianPx: median(res.filter(Number.isFinite)),
                edges, edgesPrior: edges0, nccFinal: ncc.ncc, nccPrior: ncc0.ncc, nccPixels: ncc.pixels, lumNccFinal: lum.ncc, lumNccPrior: lum0.ncc, heldOut, camera: cam
            };
        });
        timings.measure = Date.now() - t2;
        timings.total = Date.now() - t0;
        const move = Math.hypot(corr.dx, corr.dz);
        return {
            panoId: input.panoId, nominalEye: input.nominalEye, referenceHeadingDeg: input.referenceHeadingDeg, correction: corr,
            moveMeters: move, moveBearingDeg: ((Math.atan2(corr.dx, -corr.dz) / DEG) + 360) % 360, atBound: this.atBound(corr),
            seed: { index: bi, label: tried[bi].label, denseScore: tried[bi].score, tried: tried.map(t => ({ label: t.label, denseScore: t.score, edgeCostPx: (t as any).edgeCost ?? null, inliers: t.inliers })) },
            inliers: joint!.inliers, matches: joint!.matches.length, frames, timingsMs: timings
        };
    }
}

// ============================================================================================
// Gates and pose quality (honest: every active gate counts, nothing measured is dropped)
// ============================================================================================

export interface FeatureGates {
    /** Max length-weighted median offset of located interior edges (px). */
    interiorEdgeMedianPx: number;
    /** Minimum located interior edge segments for an edge statistic to count. */
    minEdgeSegments: number;
    /** Orientation NCC (photo vs textured render) at the final pose minus at the GPS pose must exceed this. */
    minNccGain: number;
    /** Minimum PnP inliers of the frame at the final pose (a consensus exists). */
    minInliers: number;
    /** Max interior edge median (px) of a frame under the pose fitted to the OTHER frames of its pano. */
    heldOutEdgeMedianPx: number;
    /** Max median cross-view residual (px) with a partner pano. */
    crossViewMedianPx: number;
    /** Minimum cross-view matches with a partner pano for that check to count. */
    crossViewMinMatches: number;
}

export const DEFAULT_FEATURE_GATES: Readonly<FeatureGates> = Object.freeze({
    interiorEdgeMedianPx: 2, minEdgeSegments: 12, minNccGain: 0, minInliers: 12,
    heldOutEdgeMedianPx: 3, crossViewMedianPx: 2.5, crossViewMinMatches: 15
});

/** Statistics a feature gate decision needs (a frame report plus cross-view agreement, or the same read back from JSON). */
export interface FeatureGateInput {
    inliers: number;
    edgeMedianPx: number | null;
    edgeLocated: number;
    nccFinal: number | null;
    nccPrior: number | null;
    /** Held-out edge median under the pose of the pano's other frames (null: single-frame pano or unmeasured). */
    heldOutEdgeMedianPx: number | null;
    /** True when the pano has other frames (then the held-out check must be measurable). */
    hasOtherFrames: boolean;
    /** Best agreeing accepted partner pano: median px and matches (null when no partner has enough matches). */
    crossView: { medianPx: number; matches: number; partnerPanoId: string } | null;
    atBound: string[];
}

/** Reasons a frame fails the feature gates (empty = accepted). An unmeasured statistic fails as "unverified". */
export function evaluateFeatureGates(s: FeatureGateInput, g: FeatureGates = DEFAULT_FEATURE_GATES): string[] {
    const r: string[] = [];
    if (s.inliers < g.minInliers) r.push(`PnP inliers ${s.inliers} < ${g.minInliers}`);
    if (s.edgeMedianPx === null) r.push(`interior edges unverified (${s.edgeLocated} located < ${g.minEdgeSegments})`);
    else if (s.edgeMedianPx > g.interiorEdgeMedianPx) r.push(`interior edge median ${s.edgeMedianPx.toFixed(2)} px > ${g.interiorEdgeMedianPx}`);
    if (s.nccFinal === null || s.nccPrior === null) r.push('photometric (orientation) NCC unmeasured');
    else if (!(s.nccFinal - s.nccPrior > g.minNccGain)) r.push(`NCC gain ${(s.nccFinal - s.nccPrior).toFixed(3)} <= ${g.minNccGain} (final ${s.nccFinal.toFixed(3)}, GPS pose ${s.nccPrior.toFixed(3)})`);
    // Cross-frame agreement: every check that applies must be measured and pass, and at least one must apply
    const crossMeasured = s.crossView !== null && s.crossView.matches >= g.crossViewMinMatches;
    if (s.hasOtherFrames) {
        if (s.heldOutEdgeMedianPx === null) r.push('held-out check unverified (too few interior edges located under the other frames\' pose)');
        else if (s.heldOutEdgeMedianPx > g.heldOutEdgeMedianPx) r.push(`held-out edge median ${s.heldOutEdgeMedianPx.toFixed(2)} px > ${g.heldOutEdgeMedianPx} under the pose of the pano's other frames`);
    }
    if (crossMeasured && s.crossView!.medianPx > g.crossViewMedianPx) r.push(`cross-view median ${s.crossView!.medianPx.toFixed(2)} px with best partner ${s.crossView!.partnerPanoId} (${s.crossView!.matches} matches) > ${g.crossViewMedianPx}`);
    if (!s.hasOtherFrames && !crossMeasured) r.push('cross-frame agreement unverified (no other frame of the pano, no accepted partner pano with enough cross-view matches)');
    if (s.atBound.length) r.push(`solution at search bound (${s.atBound.join(', ')})`);
    return r;
}

/**
 * Pose quality in [0, 1] on the texture-fusion confidence scale (StationPlate.poseQuality multiplies a texel's
 * confidence; c >= 0.5 counts as confident). 0 when any gate fails. Otherwise q = 1 / (1 + r^2), r the WORST ratio
 * over every gated statistic: edge median / gate, held-out edge median / gate (when it applies), cross-view median /
 * gate (when measured), min inliers / inliers and the NCC term 1 / (1 + gain / 0.02) (1 at zero gain). A perfect fit
 * scores 1 and a frame at its worst gate 0.5. No gated statistic is ever left out.
 */
export function featurePoseQuality(s: FeatureGateInput, g: FeatureGates = DEFAULT_FEATURE_GATES): number {
    if (evaluateFeatureGates(s, g).length) return 0;
    const ratios = [s.edgeMedianPx! / g.interiorEdgeMedianPx, g.minInliers / Math.max(1, s.inliers), 1 / (1 + (s.nccFinal! - s.nccPrior!) / 0.02)];
    if (s.hasOtherFrames) ratios.push(s.heldOutEdgeMedianPx! / g.heldOutEdgeMedianPx);
    if (s.crossView !== null && s.crossView.matches >= g.crossViewMinMatches) ratios.push(s.crossView.medianPx / g.crossViewMedianPx);
    return 1 / (1 + Math.max(...ratios) ** 2);
}
