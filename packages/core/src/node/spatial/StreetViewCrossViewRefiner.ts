/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Cross-view photo consistency for Street View plates projected through a scan.
 *
 * Why: a sky-silhouette fit pins a frame's rotation against a far tower, but it is blind to translation and
 * to errors along the view ray, and on a photogrammetric tile whose silhouettes are eroded it even biases
 * the camera toward the building. What texturing needs is that the photos, projected onto the mesh, agree
 * with each other: photo A sent through the mesh into pose B must line up with photo B. That is measurable
 * with sharp photo detail on both sides (unlike photo vs. the blurry tile texture).
 *
 * How:
 *   1. For every ordered pair (A, B) of frames from different panos, photo A is warped into B through B's
 *      mesh depth (depth-tested in A), both are band-passed (difference of Gaussians, removes shading and
 *      sensor noise) and patches are block-matched by NCC (coarse-to-fine). A good match (peak >= 0.5, peak
 *      clearly above the second peak, not at the search border) is a photo-to-photo correspondence: the
 *      content at pixel a of A appears at pixel b of B; X is the mesh point under the patch, n its normal.
 *   2. Pano corrections (one rigid correction per pano, the registrar's PoseCorrection model) are refined
 *      jointly by Levenberg-Marquardt on the reprojection residual of each correspondence through the mesh
 *      tangent plane at X (ray of a in A -> plane -> B, compared with b; and symmetrically), with a Huber
 *      loss and Gaussian priors (translation around the nominal GPS eye, rotation around the start).
 *   3. Matching and refinement alternate a few times (correspondences move as the poses change).
 *   4. The final matches give per-frame consistency statistics (pixel and object-space residuals, partner
 *      panos) for gating, and a per-pixel support mask: plate pixels near verified-consistent patches are
 *      kept, pixels near inconsistent patches or without any cross-view evidence are dropped.
 *
 * Mesh errors that no rigid pose can explain stay as large residuals and are masked out instead of being
 * projected. Generic: nothing here knows the location; every threshold is an option.
 */

import {
    frameCamera, renderFrameDepth, renderTexturedView, luminance, gaussianBlur, projectToFrame, arrayToCorrection, correctionToArray,
    skySilhouetteSamples, sampleDistanceMap,
    PLATE_EMPTY_DEPTH, type FrameCamera, type PoseCorrection, type RgbaImage, type TexturedPrimitive
} from './StreetViewPoseRegistrar';
import type { RenderMesh3D } from './HeadlessMeshSilhouetteRenderer';

export interface CrossViewFrame {
    key: string;
    panoId: string;
    /** Nominal (GPS) eye of the pano in the scan frame. */
    nominalEye: [number, number, number];
    headingDeg: number;
    pitchDeg: number;
    fovDeg: number;
    /** Reference heading of the pano's correction model (see frameCamera). */
    referenceHeadingDeg: number;
    image: RgbaImage;
    /** 1 = usable photo pixel (watermark strip and occluders are 0). */
    valid: Uint8Array;
    /**
     * Optional photo sky: segmentation mask and distance (px) to the sky boundary. With it the refinement also
     * keeps the mesh's sky silhouette on the photo's sky boundary (absolute rotation anchor; cross-view consistency
     * alone lets a group of panos that only see each other rotate together).
     */
    sky?: { mask: Uint8Array; dt: Float32Array };
    /**
     * Optional photo structural edges: distance (px) to the photo's long, strong line segments. With it the refinement also
     * keeps the mesh's occluding contours and creases on them (an absolute anchor on the scan's own geometry, like the sky).
     */
    edges?: { dt: Float32Array };
}

export interface CrossViewPriors { horizontalSigmaMeters: number; verticalSigmaMeters: number; angleSigmaDeg: number }
export interface CrossViewBounds { horizontalMeters: number; verticalMeters: number; yawDeg: number; pitchDeg: number; rollDeg: number }

export interface CrossViewOptions {
    /** Alternations of matching and joint refinement. Default 3. */
    outerIterations?: number;
    /** Patch size (px, full resolution). Default 40. */
    patchPx?: number;
    /** Patch stride (px). Default 24. */
    stridePx?: number;
    /** Search radius (px) of the first alternation (coarse-to-fine). Default 24. */
    initialSearchPx?: number;
    /** Search radius (px) of later alternations (residual shifts are small by then). Default 4. */
    searchPx?: number;
    /** Search radius (px) of the final measurement; larger residual shifts count as unmatched. Default 6. */
    finalSearchPx?: number;
    /** Difference-of-Gaussians sigmas (px). Default [1, 8]. */
    bandpassSigmas?: [number, number];
    /** Minimum NCC peak of a match. Default 0.5. */
    minPeak?: number;
    /** Minimum margin of the peak over the best NCC more than 2 px away. Default 0.1. */
    minPeakMargin?: number;
    /** Minimum band-passed standard deviation of a patch (luminance units). Default 2. */
    minPatchStd?: number;
    /** Minimum warped overlap (px) for a pair to be matched. Default 6000. */
    minOverlapPx?: number;
    /** Mesh points nearer than this (m) are not used. Default 5. */
    minDepthMeters?: number;
    /** Huber threshold (px). Default 1.5. */
    huberPx?: number;
    /** Weight of the priors in px^2 per sigma^2. Default 1. */
    priorWeight?: number;
    /** Gaussian priors on the pano corrections. Default 2 m / 0.5 m / 0.5 deg. */
    priors?: Partial<CrossViewPriors>;
    /** Box on the pano corrections. Default 4 m / 0.7 m / 3 / 1.5 / 1.5 deg. */
    bounds?: Partial<CrossViewBounds>;
    /** Panos whose corrections are held fixed (e.g. an anchor pano). */
    fixedPanos?: string[];
    /** Support radius (px) around consistent matches, measured along depth-continuous mesh pixels. Default 96. */
    supportRadiusPx?: number;
    /** Total weight of a frame's sky-silhouette samples, in equivalent cross-view matches (0 disables). Default 40. */
    silhouetteEquivalentMatches?: number;
    /** Silhouette samples per frame. Default 300. */
    maxSilhouetteSamples?: number;
    /** Truncation (px) of the silhouette distance. Default 15. */
    silhouetteTruncationPx?: number;
    /** Huber threshold (px) of the silhouette distance. Default 2. */
    silhouetteHuberPx?: number;
    /** Total weight of a frame's mesh-edge samples against its photo edges (frames with `edges`), in equivalent matches. Default 0 (off). */
    edgeEquivalentMatches?: number;
    /** Mesh-edge samples per frame. Default 400. */
    maxEdgeSamples?: number;
    /**
     * Only scan points this accepts take part (matches by their mesh point, silhouette and edge samples by theirs): a spatial
     * hold-out, so a measure on the points it rejects is not one the refinement fitted.
     */
    pointFilter?: (X: [number, number, number]) => boolean;
    /** Wall-clock budget (ms) of run(): no new alternation starts past it. */
    budgetMs?: number;
    log?: (msg: string) => void;
}

/** A sky-silhouette sample of a frame (mesh point on the sky boundary) with its residual weight. */
export interface SilhouetteSample { frame: number; X: [number, number, number]; w: number; /** Which photo map it is held to: the sky boundary (default) or the structural edges. */ on?: 'sky' | 'edges' }
type Entry = { kind: 0; m: CrossViewMatch } | { kind: 1; frame: number; X: [number, number, number]; w: number; dt: Float32Array };

/** One photo-to-photo correspondence found through the mesh. */
export interface CrossViewMatch {
    /** Frame indices (into the frames array). */
    a: number;
    b: number;
    /** Content location in A and in B (continuous px, pixel i covers [i, i + 1)). */
    ax: number; ay: number;
    bx: number; by: number;
    /** Mesh point under the patch (B's depth at the patch centre) and its unit normal (toward B). */
    X: [number, number, number];
    n: [number, number, number];
    /** Patch centre in B and the measured shift (b - centre) at the poses the match was made with. */
    qx: number; qy: number;
    peak: number;
    margin: number;
    /** Camera-z depth of X in B (m) and B's focal length (px), for object-space residuals. */
    depthB: number;
    fxB: number;
}

export interface CrossViewPairStats {
    a: string; b: string;
    overlapPx: number;
    patches: number;
    matches: number;
    medianPx: number | null;
    fractionWithin3Px: number | null;
    medianShift: [number, number] | null;
}

export interface CrossViewFrameStats {
    key: string;
    panoId: string;
    /** Matches involving this frame and a frame of another pano, at the final poses. */
    matches: number;
    partnerPanos: string[];
    /** Median / p75 residual (px, measured in the image of the pair's B frame). */
    medianPx: number | null;
    p75Px: number | null;
    /** Median object-space residual on the surface (m): px * depth / fx. */
    medianMeters: number | null;
    fractionWithin3Px: number | null;
    /** Pixels of this frame with cross-view support (see supportMask). */
    supportedPixels: number;
}

export interface CrossViewResult {
    corrections: Map<string, PoseCorrection>;
    cameras: FrameCamera[];
    /** Final matches (made at the final poses; their residual is the remaining shift). */
    matches: CrossViewMatch[];
    pairs: CrossViewPairStats[];
    frames: CrossViewFrameStats[];
    /** Per-frame support masks (1 = pixel lies near a consistent cross-view patch and near no inconsistent one). */
    supportMasks: Uint8Array[];
    history: Array<{ iteration: number; matches: number; medianPx: number | null; fractionWithin3Px: number | null; cost: number; panosRefined: number }>;
    timingsMs: Record<string, number>;
}

const DEF = {
    outerIterations: 3, patchPx: 40, stridePx: 24, initialSearchPx: 24, searchPx: 4, finalSearchPx: 6, bandpassSigmas: [1, 8] as [number, number],
    minPeak: 0.5, minPeakMargin: 0.1, minPatchStd: 2, minOverlapPx: 6000, minDepthMeters: 5, huberPx: 1.5, priorWeight: 1,
    silhouetteEquivalentMatches: 40, maxSilhouetteSamples: 300, silhouetteTruncationPx: 15, silhouetteHuberPx: 2, supportRadiusPx: 96
};
const DEFAULT_PRIORS: CrossViewPriors = { horizontalSigmaMeters: 2, verticalSigmaMeters: 0.5, angleSigmaDeg: 0.5 };
const DEFAULT_BOUNDS: CrossViewBounds = { horizontalMeters: 4, verticalMeters: 0.7, yawDeg: 3, pitchDeg: 1.5, rollDeg: 1.5 };

type V3 = [number, number, number];

function median(v: number[]): number | null {
    if (!v.length) return null;
    const a = v.slice().sort((x, y) => x - y);
    return a[a.length >> 1];
}
function quantile(v: number[], q: number): number | null {
    if (!v.length) return null;
    const a = v.slice().sort((x, y) => x - y);
    return a[Math.min(a.length - 1, Math.floor(q * a.length))];
}

/** Difference of Gaussians of a luminance image. */
export function bandpassLuminance(L: Float32Array, w: number, h: number, s1: number, s2: number): Float32Array {
    const a = gaussianBlur(L, w, h, s1), b = gaussianBlur(L, w, h, s2);
    const o = new Float32Array(w * h);
    for (let i = 0; i < o.length; i++) o[i] = a[i] - b[i];
    return o;
}

/**
 * Warps photo A's luminance into frame B's pixel grid through B's mesh depth: each covered, usable B pixel is
 * lifted to the mesh, projected into A, depth-tested against A's depth (2 % / 0.5 m) and sampled bilinearly.
 */
export function warpLuminanceAtoB(
    camA: FrameCamera, depthA: Float32Array, lumA: Float32Array, validA: Uint8Array,
    camB: FrameCamera, depthB: Float32Array, validB: Uint8Array, minDepth = 0
): { lum: Float32Array; mask: Uint8Array; count: number } {
    const w = camB.width, h = camB.height, WA = camA.width, HA = camA.height;
    const out = new Float32Array(w * h), mask = new Uint8Array(w * h);
    let count = 0;
    const EMPTY = PLATE_EMPTY_DEPTH * 0.5;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x, d = depthB[i];
        if (!(d < EMPTY) || d < minDepth || !validB[i]) continue;
        const u = (x + 0.5 - camB.cx) / camB.fx, v = (y + 0.5 - camB.cy) / camB.fy;
        const X = camB.eye[0] + d * (camB.fwd[0] + u * camB.right[0] - v * camB.up[0]);
        const Y = camB.eye[1] + d * (camB.fwd[1] + u * camB.right[1] - v * camB.up[1]);
        const Z = camB.eye[2] + d * (camB.fwd[2] + u * camB.right[2] - v * camB.up[2]);
        const qx = X - camA.eye[0], qy = Y - camA.eye[1], qz = Z - camA.eye[2];
        const z = qx * camA.fwd[0] + qy * camA.fwd[1] + qz * camA.fwd[2];
        if (z < 0.5) continue;
        const pu = camA.cx + camA.fx * (qx * camA.right[0] + qy * camA.right[1] + qz * camA.right[2]) / z - 0.5;
        const pv = camA.cy - camA.fy * (qx * camA.up[0] + qy * camA.up[1] + qz * camA.up[2]) / z - 0.5;
        if (pu < 0 || pv < 0 || pu >= WA - 1 || pv >= HA - 1) continue;
        const ix = pu | 0, iy = pv | 0, k = iy * WA + ix;
        if (!(Math.abs(depthA[k] - z) < Math.max(0.5, 0.02 * z)) || !validA[k] || !validA[k + 1] || !validA[k + WA] || !validA[k + WA + 1]) continue;
        const fx = pu - ix, fy = pv - iy;
        out[i] = (lumA[k] * (1 - fx) + lumA[k + 1] * fx) * (1 - fy) + (lumA[k + WA] * (1 - fx) + lumA[k + WA + 1] * fx) * fy;
        mask[i] = 1; count++;
    }
    return { lum: out, mask, count };
}

