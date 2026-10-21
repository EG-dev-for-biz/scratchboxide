/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A visible fallback chain for vision calls (the object builder's spec reads and comparisons, the staged build's
 * facade-detail reading).
 *
 * - Its first call walks the candidate models in order. Only a "model not found" answer moves on to the next one, and
 *   every model passed over is recorded with why (`skipped`). After a model answers, every later call uses it only.
 * - A transient answer (429 / 5xx, network) retries the same model after 1 s, then 2 s; another model never stands in
 *   for a transient failure.
 * - A call may ask for a thinking budget. The thinking config is computed for the model actually called, at the time
 *   of the call (thinkingConfigFor): a fallback can change the model family (a level on Gemini 4, a budget on 3.x).
 * - Every attempt is recorded (model, thinking, time, time to first token when streamed, outcome, error), so a failure
 *   can still name the model and thinking level that were tried.
 *
 * Errors are made by the caller's factory, so the object builder keeps its own typed errors and messages.
 *
 * Hedging and deadlines (the long tail of slow answers, VISION_CALL_POLICY):
 * - A call that is not streamed and asks to be hedged (`hedge`) is sent once more, the same request, when it has had no
 *   answer for an adaptive threshold: a quantile of the latencies the same call kind (its stage) answered in lately in
 *   this process, clamped to a floor and a ceiling. The first valid answer is taken and the other request aborted.
 * - After a 429, no hedge goes to that model for a pause that doubles with each 429 in a row (VISION_RATE_LIMIT_PAUSE_MS),
 *   a 429 is retried after 2 s then 4 s, and at most VISION_HEDGE_MAX_IN_FLIGHT duplicates are out at once.
 * - A call may carry a deadline (`deadlineMs`, retries and hedges included): with no answer by then it fails with a
 *   typed deadline error (details.deadline), never a made-up answer, and the caller degrades the way it already can.
 * - SCRATCHBOX_VISION_HEDGE=0 turns hedging of unstreamed calls off (deadlines stay).
 *
 * With a `replyCache`, a call whose request (contents, config, stage, thinking budget, candidates) was answered before
 * returns that recorded answer without a model call (`cached: true`, the attempt marked cached). A reply is recorded
 * only when the caller says it was usable (`remember()`), so a cut-off or invalid reply is never replayed.
 */

import * as crypto from 'crypto';
import type { GenerateContentParameters, GenerateContentResponse } from '@google/genai';
import { classifyMediaGenerationError } from '../../common/media-generation-protocol';
import { imageContentSha256 } from '../image-codec-ffmpeg';
import { isModelNotFoundError } from './gemini-client';
import { describeThinking, thinkingConfigFor, type GeminiThinkingConfig } from './thinking-config';

/** Backoff retries for 429 / 5xx answers, always on the same model. */
export const VISION_TRANSIENT_RETRIES = 2;

/**
 * Hedging of a call that is not streamed: the duplicate goes out when the call has had no answer for the `quantile` of
 * its kind's recent answered latencies, clamped to [floorMs, ceilingMs]; `initialMs` until the kind has
 * VISION_HEDGE_MIN_SAMPLES of them in this process.
 */
export interface VisionHedgePolicy {
    quantile: number;
    floorMs: number;
    ceilingMs: number;
    initialMs: number;
}

/** What a call kind (its stage name) is given: how it is hedged, and the time after which it fails as unanswered. */
export interface VisionCallPolicy {
    hedge?: VisionHedgePolicy;
    deadlineMs?: number;
}

/**
 * The staged build's unstreamed call kinds. Chosen by replaying 394 grammar and 72 ownership latencies recorded on
 * gemini-4-argon (Vertex, October 2026; p50 8.5 / 18.0 s, p90 23.3 / 33.5 s, max 211 / 46 s): see
 * test/fixtures/vision-latency and docs/processes/vision_call_hedging.md. The initial thresholds are the recorded p75-p80.
 * - grammar: a facade whose whole reading has no answer by the deadline keeps the relief's own window lattice; a
 *   held-out reading without one is not scored (the held-out check's own quorum: two folds, 40% of the hidden facade).
 * - ownership: a view without an answer by the deadline casts no vote (and see OWNERSHIP_VOTE_RULE: the vote goes ahead
 *   without its slowest views once a quorum of outlines is in).
 * - locate-target: hedged only. A locator failure fails the texture pass's ownership step, which has no rung for a
 *   missing answer, so it gets no deadline here.
 */
