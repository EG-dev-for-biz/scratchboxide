/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Street View texture fusion (plan E9-E10).
 *
 * Projects registered street-level photo plates onto a textured mesh through
 * SurveyTextureUnprojector (original per-primitive UVs, depth-tested, robustly blended), then
 * fuses the projection with the mesh's own baseColor texture in linear RGB:
 *
 *   T    = original baseColor, bicubic-upsampled by the primitive scale s
 *   S    = Street View accumulation (weighted mean of plate samples)
 *   G_t  = normalised-convolution Gaussian over observed texels at the tile's own blur (sigma estimated per
 *          primitive as the blur of S that best correlates with T)
 *   D_f  = clamp(S / G_t(S), 0.35, 2.2) per channel: the detail the tile cannot show (a ratio: invariant to
 *          per-frame exposure / white balance)
 *   out  = T * (1 + c (D_f - 1))      (detailMode 'fine', default)
 *
 * Every band the tile resolves stays the tile's, so the fusion cannot soften it or shift its colour; the plan's
 * ratio transfer out = c L(T) D + (1 - c) T with D = S / L(S) is kept as detailMode 'ratio'.
 *
 * c = evidence(sum of view weights) * incidence * poseQuality * resolutionGain * region * detailEnergy * feather,
 * so texels the photos do not resolve better than the tile keep the tile texture: detailEnergy keeps the tile
 * wherever the photo's local detail (RMS of log S / L(S)) is not stronger than the tile's own (RMS of log T / L(T)),
 * so the fusion never softens the tile; region restricts it to a caller's area (e.g. a hero footprint).
 * Unobserved texels keep T exactly (never a default colour). An image is replaced only when its fused texture is
 * sharper than the tile on the confident texels (Laplacian variance gain >= minTextureSharpnessGain); every other
 * image keeps its original bytes. Plate pixels near depth discontinuities are dropped (pixel and object-space
 * guards). Replaced images are JPEG with exact JFIF colour (no re-encode colour shift). KHR_materials_unlit is
 * preserved, touched materials are forced non-metallic, and orphaned images / textures / buffer views are removed.
 *
 * Generic: any GLB with per-primitive TEXCOORD_0 baseColor textures and identity node transforms.
 * No location-specific constants live here; every threshold is an option.
 */

import * as fs from 'fs-extra';
import * as path from 'path';
import { AlgorithmicUvEngine } from './AlgorithmicUvEngine';
import {
    SurveyTextureUnprojector,
    type MeshPrimitiveData,
    type PreparedCamera,
    type RobustReweightingOptions,
    type StationPlate,
    type SurveyTextureUnprojectorOptions
} from './SurveyTextureUnprojector';
import { EMPTY_DEPTH } from './SurveyStationRenderService';
import { decodeImageToRgba, encodeRgbaToJpeg } from '../image-codec-ffmpeg';
import { encodePng } from '../texture-processing';

export interface StreetViewTextureFusionOptions {
    /** Where to write the fused GLB (directories are created). */
    outGlbPath?: string;
    /** Upper bound for the per-primitive atlas scale s (power of two). Default 4. */
    maxScale?: number;
    /** Minimum incidence cosine for a plate sample. Default 0.3. */
    minCosIncidence?: number;
    /** Absolute depth-test tolerance in metres. Default 0.25. */
    depthTolerance?: number;
    /** Relative depth-test tolerance (fraction of camera depth). Default 0.015. */
    depthRelativeTolerance?: number;
    /** Exponent gamma of the cos^gamma view score. Default 2. */
    angleWeightExponent?: number;
    /** Robust IRLS Huber re-weighting (default: enabled, >= 3 observations, Delta-E 10). Pass false to disable. */
    robust?: RobustReweightingOptions | false;
    /**
     * Sum of raw view weights (cos^(2 gamma) / distance) at which evidence saturates. Default 0.0005
     * (one view at cos 0.5 from 125 m). Incidence and distance are also judged by cosRange and
     * resolutionGainRange, so this only guards against near-zero evidence.
     */
    weightFull?: number;
    /** Incidence-cosine ramp for confidence. Default [0.3, 0.5]. */
    cosRange?: [number, number];
    /** Ramp of (tile texel size / plate pixel footprint) for confidence. Default [1, 2]. */
    resolutionGainRange?: [number, number];
    /**
     * Feather width from the observation edge, in source-texture texels (multiplied by s). Default 4.
     * The ratio transfer keeps the tile's low band, so an edge only changes detail level: on the ESB
     * pilot 4 texels kept the seam-band low-pass CIEDE2000 at 0.36 mean (8 texels: 0.27) while adding
     * 38% confident area.
     */
    featherTexels?: number;
    /**
     * Low-pass sigma in source-texture texels (multiplied by s). Default 3. The tile keeps only this low band
     * where the photo is used; at 1.5 texels the tile's window grid (period 3-6 texels) survived at 7-17 %
     * amplitude and ghosted against photo detail registered half a texel off.
     */
    lowPassSigmaTexels?: number;
    /** Clamp for the detail ratio D. Default [0.35, 2.2]. */
    detailClamp?: [number, number];
    /**
     * Which photo band is transferred (default 'fine'):
     *   'fine'  : out = T (1 + c (D_f - 1)), D_f = clamp(S / G_t(S)) with G_t the photo blurred to the tile's own
     *             resolution (sigma estimated per primitive, see tileBlurSigmaCandidates). Only detail the tile cannot
     *             show is added; every band the tile resolves stays the tile's, so the result is never softer than the
     *             tile and its colour, low band and seams are unchanged.
     *   'ratio' : the plan's ratio transfer out = c L(T) D + (1 - c) T, D = clamp(S / L(S)), L at lowPassSigmaTexels:
     *             the photo replaces every band above L, including bands where its contrast may be lower than the tile's.
     */
    detailMode?: 'fine' | 'ratio';
    /**
     * Candidate tile blur sigmas (source texels) for detailMode 'fine'; per primitive the one whose blurred photo
     * correlates best with the tile is used. Default [0.5, 0.75, 1, 1.5, 2].
     */
    tileBlurSigmaCandidates?: number[];
    /**
     * detailMode 'ratio' only. 'tile' (default): out = c L(T) D + (1-c) T.
     * 'streetview-harmonized': per-primitive Lab mean/std transfer of S onto T, out = c S' + (1-c) T.
     */
    lowBand?: 'tile' | 'streetview-harmonized';
    /**
     * Optional de-light of the tile low band L(T) before fusion (plan E11, default false): sRGB
     * Rec.601 luma l < 0.45 is lifted by 1 + 0.38 ((0.45 - l) / 0.45)^2, as in the committed
     * pbr_texture_batch shadow lift. Applies only where c > 0, so it raises the seam Delta-E.
     */
    lowBandShadowLift?: boolean;
    /** JPEG quality for replaced images. Default 92. */
    jpegQuality?: number;
    /** JPEG chroma subsampling of replaced images. Default '444' (photo detail is mostly chroma-edged). */
    jpegChroma?: '420' | '444';
    /**
     * Detail-energy gate (default off; e.g. [1, 1.4]): the photo's detail is used only where its local
     * detail energy (RMS of log(S / L(S)) over ~2 source texels) exceeds the tile's (RMS of log(T / L(T))), with
     * c ramping from 0 at ratio [0] to full at ratio [1]. Where the photo resolves less than the tile
     * (foreshortening, distance, blending) the tile is kept, so the fusion never softens the tile.
     */
    detailEnergyGate?: [number, number] | false;
    /**
     * A primitive's image is replaced only when the fused texture's Laplacian variance over its c >= 0.5 texels is
     * at least this multiple of the bicubic tile's. Default 1.1.
     */
    minTextureSharpnessGain?: number;
    /**
     * Per-texel region test on the texel's world position and face normal (e.g. a hero footprint): texels that
     * fail get c = 0 and keep the tile. Default: every texel.
     */
    texelFilter?: (x: number, y: number, z: number, nx: number, ny: number, nz: number) => boolean;
    /** Output size budget in bytes. Default 45,000,000. */
    maxOutputBytes?: number;
    /**
     * A primitive's image is replaced only if at least this many source-resolution texels reach
     * c >= 0.5 (atlas count / s^2). Re-encoding a whole image for a few texels only adds JPEG
     * generation loss. Default 16.
     */
    minConfidentSourceTexels?: number;
    /**
     * Per-plate exposure / white-balance normalisation (default true): each plate gets a linear gain
     * from the robust median of tile / plate colour over its visible survey samples (plate samples
     * box-averaged to the tile texel footprint), normalised to a geometric mean of 1 and applied in
     * float at sample time (StationPlate.linearGain). Keeps overlapping plates consistent for
     * blending and robust weighting; the detail ratio D is unaffected by a per-plate gain.
     */
    exposureNormalization?: boolean;
    /**
     * Depth-discontinuity guard (default 0 = off): plate pixels within this many pixels of a silhouette or a
     * depth jump (relative step > depthEdgeRelativeJump) are excluded (depth = EMPTY_DEPTH) on a copy of each
     * plate's depth, so a residual registration error of a pixel or two cannot smear sky or a nearer surface
     * across a building edge. 3 px removed visible edge halos on the ESB pilot.
     */
    depthEdgeGuardPx?: number;
    /** Relative depth step treated as a discontinuity by the guard. Default 0.04. */
    depthEdgeRelativeJump?: number;
    /**
     * Object-space guard (default 0 = off): around each discontinuity at least this distance on the surface is
     * excluded (radius = metres x focal px / depth), so pose residuals of a few decimetres cannot paint one surface's
     * pixels onto the next one at near range, where a fixed pixel band is too thin.
     */
    depthEdgeGuardMeters?: number;
    /** Restrict fusion to some primitives (e.g. a hero footprint). Default: all. */
    primitiveFilter?: (primitiveIndex: number, primitive: MeshPrimitiveData) => boolean;
    /** Gutter bleed of fused texels into non-chart texels, in source texels (multiplied by s). Default 2. */
    gutterBleedTexels?: number;
    /** Extra SurveyTextureUnprojector options (applied last; for tests and diagnostics). */
    unprojectorOverrides?: Partial<SurveyTextureUnprojectorOptions>;
    /** Attach per-texel confidence / world-position maps to each primitive report (memory heavy). */
    returnConfidenceMaps?: boolean;
    /** Write per-primitive debug PNGs (confidence, tile, fused) into this directory. */
    debugDir?: string;
    /** Progress logger. Default: silent. */
    log?: (message: string) => void;
}

export interface StreetViewTextureFusionRequest {
    /** Input GLB path (raw tile or rectified textured base; any GLB in the plates' frame). */
    glbPath?: string;
    /** Input GLB bytes (alternative to glbPath). */
    glbBuffer?: Buffer;
    /** Registered plates: photo RGBA, camera-z depth (EMPTY_DEPTH = masked), pose, optional poseQuality. */
    plates: StationPlate[];
    options?: StreetViewTextureFusionOptions;
}

