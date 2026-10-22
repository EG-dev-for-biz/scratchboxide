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
import { TEXTURE_PLATE_PROMPT_ID, TEXTURE_PLATE_STREET_VIEW_PROMPT_ID, TEXTURE_PLATE_UNSEEN_PROMPT_ID } from '../../../../browser/generative-canvas/services/location-beautify-service';
import { edgeMap, exactDistanceTransform } from '../../../spatial/StreetViewStage3Metrics';
import { resizeRgba } from '../texture-enhance';
import { generateImageWithModels } from '../../../google-media-generation-service';
import { nearestImageAspectRatio } from '../../../../common/media-generation-protocol';
import { lumaPlane } from './image-ops';
import type { FaceTexture } from './massing-glb';
import type { MassingFace } from './native-massing';
import { auditPlate, cellMaskToPixels, describeRegions, revertRegions, KEPT_KINDS, MAX_FLAGGED_SHARE, type CellGrid, type FlaggedRegion } from './plate-audit';
import { verifyAgainstPhoto, type GuideView, type PhotoCheck, type RectifiedPhoto } from './plate-streetview';
import { GROSS_MAX_CHAMFER_PX, GROSS_MAX_LOST_SHARE, type IdentityGate } from './plate-identity';

export const ENHANCE_MAX_SIDE = 1024;
export const MAX_SHIFT_PX = 6;
export const SEARCH_SIDE = 320;
export const MAX_SCALE = 0.02;
export const LOST_EDGE_M = 0.3;
export const MIN_ENHANCE_AREA_M2 = 60;
/** Survey views enhanced mode fetches (one wide view per face first, then more per face), each with a street-level view of the same pano. */
export const ENHANCE_STREET_VIEWS = 5;
/**
 * Walls the tile hardly sees (coverage under LOW_COVERAGE: behind trees, against a neighbour) are drawn in enhanced mode
 * too (the realism-first directive: generated detail is the default where no source covers a surface), at most this many,
 * after the walls the tile sees, each with a finished wall as its reference.
 */
export const MAX_UNSEEN_WALLS = 4;
/** An unseen wall is drawn only when at least this share of it faces open air (not another part of the solid). */
export const MIN_UNSEEN_EXPOSED_SHARE = 0.5;
/** Below this share of a wall's texels covered by the tile, the plate is not aligned to it (too little to align on). */
export const UNSEEN_MIN_ALIGN_SHARE = 0.1;
/**
 * Below this share covered, the storeys and bays are not counted on the tile. Matches LOW_COVERAGE (pipeline-e.ts): a wall
 * is only in the unseen branch at all because the tile's view of it is too fragmentary to trust, so nothing in that same
 * view should then be held against its plate either. Below 0.35 the two coincided only on the coverage band 0.25-0.35, a
 * real build (Haughwout, scene-stg-d9660711) found three walls there: the tile's partial view undercounted every one of
 * them (e.g. 1 or 2 storeys read where the plate and the building both have 5), rejecting plates whose aspect, colour and
 * gross alignment were all otherwise fine.
 */
export const UNSEEN_MIN_COUNT_SHARE = 0.35;
/** Below this share covered, the plate's colour family is checked against the building's median facade colour. */
export const UNSEEN_MIN_COLOUR_SHARE = 0.05;
/** An unseen wall's plate that leaves more than this share of the unseen texels flat mid-grey is refused. */
export const UNSEEN_MAX_GREY_SHARE = 0.1;
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
    /** Hue and chroma distance (lightness weighted down) of the median colours, and the medians (CIELAB). */
    familyDe: number;
    tileLab: [number, number, number];
    plateLab: [number, number, number];
    colourPassed: boolean;
    grossPassed: boolean;
}

export function identityRecord(g: IdentityGate): EnhanceIdentityRecord {
    const r = (c: IdentityGate['storeys']) => ({ ...(c.tile !== undefined ? { tile: c.tile } : {}), ...(c.plate !== undefined ? { plate: c.plate } : {}), measured: c.measured, passed: c.passed });
    return { passed: g.passed, aspectDrift: g.aspect.drift, storeys: r(g.storeys), bays: r(g.bays), colourDe: g.colour.de, familyDe: g.colour.familyDe, tileLab: g.colour.tileLab, plateLab: g.colour.plateLab, colourPassed: g.colour.passed, grossPassed: g.gross.passed };
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

/**
 * The share of the texels the tile does not cover (inside the wall's polygon when `inside` is given: the frame's corners
 * outside a gable or a stepped wall are not the wall) that a plate left flat mid-grey (each channel within 4 of 128).
 */
export function unseenGreyShare(plate: Uint8Array, use: Uint8Array, N: number, inside?: Uint8Array): number {
    let n = 0, grey = 0;
    for (let i = 0; i < N; i++) {
        if (use[i] || (inside && !inside[i])) continue;
        n++;
        if (Math.abs(plate[i * 4] - 128) <= 4 && Math.abs(plate[i * 4 + 1] - 128) <= 4 && Math.abs(plate[i * 4 + 2] - 128) <= 4) grey++;
    }
    return n ? grey / n : 0;
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

// redrawing a wall and gating it: facade-texture/facade-texture.ts (buildFacadeTexture), the one facade texture builder

export { TEXTURE_PLATE_PROMPT_ID, TEXTURE_PLATE_STREET_VIEW_PROMPT_ID, TEXTURE_PLATE_UNSEEN_PROMPT_ID };
