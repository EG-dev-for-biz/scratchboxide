/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K-D's chunked district: the whole radius at leaf LOD, built as chunks.
 *
 * One build holding a dense district's whole radius at leaf LOD, and every stage run over it, would not fit in memory
 * (an extraction keeps every leaf the radius touches, Google3DTileBlockoutPipelineService selectLeavesByPlanReach). Here the radius is cut into chunks, each built on its own (extraction, remesh, K, trees, textures) in its
 * own worker, and joined:
 *  1. The plan (planDistrictChunks): a square grid of `cellM` cells over the disc. Every building (Google's vector
 *     footprints) belongs wholly to the cell holding its centroid, so no chunk boundary cuts through a building (AGENTS.md
 *     atomic building integrity); a chunk extracts the leaf tiles touching its cell grown to every building it owns, plus a
 *     margin of context (a rectangle, not a circle around it, which took about twice the cell's area). The chunk at the
 *     centre is the run itself.
 *  2. Ownership (ownerOf): a point inside a building's footprint belongs to that building's chunk; any other point to the
 *     cell it lies in; past the radius, or inside a building left out, to none. Every building the circle reaches is
 *     planned whole (one whose middle lies past the circle in the cell of its point nearest the centre); one reaching more
 *     than `edgeGrowthM` past the circle is left out whole, with its reason, never cut (M2a). The seam stage cuts the
 *     ground exactly on the circle (district-seams.ts).
 *  3. The join (joinChunkGlb): a chunk's layers, built in the chunk's own tangent frame, are placed in the district's frame
 *     by the exact rigid transform between the two frames (through ECEF), and cut to what the chunk owns: the scan and the
 *     ground triangle by triangle, each kept when its middle or a corner lies in what the chunk keeps (its own, and a band
 *     of `seamBandM` past its edge); trees whole, by each connected piece's middle.
 * Seams: two neighbouring chunks remeshed the ground on either side of a cell line independently, and harmonised their
 * photos to their own references; the seam stage (district-seams.ts) cuts the overlapping bands exactly at the line, moves
 * the later chunk's cut edge onto the earlier one's, and levels their colour where they meet. A line never runs through a
 * building with a footprint.
 */

import * as os from 'os';
import type { Vec2 } from '../../../../common/spatial/staged-location-contracts';
import { GoogleTileDistrictCrawler } from '../../../spatial/GoogleTileDistrictCrawler';
import { assembleGlb, nodeWorldMatrices, parseGlbBytes, readAccessor, transformPoint, type Mat4 } from '../glb-bytes';
import { districtBuildingIndex, type DistrictFootprint } from './district-buildings';

export const DISTRICT_CHUNKS_VERSION = 'district-chunks/3';  // 3: every building the circle reaches is planned whole, or left out (M2a)

export const DISTRICT_CHUNKS_PARAMS = {
    /** The grid's cell (m): small enough that a chunk's extraction stays under the leaf-tile cap in a dense centre. */
    cellM: 120,
    /** Context past what a chunk owns (m): its remesh, trees and ground see past their own edge. */
    marginM: 8,
    /** The ground a chunk keeps past its own edge (m), for the seam stage to cut at the line and read colour in (district-seams.ts). */
    seamBandM: 3,
    /** A district this small is one build (m): its whole radius already fits under the leaf-tile cap. */
    minChunkedRadiusM: 140,
    /** Chunk builds at once beside the centre build (fewer when memory is short: a build holds several GB). */
    parallel: 3,
    /**
     * A building the circle reaches but whose middle lies past it is planned whole only when it reaches no more than this
     * past the circle (m; the staged district's containment growth, orchestrator.ts DISTRICT_CONTAINMENT_MAX_GROWTH_M);
     * past that it is left out, with its reason, rather than cut at the edge.
     */
    edgeGrowthM: 100
};

export interface DistrictChunk {
    /** Row-major over the grid; the centre cell is the run itself. */
    index: number;
    /** The cell's centre (m, the district's frame: x east, z south) and its square's half side. */
    cx: number; cz: number; half: number;
    /**
     * What the chunk extracts: its cell grown to every building it owns, plus the margin (m, the district's frame). The leaf
     * tiles that touch it are kept, not a circle's: a circle around a square cell took about twice the cell's area.
     */
    rect: { x0: number; z0: number; x1: number; z1: number };
    /** The rectangle's farthest corner from the chunk's centre (m): the extraction's search circle. */
    radiusM: number;
    /** The buildings it owns (vector ids). */
    buildings: string[];
    centre: boolean;
}

export interface DistrictChunkPlan {
    version: string;
    radiusM: number;
    cellM: number;
    chunks: DistrictChunk[];
    /** Every footprint the plan assigned, with its chunk: ownership is rebuilt from these (ownerOf). */
    footprints: Array<DistrictFootprint & { chunk: number }>;
    /** Buildings the circle reaches that reach too far past it to be planned whole: left out (no chunk owns them), with why. */
    leftOut?: Array<DistrictFootprint & { reason: string }>;
}

/** The point of a footprint's outline nearest the district's centre and its distance (the centre itself, 0, when inside). */
function nearestToCentre(loops: Vec2[][]): { p: Vec2; d: number } | undefined {
    let inside = false, best: { p: Vec2; d: number } | undefined;
    for (const loop of loops) for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
        const [ax, az] = loop[j], [bx, bz] = loop[i];
        if ((az > 0) !== (bz > 0) && 0 < ((bx - ax) * (0 - az)) / (bz - az) + ax) inside = !inside;
        const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
        const t = l2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + az * dz) / l2)) : 0;
        const p: Vec2 = [ax + dx * t, az + dz * t], d = Math.hypot(p[0], p[1]);
        if (!best || d < best.d) best = { p, d };
    }
    return inside ? { p: [0, 0], d: 0 } : best;
}

