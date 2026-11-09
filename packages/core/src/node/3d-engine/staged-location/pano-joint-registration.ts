/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Joint registration of all panos of a structure (in the manner of Zhou & Koltun 2014, "Color Map Optimization for 3D
 * Reconstruction with Consumer Depth Cameras"): every pano's 6-DOF pose is optimised together instead of one pano at a time.
 *
 * The per-pano registration (pano-edge-registration.ts) chooses each pano's pose, box or edge, by itself; neighbouring views
 * then come from two pose families and the texture shows it as offset blocks. Here, from the best of the two per pano (the edge
 * pose where it locked onto the scan, else the box pose), StreetViewCrossViewRefiner minimises, by robust Levenberg-Marquardt
 * over all poses at once and coarse to fine (two image scales):
 *   (a) per view, the distance of the full tile mesh's sky silhouette, occluding contours and creases to the photo's sky
 *       boundary and structural line segments (the absolute anchor on the scan's geometry);
 *   (b) cross-view photo consistency: patches of one photo carried through the scan into another must match there (block
 *       matching of band-passed luminance between every pair of views that see the same scan surface);
 *   (c) Gaussian priors about the start poses;
 *   (e) when the fitted faces are given, per view, the outline of the structure's own faces (the tile mesh within a slab of the
 *       fitted faces, so trees and statues in front of a face do not hide it) against the photo's strong colour-contrast edges:
 *       the anchor photo tier A used to place each pano's wide view on its own, now one term of this fit, so the texture's
 *       projection and its rectified tier read the photos through one set of poses.
 * Then (d) a non-rigid warp per pano, a coarse lattice (16 x 12) over the pano's view directions, strongly regularised, moves
 * each photo's content onto the consensus of the matches: what geometry error no rigid pose can explain.
 *
 * Nothing is accepted on the objective it minimised. The scan's surface is split into a checkerboard of 3D cells; the fit uses
 * only scan points in the even cells, and each candidate (the per-pano choice it started from, the joint poses, the joint poses
 * with the warps) is scored on the odd cells only, by the held-out fit: per view, the other panos' photos carried through the
 * scan into that view (leave one pano out) against the view's own photo, as a structural-edge chamfer and a gradient NCC
 * (texture-fit-metric.ts). A candidate replaces the current one only when it is better on that score. Generic: no number here
 * knows the place.
 */

import type { Vec3 } from '../../../common/spatial/staged-location-contracts';
import type { RenderMesh3D } from '../../spatial/HeadlessMeshSilhouetteRenderer';
import { HeadlessEdgeRenderPool } from '../../spatial/HeadlessEdgeRenderPool';
import { colourContrastEdges, faceOutlineSamples, meshEdgeSamples, StreetViewCrossViewRefiner, type CrossViewFrame, type CrossViewMatch, type CrossViewOptions, type CrossViewResult } from '../../spatial/StreetViewCrossViewRefiner';
import {
    buildValidMask, detectLineSegments, distanceTransform, frameCamera, gaussianBlur, groundingHorizontalFovDeg, luminance, projectToFrame, renderFrameDepth, segmentSky, sobel,
    ZERO_CORRECTION, type FrameCamera, type PoseCorrection, type RgbaImage
} from '../../spatial/StreetViewPoseRegistrar';
import { downscaleRgba, EDGE_REG_MIN_FOV_DEG, EDGE_RESIDUAL_FLOOR_M, type EdgeRegFrame } from './pano-edge-registration';
import type { Registration } from './pano-registration';
import type { SurfaceChart } from '../../../common/spatial/staged-location-contracts';
import { chamferMean, erode, FIT_CHAMFER_TRUNCATION_PX, maskedNcc, structuralEdges } from './texture-fit-metric';

/** Image widths of the two scales of the joint fit (coarse, fine). */
export const JOINT_WIDTHS_PX = [360, 640] as const;
/** Width at which the held-out fit is scored. */
export const JOINT_METRIC_WIDTH_PX = 480;
/** Side of the 3D checkerboard cells of the spatial hold-out (m). */
export const HOLDOUT_CELL_M = 1.5;
/** The evidence stage's allowance for the joint fit (the scoring is extra, a few seconds). */
export const JOINT_REGISTRATION_BUDGET_MS = 120_000;
/** Warp lattice (nodes across the pano's directions) and its cap (deg). */
export const WARP_GRID = [16, 12] as const;
export const WARP_MAX_DEG = 0.6;
/**
 * A candidate must be better by this chamfer (px) or this NCC, and no worse than the tolerance on the other. The NCC of the
 * carried-over photos is near its noise (0.08-0.12 live), so a chamfer gain tolerates a larger NCC loss than the reverse:
 * on a recorded live run the joint poses gained 0.65 px of chamfer for 0.014 of NCC, and the leave-one-pano-out texture fit on
 * close-ups the fit never saw preferred them (round 5, docs/processes/staged_location_texture_pass_live_arch.md).
 */
export const ACCEPT_CHAMFER_GAIN_PX = 0.15;
export const ACCEPT_NCC_GAIN = 0.01;
export const ACCEPT_NCC_LOSS_WITH_CHAMFER_GAIN = 0.02;

/** Tile mesh within this of a fitted face (m) is the structure's own surface (the face-outline term), and the margin past its extent. */
export const OUTLINE_SLAB_M = 1.5;
export const OUTLINE_MARGIN_M = 1;
/** Weight of a view's face-outline samples, in equivalent cross-view matches (like the sky and edge terms). */
export const OUTLINE_EQUIVALENT_MATCHES = 40;

const EMPTY = 1e8;
const DEG = Math.PI / 180;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
type V3 = [number, number, number];

/** True on the scan points the fit may use (even cells of the 3D checkerboard); the odd cells are held out for the score. */
export function trainCell(X: ArrayLike<number>, cellM = HOLDOUT_CELL_M): boolean {
    return ((Math.floor(X[0] / cellM) + Math.floor(X[1] / cellM) + Math.floor(X[2] / cellM)) & 1) === 0;
}

/**
 * The tile mesh near the fitted faces: triangles with a vertex within `slabM` of a face (a plane: inside its extent plus
 * `marginM`; a cylinder: within `slabM` of its radius over its height plus the margin). What stands in front of the faces
 * (trees, lamp posts, statues off the faces) and what stands behind them is left out, so the outline of this mesh is the
 * outline of the structure's own faces.
 */
export function faceSlabMesh(mesh: RenderMesh3D, charts: SurfaceChart[], slabM = OUTLINE_SLAB_M, marginM = OUTLINE_MARGIN_M): RenderMesh3D {
    const V = mesh.vertices, nv = V.length / 3;
    const near = new Uint8Array(nv);
    const tests = charts.map(c => {
        if ('plane' in c) {
            const { origin: o, u, v, normal: n, extentUv } = c.plane;
            let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
            for (const [a, b] of extentUv) { u0 = Math.min(u0, a); u1 = Math.max(u1, a); v0 = Math.min(v0, b); v1 = Math.max(v1, b); }
            const nl = Math.hypot(n[0], n[1], n[2]) || 1;
            return (x: number, y: number, z: number) => {
                const d0 = x - o[0], d1 = y - o[1], d2 = z - o[2];
                if (Math.abs((d0 * n[0] + d1 * n[1] + d2 * n[2]) / nl) > slabM) return false;
                const a = d0 * u[0] + d1 * u[1] + d2 * u[2], b = d0 * v[0] + d1 * v[1] + d2 * v[2];
                return a >= u0 - marginM && a <= u1 + marginM && b >= v0 - marginM && b <= v1 + marginM;
            };
        }
        const { axisOrigin: o, axisDir: ad, radiusM, zM } = c.cylinder;
        const al = Math.hypot(ad[0], ad[1], ad[2]) || 1, A = [ad[0] / al, ad[1] / al, ad[2] / al];
        return (x: number, y: number, z: number) => {
            const d0 = x - o[0], d1 = y - o[1], d2 = z - o[2];
            const t = d0 * A[0] + d1 * A[1] + d2 * A[2];
            if (t < Math.min(zM[0], zM[1]) - marginM || t > Math.max(zM[0], zM[1]) + marginM) return false;
            const r = Math.hypot(d0 - t * A[0], d1 - t * A[1], d2 - t * A[2]);
            return Math.abs(r - radiusM) <= slabM;
        };
    });
    for (let i = 0; i < nv; i++) { const x = V[i * 3], y = V[i * 3 + 1], z = V[i * 3 + 2]; for (const t of tests) if (t(x, y, z)) { near[i] = 1; break; } }
    const I = mesh.indices, keep: number[] = [];
    for (let t = 0; t < I.length; t += 3) if (near[I[t]] || near[I[t + 1]] || near[I[t + 2]]) keep.push(I[t], I[t + 1], I[t + 2]);
    return { vertices: V, indices: Uint32Array.from(keep) };
}

/**
 * A pano's non-rigid warp: angular displacement (heading, pitch, degrees) of where the photo shows the content a posed ray
 * points at, on a lattice over the pano's view directions (world heading relative to `refHeadingDeg`, pitch).
 */
export interface PanoWarp {
    panoId: string;
    refHeadingDeg: number;
    h0: number; h1: number; p0: number; p1: number;
    gw: number; gh: number;
    dh: Float32Array; dp: Float32Array;
    /** Matches the warp was fitted to, and the median |displacement| it applies at them (deg). */
    samples: number;
    medianDeg: number;
}

const wrap180 = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;
function dirAngles(cam: FrameCamera, x: number, y: number): [number, number] {
    const u = (x - cam.cx) / cam.fx, v = (y - cam.cy) / cam.fy;
    const d = [cam.fwd[0] + u * cam.right[0] - v * cam.up[0], cam.fwd[1] + u * cam.right[1] - v * cam.up[1], cam.fwd[2] + u * cam.right[2] - v * cam.up[2]];
    const l = Math.hypot(d[0], d[1], d[2]);
    return [Math.atan2(d[0], -d[2]) / DEG, Math.asin(Math.max(-1, Math.min(1, d[1] / l))) / DEG];
}
function anglesDir(hDeg: number, pDeg: number): V3 {
    const h = hDeg * DEG, p = pDeg * DEG;
    return [Math.sin(h) * Math.cos(p), Math.sin(p), -Math.cos(h) * Math.cos(p)];
}

/** The warp's displacement at a (relative heading, pitch), bilinear; 0 outside the lattice. */
function warpAt(w: PanoWarp, hRel: number, p: number): [number, number] {
    const fx = ((hRel - w.h0) / (w.h1 - w.h0)) * (w.gw - 1), fy = ((p - w.p0) / (w.p1 - w.p0)) * (w.gh - 1);
    if (!(fx >= 0 && fy >= 0 && fx <= w.gw - 1 && fy <= w.gh - 1)) return [0, 0];
    const x0 = Math.min(w.gw - 2, Math.floor(fx)), y0 = Math.min(w.gh - 2, Math.floor(fy)), ax = fx - x0, ay = fy - y0;
    const k = y0 * w.gw + x0;
    const bl = (a: Float32Array) => (a[k] * (1 - ax) + a[k + 1] * ax) * (1 - ay) + (a[k + w.gw] * (1 - ax) + a[k + w.gw + 1] * ax) * ay;
    return [bl(w.dh), bl(w.dp)];
}

/** Where a camera of the warped pano reads the content its pose puts at pixel (x, y). */
export function warpPixel(w: PanoWarp, cam: FrameCamera, x: number, y: number): [number, number] {
    const [h, p] = dirAngles(cam, x, y);
    const hRel = wrap180(h - w.refHeadingDeg);
    const [dh, dp] = warpAt(w, hRel, p);
    if (!dh && !dp) return [x, y];
    const d = anglesDir(h + dh, p + dp);
    const q = projectToFrame(cam, [cam.eye[0] + d[0] * 100, cam.eye[1] + d[1] * 100, cam.eye[2] + d[2] * 100]);
    return q ? [q[0], q[1]] : [x, y];
}

/** The warp as an image-space lattice of one view (pixel displacements at gw x gh nodes spanning the image), for the projection. */
export function warpLatticeForView(w: PanoWarp, cam: FrameCamera, gw = 17, gh = 13): { gw: number; gh: number; dx: Float32Array; dy: Float32Array } {
    const dx = new Float32Array(gw * gh), dy = new Float32Array(gw * gh);
    for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
        const x = (i / (gw - 1)) * cam.width, y = (j / (gh - 1)) * cam.height;
        const [qx, qy] = warpPixel(w, cam, x, y);
        dx[j * gw + i] = qx - x; dy[j * gw + i] = qy - y;
    }
    return { gw, gh, dx, dy };
}

