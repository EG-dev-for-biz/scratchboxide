/**
 * Chat routing eval (BILLED: every request is a real Gemini call on the app's Vertex service account).
 *
 * Sends the first model call of each request in requests.json exactly as the chat builds it (system instruction,
 * tool declarations, contents, thinking config) and records which tool the model chose and with which arguments,
 * or that it answered in text, plus the call's timings and usage. A variant changes one thing (the model, the
 * thinking level, how tools are offered). `compare` scores a variant against the reference: tool agreement, key
 * argument agreement, and a blind A/B judgement by gemini-4-argon on every disagreement.
 *
 *   npx vite-node scripts/chat-routing-eval/run.ts -- run --variant reference --out <dir> --yes-billed
 *   npx vite-node scripts/chat-routing-eval/run.ts -- compare --ref <dir>/reference.json --var <dir>/<variant>.json --yes-billed
 *
 * Variants: see VARIANTS below. Nothing here runs in the unit tests.
 */
import * as fs from 'fs';
import * as path from 'path';
import { GeminiService } from '../../packages/core/src/node/gemini-service';
import type { GeminiGenerateRequest } from '../../packages/core/src/common/gemini-protocol';
import type { CanvasArtifact } from '../../packages/core/src/browser/generative-canvas/canvas-types';
import { FIXTURES } from './fixtures';

interface EvalRequest { id: string; family: string; prompt: string; fixture?: string }

export interface Variant {
    name: string;
    model: string;
    thinkingLevel?: 'LOW' | 'MEDIUM' | 'HIGH';
    /** Thinking config sent as is (a Gemini 3 model takes a budget). */
    thinking?: Record<string, unknown>;
    /** Read the stable prefix from an explicit context cache, as the chat does (context-cache.ts). */
    contextCache?: boolean;
    /** Env set while the payload is built (switches the chat reads). */
    env?: Record<string, string>;
}

const VARIANTS: Record<string, Variant> = {
    reference: { name: 'reference', model: 'gemini-4-argon', thinkingLevel: 'MEDIUM', env: { SCRATCHBOX_CHAT_TOOLS: 'all', SCRATCHBOX_CHAT_STABLE_PREFIX: '0' } },
    'stable-prefix': { name: 'stable-prefix', model: 'gemini-4-argon', thinkingLevel: 'MEDIUM', env: { SCRATCHBOX_CHAT_TOOLS: 'all', SCRATCHBOX_CHAT_STABLE_PREFIX: '1' } },
    'argon-low': { name: 'argon-low', model: 'gemini-4-argon', thinkingLevel: 'LOW', env: { SCRATCHBOX_CHAT_TOOLS: 'all', SCRATCHBOX_CHAT_STABLE_PREFIX: '1' } },
    'flash-all': { name: 'flash-all', model: 'gemini-3.8-flash', env: { SCRATCHBOX_CHAT_TOOLS: 'all', SCRATCHBOX_CHAT_STABLE_PREFIX: '1' } },
    catalog: { name: 'catalog', model: 'gemini-4-argon', thinkingLevel: 'MEDIUM', env: { SCRATCHBOX_CHAT_TOOLS: 'catalog', SCRATCHBOX_CHAT_STABLE_PREFIX: '1' } },
    'catalog-low': { name: 'catalog-low', model: 'gemini-4-argon', thinkingLevel: 'LOW', env: { SCRATCHBOX_CHAT_TOOLS: 'catalog', SCRATCHBOX_CHAT_STABLE_PREFIX: '1' } },
    'catalog-flash': { name: 'catalog-flash', model: 'gemini-3.8-flash', env: { SCRATCHBOX_CHAT_TOOLS: 'catalog', SCRATCHBOX_CHAT_STABLE_PREFIX: '1' } },
    // The shipped default: catalog tools, the request's context at the end of the system instruction; the first call
    // races the chat model at LOW against itself at MEDIUM (compose default-low over default-med).
    'default-med': { name: 'default-med', model: 'gemini-4-argon', thinkingLevel: 'MEDIUM', env: { SCRATCHBOX_CHAT_TOOLS: 'catalog', SCRATCHBOX_CHAT_STABLE_PREFIX: '0' } },
    'default-low': { name: 'default-low', model: 'gemini-4-argon', thinkingLevel: 'LOW', env: { SCRATCHBOX_CHAT_TOOLS: 'catalog', SCRATCHBOX_CHAT_STABLE_PREFIX: '0' } },
    // As the router runs in the chat: the client's thinking budget for a Gemini 3 model, prefix from the cache.
    'router-flash': { name: 'router-flash', model: 'gemini-3.8-flash', thinking: { thinkingBudget: 1024 }, contextCache: true, env: { SCRATCHBOX_CHAT_TOOLS: 'catalog', SCRATCHBOX_CHAT_STABLE_PREFIX: '1' } },
    'router-flash-lite': { name: 'router-flash-lite', model: 'gemini-3.5-flash-lite', thinking: { thinkingBudget: 1024 }, contextCache: true, env: { SCRATCHBOX_CHAT_TOOLS: 'catalog', SCRATCHBOX_CHAT_STABLE_PREFIX: '1' } }
};