export interface FusedPrimitiveReport {
    primitiveIndex: number;
    materialIndex?: number;
    imageIndex?: number;
    sourceWidth: number;
    sourceHeight: number;
    scale: number;
    width: number;
    height: number;
    chartTexels: number;
    observedTexels: number;
    affectedTexels: number;
    confidentTexels: number;
    maxConfidence: number;
    /** Surface area of the primitive's UV charts (m^2). */
    chartAreaM2: number;
    observedAreaM2: number;
    /** Surface area with c >= 0.5 (m^2). */
    confidentAreaM2: number;
    /** Mean / p95 CIEDE2000 between low-passed output and low-passed tile in the seam band. */
    seamDeltaE00Mean: number;
    seamDeltaE00P95: number;
    seamBandTexels: number;
    /** Texture-space Laplacian variance of the output over the bicubic tile, on texels with c >= 0.5. */
    textureSharpnessGain: number;
    /**
     * Chart texels equal to the unprojector default colour (+-2) in the output. Must be 0. Measured
     * only when `unprojectorOverrides.defaultColor` is set (use a colour absent from the scene).
     */
    defaultColorTexels: number;
    /** detailMode 'fine': tile blur (source texels) chosen for the detail split, with its NCC against the tile. */
    tileBlurSigmaTexels?: number;
    tileBlurNcc?: number;
    /** Area-weighted mean of each confidence factor over observed texels (diagnostics for tuning). */
    confidenceFactors: { evidence: number; incidence: number; poseQuality: number; resolutionGain: number; feather: number; detailEnergy?: number; region?: number };
    replaced: boolean;
    skippedReason?: string;
    outputImageBytes?: number;
    /** Present with options.returnConfidenceMaps. */
    maps?: {
        /** Atlas size of the maps (the fusion size; a budget downscale of the image does not change it). */
        width: number;
        height: number;
        confidence: Float32Array;
        worldPositions: Float32Array;
        worldNormals: Float32Array;
        texelSizeMeters: Float32Array;
        coverage: Uint8Array;
    };
}

export interface StreetViewTextureFusionResult {
    glbBuffer: Buffer;
    outGlbPath?: string;
    bytes: number;
    primitives: FusedPrimitiveReport[];
    imagesReplaced: number;
    imagesRemoved: number;
    texturesRemoved: number;
    bufferViewsRemoved: number;
    budgetDownscales: number;
    /** Per-plate exposure gains applied (linear RGB, geometric mean 1; 1 when off). `plate` indexes request.plates. */
    plateExposure: Array<{ plate: number; samples: number; gain: [number, number, number] }>;
    totals: {
        chartAreaM2: number;
        observedAreaM2: number;
        confidentAreaM2: number;
        seamDeltaE00Mean: number;
        defaultColorTexels: number;
    };
    durationMs: number;
}

interface PrimitiveSlot {
    primitive: MeshPrimitiveData;
    meshIndex: number;
    primInMesh: number;
    /** glTF primitive mode (4 = TRIANGLES). */
    mode: number;
}

interface PendingImage {
    report: FusedPrimitiveReport;
    rgba: Buffer;
    width: number;
    height: number;
    jpeg: Buffer;
    scale: number;
}

const DEFAULTS = {
    maxScale: 4,
    minCosIncidence: 0.3,
    depthTolerance: 0.25,
    depthRelativeTolerance: 0.015,
    angleWeightExponent: 2,
    weightFull: 0.0005,
    cosRange: [0.3, 0.5] as [number, number],
    resolutionGainRange: [1, 2] as [number, number],
    featherTexels: 4,
    lowPassSigmaTexels: 3,
    detailClamp: [0.35, 2.2] as [number, number],
    jpegQuality: 92,
    jpegChroma: '444' as '420' | '444',
    detailEnergyGate: false as [number, number] | false,
    tileBlurSigmaCandidates: [0.5, 0.75, 1, 1.5, 2],
    minTextureSharpnessGain: 1.1,
    maxOutputBytes: 45_000_000,
    minConfidentSourceTexels: 16,
    gutterBleedTexels: 2
};

// ---------------------------------------------------------------------------------------------
// Colour helpers
// ---------------------------------------------------------------------------------------------

const SRGB8_TO_LINEAR = (() => {
    const lut = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
        const c = i / 255;
        lut[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    }
    return lut;
})();

/** sRGB (0..255 scale, may exceed 255 for gained samples) to linear; not clamped above. */
function srgbToLinear(v255: number): number {
    const c = Math.max(0, v255 / 255);
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linearToSrgb8(v: number): number {
    const c = v <= 0 ? 0 : v >= 1 ? 1 : v;
    const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    return Math.round(s * 255);
}

function linearToLab(r: number, g: number, b: number, out: Float64Array, o: number): void {
    const X = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
    const Y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b;
    const Z = (0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / 1.08883;
    const f = (t: number): number => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
    const fx = f(Math.max(0, X)), fy = f(Math.max(0, Y)), fz = f(Math.max(0, Z));
    out[o] = 116 * fy - 16;
    out[o + 1] = 500 * (fx - fy);
    out[o + 2] = 200 * (fy - fz);
}

function labToLinear(L: number, a: number, b: number): [number, number, number] {
    const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
    const inv = (f: number): number => { const f3 = f * f * f; return f3 > 216 / 24389 ? f3 : (116 * f - 16) / (24389 / 27); };
    const X = inv(fx) * 0.95047, Y = inv(fy), Z = inv(fz) * 1.08883;
    return [
        3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z,
        -0.9692660 * X + 1.8760108 * Y + 0.0415560 * Z,
        0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z
    ];
}

/** CIEDE2000 colour difference between two Lab colours. */
export function deltaE2000(L1: number, a1: number, b1: number, L2: number, a2: number, b2: number): number {
    const deg = Math.PI / 180;
    const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2);
    const Cb = (C1 + C2) / 2;
    const Cb7 = Math.pow(Cb, 7);
    const G = 0.5 * (1 - Math.sqrt(Cb7 / (Cb7 + Math.pow(25, 7))));
    const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
    const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
    const h = (bb: number, ap: number): number => {
        if (bb === 0 && ap === 0) return 0;
        const v = Math.atan2(bb, ap) / deg;
        return v < 0 ? v + 360 : v;
    };
    const h1p = h(b1, a1p), h2p = h(b2, a2p);
    const dLp = L2 - L1, dCp = C2p - C1p;
    let dhp = 0;
    if (C1p * C2p !== 0) {
        dhp = h2p - h1p;
        if (dhp > 180) dhp -= 360; else if (dhp < -180) dhp += 360;
    }
    const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * deg);
    const Lbp = (L1 + L2) / 2, Cbp = (C1p + C2p) / 2;
    let hbp = h1p + h2p;
    if (C1p * C2p !== 0) {
        if (Math.abs(h1p - h2p) > 180) hbp = h1p + h2p < 360 ? hbp + 360 : hbp - 360;
        hbp /= 2;
    }
    const T = 1 - 0.17 * Math.cos((hbp - 30) * deg) + 0.24 * Math.cos(2 * hbp * deg)
        + 0.32 * Math.cos((3 * hbp + 6) * deg) - 0.20 * Math.cos((4 * hbp - 63) * deg);
    const dTheta = 30 * Math.exp(-Math.pow((hbp - 275) / 25, 2));
    const Cbp7 = Math.pow(Cbp, 7);
    const Rc = 2 * Math.sqrt(Cbp7 / (Cbp7 + Math.pow(25, 7)));
    const Sl = 1 + (0.015 * Math.pow(Lbp - 50, 2)) / Math.sqrt(20 + Math.pow(Lbp - 50, 2));
    const Sc = 1 + 0.045 * Cbp, Sh = 1 + 0.015 * Cbp * T;
    const Rt = -Math.sin(2 * dTheta * deg) * Rc;
    const tl = dLp / Sl, tc = dCp / Sc, th = dHp / Sh;
    return Math.sqrt(tl * tl + tc * tc + th * th + Rt * tc * th);
}

/** Bilinear sample of an RGBA8 sRGB image, returned in linear RGB (edge-clamped). */
function bilinearLinear(rgba: Buffer | Uint8Array, w: number, h: number, x: number, y: number): [number, number, number] {
    const x0 = Math.max(0, Math.min(w - 1, Math.floor(x))), y0 = Math.max(0, Math.min(h - 1, Math.floor(y)));
    const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
    const fx = Math.max(0, Math.min(1, x - x0)), fy = Math.max(0, Math.min(1, y - y0));
    const out: [number, number, number] = [0, 0, 0];
    for (let ch = 0; ch < 3; ch++) {
        const a = SRGB8_TO_LINEAR[rgba[(y0 * w + x0) * 4 + ch]], b = SRGB8_TO_LINEAR[rgba[(y0 * w + x1) * 4 + ch]];
        const c = SRGB8_TO_LINEAR[rgba[(y1 * w + x0) * 4 + ch]], d = SRGB8_TO_LINEAR[rgba[(y1 * w + x1) * 4 + ch]];
        out[ch] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
    }
    return out;
}

/** Mean linear RGB over pixel centres within +-r of (x, y) (at least the nearest pixel). */
function boxAverageLinear(rgba: Buffer | Uint8Array, w: number, h: number, x: number, y: number, r: number): [number, number, number] {
    const x0 = Math.max(0, Math.ceil(x - r)), x1 = Math.min(w - 1, Math.floor(x + r));
    const y0 = Math.max(0, Math.ceil(y - r)), y1 = Math.min(h - 1, Math.floor(y + r));
    if (x1 < x0 || y1 < y0) return bilinearLinear(rgba, w, h, x, y);
    let sr = 0, sg = 0, sb = 0, n = 0;
    for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) {
        const i = (yy * w + xx) * 4;
        sr += SRGB8_TO_LINEAR[rgba[i]]; sg += SRGB8_TO_LINEAR[rgba[i + 1]]; sb += SRGB8_TO_LINEAR[rgba[i + 2]]; n++;
    }
    return [sr / n, sg / n, sb / n];
}

/** Product of an optional caller gain and the solved exposure gain. */
function combineGain(a: [number, number, number] | undefined, b: [number, number, number]): [number, number, number] {
    return a ? [a[0] * b[0], a[1] * b[1], a[2] * b[2]] : [b[0], b[1], b[2]];
}

function smoothstep(e0: number, e1: number, x: number): number {
    if (e1 === e0) return x >= e1 ? 1 : 0;
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------------------------------
// Image-space helpers (exported for tests)
// ---------------------------------------------------------------------------------------------

/** Rectangle [x0, x1) x [y0, y1). */
export interface Roi { x0: number; y0: number; x1: number; y1: number }

/**
 * Bicubic (Catmull-Rom, a = -0.5) upsampling of interleaved 3-channel float data by an integer
 * factor, centre-aligned (dst texel centre maps to src (x + 0.5) / s - 0.5), edge-clamped.
 */
export function upsampleBicubic3(src: Float32Array, w: number, h: number, s: number): Float32Array {
    if (s === 1) return Float32Array.from(src);
    const W = w * s, H = h * s;
    const kern = (t: number): number => {
        const a = -0.5, x = Math.abs(t);
        if (x <= 1) return (a + 2) * x * x * x - (a + 3) * x * x + 1;
        if (x < 2) return a * x * x * x - 5 * a * x * x + 8 * a * x - 4 * a;
        return 0;
    };
    // Precompute taps per destination coordinate (shared by rows and columns for each axis).
    const taps = (n: number, N: number): { idx: Int32Array; wt: Float32Array } => {
        const idx = new Int32Array(N * 4), wt = new Float32Array(N * 4);
        for (let d = 0; d < N; d++) {
            const u = (d + 0.5) / s - 0.5;
            const base = Math.floor(u);
            let sum = 0;
            for (let k = 0; k < 4; k++) {
                const si = base - 1 + k;
                const wv = kern(u - si);
                idx[d * 4 + k] = Math.min(n - 1, Math.max(0, si));
                wt[d * 4 + k] = wv;
                sum += wv;
            }
            for (let k = 0; k < 4; k++) wt[d * 4 + k] /= sum;
        }
        return { idx, wt };
    };
    const tx = taps(w, W), ty = taps(h, H);
    const tmp = new Float32Array(W * h * 3);
    for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < W; x++) {
            let r = 0, g = 0, b = 0;
            for (let k = 0; k < 4; k++) {
                const si = (row + tx.idx[x * 4 + k]) * 3, wv = tx.wt[x * 4 + k];
                r += src[si] * wv; g += src[si + 1] * wv; b += src[si + 2] * wv;
            }
            const o = (y * W + x) * 3;
            tmp[o] = r; tmp[o + 1] = g; tmp[o + 2] = b;
        }
    }
    const out = new Float32Array(W * H * 3);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            let r = 0, g = 0, b = 0;
            for (let k = 0; k < 4; k++) {
                const si = (ty.idx[y * 4 + k] * W + x) * 3, wv = ty.wt[y * 4 + k];
                r += tmp[si] * wv; g += tmp[si + 1] * wv; b += tmp[si + 2] * wv;
            }
            const o = (y * W + x) * 3;
            out[o] = r; out[o + 1] = g; out[o + 2] = b;
        }
    }
    return out;
}

