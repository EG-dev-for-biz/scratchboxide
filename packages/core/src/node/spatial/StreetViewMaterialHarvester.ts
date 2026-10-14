/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Street View material harvester: the texture agent's capture step.
 *
 * Projective texturing needs pixel-exact camera poses; this path does not. It treats each Street View frame as a
 * source of MATERIAL SAMPLES (swatches), not as a plate to paint through:
 *
 *   1. Segment: Gemini proposes clean patches of single surface materials (open-string labels, polygons in pixel
 *      space, continuous physical hints: surface tilt, metalness, roughness) and planar facade quads.
 *   2. Plane: each patch's surface plane comes from the base mesh at the frame's pose (robust RANSAC on the
 *      rendered depth) or from the Gemini facade quad (rectangle-from-quad with the known intrinsics, metric scale
 *      from the mesh depth). Only the plane's ORIENTATION relative to the camera matters for rectification, and a
 *      rotation error of a degree or two changes it negligibly; translation error only scales metres-per-pixel by a
 *      few percent. Misregistration therefore never ghosts here.
 *   3. Rectify: the patch is resampled fronto-parallel at an isotropic metric scale (the coarse axis of the photo
 *      footprint, anti-aliased by supersampling), the largest clean rectangle is cropped (period-aligned when the
 *      material is periodic), flat-fielded and made tileable with the periodic + smooth decomposition (Moisan
 *      2011): no mirroring, no cross-fade ghosts.
 *   4. Texture agent kernel: the tileable swatch runs through the native PBR field estimator that the
 *      image_to_adaptive_pbr_plane tool calls (NativeMaterialPbrService, Node fallback), wrap-padded so the
 *      albedo / normal / ORM maps tile exactly.
 *   5. Library: label, source frame, metres-per-pixel, colour statistics of the swatch AND of the scan tile at the
 *      same surface (the classifier compares tile with tile), source geometry (tilt, height above ground), quality.
 *
 * Gates are continuous measurements (incidence cosine, resolution gain over the tile texel, occluded fraction,
 * illumination range, axis deviation of rectified lines, crop size). Labels are open strings and never branch
 * execution. Street View pixels stay in the local, gitignored output directory.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { encodePng } from '../texture-processing';
import { NativeMaterialPbrService } from '../3d-engine/native-material-pbr-service';
import { AdaptiveMaterialPbrService } from '../3d-engine/adaptive-material-pbr-service';
import type { AdaptiveMaterialSchema, ContinuousBiophysicalFields } from '../../common/adaptive-material-types';
import {
    type FrameCamera, type OccluderBox, type GeminiContentClient, type TexturedPrimitive,
    renderTexturedView, buildValidMask, gaussianBlur, STREETVIEW_GEMINI_MODEL, PLATE_EMPTY_DEPTH
} from './StreetViewPoseRegistrar';
import { linearRgbToLab } from './StreetViewStage3Metrics';

export type Vec3 = [number, number, number];

// ============================================================================================
// Inputs
// ============================================================================================

/** One cached Street View frame with its camera in the scan frame. */
export interface HarvestFrameInput {
    /** Frame id (cache key, e.g. `<pano>_h<heading>_p<pitch>_f<fov>`). */
    key: string;
    panoId?: string;
    date?: string;
    /** Encoded image (sent to the segmenter). */
    image: Buffer;
    /** Decoded RGBA8, row 0 = top. */
    rgba: Buffer;
    width: number;
    height: number;
    camera: FrameCamera;
    /** Pose provenance, diagnostic only (e.g. 'registered-accepted', 'registered', 'prior'). */
    poseSource: string;
    /** Continuous pose confidence in [0, 1]; recorded with each sample and used to weight the sample's quality. */
    poseConfidence: number;
    /** Occluder boxes (pixels) from an earlier detector; masked out of every sample. */
    occluders?: OccluderBox[];
    /** Rows at the bottom carrying the watermark. Default 24. */
    watermarkBottomPx?: number;
}

// ============================================================================================
// Segmentation (Gemini) contract
// ============================================================================================

export interface MaterialDescriptorProposal {
    /** Open descriptive label (never a closed category). */
    label: string;
    description: string;
    /** 0 = horizontal (ground, roof), 90 = vertical wall; null when not given. */
    surfaceTiltDeg: number | null;
    metalness: number | null;
    roughness: number | null;
}

export interface MaterialSampleProposal {
    /** Index into `materials`. */
    materialIndex: number;
    /** Polygon in pixels (x right, y down). */
    polygon: Array<[number, number]>;
    /** Index into `facades` of the facade quad the sample lies on, or null. */
    facadeIndex: number | null;
    occludedFraction: number;
    evenlyLit: boolean;
}

export interface FacadeQuadProposal {
    label: string;
    /** Image corners (pixels) of a real-world rectangle: top-left, top-right, bottom-right, bottom-left. */
    corners: Array<[number, number]>;
}

export interface FrameMaterialSegmentation {
    model: string;
    promptVersion: number;
    width: number;
    height: number;
    materials: MaterialDescriptorProposal[];
    samples: MaterialSampleProposal[];
    facades: FacadeQuadProposal[];
}

export type MaterialSegmenter = (frame: HarvestFrameInput) => Promise<FrameMaterialSegmentation>;

/** Bump when MATERIAL_SEGMENTATION_PROMPT changes: cached segmentations with another version are re-requested. */
export const MATERIAL_SEGMENTATION_PROMPT_VERSION = 1;

export function materialSegmentationPrompt(width: number, height: number): string {
    return `This is a ${width}x${height} street-level photograph. You are harvesting physically based material samples ` +
        '(texture swatches) for a 3D city model.\n' +
        '1. "facades": list every clearly visible flat building facade or large flat wall section. For each give "quad": the image ' +
        'positions of the four corners of a large RECTANGLE that lies on that facade in the real world (its sides follow real ' +
        'horizontal and vertical lines such as window rows, piers, cornices or building edges), ordered top-left, top-right, ' +
        'bottom-right, bottom-left as seen in the image.\n' +
        '2. "materials": list the distinct surface materials of the buildings and of the ground. Name each with a precise, open, ' +
        'descriptive label in your own words (for example the stone type and its coursing, the brick colour and bond, the metal ' +
        'and its finish, glazing with its mullions, the road or pavement surface); do not choose from a fixed list. For each ' +
        'material estimate "surface_tilt_deg" (0 = horizontal ground or roof, 90 = vertical wall), "metalness" (0..1) and ' +
        '"roughness" (0..1), and give up to 3 "samples": polygons that tightly enclose CLEAN patches containing ONLY that ' +
        'material on ONE flat surface: no people, vehicles, poles, trees, signs, logos, lettering, sky, other materials, and no ' +
        'sharp shadow edges. Make each sample as large as possible while staying clean. For each sample give "facade" (the ' +
        'index of the facade quad it lies on, or -1), "occluded_fraction" (0..1) and "evenly_lit" (true/false).\n' +
        'Use coordinates [y, x] normalised to 0-1000 (like box_2d). Ignore the bottom 4% of the image (watermark).\n' +
        'Respond with JSON only: {"facades":[{"label":string,"quad":[[y,x],[y,x],[y,x],[y,x]]}],' +
        '"materials":[{"label":string,"description":string,"surface_tilt_deg":number,"metalness":number,"roughness":number,' +
        '"samples":[{"polygon":[[y,x],...],"box_2d":[ymin,xmin,ymax,xmax],"facade":number,"occluded_fraction":number,"evenly_lit":boolean}]}]}';
}

function parseJsonLoose(text: string): any {
    const t = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    try { return JSON.parse(t); } catch { /* fall through */ }
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
    throw new Error('segmentation response is not JSON');
}

const finiteOr = (v: unknown, fallback: number | null): number | null => {
    const n = Number(v);
    return v !== null && v !== undefined && v !== '' && Number.isFinite(n) ? n : fallback;
};
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Normalised [y, x] (0..1000) point list -> pixel (x, y) list; null when malformed. */
function normPoints(list: unknown, width: number, height: number): Array<[number, number]> | null {
    if (!Array.isArray(list)) return null;
    const out: Array<[number, number]> = [];
    for (const p of list) {
        if (!Array.isArray(p) || p.length < 2) return null;
        const y = Number(p[0]), x = Number(p[1]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        out.push([clamp01(x / 1000) * width, clamp01(y / 1000) * height]);
    }
    return out;
}

/** Validates and converts a raw segmentation response (normalised coordinates) to pixels. */
export function parseMaterialSegmentation(raw: any, width: number, height: number, model: string, promptVersion = MATERIAL_SEGMENTATION_PROMPT_VERSION): FrameMaterialSegmentation {
    const facades: FacadeQuadProposal[] = [];
    const facadeMap = new Map<number, number>();
    (Array.isArray(raw?.facades) ? raw.facades : []).forEach((f: any, i: number) => {
        const q = normPoints(f?.quad, width, height);
        if (!q || q.length !== 4) return;
        facadeMap.set(i, facades.length);
        facades.push({ label: String(f?.label ?? 'facade'), corners: q });
    });
    const materials: MaterialDescriptorProposal[] = [];
    const samples: MaterialSampleProposal[] = [];
    for (const m of Array.isArray(raw?.materials) ? raw.materials : []) {
        const label = String(m?.label ?? '').trim();
        if (!label) continue;
        const mi = materials.length;
        materials.push({
            label,
            description: String(m?.description ?? ''),
            surfaceTiltDeg: finiteOr(m?.surface_tilt_deg, null),
            metalness: (() => { const v = finiteOr(m?.metalness, null); return v === null ? null : clamp01(v); })(),
            roughness: (() => { const v = finiteOr(m?.roughness, null); return v === null ? null : clamp01(v); })()
        });
        for (const s of Array.isArray(m?.samples) ? m.samples : []) {
            let poly = normPoints(s?.polygon, width, height);
            if (!poly || poly.length < 3) {
                const b = s?.box_2d;
                if (Array.isArray(b) && b.length === 4 && b.every((v: any) => Number.isFinite(Number(v)))) {
                    const [y0, x0, y1, x1] = b.map(Number);
                    poly = normPoints([[y0, x0], [y0, x1], [y1, x1], [y1, x0]], width, height);
                }
            }
            if (!poly || poly.length < 3) continue;
            const fi = finiteOr(s?.facade, -1);
            samples.push({
                materialIndex: mi,
                polygon: poly,
                facadeIndex: fi !== null && fi >= 0 && facadeMap.has(fi) ? facadeMap.get(fi)! : null,
                occludedFraction: clamp01(finiteOr(s?.occluded_fraction, 0) ?? 0),
                evenlyLit: s?.evenly_lit !== false
            });
        }
    }
    return { model, promptVersion, width, height, materials, samples, facades };
}

/** Rejects when `p` does not settle within `ms` (the request itself is abandoned, not aborted). */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const t = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms); });
    return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

/** Per-request timeout for multimodal calls (ms). Override with SCRATCHBOX_GEMINI_TIMEOUT_MS. */
export function geminiTimeoutMs(): number {
    const v = Number(process.env.SCRATCHBOX_GEMINI_TIMEOUT_MS);
    return Number.isFinite(v) && v > 0 ? v : 180_000;
}

