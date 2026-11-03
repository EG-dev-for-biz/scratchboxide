/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The roof cast-shadow lift's hot kernels in C++ (scratchbox_roof_shadow.hpp behind scripts/roof_shadow_native.cpp, built
 * through the native build cache), opt-in: nothing in the pipeline calls these yet. Each wrapper returns what the
 * TypeScript it replaces computes (roof-shadow.ts, roof-shadow/9), to the bit:
 *   - shadowMapNative: shadowMap;
 *   - shadowedBitsNative: shadowedAt of many points under several suns' maps (steps 5, 6, the lit levels and the audit);
 *   - sunSearchNative: step 3, the coarse and refined sun search over every deck, in one process call (the run's cost:
 *     on a 700k-triangle scene, 152 maps of 30 ms each, against 0.1 s for the cells and 0.2 s for the lift);
 *   - liftRoofShadowsNative: step 7, the lift's texel pass; the gain itself (Math.pow, the sRGB curve) is applied here, in V8.
 * Sun frames, tan(elevation) and the log tables are computed here with the TypeScript's own expressions and handed to the
 * kernel, and the kernel returns sums rather than exponentials, so no libm call in C++ stands in for one of V8's.
 * A failed build or run throws RoofShadowNativeError; there is no fallback.
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { compileNativeCached, defaultNativeFlags, NativeBuildError } from '../../../native-build-cache';
import { SRGB8_TO_LINEAR, linearToSrgb255 } from '../../../../../common/spatial/photogrammetric-delight';
import type { RgbaImage8 } from '../../tile-texture-transfer';
import type { Soup } from '../view-relight';
import type { Occluders, RoofShadowParams, ShadowMap } from '../roof-shadow';

export type RoofShadowNativeErrorCode = 'build_failed' | 'run_failed' | 'invalid_output';

export class RoofShadowNativeError extends Error {
    constructor(public readonly code: RoofShadowNativeErrorCode, message: string) {
        super(message);
        this.name = 'RoofShadowNativeError';
    }
}

/** Roof cells as roofShadowLift holds them: photo, 3D point, log linear colour. */
export interface RoofCells { n: number; img: Int32Array; p: Float32Array; c: Float32Array }
export interface RoofShadowCandidate { az: number; el: number }
/** A sun scored on a plane (roofShadowLift's Scored). */
export type RoofShadowScored = RoofShadowCandidate & { share: number; ratio: number; rgb: [number, number, number]; halves: [number, number] };

export interface RoofShadowNativeOptions {
    /** Worker threads (default: every core). */
    threads?: number;
    /** Longest a run may take, not counting a first-use build (default 600 s). */
    timeoutMs?: number;
    /** Where scripts/roof_shadow_native.cpp and the engine headers live (default: discovered). */
    repoRoot?: string;
}

const CLI_SOURCE = path.join('scripts', 'roof_shadow_native.cpp');
const INCLUDE_DIR = path.join('packages', 'core', 'src', 'native', '3d-engine', 'include');
const REQUEST_MAGIC = 0x51485352, RESULT_MAGIC = 0x52485352, VERSION = 1;
const MODE_MAP = 1, MODE_BITS = 2, MODE_SEARCH = 3, MODE_LIFT = 4;
const DEG = Math.PI / 180;

/** The checkout holding scripts/roof_shadow_native.cpp, from this file or the working directory up. */
export function findRoofShadowRepoRoot(): string {
    for (const start of [__dirname, process.cwd()]) {
        for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
            if (fs.existsSync(path.join(dir, CLI_SOURCE))) return dir;
            if (path.dirname(dir) === dir) break;
        }
    }
    throw new RoofShadowNativeError('build_failed', `cannot find ${CLI_SOURCE} above ${__dirname} or ${process.cwd()}`);
}

let building: Promise<string> | undefined;