/** Number of lattice pixels (every `step` px) of B whose mesh point is visible and usable in A. */
function estimateOverlap(camA: FrameCamera, depthA: Float32Array, validA: Uint8Array, camB: FrameCamera, depthB: Float32Array, validB: Uint8Array, minDepth: number, step: number): number {
    const w = camB.width, h = camB.height, WA = camA.width, HA = camA.height, EMPTY = PLATE_EMPTY_DEPTH * 0.5;
    let n = 0;
    for (let y = step >> 1; y < h; y += step) for (let x = step >> 1; x < w; x += step) {
        const i = y * w + x, d = depthB[i];
        if (!(d < EMPTY) || d < minDepth || !validB[i]) continue;
        const u = (x + 0.5 - camB.cx) / camB.fx, v = (y + 0.5 - camB.cy) / camB.fy;
        const qx = camB.eye[0] + d * (camB.fwd[0] + u * camB.right[0] - v * camB.up[0]) - camA.eye[0];
        const qy = camB.eye[1] + d * (camB.fwd[1] + u * camB.right[1] - v * camB.up[1]) - camA.eye[1];
        const qz = camB.eye[2] + d * (camB.fwd[2] + u * camB.right[2] - v * camB.up[2]) - camA.eye[2];
        const z = qx * camA.fwd[0] + qy * camA.fwd[1] + qz * camA.fwd[2];
        if (z < 0.5) continue;
        const pu = camA.cx + camA.fx * (qx * camA.right[0] + qy * camA.right[1] + qz * camA.right[2]) / z;
        const pv = camA.cy - camA.fy * (qx * camA.up[0] + qy * camA.up[1] + qz * camA.up[2]) / z;
        if (pu < 0 || pv < 0 || pu >= WA || pv >= HA) continue;
        const k = (pv | 0) * WA + (pu | 0);
        if (validA[k] && Math.abs(depthA[k] - z) < Math.max(0.5, 0.02 * z)) n++;
    }
    return n;
}

function downsample2(src: Float32Array, w: number, h: number): Float32Array {
    const W = w >> 1, H = h >> 1, o = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = 2 * y * w + 2 * x;
        o[y * W + x] = 0.25 * (src[i] + src[i + 1] + src[i + w] + src[i + w + 1]);
    }
    return o;
}

/** Summed-area tables of v and v^2 ((w + 1) x (h + 1)), for O(1) window sums. */
interface Integral { s: Float64Array; s2: Float64Array; w: number }
function integralImage(v: Float32Array, w: number, h: number): Integral {
    const W1 = w + 1, s = new Float64Array(W1 * (h + 1)), s2 = new Float64Array(W1 * (h + 1));
    for (let y = 0; y < h; y++) {
        let r = 0, r2 = 0;
        for (let x = 0; x < w; x++) {
            const a = v[y * w + x]; r += a; r2 += a * a;
            s[(y + 1) * W1 + x + 1] = s[y * W1 + x + 1] + r;
            s2[(y + 1) * W1 + x + 1] = s2[y * W1 + x + 1] + r2;
        }
    }
    return { s, s2, w: W1 };
}
const boxSum = (t: Float64Array, W1: number, x0: number, y0: number, P: number) => t[(y0 + P) * W1 + x0 + P] - t[y0 * W1 + x0 + P] - t[(y0 + P) * W1 + x0] + t[y0 * W1 + x0];