interface Prepared {
    key: string; panoId: string; nominalEye: V3; headingDeg: number; pitchDeg: number; fovDeg: number; refHeadingDeg: number;
    image: RgbaImage; valid: Uint8Array; lum: Float32Array;
}

function prepare(f: EdgeRegFrame, width: number, refHeadingDeg: number): Prepared {
    const image = downscaleRgba(f.image, width);
    const valid = buildValidMask(image.width, image.height, { watermarkBottomPx: Math.ceil((24 * image.width) / Math.max(1, f.image.width)) + 2 });
    return {
        // the crop's true horizontal fov (the requested fov is that of the 1920 px grounding frame)
        key: f.key, panoId: f.view.panoId, nominalEye: [f.view.eye[0], f.view.eye[1], f.view.eye[2]], headingDeg: f.view.headingDeg, pitchDeg: f.view.pitchDeg, fovDeg: groundingHorizontalFovDeg(f.view.fovDeg, f.image.width, f.image.height),
        refHeadingDeg, image, valid, lum: luminance(image.rgba, image.width, image.height)
    };
}

function photoEdgesDT(p: Prepared): Float32Array {
    const w = p.image.width, h = p.image.height;
    const segs = detectLineSegments(gaussianBlur(p.lum, w, h, 1.5), w, h, p.valid, { minLength: Math.round(30 * w / 900), magnitudeThreshold: 5 });
    const map = new Uint8Array(w * h);
    for (const s of segs) {
        const len = Math.hypot(s.x1 - s.x0, s.y1 - s.y0), steps = Math.max(1, Math.ceil(len * 2));
        for (let i = 0; i <= steps; i++) { const t = i / steps, x = Math.floor(s.x0 + (s.x1 - s.x0) * t), y = Math.floor(s.y0 + (s.y1 - s.y0) * t); if (x >= 0 && y >= 0 && x < w && y < h) map[y * w + x] = 1; }
    }
    return distanceTransform(map, w, h, 16);
}

