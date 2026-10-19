/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The photo-match evaluator: does a build look like the real place, judged against real photos it never saw?
 *
 * Inputs are held-out views (a real photo and its registered pinhole pose, in the tile frame) and arms (the GLB layers one
 * pipeline variant produced, in the same frame). For every view:
 *  - each arm is rendered from exactly the photo's pose, at the photo's resolution and field of view, by a software
 *    rasterizer (perspective-correct UVs, mip-mapped bilinear base colour, z-buffer, 2x2 supersampling). Every arm gets the
 *    same neutral light (a camera headlight term over a flat ambient) on the same flat grey background, so lighting is never
 *    what separates two arms;
 *  - a vision model is shown the photo and the arm renders in shuffled order, unlabelled, and scores each render 1-10 on
 *    shape, materials, detail, errors (10 = nothing wrong or invented) and overall. Each judgement runs `repeats` times with
 *    the order reshuffled; the scores are mapped back to the arms and reported as mean and spread;
 *  - secondary numbers inside the building mask (the reference arm's coverage, by default the raw scan): luminance SSIM,
 *    the symmetric structural-edge chamfer (texture-fit-metric.ts's edges and truncation) and the mean CIEDE2000 of the
 *    blurred colours, plus how much of the mask the arm covers;
 *  - a grid image: the photo beside every arm render, labelled, for a person to look at.
 *
 * Nothing here knows a place or a pipeline; the arms are whatever GLBs the caller names. The photos must not have been used
 * to texture or register any arm: the caller holds them out (the bake-off driver checks the pano ids).
 */

import type { DecodedImage, PinholeCamera } from '../../../common/spatial/texture-pass-contracts';
import type { Vec3 } from '../../../common/spatial/staged-location-contracts';
import { SRGB8_TO_LINEAR, linearToSrgb255 } from '../../../common/spatial/photogrammetric-delight';
import { distanceTransform, gaussianBlur } from '../../spatial/StreetViewPoseRegistrar';
import { chamferMean, FIT_CHAMFER_TRUNCATION_PX, reducedLuminance, structuralEdges } from './texture-fit-metric';
import { deltaE00, linearToLab } from './texel-exposure';
import { encodePng } from './png-encode';
import type { TileTriangles } from './tile-texture-transfer';

// =============================================================================
// Rendering
// =============================================================================

/** Flat background of every render (sRGB). */
export const PHOTO_MATCH_BACKGROUND: Vec3 = [128, 128, 128];
/** The neutral light: ambient share, the rest from a headlight (|n . view|). */
export const PHOTO_MATCH_AMBIENT = 0.72;
/** Nearest depth rendered (m). */
export const PHOTO_MATCH_NEAR_M = 0.25;

export interface ArmRender {
    width: number;
    height: number;
    /** sRGB8 RGBA, background where nothing renders. */
    rgba: Uint8Array;
    /** 0..1 share of each pixel's samples that hit the arm (never its context). */
    coverage: Float32Array;
    triangles: number;
    ms: number;
}

interface MipLevel { width: number; height: number; linear: Float32Array }
const mipCache = new WeakMap<object, MipLevel[]>();

function mipChain(tex: TileTriangles['textures'][number]): MipLevel[] {
    let chain = mipCache.get(tex);
    if (chain) return chain;
    chain = [{ width: tex.width, height: tex.height, linear: tex.linear }];
    for (let k = 0; k < 12; k++) {
        const p = chain[chain.length - 1];
        if (p.width <= 1 && p.height <= 1) break;
        const w = Math.max(1, p.width >> 1), h = Math.max(1, p.height >> 1);
        const out = new Float32Array(w * h * 3);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            for (let c = 0; c < 3; c++) {
                let s = 0, n = 0;
                for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
                    const xx = Math.min(p.width - 1, x * 2 + dx), yy = Math.min(p.height - 1, y * 2 + dy);
                    s += p.linear[(yy * p.width + xx) * 3 + c]; n++;
                }
                out[(y * w + x) * 3 + c] = s / n;
            }
        }
        chain.push({ width: w, height: h, linear: out });
    }
    mipCache.set(tex, chain);
    return chain;
}

function sampleBilinear(m: MipLevel, u: number, v: number, repeatS: boolean, repeatT: boolean, out: Float64Array): void {
    // glTF UV: (0, 0) is the top-left of the image
    const x = u * m.width - 0.5, y = v * m.height - 0.5;
    const wrap = (i: number, n: number, rep: boolean) => (rep ? ((i % n) + n) % n : Math.max(0, Math.min(n - 1, i)));
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    const xa = wrap(x0, m.width, repeatS), xb = wrap(x0 + 1, m.width, repeatS), ya = wrap(y0, m.height, repeatT), yb = wrap(y0 + 1, m.height, repeatT);
    for (let c = 0; c < 3; c++) {
        const a = m.linear[(ya * m.width + xa) * 3 + c], b = m.linear[(ya * m.width + xb) * 3 + c];
        const d = m.linear[(yb * m.width + xa) * 3 + c], e = m.linear[(yb * m.width + xb) * 3 + c];
        out[c] = (a * (1 - fx) + b * fx) * (1 - fy) + (d * (1 - fx) + e * fx) * fy;
    }
}

