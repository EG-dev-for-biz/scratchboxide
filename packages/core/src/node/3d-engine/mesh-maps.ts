/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Maps measured from a mesh's geometry (scratchbox_mesh_maps.hpp through scripts/mesh_maps_bake.cpp, built through the
 * native build cache and run through a pipe): at each query point, the mean curvature at a set radius (H r, convex
 * positive), cavity (0..1), the inward thickness (metres, capped) and ambient occlusion (1 open). They are read, never
 * applied to geometry; whatever a caller draws from them is labelled generated.
 */

import * as path from 'path';
import { spawn } from 'child_process';
import { compileNativeCached, defaultNativeFlags, NativeBuildError } from './native-build-cache';
import { findUvAtlasRepoRoot } from './staged-location/texture-uv';

export interface MeshMapsParams {
    curvatureRadiusM: number;
    cavityRadiusM: number;
    aoRadiusM: number;
    /** 0: no AO (every point reads 1). */
    aoSamples?: number;
    thicknessMaxM: number;
    /** 0: no thickness (every point reads the cap). */
    thicknessSamples?: number;
    thicknessConeDeg?: number;
    samplesPerDisk?: number;
    /** Surface points per set; past it the spacing, and the radius read at, grow (reported). */
    maxSamples?: number;
    rayEpsM?: number;
    /** Ground plane y that occludes like a surface. */
    groundY?: number;
}

export interface MeshMapsInput {
    /** Every surface, 9 floats a triangle: rays hit it and cavity reads it. */
    soup: Float32Array;
    /** The surface curvature reads, each triangle in a group (an object's parts); absent: the soup as one group. */
    grouped?: { soup: Float32Array; groups: Uint32Array };
    /** Query points: position and normal, 6 floats each. */
    points: Float32Array;
    /** Each query's group (with `grouped`). */
    pointGroups?: Uint32Array;
    params: MeshMapsParams;
    threads?: number;
    native?: { binaryPath?: string; repoRoot?: string; timeoutMs?: number };
    signal?: AbortSignal;
}

export interface MeshMapsResult {
    /** 4 floats a query: curvature (H r), cavity, thicknessM, ao. */
    maps: Float32Array;
    /** The radii read at (larger than asked when the point budget forced it) and the surface points used. */
    curvatureRadiusM: number;
    cavityRadiusM: number;
    curvaturePoints: number;
    cavityPoints: number;
    ms: { build: number; bake: number };
}

const CLI_SOURCE = path.join('scripts', 'mesh_maps_bake.cpp');
const INCLUDE_DIR = path.join('packages', 'core', 'src', 'native', '3d-engine', 'include');
let building: Promise<string> | undefined;

/** The mesh-maps binary, built through the native build cache when its source or any header it includes changed. */
export function ensureMeshMapsBinary(repoRoot = findUvAtlasRepoRoot()): Promise<string> {
    if (process.env.SCRATCHBOX_MESH_MAPS_BIN) return Promise.resolve(process.env.SCRATCHBOX_MESH_MAPS_BIN);
    building ??= (async () => {
        try {
            const built = await compileNativeCached({ sourcePath: path.join(repoRoot, CLI_SOURCE), includeDirs: [path.join(repoRoot, INCLUDE_DIR)], flags: defaultNativeFlags(['-pthread']), name: 'mesh_maps_bake', timeoutMs: 600_000 });
            return built.binaryPath;
        } catch (err) {
            throw new Error(`could not build the mesh maps bake: ${err instanceof NativeBuildError ? err.compilerOutput.slice(-1500) : (err as Error).message}`);
        }
    })().finally(() => { building = undefined; });
    return building;
}

