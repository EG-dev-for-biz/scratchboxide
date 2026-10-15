/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A chat turn that fails after a fallback model (or the Gemini API key) started answering still says so: the
 * stream route forwards the error's model provenance on its SSE error event, which the browser client reads into
 * the failed reply's notice. It used to write only `{ type: 'error', error }`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Router } from 'express';
import { createGeminiRouter } from '../server/routes/geminiRoutes';
import { GeminiService } from '../../packages/core/src/node';

const NOT_FOUND = JSON.stringify({ error: { code: 404, message: 'Publisher Model gemini-4-argon was not found', status: 'NOT_FOUND' } });
const savedFetch = (globalThis as any).fetch;
afterEach(() => { (globalThis as any).fetch = savedFetch; });

/** POSTs `body` to `url` on the router and returns the SSE data lines it wrote. */
function postSse(router: Router, url: string, body: unknown): Promise<string[]> {
    return new Promise(resolve => {
        const chunks: string[] = [];
        const listeners: Record<string, () => void> = {};
        const req: any = { method: 'POST', url, body, headers: {}, query: {} };
        const res: any = {
            destroyed: false,
            writableEnded: false,
            writeHead() { return this; },
            flushHeaders() {},
            on(event: string, fn: () => void) { listeners[event] = fn; return this; },
            write(payload: string) { chunks.push(payload); return true; },
            end() {
                this.writableEnded = true;
                resolve(chunks.join('').split('\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6)));
            },
            status() { return this; },
            json(payload: unknown) { chunks.push(`data: ${JSON.stringify(payload)}\n`); this.end(); }
        };
        router(req, res, () => resolve(['router fell through']));
    });
}

describe('POST /stream on a turn that fails', () => {
    it('the error event names the model that answered and the model it stood in for', async () => {
        const geminiService = new GeminiService();
        (geminiService as any).auth = { getClient: async () => ({ getAccessToken: async () => ({ token: 'mock-token' }) }) };
        (geminiService as any).cachedProjectId = 'mock-project';
        (globalThis as any).fetch = async (url: string) => {
            const a = url.includes('/models/gemini-4-argon:')
                ? { ok: false, status: 404, body: NOT_FOUND }
                : { ok: false, status: 500, body: '{"error":{"code":500,"message":"Internal error"}}' };
            return { ok: a.ok, status: a.status, text: async () => a.body, json: async () => JSON.parse(a.body), body: null };
        };
        const router = createGeminiRouter({ geminiService, memoriesService: {} } as any, {
            allowedWorkspaceRoots: [], requireWorkspaceRoot: (c: unknown) => String(c), sendError: () => undefined, isPathError: () => false
        });

        const lines = await postSse(router, '/stream', { prompt: 'hi', model: 'gemini-4-argon', mode: 'ask' });
        expect(lines[lines.length - 1]).toBe('[DONE]');
        const failure = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).find(e => e?.type === 'error');
        expect(failure?.error).toContain('AI request failed (500)');
        expect(failure?.modelProvenance).toMatchObject({
            requestedModel: 'gemini-4-argon',
            modelUsed: 'gemini-3.8-flash',
            fallbackReason: expect.stringContaining('gemini-4-argon unavailable: 404'),
            credential: 'vertex'
        });
    }, 120_000);
});