/** One vertex in camera space with its UV. */
interface CamVertex { x: number; y: number; z: number; u: number; v: number }

/** Clips a camera-space polygon to z >= near (Sutherland-Hodgman, one plane). */
function clipNear(poly: CamVertex[], near: number): CamVertex[] {
    const out: CamVertex[] = [];
    for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        const ina = a.z >= near, inb = b.z >= near;
        if (ina) out.push(a);
        if (ina !== inb) {
            const t = (near - a.z) / (b.z - a.z);
            out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: near, u: a.u + (b.u - a.u) * t, v: a.v + (b.v - a.v) * t });
        }
    }
    return out;
}

/**
 * Renders triangle soups (readTileTriangles: tile frame, linear textures) from a pinhole camera at the camera's own
 * resolution. `supersample` samples per pixel side (2 = 4 samples). Both faces of a triangle render (scan meshes have mixed
 * winding); the nearest surface wins; `occluderDepth` hides what the real place hides.
 */
export function renderTriangles(meshes: TileTriangles[], camera: PinholeCamera, options: {
    supersample?: number; background?: Vec3; ambient?: number;
    /**
     * What stands in front in the real place (e.g. the full tile mesh: neighbours, trees, the street): its depth from the same
     * camera (camera z, metres, at the camera's resolution; Infinity or >= 1e8 where nothing). An arm surface farther than it
     * (by 0.25 m + 2 percent) is hidden, as the photo hides it, so every arm is seen through the same occluders.
     */
    occluderDepth?: Float32Array;
    /**
     * The place around the arm (e.g. the photo-textured tile with the target cut out, identical for every arm): drawn with
     * the arm, depth-tested against it and lit the same, so the arm is seen in its street as the photo shows it. `coverage`
     * still counts the arm's samples only, so the metrics' mask stays the target.
     */
    context?: TileTriangles[];
} = {}): ArmRender {
    const t0 = Date.now();
    const ss = Math.max(1, Math.round(options.supersample ?? 2));
    const W = camera.width * ss, H = camera.height * ss;
    const fx = camera.fx * ss, fy = camera.fy * ss, cx = camera.cx * ss, cy = camera.cy * ss;
    const depth = new Float32Array(W * H).fill(Infinity);
    const mesh = new Int32Array(W * H).fill(-1), tri = new Int32Array(W * H).fill(-1);
    const bu = new Float32Array(W * H), bv = new Float32Array(W * H);
    const levelOf = new Map<number, Float32Array>(); // per mesh: mip level per triangle
    const { eye, right, up, fwd } = camera;
    let drawn = 0;
    const armMeshes = meshes.length;
    if (options.context?.length) meshes = [...meshes, ...options.context];
    meshes.forEach((m, mi) => {
        const nt = m.texture.length;
        const levels = new Float32Array(nt);
        levelOf.set(mi, levels);
        const P = m.positions, UV = m.uvs;
        for (let t = 0; t < nt; t++) {
            const poly: CamVertex[] = [];
            for (let k = 0; k < 3; k++) {
                const o = t * 9 + k * 3;
                const dx = P[o] - eye[0], dy = P[o + 1] - eye[1], dz = P[o + 2] - eye[2];
                poly.push({ x: dx * right[0] + dy * right[1] + dz * right[2], y: dx * up[0] + dy * up[1] + dz * up[2], z: dx * fwd[0] + dy * fwd[1] + dz * fwd[2], u: UV[t * 6 + k * 2], v: UV[t * 6 + k * 2 + 1] });
            }
            if (poly[0].z < PHOTO_MATCH_NEAR_M && poly[1].z < PHOTO_MATCH_NEAR_M && poly[2].z < PHOTO_MATCH_NEAR_M) continue;
            const clipped = poly[0].z < PHOTO_MATCH_NEAR_M || poly[1].z < PHOTO_MATCH_NEAR_M || poly[2].z < PHOTO_MATCH_NEAR_M ? clipNear(poly, PHOTO_MATCH_NEAR_M) : poly;
            if (clipped.length < 3) continue;
            const sx = clipped.map(p => cx + (fx * p.x) / p.z), sy = clipped.map(p => cy - (fy * p.y) / p.z);
            let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
            for (let i = 0; i < sx.length; i++) { minX = Math.min(minX, sx[i]); maxX = Math.max(maxX, sx[i]); minY = Math.min(minY, sy[i]); maxY = Math.max(maxY, sy[i]); }
            if (maxX < 0 || maxY < 0 || minX >= W || minY >= H) continue;
            // mip level: texels per screen sample over the original triangle (area ratio)
            const ti = m.texture[t];
            if (ti >= 0) {
                const tex = m.textures[ti];
                const ua = (UV[t * 6 + 2] - UV[t * 6]) * tex.width, va = (UV[t * 6 + 3] - UV[t * 6 + 1]) * tex.height;
                const ub = (UV[t * 6 + 4] - UV[t * 6]) * tex.width, vb = (UV[t * 6 + 5] - UV[t * 6 + 1]) * tex.height;
                const texArea = Math.abs(ua * vb - ub * va) / 2;
                let scrArea = 0;
                for (let i = 1; i + 1 < sx.length; i++) scrArea += Math.abs((sx[i] - sx[0]) * (sy[i + 1] - sy[0]) - (sx[i + 1] - sx[0]) * (sy[i] - sy[0])) / 2;
                levels[t] = scrArea > 1e-9 ? Math.max(0, 0.5 * Math.log2(texArea / scrArea)) : 0;
            }
            // fan triangulation of the clipped polygon
            for (let f = 1; f + 1 < clipped.length; f++) {
                const ids = [0, f, f + 1];
                const X = ids.map(i => sx[i]), Y = ids.map(i => sy[i]), Z = ids.map(i => clipped[i]);
                const area = (X[1] - X[0]) * (Y[2] - Y[0]) - (X[2] - X[0]) * (Y[1] - Y[0]);
                if (Math.abs(area) < 1e-12) continue;
                const x0 = Math.max(0, Math.floor(Math.min(X[0], X[1], X[2]))), x1 = Math.min(W - 1, Math.ceil(Math.max(X[0], X[1], X[2])));
                const y0 = Math.max(0, Math.floor(Math.min(Y[0], Y[1], Y[2]))), y1 = Math.min(H - 1, Math.ceil(Math.max(Y[0], Y[1], Y[2])));
                const iz = Z.map(p => 1 / p.z);
                for (let py = y0; py <= y1; py++) {
                    const yc = py + 0.5;
                    for (let px = x0; px <= x1; px++) {
                        const xc = px + 0.5;
                        const w0 = ((X[1] - xc) * (Y[2] - yc) - (X[2] - xc) * (Y[1] - yc)) / area;
                        const w1 = ((X[2] - xc) * (Y[0] - yc) - (X[0] - xc) * (Y[2] - yc)) / area;
                        const w2 = 1 - w0 - w1;
                        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
                        const izp = w0 * iz[0] + w1 * iz[1] + w2 * iz[2];
                        const z = 1 / izp;
                        const i = py * W + px;
                        if (z >= depth[i]) continue;
                        depth[i] = z;
                        mesh[i] = mi; tri[i] = t;
                        bu[i] = (w0 * Z[0].u * iz[0] + w1 * Z[1].u * iz[1] + w2 * Z[2].u * iz[2]) / izp;
                        bv[i] = (w0 * Z[0].v * iz[0] + w1 * Z[1].v * iz[1] + w2 * Z[2].v * iz[2]) / izp;
                    }
                }
            }
            if (mi < armMeshes) drawn++;
        }
    });
    // shade the samples, then box-reduce to the camera's resolution
    const amb = options.ambient ?? PHOTO_MATCH_AMBIENT;
    const bg = options.background ?? PHOTO_MATCH_BACKGROUND;
    const bgLin = bg.map(c => SRGB8_TO_LINEAR[c]);
    const outW = camera.width, outH = camera.height;
    const acc = new Float64Array(outW * outH * 3), cov = new Float32Array(outW * outH);
    const col = new Float64Array(3);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const o = (Math.floor(y / ss) * outW + Math.floor(x / ss));
        let mi = mesh[i];
        if (mi >= 0 && options.occluderDepth) {
            const oz = options.occluderDepth[Math.floor(y / ss) * camera.width + Math.floor(x / ss)];
            if (oz < 1e8 && oz < depth[i] - (0.25 + 0.02 * depth[i])) mi = -1;
        }
        if (mi < 0) { acc[o * 3] += bgLin[0]; acc[o * 3 + 1] += bgLin[1]; acc[o * 3 + 2] += bgLin[2]; continue; }
        const m = meshes[mi], t = tri[i], ti = m.texture[t];
        if (ti >= 0) {
            const tex = m.textures[ti], chain = mipChain(tex);
            const lv = levelOf.get(mi)![t];
            const l0 = Math.min(chain.length - 1, Math.floor(lv)), l1 = Math.min(chain.length - 1, l0 + 1), f = Math.min(1, lv - l0);
            sampleBilinear(chain[l0], bu[i], bv[i], tex.repeatS, tex.repeatT, col);
            if (f > 0.01 && l1 !== l0) {
                const a0 = col[0], a1 = col[1], a2 = col[2];
                sampleBilinear(chain[l1], bu[i], bv[i], tex.repeatS, tex.repeatT, col);
                col[0] = a0 * (1 - f) + col[0] * f; col[1] = a1 * (1 - f) + col[1] * f; col[2] = a2 * (1 - f) + col[2] * f;
            }
        } else {
            col[0] = m.flatLinear[t * 3]; col[1] = m.flatLinear[t * 3 + 1]; col[2] = m.flatLinear[t * 3 + 2];
        }
        // the neutral light: ambient plus a headlight on the facet normal
        const xc = (x + 0.5 - cx) / fx, yc = -(y + 0.5 - cy) / fy;
        const dx = right[0] * xc + up[0] * yc + fwd[0], dy = right[1] * xc + up[1] * yc + fwd[1], dz = right[2] * xc + up[2] * yc + fwd[2];
        const dl = Math.hypot(dx, dy, dz);
        const n = t * 3;
        const cos = Math.abs((m.normals[n] * dx + m.normals[n + 1] * dy + m.normals[n + 2] * dz) / dl);
        const shade = amb + (1 - amb) * cos;
        acc[o * 3] += col[0] * shade; acc[o * 3 + 1] += col[1] * shade; acc[o * 3 + 2] += col[2] * shade;
        if (mi < armMeshes) cov[o] += 1;
    }
    const k = ss * ss;
    const rgba = new Uint8Array(outW * outH * 4);
    for (let o = 0; o < outW * outH; o++) {
        rgba[o * 4] = linearToSrgb255(acc[o * 3] / k); rgba[o * 4 + 1] = linearToSrgb255(acc[o * 3 + 1] / k); rgba[o * 4 + 2] = linearToSrgb255(acc[o * 3 + 2] / k); rgba[o * 4 + 3] = 255;
        cov[o] /= k;
    }
    return { width: outW, height: outH, rgba, coverage: cov, triangles: drawn, ms: Date.now() - t0 };
}

