/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The quality gate (quality-gate.ts, streaming.ts): a turn that made files is checked by an independent reviewer
 * against a bar read from the request, the agent revises at most MAX_GATE_ROUNDS times, then reports what is unmet.
 * The model calls are stubbed: tests never bill.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeminiService } from '../src/node/gemini-service';
import { GeminiClient } from '../src/node/gemini/gemini-client';
import { encodeRgbaToPng, resolveFfmpegPath } from '../src/node/image-codec-ffmpeg';
import {
    MAX_GATE_ROUNDS,
    deliverablePathsFromResult,
    deriveCriteria,
    filesToReview,
    formatReviewFeedback,
    formatReviewNotice,
    measureDeliverable,
    meanAbsDiff,
    qualityGateEnabled,
    reviewDeliverables
} from '../src/node/gemini/quality-gate';
import type { ToolContext } from '../src/node/gemini/tools/types';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qgate-'));

async function writeRgbaPng(file: string, w: number, h: number, alphaAt: (x: number, y: number) => number) {
    const rgba = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        rgba[i] = 200; rgba[i + 1] = 20; rgba[i + 2] = 20; rgba[i + 3] = alphaAt(x, y);
    }
    fs.writeFileSync(file, await encodeRgbaToPng(rgba, w, h));
}

/** A stub Gemini client: the bar call returns `criteria`, each review call the next verdict list. */
function stubModels(criteria: string[], verdictRounds: boolean[][]) {
    const calls: Array<{ system: string; parts: any[] }> = [];
    let review = 0;
    const models = {
        generateContent: async (params: any) => {
            const system = String(params.config?.systemInstruction ?? '');
            const parts = params.contents?.[0]?.parts ?? [];
            calls.push({ system, parts });
            if (/acceptance bar/.test(system)) return { text: JSON.stringify({ criteria }) };
            const round = verdictRounds[Math.min(review++, verdictRounds.length - 1)];
            return { text: JSON.stringify({ verdicts: criteria.map((c, i) => ({ criterion: c, met: round[i], where: `file, part ${i}`, reason: round[i] ? 'shown' : 'not shown' })) }) };
        }
    };
    return { client: { getGenAIClient: async () => ({ models }) as any }, calls };
}

describe('the gate is off under tests unless asked for, and can be turned off', () => {
    it('reads its switch', () => {
        expect(qualityGateEnabled({ VITEST: 'true' })).toBe(false);
        expect(qualityGateEnabled({ VITEST: 'true', SCRATCHBOX_QUALITY_GATE: '1' })).toBe(true);
        expect(qualityGateEnabled({})).toBe(true);
        expect(qualityGateEnabled({ SCRATCHBOX_QUALITY_GATE: '0' })).toBe(false);
    });
});

describe('which files a turn made', () => {
    it('finds media paths at any depth in a tool result, resolved against the roots, existing only', async () => {
        const repo = tmp();
        fs.mkdirSync(path.join(repo, 'build', 'generated-images'), { recursive: true });
        const png = path.join(repo, 'build', 'generated-images', 'car.png');
        fs.writeFileSync(png, 'x');
        const glb = path.join(repo, 'public', 'models', 'lamp.glb');
        fs.mkdirSync(path.dirname(glb), { recursive: true });
        fs.writeFileSync(glb, 'x');
        const found = deliverablePathsFromResult({
            outputPath: png,
            nested: { list: [{ matte: 'build/generated-images/car.png' }, { url: 'https://x/y.png' }] },
            glb: '/models/lamp.glb',
            missing: 'build/generated-images/none.png',
            text: 'notes.txt',
            modelImages: [{ path: png }]
        }, [repo, path.join(repo, 'public')]);
        expect(found).toEqual([png, glb]);
    });

    it('reviews the newest files first, at most four, always keeping the turn\'s first file', () => {
        expect(filesToReview(['/x/a.png', '/x/b.png', '/x/c.png'])).toEqual(['/x/c.png', '/x/b.png', '/x/a.png']);
        expect(filesToReview(['/x/plate.png', '/x/b.png', '/x/c.png', '/x/d.png', '/x/e.png'])).toEqual(['/x/e.png', '/x/d.png', '/x/c.png', '/x/plate.png']);
    });

    it('counts a file redone several times once, at its newest version', () => {
        // the car turn: the plate, then a matte and a cut-out redone in three folders
        const turn = ['/g/plate.png', '/g/v1/matte_0000.png', '/g/v1/cutout_0000.png', '/g/v2/matte_0000.png', '/g/v2/cutout_0000.png', '/g/v3/matte_0000.png', '/g/v3/cutout_0000.png'];
        expect(filesToReview(turn)).toEqual(['/g/v3/cutout_0000.png', '/g/v3/matte_0000.png', '/g/plate.png']);
    });
});

