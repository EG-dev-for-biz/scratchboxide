/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Street View plate registration against a photogrammetric scan (plan E5-E7).
 *
 * A Street View Static frame is an exact pinhole image (fx = W / 2 / tan(hfov / 2)) whose pose is
 * known only roughly: the pano's GPS position can be metres off in street canyons and its heading,
 * pitch and roll a degree or so. This module recovers ONE rigid correction per pano (shared by all
 * of its frames) by matching what the scan and the photo both contain:
 *
 *   - sky silhouettes: mesh-against-empty-space contours vs the photo sky boundary (unambiguous),
 *   - occluding contours and straight crease chains of the mesh vs oriented photo line segments,
 *   - lines found in the scan's own texture, lifted to 3D through the UVs (optional),
 *   - a sparse photometric term: gradient-rich pixels of the textured scan, lifted to 3D, scored by
 *     NCC against the blurred photo (optional; gain / white-balance invariant). Facades that are flat
 *     in the geometry carry no line features, so this term is what pins the depth direction; on a
 *     synthetic render it recovers a 2 m / 1.5 deg perturbation to about 1 cm / 0.02 deg.
 *
 * The chamfer terms run mesh -> photo through truncated, orientation-binned distance transforms, so
 * extra photo lines (windows, cars, signage) never pull the solution; each feature class gets a fixed
 * share of the cost. A coarse grid over (dx, dz, dyaw, pitch) is followed by bounded Nelder-Mead over
 * all six parameters with Gaussian priors and a visibility recheck. Gates (configurable, plan
 * defaults): silhouette median <= 2 px, line median <= 3 px, sky IoU >= 0.96, solution not on a search
 * bound, frames of one pano agreeing within 0.5 m / 0.3 deg; optional photometric NCC / peak gates.
 * Frames that fail are dropped, never projected.
 *
 * This rigid fit pins rotation against the far sky silhouette but is blind to translation (and on an eroded
 * photogrammetric silhouette biased toward the building), so for texturing it is only the rotation anchor of
 * StreetViewCrossViewRefiner, which refines all panos jointly by photo-to-photo consistency through the mesh and
 * anchors them to the scan's own texture; TEXTURING_GATES then certify each frame by its cross-view residual.
 *
 * Fallback: numbered markers on 3D mesh corners are rendered and Gemini picks their pixels in the
 * photo; solvePnPRansac (fixed intrinsics) seeds a local re-registration.
 *
 * Masks (E5): the bottom watermark strip and occluder boxes (Gemini) are excluded from features and
 * from texturing (plate depth = PLATE_EMPTY_DEPTH) (E7).
 *
 * Conventions: scan frame x = East, y = Up, z = South (-North). Heading is clockwise from north,
 * pitch positive up. Image pixel (i, j) covers [i, i+1) x [j, j+1); projection u = cx + fx * X / Z.
 */

import * as fs from 'fs';
import * as path from 'path';
import { HeadlessMeshSilhouetteRenderer, type RenderMesh3D } from './HeadlessMeshSilhouetteRenderer';
import type { CameraPose6DOF } from './SubPixelEdgeAlignmentOptimizer';
import { SpatialPoseEstimatorService, type Point2D, type Point3D } from './SpatialPoseEstimatorService';
import { decodePng, encodePng } from '../texture-processing';
import { decodeImageToRgbaSync, readImageDimensions, sniffImageFormat } from '../image-codec-ffmpeg';
import type { PinholeIntrinsics } from '../../common/spatial/SurveySynthesisEngine';
import type { ColmapCameraPose } from '../../common/spatial/colmap-vector-reference-types';
import { LocalTangentPlane } from '../../common/coordinate/LocalTangentPlane';
import type { StationPlate } from './SurveyTextureUnprojector';

/** Plate depth value meaning "no surface / do not project" (matches SurveyStationRenderService.EMPTY_DEPTH). */
export const PLATE_EMPTY_DEPTH = 1e9;

// ============================================================================================
// Small vector helpers
// ============================================================================================

type V3 = [number, number, number];
const DEG = Math.PI / 180;
const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm3 = (a: V3): V3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
/** Rodrigues rotation of v about unit axis k by angle (radians), right-handed. */
function rotateAbout(v: V3, k: V3, angle: number): V3 {
    const c = Math.cos(angle), s = Math.sin(angle);
    const kxv = cross3(k, v);
    const kdv = dot3(k, v);
    return [
        v[0] * c + kxv[0] * s + k[0] * kdv * (1 - c),
        v[1] * c + kxv[1] * s + k[1] * kdv * (1 - c),
        v[2] * c + kxv[2] * s + k[2] * kdv * (1 - c)
    ];
}

/** Forward unit vector for a Street View heading (deg, clockwise from north) and pitch (deg, up). */
export function streetViewForward(headingDeg: number, pitchDeg: number): V3 {
    const h = headingDeg * DEG, p = pitchDeg * DEG;
    return [Math.sin(h) * Math.cos(p), Math.sin(p), -Math.cos(h) * Math.cos(p)];
}

/** Vertical fov (deg) of a pinhole frame given its horizontal fov (Street View `fov` is horizontal). */
export function verticalFovDeg(horizontalFovDeg: number, width: number, height: number): number {
    return 2 * Math.atan(Math.tan(horizontalFovDeg * DEG / 2) * height / width) / DEG;
}

/**
 * Street View grounding images (Maps Imagery Grounding API): the requested `fov` is the horizontal fov of a 1920 x 1280 frame,
 * and every aspect ratio is a centred crop of that frame at the same focal length (1920 x 1080, 1707 x 1280, 1280 x 1280,
 * 720 x 1280; measured live with rotated and re-cropped views of one pano). So fx = 960 / tan(fov / 2) at the delivered size,
 * not width / (2 tan(fov / 2)), which is 11 % short for 4:3 and 33-63 % for square and portrait crops.
 */
export const GROUNDING_FRAME_WIDTH_PX = 1920;
export const GROUNDING_FRAME_HEIGHT_PX = 1280;

/** Delivered width of a grounding crop of this aspect (width / height) at full resolution. */
export function groundingCropWidthPx(aspect: number): number {
    return Math.min(GROUNDING_FRAME_WIDTH_PX, GROUNDING_FRAME_HEIGHT_PX * aspect);
}

/** Focal length (px) of a grounding image `width` x `height` (any downscale of a delivered crop) requested with `fovDeg`. */
export function groundingFocalPx(fovDeg: number, width: number, height: number): number {
    return (width / groundingCropWidthPx(width / height)) * (GROUNDING_FRAME_WIDTH_PX / 2) / Math.tan(fovDeg * DEG / 2);
}

/** The true horizontal fov of a grounding image requested with `fovDeg` (what a pinhole of the image's own width needs). */
export function groundingHorizontalFovDeg(fovDeg: number, width: number, height: number): number {
    return 2 * Math.atan(width / 2 / groundingFocalPx(fovDeg, width, height)) / DEG;
}

/** The fov to request for a crop of this aspect so that its true horizontal fov is `horizontalFovDeg`. */
export function groundingRequestFovDeg(horizontalFovDeg: number, aspect: number): number {
    return 2 * Math.atan(Math.tan(horizontalFovDeg * DEG / 2) * GROUNDING_FRAME_WIDTH_PX / groundingCropWidthPx(aspect)) / DEG;
}

export function streetViewIntrinsics(horizontalFovDeg: number, width: number, height: number): PinholeIntrinsics {
    const fx = width / (2 * Math.tan(horizontalFovDeg * DEG / 2));
    return {
        width, height, fx, fy: fx, cx: width / 2, cy: height / 2,
        horizontalFovDegrees: horizontalFovDeg, verticalFovDegrees: verticalFovDeg(horizontalFovDeg, width, height)
    };
}

// ============================================================================================
// Pose model: one rigid correction per pano
// ============================================================================================

/** Rigid correction applied to every frame of one pano. Angles in degrees. */
export interface PoseCorrection {
    dx: number; dy: number; dz: number;
    /** Added to every frame's heading (clockwise from north). */
    dyawDeg: number;
    /** Tilt about the pano reference heading's right axis (positive raises the view at the reference heading). */
    dpitchDeg: number;
    /** Tilt about the pano reference heading's horizontal forward axis (positive lowers the camera's right side). */
    drollDeg: number;
    /**
     * The heading the pitch and roll are about, when the correction is one rigid rotation shared by frames of different
     * headings (a pano registered as a whole). Absent: each frame's own heading (the box registration's convention).
     */
    referenceHeadingDeg?: number;
}

export const ZERO_CORRECTION: PoseCorrection = Object.freeze({ dx: 0, dy: 0, dz: 0, dyawDeg: 0, dpitchDeg: 0, drollDeg: 0 }) as PoseCorrection;

export function correctionToArray(c: PoseCorrection): number[] {
    return [c.dx, c.dy, c.dz, c.dyawDeg, c.dpitchDeg, c.drollDeg];
}
export function arrayToCorrection(a: ArrayLike<number>): PoseCorrection {
    return { dx: a[0], dy: a[1], dz: a[2], dyawDeg: a[3], dpitchDeg: a[4], drollDeg: a[5] };
}

/** Camera basis (world space) of a frame under a pano correction. */
export interface FrameCamera {
    eye: V3; right: V3; up: V3; fwd: V3;
    fx: number; fy: number; cx: number; cy: number;
    width: number; height: number;
}

export function frameCamera(
    nominalEye: V3, headingDeg: number, pitchDeg: number, horizontalFovDeg: number,
    width: number, height: number, corr: PoseCorrection, referenceHeadingDeg: number
): FrameCamera {
    const eye: V3 = [nominalEye[0] + corr.dx, nominalEye[1] + corr.dy, nominalEye[2] + corr.dz];
    let f = streetViewForward(headingDeg, pitchDeg);
    let r = norm3(cross3(f, [0, 1, 0]));
    let u = cross3(r, f);
    const refF = streetViewForward(referenceHeadingDeg, 0);
    const refR = norm3(cross3(refF, [0, 1, 0]));
    // R = Ryaw(dyaw) * R(refRight, dpitch) * R(refFwd, droll), applied to the nominal camera axes
    const steps: Array<[V3, number]> = [
        [refF, corr.drollDeg * DEG],
        [refR, corr.dpitchDeg * DEG],
        [[0, 1, 0], -corr.dyawDeg * DEG] // right-handed +Y rotation decreases heading
    ];
    for (const [axis, ang] of steps) {
        if (ang === 0) continue;
        f = rotateAbout(f, axis, ang); r = rotateAbout(r, axis, ang); u = rotateAbout(u, axis, ang);
    }
    const intr = streetViewIntrinsics(horizontalFovDeg, width, height);
    return { eye, right: norm3(r), up: norm3(u), fwd: norm3(f), fx: intr.fx, fy: intr.fy, cx: intr.cx, cy: intr.cy, width, height };
}

/** CameraPose6DOF (renderer / SurveyTextureUnprojector convention: fov is vertical, `up` carries roll). */
export function frameCameraToPose(cam: FrameCamera): CameraPose6DOF {
    const vfov = 2 * Math.atan(cam.height / 2 / cam.fy) / DEG;
    return {
        x: cam.eye[0], y: cam.eye[1], z: cam.eye[2],
        targetX: cam.eye[0] + cam.fwd[0] * 100, targetY: cam.eye[1] + cam.fwd[1] * 100, targetZ: cam.eye[2] + cam.fwd[2] * 100,
        fov: vfov,
        up: [cam.up[0], cam.up[1], cam.up[2]]
    };
}

/** Projects a world point; returns [u, v, depth] in pixels (u right, v down) or null when behind the camera. */
export function projectToFrame(cam: FrameCamera, p: ArrayLike<number>, offset = 0): [number, number, number] | null {
    const dx = p[offset] - cam.eye[0], dy = p[offset + 1] - cam.eye[1], dz = p[offset + 2] - cam.eye[2];
    const zc = dx * cam.fwd[0] + dy * cam.fwd[1] + dz * cam.fwd[2];
    if (zc <= 1e-3) return null;
    const xc = dx * cam.right[0] + dy * cam.right[1] + dz * cam.right[2];
    const yc = dx * cam.up[0] + dy * cam.up[1] + dz * cam.up[2];
    return [cam.cx + cam.fx * xc / zc, cam.cy - cam.fy * yc / zc, zc];
}

// ============================================================================================
// Image codec: shared ffmpeg helper (exact JFIF colour, temp-file input, timeout + retry, sips fallback)
// ============================================================================================

export interface RgbaImage { width: number; height: number; rgba: Buffer }

/** Width/height from a JPEG's SOF marker, or null (not a JPEG / no SOF). */
export function readJpegSize(buf: Buffer): { width: number; height: number } | null {
    return sniffImageFormat(buf) === 'jpeg' ? readImageDimensions(buf) : null;
}

/** Decodes a PNG or JPEG buffer to RGBA (synchronous; see image-codec-ffmpeg decodeImageToRgbaSync). */
export function decodeImageToRgba(buf: Buffer): RgbaImage {
    return decodeImageToRgbaSync(buf);
}

// ============================================================================================
// Raster helpers: blur, Sobel, exact Euclidean distance transform
// ============================================================================================

export function luminance(rgba: Uint8Array | Buffer, w: number, h: number): Float32Array {
    const L = new Float32Array(w * h);
    for (let i = 0, k = 0; i < w * h; i++, k += 4) L[i] = 0.299 * rgba[k] + 0.587 * rgba[k + 1] + 0.114 * rgba[k + 2];
    return L;
}

export function gaussianBlur(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
    if (sigma <= 0) return Float32Array.from(src);
    const rad = Math.max(1, Math.ceil(sigma * 3));
    const ker = new Float32Array(2 * rad + 1);
    let s = 0;
    for (let i = -rad; i <= rad; i++) { ker[i + rad] = Math.exp(-(i * i) / (2 * sigma * sigma)); s += ker[i + rad]; }
    for (let i = 0; i < ker.length; i++) ker[i] /= s;
    const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
            let acc = 0;
            for (let k = -rad; k <= rad; k++) {
                const xx = x + k < 0 ? 0 : x + k >= w ? w - 1 : x + k;
                acc += src[row + xx] * ker[k + rad];
            }
            tmp[row + x] = acc;
        }
    }
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let acc = 0;
            for (let k = -rad; k <= rad; k++) {
                const yy = y + k < 0 ? 0 : y + k >= h ? h - 1 : y + k;
                acc += tmp[yy * w + x] * ker[k + rad];
            }
            out[y * w + x] = acc;
        }
    }
    return out;
}

/** Sobel gradients normalised to intensity units per pixel (kernel sum / 8). */
export function sobel(src: Float32Array, w: number, h: number): { gx: Float32Array; gy: Float32Array; mag: Float32Array } {
    const gx = new Float32Array(w * h), gy = new Float32Array(w * h), mag = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
            const i = y * w + x;
            const a = src[i - w - 1], b = src[i - w], c = src[i - w + 1];
            const d = src[i - 1], f = src[i + 1];
            const g = src[i + w - 1], hh = src[i + w], k = src[i + w + 1];
            const sx = ((c + 2 * f + k) - (a + 2 * d + g)) / 8;
            const sy = ((g + 2 * hh + k) - (a + 2 * b + c)) / 8;
            gx[i] = sx; gy[i] = sy; mag[i] = Math.hypot(sx, sy);
        }
    }
    return { gx, gy, mag };
}

/**
 * Exact Euclidean distance transform (Felzenszwalb-Huttenlocher) of a binary feature map.
 * Returns the distance (pixels) from every pixel centre to the nearest feature pixel centre,
 * clamped to `cap`.
 */
export function distanceTransform(feature: Uint8Array, w: number, h: number, cap = 64): Float32Array {
    const INF = 1e20;
    const n = Math.max(w, h);
    const f = new Float64Array(n), d = new Float64Array(n), z = new Float64Array(n + 1);
    const v = new Int32Array(n);
    const grid = new Float64Array(w * h);
    for (let i = 0; i < w * h; i++) grid[i] = feature[i] ? 0 : INF;
    const pass = (len: number) => {
        let k = 0; v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
        for (let q = 1; q < len; q++) {
            let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
            while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
            k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
        }
        k = 0;
        for (let q = 0; q < len; q++) {
            while (z[k + 1] < q) k++;
            const dq = q - v[k];
            d[q] = dq * dq + f[v[k]];
        }
    };
    for (let x = 0; x < w; x++) {
        for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
        pass(h);
        for (let y = 0; y < h; y++) grid[y * w + x] = d[y];
    }
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) f[x] = grid[y * w + x];
        pass(w);
        for (let x = 0; x < w; x++) out[y * w + x] = d[x] >= INF * 0.5 ? cap : Math.min(cap, Math.sqrt(d[x]));
    }
    return out;
}

/** Bilinear lookup of a distance map at continuous pixel coordinates (u, v); centres at +0.5. */
function sampleDT(dt: Float32Array, w: number, h: number, u: number, v: number, outside: number): number {
    const x = u - 0.5, y = v - 0.5;
    if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return outside;
    const x0 = x | 0, y0 = y | 0;
    const x1 = x0 + 1 < w ? x0 + 1 : x0, y1 = y0 + 1 < h ? y0 + 1 : y0;
    const fx = x - x0, fy = y - y0;
    const a = dt[y0 * w + x0], b = dt[y0 * w + x1], c = dt[y1 * w + x0], d = dt[y1 * w + x1];
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

function dilateMask(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
    if (r <= 0) return Uint8Array.from(mask);
    const dt = distanceTransform(mask, w, h, r + 2);
    const out = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) out[i] = dt[i] <= r ? 1 : 0;
    return out;
}

/** Labels 4-connected components of `mask`; returns labels (0 = background) and sizes (index = label). */
function connectedComponents(mask: Uint8Array, w: number, h: number): { labels: Int32Array; sizes: number[] } {
    const labels = new Int32Array(w * h);
    const sizes: number[] = [0];
    const stack = new Int32Array(w * h);
    let next = 1;
    for (let i = 0; i < w * h; i++) {
        if (!mask[i] || labels[i]) continue;
        let sp = 0; stack[sp++] = i; labels[i] = next; let count = 0;
        while (sp > 0) {
            const p = stack[--sp]; count++;
            const x = p % w, y = (p / w) | 0;
            if (x > 0 && mask[p - 1] && !labels[p - 1]) { labels[p - 1] = next; stack[sp++] = p - 1; }
            if (x < w - 1 && mask[p + 1] && !labels[p + 1]) { labels[p + 1] = next; stack[sp++] = p + 1; }
            if (y > 0 && mask[p - w] && !labels[p - w]) { labels[p - w] = next; stack[sp++] = p - w; }
            if (y < h - 1 && mask[p + w] && !labels[p + w]) { labels[p + w] = next; stack[sp++] = p + w; }
        }
        sizes.push(count); next++;
    }
    return { labels, sizes };
}

// ============================================================================================
// E5: masks (watermark strip, occluders) and sky segmentation
// ============================================================================================

/** Occluder box in pixel coordinates (x right, y down), inclusive-exclusive. */
export interface OccluderBox { label: string; category?: string; x0: number; y0: number; x1: number; y1: number }

export interface FrameMaskOptions {
    /** Bottom rows carrying the "Google" logo and copyright text. Default 24. */
    watermarkBottomPx?: number;
    occluders?: OccluderBox[];
    /** Occluder box dilation in pixels. Default 8. */
    occluderDilatePx?: number;
}

/** 1 = usable pixel, 0 = masked (watermark strip or occluder). */
export function buildValidMask(width: number, height: number, opts: FrameMaskOptions = {}): Uint8Array {
    const m = new Uint8Array(width * height).fill(1);
    const strip = Math.max(0, Math.min(height, Math.round(opts.watermarkBottomPx ?? 24)));
    for (let y = height - strip; y < height; y++) m.fill(0, y * width, (y + 1) * width);
    const dil = opts.occluderDilatePx ?? 8;
    for (const b of opts.occluders ?? []) {
        const x0 = Math.max(0, Math.floor(Math.min(b.x0, b.x1) - dil)), x1 = Math.min(width, Math.ceil(Math.max(b.x0, b.x1) + dil));
        const y0 = Math.max(0, Math.floor(Math.min(b.y0, b.y1) - dil)), y1 = Math.min(height, Math.ceil(Math.max(b.y0, b.y1) + dil));
        for (let y = y0; y < y1; y++) m.fill(0, y * width + x0, y * width + x1);
    }
    return m;
}

