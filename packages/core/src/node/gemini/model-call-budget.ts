/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The process's model-call budget, and a run's call meter.
 *
 * - **Budget:** at most `inFlight` requests out at once and `perMinute` started in any 60 s, per model, over every client
 *   this process wraps (budgetedClient), so the tasks that share one project's Vertex quota (the Cloud Run chunk tasks)
 *   can each be given their share. Read from the environment once:
 *   - SCRATCHBOX_MODEL_CALLS_IN_FLIGHT, SCRATCHBOX_MODEL_CALLS_PER_MINUTE: every model's limits;
 *   - SCRATCHBOX_MODEL_CALL_BUDGET: one model's, over those: `model=inFlight/perMinute`, comma-separated.
 *   A limit unset, empty or 0 is none; with none set nothing waits (the behaviour before the budget). Every request
 *   counts, a retry or a hedged duplicate too (each spends quota), and requests wait their turn in the order they came.
 *   A staged build runs on a worker thread of its own: the thread that starts it serves it its budget over a port
 *   (serveCallBudget, RemoteCallBudget), so the builds of one process (a district's chunks beside its centre) share one,
 *   and a thread that ends lets go of every turn it held.
 * - **Meter:** a run's requests per model, answered or failed, their tokens and time, and an estimated cost from list
 *   prices per million tokens (MODEL_PRICES; SCRATCHBOX_MODEL_PRICES=`model=in/out`, comma-separated, adds or corrects
 *   them). A model with no price is counted and named, its cost left out.
 */

import { isMainThread, MessagePort, workerData } from 'worker_threads';
import type { GenerateContentParameters, GenerateContentResponse } from '@google/genai';
import type { VisionGenAIClient } from './vision-model-chain';

export interface ModelCallLimits { inFlight?: number; perMinute?: number }

const WINDOW_MS = 60_000;

const limitOf = (v: string | undefined) => { const n = Number(v?.trim()); return Number.isFinite(n) && n >= 1 ? Math.floor(n) : undefined; };

/** The limits the environment sets: every model's, and the models named in SCRATCHBOX_MODEL_CALL_BUDGET. Throws on a malformed entry. */
export function modelCallLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): { all: ModelCallLimits; byModel: Map<string, ModelCallLimits> } {
    const all = { inFlight: limitOf(env.SCRATCHBOX_MODEL_CALLS_IN_FLIGHT), perMinute: limitOf(env.SCRATCHBOX_MODEL_CALLS_PER_MINUTE) };
    const byModel = new Map<string, ModelCallLimits>();
    for (const part of (env.SCRATCHBOX_MODEL_CALL_BUDGET ?? '').split(',').map(s => s.trim()).filter(Boolean)) {
        const m = /^([^=\s]+)\s*=\s*(\d*)\s*\/\s*(\d*)$/.exec(part);
        if (!m) throw new Error(`SCRATCHBOX_MODEL_CALL_BUDGET: "${part}" is not model=inFlight/perMinute`);
        byModel.set(m[1], { inFlight: limitOf(m[2]), perMinute: limitOf(m[3]) });
    }
    return { all, byModel };
}

/**
 * One of `shares` equal parts of these limits, as the environment that sets them, for a process that shares the quota
 * with others (a district's Cloud Run chunk tasks beside its centre build). A limit set keeps at least 1 call; one unset
 * stays unset; with none set, nothing is set.
 */
export function modelCallShareEnv(limits: { all: ModelCallLimits; byModel: Map<string, ModelCallLimits> }, shares: number): Record<string, string> {
    const n = Math.max(1, Math.floor(shares));
    const part = (v: number | undefined) => v ? Math.max(1, Math.floor(v / n)) : undefined;
    const env: Record<string, string> = {};
    const all = { inFlight: part(limits.all.inFlight), perMinute: part(limits.all.perMinute) };
    if (all.inFlight) env.SCRATCHBOX_MODEL_CALLS_IN_FLIGHT = String(all.inFlight);
    if (all.perMinute) env.SCRATCHBOX_MODEL_CALLS_PER_MINUTE = String(all.perMinute);
    const byModel = [...limits.byModel.entries()].filter(([, l]) => l.inFlight || l.perMinute)
        .map(([m, l]) => `${m}=${part(l.inFlight) ?? ''}/${part(l.perMinute) ?? ''}`);
    if (byModel.length) env.SCRATCHBOX_MODEL_CALL_BUDGET = byModel.join(',');
    return env;
}

interface ModelLane { active: number; starts: number[]; queue: Array<{ go: () => void; signal?: AbortSignal; onAbort?: () => void }>; timer?: ReturnType<typeof setTimeout> }

export class ModelCallBudget implements CallBudget {
    private readonly lanes = new Map<string, ModelLane>();

