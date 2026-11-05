/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K's facade upscale (opt-in): each rebuilt facade's texture in the twin (facade-lattice.ts's FacadeLattice_<id>
 * nodes, the straightened, de-lit photo at the tile's own resolution) given fine detail by an image model, held to the
 * photo so the model can only sharpen, never redraw:
 *
 *  1. The texture cut into square tiles (tilePx a side, overlapPx shared) and each sent to the image model ("the same
 *     picture at higher resolution"); its answer resized to the tile times the factor. Each answer is kept in the model
 *     readings store under the tile's pixels, the prompt and the models (`facade-upscale/<sha256>`), so a facade is
 *     upscaled once and every later run, chunk or machine reads it back.
 *  2. Detail transfer: the output is the photo enlarged (bilinear) plus only the answer's fine detail (the answer minus
 *     its own enlarged box-average), so at the photo's resolution the result is the photo, texel for texel.
 *  3. The detail is kept where the answer, shrunk back and its smooth colour offset removed (offsetRadiusPx), still
 *     matches the photo (CIELAB difference under fullDeltaE: all
 *     of it; over maxDeltaE: none; between, a ramp; the difference smoothed and grown by a texel), so where the model
 *     redrew something (a sign drawn into a blur, windows painted on a filled patch) none of its detail is used.
 *  4. The detail's amplitude is capped at softRatio times the photo's own local contrast (contrastFloor at least), so a
 *     soft patch (a smear, a sign the photo cannot read) gains at most grain, never letters or edges the photo lacks.
 *
 * The upscaled texture is labelled generated (sbFacadeUpscale in the node's extras: the model, the factor, the share of
 * detail kept, the mean difference), and the twin's provenance gains one entry. A facade too small, one whose texture
 * cannot grow by minFactor within maxTexels, one past the build's call budget, and every facade when no image model is
 * available, keep their photo, and the report says why. Facades go lowest first (the ones a walk reaches), then larger.
 */

import * as crypto from 'crypto';
import { linearRgbToLab } from '../../../../common/spatial/texture-library-index';
import { assembleGlb, parseGlbBytes } from '../glb-bytes';
import { encodePng } from '../png-encode';
import { resizeRgba, type EnhanceModelClient } from '../texture-enhance';
import { decodeImageInMemory, type RgbaImage8 } from '../tile-texture-transfer';
import { readingKey, type ModelReadingStore } from './model-readings';

export const FACADE_UPSCALE_VERSION = 'facade-upscale/2';

/** The image models asked, in order: the one the 2026-11-03 Penn test used first. */
export const FACADE_UPSCALE_MODELS = ['gemini-3-pro-image', 'gemini-3.1-flash-image'];

export const FACADE_UPSCALE_PARAMS = {
    /** Output texels per photo texel along each side, at most; less when maxTexels or maxSidePx would be passed. */
    factor: 4,
    /** A facade that cannot grow by at least this factor keeps its photo. */
    minFactor: 2,
    /** The upscaled texture's texels and longest side, at most (memory and the viewer's texture limit). */
    maxTexels: 4096 * 4096,
    maxSidePx: 8192,
    /** A facade texture with a side under this keeps its photo (too little to read). */
    minSidePx: 48,
    /** Photo texels a model call covers (a square), and the overlap of neighbouring tiles, feathered. */
    tilePx: 1024,
    overlapPx: 48,
    /** Model calls a build may make (answers read back from the store are free and not counted). */
    maxCalls: 48,
    /** Model calls in flight at once, and facades worked on at once (each answer takes about 40 s). */
    concurrency: 4,
    /** No facade is started after this long (ms); one started finishes. The rest keep their photo, with the reason. */
    maxMs: 15 * 60_000,
    /** CIELAB difference between the photo and the answer shrunk back: all detail kept at or under fullDeltaE, none at maxDeltaE. */
    fullDeltaE: 3,
    maxDeltaE: 7,
    /** The answer's colour offset from the photo averaged over this radius (photo texels, a box) is removed before the difference: a smooth shift in colour or brightness carries no fine detail, so only a different shape counts. */
    offsetRadiusPx: 6,
    /** The detail's amplitude (8-bit sRGB) at most softRatio times the photo's 3 x 3 contrast, and at least contrastFloor. */
    softRatio: 1.5,
    contrastFloor: 3
};

export type FacadeUpscaleParams = typeof FACADE_UPSCALE_PARAMS;

/**
 * A district's chunk (pipeline K-D), where the upscale is on by default (user decision, 2026-11-04): a dozen calls and six
 * minutes a chunk, the lowest facades first, so a 21-chunk district asks at most about 250 tiles the first time (about
 * $35-60) and nothing for tiles already answered; within its run's own budget.
 */
export const FACADE_UPSCALE_DISTRICT_PARAMS: FacadeUpscaleParams = { ...FACADE_UPSCALE_PARAMS, maxCalls: 12, maxMs: 6 * 60_000 };

/** The time a single building's own budget and its chat tool's limit grow by when the upscale is on: its maxMs plus the facades in flight. */
export const FACADE_UPSCALE_EXTRA_MS = 20 * 60_000;

/**
 * Whether a build runs the upscale: the node graph's switch when set, else SCRATCHBOX_K_FACADE_UPSCALE (1 on, 0 off), else
 * on for a district (K-D, its chunks too) and off for a single building.
 */
export function facadeUpscaleAsked(steps: Record<string, unknown> | undefined, opts: { district?: boolean } = {}): boolean {
    const asked = steps?.['twin.facadeUpscale'];
    if (typeof asked === 'boolean') return asked;
    const env = process.env.SCRATCHBOX_K_FACADE_UPSCALE?.trim();
    return env === '1' ? true : env === '0' ? false : opts.district === true;
}

export interface FacadeUpscaleFacade {
    facadeId: number; node: string;
    /** Photo size and upscaled size (px). */
    from: [number, number]; to?: [number, number]; factor?: number;
    /** Model calls made, and tiles read back from the store. */
    calls: number; cached: number;
    /** Share of the detail kept after the faithfulness mask (0..1), the mean shrunk-back difference, and the share of texels whose detail the contrast cap limited. */
    keptShare?: number; meanDeltaE?: number; cappedShare?: number;
    model?: string; skipped?: string;
}

export interface FacadeUpscaleReport {
    version: string; facades: number; upscaled: number; calls: number; cached: number;
    perFacade: FacadeUpscaleFacade[];
    /** The upscaled facades' share of the rebuilt facades' texels (photo resolution), for the provenance entry. */
    coverage: number;
    skipped?: string;
}

/** The prompt: the same picture at a higher resolution, nothing added. */
export function facadeUpscalePrompt(): string {
    return [
        'Upscale this image to a higher resolution and return only the image.',
        "It is a straight-on, evenly lit orthographic photo of part of a real building's facade.",
        'Return exactly the same picture with the same framing, edge for edge: every window, mullion, joint, edge and colour exactly where and as it is.',
        'Sharpen only what is already there and add only fine surface texture consistent with the material (stone grain, brick joints, glass, metal).',
        'Where the image is blurry or plain, keep it plain: do not add or sharpen any text, letters, numbers, signs, logos, people, vehicles, objects or windows that are not clearly visible.',
        'No borders, no lighting change, no shadows.'
    ].join(' ');
}

const PROMPT_KEY = crypto.createHash('sha256').update(facadeUpscalePrompt()).digest('hex').slice(0, 16);

/** The integer factor a facade grows by: the largest within factor, maxTexels and maxSidePx; 0 when under minFactor. */
export function upscaleFactor(width: number, height: number, P: FacadeUpscaleParams = FACADE_UPSCALE_PARAMS): number {
    for (let f = Math.floor(P.factor); f >= P.minFactor; f--) if (width * height * f * f <= P.maxTexels && Math.max(width, height) * f <= P.maxSidePx) return f;
    return 0;
}

/** Tile starts along one side: one tile when it fits, else tiles of `tile` sharing `overlap`, the last flush with the end. */
export function tileStarts(length: number, tile: number, overlap: number): number[] {
    if (length <= tile) return [0];
    const step = Math.max(1, tile - overlap), out: number[] = [];
    for (let s = 0; s + tile < length; s += step) out.push(s);
    out.push(length - tile);
    return out;
}

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const LIN = Float64Array.from({ length: 256 }, (_, v) => srgbToLinear(v / 255));

function labOf(r: number, g: number, b: number): [number, number, number] {
    return linearRgbToLab([LIN[Math.round(Math.max(0, Math.min(255, r)))], LIN[Math.round(Math.max(0, Math.min(255, g)))], LIN[Math.round(Math.max(0, Math.min(255, b)))]]);
}

/** Bilinear sample of a W x H x C float field at a source position (texel centres at integer + 0.5). */
function sample(field: Float32Array, W: number, H: number, C: number, fx: number, fy: number, c: number): number {
    const x = Math.max(0, Math.min(W - 1, fx - 0.5)), y = Math.max(0, Math.min(H - 1, fy - 0.5));
    const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1), tx = x - x0, ty = y - y0;
    const a = field[(y0 * W + x0) * C + c], b = field[(y0 * W + x1) * C + c], d = field[(y1 * W + x0) * C + c], e = field[(y1 * W + x1) * C + c];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (d * (1 - tx) + e * tx) * ty;
}

