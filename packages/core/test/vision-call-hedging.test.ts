/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Hedged requests and deadlines for vision calls that are not streamed (vision-model-chain.ts VISION_CALL_POLICY), the
 * ownership vote's quorum rule (ownership-masks.ts OWNERSHIP_VOTE_RULE) and the grammar's deadline handling, on a fake
 * client whose answers take scripted times on fake timers. The replay tests drive the chain with the latencies recorded
 * from real staged builds (fixtures/vision-latency/recorded.json). No network, no billed call.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    VISION_CALL_POLICY, VISION_HEDGE_MIN_SAMPLES, VisionHedgeBook, VisionModelChain, type VisionGenAIClient, type VisionHedgePolicy
} from '../src/node/gemini/vision-model-chain';
import { OWNERSHIP_VOTE_RULE, segmentOwnershipViews } from '../src/node/3d-engine/staged-location/ownership-masks';
import { runFacadeGrammarPass, type ReliefOrthoFacade } from '../src/node/3d-engine/staged-location/facade-grammar';
import { encodePng } from './helpers/synthetic-scan-glb';
import { promptImage, simulatedReply, type TrueOpening } from './helpers/facade-grammar-reader';

const RECORDED = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/vision-latency/recorded.json'), 'utf8')) as { grammar: number[]; ownership: number[] };
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-vision-hedge-')));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

const HANG = 1e9;
type Plan = { ms: number; text?: string; error?: Error };
type Req = { i: number; model: string; state: 'pending' | 'answered' | 'aborted' | 'failed'; t0: number; t1?: number };

/** A client whose i-th request answers (or fails) after plan(i).ms, and rejects with an AbortError when its signal fires. */
function timedClient(plan: (i: number, params: any) => Plan): VisionGenAIClient & { reqs: Req[] } {
    const reqs: Req[] = [];
    return {
        reqs,
        models: {
            generateContent: (params: any) => {
                const rec: Req = { i: reqs.length, model: params.model, state: 'pending', t0: Date.now() };
                reqs.push(rec);
                const p = plan(rec.i, params);
                return new Promise((resolve, reject) => {
                    const sig: AbortSignal | undefined = params.config?.abortSignal;
                    const t = setTimeout(() => {
                        rec.t1 = Date.now();
                        if (p.error) { rec.state = 'failed'; reject(p.error); return; }
                        rec.state = 'answered';
                        resolve({ candidates: [{ content: { parts: [{ text: p.text ?? '{"ok":1}' }] }, finishReason: 'STOP' }], modelVersion: `${params.model}-001` } as any);
                    }, p.ms);
                    const onAbort = () => { clearTimeout(t); rec.state = 'aborted'; rec.t1 = Date.now(); reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })); };
                    if (sig?.aborted) onAbort(); else sig?.addEventListener('abort', onAbort, { once: true });
                });
            }
        }
    };
}

const http = (status: number, message: string) => Object.assign(new Error(message), { status });
const POLICY: VisionHedgePolicy = { quantile: 0.8, floorMs: 12_000, ceilingMs: 30_000, initialMs: 15_000 };
const text = (r: any) => r.response.candidates[0].content.parts[0].text;

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); delete process.env.SCRATCHBOX_VISION_HEDGE; });

