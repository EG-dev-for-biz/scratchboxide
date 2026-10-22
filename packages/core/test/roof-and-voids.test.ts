/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Plane first inside and on top of a rebuilt building (roof-and-voids.ts), on synthetic height maps: an enclosed light well
 * is carved with a floor, a notch open to the street is not; a box and a hollow lantern on the roof become fitted prisms;
 * splinters, the scan hidden inside the solid and roof noise are dropped while a canopy stays; and a footprint the scan
 * shows shifted is registered before its walls are fitted (wall-plane-fit.ts registerFootprint).
 */

import { describe, expect, it } from 'vitest';
import { carveCourtyards, fitRooftopSolids, principalExtents, roofDebrisDecider } from '../src/node/3d-engine/staged-location/roof-and-voids';
import { registerFootprint } from '../src/node/3d-engine/staged-location/wall-plane-fit';
import { inLoops } from '../src/node/3d-engine/staged-location/pipeline-e/massing-spec';
import type { Vec2 } from '../src/common/spatial/staged-location-contracts';

const rect = (x0: number, z0: number, x1: number, z1: number): Vec2[] => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
const part = (loops: Vec2[][], topY = 30) => ({ id: 'b/e0', baseY: 0, topY, loops, planes: [] });
const inRect = (x: number, z: number, r: [number, number, number, number]) => x >= r[0] && x <= r[2] && z >= r[1] && z <= r[3];

describe('carveCourtyards', () => {
    it('carves an enclosed light well with a floor, and leaves a notch open to the street', () => {
        // a 40 x 40 m block 30 m tall; a 10 x 8 m well down to 12 m in its middle; a 6 x 6 m notch at its edge down to 2 m
        const top = (x: number, z: number) => (inRect(x, z, [15, 16, 25, 24]) ? 12 : inRect(x, z, [0, 0, 6, 6]) ? 2 : 30);
        const { parts, floors, voids } = carveCourtyards([part([rect(0, 0, 40, 40)])], top);
        expect(voids).toHaveLength(1);
        expect(parts[0].loops).toHaveLength(2);
        const hole = parts[0].loops[1];
        expect(inLoops(20, 20, parts[0].loops)).toBe(false);   // the well is open
        expect(inLoops(3, 3, parts[0].loops)).toBe(true);      // the notch stays solid (not enclosed)
        const xs = hole.map(q => q[0]), zs = hole.map(q => q[1]);
        expect(Math.min(...xs)).toBeCloseTo(15, 0); expect(Math.max(...xs)).toBeCloseTo(25, 0);
        expect(Math.min(...zs)).toBeCloseTo(16, 0); expect(Math.max(...zs)).toBeCloseTo(24, 0);
        expect(voids[0].floorY).toBeCloseTo(12, 6);
        expect(floors).toHaveLength(1);
        expect(floors[0].floor.topY).toBeCloseTo(12, 6);
    });
});

describe('fitRooftopSolids', () => {
    it('rebuilds a plant room as a box and a hollow lantern as one prism, and leaves the parapet', () => {
        const p = part([rect(0, 0, 40, 40)], 20);
        const top = (x: number, z: number) => {
            if (inRect(x, z, [5, 5, 11, 9])) return 24;                        // a 6 x 4 m plant room, 4 m tall
            const r = Math.hypot(x - 28, z - 28);
            if (r >= 2.5 && r <= 4.5) return 27;                               // a hollow lantern ring, 7 m tall
            if (x < 0.8 || z < 0.8 || x > 39.2 || z > 39.2) return 21.5;       // the parapet
            return 20;
        };
        const { solids, records } = fitRooftopSolids([p], top);
        expect(solids).toHaveLength(2);
        const box = records.find(r => r.shape === 'rectangle' && r.areaM2 < 40)!;
        expect(box.heightM).toBeCloseTo(4, 0);
        expect(box.areaM2).toBeGreaterThan(20); expect(box.areaM2).toBeLessThan(30);
        const lantern = records.find(r => r !== box)!;
        expect(lantern.heightM).toBeCloseTo(7, 0);
        // the ring's interior is the lantern's, not a hole in it
        expect(lantern.areaM2).toBeGreaterThan(40);
        expect(solids.every(s => s.baseY < 20 && s.provenance === 'rooftop-solid-fitted')).toBe(true);
    });
});

describe('roofDebrisDecider', () => {
    const parts = [part([rect(0, 0, 20, 20)], 15)];
    const decide = roofDebrisDecider(parts);
    const cluster = (tris: number[][][]) => {
        const points = tris.flat(2);
        const out = tris.map(t => {
            const u = [t[1][0] - t[0][0], t[1][1] - t[0][1], t[1][2] - t[0][2]], w = [t[2][0] - t[0][0], t[2][1] - t[0][1], t[2][2] - t[0][2]];
            return { c: [0, 1, 2].map(k => (t[0][k] + t[1][k] + t[2][k]) / 3) as [number, number, number], area: 0.5 * Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]) };
        });
        return { areaM2: out.reduce((t, q) => t + q.area, 0), tris: out, points };
    };
    it('drops a splinter, the scan hidden inside the solid and the roof noise, and keeps a canopy', () => {
        const splinter = cluster([[[2, 15.5, 2], [9, 16, 2.1], [9, 15.6, 2.3]]]);
        expect(principalExtents(splinter.points)[1]).toBeLessThan(0.5);
        expect(decide(splinter)).toBe('splinter');
        expect(decide(cluster([[[3, 5, 3], [12, 5, 3], [12, 10, 12]], [[3, 5, 3], [12, 10, 12], [3, 10, 12]]]))).toBe('hidden');
        expect(decide(cluster([[[3, 15.3, 3], [8, 15.5, 3], [8, 15.2, 8]], [[3, 15.3, 3], [8, 15.2, 8], [3, 15.4, 8]]]))).toBe('roof');
        // a canopy 4 m out from the wall at 5 m up
        expect(decide(cluster([[[21, 5, 4], [25, 5, 4], [25, 5, 12]], [[21, 5, 4], [25, 5, 12], [21, 5, 12]]]))).toBeUndefined();
    });
});

describe('registerFootprint', () => {
    it('recovers the shift a footprint stands off the scan from its walls\' offsets, and refuses walls of one direction', () => {
        // a 20 x 30 m footprint whose scan stands 0.7 m east and 1.1 m south of it: each wall's offset is n . shift
        const T: Vec2 = [0.7, 1.1];
        const walls = [
            { a: [0, 0] as Vec2, b: [20, 0] as Vec2, outward: [0, -1] as Vec2 },
            { a: [20, 0] as Vec2, b: [20, 30] as Vec2, outward: [1, 0] as Vec2 },
            { a: [20, 30] as Vec2, b: [0, 30] as Vec2, outward: [0, 1] as Vec2 },
            { a: [0, 30] as Vec2, b: [0, 0] as Vec2, outward: [-1, 0] as Vec2 }
        ].map(w => ({ ...w, offsetM: w.outward[0] * T[0] + w.outward[1] * T[1], weight: 10 }));
        const reg = registerFootprint(walls);
        expect(reg.applied).toBe(true);
        expect(reg.shift[0]).toBeCloseTo(0.7, 2); expect(reg.shift[1]).toBeCloseTo(1.1, 2);
        expect(Math.abs(reg.rotationDeg)).toBeLessThan(0.01);
        const q = reg.transform([0, 0]);
        expect(q[0]).toBeCloseTo(0.7, 2); expect(q[1]).toBeCloseTo(1.1, 2);
        expect(registerFootprint(walls.filter(w => w.outward[0] === 0)).applied).toBe(false);
    });
});
