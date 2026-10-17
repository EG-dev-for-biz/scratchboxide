/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The visible vision fallback chain and the thinking mapping it applies per model at call time. No network: a fake
 * client records every request and answers from a script.
 */

import { describe, it, expect } from 'vitest';
import { GeminiClient } from '../src/node/gemini/gemini-client';
import { describeThinking, geminiMajorVersion, thinkingConfigFor } from '../src/node/gemini/thinking-config';
import { VisionChainError, VisionModelChain, type VisionGenAIClient } from '../src/node/gemini/vision-model-chain';

function httpError(status: number, message: string): Error {
    return Object.assign(new Error(message), { status });
}

function scriptedClient(script: Record<string, Array<Error | string>>): VisionGenAIClient & { calls: Array<{ model: string; config: any }> } {
    const calls: Array<{ model: string; config: any }> = [];
    const answer = (model: string) => {
        const queue = script[model] ?? [];
        const next = queue.length > 1 ? queue.shift()! : queue[0];
        if (next === undefined) throw httpError(404, `model ${model} was not found (404)`);
        if (next instanceof Error) throw next;
        return next;
    };
    return {
        calls,
        models: {
            generateContent: async (params: any) => {
                calls.push({ model: params.model, config: params.config });
                const text = answer(params.model);
                return { candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }], modelVersion: `${params.model}-001` } as any;
            },
            generateContentStream: async (params: any) => {
                calls.push({ model: params.model, config: params.config });
                const text = answer(params.model);
                return (async function* () {
                    yield { candidates: [{ content: { parts: [{ text: '{"a"' }] } }] } as any;
                    yield { candidates: [{ content: { parts: [{ text: text.slice(4) }] }, finishReason: 'STOP' }], modelVersion: `${params.model}-001`, usageMetadata: { candidatesTokenCount: 7 } } as any;
                })();
            }
        }
    };
}

describe('thinkingConfigFor', () => {
    it('maps a token budget onto a level on Gemini 4 and later, and passes it through on earlier models', () => {
        expect(geminiMajorVersion('gemini-4-argon')).toBe(4);
        expect(geminiMajorVersion('gemini-3.8-flash')).toBe(3);
        expect(geminiMajorVersion('claude-something')).toBe(0);
        expect(thinkingConfigFor('gemini-4-argon', 512)).toEqual({ thinkingLevel: 'LOW' });
        expect(thinkingConfigFor('gemini-4-argon', 1500)).toEqual({ thinkingLevel: 'MEDIUM' });
        expect(thinkingConfigFor('gemini-5-pro', 4096)).toEqual({ thinkingLevel: 'HIGH' });
        expect(thinkingConfigFor('gemini-3.8-flash', 512)).toEqual({ thinkingBudget: 512 });
        expect(thinkingConfigFor(undefined, 512)).toEqual({ thinkingBudget: 512 });
        expect(describeThinking({ thinkingLevel: 'LOW' })).toEqual({ level: 'LOW' });
        expect(describeThinking({ thinkingBudget: 512 })).toEqual({ budget: 512 });
    });

    it('is the mapping the chat client uses', () => {
        const client = new GeminiClient();
        expect(client.getThinkingConfig({ thinkingBudget: 512 }, 'gemini-4-argon')).toEqual(thinkingConfigFor('gemini-4-argon', 512));
        expect(client.getThinkingConfig({ thinkingBudget: 3000 }, 'gemini-3.8-flash')).toEqual({ thinkingBudget: 3000 });
    });
});

