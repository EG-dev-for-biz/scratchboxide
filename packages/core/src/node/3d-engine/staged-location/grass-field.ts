/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Grass blades over the ground a grass mask (grass-detect.ts) marks as grass, as instanced meshes: the native grass field
 * (scratchbox_grass_field.hpp over GrassClumpGenerator) builds a few clump variants once and places one instance per
 * blue-noise sample on a grass cell, kept with the cell's confidence, inside a band around a centre (the near ground; the
 * far ground stays the tile photo). Away from the centre the variants come in distance rings with wider, fewer blades, so a
 * blade stays about a pixel wide where the viewer at the centre sees it. The GLB carries one node per variant with EXT_mesh_gpu_instancing (TRANSLATION,
 * ROTATION, SCALE, _COLOR_0 tinted toward the cell's lit photo colour, _CONFIDENCE the cell's mask confidence).
 *
 * Buildings win and water is never grass: cells inside vector building footprints or water areas are excluded, and no
 * clump is placed within its own reach of one, so no blade stands over either in plan. Blades grow only on cells the
 * scan measured (the mask's own grid), never on synthetic terrain, so the terrain gap around the tiles is left alone.
 * Each clump stands on the scan's own surface where the scan has one near the cell's surface (measured), else on the
 * cell's estimate. Blade geometry is generated; its colour is photo-inferred (cells under park crowns, where nothing was
 * seen, take the nearest seen grass colour).
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { compileNativeCached, defaultNativeFlags, NativeBuildError } from '../native-build-cache';
import { findTileRefineRepoRoot } from '../tile-refine-service';
import { GltfBinaryPacker } from '../gltf-binary-packer';
import { GRASS_DETECT_PARAMS, type GrassMask } from './grass-detect';
import type { GroundModel } from '../../spatial/StreetViewSurveyPlanner';

export const GRASS_FIELD_VERSION = 'grass-field/1';

const CLI_SOURCE = path.join('scripts', 'grass_field.cpp');
const INCLUDE_DIR = path.join('packages', 'core', 'src', 'native', '3d-engine', 'include');

/** The field's parameters (scratchbox_grass_field.hpp Params); every one optional, all continuous. */
export interface GrassFieldParams {
    densityPerM2?: number; minConfidence?: number;
    centreX?: number; centreZ?: number; bandRadiusM?: number; maxInstances?: number;
    edgeMarginM?: number; snapM?: number; jitter?: number; scaleMin?: number; scaleMax?: number; heightJitter?: number; tintJitter?: number;
    variants?: number; seed?: number;
    bladeCount?: number; clumpRadius?: number; bladeHeightMin?: number; bladeHeightMax?: number;
    bladeWidthBase?: number; bladeWidthMid?: number; keelDepth?: number; segmentsPerBlade?: number; farSegmentsPerBlade?: number;
    gravityDroop?: number; radialSplay?: number; curlStochasticity?: number; centerHeightBias?: number;
    clumpNormalBlend?: number; senescence?: number;
    /** Radians a pixel spans: blades are widened ring by ring so they stay about a pixel wide away from the centre (0: one ring). */
    pixelAngle?: number; maxWidthScale?: number;
}

export interface GrassFieldReport {
    variants: Array<{ vertices: number; indices: number; meshOffset: number; min: number[]; max: number[]; instances: number; instanceOffset: number; ring: number; widthScale: number; reachM: number }>;
    instances: number;
    instancedTriangles: number;
    reachM: number;
    stats: { strata: number; notGrass: number; lowConfidence: number; outsideBand: number; nearExcluded: number; thinned: number; overBudget: number; snapped: number; unsnapped: number; expected: number; bandGrassM2: number; radiusReachedM: number };
}

export interface GrassFieldVariant {
    positions: Float32Array; normals: Float32Array; colours: Float32Array; indices: Uint32Array;
    translation: Float32Array; rotation: Float32Array; scale: Float32Array; tint: Float32Array; confidence: Float32Array;
    min: number[]; max: number[];
    /** The distance ring the variant is drawn in, and how much wider its blades are than the near ones. */
    ring: number; widthScale: number;
    /** The farthest its blades reach from the anchor in plan at scale 1 (m). */
    reachM: number;
}

export interface GrassField { report: GrassFieldReport; variants: GrassFieldVariant[]; params: GrassFieldParams; ms: number }

let building: Promise<string> | undefined;

