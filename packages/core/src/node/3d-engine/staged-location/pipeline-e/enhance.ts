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
import { buildTexturePlatePrompt, TEXTURE_PLATE_PROMPT_ID, TEXTURE_PLATE_STREET_VIEW_PROMPT_ID } from '../../../../browser/generative-canvas/services/location-beautify-service';
import { edgeMap, exactDistanceTransform } from '../../../spatial/StreetViewStage3Metrics';
import { decodeImageInMemory, type RgbaImage8 } from '../tile-texture-transfer';
import { padToModelAspect, resizeRgba } from '../texture-enhance';
import { encodePng } from '../png-encode';
import { generateImageWithModels } from '../../../google-media-generation-service';
import { nearestImageAspectRatio } from '../../../../common/media-generation-protocol';
import { lumaPlane } from './image-ops';
import type { FaceTexture } from './massing-glb';
import type { MassingFace } from './native-massing';
import { auditPlate, cellMaskToPixels, describeRegions, revertRegions, MAX_FLAGGED_SHARE, type CellGrid, type FlaggedRegion } from './plate-audit';
import { streetBandTop, verifyAgainstPhoto, type GuideView, type PhotoCheck, type RectifiedPhoto } from './plate-streetview';

export const ENHANCE_MAX_SIDE = 1024;
export const MAX_SHIFT_PX = 6;
export const SEARCH_SIDE = 320;
export const MAX_SCALE = 0.02;
export const MAX_CHAMFER_PX = 2.2;
export const MAX_LOST_SHARE = 0.15;
export const LOST_EDGE_M = 0.3;
export const MIN_ENHANCE_AREA_M2 = 60;
/** Survey views enhanced mode fetches (one wide view per face first, then more per face), each with a street-level view of the same pano. */
export const ENHANCE_STREET_VIEWS = 5;
/** Walls redrawn at once after the first (each references a finished wall). */
export const ENHANCE_CONCURRENCY = 3;

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

export interface PlateRequest { prompt: string; image: Uint8Array; width: number; height: number; reference?: Uint8Array; streetView?: Uint8Array; models: string[]; signal?: AbortSignal }
export interface PlateAnswer { bytes: Uint8Array; modelUsed: string }
export type PlateModelClient = (r: PlateRequest) => Promise<PlateAnswer>;