export interface CallResult {
    id: string;
    family: string;
    prompt: string;
    variant: string;
    model: string;
    ok: boolean;
    error?: string;
    tool?: string;
    args?: Record<string, unknown>;
    /** Further function calls in the same reply. */
    moreCalls?: Array<{ name: string; args: Record<string, unknown> }>;
    text?: string;
    firstByteMs?: number;
    firstFunctionCallMs?: number;
    endMs?: number;
    usage?: Record<string, number>;
    systemChars: number;
    toolCount: number;
    toolBytes: number;
    /** Set when the model called load_tools first: the tools it loaded (the result is its next call). */
    viaLoad?: string[];
    loadUsage?: Record<string, number>;
}

function arg(name: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

function requestFor(r: EvalRequest): GeminiGenerateRequest {
    const activeArtifact = r.fixture ? FIXTURES[r.fixture] as CanvasArtifact : undefined;
    if (r.fixture && !activeArtifact) throw new Error(`unknown fixture ${r.fixture}`);
    // As useSendMessage sends a chat request.
    return {
        prompt: r.prompt,
        enableGoogleSearch: true,
        activeArtifact,
        chatHistory: activeArtifact ? [{ role: 'user', text: 'earlier request that built the open artifact' }, { role: 'model', text: `Built "${activeArtifact.title}".` }] : [],
        mode: 'agent',
        enableWorkspaceTools: true,
        autoVerify: true,
        workspaceRoot: undefined
    };
}

async function withEnv<T>(env: Record<string, string> | undefined, fn: () => Promise<T>): Promise<T> {
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(env || {})) { saved[k] = process.env[k]; process.env[k] = v; }
    try { return await fn(); } finally {
        for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
}

async function streamOnce(service: GeminiService, variant: Variant, r: EvalRequest): Promise<CallResult> {
    const engine = (service as any).streaming;
    const client = (service as any).client;
    const request = requestFor(r);
    const built = await withEnv(variant.env, () => engine.buildFirstCallPayload(request, variant.model));
    const payload = built.payload;
    if (variant.thinking) payload.generationConfig.thinkingConfig = variant.thinking;
    else if (variant.thinkingLevel) payload.generationConfig.thinkingConfig = { thinkingLevel: variant.thinkingLevel };
    else delete payload.generationConfig.thinkingConfig;
    const base: CallResult = {
        id: r.id, family: r.family, prompt: r.prompt, variant: variant.name, model: variant.model, ok: false,
        systemChars: built.shape.systemChars, toolCount: built.shape.toolCount, toolBytes: built.shape.toolBytes
    };
    const cached = async (p: any) => {
        if (!variant.contextCache) return p;
        const { token, projectId } = await client.getAccessToken();
        const target = engine.contextCacheTarget({ projectId, token });
        let name = engine.contextCache.lookup(target, variant.model, p.systemInstruction, p.tools);
        if (!name) { await engine.contextCache.settled(); name = engine.contextCache.lookup(target, variant.model, p.systemInstruction, p.tools); }
        if (!name) return p;
        const { systemInstruction, tools, ...rest } = p;
        return { ...rest, cachedContent: name };
    };
    const first = await callOnce(client, variant.model, await cached(payload), { ...base });
    if (!first.ok || first.tool !== 'load_tools') return first;
    // The model loaded tools first: run the load as the chat does and ask again, so the result is the tool it then
    // calls; the timings add up both calls (what the user waits for).
    const loaded = (first.args?.tools as string[] | undefined) || [];
    const request2 = { ...request, loadedTools: loaded };
    const tools2 = await withEnv(variant.env, async () => engine.buildToolDeclarations(request2));
    const payload2 = JSON.parse(JSON.stringify(payload));
    payload2.tools = tools2;
    payload2.contents.push({ role: 'model', parts: [{ functionCall: { name: 'load_tools', args: first.args }, thought_signature: first.signature || 'skip_thought_signature_validator' }] });
    payload2.contents.push({ role: 'user', parts: [{ functionResponse: { name: 'load_tools', response: { name: 'load_tools', content: { success: true, loaded, note: 'These tools are now declared and can be called.' } } } }] });
    const second = await callOnce(client, variant.model, await cached(payload2), { ...base });
    const add = (a?: number, b?: number) => (a === undefined || b === undefined ? undefined : a + b);
    return {
        ...second,
        viaLoad: loaded,
        firstByteMs: first.firstByteMs,
        firstFunctionCallMs: add(first.endMs, second.firstFunctionCallMs),
        endMs: add(first.endMs, second.endMs),
        loadUsage: first.usage
    } as CallResult;
}

async function callOnce(client: any, model: string, payload: unknown, base: CallResult): Promise<CallResult & { signature?: string }> {
    const { token, projectId } = await client.getAccessToken();
    const url = client.vertexModelUrl(projectId, model, 'streamGenerateContent');
    const t0 = Date.now();
    const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!res.ok) return { ...base, error: `${res.status} ${(await res.text()).slice(0, 400)}` };
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    let text = '';
    let usage: Record<string, number> | undefined;
    let signature: string | undefined;
    const out: CallResult & { signature?: string } = { ...base };
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (out.firstByteMs === undefined) out.firstByteMs = Date.now() - t0;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            let j: any;
            try { j = JSON.parse(line.slice(5)); } catch { continue; }
            if (j.usageMetadata) usage = j.usageMetadata;
            for (const c of j.candidates || []) for (const p of c.content?.parts || []) {
                if (p.functionCall) {
                    if (out.firstFunctionCallMs === undefined) out.firstFunctionCallMs = Date.now() - t0;
                    calls.push({ name: p.functionCall.name, args: p.functionCall.args || {} });
                    signature = signature || p.thoughtSignature || p.thought_signature;
                } else if (p.text && !p.thought) text += p.text;
            }
        }
    }
    out.endMs = Date.now() - t0;
    out.ok = true;
    out.usage = usage;
    if (calls.length) { out.tool = calls[0].name; out.args = calls[0].args; if (calls.length > 1) out.moreCalls = calls.slice(1); }
    if (text) out.text = text.slice(0, 600);
    if (signature) out.signature = signature;
    return out;
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: n }, async () => {
        while (next < items.length) { const i = next++; results[i] = await fn(items[i]); }
    }));
    return results;
}

