/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Keeps a fused splat world inside the hulls the scan measures (user ask, 2026-10-29: "use the building hulls to
 * contain the splats"). The scan's top surface on a grid gives two things: the ground (the lowest top surface around a
 * cell, so a car or a kiosk on the street does not lift it) and the building columns (cells whose top rises well above
 * that ground). A splat is kept on the ground layer, or inside a building column up to its top; everything else goes:
 * - under the ground (seen through any gap, it reads as an upside-down world below the street);
 * - in the air over the street outside the buildings: the scan's lumps for cars, people, trees and street furniture,
 *   which the obstruction-free station images painted with the street behind them (floating smears); a lump in a
 *   building column's margin counts as one up to its own top, so a car parked against a wall is not kept for the wall;
 * - above the scan's own top surface.
 * The same rule published work applies at training time (keep only Gaussians on ground or building surfaces,
 * GS4Buildings / Clean-GS), applied here once to the fused splats, without training.
 */

import type { TileMeshRaycaster } from './tile-mesh-raycast';

/** Bytes per splat in the .splat layout (position xyz f32, scale xyz f32, rgba u8, rotation u8 x4). */
export const SPLAT_RECORD_BYTES = 32;

export interface ContainmentOptions {
    /** Grid cell of the scan's surface model, metres. Default 1. */
    cellM?: number;
    /** Radius of the window the ground is read over, metres (wider than a car or a kiosk). Default 8. */
    groundWindowM?: number;
    /** The ground is this percentile of the window's top surfaces (0..1). Default 0.2. */
    groundPercentile?: number;
    /** Thickness kept above and below the ground, metres. Default 0.6. */
    groundBandM?: number;
    /** A cell whose top rises more than this above its ground is a building column, metres. Default 4. */
    buildingRiseM?: number;
    /** Building columns are grown by this much, so a facade's own splats on the column's edge stay. Default 1. */
    hullMarginM?: number;
    /** A low structure rises at least this above its ground, metres. Default 0.8. */
    lowStructureRiseM?: number;
    /** A low structure with a connected footprint of at least this is kept as a hull (a car or a kiosk is far smaller), m². Default 50. */
    minStructureAreaM2?: number;
}

export interface ContainmentReport {
    input: number;
    kept: number;
    droppedUnderground: number;
    droppedInAir: number;
    droppedAboveScan: number;
    /** Splats over cells the scan does not cover (kept: nothing measured says they are wrong). */
    unmeasured: number;
    buildingCells: number;
    cells: number;
}

/** Why each splat was kept or dropped (containSplatsToScan's `reasons`). */
export const enum ContainmentReason { Ground = 0, Building = 1, Unmeasured = 2, Underground = 3, InAir = 4, AboveScan = 5 }

/** The scan's ground and building hulls on a grid over an extent; classify() says where a point stands against them. */
export interface ScanHulls {
    classify(x: number, y: number, z: number): ContainmentReason;
    /** The ground's height under (x, z), or undefined where the scan does not cover it. */
    groundAt(x: number, z: number): number | undefined;
    buildingCells: number;
    cells: number;
}

/** A point the hulls keep: on the ground, inside a building or structure column, or over a cell the scan does not cover. */
export function keptByHulls(reason: ContainmentReason): boolean {
    return reason === ContainmentReason.Ground || reason === ContainmentReason.Building || reason === ContainmentReason.Unmeasured;
}

