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
import type { TopDownFrame, TopDownPhoto } from './top-down-photo';
import type { Vec2 } from '../../../common/spatial/staged-location-contracts';
import { rankSurfaceTextures, type SurfaceTextureIndex } from '../../../common/spatial/surface-texture-library';
import { linearToLab } from './texel-exposure';
import { SRGB8_TO_LINEAR } from '../../../common/spatial/photogrammetric-delight';

/** 2: the ground program (land-use areas read as regions, their material decided from measurements; `_SB_GROUND_REGION` per vertex). */
export const PROCEDURAL_GROUND_VERSION = 'procedural-ground/2';

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

// =============================================================================
// The ground program: what each part of the ground is built as, decided from measurements
// =============================================================================

/** A land-use area as the vector evidence carries it (VectorEvidence.landuse): boundary loops in the scan frame, type codes as labels. */
export interface GroundLanduseArea { loops: Vec2[][]; types: string[] }

export const GROUND_PROGRAM_PARAMS = {
    /** Cell the program is measured on (m). */
    cellM: 2,
    /** The photo greenness (`photoGreenness`) that counts as fully vegetated, and the height roughness (m) that counts as fully rough ground. */
    fullGreenness: 0.08, fullRoughnessM: 0.25,
    /** The vegetation score at and above which the ground is planted. */
    plantedAt: 0.5,
    /** The tints the material takes when the photo is not available (linear RGB): labelled estimates, never measured. */
    estimatedTint: { planted: [0.12, 0.2, 0.07] as [number, number, number], paved: [0.26, 0.26, 0.26] as [number, number, number] }
};

/** How green a linear-RGB colour is: green over the mean of red and blue, as a share of the sum (0 for grey, ~0.1 and up for a lawn). */
export function photoGreenness([r, g, b]: [number, number, number]): number {
    const sum = r + g + b;
    return sum <= 1e-6 ? 0 : (g - (r + b) / 2) / sum;
}

/** The ground's measured parameters over one region (a land-use area, or the ground off every area). */
export interface GroundRegionMeasure {
    /** Program cells of the ground inside the extraction the region holds, their area (m²) and share of all ground cells. */
    cells: number; areaM2: number; shareOfExtraction: number;
    /** Of those cells: on the scan's open surface (nothing standing there), under a measured tree crown, under a carriageway. */
    openShare: number; canopyShare: number; roadShare: number;
    /** RMS of the open scan surface's height over its local median (m): the scan's own roughness there. */
    roughnessM: number;
    /** The top-down photo over the region's lit texels, when the photo was given: mean linear RGB and its greenness. */
    photo?: { meanLinearRgb: [number, number, number]; greenness: number; texels: number };
}

/**
 * The material the region is built in: continuous parameters decided from the measurements, never from a type code.
 * `provenance` is always `generated`: the surface heights are measured, the material is a reading of the appearance; `why`
 * names the measurements that decided it.
 */
export interface GroundRegionMaterial {
    /** Linear RGB tint: the photo's mean lit colour where the photo was given, else a labelled estimate. */
    tint: [number, number, number];
    tintSource: 'photo' | 'estimate';
    /** PBR roughness, 0..1. */
    roughness: number;
    /** 0..1: how strongly the measurements say vegetation; `planted` at GROUND_PROGRAM_PARAMS.plantedAt and above. */
    vegetationScore: number;
    planted: boolean;
    /** The low-vegetation density SB-Veggie is asked for there (0 when not planted). */
    vegetationDensity: number;
    /** A surface-library entry chosen by appearance (colour, roughness) when a library index was given. */
    libraryEntryId?: string;
    provenance: 'generated';
    why: string;
}

export interface GroundRegionProgram {
    /** Index into the land-use areas given, or -1 for the ground off every area. */
    area: number;
    /** Google's type codes as received: labels for the notes and the brief; nothing here branches on them. */
    labels: string[];
    measure: GroundRegionMeasure;
    material: GroundRegionMaterial;
}

export interface GroundProgram {
    version: string;
    regions: GroundRegionProgram[];
    /** Per ground vertex: the region (index into `regions`) it lies in; -1 on the rim past every measured cell (the surface's outer edge). */
    vertexRegion: Int16Array;
    /** The land-use areas read, as labels: how many, the type codes seen, and how many had no cell inside the extraction. */
    landuse: { areas: number; typeCodes: string[]; outsideExtraction: number };
    method: string;
}