function gaussianKernel(sigma: number): Float32Array {
    const radius = Math.max(1, Math.ceil(3 * sigma));
    const k = new Float32Array(2 * radius + 1);
    let sum = 0;
    for (let i = -radius; i <= radius; i++) {
        const v = Math.exp(-(i * i) / (2 * sigma * sigma));
        k[i + radius] = v;
        sum += v;
    }
    for (let i = 0; i < k.length; i++) k[i] /= sum;
    return k;
}

/**
 * Normalised-convolution Gaussian of interleaved 3-channel data under a [0, 1] certainty mask,
 * evaluated inside `roi` (texels outside the ROI are treated as mask 0). Output is defined where
 * the blurred mask exceeds 1e-6 and equals 0 elsewhere (and outside the ROI).
 */
export function normalizedGaussian3(values: Float32Array, mask: Float32Array | Uint8Array, w: number, h: number, sigma: number, roi?: Roi): Float32Array {
    const r = roi || { x0: 0, y0: 0, x1: w, y1: h };
    const rw = r.x1 - r.x0, rh = r.y1 - r.y0;
    const out = new Float32Array(w * h * 3);
    if (rw <= 0 || rh <= 0) return out;
    const k = gaussianKernel(sigma);
    const rad = (k.length - 1) >> 1;
    // Horizontal pass into ROI-local buffers (num x3, den)
    const hn = new Float32Array(rw * rh * 3), hd = new Float32Array(rw * rh);
    for (let y = 0; y < rh; y++) {
        const gy = y + r.y0;
        for (let x = 0; x < rw; x++) {
            let n0 = 0, n1 = 0, n2 = 0, d = 0;
            for (let t = -rad; t <= rad; t++) {
                const sx = x + t;
                if (sx < 0 || sx >= rw) continue;
                const gi = gy * w + sx + r.x0;
                const m = mask[gi];
                if (m <= 0) continue;
                const wv = k[t + rad] * m;
                n0 += values[gi * 3] * wv; n1 += values[gi * 3 + 1] * wv; n2 += values[gi * 3 + 2] * wv;
                d += wv;
            }
            const li = y * rw + x;
            hn[li * 3] = n0; hn[li * 3 + 1] = n1; hn[li * 3 + 2] = n2; hd[li] = d;
        }
    }
    for (let y = 0; y < rh; y++) {
        for (let x = 0; x < rw; x++) {
            let n0 = 0, n1 = 0, n2 = 0, d = 0;
            for (let t = -rad; t <= rad; t++) {
                const sy = y + t;
                if (sy < 0 || sy >= rh) continue;
                const li = sy * rw + x;
                const wv = k[t + rad];
                n0 += hn[li * 3] * wv; n1 += hn[li * 3 + 1] * wv; n2 += hn[li * 3 + 2] * wv;
                d += hd[li] * wv;
            }
            if (d > 1e-6) {
                const gi = (y + r.y0) * w + x + r.x0;
                out[gi * 3] = n0 / d; out[gi * 3 + 1] = n1 / d; out[gi * 3 + 2] = n2 / d;
            }
        }
    }
    return out;
}

/**
 * Exact Euclidean distance transform (Felzenszwalb-Huttenlocher) to the nearest `source` texel,
 * inside `roi`. Returns distances in texels (Infinity where the ROI holds no source).
 */
export function euclideanDistanceTransform(source: Uint8Array, w: number, h: number, roi?: Roi): Float32Array {
    const r = roi || { x0: 0, y0: 0, x1: w, y1: h };
    const rw = r.x1 - r.x0, rh = r.y1 - r.y0;
    const INF = 1e20;
    const f = new Float64Array(rw * rh);
    for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) {
        f[y * rw + x] = source[(y + r.y0) * w + x + r.x0] ? 0 : INF;
    }
    const n = Math.max(rw, rh);
    const d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1), line = new Float64Array(n);
    const dt1 = (len: number): void => {
        let k = 0;
        v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
        for (let q = 1; q < len; q++) {
            let s = ((line[q] + q * q) - (line[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
            while (s <= z[k]) {
                k--;
                s = ((line[q] + q * q) - (line[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
            }
            k++;
            v[k] = q; z[k] = s; z[k + 1] = Infinity;
        }
        k = 0;
        for (let q = 0; q < len; q++) {
            while (z[k + 1] < q) k++;
            const dq = q - v[k];
            d[q] = dq * dq + line[v[k]];
        }
    };
    for (let x = 0; x < rw; x++) {
        for (let y = 0; y < rh; y++) line[y] = f[y * rw + x];
        dt1(rh);
        for (let y = 0; y < rh; y++) f[y * rw + x] = d[y];
    }
    for (let y = 0; y < rh; y++) {
        for (let x = 0; x < rw; x++) line[x] = f[y * rw + x];
        dt1(rw);
        for (let x = 0; x < rw; x++) f[y * rw + x] = d[x];
    }
    const out = new Float32Array(w * h).fill(Infinity);
    for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) {
        const val = f[y * rw + x];
        out[(y + r.y0) * w + x + r.x0] = val >= INF * 0.5 ? Infinity : Math.sqrt(val);
    }
    return out;
}

/**
 * Chamfer (1, sqrt 2) geodesic distance to the nearest `source` texel, propagating only through
 * texels where `domain` is 1 (e.g. UV chart texels, so distances never jump across a gutter into an
 * unrelated chart). Non-domain texels get Infinity. Two forward/backward sweeps inside `roi`.
 */
export function maskedChamferDistance(source: Uint8Array, domain: Uint8Array, w: number, h: number, roi?: Roi, sweeps = 2): Float32Array {
    const r = roi || { x0: 0, y0: 0, x1: w, y1: h };
    const d = new Float32Array(w * h).fill(Infinity);
    for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) {
        const i = y * w + x;
        if (domain[i] === 1 && source[i]) d[i] = 0;
    }
    const D = Math.SQRT2;
    for (let s = 0; s < sweeps; s++) {
        for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) {
            const i = y * w + x;
            if (domain[i] !== 1 || d[i] === 0) continue;
            let v = d[i];
            if (x > r.x0 && domain[i - 1] === 1) v = Math.min(v, d[i - 1] + 1);
            if (y > r.y0) {
                if (domain[i - w] === 1) v = Math.min(v, d[i - w] + 1);
                if (x > r.x0 && domain[i - w - 1] === 1) v = Math.min(v, d[i - w - 1] + D);
                if (x + 1 < r.x1 && domain[i - w + 1] === 1) v = Math.min(v, d[i - w + 1] + D);
            }
            d[i] = v;
        }
        for (let y = r.y1 - 1; y >= r.y0; y--) for (let x = r.x1 - 1; x >= r.x0; x--) {
            const i = y * w + x;
            if (domain[i] !== 1 || d[i] === 0) continue;
            let v = d[i];
            if (x + 1 < r.x1 && domain[i + 1] === 1) v = Math.min(v, d[i + 1] + 1);
            if (y + 1 < r.y1) {
                if (domain[i + w] === 1) v = Math.min(v, d[i + w] + 1);
                if (x + 1 < r.x1 && domain[i + w + 1] === 1) v = Math.min(v, d[i + w + 1] + D);
                if (x > r.x0 && domain[i + w - 1] === 1) v = Math.min(v, d[i + w - 1] + D);
            }
            d[i] = v;
        }
    }
    return d;
}

// ---------------------------------------------------------------------------------------------
// GLB helpers
// ---------------------------------------------------------------------------------------------

function isIdentityNode(node: any): boolean {
    if (Array.isArray(node.matrix)) {
        const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
        return node.matrix.every((v: number, i: number) => Math.abs(v - I[i]) < 1e-9);
    }
    const t = node.translation || [0, 0, 0];
    const r = node.rotation || [0, 0, 0, 1];
    const s = node.scale || [1, 1, 1];
    return Math.abs(t[0]) + Math.abs(t[1]) + Math.abs(t[2]) < 1e-9
        && Math.abs(r[0]) + Math.abs(r[1]) + Math.abs(r[2]) < 1e-9 && Math.abs(Math.abs(r[3]) - 1) < 1e-9
        && Math.abs(s[0] - 1) + Math.abs(s[1] - 1) + Math.abs(s[2] - 1) < 1e-9;
}

function imageBytes(json: any, bin: Buffer, imageIndex: number): Buffer | null {
    const img = json.images?.[imageIndex];
    if (!img || img.bufferView === undefined) return null;
    const bv = json.bufferViews[img.bufferView];
    const off = bv.byteOffset || 0;
    return bin.subarray(off, off + bv.byteLength);
}

/** Visits every textureInfo-like object ({ index }) under keys ending in "Texture" inside materials. */
function forEachMaterialTextureRef(materials: any[], fn: (ref: { index: number }) => void): void {
    const walk = (obj: any, key: string): void => {
        if (!obj || typeof obj !== 'object') return;
        if (/Texture$/.test(key) && typeof obj.index === 'number') fn(obj);
        for (const [k, v] of Object.entries(obj)) {
            if (v && typeof v === 'object') walk(v, k);
        }
    };
    for (const m of materials || []) walk(m, '');
}

/** Visits every { bufferView } reference outside the bufferViews array itself. */
function forEachBufferViewRef(json: any, fn: (holder: any) => void): void {
    const walk = (obj: any): void => {
        if (!obj || typeof obj !== 'object') return;
        if (Array.isArray(obj)) { for (const v of obj) walk(v); return; }
        if (typeof obj.bufferView === 'number') fn(obj);
        for (const [k, v] of Object.entries(obj)) {
            if (k === 'bufferViews') continue;
            if (v && typeof v === 'object') walk(v);
        }
    };
    walk(json);
}

/**
 * Removes textures not referenced by any material, images not referenced by any texture, and
 * buffer views not referenced anywhere, then repacks the BIN chunk (4-byte aligned, original
 * order). Referenced bytes are copied verbatim.
 */
export function compactGlb(jsonIn: any, bin: Buffer): { json: any; bin: Buffer; texturesRemoved: number; imagesRemoved: number; bufferViewsRemoved: number } {
    const json = JSON.parse(JSON.stringify(jsonIn));
    let texturesRemoved = 0, imagesRemoved = 0, bufferViewsRemoved = 0;

    // 1. Orphan textures
    if (Array.isArray(json.textures)) {
        const used = new Set<number>();
        forEachMaterialTextureRef(json.materials, ref => used.add(ref.index));
        const remap = new Map<number, number>();
        const kept: any[] = [];
        json.textures.forEach((t: any, i: number) => { if (used.has(i)) { remap.set(i, kept.length); kept.push(t); } });
        texturesRemoved = json.textures.length - kept.length;
        if (texturesRemoved > 0) {
            json.textures = kept;
            forEachMaterialTextureRef(json.materials, ref => { ref.index = remap.get(ref.index)!; });
        }
    }

    // 2. Orphan images
    if (Array.isArray(json.images)) {
        const used = new Set<number>();
        const visitSources = (fn: (holder: any) => void): void => {
            for (const t of json.textures || []) {
                if (typeof t.source === 'number') fn(t);
                for (const ext of Object.values(t.extensions || {}) as any[]) {
                    if (ext && typeof ext.source === 'number') fn(ext);
                }
            }
        };
        visitSources(h => used.add(h.source));
        const remap = new Map<number, number>();
        const kept: any[] = [];
        json.images.forEach((im: any, i: number) => { if (used.has(i)) { remap.set(i, kept.length); kept.push(im); } });
        imagesRemoved = json.images.length - kept.length;
        if (imagesRemoved > 0) {
            json.images = kept;
            visitSources(h => { h.source = remap.get(h.source)!; });
        }
    }

    // 3. Orphan buffer views + BIN repack (single embedded buffer only)
    const singleBuffer = Array.isArray(json.buffers) && json.buffers.length === 1 && json.buffers[0].uri === undefined
        && (json.bufferViews || []).every((bv: any) => (bv.buffer ?? 0) === 0);
    if (!singleBuffer || !Array.isArray(json.bufferViews)) {
        return { json, bin, texturesRemoved, imagesRemoved, bufferViewsRemoved };
    }
    const used = new Set<number>();
    forEachBufferViewRef(json, h => used.add(h.bufferView));
    const remap = new Map<number, number>();
    const kept: any[] = [];
    let size = 0;
    json.bufferViews.forEach((bv: any, i: number) => {
        if (!used.has(i)) return;
        remap.set(i, kept.length);
        size = ((size + 3) & ~3) + bv.byteLength;
        kept.push(bv);
    });
    bufferViewsRemoved = json.bufferViews.length - kept.length;
    const out = Buffer.alloc((size + 3) & ~3);
    let cursor = 0;
    for (const bv of kept) {
        cursor = (cursor + 3) & ~3;
        const off = bv.byteOffset || 0;
        bin.copy(out, cursor, off, off + bv.byteLength);
        bv.byteOffset = cursor;
        cursor += bv.byteLength;
    }
    json.bufferViews = kept;
    forEachBufferViewRef(json, h => { h.bufferView = remap.get(h.bufferView)!; });
    json.buffers[0].byteLength = out.length;
    return { json, bin: out, texturesRemoved, imagesRemoved, bufferViewsRemoved };
}

/**
 * Marks plate pixels within `radiusPx` of a depth discontinuity as EMPTY_DEPTH, in place: a discontinuity is
 * a 4-neighbour pair where one side is empty and the other is not, or both are surfaces whose depths differ
 * by more than `relativeJump` of the nearer one. With `radiusMeters` and `focalPx`, the radius at each
 * discontinuity is at least that distance on the surface (radiusMeters * focalPx / depth of the nearer side),
 * capped at `maxRadiusPx` (default 32): a residual pose error is a roughly constant distance on the surface, so a
 * fixed pixel band protects distant edges but not near ones. Returns the number of pixels newly masked.
 */
export function guardPlateDepthEdges(
    depth: Float32Array, width: number, height: number, radiusPx: number, relativeJump = 0.04,
    opts: { radiusMeters?: number; focalPx?: number; maxRadiusPx?: number } = {}
): number {
    const base = Math.max(0, Math.round(radiusPx));
    const metric = (opts.radiusMeters ?? 0) > 0 && (opts.focalPx ?? 0) > 0;
    if (base === 0 && !metric) return 0;
    const maxR = Math.max(base, Math.round(opts.maxRadiusPx ?? 32));
    const empty = EMPTY_DEPTH * 0.5;
    // radius per edge pixel (0 = not an edge)
    const edgeR = new Uint8Array(width * height);
    const radiusAt = (d: number) => Math.min(maxR, Math.max(base, metric ? Math.round(opts.radiusMeters! * opts.focalPx! / Math.max(0.5, d)) : 0));
    const mark = (i: number, d: number) => { const r = radiusAt(d); if (r > edgeR[i]) edgeR[i] = Math.min(255, r); };
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const i = y * width + x, di = depth[i], ai = di < empty;
        for (const j of [x + 1 < width ? i + 1 : -1, y + 1 < height ? i + width : -1]) {
            if (j < 0) continue;
            const dj = depth[j], aj = dj < empty;
            if (ai !== aj || (ai && aj && Math.abs(di - dj) > relativeJump * Math.min(di, dj))) {
                const near = ai && aj ? Math.min(di, dj) : ai ? di : dj;
                mark(i, near); mark(j, near);
            }
        }
    }
    const before = new Uint8Array(width * height);
    for (let i = 0; i < before.length; i++) before[i] = depth[i] < empty ? 1 : 0;
    let masked = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const r = edgeR[y * width + x];
        if (!r) continue;
        const r2 = r * r;
        for (let dy = -r; dy <= r; dy++) {
            const yy = y + dy;
            if (yy < 0 || yy >= height) continue;
            for (let dx = -r; dx <= r; dx++) {
                const xx = x + dx;
                if (xx < 0 || xx >= width || (metric && dx * dx + dy * dy > r2)) continue;
                const j = yy * width + xx;
                if (depth[j] < empty) { depth[j] = EMPTY_DEPTH; if (before[j]) masked++; before[j] = 0; }
            }
        }
    }
    return masked;
}

