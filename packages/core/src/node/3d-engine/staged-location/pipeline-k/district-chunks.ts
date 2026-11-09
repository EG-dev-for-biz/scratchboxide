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
 *  3. The join: a chunk's layers, built in the chunk's own tangent frame, are cut to what the chunk owns (the scan and the
 *     ground triangle by triangle, each kept when its middle or a corner lies in what the chunk keeps: its own, and a band
 *     of `seamBandM` past its edge; trees whole, by each connected piece's middle) and placed in the district's frame by the
 *     exact rigid transform between the two frames (through ECEF), and compacted. A chunk built in the cloud does all of
 *     that in its own job once it has the district's frame (cutChunkLayer), so the laptop downloads only what it keeps and
 *     only checks and publishes it, on a worker thread (joinChunkLayerFile); a layer that comes uncut is joined there.
 *     joinChunkGlb does the whole join on one machine (the centre built here, the placeholders).
 * Building tasks (SCRATCHBOX_KD_CHUNK_UNIT=building, kdChunkUnit; plan.unit 'building'): every planned building is a chunk
 * of its own, one task (a Cloud Run job) each, after the cells: its extraction is its footprint's box plus the margin, it
 * runs the whole pipeline K over it and keeps only its footprint grown by `buildingReachM` (a scanned wall stands a little
 * past the vector outline), whole; the cells keep the ground, streets and trees around the buildings and build with K's
 * facade work turned off (KD_GROUND_CELL_STEPS: each building in a cell belongs to its own task), so a district takes about
 * as long as its slowest building, not its slowest cell. The cell grid, its lines and the seam stage are the cell plan's:
 * a building task's edge is its outline, where ownership already changed at no cell line.
 * Seams: two neighbouring chunks remeshed the ground on either side of a cell line independently, and harmonised their
 * photos to their own references; the seam stage (district-seams.ts) cuts the overlapping bands exactly at the line, moves
 * the later chunk's cut edge onto the earlier one's, and levels their colour where they meet. A line never runs through a
 * building with a footprint.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Vec2 } from '../../../../common/spatial/staged-location-contracts';
import { GoogleTileDistrictCrawler } from '../../../spatial/GoogleTileDistrictCrawler';
import { accessorLayout, assembleGlb, nodeWorldMatrices, parseGlbBytes, readAccessor, transformPoint, type Mat4, type ParsedGlb } from '../glb-bytes';
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
    edgeGrowthM: 100,
    /**
     * A building task keeps the plan within this of its footprint (m, plan.unit 'building'): a scanned wall stands up to
     * a few decimetres past Google's vector outline, and must stay with the building that rebuilt it, not with the cell.
     */
    buildingReachM: 1
};

/**
 * What a building's cell builds when every building is a task of its own (plan.unit 'building'): K's facade work off (the
 * reader, the window fit, the wall sheets, the material regions), since every surface it would rebuild is cut away and
 * taken from the building's own task; the ground, the streets, the trees and the scan are built as in any chunk.
 */
export const KD_GROUND_CELL_STEPS: Readonly<Record<string, boolean>> = {
    'remesh.facadeRead': false,
    'remesh.windowFit': false,
    'remesh.wallSheets': false,
    'remesh.occlusion': false,
    'twin.materials': false,
    'twin.roofShadow': false,
    'polish.lattice': false
};

/**
 * The shown band (user decision 2026-11-08: a district is shown and explorable within 3 minutes, its model-refined detail
 * after; docs/research/2026-11-08-kd-cloud-processing-design.md): every chunk built with no model call at all (`models`
 * off: the facade reader, the building system, the window reader, material naming and picks, the upscale, the lighting
 * models), no material sets and no facade upscale. Each building keeps K's straightened geometry, its window fit from
 * the photo, and its de-lit, harmonised photos.
 */
export const KD_SHOWN_STEPS: Readonly<Record<string, boolean>> = {
    models: false,
    'twin.materials': false,
    'twin.facadeUpscale': false
};

/** Which band a chunked district builds: SCRATCHBOX_KD_BAND=shown (KD_SHOWN_STEPS), else everything. */
export function kdBand(env: NodeJS.ProcessEnv = process.env): 'shown' | 'full' {
    return env.SCRATCHBOX_KD_BAND?.trim() === 'shown' ? 'shown' : 'full';
}

