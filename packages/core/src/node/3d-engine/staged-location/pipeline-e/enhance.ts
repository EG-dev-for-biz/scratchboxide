/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline E, enhanced mode (opt-in: SCRATCHBOX_STAGED_ENHANCE=1 or the tool's `enhance: true`; never the default). It
 * trades some strict realism for clean, believable detail, and says so: every texel it writes is labelled `generated`,
 * "AI-enhanced from tile (model, prompt id)".
 *
 * Each large wall's straight-on texture (E's, after inference) is redrawn exactly once by an image model with the AI
 * Beautify prompt's texture-plate variant (buildTexturePlatePrompt), the adjacent wall already finished sent as a reference
 * so materials match across corners. The answer is resized to the input and must keep the input's geometry:
 *
 *   - a small corrective warp (a shift of up to MAX_SHIFT_PX and a scale within MAX_SCALE) is searched to best align its
 *     edges with the input's;
 *   - the wall is rejected when, after it, the symmetric edge chamfer exceeds MAX_CHAMFER_PX, or more than MAX_LOST_SHARE
 *     of the input's edge pixels have no edge of the answer within LOST_EDGE_M (an opening moved, vanished or changed
 *     size). A rejected wall keeps its tile texture.
 */

import { LIGHTING_PROMPTS } from '../texture-lighting';
import { buildTexturePlatePrompt, TEXTURE_PLATE_PROMPT_ID } from '../../../../browser/generative-canvas/services/location-beautify-service';
import { edgeMap, exactDistanceTransform } from '../../../spatial/StreetViewStage3Metrics';
import { decodeImageInMemory, type RgbaImage8 } from '../tile-texture-transfer';
import { padToModelAspect, resizeRgba } from '../texture-enhance';
import { encodePng } from '../png-encode';
import { generateImageWithModels } from '../../../google-media-generation-service';
import { nearestImageAspectRatio } from '../../../../common/media-generation-protocol';
import { lumaPlane } from './image-ops';
import type { FaceTexture } from './massing-glb';
import type { MassingFace } from './native-massing';

export const ENHANCE_MAX_SIDE = 1024;
export const MAX_SHIFT_PX = 6;
export const SEARCH_SIDE = 320;
export const MAX_SCALE = 0.02;
export const MAX_CHAMFER_PX = 2.2;
export const MAX_LOST_SHARE = 0.15;
export const LOST_EDGE_M = 0.3;
export const MIN_ENHANCE_AREA_M2 = 60;

/**
 * The image model redrawing the plates. Chosen on evidence (Puck and Haughwout, 5 walls, 2026-10-19): the full model kept
 * the geometry (edge chamfer 1.54-1.94 px, 2-4% of the tile's edges lost; 4 of 5 walls passed) where Nano Banana Lite
 * invented storefronts and repainted a fire escape as windows (1.80-4.35 px, 7-38% lost; 2 of 5 passed).
 * SCRATCHBOX_STAGED_ENHANCE_MODELS overrides (comma-separated).
 */
export const ENHANCE_MODEL_DEFAULT = 'gemini-3.1-flash-image';
export function enhanceModels(env: NodeJS.ProcessEnv = process.env): string[] {
    const m = (env.SCRATCHBOX_STAGED_ENHANCE_MODELS ?? '').split(',').map(x => x.trim()).filter(Boolean);
    return m.length ? m : [ENHANCE_MODEL_DEFAULT];
}

/** SCRATCHBOX_STAGED_ENHANCE=1 turns enhanced mode on for a server (off by default). */
export function stagedEnhance(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.SCRATCHBOX_STAGED_ENHANCE === '1';
}

export interface PlateRequest { prompt: string; image: Uint8Array; width: number; height: number; reference?: Uint8Array; models: string[]; signal?: AbortSignal }
export interface PlateAnswer { bytes: Uint8Array; modelUsed: string }
export type PlateModelClient = (r: PlateRequest) => Promise<PlateAnswer>;

/** The production client: the Gen AI SDK through generateImageWithModels (the plate first, then the reference). */
export function genAiPlateClient(genai: unknown): PlateModelClient {
    return async r => {
        const parts: unknown[] = [{ text: r.prompt }, { inlineData: { mimeType: 'image/png', data: Buffer.from(r.image).toString('base64') } }];
        if (r.reference) parts.push({ text: 'Second image: the adjacent wall, already finished (reference for materials only).' }, { inlineData: { mimeType: 'image/png', data: Buffer.from(r.reference).toString('base64') } });
        const a = await generateImageWithModels(genai, { models: r.models, contents: [{ role: 'user', parts }], imageConfig: { aspectRatio: nearestImageAspectRatio(r.width, r.height) }, ...(r.signal ? { signal: r.signal } : {}) } as never);
        return { bytes: new Uint8Array(a.data.buffer, a.data.byteOffset, a.data.byteLength), modelUsed: a.modelUsed };
    };
}