/**
 * NCC of patch A[ax0.., ay0..] (size P) against B shifted by (cdx + dx, cdy + dy), |dx|, |dy| <= R.
 * Returns the best integer shift (relative to the centre shift), its sub-pixel refinement, the peak and the
 * best NCC more than 2 px from the peak, or null when the patch has too little variance.
 */
function searchPatch(
    A: Float32Array, B: Float32Array, BI: Integral, w: number, h: number, ax0: number, ay0: number, P: number,
    cdx: number, cdy: number, R: number, minStd: number
): { dx: number; dy: number; peak: number; second: number; atBorder: boolean } | null {
    const n = P * P;
    let sa = 0, saa = 0;
    for (let y = 0; y < P; y++) { const r = (ay0 + y) * w + ax0; for (let x = 0; x < P; x++) { const v = A[r + x]; sa += v; saa += v * v; } }
    const va = saa - sa * sa / n;
    if (va / n < minStd * minStd) return null;
    const ma = sa / n;
    const S = 2 * R + 1, grid = new Float32Array(S * S).fill(-2);
    for (let dy = -R; dy <= R; dy++) {
        const by0 = ay0 + cdy + dy;
        if (by0 < 0 || by0 + P > h) continue;
        for (let dx = -R; dx <= R; dx++) {
            const bx0 = ax0 + cdx + dx;
            if (bx0 < 0 || bx0 + P > w) continue;
            let sab = 0;
            for (let y = 0; y < P; y++) {
                const ra = (ay0 + y) * w + ax0, rb = (by0 + y) * w + bx0;
                for (let x = 0; x < P; x++) sab += (A[ra + x] - ma) * B[rb + x];
            }
            const sb = boxSum(BI.s, BI.w, bx0, by0, P), sbb = boxSum(BI.s2, BI.w, bx0, by0, P);
            const vb = sbb - sb * sb / n;
            grid[(dy + R) * S + dx + R] = vb > 1e-6 ? sab / Math.sqrt(va * vb) : 0;
        }
    }
    let best = -2, bi = -1;
    for (let k = 0; k < grid.length; k++) if (grid[k] > best) { best = grid[k]; bi = k; }
    if (bi < 0 || best <= -1) return null;
    const iy = Math.floor(bi / S) - R, ix = (bi % S) - R;
    let second = -2;
    for (let k = 0; k < grid.length; k++) {
        const yy = Math.floor(k / S) - R, xx = (k % S) - R;
        if (Math.abs(yy - iy) <= 2 && Math.abs(xx - ix) <= 2) continue;
        if (grid[k] > second) second = grid[k];
    }
    const at = (xx: number, yy: number) => grid[(yy + R) * S + xx + R];
    let sx = ix, sy = iy;
    const atBorder = Math.abs(ix) >= R || Math.abs(iy) >= R;
    if (!atBorder) {
        const l = at(ix - 1, iy), c = at(ix, iy), r = at(ix + 1, iy), d = l - 2 * c + r;
        if (d < 0 && l > -2 && r > -2) sx = ix + Math.max(-0.5, Math.min(0.5, 0.5 * (l - r) / d));
        const u = at(ix, iy - 1), dd = at(ix, iy + 1), d2 = u - 2 * c + dd;
        if (d2 < 0 && u > -2 && dd > -2) sy = iy + Math.max(-0.5, Math.min(0.5, 0.5 * (u - dd) / d2));
    }
    return { dx: sx, dy: sy, peak: best, second, atBorder };
}

interface FrameState {
    cam: FrameCamera;
    depth: Float32Array;
    lum: Float32Array;
    bp: Float32Array;
    bpHalf: Float32Array;
    bpI: Integral;
    bpHalfI: Integral;
}

export class StreetViewCrossViewRefiner {
    readonly mesh: RenderMesh3D;
    readonly frames: CrossViewFrame[];
    readonly opts: CrossViewOptions;
    readonly priors: CrossViewPriors;
    readonly bounds: CrossViewBounds;
    private readonly lum: Float32Array[];
    private readonly bp: Float32Array[];
    private readonly bpHalf: Float32Array[];
    private readonly bpI: Integral[];
    private readonly bpHalfI: Integral[];

    constructor(mesh: RenderMesh3D, frames: CrossViewFrame[], opts: CrossViewOptions = {}) {
        this.mesh = mesh;
        this.frames = frames;
        this.opts = opts;
        this.priors = { ...DEFAULT_PRIORS, ...(opts.priors ?? {}) };
        this.bounds = { ...DEFAULT_BOUNDS, ...(opts.bounds ?? {}) };
        const [s1, s2] = opts.bandpassSigmas ?? DEF.bandpassSigmas;
        this.lum = frames.map(f => luminance(f.image.rgba, f.image.width, f.image.height));
        this.bp = this.lum.map((L, i) => bandpassLuminance(L, frames[i].image.width, frames[i].image.height, s1, s2));
        this.bpHalf = this.bp.map((b, i) => downsample2(b, frames[i].image.width, frames[i].image.height));
        this.bpI = this.bp.map((b, i) => integralImage(b, frames[i].image.width, frames[i].image.height));
        this.bpHalfI = this.bpHalf.map((b, i) => integralImage(b, frames[i].image.width >> 1, frames[i].image.height >> 1));
    }

    private log(m: string) { this.opts.log?.(m); }

    camera(i: number, corr: PoseCorrection): FrameCamera {
        const f = this.frames[i];
        return frameCamera(f.nominalEye, f.headingDeg, f.pitchDeg, f.fovDeg, f.image.width, f.image.height, corr, f.referenceHeadingDeg);
    }

    private states(corrs: Map<string, PoseCorrection>): FrameState[] {
        return this.frames.map((f, i) => {
            const cam = this.camera(i, corrs.get(f.panoId)!);
            return { cam, depth: renderFrameDepth(this.mesh, cam), lum: this.lum[i], bp: this.bp[i], bpHalf: this.bpHalf[i], bpI: this.bpI[i], bpHalfI: this.bpHalfI[i] };
        });
    }

