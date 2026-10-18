/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A time limit on a call to an outside service (a vision model, an image fetch), started when the request is sent.
 *
 * A plain setTimeout cannot tell a slow service from a busy thread: when this thread was held past the limit by CPU work,
 * the expired timer runs first in the next loop turn, before the reply that came in meanwhile is read, and cuts a call
 * whose answer is already waiting. This timer, when it fires late, extends the limit by how late it fired (the time the
 * thread could not read anything) so the waiting reply is read first; the extensions add up to at most the limit itself.
 * A call that is really slow still ends, at most one limit later.
 */

/** Lateness below this is ordinary timer jitter, not a blocked thread. */
export const CALL_TIMER_LATE_MS = 250;

export interface CallTimer {
    clear(): void;
    /** How long the limit was extended for this thread's blocks so far, ms. */
    readonly extendedMs: number;
}

export function callTimeout(onTimeout: () => void, ms: number, now: () => number = () => performance.now()): CallTimer {
    let due = now() + ms;
    let extended = 0;
    let cleared = false;
    let handle: ReturnType<typeof setTimeout>;
    const fire = () => {
        if (cleared) return;
        const late = now() - due;
        if (late > CALL_TIMER_LATE_MS && extended < ms) {
            const add = Math.min(late, ms - extended);
            extended += add;
            due = now() + add;
            handle = setTimeout(fire, add);
            return;
        }
        cleared = true;
        onTimeout();
    };
    handle = setTimeout(fire, ms);
    return {
        clear: () => { cleared = true; clearTimeout(handle); },
        get extendedMs() { return extended; }
    };
}
