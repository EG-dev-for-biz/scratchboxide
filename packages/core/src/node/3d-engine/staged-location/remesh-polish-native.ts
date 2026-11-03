/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K's remesh-polish steps in native C++20 on a fixed thread pool (scripts/remesh_polish_native.cpp over
 * scratchbox_window_fit.hpp and scratchbox_open_loop_fill.hpp): the window fit (window-fit.ts fitOrthoFacadesNative, the
 * photometric relief read in the same process, one facade a task) and the infill (pipeline-k/lattice-stitch.ts
 * fillOpenLoops). Their results are the TypeScript's, which stays behind SCRATCHBOX_K_NATIVE_POLISH=0 for comparison.
 *
 * Data goes over stdin as raw little-endian buffers (a header, then arrays), never PNG; the window fit's facades are
 * streamed as they are decoded and fitted as they arrive. The pool's size is the caller's: a chunked district's builds
 * pass their share of the cores (pipeline-k/district-chunks.ts chunkCpuShare).
 *
 * The binary is built through the native build cache. The polish runs synchronously (often on a worker thread), so the
 * infill finds the binary by its cache key (remeshPolishBinarySync); ensureRemeshPolishBinary builds it first.
 */

import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Vec2 } from '../../../common/spatial/staged-location-contracts';
import { compileNativeCached, defaultNativeFlags, nativeBuildCacheRoot, nativeBuildEntryBinary, nativeBuildKey, NativeBuildError, type NativeCompileSpec } from '../native-build-cache';
import { findTileRefineRepoRoot } from '../tile-refine-service';

/** The native polish steps are on unless SCRATCHBOX_K_NATIVE_POLISH=0. */
export function nativePolishEnabled(): boolean {
    return process.env.SCRATCHBOX_K_NATIVE_POLISH?.trim() !== '0';
}

/** The pool's size when the caller names none: every core. */
export function nativePolishThreads(): number {
    return Math.max(1, typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length);
}

const CLI_SOURCE = path.join('scripts', 'remesh_polish_native.cpp');
const INCLUDE_DIR = path.join('packages', 'core', 'src', 'native', '3d-engine', 'include');

function compileSpec(repoRoot: string): NativeCompileSpec {
    return { sourcePath: path.join(repoRoot, CLI_SOURCE), includeDirs: [path.join(repoRoot, INCLUDE_DIR)], flags: defaultNativeFlags(), libs: ['-lz'], name: 'remesh_polish_native', timeoutMs: 600_000 };
}

let building: Promise<string> | undefined;

/** The native polish binary, compiled through the native build cache when no process has yet. */
export function ensureRemeshPolishBinary(repoRoot = findTileRefineRepoRoot()): Promise<string> {
    if (process.env.SCRATCHBOX_REMESH_POLISH_BIN) return Promise.resolve(process.env.SCRATCHBOX_REMESH_POLISH_BIN);
    building ??= (async () => {
        try {
            return (await compileNativeCached(compileSpec(repoRoot))).binaryPath;
        } catch (err) {
            throw new Error(`could not build remesh_polish_native: ${err instanceof NativeBuildError ? err.compilerOutput.slice(-1500) : String(err)}`);
        }
    })().finally(() => { building = undefined; });
    return building;
}

/** The polish input's native steps built before it runs: the infill (or seal) runs synchronously and cannot compile. */
export async function ensureNativePolishFor(input: { infill?: boolean; seal?: boolean }): Promise<void> {
    if ((input.infill || input.seal) && nativePolishEnabled()) await ensureRemeshPolishBinary();
}

/** The binary already in the native build cache for this source, found synchronously; throws when it was never built. */
export function remeshPolishBinarySync(repoRoot = findTileRefineRepoRoot()): string {
    if (process.env.SCRATCHBOX_REMESH_POLISH_BIN) return process.env.SCRATCHBOX_REMESH_POLISH_BIN;
    const bin = nativeBuildEntryBinary(nativeBuildCacheRoot(), nativeBuildKey(compileSpec(repoRoot)).key);
    if (!fs.existsSync(bin)) throw new Error('the native remesh polish is not built yet: await ensureRemeshPolishBinary() before the polish (or set SCRATCHBOX_K_NATIVE_POLISH=0 for the TypeScript)');
    return bin;
}