async function withRetry<T>(fn: () => Promise<T & { ok: boolean; error?: string }>): Promise<T & { ok: boolean; error?: string }> {
    let last: T & { ok: boolean; error?: string };
    for (let attempt = 0; attempt < 5; attempt++) {
        try { last = await fn(); } catch (e) { last = { ok: false, error: String(e) } as any; }
        if (last.ok || !/429|RESOURCE_EXHAUSTED|503|UNAVAILABLE|fetch failed|ECONNRESET/.test(last.error || '')) return last;
        await new Promise(r => setTimeout(r, 10_000 * (attempt + 1)));
    }
    return last!;
}

// ---------------------------------------------------------------- compare

const JUDGE_VOTES = Number(process.env.EVAL_JUDGE_VOTES || 3);

/** The arguments that decide what a call does, per tool; other tools compare their scalar arguments. */
const KEY_ARGS: Record<string, string[]> = {
    google_3d_tiles_get_clay: ['address', 'location', 'query', 'isolate', 'radiusMeters', 'stageIntoActiveScene'],
    google_3d_tiles_get_full_texture: ['address', 'location', 'query', 'isolate', 'radiusMeters', 'stageIntoActiveScene'],
    build_3d_object_from_reference: ['subject', 'location', 'addToActiveScene', 'replaceObjectId', 'clay'],
    mount_canvas_primitive: ['type'],
    staged_location_material_mode: ['mode'],
    generate_image: [],
    load_tools: []
};

function norm(v: unknown): string {
    return typeof v === 'string' ? v.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() : JSON.stringify(v);
}

