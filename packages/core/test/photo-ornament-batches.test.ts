/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The wide facade-detail reading split into batches (ornament-batches.ts): how the slots and images are split (by fitted
 * face, at most 6 images and 12 slots a batch, every slot shown by an image of its batch, on the synthetic fit and on the
 * real arch fit), that the batches run at once, that a stalled stream is caught and asked again, that one batch which
 * stalls or runs out of the budget does not sink the others and is reported (its slots stay flat, nothing is invented for
 * them), that a revision that does not come leaves the first reply standing, the downscaled close-ups, and that thinking
 * LOW reaches the request body the SDK sends. A fake model that READS ITS PROMPT, a local HTTP stand-in for the API; no
 * billed call.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as http from 'http';
import { GoogleGenAI } from '@google/genai';
import {
    downscaleEvidence, planOrnamentBatches, readOrnamentBatched, ORNAMENT_BATCH_MAX_IMAGES, ORNAMENT_BATCH_MAX_OUTPUT_TOKENS, ORNAMENT_BATCH_MAX_SLOTS,
    ORNAMENT_PASS_BUDGET_MS
} from '../src/node/3d-engine/staged-location/ornament-batches';
import { orthoCaption, orthoRef, streetViewCaption, ORNAMENT_THINKING_BUDGET, type EvidenceInput } from '../src/node/3d-engine/staged-location/ornament-vision';
import { STAGES, VISION_RUNS_ALLOWANCE_MS, VISION_STAGE_MARGIN_MS } from '../src/node/3d-engine/staged-location/orchestrator';
import { RUN_PASS_BUDGET_MS } from '../src/node/3d-engine/staged-location/run-reading';
import { thinkingConfigFor } from '../src/node/gemini/thinking-config';
import { VisionModelChain, type VisionGenAIClient } from '../src/node/gemini/vision-model-chain';
import { STAGED_VISION_MODEL_DEFAULT, validateContract, type CompactElement, type EvidenceImageRef, type StructureFit } from '../src/common/spatial/staged-location-contracts';
import { structureFit } from './helpers/staged-location-fixtures';
import { findArchFit } from './helpers/real-arch-data';
import { bandJpeg, GREY, SKY, STONE } from './helpers/photo-ornament-fixtures';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000100000001008060000001ff3ff61', 'hex');
const JPG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffc00011080300040003012200021101031101ffd9', 'hex');

/** The north face's ortho (S01, S02 on it) and one close-up showing S02 (north cornice) and S03 (the soffit, another face). */
function evidence(f: StructureFit, sv: Partial<EvidenceImageRef> = {}, svBytes = JPG): EvidenceInput[] {
    const ortho = orthoRef({ id: 'ortho:s00', surfaceId: 's00', path: 'x.png', widthPx: 526, heightPx: 488, gsdM: 0.05, texelM: 0.154, originUv: [0, 24.4], slotsDrawn: ['S01', 'S02'], sha256: '' }, 0, f, PNG);
    const ref: EvidenceImageRef = {
        id: 'sv:PANO1:180:15:42', index: 1, kind: 'streetview-grounding', widthPx: 1024, heightPx: 768, sha256: 'c'.repeat(64), nativeSampleM: 0.021,
        panoId: 'PANO1', captureDate: '2025-06', copyright: '© Google', headingDeg: 180, pitchDeg: 15, fovDeg: 42, distanceM: 29.4,
        pose: { eye: [0, 2.5, -34], registered: false, uncertaintyM: 2, uncertaintyDeg: 2 },
        slotsShown: [
            { slotId: 'S02', polygon1000: [130, 50, 130, 950, 220, 950, 220, 50], visibleFraction: 0.92 },
            { slotId: 'S03', polygon1000: [400, 250, 400, 750, 820, 750, 820, 250], visibleFraction: 0.7 }
        ],
        ...sv
    };
    return [
        { ref: ortho, bytes: PNG, mimeType: 'image/png', caption: orthoCaption(ortho, f) },
        { ref, bytes: svBytes, mimeType: 'image/jpeg', caption: streetViewCaption(ref) }
    ];
}