// =============================================================================
// Perceptual metrics (secondary)
// =============================================================================

/** Working width of the metrics (px): the fit metric's scale. */
export const PHOTO_MATCH_METRIC_WIDTH_PX = 640;

export interface PerceptualScores {
    /** Share of the building mask the arm covers. */
    coverage: number;
    /** Mean luminance SSIM over the mask (Gaussian window, sigma 1.5 px at the working width). */
    ssim: number | null;
    /** Symmetric structural-edge chamfer inside the mask (px at the working width, truncated). Lower is better. */
    edgeChamferPx: number | null;
    /** Mean CIEDE2000 of the colours blurred at sigma 3 px, over the mask. Lower is better. */
    colourDeltaE: number | null;
    maskPixels: number;
}

function resizeRgbaBox(img: { width: number; height: number; rgba: Uint8Array }, w: number, h: number): Uint8Array {
    const out = new Uint8Array(w * h * 4);
    const sx = img.width / w, sy = img.height / h;
    for (let y = 0; y < h; y++) {
        const y0 = Math.floor(y * sy), y1 = Math.min(img.height, Math.max(y0 + 1, Math.floor((y + 1) * sy)));
        for (let x = 0; x < w; x++) {
            const x0 = Math.floor(x * sx), x1 = Math.min(img.width, Math.max(x0 + 1, Math.floor((x + 1) * sx)));
            const s = [0, 0, 0, 0];
            let n = 0;
            for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { const k = (yy * img.width + xx) * 4; s[0] += img.rgba[k]; s[1] += img.rgba[k + 1]; s[2] += img.rgba[k + 2]; s[3] += img.rgba[k + 3]; n++; }
            for (let c = 0; c < 4; c++) out[(y * w + x) * 4 + c] = Math.round(s[c] / Math.max(1, n));
        }
    }
    return out;
}

