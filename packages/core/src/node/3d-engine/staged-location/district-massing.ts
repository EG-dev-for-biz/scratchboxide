/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline E's massing (pipeline-e/massing-spec.ts buildMassing: the vector footprint, heights from the scan's own surface,
 * stepped tiers, roof planes) for every building of a district, without vision.
 *
 * An isolated structure is checked by the overlap of its plan with the scan's structure cells; in a district the scan of
 * one building cannot be cut from its neighbours' (shared walls, joined blocks), and a small footprint's overlap is swamped
 * by any margin. The district check asks what can be answered building by building:
 *   - raised: most of the footprint stands clear of the street in the scan (the vector data and the scan agree a building is
 *     there);
 *   - overhang: little raised scan lies just outside the footprint where no other footprint is (the footprint is not too
 *     small for what was scanned); a raised mass no footprint holds that has width of its own (not a band of facade along
 *     a footprint) is a structure of its own (districtUnmappedStructures: its outline the scan's, photo-inferred), not any building's overhang;
 *   - roof: pipeline E's own roof error against the scan, over the footprint's raised cells;
 *   - scanned: the footprint lies where the scan reaches. A building the scan holds only part of is rebuilt over that part
 *     when a straight cut where the scan ends keeps at least `minScannedShare` of its footprint (clipToScanned); the rest
 *     keeps the scan, and nothing is drawn where the scan never reached.
 * A building that fails keeps the scan, with the reason.
 *
 * Plane first (wall-plane-fit.ts; off unless SCRATCHBOX_STAGED_PLANE_FIRST=1: the user rejected vertical planes everywhere,
 * 2026-10-22, preferring pipeline E's walls moved onto the facades the scan measures): every wall is one
 * plumb plane on its footprint edge at the depth the scan measures, relief only where the scan departs from it consistently
 * over a real area, and the scan's lumps on the walls taken out of the residual. A building failing a soft check (running
 * past the extraction, scan spilling past its footprint) is then rebuilt anyway with the failure as its
 * labelled caveat (believability first): a planar building is a better guess than the lumpy scan. One the scan shows as
 * street (raised share) is still never built, and one whose roof is well off the scan keeps it (a pitched or spired roof a
 * flat massing would erase).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { GroundModel } from '../../spatial/StreetViewSurveyPlanner';
import type { EvidenceLookup, VectorBuilding } from './vector-footprints';
import { buildMassing, checkMassing, type Massing } from './pipeline-e/massing-spec';
import { massingProvenance, plainTextures, runNativeMassing, writeMassingLayer, type MassingLayerFiles } from './pipeline-e/pipeline-e';
import type { FaceTexture, TexelSource } from './pipeline-e/massing-glb';
import type { MassingRun } from './pipeline-e/native-massing';
import { FOOTPRINT_GROUND_CLEARANCE_M, hideFootprintInGlb, type StructureFootprint } from './kept-structure';
import { APRON_HEIGHT_M } from './pipeline-e/residual-audit-e';
import { cellsFootprint, inLoops, ringArea } from './pipeline-e/massing-spec';
import { carveCourtyards, COURTYARD_FLOOR_TOKEN, fitRooftopSolids, roofDebrisDecider, ROOF_AND_VOIDS_VERSION, ROOFTOP_SOLID_TOKEN, type RooftopRecord, type VoidRecord } from './roof-and-voids';
import { dropResidualClusters, dropWallBandResidual, planeFirstMassing, PLANE_RELIEF_TOKEN, WALL_PLANE_FIT_VERSION, type PlaneFirstMassing, type PlaneFirstWall, type WallSampleIndex } from './wall-plane-fit';
import type { ProvenanceRecord, Vec2 } from '../../../common/spatial/staged-location-contracts';
import type { MassingNode } from './pipeline-e/native-massing';
import type { MassingPart } from './pipeline-e/massing-spec';
import { stagedDistrict } from './staged-switches';

/** Plane-first walls (wall-plane-fit.ts): off unless SCRATCHBOX_STAGED_PLANE_FIRST=1. */
export function planeFirstEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.SCRATCHBOX_STAGED_PLANE_FIRST === '1';
}

export const DISTRICT_MASSING_VERSION = `district-massing/2${planeFirstEnabled() ? `+${WALL_PLANE_FIT_VERSION}+${ROOF_AND_VOIDS_VERSION}` : ''}`;

/**
 * The district massing stage: pipeline E's massing for every building the scan confirms, the default for districts (user
 * decision 2026-10-22, "pipeline E as our default for districts"); a district shown as scanned or as kd has none (the
 * request's `district`, else SCRATCHBOX_STAGED_DISTRICT).
 */
export function districtMassingEnabled(request: { district?: string } = {}, env: NodeJS.ProcessEnv = process.env): boolean {
    const mode = stagedDistrict(request, env);
    return mode === 'massing' || mode === 'rebuilt';
}

/**
 * SCRATCHBOX_STAGED_DISTRICT=rebuilt: the district is shown rebuilt, not scanned: every building the scan confirms rebuilt
 * (lenient), the ground a measured surface, the streets SB-Roadie's carriageways and kerbs; the scan stays as the reference
 * the rebuilt layers supersede (user direction, 2026-10-22: the tiles as a visual reference, the scene recreated).
 */
export function proceduralDistrictEnabled(request: { district?: string } = {}, env: NodeJS.ProcessEnv = process.env): boolean {
    return stagedDistrict(request, env) === 'rebuilt';
}

/**
 * The face texel of a district's rebuilt buildings, metres: pipeline E's 5 cm suits one hero structure; 53 Federation
 * Square buildings at 5 cm wrote 151 MB of texture. The leaf tiles' own photo is coarser than this.
 */
export const DISTRICT_TEXEL_M = 0.15;

/** The district's footprints are read this far past the extraction (m), so a building it holds only part of is seen whole. */
export const DISTRICT_EVIDENCE_REACH_M = 60;

export const DISTRICT_MASSING_PARAMS = {
    /** A cell is raised when the scan stands this far over the measured ground there. */
    raisedM: 2.5,
    /** At least this share of the footprint raised. */
    minRaisedShare: 0.6,
    /** Raised cells in a ring this wide outside the footprint, in no other footprint, at most this share of the footprint. */
    overhangRingM: 1.5,
    maxOverhangShare: 0.35,
    /** A building the scan holds only part of is rebuilt over that part when the cut keeps at least this share of its footprint. */
    minScannedShare: 0.9,
    /**
     * A raised mass in no footprint is a structure of its own when at least this much of it (m2) lies `unmappedCoreM` or
     * more inside it (from the street, a footprint, anything it is not): a facade standing past a footprint that is too
     * small is a band along it, however long, and never qualifies (at Penn such bands ran 2 to 5 m along whole blocks).
     */
    unmappedMinAreaM2: 6,
    unmappedCoreM: 3
};

