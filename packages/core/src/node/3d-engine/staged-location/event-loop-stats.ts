/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import type { IntervalHistogram } from 'perf_hooks';

/** A monitorEventLoopDelay histogram in milliseconds (nanoseconds in the histogram), rounded to 0.1 ms. */
export function eventLoopStats(h: IntervalHistogram): { eventLoopMeanMs: number; eventLoopP50Ms: number; eventLoopP99Ms: number; eventLoopMaxMs: number } {
    const ms = (ns: number) => (Number.isFinite(ns) ? Math.round(ns / 1e5) / 10 : 0);
    return { eventLoopMeanMs: ms(h.mean), eventLoopP50Ms: ms(h.percentile(50)), eventLoopP99Ms: ms(h.percentile(99)), eventLoopMaxMs: ms(h.max) };
}
