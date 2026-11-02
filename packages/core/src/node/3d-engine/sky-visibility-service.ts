/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Sky visibility at points: the native kernel (scratchbox_bvh.hpp skyVisibility) behind its CLI driver
 * (scripts/sky_visibility.cpp), built through the native build cache. Each sample is a point and the unit normal of the
 * side it looks from; its value is the share of its cosine-weighted hemisphere rays (those not pointing below the
 * horizon) that leave the mesh unblocked within maxRayM. Rays are a deterministic Fibonacci spiral, so a run repeats.
 *
 * The mesh and samples go to the driver as raw float32 / uint32 files in a private temp directory, removed afterwards.
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { compileNativeCached, defaultNativeFlags, NativeBuildError, placeCachedBinary } from './native-build-cache';
import { findTileRefineRepoRoot } from './tile-refine-service';

export type SkyVisibilityErrorCode = 'bad_request' | 'build_failed' | 'run_failed' | 'invalid_output';

export class SkyVisibilityError extends Error {
    constructor(public readonly code: SkyVisibilityErrorCode, message: string) {
        super(message);
        this.name = 'SkyVisibilityError';
    }
}

export interface SkyVisibilityRequest {
    /** The occluders: x y z per vertex, and three vertex indices per triangle. */
    positions: Float32Array;
    indices: Uint32Array;
    /** Per sample: the point (x y z), then the unit normal of the side it looks from. */
    samples: Float32Array;
    /** Rays per sample (default 48). */
    rays?: number;
    /** A ray unblocked this far sees sky (default 300 m). */
    maxRayM?: number;
    /** Rays start this far off the surface along the normal, and hits nearer than minHitM along a ray are ignored (default 0.05 m each). */
    originOffsetM?: number;
    minHitM?: number;
    /** Rays whose direction y is under this are not counted (default -0.02). */
    minDirY?: number;
    /** Worker threads (default: all cores). */
    threads?: number;
    /** Longest the run may take, not counting a first-use build (default 300 s). */
    timeoutMs?: number;
    /** Where scripts/sky_visibility.cpp and the engine headers live (default: discovered). */
    repoRoot?: string;
}

export interface SkyVisibilityResult {
    /** Per sample, in [0, 1]. */
    visibility: Float32Array;
    triangles: number;
    ms: { load: number; build: number; cast: number };
}

const CLI_SOURCE = path.join('scripts', 'sky_visibility.cpp');
const INCLUDE_DIR = path.join('packages', 'core', 'src', 'native', '3d-engine', 'include');
const BINARY = path.join('build', '3d-native', 'sky_visibility');
let building: Promise<string> | undefined;

/** Builds build/3d-native/sky_visibility through the native build cache when its sources changed. */
export function ensureSkyVisibilityBinary(repoRoot = findTileRefineRepoRoot()): Promise<string> {
    if (process.env.SCRATCHBOX_SKY_VISIBILITY_BIN) return Promise.resolve(process.env.SCRATCHBOX_SKY_VISIBILITY_BIN);
    if (building) return building;
    building = (async () => {
        const bin = path.join(repoRoot, BINARY);
        try {
            const built = await compileNativeCached({ sourcePath: path.join(repoRoot, CLI_SOURCE), includeDirs: [path.join(repoRoot, INCLUDE_DIR)], flags: defaultNativeFlags(['-pthread']), name: 'sky_visibility', timeoutMs: 300_000 });
            placeCachedBinary(built.binaryPath, bin);
            return bin;
        } catch (err) {
            throw new SkyVisibilityError('build_failed', `could not build sky_visibility: ${err instanceof NativeBuildError ? err.compilerOutput.slice(-1500) : String(err)}`);
        }
    })().finally(() => { building = undefined; });
    return building;
}

function writeTyped(file: string, a: Float32Array | Uint32Array): void {
    fs.writeFileSync(file, Buffer.from(a.buffer, a.byteOffset, a.byteLength));
}

/** Sky visibility at every sample of the request. */
export async function runSkyVisibility(req: SkyVisibilityRequest): Promise<SkyVisibilityResult> {
    if (req.positions.length % 3) throw new SkyVisibilityError('bad_request', 'positions must hold x y z per vertex');
    if (req.indices.length % 3) throw new SkyVisibilityError('bad_request', 'indices must hold three per triangle');
    if (req.samples.length % 6) throw new SkyVisibilityError('bad_request', 'samples must hold a point and a normal each');
    const nv = req.positions.length / 3;
    for (let i = 0; i < req.indices.length; i++) if (req.indices[i] >= nv) throw new SkyVisibilityError('bad_request', `index ${req.indices[i]} is past the ${nv} vertices`);
    const ns = req.samples.length / 6;
    if (!ns) return { visibility: new Float32Array(0), triangles: req.indices.length / 3, ms: { load: 0, build: 0, cast: 0 } };
    const bin = await ensureSkyVisibilityBinary(req.repoRoot);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-sky-visibility-'));
    try {
        const file = (name: string) => path.join(dir, name);
        writeTyped(file('p.f32'), req.positions);
        writeTyped(file('i.u32'), req.indices);
        writeTyped(file('s.f32'), req.samples);
        const args = ['--positions', file('p.f32'), '--indices', file('i.u32'), '--samples', file('s.f32'), '--out', file('v.f32')];
        const opt: Array<[string, number | undefined]> = [['--rays', req.rays], ['--max-ray', req.maxRayM], ['--origin-offset', req.originOffsetM], ['--min-hit', req.minHitM], ['--min-dir-y', req.minDirY], ['--threads', req.threads]];
        for (const [flag, value] of opt) if (value !== undefined) {
            if (!Number.isFinite(value)) throw new SkyVisibilityError('bad_request', `${flag} must be a finite number`);
            args.push(flag, String(value));
        }
        const stdout = await new Promise<string>((resolve, reject) => {
            execFile(bin, args, { timeout: req.timeoutMs ?? 300_000, maxBuffer: 1024 * 1024, windowsHide: true }, (err, out, stderr) => {
                if (err) reject(new SkyVisibilityError('run_failed', `sky_visibility failed: ${String(stderr || err.message).trim().slice(-1500)}`));
                else resolve(out);
            });
        });
        let report: any;
        try { report = JSON.parse(stdout.trim().split('\n').pop() ?? ''); } catch { throw new SkyVisibilityError('invalid_output', 'sky_visibility printed no JSON report'); }
        if (report?.ok !== true || report.samples !== ns) throw new SkyVisibilityError('invalid_output', `sky_visibility reported ${report?.samples} samples, sent ${ns}`);
        const bytes = fs.readFileSync(file('v.f32'));
        if (bytes.byteLength !== ns * 4) throw new SkyVisibilityError('invalid_output', `sky_visibility wrote ${bytes.byteLength} bytes for ${ns} samples`);
        const visibility = new Float32Array(ns);
        new Uint8Array(visibility.buffer).set(bytes);
        return { visibility, triangles: Number(report.triangles) || 0, ms: { load: Number(report.ms?.load) || 0, build: Number(report.ms?.build) || 0, cast: Number(report.ms?.cast) || 0 } };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}