/**
 * A raised mass the scan shows where no Google footprint is (districtUnmappedStructures): its own outline, traced from the
 * scan's cells (photo-inferred, never vector-modelled). It keeps the scan; no building counts it as its overhang, and no
 * rebuilt neighbour's cut reaches into it.
 */
export interface UnmappedStructureOutline {
    id: string;
    label: 'photo-inferred';
    areaM2: number;
    heightM: number;
    centroid: Vec2;
    outline: Vec2[];
    /** The buildings whose footprint it touches (their ids). */
    touches: string[];
    /** Its cells ("floor(x),floor(z)"). */
    cells: Set<string>;
}

export interface DistrictBuildingMassing {
    id: string;
    /** Index into the vector evidence's buildings. */
    index: number;
    groundY: number;
    footprintCells: number;
    raisedShare: number;
    overhangShare: number;
    /** Raised cells around the footprint that belong to an unmapped structure of their own, as a share of the footprint (not counted as overhang). */
    unmappedShare?: number;
    /** A building the scan holds only part of, rebuilt over that part: the cut (keep dot([x, z], normal) <= offset), and the shares of its footprint the scan holds and the cut keeps. */
    clip?: ScanClip;
    massing?: Massing;
    ok: boolean;
    reason?: string;
    /**
     * Lenient (a procedural district, where the scan is not shown and a building left out would be missing): a check the
     * building failed but was rebuilt anyway, from its footprint and what the scan does measure. Its confidence is lower.
     */
    caveat?: string;
    /** Plane first: the walls fitted to the scan, their relief as native items, and the overhang left once the walls moved. */
    planeFirst?: Omit<PlaneFirstMassing<MassingPart>, 'parts'> & { overhangAfterShare: number; voids: VoidRecord[]; rooftops: RooftopRecord[] };
    ms: number;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/** A building's footprint cells where the scan reaches, and those where it does not (`outside`, their count). */
export interface FootprintCells { cells: Array<[number, number]>; outside: number; outsideCells: Array<[number, number]> }

/** Each building's footprint cells inside the extraction, and whether any part of it lies outside. */
export function footprintCellsByBuilding(look: EvidenceLookup, within: (x: number, z: number) => boolean): Map<number, FootprintCells> {
    const g = look.grid, raster = look.raster.building;
    const out = new Map<number, FootprintCells>();
    for (let k = 0; k < g.nz; k++) for (let i = 0; i < g.nx; i++) {
        const b = raster[k * g.nx + i] - 1;
        if (b < 0) continue;
        const x = g.x0 + (i + 0.5) * g.cellMeters, z = g.z0 + (k + 0.5) * g.cellMeters;
        const e = out.get(b) ?? { cells: [], outside: 0, outsideCells: [] };
        if (within(x, z)) e.cells.push([Math.floor(x), Math.floor(z)]); else { e.outside++; e.outsideCells.push([Math.floor(x), Math.floor(z)]); }
        out.set(b, e);
    }
    return out;
}

/** The straight cut of a building the scan holds only part of: its plan is kept where dot([x, z], normal) <= offset. */
export interface ScanClip { normal: Vec2; offset: number; scannedShare: number; keptShare: number }

/** Whether the 1 m cell at (x, z) (its floor corner) lies wholly on the kept side of a clip. */
export const clipKeepsCell = (c: Pick<ScanClip, 'normal' | 'offset'>, x: number, z: number): boolean =>
    Math.max(x * c.normal[0], (x + 1) * c.normal[0]) + Math.max(z * c.normal[1], (z + 1) * c.normal[1]) <= c.offset + 1e-9;

/**
 * The straight cut that keeps the most of a footprint's scanned cells and none of its unscanned ones: tried across the
 * direction from the scanned cells toward the unscanned, the direction from the scan's centre, and the four axes, each
 * placed at the nearest unscanned cell. Undefined when the footprint is wholly scanned or no cut keeps anything.
 */
export function clipToScanned(fp: Pick<FootprintCells, 'cells' | 'outsideCells'>): ScanClip | undefined {
    if (!fp.outsideCells.length || !fp.cells.length) return undefined;
    const mean = (cs: Array<[number, number]>): Vec2 => { let x = 0, z = 0; for (const [a, b] of cs) { x += a + 0.5; z += b + 0.5; } return [x / cs.length, z / cs.length]; };
    const ci = mean(fp.cells), co = mean(fp.outsideCells);
    const unit = (v: Vec2): Vec2 | undefined => { const l = Math.hypot(v[0], v[1]); return l > 1e-9 ? [v[0] / l, v[1] / l] : undefined; };
    const dirs = [unit([co[0] - ci[0], co[1] - ci[1]]), unit(co), [1, 0], [-1, 0], [0, 1], [0, -1]].filter((d): d is Vec2 => !!d);
    const total = fp.cells.length + fp.outsideCells.length;
    let best: ScanClip | undefined, bestKept = 0;
    for (const normal of dirs) {
        // the cut at the nearest corner of any unscanned cell along the normal: no unscanned cell is kept, even in part
        let offset = Infinity;
        for (const [x, z] of fp.outsideCells) offset = Math.min(offset, Math.min(x * normal[0], (x + 1) * normal[0]) + Math.min(z * normal[1], (z + 1) * normal[1]));
        const clip = { normal, offset };
        const kept = fp.cells.reduce((a, [x, z]) => a + (clipKeepsCell(clip, x, z) ? 1 : 0), 0);
        if (kept > bestKept) { bestKept = kept; best = { normal, offset, scannedShare: r2(fp.cells.length / total), keptShare: Math.floor((kept / total) * 100) / 100 }; }
    }
    return best;
}

/**
 * A ring cut to the half-plane dot(p, normal) <= offset, as simple rings: the ring's runs on the kept side, each closed
 * along the cut line by the chord to the next crossing (crossings along the line paired in order, so a concave ring cut
 * across several times gives one ring per piece, never a ring that doubles back along the line).
 */
export function clipRingToHalfPlane(ring: Vec2[], normal: Vec2, offset: number): Vec2[][] {
    const n = ring.length;
    const s = ring.map(([x, z]) => offset - (x * normal[0] + z * normal[1]));
    if (s.every(v => v >= 0)) return [ring.slice()];
    if (s.every(v => v < 0)) return [];
    const along: Vec2 = [-normal[1], normal[0]];
    const nodes: Array<{ p: Vec2; cross?: 'enter' | 'exit'; t?: number }> = [];
    for (let i = 0; i < n; i++) {
        const a = ring[i], b = ring[(i + 1) % n], sa = s[i], sb = s[(i + 1) % n];
        if (sa >= 0) nodes.push({ p: a });
        if ((sa >= 0) !== (sb >= 0)) {
            const t = sa / (sa - sb);
            const p: Vec2 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
            nodes.push({ p, cross: sa >= 0 ? 'exit' : 'enter', t: p[0] * along[0] + p[1] * along[1] });
        }
    }
    const crosses = nodes.map((nd, i) => ({ nd, i })).filter(x => x.nd.cross).sort((u, v) => u.nd.t! - v.nd.t!);
    const partner = new Map<number, number>();
    for (let k = 0; k + 1 < crosses.length; k += 2) { partner.set(crosses[k].i, crosses[k + 1].i); partner.set(crosses[k + 1].i, crosses[k].i); }
    const used = new Set<number>();
    const pieces: Vec2[][] = [];
    for (let start = 0; start < nodes.length; start++) {
        if (used.has(start) || nodes[start].cross !== 'enter') continue;
        const piece: Vec2[] = [];
        let i = start;
        for (let guard = 0; guard <= nodes.length; guard++) {
            used.add(i);
            const p = nodes[i].p, last = piece[piece.length - 1];
            if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 1e-9) piece.push(p);
            const next = nodes[i].cross === 'exit' ? partner.get(i) : (i + 1) % nodes.length;
            if (next === undefined || next === start || used.has(next)) break;
            i = next;
        }
        if (piece.length >= 3 && Math.abs(ringArea(piece)) >= 1e-6) pieces.push(piece);
    }
    return pieces;
}

