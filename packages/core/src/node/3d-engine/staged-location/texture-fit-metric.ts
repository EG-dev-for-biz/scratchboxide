/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The fit metric of a textured layer: how well the model, rendered from each Street View pose, lines up with that photo,
 * measured only on what the photo did not make (leave one pano out).
 *
 * Per scoring view (a registered Street View image and its pose):
 *  - the layer is rendered from the pose by splatting its atlas texels (z-buffered, depth-tested against the full scan, so a
 *    statue in front or the building behind an opening does not count as the layer). Texels whose provenance names the view's
 *    own pano take part in the visibility but are not scored: the score is held out.
 *  - texture edges: structural line segments (blurred, long, strong: the scale of a moulding, not of a course joint) of the
 *    held-out render and of the photo, inside the held-out region; the symmetric chamfer distance between them (truncated
 *    mean, px at the scoring width). A texture painted one course or a moulding off shows here.
 *  - surface gradient NCC: the blurred luminance gradient magnitude of the render against the photo's over the held-out region.
 *  - clay edges: the layer's own geometry rendered from the pose (its depth steps, creases and silhouette against what lies
 *    past it) against the photo's structural segments (one-sided chamfer, geometry to photo): how well the shape sits on the photo.
 *
 * Lower chamfer and higher NCC are better. Nothing here was fitted to these numbers; the per-layer figure is the pixel-weighted
 * mean over the views that scored. Generic: no threshold names a place.
 */

import type { BakedTexturePlanes, DecodedImage, DepthMap, PinholeCamera, UvAtlas } from '../../../common/spatial/texture-pass-contracts';
import { detectLineSegments, distanceTransform, gaussianBlur, sobel } from '../../spatial/StreetViewPoseRegistrar';

/** Scoring width (px): structural edges survive, course joints blur out (the registration's scale, 900 px, halved for speed). */
export const FIT_METRIC_WIDTH_PX = 640;
/** Chamfer truncation (px at the scoring width). */
export const FIT_CHAMFER_TRUNCATION_PX = 12;
/** Structural edges: blur sigma, least segment length and gradient (the edge registration's photo settings, scaled). */
export const FIT_EDGE_BLUR_PX = 1.5;
export const FIT_EDGE_MIN_LENGTH_PX = 22;
export const FIT_EDGE_MAGNITUDE = 5;
/** Least held-out pixels for a view to score, and least edge pixels per side for a chamfer. */
export const FIT_MIN_PIXELS = 1500;
export const FIT_MIN_EDGE_PIXELS = 40;

export interface FitScoreView { panoId: string; camera: PinholeCamera; image: DecodedImage }

export interface LayerFitInput {
    atlas: UvAtlas;
    /** The layer's final planes: albedo (sRGB8, alpha 255 where coloured), confidence (R = provenance index) and provenance. */
    planes: Pick<BakedTexturePlanes, 'albedo' | 'confidence' | 'provenance'>;
    views: FitScoreView[];
    /** The full scan's depth from a view (camera z, metres; >= 1e8 or Infinity where nothing). */
    depthFor: (view: FitScoreView) => DepthMap;
    widthPx?: number;
    /** At most this many views score (the ones that see most of the layer). Default 24. */
    maxViews?: number;
    signal?: AbortSignal;
    /** Diagnostic: each scored view's render, photo and edge maps at the scoring width (for overlays). */
    debug?: (d: { panoId: string; w: number; h: number; render: Float32Array; held: Uint8Array; photo: Float32Array; renderEdges: Uint8Array; photoEdges: Uint8Array; clayEdges: Uint8Array }) => void;
}

export interface ViewFit {
    panoId: string;
    /** Held-out layer pixels at the scoring width. */
    pixels: number;
    /** Layer pixels made by the view's own pano (not scored). */
    ownPixels: number;
    chamferPx: number | null;
    clayChamferPx: number | null;
    gradNcc: number | null;
}

