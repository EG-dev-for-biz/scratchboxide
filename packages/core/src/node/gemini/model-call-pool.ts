/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The district model pool: one queue and one call budget for a whole district's chunk tasks, wherever they run (Cloud Run
 * jobs, the pool's instances, the fast VMs), where each task used to get an equal share of the limits (modelCallShareEnv).
 *
 * - **Server** (ModelCallPool, modelPoolHandler; `kd-chunk-job.js --model-pool`, a Cloud Run service with one instance):
 *   per district a ModelCallBudget (SCRATCHBOX_MODEL_POOL_LIMITS: `model=inFlight/perMinute`, comma-separated, `*` for
 *   every model) and a cap on the calls granted (SCRATCHBOX_MODEL_POOL_MAX_CALLS; past it a turn is refused, the call
 *   fails and its step degrades with its reason). A turn is asked with POST /turn and answered when granted (a ticket),
 *   or after a while with "ask again" (a long poll); POST /release gives it back; a ticket a task never gives back (it
 *   died) is released after TICKET_TTL_MS. GET /stats?district= reports what was granted.
 * - **Client** (PoolCallBudget): the process's call budget when SCRATCHBOX_MODEL_POOL_URL and
 *   SCRATCHBOX_MODEL_POOL_DISTRICT are set (processModelCallBudget); a build's worker threads reach it through their
 *   budget port as before. Only turns go to the pool: the request itself goes straight to Vertex AI.
 *
 * The answers are cached by content as before (pipeline-k/model-readings.ts), so a rebuild asks only about what changed.
 */

import * as crypto from 'crypto';
import type * as http from 'http';
import { ModelCallBudget, type CallBudget, type ModelCallLimits } from './model-call-budget';

/** A ticket not given back within this long is released (its task died holding it). */
export const TICKET_TTL_MS = 15 * 60_000;
/** How long the server holds a turn request before answering "ask again" (under Cloud Run's and proxies' idle limits). */
export const TURN_POLL_MS = 25_000;

export class ModelPoolBudgetSpentError extends Error {
    constructor(district: string, max: number) {
        super(`the district model pool's budget for ${district} is spent (${max} calls)`);
        this.name = 'ModelPoolBudgetSpentError';
    }
}

/** SCRATCHBOX_MODEL_POOL_LIMITS: `model=inFlight/perMinute`, `*` for every model's. Throws on a malformed entry. */
export function modelPoolLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): { all: ModelCallLimits; byModel: Map<string, ModelCallLimits> } {
    const n = (v: string) => { const x = Number(v); return Number.isFinite(x) && x >= 1 ? Math.floor(x) : undefined; };
    const all: ModelCallLimits = {}, byModel = new Map<string, ModelCallLimits>();
    for (const part of (env.SCRATCHBOX_MODEL_POOL_LIMITS ?? '').split(',').map(s => s.trim()).filter(Boolean)) {
        const m = /^([^=\s]+)\s*=\s*(\d*)\s*\/\s*(\d*)$/.exec(part);
        if (!m) throw new Error(`SCRATCHBOX_MODEL_POOL_LIMITS: "${part}" is not model=inFlight/perMinute`);
        const l: ModelCallLimits = { ...(n(m[2]) ? { inFlight: n(m[2]) } : {}), ...(n(m[3]) ? { perMinute: n(m[3]) } : {}) };
        if (m[1] === '*') Object.assign(all, l); else byModel.set(m[1], l);
    }
    return { all, byModel };
}

interface DistrictLane { budget: ModelCallBudget; granted: Map<string, number>; refused: number; waiting: number; firstMs: number; lastMs: number }

/** The pool's state: a budget, a cap and counts per district. */
export class ModelCallPool {
    private readonly districts = new Map<string, DistrictLane>();
    private readonly tickets = new Map<string, { release: () => void; timer: ReturnType<typeof setTimeout> }>();

    constructor(private readonly limits: { all: ModelCallLimits; byModel: Map<string, ModelCallLimits> }, private readonly maxCalls?: number, private readonly now: () => number = Date.now) {}

    private lane(district: string): DistrictLane {
        let l = this.districts.get(district);
        if (!l) { l = { budget: new ModelCallBudget(this.limits, this.now), granted: new Map(), refused: 0, waiting: 0, firstMs: this.now(), lastMs: this.now() }; this.districts.set(district, l); }
        return l;
    }