describe('what code measures', () => {
    it('states a cut-out\'s transparency, and says when a PNG has none', async () => {
        const dir = tmp();
        const cut = path.join(dir, 'cut.png');
        await writeRgbaPng(cut, 20, 10, x => (x < 5 ? 255 : 0));
        const opaque = path.join(dir, 'opaque.png');
        await writeRgbaPng(opaque, 20, 10, () => 255);
        const a = await measureDeliverable(cut, dir);
        expect(a.kind).toBe('image');
        expect(a.frames).toEqual([cut]);
        expect(a.facts).toContain('size: 20 x 10 px');
        expect(a.facts.find(f => f.startsWith('transparency'))).toBe('transparency: alpha 0-255, 25.0% of pixels opaque');
        const b = await measureDeliverable(opaque, dir);
        expect(b.facts).toContain('transparency: none (every pixel opaque)');
    });

    it('measures a video\'s real size and length, and whether anything changes between frames', async () => {
        const dir = tmp();
        const ffmpeg = resolveFfmpegPath();
        const still = path.join(dir, 'still.mp4');
        const moving = path.join(dir, 'moving.mp4');
        execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x180:d=2:r=10', '-pix_fmt', 'yuv420p', still]);
        execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=320x180:d=2:r=10', '-pix_fmt', 'yuv420p', moving]);
        const s = await measureDeliverable(still, dir);
        expect(s.kind).toBe('video');
        expect(s.facts.join(' | ')).toMatch(/size: 320 x 180 px \| duration: 2\.\d\d s/);
        expect(s.facts.find(f => f.startsWith('change'))).toMatch(/^change first->middle: 0\.0\/255, middle->last: 0\.0\/255/);
        expect(s.frames).toHaveLength(3);
        for (const f of s.frames) expect(fs.existsSync(f)).toBe(true);
        const m = await measureDeliverable(moving, dir);
        const change = Number(/first->middle: ([\d.]+)/.exec(m.facts.find(f => f.startsWith('change'))!)![1]);
        expect(change).toBeGreaterThan(1);
    }, 60_000);

    it('compares thumbnails', () => {
        expect(meanAbsDiff(new Uint8Array([0, 10, 20]), new Uint8Array([10, 10, 0]))).toBe(10);
    });
});

describe('the bar and the reviewer', () => {
    it('sets the bar from the request alone, with no image', async () => {
        const { client, calls } = stubModels(['The car is complete', 'The cut-out has transparency'], [[true, true]]);
        expect(await deriveCriteria(client, 'cut the car out on transparency')).toEqual(['The car is complete', 'The cut-out has transparency']);
        expect(calls[0].parts.some((p: any) => p.inlineData)).toBe(false);
        await expect(deriveCriteria({ getGenAIClient: async () => ({ models: { generateContent: async () => ({ text: '{}' }) } } as any) }, 'x')).rejects.toThrow(/no acceptance criteria/);
    });

    it('shows the reviewer the files, facts and claims, and maps its verdicts in order; a missing verdict is unmet', async () => {
        const dir = tmp();
        const png = path.join(dir, 'cut.png');
        await writeRgbaPng(png, 8, 8, () => 255);
        const models = { generateContent: async (p: any) => { seen = p; return { text: JSON.stringify({ verdicts: [{ met: true, reason: 'ok' }] }) }; } };
        let seen: any;
        const deliverable = await measureDeliverable(png, dir);
        const review = await reviewDeliverables({ getGenAIClient: async () => ({ models }) as any }, {
            request: 'cut it out', criteria: ['A', 'B'], deliverables: [deliverable], claims: 'I cleanly captured the car.'
        });
        expect(review.status).toBe('reviewed');
        if (review.status !== 'reviewed') return;
        expect(review.verdicts.map(v => v.met)).toEqual([true, false]);
        expect(review.verdicts[1].reason).toMatch(/no verdict/);
        const parts = seen.contents[0].parts;
        expect(parts.filter((p: any) => p.inlineData)).toHaveLength(1);
        const text = parts.map((p: any) => p.text ?? '').join('\n');
        expect(text).toContain('transparency: none (every pixel opaque)');
        expect(text).toContain('I cleanly captured the car.');
        expect(String(seen.config.systemInstruction)).toMatch(/claim is not evidence/);
    });

    it('is unavailable, with the reason, when no model client is configured', async () => {
        const review = await reviewDeliverables({ getGenAIClient: async () => undefined }, { request: 'x', criteria: ['A'], deliverables: [], claims: '' });
        expect(review).toMatchObject({ status: 'unavailable', error: expect.stringMatching(/no Google Cloud service account/) });
    });

    it('tells the agent to fix, and on the last round to report and claim nothing unmet', () => {
        const review = { status: 'reviewed' as const, criteria: ['A', 'B'], verdicts: [{ criterion: 'A', met: true, reason: 'ok' }, { criterion: 'B', met: false, where: 'matte.png, wheels', reason: 'the wheels are cut off' }], modelUsed: 'm', files: [] };
        expect(formatReviewFeedback(review, false)).toMatch(/1 of 2 criteria not met:[\s\S]*matte\.png, wheels[\s\S]*Fix these/);
        expect(formatReviewFeedback(review, true)).toMatch(/No revision rounds are left[\s\S]*do not claim them/);
        expect(formatReviewNotice(review, 1)).toContain('Independent review (m, round 1): 1 of 2 criteria met.\n- Met: A\n- Not met: B (matte.png, wheels: the wheels are cut off)');
    });
});

