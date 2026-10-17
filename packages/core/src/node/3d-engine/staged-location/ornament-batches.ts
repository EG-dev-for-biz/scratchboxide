/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The wide facade-detail reading, split into small batches read in parallel.
 *
 * Why: the reading was one combined call per building. On the live Washington Square Arch it sent 22 images (6 tile
 * orthos, 16 Street View close-ups of 960-1920 px, 24.3 MP) and a 68k-character text (40 offered slots, their outlines in
 * every close-up, a 4.1k-character reply schema): about 85k prompt tokens per call. gemini-4-argon at thinking LOW took
 * 32-75 s to its first token and 137-171 s for the reading and its revision (every live reading needed one), and the
 * focused run readings came after it inside the same 250 s stage limit, so the stage ran out and its finished reading
 * was lost with it.
 *
 * Here each batch is the slots of one fitted face (edge slots go with their first face), at most 12 of them, with only
 * the images that show them: a greedy cover picks at most 6, every slot seen once, then a second view where one helps.
 * Street View close-ups wider than 1280 px are downscaled first (the image's metres per pixel grows with it, so the
 * resolvability check stays honest). Each batch is a normal reading (readOrnament: the same prompt and checks, its own
 * revision, a stall watch with one retry) with fewer output elements and only its own primitives' correctable values.
 * The batches run at once under one budget; the results merge into the one OrnamentSpec the rest of the pipeline reads.
 *
 * A batch that fails (stalls twice, times out, runs out of the budget, invalid twice) is reported with its reason and
 * its slots stay flat; the other batches stand. Nothing is filled in for it. Only when every batch fails does the
 * reading fail.
 */

import * as crypto from 'crypto';
import type { EvidenceImageRef, OrnamentSlot, OrnamentSpec, PrimitiveCorrection, StructureFit, VisionModelUse } from '../../../common/spatial/staged-location-contracts';
import { decodeImageToRgba, encodeRgbaToJpeg } from '../../image-codec-ffmpeg';
import type { AnchorNote } from './ornament-anchor';
import {
    readOrnament, streetViewCaption, visionUse, VisionStageError, MIN_SLOT_VISIBLE_FRACTION,
    type EvidenceInput, type OrnamentReading, type ReadOrnamentInput
} from './ornament-vision';
import type { SlotOffer } from './slot-exposure';

/** Images one batch sends at most. */
export const ORNAMENT_BATCH_MAX_IMAGES = 6;
/** Slots one batch asks about at most. */
export const ORNAMENT_BATCH_MAX_SLOTS = 12;
/** Batches aimed for: when the faces give more, small groups are merged (within the slot cap) down to this before images are picked. */
export const ORNAMENT_MAX_BATCHES = 8;
/** "At most N in all" for one batch (the combined reading asked for 60 over every slot). */
export const ORNAMENT_BATCH_MAX_ELEMENTS = 24;
/** A batch's reply is at most 24 compact elements: about 3k tokens (the live combined replies were 10-13 KB). */
export const ORNAMENT_BATCH_MAX_OUTPUT_TOKENS = 8_192;
/** Hard limit on one batch call. */
export const ORNAMENT_BATCH_TIMEOUT_MS = 100_000;
/** The whole batched reading: no batch call, retry or revision outlives it. */
export const ORNAMENT_PASS_BUDGET_MS = 180_000;
/** The pass's own abort comes this long after the deadline its calls are held to. */
const BUDGET_BACKSTOP_MS = 2_000;
/** Street View close-ups are downscaled to this longest side before they are sent. */
export const ORNAMENT_IMAGE_MAX_SIDE_PX = 1280;

export interface OrnamentBatchPlan {
    id: string;
    slotIds: string[];
    /** Indexes into the full evidence list (its `ref.index`). */
    imageIndexes: number[];
}

export interface OrnamentBatchReport {
    id: string;
    slotIds: string[];
    imageIds: string[];
    status: 'answered' | 'failed';
    calls: number;
    retries: number;
    ms: number;
    elements: number;
    revised: boolean;
    reason?: string;
    reasonCode?: string;
    transient?: boolean;
    model?: VisionModelUse;
}

export interface BatchedOrnamentReading extends OrnamentReading {
    batches: OrnamentBatchReport[];
    /** Offered slots no image shows (not asked about). */
    unshown: string[];
    /** Close-ups sent smaller than they arrived. */
    downscaled: Array<{ imageId: string; fromPx: [number, number]; toPx: [number, number] }>;
}