/**
 * The building cut to the part the scan holds (clip): each extruded part's loops (else its plan's) cut to the clip's
 * half-plane; its modelled volumes left out (they cannot be cut honestly), so its heights come from the scan over what is
 * kept. Undefined when nothing is left.
 */
export function clipBuilding(b: VectorBuilding, clip: Pick<ScanClip, 'normal' | 'offset'>): VectorBuilding | undefined {
    const source = (b.extruded?.length ? b.extruded : b.parts.map(loops => ({ loops, ...(b.heightM !== undefined ? { heightM: b.heightM } : {}) }))).map(p => ({ ...p, planOnly: undefined }));
    const extruded = source.map(p => {
        // the outer ring (the largest) cut into pieces; every other loop (a hole) cut on its own and kept with every piece
        const outerIdx = p.loops.reduce((bi, l, i) => (Math.abs(ringArea(l)) > Math.abs(ringArea(p.loops[bi])) ? i : bi), 0);
        const holes = p.loops.flatMap((l, i) => (i === outerIdx ? [] : clipRingToHalfPlane(l, clip.normal, clip.offset)));
        return clipRingToHalfPlane(p.loops[outerIdx], clip.normal, clip.offset).map(outer => ({ ...p, loops: [outer, ...holes.filter(h => inLoops(h[0][0], h[0][1], [outer]))] }));
    }).flat().filter(p => p.loops.length && Math.abs(ringArea(p.loops[0])) >= 1);
    if (!extruded.length) return undefined;
    return { ...b, parts: extruded.map(p => p.loops), extruded: extruded.map(({ planOnly: _p, ...p }) => p), volumes: undefined };
}

/**
 * Raised masses the scan shows where no Google footprint is (`raisedM` over the measured ground, not water), each a
 * structure of its own: the mask opened by `unmappedCoreM` (the cells within it of a cell lying that far inside the mask),
 * so a band of facade past a footprint, however long, falls away, as does the band joining a real mass to its neighbours;
 * each 4-connected piece holding at least `unmappedMinAreaM2` of such inner cells, its outline traced from its cells
 * (cellsFootprint), the buildings it touches. Labelled photo-inferred: the outline is read from the scan, no
 * vector data says it is there.
 */
export function districtUnmappedStructures(input: { buildings: VectorBuilding[]; look: EvidenceLookup; ground: Pick<GroundModel, 'groundAt' | 'topAt'>; within: (x: number, z: number) => boolean }, P = DISTRICT_MASSING_PARAMS): UnmappedStructureOutline[] {
    const g = input.look.grid, nx = g.nx, nz = g.nz, cell = g.cellMeters, raster = input.look.raster.building;
    const raised = (c: number) => {
        if (raster[c] > 0) return false;
        const x = g.x0 + ((c % nx) + 0.5) * cell, z = g.z0 + (((c / nx) | 0) + 0.5) * cell;
        if (!input.within(x, z) || input.look.waterAt(x, z)) return false;
        const t = input.ground.topAt(x, z), gy = input.ground.groundAt(x, z);
        return Number.isFinite(t) && Number.isFinite(gy) && t - gy > P.raisedM;
    };
    const mask = new Uint8Array(nx * nz);
    for (let c = 0; c < nx * nz; c++) mask[c] = raised(c) ? 1 : 0;
    // metres from each raised cell to the nearest cell that is not one, along the axes or diagonals (chessboard): a band
    // w wide is at most w / 2 inside everywhere
    const depth = chessboardDistance(mask, nx, nz, cell);
    // the opening: what lies within unmappedCoreM of the inner cells
    const notCore = new Uint8Array(nx * nz);
    for (let c = 0; c < nx * nz; c++) notCore[c] = depth[c] >= P.unmappedCoreM ? 0 : 1;
    const toCore = chessboardDistance(notCore, nx, nz, cell);
    for (let c = 0; c < nx * nz; c++) if (mask[c] && toCore[c] > P.unmappedCoreM) mask[c] = 0;
    const seen = new Uint8Array(nx * nz);
    const out: UnmappedStructureOutline[] = [];
    for (let s = 0; s < nx * nz; s++) {
        if (seen[s] || !mask[s]) continue;
        seen[s] = 1;
        const stack = [s], comp: number[] = [], touches = new Set<number>();
        let clear = 0, h = 0;
        while (stack.length) {
            const c = stack.pop()!;
            comp.push(c);
            if (depth[c] >= P.unmappedCoreM) clear++;
            const i = c % nx, k = (c / nx) | 0;
            const x = g.x0 + (i + 0.5) * cell, z = g.z0 + (k + 0.5) * cell;
            h = Math.max(h, input.ground.topAt(x, z) - input.ground.groundAt(x, z));
            for (const [ii, kk] of [[i + 1, k], [i - 1, k], [i, k + 1], [i, k - 1]]) {
                if (ii < 0 || kk < 0 || ii >= nx || kk >= nz) continue;
                const q = kk * nx + ii;
                if (raster[q] > 0) touches.add(raster[q] - 1);
                else if (!seen[q] && mask[q]) { seen[q] = 1; stack.push(q); }
            }
        }
        if (clear * cell * cell < P.unmappedMinAreaM2) continue;
        const cells = new Set<string>();
        let sx = 0, sz = 0;
        for (const c of comp) {
            const x = g.x0 + ((c % nx) + 0.5) * cell, z = g.z0 + (((c / nx) | 0) + 0.5) * cell;
            cells.add(`${Math.floor(x)},${Math.floor(z)}`);
            sx += x; sz += z;
        }
        const outline = cellsFootprint(cells);
        if (!outline) continue;
        out.push({
            id: `unmapped/${out.length}`, label: 'photo-inferred', areaM2: r2(comp.length * cell * cell), heightM: r2(h), centroid: [r2(sx / comp.length), r2(sz / comp.length)], outline,
            touches: [...touches].sort((a, b) => a - b).map(b => input.buildings[b]?.id ?? String(b)), cells
        });
    }
    return out.sort((a, b) => b.areaM2 - a.areaM2).map((u, i) => ({ ...u, id: `unmapped/${i}` }));
}