describe('VisionModelChain', () => {
    it('moves on only past a model that is not served, records why, and computes the thinking for the model it calls', async () => {
        const client = scriptedClient({ 'gemini-3.8-flash': ['{"ok":1}'] });
        const chain = new VisionModelChain({ client, candidates: ['gemini-4-argon', 'gemini-3.8-flash'], sleep: async () => undefined });
        expect(chain.thinkingFor(512)).toEqual({ level: 'LOW' });
        const r = await chain.generate({ contents: [{ role: 'user', parts: [{ text: 'x' }] }] }, { stage: 'vision', thinkingBudget: 512 });
        expect(r.model).toBe('gemini-3.8-flash');
        expect(r.thinking).toEqual({ thinkingBudget: 512 });
        expect(client.calls.map(c => [c.model, c.config.thinkingConfig])).toEqual([
            ['gemini-4-argon', { thinkingLevel: 'LOW' }],
            ['gemini-3.8-flash', { thinkingBudget: 512 }]
        ]);
        expect(chain.skipped).toHaveLength(1);
        expect(chain.skipped[0].model).toBe('gemini-4-argon');
        expect(chain.skipped[0].reason).toContain('404');
        expect(chain.attempts.map(a => [a.model, a.outcome])).toEqual([['gemini-4-argon', 'not_found'], ['gemini-3.8-flash', 'answered']]);
        expect(chain.answeredModel).toBe('gemini-3.8-flash');
        expect(chain.answered).toBe('gemini-3.8-flash-001');
        // later calls stay on the model that answered
        await chain.generate({ contents: [] }, { stage: 'vision' });
        expect(client.calls[2].model).toBe('gemini-3.8-flash');
        expect(client.calls[2].config.thinkingConfig).toBeUndefined();
    });

    it('retries a transient failure on the same model after 1 s then 2 s, and never moves on for it', async () => {
        const client = scriptedClient({ 'gemini-4-argon': [httpError(503, 'unavailable'), httpError(503, 'unavailable'), httpError(503, 'unavailable')], 'gemini-3.8-flash': ['{}'] });
        const waits: number[] = [];
        const chain = new VisionModelChain({ client, candidates: ['gemini-4-argon', 'gemini-3.8-flash'], sleep: async ms => { waits.push(ms); } });
        const err = await chain.generate({ contents: [] }, { stage: 'vision', thinkingBudget: 512 }).catch(e => e);
        expect(err).toBeInstanceOf(VisionChainError);
        expect(err.message).toBe('gemini-4-argon failed (transient 503): unavailable');
        expect(err.details).toMatchObject({ model: 'gemini-4-argon', httpStatus: 503, modelNotFound: false });
        expect(waits).toEqual([1000, 2000]);
        expect(client.calls.every(c => c.model === 'gemini-4-argon')).toBe(true);
        expect(chain.attempts.map(a => a.outcome)).toEqual(['retried', 'retried', 'failed']);
        expect(chain.attempts[2]).toMatchObject({ thinking: { level: 'LOW' }, httpStatus: 503, error: 'unavailable' });
    });

    it('says none is served when every candidate is not found', async () => {
        const client = scriptedClient({});
        const chain = new VisionModelChain({ client, candidates: ['gemini-4-argon', 'gemini-3.8-flash'], sleep: async () => undefined });
        const err = await chain.generate({ contents: [] }, { stage: 'vision' }).catch(e => e);
        expect(err.message).toMatch(/^None of the chat's models is served: gemini-4-argon \(.*404.*\); gemini-3.8-flash \(.*404.*\)$/);
        expect(err.details.skipped).toHaveLength(2);
    });

    it('streams when asked, joining the chunks and measuring the time to first token', async () => {
        const client = scriptedClient({ 'gemini-4-argon': ['{"a":1}'] });
        let t = 1000;
        const firsts: number[] = [];
        const chain = new VisionModelChain({ client, candidates: ['gemini-4-argon'], now: () => (t += 250) });
        const r = await chain.generate({ contents: [] }, { stage: 'vision', stream: true, onFirstToken: ms => firsts.push(ms) });
        expect(r.response.candidates?.[0]?.content?.parts?.[0]?.text).toBe('{"a":1}');
        expect(r.response.candidates?.[0]?.finishReason).toBe('STOP');
        expect(r.response.usageMetadata?.candidatesTokenCount).toBe(7);
        expect(r.ttftMs).toBe(250);
        expect(firsts).toEqual([250]);
        expect(r.ms).toBe(500);
        expect(chain.attempts[0]).toMatchObject({ model: 'gemini-4-argon', outcome: 'answered', ttftMs: 250, ms: 500 });
    });

    it('reports a stop as a stop, not as a model failure', async () => {
        const stop = new AbortController();
        const client: VisionGenAIClient = {
            models: {
                generateContent: () => new Promise((_, reject) => { stop.abort(); reject(new Error('fetch failed')); })
            }
        };
        const chain = new VisionModelChain({ client, candidates: ['gemini-4-argon'], signal: stop.signal, sleep: async () => undefined });
        const err = await chain.generate({ contents: [] }, { stage: 'vision' }).catch(e => e);
        expect(err.message).toBe('Stopped by the user.');
        expect(err.details.aborted).toBe(true);
        expect(chain.attempts.map(a => a.outcome)).toEqual(['stopped']);
    });
});

describe('a stream that stalls', () => {
    it('ends when the call\'s own time limit fires, even though the request underneath ignores the abort', async () => {
        // a stream that sends one chunk and then never yields again, and never looks at the abort signal
        const stalled = {
            models: {
                generateContent: async () => { throw new Error('streaming expected'); },
                generateContentStream: async () => (async function* () {
                    yield { candidates: [{ content: { parts: [{ text: '{"a":' }] } }] } as any;
                    await new Promise(() => undefined);
                })()
            }
        } as unknown as VisionGenAIClient;
        const chain = new VisionModelChain<string>({ client: stalled, candidates: ['gemini-3.8-flash'], sleep: async () => undefined });
        const own = new AbortController();
        const timer = setTimeout(() => own.abort(Object.assign(new Error('the call took too long'), { name: 'TimeoutError' })), 150);
        const t0 = Date.now();
        await expect(chain.generate({ contents: [{ role: 'user', parts: [{ text: 'x' }] }], config: { abortSignal: own.signal } }, { stage: 'vision', stream: true })).rejects.toThrow();
        clearTimeout(timer);
        expect(Date.now() - t0).toBeLessThan(3000);
    });
});
