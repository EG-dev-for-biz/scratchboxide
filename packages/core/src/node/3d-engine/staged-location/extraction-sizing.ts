/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Request-sized extraction for an isolated structure, and the one structure pick every later stage uses.
 *
 *  1. Extract a probe at r0 = 25 m (whole leaves touching the circle, about 40-55 m across).
 *  2. Mask the canopy with tile_vegetation's own classifier (the cells strip later calls canopy) when it is available.
 *  3. Build the 1 m surface model and ground model; canopy cells take the ground value in a masked copy (the unmasked
 *     surface is kept for Street View visibility: trees do block a photo).
 *  4. Pick the structure: the 8-connected component of cells 3.0 m or more above the ground that holds the tall cell
 *     nearest the geocoded point, searched within 30 m: tile_refine's own isolate rule, so the probe and the remesh
 *     pick one structure. The seed cell is what tile_refine and scan_fit are given as their anchor.
 *  5. While the structure comes within 3 m of the extraction's edge, extract again by coordinates at (farthest
 *     footprint point) + max(8 m, 0.25 × its diagonal): at most 3 rounds, never past 150 m (the leaf cache serves the
 *     leaves already fetched).
 *  6. Still touching: a district extraction at the last radius, without isolate. A structure is never fitted or shown
 *     clipped (AGENTS.md, Atomic Building Integrity).
 *
 * tile_refine's isolate is handed this pick (writeIsolationPick) and isolates exactly its footprint on its terrain. After
 * the remesh, checkIsolate compares the structure it isolated (its raw_clay.glb, cells standing on the pick's terrain)
 * with the pick: when it strays from the pick, is a shell without its roof, or does not hold the seed, the district around
 * it is remeshed whole and shown instead, without a rebuild (isolate_mismatch), never a partial isolate.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    buildGroundModel,
    findHeroFootprint,
    loadScanMesh,
    surfaceModel,
    type GroundModel,
    type ScanMesh
} from '../../spatial/StreetViewSurveyPlanner';
import type { CanopyMask, Vec2 } from '../../../common/spatial/staged-location-contracts';

/** tile_refine's isolate values (scratchbox_tile_refine.hpp): minimum height, seed search. */
export const STRUCTURE_MIN_HEIGHT_M = 3.0;
export const STRUCTURE_SEED_SEARCH_M = 30;
export const PROBE_RADIUS_M = 25;
export const CONTAINMENT_MARGIN_M = 3;
export const CONTAINMENT_MAX_ROUNDS = 3;
export const CONTAINMENT_MAX_RADIUS_M = 150;
/** No structure at the anchor: the area around it, at this radius, without a rebuild. */
export const NO_STRUCTURE_DISTRICT_RADIUS_M = 60;

export interface StructurePickResult {
    /** Seed cell centre (tile frame x east, z south): the anchor tile_refine and scan_fit are given. */
    seed: { x: number; z: number };
    geocodeToStructureM: number;
    /** World cells (1 m, floor(x), floor(z)) of the structure's component, undilated. */
    cells: Set<string>;
    areaM2: number;
    heightM: number;
    centroid: { x: number; z: number };
    bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
    /** Convex outline of the component (tile frame), counter-clockwise. */
    outline: Vec2[];
    facadeHeadingsDeg: number[];
    groundY: number;
    /** Canopy cells masked out of the surface model (0 without a mask). */
    canopyCellsMasked: number;
    /** Per cell of the ground model's grid: PICK_OPEN, PICK_STRUCTURE, PICK_OTHER, PICK_LOW_ATTACHMENT or PICK_CANOPY. */
    footprintMask: Uint8Array;
    /** The core height of the low-attachment rule (0: not applied). */
    coreHeightM: number;
}

function cellKey(x: number, z: number): string {
    return `${Math.floor(x)},${Math.floor(z)}`;
}

/** Whether a mask cell holds canopy, from its run-length encoding (first run = not canopy). */
export function canopyLookup(mask: CanopyMask): (x: number, z: number) => boolean {
    const flags = new Uint8Array(mask.nx * mask.nz);
    let at = 0, value = 0;
    for (const run of mask.runs) {
        if (value) flags.fill(1, at, Math.min(flags.length, at + run));
        at += run;
        value ^= 1;
    }
    return (x, z) => {
        const i = Math.floor((x - mask.x0) / mask.cellM), k = Math.floor((z - mask.z0) / mask.cellM);
        return i >= 0 && k >= 0 && i < mask.nx && k < mask.nz && flags[k * mask.nx + i] === 1;
    };
}

/** A copy of the ground model whose canopy cells take the ground value. Returns the count masked. */
export function maskCanopy(ground: GroundModel, mask: CanopyMask): { masked: GroundModel; cells: number } {
    const isCanopy = canopyLookup(mask);
    const top = Float32Array.from(ground.top);
    const canopy = new Uint8Array(top.length);
    let cells = 0;
    for (let k = 0; k < ground.nz; k++) for (let i = 0; i < ground.nx; i++) {
        const c = k * ground.nx + i;
        const x = ground.x0 + (i + 0.5) * ground.cellMeters, z = ground.z0 + (k + 0.5) * ground.cellMeters;
        if (isCanopy(x, z) && top[c] === top[c] && ground.ground[c] === ground.ground[c]) { top[c] = ground.ground[c]; canopy[c] = 1; cells++; }
    }
    return { masked: { ...ground, top, canopy, topAt: (x, z) => { const c = ground.cellIndex(x, z); return c < 0 ? NaN : top[c]; } }, cells };
}