    /**
     * Correspondences for every pair of frames from different panos at the given frame states. Each unordered pair
     * is matched once, on the grid of the frame with the longer focal length (B; more pixels on the overlap); the
     * refinement uses residuals in both images.
     */
    matchAll(st: FrameState[], searchPx: number, coarseToFine: boolean): { matches: CrossViewMatch[]; pairs: CrossViewPairStats[] } {
        const o = this.opts;
        const P = o.patchPx ?? DEF.patchPx, S = o.stridePx ?? DEF.stridePx;
        const minPeak = o.minPeak ?? DEF.minPeak, minMargin = o.minPeakMargin ?? DEF.minPeakMargin, minStd = o.minPatchStd ?? DEF.minPatchStd;
        const minOverlap = o.minOverlapPx ?? DEF.minOverlapPx, minDepth = o.minDepthMeters ?? DEF.minDepthMeters;
        const [s1, s2] = o.bandpassSigmas ?? DEF.bandpassSigmas;
        const matches: CrossViewMatch[] = [];
        const pairs: CrossViewPairStats[] = [];
        const EMPTY = PLATE_EMPTY_DEPTH * 0.5;
        for (let b = 0; b < this.frames.length; b++) {
            const B = st[b], fb = this.frames[b], w = B.cam.width, h = B.cam.height;
            for (let a = 0; a < this.frames.length; a++) {
                if (a === b || this.frames[a].panoId === fb.panoId) continue;
                // one direction per unordered pair: B is the longer focal length (ties: the higher index)
                const fxa = st[a].cam.fx, fxb = B.cam.fx;
                if (fxa > fxb + 1e-9 || (Math.abs(fxa - fxb) <= 1e-9 && a > b)) continue;
                const A = st[a], fa = this.frames[a];
                // cheap overlap estimate on a 16 px lattice before the full warp + band-pass
                if (estimateOverlap(A.cam, A.depth, fa.valid, B.cam, B.depth, fb.valid, minDepth, 16) * 256 < minOverlap * 0.5) continue;
                const wp = warpLuminanceAtoB(A.cam, A.depth, A.lum, fa.valid, B.cam, B.depth, fb.valid, minDepth);
                if (wp.count < minOverlap) continue;
                const W = bandpassLuminance(wp.lum, w, h, s1, s2);
                const Wh = coarseToFine ? downsample2(W, w, h) : null;
                const pairMatches: CrossViewMatch[] = [];
                let patches = 0;
                for (let y0 = 0; y0 + P <= h; y0 += S) for (let x0 = 0; x0 + P <= w; x0 += S) {
                    // the patch must be warped (covered in both) everywhere but a few pixels, with no depth edge
                    let cnt = 0, dmin = Infinity, dmax = 0;
                    for (let y = 0; y < P; y += 2) for (let x = 0; x < P; x += 2) {
                        const i = (y0 + y) * w + x0 + x;
                        if (wp.mask[i]) { cnt++; const d = B.depth[i]; if (d < dmin) dmin = d; if (d > dmax) dmax = d; }
                    }
                    if (cnt < 0.95 * (P / 2) * (P / 2) || dmax > 1.15 * dmin + 0.5) continue;
                    patches++;
                    let m: ReturnType<typeof searchPatch>;
                    if (coarseToFine && Wh) {
                        const c = searchPatch(Wh, B.bpHalf, B.bpHalfI, w >> 1, h >> 1, x0 >> 1, y0 >> 1, P >> 1, 0, 0, Math.ceil(searchPx / 2), minStd * 0.7);
                        if (!c || c.atBorder || c.peak < minPeak * 0.8 || c.peak - c.second < minMargin) continue;
                        m = searchPatch(W, B.bp, B.bpI, w, h, x0, y0, P, Math.round(2 * c.dx), Math.round(2 * c.dy), 3, minStd);
                        if (m) { m.dx += Math.round(2 * c.dx); m.dy += Math.round(2 * c.dy); m.second = Math.max(m.second, c.second); }
                    } else {
                        m = searchPatch(W, B.bp, B.bpI, w, h, x0, y0, P, 0, 0, searchPx, minStd);
                    }
                    if (!m || m.atBorder || m.peak < minPeak || m.peak - m.second < minMargin) continue;
                    // mesh point and normal under the patch centre (from B's depth)
                    const qx = x0 + P / 2, qy = y0 + P / 2;
                    const ci = Math.floor(qy) * w + Math.floor(qx);
                    const d = B.depth[ci];
                    if (!(d < EMPTY)) continue;
                    const lift = (px: number, py: number, dd: number): V3 => {
                        const u = (px - B.cam.cx) / B.cam.fx, v = (py - B.cam.cy) / B.cam.fy;
                        return [0, 1, 2].map(k => B.cam.eye[k] + dd * (B.cam.fwd[k] + u * B.cam.right[k] - v * B.cam.up[k])) as V3;
                    };
                    const X = lift(qx, qy, d);
                    const r4 = 6;
                    const dx1 = B.depth[ci + r4], dx0 = B.depth[ci - r4], dy1 = B.depth[ci + r4 * w], dy0 = B.depth[ci - r4 * w];
                    if (!(dx1 < EMPTY && dx0 < EMPTY && dy1 < EMPTY && dy0 < EMPTY)) continue;
                    const Px1 = lift(qx + r4, qy, dx1), Px0 = lift(qx - r4, qy, dx0), Py1 = lift(qx, qy + r4, dy1), Py0 = lift(qx, qy - r4, dy0);
                    const ex = [Px1[0] - Px0[0], Px1[1] - Px0[1], Px1[2] - Px0[2]], ey = [Py1[0] - Py0[0], Py1[1] - Py0[1], Py1[2] - Py0[2]];
                    let n: V3 = [ex[1] * ey[2] - ex[2] * ey[1], ex[2] * ey[0] - ex[0] * ey[2], ex[0] * ey[1] - ex[1] * ey[0]];
                    const nl = Math.hypot(n[0], n[1], n[2]);
                    if (!(nl > 1e-9)) continue;
                    n = [n[0] / nl, n[1] / nl, n[2] / nl];
                    const toB = [B.cam.eye[0] - X[0], B.cam.eye[1] - X[1], B.cam.eye[2] - X[2]];
                    if (n[0] * toB[0] + n[1] * toB[1] + n[2] * toB[2] < 0) n = [-n[0], -n[1], -n[2]];
                    if (o.pointFilter && !o.pointFilter(X)) continue;
                    const pa = projectToFrame(A.cam, X);
                    if (!pa) continue;
                    pairMatches.push({
                        a, b, ax: pa[0], ay: pa[1], bx: qx + m.dx, by: qy + m.dy, X, n, qx, qy,
                        peak: m.peak, margin: m.peak - m.second, depthB: d, fxB: B.cam.fx
                    });
                }
                const mags = pairMatches.map(mm => Math.hypot(mm.bx - mm.qx, mm.by - mm.qy));
                pairs.push({
                    a: fa.key, b: fb.key, overlapPx: wp.count, patches, matches: pairMatches.length,
                    medianPx: median(mags), fractionWithin3Px: mags.length ? mags.filter(v => v <= 3).length / mags.length : null,
                    medianShift: pairMatches.length ? [median(pairMatches.map(mm => mm.bx - mm.qx))!, median(pairMatches.map(mm => mm.by - mm.qy))!] : null
                });
                for (const mm of pairMatches) matches.push(mm);
            }
        }
        return { matches, pairs };
    }

    /** Ray of pixel (px, py) of a camera intersected with the plane (X, n); null when parallel / behind. */
    private static rayPlane(cam: FrameCamera, px: number, py: number, X: V3, n: V3): V3 | null {
        const u = (px - cam.cx) / cam.fx, v = (py - cam.cy) / cam.fy;
        const d = [cam.fwd[0] + u * cam.right[0] - v * cam.up[0], cam.fwd[1] + u * cam.right[1] - v * cam.up[1], cam.fwd[2] + u * cam.right[2] - v * cam.up[2]];
        const den = n[0] * d[0] + n[1] * d[1] + n[2] * d[2];
        if (Math.abs(den) < 1e-6) return null;
        const t = (n[0] * (X[0] - cam.eye[0]) + n[1] * (X[1] - cam.eye[1]) + n[2] * (X[2] - cam.eye[2])) / den;
        if (!(t > 0.5)) return null;
        return [cam.eye[0] + t * d[0], cam.eye[1] + t * d[1], cam.eye[2] + t * d[2]];
    }

    /**
     * Residuals (px) at a set of corrections, 4 per entry: a match gives [A->B dx, dy, B->A dx, dy]; a silhouette
     * sample gives [w * distance to the photo sky boundary (truncated), 0, 0, 0].
     */
    private residuals(entries: Entry[], corrs: Map<string, PoseCorrection>): Float64Array {
        const cams = this.frames.map((f, i) => this.camera(i, corrs.get(f.panoId)!));
        const r = new Float64Array(entries.length * 4);
        const big = 50, T = this.opts.silhouetteTruncationPx ?? DEF.silhouetteTruncationPx;
        for (let k = 0; k < entries.length; k++) {
            const e = entries[k];
            if (e.kind === 1) {
                const cam = cams[e.frame];
                const p = projectToFrame(cam, e.X);
                const d = p ? Math.min(T, sampleDistanceMap(e.dt, cam.width, cam.height, p[0], p[1], T)) : T;
                r[k * 4] = e.w * d;
                continue;
            }
            const m = e.m, A = cams[m.a], B = cams[m.b];
            const XA = StreetViewCrossViewRefiner.rayPlane(A, m.ax, m.ay, m.X, m.n);
            const pb = XA ? projectToFrame(B, XA) : null;
            r[k * 4] = pb ? pb[0] - m.bx : big; r[k * 4 + 1] = pb ? pb[1] - m.by : big;
            const XB = StreetViewCrossViewRefiner.rayPlane(B, m.bx, m.by, m.X, m.n);
            const pa = XB ? projectToFrame(A, XB) : null;
            r[k * 4 + 2] = pa ? pa[0] - m.ax : big; r[k * 4 + 3] = pa ? pa[1] - m.ay : big;
        }
        return r;
    }

