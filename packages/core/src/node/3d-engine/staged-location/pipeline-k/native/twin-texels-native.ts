/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K's per-texel twin kernels in native code: scratchbox_twin_texels.hpp behind its CLI driver
 * (scripts/twin_texels.cpp), built through the native build cache. roof-shadow.ts runs its roof cells, cell shadows,
 * plane sums and lift there, and texture-harmonize.ts its apply; the fits that decide what to change stay in TypeScript.
 *
 * Run when SCRATCHBOX_K_NATIVE runs `roof-shadow` or `harmonize` natively (native-switch.ts; the default), else the TypeScript
 * loops, the reference the kernels match (roof-shadow-native.test.ts, texture-harmonize-native.test.ts).
 * SCRATCHBOX_K_NATIVE_THREADS caps their threads (default every core) when a caller passes none, so chunk builds
 * running side by side can share the machine (district-chunks.ts chunkCpuShare).
 *
 * The data goes over stdin and stdout as raw little-endian buffers (a 16-byte header and the fields the driver's
 * comment lists), never PNG. The roof-shadow lift keeps one process for its four requests (NativeTwinWorker), so its
 * twin and photos go over once; the harmonisation, a synchronous step, runs the driver once per batch of photos
 * (runNativeTwinSync).
 *
 * The values JavaScript computes with its own transcendental functions and a threshold then reads go over with the
 * data: the log colour table and the 8-bit sRGB encoder's thresholds (here), the sun frames (roof-shadow.ts sunFrame).
 */

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { SRGB8_TO_LINEAR, linearToSrgb255 } from '../../../../../common/spatial/photogrammetric-delight';
import { compileNativeCached, compileNativeCachedSync, defaultNativeFlags, NativeBuildError, placeCachedBinary, type NativeCompileSpec } from '../../../native-build-cache';
import { findTileRefineRepoRoot } from '../../../tile-refine-service';

/** The driver's requests (scripts/twin_texels.cpp). */
export const TWIN_CMD = { roofLoad: 1, roofCells: 2, cellShadows: 3, roofLift: 4, harmonize: 5 } as const;

const MAGIC = 0x54544253; // "SBTT"
const CLI_SOURCE = path.join('scripts', 'twin_texels.cpp');
const INCLUDE_DIR = path.join('packages', 'core', 'src', 'native', '3d-engine', 'include');
const BINARY = path.join('build', '3d-native', 'twin_texels');

/** The kernels' threads: the caller's, else SCRATCHBOX_K_NATIVE_THREADS, else 0 (every core). */
export function nativeTwinThreads(requested?: number, env: NodeJS.ProcessEnv = process.env): number {
    const n = requested ?? Number(env.SCRATCHBOX_K_NATIVE_THREADS ?? 0);
    return Number.isInteger(n) && n > 0 ? Math.min(n, 1024) : 0;
}

function compileSpec(repoRoot: string): NativeCompileSpec {
    // -ffp-contract=off: a fused multiply-add rounds once where JavaScript rounds twice, and the kernels match it value for value
    return { sourcePath: path.join(repoRoot, CLI_SOURCE), includeDirs: [path.join(repoRoot, INCLUDE_DIR)], flags: defaultNativeFlags(['-ffp-contract=off', '-pthread']), name: 'twin_texels', timeoutMs: 300_000 };
}

const buildFailed = (err: unknown) => new Error(`could not build twin_texels: ${err instanceof NativeBuildError ? err.compilerOutput.slice(-1500) : String(err)}`);

let building: Promise<string> | undefined;

/** Builds build/3d-native/twin_texels through the native build cache when its sources changed. */
export function ensureNativeTwinBinary(repoRoot = findTileRefineRepoRoot()): Promise<string> {
    if (process.env.SCRATCHBOX_TWIN_TEXELS_BIN) return Promise.resolve(process.env.SCRATCHBOX_TWIN_TEXELS_BIN);
    if (building) return building;
    building = (async () => {
        const bin = path.join(repoRoot, BINARY);
        try {
            placeCachedBinary((await compileNativeCached(compileSpec(repoRoot))).binaryPath, bin);
            return bin;
        } catch (err) {
            throw buildFailed(err);
        }
    })().finally(() => { building = undefined; });
    return building;
}

/** ensureNativeTwinBinary for a synchronous caller (the thread waits while a first use compiles). */
export function nativeTwinBinarySync(repoRoot = findTileRefineRepoRoot()): string {
    if (process.env.SCRATCHBOX_TWIN_TEXELS_BIN) return process.env.SCRATCHBOX_TWIN_TEXELS_BIN;
    const bin = path.join(repoRoot, BINARY);
    try {
        placeCachedBinary(compileNativeCachedSync(compileSpec(repoRoot)).binaryPath, bin);
        return bin;
    } catch (err) {
        throw buildFailed(err);
    }
}

