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
 */

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
}

export interface VisionCallResult {
    response: GenerateContentResponse;
    model: string;
    ms: number;
    ttftMs?: number;
    thinking?: GeminiThinkingConfig;
}

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Joins streamed chunks into one response: text parts concatenated, the last chunk's metadata kept. */
async function joinStream(stream: AsyncIterable<GenerateContentResponse>, onFirst: () => void): Promise<GenerateContentResponse> {
    let text = '';
    let last: GenerateContentResponse | undefined;
    let first = true;
    for await (const chunk of stream) {
        if (first) { first = false; onFirst(); }
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
                const response = stream
                    ? await joinStream(await stream.call(this.options.client.models, full), () => {
                        ttftMs = this.now() - started;
                        opts.onFirstToken?.(ttftMs);
                    })
                    : await this.options.client.models.generateContent(full);
                const ms = this.now() - started;
                this.attempts.push({ model, ...(thinking ? { thinking: describeThinking(thinking) } : {}), ms, ...(ttftMs !== undefined ? { ttftMs } : {}), outcome: 'answered' });
                return { response, model, ms, ...(ttftMs !== undefined ? { ttftMs } : {}), ...(thinking ? { thinking } : {}) };
            } catch (err) {
                const ms = this.now() - started;
                // A stop aborts the request in flight: report the stop, not a model failure.
                if (signal?.aborted) {
                    this.attempts.push({ model, ...(thinking ? { thinking: describeThinking(thinking) } : {}), ms, outcome: 'stopped' });
                    throw this.aborted(opts.stage);
                }
                const classified = classifyMediaGenerationError(err, model);
                const notFound = isModelNotFoundError(err);
                const retryable = !notFound && (classified.code === 'transient' || classified.code === 'quota');
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
    async generate(params: Omit<GenerateContentParameters, 'model'>, opts: VisionCallOptions<Stage>): Promise<VisionCallResult> {
        this.asked = true;
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
                this.skipped.push({ model, reason: (err as Error).message });
            }
        }
        throw this.makeError(opts.stage,
            `None of the chat's models is served: ${this.skipped.map(s => `${s.model} (${s.reason})`).join('; ')}`,
            { skipped: [...this.skipped] });
    }
}