export interface SkySegmentationOptions {
    /** Max per-pixel colour gradient (intensity / px) of a sky pixel. Default 3. */
    smoothGradient?: number;
    /** Max mean colour gradient in a 9x9 window (texture energy) of a sky pixel. Default 2.2. */
    textureEnergy?: number;
    /** A candidate sky region whose enclosed non-sky holes exceed this fraction is a facade (window grid). Default 0.12. */
    maxHoleFraction?: number;
    /** Width (px) of the band outside the core sky mask that is reassigned by local colour (see refineSkyBoundary). Default 8. */
    boundaryBandPx?: number;
}

/**
 * Colour gradient: per-pixel maximum of the Sobel magnitudes of the blurred R, G and B channels.
 * Unlike a luminance gradient it separates blue sky from an equally bright shaded facade.
 */
export function colourGradient(rgba: Uint8Array | Buffer, w: number, h: number, sigma = 1.2): Float32Array {
    const out = new Float32Array(w * h);
    const ch = new Float32Array(w * h);
    for (let c = 0; c < 3; c++) {
        for (let i = 0; i < w * h; i++) ch[i] = rgba[i * 4 + c];
        const { mag } = sobel(gaussianBlur(ch, w, h, sigma), w, h);
        for (let i = 0; i < w * h; i++) if (mag[i] > out[i]) out[i] = mag[i];
    }
    return out;
}

/** Box mean over a (2r+1)^2 window via an integral image (edges clamp). */
function boxMean(src: Float32Array, w: number, h: number, r: number): Float32Array {
    const I = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
        let row = 0;
        for (let x = 0; x < w; x++) { row += src[y * w + x]; I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row; }
    }
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
        const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
        for (let x = 0; x < w; x++) {
            const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
            const s = I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0];
            out[y * w + x] = s / ((y1 - y0) * (x1 - x0));
        }
    }
    return out;
}

/**
 * Sky mask of a street-level photo: smooth, low-texture, sky-coloured pixels (clear blue, or bright
 * neutral / cool overcast) connected to the top or upper side borders. Connected candidate regions
 * whose enclosed holes exceed `maxHoleFraction` (a window grid on a pale facade) are rejected; small
 * enclosed holes (birds, wires) are filled. Masked pixels are never sky.
 */
export function segmentSky(rgba: Uint8Array | Buffer, w: number, h: number, valid: Uint8Array, opts: SkySegmentationOptions = {}): Uint8Array {
    const g1 = opts.smoothGradient ?? 3, e1 = opts.textureEnergy ?? 2.2, maxHoleFrac = opts.maxHoleFraction ?? 0.12;
    const L = luminance(rgba, w, h);
    const grad = colourGradient(rgba, w, h);
    const energy = boxMean(grad, w, h, 4);
    // Brightness reference: sky is (one of) the brightest large regions of a street frame
    const hist = new Uint32Array(256);
    for (let i = 0; i < w * h; i++) if (valid[i]) hist[Math.min(255, L[i] | 0)]++;
    let total = 0; for (let i = 0; i < 256; i++) total += hist[i];
    let acc = 0, p90 = 255;
    for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= total * 0.9) { p90 = i; break; } }
    const brightMin = Math.max(130, p90 * 0.82);
    const cand = new Uint8Array(w * h);
    for (let i = 0, k = 0; i < w * h; i++, k += 4) {
        if (!valid[i] || grad[i] > g1 || energy[i] > e1) continue;
        const r = rgba[k], g = rgba[k + 1], b = rgba[k + 2];
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        const clearBlue = b >= r + 25 && b >= g && b >= 110;
        // Overcast / hazy sky is neutral or cool; sunlit stone and brick are warm (R > B)
        const brightNeutral = L[i] >= brightMin && (mx - mn) <= 38 && b >= r - 6;
        if (clearBlue || brightNeutral) cand[i] = 1;
    }
    // Flood fill from the top border and the upper 60 % of the side borders
    const sky = new Uint8Array(w * h);
    const stack = new Int32Array(w * h);
    let sp = 0;
    const seed = (i: number) => { if (cand[i] && !sky[i]) { sky[i] = 1; stack[sp++] = i; } };
    for (let x = 0; x < w; x++) seed(x);
    for (let y = 0; y < Math.floor(h * 0.6); y++) { seed(y * w); seed(y * w + w - 1); }
    while (sp > 0) {
        const p = stack[--sp];
        const x = p % w, y = (p / w) | 0;
        if (x > 0) seed(p - 1);
        if (x < w - 1) seed(p + 1);
        if (y > 0) seed(p - w);
        if (y < h - 1) seed(p + w);
    }
    // Per sky component: enclosed hole area (non-sky components off the border, attributed to the adjacent sky component)
    const sc = connectedComponents(sky, w, h);
    const notSky = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) notSky[i] = sky[i] ? 0 : 1;
    const nc = connectedComponents(notSky, w, h);
    const touchesBorder = new Uint8Array(nc.sizes.length);
    for (let x = 0; x < w; x++) { touchesBorder[nc.labels[x]] = 1; touchesBorder[nc.labels[(h - 1) * w + x]] = 1; }
    for (let y = 0; y < h; y++) { touchesBorder[nc.labels[y * w]] = 1; touchesBorder[nc.labels[y * w + w - 1]] = 1; }
    const holeOwner = new Int32Array(nc.sizes.length).fill(-1);
    for (let i = 0; i < w * h; i++) {
        const l = nc.labels[i];
        if (!l || touchesBorder[l] || holeOwner[l] >= 0) continue;
        const x = i % w;
        const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w];
        for (const j of nb) { if (j >= 0 && j < w * h && sky[j]) { holeOwner[l] = sc.labels[j]; break; } }
    }
    const holes = new Float64Array(sc.sizes.length);
    for (let l = 1; l < nc.sizes.length; l++) if (holeOwner[l] > 0) holes[holeOwner[l]] += nc.sizes[l];
    // Share of clear-blue pixels per component: when the dominant sky is clear blue, a separate
    // component with almost no blue is a pale facade (or awning) that happened to pass, not sky.
    const blueCount = new Float64Array(sc.sizes.length);
    for (let i = 0, k = 0; i < w * h; i++, k += 4) {
        if (!sky[i]) continue;
        const r = rgba[k], g = rgba[k + 1], b = rgba[k + 2];
        if (b >= r + 25 && b >= g && b >= 110) blueCount[sc.labels[i]]++;
    }
    let largest = 0;
    for (let l = 1; l < sc.sizes.length; l++) if (sc.sizes[l] > sc.sizes[largest] || largest === 0) largest = l;
    const dominantBlue = largest > 0 && blueCount[largest] / sc.sizes[largest] >= 0.7;
    const keep = new Uint8Array(sc.sizes.length);
    const minSky = w * h * 0.0008;
    for (let l = 1; l < sc.sizes.length; l++) {
        const frac = holes[l] / (holes[l] + sc.sizes[l]);
        const paleOutlier = dominantBlue && l !== largest && blueCount[l] / sc.sizes[l] < 0.3;
        keep[l] = sc.sizes[l] >= minSky && frac <= maxHoleFrac && !paleOutlier ? 1 : 0;
    }
    const maxHole = w * h * 0.004;
    const out = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
        if (sky[i]) { out[i] = keep[sc.labels[i]]; continue; }
        const l = nc.labels[i];
        if (l && !touchesBorder[l] && nc.sizes[l] <= maxHole && valid[i] && holeOwner[l] > 0 && keep[holeOwner[l]]) out[i] = 1;
    }
    return refineSkyBoundary(rgba, w, h, out, valid, opts.boundaryBandPx ?? 8);
}

/**
 * Moves the sky boundary onto the colour edge. The smoothness / texture tests keep the core sky mask a
 * few pixels away from strong edges; every pixel within `band` px outside the core is reassigned by a
 * local two-class test: closer (RGB) to the mean of nearby core-sky pixels or to the mean of nearby
 * pixels that are clearly not sky (farther than `band` from the core). Only pixels connected to the
 * sky through reassigned pixels are kept.
 */
function refineSkyBoundary(rgba: Uint8Array | Buffer, w: number, h: number, core: Uint8Array, valid: Uint8Array, band: number): Uint8Array {
    let any = false;
    for (let i = 0; i < w * h; i++) if (core[i]) { any = true; break; }
    if (!any || band <= 0) return core;
    const dist = distanceTransform(core, w, h, band + 2);
    const far = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) far[i] = !core[i] && dist[i] > band && valid[i] ? 1 : 0;
    const r = band + 4;
    const meanOf = (mask: Uint8Array) => {
        const sums: Float32Array[] = [];
        const cnt = new Float32Array(w * h);
        for (let i = 0; i < w * h; i++) cnt[i] = mask[i];
        const cm = boxMean(cnt, w, h, r);
        for (let c = 0; c < 3; c++) {
            const ch = new Float32Array(w * h);
            for (let i = 0; i < w * h; i++) ch[i] = mask[i] ? rgba[i * 4 + c] : 0;
            sums.push(boxMean(ch, w, h, r));
        }
        return { cm, sums };
    };
    const S = meanOf(core), B = meanOf(far);
    const cand = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
        if (core[i] || !valid[i] || dist[i] > band || S.cm[i] <= 0 || B.cm[i] <= 0) continue;
        let ds = 0, db = 0;
        for (let c = 0; c < 3; c++) {
            const v = rgba[i * 4 + c];
            ds += (v - S.sums[c][i] / S.cm[i]) ** 2;
            db += (v - B.sums[c][i] / B.cm[i]) ** 2;
        }
        if (ds < db) cand[i] = 1;
    }
    // keep candidates connected to the core
    const out = Uint8Array.from(core);
    const stack: number[] = [];
    for (let i = 0; i < w * h; i++) if (core[i]) stack.push(i);
    while (stack.length) {
        const p = stack.pop()!;
        const x = p % w;
        for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) {
            if (q < 0 || q >= w * h || out[q] || !cand[q]) continue;
            out[q] = 1; stack.push(q);
        }
    }
    return out;
}

// ============================================================================================
// E6 photo features: line segments (region growing on level-line orientation) + oriented DTs
// ============================================================================================

export interface LineSegment2D {
    x0: number; y0: number; x1: number; y1: number;
    /** Undirected orientation in degrees, [0, 180). */
    orientationDeg: number;
    length: number;
    width: number;
    support: number;
}

export interface LineSegmentOptions {
    minLength?: number;        // default 40 px
    angleToleranceDeg?: number; // default 22.5
    magnitudeThreshold?: number; // default 4 (intensity / px)
    maxWidth?: number;           // default 8 px (blurred edges are ~5-6 px wide)
}

/**
 * LSD-style line-support regions: pixels are grown (8-connected, strongest first) while their
 * level-line angle (with polarity) stays within the tolerance of the region's mean angle. Each
 * region is fitted by weighted PCA and kept when it is long and thin.
 */
export function detectLineSegments(
    blurred: Float32Array, w: number, h: number, valid: Uint8Array, opts: LineSegmentOptions = {}
): LineSegment2D[] {
    const minLen = opts.minLength ?? 40, tol = (opts.angleToleranceDeg ?? 22.5) * DEG;
    const thr = opts.magnitudeThreshold ?? 4, maxWidth = opts.maxWidth ?? 8;
    const { gx, gy, mag } = sobel(blurred, w, h);
    const ang = new Float32Array(w * h);
    const status = new Uint8Array(w * h); // 0 free, 1 used/ineligible
    const NB = 1024;
    let mmax = 0;
    for (let i = 0; i < w * h; i++) {
        ang[i] = Math.atan2(gx[i], -gy[i]); // level-line direction (perpendicular to gradient), with polarity
        const x = i % w, y = (i / w) | 0;
        if (!valid[i] || mag[i] < thr || x < 1 || y < 1 || x >= w - 1 || y >= h - 1) status[i] = 1;
        else if (mag[i] > mmax) mmax = mag[i];
    }
    // Bucket sort eligible pixels by magnitude (descending)
    const bucketCount = new Int32Array(NB);
    const scale = (NB - 1) / Math.max(1e-6, mmax);
    for (let i = 0; i < w * h; i++) if (!status[i]) bucketCount[Math.min(NB - 1, (mag[i] * scale) | 0)]++;
    const bucketStart = new Int32Array(NB + 1);
    for (let b = NB - 1, acc = 0; b >= 0; b--) { bucketStart[b] = acc; acc += bucketCount[b]; }
    const order = new Int32Array(w * h);
    const fill = Int32Array.from(bucketStart.subarray(0, NB));
    let eligible = 0;
    for (let i = 0; i < w * h; i++) if (!status[i]) { order[fill[Math.min(NB - 1, (mag[i] * scale) | 0)]++] = i; eligible++; }

    const segs: LineSegment2D[] = [];
    const region = new Int32Array(w * h);
    const cosTol = Math.cos(tol);
    for (let oi = 0; oi < eligible; oi++) {
        const s = order[oi];
        if (status[s]) continue;
        let n = 0;
        region[n++] = s; status[s] = 1;
        let sx = Math.cos(ang[s]), sy = Math.sin(ang[s]);
        let rc = sx, rs = sy;
        for (let k = 0; k < n; k++) {
            const p = region[k];
            const px = p % w, py = (p / w) | 0;
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    if (!dx && !dy) continue;
                    const qx = px + dx, qy = py + dy;
                    if (qx < 0 || qy < 0 || qx >= w || qy >= h) continue;
                    const q = qy * w + qx;
                    if (status[q]) continue;
                    if (Math.cos(ang[q]) * rc + Math.sin(ang[q]) * rs < cosTol) continue;
                    status[q] = 1; region[n++] = q;
                    sx += Math.cos(ang[q]); sy += Math.sin(ang[q]);
                    const l = Math.hypot(sx, sy) || 1; rc = sx / l; rs = sy / l;
                }
            }
        }
        if (n < minLen * 0.5) continue;
        // Weighted PCA
        let W = 0, mx = 0, my = 0;
        for (let k = 0; k < n; k++) { const p = region[k]; const wt = mag[p]; W += wt; mx += wt * (p % w + 0.5); my += wt * (((p / w) | 0) + 0.5); }
        mx /= W; my /= W;
        let cxx = 0, cxy = 0, cyy = 0;
        for (let k = 0; k < n; k++) {
            const p = region[k]; const wt = mag[p];
            const ex = p % w + 0.5 - mx, ey = ((p / w) | 0) + 0.5 - my;
            cxx += wt * ex * ex; cxy += wt * ex * ey; cyy += wt * ey * ey;
        }
        const theta = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
        const ux = Math.cos(theta), uy = Math.sin(theta);
        let lmin = Infinity, lmax = -Infinity, wmin = Infinity, wmax = -Infinity;
        for (let k = 0; k < n; k++) {
            const p = region[k];
            const ex = p % w + 0.5 - mx, ey = ((p / w) | 0) + 0.5 - my;
            const a = ex * ux + ey * uy, b = -ex * uy + ey * ux;
            if (a < lmin) lmin = a; if (a > lmax) lmax = a;
            if (b < wmin) wmin = b; if (b > wmax) wmax = b;
        }
        const length = lmax - lmin + 1, width = wmax - wmin + 1;
        if (length < minLen || width > Math.max(maxWidth, 0.05 * length)) continue;
        if (n / (length * width) < 0.35) continue;
        let o = theta / DEG; o = ((o % 180) + 180) % 180;
        segs.push({ x0: mx + ux * lmin, y0: my + uy * lmin, x1: mx + ux * lmax, y1: my + uy * lmax, orientationDeg: o, length, width, support: n });
    }
    return segs;
}

function rasterizeSegment(map: Uint8Array, w: number, h: number, s: { x0: number; y0: number; x1: number; y1: number }): void {
    const len = Math.hypot(s.x1 - s.x0, s.y1 - s.y0);
    const steps = Math.max(1, Math.ceil(len * 2));
    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const x = Math.floor(s.x0 + (s.x1 - s.x0) * t), y = Math.floor(s.y0 + (s.y1 - s.y0) * t);
        if (x >= 0 && y >= 0 && x < w && y < h) map[y * w + x] = 1;
    }
}

/** Number of orientation bins of the oriented line distance transforms (10 degrees each). */
export const ORIENTATION_BINS = 18;
const BIN_WIDTH_DEG = 180 / ORIENTATION_BINS;

export interface PhotoFeatures {
    width: number; height: number;
    valid: Uint8Array;
    sky: Uint8Array;
    skyFraction: number;
    segments: LineSegment2D[];
    /** ORIENTATION_BINS distance maps; bin k holds segments within `orientationToleranceDeg` of k * 10 deg. */
    lineDT: Float32Array[];
    /** Distance to the photo sky boundary (excluding boundaries with masked pixels / image border). */
    skyDT: Float32Array;
    dtCap: number;
    /** Photo luminance blurred to roughly the scan texture's resolution (photometric term). */
    lumBlur: Float32Array;
}

export interface PhotoFeatureOptions extends LineSegmentOptions, SkySegmentationOptions {
    orientationToleranceDeg?: number; // default 20
    dtCap?: number;                   // default 40 px (stages truncate lower)
    blurSigma?: number;               // default 1.5
    /** Blur of the photo luminance compared with the scan texture. Default 3 px. */
    photometricBlurPx?: number;
}

export function buildPhotoFeatures(img: RgbaImage, valid: Uint8Array, opts: PhotoFeatureOptions = {}): PhotoFeatures {
    const { width: w, height: h, rgba } = img;
    const cap = opts.dtCap ?? 40;
    const tolDeg = opts.orientationToleranceDeg ?? 20;
    const blurred = gaussianBlur(luminance(rgba, w, h), w, h, opts.blurSigma ?? 1.5);
    const sky = segmentSky(rgba, w, h, valid, opts);
    let skyCount = 0; for (let i = 0; i < w * h; i++) skyCount += sky[i];
    // Lines may not cross into the sky interior: suppress gradients deep inside the sky mask
    const segments = detectLineSegments(blurred, w, h, valid, opts);
    const lineDT: Float32Array[] = [];
    for (let k = 0; k < ORIENTATION_BINS; k++) {
        const c = k * BIN_WIDTH_DEG;
        const map = new Uint8Array(w * h);
        for (const s of segments) {
            let d = Math.abs(s.orientationDeg - c); if (d > 90) d = 180 - d;
            if (d <= tolDeg) rasterizeSegment(map, w, h, s);
        }
        lineDT.push(distanceTransform(map, w, h, cap));
    }
    // Sky boundary: sky pixel with a non-sky, valid 4-neighbour
    const boundary = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
            const i = y * w + x;
            if (!sky[i]) continue;
            const nb = [i - 1, i + 1, i - w, i + w];
            for (const j of nb) { if (!sky[j] && valid[j]) { boundary[i] = 1; break; } }
        }
    }
    const skyDT = distanceTransform(boundary, w, h, cap);
    const lumBlur = gaussianBlur(luminance(rgba, w, h), w, h, opts.photometricBlurPx ?? 3);
    return { width: w, height: h, valid, sky, skyFraction: skyCount / (w * h), segments, lineDT, skyDT, dtCap: cap, lumBlur };
}

/** Bin index for an undirected 2D orientation (degrees). */
export function orientationBin(orientationDeg: number): number {
    let o = ((orientationDeg % 180) + 180) % 180;
    return Math.round(o / BIN_WIDTH_DEG) % ORIENTATION_BINS;
}

// ============================================================================================
// E6 mesh features: crease edges (3D, pose independent) and per-frame visible / silhouette samples
// ============================================================================================

