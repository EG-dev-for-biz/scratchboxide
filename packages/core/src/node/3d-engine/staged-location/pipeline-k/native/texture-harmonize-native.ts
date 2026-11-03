/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K's texture harmonisation run natively (opt-in): the compute of ../texture-harmonize.ts translated to C++20
 * (scratchbox_texture_harmonize.hpp) behind its CLI driver (scripts/texture_harmonize_native.cpp), built through the
 * native build cache. Same signatures and results as the TypeScript, asynchronous: the GLB is read here, its triangle
 * primitives, the photos and the parameters go to the driver in one request file, and the report is assembled here from
 * the driver's figures exactly as the TypeScript assembles its own. One process per call.
 *
 * A failed build or run throws TextureHarmonizeNativeError; nothing falls back to the TypeScript.
 */

import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { compileNativeCached, defaultNativeFlags, NativeBuildError } from '../../../native-build-cache';
import { readAccessor, type ParsedGlb } from '../../glb-bytes';
import { SRGB8_TO_LINEAR, linearToSrgb255 } from '../../../../../common/spatial/photogrammetric-delight';
import type { RgbaImage8 } from '../../tile-texture-transfer';
import { TEXTURE_HARMONIZE_PARAMS, type TextureHarmonizeParams, type TextureHarmonizeReport } from '../texture-harmonize';

export type TextureHarmonizeNativeErrorCode = 'build_failed' | 'run_failed' | 'invalid_output';

export class TextureHarmonizeNativeError extends Error {
    constructor(public readonly code: TextureHarmonizeNativeErrorCode, message: string) {
        super(message);
        this.name = 'TextureHarmonizeNativeError';
    }
}

export interface TextureHarmonizeNativeOptions {
    /** Worker threads (default 0: all cores). The result does not depend on it. */
    threads?: number;
    /** Longest a run may take, not counting a first-use build (default 600 s). */
    timeoutMs?: number;
    /** Where scripts/texture_harmonize_native.cpp and the engine headers live (default: discovered). */
    repoRoot?: string;
}

/** The driver's own figures beside the report: its stage timings (ms) and the conjugate-gradient iterations per channel. */
export interface TextureHarmonizeNativeStats {
    ms: { heightMap: number; samples: number; gainsAndPatches: number; fieldSolve: number; masks: number; apply: number; process: number };
    cgIterations: [number, number, number];
}

const CLI_SOURCE = path.join('scripts', 'texture_harmonize_native.cpp');
const INCLUDE_DIR = path.join('packages', 'core', 'src', 'native', '3d-engine', 'include');
const REQUEST_MAGIC = 0x48544253, RESULT_MAGIC = 0x52544253, VERSION = 1;
const MODE_MASKS = 1, MODE_HARMONIZE = 2;
const STATUS_TOO_FEW = 0, STATUS_NOT_CLOSER = 1, STATUS_KEPT = 2;
/** TEXTURE_HARMONIZE_PARAMS in the request's order. */
const PARAM_ORDER: ReadonlyArray<keyof TextureHarmonizeParams> = ['sampleM', 'maxSamplesPerTriangle', 'sideBins', 'bandM', 'flatNy', 'maxGainLog', 'gainScale', 'seamM', 'seamFacingBins', 'fieldPx', 'maxField', 'wSmooth', 'wAnchor', 'maxOffsetLog', 'heightCellM', 'roofToleranceM'];

/** The repository root: the first ancestor of this module (or of the working directory) holding the driver's source. */
export function findTextureHarmonizeRepoRoot(): string {
    for (const start of [__dirname, process.cwd()]) {
        for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
            if (fs.existsSync(path.join(dir, CLI_SOURCE))) return dir;
            if (path.dirname(dir) === dir) break;
        }
    }
    return process.cwd();
}