export const GROUND_PROGRAM_METHOD = 'per region (each Google land-use area inside the extraction, and the ground off every area): the scan\'s open-surface share and height roughness, the measured crowns\' canopy share, the carriageway share and the top-down photo\'s mean lit colour and greenness; vegetation score = mean of the greenness term (the photo; without it the caller\'s label prior, else the canopy share), the canopy share and the roughness term, less half the carriageway share; planted at 0.5 and above, else paved (roughness from the measured flatness); the tint is the photo\'s mean lit colour, or a labelled estimate without the photo; the type codes are labels only';

export interface GroundProgramInput {
    ground: Pick<GroundModel, 'groundAt' | 'topAt' | 'cellMeters'>;
    within: (x: number, z: number) => boolean;
    bounds: { x0: number; z0: number; x1: number; z1: number };
    /** The ground surface the program is for: its vertices take their region. */
    surface: Pick<GroundSurface, 'mesh'>;
    areas: GroundLanduseArea[];
    /** The land-use area index + 1 at (x, z), 0 off every area: `landuseAreaAt(evidenceLookup(...))`, or a test's stand-in. */
    areaAt: (x: number, z: number) => number;
    roadAt?: (x: number, z: number) => boolean;
    /** Where a measured tree crown stands over the ground. */
    canopyAt?: (x: number, z: number) => boolean;
    /** The top-down render of the tile photo over the ground's UV frame, when available. */
    photo?: { photo: TopDownPhoto; frame: TopDownFrame };
    /**
     * Without the photo only: a vegetation prior (0..1) for an area's labels, or undefined for no opinion. The caller's own
     * reading of the labels (a test's, a model's): this module never matches type codes itself.
     */
    labelPrior?: (types: string[]) => number | undefined;
    /** A surface library index to pick each region's entry from, by appearance. */
    library?: SurfaceTextureIndex;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** `areaAt` from the evidence lookup's raster (EvidenceLookup.raster.landuse over EvidenceLookup.grid). */
export function landuseAreaAt(look: { raster: { landuse: Int32Array }; grid: { x0: number; z0: number; nx: number; nz: number; cellMeters: number } }): (x: number, z: number) => number {
    const g = look.grid;
    return (x, z) => {
        const i = Math.floor((x - g.x0) / g.cellMeters), k = Math.floor((z - g.z0) / g.cellMeters);
        return i < 0 || k < 0 || i >= g.nx || k >= g.nz ? 0 : look.raster.landuse[k * g.nx + i];
    };
}

/** `canopyAt` from the strip's measured crowns: a disc of the crown's mean sector radius at each stem. */
export function crownCanopyAt(crowns: Array<{ x: number; z: number; radiusM: number }>, cellM = 4): (x: number, z: number) => boolean {
    const cells = new Map<string, Array<{ x: number; z: number; r2: number }>>();
    for (const c of crowns) {
        if (!(Number.isFinite(c.x) && Number.isFinite(c.z) && c.radiusM > 0)) continue;
        const i0 = Math.floor((c.x - c.radiusM) / cellM), i1 = Math.floor((c.x + c.radiusM) / cellM), k0 = Math.floor((c.z - c.radiusM) / cellM), k1 = Math.floor((c.z + c.radiusM) / cellM);
        for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) {
            const key = `${i},${k}`;
            let list = cells.get(key);
            if (!list) { list = []; cells.set(key, list); }
            list.push({ x: c.x, z: c.z, r2: c.radiusM * c.radiusM });
        }
    }
    return (x, z) => {
        const list = cells.get(`${Math.floor(x / cellM)},${Math.floor(z / cellM)}`);
        if (!list) return false;
        for (const c of list) if ((x - c.x) * (x - c.x) + (z - c.z) * (z - c.z) <= c.r2) return true;
        return false;
    };
}