export const VISION_CALL_POLICY = {
    grammar: { hedge: { quantile: 0.8, floorMs: 12_000, ceilingMs: 30_000, initialMs: 15_000 }, deadlineMs: 90_000 },
    ownership: { hedge: { quantile: 0.75, floorMs: 15_000, ceilingMs: 30_000, initialMs: 20_000 }, deadlineMs: 90_000 },
    'locate-target': { hedge: { quantile: 0.8, floorMs: 10_000, ceilingMs: 30_000, initialMs: 15_000 } }
} satisfies Record<string, VisionCallPolicy>;

/** Answered latencies a kind needs before its threshold is its own quantile, and how many recent ones are kept. */
export const VISION_HEDGE_MIN_SAMPLES = 8;
export const VISION_LATENCY_WINDOW = 64;
/** Duplicates out at once, across every chain in the process. */
export const VISION_HEDGE_MAX_IN_FLIGHT = 8;
/** No hedge goes to a model for this long after a 429, doubled for each further 429 in a row, up to the max. */
export const VISION_RATE_LIMIT_PAUSE_MS = 30_000;
export const VISION_RATE_LIMIT_PAUSE_MAX_MS = 300_000;

/** SCRATCHBOX_VISION_HEDGE=0 turns hedging of unstreamed calls off. */
export function visionHedgeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.SCRATCHBOX_VISION_HEDGE !== '0';
}

export interface VisionHedgeCounts { calls: number; fired: number; won: number; suppressed: number; deadlines: number }

/**
 * The process's view of the vision calls, shared by every chain: the recent answered latencies per call kind (the
 * adaptive thresholds), the 429 pauses per model, the duplicates in flight, and what hedging did per kind.
 */
export class VisionHedgeBook {
    private readonly latencies = new Map<string, number[]>();
    private readonly pause = new Map<string, { until: number; strikes: number }>();
    private readonly tally = new Map<string, VisionHedgeCounts>();
    inFlight = 0;

    constructor(private readonly now: () => number = Date.now) {}

    record(kind: string, ms: number): void {
        const v = this.latencies.get(kind) ?? [];
        v.push(ms);
        if (v.length > VISION_LATENCY_WINDOW) v.shift();
        this.latencies.set(kind, v);
    }

    /** When a call of this kind is hedged: the policy's quantile of the recent latencies, clamped; the initial value until enough are in. */
    threshold(kind: string, p: VisionHedgePolicy): number {
        const v = this.latencies.get(kind) ?? [];
        if (v.length < VISION_HEDGE_MIN_SAMPLES) return Math.min(p.ceilingMs, Math.max(p.floorMs, p.initialMs));
        const s = [...v].sort((a, b) => a - b);
        const q = s[Math.min(s.length - 1, Math.floor(p.quantile * s.length))];
        return Math.min(p.ceilingMs, Math.max(p.floorMs, q));
    }

    rateLimited(model: string): void {
        const at = this.now();
        const prev = this.pause.get(model);
        const strikes = prev && at < prev.until + VISION_RATE_LIMIT_PAUSE_MS ? prev.strikes + 1 : 1;
        this.pause.set(model, { until: at + Math.min(VISION_RATE_LIMIT_PAUSE_MAX_MS, VISION_RATE_LIMIT_PAUSE_MS * 2 ** (strikes - 1)), strikes });
    }

    /** Milliseconds left of the model's 429 pause (0: none). */
    pausedFor(model: string): number {
        const p = this.pause.get(model);
        return p ? Math.max(0, p.until - this.now()) : 0;
    }

    count(kind: string, field: keyof VisionHedgeCounts): void {
        const c = this.tally.get(kind) ?? { calls: 0, fired: 0, won: 0, suppressed: 0, deadlines: 0 };
        c[field]++;
        this.tally.set(kind, c);
    }

    counts(): Record<string, VisionHedgeCounts> {
        return Object.fromEntries([...this.tally.entries()].map(([k, v]) => [k, { ...v }]));
    }
}

/** The book every chain shares unless it is given its own (tests). */
export const visionHedgeBook = new VisionHedgeBook();

const quotaError = (code: string | undefined, status: number | undefined) => code === 'quota' || status === 429;

/** The part of a @google/genai client the chain calls. */
export interface VisionGenAIClient {
    models: {
        generateContent(params: GenerateContentParameters): Promise<GenerateContentResponse>;
        /** Used when a call asks to stream (to measure the time to first token); generateContent otherwise. */
        generateContentStream?(params: GenerateContentParameters): Promise<AsyncIterable<GenerateContentResponse>>;
    };
    /** Set on real clients: true for Vertex AI, false for an AI Studio API key. */
    readonly vertexai?: boolean;
}