export interface LayerFit {
    views: ViewFit[];
    scoredViews: number;
    /** Pixel-weighted means over the scoring views (null when none scored). */
    chamferPx: number | null;
    clayChamferPx: number | null;
    gradNcc: number | null;
    /** Held-out pixels over all layer pixels the views see: how much of the layer is judged by a view that did not make it. */
    heldOutShare: number;
    widthPx: number;
    ms: number;
}

const EMPTY = 1e8;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** The camera scaled to at most `maxW` wide (the same field of view). */
export function scaledCamera(cam: PinholeCamera, maxW: number): { cam: PinholeCamera; s: number } {
    if (cam.width <= maxW) return { cam, s: 1 };
    const s = maxW / cam.width;
    const w = maxW, h = Math.max(1, Math.round(cam.height * s));
    return { cam: { ...cam, fx: cam.fx * s, fy: cam.fy * s, cx: cam.cx * s, cy: cam.cy * s, width: w, height: h }, s };
}

/** Box-filtered luminance of an RGBA image at `w` x `h` (a reduction of the same field of view). */
export function reducedLuminance(img: DecodedImage, w: number, h: number): Float32Array {
    const out = new Float32Array(w * h);
    const sx = img.width / w, sy = img.height / h;
    for (let y = 0; y < h; y++) {
        const y0 = Math.floor(y * sy), y1 = Math.min(img.height, Math.max(y0 + 1, Math.floor((y + 1) * sy)));
        for (let x = 0; x < w; x++) {
            const x0 = Math.floor(x * sx), x1 = Math.min(img.width, Math.max(x0 + 1, Math.floor((x + 1) * sx)));
            let s = 0, n = 0;
            for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
                const k = (yy * img.width + xx) * 4;
                s += 0.299 * img.rgba[k] + 0.587 * img.rgba[k + 1] + 0.114 * img.rgba[k + 2]; n++;
            }
            out[y * w + x] = n ? s / n : 0;
        }
    }
    return out;
}

/** Structural edge pixels of a luminance image inside `region` (rasterised line segments: long, strong, at the blur's scale). */
export function structuralEdges(lum: Float32Array, w: number, h: number, region: Uint8Array): Uint8Array {
    const blurred = gaussianBlur(lum, w, h, FIT_EDGE_BLUR_PX);
    const segs = detectLineSegments(blurred, w, h, region, { minLength: FIT_EDGE_MIN_LENGTH_PX, magnitudeThreshold: FIT_EDGE_MAGNITUDE });
    const map = new Uint8Array(w * h);
    for (const s of segs) {
        const len = Math.hypot(s.x1 - s.x0, s.y1 - s.y0), steps = Math.max(1, Math.ceil(len * 2));
        for (let i = 0; i <= steps; i++) {
            const t = i / steps, x = Math.floor(s.x0 + (s.x1 - s.x0) * t), y = Math.floor(s.y0 + (s.y1 - s.y0) * t);
            if (x >= 0 && y >= 0 && x < w && y < h && region[y * w + x]) map[y * w + x] = 1;
        }
    }
    return map;
}

/** Mean of min(DT(edgesTo), T) over the pixels of `from` (inside `region` when given); null below the edge floor. */
export function chamferMean(from: Uint8Array, toDT: Float32Array, region?: Uint8Array): number | null {
    let s = 0, n = 0;
    for (let i = 0; i < from.length; i++) {
        if (!from[i] || (region && !region[i])) continue;
        s += Math.min(FIT_CHAMFER_TRUNCATION_PX, toDT[i]); n++;
    }
    return n >= FIT_MIN_EDGE_PIXELS ? s / n : null;
}

/** NCC of two fields over a mask; null below `minN` samples. */
export function maskedNcc(a: Float32Array, b: Float32Array, mask: Uint8Array, minN = 500): number | null {
    let n = 0, ma = 0, mb = 0;
    for (let i = 0; i < mask.length; i++) if (mask[i]) { ma += a[i]; mb += b[i]; n++; }
    if (n < minN) return null;
    ma /= n; mb /= n;
    let sab = 0, saa = 0, sbb = 0;
    for (let i = 0; i < mask.length; i++) if (mask[i]) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
    return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : null;
}

