/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The sun's screen-space contact shadows (contactShadows.ts), on real WebGL in headless Chrome: on a wall 60 m out, the
 * shadow of a 0.3 m ledge, which the coarse cascades miss, is darkened by the sun's share of the wall's light; the same
 * ledge's shadow inside a canopy's shadow, which the cascades hold, is left alone (nothing is shadowed twice), and is
 * darkened once the cascades are out of the pass; open wall and sky are untouched.
 */

import { describe, expect, it } from 'vitest';
import * as path from 'path';
import { runWebglPage, webglChromePath } from './helpers/webgl-page';

interface Patch { min: number; max: number; mean: number }
interface Result { underLedge: Patch; underCanopy: Patch; underCanopyWithoutCascades: Patch; openWall: Patch; sky: Patch; darkenedShare: number; cascades: number[] }

describe.skipIf(!webglChromePath)('contact shadows on real WebGL', () => {
    it('darken what the cascades miss, by the sun\'s share, and nothing they already shadow', async () => {
        const r = await runWebglPage<Result>(path.join(__dirname, 'fixtures', 'contact-shadows', 'page.ts'));
        // the sun's share of the wall's light: 3 x cos 45 against a sky fill of 0.5 is 0.81; the ledge's own blocker is a
        // few centimetres up the ray, so nearly all of it goes (less where the coarse map already shades part of the texel)
        expect(r.underLedge.min).toBeLessThan(0.6);
        expect(r.underLedge.min).toBeGreaterThan(0.15);
        // inside the canopy's shadow the second ledge's contact shadow is not drawn: the cascades already shade it ...
        expect(r.underCanopy.min).toBeGreaterThan(0.99);
        // ... and it is the cascades that spare it: without them the same point is darkened
        expect(r.underCanopyWithoutCascades.min).toBeLessThan(0.6);
        expect(r.openWall.min).toBeGreaterThan(0.99);
        expect(r.sky.min).toBe(1);
        // a thin line under the ledge, not a wash over the frame
        expect(r.darkenedShare).toBeGreaterThan(0);
        expect(r.darkenedShare).toBeLessThan(0.02);
        expect(r.cascades).toHaveLength(4);
    }, 90000);
});
