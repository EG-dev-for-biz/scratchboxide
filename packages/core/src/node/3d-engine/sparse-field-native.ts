/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The sparse narrow-band signed distance field (scratchbox_sparse_field.hpp behind scripts/sparse_field_native.cpp,
 * built through the native build cache). A triangle mesh, open or closed, becomes a field of 8^3-voxel blocks kept only
 * near its surface, signed by its generalised winding number; closings fill gaps narrower than about twice their
 * radius and openings remove parts thinner than that. The field is saved for the stages that mesh or combine it
 * (dual contouring, booleans, offsets), and its signed distance is returned at any query points.
 *
 * Geometry stays in C++ (AGENTS.md section 3.1); this file only carries arrays to the kernel and back. A failed build
 * or run throws; there is no fallback.
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { compileNativeCached, defaultNativeFlags, NativeBuildError } from './native-build-cache';

export type SparseFieldErrorCode = 'build_failed' | 'run_failed' | 'invalid_input' | 'invalid_output';

export class SparseFieldError extends Error {
    constructor(public readonly code: SparseFieldErrorCode, message: string) {
        super(message);
        this.name = 'SparseFieldError';
    }
}

export interface SparseFieldOp {
    op: 'close' | 'open';
    /** Metres: a closing fills gaps narrower than about 2 x radiusM, an opening removes parts thinner than that. */
    radiusM: number;
    /**
     * The grid the morphology runs on before it is merged into the field (metres). Default radiusM / 8 (never finer than
     * the field); the field's own voxel runs it there directly, exact but with memory growing with radiusM / voxel.
     */
    morphVoxelM?: number;
}

export interface SparseFieldRequest {
    /** World positions, xyz per vertex. */
    positions: Float32Array;
    indices: Uint32Array;
    voxelM: number;
    /** Half width of the band in voxels (default 3, at least 2). */
    bandVoxels?: number;
    /** Barnes-Hut opening ratio of the winding number (default 2). */
    windingFarRatio?: number;
    /** Applied in order. */
    ops?: SparseFieldOp[];
    /** Points (xyz) whose signed distance is wanted, after the ops. */
    queries?: Float32Array;
    /** Saves the field (SBSF v1) here. */
    fieldPath?: string;
    threads?: number;
    timeoutMs?: number;
}

export interface SparseFieldBuildReport {
    inputTriangles: number; blocks: number; activeVoxels: number; tiles: number;
    windingEvaluations: number; signGroups: number; splitGroups: number; memoryBytes: number;
    ms: { bin: number; distance: number; sign: number; tiles: number };
}

export interface SparseFieldReport {
    voxelM: number; bandM: number;
    build: SparseFieldBuildReport;
    /** One entry per op, as the kernel reports it (counts, memory, timings). */
    ops: Array<Record<string, unknown> & { op: 'close' | 'open'; radiusM: number }>;
    blocks: number; activeVoxels: number; tiles: number; memoryBytes: number;
    fieldPath?: string;
    ms: number;
}

export interface SparseFieldResult {
    report: SparseFieldReport;
    /** Signed distance at each query point, metres, negative inside, clamped to +-bandM. */
    values: Float32Array;
    /** 1 where the field itself knew the point; 0 where its sign came from the winding number (beyond the band). */
    known: Uint8Array;
}

const CLI_SOURCE = path.join('scripts', 'sparse_field_native.cpp');
const INCLUDE_DIR = path.join('packages', 'core', 'src', 'native', '3d-engine', 'include');
const REQ_MAGIC = 0x51534253, RES_MAGIC = 0x52534253, VERSION = 1;

function repoRoot(): string {
    for (const start of [__dirname, process.cwd()]) {
        let dir = path.resolve(start);
        while (true) {
            if (fs.existsSync(path.join(dir, CLI_SOURCE))) return dir;
            const parent = path.dirname(dir);
            if (parent === dir) break;
            dir = parent;
        }
    }
    throw new SparseFieldError('build_failed', `${CLI_SOURCE} not found above ${__dirname} or ${process.cwd()}`);
}

let building: Promise<string> | undefined;

/** The kernel's binary, built through the native build cache when its sources changed. */
export function ensureSparseFieldBinary(): Promise<string> {
    if (building) return building;
    building = (async () => {
        const root = repoRoot();
        try {
            return (await compileNativeCached({ sourcePath: path.join(root, CLI_SOURCE), includeDirs: [path.join(root, INCLUDE_DIR)], flags: defaultNativeFlags(), libs: ['-lz'], name: 'sparse_field_native', timeoutMs: 300_000 })).binaryPath;
        } catch (err) {
            building = undefined;
            throw new SparseFieldError('build_failed', `could not build sparse_field_native: ${err instanceof NativeBuildError ? err.compilerOutput.slice(-1500) : String(err)}`);
        }
    })();
    return building;
}

const bytesOf = (a: Float32Array | Uint32Array | Float64Array | Uint8Array) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
const u32 = (...v: number[]) => bytesOf(Uint32Array.from(v));
const f64 = (...v: number[]) => bytesOf(Float64Array.from(v));