/** Builds the hulls the scan `ray` measures over the x/z extent (see the file comment). */
export function buildScanHulls(ray: Pick<TileMeshRaycaster, 'topHitLocal'>, extent: { minX: number; maxX: number; minZ: number; maxZ: number }, opts: ContainmentOptions = {}): ScanHulls {
    const cell = opts.cellM ?? 1, band = opts.groundBandM ?? 0.6, rise = opts.buildingRiseM ?? 4;
    const { minX, maxX, minZ, maxZ } = extent;
    const cols = Math.max(1, Math.ceil((maxX - minX) / cell) + 1), rows = Math.max(1, Math.ceil((maxZ - minZ) / cell) + 1);
    const top = new Float32Array(cols * rows).fill(Number.NaN);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const y = ray.topHitLocal(minX + (c + 0.5) * cell, minZ + (r + 0.5) * cell);
        if (y !== undefined) top[r * cols + c] = y;
    }

    // ground: a low percentile of the top surface within the window. Not its minimum: a stairwell, a light well or a
    // pit in the scan (Penn Station's entrances) reaches far below the street and would sink the ground around it, so
    // the street-level facade beside it would read as floating. A car or a kiosk still covers too little of the window
    // to lift it.
    const w = Math.max(1, Math.round((opts.groundWindowM ?? 8) / cell));
    const q = opts.groundPercentile ?? 0.2;
    const ground = new Float32Array(cols * rows).fill(Number.NaN);
    const win: number[] = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        win.length = 0;
        for (let rr = Math.max(0, r - w); rr <= Math.min(rows - 1, r + w); rr++) {
            for (let cc = Math.max(0, c - w); cc <= Math.min(cols - 1, c + w); cc++) {
                const v = top[rr * cols + cc];
                if (!Number.isNaN(v)) win.push(v);
            }
        }
        if (!win.length) continue;
        win.sort((a, b) => a - b);
        ground[r * cols + c] = win[Math.min(win.length - 1, Math.floor(q * win.length))];
    }

    // building columns: top well above the ground, grown by the hull margin. Low structures (a fence line, a row of
    // sheds, an entrance canopy) count too when their connected footprint is large: height alone does not tell them
    // from a car or a kiosk, size does.
    const isBuilding = new Uint8Array(cols * rows);
    for (let i = 0; i < isBuilding.length; i++) if (top[i] - ground[i] > rise) isBuilding[i] = 1;
    const lowMin = opts.lowStructureRiseM ?? 0.8, minCells = Math.ceil((opts.minStructureAreaM2 ?? 50) / (cell * cell));
    const isLow = (i: number) => !isBuilding[i] && top[i] - ground[i] > lowMin;
    // a low component too small to be a structure is a lump (a parked car, a kiosk), wherever it stands
    const isLump = new Uint8Array(cols * rows);
    const lumpTop = new Float32Array(cols * rows).fill(Number.NaN);
    const seen = new Uint8Array(cols * rows), stack: number[] = [], comp: number[] = [];
    for (let s0 = 0; s0 < seen.length; s0++) {
        if (seen[s0] || !isLow(s0)) continue;
        comp.length = 0; stack.push(s0); seen[s0] = 1;
        while (stack.length) {
            const i = stack.pop()!; comp.push(i);
            const r = Math.floor(i / cols), c = i % cols;
            for (const [rr, cc] of [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]]) {
                if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
                const j = rr * cols + cc;
                if (!seen[j] && isLow(j)) { seen[j] = 1; stack.push(j); }
            }
        }
        if (comp.length >= minCells) for (const i of comp) isBuilding[i] = 1;
        else for (const i of comp) isLump[i] = 1;
    }
    // each lump's top over its own cells and the ground-level cells beside them (a car is two or three cells wide, and a
    // cell whose centre misses it reads as ground while the car's side still stands in it)
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        if (isBuilding[i]) continue;
        if (isLump[i]) { lumpTop[i] = Math.max(Number.isNaN(lumpTop[i]) ? -Infinity : lumpTop[i], top[i]); continue; }
        if (!(top[i] - ground[i] <= lowMin)) continue;
        for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
            const rr = r + dr, cc = c + dc;
            if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
            const j = rr * cols + cc;
            if (isLump[j] && !(lumpTop[i] >= top[j])) lumpTop[i] = top[j];
        }
    }
    const grow = Math.max(0, Math.round((opts.hullMarginM ?? 1) / cell));
    const hull = new Uint8Array(isBuilding);
    // the tallest top within the margin, so a facade splat at the column's edge is judged against its own building
    const hullTop = new Float32Array(top);
    if (grow > 0) {
        for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
            if (!isBuilding[r * cols + c]) continue;
            for (let dr = -grow; dr <= grow; dr++) for (let dc = -grow; dc <= grow; dc++) {
                const rr = r + dr, cc = c + dc;
                if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
                const k = rr * cols + cc;
                hull[k] = 1;
                if (!(hullTop[k] >= top[r * cols + c])) hullTop[k] = top[r * cols + c];
            }
        }
    }

    let buildingCells = 0;
    for (let i = 0; i < isBuilding.length; i++) buildingCells += isBuilding[i];
    const cellOf = (x: number, z: number) => {
        const c = Math.floor((x - minX) / cell), r = Math.floor((z - minZ) / cell);
        return c < 0 || r < 0 || c >= cols || r >= rows ? -1 : r * cols + c;
    };
    return {
        buildingCells, cells: cols * rows,
        groundAt(x: number, z: number): number | undefined {
            const k = cellOf(x, z);
            return k < 0 || Number.isNaN(ground[k]) ? undefined : ground[k];
        },
        classify(x: number, y: number, z: number): ContainmentReason {
            const k = cellOf(x, z);
            if (k < 0) return ContainmentReason.Unmeasured;
            const g = ground[k];
            if (Number.isNaN(g)) return ContainmentReason.Unmeasured;
            if (y < g - band) return ContainmentReason.Underground;
            if (y <= g + band) return ContainmentReason.Ground;
            if (!hull[k]) return ContainmentReason.InAir;
            // a lump in a column's margin is still a lump up to its own top (7th Ave, 2026-11-03: cars parked against a
            // 7 m structure stood crumpled beside the walk, kept by its margin); the column's facade above it stays
            if (!Number.isNaN(lumpTop[k]) && y <= lumpTop[k] + band) return ContainmentReason.InAir;
            if (y > hullTop[k] + band) return ContainmentReason.AboveScan;
            return ContainmentReason.Building;
        }
    };
}

