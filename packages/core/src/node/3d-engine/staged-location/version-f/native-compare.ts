/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Version F round 3: the native render-compare kernel's client (scripts/version_f_compare.cpp,
 * scratchbox_version_f_compare.hpp). One process per adjustment: the seen walls' evidence is written once as a session
 * file, then every batch of jobs (one wall with the rectangles a candidate program draws on it) goes down its stdin and the
 * scores come back on its stdout, every job on its own core. A wall whose rectangles did not change between two candidates
 * is not sent again: its score is kept by the hash of its rectangles (so a knob that moves one wall re-renders that wall only).
 *
 * `wallRects` draws the same rectangles programWallOffset (render-compare.ts) draws, in the same order, and `scoreRectsJs`
 * is the JavaScript reference the kernel is checked against (staged-version-f3.test.ts).
 */

import { spawn, type ChildProcessByStdio } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { Readable, Writable } from 'stream';
import { compileNativeCached, defaultNativeFlags, NativeBuildError, placeCachedBinary } from '../../native-build-cache';
import { findTileRefineRepoRoot } from '../../tile-refine-service';
import type { FaceSweepItem, OpeningItem, SweepItem } from '../pipeline-e/massing-spec';
import { faceToPixel, type MassingFace } from '../pipeline-e/native-massing';
import { compareWall, type WallCompare, type WallEvidence } from './render-compare';

const CLI_SOURCE = path.join('scripts', 'version_f_compare.cpp');
const INCLUDE_DIR = path.join('packages', 'core', 'src', 'native', '3d-engine', 'include');
const BINARY = path.join('build', '3d-native', 'version_f_compare');

/** A pixel rectangle of the offset map: [x0, x1) x [y0, y1) set to `v` (mode 0) or raised to at least `v` (mode 1). */
export interface OffsetRect { x0: number; y0: number; x1: number; y1: number; v: number; mode: 0 | 1 }
export interface CompareJob { face: number; rects: OffsetRect[] }
export interface WallScore { ncc: number; edgeDistM: number; depthMaeM: number; depthWithin015: number; openingShare: number }

let building: Promise<{ path: string; built: boolean; buildMs?: number }> | undefined;

/** Builds build/3d-native/version_f_compare through the native build cache when its sources changed. */
export function ensureCompareBinary(repoRoot = findTileRefineRepoRoot()): Promise<{ path: string; built: boolean; buildMs?: number }> {
    if (process.env.SCRATCHBOX_VERSION_F_COMPARE_BIN) return Promise.resolve({ path: process.env.SCRATCHBOX_VERSION_F_COMPARE_BIN, built: false });
    building ??= (async () => {
        const t0 = Date.now();
        const bin = path.join(repoRoot, BINARY);
        try {
            const built = await compileNativeCached({ sourcePath: path.join(repoRoot, CLI_SOURCE), includeDirs: [path.join(repoRoot, INCLUDE_DIR)], flags: defaultNativeFlags(['-pthread']), name: 'version_f_compare', timeoutMs: 600_000 });
            placeCachedBinary(built.binaryPath, bin);
            return built.cacheHit ? { path: bin, built: false } : { path: bin, built: true, buildMs: Date.now() - t0 };
        } catch (err) {
            throw new Error(`could not build version_f_compare: ${err instanceof NativeBuildError ? err.compilerOutput.slice(-1500) : String(err)}`);
        }
    })().finally(() => { building = undefined; });
    return building;
}

/** The rectangles programWallOffset draws on a wall for a program, in its order (openings set, bands and piers raised). */
export function wallRects(f: MassingFace, openings: OpeningItem[], sweeps: SweepItem[], faceSweeps: FaceSweepItem[]): OffsetRect[] {
    const out: OffsetRect[] = [];
    const rect = (s0: number, s1: number, t0: number, t1: number, v: number, mode: 0 | 1) => {
        const [xa, ya] = faceToPixel(f, s0, t1), [xb, yb] = faceToPixel(f, s1, t0);
        out.push({ x0: Math.round(xa), y0: Math.round(ya), x1: Math.round(xb), y1: Math.round(yb), v, mode });
    };
    for (const o of openings) if (o.face === f.key) rect(o.s0, o.s1, o.t0, o.t1, -o.depth, 0);
    for (const sw of sweeps) if (sw.faces.includes(f.key) && !sw.relativeToTop) {
        const ys = sw.profile.map(q => q[1]), proj = Math.max(...sw.profile.map(q => q[0]));
        if (proj > 0) rect(f.sMin, f.sMax, Math.min(...ys), Math.max(...ys), Math.min(0.8, proj), 1);
    }
    for (const fs of faceSweeps) if (fs.face === f.key && fs.axis === 1) {
        const cs = fs.profile.map(q => q[1]), proj = Math.max(...fs.profile.map(q => q[0]));
        for (const [a0, a1, dc] of fs.placements) rect(dc + Math.min(...cs), dc + Math.max(...cs), a0, a1, Math.min(0.8, proj), 1);
    }
    return out;
}