/** The de-light study's winning "keep everything in place" sentences (texture-lighting.ts, plain-detailed). */
export function preserveClause(width: number, height: number): string {
    return LIGHTING_PROMPTS['plain-detailed'](width, height).split(/(?<=\.)\s+/).filter(s => /^Keep every|^Same framing/.test(s)).join(' ');
}

export interface AlignResult { dx: number; dy: number; scale: number; chamferPx: number; lostShare: number; accepted: boolean; why: string; aligned: Uint8Array }

/** Edge pixels of an RGBA image over the `use` pixels. */
function edges(rgba: Uint8Array, W: number, H: number, use: Uint8Array): Uint8Array { return edgeMap(lumaPlane(rgba, W, H), W, H, use, 0.88, 1); }

/** Samples `src` (W x H) shifted and scaled about the centre (bilinear). */
function transform(src: Uint8Array, W: number, H: number, dx: number, dy: number, s: number): Uint8Array {
    const out = new Uint8Array(W * H * 4), cx = W / 2, cy = H / 2;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const sx = Math.max(0, Math.min(W - 1.001, (x - cx - dx) / s + cx)), sy = Math.max(0, Math.min(H - 1.001, (y - cy - dy) / s + cy));
        const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
        for (let c = 0; c < 4; c++) {
            const v = (1 - fx) * (1 - fy) * src[(y0 * W + x0) * 4 + c] + fx * (1 - fy) * src[(y0 * W + x0 + 1) * 4 + c] + (1 - fx) * fy * src[((y0 + 1) * W + x0) * 4 + c] + fx * fy * src[((y0 + 1) * W + x0 + 1) * 4 + c];
            out[(y * W + x) * 4 + c] = Math.round(v);
        }
    }
    return out;
}

/**
 * The alignment gate: the corrective warp (shift and scale) that brings the answer's edges nearest the input's, then the
 * symmetric chamfer and the share of the input's edges the answer lost. `use` marks the texels the tile covers.
 */
export function alignPlate(input: Uint8Array, answer: Uint8Array, W: number, H: number, use: Uint8Array, pixelM: number): AlignResult {
    // the search on a copy at most SEARCH_SIDE px long (shift in its pixels), the measurement at full size
    const k = Math.min(1, SEARCH_SIDE / Math.max(W, H));
    const w = Math.max(8, Math.round(W * k)), h = Math.max(8, Math.round(H * k));
    const inS = resizeRgba({ width: W, height: H, rgba: input }, w, h).rgba, ansS = resizeRgba({ width: W, height: H, rgba: answer }, w, h).rgba;
    const useS = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) useS[y * w + x] = use[Math.min(H - 1, Math.floor((y + 0.5) / k)) * W + Math.min(W - 1, Math.floor((x + 0.5) / k))];
    const dtS = exactDistanceTransform(edges(inS, w, h, useS), w, h);
    const meanS = (cand: Uint8Array) => {
        const e = edges(cand, w, h, useS);
        let s = 0, n = 0;
        for (let i = 0; i < w * h; i++) if (e[i] && useS[i]) { s += Math.min(8, dtS[i]); n++; }
        return n ? s / n : 8;
    };
    const R = Math.max(1, Math.round(MAX_SHIFT_PX * k));
    let best = { dx: 0, dy: 0, s: 1, v: meanS(ansS) };
    for (const s of [1 - MAX_SCALE, 1 - MAX_SCALE / 2, 1, 1 + MAX_SCALE / 2, 1 + MAX_SCALE]) for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
        const v = meanS(transform(ansS, w, h, dx, dy, s));
        if (v < best.v - 1e-6) best = { dx, dy, s, v };
    }
    const dx = Math.round(best.dx / k), dy = Math.round(best.dy / k);
    const aligned = transform(answer, W, H, dx, dy, best.s);
    const eIn = edges(input, W, H, use), eOut = edges(aligned, W, H, use);
    const dtIn = exactDistanceTransform(eIn, W, H), dtOut = exactDistanceTransform(eOut, W, H);
    let fwd = 0, nOut = 0, back = 0, nIn = 0, lost = 0;
    const lostPx = LOST_EDGE_M / pixelM;
    for (let i = 0; i < W * H; i++) {
        if (!use[i]) continue;
        if (eOut[i]) { fwd += Math.min(8, dtIn[i]); nOut++; }
        if (eIn[i]) { back += Math.min(8, dtOut[i]); nIn++; if (dtOut[i] > lostPx) lost++; }
    }
    const chamfer = 0.5 * ((nOut ? fwd / nOut : 8) + (nIn ? back / nIn : 8));
    const lostShare = nIn ? lost / nIn : 1;
    const accepted = chamfer <= MAX_CHAMFER_PX && lostShare <= MAX_LOST_SHARE;
    const why = `corrective warp ${dx}, ${dy} px, scale ${best.s.toFixed(3)}; edge chamfer ${chamfer.toFixed(2)} px (at most ${MAX_CHAMFER_PX}); ${(100 * lostShare).toFixed(0)}% of the tile's edges with no edge within ${LOST_EDGE_M} m (at most ${100 * MAX_LOST_SHARE}%)`;
    return { dx, dy, scale: best.s, chamferPx: Math.round(chamfer * 100) / 100, lostShare: Math.round(lostShare * 1000) / 1000, accepted, why, aligned };
}

