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
 * scratchbox_window_fit.hpp, scratchbox_wall_grammar.hpp, scratchbox_facade_lattice.hpp and scratchbox_open_loop_fill.hpp):
 * the window fit (window-fit.ts fitOrthoFacadesNative, the photometric relief read in the same process, one facade a
 * task), the wall grammar's evidence and bays (wall-grammar.ts readWallGrammar, one wall a task), the lattice
 * (facade-lattice.ts: each facade's lattice and rebuilt surface, and its repeat texture, one facade a task; then the
 * removals under the tear audit, one view a task) and the infill (pipeline-k/lattice-stitch.ts fillOpenLoops). Their
 * results are the TypeScript's, which runs when SCRATCHBOX_K_NATIVE leaves `window-fit`, `wall-grammar`, `lattice` or `infill` out
 * (pipeline-k/native/native-switch.ts; all native by default).
 *
 * Data goes over stdin as raw little-endian buffers (a header, then arrays), never PNG; the window fit's facades are
 * streamed as they are decoded and fitted as they arrive. The pool's size is the caller's: a chunked district's builds
 * pass their share of the cores (pipeline-k/district-chunks.ts chunkCpuShare).
 *
 * The binary is built through the native build cache. The polish runs synchronously (often on a worker thread), so the
 * wall grammar, the lattice and the infill find the binary by its cache key (remeshPolishBinarySync); ensureRemeshPolishBinary
 * builds it first.
 */

import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Vec2 } from '../../../common/spatial/staged-location-contracts';
import { compileNativeCached, defaultNativeFlags, nativeBuildCacheRoot, nativeBuildEntryBinary, nativeBuildKey, NativeBuildError, type NativeCompileSpec } from '../native-build-cache';
import { findTileRefineRepoRoot } from '../tile-refine-service';
import { kNative } from './pipeline-k/native/native-switch';

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

/** The polish input's native steps built before it runs: the lattice and the infill (or seal) run synchronously and cannot compile. */
export async function ensureNativePolishFor(input: { infill?: boolean; seal?: boolean; lattice?: boolean; orthosDir?: string }): Promise<void> {
    if (((input.infill || input.seal) && kNative('infill')) || (input.orthosDir && input.lattice !== false && kNative('lattice'))) await ensureRemeshPolishBinary();
}

/** The wall grammar's native reading built before it runs: readWallGrammar runs synchronously and cannot compile. */
export async function ensureNativeWallGrammar(): Promise<void> {
    if (kNative('wall-grammar')) await ensureRemeshPolishBinary();
}