describe('hedging a call that is not streamed', () => {
    it('sends the same request again at the threshold; the duplicate answers first and the slow request is aborted', async () => {
        const client = timedClient(i => (i === 0 ? { ms: 190_000, text: '{"slow":1}' } : { ms: 8_000, text: '{"fast":1}' }));
        const book = new VisionHedgeBook();
        const chain = new VisionModelChain<string>({ client, candidates: ['gemini-4-argon'], hedgeBook: book });
        const p = chain.generate({ contents: [{ role: 'user', parts: [{ text: 'x' }] }] }, { stage: 'grammar', hedge: POLICY });
        await vi.advanceTimersByTimeAsync(14_999);
        expect(client.reqs).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(client.reqs).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(8_000);
        const r = await p;
        expect(text(r)).toBe('{"fast":1}');
        expect(r.ms).toBe(23_000);
        expect(client.reqs.map(q => q.state)).toEqual(['aborted', 'answered']);
        expect(chain.attempts).toEqual([expect.objectContaining({ outcome: 'answered', hedged: true, hedgeWon: true, hedgeAtMs: 15_000, ms: 23_000 })]);
        expect(book.counts().grammar).toMatchObject({ calls: 1, fired: 1, won: 1, suppressed: 0 });
        expect(book.inFlight).toBe(0);
    });

    it('keeps the first answer when it comes before the duplicate, and aborts the duplicate', async () => {
        const client = timedClient(i => (i === 0 ? { ms: 20_000, text: '{"first":1}' } : { ms: 30_000, text: '{"second":1}' }));
        const book = new VisionHedgeBook();
        const chain = new VisionModelChain<string>({ client, candidates: ['gemini-4-argon'], hedgeBook: book });
        const p = chain.generate({ contents: [] }, { stage: 'grammar', hedge: POLICY });
        await vi.advanceTimersByTimeAsync(20_000);
        const r = await p;
        expect(text(r)).toBe('{"first":1}');
        expect(client.reqs.map(q => q.state)).toEqual(['answered', 'aborted']);
        expect(chain.attempts[0]).toMatchObject({ hedged: true, hedgeWon: false });
        expect(book.counts().grammar).toMatchObject({ fired: 1, won: 0 });
    });

    it('does not hedge an answer that comes before the threshold', async () => {
        const client = timedClient(() => ({ ms: 9_000 }));
        const chain = new VisionModelChain<string>({ client, candidates: ['gemini-4-argon'], hedgeBook: new VisionHedgeBook() });
        const p = chain.generate({ contents: [] }, { stage: 'grammar', hedge: POLICY });
        await vi.advanceTimersByTimeAsync(9_000);
        await p;
        await vi.advanceTimersByTimeAsync(60_000);
        expect(client.reqs).toHaveLength(1);
        expect(chain.attempts[0].hedged).toBeUndefined();
    });

    it('waits for the other request when the first answer is not usable', async () => {
        const client = timedClient(i => (i === 0 ? { ms: 20_000, text: 'not json' } : { ms: 10_000, text: '{"good":1}' }));
        const chain = new VisionModelChain<string>({ client, candidates: ['gemini-4-argon'], hedgeBook: new VisionHedgeBook() });
        const valid = (res: any) => { try { JSON.parse(res.candidates[0].content.parts[0].text); return true; } catch { return false; } };
        const p = chain.generate({ contents: [] }, { stage: 'grammar', hedge: POLICY, valid });
        await vi.advanceTimersByTimeAsync(25_000);
        expect(text(await p)).toBe('{"good":1}');
        expect(chain.attempts[0]).toMatchObject({ hedgeWon: true, ms: 25_000 });
    });

    it('adapts the threshold to the kind\'s recent latencies, within the floor and the ceiling', () => {
        const book = new VisionHedgeBook();
        expect(book.threshold('grammar', POLICY)).toBe(15_000);
        for (let i = 0; i < VISION_HEDGE_MIN_SAMPLES - 1; i++) book.record('grammar', 2_000);
        expect(book.threshold('grammar', POLICY)).toBe(15_000); // not enough answers yet
        book.record('grammar', 2_000);
        expect(book.threshold('grammar', POLICY)).toBe(12_000); // fast answers: the floor
        for (let i = 0; i < 64; i++) book.record('grammar', 20_000 + i);
        expect(book.threshold('grammar', POLICY)).toBe(20_051); // p80 of the last 64
        for (let i = 0; i < 64; i++) book.record('grammar', 120_000);
        expect(book.threshold('grammar', POLICY)).toBe(30_000); // a slow spell: the ceiling
        expect(book.threshold('ownership', VISION_CALL_POLICY.ownership.hedge)).toBe(20_000); // kinds are kept apart
    });

    it('is off with SCRATCHBOX_VISION_HEDGE=0', async () => {
        process.env.SCRATCHBOX_VISION_HEDGE = '0';
        const client = timedClient(() => ({ ms: 40_000 }));
        const chain = new VisionModelChain<string>({ client, candidates: ['gemini-4-argon'], hedgeBook: new VisionHedgeBook() });
        const p = chain.generate({ contents: [] }, { stage: 'grammar', hedge: POLICY });
        await vi.advanceTimersByTimeAsync(40_000);
        await p;
        expect(client.reqs).toHaveLength(1);
    });
});

