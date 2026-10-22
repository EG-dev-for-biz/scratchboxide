/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The ground of a procedural district: one continuous surface over the extraction, built from measurement, not shown as
 * scanned. Each vertex takes the scan's own surface where that surface is open ground (within a step of the measured
 * terrain: kerbs, steps and raised plazas stay), the median of its open neighbours to take out the scan's noise; where
 * something stands on the ground (a car, a kiosk, a scan lump, a building), it takes the terrain the scan's walkable
 * surface measures. It runs on under the rebuilt buildings (hidden there), so it never leaves a gap at a wall. Planar UVs
 * into a top-down render of the tile photo give it the photo's own colour.
 */

import type { GroundModel } from '../../spatial/StreetViewSurveyPlanner';
import type { RoadMeshPart, RoadStation, RoadSurface } from './road-surfaces';

export const PROCEDURAL_GROUND_VERSION = 'procedural-ground/1';

export const PROCEDURAL_GROUND_PARAMS = {
    /** Vertex spacing (m). */
    cellM: 2,
    /** The scan's surface counts as open ground within this of the terrain, above or below (m). */
    openToleranceM: 1.5,
    /** Neighbourhood (cells of the ground model) the open surface's median is taken over, each way. */
    medianRadius: 1
};

export interface GroundSurface {
    mesh: RoadMeshPart;
    /** uv = ((x - x0) / widthM, (z - z0) / heightM). */
    uvFrame: { x0: number; z0: number; widthM: number; heightM: number };
    stats: { vertices: number; triangles: number; openVertices: number; terrainVertices: number; minY: number; maxY: number };
}

/** The measured height of the ground at (x, z): the open scan surface's local median, else the terrain. */
export function groundHeightAt(ground: Pick<GroundModel, 'groundAt' | 'topAt' | 'cellMeters'>, x: number, z: number, P = PROCEDURAL_GROUND_PARAMS): { y: number; open: boolean } {
    const g = ground.groundAt(x, z);
    const c = ground.cellMeters;
    const vals: number[] = [];
    for (let dz = -P.medianRadius; dz <= P.medianRadius; dz++) for (let dx = -P.medianRadius; dx <= P.medianRadius; dx++) {
        const t = ground.topAt(x + dx * c, z + dz * c), gg = ground.groundAt(x + dx * c, z + dz * c);
        if (Number.isFinite(t) && Number.isFinite(gg) && Math.abs(t - gg) <= P.openToleranceM) vals.push(t);
    }
    if (vals.length >= 3) { vals.sort((a, b) => a - b); return { y: vals[vals.length >> 1], open: true }; }
    return { y: g, open: false };
}

export function buildGroundSurface(input: { ground: Pick<GroundModel, 'groundAt' | 'topAt' | 'cellMeters'>; within: (x: number, z: number) => boolean; bounds: { x0: number; z0: number; x1: number; z1: number }; skip?: (x: number, z: number) => boolean }, P = PROCEDURAL_GROUND_PARAMS): GroundSurface {
    const { x0, z0, x1, z1 } = input.bounds;
    const n = Math.max(1, Math.ceil((x1 - x0) / P.cellM)), m = Math.max(1, Math.ceil((z1 - z0) / P.cellM));
    const frame = { x0, z0, widthM: n * P.cellM, heightM: m * P.cellM };
    const vid = new Int32Array((n + 1) * (m + 1)).fill(-1);
    const positions: number[] = [], uv: number[] = [], indices: number[] = [];
    let open = 0, terrain = 0, minY = Infinity, maxY = -Infinity;
    const vertex = (i: number, k: number): number => {
        const at = k * (n + 1) + i;
        if (vid[at] >= 0) return vid[at];
        const x = x0 + i * P.cellM, z = z0 + k * P.cellM;
        const h = groundHeightAt(input.ground, x, z, P);
        if (!Number.isFinite(h.y)) return -1;
        if (h.open) open++; else terrain++;
        minY = Math.min(minY, h.y); maxY = Math.max(maxY, h.y);
        vid[at] = positions.length / 3;
        positions.push(x, h.y, z);
        uv.push((x - frame.x0) / frame.widthM, (z - frame.z0) / frame.heightM);
        return vid[at];
    };
    for (let k = 0; k < m; k++) for (let i = 0; i < n; i++) {
        const cx = x0 + (i + 0.5) * P.cellM, cz = z0 + (k + 0.5) * P.cellM;
        if (!input.within(cx, cz) || input.skip?.(cx, cz)) continue;
        const a = vertex(i, k), b = vertex(i + 1, k), c = vertex(i + 1, k + 1), d = vertex(i, k + 1);
        if (a < 0 || b < 0 || c < 0 || d < 0) continue;
        // up-facing (y up, z south): a (x0,z0) -> d (x0,z1) -> c (x1,z1) winds counter-clockwise seen from above
        indices.push(a, d, c, a, c, b);
    }
    return {
        mesh: { positions: Float32Array.from(positions), indices: Uint32Array.from(indices), uv: Float32Array.from(uv) }, uvFrame: frame,
        stats: { vertices: positions.length / 3, triangles: indices.length / 3, openVertices: open, terrainVertices: terrain, minY: Number.isFinite(minY) ? minY : 0, maxY: Number.isFinite(maxY) ? maxY : 0 }
    };
}

/** A kerb's height over the carriageway in a procedural district (m). */
export const PROCEDURAL_KERB_M = 0.15;