/** The plan for a district of `radiusM`; undefined when the district is small enough to be one build. */
export function planDistrictChunks(radiusM: number, buildings: Array<{ id: string; centroid: Vec2; loops: Vec2[][] }>, P = DISTRICT_CHUNKS_PARAMS): DistrictChunkPlan | undefined {
    if (!(radiusM > P.minChunkedRadiusM)) return undefined;
    const half = P.cellM / 2, n = Math.ceil((radiusM - half) / P.cellM);
    const cells: Array<{ i: number; j: number; cx: number; cz: number }> = [];
    for (let j = -n; j <= n; j++) for (let i = -n; i <= n; i++) {
        const cx = i * P.cellM, cz = j * P.cellM;
        // the square's nearest point to the centre within the radius
        const dx = Math.max(0, Math.abs(cx) - half), dz = Math.max(0, Math.abs(cz) - half);
        if (Math.hypot(dx, dz) < radiusM) cells.push({ i, j, cx, cz });
    }
    const cellAt = (x: number, z: number) => cells.findIndex(c => Math.abs(x - c.cx) <= half && Math.abs(z - c.cz) <= half);
    const owned: string[][] = cells.map(() => []);
    const box = cells.map(c => ({ x0: c.cx - half, z0: c.cz - half, x1: c.cx + half, z1: c.cz + half }));
    const footprints: DistrictChunkPlan['footprints'] = [];
    const leftOut: NonNullable<DistrictChunkPlan['leftOut']> = [];
    for (const b of buildings) {
        // every building the circle reaches is planned whole: in the cell of its middle, or, with its middle past the circle,
        // the cell of its point nearest the centre; one reaching more than edgeGrowthM past the circle is left out, not cut
        let at = b.centroid;
        if (Math.hypot(b.centroid[0], b.centroid[1]) > radiusM) {
            const near = nearestToCentre(b.loops);
            if (!near || near.d >= radiusM) continue;
            const far = Math.max(...b.loops.flat().map(([x, z]) => Math.hypot(x, z)));
            if (far > radiusM + P.edgeGrowthM) {
                leftOut.push({ id: b.id, loops: b.loops, reason: `it reaches ${Math.round(far)} m from the centre, more than ${P.edgeGrowthM} m past the district's ${Math.round(radiusM)} m edge: left out whole rather than cut there` });
                continue;
            }
            at = near.p;
        }
        const k = cellAt(at[0], at[1]);
        if (k < 0) continue;
        owned[k].push(b.id);
        footprints.push({ id: b.id, loops: b.loops, chunk: k });
        for (const loop of b.loops) for (const [x, z] of loop) { const r = box[k]; r.x0 = Math.min(r.x0, x); r.z0 = Math.min(r.z0, z); r.x1 = Math.max(r.x1, x); r.z1 = Math.max(r.z1, z); }
    }
    const chunks = cells.map((c, k) => {
        const r = { x0: box[k].x0 - P.marginM, z0: box[k].z0 - P.marginM, x1: box[k].x1 + P.marginM, z1: box[k].z1 + P.marginM };
        const radius = Math.max(...[[r.x0, r.z0], [r.x1, r.z0], [r.x0, r.z1], [r.x1, r.z1]].map(([x, z]) => Math.hypot(x - c.cx, z - c.cz)));
        return { index: k, cx: c.cx, cz: c.cz, half, rect: r, radiusM: Math.ceil(radius), buildings: owned[k], centre: c.i === 0 && c.j === 0 };
    });
    return { version: DISTRICT_CHUNKS_VERSION, radiusM, cellM: P.cellM, chunks, footprints, ...(leftOut.length ? { leftOut } : {}) };
}