    /**
     * Joint Levenberg-Marquardt over the corrections of every pano that has matches (Huber IRLS, priors,
     * box bounds), on the cross-view residuals plus, for frames with a photo sky mask, the sky-silhouette distance
     * of the mesh's silhouette samples (absolute rotation anchor). Returns the refined corrections and the cost.
     */
    refineCorrections(
        matches: CrossViewMatch[], start: Map<string, PoseCorrection>, priorCentre: Map<string, PoseCorrection>, maxIterations = 30,
        priorSigma?: Map<string, Partial<CrossViewPriors>>, silhouettes: SilhouetteSample[] = []
    ): { corrections: Map<string, PoseCorrection>; cost: number; panosRefined: number } {
        const o = this.opts;
        const fixed = new Set(o.fixedPanos ?? []);
        const panos = [...new Set(matches.flatMap(m => [this.frames[m.a].panoId, this.frames[m.b].panoId]))].filter(p => !fixed.has(p));
        const corrs = new Map(start);
        if (!panos.length || !matches.length) return { corrections: corrs, cost: 0, panosRefined: 0 };
        const np = panos.length * 6;
        const pIndex = new Map(panos.map((p, i) => [p, i]));
        const entries: Entry[] = matches.map(m => ({ kind: 0 as const, m }));
        for (const sl of silhouettes) {
            if (!pIndex.has(this.frames[sl.frame].panoId)) continue;
            const dt = sl.on === 'edges' ? this.frames[sl.frame].edges?.dt : this.frames[sl.frame].sky?.dt;
            if (dt) entries.push({ kind: 1, frame: sl.frame, X: sl.X, w: sl.w, dt });
        }
        const x = new Float64Array(np);
        panos.forEach((p, i) => correctionToArray(corrs.get(p)!).forEach((v, j) => { x[i * 6 + j] = v; }));
        const pr = this.priors, bd = this.bounds;
        const sig = new Float64Array(np);
        panos.forEach((p, i) => {
            const q = { ...pr, ...(priorSigma?.get(p) ?? {}) };
            [q.horizontalSigmaMeters, q.verticalSigmaMeters, q.horizontalSigmaMeters, q.angleSigmaDeg, q.angleSigmaDeg, q.angleSigmaDeg].forEach((v, j) => { sig[i * 6 + j] = v; });
        });
        const hi = [bd.horizontalMeters, bd.verticalMeters, bd.horizontalMeters, bd.yawDeg, bd.pitchDeg, bd.rollDeg];
        const centre = new Float64Array(np);
        panos.forEach((p, i) => correctionToArray(priorCentre.get(p) ?? { dx: 0, dy: 0, dz: 0, dyawDeg: 0, dpitchDeg: 0, drollDeg: 0 }).forEach((v, j) => { centre[i * 6 + j] = v; }));
        const pw = Math.sqrt(o.priorWeight ?? DEF.priorWeight);
        const delta = o.huberPx ?? DEF.huberPx, deltaSil = o.silhouetteHuberPx ?? DEF.silhouetteHuberPx;
        const nE = entries.length;
        const apply = (xv: Float64Array) => {
            const c = new Map(corrs);
            panos.forEach((p, i) => c.set(p, arrayToCorrection(Array.from(xv.subarray(i * 6, i * 6 + 6)))));
            return c;
        };
        const resid = (xv: Float64Array) => {
            const rm = this.residuals(entries, apply(xv));
            const out = new Float64Array(rm.length + np);
            out.set(rm);
            for (let j = 0; j < np; j++) out[rm.length + j] = pw * (xv[j] - centre[j]) / sig[j];
            return out;
        };
        // Huber: on the 2D residual of each match direction, on the unweighted distance of a silhouette sample
        const huber = (k: number, r: Float64Array, cb: (off: number, e: number, d: number) => void) => {
            const e = entries[k];
            if (e.kind === 1) { cb(0, Math.abs(r[k * 4]) / e.w, deltaSil); return; }
            for (const off of [0, 2]) cb(off, Math.hypot(r[k * 4 + off], r[k * 4 + off + 1]), delta);
        };
        const weights = (r: Float64Array) => {
            const w = new Float64Array(r.length).fill(1);
            for (let k = 0; k < nE; k++) huber(k, r, (off, e, d) => { const wk = e <= d ? 1 : d / e; w[k * 4 + off] = wk; w[k * 4 + off + 1] = wk; });
            return w;
        };
        const robustCost = (r: Float64Array) => {
            let c = 0;
            for (let k = 0; k < nE; k++) {
                const ent = entries[k];
                huber(k, r, (_off, e, d) => {
                    const scale = ent.kind === 1 ? ent.w * ent.w : 1;
                    c += scale * (e <= d ? e * e : 2 * d * e - d * d);
                });
            }
            for (let j = nE * 4; j < r.length; j++) c += r[j] * r[j];
            return c;
        };
        let r = resid(x);
        let cost = robustCost(r);
        let lambda = 1e-3;
        // parameter block -> entries it affects
        const rowsOf: number[][] = panos.map(() => []);
        entries.forEach((e, k) => {
            if (e.kind === 1) { const ip = pIndex.get(this.frames[e.frame].panoId); if (ip !== undefined) rowsOf[ip].push(k); return; }
            const ia = pIndex.get(this.frames[e.m.a].panoId), ib = pIndex.get(this.frames[e.m.b].panoId);
            if (ia !== undefined) rowsOf[ia].push(k);
            if (ib !== undefined && ib !== ia) rowsOf[ib].push(k);
        });
        const steps = [0.05, 0.05, 0.05, 0.02, 0.02, 0.02];
        for (let it = 0; it < maxIterations; it++) {
            const w = weights(r);
            // numeric Jacobian (forward differences), sparse by pano block
            const J: Array<Map<number, Float64Array>> = []; // per parameter: entry index -> 4 partials
            for (let j = 0; j < np; j++) {
                const pi = Math.floor(j / 6), h = steps[j % 6];
                const xp = Float64Array.from(x); xp[j] += h;
                const cp = apply(xp);
                const sub = rowsOf[pi].map(k => entries[k]);
                const rp = this.residuals(sub, cp);
                const col = new Map<number, Float64Array>();
                rowsOf[pi].forEach((k, si) => {
                    col.set(k, Float64Array.from([0, 1, 2, 3].map(q => (rp[si * 4 + q] - r[k * 4 + q]) / h)));
                });
                J.push(col);
            }
            // normal equations
            const JTJ = new Float64Array(np * np), JTr = new Float64Array(np);
            for (let j = 0; j < np; j++) {
                for (const [k, dj] of J[j]) for (let q = 0; q < 4; q++) JTr[j] += dj[q] * w[k * 4 + q] * r[k * 4 + q];
                for (let l = j; l < np; l++) {
                    let sum = 0;
                    const small = J[j].size < J[l].size ? J[j] : J[l], other = small === J[j] ? J[l] : J[j];
                    for (const [k, d1] of small) { const d2 = other.get(k); if (d2) for (let q = 0; q < 4; q++) sum += d1[q] * w[k * 4 + q] * d2[q]; }
                    JTJ[j * np + l] = sum; JTJ[l * np + j] = sum;
                }
                const pj = pw / sig[j];
                JTJ[j * np + j] += pj * pj;
                JTr[j] += pj * r[nE * 4 + j];
            }
            let improved = false;
            for (let tries = 0; tries < 8; tries++) {
                const Aug = Float64Array.from(JTJ);
                for (let j = 0; j < np; j++) Aug[j * np + j] *= 1 + lambda;
                for (let j = 0; j < np; j++) Aug[j * np + j] += 1e-9;
                const step = solveSymmetric(Aug, JTr.map(v => -v), np);
                if (!step) { lambda *= 10; continue; }
                const xn = Float64Array.from(x);
                for (let j = 0; j < np; j++) xn[j] = Math.max(-hi[j % 6], Math.min(hi[j % 6], xn[j] + step[j]));
                const rn = resid(xn);
                const cn = robustCost(rn);
                if (cn < cost) {
                    const rel = (cost - cn) / Math.max(1e-12, cost);
                    x.set(xn); r = rn; cost = cn; lambda = Math.max(1e-7, lambda / 3); improved = true;
                    if (rel < 1e-6) it = maxIterations;
                    break;
                }
                lambda *= 10;
            }
            if (!improved) break;
        }
        return { corrections: apply(x), cost, panosRefined: panos.length };
    }

    /** Sky-silhouette samples of every frame with a sky mask at the given states (evenly thinned, weighted). */
    private silhouetteSamples(st: FrameState[]): SilhouetteSample[] {
        const out: SilhouetteSample[] = [];
        const maxN = this.opts.maxSilhouetteSamples ?? DEF.maxSilhouetteSamples, eq = this.opts.silhouetteEquivalentMatches ?? DEF.silhouetteEquivalentMatches;
        if (eq > 0) this.frames.forEach((f, i) => {
            if (!f.sky) return;
            const P = skySilhouetteSamples(st[i].depth, st[i].cam, { valid: f.valid, sky: f.sky.mask });
            const n = P.length / 3;
            if (n < 30) return;
            const pts: Array<[number, number, number]> = [];
            for (let q = 0; q < P.length; q += 3) { const X: [number, number, number] = [P[q], P[q + 1], P[q + 2]]; if (!this.opts.pointFilter || this.opts.pointFilter(X)) pts.push(X); }
            if (pts.length < 30) return;
            const take = Math.min(pts.length, maxN), stepK = pts.length / take;
            const w = Math.sqrt(eq / take);
            for (let k = 0; k < take; k++) out.push({ frame: i, X: pts[Math.floor(k * stepK)], w });
        });
        const eqE = this.opts.edgeEquivalentMatches ?? 0, maxE = this.opts.maxEdgeSamples ?? 400;
        if (eqE > 0) this.frames.forEach((f, i) => {
            if (!f.edges) return;
            const pts = meshEdgeSamples(st[i].depth, st[i].cam, f.valid).filter(X => !this.opts.pointFilter || this.opts.pointFilter(X));
            if (pts.length < 30) return;
            const take = Math.min(pts.length, maxE), stepK = pts.length / take;
            const w = Math.sqrt(eqE / take);
            for (let k = 0; k < take; k++) out.push({ frame: i, X: pts[Math.floor(k * stepK)], w, on: 'edges' });
        });
        return out;
    }