export interface BatchLimits {
    maxImages?: number;
    maxSlots?: number;
    maxBatches?: number;
}

/** The fitted face a slot belongs to: its surface, or an edge's first surface. Geometry only; never a slot's name. */
function faceOf(slot: OrnamentSlot): string {
    return 'surface' in slot.host ? slot.host.surface.surfaceId : slot.host.edge.surfaceIds[0] ?? slot.id;
}

/** The images that show each slot, with how much of it: from the offer when there is one, else from the slot outlines. */
function viewsOf(fit: Pick<StructureFit, 'slots'>, refs: EvidenceImageRef[], offer?: SlotOffer): Map<string, Map<number, number>> {
    const out = new Map<string, Map<number, number>>();
    for (const s of fit.slots) {
        if (offer && !offer.offeredIds.has(s.id)) continue;
        const images = offer
            ? (offer.entries.find(e => e.slotId === s.id)?.images ?? [])
            : refs.flatMap(r => { const x = r.slotsShown.find(y => y.slotId === s.id); return x && x.visibleFraction > 0 ? [{ index: r.index, visibleFraction: x.visibleFraction }] : []; });
        out.set(s.id, new Map(images.map(i => [i.index, i.visibleFraction])));
    }
    return out;
}

/**
 * Splits the offered slots into batches: by fitted face, at most `maxSlots` per batch, small ones merged toward `maxBatches`,
 * each with at most `maxImages` images picked to show every one of its slots (a slot the cap leaves unseen starts another batch).
 */
export function planOrnamentBatches(fit: Pick<StructureFit, 'slots'>, refs: EvidenceImageRef[], offer?: SlotOffer, limits: BatchLimits = {}): { batches: OrnamentBatchPlan[]; unshown: string[] } {
    const maxImages = Math.max(1, limits.maxImages ?? ORNAMENT_BATCH_MAX_IMAGES);
    const maxSlots = Math.max(1, limits.maxSlots ?? ORNAMENT_BATCH_MAX_SLOTS);
    const maxBatches = Math.max(1, limits.maxBatches ?? ORNAMENT_MAX_BATCHES);
    const views = viewsOf(fit, refs, offer);
    const slots = fit.slots.filter(s => views.has(s.id));
    const unshown = slots.filter(s => views.get(s.id)!.size === 0).map(s => s.id);
    const byFace = new Map<string, string[]>();
    for (const s of slots) if (views.get(s.id)!.size) byFace.set(faceOf(s), [...(byFace.get(faceOf(s)) ?? []), s.id]);
    const groups: string[][] = [];
    for (const ids of byFace.values()) for (let i = 0; i < ids.length; i += maxSlots) groups.push(ids.slice(i, i + maxSlots));
    const imagesOf = (ids: string[]) => new Set(ids.flatMap(id => [...views.get(id)!.keys()]));
    // more faces than batches: the smallest group joins the one it shares the most images with (then the smallest), as long as
    // the two stay within the slot cap; when no pair fits, the batches stay as they are (the cap on slots is the harder one)
    while (groups.length > maxBatches) {
        groups.sort((a, b) => a.length - b.length);
        const small = groups[0];
        const mine = imagesOf(small);
        let best = -1, bestShared = -1;
        for (let k = 1; k < groups.length; k++) {
            if (groups[k].length + small.length > maxSlots) continue;
            const shared = [...imagesOf(groups[k])].filter(i => mine.has(i)).length;
            if (shared > bestShared || (shared === bestShared && groups[k].length < groups[best].length)) { best = k; bestShared = shared; }
        }
        if (best < 0) break;
        groups[best] = [...groups[best], ...small];
        groups.shift();
    }
    const order = new Map(fit.slots.map((s, i) => [s.id, i]));
    const batches: OrnamentBatchPlan[] = [];
    const queue = groups.map(g => [...g].sort((a, b) => order.get(a)! - order.get(b)!));
    while (queue.length) {
        const ids = queue.shift()!;
        const seen = new Map(ids.map(id => [id, 0]));
        const chosen: number[] = [];
        const candidates = [...imagesOf(ids)].sort((a, b) => a - b);
        // every slot seen once, then a second view where the cap allows (depth is judged better from two)
        for (const need of [1, 2]) {
            while (chosen.length < maxImages) {
                let bestIdx = -1, bestGain = 0;
                for (const idx of candidates) {
                    if (chosen.includes(idx)) continue;
                    let gain = 0;
                    for (const id of ids) if (seen.get(id)! < need) gain += views.get(id)!.get(idx) ?? 0;
                    if (gain > bestGain + 1e-9) { bestGain = gain; bestIdx = idx; }
                }
                if (bestIdx < 0) break;
                chosen.push(bestIdx);
                for (const id of ids) if (views.get(id)!.has(bestIdx)) seen.set(id, seen.get(id)! + 1);
            }
        }
        const covered = ids.filter(id => seen.get(id)! > 0), left = ids.filter(id => seen.get(id)! === 0);
        if (covered.length) batches.push({ id: `b${batches.length}`, slotIds: covered, imageIndexes: chosen.sort((a, b) => a - b) });
        if (left.length) queue.push(left);
    }
    return { batches, unshown };
}

