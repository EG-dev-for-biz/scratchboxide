/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K's facade ortho straightening, native: rectifyOrtho (../ortho-rectify.ts) translated line for line
 * into C++20 (scratchbox_ortho_rectify.hpp) behind its CLI driver (scripts/ortho_rectify_native.cpp), built through the
 * native build cache. Same parameters, same result: the image, the uncovered, featureless and (warped) occluded masks
 * and the report, bit for bit on the same input (ortho-rectify-native.test.ts holds the parity). ortho-rectify-worker.ts
 * calls it when SCRATCHBOX_K_NATIVE runs `rectify` (native-switch.ts; the default). A failed build or run throws; there is
 * no fallback to the TypeScript. With `trace: true` the driver also writes what it traced (--trace), read back as the
 * result's `trace`, the same as the TypeScript's, for the straightening's overlay (rectify-overlay.ts).
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { compileNativeCached, defaultNativeFlags, NativeBuildError } from '../../../native-build-cache';
import { ORTHO_RECTIFY_PARAMS, type OrthoRectifyParams, type OrthoRectifyReport, type OrthoRectifyResult, type RejectedPeak, type Rgba, type TracedLine } from '../ortho-rectify';

const CLI_SOURCE = path.join('scripts', 'ortho_rectify_native.cpp');
const INCLUDE_DIR = path.join('packages', 'core', 'src', 'native', '3d-engine', 'include');
const VERSION = 1;

/** The parameters in the order the request carries them (scratchbox_ortho_rectify.hpp paramNames). */
export const NATIVE_PARAM_ORDER: ReadonlyArray<keyof OrthoRectifyParams> = [
    'peakK', 'minLineGapM', 'maxShiftM', 'trackStepM', 'bendCost', 'minEdge', 'minSupport', 'minSegmentM', 'segmentGapM',
    'traceVertical', 'traceHorizontal', 'gridM', 'wLine', 'wSimilarity', 'wAnchor', 'wBorder', 'cgIterations', 'cgTolerance',
    'minJacobian', 'minGain', 'fillRepeats', 'minFillRepeats', 'storeyMinM', 'storeyMaxM', 'periodMinM', 'periodMaxM',
    'minPeriodNcc', 'repeats', 'minRepeats', 'repeatWindowM', 'minRepeatNcc', 'minSmearRepeats', 'smearRepeats', 'phaseSearchPx',
    'smearRadiusYM', 'smearRadiusXM', 'smearK', 'smearMinLog', 'smearMaxLog', 'featureWindowM', 'featurelessRatio',
    'featurelessMinM2', 'featurelessMinSideM'
];

/** The repository root: the first ancestor of this file (or of the working directory) holding the driver's source. */
export function findOrthoRectifyRepoRoot(): string {
    for (const start of [__dirname, process.cwd()]) {
        let dir = path.resolve(start);
        while (true) {
            if (fs.existsSync(path.join(dir, CLI_SOURCE))) return dir;
            const parent = path.dirname(dir);
            if (parent === dir) break;
            dir = parent;
        }
    }
    throw new Error(`ortho_rectify_native: ${CLI_SOURCE} not found above ${__dirname} or ${process.cwd()}`);
}

let building: Promise<string> | undefined;

/** The driver's binary, built through the native build cache when its sources changed. */
export function ensureOrthoRectifyBinary(repoRoot?: string): Promise<string> {
    if (building) return building;
    building = (async () => {
        const root = repoRoot ?? findOrthoRectifyRepoRoot();
        try {
            const built = await compileNativeCached({ sourcePath: path.join(root, CLI_SOURCE), includeDirs: [path.join(root, INCLUDE_DIR)], flags: defaultNativeFlags(['-pthread']), name: 'ortho_rectify_native', timeoutMs: 300_000 });
            return built.binaryPath;
        } catch (err) {
            building = undefined;
            throw new Error(`could not build ortho_rectify_native: ${err instanceof NativeBuildError ? err.compilerOutput.slice(-1500) : String(err)}`);
        }
    })();
    return building;
}

/** The request file: header, params as doubles, the RGBA, then the occlusion mask when given. */
function encodeRequest(img: Rgba, pixelM: number, P: OrthoRectifyParams, occluded?: Uint8Array): Buffer {
    const N = img.width * img.height;
    if (img.rgba.length !== N * 4) throw new Error(`ortho_rectify_native: ${img.rgba.length} RGBA bytes for ${img.width} x ${img.height}`);
    if (occluded && occluded.length !== N) throw new Error(`ortho_rectify_native: an occlusion mask of ${occluded.length} for ${N} texels`);
    const extra = Object.keys(P).filter(k => !(NATIVE_PARAM_ORDER as readonly string[]).includes(k));
    if (extra.length) throw new Error(`ortho_rectify_native: parameters the native kernel does not know: ${extra.join(', ')}`);
    const headLen = 4 + 4 * 3 + 8 + 4 * 2 + 8 * NATIVE_PARAM_ORDER.length;
    const buf = Buffer.alloc(headLen + N * 4 + (occluded ? N : 0));
    let o = buf.write('SBOR', 0, 'latin1');
    o = buf.writeUInt32LE(VERSION, o);
    o = buf.writeUInt32LE(img.width, o);
    o = buf.writeUInt32LE(img.height, o);
    o = buf.writeDoubleLE(pixelM, o);
    o = buf.writeUInt32LE(occluded ? 1 : 0, o);
    o = buf.writeUInt32LE(NATIVE_PARAM_ORDER.length, o);
    for (const k of NATIVE_PARAM_ORDER) {
        const v = P[k];
        if (v === undefined) throw new Error(`ortho_rectify_native: parameter ${k} missing`);
        o = buf.writeDoubleLE(typeof v === 'boolean' ? (v ? 1 : 0) : v, o);
    }
    buf.set(img.rgba, o);
    if (occluded) buf.set(occluded, o + N * 4);
    return buf;
}