function convexHull(points: Vec2[]): Vec2[] {
    const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (pts.length < 3) return pts;
    const cross = (o: Vec2, a: Vec2, b: Vec2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower: Vec2[] = [], upper: Vec2[] = [];
    for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
    for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
    return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/**
 * The structure rule, shared with tile_refine's isolate (it is handed the pick, writeIsolationPick, and isolates exactly
 * these cells on this terrain):
 *  1. tall cells: the (canopy-masked) surface at least `minHeightM` above the walkable terrain (tree canopy the mass
 *     encloses, a roof garden, counts as tall);
 *  2. a morphological opening of the tall cells by a disc scaled to the mass at the seed and to the cell size
 *     (STRUCTURE_OPENING_FRACTION of its half-width, one cell to STRUCTURE_OPENING_MAX_M): necks narrower than the disc (a
 *     one-cell diagonal link, a leftover rim of crown, an alley the scan melted shut part of the way) no longer join two
 *     masses, while every part of a mass at least the disc's width keeps its exact outline;
 *  3. the 4-connected opened component holding the opened cell nearest the anchor (within `seedSearchM`);
 *  4. parts across height discontinuities (joinParts): from the seed's part, the parts it encloses or that are neither low
 *     beside it nor a larger, taller mass it abuts.
 * Every threshold is continuous (metres, a fraction): nothing depends on what kind of structure it is.
 */
/** The opening disc: STRUCTURE_OPENING_FRACTION of the mass's half-width at the seed, at least one cell, at most STRUCTURE_OPENING_MAX_M. */
export const STRUCTURE_OPENING_FRACTION = 0.4;
export const STRUCTURE_OPENING_MAX_M = 4.0;
/** The half-width at the seed is the largest within this of it. */
export const STRUCTURE_THICKNESS_WINDOW_M = 8.0;
/** A part with this share of its rim on the structure is enclosed by it and joins it whatever its height. */
export const STRUCTURE_ENCLOSED_SHARE = 0.5;
export const STRUCTURE_LOW_ATTACHMENT_FRACTION = 0.5;
/** A height discontinuity of a storey or more separates parts of a mass. */
export const STRUCTURE_PART_STEP_M = 3.0;

/** Cell states of a pick (footprintMask): open, the structure, another raised mass, a low attachment left out, tree canopy. */
export const PICK_OPEN = 0, PICK_STRUCTURE = 1, PICK_OTHER = 2, PICK_LOW_ATTACHMENT = 3, PICK_CANOPY = 4;

/** The opening radius in cells for a mass of half-width `halfWidthM` at the seed: scaled to the mass and the cell size. */
export function openingRadiusCells(cellMeters: number, halfWidthM: number, maxM = STRUCTURE_OPENING_MAX_M): number {
    return Math.max(1, Math.min(Math.round(maxM / cellMeters), Math.round((STRUCTURE_OPENING_FRACTION * halfWidthM) / cellMeters)));
}

/** Chamfer distance (m) from each cell of `mask` to the nearest cell outside it (0 outside). */
export function insideDistance(mask: Uint8Array, nx: number, nz: number, cell: number): Float32Array {
    const d = new Float32Array(nx * nz);
    for (let c = 0; c < nx * nz; c++) d[c] = mask[c] ? Infinity : 0;
    const s1 = cell, s2 = cell * Math.SQRT2;
    const relax = (i: number, k: number, ii: number, kk: number, w: number) => {
        const v = ii < 0 || kk < 0 || ii >= nx || kk >= nz ? 0 : d[kk * nx + ii];
        if (v + w < d[k * nx + i]) d[k * nx + i] = v + w;
    };
    for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) { if (!mask[k * nx + i]) continue; relax(i, k, i - 1, k, s1); relax(i, k, i - 1, k - 1, s2); relax(i, k, i, k - 1, s1); relax(i, k, i + 1, k - 1, s2); }
    for (let k = nz - 1; k >= 0; k--) for (let i = nx - 1; i >= 0; i--) { if (!mask[k * nx + i]) continue; relax(i, k, i + 1, k, s1); relax(i, k, i + 1, k + 1, s2); relax(i, k, i, k + 1, s1); relax(i, k, i - 1, k + 1, s2); }
    return d;
}

/** Morphological opening (erosion then dilation) of a binary mask by a disc of `r` cells. */
export function openMask(mask: Uint8Array, nx: number, nz: number, r: number): Uint8Array {
    const offs: Array<[number, number]> = [];
    for (let dk = -r; dk <= r; dk++) for (let di = -r; di <= r; di++) if (di * di + dk * dk <= r * r + r) offs.push([di, dk]);
    const eroded = new Uint8Array(nx * nz);
    for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
        if (!mask[k * nx + i]) continue;
        let ok = 1;
        for (const [di, dk] of offs) {
            const ii = i + di, kk = k + dk;
            if (ii < 0 || kk < 0 || ii >= nx || kk >= nz || !mask[kk * nx + ii]) { ok = 0; break; }
        }
        eroded[k * nx + i] = ok;
    }
    const out = new Uint8Array(nx * nz);
    for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
        if (!eroded[k * nx + i]) continue;
        for (const [di, dk] of offs) {
            const ii = i + di, kk = k + dk;
            if (ii >= 0 && kk >= 0 && ii < nx && kk < nz && mask[kk * nx + ii]) out[kk * nx + ii] = 1;
        }
    }
    return out;
}

