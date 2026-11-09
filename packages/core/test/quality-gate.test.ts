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
 * against a bar read from the request and scores each criterion 1-10; a result passes with none under 6 and a mean of
 * 7 or more. The agent revises until it passes or the gate stops (round limit, no improvement, time), then reports.
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
    GATE_MAX_MS,
    GATE_STALL_ROUNDS,
    MAX_GATE_ROUNDS,
    MAX_REVIEW_FIXES,
    deliverablePathsFromResult,
    deriveCriteria,
    filesToReview,
    formatReviewFeedback,
    formatReviewNotice,
    gateStopReason,
    passBar,
    scoredVerdict,
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
function stubModels(criteria: string[], scoreRounds: number[][]) {
    const calls: Array<{ system: string; parts: any[] }> = [];
    let review = 0;
    const models = {
        generateContent: async (params: any) => {
            const system = String(params.config?.systemInstruction ?? '');
            const parts = params.contents?.[0]?.parts ?? [];
            calls.push({ system, parts });
            if (/acceptance bar/.test(system)) return { text: JSON.stringify({ criteria }) };
            const round = scoreRounds[Math.min(review++, scoreRounds.length - 1)];
            return {
                text: JSON.stringify({
                    verdicts: criteria.map((c, i) => ({ criterion: c, score: round[i], where: `file, part ${i}`, reason: round[i] >= 6 ? 'shown' : 'not shown' })),
                    fixes: [1, 2, 3, 4, 5, 6, 7].map(n => ({ fix: `fix ${n}`, where: `place ${n}` }))
                })
            };
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
        const { client, calls } = stubModels(['The car is complete', 'The cut-out has transparency'], [[8, 8]]);
        expect(await deriveCriteria(client, 'cut the car out on transparency')).toEqual(['The car is complete', 'The cut-out has transparency']);
        expect(calls[0].parts.some((p: any) => p.inlineData)).toBe(false);
        await expect(deriveCriteria({ getGenAIClient: async () => ({ models: { generateContent: async () => ({ text: '{}' }) } } as any) }, 'x')).rejects.toThrow(/no acceptance criteria/);
    });

    it('shows the reviewer the files, facts and claims; scores each criterion in order; hands back at most five ranked fixes', async () => {
        const dir = tmp();
        const png = path.join(dir, 'cut.png');
        await writeRgbaPng(png, 8, 8, () => 255);
        const { client, calls } = stubModels(['A', 'B'], [[9, 4]]);
        const deliverable = await measureDeliverable(png, dir);
        const review = await reviewDeliverables(client, { request: 'cut it out', criteria: ['A', 'B'], deliverables: [deliverable], claims: 'I cleanly captured the car.' });
        expect(review.status).toBe('reviewed');
        if (review.status !== 'reviewed') return;
        expect(review.verdicts.map(v => [v.score, v.met])).toEqual([[9, true], [4, false]]);
        expect(review.meanScore).toBe(6.5);
        expect(review.passed).toBe(false);
        expect(review.fixes).toHaveLength(MAX_REVIEW_FIXES);
        expect(review.fixes.map(f => f.fix)).toEqual(['fix 1', 'fix 2', 'fix 3', 'fix 4', 'fix 5']);
        const parts = calls[0].parts;
        expect(parts.filter((p: any) => p.inlineData)).toHaveLength(1);
        const text = parts.map((p: any) => p.text ?? '').join('\n');
        expect(text).toContain('transparency: none (every pixel opaque)');
        expect(text).toContain('I cleanly captured the car.');
        expect(calls[0].system).toMatch(/claim is not evidence/);
        expect(calls[0].system).toMatch(/Score each criterion from 1 to 10/);
    });

    it('reads a score defensively: clamped and rounded, an old met-only answer, a missing entry', () => {
        expect(scoredVerdict('a', { score: 14 }).score).toBe(10);
        expect(scoredVerdict('a', { score: 0 }).score).toBe(1);
        expect(scoredVerdict('a', { score: '6.6' })).toMatchObject({ score: 7, met: true });
        expect(scoredVerdict('a', { met: true })).toMatchObject({ score: 7, met: true });
        expect(scoredVerdict('a', { met: false })).toMatchObject({ score: 3, met: false });
        expect(scoredVerdict('a', undefined)).toMatchObject({ score: 1, met: false, reason: expect.stringMatching(/no verdict/) });
    });

    it('passes only with no criterion under 6 and a mean of 7 or more', () => {
        const v = (scores: number[]) => scores.map((score, i) => scoredVerdict(`c${i}`, { score }));
        expect(passBar(v([8, 7, 9]))).toEqual({ meanScore: 8, passed: true });
        expect(passBar(v([10, 10, 5]))).toEqual({ meanScore: 8.3, passed: false });
        expect(passBar(v([6, 6, 7]))).toEqual({ meanScore: 6.3, passed: false });
        expect(passBar([])).toEqual({ meanScore: 0, passed: false });
    });

    it('stops revising at the round limit, after rounds with no improvement, or at the time limit', () => {
        expect(gateStopReason([5], 0)).toBeUndefined();
        expect(gateStopReason([5, 5.5, 6], 0)).toBeUndefined();
        expect(gateStopReason([5, 5, 5], 0)).toMatch(new RegExp(`${GATE_STALL_ROUNDS} rounds in a row brought no improvement`));
        expect(gateStopReason([5, 6, 5.9, 6], 0)).toMatch(/round/);
        expect(gateStopReason(Array.from({ length: MAX_GATE_ROUNDS }, (_, i) => 3 + i), 0)).toMatch(new RegExp(`${MAX_GATE_ROUNDS} review rounds were used`));
        expect(gateStopReason([5], GATE_MAX_MS)).toMatch(/time limit/);
    });

    it('is unavailable, with the reason, when no model client is configured', async () => {
        const review = await reviewDeliverables({ getGenAIClient: async () => undefined }, { request: 'x', criteria: ['A'], deliverables: [], claims: '' });
        expect(review).toMatchObject({ status: 'unavailable', error: expect.stringMatching(/no Google Cloud service account/) });
    });

    it('tells the agent the low criteria and the ranked fixes; when stopped, to report and claim nothing under the bar', () => {
        const verdicts = [scoredVerdict('A', { score: 9, reason: 'ok' }), scoredVerdict('B', { score: 4, where: 'matte.png, wheels', reason: 'the wheels are cut off' })];
        const review = { status: 'reviewed' as const, criteria: ['A', 'B'], verdicts, ...passBar(verdicts), fixes: [{ fix: 'extend the matte over the wheels', where: 'matte.png' }], modelUsed: 'm', files: [] };
        expect(formatReviewFeedback(review)).toMatch(/mean 6\.5\/10, not passed[\s\S]*1 of 2 criteria under 6[\s\S]*4\/10 B[\s\S]*matte\.png, wheels[\s\S]*1\. extend the matte over the wheels \(matte\.png\)[\s\S]*Make these fixes/);
        expect(formatReviewFeedback(review, '2 rounds in a row brought no improvement')).toMatch(/No further revision: 2 rounds in a row brought no improvement[\s\S]*do not claim them/);
        expect(formatReviewNotice(review, 1)).toContain('Independent review (m, round 1): mean 6.5/10, not passed (pass: none under 6, mean 7 or more).\n- 9/10 Met: A\n- 4/10 Not met: B (matte.png, wheels: the wheels are cut off)\nFixes asked for, most important first:\n1. extend the matte over the wheels (matte.png)');
        // every criterion clears 6 but the mean does not: the weakest are named
        const close = [scoredVerdict('A', { score: 6 }), scoredVerdict('B', { score: 7 })];
        expect(formatReviewFeedback({ ...review, verdicts: close, ...passBar(close) })).toMatch(/Every criterion clears 6, but the mean is under 7; the weakest:\n1\. 6\/10 A/);
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

    async function run(scores: number[][], withFile = true) {
        process.env.SCRATCHBOX_QUALITY_GATE = '1';
        const dir = tmp();
        const png = path.join(dir, 'cutout.png');
        await writeRgbaPng(png, 8, 8, x => (x < 4 ? 255 : 0));
        const stub = stubModels(['The whole car is inside the matte', 'The cut-out is on transparency'], scores);
        vi.spyOn(GeminiClient.prototype, 'getGenAIClient').mockImplementation(stub.client.getGenAIClient as never);
        const turns = [TOOL_CALL('make_cutout'), TEXT('Done: the car is cleanly captured.'), ...Array.from({ length: 6 }, (_, k) => TEXT(`Revision ${k + 1}.`))];
        const { service, requests, register } = makeService(turns);
        register('make_cutout', async () => ({ resultPayload: withFile ? { success: true, cutoutPath: png } : { success: true }, status: 'completed' }));
        const res = await service.streamGenerate({ prompt: 'cut the car out on transparency', model: 'gemini-3.7-flash', mode: 'agent' }, () => undefined);
        const reviews = stub.calls.filter(c => /independent reviewer/.test(c.system));
        return { res, requests, calls: stub.calls, reviews };
    }

    it('ends after one review when the result clears the bar, and says so', async () => {
        const { res, requests, reviews } = await run([[8, 9]]);
        expect(requests).toHaveLength(2);
        expect(reviews).toHaveLength(1);
        expect(res.text).toContain('mean 8.5/10, passed');
    });

    it('keeps revising while the score improves, and ends when the result passes', async () => {
        const { res, requests, reviews } = await run([[4, 8], [5, 8], [8, 8]]);
        expect(reviews).toHaveLength(3);
        expect(requests).toHaveLength(4);
        expect(res.text).toContain('round 3): mean 8.0/10, passed');
        const feedback1 = JSON.stringify(requests[2].contents.at(-1));
        expect(feedback1).toContain('[INDEPENDENT REVIEW]');
        expect(feedback1).toContain('Make these fixes');
        expect(feedback1).toContain('fix 1');
        expect(feedback1).not.toContain('fix 6');
    });

    it(`stops after ${GATE_STALL_ROUNDS} rounds with no improvement and makes the agent report without another review`, async () => {
        const { res, requests, calls, reviews } = await run([[4, 8], [4, 8], [4, 8]]);
        expect(reviews).toHaveLength(1 + GATE_STALL_ROUNDS);
        expect(requests).toHaveLength(2 + 1 + GATE_STALL_ROUNDS);
        expect(calls.filter(c => /acceptance bar/.test(c.system))).toHaveLength(1);
        expect(JSON.stringify(requests.at(-1).contents.at(-1))).toContain('No further revision: 2 rounds in a row brought no improvement');
        expect(res.text).toContain('Revision 3.');
        // the reviewer saw the maker's claim as a claim, and the file itself
        expect(reviews[0].parts.some((p: any) => p.inlineData)).toBe(true);
        expect(reviews[0].parts.map((p: any) => p.text ?? '').join('\n')).toContain('the car is cleanly captured');
    });

    it(`stops at ${MAX_GATE_ROUNDS} rounds when the score keeps rising but never passes`, async () => {
        const { requests, reviews } = await run([[2, 8], [3, 8], [4, 8], [5, 8], [5.9, 8]]);
        expect(reviews).toHaveLength(MAX_GATE_ROUNDS);
        expect(JSON.stringify(requests.at(-1).contents.at(-1))).toContain(`No further revision: ${MAX_GATE_ROUNDS} review rounds were used`);
    });

    it('does not run when the turn made no files', async () => {
        const { requests, calls, res } = await run([[2, 2]], false);
        expect(requests).toHaveLength(2);
        expect(calls).toHaveLength(0);
        expect(res.text).not.toContain('Independent review');
    });
});
