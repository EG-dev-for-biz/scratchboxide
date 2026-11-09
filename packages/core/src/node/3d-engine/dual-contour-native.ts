/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Dual contouring with sharp features (scratchbox_dual_contour.hpp behind scripts/dual_contour_native.cpp, built
 * through the native build cache): meshes a sparse field saved by buildSparseField (sparse-field-native.ts) into a
 * closed, oriented 2-manifold of quads and their triangles. Given the source mesh, the Hermite normals come from its
 * nearest triangles, which keeps corners and creases sharp; adaptive simplification merges cells whose surface stays
 * within a tolerance. Geometry stays in C++ (AGENTS.md section 3.1); a failed build or run throws.
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { compileNativeCached, defaultNativeFlags, NativeBuildError } from './native-build-cache';

export type DualContourErrorCode = 'build_failed' | 'run_failed' | 'invalid_input' | 'invalid_output';

export class DualContourError extends Error {
    constructor(public readonly code: DualContourErrorCode, message: string) {
        super(message);
        this.name = 'DualContourError';
    }
}

export interface DualContourRequest {
    /** A field saved by buildSparseField (SBSF v1). */
    fieldPath: string;
    /** The mesh the field was built from, for sharp normals (optional: without it the field's gradient is used). */
    positions?: Float32Array;
    indices?: Uint32Array;
    /** QEF eigenvalues below this share of the largest are dropped (default 0.1). */
    qefTruncation?: number;
    /** Mesh normals from triangles within this distance of a crossing (metres; default the field's voxel). */
    normalMaxM?: number;
    /** false: vertices at the crossings' mass points, no sharp features (default true). */
    sharp?: boolean;
    /** Adaptive simplification tolerance (metres RMS distance to the merged cells' planes; default 0: off). */
    simplifyToleranceM?: number;
    threads?: number;
    timeoutMs?: number;
}

export interface DualContourReport {
    stats: {
        cells: number; patches: number; multiPatchCells: number; crossingEdges: number;
        meshNormals: number; fieldNormals: number; clamped: number;
        vertices: number; quads: number; triangles: number; degenerateQuads: number;
        clusters: number; clusteredVertices: number;
        ms: { cells: number; simplify: number; quads: number };
    };
    /** Edge audit of the triangles: a closed manifold has no open, non-manifold or misoriented edges. */
    audit: { edges: number; openEdges: number; nonManifoldEdges: number; misorientedEdges: number; components: number; euler: number };
    ms: number;
}

export interface DualContourResult {
    report: DualContourReport;
    positions: Float32Array;
    /** Four indices per quad, outward winding. */
    quads: Uint32Array;
    triangles: Uint32Array;
}

const CLI_SOURCE = path.join('scripts', 'dual_contour_native.cpp');
const INCLUDE_DIR = path.join('packages', 'core', 'src', 'native', '3d-engine', 'include');
const REQ_MAGIC = 0x51434453, RES_MAGIC = 0x52434453, VERSION = 1;

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
    throw new DualContourError('build_failed', `${CLI_SOURCE} not found above ${__dirname} or ${process.cwd()}`);
}

let building: Promise<string> | undefined;

/** The kernel's binary, built through the native build cache when its sources changed. */
export function ensureDualContourBinary(): Promise<string> {
    if (building) return building;
    building = (async () => {
        const root = repoRoot();
        try {
            return (await compileNativeCached({ sourcePath: path.join(root, CLI_SOURCE), includeDirs: [path.join(root, INCLUDE_DIR)], flags: defaultNativeFlags(), libs: ['-lz'], name: 'dual_contour_native', timeoutMs: 600_000 })).binaryPath;
        } catch (err) {
            building = undefined;
            throw new DualContourError('build_failed', `could not build dual_contour_native: ${err instanceof NativeBuildError ? err.compilerOutput.slice(-1500) : String(err)}`);
        }
    })();
    return building;
}