/**
 * The steps a chunk's build is asked for: the district's, then a building task's cell's ground steps (plan.unit
 * 'building'), then the band's; undefined when none.
 */
export function chunkSteps(plan: DistrictChunkPlan, chunk: DistrictChunk, steps: Record<string, boolean> | undefined, band: 'shown' | 'full'): Record<string, boolean> | undefined {
    const ground = plan.unit === 'building' && isCellChunk(chunk);
    if (!ground && band === 'full') return steps;
    return { ...(steps ?? {}), ...(ground ? KD_GROUND_CELL_STEPS : {}), ...(band === 'shown' ? KD_SHOWN_STEPS : {}) };
}

/**
 * How many of a building plan's largest chunks (cells and building tasks alike) are marked for the fast VMs
 * (SCRATCHBOX_KD_FAST_CHUNKS; default 0): the runner builds them there while a VM is free (cloud-chunk-runner.ts
 * HybridJobs). Set it to the number of VMs. On the pool every chunk builds ~35% slower, so a district is shown in under
 * 3 minutes only with all of its chunks on the VMs (Penn 150 m: 34).
 */
export function kdFastChunks(env: NodeJS.ProcessEnv = process.env): number {
    const n = Number(env.SCRATCHBOX_KD_FAST_CHUNKS);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** The chunks marked for the fast VMs: the `count` largest by extraction area, cells and building tasks alike (ties by index). */
export function fastChunkIndices(plan: DistrictChunkPlan, count: number): Set<number> {
    if (plan.unit !== 'building' || count <= 0) return new Set();
    const area = (c: DistrictChunk) => (c.rect.x1 - c.rect.x0) * (c.rect.z1 - c.rect.z0);
    return new Set([...plan.chunks].sort((a, b) => area(b) - area(a) || a.index - b.index).slice(0, count).map(c => c.index));
}

/** How a chunked district is split: by 120 m cells (each building whole in one), or a task per building beside the cells. */
export type DistrictChunkUnit = 'cell' | 'building';

/** SCRATCHBOX_KD_CHUNK_UNIT=building: a task per building (with the cloud runner and its centre in the cloud only); else cells. */
export function kdChunkUnit(env: NodeJS.ProcessEnv = process.env): DistrictChunkUnit {
    return env.SCRATCHBOX_KD_CHUNK_UNIT?.trim() === 'building' ? 'building' : 'cell';
}

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
    /** 'building': one building's task (plan.unit 'building'); absent: a cell of the grid. */
    kind?: 'building';
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
    /** 'building': every building a task of its own after the cells (the cells keep the ground); absent: cells only. */
    unit?: 'building';
    /** With unit 'building': how far past its footprint a building's task keeps the plan (m). */
    buildingReachM?: number;
}

/** Whether a chunk is one of the grid's cells (not a building's task). */
export const isCellChunk = (c: DistrictChunk): boolean => c.kind !== 'building';

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
export function planDistrictChunks(radiusM: number, buildings: Array<{ id: string; centroid: Vec2; loops: Vec2[][] }>, P = DISTRICT_CHUNKS_PARAMS, unit: DistrictChunkUnit = 'cell'): DistrictChunkPlan | undefined {
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
        // a building task's cell keeps only its ground: its extraction is the cell, not grown to the building
        if (unit !== 'building') for (const loop of b.loops) for (const [x, z] of loop) { const r = box[k]; r.x0 = Math.min(r.x0, x); r.z0 = Math.min(r.z0, z); r.x1 = Math.max(r.x1, x); r.z1 = Math.max(r.z1, z); }
    }
    const farthest = (r: DistrictChunk['rect'], cx: number, cz: number) => Math.ceil(Math.max(...[[r.x0, r.z0], [r.x1, r.z0], [r.x0, r.z1], [r.x1, r.z1]].map(([x, z]) => Math.hypot(x - cx, z - cz))));
    const chunks: DistrictChunk[] = cells.map((c, k) => {
        const r = { x0: box[k].x0 - P.marginM, z0: box[k].z0 - P.marginM, x1: box[k].x1 + P.marginM, z1: box[k].z1 + P.marginM };
        return { index: k, cx: c.cx, cz: c.cz, half, rect: r, radiusM: farthest(r, c.cx, c.cz), buildings: unit === 'building' ? [] : owned[k], centre: c.i === 0 && c.j === 0 };
    });
    if (unit !== 'building') return { version: DISTRICT_CHUNKS_VERSION, radiusM, cellM: P.cellM, chunks, footprints, ...(leftOut.length ? { leftOut } : {}) };
    const cellKeeps = (c: DistrictChunk, id: string) => { c.buildings.push(id); };
    // a task per building, after the cells, in the footprints' order: its box, grown by its reach and the margin
    for (const f of footprints) {
        let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
        for (const loop of f.loops) for (const [x, z] of loop) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); }
        // a building with no outline (only a centroid) has no box to extract: it stays with its cell, as in the cell plan
        if (!(x1 >= x0 && z1 >= z0)) { cellKeeps(chunks[f.chunk], f.id); continue; }
        const g = P.marginM + P.buildingReachM, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
        const r = { x0: x0 - g, z0: z0 - g, x1: x1 + g, z1: z1 + g };
        f.chunk = chunks.length;
        chunks.push({ index: chunks.length, cx, cz, half: Math.max(x1 - x0, z1 - z0) / 2, rect: r, radiusM: farthest(r, cx, cz), buildings: [f.id], centre: false, kind: 'building' });
    }
    return { version: `${DISTRICT_CHUNKS_VERSION}+building`, radiusM, cellM: P.cellM, chunks, footprints, ...(leftOut.length ? { leftOut } : {}), unit: 'building', buildingReachM: P.buildingReachM };
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