export interface VisionAttempt {
    model: string;
    thinking?: { level: 'LOW' | 'MEDIUM' | 'HIGH' } | { budget: number };
    ms: number;
    ttftMs?: number;
    /** 'deadline': the call's deadline (VisionCallOptions.deadlineMs) ended it with no answer. */
    outcome: 'answered' | 'not_found' | 'retried' | 'failed' | 'stopped' | 'deadline';
    error?: string;
    httpStatus?: number;
    code?: string;
    /** The answer was the recorded reply of an identical earlier request (no model call was made). */
    cached?: boolean;
    /**
     * The request was sent once more: after a slow first token (streamed, hedgeAfterMs) or after `hedgeAtMs` with no
     * answer (not streamed, VisionCallOptions.hedge); `hedgeWon` says the second one answered.
     */
    hedged?: boolean;
    hedgeWon?: boolean;
    hedgeAtMs?: number;
}

/** A usable reply, recorded so an identical request gets it back without a model call. */
export interface VisionReplyRecord {
    schema: 'scratchbox.vision-reply/1';
    model: string;
    answeredVersion: string;
    /** The answer's non-thought text, its finish reason, usage and model version. */
    text: string;
    finishReason?: string;
    usageMetadata?: GenerateContentResponse['usageMetadata'];
    modelVersion?: string;
    attempt: VisionAttempt;
    skipped: Array<{ model: string; reason: string }>;
}

export interface VisionReplyCache {
    get(key: string): VisionReplyRecord | undefined;
    put(key: string, record: VisionReplyRecord): void;
}

/** sha256 of a request: every content part (image bytes included), the config without its abort signal, the stage, the thinking budget and the candidates. */
export function visionRequestKey(params: Omit<GenerateContentParameters, 'model'>, stage: string, thinkingBudget: number | undefined, candidates: string[]): string {
    const { abortSignal: _a, ...config } = (params.config ?? {}) as Record<string, unknown>;
    const h = crypto.createHash('sha256').update('vision-request/v1');
    h.update('\0').update(JSON.stringify({ stage, thinkingBudget: thinkingBudget ?? null, candidates, config }));
    const contents = Array.isArray(params.contents) ? params.contents : [params.contents];
    for (const c of contents as Array<{ role?: string; parts?: Array<Record<string, unknown>> } | string>) {
        if (typeof c === 'string') { h.update('\0t').update(c); continue; }
        h.update('\0r').update(c.role ?? '');
        for (const p of c.parts ?? []) {
            const inline = p.inlineData as { mimeType?: string; data?: string } | undefined;
            // an image by its content (a JPEG without its metadata segments): the same pixels re-sent with a freshly signed header are the same request
            if (inline) h.update('\0i').update(inline.mimeType ?? '').update('\0').update(imageContentSha256(Buffer.from(inline.data ?? '', 'base64')));
            else h.update('\0p').update(JSON.stringify(p));
        }
    }
    return h.digest('hex');
}

export interface VisionErrorDetails {
    model?: string;
    code?: string;
    httpStatus?: number;
    modelNotFound?: boolean;
    aborted?: boolean;
    /** The call had no answer by its deadline (VisionCallOptions.deadlineMs). */
    deadline?: boolean;
    deadlineMs?: number;
    skipped?: Array<{ model: string; reason: string }>;
}

export interface VisionModelChainOptions<Stage extends string> {
    client: VisionGenAIClient;
    /** The models to try, in order (the requested one first). */
    candidates: string[];
    signal?: AbortSignal;
    sleep?: (ms: number) => Promise<void>;
    /** Builds the error a failed call throws (default: a VisionChainError). */
    makeError?: (stage: Stage, message: string, details: VisionErrorDetails) => Error;
    /** Time source (tests). */
    now?: () => number;
    /** Usable replies of identical earlier requests (see the header). */
    replyCache?: VisionReplyCache;
    /**
     * A streamed call whose first token has not come this long after it started is sent once more, the same request,
     * and the first of the two to answer is taken (the other is aborted): the model's time to first token has a long
     * tail (live: 7-9 s typical, 65-110 s at times). Off when undefined.
     */
    hedgeAfterMs?: number;
    /** The latencies, 429 pauses and hedge counts this chain shares (default: the process's visionHedgeBook). */
    hedgeBook?: VisionHedgeBook;
}

export class VisionChainError extends Error {
    constructor(readonly stage: string, message: string, readonly details: VisionErrorDetails) {
        super(message);
        this.name = 'VisionChainError';
    }
}

