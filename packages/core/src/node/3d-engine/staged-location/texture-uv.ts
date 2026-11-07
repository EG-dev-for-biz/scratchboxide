/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Texture pass, task B: the UV atlas of a staged layer (docs/processes/staged_location_texture_pass_design.md section 3).
 *
 * - Fitted surfaces (a node whose surface id has a plane or cylinder chart) take their UVs from the chart: exact and free.
 *   The chart is used only when it holds the node (every vertex within `chartToleranceM` of chartPoint(u, v)) and does
 *   not fold it (all triangles one orientation in the chart); otherwise the node goes to the island path and the reason
 *   is recorded.
 * - Everything else (the remeshed scan, pass-through regions) is unwrapped by the native island unwrapper
 *   (scripts/uv_atlas.cpp, built with clang++ on first use and run through a pipe; no files): by default charts grown and
 *   flattened by LSCM, ABF++ and SLIM (scratchbox_uv_rewrap.hpp's chart stage); with islandMethod 'orthographic' (or
 *   SCRATCHBOX_TWIN_UV=orthographic) normal-clustered orthographic islands (scratchbox_uv_atlas.hpp).
 * - Charts and islands are packed together into one atlas at one texel density; when they do not fit in `maxSide`, the
 *   density goes down for all of them (the measured density is reported per map).
 * - Every rect carries `gutterTexels` of padding on each side; covered texels are dilated into it (gutter = 1).
 * - The per-texel arrays invert the UV map: world position (node world matrix applied) and geometric normal per texel,
 *   from the chart for fitted surfaces and from the triangle (barycentric) for islands.
 * - Positions are never written: the layout keeps, per twin vertex, the index of the clay vertex it copies, so the
 *   textured twin's positions are the clay bytes.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, execFile } from 'child_process';
import { TILE_REFINE_VERTEX_ATTRIBUTES, type FittedSurface, type SurfaceChart, type Vec3 } from '../../../common/spatial/staged-location-contracts';
import type { BuildUvAtlas, SurfaceUvMap, UvAtlas, UvAtlasInput } from '../../../common/spatial/texture-pass-contracts';
import { chartPoint } from './slot-projection';
import { nodeWorldMatrices, parseGlbBytes, readAccessor, readPositionsExact, transformPoint, type Mat4, type ParsedGlb } from './glb-bytes';

// =============================================================================
// Public types
// =============================================================================

/** One clay primitive as the textured twin lays it out. */
export interface AtlasPrimitiveLayout {
    nodeIndex: number;
    nodeName: string;
    meshIndex: number;
    primitiveIndex: number;
    /** Index into UvAtlas.maps. */
    mapIndex: number;
    /** Per twin vertex: the clay vertex it copies (positions and every attribute are gathered by this index). */
    sourceVertex: Uint32Array;
    /** TEXCOORD_0 per twin vertex, glTF convention (0,0 = top-left texel corner of the image). */
    uv: Float32Array;
    /** Twin triangles, same triangle order as the clay primitive. */
    indices: Uint32Array;
    /** Per triangle: index into UvAtlasLayout.rects (the chart or island it was laid out in). */
    rectOfTriangle: Uint32Array;
}

/** One packed chart or island, in texels: the outer rect includes `gutterTexels` on every side. */
export interface AtlasRect { x: number; y: number; width: number; height: number; kind: 'chart' | 'island'; mapIndex: number }

export interface UvAtlasStats {
    charts: number;
    islands: number;
    /** Island-path primitives whose chart was not used, with the measured reason. */
    chartsRejected: Array<{ nodeName: string; reason: string }>;
    /** Texels claimed in their interior by two different triangles (0 for a valid atlas). */
    overlapTexels: number;
    /**
     * Closed primitives wound inside out (negative signed volume): their texel normals are flipped to point outward, so the
     * projection sees their faces (an inward normal fails every view's incidence test).
     */
    insideOutPrimitives: number;
    /** Share of the atlas covered by charts/islands (gutter excluded). */
    coverage: number;
    /** Share of the atlas that is gutter. */
    gutterShare: number;
    /** Requested and achieved texel density. */
    requestedTexelsPerMeter: number;
    texelsPerMeter: number;
    native?: { evictionRounds: number; evictedTriangles: number; forcedSingletons: number; mergedIslands: number; ms: number; binary: string; built: boolean };
    ms: number;
}

export interface UvAtlasLayout {
    /** sha256 of the clay GLB this layout indexes into; the twin writer refuses another one. */
    claySha256: string;
    gutterTexels: number;
    rects: AtlasRect[];
    primitives: AtlasPrimitiveLayout[];
    /** Primitives left without UVs (not triangles), with the reason; the twin keeps them clay. */
    untextured: Array<{ nodeName: string; reason: string }>;
    stats: UvAtlasStats;
}

/** A UvAtlas plus the twin layout the writer needs (the contract's UvAtlas is a structural subset of this). */
export interface LaidOutUvAtlas extends UvAtlas { layout: UvAtlasLayout }

