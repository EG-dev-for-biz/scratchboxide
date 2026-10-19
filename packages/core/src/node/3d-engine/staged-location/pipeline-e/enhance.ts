/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline E, enhanced mode (the default within pipeline E since round 4, the realism-first directive; the real-data view is
 * `enhance: false` or SCRATCHBOX_STAGED_ENHANCE=0). Every texel it writes is labelled `generated`, "AI-enhanced from tile
 * (model, prompt id)", with the wall's alignment numbers.
 *
 * Each large wall's straight-on texture (E's, after inference) is redrawn exactly once by an image model with the AI
 * Beautify prompt's texture-plate variant (buildTexturePlatePrompt), the adjacent wall already finished sent as a reference
 * so materials match across corners. The answer is resized to the input, then:
 *
 *   - a small corrective warp (a shift of up to MAX_SHIFT_PX and a scale within MAX_SCALE) is searched to best align its
 *     edges with the input's; the symmetric edge chamfer and the share of the input's edges with no edge of the answer
 *     within LOST_EDGE_M are measured and reported, not gated (round 5: the user chose redraws at 3.5-4.4 px);
 *   - the identity gate (plate-identity.ts): same framing and aspect, storey and bay rhythm, wall colour family, and a loose
 *     gross-failure bound on chamfer and lost share; a wall that fails it keeps its tile texture;
 *   - the region-level identity audit (plate-audit.ts) and, with a Street View photo of the wall, the photo check.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { LIGHTING_MODEL_LITE, LIGHTING_PROMPTS } from '../texture-lighting';
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
import { auditPlate, cellMaskToPixels, describeRegions, revertRegions, KEPT_KINDS, MAX_FLAGGED_SHARE, type CellGrid, type FlaggedRegion } from './plate-audit';
import { streetBandTop, verifyAgainstPhoto, type GuideView, type PhotoCheck, type RectifiedPhoto } from './plate-streetview';
import { identityGate, GROSS_MAX_CHAMFER_PX, GROSS_MAX_LOST_SHARE, type FacadeCounter, type FacadeCounts, type IdentityGate } from './plate-identity';

export const ENHANCE_MAX_SIDE = 1024;
export const MAX_SHIFT_PX = 6;
export const SEARCH_SIDE = 320;
export const MAX_SCALE = 0.02;
export const LOST_EDGE_M = 0.3;
export const MIN_ENHANCE_AREA_M2 = 60;
/** Survey views enhanced mode fetches (one wide view per face first, then more per face), each with a street-level view of the same pano. */
export const ENHANCE_STREET_VIEWS = 5;
/** Walls redrawn at once after the first (each references a finished wall). */
export const ENHANCE_CONCURRENCY = 3;

/**
 * The image model redrawing the plates: Nano Banana Lite, the user's choice after the round-4 comparison sheets (its redraws
 * of Puck wall 17 and Jefferson wall 157, which the old 2.2 px alignment gate rejected, judged the most realistic; the full
 * model kept the tile's edges more closely, 1.05-1.95 px, but looked less real). SCRATCHBOX_STAGED_ENHANCE_MODELS overrides
 * (comma-separated).
 */
export const ENHANCE_MODEL_DEFAULT = LIGHTING_MODEL_LITE;
export function enhanceModels(env: NodeJS.ProcessEnv = process.env): string[] {
    const m = (env.SCRATCHBOX_STAGED_ENHANCE_MODELS ?? '').split(',').map(x => x.trim()).filter(Boolean);
    return m.length ? m : [ENHANCE_MODEL_DEFAULT];
}

/**
 * Within pipeline E enhanced appearance is the default (the realism-first directive); SCRATCHBOX_STAGED_ENHANCE=0 makes the
 * real-data view the server's default instead. A request's own `enhance` overrides it either way.
 */
