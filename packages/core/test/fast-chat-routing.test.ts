/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Fast chat routing (docs/processes/fast_chat_routing.md): the cacheable prompt prefix stays byte-identical across
 * requests, tools are offered as an entry set plus load_tools (never chosen by words in the prompt), a tool starts as
 * soon as its functionCall part arrives, and a router model can choose the first tool call or hand off to the chat
 * model, with the outcome on the reply's provenance. No test here reaches a real model: fetch is replaced.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { GeminiService } from '../src/node/gemini-service';
import { buildChatPayload, TURN_CONTEXT_HEADING, withTurnContext } from '../src/node/gemini/chat-payload';
import { buildToolDeclarations, createDefaultToolRegistry } from '../src/node/gemini/tool-registry';
import { catalogLine, createLoadToolsHandler, ENTRY_TOOL_NAMES, LOAD_TOOLS_NAME } from '../src/node/gemini/tool-catalog';
import { raceRoutedCall, routerConfig, describeRouteOutcome, type StartStream } from '../src/node/gemini/fast-router';
import { ChatTurnTimer } from '../src/node/gemini/chat-turn-telemetry';
import type { GeminiGenerateRequest, GeminiStreamEvent } from '../src/common/gemini-protocol';
import type { CanvasArtifact } from '../src/browser/generative-canvas/canvas-types';
import type { ToolContext } from '../src/node/gemini/tools/types';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const callLine = (name: string, args: Record<string, unknown> = {}) =>
    `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name, args } }] } }] })}`;
const textLine = (t: string) => `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: t }] } }] })}`;
const usageLine = (prompt: number, cached: number) =>
    `data: ${JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [] } }], usageMetadata: { promptTokenCount: prompt, cachedContentTokenCount: cached, candidatesTokenCount: 12 } })}`;

const fnNames = (tools: any[] | undefined): string[] =>
    (tools || []).flatMap(t => (t.functionDeclarations || []).map((d: any) => d.name));

const savedEnv = { ...process.env };
afterEach(() => {
    for (const k of ['SCRATCHBOX_CHAT_TOOLS', 'SCRATCHBOX_CHAT_ROUTER', 'SCRATCHBOX_CHAT_STABLE_PREFIX']) {
        if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
    }
});

const STAGED: CanvasArtifact = {
    id: 'scene-stg-1',
    type: '3d-scene',
    title: 'Flatiron Building (staged clay)',
    data: { title: 'Flatiron Building (staged clay)', renderMode: 'clay', objects: [] }
} as unknown as CanvasArtifact;

describe('cacheable prompt prefix', () => {
    const registry = createDefaultToolRegistry();
    const build = (request: GeminiGenerateRequest) =>
        buildChatPayload(request, {}, buildToolDeclarations(request, registry), 'gemini-4-argon', { thinkingLevel: 'MEDIUM' });

    it('keeps the system instruction and tools byte-identical across different requests and open artifacts', async () => {
        const a = await build({ prompt: 'Build a 3D scene of the Flatiron Building', mode: 'agent', enableWorkspaceTools: true });
        const b = await build({ prompt: 'make it golden hour', mode: 'agent', enableWorkspaceTools: true, activeArtifact: STAGED, chatHistory: [{ role: 'user', text: 'earlier' }] });
        const c = await build({ prompt: 'Write a product spec for a drone delivery service', mode: 'agent', enableWorkspaceTools: true });
        expect(JSON.stringify(a.payload.systemInstruction)).toBe(JSON.stringify(b.payload.systemInstruction));
        expect(JSON.stringify(a.payload.systemInstruction)).toBe(JSON.stringify(c.payload.systemInstruction));
        expect(JSON.stringify(a.payload.tools)).toBe(JSON.stringify(b.payload.tools));
        expect(JSON.stringify(a.payload.tools)).toBe(JSON.stringify(c.payload.tools));
        // The open-artifact rule is per request: it goes with the request, ahead of the user's words.
        const last = b.payload.contents[b.payload.contents.length - 1];
        expect(last.parts![0].text!.startsWith(TURN_CONTEXT_HEADING)).toBe(true);
        expect(last.parts![0].text).toContain('scene-stg-1');
        expect(last.parts![last.parts!.length - 1].text).toContain('make it golden hour');
        expect(b.shape.turnContextChars).toBeGreaterThan(0);
        expect(b.shape.staticSystemChars).toBe(b.shape.systemChars);
    });

    it('puts the context back in the system instruction with SCRATCHBOX_CHAT_STABLE_PREFIX=0', async () => {
        process.env.SCRATCHBOX_CHAT_STABLE_PREFIX = '0';
        const b = await build({ prompt: 'make it golden hour', mode: 'agent', enableWorkspaceTools: true, activeArtifact: STAGED });
        expect(b.payload.systemInstruction!.parts![0].text).toContain('scene-stg-1');
        expect(b.payload.contents[b.payload.contents.length - 1].parts).toHaveLength(1);
    });

    it('adds no context part when there is none', () => {
        const contents = [{ role: 'user', parts: [{ text: 'hi' }] }];
        expect(withTurnContext(contents, '  ')).toBe(contents);
    });
});

