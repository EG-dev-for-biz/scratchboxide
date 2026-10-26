/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The facade texture builder: the one way a wall's texture is redrawn, whatever pipeline built the wall. A wall's
 * straight-on plate (its texels in the face's metric (s, t) frame, `use` marking the ones a real source covers) goes to the
 * image model with the AI Beautify prompt's texture-plate variant, and the answer is kept only through the gates of
 * pipeline E's enhanced mode (enhance.ts: the corrective warp, the identity gate, the region audit, the Street View check).
 *
 * The steps are separate so a caller can draw once (buildFacadeTexture, pipeline E and version F round 2) or many times and
 * pick (version F round 3's best-of-n): prepareFacadeRequest, plateFromAnswer, alignAndIdentify, writeFacadeTexture.
 */

import { buildTexturePlatePrompt, TEXTURE_PLATE_UNSEEN_PROMPT_ID } from '../../../../browser/generative-canvas/services/location-beautify-service';
import { decodeImageInMemory, type RgbaImage8 } from '../tile-texture-transfer';
import { padToModelAspect, resizeRgba } from '../texture-enhance';
import { encodePng } from '../png-encode';
import type { FaceTexture } from '../pipeline-e/massing-glb';
import type { MassingFace } from '../pipeline-e/native-massing';
import {
    alignPlate, cachedPlate, guardPlate, identityRecord, preserveClause, unseenGreyShare, ENHANCE_MAX_SIDE, UNSEEN_MAX_GREY_SHARE, UNSEEN_MIN_ALIGN_SHARE,
    UNSEEN_MIN_COLOUR_SHARE, UNSEEN_MIN_COUNT_SHARE, type AlignResult, type EnhanceAuditRecord, type EnhanceStreetViewRecord, type EnhanceWallRecord,
    type PlateAnswer, type PlateModelClient, type PlateRequest, type WallStreetView
} from '../pipeline-e/enhance';
import { identityGate, type FacadeCounter, type FacadeCounts, type IdentityGate } from '../pipeline-e/plate-identity';
import { streetBandTop } from '../pipeline-e/plate-streetview';
import type { CellGrid } from '../pipeline-e/plate-audit';
import { infillImageHoles } from '../../../image-hole-infill';
import { facadeQuality, openingsKept } from './quality';
import type { EnhanceModelClient } from '../texture-enhance';

/** A wall with more than this share of its texels to draw as it continues is redrawn by `unseenModels` when given. */
export const UNSEEN_MODEL_SHARE = 0.02;

/** The band, texels, over which a fill is blended into the seen texels around it (no hard outline left to draw). */
export const UNSEEN_FEATHER_PX = 3;

/**
 * A wall the tile hardly sees: what the tile does not cover is drawn as the wall continues (labelled `source`). With `fill`
 * (W x H RGBA, e.g. the facade reading painted: its openings, bands and wall colour), the unseen texels are sent as that fill
 * feathered into the seen ones, with the ordinary prompt, instead of flat mid-grey: a model handed grey holes paints their
 * outlines (the Haughwout's Broome St, run of b7ff299c: jagged grey plaster where the melted windows were).
 */
export interface UnseenWall { source: number; familyLab?: [number, number, number]; inside?: Uint8Array; fill?: Uint8Array }

/**
 * The wall's bay or storey repeat: the first local peak (texels) in [lo, hi] of a profile's match with itself that reaches 60%
 * of its best (a facade matches itself at every multiple of its bay too, a partly unseen one sometimes better: the first is the bay).
 */
function repeatLag(p: Float64Array, lo: number, hi: number, fallback: number): number {
    let m = 0;
    for (const v of p) m += v;
    m /= Math.max(1, p.length);
    const rs: Array<[number, number]> = [];
    for (let d = Math.max(1, lo); d <= Math.min(hi, p.length - 2); d++) {
        let num = 0, a = 0, b = 0;
        for (let i = 0; i + d < p.length; i++) { const u = p[i] - m, v = p[i + d] - m; num += u * v; a += u * u; b += v * v; }
        rs.push([d, a > 0 && b > 0 ? num / Math.sqrt(a * b) : -1]);
    }
    const best = Math.max(...rs.map(r => r[1]));
    if (!(best > 0)) return fallback;
    for (let k = 0; k < rs.length; k++) {
        const r = rs[k][1], prev = k > 0 ? rs[k - 1][1] : -Infinity, next = k + 1 < rs.length ? rs[k + 1][1] : -Infinity;
        if (r >= 0.6 * best && r >= prev && r >= next) return rs[k][0];
    }
    return rs.find(([, r]) => r === best)![0];
}

/** A fill texel needs at least this many bays of its storey row seen at its place in the bay (so a one-off is outvoted). */
export const MIN_FILL_BAYS = 3;

/** A stacked texel whose bays differ by this much luminance (median absolute deviation, 0-255) has confidence 0. */
export const BAY_SPREAD_ZERO_CONFIDENCE = 64;

/**
 * The wall's irreducible bay (Müller et al. 2007, "Image-based Procedural Modeling of Facades", section 2.3): every bay of
 * the wall stacked onto one, each texel (place in the bay, row) the per-channel median of the bays `source` marks there
 * (default: the seen ones), so a car, a shadow or a one-off in one bay is outvoted by the bays without it. Rows stay rows:
 * a storey is never stacked onto another. `spread` is how much the bays disagree there (the median absolute deviation of
 * their luminance) and `confidence` maps it to 0..1 (0 too where fewer than MIN_FILL_BAYS bays vote): a measurement of how
 * well the wall repeats, not a guess.
 */
export interface BayStack {
    /** The bay, texels; the tile is bay x H. */
    bay: number;
    bayM: number;
    /** The bays the wall spans (W / bay, rounded up). */
    bays: number;
    /** bay x H RGBA: the median bay (alpha 0 where fewer than MIN_FILL_BAYS bays vote). */
    tile: Uint8Array;
    /** bay x H: the bays that voted at each texel. */
    votes: Uint8Array;
    /** bay x H: the luminance MAD across the voting bays. */
    spread: Float32Array;
    /** bay x H: 1 - spread / BAY_SPREAD_ZERO_CONFIDENCE, clamped; 0 under MIN_FILL_BAYS votes. */
    confidence: Float32Array;
    /** The share of the tile's texels with at least MIN_FILL_BAYS votes. */
    votedShare: number;
    /** The mean confidence over the voted texels (0 when none voted). */
    meanConfidence: number;
}

export function bayStack(rgba: Uint8Array, use: Uint8Array, W: number, H: number, pixelM: number, source?: Uint8Array): BayStack {
    const src = source ?? use;
    const N = W * H, L = new Float32Array(N);
    for (let i = 0; i < N; i++) L[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
    const col = new Float64Array(W);
    for (let y = 0; y < H; y++) for (let x = 0; x + 1 < W; x++) { const i = y * W + x; if (use[i] && use[i + 1]) col[x] += Math.abs(L[i + 1] - L[i]); }
    const bay = Math.max(1, Math.min(W, repeatLag(col, Math.round(1 / pixelM), Math.round(6 / pixelM), Math.round(2 / pixelM))));
    const tile = new Uint8Array(bay * H * 4), votes = new Uint8Array(bay * H), spread = new Float32Array(bay * H), confidence = new Float32Array(bay * H);
    const vals: number[][] = [[], [], [], []];
    const med = (v: number[]) => { v.sort((p, q) => p - q); return v[Math.floor(v.length / 2)]; };
    let voted = 0, confSum = 0;
    for (let y = 0; y < H; y++) for (let b = 0; b < bay; b++) {
        vals[0].length = vals[1].length = vals[2].length = vals[3].length = 0;
        for (let x = b; x < W; x += bay) {
            const j = y * W + x;
            if (!src[j]) continue;
            vals[0].push(rgba[j * 4]); vals[1].push(rgba[j * 4 + 1]); vals[2].push(rgba[j * 4 + 2]); vals[3].push(L[j]);
        }
        const k = y * bay + b, n = vals[0].length;
        votes[k] = Math.min(255, n);
        if (n < MIN_FILL_BAYS) continue;
        tile[k * 4] = med(vals[0]); tile[k * 4 + 1] = med(vals[1]); tile[k * 4 + 2] = med(vals[2]); tile[k * 4 + 3] = 255;
        const ml = med(vals[3]);
        spread[k] = med(vals[3].map(v => Math.abs(v - ml)));
        confidence[k] = Math.max(0, Math.min(1, 1 - spread[k] / BAY_SPREAD_ZERO_CONFIDENCE));
        voted++; confSum += confidence[k];
    }
    return { bay, bayM: bay * pixelM, bays: Math.ceil(W / bay), tile, votes, spread, confidence, votedShare: voted / Math.max(1, bay * H), meanConfidence: voted ? confSum / voted : 0 };
}

/** The stack laid back across the wall (W x H RGBA): each texel its bay's median, `base` where too few bays voted. */
export function stackedWall(st: BayStack, W: number, H: number, base: Uint8Array): Uint8Array {
    const out = Uint8Array.from(base);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const k = y * st.bay + (x % st.bay);
        if (!st.tile[k * 4 + 3]) continue;
        out.set(st.tile.subarray(k * 4, k * 4 + 3), (y * W + x) * 4);
        out[(y * W + x) * 4 + 3] = 255;
    }
    return out;
}

/** A bay stack is sent as the wall's reference only when at least this share of its texels had MIN_FILL_BAYS bays voting. */
export const BAY_STACK_MIN_REFERENCE_SHARE = 0.5;

/** What a bay stack measured, for a wall's record. */
export function bayStackRecord(st: BayStack): NonNullable<EnhanceWallRecord['bayStack']> {
    return { bayM: Math.round(st.bayM * 100) / 100, bays: st.bays, votedShare: Math.round(st.votedShare * 1000) / 1000, meanConfidence: Math.round(st.meanConfidence * 1000) / 1000 };
}

/**
 * A fill for a wall's unseen texels from the wall itself, along its own storey only: the wall's bay stack (bayStack) at the
 * texel's place in the bay. Never a storey up or down (that added a storey above the Haughwout's cornice), and a one-off
 * feature in one bay (its clock) is outvoted by the bays without it, so it is never repeated. A texel with fewer than
 * MIN_FILL_BAYS bays to vote takes `base` (e.g. the painted reading). Pass `stack` when it is already measured.
 */
export function repeatFill(rgba: Uint8Array, use: Uint8Array, W: number, H: number, pixelM: number, base: Uint8Array, source?: Uint8Array, stack?: BayStack): Uint8Array {
    const st = stack ?? bayStack(rgba, use, W, H, pixelM, source);
    const all = stackedWall(st, W, H, base), out = Uint8Array.from(base);
    for (let i = 0; i < W * H; i++) if (!use[i]) out.set(all.subarray(i * 4, i * 4 + 4), i * 4);
    return out;
}

/** The texels as sent: the seen ones as they are, the unseen ones from `fill`, the band between blended over UNSEEN_FEATHER_PX. */
export function featheredFill(rgba: Uint8Array, fill: Uint8Array, use: Uint8Array, W: number, H: number): Uint8Array {
    const out = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) { const src = use[i] ? rgba : fill; out[i * 4] = src[i * 4]; out[i * 4 + 1] = src[i * 4 + 1]; out[i * 4 + 2] = src[i * 4 + 2]; out[i * 4 + 3] = 255; }
    const r = UNSEEN_FEATHER_PX, res = out.slice();
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x;
        let mixed = false;
        for (let dy = -r; dy <= r && !mixed; dy++) for (let dx = -r; dx <= r && !mixed; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx >= 0 && yy >= 0 && xx < W && yy < H && use[yy * W + xx] !== use[i]) mixed = true;
        }
        if (!mixed) continue;
        let s0 = 0, s1 = 0, s2 = 0, n = 0;
        for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
            const j = (yy * W + xx) * 4;
            s0 += out[j]; s1 += out[j + 1]; s2 += out[j + 2]; n++;
        }
        res[i * 4] = Math.round(s0 / n); res[i * 4 + 1] = Math.round(s1 / n); res[i * 4 + 2] = Math.round(s2 / n);
    }
    return res;
}