export interface VisionCallOptions<Stage extends string> {
    stage: Stage;
    /** Ask for this many thinking tokens (a level on Gemini 4: under 1,024 is LOW). Omitted: the model's default. */
    thinkingBudget?: number;
    /** Stream the answer, measuring the time to first token; the chunks are joined into one response. */
    stream?: boolean;
    /** Called once when the first streamed chunk arrives, with the time since the call started. */
    onFirstToken?: (ms: number) => void;
    /** Called on every streamed chunk (thought chunks too): a caller watching for a stalled stream re-arms its timer here. */
    onChunk?: () => void;
    /** Hedge this call when it is not streamed (VISION_CALL_POLICY): the duplicate goes out at the kind's adaptive threshold. */
    hedge?: VisionHedgePolicy;
    /** The call (retries and hedges included) fails with a deadline error when it has no answer this long after it started. */
    deadlineMs?: number;
    /** Whether an answer is usable (default: it has text). With a hedge out, an unusable answer waits for the other request. */
    valid?: (response: GenerateContentResponse) => boolean;
}

export interface VisionCallResult {
    response: GenerateContentResponse;
    model: string;
    ms: number;
    ttftMs?: number;
    thinking?: GeminiThinkingConfig;
    /** The recorded reply of an identical earlier request: no model call was made. */
    cached?: boolean;
    /** Records this reply as usable, so an identical request later gets it back (a no-op without a reply cache, or for a cached reply). */
    remember: () => void;
}

/**
 * Ends the wait when a signal fires even if the request underneath ignores it: a stream that stalls mid-answer would otherwise hold
 * the call (and the stage waiting on it) far past its time limit, because aborting the request does not always end the iteration.
 */
function raceAbort<T>(work: Promise<T>, signals: Array<AbortSignal | undefined>): Promise<T> {
    const live = signals.filter((s): s is AbortSignal => !!s);
    if (!live.length) return work;
    return new Promise<T>((resolve, reject) => {
        const onAbort = (s: AbortSignal) => () => reject(s.reason instanceof Error ? s.reason : Object.assign(new Error('the call was aborted'), { name: 'AbortError' }));
        const handlers = live.map(s => ({ s, h: onAbort(s) }));
        for (const { s, h } of handlers) { if (s.aborted) { h(); break; } s.addEventListener('abort', h, { once: true }); }
        work.then(resolve, reject).finally(() => { for (const { s, h } of handlers) s.removeEventListener('abort', h); });
    });
}

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** The default test of an answer: it has non-thought text. */
const hasText = (r: GenerateContentResponse) => (r.candidates?.[0]?.content?.parts ?? []).some(p => typeof p.text === 'string' && p.text.trim() !== '' && !(p as { thought?: boolean }).thought);

/** Joins streamed chunks into one response: text parts concatenated, the last chunk's metadata kept. */
async function joinStream(stream: AsyncIterable<GenerateContentResponse>, onFirst: () => void, onChunk?: () => void): Promise<GenerateContentResponse> {
    let text = '';
    let last: GenerateContentResponse | undefined;
    let first = true;
    for await (const chunk of stream) {
        if (first) { first = false; onFirst(); }
        onChunk?.();
        for (const p of chunk.candidates?.[0]?.content?.parts ?? []) {
            if (typeof p.text === 'string' && !(p as { thought?: boolean }).thought) text += p.text;
        }
        last = chunk;
    }
    const lastCandidate = last?.candidates?.[0];
    return {
        ...(last ?? {}),
        candidates: [{ ...(lastCandidate ?? {}), content: { role: 'model', parts: [{ text }] } }]
    } as GenerateContentResponse;
}

export class VisionModelChain<Stage extends string = string> {
    private model?: string;
    private answeredVersion?: string;
    private asked = false;
    readonly skipped: Array<{ model: string; reason: string }> = [];
    readonly attempts: VisionAttempt[] = [];
    private readonly sleep: (ms: number) => Promise<void>;
    private readonly now: () => number;
    private readonly makeError: (stage: Stage, message: string, details: VisionErrorDetails) => Error;
    private readonly book: VisionHedgeBook;

    constructor(private readonly options: VisionModelChainOptions<Stage>) {
        this.book = options.hedgeBook ?? visionHedgeBook;
        if (options.candidates.length === 0) throw new VisionChainError('setup', 'No vision model to call.', {});
        this.sleep = options.sleep ?? defaultSleep;
        this.now = options.now ?? Date.now;
        this.makeError = options.makeError ?? ((stage, message, details) => new VisionChainError(stage, message, details));
    }