export interface BuildUvAtlasOptions extends UvAtlasInput {
    /** Fitted surfaces with charts, matched to nodes by StagedNodeExtras ids.surfaceId, else by node name. */
    surfaces?: Array<Pick<FittedSurface, 'id' | 'chart'>>;
    /** Gutter on each side of every rect, texels (default 2). */
    gutterTexels?: number;
    /** Islands below this area merge into a neighbour when their normals allow (default 0.05 m^2). */
    minIslandAreaM2?: number;
    /** A chart holds a node when every vertex is within this distance of chartPoint (default 0.02 m). */
    chartToleranceM?: number;
    /** Native unwrapper binary override and repo root (defaults: discovered). */
    native?: { binaryPath?: string; repoRoot?: string; timeoutMs?: number };
    /** Stops the native unwrapper (its child is killed). */
    signal?: AbortSignal;
    /** Primitives ("nodeIndex:primitiveIndex") laid out as islands even with a chart (set internally when a chart's triangles overlap). */
    forceIslands?: string[];
}

const primKey = (p: { nodeIndex: number; primitiveIndex: number }) => `${p.nodeIndex}:${p.primitiveIndex}`;

/** The island method: the input's, else SCRATCHBOX_TWIN_UV ('orthographic' or 'slim'), else 'slim'. */
export function twinIslandMethod(requested?: 'slim' | 'orthographic'): 'slim' | 'orthographic' {
    if (requested) return requested;
    return process.env.SCRATCHBOX_TWIN_UV === 'orthographic' ? 'orthographic' : 'slim';
}

// =============================================================================
// Native island unwrapper (pipe protocol of scripts/uv_atlas.cpp)
// =============================================================================

const CLI_SOURCE = path.join('scripts', 'uv_atlas.cpp');
const HEADERS = ['scratchbox_uv_atlas.hpp', 'scratchbox_uv_rewrap.hpp'].map(h => path.join('packages', 'core', 'src', 'native', '3d-engine', 'include', h));
const INCLUDE_DIR = path.join('packages', 'core', 'src', 'native', '3d-engine', 'include');
const BINARY = path.join('build', '3d-native', 'uv_atlas');

export function findUvAtlasRepoRoot(): string {
    for (const start of [__dirname, process.cwd()]) {
        let dir = path.resolve(start);
        while (true) {
            if (fs.existsSync(path.join(dir, CLI_SOURCE))) return dir;
            const parent = path.dirname(dir);
            if (parent === dir) break;
            dir = parent;
        }
    }
    throw new Error(`the island unwrapper source ${CLI_SOURCE} was not found above ${__dirname} or ${process.cwd()}`);
}

const building = new Map<string, Promise<{ path: string; built: boolean }>>();