/** Everything one model request for a wall is made of, and what is needed to read its answer back onto the plate. */
export interface PreparedFacade {
    request: PlateRequest;
    /** The plate as sent, before padding (sw x sh). */
    small: RgbaImage8;
    /** What the survey saw (sw x sh), the unseen texels mid-grey: what the storeys and bays are counted on when a fill was sent. */
    surveyed: RgbaImage8;
    padded: RgbaImage8;
    offset: [number, number];
    sw: number; sh: number;
    N: number;
    coveredShare: number;
    widthM: number; heightM: number;
}

/** The plate as sent to the model: at most ENHANCE_MAX_SIDE long, padded to a model aspect, an unseen wall's gaps mid-grey. */
export function prepareFacadeRequest(f: MassingFace, t: FaceTexture, use: Uint8Array, opts: {
    locationName: string; models: string[]; reference?: FaceTexture; signal?: AbortSignal;
    /** What `reference` is: the adjacent finished wall (default) or this wall's own bays stacked (stackedWall). */
    referenceKind?: 'adjacent' | 'bayStack';
    /** The Street View photo sent to the model with the plate (absent: none sent). */
    streetView?: WallStreetView;
    unseen?: UnseenWall;
    /** The lowest metres of the wall to describe to the model as the street level to draw (TexturePlatePromptOptions.streetBand). */
    streetBandM?: number;
}): PreparedFacade {
    const scale = Math.min(1, ENHANCE_MAX_SIDE / Math.max(t.width, t.height));
    const sw = Math.max(16, Math.round(t.width * scale)), sh = Math.max(16, Math.round(t.height * scale));
    const N = t.width * t.height;
    let coveredN = 0;
    for (let i = 0; i < N; i++) if (use[i]) coveredN++;
    const coveredShare = N ? coveredN / N : 0;
    // an unseen wall goes to the model with what the tile does not cover in flat mid-grey, to be drawn as the wall continues,
    // or, given a fill, as that fill feathered into what the tile does cover
    const sent = opts.unseen?.fill ? featheredFill(t.rgba, opts.unseen.fill, use, t.width, t.height) : opts.unseen ? (() => { const g = t.rgba.slice(); for (let i = 0; i < N; i++) if (!use[i]) { g[i * 4] = 128; g[i * 4 + 1] = 128; g[i * 4 + 2] = 128; g[i * 4 + 3] = 255; } return g; })() : t.rgba;
    const small: RgbaImage8 = resizeRgba({ width: t.width, height: t.height, rgba: sent }, sw, sh);
    // counted on what was seen, never on a fill (a fill copied a storey up and the count read 6 storeys on both sides)
    const surveyed: RgbaImage8 = opts.unseen?.fill ? resizeRgba({ width: t.width, height: t.height, rgba: (() => { const g = t.rgba.slice(); for (let i = 0; i < N; i++) if (!use[i]) { g[i * 4] = 128; g[i * 4 + 1] = 128; g[i * 4 + 2] = 128; g[i * 4 + 3] = 255; } return g; })() }, sw, sh) : small;
    const { padded, offset } = padToModelAspect(small);
    const r = opts.reference;
    const ref = r ? (() => { const rs = Math.min(1, 768 / Math.max(r.width, r.height)); const s = resizeRgba({ width: r.width, height: r.height, rgba: r.rgba }, Math.max(8, Math.round(r.width * rs)), Math.max(8, Math.round(r.height * rs))); return new Uint8Array(encodePng(s.width, s.height, Buffer.from(s.rgba), 4)); })() : undefined;
    const prompt = buildTexturePlatePrompt({ locationName: opts.locationName, widthM: t.width * f.pixel, heightM: t.height * f.pixel, widthPx: padded.width, heightPx: padded.height, preserveClause: preserveClause(padded.width, padded.height), withReference: !!ref, ...(ref && opts.referenceKind === 'bayStack' ? { referenceIsBayStack: true } : {}), ...(opts.streetView ? { withStreetView: true } : {}), ...(opts.unseen && !opts.unseen.fill ? { unseen: true } : {}),
        ...(opts.streetBandM ? { streetBand: { bandM: opts.streetBandM, bandPx: Math.round((opts.streetBandM / (t.height * f.pixel)) * sh) + (padded.height - sh) - offset[1] } } : {}) });
    const image = new Uint8Array(encodePng(padded.width, padded.height, Buffer.from(padded.rgba), 4));
    const request: PlateRequest = { prompt, image, width: padded.width, height: padded.height, ...(ref ? { reference: ref } : {}), ...(opts.streetView ? { streetView: opts.streetView.crop } : {}), models: opts.models, ...(opts.signal ? { signal: opts.signal } : {}) };
    return { request, small, surveyed, padded, offset: offset as [number, number], sw, sh, N, coveredShare, widthM: t.width * f.pixel, heightM: t.height * f.pixel };
}

