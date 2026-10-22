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
 *     small for what was scanned);
 *   - roof: pipeline E's own roof error against the scan, over the footprint's raised cells;
 *   - whole: the footprint lies inside the extraction (a building the scan only partly covers is never rebuilt from part).
 * A building that fails keeps the scan, with the reason.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { GroundModel } from '../../spatial/StreetViewSurveyPlanner';
import type { EvidenceLookup, VectorBuilding } from './vector-footprints';
import { buildMassing, checkMassing, type Massing } from './pipeline-e/massing-spec';
import { plainTextures, runNativeMassing, writeMassingLayer, type MassingLayerFiles } from './pipeline-e/pipeline-e';
import type { MassingRun } from './pipeline-e/native-massing';
import { FOOTPRINT_GROUND_CLEARANCE_M, hideFootprintInGlb, type StructureFootprint } from './kept-structure';
import { APRON_HEIGHT_M } from './pipeline-e/residual-audit-e';

export const DISTRICT_MASSING_VERSION = 'district-massing/1';

/** The district massing stage runs when SCRATCHBOX_STAGED_DISTRICT_MASSING=1, or with the procedural district (off until measured live). */
export function districtMassingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.SCRATCHBOX_STAGED_DISTRICT_MASSING === '1' || proceduralDistrictEnabled(env);
}

/**
 * SCRATCHBOX_STAGED_PROCEDURAL=1: the district is shown rebuilt, not scanned: every building the scan confirms rebuilt
 * (lenient), the ground a measured surface, the streets SB-Roadie's carriageways and kerbs; the scan stays as the reference
 * the rebuilt layers supersede (user direction, 2026-10-22: the tiles as a visual reference, the scene recreated).
 */
export function proceduralDistrictEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.SCRATCHBOX_STAGED_PROCEDURAL === '1';
}

/**
 * The face texel of a district's rebuilt buildings, metres: pipeline E's 5 cm suits one hero structure; 53 Federation
 * Square buildings at 5 cm wrote 151 MB of texture. The leaf tiles' own photo is coarser than this.
 */
export const DISTRICT_TEXEL_M = 0.15;

export const DISTRICT_MASSING_PARAMS = {
    /** A cell is raised when the scan stands this far over the measured ground there. */
    raisedM: 2.5,
    /** At least this share of the footprint raised. */
    minRaisedShare: 0.6,
    /** Raised cells in a ring this wide outside the footprint, in no other footprint, at most this share of the footprint. */
    overhangRingM: 1.5,
    maxOverhangShare: 0.35
};