describe('rate limits', () => {
    it('backs a 429 off for 2 s then 4 s on the same model, and sends no hedge to that model during the pause', async () => {
        const waits: number[] = [];
        const book = new VisionHedgeBook();
        const client = timedClient(i => (i === 0 ? { ms: 100, error: http(429, 'Resource exhausted') } : { ms: 40_000 }));
        const chain = new VisionModelChain<string>({ client, candidates: ['gemini-4-argon'], hedgeBook: book, sleep: async ms => { waits.push(ms); } });
        const p = chain.generate({ contents: [] }, { stage: 'grammar', hedge: POLICY });
        await vi.advanceTimersByTimeAsync(16_000);
        expect(book.pausedFor('gemini-4-argon')).toBe(30_000 - 15_900);
        await vi.advanceTimersByTimeAsync(24_100);
        await p;
        expect(waits).toEqual([2_000]);
        expect(chain.attempts.map(a => a.outcome)).toEqual(['retried', 'answered']);
        // the retry ran 40 s, past the threshold, but the model was in its 429 pause: no duplicate went out
        expect(client.reqs).toHaveLength(2);
        expect(book.counts().grammar).toMatchObject({ fired: 0, suppressed: 1 });
    });

    it('doubles the pause for 429s in a row and lets hedges go again once it has passed', async () => {
        const book = new VisionHedgeBook();
        book.rateLimited('m');
        expect(book.pausedFor('m')).toBe(30_000);
        book.rateLimited('m');
        expect(book.pausedFor('m')).toBe(60_000);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(book.pausedFor('m')).toBe(0);
        const client = timedClient(i => (i === 0 ? { ms: HANG } : { ms: 5_000 }));
        const chain = new VisionModelChain<string>({ client, candidates: ['m'], hedgeBook: book });
        const p = chain.generate({ contents: [] }, { stage: 'grammar', hedge: POLICY });
        await vi.advanceTimersByTimeAsync(20_000);
        await p;
        expect(book.counts().grammar).toMatchObject({ fired: 1, won: 1 });
    });

    it('a duplicate that is refused with a 429 leaves the first request running and pauses hedging', async () => {
        const book = new VisionHedgeBook();
        const client = timedClient(i => (i === 0 ? { ms: 50_000, text: '{"first":1}' } : { ms: 500, error: http(429, 'Resource exhausted') }));
        const chain = new VisionModelChain<string>({ client, candidates: ['gemini-4-argon'], hedgeBook: book });
        const p = chain.generate({ contents: [] }, { stage: 'grammar', hedge: POLICY });
        await vi.advanceTimersByTimeAsync(16_000);
        expect(book.pausedFor('gemini-4-argon')).toBe(29_500);
        await vi.advanceTimersByTimeAsync(34_000);
        expect(text(await p)).toBe('{"first":1}');
        expect(client.reqs.map(q => q.state)).toEqual(['answered', 'failed']);
    });
});

describe('deadlines', () => {
    it('fails a call with no answer by its deadline with a typed deadline error, every request aborted', async () => {
        const client = timedClient(() => ({ ms: HANG }));
        const book = new VisionHedgeBook();
        const chain = new VisionModelChain<string>({ client, candidates: ['gemini-4-argon'], hedgeBook: book });
        const p = chain.generate({ contents: [] }, { stage: 'grammar', hedge: POLICY, deadlineMs: 90_000 }).catch(e => e);
        await vi.advanceTimersByTimeAsync(90_000);
        const err = await p;
        expect(err.message).toBe("no answer within 90 s (the grammar call's deadline)");
        expect(err.details).toMatchObject({ deadline: true, deadlineMs: 90_000, model: 'gemini-4-argon' });
        expect(client.reqs.map(q => q.state)).toEqual(['aborted', 'aborted']);
        expect(chain.attempts.map(a => a.outcome)).toEqual(['deadline']);
        expect(book.counts().grammar).toMatchObject({ deadlines: 1, fired: 1 });
    });

    it('a stop by the user is still a stop, not a deadline', async () => {
        const stop = new AbortController();
        const client = timedClient(() => ({ ms: HANG }));
        const chain = new VisionModelChain<string>({ client, candidates: ['gemini-4-argon'], signal: stop.signal, hedgeBook: new VisionHedgeBook() });
        const p = chain.generate({ contents: [] }, { stage: 'grammar', hedge: POLICY, deadlineMs: 90_000 }).catch(e => e);
        await vi.advanceTimersByTimeAsync(20_000);
        stop.abort();
        const err = await p;
        expect(err.message).toBe('Stopped by the user.');
        expect(err.details.aborted).toBe(true);
    });
});

