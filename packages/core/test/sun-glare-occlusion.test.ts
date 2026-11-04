/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The sun's glare as a wall's edge crosses the disc, on real WebGL in headless Chrome at 60 Hz: a hidden sun has no glare
 * from the frame it is hidden, a sun coming back out glows again at once, a large change is followed to within
 * VISIBILITY_GLIDE_BAND and small ones glide (an edge jittering over the disc does not flicker the glare), and the probe
 * leaves the sun's cascades fitted to the view.
 */

import { describe, expect, it } from 'vitest';
import * as path from 'path';
import { runWebglPage, webglChromePath } from './helpers/webgl-page';
import { VISIBILITY_GLIDE_BAND, VISIBILITY_HIDDEN } from '../src/browser/generative-canvas/services/atmosphere/SunGlare';

interface Frame { glare: number; shown: number; measured: number }
interface Result { open: Frame[]; covered: Frame[]; reopened: Frame[]; halfOver: Frame[]; jitter: Frame[]; sweep: Frame[]; fittedTo: string[] }

describe.skipIf(!webglChromePath)('sun glare behind a moving edge, on real WebGL', () => {
    it('goes at once when the sun is hidden, follows large changes, glides small ones', async () => {
        const r = await runWebglPage<Result>(path.join(__dirname, 'fixtures', 'sun-glare-occlusion', 'page.ts'));
        const open = r.open[r.open.length - 1].glare;
        expect(open).toBeGreaterThan(0);
        expect(r.open.every(f => f.measured === 1 && f.shown === 1)).toBe(true);
        // the glare drawn is the open sun's times the shown visibility
        for (const f of [...r.halfOver, ...r.sweep]) expect(Math.abs(f.glare - open * f.shown)).toBeLessThan(0.01 * open);

        // behind the wall: no glare from the first frame
        expect(r.covered[0].measured).toBe(0);
        expect(r.covered.every(f => f.shown === 0 && f.glare === 0)).toBe(true);
        // out again: back to within the band at once, then the rest of the way
        expect(r.reopened[0].shown).toBeGreaterThanOrEqual(1 - VISIBILITY_GLIDE_BAND - 1e-3);
        expect(r.reopened[r.reopened.length - 1].shown).toBeGreaterThan(0.99);

        // half over: the band's edge at once (less that frame's own step of the glide), then a glide to the measure
        const half = r.halfOver[0].measured;
        expect(Math.abs(half - 0.5)).toBeLessThan(0.05);
        expect(r.halfOver[0].shown).toBeLessThanOrEqual(half + VISIBILITY_GLIDE_BAND + 1e-3);
        expect(r.halfOver[0].shown).toBeGreaterThan(half + 0.85 * VISIBILITY_GLIDE_BAND);
        expect(Math.abs(r.halfOver[r.halfOver.length - 1].shown - half)).toBeLessThan(0.01);

        // an edge jittering over the disc: the measure swings, the glare barely moves
        const swing = (fs: Frame[], k: keyof Frame) => Math.max(...fs.slice(1).map((f, i) => Math.abs(f[k] - fs[i][k])));
        expect(swing(r.jitter, 'measured')).toBeGreaterThan(0.04);
        expect(swing(r.jitter, 'shown')).toBeLessThan(0.01);

        // sweeping across in 12 frames: never more than the band behind, and none the frame the sun is hidden
        for (const f of r.sweep) expect(Math.abs(f.shown - f.measured)).toBeLessThanOrEqual(VISIBILITY_GLIDE_BAND + 1e-3);
        const hidden = r.sweep.findIndex(f => f.measured <= VISIBILITY_HIDDEN);
        expect(hidden).toBeGreaterThan(0);
        expect(r.sweep.slice(hidden).every(f => f.shown === 0 && f.glare === 0)).toBe(true);

        // the probe draws no shadow maps: the cascades are only ever fitted to the view
        expect(r.fittedTo).toEqual(['view']);
    }, 90000);
});