    /** The model the next call goes to: the one that answered, else the next candidate not yet passed over. */
    get current(): string {
        return this.model ?? this.options.candidates[Math.min(this.skipped.length, this.options.candidates.length - 1)];
    }

    get requested(): string {
        return this.options.candidates[0];
    }

    /** The model that answered (undefined until one has). */
    get answeredModel(): string | undefined {
        return this.model;
    }

    /** The version the API reported for the first answer. */
    get answered(): string | undefined {
        return this.answeredVersion;
    }

    /** True once any model was asked. */
    get wasAsked(): boolean {
        return this.asked;
    }

    get backend(): 'vertex' | 'api-key' | 'injected' {
        return this.options.client.vertexai === true ? 'vertex' : this.options.client.vertexai === false ? 'api-key' : 'injected';
    }

    /** The thinking a call with `budget` would ask the current model for, as a VisionModelUse records it. */
    thinkingFor(budget: number): { level: 'LOW' | 'MEDIUM' | 'HIGH' } | { budget: number } {
        return describeThinking(thinkingConfigFor(this.current, budget));
    }

    private aborted(stage: Stage): Error {
        return this.makeError(stage, 'Stopped by the user.', { aborted: true });
    }

    /** One call on exactly `model`, retrying only 429 / 5xx answers with backoff (a 429 waits longer and pauses hedging). */
    private async callOne(model: string, params: Omit<GenerateContentParameters, 'model'>, opts: VisionCallOptions<Stage>, deadline?: AbortSignal): Promise<VisionCallResult> {
        const signal = this.options.signal;
        const thinking = opts.thinkingBudget !== undefined ? thinkingConfigFor(model, opts.thinkingBudget) : undefined;
        const config = { ...(params.config ?? {}), ...(thinking ? { thinkingConfig: thinking } : {}) };
        const full: GenerateContentParameters = { ...params, model, config } as GenerateContentParameters;
        const callSignal = (params.config as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
        for (let retry = 0; ; retry++) {
            if (signal?.aborted) throw this.aborted(opts.stage);
            const started = this.now();
            let ttftMs: number | undefined;
            const hedge: { sent: boolean; won: boolean; atMs?: number } = { sent: false, won: false };
            try {
                // the call's own signal (its time limit or deadline) fired while it waited to retry: asking again would only end the same way
                if (callSignal?.aborted) throw callSignal.reason ?? Object.assign(new Error('the call was aborted'), { name: 'AbortError' });
                const stream = opts.stream ? this.options.client.models.generateContentStream : undefined;
                const work = stream
                    ? this.streamHedged(stream, full, callSignal, () => {
                        if (ttftMs !== undefined) return;
                        ttftMs = this.now() - started;
                        opts.onFirstToken?.(ttftMs);
                    }, opts.onChunk, hedge)
                    : this.unaryHedged(full, callSignal, opts, hedge);
                const response = await raceAbort(work, [callSignal, signal]);
                const ms = this.now() - started;
                const attempt: VisionAttempt = {
                    model, ...(thinking ? { thinking: describeThinking(thinking) } : {}), ms, ...(ttftMs !== undefined ? { ttftMs } : {}), outcome: 'answered',
                    ...(hedge.sent ? { hedged: true, hedgeWon: hedge.won, ...(hedge.atMs !== undefined ? { hedgeAtMs: hedge.atMs } : {}) } : {})
                };
                this.attempts.push(attempt);
                console.log(`[vision-call] ${opts.stage} ${model} answered in ${ms} ms${ttftMs !== undefined ? ` (first token ${ttftMs} ms)` : ''}${hedge.sent ? ` hedged${hedge.atMs !== undefined ? ` at ${hedge.atMs} ms` : ''} (${hedge.won ? 'the duplicate won' : 'the first request won'})` : ''}`);
                return { response, model, ms, ...(ttftMs !== undefined ? { ttftMs } : {}), ...(thinking ? { thinking } : {}), remember: () => this.record(params, opts, model, response, attempt) };
            } catch (err) {
                const ms = this.now() - started;
                // A stop aborts the request in flight: report the stop, not a model failure.
                if (signal?.aborted) {
                    this.attempts.push({ model, ...(thinking ? { thinking: describeThinking(thinking) } : {}), ms, outcome: 'stopped' });
                    throw this.aborted(opts.stage);
                }
                const classified = classifyMediaGenerationError(err, model);
                const notFound = isModelNotFoundError(err);
                // the call's own abort signal (a per-call time limit or its deadline) ended it: asking again would only end the same way
                const callAborted = callSignal?.aborted === true;
                const quota = quotaError(classified.code, classified.status);
                if (quota && !callAborted) this.book.rateLimited(model);
                const retryable = !notFound && !callAborted && (classified.code === 'transient' || classified.code === 'quota');
                const record: VisionAttempt = {
                    model, ...(thinking ? { thinking: describeThinking(thinking) } : {}), ms, error: classified.message,
                    ...(classified.status !== undefined ? { httpStatus: classified.status } : {}), code: classified.code,
                    outcome: deadline?.aborted ? 'deadline' : notFound ? 'not_found' : retryable && retry < VISION_TRANSIENT_RETRIES ? 'retried' : 'failed',
                    ...(hedge.sent ? { hedged: true, hedgeWon: false, ...(hedge.atMs !== undefined ? { hedgeAtMs: hedge.atMs } : {}) } : {})
                };
                this.attempts.push(record);
                // a call its caller ended (its time limit, or a vote that went ahead without it) says so, not "transient"
                const why = deadline?.aborted ? 'its deadline' : callAborted ? `ended by its caller: ${callSignal?.reason instanceof Error ? callSignal.reason.message : 'aborted'}` : classified.code;
                console.log(`[vision-call] ${opts.stage} ${model} ${record.outcome} after ${ms} ms (${why})${hedge.sent ? ' hedged' : ''}`);
                if (record.outcome === 'retried') {
                    // a 429 backs off longer than a 5xx: 2 s then 4 s (and hedges to this model pause, VisionHedgeBook.rateLimited)
                    await this.sleep((quota ? 2000 : 1000) * 2 ** retry);
                    continue;
                }
                throw this.makeError(opts.stage,
                    `${model} failed (${classified.code}${classified.status ? ` ${classified.status}` : ''}): ${classified.message}`,
                    { model, code: classified.code, httpStatus: classified.status, modelNotFound: notFound });
            }
        }
    }

    /**
     * One request that is not streamed; with a hedge policy, the same request again when no answer came by the kind's
     * adaptive threshold, the first valid answer taken and the other aborted. Every answered request's own latency is
     * recorded for its kind. Rejects only when every request sent failed (with the first request's error when it failed).
     */
    private unaryHedged(full: GenerateContentParameters, callSignal: AbortSignal | undefined, opts: VisionCallOptions<Stage>, hedge: { sent: boolean; won: boolean; atMs?: number }): Promise<GenerateContentResponse> {
        const models = this.options.client.models;
        const book = this.book;
        const kind = opts.stage;
        const valid = opts.valid ?? hasText;
        const policy = opts.hedge && visionHedgeEnabled() ? opts.hedge : undefined;
        if (opts.hedge) book.count(kind, 'calls');
        type Req = { ctl: AbortController; t0: number; pending: boolean; second: boolean; error?: unknown };
        const send = (q: Req) => {
            const sig = callSignal ? AbortSignal.any([callSignal, q.ctl.signal]) : q.ctl.signal;
            return models.generateContent({ ...full, config: { ...(full.config ?? {}), abortSignal: sig } } as GenerateContentParameters);
        };
        if (!policy) {
            const t0 = this.now();
            return models.generateContent(full).then(r => { if (opts.hedge && valid(r)) book.record(kind, this.now() - t0); return r; });
        }
        const after = book.threshold(kind, policy);
        return new Promise<GenerateContentResponse>((resolve, reject) => {
            const reqs: Req[] = [];
            let settled = false;
            let held: GenerateContentResponse | undefined;
            const finish = (done: () => void) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                for (const q of reqs) if (q.pending) q.ctl.abort(Object.assign(new Error('the other request answered first'), { name: 'AbortError' }));
                done();
            };
            const whenAllDone = () => {
                if (settled || reqs.some(q => q.pending)) return;
                if (held) finish(() => resolve(held!));
                else finish(() => reject(reqs[0].error ?? reqs[1]?.error));
            };
            const go = (second: boolean) => {
                const q: Req = { ctl: new AbortController(), t0: this.now(), pending: true, second };
                reqs.push(q);
                if (second) book.inFlight++;
                send(q).then(r => {
                    q.pending = false;
                    if (second) book.inFlight--;
                    const ok = valid(r);
                    if (ok) book.record(kind, this.now() - q.t0);
                    if (ok && !settled) {
                        hedge.won = second;
                        if (second) book.count(kind, 'won');
                        finish(() => resolve(r));
                        return;
                    }
                    held ??= r;
                    whenAllDone();
                }, err => {
                    q.pending = false;
                    if (second) book.inFlight--;
                    q.error = err;
                    const c = classifyMediaGenerationError(err, full.model);
                    if (second && quotaError(c.code, c.status) && !callSignal?.aborted) book.rateLimited(full.model);
                    whenAllDone();
                });
            };
            const timer = setTimeout(() => {
                if (settled || callSignal?.aborted || !reqs[0].pending) return;
                if (book.pausedFor(full.model) > 0 || book.inFlight >= VISION_HEDGE_MAX_IN_FLIGHT) {
                    book.count(kind, 'suppressed');
                    console.log(`[vision-call] ${kind} ${full.model} not hedged at ${after} ms (${book.pausedFor(full.model) > 0 ? `429 pause, ${Math.round(book.pausedFor(full.model) / 1000)} s left` : `${book.inFlight} duplicates already out`})`);
                    return;
                }
                hedge.sent = true;
                hedge.atMs = after;
                book.count(kind, 'fired');
                go(true);
            }, after);
            go(false);
        });
    }