describe('the visible model fallback, hedged', () => {
    it('still says which model answered and why the requested one was passed over', async () => {
        const client = timedClient((i, params) => (params.model === 'gemini-4-argon' ? { ms: 50, error: http(404, 'model gemini-4-argon was not found (404)') } : i === 1 ? { ms: HANG } : { ms: 3_000, text: '{"fallback":1}' }));
        const chain = new VisionModelChain<string>({ client, candidates: ['gemini-4-argon', 'gemini-3.8-flash'], hedgeBook: new VisionHedgeBook() });
        const p = chain.generate({ contents: [] }, { stage: 'grammar', hedge: POLICY, deadlineMs: 90_000 });
        await vi.advanceTimersByTimeAsync(20_000);
        const r = await p;
        expect(r.model).toBe('gemini-3.8-flash');
        expect(chain.answeredModel).toBe('gemini-3.8-flash');
        expect(chain.skipped).toEqual([{ model: 'gemini-4-argon', reason: expect.stringMatching(/not found/) }]);
        expect(chain.attempts.map(a => [a.model, a.outcome, a.hedged ?? false])).toEqual([['gemini-4-argon', 'not_found', false], ['gemini-3.8-flash', 'answered', true]]);
        expect(client.reqs.map(q => q.model)).toEqual(['gemini-4-argon', 'gemini-3.8-flash', 'gemini-3.8-flash']);
    });
});

// ---------------------------------------------------------------------------------------------------------------
// the ownership vote
// ---------------------------------------------------------------------------------------------------------------

const OUTLINE = JSON.stringify({ visible: true, polygons: [{ outer: [[100, 100], [100, 900], [900, 900], [900, 100]], holes: [] }] });

function ownershipViews(n: number): string {
    const dir = fs.mkdtempSync(path.join(TMP, 'views-'));
    const lines: string[] = [];
    for (let i = 0; i < n; i++) {
        const name = `v${String(i).padStart(2, '0')}`;
        // each view's pixels differ, so the requests differ
        fs.writeFileSync(path.join(dir, `${name}.png`), encodePng(8, 8, new Uint8Array(8 * 8 * 3).fill(10 + i)));
        lines.push(`${name} 8 8`);
    }
    fs.writeFileSync(path.join(dir, 'views.txt'), lines.join('\n') + '\n');
    return dir;
}

