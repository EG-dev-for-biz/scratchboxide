/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { buildMaterialPlan, rgbToLab } from '../src/node/3d-engine/staged-location/material-plan';
import { inferStructureIntent, type IntentFacadeInput } from '../src/node/3d-engine/staged-location/structure-intent';

type Rect = [number, number, number, number];
const frame = (id: number): IntentFacadeInput['frame'] => ({ centroid: [20 + 50 * id, 15, 0], normal: [0, 0, 1], axisS: [1, 0, 0], axisT: [0, 1, 0], orthoSMin: -20, orthoTMax: 0, pixel: 0.1, width: 400, height: 300 });
const grid = (xs: number[], ys: number[]): Rect[] => xs.flatMap(x => ys.map(y => [x - 10, y - 12, x + 10, y + 12] as Rect));

describe('material plan: one material per element, read from the photo', () => {
    it('reads stone walls and dark glass as two materials, lit and shaded stone as one, and cuts exemplars of each', () => {
        const rects = grid([40, 80, 120, 160, 200, 240, 280, 320, 360], [40, 90, 140, 190, 240]);
        // two facades of one stone (warm grey), one in sun and one in shade (darker, same hue); dark bluish glass in every window, a smear on one wall
        const photoOf = (lit: number) => {
            const W = 400, H = 300, rgba = new Uint8Array(W * H * 4), valid = new Uint8Array(W * H).fill(1), featureless = new Uint8Array(W * H);
            for (let i = 0; i < W * H; i++) { const n = ((i * 2654435761) >>> 0) % 13 - 6; rgba.set([Math.round((180 + n) * lit), Math.round((165 + n) * lit), Math.round((150 + n) * lit), 255], 4 * i); }
            for (const r of rects) for (let y = r[1] + 1; y < r[3] - 1; y++) for (let x = r[0] + 1; x < r[2] - 1; x++) rgba.set([40, 48, 62, 255], 4 * (y * W + x));
            for (let y = 250; y < 300; y++) for (let x = 0; x < 60; x++) featureless[y * W + x] = 1;
            return { rgba, width: W, height: H, valid, featureless };
        };
        const facades = [0, 1].map(id => ({ facadeId: id, frame: frame(id), rects, period: { m: 4, ncc: 0.9 } }));
        const intent = inferStructureIntent(facades);
        const { plan, atlas } = buildMaterialPlan(intent, facades.map((f, k) => ({ facadeId: f.facadeId, frame: f.frame, photo: photoOf(k ? 0.6 : 1) })));
        const walls = plan.materials.filter(m => m.role === 'wall'), glass = plan.materials.filter(m => m.role === 'glass');
        // the shaded facade's stone is the same material as the sunlit one's
        expect(walls).toHaveLength(1);
        expect(glass).toHaveLength(1);
        const [wl, ga, gb] = walls[0].colour!.lab, gl = glass[0].colour!.lab;
        expect(gl[0]).toBeLessThan(wl - 20);
        // glass reads cool (b below the stone's), stone warm
        expect(gl[2]).toBeLessThan(gb);
        expect(ga).toBeGreaterThan(-5);
        // exemplars: from both facades, clean (the smear left out), cut into the atlas
        expect(walls[0].exemplars.length).toBeGreaterThanOrEqual(4);
        expect(new Set(walls[0].exemplars.map(e => e.facadeId)).size).toBe(2);
        for (const e of walls[0].exemplars) expect(e.rect[1] >= 250 && e.rect[0] < 60).toBe(false);
        expect(atlas!.rgb.length).toBe(atlas!.width * atlas!.height * 3);
        // every element of both facades names its material
        expect(plan.facades.flatMap(f => f.elements).every(e => e.material > 0)).toBe(true);
        expect(rgbToLab(255, 255, 255)[0]).toBeCloseTo(100, 0);
    });

    it('takes pipeline K\'s finish from the class on the same side of the window openings', () => {
        const rects = grid([40, 80, 120, 160, 200], [40, 90, 140]);
        const W = 400, H = 300, rgba = new Uint8Array(W * H * 4).fill(255), valid = new Uint8Array(W * H).fill(1);
        for (let i = 0; i < W * H; i++) rgba.set([170, 160, 150, 255], 4 * i);
        for (const r of rects) for (let y = r[1]; y < r[3]; y++) for (let x = r[0]; x < r[2]; x++) rgba.set([50, 52, 58, 255], 4 * (y * W + x));
        const f = { facadeId: 0, frame: frame(0), rects };
        const intent = inferStructureIntent([f]);
        const stone = rgbToLab(170, 160, 150), pane = rgbToLab(50, 52, 58);
        const { plan } = buildMaterialPlan(intent, [{ facadeId: 0, frame: f.frame, photo: { rgba, width: W, height: H, valid } }], { kClasses: [
            { meanLab: [...stone], openings: false, set: 'StoneSet', finish: { read: { roughness: 0.7, metalness: 0, conf: 80 } } },
            // a dark class outside the openings, nearer the glass's colour than the pane class is: never the glass's finish
            { meanLab: [pane[0] + 1, pane[1], pane[2]], openings: false, set: 'DarkStone', finish: { read: { roughness: 0.8, metalness: 0, conf: 70 } } },
            { meanLab: [pane[0] + 4, pane[1], pane[2]], openings: true, set: 'PaneSet', finish: { read: { roughness: 0.05, metalness: 0, conf: 85 } } }
        ] });
        expect(plan.materials.find(m => m.role === 'wall')!.finish).toMatchObject({ roughness: 0.7, kSet: 'StoneSet' });
        expect(plan.materials.find(m => m.role === 'glass')!.finish).toMatchObject({ roughness: 0.05, kSet: 'PaneSet' });
    });
});
