/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Optional enhancement of the tier 2 tile transfer ('tile-photo-enhanced', design section 5). Per chart of the
 * atlas, a Google image model (Gemini image edit; model ids from IMAGE_MODEL_PRIORITY) is given the transferred
 * crop plus the nearest registered real Street View views of the same surface as grounding references, and asked to
 * sharpen it at low strength without moving, adding or removing anything. The answer is kept only when it passes
 * a gate against the transferred original:
 *
 *   edge NCC          Pearson correlation of Sobel magnitudes at the transfer's scale (both blurred by
 *                     edgeScaleSigmaPx) >= minEdgeNcc: edges stay where they were.
 *   new structure     share of the answer's strong edges farther than maxNewEdgeDistPx from any original edge
 *                     <= maxNewEdgeShare: nothing new appears.
 *   low-band SSIM     SSIM of the luma low band (blur lowBandSigmaPx) >= minLowBandSsim: layout and shading stay.
 *   low-band colour   mean CIEDE2000 of the colour low band <= maxLowBandDeltaE: no restyle or regrade.
 *   sharpness gain    Laplacian variance ratio >= minSharpnessGain: the answer must actually add detail.
 *
 * A failing gate, a model failure, or a chart with no grounding view keeps the transferred texels and records a
 * degradation with the real reason (a model failure is a MediaModelUnavailableError, which generateImageWithModels
 * throws; any other error propagates); accepted texels get their own provenance entry naming the model that answered
 * (and the models skipped before it, when the first choice did not answer). The model client is injected; image
 * bytes stay in memory. Charts are processed concurrently and assembled in chart order, so the result is
 * deterministic for a deterministic client.
 */

import type { Vec3 } from '../../../common/spatial/staged-location-contracts';
import {
    packConfidenceTexel, unpackConfidenceTexel,
    type BakedTexturePlanes, type ConfidencePlane, type DecodedImage, type PinholeCamera, type TexelProvenance,
    type TexturePassDegradation, type UvAtlas
} from '../../../common/spatial/texture-pass-contracts';
import { IMAGE_MODEL_ASPECT_RATIOS, IMAGE_MODEL_PRIORITY, nearestImageAspectRatio, type SkippedMediaModel } from '../../../common/media-generation-protocol';
import { generateImageWithModels } from '../../google-media-generation-service';
import { MediaModelUnavailableError } from '../../../common/errors/pipeline-errors';
import { encodePng } from '../../texture-processing';
import { encodeRgbaToJpeg } from '../../image-codec-ffmpeg';
import { blur1, ciede2000, edgeMap, exactDistanceTransform, laplacianVariance, linearRgbToLab, maskedNcc } from '../../spatial/StreetViewStage3Metrics';
import { SRGB8_TO_LINEAR } from '../../../common/spatial/photogrammetric-delight';
import { decodeImageInMemory, TILE_TRANSFER_RUNG, type RgbaImage8 } from './tile-texture-transfer';

// =============================================================================
// Model client (injected)
// =============================================================================

export interface EnhanceModelRequest {
    /** Chart label (node name and chart id), for logs and replay keys. */
    label: string;
    /** Models to try in order (API ids). */
    models: string[];
    prompt: string;
    /** The transferred crop, PNG. */
    image: { mimeType: 'image/png'; bytes: Uint8Array; width: number; height: number };
    /** Real Street View views of the same surface, PNG crops. */
    references: Array<{ panoId: string; mimeType: 'image/png' | 'image/jpeg'; bytes: Uint8Array }>;
    signal?: AbortSignal;
}

export interface EnhanceModelAnswer {
    bytes: Uint8Array;
    mimeType: string;
    /** The model that answered. */
    modelUsed: string;
    requestedModels: string[];
    skippedModels: SkippedMediaModel[];
    /** One sentence naming the model that answered and, when it was not the first asked for, why. */
    modelNote: string;
    costUsd?: number;
}

export type EnhanceModelClient = (request: EnhanceModelRequest) => Promise<EnhanceModelAnswer>;

/** The production client: a Google Gen AI SDK client (`models.generateContent`) through generateImageWithModels. */
export function genAiEnhanceClient(genai: unknown): EnhanceModelClient {
    return async request => {
        const parts: any[] = [{ text: request.prompt }, { inlineData: { mimeType: request.image.mimeType, data: Buffer.from(request.image.bytes).toString('base64') } }];
        request.references.forEach((ref, k) => {
            parts.push({ text: `Reference photo ${k + 1} (real street-level view of the same surface, pano ${ref.panoId}):` });
            parts.push({ inlineData: { mimeType: ref.mimeType, data: Buffer.from(ref.bytes).toString('base64') } });
        });
        const answer = await generateImageWithModels(genai, {
            models: request.models,
            contents: [{ role: 'user', parts }],
            imageConfig: { aspectRatio: nearestImageAspectRatio(request.image.width, request.image.height) },
            signal: request.signal
        });
        return {
            bytes: new Uint8Array(answer.data.buffer, answer.data.byteOffset, answer.data.byteLength), mimeType: answer.mimeType,
            modelUsed: answer.modelUsed, requestedModels: answer.requestedModels, skippedModels: answer.skippedModels, modelNote: answer.modelNote
        };
    };
}