function sameValue(a: unknown, b: unknown): boolean {
    if (typeof a === 'string' && typeof b === 'string') {
        const x = norm(a), y = norm(b);
        return x === y || x.includes(y) || y.includes(x);
    }
    if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= Math.max(1e-6, 0.25 * Math.max(Math.abs(a), Math.abs(b)));
    return JSON.stringify(a) === JSON.stringify(b);
}

/** Fraction of the reference's key arguments the variant set to the same value (1 when there are none). */
export function argAgreement(tool: string, ref: Record<string, unknown> = {}, v: Record<string, unknown> = {}): number {
    const keys = (KEY_ARGS[tool] ?? Object.keys(ref).filter(k => ['string', 'number', 'boolean'].includes(typeof ref[k])))
        .filter(k => k in ref || k in v);
    if (keys.length === 0) return 1;
    return keys.filter(k => sameValue(ref[k], v[k])).length / keys.length;
}

function describeChoice(c: CallResult): string {
    if (!c.ok) return `(failed: ${c.error})`;
    if (c.tool) return `calls ${c.tool}(${JSON.stringify(c.args).slice(0, 1500)})${c.moreCalls ? ` then ${c.moreCalls.map(m => m.name).join(', ')}` : ''}`;
    return `answers in text: ${JSON.stringify((c.text || '').slice(0, 800))}`;
}

async function judge(service: GeminiService, r: EvalRequest, a: CallResult, b: CallResult): Promise<{ winner: 'ref' | 'var' | 'tie'; reason: string }> {
    const flip = Math.random() < 0.5;
    const [first, second] = flip ? [b, a] : [a, b];
    const canvas = r.fixture ? `The canvas has this artifact open: ${(FIXTURES[r.fixture] as any).type} "${(FIXTURES[r.fixture] as any).title}".` : 'The canvas is empty.';
    const prompt = `You judge the first step a creative-tools assistant (Scratchbox IDE: 3D scenes of real places from Google 3D Tiles, object builds, video/VFX tools, live-code sandbox apps, documents, boards) took for a user's request. ${canvas}

User request: ${JSON.stringify(r.prompt)}

Response A ${describeChoice(first)}
Response B ${describeChoice(second)}

A tool named load_tools only loads more tool declarations; judge it by whether the toolset it loads is the right one for the request. Which first step better serves the request (right tool, right arguments, or a text answer when that is what the user needs)? Reply with JSON only: {"better": "A" | "B" | "tie", "reason": "<one sentence>"}`;
    const res = await (service as any).client.generateContent({ model: 'gemini-4-argon', prompt, temperature: 0, maxOutputTokens: 2048 });
    const m = /\{[\s\S]*\}/.exec(res.text || '');
    const parsed = m ? JSON.parse(m[0]) : { better: 'tie', reason: `unparsed: ${res.text}` };
    const better = parsed.better === 'A' ? (flip ? 'var' : 'ref') : parsed.better === 'B' ? (flip ? 'ref' : 'var') : 'tie';
    return { winner: better, reason: parsed.reason };
}