function resizeField(f: Float32Array, W: number, H: number, w: number, h: number): Float32Array {
    const out = new Float32Array(w * h);
    const sx = W / w, sy = H / h;
    for (let y = 0; y < h; y++) {
        const y0 = Math.floor(y * sy), y1 = Math.min(H, Math.max(y0 + 1, Math.floor((y + 1) * sy)));
        for (let x = 0; x < w; x++) {
            const x0 = Math.floor(x * sx), x1 = Math.min(W, Math.max(x0 + 1, Math.floor((x + 1) * sx)));
            let s = 0, n = 0;
            for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { s += f[yy * W + xx]; n++; }
            out[y * w + x] = n ? s / n : 0;
        }
    }
    return out;
}

/** Mean SSIM of two luminance images (0..255) over a mask. */
export function maskedSsim(a: Float32Array, b: Float32Array, w: number, h: number, mask: Uint8Array, sigma = 1.5): number | null {
    const n = w * h;
    const ab = new Float32Array(n), aa = new Float32Array(n), bb = new Float32Array(n);
    for (let i = 0; i < n; i++) { ab[i] = a[i] * b[i]; aa[i] = a[i] * a[i]; bb[i] = b[i] * b[i]; }
    const ma = gaussianBlur(a, w, h, sigma), mb = gaussianBlur(b, w, h, sigma);
    const saa = gaussianBlur(aa, w, h, sigma), sbb = gaussianBlur(bb, w, h, sigma), sab = gaussianBlur(ab, w, h, sigma);
    const C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2;
    let s = 0, k = 0;
    for (let i = 0; i < n; i++) {
        if (!mask[i]) continue;
        const va = Math.max(0, saa[i] - ma[i] * ma[i]), vb = Math.max(0, sbb[i] - mb[i] * mb[i]), cab = sab[i] - ma[i] * mb[i];
        s += ((2 * ma[i] * mb[i] + C1) * (2 * cab + C2)) / ((ma[i] * ma[i] + mb[i] * mb[i] + C1) * (va + vb + C2));
        k++;
    }
    return k >= 200 ? s / k : null;
}