describe('the ownership vote', () => {
    it('goes ahead without its slowest views once the quorum of outlines is in, and says so', async () => {
        const views = ownershipViews(12);
        // views 0-9 answer within 12 s; views 10 and 11 never answer (their hedges neither)
        const client = timedClient((_, params) => {
            const png = Buffer.from(params.contents[0].parts[0].inlineData.data, 'base64');
            const v = [...Array(12).keys()].find(i => png.equals(fs.readFileSync(path.join(views, `v${String(i).padStart(2, '0')}.png`))))!;
            return v >= 10 ? { ms: HANG } : { ms: 4_000 + v * 800, text: OUTLINE };
        });
        const chain = new VisionModelChain<string>({ client, candidates: ['gemini-4-argon'], hedgeBook: new VisionHedgeBook() });
        const p = segmentOwnershipViews({ viewsDir: views, masksDir: path.join(views, 'masks'), target: 'the building', chain, concurrency: 6 });
        await vi.advanceTimersByTimeAsync(OWNERSHIP_VOTE_RULE.afterMs);
        const seg = await p;
        expect(seg.masks).toBe(10);
        expect(seg.ms).toBe(30_000);
        expect(seg.cut).toMatchObject({ views: ['v10', 'v11'], quorum: 9, afterMs: 30_000 });
        expect(seg.cut!.note).toBe('the vote went ahead 30 s in without 2 views still unanswered (v10, v11): 10 of 12 had outlines, at least 9 needed');
        expect(seg.skipped.map(s => s.view)).toEqual(['v10', 'v11']);
        expect(seg.skipped[0].reason).toBe('no answer by the time the vote went ahead (30 s in, with 10 of 12 outlines; quorum 9)');
        expect(client.reqs.filter(q => q.state === 'pending')).toHaveLength(0);
        expect(fs.readdirSync(path.join(views, 'masks')).filter(f => f.endsWith('.mask.png'))).toHaveLength(10);
    });

    it('below the quorum it keeps waiting, each call to its deadline, and a view without an answer casts no vote', async () => {
        const views = ownershipViews(12);
        const client = timedClient((_, params) => {
            const png = Buffer.from(params.contents[0].parts[0].inlineData.data, 'base64');
            const v = [...Array(12).keys()].find(i => png.equals(fs.readFileSync(path.join(views, `v${String(i).padStart(2, '0')}.png`))))!;
            return v % 2 ? { ms: HANG } : { ms: 5_000, text: OUTLINE };
        });
        const chain = new VisionModelChain<string>({ client, candidates: ['gemini-4-argon'], hedgeBook: new VisionHedgeBook() });
        const p = segmentOwnershipViews({ viewsDir: views, masksDir: path.join(views, 'masks'), target: 'the building', chain, concurrency: 12 });
        await vi.advanceTimersByTimeAsync(VISION_CALL_POLICY.ownership.deadlineMs);
        const seg = await p;
        expect(seg.masks).toBe(6);
        expect(seg.cut).toBeUndefined();
        expect(seg.skipped).toHaveLength(6);
        expect(seg.skipped.every(s => s.reason === "no answer within 90 s (the ownership call's deadline)")).toBe(true);
    });

    it('waits for every view when the rule is off', async () => {
        const views = ownershipViews(4);
        const client = timedClient(i => ({ ms: i === 3 ? 70_000 : 5_000, text: OUTLINE }));
        const chain = new VisionModelChain<string>({ client, candidates: ['gemini-4-argon'], hedgeBook: new VisionHedgeBook() });
        process.env.SCRATCHBOX_VISION_HEDGE = '0';
        const p = segmentOwnershipViews({ viewsDir: views, masksDir: path.join(views, 'masks'), target: 'the building', chain, concurrency: 4, vote: false });
        await vi.advanceTimersByTimeAsync(70_000);
        const seg = await p;
        expect(seg.masks).toBe(4);
        expect(seg.ms).toBe(70_000);
    });
});

// ---------------------------------------------------------------------------------------------------------------
// the grammar
// ---------------------------------------------------------------------------------------------------------------

/** A 40 x 30 m facade at 10 cm: five storeys of six windows (the grammar stage test's facade). */
function facadeOf(id: number): { meta: ReliefOrthoFacade; png: Buffer; truth: TrueOpening[] } {
    const W = 400, H = 300, px = 0.1;
    const truth: TrueOpening[] = [];
    for (let k = 0; k < 5; k++) for (let j = 0; j < 6; j++) { const sc = -15 + j * 6, tb = -8 + k * 5.2; truth.push({ s0: sc - 0.7, s1: sc + 0.7, t0: tb, t1: tb + 2.2 }); }
    const rgb = new Uint8Array(W * H * 3);
    let seed = id * 31 + 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const s = -20 + (x + 0.5) * px, t = 20 - (y + 0.5) * px;
        let v = 165;
        for (const o of truth) if (s >= o.s0 && s <= o.s1 && t >= o.t0 && t <= o.t1) v = 70;
        v += (rnd() - 0.5) * 30;
        for (let c = 0; c < 3; c++) rgb[(y * W + x) * 3 + c] = Math.max(0, Math.min(255, Math.round(v + (c === 0 ? 12 : 0))));
    }
    const meta: ReliefOrthoFacade = {
        facadeId: id, planeIndex: id, image: `facade_${id}.png`, area_m2: 1200, centroid: [20, 10, 0], normal: [1, 0, 0], axisS: [0, 0, -1], axisT: [0, 1, 0],
        sMin: -20, sMax: 20, tMin: -10, tMax: 20, pixel: px, texel: 0.2, width: W, height: H, orthoSMin: -20, orthoTMax: 20, coverage: 1,
        pattern: 'cells', latticeConfirmation: 0.3, latticeRejected: true,
        cells: [[-15.6, -14.4, -7.9, -5.9, -0.2, 1, 0.3], [-3.6, -2.4, 2.3, 4.3, -0.2, 1, 0.3], [2.0, 3.0, 3.5, 4.5, -0.2, 1, 0.3]]
    };
    return { meta, png: encodePng(W, H, rgb), truth };
}

