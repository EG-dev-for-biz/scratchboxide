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
    /** Huber threshold (CIE76 Delta E) and the view count it starts at. Default 10 and 3. */
    huberDeltaE?: number;
    huberMinViews?: number;
    /** Gaussian sigmas (texels) between the 4 bands of the seam blend. Default [1, 2, 4]. Empty disables the band blend. */
    bandSigmasTexels?: number[];
    /** Relative per-view exposure gains. Default true. */
    exposure?: boolean;
    /** Palette gate distance (CIEDE2000). Default 6. */
    paletteGateDeltaE?: number;
    /** Solar de-lighting and shadow lift; off unless given (a place is never assumed). */
    delight?: ProjectionDelightOptions;
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
export function poseSigmaTerm(poseSigmaPx: number, z: number, gsdM: number): number {
    const sigmaM = (poseSigmaPx / Math.max(1, z)) * gsdM;
    if (!Number.isFinite(sigmaM)) return 0;
    return 1 / (1 + (sigmaM / POSE_SIGMA_SCALE_M) ** 2);
}

interface RawSamples { texel: number[]; rgb: number[]; logW: number[]; wAbs: number[] }

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
    'featherPx' | 'minCosIncidence' | 'depthToleranceBaseM' | 'depthTolerancePerMeter' | 'edgeGuardPx'>>): RawSamples {
    const { atlas } = input;
    const cam = view.camera;
    const out: RawSamples = { texel: [], rgb: [], logW: [], wAbs: [] };
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
        // depth-edge guard: the occluder depth at +-g px must be where the texel's own tangent plane predicts it
        // (so a steeply tilted wall is not an edge, and a thing standing proud of it is, whatever the angle)
        const cHas = dc < EMPTY_DEPTH;
        const nP = normal[o] * dx + normal[o + 1] * dy + normal[o + 2] * dz; // n . (P - eye)
        let edge = false;
        for (const [ex, ey] of EDGE_PROBES) {
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
    }
    return out;
}