/** The result file back into the TypeScript result's shape. */
function decodeResult(buf: Buffer, report: OrthoRectifyReport, withOccluded: boolean): OrthoRectifyResult {
    if (buf.length < 20 || buf.toString('latin1', 0, 4) !== 'SBOR' || buf.readUInt32LE(4) !== VERSION) throw new Error('ortho_rectify_native: not a result file');
    const W = buf.readUInt32LE(8), H = buf.readUInt32LE(12), has = buf.readUInt32LE(16) === 1, N = W * H;
    if (has !== withOccluded || buf.length !== 20 + N * 6 + (has ? N : 0)) throw new Error(`ortho_rectify_native: a result of ${buf.length} bytes for ${W} x ${H}`);
    let o = 20;
    const take = (n: number) => { const v = new Uint8Array(n); v.set(buf.subarray(o, o + n)); o += n; return v; };
    const rgba = take(N * 4), uncovered = take(N), featureless = take(N), occluded = has ? take(N) : undefined;
    return { image: { width: W, height: H, rgba }, report, uncovered, featureless, ...(occluded ? { occluded } : {}) };
}

/** The trace file (scripts/ortho_rectify_native.cpp, --trace) back into the TypeScript result's `trace`. */
export function decodeTrace(buf: Buffer): NonNullable<OrthoRectifyResult['trace']> {
    if (buf.length < 20 || buf.toString('latin1', 0, 4) !== 'SBTR' || buf.readUInt32LE(4) !== 1) throw new Error('ortho_rectify_native: not a trace file');
    const nLines = buf.readUInt32LE(8), nRejected = buf.readUInt32LE(12), hasAfter = buf.readUInt32LE(16) === 1;
    let o = 20;
    const need = (n: number) => { if (o + n > buf.length) throw new Error('ortho_rectify_native: a truncated trace file'); };
    const f64s = (n: number) => { need(n * 8); const v: number[] = new Array(n); for (let k = 0; k < n; k++, o += 8) v[k] = buf.readDoubleLE(o); return v; };
    const axisOf = (c: number): 'v' | 'h' => (c === 0x76 ? 'v' : 'h');
    const lines: TracedLine[] = [];
    for (let i = 0; i < nLines; i++) {
        need(13);
        const axis = axisOf(buf[o]), at = buf.readInt32LE(o + 1), segments = buf.readInt32LE(o + 5), n = buf.readUInt32LE(o + 9);
        o += 13;
        const along = f64s(n), across = f64s(n), weight = f64s(n), straight = f64s(n);
        lines.push({ axis, at, along, across, weight, straight, segments });
    }
    const why: Record<number, RejectedPeak['why']> = { 0x62: 'border', 0x65: 'no-edge', 0x73: 'no-segment' };
    const rejected: RejectedPeak[] = [];
    for (let i = 0; i < nRejected; i++) {
        need(6);
        const w = why[buf[o + 5]];
        if (!w) throw new Error(`ortho_rectify_native: a dropped peak's reason ${buf[o + 5]} is not known`);
        rejected.push({ axis: axisOf(buf[o]), at: buf.readInt32LE(o + 1), why: w });
        o += 6;
    }
    const after = hasAfter ? lines.map(l => ({ ...l, across: f64s(l.along.length) })) : undefined;
    if (o !== buf.length) throw new Error(`ortho_rectify_native: ${buf.length - o} bytes left over in the trace file`);
    return { lines, rejected, ...(after ? { after } : {}) };
}

/**
 * rectifyOrtho, native: one facade ortho straightened (verified) and its smears levelled, `occluded` carried through a
 * kept warp. The report's `ms` is the kernel's own time. `trace` asks for what it traced, as the result's `trace`.
 */
export async function rectifyOrthoNative(img: Rgba, pixelM: number, P: OrthoRectifyParams = ORTHO_RECTIFY_PARAMS, occluded?: Uint8Array, opts: { threads?: number; timeoutMs?: number; trace?: boolean } = {}): Promise<OrthoRectifyResult> {
    const bin = await ensureOrthoRectifyBinary();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ortho-rectify-native-'));
    try {
        const req = path.join(dir, 'request.bin'), res = path.join(dir, 'result.bin'), tr = path.join(dir, 'trace.bin');
        fs.writeFileSync(req, encodeRequest(img, pixelM, P, occluded));
        const args = [req, res, ...(opts.threads !== undefined ? ['--threads', String(opts.threads)] : []), ...(opts.trace ? ['--trace', tr] : [])];
        const stdout = await new Promise<string>((resolve, reject) => {
            execFile(bin, args, { timeout: opts.timeoutMs ?? 600_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, out, stderr) => {
                if (err) reject(new Error(`ortho_rectify_native failed: ${String(stderr).trim() || err.message}`));
                else resolve(String(out));
            });
        });
        // the driver writes a non-finite number as null; the report holds no other null
        const report = JSON.parse(stdout, (_k, v) => (v === null ? NaN : v)) as OrthoRectifyReport;
        const result = decodeResult(fs.readFileSync(res), report, !!occluded);
        return opts.trace ? { ...result, trace: decodeTrace(fs.readFileSync(tr)) } : result;
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}