export function buildGroundProgram(input: GroundProgramInput, P = GROUND_PROGRAM_PARAMS, G = PROCEDURAL_GROUND_PARAMS): GroundProgram {
    const { x0, z0, x1, z1 } = input.bounds;
    const nAreas = input.areas.length;
    type Acc = { cells: number; open: number; canopy: number; road: number; sq: number; rgb: [number, number, number]; texels: number };
    const acc: Acc[] = Array.from({ length: nAreas + 1 }, () => ({ cells: 0, open: 0, canopy: 0, road: 0, sq: 0, rgb: [0, 0, 0], texels: 0 }));
    const slot = (x: number, z: number) => { const a = input.areaAt(x, z); return a > 0 && a <= nAreas ? a : 0; };  // 0: off every area
    const ph = input.photo;
    const per = ph ? Math.max(1, Math.round(P.cellM / ph.photo.texelM)) : 0;
    const lums: number[] = [], px: Array<[number, number, number]> = [];
    let totalCells = 0;
    for (let z = z0; z < z1; z += P.cellM) for (let x = x0; x < x1; x += P.cellM) {
        const cx = x + P.cellM / 2, cz = z + P.cellM / 2;
        if (!input.within(cx, cz)) continue;
        const a = acc[slot(cx, cz)];
        a.cells++; totalCells++;
        const h = groundHeightAt(input.ground, cx, cz, G);
        if (h.open) {
            a.open++;
            const t = input.ground.topAt(cx, cz);
            if (Number.isFinite(t)) a.sq += (t - h.y) * (t - h.y);
        }
        if (input.canopyAt?.(cx, cz)) a.canopy++;
        if (input.roadAt?.(cx, cz)) a.road++;
        if (ph) {
            // the photo's texels over this cell, the darkest third left out (cast shadow), so a shaded lawn stays green
            const px0 = Math.floor((cx - P.cellM / 2 - ph.frame.x0) / ph.photo.texelM), py0 = Math.floor((cz - P.cellM / 2 - ph.frame.z0) / ph.photo.texelM);
            lums.length = 0; px.length = 0;
            for (let y = 0; y < per; y++) for (let xx = 0; xx < per; xx++) {
                const sx = px0 + xx, sy = py0 + y;
                if (sx < 0 || sy < 0 || sx >= ph.photo.width || sy >= ph.photo.height) continue;
                const o = (sy * ph.photo.width + sx) * 4;
                if (ph.photo.rgba[o + 3] === 0) continue;
                const c: [number, number, number] = [SRGB8_TO_LINEAR[ph.photo.rgba[o]], SRGB8_TO_LINEAR[ph.photo.rgba[o + 1]], SRGB8_TO_LINEAR[ph.photo.rgba[o + 2]]];
                px.push(c); lums.push(0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]);
            }
            if (px.length) {
                const cut = lums.slice().sort((p, q) => p - q)[Math.floor(lums.length / 3)];
                for (let i = 0; i < px.length; i++) if (lums[i] >= cut) { a.rgb[0] += px[i][0]; a.rgb[1] += px[i][1]; a.rgb[2] += px[i][2]; a.texels++; }
            }
        }
    }
    const cellArea = P.cellM * P.cellM;
    const regions: GroundRegionProgram[] = [];
    const regionOfSlot = new Int16Array(nAreas + 1).fill(-1);
    let outside = 0;
    for (let s = 0; s <= nAreas; s++) {
        const a = acc[s];
        if (a.cells === 0) { if (s > 0) outside++; continue; }
        const labels = s > 0 ? input.areas[s - 1].types.slice() : [];
        const mean: [number, number, number] | undefined = a.texels ? [a.rgb[0] / a.texels, a.rgb[1] / a.texels, a.rgb[2] / a.texels] : undefined;
        const measure: GroundRegionMeasure = {
            cells: a.cells, areaM2: a.cells * cellArea, shareOfExtraction: totalCells ? a.cells / totalCells : 0,
            openShare: a.open / a.cells, canopyShare: a.canopy / a.cells, roadShare: a.road / a.cells,
            roughnessM: a.open ? Math.sqrt(a.sq / a.open) : 0,
            ...(mean ? { photo: { meanLinearRgb: mean, greenness: photoGreenness(mean), texels: a.texels } } : {})
        };
        regionOfSlot[s] = regions.length;
        regions.push({ area: s - 1, labels, measure, material: decideGroundMaterial(measure, labels, input, P) });
    }
    const pos = input.surface.mesh.positions;
    const vertexRegion = new Int16Array(pos.length / 3);
    for (let v = 0; v < vertexRegion.length; v++) vertexRegion[v] = regionOfSlot[slot(pos[v * 3], pos[v * 3 + 2])];
    const typeCodes = [...new Set(input.areas.flatMap(a => a.types))].sort();
    return { version: PROCEDURAL_GROUND_VERSION, regions, vertexRegion, landuse: { areas: nAreas, typeCodes, outsideExtraction: outside }, method: GROUND_PROGRAM_METHOD };
}

