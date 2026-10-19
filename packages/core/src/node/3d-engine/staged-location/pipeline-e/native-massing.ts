/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Runs the native massing tool (scripts/staged_massing.cpp, scratchbox_staged_massing.hpp): builds it through the native
 * build cache (rebuilt when its source or a header it includes changes; a failed build is an error, never an older
 * binary), runs it on a spec with a timeout, and reads its outputs: the report, the nodes from mesh.bin, and the faces'
 * orthophotos, depth and protrusion maps on demand.
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { compileNativeCached, defaultNativeFlags, NativeBuildError, placeCachedBinary } from '../../native-build-cache';
import { findTileRefineRepoRoot } from '../../tile-refine-service';
import { decodeImageInMemory } from '../tile-texture-transfer';

export type V3 = [number, number, number];

export interface MassingFace {
    index: number;
    key: string;
    /** 'wall' | 'roof' | 'base' | 'soffit' (open, diagnostic). */
    kind: string;
    part: string;
    loop: number;
    edge: number;
    wall: boolean;
    normal: V3; axisS: V3; axisT: V3; origin: V3;
    sMin: number; sMax: number; tMin: number; tMax: number; tBottom: number; area: number;
    pixel: number; orthoSMin: number; orthoTMax: number; width: number; height: number; coverage: number;
    openings: string[];
    top: Array<[number, number]>;
}

export interface MassingNode {
    name: string;
    /** 'wall' | 'roof' | 'base' | 'opening' | 'sweep' | 'residual' ... (open). */
    kind: string;
    provenance: string;
    confidence: number | null;
    positions: Float32Array;
    normals: Float32Array;
    /** Per vertex: the face whose ortho textures it (>= 0), or -(tile image + 2) for scanned residual. */
    ref: Int32Array;
    /** Per vertex: the face's (s, t), or the tile uv. */
    st: Float32Array;
    indices: Uint32Array;
}

export interface MassingSection { face: number; key: string; image: string; pixel: number; hMin: number; hMax: number; tTop: number; tBottom: number; width: number; height: number; profiles: Array<Array<number | null>> }

export interface MassingReport {
    schema: 'scratchbox.staged-massing/1';
    faces: MassingFace[];
    parts: Array<{ id: string; baseY: number; topY: number; loops: Array<Array<[number, number]>> }>;
    snap: Array<{ part: string; loop: number; edge: number; lengthM: number; offsetM: number; supportShare: number; applied: boolean }>;
    residual: { isolateTriangles: number; surface: number; proud: number; cut: number; apron: number; droppedSmall: number; clusters: Array<{ kind: string; areaM2: number; extremeM: number; triangles: number; lo: V3; hi: V3; opensFace: boolean; face: string; rect: [number, number, number, number] }> };
    signedVolumeM3: number;
    rejectedOpenings: string[];
    rejectedSweeps: string[];
    nodes: Array<{ name: string; kind: string; provenance: string; confidence: number | null; offset: number; vertices: number; indices: number }>;
    images: Array<{ image: number; file: string; mimeType: string }>;
    sections: MassingSection[];
    topdown: { image: string; height: string; x0: number; z0: number; pixel: number; width: number; rows: number } | null;
    notes: string[];
    timingsMs: Record<string, number>;
}

export interface MassingRun { dir: string; report: MassingReport; nodes: MassingNode[]; ms: number; binary: { path: string; built: boolean; buildMs?: number } }

const CLI_SOURCE = path.join('scripts', 'staged_massing.cpp');
const INCLUDE_DIR = path.join('packages', 'core', 'src', 'native', '3d-engine', 'include');
const BINARY = path.join('build', '3d-native', 'staged_massing');

let building: Promise<MassingRun['binary']> | undefined;

