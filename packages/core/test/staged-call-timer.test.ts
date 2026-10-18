/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/** The call time limit (call-timer.ts): a thread blocked past the limit reads the reply that came in before it cuts the call. */

import { spawn } from 'child_process';
import { describe, expect, it } from 'vitest';
import { callTimeout } from '../src/node/3d-engine/staged-location/call-timer';

const busy = (ms: number) => { const t = Date.now(); while (Date.now() - t < ms) { /* the thread is held */ } };

/** A reply that arrives `afterMs` after the call starts, on a pipe (real I/O), while this thread is held for `holdMs`. */
async function race(limitMs: number, afterMs: number, holdMs: number, plain: boolean): Promise<'reply' | 'timeout'> {
    return new Promise(resolve => {
        let settled = false;
        const settle = (v: 'reply' | 'timeout') => { if (!settled) { settled = true; resolve(v); } };
        const child = spawn(process.execPath, ['-e', `setTimeout(() => process.stdout.write('answer'), ${afterMs})`]);
        let timer: { clear(): void };
        child.stdout.once('data', () => { timer.clear(); settle('reply'); });
        child.once('spawn', () => {
            if (plain) { const h = setTimeout(() => settle('timeout'), limitMs); timer = { clear: () => clearTimeout(h) }; }
            else timer = callTimeout(() => settle('timeout'), limitMs);
            // the reply comes in while the thread is busy, past the limit (held from the check phase, as after an awaited
            // reply or a setImmediate: the loop's next turn runs the expired timers before it reads the pipe)
            setTimeout(() => setImmediate(() => busy(holdMs)), 10);
        });
    });
}

describe('call time limit', () => {
    it('a plain timer cuts a call whose reply came in while the thread was blocked; the call timer reads the reply', async () => {
        expect(await race(400, 150, 1_500, true)).toBe('timeout');
        expect(await race(400, 150, 1_500, false)).toBe('reply');
    }, 30_000);

    it('a call that is really slow still ends, at most one limit later', async () => {
        const t0 = performance.now();
        let fired = 0;
        await new Promise<void>(resolve => {
            const timer = callTimeout(() => { fired = performance.now() - t0; resolve(); }, 300);
            setTimeout(() => busy(600), 10);
            void timer;
        });
        expect(fired).toBeGreaterThan(600);
        expect(fired).toBeLessThan(300 + 300 + 600 + 200);
    });

    it('without a block it fires on time and clear stops it', async () => {
        const t0 = performance.now();
        const at = await new Promise<number>(resolve => { callTimeout(() => resolve(performance.now() - t0), 100); });
        expect(at).toBeGreaterThanOrEqual(95);
        expect(at).toBeLessThan(400);
        let hit = false;
        const t = callTimeout(() => { hit = true; }, 50);
        t.clear();
        await new Promise(r => setTimeout(r, 120));
        expect(hit).toBe(false);
        expect(t.extendedMs).toBe(0);
    });
});
