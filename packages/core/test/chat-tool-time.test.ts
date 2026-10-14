/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Chat time for long tools. A flat 5-minute cap stopped survey_beautify_to_texture (~11 min) mid-run, and its
 * result was dropped. Now a tool with a budget may run as long as it keeps reporting progress (up to its ceiling),
 * the chat shows it as running with that progress, the user's Stop ends it at once and tells the tool to stop,
 * the Vertex token is refreshed after a long call, and a later model error never replays the tools on another model.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { GeminiService } from '../src/node/gemini-service';
import { TOOL_TIME_BUDGETS, resolveToolTimeBudget } from '../src/node/gemini/tool-time-budgets';
import { createDefaultToolRegistry } from '../src/node/gemini/tool-registry';
import type { GeminiStreamEvent } from '../src/common/gemini-protocol';
import type { ToolContext } from '../src/node/gemini/tools/types';

const TOOL_CALL = (name: string, args: Record<string, unknown> = {}) =>
    `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name, args } }] }, finishReason: 'STOP' }] })}\ndata: [DONE]`;
const TEXT = (t: string) => `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: t }] }, finishReason: 'STOP' }] })}\ndata: [DONE]`;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** A service whose model answers with `turns` in order and whose token source counts its calls. */
function makeService(turns: string[], opts: { status?: (i: number) => number } = {}) {
    const service = new GeminiService();
    let tokenCalls = 0;
    (service as any).auth = { getClient: async () => ({ getAccessToken: async () => ({ token: `token-${++tokenCalls}` }) }) };
    (service as any).cachedProjectId = 'mock-project';
    const requests: Array<{ body: any; auth: string }> = [];
    (globalThis as any).fetch = async (_url: string, init: any) => {
        requests.push({ body: JSON.parse(init.body), auth: init.headers?.Authorization });
        const i = requests.length - 1;
        const status = opts.status?.(i) ?? 200;
        return { ok: status < 400, status, text: async () => (status < 400 ? turns[i] ?? TEXT('done') : `{"error":{"code":${status},"message":"model not found"}}`), body: null };
    };
    const register = (name: string, handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<any>) =>
        (service as any).toolRegistry.register(name, { name, description: name, parameters: { type: 'OBJECT', properties: {} } }, handler, 'workspace');
    return { service, requests, register, tokenCalls: () => tokenCalls };
}

const budgets = TOOL_TIME_BUDGETS as Record<string, unknown>;
afterEach(() => {
    delete budgets.test_long_tool;
    delete process.env.SCRATCHBOX_TOOL_TIMEOUT_MS;
});

describe('chat tool time', () => {
    it('lets a budgeted tool run past the default limit while it reports progress, shown as one running card', async () => {
        process.env.SCRATCHBOX_TOOL_TIMEOUT_MS = '300';
        budgets.test_long_tool = { maxMs: 5000, idleMs: 400 };
        const { service, register } = makeService([TOOL_CALL('test_long_tool'), TEXT('Baked.')]);
        register('test_long_tool', async (_args, ctx) => {
            for (let i = 1; i <= 8; i++) { await sleep(150); ctx.reportProgress?.(`Station ${i}/8`, i / 8); }
            return { resultPayload: { success: true, outGlbPath: 'public/models/x.glb' }, status: 'completed', summaryResult: 'baked' };
        });
        const events: GeminiStreamEvent[] = [];
        const started = Date.now();
        const res = await service.streamGenerate({ prompt: 'bake', model: 'gemini-3.7-flash', mode: 'agent' }, e => events.push(e));
        expect(res.success).toBe(true);
        expect(Date.now() - started).toBeGreaterThan(1100); // well past the 300 ms default and the 400 ms idle limit
        const running = events.filter(e => e.mcpExecution?.status === 'running');
        const result = events.find(e => e.type === 'tool_result');
        expect(result?.mcpExecution?.status).toBe('completed');
        expect(running.length).toBeGreaterThanOrEqual(2);
        expect(new Set(running.map(e => e.mcpExecution!.id))).toEqual(new Set([result!.mcpExecution!.id]));
        expect(running.some(e => /Station \d\/8 - \d+%/.test(e.mcpExecution!.summaryResult || ''))).toBe(true);
        expect(result!.mcpExecution!.durationMs).toBeGreaterThan(1100);
    });

    it('stops a budgeted tool that goes quiet and aborts its signal', async () => {
        process.env.SCRATCHBOX_TOOL_TIMEOUT_MS = '300';
        budgets.test_long_tool = { maxMs: 10_000, idleMs: 400 };
        const { service, register, requests } = makeService([TOOL_CALL('test_long_tool'), TEXT('It stalled.')]);
        let toldToStop = false;
        register('test_long_tool', (_args, ctx) => new Promise(() => {
            ctx.reportProgress?.('Station 1/8');
            ctx.signal?.addEventListener('abort', () => { toldToStop = true; });
        }));
        const events: GeminiStreamEvent[] = [];
        const started = Date.now();
        const res = await service.streamGenerate({ prompt: 'bake', model: 'gemini-3.7-flash', mode: 'agent' }, e => events.push(e));
        expect(res.success).toBe(true);
        expect(Date.now() - started).toBeLessThan(3000);
        const result = events.find(e => e.type === 'tool_result');
        expect(result?.mcpExecution?.status).toBe('failed');
        expect(String((result?.toolResult as any)?.result?.error)).toMatch(/reported no progress/);
        expect(JSON.stringify(requests[1].body.contents.at(-1))).toContain('reported no progress');
        expect(toldToStop).toBe(true);
    });

    it('ends the turn at once when the user stops the chat, and tells the tool to stop', async () => {
        const { service, register } = makeService([TOOL_CALL('test_long_tool'), TEXT('never reached')]);
        let toldToStop = false;
        register('test_long_tool', (_args, ctx) => new Promise(() => {
            ctx.signal?.addEventListener('abort', () => { toldToStop = true; });
        }));
        const stop = new AbortController();
        setTimeout(() => stop.abort(), 200);
        const started = Date.now();
        await expect(service.streamGenerate({ prompt: 'bake', model: 'gemini-3.7-flash', mode: 'agent' }, () => undefined, stop.signal))
            .rejects.toThrow(/aborted/i);
        expect(Date.now() - started).toBeLessThan(1500); // not the 5 min default limit
        expect(toldToStop).toBe(true);
    });

    it('refreshes the Vertex token before each model call after the first', async () => {
        const { service, register, requests } = makeService([TOOL_CALL('quick_tool'), TOOL_CALL('quick_tool'), TEXT('ok')]);
        register('quick_tool', async () => ({ resultPayload: { success: true }, status: 'completed' }));
        await service.streamGenerate({ prompt: 'go', model: 'gemini-3.7-flash', mode: 'agent' }, () => undefined);
        expect(requests.map(r => r.auth)).toEqual(['Bearer token-1', 'Bearer token-2', 'Bearer token-3']);
    });

    it('does not replay the tools on another model when a model fails after answering', async () => {
        const { service, register, requests } = makeService([TOOL_CALL('quick_tool')], { status: i => (i === 1 ? 404 : 200) });
        let runs = 0;
        register('quick_tool', async () => { runs++; return { resultPayload: { success: true }, status: 'completed' }; });
        const candidates = service.getModelCandidates?.('gemini-3.7-flash') ?? (service as any).client.getModelCandidates('gemini-3.7-flash');
        expect(candidates.length).toBeGreaterThan(1); // there is a model to fall back to
        await expect(service.streamGenerate({ prompt: 'go', model: 'gemini-3.7-flash', mode: 'agent' }, () => undefined)).rejects.toThrow(/404/);
        expect(runs).toBe(1);
        expect(requests.length).toBe(2);
    });
});

