/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import { containSplatsToScan, SPLAT_RECORD_BYTES } from '../src/node/spatial/splat-containment';

/** A scan of a street at y = 10: a 20 m tall building over x in [10, 30], a 1.5 m car lump at x in [-4, -2], ground elsewhere. */
const scan = {
    topHitLocal(x: number, _z: number): number | undefined {
        if (x >= 10 && x <= 30) return 30;
        if (x >= -4 && x <= -2) return 11.5;
        return 10;
    }
};

function splats(points: Array<[number, number, number]>): Buffer {
    const b = Buffer.alloc(points.length * SPLAT_RECORD_BYTES);
    points.forEach(([x, y, z], i) => { b.writeFloatLE(x, i * 32); b.writeFloatLE(y, i * 32 + 4); b.writeFloatLE(z, i * 32 + 8); b[i * 32 + 24] = i; });
    return b;
}

describe('containSplatsToScan', () => {
    it('keeps the ground and the building, drops what is under the street, over the car lump and above the roof', () => {
        const pts: Array<[number, number, number]> = [
            [0, 10.1, 0],     // street surface: kept
            [-3, 10.2, 0],    // the street under the car lump: kept (the ground is the window's lowest top, not the lump's)
            [-3, 11.4, 0],    // on top of the car lump: dropped (in the air over the street)
            [0, 3, 0],        // 7 m under the street: dropped
            [11.5, 25, 0],    // building facade, 1.5 m in from its edge, at mid-height: kept
            [10.5, 15, 0],    // on the building's face at its edge: kept
            [20, 34, 0],      // 4 m above the roof: dropped
            [5, 6, 0],        // under the street beside the building: dropped
            [20, 25, 0]       // inside the 20 m wide building, at mid-height: dropped (nothing stands inside a building)
        ];
        const { kept, report } = containSplatsToScan(splats(pts), scan, { cellM: 1, groundWindowM: 8 });
        const ids = Array.from({ length: kept.length / 32 }, (_, i) => kept[i * 32 + 24]);
        expect(ids).toEqual([0, 1, 4, 5]);
        // mid-roof of a building wider than the ground window the roof is that window's ground, so a splat over it counts as in the air
        expect(report).toMatchObject({ input: 9, kept: 4, droppedUnderground: 3, droppedInAir: 2, droppedAboveScan: 0, unmeasured: 0 });
        // the kept records are copied whole
        expect(kept.readFloatLE(2 * 32 + 4)).toBeCloseTo(25, 5);
    });

    it('keeps a long low structure (a fence line, a row of sheds) but not a car-sized lump of the same height', () => {
        // a street at y = 0; a 2.5 m tall structure 3 m wide and 30 m long (90 m²), and a 2.5 m lump 2 x 4 m (8 m²)
        const scan2 = {
            topHitLocal(x: number, z: number): number | undefined {
                if (x >= 5 && x < 8 && z >= -15 && z < 15) return 2.5;
                if (x >= -6 && x < -4 && z >= -2 && z < 2) return 2.5;
                return 0;
            }
        };
        const pts: Array<[number, number, number]> = [[6.5, 1.5, 0], [-5, 1.5, 0], [0, 0.1, 30], [0, 0.1, -30], [30, 0.1, 0], [-30, 0.1, 0]];
        const { report, reasons } = containSplatsToScan(splats(pts), scan2, { cellM: 1, groundWindowM: 8 });
        expect(reasons[0]).toBe(1); // the structure's face: kept as a hull
        expect(reasons[1]).toBe(4); // on the lump: in the air
        expect(report.kept).toBe(5);
    });

    it('keeps splats over cells the scan does not cover', () => {
        const { report } = containSplatsToScan(splats([[0, 0, 0], [1, 50, 1]]), { topHitLocal: () => undefined });
        expect(report).toMatchObject({ kept: 2, unmeasured: 2 });
    });
});