const textOf = (params: any): string => (params.contents[0].parts as any[]).filter(p => typeof p.text === 'string').map(p => p.text).join('\n');
const imagesOf = (params: any): number => (params.contents[0].parts as any[]).filter(p => p.inlineData).length;
/** The slot ids a prompt offers ("Sxx: surface …" / "Sxx: edge …" lines of its slot table). */
const offeredIn = (text: string): string[] => [...text.matchAll(/^(S\d+): (?:surface|edge) /gm)].map(m => m[1]);
/** The first image index the prompt lists for a slot, of the given kind ("in images [i (n% …)]" and the caption kinds). */
function imageFor(text: string, slot: string, kind: 'ortho' | 'sv'): number | undefined {
    const m = text.match(new RegExp(`^${slot}: .*in images \\[([^\\]]*)\\]`, 'm'));
    const idx = m ? [...m[1].matchAll(/(\d+) \(/g)].map(x => Number(x[1])) : [];
    const isKind = (i: number) => new RegExp(`^\\[${i}\\] ${kind === 'ortho' ? 'Orthographic' : 'Google Street View'}`, 'm').test(text);
    return idx.find(isKind);
}

/** What a reader of the prompt would answer: a roundel on S01 (ortho), a cornice on S02 (close-up), a panel on S03 (close-up). */
function answerFor(text: string): string {
    const els: CompactElement[] = [];
    const offered = offeredIn(text);
    if (offered.includes('S01')) els.push({ slot: 'S01', op: { revolve: { at: [5000, 15000], axis: 'n', profile: [0, 0, 900, 0, 900, 120, 0, 180] } }, conf: 62, depthBasis: 'rim highlight', ev: [[imageFor(text, 'S01', 'ortho')!, 300, 120, 470, 260]] });
    if (offered.includes('S02')) els.push({ slot: 'S02', op: { sweep: { t: [0, 1000], offset: [0, 120], profile: [0, 0, 180, 0, 180, 90, 60, 160, 0, 160] } }, conf: 81, depthBasis: 'shadow line', ev: [[imageFor(text, 'S02', 'sv')!, 140, 60, 210, 940]] });
    if (offered.includes('S03')) els.push({ slot: 'S03', op: { relief: { box: [2000, 2000, 5000, 5000], depth: 60 } }, conf: 58, depthBasis: 'shadow at the edge', ev: [[imageFor(text, 'S03', 'sv')!, 450, 300, 780, 700]] });
    return JSON.stringify({ elements: els, corrections: [], emptySlots: [] });
}

type Behaviour = 'answer' | 'hang' | 'stall-after-first-chunk' | 'trickle' | 'broken';
/** A streaming client that reads each prompt; `how(text, nthCallForThatPrompt)` picks what it does. Records calls and concurrency. */
function promptReader(how: (text: string, nth: number) => Behaviour = () => 'answer', delayMs = 40) {
    const calls: Array<{ text: string; images: number; config: any; startedAt: number }> = [];
    const seen = new Map<string, number>();
    let inFlight = 0, maxInFlight = 0;
    const client: VisionGenAIClient = {
        models: {
            generateContent: async () => { throw new Error('streaming expected'); },
            generateContentStream: async (params: any) => {
                const text = textOf(params);
                const key = offeredIn(text).join(',');
                const nth = seen.get(key) ?? 0;
                seen.set(key, nth + 1);
                calls.push({ text, images: imagesOf(params), config: params.config, startedAt: Date.now() });
                const signal: AbortSignal = params.config.abortSignal;
                const behaviour = how(text, nth);
                const body = behaviour === 'broken'
                    ? JSON.stringify({ elements: [{ slot: 'S01', op: { relief: { box: [0, 0, 1000, 1000], depth: 50 } }, conf: 60, depthBasis: 'x', ev: [[0, 300, 120, 470, 260]] }, ...JSON.parse(answerFor(text)).elements.filter((e: any) => e.slot !== 'S01')], corrections: [], emptySlots: [] })
                    : answerFor(text);
                const never = () => new Promise<never>((_, reject) => { if (signal.aborted) reject(signal.reason); signal.addEventListener('abort', () => reject(signal.reason)); });
                const wait = (ms: number) => new Promise<void>((resolve, reject) => { const t = setTimeout(resolve, ms); signal.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }); });
                inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
                const done = () => { inFlight--; };
                if (behaviour === 'hang') { try { return await never(); } finally { done(); } }
                return (async function* () {
                    try {
                        await wait(delayMs);
                        yield { candidates: [{ content: { parts: [{ text: body.slice(0, 12) }] } }] } as any;
                        if (behaviour === 'stall-after-first-chunk') await never();
                        if (behaviour === 'trickle') for (;;) { await wait(20); yield { candidates: [{ content: { parts: [{ text: '' }] } }] } as any; }
                        yield { candidates: [{ content: { parts: [{ text: body.slice(12) }] }, finishReason: 'STOP' }], modelVersion: `${params.model}-001`, usageMetadata: { promptTokenCount: 4000, candidatesTokenCount: 600, thoughtsTokenCount: 0 } } as any;
                    } finally { done(); }
                })();
            }
        }
    };
    return { client, calls, maxInFlight: () => maxInFlight };
}