/**
 * SB-Roadie's measured streets settled onto the procedural ground: each station's levels (its five points across) read from
 * the ground surface at their places plus `liftM`, the kerbs a fixed `kerbM` over them, no scanned sidewalk strip (the
 * ground is the sidewalk). The widths stay as measured where both kerbs showed, a default where they did not, and never
 * past `maxHalfWidthM` (a "kerb" further out is a wall). The scan's own levels made spikes: a kerb read on a wall or a lump
 * rose metres (Federation Square, 2026-10-22).
 */
export function settleRoadsOnGround(roads: RoadSurface[], heightAt: (x: number, z: number) => number, opts: { liftM: number; kerbM?: number; maxHalfWidthM?: number; defaultHalfWidthM?: number }): RoadSurface[] {
    const kerb = opts.kerbM ?? PROCEDURAL_KERB_M, maxHalf = opts.maxHalfWidthM ?? 12, def = opts.defaultHalfWidthM ?? 3.5;
    return roads.map(r => ({
        ...r,
        stations: r.stations.map(st => {
            const side = (s: RoadStation['left']): RoadStation['left'] => {
                const halfWidthM = s.kerb === 'measured' ? Math.min(maxHalf, s.halfWidthM) : def;
                return { halfWidthM, kerb: s.kerb };
            };
            const left = side(st.left), right = side(st.right);
            const at = (d: number) => { const y = heightAt(st.x + st.nx * d, st.z + st.nz * d); return Number.isFinite(y) ? y + opts.liftM : NaN; };
            const centre = at(0);
            const raw = [at(left.halfWidthM), at(left.halfWidthM / 2), centre, at(-right.halfWidthM / 2), at(-right.halfWidthM)];
            const profile = raw.map(y => (Number.isFinite(y) ? y : centre)) as RoadStation['profile'];
            const out: RoadStation = {
                ...st, profile,
                left: { ...left, kerbTopY: profile[0] + kerb },
                right: { ...right, kerbTopY: profile[4] + kerb }
            };
            if (st.median) out.median = { ...st.median, level: centre + kerb };
            return out;
        }).filter(st => Number.isFinite(st.profile[2]))
    }));
}

/**
 * The water's level: a low percentile of the scan's surface over the water areas (a bridge deck or a boat stands above it,
 * the water does not), or undefined when the scan holds too little of it.
 */
export function measureWaterLevel(waterAt: (x: number, z: number) => boolean, topAt: (x: number, z: number) => number, within: (x: number, z: number) => boolean, bounds: { x0: number; z0: number; x1: number; z1: number }, cellM = 2): number | undefined {
    const ys: number[] = [];
    for (let x = bounds.x0; x < bounds.x1; x += cellM) for (let z = bounds.z0; z < bounds.z1; z += cellM) {
        if (!within(x, z) || !waterAt(x, z)) continue;
        const t = topAt(x, z);
        if (Number.isFinite(t)) ys.push(t);
    }
    if (ys.length < 20) return undefined;
    ys.sort((a, b) => a - b);
    return ys[Math.floor(ys.length * 0.15)];
}

/**
 * The water: one flat sheet at its measured level over Google's water areas, a cell wider all round so it runs under the
 * banks; UVs in metres / `tileM` for a tileable surface.
 */
export function buildWaterSurface(input: { waterAt: (x: number, z: number) => boolean; within: (x: number, z: number) => boolean; bounds: { x0: number; z0: number; x1: number; z1: number }; levelY: number; cellM?: number; tileM?: number }): RoadMeshPart & { cells: number } {
    const cell = input.cellM ?? 2, tile = input.tileM ?? 12;
    const positions: number[] = [], uv: number[] = [], indices: number[] = [];
    let cells = 0;
    const wetNear = (x: number, z: number) => { for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (input.waterAt(x + dx * cell, z + dz * cell)) return true; return false; };
    for (let x = input.bounds.x0; x < input.bounds.x1; x += cell) for (let z = input.bounds.z0; z < input.bounds.z1; z += cell) {
        const cx = x + cell / 2, cz = z + cell / 2;
        if (!input.within(cx, cz) || !wetNear(cx, cz)) continue;
        const b = positions.length / 3;
        for (const [px, pz] of [[x, z], [x, z + cell], [x + cell, z + cell], [x + cell, z]]) { positions.push(px, input.levelY, pz); uv.push(px / tile, pz / tile); }
        indices.push(b, b + 1, b + 2, b, b + 2, b + 3);
        cells++;
    }
    return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices), uv: Float32Array.from(uv), cells };
}

/** A tileable water texture (RGBA, size x size): the measured colour of the water, with soft ripples. */
export function waterTexture(rgb: [number, number, number], size = 256): Uint8Array {
    const out = new Uint8Array(size * size * 4);
    const TAU = Math.PI * 2;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const u = x / size, v = y / size;
        // a few periodic waves (whole periods across the tile, so it tiles)
        const w = 0.5 * Math.sin(TAU * (3 * u + 1 * v)) + 0.3 * Math.sin(TAU * (-2 * u + 5 * v) + 1.3) + 0.2 * Math.sin(TAU * (7 * u + 4 * v) + 0.4);
        const k = 1 + 0.06 * w;
        const i = (y * size + x) * 4;
        out[i] = Math.max(0, Math.min(255, rgb[0] * k)); out[i + 1] = Math.max(0, Math.min(255, rgb[1] * k)); out[i + 2] = Math.max(0, Math.min(255, rgb[2] * k)); out[i + 3] = 255;
    }
    return out;
}