/** The model's answer read back onto the plate's full size (the padding cut away). Throws when the answer cannot be decoded. */
export function plateFromAnswer(bytes: Uint8Array, prep: PreparedFacade, t: FaceTexture): { back: Uint8Array; answered: { width: number; height: number } } {
    const dec = decodeImageInMemory(bytes);
    const { padded, offset, sw, sh } = prep;
    const full = resizeRgba(dec, padded.width, padded.height);
    const inner = new Uint8Array(sw * sh * 4);
    for (let y = 0; y < sh; y++) inner.set(full.rgba.subarray(((offset[1] + y) * full.width + offset[0]) * 4, ((offset[1] + y) * full.width + offset[0] + sw) * 4), y * sw * 4);
    return { back: resizeRgba({ width: sw, height: sh, rgba: inner }, t.width, t.height).rgba, answered: { width: dec.width, height: dec.height } };
}

export type FacadeCountsRead = { tile?: FacadeCounts; plate?: FacadeCounts; unread?: string };

/**
 * The corrective warp and the identity gate of one answer. The storeys and bays are read by `count` when given (a caller's
 * own reading, e.g. version F's lattice), else by `counter` (the vision count of the plate as sent against the aligned
 * answer); an unseen wall's plate must also draw its gaps rather than leave them grey.
 */