// ----------------------------------------------------------------------
// The loop, in the real chat engine
// ----------------------------------------------------------------------

const TOOL_CALL = (name: string) => `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name, args: {} } }] }, finishReason: 'STOP' }] })}\ndata: [DONE]`;
const TEXT = (t: string) => `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: t }] }, finishReason: 'STOP' }] })}\ndata: [DONE]`;

function makeService(turns: string[]) {
    const service = new GeminiService();
    (service as any).auth = { getClient: async () => ({ getAccessToken: async () => ({ token: 't' }) }) };
    (service as any).cachedProjectId = 'mock-project';
    const requests: any[] = [];
    (globalThis as any).fetch = async (_url: string, init: any) => {
        requests.push(JSON.parse(init.body));
        return { ok: true, status: 200, text: async () => turns[requests.length - 1] ?? TEXT('done'), body: null };
    };
    const register = (name: string, handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<any>) =>
        (service as any).toolRegistry.register(name, { name, description: name, parameters: { type: 'OBJECT', properties: {} } }, handler, 'workspace');
    return { service, requests, register };
}

describe('the review loop in a chat turn', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        delete process.env.SCRATCHBOX_QUALITY_GATE;
    });

    async function run(verdicts: boolean[][], withFile = true) {
        process.env.SCRATCHBOX_QUALITY_GATE = '1';
        const dir = tmp();
        const png = path.join(dir, 'cutout.png');
        await writeRgbaPng(png, 8, 8, x => (x < 4 ? 255 : 0));
        const stub = stubModels(['The whole car is inside the matte', 'The cut-out is on transparency'], verdicts);
        vi.spyOn(GeminiClient.prototype, 'getGenAIClient').mockImplementation(stub.client.getGenAIClient as never);
        const { service, requests, register } = makeService([TOOL_CALL('make_cutout'), TEXT('Done: the car is cleanly captured.'), TEXT('Fixed the wheels.'), TEXT('Final: the wheels are still cut off.')]);
        register('make_cutout', async () => ({ resultPayload: withFile ? { success: true, cutoutPath: png } : { success: true }, status: 'completed' }));
        const res = await service.streamGenerate({ prompt: 'cut the car out on transparency', model: 'gemini-3.7-flash', mode: 'agent' }, () => undefined);
        return { res, requests, calls: stub.calls };
    }

    it('ends after one review when every criterion is met, and says so', async () => {
        const { res, requests, calls } = await run([[true, true]]);
        expect(requests).toHaveLength(2);
        expect(calls.filter(c => /independent reviewer/.test(c.system))).toHaveLength(1);
        expect(res.text).toContain('2 of 2 criteria met');
    });

    it(`sends unmet criteria back at most ${MAX_GATE_ROUNDS} times, then makes the agent report them without another review`, async () => {
        const { res, requests, calls } = await run([[false, true], [false, true]]);
        expect(requests).toHaveLength(2 + MAX_GATE_ROUNDS);
        expect(calls.filter(c => /independent reviewer/.test(c.system))).toHaveLength(MAX_GATE_ROUNDS);
        expect(calls.filter(c => /acceptance bar/.test(c.system))).toHaveLength(1);
        const feedback1 = JSON.stringify(requests[2].contents.at(-1));
        expect(feedback1).toContain('[INDEPENDENT REVIEW]');
        expect(feedback1).toContain('Fix these with your tools');
        const feedback2 = JSON.stringify(requests[3].contents.at(-1));
        expect(feedback2).toContain('No revision rounds are left');
        expect(res.text).toContain('round 1): 1 of 2 criteria met');
        expect(res.text).toContain('round 2): 1 of 2 criteria met');
        expect(res.text).toContain('Final: the wheels are still cut off.');
        // the reviewer saw the maker's claim as a claim, and the file itself
        const review1 = calls.find(c => /independent reviewer/.test(c.system))!;
        expect(review1.parts.some((p: any) => p.inlineData)).toBe(true);
        expect(review1.parts.map((p: any) => p.text ?? '').join('\n')).toContain('the car is cleanly captured');
    });

    it('does not run when the turn made no files', async () => {
        const { requests, calls, res } = await run([[false, false]], false);
        expect(requests).toHaveLength(2);
        expect(calls).toHaveLength(0);
        expect(res.text).not.toContain('Independent review');
    });
});