/** The production client: the Gen AI SDK through generateImageWithModels (the plate first, then the reference, then the Street View photo). */
export function genAiPlateClient(genai: unknown): PlateModelClient {
    return async r => {
        const parts: unknown[] = [{ text: r.prompt }, { inlineData: { mimeType: 'image/png', data: Buffer.from(r.image).toString('base64') } }];
        if (r.reference) parts.push({ text: 'Second image: the adjacent wall, already finished (reference for materials only).' }, { inlineData: { mimeType: 'image/png', data: Buffer.from(r.reference).toString('base64') } });
        if (r.streetView) parts.push({ text: `${r.reference ? 'Third' : 'Second'} image: a street-level photograph of this wall (Google Street View), resampled onto the first image's frame; grey where it does not show the wall.` }, { inlineData: { mimeType: 'image/png', data: Buffer.from(r.streetView).toString('base64') } });
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

/** The Street View photo a wall's redraw is guided by and checked against (plate-streetview.ts). */
export interface WallStreetView { view: GuideView; rect: RectifiedPhoto; crop: Uint8Array; why: string }

export interface EnhanceAuditRecord {
    regions: FlaggedRegion[];
    flaggedAreaM2: number;
    coveredAreaM2: number;
    flaggedShare: number;
    /** Texels taken back from the input (input weight at least 0.5), square metres. */
    revertedAreaM2: number;
    /** Cells the tile check flagged that the Street View photo shows as the plate draws them (kept), square metres. */
    photoKeptM2: number;
}

export interface EnhanceStreetViewRecord {
    panoId: string;
    method: string;
    bandCover: number;
    pxPerM: number;
    shiftPx?: [number, number];
    nccPlate?: number;
    nccInput?: number;
    comparedCells?: number;
    supportedCells?: number;
    contradictedCells?: number;
    /** The photo-guided redraw failed the alignment gate (why); the wall was redrawn without the photo. */
    guidedRejected?: string;
}

export interface EnhanceWallRecord {
    face: number; key: string; accepted: boolean; why: string; model?: string; chamferPx?: number; lostShare?: number; referenceFace?: number; ms: number;
    /** The invention and erasure check (absent when the alignment gate already rejected the wall, or the guards are off). */
    audit?: EnhanceAuditRecord;
    /** The Street View photo that guided and checked the redraw, or why there was none. */
    streetView?: EnhanceStreetViewRecord;
    noStreetView?: string;
}

/**
 * SCRATCHBOX_STAGED_ENHANCE_GUARDS=0 turns off the invention and erasure check and the Street View guidance (enhanced mode
 * as it was before them: the alignment gate only). On by default.
 */
export function enhanceGuards(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.SCRATCHBOX_STAGED_ENHANCE_GUARDS !== '0';
}

/** The walls worth enhancing, in plan-loop order (so each has its finished neighbour as the reference). */
export function enhanceOrder(faces: MassingFace[], textures: Map<number, FaceTexture>, minCoverage: number): MassingFace[] {
    return faces.filter(f => f.kind === 'wall' && f.width > 0 && textures.has(f.index) && f.area >= MIN_ENHANCE_AREA_M2 && f.coverage >= minCoverage)
        .sort((a, b) => a.part.localeCompare(b.part) || a.loop - b.loop || a.edge - b.edge || b.area - a.area);
}

/**
 * The tile check and the photo check of an aligned plate, merged: cells the photo shows as the plate draws them are kept even
 * when the tile flagged them (the photo is the better evidence at street level); cells that contradict the photo are flagged.
 */
export function guardPlate(input: Uint8Array, aligned: Uint8Array, W: number, H: number, use: Uint8Array, pixelM: number, photo?: { rect: RectifiedPhoto; bandTop: number }): {
    audit: EnhanceAuditRecord; reject: boolean; why: string; rgba: Uint8Array; weight: Float32Array; labels: string[]; grid: CellGrid; photo?: PhotoCheck
} {
    const a = auditPlate(input, aligned, W, H, use, pixelM);
    const labels = a.labels.slice();
    let photoKept = 0;
    const check = photo ? verifyAgainstPhoto(input, aligned, photo.rect, W, H, use, pixelM, photo.bandTop) : undefined;
    if (check) {
        for (let k = 0; k < labels.length; k++) {
            if (check.verdict[k] === 'supported' && labels[k]) { labels[k] = ''; photoKept += a.grid.cover[k]; }
            else if (check.verdict[k] === 'contradicts-photo') labels[k] = 'contradicts-photo';
        }
    }
    const { regions, flagged } = describeRegions(labels, a.grid, pixelM, W, H, { toneDe: a.features.toneDe, ncc: a.features.nccIn });
    const flaggedAreaM2 = Math.round(regions.reduce((s, r) => s + r.areaM2, 0) * 10) / 10;
    const share = a.coveredAreaM2 > 0 ? flaggedAreaM2 / a.coveredAreaM2 : 0;
    const reject = share > MAX_FLAGGED_SHARE;
    const { rgba, weight } = revertRegions(input, aligned, W, H, cellMaskToPixels(flagged, a.grid, W, H), pixelM);
    let reverted = 0;
    for (let i = 0; i < W * H; i++) if (use[i] && weight[i] >= 0.5) reverted++;
    const byKind = new Map<string, number>();
    for (const r of regions) byKind.set(r.kind, (byKind.get(r.kind) ?? 0) + r.areaM2);
    const cellM2 = (a.grid.cellPx * pixelM) ** 2;
    const audit: EnhanceAuditRecord = {
        regions, flaggedAreaM2, coveredAreaM2: a.coveredAreaM2, flaggedShare: Math.round(share * 1000) / 1000,
        revertedAreaM2: Math.round(reverted * pixelM * pixelM * 10) / 10, photoKeptM2: Math.round(photoKept * cellM2 * 10) / 10
    };
    const kinds = [...byKind.entries()].map(([k, v]) => `${k} ${v.toFixed(1)} m2`).join(', ');
    const why = regions.length
        ? `${regions.length} region${regions.length === 1 ? '' : 's'} not supported (${kinds}), ${(100 * share).toFixed(0)}% of ${a.coveredAreaM2.toFixed(0)} m2${reject ? `: more than ${100 * MAX_FLAGGED_SHARE}%, the wall keeps its tile texture` : `: ${audit.revertedAreaM2.toFixed(1)} m2 reverted to the tile texture`}`
        : 'no region adds or removes structure the tile does not support';
    return { audit, reject, why: `${why}${photoKept ? `; ${audit.photoKeptM2} m2 the tile check flagged kept because the Street View photo shows it` : ''}`, rgba, weight, labels, grid: a.grid, ...(check ? { photo: check } : {}) };
}

/**
 * Redraws one wall once and gates it: the alignment gate, then (guards on) the invention and erasure check and, with a
 * Street View photo of the wall, the photo check; flagged regions revert to the input, feathered. On acceptance the wall's
 * texels become the guarded plate with `source` (or `streetViewSource` when a photo guided it); reverted texels keep theirs.
 */
export async function enhanceWall(f: MassingFace, t: FaceTexture, use: Uint8Array, opts: {
    client: PlateModelClient; models: string[]; locationName: string; reference?: FaceTexture; source: number; signal?: AbortSignal;
    guards?: boolean; streetView?: WallStreetView; streetViewSource?: number; noStreetView?: string;
    /** When the photo-guided redraw fails the alignment gate, redraw once without the photo (default true). */
    retryWithoutPhoto?: boolean;
}): Promise<EnhanceWallRecord & { plate?: Uint8Array; guarded?: Uint8Array; labels?: string[]; grid?: CellGrid }> {
    const t0 = Date.now();
    const guards = opts.guards ?? true;
    const sv = guards ? opts.streetView : undefined;
    const scale = Math.min(1, ENHANCE_MAX_SIDE / Math.max(t.width, t.height));
    const sw = Math.max(16, Math.round(t.width * scale)), sh = Math.max(16, Math.round(t.height * scale));
    const small: RgbaImage8 = resizeRgba({ width: t.width, height: t.height, rgba: t.rgba }, sw, sh);
    const { padded, offset } = padToModelAspect(small);
    const ref = opts.reference ? (() => { const rs = Math.min(1, 768 / Math.max(opts.reference.width, opts.reference.height)); const r = resizeRgba({ width: opts.reference.width, height: opts.reference.height, rgba: opts.reference.rgba }, Math.max(8, Math.round(opts.reference.width * rs)), Math.max(8, Math.round(opts.reference.height * rs))); return new Uint8Array(encodePng(r.width, r.height, Buffer.from(r.rgba), 4)); })() : undefined;
    const prompt = buildTexturePlatePrompt({ locationName: opts.locationName, widthM: t.width * f.pixel, heightM: t.height * f.pixel, widthPx: padded.width, heightPx: padded.height, preserveClause: preserveClause(padded.width, padded.height), withReference: !!ref, ...(sv ? { withStreetView: true } : {}) });
    const svRec: EnhanceStreetViewRecord | undefined = sv ? { panoId: sv.view.panoId, method: sv.view.registration?.method ?? 'nominal', bandCover: Math.round(sv.rect.bandCover * 1000) / 1000, pxPerM: Math.round(sv.rect.pxPerM * 10) / 10 } : undefined;
    const base = { face: f.index, key: f.key, ...(svRec ? { streetView: svRec } : {}), ...(guards && !sv && opts.noStreetView ? { noStreetView: opts.noStreetView } : {}) };
    let answer: PlateAnswer;
    try {
        answer = await opts.client({ prompt, image: new Uint8Array(encodePng(padded.width, padded.height, Buffer.from(padded.rgba), 4)), width: padded.width, height: padded.height, ...(ref ? { reference: ref } : {}), ...(sv ? { streetView: sv.crop } : {}), models: opts.models, ...(opts.signal ? { signal: opts.signal } : {}) });
    } catch (err) {
        if (opts.signal?.aborted) throw err;
        return { ...base, accepted: false, why: `the model did not answer (${(err as Error).message.slice(0, 160)})`, ms: Date.now() - t0 };
    }
    let dec: RgbaImage8;
    try { dec = decodeImageInMemory(answer.bytes); } catch (err) { return { ...base, accepted: false, why: `the answer cannot be decoded (${(err as Error).message})`, model: answer.modelUsed, ms: Date.now() - t0 }; }
    const full = resizeRgba(dec, padded.width, padded.height);
    const inner = new Uint8Array(sw * sh * 4);
    for (let y = 0; y < sh; y++) inner.set(full.rgba.subarray(((offset[1] + y) * full.width + offset[0]) * 4, ((offset[1] + y) * full.width + offset[0] + sw) * 4), y * sw * 4);
    const back = resizeRgba({ width: sw, height: sh, rgba: inner }, t.width, t.height).rgba;
    const g = alignPlate(t.rgba, back, t.width, t.height, use, f.pixel);
    const rec = { ...base, accepted: g.accepted, why: g.why, model: answer.modelUsed, chamferPx: g.chamferPx, lostShare: g.lostShare, ms: Date.now() - t0, plate: g.aligned };
    if (!g.accepted && sv && opts.retryWithoutPhoto !== false) {
        // the photo pulled the redraw off the wall's geometry: one more redraw without it (the tile check still applies)
        const again = await enhanceWall(f, t, use, { ...opts, streetView: undefined, noStreetView: `the redraw guided by Street View ${sv.view.panoId} failed the alignment gate (${g.why}); redrawn without the photo` });
        return { ...again, ms: Date.now() - t0, streetView: { ...svRec!, guidedRejected: g.why } };
    }
    if (!g.accepted) return rec;
    let out = g.aligned, weight: Float32Array | undefined;
    let extra: { audit?: EnhanceAuditRecord; guarded?: Uint8Array; labels?: string[]; grid?: CellGrid } = {};
    if (guards) {
        const gp = guardPlate(t.rgba, g.aligned, t.width, t.height, use, f.pixel, sv ? { rect: sv.rect, bandTop: streetBandTop(f) } : undefined);
        if (svRec && gp.photo) Object.assign(svRec, { shiftPx: gp.photo.shiftPx, nccPlate: gp.photo.nccPlate, nccInput: gp.photo.nccInput, comparedCells: gp.photo.comparedCells, supportedCells: gp.photo.supportedCells, contradictedCells: gp.photo.contradictedCells });
        extra = { audit: gp.audit, guarded: gp.rgba, labels: gp.labels, grid: gp.grid };
        if (gp.reject) return { ...rec, ...extra, accepted: false, why: `${g.why}; ${gp.why}`, ms: Date.now() - t0 };
        out = gp.rgba; weight = gp.weight;
        rec.why = `${g.why}; ${gp.why}`;
    }
    const src = sv && opts.streetViewSource !== undefined ? opts.streetViewSource : opts.source;
    for (let i = 0; i < t.width * t.height; i++) {
        t.rgba[i * 4] = out[i * 4]; t.rgba[i * 4 + 1] = out[i * 4 + 1]; t.rgba[i * 4 + 2] = out[i * 4 + 2]; t.rgba[i * 4 + 3] = 255;
        if (!weight || weight[i] < 0.5) t.source[i] = src;
    }
    return { ...rec, ...extra, ms: Date.now() - t0 };
}

export { TEXTURE_PLATE_PROMPT_ID, TEXTURE_PLATE_STREET_VIEW_PROMPT_ID };