export async function alignAndIdentify(f: MassingFace, t: FaceTexture, use: Uint8Array, prep: PreparedFacade, back: Uint8Array, answered: { width: number; height: number }, opts: {
    unseen?: UnseenWall; counter?: FacadeCounter; signal?: AbortSignal;
    count?: (aligned: Uint8Array) => Promise<FacadeCountsRead> | FacadeCountsRead;
}): Promise<{ g: AlignResult; idg: IdentityGate; counts: FacadeCountsRead; grossNotMeasured?: string }> {
    const { unseen } = opts;
    // too little of an unseen wall is covered to align the answer on: it is taken as answered, and the gate says so
    const alignable = !unseen || prep.coveredShare >= UNSEEN_MIN_ALIGN_SHARE;
    const g: AlignResult = alignable ? alignPlate(t.rgba, back, t.width, t.height, use, f.pixel)
        : { dx: 0, dy: 0, scale: 1, chamferPx: 0, lostShare: 0, accepted: true, why: 'not aligned', aligned: back };
    const grossNotMeasured = alignable ? undefined : `the tile covers ${(100 * prep.coveredShare).toFixed(0)}% of the wall, under ${100 * UNSEEN_MIN_ALIGN_SHARE}%: too little to align on`;
    let counts: FacadeCountsRead;
    if (opts.count) counts = await opts.count(g.aligned);
    else if (unseen && prep.coveredShare < UNSEEN_MIN_COUNT_SHARE) counts = { unread: `the tile covers ${(100 * prep.coveredShare).toFixed(0)}% of the wall: its storeys and bays cannot be counted on it` };
    else if (opts.counter) {
        // the tile as sent and the aligned plate at the same size, counted together
        const plateSmall = resizeRgba({ width: t.width, height: t.height, rgba: g.aligned }, prep.sw, prep.sh);
        try {
            counts = await opts.counter(new Uint8Array(encodePng(prep.sw, prep.sh, Buffer.from(prep.surveyed.rgba), 4)), new Uint8Array(encodePng(prep.sw, prep.sh, Buffer.from(plateSmall.rgba), 4)), prep.widthM, prep.heightM);
        } catch (err) {
            if (opts.signal?.aborted) throw err;
            counts = { unread: `the count could not be read: ${(err as Error).message.slice(0, 120)}` };
        }
    } else counts = { unread: 'no vision model to count with' };
    const colourAgainst = unseen?.familyLab && prep.coveredShare < UNSEEN_MIN_COLOUR_SHARE ? unseen.familyLab : undefined;
    const idg = identityGate(t.rgba, g.aligned, t.width, t.height, use, { askedAspect: prep.padded.width / prep.padded.height, answeredAspect: answered.width / answered.height, chamferPx: g.chamferPx, lostShare: g.lostShare, counts, ...(grossNotMeasured ? { grossNotMeasured } : {}), ...(colourAgainst ? { colourAgainst } : {}) });
    // an unseen wall's plate must draw the unseen part, not leave it grey (a filled wall was sent nothing grey)
    if (unseen && !unseen.fill) {
        const grey = unseenGreyShare(g.aligned, use, prep.N, unseen.inside);
        if (grey > UNSEEN_MAX_GREY_SHARE) { idg.passed = false; idg.why = `${idg.why}; ${(100 * grey).toFixed(0)}% of the unseen part left flat mid-grey (more than ${100 * UNSEEN_MAX_GREY_SHARE}%)`; }
    }
    return { g, idg, counts, ...(grossNotMeasured ? { grossNotMeasured } : {}) };
}