async function main(): Promise<void> {
    const cmd = process.argv.find(a => a === 'run' || a === 'compare' || a === 'compose');
    if (cmd === 'compose') {
        // What the routing race (fast-router.ts) would answer: the router's call when its reply has one, else the
        // chat model's choice. Timing: the router's call time when it decided, else the chat model's.
        const chat: CallResult[] = JSON.parse(fs.readFileSync(arg('chat')!, 'utf8'));
        const router: CallResult[] = JSON.parse(fs.readFileSync(arg('router')!, 'utf8'));
        const composed = chat.map(c => {
            const r = router.find(x => x.id === c.id);
            const routerDecides = !!r?.ok && !!r.tool && (c.firstFunctionCallMs === undefined || c.tool === undefined || (r.endMs ?? Infinity) < (c.firstFunctionCallMs ?? c.firstByteMs ?? Infinity));
            return routerDecides ? { ...r!, variant: arg('name')!, decidedBy: 'router' } : { ...c, variant: arg('name')!, decidedBy: 'chat' };
        });
        fs.writeFileSync(arg('out')!, JSON.stringify(composed, null, 2));
        console.log(`router decided ${composed.filter((x: any) => x.decidedBy === 'router').length}/${composed.length}`);
        return;
    }
    if (!process.argv.includes('--yes-billed')) throw new Error('every request is a billed Gemini call: pass --yes-billed');
    const requests: EvalRequest[] = JSON.parse(fs.readFileSync(path.join(__dirname, 'requests.json'), 'utf8'));
    const only = arg('only')?.split(',');
    const selected = only ? requests.filter(r => only.includes(r.id)) : requests;
    const service = new GeminiService();
    if (cmd === 'run') {
        const variant = VARIANTS[arg('variant') || 'reference'];
        if (!variant) throw new Error(`unknown variant; one of ${Object.keys(VARIANTS).join(', ')}`);
        const outDir = arg('out')!;
        fs.mkdirSync(outDir, { recursive: true });
        const conc = Number(arg('concurrency') || 4);
        const results = await pool(selected, conc, r => withRetry(() => streamOnce(service, variant, r)));
        const file = path.join(outDir, `${arg('name') || variant.name}.json`);
        fs.writeFileSync(file, JSON.stringify(results, null, 2));
        for (const x of results) console.log(`${x.id.padEnd(22)} ${x.viaLoad ? `[load ${x.viaLoad.join(',')}] ` : ''}${(x.tool || (x.ok ? 'TEXT' : 'FAIL ' + x.error)).slice(0, 60).padEnd(40)} fb=${x.firstByteMs} fc=${x.firstFunctionCallMs ?? '-'} end=${x.endMs} prompt=${x.usage?.promptTokenCount} cached=${x.usage?.cachedContentTokenCount ?? 0} thoughts=${x.usage?.thoughtsTokenCount ?? 0}`);
        console.log(`wrote ${file}`);
        return;
    }
    if (cmd === 'compare') {
        const ref: CallResult[] = JSON.parse(fs.readFileSync(arg('ref')!, 'utf8'));
        const vr: CallResult[] = JSON.parse(fs.readFileSync(arg('var')!, 'utf8'));
        const rows: any[] = [];
        for (const r of selected) {
            const a = ref.find(x => x.id === r.id), b = vr.find(x => x.id === r.id);
            if (!a || !b) continue;
            const sameTool = (a.tool || 'TEXT') === (b.tool || 'TEXT');
            const args = sameTool && a.tool ? argAgreement(a.tool, a.args, b.args) : undefined;
            const row: any = { id: r.id, family: r.family, ref: a.tool || 'TEXT', var: b.tool || 'TEXT', sameTool, args };
            if (!sameTool || (args !== undefined && args < 1)) {
                // Three blind judgements (order shuffled each time); the majority decides, else a tie.
                const votes: Array<{ winner: string; reason: string }> = [];
                for (let k = 0; k < JUDGE_VOTES; k++) votes.push(await withRetry(async () => ({ ok: true, ...(await judge(service, r, a, b)) })) as any);
                const count = (w: string) => votes.filter(v => v.winner === w).length;
                row.judge = count('var') * 2 > JUDGE_VOTES ? 'var' : count('ref') * 2 > JUDGE_VOTES ? 'ref' : 'tie';
                row.votes = votes.map(v => v.winner).join(',');
                row.reason = votes.find(v => v.winner === row.judge)?.reason ?? votes[0].reason;
            }
            rows.push(row);
            console.log(`${r.id.padEnd(22)} ${row.ref.padEnd(34)} ${row.var.padEnd(34)} args=${args === undefined ? '-' : args.toFixed(2)} ${row.judge ? `judge=${row.judge} (${row.votes}): ${row.reason}` : ''}`);
        }
        const n = rows.length;
        const tool = rows.filter(x => x.sameTool).length;
        const withArgs = rows.filter(x => x.args !== undefined);
        const argMean = withArgs.reduce((s, x) => s + x.args, 0) / Math.max(1, withArgs.length);
        const judged = rows.filter(x => x.judge);
        const summary = {
            n, toolAgreement: tool / n, argAgreementMean: argMean,
            judged: judged.length,
            varBetter: judged.filter(x => x.judge === 'var').length,
            refBetter: judged.filter(x => x.judge === 'ref').length,
            ties: judged.filter(x => x.judge === 'tie').length
        };
        console.log(JSON.stringify(summary));
        const out = arg('out');
        if (out) fs.writeFileSync(out, JSON.stringify({ summary, rows }, null, 2));
        return;
    }
    throw new Error('usage: run|compare');
}

main().catch(e => { console.error(e); process.exit(1); });