function outlineDT(p: Prepared): Float32Array {
    return distanceTransform(colourContrastEdges(p.image, p.valid), p.image.width, p.image.height, 16);
}

function crossViewFrame(p: Prepared, withOutline = false): CrossViewFrame {
    const w = p.image.width, h = p.image.height;
    const sky = segmentSky(p.image.rgba, w, h, p.valid);
    const boundary = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (!sky[i]) continue;
        if ((!sky[i - 1] && p.valid[i - 1]) || (!sky[i + 1] && p.valid[i + 1]) || (!sky[i - w] && p.valid[i - w]) || (!sky[i + w] && p.valid[i + w])) boundary[i] = 1;
    }
    return {
        key: p.key, panoId: p.panoId, nominalEye: p.nominalEye, headingDeg: p.headingDeg, pitchDeg: p.pitchDeg, fovDeg: p.fovDeg, referenceHeadingDeg: p.refHeadingDeg,
        image: p.image, valid: p.valid, sky: { mask: sky, dt: distanceTransform(boundary, w, h, 40) }, edges: { dt: photoEdgesDT(p) },
        ...(withOutline ? { outline: { dt: outlineDT(p) } } : {})
    };
}

const camOf = (p: Prepared, c: PoseCorrection): FrameCamera => frameCamera(p.nominalEye, p.headingDeg, p.pitchDeg, p.fovDeg, p.image.width, p.image.height, c, p.refHeadingDeg);

// ---------------------------------------------------------------------------------------------------------------------
// the held-out fit of a set of poses (and warps)
// ---------------------------------------------------------------------------------------------------------------------

export interface PoseFitView { key: string; panoId: string; pixels: number; chamferPx: number | null; clayChamferPx: number | null; gradNcc: number | null; outlinePx?: number | null; outlineSamples?: number }
export interface PoseFit {
    chamferPx: number | null; clayChamferPx: number | null; gradNcc: number | null;
    /** Held-out face-outline samples against the photo's colour-contrast edges (px, truncated; when the faces were given). */
    outlinePx?: number | null;
    views: PoseFitView[]; ms: number;
}

function bilinear(a: Float32Array, w: number, h: number, x: number, y: number): number {
    const fx = x - 0.5, fy = y - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    if (x0 < 0 || y0 < 0 || x0 >= w - 1 || y0 >= h - 1) return NaN;
    const ax = fx - x0, ay = fy - y0, i = y0 * w + x0;
    return (a[i] * (1 - ax) + a[i + 1] * ax) * (1 - ay) + (a[i + w] * (1 - ax) + a[i + w + 1] * ax) * ay;
}

/**
 * Per view: the other panos' photos carried through the scan into it (mean luminance of every other pano's view that sees the
 * same scan point), scored against the view's own photo on the held-out scan points (`score`), as texture-fit-metric scores a
 * texture: structural-edge chamfer both ways and gradient NCC; and the scan's own edges against the photo's (clay).
 */
