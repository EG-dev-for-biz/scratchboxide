/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The staged build's scheduling: the vision reply cache (an identical request is answered from the record, never a
 * model call), the survey's per-face calls running at once (wall time about one call, not four), the image caps, the
 * per-run grounding memo, and a figure spec the builder refuses asked again with the builder's reason. Fake model
 * clients only: no billed call.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { VisionModelChain, type VisionGenAIClient, type VisionReplyCache, type VisionReplyRecord } from '../src/node/gemini/vision-model-chain';
import { runFaceSurvey, footprintSurveyFaces } from '../src/node/3d-engine/staged-location/face-survey';
import { capImageSide, shrinkImage } from '../src/node/3d-engine/staged-location/ornament-batches';
import { memoizeGrounding, type PanoCandidate } from '../src/node/3d-engine/staged-location/streetview-evidence';
import { readFigure, type FigureImage } from '../src/node/3d-engine/staged-location/figures';
import { StageCache, stagedReplyCache } from '../src/node/3d-engine/staged-location/stage-cache';
import { decodeImageToRgba, imageContentSha256, readImageDimensions } from '../src/node/image-codec-ffmpeg';
import { performance } from 'perf_hooks';
import * as crypto from 'crypto';
import { bandJpeg, figuresReply, GREY, perFaceSurveyReply, SKY, STONE, surveyReply } from './helpers/photo-ornament-fixtures';
import { startLoadProbe } from './helpers/load-probe';

const memoryCache = (): VisionReplyCache & { map: Map<string, VisionReplyRecord> } => {
    const map = new Map<string, VisionReplyRecord>();
    return { map, get: k => map.get(k), put: (k, r) => { map.set(k, r); } };
};

/** A streaming client that answers after `delayMs`, counting calls; `answer` builds the reply text from the prompt. */
function slowClient(delayMs: number, answer: (params: any) => string): { client: VisionGenAIClient; calls: () => number; peak: () => number } {
    let calls = 0, active = 0, peak = 0;
    return {
        calls: () => calls, peak: () => peak,
        client: {
            models: {
                generateContent: async () => { throw new Error('streaming expected'); },
                generateContentStream: async (params: any) => {
                    calls++; active++; peak = Math.max(peak, active);
                    await new Promise(r => setTimeout(r, delayMs));
                    active--;
                    const text = answer(params);
                    return (async function* () { yield { candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }], modelVersion: `${params.model}-001`, usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10 } } as any; })();
                }
            }
        }
    };
}

const textOf = (params: any) => JSON.stringify(params.contents.flatMap((c: any) => c.parts.filter((p: any) => p.text).map((p: any) => p.text)));

