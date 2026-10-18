/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Persistent Python workers: one long-lived interpreter per worker slot serves many calls to the same sidecar
 * script, so the interpreter start and the model load are paid once instead of per frame or per call.
 *
 * Each worker runs `packages/core/src/python/scratchbox/worker_host.py <script>`, which imports the script once and
 * calls its `main()` per request with the request's argv / stdin text / cwd, answering one line of JSON per request
 * (`{id, exitCode, stdout, stderr}`), so a script keeps its CLI shape and a module-level model cache survives
 * between calls. Images and other large data travel by file path, never inline in the protocol.
 *
 * A pool serves one request per worker at a time, with up to `maxWorkers` workers in parallel. Each request has a
 * timeout and an optional AbortSignal: a Stop or a timeout kills the worker running that request (its computation
 * cannot be interrupted any other way) and the next request starts a fresh one; a request still queued is simply
 * dropped. A worker that crashes fails its request with the exit status and its stderr tail and is replaced on
 * the next request. Idle workers shut down after `idleShutdownMs`; all workers are killed when this process exits,
 * and a worker whose parent dies sees its stdin close and exits on its own.
 */

import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export type PythonWorkerFailureKind = 'spawn' | 'startup' | 'crash' | 'timeout' | 'protocol';

export class PythonWorkerError extends Error {
    constructor(public readonly kind: PythonWorkerFailureKind, message: string) {
        super(message);
        this.name = 'PythonWorkerError';
    }
}

export interface PythonWorkerPoolOptions {
    /** Interpreter (or wrapper executable) that runs the host. */
    pythonBinary: string;
    /** The sidecar script whose `main()` serves each request. */
    scriptPath: string;
    /** Name used in error messages (e.g. "the MediaPipe bridge"). */
    label?: string;
    /** Workers run in parallel (default 1). A later request for the same pool may raise it. */
    maxWorkers?: number;
    /** An idle worker exits after this long (default 120 s). */
    idleShutdownMs?: number;
    env?: NodeJS.ProcessEnv;
    /** Working directory of the worker processes (default: this process's cwd at spawn). */
    cwd?: string;
    /** Override of worker_host.py (tests). */
    hostScriptPath?: string;
}

export interface PythonWorkerRequest {
    argv?: string[];
    /** Small text the script reads from sys.stdin (e.g. a JSON request). Not for image bytes: pass a file path. */
    stdin?: string;
    /** Working directory for this request only. */
    cwd?: string;
    timeoutMs: number;
    signal?: AbortSignal;
}

export interface PythonWorkerResult {
    exitCode: number;
    stdout: string;
    stderr: string;
    /** Pid of the worker that served the request. */
    workerPid: number;
    /** How many requests that worker had served before this one (0 = it started for this request). */
    priorRequestsOnWorker: number;
}

interface PendingRequest {
    id: number;
    request: PythonWorkerRequest;
    resolve: (r: PythonWorkerResult) => void;
    reject: (e: unknown) => void;
    timer?: NodeJS.Timeout;
    onAbort?: () => void;
}

interface WorkerSlot {
    child: ChildProcess;
    pid: number;
    current?: PendingRequest;
    served: number;
    stdoutBuf: string;
    stderrTail: string;
    fatal?: string;
    idleTimer?: NodeJS.Timeout;
    dead: boolean;
}

const STDERR_TAIL_BYTES = 4000;

function abortError(label: string, signal?: AbortSignal): Error {
    return Object.assign(new Error(`${label} was stopped`), { name: 'AbortError', cause: signal?.reason });
}

/** Locates worker_host.py next to the sources, or under the working directory. */
export function resolveWorkerHostScript(): string | undefined {
    const candidates = [
        path.resolve(__dirname, '../../python/scratchbox/worker_host.py'),
        path.resolve(process.cwd(), 'packages/core/src/python/scratchbox/worker_host.py'),
        path.resolve(process.cwd(), '../packages/core/src/python/scratchbox/worker_host.py')
    ];
    return candidates.find(c => fs.existsSync(c));
}