function validate(req: SparseFieldRequest): void {
    if (!(req.voxelM > 0) || !Number.isFinite(req.voxelM)) throw new SparseFieldError('invalid_input', `voxelM must be a positive number (got ${req.voxelM})`);
    if (req.positions.length % 3 !== 0) throw new SparseFieldError('invalid_input', 'positions must hold xyz per vertex');
    if (req.indices.length % 3 !== 0) throw new SparseFieldError('invalid_input', 'indices must hold three per triangle');
    const V = req.positions.length / 3;
    for (let i = 0; i < req.indices.length; i++) if (req.indices[i] >= V) throw new SparseFieldError('invalid_input', `index ${req.indices[i]} is past the ${V} vertices`);
    if (req.queries && req.queries.length % 3 !== 0) throw new SparseFieldError('invalid_input', 'queries must hold xyz per point');
    for (const o of req.ops ?? []) {
        if (o.op !== 'close' && o.op !== 'open') throw new SparseFieldError('invalid_input', `unknown op ${String(o.op)}`);
        if (!(o.radiusM > 0)) throw new SparseFieldError('invalid_input', `a ${o.op} needs a positive radiusM`);
        if (o.morphVoxelM !== undefined && !(o.morphVoxelM > 0)) throw new SparseFieldError('invalid_input', 'morphVoxelM must be positive');
    }
    if ((req.bandVoxels ?? 3) < 2) throw new SparseFieldError('invalid_input', 'bandVoxels must be at least 2');
}

/** Builds the field, applies the ops, saves it when asked and samples it at the query points (see the file comment). */
export async function buildSparseField(req: SparseFieldRequest): Promise<SparseFieldResult> {
    if (os.endianness() !== 'LE') throw new SparseFieldError('run_failed', 'the native sparse field layout is little-endian');
    validate(req);
    const bin = await ensureSparseFieldBinary();
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sb-sparse-field-'));
    try {
        const reqFile = path.join(dir, 'request.bin'), resFile = path.join(dir, 'result.bin');
        const ops = req.ops ?? [];
        const queries = req.queries ?? new Float32Array(0);
        const fieldPath = Buffer.from(req.fieldPath ? path.resolve(req.fieldPath) : '', 'utf8');
        const parts: Uint8Array[] = [
            u32(REQ_MAGIC, VERSION, Math.max(0, Math.floor(req.threads ?? 0))),
            f64(req.voxelM), u32(Math.floor(req.bandVoxels ?? 3)), f64(req.windingFarRatio ?? 2),
            u32(req.positions.length / 3), bytesOf(req.positions), u32(req.indices.length / 3), bytesOf(req.indices),
            u32(ops.length)
        ];
        for (const o of ops) parts.push(u32(o.op === 'close' ? 0 : 1), f64(o.radiusM), f64(o.morphVoxelM ?? Math.max(req.voxelM, o.radiusM / 8)));
        parts.push(u32(queries.length / 3), bytesOf(queries), u32(fieldPath.length), new Uint8Array(fieldPath));
        const fh = await fs.promises.open(reqFile, 'w');
        try { for (const p of parts) await fh.write(p); } finally { await fh.close(); }
        await new Promise<void>((resolve, reject) => {
            execFile(bin, ['run', reqFile, resFile], { timeout: req.timeoutMs ?? 1_800_000, maxBuffer: 1 << 20, windowsHide: true }, (err, _stdout, stderr) => {
                if (err) reject(new SparseFieldError('run_failed', `sparse_field_native failed: ${String(stderr || err.message).trim().slice(-1500)}`));
                else resolve();
            });
        });
        const buf = await fs.promises.readFile(resFile);
        const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        let at = 0;
        const need = (n: number) => { if (at + n > buf.length) throw new SparseFieldError('invalid_output', `sparse_field_native wrote a result truncated at byte ${at}`); };
        const rU32 = () => { need(4); const v = dv.getUint32(at, true); at += 4; return v; };
        if (rU32() !== RES_MAGIC || rU32() !== VERSION) throw new SparseFieldError('invalid_output', 'sparse_field_native wrote a result with the wrong header');
        const jl = rU32();
        need(jl);
        let report: SparseFieldReport;
        try { report = JSON.parse(buf.subarray(at, at + jl).toString('utf8')) as SparseFieldReport; } catch (e) { throw new SparseFieldError('invalid_output', `sparse_field_native wrote an unreadable report: ${(e as Error).message}`); }
        at += jl;
        const Q = rU32();
        if (Q !== queries.length / 3) throw new SparseFieldError('invalid_output', 'sparse_field_native returned the wrong number of query values');
        need(Q * 5);
        const values = new Float32Array(Q), known = new Uint8Array(Q);
        for (let i = 0; i < Q; i++) values[i] = dv.getFloat32(at + 4 * i, true);
        at += 4 * Q;
        known.set(buf.subarray(at, at + Q));
        return { report, values, known };
    } finally {
        await fs.promises.rm(dir, { recursive: true, force: true });
    }
}