// ---------------------------------------------------------------------------------------------
// Fusion
// ---------------------------------------------------------------------------------------------

export class StreetViewTextureFusion {
    /**
     * Fuses Street View plates into the GLB's baseColor textures (see file header).
     */
    public static async fuse(request: StreetViewTextureFusionRequest): Promise<StreetViewTextureFusionResult> {
        const t0 = performance.now();
        const o = request.options || {};
        const log = o.log || (() => undefined);
        if (!request.glbBuffer && !request.glbPath) throw new Error('StreetViewTextureFusion: glbPath or glbBuffer is required');
        const glbBuffer = request.glbBuffer || await fs.readFile(request.glbPath!);
        const { json, bin } = AlgorithmicUvEngine.parseGlb(glbBuffer);

        for (const node of json.nodes || []) {
            if (!isIdentityNode(node)) {
                throw new Error('StreetViewTextureFusion: node transforms are not supported (plates and mesh must share one frame); bake transforms first');
            }
        }

        const slots = this.collectPrimitiveSlots(json, glbBuffer);
        const plateIndices: number[] = [];
        request.plates.forEach((p, k) => { if (p.poseQuality === undefined || p.poseQuality > 0) plateIndices.push(k); });
        const guardPx = Math.max(0, Math.round(o.depthEdgeGuardPx ?? 0));
        const guardM = Math.max(0, o.depthEdgeGuardMeters ?? 0);
        const plates = plateIndices.map(k => {
            const pl = request.plates[k];
            if (guardPx === 0 && guardM === 0) return pl;
            const depth = Float32Array.from(pl.depth);
            const fy = pl.intrinsics?.fy ?? pl.intrinsics?.fx ?? (pl.height / 2) / Math.tan(((pl.pose.fov ?? 60) * Math.PI) / 360);
            guardPlateDepthEdges(depth, pl.width, pl.height, guardPx, o.depthEdgeRelativeJump ?? 0.04, { radiusMeters: guardM, focalPx: fy });
            return { ...pl, depth };
        });
        const cams = SurveyTextureUnprojector.prepareCameras(plates);
        const maxScale = Math.max(1, Math.pow(2, Math.floor(Math.log2(o.maxScale ?? DEFAULTS.maxScale))));
        const minCos = o.minCosIncidence ?? DEFAULTS.minCosIncidence;
        const resRange = o.resolutionGainRange ?? DEFAULTS.resolutionGainRange;

        const reports: FusedPrimitiveReport[] = [];
        const pending: PendingImage[] = [];
        const candidates: Array<{ pi: number; prim: MeshPrimitiveData; src: { imageIndex: number; width: number; height: number }; encoded: Buffer; scale: number; report: FusedPrimitiveReport }> = [];
        const decodedTiles = new Map<number, { width: number; height: number; rgba: Buffer }>();
        const exposureOn = o.exposureNormalization !== false;
        const logRatios: number[][][] = cams.map(() => [[], [], []]);
        const surveyParams = {
            minCos,
            depthTol: o.depthTolerance ?? DEFAULTS.depthTolerance,
            depthRelTol: o.depthRelativeTolerance ?? DEFAULTS.depthRelativeTolerance,
            minGain: resRange[0],
            maxScale
        };

        // Phase 1: survey every primitive (scale, candidacy, exposure samples).
        for (let pi = 0; pi < slots.length; pi++) {
            const slot = slots[pi];
            const prim = slot.primitive;
            if (o.primitiveFilter && !o.primitiveFilter(pi, prim)) continue;
            const src = this.baseColorSource(json, bin, prim);
            const report: FusedPrimitiveReport = {
                primitiveIndex: pi,
                materialIndex: prim.materialIndex,
                imageIndex: src?.imageIndex,
                sourceWidth: src?.width ?? 0,
                sourceHeight: src?.height ?? 0,
                scale: 1,
                width: 0,
                height: 0,
                chartTexels: 0,
                observedTexels: 0,
                affectedTexels: 0,
                confidentTexels: 0,
                maxConfidence: 0,
                chartAreaM2: 0,
                observedAreaM2: 0,
                confidentAreaM2: 0,
                seamDeltaE00Mean: 0,
                seamDeltaE00P95: 0,
                seamBandTexels: 0,
                textureSharpnessGain: 1,
                defaultColorTexels: 0,
                confidenceFactors: { evidence: 0, incidence: 0, poseQuality: 0, resolutionGain: 0, feather: 0 },
                replaced: false
            };
            reports.push(report);
            if (!src) { report.skippedReason = 'no TEXCOORD_0 baseColor image'; continue; }
            if (slot.mode !== 4) { report.skippedReason = `primitive mode ${slot.mode} is not TRIANGLES`; continue; }
            const vertexCount = prim.positions.length / 3;
            let badIndex = false;
            for (let t = 0; t < prim.indices.length; t++) if (prim.indices[t] >= vertexCount) { badIndex = true; break; }
            if (badIndex) { report.skippedReason = 'index out of range'; continue; }
            if (cams.length === 0) { report.skippedReason = 'no usable plates'; continue; }
            const encoded = imageBytes(json, bin, src.imageIndex);
            if (!encoded) { report.skippedReason = 'baseColor image has no bufferView'; continue; }

            const samples: Array<{ cam: number; sx: number; sy: number; u: number; v: number; r: number }> = [];
            const scale = this.surveyPrimitive(prim, src.width, src.height, cams, surveyParams, exposureOn ? samples : undefined);
            if (samples.length > 0) {
                let tile = decodedTiles.get(src.imageIndex);
                if (!tile) { tile = await decodeImageToRgba(encoded); decodedTiles.set(src.imageIndex, tile); }
                for (const smp of samples) {
                    const cam = cams[smp.cam];
                    // Average the plate over the tile texel's footprint so a sharp photo is compared
                    // with the blurry tile at matching resolution (point samples are bimodal).
                    const pc = boxAverageLinear(cam.rgba, cam.width, cam.height, smp.sx - 0.5, smp.sy - 0.5, smp.r);
                    const tc = bilinearLinear(tile.rgba, tile.width, tile.height, smp.u * tile.width - 0.5, smp.v * tile.height - 0.5);
                    for (let ch = 0; ch < 3; ch++) {
                        // Reject near-black / clipped values on the raw plate and tile, then compare the
                        // plate as the fusion will see it (including any caller-supplied gain).
                        if (!(pc[ch] > 0.01 && pc[ch] < 0.95 && tc[ch] > 0.01 && tc[ch] < 0.95)) continue;
                        const pg = cam.linearGain ? pc[ch] * cam.linearGain[ch] : pc[ch];
                        logRatios[smp.cam][ch].push(Math.log(tc[ch] / pg));
                    }
                }
            }
            if (scale === 0) { report.skippedReason = 'not observed with a resolution gain'; continue; }
            report.scale = scale;
            candidates.push({ pi, prim, src, encoded, scale, report });
        }

        // Phase 2: relative per-plate exposure gains (median log ratio, normalised to a geometric mean of 1).
        const plateExposure = this.solvePlateExposure(logRatios, exposureOn);
        plateExposure.forEach((e, k) => { e.plate = plateIndices[k]; });
        const fusionCams = exposureOn
            ? SurveyTextureUnprojector.prepareCameras(plates.map((pl, k) => ({ ...pl, linearGain: combineGain(pl.linearGain, plateExposure[k].gain) })))
            : cams;

        // Phase 3: fuse candidate primitives.
        for (const cnd of candidates) {
            const fused = await this.fusePrimitive(cnd.prim, cnd.pi, fusionCams, cnd.src, cnd.encoded, cnd.scale, o, cnd.report, log, decodedTiles.get(cnd.src.imageIndex));
            if (fused) pending.push(fused);
        }

        // Assemble output GLB and enforce the size budget.
        const budget = o.maxOutputBytes ?? DEFAULTS.maxOutputBytes;
        let assembled = this.assembleGlb(json, bin, slots, pending);
        let budgetDownscales = 0;
        while (assembled.buffer.length > budget) {
            const candidate = pending
                .filter(p => p.scale > 1)
                .sort((a, b) => b.scale - a.scale || b.jpeg.length - a.jpeg.length)[0];
            if (candidate) {
                const half = this.downsample2x(candidate.rgba, candidate.width, candidate.height);
                candidate.rgba = half.rgba;
                candidate.width = half.width;
                candidate.height = half.height;
                candidate.scale /= 2;
                candidate.jpeg = await encodeRgbaToJpeg(half.rgba, half.width, half.height, { quality: o.jpegQuality ?? DEFAULTS.jpegQuality, chroma: o.jpegChroma ?? DEFAULTS.jpegChroma });
                candidate.report.width = half.width;
                candidate.report.height = half.height;
                candidate.report.scale = candidate.scale;
                candidate.report.outputImageBytes = candidate.jpeg.length;
                budgetDownscales++;
            } else {
                // Every replacement is at source size: drop the least valuable one.
                const weakest = pending.slice().sort((a, b) => a.report.confidentAreaM2 - b.report.confidentAreaM2)[0];
                if (!weakest) break;
                pending.splice(pending.indexOf(weakest), 1);
                weakest.report.replaced = false;
                weakest.report.skippedReason = 'dropped to meet the output size budget';
                budgetDownscales++;
            }
            assembled = this.assembleGlb(json, bin, slots, pending);
            log(`[StreetViewTextureFusion] budget: ${(assembled.buffer.length / 1e6).toFixed(1)} MB after ${budgetDownscales} reductions`);
        }

        if (o.outGlbPath) {
            await fs.ensureDir(path.dirname(o.outGlbPath));
            await fs.writeFile(o.outGlbPath, assembled.buffer);
        }

        let chartA = 0, obsA = 0, confA = 0, seamW = 0, seamSum = 0, defTex = 0;
        for (const r of reports) {
            chartA += r.chartAreaM2; obsA += r.observedAreaM2; confA += r.confidentAreaM2; defTex += r.defaultColorTexels;
            if (r.replaced && r.seamBandTexels > 0) { seamSum += r.seamDeltaE00Mean * r.seamBandTexels; seamW += r.seamBandTexels; }
        }

        return {
            glbBuffer: assembled.buffer,
            outGlbPath: o.outGlbPath,
            bytes: assembled.buffer.length,
            primitives: reports,
            imagesReplaced: pending.length,
            imagesRemoved: assembled.imagesRemoved,
            texturesRemoved: assembled.texturesRemoved,
            bufferViewsRemoved: assembled.bufferViewsRemoved,
            budgetDownscales,
            plateExposure,
            totals: {
                chartAreaM2: chartA,
                observedAreaM2: obsA,
                confidentAreaM2: confA,
                seamDeltaE00Mean: seamW > 0 ? seamSum / seamW : 0,
                defaultColorTexels: defTex
            },
            durationMs: performance.now() - t0
        };
    }