// =============================================================================
// Gate
// =============================================================================

export interface EnhanceGateThresholds {
    minEdgeNcc: number;
    maxNewEdgeShare: number;
    maxNewEdgeDistPx: number;
    minLowBandSsim: number;
    maxLowBandDeltaE: number;
    minSharpnessGain: number;
    /** Blur (px) before the edge comparison: the transfer's own scale, so added fine detail is not counted as moved edges. */
    edgeScaleSigmaPx: number;
    /** Blur (px) of the low band for SSIM and colour. */
    lowBandSigmaPx: number;
}

/**
 * Design section 5: edges stay put and no new structure beyond 3 px; the rest guard layout and colour. Sobel NCC 0.95
 * (design 0.97): measured on 159 real chart answers from the live arch, the answers that only sharpened scored 0.954 to
 * 0.996 with every other metric in bounds, while every answer that invented or regraded failed two or more metrics.
 */
export const DEFAULT_ENHANCE_GATE: EnhanceGateThresholds = {
    minEdgeNcc: 0.95, maxNewEdgeShare: 0.05, maxNewEdgeDistPx: 3, minLowBandSsim: 0.95, maxLowBandDeltaE: 3, minSharpnessGain: 1.05,
    edgeScaleSigmaPx: 1.5, lowBandSigmaPx: 2
};

export interface EnhanceGateMetrics {
    edgeNcc: number | null;
    newEdgeShare: number;
    lowBandSsim: number;
    lowBandDeltaE: number;
    sharpnessGain: number;
    texels: number;
}

export interface EnhanceGateResult { pass: boolean; reasonCode?: string; reason?: string; metrics: EnhanceGateMetrics }

const lumaOf = (img: RgbaImage8): Float32Array => {
    const n = img.width * img.height, out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = 0.2126 * img.rgba[i * 4] + 0.7152 * img.rgba[i * 4 + 1] + 0.0722 * img.rgba[i * 4 + 2];
    return out;
};

function sobelMagnitude(L: Float32Array, W: number, H: number): Float32Array {
    const out = new Float32Array(W * H);
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        const gx = L[i - W + 1] + 2 * L[i + 1] + L[i + W + 1] - L[i - W - 1] - 2 * L[i - 1] - L[i + W - 1];
        const gy = L[i + W - 1] + 2 * L[i + W] + L[i + W + 1] - L[i - W - 1] - 2 * L[i - W] - L[i - W + 1];
        out[i] = Math.hypot(gx, gy);
    }
    return out;
}

/** Mean SSIM (Gaussian 1.5 px window, 8-bit constants) of two single-channel images over `mask`. */
function maskedSsim(a: Float32Array, b: Float32Array, W: number, H: number, mask: Uint8Array): number {
    const C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2;
    const ab = new Float32Array(W * H), aa = new Float32Array(W * H), bb = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) { ab[i] = a[i] * b[i]; aa[i] = a[i] * a[i]; bb[i] = b[i] * b[i]; }
    const ma = blur1(a, W, H, 1.5), mb = blur1(b, W, H, 1.5), mab = blur1(ab, W, H, 1.5), maa = blur1(aa, W, H, 1.5), mbb = blur1(bb, W, H, 1.5);
    let s = 0, n = 0;
    for (let i = 0; i < W * H; i++) {
        if (!mask[i]) continue;
        const va = maa[i] - ma[i] * ma[i], vb = mbb[i] - mb[i] * mb[i], cov = mab[i] - ma[i] * mb[i];
        s += ((2 * ma[i] * mb[i] + C1) * (2 * cov + C2)) / ((ma[i] * ma[i] + mb[i] * mb[i] + C1) * (va + vb + C2));
        n++;
    }
    return n ? s / n : 0;
}