export class PersistentPythonWorkerPool {
    private readonly label: string;
    private maxWorkers: number;
    private readonly idleShutdownMs: number;
    private readonly workers: WorkerSlot[] = [];
    private readonly queue: PendingRequest[] = [];
    private nextId = 1;
    private closed = false;
    /** Processes started over the pool's life (a measure of how often a model had to be loaded). */
    public spawnCount = 0;
    public requestCount = 0;

    constructor(private readonly options: PythonWorkerPoolOptions) {
        this.label = options.label ?? path.basename(options.scriptPath);
        this.maxWorkers = Math.max(1, Math.floor(options.maxWorkers ?? 1));
        this.idleShutdownMs = options.idleShutdownMs ?? 120_000;
    }

    /** Raises the parallel worker limit (never lowers it while requests may be running). */
    public ensureMaxWorkers(n: number): void {
        this.maxWorkers = Math.max(this.maxWorkers, Math.floor(n));
        this.dispatch();
    }

    public get liveWorkerCount(): number {
        return this.workers.filter(w => !w.dead).length;
    }

    public run(request: PythonWorkerRequest): Promise<PythonWorkerResult> {
        const signal = request.signal;
        if (signal?.aborted) return Promise.reject(abortError(this.label, signal));
        if (this.closed) return Promise.reject(new PythonWorkerError('spawn', `${this.label}: the worker pool was shut down`));
        return new Promise<PythonWorkerResult>((resolve, reject) => {
            const pending: PendingRequest = { id: this.nextId++, request, resolve, reject };
            if (signal) {
                pending.onAbort = () => this.abortRequest(pending);
                signal.addEventListener('abort', pending.onAbort, { once: true });
            }
            this.requestCount++;
            this.queue.push(pending);
            this.dispatch();
        });
    }

    /** Ends every worker and fails queued and running requests. */
    public shutdown(): void {
        this.closed = true;
        for (const p of this.queue.splice(0)) this.settle(p, undefined, new PythonWorkerError('crash', `${this.label}: the worker pool was shut down`));
        for (const w of this.workers) {
            if (w.current) this.settle(w.current, undefined, new PythonWorkerError('crash', `${this.label}: the worker pool was shut down`));
            w.current = undefined;
            this.killWorker(w);
        }
    }

    /** Synchronous kill for process exit. */
    public killAllSync(): void {
        for (const w of this.workers) {
            if (!w.dead) {
                try { w.child.kill('SIGKILL'); } catch { /* already gone */ }
            }
        }
    }

    private dispatch(): void {
        while (this.queue.length > 0) {
            let slot = this.workers.find(w => !w.dead && !w.current);
            if (!slot) {
                if (this.liveWorkerCount >= this.maxWorkers) return;
                const started = this.startWorker();
                if (!started) return; // the queued request was failed by startWorker
                slot = started;
            }
            const pending = this.queue.shift()!;
            this.assign(slot, pending);
        }
    }