/** Writes an accepted plate into the wall's texture: texels the guards did not revert (weight under 0.5) take `source`. */
export function writeFacadeTexture(t: FaceTexture, out: Uint8Array, weight: Float32Array | undefined, use: Uint8Array, source: number, unseen?: UnseenWall): void {
    for (let i = 0; i < t.width * t.height; i++) {
        t.rgba[i * 4] = out[i * 4]; t.rgba[i * 4 + 1] = out[i * 4 + 1]; t.rgba[i * 4 + 2] = out[i * 4 + 2]; t.rgba[i * 4 + 3] = 255;
        if (!weight || weight[i] < 0.5) t.source[i] = unseen && !use[i] ? unseen.source : source;
    }
}

export interface BuildFacadeTextureOptions {
    client: PlateModelClient; models: string[]; locationName: string; reference?: FaceTexture; source: number; signal?: AbortSignal;
    guards?: boolean; streetView?: WallStreetView; streetViewSource?: number; noStreetView?: string;
    /** Send `streetView` to the model as its street-level reference even with the guards off (they alone otherwise enable it). */
    streetViewGuide?: boolean;
    /** When the photo-guided redraw fails the identity gate, redraw once without the photo (default true). */
    retryWithoutPhoto?: boolean;
    /** Do not send the photo; only check the plate against it (the redraw after a photo-guided one failed the gate). */
    photoCheckOnly?: boolean;
    /** Reads storey and bay counts of the tile and of the plate (plate-identity.ts); without it the counts are not checked. */
    counter?: FacadeCounter;
    /**
     * This wall's bays stacked onto one (bayStack): recorded on the wall, and sent as the model's reference (stackedWall) when
     * no `reference` is given and at least BAY_STACK_MIN_REFERENCE_SHARE of the bay was voted on.
     */
    bayStack?: BayStack;
    /**
     * A wall the tile hardly sees: its uncovered texels are sent mid-grey with the unseen prompt (drawn as the wall continues)
     * and labelled `source` when accepted; `familyLab` is the building's median facade colour (CIELAB), the colour family
     * checked when the tile covers too little of the wall to have one.
     */
    unseen?: UnseenWall;
    /**
     * Where answers are kept, keyed by everything the model is sent (models, prompt, images): the same wall with the same
     * inputs gets the same plate on every rebuild.
     */
    cacheDir?: string;
    /**
     * Regions the audit flags (erased, replaced or recoloured against the input) are redrawn by generative infill from the
     * accepted plate around them (image-hole-infill.ts, the inpaint lock), not reverted to the input, and the wall is not
     * refused for how much was flagged. For inputs worse than the redraw (pipeline G's survey plates of the melted tile),
     * where a revert would paste the melt back. A fill the lock refuses falls back to the revert (and the share limit).
     */
    infill?: { client: EnhanceModelClient; models: string[] };
    /**
     * The models that redraw a wall with unseen areas (more than UNSEEN_MODEL_SHARE of it to be drawn as it continues), in
     * place of `models`: the Lite model redraws a seen wall well but leaves what it is asked to fill flat grey (the
     * Haughwout, run 653c06f8: 59% of Broadway's unseen part left grey).
     */
    unseenModels?: string[];
    /** The lowest metres of the wall: described to the model as the street level, drawn as the ground floor (prepareFacadeRequest). */
    streetBandM?: number;
    /**
     * The quality score (quality.ts) decides too: the texture as it would be written must have no seam, no smeared run and at
     * most MAX_EMPTY_SHARE flat grey or empty inside `inside` (the wall's polygon); with `infill`, what it faults is redrawn by
     * generative infill first and scored again.
     */
    quality?: boolean;
    /** The wall's own polygon in its frame (the quality score's extent). */
    inside?: Uint8Array;
    /** Texels the survey saw through (openings, 1): with `quality`, the redraw must still show openings there (quality.ts openingsKept). */
    openings?: Uint8Array;
}

