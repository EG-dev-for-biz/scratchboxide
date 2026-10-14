/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * facadeSideHeadings finds the hero's facade sides in the scan instead of assuming four: a rotated rectangular
 * tower gives its 4 outward headings, a triangular one 3, an L-shaped plan its 4 directions (two faces each), and
 * a round tower falls back to 8 sectors.
 */

import { describe, it, expect } from 'vitest';
import { facadeSideHeadings, type ScanMesh, type GroundModel } from '../src/node/spatial/StreetViewSurveyPlanner';

const DEG = Math.PI / 180;

/** Vertical wall strips of a closed polygonal plan (vertices in x, z), 40 m tall, as a ScanMesh-like triangle soup. */
function prism(plan: Array<[number, number]>, segmentsPerEdge = 6): ScanMesh {
    const normals: number[] = [], areas: number[] = [], centroids: number[] = [];
    for (let e = 0; e < plan.length; e++) {
        const [x0, z0] = plan[e], [x1, z1] = plan[(e + 1) % plan.length];
        const len = Math.hypot(x1 - x0, z1 - z0);
        // in-plane horizontal direction and a normal (sign arbitrary, like photogrammetry winding)
        const nx = (z1 - z0) / len, nz = -(x1 - x0) / len;
        for (let k = 0; k < segmentsPerEdge; k++) {
            const t = (k + 0.5) / segmentsPerEdge;
            for (const sign of [1, -1]) { // two triangles per segment, opposite windings
                normals.push(sign * nx, 0, sign * nz);
                areas.push(0.5 * (len / segmentsPerEdge) * 40);
                centroids.push(x0 + (x1 - x0) * t, 20, z0 + (z1 - z0) * t);
            }
        }
    }
    const n = areas.length;
    return {
        mesh: { vertices: new Float32Array(0), indices: new Uint32Array(0) }, triCount: n,
        triNormal: Float32Array.from(normals), triArea: Float32Array.from(areas), triCentroid: Float32Array.from(centroids),
        triTexelMeters: new Float32Array(n).fill(NaN), bounds: { min: [-100, 0, -100], max: [100, 40, 100] }
    };
}

const everywhere = { cellIndex: () => 0 } as unknown as GroundModel;
const footprint = Uint8Array.from([1]);
const rotate = (pts: Array<[number, number]>, deg: number): Array<[number, number]> =>
    pts.map(([x, z]) => [x * Math.cos(deg * DEG) - z * Math.sin(deg * DEG), x * Math.sin(deg * DEG) + z * Math.cos(deg * DEG)]);
const centroidOf = (pts: Array<[number, number]>) => ({ x: pts.reduce((s, p) => s + p[0], 0) / pts.length, z: pts.reduce((s, p) => s + p[1], 0) / pts.length });
const near = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };

describe('facadeSideHeadings', () => {
    it('finds the 4 sides of a rotated rectangular tower', () => {
        const plan = rotate([[-20, -15], [20, -15], [20, 15], [-20, 15]], 29);
        const h = facadeSideHeadings(prism(plan), everywhere, footprint, centroidOf(plan), 29);
        expect(h.length).toBe(4);
        // outward headings are 90 deg apart
        for (let k = 0; k < 4; k++) expect(near(h[(k + 1) % 4], h[k] + 90)).toBeLessThan(1);
    });

    it('finds the 3 sides of a triangular tower', () => {
        const plan: Array<[number, number]> = [[0, -30], [26, 15], [-26, 15]];
        const h = facadeSideHeadings(prism(plan), everywhere, footprint, centroidOf(plan), 0);
        expect(h.length).toBe(3);
        for (let k = 0; k < 3; k++) expect(near(h[(k + 1) % 3], h[k] + 120)).toBeLessThan(1.5);
    });

    it('falls back to 8 sectors for a round tower', () => {
        const plan: Array<[number, number]> = Array.from({ length: 72 }, (_, k) => [20 * Math.cos(k * 5 * DEG), 20 * Math.sin(k * 5 * DEG)]);
        const h = facadeSideHeadings(prism(plan, 1), everywhere, footprint, { x: 0, z: 0 }, 12);
        expect(h.length).toBe(8);
        expect(near(h[0], 12)).toBeLessThan(1e-9);
    });
});