/**
 * A chunked district's builds run side by side (the centre and `parallel` chunks): each takes its share of the cores for
 * its native steps (tile_refine, tile_vegetation, the rectify and window-fit workers), and its time limits grow by the same
 * factor, so a step slowed by sharing the machine is not taken for a failed one (five builds each on every core timed out).
 */
export function chunkCpuShare(cores = machineCores(), P = DISTRICT_CHUNKS_PARAMS, env: NodeJS.ProcessEnv = process.env): { builds: number; threads: number; slowdown: number } {
    // a build alone on its machine: the centre when the chunks run in the cloud, and a chunk in its cloud job
    const builds = kdChunkRunner(env) === 'cloud' || env.SCRATCHBOX_KD_CHUNK_JOB === '1' ? 1 : chunkParallel(P, os.totalmem(), env) + 1;
    const threads = Math.max(2, Math.floor(cores / builds));
    return { builds, threads, slowdown: Math.max(1, cores / threads) };
}

/**
 * Chunk builds at once: `parallel`, fewer when memory is short (a district build holds several GB; 24 GB a build). With the
 * cloud runner each chunk has a machine of its own, so the width is SCRATCHBOX_KD_CLOUD_PARALLEL (default 48: every chunk of
 * a 350 m district at once), set lower when the region's Cloud Run quota does not cover it.
 */
export function chunkParallel(P = DISTRICT_CHUNKS_PARAMS, totalMem = os.totalmem(), env: NodeJS.ProcessEnv = process.env): number {
    if (kdChunkRunner(env) === 'cloud') {
        const n = Number(env.SCRATCHBOX_KD_CLOUD_PARALLEL);
        return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 48;
    }
    return Math.max(1, Math.min(P.parallel, Math.floor(totalMem / (24 * 1024 ** 3)) - 1));
}

/** Where a chunked district's chunks build: on this machine's worker threads, or one Cloud Run job each (SCRATCHBOX_KD_CHUNK_RUNNER=cloud; cloud-chunk-runner.ts). */
export function kdChunkRunner(env: NodeJS.ProcessEnv = process.env): 'local' | 'cloud' {
    return env.SCRATCHBOX_KD_CHUNK_RUNNER?.trim() === 'cloud' ? 'cloud' : 'local';
}

/** This machine's cores: SCRATCHBOX_CPUS when set (a container can report its host's cores, not its own), else what the OS reports. */
export function machineCores(env: NodeJS.ProcessEnv = process.env): number {
    const n = Number(env.SCRATCHBOX_CPUS);
    if (Number.isFinite(n) && n >= 1) return Math.floor(n);
    return typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
}