function decideGroundMaterial(m: GroundRegionMeasure, labels: string[], input: Pick<GroundProgramInput, 'labelPrior' | 'library'>, P: typeof GROUND_PROGRAM_PARAMS): GroundRegionMaterial {
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    const r3 = (v: number) => Math.round(v * 1000) / 1000;
    const terms: string[] = [];
    let green: number;
    if (m.photo) { green = clamp01(m.photo.greenness / P.fullGreenness); terms.push(`photo greenness ${m.photo.greenness.toFixed(3)} (${pct(green)} of fully vegetated)`); }
    else {
        const prior = labels.length ? input.labelPrior?.(labels) : undefined;
        if (prior !== undefined) { green = clamp01(prior); terms.push(`no photo: the caller's prior for the labels ${labels.join(', ')} = ${green.toFixed(2)}`); }
        else { green = m.canopyShare; terms.push('no photo and no label prior: the canopy share stands in for the greenness'); }
    }
    const rough = clamp01(m.roughnessM / P.fullRoughnessM);
    terms.push(`canopy ${pct(m.canopyShare)}`, `height roughness ${m.roughnessM.toFixed(2)} m (${pct(rough)} of fully rough)`, `carriageway ${pct(m.roadShare)}`);
    const score = clamp01((green + m.canopyShare + rough) / 3 - m.roadShare * 0.5);
    const planted = score >= P.plantedAt;
    const tintSource: GroundRegionMaterial['tintSource'] = m.photo ? 'photo' : 'estimate';
    const tint: [number, number, number] = m.photo ? m.photo.meanLinearRgb : planted ? P.estimatedTint.planted : P.estimatedTint.paved;
    // planted ground is matte; paved ground is the smoother the flatter the scan measured it (slabs to coarse paving)
    const roughness = r3(planted ? 0.9 : 0.55 + 0.3 * rough);
    const material: GroundRegionMaterial = {
        tint, tintSource, roughness, vegetationScore: r3(score), planted, vegetationDensity: planted ? r3(score) : 0, provenance: 'generated',
        why: `${planted ? 'planted' : 'paved'}: vegetation score ${score.toFixed(2)} ${planted ? '>=' : '<'} ${P.plantedAt} from ${terms.join(', ')}; tint ${tintSource === 'photo' ? 'the photo\'s mean lit colour' : 'an estimate (no photo), labelled'}`
    };
    if (input.library?.surfaces.length) {
        const lab = linearToLab(tint[0], tint[1], tint[2]);
        const pick = rankSurfaceTextures(input.library, { meanLab: [lab[0], lab[1], lab[2]], roughness })[0];
        if (pick) { material.libraryEntryId = pick.id; material.why += `; library entry ${pick.id}, the nearest by colour and roughness`; }
    }
    return material;
}

/** One line per region for the stage's notes: area, labels, the measurements, and the material decided and why. */
export function groundProgramNotes(program: Pick<GroundProgram, 'regions'>): string[] {
    return program.regions.map(r => {
        const m = r.measure, mat = r.material;
        const name = r.area < 0 ? 'ground off every land-use area' : `land-use area ${r.area} [${r.labels.length ? r.labels.join(', ') : 'no type code'}]`;
        return `${name}: ${Math.round(m.areaM2).toLocaleString('en-US')} m² (${Math.round(m.shareOfExtraction * 100)}% of the ground), ${Math.round(m.openShare * 100)}% open scan surface, roughness ${m.roughnessM.toFixed(2)} m, canopy ${Math.round(m.canopyShare * 100)}%, carriageway ${Math.round(m.roadShare * 100)}%${m.photo ? `, photo greenness ${m.photo.greenness.toFixed(3)}` : ', no photo'}; ${mat.why}`;
    });
}

/** A region SB-Veggie is asked to plant low vegetation in: a land-use area's loops (scan frame; empty for the ground off every area) and the density. */
export interface GroundCoverRegion { loops: Vec2[][]; density: number; areaM2: number; labels: string[]; why: string }

export function groundCoverRegions(program: Pick<GroundProgram, 'regions'>, areas: GroundLanduseArea[]): GroundCoverRegion[] {
    return program.regions.filter(r => r.material.planted).map(r => ({
        loops: r.area >= 0 ? areas[r.area].loops : [], density: r.material.vegetationDensity, areaM2: r.measure.areaM2, labels: r.labels, why: r.material.why
    }));
}
