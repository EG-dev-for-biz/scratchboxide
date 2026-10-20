/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * How much slower CPU-bound work ran while a timed section ran.
 *
 * The full suite runs dozens of vitest forks, each spawning ffmpeg and worker threads, so a timing bound
 * calibrated on an idle machine fails under that load even though the code under test does nothing more.
 * This probe is a child process that spins for the length of the section and reports the share of a core
 * it got (its own CPU time over its wall time). A thread that only sleeps and wakes on a timer would not
 * see the contention (it is scheduled promptly), so the probe must be busy; it is one more runnable
 * process, which is a small addition to the load it measures.
 *
 * It measures the machine, not the code: the main thread's own blocking or pixel work does not reach the
 * child, so a bound scaled by the probe still fails on a missing yield or an in-thread pixel loop.
 *
 *   const probe = startLoadProbe();
 *   ... the timed section ...
 *   const { slowdown } = await probe.stop();
 *   expect(blockMs).toBeLessThan(60 * slowdown);  // 60 ms on an idle machine
 */

import { spawn, type ChildProcess } from 'child_process';

export interface LoadSample {
    /** Length of the window (ms). */
    windowMs: number;
    /** CPU time the busy child got in the window (ms). */
    cpuMs: number;
    /** windowMs / cpuMs: how much longer CPU-bound work takes at the share of a core this process gets (>= 1). */
    slowdown: number;
}

// A child that spins until its stdin closes (the parent stopped it, or died) and then reports its CPU share.
const PROBE = `
const t0 = performance.now(), c0 = process.cpuUsage();
let x = 0;
const report = () => {
    const c = process.cpuUsage(c0);
    process.stdout.write(JSON.stringify({ windowMs: performance.now() - t0, cpuMs: (c.user + c.system) / 1000 }), () => process.exit(0));
};
process.stdin.on('data', report);
process.stdin.on('end', report);
process.stdin.on('close', report);
process.stdin.resume();
setTimeout(() => process.exit(0), 10 * 60 * 1000).unref();
const spin = () => { for (let i = 0; i < 2e6; i++) x += i; setImmediate(spin); };
spin();
`;

export interface LoadProbe {
    stop(): Promise<LoadSample>;
}

/** Starts the busy child; `stop` ends it and returns what it saw. The child exits on its own if this process dies. */
export function startLoadProbe(): LoadProbe {
    const child: ChildProcess = spawn(process.execPath, ['-e', PROBE], { stdio: ['pipe', 'pipe', 'ignore'] });
    child.unref();
    child.stdin!.on('error', () => undefined);
    let out = '';
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (d: string) => { out += d; });
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    const failed = new Promise<never>((_, reject) => child.once('error', reject));
    return {
        async stop() {
            child.stdin!.write('stop');
            child.stdin!.end();
            await Promise.race([exited, failed]);
            const s = JSON.parse(out) as Omit<LoadSample, 'slowdown'>;
            return { ...s, slowdown: Math.max(1, s.windowMs / Math.max(1, s.cpuMs)) };
        }
    };
}