export interface CreaseExtractionOptions {
    /** Minimum angle between adjacent face normals (orientation-insensitive). Default 35. */
    minDihedralDeg?: number;
    /** Minimum length of a single crease edge in metres. Default 0.3. */
    minEdgeLengthMeters?: number;
    /**
     * Minimum length of a straight crease chain in metres. Photogrammetric tiles are full of short,
     * randomly oriented creases (surface noise); structural lines (building corners, setbacks,
     * cornices) form long straight chains. Default 6. Set 0 to keep every crease edge.
     */
    minChainLengthMeters?: number;
    /** Maximum turn between consecutive edges of a chain. Default 20 deg. */
    maxChainTurnDeg?: number;
    /** A chain is split where a vertex deviates more than max(this, 2 % of the chord) from the chord. Default 0.3 m. */
    chainDeviationMeters?: number;
    /** Sample spacing along creases in metres. Default 0.25. */
    sampleSpacingMeters?: number;
    /** Vertex weld quantum in metres (tiles duplicate vertices along chunk seams). Default 1e-3. */
    weldEpsilonMeters?: number;
}

export interface CreaseSampleSet {
    count: number;
    /** xyz per sample */
    pos: Float32Array;
    /** unit line direction per sample */
    dir: Float32Array;
    /** crease edges passing the dihedral / edge-length test */
    edgeCount: number;
    /** straight chains kept (each sampled along its chord) */
    chainCount: number;
    totalLengthMeters: number;
}

/**
 * Structural crease lines of a triangle soup. Vertices are welded; an edge shared by exactly two
 * faces is a crease when the angle between their normals exceeds `minDihedralDeg` (|n1 . n2| test,
 * since photogrammetry tiles mix winding). Creases are linked into chains through vertices where
 * they continue nearly collinearly, chains are split into straight pieces (Douglas-Peucker on the
 * chord deviation), and pieces of at least `minChainLengthMeters` are sampled along their chord.
 */
export function extractCreaseSamples(mesh: RenderMesh3D, opts: CreaseExtractionOptions = {}): CreaseSampleSet {
    const minDihedral = opts.minDihedralDeg ?? 35, minLen = opts.minEdgeLengthMeters ?? 0.3;
    const spacing = opts.sampleSpacingMeters ?? 0.25, eps = opts.weldEpsilonMeters ?? 1e-3;
    const minChain = opts.minChainLengthMeters ?? 6, maxTurn = opts.maxChainTurnDeg ?? 20, devTol = opts.chainDeviationMeters ?? 0.3;
    const V = mesh.vertices, I = mesh.indices;
    const nv = Math.floor(V.length / 3), nt = Math.floor(I.length / 3);
    const weld = new Int32Array(nv);
    const keyMap = new Map<string, number>();
    const wpos: number[] = [];
    for (let i = 0; i < nv; i++) {
        const k = `${Math.round(V[i * 3] / eps)},${Math.round(V[i * 3 + 1] / eps)},${Math.round(V[i * 3 + 2] / eps)}`;
        let id = keyMap.get(k);
        if (id === undefined) { id = wpos.length / 3; keyMap.set(k, id); wpos.push(V[i * 3], V[i * 3 + 1], V[i * 3 + 2]); }
        weld[i] = id;
    }
    const nw = wpos.length / 3;
    const tn = new Float32Array(nt * 3);
    const triOk = new Uint8Array(nt);
    for (let t = 0; t < nt; t++) {
        const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
        const ux = V[b] - V[a], uy = V[b + 1] - V[a + 1], uz = V[b + 2] - V[a + 2];
        const vx = V[c] - V[a], vy = V[c + 1] - V[a + 1], vz = V[c + 2] - V[a + 2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const l = Math.hypot(nx, ny, nz);
        if (l < 1e-8) continue;
        triOk[t] = 1; tn[t * 3] = nx / l; tn[t * 3 + 1] = ny / l; tn[t * 3 + 2] = nz / l;
    }
    const edgeIndex = new Map<number, number>();
    const eA: number[] = [], eB: number[] = [], eT0: number[] = [], eT1: number[] = [], eCount: number[] = [];
    for (let t = 0; t < nt; t++) {
        if (!triOk[t]) continue;
        for (let k = 0; k < 3; k++) {
            let a = weld[I[t * 3 + k]], b = weld[I[t * 3 + (k + 1) % 3]];
            if (a === b) continue;
            if (a > b) { const tmp = a; a = b; b = tmp; }
            const key = a * nw + b;
            const e = edgeIndex.get(key);
            if (e === undefined) { edgeIndex.set(key, eA.length); eA.push(a); eB.push(b); eT0.push(t); eT1.push(-1); eCount.push(1); }
            else { if (eCount[e] === 1) eT1[e] = t; eCount[e]++; }
        }
    }
    const cosMax = Math.cos(minDihedral * DEG);
    // Crease edges
    const cA: number[] = [], cB: number[] = [];
    for (let e = 0; e < eA.length; e++) {
        if (eCount[e] !== 2) continue;
        const t0 = eT0[e], t1 = eT1[e];
        const d = Math.abs(tn[t0 * 3] * tn[t1 * 3] + tn[t0 * 3 + 1] * tn[t1 * 3 + 1] + tn[t0 * 3 + 2] * tn[t1 * 3 + 2]);
        if (d >= cosMax) continue;
        const len = Math.hypot(wpos[eB[e] * 3] - wpos[eA[e] * 3], wpos[eB[e] * 3 + 1] - wpos[eA[e] * 3 + 1], wpos[eB[e] * 3 + 2] - wpos[eA[e] * 3 + 2]);
        if (len < minLen) continue;
        cA.push(eA[e]); cB.push(eB[e]);
    }
    const nc = cA.length;
    const pos: number[] = [], dir: number[] = [];
    let totalLength = 0, chainCount = 0;
    const samplePolyline = (pts: number[]) => {
        // sample along the chord of a straight piece (its vertices deviate < tolerance from it)
        const ax = wpos[pts[0] * 3], ay = wpos[pts[0] * 3 + 1], az = wpos[pts[0] * 3 + 2];
        const last = pts[pts.length - 1];
        const bx = wpos[last * 3], by = wpos[last * 3 + 1], bz = wpos[last * 3 + 2];
        const len = Math.hypot(bx - ax, by - ay, bz - az);
        if (len < Math.max(minChain, 1e-6)) return;
        chainCount++; totalLength += len;
        const n = Math.max(1, Math.floor(len / spacing));
        const dx = (bx - ax) / len, dy = (by - ay) / len, dz = (bz - az) / len;
        for (let i = 0; i < n; i++) {
            const s = (i + 0.5) / n;
            pos.push(ax + (bx - ax) * s, ay + (by - ay) * s, az + (bz - az) * s);
            dir.push(dx, dy, dz);
        }
    };
    if (minChain <= 0) {
        for (let e = 0; e < nc; e++) samplePolyline([cA[e], cB[e]]);
        return { count: pos.length / 3, pos: Float32Array.from(pos), dir: Float32Array.from(dir), edgeCount: nc, chainCount, totalLengthMeters: totalLength };
    }
    // Link crease edges through shared vertices where they continue nearly collinearly
    const incident = new Map<number, number[]>();
    for (let e = 0; e < nc; e++) {
        for (const v of [cA[e], cB[e]]) { const l = incident.get(v); if (l) l.push(e); else incident.set(v, [e]); }
    }
    const linkA = new Int32Array(nc).fill(-1), linkB = new Int32Array(nc).fill(-1); // neighbour edge at cA / cB end
    const cosTurn = Math.cos(maxTurn * DEG);
    const other = (e: number, v: number) => (cA[e] === v ? cB[e] : cA[e]);
    for (const [v, edges] of incident) {
        if (edges.length < 2) continue;
        const pairs: Array<[number, number, number]> = [];
        for (let i = 0; i < edges.length; i++) for (let j = i + 1; j < edges.length; j++) {
            const e1 = edges[i], e2 = edges[j];
            const o1 = other(e1, v), o2 = other(e2, v);
            const d1x = wpos[v * 3] - wpos[o1 * 3], d1y = wpos[v * 3 + 1] - wpos[o1 * 3 + 1], d1z = wpos[v * 3 + 2] - wpos[o1 * 3 + 2];
            const d2x = wpos[o2 * 3] - wpos[v * 3], d2y = wpos[o2 * 3 + 1] - wpos[v * 3 + 1], d2z = wpos[o2 * 3 + 2] - wpos[v * 3 + 2];
            const c = (d1x * d2x + d1y * d2y + d1z * d2z) / ((Math.hypot(d1x, d1y, d1z) * Math.hypot(d2x, d2y, d2z)) || 1);
            if (c >= cosTurn) pairs.push([c, e1, e2]);
        }
        pairs.sort((a, b) => b[0] - a[0]);
        const used = new Set<number>();
        for (const [, e1, e2] of pairs) {
            if (used.has(e1) || used.has(e2)) continue;
            used.add(e1); used.add(e2);
            if (cA[e1] === v) linkA[e1] = e2; else linkB[e1] = e2;
            if (cA[e2] === v) linkA[e2] = e1; else linkB[e2] = e1;
        }
    }
    // Walk chains as vertex sequences, split into straight pieces, sample pieces
    const visited = new Uint8Array(nc);
    const walk = (e0: number, vStart: number): number[] => {
        // vertices from vStart through e0 and onward until the chain ends
        const verts: number[] = [vStart];
        let e = e0, v = vStart;
        while (e >= 0 && !visited[e]) {
            visited[e] = 1;
            const w = other(e, v);
            verts.push(w);
            const next = cA[e] === w ? linkA[e] : linkB[e];
            v = w; e = next;
        }
        return verts;
    };
    const split = (verts: number[], out: number[][]) => {
        if (verts.length < 2) return;
        const a = verts[0], b = verts[verts.length - 1];
        const ax = wpos[a * 3], ay = wpos[a * 3 + 1], az = wpos[a * 3 + 2];
        let ux = wpos[b * 3] - ax, uy = wpos[b * 3 + 1] - ay, uz = wpos[b * 3 + 2] - az;
        const L = Math.hypot(ux, uy, uz) || 1e-9; ux /= L; uy /= L; uz /= L;
        let worst = -1, worstD = 0;
        for (let k = 1; k < verts.length - 1; k++) {
            const qx = wpos[verts[k] * 3] - ax, qy = wpos[verts[k] * 3 + 1] - ay, qz = wpos[verts[k] * 3 + 2] - az;
            const t = qx * ux + qy * uy + qz * uz;
            const d = Math.hypot(qx - t * ux, qy - t * uy, qz - t * uz);
            if (d > worstD) { worstD = d; worst = k; }
        }
        if (worst > 0 && worstD > Math.max(devTol, 0.02 * L)) { split(verts.slice(0, worst + 1), out); split(verts.slice(worst), out); }
        else out.push(verts);
    };
    for (let e = 0; e < nc; e++) {
        if (visited[e]) continue;
        // find one end of the chain containing e (bounded walk to handle cycles)
        let cur = e, v = cA[e], guard = 0;
        while (guard++ < nc) {
            const prev = cA[cur] === v ? linkA[cur] : linkB[cur];
            if (prev < 0 || prev === e) break;
            v = other(prev, v); cur = prev;
        }
        const verts = walk(cur, v);
        const pieces: number[][] = [];
        split(verts, pieces);
        for (const pc of pieces) samplePolyline(pc);
    }
    return { count: pos.length / 3, pos: Float32Array.from(pos), dir: Float32Array.from(dir), edgeCount: nc, chainCount, totalLengthMeters: totalLength };
}

/** Depth render (camera-z, PLATE_EMPTY_DEPTH where empty) of the mesh from a frame camera, near-plane clipped. */
export function renderFrameDepth(mesh: RenderMesh3D, cam: FrameCamera): Float32Array {
    return HeadlessMeshSilhouetteRenderer.renderMesh(mesh, frameCameraToPose(cam), cam.width, cam.height, { clipNearPlane: true }).depthBuffer;
}

interface FrameMeshFeatures {
    /** visible crease samples at the reference pose */
    cPos: Float32Array; cDir: Float32Array; cBin: Uint8Array; cCount: number;
    /** visible texture-line samples (lines in the scan's own texture) */
    tPos: Float32Array; tBin: Uint8Array; tCount: number;
    /** occluding contours (near surface in front of a farther surface) lifted to 3D, with 2D orientation bin */
    kPos: Float32Array; kBin: Uint8Array; kCount: number;
    /** silhouette (mesh against empty space) samples lifted to 3D */
    sPos: Float32Array; sCount: number;
    /** photometric samples: textured-render pixels with strong gradients, lifted to 3D, with their scan-texture luminance */
    pPos: Float32Array; pVal: Float32Array; pCount: number;
    depth: Float32Array;
}

function projectedOrientationDeg(cam: FrameCamera, px: number, py: number, pz: number, dx: number, dy: number, dz: number): number {
    const qx = px - cam.eye[0], qy = py - cam.eye[1], qz = pz - cam.eye[2];
    const z = qx * cam.fwd[0] + qy * cam.fwd[1] + qz * cam.fwd[2];
    const x = qx * cam.right[0] + qy * cam.right[1] + qz * cam.right[2];
    const y = qx * cam.up[0] + qy * cam.up[1] + qz * cam.up[2];
    const dzc = dx * cam.fwd[0] + dy * cam.fwd[1] + dz * cam.fwd[2];
    const dxc = dx * cam.right[0] + dy * cam.right[1] + dz * cam.right[2];
    const dyc = dx * cam.up[0] + dy * cam.up[1] + dz * cam.up[2];
    const du = cam.fx * (dxc * z - x * dzc) / (z * z);
    const dv = -cam.fy * (dyc * z - y * dzc) / (z * z);
    return Math.atan2(dv, du) / DEG;
}

/**
 * Visible crease samples and sky-silhouette samples of one frame at a reference camera.
 * `skyBand` controls which silhouette samples are trusted: the photo must show sky on the mesh's
 * empty side at enough of the probe distances (rejects silhouettes against buildings beyond the
 * tile, trees or masked areas).
 */
/** 3D line samples visible at a camera (depth test), thinned to one per 2x2 px cell and orientation bin. */
function visibleLineSamples(set: CreaseSampleSet | undefined, cam: FrameCamera, depth: Float32Array, photo: PhotoFeatures, minDepthMeters: number) {
    const w = cam.width, h = cam.height;
    const P: number[] = [], D: number[] = [], B: number[] = [];
    if (!set) return { pos: P, dir: D, bin: B };
    const gw = Math.ceil(w / 2);
    const occupied = new Uint8Array(gw * Math.ceil(h / 2) * ORIENTATION_BINS);
    for (let i = 0; i < set.count; i++) {
        const px = set.pos[i * 3], py = set.pos[i * 3 + 1], pz = set.pos[i * 3 + 2];
        const qx = px - cam.eye[0], qy = py - cam.eye[1], qz = pz - cam.eye[2];
        const z = qx * cam.fwd[0] + qy * cam.fwd[1] + qz * cam.fwd[2];
        if (z < minDepthMeters) continue;
        const u = cam.cx + cam.fx * (qx * cam.right[0] + qy * cam.right[1] + qz * cam.right[2]) / z;
        const v = cam.cy - cam.fy * (qx * cam.up[0] + qy * cam.up[1] + qz * cam.up[2]) / z;
        if (u < 2 || v < 2 || u >= w - 2 || v >= h - 2) continue;
        const ix = u | 0, iy = v | 0, p = iy * w + ix;
        if (!photo.valid[p]) continue;
        const tol = Math.max(0.25, 0.01 * z);
        if (!(z <= depth[p] + tol || z <= depth[p - 1] + tol || z <= depth[p + 1] + tol || z <= depth[p - w] + tol || z <= depth[p + w] + tol)) continue;
        const bin = orientationBin(projectedOrientationDeg(cam, px, py, pz, set.dir[i * 3], set.dir[i * 3 + 1], set.dir[i * 3 + 2]));
        const cell = ((iy >> 1) * gw + (ix >> 1)) * ORIENTATION_BINS + bin;
        if (occupied[cell]) continue;
        occupied[cell] = 1;
        P.push(px, py, pz); D.push(set.dir[i * 3], set.dir[i * 3 + 1], set.dir[i * 3 + 2]); B.push(bin);
    }
    return { pos: P, dir: D, bin: B };
}

/**
 * Sparse photometric samples: the textured scan is rendered at half resolution from the frame camera,
 * blurred, and its strongest-gradient pixels (on usable photo pixels) are lifted to 3D with their
 * texture luminance. NCC against the blurred photo is invariant to the exposure / white-balance gap
 * between the aerial texture and Street View.
 */
function buildPhotometricSamples(textured: TexturedPrimitive[], cam: FrameCamera, photo: PhotoFeatures, maxSamples: number, minDepthMeters: number) {
    const s = 2;
    const W = Math.floor(cam.width / s), H = Math.floor(cam.height / s);
    const half: FrameCamera = { ...cam, width: W, height: H, fx: cam.fx / s, fy: cam.fy / s, cx: cam.cx / s, cy: cam.cy / s };
    const r = renderTexturedView(textured, half);
    const L = gaussianBlur(luminance(r.rgba, W, H), W, H, 1.0);
    const { mag } = sobel(L, W, H);
    const cand: number[] = [];
    const EMPTY = PLATE_EMPTY_DEPTH * 0.5;
    for (let y = 2; y < H - 2; y++) for (let x = 2; x < W - 2; x++) {
        const i = y * W + x;
        const d = r.depth[i];
        if (!(d < EMPTY) || d < minDepthMeters || mag[i] < 1.5) continue;
        // all 3x3 neighbours on the mesh (no samples straddling the silhouette) and usable in the photo
        let ok = true;
        for (let dy = -1; dy <= 1 && ok; dy++) for (let dx = -1; dx <= 1; dx++) if (!(r.depth[i + dy * W + dx] < EMPTY)) { ok = false; break; }
        if (!ok || !photo.valid[(y * s + 1) * cam.width + x * s + 1]) continue;
        cand.push(i);
    }
    cand.sort((a, b) => mag[b] - mag[a]);
    const keep = cand.slice(0, maxSamples);
    const pos = new Float32Array(keep.length * 3), val = new Float32Array(keep.length);
    keep.forEach((i, k) => {
        const x = i % W, y = (i / W) | 0, d = r.depth[i];
        const u = (x + 0.5 - half.cx) / half.fx, v = (y + 0.5 - half.cy) / half.fy;
        for (let c = 0; c < 3; c++) pos[k * 3 + c] = cam.eye[c] + d * (cam.fwd[c] + u * cam.right[c] - v * cam.up[c]);
        val[k] = L[i];
    });
    return { pos, val };
}

/** NCC between scan-texture luminance samples and the blurred photo at their projections (null when < 50 usable). */
function photometricNcc(P: Float32Array, val: Float32Array, n: number, stride: number, cam: FrameCamera, photo: PhotoFeatures): number | null {
    const { eye, fwd, right, up, fx, fy, cx, cy, width: w, height: h } = cam;
    let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, m = 0;
    const img = photo.lumBlur;
    for (let i = 0; i < n; i += stride) {
        const qx = P[i * 3] - eye[0], qy = P[i * 3 + 1] - eye[1], qz = P[i * 3 + 2] - eye[2];
        const z = qx * fwd[0] + qy * fwd[1] + qz * fwd[2];
        if (z <= 0.5) continue;
        const u = cx + fx * (qx * right[0] + qy * right[1] + qz * right[2]) / z - 0.5;
        const v = cy - fy * (qx * up[0] + qy * up[1] + qz * up[2]) / z - 0.5;
        if (u < 0 || v < 0 || u >= w - 1 || v >= h - 1) continue;
        const x0 = u | 0, y0 = v | 0, k = y0 * w + x0;
        if (!photo.valid[k]) continue;
        const ax = u - x0, ay = v - y0;
        const b = (img[k] * (1 - ax) + img[k + 1] * ax) * (1 - ay) + (img[k + w] * (1 - ax) + img[k + w + 1] * ax) * ay;
        const a = val[i];
        sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b; m++;
    }
    if (m < 50) return null;
    const va = saa - sa * sa / m, vb = sbb - sb * sb / m;
    if (va <= 1e-9 || vb <= 1e-9) return null;
    return (sab - sa * sb / m) / Math.sqrt(va * vb);
}

/** Sky-side test of silhouette samples: photo sky at >= minSkyHits of the probe distances beyond the mesh edge. */
export interface SkyBand { distancesPx: number[]; minSkyHits: number }
/** Strict sky-side band (used for final residuals and gates). */
export const STRICT_SKY_BAND: Readonly<SkyBand> = Object.freeze({ distancesPx: [3, 6, 10, 15, 20], minSkyHits: 3 });

/**
 * Mesh-against-sky silhouette samples of a frame, lifted to 3D: covered pixels with an empty 4-neighbour (every
 * other pixel), kept when the photo shows sky on the mesh's empty side (`band`) and the pixel is usable.
 */
export function skySilhouetteSamples(depth: Float32Array, cam: FrameCamera, photo: { valid: Uint8Array; sky: Uint8Array }, band: SkyBand = STRICT_SKY_BAND): Float32Array {
    const w = cam.width, h = cam.height;
    const EMPTY = PLATE_EMPTY_DEPTH * 0.5;
    const out: number[] = [];
    for (let y = 2; y < h - 2; y++) {
        for (let x = 2; x < w - 2; x++) {
            const i = y * w + x;
            const d = depth[i];
            if (d >= EMPTY || !photo.valid[i]) continue;
            let sx = 0, sy = 0, empty = 0;
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                if ((dx || dy) && depth[i + dy * w + dx] >= EMPTY) { sx += dx; sy += dy; empty++; }
            }
            if (!empty || !(depth[i - 1] >= EMPTY || depth[i + 1] >= EMPTY || depth[i - w] >= EMPTY || depth[i + w] >= EMPTY)) continue;
            if (((x + y) & 1) !== 0) continue; // thin the contour
            const l = Math.hypot(sx, sy);
            if (l < 1e-6) continue;
            const nx = sx / l, ny = sy / l;
            let hits = 0;
            for (const k of band.distancesPx) {
                const qx = Math.round(x + nx * k), qy = Math.round(y + ny * k);
                if (qx >= 0 && qy >= 0 && qx < w && qy < h && photo.sky[qy * w + qx]) hits++;
            }
            if (hits < band.minSkyHits) continue;
            const u = (x + 0.5 - cam.cx) / cam.fx, v = (y + 0.5 - cam.cy) / cam.fy;
            out.push(
                cam.eye[0] + d * (cam.fwd[0] + u * cam.right[0] - v * cam.up[0]),
                cam.eye[1] + d * (cam.fwd[1] + u * cam.right[1] - v * cam.up[1]),
                cam.eye[2] + d * (cam.fwd[2] + u * cam.right[2] - v * cam.up[2])
            );
        }
    }
    return Float32Array.from(out);
}