/** One Gemini call: material samples and facade quads for a frame (retries malformed or timed-out responses). */
export async function segmentMaterialsWithGemini(
    client: GeminiContentClient, image: Buffer, width: number, height: number, model = STREETVIEW_GEMINI_MODEL, attempts = 3
): Promise<{ raw: any; segmentation: FrameMaterialSegmentation }> {
    const mimeType = image[0] === 0x89 ? 'image/png' : 'image/jpeg';
    for (let a = 1; ; a++) {
        try {
            const res = await withTimeout(client.models.generateContent({
                model,
                contents: [{ role: 'user', parts: [{ inlineData: { mimeType, data: image.toString('base64') } }, { text: materialSegmentationPrompt(width, height) }] }],
                config: { responseMimeType: 'application/json', temperature: a === 1 ? 0 : 0.2 }
            }), geminiTimeoutMs(), 'material segmentation');
            const raw = parseJsonLoose(res.text ?? '{}');
            return { raw, segmentation: parseMaterialSegmentation(raw, width, height, model) };
        } catch (e) {
            if (a >= attempts) throw e;
        }
    }
}

export interface CachedSegmenterOptions {
    model?: string;
    /** When false, only cached segmentations are used (frames without one throw). Default true. */
    allowNetwork?: boolean;
    /** Re-request even when a cache entry with the current prompt version exists. */
    refresh?: boolean;
}

/** Segmenter backed by an on-disk cache (`<cacheDir>/<frame key>.json`, keyed by prompt version). */
export function cachedGeminiSegmenter(client: GeminiContentClient | null, cacheDir: string, opts: CachedSegmenterOptions = {}): MaterialSegmenter {
    const model = opts.model ?? STREETVIEW_GEMINI_MODEL;
    return async (frame: HarvestFrameInput) => {
        const file = path.join(cacheDir, `${frame.key}.json`);
        if (!opts.refresh && fs.existsSync(file)) {
            const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (cached.promptVersion === MATERIAL_SEGMENTATION_PROMPT_VERSION && cached.raw) {
                return parseMaterialSegmentation(cached.raw, frame.width, frame.height, cached.model ?? model, cached.promptVersion);
            }
        }
        if (!client || opts.allowNetwork === false) throw new Error(`no cached segmentation for ${frame.key} (Gemini disabled or unavailable)`);
        const { raw, segmentation } = await segmentMaterialsWithGemini(client, frame.image, frame.width, frame.height, model);
        fs.mkdirSync(cacheDir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ model, promptVersion: MATERIAL_SEGMENTATION_PROMPT_VERSION, createdAt: new Date().toISOString(), raw }, null, 1));
        return segmentation;
    };
}

// ============================================================================================
// Small vector / colour helpers
// ============================================================================================

const DEG = Math.PI / 180;
const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: ArrayLike<number>, b: ArrayLike<number>): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: ArrayLike<number>): Vec3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const add = (a: ArrayLike<number>, b: ArrayLike<number>, s = 1): Vec3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const sub = (a: ArrayLike<number>, b: ArrayLike<number>): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale3 = (a: ArrayLike<number>, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];

/** Linear value of sRGB 250: pixels at or above it in any channel count as clipped. */
const CLIP_LINEAR = 0.955;
const SRGB_TO_LIN = (() => { const t = new Float32Array(256); for (let i = 0; i < 256; i++) { const c = i / 255; t[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); } return t; })();
export const srgb8ToLinear = (v: number): number => SRGB_TO_LIN[v < 0 ? 0 : v > 255 ? 255 : v | 0];
export const linearToSrgb8 = (v: number): number => {
    const c = v <= 0 ? 0 : v >= 1 ? 1 : v;
    return Math.round((c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055) * 255);
};

/** Deterministic PRNG (mulberry32). */
function rng32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function seedOf(text: string): number {
    return createHash('sha256').update(text).digest().readUInt32LE(0);
}

/** Camera-space ray (right, up, forward components; forward = 1) of a pixel position (pixel centres at +0.5). */
function pixelRayCam(cam: FrameCamera, u: number, v: number): Vec3 {
    return [(u - cam.cx) / cam.fx, -(v - cam.cy) / cam.fy, 1];
}
function camToWorldDir(cam: FrameCamera, c: ArrayLike<number>): Vec3 {
    return [
        cam.right[0] * c[0] + cam.up[0] * c[1] + cam.fwd[0] * c[2],
        cam.right[1] * c[0] + cam.up[1] * c[1] + cam.fwd[1] * c[2],
        cam.right[2] * c[0] + cam.up[2] * c[1] + cam.fwd[2] * c[2]
    ];
}
/** World point -> pixel position (pixel centres at +0.5) and camera-z, or null behind the camera. */
function projectPoint(cam: FrameCamera, p: ArrayLike<number>): [number, number, number] | null {
    const dx = p[0] - cam.eye[0], dy = p[1] - cam.eye[1], dz = p[2] - cam.eye[2];
    const z = dx * cam.fwd[0] + dy * cam.fwd[1] + dz * cam.fwd[2];
    if (z <= 1e-3) return null;
    return [cam.cx + cam.fx * (dx * cam.right[0] + dy * cam.right[1] + dz * cam.right[2]) / z, cam.cy - cam.fy * (dx * cam.up[0] + dy * cam.up[1] + dz * cam.up[2]) / z, z];
}

// ============================================================================================
// Raster helpers (exported for tests)
// ============================================================================================

/** Even-odd scanline fill of a polygon (pixel coordinates) into a W x H mask (pixel centres at +0.5). */
export function rasterizePolygon(poly: ArrayLike<readonly [number, number]>, W: number, H: number): Uint8Array {
    const m = new Uint8Array(W * H);
    const n = poly.length;
    if (n < 3) return m;
    const xs: number[] = [];
    for (let y = 0; y < H; y++) {
        const py = y + 0.5;
        xs.length = 0;
        for (let i = 0, j = n - 1; i < n; j = i++) {
            const [xi, yi] = poly[i], [xj, yj] = poly[j];
            if ((yi > py) !== (yj > py)) xs.push(xi + (py - yi) / (yj - yi) * (xj - xi));
        }
        xs.sort((a, b) => a - b);
        for (let k = 0; k + 1 < xs.length; k += 2) {
            const x0 = Math.max(0, Math.ceil(xs[k] - 0.5)), x1 = Math.min(W - 1, Math.floor(xs[k + 1] - 0.5));
            for (let x = x0; x <= x1; x++) m[y * W + x] = 1;
        }
    }
    return m;
}

/** Binary erosion with a (2r+1)^2 box. */
export function erodeMask(m: Uint8Array, W: number, H: number, r: number): Uint8Array {
    if (r <= 0) return Uint8Array.from(m);
    const tmp = new Uint8Array(W * H), out = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
        let run = 0;
        const row = y * W;
        // horizontal: pixel kept when all of [x-r, x+r] are set
        const pre = new Int32Array(W + 1);
        for (let x = 0; x < W; x++) pre[x + 1] = pre[x] + m[row + x];
        for (let x = 0; x < W; x++) {
            const a = x - r, b = x + r;
            if (a < 0 || b >= W) { tmp[row + x] = 0; continue; }
            run = pre[b + 1] - pre[a];
            tmp[row + x] = run === 2 * r + 1 ? 1 : 0;
        }
    }
    for (let x = 0; x < W; x++) {
        const pre = new Int32Array(H + 1);
        for (let y = 0; y < H; y++) pre[y + 1] = pre[y] + tmp[y * W + x];
        for (let y = 0; y < H; y++) {
            const a = y - r, b = y + r;
            out[y * W + x] = a >= 0 && b < H && pre[b + 1] - pre[a] === 2 * r + 1 ? 1 : 0;
        }
    }
    return out;
}

/**
 * Largest axis-aligned rectangle of set pixels, scored by area with the long side capped at `maxAspect` times
 * the short side (a capped rectangle is centred in the free span). Returns null when the mask is empty.
 */
export function largestValidRectangle(mask: Uint8Array, W: number, H: number, maxAspect = 4): { x: number; y: number; w: number; h: number } | null {
    const heights = new Int32Array(W);
    let best: { x: number; y: number; w: number; h: number } | null = null, bestScore = 0;
    const stack: number[] = [];
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) heights[x] = mask[y * W + x] ? heights[x] + 1 : 0;
        stack.length = 0;
        for (let x = 0; x <= W; x++) {
            const hx = x < W ? heights[x] : 0;
            while (stack.length && heights[stack[stack.length - 1]] >= hx) {
                const top = stack.pop()!;
                const hgt = heights[top];
                const left = stack.length ? stack[stack.length - 1] + 1 : 0;
                const wid = x - left;
                if (hgt <= 0 || wid <= 0) continue;
                const we = Math.min(wid, Math.floor(maxAspect * hgt)), he = Math.min(hgt, Math.floor(maxAspect * wid));
                const score = we * he;
                if (score > bestScore) {
                    bestScore = score;
                    best = { x: left + ((wid - we) >> 1), y: y - hgt + 1 + ((hgt - he) >> 1), w: we, h: he };
                }
            }
            stack.push(x);
        }
    }
    return best;
}

// ============================================================================================
// Plane estimation
// ============================================================================================

/** A planar surface frame in world space: P(s, t) = origin + s * uAxis + t * vAxis; normal faces the camera. */
export interface PlaneFrame {
    origin: Vec3;
    normal: Vec3;
    /** In-plane horizontal axis (image x of the rectified swatch). */
    uAxis: Vec3;
    /** In-plane axis pointing up (image -y of the rectified swatch). */
    vAxis: Vec3;
}

/** Eigen-decomposition of a symmetric 3x3 matrix (Jacobi). Returns eigenvalues ascending with column eigenvectors. */
export function symmetricEigen3(m: number[][]): { values: number[]; vectors: Vec3[] } {
    const a = m.map(r => r.slice());
    const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (let sweep = 0; sweep < 50; sweep++) {
        let off = 0;
        for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) off += a[p][q] * a[p][q];
        if (off < 1e-24) break;
        for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) {
            if (Math.abs(a[p][q]) < 1e-30) continue;
            const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
            const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
            const c = 1 / Math.sqrt(t * t + 1), s = t * c;
            for (let k = 0; k < 3; k++) {
                const akp = a[k][p], akq = a[k][q];
                a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq;
            }
            for (let k = 0; k < 3; k++) {
                const apk = a[p][k], aqk = a[q][k];
                a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk;
            }
            for (let k = 0; k < 3; k++) {
                const vkp = v[k][p], vkq = v[k][q];
                v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq;
            }
        }
    }
    const idx = [0, 1, 2].sort((i, j) => a[i][i] - a[j][j]);
    return { values: idx.map(i => a[i][i]), vectors: idx.map(i => [v[0][i], v[1][i], v[2][i]] as Vec3) };
}

export interface RansacPlaneResult {
    normal: Vec3;
    /** Plane offset: normal . x = offset. */
    offset: number;
    inliers: Uint8Array;
    inlierFraction: number;
    rmsMeters: number;
}

/**
 * Robust plane through world points: RANSAC with a depth-proportional threshold, then least squares (PCA)
 * on the inliers. `depths` are the camera distances used to scale the threshold.
 */