function flood4(nx: number, nz: number, seed: number, pass: (c: number) => boolean, out: Uint8Array): void {
    const stack = [seed];
    out[seed] = 1;
    while (stack.length) {
        const c = stack.pop()!;
        const i = c % nx, k = (c / nx) | 0;
        for (let q = 0; q < 4; q++) {
            const ii = i + (q === 0 ? 1 : q === 1 ? -1 : 0), kk = k + (q === 2 ? 1 : q === 3 ? -1 : 0);
            if (ii < 0 || kk < 0 || ii >= nx || kk >= nz) continue;
            const n = kk * nx + ii;
            if (!out[n] && pass(n)) { out[n] = 1; stack.push(n); }
        }
    }
}

/**
 * Parts of a component: 4-connected cells whose surfaces meet with steps under `partStepM` (a pitched roof is one part, a
 * tower standing a storey or more above its base another). From the seed's part the structure takes each neighbouring
 * part that it mostly encloses (STRUCTURE_ENCLOSED_SHARE of the part's rim on the structure: a tower on its podium, an
 * atrium roof), and otherwise each one that is neither
 *  - low: under STRUCTURE_LOW_ATTACHMENT_FRACTION x the seed part's height above the terrain (a sidewalk shed, a lower
 *    annex, a lower neighbour or a tree crown against the facade), nor
 *  - over it: the seed part is under that fraction of the part's height, and the part is the larger (the taller building
 *    the structure abuts),
 * so a tower, a steeple or an upper storey joins its base and the base its tower, while the building next door does not.
 */
export function joinParts(comp: Uint8Array, above: Float32Array, nx: number, nz: number, seed: number, partStepM: number): { kept: Uint8Array; parts: number; lowCutM: number } {
    const N = nx * nz;
    const part = new Int32Array(N).fill(-1);
    const area: number[] = [];
    const heights: number[][] = [];
    const stack: number[] = [];
    for (let s = 0; s < N; s++) {
        if (!comp[s] || part[s] >= 0) continue;
        const id = area.length;
        area.push(0); heights.push([]);
        part[s] = id; stack.push(s);
        while (stack.length) {
            const c = stack.pop()!;
            area[id]++; heights[id].push(above[c]);
            const i = c % nx, k = (c / nx) | 0;
            for (let q = 0; q < 4; q++) {
                const ii = i + (q === 0 ? 1 : q === 1 ? -1 : 0), kk = k + (q === 2 ? 1 : q === 3 ? -1 : 0);
                if (ii < 0 || kk < 0 || ii >= nx || kk >= nz) continue;
                const n = kk * nx + ii;
                if (comp[n] && part[n] < 0 && Math.abs(above[n] - above[c]) < partStepM) { part[n] = id; stack.push(n); }
            }
        }
    }
    const P = area.length;
    const h90 = heights.map(h => { const a = h.slice().sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(0.9 * (a.length - 1)))]; });
    // rims: every 4-edge of a part's cells to a cell outside it, and the share of it on each neighbouring part
    const rim = new Float64Array(P);
    const shared: Array<Map<number, number>> = Array.from({ length: P }, () => new Map());
    for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
        const c = k * nx + i, p = part[c];
        if (p < 0) continue;
        for (let q = 0; q < 4; q++) {
            const ii = i + (q === 0 ? 1 : q === 1 ? -1 : 0), kk = k + (q === 2 ? 1 : q === 3 ? -1 : 0);
            const n = ii < 0 || kk < 0 || ii >= nx || kk >= nz ? -1 : part[kk * nx + ii];
            if (n === p) continue;
            rim[p]++;
            if (n >= 0) shared[p].set(n, (shared[p].get(n) ?? 0) + 1);
        }
    }
    const inS = new Uint8Array(P);
    const s0 = part[seed];
    inS[s0] = 1;
    const seedH = h90[s0];
    const lowCut = STRUCTURE_LOW_ATTACHMENT_FRACTION * seedH;
    let sArea = area[s0];
    for (let changed = true; changed;) {
        changed = false;
        for (let p = 0; p < P; p++) {
            if (inS[p]) continue;
            let onS = 0;
            for (const [q, n] of shared[p]) if (inS[q]) onS += n;
            if (!onS) continue;
            const enclosed = onS >= STRUCTURE_ENCLOSED_SHARE * rim[p];
            const low = h90[p] < lowCut;
            const over = seedH < STRUCTURE_LOW_ATTACHMENT_FRACTION * h90[p] && area[p] > sArea;
            if (!enclosed && (low || over)) continue;
            inS[p] = 1; sArea += area[p];
            changed = true;
        }
    }
    const kept = new Uint8Array(N);
    for (let c = 0; c < N; c++) if (part[c] >= 0 && inS[part[c]]) kept[c] = 1;
    return { kept, parts: P, lowCutM: lowCut };
}