describe('the vision reply cache', () => {
    it('answers an identical request from the record once it was remembered, restoring the model; an unremembered reply is asked again', async () => {
        const c = slowClient(1, () => '{"ok":1}');
        const cache = memoryCache();
        const req = { contents: [{ role: 'user', parts: [{ text: 'hello' }, { inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } }] }], config: { temperature: 0.2 } };
        const a = new VisionModelChain<string>({ client: c.client, candidates: ['m1'], replyCache: cache });
        const r1 = await a.generate(req, { stage: 's', thinkingBudget: 512, stream: true });
        expect(r1.cached).toBeUndefined();
        // not remembered: asked again
        const b = new VisionModelChain<string>({ client: c.client, candidates: ['m1'], replyCache: cache });
        const r2 = await b.generate(req, { stage: 's', thinkingBudget: 512, stream: true });
        expect(c.calls()).toBe(2);
        r2.remember();
        const d = new VisionModelChain<string>({ client: c.client, candidates: ['m1'], replyCache: cache });
        const r3 = await d.generate(req, { stage: 's', thinkingBudget: 512, stream: true });
        expect(c.calls()).toBe(2);
        expect(r3.cached).toBe(true);
        expect(r3.response.candidates![0].content!.parts![0].text).toBe('{"ok":1}');
        expect(r3.response.candidates![0].finishReason).toBe('STOP');
        expect(d.answeredModel).toBe('m1');
        expect(d.attempts).toEqual([expect.objectContaining({ model: 'm1', outcome: 'answered', cached: true })]);
        // another image, another request
        const e = new VisionModelChain<string>({ client: c.client, candidates: ['m1'], replyCache: cache });
        await e.generate({ ...req, contents: [{ role: 'user', parts: [{ text: 'hello' }, { inlineData: { mimeType: 'image/jpeg', data: 'AAAB' } }] }] }, { stage: 's', thinkingBudget: 512, stream: true });
        expect(c.calls()).toBe(3);
    });

    it('keeps the model passed over on record: a replayed answer still shows the fallback', async () => {
        const cache = memoryCache();
        const notFound: VisionGenAIClient = {
            models: {
                generateContent: async () => { throw new Error('streaming expected'); },
                generateContentStream: async (params: any) => {
                    if (params.model === 'gone') throw Object.assign(new Error('models/gone is not found for API version v1beta'), { status: 404 });
                    return (async function* () { yield { candidates: [{ content: { parts: [{ text: '{}' }] }, finishReason: 'STOP' }] } as any; })();
                }
            }
        };
        const req = { contents: [{ role: 'user', parts: [{ text: 'q' }] }] };
        const a = new VisionModelChain<string>({ client: notFound, candidates: ['gone', 'next'], replyCache: cache });
        (await a.generate(req, { stage: 's', stream: true })).remember();
        expect(a.skipped.map(x => x.model)).toEqual(['gone']);
        const b = new VisionModelChain<string>({ client: { models: { generateContent: async () => { throw new Error('no call expected'); } } }, candidates: ['gone', 'next'], replyCache: cache });
        const r = await b.generate(req, { stage: 's', stream: true });
        expect(r.cached).toBe(true);
        expect(b.answeredModel).toBe('next');
        expect(b.skipped.map(x => x.model)).toEqual(['gone']);
    });

    it('lives in the stage cache on disk (text only)', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-reply-cache-'));
        try {
            const cache = new StageCache({ workspaceRoot: root });
            const c = slowClient(1, () => '{"a":2}');
            const req = { contents: [{ role: 'user', parts: [{ text: 'x' }, { inlineData: { mimeType: 'image/jpeg', data: Buffer.alloc(64, 7).toString('base64') } }] }] };
            (await new VisionModelChain<string>({ client: c.client, candidates: ['m'], replyCache: stagedReplyCache(cache) }).generate(req, { stage: 's', stream: true })).remember();
            const r = await new VisionModelChain<string>({ client: c.client, candidates: ['m'], replyCache: stagedReplyCache(cache) }).generate(req, { stage: 's', stream: true });
            expect(r.cached).toBe(true);
            expect(c.calls()).toBe(1);
            const files = fs.readdirSync(path.join(cache.dir, 'vision-reply'));
            expect(files.length).toBe(1);
            const done = fs.readFileSync(path.join(cache.dir, 'vision-reply', files[0], 'done.json'), 'utf8');
            expect(done).not.toMatch(/BwcHBw/); // no image bytes
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});

describe('a call whose first token is late is sent once more', () => {
    /** A client whose first request never gets its first token (until aborted); later ones answer after `ms`. */
    function stuckFirst(ms: number) {
        let n = 0, aborted = 0;
        const client: VisionGenAIClient = { models: { generateContent: async () => { throw new Error('streaming expected'); }, generateContentStream: async (params: any) => {
            const k = n++;
            const signal: AbortSignal | undefined = params.config?.abortSignal;
            return (async function* () {
                if (k === 0) {
                    await new Promise((_, reject) => signal?.addEventListener('abort', () => { aborted++; reject(signal.reason); }, { once: true }));
                }
                await new Promise(r => setTimeout(r, ms));
                yield { candidates: [{ content: { parts: [{ text: `{"from":${k}}` }] }, finishReason: 'STOP' }] } as any;
            })();
        } } };
        return { client, calls: () => n, aborted: () => aborted };
    }

    it('takes the second request\'s answer and aborts the first; the attempt says it was hedged', async () => {
        const c = stuckFirst(20);
        const chain = new VisionModelChain<string>({ client: c.client, candidates: ['m'], hedgeAfterMs: 100 });
        const t0 = Date.now();
        const r = await chain.generate({ contents: [{ role: 'user', parts: [{ text: 'q' }] }] }, { stage: 's', stream: true });
        expect(Date.now() - t0).toBeLessThan(2000);
        expect(r.response.candidates![0].content!.parts![0].text).toBe('{"from":1}');
        expect(c.calls()).toBe(2);
        expect(c.aborted()).toBe(1);
        expect(chain.attempts[0]).toMatchObject({ outcome: 'answered', hedged: true, hedgeWon: true });
    });

    it('sends nothing more when the first token comes in time', async () => {
        const c = slowClient(10, () => '{}');
        const chain = new VisionModelChain<string>({ client: c.client, candidates: ['m'], hedgeAfterMs: 500 });
        await chain.generate({ contents: [{ role: 'user', parts: [{ text: 'q' }] }] }, { stage: 's', stream: true });
        await new Promise(r => setTimeout(r, 600));
        expect(c.calls()).toBe(1);
        expect(chain.attempts[0].hedged).toBeUndefined();
    });
});

describe('an image is known by its content, not its metadata', () => {
    /** The JPEG with an APP11 segment of `payload` after SOI, as the grounding API signs each answer afresh. */
    const resigned = (jpeg: Buffer, payload: Buffer) => {
        const len = Buffer.alloc(2); len.writeUInt16BE(payload.length + 2);
        return Buffer.concat([jpeg.subarray(0, 2), Buffer.from([0xff, 0xeb]), len, payload, jpeg.subarray(2)]);
    };
    it('the same pixels with differently signed metadata have one digest (and one reply cache key); other pixels another', async () => {
        const img = bandJpeg([SKY, STONE]);
        const a = resigned(img, crypto.randomBytes(300)), b = resigned(img, crypto.randomBytes(300));
        expect(crypto.createHash('sha256').update(a).digest('hex')).not.toBe(crypto.createHash('sha256').update(b).digest('hex'));
        expect(imageContentSha256(a)).toBe(imageContentSha256(b));
        expect(imageContentSha256(a)).toBe(imageContentSha256(img));
        expect(imageContentSha256(bandJpeg([SKY, GREY]))).not.toBe(imageContentSha256(img));
        const c = slowClient(1, () => '{}');
        const cache = memoryCache();
        const req = (bytes: Buffer) => ({ contents: [{ role: 'user', parts: [{ text: 'q' }, { inlineData: { mimeType: 'image/jpeg', data: bytes.toString('base64') } }] }] });
        (await new VisionModelChain<string>({ client: c.client, candidates: ['m'], replyCache: cache }).generate(req(a), { stage: 's', stream: true })).remember();
        const r = await new VisionModelChain<string>({ client: c.client, candidates: ['m'], replyCache: cache }).generate(req(b), { stage: 's', stream: true });
        expect(r.cached).toBe(true);
        expect(c.calls()).toBe(1);
    });
});

describe('the survey: one call per face, all at once', () => {
    const STRUCTURE = { outline: [[-13.15, -5.5], [13.15, -5.5], [13.15, 5.5], [-13.15, 5.5]] as Array<[number, number]>, centroid: { x: 0, z: 0 }, facadeHeadingsDeg: [0, 90, 180, 270], cells: new Set<string>(), groundY: 0, heightM: 24.4 };
    const GROUND = { cellIndex: () => -1, groundAt: () => 0 };
    const pano = (id: string, x: number, z: number): PanoCandidate => ({ panoId: id, lat: 0, lng: 0, x, z, date: '2025-06', copyright: '© Google' });
    const PANOS = [pano('N1', 0, -34), pano('E1', 44, 1), pano('S1', -4, 38), pano('W1', -46, -2)];
    const faces = footprintSurveyFaces(STRUCTURE);
    const fetched: Array<{ fov: number }> = [];
    const grounding = { retrieveGroundingImage: async (req: any) => { fetched.push({ fov: req.fovDegree }); return { image: bandJpeg([SKY, STONE, GREY], 2048, 1536), mimeType: 'image/jpeg', panoId: req.panoId, headingDegree: req.headingDegree, pitchDegree: req.pitchDegree, fovDegree: req.fovDegree }; } };

    it('the four calls overlap (wall time about one call), each sends one image at most 1024 px long, and a rerun reads them all back with the same result', async () => {
        const DELAY = 400;
        const c = slowClient(DELAY, params => JSON.stringify(perFaceSurveyReply(surveyReply(), textOf(params))));
        const cache = memoryCache();
        const sent: Array<[number, number]> = [];
        const watch: VisionGenAIClient = { models: { generateContent: c.client.models.generateContent, generateContentStream: async (p: any) => {
            for (const part of p.contents[0].parts) if (part.inlineData) { const d = readImageDimensions(Buffer.from(part.inlineData.data, 'base64'))!; sent.push([d.width, d.height]); }
            return c.client.models.generateContentStream!(p);
        } } };
        const input = () => ({ faces, panos: PANOS, structure: STRUCTURE, ground: GROUND, top: new Float32Array(0), deps: { mapsApiKey: 'k', grounding } });
        // the survey's own work (the decode, the downscale and the palettes) on this host: the same survey with calls that answer at once
        const instant = slowClient(0, params => JSON.stringify(perFaceSurveyReply(surveyReply(), textOf(params))));
        const w0 = Date.now();
        await runFaceSurvey({ ...input(), chain: new VisionModelChain<string>({ client: instant.client, candidates: ['gemini-4-argon'], replyCache: memoryCache() }) });
        const workMs = Date.now() - w0;
        expect(instant.calls()).toBe(4);
        const probe = startLoadProbe();
        const t0 = Date.now();
        const cold = await runFaceSurvey({ ...input(), chain: new VisionModelChain<string>({ client: watch, candidates: ['gemini-4-argon'], replyCache: cache }) });
        const coldMs = Date.now() - t0;
        const load = await probe.stop();
        expect(c.calls()).toBe(4);
        expect(c.peak()).toBe(4);
        // the sum would be 4 x DELAY over the survey's own work; at once it is about one DELAY over it (that work run as much
        // slower as the suite's other forks make CPU work while it runs)
        expect(coldMs, JSON.stringify({ ...load, workMs })).toBeLessThan(workMs * load.slowdown + 2 * DELAY);
        expect(sent.length).toBe(4);
        for (const [w, h] of sent) expect(Math.max(w, h)).toBe(1024);
        // the full image stays in hand for the palette and registration
        expect(cold.read.every(r => r.widthPx === 2048)).toBe(true);
        expect(cold.cost).toMatchObject({ images: 4, visionCalls: 4 });
        const warm = await runFaceSurvey({ ...input(), chain: new VisionModelChain<string>({ client: watch, candidates: ['gemini-4-argon'], replyCache: cache }) });
        expect(c.calls()).toBe(4);
        expect(warm.faces).toEqual(cold.faces);
        expect(warm.read).toEqual(cold.read);
        expect(warm.model.used).toBe('gemini-4-argon');
    });

    it('a face whose call fails is left out with why; the others stand', async () => {
        let n = 0;
        const flaky: VisionGenAIClient = { models: { generateContent: async () => { throw new Error('streaming expected'); }, generateContentStream: async (p: any) => {
            if (/outward direction is 90°/.test(textOf(p))) { n++; throw Object.assign(new Error('400 bad request'), { status: 400 }); }
            const text = JSON.stringify(perFaceSurveyReply(surveyReply(), textOf(p)));
            return (async function* () { yield { candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] } as any; })();
        } } };
        const r = await runFaceSurvey({ faces, panos: PANOS, structure: STRUCTURE, ground: GROUND, top: new Float32Array(0), deps: { mapsApiKey: 'k', grounding }, chain: new VisionModelChain<string>({ client: flaky, candidates: ['m'] }) });
        expect(n).toBe(1);
        const east = r.faces.find(f => f.headingDeg === 90)!;
        expect(east.skipped).toMatch(/its reading failed/);
        expect(r.faces.filter(f => !f.skipped).length).toBe(3);
        expect(r.read.length).toBe(3);
    });
});

