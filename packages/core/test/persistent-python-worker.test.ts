/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The persistent Python worker pool against a real interpreter running the real worker_host.py. The target scripts
 * are small stand-ins (stdlib only) whose "model" is a module-level value that takes a measurable time to load, so
 * the tests can see that it loads once per worker, that workers run in parallel, and how timeouts, Stop, crashes
 * and idle shutdown end a worker.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    PersistentPythonWorkerPool,
    PythonWorkerError,
    getPythonWorkerPool,
    mapWithConcurrency,
    resolveWorkerHostScript,
    shutdownAllPythonWorkerPools
} from '../src/node/process/persistent-python-worker';

const PYTHON = process.env.SCRATCHBOX_PYTHON || 'python3';
const hasPython = spawnSync(PYTHON, ['-c', 'print(1)']).status === 0;
let DIR = '';
const pools: PersistentPythonWorkerPool[] = [];

function script(name: string, body: string): string {
    const p = path.join(DIR, name);
    fs.writeFileSync(p, body);
    return p;
}
function pool(scriptPath: string, extra: Partial<ConstructorParameters<typeof PersistentPythonWorkerPool>[0]> = {}): PersistentPythonWorkerPool {
    const p = new PersistentPythonWorkerPool({ pythonBinary: PYTHON, scriptPath, ...extra });
    pools.push(p);
    return p;
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** A script whose model takes LOAD_S seconds to load (once per process) and whose inference takes INFER_S seconds. */
const SLOW_MODEL = `
import json, os, sys, time
_MODEL = {}
def main():
    load_s, infer_s = float(sys.argv[1]), float(sys.argv[2])
    loaded_now = False
    if "m" not in _MODEL:
        time.sleep(load_s)
        _MODEL["m"] = os.getpid()
        loaded_now = True
    time.sleep(infer_s)
    print(json.dumps({"pid": _MODEL["m"], "loadedNow": loaded_now, "arg": sys.argv[3] if len(sys.argv) > 3 else None}))
`;

describe.skipIf(!hasPython)('PersistentPythonWorkerPool (real interpreter, real worker_host.py)', () => {
    beforeAll(() => { DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-pyworker-')); });
    afterAll(() => {
        for (const p of pools) p.shutdown();
        shutdownAllPythonWorkerPools();
        fs.rmSync(DIR, { recursive: true, force: true });
    });

    it('finds worker_host.py next to the sources', () => {
        expect(resolveWorkerHostScript()).toMatch(/packages\/core\/src\/python\/scratchbox\/worker_host\.py$/);
    });

    it('loads the model once: ten calls on one worker pay the load once', async () => {
        const p = pool(script('slow_model.py', SLOW_MODEL));
        const t0 = Date.now();
        const results = [];
        for (let i = 0; i < 10; i++) results.push(await p.run({ argv: ['0.8', '0.01', String(i)], timeoutMs: 20_000 }));
        const elapsed = Date.now() - t0;
        const answers = results.map(r => JSON.parse(r.stdout));
        expect(answers.filter(a => a.loadedNow)).toHaveLength(1);
        expect(new Set(answers.map(a => a.pid)).size).toBe(1);
        expect(answers.map(a => a.arg)).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']);
        expect(results.map(r => r.priorRequestsOnWorker)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
        expect(p.spawnCount).toBe(1);
        // One 0.8 s load plus ten 10 ms calls, far under the 8 s ten loads would take.
        expect(elapsed).toBeLessThan(4_000);
    });

    it('runs up to maxWorkers requests in parallel, each worker loading its own model once', async () => {
        const p = pool(script('slow_model_par.py', SLOW_MODEL), { maxWorkers: 3 });
        const t0 = Date.now();
        const results = await Promise.all(Array.from({ length: 9 }, (_, i) => p.run({ argv: ['0.3', '0.3', String(i)], timeoutMs: 20_000 })));
        const elapsed = Date.now() - t0;
        const answers = results.map(r => JSON.parse(r.stdout));
        expect(new Set(answers.map(a => a.pid)).size).toBe(3);
        expect(answers.filter(a => a.loadedNow)).toHaveLength(3);
        expect(p.spawnCount).toBe(3);
        // Serial would be 0.3 + 9 * 0.3 = 3.0 s; three lanes take about 0.3 + 3 * 0.3 = 1.2 s.
        expect(elapsed).toBeLessThan(2_600);
    });

    it('gives each request its argv, stdin text, cwd and exit code, and keeps stray fd-1 writes out of the protocol', async () => {
        const p = pool(script('echo.py', `
import json, os, sys
def main():
    os.write(1, b"native library noise on fd 1\\n")
    print("library chatter on stderr", file=sys.stderr)
    data = sys.stdin.read()
    print(json.dumps({"argv": sys.argv[1:], "stdin": data, "cwd": os.getcwd()}))
    if sys.argv[1:] == ["fail"]:
        sys.exit(4)
`));
        const cwd = fs.realpathSync(DIR);
        const ok = await p.run({ argv: ['a', 'b c'], stdin: '{"q": 1}', cwd, timeoutMs: 10_000 });
        expect(ok.exitCode).toBe(0);
        expect(JSON.parse(ok.stdout)).toEqual({ argv: ['a', 'b c'], stdin: '{"q": 1}', cwd });
        expect(ok.stderr).toContain('library chatter on stderr');
        const failed = await p.run({ argv: ['fail'], timeoutMs: 10_000 });
        expect(failed.exitCode).toBe(4);
        expect(JSON.parse(failed.stdout).argv).toEqual(['fail']);
        // The sys.exit ended the request, not the worker.
        expect(failed.workerPid).toBe(ok.workerPid);
        const noStdin = await p.run({ timeoutMs: 10_000 });
        expect(JSON.parse(noStdin.stdout).stdin).toBe('');
    });

    it('reports an uncaught exception as exit 1 with the traceback, and keeps serving', async () => {
        const p = pool(script('raises.py', `
import sys
def main():
    if sys.argv[1] == "boom":
        raise ValueError("model exploded")
    print("fine")
`));
        const bad = await p.run({ argv: ['boom'], timeoutMs: 10_000 });
        expect(bad.exitCode).toBe(1);
        expect(bad.stderr).toContain('ValueError: model exploded');
        const good = await p.run({ argv: ['ok'], timeoutMs: 10_000 });
        expect(good.stdout.trim()).toBe('fine');
        expect(good.workerPid).toBe(bad.workerPid);
    });

    it('a crash fails the request with the exit status and stderr tail; the next request gets a fresh worker', async () => {
        const p = pool(script('crashes.py', `
import os, sys
def main():
    if sys.argv[1] == "crash":
        os.write(2, b"segfault-ish: the native module died\\n")
        os._exit(7)
    print(os.getpid())
`));
        const first = await p.run({ argv: ['ok'], timeoutMs: 10_000 });
        const err = await p.run({ argv: ['crash'], timeoutMs: 10_000 }).catch(e => e);
        expect(err).toBeInstanceOf(PythonWorkerError);
        expect(err.kind).toBe('crash');
        expect(err.message).toMatch(/exited with code 7/);
        expect(err.message).toContain('the native module died');
        const after = await p.run({ argv: ['ok'], timeoutMs: 10_000 });
        expect(after.exitCode).toBe(0);
        expect(after.workerPid).not.toBe(first.workerPid);
        expect(p.spawnCount).toBe(2);
    });

    it('a timeout kills the stuck worker, and later requests run on a new one', async () => {
        const p = pool(script('hangs.py', `
import os, sys, time
def main():
    if sys.argv[1] == "hang":
        time.sleep(60)
    print(os.getpid())
`));
        const warm = await p.run({ argv: ['ok'], timeoutMs: 10_000 });
        const t0 = Date.now();
        const err = await p.run({ argv: ['hang'], timeoutMs: 400 }).catch(e => e);
        expect(err).toBeInstanceOf(PythonWorkerError);
        expect(err.kind).toBe('timeout');
        expect(Date.now() - t0).toBeLessThan(3_000);
        await sleep(200);
        expect(alive(warm.workerPid)).toBe(false);
        const next = await p.run({ argv: ['ok'], timeoutMs: 10_000 });
        expect(next.workerPid).not.toBe(warm.workerPid);
    });

    it('a Stop kills the worker running that request; a Stop of a queued request drops it without starting anything', async () => {
        const p = pool(script('stoppable.py', `
import os, sys, time
def main():
    time.sleep(float(sys.argv[1]))
    print(os.getpid())
`));
        const warm = await p.run({ argv: ['0'], timeoutMs: 10_000 });
        const inFlight = new AbortController();
        const queued = new AbortController();
        const running = p.run({ argv: ['30'], timeoutMs: 60_000, signal: inFlight.signal }).catch(e => e);
        const waiting = p.run({ argv: ['0'], timeoutMs: 60_000, signal: queued.signal }).catch(e => e);
        queued.abort();
        expect((await waiting).name).toBe('AbortError');
        await sleep(100);
        const t0 = Date.now();
        inFlight.abort();
        const err = await running;
        expect(err.name).toBe('AbortError');
        expect(Date.now() - t0).toBeLessThan(1_000);
        await sleep(200);
        expect(alive(warm.workerPid)).toBe(false);
        expect(p.spawnCount).toBe(1);
        const pre = new AbortController();
        pre.abort();
        await expect(p.run({ argv: ['0'], timeoutMs: 1000, signal: pre.signal })).rejects.toMatchObject({ name: 'AbortError' });
        expect(p.spawnCount).toBe(1);
    });

    it('an idle worker shuts down after idleShutdownMs and the next request starts one', async () => {
        const p = pool(script('idle.py', 'import os\ndef main():\n    print(os.getpid())\n'), { idleShutdownMs: 150 });
        const first = await p.run({ timeoutMs: 10_000 });
        expect(p.liveWorkerCount).toBe(1);
        const deadline = Date.now() + 5_000;
        while (alive(first.workerPid) && Date.now() < deadline) await sleep(50);
        expect(alive(first.workerPid)).toBe(false);
        expect(p.liveWorkerCount).toBe(0);
        const second = await p.run({ timeoutMs: 10_000 });
        expect(second.workerPid).not.toBe(first.workerPid);
    });

    it('a script that cannot be imported fails the request with the import error', async () => {
        const p = pool(script('broken_import.py', 'import no_such_module_for_scratchbox\ndef main():\n    pass\n'));
        const err = await p.run({ timeoutMs: 10_000 }).catch(e => e);
        expect(err).toBeInstanceOf(PythonWorkerError);
        expect(err.kind).toBe('startup');
        expect(err.message).toContain('no_such_module_for_scratchbox');
        const noMain = pool(script('no_main.py', 'X = 1\n'));
        await expect(noMain.run({ timeoutMs: 10_000 })).rejects.toThrow(/defines no main\(\)/);
    });

    it('an interpreter that cannot be started fails the request', async () => {
        const p = pool(script('fine.py', 'def main():\n    pass\n'), { pythonBinary: path.join(DIR, 'no_such_python') });
        const err = await p.run({ timeoutMs: 10_000 }).catch(e => e);
        expect(err).toBeInstanceOf(PythonWorkerError);
        expect(err.message).toMatch(/could not be started|ENOENT/);
    });

    it('a worker exits on its own when its parent goes away (stdin closes)', async () => {
        const host = resolveWorkerHostScript()!;
        const target = script('orphan.py', 'def main():\n    pass\n');
        const child = spawn(PYTHON, [host, target], { stdio: ['pipe', 'pipe', 'inherit'] });
        await new Promise<void>(resolve => child.stdout!.once('data', () => resolve())); // the ready line
        const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
        child.stdin!.end();
        expect(await exited).toBe(0);
    });

    it('shares one pool per interpreter + script and raises its worker limit on request', () => {
        const s = script('shared.py', 'def main():\n    pass\n');
        const a = getPythonWorkerPool({ pythonBinary: PYTHON, scriptPath: s, maxWorkers: 1 });
        const b = getPythonWorkerPool({ pythonBinary: PYTHON, scriptPath: s, maxWorkers: 3 });
        expect(b).toBe(a);
        const other = getPythonWorkerPool({ pythonBinary: PYTHON, scriptPath: s, env: { ...process.env, SBX_X: '1' } });
        expect(other).not.toBe(a);
    });

    it('mapWithConcurrency keeps input order and never runs more than the limit', async () => {
        let inFlight = 0;
        let peak = 0;
        const out = await mapWithConcurrency([5, 1, 4, 2, 3], 2, async (n, i) => {
            inFlight++; peak = Math.max(peak, inFlight);
            await sleep(n * 10);
            inFlight--;
            return `${i}:${n}`;
        });
        expect(out).toEqual(['0:5', '1:1', '2:4', '3:2', '4:3']);
        expect(peak).toBe(2);
        await expect(mapWithConcurrency([1, 2, 3], 2, async n => { if (n === 2) throw new Error('two'); return n; })).rejects.toThrow('two');
    });
});
