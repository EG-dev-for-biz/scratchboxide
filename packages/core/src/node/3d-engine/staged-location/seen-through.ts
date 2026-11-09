/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Seen-through removal: what the scan baked into the street (a parked truck, a sidewalk shed, a construction fence) that
 * the registered Street View photos look straight through, taken out of the scan.
 *
 * The photos measure where the street is clear: a point two registered photos both see (a tie, triangulated: the drive
 * registration's SeenPoint) lies at the end of a clear line of sight from each camera. A scan surface standing on that line,
 * short of the point, is not there any more. This is how streetview-to-3d drops Google's points "standing in front of what
 * a pano saw" (its merged_world.py), rewritten for a mesh as the vehicle removal's decision (user decision, 2026-11-09):
 *
 *  - the candidates are the vehicle removal's own (vehicleCandidates: scan cells standing proud of the measured street,
 *    clear of the vector buildings, at most proudMaxM high);
 *  - a candidate cell is seen through when a line of sight passes under its top and over the street, at least
 *    `beyondM` short of the seen point; it counts the lines and the panoramas they come from;
 *  - the judge (seenThroughJudge, in place of the vision model) boxes each cluster of cells seen through from at least
 *    `minPanos` panoramas by at least `minRays` lines; the vehicle removal then patches them as it patches vehicles (the
 *    street under rebuilt from the measured ring around, an awning over open space left standing, texels from the street).
 *
 * No noun list decides anything and no model is asked: the photos' geometry does.
 */

import type { GroundModel, ScanMesh } from '../../spatial/StreetViewSurveyPlanner';
import { buildGroundModel, loadScanMesh } from '../../spatial/StreetViewSurveyPlanner';
import type { SeenPoint } from './pano-drive-registration';
import { evidenceLookup, fetchVectorEvidence } from './vector-footprints';
import { GoogleVectorTileService } from '../../spatial/GoogleVectorTileService';
import {
    removeVehicles, vehicleCandidates, VEHICLE_REMOVAL_PARAMS,
    type ProudGrid, type RemoveVehiclesResult, type VehicleJudge, type VehicleLookups, type VehicleReading, type VehicleRemovalParams
} from './vehicle-removal';

export interface SeenThroughOptions {
    /** A line of sight counts against a cell only this far (m) or more short of the point it sees. */
    beyondM: number;
    /** ... and only where it passes this far (m) under the cell's top and over the street. */
    underTopM: number;
    overStreetM: number;
    /** Step along each line (m). */
    stepM: number;
    /** A cluster is removed when lines from this many panoramas, and this many lines, pass through it. */
    minPanos: number;
    minRays: number;
    /**
     * A cluster is boxed in tiles of at most this size (m), each tight round its own seen-through cells: the removal takes
     * every candidate cell inside a box, and one box round a long cluster at an angle to the grid takes far more than the
     * photos saw through.
     */
    boxM: number;
}

/** The tallest thing the seen-through removal takes (m above the street). */
export const SEEN_THROUGH_MAX_HEIGHT_M = 8;

export const SEEN_THROUGH_DEFAULTS: SeenThroughOptions = { beyondM: 1.5, underTopM: 0.15, overStreetM: 0.3, stepM: 0.1, minPanos: 2, minRays: 3, boxM: 4 };

export interface SeenThroughEvidence {
    grid: ProudGrid;
    /** Lines of sight through each cell. */
    rays: Uint16Array;
    /** Panoramas whose lines pass through each cell (sets, by cell). */
    panos: Map<number, Set<string>>;
    /** Lines tested, and lines that passed through at least one candidate cell. */
    lines: number;
    blocked: number;
}