    constructor(private readonly limits: { all: ModelCallLimits; byModel: Map<string, ModelCallLimits> } = { all: {}, byModel: new Map() }, private readonly now: () => number = Date.now) {}

    /** The limits a model's requests keep: its own where SCRATCHBOX_MODEL_CALL_BUDGET names it, else every model's. */
    limitsFor(model: string): ModelCallLimits {
        return this.limits.byModel.get(model) ?? this.limits.all;
    }

    /** Waits for a turn for one request to `model` and returns its release (call it once the request has ended). Rejects when `signal` aborts first. */
    acquire(model: string, signal?: AbortSignal): Promise<() => void> {
        const lim = this.limitsFor(model);
        if (!lim.inFlight && !lim.perMinute) return Promise.resolve(() => undefined);
        if (signal?.aborted) return Promise.reject(signal.reason ?? Object.assign(new Error('the call was aborted'), { name: 'AbortError' }));
        const lane = this.lane(model);
        return new Promise<() => void>((resolve, reject) => {
            let released = false;
            const release = () => { if (released) return; released = true; lane.active--; this.pump(model); };
            const entry: ModelLane['queue'][number] = { go: () => { if (entry.onAbort) signal?.removeEventListener('abort', entry.onAbort); resolve(release); }, ...(signal ? { signal } : {}) };
            if (signal) {
                entry.onAbort = () => { const i = lane.queue.indexOf(entry); if (i >= 0) lane.queue.splice(i, 1); reject(signal.reason ?? Object.assign(new Error('the call was aborted'), { name: 'AbortError' })); };
                signal.addEventListener('abort', entry.onAbort, { once: true });
            }
            lane.queue.push(entry);
            this.pump(model);
        });
    }

    /** Requests out, waiting, and started in the last minute, per model (for a run's record). */
    stats(): Record<string, { active: number; waiting: number; lastMinute: number }> {
        const t = this.now();
        return Object.fromEntries([...this.lanes.entries()].map(([m, l]) => [m, { active: l.active, waiting: l.queue.length, lastMinute: l.starts.filter(s => t - s < WINDOW_MS).length }]));
    }

    private lane(model: string): ModelLane {
        let l = this.lanes.get(model);
        if (!l) { l = { active: 0, starts: [], queue: [] }; this.lanes.set(model, l); }
        return l;
    }

    /** Starts the waiting requests the limits allow; when the minute's count is what holds them, wakes again as its oldest start leaves the window. */
    private pump(model: string): void {
        const lane = this.lane(model), lim = this.limitsFor(model);
        for (;;) {
            const t = this.now();
            while (lane.starts.length && t - lane.starts[0] >= WINDOW_MS) lane.starts.shift();
            if (!lane.queue.length) return;
            if (lim.inFlight && lane.active >= lim.inFlight) return;
            if (lim.perMinute && lane.starts.length >= lim.perMinute) {
                if (!lane.timer) lane.timer = setTimeout(() => { lane.timer = undefined; this.pump(model); }, Math.max(1, lane.starts[0] + WINDOW_MS - t));
                return;
            }
            const next = lane.queue.shift()!;
            lane.active++;
            lane.starts.push(t);
            next.go();
        }
    }
}

/** What a client is kept to: a turn per request (ModelCallBudget, or RemoteCallBudget on a thread another one started). */
export interface CallBudget { acquire(model: string, signal?: AbortSignal): Promise<() => void> }

type BudgetMessage = { kind: 'model-call-acquire'; id: number; model: string } | { kind: 'model-call-grant'; id: number } | { kind: 'model-call-release'; id: number } | { kind: 'model-call-cancel'; id: number };

/** The budget of the thread that started this one, every turn asked of it over `port` (serveCallBudget at the other end). */
export class RemoteCallBudget implements CallBudget {
    private next = 1;
    private readonly granted = new Map<number, () => void>();
    private open = 0;

    constructor(private readonly port: MessagePort) {
        port.on('message', (m: BudgetMessage) => { if (m?.kind === 'model-call-grant') this.granted.get(m.id)?.(); });
        port.unref();
    }

    /** The port keeps this thread alive only while a turn is asked for or held. */
    private hold(d: number): void {
        this.open += d;
        if (this.open > 0) this.port.ref(); else this.port.unref();
    }

