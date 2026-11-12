/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { SUBAGENT_MODEL_FOR_PROVIDER, providerForChatModel, subagentModelFor } from '../src/common/chat-models';
import { GeminiService } from '../src/node/gemini-service';

describe('a chat\'s subagents run on its own provider', () => {
    it('picks each provider\'s fast model, and the chat\'s chosen subagent model when it is the same provider', () => {
        expect(subagentModelFor(undefined)).toBe('gemini-3.5-flash-lite');
        expect(subagentModelFor('gemini-4-argon')).toBe('gemini-3.5-flash-lite');
        expect(subagentModelFor('gemini-4-argon', 'gemini-3.1-flash-lite')).toBe('gemini-3.1-flash-lite');
        expect(subagentModelFor('claude-opus-5-5')).toBe('claude-haiku-5-5');
        expect(subagentModelFor('gpt-6-astra')).toBe('gpt-6.1-terra');
        // Settings' subagent choice is a Gemini model: a Claude or OpenAI chat does not send its helpers to Google
        expect(subagentModelFor('claude-sonnet-5-5', 'gemini-3.5-flash-lite')).toBe('claude-haiku-5-5');
        expect(subagentModelFor('gpt-6.1-sol', 'gemini-3.5-flash-lite')).toBe('gpt-6.1-terra');
        // every provider's subagent model is served by that provider
        for (const [provider, model] of Object.entries(SUBAGENT_MODEL_FOR_PROVIDER)) expect(providerForChatModel(model)).toBe(provider);
    });

    it('invoke_subagent\'s run asks for the chat provider\'s subagent model', async () => {
        // runSubagent's own code, on a stand-in for the service's streaming engine (constructing the whole service starts
        // its background workers, which a unit test does not need)
        const seen: string[] = [];
        const self = { streaming: { streamGenerate: async (req: { model?: string }) => { seen.push(String(req.model)); return { success: true, text: 'report', modelUsed: req.model }; } } };
        for (const model of ['claude-opus-5-5', 'gpt-6-astra', 'gemini-4-argon']) {
            const run = await GeminiService.prototype.runSubagent.call(self as any, 'read the README', { prompt: 'p', model } as any);
            expect(run.success).toBe(true);
        }
        expect(seen).toEqual(['claude-haiku-5-5', 'gpt-6.1-terra', 'gemini-3.5-flash-lite']);
    });
});