export function heldOutPoseFit(frames: Prepared[], mesh: RenderMesh3D, corrs: Map<string, PoseCorrection>, warps: Map<string, PanoWarp> | undefined, score: (X: V3) => boolean,
    outline?: { mesh: RenderMesh3D; dts: Float32Array[] }): PoseFit {
    const t0 = Date.now();
    const cams = frames.map(f => camOf(f, corrs.get(f.panoId) ?? ZERO_CORRECTION));
    const depths = cams.map(c => renderFrameDepth(mesh, c));
    const views: PoseFitView[] = [];
    for (let v = 0; v < frames.length; v++) {
        const fv = frames[v], cam = cams[v], D = depths[v], W = cam.width, H = cam.height;
        const sum = new Float32Array(W * H), cnt = new Uint16Array(W * H), held = new Uint8Array(W * H), seen = new Uint8Array(W * H);
        const photo = new Float32Array(W * H);
        const wv = warps?.get(fv.panoId);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const i = y * W + x, d = D[i];
            if (!(d < EMPTY) || !fv.valid[i]) continue;
            seen[i] = 1;
            const [px, py] = wv ? warpPixel(wv, cam, x + 0.5, y + 0.5) : [x + 0.5, y + 0.5];
            const pl = bilinear(fv.lum, W, H, px, py);
            photo[i] = Number.isFinite(pl) ? pl : fv.lum[i];
            const u = (x + 0.5 - cam.cx) / cam.fx, vv = (y + 0.5 - cam.cy) / cam.fy;
            const X: V3 = [cam.eye[0] + d * (cam.fwd[0] + u * cam.right[0] - vv * cam.up[0]), cam.eye[1] + d * (cam.fwd[1] + u * cam.right[1] - vv * cam.up[1]), cam.eye[2] + d * (cam.fwd[2] + u * cam.right[2] - vv * cam.up[2])];
            if (score(X)) held[i] = 1;
            for (let o = 0; o < frames.length; o++) {
                if (frames[o].panoId === fv.panoId) continue;
                const co = cams[o];
                const qx = X[0] - co.eye[0], qy = X[1] - co.eye[1], qz = X[2] - co.eye[2];
                const zc = qx * co.fwd[0] + qy * co.fwd[1] + qz * co.fwd[2];
                if (zc <= 0.5) continue;
                const q0 = co.cx + (co.fx * (qx * co.right[0] + qy * co.right[1] + qz * co.right[2])) / zc;
                const q1 = co.cy - (co.fy * (qx * co.up[0] + qy * co.up[1] + qz * co.up[2])) / zc;
                const ix = Math.floor(q0), iy = Math.floor(q1);
                if (ix < 1 || iy < 1 || ix >= co.width - 1 || iy >= co.height - 1) continue;
                const k = iy * co.width + ix;
                if (!frames[o].valid[k] || !(Math.abs(depths[o][k] - zc) < 0.03 * zc + 0.2)) continue;
                const wo = warps?.get(frames[o].panoId);
                const [sx, sy] = wo ? warpPixel(wo, co, q0, q1) : [q0, q1];
                const lv = bilinear(frames[o].lum, co.width, co.height, sx, sy);
                if (!Number.isFinite(lv)) continue;
                sum[i] += lv; cnt[i]++;
            }
        }
        const others = new Uint8Array(W * H), R = new Float32Array(W * H);
        let n = 0;
        for (let i = 0; i < W * H; i++) if (cnt[i]) { others[i] = 1; R[i] = sum[i] / cnt[i]; if (held[i]) n++; }
        const base: PoseFitView = { key: fv.key, panoId: fv.panoId, pixels: n, chamferPx: null, clayChamferPx: null, gradNcc: null };
        if (outline) {
            // the structure's face outline on the held-out cells against the photo's colour-contrast edges
            let s = 0, c = 0;
            for (const X of faceOutlineSamples(renderFrameDepth(outline.mesh, cam), D, cam, fv.valid)) {
                if (!score(X)) continue;
                const q = projectToFrame(cam, X);
                if (!q) continue;
                const ix = Math.floor(q[0]), iy = Math.floor(q[1]);
                if (ix < 0 || iy < 0 || ix >= W || iy >= H) continue;
                s += Math.min(FIT_CHAMFER_TRUNCATION_PX, outline.dts[v][iy * W + ix]); c++;
            }
            base.outlineSamples = c;
            base.outlinePx = c >= 30 ? r3(s / c) : null;
        }
        if (n < 1500) { views.push(base); continue; }
        const region = new Uint8Array(W * H);
        const er = erode(others, W, H, 2);
        for (let i = 0; i < W * H; i++) if (er[i] && held[i]) region[i] = 1;
        const eR = structuralEdges(R, W, H, others), eP = structuralEdges(photo, W, H, seen);
        const dtP = distanceTransform(eP, W, H, FIT_CHAMFER_TRUNCATION_PX + 1), dtR = distanceTransform(eR, W, H, FIT_CHAMFER_TRUNCATION_PX + 1);
        const a = chamferMean(eR, dtP, region), b = chamferMean(eP, dtR, region);
        const gR = sobel(gaussianBlur(R, W, H, 1.5), W, H).mag, gP = sobel(gaussianBlur(photo, W, H, 1.5), W, H).mag;
        const g = maskedNcc(gR, gP, (() => { const m = erode(others, W, H, 4); for (let i = 0; i < m.length; i++) m[i] = m[i] && held[i] ? 1 : 0; return m; })());
        // clay: the scan's contours and creases (held-out points) against the photo's structural edges
        const geo = new Uint8Array(W * H);
        for (const X of meshEdgeSamples(D, cam, fv.valid)) {
            if (!score(X)) continue;
            const q = projectToFrame(cam, X);
            if (q) { const ix = Math.floor(q[0]), iy = Math.floor(q[1]); if (ix >= 0 && iy >= 0 && ix < W && iy < H) geo[iy * W + ix] = 1; }
        }
        const eP2 = structuralEdges(photo, W, H, fv.valid);
        const clay = chamferMean(geo, distanceTransform(eP2, W, H, FIT_CHAMFER_TRUNCATION_PX + 1));
        views.push({ ...base, chamferPx: a !== null && b !== null ? r3((a + b) / 2) : null, clayChamferPx: clay === null ? null : r3(clay), gradNcc: g === null ? null : r3(g) });
    }
    const wmean = (pick: (v: PoseFitView) => number | null): number | null => {
        let s = 0, n = 0;
        for (const v of views) { const x = pick(v); if (x === null) continue; s += x * v.pixels; n += v.pixels; }
        return n ? r3(s / n) : null;
    };
    let os = 0, on = 0;
    for (const v of views) if (v.outlinePx !== null && v.outlinePx !== undefined && v.outlineSamples) { os += v.outlinePx * v.outlineSamples; on += v.outlineSamples; }
    return { chamferPx: wmean(v => v.chamferPx), clayChamferPx: wmean(v => v.clayChamferPx), gradNcc: wmean(v => v.gradNcc), ...(outline ? { outlinePx: on ? r3(os / on) : null } : {}), views, ms: Date.now() - t0 };
}