const chainOf = (client: VisionGenAIClient) => new VisionModelChain<string>({ client, candidates: [STAGED_VISION_MODEL_DEFAULT.model], sleep: async () => undefined });
const FAST = { firstTokenStallMs: 150, stallMs: 80, timeoutMs: 3_000, budgetMs: 6_000 };

describe('splitting the reading into batches', () => {
    it('one batch per fitted face, each with only the images that show its slots', () => {
        const f = structureFit();
        const { batches, unshown } = planOrnamentBatches(f, evidence(f).map(e => e.ref));
        expect(unshown).toEqual([]);
        // S01 and the S02 crease are on face s00 (the ortho shows both, the close-up adds a second view of S02); S03 is on s05
        expect(batches).toEqual([
            { id: 'b0', slotIds: ['S01', 'S02'], imageIndexes: [0, 1] },
            { id: 'b1', slotIds: ['S03'], imageIndexes: [1] }
        ]);
    });

    it.skipIf(!findArchFit())('on the real arch fit (84 slots), 6 images and 12 slots a batch at most, every offered slot in one batch with an image showing it', () => {
        const f = JSON.parse(fs.readFileSync(findArchFit()!.fitPath, 'utf8')) as StructureFit;
        // 6 orthos of the largest faces and 16 close-ups, each showing a deterministic spread of slots (the live reading's shape)
        const orthos = f.outputs.orthos.slice(0, 6).map((o, k) => orthoRef(o, k, f, PNG));
        const svs: EvidenceImageRef[] = Array.from({ length: 16 }, (_, k) => ({
            id: `sv:P${k}`, index: 6 + k, kind: 'streetview-grounding', widthPx: 1280, heightPx: 1280, sha256: 'c'.repeat(64), nativeSampleM: 0.02,
            slotsShown: f.slots.filter((_, i) => (i * 7 + k * 3) % 5 === 0).map(s => ({ slotId: s.id, polygon1000: [0, 0, 0, 1000, 1000, 1000, 1000, 0], visibleFraction: 0.4 + ((k % 3) * 0.2) }))
        }));
        const refs = [...orthos, ...svs];
        const { batches, unshown } = planOrnamentBatches(f, refs);
        const shownSlots = f.slots.filter(s => refs.some(r => r.slotsShown.some(x => x.slotId === s.id))).map(s => s.id);
        expect(batches.length).toBeGreaterThan(1);
        expect(batches.flatMap(b => b.slotIds).sort()).toEqual([...shownSlots].sort());
        expect(new Set(batches.flatMap(b => b.slotIds)).size).toBe(shownSlots.length);
        expect(unshown).toEqual([]);
        for (const b of batches) {
            expect(b.imageIndexes.length).toBeLessThanOrEqual(ORNAMENT_BATCH_MAX_IMAGES);
            for (const id of b.slotIds) expect(b.imageIndexes.some(i => refs[i].slotsShown.some(x => x.slotId === id))).toBe(true);
        }
        // the combined call sent all 22 images to one call; no batch sends more than 6
        expect(Math.max(...batches.map(b => b.imageIndexes.length))).toBeLessThan(refs.length);
        expect(Math.max(...batches.map(b => b.slotIds.length))).toBeLessThanOrEqual(ORNAMENT_BATCH_MAX_SLOTS);
        console.log(`real arch fit: ${shownSlots.length} slots shown by ${refs.length} images -> ${batches.length} batches: ${batches.map(b => `${b.slotIds.length} slots/${b.imageIndexes.length} images`).join(', ')}`);
    });
});