    /** A turn for one request to `model` in `district`: its ticket, once granted. Throws ModelPoolBudgetSpentError past the cap. */
    async turn(district: string, model: string, signal?: AbortSignal): Promise<string> {
        const l = this.lane(district);
        const spent = () => [...l.granted.values()].reduce((a, b) => a + b, 0);
        if (this.maxCalls && spent() >= this.maxCalls) { l.refused++; throw new ModelPoolBudgetSpentError(district, this.maxCalls); }
        l.waiting++;
        let release: () => void;
        try { release = await l.budget.acquire(model, signal); } finally { l.waiting--; }
        // the cap counted again: others may have been granted while this one waited
        if (this.maxCalls && spent() >= this.maxCalls) { release(); l.refused++; throw new ModelPoolBudgetSpentError(district, this.maxCalls); }
        l.granted.set(model, (l.granted.get(model) ?? 0) + 1);
        l.lastMs = this.now();
        const ticket = crypto.randomBytes(12).toString('hex');
        const timer = setTimeout(() => this.release(ticket), TICKET_TTL_MS);
        timer.unref?.();
        this.tickets.set(ticket, { release, timer });
        return ticket;
    }

    /** Gives a turn back (a ticket given back twice, or expired, is nothing). */
    release(ticket: string): boolean {
        const t = this.tickets.get(ticket);
        if (!t) return false;
        this.tickets.delete(ticket);
        clearTimeout(t.timer);
        t.release();
        return true;
    }

    stats(district: string): { granted: Record<string, number>; refused: number; waiting: number; held: number; firstMs?: number; lastMs?: number } {
        const l = this.districts.get(district);
        if (!l) return { granted: {}, refused: 0, waiting: 0, held: 0 };
        return { granted: Object.fromEntries(l.granted), refused: l.refused, waiting: l.waiting, held: this.tickets.size, firstMs: l.firstMs, lastMs: l.lastMs };
    }
}

const json = (res: http.ServerResponse, status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body)); };
const readBody = (req: http.IncomingMessage) => new Promise<Record<string, unknown>>((resolve, reject) => {
    let s = '';
    req.on('data', d => { s += d; if (s.length > 64_000) req.destroy(); });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) as Record<string, unknown> : {}); } catch (err) { reject(err); } });
    req.on('error', reject);
});
const name = (v: unknown) => (typeof v === 'string' && /^[\w.@:/-]{1,128}$/.test(v) ? v : undefined);

/** The pool's HTTP side (POST /turn, POST /release, GET /stats, GET /healthz). */
export function modelPoolHandler(pool: ModelCallPool, pollMs = TURN_POLL_MS): (req: http.IncomingMessage, res: http.ServerResponse) => void {
    return (req, res) => {
        const url = new URL(req.url ?? '/', 'http://pool');
        if (req.method === 'GET' && url.pathname === '/healthz') { res.writeHead(200).end('ok'); return; }
        if (req.method === 'GET' && url.pathname === '/stats') {
            const district = name(url.searchParams.get('district'));
            if (!district) { json(res, 400, { error: 'district is required' }); return; }
            json(res, 200, pool.stats(district));
            return;
        }
        if (req.method !== 'POST') { json(res, 404, { error: 'not found' }); return; }
        readBody(req).then(async body => {
            if (url.pathname === '/release') {
                const ticket = typeof body.ticket === 'string' ? body.ticket : '';
                json(res, 200, { released: pool.release(ticket) });
                return;
            }
            if (url.pathname !== '/turn') { json(res, 404, { error: 'not found' }); return; }
            const district = name(body.district), model = name(body.model);
            if (!district || !model) { json(res, 400, { error: 'district and model are required' }); return; }
            // the caller gone, or this poll's time up: the wait is given up (a turn granted then is given back at once)
            const own = new AbortController();
            const timer = setTimeout(() => own.abort(Object.assign(new Error('ask again'), { name: 'AbortError' })), pollMs);
            res.on('close', () => { if (!res.writableEnded) own.abort(Object.assign(new Error('the caller went away'), { name: 'AbortError' })); });
            try {
                const ticket = await pool.turn(district, model, own.signal);
                if (res.destroyed) { pool.release(ticket); return; }
                json(res, 200, { ticket });
            } catch (err) {
                if (err instanceof ModelPoolBudgetSpentError) { json(res, 429, { error: err.message, spent: true }); return; }
                if (own.signal.aborted) { if (!res.destroyed) json(res, 202, { again: true }); return; }
                json(res, 500, { error: err instanceof Error ? err.message : String(err) });
            } finally {
                clearTimeout(timer);
            }
        }).catch(err => json(res, 400, { error: err instanceof Error ? err.message : String(err) }));
    };
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * The process's call budget from the district model pool: each turn asked of the pool (POST /turn, asked again while it
 * answers "again"), given back when the request ends. `headers` gives the pool's authorization (an ID token for a Cloud
 * Run service). A pool that cannot be reached for POOL_UNREACHABLE_MS fails the call, as a quota error would.
 */