/** Judges an enhanced crop against the transferred original over `mask` (texels of the chart). */
export function enhancementGate(original: RgbaImage8, candidate: RgbaImage8, mask: Uint8Array, t: EnhanceGateThresholds = DEFAULT_ENHANCE_GATE): EnhanceGateResult {
    const W = original.width, H = original.height;
    if (candidate.width !== W || candidate.height !== H) throw new Error('enhancementGate: candidate and original sizes differ');
    let texels = 0;
    for (let i = 0; i < W * H; i++) if (mask[i]) texels++;
    const Lo = lumaOf(original), Lc = lumaOf(candidate);

    // Interior mask: the chart minus a 2 px border, so crop fill outside the chart never counts as an edge.
    const inner = new Uint8Array(W * H);
    for (let y = 2; y < H - 2; y++) for (let x = 2; x < W - 2; x++) {
        let ok = 1;
        for (let dy = -2; dy <= 2 && ok; dy++) for (let dx = -2; dx <= 2; dx++) if (!mask[(y + dy) * W + x + dx]) { ok = 0; break; }
        inner[y * W + x] = ok;
    }
    const So = sobelMagnitude(blur1(Lo, W, H, t.edgeScaleSigmaPx), W, H), Sc = sobelMagnitude(blur1(Lc, W, H, t.edgeScaleSigmaPx), W, H);
    const edgeNcc = maskedNcc(So, Sc, inner).ncc;

    const Eo = edgeMap(Lo, W, H, inner, 0.85, t.edgeScaleSigmaPx), Ec = edgeMap(Lc, W, H, inner, 0.85, t.edgeScaleSigmaPx);
    const dist = exactDistanceTransform(Eo, W, H);
    let candEdges = 0, far = 0;
    for (let i = 0; i < W * H; i++) if (Ec[i]) { candEdges++; if (dist[i] > t.maxNewEdgeDistPx) far++; }
    const newEdgeShare = candEdges ? far / candEdges : 0;

    const lowO = blur1(Lo, W, H, t.lowBandSigmaPx), lowC = blur1(Lc, W, H, t.lowBandSigmaPx);
    const lowBandSsim = maskedSsim(lowO, lowC, W, H, inner);

    const chan = (img: RgbaImage8, k: number) => { const c = new Float32Array(W * H); for (let i = 0; i < W * H; i++) c[i] = SRGB8_TO_LINEAR[img.rgba[i * 4 + k]]; return blur1(c, W, H, t.lowBandSigmaPx); };
    const oR = chan(original, 0), oG = chan(original, 1), oB = chan(original, 2), cR = chan(candidate, 0), cG = chan(candidate, 1), cB = chan(candidate, 2);
    let dE = 0, nE = 0;
    for (let i = 0; i < W * H; i++) {
        if (!inner[i]) continue;
        dE += ciede2000(linearRgbToLab(oR[i], oG[i], oB[i]), linearRgbToLab(cR[i], cG[i], cB[i])); nE++;
    }
    const lowBandDeltaE = nE ? dE / nE : 0;
    const vo = laplacianVariance(Lo, W, H, inner).variance, vc = laplacianVariance(Lc, W, H, inner).variance;
    const sharpnessGain = vo > 0 ? vc / vo : (vc > 0 ? Infinity : 1);

    const metrics: EnhanceGateMetrics = { edgeNcc, newEdgeShare, lowBandSsim, lowBandDeltaE, sharpnessGain, texels };
    const f = (x: number | null, d = 3) => (x === null ? 'n/a' : x.toFixed(d));
    if (edgeNcc === null || edgeNcc < t.minEdgeNcc) return { pass: false, metrics, reasonCode: 'enhance_edges_moved', reason: `the enhanced crop's edges do not line up with the transferred texture (Sobel NCC ${f(edgeNcc)} < ${t.minEdgeNcc})` };
    if (newEdgeShare > t.maxNewEdgeShare) return { pass: false, metrics, reasonCode: 'enhance_new_structure', reason: `the enhanced crop adds structure: ${(100 * newEdgeShare).toFixed(1)} percent of its strong edges are more than ${t.maxNewEdgeDistPx} px from any edge of the transferred texture (limit ${(100 * t.maxNewEdgeShare).toFixed(1)})` };
    if (lowBandSsim < t.minLowBandSsim) return { pass: false, metrics, reasonCode: 'enhance_layout_changed', reason: `the enhanced crop's low-frequency layout differs from the transferred texture (SSIM ${f(lowBandSsim)} < ${t.minLowBandSsim})` };
    if (lowBandDeltaE > t.maxLowBandDeltaE) return { pass: false, metrics, reasonCode: 'enhance_colour_drift', reason: `the enhanced crop changed colour (mean low-band CIEDE2000 ${f(lowBandDeltaE, 2)} > ${t.maxLowBandDeltaE})` };
    if (sharpnessGain < t.minSharpnessGain) return { pass: false, metrics, reasonCode: 'enhance_no_gain', reason: `the enhanced crop is not sharper than the transferred texture (Laplacian variance ratio ${f(sharpnessGain, 2)} < ${t.minSharpnessGain})` };
    return { pass: true, metrics };
}

// =============================================================================
// Crops and grounding references
// =============================================================================

