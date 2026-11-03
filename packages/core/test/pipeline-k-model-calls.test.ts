/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Fewer model calls for pipeline K's texture stage, against stand-in models (no call leaves the process): a plane's zones
 * read and judged in one call each, the answers split back to their zones and drawing what a call a zone draws; the
 * reader's answers kept by the plane's pixels and masks, given back while they are unchanged and asked again when one
 * changes; the process's call budget (in flight, per minute, per model) and a run's call meter; a material pick kept and
 * taken again by a class shown the same candidates, of its colour; and the calls a stand-in building takes before and after.
 */

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { checkFacadeReply, FACADE_READER_PARAMS, facadeReplyUsable, parseBatch, parseReading, readFacade, readPlanes, type FacadeAsk, type FacadePhoto, type ImageRegion } from '../src/node/3d-engine/staged-location/pipeline-k/facade-reader';
import { memoryReadingStore, planePixelsKey, type ModelReadingStore } from '../src/node/3d-engine/staged-location/pipeline-k/model-readings';
import { chooseWithMemory, swatchRows, type ChoiceRow, type SetChoice } from '../src/node/3d-engine/staged-location/pipeline-k/material-choice';
import { MessageChannel } from 'worker_threads';
import { budgetedClient, ModelCallBudget, ModelCallMeter, modelCallLimitsFromEnv, RemoteCallBudget, serveCallBudget } from '../src/node/gemini/model-call-budget';
import { VisionModelChain } from '../src/node/gemini/vision-model-chain';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';
import { decodePng } from '../src/node/texture-processing';

// a wall at 0.1 m a pixel: 5 bays of two windows 12 px wide, storeys every 38.4 px, windows 22 px tall; a 60 m wall's top 6 m never reached
const W = 300, H = 600, PITCH = 38.4, PHASE = 9, WIN_H = 22, PIXEL = 0.1, GREY_ROWS = 60;
const cols: Array<[number, number]> = [];
for (let b = 0; b < 5; b++) { const x = 18 + b * 56; cols.push([x, x + 12], [x + 20, x + 32]); }

function facade(width = W, height = H, grey = GREY_ROWS, seed = 12345): FacadePhoto {
    const rgba = new Uint8Array(width * height * 4);
    let s = seed;
    const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const p = (y * width + x) * 4;
        if (y < grey) { rgba.set([128, 128, 128, 255], p); continue; }
        const win = cols.some(([a, c]) => x >= a && x < c) && (((y - PHASE) % PITCH) + PITCH) % PITCH < WIN_H;
        const v = (win ? 70 : 190) + Math.round((rnd() - 0.5) * 30);
        rgba.set([v, v - 5, v - 10, 255], p);
    }
    return { rgba, width, height };
}

/** Each zone's own columns, by where its middle stands down a 60 m wall, so an answer drawn in the wrong zone shows. */
const zoneOf = (r: ImageRegion) => { const c = (r.y0 + r.y1) / 2; return c < 240 ? 0 : c < 420 ? 1 : 2; };
const ZONE_COLS = [[0, 1, 2, 3], [4, 5, 6, 7], [8, 9]];
const TINT = ['#100000', '#200000', '#300000'];

/**
 * A stand-in model that answers a question the same way whether it comes alone or in a batch: the overview splits a
 * 300 px wall into three zones (a 200 px one into two); a reading gives every whole row of its zone's own columns (those
 * the image holds) and its zone's tint; the judge accepts, the middle zone's first column rejected. A batch's entries
 * come back last first, each with its number.
 */