export interface PickOptions {
    anchor?: { x: number; z: number };
    minHeightM?: number;
    seedSearchM?: number;
    canopyCellsMasked?: number;
    /** Fixed opening disc radius (m) instead of the one scaled to the mass; 0 turns the opening off. */
    openingM?: number;
    /** Height discontinuity (m) between parts of a mass. */
    partStepM?: number;
}

/**
 * The structure at the anchor on a (masked) ground model, by the structure rule above. Undefined when no tall cell stands
 * within `seedSearchM` of the anchor.
 */
export function pickStructure(scan: ScanMesh, ground: GroundModel, opts: PickOptions = {}): StructurePickResult | undefined {
    const a = opts.anchor ?? { x: 0, z: 0 };
    const minH = opts.minHeightM ?? STRUCTURE_MIN_HEIGHT_M;
    const { nx, nz, top, cellMeters: cell } = ground;
    const N = nx * nz;
    const above = new Float32Array(N).fill(NaN);
    const tall = new Uint8Array(N);
    for (let c = 0; c < N; c++) {
        if (top[c] === top[c] && ground.ground[c] === ground.ground[c]) above[c] = top[c] - ground.ground[c];
        tall[c] = above[c] >= minH ? 1 : 0;
    }
    // tree canopy the structure encloses (a roof garden) is part of it: canopy cells the grid border cannot reach without
    // crossing tall cells are tall
    if (ground.canopy) {
        const outside = new Uint8Array(N);
        for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
            if (k !== 0 && k !== nz - 1 && i !== 0 && i !== nx - 1) continue;
            const c = k * nx + i;
            if (!tall[c] && !outside[c]) flood4(nx, nz, c, n => !tall[n], outside);
        }
        for (let c = 0; c < N; c++) if (!outside[c] && !tall[c] && ground.canopy[c]) tall[c] = 1;
    }
    const ai = Math.floor((a.x - ground.x0) / cell), ak = Math.floor((a.z - ground.z0) / cell);
    const r = Math.ceil((opts.seedSearchM ?? STRUCTURE_SEED_SEARCH_M) / cell);
    const nearest = (mask: Uint8Array) => {
        let seed = -1, best = Infinity;
        for (let k = ak - r; k <= ak + r; k++) for (let i = ai - r; i <= ai + r; i++) {
            if (i < 0 || k < 0 || i >= nx || k >= nz || !mask[k * nx + i]) continue;
            const d = (i - ai) ** 2 + (k - ak) ** 2;
            if (d <= r * r && d < best) { best = d; seed = k * nx + i; }
        }
        return seed;
    };
    const rawSeed = nearest(tall);
    if (rawSeed < 0) return undefined;
    // the opening disc, scaled to the mass at the seed (its largest half-width within the window)
    let openCells = 0;
    if (opts.openingM !== undefined) openCells = opts.openingM > 0 ? Math.max(1, Math.round(opts.openingM / cell)) : 0;
    else {
        // (measured with the mass's enclosed holes filled: a light well or a roof garden does not make a building thinner)
        const solid = Uint8Array.from(tall);
        const outside = new Uint8Array(N);
        for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
            if (k !== 0 && k !== nz - 1 && i !== 0 && i !== nx - 1) continue;
            const c = k * nx + i;
            if (!tall[c] && !outside[c]) flood4(nx, nz, c, n => !tall[n], outside);
        }
        for (let c = 0; c < N; c++) if (!outside[c]) solid[c] = 1;
        const inside = insideDistance(solid, nx, nz, cell);
        const w = Math.ceil(STRUCTURE_THICKNESS_WINDOW_M / cell), si = rawSeed % nx, sk = (rawSeed / nx) | 0;
        let half = 0;
        for (let k = Math.max(0, sk - w); k <= Math.min(nz - 1, sk + w); k++) for (let i = Math.max(0, si - w); i <= Math.min(nx - 1, si + w); i++) {
            if ((i - si) ** 2 + (k - sk) ** 2 <= w * w) half = Math.max(half, inside[k * nx + i]);
        }
        openCells = openingRadiusCells(cell, half);
    }
    const opened = openCells > 0 ? openMask(tall, nx, nz, openCells) : tall;
    // a structure narrower than the opening disc everywhere (a column, a kiosk) is taken unopened
    let mass = opened;
    let seed = nearest(opened);
    if (seed < 0) { mass = tall; seed = rawSeed; }
    const comp = new Uint8Array(N);
    flood4(nx, nz, seed, c => mass[c] === 1, comp);
    if (mass !== tall) {
        // what the opening took off: a piece touching only this mass is its own (a corner the disc rounded, a narrow wing);
        // one that also touches another opened mass is the neck between them and stays out
        const seen = new Uint8Array(N);
        const piece: number[] = [];
        for (let s0 = 0; s0 < N; s0++) {
            if (seen[s0] || !tall[s0] || mass[s0]) continue;
            piece.length = 0;
            let touchesThis = false, touchesOther = false;
            const st = [s0];
            seen[s0] = 1;
            while (st.length) {
                const c = st.pop()!;
                piece.push(c);
                const i = c % nx, k = (c / nx) | 0;
                for (let q = 0; q < 4; q++) {
                    const ii = i + (q === 0 ? 1 : q === 1 ? -1 : 0), kk = k + (q === 2 ? 1 : q === 3 ? -1 : 0);
                    if (ii < 0 || kk < 0 || ii >= nx || kk >= nz) continue;
                    const n = kk * nx + ii;
                    if (comp[n]) touchesThis = true;
                    else if (mass[n]) touchesOther = true;
                    else if (tall[n] && !seen[n]) { seen[n] = 1; st.push(n); }
                }
            }
            if (touchesThis && !touchesOther) for (const c of piece) comp[c] = 1;
        }
    }
    // parts across height discontinuities, joined to the seed's part by the structure rule
    const parts = joinParts(comp, above, nx, nz, seed, opts.partStepM ?? STRUCTURE_PART_STEP_M);
    // a part left out below the low cut is a low attachment; one left out above it is the taller structure next door
    const coreHeightM = parts.lowCutM;
    const footprintMask = new Uint8Array(N);
    for (let c = 0; c < N; c++) {
        if (comp[c] && !parts.kept[c]) { comp[c] = 0; footprintMask[c] = above[c] < coreHeightM ? PICK_LOW_ATTACHMENT : PICK_OTHER; }
        else footprintMask[c] = comp[c] ? PICK_STRUCTURE : tall[c] ? PICK_OTHER : ground.canopy?.[c] ? PICK_CANOPY : PICK_OPEN;
    }
    const cells = new Set<string>();
    const corners: Vec2[] = [];
    let sx = 0, sz = 0, cnt = 0, hmax = 0;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let c = 0; c < N; c++) {
        if (!comp[c]) continue;
        const i = c % nx, k = (c / nx) | 0;
        const x0 = ground.x0 + i * cell, z0 = ground.z0 + k * cell;
        cells.add(cellKey(x0 + cell / 2, z0 + cell / 2));
        corners.push([x0, z0], [x0 + cell, z0], [x0, z0 + cell], [x0 + cell, z0 + cell]);
        sx += x0 + cell / 2; sz += z0 + cell / 2; cnt++;
        hmax = Math.max(hmax, above[c]);
        minX = Math.min(minX, x0); maxX = Math.max(maxX, x0 + cell); minZ = Math.min(minZ, z0); maxZ = Math.max(maxZ, z0 + cell);
    }
    const si = seed % nx, sk = (seed / nx) | 0;
    const seedPt = { x: ground.x0 + (si + 0.5) * cell, z: ground.z0 + (sk + 0.5) * cell };
    const centroid = { x: sx / cnt, z: sz / cnt };
    // facade headings (no assumed side count) and the ground around it, as the survey planner measures them, on these cells
    const hero = heroOnCells(scan, ground, comp, seed);
    return {
        seed: { x: round3(seedPt.x), z: round3(seedPt.z) },
        geocodeToStructureM: round3(Math.hypot(seedPt.x - a.x, seedPt.z - a.z)),
        cells,
        areaM2: cnt * cell * cell,
        heightM: round3(hmax),
        centroid: { x: round3(centroid.x), z: round3(centroid.z) },
        bounds: { minX, maxX, minZ, maxZ },
        outline: convexHull(corners),
        facadeHeadingsDeg: hero.sideHeadingsDeg.map(round3),
        groundY: round3(hero.groundY),
        canopyCellsMasked: opts.canopyCellsMasked ?? 0,
        footprintMask,
        coreHeightM: round3(coreHeightM)
    };
}