/**
 * Where a chunked district's centre cell builds: with the cloud runner, in the cloud as one more chunk job (the hero's query
 * and address kept, its frame the district's), the build here only planning, painting, joining and publishing; on this
 * machine otherwise, or with SCRATCHBOX_KD_CENTRE_RUNNER=local.
 */
export function kdCentreRunner(env: NodeJS.ProcessEnv = process.env): 'local' | 'cloud' {
    return kdChunkRunner(env) === 'cloud' && env.SCRATCHBOX_KD_CENTRE_RUNNER?.trim() !== 'local' ? 'cloud' : 'local';
}

/** This machine's cores: SCRATCHBOX_CPUS when set (a container can report its host's cores, not its own), else what the OS reports. */
export function machineCores(env: NodeJS.ProcessEnv = process.env): number {
    const n = Number(env.SCRATCHBOX_CPUS);
    if (Number.isFinite(n) && n >= 1) return Math.floor(n);
    return typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
}

/** Which chunk a plan point belongs to (see the file comment); -1 past the radius. */
export function chunkOwner(plan: DistrictChunkPlan): (x: number, z: number) => number {
    // a building task keeps its footprint and the reach past it (the nearest footprint within it); a cell, its outline only
    const inBuilding = districtBuildingIndex(plan.footprints, { marginM: plan.unit === 'building' ? (plan.buildingReachM ?? 0) : 0, cellM: 20 });
    const inLeftOut = plan.leftOut?.length ? districtBuildingIndex(plan.leftOut, { marginM: 0, cellM: 20 }) : undefined;
    const half = plan.cellM / 2;
    // the cell by its grid position (a point on a cell line goes to the lower row, then the lower column, as the plan's
    // row-major order has it); a point whose cell is not in the plan falls back to the search
    const at = new Map<string, number>();
    plan.chunks.forEach((c, k) => { if (isCellChunk(c)) at.set(`${Math.round(c.cx / plan.cellM)},${Math.round(c.cz / plan.cellM)}`, k); });
    return (x, z) => {
        const b = inBuilding(x, z);
        if (b >= 0) return plan.footprints[b].chunk;
        if (Math.hypot(x, z) > plan.radiusM || (inLeftOut && inLeftOut(x, z) >= 0)) return -1;
        const k = at.get(`${Math.ceil((x - half) / plan.cellM)},${Math.ceil((z - half) / plan.cellM)}`);
        return k ?? plan.chunks.findIndex(c => isCellChunk(c) && Math.abs(x - c.cx) <= half && Math.abs(z - c.cz) <= half);
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
    // a building's task keeps its own and no band: its edge is its outline, beside the cell's ground
    if (bandM > 0 && isCellChunk(plan.chunks[index])) for (const dx of [-1, 0, 1]) for (const dz of [-1, 0, 1]) if (dx || dz) probes.push([dx * bandM / Math.hypot(dx, dz), dz * bandM / Math.hypot(dx, dz)]);
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

const align4 = (n: number) => n + ((4 - (n % 4)) % 4);

/** Extensions that hold no bufferView or accessor of their own past those the compaction rewrites (EXT_mesh_gpu_instancing's). */
const COMPACT_SAFE_EXTENSION = /^(KHR_materials_\w+|KHR_texture_transform|KHR_texture_basisu|KHR_mesh_quantization|KHR_lights_punctual|EXT_texture_webp|EXT_texture_avif|EXT_mesh_gpu_instancing)$/;

/** An accessor's float VEC3 values: a view of the binary chunk when tightly packed and aligned, else read element by element. */
function vec3Of(glb: ParsedGlb, index: number): ArrayLike<number> {
    const l = accessorLayout(glb.json, index);
    if (l.componentType === 5126 && l.comps === 3 && l.stride === 12 && (glb.bin.byteOffset + l.base) % 4 === 0) return new Float32Array(glb.bin.buffer, glb.bin.byteOffset + l.base, l.count * 3);
    return readAccessor(glb, index).data;
}

/** An index accessor's values, a view of the binary chunk when it can be. */
function indicesOf(glb: ParsedGlb, index: number): ArrayLike<number> {
    const l = accessorLayout(glb.json, index);
    const at = glb.bin.byteOffset + l.base;
    if (l.componentType === 5125 && l.stride === 4 && at % 4 === 0) return new Uint32Array(glb.bin.buffer, at, l.count);
    if (l.componentType === 5123 && l.stride === 2 && at % 2 === 0) return new Uint16Array(glb.bin.buffer, at, l.count);
    return readAccessor(glb, index).data;
}

/**
 * A GLB opened for the join's edits. New data (the cut's indices, the placement's baked positions and normals) goes past
 * the binary chunk as new bufferViews; `finish` writes the file, by default compacted: only the accessors something draws
 * or reads, and the bufferViews they and the images use, are kept, so the data an edit replaced (the uncut indices, the
 * unplaced positions) is not carried along (it was a third of a joined ground layer: 132 MB of 389 MB at Penn Station).
 * Every kept byte is copied as it was; only offsets and indices into the lists change.
 */
class GlbEdit {
    readonly glb: ParsedGlb;
    readonly json: any;
    private length: number;
    /** The appended data, by bufferView. */
    private readonly appended = new Map<number, Uint8Array>();

    constructor(bytes: Uint8Array) {
        this.glb = parseGlbBytes(bytes);
        this.json = this.glb.json;
        this.json.bufferViews ??= [];
        this.json.accessors ??= [];
        this.length = align4(this.glb.bin.byteLength);
    }

    /** `data` as a new bufferView of the binary chunk; the new accessor's index once `accessor` is added for it. */
    accessor(data: Uint8Array, target: number, accessor: Record<string, unknown>): number {
        this.json.bufferViews.push({ buffer: 0, byteOffset: this.length, byteLength: data.byteLength, target });
        this.appended.set(this.json.bufferViews.length - 1, data);
        this.length += align4(data.byteLength);
        this.json.accessors.push({ bufferView: this.json.bufferViews.length - 1, ...accessor });
        return this.json.accessors.length - 1;
    }

    /** Why the file cannot be compacted (data the compaction does not know how to follow), or undefined. */
    private uncompactable(): string | undefined {
        const json = this.json;
        if ((json.buffers?.length ?? 0) > 1 || json.buffers?.[0]?.uri !== undefined) return 'it has an external buffer';
        if (json.bufferViews.some((v: any) => (v.buffer ?? 0) !== 0)) return 'a bufferView names another buffer';
        const ext = (json.extensionsUsed ?? []).find((x: string) => !COMPACT_SAFE_EXTENSION.test(x));
        return ext ? `it uses ${ext}` : undefined;
    }

    /** The file: compacted (the default), or laid out as before, the edits appended past the original binary chunk. */
    finish(compact = true): { glb: Buffer; droppedBytes: number; uncompacted?: string } {
        const l = this.layout(compact);
        return { glb: assembleGlb(this.json, l.bin), droppedBytes: l.droppedBytes, ...(l.uncompacted ? { uncompacted: l.uncompacted } : {}) };
    }

    /** The binary chunk finish writes, the JSON's lists rewritten to match it (the JSON may still be edited before it is assembled). */
    layout(compact = true): { bin: Uint8Array; droppedBytes: number; uncompacted?: string } {
        const json = this.json;
        const why = compact ? this.uncompactable() : 'not asked';
        if (why) {
            const bin = new Uint8Array(this.length);
            bin.set(this.glb.bin, 0);
            for (const [v, d] of this.appended) bin.set(d, json.bufferViews[v].byteOffset);
            if (json.buffers?.[0]) json.buffers[0].byteLength = this.length;
            else if (this.length) json.buffers = [{ byteLength: this.length }];
            return { bin, droppedBytes: 0, ...(compact ? { uncompacted: why } : {}) };
        }
        // the accessors anything reads: primitives (attributes, indices, morph targets), skins, animations, GPU instancing
        const accessors: any[] = json.accessors;
        const used = new Uint8Array(accessors.length);
        const mark = (i: unknown) => { if (Number.isInteger(i) && (i as number) >= 0 && (i as number) < accessors.length) used[i as number] = 1; };
        const eachAccessorRef = (f: (holder: any, key: string) => void) => {
            for (const mesh of json.meshes ?? []) for (const p of mesh.primitives ?? []) {
                for (const k of Object.keys(p.attributes ?? {})) f(p.attributes, k);
                if (p.indices !== undefined) f(p, 'indices');
                for (const t of p.targets ?? []) for (const k of Object.keys(t)) f(t, k);
            }
            for (const s of json.skins ?? []) if (s.inverseBindMatrices !== undefined) f(s, 'inverseBindMatrices');
            for (const a of json.animations ?? []) for (const s of a.samplers ?? []) { f(s, 'input'); f(s, 'output'); }
            for (const n of json.nodes ?? []) { const at = n.extensions?.EXT_mesh_gpu_instancing?.attributes; if (at) for (const k of Object.keys(at)) f(at, k); }
        };
        eachAccessorRef((h, k) => mark(h[k]));
        const accessorMap = new Int32Array(accessors.length).fill(-1);
        const keptAccessors: any[] = [];
        accessors.forEach((a, i) => { if (used[i]) { accessorMap[i] = keptAccessors.length; keptAccessors.push(a); } });
        eachAccessorRef((h, k) => { const i = h[k]; if (Number.isInteger(i) && i >= 0 && i < accessors.length) h[k] = accessorMap[i]; });
        json.accessors = keptAccessors;
        // the bufferViews the kept accessors and the images read
        const views: any[] = json.bufferViews;
        const usedView = new Uint8Array(views.length);
        const markView = (i: unknown) => { if (Number.isInteger(i) && (i as number) >= 0 && (i as number) < views.length) usedView[i as number] = 1; };
        for (const a of keptAccessors) { markView(a.bufferView); markView(a.sparse?.indices?.bufferView); markView(a.sparse?.values?.bufferView); }
        for (const im of json.images ?? []) markView(im.bufferView);
        const viewMap = new Int32Array(views.length).fill(-1);
        const keptViews: any[] = [];
        let length = 0;
        const parts: Array<[number, Uint8Array]> = [];
        views.forEach((v, i) => {
            if (!usedView[i]) return;
            const from = v.byteOffset ?? 0;
            const data = this.appended.get(i) ?? this.glb.bin.subarray(from, from + v.byteLength);
            if (!data || data.byteLength < v.byteLength) throw new Error(`bufferView ${i} reads past the binary chunk`);
            viewMap[i] = keptViews.length;
            keptViews.push({ ...v, byteOffset: length });
            parts.push([length, data.subarray(0, v.byteLength)]);
            length += align4(v.byteLength);
        });
        const remapView = (h: any) => { if (h && h.bufferView !== undefined) h.bufferView = viewMap[h.bufferView]; };
        for (const a of keptAccessors) { remapView(a); remapView(a.sparse?.indices); remapView(a.sparse?.values); }
        for (const im of json.images ?? []) remapView(im);
        json.bufferViews = keptViews;
        const bin = new Uint8Array(length);
        for (const [o, d] of parts) bin.set(d, o);
        if (json.buffers?.[0]) json.buffers[0].byteLength = length;
        else if (length) json.buffers = [{ byteLength: length }];
        return { bin, droppedBytes: this.length - length };
    }
}

/**
 * The cut: each triangle mesh drawn by a node, its node's world matrix and `toPlan` taking it onto the district's plan,
 * cut to `keep` triangle by triangle (kept when its middle or any corner lies in it), or with `whole` connected piece by
 * piece by each piece's middle (trees: never cut through). Vertices and node transforms are left as they are; a cut
 * primitive gets new indices.
 */
function cutGlb(e: GlbEdit, toPlan: Mat4, keep: (x: number, z: number) => boolean, whole: boolean): JoinReport {
    const { glb, json } = e;
    const local = nodeWorldMatrices(json);
    let removed = 0, kept = 0, piecesKept = 0, piecesRemoved = 0;
    // a mesh drawn by several nodes is cut once, by the first node that draws it
    const done = new Set<number>();
    (json.nodes ?? []).forEach((node: any, ni: number) => {
        if (node.mesh === undefined || done.has(node.mesh)) return;
        done.add(node.mesh);
        const m = multiply(toPlan, local[ni]);
        for (const prim of json.meshes?.[node.mesh]?.primitives ?? []) {
            if ((prim.mode ?? 4) !== 4 || prim.attributes?.POSITION === undefined) continue;
            const pos = vec3Of(glb, prim.attributes.POSITION);
            const idx = prim.indices !== undefined ? indicesOf(glb, prim.indices) : undefined;
            const count = idx ? idx.length : pos.length / 3;
            const vi = (t: number) => (idx ? idx[t] : t);
            const keepTri = new Uint8Array(count / 3);
            if (whole) {
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
            let n = 0;
            for (let t = 0; t < keepTri.length; t++) n += keepTri[t];
            const cut = count / 3 - n;
            removed += cut; kept += n;
            if (!cut) continue;
            const out = new Uint32Array(n * 3);
            for (let t = 0, o = 0; t + 2 < count; t += 3) if (keepTri[t / 3]) { out[o++] = vi(t); out[o++] = vi(t + 1); out[o++] = vi(t + 2); }
            prim.indices = e.accessor(new Uint8Array(out.buffer), 34963, { componentType: 5125, count: out.length, type: 'SCALAR' });
        }
    });
    return { keptTriangles: kept, removedTriangles: removed, ...(whole ? { pieces: { kept: piecesKept, removed: piecesRemoved } } : {}) };
}

/**
 * The placement: the district's frame (`transform`) baked into the vertices when every mesh is drawn by one node (the
 * seam weld reads positions, never node transforms), node transforms then cleared; else (instanced meshes: trees, never
 * welded) on a new root over the scene's roots, the vertices as they were. `bake: false` always takes the root node.
 */
function placeGlb(e: GlbEdit, transform: Mat4, bakeAsked = true): void {
    const { glb, json } = e;
    const local = nodeWorldMatrices(json);
    const users = new Map<number, number>();
    for (const n of json.nodes ?? []) if (n.mesh !== undefined) users.set(n.mesh, (users.get(n.mesh) ?? 0) + 1);
    const bake = bakeAsked && [...users.values()].every(c => c === 1);
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
                const src = vec3Of(glb, acc), out = new Float32Array(src.length);
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
                const index = e.accessor(new Uint8Array(out.buffer), 34962, { componentType: 5126, count: out.length / 3, type: 'VEC3', ...(attr === 'POSITION' ? { min: lo, max: hi } : {}) });
                prim.attributes[attr] = index;
                baked.set(key, index);
            }
        });
        for (const n of json.nodes ?? []) { delete n.matrix; delete n.translation; delete n.rotation; delete n.scale; }
    } else if (scene) {
        json.nodes.push({ name: 'district_frame', matrix: Array.from(transform), children: scene.nodes ?? [] });
        scene.nodes = [json.nodes.length - 1];
    }
}