/** Bilinear lookup of a distance map at continuous pixel coordinates (exported sampleDT). */
export function sampleDistanceMap(dt: Float32Array, w: number, h: number, u: number, v: number, outside: number): number {
    return sampleDT(dt, w, h, u, v, outside);
}

function buildFrameMeshFeatures(
    mesh: RenderMesh3D, creases: CreaseSampleSet, cam: FrameCamera, photo: PhotoFeatures,
    skyBand: { distancesPx: number[]; minSkyHits: number }, minDepthMeters = 2, textureLines?: CreaseSampleSet,
    textured?: TexturedPrimitive[], maxPhotometricSamples = 6000
): FrameMeshFeatures {
    const w = cam.width, h = cam.height;
    const depth = renderFrameDepth(mesh, cam);
    const cr = visibleLineSamples(creases, cam, depth, photo, minDepthMeters);
    const cPos = cr.pos, cDir = cr.dir, cBin = cr.bin;
    const tx = visibleLineSamples(textureLines, cam, depth, photo, minDepthMeters);
    const EMPTY = PLATE_EMPTY_DEPTH * 0.5;
    const lift = (x: number, y: number, d: number, out: number[]) => {
        const u = (x + 0.5 - cam.cx) / cam.fx, v = (y + 0.5 - cam.cy) / cam.fy;
        out.push(
            cam.eye[0] + d * (cam.fwd[0] + u * cam.right[0] - v * cam.up[0]),
            cam.eye[1] + d * (cam.fwd[1] + u * cam.right[1] - v * cam.up[1]),
            cam.eye[2] + d * (cam.fwd[2] + u * cam.right[2] - v * cam.up[2])
        );
    };
    // Occluding contours: covered pixel with a covered 4-neighbour at least 15 % (and 1 m) farther
    const kPos: number[] = [], kBin: number[] = [];
    for (let y = 2; y < h - 2; y++) {
        for (let x = 2; x < w - 2; x++) {
            if (((x + y) & 1) !== 0) continue;
            const i = y * w + x;
            const d = depth[i];
            if (d >= EMPTY || d < minDepthMeters || !photo.valid[i]) continue;
            const far = d * 1.15 + 1;
            const isFar = (j: number) => depth[j] < EMPTY && depth[j] > far;
            if (!(isFar(i - 1) || isFar(i + 1) || isFar(i - w) || isFar(i + w))) continue;
            let sx = 0, sy = 0;
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && isFar(i + dy * w + dx)) { sx += dx; sy += dy; }
            if (Math.hypot(sx, sy) < 1e-6) continue;
            kBin.push(orientationBin(Math.atan2(sy, sx) / DEG + 90));
            lift(x, y, d, kPos);
        }
    }
    const sPos = skySilhouetteSamples(depth, cam, photo, skyBand);
    const ph = textured ? buildPhotometricSamples(textured, cam, photo, maxPhotometricSamples, Math.max(3, minDepthMeters)) : { pos: new Float32Array(0), val: new Float32Array(0) };
    return {
        pPos: ph.pos, pVal: ph.val, pCount: ph.val.length,
        cPos: Float32Array.from(cPos), cDir: Float32Array.from(cDir), cBin: Uint8Array.from(cBin), cCount: cBin.length,
        tPos: Float32Array.from(tx.pos), tBin: Uint8Array.from(tx.bin), tCount: tx.bin.length,
        kPos: Float32Array.from(kPos), kBin: Uint8Array.from(kBin), kCount: kBin.length,
        sPos, sCount: sPos.length / 3, depth
    };
}

// ============================================================================================
// E6 registration: cost, coarse grid, bounded Nelder-Mead, gates
// ============================================================================================

export interface RegistrationFrame {
    key: string;
    image: RgbaImage;
    /** Requested Street View heading (deg, clockwise from north). */
    headingDeg: number;
    /** Requested Street View pitch (deg, up positive). */
    pitchDeg: number;
    /** Requested Street View fov (deg, horizontal). */
    fovDeg: number;
    occluders?: OccluderBox[];
}

export interface PanoRegistrationInput {
    panoId: string;
    /** Nominal eye in the scan frame: ENU(pano lat/lng) with y = local ground + camera height. */
    nominalEye: [number, number, number];
    frames: RegistrationFrame[];
    /** Start correction (e.g. from the Gemini + PnP fallback). Bounds stay relative to the nominal eye. */
    initialCorrection?: PoseCorrection;
    /**
     * Polish only: `initialCorrection` is taken as the basin (e.g. a learned seed), so the coarse grid and the multi-start are
     * skipped and the start is refined by one bounded Nelder-Mead per truncation, at most `maxEvals` cost evaluations each.
     */
    polishOnly?: { maxEvals: number };
}

export interface RegistrationBounds { horizontalMeters: number; verticalMeters: number; yawDeg: number; pitchDeg: number; rollDeg: number }
export interface RegistrationPriors { horizontalSigmaMeters: number; verticalSigmaMeters: number; angleSigmaDeg: number }
export interface RegistrationGates {
    /** Max median sky-silhouette residual (px). null disables the gate. */
    silhouetteMedianPx: number | null;
    /** Max median residual of mesh line features (crease chains + occluding contours). null disables the gate. */
    creaseMedianPx: number | null;
    /** Min sky IoU when measurable. null disables the gate. */
    skyIoU: number | null;
    /** Min photometric NCC (textured scan vs photo) at the solution. null disables (default). */
    minPhotometricNcc: number | null;
    /** Min photometric peak (NCC at the solution minus best perturbed NCC). null disables (default). */
    minPhotometricPeak: number | null;
    /** Max disagreement of a frame refined alone with its pano solution. null disables. */
    frameAgreementMeters: number | null;
    frameAgreementDeg: number | null;
    /**
     * Max median cross-view residual (px): photo-to-photo shift of this frame against frames of other panos,
     * projected through the mesh at the final poses (StreetViewCrossViewRefiner). null disables. When on, a
     * frame with fewer than crossViewMinMatches such matches is unverified and rejected.
     */
    crossViewMedianPx: number | null;
    /** Max 75th-percentile cross-view residual (px). null disables. */
    crossViewP75Px: number | null;
    crossViewMinMatches: number;
    /** Minimum number of samples for a residual statistic to count. */
    minCreaseSamples: number;
    minSilhouetteSamples: number;
    /** Minimum fraction of the frame where the IoU is evaluated (sky union); below it IoU is n/a. */
    minSkyEvaluatedFraction: number;
}

export interface StreetViewRegistrationOptions {
    bounds?: Partial<RegistrationBounds>;
    priors?: Partial<RegistrationPriors>;
    gates?: Partial<RegistrationGates>;
    /** Weight of the prior chi-square in pixel^2 of mean residual. Default 0.5. */
    priorWeight?: number;
    /** Weight of a sky-silhouette sample (unambiguous edge). Default 4. */
    silhouetteWeight?: number;
    /** Weight of an occluding-contour sample. Default 2. */
    contourWeight?: number;
    /** Weight of a structural crease sample. Default 1. */
    creaseWeight?: number;
    /** Weight of a texture-line sample (used without classShares). Default 1. */
    textureWeight?: number;
    /**
     * Weight (px^2 per unit of 1 - NCC) of the photometric term between the textured scan and the
     * photo; it applies when the registrar is given the textured scene. Default 150.
     */
    photometricWeight?: number;
    /** Photometric samples per frame. Default 6000. */
    maxPhotometricSamples?: number;
    /**
     * When set, each feature class of a frame contributes this share of the frame's cost regardless of
     * its sample count (classes with no samples drop out and the rest renormalise). Overrides the
     * per-sample weights above. Default { silhouette: 0.4, contour: 0.15, crease: 0.15, texture: 0.3 }
     * (texture applies when texture lines are supplied); pass null for plain per-sample weighting.
     */
    classShares?: { silhouette: number; contour: number; crease: number; texture?: number } | null;
    truncationPx?: number;        // default 15
    coarseTruncationPx?: number;  // default 30
    coarseStepMeters?: number;    // default 0.5
    coarseYawStepDeg?: number;    // default 0.5
    /** Pitch offsets tried in the coarse grid. Default [-1, 0, 1]. */
    coarsePitchValuesDeg?: number[];
    coarseTopK?: number;          // default 5
    maxCoarseSamplesPerFrame?: number; // default 2500
    crease?: CreaseExtractionOptions;
    photo?: PhotoFeatureOptions;
    mask?: Omit<FrameMaskOptions, 'occluders'>;
    /** Pixel band (beyond the mesh silhouette) used to decide that the mesh's empty side is photo sky. */
    skyIoUBandPx?: number; // default 12
    log?: (msg: string) => void;
}

export interface FrameRegistrationReport {
    key: string;
    accepted: boolean;
    reasons: string[];
    headingDeg: number; pitchDeg: number; fovDeg: number;
    creaseSamples: number;
    silhouetteSamples: number;
    initial: { creaseMedianPx: number | null; silhouetteMedianPx: number | null; skyIoU: number | null; photometricNcc: number | null };
    final: { creaseMedianPx: number | null; silhouetteMedianPx: number | null; textureMedianPx: number | null; creaseInlierFraction: number | null; skyIoU: number | null; skyEvaluatedFraction: number; photometricNcc: number | null };
    /**
     * Photometric localisation: NCC at the solution minus the best NCC over perturbations of
     * +-0.5 m (x, z), +-0.3 m (y) and +-0.3 deg (yaw, pitch). Positive = the solution is a sharp NCC peak.
     */
    photometricPeak: number | null;
    textureSamples: number;
    /** This frame refined alone, starting from the pano solution (agreement check). */
    soloCorrection?: PoseCorrection;
    agreement?: { meters: number; deg: number };
    pose: CameraPose6DOF;
    camera: FrameCamera;
    photoSkyFraction: number;
    photoSegments: number;
}

export interface PanoRegistrationResult {
    panoId: string;
    nominalEye: [number, number, number];
    referenceHeadingDeg: number;
    correction: PoseCorrection;
    /** Horizontal move in metres and its bearing (deg clockwise from north). */
    moveMeters: number;
    moveBearingDeg: number;
    atBound: string[];
    cost: { initial: number; coarse: number; final: number };
    frames: FrameRegistrationReport[];
    accepted: boolean;
    /** 'search': coarse grid + refinement from the GPS pose; 'correspondence-seeded': local search from the Gemini + PnP pose. */
    method: 'search' | 'correspondence-seeded';
    /** Terms used by the objective (silhouette, crease, contour, texture-line, photometric). */
    objective: string[];
    timingsMs: Record<string, number>;
    /** Cost evaluations of the pose search (grid, Nelder-Mead, recheck) and of the gates' per-frame refinements. */
    evaluations: { search: number; gates: number };
}

const DEFAULT_BOUNDS: RegistrationBounds = { horizontalMeters: 4, verticalMeters: 0.7, yawDeg: 3, pitchDeg: 1.5, rollDeg: 1.5 };
const DEFAULT_PRIORS: RegistrationPriors = { horizontalSigmaMeters: 2, verticalSigmaMeters: 0.5, angleSigmaDeg: 1 };
const DEFAULT_GATES: RegistrationGates = {
    silhouetteMedianPx: 2, creaseMedianPx: 3, skyIoU: 0.96, minPhotometricNcc: null, minPhotometricPeak: null, frameAgreementMeters: 0.5, frameAgreementDeg: 0.3,
    crossViewMedianPx: null, crossViewP75Px: null, crossViewMinMatches: 15,
    minCreaseSamples: 60, minSilhouetteSamples: 30, minSkyEvaluatedFraction: 0.01
};

/** Default (plan E6) acceptance gates. */
export const PLAN_GATES: Readonly<RegistrationGates> = Object.freeze({ ...DEFAULT_GATES });

/**
 * Gates for projecting a frame onto a photogrammetric tile (used by the Street View texturing CLI).
 * Interior alignment is certified by cross-view photo consistency through the mesh (<= 2 px median, <= 3.5 px
 * p75, >= 15 matches with other panos) instead of the plan's mesh-line gate: tile creases are bevelled and
 * eroded, so their median residual sits at the 15 px truncation even at a correct pose, and the sky
 * silhouette alone is blind to translation. Silhouette and sky IoU stay as sanity checks of the absolute
 * pose (2.5 px, 0.9); per-frame "solo" agreement is replaced by the joint cross-view refinement.
 */
export const TEXTURING_GATES: Readonly<RegistrationGates> = Object.freeze({
    ...DEFAULT_GATES,
    silhouetteMedianPx: 2.5, creaseMedianPx: null, skyIoU: 0.9, frameAgreementMeters: null, frameAgreementDeg: null,
    crossViewMedianPx: 2, crossViewP75Px: 3.5, crossViewMinMatches: 15
});

/** Cross-view consistency of one frame (StreetViewCrossViewRefiner frame statistics). */
export interface CrossViewGateStats { matches: number; medianPx: number | null; p75Px: number | null; partnerPanos: number }

/** Statistics a gate decision needs (a FrameRegistrationReport, or the same fields read back from pose_report.json). */
export interface GateInput {
    final: { creaseMedianPx: number | null; silhouetteMedianPx: number | null; skyIoU: number | null; photometricNcc: number | null };
    photometricPeak: number | null;
    agreement?: { meters: number; deg: number } | null;
    crossView?: CrossViewGateStats | null;
}

/** Reasons a frame fails the gates (empty = accepted). Pure function of the registration statistics. */
export function evaluateFrameGates(r: GateInput, atBound: string[], g: RegistrationGates): string[] {
    const reasons: string[] = [];
    const f = r.final;
    if (g.silhouetteMedianPx !== null && f.silhouetteMedianPx !== null && f.silhouetteMedianPx > g.silhouetteMedianPx) reasons.push(`silhouette median ${f.silhouetteMedianPx.toFixed(2)} px > ${g.silhouetteMedianPx}`);
    if (g.creaseMedianPx !== null && f.creaseMedianPx !== null && f.creaseMedianPx > g.creaseMedianPx) reasons.push(`line (crease/contour) median ${f.creaseMedianPx.toFixed(2)} px > ${g.creaseMedianPx}`);
    // Some geometric evidence must have been measured and passed: a sky silhouette / sky IoU, the line gate when it is on,
    // or cross-view consistency when that gate is on
    const lineEvidence = g.creaseMedianPx !== null && f.creaseMedianPx !== null;
    const cv = r.crossView ?? null;
    const crossEvidence = g.crossViewMedianPx !== null && !!cv && cv.matches >= g.crossViewMinMatches;
    if (f.silhouetteMedianPx === null && f.skyIoU === null && !lineEvidence && !crossEvidence) reasons.push('no measurable geometric evidence (no sky silhouette / sky IoU in view, no line gate, no cross-view check)');
    if (g.crossViewMedianPx !== null) {
        if (!cv || cv.matches < g.crossViewMinMatches) {
            reasons.push(`cross-view: ${cv?.matches ?? 0} photo matches with other panos < ${g.crossViewMinMatches} (interior alignment unverified)`);
        } else {
            if (cv.medianPx !== null && cv.medianPx > g.crossViewMedianPx) reasons.push(`cross-view median ${cv.medianPx.toFixed(2)} px > ${g.crossViewMedianPx}`);
            if (g.crossViewP75Px !== null && cv.p75Px !== null && cv.p75Px > g.crossViewP75Px) reasons.push(`cross-view p75 ${cv.p75Px.toFixed(2)} px > ${g.crossViewP75Px}`);
        }
    }
    if (g.skyIoU !== null && f.skyIoU !== null && f.skyIoU < g.skyIoU) reasons.push(`sky IoU ${f.skyIoU.toFixed(3)} < ${g.skyIoU}`);
    if (g.minPhotometricNcc !== null && (f.photometricNcc === null || f.photometricNcc < g.minPhotometricNcc)) reasons.push(`photometric NCC ${f.photometricNcc === null ? 'n/a' : f.photometricNcc.toFixed(3)} < ${g.minPhotometricNcc}`);
    if (g.minPhotometricPeak !== null && (r.photometricPeak === null || r.photometricPeak < g.minPhotometricPeak)) reasons.push(`photometric peak ${r.photometricPeak === null ? 'n/a' : r.photometricPeak.toFixed(4)} < ${g.minPhotometricPeak}`);
    if (atBound.length) reasons.push(`solution at search bound (${atBound.join(', ')})`);
    if (r.agreement && ((g.frameAgreementMeters !== null && r.agreement.meters > g.frameAgreementMeters) || (g.frameAgreementDeg !== null && r.agreement.deg > g.frameAgreementDeg))) {
        reasons.push(`frame alone disagrees with pano solution (${r.agreement.meters.toFixed(2)} m, ${r.agreement.deg.toFixed(2)} deg)`);
    }
    return reasons;
}

interface PreparedFrame {
    frame: RegistrationFrame;
    photo: PhotoFeatures;
    feats: FrameMeshFeatures;
    /** strided subset used by the coarse grid */
    coarseCreaseStride: number;
    coarseContourStride: number;
    coarseSilStride: number;
    coarseTextureStride: number;
    /** per-sample weights of the feature classes */
    wCrease: number; wContour: number; wSil: number; wTexture: number;
}

function median(values: number[]): number | null {
    if (!values.length) return null;
    const a = values.slice().sort((x, y) => x - y);
    const m = a.length >> 1;
    return a.length % 2 ? a[m] : 0.5 * (a[m - 1] + a[m]);
}