/** log(1e-4 + linear) of each 8-bit code: the log colour roof-shadow.ts reads. */
export const LOG_LINEAR = Float64Array.from(SRGB8_TO_LINEAR, v => Math.log(1e-4 + v));

let thresholds: Float64Array | undefined;

/**
 * The 8-bit sRGB encoder as thresholds: entry k - 1 is the least linear value whose code, Math.round(linearToSrgb255),
 * is at least k (k = 1..255), found by bisection on the doubles themselves. A code read from them is the code
 * JavaScript gives, for every value.
 */
export function srgb8Thresholds(): Float64Array {
    if (thresholds) return thresholds;
    const f = new Float64Array(1), bits = new BigUint64Array(f.buffer), out = new Float64Array(255);
    const code = (x: number) => Math.round(linearToSrgb255(x));
    for (let k = 1; k <= 255; k++) {
        // positive doubles order as their bit patterns do; code(0) = 0 < k and code(1) = 255 >= k
        f[0] = 0; let lo = bits[0];
        f[0] = 1; let hi = bits[0];
        while (hi - lo > 1n) {
            bits[0] = (lo + hi) >> 1n;
            if (code(f[0]) >= k) hi = bits[0]; else lo = bits[0];
        }
        bits[0] = hi;
        out[k - 1] = f[0];
    }
    return (thresholds = out);
}

/** A request's payload: small fields packed as they come, large arrays passed as views (never copied). */
export class TwinRequest {
    readonly parts: Uint8Array[] = [];
    bytes = 0;

    constructor() {
        if (os.endianness() !== 'LE') throw new Error('twin_texels takes little-endian buffers');
    }
    private push(u: Uint8Array): this { this.parts.push(u); this.bytes += u.byteLength; return this; }
    u8(v: number): this { return this.push(Uint8Array.of(v)); }
    u32(v: number): this { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); return this.push(b); }
    i32(v: number): this { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, v, true); return this.push(b); }
    f64(...v: number[]): this { return this.push(new Uint8Array(Float64Array.from(v).buffer)); }
    array(a: ArrayBufferView): this { return this.push(new Uint8Array(a.buffer, a.byteOffset, a.byteLength)); }
    /** `count` records of `size` bytes each, written by `fill` at their offset. */
    records(count: number, size: number, fill: (dv: DataView, offset: number, i: number) => void): this {
        const b = new Uint8Array(count * size), dv = new DataView(b.buffer);
        for (let i = 0; i < count; i++) fill(dv, i * size, i);
        return this.push(b);
    }
    header(cmd: number): Uint8Array {
        const h = new Uint8Array(16), dv = new DataView(h.buffer);
        dv.setUint32(0, MAGIC, true); dv.setUint32(4, cmd, true); dv.setBigUint64(8, BigInt(this.bytes), true);
        return h;
    }
}

/** A reply's payload, read in order. Arrays come back as copies of their own (a view would keep the whole reply alive). */
export class TwinReply {
    private o = 0;
    constructor(readonly buf: Buffer) {}
    get left(): number { return this.buf.length - this.o; }
    private take(n: number): number {
        if (this.o + n > this.buf.length) throw new Error('twin_texels replied with fewer bytes than its fields');
        const at = this.o; this.o += n; return at;
    }
    u8(): number { return this.buf.readUInt8(this.take(1)); }
    u32(): number { return this.buf.readUInt32LE(this.take(4)); }
    i32(): number { return this.buf.readInt32LE(this.take(4)); }
    f64(): number { return this.buf.readDoubleLE(this.take(8)); }
    bytes(n: number): Uint8Array { const at = this.take(n); return new Uint8Array(this.buf.subarray(at, at + n)); }
    /** n bytes as a view into the reply (for arrays used only here, never passed on). */
    view(n: number): Uint8Array { const at = this.take(n); return new Uint8Array(this.buf.buffer, this.buf.byteOffset + at, n); }
    int32s(n: number): Int32Array { const at = this.take(n * 4); return new Int32Array(this.buf.buffer.slice(this.buf.byteOffset + at, this.buf.byteOffset + at + n * 4)); }
    float32s(n: number): Float32Array { const at = this.take(n * 4); return new Float32Array(this.buf.buffer.slice(this.buf.byteOffset + at, this.buf.byteOffset + at + n * 4)); }
}