    /** Primitives in loadMeshPrimitives order, with their mesh / primitive slot. */
    private static collectPrimitiveSlots(json: any, glbBuffer: Buffer): PrimitiveSlot[] {
        const { primitives } = SurveyTextureUnprojector.loadMeshPrimitives(glbBuffer, 1024, { decodeAllIndexTypes: true });
        const slots: PrimitiveSlot[] = [];
        let k = 0;
        (json.meshes || []).forEach((mesh: any, mi: number) => {
            (mesh.primitives || []).forEach((p: any, pj: number) => {
                if (p.attributes && p.attributes.POSITION !== undefined) {
                    slots.push({ primitive: primitives[k++], meshIndex: mi, primInMesh: pj, mode: p.mode ?? 4 });
                }
            });
        });
        return slots;
    }

    /** The primitive's baseColor image when it is a TEXCOORD_0, untransformed texture. */
    private static baseColorSource(json: any, bin: Buffer, prim: MeshPrimitiveData): { imageIndex: number; width: number; height: number } | null {
        if (prim.materialIndex === undefined) return null;
        const info = json.materials?.[prim.materialIndex]?.pbrMetallicRoughness?.baseColorTexture;
        if (!info || (info.texCoord ?? 0) !== 0 || info.extensions?.KHR_texture_transform) return null;
        const dims = SurveyTextureUnprojector.readPrimitiveBaseColorDimensions(prim, json, bin);
        if (!dims) return null;
        return { imageIndex: dims.imageIndex, width: dims.width, height: dims.height };
    }

    /**
     * Surveys a primitive at 4 points per triangle against every plate. Returns the per-primitive
     * scale s = clamp(pow2(round(log2(median gain))), 1, maxScale) over triangles some plate sees with
     * (tile texel / plate footprint) >= minGain, or 0 when none qualifies (the primitive keeps its
     * original image). For exposure estimation every triangle is sampled with area-proportional
     * stratified points (one per ~4 tile texels, at most 64 per triangle); visible samples are
     * appended to `samples`, deterministically thinned to at most 4096 per plate per primitive.
     */
    private static surveyPrimitive(
        prim: MeshPrimitiveData,
        srcW: number,
        srcH: number,
        cams: PreparedCamera[],
        p: { minCos: number; depthTol: number; depthRelTol: number; minGain: number; maxScale: number },
        samples?: Array<{ cam: number; sx: number; sy: number; u: number; v: number; r: number }>
    ): number {
        const { positions: P, uvs: UV, indices: I } = prim;
        const gains: Array<{ g: number; a: number }> = [];
        const bary = [[1 / 3, 1 / 3, 1 / 3], [0.6, 0.2, 0.2], [0.2, 0.6, 0.2], [0.2, 0.2, 0.6]];
        const proj = new Float64Array(2);
        const local: Array<Array<{ cam: number; sx: number; sy: number; u: number; v: number; r: number }>> = cams.map(() => []);
        for (let t = 0; t + 2 < I.length; t += 3) {
            const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
            const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
            const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
            let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
            const twiceArea = Math.hypot(nx, ny, nz);
            if (!(twiceArea >= 1e-9)) continue;
            nx /= twiceArea; ny /= twiceArea; nz /= twiceArea;
            const ua = I[t] * 2, ub = I[t + 1] * 2, uc = I[t + 2] * 2;
            const areaUv = 0.5 * Math.abs((UV[ub] - UV[ua]) * (UV[uc + 1] - UV[ua + 1]) - (UV[ub + 1] - UV[ua + 1]) * (UV[uc] - UV[ua]));
            if (!(areaUv > 0)) continue;
            const tileTexel = Math.sqrt((0.5 * twiceArea) / (areaUv * srcW * srcH));
            if (samples !== undefined) {
                const n = Math.min(64, Math.max(1, Math.round((areaUv * srcW * srcH) / 4)));
                for (let m = 0; m < n; m++) {
                    // R2 low-discrepancy point mapped uniformly onto the triangle.
                    const r1 = (0.5 + m * 0.7548776662466927) % 1, r2 = (0.5 + m * 0.5698402909980532) % 1;
                    const s1 = Math.sqrt(r1);
                    const w0 = 1 - s1, w1 = s1 * (1 - r2), w2 = s1 * r2;
                    const px = w0 * P[a] + w1 * P[b] + w2 * P[c];
                    const py = w0 * P[a + 1] + w1 * P[b + 1] + w2 * P[c + 1];
                    const pz = w0 * P[a + 2] + w1 * P[b + 2] + w2 * P[c + 2];
                    for (let ci = 0; ci < cams.length; ci++) {
                        const fp = this.footprintAt(cams[ci], px, py, pz, nx, ny, nz, p, proj);
                        if (!(fp > 0)) continue;
                        local[ci].push({
                            cam: ci, sx: proj[0], sy: proj[1], r: Math.min(8, Math.max(0.5, 0.5 * tileTexel / fp)),
                            u: w0 * UV[ua] + w1 * UV[ub] + w2 * UV[uc],
                            v: w0 * UV[ua + 1] + w1 * UV[ub + 1] + w2 * UV[uc + 1]
                        });
                    }
                }
            }
            let best = 0;
            for (let k = 0; k < bary.length; k++) {
                const w = bary[k];
                const px = w[0] * P[a] + w[1] * P[b] + w[2] * P[c];
                const py = w[0] * P[a + 1] + w[1] * P[b + 1] + w[2] * P[c + 1];
                const pz = w[0] * P[a + 2] + w[1] * P[b + 2] + w[2] * P[c + 2];
                for (let ci = 0; ci < cams.length; ci++) {
                    const fp = this.footprintAt(cams[ci], px, py, pz, nx, ny, nz, p);
                    if (fp > 0 && tileTexel / fp > best) best = tileTexel / fp;
                }
            }
            if (best >= p.minGain) gains.push({ g: best, a: 0.5 * twiceArea });
        }
        if (samples !== undefined) {
            const cap = 4096;
            for (const list of local) {
                if (list.length <= cap) { for (const x of list) samples.push(x); continue; }
                const step = list.length / cap; // even thinning keeps the spatial spread
                for (let k = 0; k < cap; k++) samples.push(list[Math.floor(k * step)]);
            }
        }
        if (gains.length === 0) return 0;
        gains.sort((x, y) => x.g - y.g);
        const total = gains.reduce((sum, x) => sum + x.a, 0);
        let acc = 0, median = gains[gains.length - 1].g;
        for (const x of gains) { acc += x.a; if (acc >= total / 2) { median = x.g; break; } }
        const scale = Math.pow(2, Math.round(Math.log2(Math.max(1, median))));
        return Math.min(p.maxScale, Math.max(1, scale));
    }

    /**
     * Relative per-plate linear gains from median log(tile / plate) ratios. Plates with fewer than
     * 32 samples in a channel take the median gain of the others. Gains are normalised to a
     * geometric mean of 1 over plates and channels (they are applied in float, so nothing clips).
     */
    private static solvePlateExposure(logRatios: number[][][], enabled: boolean): Array<{ plate: number; samples: number; gain: [number, number, number] }> {
        const out = logRatios.map((lr, k) => ({ plate: k, samples: Math.min(lr[0].length, lr[1].length, lr[2].length), gain: [1, 1, 1] as [number, number, number] }));
        if (!enabled || logRatios.length === 0) return out;
        const median = (v: number[]): number => { const a = v.slice().sort((x, y) => x - y); return a.length ? a[a.length >> 1] : NaN; };
        const raw: number[][] = logRatios.map(lr => lr.map(ch => (ch.length >= 32 ? median(ch) : NaN)));
        for (let ch = 0; ch < 3; ch++) {
            const valid = raw.map(r => r[ch]).filter(v => Number.isFinite(v));
            const fill = valid.length ? median(valid) : 0;
            for (const r of raw) if (!Number.isFinite(r[ch])) r[ch] = fill;
        }
        let meanLog = 0;
        for (const r of raw) for (let ch = 0; ch < 3; ch++) meanLog += r[ch];
        meanLog /= raw.length * 3;
        raw.forEach((r, k) => { out[k].gain = [Math.exp(r[0] - meanLog), Math.exp(r[1] - meanLog), Math.exp(r[2] - meanLog)]; });
        return out;
    }

