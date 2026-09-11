/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as React from 'react';
import { Endpoint } from '../endpoint';
import type {
    MediaGenerationError,
    MediaGenerationJob,
    StartMediaGenerationResponse
} from '../../../common/media-generation-protocol';

/**
 * Shared polling primitives for `/media/jobs/:id?workspaceRoot=` status checks.
 *
 * The pure pieces (`buildMediaJobStatusUrl`, `pollMediaJobOnce`, `startMediaJobPolling`) are
 * framework-agnostic and unit-testable with an injected `fetch`. Two hooks sit on top:
 *
 * - `useMediaJobPolling(options)` — declarative: poll while `jobId` is set and `enabled`.
 * - `useMediaJobPoller()`         — imperative: `startPolling(...)` from event handlers; every
 *                                   poller started through it is aborted when the component unmounts.
 */

export type MediaJobPollOutcome =
    | { kind: 'completed'; job: MediaGenerationJob }
    | { kind: 'failed'; job: MediaGenerationJob; error?: MediaGenerationError }
    | { kind: 'pending'; job?: MediaGenerationJob }
    | { kind: 'error'; error: Error };

export interface PollMediaJobOnceOptions {
    jobId: string;
    workspaceRoot: string;
    /** Base REST URL, e.g. `/gemini`. Resolved via `resolveMediaBaseUrl()` when omitted. */
    baseUrl?: string;
    signal?: AbortSignal;
}

export interface StartMediaJobPollingOptions extends PollMediaJobOnceOptions {
    intervalMs?: number;
    fetchImpl?: typeof fetch;
    onComplete: (job: MediaGenerationJob) => void;
    onError: (error: Error, job?: MediaGenerationJob) => void;
}

export interface UseMediaJobPollingOptions {
    jobId?: string | null;
    workspaceRoot: string;
    enabled?: boolean;
    intervalMs?: number;
    onComplete: (job: MediaGenerationJob) => void;
    onError: (error: Error, job?: MediaGenerationJob) => void;
}

export interface MediaJobPollerHandle {
    /** Starts polling a job; returns a stop function. All active pollers stop on unmount. */
    startPolling: (options: Omit<StartMediaJobPollingOptions, 'signal'>) => () => void;
    /** Stops every poller started from this component. */
    stopAll: () => void;
}

export const DEFAULT_MEDIA_JOB_POLL_INTERVAL_MS = 1000;

export function resolveMediaBaseUrl(): string {
    try {
        const url = new Endpoint({ path: 'gemini' }).getRestUrl().toString();
        return url.endsWith('/') ? url.slice(0, -1) : url;
    } catch {
        return '/gemini';
    }
}

export function buildMediaJobStatusUrl(baseUrl: string, jobId: string, workspaceRoot: string): string {
    const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
    return `${base}/media/jobs/${encodeURIComponent(jobId)}?workspaceRoot=${encodeURIComponent(workspaceRoot)}`;
}

/**
 * One polling step. Never throws: network / HTTP / shape problems become `{ kind: 'error' }`.
 * A `completed` job without an asset URI is reported as `pending` so callers keep waiting for
 * the download step to land (matches the original inline polling semantics).
 */
export async function pollMediaJobOnce(
    fetchImpl: typeof fetch,
    options: PollMediaJobOnceOptions
): Promise<MediaJobPollOutcome> {
    const baseUrl = options.baseUrl ?? resolveMediaBaseUrl();
    const url = buildMediaJobStatusUrl(baseUrl, options.jobId, options.workspaceRoot);
    try {
        const response = await fetchImpl(url, {
            headers: { Accept: 'application/json' },
            signal: options.signal
        });
        const body = (await response.json().catch(() => undefined)) as StartMediaGenerationResponse | undefined;
        if (!response.ok && !body?.error) {
            return { kind: 'error', error: new Error(`Media service request failed (${response.status})`) };
        }
        if (!body?.success || !body.job) {
            return { kind: 'error', error: new Error(body?.error?.message || 'Media generation job not found') };
        }
        const job = body.job;
        if (job.status === 'completed') {
            return job.result?.asset?.uri ? { kind: 'completed', job } : { kind: 'pending', job };
        }
        if (job.status === 'failed' || job.status === 'cancelled') {
            return { kind: 'failed', job, error: job.error };
        }
        return { kind: 'pending', job };
    } catch (err: any) {
        return { kind: 'error', error: err instanceof Error ? err : new Error(String(err)) };
    }
}