/** Bounded Nelder-Mead (vertices are projected into the box). */
function nelderMead(
    f: (x: number[]) => number, x0: number[], step: number[], lo: number[], hi: number[],
    maxEvals = 500, tol = 1e-4
): { x: number[]; fx: number; evals: number } {
    const n = x0.length;
    const clamp = (x: number[]) => x.map((v, i) => Math.min(hi[i], Math.max(lo[i], v)));
    let simplex: number[][] = [clamp(x0)];
    for (let i = 0; i < n; i++) {
        const v = x0.slice(); v[i] += step[i];
        if (v[i] > hi[i]) v[i] = x0[i] - step[i];
        simplex.push(clamp(v));
    }
    let values = simplex.map(f);
    let evals = simplex.length;
    while (evals < maxEvals) {
        const order = values.map((v, i) => i).sort((a, b) => values[a] - values[b]);
        simplex = order.map(i => simplex[i]); values = order.map(i => values[i]);
        if (Math.abs(values[n] - values[0]) <= tol * (Math.abs(values[0]) + 1e-9)) break;
        const centroid = new Array(n).fill(0);
        for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) centroid[j] += simplex[i][j] / n;
        const along = (t: number) => clamp(centroid.map((c, j) => c + t * (simplex[n][j] - c)));
        const xr = along(-1); const fr = f(xr); evals++;
        if (fr < values[0]) {
            const xe = along(-2); const fe = f(xe); evals++;
            if (fe < fr) { simplex[n] = xe; values[n] = fe; } else { simplex[n] = xr; values[n] = fr; }
        } else if (fr < values[n - 1]) {
            simplex[n] = xr; values[n] = fr;
        } else {
            const outside = fr < values[n];
            const xc = along(outside ? -0.5 : 0.5); const fc = f(xc); evals++;
            if (fc < (outside ? fr : values[n])) { simplex[n] = xc; values[n] = fc; }
            else {
                for (let i = 1; i <= n; i++) {
                    simplex[i] = clamp(simplex[i].map((v, j) => simplex[0][j] + 0.5 * (v - simplex[0][j])));
                    values[i] = f(simplex[i]); evals++;
                }
            }
        }
    }
    let best = 0;
    for (let i = 1; i < values.length; i++) if (values[i] < values[best]) best = i;
    return { x: simplex[best], fx: values[best], evals };
}

export class StreetViewPoseRegistrar {
    readonly mesh: RenderMesh3D;
    readonly creases: CreaseSampleSet;
    readonly opts: StreetViewRegistrationOptions;
    readonly bounds: RegistrationBounds;
    readonly priors: RegistrationPriors;
    readonly gates: RegistrationGates;

    /** Optional lines from the scan's own texture (see extractTextureLineSamples). */
    readonly textureLines?: CreaseSampleSet;
    /** Optional textured scene (loadTexturedScene) enabling the photometric term. */
    readonly textured?: TexturedPrimitive[];

    constructor(mesh: RenderMesh3D, opts: StreetViewRegistrationOptions = {}, creases?: CreaseSampleSet, extras: { textureLines?: CreaseSampleSet; textured?: TexturedPrimitive[] } = {}) {
        this.mesh = mesh;
        this.textureLines = extras.textureLines;
        this.textured = extras.textured;
        this.opts = opts;
        this.bounds = { ...DEFAULT_BOUNDS, ...(opts.bounds ?? {}) };
        this.priors = { ...DEFAULT_PRIORS, ...(opts.priors ?? {}) };
        this.gates = { ...DEFAULT_GATES, ...(opts.gates ?? {}) };
        this.creases = creases ?? extractCreaseSamples(mesh, opts.crease);
    }

    private log(msg: string) { this.opts.log?.(msg); }

    private lowerBounds(): number[] {
        const b = this.bounds;
        return [-b.horizontalMeters, -b.verticalMeters, -b.horizontalMeters, -b.yawDeg, -b.pitchDeg, -b.rollDeg];
    }
    private upperBounds(): number[] { return this.lowerBounds().map(v => -v); }

    private priorChi2(x: ArrayLike<number>): number {
        const p = this.priors;
        return (x[0] * x[0] + x[2] * x[2]) / (p.horizontalSigmaMeters ** 2) + (x[1] * x[1]) / (p.verticalSigmaMeters ** 2)
            + (x[3] * x[3] + x[4] * x[4] + x[5] * x[5]) / (p.angleSigmaDeg ** 2);
    }

    /** Camera of a frame of this pano under a correction. */
    camera(input: PanoRegistrationInput, frame: RegistrationFrame, corr: PoseCorrection): FrameCamera {
        return frameCamera(input.nominalEye, frame.headingDeg, frame.pitchDeg, frame.fovDeg, frame.image.width, frame.image.height, corr, input.frames[0].headingDeg);
    }

    /** Mean truncated squared residual (pixels^2) of the prepared frames at a correction. */
    private dataCost(input: PanoRegistrationInput, frames: PreparedFrame[], x: ArrayLike<number>, trunc: number, coarse: boolean): number {
        const corr = arrayToCorrection(x);
        const T2 = trunc * trunc;
        let sum = 0, wsum = 0;
        for (const pf of frames) {
            const silW = pf.wSil, conW = pf.wContour, creaseW = pf.wCrease;
            const cam = this.camera(input, pf.frame, corr);
            const { eye, fwd, right, up, fx, fy, cx, cy, width: w, height: h } = cam;
            const f = pf.feats;
            const cs = coarse ? pf.coarseCreaseStride : 1;
            for (let i = 0; i < f.cCount; i += cs) {
                const qx = f.cPos[i * 3] - eye[0], qy = f.cPos[i * 3 + 1] - eye[1], qz = f.cPos[i * 3 + 2] - eye[2];
                const z = qx * fwd[0] + qy * fwd[1] + qz * fwd[2];
                let r2 = T2;
                if (z > 0.5) {
                    const u = cx + fx * (qx * right[0] + qy * right[1] + qz * right[2]) / z;
                    const v = cy - fy * (qx * up[0] + qy * up[1] + qz * up[2]) / z;
                    const r = sampleDT(pf.photo.lineDT[f.cBin[i]], w, h, u, v, trunc);
                    r2 = r < trunc ? r * r : T2;
                }
                sum += creaseW * r2; wsum += creaseW;
            }
            const ts = coarse ? pf.coarseTextureStride : 1;
            const texW = pf.wTexture;
            for (let i = 0; i < f.tCount; i += ts) {
                const qx = f.tPos[i * 3] - eye[0], qy = f.tPos[i * 3 + 1] - eye[1], qz = f.tPos[i * 3 + 2] - eye[2];
                const z = qx * fwd[0] + qy * fwd[1] + qz * fwd[2];
                let r2 = T2;
                if (z > 0.5) {
                    const u = cx + fx * (qx * right[0] + qy * right[1] + qz * right[2]) / z;
                    const v = cy - fy * (qx * up[0] + qy * up[1] + qz * up[2]) / z;
                    const r = sampleDT(pf.photo.lineDT[f.tBin[i]], w, h, u, v, trunc);
                    r2 = r < trunc ? r * r : T2;
                }
                sum += texW * r2; wsum += texW;
            }
            const ks = coarse ? pf.coarseContourStride : 1;
            for (let i = 0; i < f.kCount; i += ks) {
                const qx = f.kPos[i * 3] - eye[0], qy = f.kPos[i * 3 + 1] - eye[1], qz = f.kPos[i * 3 + 2] - eye[2];
                const z = qx * fwd[0] + qy * fwd[1] + qz * fwd[2];
                let r2 = T2;
                if (z > 0.5) {
                    const u = cx + fx * (qx * right[0] + qy * right[1] + qz * right[2]) / z;
                    const v = cy - fy * (qx * up[0] + qy * up[1] + qz * up[2]) / z;
                    const r = sampleDT(pf.photo.lineDT[f.kBin[i]], w, h, u, v, trunc);
                    r2 = r < trunc ? r * r : T2;
                }
                sum += conW * r2; wsum += conW;
            }
            const ss = coarse ? pf.coarseSilStride : 1;
            for (let i = 0; i < f.sCount; i += ss) {
                const qx = f.sPos[i * 3] - eye[0], qy = f.sPos[i * 3 + 1] - eye[1], qz = f.sPos[i * 3 + 2] - eye[2];
                const z = qx * fwd[0] + qy * fwd[1] + qz * fwd[2];
                let r2 = T2;
                if (z > 0.5) {
                    const u = cx + fx * (qx * right[0] + qy * right[1] + qz * right[2]) / z;
                    const v = cy - fy * (qx * up[0] + qy * up[1] + qz * up[2]) / z;
                    const r = sampleDT(pf.photo.skyDT, w, h, u, v, trunc);
                    r2 = r < trunc ? r * r : T2;
                }
                sum += silW * r2; wsum += silW;
            }
        }
        let cost = wsum > 0 ? sum / wsum : T2;
        const mu = this.opts.photometricWeight ?? 150;
        if (this.textured && mu > 0) {
            let acc = 0, nf = 0;
            for (const pf of frames) {
                if (!pf.feats.pCount) continue;
                const cam = this.camera(input, pf.frame, corr);
                const stride = coarse ? Math.max(1, Math.ceil(pf.feats.pCount / 1500)) : 1;
                const ncc = photometricNcc(pf.feats.pPos, pf.feats.pVal, pf.feats.pCount, stride, cam, pf.photo);
                acc += 1 - (ncc ?? 0); nf++;
            }
            if (nf) cost += mu * acc / nf;
        }
        return cost;
    }

    private photometricPeak(input: PanoRegistrationInput, pf: PreparedFrame, x: number[]): number | null {
        const n0 = this.frameNcc(input, pf, arrayToCorrection(x));
        if (n0 === null) return null;
        let best = -Infinity;
        for (const [i, d] of [[0, 0.5], [2, 0.5], [1, 0.3], [3, 0.3], [4, 0.3]] as Array<[number, number]>) {
            for (const sgn of [-1, 1]) {
                const y = x.slice(); y[i] += sgn * d;
                const n = this.frameNcc(input, pf, arrayToCorrection(y));
                if (n !== null && n > best) best = n;
            }
        }
        return best === -Infinity ? null : n0 - best;
    }

    /** Photometric NCC of one prepared frame at a correction (null without texture or samples). */
    private frameNcc(input: PanoRegistrationInput, pf: PreparedFrame, corr: PoseCorrection): number | null {
        if (!pf.feats.pCount) return null;
        return photometricNcc(pf.feats.pPos, pf.feats.pVal, pf.feats.pCount, 1, this.camera(input, pf.frame, corr), pf.photo);
    }

    /** Cost evaluations since the current registerPano started. */
    private evaluations = 0;

    private objective(input: PanoRegistrationInput, frames: PreparedFrame[], trunc: number, coarse: boolean, priorCentre?: number[]) {
        const pw = this.opts.priorWeight ?? 0.5;
        return (x: number[]) => {
            const px = priorCentre ? x : x;
            this.evaluations++;
            return this.dataCost(input, frames, x, trunc, coarse) + pw * this.priorChi2(px);
        };
    }

    private prepareFrames(input: PanoRegistrationInput, photos: PhotoFeatures[], corr: PoseCorrection, strictSky: boolean): PreparedFrame[] {
        const band = strictSky ? { distancesPx: [3, 6, 10, 15, 20], minSkyHits: 3 } : { distancesPx: [10, 20, 30, 45, 60], minSkyHits: 2 };
        const maxCoarse = this.opts.maxCoarseSamplesPerFrame ?? 2500;
        return input.frames.map((frame, i) => {
            const feats = buildFrameMeshFeatures(this.mesh, this.creases, this.camera(input, frame, corr), photos[i], band, 2, this.textureLines, this.textured, this.opts.maxPhotometricSamples ?? 6000);
            let wCrease = this.opts.creaseWeight ?? 1, wContour = this.opts.contourWeight ?? 2, wSil = this.opts.silhouetteWeight ?? 4, wTexture = this.opts.textureWeight ?? 1;
            const shares = this.opts.classShares === undefined ? { silhouette: 0.4, contour: 0.15, crease: 0.15, texture: 0.3 } : this.opts.classShares;
            if (shares) {
                const minS = this.gates.minSilhouetteSamples;
                const parts = [
                    feats.sCount >= minS ? shares.silhouette : 0,
                    feats.kCount >= 20 ? shares.contour : 0,
                    feats.cCount >= 20 ? shares.crease : 0,
                    feats.tCount >= 20 ? (shares.texture ?? 0) : 0
                ];
                const tot = parts[0] + parts[1] + parts[2] + parts[3] || 1;
                // scaled by 1000 so a frame's total weight is comparable to its sample count
                wSil = feats.sCount ? 1000 * parts[0] / tot / feats.sCount : 0;
                wContour = feats.kCount ? 1000 * parts[1] / tot / feats.kCount : 0;
                wCrease = feats.cCount ? 1000 * parts[2] / tot / feats.cCount : 0;
                wTexture = feats.tCount ? 1000 * parts[3] / tot / feats.tCount : 0;
            }
            return {
                frame, photo: photos[i], feats, wCrease, wContour, wSil, wTexture,
                coarseTextureStride: Math.max(1, Math.ceil(feats.tCount / maxCoarse)),
                coarseCreaseStride: Math.max(1, Math.ceil(feats.cCount / maxCoarse)),
                coarseContourStride: Math.max(1, Math.ceil(feats.kCount / (maxCoarse / 2))),
                coarseSilStride: Math.max(1, Math.ceil(feats.sCount / (maxCoarse / 3)))
            };
        });
    }

    /** Per-frame residual statistics at a correction (truncation `trunc`). */
    private frameResiduals(input: PanoRegistrationInput, pf: PreparedFrame, corr: PoseCorrection, trunc: number) {
        const cam = this.camera(input, pf.frame, corr);
        const crease: number[] = [], sil: number[] = [];
        const f = pf.feats;
        for (let i = 0; i < f.cCount; i++) {
            const p = projectToFrame(cam, f.cPos, i * 3);
            crease.push(p ? Math.min(trunc, sampleDT(pf.photo.lineDT[f.cBin[i]], cam.width, cam.height, p[0], p[1], trunc)) : trunc);
        }
        for (let i = 0; i < f.kCount; i++) {
            const p = projectToFrame(cam, f.kPos, i * 3);
            crease.push(p ? Math.min(trunc, sampleDT(pf.photo.lineDT[f.kBin[i]], cam.width, cam.height, p[0], p[1], trunc)) : trunc);
        }
        const texture: number[] = [];
        for (let i = 0; i < f.tCount; i++) {
            const p = projectToFrame(cam, f.tPos, i * 3);
            texture.push(p ? Math.min(trunc, sampleDT(pf.photo.lineDT[f.tBin[i]], cam.width, cam.height, p[0], p[1], trunc)) : trunc);
        }
        for (let i = 0; i < f.sCount; i++) {
            const p = projectToFrame(cam, f.sPos, i * 3);
            sil.push(p ? Math.min(trunc, sampleDT(pf.photo.skyDT, cam.width, cam.height, p[0], p[1], trunc)) : trunc);
        }
        return {
            creaseMedianPx: crease.length >= this.gates.minCreaseSamples ? median(crease) : null,
            silhouetteMedianPx: sil.length >= this.gates.minSilhouetteSamples ? median(sil) : null,
            creaseInlierFraction: crease.length ? crease.filter(r => r <= (this.gates.creaseMedianPx ?? 3)).length / crease.length : null,
            textureMedianPx: texture.length >= this.gates.minCreaseSamples ? median(texture) : null,
            creaseCount: crease.length, silCount: sil.length, textureCount: texture.length
        };
    }