export function stagedEnhance(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.SCRATCHBOX_STAGED_ENHANCE !== '0';
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

/** The key of a plate request: everything the model is sent. */
export function plateCacheKey(r: PlateRequest): string {
    const h = crypto.createHash('sha256').update(JSON.stringify({ v: 1, models: r.models, prompt: r.prompt, width: r.width, height: r.height }));
    for (const b of [r.image, r.reference, r.streetView]) { h.update(b ? `|${b.length}|` : '|-|'); if (b) h.update(b); }
    return h.digest('hex').slice(0, 40);
}

/** The model's answer to `r`, from `dir` when it was answered before (then stored there). */
export async function cachedPlate(dir: string | undefined, r: PlateRequest, client: PlateModelClient): Promise<PlateAnswer & { cached?: boolean }> {
    const key = dir ? plateCacheKey(r) : '';
    if (dir) {
        try {
            const meta = JSON.parse(fs.readFileSync(path.join(dir, `${key}.json`), 'utf8')) as { modelUsed: string };
            return { bytes: new Uint8Array(fs.readFileSync(path.join(dir, `${key}.img`))), modelUsed: meta.modelUsed, cached: true };
        } catch { /* not cached */ }
    }
    const a = await client(r);
    if (dir) {
        try {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, `${key}.img`), a.bytes);
            fs.writeFileSync(path.join(dir, `${key}.json`), JSON.stringify({ modelUsed: a.modelUsed, models: r.models, at: new Date().toISOString() }));
        } catch { /* the cache is an optimisation */ }
    }
    return a;
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
 * The alignment: the corrective warp (shift and scale) that brings the answer's edges nearest the input's, then the
 * symmetric chamfer and the share of the input's edges the answer lost (`use` marks the texels the tile covers). Both are
 * reported; `accepted` is only the loose gross-failure bound (plate-identity.ts), the identity gate decides the rest.
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
    const accepted = chamfer <= GROSS_MAX_CHAMFER_PX && lostShare <= GROSS_MAX_LOST_SHARE;
    const why = `corrective warp ${dx}, ${dy} px, scale ${best.s.toFixed(3)}; edge chamfer ${chamfer.toFixed(2)} px (${(chamfer * pixelM).toFixed(2)} m), ${(100 * lostShare).toFixed(0)}% of the tile's edges with no edge within ${LOST_EDGE_M} m (reported${accepted ? '' : `; beyond the gross-failure bound of ${GROSS_MAX_CHAMFER_PX} px or ${100 * GROSS_MAX_LOST_SHARE}%`})`;
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
    /** Finer detail the plate adds over ordinary wall (kept: the point of the redraw), square metres. */
    inventedDetailM2: number;
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
    /** The photo-guided redraw failed the identity gate (why); the wall was redrawn without the photo, which then only checked it. */
    guidedRejected?: string;
    /** The photo was not sent to the model; it only checked the plate. */
    checkOnly?: boolean;
}

/** The identity gate's numbers for the record (plate-identity.ts). */
export interface EnhanceIdentityRecord {
    passed: boolean;
    aspectDrift: number;
    storeys: { tile?: number; plate?: number; measured: boolean; passed: boolean };
    bays: { tile?: number; plate?: number; measured: boolean; passed: boolean };
    colourDe: number;
    colourPassed: boolean;
    grossPassed: boolean;
}

export function identityRecord(g: IdentityGate): EnhanceIdentityRecord {
    const r = (c: IdentityGate['storeys']) => ({ ...(c.tile !== undefined ? { tile: c.tile } : {}), ...(c.plate !== undefined ? { plate: c.plate } : {}), measured: c.measured, passed: c.passed });
    return { passed: g.passed, aspectDrift: g.aspect.drift, storeys: r(g.storeys), bays: r(g.bays), colourDe: g.colour.de, colourPassed: g.colour.passed, grossPassed: g.gross.passed };
}

export interface EnhanceWallRecord {
    face: number; key: string; accepted: boolean; why: string; model?: string;
    /** Alignment after the corrective warp: reported, not gated (beyond the gross-failure bound). */
    chamferPx?: number; lostShare?: number; referenceFace?: number; ms: number;
    /** The identity gate (absent when the model did not answer). */
    identity?: EnhanceIdentityRecord;
    /** The invention and erasure check (absent when the identity gate already rejected the wall, or the guards are off). */
    audit?: EnhanceAuditRecord;
    /** The Street View photo that guided and checked the redraw, or why there was none. */
    streetView?: EnhanceStreetViewRecord;
    noStreetView?: string;
}