/**
 * The detail transfer (steps 2 to 4 of the file comment): the photo `src` (W x H) and the model's answer `ai`, already at
 * W*F x H*F. Returns the upscaled texture and what the mask and the cap did.
 */
export function transferDetail(src: RgbaImage8, ai: RgbaImage8, F: number, P: FacadeUpscaleParams = FACADE_UPSCALE_PARAMS): { image: RgbaImage8; keptShare: number; meanDeltaE: number; cappedShare: number } {
    const W = src.width, H = src.height, OW = W * F, OH = H * F;
    if (ai.width !== OW || ai.height !== OH) throw new Error(`the answer is ${ai.width} x ${ai.height}, not ${OW} x ${OH}`);
    const n = W * H;
    // the photo and the answer's box average at the photo's resolution, as floats
    const photo = new Float32Array(n * 3), low = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) photo[i * 3 + c] = src.rgba[i * 4 + c];
    const inv = 1 / (F * F);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        let r = 0, g = 0, b = 0;
        for (let dy = 0; dy < F; dy++) { let o = ((y * F + dy) * OW + x * F) * 4; for (let dx = 0; dx < F; dx++, o += 4) { r += ai.rgba[o]; g += ai.rgba[o + 1]; b += ai.rgba[o + 2]; } }
        const i = (y * W + x) * 3;
        low[i] = r * inv; low[i + 1] = g * inv; low[i + 2] = b * inv;
    }
    // the answer's smooth colour offset from the photo, removed: low less the offset's local mean
    const off = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i++) off[i] = low[i] - photo[i];
    const offMean = boxBlur3(off, W, H, P.offsetRadiusPx);
    const lowAligned = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i++) lowAligned[i] = low[i] - offMean[i];
    // the shrunk-back difference per photo texel, smoothed (3 x 3 mean) and grown by a texel (3 x 3 max)
    const de = new Float32Array(n);
    let deSum = 0;
    for (let i = 0; i < n; i++) {
        const a = labOf(photo[i * 3], photo[i * 3 + 1], photo[i * 3 + 2]), b = labOf(lowAligned[i * 3], lowAligned[i * 3 + 1], lowAligned[i * 3 + 2]);
        de[i] = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
        deSum += de[i];
    }
    const box = (f: Float32Array, op: 'mean' | 'max') => {
        const out = new Float32Array(n);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            let s = op === 'max' ? -Infinity : 0, k = 0;
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                const xx = x + dx, yy = y + dy;
                if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
                const v = f[yy * W + xx];
                if (op === 'max') s = Math.max(s, v); else { s += v; k++; }
            }
            out[y * W + x] = op === 'max' ? s : s / k;
        }
        return out;
    };
    const deGrown = box(box(de, 'mean'), 'max');
    // the keep weight, and the contrast cap from the photo's 3 x 3 luminance spread
    const keep = new Float32Array(n), cap = new Float32Array(n);
    let keptSum = 0;
    for (let i = 0; i < n; i++) {
        keep[i] = Math.max(0, Math.min(1, (P.maxDeltaE - deGrown[i]) / Math.max(1e-6, P.maxDeltaE - P.fullDeltaE)));
        keptSum += keep[i];
    }
    const lum = new Float32Array(n);
    for (let i = 0; i < n; i++) lum[i] = 0.2126 * photo[i * 3] + 0.7152 * photo[i * 3 + 1] + 0.0722 * photo[i * 3 + 2];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        let s = 0, s2 = 0, k = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
            const v = lum[yy * W + xx]; s += v; s2 += v * v; k++;
        }
        const sd = Math.sqrt(Math.max(0, s2 / k - (s / k) * (s / k)));
        cap[y * W + x] = P.softRatio * Math.max(sd, P.contrastFloor);
    }
    // the output: the photo enlarged plus the kept, capped detail
    const out = new Uint8Array(OW * OH * 4);
    let capped = 0;
    for (let oy = 0; oy < OH; oy++) for (let ox = 0; ox < OW; ox++) {
        const fx = (ox + 0.5) / F, fy = (oy + 0.5) / F, o = (oy * OW + ox) * 4;
        const w = sample(keep, W, H, 1, fx, fy, 0), lim = sample(cap, W, H, 1, fx, fy, 0);
        let hit = false;
        for (let c = 0; c < 3; c++) {
            const base = sample(photo, W, H, 3, fx, fy, c);
            let d = ai.rgba[o + c] - sample(low, W, H, 3, fx, fy, c);
            if (d > lim) { d = lim; hit = true; } else if (d < -lim) { d = -lim; hit = true; }
            out[o + c] = Math.max(0, Math.min(255, Math.round(base + w * d)));
        }
        if (hit && w > 0) capped++;
        // alpha: the photo's own, nearest
        out[o + 3] = src.rgba[(Math.min(H - 1, Math.floor(oy / F)) * W + Math.min(W - 1, Math.floor(ox / F))) * 4 + 3];
    }
    return { image: { width: OW, height: OH, rgba: out }, keptShare: n ? keptSum / n : 0, meanDeltaE: n ? deSum / n : 0, cappedShare: OW * OH ? capped / (OW * OH) : 0 };
}