    /**
     * Alternates matching and joint refinement, then measures the final consistency and builds support masks.
     * `start` gives every pano's starting correction; `priorCentre` the prior means (default: translation at the
     * nominal eye, i.e. 0, and rotation at the start).
     */
    run(
        start: Map<string, PoseCorrection>, priorCentre?: Map<string, PoseCorrection>, priorSigma?: Map<string, Partial<CrossViewPriors>>,
        runOpts: { outerIterations?: number; initialSearchPx?: number } = {}
    ): CrossViewResult {
        const t0 = Date.now();
        const timings: Record<string, number> = {};
        const o = this.opts;
        const centre = priorCentre ?? new Map([...start].map(([p, c]) => [p, { dx: 0, dy: 0, dz: 0, dyawDeg: c.dyawDeg, dpitchDeg: c.dpitchDeg, drollDeg: c.drollDeg }]));
        let corrs = new Map(start);
        const history: CrossViewResult['history'] = [];
        const iters = runOpts.outerIterations ?? o.outerIterations ?? DEF.outerIterations;
        for (let it = 0; it < iters; it++) {
            if (o.budgetMs !== undefined && it > 0 && Date.now() - t0 > o.budgetMs) { this.log(`[cross-view] budget of ${o.budgetMs} ms reached after ${it} alternations`); break; }
            const ts = Date.now();
            const st = this.states(corrs);
            const first = it === 0;
            const initialSearch = runOpts.initialSearchPx ?? o.initialSearchPx ?? DEF.initialSearchPx;
            const { matches } = this.matchAll(st, first ? initialSearch : (o.searchPx ?? DEF.searchPx), first && initialSearch > 8);
            timings[`match${it}`] = Date.now() - ts;
            const mags = matches.map(m => Math.hypot(m.bx - m.qx, m.by - m.qy));
            const tr = Date.now();
            const ref = this.refineCorrections(matches, corrs, centre, 30, priorSigma, this.silhouetteSamples(st));
            timings[`refine${it}`] = Date.now() - tr;
            corrs = ref.corrections;
            history.push({ iteration: it, matches: matches.length, medianPx: median(mags), fractionWithin3Px: mags.length ? mags.filter(v => v <= 3).length / mags.length : null, cost: ref.cost, panosRefined: ref.panosRefined });
            this.log(`[cross-view] iteration ${it}: ${matches.length} matches, median shift ${median(mags)?.toFixed(2) ?? 'n/a'} px before refinement, ${ref.panosRefined} panos refined`);
        }
        const m = this.measure(corrs);
        history.push(...m.history.map(h => ({ ...h, iteration: iters })));
        Object.assign(timings, m.timingsMs);
        timings.total = Date.now() - t0;
        return { ...m, history, timingsMs: timings };
    }

    /**
     * Final measurement at given corrections (no refinement): fresh matching with the final search radius,
     * per-frame consistency statistics and support masks.
     */
    measure(corrs: Map<string, PoseCorrection>): CrossViewResult {
        const o = this.opts;
        const timings: Record<string, number> = {};
        const history: CrossViewResult['history'] = [];
        const tf = Date.now();
        const st = this.states(corrs);
        const fin = this.matchAll(st, o.finalSearchPx ?? DEF.finalSearchPx, false);
        timings.finalMatch = Date.now() - tf;
        const finMags = fin.matches.map(m => Math.hypot(m.bx - m.qx, m.by - m.qy));
        history.push({ iteration: 0, matches: fin.matches.length, medianPx: median(finMags), fractionWithin3Px: finMags.length ? finMags.filter(v => v <= 3).length / finMags.length : null, cost: NaN, panosRefined: 0 });
        this.log(`[cross-view] final: ${fin.matches.length} matches, median residual ${median(finMags)?.toFixed(2) ?? 'n/a'} px`);
        const supportMasks = this.supportMasks(fin.matches, st);
        const frames: CrossViewFrameStats[] = this.frames.map((f, i) => {
            const mine = fin.matches.filter(m => m.a === i || m.b === i);
            const px = mine.map(m => Math.hypot(m.bx - m.qx, m.by - m.qy));
            const meters = mine.map(m => Math.hypot(m.bx - m.qx, m.by - m.qy) * m.depthB / m.fxB);
            let sup = 0; for (const v of supportMasks[i]) sup += v;
            return {
                key: f.key, panoId: f.panoId, matches: mine.length,
                partnerPanos: [...new Set(mine.map(m => this.frames[m.a === i ? m.b : m.a].panoId))],
                medianPx: median(px), p75Px: quantile(px, 0.75), medianMeters: median(meters),
                fractionWithin3Px: px.length ? px.filter(v => v <= 3).length / px.length : null,
                supportedPixels: sup
            };
        });
        return { corrections: corrs, cameras: st.map(s => s.cam), matches: fin.matches, pairs: fin.pairs, frames, supportMasks, history, timingsMs: timings };
    }

    /**
     * Support masks: a pixel of frame F is supported when it lies within `radiusPx` of a consistent match of F
     * (residual <= consistentPx), measured along the mesh surface as seen by F (the distance may not cross a depth
     * discontinuity: a jump above 4 % between neighbouring pixels, or an empty pixel), and no inconsistent match
     * (residual > inconsistentPx) lies within one patch stride. The match location in F is its B-side centre or its
     * A-side content pixel. Unsupported pixels are never projected.
     */
    supportMasks(matches: CrossViewMatch[], st: FrameState[], consistentPx = 3, inconsistentPx = 5, radiusPx?: number): Uint8Array[] {
        const stride = this.opts.stridePx ?? DEF.stridePx;
        const R = radiusPx ?? this.opts.supportRadiusPx ?? DEF.supportRadiusPx;
        const EMPTY = PLATE_EMPTY_DEPTH * 0.5;
        return this.frames.map((f, i) => {
            const w = f.image.width, h = f.image.height, d = st[i].depth;
            const good: Array<[number, number]> = [], bad: Array<[number, number]> = [];
            for (const m of matches) {
                if (m.a !== i && m.b !== i) continue;
                const e = Math.hypot(m.bx - m.qx, m.by - m.qy);
                const p: [number, number] = m.b === i ? [m.qx, m.qy] : [m.ax, m.ay];
                if (e <= consistentPx) good.push(p); else if (e > inconsistentPx) bad.push(p);
            }
            const on = (k: number) => d[k] < EMPTY && f.valid[k] === 1;
            const cont = (a: number, b: number) => Math.abs(d[a] - d[b]) <= 0.04 * Math.min(d[a], d[b]);
            // geodesic (chamfer 1 / sqrt 2) distance from the consistent matches over depth-continuous mesh pixels
            const dist = new Float32Array(w * h).fill(Infinity);
            for (const [px, py] of good) {
                const x = Math.min(w - 1, Math.max(0, Math.floor(px))), y = Math.min(h - 1, Math.max(0, Math.floor(py)));
                const k = y * w + x;
                if (on(k)) dist[k] = 0;
            }
            const D = Math.SQRT2;
            for (let sweep = 0; sweep < 3; sweep++) {
                for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
                    const k = y * w + x;
                    if (!on(k) || dist[k] === 0) continue;
                    let v = dist[k];
                    if (x > 0 && on(k - 1) && cont(k, k - 1)) v = Math.min(v, dist[k - 1] + 1);
                    if (y > 0) {
                        if (on(k - w) && cont(k, k - w)) v = Math.min(v, dist[k - w] + 1);
                        if (x > 0 && on(k - w - 1) && cont(k, k - w - 1)) v = Math.min(v, dist[k - w - 1] + D);
                        if (x + 1 < w && on(k - w + 1) && cont(k, k - w + 1)) v = Math.min(v, dist[k - w + 1] + D);
                    }
                    dist[k] = v;
                }
                for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
                    const k = y * w + x;
                    if (!on(k) || dist[k] === 0) continue;
                    let v = dist[k];
                    if (x + 1 < w && on(k + 1) && cont(k, k + 1)) v = Math.min(v, dist[k + 1] + 1);
                    if (y + 1 < h) {
                        if (on(k + w) && cont(k, k + w)) v = Math.min(v, dist[k + w] + 1);
                        if (x + 1 < w && on(k + w + 1) && cont(k, k + w + 1)) v = Math.min(v, dist[k + w + 1] + D);
                        if (x > 0 && on(k + w - 1) && cont(k, k + w - 1)) v = Math.min(v, dist[k + w - 1] + D);
                    }
                    dist[k] = v;
                }
            }
            const mask = new Uint8Array(w * h);
            for (let k = 0; k < mask.length; k++) if (dist[k] <= R) mask[k] = 1;
            const r2 = stride * stride;
            for (const [px, py] of bad) {
                const x0 = Math.max(0, Math.floor(px - stride)), x1 = Math.min(w - 1, Math.ceil(px + stride));
                const y0 = Math.max(0, Math.floor(py - stride)), y1 = Math.min(h - 1, Math.ceil(py + stride));
                for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if ((x + 0.5 - px) ** 2 + (y + 0.5 - py) ** 2 <= r2) mask[y * w + x] = 0;
            }
            return mask;
        });
    }
}