    private startWorker(): WorkerSlot | undefined {
        const host = this.options.hostScriptPath ?? resolveWorkerHostScript();
        if (!host || !fs.existsSync(host)) {
            const err = new PythonWorkerError('spawn', `${this.label}: the Python worker host worker_host.py was not found (looked next to ${__dirname} and under ${process.cwd()})`);
            for (const p of this.queue.splice(0)) this.settle(p, undefined, err);
            return undefined;
        }
        let child: ChildProcess;
        try {
            child = spawn(this.options.pythonBinary, [host, this.options.scriptPath], {
                stdio: ['pipe', 'pipe', 'pipe'],
                cwd: this.options.cwd,
                env: this.options.env
            });
        } catch (e: any) {
            const err = new PythonWorkerError('spawn', `${this.label}: ${this.options.pythonBinary} could not be started (${e?.message || e})`);
            for (const p of this.queue.splice(0)) this.settle(p, undefined, err);
            return undefined;
        }
        this.spawnCount++;
        const slot: WorkerSlot = { child, pid: child.pid ?? -1, served: 0, stdoutBuf: '', stderrTail: '', dead: false };
        this.workers.push(slot);
        // The workers never keep this process alive on their own: a pending request's timer does.
        child.unref();
        (child.stdin as any)?.unref?.();
        (child.stdout as any)?.unref?.();
        (child.stderr as any)?.unref?.();
        child.stdin?.on('error', () => { /* reported through exit */ });
        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => this.onStdout(slot, chunk));
        child.stderr?.on('data', (chunk: Buffer) => {
            slot.stderrTail = (slot.stderrTail + chunk.toString()).slice(-STDERR_TAIL_BYTES);
        });
        child.on('error', (e: Error) => this.onWorkerGone(slot, `${this.options.pythonBinary} could not be started (${e.message})`, 'spawn'));
        child.on('exit', (code, sig) => this.onWorkerGone(slot, `exited with ${sig ? `signal ${sig}` : `code ${code}`}`, 'crash'));
        return slot;
    }

    private assign(slot: WorkerSlot, pending: PendingRequest): void {
        if (slot.idleTimer) { clearTimeout(slot.idleTimer); slot.idleTimer = undefined; }
        slot.current = pending;
        const { request } = pending;
        pending.timer = setTimeout(() => {
            if (slot.current !== pending) return;
            slot.current = undefined;
            this.killWorker(slot);
            this.settle(pending, undefined, new PythonWorkerError('timeout', `${this.label} timed out after ${request.timeoutMs} ms`));
            this.dispatch();
        }, request.timeoutMs);
        const line = JSON.stringify({ id: pending.id, argv: request.argv ?? [], stdin: request.stdin ?? '', cwd: request.cwd }) + '\n';
        try {
            slot.child.stdin?.write(line);
        } catch {
            // The exit handler fails the request.
        }
    }

    private onStdout(slot: WorkerSlot, chunk: string): void {
        slot.stdoutBuf += chunk;
        let nl: number;
        while ((nl = slot.stdoutBuf.indexOf('\n')) >= 0) {
            const line = slot.stdoutBuf.slice(0, nl).trim();
            slot.stdoutBuf = slot.stdoutBuf.slice(nl + 1);
            if (!line) continue;
            let msg: any;
            try {
                msg = JSON.parse(line);
            } catch {
                slot.stderrTail = (slot.stderrTail + `\n[non-protocol stdout] ${line.slice(0, 300)}`).slice(-STDERR_TAIL_BYTES);
                continue;
            }
            if (msg.ready) continue;
            if (typeof msg.fatal === 'string') {
                slot.fatal = msg.fatal;
                continue;
            }
            const pending = slot.current;
            if (typeof msg.protocolError === 'string') {
                if (pending) {
                    slot.current = undefined;
                    this.settle(pending, undefined, new PythonWorkerError('protocol', `${this.label}: ${msg.protocolError}`));
                }
                continue;
            }
            if (!pending || msg.id !== pending.id) continue; // an answer to a request already timed out or stopped
            slot.current = undefined;
            const prior = slot.served++;
            this.settle(pending, {
                exitCode: typeof msg.exitCode === 'number' ? msg.exitCode : 1,
                stdout: String(msg.stdout ?? ''),
                stderr: String(msg.stderr ?? ''),
                workerPid: slot.pid,
                priorRequestsOnWorker: prior
            });
            this.onIdle(slot);
        }
    }

    private onIdle(slot: WorkerSlot): void {
        this.dispatch();
        if (slot.dead || slot.current) return;
        slot.idleTimer = setTimeout(() => {
            if (slot.current || slot.dead) return;
            try {
                slot.child.stdin?.write(JSON.stringify({ shutdown: true }) + '\n');
                slot.child.stdin?.end();
            } catch {
                this.killWorker(slot);
            }
        }, this.idleShutdownMs);
        slot.idleTimer.unref();
    }

    private onWorkerGone(slot: WorkerSlot, how: string, kind: PythonWorkerFailureKind): void {
        if (slot.dead) return;
        slot.dead = true;
        if (slot.idleTimer) clearTimeout(slot.idleTimer);
        const idx = this.workers.indexOf(slot);
        if (idx >= 0) this.workers.splice(idx, 1);
        const pending = slot.current;
        slot.current = undefined;
        if (pending) {
            const tail = slot.stderrTail.trim();
            const reason = slot.fatal
                ? `${this.label} could not start: ${slot.fatal}`
                : `${this.label} ${how}${tail ? `: ${tail.slice(-600)}` : ''}`;
            this.settle(pending, undefined, new PythonWorkerError(slot.fatal ? 'startup' : kind, reason));
        }
        if (!this.closed) this.dispatch();
    }

    private killWorker(slot: WorkerSlot): void {
        if (slot.dead) return;
        try { slot.child.kill('SIGKILL'); } catch { /* already gone */ }
    }

    private abortRequest(pending: PendingRequest): void {
        const qi = this.queue.indexOf(pending);
        if (qi >= 0) {
            this.queue.splice(qi, 1);
        } else {
            const slot = this.workers.find(w => w.current === pending);
            if (slot) {
                slot.current = undefined;
                this.killWorker(slot);
            }
        }
        this.settle(pending, undefined, abortError(this.label, pending.request.signal));
        this.dispatch();
    }

    private settle(pending: PendingRequest, result?: PythonWorkerResult, error?: unknown): void {
        if (pending.timer) clearTimeout(pending.timer);
        if (pending.onAbort) pending.request.signal?.removeEventListener('abort', pending.onAbort);
        pending.timer = undefined;
        pending.onAbort = undefined;
        if (error !== undefined) pending.reject(error);
        else pending.resolve(result!);
    }
}