describe('the batched reading', () => {
    it('reads the batches at once, each with its own small prompt at thinking LOW, and merges them into one spec', async () => {
        const f = structureFit();
        const fake = promptReader();
        const t0 = Date.now();
        const r = await readOrnamentBatched({ fit: f, fitSha256: 'b'.repeat(64), evidence: evidence(f), chain: chainOf(fake.client), ...FAST });
        expect(fake.calls).toHaveLength(2);
        expect(fake.maxInFlight()).toBe(2); // at once, not one after the other
        expect(Math.abs(fake.calls[0].startedAt - fake.calls[1].startedAt)).toBeLessThan(30);
        for (const c of fake.calls) {
            expect(c.config).toMatchObject({ thinkingConfig: { thinkingLevel: 'LOW' }, maxOutputTokens: ORNAMENT_BATCH_MAX_OUTPUT_TOKENS, responseMimeType: 'application/json' });
            expect(c.text).toContain('and 24 in all');
        }
        const soffit = fake.calls.find(c => offeredIn(c.text).includes('S03'))!;
        const north = fake.calls.find(c => offeredIn(c.text).includes('S01'))!;
        // each batch is asked about its own slots, with its own images, and only its own primitives' correctable values
        expect(offeredIn(soffit.text)).toEqual(['S03']);
        expect(soffit.images).toBe(1);
        expect(soffit.text).toContain('p03 (passage arch): param 2 (riseToSpan)');
        expect(offeredIn(north.text)).toEqual(['S01', 'S02']);
        expect(north.images).toBe(2);
        expect(north.text).toContain('Correctable fit values: none');
        // merged: one spec the rest of the pipeline reads, ids unique per batch, images listed once
        expect(validateContract('OrnamentSpec', r.spec)).toEqual([]);
        expect(r.spec.elements.map(e => [e.id, e.slotId])).toEqual([['b0.e000', 'S01'], ['b0.e001', 'S02'], ['b1.e000', 'S03']]);
        expect(r.spec.elements.every(e => e.provenance.label === 'photo-inferred')).toBe(true);
        expect(r.spec.evidence.map(e => [e.index, e.id])).toEqual([[0, 'ortho:s00'], [1, 'sv:PANO1:180:15:42']]);
        // the soffit panel cites the close-up by id (its batch called it image 0)
        expect(r.spec.elements[2].evidence[0].imageId).toBe('sv:PANO1:180:15:42');
        expect(r.batches.map(b => [b.id, b.status, b.calls])).toEqual([['b0', 'answered', 1], ['b1', 'answered', 1]]);
        expect(r.calls).toBe(2);
        expect(r.spec.model).toMatchObject({ used: 'gemini-4-argon', thinking: { level: 'LOW' }, outcome: 'answered', promptTokens: 8000, outputTokens: 1200 });
        // the reading's time is its wall time (the batches overlapped), not the sum of the calls
        expect(r.spec.model.ms).toBeLessThanOrEqual(Date.now() - t0);
    });

    it('a batch whose stream stalls is asked again and, stalling again, fails alone: the other batch stands and its slots stay flat, with the reason', async () => {
        const f = structureFit();
        const fake = promptReader(text => (offeredIn(text).includes('S03') ? 'stall-after-first-chunk' : 'answer'));
        const progress: string[] = [];
        const t0 = Date.now();
        const r = await readOrnamentBatched({ fit: f, fitSha256: 'b'.repeat(64), evidence: evidence(f), chain: chainOf(fake.client), ...FAST, onProgress: m => progress.push(m) });
        const ms = Date.now() - t0;
        // caught by the stall watch (80 ms of silence), far inside the 3 s call limit
        expect(ms).toBeLessThan(1_500);
        expect(fake.calls.filter(c => offeredIn(c.text).includes('S03'))).toHaveLength(2);
        const failed = r.batches.find(b => b.id === 'b1')!;
        expect(failed).toMatchObject({ status: 'failed', slotIds: ['S03'], calls: 2, retries: 1, reasonCode: 'vision_stalled', transient: true, elements: 0 });
        expect(failed.reason).toMatch(/stalled: no token for 0 s/);
        expect(failed.model).toMatchObject({ used: 'gemini-4-argon', thinking: { level: 'LOW' }, outcome: 'failed' });
        expect(progress.some(p => /asking again/.test(p))).toBe(true);
        // the other batch is whole; nothing stands in for the failed one (no element, no "empty" claim on its slot)
        expect(r.batches.find(b => b.id === 'b0')).toMatchObject({ status: 'answered', elements: 2 });
        expect(r.spec.elements.map(e => e.slotId)).toEqual(['S01', 'S02']);
        expect(r.spec.emptySlots.some(s => s.slotId === 'S03')).toBe(false);
        expect(validateContract('OrnamentSpec', r.spec)).toEqual([]);
    });

    it('a stall on the first try that answers on the second keeps that batch', async () => {
        const f = structureFit();
        const fake = promptReader((text, nth) => (offeredIn(text).includes('S03') && nth === 0 ? 'hang' : 'answer'));
        const r = await readOrnamentBatched({ fit: f, fitSha256: 'b'.repeat(64), evidence: evidence(f), chain: chainOf(fake.client), ...FAST });
        expect(r.batches.find(b => b.id === 'b1')).toMatchObject({ status: 'answered', calls: 2, retries: 1, elements: 1 });
        expect(r.retries).toBe(1);
        expect(r.spec.elements.map(e => e.slotId)).toEqual(['S01', 'S02', 'S03']);
    });

    it('a batch that keeps streaming past the reading budget is cut there and reported; the reading ends inside its budget', async () => {
        const f = structureFit();
        const fake = promptReader(text => (offeredIn(text).includes('S03') ? 'trickle' : 'answer'));
        const t0 = Date.now();
        const r = await readOrnamentBatched({ fit: f, fitSha256: 'b'.repeat(64), evidence: evidence(f), chain: chainOf(fake.client), ...FAST, timeoutMs: 60_000, budgetMs: 400 });
        const ms = Date.now() - t0;
        expect(ms).toBeLessThan(400 + 2_000 + 300); // its own limit at the deadline, the backstop 2 s after
        expect(ms).toBeGreaterThanOrEqual(380);
        expect(r.batches.find(b => b.id === 'b1')).toMatchObject({ status: 'failed', reasonCode: 'vision_timeout', calls: 1 });
        expect(r.spec.elements.map(e => e.slotId)).toEqual(['S01', 'S02']);
    });

    it('a revision that does not come leaves the first reply standing, with the element that broke a rule dropped and recorded', async () => {
        const f = structureFit();
        // the north batch first answers with a relief that runs outside S01; the revision it is asked for then hangs, twice
        const fake = promptReader((text, nth) => (offeredIn(text).includes('S01') ? (nth === 0 ? 'broken' : 'hang') : 'answer'));
        const r = await readOrnamentBatched({ fit: f, fitSha256: 'b'.repeat(64), evidence: evidence(f), chain: chainOf(fake.client), ...FAST });
        const north = r.batches.find(b => b.id === 'b0')!;
        expect(north).toMatchObject({ status: 'answered', revised: true, calls: 3, retries: 1, elements: 1 });
        expect(r.spec.elements.map(e => e.slotId)).toEqual(['S02', 'S03']);
        expect(r.dropped).toEqual([expect.objectContaining({ elementId: 'b0.e000', slotId: 'S01', reasonCode: 'still_invalid_after_revision' })]);
        expect(r.spec.revision.problems.some(p => /^b0: the revision gave no reply \(the vision call stalled/.test(p))).toBe(true);
    });

    it('fails only when every batch fails, naming each', async () => {
        const f = structureFit();
        const fake = promptReader(() => 'hang');
        const err = await readOrnamentBatched({ fit: f, fitSha256: 'b'.repeat(64), evidence: evidence(f), chain: chainOf(fake.client), ...FAST, stallRetries: 0 }).catch(e => e);
        expect(err.name).toBe('VisionStageError');
        expect(err.message).toMatch(/^every batch of the reading failed \(b0: the vision call stalled: .*; b1: the vision call stalled/);
        expect(err.transient).toBe(true);
        expect(err.batches).toHaveLength(2);
    });
});

describe('the images sent', () => {
    it('a close-up wider than 1280 px is sent at 1280 px, its metres per pixel scaled with it; a smaller one is sent as it came', async () => {
        const f = structureFit();
        const big = bandJpeg([SKY, STONE, STONE, GREY], 1920, 1080);
        const ev = evidence(f, { widthPx: 1920, heightPx: 1080, nativeSampleM: 0.02 }, big);
        const { evidence: out, downscaled } = await downscaleEvidence(ev);
        expect(downscaled).toEqual([{ imageId: 'sv:PANO1:180:15:42', fromPx: [1920, 1080], toPx: [1280, 720] }]);
        const sv = out[1];
        expect([sv.ref.widthPx, sv.ref.heightPx]).toEqual([1280, 720]);
        expect(sv.ref.nativeSampleM).toBeCloseTo(0.03, 6);
        expect(sv.bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))).toBe(true);
        expect(sv.bytes.length).toBeLessThan(big.length);
        expect(sv.caption).toContain('1280 × 720 px; one pixel spans about 0.03 m');
        // the ortho is untouched, and the slot outlines (0-1000 of the image) do not change with the size
        expect(out[0]).toBe(ev[0]);
        expect(sv.ref.slotsShown).toEqual(ev[1].ref.slotsShown);
        const small = evidence(f);
        expect((await downscaleEvidence(small)).evidence[1]).toBe(small[1]);
    });
});