/**
 * The mesh's own structural edges as seen by a frame, lifted to 3D: the near side of occluding contours (a depth step of more
 * than 4 % + 0.3 m to a neighbour) and creases (normals from the depth differing by more than 40 degrees across 3 px), every
 * other pixel. The silhouette against empty space is left to the sky term.
 */
export function meshEdgeSamples(depth: Float32Array, cam: FrameCamera, valid: Uint8Array): Array<[number, number, number]> {
    const w = cam.width, h = cam.height, EMPTY = PLATE_EMPTY_DEPTH * 0.5, R = 3;
    const lift = (x: number, y: number, d: number): V3 => {
        const u = (x + 0.5 - cam.cx) / cam.fx, v = (y + 0.5 - cam.cy) / cam.fy;
        return [cam.eye[0] + d * (cam.fwd[0] + u * cam.right[0] - v * cam.up[0]), cam.eye[1] + d * (cam.fwd[1] + u * cam.right[1] - v * cam.up[1]), cam.eye[2] + d * (cam.fwd[2] + u * cam.right[2] - v * cam.up[2])];
    };
    const normalAt = (x: number, y: number): V3 | null => {
        const i = y * w + x;
        const a = depth[i - R], b = depth[i + R], c = depth[i - R * w], d = depth[i + R * w], m = depth[i];
        if (!(a < EMPTY && b < EMPTY && c < EMPTY && d < EMPTY)) return null;
        if (Math.abs(a - m) > 0.04 * m + 0.3 || Math.abs(b - m) > 0.04 * m + 0.3 || Math.abs(c - m) > 0.04 * m + 0.3 || Math.abs(d - m) > 0.04 * m + 0.3) return null;
        const pa = lift(x - R, y, a), pb = lift(x + R, y, b), pc = lift(x, y - R, c), pd = lift(x, y + R, d);
        const ex = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]], ey = [pd[0] - pc[0], pd[1] - pc[1], pd[2] - pc[2]];
        const n: V3 = [ex[1] * ey[2] - ex[2] * ey[1], ex[2] * ey[0] - ex[0] * ey[2], ex[0] * ey[1] - ex[1] * ey[0]];
        const l = Math.hypot(n[0], n[1], n[2]);
        return l > 1e-9 ? [n[0] / l, n[1] / l, n[2] / l] : null;
    };
    const out: V3[] = [];
    const cosCrease = Math.cos(40 * Math.PI / 180);
    for (let y = 2 * R; y < h - 2 * R; y++) for (let x = 2 * R; x < w - 2 * R; x++) {
        if (((x + y) & 1) !== 0) continue;
        const i = y * w + x, d = depth[i];
        if (!(d < EMPTY) || !valid[i]) continue;
        let edge = false;
        for (const j of [i - 1, i + 1, i - w, i + w]) {
            const dj = depth[j];
            if (dj < EMPTY && dj > d + 0.04 * d + 0.3) { edge = true; break; } // this pixel is the near side of a step
        }
        if (!edge) {
            const n0 = normalAt(x - R, y), n1 = normalAt(x + R, y), m0 = normalAt(x, y - R), m1 = normalAt(x, y + R);
            if (n0 && n1 && n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2] < cosCrease) edge = true;
            else if (m0 && m1 && m0[0] * m1[0] + m0[1] * m1[1] + m0[2] * m1[2] < cosCrease) edge = true;
        }
        if (edge) out.push(lift(x, y, d));
    }
    return out;
}

/** Solves a symmetric positive (semi-)definite system by Cholesky; null when not positive definite. */
export function solveSymmetric(A: Float64Array, b: Float64Array, n: number): Float64Array | null {
    const L = new Float64Array(n * n);
    for (let i = 0; i < n; i++) {
        for (let j = 0; j <= i; j++) {
            let s = A[i * n + j];
            for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
            if (i === j) {
                if (!(s > 0)) return null;
                L[i * n + i] = Math.sqrt(s);
            } else {
                L[i * n + j] = s / L[j * n + j];
            }
        }
    }
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= L[i * n + k] * y[k]; y[i] = s / L[i * n + i]; }
    const x = new Float64Array(n);
    for (let i = n - 1; i >= 0; i--) { let s = y[i]; for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k]; x[i] = s / L[i * n + i]; }
    return x;
}

// ============================================================================================
// Absolute anchor against the scan's own texture
// ============================================================================================

export interface TileAnchorFrame { key: string; cam: FrameCamera; image: RgbaImage; valid: Uint8Array }

export interface TileAnchorOptions {
    /** Half-width of the searched horizontal offsets (m). Default 1.5. */
    rangeMeters?: number;
    /** Grid step (m). Default 0.25. */
    stepMeters?: number;
    /** Photo blur in units of the tile texel footprint in the photo (px per texel). Default 0.6. */
    blurPerTexel?: number;
    /** Sample spacing on the photo grid (px). Default 3. */
    sampleStridePx?: number;
    /** Mesh points nearer than this are not sampled (m). Default 5. */
    minDepthMeters?: number;
}

export interface TileAnchorResult {
    stepMeters: number;
    rangeMeters: number;
    /** Horizontal offset of every eye that maximises the aggregate NCC (m). */
    offset: { dx: number; dz: number };
    nccAtZero: number;
    nccBest: number;
    /** Best aggregate NCC minus the mean aggregate NCC on offsets at least 1 m away: how peaked the landscape is. */
    ringContrast: number;
    frames: Array<{ key: string; samples: number; blurPx: number; nccAtZero: number }>;
    /** Aggregate (sample-weighted) NCC, grid[iz][ix] for dz, dx = (i - n) * step. */
    grid: number[][];
}

interface FrameLandscape { key: string; samples: number; blurPx: number; grid: number[][] }

/** NCC landscape of one frame over horizontal eye offsets (grid[iz][ix], offsets (i - n) * step). */
function frameTileLandscape(textured: TexturedPrimitive[], f: TileAnchorFrame, n: number, step: number, k: number, stride: number, minDepth: number): FrameLandscape | null {
    const { cam } = f, W = cam.width, H = cam.height;
    const EMPTY = PLATE_EMPTY_DEPTH * 0.5;
    const r = renderTexturedView(textured, cam, [0, 0, 0], true);
    const tm = r.texelMeters!;
    const fps: number[] = [];
    for (let i = 0; i < W * H; i += 7) if (r.depth[i] < EMPTY && tm[i] > 0) fps.push(tm[i] * cam.fx / r.depth[i]);
    const fpx = median(fps);
    if (fpx === null) return null;
    const blurPx = Math.max(1, k * fpx);
    const Lt = gaussianBlur(luminance(r.rgba, W, H), W, H, 1);
    const Lp = gaussianBlur(luminance(f.image.rgba, W, H), W, H, blurPx);
    const P: number[] = [], V: number[] = [];
    for (let y = 4; y < H - 4; y += stride) for (let x = 4; x < W - 4; x += stride) {
        const i = y * W + x, d = r.depth[i];
        if (!(d < EMPTY) || d < minDepth || !f.valid[i] || !(tm[i] > 0)) continue;
        const u = (x + 0.5 - cam.cx) / cam.fx, v = (y + 0.5 - cam.cy) / cam.fy;
        for (let c = 0; c < 3; c++) P.push(cam.eye[c] + d * (cam.fwd[c] + u * cam.right[c] - v * cam.up[c]));
        V.push(Lt[i]);
    }
    const m = V.length;
    if (m < 500) return null;
    const ncc = (dx: number, dz: number): number => {
        const ex = cam.eye[0] + dx, ey = cam.eye[1], ez = cam.eye[2] + dz;
        let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, cnt = 0;
        for (let q = 0; q < m; q++) {
            const qx = P[q * 3] - ex, qy = P[q * 3 + 1] - ey, qz = P[q * 3 + 2] - ez;
            const z = qx * cam.fwd[0] + qy * cam.fwd[1] + qz * cam.fwd[2];
            if (z < 1) continue;
            const pu = cam.cx + cam.fx * (qx * cam.right[0] + qy * cam.right[1] + qz * cam.right[2]) / z - 0.5;
            const pv = cam.cy - cam.fy * (qx * cam.up[0] + qy * cam.up[1] + qz * cam.up[2]) / z - 0.5;
            if (pu < 0 || pv < 0 || pu >= W - 1 || pv >= H - 1) continue;
            const ix = pu | 0, iy = pv | 0, j = iy * W + ix, ax = pu - ix, ay = pv - iy;
            const b = (Lp[j] * (1 - ax) + Lp[j + 1] * ax) * (1 - ay) + (Lp[j + W] * (1 - ax) + Lp[j + W + 1] * ax) * ay;
            const a = V[q];
            sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b; cnt++;
        }
        if (cnt < 100) return 0;
        const va = saa - sa * sa / cnt, vb = sbb - sb * sb / cnt;
        return va > 1e-9 && vb > 1e-9 ? (sab - sa * sb / cnt) / Math.sqrt(va * vb) : 0;
    };
    const S = 2 * n + 1;
    const grid: number[][] = Array.from({ length: S }, (_, iz) => Array.from({ length: S }, (_, ix) => ncc((ix - n) * step, (iz - n) * step)));
    return { key: f.key, samples: m, blurPx, grid };
}