describe('tool catalog', () => {
    const registry = createDefaultToolRegistry();

    it('offers the entry set and load_tools whatever the prompt says, listing every other tool by name', () => {
        const prompts = ['Build a 3D scene of the Flatiron Building', 'a scene at the Alhambra', 'Color grade drone.mov teal and orange', 'browse to localhost and click the lens'];
        const offers = prompts.map(prompt => buildToolDeclarations({ prompt, mode: 'agent', enableWorkspaceTools: true }, registry));
        for (const o of offers) expect(JSON.stringify(o)).toBe(JSON.stringify(offers[0]));
        const names = fnNames(offers[0]);
        expect(names).toEqual(ENTRY_TOOL_NAMES.filter(n => registry.has(n) || n === LOAD_TOOLS_NAME));
        const load = (offers[0]![offers[0]!.length - 1] as any).functionDeclarations.find((d: any) => d.name === LOAD_TOOLS_NAME);
        const allDefault = registry.declarations(['workspace']).map(d => d.name).filter(n => !names.includes(n));
        expect(allDefault.length).toBeGreaterThan(100);
        for (const n of allDefault) expect(load.description).toContain(`- ${n}: `);
        // Far smaller than every declaration.
        expect(JSON.stringify(offers[0]).length).toBeLessThan(JSON.stringify(registry.declarations(['workspace'])).length / 3);
    });

    it('appends loaded tools after the entry set and load_tools, keeping that prefix unchanged', () => {
        const base = buildToolDeclarations({ prompt: 'x', mode: 'agent', enableWorkspaceTools: true }, registry) as any[];
        const loaded = buildToolDeclarations({ prompt: 'x', mode: 'agent', enableWorkspaceTools: true, loadedTools: ['botanical_synthesize_tree', 'adaptive_matchmove_calibrate_sequence', 'no_such_tool'] }, registry) as any[];
        const baseDecls = base[base.length - 1].functionDeclarations;
        const loadedDecls = loaded[loaded.length - 1].functionDeclarations;
        expect(JSON.stringify(loadedDecls.slice(0, baseDecls.length))).toBe(JSON.stringify(baseDecls));
        expect(loadedDecls.slice(baseDecls.length).map((d: any) => d.name)).toEqual(['botanical_synthesize_tree', 'adaptive_matchmove_calibrate_sequence']);
    });

    it('offers every tool with SCRATCHBOX_CHAT_TOOLS=all, and keeps Plan mode read-only', () => {
        process.env.SCRATCHBOX_CHAT_TOOLS = 'all';
        const all = fnNames(buildToolDeclarations({ prompt: 'x', mode: 'agent', enableWorkspaceTools: true }, registry));
        expect(all.length).toBeGreaterThan(150);
        expect(all).not.toContain(LOAD_TOOLS_NAME);
        delete process.env.SCRATCHBOX_CHAT_TOOLS;
        const plan = fnNames(buildToolDeclarations({ prompt: 'x', mode: 'plan', enableWorkspaceTools: true }, registry));
        expect(plan).not.toContain('workspace_write_file');
        expect(plan).toContain('workspace_read_file');
    });

    it('load_tools loads known tools, reports unknown ones, and fails when nothing is loadable', async () => {
        const handler = createLoadToolsHandler(n => registry.has(n) && n !== LOAD_TOOLS_NAME);
        const ok: any = await handler({ tools: ['vfx_segment_subject', 'nope'] }, {} as ToolContext);
        expect(ok.status).toBe('completed');
        expect(ok.resultPayload.loaded).toEqual(['vfx_segment_subject']);
        expect(ok.resultPayload.unknown).toEqual(['nope']);
        const bad: any = await handler({ tools: ['nope'] }, {} as ToolContext);
        expect(bad.status).toBe('failed');
        expect(bad.resultPayload.success).toBe(false);
    });

    it('takes the first sentence of a description for the catalog line', () => {
        expect(catalogLine('Ingest a place as clay. Long details follow here.')).toBe('Ingest a place as clay.');
        expect(catalogLine('x'.repeat(400)).length).toBe(150);
    });
});