/** Which chunk a plan point belongs to (see the file comment); -1 past the radius. */
export function chunkOwner(plan: DistrictChunkPlan): (x: number, z: number) => number {
    const inBuilding = districtBuildingIndex(plan.footprints, { marginM: 0, cellM: 20 });
    const inLeftOut = plan.leftOut?.length ? districtBuildingIndex(plan.leftOut, { marginM: 0, cellM: 20 }) : undefined;
    const half = plan.cellM / 2;
    // the cell by its grid position (a point on a cell line goes to the lower row, then the lower column, as the plan's
    // row-major order has it); a point whose cell is not in the plan falls back to the search
    const at = new Map<string, number>();
    plan.chunks.forEach((c, k) => at.set(`${Math.round(c.cx / plan.cellM)},${Math.round(c.cz / plan.cellM)}`, k));
    return (x, z) => {
        const b = inBuilding(x, z);
        if (b >= 0) return plan.footprints[b].chunk;
        if (Math.hypot(x, z) > plan.radiusM || (inLeftOut && inLeftOut(x, z) >= 0)) return -1;
        const k = at.get(`${Math.ceil((x - half) / plan.cellM)},${Math.ceil((z - half) / plan.cellM)}`);
        return k ?? plan.chunks.findIndex(c => Math.abs(x - c.cx) <= half && Math.abs(z - c.cz) <= half);
    };
}

/**
 * What chunk `index` keeps of its own build: what it owns, and, past its edge, a band of `bandM` of ground that no
 * other chunk's building stands on (scene-healing §3.1: neighbouring pieces overlap, then the seam stage trims the
 * overlap by piece order and welds the rims, instead of two cuts meeting edge to edge with a crack between them).
 */
export function chunkTerritory(plan: DistrictChunkPlan, index: number, bandM = 0): (x: number, z: number) => boolean {
    const owner = chunkOwner(plan);
    const inBuilding = districtBuildingIndex(plan.footprints, { marginM: 0, cellM: 20 });
    const probes: Array<[number, number]> = [];
    if (bandM > 0) for (const dx of [-1, 0, 1]) for (const dz of [-1, 0, 1]) if (dx || dz) probes.push([dx * bandM / Math.hypot(dx, dz), dz * bandM / Math.hypot(dx, dz)]);
    return (x, z) => {
        if (owner(x, z) === index) return true;
        if (!probes.length || inBuilding(x, z) >= 0 || Math.hypot(x, z) > plan.radiusM) return false;
        return probes.some(([dx, dz]) => owner(x + dx, z + dz) === index);
    };
}

/** A tangent frame: its origin's latitude, longitude and ellipsoidal height (the extraction's own). */
export interface TileFrame { lat: number; lng: number; originEllipsoidalHeightM: number }

/**
 * The rigid transform (glTF column-major) taking a point of one extraction's frame (x east, y up, z south, about its
 * origin) into another's: through ECEF, exactly, so a chunk 300 m away lands with no curvature error.
 */
export function frameTransform(from: TileFrame, to: TileFrame): Mat4 {
    const a = GoogleTileDistrictCrawler.localFrame(from.lat, from.lng, from.originEllipsoidalHeightM);
    const b = GoogleTileDistrictCrawler.localFrame(to.lat, to.lng, to.originEllipsoidalHeightM);
    // the source frame's axes in ECEF: x = east, y = up, z = south = -north
    const ax = a.east, ay = a.up, az = a.north.map(v => -v);
    const bx = b.east, by = b.up, bz = b.north.map(v => -v);
    const dot = (p: ArrayLike<number>, q: ArrayLike<number>) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
    const d = [a.origin[0] - b.origin[0], a.origin[1] - b.origin[1], a.origin[2] - b.origin[2]];
    const m: Mat4 = new Float64Array(16);
    const cols = [ax, ay, az];
    for (let c = 0; c < 3; c++) { m[c * 4] = dot(cols[c], bx); m[c * 4 + 1] = dot(cols[c], by); m[c * 4 + 2] = dot(cols[c], bz); }
    m[12] = dot(d, bx); m[13] = dot(d, by); m[14] = dot(d, bz); m[15] = 1;
    return m;
}

const multiply = (a: Mat4, b: Mat4): Mat4 => {
    const o: Mat4 = new Float64Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; }
    return o;
};

export interface JoinReport { keptTriangles: number; removedTriangles: number; pieces?: { kept: number; removed: number } }

/**
 * A chunk's layer GLB placed in the district's frame (`transform`, on a new root node over its scene; its vertices are
 * not rewritten) and cut to what `keep` (plan x, z in the district's frame) gives it: triangle by triangle, kept when its
 * middle or any corner lies in it, or with `whole`, connected piece by piece by each piece's middle (trees: never cut through).
 */