/**
 * Polls a media job until it completes or fails. Returns a `stop()` function that aborts any
 * in-flight request, clears the timer and guarantees no callback fires afterwards.
 */
export function startMediaJobPolling(options: StartMediaJobPollingOptions): () => void {
    const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    const intervalMs = options.intervalMs ?? DEFAULT_MEDIA_JOB_POLL_INTERVAL_MS;
    const baseUrl = options.baseUrl ?? resolveMediaBaseUrl();
    const controller = new AbortController();
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;

    const stop = () => {
        if (cancelled) return;
        cancelled = true;
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        controller.abort();
    };

    const tick = async () => {
        if (cancelled || inFlight) return;
        inFlight = true;
        const outcome = await pollMediaJobOnce(fetchImpl, {
            jobId: options.jobId,
            workspaceRoot: options.workspaceRoot,
            baseUrl,
            signal: controller.signal
        });
        inFlight = false;
        if (cancelled) return;

        if (outcome.kind === 'completed') {
            stop();
            options.onComplete(outcome.job);
        } else if (outcome.kind === 'failed') {
            stop();
            options.onError(new Error(outcome.error?.message || 'Media generation failed'), outcome.job);
        } else if (outcome.kind === 'error') {
            stop();
            options.onError(outcome.error);
        } else {
            timer = setTimeout(tick, intervalMs);
        }
    };

    timer = setTimeout(tick, intervalMs);
    return stop;
}

/**
 * Declarative hook: polls `jobId` while `enabled` and the component is mounted.
 * Callbacks are read through refs so the poller is not restarted when they change identity.
 */
export function useMediaJobPolling(options: UseMediaJobPollingOptions): void {
    const { jobId, workspaceRoot, enabled = true, intervalMs } = options;
    const onCompleteRef = React.useRef(options.onComplete);
    const onErrorRef = React.useRef(options.onError);
    onCompleteRef.current = options.onComplete;
    onErrorRef.current = options.onError;

    React.useEffect(() => {
        if (!enabled || !jobId) return;
        const stop = startMediaJobPolling({
            jobId,
            workspaceRoot,
            intervalMs,
            onComplete: (job) => onCompleteRef.current(job),
            onError: (err, job) => onErrorRef.current(err, job)
        });
        return stop;
    }, [jobId, workspaceRoot, enabled, intervalMs]);
}

/**
 * Imperative hook for callback-driven flows (e.g. "Generate" button handlers that start a job
 * and then need to watch it). Every poller is torn down on unmount so no state updates leak.
 */
export function useMediaJobPoller(): MediaJobPollerHandle {
    const activeStopsRef = React.useRef<Set<() => void>>(new Set());

    const stopAll = React.useCallback(() => {
        for (const stop of activeStopsRef.current) stop();
        activeStopsRef.current.clear();
    }, []);

    const startPolling = React.useCallback((opts: Omit<StartMediaJobPollingOptions, 'signal'>) => {
        let stopSelf: () => void = () => undefined;
        const wrappedStop = () => {
            activeStopsRef.current.delete(wrappedStop);
            stopSelf();
        };
        stopSelf = startMediaJobPolling({
            ...opts,
            onComplete: (job) => {
                activeStopsRef.current.delete(wrappedStop);
                opts.onComplete(job);
            },
            onError: (err, job) => {
                activeStopsRef.current.delete(wrappedStop);
                opts.onError(err, job);
            }
        });
        activeStopsRef.current.add(wrappedStop);
        return wrappedStop;
    }, []);

    React.useEffect(() => stopAll, [stopAll]);

    return React.useMemo(() => ({ startPolling, stopAll }), [startPolling, stopAll]);
}