function oracle(opts: { leaveOut?: number; garble?: number } = {}): { ask: FacadeAsk; calls: string[] } {
    const calls: string[] = [];
    const reading = (r: ImageRegion) => {
        const ch = r.y1 - r.y0, cw = r.x1 - r.x0, rows = [];
        for (let k = -2; k < 20; k++) {
            const t = PHASE + k * PITCH, b = t + WIN_H;
            if (t < r.y0 || b > r.y1) continue;
            rows.push({ y: [((t - r.y0) / ch) * 1000, ((b - r.y0) / ch) * 1000], openings: ZONE_COLS[zoneOf(r)].map(i => cols[i]).filter(([, c]) => c <= r.x1).map(([a, c]) => ({ x: [((a - r.x0) / cw) * 1000, ((c - r.x0) / cw) * 1000], panes: 2 })) });
        }
        return { rows, glass: { label: 'stand-in', transparency: 0.6, reflectivity: 0.3, tint: TINT[zoneOf(r)], opaque: false }, conf: 85 };
    };
    const judgement = (r: ImageRegion) => ({ accept: true, badColumns: zoneOf(r) === 1 ? [1] : [], conf: 80 });
    const batch = (regions: ImageRegion[], one: (r: ImageRegion) => object) => JSON.stringify({ zones: regions.map((r, i) => ({ zone: i + 1, ...one(r) })).filter((_, i) => i !== opts.leaveOut).map((z, i) => (i === opts.garble ? { zone: z.zone, rows: 'x' } : z)).reverse() });
    const ask: FacadeAsk = async (_png, _prompt, kind, region, regions) => {
        calls.push(kind);
        if (kind === 'brief') return JSON.stringify({ building: 'a stand-in office block', families: [], conf: 80 });
        if (kind === 'overview') {
            const z = (t: number, b: number, openings = true) => ({ box: [0, t, 1000, b], openings });
            return JSON.stringify({ zones: region.x1 === W ? [z(0, 100, false), z(100, 400), z(400, 700), z(700, 1000)] : [z(0, 100, false), z(100, 400), z(400, 700)], conf: 90 });
        }
        if (kind === 'read') return JSON.stringify(reading(region));
        if (kind === 'judge') return JSON.stringify(judgement(region));
        if (kind === 'reads') return batch(regions!, reading);
        return batch(regions!, judgement);
    };
    return { ask, calls };
}

const frame = { facadeId: 7, image: 'f7.png', coverage: 0.9, width: W, height: H, pixel: PIXEL, orthoSMin: 0, orthoTMax: H * PIXEL, texel: PIXEL };
const P1 = { ...FACADE_READER_PARAMS, batchZones: false }, PN = { ...FACADE_READER_PARAMS, batchZones: true };

/** The photo with a 4 x 4 block of texels a shade off (enough to show on the brief's contact sheet too). */
function touched(img: FacadePhoto, x: number, y: number): FacadePhoto {
    const rgba = Uint8Array.from(img.rgba);
    for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) rgba[((y + dy) * img.width + x + dx) * 4] ^= 1;
    return { ...img, rgba };
}

/** A plane's orthos directory: each plane's photo, its frame, and (opt.) its occlusion mask. */
function planesDir(planes: Array<{ id: number; img: FacadePhoto; occluded?: Uint8Array }>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-calls-'));
    writePlanes(dir, planes);
    return dir;
}
function writePlanes(dir: string, planes: Array<{ id: number; img: FacadePhoto; occluded?: Uint8Array }>) {
    for (const p of planes) {
        fs.writeFileSync(path.join(dir, `f${p.id}.png`), encodePng(p.img.width, p.img.height, Uint8Array.from(p.img.rgba), 4));
        if (p.occluded) { const m = new Uint8Array(p.img.width * p.img.height * 4); p.occluded.forEach((v, k) => m.set([v, v, v, 255], k * 4)); fs.writeFileSync(path.join(dir, `f${p.id}_occ.png`), encodePng(p.img.width, p.img.height, m, 4)); }
    }
    fs.writeFileSync(path.join(dir, 'facades.json'), JSON.stringify({ facades: planes.map(p => ({ ...frame, facadeId: p.id, image: `f${p.id}.png`, width: p.img.width, height: p.img.height, orthoTMax: p.img.height * PIXEL, ...(p.occluded ? { occludedMask: `f${p.id}_occ.png` } : {}) })) }));
    fs.rmSync(path.join(dir, 'facade_reader.json'), { force: true });
}

