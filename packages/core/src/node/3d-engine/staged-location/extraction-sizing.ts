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
 * After the remesh, footprintIoU compares tile_refine's isolated structure (its raw_clay.glb, by the same 1 m rule)
 * with the probe's: below 0.7 the rebuild stages are skipped (isolate_mismatch).
 */

import {
    buildGroundModel,
    findHeroFootprint,
    loadScanMesh,
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
export const ISOLATE_IOU_MIN = 0.7;

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
    let cells = 0;
    for (let k = 0; k < ground.nz; k++) for (let i = 0; i < ground.nx; i++) {
        const c = k * ground.nx + i;
        const x = ground.x0 + (i + 0.5) * ground.cellMeters, z = ground.z0 + (k + 0.5) * ground.cellMeters;
        if (isCanopy(x, z) && top[c] === top[c] && ground.ground[c] === ground.ground[c]) { top[c] = ground.ground[c]; cells++; }
    }
    return { masked: { ...ground, top, topAt: (x, z) => { const c = ground.cellIndex(x, z); return c < 0 ? NaN : top[c]; } }, cells };
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
 * The structure at the anchor on a (masked) ground model: the component of cells at least `minHeightM` above the
 * ground holding the tall cell nearest the anchor within `seedSearchM`. Undefined when no such cell exists.
 */
export function pickStructure(scan: ScanMesh, ground: GroundModel, opts: { anchor?: { x: number; z: number }; minHeightM?: number; seedSearchM?: number; canopyCellsMasked?: number } = {}): StructurePickResult | undefined {
    const a = opts.anchor ?? { x: 0, z: 0 };
    const minH = opts.minHeightM ?? STRUCTURE_MIN_HEIGHT_M;
    const { nx, nz, top, cellMeters: cell } = ground;
    const tall = new Uint8Array(nx * nz);
    for (let c = 0; c < nx * nz; c++) tall[c] = top[c] === top[c] && ground.ground[c] === ground.ground[c] && top[c] - ground.ground[c] >= minH ? 1 : 0;
    const ai = Math.floor((a.x - ground.x0) / cell), ak = Math.floor((a.z - ground.z0) / cell);
    const r = Math.ceil((opts.seedSearchM ?? STRUCTURE_SEED_SEARCH_M) / cell);
    let seed = -1, best = Infinity;
    for (let k = ak - r; k <= ak + r; k++) for (let i = ai - r; i <= ai + r; i++) {
        if (i < 0 || k < 0 || i >= nx || k >= nz || !tall[k * nx + i]) continue;
        const d = (i - ai) ** 2 + (k - ak) ** 2;
        if (d <= r * r && d < best) { best = d; seed = k * nx + i; }
    }
    if (seed < 0) return undefined;
    const comp = new Uint8Array(nx * nz);
    const stack = [seed];
    comp[seed] = 1;
    while (stack.length) {
        const c = stack.pop()!;
        const i = c % nx, k = (c / nx) | 0;
        for (let dk = -1; dk <= 1; dk++) for (let di = -1; di <= 1; di++) {
            const ii = i + di, kk = k + dk;
            if (ii < 0 || kk < 0 || ii >= nx || kk >= nz) continue;
            const nb = kk * nx + ii;
            if (tall[nb] && !comp[nb]) { comp[nb] = 1; stack.push(nb); }
        }
    }
    const cells = new Set<string>();
    const corners: Vec2[] = [];
    let sx = 0, sz = 0, cnt = 0, hmax = 0;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let c = 0; c < nx * nz; c++) {
        if (!comp[c]) continue;
        const i = c % nx, k = (c / nx) | 0;
        const x0 = ground.x0 + i * cell, z0 = ground.z0 + k * cell;
        cells.add(cellKey(x0 + cell / 2, z0 + cell / 2));
        corners.push([x0, z0], [x0 + cell, z0], [x0, z0 + cell], [x0 + cell, z0 + cell]);
        sx += x0 + cell / 2; sz += z0 + cell / 2; cnt++;
        hmax = Math.max(hmax, top[c] - ground.ground[c]);
        minX = Math.min(minX, x0); maxX = Math.max(maxX, x0 + cell); minZ = Math.min(minZ, z0); maxZ = Math.max(maxZ, z0 + cell);
    }
    const si = seed % nx, sk = (seed / nx) | 0;
    const seedPt = { x: ground.x0 + (si + 0.5) * cell, z: ground.z0 + (sk + 0.5) * cell };
    const centroid = { x: sx / cnt, z: sz / cnt };
    // facade headings (no assumed side count) and the ground around it, as the survey planner measures them, on the
    // same component: seeded at the seed cell, with the same height rule and a 2 m dilation
    const hero = findHeroFootprint(scan, ground, { anchor: seedPt, minHeightAboveGroundMeters: minH, dilateMeters: 2 });
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
        canopyCellsMasked: opts.canopyCellsMasked ?? 0
    };
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