describe('thinking LOW in the request body, and the stage bounds', () => {
    it('the @google/genai SDK puts thinkingConfig { thinkingLevel: LOW } in the streamed request it sends', async () => {
        const bodies: any[] = [];
        const urls: string[] = [];
        const server = http.createServer((req, res) => {
            let raw = '';
            req.on('data', c => { raw += c; });
            req.on('end', () => {
                urls.push(req.url ?? '');
                bodies.push(JSON.parse(raw));
                res.writeHead(200, { 'content-type': 'text/event-stream' });
                res.end(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: '{"elements":[],"corrections":[],"emptySlots":[]}' }] }, finishReason: 'STOP' }] })}\r\n\r\n`);
            });
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
        try {
            const port = (server.address() as { port: number }).port;
            const ai = new GoogleGenAI({ apiKey: 'local-stand-in', httpOptions: { baseUrl: `http://127.0.0.1:${port}` } });
            const chain = new VisionModelChain<string>({ client: ai as unknown as VisionGenAIClient, candidates: [STAGED_VISION_MODEL_DEFAULT.model], sleep: async () => undefined });
            await chain.generate({ contents: [{ role: 'user', parts: [{ text: 'x' }] }], config: { maxOutputTokens: ORNAMENT_BATCH_MAX_OUTPUT_TOKENS } }, { stage: 'vision', thinkingBudget: ORNAMENT_THINKING_BUDGET, stream: true });
            expect(urls[0]).toMatch(/gemini-4-argon:streamGenerateContent\?alt=sse/);
            expect(bodies[0].generationConfig).toMatchObject({ thinkingConfig: { thinkingLevel: 'LOW' }, maxOutputTokens: ORNAMENT_BATCH_MAX_OUTPUT_TOKENS });
            expect(thinkingConfigFor('gemini-4-argon', ORNAMENT_THINKING_BUDGET)).toEqual({ thinkingLevel: 'LOW' });
        } finally {
            server.close();
        }
    });

    it('the vision stage holds the batched reading, the run readings and a margin, so its own limit never ends a finished reading', () => {
        expect(STAGES.vision.budgetMs).toBe(ORNAMENT_PASS_BUDGET_MS + VISION_RUNS_ALLOWANCE_MS + VISION_STAGE_MARGIN_MS);
        // the run readings are given what is left, never their own longer budget
        expect(VISION_RUNS_ALLOWANCE_MS).toBeLessThan(RUN_PASS_BUDGET_MS);
    });
});