/**
 * The secondary numbers of one arm render against the photo, inside `mask` (photo resolution, 1 = the building).
 * Everything is computed at PHOTO_MATCH_METRIC_WIDTH_PX wide.
 */
export function perceptualScores(photo: DecodedImage, render: ArmRender, mask: Uint8Array): PerceptualScores {
    const W = photo.width, H = photo.height;
    const w = Math.min(W, PHOTO_MATCH_METRIC_WIDTH_PX), h = Math.max(1, Math.round((H * w) / W));
    const m = resizeField(Float32Array.from(mask), W, H, w, h);
    const region = new Uint8Array(w * h);
    let maskPixels = 0;
    for (let i = 0; i < region.length; i++) if (m[i] >= 0.5) { region[i] = 1; maskPixels++; }
    const cov = resizeField(render.coverage, W, H, w, h);
    let covered = 0;
    for (let i = 0; i < region.length; i++) if (region[i] && cov[i] >= 0.5) covered++;
    const lp = reducedLuminance(photo, w, h), lr = reducedLuminance({ width: render.width, height: render.height, rgba: render.rgba }, w, h);
    const ssim = maskedSsim(lp, lr, w, h, region);
    // structural edges both ways inside the mask (the photo's found around it, so a mask edge does not cut its segments)
    const near = new Uint8Array(w * h);
    const dtMask = distanceTransform(region, w, h, 8);
    for (let i = 0; i < near.length; i++) if (dtMask[i] <= 6) near[i] = 1;
    const eP = structuralEdges(lp, w, h, near), eR = structuralEdges(lr, w, h, near);
    const dtP = distanceTransform(eP, w, h, FIT_CHAMFER_TRUNCATION_PX + 1), dtR = distanceTransform(eR, w, h, FIT_CHAMFER_TRUNCATION_PX + 1);
    const ca = chamferMean(eR, dtP, region), cb = chamferMean(eP, dtR, region);
    const edgeChamferPx = ca !== null && cb !== null ? (ca + cb) / 2 : ca ?? cb;
    // colour: blurred linear RGB -> Lab, CIEDE2000, every second pixel
    const rp = resizeRgbaBox(photo, w, h), rr = resizeRgbaBox(render, w, h);
    const chan = (src: Uint8Array, c: number) => { const f = new Float32Array(w * h); for (let i = 0; i < f.length; i++) f[i] = SRGB8_TO_LINEAR[src[i * 4 + c]]; return gaussianBlur(f, w, h, 3); };
    const P = [0, 1, 2].map(c => chan(rp, c)), R = [0, 1, 2].map(c => chan(rr, c));
    let de = 0, nd = 0;
    for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
        const i = y * w + x;
        if (!region[i]) continue;
        de += deltaE00(linearToLab(P[0][i], P[1][i], P[2][i]), linearToLab(R[0][i], R[1][i], R[2][i]));
        nd++;
    }
    const r3 = (v: number | null) => (v === null ? null : Math.round(v * 1000) / 1000);
    return { coverage: maskPixels ? r3(covered / maskPixels)! : 0, ssim: r3(ssim), edgeChamferPx: r3(edgeChamferPx), colourDeltaE: nd >= 50 ? r3(de / nd) : null, maskPixels };
}