const bytesOf = (a: Float32Array | Uint32Array | Float64Array | Uint8Array) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
const u32 = (...v: number[]) => bytesOf(Uint32Array.from(v));
const f64 = (...v: number[]) => bytesOf(Float64Array.from(v));

/** Meshes a saved sparse field (see the file comment). */
export async function contourSparseField(req: DualContourRequest): Promise<DualContourResult> {
    if (os.endianness() !== 'LE') throw new DualContourError('run_failed', 'the native dual contour layout is little-endian');
    if (!fs.existsSync(req.fieldPath)) throw new DualContourError('invalid_input', `no field at ${req.fieldPath}`);
    const positions = req.positions ?? new Float32Array(0), indices = req.indices ?? new Uint32Array(0);
    if (positions.length % 3 !== 0 || indices.length % 3 !== 0) throw new DualContourError('invalid_input', 'positions and indices must hold three values per vertex and per triangle');
    const V = positions.length / 3;
    for (let i = 0; i < indices.length; i++) if (indices[i] >= V) throw new DualContourError('invalid_input', `index ${indices[i]} is past the ${V} vertices`);
    if ((req.simplifyToleranceM ?? 0) < 0) throw new DualContourError('invalid_input', 'simplifyToleranceM must not be negative');
    const bin = await ensureDualContourBinary();
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sb-dual-contour-'));
    try {
        const reqFile = path.join(dir, 'request.bin'), resFile = path.join(dir, 'result.bin');
        const fp = Buffer.from(path.resolve(req.fieldPath), 'utf8');
        const parts: Uint8Array[] = [
            u32(REQ_MAGIC, VERSION, Math.max(0, Math.floor(req.threads ?? 0))),
            f64(req.qefTruncation ?? 0.1, req.normalMaxM ?? 0), u32(req.sharp === false ? 0 : 1), f64(req.simplifyToleranceM ?? 0),
            u32(fp.length), new Uint8Array(fp), u32(V), bytesOf(positions), u32(indices.length / 3), bytesOf(indices)
        ];
        const fh = await fs.promises.open(reqFile, 'w');
        try { for (const p of parts) await fh.write(p); } finally { await fh.close(); }
        await new Promise<void>((resolve, reject) => {
            execFile(bin, ['run', reqFile, resFile], { timeout: req.timeoutMs ?? 1_800_000, maxBuffer: 1 << 20, windowsHide: true }, (err, _stdout, stderr) => {
                if (err) reject(new DualContourError('run_failed', `dual_contour_native failed: ${String(stderr || err.message).trim().slice(-1500)}`));
                else resolve();
            });
        });
        const buf = await fs.promises.readFile(resFile);
        const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        let at = 0;
        const need = (n: number) => { if (at + n > buf.length) throw new DualContourError('invalid_output', `dual_contour_native wrote a result truncated at byte ${at}`); };
        const rU32 = () => { need(4); const v = dv.getUint32(at, true); at += 4; return v; };
        const copy = (n: number) => { need(n); const out = new Uint8Array(n); out.set(buf.subarray(at, at + n)); at += n; return out.buffer; };
        if (rU32() !== RES_MAGIC || rU32() !== VERSION) throw new DualContourError('invalid_output', 'dual_contour_native wrote a result with the wrong header');
        const jl = rU32();
        need(jl);
        let report: DualContourReport;
        try { report = JSON.parse(buf.subarray(at, at + jl).toString('utf8')) as DualContourReport; } catch (e) { throw new DualContourError('invalid_output', `unreadable report: ${(e as Error).message}`); }
        at += jl;
        const nv = rU32();
        const pos = new Float32Array(copy(nv * 12));
        const nq = rU32();
        const quads = new Uint32Array(copy(nq * 16));
        const nt = rU32();
        const triangles = new Uint32Array(copy(nt * 12));
        return { report, positions: pos, quads, triangles };
    } finally {
        await fs.promises.rm(dir, { recursive: true, force: true });
    }
}