    /**
     * Sky IoU between the mesh's empty region and the photo sky at a camera, over usable pixels.
     * Mesh-empty pixels that are not photo sky and lie more than `bandPx` from the mesh silhouette are
     * excluded: they show structure beyond the tile extent (or occluders), not misregistration.
     */
    skyIoU(depth: Float32Array, photo: PhotoFeatures, bandPx = this.opts.skyIoUBandPx ?? 12): { iou: number | null; evaluatedFraction: number } {
        const w = photo.width, h = photo.height;
        const EMPTY = PLATE_EMPTY_DEPTH * 0.5;
        const boundary = new Uint8Array(w * h);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const i = y * w + x, e = depth[i] >= EMPTY;
            if ((x + 1 < w && (depth[i + 1] >= EMPTY) !== e) || (y + 1 < h && (depth[i + w] >= EMPTY) !== e)) boundary[i] = 1;
        }
        const dist = distanceTransform(boundary, w, h, bandPx + 2);
        let inter = 0, uni = 0;
        for (let i = 0; i < w * h; i++) {
            if (!photo.valid[i]) continue;
            const m = depth[i] >= EMPTY, s = photo.sky[i] === 1;
            if (m && !s && dist[i] > bandPx) continue;
            if (m && s) inter++;
            if (m || s) uni++;
        }
        const evaluatedFraction = uni / (w * h);
        if (evaluatedFraction < this.gates.minSkyEvaluatedFraction) return { iou: null, evaluatedFraction };
        return { iou: inter / uni, evaluatedFraction };
    }

    /**
     * Mesh feature samples of one frame projected at a correction, with their truncated residuals
     * (pixels): kind 0 = crease, 1 = occluding contour, 2 = sky silhouette. Features are selected at
     * `featureCorrection` (defaults to `corr`) with the strict sky-side test.
     */
    featureResiduals(input: PanoRegistrationInput, photos: PhotoFeatures[], corr: PoseCorrection, frameIndex: number, featureCorrection?: PoseCorrection): Array<{ u: number; v: number; r: number; kind: 0 | 1 | 2 | 3 }> {
        const T = this.opts.truncationPx ?? 15;
        const pf = this.prepareFrames({ ...input, frames: [input.frames[frameIndex]] }, [photos[frameIndex]], featureCorrection ?? corr, true)[0];
        const cam = this.camera(input, input.frames[frameIndex], corr);
        const out: Array<{ u: number; v: number; r: number; kind: 0 | 1 | 2 | 3 }> = [];
        const f = pf.feats;
        const push = (P: Float32Array, i: number, dt: Float32Array, kind: 0 | 1 | 2 | 3) => {
            const p = projectToFrame(cam, P, i * 3);
            if (!p) return;
            out.push({ u: p[0], v: p[1], r: Math.min(T, sampleDT(dt, cam.width, cam.height, p[0], p[1], T)), kind });
        };
        for (let i = 0; i < f.cCount; i++) push(f.cPos, i, pf.photo.lineDT[f.cBin[i]], 0);
        for (let i = 0; i < f.kCount; i++) push(f.kPos, i, pf.photo.lineDT[f.kBin[i]], 1);
        for (let i = 0; i < f.sCount; i++) push(f.sPos, i, pf.photo.skyDT, 2);
        for (let i = 0; i < f.tCount; i++) push(f.tPos, i, pf.photo.lineDT[f.tBin[i]], 3);
        return out;
    }

    /** Data cost (mean truncated squared residual, px^2) of a pano at `corr`, features selected at `featureCorrection`. */
    evaluateDataCost(input: PanoRegistrationInput, photos: PhotoFeatures[], corr: PoseCorrection, featureCorrection?: PoseCorrection, truncPx?: number): number {
        const prepared = this.prepareFrames(input, photos, featureCorrection ?? corr, true);
        return this.dataCost(input, prepared, correctionToArray(corr), truncPx ?? this.opts.truncationPx ?? 15, false);
    }

    /** Builds photo features (mask + sky + lines + distance transforms) for every frame. */
    photoFeatures(frames: RegistrationFrame[]): PhotoFeatures[] {
        return frames.map(fr => {
            const valid = buildValidMask(fr.image.width, fr.image.height, { ...(this.opts.mask ?? {}), occluders: fr.occluders });
            return buildPhotoFeatures(fr.image, valid, { dtCap: Math.max(this.opts.coarseTruncationPx ?? 30, this.opts.truncationPx ?? 15) + 2, ...(this.opts.photo ?? {}) });
        });
    }

    registerPano(input: PanoRegistrationInput, photos?: PhotoFeatures[]): PanoRegistrationResult {
        const t0 = Date.now();
        this.evaluations = 0;
        const timings: Record<string, number> = {};
        const lap = (k: string, since: number) => { timings[k] = Date.now() - since; return Date.now(); };
        let t = Date.now();
        const feats = photos ?? this.photoFeatures(input.frames);
        t = lap('photoFeatures', t);
        const T = this.opts.truncationPx ?? 15, Tc = this.opts.coarseTruncationPx ?? 30;
        const lo = this.lowerBounds(), hi = this.upperBounds();
        const start = correctionToArray(input.initialCorrection ?? ZERO_CORRECTION).map((v, i) => Math.min(hi[i], Math.max(lo[i], v)));

        // Reference features at the start pose (lenient sky-side check)
        let prepared = this.prepareFrames(input, feats, arrayToCorrection(start), false);
        t = lap('meshFeaturesInitial', t);
        const initialStats = prepared.map(pf => ({ ...this.frameResiduals(input, pf, arrayToCorrection(start), T), iou: this.skyIoU(pf.feats.depth, pf.photo), ncc: this.frameNcc(input, pf, arrayToCorrection(start)) }));
        const initialCost = this.objective(input, prepared, T, false)(start);

        // Coarse grid over (dx, dz, dyaw) x pitch values, coarse truncation, strided samples
        const step = this.opts.coarseStepMeters ?? 0.5, ystep = this.opts.coarseYawStepDeg ?? 0.5;
        const pitches = this.opts.coarsePitchValuesDeg ?? [-1, 0, 1];
        // Full search box around the nominal pose, or a local box around a supplied start (fallback seed)
        const local = !!input.initialCorrection;
        const radiusH = local ? Math.min(1, this.bounds.horizontalMeters) : this.bounds.horizontalMeters;
        const radiusY = local ? Math.min(1, this.bounds.yawDeg) : this.bounds.yawDeg;
        const centre = local ? start : [0, start[1], 0, 0, start[4], start[5]];
        const nH = Math.round(radiusH / step), nY = Math.round(radiusY / ystep);
        const coarseObj = this.objective(input, prepared, Tc, true);
        const grid: { x: number[]; f: number; key: string }[] = [];
        const costAt = new Map<string, number>();
        const cl = (v: number, i: number) => Math.min(hi[i], Math.max(lo[i], v));
        for (const dp of input.polishOnly ? [] : local ? [0] : pitches) {
            for (let ix = -nH; ix <= nH; ix++) for (let iz = -nH; iz <= nH; iz++) for (let iy = -nY; iy <= nY; iy++) {
                const x = [cl(centre[0] + ix * step, 0), start[1], cl(centre[2] + iz * step, 2), cl(centre[3] + iy * ystep, 3), cl(start[4] + dp, 4), start[5]];
                const f = coarseObj(x);
                const key = `${ix},${iz},${iy},${dp}`;
                costAt.set(key, f);
                grid.push({ x, f, key });
            }
        }
        // Local minima of the grid (6-neighbourhood in ix/iz/iy, same pitch), best first
        const minima = grid.filter(g => {
            const [ix, iz, iy, dp] = g.key.split(',').map(Number);
            for (const [a, b, c] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
                const n = costAt.get(`${ix + a},${iz + b},${iy + c},${dp}`);
                if (n !== undefined && n < g.f) return false;
            }
            return true;
        }).sort((a, b) => a.f - b.f).slice(0, this.opts.coarseTopK ?? 5);
        t = lap('coarseGrid', t);
        const coarseBest = minima.length ? minima[0].f : input.polishOnly ? NaN : coarseObj(start);
        this.log(`[${input.panoId}] coarse: ${grid.length} poses, best ${coarseBest.toFixed(2)} at ${minima[0]?.x.map(v => v.toFixed(2)).join(',')}`);

        // Bounded Nelder-Mead from each minimum (coarse truncation, then fine truncation)
        const nmStep = [0.3, 0.15, 0.3, 0.2, 0.15, 0.15];
        let best = { x: start, fx: Infinity };
        const seeds = minima.length ? minima.map(m => m.x) : [start];
        if (!seeds.some(s => s.every((v, i) => v === start[i]))) seeds.push(start);
        const polish = input.polishOnly?.maxEvals;
        for (const s of seeds) {
            const a = nelderMead(this.objective(input, prepared, Tc, false), s, polish ? nmStep.map(v => v * 0.5) : nmStep, lo, hi, polish ?? 400);
            const b = nelderMead(this.objective(input, prepared, T, false), a.x, nmStep.map(v => v * 0.5), lo, hi, polish ?? 400);
            if (b.fx < best.fx) best = { x: b.x, fx: b.fx };
        }
        t = lap('nelderMead', t);

        // Visibility recheck at the refined pose with the strict sky-side test, then final refinement
        prepared = this.prepareFrames(input, feats, arrayToCorrection(best.x), true);
        const fin = nelderMead(this.objective(input, prepared, T, false), best.x, nmStep.map(v => v * 0.3), lo, hi, polish ?? 500);
        const searchEvaluations = this.evaluations;
        const x = fin.x;
        const corr = arrayToCorrection(x);
        t = lap('recheckRefine', t);

        // Final renders, gates
        const atBound: string[] = [];
        const names = ['dx', 'dy', 'dz', 'dyaw', 'dpitch', 'droll'];
        for (let i = 0; i < 6; i++) if (Math.abs(x[i]) >= hi[i] * 0.98) atBound.push(names[i]);
        const reports: FrameRegistrationReport[] = prepared.map((pf, i) => {
            const cam = this.camera(input, pf.frame, corr);
            const depth = renderFrameDepth(this.mesh, cam);
            const stats = this.frameResiduals(input, pf, corr, T);
            const iou = this.skyIoU(depth, pf.photo);
            const reasons: string[] = []; // filled by evaluateFrameGates below
            const ncc = this.frameNcc(input, pf, corr);
            const peak = this.photometricPeak(input, pf, x);
            return {
                key: pf.frame.key, accepted: reasons.length === 0, reasons,
                headingDeg: pf.frame.headingDeg, pitchDeg: pf.frame.pitchDeg, fovDeg: pf.frame.fovDeg,
                creaseSamples: stats.creaseCount, silhouetteSamples: stats.silCount, textureSamples: stats.textureCount,
                initial: { creaseMedianPx: initialStats[i].creaseMedianPx, silhouetteMedianPx: initialStats[i].silhouetteMedianPx, skyIoU: initialStats[i].iou.iou, photometricNcc: initialStats[i].ncc },
                final: { creaseMedianPx: stats.creaseMedianPx, silhouetteMedianPx: stats.silhouetteMedianPx, textureMedianPx: stats.textureMedianPx, creaseInlierFraction: stats.creaseInlierFraction, skyIoU: iou.iou, skyEvaluatedFraction: iou.evaluatedFraction, photometricNcc: ncc },
                photometricPeak: peak,
                pose: frameCameraToPose(cam), camera: cam,
                photoSkyFraction: pf.photo.skyFraction, photoSegments: pf.photo.segments.length
            };
        });
        // Agreement between frames of the same pano: each frame refined alone from the pano solution
        if (prepared.length >= 2) {
            prepared.forEach((pf, i) => {
                const solo = nelderMead(this.objective(input, [pf], T, false), x, nmStep.map(v => v * 0.3), lo, hi, 400).x;
                const dm = Math.hypot(solo[0] - x[0], solo[1] - x[1], solo[2] - x[2]);
                const dd = Math.max(Math.abs(solo[3] - x[3]), Math.abs(solo[4] - x[4]), Math.abs(solo[5] - x[5]));
                reports[i].soloCorrection = arrayToCorrection(solo);
                reports[i].agreement = { meters: dm, deg: dd };
            });
        }
        for (const r of reports) { r.reasons = evaluateFrameGates(r, atBound, this.gates); r.accepted = r.reasons.length === 0; }
        const gateEvaluations = this.evaluations - searchEvaluations;
        t = lap('gates', t);
        timings.total = Date.now() - t0;
        const move = Math.hypot(corr.dx, corr.dz);
        return {
            panoId: input.panoId, nominalEye: input.nominalEye, referenceHeadingDeg: input.frames[0].headingDeg,
            correction: corr, moveMeters: move, moveBearingDeg: ((Math.atan2(corr.dx, -corr.dz) / DEG) + 360) % 360,
            atBound, cost: { initial: initialCost, coarse: coarseBest, final: fin.fx },
            frames: reports, accepted: reports.some(r => r.accepted),
            method: input.initialCorrection ? 'correspondence-seeded' : 'search',
            objective: ['silhouette', 'crease', 'contour', ...(this.textureLines ? ['texture-line'] : []), ...(this.textured && (this.opts.photometricWeight ?? 150) > 0 ? ['photometric'] : [])],
            timingsMs: timings,
            evaluations: { search: searchEvaluations, gates: gateEvaluations }
        };
    }
}

// ============================================================================================
// Overlays (pose report)
// ============================================================================================

function depthEdges(depth: Float32Array, w: number, h: number): Uint8Array {
    const e = new Uint8Array(w * h);
    const EMPTY = PLATE_EMPTY_DEPTH * 0.5;
    for (let y = 0; y < h - 1; y++) for (let x = 0; x < w - 1; x++) {
        const i = y * w + x, a = depth[i];
        for (const j of [i + 1, i + w]) {
            const b = depth[j];
            const ea = a >= EMPTY, eb = b >= EMPTY;
            if (ea !== eb || (!ea && Math.abs(a - b) / Math.min(a, b) > 0.04)) { e[i] = 1; break; }
        }
    }
    return e;
}

/**
 * Photo with mesh depth/silhouette edges at the initial pose (magenta) and the registered pose
 * (green); masked pixels are dimmed and the photo sky boundary is drawn in yellow when supplied.
 */
export function renderRegistrationOverlay(img: RgbaImage, initialDepth: Float32Array | null, finalDepth: Float32Array | null, photo?: PhotoFeatures): Buffer {
    const { width: w, height: h } = img;
    const out = Buffer.from(img.rgba);
    if (photo) {
        for (let i = 0; i < w * h; i++) if (!photo.valid[i]) { out[i * 4] >>= 1; out[i * 4 + 1] >>= 1; out[i * 4 + 2] >>= 1; }
        for (let i = 0; i < w * h; i++) if (photo.skyDT[i] < 0.5) { out[i * 4] = 255; out[i * 4 + 1] = 220; out[i * 4 + 2] = 0; }
    }
    const paint = (depth: Float32Array, c: [number, number, number]) => {
        const e = depthEdges(depth, w, h);
        for (let i = 0; i < w * h; i++) if (e[i]) { out[i * 4] = c[0]; out[i * 4 + 1] = c[1]; out[i * 4 + 2] = c[2]; out[i * 4 + 3] = 255; }
    };
    if (initialDepth) paint(initialDepth, [255, 0, 255]);
    if (finalDepth) paint(finalDepth, [0, 255, 80]);
    return out;
}

// ============================================================================================
// Gemini helpers: occluder boxes (E5) and marker correspondences + PnP fallback (E6)
// ============================================================================================

/** Default multimodal model for occluder detection and correspondence picking. */
export const STREETVIEW_GEMINI_MODEL = 'gemini-3.8-flash';

/** Minimal surface of @google/genai's client used here (injectable for tests). */
export interface GeminiContentClient {
    models: { generateContent(request: any): Promise<{ text?: string }> };
}

/** Gemini client from GEMINI_API_KEY (or GOOGLE_GENAI_API_KEY), else Vertex credentials; null when unavailable. */
export async function createGeminiContentClient(): Promise<GeminiContentClient | null> {
    const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_GENAI_API_KEY || process.env.GOOGLE_AI_API_KEY;
    try {
        const { GoogleGenAI } = await import('@google/genai');
        if (key) return new GoogleGenAI({ apiKey: key }) as unknown as GeminiContentClient;
        const { GoogleMediaCredentialsService } = await import('../google-media-credentials-service');
        return (await new GoogleMediaCredentialsService().createVertexClient()) as unknown as GeminiContentClient;
    } catch {
        return null;
    }
}

function parseJsonLoose(text: string): any {
    const t = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    try { return JSON.parse(t); } catch { /* fall through */ }
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
    throw new Error('Gemini response is not JSON');
}

/**
 * Version of OCCLUDER_PROMPT. Cached detections carry it; a cache entry with another version is detected again.
 * v2 (plan E5): signage is masked too (wall-mounted and projecting signs, logos, awnings, banners, posters,
 * illuminated displays, merchandise in display windows), so transient advertising is never baked into facades.
 */
export const OCCLUDER_PROMPT_VERSION = 2;

const OCCLUDER_PROMPT = (w: number, h: number) =>
    `This is a ${w}x${h} street-level photograph. Return a bounding box for every object that must not be painted onto a 3D model ` +
    'of the buildings and street: (1) anything standing in FRONT of a building facade or the street surface: vehicles (cars, taxis, ' +
    'vans, trucks, buses), people and cyclists, poles (street lamps, traffic lights, sign posts), trees and foliage, scaffolding and ' +
    'sidewalk sheds, free-standing signs, flags and banners, construction barriers, bollards, kiosks and vendor carts; (2) transient ' +
    'SIGNAGE on facades: wall-mounted or projecting signs, shop names and logos, awnings with lettering, banners, posters and ' +
    'advertising, illuminated displays and screens, and merchandise displayed behind storefront glass. Do NOT box plain building ' +
    'facades, windows, carved or cast inscriptions that are part of the masonry, the sky or the road itself. Respond with JSON only: ' +
    '{"objects":[{"label":string,"category":string,"box_2d":[ymin,xmin,ymax,xmax]}]} with integer coordinates normalised to 0-1000.';

/** Occluder boxes (pixels) from Gemini; retries malformed responses, then throws. */
export async function detectOccludersWithGemini(client: GeminiContentClient, image: Buffer, width: number, height: number, model = STREETVIEW_GEMINI_MODEL, attempts = 3): Promise<OccluderBox[]> {
    const mimeType = image[0] === 0x89 ? 'image/png' : 'image/jpeg';
    let parsed: any;
    for (let a = 1; ; a++) {
        try {
            const res = await client.models.generateContent({
                model,
                contents: [{ role: 'user', parts: [{ inlineData: { mimeType, data: image.toString('base64') } }, { text: OCCLUDER_PROMPT(width, height) }] }],
                config: { responseMimeType: 'application/json', temperature: a === 1 ? 0 : 0.2 }
            });
            parsed = parseJsonLoose(res.text ?? '{}');
            break;
        } catch (e) {
            if (a >= attempts) throw e;
        }
    }
    const list: any[] = Array.isArray(parsed) ? parsed : (parsed.objects ?? []);
    const out: OccluderBox[] = [];
    for (const o of list) {
        const b = o.box_2d ?? o.box2d;
        if (!Array.isArray(b) || b.length !== 4 || b.some((v: any) => !Number.isFinite(Number(v)))) continue;
        const [y0, x0, y1, x1] = b.map(Number);
        out.push({ label: String(o.label ?? 'object'), category: o.category ? String(o.category) : undefined, x0: x0 / 1000 * width, y0: y0 / 1000 * height, x1: x1 / 1000 * width, y1: y1 / 1000 * height });
    }
    return out;
}

// 5x7 bitmap digits for marker labels
const DIGITS = ['01110100011001110101110011000101110', '00100011000010000100001000010001110', '01110100010000100010001000100011111', '11111000100010000010000011000101110', '00010001100101010010111110001000010', '11111100001111000001000011000101110', '00110010001000011110100011000101110', '11111000010001000100010000100001000', '01110100011000101110100011000101110', '01110100011000101111000010001001100'];

function drawDigits(rgba: Buffer, w: number, h: number, x: number, y: number, text: string, scale = 2) {
    const cw = 6 * scale;
    for (let yy = y - 2; yy < y + 7 * scale + 2; yy++) for (let xx = x - 2; xx < x + text.length * cw + 1; xx++) {
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const k = (yy * w + xx) * 4; rgba[k] = 255; rgba[k + 1] = 255; rgba[k + 2] = 255;
    }
    for (let c = 0; c < text.length; c++) {
        const g = DIGITS[Number(text[c])];
        if (!g) continue;
        for (let r = 0; r < 7; r++) for (let q = 0; q < 5; q++) {
            if (g[r * 5 + q] !== '1') continue;
            for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) {
                const xx = x + c * cw + q * scale + sx, yy = y + r * scale + sy;
                if (xx >= 0 && yy >= 0 && xx < w && yy < h) { const k = (yy * w + xx) * 4; rgba[k] = 200; rgba[k + 1] = 0; rgba[k + 2] = 0; }
            }
        }
    }
}

/** Harris corners of a luminance image; returns pixel positions sorted by response. */
function harrisCorners(L: Float32Array, w: number, h: number, sigma = 1.5, k = 0.05): Array<{ x: number; y: number; r: number }> {
    const { gx, gy } = sobel(L, w, h);
    const xx = new Float32Array(w * h), yy = new Float32Array(w * h), xy = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) { xx[i] = gx[i] * gx[i]; yy[i] = gy[i] * gy[i]; xy[i] = gx[i] * gy[i]; }
    const a = gaussianBlur(xx, w, h, sigma), b = gaussianBlur(yy, w, h, sigma), c = gaussianBlur(xy, w, h, sigma);
    const R = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) R[i] = a[i] * b[i] - c[i] * c[i] - k * (a[i] + b[i]) ** 2;
    const out: Array<{ x: number; y: number; r: number }> = [];
    for (let y = 8; y < h - 8; y++) for (let x = 8; x < w - 8; x++) {
        const i = y * w + x, v = R[i];
        if (v <= 0) continue;
        let isMax = true;
        for (let dy = -3; dy <= 3 && isMax; dy++) for (let dx = -3; dx <= 3; dx++) if ((dx || dy) && R[i + dy * w + dx] > v) { isMax = false; break; }
        if (isMax) out.push({ x, y, r: v });
    }
    return out.sort((p, q) => q.r - p.r);
}

export interface CorrespondenceFallbackResult {
    ok: boolean;
    reason?: string;
    correction?: PoseCorrection;
    markers: Array<{ id: number; world: [number, number, number]; render: [number, number]; photo: [number, number] | null }>;
    inliers: number;
    rmsPx: number | null;
    annotatedRender?: Buffer; // RGBA of the marker render (for the pose report)
}

/**
 * E6 fallback: numbered markers on 3D mesh corners (Harris corners of a clay render at the current
 * pose, lifted with the depth buffer) are shown to Gemini next to the photo; Gemini returns the
 * matching photo pixels. solvePnPRansac (fixed Street View intrinsics, 4 px threshold) must find at
 * least `minInliers` inliers with RMS <= `maxRmsPx`; the pose is then expressed as a pano correction.
 */