/**
 * A chunk's layer GLB placed in the district's frame (`transform`; see placeGlb) and cut to what `keep` (plan x, z in the
 * district's frame) gives it: triangle by triangle, kept when its middle or any corner lies in it, or with `whole`,
 * connected piece by piece by each piece's middle (trees: never cut through). The file is compacted (GlbEdit.finish)
 * unless `compact: false`. The whole join on one machine: the centre build's own layers, the placeholders; a chunk's
 * layers are cut in its own job (cutChunkLayer) and only placed here (joinChunkLayerFile).
 */
export function joinChunkGlb(bytes: Uint8Array, transform: Mat4, keep: (x: number, z: number) => boolean, opts: { whole?: boolean; /** false: the transform on a root node, the vertices as they were. */ bake?: boolean; compact?: boolean } = {}): { glb: Buffer; droppedBytes: number } & JoinReport {
    const e = new GlbEdit(bytes);
    const report = cutGlb(e, transform, keep, !!opts.whole);
    placeGlb(e, transform, opts.bake !== false);
    const out = e.finish(opts.compact !== false);
    return { glb: out.glb, droppedBytes: out.droppedBytes, ...report };
}

export const KD_CHUNK_CUT_VERSION = 'kd-chunk-cut/1';

/** What a chunk's build needs to cut its own layers (the runner's request; a job without it sends them uncut). */
export interface KdChunkCutSpec {
    version: typeof KD_CHUNK_CUT_VERSION;
    plan: DistrictChunkPlan;
    /**
     * The district's frame: its place, and its origin height once known (the centre's tiles: given when the centre is
     * built here; with the centre in the cloud the centre job publishes it, kdDistrictFrameKey, and the other jobs read it).
     */
    district: { lat: number; lng: number; originEllipsoidalHeightM?: number };
    /** The ground a chunk keeps past its own edge (m): DISTRICT_CHUNKS_PARAMS.seamBandM. */
    bandM: number;
}