/** Builds build/3d-native/uv_atlas when missing or older than its source or header (atomic rename). */
export function ensureUvAtlasBinary(repoRoot = findUvAtlasRepoRoot()): Promise<{ path: string; built: boolean }> {
    const bin = path.join(repoRoot, BINARY);
    const pending = building.get(bin);
    if (pending) return pending;
    const job = (async () => {
        const deps = [path.join(repoRoot, CLI_SOURCE), ...HEADERS.map(h => path.join(repoRoot, h))];
        const binTime = fs.existsSync(bin) ? fs.statSync(bin).mtimeMs : -1;
        if (binTime >= 0 && deps.every(d => fs.existsSync(d) && fs.statSync(d).mtimeMs <= binTime)) return { path: bin, built: false };
        fs.mkdirSync(path.dirname(bin), { recursive: true });
        const tmp = `${bin}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
        const args = ['-std=c++20', '-O3'];
        if (process.env.SCRATCHBOX_NATIVE_ARCH === '1') args.push('-march=native');
        args.push('-I', path.join(repoRoot, INCLUDE_DIR), deps[0], '-o', tmp, '-pthread');
        await new Promise<void>((resolve, reject) => {
            execFile(process.env.CXX || 'clang++', args, { timeout: 300_000, maxBuffer: 8 * 1024 * 1024 }, (err, _out, stderr) => {
                if (err) { fs.rmSync(tmp, { force: true }); reject(new Error(`could not build the island unwrapper: ${String(stderr || err.message).slice(-1500)}`)); } else resolve();
            });
        });
        fs.renameSync(tmp, bin);
        return { path: bin, built: true };
    })().finally(() => building.delete(bin));
    building.set(bin, job);
    return job;
}

export interface NativeIslands {
    sourceVertex: Uint32Array;
    uv: Float32Array;
    indices: Uint32Array;
    triangleIsland: Uint32Array;
    islands: Array<{ widthM: number; heightM: number; area3DM2: number; area2DM2: number; normal: Vec3; group: number }>;
    evictionRounds: number; evictedTriangles: number; forcedSingletons: number; mergedIslands: number;
}

/** Runs the native unwrapper over one concatenated mesh; `groups` (per triangle) keeps islands inside a primitive. */
export async function runNativeIslands(binary: string, positions: Float32Array, indices: Uint32Array, groups: Uint32Array,
    params: { normalToleranceDeg: number; minIslandAreaM2: number; flatten?: boolean }, timeoutMs = 120_000, signal?: AbortSignal): Promise<NativeIslands> {
    const V = positions.length / 3, T = indices.length / 3;
    const head = Buffer.alloc(16);
    head.write('SBUV', 0, 'latin1');
    head.writeUInt32LE(2, 4); head.writeUInt32LE(V, 8); head.writeUInt32LE(T, 12);
    const prm = Buffer.alloc(12);
    prm.writeFloatLE(params.normalToleranceDeg, 0); prm.writeFloatLE(params.minIslandAreaM2, 4); prm.writeUInt32LE(params.flatten ? 1 : 0, 8);
    const asBuf = (a: Float32Array | Uint32Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);
    const out: Buffer = await new Promise((resolve, reject) => {
        const proc = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        const chunks: Buffer[] = [];
        let err = '';
        const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error(`island unwrapper timed out after ${timeoutMs} ms`)); }, timeoutMs);
        // a stop kills the child (a texture worker is asked to stop before it is terminated, so no unwrapper outlives it)
        const onAbort = () => { clearTimeout(timer); proc.kill('SIGKILL'); reject(signal!.reason instanceof Error ? signal!.reason : Object.assign(new Error('the island unwrapper was stopped'), { name: 'AbortError' })); };
        if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
        proc.on('close', () => signal?.removeEventListener('abort', onAbort));
        proc.stdout.on('data', (c: Buffer) => chunks.push(c));
        proc.stderr.on('data', (c: Buffer) => { err += c.toString(); });
        proc.on('error', e => { clearTimeout(timer); reject(e); });
        proc.on('close', code => {
            clearTimeout(timer);
            if (code !== 0) reject(new Error(`island unwrapper exited ${code}: ${err.trim().slice(-800)}`));
            else resolve(Buffer.concat(chunks));
        });
        proc.stdin.on('error', () => { /* reported through close */ });
        proc.stdin.end(Buffer.concat([head, prm, asBuf(positions), asBuf(indices), asBuf(groups)]));
    });
    if (out.length < 36 || out.toString('latin1', 0, 4) !== 'SBUA') throw new Error('island unwrapper returned no SBUA header');
    const h = (i: number) => out.readUInt32LE(4 + i * 4);
    const outV = h(1), t = h(2), I = h(3);
    if (t !== T) throw new Error(`island unwrapper returned ${t} triangles for ${T}`);
    let o = 36;
    const take = <A extends Uint32Array | Float32Array>(Ctor: { new(b: ArrayBuffer): A }, n: number): A => {
        const bytes = n * 4;
        if (o + bytes > out.length) throw new Error('island unwrapper output is truncated');
        const a = new Ctor(out.buffer.slice(out.byteOffset + o, out.byteOffset + o + bytes) as ArrayBuffer);
        o += bytes;
        return a;
    };
    const sourceVertex = take(Uint32Array, outV), uv = take(Float32Array, outV * 2), idx = take(Uint32Array, T * 3), triangleIsland = take(Uint32Array, T);
    const isl = take(Float32Array, I * 7), ig = take(Uint32Array, I);
    return {
        sourceVertex, uv, indices: idx, triangleIsland,
        islands: Array.from({ length: I }, (_, i) => ({
            widthM: isl[i * 7], heightM: isl[i * 7 + 1], area3DM2: isl[i * 7 + 2], area2DM2: isl[i * 7 + 3],
            normal: [isl[i * 7 + 4], isl[i * 7 + 5], isl[i * 7 + 6]] as Vec3, group: ig[i]
        })),
        evictionRounds: h(4), evictedTriangles: h(5), forcedSingletons: h(6), mergedIslands: h(7)
    };
}

// =============================================================================
// Charts
// =============================================================================

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: Vec3): Vec3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** Chart coordinates (metres) of a world point: the inverse of chartPoint on the surface. Cylinders unwrap around the middle of their angular range. */
export function chartUv(chart: SurfaceChart, p: Vec3): [number, number] {
    if ('plane' in chart) {
        const d = sub(p, chart.plane.origin);
        return [dot(d, chart.plane.u), dot(d, chart.plane.v)];
    }
    const c = chart.cylinder;
    const axis = unit(c.axisDir), x0 = unit(c.thetaZeroDir), y0 = cross(axis, x0);
    const d = sub(p, c.axisOrigin);
    const mid = ((c.thetaDeg[0] + c.thetaDeg[1]) / 2) * (Math.PI / 180);
    let th = Math.atan2(dot(d, y0), dot(d, x0)) - mid;
    th -= 2 * Math.PI * Math.round(th / (2 * Math.PI));
    return [c.radiusM * (th + mid), dot(d, axis)];
}

/** Unit outward normal of the chart at (u, v). */
function chartNormal(chart: SurfaceChart, u: number): Vec3 {
    if ('plane' in chart) return unit(chart.plane.normal);
    const c = chart.cylinder;
    const axis = unit(c.axisDir), x0 = unit(c.thetaZeroDir), y0 = cross(axis, x0);
    const th = u / c.radiusM;
    const r: Vec3 = [x0[0] * Math.cos(th) + y0[0] * Math.sin(th), x0[1] * Math.cos(th) + y0[1] * Math.sin(th), x0[2] * Math.cos(th) + y0[2] * Math.sin(th)];
    return [r[0] * c.normalSign, r[1] * c.normalSign, r[2] * c.normalSign];
}

// =============================================================================
// Packing
// =============================================================================

interface PackItem { w: number; h: number; x: number; y: number }

/** Shelf packing (tallest first) into a width; returns the used height. Rects keep their size; no rotation. */
function shelfPack(items: PackItem[], width: number): number {
    const order = items.map((_, i) => i).sort((a, b) => items[b].h - items[a].h || items[b].w - items[a].w || a - b);
    let x = 0, y = 0, row = 0;
    for (const i of order) {
        const it = items[i];
        if (x + it.w > width) { y += row; x = 0; row = 0; }
        it.x = x; it.y = y;
        x += it.w; row = Math.max(row, it.h);
    }
    return y + row;
}
const nextPow2 = (n: number) => 2 ** Math.ceil(Math.log2(Math.max(1, n)));

// =============================================================================
// buildUvAtlas
// =============================================================================

interface Prim {
    nodeIndex: number; nodeName: string; meshIndex: number; primitiveIndex: number; mapIndex: number;
    positions: Float32Array; indices: Uint32Array; world: Mat4;
    chart?: SurfaceChart; chartKind?: string; chartId?: string;
    /** Metres tile_refine moved the scan surface under each vertex (|_RECTIFY_DISPLACEMENT| + |_RELIEF_HEIGHT|), when written. */
    movedM?: Float32Array;
}

interface Item {
    prim: Prim;
    wM: number; hM: number;
    /** Local (metres) UV per twin vertex. */
    local: Float32Array; sourceVertex: Uint32Array; indices: Uint32Array;
    chart?: { chart: SurfaceChart; u0: number; v0: number; u1: number; flipU: boolean };
    /** Island items: the clay-primitive triangle index of each item triangle. */
    triOrder?: Uint32Array;
    wC: number; hC: number; pack: PackItem;
}

const worldPos = (p: Prim, v: number): Vec3 => transformPoint(p.world, p.positions[v * 3], p.positions[v * 3 + 1], p.positions[v * 3 + 2]);

/**
 * True when a primitive is a closed solid (every edge, after welding positions to 0.1 mm, shared by exactly two
 * triangles) whose triangles wind inside out (negative signed volume). An open surface is never judged: which side of it
 * faces out is not decidable from the mesh alone (an arch soffit faces its own centroid and is right).
 */
export function primitiveInsideOut(positions: Float32Array, indices: Uint32Array, toWorld: (v: number) => Vec3): boolean {
    const nt = Math.floor(indices.length / 3);
    if (nt < 4) return false;
    const weld = new Map<string, number>();
    const id = new Int32Array(positions.length / 3);
    const pts: Vec3[] = [];
    for (let v = 0; v < id.length; v++) {
        const P = toWorld(v);
        const k = `${Math.round(P[0] * 1e4)},${Math.round(P[1] * 1e4)},${Math.round(P[2] * 1e4)}`;
        let w = weld.get(k);
        if (w === undefined) { w = pts.length; weld.set(k, w); pts.push(P); }
        id[v] = w;
    }
    const edges = new Map<string, number>();
    let vol = 0;
    const c = pts.reduce((a, p) => [a[0] + p[0] / pts.length, a[1] + p[1] / pts.length, a[2] + p[2] / pts.length] as Vec3, [0, 0, 0] as Vec3);
    for (let t = 0; t < nt; t++) {
        const a = id[indices[t * 3]], b = id[indices[t * 3 + 1]], d = id[indices[t * 3 + 2]];
        if (a === b || b === d || a === d) continue;
        for (const [x, y] of [[a, b], [b, d], [d, a]]) { const k = x < y ? `${x},${y}` : `${y},${x}`; edges.set(k, (edges.get(k) ?? 0) + 1); }
        const A = sub(pts[a], c), B = sub(pts[b], c), D = sub(pts[d], c);
        vol += dot(A, cross(B, D)) / 6;
    }
    for (const n of edges.values()) if (n !== 2) return false;
    return vol < 0;
}

/** Builds the UV atlas of a clay GLB (contract BuildUvAtlas, plus fitted charts and the twin layout). */
export async function buildUvAtlas(input: BuildUvAtlasOptions): Promise<LaidOutUvAtlas> {
    const t0 = Date.now();
    const G = Math.max(1, Math.round(input.gutterTexels ?? 2));
    if (!(input.densityTexelsPerMeter > 0)) throw new Error('densityTexelsPerMeter must be positive');
    if (!(input.maxSide >= 16)) throw new Error('maxSide must be at least 16 texels');
    const chartTol = input.chartToleranceM ?? 0.02;
    const glb: ParsedGlb = parseGlbBytes(input.clayGlb);
    const json = glb.json;
    const world = nodeWorldMatrices(json);
    const surfaces = new Map((input.surfaces ?? []).map(s => [s.id, s]));
    const forceIslands = new Set(input.forceIslands ?? []);

    const maps: SurfaceUvMap[] = [];
    const mapOfNode = new Map<number, number>();
    const prims: Prim[] = [];
    const untextured: UvAtlasLayout['untextured'] = [];
    const chartsRejected: UvAtlasStats['chartsRejected'] = [];
    (json.nodes ?? []).forEach((node: any, nodeIndex: number) => {
        if (node.mesh === undefined) return;
        const mesh = json.meshes?.[node.mesh];
        const nodeName: string = node.name ?? mesh?.name ?? `node_${nodeIndex}`;
        (mesh?.primitives ?? []).forEach((prim: any, primitiveIndex: number) => {
            if ((prim.mode ?? 4) !== 4 || prim.attributes?.POSITION === undefined) {
                untextured.push({ nodeName, reason: `primitive ${primitiveIndex} is not a triangle list (mode ${prim.mode ?? 4})` });
                return;
            }
            const positions = readPositionsExact(glb, prim.attributes.POSITION);
            const n = positions.length / 3;
            const indices = prim.indices !== undefined ? Uint32Array.from(readAccessor(glb, prim.indices).data) : Uint32Array.from({ length: n - (n % 3) }, (_, i) => i);
            if (indices.length < 3) { untextured.push({ nodeName, reason: `primitive ${primitiveIndex} has no triangles` }); return; }
            if (!mapOfNode.has(nodeIndex)) {
                mapOfNode.set(nodeIndex, maps.length);
                maps.push({ nodeName, kind: 'atlas', texelsPerMeter: 0, atlasRect: [1, 1, 0, 0] });
            }
            // how far tile_refine moved the scan surface at each vertex (rectify, facade flatten, photo relief): the tile photo
            // of a moved texel lies that much further away (tile-texture-transfer.ts widens its distance gate by it)
            let movedM: Float32Array | undefined;
            for (const name of [TILE_REFINE_VERTEX_ATTRIBUTES.rectifyDisplacement, TILE_REFINE_VERTEX_ATTRIBUTES.reliefHeight]) {
                const a = prim.attributes?.[name];
                if (a === undefined) continue;
                const d = readAccessor(glb, a).data;
                if (d.length !== n) continue;
                movedM ??= new Float32Array(n);
                for (let v = 0; v < n; v++) if (Number.isFinite(d[v])) movedM[v] += Math.abs(d[v]);
            }
            const surfaceId: string = node.extras?.sb?.ids?.surfaceId ?? nodeName;
            const surface = surfaces.get(surfaceId);
            prims.push({
                nodeIndex, nodeName, meshIndex: node.mesh, primitiveIndex, mapIndex: mapOfNode.get(nodeIndex)!, positions, indices, world: world[nodeIndex],
                ...(movedM ? { movedM } : {}),
                ...(surface ? { chart: surface.chart, chartKind: 'plane' in surface.chart ? 'chart-plane' : 'chart-cylinder', chartId: surface.id } : {})
            });
        });
    });

    // charts: exact UVs where the chart holds the node
    const items: Item[] = [];
    const islandPrims: Prim[] = [];
    for (const p of prims) {
        if (!p.chart) { islandPrims.push(p); continue; }
        const n = p.positions.length / 3;
        const local = new Float32Array(n * 2);
        const uvM = new Float64Array(n * 2);
        let worst = 0;
        for (let v = 0; v < n; v++) {
            const w = worldPos(p, v);
            const [u, vv] = chartUv(p.chart, w);
            uvM[v * 2] = u; uvM[v * 2 + 1] = vv;
            const back = chartPoint(p.chart, u, vv);
            worst = Math.max(worst, Math.hypot(back[0] - w[0], back[1] - w[1], back[2] - w[2]));
        }
        let pos = 0, neg = 0;
        for (let t = 0; t < p.indices.length; t += 3) {
            const a = p.indices[t] * 2, b = p.indices[t + 1] * 2, c = p.indices[t + 2] * 2;
            const s = (uvM[b] - uvM[a]) * (uvM[c + 1] - uvM[a + 1]) - (uvM[b + 1] - uvM[a + 1]) * (uvM[c] - uvM[a]);
            if (s > 1e-10) pos++; else if (s < -1e-10) neg++;
        }
        const forced = forceIslands.has(primKey(p));
        if (forced || worst > chartTol || (pos && neg)) {
            chartsRejected.push({
                nodeName: p.nodeName,
                reason: forced ? `the node's own triangles overlap each other in its ${p.chartKind} chart (the fitted mesh overlaps itself), so it is laid out as islands`
                    : worst > chartTol ? `vertices sit up to ${worst.toFixed(3)} m off the ${p.chartKind} chart (tolerance ${chartTol} m)` : `the chart folds the node (${pos} triangles one way, ${neg} the other)`
            });
            delete p.chart; delete p.chartKind; delete p.chartId;
            islandPrims.push(p);
            continue;
        }
        let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
        for (let v = 0; v < n; v++) { u0 = Math.min(u0, uvM[v * 2]); u1 = Math.max(u1, uvM[v * 2]); v0 = Math.min(v0, uvM[v * 2 + 1]); v1 = Math.max(v1, uvM[v * 2 + 1]); }
        const flipU = neg > 0;   // the triangles face against the chart: mirror u so the image reads unmirrored from the front
        for (let v = 0; v < n; v++) { local[v * 2] = flipU ? u1 - uvM[v * 2] : uvM[v * 2] - u0; local[v * 2 + 1] = uvM[v * 2 + 1] - v0; }
        const m = maps[p.mapIndex];
        m.kind = p.chartKind!; m.chartId = p.chartId;
        items.push({
            prim: p, wM: u1 - u0, hM: v1 - v0, local, sourceVertex: Uint32Array.from({ length: n }, (_, i) => i), indices: p.indices,
            chart: { chart: p.chart, u0, v0, u1, flipU }, wC: 0, hC: 0, pack: { w: 0, h: 0, x: 0, y: 0 }
        });
    }

    // islands: one native run over every non-chart primitive
    let native: UvAtlasStats['native'];
    if (islandPrims.length) {
        const nv = islandPrims.reduce((s, p) => s + p.positions.length / 3, 0), nt = islandPrims.reduce((s, p) => s + p.indices.length / 3, 0);
        const positions = new Float32Array(nv * 3), indices = new Uint32Array(nt * 3), groups = new Uint32Array(nt);
        const vOff: number[] = [], tOff: number[] = [];
        let ov = 0, ot = 0;
        islandPrims.forEach((p, g) => {
            vOff.push(ov); tOff.push(ot);
            const n = p.positions.length / 3;
            for (let v = 0; v < n; v++) { const w = worldPos(p, v); positions[(ov + v) * 3] = w[0]; positions[(ov + v) * 3 + 1] = w[1]; positions[(ov + v) * 3 + 2] = w[2]; }
            for (let k = 0; k < p.indices.length; k++) indices[ot * 3 + k] = p.indices[k] + ov;
            groups.fill(g, ot, ot + p.indices.length / 3);
            ov += n; ot += p.indices.length / 3;
        });
        const nt0 = Date.now();
        const bin = input.native?.binaryPath ? { path: input.native.binaryPath, built: false } : await ensureUvAtlasBinary(input.native?.repoRoot);
        const r = await runNativeIslands(bin.path, positions, indices, groups, { normalToleranceDeg: input.islandNormalToleranceDeg, minIslandAreaM2: input.minIslandAreaM2 ?? 0.05, flatten: twinIslandMethod(input.islandMethod) === 'slim' }, input.native?.timeoutMs, input.signal);
        native = { evictionRounds: r.evictionRounds, evictedTriangles: r.evictedTriangles, forcedSingletons: r.forcedSingletons, mergedIslands: r.mergedIslands, ms: Date.now() - nt0, binary: bin.path, built: bin.built };
        // split the output per island: each island is an item; its vertices index the primitive's own clay vertices
        const islandVerts: number[][] = r.islands.map(() => []);
        const vertIsland = new Int32Array(r.sourceVertex.length).fill(-1);
        for (let t = 0; t < nt; t++) for (let k = 0; k < 3; k++) vertIsland[r.indices[t * 3 + k]] = r.triangleIsland[t];
        for (let v = 0; v < vertIsland.length; v++) if (vertIsland[v] >= 0) islandVerts[vertIsland[v]].push(v);
        const islandTris: number[][] = r.islands.map(() => []);
        for (let t = 0; t < nt; t++) islandTris[r.triangleIsland[t]].push(t);
        r.islands.forEach((isl, i) => {
            const p = islandPrims[isl.group];
            const verts = islandVerts[i];
            const localIndex = new Map<number, number>(verts.map((v, k) => [v, k]));
            const local = new Float32Array(verts.length * 2), sourceVertex = new Uint32Array(verts.length);
            verts.forEach((v, k) => { local[k * 2] = r.uv[v * 2]; local[k * 2 + 1] = r.uv[v * 2 + 1]; sourceVertex[k] = r.sourceVertex[v] - vOff[isl.group]; });
            const tris = islandTris[i];
            const idx = new Uint32Array(tris.length * 3);
            tris.forEach((t, k) => { for (let c = 0; c < 3; c++) idx[k * 3 + c] = localIndex.get(r.indices[t * 3 + c])!; });
            // triOrder keeps the clay primitive's triangle order: each island triangle's position in it
            items.push({ prim: p, wM: isl.widthM, hM: isl.heightM, local, sourceVertex, indices: idx, triOrder: Uint32Array.from(tris, t => t - tOff[isl.group]), wC: 0, hC: 0, pack: { w: 0, h: 0, x: 0, y: 0 } });
        });
    }
    if (!items.length) throw new Error('the clay GLB has no triangle primitives to lay out');

    // density and atlas size: grow the atlas past maxSide (up to hardMaxSide) before shrinking density — a bigger atlas
    // keeps the requested texel density, a smaller one at lower density does not. Only once hardMaxSide itself cannot
    // hold the layer does density start shrinking.
    const sideCeiling = Math.max(input.maxSide, input.hardMaxSide ?? 8192);
    let d = input.densityTexelsPerMeter;
    let W = 0, H = 0;
    for (let attempt = 0; ; attempt++) {
        let area = 0, widest = 0;
        for (const it of items) {
            it.wC = Math.max(1, Math.ceil(it.wM * d - 1e-9)); it.hC = Math.max(1, Math.ceil(it.hM * d - 1e-9));
            it.pack.w = it.wC + 2 * G; it.pack.h = it.hC + 2 * G;
            area += it.pack.w * it.pack.h; widest = Math.max(widest, it.pack.w, it.pack.h);
        }
        // power-of-two sizes (mipmaps); try each width from the narrowest that can hold the widest rect and keep the smallest atlas
        let best: { w: number; h: number } | undefined;
        for (let w = Math.max(16, nextPow2(widest)); w <= sideCeiling; w *= 2) {
            const h = Math.max(16, nextPow2(shelfPack(items.map(i => i.pack), w)));
            if (h <= sideCeiling && (!best || w * h < best.w * best.h || (w * h === best.w * best.h && Math.abs(w - h) < Math.abs(best.w - best.h)))) best = { w, h };
        }
        if (best) { W = best.w; H = best.h; shelfPack(items.map(i => i.pack), W); break; }
        if (attempt > 60 || d < 1e-3) throw new Error(`the layer does not fit in ${sideCeiling}x${sideCeiling} texels even at ${d.toFixed(4)} texels/m`);
        d *= Math.min(0.95, Math.sqrt((sideCeiling * sideCeiling * 0.8) / area));
    }

    // per-vertex UVs and the per-primitive layout (clay triangle order kept)
    const layoutOf = new Map<Prim, { verts: Array<{ src: Uint32Array; uv: Float32Array }>; tri: Uint32Array; rect: Uint32Array }>();
    const pixel = (it: Item, k: number): [number, number] => [it.pack.x + G + it.local[k * 2] * d, it.pack.y + G + it.hC - it.local[k * 2 + 1] * d];
    const vertexBase = new Map<Prim, number>();
    for (const [itemIndex, it] of items.entries()) {
        let L = layoutOf.get(it.prim);
        if (!L) { L = { verts: [], tri: new Uint32Array(it.prim.indices.length), rect: new Uint32Array(it.prim.indices.length / 3) }; layoutOf.set(it.prim, L); vertexBase.set(it.prim, 0); }
        const base = vertexBase.get(it.prim)!;
        const uv = new Float32Array(it.sourceVertex.length * 2);
        for (let k = 0; k < it.sourceVertex.length; k++) { const [X, Y] = pixel(it, k); uv[k * 2] = X / W; uv[k * 2 + 1] = Y / H; }
        L.verts.push({ src: it.sourceVertex, uv });
        const order = it.triOrder;
        const nTri = it.indices.length / 3;
        for (let k = 0; k < nTri; k++) {
            const t = order ? order[k] : k;
            L.rect[t] = itemIndex;
            for (let c = 0; c < 3; c++) L.tri[t * 3 + c] = it.indices[k * 3 + c] + base;
        }
        vertexBase.set(it.prim, base + it.sourceVertex.length);
    }
    const primitives: AtlasPrimitiveLayout[] = prims.map(p => {
        const L = layoutOf.get(p)!;
        const n = L.verts.reduce((s, x) => s + x.src.length, 0);
        const sourceVertex = new Uint32Array(n), uv = new Float32Array(n * 2);
        let o = 0;
        for (const x of L.verts) { sourceVertex.set(x.src, o); uv.set(x.uv, o * 2); o += x.src.length; }
        return { nodeIndex: p.nodeIndex, nodeName: p.nodeName, meshIndex: p.meshIndex, primitiveIndex: p.primitiveIndex, mapIndex: p.mapIndex, sourceVertex, uv, indices: L.tri, rectOfTriangle: L.rect };
    });

    // primitives wound inside out get outward normals (a solid's inner face is never what a photo shows)
    const insideOut = new Set<Prim>(prims.filter(p => primitiveInsideOut(p.positions, p.indices, v => worldPos(p, v))));
    // rasterise: texel centres inside each triangle; world position and normal per texel
    const N = W * H;
    const covered = new Uint8Array(N), gutter = new Uint8Array(N), mapIndex = new Uint16Array(N).fill(65535);
    const position = new Float32Array(N * 3), normal = new Float32Array(N * 3), sizeM = new Float32Array(N);
    const movedM = prims.some(p => p.movedM) ? new Float32Array(N) : undefined;
    const owner = new Int32Array(N).fill(-1), ownerScore = new Float32Array(N);
    let overlapTexels = 0, triId = 0;
    const triItem: Item[] = [];
    const overlapItems = new Set<Item>();
    for (const it of items) {
        const p = it.prim;
        const m = maps[p.mapIndex];
        m.texelsPerMeter = d;
        m.atlasRect = [Math.min(m.atlasRect[0], it.pack.x / W), Math.min(m.atlasRect[1], it.pack.y / H),
            Math.max(m.atlasRect[2], (it.pack.x + it.pack.w) / W), Math.max(m.atlasRect[3], (it.pack.y + it.pack.h) / H)];
        for (let k = 0; k < it.indices.length; k += 3, triId++) {
            triItem[triId] = it;
            const ia = it.indices[k], ib = it.indices[k + 1], ic = it.indices[k + 2];
            const A = pixel(it, ia), B = pixel(it, ib), C = pixel(it, ic);
            const den = (B[1] - C[1]) * (A[0] - C[0]) + (C[0] - B[0]) * (A[1] - C[1]);
            if (Math.abs(den) < 1e-12) continue;
            const PA = worldPos(p, it.sourceVertex[ia]), PB = worldPos(p, it.sourceVertex[ib]), PC = worldPos(p, it.sourceVertex[ic]);
            const fw = unit(cross(sub(PB, PA), sub(PC, PA)));
            const fn: Vec3 = insideOut.has(p) ? [-fw[0], -fw[1], -fw[2]] : fw;
            let islandSize = 1 / d;
            if (!it.chart) {
                // orthographic island: a texel covers 1/d^2 of the plane, 1/(d^2 cos) of the surface
                const e1: Vec3 = sub(PB, PA), e2: Vec3 = sub(PC, PA);
                const area3 = 0.5 * Math.hypot(...cross(e1, e2));
                const area2 = 0.5 * Math.abs(den) / (d * d);
                if (area2 > 1e-14) islandSize = (1 / d) * Math.sqrt(Math.max(1, area3 / area2));
            }
            const x0 = Math.max(0, Math.floor(Math.min(A[0], B[0], C[0]))), x1 = Math.min(W - 1, Math.ceil(Math.max(A[0], B[0], C[0])));
            const y0 = Math.max(0, Math.floor(Math.min(A[1], B[1], C[1]))), y1 = Math.min(H - 1, Math.ceil(Math.max(A[1], B[1], C[1])));
            for (let y = y0; y <= y1; y++) {
                const py = y + 0.5;
                for (let x = x0; x <= x1; x++) {
                    const px = x + 0.5;
                    const l0 = ((B[1] - C[1]) * (px - C[0]) + (C[0] - B[0]) * (py - C[1])) / den;
                    const l1 = ((C[1] - A[1]) * (px - C[0]) + (A[0] - C[0]) * (py - C[1])) / den;
                    const l2 = 1 - l0 - l1;
                    const score = Math.min(l0, l1, l2);
                    if (score < -1e-7) continue;
                    const i = y * W + x;
                    if (owner[i] >= 0 && owner[i] !== triId) {
                        if (score > 1e-4 && ownerScore[i] > 1e-4) { overlapTexels++; overlapItems.add(it); overlapItems.add(triItem[owner[i]]); }
                        if (score <= ownerScore[i]) continue;
                    }
                    owner[i] = triId; ownerScore[i] = score; covered[i] = 1; mapIndex[i] = p.mapIndex;
                    let P: Vec3, Nn: Vec3;
                    if (it.chart) {
                        const lu = (px - it.pack.x - G) / d, lv = (it.pack.y + G + it.hC - py) / d;
                        const u = it.chart.flipU ? it.chart.u1 - lu : it.chart.u0 + lu, v = it.chart.v0 + lv;
                        P = chartPoint(it.chart.chart, u, v);
                        Nn = chartNormal(it.chart.chart, u);
                        if (dot(Nn, fn) < 0) Nn = [-Nn[0], -Nn[1], -Nn[2]];
                    } else {
                        P = [l0 * PA[0] + l1 * PB[0] + l2 * PC[0], l0 * PA[1] + l1 * PB[1] + l2 * PC[1], l0 * PA[2] + l1 * PB[2] + l2 * PC[2]];
                        Nn = fn;
                    }
                    position[i * 3] = P[0]; position[i * 3 + 1] = P[1]; position[i * 3 + 2] = P[2];
                    normal[i * 3] = Nn[0]; normal[i * 3 + 1] = Nn[1]; normal[i * 3 + 2] = Nn[2];
                    sizeM[i] = islandSize;
                    if (movedM) { const D = p.movedM; movedM[i] = D ? l0 * D[it.sourceVertex[ia]] + l1 * D[it.sourceVertex[ib]] + l2 * D[it.sourceVertex[ic]] : 0; }
                }
            }
        }
    }
    // a fitted mesh whose triangles overlap in its own chart cannot use the chart: lay it out as islands instead
    const foldedCharts = [...overlapItems].filter(i => i.chart).map(i => primKey(i.prim));
    if (foldedCharts.length) {
        return buildUvAtlas({ ...input, forceIslands: [...(input.forceIslands ?? []), ...new Set(foldedCharts)] });
    }
    let content = 0;
    for (let i = 0; i < N; i++) content += covered[i];

    // gutter: dilate covered texels G times (8-neighbourhood); gutter texels copy their neighbour's sample
    for (let pass = 0; pass < G; pass++) {
        const add: number[] = [];
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const i = y * W + x;
            if (covered[i]) continue;
            let from = -1;
            for (let dy = -1; dy <= 1 && from < 0; dy++) for (let dx = -1; dx <= 1; dx++) {
                const xx = x + dx, yy = y + dy;
                if ((dx || dy) && xx >= 0 && yy >= 0 && xx < W && yy < H && covered[yy * W + xx]) { from = yy * W + xx; break; }
            }
            if (from >= 0) add.push(i, from);
        }
        for (let k = 0; k < add.length; k += 2) {
            const i = add[k], f = add[k + 1];
            covered[i] = 1; gutter[i] = 1; mapIndex[i] = mapIndex[f]; sizeM[i] = sizeM[f]; if (movedM) movedM[i] = movedM[f];
            position.copyWithin(i * 3, f * 3, f * 3 + 3); normal.copyWithin(i * 3, f * 3, f * 3 + 3);
        }
    }
    let gutterCount = 0;
    for (let i = 0; i < N; i++) gutterCount += gutter[i];

    return {
        layerKey: input.layerKey, width: W, height: H, maps,
        texels: { covered, gutter, mapIndex, position, normal, sizeM, ...(movedM ? { movedM } : {}) },
        layout: {
            claySha256: crypto.createHash('sha256').update(input.clayGlb).digest('hex'), gutterTexels: G, primitives, untextured,
            rects: items.map(it => ({ x: it.pack.x, y: it.pack.y, width: it.pack.w, height: it.pack.h, kind: it.chart ? 'chart' as const : 'island' as const, mapIndex: it.prim.mapIndex })),
            stats: {
                charts: items.filter(i => i.chart).length, islands: items.filter(i => !i.chart).length, chartsRejected, overlapTexels, insideOutPrimitives: insideOut.size,
                coverage: content / N, gutterShare: gutterCount / N, requestedTexelsPerMeter: input.densityTexelsPerMeter, texelsPerMeter: d,
                ...(native ? { native } : {}), ms: Date.now() - t0
            }
        }
    };
}

/** The contract seam: BuildUvAtlas (fitted charts are used when `surfaces` are passed through BuildUvAtlasOptions). */
export const buildUvAtlasSeam: BuildUvAtlas = input => buildUvAtlas(input);