/** The survey planner's hero measurements (facade headings, ground around it) on the picked cells, dilated 2 m. */
function heroOnCells(scan: ScanMesh, ground: GroundModel, comp: Uint8Array, seed: number): { sideHeadingsDeg: number[]; groundY: number } {
    // findHeroFootprint grows its own component; given a top raised only over these cells it finds exactly them
    const top = new Float32Array(ground.top.length);
    for (let c = 0; c < top.length; c++) top[c] = comp[c] ? ground.ground[c] + 1e4 : ground.ground[c];
    const masked: GroundModel = { ...ground, top, topAt: (x, z) => { const c = ground.cellIndex(x, z); return c < 0 ? NaN : top[c]; } };
    const si = seed % ground.nx, sk = (seed / ground.nx) | 0;
    const hero = findHeroFootprint(scan, masked, { anchor: { x: ground.x0 + (si + 0.5) * ground.cellMeters, z: ground.z0 + (sk + 0.5) * ground.cellMeters }, minHeightAboveGroundMeters: 1, dilateMeters: 2 });
    return { sideHeadingsDeg: hero.sideHeadingsDeg, groundY: hero.groundY };
}

function round3(v: number): number {
    return Math.round(v * 1000) / 1000;
}

/** Whether the structure comes within `marginM` of the extracted surface model's edge. */
export function touchesEdge(structure: Pick<StructurePickResult, 'bounds'>, ground: Pick<GroundModel, 'x0' | 'z0' | 'nx' | 'nz' | 'cellMeters'>, marginM = CONTAINMENT_MARGIN_M): boolean {
    const maxX = ground.x0 + ground.nx * ground.cellMeters, maxZ = ground.z0 + ground.nz * ground.cellMeters;
    const b = structure.bounds;
    return b.minX - ground.x0 < marginM || maxX - b.maxX < marginM || b.minZ - ground.z0 < marginM || maxZ - b.maxZ < marginM;
}