export class PoolCallBudget implements CallBudget {
    static readonly POOL_UNREACHABLE_MS = 120_000;

    constructor(private readonly url: string, private readonly district: string, private readonly headers: () => Promise<Record<string, string>> = async () => ({}),
        private readonly fetchImpl: Fetch = ((u, i) => fetch(u, i)) as Fetch, private readonly now: () => number = Date.now) {}

    async acquire(model: string, signal?: AbortSignal): Promise<() => void> {
        let failingSince: number | undefined;
        for (;;) {
            if (signal?.aborted) throw signal.reason ?? Object.assign(new Error('aborted'), { name: 'AbortError' });
            let res: Awaited<ReturnType<Fetch>> | undefined, err: unknown;
            try {
                res = await this.fetchImpl(`${this.url}/turn`, { method: 'POST', headers: { 'content-type': 'application/json', ...(await this.headers()) }, body: JSON.stringify({ district: this.district, model }), ...(signal ? { signal } : {}) });
            } catch (e) { err = e; }
            if (res?.ok && res.status === 200) {
                const ticket = String(((await res.json()) as { ticket?: string }).ticket ?? '');
                let given = false;
                return () => {
                    if (given) return;
                    given = true;
                    void this.headers().then(h => this.fetchImpl(`${this.url}/release`, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify({ ticket }) })).catch(() => undefined);
                };
            }
            if (res?.status === 202) { failingSince = undefined; continue; }
            if (res?.status === 429) {
                const body = (await res.json().catch(() => ({}))) as { spent?: boolean; error?: string };
                if (body.spent) throw new Error(body.error ?? 'the district model pool\'s budget is spent');
            }
            if (signal?.aborted) throw signal.reason;
            failingSince ??= this.now();
            if (this.now() - failingSince > PoolCallBudget.POOL_UNREACHABLE_MS) throw new Error(`the district model pool at ${this.url} did not answer (${err instanceof Error ? err.message : res ? `HTTP ${res.status}` : 'no answer'})`);
            await new Promise(r => setTimeout(r, 1_000));
        }
    }
}

/** The pool a process takes its turns from: SCRATCHBOX_MODEL_POOL_URL and SCRATCHBOX_MODEL_POOL_DISTRICT, else none. */
export function modelPoolFromEnv(env: NodeJS.ProcessEnv = process.env): { url: string; district: string } | undefined {
    const url = env.SCRATCHBOX_MODEL_POOL_URL?.trim().replace(/\/+$/, ''), district = env.SCRATCHBOX_MODEL_POOL_DISTRICT?.trim();
    return url && /^https?:\/\//.test(url) && district && name(district) ? { url, district } : undefined;
}

/** An ID token for a Cloud Run service at `url` (the app's service account), refreshed by the auth library as it expires. */
export function cloudRunIdTokenHeaders(url: string): () => Promise<Record<string, string>> {
    if (url.startsWith('http://')) return async () => ({});
    let client: { getRequestHeaders(): Promise<unknown> } | undefined;
    return async () => {
        if (!client) {
            const { GoogleAuth } = await import('google-auth-library');
            client = await new GoogleAuth().getIdTokenClient(new URL(url).origin) as unknown as { getRequestHeaders(): Promise<unknown> };
        }
        const h = await client.getRequestHeaders() as { get?: (k: string) => string | null; Authorization?: string; authorization?: string };
        const authorization = typeof h.get === 'function' ? h.get('authorization') ?? '' : h.Authorization ?? h.authorization ?? '';
        const out: Record<string, string> = {};
        if (authorization) out.authorization = authorization;
        return out;
    };
}