// ============================================================================
// Shared pools: services are constructed per call, the workers outlive them.
// ============================================================================

const pools = new Map<string, PersistentPythonWorkerPool>();
let exitHookInstalled = false;

function poolKey(o: PythonWorkerPoolOptions): string {
    const envKey = o.env ? Object.keys(o.env).sort().map(k => `${k}=${o.env![k]}`).join('\u0000') : '';
    return JSON.stringify([o.pythonBinary, path.resolve(o.scriptPath), o.hostScriptPath ?? '', o.cwd ?? '', envKey]);
}

/** The shared pool for this interpreter + script (+ cwd/env); created on first use. */
export function getPythonWorkerPool(options: PythonWorkerPoolOptions): PersistentPythonWorkerPool {
    if (!exitHookInstalled) {
        exitHookInstalled = true;
        process.once('exit', () => { for (const p of pools.values()) p.killAllSync(); });
    }
    // Without an explicit environment a worker gets this process's environment as it is now, exactly as a fresh
    // spawn would: a later change to process.env starts a new pool rather than reusing a worker started under the
    // old values.
    const resolved: PythonWorkerPoolOptions = options.env ? options : { ...options, env: { ...process.env } };
    const key = poolKey(resolved);
    let pool = pools.get(key);
    if (!pool) {
        pool = new PersistentPythonWorkerPool(resolved);
        pools.set(key, pool);
    } else if (options.maxWorkers) {
        pool.ensureMaxWorkers(options.maxWorkers);
    }
    return pool;
}

/** Shuts every shared pool down (server shutdown, tests). */
export function shutdownAllPythonWorkerPools(): void {
    for (const p of pools.values()) p.shutdown();
    pools.clear();
}

/** Runs `fn` over `items` with at most `limit` in flight; results keep the input order. Rejects on the first failure. */
export async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    let failed = false;
    const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
        while (!failed && next < items.length) {
            const i = next++;
            try {
                results[i] = await fn(items[i], i);
            } catch (e) {
                failed = true;
                throw e;
            }
        }
    });
    await Promise.all(lanes);
    return results;
}