/** Contains the splats in `splat` (the .splat layout) to the scan `ray` measures; returns the kept records, what went, and why per splat. */
export function containSplatsToScan(splat: Buffer, ray: Pick<TileMeshRaycaster, 'topHitLocal'>, opts: ContainmentOptions = {}): { kept: Buffer; report: ContainmentReport; reasons: Uint8Array } {
    const n = Math.floor(splat.length / SPLAT_RECORD_BYTES);
    const f32 = (i: number, k: number) => splat.readFloatLE(i * SPLAT_RECORD_BYTES + k * 4);
    // the grid over the splats' own extent
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
        const x = f32(i, 0), z = f32(i, 2);
        if (x < minX) minX = x; if (x > maxX) maxX = x; if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    const hulls = buildScanHulls(ray, { minX, maxX, minZ, maxZ }, opts);
    const keep = new Uint8Array(n), reasons = new Uint8Array(n);
    const report: ContainmentReport = { input: n, kept: 0, droppedUnderground: 0, droppedInAir: 0, droppedAboveScan: 0, unmeasured: 0, buildingCells: hulls.buildingCells, cells: hulls.cells };
    for (let i = 0; i < n; i++) {
        const why = hulls.classify(f32(i, 0), f32(i, 1), f32(i, 2));
        reasons[i] = why;
        if (keptByHulls(why)) keep[i] = 1;
        if (why === ContainmentReason.Unmeasured) report.unmeasured++;
        else if (why === ContainmentReason.Underground) report.droppedUnderground++;
        else if (why === ContainmentReason.InAir) report.droppedInAir++;
        else if (why === ContainmentReason.AboveScan) report.droppedAboveScan++;
    }
    let m = 0;
    for (let i = 0; i < n; i++) m += keep[i];
    const kept = Buffer.alloc(m * SPLAT_RECORD_BYTES);
    for (let i = 0, o = 0; i < n; i++) if (keep[i]) { splat.copy(kept, o, i * SPLAT_RECORD_BYTES, (i + 1) * SPLAT_RECORD_BYTES); o += SPLAT_RECORD_BYTES; }
    report.kept = m;
    return { kept, report, reasons };
}
