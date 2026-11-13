/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { buildingStorey, fitLattice, inferStructureIntent, mirrorShare, splitStrips, STRUCTURE_INTENT_PARAMS, type IntentFacadeInput } from '../src/node/3d-engine/staged-location/structure-intent';

type Rect = [number, number, number, number];
// a facade 400 x 300 px at 0.1 m a pixel, facing +z, its photo's top at t = 15 m (world y = 15 at row 0)
const frame = (id = 1): IntentFacadeInput['frame'] => ({ centroid: [20, 15, 0], normal: [0, 0, 1], axisS: [1, 0, 0], axisT: [0, 1, 0], orthoSMin: -20, orthoTMax: 0, pixel: 0.1, width: 400, height: 300 });
const grid = (xs: number[], ys: number[], w = 16, h = 20): Rect[] => xs.flatMap(x => ys.map(y => [x - w / 2, y - h / 2, x + w / 2, y + h / 2] as Rect));

describe('structure intent: what the design is, decided region by region', () => {
    it('fits a lattice to positions and says how many sit on it', () => {
        const l = fitLattice([40, 80, 120, 200, 240], 0.2, 3)!;
        expect(l.pitch).toBeCloseTo(40, 3);
        expect(l.share).toBe(1);
        expect([l.first, l.last]).toEqual([0, 5]);
        expect(fitLattice([40, 80], 0.2, 3)).toBeUndefined();
        expect(fitLattice([10, 33, 71, 90, 160], STRUCTURE_INTENT_PARAMS.latticeTol, 3)!.share).toBeLessThan(0.75);
    });

    it('fills the sites a repeating band\'s capture missed, every window at the module', () => {
        // 6 columns at 40 px pitch, 4 rows at 50 px; the photo missed four windows (a smear, an occlusion)
        const all = grid([60, 100, 140, 180, 220, 260], [50, 100, 150, 200]);
        const missed = new Set([3, 8, 13, 21]);
        const read = all.filter((_, i) => !missed.has(i)).map(r => [r[0] + (r[0] % 3) - 1, r[1], r[2], r[3] + (r[1] % 2)] as Rect);
        const it = inferStructureIntent([{ facadeId: 1, frame: frame(), rects: read }]);
        const f = it.facades[0];
        expect(f.regions).toHaveLength(1);
        expect(f.regions[0].decision).toBe('repeat');
        expect(f.regions[0].added).toBe(4);
        expect(f.windows.filter(w => w.source === 'repeat')).toHaveLength(4);
        expect(f.windows).toHaveLength(24);
        // one family, every window the same size: the module
        const ws = new Set(f.windows.map(w => (w.rect[2] - w.rect[0]).toFixed(3))), hs = new Set(f.windows.map(w => (w.rect[3] - w.rect[1]).toFixed(3)));
        expect(ws.size).toBe(1); expect(hs.size).toBe(1);
        for (const k of missed) expect(f.windows.some(w => Math.abs((w.rect[0] + w.rect[2]) / 2 - (all[k][0] + all[k][2]) / 2) < 2 && Math.abs((w.rect[1] + w.rect[3]) / 2 - (all[k][1] + all[k][3]) / 2) < 2)).toBe(true);
    });

    it('mirrors an irregular but symmetric band about its axis, and leaves a band with neither as read', () => {
        // a band of irregular spacing symmetric about x = 200 (one window's partner unread), and above it a band with neither
        const sym: Rect[] = [[40, 200, 60, 230], [95, 200, 120, 230], [190, 200, 210, 230], [340, 200, 360, 230]]; // 280-305 (the partner of 95-120) unread
        const odd: Rect[] = [[30, 40, 44, 60], [120, 40, 170, 90], [300, 40, 320, 52]];
        const f = inferStructureIntent([{ facadeId: 1, frame: frame(), rects: [...sym, ...odd] }]).facades[0];
        const decisions = f.regions.map(r => r.decision);
        expect(decisions).toContain('symmetric');
        expect(decisions).toContain('neither');
        const mirrored = f.windows.filter(w => w.source === 'mirror');
        expect(mirrored).toHaveLength(1);
        expect(mirrored[0].rect[0]).toBeCloseTo(280, 0);
        expect(mirrored[0].rect[2]).toBeCloseTo(305, 0);
        // the irregular band is untouched
        for (const r of odd) expect(f.windows.some(w => w.source === 'measured' && w.rect.every((v, i) => Math.abs(v - r[i]) < 1e-9))).toBe(true);
        expect(mirrorShare(sym, 200, STRUCTURE_INTENT_PARAMS.mirrorIoU)).toBe(0.75);
    });

    it('reads a strip of stacked panes as a column of windows, and a plain strip as one opening', () => {
        const strip: Rect = [100, 20, 120, 280], plain: Rect = [200, 20, 220, 280];
        const small = grid([300, 340], [50, 100]);
        const panes = [60, 110, 160, 210, 260].map(y => [100, y - 18, 120, y + 18] as Rect);
        const out = splitStrips([strip, plain, ...small], panes, STRUCTURE_INTENT_PARAMS);
        expect(out.filter(r => r[0] === 100)).toHaveLength(5);
        expect(out.filter(r => r[0] === 200)).toEqual([plain]);
    });

    it('finds the building\'s storey and puts every agreeing band on its floor lines', () => {
        const st = buildingStorey([{ pitchM: 3.5, phaseY: 1.0, rows: 10 }, { pitchM: 3.55, phaseY: 4.5, rows: 6 }, { pitchM: 7, phaseY: 0, rows: 4 }], 0.08)!;
        expect(st.pitchM).toBeCloseTo(3.52, 1);
        expect(st.bands).toBe(2);
        // two facades on a 50 px (5 m) storey; the second read 6 px off the first's floors: it lands on them
        const a = inferStructureIntent([
            { facadeId: 1, frame: frame(1), rects: grid([60, 100, 140, 180], [50, 100, 150, 200, 250]) },
            { facadeId: 2, frame: frame(2), rects: grid([60, 100, 140, 180], [56, 106, 156, 206, 256]) }
        ]);
        expect(a.storey?.pitchM).toBeCloseTo(5, 1);
        const rowsOf = (k: number) => [...new Set(a.facades[k].windows.map(w => Math.round((w.rect[1] + w.rect[3]) / 2)))].sort((x, y) => x - y);
        expect(rowsOf(0)).toEqual(rowsOf(1));
    });
});