/** The building mask of a view: pixels the reference render covers at least half. */
export function coverageMask(render: ArmRender): Uint8Array {
    const m = new Uint8Array(render.width * render.height);
    for (let i = 0; i < m.length; i++) if (render.coverage[i] >= 0.5) m[i] = 1;
    return m;
}

// =============================================================================
// Blind judging
// =============================================================================

export const JUDGE_CRITERIA = ['shape', 'materials', 'detail', 'errors', 'overall'] as const;
export type JudgeCriterion = typeof JUDGE_CRITERIA[number];
export type JudgeScores = Record<JudgeCriterion, number>;

/** The part of a vision chain the judge calls (VisionModelChain.generate). */
export interface JudgeClient {
    generate(params: { contents: Array<{ role: string; parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> }>; config?: Record<string, unknown> },
        opts: { stage: string; thinkingBudget?: number }): Promise<{ response: { candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> }; finishReason?: string }> }; model: string; remember?: () => void }>;
}

export interface JudgeRun { order: string[]; scores: Record<string, JudgeScores>; notes: Record<string, string>; model: string }

/** Deterministic shuffle (mulberry32 seeded by a string). */
export function seededShuffle<T>(items: T[], seed: string): T[] {
    let h = 1779033703 ^ seed.length;
    for (let i = 0; i < seed.length; i++) { h = Math.imul(h ^ seed.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
    let s = h >>> 0;
    const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const a = items.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
}

export function judgePrompt(place: string, count: number): { preamble: string; closing: string } {
    return {
        preamble: `You are judging how closely 3D reconstructions match a real place. Image 0 is a real photograph (Google Street View) of ${place}. ` +
            `Images 1 to ${count} are renders of ${count} different 3D reconstructions of that building, each rendered from exactly the camera position, direction, field of view and resolution of the photograph, ` +
            'all with the same flat neutral light on the same flat grey background. Judge only the target building the renders show: ignore the sky, trees, vehicles, people, street furniture and any neighbouring buildings the renders leave out, ' +
            'and do not reward or penalise a render for the absence of sun and shadows (no render has them). The renders are in no particular order and come from different methods.',
        closing: `Score every render 1-10 (10 best) against the photograph on five criteria:\n` +
            '- shape: shape and silhouette match (massing, roofline, setbacks, openings in the right places);\n' +
            '- materials: materials and colour match (the facade materials and their colours as the photograph shows them);\n' +
            '- detail: detail believability (windows, cornices, ornament, storefronts read as the real ones, at a believable sharpness);\n' +
            '- errors: wrong or invented content, 10 = none (melted or broken geometry, smeared or doubled textures, things painted where they are not, content that is not in the photograph);\n' +
            '- overall: how much the render looks like this place in the photograph.\n' +
            `Use the whole scale and compare the renders with each other. Reply with JSON only: {"renders":[{"image":1,"shape":n,"materials":n,"detail":n,"errors":n,"overall":n,"note":"at most 20 words on what decides it"}, ...]} with one entry for each of images 1 to ${count}.`
    };
}

export function parseJudgeReply(text: string, count: number): { scores: Array<JudgeScores & { note: string }>; problems: string[] } {
    const problems: string[] = [];
    let j: { renders?: Array<Record<string, unknown>> };
    try {
        const s = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '');
        j = JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1));
    } catch {
        return { scores: [], problems: ['the reply is not JSON'] };
    }
    const out: Array<JudgeScores & { note: string }> = [];
    for (let k = 1; k <= count; k++) {
        const r = j.renders?.find(x => Number(x.image) === k);
        if (!r) { problems.push(`no entry for image ${k}`); continue; }
        const sc = {} as JudgeScores;
        let ok = true;
        for (const c of JUDGE_CRITERIA) {
            const v = Number(r[c]);
            if (!Number.isFinite(v) || v < 1 || v > 10) { ok = false; problems.push(`image ${k}: ${c} is ${String(r[c])}`); break; }
            sc[c] = v;
        }
        if (ok) out[k - 1] = { ...sc, note: typeof r.note === 'string' ? r.note : '' };
    }
    return { scores: out, problems };
}

const jpegOrPngB64 = (img: { bytes: Uint8Array; mimeType: string }) => ({ inlineData: { mimeType: img.mimeType, data: Buffer.from(img.bytes).toString('base64') } });

/**
 * One blind judgement of a view, `repeats` times: the photo, then the arm renders in an order shuffled per repeat (seeded by
 * `seed` and the repeat), unlabelled. Returns the scores mapped back to the arm ids. A reply that does not parse is retried once.
 */