/** Builds the tool through the native build cache (rebuilt when its source or a header changes; a failed build throws). */
export function ensureGrassFieldBinary(repoRoot = findTileRefineRepoRoot()): Promise<string> {
    if (process.env.SCRATCHBOX_GRASS_FIELD_BIN) return Promise.resolve(process.env.SCRATCHBOX_GRASS_FIELD_BIN);
    building ??= (async () => {
        try {
            const built = await compileNativeCached({ sourcePath: path.join(repoRoot, CLI_SOURCE), includeDirs: [path.join(repoRoot, INCLUDE_DIR)], flags: defaultNativeFlags(), name: 'grass_field', timeoutMs: 300_000 });
            return built.binaryPath;
        } catch (err) {
            throw new Error(`could not build grass_field: ${err instanceof NativeBuildError ? err.compilerOutput.slice(-1500) : String(err)}`);
        }
    })().finally(() => { building = undefined; });
    return building;
}

/** What the native field reads per cell: the mask, where never to grow, confidence, the surface the blades stand on, the photo colour. */
export interface GrassFieldGrid {
    nx: number; nz: number; x0: number; z0: number; cellM: number;
    mask: Uint8Array; exclude: Uint8Array; confidence: Float32Array; surfaceY: Float32Array; colour: Float32Array;
    /** The scan's triangles over the band (9 floats each), which each clump stands on where one lies near the cell surface. */
    scan?: Float32Array;
}

/** The SBGF input (see scratchbox_grass_field.hpp). */
export function encodeGrassFieldInput(g: GrassFieldGrid): Buffer {
    const N = g.nx * g.nz;
    const scan = g.scan ?? new Float32Array(0);
    const buf = Buffer.alloc(28 + N * 2 + N * 8 + N * 12 + 4 + scan.byteLength);
    buf.write('SBGF', 0, 'ascii');
    buf.writeUInt32LE(2, 4); buf.writeUInt32LE(g.nx, 8); buf.writeUInt32LE(g.nz, 12);
    buf.writeFloatLE(g.x0, 16); buf.writeFloatLE(g.z0, 20); buf.writeFloatLE(g.cellM, 24);
    let o = 28;
    Buffer.from(g.mask.buffer, g.mask.byteOffset, N).copy(buf, o); o += N;
    Buffer.from(g.exclude.buffer, g.exclude.byteOffset, N).copy(buf, o); o += N;
    for (const a of [g.confidence, g.surfaceY, g.colour]) { Buffer.from(a.buffer, a.byteOffset, a.byteLength).copy(buf, o); o += a.byteLength; }
    buf.writeUInt32LE(scan.length / 9, o); o += 4;
    Buffer.from(scan.buffer, scan.byteOffset, scan.byteLength).copy(buf, o);
    return buf;
}

/**
 * The native grid from a grass mask on its ground model: blades stand on the scan's top where the scan saw the ground,
 * and under crowns on the terrain raised as far as the nearest seen ground stands above it; `exclude` is building footprints and water (non-zero per ground cell); a grass cell
 * with no photo colour (under crowns, or filled by the majority filter) takes the nearest seen one.
 */
export function grassFieldGrid(g: GrassMask, ground: GroundModel, exclude: { building?: ArrayLike<number>; water?: ArrayLike<number> }, scan?: Float32Array): GrassFieldGrid {
    const N = g.nx * g.nz;
    if (ground.nx !== g.nx || ground.nz !== g.nz) throw new Error('grass mask and ground model grids differ');
    const ex = new Uint8Array(N), surfaceY = new Float32Array(N).fill(NaN), colour = Float32Array.from(g.colour);
    // the ground the scan saw (its top within a lawn's height of the terrain): its rise above the terrain carries to the
    // hidden cells, since the smooth terrain runs under a park's real ground by a few decimetres
    const seen = (c: number) => Number.isFinite(ground.top[c]) && Number.isFinite(ground.ground[c]) && ground.top[c] - ground.ground[c] <= GRASS_DETECT_PARAMS.maxAboveGroundM;
    const rise = new Float32Array(N);
    for (let c = 0; c < N; c++) {
        if (exclude.building?.[c] || exclude.water?.[c]) ex[c] = 1;
        if (seen(c)) rise[c] = ground.top[c] - ground.ground[c];
    }
    nearestFill(g.nx, g.nz, seen, () => true, (n, c) => { rise[n] = rise[c]; });
    for (let c = 0; c < N; c++) if (g.mask[c]) surfaceY[c] = seen(c) ? ground.top[c] : ground.ground[c] + rise[c];
    // the nearest seen grass colour, carried over any ground (a patch under crowns may touch no seen grass)
    const has = (c: number) => colour[c * 3] > 0 || colour[c * 3 + 1] > 0 || colour[c * 3 + 2] > 0;
    nearestFill(g.nx, g.nz, c => !!g.mask[c] && has(c), () => true, (n, c) => { colour.copyWithin(n * 3, c * 3, c * 3 + 3); });
    for (let c = 0; c < N; c++) if (!g.mask[c]) colour.fill(0, c * 3, c * 3 + 3);
    return { nx: g.nx, nz: g.nz, x0: g.x0, z0: g.z0, cellM: g.cellM, mask: g.mask, exclude: ex, confidence: g.confidence, surfaceY, colour, scan };
}

