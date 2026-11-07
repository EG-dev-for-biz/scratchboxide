/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K's remesh-polish steps in native C++20 on a fixed thread pool (scripts/remesh_polish_native.cpp over the
 * headers each names), every one giving its TypeScript's result, which runs when SCRATCHBOX_K_NATIVE leaves its port out
 * (pipeline-k/native/native-switch.ts; all native by default):
 *  - `window-fit`: window-fit.ts fitOrthoFacadesNative (scratchbox_window_fit.hpp), the photometric relief read in the
 *    same process, one facade a task;
 *  - `wall-grammar`: wall-grammar.ts readWallGrammar's evidence and bays (scratchbox_wall_grammar.hpp), one wall a task;
 *  - `wall-sheets`: wall-sheets.ts buildWallSheets' photos and masks (scratchbox_wall_sheets.hpp), one sheet a task, their
 *    PNG scanlines filtered there and deflated by Node's zlib, so the files are the TypeScript's byte for byte;
 *  - `lattice`: facade-lattice.ts (scratchbox_facade_lattice.hpp), each facade's lattice, rebuilt surface and repeat
 *    texture one facade a task, then the removals under the tear audit one view a task;
 *  - `cut`: pipeline-k/lattice-stitch.ts cutScanToLattice (scratchbox_lattice_cut.hpp), triangles in chunks;
 *  - `stitch`: pipeline-k/lattice-stitch.ts stitchLattice's strips and corner zips (scratchbox_lattice_stitch.hpp), one
 *    facade a task;
 *  - `clip`: pipeline-k/lattice-stitch.ts clipToFootprint (scratchbox_lattice_cut.hpp, the cut's splits and weld), triangles
 *    in chunks;
 *  - `infill`: pipeline-k/lattice-stitch.ts fillOpenLoops (scratchbox_open_loop_fill.hpp), plus its native-only CDT caps
 *    (LATTICE_STITCH_PARAMS.cdtCaps; off for its parity test);
 *  - `fill-texture`: pipeline-k/lattice-stitch.ts appendTexturedTriangles' routes (scratchbox_fill_texture.hpp), the
 *    texturing of the fill, seal and stitch in the twin, triangles and pieces in chunks.
 * and ones with no TypeScript twin: the inner core (pipeline-k/inner-core.ts, scratchbox_inner_core.hpp), columns of voxels a task;
 * and the engine's CDT itself (`cdt`: scratchbox_cdt.hpp), for its tests and tools.
 *
 * Data goes over stdin as raw little-endian buffers (a header, then arrays), never PNG; the window fit's facades are
 * streamed as they are decoded and fitted as they arrive. The pool's size is the caller's: a chunked district's builds
 * pass their share of the cores (pipeline-k/district-chunks.ts chunkCpuShare).
 *
 * The binary is built through the native build cache. The steps after the window fit run synchronously (often on a worker
 * thread), so they find the binary by its cache key (remeshPolishBinarySync); ensureRemeshPolishBinary builds it first.
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

/** The polish input's native steps built before it runs: the lattice (its cut and stitch), the clip and the infill (or seal, and their textured fill) run synchronously and cannot compile. */
export async function ensureNativePolishFor(input: { infill?: boolean; seal?: boolean; lattice?: boolean; orthosDir?: string; clip?: boolean; base?: unknown; closure?: unknown }): Promise<void> {
    // the inner core is native only
    if (input.closure || ((input.infill || input.seal) && (kNative('infill') || kNative('fill-texture'))) || (input.clip && input.base && kNative('clip')) || (input.orthosDir && input.lattice !== false && (kNative('lattice') || kNative('cut') || kNative('stitch') || kNative('fill-texture')))) await ensureRemeshPolishBinary();
}

/** The wall grammar's native reading built before it runs: readWallGrammar runs synchronously and cannot compile. */
export async function ensureNativeWallGrammar(): Promise<void> {
    if (kNative('wall-grammar')) await ensureRemeshPolishBinary();
}

/** The wall sheets' native photos built before they run: buildWallSheets runs synchronously and cannot compile. */
export async function ensureNativeWallSheets(): Promise<void> {
    if (kNative('wall-sheets')) await ensureRemeshPolishBinary();
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
    // typed arrays of the right kind go as they are, others are copied once
    f64s(v: ArrayLike<number>) { const a = v instanceof Float64Array ? v : Float64Array.from(v); this.parts.push(Buffer.from(a.buffer, a.byteOffset, a.byteLength)); return this; }
    f32s(v: Float32Array) { this.parts.push(Buffer.from(v.buffer, v.byteOffset, v.byteLength)); return this; }
    str(v: string) { const b = Buffer.from(v, 'utf8'); return this.u32(b.length).raw(b); }
    u32s(v: ArrayLike<number>) { const a = v instanceof Uint32Array ? v : Uint32Array.from(v); this.parts.push(Buffer.from(a.buffer, a.byteOffset, a.byteLength)); return this; }
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
export interface NativeLatticeJob { f: NativeLatticeFrame; image: string; mask?: string; /** The holes sent to the image model (facade-lattice.ts photoLattice reads them as uncovered). */ inpainted?: string; fitted?: readonly Rect4[]; bays?: readonly Rect4[]; recessM?: number; rectsPx?: readonly Rect4[] }
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
    const w = new Writer().magic('SBLF').u32(2).u32(params.length).f64s(params).u32((opts.photoRecess ? 1 : 0) | (opts.whole ? 2 : 0));
    w.u32(soup.length).f32s(soup).u32(rawSoup ? 1 : 0).u32(rawSoup?.length ?? 0);
    if (rawSoup) w.f32s(rawSoup);
    w.u32(jobs.length);
    for (const j of jobs) {
        frame(w, j.f).str(j.image).str(j.mask ?? '').str(j.inpainted ?? '');
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
export function runNativeLatticeAudit(params: number[], sameFacing: boolean, soup: Float32Array, facades: NativeAuditFacade[], threads: number): { claim: Int32Array; found: number; restored: number; left: number; obliqueLeft: number; oblique?: number; keptInFront: number; restoredInFront: number; dropped: number[] } {
    const w = new Writer().magic('SBLA').u32(2).u32(params.length).f64s(params).u32(sameFacing ? 1 : 0).u32(soup.length).f32s(soup).u32(facades.length);
    for (const x of facades) {
        if (x.built.length !== (x.s.length - 1) * (x.t.length - 1)) throw new Error(`facade ${x.f.facadeId}: its built cells do not match its lattice`);
        frame(w, x.f).u32(x.s.length).f64s(x.s).u32(x.t.length).f64s(x.t).raw(x.built).u32(x.positions.length).f32s(x.positions).u32(x.indices.length).raw(new Uint8Array(x.indices.buffer, x.indices.byteOffset, x.indices.byteLength));
    }
    const r = new Reader(runSync('lattice-audit', w.take(), threads));
    const claim = r.i32s(r.u32()), found = r.f64(), restored = r.f64(), left = r.f64(), obliqueLeft = r.f64(), hasOblique = r.u32(), oblique = r.f64(), keptInFront = r.f64(), restoredInFront = r.f64();
    const dropped = Array.from(r.i32s(r.u32()));
    r.done('lattice-audit');
    return { claim, found, restored, left, obliqueLeft, ...(hasOblique ? { oblique } : {}), keptInFront, restoredInFront, dropped };
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

// ------------------------------------------------------------------------------------------------ the cut

/** A rebuilt facade for the native cut: its frame, lattice lines and rebuilt cells. */
export interface NativeCutFacade { facadeId: number; centroid: number[]; normal: number[]; axisS: number[]; axisT: number[]; s: number[]; t: number[]; built: Uint8Array }
/** A scan primitive for the native cut (lattice-stitch.ts readPrims): every attribute after POSITION with its width and kind, as doubles. */
export interface NativeCutPrim { comps: number[]; flags: boolean[]; normals: boolean[]; pos: ArrayLike<number>; attr: ArrayLike<number>[]; I: ArrayLike<number> }
/** A primitive's cut: the triangles cut (their first index slots) and its kept pieces welded (appendPieces' vertices and triangles). */
export interface NativeCutOut { cut: Uint32Array; verts: number; arrays: Float32Array[]; min: number[]; max: number[]; tris: Uint32Array }

/** lattice-stitch.ts cutScanToLattice's geometry natively, per primitive, and its report. */
export function runNativeCut(params: number[], facades: NativeCutFacade[], prims: NativeCutPrim[], threads: number): { report: { cutTriangles: number; removedPieces: number; keptPieces: number }; prims: NativeCutOut[] } {
    const w = new Writer().magic('SBCT').u32(1).u32(params.length).f64s(params).u32(facades.length);
    for (const f of facades) {
        if (f.built.length !== (f.s.length - 1) * (f.t.length - 1)) throw new Error(`facade ${f.facadeId}: its built cells do not match its lattice`);
        w.i32(f.facadeId).f64s([...f.centroid, ...f.normal, ...f.axisS, ...f.axisT]).u32(f.s.length).f64s(f.s).u32(f.t.length).f64s(f.t).raw(f.built);
    }
    writeCutPrims(w, prims);
    const r = new Reader(runSync('cut', w.take(), threads));
    const report = { cutTriangles: r.f64(), removedPieces: r.f64(), keptPieces: r.f64() };
    const out = readCutOuts(r, prims);
    r.done('cut');
    return { report, prims: out };
}

function writeCutPrims(w: Writer, prims: NativeCutPrim[]): void {
    w.u32(prims.length);
    for (const p of prims) {
        w.u32(p.comps.length);
        p.comps.forEach((c, k) => w.i32(c).u32(p.flags[k] ? 1 : 0).u32(p.normals[k] ? 1 : 0));
        const n = p.pos.length / 3;
        w.u32(n).f64s(p.pos);
        p.attr.forEach((a, k) => { if (a.length !== n * p.comps[k]) throw new Error('a cut primitive\'s attribute does not match its positions'); w.f64s(a); });
        w.u32(p.I.length).u32s(p.I);
    }
}

function readCutOuts(r: Reader, prims: NativeCutPrim[]): NativeCutOut[] {
    return prims.map((p): NativeCutOut => {
        const cut = r.u32s(r.u32()), verts = r.u32();
        const arrays = [r.f32s(verts * 3), ...p.comps.map(c => r.f32s(verts * c))];
        const min = Array.from(r.f64s(3)), max = Array.from(r.f64s(3));
        return { cut, verts, arrays, min, max, tris: r.u32s(r.u32()) };
    });
}

/**
 * lattice-stitch.ts clipToFootprint's geometry natively, per primitive: the outline lines (a point and the outward normal
 * in plan, as the TypeScript works them out), the footprint's loops and the margin; its report (the area unrounded).
 */
export function runNativeClip(marginM: number, loops: Vec2[][], lines: Array<{ ax: number; az: number; nx: number; nz: number }>, prims: NativeCutPrim[], threads: number): { report: { cutTriangles: number; removedTriangles: number; removedAreaM2: number }; prims: NativeCutOut[] } {
    const w = new Writer().magic('SBCL').u32(1).f64s([marginM]).u32(loops.length);
    for (const loop of loops) w.u32(loop.length).f64s(loop.flatMap(p => [p[0], p[1]]));
    w.u32(lines.length).f64s(lines.flatMap(l => [l.ax, l.az, l.nx, l.nz]));
    writeCutPrims(w, prims);
    const r = new Reader(runSync('clip', w.take(), threads));
    const report = { cutTriangles: r.f64(), removedTriangles: r.f64(), removedAreaM2: r.f64() };
    const out = readCutOuts(r, prims);
    r.done('clip');
    return { report, prims: out };
}

/** A constrained Delaunay triangulation (scratchbox_cdt.hpp through `cdt`): directed segments, a fill rule, optional refinement. */
export function runNativeCdt(points: ReadonlyArray<readonly [number, number]>, segments: ReadonlyArray<readonly [number, number]>, opts: { fill?: 'even-odd' | 'non-zero' | 'positive'; refine?: boolean; minAngleDeg?: number; maxArea?: number; splitSegments?: boolean } = {}): { report: Record<string, number>; points: Array<[number, number]>; tris: Array<[number, number, number]>; winding: number[] } {
    const fill = opts.fill === 'non-zero' ? 1 : opts.fill === 'positive' ? 2 : 0;
    const w = new Writer().magic('SBDT').u32(1).u32(fill).u32(opts.refine ? 1 : 0).f64s([opts.minAngleDeg ?? 20, opts.maxArea ?? 0]).u32(opts.splitSegments === false ? 0 : 1);
    w.u32(points.length).f64s(points.flatMap(p => [p[0], p[1]])).u32(segments.length);
    const sb = Buffer.alloc(segments.length * 8);
    segments.forEach((sg, i) => { sb.writeInt32LE(sg[0], i * 8); sb.writeInt32LE(sg[1], i * 8 + 4); });
    w.raw(sb);
    const r = new Reader(runSync('cdt', w.take(), 1));
    const report = JSON.parse(r.str()) as Record<string, number>;
    const pts = Array.from({ length: r.u32() }, () => [r.f64(), r.f64()] as [number, number]);
    const n = r.u32();
    const tris = Array.from({ length: n }, () => [r.i32(), r.i32(), r.i32()] as [number, number, number]);
    const winding = Array.from({ length: n }, () => r.i32());
    r.done('cdt');
    return { report, points: pts, tris, winding };
}

// ------------------------------------------------------------------------------------------------ the stitch

/** A rebuilt facade for the native stitch: its frame, lattice lines, rebuilt cells and their depths, row by row. */
export interface NativeStitchFacade extends NativeCutFacade { depth: number[] }

/** lattice-stitch.ts stitchLattice's geometry natively: its report, the cells left unjoined per facade, and the strips' and zips' triangles. */
export function runNativeStitch(params: number[], facades: NativeStitchFacade[], prims: NativeFillPrim[], threads: number): { report: { segments: number; stitched: number; stripTriangles: number; cornersZipped: number; why: Record<string, number>; unjoined: number }; unjoinedCells: Map<number, Array<[number, number]>>; out: number[][][] } {
    const w = new Writer().magic('SBST').u32(1).u32(params.length).f64s(params).u32(facades.length);
    for (const f of facades) {
        const cells = (f.s.length - 1) * (f.t.length - 1);
        if (f.built.length !== cells || f.depth.length !== cells) throw new Error(`facade ${f.facadeId}: its built cells or depths do not match its lattice`);
        w.i32(f.facadeId).f64s([...f.centroid, ...f.normal, ...f.axisS, ...f.axisT]).u32(f.s.length).f64s(f.s).u32(f.t.length).f64s(f.t).f64s(f.depth).raw(f.built);
    }
    w.u32(prims.length);
    for (const p of prims) w.i32(p.wall).u32(p.X.length / 3).f64s(p.X).u32(p.I ? 1 : 0).u32(p.I ? p.I.length : 0).u32s(p.I ?? []);
    const r = new Reader(runSync('stitch', w.take(), threads));
    const segments = r.f64(), stitched = r.f64(), stripTriangles = r.f64(), cornersZipped = r.f64(), unjoined = r.f64();
    const why: Record<string, number> = {};
    for (let n = r.u32(); n > 0; n--) { const k = r.str(); why[k] = r.f64(); }
    const unjoinedCells = new Map<number, Array<[number, number]>>();
    for (let n = r.u32(); n > 0; n--) { const id = r.i32(); unjoinedCells.set(id, Array.from({ length: r.u32() }, () => [r.i32(), r.i32()] as [number, number])); }
    const out = Array.from({ length: r.u32() }, () => [Array.from(r.f64s(3)), Array.from(r.f64s(3)), Array.from(r.f64s(3))]);
    r.done('stitch');
    return { report: { segments, stitched, stripTriangles, cornersZipped, why, unjoined }, unjoinedCells, out };
}

// ------------------------------------------------------------------------------------------------ the wall sheets

/** A sheet for the native wall sheets: its size and texel, and its members in the sheet's order with their files and maps from its pixels. */
export interface NativeSheetJob { width: number; height: number; pixel: number; members: Array<{ image: string; uncovered?: string; occluded?: string; o: number[]; dx: number[]; dy: number[] }> }
/** A sheet's photo and masks as PNG scanlines (png-encode.ts encodePngFiltered), and what was filled. */
export interface NativeSheetOut { holes: number; wallCoverage: number; wallAreaM2: number; fromRepeats: number; fromStoreys: number; smooth: number; image: Uint8Array; mask: Uint8Array; occluded?: Uint8Array }

/** wall-sheets.ts buildWallSheets' pixel work natively: each sheet's mosaic, its holes filled, its images' scanlines. */
export function runNativeWallSheets(params: number[], sheets: NativeSheetJob[], threads: number): NativeSheetOut[] {
    const w = new Writer().magic('SBWS').u32(1).u32(params.length).f64s(params).u32(sheets.length);
    for (const sh of sheets) {
        w.u32(sh.width).u32(sh.height).f64s([sh.pixel]).u32(sh.members.length);
        for (const m of sh.members) w.str(m.image).str(m.uncovered ?? '').str(m.occluded ?? '').f64s([m.o[0], m.o[1], m.dx[0], m.dx[1], m.dy[0], m.dy[1]]);
    }
    const r = new Reader(runSync('wall-sheets', w.take(), threads));
    const out = sheets.map((): NativeSheetOut => {
        const holes = r.f64(), wallCoverage = r.f64(), wallAreaM2 = r.f64(), fromRepeats = r.f64(), fromStoreys = r.f64(), smooth = r.f64(), anyOccluded = r.u32();
        const image = r.u8s(r.u32()), mask = r.u8s(r.u32()), occluded = r.u8s(r.u32());
        return { holes, wallCoverage, wallAreaM2, fromRepeats, fromStoreys, smooth, image, mask, ...(anyOccluded ? { occluded } : {}) };
    });
    r.done('wall-sheets');
    return out;
}

// ------------------------------------------------------------------------------------------------ the fill's texturing

/** A rebuilt facade's photo mapping for the native texturing (lattice-stitch.ts wallMaps). */
export interface NativeWallMap { material: number; U: number[]; u0: number; V: number[]; v0: number; n: number[]; dLo: number; dHi: number; pu?: number; pv?: number }
/** A textured primitive of the twin: its material, positions, UVs and indices. */
export interface NativeTexPrim { material: number; X: ArrayLike<number>; UV: ArrayLike<number>; I: ArrayLike<number> }
/** A generated piece: its triangle, corners and their weights in it, and how many pieces that triangle was cut into. */
export interface NativeFillPiece2 { parent: number; p: number[][]; w: number[][]; of: number }

/**
 * lattice-stitch.ts appendTexturedTriangles' routes natively: whether the twin has a textured triangle at all, the facade
 * materials continued pieces asked to repeat (in the order they asked), and per piece kept its corners and route (0 clay,
 * 1 the facade's own photo, 2 the photo at its triangle's corners, 3 continued) with its material, UVs and confidence.
 */
export function runNativeFillTexture(params: number[], walls: NativeWallMap[], prims: NativeTexPrim[], tris: number[][][], pieces: NativeFillPiece2[] | undefined, threads: number): { textured: boolean; repeatOrder: number[]; parts: Array<{ parent: number; p: number[][]; route: number; material: number; uv: number[][]; confidence: number }> } {
    const w = new Writer().magic('SBFT').u32(1).u32(params.length).f64s(params).u32(walls.length);
    for (const m of walls) w.i32(m.material).f64s([...m.U, m.u0, ...m.V, m.v0, ...m.n, m.dLo, m.dHi]).u32(m.pu !== undefined ? 1 : 0).f64s([m.pu ?? 0]).u32(m.pv !== undefined ? 1 : 0).f64s([m.pv ?? 0]);
    w.u32(prims.length);
    for (const p of prims) {
        const n = p.X.length / 3;
        if (p.UV.length !== n * 2) throw new Error("a textured primitive's UVs do not match its positions");
        w.i32(p.material).u32(n).f64s(p.X).f64s(p.UV).u32(p.I.length).u32s(p.I);
    }
    const corners = new Float64Array(tris.length * 9);
    tris.forEach((t, i) => { for (let k = 0; k < 3; k++) for (let c = 0; c < 3; c++) corners[i * 9 + k * 3 + c] = t[k][c]; });
    w.u32(tris.length).f64s(corners);
    w.u32(pieces ? 1 : 0).u32(pieces?.length ?? 0);
    for (const q of pieces ?? []) w.i32(q.parent).i32(q.of).f64s([...q.p[0], ...q.p[1], ...q.p[2], ...q.w[0], ...q.w[1], ...q.w[2]]);
    const r = new Reader(runSync('fill-texture', w.take(), threads));
    if (!r.u32()) { r.done('fill-texture'); return { textured: false, repeatOrder: [], parts: [] }; }
    const repeatOrder = Array.from(r.i32s(r.u32()));
    const parts = Array.from({ length: r.u32() }, () => {
        const parent = r.i32(), p = [Array.from(r.f64s(3)), Array.from(r.f64s(3)), Array.from(r.f64s(3))], route = r.i32(), material = r.i32();
        const uv = [Array.from(r.f64s(2)), Array.from(r.f64s(2)), Array.from(r.f64s(2))];
        return { parent, p, route, material, uv, confidence: r.f64() };
    });
    r.done('fill-texture');
    return { textured: true, repeatOrder, parts };
}

// ------------------------------------------------------------------------------------------------ the inner core

/** pipeline-k/inner-core.ts's solid natively (scratchbox_inner_core.hpp): its report, closed surface and each triangle's photo source. */
export function runNativeInnerCore(params: number[], soup: Float32Array, kind: Uint8Array, footprint: Vec2[][], groundY: number | undefined, regions: Array<{ c: number[]; r: number }>, threads: number, queries?: { points: ArrayLike<number>; only: boolean }): { report: Record<string, unknown>; positions: Float64Array; indices: Uint32Array; source: Int32Array; route: Uint8Array; winding: Float64Array } {
    const w = new Writer().magic('SBIC').u32(1).u32(params.length).f64s(params).u32(soup.length).f32s(soup).raw(kind).u32(footprint.length);
    for (const loop of footprint) w.u32(loop.length).f64s(loop.flatMap(p => [p[0], p[1]]));
    w.f64s([groundY ?? Number.NaN]).u32(regions.length).f64s(regions.flatMap(g => [g.c[0], g.c[1], g.c[2], g.r]));
    w.u32(queries?.only ? 1 : 0).u32((queries?.points.length ?? 0) / 3).f64s(queries?.points ?? []);
    const r = new Reader(runSync('inner-core', w.take(), threads));
    const report = JSON.parse(r.str()) as Record<string, unknown>;
    const positions = r.f64s(r.u32()), indices = r.u32s(r.u32());
    const n = indices.length / 3, source = new Int32Array(n), route = new Uint8Array(n);
    for (let t = 0; t < n; t++) { source[t] = r.i32(); route[t] = r.u8s(1)[0]; }
    const winding = r.f64s(r.u32());
    r.done('inner-core');
    return { report, positions, indices, source, route, winding };
}