/** Separable Gaussian of `fields` (each n long) weighted by `mask`, never mixing texels of different atlas maps. Returns blurred fields and blurred mask. */
function blurWithinMaps(fields: Float64Array[], mask: Float64Array, sigma: number, W: number, H: number, mapIndex: Uint16Array, covered: Uint8Array): { f: Float64Array[]; m: Float64Array } {
    const r = Math.max(1, Math.ceil(3 * sigma));
    const k = new Float64Array(2 * r + 1);
    for (let i = -r; i <= r; i++) k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
    const n = W * H;
    const pass = (src: Float64Array[], srcM: Float64Array, horizontal: boolean): { f: Float64Array[]; m: Float64Array } => {
        const f = src.map(() => new Float64Array(n));
        const m = new Float64Array(n);
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const i = y * W + x;
                if (!covered[i]) continue;
                const mi = mapIndex[i];
                let sm = 0;
                const acc = new Float64Array(src.length);
                for (let d = -r; d <= r; d++) {
                    const xx = horizontal ? x + d : x, yy = horizontal ? y : y + d;
                    if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
                    const j = yy * W + xx;
                    if (!covered[j] || mapIndex[j] !== mi) continue;
                    const w = k[d + r];
                    sm += w * srcM[j];
                    for (let c = 0; c < src.length; c++) acc[c] += w * src[c][j];
                }
                m[i] = sm;
                for (let c = 0; c < src.length; c++) f[c][i] = acc[c];
            }
        }
        return { f, m };
    };
    const pre = fields.map((fl) => { const o = new Float64Array(n); for (let i = 0; i < n; i++) o[i] = fl[i] * mask[i]; return o; });
    const h = pass(pre, mask, true);
    return pass(h.f, h.m, false);
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
        edgeGuardPx: o.edgeGuardPx ?? 3
    };
    const huberK = o.huberDeltaE ?? 10, huberMin = o.huberMinViews ?? 3;
    const bandSigmas = o.bandSigmasTexels ?? [1, 2, 4];
    const { atlas, views } = input;
    const W = atlas.width, H = atlas.height, n = W * H;
    const { covered, gutter, mapIndex, normal } = atlas.texels;
    const degradations: TexturePassDegradation[] = [];
    let targetTexels = 0, coveredTexels = 0;
    for (let t = 0; t < n; t++) { if (covered[t]) coveredTexels++; if (covered[t] && !gutter[t]) targetTexels++; }

    // ---- 1-3: project every view ------------------------------------------------------------------------------
    const raw: RawSamples[] = [];
    for (const view of views) {
        checkAbort(input.signal);
        if (!(view.poseQuality > 0)) {
            degradations.push({ stage: 'bake-projection', reasonCode: 'pano_set_aside', layerKey: atlas.layerKey,
                reason: `Pano ${view.panoId} has no usable registered pose (pose quality 0), so it was not projected.` });
            raw.push({ texel: [], rgb: [], logW: [], wAbs: [] });
            continue;
        }
        const s = projectView(input, view, input.depthFor(view), opts);
        if (!s.texel.length) {
            degradations.push({ stage: 'bake-projection', reasonCode: 'pano_sees_nothing', layerKey: atlas.layerKey,
                reason: `Pano ${view.panoId} sees none of this layer's texels unoccluded at a usable angle.` });
        }
        raw.push(s);
    }
    timingsMs.project = Date.now() - t0;

    const samples: ViewSamples[] = raw.map((r) => ({ texel: Int32Array.from(r.texel), rgb: Float32Array.from(r.rgb) }));
    const logW = raw.map((r) => Float64Array.from(r.logW));
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

    // ---- 6b: 4-band seam blend of each view's residual against the mean -----------------------------------------
    const final = Float64Array.from(mean);
    let multiViewTexels = 0;
    for (let t = 0; t < n; t++) if (index.start[t + 1] - index.start[t] >= 2) multiViewTexels++;
    if (bandSigmas.length && multiViewTexels > 0) {
        const bands = bandSigmas.length + 1;
        const num = Array.from({ length: bands }, () => new Float64Array(n * 3));
        const den = Array.from({ length: bands }, () => new Float64Array(n));
        const ones = new Float64Array(n);
        for (let t = 0; t < n; t++) ones[t] = covered[t] ? 1 : 0;
        const coveredMask = covered;
        samples.forEach((s, k) => {
            checkAbort(input.signal);
            if (!s.texel.length) return;
            const M = new Float64Array(n);
            const Dr = new Float64Array(n), Dg = new Float64Array(n), Db = new Float64Array(n), Wk = new Float64Array(n);
            for (let i = 0; i < s.texel.length; i++) {
                const t = s.texel[i];
                M[t] = 1;
                Dr[t] = s.rgb[i * 3] - mean[t * 3]; Dg[t] = s.rgb[i * 3 + 1] - mean[t * 3 + 1]; Db[t] = s.rgb[i * 3 + 2] - mean[t * 3 + 2];
            }
            for (let t = 0; t < n; t++) {
                const a = index.start[t], b = index.start[t + 1];
                for (let p = a; p < b; p++) if (index.view[p] === k) { Wk[t] = index.weight[p]; break; }
            }
            // Gaussian stack of the residual (normalised over the view's support) and of the weight (over the atlas map)
            const gD: Float64Array[][] = [[Dr, Dg, Db]];
            const gW: Float64Array[] = [Wk];
            for (const sg of bandSigmas) {
                const bd = blurWithinMaps([Dr, Dg, Db], M, sg, W, H, mapIndex, coveredMask);
                gD.push(bd.f.map((f) => { const out = new Float64Array(n); for (let t = 0; t < n; t++) out[t] = bd.m[t] > 1e-12 ? f[t] / bd.m[t] : 0; return out; }));
                const bw = blurWithinMaps([Wk], ones, sg, W, H, mapIndex, coveredMask);
                const out = new Float64Array(n);
                for (let t = 0; t < n; t++) out[t] = bw.m[t] > 1e-12 ? bw.f[0][t] / bw.m[t] : 0;
                gW.push(out);
            }
            for (let i = 0; i < s.texel.length; i++) {
                const t = s.texel[i];
                for (let bnd = 0; bnd < bands; bnd++) {
                    const w = gW[bnd][t];
                    if (!(w > 0)) continue;
                    for (let c = 0; c < 3; c++) {
                        const band = bnd < bands - 1 ? gD[bnd][c][t] - gD[bnd + 1][c][t] : gD[bnd][c][t];
                        num[bnd][t * 3 + c] += w * band;
                    }
                    den[bnd][t] += w;
                }
            }
        });
        for (let t = 0; t < n; t++) {
            if (index.start[t + 1] - index.start[t] < 2) continue;
            for (let bnd = 0; bnd < bands; bnd++) {
                if (!(den[bnd][t] > 0)) continue;
                for (let c = 0; c < 3; c++) final[t * 3 + c] += num[bnd][t * 3 + c] / den[bnd][t];
            }
        }
    }
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
        dominant[t] = best;
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
            ...(delightReport ? { delight: delightReport } : {}),
            views: views.map((v, k) => ({ panoId: v.panoId, samples: samples[k].texel.length, gain: gains[k], anchor: anchors.has(k), paletteGate: gateReports[k], solarDelit: solarDelit[k] }))
        }
    };
}

