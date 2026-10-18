/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Time slicing for CPU work the staged run does on the main thread while vision calls are in flight: a loop calls
 * `due()` between its independent items and awaits it; once the slice has run `sliceMs` the loop yields to the event
 * loop (setImmediate), so a streamed reply or a call timer is served between items instead of after the whole loop.
 * The work and its results are unchanged; only where the thread pauses is.
 */
export const TIME_SLICE_MS = 8;

export interface TimeSlicer {
    /** Resolves at once while the slice has time left; otherwise after one turn of the event loop. */
    due(): Promise<void> | undefined;
    /** How many times the work yielded. */
    readonly yields: number;
}

export function timeSlicer(sliceMs = TIME_SLICE_MS, now: () => number = () => performance.now()): TimeSlicer {
    let start = now();
    let yields = 0;
    return {
        due() {
            if (now() - start < sliceMs) return undefined;
            yields++;
            return new Promise<void>(resolve => setImmediate(() => { start = now(); resolve(); }));
        },
        get yields() { return yields; }
    };
}