export function fitPlaneRansac(points: Float64Array, depths: Float64Array, opts: { iterations?: number; tolMeters?: number; tolPerMeter?: number; seed?: number } = {}): RansacPlaneResult | null {
    const n = points.length / 3;
    if (n < 12) return null;
    const iters = opts.iterations ?? 300, tol0 = opts.tolMeters ?? 0.25, tol1 = opts.tolPerMeter ?? 0.004;
    const rand = rng32(opts.seed ?? 1234);
    let bestCount = -1, bestN: Vec3 = [0, 1, 0], bestD = 0;
    for (let it = 0; it < iters; it++) {
        const i = (rand() * n) | 0, j = (rand() * n) | 0, k = (rand() * n) | 0;
        if (i === j || j === k || i === k) continue;
        const a: Vec3 = [points[i * 3], points[i * 3 + 1], points[i * 3 + 2]];
        const nn = cross(sub([points[j * 3], points[j * 3 + 1], points[j * 3 + 2]], a), sub([points[k * 3], points[k * 3 + 1], points[k * 3 + 2]], a));
        const l = Math.hypot(nn[0], nn[1], nn[2]);
        if (l < 1e-9) continue;
        const nu: Vec3 = [nn[0] / l, nn[1] / l, nn[2] / l];
        const d = dot(nu, a);
        let count = 0;
        for (let q = 0; q < n; q++) {
            const r = Math.abs(nu[0] * points[q * 3] + nu[1] * points[q * 3 + 1] + nu[2] * points[q * 3 + 2] - d);
            if (r <= tol0 + tol1 * depths[q]) count++;
        }
        if (count > bestCount) { bestCount = count; bestN = nu; bestD = d; }
    }
    if (bestCount < 3) return null;
    // least-squares refinement (two rounds)
    let nrm = bestN, off = bestD;
    let inliers = new Uint8Array(n);
    for (let round = 0; round < 2; round++) {
        inliers = new Uint8Array(n);
        let c: Vec3 = [0, 0, 0], m = 0;
        for (let q = 0; q < n; q++) {
            const r = Math.abs(dot(nrm, [points[q * 3], points[q * 3 + 1], points[q * 3 + 2]]) - off);
            if (r <= tol0 + tol1 * depths[q]) { inliers[q] = 1; c = add(c, [points[q * 3], points[q * 3 + 1], points[q * 3 + 2]]); m++; }
        }
        if (m < 3) break;
        c = scale3(c, 1 / m);
        const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
        for (let q = 0; q < n; q++) {
            if (!inliers[q]) continue;
            const d = sub([points[q * 3], points[q * 3 + 1], points[q * 3 + 2]], c);
            for (let r = 0; r < 3; r++) for (let s = 0; s < 3; s++) C[r][s] += d[r] * d[s];
        }
        const e = symmetricEigen3(C);
        let nn = norm(e.vectors[0]);
        if (dot(nn, nrm) < 0) nn = scale3(nn, -1);
        nrm = nn; off = dot(nrm, c);
    }
    let m = 0, ss = 0;
    for (let q = 0; q < n; q++) {
        const r = dot(nrm, [points[q * 3], points[q * 3 + 1], points[q * 3 + 2]]) - off;
        if (Math.abs(r) <= tol0 + tol1 * depths[q]) { inliers[q] = 1; m++; ss += r * r; } else inliers[q] = 0;
    }
    return { normal: nrm, offset: off, inliers, inlierFraction: m / n, rmsMeters: m ? Math.sqrt(ss / m) : Infinity };
}

/** In-plane axes: u horizontal (world up x normal) unless the plane is near-horizontal, then the camera right projected. */
export function planeAxes(normal: Vec3, cameraRight: Vec3): { uAxis: Vec3; vAxis: Vec3 } {
    const up: Vec3 = [0, 1, 0];
    let u: Vec3;
    if (Math.abs(normal[1]) < 0.97) {
        u = norm(cross(up, normal));
    } else {
        u = norm(sub(cameraRight, scale3(normal, dot(cameraRight, normal))));
    }
    const v = norm(cross(normal, u));
    return { uAxis: u, vAxis: v };
}

/** Plane frame from a fitted plane, oriented toward the camera, with its origin where `ray` from the eye hits it. */
function planeFrameFrom(normal: Vec3, offset: number, cam: FrameCamera, rayWorld: Vec3): PlaneFrame | null {
    let n = normal, d = offset;
    if (dot(n, cam.eye) - d < 0) { n = scale3(n, -1); d = -d; }
    const denom = dot(n, rayWorld);
    if (Math.abs(denom) < 1e-6) return null;
    const lam = (d - dot(n, cam.eye)) / denom;
    if (!(lam > 0)) return null;
    const origin = add(cam.eye, rayWorld, lam);
    const { uAxis, vAxis } = planeAxes(n, cam.right);
    return { origin, normal: n, uAxis, vAxis };
}

/** Ray (world) / plane intersection parameter; null when parallel or behind. */
function rayPlane(eye: Vec3, dir: Vec3, plane: PlaneFrame): number | null {
    const denom = dot(plane.normal, dir);
    if (Math.abs(denom) < 1e-9) return null;
    const lam = dot(plane.normal, sub(plane.origin, eye)) / denom;
    return lam > 0 ? lam : null;
}

export interface QuadPlaneResult {
    plane: PlaneFrame;
    widthMeters: number;
    heightMeters: number;
    /** |90 - angle between the recovered rectangle edges| (deg): quad consistency. */
    orthogonalityErrorDeg: number;
    /** Median ratio used to put the up-to-scale rectangle at the mesh depth. */
    metricScale: number;
}

/**
 * Plane of a real-world rectangle seen as an image quad (TL, TR, BR, BL), with known intrinsics: solves
 * lambda_1 m1 + lambda_3 m3 = lambda_2 m2 + lambda_4 m4 (rectangle diagonals bisect) for the corner depths up to
 * scale; metric scale is the median ratio of `depthAt` (mesh camera-z) to the plane depth over interior points.
 */
export function planeFromQuad(cam: FrameCamera, corners: Array<[number, number]>, depthAt: (u: number, v: number) => number | null): QuadPlaneResult | null {
    if (corners.length !== 4) return null;
    const m = corners.map(([u, v]) => pixelRayCam(cam, u, v));
    // [m2, -m3, m4] * [l2, l3, l4]^T = m1
    const A = [[m[1][0], -m[2][0], m[3][0]], [m[1][1], -m[2][1], m[3][1]], [m[1][2], -m[2][2], m[3][2]]];
    const det3 = (M: number[][]) => M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
    const D = det3(A);
    if (Math.abs(D) < 1e-12) return null;
    const lam = [1, 0, 0, 0];
    for (let c = 0; c < 3; c++) {
        const Ac = A.map((row, r) => row.map((val, k) => (k === c ? m[0][r] : val)));
        lam[c + 1] = det3(Ac) / D;
    }
    if (lam.some(l => !(l > 0))) return null;
    const Q = m.map((mi, i) => scale3(mi, lam[i])); // camera coords (right, up, fwd), up to scale
    const eTop = sub(Q[1], Q[0]), eLeft = sub(Q[3], Q[0]);
    const lt = Math.hypot(...eTop), ll = Math.hypot(...eLeft);
    if (lt < 1e-9 || ll < 1e-9) return null;
    const cosA = dot(eTop, eLeft) / (lt * ll);
    const orthErr = Math.abs(90 - Math.acos(Math.max(-1, Math.min(1, cosA))) / DEG);
    let nc = norm(cross(eTop, eLeft));
    const centre = scale3(add(Q[0], Q[2]), 0.5);
    if (dot(nc, centre) > 0) nc = scale3(nc, -1); // face the camera (camera at origin)
    const dc = dot(nc, centre);
    // metric scale: mesh depth / plane depth over interior samples (bilinear in the quad)
    const ratios: number[] = [];
    for (let a = 1; a < 8; a++) for (let b = 1; b < 8; b++) {
        const s = a / 8, t = b / 8;
        const top = [corners[0][0] + (corners[1][0] - corners[0][0]) * s, corners[0][1] + (corners[1][1] - corners[0][1]) * s];
        const bot = [corners[3][0] + (corners[2][0] - corners[3][0]) * s, corners[3][1] + (corners[2][1] - corners[3][1]) * s];
        const u = top[0] + (bot[0] - top[0]) * t, v = top[1] + (bot[1] - top[1]) * t;
        const ray = pixelRayCam(cam, u, v);
        const den = dot(nc, ray);
        if (Math.abs(den) < 1e-9) continue;
        const zPlane = dc / den; // ray has forward component 1, so the parameter is camera-z
        const zMesh = depthAt(u, v);
        if (zMesh === null || !(zPlane > 0)) continue;
        ratios.push(zMesh / zPlane);
    }
    if (ratios.length < 8) return null;
    ratios.sort((x, y) => x - y);
    const k = ratios[ratios.length >> 1];
    const QW = Q.map(q => add(cam.eye, camToWorldDir(cam, scale3(q, k))));
    let nW = norm(camToWorldDir(cam, nc));
    if (dot(nW, sub(cam.eye, QW[0])) < 0) nW = scale3(nW, -1);
    const origin = scale3(add(add(QW[0], QW[1]), add(QW[2], QW[3])), 0.25);
    // In-plane axes follow world up (as for mesh planes); the swatch builder corrects residual in-plane rotation.
    const { uAxis, vAxis } = planeAxes(nW, cam.right);
    return {
        plane: { origin, normal: nW, uAxis, vAxis },
        widthMeters: lt * k, heightMeters: ll * k, orthogonalityErrorDeg: orthErr, metricScale: k
    };
}

/** Rotates the in-plane axes of a frame by `angleDeg` about its normal. */
export function rotatePlaneAxes(plane: PlaneFrame, angleDeg: number): PlaneFrame {
    const c = Math.cos(angleDeg * DEG), s = Math.sin(angleDeg * DEG);
    const u = norm(add(scale3(plane.uAxis, c), plane.vAxis, s));
    const v = norm(cross(plane.normal, u));
    return { ...plane, uAxis: u, vAxis: v };
}

// ============================================================================================
// Rectification
// ============================================================================================

/** Photo footprint at a plane point: metres per photo pixel along the finest and coarsest in-plane directions. */
export function planeFootprint(cam: FrameCamera, plane: PlaneFrame, s: number, t: number, h = 0.01): { fine: number; coarse: number } | null {
    const P = add(add(plane.origin, plane.uAxis, s), plane.vAxis, t);
    const p0 = projectPoint(cam, P), pu = projectPoint(cam, add(P, plane.uAxis, h)), pv = projectPoint(cam, add(P, plane.vAxis, h));
    if (!p0 || !pu || !pv) return null;
    const a = (pu[0] - p0[0]) / h, b = (pv[0] - p0[0]) / h, c = (pu[1] - p0[1]) / h, d = (pv[1] - p0[1]) / h; // px per metre
    const t1 = a * a + c * c, t2 = b * b + d * d, t3 = a * b + c * d;
    const tr = t1 + t2, det = t1 * t2 - t3 * t3;
    const disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
    const sMax = Math.sqrt(Math.max(0, tr / 2 + disc)), sMin = Math.sqrt(Math.max(0, tr / 2 - disc));
    if (!(sMin > 0)) return null;
    return { fine: 1 / sMax, coarse: 1 / sMin };
}

export interface RectifiedSwatch {
    width: number;
    height: number;
    /** Interleaved linear RGB. */
    rgb: Float32Array;
    /** 1 where every supersample landed on a usable photo pixel. */
    valid: Uint8Array;
}

/**
 * Resamples a plane region fronto-parallel: output pixel (i, j) covers s in s0 + [i, i+1) * mppU and t in
 * tTop - [j, j+1) * mppV, averaged over ss x ss bilinear photo samples (anti-aliasing).
 */