export interface DistrictBuildingMassing {
    id: string;
    /** Index into the vector evidence's buildings. */
    index: number;
    groundY: number;
    footprintCells: number;
    raisedShare: number;
    overhangShare: number;
    massing?: Massing;
    ok: boolean;
    reason?: string;
    /**
     * Lenient (a procedural district, where the scan is not shown and a building left out would be missing): a check the
     * building failed but was rebuilt anyway, from its footprint and what the scan does measure. Its confidence is lower.
     */
    caveat?: string;
    ms: number;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/** Each building's footprint cells inside the extraction, and whether any part of it lies outside. */
export function footprintCellsByBuilding(look: EvidenceLookup, within: (x: number, z: number) => boolean): Map<number, { cells: Array<[number, number]>; outside: number }> {
    const g = look.grid, raster = look.raster.building;
    const out = new Map<number, { cells: Array<[number, number]>; outside: number }>();
    for (let k = 0; k < g.nz; k++) for (let i = 0; i < g.nx; i++) {
        const b = raster[k * g.nx + i] - 1;
        if (b < 0) continue;
        const x = g.x0 + (i + 0.5) * g.cellMeters, z = g.z0 + (k + 0.5) * g.cellMeters;
        const e = out.get(b) ?? { cells: [], outside: 0 };
        if (within(x, z)) e.cells.push([Math.floor(x), Math.floor(z)]); else e.outside++;
        out.set(b, e);
    }
    return out;
}

export function massDistrictBuilding(b: VectorBuilding, index: number, fp: { cells: Array<[number, number]>; outside: number }, look: EvidenceLookup, ground: Pick<GroundModel, 'groundAt' | 'topAt'>, P = DISTRICT_MASSING_PARAMS, opts: { lenient?: boolean } = {}): DistrictBuildingMassing {
    const t0 = Date.now();
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
    const R = Math.ceil(P.overhangRingM);
    for (const [x, z] of fp.cells) for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
        if (dx * dx + dz * dz > P.overhangRingM * P.overhangRingM + 0.5) continue;
        const k = `${x + dx},${z + dz}`;
        if (inFoot.has(k) || ring.has(k)) continue;
        if (look.buildingAt(x + dx + 0.5, z + dz + 0.5) > 0) continue;
        if (raisedAt(x + dx, z + dz)) ring.add(k);
    }
    const overhangShare = ring.size / Math.max(1, fp.cells.length);
    const common = { ...base, groundY: r2(groundY), raisedShare: r2(raisedShare), overhangShare: r2(overhangShare) };
    let reason: string | undefined;
    const caveats: string[] = [];
    // the scan showing street where the footprint is: real data leads, nothing is built there (lenient or not)
    if (raisedShare < P.minRaisedShare) reason = `only ${Math.round(raisedShare * 100)}% of the footprint stands ${P.raisedM} m over the street in the scan (at least ${Math.round(P.minRaisedShare * 100)}% needed): the vector data and the scan disagree that a building stands here`;
    if (reason) return { ...common, ok: false, reason, ms: Date.now() - t0 };
    const soft: string[] = [];
    if (fp.outside > 0) soft.push(`the footprint runs past the extraction (${fp.outside} of its cells outside): the scan holds only part of the building`);
    if (overhangShare > P.maxOverhangShare) soft.push(`the scan stands raised over ${Math.round(overhangShare * 100)}% of the footprint's area just outside it, where no footprint is (at most ${Math.round(P.maxOverhangShare * 100)}%): the footprint is smaller than what was scanned`);
    if (soft.length && !opts.lenient) return { ...common, ok: false, reason: soft[0], ms: Date.now() - t0 };
    caveats.push(...soft);
    const massing = buildMassing({ buildings: [b], groundY, scanTop: ground.topAt, cells: raised });
    // pipeline E's roof check over the raised footprint (its plan check is the isolate's and does not apply here)
    const roof = checkMassing(massing.parts, massing.meshes, { groundY, scanTop: ground.topAt, cells: raised });
    if (!roof.massingCells) reason = 'the vector data hold no extruded part or modelled volume for the building';
    else if (roof.reason && !/plan agrees/.test(roof.reason)) { if (opts.lenient) caveats.push(roof.reason); else reason = roof.reason; }
    return { ...common, massing, ok: !reason, ...(reason ? { reason } : {}), ...(caveats.length ? { caveat: caveats.join('; ') } : {}), ms: Date.now() - t0 };
}

/** Every building of the district reaching the extraction, massed and checked. */
export function massDistrict(input: { buildings: VectorBuilding[]; look: EvidenceLookup; ground: Pick<GroundModel, 'groundAt' | 'topAt'>; within: (x: number, z: number) => boolean; lenient?: boolean }, P = DISTRICT_MASSING_PARAMS): DistrictBuildingMassing[] {
    const fps = footprintCellsByBuilding(input.look, input.within);
    const out: DistrictBuildingMassing[] = [];
    for (const [b, fp] of [...fps].sort((p, q) => p[0] - q[0])) if (fp.cells.length) out.push(massDistrictBuilding(input.buildings[b], b, fp, input.look, input.ground, P, { lenient: input.lenient }));
    return out;
}

/**
 * The plan cells the rebuilt buildings stand on, for cutting them out of the scan's layers: their footprints, grown by
 * `marginM` (the scan's facade stands a little outside a footprint) but never into another building's footprint, so a
 * neighbour left as scanned keeps its own walls whole.
 */
