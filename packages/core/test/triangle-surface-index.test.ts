/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import { nearestLabelIndex, pointTriangleDist2, surfaceIndex } from '../src/node/spatial/triangle-surface-index';

// a right triangle in the ground plane: (0,0,0), (2,0,0), (0,0,2)
const TRI = Float32Array.from([0, 0, 0, 2, 0, 0, 0, 0, 2]);

describe('triangle surface index', () => {
    it('measures point-to-triangle distance over the face, to an edge and to a corner', () => {
        expect(pointTriangleDist2(TRI, 0, 0.5, 3, 0.5)).toBeCloseTo(9, 6);            // over the face: its height
        expect(pointTriangleDist2(TRI, 0, 1, 0, -1)).toBeCloseTo(1, 6);               // beside the edge along x
        expect(pointTriangleDist2(TRI, 0, 2, 0, 2)).toBeCloseTo(2, 6);                // past the hypotenuse's middle: to (1, 0, 1)
        expect(pointTriangleDist2(TRI, 0, -1, 0, -1)).toBeCloseTo(2, 6);              // past the corner at the origin
        expect(pointTriangleDist2(TRI, 0, 3, 1, 0)).toBeCloseTo(2, 6);                // past the corner (2, 0, 0)
    });

    it('says whether a point lies within the tolerance of any triangle, and only of those kept', () => {
        const soup = { positions: Float32Array.from([...TRI, ...TRI.map((v, i) => (i % 3 === 0 ? v + 10 : v))]) };
        const near = surfaceIndex(soup, 0.03);
        expect(near(0.5, 0.02, 0.5)).toBe(true);
        expect(near(0.5, 0.05, 0.5)).toBe(false);
        expect(near(10.5, 0.01, 0.5)).toBe(true);
        const onlyFirst = surfaceIndex(soup, 0.03, Uint8Array.from([1, 0]));
        expect(onlyFirst(10.5, 0.01, 0.5)).toBe(false);
    });

    it('gives the label of the nearest triangle within reach, -1 beyond it', () => {
        // two triangles 1 m apart in height: the ground (label 4) and a slab above it (label 9)
        const soup = { positions: Float32Array.from([...TRI, ...TRI.map((v, i) => (i % 3 === 1 ? v + 1 : v))]) };
        const nearest = nearestLabelIndex(soup, Uint8Array.from([4, 9]), 0.6);
        expect(nearest(0.5, 0.2, 0.5)).toBe(4);
        expect(nearest(0.5, 0.8, 0.5)).toBe(9);
        expect(nearest(0.5, 1.5, 0.5)).toBe(9);
        expect(nearest(0.5, 1.7, 0.5)).toBe(-1);
        expect(nearest(5, 0, 5)).toBe(-1);
        expect(nearestLabelIndex(soup, 2, 0.6)(0.5, 0.2, 0.5)).toBe(2);
        // a triangle across several cells is found from each of them
        const big = { positions: Float32Array.from([0, 0, 0, 20, 0, 0, 0, 0, 20]) };
        const q = nearestLabelIndex(big, 7, 0.5, 1);
        expect([q(0.5, 0.1, 0.5), q(9.5, 0.4, 3.5), q(1, -0.3, 17)]).toEqual([7, 7, 7]);
    });
});