export async function judgeView(input: {
    client: JudgeClient; place: string; photo: { bytes: Uint8Array; mimeType: string };
    renders: Array<{ armId: string; png: Uint8Array }>; repeats?: number; seed: string; thinkingBudget?: number; temperature?: number;
}): Promise<JudgeRun[]> {
    const runs: JudgeRun[] = [];
    const repeats = input.repeats ?? 3;
    for (let r = 0; r < repeats; r++) {
        const order = seededShuffle(input.renders, `${input.seed}#${r}`);
        const { preamble, closing } = judgePrompt(input.place, order.length);
        const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [{ text: preamble }, { text: 'Image 0: the real photograph.' }, jpegOrPngB64(input.photo)];
        order.forEach((o, k) => { parts.push({ text: `Image ${k + 1}: a render.` }, jpegOrPngB64({ bytes: o.png, mimeType: 'image/png' })); });
        parts.push({ text: closing });
        let parsed: ReturnType<typeof parseJudgeReply> | undefined;
        let model = '';
        for (let attempt = 0; attempt < 2; attempt++) {
            const res = await input.client.generate({
                contents: [{ role: 'user', parts: attempt ? [...parts, { text: `(Attempt ${attempt + 1}: reply with the JSON object only.)` }] : parts }],
                config: { responseMimeType: 'application/json', temperature: input.temperature ?? 1 }
            }, { stage: 'photo-match-judge', thinkingBudget: input.thinkingBudget ?? 24_576 });
            model = res.model;
            const text = (res.response.candidates?.[0]?.content?.parts ?? []).filter(p => !p.thought).map(p => p.text ?? '').join('');
            parsed = parseJudgeReply(text, order.length);
            if (!parsed.problems.length) { res.remember?.(); break; }
        }
        if (!parsed || parsed.problems.length) throw new Error(`photo-match judge: the reply could not be read (${parsed?.problems.slice(0, 3).join('; ')})`);
        const scores: Record<string, JudgeScores> = {}, notes: Record<string, string> = {};
        order.forEach((o, k) => { const { note, ...sc } = parsed!.scores[k]; scores[o.armId] = sc; notes[o.armId] = note; });
        runs.push({ order: order.map(o => o.armId), scores, notes, model });
    }
    return runs;
}

export interface CriterionStat { mean: number; sd: number; min: number; max: number }

/** Mean, standard deviation (population) and range of each arm's scores over the runs. */
export function aggregateRuns(runs: JudgeRun[], armIds: string[]): Record<string, Record<JudgeCriterion, CriterionStat>> {
    const out: Record<string, Record<JudgeCriterion, CriterionStat>> = {};
    for (const a of armIds) {
        out[a] = {} as Record<JudgeCriterion, CriterionStat>;
        for (const c of JUDGE_CRITERIA) {
            const v = runs.map(r => r.scores[a]?.[c]).filter((x): x is number => typeof x === 'number');
            const mean = v.reduce((s, x) => s + x, 0) / Math.max(1, v.length);
            const sd = Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, v.length));
            out[a][c] = { mean: Math.round(mean * 100) / 100, sd: Math.round(sd * 100) / 100, min: v.length ? Math.min(...v) : NaN, max: v.length ? Math.max(...v) : NaN };
        }
    }
    return out;
}

// =============================================================================
// Grids
// =============================================================================

/** 5 x 7 bitmap glyphs (rows top to bottom, 5 bits each, MSB left) for the labels. */
const GLYPHS: Record<string, number[]> = {
    'A': [14, 17, 17, 31, 17, 17, 17], 'B': [30, 17, 17, 30, 17, 17, 30], 'C': [14, 17, 16, 16, 16, 17, 14], 'D': [30, 17, 17, 17, 17, 17, 30],
    'E': [31, 16, 16, 30, 16, 16, 31], 'F': [31, 16, 16, 30, 16, 16, 16], 'G': [14, 17, 16, 23, 17, 17, 15], 'H': [17, 17, 17, 31, 17, 17, 17],
    'I': [14, 4, 4, 4, 4, 4, 14], 'J': [7, 2, 2, 2, 2, 18, 12], 'K': [17, 18, 20, 24, 20, 18, 17], 'L': [16, 16, 16, 16, 16, 16, 31],
    'M': [17, 27, 21, 21, 17, 17, 17], 'N': [17, 17, 25, 21, 19, 17, 17], 'O': [14, 17, 17, 17, 17, 17, 14], 'P': [30, 17, 17, 30, 16, 16, 16],
    'Q': [14, 17, 17, 17, 21, 18, 13], 'R': [30, 17, 17, 30, 20, 18, 17], 'S': [15, 16, 16, 14, 1, 1, 30], 'T': [31, 4, 4, 4, 4, 4, 4],
    'U': [17, 17, 17, 17, 17, 17, 14], 'V': [17, 17, 17, 17, 17, 10, 4], 'W': [17, 17, 17, 21, 21, 21, 10], 'X': [17, 17, 10, 4, 10, 17, 17],
    'Y': [17, 17, 10, 4, 4, 4, 4], 'Z': [31, 1, 2, 4, 8, 16, 31],
    '0': [14, 17, 19, 21, 25, 17, 14], '1': [4, 12, 4, 4, 4, 4, 14], '2': [14, 17, 1, 2, 4, 8, 31], '3': [31, 2, 4, 2, 1, 17, 14],
    '4': [2, 6, 10, 18, 31, 2, 2], '5': [31, 16, 30, 1, 1, 17, 14], '6': [6, 8, 16, 30, 17, 17, 14], '7': [31, 1, 2, 4, 8, 8, 8],
    '8': [14, 17, 17, 14, 17, 17, 14], '9': [14, 17, 17, 15, 1, 2, 12],
    ' ': [0, 0, 0, 0, 0, 0, 0], '.': [0, 0, 0, 0, 0, 12, 12], ',': [0, 0, 0, 0, 12, 4, 8], ':': [0, 12, 12, 0, 12, 12, 0], '-': [0, 0, 0, 31, 0, 0, 0],
    '+': [0, 4, 4, 31, 4, 4, 0], '/': [1, 1, 2, 4, 8, 16, 16], '(': [2, 4, 8, 8, 8, 4, 2], ')': [8, 4, 2, 2, 2, 4, 8], '=': [0, 0, 31, 0, 31, 0, 0],
    '%': [24, 25, 2, 4, 8, 19, 3], '\'': [4, 4, 8, 0, 0, 0, 0], '#': [10, 10, 31, 10, 31, 10, 10]
};

