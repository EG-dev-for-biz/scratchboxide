/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Window scoring against a checked set: pixel IoU, precision and recall, windows found and correct, and edge error in
 * pixels, with edges on the crop's border left out; and every checked set in the fixtures is well formed.
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { fittedInCrop, scoreTotals, scoreWindows, type CheckedSet, type WindowRect } from '../src/node/3d-engine/staged-location/window-score';

describe('window scoring', () => {
    const checked: WindowRect[] = [[10, 10, 30, 50], [40, 10, 60, 50]];

    it('scores an exact fit as perfect, with no edge error', () => {
        const s = scoreWindows(checked, checked, 100, 100);
        expect(s.pixel).toMatchObject({ iou: 1, precision: 1, recall: 1 });
        expect([s.found, s.correct]).toEqual([2, 2]);
        expect(s.edges.meanPx).toBe(0);
        expect(s.edges.n).toBe(8);
    });

    it('measures each edge offset in pixels, per side', () => {
        const fitted: WindowRect[] = [[12, 10, 30, 53], [40, 9, 60, 50]];
        const s = scoreWindows(fitted, checked, 100, 100);
        expect(s.pairs.map(p => p.offsetPx)).toEqual([[2, 0, 0, 3], [0, -1, 0, 0]]);
        expect(s.edges.bySide.left.maxPx).toBe(2);
        expect(s.edges.bySide.bottom.maxPx).toBe(3);
        expect(s.edges.maxPx).toBe(3);
    });

    it("counts a strip over two windows as finding both; it pairs with one, its far edge off by the other's width; pixel precision shows the mullion", () => {
        const s = scoreWindows([[10, 10, 60, 50]], checked, 100, 100);
        expect(s.found).toBe(2);
        expect(s.correct).toBe(1);
        expect(s.pairs.map(p => p.offsetPx)).toEqual([[0, 0, 30, 0]]);
        // the 10 px mullion between the windows is fitted but not window
        expect(s.pixel.precision).toBeCloseTo(40 / 50, 6);
        expect(s.pixel.recall).toBe(1);
    });

    it('leaves out a checked edge on the crop border (the window runs on past the crop)', () => {
        const column: WindowRect[] = [[10, 0, 30, 100]];
        const s = scoreWindows([[11, -20, 30, 140]], column, 100, 100);
        // the top and bottom are the crop's, not the window's: only the left (1 px) and right (0) are scored
        expect(s.edges.n).toBe(2);
        expect(s.pairs[0].offsetPx.filter(Number.isNaN)).toHaveLength(2);
    });

    it('scores missing and false windows, and pools totals over crops by pixels', () => {
        const a = scoreWindows([[10, 10, 30, 50], [70, 70, 90, 90]], checked, 100, 100);
        expect([a.found, a.checked, a.correct, a.fitted]).toEqual([1, 2, 1, 2]);
        const b = scoreWindows(checked, checked, 100, 100);
        const t = scoreTotals([a, b]);
        expect([t.found, t.checked, t.correct, t.fitted]).toEqual([3, 4, 3, 4]);
        // pooled over pixels: 800 + 1600 window pixels hit, of 1200 + 1600 fitted and 1600 + 1600 checked
        expect(t.pixel.precision).toBeCloseTo(2400 / 2800, 6);
        expect(t.pixel.recall).toBeCloseTo(2400 / 3200, 6);
    });

    it('moves photo-pixel windows into a checked crop', () => {
        const set: CheckedSet = { facadeId: 1, crop: [100, 400, 50, 350], pixel: 0.077, windows: [] };
        expect(fittedInCrop([[110, 60, 130, 100]], set)).toEqual([[10, 10, 30, 50]]);
    });

    it('keeps every checked set in the fixtures well formed: windows inside their crop, a texel, a note', () => {
        const dir = path.join(__dirname, 'fixtures/window-checked');
        const files = fs.readdirSync(dir).filter(n => n.endsWith('.json'));
        expect(files.length).toBeGreaterThanOrEqual(5);
        for (const n of files) {
            const set = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')) as CheckedSet;
            const [x0, x1, y0, y1] = set.crop;
            expect(x1).toBeGreaterThan(x0);
            expect(y1).toBeGreaterThan(y0);
            expect(set.pixel).toBeGreaterThan(0);
            expect(set.windows.length).toBeGreaterThan(0);
            for (const w of set.windows) {
                expect(w[0]).toBeGreaterThanOrEqual(0); expect(w[1]).toBeGreaterThanOrEqual(0);
                expect(w[2]).toBeLessThanOrEqual(x1 - x0); expect(w[3]).toBeLessThanOrEqual(y1 - y0);
                expect(w[2]).toBeGreaterThan(w[0]); expect(w[3]).toBeGreaterThan(w[1]);
            }
        }
    });
});