export type FacadeTextureResult = EnhanceWallRecord & { plate?: Uint8Array; guarded?: Uint8Array; labels?: string[]; grid?: CellGrid };

/**
 * Redraws one wall once and gates it: the identity gate, then (guards on) the invention and erasure check and, with a
 * Street View photo of the wall, the photo check; flagged regions revert to the input, feathered. On acceptance the wall's
 * texels become the guarded plate with `source` (or `streetViewSource` when a photo guided it); reverted texels keep theirs.
 */
export async function buildFacadeTexture(f: MassingFace, t: FaceTexture, use: Uint8Array, opts: BuildFacadeTextureOptions): Promise<FacadeTextureResult> {
    const t0 = Date.now();
    const guards = opts.guards ?? true;
    const sv = guards || opts.streetViewGuide ? opts.streetView : undefined;
    // the photo is sent to the model unless this is the redraw without it (it then only checks the plate)
    const guide = !!sv && !opts.photoCheckOnly;
    const unseen = opts.unseen;
    let uncovered = 0;
    for (let i = 0; i < use.length; i++) if (!use[i]) uncovered++;
    const models = unseen && opts.unseenModels?.length && uncovered > UNSEEN_MODEL_SHARE * use.length ? opts.unseenModels : opts.models;
    // with no finished neighbour, the wall's own bays stacked are its reference when enough of the bay was voted on
    const st = opts.bayStack;
    const stackRef: FaceTexture | undefined = !opts.reference && st && st.votedShare >= BAY_STACK_MIN_REFERENCE_SHARE
        ? { width: t.width, height: t.height, rgba: stackedWall(st, t.width, t.height, t.rgba), source: new Uint8Array(t.width * t.height) } : undefined;
    const reference = opts.reference ?? stackRef;
    const prep = prepareFacadeRequest(f, t, use, { locationName: opts.locationName, models, ...(reference ? { reference } : {}), ...(stackRef ? { referenceKind: 'bayStack' as const } : {}), ...(opts.signal ? { signal: opts.signal } : {}), ...(guide ? { streetView: sv } : {}), ...(unseen ? { unseen } : {}), ...(opts.streetBandM ? { streetBandM: opts.streetBandM } : {}) });
    const svRec: EnhanceStreetViewRecord | undefined = sv ? { ...(guide ? {} : { checkOnly: true }), panoId: sv.view.panoId, method: sv.view.registration?.method ?? 'nominal', bandCover: Math.round(sv.rect.bandCover * 1000) / 1000, pxPerM: Math.round(sv.rect.pxPerM * 10) / 10 } : undefined;
    const base = { face: f.index, key: f.key, ...(st ? { bayStack: bayStackRecord(st) } : {}), ...(svRec ? { streetView: svRec } : {}), ...(guards && !sv && opts.noStreetView ? { noStreetView: opts.noStreetView } : {}) };
    let answer: PlateAnswer;
    try {
        answer = await cachedPlate(opts.cacheDir, prep.request, opts.client);
    } catch (err) {
        if (opts.signal?.aborted) throw err;
        return { ...base, accepted: false, why: `the model did not answer (${(err as Error).message.slice(0, 160)})`, ms: Date.now() - t0 };
    }
    let read: ReturnType<typeof plateFromAnswer>;
    try { read = plateFromAnswer(answer.bytes, prep, t); } catch (err) { return { ...base, accepted: false, why: `the answer cannot be decoded (${(err as Error).message})`, model: answer.modelUsed, ms: Date.now() - t0 }; }
    const { g, idg } = await alignAndIdentify(f, t, use, prep, read.back, read.answered, { ...(unseen ? { unseen } : {}), ...(opts.counter ? { counter: opts.counter } : {}), ...(opts.signal ? { signal: opts.signal } : {}) });
    const why0 = `${unseen ? `${(100 * prep.coveredShare).toFixed(0)}% of the wall seen, the rest drawn as it continues (${unseen.fill ? 'sent as the given fill, feathered' : TEXTURE_PLATE_UNSEEN_PROMPT_ID}); ` : ''}corrective warp ${g.dx}, ${g.dy} px, scale ${g.scale.toFixed(3)}; ${idg.why}`;
    const rec = { ...base, accepted: idg.passed, why: idg.passed ? why0 : `not the same wall: ${why0}`, model: answer.modelUsed, chamferPx: g.chamferPx, lostShare: g.lostShare, identity: identityRecord(idg), ms: Date.now() - t0, plate: g.aligned };
    if (!idg.passed && guide && opts.retryWithoutPhoto !== false) {
        // the photo pulled the redraw away from the wall: one more redraw without it; the tile check and the check against the
        // photo still apply
        const again = await buildFacadeTexture(f, t, use, { ...opts, photoCheckOnly: true });
        return { ...again, ms: Date.now() - t0, streetView: { ...(again.streetView ?? svRec!), guidedRejected: rec.why } };
    }
    if (!idg.passed) return rec;
    let out = g.aligned, weight: Float32Array | undefined;
    let extra: { audit?: EnhanceAuditRecord; guarded?: Uint8Array; labels?: string[]; grid?: CellGrid } = {};
    if (guards) {
        const gp = guardPlate(t.rgba, g.aligned, t.width, t.height, use, f.pixel, sv ? { rect: sv.rect, bandTop: streetBandTop(f) } : undefined);
        if (svRec && gp.photo) Object.assign(svRec, { shiftPx: gp.photo.shiftPx, nccPlate: gp.photo.nccPlate, nccInput: gp.photo.nccInput, comparedCells: gp.photo.comparedCells, supportedCells: gp.photo.supportedCells, contradictedCells: gp.photo.contradictedCells });
        extra = { audit: gp.audit, guarded: gp.rgba, labels: gp.labels, grid: gp.grid };
        let flagged = 0;
        for (let i = 0; i < gp.mask.length; i++) if (gp.mask[i] && use[i]) flagged++;
        const fill = opts.infill && flagged ? await infillImageHoles({ image: { width: t.width, height: t.height, rgba: g.aligned }, client: opts.infill.client, models: opts.infill.models, mask: gp.mask, ...(opts.signal ? { signal: opts.signal } : {}) }) : undefined;
        if (fill) (rec as FacadeTextureResult).infill = { decision: fill.decision, holePixels: fill.holePixels, filledPixels: fill.filledPixels, ...(fill.reason ? { reason: fill.reason } : {}), ...(fill.modelUsed ? { model: fill.modelUsed } : {}) };
        if (fill?.decision === 'accepted') {
            // the flagged regions redrawn from the plate around them: the whole wall is the redraw, nothing taken back from the input
            out = fill.image.rgba; weight = undefined;
            rec.why = `${rec.why}; ${gp.audit.regions.length} flagged region${gp.audit.regions.length === 1 ? '' : 's'} (${(100 * gp.audit.flaggedShare).toFixed(0)}% of the wall) redrawn by generative infill (${fill.modelUsed}, ${fill.filledPixels} texels) instead of reverted`;
        } else {
            const fell = fill ? `; generative infill of the flagged regions was refused (${fill.reason ?? fill.decision}), so they revert` : '';
            if (gp.reject) return { ...rec, ...extra, accepted: false, why: `${rec.why}; ${gp.why}${fell}`, ms: Date.now() - t0 };
            out = gp.rgba; weight = gp.weight;
            rec.why = `${rec.why}; ${gp.why}${fell}`;
        }
    }
    if (opts.quality) {
        let q = facadeQuality(out, t.width, t.height, f.pixel, opts.inside);
        if (!q.passed && opts.infill) {
            // what the score faults (empty areas, a band round each seam, the smeared runs) redrawn from around it, then scored again
            const fill = await infillImageHoles({ image: { width: t.width, height: t.height, rgba: out }, client: opts.infill.client, models: opts.infill.models, mask: q.faultMask, ...(opts.signal ? { signal: opts.signal } : {}) });
            (rec as FacadeTextureResult).infill = { decision: fill.decision, holePixels: fill.holePixels, filledPixels: fill.filledPixels, ...(fill.reason ? { reason: fill.reason } : {}), ...(fill.modelUsed ? { model: fill.modelUsed } : {}) };
            if (fill.decision === 'accepted') { out = fill.image.rgba; q = facadeQuality(out, t.width, t.height, f.pixel, opts.inside); rec.why = `${rec.why}; ${fill.filledPixels} texels the quality score faulted redrawn by generative infill`; }
            else rec.why = `${rec.why}; generative infill of what the quality score faulted was refused (${fill.reason ?? fill.decision})`;
        }
        const ok = opts.openings ? openingsKept(out, t.width, t.height, opts.openings) : undefined;
        (rec as FacadeTextureResult).quality = { passed: q.passed && (ok?.passed ?? true), emptyShare: q.emptyShare, seams: q.seams.rows.length + q.seams.cols.length, smearShare: q.smearShare, sharpness: q.sharpness, why: q.why, ...(ok ? { openings: { passed: ok.passed, contrast: ok.contrast, smoothRatio: ok.smoothRatio } } : {}) };
        const qWhy = ok ? `${q.why}; ${ok.why}` : q.why;
        if (!q.passed || (ok && !ok.passed)) return { ...rec, ...extra, accepted: false, why: `${rec.why}; ${qWhy}`, ms: Date.now() - t0 };
        rec.why = `${rec.why}; ${qWhy}`;
    }
    writeFacadeTexture(t, out, weight, use, guide && opts.streetViewSource !== undefined ? opts.streetViewSource : opts.source, unseen);
    return { ...rec, ...extra, ms: Date.now() - t0 };
}

