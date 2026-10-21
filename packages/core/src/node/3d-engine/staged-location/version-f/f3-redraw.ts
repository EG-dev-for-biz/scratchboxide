/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Version F round 3: the redraw of one wall, best of n.
 *
 * Pipeline E's enhanceWall (enhance.ts) draws a wall once, counts its storeys and bays with a vision call, audits it, and on
 * a rejection redraws it once more without the photo, in series. Here each wall is drawn SAMPLES times at once (the same
 * request, its own cache slot per sample), every answer is gated by the local checks (local-gate.ts: F's lattice on a
 * strong-fit wall, the must-keep features, the region audit and the Street View check of enhance.ts), the weak-fit walls'
 * vision count runs for all the samples at the same time, and the best eligible candidate by the local numbers is the plate.
 * Nothing is retried in series; a wall none of whose samples passes keeps its tile texture, with every sample's reason.
 *
 * Every image call goes through an ImageCallGovernor: at most `maxInFlight` calls out at once across the building, a 429
 * pauses new calls for a doubling back-off (as the vision chain's hedge pause), 5xx and deadline errors retry twice.
 */

import * as path from 'path';
import { buildTexturePlatePrompt, TEXTURE_PLATE_UNSEEN_PROMPT_ID } from '../../../../browser/generative-canvas/services/location-beautify-service';
import { decodeImageInMemory, type RgbaImage8 } from '../tile-texture-transfer';
import { padToModelAspect, resizeRgba } from '../texture-enhance';
import { encodePng } from '../png-encode';
import type { FaceTexture } from '../pipeline-e/massing-glb';
import type { MassingFace } from '../pipeline-e/native-massing';
import { alignPlate, cachedPlate, guardPlate, identityRecord, preserveClause, unseenGreyShare, ENHANCE_MAX_SIDE, UNSEEN_MAX_GREY_SHARE, UNSEEN_MIN_ALIGN_SHARE, UNSEEN_MIN_COLOUR_SHARE, UNSEEN_MIN_COUNT_SHARE, type AlignResult, type EnhanceAuditRecord, type EnhanceIdentityRecord, type EnhanceStreetViewRecord, type PlateAnswer, type PlateModelClient, type PlateRequest, type WallStreetView } from '../pipeline-e/enhance';
import { identityGate, type FacadeCounter, type FacadeCounts } from '../pipeline-e/plate-identity';
import { streetBandTop } from '../pipeline-e/plate-streetview';
import { featureGuard, latticeIdentity, pickCandidate, STRONG_FIT_NCC, type CandidateScore, type FeatureRegionPx, type FeatureVerdict, type LatticeCheck } from './local-gate';

/** Plates drawn per wall at once. */
export const SAMPLES = 3;
/** Image calls out at once across the building (the model's 429s set the pace from there). */
export const IMAGE_MAX_IN_FLIGHT = 12;
export const IMAGE_RATE_LIMIT_PAUSE_MS = 30_000;
export const IMAGE_RATE_LIMIT_PAUSE_MAX_MS = 300_000;
export const IMAGE_RETRIES = 3;

const isRateLimit = (err: unknown): boolean => {
    const e = err as { status?: number; mediaError?: { code?: string; status?: number }; message?: string } | undefined;
    return e?.status === 429 || e?.mediaError?.status === 429 || e?.mediaError?.code === 'quota' || /\b429\b|RESOURCE_EXHAUSTED|quota exceeded|rate limit/i.test(e?.message ?? '');
};
const isTransient = (err: unknown): boolean => {
    const e = err as { status?: number; mediaError?: { status?: number; retryable?: boolean }; message?: string } | undefined;
    const st = e?.status ?? e?.mediaError?.status;
    return (st !== undefined && st >= 500) || e?.mediaError?.retryable === true || /\b50[0-9]\b|deadline|UNAVAILABLE|ECONNRESET|fetch failed|socket hang up/i.test(e?.message ?? '');
};

/** The pace of the image calls: a slot limit, a shared pause after a 429 that doubles, retries for transient answers. */
export class ImageCallGovernor {
    readonly counts = { calls: 0, rateLimited: 0, transient: 0, retried: 0, waitedMs: 0, peakInFlight: 0 };
    private inFlight = 0;
    private waiters: Array<() => void> = [];
    private pauseUntil = 0;
    private pauseMs: number;
    private readonly sleep: (ms: number) => Promise<void>;
    constructor(private readonly opts: { maxInFlight?: number; pauseMs?: number; maxPauseMs?: number; retries?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {}) {
        this.pauseMs = opts.pauseMs ?? IMAGE_RATE_LIMIT_PAUSE_MS;
        this.sleep = opts.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
    }
    private now(): number { return this.opts.now ? this.opts.now() : Date.now(); }
    private async slot(): Promise<void> {
        const max = this.opts.maxInFlight ?? IMAGE_MAX_IN_FLIGHT;
        if (this.inFlight >= max) await new Promise<void>(r => this.waiters.push(r));
        this.inFlight++;
        this.counts.peakInFlight = Math.max(this.counts.peakInFlight, this.inFlight);
    }
    private release(): void {
        this.inFlight--;
        const w = this.waiters.shift();
        if (w) w();
    }
    /** Milliseconds of the current 429 pause left (0: none). */
    pauseLeftMs(): number { return Math.max(0, this.pauseUntil - this.now()); }
    async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
        const retries = this.opts.retries ?? IMAGE_RETRIES;
        let attempt = 0;
        for (;;) {
            if (signal?.aborted) throw new Error('aborted');
            const wait = this.pauseLeftMs();
            if (wait > 0) { this.counts.waitedMs += wait; await this.sleep(wait); continue; }
            await this.slot();
            try {
                this.counts.calls++;
                return await fn();
            } catch (err) {
                if (signal?.aborted) throw err;
                if (isRateLimit(err)) {
                    this.counts.rateLimited++;
                    // one pause for the whole building; the next 429 in a row doubles it
                    const left = this.pauseLeftMs();
                    if (left <= 0) { this.pauseUntil = this.now() + this.pauseMs; this.pauseMs = Math.min(this.opts.maxPauseMs ?? IMAGE_RATE_LIMIT_PAUSE_MAX_MS, this.pauseMs * 2); }
                    if (++attempt > retries) throw err;
                    this.counts.retried++;
                    continue;
                }
                if (isTransient(err) && attempt < 2) { this.counts.transient++; this.counts.retried++; attempt++; await this.sleep(1000 * attempt); continue; }
                throw err;
            } finally { this.release(); }
        }
    }
    /** A good answer resets the pause length (not an active pause). */
    noteSuccess(): void { this.pauseMs = this.opts.pauseMs ?? IMAGE_RATE_LIMIT_PAUSE_MS; }
}

export interface SampleRecord {
    sample: number;
    model?: string;
    cached?: boolean;
    /** Why the sample is not eligible (absent when it is). */
    rejected?: string;
    chamferPx?: number;
    lostShare?: number;
    identity?: EnhanceIdentityRecord;
    lattice?: LatticeCheck;
    counts?: { tile?: FacadeCounts; plate?: FacadeCounts; unread?: string };
    audit?: EnhanceAuditRecord;
    features?: FeatureVerdict[];
    photoSupport?: number;
    rank?: number;
    ms: number;
}

export interface RedrawWallRecord {
    face: number; key: string; accepted: boolean; why: string; model?: string; ms: number;
    /** The chosen sample (absent when none was eligible). */
    chosen?: number;
    samples: SampleRecord[];
    /** The gate that decided the storeys and bays: F's lattice (strong fit) or the vision count (weak fit, or no fit). */
    countGate: 'lattice' | 'vision' | 'none' | (string & {});
    chamferPx?: number; lostShare?: number; identity?: EnhanceIdentityRecord; audit?: EnhanceAuditRecord; streetView?: EnhanceStreetViewRecord; noStreetView?: string;
    plate?: Uint8Array; guarded?: Uint8Array; labels?: string[]; grid?: { cw: number; ch: number; cellPx: number; cover: Float32Array };
}

export interface RedrawWallOptions {
    client: PlateModelClient; models: string[]; locationName: string; reference?: FaceTexture; source: number; signal?: AbortSignal;
    guards?: boolean; streetView?: WallStreetView; streetViewSource?: number; noStreetView?: string;
    cacheDir?: string; samples?: number; governor: ImageCallGovernor;
    /** The vision count (weak-fit walls only; the strong-fit walls read F's lattice). */
    counter?: FacadeCounter;
    /** F's planned offset map of the wall and the tile's window NCC against it (the fit's strength). */
    fit?: { planned: Float32Array; tileNcc: number };
    /** The reading's must-keep features on this wall. */
    features?: FeatureRegionPx[];
    unseen?: { source: number; familyLab?: [number, number, number]; inside?: Uint8Array };
    onProgress?: (m: string) => void;
}

/**
 * Draws the wall `samples` times at once, gates every answer locally, and writes the best one into `t` (texels become
 * `source`, or `streetViewSource` when the photo guided the plate; reverted regions keep their texels).
 */
export async function redrawWallBestOf(f: MassingFace, t: FaceTexture, use: Uint8Array, opts: RedrawWallOptions): Promise<RedrawWallRecord> {
    const t0 = Date.now();
    const guards = opts.guards ?? true;
    const sv = guards ? opts.streetView : undefined;
    const scale = Math.min(1, ENHANCE_MAX_SIDE / Math.max(t.width, t.height));
    const sw = Math.max(16, Math.round(t.width * scale)), sh = Math.max(16, Math.round(t.height * scale));
    const N = t.width * t.height;
    let coveredN = 0;
    for (let i = 0; i < N; i++) if (use[i]) coveredN++;
    const coveredShare = N ? coveredN / N : 0;
    const unseen = opts.unseen;
    const sent = unseen ? (() => { const g = t.rgba.slice(); for (let i = 0; i < N; i++) if (!use[i]) { g[i * 4] = 128; g[i * 4 + 1] = 128; g[i * 4 + 2] = 128; g[i * 4 + 3] = 255; } return g; })() : t.rgba;
    const small: RgbaImage8 = resizeRgba({ width: t.width, height: t.height, rgba: sent }, sw, sh);
    const { padded, offset } = padToModelAspect(small);
    const ref = opts.reference ? (() => { const rs = Math.min(1, 768 / Math.max(opts.reference.width, opts.reference.height)); const r = resizeRgba({ width: opts.reference.width, height: opts.reference.height, rgba: opts.reference.rgba }, Math.max(8, Math.round(opts.reference.width * rs)), Math.max(8, Math.round(opts.reference.height * rs))); return new Uint8Array(encodePng(r.width, r.height, Buffer.from(r.rgba), 4)); })() : undefined;
    const prompt = buildTexturePlatePrompt({ locationName: opts.locationName, widthM: t.width * f.pixel, heightM: t.height * f.pixel, widthPx: padded.width, heightPx: padded.height, preserveClause: preserveClause(padded.width, padded.height), withReference: !!ref, ...(sv ? { withStreetView: true } : {}), ...(unseen ? { unseen: true } : {}) });
    const svRec: EnhanceStreetViewRecord | undefined = sv ? { panoId: sv.view.panoId, method: sv.view.registration?.method ?? 'nominal', bandCover: Math.round(sv.rect.bandCover * 1000) / 1000, pxPerM: Math.round(sv.rect.pxPerM * 10) / 10 } : undefined;
    const base = { face: f.index, key: f.key, ...(svRec ? { streetView: svRec } : {}), ...(guards && !sv && opts.noStreetView ? { noStreetView: opts.noStreetView } : {}) };
    const image = new Uint8Array(encodePng(padded.width, padded.height, Buffer.from(padded.rgba), 4));
    const widthM = t.width * f.pixel, heightM = t.height * f.pixel;
    const request: PlateRequest = { prompt, image, width: padded.width, height: padded.height, ...(ref ? { reference: ref } : {}), ...(sv ? { streetView: sv.crop } : {}), models: opts.models, ...(opts.signal ? { signal: opts.signal } : {}) };
    const strong = !!opts.fit && opts.fit.tileNcc >= STRONG_FIT_NCC && !unseen;
    const countGate: RedrawWallRecord['countGate'] = strong ? 'lattice' : opts.counter ? 'vision' : 'none';
    const samples = Math.max(1, opts.samples ?? SAMPLES);
    opts.onProgress?.(`wall ${f.index}: drawing ${samples} plates at once (${countGate === 'lattice' ? 'storeys and bays read against F\'s lattice' : countGate === 'vision' ? 'storeys and bays counted by the vision model' : 'storeys and bays not counted'})`);

    // the samples, all at once; each gated on its own as soon as it is in
    const gateOne = async (k: number): Promise<SampleRecord & { aligned?: Uint8Array; guarded?: Uint8Array; weight?: Float32Array; labels?: string[]; grid?: RedrawWallRecord['grid']; svNumbers?: Partial<EnhanceStreetViewRecord> }> => {
        const ts = Date.now();
        let answer: PlateAnswer & { cached?: boolean };
        try {
            answer = await opts.governor.run(() => cachedPlate(opts.cacheDir ? path.join(opts.cacheDir, `sample${k}`) : undefined, request, opts.client), opts.signal);
            opts.governor.noteSuccess();
        } catch (err) {
            if (opts.signal?.aborted) throw err;
            return { sample: k, rejected: `the model did not answer (${(err as Error).message.slice(0, 160)})`, ms: Date.now() - ts };
        }
        let dec: RgbaImage8;
        try { dec = decodeImageInMemory(answer.bytes); } catch (err) { return { sample: k, model: answer.modelUsed, rejected: `the answer cannot be decoded (${(err as Error).message})`, ms: Date.now() - ts }; }
        const full = resizeRgba(dec, padded.width, padded.height);
        const inner = new Uint8Array(sw * sh * 4);
        for (let y = 0; y < sh; y++) inner.set(full.rgba.subarray(((offset[1] + y) * full.width + offset[0]) * 4, ((offset[1] + y) * full.width + offset[0] + sw) * 4), y * sw * 4);
        const back = resizeRgba({ width: sw, height: sh, rgba: inner }, t.width, t.height).rgba;
        const alignable = !unseen || coveredShare >= UNSEEN_MIN_ALIGN_SHARE;
        const g: AlignResult = alignable ? alignPlate(t.rgba, back, t.width, t.height, use, f.pixel) : { dx: 0, dy: 0, scale: 1, chamferPx: 0, lostShare: 0, accepted: true, why: 'not aligned', aligned: back };
        const grossNotMeasured = alignable ? undefined : `the tile covers ${(100 * coveredShare).toFixed(0)}% of the wall, under ${100 * UNSEEN_MIN_ALIGN_SHARE}%: too little to align on`;
        // storeys and bays: F's lattice on a strong-fit wall; the vision count (run now, alongside the other samples') on a weak one
        let counts: { tile?: FacadeCounts; plate?: FacadeCounts; unread?: string } | undefined;
        let lattice: LatticeCheck | undefined;
        if (strong) { lattice = latticeIdentity(g.aligned, f, use, opts.fit!.planned, opts.fit!.tileNcc); counts = { unread: `read locally against F's lattice (${lattice.why})` }; }
        else if (unseen && coveredShare < UNSEEN_MIN_COUNT_SHARE) counts = { unread: `the tile covers ${(100 * coveredShare).toFixed(0)}% of the wall: its storeys and bays cannot be counted on it` };
        else if (opts.counter) {
            const plateSmall = resizeRgba({ width: t.width, height: t.height, rgba: g.aligned }, sw, sh);
            try { counts = await opts.counter(new Uint8Array(encodePng(sw, sh, Buffer.from(small.rgba), 4)), new Uint8Array(encodePng(sw, sh, Buffer.from(plateSmall.rgba), 4)), widthM, heightM); }
            catch (err) { if (opts.signal?.aborted) throw err; counts = { unread: `the count could not be read: ${(err as Error).message.slice(0, 120)}` }; }
        } else counts = { unread: 'no vision model to count with' };
        const colourAgainst = unseen?.familyLab && coveredShare < UNSEEN_MIN_COLOUR_SHARE ? unseen.familyLab : undefined;
        const idg = identityGate(t.rgba, g.aligned, t.width, t.height, use, { askedAspect: padded.width / padded.height, answeredAspect: dec.width / dec.height, chamferPx: g.chamferPx, lostShare: g.lostShare, counts, ...(grossNotMeasured ? { grossNotMeasured } : {}), ...(colourAgainst ? { colourAgainst } : {}) });
        if (lattice && !lattice.passed) { idg.passed = false; idg.why = `${idg.why}; ${lattice.why}`; }
        if (unseen) {
            const grey = unseenGreyShare(g.aligned, use, N, unseen.inside);
            if (grey > UNSEEN_MAX_GREY_SHARE) { idg.passed = false; idg.why = `${idg.why}; ${(100 * grey).toFixed(0)}% of the unseen part left flat mid-grey (more than ${100 * UNSEEN_MAX_GREY_SHARE}%)`; }
        }
        const rec: SampleRecord & { aligned?: Uint8Array } = { sample: k, model: answer.modelUsed, ...(answer.cached ? { cached: true } : {}), chamferPx: g.chamferPx, lostShare: g.lostShare, identity: identityRecord(idg), ...(lattice ? { lattice } : {}), counts, ms: 0, aligned: g.aligned };
        if (!idg.passed) return { ...rec, rejected: `not the same wall: ${idg.why}`, ms: Date.now() - ts };
        if (!guards) return { ...rec, ms: Date.now() - ts };
        const gp = guardPlate(t.rgba, g.aligned, t.width, t.height, use, f.pixel, sv ? { rect: sv.rect, bandTop: streetBandTop(f) } : undefined);
        const svNumbers = gp.photo ? { shiftPx: gp.photo.shiftPx, nccPlate: gp.photo.nccPlate, nccInput: gp.photo.nccInput, comparedCells: gp.photo.comparedCells, supportedCells: gp.photo.supportedCells, contradictedCells: gp.photo.contradictedCells } : undefined;
        const photoSupport = gp.photo && gp.photo.comparedCells > 0 ? (gp.photo.supportedCells - gp.photo.contradictedCells) / gp.photo.comparedCells : undefined;
        const fg = featureGuard(t.rgba, g.aligned, t.width, t.height, use, f.pixel, opts.features ?? [], sv ? { rgba: sv.rect.rgba, valid: sv.rect.valid } : undefined);
        const out = { ...rec, audit: gp.audit, features: fg.regions, ...(photoSupport !== undefined ? { photoSupport } : {}), guarded: gp.rgba, weight: gp.weight, labels: gp.labels, grid: gp.grid, ...(svNumbers ? { svNumbers } : {}), ms: Date.now() - ts };
        if (gp.reject) return { ...out, rejected: gp.why };
        if (!fg.kept) return { ...out, rejected: fg.why };
        return out;
    };
    const settled = await Promise.all(Array.from({ length: samples }, (_, k) => gateOne(k)));
    const scores: CandidateScore[] = settled.map(s => ({ sample: s.sample, eligible: !s.rejected, why: s.rejected ?? 'eligible', ...(s.lattice ? { latticeNcc: s.lattice.latticeNcc } : {}), ...(s.photoSupport !== undefined ? { photoSupport: s.photoSupport } : {}), ...(s.audit ? { flaggedShare: s.audit.flaggedShare } : {}), ...(s.chamferPx !== undefined ? { chamferPx: s.chamferPx } : {}) }));
    const pick = pickCandidate(scores);
    const records: SampleRecord[] = settled.map(s => { const r = pick.ranked.find(x => x.sample === s.sample); const { aligned: _a, guarded: _g, weight: _w, labels: _l, grid: _gr, svNumbers: _s, ...rest } = s; return { ...rest, ...(r && Number.isFinite(r.rank) ? { rank: Math.round(r.rank * 1000) / 1000 } : {}) }; });
    const describe = records.map(r => `sample ${r.sample}: ${r.rejected ?? `eligible (rank ${r.rank ?? 0})`}`).join(' | ');
    if (!pick.chosen) return { ...base, accepted: false, why: `none of ${samples} plates passed: ${describe}`, samples: records, countGate, ms: Date.now() - t0 };
    const best = settled.find(s => s.sample === pick.chosen!.sample)!;
    if (svRec && best.svNumbers) Object.assign(svRec, best.svNumbers);
    const outRgba = guards && best.guarded ? best.guarded : best.aligned!;
    const weight = guards ? best.weight : undefined;
    const src = sv && opts.streetViewSource !== undefined ? opts.streetViewSource : opts.source;
    for (let i = 0; i < N; i++) {
        t.rgba[i * 4] = outRgba[i * 4]; t.rgba[i * 4 + 1] = outRgba[i * 4 + 1]; t.rgba[i * 4 + 2] = outRgba[i * 4 + 2]; t.rgba[i * 4 + 3] = 255;
        if (!weight || weight[i] < 0.5) t.source[i] = unseen && !use[i] ? unseen.source : src;
    }
    const why = `${unseen ? `a wall the tile hardly sees (${(100 * coveredShare).toFixed(0)}% covered), drawn as it continues (${TEXTURE_PLATE_UNSEEN_PROMPT_ID}); ` : ''}sample ${best.sample} of ${samples} chosen by the local numbers (${describe})`;
    return {
        ...base, accepted: true, why, model: best.model, chosen: best.sample, samples: records, countGate, chamferPx: best.chamferPx, lostShare: best.lostShare, identity: best.identity, ...(best.audit ? { audit: best.audit } : {}),
        plate: best.aligned, guarded: best.guarded, labels: best.labels, grid: best.grid, ms: Date.now() - t0
    };
}