function runPipe(binary: string, request: Buffer[], timeoutMs: number, signal?: AbortSignal): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const proc = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        const chunks: Buffer[] = [];
        let err = '';
        const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error(`the mesh maps bake timed out after ${timeoutMs} ms`)); }, timeoutMs);
        const onAbort = () => { clearTimeout(timer); proc.kill('SIGKILL'); reject(signal!.reason instanceof Error ? signal!.reason : Object.assign(new Error('the mesh maps bake was stopped'), { name: 'AbortError' })); };
        if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
        proc.stdout.on('data', (c: Buffer) => chunks.push(c));
        proc.stderr.on('data', (c: Buffer) => { err += c.toString(); });
        proc.on('error', e => { clearTimeout(timer); reject(e); });
        proc.on('close', code => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            if (code !== 0) reject(new Error(`the mesh maps bake exited ${code}: ${err.trim().slice(-800)}`));
            else resolve(Buffer.concat(chunks));
        });
        proc.stdin.on('error', () => { /* reported through close */ });
        for (const b of request) proc.stdin.write(b);
        proc.stdin.end();
    });
}

const u32 = (...v: number[]) => { const b = Buffer.alloc(v.length * 4); v.forEach((x, i) => b.writeUInt32LE(x >>> 0, i * 4)); return b; };
const f64 = (...v: number[]) => { const b = Buffer.alloc(v.length * 8); v.forEach((x, i) => b.writeDoubleLE(x, i * 8)); return b; };
const view = (a: Float32Array | Uint32Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);

/** Bakes the maps at every query point (see the file comment). */
export async function bakeMeshMaps(input: MeshMapsInput): Promise<MeshMapsResult> {
    const { soup, grouped, points, params: P } = input;
    if (soup.length % 9 || points.length % 6) throw new Error('mesh maps: the soup takes 9 floats a triangle and the points 6 a query');
    if (grouped && grouped.soup.length / 9 !== grouped.groups.length) throw new Error('mesh maps: one group per grouped triangle');
    const Q = points.length / 6;
    if (input.pointGroups && input.pointGroups.length !== Q) throw new Error('mesh maps: one group per query point');
    const binary = input.native?.binaryPath ?? await ensureMeshMapsBinary(input.native?.repoRoot);
    const G = grouped ? grouped.groups.length : 0;
    const reply = await runPipe(binary, [
        Buffer.from('SBMM', 'latin1'),
        u32(1, soup.length / 9, G, Q, (P.groundY !== undefined ? 1 : 0) | (input.pointGroups ? 2 : 0), input.threads ?? 0),
        f64(P.curvatureRadiusM, P.cavityRadiusM, P.aoRadiusM, P.aoSamples ?? 16, P.thicknessMaxM, P.thicknessSamples ?? 8, P.thicknessConeDeg ?? 25,
            P.samplesPerDisk ?? 48, P.maxSamples ?? 4_000_000, P.rayEpsM ?? 1e-4, P.groundY ?? 0),
        view(soup), ...(grouped ? [view(grouped.soup), view(grouped.groups)] : []), view(points), ...(input.pointGroups ? [view(input.pointGroups)] : [])
    ], input.native?.timeoutMs ?? 600_000, input.signal);
    if (reply.length < 12 || reply.toString('latin1', 0, 4) !== 'SBMR' || reply.readUInt32LE(4) !== 1) throw new Error('the mesh maps bake returned no SBMR reply');
    if (reply.readUInt32LE(8) !== Q) throw new Error('the mesh maps bake reply does not match its request');
    const info = [0, 1, 2, 3, 4, 5].map(k => reply.readDoubleLE(12 + k * 8));
    const off = 12 + 48;
    if (reply.length !== off + Q * 16) throw new Error('the mesh maps bake reply is truncated');
    const maps = new Float32Array(reply.buffer.slice(reply.byteOffset + off, reply.byteOffset + off + Q * 16));
    return { maps, curvatureRadiusM: info[0], cavityRadiusM: info[1], curvaturePoints: info[2], cavityPoints: info[3], ms: { build: info[4], bake: info[5] } };
}