/** The JavaScript reference: the rectangles drawn on the wall's inside mask, compared as compareWall does. */
export function scoreRectsJs(ev: WallEvidence, inside: Uint8Array, rects: OffsetRect[]): WallCompare {
    const f = ev.tile.face, W = f.width, H = f.height;
    const d = new Float32Array(W * H).fill(NaN);
    for (let i = 0; i < W * H; i++) if (inside[i]) d[i] = 0;
    for (const r of rects) for (let y = Math.max(0, r.y0); y < Math.min(H, r.y1); y++) for (let x = Math.max(0, r.x0); x < Math.min(W, r.x1); x++) {
        const i = y * W + x;
        if (!Number.isFinite(d[i])) continue;
        d[i] = r.mode ? Math.max(d[i], r.v) : r.v;
    }
    return compareWall(ev, d);
}

/** The hash of a wall's rectangles (the key a kept score is found by). */
export function rectsKey(face: number, rects: OffsetRect[]): string {
    const b = Buffer.alloc(rects.length * 24);
    rects.forEach((r, k) => { b.writeInt32LE(r.x0, k * 24); b.writeInt32LE(r.y0, k * 24 + 4); b.writeInt32LE(r.x1, k * 24 + 8); b.writeInt32LE(r.y1, k * 24 + 12); b.writeFloatLE(r.v, k * 24 + 16); b.writeUInt32LE(r.mode, k * 24 + 20); });
    return `${face}:${crypto.createHash('sha1').update(b).digest('hex').slice(0, 20)}`;
}

/** The session file: the walls' evidence as the kernel reads it. */
export function writeSession(file: string, evidence: WallEvidence[], inside: Map<number, Uint8Array>): void {
    const head = Buffer.alloc(12);
    head.write('SBVF', 0, 'latin1'); head.writeUInt32LE(1, 4); head.writeUInt32LE(evidence.length, 8);
    const parts: Buffer[] = [head];
    for (const ev of evidence) {
        const f = ev.tile.face, n = f.width * f.height;
        const h = Buffer.alloc(20);
        h.writeInt32LE(f.index, 0); h.writeInt32LE(f.width, 4); h.writeInt32LE(f.height, 8); h.writeFloatLE(f.pixel, 12); h.writeFloatLE(f.area, 16);
        const ins = inside.get(f.index);
        if (!ins || ins.length !== n) throw new Error(`version F compare: wall ${f.index} has no inside mask of ${n} texels`);
        const f32 = (a: Float32Array) => { if (a.length !== n) throw new Error(`version F compare: wall ${f.index} evidence of ${a.length} texels, not ${n}`); return Buffer.from(a.buffer, a.byteOffset, a.byteLength); };
        parts.push(h, f32(ev.tile.luma), f32(ev.dark), f32(ev.edgeDist), f32(ev.tile.depth), Buffer.from(ins.buffer, ins.byteOffset, ins.byteLength));
    }
    fs.writeFileSync(file, Buffer.concat(parts));
}

/**
 * One kernel process over a session. `score` takes a batch of jobs and answers in the same order; a job whose rectangles
 * were scored before (same wall, same rectangles) is answered from memory without going to the process.
 */
export class NativeCompare {
    private proc: ChildProcessByStdio<Writable, Readable, Readable>;
    private pending: Array<{ n: number; resolve: (b: Buffer) => void; reject: (e: Error) => void }> = [];
    private chunks: Buffer[] = [];
    private buffered = 0;
    private stderr = '';
    private exited: string | undefined;
    private readonly kept = new Map<string, WallScore>();
    /** Jobs sent to the process and jobs answered from memory (diagnostics). */
    readonly counts = { sent: 0, kept: 0, batches: 0 };
    private queue: Promise<unknown> = Promise.resolve();

    private constructor(proc: ChildProcessByStdio<Writable, Readable, Readable>, readonly sessionFile: string, readonly binary: { path: string; built: boolean }) {
        this.proc = proc;
        proc.stdout.on('data', (b: Buffer) => { this.chunks.push(b); this.buffered += b.length; this.drain(); });
        proc.stderr.on('data', (b: Buffer) => { this.stderr = (this.stderr + b.toString()).slice(-4000); });
        proc.on('exit', (code, signal) => { this.exited = `version_f_compare exited (${code ?? signal}): ${this.stderr.trim().split('\n').pop() ?? ''}`; for (const p of this.pending.splice(0)) p.reject(new Error(this.exited)); });
        proc.on('error', err => { this.exited = `version_f_compare failed to start: ${err.message}`; for (const p of this.pending.splice(0)) p.reject(new Error(this.exited)); });
    }