/** Chessboard distance (m) from each cell of `mask` to the nearest cell outside it (0 outside; past the grid is outside). */
function chessboardDistance(mask: Uint8Array, nx: number, nz: number, cell: number): Float32Array {
    const d = new Float32Array(nx * nz);
    for (let c = 0; c < nx * nz; c++) d[c] = mask[c] ? Infinity : 0;
    const relax = (c: number, ii: number, kk: number) => { const v = ii < 0 || kk < 0 || ii >= nx || kk >= nz ? 0 : d[kk * nx + ii]; if (v + cell < d[c]) d[c] = v + cell; };
    for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) { const c = k * nx + i; if (!mask[c]) continue; relax(c, i - 1, k); relax(c, i - 1, k - 1); relax(c, i, k - 1); relax(c, i + 1, k - 1); }
    for (let k = nz - 1; k >= 0; k--) for (let i = nx - 1; i >= 0; i--) { const c = k * nx + i; if (!mask[c]) continue; relax(c, i + 1, k); relax(c, i + 1, k + 1); relax(c, i, k + 1); relax(c, i - 1, k + 1); }
    return d;
}

export function massDistrictBuilding(b: VectorBuilding, index: number, fp: { cells: Array<[number, number]>; outside: number; outsideCells?: Array<[number, number]> }, look: EvidenceLookup, ground: Pick<GroundModel, 'groundAt' | 'topAt'>, P = DISTRICT_MASSING_PARAMS, opts: { lenient?: boolean; walls?: WallSampleIndex; /** Cells of unmapped structures of their own (districtUnmappedStructures): never this building's overhang. */ unmapped?: ReadonlySet<string> } = {}): DistrictBuildingMassing {
    const t0 = Date.now();
    // a building the scan holds only part of: the straight cut that keeps the most of what it holds (applied below, once
    // the checks that read the scanned part have passed)
    const clip = fp.outside > 0 && fp.outsideCells?.length ? clipToScanned({ cells: fp.cells, outsideCells: fp.outsideCells }) : undefined;
    const keptCells = clip ? fp.cells.filter(([x, z]) => clipKeepsCell(clip, x, z)) : fp.cells;
    const base = { id: b.id, index, footprintCells: fp.cells.length };
    const gs = fp.cells.map(([x, z]) => ground.groundAt(x + 0.5, z + 0.5)).filter(Number.isFinite).sort((p, q) => p - q);
    if (!gs.length) return { ...base, groundY: NaN, raisedShare: 0, overhangShare: 0, ok: false, reason: 'no ground was measured under the footprint', ms: Date.now() - t0 };
    const groundY = gs[gs.length >> 1];
    const raisedAt = (x: number, z: number) => { const t = ground.topAt(x + 0.5, z + 0.5); return Number.isFinite(t) && t - groundY > P.raisedM; };
    const inFoot = new Set(fp.cells.map(([x, z]) => `${x},${z}`));
    const raised = new Set<string>();
    for (const [x, z] of fp.cells) if (raisedAt(x, z)) raised.add(`${x},${z}`);
    const raisedShare = raised.size / Math.max(1, fp.cells.length);
    const ring = new Set<string>();
    let toUnmapped = 0;
    const R = Math.ceil(P.overhangRingM);
    for (const [x, z] of fp.cells) for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
        if (dx * dx + dz * dz > P.overhangRingM * P.overhangRingM + 0.5) continue;
        const k = `${x + dx},${z + dz}`;
        if (inFoot.has(k) || ring.has(k)) continue;
        if (look.buildingAt(x + dx + 0.5, z + dz + 0.5) > 0) continue;
        if (!raisedAt(x + dx, z + dz)) continue;
        // a structure of its own the vector data does not map stands there: not this footprint's overhang
        if (opts.unmapped?.has(k)) { toUnmapped++; continue; }
        ring.add(k);
    }
    const overhangShare = ring.size / Math.max(1, fp.cells.length);
    const common = { ...base, groundY: r2(groundY), raisedShare: r2(raisedShare), overhangShare: r2(overhangShare), ...(toUnmapped ? { unmappedShare: r2(toUnmapped / Math.max(1, fp.cells.length)) } : {}) };
    let reason: string | undefined;
    const caveats: string[] = [];
    // the scan showing street where the footprint is: real data leads, nothing is built there (lenient or not)
    if (raisedShare < P.minRaisedShare) reason = `only ${Math.round(raisedShare * 100)}% of the footprint stands ${P.raisedM} m over the street in the scan (at least ${Math.round(P.minRaisedShare * 100)}% needed): the vector data and the scan disagree that a building stands here`;
    if (reason) return { ...common, ok: false, reason, ms: Date.now() - t0 };
    const soft: string[] = [];
    if (overhangShare > P.maxOverhangShare) soft.push(`the scan stands raised over ${Math.round(overhangShare * 100)}% of the footprint's area just outside it, where no footprint is (at most ${Math.round(P.maxOverhangShare * 100)}%): the footprint is smaller than what was scanned`);
    // plane first: a soft failure is the rebuilt building's labelled caveat, never a reason to leave the scan's lumps standing
    const lenient = opts.lenient || !!opts.walls;
    // a building the scan holds only part of: rebuilt over the part a straight cut keeps when that is nearly all of it (any
    // part, lenient), the rest kept as scanned; nothing is ever drawn where the scan did not reach (lenient or not)
    let built = b;
    if (fp.outside > 0) {
        const share = clip?.keptShare ?? 0;
        const cut = clip && (lenient || share >= P.minScannedShare) ? clipBuilding(b, clip) : undefined;
        const why = `the footprint runs past the extraction (${fp.outside} of its cells outside): the scan holds ${Math.round((fp.cells.length / (fp.cells.length + fp.outside)) * 100)}% of it, and a straight cut where the scan ends keeps ${Math.round(share * 100)}% (at least ${Math.round(P.minScannedShare * 100)}% needed to rebuild the part it holds)`;
        if (!cut) return { ...common, ok: false, reason: why, ...(clip ? { clip } : {}), ms: Date.now() - t0 };
        built = cut;
        caveats.push(`rebuilt over the ${Math.round(share * 100)}% of its footprint the scan holds, cut straight where the scan ends; the rest (${fp.cells.length - keptCells.length + fp.outside} cells) is kept as scanned or was never scanned, and nothing is drawn there`);
    }
    if (soft.length && !lenient) return { ...common, ok: false, reason: soft[0], ...(clip && fp.outside > 0 ? { clip } : {}), ms: Date.now() - t0 };
    caveats.push(...soft);
    const massCells = clip && fp.outside > 0 ? new Set(keptCells.map(([x, z]) => `${x},${z}`).filter(k => raised.has(k))) : raised;
    const massing = buildMassing({ buildings: [built], groundY, scanTop: ground.topAt, cells: massCells });
    let planeFirst: DistrictBuildingMassing['planeFirst'];
    let rooftopSolids: MassingPart[] = [];
    if (opts.walls && massing.parts.length) {
        // enclosed voids first (their rings are then fitted like any wall), then the walls, then what stands on the roofs
        const cy = carveCourtyards(massing.parts, ground.topAt);
        const pf = planeFirstMassing(cy.parts, opts.walls, (part, x, z) => inLoops(x, z, part.loops), { idPrefix: `pf${index}_`, register: process.env.SCRATCHBOX_STAGED_PLANE_REGISTER !== '0' });
        const floors = cy.floors.map(f => ({ ...f.floor, loops: [pf.parts.find(p => p.id === f.host)!.loops[f.holeLoop]] }));
        const roofs = fitRooftopSolids(pf.parts, ground.topAt);
        massing.parts = [...pf.parts, ...floors];
        rooftopSolids = roofs.solids;
        // the overhang once the walls stand on the scanned facades: ring cells the moved walls now take in
        let after = 0;
        for (const k of ring) { const [x, z] = k.split(',').map(Number); if (!pf.parts.some(p => inLoops(x + 0.5, z + 0.5, p.loops))) after++; }
        const { parts: _parts, ...rest } = pf;
        planeFirst = { ...rest, overhangAfterShare: r2(after / Math.max(1, fp.cells.length)), voids: cy.voids, rooftops: roofs.records };
        if (overhangShare > P.maxOverhangShare) caveats.push(`with the walls on the planes the scan measures, ${Math.round(planeFirst.overhangAfterShare * 100)}% remains outside them`);
    }
    // pipeline E's roof check over the raised footprint (its plan check is the isolate's and does not apply here)
    const roof = checkMassing(massing.parts, massing.meshes, { groundY, scanTop: ground.topAt, cells: massCells });
    if (!roof.massingCells) reason = 'the vector data hold no extruded part or modelled volume for the building';
    // a roof off the scan is not a wall question: plane first leaves it a reason (a pitched or spired roof the flat massing
    // would erase is a measured distinctive feature); only the procedural district, where the scan is not shown, rebuilds it
    else if (roof.reason && !/plan agrees/.test(roof.reason)) { if (opts.lenient) caveats.push(roof.reason); else reason = roof.reason; }
    // the rooftop solids join after the roof check: they never make a roof the check refused pass
    if (rooftopSolids.length) massing.parts = [...massing.parts, ...rooftopSolids];
    return { ...common, massing, ok: !reason, ...(reason ? { reason } : {}), ...(clip && fp.outside > 0 ? { clip } : {}), ...(caveats.length ? { caveat: caveats.join('; ') } : {}), ...(planeFirst ? { planeFirst } : {}), ms: Date.now() - t0 };
}