export function rectifyPlaneRegion(
    photoLin: Float32Array, usable: Uint8Array, cam: FrameCamera, plane: PlaneFrame,
    s0: number, tTop: number, mppU: number, mppV: number, Nu: number, Nv: number, ss = 2
): RectifiedSwatch {
    const W = cam.width, H = cam.height;
    const rgb = new Float32Array(Nu * Nv * 3), valid = new Uint8Array(Nu * Nv);
    const { origin: O, uAxis: U, vAxis: V } = plane;
    for (let j = 0; j < Nv; j++) for (let i = 0; i < Nu; i++) {
        let r = 0, g = 0, b = 0, ok = 1;
        for (let a = 0; a < ss && ok; a++) for (let c = 0; c < ss; c++) {
            const s = s0 + (i + (a + 0.5) / ss) * mppU, t = tTop - (j + (c + 0.5) / ss) * mppV;
            const P: Vec3 = [O[0] + U[0] * s + V[0] * t, O[1] + U[1] * s + V[1] * t, O[2] + U[2] * s + V[2] * t];
            const pr = projectPoint(cam, P);
            if (!pr) { ok = 0; break; }
            const x = pr[0] - 0.5, y = pr[1] - 0.5;
            if (x < 0 || y < 0 || x > W - 1.001 || y > H - 1.001) { ok = 0; break; }
            const xi = x | 0, yi = y | 0, fx = x - xi, fy = y - yi;
            const nearest = (fy < 0.5 ? yi : yi + 1) * W + (fx < 0.5 ? xi : xi + 1);
            if (!usable[nearest]) { ok = 0; break; }
            const k00 = (yi * W + xi) * 3, k10 = k00 + 3, k01 = k00 + W * 3, k11 = k01 + 3;
            const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
            r += photoLin[k00] * w00 + photoLin[k10] * w10 + photoLin[k01] * w01 + photoLin[k11] * w11;
            g += photoLin[k00 + 1] * w00 + photoLin[k10 + 1] * w10 + photoLin[k01 + 1] * w01 + photoLin[k11 + 1] * w11;
            b += photoLin[k00 + 2] * w00 + photoLin[k10 + 2] * w10 + photoLin[k01 + 2] * w01 + photoLin[k11 + 2] * w11;
        }
        const o = (j * Nu + i) * 3;
        if (ok) {
            const inv = 1 / (ss * ss);
            rgb[o] = r * inv; rgb[o + 1] = g * inv; rgb[o + 2] = b * inv;
            valid[j * Nu + i] = 1;
        }
    }
    return { width: Nu, height: Nv, rgb, valid };
}

// ============================================================================================
// Tileability: period estimate, periodic + smooth decomposition, flat-field
// ============================================================================================

/** In-place iterative radix-2 complex FFT (n must be a power of two). */
export function fft1(re: Float64Array, im: Float64Array, inverse = false): void {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let len = 2; len <= n; len <<= 1) {
        const ang = (inverse ? 2 : -2) * Math.PI / len;
        const wr = Math.cos(ang), wi = Math.sin(ang);
        for (let i = 0; i < n; i += len) {
            let cr = 1, ci = 0;
            for (let k = 0; k < len / 2; k++) {
                const a = i + k, b = a + len / 2;
                const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
                re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
                const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
            }
        }
    }
    if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

const isPow2 = (n: number) => n > 0 && (n & (n - 1)) === 0;

function fft2(re: Float64Array, im: Float64Array, W: number, H: number, inverse: boolean): void {
    const rr = new Float64Array(W), ri = new Float64Array(W);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) { rr[x] = re[y * W + x]; ri[x] = im[y * W + x]; }
        fft1(rr, ri, inverse);
        for (let x = 0; x < W; x++) { re[y * W + x] = rr[x]; im[y * W + x] = ri[x]; }
    }
    const cr = new Float64Array(H), ci = new Float64Array(H);
    for (let x = 0; x < W; x++) {
        for (let y = 0; y < H; y++) { cr[y] = re[y * W + x]; ci[y] = im[y * W + x]; }
        fft1(cr, ci, inverse);
        for (let y = 0; y < H; y++) { re[y * W + x] = cr[y]; im[y * W + x] = ci[y]; }
    }
}

/**
 * Periodic + smooth decomposition (Moisan 2011) of one channel (power-of-two sizes): u = p + s, where s is the
 * smooth component carrying the boundary discontinuity and p tiles with no seam and no mirrored or blended copy.
 */
export function periodicSmoothDecomposition(u: Float32Array, W: number, H: number): { periodic: Float32Array; smooth: Float32Array } {
    if (!isPow2(W) || !isPow2(H)) throw new Error(`periodicSmoothDecomposition: ${W}x${H} is not a power of two`);
    const re = new Float64Array(W * H), im = new Float64Array(W * H);
    for (let y = 0; y < H; y++) {
        const d = u[y * W + W - 1] - u[y * W];
        re[y * W] += d; re[y * W + W - 1] -= d;
    }
    for (let x = 0; x < W; x++) {
        const d = u[(H - 1) * W + x] - u[x];
        re[x] += d; re[(H - 1) * W + x] -= d;
    }
    fft2(re, im, W, H, false);
    for (let r = 0; r < H; r++) for (let q = 0; q < W; q++) {
        const i = r * W + q;
        if (q === 0 && r === 0) { re[i] = 0; im[i] = 0; continue; }
        const den = 2 * Math.cos(2 * Math.PI * q / W) + 2 * Math.cos(2 * Math.PI * r / H) - 4;
        re[i] /= den; im[i] /= den;
    }
    fft2(re, im, W, H, true);
    const smooth = new Float32Array(W * H), periodic = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) { smooth[i] = re[i]; periodic[i] = u[i] - re[i]; }
    return { periodic, smooth };
}

/** Wrap-around seam discontinuity relative to the interior gradient (0 = seamless). */
export function seamResidual(Y: Float32Array, W: number, H: number): number {
    let seam = 0, ns = 0, inner = 0, ni = 0;
    for (let y = 0; y < H; y++) { seam += Math.abs(Y[y * W + W - 1] - Y[y * W]); ns++; }
    for (let x = 0; x < W; x++) { seam += Math.abs(Y[(H - 1) * W + x] - Y[x]); ns++; }
    for (let y = 0; y < H; y++) for (let x = 0; x + 1 < W; x++) { inner += Math.abs(Y[y * W + x + 1] - Y[y * W + x]); ni++; }
    for (let y = 0; y + 1 < H; y++) for (let x = 0; x < W; x++) { inner += Math.abs(Y[(y + 1) * W + x] - Y[y * W + x]); ni++; }
    const gi = inner / Math.max(1, ni);
    return gi > 1e-12 ? (seam / Math.max(1, ns)) / gi : 0;
}

/** Dominant period (pixels) along x or y from the normalised autocorrelation; null when not periodic. */
export function dominantPeriod(Y: Float32Array, W: number, H: number, axis: 'x' | 'y', minLag = 4, minCorrelation = 0.3): { period: number | null; correlation: number } {
    const N = axis === 'x' ? W : H, M = axis === 'x' ? H : W;
    const at = (i: number, j: number) => (axis === 'x' ? Y[j * W + i] : Y[i * W + j]);
    let mean = 0;
    for (let k = 0; k < W * H; k++) mean += Y[k];
    mean /= W * H;
    const maxLag = Math.floor(N / 2);
    const corr = new Float64Array(maxLag + 2);
    for (let L = 1; L <= maxLag + 1 && L < N; L++) {
        let sab = 0, saa = 0, sbb = 0;
        for (let j = 0; j < M; j++) for (let i = 0; i + L < N; i++) {
            const a = at(i, j) - mean, b = at(i + L, j) - mean;
            sab += a * b; saa += a * a; sbb += b * b;
        }
        corr[L] = saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
    }
    let bestPeak = -1;
    const peaks: number[] = [];
    for (let L = Math.max(2, minLag); L <= maxLag; L++) {
        if (corr[L] > corr[L - 1] && corr[L] >= corr[L + 1] && corr[L] >= minCorrelation) { peaks.push(L); bestPeak = Math.max(bestPeak, corr[L]); }
    }
    for (const L of peaks) {
        if (corr[L] < 0.8 * bestPeak) continue;
        const a = corr[L - 1], b = corr[L], c = corr[L + 1];
        const den = a - 2 * b + c;
        const off = Math.abs(den) > 1e-12 ? 0.5 * (a - c) / den : 0;
        return { period: L + Math.max(-0.5, Math.min(0.5, off)), correlation: b };
    }
    return { period: null, correlation: bestPeak > 0 ? bestPeak : 0 };
}

/** Line-orientation alignment of a rectified swatch: deviations (deg) of the dominant near-vertical / near-horizontal edges. */
export function axisAlignment(Y: Float32Array, W: number, H: number, minEvidence = 3.5): { deviationVerticalDeg: number | null; deviationHorizontalDeg: number | null; evidenceVertical: number; evidenceHorizontal: number } {
    const BINS = 720; // 0.25 deg
    const hist = new Float64Array(BINS);
    let total = 0;
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        const gx = (Y[i - W + 1] + 2 * Y[i + 1] + Y[i + W + 1]) - (Y[i - W - 1] + 2 * Y[i - 1] + Y[i + W - 1]);
        const gy = (Y[i + W - 1] + 2 * Y[i + W] + Y[i + W + 1]) - (Y[i - W - 1] + 2 * Y[i - W] + Y[i - W + 1]);
        const m2 = gx * gx + gy * gy;
        if (m2 <= 0) continue;
        let th = Math.atan2(gy, gx) / DEG; // gradient direction
        th = ((th % 180) + 180) % 180;
        hist[Math.min(BINS - 1, Math.floor(th * 4))] += m2;
        total += m2;
    }
    if (total <= 0) return { deviationVerticalDeg: null, deviationHorizontalDeg: null, evidenceVertical: 0, evidenceHorizontal: 0 };
    // smooth (sigma 0.5 deg, circular)
    const sm = new Float64Array(BINS);
    for (let b = 0; b < BINS; b++) { let s = 0; for (let d = -4; d <= 4; d++) s += hist[(b + d + BINS) % BINS] * Math.exp(-(d * d) / 8); sm[b] = s; }
    const peakNear = (centreDeg: number) => {
        let best = -1, bestB = 0;
        for (let d = -48; d <= 48; d++) { const b = (Math.round(centreDeg * 4) + d + BINS) % BINS; if (sm[b] > best) { best = sm[b]; bestB = d; } }
        // energy within +-1.5 deg of the peak vs a uniform distribution
        let e = 0;
        for (let d = -6; d <= 6; d++) e += hist[(Math.round(centreDeg * 4) + bestB + d + BINS) % BINS];
        return { dev: bestB / 4, evidence: (e / total) / (13 / BINS) };
    };
    const v = peakNear(0), h = peakNear(90); // gradient ~0 deg = vertical edges
    return {
        // a deviation is only meaningful where straight edges concentrate gradient energy (evidence = concentration
        // within +-1.5 deg of the peak relative to a uniform orientation distribution)
        deviationVerticalDeg: v.evidence >= minEvidence ? v.dev : null,
        deviationHorizontalDeg: h.evidence >= minEvidence ? h.dev : null,
        evidenceVertical: v.evidence,
        evidenceHorizontal: h.evidence
    };
}

function luminanceOf(rgb: Float32Array, n: number): Float32Array {
    const Y = new Float32Array(n);
    for (let i = 0; i < n; i++) Y[i] = 0.2126 * rgb[i * 3] + 0.7152 * rgb[i * 3 + 1] + 0.0722 * rgb[i * 3 + 2];
    return Y;
}

function quantile(values: ArrayLike<number>, q: number): number {
    const a = Array.from(values).filter(v => Number.isFinite(v)).sort((x, y) => x - y);
    if (!a.length) return NaN;
    return a[Math.min(a.length - 1, Math.max(0, Math.round(q * (a.length - 1))))];
}

// ============================================================================================
// Texture agent kernel
// ============================================================================================