/** The driver binary from the native build cache, compiled when its sources changed. */
export async function ensureTextureHarmonizeNativeBinary(repoRoot = findTextureHarmonizeRepoRoot()): Promise<string> {
    if (process.env.SCRATCHBOX_TEXTURE_HARMONIZE_BIN) return process.env.SCRATCHBOX_TEXTURE_HARMONIZE_BIN;
    try {
        const built = await compileNativeCached({ sourcePath: path.join(repoRoot, CLI_SOURCE), includeDirs: [path.join(repoRoot, INCLUDE_DIR)], flags: defaultNativeFlags(), name: 'texture_harmonize_native', timeoutMs: 300_000 });
        return built.binaryPath;
    } catch (err) {
        throw new TextureHarmonizeNativeError('build_failed', `could not build texture_harmonize_native: ${err instanceof NativeBuildError ? err.compilerOutput.slice(-1500) : String(err)}`);
    }
}

let encodeThresholds: Float64Array | undefined;

/**
 * The sRGB encode as thresholds: per byte v = 1..255, the least x in [0, 1] with Math.round(linearToSrgb255(x)) >= v
 * (+Infinity when none), found by bisection over the doubles' bit patterns with this process's own Math.pow, so the
 * driver's encode equals the TypeScript's without computing a pow of its own. Checked once against the encode itself on
 * a dense grid and at every threshold's neighbours.
 */
export function srgbEncodeThresholds(): Float64Array {
    if (encodeThresholds) return encodeThresholds;
    const f = (x: number) => Math.round(linearToSrgb255(x));
    const bits = new BigUint64Array(1), dbl = new Float64Array(bits.buffer);
    const at = (b: bigint) => { bits[0] = b; return dbl[0]; };
    dbl[0] = 1; const oneBits = bits[0];
    const t = new Float64Array(255);
    for (let v = 1; v <= 255; v++) {
        if (f(1) < v) { t[v - 1] = Infinity; continue; }
        let lo = 0n, hi = oneBits;
        while (lo < hi) { const mid = (lo + hi) >> 1n; if (f(at(mid)) >= v) hi = mid; else lo = mid + 1n; }
        t[v - 1] = at(lo);
    }
    const encode = (x: number) => { let n = 0; while (n < 255 && t[n] <= x) n++; return n; };
    for (let v = 1; v <= 255; v++) {
        if (v > 1 && !(t[v - 1] >= t[v - 2])) throw new TextureHarmonizeNativeError('run_failed', 'the sRGB encode is not monotone: no thresholds reproduce it');
        if (!Number.isFinite(t[v - 1])) continue;
        dbl[0] = t[v - 1];
        const base = bits[0];
        for (const d of [-2n, -1n, 0n, 1n, 2n]) { const x = at(base + d); if (x >= 0 && x <= 1 && encode(x) !== f(x)) throw new TextureHarmonizeNativeError('run_failed', `the sRGB encode thresholds miss ${x}`); }
    }
    for (let i = 0; i <= 200_000; i++) { const x = i / 200_000; if (encode(x) !== f(x)) throw new TextureHarmonizeNativeError('run_failed', `the sRGB encode thresholds miss ${x}`); }
    return (encodeThresholds = t);
}

interface Prim { image: number; positions: Float64Array; indices?: Uint32Array; uvs: Float64Array }

/** The GLB's triangle primitives as the TypeScript walks them (topHeightMap reads them all; forEachTexturedTriangle the textured ones). */
function primitivesOf(g: ParsedGlb, json: any): Prim[] {
    const out: Prim[] = [];
    for (const mesh of json.meshes ?? []) for (const prim of mesh.primitives ?? []) {
        if ((prim.mode ?? 4) !== 4 || prim.attributes?.POSITION === undefined) continue;
        const positions = readAccessor(g, prim.attributes.POSITION).data;
        const indices = prim.indices !== undefined ? Uint32Array.from(readAccessor(g, prim.indices).data) : undefined;
        let image = -1, uvs: Float64Array = new Float64Array(0);
        if (prim.material !== undefined) {
            const tex = json.materials?.[prim.material]?.pbrMetallicRoughness?.baseColorTexture;
            const source = tex ? json.textures?.[tex.index]?.source : undefined;
            const uvAcc = tex ? prim.attributes[`TEXCOORD_${tex.texCoord ?? 0}`] : undefined;
            if (source !== undefined && uvAcc !== undefined) {
                if (!Number.isInteger(source) || source < 0 || source > 0x7fffffff) throw new TextureHarmonizeNativeError('run_failed', `texture source ${source} is not an image index`);
                image = source; uvs = readAccessor(g, uvAcc).data;
            }
        }
        out.push({ image, positions, indices, uvs });
    }
    return out;
}