describe('pipeline K model calls', () => {
    it("reads and judges a plane's zones in one call each, splits the answers back to their zones, and draws what a call a zone draws", async () => {
        const one = oracle(), batched = oracle();
        const r0 = await readFacade(facade(), undefined, frame, one.ask, P1);
        const r1 = await readFacade(facade(), undefined, frame, batched.ask, PN);
        expect([...one.calls].sort()).toEqual(['judge', 'judge', 'judge', 'overview', 'read', 'read', 'read']);
        expect(batched.calls).toEqual(['overview', 'reads', 'judges']);
        // the same accepted readings for the same answers
        expect(r1.record.zones).toEqual(r0.record.zones);
        expect(r1.rects).toEqual(r0.rects);
        expect(r1.panes).toEqual(r0.panes);
        expect(r1.glass).toEqual(r0.glass);
        // every zone drawn from its own answer: its own columns (the middle zone less the column its judge rejected) and its tint
        expect(r1.record.zones!.map(z => z.outcome)).toEqual(['drawn', 'drawn', 'drawn']);
        r1.record.zones!.forEach((z, k) => {
            const inZone = r1.rects!.filter(r => (r[1] + r[3]) / 2 >= z.region.y0 && (r[1] + r[3]) / 2 < z.region.y1);
            const want = ZONE_COLS[k].slice(k === 1 ? 1 : 0).map(i => cols[i][0]);
            expect(inZone.length).toBeGreaterThan(0);
            for (const r of inZone) expect(want.some(x => Math.abs(r[0] - x) <= 1)).toBe(true);
            expect(new Set(inZone.map(r => Math.round(r[0])))).toEqual(new Set(want));
            expect(r1.glass!.find(g => g.region.y0 === z.region.y0)!.glass.tint).toBe(TINT[k]);
        });
    });

    it('fails only the zones a batched answer leaves out or garbles, and keeps no part answer', async () => {
        const o = oracle({ leaveOut: 2, garble: 1 });
        const r = await readFacade(facade(), undefined, frame, o.ask, PN);
        // the one zone left is judged alone
        expect(o.calls).toEqual(['overview', 'reads', 'judge']);
        expect(r.record.zones!.map(z => z.outcome)).toEqual(['drawn', 'failed', 'failed']);
        expect(r.record.zones![1].why).toMatch(/^the reading failed: /);
        expect(r.record.zones![2].why).toBe('the reading failed: the reply gave this zone no answer');
        // placed by number, out of order; a zone answered twice is not taken
        const p = parseBatch('{"zones":[{"zone":2,"rows":[]},{"zone":1,"rows":[]},{"zone":2,"rows":[]},{"zone":9,"rows":[]}]}', 3, parseReading);
        expect(p[0]).toEqual({ rows: [], conf: 50 });
        expect(p[1]).toEqual({ failed: 'the reply answered this zone twice' });
        expect(p[2]).toEqual({ failed: 'the reply gave this zone no answer' });
        expect(() => parseBatch('{"rows":[]}', 2, parseReading)).toThrow();
        // usable (hedging, the store) only when every zone is answered well
        expect(facadeReplyUsable('reads', '{"zones":[{"zone":1,"rows":[]},{"zone":2,"rows":[]}]}', 2)).toBe(true);
        expect(facadeReplyUsable('reads', '{"zones":[{"zone":1,"rows":[]}]}', 2)).toBe(false);
        expect(() => checkFacadeReply('judges', '{"zones":[{"zone":1,"accept":true},{"zone":2}]}', 2)).toThrow(/zone 2/);
    });

    it("gives a plane's answers back from the store while its photo and masks are unchanged, and asks again when one changes", async () => {
        const wall = facade(), short = facade(W, 240, 0);
        const dir = planesDir([{ id: 7, img: wall }, { id: 8, img: short }]);
        try {
            const store = memoryReadingStore(), readings = { store, model: 'stand-in/thinking-512' };
            const run = async (o = oracle(), r = readings) => ({ o, out: await readPlanes(dir, o.ask, { readings: r }) });
            const first = await run();
            // the brief; the wall's overview, reads and judges; the short plane's read and judge
            expect([...first.o.calls].sort()).toEqual(['brief', 'judge', 'judges', 'overview', 'read', 'reads']);
            expect(first.out.records.calls).toEqual({ calls: 6, reused: 0 });
            // a rebuild (readOnTwin starts each in a fresh directory): nothing asked, the same readings drawn
            writePlanes(dir, [{ id: 7, img: wall }, { id: 8, img: short }]);
            const again = await run();
            expect(again.o.calls).toEqual([]);
            expect(again.out.records.calls).toEqual({ calls: 0, reused: 6 });
            expect(again.out.records.readings).toEqual(first.out.records.readings);
            expect(again.out.records.facades.map(f => f.zones)).toEqual(first.out.records.facades.map(f => f.zones));
            // a few texels of the short plane changed: it and the brief (its sheet shows them) are asked again, the wall is not
            const changed = touched(short, 150, 100);
            writePlanes(dir, [{ id: 7, img: wall }, { id: 8, img: changed }]);
            const one = await run();
            expect(one.o.calls.sort()).toEqual(['brief', 'judge', 'read']);
            expect(one.out.records.facades.find(f => f.facadeId === 7)).toMatchObject({ calls: 0, reused: 3 });
            expect(one.out.records.facades.find(f => f.facadeId === 8)).toMatchObject({ calls: 2 });
            // an occlusion mask with nothing blocked is no change; one that blocks part of the wall is
            writePlanes(dir, [{ id: 7, img: wall, occluded: new Uint8Array(W * H) }, { id: 8, img: changed }]);
            expect((await run()).o.calls).toEqual([]);
            const blocked = new Uint8Array(W * H);
            for (let k = 300 * W; k < 330 * W; k++) blocked[k] = 255;
            writePlanes(dir, [{ id: 7, img: wall, occluded: blocked }, { id: 8, img: changed }]);
            const occ = await run();
            expect(occ.out.records.facades.find(f => f.facadeId === 7)!.calls).toBeGreaterThan(0);
            expect(occ.out.records.facades.find(f => f.facadeId === 8)).toMatchObject({ calls: 0, reused: 2 });
            // another model: every answer asked again
            writePlanes(dir, [{ id: 7, img: wall, occluded: blocked }, { id: 8, img: changed }]);
            expect((await run(oracle(), { store, model: 'another-model' })).out.records.calls).toEqual({ calls: 6, reused: 0 });
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    it('keeps an answer whatever building context it was told, never a malformed one, and keys a plane by its pixels and masks', async () => {
        const store = memoryReadingStore(), img = facade(), memory = { store, model: 'm', plane: planePixelsKey(img) };
        const a = oracle(), b = oracle();
        const ra = await readFacade(img, undefined, frame, a.ask, PN, undefined, undefined, 'Building context: a bank', memory);
        const rb = await readFacade(img, undefined, frame, b.ask, PN, undefined, undefined, 'Building context: a school', memory);
        expect(a.calls.length).toBe(3);
        expect(b.calls).toEqual([]);
        expect(rb.rects).toEqual(ra.rects);
        expect(rb.record).toMatchObject({ calls: 0, reused: 3 });
        // a malformed overview is not kept: asked again
        const bad = memoryReadingStore(), m2 = { store: bad, model: 'm', plane: memory.plane };
        let n = 0;
        const garbled: FacadeAsk = async (...q) => { n++; return q[2] === 'overview' && n === 1 ? 'no json' : oracle().ask(...q); };
        expect((await readFacade(img, undefined, frame, garbled, PN, undefined, undefined, '', m2)).record.outcome).toBe('failed');
        expect((await readFacade(img, undefined, frame, garbled, PN, undefined, undefined, '', m2)).record.outcome).toBe('replaced');
        expect(n).toBe(4);
        // the key: pixels and the unread mask (none set is none)
        const mask = new Uint8Array(W * H);
        expect(planePixelsKey(img, mask)).toBe(planePixelsKey(img));
        mask[5] = 1;
        expect(planePixelsKey(img, mask)).not.toBe(planePixelsKey(img));
    });

    it("keeps each model's requests to the budget: in flight, per minute, per model; with none set nothing waits", async () => {
        const free = new ModelCallBudget();
        (await Promise.all(Array.from({ length: 50 }, () => free.acquire('m')))).forEach(release => release());
        expect(free.stats()).toEqual({});
        const b = new ModelCallBudget({ all: { inFlight: 2 }, byModel: new Map([['solo', { inFlight: 1 }]]) });
        const peak: Record<string, number> = {}, active: Record<string, number> = {};
        const run = async (m: string) => {
            const release = await b.acquire(m);
            active[m] = (active[m] ?? 0) + 1; peak[m] = Math.max(peak[m] ?? 0, active[m]);
            await new Promise(r => setTimeout(r, 3));
            active[m]--; release();
        };
        await Promise.all([...Array.from({ length: 8 }, () => run('m')), ...Array.from({ length: 4 }, () => run('solo'))]);
        expect(peak).toEqual({ m: 2, solo: 1 });
        // a waiting request whose call is stopped leaves the queue
        const held = await b.acquire('solo'), ctl = new AbortController(), waiting = b.acquire('solo', ctl.signal);
        ctl.abort(new Error('stopped'));
        await expect(waiting).rejects.toThrow('stopped');
        expect(b.stats().solo).toMatchObject({ active: 1, waiting: 0 });
        held();
        // per minute: the fourth waits until the first has left the window
        vi.useFakeTimers();
        try {
            const pm = new ModelCallBudget({ all: { perMinute: 3 }, byModel: new Map() }), got: number[] = [];
            for (let i = 0; i < 5; i++) void pm.acquire('m').then(release => { got.push(i); release(); });
            await vi.advanceTimersByTimeAsync(0);
            expect(got).toEqual([0, 1, 2]);
            await vi.advanceTimersByTimeAsync(59_999);
            expect(got).toEqual([0, 1, 2]);
            await vi.advanceTimersByTimeAsync(1);
            expect(got).toEqual([0, 1, 2, 3, 4]);
        } finally { vi.useRealTimers(); }
        // a build's thread asks the thread that started it: one budget for both, and the turns of a thread that ends let go
        const shared = new ModelCallBudget({ all: { inFlight: 1 }, byModel: new Map() }), channel = new MessageChannel();
        serveCallBudget(channel.port1, shared);
        const remote = new RemoteCallBudget(channel.port2);
        const local = await shared.acquire('m'), order: string[] = [];
        const far = remote.acquire('m').then(release => { order.push('remote'); return release; });
        await new Promise(r => setTimeout(r, 20));
        expect(order).toEqual([]);
        local();
        const farRelease = await far;
        expect(shared.stats().m).toMatchObject({ active: 1, waiting: 0 });
        farRelease();
        await new Promise(r => setTimeout(r, 20));
        expect(shared.stats().m.active).toBe(0);
        await remote.acquire('m');
        await new Promise(r => setTimeout(r, 20));
        expect(shared.stats().m.active).toBe(1);
        channel.port2.close();
        await new Promise(r => setTimeout(r, 20));
        expect(shared.stats().m.active).toBe(0);
        // from the environment
        const env = modelCallLimitsFromEnv({ SCRATCHBOX_MODEL_CALLS_IN_FLIGHT: '8', SCRATCHBOX_MODEL_CALLS_PER_MINUTE: '', SCRATCHBOX_MODEL_CALL_BUDGET: 'gemini-3.8-flash=16/600, gemini-4-argon=/60' });
        expect(env.all).toEqual({ inFlight: 8 });
        expect(env.byModel.get('gemini-3.8-flash')).toEqual({ inFlight: 16, perMinute: 600 });
        expect(env.byModel.get('gemini-4-argon')).toEqual({ perMinute: 60 });
        expect(new ModelCallBudget(env).limitsFor('other')).toEqual({ inFlight: 8 });
        expect(() => modelCallLimitsFromEnv({ SCRATCHBOX_MODEL_CALL_BUDGET: 'flash:3' })).toThrow(/model=inFlight\/perMinute/);
        expect(modelCallLimitsFromEnv({}).all).toEqual({});
    });

    it("counts a run's requests and their estimated cost through the wrapped client, and leaves the client's other parts as they were", async () => {
        let active = 0, peak = 0, fail = false;
        const usage = { promptTokenCount: 1000, candidatesTokenCount: 100, thoughtsTokenCount: 50 };
        const client = {
            vertexai: true,
            models: {
                other: () => 'kept',
                generateContent: async () => {
                    active++; peak = Math.max(peak, active);
                    await new Promise(r => setTimeout(r, 3));
                    active--;
                    if (fail) throw Object.assign(new Error('bad request'), { status: 400 });
                    return { candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }], usageMetadata: usage };
                },
                generateContentStream: async () => (async function* () { yield { candidates: [{ content: { parts: [{ text: '{' }] } }] }; yield { candidates: [{ content: { parts: [{ text: '}' }] } }], usageMetadata: usage }; })()
            }
        };
        const meter = new ModelCallMeter();
        const wrapped = budgetedClient(client as any, { budget: new ModelCallBudget({ all: { inFlight: 1 }, byModel: new Map() }), meter });
        expect(wrapped.vertexai).toBe(true);
        expect((wrapped.models as any).other()).toBe('kept');
        await Promise.all([1, 2, 3].map(() => wrapped.models.generateContent({ model: 'gemini-3.8-flash', contents: [] })));
        expect(peak).toBe(1);
        // through the model chain, as the build calls it
        const chain = new VisionModelChain<string>({ client: wrapped, candidates: ['gemini-3.8-flash'] });
        expect((await chain.generate({ contents: [{ role: 'user', parts: [{ text: 'q' }] }] }, { stage: 'grammar', stream: true })).response.candidates?.[0]?.content?.parts?.[0]?.text).toBe('{}');
        expect(chain.backend).toBe('vertex');
        fail = true;
        await expect(wrapped.models.generateContent({ model: 'gemini-4-argon', contents: [] })).rejects.toThrow('bad request');
        const r = meter.report({ 'gemini-3.8-flash': { inUsdPerM: 0.5, outUsdPerM: 3, source: 'test' } });
        expect(r.requests).toBe(5);
        expect(r.failed).toBe(1);
        expect(r.byModel['gemini-3.8-flash']).toMatchObject({ requests: 4, answered: 4, promptTokens: 4000, outputTokens: 400, thinkingTokens: 200, estimatedUsd: 0.0038 });
        expect(r.estimatedUsd).toBe(0.0038);
        expect(r.unpriced).toEqual(['gemini-4-argon']);
        expect(meter.report().priceError).toBeUndefined();
    });

    it('takes a kept material pick for a class shown the same candidates, of its colour, and asks only about the rest', async () => {
        const cands = (ids: string[]) => ids.map(id => ({ id, realSizeM: [1, 1] as [number, number], preview: { width: 2, height: 2, rgba: new Uint8Array(16).fill(128) } }));
        const rows = (stone: [number, number, number], dark: [number, number, number], brick: [number, number, number], stoneIds = ['stone1', 'stone2', 'stone3']): ChoiceRow[] => [
            { meanLinear: stone, candidates: cands(stoneIds) }, { meanLinear: dark, candidates: cands(['dark1', 'dark2']) }, { meanLinear: brick, candidates: cands(['brick1', 'brick2', 'brick3']) }];
        // a swatch sheet as classSwatchSheet lays it out: a row of cells a class, row k drawn in grey 40 (k + 1)
        const CELL = 16, GAP = 8, SW = 2 * (CELL + GAP) + GAP, SH = 3 * (CELL + GAP) + GAP;
        const px = new Uint8Array(SW * SH * 4).fill(255);
        for (let k = 0; k < 3; k++) for (let y = 0; y < CELL; y++) for (let x = GAP; x < SW - GAP; x++) px.set([40 * (k + 1), 40 * (k + 1), 40 * (k + 1), 255], ((GAP + k * (CELL + GAP) + y) * SW + x) * 4);
        const swatches = { png: Buffer.from(encodePng(SW, SH, px, 4)), spanM: 1.5 };
        const PICK: Record<string, number> = { stone1: 2, stone2: 1, dark1: 0, brick1: 3 };
        const asked: Array<{ rows: string[]; png: Buffer }> = [];
        const ask = async (rs: ChoiceRow[], sw: { png: Buffer }): Promise<Array<SetChoice | undefined>> => { asked.push({ rows: rs.map(r => r.candidates[0].id), png: sw.png }); return rs.map(r => ({ pick: PICK[r.candidates[0].id], seen: r.candidates[0].id, conf: 70 })); };
        const keys: string[] = [], inner = memoryReadingStore();
        const store: ModelReadingStore = { get: k => inner.get(k), put: (k, v) => { keys.push(k); inner.put(k, v); } };
        const memory = { store, model: 'stand-in' };
        const stone: [number, number, number] = [0.4, 0.38, 0.35], dark: [number, number, number] = [0.05, 0.05, 0.06], brick: [number, number, number] = [0.2, 0.12, 0.08];
        // the first building: every class asked, the request as before (the same rows, the same sheet)
        const first = await chooseWithMemory(rows(stone, dark, brick), swatches, ask, memory);
        expect(first).toMatchObject({ calls: 1, reused: 0 });
        expect(asked[0].rows).toEqual(['stone1', 'dark1', 'brick1']);
        expect(asked[0].png).toBe(swatches.png);
        expect(first.picks.map(p => p?.pick)).toEqual([2, 0, 3]);
        expect(keys.every(k => /^material-choice\/[0-9a-f]{64}$/.test(k))).toBe(true);
        // the next chunk, its classes a shade off: nothing asked, the same picks, each saying it was kept
        const scale = (c: [number, number, number], s: number) => c.map(v => v * s) as [number, number, number];
        const next = await chooseWithMemory(rows(scale(stone, 1.03), scale(dark, 1.03), scale(brick, 1.03)), swatches, ask, memory);
        expect(next).toMatchObject({ calls: 0, reused: 3 });
        expect(asked.length).toBe(1);
        expect(next.picks.map(p => p?.pick)).toEqual([2, 0, 3]);
        expect(next.picks.every(p => p!.reused && p!.reused.colourUnits < 1)).toBe(true);
        // a much lighter dark class is a new class: only it is asked, its swatches cut from the sheet
        const lighter = await chooseWithMemory(rows(stone, [0.3, 0.3, 0.3], brick), swatches, ask, memory);
        expect(lighter).toMatchObject({ calls: 1, reused: 2 });
        expect(asked[1].rows).toEqual(['dark1']);
        const cut = decodePng(asked[1].png);
        expect([cut.width, cut.height]).toEqual([SW, CELL + 2 * GAP]);
        expect(cut.rgba[(GAP * SW + GAP) * 4]).toBe(80);
        expect(lighter.picks[0]!.reused).toBeDefined();
        expect(lighter.picks[1]!.reused).toBeUndefined();
        // candidates in another order are another shortlist: asked
        await chooseWithMemory(rows(stone, dark, brick, ['stone2', 'stone1', 'stone3']), swatches, ask, memory);
        expect(asked[2].rows).toEqual(['stone2']);
        // without a store every class is asked every time
        await chooseWithMemory(rows(stone, dark, brick), swatches, ask);
        expect(asked[3].rows.length).toBe(3);
        // a sheet not laid out in n rows is not cut
        expect(swatchRows(swatches.png, 5, [0])).toBeUndefined();
    });

    it('takes fewer calls on a stand-in building: before, batched, rebuilt, one plane changed', async () => {
        // two 60 m walls of three zones, a 20 m wide one of two, two 24 m planes of one
        // each its own photo (the same photo twice would be the same questions, answered once)
        const planes = [{ id: 1, img: facade(W, H, GREY_ROWS, 1) }, { id: 2, img: facade(W, H, GREY_ROWS, 2) }, { id: 3, img: facade(200, H, GREY_ROWS, 3) }, { id: 4, img: facade(W, 240, 0, 4) }, { id: 5, img: facade(W, 240, 0, 5) }];
        const dir = planesDir(planes);
        try {
            const counted = async (params: typeof FACADE_READER_PARAMS, readings?: { store: ModelReadingStore; model: string }) => {
                writePlanes(dir, planes);
                const o = oracle(), out = await readPlanes(dir, o.ask, { params, ...(readings ? { readings } : {}) });
                return { calls: o.calls.length, out };
            };
            const before = await counted(P1);
            const store = memoryReadingStore(), readings = { store, model: 'stand-in' };
            const batched = await counted(PN, readings);
            const rebuilt = await counted(PN, readings);
            planes[3] = { id: 4, img: touched(planes[3].img, 150, 100) };
            const oneChanged = await counted(PN, readings);
            console.log(`[model calls] stand-in building of 5 planes: before ${before.calls}, batched ${batched.calls}, rebuilt ${rebuilt.calls}, one plane changed ${oneChanged.calls}`);
            expect([before.calls, batched.calls, rebuilt.calls, oneChanged.calls]).toEqual([24, 14, 0, 3]);
            // what is drawn does not depend on how it was asked
            expect(batched.out.records.readings).toEqual(before.out.records.readings);
            expect(rebuilt.out.records.readings).toEqual(before.out.records.readings);
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });
});