describe('image caps and the per-run grounding memo', () => {
    it('caps a JPEG to its longest side and leaves a small one as it came', async () => {
        const big = bandJpeg([SKY, STONE], 1920, 1440);
        const capped = await capImageSide(big, 'image/jpeg', 1920, 1440, 1024);
        expect(capped).toMatchObject({ widthPx: 1024, heightPx: 768, downscaled: true, mimeType: 'image/jpeg' });
        expect(readImageDimensions(capped.bytes)).toEqual({ width: 1024, height: 768 });
        // deterministic: the same bytes in, the same bytes out (the reply cache keys on them)
        expect((await capImageSide(big, 'image/jpeg', 1920, 1440, 1024)).bytes.equals(capped.bytes)).toBe(true);
        const small = bandJpeg([SKY], 320, 240);
        expect((await capImageSide(small, 'image/jpeg', 320, 240, 1024)).bytes).toBe(small);
    });

    it('shrinks a JPEG in ffmpeg: colours kept, and the thread runs no pixel loop (live: ~0.5 s blocked per reading)', async () => {
        const big = bandJpeg([SKY, STONE, GREY], 1920, 1440);
        const small = await shrinkImage(big, 1024);
        expect(small).toMatchObject({ widthPx: 1024, heightPx: 768, fromPx: [1920, 1440] });
        // the bands keep their colour (area average in the Y'CbCr planes, full range: no shift)
        const a = await decodeImageToRgba(big), b = await decodeImageToRgba(small!.bytes);
        const meanAt = (img: { rgba: Uint8Array | Buffer; width: number; height: number }, fy: number) => {
            const y = Math.floor(img.height * fy), s = [0, 0, 0];
            for (let x = 0; x < img.width; x++) for (let c = 0; c < 3; c++) s[c] += img.rgba[(y * img.width + x) * 4 + c];
            return s.map(v => v / img.width);
        };
        for (const fy of [1 / 6, 0.5, 5 / 6]) {
            const [p, q] = [meanAt(a, fy), meanAt(b, fy)];
            for (let c = 0; c < 3; c++) expect(Math.abs(p[c] - q[c])).toBeLessThan(4);
        }
        // eight close-ups at once: the event loop's active time stays small (the in-thread decode/average/encode used ~60 ms
        // each). The measure is against what the thread would spend just decoding the eight in-process, taken right before
        // in the same conditions: ~20 ms against ~180 ms idle; under the suite's load both grow, the pipe wake-ups most.
        const imgs = Array.from({ length: 8 }, (_, k) => bandJpeg([SKY, k % 2 ? STONE : GREY, STONE], 1920, 1440));
        const beforeDecode = performance.eventLoopUtilization();
        for (const im of imgs) await decodeImageToRgba(im);
        const inThread = performance.eventLoopUtilization(beforeDecode);
        const before = performance.eventLoopUtilization();
        const out = await Promise.all(imgs.map(im => shrinkImage(im, 1024)));
        const elu = performance.eventLoopUtilization(before);
        expect(out.every(o => o && readImageDimensions(o.bytes)?.width === 1024)).toBe(true);
        expect(elu.active, `shrink ${elu.active.toFixed(1)} ms active, in-thread decode ${inThread.active.toFixed(1)} ms`).toBeLessThan(inThread.active);
    });

    it('one grounding request per view: a prefetched view is handed over, a failed one is asked again', async () => {
        let calls = 0, fail = true;
        const g = memoizeGrounding({ retrieveGroundingImage: async (req: any) => {
            calls++;
            await new Promise(r => setTimeout(r, 20));
            if (req.panoId === 'BAD' && fail) { fail = false; throw new Error('503'); }
            return { image: bandJpeg([SKY]), mimeType: 'image/jpeg', panoId: req.panoId, headingDegree: req.headingDegree, pitchDegree: req.pitchDegree, fovDegree: req.fovDegree } as any;
        } });
        const req = { panoId: 'P', headingDegree: 10, pitchDegree: -5, fovDegree: 60, aspectRatio: 'RATIO_4X3' } as any;
        const [a, b] = await Promise.all([g.retrieveGroundingImage(req), g.retrieveGroundingImage({ ...req })]);
        expect(a).toBe(b);
        expect(calls).toBe(1);
        await g.retrieveGroundingImage(req);
        expect(calls).toBe(1);
        expect(g.prefetched()).toBe(2);
        await g.retrieveGroundingImage({ ...req, fovDegree: 30 });
        expect(calls).toBe(2);
        await expect(g.retrieveGroundingImage({ ...req, panoId: 'BAD' })).rejects.toThrow('503');
        await g.retrieveGroundingImage({ ...req, panoId: 'BAD' });
        expect(calls).toBe(4);
    });
});