/** Builds build/3d-native/staged_massing through the native build cache when its sources changed. */
export function ensureMassingBinary(repoRoot = findTileRefineRepoRoot()): Promise<MassingRun['binary']> {
    if (process.env.SCRATCHBOX_STAGED_MASSING_BIN) return Promise.resolve({ path: process.env.SCRATCHBOX_STAGED_MASSING_BIN, built: false });
    building ??= (async () => {
        const t0 = Date.now();
        const bin = path.join(repoRoot, BINARY);
        try {
            const built = await compileNativeCached({ sourcePath: path.join(repoRoot, CLI_SOURCE), includeDirs: [path.join(repoRoot, INCLUDE_DIR)], flags: defaultNativeFlags(['-pthread']), libs: ['-lz'], name: 'staged_massing', timeoutMs: 600_000 });
            placeCachedBinary(built.binaryPath, bin);
            return built.cacheHit ? { path: bin, built: false } : { path: bin, built: true, buildMs: Date.now() - t0 };
        } catch (err) {
            throw new Error(`could not build staged_massing: ${err instanceof NativeBuildError ? err.compilerOutput.slice(-1500) : String(err)}`);
        }
    })().finally(() => { building = undefined; });
    return building;
}

/** Runs the tool on `specText` in `dir` (created); throws with the tool's own error. */
export async function runMassing(specText: string, dir: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<MassingRun> {
    const binary = await ensureMassingBinary();
    fs.mkdirSync(dir, { recursive: true });
    const specFile = path.join(dir, 'spec.txt');
    fs.writeFileSync(specFile, specText);
    const t0 = Date.now();
    const stdout = await new Promise<string>((resolve, reject) => {
        execFile(binary.path, [specFile], { timeout: opts.timeoutMs ?? 180_000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024, ...(opts.signal ? { signal: opts.signal } : {}) }, (err, out, errOut) => {
            if (err) {
                const tail = String(out || errOut || err.message).trim().split('\n').pop() ?? err.message;
                let msg = tail;
                try { msg = JSON.parse(tail).error ?? tail; } catch { /* not JSON */ }
                reject(new Error(`staged_massing failed: ${msg}`));
            } else resolve(String(out));
        });
    });
    const head = JSON.parse(stdout.trim().split('\n').pop() ?? '{}');
    if (!head.ok) throw new Error(`staged_massing failed: ${head.error ?? 'no answer'}`);
    const report = JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8')) as MassingReport;
    return { dir, report, nodes: readNodes(dir, report), ms: Date.now() - t0, binary };
}

export function readNodes(dir: string, report: MassingReport): MassingNode[] {
    const bin = fs.readFileSync(path.join(dir, 'mesh.bin'));
    const ab = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
    return report.nodes.map(n => {
        let o = n.offset;
        const take = <T>(ctor: new (b: ArrayBuffer, o: number, l: number) => T, count: number): T => { const v = new ctor(ab, o, count); o += count * 4; return v; };
        const positions = take(Float32Array, n.vertices * 3);
        const normals = take(Float32Array, n.vertices * 3);
        const ref = take(Int32Array, n.vertices);
        const st = take(Float32Array, n.vertices * 2);
        const indices = take(Uint32Array, n.indices);
        return { name: n.name, kind: n.kind, provenance: n.provenance, confidence: n.confidence, positions: positions.slice(), normals: normals.slice(), ref: ref.slice(), st: st.slice(), indices: indices.slice() };
    });
}

/** A face's ortho: RGBA (A 255 where the tile covers it), depth and protrusion (metres along the normal, NaN uncovered). */
export interface FaceOrtho { width: number; height: number; rgba: Uint8Array; depth: Float32Array; prot: Float32Array }

export function readFaceOrtho(dir: string, face: Pick<MassingFace, 'index' | 'width' | 'height'>): FaceOrtho | undefined {
    const base = path.join(dir, `face_${face.index}`);
    if (!fs.existsSync(`${base}.png`)) return undefined;
    const img = decodeImageInMemory(fs.readFileSync(`${base}.png`));
    const f32 = (file: string) => { const b = fs.readFileSync(file); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
    return { width: img.width, height: img.height, rgba: img.rgba, depth: f32(`${base}.depth`), prot: f32(`${base}.prot`) };
}

/** Face (s, t) -> ortho pixel (x right, y down). */
export const faceToPixel = (f: Pick<MassingFace, 'orthoSMin' | 'orthoTMax' | 'pixel'>, s: number, t: number): [number, number] => [(s - f.orthoSMin) / f.pixel, (f.orthoTMax - t) / f.pixel];
export const pixelToFace = (f: Pick<MassingFace, 'orthoSMin' | 'orthoTMax' | 'pixel'>, x: number, y: number): [number, number] => [f.orthoSMin + x * f.pixel, f.orthoTMax - y * f.pixel];