/** A box mean of radius r over a W x H x 3 field (separable, clamped at the edges). */
function boxBlur3(f: Float32Array, W: number, H: number, r: number): Float32Array {
    if (r <= 0) return Float32Array.from(f);
    const tmp = new Float32Array(f.length), out = new Float32Array(f.length);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let c = 0; c < 3; c++) {
        let s = 0, k = 0;
        for (let d = -r; d <= r; d++) { const xx = x + d; if (xx < 0 || xx >= W) continue; s += f[(y * W + xx) * 3 + c]; k++; }
        tmp[(y * W + x) * 3 + c] = s / k;
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let c = 0; c < 3; c++) {
        let s = 0, k = 0;
        for (let d = -r; d <= r; d++) { const yy = y + d; if (yy < 0 || yy >= H) continue; s += tmp[(yy * W + x) * 3 + c]; k++; }
        out[(y * W + x) * 3 + c] = s / k;
    }
    return out;
}

/** One square crop of the photo, padded past the image's edge with its own edge texels. */
function squareCrop(img: RgbaImage8, x0: number, y0: number, side: number): RgbaImage8 {
    const out = new Uint8Array(side * side * 4);
    for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
        const sx = Math.min(img.width - 1, x0 + x), sy = Math.min(img.height - 1, y0 + y);
        out.set(img.rgba.subarray((sy * img.width + sx) * 4, (sy * img.width + sx) * 4 + 4), (y * side + x) * 4);
    }
    return { width: side, height: side, rgba: out };
}