/** The radius that contains the structure: farthest footprint point from the anchor + max(8 m, 0.25 × its diagonal). */
export function containmentRadius(structure: Pick<StructurePickResult, 'bounds'>, anchor = { x: 0, z: 0 }): number {
    const b = structure.bounds;
    const far = Math.max(...[[b.minX, b.minZ], [b.maxX, b.minZ], [b.minX, b.maxZ], [b.maxX, b.maxZ]].map(([x, z]) => Math.hypot(x - anchor.x, z - anchor.z)));
    const diag = Math.hypot(b.maxX - b.minX, b.maxZ - b.minZ);
    return Math.ceil(far + Math.max(8, 0.25 * diag));
}

/** tile_refine's core grow (m): triangles within this of the footprint belong to it, so its isolate reaches this far out. */
export const ISOLATE_CORE_GROW_M = 2;
/** Of the structure tile_refine isolated: the share within the core grow of the pick, and the share that is roofed. */
export const ISOLATE_PRECISION_MIN = 0.7;
export const ISOLATE_ROOFED_MIN = 0.6;

export interface IsolateCheck {
    /** Cells of the isolated structure (1 m, standing STRUCTURE_MIN_HEIGHT_M above the pick's terrain). */
    cells: Set<string>;
    areaM2: number;
    /** Share of the isolated cells within ISOLATE_CORE_GROW_M of a picked cell: what tile_refine kept lies on the pick. */
    precision: number;
    /** Share of the picked cells within ISOLATE_CORE_GROW_M of an isolated cell (a vote may legitimately trim the pick). */
    recall: number;
    /** Share of the isolated cells whose highest surface is an up-facing one (a roof), not walls alone (a hollow shell). */
    roofed: number;
    /** Whether the isolated structure holds the seed (within ISOLATE_CORE_GROW_M). */
    holdsSeed: boolean;
    iou: number;
    /** min(precision, roofed), 0 without the seed: below ISOLATE_PRECISION_MIN or a roofed share under ISOLATE_ROOFED_MIN, the isolate is not the pick. */
    agreement: number;
    ok: boolean;
}

function nearCell(k: string, other: ReadonlySet<string>, tolM: number): boolean {
    if (other.has(k)) return true;
    const [x, z] = k.split(',').map(Number);
    const r = Math.ceil(tolM);
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dz * dz <= tolM * tolM && other.has(`${x + dx},${z + dz}`)) return true;
    return false;
}

/**
 * Whether tile_refine isolated the structure picked. tile_refine is handed the pick, so it cannot isolate another
 * structure by its own rule; what can still go wrong is that its result strays from the pick (closure), or that the
 * ownership vote leaves a shell of facades without its roof, or something away from the seed. A vote that trims the pick
 * to a coherent, roofed structure holding the seed is accepted (recall is reported, not required).
 */
export function checkIsolate(rawClayGlb: string, pick: Pick<StructurePickResult, 'cells' | 'seed'>, terrain: GroundModel): IsolateCheck {
    const scan = loadScanMesh(rawClayGlb);
    const cell = terrain.cellMeters;
    const all = surfaceModel(scan, cell);
    const roofs = surfaceModel(scan, cell, t => Math.abs(scan.triNormal[t * 3 + 1]) >= 0.7);
    const cells = new Set<string>();
    let roofed = 0;
    for (let k = 0; k < all.nz; k++) for (let i = 0; i < all.nx; i++) {
        const c = k * all.nx + i;
        const x = all.x0 + (i + 0.5) * cell, z = all.z0 + (k + 0.5) * cell;
        const g = terrain.groundAt(x, z);
        if (!(all.top[c] === all.top[c] && g === g && all.top[c] - g >= STRUCTURE_MIN_HEIGHT_M)) continue;
        cells.add(cellKey(x, z));
        if (roofs.top[c] >= all.top[c] - ISOLATE_ROOF_BAND_M) roofed++;
    }
    let inPick = 0, covered = 0;
    for (const k of cells) if (nearCell(k, pick.cells, ISOLATE_CORE_GROW_M)) inPick++;
    for (const k of pick.cells) if (nearCell(k, cells, ISOLATE_CORE_GROW_M)) covered++;
    const precision = cells.size ? inPick / cells.size : 0;
    const recall = pick.cells.size ? covered / pick.cells.size : 0;
    const roofedShare = cells.size ? roofed / cells.size : 0;
    const holdsSeed = nearCell(cellKey(pick.seed.x, pick.seed.z), cells, ISOLATE_CORE_GROW_M);
    const agreement = holdsSeed ? Math.min(precision, roofedShare) : 0;
    return {
        cells, areaM2: cells.size * cell * cell, precision, recall, roofed: roofedShare, holdsSeed, iou: footprintIoU(pick.cells, cells), agreement,
        ok: holdsSeed && precision >= ISOLATE_PRECISION_MIN && roofedShare >= ISOLATE_ROOFED_MIN
    };
}

/** A roof is the cell's highest surface within this (m): parapets and roof clutter stand above the roof itself. */
export const ISOLATE_ROOF_BAND_M = 1.5;