/** Bilinear resize of an RGBA8 image. */
export function resizeRgba(img: RgbaImage8, width: number, height: number): RgbaImage8 {
    if (img.width === width && img.height === height) return img;
    const out = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const fx = ((x + 0.5) * img.width) / width - 0.5, fy = ((y + 0.5) * img.height) / height - 0.5;
        const x0 = Math.max(0, Math.min(img.width - 1, Math.floor(fx))), y0 = Math.max(0, Math.min(img.height - 1, Math.floor(fy)));
        const x1 = Math.min(img.width - 1, x0 + 1), y1 = Math.min(img.height - 1, y0 + 1);
        const tx = Math.max(0, Math.min(1, fx - x0)), ty = Math.max(0, Math.min(1, fy - y0));
        for (let k = 0; k < 4; k++) {
            const a = img.rgba[(y0 * img.width + x0) * 4 + k], b = img.rgba[(y0 * img.width + x1) * 4 + k];
            const c = img.rgba[(y1 * img.width + x0) * 4 + k], d = img.rgba[(y1 * img.width + x1) * 4 + k];
            out[(y * width + x) * 4 + k] = Math.round((a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty);
        }
    }
    return { width, height, rgba: out };
}

/** A real Street View view usable as a grounding reference (a ProjectionView carries these fields). */
export interface EnhanceReferenceView { panoId: string; camera: PinholeCamera; image: DecodedImage }

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** The views that see a chart, best first: share of chart texels inside the frame and facing the camera, over distance. */
export function pickReferenceViews(points: Vec3[], normals: Vec3[], views: EnhanceReferenceView[], max: number, minVisibleShare = 0.25):
    Array<{ view: EnhanceReferenceView; rect: [number, number, number, number]; visibleShare: number; distanceM: number }> {
    const scored = views.map(view => {
        const cam = view.camera;
        let seen = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, dsum = 0;
        points.forEach((p, k) => {
            const d = sub(p, cam.eye);
            const z = dot(d, cam.fwd);
            if (z <= 0.1 || dot(d, normals[k]) >= 0) return; // behind, or the surface faces away
            const x = cam.cx + (cam.fx * dot(d, cam.right)) / z, y = cam.cy - (cam.fy * dot(d, cam.up)) / z;
            if (x < 0 || y < 0 || x >= cam.width || y >= cam.height) return;
            seen++; dsum += Math.hypot(d[0], d[1], d[2]);
            x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
        });
        const visibleShare = points.length ? seen / points.length : 0;
        const pad = 0.1 * Math.max(x1 - x0, y1 - y0, 1);
        const rect: [number, number, number, number] = [
            Math.max(0, Math.floor(x0 - pad)), Math.max(0, Math.floor(y0 - pad)),
            Math.min(cam.width, Math.ceil(x1 + pad)), Math.min(cam.height, Math.ceil(y1 + pad))
        ];
        return { view, rect, visibleShare, distanceM: seen ? dsum / seen : Infinity };
    });
    return scored
        .filter(s => s.visibleShare >= minVisibleShare && s.rect[2] - s.rect[0] >= 8 && s.rect[3] - s.rect[1] >= 8)
        .sort((a, b) => b.visibleShare / b.distanceM - a.visibleShare / a.distanceM || a.view.panoId.localeCompare(b.view.panoId))
        .slice(0, max);
}

function cropRgba(img: DecodedImage, rect: [number, number, number, number]): RgbaImage8 {
    const [x0, y0, x1, y1] = rect, w = x1 - x0, h = y1 - y0;
    const out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) out.set(img.rgba.subarray(((y0 + y) * img.width + x0) * 4, ((y0 + y) * img.width + x1) * 4), y * w * 4);
    return { width: w, height: h, rgba: out };
}

const png = (img: RgbaImage8): Uint8Array => new Uint8Array(encodePng(img.width, img.height, Buffer.from(img.rgba.buffer, img.rgba.byteOffset, img.rgba.byteLength)));

/** The instruction sent with each crop. Enhance only; nothing moves. */
export function enhancePrompt(width: number, height: number, referenceCount: number): string {
    return [
        `The first image is a ${width} x ${height} px albedo texture of one building surface, transferred from photogrammetry, so it is soft and slightly smeared.`,
        `Return the same texture, ${width} x ${height} px, enhanced only: restore the sharpness and fine surface detail of features that are already visible, at low strength.`,
        'Keep every feature exactly where it is, at the same size and shape. Do not add, remove, move, straighten, repeat or restyle anything. Keep the colours and the overall brightness.',
        'Do not add lighting, shadows, reflections, people, vehicles, signs or text. Keep the framing: no crop, zoom, rotation or border.',
        referenceCount
            ? `The ${referenceCount === 1 ? 'next image is a real street-level photo' : `next ${referenceCount} images are real street-level photos`} of the same surface: use them only to recover the true detail of features the texture already shows.`
            : ''
    ].filter(Boolean).join(' ');
}

// =============================================================================
// Enhancement over the atlas
// =============================================================================