/** The triangles of an indexed mesh (y up) any corner of which lies within `radiusM` of (cx, cz) in plan, 9 floats each. */
export function scanTrianglesNear(vertices: Float32Array, indices: Uint32Array, cx: number, cz: number, radiusM: number): Float32Array {
    const out: number[] = [], r2 = radiusM * radiusM;
    for (let t = 0; t < indices.length; t += 3) {
        let near = false;
        for (let q = 0; q < 3 && !near; q++) { const v = indices[t + q] * 3; near = (vertices[v] - cx) ** 2 + (vertices[v + 2] - cz) ** 2 <= r2; }
        if (!near) continue;
        for (let q = 0; q < 3; q++) { const v = indices[t + q] * 3; out.push(vertices[v], vertices[v + 1], vertices[v + 2]); }
    }
    return Float32Array.from(out);
}

/** A breadth-first wave from every `source` cell through `through` cells: `take(n, c)` hands cell n the value of its nearest source's c. */
function nearestFill(nx: number, nz: number, source: (c: number) => boolean, through: (c: number) => boolean, take: (n: number, c: number) => void): void {
    const done = new Uint8Array(nx * nz);
    let queue: number[] = [];
    for (let c = 0; c < nx * nz; c++) if (source(c)) { done[c] = 1; queue.push(c); }
    while (queue.length) {
        const next: number[] = [];
        for (const c of queue) {
            const i = c % nx, k = (c / nx) | 0;
            for (const [di, dk] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const ii = i + di, kk = k + dk;
                if (ii < 0 || kk < 0 || ii >= nx || kk >= nz) continue;
                const n = kk * nx + ii;
                if (done[n] || !through(n)) continue;
                done[n] = 1; take(n, c); next.push(n);
            }
        }
        queue = next;
    }
}