function grammarSetup(hangCall: number) {
    const f = facadeOf(3);
    const dir = fs.mkdtempSync(path.join(TMP, 'orthos-'));
    fs.writeFileSync(path.join(dir, f.meta.image), f.png);
    fs.writeFileSync(path.join(dir, 'facades.json'), JSON.stringify({ schema: 'scratchbox.relief-orthos/1', facades: [f.meta] }));
    // the facade's five readings are asked in order: the whole photo first, then the four held-out folds
    const client = timedClient((i, params) => (i === hangCall || i === 5 ? { ms: HANG } : { ms: 3_000, text: simulatedReply(f.meta, f.png, promptImage(params), f.truth) }));
    return { dir, client, chain: new VisionModelChain<string>({ client, candidates: ['gemini-4-argon'], hedgeBook: new VisionHedgeBook() }) };
}

describe('the grammar readings', () => {
    it('a facade whose whole reading has no answer by the deadline keeps the relief\'s lattice, saying why', async () => {
        const { dir, chain } = grammarSetup(0);
        const p = runFacadeGrammarPass({ orthosDir: dir, chain });
        await vi.advanceTimersByTimeAsync(VISION_CALL_POLICY.grammar.deadlineMs);
        const pass = await p;
        expect(pass.accepted).toHaveLength(0);
        expect(pass.facades[0].reason).toBe("the reading failed (no answer within 90 s (the grammar call's deadline))");
        expect(pass.facades[0].readings[0]).toMatchObject({ view: 'whole', error: "no answer within 90 s (the grammar call's deadline)" });
    });

    it('a held-out reading with no answer is not scored; the check goes on with the folds it has', async () => {
        const { dir, chain } = grammarSetup(2);
        const p = runFacadeGrammarPass({ orthosDir: dir, chain });
        await vi.advanceTimersByTimeAsync(VISION_CALL_POLICY.grammar.deadlineMs);
        const pass = await p;
        const f = pass.facades[0];
        expect(f.readings.filter(r => r.error)).toEqual([expect.objectContaining({ view: 'stripes-b', error: expect.stringMatching(/no answer within 90 s/) })]);
        expect(f.heldOut!.why).toMatch(/held out \(3 of 4 readings with parts hidden\)/);
        expect(f.accepted).toBe(true);
    });
});

describe('the grammar reading pool', () => {
    it('every facade\'s readings go through one pool, in facade order; a facade is judged when its own five are in, and the pass is not rounds of "slowest of five"', async () => {
        // 12 facades, 5 readings each; every facade's whole reading takes 30 s, its four held-out readings 10 s. Read 3 facades at a
        // time, each waiting for all five (the shape before 2026-10-21), the pass was 4 rounds of 30 s: 120 s
        const dir = fs.mkdtempSync(path.join(TMP, 'orthos-pool-'));
        const facades = [...Array(12).keys()].map(id => facadeOf(id + 1));
        for (const f of facades) fs.writeFileSync(path.join(dir, f.meta.image), f.png);
        fs.writeFileSync(path.join(dir, 'facades.json'), JSON.stringify({ schema: 'scratchbox.relief-orthos/1', facades: facades.map(f => f.meta) }));
        process.env.SCRATCHBOX_VISION_HEDGE = '0';
        let inFlight = 0, maxInFlight = 0;
        const order: number[] = [];
        // the facade a request reads is told by the one whose photo the simulated reader can place the request's image in
        const read = (params: any): { id: number; text: string } => {
            const img = promptImage(params);
            for (const f of facades) { try { return { id: f.meta.facadeId, text: simulatedReply(f.meta, f.png, img, f.truth) }; } catch { /* not this facade */ } }
            throw new Error('the request\'s image is none of the facades');
        };
        const client = timedClient((i, params) => {
            const r = read(params);
            order.push(r.id);
            inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
            return { ms: i % 5 === 0 ? 30_000 : 10_000, text: r.text };
        });
        const realGenerate = client.models.generateContent;
        client.models.generateContent = (params: any) => realGenerate(params).finally(() => { inFlight--; });
        const chain = new VisionModelChain<string>({ client, candidates: ['gemini-4-argon'], hedgeBook: new VisionHedgeBook() });
        const t0 = Date.now();
        const p = runFacadeGrammarPass({ orthosDir: dir, chain, maxFacades: 12, readPool: 14 });
        await vi.runAllTimersAsync();
        const pass = await p;
        const ms = Date.now() - t0;
        expect(pass.calls).toBe(60);
        expect(maxInFlight).toBe(14);
        // facade order: the first facade's five readings are sent before the second's, and so on
        expect(order.slice(0, 15)).toEqual([1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3]);
        expect(pass.facades.map(f => f.facadeId)).toEqual(facades.map(f => f.meta.facadeId));
        for (const f of pass.facades) expect(f.readings.filter(r => r.error)).toEqual([]);
        // 60 readings (48 x 10 s + 12 x 30 s) through 14 slots: about 60-70 s, against 120 s in rounds
        expect(ms).toBeLessThan(0.7 * 120_000);
        expect(ms).toBeGreaterThanOrEqual(60_000);
    });
});