/** An area-average downscale of RGBA8 to `w` × `h`. */
function downscaleRgba(src: Buffer, sw: number, sh: number, w: number, h: number): Buffer {
    const out = Buffer.alloc(w * h * 4);
    const fx = sw / w, fy = sh / h;
    for (let y = 0; y < h; y++) {
        const y0 = Math.floor(y * fy), y1 = Math.max(y0 + 1, Math.min(sh, Math.floor((y + 1) * fy)));
        for (let x = 0; x < w; x++) {
            const x0 = Math.floor(x * fx), x1 = Math.max(x0 + 1, Math.min(sw, Math.floor((x + 1) * fx)));
            let r = 0, g = 0, b = 0, a = 0, n = 0;
            for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
                const o = (yy * sw + xx) * 4;
                r += src[o]; g += src[o + 1]; b += src[o + 2]; a += src[o + 3]; n++;
            }
            const o = (y * w + x) * 4;
            out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n); out[o + 2] = Math.round(b / n); out[o + 3] = Math.round(a / n);
        }
    }
    return out;
}

/**
 * Street View close-ups whose longest side passes `maxSidePx`, sent smaller: the reference records the size sent, its
 * hash, and the coarser metres per pixel (so rule 10 judges what the model was shown). A close-up that cannot be
 * re-encoded is sent as it came.
 */
export async function downscaleEvidence(evidence: EvidenceInput[], maxSidePx = ORNAMENT_IMAGE_MAX_SIDE_PX): Promise<{ evidence: EvidenceInput[]; downscaled: BatchedOrnamentReading['downscaled'] }> {
    const downscaled: BatchedOrnamentReading['downscaled'] = [];
    const out = await Promise.all(evidence.map(async e => {
        const r = e.ref;
        const long = Math.max(r.widthPx, r.heightPx);
        if (r.kind !== 'streetview-grounding' || long <= maxSidePx) return e;
        try {
            const img = await decodeImageToRgba(e.bytes);
            const s = maxSidePx / Math.max(img.width, img.height);
            const w = Math.max(1, Math.round(img.width * s)), h = Math.max(1, Math.round(img.height * s));
            const bytes = await encodeRgbaToJpeg(downscaleRgba(img.rgba, img.width, img.height, w, h), w, h, { quality: 92 });
            const ref: EvidenceImageRef = { ...r, widthPx: w, heightPx: h, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), nativeSampleM: r.nativeSampleM * (img.width / w) };
            downscaled.push({ imageId: r.id, fromPx: [img.width, img.height], toPx: [w, h] });
            return { ref, bytes, mimeType: 'image/jpeg', caption: streetViewCaption(ref) };
        } catch {
            return e;
        }
    }));
    return { evidence: out, downscaled };
}

async function pool<T, R>(items: T[], n: number, fn: (x: T, k: number) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
        for (;;) {
            const i = next++;
            if (i >= items.length) return;
            out[i] = await fn(items[i], i);
        }
    }));
    return out;
}

export interface ReadOrnamentBatchedInput extends Omit<ReadOrnamentInput, 'focus' | 'scope' | 'deadlineAt'> {
    /** The whole reading's budget (default ORNAMENT_PASS_BUDGET_MS). */
    budgetMs?: number;
    /** Batches read at once (default: all). */
    concurrency?: number;
    limits?: BatchLimits;
    /** Close-ups are downscaled to this longest side (default ORNAMENT_IMAGE_MAX_SIDE_PX). */
    maxSidePx?: number;
}

