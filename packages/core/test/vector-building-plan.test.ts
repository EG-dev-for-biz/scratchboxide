/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { buildingPlanLoops, type VectorBuilding } from '../src/node/3d-engine/staged-location/vector-footprints';
import { footprintLoops } from '../src/node/3d-engine/staged-location/orchestrator';
import { inRing, ringArea } from '../src/node/3d-engine/staged-location/pipeline-e/massing-spec';
import type { Vec2 } from '../src/common/spatial/staged-location-contracts';

/** A closed prism over a plan rectangle as Google's modelled volumes come: triangles (x, height, z), walls and roof. */
function box(x0: number, z0: number, x1: number, z1: number, h: number, at = 0): NonNullable<VectorBuilding['volumes']>[number] {
    const c: Array<[number, number]> = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
    const vertices: Array<[number, number, number]> = [...c.map(([x, z]) => [x, 0, z] as [number, number, number]), ...c.map(([x, z]) => [x, h, z] as [number, number, number])];
    const indices = [4, 5, 6, 4, 6, 7, 0, 2, 1, 0, 3, 2];
    for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; indices.push(i, j, 4 + j, i, 4 + j, 4 + i); }
    return { vertices: vertices.map(([x, y, z]) => [x + at, y, z]), indices, heightM: h };
}

const inAny = (x: number, z: number, loops: Vec2[][]) => loops.some(l => inRing(x, z, l));

describe('a building plan from Google vector data, whatever form it comes in', () => {
    it('traces a modelled L-shaped building from above: its notch stays out, its outline within half a metre of the model', () => {
        // a tower 40 x 20 m and a podium wing 20 x 20 m below it: an L, whose convex hull would take in the 20 x 20 m notch
        const b: VectorBuilding = { id: 'L', parts: [], volumes: [box(0, 0, 40, 20, 120), box(0, 20, 20, 40, 25)] };
        const { loops, modelled } = buildingPlanLoops(b);
        expect(modelled).toBe(true);
        expect(loops).toHaveLength(1);
        expect(Math.abs(ringArea(loops[0]))).toBeGreaterThan(1200);
        expect(Math.abs(ringArea(loops[0]))).toBeLessThan(1250);
        // the notch (20..40, 20..40) is outside, every corner of the model inside or within 0.5 m of the outline
        expect(inAny(30, 30, loops)).toBe(false);
        expect(inAny(21, 21, loops)).toBe(false);
        for (const [x, z] of [[0.1, 0.1], [39.9, 0.1], [39.9, 19.9], [19.9, 39.9], [0.1, 39.9], [19.9, 20.1]] as Vec2[]) expect(inAny(x, z, loops)).toBe(true);
        for (const [x, z] of [[-0.5, 10], [40.5, 10], [10, 40.5], [30, 20.5]] as Vec2[]) expect(inAny(x, z, loops)).toBe(false);
    });

    it('keeps two separate modelled pieces as two loops, and drops slivers', () => {
        const b: VectorBuilding = { id: 'two', parts: [], volumes: [box(0, 0, 10, 10, 30), box(30, 0, 40, 10, 30), box(60, 0, 60.3, 0.3, 5)] };
        const { loops } = buildingPlanLoops(b);
        expect(loops).toHaveLength(2);
        expect(inAny(5, 5, loops) && inAny(35, 5, loops)).toBe(true);
        expect(inAny(20, 5, loops)).toBe(false);
    });

    it('takes extruded outlines as they are, and plan-only footprints only when nothing else is there', () => {
        const ring: Vec2[] = [[0, 0], [10, 0], [10, 10], [0, 10]];
        const plan: Vec2[] = [[0, 0], [12, 0], [12, 12], [0, 12]];
        expect(buildingPlanLoops({ extruded: [{ loops: [ring], heightM: 20 }, { loops: [plan], planOnly: true }] })).toEqual({ loops: [ring], modelled: false });
        expect(buildingPlanLoops({ extruded: [{ loops: [plan], planOnly: true }] })).toEqual({ loops: [plan], modelled: false });
        expect(buildingPlanLoops({})).toEqual({ loops: [], modelled: false });
    });

    it('footprintLoops joins every building and says when one was modelled; empty when none has a plan', () => {
        const ring: Vec2[] = [[50, 0], [60, 0], [60, 10], [50, 10]];
        const r = footprintLoops([{ volumes: [box(0, 0, 10, 10, 30)] }, { extruded: [{ loops: [ring], heightM: 9 }] }]);
        expect(r.modelled).toBe(true);
        expect(r.loops).toHaveLength(2);
        expect(footprintLoops([{ extruded: [{ loops: [ring] }] }]).modelled).toBe(false);
        expect(footprintLoops([{}]).loops).toEqual([]);
    });
});