describe('routing race', () => {
    /** A stream that sends `lines` with `gapMs` between them, honouring abort. */
    const stream = (lines: string[], gapMs: number, opts: { failWith?: Error; startDelayMs?: number } = {}): StartStream & { aborted: () => boolean } => {
        let aborted = false;
        const fn = (async (signal: AbortSignal, onLine: (l: string) => void) => {
            signal.addEventListener('abort', () => { aborted = true; });
            await sleep(opts.startDelayMs ?? 0);
            if (opts.failWith) throw opts.failWith;
            for (const l of lines) {
                await sleep(gapMs);
                if (signal.aborted) throw new Error('aborted');
                onLine(l);
            }
        }) as StartStream & { aborted: () => boolean };
        fn.aborted = () => aborted;
        return fn;
    };
    const router = routerConfig('gemini-4-argon', 'gemini-3.8-flash')!;

    it('runs the router\'s call and cancels the chat model when the router decides first', async () => {
        const seen: Array<[string, string]> = [];
        const chat = stream([textLine('thinking...'), callLine('google_3d_tiles_get_clay')], 200);
        const outcome = await raceRoutedCall({ router, chatModel: 'gemini-4-argon', startRouter: stream([callLine('google_3d_tiles_get_clay', { query: 'Flatiron Building' }), usageLine(10, 0)], 10), startChat: chat, handle: (l, m) => seen.push([l, m]) });
        expect(outcome.decidedBy).toBe('router');
        expect(chat.aborted()).toBe(true);
        expect(seen.every(([, m]) => m === 'gemini-3.8-flash')).toBe(true);
        expect(seen[0][0]).toContain('Flatiron Building');
        expect(describeRouteOutcome(outcome, 'gemini-4-argon')).toContain('gemini-3.8-flash chose the first tool call (google_3d_tiles_get_clay)');
    });

    it('hands off to the chat model when the router answers in text, replaying the chat stream in order', async () => {
        const seen: Array<[string, string]> = [];
        const chat = stream([textLine('Gaussian splats are '), textLine('3D gaussians.'), usageLine(10, 0)], 30);
        const routerStream = stream([textLine('Splats are...'), usageLine(5, 0)], 5);
        const outcome = await raceRoutedCall({ router, chatModel: 'gemini-4-argon', startRouter: routerStream, startChat: chat, handle: (l, m) => seen.push([l, m]) });
        expect(outcome).toMatchObject({ decidedBy: 'chat', reason: 'answered in text, handed off' });
        expect(seen.map(([, m]) => m)).toEqual(['gemini-4-argon', 'gemini-4-argon', 'gemini-4-argon']);
        expect(seen[0][0]).toContain('Gaussian splats are');
    });

    it('takes the chat model\'s call when it decides before the router', async () => {
        const seen: string[] = [];
        const routerStream = stream([callLine('generate_image')], 300);
        const outcome = await raceRoutedCall({ router, chatModel: 'gemini-4-argon', startRouter: routerStream, startChat: stream([callLine('mount_canvas_primitive')], 10), handle: l => seen.push(l) });
        expect(outcome).toMatchObject({ decidedBy: 'chat', reason: 'the chat model decided first' });
        expect(routerStream.aborted()).toBe(true);
        expect(seen).toHaveLength(1);
        expect(seen[0]).toContain('mount_canvas_primitive');
    });

    it('says why when the router fails, and still fails when the chat model fails and the router made no call', async () => {
        const ok = await raceRoutedCall({ router, chatModel: 'gemini-4-argon', startRouter: stream([], 0, { failWith: new Error('AI request failed (404): not found') }), startChat: stream([callLine('x')], 50), handle: () => undefined });
        expect(ok).toMatchObject({ decidedBy: 'chat' });
        expect((ok as any).reason).toMatch(/failed: AI request failed \(404\)/);
        await expect(raceRoutedCall({ router, chatModel: 'gemini-4-argon', startRouter: stream([textLine('hi')], 5), startChat: stream([], 0, { failWith: new Error('AI request failed (500)') }), handle: () => undefined })).rejects.toThrow('500');
    });

    it('parses the router setting and refuses a malformed one', () => {
        expect(routerConfig('gemini-4-argon', 'off')).toBeUndefined();
        expect(routerConfig('gemini-4-argon', 'gemini-4-argon')).toBeUndefined();
        expect(routerConfig('gemini-4-argon', 'gemini-4-argon@LOW')).toMatchObject({ model: 'gemini-4-argon', thinkingConfig: { thinkingLevel: 'LOW' } });
        expect(() => routerConfig('gemini-4-argon', 'flash please')).toThrow(/SCRATCHBOX_CHAT_ROUTER/);
        expect(() => routerConfig('gemini-4-argon', 'gemini-3.8-flash@FAST')).toThrow(/thinking level/);
    });
});