export interface EnhanceTransferInput {
    atlas: UvAtlas;
    /** The tile transfer planes (only texels with alpha 255 are candidates). */
    transfer: BakedTexturePlanes;
    /** Registered real views (Street View), for grounding references. */
    views: EnhanceReferenceView[];
    client: EnhanceModelClient;
    /** Models to try in order; default IMAGE_MODEL_PRIORITY. */
    models?: string[];
    gate?: Partial<EnhanceGateThresholds>;
    /** Reference views per chart. Default 3. */
    maxReferences?: number;
    /** Charts with fewer transferred texels are left alone. Default 64. */
    minChartTexels?: number;
    /** Largest side of a grounding reference sent to the model (JPEG). Default ENHANCE_REFERENCE_MAX_SIDE. */
    maxReferenceSide?: number;
    /** Largest crop side sent to the model; larger crops are box-downsampled and the answer resized back. Default 2048. */
    maxModelSide?: number;
    /** Charts in flight at once. Default 12 (a call takes 10 to 20 s; the wall clock, not the cost, is the limit). */
    concurrency?: number;
    signal?: AbortSignal;
    /**
     * The enhancement's own time budget. When it fires, no new chart starts, charts in flight are abandoned (decision
     * 'timeout'), and the charts already accepted are kept: the result is partial, never discarded. `signal` (the
     * stage's stop) still aborts everything.
     */
    budgetSignal?: AbortSignal;
}

export type ChartEnhanceDecision = 'accepted' | 'rejected' | 'model_failed' | 'skipped' | 'timeout' | (string & {});

export interface ChartEnhanceRecord {
    mapIndex: number;
    label: string;
    texels: number;
    decision: ChartEnhanceDecision;
    reasonCode?: string;
    reason?: string;
    referencePanoIds: string[];
    modelUsed?: string;
    modelNote?: string;
    metrics?: EnhanceGateMetrics;
}

export interface EnhanceTransferResult {
    planes: BakedTexturePlanes;
    charts: ChartEnhanceRecord[];
    modelsUsed: string[];
    costUsd?: number;
}

interface ChartJob {
    mapIndex: number; label: string; rect: [number, number, number, number]; mask: Uint8Array; texelIndex: Int32Array; crop: RgbaImage8; count: number;
    /** Texels the gate can judge (the chart minus a 2 px border) and the share of the crop the chart fills. */
    gateable: number; fill: number;
}

/** Fewest texels the gate can judge (inside a 2 px border) for a chart to be sent: below it the gate has nothing to measure. */
/** Grounding references are sent as JPEG at most this long on their longest side. */
export const ENHANCE_REFERENCE_MAX_SIDE = 1024;
export const MIN_GATEABLE_TEXELS = 256;
/** Least share of its crop a chart must fill: a few scattered fragments in a crop of flat fill give the model nothing to sharpen and room to invent. */
export const MIN_CHART_FILL = 0.3;

function chartJobs(atlas: UvAtlas, transfer: BakedTexturePlanes, minTexels: number): ChartJob[] {
    const W = atlas.width, H = atlas.height;
    return atlas.maps.map((m, mapIndex) => {
        const [u0, v0, u1, v1] = m.atlasRect;
        let x0 = Math.max(0, Math.floor(u0 * W)), y0 = Math.max(0, Math.floor(v0 * H)), x1 = Math.min(W, Math.ceil(u1 * W)), y1 = Math.min(H, Math.ceil(v1 * H));
        // the crop is the box of the chart's transferred texels (2 px margin), not the whole map rectangle
        let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
            const i = y * W + x;
            if (atlas.texels.mapIndex[i] !== mapIndex || atlas.texels.gutter[i] || !transfer.albedo[i * 4 + 3]) continue;
            if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y;
        }
        if (bx1 >= bx0) { x0 = Math.max(x0, bx0 - 2); y0 = Math.max(y0, by0 - 2); x1 = Math.min(x1, bx1 + 3); y1 = Math.min(y1, by1 + 3); }
        const w = Math.max(0, x1 - x0), h = Math.max(0, y1 - y0);
        const mask = new Uint8Array(w * h), texelIndex = new Int32Array(w * h).fill(-1), rgba = new Uint8Array(w * h * 4);
        let count = 0; const sum = [0, 0, 0];
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const i = (y0 + y) * W + x0 + x, j = y * w + x;
            if (atlas.texels.mapIndex[i] !== mapIndex || atlas.texels.gutter[i] || !transfer.albedo[i * 4 + 3]) continue;
            mask[j] = 1; texelIndex[j] = i; count++;
            rgba.set(transfer.albedo.subarray(i * 4, i * 4 + 4), j * 4);
            for (let k = 0; k < 3; k++) sum[k] += transfer.albedo[i * 4 + k];
        }
        // Texels outside the chart get the chart's mean colour (never read back), so the crop has no false edges at its holes.
        if (count) for (let j = 0; j < w * h; j++) if (!mask[j]) rgba.set([Math.round(sum[0] / count), Math.round(sum[1] / count), Math.round(sum[2] / count), 255], j * 4);
        let gateable = 0;
        for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
            let ok = 1;
            for (let dy = -2; dy <= 2 && ok; dy++) for (let dx = -2; dx <= 2; dx++) if (!mask[(y + dy) * w + x + dx]) { ok = 0; break; }
            gateable += ok;
        }
        return { mapIndex, label: `${m.nodeName}${m.chartId ? `/${m.chartId}` : ''}`, rect: [x0, y0, x1, y1] as [number, number, number, number], mask, texelIndex, crop: { width: w, height: h, rgba }, count, gateable, fill: w * h ? count / (w * h) : 0 };
    }).filter(j => j.count >= minTexels);
}