const imageSizeFor = (px: number) => (px <= 1024 ? '1K' : px <= 2048 ? '2K' : '4K');

interface StoredAnswer { model: string; mimeType: string; data: string }

/**
 * The model's answer for the whole photo at W*F x H*F: its tiles asked (or read back from the store) and blended,
 * feathered across their overlaps. Throws when a call fails.
 */
async function upscaleByTiles(photo: RgbaImage8, F: number, opts: { client: EnhanceModelClient; models: string[]; store?: ModelReadingStore; signal?: AbortSignal; label: string; limit: Limit }, P: FacadeUpscaleParams): Promise<{ ai: RgbaImage8; calls: number; cached: number; model?: string }> {
    const W = photo.width, H = photo.height, T = Math.min(P.tilePx, Math.max(W, H)), OW = W * F, OH = H * F, OT = T * F;
    const xs = tileStarts(W, T, P.overlapPx), ys = tileStarts(H, T, P.overlapPx);
    const acc = new Float32Array(OW * OH * 3), wsum = new Float32Array(OW * OH);
    const ramp = P.overlapPx * F;
    let calls = 0, cached = 0, model: string | undefined;
    // the tiles' answers (the build's call limit gates the model calls), then blended in order
    const starts = ys.flatMap(y0 => xs.map(x0 => [x0, y0] as const));
    const answers = await Promise.all(starts.map(async ([x0, y0]): Promise<StoredAnswer> => {
        const png = encodePng(T, T, squareCrop(photo, x0, y0, T).rgba, 4);
        const key = readingKey('facade-upscale', [FACADE_UPSCALE_VERSION, PROMPT_KEY, opts.models.join(','), imageSizeFor(OT), png]);
        const kept = opts.store ? await opts.store.get<StoredAnswer>(key) : undefined;
        if (kept) { cached++; return kept; }
        const answer = await opts.limit(() => opts.client({ label: `${opts.label}@${x0},${y0}`, models: opts.models, prompt: facadeUpscalePrompt(), image: { mimeType: 'image/png', bytes: png, width: T, height: T }, references: [], imageSize: imageSizeFor(OT), ...(opts.signal ? { signal: opts.signal } : {}) }));
        calls++;
        const stored = { model: answer.modelUsed, mimeType: answer.mimeType, data: Buffer.from(answer.bytes).toString('base64') };
        opts.store?.put(key, stored);
        return stored;
    }));
    starts.forEach(([x0, y0], k) => {
        const stored = answers[k];
        model ??= stored.model;
        const tile = resizeRgba(decodeImageInMemory(Buffer.from(stored.data, 'base64')), OT, OT);
        // the tile's weight: 1 inside, falling to 0 across an overlap with a neighbour (never at the image's own edge)
        const left = x0 > 0, top = y0 > 0, right = x0 + T < W, bottom = y0 + T < H;
        const cw = Math.min(OT, OW - x0 * F), ch = Math.min(OT, OH - y0 * F);
        for (let y = 0; y < ch; y++) {
            const wy = Math.min(top ? (y + 0.5) / ramp : 1, bottom ? (ch - y - 0.5) / ramp : 1, 1);
            for (let x = 0; x < cw; x++) {
                const wx = Math.min(left ? (x + 0.5) / ramp : 1, right ? (cw - x - 0.5) / ramp : 1, 1);
                const w = Math.max(1e-3, wx * wy), t = (y * OT + x) * 4, o = (y0 * F + y) * OW + x0 * F + x;
                acc[o * 3] += w * tile.rgba[t]; acc[o * 3 + 1] += w * tile.rgba[t + 1]; acc[o * 3 + 2] += w * tile.rgba[t + 2];
                wsum[o] += w;
            }
        }
    });
    const rgba = new Uint8Array(OW * OH * 4);
    for (let i = 0; i < OW * OH; i++) {
        const w = wsum[i] || 1;
        rgba[i * 4] = Math.round(acc[i * 3] / w); rgba[i * 4 + 1] = Math.round(acc[i * 3 + 1] / w); rgba[i * 4 + 2] = Math.round(acc[i * 3 + 2] / w); rgba[i * 4 + 3] = 255;
    }
    return { ai: { width: OW, height: OH, rgba }, calls, cached, ...(model ? { model } : {}) };
}