/** The record a cut layer carries (asset.extras.scratchbox.kdCut), taken off again on the laptop. */
export interface ChunkCutStamp extends JoinReport {
    version: typeof KD_CHUNK_CUT_VERSION;
    /** The district's run and the chunk the layer was cut for. */
    of: string;
    chunk: number;
    whole: boolean;
    /** The transform it was placed by (frameTransform, column-major): the laptop's must be the same, number for number. */
    transform: number[];
    /** Bytes the compaction dropped, and the file's size before the cut. */
    droppedBytes: number;
    bytesIn: number;
    ms: number;
    /** What the stamp added to the asset's extras (taken off with it, so the published file's extras are the build's). */
    added: { extras: boolean; scratchbox: boolean };
}

/** What chunk `index` keeps of a layer: its own (trees, whole pieces), else its own and the band past its edge. */
export function chunkKeep(plan: DistrictChunkPlan, index: number, whole: boolean, bandM: number): (x: number, z: number) => boolean {
    if (!whole) return chunkTerritory(plan, index, bandM);
    const owner = chunkOwner(plan);
    return (x, z) => owner(x, z) === index;
}

/**
 * The chunk's half of the join, in its own build (kd-chunk-job.ts): a layer cut to what the chunk keeps, placed in the
 * district's frame and compacted, exactly as the laptop would have (joinChunkGlb, the same transform from the same two
 * frames), and stamped (asset.extras.scratchbox.kdCut) so the laptop only checks it and publishes it. The district's frame
 * must be known exactly: its origin height moves a point's x and z only by the ECEF arithmetic's 1e-9 m, but a point
 * lying exactly on a line (a remeshed ground's vertex on its cell line, a footprint's edge) is decided by that, so a cut
 * in an assumed frame differed from the laptop's by a few triangles a chunk at Penn Station; a job without the frame
 * sends its layers uncut.
 */