/**
 * The held-out fit (heldOutPoseFit, held-out cells only) of the wide frames of `frames` under `corrs`, each pano's rotations
 * stated about its first wide frame's heading (as the edge registration states them).
 */
export function heldOutFitOfFrames(frames: EdgeRegFrame[], mesh: RenderMesh3D, corrs: Map<string, PoseCorrection>, widthPx: number = JOINT_METRIC_WIDTH_PX): PoseFit {
    const wide = frames.filter(f => f.view.fovDeg >= EDGE_REG_MIN_FOV_DEG);
    const ref = new Map<string, number>();
    for (const f of wide) if (!ref.has(f.view.panoId)) ref.set(f.view.panoId, f.view.headingDeg);
    const stated = new Map([...corrs].map(([id, c]) => [id, { ...c, referenceHeadingDeg: c.referenceHeadingDeg ?? ref.get(id) }]));
    return heldOutPoseFit(wide.map(f => prepare(f, widthPx, stated.get(f.view.panoId)?.referenceHeadingDeg ?? ref.get(f.view.panoId)!)), mesh, stated, undefined, X => !trainCell(X));
}

/** Whether held-out fit `c` is better than `b` (see ACCEPT_*): better on one measure, not worse past the tolerance on the other. */
export function fitIsBetter(c: PoseFit, b: PoseFit): boolean {
    if (c.chamferPx === null || c.gradNcc === null) return false;
    if (b.chamferPx === null || b.gradNcc === null) return true;
    const dC = b.chamferPx - c.chamferPx, dN = c.gradNcc - b.gradNcc;
    return (dC >= ACCEPT_CHAMFER_GAIN_PX && dN >= -ACCEPT_NCC_LOSS_WITH_CHAMFER_GAIN) || (dN >= ACCEPT_NCC_GAIN && dC >= -ACCEPT_CHAMFER_GAIN_PX);
}

// ---------------------------------------------------------------------------------------------------------------------
// (d) the per-pano warps
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Fits each pano's warp to the final matches: for a match, the consensus surface point is midway between where the two poses
 * put the content; each photo's warp moves its sampling of that point onto where it shows the content. Least squares on the
 * lattice with a strong membrane (Laplacian) term and a pull to zero, solved by Gauss-Seidel; capped at WARP_MAX_DEG.
 */
export function fitPanoWarps(frames: Prepared[], cams: FrameCamera[], matches: CrossViewMatch[], maxResidualPx = 8): Map<string, PanoWarp> {
    const samples = new Map<string, Array<{ h: number; p: number; dh: number; dp: number }>>();
    const push = (fi: number, from: [number, number], to: [number, number]) => {
        const cam = cams[fi], f = frames[fi];
        const [h0, p0] = dirAngles(cam, from[0], from[1]), [h1, p1] = dirAngles(cam, to[0], to[1]);
        const list = samples.get(f.panoId) ?? [];
        list.push({ h: wrap180(h0 - f.refHeadingDeg), p: p0, dh: wrap180(h1 - h0), dp: p1 - p0 });
        samples.set(f.panoId, list);
    };
    for (const m of matches) {
        if (Math.hypot(m.bx - m.qx, m.by - m.qy) > maxResidualPx) continue;
        const B = cams[m.b], A = cams[m.a];
        // where B's content b lies on the tangent plane at X, and the midpoint with X
        const u = (m.bx - B.cx) / B.fx, v = (m.by - B.cy) / B.fy;
        const d = [B.fwd[0] + u * B.right[0] - v * B.up[0], B.fwd[1] + u * B.right[1] - v * B.up[1], B.fwd[2] + u * B.right[2] - v * B.up[2]];
        const den = m.n[0] * d[0] + m.n[1] * d[1] + m.n[2] * d[2];
        if (Math.abs(den) < 1e-6) continue;
        const t = (m.n[0] * (m.X[0] - B.eye[0]) + m.n[1] * (m.X[1] - B.eye[1]) + m.n[2] * (m.X[2] - B.eye[2])) / den;
        const Xb: V3 = [B.eye[0] + t * d[0], B.eye[1] + t * d[1], B.eye[2] + t * d[2]];
        const Xm: V3 = [(m.X[0] + Xb[0]) / 2, (m.X[1] + Xb[1]) / 2, (m.X[2] + Xb[2]) / 2];
        const pa = projectToFrame(A, Xm), pb = projectToFrame(B, Xm);
        if (!pa || !pb) continue;
        push(m.a, [pa[0], pa[1]], [m.ax, m.ay]);
        push(m.b, [pb[0], pb[1]], [m.bx, m.by]);
    }
    const out = new Map<string, PanoWarp>();
    const [gw, gh] = WARP_GRID;
    for (const [panoId, list] of samples) {
        if (list.length < 30) continue;
        const fi = frames.findIndex(f => f.panoId === panoId);
        // the lattice spans the pano's frames' directions
        let h0 = Infinity, h1 = -Infinity, p0 = Infinity, p1 = -Infinity;
        frames.forEach((f, k) => {
            if (f.panoId !== panoId) return;
            for (const [x, y] of [[0, 0], [cams[k].width, 0], [0, cams[k].height], [cams[k].width, cams[k].height], [cams[k].width / 2, 0], [cams[k].width / 2, cams[k].height]]) {
                const [h, p] = dirAngles(cams[k], x, y);
                const hr = wrap180(h - f.refHeadingDeg);
                h0 = Math.min(h0, hr); h1 = Math.max(h1, hr); p0 = Math.min(p0, p); p1 = Math.max(p1, p);
            }
        });
        if (!(h1 > h0 && p1 > p0)) continue;
        const nodes = gw * gh;
        const A = new Float64Array(nodes), bh = new Float64Array(nodes), bp = new Float64Array(nodes);
        const wts: Array<{ k: number[]; w: number[]; dh: number; dp: number }> = [];
        for (const s of list) {
            const fx = ((s.h - h0) / (h1 - h0)) * (gw - 1), fy = ((s.p - p0) / (p1 - p0)) * (gh - 1);
            if (!(fx >= 0 && fy >= 0 && fx <= gw - 1 && fy <= gh - 1)) continue;
            const x0 = Math.min(gw - 2, Math.floor(fx)), y0 = Math.min(gh - 2, Math.floor(fy)), ax = fx - x0, ay = fy - y0;
            const k = [y0 * gw + x0, y0 * gw + x0 + 1, (y0 + 1) * gw + x0, (y0 + 1) * gw + x0 + 1];
            const w = [(1 - ax) * (1 - ay), ax * (1 - ay), (1 - ax) * ay, ax * ay];
            wts.push({ k, w, dh: s.dh, dp: s.dp });
        }
        if (wts.length < 30) continue;
        // strong regularisation: a membrane weighted like the data at every node, and a pull to zero
        const lamS = 4 * (wts.length / nodes), lam0 = 0.25 * (wts.length / nodes);
        const dh = new Float64Array(nodes), dp = new Float64Array(nodes);
        for (const s of wts) for (let q = 0; q < 4; q++) { A[s.k[q]] += s.w[q] * s.w[q]; bh[s.k[q]] += s.w[q] * s.dh; bp[s.k[q]] += s.w[q] * s.dp; }
        // Gauss-Seidel on (J^T J + lamS L + lam0 I) g = J^T r, with the data's cross terms handled by re-evaluating residuals
        for (let it = 0; it < 120; it++) {
            const rh = new Float64Array(nodes), rp = new Float64Array(nodes);
            for (const s of wts) {
                let ph = 0, pp = 0;
                for (let q = 0; q < 4; q++) { ph += s.w[q] * dh[s.k[q]]; pp += s.w[q] * dp[s.k[q]]; }
                for (let q = 0; q < 4; q++) { rh[s.k[q]] += s.w[q] * (s.dh - ph); rp[s.k[q]] += s.w[q] * (s.dp - pp); }
            }
            for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
                const k = j * gw + i;
                const nb = [i > 0 ? k - 1 : -1, i < gw - 1 ? k + 1 : -1, j > 0 ? k - gw : -1, j < gh - 1 ? k + gw : -1].filter(x => x >= 0);
                let sh = 0, sp = 0;
                for (const q of nb) { sh += dh[q]; sp += dp[q]; }
                const diag = A[k] + lamS * nb.length + lam0;
                // Jacobi-style update of node k: data residual (with its own current contribution added back) + membrane
                dh[k] = (rh[k] + A[k] * dh[k] + lamS * sh) / diag;
                dp[k] = (rp[k] + A[k] * dp[k] + lamS * sp) / diag;
            }
        }
        const cap = (v: number) => Math.max(-WARP_MAX_DEG, Math.min(WARP_MAX_DEG, v));
        const DH = Float32Array.from(dh, cap), DP = Float32Array.from(dp, cap);
        const warp: PanoWarp = { panoId, refHeadingDeg: frames[fi].refHeadingDeg, h0, h1, p0, p1, gw, gh, dh: DH, dp: DP, samples: wts.length, medianDeg: 0 };
        const mags = list.map(s => Math.hypot(...warpAt(warp, s.h, s.p))).sort((a, b) => a - b);
        warp.medianDeg = r3(mags[mags.length >> 1] ?? 0);
        out.set(panoId, warp);
    }
    return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// the joint registration