    acquire(model: string, signal?: AbortSignal): Promise<() => void> {
        if (signal?.aborted) return Promise.reject(signal.reason ?? Object.assign(new Error('the call was aborted'), { name: 'AbortError' }));
        const id = this.next++;
        this.hold(1);
        return new Promise<() => void>((resolve, reject) => {
            const onAbort = () => { this.granted.delete(id); this.port.postMessage({ kind: 'model-call-cancel', id } satisfies BudgetMessage); this.hold(-1); reject(signal!.reason ?? Object.assign(new Error('the call was aborted'), { name: 'AbortError' })); };
            this.granted.set(id, () => {
                this.granted.delete(id);
                signal?.removeEventListener('abort', onAbort);
                let done = false;
                resolve(() => { if (done) return; done = true; this.port.postMessage({ kind: 'model-call-release', id } satisfies BudgetMessage); this.hold(-1); });
            });
            signal?.addEventListener('abort', onAbort, { once: true });
            this.port.postMessage({ kind: 'model-call-acquire', id, model } satisfies BudgetMessage);
        });
    }
}

/**
 * Serves `budget` (this process's) to a thread this one starts, over `port`: its turns asked for, given and let go. When
 * the thread ends (the port closes), every turn it held or waited for is let go.
 */
export function serveCallBudget(port: MessagePort, budget: CallBudget = processModelCallBudget()): void {
    const held = new Map<number, () => void>(), waiting = new Map<number, AbortController>();
    port.on('message', (m: BudgetMessage) => {
        if (m?.kind === 'model-call-acquire') {
            const ctl = new AbortController();
            waiting.set(m.id, ctl);
            budget.acquire(m.model, ctl.signal).then(release => {
                waiting.delete(m.id);
                held.set(m.id, release);
                port.postMessage({ kind: 'model-call-grant', id: m.id } satisfies BudgetMessage);
            }, () => waiting.delete(m.id));
        } else if (m?.kind === 'model-call-release' || m?.kind === 'model-call-cancel') {
            waiting.get(m.id)?.abort();
            waiting.delete(m.id);
            held.get(m.id)?.();
            held.delete(m.id);
        }
    });
    port.on('close', () => {
        for (const c of waiting.values()) c.abort();
        for (const r of held.values()) r();
        waiting.clear(); held.clear();
    });
    port.unref();
}

let processBudget: CallBudget | undefined;

/**
 * The budget every wrapped client in this process shares, read from the environment on first use. On a thread started
 * with a budget port (workerData.modelCallBudget, as runStagedLocationOffThread starts a build) and with any limit set,
 * the turns are asked of the thread that started it, so a process's builds share one budget.
 */
export function processModelCallBudget(): CallBudget {
    if (processBudget) return processBudget;
    const limits = modelCallLimitsFromEnv();
    const limited = !!(limits.all.inFlight || limits.all.perMinute || [...limits.byModel.values()].some(l => l.inFlight || l.perMinute));
    const port = isMainThread ? undefined : (workerData as { modelCallBudget?: unknown } | null | undefined)?.modelCallBudget;
    processBudget = limited && port instanceof MessagePort ? new RemoteCallBudget(port) : new ModelCallBudget(limits);
    return processBudget;
}

// ------------------------------------------------------------------------------------------------ the meter

/**
 * List prices, USD per million tokens (input; output, thinking included). Only what is known is listed: a model missing
 * here is counted and named in the record, its cost left out, until SCRATCHBOX_MODEL_PRICES gives it.
 */
export const MODEL_PRICES: Record<string, { inUsdPerM: number; outUsdPerM: number; source: string }> = {
    'gemini-3.8-flash': { inUsdPerM: 0.5, outUsdPerM: 3, source: 'assumed: the Gemini 3 Flash list price on Vertex AI (December 2025), not checked for this model' }
};

/** MODEL_PRICES with SCRATCHBOX_MODEL_PRICES over it (`model=in/out`, comma-separated). Throws on a malformed entry. */
export function modelPrices(env: NodeJS.ProcessEnv = process.env): Record<string, { inUsdPerM: number; outUsdPerM: number; source: string }> {
    const out = { ...MODEL_PRICES };
    for (const part of (env.SCRATCHBOX_MODEL_PRICES ?? '').split(',').map(s => s.trim()).filter(Boolean)) {
        const m = /^([^=\s]+)\s*=\s*([\d.]+)\s*\/\s*([\d.]+)$/.exec(part);
        if (!m) throw new Error(`SCRATCHBOX_MODEL_PRICES: "${part}" is not model=in/out (USD per million tokens)`);
        out[m[1]] = { inUsdPerM: Number(m[2]), outUsdPerM: Number(m[3]), source: 'SCRATCHBOX_MODEL_PRICES' };
    }
    return out;
}

export interface ModelCallTally { requests: number; answered: number; failed: number; promptTokens: number; outputTokens: number; thinkingTokens: number; ms: number }

