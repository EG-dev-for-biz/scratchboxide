/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { inferStructureIntent, type IntentFacadeInput } from '../src/node/3d-engine/staged-location/structure-intent';
import { buildMaterialPlan } from '../src/node/3d-engine/staged-location/material-plan';
import { infillFacade, INFILL_SOURCE } from '../src/node/3d-engine/staged-location/material-infill';

type Rect = [number, number, number, number];

describe('material infill: a hole takes its own element\'s material', () => {
    // a facade 400 x 300 px at 0.1 m a pixel: light stone, 6 x 4 dark windows; the photo missed one window and the wall around it
    const W = 400, H = 300;
    const frame: IntentFacadeInput['frame'] = { centroid: [20, 15, 0], normal: [0, 0, 1], axisS: [1, 0, 0], axisT: [0, 1, 0], orthoSMin: -20, orthoTMax: 0, pixel: 0.1, width: W, height: H };
    const xs = [60, 100, 140, 180, 220, 260], ys = [50, 100, 150, 200];
    const all: Rect[] = xs.flatMap(x => ys.map(y => [x - 8, y - 10, x + 8, y + 10] as Rect));
    const hidden = all.find(r => r[0] === 132 && r[1] === 90)!;
    const rgba = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4, glass = all.some(r => x >= r[0] + 1 && x < r[2] - 1 && y >= r[1] + 1 && y < r[3] - 1), v = (x * 7 + y * 13) % 9;
        rgba[i] = (glass ? 40 : 200) + v; rgba[i + 1] = (glass ? 50 : 190) + v; rgba[i + 2] = (glass ? 60 : 170) + v; rgba[i + 3] = 255;
    }
    const hole = new Uint8Array(W * H);
    for (let y = 80; y < 122; y++) for (let x = 120; x < 162; x++) hole[y * W + x] = 1;
    const valid = Uint8Array.from(hole, v => (v ? 0 : 1));
    const photo = { rgba, width: W, height: H, valid };
    const intent = inferStructureIntent([{ facadeId: 1, frame, rects: all.filter(r => r !== hidden) }]);
    const { plan } = buildMaterialPlan(intent, [{ facadeId: 1, frame, photo }]);
    const fi = intent.facades[0];

    it('lays the missed window from its siblings and the wall from the wall, nothing bleeding across', () => {
        expect(fi.windows.some(w => Math.abs((w.rect[0] + w.rect[2]) / 2 - 140) < 3 && Math.abs((w.rect[1] + w.rect[3]) / 2 - 100) < 3 && w.source !== 'measured')).toBe(true);
        const r = infillFacade(fi, frame, photo, hole, plan, new Map());
        expect(r.stats.holes).toBe(42 * 42);
        expect(r.stats.left).toBe(0);
        expect(r.stats.peer).toBeGreaterThan(200);
        const at = (x: number, y: number) => r.rgba[(y * W + x) * 4];
        // the hidden window's middle is glass, copied from a sibling; the wall beside it is stone
        expect(at(140, 100)).toBeLessThan(60);
        expect(r.source[100 * W + 140]).toBe(INFILL_SOURCE.peer);
        expect(at(124, 84)).toBeGreaterThan(180);
        expect(at(158, 118)).toBeGreaterThan(180);
        // a real texel is never rewritten
        for (const i of [0, 50 * W + 60, 299 * W + 399]) { expect(r.source[i]).toBe(INFILL_SOURCE.real); expect(r.rgba[i * 4]).toBe(rgba[i * 4]); }
    });

    it('fills only the texels asked for, and never copies from a hole', () => {
        const only = new Uint8Array(W * H); for (let y = 95; y < 105; y++) for (let x = 135; x < 145; x++) only[y * W + x] = 1;
        const r = infillFacade(fi, frame, photo, hole, plan, new Map(), undefined, undefined, { only });
        expect(r.stats.holes).toBe(100);
        expect(r.source[81 * W + 121]).toBe(INFILL_SOURCE.real);
        expect(r.rgba[(100 * W + 140) * 4]).toBeLessThan(60);
    });
});