// ---------------------------------------------------------------------------------------------------------------------

export interface JointRegistrationInput {
    frames: EdgeRegFrame[];
    /** The full photogrammetric tile mesh (tile frame). */
    mesh: RenderMesh3D;
    /** The registration in force (the per-pano choice): its corrections are the baseline the joint result must beat. */
    current: Registration;
    /** Per pano, the box pose and the edge pose with whether the edge search locked onto the scan; the start is the better of the two. */
    candidates: Map<string, { box: PoseCorrection; edge?: PoseCorrection; edgeLocked: boolean }>;
    budgetMs?: number;
    /** Overrides of the refiner's settings (both scales). */
    refiner?: Partial<CrossViewOptions>;
    /** Worker threads the refiner's pair matching runs on (default: one per core but one, at most 8; 1: this thread). The matches are the same either way. */
    threads?: number;
    /**
     * The fitted faces of the structure. With them the fit also holds each view's face outline (term (e)); without them, or with
     * SCRATCHBOX_JOINT_OUTLINE=0, it does not.
     */
    faces?: Array<{ chart: SurfaceChart }>;
    log?: (m: string) => void;
    /** The clock the budget is read from (default Date.now; a test ends the budget at a chosen point with it). */
    now?: () => number;
}

export interface JointPanoOutcome {
    panoId: string;
    start: 'edges' | 'boxes';
    correction: PoseCorrection;
    /** Move from the start (m, deg). */
    movedM: number; turnedDeg: number;
    matches: number;
    medianPx: number | null;
    medianM: number | null;
    warpMedianDeg?: number;
}

export interface JointRegistrationResult {
    /** The registration to use: the current one, or the joint poses (with the warps) when the held-out fit says so. */
    registration: Registration;
    chosen: 'current' | 'joint' | 'joint+warp';
    reason: string;
    fit: { current: PoseFit; start: PoseFit; joint: PoseFit | null; warped: PoseFit | null };
    panos: JointPanoOutcome[];
    matches: { before: number; after: number; medianPxBefore: number | null; medianPxAfter: number | null };
    warps: PanoWarp[];
    /** Whether the face-outline term (e) took part, and the structure mesh's triangles. */
    outlineTerm: { used: boolean; triangles: number };
    timingsMs: Record<string, number>;
}

const median = (v: number[]) => { if (!v.length) return null; const s = [...v].sort((a, b) => a - b); return s[s.length >> 1]; };