// ---------------------------------------------------------------------------------------------------------------
// replay of the recorded latencies
// ---------------------------------------------------------------------------------------------------------------

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
    let next = 0;
    await Promise.all(Array.from({ length: n }, async () => { for (let i; (i = next++) < items.length;) await fn(items[i]); }));
}

/**
 * The grammar stage's shape: 12 facades, three at a time, each waiting for its five readings. Request k of the replay
 * takes the k-th recorded latency (the duplicates draw from the same list, half a list later), so every recorded
 * latency, the 211 s one too, is the first request of one call.
 */
async function replayGrammar(mode: 'before' | 'deadline only' | 'hedged'): Promise<{ stages: number[]; worstCall: number; fired: number; won: number; deadlines: number }> {
    if (mode === 'deadline only') process.env.SCRATCHBOX_VISION_HEDGE = '0'; else delete process.env.SCRATCHBOX_VISION_HEDGE;
    const lat = RECORDED.grammar;
    let first = 0, dup = 0;
    const isDup = new Set<number>();
    const book = new VisionHedgeBook();
    const client = timedClient(i => {
        // a request sent while another of the same call is out is the duplicate
        const ms = isDup.has(i) ? lat[(Math.floor(lat.length / 2) + dup++) % lat.length] : lat[first++ % lat.length];
        return { ms };
    });
    const realGenerate = client.models.generateContent;
    const chain = new VisionModelChain<string>({ client, candidates: ['gemini-4-argon'], hedgeBook: book });
    // tell duplicates apart: a request whose call already had one sent
    const outByCall = new Map<number, number>();
    client.models.generateContent = (params: any) => {
        const call = params.contents[0].parts[0].text as unknown as number;
        const n = outByCall.get(call) ?? 0;
        if (n > 0) isDup.add(client.reqs.length);
        outByCall.set(call, n + 1);
        return realGenerate(params);
    };
    const stages: number[] = [];
    let worstCall = 0, callNo = 0;
    const builds = Math.ceil(lat.length / 60);
    for (let b = 0; b < builds; b++) {
        const t0 = Date.now();
        const run = pool([...Array(12).keys()], 3, async () => {
            await Promise.all([...Array(5).keys()].map(async () => {
                const id = callNo++;
                const c0 = Date.now();
                try { await chain.generate({ contents: [{ role: 'user', parts: [{ text: id as unknown as string }] }] }, { stage: 'grammar', ...(mode === 'before' ? {} : VISION_CALL_POLICY.grammar) }); } catch { /* a deadline: the reading failed */ }
                worstCall = Math.max(worstCall, Date.now() - c0);
            }));
        });
        await vi.runAllTimersAsync();
        await run;
        stages.push(Date.now() - t0);
    }
    const c = book.counts().grammar;
    return { stages, worstCall, fired: c?.fired ?? 0, won: c?.won ?? 0, deadlines: c?.deadlines ?? 0 };
}

