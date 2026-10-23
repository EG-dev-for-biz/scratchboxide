/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline G's check (pipeline-g/check.ts): a plate of a 15 m x 12 m wall with dark arched windows 1.2 m wide every 3 m on
 * three storeys and a cornice band, a few cm of noise, the top metre unseen. Its true reading explains most of the plate's
 * light and dark and passes; the same reading displaced by half a bay explains far less, an empty one nothing, a reading
 * with half its windows in the wrong row is weak; arches are drawn as arches.
 */

import { describe, expect, it } from 'vitest';
import { checkReading, checkWall, labelRaster, programShapes, type CheckPlate } from '../src/node/3d-engine/staged-location/pipeline-g/check';
import type { FacadeProgram } from '../src/node/3d-engine/staged-location/pipeline-g/read';

const PX = 0.05, WM = 15, HM = 12, W = WM / PX, H = HM / PX;
const isWindow = (u: number, h: number) => {
    const uu = u % 3, row = Math.floor(h / 3.5), hh = h - row * 3.5;
    if (row > 2 || uu < 0.9 || uu > 2.1 || hh < 1 || hh > 3) return false;
    // a round arch springing at 2.4 m
    return hh <= 2.4 || (uu - 1.5) ** 2 + (hh - 2.4) ** 2 <= 0.6 ** 2;
};

function plate(): CheckPlate {
    const rgb = new Uint8Array(W * H * 3), seen = new Uint8Array(W * H);
    let seed = 7;
    const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 30;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const u = (x + 0.5) * PX, h = HM - (y + 0.5) * PX, i = y * W + x;
        if (h > HM - 1) { rgb.set([128, 128, 128], i * 3); continue; }
        const band = h > 10.4 && h < 10.8;
        const v = Math.max(0, Math.min(255, (isWindow(u, h) ? 45 : band ? 235 : 190) + noise()));
        rgb.set([v, v, v * 0.95], i * 3);
        seen[i] = 1;
    }
    return { w: W, h: H, rgb, seen };
}

const truth: FacadeProgram = {
    openings: [0, 1, 2].map(r => ({ h0: r * 3.5 + 1, h1: r * 3.5 + 3, archRise: 0.6, cols: [0, 1, 2, 3, 4].map(k => [k * 3 + 0.9, k * 3 + 2.1]) })),
    horizontal: [{ h: 10.6, u0: 0, u1: 15, profile: [[-0.2, 0], [0, 0.3], [0.2, 0]] }]
};
const shift = (p: FacadeProgram, du: number, dh: number): FacadeProgram => ({
    openings: p.openings!.map(r => ({ ...r, h0: r.h0 + dh, h1: r.h1 + dh, cols: r.cols!.map(([a, b]) => [a + du, b + du]) })),
    horizontal: p.horizontal!.map(b => ({ ...b, h: b.h + dh, u0: b.u0 + du, u1: b.u1 + du }))
});

describe('pipeline G check', () => {
    it('draws a reading as shapes in the plate frame, arches as arches', () => {
        const shapes = programShapes(truth);
        expect(shapes.filter(s => s.kind === 'opening')).toHaveLength(15);
        expect(shapes.filter(s => s.kind === 'member')).toHaveLength(1);
        const lab = labelRaster(W, H, shapes);
        const at = (u: number, h: number) => lab[Math.floor((HM - h) / PX) * W + Math.floor(u / PX)];
        expect(at(1.5, 2)).toBe(2);           // inside a window
        expect(at(1.5, 2.95)).toBe(2);        // the arch's crown
        expect(at(0.95, 2.95)).toBe(0);       // the spandrel beside the crown
        expect(at(5, 10.6)).toBe(1);          // the band
    });

    it('passes the true reading and scores it far above its displaced copy and an empty reading', () => {
        const p = plate();
        const good = checkReading(p, truth);
        expect(good.weak).toBe(false);
        expect(good.explained).toBeGreaterThan(0.6);
        expect(good.lift).toBeGreaterThan(3);
        expect(good.openingContrast).toBeGreaterThan(3);
        const displaced = checkWall(p, programShapes(shift(truth, 1.5, 0)));
        expect(displaced.explained).toBeLessThan(good.explained / 3);
        expect(displaced.openingContrast).toBeLessThan(0);
        const empty = checkReading(p, {});
        expect(empty.explained).toBe(0);
        expect(empty.weak).toBe(true);
    });

    it('flags a reading with its rows a storey out of place as weak', () => {
        const wrong = checkReading(plate(), shift(truth, 0, 1.75));
        expect(wrong.weak).toBe(true);
        expect(wrong.explained).toBeLessThan(0.05);
    });

    it('ignores what no station saw', () => {
        const p = plate();
        // windows read into the unseen top metre change nothing
        const extra: FacadeProgram = { ...truth, openings: [...truth.openings!, { h0: 11.2, h1: 11.9, cols: [[1, 2], [4, 5]] }] };
        expect(checkWall(p, programShapes(extra)).explained).toBeCloseTo(checkWall(p, programShapes(truth)).explained, 3);
    });
});