/** A streamed fetch body: each chunk after its delay. */
function streamedBody(chunks: Array<{ text: string; delayMs: number }>, signal?: AbortSignal) {
    return new ReadableStream<Uint8Array>({
        async start(controller) {
            const enc = new TextEncoder();
            for (const c of chunks) {
                await sleep(c.delayMs);
                if (signal?.aborted) { controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' })); return; }
                controller.enqueue(enc.encode(`${c.text}\n`));
            }
            controller.close();
        }
    });
}

function makeService() {
    const service = new GeminiService();
    (service as any).auth = { getClient: async () => ({ getAccessToken: async () => ({ token: 'token' }) }) };
    (service as any).cachedProjectId = 'mock-project';
    const register = (name: string, handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<any>) =>
        (service as any).toolRegistry.register(name, { name, description: name, parameters: { type: 'OBJECT', properties: {} } }, handler, 'workspace');
    return { service, register };
}

describe('streaming engine', () => {
    it('starts a tool when its functionCall part arrives, before the stream ends', async () => {
        const { service, register } = makeService();
        let streamEndedAt = 0;
        let toolStartedAt = 0;
        let call = 0;
        (globalThis as any).fetch = async (_url: string, init: any) => {
            call++;
            const chunks = call === 1
                ? [{ text: callLine('test_tool'), delayMs: 5 }, { text: usageLine(100, 0), delayMs: 300 }]
                : [{ text: textLine('Done.'), delayMs: 5 }, { text: usageLine(100, 0), delayMs: 5 }];
            const body = streamedBody(chunks, init.signal);
            if (call === 1) setTimeout(() => { streamEndedAt = Date.now(); }, 305);
            return { ok: true, status: 200, body, text: async () => '' };
        };
        register('test_tool', async () => {
            toolStartedAt = Date.now();
            return { resultPayload: { success: true }, status: 'completed', summaryResult: 'ok' };
        });
        const logs: string[] = [];
        const orig = console.log;
        console.log = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
        try {
            const res = await service.streamGenerate({ prompt: 'go', model: 'gemini-4-argon', mode: 'agent' }, () => undefined);
            expect(res.success).toBe(true);
        } finally {
            console.log = orig;
        }
        expect(toolStartedAt).toBeGreaterThan(0);
        expect(streamEndedAt - toolStartedAt).toBeGreaterThan(200);
        const turn = logs.map(l => /^\[chat-turn\] (.*)$/.exec(l)?.[1]).filter(Boolean).map(j => JSON.parse(j!));
        expect(turn).toHaveLength(2);
        expect(turn[0]).toMatchObject({ call: 1, role: 'route', functionCalls: ['test_tool'], usage: { promptTokenCount: 100, cachedContentTokenCount: 0 } });
        expect(turn[0].toolStartMs).toBeLessThan(turn[0].endMs - 200);
        expect(turn[0].firstFunctionCallMs).toBeLessThanOrEqual(turn[0].toolStartMs);
    });

    it('lets a router choose the first tool, sends the rest to the chat model, and says so on the reply', async () => {
        process.env.SCRATCHBOX_CHAT_ROUTER = 'gemini-3.8-flash';
        const { service, register } = makeService();
        const urls: string[] = [];
        const bodies: any[] = [];
        let chatAborted = false;
        let cacheCreates = 0;
        (globalThis as any).fetch = async (url: string, init: any) => {
            if (url.endsWith('/cachedContents')) {
                cacheCreates++;
                return { ok: false, status: 400, text: async () => '{"error":{"code":400,"message":"Model `gemini-3.8-flash` does not support explicit context caching."}}' };
            }
            urls.push(url);
            bodies.push(JSON.parse(init.body));
            const isRouter = url.includes('gemini-3.8-flash');
            const firstChat = !isRouter && urls.filter(u => !u.includes('gemini-3.8-flash')).length === 1;
            init.signal?.addEventListener('abort', () => { if (firstChat) chatAborted = true; });
            const chunks = isRouter
                ? [{ text: callLine('test_tool', { place: 'Flatiron' }), delayMs: 5 }, { text: usageLine(50, 0), delayMs: 5 }]
                : firstChat
                    ? [{ text: callLine('test_tool', { place: 'slow' }), delayMs: 400 }]
                    : [{ text: textLine('Built it.'), delayMs: 5 }, { text: usageLine(60, 0), delayMs: 5 }];
            return { ok: true, status: 200, body: streamedBody(chunks, init.signal), text: async () => '' };
        };
        const ran: unknown[] = [];
        register('test_tool', async args => { ran.push(args); return { resultPayload: { success: true }, status: 'completed', summaryResult: 'ok' }; });
        const events: GeminiStreamEvent[] = [];
        const res = await service.streamGenerate({ prompt: 'Build a 3D scene of the Flatiron Building', model: 'gemini-4-argon', mode: 'agent' }, e => events.push(e));
        expect(res.success).toBe(true);
        expect(ran).toEqual([{ place: 'Flatiron' }]);
        expect(chatAborted).toBe(true);
        // Same instructions and tools to both; the call after the tool result goes to the chat model.
        expect(JSON.stringify(bodies[0].systemInstruction)).toBe(JSON.stringify(bodies[1].systemInstruction));
        expect(JSON.stringify(bodies[0].tools)).toBe(JSON.stringify(bodies[1].tools));
        expect(urls[2]).toContain('gemini-4-argon');
        // The router's call is replayed to the chat model without the router's thought signature.
        const modelTurn = bodies[2].contents.find((c: any) => c.role === 'model');
        expect(modelTurn.parts[0].thought_signature).toBe('skip_thought_signature_validator');
        expect(res.modelProvenance?.routing).toContain('gemini-3.8-flash chose the first tool call (test_tool)');
        expect(res.modelProvenance?.modelUsed).toBe('gemini-4-argon');
        expect(events.some(e => e.type === 'tool_call' && e.modelUsed === 'gemini-3.8-flash')).toBe(true);
        // The router asked for a context cache once; refused, it is not asked again.
        expect(cacheCreates).toBe(1);
        expect((service as any).streaming.contextCache.unsupportedReason('gemini-3.8-flash')).toContain('does not support');
    });

    it('returns the tools load_tools loaded, offers them on the next call, and keeps the first call\'s prefix', async () => {
        const { service } = makeService();
        const bodies: any[] = [];
        (globalThis as any).fetch = async (_url: string, init: any) => {
            bodies.push(JSON.parse(init.body));
            const chunks = bodies.length === 1
                ? [{ text: callLine(LOAD_TOOLS_NAME, { tools: ['botanical_synthesize_tree'] }), delayMs: 1 }]
                : [{ text: textLine('Loaded.'), delayMs: 1 }];
            return { ok: true, status: 200, body: streamedBody(chunks, init.signal), text: async () => '' };
        };
        const events: GeminiStreamEvent[] = [];
        const res = await service.streamGenerate({ prompt: 'grow an oak', model: 'gemini-4-argon', mode: 'agent', enableWorkspaceTools: true }, e => events.push(e));
        expect(res.loadedTools).toEqual(['botanical_synthesize_tree']);
        expect(events.find(e => e.type === 'done')?.loadedTools).toEqual(['botanical_synthesize_tree']);
        const first = fnNames(bodies[0].tools);
        const second = fnNames(bodies[1].tools);
        expect(first).not.toContain('botanical_synthesize_tree');
        expect(second.slice(0, first.length)).toEqual(first);
        expect(second[second.length - 1]).toBe('botanical_synthesize_tree');
    });
});

describe('chat turn timer', () => {
    it('records times from the turn start and logs one line', () => {
        let t = 1000;
        const timer = new ChatTurnTimer(1000, { model: 'm', call: 1, role: 'route', thinking: 'LOW', systemChars: 1, staticSystemChars: 1, turnContextChars: 0, toolCount: 2, toolBytes: 3, contentsBytes: 4 }, () => t);
        t = 1010; timer.sent();
        t = 1500; timer.firstByte(); t = 1600; timer.firstByte();
        timer.functionCall('a'); timer.toolStarted();
        t = 1700; timer.usage({ promptTokenCount: 9, cachedContentTokenCount: 8 }, 'STOP');
        const lines: string[] = [];
        const r = timer.log(l => lines.push(l));
        expect(r).toMatchObject({ sentMs: 10, firstByteMs: 500, firstFunctionCallMs: 600, toolStartMs: 600, endMs: 700, functionCalls: ['a'], usage: { promptTokenCount: 9, cachedContentTokenCount: 8, thoughtsTokenCount: 0 } });
        expect(lines[0].startsWith('[chat-turn] ')).toBe(true);
    });
});

describe('context cache', () => {
    const target = { apiBase: 'https://example.test/v1/projects/p/locations/global', projectId: 'p', location: 'global', token: 't' };
    const sys = { role: 'system', parts: [{ text: 'stable' }] };
    const tools = [{ functionDeclarations: [{ name: 'a', description: 'a' }] }] as any;

    it('creates a cache in the background, then names it for the same prefix only', async () => {
        const posts: any[] = [];
        let t = 0;
        const { ContextCacheManager } = await import('../src/node/gemini/context-cache');
        const m = new ContextCacheManager(() => (async (url: string, init: any) => {
            posts.push({ url, body: JSON.parse(init.body) });
            return { ok: true, status: 200, text: async () => JSON.stringify({ name: 'projects/p/locations/global/cachedContents/123', expireTime: new Date(3_600_000).toISOString(), usageMetadata: { totalTokenCount: 31886 } }) };
        }) as any, () => t, () => undefined);
        expect(m.lookup(target, 'gemini-3.8-flash', sys, tools)).toBeUndefined();
        expect(m.lookup(target, 'gemini-3.8-flash', sys, tools)).toBeUndefined(); // still creating: no second POST
        await m.settled();
        expect(posts).toHaveLength(1);
        expect(posts[0].url).toBe(`${target.apiBase}/cachedContents`);
        expect(posts[0].body).toMatchObject({ model: 'projects/p/locations/global/publishers/google/models/gemini-3.8-flash', systemInstruction: sys, tools, ttl: '3600s' });
        expect(m.lookup(target, 'gemini-3.8-flash', sys, tools)).toBe('projects/p/locations/global/cachedContents/123');
        // A different prefix (a loaded tool) is a different cache.
        expect(m.lookup(target, 'gemini-3.8-flash', sys, [{ functionDeclarations: [{ name: 'b' }] }] as any)).toBeUndefined();
        // Close to expiry it is renewed, not used.
        t = 3_600_000 - 60_000;
        expect(m.lookup(target, 'gemini-3.8-flash', sys, tools)).toBeUndefined();
        await m.settled();
        m.invalidate('projects/p/locations/global/cachedContents/123');
    });

    it('waits before trying a failed prefix again, and is off with SCRATCHBOX_CHAT_CONTEXT_CACHE=0', async () => {
        let t = 0;
        let calls = 0;
        const { ContextCacheManager } = await import('../src/node/gemini/context-cache');
        const m = new ContextCacheManager(() => (async () => { calls++; return { ok: false, status: 500, text: async () => 'boom' }; }) as any, () => t, () => undefined);
        m.lookup(target, 'gemini-3.8-flash', sys, tools);
        await m.settled();
        m.lookup(target, 'gemini-3.8-flash', sys, tools);
        expect(calls).toBe(1);
        t = 11 * 60_000;
        m.lookup(target, 'gemini-3.8-flash', sys, tools);
        await m.settled();
        expect(calls).toBe(2);
        process.env.SCRATCHBOX_CHAT_CONTEXT_CACHE = '0';
        try {
            t = 30 * 60_000;
            expect(m.lookup(target, 'gemini-3.8-flash', sys, tools)).toBeUndefined();
            expect(calls).toBe(2);
        } finally {
            delete process.env.SCRATCHBOX_CHAT_CONTEXT_CACHE;
        }
    });
});