/** The vote's shape: 12 views, six at a time; request k takes the k-th recorded ownership latency. */
async function replayOwnership(hedgeAndRule: boolean, concurrency = 6): Promise<{ votes: number[]; viewsVoting: number[]; fired: number; won: number }> {
    if (!hedgeAndRule) process.env.SCRATCHBOX_VISION_HEDGE = '0'; else delete process.env.SCRATCHBOX_VISION_HEDGE;
    const lat = RECORDED.ownership;
    let k = 0;
    const book = new VisionHedgeBook();
    const client = timedClient(() => ({ ms: lat[k++ % lat.length], text: OUTLINE }));
    const votes: number[] = [], viewsVoting: number[] = [];
    for (let b = 0; b < Math.floor(lat.length / 12); b++) {
        const views = ownershipViews(12);
        const chain = new VisionModelChain<string>({ client, candidates: ['gemini-4-argon'], hedgeBook: book });
        const p = segmentOwnershipViews({ viewsDir: views, masksDir: path.join(views, 'masks'), target: 'the building', chain, concurrency, ...(hedgeAndRule ? {} : { vote: false as const }) });
        await vi.runAllTimersAsync();
        const seg = await p;
        votes.push(seg.ms);
        viewsVoting.push(seg.masks);
    }
    const c = book.counts().ownership;
    return { votes, viewsVoting, fired: c?.fired ?? 0, won: c?.won ?? 0 };
}

const sum = (v: number[]) => v.reduce((a, b) => a + b, 0);
const s1 = (ms: number) => Math.round(ms / 100) / 10;

describe('replaying the recorded latencies', () => {
    it('grammar: hedging cuts the stage\'s long tail', async () => {
        const before = await replayGrammar('before');
        const deadlineOnly = await replayGrammar('deadline only');
        const after = await replayGrammar('hedged');
        for (const [name, r] of [['before (no hedge, no deadline)', before], ['deadline only', deadlineOnly], ['hedged + deadline', after]] as const) {
            console.log(`[replay] grammar stage s, ${name}: ${r.stages.map(s1).join(', ')} (sum ${s1(sum(r.stages))}, worst call ${s1(r.worstCall)}); hedges fired ${r.fired}, won ${r.won}, deadlines ${r.deadlines}`);
        }
        expect(before.worstCall).toBe(Math.max(...RECORDED.grammar)); // the 211 s call held its stage
        expect(deadlineOnly.worstCall).toBe(VISION_CALL_POLICY.grammar.deadlineMs);
        expect(after.worstCall).toBeLessThan(deadlineOnly.worstCall);
        expect(Math.max(...after.stages)).toBeLessThan(0.7 * Math.max(...before.stages));
        expect(sum(after.stages)).toBeLessThan(0.8 * sum(before.stages));
        expect(after.won).toBeGreaterThan(0);
        expect(after.deadlines).toBe(0);
        expect(after.fired).toBeLessThan(0.3 * RECORDED.grammar.length);
    });

    it('ownership: hedging and the quorum rule end the vote sooner, with most views still voting', async () => {
        const before = await replayOwnership(false);
        const after = await replayOwnership(true);
        const wide = await replayOwnership(true, 12);
        console.log(`[replay] ownership vote s, waiting for all (6 at a time): ${before.votes.map(s1).join(', ')} (sum ${s1(sum(before.votes))})`);
        console.log(`[replay] ownership vote s, hedged + quorum (6 at a time): ${after.votes.map(s1).join(', ')} (sum ${s1(sum(after.votes))}); views voting ${after.viewsVoting.join(', ')}; hedges fired ${after.fired}, won ${after.won}`);
        console.log(`[replay] ownership vote s, hedged + quorum (12 at a time): ${wide.votes.map(s1).join(', ')} (sum ${s1(sum(wide.votes))}); views voting ${wide.viewsVoting.join(', ')}; hedges fired ${wide.fired}, won ${wide.won}`);
        expect(Math.max(...after.votes)).toBeLessThan(Math.max(...before.votes));
        expect(sum(after.votes)).toBeLessThan(sum(before.votes));
        expect(Math.min(...after.viewsVoting)).toBeGreaterThanOrEqual(9);
        expect(before.viewsVoting.every(n => n === 12)).toBe(true);
    });
});