interface RequestImage { index: number; width: number; height: number; rgba?: Uint8Array; mask?: Uint8Array }

function buildRequest(mode: number, threads: number, P: TextureHarmonizeParams, groundY: number, prims: Prim[], images: RequestImage[], masksGiven: boolean): Buffer {
    if (os.endianness() !== 'LE') throw new TextureHarmonizeNativeError('run_failed', 'the native harmoniser exchanges little-endian files and this host is big-endian');
    let size = 16 + 16 * 8 + 8 + 256 * 4 + 255 * 8 + 4 + 4 + 4;
    for (const p of prims) size += 4 + 4 + p.positions.byteLength + 8 + (p.indices?.byteLength ?? 0) + 4 + p.uvs.byteLength;
    for (const im of images) size += 16 + (im.rgba ? im.rgba.byteLength : 0) + 8 + (im.mask ? im.mask.byteLength : 0);
    const buf = Buffer.allocUnsafe(size);
    let o = 0;
    const u32 = (v: number) => { o = buf.writeUInt32LE(v, o); }, i32 = (v: number) => { o = buf.writeInt32LE(v, o); }, f64 = (v: number) => { o = buf.writeDoubleLE(v, o); };
    const bytes = (a: ArrayBufferView) => { buf.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), o); o += a.byteLength; };
    u32(REQUEST_MAGIC); u32(VERSION); u32(mode); u32(threads);
    for (const k of PARAM_ORDER) f64(P[k]);
    f64(groundY);
    bytes(SRGB8_TO_LINEAR);
    bytes(srgbEncodeThresholds());
    u32(prims.length);
    for (const p of prims) {
        i32(p.image);
        u32(p.positions.length); bytes(p.positions);
        u32(p.indices ? 1 : 0); u32(p.indices?.length ?? 0); if (p.indices) bytes(p.indices);
        u32(p.uvs.length); bytes(p.uvs);
    }
    u32(masksGiven ? 1 : 0);
    u32(images.length);
    for (const im of images) {
        if (!Number.isInteger(im.index) || im.index < -0x80000000 || im.index > 0x7fffffff) throw new TextureHarmonizeNativeError('run_failed', `image index ${im.index} does not fit the request`);
        if (im.rgba && im.rgba.byteLength !== im.width * im.height * 4) throw new TextureHarmonizeNativeError('run_failed', `image ${im.index}'s RGBA is not ${im.width} x ${im.height} x 4 bytes`);
        i32(im.index); u32(im.width); u32(im.height);
        u32(im.rgba ? 1 : 0); if (im.rgba) bytes(im.rgba);
        u32(im.mask ? 1 : 0); u32(im.mask?.length ?? 0); if (im.mask) bytes(im.mask);
    }
    if (o !== size) throw new TextureHarmonizeNativeError('run_failed', `request size ${o} is not the ${size} bytes planned`);
    return buf;
}