/** Pixels of `mask` whose 8 neighbours at distance `r` are all in it. */
export function erode(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
    const out = new Uint8Array(w * h);
    for (let y = r; y < h - r; y++) for (let x = r; x < w - r; x++) {
        const i = y * w + x;
        if (!mask[i]) continue;
        if (mask[i - r] && mask[i + r] && mask[i - r * w] && mask[i + r * w] && mask[i - r * w - r] && mask[i - r * w + r] && mask[i + r * w - r] && mask[i + r * w + r]) out[i] = 1;
    }
    return out;
}

const SRGB_LUM = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

interface LayerRender {
    w: number; h: number;
    /** Layer depth (camera z) per pixel, Infinity where the layer does not show. */
    z: Float32Array;
    /** Texel shown per pixel, -1 where none. */
    texel: Int32Array;
    /** 1 where the shown texel is held out (its provenance does not name the view's pano). */
    held: Uint8Array;
    lum: Float32Array;
    own: number;
    scan: Float32Array;
}

/** Splats the layer's coloured texels into the scaled view (z-buffered, the full scan in front of them hides them). */
function renderLayer(input: LayerFitInput, view: FitScoreView, cam: PinholeCamera, s: number, ownEntry: Uint8Array): LayerRender {
    const { atlas, planes } = input;
    const W = cam.width, H = cam.height, n = atlas.width * atlas.height;
    const { covered, gutter, position, normal, sizeM } = atlas.texels;
    const depth = input.depthFor(view);
    const scan = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const fx = Math.min(depth.width - 1, Math.floor((x + 0.5) / s)), fy = Math.min(depth.height - 1, Math.floor((y + 0.5) / s));
        const d = depth.depthM[fy * depth.width + fx];
        scan[y * W + x] = Number.isFinite(d) && d < EMPTY ? d : Infinity;
    }
    const z = new Float32Array(W * H).fill(Infinity), texel = new Int32Array(W * H).fill(-1), best = new Float32Array(W * H).fill(Infinity);
    // texel stride: about one splat per pixel (a texel much smaller than a pixel is sampled, its footprint widened)
    let foot = 0, nf = 0;
    for (let t = 0; t < n && nf < 4000; t += Math.max(1, Math.floor(n / 4000))) {
        if (!covered[t] || gutter[t]) continue;
        const o = t * 3;
        const dz = (position[o] - cam.eye[0]) * cam.fwd[0] + (position[o + 1] - cam.eye[1]) * cam.fwd[1] + (position[o + 2] - cam.eye[2]) * cam.fwd[2];
        if (dz > 0.5) { foot += (sizeM[t] * cam.fx) / dz; nf++; }
    }
    const meanFoot = nf ? foot / nf : 1;
    const k = Math.max(1, Math.floor(0.7 / Math.max(1e-6, meanFoot)));
    const aw = atlas.width;
    for (let ty = 0; ty < atlas.height; ty += k) for (let tx = 0; tx < aw; tx += k) {
        const t = ty * aw + tx;
        if (!covered[t] || gutter[t] || planes.albedo[t * 4 + 3] === 0) continue;
        const o = t * 3;
        const dx = position[o] - cam.eye[0], dy = position[o + 1] - cam.eye[1], dzz = position[o + 2] - cam.eye[2];
        const zc = dx * cam.fwd[0] + dy * cam.fwd[1] + dzz * cam.fwd[2];
        if (zc <= 0.5) continue;
        const dist = Math.hypot(dx, dy, dzz);
        const cos = -(normal[o] * dx + normal[o + 1] * dy + normal[o + 2] * dzz) / dist;
        if (cos < 0.05) continue;
        const px = cam.cx + (cam.fx * (dx * cam.right[0] + dy * cam.right[1] + dzz * cam.right[2])) / zc;
        const py = cam.cy - (cam.fy * (dx * cam.up[0] + dy * cam.up[1] + dzz * cam.up[2])) / zc;
        if (!(px >= 0 && py >= 0 && px < W && py < H)) continue;
        const r = Math.max(0, Math.min(6, Math.ceil((k * sizeM[t] * cam.fx) / zc / 2 - 0.5)));
        const x0 = Math.max(0, Math.floor(px) - r), x1 = Math.min(W - 1, Math.floor(px) + r), y0 = Math.max(0, Math.floor(py) - r), y1 = Math.min(H - 1, Math.floor(py) + r);
        // z-buffer; on the same surface (within a depth tolerance) the texel whose centre is nearest the pixel's wins, so an
        // edge in the texture is not ragged by the splat order
        const tolZ = 0.01 * zc + 0.03;
        for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) {
            const i = yy * W + xx;
            const d2 = (xx + 0.5 - px) ** 2 + (yy + 0.5 - py) ** 2;
            if (zc < z[i] - tolZ) { z[i] = zc; texel[i] = t; best[i] = d2; } else if (zc <= z[i] + tolZ && d2 < best[i]) { z[i] = Math.min(z[i], zc); texel[i] = t; best[i] = d2; }
        }
    }
    const held = new Uint8Array(W * H), lum = new Float32Array(W * H);
    let own = 0;
    for (let i = 0; i < W * H; i++) {
        const t = texel[i];
        if (t < 0) continue;
        // the full scan in front of the layer hides it (a statue, a tree, a nearer wall)
        const zs = scan[i];
        if (zs < z[i] - (0.25 + 0.02 * z[i])) { texel[i] = -1; z[i] = Infinity; continue; }
        lum[i] = SRGB_LUM(planes.albedo[t * 4], planes.albedo[t * 4 + 1], planes.albedo[t * 4 + 2]);
        if (ownEntry[planes.confidence.data[t * 4]]) own++; else held[i] = 1;
    }
    return { w: W, h: H, z, texel, held, lum, own, scan };
}