/** Builds the driver through the native build cache when its sources changed; returns the cached binary. */
export function ensureRoofShadowNativeBinary(repoRoot?: string): Promise<string> {
    if (process.env.SCRATCHBOX_ROOF_SHADOW_NATIVE_BIN) return Promise.resolve(process.env.SCRATCHBOX_ROOF_SHADOW_NATIVE_BIN);
    if (building) return building;
    building = (async () => {
        const root = repoRoot ?? findRoofShadowRepoRoot();
        try {
            const built = await compileNativeCached({ sourcePath: path.join(root, CLI_SOURCE), includeDirs: [path.join(root, INCLUDE_DIR)], flags: defaultNativeFlags(), name: 'roof_shadow_native', timeoutMs: 300_000 });
            return built.binaryPath;
        } catch (err) {
            throw new RoofShadowNativeError('build_failed', `could not build roof_shadow_native: ${err instanceof NativeBuildError ? err.compilerOutput.slice(-1500) : String(err)}`);
        }
    })().finally(() => { building = undefined; });
    return building;
}

/** A growing little-endian buffer. */
class Out {
    private buf = new Uint8Array(1 << 16);
    private dv = new DataView(this.buf.buffer);
    private at = 0;
    private room(n: number) {
        if (this.at + n <= this.buf.length) return;
        let size = this.buf.length;
        while (size < this.at + n) size *= 2;
        const next = new Uint8Array(size);
        next.set(this.buf.subarray(0, this.at));
        this.buf = next; this.dv = new DataView(next.buffer);
    }
    u32(v: number) { this.room(4); this.dv.setUint32(this.at, v, true); this.at += 4; }
    i32(v: number) { this.room(4); this.dv.setInt32(this.at, v, true); this.at += 4; }
    f64(v: number) { this.room(8); this.dv.setFloat64(this.at, v, true); this.at += 8; }
    bytes(b: Uint8Array) { this.room(b.length); this.buf.set(b, this.at); this.at += b.length; }
    f32s(a: Float32Array) { this.bytes(new Uint8Array(a.buffer, a.byteOffset, a.byteLength)); }
    i32s(a: Int32Array) { this.bytes(new Uint8Array(a.buffer, a.byteOffset, a.byteLength)); }
    sun(d: SunFrame) { for (const v of [...d.s, ...d.r, ...d.u, d.tanEl]) this.f64(v); }
    done(): Uint8Array { return this.buf.subarray(0, this.at); }
}

/** A little-endian reader over a result. */
class In {
    private readonly dv: DataView;
    at = 0;
    constructor(readonly buf: Uint8Array) { this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength); }
    private need(n: number) { if (this.at + n > this.buf.length) throw new RoofShadowNativeError('invalid_output', 'roof_shadow_native result is truncated'); }
    u32() { this.need(4); const v = this.dv.getUint32(this.at, true); this.at += 4; return v; }
    i32() { this.need(4); const v = this.dv.getInt32(this.at, true); this.at += 4; return v; }
    f64() { this.need(8); const v = this.dv.getFloat64(this.at, true); this.at += 8; return v; }
    bytes(n: number) { this.need(n); const v = this.buf.slice(this.at, this.at + n); this.at += n; return v; }
    f32s(n: number) { this.need(n * 4); const v = new Float32Array(n); new Uint8Array(v.buffer).set(this.buf.subarray(this.at, this.at + n * 4)); this.at += n * 4; return v; }
}

/** A sun's frame, by roof-shadow.ts's own expressions (sunDir and the axes shadowMap builds). */
interface SunFrame { s: number[]; r: number[]; u: number[]; tanEl: number }
function sunFrame(azDeg: number, elDeg: number): SunFrame {
    const s = [Math.cos(elDeg * DEG) * Math.cos(azDeg * DEG), Math.sin(elDeg * DEG), Math.cos(elDeg * DEG) * Math.sin(azDeg * DEG)];
    const r0 = [-s[2], 0, s[0]], rl = Math.hypot(r0[0], r0[2]) || 1;
    const r = [r0[0] / rl, 0, r0[2] / rl];
    const u = [s[1] * r[2] - s[2] * r[1], s[2] * r[0] - s[0] * r[2], s[0] * r[1] - s[1] * r[0]];
    return { s, r, u, tanEl: Math.max(0.1, Math.tan(elDeg * DEG)) };
}