/**
 * SCRATCHBOX_STAGED_ENHANCE_GUARDS=0 turns off the invention and erasure check and the Street View guidance (the identity
 * gate only). On by default.
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
    const { regions, flagged } = describeRegions(labels.map(l => (KEPT_KINDS.has(l) ? '' : l)), a.grid, pixelM, W, H, { toneDe: a.features.toneDe, ncc: a.features.nccIn });
    const inventedDetailM2 = Math.round(labels.reduce((t, l, k) => t + (KEPT_KINDS.has(l) ? a.grid.cover[k] : 0), 0) * (a.grid.cellPx * pixelM) ** 2 * 10) / 10;
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
        revertedAreaM2: Math.round(reverted * pixelM * pixelM * 10) / 10, photoKeptM2: Math.round(photoKept * cellM2 * 10) / 10, inventedDetailM2
    };
    const kinds = [...byKind.entries()].map(([k, v]) => `${k} ${v.toFixed(1)} m2`).join(', ');
    const why = regions.length
        ? `${regions.length} region${regions.length === 1 ? '' : 's'} that erase, replace or recolour a distinct element (${kinds}), ${(100 * share).toFixed(0)}% of ${a.coveredAreaM2.toFixed(0)} m2${reject ? `: more than ${100 * MAX_FLAGGED_SHARE}%, the wall keeps its tile texture` : `: ${audit.revertedAreaM2.toFixed(1)} m2 reverted to the tile texture`}`
        : 'no region erases, replaces or recolours a distinct element of the tile';
    return { audit, reject, why: `${why}${inventedDetailM2 ? `; ${inventedDetailM2} m2 of finer detail drawn over ordinary wall kept` : ''}${photoKept ? `; ${audit.photoKeptM2} m2 the tile check flagged kept because the Street View photo shows it` : ''}`, rgba, weight, labels, grid: a.grid, ...(check ? { photo: check } : {}) };
}

/**
 * Redraws one wall once and gates it: the identity gate, then (guards on) the invention and erasure check and, with a
 * Street View photo of the wall, the photo check; flagged regions revert to the input, feathered. On acceptance the wall's
 * texels become the guarded plate with `source` (or `streetViewSource` when a photo guided it); reverted texels keep theirs.
 */