/** The model calls a photo needs at its factor. */
export function tilesFor(width: number, height: number, P: FacadeUpscaleParams = FACADE_UPSCALE_PARAMS): number {
    const T = Math.min(P.tilePx, Math.max(width, height));
    return tileStarts(width, T, P.overlapPx).length * tileStarts(height, T, P.overlapPx).length;
}

/** The provenance entry the twin gains. */
export const facadeUpscaleProvenance = (report: Pick<FacadeUpscaleReport, 'coverage' | 'perFacade'>) => {
    const done = report.perFacade.filter(f => f.to);
    const models = [...new Set(done.map(f => f.model).filter(Boolean))].join(', ');
    return { source: 'facade-upscale', label: 'generated' as const, method: `the rebuilt facades' photos upscaled by an image model (${models || 'none'}): only its fine detail kept, where its answer shrunk back still matches the photo, and no stronger than the photo's own contrast; the photo's colours and shapes unchanged`, coverage: report.coverage };
};

/**
 * Upscales the rebuilt facades' textures in a twin (see the file comment). Never throws for a facade: a failed call
 * leaves that facade as its photo, with the reason; an abort propagates.
 */
export async function upscaleFacadeTextures(twin: Uint8Array, opts: { client?: EnhanceModelClient; models?: string[]; store?: ModelReadingStore; signal?: AbortSignal; progress?: (m: string) => void }, P: FacadeUpscaleParams = FACADE_UPSCALE_PARAMS): Promise<{ glb: Buffer; report: FacadeUpscaleReport }> {
    const g = parseGlbBytes(twin), json = g.json;
    const models = opts.models ?? FACADE_UPSCALE_MODELS;
    // each rebuilt facade: its node, its base colour image, and its lowest point (for the order)
    const found: Array<{ facadeId: number; node: any; image: number; bottom: number }> = [];
    for (const node of json.nodes ?? []) {
        const name: string = node.name ?? '';
        if (!name.startsWith('FacadeLattice_') || node.mesh === undefined) continue;
        const prim = json.meshes?.[node.mesh]?.primitives?.[0];
        const tex = prim?.material !== undefined ? json.materials?.[prim.material]?.pbrMetallicRoughness?.baseColorTexture?.index : undefined;
        const image = tex !== undefined ? json.textures?.[tex]?.source : undefined;
        if (image === undefined || json.images?.[image]?.bufferView === undefined) continue;
        const pos = prim.attributes?.POSITION !== undefined ? json.accessors?.[prim.attributes.POSITION] : undefined;
        found.push({ facadeId: node.extras?.sbFacadeLattice?.facadeId ?? Number(name.slice('FacadeLattice_'.length)), node, image, bottom: pos?.min?.[1] ?? 0 });
    }
    const report: FacadeUpscaleReport = { version: FACADE_UPSCALE_VERSION, facades: found.length, upscaled: 0, calls: 0, cached: 0, perFacade: [], coverage: 0 };
    const unchanged = (skipped: string) => ({ glb: Buffer.from(twin), report: { ...report, skipped } });
    if (!found.length) return unchanged('no rebuilt facade in this model');
    if (!opts.client) return unchanged('no image model client in this build\'s services');
    const viewBytes = (v: number) => { const bv = json.bufferViews[v]; return g.bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength); };
    // lowest first (what a walk reaches), then the larger photo; an image shared by two facades is done once
    const decoded = new Map<number, RgbaImage8>();
    const order = found.map(f => {
        let img = decoded.get(f.image);
        if (!img) { img = decodeImageInMemory(viewBytes(json.images[f.image].bufferView)); decoded.set(f.image, img); }
        return { ...f, img };
    }).sort((a, b) => a.bottom - b.bottom || b.img.width * b.img.height - a.img.width * a.img.height);
    const replaced = new Map<number, { png: Buffer; facade: FacadeUpscaleFacade }>();
    let totalTexels = 0, upTexels = 0;
    // planned in order: what each facade is skipped for, and the call budget reserved lowest first (a facade past it is
    // still read from the store, with no call allowed)
    const firstOf = new Map<number, FacadeUpscaleFacade>(), copies: Array<{ row: FacadeUpscaleFacade; image: number; texels: number }> = [];
    const work: Array<{ f: (typeof order)[number]; row: FacadeUpscaleFacade; F: number; allowCalls: boolean }> = [];
    let reserved = 0;
    for (const f of order) {
        const { img } = f, row: FacadeUpscaleFacade = { facadeId: f.facadeId, node: f.node.name, from: [img.width, img.height], calls: 0, cached: 0 };
        report.perFacade.push(row);
        totalTexels += img.width * img.height;
        if (firstOf.has(f.image)) { copies.push({ row, image: f.image, texels: img.width * img.height }); continue; }
        firstOf.set(f.image, row);
        if (Math.min(img.width, img.height) < P.minSidePx) { row.skipped = `its photo is ${img.width} x ${img.height} px (under ${P.minSidePx} a side)`; continue; }
        const F = upscaleFactor(img.width, img.height, P);
        if (!F) { row.skipped = `its photo (${img.width} x ${img.height} px) cannot grow ${P.minFactor}x within ${P.maxTexels} texels and ${P.maxSidePx} px a side`; continue; }
        const need = tilesFor(img.width, img.height, P), allowCalls = reserved + need <= P.maxCalls;
        if (allowCalls) reserved += need;
        else row.skipped = `past the build's ${P.maxCalls} model calls (${need} tiles; ${reserved} reserved before it)`;
        work.push({ f, row, F, allowCalls });
    }
    const limit = limiter(P.concurrency), denied = (async () => { throw new BudgetSpent(); }) as EnhanceModelClient, deadline = Date.now() + P.maxMs;
    let next = 0;
    const worker = async () => {
        for (let k = next++; k < work.length; k = next++) {
            const { f, row, F } = work[k], { img } = f;
            // past the step's time: only what the store already holds, no call
            const late = Date.now() > deadline, allowCalls = work[k].allowCalls && !late;
            if (late && work[k].allowCalls) row.skipped = `not started within the step's ${Math.round(P.maxMs / 60_000)} min`;
            try {
                const up = await upscaleByTiles(img, F, { client: allowCalls ? opts.client! : denied, models, ...(opts.store ? { store: opts.store } : {}), ...(opts.signal ? { signal: opts.signal } : {}), label: f.node.name, limit }, P);
                delete row.skipped;
                const t = transferDetail(img, up.ai, F, P);
                const opaque = t.image.rgba.every((v, i) => i % 4 !== 3 || v === 255);
                const rgb = opaque ? new Uint8Array(t.image.width * t.image.height * 3) : t.image.rgba;
                if (opaque) for (let i = 0; i < t.image.width * t.image.height; i++) { rgb[i * 3] = t.image.rgba[i * 4]; rgb[i * 3 + 1] = t.image.rgba[i * 4 + 1]; rgb[i * 3 + 2] = t.image.rgba[i * 4 + 2]; }
                Object.assign(row, { to: [t.image.width, t.image.height], factor: F, calls: up.calls, cached: up.cached, keptShare: +t.keptShare.toFixed(3), meanDeltaE: +t.meanDeltaE.toFixed(2), cappedShare: +t.cappedShare.toFixed(3), ...(up.model ? { model: up.model } : {}) });
                replaced.set(f.image, { png: encodePng(t.image.width, t.image.height, rgb, opaque ? 3 : 4), facade: { ...row } });
                report.calls += up.calls; report.cached += up.cached; report.upscaled++;
                upTexels += img.width * img.height;
                opts.progress?.(`facade upscale: ${f.node.name} ${img.width} x ${img.height} -> ${t.image.width} x ${t.image.height} (${Math.round(100 * t.keptShare)}% of the detail kept${up.cached ? `, ${up.cached} tiles saved before` : ''})`);
            } catch (err) {
                if (opts.signal?.aborted || (err as Error)?.name === 'AbortError') throw err;
                if (!(err instanceof BudgetSpent)) row.skipped = `the image model failed: ${err instanceof Error ? err.message : String(err)}`;
            }
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(P.concurrency, work.length)) }, worker));
    // a facade sharing an upscaled image with one before it
    for (const c of copies) {
        const done = replaced.get(c.image);
        if (done) { Object.assign(c.row, { ...done.facade, facadeId: c.row.facadeId, node: c.row.node, calls: 0, cached: 0 }); upTexels += c.texels; }
        else c.row.skipped = firstOf.get(c.image)?.skipped ?? 'its image was not upscaled';
    }
    report.coverage = totalTexels ? +(upTexels / totalTexels).toFixed(4) : 0;
    if (!replaced.size) return { glb: Buffer.from(twin), report: { ...report, skipped: report.perFacade.find(f => f.skipped)?.skipped ?? 'no facade upscaled' } };
    // the twin rewritten: each upscaled image's view replaced, every other view copied as it was
    const newBytes = new Map<number, Uint8Array>();
    for (const [image, { png }] of replaced) { newBytes.set(json.images[image].bufferView, png); json.images[image].mimeType = 'image/png'; }
    const chunks: Uint8Array[] = [];
    let len = 0;
    json.bufferViews = json.bufferViews.map((bv: any, v: number) => {
        const bytes = newBytes.get(v) ?? viewBytes(v);
        const pad = (4 - (len % 4)) % 4;
        if (pad) { chunks.push(new Uint8Array(pad)); len += pad; }
        const out = { ...bv, buffer: 0, byteOffset: len, byteLength: bytes.byteLength };
        chunks.push(bytes); len += bytes.byteLength;
        return out;
    });
    const pad = (4 - (len % 4)) % 4;
    if (pad) { chunks.push(new Uint8Array(pad)); len += pad; }
    const bin = new Uint8Array(len);
    let o = 0;
    for (const c of chunks) { bin.set(c, o); o += c.length; }
    json.buffers = [{ ...(json.buffers?.[0] ?? {}), byteLength: len }];
    // each upscaled facade labelled
    for (const f of found) {
        const row = report.perFacade.find(r => r.node === f.node.name);
        if (!row?.to) continue;
        f.node.extras = { ...(f.node.extras ?? {}), sbFacadeUpscale: { version: FACADE_UPSCALE_VERSION, label: 'generated', model: row.model, factor: row.factor, from: row.from, to: row.to, keptShare: row.keptShare, meanDeltaE: row.meanDeltaE, cappedShare: row.cappedShare, method: facadeUpscaleProvenance(report).method } };
    }
    return { glb: assembleGlb(json, bin), report };
}

/** Runs at most n tasks at once. */
type Limit = <T>(task: () => Promise<T>) => Promise<T>;
function limiter(n: number): Limit {
    let active = 0;
    const waiting: Array<() => void> = [];
    return async task => {
        if (active >= n) await new Promise<void>(go => waiting.push(go));
        active++;
        try { return await task(); } finally { active--; waiting.shift()?.(); }
    };
}

/** A tile that would need a call after the build's budget is spent. */
class BudgetSpent extends Error { constructor() { super('the build\'s model call budget is spent'); } }