/** Intersection over union of two cell sets. */
export function footprintIoU(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
    if (a.size === 0 && b.size === 0) return 1;
    let inter = 0;
    for (const k of a) if (b.has(k)) inter++;
    return inter / (a.size + b.size - inter);
}

/** The structure tile_refine isolated (its raw_clay.glb), by the same 1 m rule, seeded at the same anchor. */
export function isolatedStructureCells(rawClayGlb: string, seed: { x: number; z: number }): { cells: Set<string>; areaM2: number } {
    const scan = loadScanMesh(rawClayGlb);
    const ground = buildGroundModel(scan, { cellMeters: 1 });
    const pick = pickStructure(scan, ground, { anchor: seed });
    return pick ? { cells: pick.cells, areaM2: pick.areaM2 } : { cells: new Set(), areaM2: 0 };
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
}

export interface SizingNote {
    reasonCode: 'canopy_not_masked' | 'no_structure_at_anchor' | 'containment_failed' | (string & {});
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
    notes: SizingNote[];
    timingsMs: Record<string, number>;
}

export async function sizeExtraction<E extends SizingExtraction>(deps: SizingDeps<E>, opts: { now?: () => number } = {}): Promise<SizingResult<E>> {
    const now = opts.now ?? Date.now;
    const notes: SizingNote[] = [];
    const timings: Record<string, number> = {};
    let radius = PROBE_RADIUS_M;
    let canopyAvailable = !!deps.canopy;
    for (let round = 1; ; round++) {
        let t = now();
        deps.onProgress?.(round === 1 ? `Extracting a ${radius} m probe around the place` : `Extracting ${radius} m to contain the whole structure (round ${round})`);
        const extraction = await deps.extract(radius, round);
        timings[`extract_r${radius}`] = now() - t;
        t = now();
        const scan = loadScanMesh(extraction.texturedGlb);
        const unmasked = buildGroundModel(scan, { cellMeters: 1 });
        timings[`dsm_r${radius}`] = now() - t;
        let ground = unmasked, canopyCells = 0;
        if (canopyAvailable) {
            t = now();
            try {
                const mask = await deps.canopy!(extraction.texturedGlb);
                const m = maskCanopy(unmasked, mask);
                ground = m.masked;
                canopyCells = m.cells;
            } catch (err) {
                canopyAvailable = false;
                notes.push({ reasonCode: 'canopy_not_masked', reason: 'the canopy could not be masked, so the structure was picked on the unmasked surface model and may include tree canopy', error: (err as Error).message });
            }
            timings[`canopy_r${radius}`] = now() - t;
        } else if (!notes.some(n => n.reasonCode === 'canopy_not_masked')) {
            notes.push({ reasonCode: 'canopy_not_masked', reason: 'tile_vegetation has no canopy classifier in this build, so the structure was picked on the unmasked surface model and may include tree canopy' });
        }
        const structure = pickStructure(scan, ground, { canopyCellsMasked: canopyCells });
        if (!structure) {
            notes.push({ reasonCode: 'no_structure_at_anchor', reason: `no structure ${STRUCTURE_MIN_HEIGHT_M} m or taller stands within ${STRUCTURE_SEED_SEARCH_M} m of the place; showing the area around it` });
            const district = radius === NO_STRUCTURE_DISTRICT_RADIUS_M ? extraction : await deps.extract(NO_STRUCTURE_DISTRICT_RADIUS_M, round + 1);
            return { extraction: district, radiusM: NO_STRUCTURE_DISTRICT_RADIUS_M, rounds: round, sizedTo: 'district-fallback', notes, timingsMs: timings };
        }
        if (!touchesEdge(structure, ground)) {
            return { extraction, radiusM: radius, rounds: round, sizedTo: 'structure', structure, ground, scan, unmaskedTop: unmasked.top, notes, timingsMs: timings };
        }
        const next = Math.min(CONTAINMENT_MAX_RADIUS_M, Math.max(radius + 1, containmentRadius(structure)));
        if (round >= CONTAINMENT_MAX_ROUNDS + 1 || radius >= CONTAINMENT_MAX_RADIUS_M) {
            notes.push({ reasonCode: 'containment_failed', reason: `the structure extends past ${radius} m; showing the district around it without a rebuild` });
            return { extraction, radiusM: radius, rounds: round, sizedTo: 'district-fallback', notes, timingsMs: timings };
        }
        radius = next;
    }
}
