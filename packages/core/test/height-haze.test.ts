/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import { hazeColumnFactor, hazeExtinctionPerM, HAZE_COLUMN_FACTOR_GLSL } from '../src/common/spatial/height-haze';
import { AERIAL_PERSPECTIVE_FRAGMENT_SHADER } from '../src/browser/generative-canvas/services/atmosphere/AerialPerspectiveEffect';

/** The mean density along the sight line by numerical integration of exp(-max(0, h - base) / H). */
function integrated(cam: number, point: number, scale: number, base = 0, steps = 20000): number {
    let sum = 0;
    for (let i = 0; i < steps; i++) {
        const h = cam + (point - cam) * (i + 0.5) / steps;
        sum += Math.exp(-Math.max(0, h - base) / scale);
    }
    return sum / steps;
}

describe('height haze', () => {
    it('is uniform when no scale height is given', () => {
        expect(hazeColumnFactor(160, 0, 0)).toBe(1);
        expect(hazeColumnFactor(160, 0, -5)).toBe(1);
    });

    it('matches the integral of the density along the sight line', () => {
        for (const [cam, point, scale, base] of [[160, 0, 50, 0], [160, 120, 50, 0], [2, 300, 80, 0], [40, 40, 50, 0], [160, -10, 50, 0], [5, 60, 30, 20], [-3, -8, 50, 0]]) {
            expect(hazeColumnFactor(cam, point, scale, base)).toBeCloseTo(integrated(cam, point, scale, base), 5);
        }
    });

    it('is thick along the street and thin toward rooftops, and the same from either end', () => {
        const street = hazeColumnFactor(1.7, 1.7, 50);       // an eye-level sight line
        const downToStreet = hazeColumnFactor(160, 0, 50);   // an aerial camera looking at the street
        const toRooftop = hazeColumnFactor(160, 120, 50);    // the same camera looking at a rooftop
        expect(street).toBeCloseTo(Math.exp(-1.7 / 50), 9);
        expect(downToStreet).toBeGreaterThan(toRooftop);
        expect(downToStreet).toBeCloseTo((1 - Math.exp(-3.2)) / 3.2, 9);
        expect(toRooftop).toBeLessThan(0.1);
        expect(hazeColumnFactor(0, 160, 50)).toBeCloseTo(downToStreet, 12);
    });

    it('is what the aerial perspective pass multiplies its optical depth by', () => {
        expect(AERIAL_PERSPECTIVE_FRAGMENT_SHADER).toContain(HAZE_COLUMN_FACTOR_GLSL.trim());
        expect(AERIAL_PERSPECTIVE_FRAGMENT_SHADER).toMatch(/float column = hazeColumnFactor\(uCameraPosition\.y, worldPos\.y, uHazeScaleHeight, uHazeBaseAltitude\)/);
        expect(AERIAL_PERSPECTIVE_FRAGMENT_SHADER).toMatch(/opticalDepth = betaExt \* dist \* 0\.85 \* column/);
        expect(AERIAL_PERSPECTIVE_FRAGMENT_SHADER).toMatch(/opticalDepth \+= vec3\(uHazeExtinction \* dist \* column\)/);
    });

    it('fades a dark object to 2% contrast at the visibility, along the ground', () => {
        expect(hazeExtinctionPerM(undefined)).toBe(0);
        expect(hazeExtinctionPerM(0)).toBe(0);
        const beta = hazeExtinctionPerM(1800);
        expect(Math.exp(-beta * 1800)).toBeCloseTo(0.02, 4);
        // an aerial camera 160 m up, a 55 m haze layer: the street 340 m away fades, a rooftop 120 m up barely does
        const street = Math.exp(-beta * 340 * hazeColumnFactor(160, 0, 55));
        const roof = Math.exp(-beta * 200 * hazeColumnFactor(160, 120, 55));
        expect(street).toBeLessThan(0.82);
        expect(roof).toBeGreaterThan(0.95);
    });
});