function readHeader(h: Buffer, cmd: number): number {
    if (h.readUInt32LE(0) !== MAGIC || h.readUInt32LE(4) !== cmd) throw new Error(`twin_texels replied out of turn (to request ${cmd})`);
    return Number(h.readBigUInt64LE(8));
}

/** One driver process for a run of requests (one at a time); close() ends it. */
export class NativeTwinWorker {
    private readonly child: ChildProcessWithoutNullStreams;
    private stderr = '';
    private dead?: Error;
    private pending?: { cmd: number; resolve: (b: Buffer) => void; reject: (e: Error) => void };
    private head = Buffer.alloc(16);
    private headFill = 0;
    private body?: Buffer;
    private bodyFill = 0;

    static async start(threads?: number): Promise<NativeTwinWorker> {
        return new NativeTwinWorker(await ensureNativeTwinBinary(), threads);
    }

    private constructor(bin: string, threads?: number) {
        this.child = spawn(bin, ['--threads', String(nativeTwinThreads(threads))], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        this.child.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
        this.child.stderr.on('data', (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString('utf8')).slice(-8000); });
        // a write into a pipe the driver closed (it failed): the exit below says why
        this.child.stdin.on('error', () => undefined);
        const die = (why: string) => {
            this.dead ??= new Error(`twin_texels ${why}${this.stderr.trim() ? `: ${this.stderr.trim().slice(-1500)}` : ''}`);
            this.pending?.reject(this.dead);
            this.pending = undefined;
        };
        this.child.on('error', err => die(`could not run (${err.message})`));
        this.child.on('exit', (code, signal) => die(`exited (${signal ?? `code ${code}`})`));
    }

    async request(cmd: number, req: TwinRequest): Promise<TwinReply> {
        if (this.dead) throw this.dead;
        if (this.pending) throw new Error('twin_texels takes one request at a time');
        const reply = new Promise<Buffer>((resolve, reject) => { this.pending = { cmd, resolve, reject }; });
        for (const part of [req.header(cmd), ...req.parts]) {
            if (this.dead) break;
            if (!this.child.stdin.write(part)) await new Promise<void>(resolve => {
                const done = () => { this.child.stdin.off('drain', done); this.child.off('exit', done); resolve(); };
                this.child.stdin.on('drain', done);
                this.child.on('exit', done);
            });
        }
        return new TwinReply(await reply);
    }

    close(): void {
        this.child.stdin.end();
        if (!this.dead) this.child.kill();
    }

    private onData(chunk: Buffer): void {
        let off = 0;
        while (off < chunk.length && this.pending) {
            if (!this.body) {
                const take = Math.min(16 - this.headFill, chunk.length - off);
                chunk.copy(this.head, this.headFill, off, off + take);
                this.headFill += take; off += take;
                if (this.headFill < 16) return;
                try {
                    this.body = Buffer.allocUnsafe(readHeader(this.head, this.pending.cmd));
                } catch (err) {
                    this.pending.reject(err as Error); this.pending = undefined; this.child.kill(); return;
                }
                this.bodyFill = 0;
            } else {
                const take = Math.min(this.body.length - this.bodyFill, chunk.length - off);
                chunk.copy(this.body, this.bodyFill, off, off + take);
                this.bodyFill += take; off += take;
            }
            if (this.body && this.bodyFill === this.body.length) {
                const done = this.pending, body = this.body;
                this.pending = undefined; this.body = undefined; this.headFill = 0;
                done.resolve(body);
            }
        }
    }
}

/** One request to a driver of its own, synchronously (the thread waits); `replyBytes` is the payload it will send back. */
export function runNativeTwinSync(cmd: number, req: TwinRequest, replyBytes: number, threads?: number): TwinReply {
    const bin = nativeTwinBinarySync();
    const r = spawnSync(bin, ['--threads', String(nativeTwinThreads(threads))], { input: Buffer.concat([req.header(cmd), ...req.parts]), maxBuffer: replyBytes + 16 + 65536, windowsHide: true });
    if (r.error || r.status !== 0) throw new Error(`twin_texels ${r.error ? `could not run (${r.error.message})` : `exited (${r.signal ?? `code ${r.status}`})`}${r.stderr?.length ? `: ${r.stderr.toString('utf8').trim().slice(-1500)}` : ''}`);
    const out = r.stdout;
    if (out.length < 16) throw new Error('twin_texels replied with no header');
    const n = readHeader(out, cmd);
    if (out.length !== 16 + n) throw new Error(`twin_texels replied with ${out.length - 16} bytes, not ${n}`);
    return new TwinReply(out.subarray(16));
}