/**
 * Every building of the district reaching the extraction, massed and checked. `unmapped` (districtUnmappedStructures,
 * computed here when not given): the raised masses no footprint holds that are structures of their own.
 */
export function massDistrict(input: { buildings: VectorBuilding[]; look: EvidenceLookup; ground: Pick<GroundModel, 'groundAt' | 'topAt'>; within: (x: number, z: number) => boolean; lenient?: boolean; /** Plane first: the scan's wall samples (wall-plane-fit.ts wallSampleIndex). */ walls?: WallSampleIndex; unmapped?: UnmappedStructureOutline[] }, P = DISTRICT_MASSING_PARAMS): DistrictBuildingMassing[] {
    const fps = footprintCellsByBuilding(input.look, input.within);
    const unmapped = unmappedCells(input.unmapped ?? districtUnmappedStructures(input, P));
    const out: DistrictBuildingMassing[] = [];
    for (const [b, fp] of [...fps].sort((p, q) => p[0] - q[0])) if (fp.cells.length) out.push(massDistrictBuilding(input.buildings[b], b, fp, input.look, input.ground, P, { lenient: input.lenient, unmapped, ...(input.walls ? { walls: input.walls } : {}) }));
    return out;
}

/** Every cell of the unmapped structures, one set. */
export function unmappedCells(us: ReadonlyArray<Pick<UnmappedStructureOutline, 'cells'>>): Set<string> {
    const s = new Set<string>();
    for (const u of us) for (const c of u.cells) s.add(c);
    return s;
}