/** Writes the request, runs the driver, returns the result bytes; temp files are removed whatever happens. */
async function runDriver(request: Buffer, opts: TextureHarmonizeNativeOptions): Promise<{ result: Buffer; ms: number }> {
    const bin = await ensureTextureHarmonizeNativeBinary(opts.repoRoot);
    const tag = `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    const reqPath = path.join(os.tmpdir(), `texture_harmonize_${tag}.req`), resPath = path.join(os.tmpdir(), `texture_harmonize_${tag}.res`);
    try {
        await fs.promises.writeFile(reqPath, request);
        const t0 = Date.now();
        await new Promise<void>((resolve, reject) => {
            execFile(bin, [reqPath, resPath], { timeout: opts.timeoutMs ?? 600_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, _stdout, stderr) => {
                if (err) reject(new TextureHarmonizeNativeError('run_failed', `texture_harmonize_native failed: ${String(stderr || err.message).trim().slice(-1500)}`));
                else resolve();
            });
        });
        const ms = Date.now() - t0;
        if (!fs.existsSync(resPath)) throw new TextureHarmonizeNativeError('invalid_output', 'texture_harmonize_native exited 0 but wrote no result');
        return { result: await fs.promises.readFile(resPath), ms };
    } finally {
        await Promise.all([fs.promises.rm(reqPath, { force: true }), fs.promises.rm(resPath, { force: true })]);
    }
}

class ResultReader {
    private o = 0;
    constructor(private readonly b: Buffer) {}
    private need(n: number) { if (this.o + n > this.b.length) throw new TextureHarmonizeNativeError('invalid_output', 'texture_harmonize_native wrote a short result'); }
    u32(): number { this.need(4); const v = this.b.readUInt32LE(this.o); this.o += 4; return v; }
    i32(): number { this.need(4); const v = this.b.readInt32LE(this.o); this.o += 4; return v; }
    f64(): number { this.need(8); const v = this.b.readDoubleLE(this.o); this.o += 8; return v; }
    bytes(n: number): Uint8Array { this.need(n); const v = new Uint8Array(n); v.set(this.b.subarray(this.o, this.o + n)); this.o += n; return v; }
    header(mode: number): void {
        if (this.u32() !== RESULT_MAGIC || this.u32() !== VERSION || this.u32() !== mode) throw new TextureHarmonizeNativeError('invalid_output', 'texture_harmonize_native wrote a result of another kind or version');
    }
    end(): void { if (this.o !== this.b.length) throw new TextureHarmonizeNativeError('invalid_output', 'texture_harmonize_native wrote trailing bytes'); }
}

/** surfaceClassMasks, natively: the same masks (TEXEL_*), per image of `sizes`, in its order. */
export async function surfaceClassMasksNative(g: ParsedGlb, json: any, sizes: Map<number, { width: number; height: number }>, P: TextureHarmonizeParams = TEXTURE_HARMONIZE_PARAMS, opts: TextureHarmonizeNativeOptions = {}): Promise<Map<number, Uint8Array>> {
    const images: RequestImage[] = [...sizes].map(([index, s]) => ({ index, width: s.width, height: s.height }));
    const { result } = await runDriver(buildRequest(MODE_MASKS, opts.threads ?? 0, P, 0, primitivesOf(g, json), images, false), opts);
    const r = new ResultReader(result);
    r.header(MODE_MASKS);
    const n = r.u32();
    if (n !== images.length) throw new TextureHarmonizeNativeError('invalid_output', `texture_harmonize_native returned ${n} masks for ${images.length} images`);
    const masks = new Map<number, Uint8Array>();
    for (const im of images) {
        const index = r.i32(), w = r.u32(), h = r.u32();
        if (index !== im.index || w !== im.width || h !== im.height) throw new TextureHarmonizeNativeError('invalid_output', `texture_harmonize_native returned image ${index} (${w} x ${h}) where ${im.index} was asked`);
        masks.set(index, r.bytes(w * h));
    }
    r.end();
    return masks;
}

/** harmonizeTextures, natively, with the driver's own timings. */
export async function harmonizeTexturesNativeDetailed(g: ParsedGlb, json: any, images: Map<number, RgbaImage8>, groundY: number, P: TextureHarmonizeParams = TEXTURE_HARMONIZE_PARAMS, masks?: Map<number, Uint8Array>, opts: TextureHarmonizeNativeOptions = {}): Promise<{ report: TextureHarmonizeReport; stats: TextureHarmonizeNativeStats }> {
    const t0 = Date.now();
    const req: RequestImage[] = [...images].map(([index, im]) => ({ index, width: im.width, height: im.height, rgba: im.rgba, mask: masks?.get(index) }));
    const { result, ms: processMs } = await runDriver(buildRequest(MODE_HARMONIZE, opts.threads ?? 0, P, groundY, primitivesOf(g, json), req, masks !== undefined), opts);
    const r = new ResultReader(result);
    r.header(MODE_HARMONIZE);
    const status = r.u32(), samples = r.u32(), groups = r.u32(), roofGains = r.u32(), gainCount = r.u32(), pairs = r.u32();
    const roofM2 = r.f64(), hiddenM2 = r.f64(), sumAbs = r.f64(), maxAbs = r.f64(), before = r.f64(), afterMatch = r.f64(), after = r.f64();
    const cgIterations: [number, number, number] = [r.i32(), r.i32(), r.i32()];
    const ms = [r.f64(), r.f64(), r.f64(), r.f64(), r.f64(), r.f64()];
    const stats: TextureHarmonizeNativeStats = { ms: { heightMap: ms[0], samples: ms[1], gainsAndPatches: ms[2], fieldSolve: ms[3], masks: ms[4], apply: ms[5], process: processMs }, cgIterations };
    const report: TextureHarmonizeReport = { images: images.size, samples, groups: 0, roofs: { roofM2: Math.round(roofM2), hiddenM2: Math.round(hiddenM2), roofGains: 0 }, gains: { meanAbsLog: 0, maxAbsLog: 0 }, seams: { pairs: 0, before: 0, afterMatch: 0, after: 0 }, kept: false, why: '', ms: 0 };
    const count = r.u32();
    if (status === STATUS_TOO_FEW) {
        if (count !== 0) throw new TextureHarmonizeNativeError('invalid_output', 'texture_harmonize_native returned images for a run it did not keep');
        r.end();
        report.why = 'fewer than two photos or too few samples: nothing to harmonise'; report.ms = Date.now() - t0;
        return { report, stats };
    }
    report.groups = groups;
    report.roofs.roofGains = roofGains;
    report.gains = { meanAbsLog: gainCount ? +(sumAbs / (3 * gainCount)).toFixed(4) : 0, maxAbsLog: +maxAbs.toFixed(4) };
    report.seams = { pairs, before: +before.toFixed(4), afterMatch: +afterMatch.toFixed(4), after: +after.toFixed(4) };
    // the driver decides on the same rounded figures; a disagreement means the two sides drifted apart
    const closer = report.seams.after < report.seams.before;
    if (closer !== (status === STATUS_KEPT) || (status !== STATUS_KEPT && status !== STATUS_NOT_CLOSER)) throw new TextureHarmonizeNativeError('invalid_output', `texture_harmonize_native returned status ${status} for seams ${report.seams.before} -> ${report.seams.after}`);
    if (status === STATUS_NOT_CLOSER) {
        if (count !== 0) throw new TextureHarmonizeNativeError('invalid_output', 'texture_harmonize_native returned images for a run it did not keep');
        r.end();
        report.why = `the seams did not get closer (${report.seams.before} -> ${report.seams.after} in log colour)`; report.ms = Date.now() - t0;
        return { report, stats };
    }
    if (count !== images.size) throw new TextureHarmonizeNativeError('invalid_output', `texture_harmonize_native returned ${count} images for ${images.size}`);
    const out: Array<[number, RgbaImage8]> = [];
    for (const im of req) {
        const index = r.i32(), w = r.u32(), h = r.u32();
        if (index !== im.index || w !== im.width || h !== im.height) throw new TextureHarmonizeNativeError('invalid_output', `texture_harmonize_native returned image ${index} (${w} x ${h}) where ${im.index} was asked`);
        out.push([index, { width: w, height: h, rgba: r.bytes(w * h * 4) }]);
    }
    r.end();
    for (const [index, im] of out) images.set(index, im);
    report.kept = true;
    report.why = `${images.size} photos matched to ${report.groups} side and height-band references, roofs apart (${report.roofs.roofM2} m² of roof seen from above, ${report.roofs.hiddenM2} m² of hidden up-facing surface left out; ${report.roofs.roofGains} roof gains) (mean gain ${Math.round((Math.exp(report.gains.meanAbsLog) - 1) * 100)}%), ${pairs} shared surface patches levelled: mean patch difference ${report.seams.before} -> ${report.seams.afterMatch} (matched) -> ${report.seams.after} (levelled), in log colour`;
    report.ms = Date.now() - t0;
    return { report, stats };
}

/** harmonizeTextures, natively: the same report, and the photos in `images` replaced in place when the result is kept. */
export async function harmonizeTexturesNative(g: ParsedGlb, json: any, images: Map<number, RgbaImage8>, groundY: number, P: TextureHarmonizeParams = TEXTURE_HARMONIZE_PARAMS, masks?: Map<number, Uint8Array>, opts: TextureHarmonizeNativeOptions = {}): Promise<TextureHarmonizeReport> {
    return (await harmonizeTexturesNativeDetailed(g, json, images, groundY, P, masks, opts)).report;
}