    /** Plate-pixel footprint (m) at a surface point, or 0 when the camera does not see it. */
    private static footprintAt(
        cam: PreparedCamera, wx: number, wy: number, wz: number, nx: number, ny: number, nz: number,
        p: { minCos: number; depthTol: number; depthRelTol: number },
        projOut?: Float64Array
    ): number {
        const vx = cam.eye[0] - wx, vy = cam.eye[1] - wy, vz = cam.eye[2] - wz;
        const dist = Math.hypot(vx, vy, vz);
        if (dist < 1e-4) return 0;
        const cos = (nx * vx + ny * vy + nz * vz) / dist;
        if (cos < p.minCos) return 0;
        const dx = -vx, dy = -vy, dz = -vz;
        const z = dx * cam.fwd[0] + dy * cam.fwd[1] + dz * cam.fwd[2];
        if (z <= 0.1) return 0;
        const x = dx * cam.right[0] + dy * cam.right[1] + dz * cam.right[2];
        const y = dx * cam.up[0] + dy * cam.up[1] + dz * cam.up[2];
        const sx = (cam.P00 * x / z + 1) * cam.halfW, sy = (1 - cam.P11 * y / z) * cam.halfH;
        const ix = Math.floor(sx), iy = Math.floor(sy);
        if (ix < 0 || iy < 0 || ix >= cam.width || iy >= cam.height) return 0;
        const rec = cam.depth[iy * cam.width + ix];
        if (rec >= EMPTY_DEPTH * 0.5) return 0;
        if (z > rec + Math.max(p.depthTol, z * p.depthRelTol)) return 0;
        if (projOut) { projOut[0] = sx; projOut[1] = sy; }
        const fPx = cam.P11 * cam.halfH;
        return (z * z) / (dist * fPx * cos);
    }

    private static async fusePrimitive(
        prim: MeshPrimitiveData,
        primIndex: number,
        cams: PreparedCamera[],
        src: { imageIndex: number; width: number; height: number },
        encoded: Buffer,
        scale: number,
        o: StreetViewTextureFusionOptions,
        report: FusedPrimitiveReport,
        log: (m: string) => void,
        preDecoded?: { width: number; height: number; rgba: Buffer }
    ): Promise<PendingImage | null> {
        const W = src.width * scale, H = src.height * scale;
        const N = W * H;
        report.width = W;
        report.height = H;
        const robust = o.robust === false ? undefined : { enabled: true, minObservations: 3, huberDeltaE: 10, ...(o.robust || {}) };
        const unprojOptions: SurveyTextureUnprojectorOptions = {
            draft: true,
            multiStationBlend: true,
            minCosIncidence: o.minCosIncidence ?? DEFAULTS.minCosIncidence,
            depthTolerance: o.depthTolerance ?? DEFAULTS.depthTolerance,
            depthRelativeTolerance: o.depthRelativeTolerance ?? DEFAULTS.depthRelativeTolerance,
            angleWeightExponent: o.angleWeightExponent ?? DEFAULTS.angleWeightExponent,
            edgeBleedPixels: 0,
            returnAccumulators: true,
            encodeTextures: false,
            skipPbrDecomposition: true,
            texelCenter: 'gl',
            incidenceNormal: 'face',
            perTriangleCameraCulling: true,
            robustReweighting: robust,
            ...(o.unprojectorOverrides || {})
        };
        const tU = performance.now();
        const sub = await SurveyTextureUnprojector.unprojectPrimitiveToAtlas(prim, primIndex, cams, unprojOptions, W, H);
        const acc = sub.accumulators;
        if (!acc) throw new Error('StreetViewTextureFusion: unprojector did not return accumulators');
        const tProj = performance.now() - tU;

        // ---- Confidence c0 (without feather) ----
        const wFull = o.weightFull ?? DEFAULTS.weightFull;
        const [cosLo, cosHi] = o.cosRange ?? DEFAULTS.cosRange;
        const [gLo, gHi] = o.resolutionGainRange ?? DEFAULTS.resolutionGainRange;
        const c = new Float32Array(N);
        const observed = new Uint8Array(N);
        const fSum = { evidence: 0, incidence: 0, poseQuality: 0, resolutionGain: 0, feather: 0, detailEnergy: 0, region: 0 };
        const P = acc.worldPositions, NRM = acc.worldNormals;
        let x0 = W, y0 = H, x1 = -1, y1 = -1;
        for (let i = 0; i < N; i++) {
            if (acc.coverage[i] !== 1) continue;
            report.chartTexels++;
            const area = acc.texelSizeMeters[i] * acc.texelSizeMeters[i];
            report.chartAreaM2 += area;
            if (!(acc.weightSum[i] > 0)) continue;
            observed[i] = 1;
            report.observedTexels++;
            report.observedAreaM2 += area;
            const raw = acc.rawWeightSum[i];
            const q = raw > 0 ? Math.min(1, Math.max(0, acc.weightSum[i] / raw)) : 0;
            const tileTexel = acc.texelSizeMeters[i] * scale;
            const gain = acc.minFootprintMeters[i] > 0 ? tileTexel / acc.minFootprintMeters[i] : 0;
            const fe = smoothstep(0, wFull, raw), fi = smoothstep(cosLo, cosHi, acc.maxCosIncidence[i]), fg = smoothstep(gLo, gHi, gain);
            const fr = !o.texelFilter || o.texelFilter(P[i * 3], P[i * 3 + 1], P[i * 3 + 2], NRM[i * 3], NRM[i * 3 + 1], NRM[i * 3 + 2]) ? 1 : 0;
            fSum.evidence += fe * area; fSum.incidence += fi * area; fSum.poseQuality += q * area; fSum.resolutionGain += fg * area; fSum.region += fr * area;
            const v = fe * fi * q * fg * fr;
            c[i] = v;
            if (v > 0) {
                const x = i % W, y = (i / W) | 0;
                if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
            }
        }
        if (report.observedAreaM2 > 0) {
            const a = report.observedAreaM2;
            report.confidenceFactors = {
                evidence: fSum.evidence / a,
                incidence: fSum.incidence / a,
                poseQuality: fSum.poseQuality / a,
                resolutionGain: fSum.resolutionGain / a,
                feather: 0,
                region: fSum.region / a
            };
        }
        if (x1 < 0) {
            report.skippedReason = 'observed texels have zero confidence';
            log(`[StreetViewTextureFusion] prim ${primIndex}: no confident texels (${report.observedTexels} observed)`);
            return null;
        }

        const sigma = (o.lowPassSigmaTexels ?? DEFAULTS.lowPassSigmaTexels) * scale;
        const featherPx = (o.featherTexels ?? DEFAULTS.featherTexels) * scale;
        const bleedPx = Math.round((o.gutterBleedTexels ?? DEFAULTS.gutterBleedTexels) * scale);
        // Covers the low-pass support, the feather, the seam-metric band + its low-pass, and the gutter bleed.
        const margin = Math.ceil(Math.max(4 * sigma, featherPx, 8 * scale, bleedPx)) + 2;
        const roi: Roi = {
            x0: Math.max(0, x0 - margin), y0: Math.max(0, y0 - margin),
            x1: Math.min(W, x1 + margin + 1), y1: Math.min(H, y1 + margin + 1)
        };

        // ---- T: decode + bicubic upsample in linear RGB ----
        const decoded = preDecoded || await decodeImageToRgba(encoded);
        if (decoded.width !== src.width || decoded.height !== src.height) {
            throw new Error(`StreetViewTextureFusion: image ${src.imageIndex} decoded to ${decoded.width}x${decoded.height}, header says ${src.width}x${src.height}`);
        }
        const tSrc = new Float32Array(src.width * src.height * 3);
        for (let i = 0, n = src.width * src.height; i < n; i++) {
            tSrc[i * 3] = SRGB8_TO_LINEAR[decoded.rgba[i * 4]];
            tSrc[i * 3 + 1] = SRGB8_TO_LINEAR[decoded.rgba[i * 4 + 1]];
            tSrc[i * 3 + 2] = SRGB8_TO_LINEAR[decoded.rgba[i * 4 + 2]];
        }
        const T = upsampleBicubic3(tSrc, src.width, src.height, scale);
        for (let i = 0; i < T.length; i++) if (T[i] < 0) T[i] = 0;

        // ---- S (linear) and low bands ----
        const S = new Float32Array(N * 3);
        for (let y = roi.y0; y < roi.y1; y++) for (let x = roi.x0; x < roi.x1; x++) {
            const i = y * W + x;
            if (!observed[i]) continue;
            S[i * 3] = srgbToLinear(acc.meanRgb[i * 3]);
            S[i * 3 + 1] = srgbToLinear(acc.meanRgb[i * 3 + 1]);
            S[i * 3 + 2] = srgbToLinear(acc.meanRgb[i * 3 + 2]);
        }
        const chartMask = acc.coverage;
        const LT = normalizedGaussian3(T, chartMask, W, H, sigma, roi);
        const LS = normalizedGaussian3(S, observed, W, H, sigma, roi);

        // ---- Detail-energy gate: never replace tile detail with weaker photo detail ----
        const gate = o.detailEnergyGate === undefined ? DEFAULTS.detailEnergyGate : o.detailEnergyGate;
        if (gate) {
            const eps = 1e-4;
            const lum = (buf: Float32Array, i: number): number => 0.2126 * buf[i * 3] + 0.7152 * buf[i * 3 + 1] + 0.0722 * buf[i * 3 + 2];
            const dT2 = new Float32Array(N * 3), dS2 = new Float32Array(N * 3);
            for (let y = roi.y0; y < roi.y1; y++) for (let x = roi.x0; x < roi.x1; x++) {
                const i = y * W + x;
                if (chartMask[i] === 1) { const v = Math.log((lum(T, i) + eps) / (lum(LT, i) + eps)); dT2[i * 3] = v * v; }
                if (observed[i]) { const v = Math.log((lum(S, i) + eps) / (lum(LS, i) + eps)); dS2[i * 3] = v * v; }
            }
            const sigE = 2 * scale;
            const ET = normalizedGaussian3(dT2, chartMask, W, H, sigE, roi);
            const ES = normalizedGaussian3(dS2, observed, W, H, sigE, roi);
            let aSum = 0, gSum = 0;
            for (let y = roi.y0; y < roi.y1; y++) for (let x = roi.x0; x < roi.x1; x++) {
                const i = y * W + x;
                if (!(c[i] > 0)) continue;
                const ratio = Math.sqrt(Math.max(0, ES[i * 3])) / Math.max(0.01, Math.sqrt(Math.max(0, ET[i * 3])));
                const g = smoothstep(gate[0], gate[1], ratio);
                const area = acc.texelSizeMeters[i] * acc.texelSizeMeters[i];
                aSum += area; gSum += g * area;
                c[i] *= g;
            }
            report.confidenceFactors.detailEnergy = aSum > 0 ? gSum / aSum : 0;
        }

        // ---- Feather from the observation edge: distance to unobserved texels of the same chart ----
        // (propagates only through chart texels, so unrelated charts packed nearby in the atlas
        // never feather each other; UV seams carry no feather because the low band is preserved)
        const unobservedChart = new Uint8Array(N);
        for (let y = roi.y0; y < roi.y1; y++) for (let x = roi.x0; x < roi.x1; x++) {
            const i = y * W + x;
            if (acc.coverage[i] === 1 && !(c[i] > 0)) unobservedChart[i] = 1;
        }
        const dist = maskedChamferDistance(unobservedChart, acc.coverage, W, H, roi);
        let affected = 0;
        for (let y = roi.y0; y < roi.y1; y++) for (let x = roi.x0; x < roi.x1; x++) {
            const i = y * W + x;
            if (c[i] > 0) {
                const ff = smoothstep(0, featherPx, dist[i]);
                fSum.feather += ff * acc.texelSizeMeters[i] * acc.texelSizeMeters[i];
                c[i] *= ff;
                if (c[i] > 0.01) affected++;
                if (c[i] >= 0.5) {
                    report.confidentTexels++;
                    report.confidentAreaM2 += acc.texelSizeMeters[i] * acc.texelSizeMeters[i];
                }
                if (c[i] > report.maxConfidence) report.maxConfidence = c[i];
            }
        }
        report.affectedTexels = affected;
        {
            // Mean feather over texels whose pre-feather confidence was positive.
            let a0 = 0;
            for (let y = roi.y0; y < roi.y1; y++) for (let x = roi.x0; x < roi.x1; x++) {
                const i = y * W + x;
                if (acc.coverage[i] === 1 && unobservedChart[i] === 0 && observed[i]) a0 += acc.texelSizeMeters[i] * acc.texelSizeMeters[i];
            }
            report.confidenceFactors.feather = a0 > 0 ? fSum.feather / a0 : 0;
        }
        const minConfident = o.minConfidentSourceTexels ?? DEFAULTS.minConfidentSourceTexels;
        const confidentSource = report.confidentTexels / (scale * scale);
        if (confidentSource < minConfident) {
            report.skippedReason = `only ${confidentSource.toFixed(1)} source texels with c >= 0.5 (< ${minConfident})`;
            return null;
        }

        if (o.lowBandShadowLift === true) {
            for (let y = roi.y0; y < roi.y1; y++) for (let x = roi.x0; x < roi.x1; x++) {
                const i = y * W + x;
                if (!(c[i] > 0)) continue;
                const r8 = linearToSrgb8(LT[i * 3]), g8 = linearToSrgb8(LT[i * 3 + 1]), b8 = linearToSrgb8(LT[i * 3 + 2]);
                const l = (0.299 * r8 + 0.587 * g8 + 0.114 * b8) / 255;
                if (l >= 0.45) continue;
                const f = (0.45 - l) / 0.45;
                const lift = 1 + 0.38 * f * f;
                LT[i * 3] = srgbToLinear(Math.min(255, r8 * lift));
                LT[i * 3 + 1] = srgbToLinear(Math.min(255, g8 * lift));
                LT[i * 3 + 2] = srgbToLinear(Math.min(255, b8 * lift));
            }
        }

        // ---- Fuse ----
        const [dLo, dHi] = o.detailClamp ?? DEFAULTS.detailClamp;
        const out = Float32Array.from(T);
        if ((o.detailMode ?? 'fine') === 'fine') {
            const fine = this.fineDetailRatio(S, T, observed, c, W, H, roi, scale, o.tileBlurSigmaCandidates ?? DEFAULTS.tileBlurSigmaCandidates);
            report.tileBlurSigmaTexels = fine.sigmaTexels;
            report.tileBlurNcc = fine.ncc;
            for (let y = roi.y0; y < roi.y1; y++) for (let x = roi.x0; x < roi.x1; x++) {
                const i = y * W + x;
                const ci = c[i];
                if (!(ci > 0)) continue;
                for (let ch = 0; ch < 3; ch++) {
                    const k = i * 3 + ch, g = fine.blurred[k];
                    const d = g > 1e-5 ? Math.min(dHi, Math.max(dLo, S[k] / g)) : 1;
                    out[k] = T[k] * (1 + ci * (d - 1));
                }
            }
        }
        const lowBand = o.lowBand ?? 'tile';
        let harmonize: ((i: number) => [number, number, number]) | undefined;
        if ((o.detailMode ?? 'fine') === 'ratio' && lowBand === 'streetview-harmonized') {
            harmonize = this.buildLabTransfer(S, T, c, N);
        }
        if ((o.detailMode ?? 'fine') === 'ratio') for (let y = roi.y0; y < roi.y1; y++) for (let x = roi.x0; x < roi.x1; x++) {
            const i = y * W + x;
            const ci = c[i];
            if (!(ci > 0)) continue;
            const harmonized = harmonize ? harmonize(i) : undefined;
            for (let ch = 0; ch < 3; ch++) {
                const k = i * 3 + ch;
                let fusedV: number;
                if (harmonized) {
                    fusedV = harmonized[ch];
                } else {
                    const ls = LS[k];
                    const d = ls > 1e-5 ? Math.min(dHi, Math.max(dLo, S[k] / ls)) : 1;
                    fusedV = LT[k] * d;
                }
                out[k] = ci * fusedV + (1 - ci) * T[k];
            }
        }

        // ---- Encode to sRGB8 RGBA (T outside charts keeps the original gutters) ----
        const rgba = Buffer.alloc(N * 4);
        for (let i = 0; i < N; i++) {
            rgba[i * 4] = linearToSrgb8(out[i * 3]);
            rgba[i * 4 + 1] = linearToSrgb8(out[i * 3 + 1]);
            rgba[i * 4 + 2] = linearToSrgb8(out[i * 3 + 2]);
            rgba[i * 4 + 3] = 255;
        }
        this.bleedIntoGutters(rgba, c, chartMask, W, H, roi, bleedPx);

        // ---- Metrics ----
        this.measurePrimitive(report, out, T, c, chartMask, W, H, roi, scale, o.unprojectorOverrides?.defaultColor, rgba);
        const minSharp = o.minTextureSharpnessGain ?? DEFAULTS.minTextureSharpnessGain;
        if (!(report.textureSharpnessGain >= minSharp)) {
            report.skippedReason = `texture sharpness gain x${report.textureSharpnessGain.toFixed(2)} on c >= 0.5 texels < x${minSharp}: the tile image is kept`;
            log(`[StreetViewTextureFusion] prim ${primIndex}: ${report.skippedReason}`);
            return null;
        }

        const jpeg = await encodeRgbaToJpeg(rgba, W, H, { quality: o.jpegQuality ?? DEFAULTS.jpegQuality, chroma: o.jpegChroma ?? DEFAULTS.jpegChroma });
        report.replaced = true;
        report.outputImageBytes = jpeg.length;
        log(`[StreetViewTextureFusion] prim ${primIndex}: s=${scale} ${W}x${H} observed ${report.observedTexels} confident ${report.confidentTexels} seam dE00 ${report.seamDeltaE00Mean.toFixed(2)} sharp x${report.textureSharpnessGain.toFixed(2)} proj ${(tProj / 1000).toFixed(1)}s jpeg ${(jpeg.length / 1024).toFixed(0)} KiB`);

        if (o.debugDir) {
            await fs.ensureDir(o.debugDir);
            const cRgba = Buffer.alloc(N * 4);
            const tRgba = Buffer.alloc(N * 4);
            for (let i = 0; i < N; i++) {
                const v = Math.round(c[i] * 255);
                cRgba[i * 4] = v; cRgba[i * 4 + 1] = acc.coverage[i] ? 60 : 0; cRgba[i * 4 + 2] = observed[i] ? 120 : 0; cRgba[i * 4 + 3] = 255;
                tRgba[i * 4] = linearToSrgb8(T[i * 3]); tRgba[i * 4 + 1] = linearToSrgb8(T[i * 3 + 1]); tRgba[i * 4 + 2] = linearToSrgb8(T[i * 3 + 2]); tRgba[i * 4 + 3] = 255;
            }
            await fs.writeFile(path.join(o.debugDir, `prim${primIndex}_confidence.png`), encodePng(W, H, cRgba));
            await fs.writeFile(path.join(o.debugDir, `prim${primIndex}_tile.png`), encodePng(W, H, tRgba));
            await fs.writeFile(path.join(o.debugDir, `prim${primIndex}_fused.png`), encodePng(W, H, rgba));
        }
        if (o.returnConfidenceMaps) {
            report.maps = {
                width: W,
                height: H,
                confidence: c,
                worldPositions: acc.worldPositions,
                worldNormals: acc.worldNormals,
                texelSizeMeters: acc.texelSizeMeters,
                coverage: acc.coverage
            };
        }
        return { report, rgba, width: W, height: H, jpeg, scale };
    }