// ------------------------------------------------------------------------------------------------ buffers

/** Little-endian writer of the drivers' input. */
class Writer {
    private parts: Buffer[] = [];
    u32(v: number) { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); this.parts.push(b); return this; }
    i32(v: number) { const b = Buffer.alloc(4); b.writeInt32LE(v | 0); this.parts.push(b); return this; }
    // typed arrays are little-endian on every host Node runs the app on
    f64s(v: ArrayLike<number>) { const a = Float64Array.from(v); this.parts.push(Buffer.from(a.buffer, a.byteOffset, a.byteLength)); return this; }
    u32s(v: ArrayLike<number>) { const a = Uint32Array.from(v); this.parts.push(Buffer.from(a.buffer, a.byteOffset, a.byteLength)); return this; }
    raw(v: Uint8Array) { this.parts.push(Buffer.from(v.buffer, v.byteOffset, v.byteLength)); return this; }
    magic(m: string) { this.parts.push(Buffer.from(m, 'latin1')); return this; }
    take(): Buffer { const b = Buffer.concat(this.parts); this.parts = []; return b; }
}

// ------------------------------------------------------------------------------------------------ the window fit

/** One facade photo for the native window fit: rgba, and the texels not read (1: never reached, or something stood in front). */
export interface NativeFacadeInput { slot: number; width: number; height: number; pixel: number; orthoSMin: number; orthoTMax: number; texel: number; rgba: Uint8Array; unread: Uint8Array }
/** One facade's native fit, as scratchbox_window_fit.hpp fitJson writes it (bands: window-fit.ts WindowFitBand). */
export type NativeFacadeFit = { slot: number; ms: number; rects: Array<[number, number, number, number]>; panes: Array<[number, number, number, number]>; generated?: Array<[number, number, number, number]>; bands: unknown[] } | { slot: number; error: string };

/**
 * Fits the facades natively, `threads` at once, each handed back (onFit) as it finishes. The facades are written to the
 * driver as the iterable yields them, so decoding the next overlaps fitting the last.
 */
export async function runNativeWindowFit(params: number[], facades: AsyncIterable<NativeFacadeInput> | Iterable<NativeFacadeInput>, opts: { threads: number; signal?: AbortSignal; onFit: (fit: NativeFacadeFit) => void }): Promise<void> {
    const bin = await ensureRemeshPolishBinary();
    if (opts.signal?.aborted) throw opts.signal.reason ?? new Error('aborted');
    const child = spawn(bin, ['window-fit', String(Math.max(1, Math.floor(opts.threads)))], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '', pending = '', failed: Error | undefined;
    child.stderr.on('data', (d: Buffer) => { stderr = (stderr + d.toString('utf8')).slice(-8000); });
    child.stdout.on('data', (d: Buffer) => {
        pending += d.toString('utf8');
        for (let nl = pending.indexOf('\n'); nl >= 0; nl = pending.indexOf('\n')) {
            const line = pending.slice(0, nl).trim();
            pending = pending.slice(nl + 1);
            if (!line) continue;
            try { opts.onFit(JSON.parse(line) as NativeFacadeFit); } catch (err) { failed ??= err instanceof Error ? err : new Error(String(err)); }
        }
    });
    const exited = new Promise<void>((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (code, sig) => (code === 0 ? resolve() : reject(new Error(`remesh_polish_native window-fit failed (${sig ?? `exit ${code}`}): ${stderr.trim().slice(-1500)}`))));
    });
    exited.catch(() => { /* awaited below; a failure while the next facade decodes is not unhandled */ });
    // a closed pipe is the child's failure, reported by its exit
    child.stdin.on('error', () => { /* the exit says why */ });
    const onAbort = () => child.kill('SIGKILL');
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    // a write waits for the pipe to drain, or for the driver to exit (its failure then thrown)
    const write = (b: Buffer) => Promise.race([new Promise<void>(resolve => { if (child.stdin.write(b)) resolve(); else child.stdin.once('drain', resolve); }), exited]);
    try {
        const w = new Writer();
        await write(w.magic('SBWF').u32(1).u32(params.length).f64s(params).take());
        for await (const f of facades) {
            if (opts.signal?.aborted || child.exitCode !== null) break;
            if (f.rgba.length !== f.width * f.height * 4 || f.unread.length !== f.width * f.height) throw new Error(`facade ${f.slot}: rgba or mask does not match ${f.width} x ${f.height}`);
            await write(w.u32(1).i32(f.slot).u32(f.width).u32(f.height).f64s([f.pixel, f.orthoSMin, f.orthoTMax, f.texel]).take());
            await write(Buffer.from(f.rgba.buffer, f.rgba.byteOffset, f.rgba.byteLength));
            await write(Buffer.from(f.unread.buffer, f.unread.byteOffset, f.unread.byteLength));
        }
        if (child.exitCode === null) await write(w.u32(0).take());
        child.stdin.end();
        await exited;
    } catch (err) {
        child.kill('SIGKILL');
        throw err;
    } finally {
        opts.signal?.removeEventListener('abort', onAbort);
    }
    if (opts.signal?.aborted) throw opts.signal.reason ?? new Error('aborted');
    if (failed) throw failed;
}

