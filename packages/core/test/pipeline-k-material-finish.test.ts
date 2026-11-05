/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Each appearance class's finish read by the vision model (pipeline-k/material-finish.ts): the reply parsed into numbers
 * per row, and what the ranking ranks toward: the read roughness and metalness at minConf, else the matte dielectric finish.
 * No reading gates a set: every class takes the set the ranking and the pick choose.
 */

import { describe, expect, it } from 'vitest';
import { energyFit, FINISH_READ, finishMaps, finishPrompt, finishTarget, grainOf, parseClassFinish, patternFit } from '../src/node/3d-engine/staged-location/pipeline-k/material-finish';
import { REGION_FINISH } from '../src/node/3d-engine/staged-location/pipeline-k/material-sets';

describe('pipeline K material finish', () => {
    it('parses one finish per row, clamped, and skips rows it cannot read', () => {
        const reply = '```json\n{"classes":[{"row":1,"roughness":0.35,"metalness":0.9,"conf":82,"seen":"anodized aluminium panel"},{"row":2,"roughness":1.4,"metalness":-1,"conf":120},{"row":3,"roughness":"x","metalness":0},{"row":9,"roughness":0.5,"metalness":0,"conf":50}]}\n```';
        const f = parseClassFinish(reply, 3);
        expect(f[0]).toEqual({ roughness: 0.35, metalness: 0.9, conf: 82, seen: 'anodized aluminium panel' });
        expect(f[1]).toEqual({ roughness: 1, metalness: 0, conf: 100 });
        expect(f[2]).toBeUndefined();
        expect(() => parseClassFinish('no json', 3)).toThrow();
    });

    it('ranks toward the read roughness and metalness when confident, else the matte dielectric finish', () => {
        const matte = { roughness: REGION_FINISH.roughness, metallic: REGION_FINISH.metallic };
        expect(finishTarget(undefined, matte)).toEqual(matte);
        expect(finishTarget({ roughness: 0.35, metalness: 0.9, conf: FINISH_READ.minConf }, matte)).toEqual({ roughness: 0.35, metallic: 0.9 });
        expect(finishTarget({ roughness: 0.05, metalness: 0, conf: 95 }, matte)).toEqual({ roughness: 0.05, metallic: 0 });
        expect(finishTarget({ roughness: 0.2, metalness: 1, conf: FINISH_READ.minConf - 1 }, matte)).toEqual(matte);
    });

    it("draws every class's set at its confident read finish: a surface read smooth comes out smooth and nearly flat, its grain kept in proportion", () => {
        // a rough, bumpy set (roughness 0.6-0.9, no metalness, normals tilted about 20 degrees)
        const N = 16, orm = { width: 4, height: 4, rgba: new Uint8Array(N * 4) }, normal = { width: 4, height: 4, rgba: new Uint8Array(N * 4) };
        for (let k = 0; k < N; k++) { orm.rgba.set([230, k % 2 ? 230 : 153, 0, 255], k * 4); normal.rgba.set([k % 2 ? 172 : 84, 128, 240, 255], k * 4); }
        const tilt = (img: typeof normal) => Math.max(...Array.from({ length: N }, (_, k) => Math.abs(img.rgba[k * 4] - 128)));
        // no confident reading: the set as it is
        expect(finishMaps(orm, normal, { roughness: 0.05, metalness: 0, conf: FINISH_READ.minConf - 1 }).orm).toBe(orm);
        // read as smooth reflective glass: roughness about 0.05 with the grain's ratio, a hundredth of the relief, no metalness
        const glass = finishMaps(orm, normal, { roughness: 0.05, metalness: 0, conf: 85 });
        const g = Array.from({ length: N }, (_, k) => glass.orm.rgba[k * 4 + 1] / 255);
        expect(g.reduce((a, b) => a + b, 0) / N).toBeCloseTo(0.05, 2);
        expect(Math.max(...g) / Math.min(...g)).toBeCloseTo(230 / 153, 0);
        expect(tilt(glass.normal)).toBeLessThan(tilt(normal) / 5);
        expect(glass.drawn).toEqual({ roughness: 0.05, metallic: 0, relief: 0.01, grain: 1 });
        expect(glass.orm.rgba[0]).toBe(230);
        // read as painted metal: metalness drawn even where the set had none; a matte read keeps the full relief
        expect(finishMaps(orm, normal, { roughness: 0.4, metalness: 0.8, conf: 70 }).orm.rgba[2]).toBe(204);
        expect(tilt(finishMaps(orm, normal, { roughness: 0.85, metalness: 0, conf: 70 }).normal)).toBeGreaterThanOrEqual(tilt(normal) - 3);
        // a set the pick by appearance did not confirm (grain 0): its finish drawn even, no pattern, flat
        const unconfirmed = finishMaps(orm, normal, { roughness: 0.6, metalness: 0, conf: 80 }, grainOf({ by: 'ranking' }));
        expect(new Set(Array.from({ length: N }, (_, k) => unconfirmed.orm.rgba[k * 4 + 1])).size).toBe(1);
        expect(tilt(unconfirmed.normal)).toBe(0);
        // half confirmed: half the grain; no chooser at all: the whole set
        expect(grainOf({ by: 'appearance', conf: 35 })).toBe(0.5);
        expect(grainOf(undefined)).toBe(1);
        expect(finishMaps(orm, normal, undefined, grainOf(undefined)).orm).toBe(orm);
        // a set's tile larger than the element its class repeats on: its grain in proportion; no element, in full
        expect(patternFit(1, [2, 2])).toBe(0.5);
        expect(patternFit(3, [2, 1])).toBe(1);
        expect(patternFit(undefined, [8, 8])).toBe(1);
        // a set with four times the photo's texture energy (a fence's pattern on a plain panel): half its grain; less energy, all of it
        expect(energyFit([0.01, 0.02, NaN], [0.04, 0.08, 0.5])).toBeCloseTo(0.5, 6);
        expect(energyFit([0.05, 0.05], [0.01, 0.01])).toBe(1);
        expect(energyFit(undefined, [1])).toBe(1);
        // the inputs are not changed
        expect(orm.rgba[1]).toBe(153);
    });

    it('asks for numbers per row, never a material category to route on', () => {
        const p = finishPrompt([{ meanLab: [38, 0, 0], share: 0.2, wall: false }, { meanLab: [70, 1, 2], share: 0.5, wall: true }], { building: 'Penn 2' });
        expect(p).toContain('row 2');
        expect(p).toContain('"roughness"');
        expect(p).toContain('"metalness"');
        expect(p).toContain('A dark colour alone is not metal');
    });
});