export interface EnhanceWallRecord { face: number; key: string; accepted: boolean; why: string; model?: string; chamferPx?: number; lostShare?: number; referenceFace?: number; ms: number }

/** The walls worth enhancing, in plan-loop order (so each has its finished neighbour as the reference). */
export function enhanceOrder(faces: MassingFace[], textures: Map<number, FaceTexture>, minCoverage: number): MassingFace[] {
    return faces.filter(f => f.kind === 'wall' && f.width > 0 && textures.has(f.index) && f.area >= MIN_ENHANCE_AREA_M2 && f.coverage >= minCoverage)
        .sort((a, b) => a.part.localeCompare(b.part) || a.loop - b.loop || a.edge - b.edge || b.area - a.area);
}

/** Redraws one wall once and gates it. On acceptance the wall's texels become the aligned answer with `source`. */
export async function enhanceWall(f: MassingFace, t: FaceTexture, use: Uint8Array, opts: { client: PlateModelClient; models: string[]; locationName: string; reference?: FaceTexture; source: number; signal?: AbortSignal }): Promise<EnhanceWallRecord & { plate?: Uint8Array }> {
    const t0 = Date.now();
    const scale = Math.min(1, ENHANCE_MAX_SIDE / Math.max(t.width, t.height));
    const sw = Math.max(16, Math.round(t.width * scale)), sh = Math.max(16, Math.round(t.height * scale));
    const small: RgbaImage8 = resizeRgba({ width: t.width, height: t.height, rgba: t.rgba }, sw, sh);
    const { padded, offset } = padToModelAspect(small);
    const ref = opts.reference ? (() => { const rs = Math.min(1, 768 / Math.max(opts.reference.width, opts.reference.height)); const r = resizeRgba({ width: opts.reference.width, height: opts.reference.height, rgba: opts.reference.rgba }, Math.max(8, Math.round(opts.reference.width * rs)), Math.max(8, Math.round(opts.reference.height * rs))); return new Uint8Array(encodePng(r.width, r.height, Buffer.from(r.rgba), 4)); })() : undefined;
    const prompt = buildTexturePlatePrompt({ locationName: opts.locationName, widthM: t.width * f.pixel, heightM: t.height * f.pixel, widthPx: padded.width, heightPx: padded.height, preserveClause: preserveClause(padded.width, padded.height), withReference: !!ref });
    let answer: PlateAnswer;
    try {
        answer = await opts.client({ prompt, image: new Uint8Array(encodePng(padded.width, padded.height, Buffer.from(padded.rgba), 4)), width: padded.width, height: padded.height, ...(ref ? { reference: ref } : {}), models: opts.models, ...(opts.signal ? { signal: opts.signal } : {}) });
    } catch (err) {
        if (opts.signal?.aborted) throw err;
        return { face: f.index, key: f.key, accepted: false, why: `the model did not answer (${(err as Error).message.slice(0, 160)})`, ms: Date.now() - t0 };
    }
    let dec: RgbaImage8;
    try { dec = decodeImageInMemory(answer.bytes); } catch (err) { return { face: f.index, key: f.key, accepted: false, why: `the answer cannot be decoded (${(err as Error).message})`, model: answer.modelUsed, ms: Date.now() - t0 }; }
    const full = resizeRgba(dec, padded.width, padded.height);
    const inner = new Uint8Array(sw * sh * 4);
    for (let y = 0; y < sh; y++) inner.set(full.rgba.subarray(((offset[1] + y) * full.width + offset[0]) * 4, ((offset[1] + y) * full.width + offset[0] + sw) * 4), y * sw * 4);
    const back = resizeRgba({ width: sw, height: sh, rgba: inner }, t.width, t.height).rgba;
    const g = alignPlate(t.rgba, back, t.width, t.height, use, f.pixel);
    const rec = { face: f.index, key: f.key, accepted: g.accepted, why: g.why, model: answer.modelUsed, chamferPx: g.chamferPx, lostShare: g.lostShare, ms: Date.now() - t0, plate: g.aligned };
    if (!g.accepted) return rec;
    for (let i = 0; i < t.width * t.height; i++) {
        t.rgba[i * 4] = g.aligned[i * 4]; t.rgba[i * 4 + 1] = g.aligned[i * 4 + 1]; t.rgba[i * 4 + 2] = g.aligned[i * 4 + 2]; t.rgba[i * 4 + 3] = 255;
        t.source[i] = opts.source;
    }
    return rec;
}

export { TEXTURE_PLATE_PROMPT_ID };