export function cutChunkLayer(bytes: Uint8Array, o: { frame: TileFrame; district: TileFrame; plan: DistrictChunkPlan; bandM: number; of: string; chunk: number; whole: boolean; now?: () => number }): { glb: Buffer; stamp: ChunkCutStamp } {
    const now = o.now ?? Date.now, t0 = now();
    const transform = frameTransform(o.frame, o.district);
    const e = new GlbEdit(bytes);
    const report = cutGlb(e, transform, chunkKeep(o.plan, o.chunk, o.whole, o.bandM), o.whole);
    placeGlb(e, transform);
    const l = e.layout(true);
    const asset = (e.json.asset ??= { version: '2.0' });
    const added = { extras: asset.extras === undefined, scratchbox: asset.extras?.scratchbox === undefined };
    const stamp: ChunkCutStamp = { version: KD_CHUNK_CUT_VERSION, of: o.of, chunk: o.chunk, whole: o.whole, ...report, transform: Array.from(transform), droppedBytes: l.droppedBytes, bytesIn: bytes.byteLength, ms: now() - t0, added };
    asset.extras ??= {};
    asset.extras.scratchbox ??= {};
    asset.extras.scratchbox.kdCut = stamp;
    return { glb: assembleGlb(e.json, l.bin), stamp };
}