describe('chat tool time: review fixes', () => {
    it('gives every call its own card when the model sends no call ids', async () => {
        const calls = Array.from({ length: 6 }, () => ({ functionCall: { name: 'quick_tool', args: {} } }));
        const turn = `data: ${JSON.stringify({ candidates: [{ content: { parts: calls }, finishReason: 'STOP' }] })}\ndata: [DONE]`;
        const { service, register } = makeService([turn, TEXT('ok')]);
        register('quick_tool', async () => ({ resultPayload: { success: true }, status: 'completed' }));
        const events: GeminiStreamEvent[] = [];
        await service.streamGenerate({ prompt: 'go', model: 'gemini-3.7-flash', mode: 'agent' }, e => events.push(e));
        const ids = events.filter(e => e.type === 'tool_result').map(e => e.mcpExecution!.id);
        expect(ids.length).toBe(6);
        expect(new Set(ids).size).toBe(6);
    });

    it('ignores progress reported after the call has ended', async () => {
        process.env.SCRATCHBOX_TOOL_TIMEOUT_MS = '300';
        budgets.test_long_tool = { maxMs: 10_000, idleMs: 300 };
        let late: (() => void) | undefined;
        const { service, register } = makeService([TOOL_CALL('test_long_tool'), TEXT('stalled')]);
        register('test_long_tool', (_args, ctx) => new Promise(() => {
            ctx.reportProgress?.('Station 1/8');
            late = () => ctx.reportProgress?.('Station 2/8');
        }));
        const events: GeminiStreamEvent[] = [];
        await service.streamGenerate({ prompt: 'bake', model: 'gemini-3.7-flash', mode: 'agent' }, e => {
            events.push(e);
            if (e.type === 'tool_result') late?.(); // the tool reports again after its call has failed
        });
        const resultAt = events.findIndex(e => e.type === 'tool_result');
        expect(events[resultAt].mcpExecution!.status).toBe('failed');
        expect(events.slice(resultAt + 1).some(e => e.mcpExecution?.status === 'running')).toBe(false);
    });
});

describe('tool time budgets', () => {
    it('gives unlisted tools the default limit and follows the command timeout for workspace_run_command', () => {
        expect(resolveToolTimeBudget('workspace_read_file', {}, 300_000)).toEqual({ maxMs: 300_000, idleMs: 300_000 });
        expect(resolveToolTimeBudget('workspace_run_command', { timeoutMs: 1_200_000 }, 300_000).maxMs).toBe(1_230_000);
        expect(resolveToolTimeBudget('workspace_run_command', {}, 300_000).maxMs).toBe(300_000);
        expect(resolveToolTimeBudget('survey_beautify_to_texture', {}, 300_000)).toEqual({ maxMs: 90 * 60_000, idleMs: 10 * 60_000 });
        // names of Object.prototype members are just unlisted tools
        for (const name of ['valueOf', 'toString', 'hasOwnProperty', 'constructor']) {
            expect(resolveToolTimeBudget(name, {}, 300_000)).toEqual({ maxMs: 300_000, idleMs: 300_000 });
        }
    });

    it('only names tools that exist', () => {
        const registry = createDefaultToolRegistry();
        const unknown = Object.keys(TOOL_TIME_BUDGETS).filter(n => !registry.has(n));
        expect(unknown).toEqual([]);
    });
});