export interface ModelCallReport {
    schema: 'scratchbox.model-calls/1';
    /** Requests sent to a model (retries and hedged duplicates each count; answers replayed from a cache are not requests). */
    requests: number; failed: number;
    byModel: Record<string, ModelCallTally & { estimatedUsd?: number; price?: string }>;
    /** The cost of the priced models' tokens; `unpriced` names the models it leaves out. */
    estimatedUsd: number; unpriced: string[];
    /** SCRATCHBOX_MODEL_PRICES could not be read (MODEL_PRICES were used). */
    priceError?: string;
}

/** One run's model requests, from every client wrapped with it (budgetedClient). */
export class ModelCallMeter {
    private readonly tally = new Map<string, ModelCallTally>();

    private of(model: string): ModelCallTally {
        let t = this.tally.get(model);
        if (!t) { t = { requests: 0, answered: 0, failed: 0, promptTokens: 0, outputTokens: 0, thinkingTokens: 0, ms: 0 }; this.tally.set(model, t); }
        return t;
    }

    answered(model: string, usage: GenerateContentResponse['usageMetadata'] | undefined, ms: number): void {
        const t = this.of(model);
        t.requests++; t.answered++; t.ms += ms;
        t.promptTokens += usage?.promptTokenCount ?? 0;
        t.outputTokens += usage?.candidatesTokenCount ?? 0;
        t.thinkingTokens += usage?.thoughtsTokenCount ?? 0;
    }

    failed(model: string, ms: number): void {
        const t = this.of(model);
        t.requests++; t.failed++; t.ms += ms;
    }

    /** The tally priced (`prices`, else modelPrices(); a malformed SCRATCHBOX_MODEL_PRICES is named and MODEL_PRICES used). */
    report(given?: ReturnType<typeof modelPrices>): ModelCallReport {
        let prices = given, priceError: string | undefined;
        if (!prices) try { prices = modelPrices(); } catch (err) { prices = MODEL_PRICES; priceError = err instanceof Error ? err.message : String(err); }
        const byModel: ModelCallReport['byModel'] = {}, unpriced: string[] = [];
        let requests = 0, failed = 0, usd = 0;
        for (const [model, t] of [...this.tally.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
            requests += t.requests; failed += t.failed;
            const p = prices[model];
            if (!p) { unpriced.push(model); byModel[model] = { ...t }; continue; }
            const cost = (t.promptTokens * p.inUsdPerM + (t.outputTokens + t.thinkingTokens) * p.outUsdPerM) / 1e6;
            usd += cost;
            byModel[model] = { ...t, estimatedUsd: Math.round(cost * 1e4) / 1e4, price: `${p.inUsdPerM}/${p.outUsdPerM} USD per million tokens in/out (${p.source})` };
        }
        return { schema: 'scratchbox.model-calls/1', requests, failed, byModel, estimatedUsd: Math.round(usd * 1e4) / 1e4, unpriced, ...(priceError ? { priceError } : {}) };
    }
}

/**
 * The client with every request kept to the budget (the process's unless given) and, with a meter, counted. Everything
 * else on the client is the client's own.
 */
export function budgetedClient<C extends VisionGenAIClient>(client: C, opts: { budget?: CallBudget; meter?: ModelCallMeter } = {}): C {
    const budget = opts.budget ?? processModelCallBudget(), meter = opts.meter, models = client.models;
    const signalOf = (p: GenerateContentParameters) => (p.config as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
    const generateContent = async (params: GenerateContentParameters): Promise<GenerateContentResponse> => {
        const release = await budget.acquire(params.model, signalOf(params));
        const t0 = Date.now();
        try {
            const r = await models.generateContent(params);
            meter?.answered(params.model, r.usageMetadata, Date.now() - t0);
            return r;
        } catch (err) {
            meter?.failed(params.model, Date.now() - t0);
            throw err;
        } finally { release(); }
    };
    const stream = models.generateContentStream;
    const generateContentStream = stream ? async (params: GenerateContentParameters): Promise<AsyncIterable<GenerateContentResponse>> => {
        const release = await budget.acquire(params.model, signalOf(params));
        const t0 = Date.now();
        let chunks: AsyncIterable<GenerateContentResponse>;
        try { chunks = await stream.call(models, params); } catch (err) { meter?.failed(params.model, Date.now() - t0); release(); throw err; }
        // the turn is held until the stream has ended, whichever way
        return (async function* () {
            let last: GenerateContentResponse | undefined, ok = false;
            try { for await (const c of chunks) { last = c; yield c; } ok = true; }
            finally {
                if (ok) meter?.answered(params.model, last?.usageMetadata, Date.now() - t0); else meter?.failed(params.model, Date.now() - t0);
                release();
            }
        })();
    } : undefined;
    const wrapped = Object.create(models, { generateContent: { value: generateContent }, ...(generateContentStream ? { generateContentStream: { value: generateContentStream } } : {}) });
    return Object.create(client, { models: { value: wrapped } }) as C;
}