/** The cut stamp a layer carries, taken off its JSON as it was before the stamp (undefined when it carries none). */
function takeCutStamp(json: any): ChunkCutStamp | undefined {
    const extras = json.asset?.extras;
    const stamp = extras?.scratchbox?.kdCut as ChunkCutStamp | undefined;
    if (!stamp) return undefined;
    delete extras.scratchbox.kdCut;
    if (stamp.added?.scratchbox && !Object.keys(extras.scratchbox).length) delete extras.scratchbox;
    if (stamp.added?.extras && !Object.keys(extras).length) delete json.asset.extras;
    return stamp;
}

/** One layer file of a chunk joined on this machine (the chunks stage, on a worker thread: chunk-join-worker.ts). */
export interface ChunkLayerJoinJob {
    source: string;
    target: string;
    /** The chunk's frame into the district's (frameTransform), column-major. */
    transform: number[];
    whole: boolean;
    /** The district's run, the chunk, and what it keeps: a layer that came uncut (a chunk built here) is cut here by them. */
    of: string;
    chunk: number;
    plan: DistrictChunkPlan;
    bandM: number;
}

export interface ChunkLayerJoinResult extends JoinReport {
    /** Where the layer was cut and placed: in its chunk's own build, or here (it came uncut). */
    cutBy: 'job' | 'here';
    bytesIn: number;
    bytesOut: number;
    /** Bytes the compaction dropped (the job's, or this machine's). */
    droppedBytes: number;
    ms: { read: number; cut: number; write: number };
}