    /**
     * One streamed request; with hedgeAfterMs, the same request again when no token came in that time, the first full
     * answer taken and the other aborted. Rejects only when every request sent failed (with the first one's error).
     */
    private streamHedged(
        stream: NonNullable<VisionGenAIClient['models']['generateContentStream']>, full: GenerateContentParameters, callSignal: AbortSignal | undefined,
        onFirst: () => void, onChunk: (() => void) | undefined, hedge: { sent: boolean; won: boolean }
    ): Promise<GenerateContentResponse> {
        const send = (ctl: AbortController, flag: { first: boolean }) => {
            const sig = callSignal ? AbortSignal.any([callSignal, ctl.signal]) : ctl.signal;
            const req = { ...full, config: { ...(full.config ?? {}), abortSignal: sig } } as GenerateContentParameters;
            return (async () => joinStream(await stream.call(this.options.client.models, req), () => { flag.first = true; onFirst(); }, onChunk))();
        };
        const after = this.options.hedgeAfterMs;
        const a = { ctl: new AbortController(), flag: { first: false } };
        const first = send(a.ctl, a.flag);
        if (after === undefined || after <= 0) return first;
        return new Promise<GenerateContentResponse>((resolve, reject) => {
            let settled = false, failures = 0, firstError: unknown;
            const b = { ctl: new AbortController(), flag: { first: false } };
            const done = (err: unknown) => {
                failures++;
                if (firstError === undefined) firstError = err;
                if (!settled && failures >= (hedge.sent ? 2 : 1)) { settled = true; clearTimeout(timer); reject(firstError); }
            };
            const win = (r: GenerateContentResponse, second: boolean) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                hedge.won = second;
                (second ? a : b).ctl.abort(Object.assign(new Error('the other request answered first'), { name: 'AbortError' }));
                resolve(r);
            };
            const timer = setTimeout(() => {
                if (settled || a.flag.first || callSignal?.aborted) return;
                if (this.book.pausedFor(full.model) > 0) return;
                hedge.sent = true;
                send(b.ctl, b.flag).then(r => win(r, true), err => done(err));
            }, after);
            first.then(r => win(r, false), err => {
                // the first request failed before the hedge went out: no second chance here (the chain's retries decide)
                if (!hedge.sent) { clearTimeout(timer); if (!settled) { settled = true; reject(err); } return; }
                done(err);
            });
        });
    }

    /** The recorded reply for this request, replayed (the chain takes the model it came from when none has answered yet). */
    private replay(params: Omit<GenerateContentParameters, 'model'>, opts: VisionCallOptions<Stage>): VisionCallResult | undefined {
        const cache = this.options.replyCache;
        if (!cache) return undefined;
        let rec: VisionReplyRecord | undefined;
        try { rec = cache.get(visionRequestKey(params, opts.stage, opts.thinkingBudget, this.options.candidates)); } catch { rec = undefined; }
        if (!rec || (this.model && this.model !== rec.model)) return undefined;
        if (!this.model) {
            for (const s of rec.skipped) if (!this.skipped.some(x => x.model === s.model)) this.skipped.push(s);
            this.model = rec.model;
            this.answeredVersion = rec.answeredVersion;
        }
        this.attempts.push({ ...rec.attempt, cached: true });
        console.log(`[vision-call] ${opts.stage} ${rec.model} replayed from the reply cache`);
        const response = {
            candidates: [{ content: { role: 'model', parts: [{ text: rec.text }] }, ...(rec.finishReason ? { finishReason: rec.finishReason } : {}) }],
            ...(rec.usageMetadata ? { usageMetadata: rec.usageMetadata } : {}), ...(rec.modelVersion ? { modelVersion: rec.modelVersion } : {})
        } as GenerateContentResponse;
        const thinking = opts.thinkingBudget !== undefined ? thinkingConfigFor(rec.model, opts.thinkingBudget) : undefined;
        return { response, model: rec.model, ms: rec.attempt.ms, ...(rec.attempt.ttftMs !== undefined ? { ttftMs: rec.attempt.ttftMs } : {}), ...(thinking ? { thinking } : {}), cached: true, remember: () => undefined };
    }

    private record(params: Omit<GenerateContentParameters, 'model'>, opts: VisionCallOptions<Stage>, model: string, response: GenerateContentResponse, attempt: VisionAttempt): void {
        const cache = this.options.replyCache;
        if (!cache) return;
        const text = (response.candidates?.[0]?.content?.parts ?? []).filter(p => !(p as { thought?: boolean }).thought).map(p => p.text ?? '').join('');
        const finishReason = response.candidates?.[0]?.finishReason as string | undefined;
        try {
            cache.put(visionRequestKey(params, opts.stage, opts.thinkingBudget, this.options.candidates), {
                schema: 'scratchbox.vision-reply/1', model, answeredVersion: this.answeredVersion ?? response.modelVersion ?? model, text,
                ...(finishReason ? { finishReason } : {}), ...(response.usageMetadata ? { usageMetadata: response.usageMetadata } : {}), ...(response.modelVersion ? { modelVersion: response.modelVersion } : {}),
                attempt, skipped: [...this.skipped]
            });
        } catch { /* a reply that cannot be recorded is asked for again next time */ }
    }

    /**
     * One call. The first call walks the candidates (only "not found" moves on); later calls use the model that
     * answered. Throws the factory's error: the last model's failure, "none is served" when every one was not found, or
     * the deadline error (details.deadline) when `deadlineMs` passed with no answer.
     */
    async generate(params: Omit<GenerateContentParameters, 'model'>, opts: VisionCallOptions<Stage>): Promise<VisionCallResult> {
        this.asked = true;
        const replayed = this.replay(params, opts);
        if (replayed) return replayed;
        if (!(opts.deadlineMs && opts.deadlineMs > 0)) return this.walk(params, opts);
        const deadlineMs = opts.deadlineMs;
        const ctl = new AbortController();
        const message = `no answer within ${Math.round(deadlineMs / 1000)} s (the ${opts.stage} call's deadline)`;
        const timer = setTimeout(() => ctl.abort(Object.assign(new Error(message), { name: 'TimeoutError' })), deadlineMs);
        const own = (params.config as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
        const sig = own ? AbortSignal.any([own, ctl.signal]) : ctl.signal;
        try {
            return await this.walk({ ...params, config: { ...(params.config ?? {}), abortSignal: sig } }, opts, ctl.signal);
        } catch (err) {
            if (ctl.signal.aborted && !this.options.signal?.aborted && !own?.aborted) {
                this.book.count(opts.stage, 'deadlines');
                console.log(`[vision-call] ${opts.stage} ${this.current} ${message}`);
                throw this.makeError(opts.stage, message, { model: this.current, deadline: true, deadlineMs });
            }
            throw err;
        } finally {
            clearTimeout(timer);
        }
    }

    private async walk(params: Omit<GenerateContentParameters, 'model'>, opts: VisionCallOptions<Stage>, deadline?: AbortSignal): Promise<VisionCallResult> {
        if (this.model) return this.callOne(this.model, params, opts, deadline);
        const candidates = this.options.candidates;
        for (let i = this.skipped.length; i < candidates.length; i++) {
            const model = candidates[i];
            try {
                const result = await this.callOne(model, params, opts, deadline);
                this.model = model;
                this.answeredVersion = result.response.modelVersion || model;
                return result;
            } catch (err) {
                const details = (err as { details?: VisionErrorDetails }).details;
                if (details?.modelNotFound !== true) throw err;
                // calls made in parallel before any model answered each walk the candidates: a model is passed over once
                if (!this.skipped.some(s => s.model === model)) this.skipped.push({ model, reason: (err as Error).message });
            }
        }
        throw this.makeError(opts.stage,
            `None of the chat's models is served: ${this.skipped.map(s => `${s.model} (${s.reason})`).join('; ')}`,
            { skipped: [...this.skipped] });
    }
}