export async function correspondenceFallback(
    client: GeminiContentClient, registrar: StreetViewPoseRegistrar, input: PanoRegistrationInput, frameIndex: number, jpeg: Buffer,
    opts: { start?: PoseCorrection; maxMarkers?: number; minInliers?: number; maxRmsPx?: number; inlierThresholdPx?: number; model?: string } = {}
): Promise<CorrespondenceFallbackResult> {
    const frame = input.frames[frameIndex];
    const start = opts.start ?? ZERO_CORRECTION;
    const cam = registrar.camera(input, frame, start);
    const W = cam.width, H = cam.height;
    const shaded = HeadlessMeshSilhouetteRenderer.renderShadedMesh(registrar.mesh, frameCameraToPose(cam), W, H, {
        clipNearPlane: true, bgColor: [235, 240, 245, 255], clayColor: [215, 210, 200], lightDir: [cam.fwd[0] * -0.6 + 0.3, 0.7, cam.fwd[2] * -0.6 + 0.2]
    });
    // Corners are detected on the clay render (geometry); the image shown to Gemini uses the scan's own
    // texture when available, which is far easier to relate to the photo.
    const L = luminance(shaded.rgba, W, H);
    const corners = harrisCorners(L, W, H);
    const shown = registrar.textured ? renderTexturedView(registrar.textured, cam, [235, 240, 245]).rgba : shaded.rgba;
    const EMPTY = PLATE_EMPTY_DEPTH * 0.5;
    const picked: Array<{ x: number; y: number; d: number }> = [];
    const minSep = Math.max(40, W / 10);
    for (const c of corners) {
        if (picked.length >= (opts.maxMarkers ?? 14)) break;
        if (c.y > H - 40) continue;
        // depth at the corner: nearest surface in a 5x5 window (corners sit on depth edges)
        let d = Infinity;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) d = Math.min(d, shaded.depthBuffer[(c.y + dy) * W + c.x + dx]);
        if (!(d < EMPTY)) continue;
        if (picked.some(p => Math.hypot(p.x - c.x, p.y - c.y) < minSep)) continue;
        picked.push({ x: c.x, y: c.y, d });
    }
    const markers: CorrespondenceFallbackResult['markers'] = picked.map((p, i) => {
        const u = (p.x + 0.5 - cam.cx) / cam.fx, v = (p.y + 0.5 - cam.cy) / cam.fy;
        const world: [number, number, number] = [0, 1, 2].map(k => cam.eye[k] + p.d * (cam.fwd[k] + u * cam.right[k] - v * cam.up[k])) as [number, number, number];
        return { id: i + 1, world, render: [p.x + 0.5, p.y + 0.5], photo: null };
    });
    if (markers.length < 6) return { ok: false, reason: `only ${markers.length} corner markers in view`, markers, inliers: 0, rmsPx: null };
    const annotated = Buffer.from(shown);
    for (const m of markers) {
        const [x, y] = m.render;
        for (let a = 0; a < 360; a += 4) for (const r of [5, 6]) {
            const xx = Math.round(x + r * Math.cos(a * DEG)), yy = Math.round(y + r * Math.sin(a * DEG));
            if (xx >= 0 && yy >= 0 && xx < W && yy < H) { const k = (yy * W + xx) * 4; annotated[k] = 230; annotated[k + 1] = 0; annotated[k + 2] = 0; }
        }
        drawDigits(annotated, W, H, Math.round(x + 8), Math.round(y - 8), String(m.id));
    }
    const prompt =
        `Image 1 is a ${W}x${H} street-level photograph. Image 2 is a coarse photogrammetric 3D model of the same buildings rendered from ` +
        'roughly the same camera (the camera may be off by a few metres and a few degrees, so everything can be shifted, and the model is ' +
        'blurry and slightly lumpy). Red numbered circles in Image 2 mark building corners, roof-line corners, setbacks and edge junctions. ' +
        'For each number, find the SAME physical point of the building in Image 1 and give its pixel position (x to the right, y down, ' +
        `origin at the top-left, 0-${W - 1} and 0-${H - 1}). Give your best estimate whenever that part of the building is visible in Image 1; ` +
        'use null only when it is hidden behind something, outside the photo, or you cannot tell which point it is. ' +
        'Respond with JSON only: {"points":[{"id":number,"x":number|null,"y":number|null}]}';
    const res = await client.models.generateContent({
        model: opts.model ?? STREETVIEW_GEMINI_MODEL,
        contents: [{ role: 'user', parts: [
            { inlineData: { mimeType: 'image/jpeg', data: jpeg.toString('base64') } },
            { inlineData: { mimeType: 'image/png', data: encodePng(W, H, annotated).toString('base64') } },
            { text: prompt }
        ] }],
        config: { responseMimeType: 'application/json', temperature: 0 }
    });
    const parsed = parseJsonLoose(res.text ?? '{}');
    for (const p of (parsed.points ?? []) as any[]) {
        const m = markers.find(q => q.id === Number(p.id));
        if (m && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)) && p.x !== null && p.y !== null) m.photo = [Number(p.x) + 0.5, Number(p.y) + 0.5];
    }
    const pairs = markers.filter(m => m.photo);
    if (pairs.length < (opts.minInliers ?? 6)) return { ok: false, reason: `Gemini located ${pairs.length} markers`, markers, inliers: 0, rmsPx: null, annotatedRender: annotated };
    const intr = { fx: cam.fx, fy: cam.fy, cx: cam.cx, cy: cam.cy, width: W, height: H };
    const ransac = SpatialPoseEstimatorService.solvePnPRansac(pairs.map(m => m.world as Point3D), pairs.map(m => m.photo as Point2D), intr, { inlierThresholdPx: opts.inlierThresholdPx ?? 4, maxRansacIterations: 400 });
    const inl = ransac.inlierIndices.map(i => pairs[i]);
    // Express the PnP pose as a pano correction: fit the 6 parameters to the inlier correspondences
    const reproj = (x: number[]) => {
        const c = registrar.camera(input, frame, arrayToCorrection(x));
        let s = 0;
        for (const m of inl) { const p = projectToFrame(c, m.world); s += p ? (p[0] - m.photo![0]) ** 2 + (p[1] - m.photo![1]) ** 2 : 1e6; }
        return s / Math.max(1, inl.length);
    };
    const wide = [-50, -5, -50, -45, -30, -30], wideHi = wide.map(v => -v);
    let fit = nelderMead(reproj, correctionToArray(start), [0.5, 0.2, 0.5, 0.5, 0.3, 0.3], wide, wideHi, 1500, 1e-10);
    fit = nelderMead(reproj, fit.x, [0.1, 0.05, 0.1, 0.1, 0.05, 0.05], wide, wideHi, 1500, 1e-12);
    const rms = Math.sqrt(fit.fx);
    // The seed must be physically plausible: within 1.25x the registration search box
    const b = registrar.bounds, c = fit.x;
    const plausible = Math.abs(c[0]) <= 1.25 * b.horizontalMeters && Math.abs(c[2]) <= 1.25 * b.horizontalMeters && Math.abs(c[1]) <= 1.25 * b.verticalMeters
        && Math.abs(c[3]) <= 1.25 * b.yawDeg && Math.abs(c[4]) <= 1.25 * b.pitchDeg && Math.abs(c[5]) <= 1.25 * b.rollDeg;
    const ok = ransac.consensus && inl.length >= (opts.minInliers ?? 6) && rms <= (opts.maxRmsPx ?? 3) && plausible;
    return {
        ok, reason: ok ? undefined : `PnP: ${inl.length} inliers, RMS ${rms.toFixed(2)} px (need >= ${opts.minInliers ?? 6} and <= ${opts.maxRmsPx ?? 3})` +
            (plausible ? '' : `; pose outside 1.25x the search bounds (${c.map(v => v.toFixed(2)).join(', ')})`),
        correction: arrayToCorrection(fit.x), markers, inliers: inl.length, rmsPx: rms, annotatedRender: annotated
    };
}

// ============================================================================================
// E7: plate depth, plates.json contract and loader
// ============================================================================================

/** Plate depth for a registered frame: camera-z of the mesh, PLATE_EMPTY_DEPTH where empty or masked. */
export function renderPlateDepth(mesh: RenderMesh3D, cam: FrameCamera, valid: Uint8Array): Float32Array {
    const depth = HeadlessMeshSilhouetteRenderer.renderShadedMesh(mesh, frameCameraToPose(cam), cam.width, cam.height, { clipNearPlane: true }).depthBuffer;
    for (let i = 0; i < depth.length; i++) if (!valid[i]) depth[i] = PLATE_EMPTY_DEPTH;
    return depth;
}

/** NCC at or below which a registered frame has no photometric support (poseQuality 0). */
export const POSE_QUALITY_NCC_VETO = 0;

/**
 * Pose quality in [0, 1] on the texture-fusion confidence scale: StationPlate.poseQuality multiplies a texel's
 * confidence c in StreetViewTextureFusion, where c >= 0.5 counts as confident. q = 1 / (1 + r^2), with r the worst
 * ratio of a measured residual to its gate: silhouette median px, line median px (when the line gate is on),
 * (1 - sky IoU) / (1 - IoU gate), cross-view median px (when that gate is on). A perfect fit scores 1 and a frame
 * exactly at its worst gate 0.5.
 *
 * Honest by construction: a statistic that was measured is never dropped because its gate was switched off. Frame
 * agreement (frame alone vs pano solution) counts whenever it was measured, against the active gate or, when that
 * gate is off, the plan gate (0.5 m / 0.3 deg); a negative photometric peak (a perturbed pose fits the photo better
 * than the solution) counts as r = 1 + |peak| / 0.01.
 *
 * Interior alignment must be certified: when neither the line gate nor the cross-view gate is on, or the
 * cross-view gate is on but the frame has fewer than crossViewMinMatches matches, q = 0 (a sky silhouette pins
 * rotation only, so such a frame is never projected). Without the cross-view gate a non-positive photometric NCC
 * (textured scan vs blurred photo) also gives 0.
 */
export function poseQuality(report: GateInput, gates: RegistrationGates = DEFAULT_GATES): number {
    const f = report.final;
    const cv = report.crossView ?? null;
    const lineOn = gates.creaseMedianPx !== null;
    const crossOn = gates.crossViewMedianPx !== null;
    if (!lineOn && !crossOn) return 0;
    if (crossOn && (!cv || cv.matches < gates.crossViewMinMatches)) return 0;
    const ratios: number[] = [];
    if (f.silhouetteMedianPx !== null && gates.silhouetteMedianPx !== null) ratios.push(f.silhouetteMedianPx / gates.silhouetteMedianPx);
    if (lineOn && f.creaseMedianPx !== null) ratios.push(f.creaseMedianPx / gates.creaseMedianPx!);
    if (f.skyIoU !== null && gates.skyIoU !== null && gates.skyIoU < 1) ratios.push(Math.max(0, 1 - f.skyIoU) / (1 - gates.skyIoU));
    if (crossOn && cv && cv.medianPx !== null) ratios.push(cv.medianPx / gates.crossViewMedianPx!);
    if (report.agreement) {
        const m = gates.frameAgreementMeters ?? PLAN_GATES.frameAgreementMeters!, d = gates.frameAgreementDeg ?? PLAN_GATES.frameAgreementDeg!;
        ratios.push(Math.max(report.agreement.meters / m, report.agreement.deg / d));
    }
    if (report.photometricPeak !== null && report.photometricPeak < 0) ratios.push(1 + Math.abs(report.photometricPeak) / 0.01);
    if (lineOn && !crossOn && f.creaseMedianPx === null) return 0; // line gate on but nothing measured: unverified
    let q = ratios.length ? 1 / (1 + Math.max(...ratios) ** 2) : 0;
    // Without cross-view certification, an anti-correlated textured render vetoes the frame. With it the veto is not
    // used: against the blurry tile the NCC is ~0 or negative on steep upward views even at a verified pose.
    if (!crossOn && f.photometricNcc !== null && f.photometricNcc <= POSE_QUALITY_NCC_VETO) q = 0;
    return q;
}

/** ColmapCameraPose for a registered Street View frame (36 mm-equivalent optics, exact pinhole). */
export function stationForFrame(id: number, name: string, cam: FrameCamera, horizontalFovDeg: number, anchor: { lat: number; lng: number; heightMeters: number }, streetY?: number): ColmapCameraPose {
    const yaw = ((Math.atan2(cam.fwd[0], -cam.fwd[2]) / DEG) + 360) % 360;
    const pitch = Math.asin(Math.max(-1, Math.min(1, cam.fwd[1]))) / DEG;
    const levelRight = norm3(cross3(cam.fwd, [0, 1, 0]));
    const levelUp = cross3(levelRight, cam.fwd);
    const roll = Math.atan2(-dot3(cam.up, levelRight), dot3(cam.up, levelUp)) / DEG;
    const ltp = new LocalTangentPlane({ lat: anchor.lat, lng: anchor.lng, alt: anchor.heightMeters });
    const g = ltp.toLatLng(cam.eye);
    return {
        id, name, imageName: `${name}.jpg`,
        positionLocalENU: [cam.eye[0], cam.eye[1], cam.eye[2]],
        forwardVector: [cam.fwd[0], cam.fwd[1], cam.fwd[2]],
        upVector: [cam.up[0], cam.up[1], cam.up[2]],
        yawDegrees: yaw, pitchDegrees: pitch, rollDegrees: roll,
        focalLengthMm: 18 / Math.tan(horizontalFovDeg * DEG / 2), sensorWidthMm: 36, fovDegrees: horizontalFovDeg,
        aspectRatio: cam.width / cam.height,
        coordinatesWGS84: { lat: g.lat, lng: g.lng, elevation: g.alt ?? 0 },
        ...(streetY !== undefined ? { cameraHeightAboveGround: cam.eye[1] - streetY } : {})
    };
}

/** One accepted Street View plate (paths are relative to the plates.json directory). */
export interface StreetViewPlateRecord {
    id: string;
    panoId: string;
    date?: string;
    copyright?: string;
    imagePath: string;
    /** Float32 little-endian, width * height, camera-z metres; PLATE_EMPTY_DEPTH = do not project (empty or masked). */
    depthPath: string;
    /** RGBA PNG: white = usable pixel, black = masked (watermark strip, occluders). */
    maskPngPath: string;
    overlayPngPath?: string;
    width: number;
    height: number;
    request: { headingDeg: number; pitchDeg: number; fovDeg: number };
    /** Registered pose in the renderer / SurveyTextureUnprojector convention (vertical fov, `up` carries roll). */
    pose: CameraPose6DOF;
    intrinsics: PinholeIntrinsics;
    station: ColmapCameraPose;
    poseQuality: number;
    occluders: OccluderBox[];
    registration: {
        /** 'feature-pnp': StreetViewFeatureRegistrar (dense + local features + RANSAC-PnP + interior edges). */
        method: PanoRegistrationResult['method'] | 'feature-pnp';
        correction: PoseCorrection;
        moveMeters: number;
        creaseMedianPx: number | null;
        silhouetteMedianPx: number | null;
        skyIoU: number | null;
        agreement?: { meters: number; deg: number };
        /** Present when the pose comes from the joint cross-view refinement (StreetViewCrossViewRefiner). */
        crossView?: CrossViewGateStats & { medianMeters: number | null; supportedPixels: number };
        /**
         * Present for 'feature-pnp': the gated statistics (interior edge median px, orientation NCC at the final and the
         * GPS pose, PnP inliers, held-out edge median, best cross-view partner) and the gates they passed.
         */
        feature?: Record<string, unknown>;
    };
}

export interface StreetViewPlatesFile {
    version: 1;
    createdAt: string;
    glbPath: string;
    anchor: { lat: number; lng: number; heightMeters: number };
    frameConvention: 'x=East,y=Up,z=South(-North); heading clockwise from north';
    plates: StreetViewPlateRecord[];
    rejected: Array<{ id: string; panoId: string; reasons: string[] }>;
}

export type LoadedStreetViewPlate = StationPlate & { id: string; poseQuality: number; panoId: string; date?: string; maskPngPath: string; record: StreetViewPlateRecord };

/** Camera of a stored plate (renderer-convention pose with `up` carrying roll, plus the stored intrinsics). */
export function plateRecordCamera(rec: Pick<StreetViewPlateRecord, 'pose' | 'intrinsics' | 'width' | 'height'>): FrameCamera {
    const p = rec.pose;
    const f = norm3([p.targetX - p.x, p.targetY - p.y, p.targetZ - p.z]);
    const u0: V3 = p.up ? [p.up[0], p.up[1], p.up[2]] : [0, 1, 0];
    const r = norm3(cross3(f, u0));
    const u = cross3(r, f);
    const I = rec.intrinsics;
    return { eye: [p.x, p.y, p.z], fwd: f, right: r, up: u, fx: I.fx, fy: I.fy, cx: I.cx, cy: I.cy, width: rec.width, height: rec.height };
}

/** Usable-pixel mask of a stored plate (white = usable) as 0/1 bytes. */
export function readPlateMask(maskPngPath: string, width: number, height: number): Uint8Array {
    const m = decodePng(fs.readFileSync(maskPngPath));
    if (m.width !== width || m.height !== height) throw new Error(`${maskPngPath}: mask is ${m.width}x${m.height}, plate is ${width}x${height}`);
    const valid = new Uint8Array(width * height);
    for (let k = 0; k < valid.length; k++) valid[k] = m.rgba[k * 4] > 127 ? 1 : 0;
    return valid;
}

export interface LoadStreetViewPlatesOptions {
    /** Skip plates below this poseQuality. Default 0 (keep all; the fusion ignores poseQuality 0). */
    minPoseQuality?: number;
    /**
     * Re-render every plate's depth from this mesh at the registered pose, masked by the stored mask, instead
     * of reading the stored depth. Use it when the plates were registered on another mesh of the same frame
     * (e.g. registered on the raw tile, projected onto the rectified Stage 2 base): the depth test must see the
     * geometry that is being textured.
     */
    depthMesh?: RenderMesh3D;
}

/** Loads plates.json into SurveyTextureUnprojector StationPlates (photo RGBA decoded, depth read, masks applied). */
export function loadStreetViewPlates(platesJsonPath: string, opts: LoadStreetViewPlatesOptions = {}): LoadedStreetViewPlate[] {
    const dir = path.dirname(platesJsonPath);
    const file: StreetViewPlatesFile = JSON.parse(fs.readFileSync(platesJsonPath, 'utf8'));
    const out: LoadedStreetViewPlate[] = [];
    for (const rec of file.plates) {
        if (rec.poseQuality < (opts.minPoseQuality ?? 0)) continue;
        const img = decodeImageToRgba(fs.readFileSync(path.resolve(dir, rec.imagePath)));
        if (img.width !== rec.width || img.height !== rec.height) throw new Error(`${rec.id}: image is ${img.width}x${img.height}, plates.json says ${rec.width}x${rec.height}`);
        let depth: Float32Array;
        if (opts.depthMesh) {
            depth = renderPlateDepth(opts.depthMesh, plateRecordCamera(rec), readPlateMask(path.resolve(dir, rec.maskPngPath), rec.width, rec.height));
        } else {
            const raw = fs.readFileSync(path.resolve(dir, rec.depthPath));
            if (raw.length !== rec.width * rec.height * 4) throw new Error(`${rec.id}: depth file has ${raw.length} bytes, expected ${rec.width * rec.height * 4}`);
            depth = new Float32Array(rec.width * rec.height);
            for (let i = 0; i < depth.length; i++) depth[i] = raw.readFloatLE(i * 4);
        }
        out.push({
            id: rec.id, station: rec.station, rgba: img.rgba, width: img.width, height: img.height, depth, pose: rec.pose,
            intrinsics: rec.intrinsics, poseQuality: rec.poseQuality, panoId: rec.panoId, date: rec.date,
            maskPngPath: path.resolve(dir, rec.maskPngPath), record: rec
        });
    }
    return out;
}

/** Float32 little-endian buffer of a depth plate. */
export function encodeDepthF32(depth: Float32Array): Buffer {
    const b = Buffer.alloc(depth.length * 4);
    for (let i = 0; i < depth.length; i++) b.writeFloatLE(depth[i], i * 4);
    return b;
}

/** RGBA PNG of a validity mask (white usable, black masked). */
export function encodeMaskPng(valid: Uint8Array, width: number, height: number): Buffer {
    const rgba = Buffer.alloc(width * height * 4);
    for (let i = 0; i < width * height; i++) { const v = valid[i] ? 255 : 0; rgba[i * 4] = v; rgba[i * 4 + 1] = v; rgba[i * 4 + 2] = v; rgba[i * 4 + 3] = 255; }
    return encodePng(width, height, rgba);
}

// ============================================================================================
// Scan texture: GLB primitives with UVs and decoded base-colour images
// ============================================================================================

export interface GlbScenePrimitive {
    /** World-space positions (node transforms applied). */
    positions: Float32Array;
    indices: Uint32Array;
    /** TEXCOORD_0 (glTF convention: (0, 0) is the top-left of the image). */
    uvs: Float32Array | null;
    /** Encoded base-colour image bytes, when the material has one. */
    image: Buffer | null;
    imageSize: { width: number; height: number } | null;
    materialIndex: number | null;
}