/** Runs the native field on `grid` in `dir` (created); throws with the tool's own error. */
export async function buildGrassField(grid: GrassFieldGrid, dir: string, params: GrassFieldParams = {}, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<GrassField> {
    const binary = await ensureGrassFieldBinary();
    fs.mkdirSync(dir, { recursive: true });
    const input = path.join(dir, 'input.sbgf');
    fs.writeFileSync(input, encodeGrassFieldInput(grid));
    const args = [input, dir, ...Object.entries(params).filter(([, v]) => typeof v === 'number' && Number.isFinite(v)).map(([k, v]) => `${k}=${v}`)];
    const t0 = Date.now();
    const stdout = await new Promise<string>((resolve, reject) => {
        execFile(binary, args, { timeout: opts.timeoutMs ?? 300_000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024, ...(opts.signal ? { signal: opts.signal } : {}) }, (err, out, errOut) => {
            if (err) {
                const tail = String(out || errOut || err.message).trim().split('\n').pop() ?? err.message;
                let msg = tail;
                try { msg = JSON.parse(tail).error ?? tail; } catch { /* not JSON */ }
                reject(new Error(`grass_field failed: ${msg}`));
            } else resolve(String(out));
        });
    });
    const head = JSON.parse(stdout.trim().split('\n').pop() ?? '{}');
    if (!head.ok) throw new Error(`grass_field failed: ${head.error ?? 'no answer'}`);
    fs.rmSync(input, { force: true });
    const report = JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8')) as GrassFieldReport;
    const mesh = fs.readFileSync(path.join(dir, 'mesh.bin')), inst = fs.readFileSync(path.join(dir, 'instances.bin'));
    const f32 = (b: Buffer, o: number, n: number) => new Float32Array(b.buffer.slice(b.byteOffset + o, b.byteOffset + o + n * 4));
    const variants = report.variants.map((v): GrassFieldVariant => {
        let o = v.meshOffset;
        const positions = f32(mesh, o, v.vertices * 3); o += v.vertices * 12;
        const normals = f32(mesh, o, v.vertices * 3); o += v.vertices * 12;
        const colours = f32(mesh, o, v.vertices * 4); o += v.vertices * 16;
        const indices = new Uint32Array(mesh.buffer.slice(mesh.byteOffset + o, mesh.byteOffset + o + v.indices * 4));
        const n = v.instances, translation = new Float32Array(n * 3), rotation = new Float32Array(n * 4), scale = new Float32Array(n * 3), tint = new Float32Array(n * 3), confidence = new Float32Array(n);
        const rec = f32(inst, v.instanceOffset, n * 14);
        for (let q = 0; q < n; q++) {
            const r = q * 14;
            translation.set(rec.subarray(r, r + 3), q * 3); rotation.set(rec.subarray(r + 3, r + 7), q * 4);
            scale.set(rec.subarray(r + 7, r + 10), q * 3); tint.set(rec.subarray(r + 10, r + 13), q * 3); confidence[q] = rec[r + 13];
        }
        return { positions, normals, colours, indices, translation, rotation, scale, tint, confidence, min: v.min, max: v.max, ring: v.ring, widthScale: v.widthScale, reachM: v.reachM };
    });
    return { report, variants, params, ms: Date.now() - t0 };
}

/**
 * Writes the field as a GLB: one mesh per clump variant (vertex colours the clump's own tones), one node per variant
 * instanced with EXT_mesh_gpu_instancing. Returns the triangles drawn (instances x clump triangles).
 */
export function writeGrassFieldGlb(file: string, field: GrassField, extras: Record<string, unknown>): number {
    const views: Buffer[] = [], accessors: object[] = [], bufferViews: object[] = [], meshes: object[] = [], nodes: object[] = [];
    const add = (a: Float32Array | Uint32Array, accessor: Record<string, unknown>, target?: number) => {
        views.push(Buffer.from(a.buffer, a.byteOffset, a.byteLength));
        bufferViews.push({ buffer: 0, ...(target ? { target } : {}) });
        accessors.push({ bufferView: bufferViews.length - 1, ...accessor });
        return accessors.length - 1;
    };
    let triangles = 0;
    field.variants.forEach((v, k) => {
        if (!v.translation.length) return;
        const nv = v.positions.length / 3, n = v.confidence.length;
        const POSITION = add(v.positions, { componentType: 5126, count: nv, type: 'VEC3', min: v.min, max: v.max }, 34962);
        const NORMAL = add(v.normals, { componentType: 5126, count: nv, type: 'VEC3' }, 34962);
        const COLOR_0 = add(v.colours, { componentType: 5126, count: nv, type: 'VEC4' }, 34962);
        const indices = add(v.indices, { componentType: 5125, count: v.indices.length, type: 'SCALAR' }, 34963);
        meshes.push({ name: `grass clump ${k}`, primitives: [{ attributes: { POSITION, NORMAL, COLOR_0 }, indices, material: 0, mode: 4 }] });
        const tmin = [Infinity, Infinity, Infinity], tmax = [-Infinity, -Infinity, -Infinity];
        for (let q = 0; q < v.translation.length; q++) { tmin[q % 3] = Math.min(tmin[q % 3], v.translation[q]); tmax[q % 3] = Math.max(tmax[q % 3], v.translation[q]); }
        const attributes = {
            TRANSLATION: add(v.translation, { componentType: 5126, count: n, type: 'VEC3', min: tmin, max: tmax }),
            ROTATION: add(v.rotation, { componentType: 5126, count: n, type: 'VEC4' }),
            SCALE: add(v.scale, { componentType: 5126, count: n, type: 'VEC3' }),
            _COLOR_0: add(v.tint, { componentType: 5126, count: n, type: 'VEC3' }),
            _CONFIDENCE: add(v.confidence, { componentType: 5126, count: n, type: 'SCALAR' })
        };
        let cmin = Infinity, cmax = -Infinity, csum = 0;
        for (const c of v.confidence) { cmin = Math.min(cmin, c); cmax = Math.max(cmax, c); csum += c; }
        nodes.push({ name: `grass clump ${k}`, mesh: meshes.length - 1, extensions: { EXT_mesh_gpu_instancing: { attributes } },
            extras: { ...extras, instances: n, ring: v.ring, bladeWidthScale: v.widthScale, maskConfidence: { mean: csum / n, min: cmin, max: cmax } } });
        triangles += n * v.indices.length / 3;
    });
    const gltf = {
        asset: { version: '2.0', generator: `Scratchbox ${GRASS_FIELD_VERSION}`, extras },
        extensionsUsed: ['EXT_mesh_gpu_instancing'], extensionsRequired: ['EXT_mesh_gpu_instancing'],
        scene: 0, scenes: [{ name: 'grass field', nodes: nodes.map((_, i) => i) }],
        nodes, meshes, accessors, bufferViews,
        materials: [{ name: 'grass blades', pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.85 }, doubleSided: true }]
    };
    GltfBinaryPacker.writeGlb(file, gltf, views);
    return triangles;
}