/** The images of one batch, indexed from 0 as its prompt cites them. */
function localEvidence(all: EvidenceInput[], plan: OrnamentBatchPlan): { evidence: EvidenceInput[]; toLocal: Map<number, number> } {
    const toLocal = new Map<number, number>();
    const evidence = plan.imageIndexes.map((g, k) => {
        toLocal.set(g, k);
        const e = all.find(x => x.ref.index === g)!;
        return { ...e, ref: { ...e.ref, index: k }, caption: e.caption.replace(/^\[\d+\]/, `[${k}]`) };
    });
    return { evidence, toLocal };
}

/** The offer as one batch sees it: its own slots, with only its own images (locally indexed). */
function localOffer(offer: SlotOffer, plan: OrnamentBatchPlan, toLocal: Map<number, number>): SlotOffer {
    const mine = new Set(plan.slotIds);
    return {
        ...offer,
        entries: offer.entries.filter(e => mine.has(e.slotId)).map(e => ({ ...e, images: e.images.flatMap(i => toLocal.has(i.index) ? [{ index: toLocal.get(i.index)!, visibleFraction: i.visibleFraction }] : []) })),
        offeredIds: mine
    };
}

/** An offer judged from the slot outlines alone, when the caller gives none. */
function offerFromRefs(fit: Pick<StructureFit, 'slots'>, refs: EvidenceImageRef[]): SlotOffer {
    const entries = fit.slots.map(s => {
        const images = refs.flatMap(r => { const x = r.slotsShown.find(y => y.slotId === s.id); return x && x.visibleFraction >= MIN_SLOT_VISIBLE_FRACTION ? [{ index: r.index, visibleFraction: x.visibleFraction }] : []; });
        return { slotId: s.id, images, offered: images.length > 0, ...(images.length ? {} : { why: 'no image shows it' }) };
    });
    return { entries, offeredIds: new Set(entries.filter(e => e.offered).map(e => e.slotId)), covers: new Map(), hidden: 0, unseen: entries.filter(e => !e.offered).length, exposureJudged: false };
}

/**
 * The wide reading in batches (see the file comment). Throws VisionStageError only when no batch gives a usable reply;
 * a stop by the caller's signal is rethrown as it came.
 */
export async function readOrnamentBatched(input: ReadOrnamentBatchedInput): Promise<BatchedOrnamentReading> {
    const { fit, chain } = input;
    const clock = input.now ?? Date.now;
    const started = clock();
    const budgetMs = input.budgetMs ?? ORNAMENT_PASS_BUDGET_MS;
    const deadlineAt = started + budgetMs;
    const { evidence: all, downscaled } = await downscaleEvidence(input.evidence, input.maxSidePx ?? ORNAMENT_IMAGE_MAX_SIDE_PX);
    const refs = all.map(e => e.ref);
    const offer = input.offer ?? offerFromRefs(fit, refs);
    const plan = planOrnamentBatches(fit, refs, offer, input.limits);
    if (!plan.batches.length) {
        const why = `no image shows any of the ${offer.offeredIds.size} offered slots`;
        throw new VisionStageError(why, visionUse(chain, 'failed', { ms: 0, error: why }), false, 'vision_unavailable');
    }
    const located = input.located ?? [];
    const n = plan.batches.length;
    input.onProgress?.(`reading ${refs.length} photos in ${n} batch${n === 1 ? '' : 'es'} of at most ${input.limits?.maxImages ?? ORNAMENT_BATCH_MAX_IMAGES} with ${chain.current}, at once`);
    // each batch's calls are cut at the deadline by their own limit (so a revision cut there leaves the first reply standing);
    // this is the backstop for anything that does not end with them
    const budget = new AbortController();
    const budgetTimer = setTimeout(() => budget.abort(Object.assign(new Error(`the reading's ${Math.round(budgetMs / 1000)} s budget ran out`), { name: 'TimeoutError' })), budgetMs + BUDGET_BACKSTOP_MS);
    const signal = input.signal ? AbortSignal.any([input.signal, budget.signal]) : budget.signal;
    type Done = { plan: OrnamentBatchPlan; evidence: EvidenceInput[]; reading?: OrnamentReading; failure?: VisionStageError | Error; calls: number; retries: number; ms: number };
    let results: Done[];
    try {
        results = await pool(plan.batches, input.concurrency ?? n, async (b, k): Promise<Done> => {
            const t0 = clock();
            const { evidence, toLocal } = localEvidence(all, b);
            const slots = new Set(b.slotIds);
            let calls = 0, retries = 0;
            try {
                const reading = await readOrnament({
                    fit, fitSha256: input.fitSha256, evidence, chain, signal, deadlineAt,
                    timeoutMs: input.timeoutMs ?? ORNAMENT_BATCH_TIMEOUT_MS, maxOutputTokens: input.maxOutputTokens ?? ORNAMENT_BATCH_MAX_OUTPUT_TOKENS,
                    ...(input.firstTokenStallMs !== undefined ? { firstTokenStallMs: input.firstTokenStallMs } : {}),
                    ...(input.stallMs !== undefined ? { stallMs: input.stallMs } : {}),
                    ...(input.stallRetries !== undefined ? { stallRetries: input.stallRetries } : {}),
                    ...(input.now ? { now: input.now } : {}),
                    located: located.filter(l => slots.has(l.slotId)), offer: localOffer(offer, b, toLocal),
                    scope: { maxElements: ORNAMENT_BATCH_MAX_ELEMENTS, correctablePrimitiveIds: new Set(fit.slots.flatMap(s => slots.has(s.id) && s.primitiveId ? [s.primitiveId] : [])) },
                    onCall: () => { calls++; }, onRetry: () => { retries++; },
                    onProgress: m => input.onProgress?.(`batch ${k + 1} of ${n} (${b.slotIds.length} slots, ${evidence.length} images): ${m}`)
                });
                return { plan: b, evidence, reading, calls, retries, ms: clock() - t0 };
            } catch (err) {
                if (input.signal?.aborted) throw err;
                const failure = budget.signal.aborted
                    ? new VisionStageError(`${(budget.signal.reason as Error).message} before this batch answered`, err instanceof VisionStageError ? err.model : visionUse(chain, 'failed', { ms: clock() - t0 }), true, 'vision_timeout')
                    : (err as Error);
                return { plan: b, evidence, failure, calls, retries, ms: clock() - t0 };
            }
        });
    } finally {
        clearTimeout(budgetTimer);
    }
    return mergeBatches(input, results, plan.unshown, downscaled, all, started, clock);
}

