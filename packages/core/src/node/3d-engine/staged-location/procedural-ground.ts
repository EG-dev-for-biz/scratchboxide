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

export function buildGroundSurface(input: { ground: Pick<GroundModel, 'groundAt' | 'topAt' | 'cellMeters'>; within: (x: number, z: number) => boolean; bounds: { x0: number; z0: number; x1: number; z1: number } }, P = PROCEDURAL_GROUND_PARAMS): GroundSurface {
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
        if (!input.within(cx, cz)) continue;
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