    /**
     * The photo blurred to the tile's own resolution: for each candidate sigma (source texels x s) the observed photo
     * is Gaussian-blurred (normalised over observed texels) and correlated with the tile on texels with c > 0.2
     * (luminance NCC); the best-correlating blur is returned with the blurred photo. S / blurred is then the detail
     * the tile cannot show.
     */
    private static fineDetailRatio(
        S: Float32Array, T: Float32Array, observed: Uint8Array, c: Float32Array, W: number, H: number, roi: Roi, scale: number, candidates: number[]
    ): { blurred: Float32Array; sigmaTexels: number; ncc: number } {
        const lum = (b: Float32Array, i: number) => 0.2126 * b[i * 3] + 0.7152 * b[i * 3 + 1] + 0.0722 * b[i * 3 + 2];
        const idx: number[] = [];
        for (let y = roi.y0; y < roi.y1; y++) for (let x = roi.x0; x < roi.x1; x++) { const i = y * W + x; if (c[i] > 0.2 && observed[i]) idx.push(i); }
        const step = Math.max(1, Math.floor(idx.length / 20000));
        let best: { blurred: Float32Array; sigmaTexels: number; ncc: number } | null = null;
        for (const sg of candidates) {
            const blurred = normalizedGaussian3(S, observed, W, H, Math.max(0.3, sg * scale), roi);
            let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, n = 0;
            for (let k = 0; k < idx.length; k += step) {
                const i = idx[k], a = lum(blurred, i), b = lum(T, i);
                sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b; n++;
            }
            const va = saa - sa * sa / Math.max(1, n), vb = sbb - sb * sb / Math.max(1, n);
            const ncc = n > 10 && va > 1e-12 && vb > 1e-12 ? (sab - sa * sb / n) / Math.sqrt(va * vb) : -1;
            if (!best || ncc > best.ncc) best = { blurred, sigmaTexels: sg, ncc };
        }
        return best ?? { blurred: normalizedGaussian3(S, observed, W, H, scale, roi), sigmaTexels: 1, ncc: -1 };
    }

    /** Per-primitive Lab mean/std transfer of S onto T (statistics over texels with c > 0). */
    private static buildLabTransfer(S: Float32Array, T: Float32Array, c: Float32Array, N: number): (i: number) => [number, number, number] {
        const lab = new Float64Array(3);
        const sumS = [0, 0, 0], sqS = [0, 0, 0], sumT = [0, 0, 0], sqT = [0, 0, 0];
        let n = 0;
        for (let i = 0; i < N; i++) {
            if (!(c[i] > 0)) continue;
            linearToLab(S[i * 3], S[i * 3 + 1], S[i * 3 + 2], lab, 0);
            for (let k = 0; k < 3; k++) { sumS[k] += lab[k]; sqS[k] += lab[k] * lab[k]; }
            linearToLab(T[i * 3], T[i * 3 + 1], T[i * 3 + 2], lab, 0);
            for (let k = 0; k < 3; k++) { sumT[k] += lab[k]; sqT[k] += lab[k] * lab[k]; }
            n++;
        }
        const muS = sumS.map(v => v / Math.max(1, n)), muT = sumT.map(v => v / Math.max(1, n));
        const sdS = sqS.map((v, k) => Math.sqrt(Math.max(1e-6, v / Math.max(1, n) - muS[k] * muS[k])));
        const sdT = sqT.map((v, k) => Math.sqrt(Math.max(1e-6, v / Math.max(1, n) - muT[k] * muT[k])));
        return (i: number) => {
            linearToLab(S[i * 3], S[i * 3 + 1], S[i * 3 + 2], lab, 0);
            const L = (lab[0] - muS[0]) / sdS[0] * sdT[0] + muT[0];
            const a = (lab[1] - muS[1]) / sdS[1] * sdT[1] + muT[1];
            const b = (lab[2] - muS[2]) / sdS[2] * sdT[2] + muT[2];
            const rgb = labToLinear(L, a, b);
            return [Math.max(0, rgb[0]), Math.max(0, rgb[1]), Math.max(0, rgb[2])];
        };
    }