// ------------------------------------------------------------------------------------------------ the infill

/** One triangle primitive of the clay, in mesh and primitive order: its positions, indices (none: a soup) and rebuilt wall (-1: scan). */
export interface NativeFillPrim { wall: number; X: ArrayLike<number>; I?: ArrayLike<number> }
export interface NativeFillPiece { parent: number; p: number[][]; w: number[][]; of: number }

/** The infill's geometry natively (lattice-stitch.ts fillOpenLoops): its report, the fill's triangles and the twin's pieces. */
export function runNativeFill(params: number[], footprint: Vec2[][], prims: NativeFillPrim[], threads: number): { report: Record<string, unknown>; out: number[][][]; pieces: NativeFillPiece[] } {
    const bin = remeshPolishBinarySync();
    const w = new Writer().magic('SBFL').u32(1).u32(params.length).f64s(params).u32(footprint.length);
    for (const loop of footprint) w.u32(loop.length).f64s(loop.flatMap(p => [p[0], p[1]]));
    w.u32(prims.length);
    for (const p of prims) w.i32(p.wall).u32(p.X.length / 3).f64s(p.X).u32(p.I ? 1 : 0).u32(p.I ? p.I.length : 0).u32s(p.I ?? []);
    const r = spawnSync(bin, ['fill', String(Math.max(1, Math.floor(threads)))], { input: w.take(), maxBuffer: 1024 * 1024 * 1024 });
    if (r.error) throw new Error(`remesh_polish_native fill could not run: ${r.error.message}`);
    if (r.status !== 0) throw new Error(`remesh_polish_native fill failed (${r.signal ?? `exit ${r.status}`}): ${r.stderr.toString('utf8').trim().slice(-1500)}`);
    const b: Buffer = r.stdout;
    let o = 0;
    const u32 = () => { const v = b.readUInt32LE(o); o += 4; return v; };
    const i32 = () => { const v = b.readInt32LE(o); o += 4; return v; };
    const f64 = () => { const v = b.readDoubleLE(o); o += 8; return v; };
    const v3 = () => [f64(), f64(), f64()];
    const jl = u32();
    const report = JSON.parse(b.toString('utf8', o, o + jl)) as Record<string, unknown>;
    o += jl;
    const out = Array.from({ length: u32() }, () => [v3(), v3(), v3()]);
    const pieces = Array.from({ length: u32() }, () => { const parent = i32(), of = i32(); return { parent, of, p: [v3(), v3(), v3()], w: [v3(), v3(), v3()] }; });
    if (o !== b.length) throw new Error(`remesh_polish_native fill: ${b.length - o} bytes left over in its output`);
    return { report, out, pieces };
}
