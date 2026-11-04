/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The facade reader's window search, native: matchExemplar (../facade-reader-template.ts) translated line for line into
 * C++20 (scratchbox_template_match.hpp) behind its CLI driver (scripts/template_match_native.cpp), built through the
 * native build cache. Every exemplar of a family on one plane in one run, on a thread pool and off the build's event
 * loop; the matches are matchExemplar's bit for bit (template-match-native.test.ts holds the parity). facade-reader.ts
 * readFromTemplates calls it when SCRATCHBOX_K_NATIVE runs `template` (native-switch.ts; the default), its threads capped
 * by SCRATCHBOX_K_NATIVE_THREADS. A failed build or run throws; there is no fallback to the TypeScript.
 *
 * The plane and the exemplars go over stdin and the matches come back on stdout as raw little-endian buffers (the
 * driver's comment lists them); the luminance grids go as their float32 bytes.
 */

import { spawn } from 'child_process';
import * as path from 'path';
import { compileNativeCached, defaultNativeFlags, NativeBuildError, placeCachedBinary, type NativeCompileSpec } from '../../../native-build-cache';
import { findTileRefineRepoRoot } from '../../../tile-refine-service';
import { byRowThenColumn, TEMPLATE_PARAMS, type LumGrid, type TemplateMatch, type TemplateParams, type WindowExemplar } from '../facade-reader-template';
import { nativeTwinThreads } from './twin-texels-native';

const CLI_SOURCE = path.join('scripts', 'template_match_native.cpp');
const INCLUDE_DIR = path.join('packages', 'core', 'src', 'native', '3d-engine', 'include');
const BINARY = path.join('build', '3d-native', 'template_match_native');
const VERSION = 1;

function compileSpec(repoRoot: string): NativeCompileSpec {
    // -ffp-contract=off: a fused multiply-add rounds once where JavaScript rounds twice, and the kernel matches it value for value
    return { sourcePath: path.join(repoRoot, CLI_SOURCE), includeDirs: [path.join(repoRoot, INCLUDE_DIR)], flags: defaultNativeFlags(['-ffp-contract=off', '-pthread']), name: 'template_match_native', timeoutMs: 300_000 };
}

let building: Promise<string> | undefined;

/** Builds build/3d-native/template_match_native through the native build cache when its sources changed. */
export function ensureTemplateMatchBinary(repoRoot = findTileRefineRepoRoot()): Promise<string> {
    if (building) return building;
    building = (async () => {
        const bin = path.join(repoRoot, BINARY);
        try {
            placeCachedBinary((await compileNativeCached(compileSpec(repoRoot))).binaryPath, bin);
            return bin;
        } catch (err) {
            throw new Error(`could not build template_match_native: ${err instanceof NativeBuildError ? err.compilerOutput.slice(-1500) : String(err)}`);
        }
    })().finally(() => { building = undefined; });
    return building;
}

const floatBytes = (a: Float32Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);

function encodeRequest(g: LumGrid, exemplars: WindowExemplar[], P: TemplateParams): Buffer {
    if (g.L.length !== g.W * g.H) throw new Error(`template_match_native: ${g.L.length} texels for ${g.W} x ${g.H}`);
    const head = Buffer.alloc(8 + 8 * 5 + 16);
    let o = head.write('SBTM', 0, 'latin1');
    o = head.writeUInt32LE(VERSION, o);
    for (const v of [P.coarseM, P.minNcc, P.gridNcc, P.minCovered, P.openingCovered]) o = head.writeDoubleLE(v, o);
    o = head.writeUInt32LE(g.W, o);
    o = head.writeUInt32LE(g.H, o);
    head.writeDoubleLE(g.pixel, o);
    const parts: Buffer[] = [head, floatBytes(g.L)];
    const count = Buffer.alloc(4);
    count.writeUInt32LE(exemplars.length, 0);
    parts.push(count);
    for (const ex of exemplars) {
        if (ex.patch.length !== ex.pw * ex.ph) throw new Error(`template_match_native: an exemplar of ${ex.patch.length} texels for ${ex.pw} x ${ex.ph}`);
        const h = Buffer.alloc(8 + 8 + 32);
        let q = h.writeUInt32LE(ex.pw, 0);
        q = h.writeUInt32LE(ex.ph, q);
        q = h.writeDoubleLE(ex.pixel, q);
        for (const v of ex.opening) q = h.writeDoubleLE(v, q);
        parts.push(h, floatBytes(ex.patch));
    }
    return Buffer.concat(parts);
}

/** The result back into matchExemplar's matches: the ncc rounded, the exemplar's panes and plane, sorted as it sorts them. */
function decodeResult(buf: Buffer, exemplars: WindowExemplar[]): TemplateMatch[][] {
    if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'SBTM' || buf.readUInt32LE(4) !== VERSION) throw new Error('template_match_native: not a result');
    if (buf.readUInt32LE(8) !== exemplars.length) throw new Error(`template_match_native: ${buf.readUInt32LE(8)} results for ${exemplars.length} exemplars`);
    let o = 12;
    return exemplars.map(ex => {
        if (o + 4 > buf.length) throw new Error('template_match_native: a truncated result');
        const n = buf.readUInt32LE(o);
        o += 4;
        if (o + n * 48 > buf.length) throw new Error('template_match_native: a truncated result');
        const found: TemplateMatch[] = [];
        for (let i = 0; i < n; i++, o += 48) {
            const rect: [number, number, number, number] = [buf.readDoubleLE(o), buf.readDoubleLE(o + 8), buf.readDoubleLE(o + 16), buf.readDoubleLE(o + 24)];
            const ncc = Math.round(buf.readDoubleLE(o + 32) * 1000) / 1000;
            found.push(buf.readDoubleLE(o + 40) ? { rect, ncc, grid: true, panes: ex.panes, fromPlane: ex.fromPlane } : { rect, ncc, panes: ex.panes, fromPlane: ex.fromPlane });
        }
        return found.sort(byRowThenColumn);
    });
}

/**
 * matchExemplar of each exemplar on the plane g, in one native run: element i is matchExemplar(g, exemplars[i], P).
 */
export async function matchExemplarsNative(g: LumGrid, exemplars: WindowExemplar[], P: TemplateParams = TEMPLATE_PARAMS, opts: { threads?: number; timeoutMs?: number } = {}): Promise<TemplateMatch[][]> {
    if (!exemplars.length) return [];
    const bin = await ensureTemplateMatchBinary();
    const threads = nativeTwinThreads(opts.threads);
    const request = encodeRequest(g, exemplars, P);
    const out = await new Promise<Buffer>((resolve, reject) => {
        const child = spawn(bin, threads ? ['--threads', String(threads)] : [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        const chunks: Buffer[] = [], errs: Buffer[] = [];
        const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 300_000);
        child.stdout.on('data', (b: Buffer) => chunks.push(b));
        child.stderr.on('data', (b: Buffer) => errs.push(b));
        child.on('error', err => { clearTimeout(timer); reject(new Error(`template_match_native failed: ${err.message}`)); });
        child.on('close', (code, signal) => {
            clearTimeout(timer);
            if (code === 0) resolve(Buffer.concat(chunks));
            else reject(new Error(`template_match_native failed: ${Buffer.concat(errs).toString().trim() || (signal ? `killed by ${signal}` : `exit code ${code}`)}`));
        });
        child.stdin.on('error', () => { /* the close handler reports why the driver stopped reading */ });
        child.stdin.end(request);
    });
    return decodeResult(out, exemplars);
}