    /** Writes the session and starts the process (the binary built through the native build cache when needed). */
    static async open(dir: string, evidence: WallEvidence[], inside: Map<number, Uint8Array>, threads?: number): Promise<NativeCompare> {
        const binary = await ensureCompareBinary();
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, 'compare_session.bin');
        writeSession(file, evidence, inside);
        const proc = spawn(binary.path, threads ? [file, String(threads)] : [file], { stdio: ['pipe', 'pipe', 'pipe'] });
        const nc = new NativeCompare(proc, file, binary);
        // the process announces the loaded session on stderr; a session it cannot read ends it with the error
        await new Promise<void>((resolve, reject) => {
            const check = () => {
                if (nc.exited) { reject(new Error(nc.exited)); return; }
                if (/"ok":true/.test(nc.stderr)) { resolve(); return; }
                if (/"ok":false/.test(nc.stderr)) { reject(new Error(nc.stderr.trim())); return; }
                setTimeout(check, 5);
            };
            check();
        });
        return nc;
    }

    private drain(): void {
        while (this.pending.length && this.buffered >= this.pending[0].n) {
            const want = this.pending[0].n;
            const all = Buffer.concat(this.chunks, this.buffered);
            const head = all.subarray(0, want), rest = all.subarray(want);
            this.chunks = rest.length ? [Buffer.from(rest)] : [];
            this.buffered = rest.length;
            this.pending.shift()!.resolve(Buffer.from(head));
        }
    }

    /** Scores the jobs (in order). Jobs with the same wall and rectangles share one evaluation. */
    score(jobs: CompareJob[]): Promise<WallScore[]> {
        const run = async (): Promise<WallScore[]> => {
            if (this.exited) throw new Error(this.exited);
            const out: WallScore[] = new Array(jobs.length);
            const send: Array<{ id: number; job: CompareJob; key: string }> = [];
            const seen = new Map<string, number>();
            jobs.forEach((job, k) => {
                const key = rectsKey(job.face, job.rects);
                const had = this.kept.get(key);
                if (had) { out[k] = had; this.counts.kept++; return; }
                const first = seen.get(key);
                if (first !== undefined) { this.counts.kept++; return; }
                seen.set(key, k);
                send.push({ id: send.length, job, key });
            });
            if (send.length) {
                let bytes = 4;
                for (const s of send) bytes += 12 + s.job.rects.length * 24;
                const b = Buffer.alloc(bytes);
                let o = 0;
                b.writeUInt32LE(send.length, o); o += 4;
                for (const s of send) {
                    b.writeUInt32LE(s.id, o); b.writeInt32LE(s.job.face, o + 4); b.writeUInt32LE(s.job.rects.length, o + 8); o += 12;
                    for (const r of s.job.rects) { b.writeInt32LE(r.x0, o); b.writeInt32LE(r.y0, o + 4); b.writeInt32LE(r.x1, o + 8); b.writeInt32LE(r.y1, o + 12); b.writeFloatLE(r.v, o + 16); b.writeUInt32LE(r.mode, o + 20); o += 24; }
                }
                const answer = await new Promise<Buffer>((resolve, reject) => {
                    this.pending.push({ n: 4 + send.length * 24, resolve, reject });
                    this.proc.stdin.write(b, err => { if (err) reject(new Error(`version_f_compare stdin: ${err.message}`)); });
                });
                const n = answer.readUInt32LE(0);
                if (n !== send.length) throw new Error(`version_f_compare answered ${n} jobs for ${send.length}`);
                for (let k = 0; k < n; k++) {
                    const p = 4 + k * 24, id = answer.readUInt32LE(p);
                    const s: WallScore = { ncc: answer.readFloatLE(p + 4), edgeDistM: answer.readFloatLE(p + 8), depthMaeM: answer.readFloatLE(p + 12), depthWithin015: answer.readFloatLE(p + 16), openingShare: answer.readFloatLE(p + 20) };
                    this.kept.set(send[id].key, s);
                }
                this.counts.sent += n; this.counts.batches++;
            }
            jobs.forEach((job, k) => { if (!out[k]) out[k] = this.kept.get(rectsKey(job.face, job.rects))!; });
            return out;
        };
        const p = this.queue.then(run, run);
        this.queue = p.catch(() => undefined);
        return p;
    }

    close(): void {
        try { this.proc.stdin.end(); } catch { /* already closed */ }
        setTimeout(() => { try { if (this.proc.exitCode === null) this.proc.kill('SIGKILL'); } catch { /* gone */ } }, 2000).unref();
        try { fs.rmSync(this.sessionFile, { force: true }); } catch { /* best effort */ }
    }
}