/**
 * The crop padded (with its own edge colour fill, centred) to the image model's nearest supported aspect ratio, so the
 * answer comes back at the crop's own proportions: resizing an answer of another aspect back onto the crop stretched it by
 * up to 6 percent on the live charts, which the gate reads as moved edges.
 */
export function padToModelAspect(img: RgbaImage8): { padded: RgbaImage8; offset: [number, number] } {
    const name = nearestImageAspectRatio(img.width, img.height);
    const r = IMAGE_MODEL_ASPECT_RATIOS.find(a => a[0] === name)?.[1] ?? img.width / img.height;
    const W = Math.max(img.width, Math.round(img.height * r)), H = Math.max(img.height, Math.round(img.width / r));
    if (W === img.width && H === img.height) return { padded: img, offset: [0, 0] };
    const ox = Math.floor((W - img.width) / 2), oy = Math.floor((H - img.height) / 2);
    const out = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const sx = Math.min(img.width - 1, Math.max(0, x - ox)), sy = Math.min(img.height - 1, Math.max(0, y - oy));
        out.set(img.rgba.subarray((sy * img.width + sx) * 4, (sy * img.width + sx) * 4 + 4), (y * W + x) * 4);
    }
    return { padded: { width: W, height: H, rgba: out }, offset: [ox, oy] };
}

function cropImage(img: RgbaImage8, x0: number, y0: number, w: number, h: number): RgbaImage8 {
    const out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) out.set(img.rgba.subarray(((y0 + y) * img.width + x0) * 4, ((y0 + y) * img.width + x0 + w) * 4), y * w * 4);
    return { width: w, height: h, rgba: out };
}

function boxDownsample(img: RgbaImage8, maxSide: number): RgbaImage8 {
    const s = Math.max(img.width, img.height) / maxSide;
    if (s <= 1) return img;
    return resizeRgba(img, Math.max(1, Math.round(img.width / s)), Math.max(1, Math.round(img.height / s)));
}

