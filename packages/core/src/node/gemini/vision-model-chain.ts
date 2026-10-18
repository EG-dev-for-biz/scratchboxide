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
 * With a `replyCache`, a call whose request (contents, config, stage, thinking budget, candidates) was answered before
 * returns that recorded answer without a model call (`cached: true`, the attempt marked cached). A reply is recorded
 * only when the caller says it was usable (`remember()`), so a cut-off or invalid reply is never replayed.
 */

import * as crypto from 'crypto';
import type { GenerateContentParameters, GenerateContentResponse } from '@google/genai';
import { classifyMediaGenerationError } from '../../common/media-generation-protocol';
import { isModelNotFoundError } from './gemini-client';
import { describeThinking, thinkingConfigFor, type GeminiThinkingConfig } from './thinking-config';

/** Backoff retries for 429 / 5xx answers, always on the same model. */
export const VISION_TRANSIENT_RETRIES = 2;

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
    outcome: 'answered' | 'not_found' | 'retried' | 'failed' | 'stopped';
    error?: string;
    httpStatus?: number;
    code?: string;
    /** The answer was the recorded reply of an identical earlier request (no model call was made). */
    cached?: boolean;
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
            if (inline) h.update('\0i').update(inline.mimeType ?? '').update('\0').update(inline.data ?? '');
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

    constructor(private readonly options: VisionModelChainOptions<Stage>) {
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

    /** One call on exactly `model`, retrying only 429 / 5xx answers with backoff. */
    private async callOne(model: string, params: Omit<GenerateContentParameters, 'model'>, opts: VisionCallOptions<Stage>): Promise<VisionCallResult> {
        const signal = this.options.signal;
        const thinking = opts.thinkingBudget !== undefined ? thinkingConfigFor(model, opts.thinkingBudget) : undefined;
        const config = { ...(params.config ?? {}), ...(thinking ? { thinkingConfig: thinking } : {}) };
        const full: GenerateContentParameters = { ...params, model, config } as GenerateContentParameters;
        for (let retry = 0; ; retry++) {
            if (signal?.aborted) throw this.aborted(opts.stage);
            const started = this.now();
            let ttftMs: number | undefined;
            try {
                const stream = opts.stream ? this.options.client.models.generateContentStream : undefined;
                const callSignal = (params.config as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
                const work = stream
                    ? (async () => joinStream(await stream.call(this.options.client.models, full), () => {
                        ttftMs = this.now() - started;
                        opts.onFirstToken?.(ttftMs);
                    }, opts.onChunk))()
                    : this.options.client.models.generateContent(full);
                const response = await raceAbort(work, [callSignal, signal]);
                const ms = this.now() - started;
                const attempt: VisionAttempt = { model, ...(thinking ? { thinking: describeThinking(thinking) } : {}), ms, ...(ttftMs !== undefined ? { ttftMs } : {}), outcome: 'answered' };
                this.attempts.push(attempt);
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
                // the call's own abort signal (a per-call time limit) ended it: asking again would only end the same way
                const callAborted = (params.config as { abortSignal?: AbortSignal } | undefined)?.abortSignal?.aborted === true;
                const retryable = !notFound && !callAborted && (classified.code === 'transient' || classified.code === 'quota');
                const record: VisionAttempt = {
                    model, ...(thinking ? { thinking: describeThinking(thinking) } : {}), ms, error: classified.message,
                    ...(classified.status !== undefined ? { httpStatus: classified.status } : {}), code: classified.code,
                    outcome: notFound ? 'not_found' : retryable && retry < VISION_TRANSIENT_RETRIES ? 'retried' : 'failed'
                };
                this.attempts.push(record);
                if (record.outcome === 'retried') {
                    await this.sleep(1000 * 2 ** retry);
                    continue;
                }
                throw this.makeError(opts.stage,
                    `${model} failed (${classified.code}${classified.status ? ` ${classified.status}` : ''}): ${classified.message}`,
                    { model, code: classified.code, httpStatus: classified.status, modelNotFound: notFound });
            }
        }
    }

    /**
     * One call. The first call walks the candidates (only "not found" moves on); later calls use the model that
     * answered. Throws the factory's error: the last model's failure, or "none is served" when every one was not found.
     */
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

    async generate(params: Omit<GenerateContentParameters, 'model'>, opts: VisionCallOptions<Stage>): Promise<VisionCallResult> {
        this.asked = true;
        const replayed = this.replay(params, opts);
        if (replayed) return replayed;
        if (this.model) return this.callOne(this.model, params, opts);
        const candidates = this.options.candidates;
        for (let i = this.skipped.length; i < candidates.length; i++) {
            const model = candidates[i];
            try {
                const result = await this.callOne(model, params, opts);
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