function header(mode: number, threads: number | undefined): Out {
    const o = new Out();
    o.u32(REQUEST_MAGIC); o.u32(VERSION); o.u32(mode); o.u32(threads ?? 0);
    return o;
}

function occluders(o: Out, occ: Occluders) {
    if (occ.P.length < occ.n * 9) throw new RoofShadowNativeError('run_failed', `occluders hold ${occ.P.length} floats for ${occ.n} triangles`);
    o.u32(occ.n); o.f32s(occ.P.subarray(0, occ.n * 9));
}

/** Runs one request; returns the result past its header. */
async function run(mode: number, request: Uint8Array, opts: RoofShadowNativeOptions): Promise<In> {
    const bin = await ensureRoofShadowNativeBinary(opts.repoRoot);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roof-shadow-native-'));
    const reqPath = path.join(dir, 'request.bin'), resPath = path.join(dir, 'result.bin');
    try {
        fs.writeFileSync(reqPath, request);
        await new Promise<void>((resolve, reject) => {
            execFile(bin, [reqPath, resPath], { timeout: opts.timeoutMs ?? 600_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, _stdout, stderr) => {
                if (err) reject(new RoofShadowNativeError('run_failed', `roof_shadow_native failed: ${String(stderr || err.message).trim().slice(-1500)}`));
                else resolve();
            });
        });
        if (!fs.existsSync(resPath)) throw new RoofShadowNativeError('invalid_output', 'roof_shadow_native exited 0 but wrote no result');
        const res = new In(new Uint8Array(fs.readFileSync(resPath)));
        if (res.u32() !== RESULT_MAGIC || res.u32() !== VERSION || res.u32() !== mode) throw new RoofShadowNativeError('invalid_output', 'roof_shadow_native wrote a result of another kind');
        return res;
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

function finished(res: In) {
    if (res.at !== res.buf.length) throw new RoofShadowNativeError('invalid_output', `roof_shadow_native result has ${res.buf.length - res.at} trailing bytes`);
}

/** shadowMap in C++: the same map, pixel for pixel. */
export async function shadowMapNative(soup: Occluders, azDeg: number, elDeg: number, mpp: number, opts: RoofShadowNativeOptions = {}): Promise<ShadowMap> {
    const f = sunFrame(azDeg, elDeg);
    const o = header(MODE_MAP, opts.threads);
    occluders(o, soup); o.sun(f); o.f64(mpp);
    const res = await run(MODE_MAP, o.done(), opts);
    const W = res.i32(), H = res.i32(), X0 = res.f64(), Y1 = res.f64(), top = res.f32s(W * H);
    finished(res);
    return { s: f.s, r: f.r, u: f.u, X0, Y1, W, H, mpp, slope: mpp / Math.max(0.1, Math.tan(elDeg * DEG)), top };
}

/** shadowedAt(shadowMap(soup, sun, mpp), point, biasM) for every point (three floats each) under each sun: one byte a point. */
export async function shadowedBitsNative(soup: Occluders, suns: RoofShadowCandidate[], mpp: number, points: Float32Array, biasM: number, opts: RoofShadowNativeOptions = {}): Promise<Uint8Array[]> {
    const np = Math.floor(points.length / 3);
    const o = header(MODE_BITS, opts.threads);
    occluders(o, soup); o.f64(mpp); o.f64(biasM);
    o.u32(suns.length); for (const s of suns) o.sun(sunFrame(s.az, s.el));
    o.u32(np); o.f32s(points.subarray(0, np * 3));
    const res = await run(MODE_BITS, o.done(), opts);
    const out = suns.map(() => res.bytes(np));
    finished(res);
    return out;
}

/** planeScore's tail, from the kernel's sums: n[2], sum[2][4], hs[2][2], hn[2][2]. */
function scoreOf(q: number[]): { share: number; ratio: number; rgb: [number, number, number]; halves: [number, number] } {
    const n = [q[0], q[1]], sum = [q.slice(2, 6), q.slice(6, 10)], hs = [q.slice(10, 12), q.slice(12, 14)], hn = [q.slice(14, 16), q.slice(16, 18)];
    const share = n[1] / Math.max(1, n[0] + n[1]);
    if (!n[0] || !n[1]) return { share, ratio: 0, rgb: [1, 1, 1], halves: [0, 0] };
    const step = (k: number) => Math.exp(sum[0][k] / n[0] - sum[1][k] / n[1]);
    const half = (h: number) => (hn[h][0] && hn[h][1] ? Math.exp(hs[h][0] / hn[h][0] - hs[h][1] / hn[h][1]) : 0);
    return { share, ratio: step(3), rgb: [step(0), step(1), step(2)], halves: [half(0), half(1)] };
}

export interface SunSearchNativeResult {
    /** Per plane, its scored suns in roofShadowLift's push order (every coarse sun, then its best one's neighbours). */
    scored: RoofShadowScored[][];
    /** Per plane, the median ratio of its valid coarse suns (computed, as in roofShadowLift, before the refinement). */
    medians: number[];
    /** Every roof cell's shadow under each coarse sun. */
    coarseBits: Array<{ cand: RoofShadowCandidate; bits: Uint8Array }>;
    /** Suns mapped: coarse plus refined. */
    candidates: number;
}

/**
 * roofShadowLift's step 3 in one call: the coarse suns scored on every plane, each plane's best valid one refined. The
 * kernel picks the refinement centre by the log ratio; should exp ever collapse two logs into one ratio so that V8's
 * first-of-the-highest differs, the search is run again with V8's centres forced, so the result is always roofShadowLift's.
 */
export async function sunSearchNative(occ: Occluders, cells: RoofCells, planes: Array<{ y: number; idx: Int32Array }>, P: RoofShadowParams, opts: RoofShadowNativeOptions = {}): Promise<SunSearchNativeResult> {
    const coarse: RoofShadowCandidate[] = [];
    for (const el of P.coarseElDeg) for (let az = 0; az < 360; az += P.coarseAzDeg) coarse.push({ az, el });
    const neighbours = coarse.map(best => {
        const list: RoofShadowCandidate[] = [];
        for (let da = -P.refineSteps; da <= P.refineSteps; da++) for (let de = -P.refineSteps; de <= P.refineSteps; de++) {
            const el = best.el + de * P.refineDeg;
            if ((da || de) && el >= 5 && el <= 85) list.push({ az: (best.az + da * P.refineDeg + 360) % 360, el });
        }
        return list;
    });
    const valid = (s: RoofShadowScored) => s.share >= P.minShare && s.share <= P.maxShare && s.ratio > 0;
    const request = (forced: number[]) => {
        const o = header(MODE_SEARCH, opts.threads);
        occluders(o, occ);
        o.u32(cells.n); o.f32s(cells.p.subarray(0, cells.n * 3)); o.f32s(cells.c.subarray(0, cells.n * 3));
        o.u32(planes.length); for (const pl of planes) { o.u32(pl.idx.length); o.i32s(pl.idx); }
        for (const v of [P.coarseMapM, P.biasM, P.halfBlockM, P.minShare, P.maxShare]) o.f64(v);
        o.u32(coarse.length); for (const c of coarse) o.sun(sunFrame(c.az, c.el));
        for (const list of neighbours) { o.u32(list.length); for (const c of list) o.sun(sunFrame(c.az, c.el)); }
        for (const f of forced) o.i32(f);
        return o.done();
    };
    const once = async (forced: number[]) => {
        const res = await run(MODE_SEARCH, request(forced), opts);
        const candidates = res.u32();
        const centre = planes.map(() => res.i32());
        const scored: RoofShadowScored[][] = [];
        for (let k = 0; k < planes.length; k++) {
            const m = res.u32(), list: RoofShadowScored[] = [];
            for (let e = 0; e < m; e++) {
                const c = res.i32(), j = res.i32(), q: number[] = [];
                for (let s = 0; s < 18; s++) q.push(res.f64());
                // the first coarse.length entries are the coarse suns in order, the rest the centre's neighbours
                if (e < coarse.length ? c !== e || j !== -1 : c !== centre[k] || j < 0 || j >= neighbours[c].length) throw new RoofShadowNativeError('invalid_output', 'roof_shadow_native listed its suns out of order');
                list.push({ ...(j < 0 ? coarse[c] : neighbours[c][j]), ...scoreOf(q) });
            }
            scored.push(list);
        }
        const coarseBits = coarse.map(cand => ({ cand, bits: res.bytes(cells.n) }));
        finished(res);
        return { candidates, centre, scored, coarseBits };
    };
    let r = await once(planes.map(() => -1));
    // V8's centre: the first of the highest ratio among the valid coarse suns (roofShadowLift's reduce)
    const centres = planes.map((_, k) => {
        let best = -1;
        for (let c = 0; c < coarse.length; c++) { const s = r.scored[k][c]; if (valid(s) && (best < 0 || s.ratio > r.scored[k][best].ratio)) best = c; }
        return best;
    });
    if (centres.some((c, k) => c !== r.centre[k])) r = await once(centres);
    const medians = r.scored.map(list => {
        const v = list.slice(0, coarse.length).filter(valid).map(s => s.ratio).sort((a, b) => a - b);
        return v.length ? v[Math.floor(v.length / 2)] : 0;
    });
    return { scored: r.scored, medians, coarseBits: r.coarseBits, candidates: r.candidates };
}

/** What roofShadowLift's step 7 reads, resolved from its maps. */
export interface RoofShadowLiftPass {
    soup: Soup;
    /** The occluders (the twin first, as occludersOf builds them). */
    occ: Occluders;
    photos: Map<number, RgbaImage8>;
    surfaces: Map<number, Uint8Array>;
    /** bySun's suns, in its order. */
    suns: RoofShadowCandidate[];
    /** photoSun: each photo's sun (an index into `suns`), its ratio and its deck (-1: fitted on its own terraces). */
    photoSun: Map<number, { sun: number; ratio: number[]; k: number }>;
    /** liftTerrace (`${img}:${bin}`), each with its lit level: litLevel.get(key) ?? sunLit.get(its sun), undefined when neither. */
    liftTerrace: Map<string, number | undefined>;
    /** compSun's terraces across photos: sun (an index into `suns`), ratio, lit level. */
    comps: Array<{ sun: number; ratio: number[]; lit: number }>;
    /** Every grid key (`${bin}:${gx}:${gz}`) whose terrace is in compSun, to its index in `comps` (compOfKey). */
    compCells: Map<string, number>;
    /** compSun.size > 0. */
    hasComp: boolean;
}

export interface RoofShadowLiftPassResult {
    /** The photos the lift changed (new arrays; `photos` is not touched). */
    changed: Map<number, Uint8Array>;
    texelsLifted: number;
    /** Texels lifted per deck index (planeLifted). */
    planeLifted: Map<number, number>;
}

/** roofShadowLift's step 7: the same texels lifted by the same gains, in the same order. */
export async function liftRoofShadowsNative(pass: RoofShadowLiftPass, P: RoofShadowParams, opts: RoofShadowNativeOptions = {}): Promise<RoofShadowLiftPassResult> {
    const { soup } = pass;
    const logFull = (ratio: number[]) => Math.log(0.2126 * ratio[0] + 0.7152 * ratio[1] + 0.0722 * ratio[2]);
    const o = header(MODE_LIFT, opts.threads);
    occluders(o, pass.occ);
    o.u32(soup.n); o.f32s(soup.UV.subarray(0, soup.n * 6)); o.i32s(soup.img.subarray(0, soup.n));
    const ny = new Float32Array(soup.n);
    for (let t = 0; t < soup.n; t++) ny[t] = soup.N[t * 3 + 1];
    o.f32s(ny);
    o.sun(sunFrame(0, 89.9));
    for (const v of [P.aboveMapM, P.fineMapM, P.biasM, P.flatNy, P.terraceBinM, P.componentGridM]) o.f64(v);
    for (let v = 0; v < 256; v++) o.f64(Math.log(1e-4 + SRGB8_TO_LINEAR[v]));
    const ids = [...pass.photos.keys()].filter(im => pass.surfaces.has(im));
    o.u32(ids.length);
    for (const im of ids) {
        const ph = pass.photos.get(im)!, mask = pass.surfaces.get(im)!;
        if (ph.rgba.length !== ph.width * ph.height * 4 || mask.length !== ph.width * ph.height) throw new RoofShadowNativeError('run_failed', `photo ${im}: its texels or mask do not match ${ph.width} x ${ph.height}`);
        o.i32(im); o.u32(ph.width); o.u32(ph.height); o.bytes(ph.rgba);
        // the kernel skips texels whose class is 0, TEXEL_NONE
        o.bytes(mask);
    }
    o.u32(pass.suns.length); for (const s of pass.suns) o.sun(sunFrame(s.az, s.el));
    o.u32(pass.photoSun.size); for (const [im, s] of pass.photoSun) { o.i32(im); o.i32(s.sun); o.f64(logFull(s.ratio)); }
    o.u32(pass.liftTerrace.size);
    for (const [key, lit] of pass.liftTerrace) { const [im, bin] = key.split(':').map(Number); o.i32(im); o.i32(bin); o.f64(lit ?? NaN); }
    o.u32(pass.hasComp ? 1 : 0);
    o.u32(pass.comps.length); for (const c of pass.comps) { o.i32(c.sun); o.f64(logFull(c.ratio)); o.f64(c.lit); }
    o.u32(pass.compCells.size);
    for (const [key, comp] of pass.compCells) { const [bin, gx, gz] = key.split(':').map(Number); o.i32(bin); o.i32(gx); o.i32(gz); o.i32(comp); }
    const res = await run(MODE_LIFT, o.done(), opts);
    const count = res.u32();
    const changed = new Map<number, Uint8Array>(), planeLifted = new Map<number, number>();
    let texelsLifted = 0;
    for (let e = 0; e < count; e++) {
        const im = res.i32(), i = res.i32(), src = res.i32(), f = res.f64();
        const photo = pass.photos.get(im), sun = pass.photoSun.get(im);
        const ratio = src < 0 ? sun?.ratio : pass.comps[src]?.ratio;
        if (!photo || !ratio) throw new RoofShadowNativeError('invalid_output', `roof_shadow_native lifted a texel of photo ${im} it cannot resolve`);
        let out = changed.get(im);
        if (!out) changed.set(im, (out = Uint8Array.from(photo.rgba)));
        texelsLifted++;
        if (sun && sun.k >= 0) planeLifted.set(sun.k, (planeLifted.get(sun.k) ?? 0) + 1);
        for (let k2 = 0; k2 < 3; k2++) out[i * 4 + k2] = Math.round(linearToSrgb255(SRGB8_TO_LINEAR[photo.rgba[i * 4 + k2]] * Math.pow(ratio[k2], f)));
    }
    finished(res);
    return { changed, texelsLifted, planeLifted };
}