export interface PbrKernelResult { fields: ContinuousBiophysicalFields; acceleration: 'native-cpp20' | 'node-v8' }
export type PbrKernel = (rgba: Buffer, width: number, height: number, schema: AdaptiveMaterialSchema) => Promise<PbrKernelResult>;

let nativePbr: NativeMaterialPbrService | null = null;

/**
 * The image_to_adaptive_pbr_plane kernel (native C++20 field estimator, Node fallback) on a TILEABLE swatch:
 * the input is wrap-padded so AO / normals at the border see their periodic neighbours, then cropped back.
 */
export async function runTileablePbrKernel(rgba: Buffer, width: number, height: number, schema: AdaptiveMaterialSchema, aoRadiusTexels = 10): Promise<PbrKernelResult> {
    const pad = aoRadiusTexels + 2;
    const Wp = width + 2 * pad, Hp = height + 2 * pad;
    const padded = Buffer.alloc(Wp * Hp * 4);
    for (let y = 0; y < Hp; y++) for (let x = 0; x < Wp; x++) {
        const sx = ((x - pad) % width + width) % width, sy = ((y - pad) % height + height) % height;
        rgba.copy(padded, (y * Wp + x) * 4, (sy * width + sx) * 4, (sy * width + sx) * 4 + 4);
    }
    const opts = { aoRadiusTexels, edgeDampingFactor: schema.edgeDampingFactor ?? 0.45, reliefMultiplier: 1, schemaOverride: schema };
    let fields: ContinuousBiophysicalFields, acceleration: 'native-cpp20' | 'node-v8';
    try {
        nativePbr = nativePbr ?? new NativeMaterialPbrService();
        fields = await nativePbr.estimateContinuousBiophysicalFields(padded, Wp, Hp, opts);
        acceleration = 'native-cpp20';
    } catch {
        fields = AdaptiveMaterialPbrService.estimateContinuousBiophysicalFields(padded, Wp, Hp, opts);
        acceleration = 'node-v8';
    }
    const crop = (src: Uint8Array, ch: number): Uint8Array => {
        const out = new Uint8Array(width * height * ch);
        for (let y = 0; y < height; y++) out.set(src.subarray(((y + pad) * Wp + pad) * ch, ((y + pad) * Wp + pad + width) * ch), y * width * ch);
        return out;
    };
    const cropF = (src: Float32Array | undefined): Float32Array | undefined => {
        if (!src) return undefined;
        const out = new Float32Array(width * height);
        for (let y = 0; y < height; y++) out.set(src.subarray((y + pad) * Wp + pad, (y + pad) * Wp + pad + width), y * width);
        return out;
    };
    return {
        acceleration,
        fields: {
            width, height,
            albedoRgba: crop(fields.albedoRgba, 4), normalRgb: crop(fields.normalRgb, 3), roughness: crop(fields.roughness, 1),
            metallic: crop(fields.metallic, 1), ambientOcclusion: crop(fields.ambientOcclusion, 1), ormRgb: crop(fields.ormRgb, 3),
            virtualHeight: cropF(fields.virtualHeight)
        }
    };
}

// ============================================================================================
// Library
// ============================================================================================

export interface LabStats { mean: Vec3; std: Vec3 }

export interface MaterialLibrarySample {
    id: string;
    label: string;
    description: string;
    source: {
        frame: string; panoId?: string; date?: string; poseSource: string; poseConfidence: number;
        /** Sample polygon in the frame (pixels). */
        polygonPx: Array<[number, number]>;
        /** World-space centre of the harvested rectangle. */
        centreWorld: Vec3;
    };
    /** Paths relative to the library directory. */
    files: { albedo: string; normal: string; orm: string; height?: string; photoSwatch?: string };
    widthPx: number;
    heightPx: number;
    /** Metres per swatch pixel along the swatch x (uAxis) and y (-vAxis). */
    metresPerPixel: { u: number; v: number };
    sizeMeters: { u: number; v: number };
    plane: { origin: Vec3; normal: Vec3; uAxis: Vec3; vAxis: Vec3; tiltDeg: number; method: string; inlierFraction: number | null; quadOrthogonalityErrorDeg: number | null };
    geometry: {
        distanceMeters: number; incidenceCos: number;
        /** Height of the swatch surface above the local terrain (p05 / p50 / p95), when a ground model is given. */
        heightAboveGround: { p05: number; p50: number; p95: number } | null;
        /** Photo footprint (metres per photo pixel) at the swatch centre. */
        photoFootprintMeters: { fine: number; coarse: number };
    };
    /** Scan tile texture at the same surface (from a render of the base mesh at the frame pose). */
    tile: { texelMeters: number | null; resolutionGain: number | null; lab: LabStats; linearRgb: Vec3; pixels: number } | null;
    /**
     * The swatch's own colour mapped into the tile's radiometry: photo swatch (linear) x the frame's per-channel
     * photo-to-tile gain (robust median ratio of the blurred tile render and the blurred photo over usable mesh pixels).
     * Lets a texel of the tile be compared with this material even where the source surface mixes materials in the tile.
     */
    tileDomain: { gain: Vec3; lab: LabStats; linearRgb: Vec3 } | null;
    /** Statistics of the de-lit albedo swatch (photo exposure). */
    albedo: { lab: LabStats; linearRgb: Vec3; lumaContrast: number };
    physical: { metalness: number; roughness: number; surfaceTiltHintDeg: number | null };
    quality: {
        axisDeviationDeg: number | null; lineEvidence: number; seamResidualBefore: number; seamResidualAfter: number;
        illuminationRange: number; clippedFraction: number; periodMeters: { u: number | null; v: number | null }; occludedFraction: number;
        /** Continuous score in [0, 1]: incidence x resolution gain x size x alignment x pose confidence. */
        score: number;
    };
    kernel: { acceleration: 'native-cpp20' | 'node-v8' };
}

export interface MaterialLibrary {
    version: 1;
    createdAt: string;
    /** Mesh the planes, depths and tile statistics were measured on. */
    baseGlbPath?: string;
    segmentation: { model: string; promptVersion: number };
    samples: MaterialLibrarySample[];
    rejected: Array<{ frame: string; label: string; reason: string }>;
}

export interface HarvestFrameReport {
    frame: string;
    poseSource: string;
    proposals: number;
    accepted: number;
    error?: string;
    timingsMs: { segmentation: number; render: number; samples: number };
}

export interface HarvestOptions {
    /** Library directory (swatch PNGs + library.json). */
    outDir: string;
    segmenter: MaterialSegmenter;
    /** Base mesh with decoded textures: plane depth and tile statistics at the source surface. */
    texturedPrims: TexturedPrimitive[];
    baseGlbPath?: string;
    /** Terrain height under (x, z) (e.g. StreetViewSurveyPlanner ground model); NaN when unknown. */
    groundHeightAt?: (x: number, z: number) => number;
    /** Reject samples seen more obliquely than this (cosine between view ray and surface normal). Default 0.4. */
    minIncidenceCos?: number;
    /** Minimum ratio of tile texel size to swatch metres-per-pixel. Default 2. */
    minResolutionGain?: number;
    /**
     * Minimum clean rectangle: narrow side in photo-footprint pixels (default 12), area in photo-footprint pixels
     * (default 512) and narrow side in metres (default 0.5). Street-level frames see facade piers and spandrels as
     * narrow strips, so the narrow side is allowed to be small while the area keeps enough texture statistics.
     */
    minCropPx?: number;
    minCropAreaPx?: number;
    minCropMeters?: number;
    /** Largest swatch side (power of two). Default 512. */
    maxSwatchPx?: number;
    /** Reject when more of the polygon than this is masked (occluders, watermark). Default 0.5. */
    maxOccludedFraction?: number;
    /** Reject when the low-frequency illumination p95/p5 ratio exceeds this. Default 1.8. */
    maxIlluminationRange?: number;
    /** Reject when rectified straight lines deviate more than this from the swatch axes (deg). Default 4. */
    maxAxisDeviationDeg?: number;
    /** Minimum RANSAC inlier fraction for a mesh plane. Default 0.55. */
    minPlaneInlierFraction?: number;
    /** Reject a plane whose tilt disagrees with the segmenter's tilt hint by more than this (deg). Default 30. */
    maxTiltDisagreementDeg?: number;
    /** Maximum rectangle aspect ratio. Default 4. */
    maxAspect?: number;
    /** A facade-quad plane is dropped when its normal differs from the mesh plane by more than this (deg). Default 10. */
    maxQuadMeshDisagreementDeg?: number;
    /** Without a mesh plane, the quad's recovered corner angles must be within this of 90 deg. Default 5. */
    maxQuadOrthogonalityDeg?: number;
    /** Reject swatches with more clipped (saturated) pixels than this fraction. Default 0.2. */
    maxClippedFraction?: number;
    /** Keep the rectified photo swatch (pre-kernel) as a PNG. Default true. */
    writePhotoSwatch?: boolean;
    /** Injectable PBR kernel (defaults to runTileablePbrKernel). */
    pbrKernel?: PbrKernel;
    /** When set, every rectified candidate (accepted or not) is written here as `<sample>_<method>.png` for inspection. */
    debugDir?: string;
    log?: (msg: string) => void;
}

interface PlaneCandidate {
    plane: PlaneFrame;
    method: string;
    inlierFraction: number | null;
    quadOrthErr: number | null;
}

interface SwatchBuild {
    plane: PlaneFrame;
    method: string;
    inlierFraction: number | null;
    quadOrthErr: number | null;
    s0: number; tTop: number; mppU: number; mppV: number; Nu: number; Nv: number;
    swatch: RectifiedSwatch;
    axisDev: number | null;
    lineEvidence: number;
    periodU: number | null; periodV: number | null;
    footprint: { fine: number; coarse: number };
    incidence: number;
    distance: number;
}

/** Rejection carried through the per-sample pipeline. */
class SampleRejection extends Error {}

function labStats(pixels: Float32Array, n: number): { lab: LabStats; linearRgb: Vec3 } {
    let r = 0, g = 0, b = 0;
    const L = new Float64Array(n), A = new Float64Array(n), B = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        r += pixels[i * 3]; g += pixels[i * 3 + 1]; b += pixels[i * 3 + 2];
        const lab = linearRgbToLab(Math.max(0, pixels[i * 3]), Math.max(0, pixels[i * 3 + 1]), Math.max(0, pixels[i * 3 + 2]));
        L[i] = lab[0]; A[i] = lab[1]; B[i] = lab[2];
    }
    const mean = (x: Float64Array) => { let s = 0; for (let i = 0; i < n; i++) s += x[i]; return n ? s / n : 0; };
    const std = (x: Float64Array, m: number) => { let s = 0; for (let i = 0; i < n; i++) s += (x[i] - m) ** 2; return n ? Math.sqrt(s / n) : 0; };
    const mL = mean(L), mA = mean(A), mB = mean(B);
    return { lab: { mean: [mL, mA, mB], std: [std(L, mL), std(A, mA), std(B, mB)] }, linearRgb: n ? [r / n, g / n, b / n] : [0, 0, 0] };
}

const round = (v: number, d = 4) => Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : v;
const roundV = (v: ArrayLike<number>, d = 4): Vec3 => [round(v[0], d), round(v[1], d), round(v[2], d)];

/**
 * Harvests tileable, metric-scale PBR material swatches from Street View frames into a material library
 * (`<outDir>/library.json`, swatches under `<outDir>/swatches/`).
 */