export function joinChunkGlb(bytes: Uint8Array, transform: Mat4, keep: (x: number, z: number) => boolean, opts: { whole?: boolean; /** false: the transform on a root node, the vertices as they were. */ bake?: boolean } = {}): { glb: Buffer } & JoinReport {
    const glb = parseGlbBytes(bytes);
    const json = glb.json;
    const local = nodeWorldMatrices(json);
    const extra: Uint8Array[] = [];
    let binLength = glb.bin.byteLength + ((4 - (glb.bin.byteLength % 4)) % 4);
    let removed = 0, kept = 0, piecesKept = 0, piecesRemoved = 0;
    // a mesh drawn by several nodes is cut once, by the first node that draws it
    const done = new Set<number>();
    (json.nodes ?? []).forEach((node: any, ni: number) => {
        if (node.mesh === undefined || done.has(node.mesh)) return;
        done.add(node.mesh);
        const m = multiply(transform, local[ni]);
        for (const prim of json.meshes?.[node.mesh]?.primitives ?? []) {
            if ((prim.mode ?? 4) !== 4 || prim.attributes?.POSITION === undefined) continue;
            const pos = readAccessor(glb, prim.attributes.POSITION).data;
            const idx = prim.indices !== undefined ? readAccessor(glb, prim.indices).data : undefined;
            const count = idx ? idx.length : pos.length / 3;
            const vi = (t: number) => (idx ? idx[t] : t);
            const keepTri = new Uint8Array(count / 3);
            if (opts.whole) {
                // connected pieces (shared vertices), each kept or cut as one, by its middle
                const parent = new Int32Array(pos.length / 3).map((_, i) => i);
                const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
                for (let t = 0; t + 2 < count; t += 3) { const r = find(vi(t)); parent[find(vi(t + 1))] = r; parent[find(vi(t + 2))] = r; }
                const sum = new Map<number, [number, number, number]>();
                for (let t = 0; t + 2 < count; t += 3) {
                    const r = find(vi(t)), s = sum.get(r) ?? [0, 0, 0];
                    for (let k = 0; k < 3; k++) { const v = vi(t + k); s[0] += pos[v * 3]; s[1] += pos[v * 3 + 2]; }
                    s[2] += 3; sum.set(r, s);
                }
                const verdict = new Map<number, boolean>();
                for (const [r, s] of sum) {
                    const w = transformPoint(m, s[0] / s[2], 0, s[1] / s[2]);
                    const k = keep(w[0], w[2]);
                    verdict.set(r, k);
                    if (k) piecesKept++; else piecesRemoved++;
                }
                for (let t = 0; t + 2 < count; t += 3) keepTri[t / 3] = verdict.get(find(vi(t))) ? 1 : 0;
            } else {
                // a triangle that reaches what `keep` gives (its middle or any corner) is kept whole: a long one whose middle lies
                // past the band but which covers ground the chunk keeps would otherwise leave a hole there that only the
                // neighbour covered; the seam stage cuts what lies past the line (district-seams.ts)
                const corner = new Int8Array(pos.length / 3).fill(-1);
                const kept = (v: number) => { if (corner[v] < 0) { const w = transformPoint(m, pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]); corner[v] = keep(w[0], w[2]) ? 1 : 0; } return corner[v] === 1; };
                for (let t = 0; t + 2 < count; t += 3) {
                    const a = vi(t), b = vi(t + 1), c = vi(t + 2);
                    const w = transformPoint(m, (pos[a * 3] + pos[b * 3] + pos[c * 3]) / 3, (pos[a * 3 + 1] + pos[b * 3 + 1] + pos[c * 3 + 1]) / 3, (pos[a * 3 + 2] + pos[b * 3 + 2] + pos[c * 3 + 2]) / 3);
                    keepTri[t / 3] = keep(w[0], w[2]) || kept(a) || kept(b) || kept(c) ? 1 : 0;
                }
            }
            const out: number[] = [];
            for (let t = 0; t + 2 < count; t += 3) if (keepTri[t / 3]) out.push(vi(t), vi(t + 1), vi(t + 2));
            const cut = count / 3 - out.length / 3;
            removed += cut; kept += out.length / 3;
            if (!cut) continue;
            const data = new Uint8Array(new Uint32Array(out).buffer);
            json.bufferViews.push({ buffer: 0, byteOffset: binLength, byteLength: data.byteLength, target: 34963 });
            json.accessors.push({ bufferView: json.bufferViews.length - 1, componentType: 5125, count: out.length, type: 'SCALAR' });
            prim.indices = json.accessors.length - 1;
            extra.push(data);
            binLength += data.byteLength + ((4 - (data.byteLength % 4)) % 4);
        }
    });
    // the district's frame: baked into the vertices when every mesh is drawn by one node (the seam weld reads positions,
    // never node transforms), else on a new root over the scene's roots (instanced meshes: trees, never welded)
    const users = new Map<number, number>();
    for (const n of json.nodes ?? []) if (n.mesh !== undefined) users.set(n.mesh, (users.get(n.mesh) ?? 0) + 1);
    const bake = opts.bake !== false && [...users.values()].every(c => c === 1);
    const scene = json.scenes?.[json.scene ?? 0];
    if (bake) {
        const baked = new Map<string, number>();
        (json.nodes ?? []).forEach((node: any, ni: number) => {
            if (node.mesh === undefined) return;
            const m = multiply(transform, local[ni]);
            for (const prim of json.meshes?.[node.mesh]?.primitives ?? []) for (const attr of ['POSITION', 'NORMAL'] as const) {
                const acc = prim.attributes?.[attr];
                if (acc === undefined) continue;
                const key = `${attr}:${acc}:${ni}`;
                if (baked.has(key)) { prim.attributes[attr] = baked.get(key); continue; }
                const src = readAccessor(glb, acc).data, out = new Float32Array(src.length);
                const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
                for (let v = 0; v + 2 < src.length; v += 3) {
                    let q: number[];
                    if (attr === 'POSITION') q = transformPoint(m, src[v], src[v + 1], src[v + 2]);
                    else {
                        // a rigid transform: the normal turns by its rotation
                        q = [m[0] * src[v] + m[4] * src[v + 1] + m[8] * src[v + 2], m[1] * src[v] + m[5] * src[v + 1] + m[9] * src[v + 2], m[2] * src[v] + m[6] * src[v + 1] + m[10] * src[v + 2]];
                        const l = Math.hypot(q[0], q[1], q[2]) || 1; q = q.map(x => x / l);
                    }
                    for (let k = 0; k < 3; k++) { out[v + k] = q[k]; lo[k] = Math.min(lo[k], q[k]); hi[k] = Math.max(hi[k], q[k]); }
                }
                const data = new Uint8Array(out.buffer);
                json.bufferViews.push({ buffer: 0, byteOffset: binLength, byteLength: data.byteLength, target: 34962 });
                json.accessors.push({ bufferView: json.bufferViews.length - 1, componentType: 5126, count: out.length / 3, type: 'VEC3', ...(attr === 'POSITION' ? { min: lo, max: hi } : {}) });
                prim.attributes[attr] = json.accessors.length - 1;
                baked.set(key, json.accessors.length - 1);
                extra.push(data);
                binLength += data.byteLength + ((4 - (data.byteLength % 4)) % 4);
            }
        });
        for (const n of json.nodes ?? []) { delete n.matrix; delete n.translation; delete n.rotation; delete n.scale; }
    } else if (scene) {
        json.nodes.push({ name: 'district_frame', matrix: Array.from(transform), children: scene.nodes ?? [] });
        scene.nodes = [json.nodes.length - 1];
    }
    const bin = new Uint8Array(binLength);
    bin.set(glb.bin, 0);
    let o = glb.bin.byteLength + ((4 - (glb.bin.byteLength % 4)) % 4);
    for (const e of extra) { bin.set(e, o); o += e.byteLength + ((4 - (e.byteLength % 4)) % 4); }
    if (json.buffers?.[0]) json.buffers[0].byteLength = binLength;
    return { glb: assembleGlb(json, bin), keptTriangles: kept, removedTriangles: removed, ...(opts.whole ? { pieces: { kept: piecesKept, removed: piecesRemoved } } : {}) };
}