/** Registers all panos jointly and keeps the result only when the held-out fit improves (see the file comment). */
export function registerPanosJointly(input: JointRegistrationInput): JointRegistrationResult {
    const clock = input.now ?? Date.now;
    const t0 = clock();
    const timings: Record<string, number> = {};
    const log = input.log ?? (() => undefined);
    const wide = input.frames.filter(f => f.view.fovDeg >= EDGE_REG_MIN_FOV_DEG).sort((a, b) => (a.key < b.key ? -1 : 1));
    const panoIds = [...new Set(wide.map(f => f.view.panoId))].sort();
    // the start: the edge pose where its search locked onto the scan, else the box pose
    const start = new Map<string, PoseCorrection>();
    const startKind = new Map<string, 'edges' | 'boxes'>();
    const refHeading = new Map<string, number>();
    for (const id of panoIds) {
        const c = input.candidates.get(id);
        const first = wide.find(f => f.view.panoId === id)!;
        const pick = c?.edge && c.edgeLocked ? c.edge : (c?.box ?? input.current.corrections.get(id) ?? ZERO_CORRECTION);
        startKind.set(id, c?.edge && c.edgeLocked ? 'edges' : 'boxes');
        refHeading.set(id, pick.referenceHeadingDeg ?? first.view.headingDeg);
        start.set(id, { ...pick, referenceHeadingDeg: pick.referenceHeadingDeg ?? first.view.headingDeg });
    }
    const current = new Map<string, PoseCorrection>();
    for (const id of panoIds) {
        const c = input.current.corrections.get(id) ?? ZERO_CORRECTION;
        current.set(id, { ...c, referenceHeadingDeg: c.referenceHeadingDeg ?? refHeading.get(id)! });
    }
    // the structure's own faces (term (e))
    let t = Date.now();
    const outlineMesh = input.faces?.length && process.env.SCRATCHBOX_JOINT_OUTLINE !== '0' ? faceSlabMesh(input.mesh, input.faces.map(f => f.chart)) : undefined;
    const useOutline = !!outlineMesh && outlineMesh.indices.length >= 3 * 12;
    if (outlineMesh) timings.outlineMesh = Date.now() - t;
    // the score frames (held-out cells only)
    t = Date.now();
    const metricFrames = wide.map(f => prepare(f, JOINT_METRIC_WIDTH_PX, refHeading.get(f.view.panoId)!));
    const held = (X: V3) => !trainCell(X);
    const metricOutline = useOutline ? { mesh: outlineMesh!, dts: metricFrames.map(outlineDT) } : undefined;
    const fitCurrent = heldOutPoseFit(metricFrames, input.mesh, current, undefined, held, metricOutline);
    const fitStart = heldOutPoseFit(metricFrames, input.mesh, start, undefined, held, metricOutline);
    timings.scoreStart = Date.now() - t;
    log(`[joint] held-out fit: current chamfer ${fitCurrent.chamferPx} px NCC ${fitCurrent.gradNcc}${useOutline ? ` outline ${fitCurrent.outlinePx} px` : ''}; start chamfer ${fitStart.chamferPx} px NCC ${fitStart.gradNcc}${useOutline ? ` outline ${fitStart.outlinePx} px` : ''}`);

    // (a)-(c): coarse to fine, on the training cells only
    const budget = input.budgetMs ?? JOINT_REGISTRATION_BUDGET_MS;
    let corrs = new Map(start);
    let res: CrossViewResult | undefined;
    let before: CrossViewResult | undefined;
    let fineFrames: Prepared[] = [];
    for (const [s, width] of JOINT_WIDTHS_PX.entries()) {
        const left = budget - (clock() - t0);
        if (left < 5000) { log(`[joint] budget spent before the ${width} px scale`); break; }
        t = Date.now();
        const prepared = wide.map(f => prepare(f, width, refHeading.get(f.view.panoId)!));
        const refiner = new StreetViewCrossViewRefiner(input.mesh, prepared.map(p => crossViewFrame(p, useOutline)), {
            outerIterations: 2, initialSearchPx: s === 0 ? 16 : 6, searchPx: s === 0 ? 4 : 3, finalSearchPx: 6,
            patchPx: Math.round(40 * width / 640), stridePx: Math.round(24 * width / 640), minOverlapPx: Math.round(6000 * (width / 900) ** 2),
            // street photos of different days match less sharply than the refiner's defaults assume; these, and the priors,
            // were chosen on the held-out cells of a recorded live run (docs/processes/staged_location_texture_pass_live_arch.md, round 5)
            minDepthMeters: 3, minPeak: 0.4, minPeakMargin: 0.06,
            priors: { horizontalSigmaMeters: 0.8, verticalSigmaMeters: 0.3, angleSigmaDeg: 0.6 },
            bounds: { horizontalMeters: 9, verticalMeters: 2.5, yawDeg: 8, pitchDeg: 5, rollDeg: 3 },
            silhouetteEquivalentMatches: 40, edgeEquivalentMatches: 40, pointFilter: X => trainCell(X), budgetMs: Math.max(5000, left - 8000), log,
            ...(useOutline ? { outlineMesh, outlineEquivalentMatches: OUTLINE_EQUIVALENT_MATCHES } : {}),
            ...(input.refiner ?? {})
        });
        refiner.useThreads(input.threads ?? HeadlessEdgeRenderPool.defaultThreads());
        try {
            // the matches before refining, at the finest scale that runs: measured at the coarsest too, so a budget that ends
            // before the fine scale still keeps the coarse fit for the held-out test below (it was thrown away whole until
            // 2026-11-08: Penn's street objects refined 44 panos to a 3.49 px median and the nominal poses stood)
            if (s === 0 || s === JOINT_WIDTHS_PX.length - 1) { before = refiner.measure(corrs); fineFrames = prepared; }
            res = refiner.run(corrs, start);
        } finally {
            refiner.close();
        }
        corrs = new Map([...res.corrections].map(([id, c]) => [id, { ...c, referenceHeadingDeg: refHeading.get(id)! }]));
        timings[`scale${width}`] = Date.now() - t;
    }
    if (!res || !before) {
        return { registration: input.current, chosen: 'current', reason: 'the joint fit did not run in its budget', fit: { current: fitCurrent, start: fitStart, joint: null, warped: null }, panos: [], matches: { before: 0, after: 0, medianPxBefore: null, medianPxAfter: null }, warps: [], outlineTerm: { used: useOutline, triangles: outlineMesh ? outlineMesh.indices.length / 3 : 0 }, timingsMs: { ...timings, total: Date.now() - t0 } };
    }
    const mags = (r: CrossViewResult) => median(r.matches.map(m => Math.hypot(m.bx - m.qx, m.by - m.qy)));
    // (d) the warps, fitted to the final training matches
    t = Date.now();
    const fineCams = fineFrames.map(f => camOf(f, corrs.get(f.panoId)!));
    const warps = fitPanoWarps(fineFrames, fineCams, res.matches);
    timings.warps = Date.now() - t;
    t = Date.now();
    const fitJoint = heldOutPoseFit(metricFrames, input.mesh, corrs, undefined, held, metricOutline);
    const fitWarped = warps.size ? heldOutPoseFit(metricFrames, input.mesh, corrs, warps, held, metricOutline) : null;
    timings.scoreJoint = Date.now() - t;
    log(`[joint] held-out fit: joint chamfer ${fitJoint.chamferPx} px NCC ${fitJoint.gradNcc}${useOutline ? ` outline ${fitJoint.outlinePx} px` : ''}${fitWarped ? `; with warps chamfer ${fitWarped.chamferPx} px NCC ${fitWarped.gradNcc}` : ''}`);

    let chosen: JointRegistrationResult['chosen'] = 'current';
    let reason: string;
    const f = (x: PoseFit) => `chamfer ${x.chamferPx ?? 'n/a'} px, gradient NCC ${x.gradNcc ?? 'n/a'}`;
    if (fitIsBetter(fitJoint, fitCurrent)) {
        chosen = 'joint';
        reason = `the joint poses fit the held-out views better (${f(fitJoint)}) than the per-pano choice (${f(fitCurrent)})`;
        if (fitWarped && fitIsBetter(fitWarped, fitJoint)) { chosen = 'joint+warp'; reason += `, and the per-pano warps better still (${f(fitWarped)})`; }
        else if (fitWarped) reason += `; the warps were not kept (${f(fitWarped)})`;
    } else {
        reason = `the joint poses do not fit the held-out views better (${f(fitJoint)}) than the per-pano choice (${f(fitCurrent)}), so it stands`;
    }
    const panos: JointPanoOutcome[] = panoIds.map(id => {
        const c = corrs.get(id)!, s0 = start.get(id)!;
        const mine = res!.frames.filter(fr => fr.panoId === id);
        const mpx = mine.map(fr => fr.medianPx).filter((x): x is number => x !== null), mm = mine.map(fr => fr.medianMeters).filter((x): x is number => x !== null);
        return {
            panoId: id, start: startKind.get(id)!, correction: c,
            movedM: r3(Math.hypot(c.dx - s0.dx, c.dy - s0.dy, c.dz - s0.dz)), turnedDeg: r3(Math.hypot(c.dyawDeg - s0.dyawDeg, c.dpitchDeg - s0.dpitchDeg, c.drollDeg - s0.drollDeg)),
            matches: mine.reduce((s, fr) => s + fr.matches, 0), medianPx: mpx.length ? r3(median(mpx)!) : null, medianM: mm.length ? r3(median(mm)!) : null,
            ...(warps.get(id) ? { warpMedianDeg: warps.get(id)!.medianDeg } : {})
        };
    });
    const registration = chosen === 'current' ? input.current : jointRegistration(input.current, corrs, panos, chosen === 'joint+warp' ? warps : undefined);
    timings.total = Date.now() - t0;
    return {
        registration, chosen, reason, fit: { current: fitCurrent, start: fitStart, joint: fitJoint, warped: fitWarped }, panos,
        matches: { before: before.matches.length, after: res.matches.length, medianPxBefore: mags(before) === null ? null : r3(mags(before)!), medianPxAfter: mags(res) === null ? null : r3(mags(res)!) },
        warps: [...warps.values()], outlineTerm: { used: useOutline, triangles: outlineMesh ? outlineMesh.indices.length / 3 : 0 }, timingsMs: timings
    };
}