export function districtFootprint(rows: DistrictBuildingMassing[], look: EvidenceLookup, within: (x: number, z: number) => boolean, marginM = 1): StructureFootprint {
    const fps = footprintCellsByBuilding(look, within);
    const cells = new Set<string>();
    const cellGroundY = new Map<string, number>();
    let baseY = Infinity, topY = -Infinity;
    const R = Math.ceil(marginM);
    for (const r of rows.filter(x => x.ok && x.massing)) {
        for (const [x, z] of fps.get(r.index)?.cells ?? []) for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
            if (dx * dx + dz * dz > marginM * marginM + 0.5) continue;
            const b = look.buildingAt(x + dx + 0.5, z + dz + 0.5);
            if (b > 0 && b - 1 !== r.index) continue;
            const k = `${x + dx},${z + dz}`;
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
    timingsMs: Record<string, number>;
}

/**
 * The rebuilt buildings as one layer: their massings in one native run (walls snapped onto the scanned facades, the scan the
 * massing does not explain kept as residual and audited), textured from the tile photo, written beside `outDir`. `scanGlb` is
 * the tree-stripped scan; the native tool sees only its part over the rebuilt footprints.
 */
export async function buildDistrictMassingLayer(input: { rows: DistrictBuildingMassing[]; look: EvidenceLookup; within: (x: number, z: number) => boolean; scanGlb: string; outDir: string; stage: string; stageKey: string; signal?: AbortSignal }): Promise<DistrictMassingLayer | undefined> {
    const timingsMs: Record<string, number> = {};
    const ok = input.rows.filter(r => r.ok && r.massing);
    if (!ok.length) return undefined;
    let t = Date.now();
    fs.mkdirSync(input.outDir, { recursive: true });
    const footprint = districtFootprint(ok, input.look, input.within, 2);
    // the native tool sees what stands on the footprints: nothing within the apron height of each building's own ground
    // (kerbs and street scanned at the footprint's edge would come back as residual lying on the street)
    for (const [k, y] of footprint.cellGroundY ?? []) footprint.cellGroundY!.set(k, y + APRON_HEIGHT_M - FOOTPRINT_GROUND_CLEARANCE_M);
    const isolate = path.join(input.outDir, 'scan_over_footprints.glb');
    fs.writeFileSync(isolate, hideFootprintInGlb(fs.readFileSync(input.scanGlb), footprint, { keep: 'inside' }).glb);
    timingsMs.crop = Date.now() - t;
    const parts = ok.flatMap(r => r.massing!.parts), meshes = ok.flatMap(r => r.massing!.meshes);
    const check = { iou: Math.round(100 * median(ok.map(r => r.raisedShare))) / 100, heightErrMedianM: median(ok.map(r => r.massing!.check.heightErrMedianM)), heightErrP90M: median(ok.map(r => r.massing!.check.heightErrP90M)), massingCells: 0, scanCells: 0, ok: true };
    t = Date.now();
    const run = await runNativeMassing({ parts, meshes }, { tilePath: input.scanGlb, isolateGlb: isolate, dir: path.join(input.outDir, 'native'), groundY: footprint.baseY, params: { pixel: DISTRICT_TEXEL_M }, ...(input.signal ? { signal: input.signal } : {}) });
    timingsMs.native = Date.now() - t;
    const offFootprint = keepResidualOver(run, footprint.cells);
    t = Date.now();
    const { textures, legend } = plainTextures(run);
    timingsMs.textures = Date.now() - t;
    t = Date.now();
    const files = writeMassingLayer(run, { check }, textures, legend, input.outDir, input.stage, input.stageKey, 'district_massing', undefined, { photoJpeg: true });
    timingsMs.glb = Date.now() - t;
    return { files, run, footprint: districtFootprint(ok, input.look, input.within, 1), rebuilt: ok.length, residualOffFootprint: offFootprint, timingsMs };
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