/**
 * A chunk's layer file joined and written to `target`. One the chunk's build cut, placed and compacted (cutChunkLayer)
 * is only checked (its stamp names this chunk, this district and this transform, number for number; else it is refused)
 * and written without the stamp. One that came uncut (a chunk built on this machine, a job that had no district frame) is
 * cut, placed and compacted here, as before.
 */
export function joinChunkLayerFile(job: ChunkLayerJoinJob, now: () => number = Date.now): ChunkLayerJoinResult {
    let t = now();
    const bytes = fs.readFileSync(job.source);
    const e = new GlbEdit(bytes);
    const ms = { read: now() - t, cut: 0, write: 0 };
    const stamp = takeCutStamp(e.json);
    let report: JoinReport, droppedBytes: number, glb: Buffer;
    t = now();
    if (stamp) {
        const sameFrame = stamp.transform?.length === 16 && stamp.transform.every((v, i) => v === job.transform[i]);
        if (stamp.version !== KD_CHUNK_CUT_VERSION || stamp.of !== job.of || stamp.chunk !== job.chunk || stamp.whole !== job.whole || !sameFrame) {
            throw new Error(`${path.basename(job.source)} was cut for chunk ${stamp.chunk} of ${stamp.of}${stamp.whole ? ' (whole pieces)' : ''} by ${stamp.version}${sameFrame ? '' : ' in another frame'}, not for chunk ${job.chunk} of ${job.of}${job.whole ? ' (whole pieces)' : ''} by ${KD_CHUNK_CUT_VERSION} in this district's frame`);
        }
        report = { keptTriangles: stamp.keptTriangles, removedTriangles: stamp.removedTriangles, ...(stamp.pieces ? { pieces: stamp.pieces } : {}) };
        droppedBytes = stamp.droppedBytes;
        glb = assembleGlb(e.json, e.glb.bin);
    } else {
        const transform = Float64Array.from(job.transform);
        report = cutGlb(e, transform, chunkKeep(job.plan, job.chunk, job.whole, job.bandM), job.whole);
        placeGlb(e, transform);
        const out = e.finish(true);
        droppedBytes = out.droppedBytes;
        glb = out.glb;
    }
    ms.cut = now() - t;
    t = now();
    fs.writeFileSync(job.target, glb);
    ms.write = now() - t;
    return { ...report, cutBy: stamp ? 'job' : 'here', bytesIn: bytes.byteLength, bytesOut: glb.byteLength, droppedBytes, ms };
}

/** Where the centre job publishes the district's frame for the other chunk jobs: `kd-jobs/<parentRunId>/frame.json`. */
export function kdDistrictFrameKey(of: string): string {
    if (!/^[0-9a-f]{8}$/.test(of)) throw new Error(`not a district run id: ${of}`);
    return `kd-jobs/${of}/frame.json`;
}