export async function enhanceWall(f: MassingFace, t: FaceTexture, use: Uint8Array, opts: {
    client: PlateModelClient; models: string[]; locationName: string; reference?: FaceTexture; source: number; signal?: AbortSignal;
    guards?: boolean; streetView?: WallStreetView; streetViewSource?: number; noStreetView?: string;
    /** When the photo-guided redraw fails the identity gate, redraw once without the photo (default true). */
    retryWithoutPhoto?: boolean;
    /** Do not send the photo; only check the plate against it (the redraw after a photo-guided one failed the gate). */
    photoCheckOnly?: boolean;
    /** Reads storey and bay counts of the tile and of the plate (plate-identity.ts); without it the counts are not checked. */
    counter?: FacadeCounter;
    /** The tile's counts when already read (the redraw without the photo reuses them). */
    tileCounts?: Promise<FacadeCounts>;
    /**
     * Where answers are kept, keyed by everything the model is sent (models, prompt, images): the same wall with the same
     * inputs gets the same plate on every rebuild.
     */
    cacheDir?: string;
}): Promise<EnhanceWallRecord & { plate?: Uint8Array; guarded?: Uint8Array; labels?: string[]; grid?: CellGrid }> {
    const t0 = Date.now();
    const guards = opts.guards ?? true;
    const sv = guards ? opts.streetView : undefined;
    // the photo is sent to the model unless this is the redraw without it (it then only checks the plate)
    const guide = !!sv && !opts.photoCheckOnly;
    const scale = Math.min(1, ENHANCE_MAX_SIDE / Math.max(t.width, t.height));
    const sw = Math.max(16, Math.round(t.width * scale)), sh = Math.max(16, Math.round(t.height * scale));
    const small: RgbaImage8 = resizeRgba({ width: t.width, height: t.height, rgba: t.rgba }, sw, sh);
    const { padded, offset } = padToModelAspect(small);
    const ref = opts.reference ? (() => { const rs = Math.min(1, 768 / Math.max(opts.reference.width, opts.reference.height)); const r = resizeRgba({ width: opts.reference.width, height: opts.reference.height, rgba: opts.reference.rgba }, Math.max(8, Math.round(opts.reference.width * rs)), Math.max(8, Math.round(opts.reference.height * rs))); return new Uint8Array(encodePng(r.width, r.height, Buffer.from(r.rgba), 4)); })() : undefined;
    const prompt = buildTexturePlatePrompt({ locationName: opts.locationName, widthM: t.width * f.pixel, heightM: t.height * f.pixel, widthPx: padded.width, heightPx: padded.height, preserveClause: preserveClause(padded.width, padded.height), withReference: !!ref, ...(guide ? { withStreetView: true } : {}) });
    const svRec: EnhanceStreetViewRecord | undefined = sv ? { ...(guide ? {} : { checkOnly: true }), panoId: sv.view.panoId, method: sv.view.registration?.method ?? 'nominal', bandCover: Math.round(sv.rect.bandCover * 1000) / 1000, pxPerM: Math.round(sv.rect.pxPerM * 10) / 10 } : undefined;
    const base = { face: f.index, key: f.key, ...(svRec ? { streetView: svRec } : {}), ...(guards && !sv && opts.noStreetView ? { noStreetView: opts.noStreetView } : {}) };
    let answer: PlateAnswer;
    const image = new Uint8Array(encodePng(padded.width, padded.height, Buffer.from(padded.rgba), 4));
    const widthM = t.width * f.pixel, heightM = t.height * f.pixel;
    // the tile's storeys and bays, read while the model redraws (the same prompt reads the plate's after)
    const tileCounts = opts.tileCounts ?? (opts.counter ? opts.counter(new Uint8Array(encodePng(sw, sh, Buffer.from(small.rgba), 4)), widthM, heightM) : undefined);
    tileCounts?.catch(() => undefined);
    const request: PlateRequest = { prompt, image, width: padded.width, height: padded.height, ...(ref ? { reference: ref } : {}), ...(guide ? { streetView: sv!.crop } : {}), models: opts.models, ...(opts.signal ? { signal: opts.signal } : {}) };
    try {
        answer = await cachedPlate(opts.cacheDir, request, opts.client);
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
    let counts: { tile?: FacadeCounts; plate?: FacadeCounts; unread?: string } | undefined;
    if (opts.counter && tileCounts) {
        const plateSmall = resizeRgba({ width: t.width, height: t.height, rgba: g.aligned }, sw, sh);
        const [tc, pc] = await Promise.allSettled([tileCounts, opts.counter(new Uint8Array(encodePng(sw, sh, Buffer.from(plateSmall.rgba), 4)), widthM, heightM)]);
        counts = { ...(tc.status === 'fulfilled' ? { tile: tc.value } : {}), ...(pc.status === 'fulfilled' ? { plate: pc.value } : {}) };
        const bad = [tc, pc].filter(x => x.status === 'rejected') as PromiseRejectedResult[];
        if (bad.length) counts.unread = `the count could not be read: ${String((bad[0].reason as Error)?.message ?? bad[0].reason).slice(0, 120)}`;
    } else counts = { unread: 'no vision model to count with' };
    const idg = identityGate(t.rgba, g.aligned, t.width, t.height, use, { askedAspect: padded.width / padded.height, answeredAspect: dec.width / dec.height, chamferPx: g.chamferPx, lostShare: g.lostShare, counts });
    const why0 = `corrective warp ${g.dx}, ${g.dy} px, scale ${g.scale.toFixed(3)}; ${idg.why}`;
    const rec = { ...base, accepted: idg.passed, why: idg.passed ? why0 : `not the same wall: ${why0}`, model: answer.modelUsed, chamferPx: g.chamferPx, lostShare: g.lostShare, identity: identityRecord(idg), ms: Date.now() - t0, plate: g.aligned };
    if (!idg.passed && guide && opts.retryWithoutPhoto !== false) {
        // the photo pulled the redraw away from the wall: one more redraw without it; the tile check and the check against the
        // photo still apply
        const again = await enhanceWall(f, t, use, { ...opts, photoCheckOnly: true, ...(tileCounts ? { tileCounts } : {}) });
        return { ...again, ms: Date.now() - t0, streetView: { ...(again.streetView ?? svRec!), guidedRejected: rec.why } };
    }
    if (!idg.passed) return rec;
    let out = g.aligned, weight: Float32Array | undefined;
    let extra: { audit?: EnhanceAuditRecord; guarded?: Uint8Array; labels?: string[]; grid?: CellGrid } = {};
    if (guards) {
        const gp = guardPlate(t.rgba, g.aligned, t.width, t.height, use, f.pixel, sv ? { rect: sv.rect, bandTop: streetBandTop(f) } : undefined);
        if (svRec && gp.photo) Object.assign(svRec, { shiftPx: gp.photo.shiftPx, nccPlate: gp.photo.nccPlate, nccInput: gp.photo.nccInput, comparedCells: gp.photo.comparedCells, supportedCells: gp.photo.supportedCells, contradictedCells: gp.photo.contradictedCells });
        extra = { audit: gp.audit, guarded: gp.rgba, labels: gp.labels, grid: gp.grid };
        if (gp.reject) return { ...rec, ...extra, accepted: false, why: `${rec.why}; ${gp.why}`, ms: Date.now() - t0 };
        out = gp.rgba; weight = gp.weight;
        rec.why = `${rec.why}; ${gp.why}`;
    }
    const src = guide && opts.streetViewSource !== undefined ? opts.streetViewSource : opts.source;
    for (let i = 0; i < t.width * t.height; i++) {
        t.rgba[i * 4] = out[i * 4]; t.rgba[i * 4 + 1] = out[i * 4 + 1]; t.rgba[i * 4 + 2] = out[i * 4 + 2]; t.rgba[i * 4 + 3] = 255;
        if (!weight || weight[i] < 0.5) t.source[i] = src;
    }
    return { ...rec, ...extra, ms: Date.now() - t0 };
}

export { TEXTURE_PLATE_PROMPT_ID, TEXTURE_PLATE_STREET_VIEW_PROMPT_ID };