/** Enhances the transferred texels chart by chart; returns new planes plus a per-chart record. */
export async function enhanceTransferredAtlas(input: EnhanceTransferInput): Promise<EnhanceTransferResult> {
    const { atlas, transfer, views, client, budgetSignal } = input;
    const outer = input.signal;
    // what a model request listens to: the stage's stop and the budget
    const signal = outer && budgetSignal ? AbortSignal.any([outer, budgetSignal]) : (outer ?? budgetSignal);
    const gate = { ...DEFAULT_ENHANCE_GATE, ...(input.gate || {}) };
    const models = input.models?.length ? input.models : [...IMAGE_MODEL_PRIORITY];
    const maxSide = input.maxModelSide ?? 2048;
    const jobs = chartJobs(atlas, transfer, input.minChartTexels ?? 64);
    const runJob = async (job: ChartJob): Promise<{ record: ChartEnhanceRecord; enhanced?: RgbaImage8; costUsd?: number }> => {
        const base: ChartEnhanceRecord = { mapIndex: job.mapIndex, label: job.label, texels: job.count, decision: 'skipped', referencePanoIds: [] };
        // Grounding: chart texel positions (subsampled) projected into each view.
        const pts: Vec3[] = [], nrm: Vec3[] = [];
        const step = Math.max(1, Math.floor(Math.sqrt(job.count / 256)));
        const w = job.crop.width;
        for (let j = 0; j < job.mask.length; j++) {
            if (!job.mask[j] || ((j % w) % step) || (Math.floor(j / w) % step)) continue;
            const i = job.texelIndex[j], P = atlas.texels.position, N = atlas.texels.normal;
            pts.push([P[i * 3], P[i * 3 + 1], P[i * 3 + 2]]); nrm.push([N[i * 3], N[i * 3 + 1], N[i * 3 + 2]]);
        }
        const refs = pickReferenceViews(pts, nrm, views, input.maxReferences ?? 3);
        base.referencePanoIds = refs.map(r => r.view.panoId);
        if (!refs.length) {
            return { record: { ...base, reasonCode: 'enhance_no_reference', reason: `no registered Street View view sees ${job.label}, so there is nothing real to ground an enhancement; the transferred texture is kept` } };
        }
        if (job.gateable < MIN_GATEABLE_TEXELS || job.fill < MIN_CHART_FILL) {
            return { record: { ...base, reasonCode: 'enhance_not_gateable', reason: job.gateable < MIN_GATEABLE_TEXELS
                ? `${job.label} has only ${job.gateable} texels inside its border for the edge gate to judge (fewer than ${MIN_GATEABLE_TEXELS}), so it was not sent; the transferred texture is kept`
                : `${job.label}'s transferred texels fill only ${(100 * job.fill).toFixed(0)} percent of their crop (scattered fragments), so it was not sent; the transferred texture is kept` } };
        }
        const { padded, offset } = padToModelAspect(job.crop);
        const sent = boxDownsample(padded, maxSide);
        const request: EnhanceModelRequest = {
            label: job.label, models, prompt: enhancePrompt(sent.width, sent.height, refs.length),
            image: { mimeType: 'image/png', bytes: png(sent), width: sent.width, height: sent.height },
            // the references only ground the model in what the surface looks like: JPEG at ENHANCE_REFERENCE_MAX_SIDE is plenty, and
            // much less to send than a lossless crop of up to maxSide (the crop being enhanced stays lossless at maxSide)
            references: await Promise.all(refs.map(async r => {
                const ref = boxDownsample(cropRgba(r.view.image, r.rect), Math.min(maxSide, input.maxReferenceSide ?? ENHANCE_REFERENCE_MAX_SIDE));
                return { panoId: r.view.panoId, mimeType: 'image/jpeg' as const, bytes: await encodeRgbaToJpeg(Buffer.from(ref.rgba.buffer, ref.rgba.byteOffset, ref.rgba.byteLength), ref.width, ref.height, { quality: 90 }) };
            })),
            signal
        };
        let answer: EnhanceModelAnswer;
        try {
            answer = await client(request);
        } catch (error) {
            // Only a model failure degrades; anything else (an abort, a bug, an unrecorded replay call) propagates.
            if (signal?.aborted || !(error instanceof MediaModelUnavailableError)) throw error;
            const message = error.message;
            return { record: { ...base, decision: 'model_failed', reasonCode: 'enhance_model_failed', reason: `the image model did not enhance ${job.label}: ${message}` } };
        }
        const withModel = { ...base, modelUsed: answer.modelUsed, modelNote: answer.modelNote };
        let decoded: RgbaImage8;
        try {
            decoded = decodeImageInMemory(answer.bytes);
        } catch (error) {
            return { record: { ...withModel, decision: 'model_failed', reasonCode: 'enhance_answer_undecodable', reason: `${answer.modelUsed} answered ${job.label} with an image that cannot be decoded (${(error as Error).message})` }, costUsd: answer.costUsd };
        }
        const candidate = cropImage(resizeRgba(decoded, padded.width, padded.height), offset[0], offset[1], job.crop.width, job.crop.height);
        const verdict = enhancementGate(job.crop, candidate, job.mask, gate);
        if (!verdict.pass) {
            return { record: { ...withModel, decision: 'rejected', reasonCode: verdict.reasonCode, reason: `${answer.modelUsed} enhanced ${job.label} but ${verdict.reason}; the transferred texture is kept`, metrics: verdict.metrics }, costUsd: answer.costUsd };
        }
        return { record: { ...withModel, decision: 'accepted', metrics: verdict.metrics }, enhanced: candidate, costUsd: answer.costUsd };
    };

    // Bounded concurrency, results kept in chart order. Past the budget a chart is recorded as timed out (in flight: abandoned,
    // even when the client ignores the abort; not started: never sent) and the finished charts stand.
    type JobResult = Awaited<ReturnType<typeof runJob>>;
    const timedOut = (job: ChartJob, started: boolean): JobResult => ({ record: {
        mapIndex: job.mapIndex, label: job.label, texels: job.count, decision: 'timeout', referencePanoIds: [], reasonCode: 'enhance_timeout',
        reason: `the enhancement's time budget ran out ${started ? 'while the model was answering' : 'before'} ${job.label}; the transferred texture is kept`
    } });
    const budgetOver = budgetSignal ? new Promise<'budget'>(resolve => {
        if (budgetSignal.aborted) resolve('budget'); else budgetSignal.addEventListener('abort', () => resolve('budget'), { once: true });
    }) : undefined;
    const results: JobResult[] = new Array(jobs.length);
    let next = 0;
    const worker = async () => {
        while (next < jobs.length) {
            const k = next++;
            if (outer?.aborted) throw outer.reason instanceof Error ? outer.reason : new Error('enhancement aborted');
            if (budgetSignal?.aborted) { results[k] = timedOut(jobs[k], false); continue; }
            const running = runJob(jobs[k]);
            if (!budgetOver) { results[k] = await running; continue; }
            running.catch(() => undefined);
            const r = await Promise.race([running.then(v => ({ v }), e => ({ e })), budgetOver]);
            if (r === 'budget') { if (outer?.aborted) throw outer.reason; results[k] = timedOut(jobs[k], true); continue; }
            if ('e' in r) {
                if (budgetSignal?.aborted && !outer?.aborted) { results[k] = timedOut(jobs[k], true); continue; }
                throw r.e;
            }
            results[k] = r.v;
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(input.concurrency ?? 12, jobs.length)) }, worker));
    const timeouts = results.filter(r => r.record.decision === 'timeout');

    const albedo = Uint8Array.from(transfer.albedo);
    const confidence: ConfidencePlane = { width: transfer.width, height: transfer.height, data: Uint8Array.from(transfer.confidence.data) };
    const enhancedIndex = transfer.provenance.length;
    let enhancedTexels = 0;
    const accepted: ChartEnhanceRecord[] = [];
    const degradations: TexturePassDegradation[] = [...transfer.degradations];
    const atlasTexels = atlas.texels.covered.reduce((s: number, c: number) => s + (c ? 1 : 0), 0);
    let costUsd: number | undefined;
    results.forEach((r, k) => {
        if (r.costUsd !== undefined) costUsd = (costUsd ?? 0) + r.costUsd;
        const job = jobs[k];
        if (!r.enhanced) {
            if (r.record.reasonCode && r.record.decision !== 'timeout') {
                degradations.push({
                    stage: 'enhance', reasonCode: r.record.reasonCode, reason: r.record.reason || r.record.reasonCode, layerKey: atlas.layerKey,
                    fromRung: TILE_TRANSFER_RUNG, toRung: TILE_TRANSFER_RUNG, texelShare: atlasTexels ? job.count / atlasTexels : 0
                });
            }
            return;
        }
        accepted.push(r.record);
        for (let j = 0; j < job.mask.length; j++) {
            if (!job.mask[j]) continue;
            const i = job.texelIndex[j];
            albedo[i * 4] = r.enhanced.rgba[j * 4]; albedo[i * 4 + 1] = r.enhanced.rgba[j * 4 + 1]; albedo[i * 4 + 2] = r.enhanced.rgba[j * 4 + 2]; albedo[i * 4 + 3] = 255;
            const c = unpackConfidenceTexel(transfer.confidence, i);
            packConfidenceTexel(confidence, i, enhancedIndex, c.weight01, c.rung);
            enhancedTexels++;
        }
    });

    if (timeouts.length) {
        const share = timeouts.reduce((s, r) => s + r.record.texels, 0);
        degradations.push({
            stage: 'enhance', reasonCode: 'enhance_timeout', layerKey: atlas.layerKey, fromRung: TILE_TRANSFER_RUNG, toRung: TILE_TRANSFER_RUNG,
            texelShare: atlasTexels ? share / atlasTexels : 0,
            reason: `The enhancement's time budget ran out with ${timeouts.length} of ${jobs.length} charts unfinished; their de-lit tile transfer stands unenhanced, and the ${accepted.length} chart${accepted.length === 1 ? '' : 's'} already accepted are kept.`
        });
    }

    // Provenance: the transfer entries lose the enhanced texels, which get their own entry naming the model(s).
    const provenance: TexelProvenance[] = transfer.provenance.map(p => ({ ...p }));
    const modelsUsed = Array.from(new Set(accepted.map(r => r.modelUsed!).filter(Boolean)));
    if (enhancedTexels) {
        const share = atlasTexels ? enhancedTexels / atlasTexels : 0;
        const replaced = new Map<number, number>();
        results.forEach((r, k) => {
            if (!r.enhanced) return;
            const job = jobs[k];
            for (let j = 0; j < job.mask.length; j++) if (job.mask[j]) {
                const idx = unpackConfidenceTexel(transfer.confidence, job.texelIndex[j]).provenanceIndex;
                replaced.set(idx, (replaced.get(idx) || 0) + 1);
            }
        });
        replaced.forEach((n, idx) => { if (provenance[idx]) provenance[idx].coverage = Math.max(0, provenance[idx].coverage - (atlasTexels ? n / atlasTexels : 0)); });
        const notes = Array.from(new Set(accepted.map(r => r.modelNote).filter(Boolean)));
        provenance.push({
            source: 'tile-photo-enhanced', label: 'photo-inferred',
            method: `tile photo transfer sharpened by ${modelsUsed.join(', ')} (Gemini image edit, enhance only, grounded by ${new Set(accepted.flatMap(r => r.referencePanoIds)).size} real Street View views), `
                + `edge gate Sobel NCC >= ${gate.minEdgeNcc}, new structure <= ${gate.maxNewEdgeDistPx} px; ${accepted.length} of ${jobs.length} charts accepted. ${notes.join(' ')}`.trim(),
            panoIds: Array.from(new Set(accepted.flatMap(r => r.referencePanoIds))).sort(),
            coverage: share
        });
    }
    return {
        planes: { layerKey: transfer.layerKey, width: transfer.width, height: transfer.height, albedo, confidence, provenance, degradations, ...(transfer.paletteDeltaE !== undefined ? { paletteDeltaE: transfer.paletteDeltaE } : {}) },
        charts: results.map(r => r.record),
        modelsUsed,
        ...(costUsd !== undefined ? { costUsd } : {})
    };
}