/**
 * The plan cells the rebuilt buildings stand on, for cutting them out of the scan's layers: their footprints, grown by
 * `marginM` (the scan's facade stands a little outside a footprint) but never into another building's footprint, so a
 * neighbour left as scanned keeps its own walls whole. A building rebuilt over part of it (clip) gives only the cells its
 * cut keeps, so the rest of it keeps the scan; `keepOut` (the unmapped structures' cells) is never taken in by a margin.
 */
export function districtFootprint(rows: DistrictBuildingMassing[], look: EvidenceLookup, within: (x: number, z: number) => boolean, marginM = 1, keepOut?: ReadonlySet<string>): StructureFootprint {
    const fps = footprintCellsByBuilding(look, within);
    const cells = new Set<string>();
    const cellGroundY = new Map<string, number>();
    let baseY = Infinity, topY = -Infinity;
    const R = Math.ceil(marginM);
    for (const r of rows.filter(x => x.ok && x.massing)) {
        const clip = r.clip;
        const seeds = (fps.get(r.index)?.cells ?? []).filter(([x, z]) => !clip || clipKeepsCell(clip, x, z));
        // plane first: the walls stand on the scanned facades, which may lie outside the vector footprint; the cells the
        // moved walls take in are the building's too (the scan's facade there is what the plane replaces)
        if (r.planeFirst) {
            const own = new Set(seeds.map(([x, z]) => `${x},${z}`));
            for (const p of r.massing!.parts) {
                const xs = p.loops[0].map(q => q[0]), zs = p.loops[0].map(q => q[1]);
                for (let z = Math.floor(Math.min(...zs)); z <= Math.ceil(Math.max(...zs)); z++) for (let x = Math.floor(Math.min(...xs)); x <= Math.ceil(Math.max(...xs)); x++) {
                    if (own.has(`${x},${z}`) || !within(x + 0.5, z + 0.5) || !inLoops(x + 0.5, z + 0.5, p.loops)) continue;
                    own.add(`${x},${z}`);
                    seeds.push([x, z]);
                }
            }
        }
        for (const [x, z] of seeds) for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
            if (dx * dx + dz * dz > marginM * marginM + 0.5) continue;
            const b = look.buildingAt(x + dx + 0.5, z + dz + 0.5);
            if (b > 0 && b - 1 !== r.index) continue;
            // the part of a cut building left as scanned stays whole, as does a structure the vector data does not map
            if (clip && b - 1 === r.index && !clipKeepsCell(clip, x + dx, z + dz)) continue;
            const k = `${x + dx},${z + dz}`;
            if (keepOut?.has(k)) continue;
            cells.add(k);
            // each cell is cut at its own building's ground (a district's streets rise and fall)
            if (!cellGroundY.has(k) || b - 1 === r.index) cellGroundY.set(k, r.groundY);
        }
        baseY = Math.min(baseY, r.groundY);
        for (const p of r.massing!.parts) topY = Math.max(topY, p.topY);
    }
    return { cellM: 1, cells, baseY: Number.isFinite(baseY) ? baseY : 0, topY: Number.isFinite(topY) ? topY : 0, cellGroundY };
}

export interface DistrictMassingLayer {
    files: MassingLayerFiles;
    run: MassingRun;
    footprint: StructureFootprint;
    rebuilt: number;
    /** Residual triangles the native run returned off the rebuilt footprints, taken out (keepResidualOver). */
    residualOffFootprint: number;
    /** Plane first: the scan's lumps on fitted walls taken out of the residual, and the relief items the native tool did not take. */
    planeFirst?: { residualRemovedTriangles: number; residualRemovedAreaM2: number; residualKeptTriangles: number; rejectedRelief: string[]; debris: Record<string, { clusters: number; triangles: number; areaM2: number }> };
    timingsMs: Record<string, number>;
    /** What pipeline E's inference and relief take (district-e-detail.ts): the combined massing, its plain textures, the cropped scan. */
    massing: Massing;
    textures: Map<number, FaceTexture>;
    legend: TexelSource[];
    isolateGlb: string;
}

/**
 * The rebuilt buildings as one layer: their massings in one native run (walls snapped onto the scanned facades, the scan the
 * massing does not explain kept as residual and audited), textured from the tile photo, written beside `outDir`. `scanGlb` is
 * the tree-stripped scan; the native tool sees only its part over the rebuilt footprints.
 */