/** Draws `text` (upper-cased; unknown characters as spaces) into an RGB buffer at (x, y), `scale` px per glyph pixel. */
export function drawText(rgb: Uint8Array, W: number, H: number, x: number, y: number, text: string, scale: number, colour: Vec3): void {
    let cx = x;
    for (const ch of text.toUpperCase()) {
        const g = GLYPHS[ch] ?? GLYPHS[' '];
        for (let r = 0; r < 7; r++) for (let c = 0; c < 5; c++) {
            if (!((g[r] >> (4 - c)) & 1)) continue;
            for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
                const px = cx + c * scale + dx, py = y + r * scale + dy;
                if (px < 0 || py < 0 || px >= W || py >= H) continue;
                const o = (py * W + px) * 3;
                rgb[o] = colour[0]; rgb[o + 1] = colour[1]; rgb[o + 2] = colour[2];
            }
        }
        cx += 6 * scale;
    }
}

/**
 * The grid of one view: the photo, then each arm render, side by side at `tileWidth`, each with its label (and an optional
 * second line, e.g. the judge's mean overall score) above it. Wraps after `columns` tiles. PNG bytes.
 */
export function composeGrid(tiles: Array<{ image: { width: number; height: number; rgba: Uint8Array }; label: string; sublabel?: string }>, options: { tileWidth?: number; columns?: number; title?: string } = {}): Buffer {
    const tw = options.tileWidth ?? 480;
    const first = tiles[0].image;
    const th = Math.round((first.height * tw) / first.width);
    const cols = Math.min(tiles.length, options.columns ?? tiles.length);
    const rows = Math.ceil(tiles.length / cols);
    const scale = Math.max(2, Math.round(tw / 240));
    const labelH = 2 * (7 * scale + 6) + 4, titleH = options.title ? 7 * scale + 12 : 0, gap = 6;
    const W = cols * tw + (cols + 1) * gap, H = titleH + rows * (th + labelH) + (rows + 1) * gap;
    const rgb = new Uint8Array(W * H * 3).fill(24);
    if (options.title) drawText(rgb, W, H, gap, 6, options.title, scale, [255, 255, 255]);
    tiles.forEach((t, k) => {
        const c = k % cols, r = Math.floor(k / cols);
        const x0 = gap + c * (tw + gap), y0 = titleH + gap + r * (th + labelH + gap);
        drawText(rgb, W, H, x0 + 2, y0 + 3, t.label, scale, [255, 236, 160]);
        if (t.sublabel) drawText(rgb, W, H, x0 + 2, y0 + 3 + 7 * scale + 6, t.sublabel, scale, [200, 220, 255]);
        const px = resizeRgbaBox(t.image, tw, th);
        for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
            const o = ((y0 + labelH + y) * W + x0 + x) * 3, s = (y * tw + x) * 4;
            rgb[o] = px[s]; rgb[o + 1] = px[s + 1]; rgb[o + 2] = px[s + 2];
        }
    });
    return encodePng(W, H, rgb, 3);
}

/** A render as PNG bytes (what the judge is shown). */
export function renderPng(r: ArmRender): Buffer {
    return encodePng(r.width, r.height, r.rgba, 4);
}
