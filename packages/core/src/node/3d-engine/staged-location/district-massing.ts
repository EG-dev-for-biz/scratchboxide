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

import type { GroundModel } from '../../spatial/StreetViewSurveyPlanner';
import type { EvidenceLookup, VectorBuilding } from './vector-footprints';
import { buildMassing, checkMassing, type Massing } from './pipeline-e/massing-spec';

export const DISTRICT_MASSING_VERSION = 'district-massing/1';

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

export function massDistrictBuilding(b: VectorBuilding, index: number, fp: { cells: Array<[number, number]>; outside: number }, look: EvidenceLookup, ground: Pick<GroundModel, 'groundAt' | 'topAt'>, P = DISTRICT_MASSING_PARAMS): DistrictBuildingMassing {
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
    if (fp.outside > 0) reason = `the footprint runs past the extraction (${fp.outside} of its cells outside): the scan holds only part of the building`;
    else if (raisedShare < P.minRaisedShare) reason = `only ${Math.round(raisedShare * 100)}% of the footprint stands ${P.raisedM} m over the street in the scan (at least ${Math.round(P.minRaisedShare * 100)}% needed): the vector data and the scan disagree that a building stands here`;
    else if (overhangShare > P.maxOverhangShare) reason = `the scan stands raised over ${Math.round(overhangShare * 100)}% of the footprint's area just outside it, where no footprint is (at most ${Math.round(P.maxOverhangShare * 100)}%): the footprint is smaller than what was scanned`;
    if (reason) return { ...common, ok: false, reason, ms: Date.now() - t0 };
    const massing = buildMassing({ buildings: [b], groundY, scanTop: ground.topAt, cells: raised });
    // pipeline E's roof check over the raised footprint (its plan check is the isolate's and does not apply here)
    const roof = checkMassing(massing.parts, massing.meshes, { groundY, scanTop: ground.topAt, cells: raised });
    if (!roof.massingCells) reason = 'the vector data hold no extruded part or modelled volume for the building';
    else if (roof.reason && !/plan agrees/.test(roof.reason)) reason = roof.reason;
    return { ...common, massing, ok: !reason, ...(reason ? { reason } : {}), ms: Date.now() - t0 };
}

/** Every building of the district reaching the extraction, massed and checked. */
export function massDistrict(input: { buildings: VectorBuilding[]; look: EvidenceLookup; ground: Pick<GroundModel, 'groundAt' | 'topAt'>; within: (x: number, z: number) => boolean }, P = DISTRICT_MASSING_PARAMS): DistrictBuildingMassing[] {
    const fps = footprintCellsByBuilding(input.look, input.within);
    const out: DistrictBuildingMassing[] = [];
    for (const [b, fp] of [...fps].sort((p, q) => p[0] - q[0])) if (fp.cells.length) out.push(massDistrictBuilding(input.buildings[b], b, fp, input.look, input.ground, P));
    return out;
}