/** What `buildFacadeTextureFromImage` needs: a straight-on picture of one wall and its size in metres. */
export interface FacadeImageInput {
    /** The wall, straight on (rectified), W x H RGBA: a survey plate, a tile ortho, a rectified photo. */
    image: RgbaImage8;
    widthM: number;
    heightM: number;
    /** Texels to draw as the wall continues (1): unseen, occluded, holes. Default: the image's flat mid-grey texels. */
    unseenMask?: Uint8Array;
    /** A finished neighbouring wall, the reference for materials (any size). */
    reference?: RgbaImage8;
    locationName: string;
    client: PlateModelClient;
    models: string[];
    /** Generative infill of what the quality score faults (and, with `audit`, of what the region audit flags). */
    infill?: { client: EnhanceModelClient; models: string[] };
    /** The models that redraw a picture with unseen areas (buildFacadeTexture's unseenModels). */
    unseenModels?: string[];
    /** Counts the input's and the redraw's storeys and bays (plate-identity.ts visionFacadeCounter); without it they are not counted. */
    counter?: FacadeCounter;
    /** The region audit against the input (default off: on a melted or partial input it reads the melt as elements erased). */
    audit?: boolean;
    cacheDir?: string;
    signal?: AbortSignal;
}

/**
 * The facade texture builder on any straight-on wall picture, outside a staged build (the facade_texture_build tool, and
 * scripts): the picture becomes a one-wall face of `widthM` x `heightM`, the unseen texels are drawn as the wall continues,
 * and the redraw is kept only through the identity gate and the quality score (with infill of what the score faults). The
 * result carries the texture when accepted.
 */
