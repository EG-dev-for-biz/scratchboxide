/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Real height in the native engine: surfaces tessellated and displaced by their material's relief
 * (scratchbox_height_displace.hpp behind scripts/height_displace_native.cpp, built through the native build cache). The
 * geometry is made in C++ (AGENTS.md section 3.1); this file only carries the patches to the kernel and back. A failed
 * build or run throws; there is no fallback.
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { compileNativeCached, defaultNativeFlags, NativeBuildError } from './native-build-cache';

export type HeightDisplaceErrorCode = 'build_failed' | 'run_failed' | 'invalid_output';

export class HeightDisplaceError extends Error {
    constructor(public readonly code: HeightDisplaceErrorCode, message: string) {
        super(message);
        this.name = 'HeightDisplaceError';
    }
}

/** A recess tile: one byte a texel, 255 the surface and 0 a recess of the request's depth; it repeats every sizeM. */
export interface ReliefTile { width: number; height: number; values: Uint8Array; sizeM: [number, number] }

/** One class a texel over a patch's UVs, and optionally the share of the relief each texel takes (0..255: it fades toward a class's border). */
export interface ReliefClassMap { width: number; height: number; classes: Uint8Array; weights?: Uint8Array }

export interface DisplacePatch {
    positions: Float32Array; normals: Float32Array; uvs: Float32Array; indices: Uint32Array;
    /** The class of each UV: an index into the request's class maps, or one class for the whole patch. */
    classMap?: number; constClass?: number;
    /** Metres one UV unit spans (u, v). */
    uvMetres: [number, number];
}

export interface DisplaceRequest {
    /** By class index; undefined for a class with no relief. */
    tiles: Array<ReliefTile | undefined>;
    classMaps: ReliefClassMap[];
    patches: DisplacePatch[];
    /** The recess a tile's 0 means, metres. */
    depthM: number;
    /** No edge split shorter than edgeMinM; every edge longer than edgeMaxM split; between, where the relief leaves the edge's chord by more than toleranceM. */
    edgeMinM: number; edgeMaxM: number; toleranceM: number;
    /** The displacement fades to nothing over this distance from a patch's border and seams, metres. */
    fadeM: number;
    /** All patches together hold at most this many triangles: the least edge is raised until they do. */
    maxTriangles: number;
    threads?: number; timeoutMs?: number;
}

export interface DisplacedPatch {
    positions: Float32Array; normals: Float32Array; uvs: Float32Array; indices: Uint32Array;
    surfaceTriangles: number; riserTriangles: number; limited: boolean;
    maxRecessM: number; meanRecessM: number;
}

export interface DisplaceResult { edgeMinM: number; patches: DisplacedPatch[] }

const CLI_SOURCE = path.join('scripts', 'height_displace_native.cpp');
const INCLUDE_DIR = path.join('packages', 'core', 'src', 'native', '3d-engine', 'include');
const MAGIC = 0x44484253, VERSION = 2;

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
    throw new HeightDisplaceError('build_failed', `${CLI_SOURCE} not found above ${__dirname} or ${process.cwd()}`);
}

let building: Promise<string> | undefined;

/** The kernel's binary, built through the native build cache when its sources changed. */
export function ensureHeightDisplaceBinary(): Promise<string> {
    if (building) return building;
    building = (async () => {
        const root = repoRoot();
        try {
            return (await compileNativeCached({ sourcePath: path.join(root, CLI_SOURCE), includeDirs: [path.join(root, INCLUDE_DIR)], flags: defaultNativeFlags(), name: 'height_displace_native', timeoutMs: 300_000 })).binaryPath;
        } catch (err) {
            building = undefined;
            throw new HeightDisplaceError('build_failed', `could not build height_displace_native: ${err instanceof NativeBuildError ? err.compilerOutput.slice(-1500) : String(err)}`);
        }
    })();
    return building;
}

const bytesOf = (a: Float32Array | Uint32Array | Float64Array | Uint8Array) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
const u32 = (...v: number[]) => bytesOf(Uint32Array.from(v));
const f64 = (...v: number[]) => bytesOf(Float64Array.from(v));