describe('a figure spec the builder refuses', () => {
    it('is asked again with the builder\'s reason as a follow-up to the reply it refused, and the second spec is built', async () => {
        const prompts: any[] = [];
        const c: VisionGenAIClient = { models: { generateContent: async () => { throw new Error('streaming expected'); }, generateContentStream: async (p: any) => {
            prompts.push(p);
            const text = JSON.stringify(figuresReply([0]));
            return (async function* () { yield { candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] } as any; })();
        } } };
        const image: FigureImage = {
            index: 0, bytes: bandJpeg([SKY, STONE]), mimeType: 'image/jpeg', widthPx: 320, heightPx: 240,
            blob: { regionId: 'r0', triangles: 400, min: [0, 0, 0], max: [1, 2, 1], centre: [0.5, 1, 0.5], axisDeg: 0, alongM: 0.6, acrossM: 0.4, heightM: 2, pedestal: { surfaceId: 's01', topY: 0, contactM: 0.5 } } as any,
            view: { panoId: 'P0', eye: [0, 2, 20], headingDeg: 0, pitchDeg: 10, fovDeg: 40, aspectRatio: 'RATIO_3X4', distanceM: 20, regionId: 'r0' } as any
        };
        let builds = 0;
        const out = await readFigure({
            image, chain: new VisionModelChain<string>({ client: c, candidates: ['m'] }),
            build: async () => { if (builds++ === 0) throw new Error('part "arm" is detached from its parent'); return 'built'; }
        });
        expect(out.built).toBe('built');
        expect(out.calls).toBe(2);
        expect(prompts.length).toBe(2);
        expect(prompts[0].contents.length).toBe(1);
        // the retry: the refused reply as the model's turn, then the builder's reason
        expect(prompts[1].contents.length).toBe(3);
        expect(prompts[1].contents[1].role).toBe('model');
        expect(prompts[1].contents[2].parts[0].text).toMatch(/The builder could not build that spec: part "arm" is detached from its parent/);
    });
});