function imageSizeFromBytes(buf: Buffer): { width: number; height: number } | null {
    if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    return readJpegSize(buf);
}

function mat4Mul(a: number[], b: number[]): number[] {
    const o = new Array(16).fill(0);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    return o;
}

function nodeMatrix(node: any): number[] {
    if (Array.isArray(node.matrix) && node.matrix.length === 16) return node.matrix.slice();
    const t = node.translation ?? [0, 0, 0], q = node.rotation ?? [0, 0, 0, 1], s = node.scale ?? [1, 1, 1];
    const [x, y, z, w] = q;
    return [
        (1 - 2 * (y * y + z * z)) * s[0], 2 * (x * y + z * w) * s[0], 2 * (x * z - y * w) * s[0], 0,
        2 * (x * y - z * w) * s[1], (1 - 2 * (x * x + z * z)) * s[1], 2 * (y * z + x * w) * s[1], 0,
        2 * (x * z + y * w) * s[2], 2 * (y * z - x * w) * s[2], (1 - 2 * (x * x + y * y)) * s[2], 0,
        t[0], t[1], t[2], 1
    ];
}

/**
 * Reads every triangle primitive of a binary glTF in world space (node transforms applied, same
 * traversal order as HeadlessMeshSilhouetteRenderer.loadMeshFromGlb: nodes in index order).
 * Supports byteStride, float / normalised-integer attributes and 8/16/32-bit indices.
 */
export function readGlbScene(glbPath: string): GlbScenePrimitive[] {
    const buf = fs.readFileSync(glbPath);
    if (buf.toString('utf8', 0, 4) !== 'glTF') throw new Error(`${glbPath}: not a binary glTF`);
    const jsonLen = buf.readUInt32LE(12);
    const gltf = JSON.parse(buf.toString('utf8', 20, 20 + jsonLen));
    const binOff = 20 + jsonLen + 8;
    const bin = buf.subarray(binOff, binOff + buf.readUInt32LE(20 + jsonLen));
    const COMP: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
    const NCOMP: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
    const readAccessor = (idx: number): Float64Array => {
        const acc = gltf.accessors[idx];
        const nc = NCOMP[acc.type], cs = COMP[acc.componentType];
        const out = new Float64Array(acc.count * nc);
        if (acc.bufferView === undefined) return out;
        const view = gltf.bufferViews[acc.bufferView];
        const stride = view.byteStride || nc * cs;
        const base = (view.byteOffset || 0) + (acc.byteOffset || 0);
        for (let i = 0; i < acc.count; i++) for (let c = 0; c < nc; c++) {
            const o = base + i * stride + c * cs;
            let v: number;
            switch (acc.componentType) {
                case 5126: v = bin.readFloatLE(o); break;
                case 5125: v = bin.readUInt32LE(o); break;
                case 5123: v = bin.readUInt16LE(o); if (acc.normalized) v /= 65535; break;
                case 5122: v = bin.readInt16LE(o); if (acc.normalized) v = Math.max(-1, v / 32767); break;
                case 5121: v = bin.readUInt8(o); if (acc.normalized) v /= 255; break;
                default: v = bin.readInt8(o); if (acc.normalized) v = Math.max(-1, v / 127); break;
            }
            out[i * nc + c] = v;
        }
        return out;
    };
    const imageOf = (materialIdx: number | undefined): Buffer | null => {
        if (materialIdx === undefined) return null;
        const tex = gltf.materials?.[materialIdx]?.pbrMetallicRoughness?.baseColorTexture;
        const img = tex ? gltf.images?.[gltf.textures?.[tex.index]?.source] : undefined;
        if (!img || img.bufferView === undefined) return null;
        const v = gltf.bufferViews[img.bufferView];
        return Buffer.from(bin.subarray(v.byteOffset || 0, (v.byteOffset || 0) + v.byteLength));
    };
    const nodes: any[] = gltf.nodes ?? [];
    const world: (number[] | null)[] = nodes.map(() => null);
    const visit = (i: number, parent: number[] | null) => {
        if (world[i]) return;
        const m = parent ? mat4Mul(parent, nodeMatrix(nodes[i])) : nodeMatrix(nodes[i]);
        world[i] = m;
        for (const c of nodes[i].children ?? []) visit(c, m);
    };
    for (const sc of gltf.scenes ?? []) for (const r of sc.nodes ?? []) visit(r, null);
    nodes.forEach((_, i) => visit(i, null));
    const instances: Array<{ mesh: any; m: number[] }> = [];
    nodes.forEach((n, i) => { if (n.mesh !== undefined && gltf.meshes?.[n.mesh]) instances.push({ mesh: gltf.meshes[n.mesh], m: world[i]! }); });
    if (!instances.length) for (const mesh of gltf.meshes ?? []) instances.push({ mesh, m: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] });
    const out: GlbScenePrimitive[] = [];
    for (const inst of instances) for (const prim of inst.mesh.primitives ?? []) {
        if ((prim.mode ?? 4) !== 4 || prim.attributes?.POSITION === undefined) continue;
        const P = readAccessor(prim.attributes.POSITION), m = inst.m;
        const n = P.length / 3;
        const positions = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
            const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
            positions[i * 3] = m[0] * x + m[4] * y + m[8] * z + m[12];
            positions[i * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
            positions[i * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
        }
        const indices = prim.indices !== undefined ? Uint32Array.from(readAccessor(prim.indices)) : Uint32Array.from({ length: n }, (_, i) => i);
        const uvs = prim.attributes.TEXCOORD_0 !== undefined ? Float32Array.from(readAccessor(prim.attributes.TEXCOORD_0)) : null;
        const image = imageOf(prim.material);
        out.push({ positions, indices, uvs, image, imageSize: image ? imageSizeFromBytes(image) : null, materialIndex: prim.material ?? null });
    }
    return out;
}

/** Concatenates primitives into one renderable mesh (same order as readGlbScene). */
export function sceneToRenderMesh(prims: GlbScenePrimitive[]): RenderMesh3D {
    let nv = 0, ni = 0;
    for (const p of prims) { nv += p.positions.length; ni += p.indices.length; }
    const vertices = new Float32Array(nv), indices = new Uint32Array(ni);
    let ov = 0, oi = 0;
    for (const p of prims) {
        vertices.set(p.positions, ov);
        const base = ov / 3;
        for (let i = 0; i < p.indices.length; i++) indices[oi + i] = p.indices[i] + base;
        ov += p.positions.length; oi += p.indices.length;
    }
    return { vertices, indices };
}

export interface TexturedPrimitive extends GlbScenePrimitive { rgba: RgbaImage | null }

/** readGlbScene plus decoded base-colour images (ffmpeg / sips). */
export function loadTexturedScene(glbPath: string): TexturedPrimitive[] {
    return readGlbScene(glbPath).map(p => ({ ...p, rgba: p.image ? decodeImageToRgba(p.image) : null }));
}

export interface TextureLineOptions {
    /** Minimum segment length in texels. Default 6. */
    minLengthTexels?: number;
    /** Gradient threshold in the texture (intensity / texel). Default 4. */
    magnitudeThreshold?: number;
    /** Both sides of a texture line (this many texels across it) must be covered by triangles (rejects chart borders). Default 2. */
    sideProbeTexels?: number;
}

/**
 * Straight lines in the scan's own base-colour textures (band courses, cornices, storefront heads,
 * window rows, colour boundaries), lifted to 3D through the UV parameterisation. They give the
 * registration near-field structure on facades that are flat in the geometry. Each segment found in
 * texture space is sampled once per texel; the 3D direction comes from the triangle's UV Jacobian.
 */
export function extractTextureLineSamples(prims: TexturedPrimitive[], opts: TextureLineOptions = {}): CreaseSampleSet {
    const minLen = opts.minLengthTexels ?? 6, probe = opts.sideProbeTexels ?? 2;
    const pos: number[] = [], dir: number[] = [];
    let segCount = 0, totalLength = 0;
    for (const p of prims) {
        if (!p.rgba || !p.uvs) continue;
        const W = p.rgba.width, H = p.rgba.height;
        // triangle id per texel (texel centres)
        const triId = new Int32Array(W * H).fill(-1);
        const nt = p.indices.length / 3;
        for (let t = 0; t < nt; t++) {
            const a = p.indices[t * 3], b = p.indices[t * 3 + 1], c = p.indices[t * 3 + 2];
            const ax = p.uvs[a * 2] * W, ay = p.uvs[a * 2 + 1] * H, bx = p.uvs[b * 2] * W, by = p.uvs[b * 2 + 1] * H, cx = p.uvs[c * 2] * W, cy = p.uvs[c * 2 + 1] * H;
            const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
            if (Math.abs(area) < 1e-9) continue;
            const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx)));
            const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by, cy)));
            for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
                const px = x + 0.5, py = y + 0.5;
                const w0 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) / area;
                const w1 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) / area;
                if (w0 >= -1e-6 && w1 >= -1e-6 && 1 - w0 - w1 >= -1e-6) triId[y * W + x] = t;
            }
        }
        const valid = new Uint8Array(W * H);
        for (let i = 0; i < W * H; i++) valid[i] = triId[i] >= 0 ? 1 : 0;
        const blurred = gaussianBlur(luminance(p.rgba.rgba, W, H), W, H, 1.0);
        const segs = detectLineSegments(blurred, W, H, valid, { minLength: minLen, magnitudeThreshold: opts.magnitudeThreshold ?? 4, maxWidth: 4 });
        for (const s of segs) {
            const len = Math.hypot(s.x1 - s.x0, s.y1 - s.y0);
            const ux = (s.x1 - s.x0) / len, uy = (s.y1 - s.y0) / len;
            let used = 0;
            for (let k = 0; k <= Math.floor(len); k++) {
                const x = s.x0 + ux * k, y = s.y0 + uy * k;
                const ix = Math.floor(x), iy = Math.floor(y);
                if (ix < 0 || iy < 0 || ix >= W || iy >= H) continue;
                const t = triId[iy * W + ix];
                if (t < 0) continue;
                let sides = true;
                for (const sgn of [-1, 1]) {
                    const qx = Math.floor(x - uy * probe * sgn), qy = Math.floor(y + ux * probe * sgn);
                    if (qx < 0 || qy < 0 || qx >= W || qy >= H || triId[qy * W + qx] < 0) { sides = false; break; }
                }
                if (!sides) continue;
                const a = p.indices[t * 3], b = p.indices[t * 3 + 1], c = p.indices[t * 3 + 2];
                const ax = p.uvs[a * 2] * W, ay = p.uvs[a * 2 + 1] * H, bx = p.uvs[b * 2] * W, by = p.uvs[b * 2 + 1] * H, cx = p.uvs[c * 2] * W, cy = p.uvs[c * 2 + 1] * H;
                // UV -> 3D affine map of the triangle
                const e1u = bx - ax, e1v = by - ay, e2u = cx - ax, e2v = cy - ay;
                const det = e1u * e2v - e2u * e1v;
                if (Math.abs(det) < 1e-9) continue;
                const P = p.positions;
                const A = [P[a * 3], P[a * 3 + 1], P[a * 3 + 2]], B = [P[b * 3], P[b * 3 + 1], P[b * 3 + 2]], C = [P[c * 3], P[c * 3 + 1], P[c * 3 + 2]];
                const toWorld = (du: number, dv: number) => {
                    const s1 = (du * e2v - dv * e2u) / det, s2 = (dv * e1u - du * e1v) / det;
                    return [0, 1, 2].map(i => s1 * (B[i] - A[i]) + s2 * (C[i] - A[i]));
                };
                const o = toWorld(x - ax, y - ay);
                const d = toWorld(ux, uy);
                const dl = Math.hypot(d[0], d[1], d[2]);
                if (dl < 1e-9) continue;
                pos.push(A[0] + o[0], A[1] + o[1], A[2] + o[2]);
                dir.push(d[0] / dl, d[1] / dl, d[2] / dl);
                used++;
            }
            if (used) { segCount++; totalLength += used; }
        }
    }
    return { count: pos.length / 3, pos: Float32Array.from(pos), dir: Float32Array.from(dir), edgeCount: segCount, chainCount: segCount, totalLengthMeters: totalLength };
}

/**
 * Software render of the textured scan from a frame camera (perspective-correct UVs, bilinear
 * texture lookup, near-plane clipping, depth test). Untextured primitives render grey. With
 * `withTexelSize`, also returns each pixel's texture texel edge on the surface (m; 0 where untextured).
 */
export function renderTexturedView(prims: TexturedPrimitive[], cam: FrameCamera, bg: [number, number, number] = [0, 0, 0], withTexelSize = false): { rgba: Buffer; depth: Float32Array; texelMeters?: Float32Array } {
    const W = cam.width, H = cam.height, near = 0.5;
    const rgba = Buffer.alloc(W * H * 4);
    const depth = new Float32Array(W * H).fill(PLATE_EMPTY_DEPTH);
    const texelMeters = withTexelSize ? new Float32Array(W * H) : undefined;
    for (let i = 0; i < W * H; i++) { rgba[i * 4] = bg[0]; rgba[i * 4 + 1] = bg[1]; rgba[i * 4 + 2] = bg[2]; rgba[i * 4 + 3] = 255; }
    const { eye, right, up, fwd, fx, fy, cx, cy } = cam;
    // scratch: up to 4 clipped vertices x (x, y, z, u, v); screen: (sx, sy, 1/z, u/z, v/z)
    const cv = new Float64Array(3 * 5), poly = new Float64Array(4 * 5), scr = new Float64Array(4 * 5);
    for (const p of prims) {
        const tex = p.rgba, T = tex?.rgba, TW = tex?.width ?? 1, TH = tex?.height ?? 1;
        const P = p.positions, UV = p.uvs;
        const nv = P.length / 3;
        const camP = new Float64Array(nv * 3);
        for (let v = 0; v < nv; v++) {
            const dx = P[v * 3] - eye[0], dy = P[v * 3 + 1] - eye[1], dz = P[v * 3 + 2] - eye[2];
            camP[v * 3] = dx * right[0] + dy * right[1] + dz * right[2];
            camP[v * 3 + 1] = dx * up[0] + dy * up[1] + dz * up[2];
            camP[v * 3 + 2] = dx * fwd[0] + dy * fwd[1] + dz * fwd[2];
        }
        const nt = p.indices.length / 3;
        for (let t = 0; t < nt; t++) {
            let tm = 0;
            if (texelMeters && UV && T) {
                const ia = p.indices[t * 3], ib = p.indices[t * 3 + 1], ic = p.indices[t * 3 + 2];
                const ex = P[ib * 3] - P[ia * 3], ey = P[ib * 3 + 1] - P[ia * 3 + 1], ez = P[ib * 3 + 2] - P[ia * 3 + 2];
                const gx = P[ic * 3] - P[ia * 3], gy = P[ic * 3 + 1] - P[ia * 3 + 1], gz = P[ic * 3 + 2] - P[ia * 3 + 2];
                const a3 = 0.5 * Math.hypot(ey * gz - ez * gy, ez * gx - ex * gz, ex * gy - ey * gx);
                const auv = 0.5 * Math.abs((UV[ib * 2] - UV[ia * 2]) * (UV[ic * 2 + 1] - UV[ia * 2 + 1]) - (UV[ib * 2 + 1] - UV[ia * 2 + 1]) * (UV[ic * 2] - UV[ia * 2]));
                tm = auv > 0 ? Math.sqrt(a3 / (auv * TW * TH)) : 0;
            }
            let behind = 0;
            for (let k = 0; k < 3; k++) {
                const v = p.indices[t * 3 + k];
                cv[k * 5] = camP[v * 3]; cv[k * 5 + 1] = camP[v * 3 + 1]; cv[k * 5 + 2] = camP[v * 3 + 2];
                cv[k * 5 + 3] = UV ? UV[v * 2] : 0; cv[k * 5 + 4] = UV ? UV[v * 2 + 1] : 0;
                if (cv[k * 5 + 2] < near) behind++;
            }
            if (behind === 3) continue;
            let n = 0;
            if (behind === 0) { poly.set(cv); n = 3; }
            else {
                for (let k = 0; k < 3; k++) {
                    const a = k * 5, b = ((k + 1) % 3) * 5;
                    const ain = cv[a + 2] >= near, bin = cv[b + 2] >= near;
                    if (ain) { for (let q = 0; q < 5; q++) poly[n * 5 + q] = cv[a + q]; n++; }
                    if (ain !== bin) {
                        const s2 = (near - cv[a + 2]) / (cv[b + 2] - cv[a + 2]);
                        for (let q = 0; q < 5; q++) poly[n * 5 + q] = cv[a + q] + (cv[b + q] - cv[a + q]) * s2;
                        n++;
                    }
                }
            }
            for (let k = 0; k < n; k++) {
                const iz = 1 / poly[k * 5 + 2];
                scr[k * 5] = cx + fx * poly[k * 5] * iz; scr[k * 5 + 1] = cy - fy * poly[k * 5 + 1] * iz;
                scr[k * 5 + 2] = iz; scr[k * 5 + 3] = poly[k * 5 + 3] * iz; scr[k * 5 + 4] = poly[k * 5 + 4] * iz;
            }
            for (let k = 1; k + 1 < n; k++) {
                const A = 0, B = k * 5, C = (k + 1) * 5;
                const ax = scr[A], ay = scr[A + 1], bx = scr[B], by = scr[B + 1], qx = scr[C], qy = scr[C + 1];
                const area = (bx - ax) * (qy - ay) - (by - ay) * (qx - ax);
                if (Math.abs(area) < 1e-12) continue;
                const inv = 1 / area;
                const x0 = Math.max(0, Math.floor(Math.min(ax, bx, qx))), x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx, qx)));
                const y0 = Math.max(0, Math.floor(Math.min(ay, by, qy))), y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by, qy)));
                for (let y = y0; y <= y1; y++) {
                    const py = y + 0.5;
                    for (let x = x0; x <= x1; x++) {
                        const px = x + 0.5;
                        const w0 = ((bx - px) * (qy - py) - (by - py) * (qx - px)) * inv;
                        if (w0 < 0) continue;
                        const w1 = ((qx - px) * (ay - py) - (qy - py) * (ax - px)) * inv;
                        if (w1 < 0) continue;
                        const w2 = 1 - w0 - w1;
                        if (w2 < 0) continue;
                        const iz = w0 * scr[A + 2] + w1 * scr[B + 2] + w2 * scr[C + 2];
                        const z = 1 / iz, i = y * W + x;
                        if (z >= depth[i]) continue;
                        depth[i] = z;
                        if (texelMeters) texelMeters[i] = tm;
                        if (!T) { rgba[i * 4] = 150; rgba[i * 4 + 1] = 150; rgba[i * 4 + 2] = 150; continue; }
                        let u = (w0 * scr[A + 3] + w1 * scr[B + 3] + w2 * scr[C + 3]) * z * TW - 0.5;
                        let v = (w0 * scr[A + 4] + w1 * scr[B + 4] + w2 * scr[C + 4]) * z * TH - 0.5;
                        u = u < 0 ? 0 : u > TW - 1 ? TW - 1 : u; v = v < 0 ? 0 : v > TH - 1 ? TH - 1 : v;
                        const ix = u | 0, iy = v | 0, ffx = u - ix, ffy = v - iy;
                        const ix1 = ix + 1 < TW ? ix + 1 : ix, iy1 = iy + 1 < TH ? iy + 1 : iy;
                        const tl = (iy * TW + ix) * 4, tr = (iy * TW + ix1) * 4, bl = (iy1 * TW + ix) * 4, br = (iy1 * TW + ix1) * 4;
                        for (let c = 0; c < 3; c++) rgba[i * 4 + c] = (T[tl + c] * (1 - ffx) + T[tr + c] * ffx) * (1 - ffy) + (T[bl + c] * (1 - ffx) + T[br + c] * ffx) * ffy;
                    }
                }
            }
        }
    }
    return texelMeters ? { rgba, depth, texelMeters } : { rgba, depth };
}