/** Geometry edges of the layer render: depth steps, creases (normals), and the silhouette against what lies past it. */
function geometryEdges(r: LayerRender, atlas: UvAtlas): Uint8Array {
    const { w, h, z, texel, scan } = r;
    const nrm = atlas.texels.normal;
    const out = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (texel[i] < 0) continue;
        for (const j of [i + 1, i + w, i - 1, i - w]) {
            if (texel[j] < 0) {
                // the layer's own outline only where the camera sees past it there (not where another layer continues it)
                if (!(scan[j] < Infinity) || scan[j] > z[i] * 1.03 + 0.3) { out[i] = 1; break; }
                continue;
            }
            if (Math.abs(z[j] - z[i]) > 0.03 * z[i] + 0.15) { if (z[i] < z[j]) { out[i] = 1; break; } continue; }
            const a = texel[i] * 3, b = texel[j] * 3;
            const c = nrm[a] * nrm[b] + nrm[a + 1] * nrm[b + 1] + nrm[a + 2] * nrm[b + 2];
            if (c < 0.82) { out[i] = 1; break; } // > ~35 degrees
        }
    }
    return out;
}

/** The layer's held-out fit against the views (see the file comment). */
export function measureLayerFit(input: LayerFitInput): LayerFit {
    const t0 = Date.now();
    const maxW = input.widthPx ?? FIT_METRIC_WIDTH_PX;
    const prov = input.planes.provenance;
    const out: ViewFit[] = [];
    const tasks = input.views.map(v => ({ v, ...scaledCamera(v.camera, maxW) }));
    const renders: Array<{ v: FitScoreView; cam: PinholeCamera; r: LayerRender }> = [];
    for (const { v, cam, s } of tasks) {
        if (input.signal?.aborted) break;
        const own = new Uint8Array(256);
        prov.forEach((p, i) => { if (i < 256 && p.panoIds?.includes(v.panoId)) own[i] = 1; });
        const r = renderLayer(input, v, cam, s, own);
        let held = 0; for (let i = 0; i < r.held.length; i++) held += r.held[i];
        if (held + r.own > 0) renders.push({ v, cam, r });
    }
    renders.sort((a, b) => sumOf(b.r.held) - sumOf(a.r.held));
    let heldAll = 0, seenAll = 0;
    for (const { v, cam, r } of renders.slice(0, input.maxViews ?? 24)) {
        const W = cam.width, H = cam.height;
        const held = sumOf(r.held);
        heldAll += held; seenAll += held + r.own;
        const base: ViewFit = { panoId: v.panoId, pixels: held, ownPixels: r.own, chamferPx: null, clayChamferPx: null, gradNcc: null };
        if (held < FIT_MIN_PIXELS) { out.push(base); continue; }
        const photo = reducedLuminance(v.image, W, H);
        const region = erode(r.held, W, H, 2);
        const any = new Uint8Array(W * H);
        for (let i = 0; i < any.length; i++) if (r.texel[i] >= 0) any[i] = 1;
        const near = new Uint8Array(W * H);
        const dtAny = distanceTransform(any, W, H, 8);
        for (let i = 0; i < near.length; i++) if (dtAny[i] <= 6) near[i] = 1;
        // texture edges, both ways, scored inside the held-out region: the render's segments are found on its held-out texels
        // only, the photo's around the whole layer (so a segment the region boundary cuts is not cut short on one side alone)
        const eR = structuralEdges(r.lum, W, H, r.held), eP = structuralEdges(photo, W, H, near);
        const dtP = distanceTransform(eP, W, H, FIT_CHAMFER_TRUNCATION_PX + 1), dtR = distanceTransform(eR, W, H, FIT_CHAMFER_TRUNCATION_PX + 1);
        const a = chamferMean(eR, dtP, region), b = chamferMean(eP, dtR, region);
        const chamferPx = a !== null && b !== null ? r3((a + b) / 2) : null;
        // gradient agreement over the held-out surface
        const gR = sobel(gaussianBlur(r.lum, W, H, 1.5), W, H).mag, gP = sobel(gaussianBlur(photo, W, H, 1.5), W, H).mag;
        const g = maskedNcc(gR, gP, erode(r.held, W, H, 4));
        // clay: the layer's geometry edges against the photo's structural edges (around the whole layer render)
        const gE = geometryEdges(r, input.atlas);
        const clay = chamferMean(gE, dtP);
        input.debug?.({ panoId: v.panoId, w: W, h: H, render: r.lum, held: r.held, photo, renderEdges: eR, photoEdges: eP, clayEdges: gE });
        out.push({ ...base, chamferPx, clayChamferPx: clay === null ? null : r3(clay), gradNcc: g === null ? null : r3(g) });
    }
    const wmean = (pick: (v: ViewFit) => number | null): number | null => {
        let s = 0, n = 0;
        for (const v of out) { const x = pick(v); if (x === null) continue; s += x * v.pixels; n += v.pixels; }
        return n ? r3(s / n) : null;
    };
    return {
        views: out, scoredViews: out.filter(v => v.chamferPx !== null || v.gradNcc !== null).length,
        chamferPx: wmean(v => v.chamferPx), clayChamferPx: wmean(v => v.clayChamferPx), gradNcc: wmean(v => v.gradNcc),
        heldOutShare: seenAll ? r3(heldAll / seenAll) : 0, widthPx: maxW, ms: Date.now() - t0
    };
}

function sumOf(a: Uint8Array): number { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s; }

/** The fit in words for the stage panel. */
export function describeLayerFit(f: LayerFit): string {
    const v = (x: number | null, u = '') => (x === null ? 'n/a' : `${x.toFixed(2)}${u}`);
    return `held-out fit over ${f.scoredViews} views: texture edge chamfer ${v(f.chamferPx, ' px')}, clay edge chamfer ${v(f.clayChamferPx, ' px')}, surface gradient NCC ${v(f.gradNcc)} (${Math.round(f.heldOutShare * 100)}% of the seen layer held out)`;
}