/** The current registration's shape with the joint poses: corrections, per-pano numbers ('joint', the matches' residual in metres) and the warps. */
function jointRegistration(current: Registration, corrs: Map<string, PoseCorrection>, panos: JointPanoOutcome[], warps?: Map<string, PanoWarp>): Registration {
    const corrections = new Map(current.corrections);
    const perPano = current.perPano.map(p => ({ ...p }));
    for (const p of panos) {
        const c = corrs.get(p.panoId)!;
        corrections.set(p.panoId, c);
        const entry = {
            panoId: p.panoId, dxM: r3(c.dx), dzM: r3(c.dz), dyawDeg: Math.round(c.dyawDeg * 100) / 100, dpitchDeg: Math.round(c.dpitchDeg * 100) / 100,
            method: 'joint' as const, edgeResidualM: Math.max(EDGE_RESIDUAL_FLOOR_M, p.medianM ?? EDGE_RESIDUAL_FLOOR_M)
        };
        const k = perPano.findIndex(q => q.panoId === p.panoId);
        if (k >= 0) perPano[k] = { ...perPano[k], ...entry }; else perPano.push({ ...entry, pairs: 0, beforeRmsM: NaN, afterRmsM: NaN });
    }
    const ids = new Set(panos.map(p => p.panoId));
    return { ...current, corrections, perPano, setAside: current.setAside.filter(s => !ids.has(s.panoId)), ...(warps?.size ? { warps } : {}) };
}

/** The joint registration in words for the stage panel. */
export function describeJointRegistration(r: JointRegistrationResult): string {
    const f = (x: PoseFit | null) => (x ? `chamfer ${x.chamferPx ?? 'n/a'} px / NCC ${x.gradNcc ?? 'n/a'}${x.outlinePx !== undefined ? ` / face outline ${x.outlinePx ?? 'n/a'} px` : ''}` : 'n/a');
    return `joint registration of ${r.panos.length} panos${r.outlineTerm.used ? ' (with the face-outline term)' : ''} (${r.matches.before} -> ${r.matches.after} cross-view matches, median ${r.matches.medianPxBefore ?? 'n/a'} -> ${r.matches.medianPxAfter ?? 'n/a'} px) in ${((r.timingsMs.total ?? 0) / 1000).toFixed(1)} s; held-out fit: per-pano choice ${f(r.fit.current)}, joint ${f(r.fit.joint)}, with warps ${f(r.fit.warped)}; kept: ${r.chosen} (${r.reason})`;
}

export type { Vec3 };