export async function buildDistrictMassingLayer(input: { rows: DistrictBuildingMassing[]; look: EvidenceLookup; within: (x: number, z: number) => boolean; scanGlb: string; outDir: string; stage: string; stageKey: string; signal?: AbortSignal; /** Cells no margin takes in (the unmapped structures'). */ keepOut?: ReadonlySet<string> }): Promise<DistrictMassingLayer | undefined> {
    const timingsMs: Record<string, number> = {};
    const ok = input.rows.filter(r => r.ok && r.massing);
    if (!ok.length) return undefined;
    let t = Date.now();
    fs.mkdirSync(input.outDir, { recursive: true });
    const footprint = districtFootprint(ok, input.look, input.within, 2, input.keepOut);
    // the native tool sees what stands on the footprints: nothing within the apron height of each building's own ground
    // (kerbs and street scanned at the footprint's edge would come back as residual lying on the street)
    for (const [k, y] of footprint.cellGroundY ?? []) footprint.cellGroundY!.set(k, y + APRON_HEIGHT_M - FOOTPRINT_GROUND_CLEARANCE_M);
    const isolate = path.join(input.outDir, 'scan_over_footprints.glb');
    fs.writeFileSync(isolate, hideFootprintInGlb(fs.readFileSync(input.scanGlb), footprint, { keep: 'inside' }).glb);
    timingsMs.crop = Date.now() - t;
    const parts = ok.flatMap(r => r.massing!.parts), meshes = ok.flatMap(r => r.massing!.meshes);
    const check = { iou: Math.round(100 * median(ok.map(r => r.raisedShare))) / 100, heightErrMedianM: median(ok.map(r => r.massing!.check.heightErrMedianM)), heightErrP90M: median(ok.map(r => r.massing!.check.heightErrP90M)), massingCells: 0, scanCells: 0, ok: true };
    t = Date.now();
    const pf = ok.filter(r => r.planeFirst);
    const walls = pf.flatMap(r => r.planeFirst!.walls);
    // plane first: the walls already stand on their fitted planes (no native snap), and the scan's cut clusters do not open
    // them (a real recess is the fit's relief, not a hole the lumpy scan fills)
    const pfParams: Record<string, number> = pf.length ? { snapWalls: 0, residualOpen: 1e9, clipOpenings: 1 } : {};
    const run = await runNativeMassing({ parts, meshes }, {
        tilePath: input.scanGlb, isolateGlb: isolate, dir: path.join(input.outDir, 'native'), groundY: footprint.baseY, params: { pixel: DISTRICT_TEXEL_M, ...pfParams },
        ...(pf.length ? { openings: pf.flatMap(r => r.planeFirst!.openings), faceSweeps: pf.flatMap(r => r.planeFirst!.faceSweeps) } : {}),
        ...(input.signal ? { signal: input.signal } : {})
    });
    timingsMs.native = Date.now() - t;
    const offFootprint = keepResidualOver(run, footprint.cells);
    let planeFirst: DistrictMassingLayer['planeFirst'];
    if (pf.length) {
        const dropped = dropWallBandResidual(run.nodes, walls);
        run.nodes = dropped.nodes;
        // roof debris: splinters and the scan's noise on the rebuilt roofs
        const debris = dropResidualClusters(run.nodes, roofDebrisDecider(ok.flatMap(r => r.massing!.parts)));
        run.nodes = debris.nodes;
        const reliefIds = new Set(walls.flatMap(w => w.reliefIds));
        // a relief item the native tool clipped to a split wall's pieces is built when any piece of it is
        const built = new Set(run.nodes.filter(n => /^(opening|facesweep):/.test(n.name)).map(n => reliefBaseId(n.name.replace(/^(opening|facesweep):/, ''))));
        planeFirst = { residualRemovedTriangles: dropped.removedTriangles, residualRemovedAreaM2: dropped.removedAreaM2, residualKeptTriangles: debris.keptTriangles, debris: debris.byReason, rejectedRelief: [...new Set([...run.report.rejectedOpenings, ...run.report.rejectedSweeps].map(reliefBaseId).filter(id => reliefIds.has(id) && !built.has(id)))] };
    }
    t = Date.now();
    const { textures, legend } = plainTextures(run);
    timingsMs.textures = Date.now() - t;
    t = Date.now();
    const provenanceOf = pf.length ? planeFirstProvenance(ok, { check }) : undefined;
    const files = writeMassingLayer(run, { check }, textures, legend, input.outDir, input.stage, input.stageKey, 'district_massing', provenanceOf, { photoJpeg: true });
    timingsMs.glb = Date.now() - t;
    const massing: Massing = { parts, meshes, check, solar: { segments: 0, inside: 0, pitchedKept: 0, pitchedRejected: 0, flatUsed: 0 }, notes: [`${ok.length} buildings massed together`] };
    return { files, run, footprint: districtFootprint(ok, input.look, input.within, 1, input.keepOut), rebuilt: ok.length, residualOffFootprint: offFootprint, timingsMs, ...(planeFirst ? { planeFirst } : {}), massing, textures, legend, isolateGlb: isolate };
}

/**
 * The run's scanned residual, kept only where it stands over the rebuilt footprints: the layer carries the buildings and what
 * stands on them, never the street or the water around them (Federation Square: 451 river-level triangles, some 15 m
 * across, reached the residual although the scan handed to the native tool held none over the water). Returns the count
 * taken out.
 */
export function keepResidualOver(run: MassingRun, cells: ReadonlySet<string>): number {
    let removed = 0;
    run.nodes = run.nodes.flatMap(n => {
        if (n.kind !== 'residual') return [n];
        const keep: number[] = [];
        for (let t = 0; t < n.indices.length / 3; t++) {
            const v = [n.indices[t * 3], n.indices[t * 3 + 1], n.indices[t * 3 + 2]];
            if (v.every(i => cells.has(`${Math.floor(n.positions[i * 3])},${Math.floor(n.positions[i * 3 + 2])}`))) keep.push(t); else removed++;
        }
        if (keep.length === n.indices.length / 3) return [n];
        if (!keep.length) return [];
        const remap = new Map<number, number>(), idx: number[] = [];
        for (const t of keep) for (let k = 0; k < 3; k++) { const v = n.indices[t * 3 + k]; if (!remap.has(v)) remap.set(v, remap.size); idx.push(remap.get(v)!); }
        const order = [...remap.keys()];
        const pick = <A extends Float32Array | Int32Array>(a: A, w: number): A => { const r = new (a.constructor as { new (n: number): A })(order.length * w); order.forEach((v, i) => r.set(a.subarray(v * w, v * w + w), i * w)); return r; };
        return [{ ...n, positions: pick(n.positions, 3), normals: pick(n.normals, 3), ref: pick(n.ref, 1), st: pick(n.st, 2), indices: Uint32Array.from(idx) }];
    });
    return removed;
}

function median(a: number[]): number {
    const s = a.filter(Number.isFinite).sort((x, y) => x - y);
    return s.length ? s[s.length >> 1] : NaN;
}

/**
 * Each node of a plane-first district's layer labelled honestly: a wall the scan measured a clean plane for (its offset,
 * coverage, inliers and RMS in the record), one placed at the median of a lumpy scan (generated: an estimate), one the scan
 * hardly sees (the vector edge as given); relief the fit found (measured); a building rebuilt despite a failed check
 * carries that caveat and a lower confidence.
 */
/** A relief item's id without the piece suffixes the native tool adds when it clips one to a split wall's pieces (<id>:<k>). */
const reliefBaseId = (id: string) => id.replace(/(:\d+)+$/, '');