/** Intersection over union of two cell sets. */
export function footprintIoU(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
    if (a.size === 0 && b.size === 0) return 1;
    let inter = 0;
    for (const k of a) if (b.has(k)) inter++;
    return inter / (a.size + b.size - inter);
}

/** Where strip may measure and regrow trees for an isolated structure: its outline grown by `growM` (apron + crown reach). */
export function grownOutline(outline: Vec2[], growM: number): Vec2[] {
    if (outline.length < 3) return outline;
    // the Minkowski sum of the convex outline and a 12-gon circumscribing a disc of radius growM: at least growM out
    // everywhere, at most growM / cos 15° at the corners
    const pts: Vec2[] = [];
    for (const [x, z] of outline) for (let k = 0; k < 12; k++) {
        const t = (k * Math.PI) / 6;
        pts.push([x + growM * Math.cos(t) / Math.cos(Math.PI / 12), z + growM * Math.sin(t) / Math.cos(Math.PI / 12)]);
    }
    return convexHull(pts).map(([x, z]) => [round3(x), round3(z)] as Vec2);
}

// ----------------------------------------------------------------------------------------------------------------
// the containment loop
// ----------------------------------------------------------------------------------------------------------------

export interface SizingExtraction {
    /** The photo-textured extraction (the surface model is built from it). */
    texturedGlb: string;
}

export interface SizingDeps<E extends SizingExtraction> {
    /** Extracts the leaves within `radiusM` of the geocoded point (whole leaves, the leaf cache serving repeats). */
    extract(radiusM: number, round: number): Promise<E>;
    /** tile_vegetation's canopy classifier on a textured extraction; absent when the engine lacks it. */
    canopy?(texturedGlb: string): Promise<CanopyMask>;
    onProgress?(message: string): void;
    /** A Stop or a time limit: an extraction that fails because of it is never turned into a district fallback. */
    signal?: AbortSignal;
}

export interface SizingNote {
    reasonCode: 'canopy_not_masked' | 'no_structure_at_anchor' | 'containment_failed' | 'district_extract_failed' | (string & {});
    reason: string;
    error?: string;
}

export interface SizingResult<E extends SizingExtraction> {
    extraction: E;
    radiusM: number;
    rounds: number;
    sizedTo: 'structure' | 'district-fallback';
    /** Absent when the request falls back to a district (no structure at the anchor, or containment failed). */
    structure?: StructurePickResult;
    /** The masked ground model of the final extraction, and the unmasked surface (Street View visibility). */
    ground?: GroundModel;
    scan?: ScanMesh;
    unmaskedTop?: Float32Array;
    /** The canopy mask the structure was picked with (absent without a classifier). */
    canopy?: CanopyMask;
    notes: SizingNote[];
    timingsMs: Record<string, number>;
}

export async function sizeExtraction<E extends SizingExtraction>(deps: SizingDeps<E>, opts: { now?: () => number } = {}): Promise<SizingResult<E>> {
    const now = opts.now ?? Date.now;
    const notes: SizingNote[] = [];
    const timings: Record<string, number> = {};
    let radius = PROBE_RADIUS_M;
    let canopyAvailable = !!deps.canopy;
    /** The last extraction that succeeded: real data the call can fall back to when a later, larger one fails. */
    let held: { extraction: E; radius: number; round: number } | undefined;
    for (let round = 1; ; round++) {
        let t = now();
        deps.onProgress?.(round === 1 ? `Extracting a ${radius} m probe around the place` : `Extracting ${radius} m to contain the whole structure (round ${round})`);
        let extraction: E;
        try {
            extraction = await deps.extract(radius, round);
        } catch (err) {
            // the first extraction has nothing to fall back to (no tile coverage); a larger one that fails leaves the district
            // at the last radius that did come back, which is real data
            if (!held || deps.signal?.aborted) throw err;
            notes.push({
                reasonCode: 'containment_failed',
                reason: `extracting ${radius} m to contain the structure failed (${(err as Error).message}); showing the district at ${held.radius} m around it without a rebuild`,
                error: (err as Error).message
            });
            return { extraction: held.extraction, radiusM: held.radius, rounds: held.round, sizedTo: 'district-fallback', notes, timingsMs: timings };
        }
        held = { extraction, radius, round };
        timings[`extract_r${radius}`] = now() - t;
        t = now();
        // the canopy first: the terrain is measured with tree crowns left out, then the crowns take the terrain's value
        let mask: CanopyMask | undefined;
        if (canopyAvailable) {
            t = now();
            try {
                mask = await deps.canopy!(extraction.texturedGlb);
            } catch (err) {
                canopyAvailable = false;
                notes.push({ reasonCode: 'canopy_not_masked', reason: 'the canopy could not be masked, so the structure was picked on the unmasked surface model and may include tree canopy', error: (err as Error).message });
            }
            timings[`canopy_r${radius}`] = now() - t;
        } else if (!notes.some(n => n.reasonCode === 'canopy_not_masked')) {
            notes.push({ reasonCode: 'canopy_not_masked', reason: 'tile_vegetation has no canopy classifier in this build, so the structure was picked on the unmasked surface model and may include tree canopy' });
        }
        t = now();
        const scan = loadScanMesh(extraction.texturedGlb);
        const unmasked = buildGroundModel(scan, { cellMeters: 1, ...(mask ? { exclude: canopyLookup(mask) } : {}) });
        let ground = unmasked, canopyCells = 0;
        if (mask) { const m = maskCanopy(unmasked, mask); ground = m.masked; canopyCells = m.cells; }
        timings[`dsm_r${radius}`] = now() - t;
        const structure = pickStructure(scan, ground, { canopyCellsMasked: canopyCells });
        if (!structure) {
            notes.push({ reasonCode: 'no_structure_at_anchor', reason: `no structure ${STRUCTURE_MIN_HEIGHT_M} m or taller stands within ${STRUCTURE_SEED_SEARCH_M} m of the place; showing the area around it` });
            if (radius === NO_STRUCTURE_DISTRICT_RADIUS_M) return { extraction, radiusM: radius, rounds: round, sizedTo: 'district-fallback', notes, timingsMs: timings };
            try {
                const district = await deps.extract(NO_STRUCTURE_DISTRICT_RADIUS_M, round + 1);
                return { extraction: district, radiusM: NO_STRUCTURE_DISTRICT_RADIUS_M, rounds: round, sizedTo: 'district-fallback', notes, timingsMs: timings };
            } catch (err) {
                if (deps.signal?.aborted) throw err;
                // the wider area did not come back: the area already extracted stands in, whole, as it was downloaded
                notes.push({
                    reasonCode: 'district_extract_failed',
                    reason: `extracting the ${NO_STRUCTURE_DISTRICT_RADIUS_M} m district failed (${(err as Error).message}); showing the ${radius} m already extracted around the place`,
                    error: (err as Error).message
                });
                return { extraction, radiusM: radius, rounds: round, sizedTo: 'district-fallback', notes, timingsMs: timings };
            }
        }
        if (!touchesEdge(structure, ground)) {
            return { extraction, radiusM: radius, rounds: round, sizedTo: 'structure', structure, ground, scan, unmaskedTop: unmasked.top, ...(mask ? { canopy: mask } : {}), notes, timingsMs: timings };
        }
        const next = Math.min(CONTAINMENT_MAX_RADIUS_M, Math.max(radius + 1, containmentRadius(structure)));
        if (round >= CONTAINMENT_MAX_ROUNDS + 1 || radius >= CONTAINMENT_MAX_RADIUS_M) {
            notes.push({ reasonCode: 'containment_failed', reason: `the structure extends past ${radius} m; showing the district around it without a rebuild` });
            return { extraction, radiusM: radius, rounds: round, sizedTo: 'district-fallback', notes, timingsMs: timings };
        }
        radius = next;
    }
}