/** Sample-weighted aggregate of landscapes, its optimum and how peaked it is. */
function aggregateLandscapes(ls: FrameLandscape[], n: number, step: number) {
    const S = 2 * n + 1;
    const agg: number[][] = Array.from({ length: S }, () => new Array(S).fill(0));
    let w = 0;
    for (const l of ls) { for (let a = 0; a < S; a++) for (let b = 0; b < S; b++) agg[a][b] += l.grid[a][b] * l.samples; w += l.samples; }
    let bi = n, bj = n, bv = -2;
    for (let a = 0; a < S; a++) for (let b = 0; b < S; b++) { agg[a][b] = w ? agg[a][b] / w : 0; if (agg[a][b] > bv) { bv = agg[a][b]; bi = a; bj = b; } }
    let ring = 0, rc = 0;
    for (let a = 0; a < S; a++) for (let b = 0; b < S; b++) if (Math.hypot((b - bj) * step, (a - bi) * step) >= 1) { ring += agg[a][b]; rc++; }
    const atEdge = bi === 0 || bj === 0 || bi === S - 1 || bj === S - 1;
    return { grid: agg, offset: { dx: (bj - n) * step, dz: (bi - n) * step }, nccAtZero: agg[n][n], nccBest: bv, ringContrast: rc ? bv - ring / rc : 0, atEdge };
}

export interface TileAnchorGroup { offset: { dx: number; dz: number }; nccAtZero: number; nccBest: number; ringContrast: number; atEdge: boolean; samples: number; grid: number[][] }

/**
 * Cross-view refinement fixes the photos relative to each other, but a translation parallel to a facade that every
 * frame seeing it shares keeps them consistent, so their placement on the mesh rests on the priors. This measures it
 * against the scan's own photogrammetric texture, which is registered to the mesh: every frame's textured-scan render
 * is lifted to 3D samples, the photo is blurred to the tile's resolution (blurPerTexel x the texel footprint in
 * pixels), and the NCC is evaluated for horizontal eye offsets on a grid. A single tile texel spans 5-20 photo pixels,
 * so a frame alone is often too blurry to localise; the landscapes are aggregated per group (e.g. per pano) and over
 * all frames.
 */
export function tileAnchorLandscapes(
    textured: TexturedPrimitive[], frames: TileAnchorFrame[], groupOf: (key: string) => string, opts: TileAnchorOptions = {}
): { stepMeters: number; rangeMeters: number; overall: TileAnchorGroup; groups: Map<string, TileAnchorGroup>; frames: Array<{ key: string; samples: number; blurPx: number; nccAtZero: number }> } {
    const range = opts.rangeMeters ?? 1.5, step = opts.stepMeters ?? 0.25, k = opts.blurPerTexel ?? 0.6;
    const stride = Math.max(1, Math.round(opts.sampleStridePx ?? 3)), minDepth = opts.minDepthMeters ?? 5;
    const n = Math.round(range / step);
    const ls: FrameLandscape[] = [];
    for (const f of frames) { const l = frameTileLandscape(textured, f, n, step, k, stride, minDepth); if (l) ls.push(l); }
    const byGroup = new Map<string, FrameLandscape[]>();
    for (const l of ls) { const g = groupOf(l.key); if (!byGroup.has(g)) byGroup.set(g, []); byGroup.get(g)!.push(l); }
    const pack = (x: FrameLandscape[]): TileAnchorGroup => ({ ...aggregateLandscapes(x, n, step), samples: x.reduce((s, l) => s + l.samples, 0) });
    return {
        stepMeters: step, rangeMeters: range, overall: pack(ls),
        groups: new Map([...byGroup].map(([g, x]) => [g, pack(x)])),
        frames: ls.map(l => ({ key: l.key, samples: l.samples, blurPx: l.blurPx, nccAtZero: l.grid[n][n] }))
    };
}

/** Global offset only (all frames aggregated); see tileAnchorLandscapes. */
export function estimateGlobalTileOffset(textured: TexturedPrimitive[], frames: TileAnchorFrame[], opts: TileAnchorOptions = {}): TileAnchorResult {
    const r = tileAnchorLandscapes(textured, frames, () => 'all', opts);
    return {
        stepMeters: r.stepMeters, rangeMeters: r.rangeMeters, offset: r.overall.offset, nccAtZero: r.overall.nccAtZero, nccBest: r.overall.nccBest,
        ringContrast: r.overall.ringContrast, frames: r.frames, grid: r.overall.grid
    };
}

export interface AnchoredRefinementOptions {
    /** Prior sigma (m, horizontal) around a pano's texture-anchored position. Default 0.5. */
    anchorSigmaMeters?: number;
    /** A pano's anchor is used only when its aggregate landscape is this peaked (best minus mean at >= 1 m). Default 0.04. */
    minRingContrast?: number;
    anchor?: TileAnchorOptions;
    /** Alternations of the second (anchored) pass. Default 2. */
    secondPassIterations?: number;
}

export interface AnchoredRefinementResult {
    first: CrossViewResult;
    anchor: ReturnType<typeof tileAnchorLandscapes>;
    panos: Array<{ panoId: string; offset: { dx: number; dz: number }; ringContrast: number; nccAtZero: number; nccBest: number; atEdge: boolean; used: boolean }>;
    final: CrossViewResult;
}

/**
 * Cross-view refinement, then per-pano texture anchors (tileAnchorLandscapes) as translation priors, then a second
 * cross-view pass: the photos stay mutually consistent while each pano whose frames clearly localise against the
 * scan texture is held near that position (others keep the GPS prior).
 */
export function refineWithTileAnchor(
    refiner: StreetViewCrossViewRefiner, textured: TexturedPrimitive[], start: Map<string, PoseCorrection>, priorCentre: Map<string, PoseCorrection>,
    opts: AnchoredRefinementOptions = {}
): AnchoredRefinementResult {
    const first = refiner.run(start, priorCentre);
    const panoOf = new Map(refiner.frames.map(f => [f.key, f.panoId]));
    const anchor = tileAnchorLandscapes(textured, refiner.frames.map((f, i) => ({ key: f.key, cam: first.cameras[i], image: f.image, valid: f.valid })), k => panoOf.get(k)!, opts.anchor);
    const minContrast = opts.minRingContrast ?? 0.04, sigma = opts.anchorSigmaMeters ?? 0.5;
    const centre = new Map(priorCentre);
    const sigmas = new Map<string, Partial<CrossViewPriors>>();
    const panos: AnchoredRefinementResult['panos'] = [];
    for (const [panoId, g] of anchor.groups) {
        const used = !g.atEdge && g.ringContrast >= minContrast && first.frames.some(f => f.panoId === panoId && f.matches > 0);
        panos.push({ panoId, offset: g.offset, ringContrast: g.ringContrast, nccAtZero: g.nccAtZero, nccBest: g.nccBest, atEdge: g.atEdge, used });
        if (!used) continue;
        const c = first.corrections.get(panoId)!, pc = centre.get(panoId) ?? c;
        centre.set(panoId, { ...pc, dx: c.dx + g.offset.dx, dz: c.dz + g.offset.dz });
        sigmas.set(panoId, { horizontalSigmaMeters: sigma });
    }
    const final = refiner.run(first.corrections, centre, sigmas, { outerIterations: opts.secondPassIterations ?? 2, initialSearchPx: 8 });
    return { first, anchor, panos, final };
}