export function planeFirstProvenance(rows: DistrictBuildingMassing[], massing: Parameters<typeof massingProvenance>[1]): (n: MassingNode) => ProvenanceRecord | undefined {
    const byKey = new Map<string, { wall: PlaneFirstWall; row: DistrictBuildingMassing }>();
    const byRelief = new Map<string, { wall: PlaneFirstWall; row: DistrictBuildingMassing }>();
    for (const row of rows) for (const wall of row.planeFirst?.walls ?? []) {
        byKey.set(wall.key, { wall, row });
        for (const id of wall.reliefIds) byRelief.set(id, { wall, row });
    }
    const sources = [{ kind: 'vector-data', id: 'google-vectortiles' }, { kind: 'tile-extraction', id: 'isolate' }];
    const caveatOf = (row: DistrictBuildingMassing) => (row.caveat ? `; rebuilt despite a failed check: ${row.caveat}` : '');
    const conf = (row: DistrictBuildingMassing, c: number) => r2(Math.max(0.05, Math.min(1, row.caveat ? c * 0.6 : c)));
    const rooftopOf = new Map<string, { rec: RooftopRecord; row: DistrictBuildingMassing }>();
    const voidOf = new Map<string, { rec: VoidRecord; row: DistrictBuildingMassing }>();
    for (const row of rows) {
        for (const rec of row.planeFirst?.rooftops ?? []) rooftopOf.set(rec.solid, { rec, row });
        for (const rec of row.planeFirst?.voids ?? []) if (rec.floorPart) voidOf.set(rec.floorPart, { rec, row });
    }
    // a node's part, from its face key (w:<part>:<loop>:<edge>[:k], r:<part>:<i>, b:<part>)
    const partOf = (name: string) => name.replace(/^[wrb]:/, '').replace(/(:\d+)+$/, '');
    return (n: MassingNode) => {
        if (n.provenance === ROOFTOP_SOLID_TOKEN) {
            const hit = rooftopOf.get(partOf(n.name));
            return {
                label: 'generated', measuredGeometry: false, confidence: hit ? conf(hit.row, Math.max(0.2, Math.min(0.8, hit.rec.fill - 0.1))) : 0.4,
                method: `${ROOF_AND_VOIDS_VERSION}: a region of the scan standing over the rebuilt roof, rebuilt as the simplest prism that fills it (a rectangle in the building's or the region's frame, or a regular polygon) from the roof to the height the scan measures there (the median of its upper half)`,
                sources, ...(hit ? { note: `${hit.rec.shape}, ${hit.rec.areaM2} m2, ${hit.rec.heightM} m tall; fills ${Math.round(hit.rec.fill * 100)}% of the scanned region's plan; the scan's top about the prism's ${hit.rec.topRmsM} m RMS${caveatOf(hit.row)}` } : {})
            };
        }
        if (n.provenance === COURTYARD_FLOOR_TOKEN) {
            const hit = voidOf.get(partOf(n.name));
            return {
                label: 'measured', measuredGeometry: true, confidence: hit ? conf(hit.row, 0.6) : 0.5,
                method: `${ROOF_AND_VOIDS_VERSION}: the floor of an enclosed void (courtyard, light well) the scan shows far under the roof, at the median height the scan measures there; the void's ring fitted like any wall`,
                sources, ...(hit ? { note: `void of ${hit.rec.areaM2} m2 (${hit.rec.shape}, fills ${Math.round(hit.rec.fill * 100)}%), ${hit.rec.depthM} m deep${caveatOf(hit.row)}` } : {})
            };
        }
        if (n.provenance === PLANE_RELIEF_TOKEN) {
            const id = reliefBaseId(n.name.replace(/^(opening|facesweep):/, ''));
            const hit = byRelief.get(id);
            if (!hit) return undefined;
            const q = hit.wall.fit.relief[hit.wall.reliefIndex[hit.wall.reliefIds.indexOf(id)]];
            return {
                label: 'measured', measuredGeometry: true, confidence: conf(hit.row, n.confidence ?? 0.7),
                method: `${WALL_PLANE_FIT_VERSION}: a ${n.kind === 'opening' ? 'recess' : 'projection'} where the scan departs from the wall's fitted plane consistently over a real area (smoothed residual, connected, filling its box, one depth)`,
                sources, note: q ? `${Math.abs(q.depthM)} m ${q.depthM < 0 ? 'deep' : 'proud'} over ${q.areaM2} m2 (fills ${Math.round(q.fill * 100)}% of its box, depth spread ${q.spreadM} m)${caveatOf(hit.row)}` : caveatOf(hit.row).slice(2)
            };
        }
        if (n.kind !== 'wall') return undefined;
        const key = n.name.replace(/:\d+$/, '');
        const hit = byKey.get(n.name) ?? byKey.get(key);
        if (!hit) return undefined;
        const f = hit.wall.fit;
        const residual = Number.isFinite(f.rmsWithReliefM) ? { residual: { rmsM: f.rmsWithReliefM, p50M: f.rmsM, p95M: f.p90M, maxM: NaN, samples: f.seenCells, areaM2: r2(f.lengthM * (hit.wall.topY - hit.wall.baseY)), inlierFraction: f.inlierShare, supportFraction: f.coverage } } : {};
        const fitNote = `offset ${f.offsetM} m from the footprint edge${f.yawDeg ? `, turned ${f.yawDeg} deg` : ''}; the scan sees ${Math.round(f.coverage * 100)}% of the wall, ${Math.round(f.inlierShare * 100)}% within 0.2 m of the plane; its lumps about the plane ${f.rmsM} m RMS (snapped flat); measured lean ${f.plumbDeg} deg (kept plumb)`;
        if (f.status === 'measured') return { label: 'vector-modelled', measuredGeometry: true, confidence: conf(hit.row, 0.5 + 0.5 * f.inlierShare), method: `${WALL_PLANE_FIT_VERSION}: one plumb plane on the Google footprint edge at the depth the scan measures (robust mode, least squares on its inliers); the scan's bumpiness about it is noise, never geometry`, sources, ...residual, note: `${fitNote}${caveatOf(hit.row)}` };
        if (f.status === 'step') return { label: 'vector-modelled', measuredGeometry: true, confidence: conf(hit.row, 0.6), method: `${WALL_PLANE_FIT_VERSION}: the return wall joining two runs of one footprint edge, each fitted as its own plane where the scan steps along the edge (a setback over most of the wall's height)`, sources, note: `${f.reason ?? ''}${caveatOf(hit.row)}` };
        if (f.status === 'estimated') return { label: 'generated', measuredGeometry: false, confidence: conf(hit.row, 0.35), method: `${WALL_PLANE_FIT_VERSION}: one plumb plane on the Google footprint edge, at the median depth of a scan with no clean plane (an estimate, labelled)`, sources, ...residual, note: `${f.reason ?? ''}; ${fitNote}${caveatOf(hit.row)}` };
        const base = massingProvenance(n, massing);
        return { ...base, label: 'vector-modelled', measuredGeometry: false, confidence: conf(hit.row, 0.5), note: `${f.reason ?? 'the scan does not see this wall'}${/moved .* with its neighbouring walls/.test(f.reason ?? '') ? '' : ': the Google footprint edge as given'}${caveatOf(hit.row)}` };
    };
}