/** Which candidate cells the photos' lines of sight pass through, and from how many panoramas. */
export function seenThroughEvidence(grid: ProudGrid, ground: GroundModel, points: SeenPoint[], opts: Partial<SeenThroughOptions> = {}): SeenThroughEvidence {
    const o = { ...SEEN_THROUGH_DEFAULTS, ...opts };
    const { x0, z0, nx, nz, cellM, rel, comp } = grid;
    const rays = new Uint16Array(nx * nz);
    const panos = new Map<number, Set<string>>();
    let lines = 0, blocked = 0;
    for (const p of points) for (let e = 0; e < 2; e++) {
        const eye = p.eyes[e], X = p.X;
        const d = [X[0] - eye[0], X[1] - eye[1], X[2] - eye[2]];
        const len = Math.hypot(d[0], d[1], d[2]);
        if (len <= o.beyondM) continue;
        lines++;
        const end = len - o.beyondM;
        let last = -1, hit = false;
        for (let s = 0.5; s <= end; s += o.stepM) {
            const x = eye[0] + d[0] * s / len, y = eye[1] + d[1] * s / len, z = eye[2] + d[2] * s / len;
            const i = Math.floor((x - x0) / cellM), k = Math.floor((z - z0) / cellM);
            if (i < 0 || k < 0 || i >= nx || k >= nz) continue;
            const c = k * nx + i;
            if (c === last || comp[c] < 0) continue;
            const g = ground.groundAt(x0 + (i + 0.5) * cellM, z0 + (k + 0.5) * cellM);
            if (g !== g || rel[c] !== rel[c]) continue;
            if (y < g + rel[c] - o.underTopM && y > g + o.overStreetM) {
                last = c; hit = true;
                if (rays[c] < 65535) rays[c]++;
                let set = panos.get(c); if (!set) panos.set(c, set = new Set()); set.add(p.panos[e]);
            }
        }
        if (hit) blocked++;
    }
    return { grid, rays, panos, lines, blocked };
}

/** Clusters (4-connected) of cells seen through enough, inside a plan rectangle: their bounds and support. */
export function seenThroughClusters(ev: SeenThroughEvidence, frame: { x0: number; z0: number; widthM: number; heightM: number }, opts: Partial<SeenThroughOptions> = {}): Array<{ lo: [number, number]; hi: [number, number]; rays: number; panos: number; cells: number }> {
    const o = { ...SEEN_THROUGH_DEFAULTS, ...opts };
    const { x0, z0, nx, nz, cellM } = ev.grid;
    // a cell joins when it carries any line; a cluster is kept on its total support
    const i0 = Math.max(0, Math.floor((frame.x0 - x0) / cellM)), i1 = Math.min(nx - 1, Math.floor((frame.x0 + frame.widthM - x0) / cellM));
    const k0 = Math.max(0, Math.floor((frame.z0 - z0) / cellM)), k1 = Math.min(nz - 1, Math.floor((frame.z0 + frame.heightM - z0) / cellM));
    const seen = new Uint8Array(nx * nz);
    const out: Array<{ lo: [number, number]; hi: [number, number]; rays: number; panos: number; cells: number }> = [];
    for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) {
        const c0 = k * nx + i;
        if (seen[c0] || !ev.rays[c0]) continue;
        const stack = [c0]; seen[c0] = 1;
        let rays = 0, cells = 0;
        const members: number[] = [];
        const ps = new Set<string>();
        while (stack.length) {
            const c = stack.pop()!;
            const ci = c % nx, ck = (c - ci) / nx;
            rays += ev.rays[c]; cells++; members.push(c);
            for (const p of ev.panos.get(c) ?? []) ps.add(p);
            for (const [di, dk] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const ii = ci + di, kk = ck + dk;
                if (ii < i0 || kk < k0 || ii > i1 || kk > k1) continue;
                const n = kk * nx + ii;
                if (seen[n] || !ev.rays[n]) continue;
                seen[n] = 1; stack.push(n);
            }
        }
        if (ps.size < o.minPanos || rays < o.minRays) continue;
        // the cluster's decision, its boxes per tile, each tight round the tile's own cells
        const per = Math.max(1, Math.round(o.boxM / cellM));
        const tiles = new Map<string, number[]>();
        for (const c of members) { const ci = c % nx, ck = (c - ci) / nx; const key = `${Math.floor(ci / per)},${Math.floor(ck / per)}`; let a = tiles.get(key); if (!a) tiles.set(key, a = []); a.push(c); }
        for (const cs of tiles.values()) {
            let li = Infinity, hi = -Infinity, lk = Infinity, hk = -Infinity, r = 0;
            for (const c of cs) { const ci = c % nx, ck = (c - ci) / nx; li = Math.min(li, ci); hi = Math.max(hi, ci); lk = Math.min(lk, ck); hk = Math.max(hk, ck); r += ev.rays[c]; }
            out.push({ lo: [x0 + li * cellM, z0 + lk * cellM], hi: [x0 + (hi + 1) * cellM, z0 + (hk + 1) * cellM], rays: r, panos: ps.size, cells: cs.length });
        }
    }
    return out;
}

/**
 * The vehicle removal's judge from the photos' evidence instead of a vision model: per crop, a reading for each cluster the
 * photos see through, not permanent (the photos show the street clear there), its confidence growing with the panoramas.
 */