/**
 * The structure pick on the scan tile_refine is given (the tile with its measured trees taken out, when trees were asked
 * for): the same rule at the same seed and with the same canopy mask, so the footprint tile_refine isolates holds no crown
 * the canopy classifier left in. Undefined when no structure stands there.
 */
export function pickOnScan(glbPath: string, seed: { x: number; z: number }, canopy?: CanopyMask): { pick: StructurePickResult; ground: GroundModel } | undefined {
    const scan = loadScanMesh(glbPath);
    let ground = buildGroundModel(scan, { cellMeters: 1, ...(canopy ? { exclude: canopyLookup(canopy) } : {}) });
    let cells = 0;
    if (canopy) { const m = maskCanopy(ground, canopy); ground = m.masked; cells = m.cells; }
    const pick = pickStructure(scan, ground, { anchor: seed, canopyCellsMasked: cells });
    return pick ? { pick, ground } : undefined;
}

/**
 * Writes the shared structure pick for tile_refine's isolate (SBIP v1, little-endian): "SBIP", u32 1, f64 x0 z0 cell,
 * i32 nx nz, f64 coreHeight seedX seedZ, u8 footprintMask[nx nz] (PICK_* states), f32 terrain[nx nz], f32 top[nx nz]
 * (the surface model the pick was made on). Returns the file.
 */
export function writeIsolationPick(file: string, pick: Pick<StructurePickResult, 'footprintMask' | 'coreHeightM' | 'seed'>, ground: Pick<GroundModel, 'x0' | 'z0' | 'nx' | 'nz' | 'cellMeters' | 'ground' | 'top'>): string {
    const n = ground.nx * ground.nz;
    if (pick.footprintMask.length !== n || ground.ground.length !== n || ground.top.length !== n) throw new Error('writeIsolationPick: the pick and the terrain are on different grids');
    const head = Buffer.alloc(4 + 4 + 24 + 8 + 24);
    head.write('SBIP', 0, 'latin1');
    head.writeUInt32LE(1, 4);
    head.writeDoubleLE(ground.x0, 8); head.writeDoubleLE(ground.z0, 16); head.writeDoubleLE(ground.cellMeters, 24);
    head.writeInt32LE(ground.nx, 32); head.writeInt32LE(ground.nz, 36);
    head.writeDoubleLE(pick.coreHeightM, 40); head.writeDoubleLE(pick.seed.x, 48); head.writeDoubleLE(pick.seed.z, 56);
    const terrain = Buffer.from(Float32Array.from(ground.ground).buffer);
    const top = Buffer.from(Float32Array.from(ground.top).buffer);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.concat([head, Buffer.from(pick.footprintMask.buffer, pick.footprintMask.byteOffset, n), terrain, top]));
    return file;
}