export async function buildFacadeTextureFromImage(input: FacadeImageInput): Promise<FacadeTextureResult & { texture?: RgbaImage8; coveredShare: number }> {
    const { width: W, height: H } = input.image;
    const pixel = input.widthM / W;
    const face: MassingFace = {
        index: 0, key: 'image', kind: 'wall', part: 'image', loop: 0, edge: 0, wall: true,
        normal: [0, 0, 1], axisS: [1, 0, 0], axisT: [0, 1, 0], origin: [0, 0, 0],
        sMin: 0, sMax: input.widthM, tMin: 0, tMax: input.heightM, tBottom: 0, area: input.widthM * input.heightM,
        pixel, orthoSMin: 0, orthoTMax: input.heightM, width: W, height: H, coverage: 1, openings: [], top: []
    };
    const use = new Uint8Array(W * H);
    let seen = 0;
    for (let i = 0; i < W * H; i++) {
        const grey = Math.abs(input.image.rgba[i * 4] - 128) <= 4 && Math.abs(input.image.rgba[i * 4 + 1] - 128) <= 4 && Math.abs(input.image.rgba[i * 4 + 2] - 128) <= 4;
        use[i] = input.unseenMask ? (input.unseenMask[i] ? 0 : 1) : (grey ? 0 : 1);
        seen += use[i];
    }
    const t: FaceTexture = { width: W, height: H, rgba: Uint8Array.from(input.image.rgba), source: new Uint8Array(W * H) };
    const ref: FaceTexture | undefined = input.reference ? { width: input.reference.width, height: input.reference.height, rgba: input.reference.rgba, source: new Uint8Array(input.reference.width * input.reference.height) } : undefined;
    const r = await buildFacadeTexture(face, t, use, {
        client: input.client, models: input.models, locationName: input.locationName, source: 1, guards: input.audit === true, quality: true,
        ...(seen < W * H ? { unseen: { source: 1 } } : {}), ...(ref ? { reference: ref } : {}), ...(input.infill ? { infill: input.infill } : {}), ...(input.unseenModels ? { unseenModels: input.unseenModels } : {}),
        ...(input.counter ? { counter: input.counter } : {}), ...(input.cacheDir ? { cacheDir: input.cacheDir } : {}), ...(input.signal ? { signal: input.signal } : {})
    });
    return { ...r, coveredShare: seen / (W * H), ...(r.accepted ? { texture: { width: W, height: H, rgba: t.rgba } } : {}) };
}
