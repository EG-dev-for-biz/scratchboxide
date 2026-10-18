/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { monitorEventLoopDelay, type IntervalHistogram } from 'perf_hooks';

/** A monitorEventLoopDelay histogram in milliseconds (nanoseconds in the histogram), rounded to 0.1 ms. */
export function eventLoopStats(h: IntervalHistogram): { eventLoopMeanMs: number; eventLoopP50Ms: number; eventLoopP99Ms: number; eventLoopMaxMs: number } {
    const ms = (ns: number) => (Number.isFinite(ns) ? Math.round(ns / 1e5) / 10 : 0);
    return { eventLoopMeanMs: ms(h.mean), eventLoopP50Ms: ms(h.percentile(50)), eventLoopP99Ms: ms(h.percentile(99)), eventLoopMaxMs: ms(h.max) };
}

export interface MainThreadBlock { atMs: number; ms: number; stages: string[] }

/**
 * Main-thread blocks over a whole run: a 50 ms timer (unref'd) that fires more than `minMs` late marks a block, with the
 * stages running then (`stages()`), and a delay histogram for the run. `stop()` ends both and returns what was seen.
 */
export function runBlockTracer(stages: () => string[], minMs = 500, now: () => number = () => performance.now()): { stop(): { blocks: MainThreadBlock[] } & ReturnType<typeof eventLoopStats> } {
    const h = monitorEventLoopDelay({ resolution: 10 });
    h.enable();
    const t0 = now();
    let last = t0;
    const blocks: MainThreadBlock[] = [];
    const timer = setInterval(() => {
        const n = now(), late = n - last - 50;
        if (late > minMs) blocks.push({ atMs: Math.round(last - t0), ms: Math.round(late), stages: stages() });
        last = n;
    }, 50);
    timer.unref?.();
    return {
        stop() {
            clearInterval(timer);
            h.disable();
            return { blocks, ...eventLoopStats(h) };
        }
    };
}