    /**
     * Copies fused colour into non-chart texels within `radius` of a changed (c > 0) texel by
     * iterative 4-neighbour averaging, so bilinear filtering at chart borders sees fused texels.
     */
    private static bleedIntoGutters(rgba: Buffer, c: Float32Array, chart: Uint8Array, W: number, H: number, roi: Roi, radius: number): void {
        if (radius <= 0) return;
        const changed = new Uint8Array(W * H);
        for (let y = roi.y0; y < roi.y1; y++) for (let x = roi.x0; x < roi.x1; x++) {
            const i = y * W + x;
            if (chart[i] === 1 && c[i] > 0) changed[i] = 1;
        }
        const near = euclideanDistanceTransform(changed, W, H, roi);
        const filled = new Uint8Array(W * H);
        for (let y = roi.y0; y < roi.y1; y++) for (let x = roi.x0; x < roi.x1; x++) {
            const i = y * W + x;
            if (chart[i] === 1) filled[i] = 1;
        }
        for (let step = 0; step < radius; step++) {
            const add: number[] = [];
            for (let y = roi.y0; y < roi.y1; y++) for (let x = roi.x0; x < roi.x1; x++) {
                const i = y * W + x;
                if (filled[i] || !(near[i] <= radius)) continue;
                let r = 0, g = 0, b = 0, n = 0;
                if (x > 0 && filled[i - 1]) { r += rgba[(i - 1) * 4]; g += rgba[(i - 1) * 4 + 1]; b += rgba[(i - 1) * 4 + 2]; n++; }
                if (x + 1 < W && filled[i + 1]) { r += rgba[(i + 1) * 4]; g += rgba[(i + 1) * 4 + 1]; b += rgba[(i + 1) * 4 + 2]; n++; }
                if (y > 0 && filled[i - W]) { r += rgba[(i - W) * 4]; g += rgba[(i - W) * 4 + 1]; b += rgba[(i - W) * 4 + 2]; n++; }
                if (y + 1 < H && filled[i + W]) { r += rgba[(i + W) * 4]; g += rgba[(i + W) * 4 + 1]; b += rgba[(i + W) * 4 + 2]; n++; }
                if (n === 0) continue;
                rgba[i * 4] = Math.round(r / n); rgba[i * 4 + 1] = Math.round(g / n); rgba[i * 4 + 2] = Math.round(b / n);
                add.push(i);
            }
            if (add.length === 0) break;
            for (const i of add) filled[i] = 1;
        }
    }

    /** Seam Delta-E00 (low-pass out vs low-pass T), texture-space sharpness gain, default-colour count. */
    private static measurePrimitive(
        report: FusedPrimitiveReport,
        out: Float32Array,
        T: Float32Array,
        c: Float32Array,
        chart: Uint8Array,
        W: number,
        H: number,
        roi: Roi,
        scale: number,
        defaultColor: [number, number, number] | undefined,
        rgba: Buffer
    ): void {
        const N = W * H;
        // Seam band: feathered texels (0 < c < 0.95) plus chart texels within 2 s of a c > 0 texel.
        const changed = new Uint8Array(N);
        for (let y = roi.y0; y < roi.y1; y++) for (let x = roi.x0; x < roi.x1; x++) {
            const i = y * W + x;
            if (chart[i] === 1 && c[i] > 0) changed[i] = 1;
        }
        const dChanged = euclideanDistanceTransform(changed, W, H, roi);
        const sigma = 2 * scale;
        const Lo = normalizedGaussian3(out, chart, W, H, sigma, roi);
        const Lt = normalizedGaussian3(T, chart, W, H, sigma, roi);
        const des: number[] = [];
        const lab = new Float64Array(6);
        for (let y = roi.y0; y < roi.y1; y++) for (let x = roi.x0; x < roi.x1; x++) {
            const i = y * W + x;
            if (chart[i] !== 1) continue;
            const inBand = (c[i] > 0 && c[i] < 0.95) || (!(c[i] > 0) && dChanged[i] <= 2 * scale);
            if (!inBand) continue;
            linearToLab(Lo[i * 3], Lo[i * 3 + 1], Lo[i * 3 + 2], lab, 0);
            linearToLab(Lt[i * 3], Lt[i * 3 + 1], Lt[i * 3 + 2], lab, 3);
            des.push(deltaE2000(lab[0], lab[1], lab[2], lab[3], lab[4], lab[5]));
        }
        report.seamBandTexels = des.length;
        if (des.length > 0) {
            report.seamDeltaE00Mean = des.reduce((s, v) => s + v, 0) / des.length;
            des.sort((a, b) => a - b);
            report.seamDeltaE00P95 = des[Math.min(des.length - 1, Math.floor(0.95 * des.length))];
        }

        // Texture-space sharpness: Laplacian variance of luminance where c >= 0.5 (interior texels).
        const lum = (buf: Float32Array, i: number): number => 0.2126 * buf[i * 3] + 0.7152 * buf[i * 3 + 1] + 0.0722 * buf[i * 3 + 2];
        let so = 0, so2 = 0, st = 0, st2 = 0, n = 0;
        for (let y = Math.max(1, roi.y0); y < Math.min(H - 1, roi.y1); y++) for (let x = Math.max(1, roi.x0); x < Math.min(W - 1, roi.x1); x++) {
            const i = y * W + x;
            if (!(c[i] >= 0.5) || chart[i - 1] !== 1 || chart[i + 1] !== 1 || chart[i - W] !== 1 || chart[i + W] !== 1) continue;
            const lo = lum(out, i - 1) + lum(out, i + 1) + lum(out, i - W) + lum(out, i + W) - 4 * lum(out, i);
            const lt = lum(T, i - 1) + lum(T, i + 1) + lum(T, i - W) + lum(T, i + W) - 4 * lum(T, i);
            so += lo; so2 += lo * lo; st += lt; st2 += lt * lt; n++;
        }
        if (n > 1) {
            const vo = so2 / n - (so / n) ** 2, vt = st2 / n - (st / n) ** 2;
            // a flat tile (vt ~ 0) gains everything the photo adds; capped to stay finite in JSON reports
            report.textureSharpnessGain = vo > 1e-12 ? Math.min(1e6, vo / Math.max(vt, 1e-12)) : 1;
        }

        let def = 0;
        if (defaultColor) {
            for (let i = 0; i < N; i++) {
                if (chart[i] !== 1) continue;
                if (Math.abs(rgba[i * 4] - defaultColor[0]) <= 2 && Math.abs(rgba[i * 4 + 1] - defaultColor[1]) <= 2 && Math.abs(rgba[i * 4 + 2] - defaultColor[2]) <= 2) def++;
            }
        }
        report.defaultColorTexels = def;
    }

    /** 2x box downsample in linear light (odd edges replicate). */
    private static downsample2x(rgba: Buffer, w: number, h: number): { rgba: Buffer; width: number; height: number } {
        const W = Math.max(1, w >> 1), H = Math.max(1, h >> 1);
        const out = Buffer.alloc(W * H * 4);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            for (let ch = 0; ch < 3; ch++) {
                let s = 0;
                for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
                    const sx = Math.min(w - 1, 2 * x + dx), sy = Math.min(h - 1, 2 * y + dy);
                    s += SRGB8_TO_LINEAR[rgba[(sy * w + sx) * 4 + ch]];
                }
                out[(y * W + x) * 4 + ch] = linearToSrgb8(s / 4);
            }
            out[(y * W + x) * 4 + 3] = 255;
        }
        return { rgba: out, width: W, height: H };
    }

    /**
     * Writes fused images: in place when the image is used only by this primitive's material
     * baseColor slot, otherwise through a cloned texture + material. Touched materials become
     * non-metallic; KHR_materials_unlit and samplers are kept. Then compacts orphans.
     */
    private static assembleGlb(
        jsonIn: any,
        binIn: Buffer,
        slots: PrimitiveSlot[],
        pending: PendingImage[]
    ): { buffer: Buffer; imagesRemoved: number; texturesRemoved: number; bufferViewsRemoved: number } {
        const json = JSON.parse(JSON.stringify(jsonIn));
        const chunks: Buffer[] = [binIn];
        let binLength = binIn.length;
        const append = (data: Buffer): number => {
            const aligned = (binLength + 3) & ~3;
            if (aligned > binLength) chunks.push(Buffer.alloc(aligned - binLength));
            chunks.push(data);
            binLength = aligned + data.length;
            json.bufferViews.push({ buffer: 0, byteOffset: aligned, byteLength: data.length });
            return json.bufferViews.length - 1;
        };

        // Reference counts: image <- textures <- material slots <- primitives
        const texRefs = new Map<number, number>();
        forEachMaterialTextureRef(json.materials, ref => texRefs.set(ref.index, (texRefs.get(ref.index) || 0) + 1));
        const imgRefs = new Map<number, number>();
        (json.textures || []).forEach((t: any) => { if (typeof t.source === 'number') imgRefs.set(t.source, (imgRefs.get(t.source) || 0) + 1); });
        const matPrimRefs = new Map<number, number>();
        for (const mesh of json.meshes || []) for (const p of mesh.primitives || []) {
            if (typeof p.material === 'number') matPrimRefs.set(p.material, (matPrimRefs.get(p.material) || 0) + 1);
        }

        for (const item of pending) {
            const slot = slots[item.report.primitiveIndex];
            const gltfPrim = json.meshes[slot.meshIndex].primitives[slot.primInMesh];
            const matIdx: number = gltfPrim.material;
            const mat = json.materials[matIdx];
            const texIdx: number = mat.pbrMetallicRoughness.baseColorTexture.index;
            const imgIdx: number = json.textures[texIdx].source;
            const bvIdx = append(item.jpeg);
            const exclusive = (imgRefs.get(imgIdx) || 0) === 1 && (texRefs.get(texIdx) || 0) === 1 && (matPrimRefs.get(matIdx) || 0) === 1;
            if (exclusive) {
                const prevName = json.images[imgIdx].name;
                json.images[imgIdx] = { bufferView: bvIdx, mimeType: 'image/jpeg', ...(prevName ? { name: prevName } : {}) };
                mat.pbrMetallicRoughness.metallicFactor = 0;
            } else {
                json.images.push({ bufferView: bvIdx, mimeType: 'image/jpeg', name: `streetview_fused_prim_${item.report.primitiveIndex}` });
                const newTex = { ...json.textures[texIdx], source: json.images.length - 1 };
                json.textures.push(newTex);
                const newMat = JSON.parse(JSON.stringify(mat));
                newMat.pbrMetallicRoughness.baseColorTexture.index = json.textures.length - 1;
                newMat.pbrMetallicRoughness.metallicFactor = 0;
                if (newMat.name) newMat.name = `${newMat.name}_streetview`;
                json.materials.push(newMat);
                gltfPrim.material = json.materials.length - 1;
            }
        }

        const bin = Buffer.concat(chunks, binLength);
        json.buffers[0].byteLength = bin.length;
        const compact = compactGlb(json, bin);
        return {
            buffer: AlgorithmicUvEngine.serializeGlb(compact.json, compact.bin),
            imagesRemoved: compact.imagesRemoved,
            texturesRemoved: compact.texturesRemoved,
            bufferViewsRemoved: compact.bufferViewsRemoved
        };
    }
}