/** Tessellates and displaces every patch (see the file comment and the kernel's header). */
export async function displaceByHeight(req: DisplaceRequest): Promise<DisplaceResult> {
    if (os.endianness() !== 'LE') throw new HeightDisplaceError('run_failed', 'the native height displace layout is little-endian');
    const bin = await ensureHeightDisplaceBinary();
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sb-height-displace-'));
    try {
        const reqFile = path.join(dir, 'request.bin'), resFile = path.join(dir, 'result.bin');
        const parts: Uint8Array[] = [u32(MAGIC, VERSION, Math.max(0, Math.floor(req.threads ?? 0))), f64(req.depthM, req.edgeMinM, req.edgeMaxM, req.toleranceM, req.fadeM), u32(req.maxTriangles), u32(req.tiles.length)];
        for (const t of req.tiles) {
            if (t && t.values.length !== t.width * t.height) throw new HeightDisplaceError('run_failed', `a relief tile's values (${t.values.length}) do not match its ${t.width} x ${t.height} size`);
            parts.push(u32(t?.width ?? 0, t?.height ?? 0), t?.values ?? new Uint8Array(0), f64(t?.sizeM[0] ?? 1, t?.sizeM[1] ?? 1));
        }
        parts.push(u32(req.classMaps.length));
        for (const c of req.classMaps) parts.push(u32(c.width, c.height), c.classes, Uint8Array.of(c.weights ? 1 : 0), c.weights ?? new Uint8Array(0));
        parts.push(u32(req.patches.length));
        for (const p of req.patches) {
            const V = p.positions.length / 3;
            if (p.normals.length !== V * 3 || p.uvs.length !== V * 2) throw new HeightDisplaceError('run_failed', 'a patch needs a normal and a UV for every vertex');
            parts.push(u32(p.classMap ?? 0xffffffff, p.constClass ?? 0), f64(p.uvMetres[0], p.uvMetres[1]), u32(V), bytesOf(p.positions), bytesOf(p.normals), bytesOf(p.uvs), u32(p.indices.length), bytesOf(p.indices));
        }
        const fh = await fs.promises.open(reqFile, 'w');
        try { for (const p of parts) await fh.write(p); } finally { await fh.close(); }
        await new Promise<void>((resolve, reject) => {
            execFile(bin, [reqFile, resFile], { timeout: req.timeoutMs ?? 600_000, maxBuffer: 1 << 20, windowsHide: true }, (err, _stdout, stderr) => {
                if (err) reject(new HeightDisplaceError('run_failed', `height_displace_native failed: ${String(stderr || err.message).trim().slice(-1500)}`));
                else resolve();
            });
        });
        const buf = await fs.promises.readFile(resFile);
        const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        let at = 0;
        const need = (n: number) => { if (at + n > buf.length) throw new HeightDisplaceError('invalid_output', `height_displace_native wrote a result truncated at byte ${at}`); };
        const rU32 = () => { need(4); const v = dv.getUint32(at, true); at += 4; return v; };
        const rF64 = () => { need(8); const v = dv.getFloat64(at, true); at += 8; return v; };
        const rU8 = () => { need(1); return dv.getUint8(at++); };
        const copy = (n: number) => { need(n); const out = new Uint8Array(n); out.set(buf.subarray(at, at + n)); at += n; return out; };
        if (rU32() !== MAGIC || rU32() !== VERSION) throw new HeightDisplaceError('invalid_output', 'height_displace_native wrote a result with the wrong header');
        const edgeMinM = rF64();
        if (rU32() !== req.patches.length) throw new HeightDisplaceError('invalid_output', 'height_displace_native returned the wrong number of patches');
        const patches = req.patches.map((): DisplacedPatch => {
            const surfaceTriangles = rU32(), riserTriangles = rU32(), limited = rU8() === 1, maxRecessM = rF64(), meanRecessM = rF64(), V = rU32();
            const positions = new Float32Array(copy(V * 12).buffer), normals = new Float32Array(copy(V * 12).buffer), uvs = new Float32Array(copy(V * 8).buffer);
            const indices = new Uint32Array(copy(rU32() * 4).buffer);
            return { positions, normals, uvs, indices, surfaceTriangles, riserTriangles, limited, maxRecessM, meanRecessM };
        });
        if (at !== buf.length) throw new HeightDisplaceError('invalid_output', `height_displace_native wrote ${buf.length - at} unread bytes`);
        return { edgeMinM, patches };
    } finally {
        await fs.promises.rm(dir, { recursive: true, force: true });
    }
}