export async function harvestStreetViewMaterials(frames: HarvestFrameInput[], opts: HarvestOptions): Promise<{ library: MaterialLibrary; libraryPath: string; frameReports: HarvestFrameReport[] }> {
    const log = opts.log ?? (() => undefined);
    const minCos = opts.minIncidenceCos ?? 0.4;
    const minGain = opts.minResolutionGain ?? 2;
    const minCropPx = opts.minCropPx ?? 12, minCropArea = opts.minCropAreaPx ?? 512, minCropM = opts.minCropMeters ?? 0.5;
    const maxSwatch = opts.maxSwatchPx ?? 512;
    const maxOcc = opts.maxOccludedFraction ?? 0.5;
    const maxIllum = opts.maxIlluminationRange ?? 1.8;
    const maxAxisDev = opts.maxAxisDeviationDeg ?? 4;
    const minInlier = opts.minPlaneInlierFraction ?? 0.55;
    const maxTiltDis = opts.maxTiltDisagreementDeg ?? 30;
    const maxAspect = opts.maxAspect ?? 4;
    const maxQuadMeshDisagreementDeg = opts.maxQuadMeshDisagreementDeg ?? 10;
    const maxQuadOrthogonalityDeg = opts.maxQuadOrthogonalityDeg ?? 5;
    const maxClipped = opts.maxClippedFraction ?? 0.2;
    const kernel = opts.pbrKernel ?? ((rgba, w, h, schema) => runTileablePbrKernel(rgba, w, h, schema));
    const swatchDir = path.join(opts.outDir, 'swatches');
    fs.mkdirSync(swatchDir, { recursive: true });

    const library: MaterialLibrary = {
        version: 1, createdAt: new Date().toISOString(), baseGlbPath: opts.baseGlbPath,
        segmentation: { model: STREETVIEW_GEMINI_MODEL, promptVersion: MATERIAL_SEGMENTATION_PROMPT_VERSION },
        samples: [], rejected: []
    };
    const frameReports: HarvestFrameReport[] = [];

    for (const frame of frames) {
        const t0 = Date.now();
        const rep: HarvestFrameReport = { frame: frame.key, poseSource: frame.poseSource, proposals: 0, accepted: 0, timingsMs: { segmentation: 0, render: 0, samples: 0 } };
        frameReports.push(rep);
        let seg: FrameMaterialSegmentation;
        try {
            seg = await opts.segmenter(frame);
            library.segmentation.model = seg.model;
        } catch (e) {
            rep.error = `segmentation: ${(e as Error).message}`;
            log(`${frame.key}: ${rep.error}`);
            continue;
        }
        rep.timingsMs.segmentation = Date.now() - t0;
        rep.proposals = seg.samples.length;
        if (!seg.samples.length) continue;

        const cam = frame.camera, W = frame.width, H = frame.height;
        const t1 = Date.now();
        const view = renderTexturedView(opts.texturedPrims, cam, [0, 0, 0], true);
        rep.timingsMs.render = Date.now() - t1;
        const t2 = Date.now();
        const EMPTY = PLATE_EMPTY_DEPTH * 0.5;
        const depthAt = (u: number, v: number): number | null => {
            const x = Math.floor(u), y = Math.floor(v);
            if (x < 0 || y < 0 || x >= W || y >= H) return null;
            const d = view.depth[y * W + x];
            return d < EMPTY ? d : null;
        };
        const frameValid = buildValidMask(W, H, { watermarkBottomPx: frame.watermarkBottomPx ?? 24, occluders: frame.occluders ?? [], occluderDilatePx: 4 });
        const photoLin = new Float32Array(W * H * 3);
        for (let i = 0; i < W * H; i++) for (let c = 0; c < 3; c++) photoLin[i * 3 + c] = srgb8ToLinear(frame.rgba[i * 4 + c]);
        const frameGain = photoToTileGain(photoLin, view.rgba, view.depth, frameValid, W, H);

        for (let si = 0; si < seg.samples.length; si++) {
            const prop = seg.samples[si];
            const mat = seg.materials[prop.materialIndex];
            const label = mat?.label ?? 'material';
            const id = `${frame.key}__s${si}`;
            try {
                const polyMask = erodeMask(rasterizePolygon(prop.polygon, W, H), W, H, 2);
                let polyArea = 0, usableArea = 0;
                const usable = new Uint8Array(W * H);
                for (let i = 0; i < W * H; i++) if (polyMask[i]) { polyArea++; if (frameValid[i]) { usable[i] = 1; usableArea++; } }
                if (polyArea < minCropArea) throw new SampleRejection(`polygon too small (${polyArea} px)`);
                const occluded = Math.max(prop.occludedFraction, 1 - usableArea / polyArea);
                if (occluded > maxOcc) throw new SampleRejection(`occluded ${occluded.toFixed(2)} > ${maxOcc}`);

                // ---------------- plane candidates ----------------
                const pts: number[] = [], dps: number[] = [];
                const pix: number[] = [];
                let cu = 0, cv = 0;
                const stride = Math.max(1, Math.round(Math.sqrt(usableArea / 2500)));
                for (let y = 0; y < H; y += stride) for (let x = 0; x < W; x += stride) {
                    const i = y * W + x;
                    if (!usable[i]) continue;
                    cu += x + 0.5; cv += y + 0.5; pix.push(i);
                    const d = view.depth[i];
                    if (!(d < EMPTY)) continue;
                    const ray = camToWorldDir(cam, pixelRayCam(cam, x + 0.5, y + 0.5));
                    const P = add(cam.eye, ray, d);
                    pts.push(P[0], P[1], P[2]); dps.push(d);
                }
                cu /= Math.max(1, pix.length); cv /= Math.max(1, pix.length);
                const centreRay = norm(camToWorldDir(cam, pixelRayCam(cam, cu, cv)));
                const candidates: PlaneCandidate[] = [];
                const reasons: string[] = [];
                const ransac = fitPlaneRansac(Float64Array.from(pts), Float64Array.from(dps), { seed: seedOf(id) });
                if (ransac && ransac.inlierFraction >= minInlier) {
                    const pf = planeFrameFrom(ransac.normal, ransac.offset, cam, centreRay);
                    if (pf) candidates.push({ plane: pf, method: 'mesh-plane', inlierFraction: ransac.inlierFraction, quadOrthErr: null });
                } else reasons.push(`mesh plane inlier fraction ${ransac ? ransac.inlierFraction.toFixed(2) : 'n/a'} < ${minInlier}`);
                const quad = prop.facadeIndex !== null ? seg.facades[prop.facadeIndex] : undefined;
                if (quad) {
                    const qp = planeFromQuad(cam, quad.corners, depthAt);
                    // The quad is a fallback: with a mesh plane it must agree with it; alone it must be a near-perfect rectangle.
                    const meshN = candidates.length ? candidates[0].plane.normal : null;
                    const agree = qp && meshN ? Math.acos(Math.min(1, Math.abs(dot(qp.plane.normal, meshN)))) / DEG : 0;
                    const orthMax = meshN ? 12 : maxQuadOrthogonalityDeg;
                    if (qp && meshN && agree > maxQuadMeshDisagreementDeg) reasons.push(`facade quad normal ${agree.toFixed(1)} deg from the mesh plane`);
                    else if (qp && qp.orthogonalityErrorDeg <= orthMax) {
                        // put the quad plane's origin under the sample centre
                        const lam = rayPlane(cam.eye, centreRay, qp.plane);
                        const origin = lam !== null ? add(cam.eye, centreRay, lam) : qp.plane.origin;
                        candidates.push({ plane: { ...qp.plane, origin }, method: 'facade-quad', inlierFraction: null, quadOrthErr: qp.orthogonalityErrorDeg });
                    } else reasons.push(`facade quad unusable (${qp ? `orthogonality error ${qp.orthogonalityErrorDeg.toFixed(1)} deg` : 'degenerate'})`);
                }
                if (!candidates.length) throw new SampleRejection(`no plane: ${reasons.join('; ')}`);

                // ---------------- rectify each candidate, keep the best aligned ----------------
                const builds: SwatchBuild[] = [];
                const candReasons: string[] = [];
                for (const cand of candidates) {
                    try {
                        builds.push(buildSwatch(cand, cam, photoLin, usable, prop.polygon, depthAt, {
                            minCos, minCropPx, minCropArea, minCropM, maxSwatch, maxAspect, tiltHint: mat?.surfaceTiltDeg ?? null, maxTiltDis
                        }));
                    } catch (e) {
                        candReasons.push(`${cand.method}: ${(e as Error).message}`);
                    }
                }
                if (!builds.length) throw new SampleRejection(candReasons.join('; '));
                if (opts.debugDir) {
                    fs.mkdirSync(opts.debugDir, { recursive: true });
                    for (const b of builds) {
                        const px = Buffer.alloc(b.Nu * b.Nv * 4);
                        for (let i = 0; i < b.Nu * b.Nv; i++) { for (let c = 0; c < 3; c++) px[i * 4 + c] = linearToSrgb8(b.swatch.rgb[i * 3 + c]); px[i * 4 + 3] = 255; }
                        fs.writeFileSync(path.join(opts.debugDir, `${id.replace(/[^A-Za-z0-9._-]/g, '_')}_${b.method}_dev${b.axisDev === null ? 'na' : b.axisDev.toFixed(1)}_ev${b.lineEvidence.toFixed(1)}.png`), encodePng(b.Nu, b.Nv, px));
                    }
                }
                const devOf = (b: SwatchBuild) => (b.axisDev === null ? 0.5 * maxAxisDev : b.axisDev);
                builds.sort((a, b) => devOf(a) - devOf(b) || (a.method === 'mesh-plane' ? -1 : 1));
                const best = builds[0];
                if (best.axisDev !== null && best.axisDev > maxAxisDev) throw new SampleRejection(`rectified lines deviate ${best.axisDev.toFixed(1)} deg > ${maxAxisDev}`);

                // ---------------- tile statistics at the source surface ----------------
                let texel: number[] = [];
                const tilePix: number[] = [];
                for (const i of pix) {
                    const d = view.depth[i];
                    if (!(d < EMPTY)) continue;
                    const x = i % W, y = (i / W) | 0;
                    const ray = camToWorldDir(cam, pixelRayCam(cam, x + 0.5, y + 0.5));
                    const lam = rayPlane(cam.eye, ray, best.plane);
                    if (lam === null) continue;
                    const zPlane = lam * dot(ray, cam.fwd);
                    if (Math.abs(zPlane - d) > 0.5 + 0.03 * d) continue;
                    tilePix.push(i);
                    if (view.texelMeters && view.texelMeters[i] > 0) texel.push(view.texelMeters[i]);
                }
                const tileTexel = texel.length ? quantile(texel, 0.5) : null;
                texel = [];
                const mppMax = Math.max(best.mppU, best.mppV);
                const gain = tileTexel !== null ? tileTexel / mppMax : null;
                if (gain !== null && gain < minGain) throw new SampleRejection(`resolution gain ${gain.toFixed(2)} < ${minGain} (tile texel ${tileTexel!.toFixed(3)} m, swatch ${mppMax.toFixed(3)} m/px)`);
                let tileStats: MaterialLibrarySample['tile'] = null;
                if (tilePix.length >= 16) {
                    const tp = new Float32Array(tilePix.length * 3);
                    tilePix.forEach((i, k) => { for (let c = 0; c < 3; c++) tp[k * 3 + c] = srgb8ToLinear(view.rgba[i * 4 + c]); });
                    const st = labStats(tp, tilePix.length);
                    tileStats = { texelMeters: tileTexel !== null ? round(tileTexel) : null, resolutionGain: gain !== null ? round(gain, 2) : null, lab: { mean: roundV(st.lab.mean, 2), std: roundV(st.lab.std, 2) }, linearRgb: roundV(st.linearRgb), pixels: tilePix.length };
                }

                // ---------------- height above ground ----------------
                let hag: MaterialLibrarySample['geometry']['heightAboveGround'] = null;
                if (opts.groundHeightAt) {
                    const hs: number[] = [];
                    for (let k = 0; k < tilePix.length; k += Math.max(1, Math.floor(tilePix.length / 400))) {
                        const i = tilePix[k], x = i % W, y = (i / W) | 0;
                        const ray = camToWorldDir(cam, pixelRayCam(cam, x + 0.5, y + 0.5));
                        const lam = rayPlane(cam.eye, ray, best.plane);
                        if (lam === null) continue;
                        const P = add(cam.eye, ray, lam);
                        const g = opts.groundHeightAt(P[0], P[2]);
                        if (Number.isFinite(g)) hs.push(P[1] - g);
                    }
                    if (hs.length) hag = { p05: round(quantile(hs, 0.05), 2), p50: round(quantile(hs, 0.5), 2), p95: round(quantile(hs, 0.95), 2) };
                }

                // ---------------- flat-field, tileability ----------------
                const { Nu, Nv } = best;
                const n = Nu * Nv;
                const rgb = best.swatch.rgb;
                // clipped highlights carry no texture: a swatch dominated by them is rejected
                let clipped = 0;
                for (let i = 0; i < n; i++) if (Math.max(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]) >= CLIP_LINEAR) clipped++;
                const clippedFraction = clipped / n;
                if (clippedFraction > maxClipped) throw new SampleRejection(`clipped highlights ${clippedFraction.toFixed(2)} > ${maxClipped}`);
                const Y = luminanceOf(rgb, n);
                const Ylp = gaussianBlur(Y, Nu, Nv, Math.max(Nu, Nv) / 6);
                let meanLp = 0;
                for (let i = 0; i < n; i++) meanLp += Ylp[i];
                meanLp /= n;
                if (!(meanLp > 1e-5)) throw new SampleRejection('swatch is black');
                const ratio = new Float32Array(n);
                for (let i = 0; i < n; i++) ratio[i] = Math.max(1e-4, Ylp[i] / meanLp);
                const illum = quantile(ratio, 0.95) / Math.max(1e-4, quantile(ratio, 0.05));
                if (illum > maxIllum) throw new SampleRejection(`uneven illumination ${illum.toFixed(2)} > ${maxIllum}`);
                const flat = new Float32Array(n * 3);
                for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) flat[i * 3 + c] = rgb[i * 3 + c] / ratio[i];
                const seamBefore = seamResidual(luminanceOf(flat, n), Nu, Nv);
                const tile = new Float32Array(n * 3);
                for (let c = 0; c < 3; c++) {
                    const ch = new Float32Array(n);
                    for (let i = 0; i < n; i++) ch[i] = flat[i * 3 + c];
                    const { periodic } = periodicSmoothDecomposition(ch, Nu, Nv);
                    for (let i = 0; i < n; i++) tile[i * 3 + c] = Math.max(0, periodic[i]);
                }
                const seamAfter = seamResidual(luminanceOf(tile, n), Nu, Nv);

                // ---------------- texture agent kernel ----------------
                const swatchRgba = Buffer.alloc(n * 4);
                for (let i = 0; i < n; i++) { for (let c = 0; c < 3; c++) swatchRgba[i * 4 + c] = linearToSrgb8(tile[i * 3 + c]); swatchRgba[i * 4 + 3] = 255; }
                const metal = mat?.metalness ?? 0, rough = mat?.roughness ?? 0.7;
                const schema: AdaptiveMaterialSchema = {
                    conductionBias: metal,
                    roughnessRange: [Math.max(0.04, rough - 0.15), Math.min(1, rough + 0.15)],
                    reliefScale: 1, edgeDampingFactor: 0.45, cavityOcclusionStrength: 1
                };
                const k = await kernel(swatchRgba, Nu, Nv, schema);
                const f = k.fields;
                const albedoRgba = Buffer.from(f.albedoRgba.buffer, f.albedoRgba.byteOffset, f.albedoRgba.byteLength);
                const normalRgba = Buffer.alloc(n * 4), ormRgba = Buffer.alloc(n * 4);
                for (let i = 0; i < n; i++) {
                    normalRgba[i * 4] = f.normalRgb[i * 3]; normalRgba[i * 4 + 1] = f.normalRgb[i * 3 + 1]; normalRgba[i * 4 + 2] = f.normalRgb[i * 3 + 2]; normalRgba[i * 4 + 3] = 255;
                    ormRgba[i * 4] = f.ormRgb[i * 3]; ormRgba[i * 4 + 1] = f.ormRgb[i * 3 + 1]; ormRgba[i * 4 + 2] = f.ormRgb[i * 3 + 2]; ormRgba[i * 4 + 3] = 255;
                }
                const safe = id.replace(/[^A-Za-z0-9._-]/g, '_');
                const files: MaterialLibrarySample['files'] = {
                    albedo: `swatches/${safe}_albedo.png`, normal: `swatches/${safe}_normal.png`, orm: `swatches/${safe}_orm.png`
                };
                fs.writeFileSync(path.join(opts.outDir, files.albedo), encodePng(Nu, Nv, albedoRgba));
                fs.writeFileSync(path.join(opts.outDir, files.normal), encodePng(Nu, Nv, normalRgba));
                fs.writeFileSync(path.join(opts.outDir, files.orm), encodePng(Nu, Nv, ormRgba));
                if (f.virtualHeight) {
                    const hgt = Buffer.alloc(n * 4);
                    let lo = Infinity, hi = -Infinity;
                    for (let i = 0; i < n; i++) { lo = Math.min(lo, f.virtualHeight[i]); hi = Math.max(hi, f.virtualHeight[i]); }
                    for (let i = 0; i < n; i++) { const v = Math.round(255 * (f.virtualHeight[i] - lo) / Math.max(1e-9, hi - lo)); hgt[i * 4] = hgt[i * 4 + 1] = hgt[i * 4 + 2] = v; hgt[i * 4 + 3] = 255; }
                    files.height = `swatches/${safe}_height.png`;
                    fs.writeFileSync(path.join(opts.outDir, files.height), encodePng(Nu, Nv, hgt));
                }
                if (opts.writePhotoSwatch !== false) {
                    files.photoSwatch = `swatches/${safe}_photo.png`;
                    fs.writeFileSync(path.join(opts.outDir, files.photoSwatch), encodePng(Nu, Nv, swatchRgba));
                }
                let tileDomain: MaterialLibrarySample['tileDomain'] = null;
                if (frameGain) {
                    const td = new Float32Array(n * 3);
                    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) td[i * 3 + c] = tile[i * 3 + c] * frameGain[c];
                    const st = labStats(td, n);
                    tileDomain = { gain: roundV(frameGain), lab: { mean: roundV(st.lab.mean, 2), std: roundV(st.lab.std, 2) }, linearRgb: roundV(st.linearRgb) };
                }
                const albLin = new Float32Array(n * 3);
                for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) albLin[i * 3 + c] = srgb8ToLinear(albedoRgba[i * 4 + c]);
                const albStats = labStats(albLin, n);
                const aY = luminanceOf(albLin, n);
                let ym = 0, yv = 0;
                for (let i = 0; i < n; i++) ym += aY[i];
                ym /= n;
                for (let i = 0; i < n; i++) yv += (aY[i] - ym) ** 2;
                const lumaContrast = ym > 0 ? Math.sqrt(yv / n) / ym : 0;

                const tiltDeg = Math.acos(Math.min(1, Math.abs(best.plane.normal[1]))) / DEG;
                const sizeU = best.Nu * best.mppU, sizeV = best.Nv * best.mppV;
                const centreWorld = add(add(best.plane.origin, best.plane.uAxis, best.s0 + sizeU / 2), best.plane.vAxis, best.tTop - sizeV / 2);
                const alignTerm = best.axisDev === null ? 0.85 : Math.max(0, 1 - best.axisDev / (2 * maxAxisDev));
                const gainTerm = gain === null ? 0.5 : Math.min(1, gain / (4 * minGain));
                const sizeTerm = Math.min(1, Math.sqrt(best.Nu * best.Nv) / 256);
                const score = clamp01(best.incidence) * gainTerm * sizeTerm * alignTerm * (0.5 + 0.5 * clamp01(frame.poseConfidence)) * (1 - occluded);

                library.samples.push({
                    id, label, description: mat?.description ?? '',
                    source: { frame: frame.key, panoId: frame.panoId, date: frame.date, poseSource: frame.poseSource, poseConfidence: round(frame.poseConfidence, 3), polygonPx: prop.polygon.map(([x, y]) => [round(x, 1), round(y, 1)] as [number, number]), centreWorld: roundV(centreWorld, 3) },
                    files, widthPx: Nu, heightPx: Nv,
                    metresPerPixel: { u: round(best.mppU, 5), v: round(best.mppV, 5) },
                    sizeMeters: { u: round(sizeU, 3), v: round(sizeV, 3) },
                    plane: { origin: roundV(best.plane.origin, 3), normal: roundV(best.plane.normal, 5), uAxis: roundV(best.plane.uAxis, 5), vAxis: roundV(best.plane.vAxis, 5), tiltDeg: round(tiltDeg, 2), method: best.method, inlierFraction: best.inlierFraction !== null ? round(best.inlierFraction, 3) : null, quadOrthogonalityErrorDeg: best.quadOrthErr !== null ? round(best.quadOrthErr, 2) : null },
                    geometry: { distanceMeters: round(best.distance, 2), incidenceCos: round(best.incidence, 3), heightAboveGround: hag, photoFootprintMeters: { fine: round(best.footprint.fine, 4), coarse: round(best.footprint.coarse, 4) } },
                    tile: tileStats,
                    tileDomain,
                    albedo: { lab: { mean: roundV(albStats.lab.mean, 2), std: roundV(albStats.lab.std, 2) }, linearRgb: roundV(albStats.linearRgb), lumaContrast: round(lumaContrast, 4) },
                    physical: { metalness: round(metal, 3), roughness: round(rough, 3), surfaceTiltHintDeg: mat?.surfaceTiltDeg ?? null },
                    quality: {
                        axisDeviationDeg: best.axisDev !== null ? round(best.axisDev, 2) : null, lineEvidence: round(best.lineEvidence, 2),
                        seamResidualBefore: round(seamBefore, 3), seamResidualAfter: round(seamAfter, 3), illuminationRange: round(illum, 3), clippedFraction: round(clippedFraction, 3),
                        periodMeters: { u: best.periodU !== null ? round(best.periodU, 3) : null, v: best.periodV !== null ? round(best.periodV, 3) : null },
                        occludedFraction: round(occluded, 3), score: round(score, 4)
                    },
                    kernel: { acceleration: k.acceleration }
                });
                rep.accepted++;
                log(`${id}: '${label}' ${Nu}x${Nv} @ ${best.mppU.toFixed(3)}x${best.mppV.toFixed(3)} m/px via ${best.method}, cos ${best.incidence.toFixed(2)}, gain ${gain !== null ? gain.toFixed(1) : '-'}, dev ${best.axisDev !== null ? best.axisDev.toFixed(1) : '-'} deg`);
            } catch (e) {
                const reason = (e as Error).message;
                library.rejected.push({ frame: frame.key, label, reason });
                if (!(e instanceof SampleRejection)) log(`${id}: error ${reason}`);
            }
        }
        rep.timingsMs.samples = Date.now() - t2;
    }
    const libraryPath = path.join(opts.outDir, 'library.json');
    fs.writeFileSync(libraryPath, JSON.stringify(library, null, 1));
    return { library, libraryPath, frameReports };
}