function mergeBatches(
    input: ReadOrnamentBatchedInput,
    results: Array<{ plan: OrnamentBatchPlan; evidence: EvidenceInput[]; reading?: OrnamentReading; failure?: Error; calls: number; retries: number; ms: number }>,
    unshown: string[], downscaled: BatchedOrnamentReading['downscaled'], all: EvidenceInput[], started: number, clock: () => number
): BatchedOrnamentReading {
    const { chain } = input;
    const reports: OrnamentBatchReport[] = results.map(r => {
        const base = { id: r.plan.id, slotIds: r.plan.slotIds, imageIds: r.evidence.map(e => e.ref.id), calls: r.calls, retries: r.retries, ms: r.ms };
        if (r.reading) return { ...base, status: 'answered' as const, elements: 0, revised: r.reading.spec.revision.passes === 1, model: r.reading.spec.model };
        const f = r.failure!;
        return {
            ...base, status: 'failed' as const, elements: 0, revised: false, reason: f.message,
            reasonCode: f instanceof VisionStageError ? f.reasonCode : 'vision_unavailable', transient: f instanceof VisionStageError ? f.transient : true,
            ...(f instanceof VisionStageError ? { model: f.model } : {})
        };
    });
    const answered = results.filter(r => r.reading);
    const calls = results.reduce((s, r) => s + r.calls, 0);
    if (!answered.length) {
        // one batch: its own failure, as a single reading reports it
        const only = results.length === 1 ? results[0].failure : undefined;
        if (only instanceof VisionStageError) throw Object.assign(only, { batches: reports, calls });
        const why = `every batch of the reading failed (${reports.map(b => `${b.id}: ${b.reason}`).join('; ')})`;
        const firstModel = reports.find(b => b.model)?.model;
        throw Object.assign(new VisionStageError(why, visionUse(chain, 'failed', { ms: clock() - started, error: why, ...(firstModel ? { thinking: firstModel.thinking } : {}) }), reports.some(b => b.transient), reports[0].reasonCode ?? 'vision_unavailable'), { batches: reports, calls });
    }
    // the images sent, once each, indexed as the merged spec lists them (elements cite images by id)
    const sentIds = new Set(results.flatMap(r => r.evidence.map(e => e.ref.id)));
    const evidence: EvidenceImageRef[] = all.filter(e => sentIds.has(e.ref.id)).map((e, k) => ({ ...e.ref, index: k }));
    const elements: OrnamentSpec['elements'] = [];
    const supportTestRequired: string[] = [];
    const dropped: OrnamentReading['dropped'] = [];
    const anchored: AnchorNote[] = [];
    const accepted: Array<{ c: PrimitiveCorrection; batch: string }> = [];
    const rejectedCorrections: PrimitiveCorrection[] = [];
    const emptySlots: OrnamentSpec['emptySlots'] = [];
    const problems: string[] = [];
    const replies: string[] = [];
    let passes: 0 | 1 = 0;
    for (const r of answered) {
        const reading = r.reading!, b = r.plan, mine = new Set(b.slotIds);
        const rename = (id: string) => `${b.id}.${id}`;
        const report = reports.find(x => x.id === b.id)!;
        for (const e of reading.spec.elements) {
            // a batch is asked about its own slots only: an element it put on another batch's slot is not checked against that batch's
            // elements (overlaps are judged per slot), so it is dropped, with the reason
            if (!mine.has(e.slotId)) {
                dropped.push({ elementId: rename(e.id), slotId: e.slotId, by: 'validator', problems: [`slot ${e.slotId} was not one of the slots offered to batch ${b.id} (${b.slotIds.join(', ')})`], reasonCode: 'slot_not_offered' });
                continue;
            }
            elements.push({ ...e, id: rename(e.id) });
            report.elements++;
        }
        const keptIds = new Set(elements.map(e => e.id));
        for (const id of reading.supportTestRequired) if (keptIds.has(rename(id))) supportTestRequired.push(rename(id));
        for (const d of reading.dropped) dropped.push({ ...d, elementId: rename(d.elementId) });
        for (const a of reading.anchored) anchored.push({ ...a, elementId: rename(a.elementId) });
        for (const c of reading.spec.corrections) accepted.push({ c, batch: b.id });
        rejectedCorrections.push(...reading.rejectedCorrections);
        for (const s of reading.spec.emptySlots) if (mine.has(s.slotId)) emptySlots.push(s);
        if (reading.spec.revision.passes === 1) passes = 1;
        problems.push(...reading.spec.revision.problems.map(p => `${b.id}: ${p}`));
        replies.push(...reading.replies);
    }
    // two batches can read the same correctable value (a primitive's slots on two faces): the more confident one stands
    const corrections: PrimitiveCorrection[] = [];
    for (const { c, batch } of accepted) {
        const rival = accepted.find(x => x.c !== c && x.c.primitiveId === c.primitiveId && x.c.param === c.param && (x.c.confidence > c.confidence || (x.c.confidence === c.confidence && accepted.indexOf(x) < accepted.findIndex(y => y.c === c))));
        if (rival) rejectedCorrections.push({ ...c, check: { ...c.check, accepted: false, why: `batch ${rival.batch} read the same value (${c.primitiveId} param ${c.param}) with higher confidence; batch ${batch}'s reading is not applied` } });
        else corrections.push(c);
    }
    const models = answered.map(r => r.reading!.spec.model);
    const sum = (k: 'promptTokens' | 'outputTokens' | 'thinkingTokens') => models.reduce((s, m) => s + (m[k] ?? 0), 0);
    const ttfts = models.map(m => m.ttftMs).filter((v): v is number => v !== undefined);
    const finish = models.find(m => m.finishReason && m.finishReason !== 'STOP')?.finishReason ?? models.find(m => m.finishReason)?.finishReason;
    const model = visionUse(chain, 'answered', {
        // the reading's wall time: the batches ran at once
        ms: clock() - started, ...(ttfts.length ? { ttftMs: Math.min(...ttfts) } : {}),
        promptTokens: sum('promptTokens'), outputTokens: sum('outputTokens'), thinkingTokens: sum('thinkingTokens'),
        ...(finish ? { finishReason: finish } : {}), thinking: models[0].thinking
    });
    const first = answered[0].reading!.spec;
    const spec: OrnamentSpec = {
        ...first,
        evidence, elements, corrections, emptySlots, model,
        revision: { passes, problems },
        dropped: dropped.map(d => ({ elementId: d.elementId, slotId: d.slotId, by: d.by, problems: d.problems }))
    };
    return {
        spec, replies, supportTestRequired, dropped, rejectedCorrections, anchored, calls,
        retries: reports.reduce((s, b) => s + b.retries, 0), batches: reports, unshown, downscaled
    };
}