/** The binary already in the native build cache for this source, found synchronously; throws when it was never built. */
export function remeshPolishBinarySync(repoRoot = findTileRefineRepoRoot()): string {
    if (process.env.SCRATCHBOX_REMESH_POLISH_BIN) return process.env.SCRATCHBOX_REMESH_POLISH_BIN;
    const bin = nativeBuildEntryBinary(nativeBuildCacheRoot(), nativeBuildKey(compileSpec(repoRoot)).key);
    if (!fs.existsSync(bin)) throw new Error('the native remesh polish is not built yet: await ensureRemeshPolishBinary() before the step (or leave `wall-grammar`, `lattice` and `infill` out of SCRATCHBOX_K_NATIVE for the TypeScript)');
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
    f32s(v: Float32Array) { this.parts.push(Buffer.from(v.buffer, v.byteOffset, v.byteLength)); return this; }
    str(v: string) { const b = Buffer.from(v, 'utf8'); return this.u32(b.length).raw(b); }
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
export async function runNativeWindowFit(params: number[], srgb8Linear: Float64Array, facades: AsyncIterable<NativeFacadeInput> | Iterable<NativeFacadeInput>, opts: { threads: number; signal?: AbortSignal; onFit: (fit: NativeFacadeFit) => void }): Promise<void> {
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
        await write(w.magic('SBWF').u32(2).u32(params.length).f64s(params).u32(srgb8Linear.length).f64s(srgb8Linear).take());
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

// ------------------------------------------------------------------------------------------------ the lattice

/** Reads the drivers' little-endian output. */
class Reader {
    private o = 0;
    constructor(private readonly b: Buffer) {}
    u32() { const v = this.b.readUInt32LE(this.o); this.o += 4; return v; }
    i32() { const v = this.b.readInt32LE(this.o); this.o += 4; return v; }
    f64() { const v = this.b.readDoubleLE(this.o); this.o += 8; return v; }
    // copied out: the arrays need their own alignment
    f64s(n: number) { const a = new Float64Array(this.b.buffer.slice(this.b.byteOffset + this.o, this.b.byteOffset + this.o + n * 8)); this.o += n * 8; return a; }
    f32s(n: number) { const a = new Float32Array(this.b.buffer.slice(this.b.byteOffset + this.o, this.b.byteOffset + this.o + n * 4)); this.o += n * 4; return a; }
    u32s(n: number) { const a = new Uint32Array(this.b.buffer.slice(this.b.byteOffset + this.o, this.b.byteOffset + this.o + n * 4)); this.o += n * 4; return a; }
    i32s(n: number) { const a = new Int32Array(this.b.buffer.slice(this.b.byteOffset + this.o, this.b.byteOffset + this.o + n * 4)); this.o += n * 4; return a; }
    u8s(n: number) { const a = Uint8Array.from(this.b.subarray(this.o, this.o + n)); this.o += n; return a; }
    str() { const n = this.u32(); const v = this.b.toString('utf8', this.o, this.o + n); this.o += n; return v; }
    done(what: string) { if (this.o !== this.b.length) throw new Error(`remesh_polish_native ${what}: ${this.b.length - this.o} bytes left over in its output`); }
}

function runSync(cmd: string, input: Buffer, threads: number): Buffer {
    const r = spawnSync(remeshPolishBinarySync(), [cmd, String(Math.max(1, Math.floor(threads)))], { input, maxBuffer: 4 * 1024 * 1024 * 1024 });
    if (r.error) throw new Error(`remesh_polish_native ${cmd} could not run: ${r.error.message}`);
    if (r.status !== 0) throw new Error(`remesh_polish_native ${cmd} failed (${r.signal ?? `exit ${r.status}`}): ${r.stderr.toString('utf8').trim().slice(-1500)}`);
    return r.stdout;
}

/** A facade's plane frame and ortho, as the lattice reads them (facade-lattice.ts ReliefFacade). */
export interface NativeLatticeFrame { facadeId: number; centroid: number[]; normal: number[]; axisS: number[]; axisT: number[]; sMin: number; sMax: number; tMin: number; tMax: number; pixel: number; orthoSMin: number; orthoTMax: number }
type Rect4 = readonly [number, number, number, number] | number[];

function frame(w: Writer, f: NativeLatticeFrame): Writer {
    return w.i32(f.facadeId).f64s([...f.centroid, ...f.normal, ...f.axisS, ...f.axisT, f.sMin, f.sMax, f.tMin, f.tMax, f.pixel, f.orthoSMin, f.orthoTMax]);
}
function rects(w: Writer, rs: readonly Rect4[] | undefined): Writer { return w.u32(rs?.length ?? 0).f64s((rs ?? []).flatMap(r => [r[0], r[1], r[2], r[3]])); }

/** One facade for the native lattice: latticeFacade's arguments, its photo and mask by file, and the repeat texture's windows in texels. */
export interface NativeLatticeJob { f: NativeLatticeFrame; image: string; mask?: string; fitted?: readonly Rect4[]; bays?: readonly Rect4[]; recessM?: number; rectsPx?: readonly Rect4[] }
/** One facade's native lattice (undefined: latticeFacade's undefined) and its repeat texture, when it drew any texel. */
export interface NativeLatticeOut {
    /** The photo's size. */
    width: number; height: number;
    lattice?: {
        s: number[]; t: number[]; cells: number; measuredShare: number; depth: Float64Array; photoRecessCells?: number;
        strips: Array<[number, number, number, number]>; stripCells: number; structure?: { cells: Uint8Array; reliefM: number; reliefFrom: string; reason: string };
        built: Uint8Array; windows: Uint8Array; cellU: number[]; cellV: number[]; positions: Float32Array; normals: Float32Array; uv: Float32Array; indices: Uint32Array;
    };
    repeat?: { groups: number; windows: number; spandrels: number; texels: number; filled: number; edge: number; png: Buffer };
}

/** facade-lattice.ts's per-facade work natively: decoded, sampled from the scan (and the raw scan), latticed, rebuilt and retextured. */
export function runNativeLattice(params: number[], opts: { photoRecess: boolean; whole: boolean }, soup: Float32Array, rawSoup: Float32Array | undefined, jobs: NativeLatticeJob[], threads: number): NativeLatticeOut[] {
    const w = new Writer().magic('SBLF').u32(1).u32(params.length).f64s(params).u32((opts.photoRecess ? 1 : 0) | (opts.whole ? 2 : 0));
    w.u32(soup.length).f32s(soup).u32(rawSoup ? 1 : 0).u32(rawSoup?.length ?? 0);
    if (rawSoup) w.f32s(rawSoup);
    w.u32(jobs.length);
    for (const j of jobs) {
        frame(w, j.f).str(j.image).str(j.mask ?? '');
        rects(w, j.fitted).u32(j.bays ? 1 : 0);
        rects(w, j.bays).u32(j.recessM !== undefined ? 1 : 0).f64s([j.recessM !== undefined ? Number(j.recessM) : 0]);
        rects(w, j.rectsPx);
    }
    const r = new Reader(runSync('lattice', w.take(), threads));
    const out = jobs.map((): NativeLatticeOut => {
        const ok = r.u32(), width = r.u32(), height = r.u32();
        if (!ok) return { width, height };
        const s = Array.from(r.f64s(r.u32())), t = Array.from(r.f64s(r.u32())), n = (s.length - 1) * (t.length - 1);
        const cells = r.i32(), measuredShare = r.f64(), depth = r.f64s(n);
        const hasPhotoRecess = r.u32(), photoRecessCells = r.i32();
        const strips = Array.from({ length: r.u32() }, () => Array.from(r.f64s(4)) as [number, number, number, number]);
        const stripCells = r.i32();
        const structure = r.u32() ? { cells: r.u8s(n), reliefM: r.f64(), reliefFrom: r.str(), reason: r.str() } : undefined;
        const built = r.u8s(n), windows = r.u8s(n), cellU = Array.from(r.f64s(s.length)), cellV = Array.from(r.f64s(t.length));
        const positions = r.f32s(r.u32()), normals = r.f32s(r.u32()), uv = r.f32s(r.u32()), indices = r.u32s(r.u32());
        const repeat = r.u32() ? { groups: r.i32(), windows: r.i32(), spandrels: r.i32(), texels: r.f64(), filled: r.f64(), edge: r.f64(), png: Buffer.from(r.u8s(r.u32())) } : undefined;
        return { width, height, lattice: { s, t, cells, measuredShare, depth, ...(hasPhotoRecess ? { photoRecessCells } : {}), strips, stripCells, ...(structure ? { structure } : {}), built, windows, cellU, cellV, positions, normals, uv, indices }, ...(repeat ? { repeat } : {}) };
    });
    r.done('lattice');
    return out;
}

/** A rebuilt facade for the native audit: its frame, lattice lines, rebuilt cells and surface. */
export interface NativeAuditFacade { f: NativeLatticeFrame; s: number[]; t: number[]; built: Uint8Array; positions: Float32Array; indices: Uint32Array }

/**
 * facade-lattice.ts applyFacadeLattices' removals under its tear audit natively: per scan triangle (nine floats each, the
 * indexed primitives' in order) the facade claiming it (-1: kept), and what the audit found, restored and dropped.
 */
export function runNativeLatticeAudit(params: number[], sameFacing: boolean, soup: Float32Array, facades: NativeAuditFacade[], threads: number): { claim: Int32Array; found: number; restored: number; left: number; obliqueLeft: number; oblique?: number; dropped: number[] } {
    const w = new Writer().magic('SBLA').u32(1).u32(params.length).f64s(params).u32(sameFacing ? 1 : 0).u32(soup.length).f32s(soup).u32(facades.length);
    for (const x of facades) {
        if (x.built.length !== (x.s.length - 1) * (x.t.length - 1)) throw new Error(`facade ${x.f.facadeId}: its built cells do not match its lattice`);
        frame(w, x.f).u32(x.s.length).f64s(x.s).u32(x.t.length).f64s(x.t).raw(x.built).u32(x.positions.length).f32s(x.positions).u32(x.indices.length).raw(new Uint8Array(x.indices.buffer, x.indices.byteOffset, x.indices.byteLength));
    }
    const r = new Reader(runSync('lattice-audit', w.take(), threads));
    const claim = r.i32s(r.u32()), found = r.f64(), restored = r.f64(), left = r.f64(), obliqueLeft = r.f64(), hasOblique = r.u32(), oblique = r.f64();
    const dropped = Array.from(r.i32s(r.u32()));
    r.done('lattice-audit');
    return { claim, found, restored, left, obliqueLeft, ...(hasOblique ? { oblique } : {}), dropped };
}

// ------------------------------------------------------------------------------------------------ the wall grammar

/** A wall for the native wall grammar: its frame, and its member facades in order with their photos and masks by file and their windows in texels. */
export interface NativeWallJob {
    u0: number; y0: number; u1: number; y1: number; U: number[];
    members: Array<{ facadeId: number; centroid: number[]; axisS: number[]; axisT: number[]; pixel: number; orthoSMin: number; orthoTMax: number; width: number; height: number; image: string; uncovered?: string; occluded?: string; windows: readonly Rect4[] }>;
}

/** wall-grammar.ts' evidence and readWallBays natively, per wall: its grid's size, its covered cells, its bays and its columns' states. */
export function runNativeWallGrammar(params: number[], walls: NativeWallJob[], threads: number): Array<{ nu: number; ny: number; covered: number; bays: Array<{ u0: number; u1: number; y0: number; y1: number; generated: boolean }>; state: Int8Array }> {
    const w = new Writer().magic('SBWG').u32(1).u32(params.length).f64s(params).u32(walls.length);
    for (const x of walls) {
        w.f64s([x.u0, x.y0, x.u1, x.y1, ...x.U]).u32(x.members.length);
        for (const m of x.members) {
            w.i32(m.facadeId).f64s([...m.centroid, ...m.axisS, ...m.axisT, m.pixel, m.orthoSMin, m.orthoTMax, m.width, m.height]).str(m.image).str(m.uncovered ?? '').str(m.occluded ?? '');
            rects(w, m.windows);
        }
    }
    const r = new Reader(runSync('wall-grammar', w.take(), threads));
    const out = walls.map(() => {
        const nu = r.u32(), ny = r.u32(), covered = r.f64();
        const bays = Array.from({ length: r.u32() }, () => { const [u0, u1, y0, y1] = r.f64s(4); return { u0, u1, y0, y1, generated: r.u32() === 1 }; });
        return { nu, ny, covered, bays, state: new Int8Array(r.u8s(nu).buffer) };
    });
    r.done('wall-grammar');
    return out;
}