/** Fills unset pixels with the nearest set pixel (breadth-first, 4-connected). */
export function fillInvalidNearest(rgb: Float32Array, valid: Uint8Array, W: number, H: number): void {
    const done = Uint8Array.from(valid);
    let frontier: number[] = [];
    for (let i = 0; i < W * H; i++) if (done[i]) frontier.push(i);
    while (frontier.length) {
        const next: number[] = [];
        for (const i of frontier) {
            const x = i % W, y = (i / W) | 0;
            const nb = [x > 0 ? i - 1 : -1, x + 1 < W ? i + 1 : -1, y > 0 ? i - W : -1, y + 1 < H ? i + W : -1];
            for (const j of nb) {
                if (j < 0 || done[j]) continue;
                done[j] = 1;
                rgb[j * 3] = rgb[i * 3]; rgb[j * 3 + 1] = rgb[i * 3 + 1]; rgb[j * 3 + 2] = rgb[i * 3 + 2];
                next.push(j);
            }
        }
        frontier = next;
    }
}

/**
 * Per-channel photo-to-tile gain of a frame: median of blurred tile / blurred photo over usable, unclipped mesh pixels away
 * from depth edges (blurring makes the ratio tolerant of a few pixels of misregistration). Null with too little support.
 */
export function photoToTileGain(photoLin: Float32Array, tileRgba: Buffer, depth: Float32Array, usable: Uint8Array, W: number, H: number): Vec3 | null {
    const EMPTY = PLATE_EMPTY_DEPTH * 0.5;
    const mask = new Uint8Array(W * H);
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
        const i = y * W + x, d = depth[i];
        if (!usable[i] || !(d < EMPTY)) continue;
        let edge = false;
        for (const j of [i - 1, i + 1, i - W, i + W]) if (!(depth[j] < EMPTY) || Math.abs(depth[j] - d) > 0.05 * d) { edge = true; break; }
        if (!edge) mask[i] = 1;
    }
    const m = erodeMask(mask, W, H, 4);
    const gains: Vec3 = [1, 1, 1];
    for (let c = 0; c < 3; c++) {
        const P = new Float32Array(W * H), T = new Float32Array(W * H);
        for (let i = 0; i < W * H; i++) { P[i] = photoLin[i * 3 + c]; T[i] = srgb8ToLinear(tileRgba[i * 4 + c]); }
        const Pb = gaussianBlur(P, W, H, 3), Tb = gaussianBlur(T, W, H, 3);
        const ratios: number[] = [];
        for (let i = 0; i < W * H; i += 2) if (m[i] && Pb[i] > 0.01 && Pb[i] < 0.85 && Tb[i] > 0.005) ratios.push(Tb[i] / Pb[i]);
        if (ratios.length < 500) return null;
        gains[c] = quantile(ratios, 0.5);
    }
    return gains;
}