export function seenThroughJudge(ev: SeenThroughEvidence, opts: Partial<SeenThroughOptions> = {}): VehicleJudge {
    return async crop => seenThroughClusters(ev, crop.frame, opts).map((c): VehicleReading => ({
        label: `seen through by ${c.rays} lines of sight from ${c.panos} registered Street View panoramas`,
        vehicle: false, permanent: false,
        confidence: Math.min(1, 0.5 + 0.1 * c.panos),
        lo: c.lo, hi: c.hi, crop: crop.index
    }));
}

export interface RemoveSeenThroughInput {
    /** The photo-textured tiles (the fill paints the street under from them) and, optionally, their geometry twin. */
    texturedGlb: string;
    geometryGlb?: string;
    points: SeenPoint[];
    outDir: string;
    look?: VehicleLookups;
    options?: Partial<SeenThroughOptions>;
    P?: VehicleRemovalParams;
    signal?: AbortSignal;
    log?: (m: string) => void;
    scan?: ScanMesh;
}

export interface RemoveSeenThroughResult extends RemoveVehiclesResult {
    evidence: { points: number; lines: number; linesThroughCandidates: number; candidateCells: number; cellsSeenThrough: number };
}


/** Takes out of the tiles what the registered photos see through (the vehicle removal, judged by the photos). */
export async function removeSeenThrough(input: RemoveSeenThroughInput): Promise<RemoveSeenThroughResult> {
    const P = input.P ?? VEHICLE_REMOVAL_PARAMS;
    const scan = input.scan ?? loadScanMesh(input.texturedGlb);
    const ground = buildGroundModel(scan, { cellMeters: 1, ...(input.look?.waterAt ? { water: input.look.waterAt } : {}), ...(input.look?.roadAt ? { road: input.look.roadAt } : {}) });
    // what the photos see through can stand taller than a vehicle (a sidewalk shed, a construction fence with its gantry):
    // up to SEEN_THROUGH_MAX_HEIGHT_M, the photos decide and the vector buildings stay clear
    const Pseen: VehicleRemovalParams = { ...P, debrisMinAreaM2: Infinity, keepOverOpenSpace: false, proudMaxM: Math.max(P.proudMaxM, SEEN_THROUGH_MAX_HEIGHT_M) };
    const { grid } = vehicleCandidates(scan, ground, input.look ?? {}, Pseen);
    const ev = seenThroughEvidence(grid, ground, input.points, input.options);
    let candidateCells = 0, cellsSeenThrough = 0;
    for (let c = 0; c < grid.comp.length; c++) { if (grid.comp[c] >= 0) candidateCells++; if (ev.rays[c]) cellsSeenThrough++; }
    input.log?.(`seen-through: ${input.points.length} points two photos see, ${ev.lines} lines of sight, ${ev.blocked} through ${cellsSeenThrough} of ${candidateCells} candidate cells`);
    const judge = seenThroughJudge(ev, input.options);
    // only what the photos see through goes: the carriageway debris the vehicle removal patches without a reading stays
    const out = await removeVehicles({
        texturedGlb: input.texturedGlb, ...(input.geometryGlb ? { geometryGlb: input.geometryGlb } : {}), scan, ground, judge,
        outDir: input.outDir, P: Pseen, ...(input.look ? { look: input.look } : {}),
        ...(input.signal ? { signal: input.signal } : {}), ...(input.log ? { log: input.log } : {})
    });
    return { ...out, evidence: { points: input.points.length, lines: ev.lines, linesThroughCandidates: ev.blocked, candidateCells, cellsSeenThrough } };
}

/**
 * The Google vector map's buildings, water and roads around an anchor, in the scan frame, as the removal's lookups: a
 * candidate stands clear of every vector building (the vehicle removal's buildingClearM), so the walls and the ground floors
 * of the buildings the photos see behind a removed shed keep their scan. Rejects when the tiles cannot be read.
 */
export async function vectorLookups(anchor: { lat: number; lng: number }, radiusM: number): Promise<VehicleLookups> {
    const ev = await fetchVectorEvidence({ lat: anchor.lat, lng: anchor.lng, radiusM: radiusM + 20, fetchTile: (x, y, z) => GoogleVectorTileService.fetchVectorTile(x, y, z, '') });
    const look = evidenceLookup(ev, radiusM + 20);
    return { buildingAt: look.buildingAt, waterAt: look.waterAt, roadAt: look.roadAt, within: (x, z) => Math.hypot(x, z) <= radiusM };
}