interface BuildSwatchOptions {
    minCos: number; minCropPx: number; minCropArea: number; minCropM: number; maxSwatch: number; maxAspect: number;
    tiltHint: number | null; maxTiltDis: number;
}

/** Rectifies one plane candidate into a power-of-two swatch (largest clean rectangle, period-aligned, axis-corrected). */
function buildSwatch(
    cand: PlaneCandidate, cam: FrameCamera, photoLin: Float32Array, usable: Uint8Array, polygon: Array<[number, number]>,
    depthAt: (u: number, v: number) => number | null, o: BuildSwatchOptions
): SwatchBuild {
    let plane = cand.plane;
    const tiltDeg = Math.acos(Math.min(1, Math.abs(plane.normal[1]))) / DEG;
    if (o.tiltHint !== null && Math.abs(tiltDeg - o.tiltHint) > o.maxTiltDis) throw new Error(`plane tilt ${tiltDeg.toFixed(0)} deg disagrees with hint ${o.tiltHint.toFixed(0)} deg`);
    const toEye = sub(cam.eye, plane.origin);
    const distance = Math.hypot(...toEye);
    const incidence = Math.abs(dot(plane.normal, toEye)) / distance;
    if (incidence < o.minCos) throw new Error(`incidence cos ${incidence.toFixed(2)} < ${o.minCos}`);
    // polygon extent on the plane
    let sMin = Infinity, sMax = -Infinity, tMin = Infinity, tMax = -Infinity;
    for (const [u, v] of polygon) {
        const ray = camToWorldDir(cam, pixelRayCam(cam, u, v));
        const lam = rayPlane(cam.eye, ray, plane);
        if (lam === null) continue;
        const d = sub(add(cam.eye, ray, lam), plane.origin);
        const s = dot(d, plane.uAxis), t = dot(d, plane.vAxis);
        sMin = Math.min(sMin, s); sMax = Math.max(sMax, s); tMin = Math.min(tMin, t); tMax = Math.max(tMax, t);
    }
    if (!(sMax > sMin && tMax > tMin)) throw new Error('polygon does not map onto the plane');
    // footprint: coarse axis over a 5x5 grid (median) -> isotropic scale
    const coarse: number[] = [], fine: number[] = [];
    for (let a = 0; a < 5; a++) for (let b = 0; b < 5; b++) {
        const f = planeFootprint(cam, plane, sMin + (a + 0.5) / 5 * (sMax - sMin), tMin + (b + 0.5) / 5 * (tMax - tMin));
        if (f) { coarse.push(f.coarse); fine.push(f.fine); }
    }
    if (!coarse.length) throw new Error('no photo footprint on the plane');
    const mpp0 = quantile(coarse, 0.5);
    const footprint = { fine: quantile(fine, 0.5), coarse: mpp0 };
    // coarse validity canvas
    const maxCanvas = 1024;
    let cm = mpp0;
    const ext = Math.max(sMax - sMin, tMax - tMin);
    if (ext / cm > maxCanvas) cm = ext / maxCanvas;
    const Cw = Math.max(1, Math.ceil((sMax - sMin) / cm)), Ch = Math.max(1, Math.ceil((tMax - tMin) / cm));
    const canvas = rectifyPlaneRegion(photoLin, usable, cam, plane, sMin, tMax, cm, cm, Cw, Ch, 1);
    // depth consistency (mesh vs plane) where the mesh is present: rejects pixels of another surface in front
    for (let j = 0; j < Ch; j++) for (let i = 0; i < Cw; i++) {
        const k = j * Cw + i;
        if (!canvas.valid[k]) continue;
        const P = add(add(plane.origin, plane.uAxis, sMin + (i + 0.5) * cm), plane.vAxis, tMax - (j + 0.5) * cm);
        const pr = projectPoint(cam, P);
        if (!pr) { canvas.valid[k] = 0; continue; }
        const dm = depthAt(pr[0], pr[1]);
        if (dm !== null && dm < pr[2] - (1.0 + 0.05 * pr[2])) canvas.valid[k] = 0;
    }
    const rect = largestValidRectangle(erodeMask(canvas.valid, Cw, Ch, 1), Cw, Ch, o.maxAspect);
    if (!rect) throw new Error('no clean rectangle');
    let wM = rect.w * cm, hM = rect.h * cm;
    const s0 = sMin + rect.x * cm, tTop = tMax - rect.y * cm;
    const wPx = wM / mpp0, hPx = hM / mpp0;
    if (Math.min(wPx, hPx) < o.minCropPx || wPx * hPx < o.minCropArea || Math.min(wM, hM) < o.minCropM) {
        throw new Error(`clean rectangle ${wM.toFixed(2)}x${hM.toFixed(2)} m (${wPx.toFixed(0)}x${hPx.toFixed(0)} px) too small`);
    }
    // first pass at mpp0 for period / alignment
    const pow2 = (len: number) => Math.max(16, Math.min(o.maxSwatch, 2 ** Math.round(Math.log2(len))));
    const firstNu = Math.min(1024, Math.round(wM / mpp0)), firstNv = Math.min(1024, Math.round(hM / mpp0));
    const first = rectifyPlaneRegion(photoLin, usable, cam, plane, s0, tTop, wM / firstNu, hM / firstNv, firstNu, firstNv, 2);
    const Y1 = luminanceOf(first.rgb, firstNu * firstNv);
    // in-plane rotation correction (camera roll / yaw error): try +-dev and keep the better one
    let align = axisAlignment(Y1, firstNu, firstNv);
    const devOf = (a: ReturnType<typeof axisAlignment>) => {
        const d = [a.deviationVerticalDeg, a.deviationHorizontalDeg].filter((x): x is number => x !== null).map(Math.abs);
        return d.length ? Math.max(...d) : null;
    };
    let dev = devOf(align);
    if (dev !== null && dev > 0.5 && dev <= 8) {
        const dv = align.deviationVerticalDeg, dh = align.deviationHorizontalDeg;
        const rot = dv !== null && dh !== null ? (Math.abs(dv - dh) < 1.5 ? (dv + dh) / 2 : null) : (dv ?? dh);
        if (rot !== null) {
            for (const sgn of [1, -1]) {
                const pr = rotatePlaneAxes(plane, sgn * rot);
                const sw = rectifyPlaneRegion(photoLin, usable, cam, pr, s0, tTop, wM / firstNu, hM / firstNv, firstNu, firstNv, 2);
                const validFrac = sw.valid.reduce((s, v) => s + v, 0) / sw.valid.length;
                if (validFrac < 0.98) continue;
                const al = axisAlignment(luminanceOf(sw.rgb, firstNu * firstNv), firstNu, firstNv);
                const d2 = devOf(al);
                if (d2 !== null && d2 < dev!) { plane = pr; align = al; dev = d2; }
            }
        }
    }
    // period alignment of the crop size
    const Yb = luminanceOf(rectifyPlaneRegion(photoLin, usable, cam, plane, s0, tTop, wM / firstNu, hM / firstNv, firstNu, firstNv, 1).rgb, firstNu * firstNv);
    const pu = dominantPeriod(Yb, firstNu, firstNv, 'x'), pv = dominantPeriod(Yb, firstNu, firstNv, 'y');
    const periodU = pu.period !== null ? pu.period * wM / firstNu : null, periodV = pv.period !== null ? pv.period * hM / firstNv : null;
    if (periodU !== null && wM >= periodU) wM = Math.floor(wM / periodU + 1e-6) * periodU;
    if (periodV !== null && hM >= periodV) hM = Math.floor(hM / periodV + 1e-6) * periodV;
    const Nu = pow2(wM / mpp0), Nv = pow2(hM / mpp0);
    const mppU = wM / Nu, mppV = hM / Nv;
    const ss = Math.max(2, Math.min(4, Math.ceil(Math.max(mppU, mppV) / footprint.fine)));
    const swatch = rectifyPlaneRegion(photoLin, usable, cam, plane, s0, tTop, mppU, mppV, Nu, Nv, ss);
    let invalid = 0;
    for (let i = 0; i < Nu * Nv; i++) if (!swatch.valid[i]) invalid++;
    if (invalid > 0.01 * Nu * Nv) throw new Error(`final swatch has ${(100 * invalid / (Nu * Nv)).toFixed(1)}% invalid pixels`);
    if (invalid) fillInvalidNearest(swatch.rgb, swatch.valid, Nu, Nv);
    const finalAlign = axisAlignment(luminanceOf(swatch.rgb, Nu * Nv), Nu, Nv);
    return {
        plane, method: cand.method, inlierFraction: cand.inlierFraction, quadOrthErr: cand.quadOrthErr,
        s0, tTop, mppU, mppV, Nu, Nv, swatch,
        axisDev: devOf(finalAlign), lineEvidence: Math.max(finalAlign.evidenceVertical, finalAlign.evidenceHorizontal),
        periodU, periodV, footprint, incidence, distance
    };
}
