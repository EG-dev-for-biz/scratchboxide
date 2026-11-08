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
import { agreeMetal, matchGlazing, settleFinishes, drawFinish, drawnMetalness, drawnRoughness, energyFit, FINISH_READ, finishMaps, finishPrompt, finishTarget, grainOf, parseClassFinish, patternFit } from '../src/node/3d-engine/staged-location/pipeline-k/material-finish';
import { ARTIST_FINISH, PBR_REFERENCE } from '../src/common/spatial/pbr-artist-reference';
import { REGION_FINISH } from '../src/node/3d-engine/staged-location/pipeline-k/material-sets';

describe('pipeline K material finish', () => {
    it('parses one finish per row, clamped, and skips rows it cannot read', () => {
        const reply = '```json\n{"classes":[{"row":1,"roughness":0.35,"metalness":0.9,"conf":82,"seen":"anodized aluminium panel"},{"row":2,"roughness":1.4,"metalness":-1,"conf":120},{"row":3,"roughness":"x","metalness":0},{"row":9,"roughness":0.5,"metalness":0,"conf":50}]}\n```';
        const f = parseClassFinish(reply, 3);
        expect(f[0]).toEqual({ roughness: 0.35, metalness: 0.9, conf: 82, seen: 'anodized aluminium panel' });
        expect(f[1]).toEqual({ roughness: 1, metalness: 0, conf: 100 });
        expect(f[2]).toBeUndefined();
        expect(() => parseClassFinish('no json', 3)).toThrow();
        // a roughness outside the range of the reference finish it named is held to that range, the read kept beside it
        const steel = PBR_REFERENCE.findIndex(e => /stainless/.test(e.look)) + 1;
        const held = parseClassFinish(`{"classes":[{"row":1,"ref":${steel},"roughness":0.1,"metalness":0,"conf":80},{"row":2,"ref":0,"roughness":0.1,"metalness":0,"conf":80}]}`, 2);
        expect(held[0]).toMatchObject({ roughness: 0.25, readRoughness: 0.1, ref: steel });
        expect(held[1]).toEqual({ roughness: 0.1, metalness: 0, conf: 80 });
    });

    it('ranks toward the read roughness and metalness when confident, else the matte dielectric finish', () => {
        const matte = { roughness: REGION_FINISH.roughness, metallic: REGION_FINISH.metallic };
        expect(finishTarget(undefined, matte)).toEqual(matte);
        expect(finishTarget({ roughness: 0.35, metalness: 0.9, conf: 80 }, matte)).toEqual({ roughness: 0.35, metallic: 1 });
        // a metal read short of the metal confidence ranks toward a dielectric; a glass read toward main's glass setting
        expect(finishTarget({ roughness: 0.35, metalness: 0.9, conf: FINISH_READ.minConf }, matte)).toEqual({ roughness: 0.35, metallic: 0 });
        expect(finishTarget({ roughness: 0.05, metalness: 0, conf: 95 }, matte)).toEqual({ roughness: 0.08, metallic: 0 });
        expect(finishTarget({ roughness: 0.2, metalness: 1, conf: FINISH_READ.minConf - 1 }, matte)).toEqual(matte);
    });

    it("draws every class's set at its confident read finish: a surface read smooth comes out smooth and nearly flat, its grain kept in proportion", () => {
        // a rough, bumpy set (roughness 0.6-0.9, no metalness, normals tilted about 20 degrees)
        const N = 16, orm = { width: 4, height: 4, rgba: new Uint8Array(N * 4) }, normal = { width: 4, height: 4, rgba: new Uint8Array(N * 4) };
        for (let k = 0; k < N; k++) { orm.rgba.set([230, k % 2 ? 230 : 153, 0, 255], k * 4); normal.rgba.set([k % 2 ? 172 : 84, 128, 240, 255], k * 4); }
        const tilt = (img: typeof normal) => Math.max(...Array.from({ length: N }, (_, k) => Math.abs(img.rgba[k * 4] - 128)));
        // no confident reading: the set as it is
        expect(finishMaps(orm, normal, { roughness: 0.05, metalness: 0, conf: FINISH_READ.minConf - 1 }).orm).toBe(orm);
        // no confident reading on a metal set: its roughness kept, its metalness never drawn (nothing is metal on a set's say-so)
        const metalSet = { ...orm, rgba: orm.rgba.map((v, i) => (i % 4 === 2 ? 204 : v)) };
        const unsure = finishMaps(metalSet, normal, { roughness: 0.3, metalness: 0.9, conf: FINISH_READ.minConf - 1 });
        expect(Array.from({ length: N }, (_, k) => unsure.orm.rgba[k * 4 + 2])).toEqual(new Array(N).fill(0));
        expect(Array.from({ length: N }, (_, k) => unsure.orm.rgba[k * 4 + 1])).toEqual(Array.from({ length: N }, (_, k) => orm.rgba[k * 4 + 1]));
        expect(unsure.drawn).toMatchObject({ metallic: 0 });
        expect(finishMaps(metalSet, normal, undefined).drawn).toMatchObject({ metallic: 0 });
        // read as smooth reflective glass (0.15): drawn as main drew glass (0.08) with the grain's ratio, a tenth of the relief, no metalness
        const glass = finishMaps(orm, normal, { roughness: 0.15, metalness: 0, conf: 85 });
        const g = Array.from({ length: N }, (_, k) => glass.orm.rgba[k * 4 + 1] / 255);
        expect(g.reduce((a, b) => a + b, 0) / N).toBeCloseTo(0.08, 2);
        // the expert's draw: a glass read at main's glass setting, every other read as read (no squaring: 0.4 stays 0.4)
        expect([drawnRoughness(0.19), drawnRoughness(0.05), drawnRoughness(0.2), drawnRoughness(0.3), drawnRoughness(0.4), drawnRoughness(0.8)]).toEqual([0.08, 0.08, 0.2, 0.3, 0.4, 0.8]);
        // metalness 0 or 1: a hedged read is a dielectric, a metal read only when sure and covering most of the class
        expect([0.1, 0.3, 0.49].map(m => drawnMetalness({ metalness: m, conf: 90 }))).toEqual([0, 0, 0]);
        expect(drawnMetalness({ metalness: 0.8, conf: 80 })).toBe(1);
        expect(drawnMetalness({ metalness: 0.8, conf: 65 })).toBe(0);
        expect(drawnMetalness({ metalness: 0.8, conf: 80, coverage: 0.4 })).toBe(0);
        expect(drawnMetalness({ metalness: 0.8, conf: 80, coverage: 0.7 })).toBe(1);
        // the set's roughness pattern is drawn as far as its relief (9% here): a smooth surface is even, not figured
        expect(Math.max(...g) - Math.min(...g)).toBeLessThan(0.01);
        // a matte read keeps the set's pattern whole
        const matte = finishMaps(orm, normal, { roughness: 0.75, metalness: 0, conf: 85 });
        expect(matte.orm.rgba[5] / matte.orm.rgba[1]).toBeCloseTo(230 / 153, 1);
        expect(tilt(glass.normal)).toBeLessThan(tilt(normal) / 5);
        expect(glass.drawn).toEqual({ roughness: 0.08, metallic: 0, relief: 0.09, grain: 1 });
        expect(glass.orm.rgba[0]).toBe(230);
        // an occlusion map with a figure in it (road markings) is drawn even on a smooth read too
        const figured = { ...orm, rgba: orm.rgba.map((v, i) => (i % 4 === 0 ? (i % 8 ? 255 : 120) : v)) };
        const drawnAo = finishMaps(figured, normal, { roughness: 0.1, metalness: 0, conf: 90 }).orm;
        expect(Math.abs(drawnAo.rgba[0] - drawnAo.rgba[4])).toBeLessThan(8);
        // read as bare metal: metalness 1 even where the set had none; a hedged 0.1 is none; a matte read keeps the full relief
        expect(finishMaps(orm, normal, { roughness: 0.4, metalness: 0.8, conf: 70 }).orm.rgba[2]).toBe(255);
        expect(finishMaps(orm, normal, { roughness: 0.15, metalness: 0.1, conf: 70 }).orm.rgba[2]).toBe(0);
        // the expert's grain caps the set's: a read of a smooth panel (grain 0.2) draws a fifth of the pattern
        const smoothPanel = finishMaps(orm, normal, { roughness: 0.75, metalness: 0, conf: 85, grain: 0.2 });
        expect(smoothPanel.drawn?.grain).toBe(0.2);
        expect(tilt(smoothPanel.normal)).toBeLessThan(tilt(normal) / 3);
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

    it('draws a class inside the window openings as the pane that closes them when no reading is confident, and asks about the pane', () => {
        // no reading, or an unsure one: the opening prior inside the openings, the set's own outside them
        expect(drawFinish(undefined, true)).toEqual({ finish: { roughness: 0.08, metalness: 0, conf: FINISH_READ.minConf }, prior: true });
        expect(drawFinish({ roughness: 0.6, metalness: 0, conf: FINISH_READ.minConf - 1 }, true).prior).toBe(true);
        expect(drawFinish(undefined, false)).toEqual({ prior: false });
        // a confident reading stands, inside the openings too (an opaque infill read rough)
        const infill = { roughness: 0.7, metalness: 0, conf: 80 };
        expect(drawFinish(infill, true)).toEqual({ finish: infill, prior: false });
        // the prompt asks for the pane's finish on the openings' rows only when there are any
        const rows = [{ meanLab: [70, 0, 0] as [number, number, number], share: 0.8, wall: true }, { meanLab: [40, 0, 0] as [number, number, number], share: 0.2, wall: false, openings: true }];
        expect(finishPrompt(rows)).toMatch(/row 2: .*inside the window openings/);
        expect(finishPrompt(rows)).toMatch(/finish of that pane itself/);
        expect(finishPrompt(rows.slice(0, 1))).not.toMatch(/pane itself/);
    });

    it("draws no metal on a class whose colour the building mostly reads dielectric: it is that material in shade; a building that mostly reads metal keeps it", () => {
        const cls = (L: number, a: number, b: number, share: number, openings = false) => ({ meanLab: [L, a, b] as [number, number, number], share, openings });
        // the Empire State Building's classes: the darkest read cast aluminium (it also holds the limestone in shadow), three read limestone
        const esb = [cls(41.08, 0.94, 0.5, 0.202), cls(50.49, 1.7, 1.44, 0.246), cls(60.88, 2.34, 3.11, 0.23), cls(72.81, 2.73, 5.85, 0.126), cls(39.59, 1.02, 0.27, 0.101, true)];
        const esbRead = [{ roughness: 0.45, metalness: 0.8, conf: 75, seen: 'cast aluminum spandrel panels' }, { roughness: 0.7, metalness: 0, conf: 85 }, { roughness: 0.75, metalness: 0, conf: 90 }, { roughness: 0.7, metalness: 0, conf: 90 }, { roughness: 0.05, metalness: 0, conf: 85 }];
        const settled = settleFinishes(esb, esbRead);
        // the dark class takes the shaded limestone's finish (its nearest in lightness), its own words and confidence kept
        expect(settled[0]).toEqual({ roughness: 0.7, metalness: 0, conf: 75, seen: 'cast aluminum spandrel panels', shadeOf: 1 });
        expect(settled.slice(1)).toEqual(esbRead.slice(1));
        // Penn 2: three classes read metal hold most of the surface, one reads a smooth dielectric: the metal stands
        const penn = [cls(37.41, 0.85, -0.3, 0.137), cls(44.43, 0.97, -0.19, 0.24), cls(51.67, 1.21, 0.38, 0.442), cls(64.09, 1.37, 1.03, 0.137)];
        const pennRead = [{ roughness: 0.5, metalness: 0.8, conf: 75 }, { roughness: 0.45, metalness: 0.8, conf: 80 }, { roughness: 0.5, metalness: 0.7, conf: 80 }, { roughness: 0.3, metalness: 0.2, conf: 65 }];
        expect(settleFinishes(penn, pennRead)).toEqual(pennRead);
        // a metal of another colour than the wall (a copper roof beside limestone: far in a, b) stands; an unsure dielectric read does not outvote it
        expect(settleFinishes([cls(45, 14, 22, 0.1), cls(70, 2, 5, 0.9)], [{ roughness: 0.4, metalness: 0.9, conf: 80 }, { roughness: 0.7, metalness: 0, conf: 90 }])[0]!.metalness).toBe(0.9);
        expect(settleFinishes([cls(41, 1, 0.5, 0.2), cls(50, 1.7, 1.4, 0.8)], [{ roughness: 0.4, metalness: 0.9, conf: 80 }, { roughness: 0.7, metalness: 0, conf: 30 }])[0]!.metalness).toBe(0.9);
        // a metal read settled against a glass twin keeps its own roughness: it is not glass, only not metal
        const glassy = settleFinishes([cls(41, 1, 0.5, 0.3), cls(60, 1.5, 1.2, 0.14)], [{ roughness: 0.1, metalness: 0, conf: 80 }, { roughness: 0.25, metalness: 1, conf: 80 }]);
        expect(glassy[1]).toMatchObject({ roughness: 0.25, metalness: 0, shadeOf: 0 });
        // an opening class is settled among the opening classes only
        expect(settleFinishes([cls(41, 1, 0.5, 0.1, true), cls(50, 1.7, 1.4, 0.9)], [{ roughness: 0.4, metalness: 0.9, conf: 80 }, { roughness: 0.7, metalness: 0, conf: 90 }])[0]!.metalness).toBe(0.9);
    });

    it('draws bare metal only where the pick by look agrees: two expert looks, the dielectric when they differ', () => {
        const metal = { roughness: 0.45, metalness: 1, conf: 80, coverage: 0.8 };
        expect(agreeMetal(metal, 0)).toEqual({ ...metal, metalness: 0, metalVetoed: true });
        expect(agreeMetal(metal, 1)).toBe(metal);
        expect(agreeMetal(metal, undefined)).toBe(metal);
        // a reading not drawn metal anyway is left alone
        const stone = { roughness: 0.75, metalness: 0.3, conf: 80 };
        expect(agreeMetal(stone, 0)).toBe(stone);
        expect(drawnMetalness(agreeMetal(metal, 0)!)).toBe(0);
    });

    it("draws an outside class the colour of the window openings as a frame, never as stone, and keeps its reading's words", () => {
        // the ESB's classes: three limestone-coloured outside classes, a dark outside class the glazing's colour, the glazing inside the openings
        const classes = [{ meanLab: [40.1, 1.09, 0.36] as [number, number, number] }, { meanLab: [49.1, 1.55, 1.41] as [number, number, number] }, { meanLab: [70.3, 3.04, 5.86] as [number, number, number] }, { meanLab: [41.6, 1.03, 0.54] as [number, number, number], openings: true }];
        const stone = { roughness: 0.82, metalness: 0, conf: 80, seen: 'shaded weathered limestone', ref: 5 };
        const out = matchGlazing(classes, [stone, { ...stone, roughness: 0.8 }, { ...stone, roughness: 0.75 }, { roughness: 0.08, metalness: 0, conf: 90 }]);
        expect(out[0]).toMatchObject({ roughness: ARTIST_FINISH.frameRoughness, metalness: 0, glazingOf: 3, seen: 'shaded weathered limestone', readRoughness: 0.82 });
        expect(out[1]).toBe(out[1]);
        expect(out[1]!.glazingOf).toBeUndefined();
        expect(out[2]!.glazingOf).toBeUndefined();
        expect(out[3]!.roughness).toBe(0.08);
        // a reading of paint or metal the glazing's colour stands (the Seagram's bronze): only a stone reading is turned
        const bronze = PBR_REFERENCE.findIndex(e => /bronze or brass/.test(e.look)) + 1;
        expect(matchGlazing(classes, [{ roughness: 0.55, metalness: 1, conf: 85, ref: bronze }, stone, stone, { roughness: 0.08, metalness: 0, conf: 90 }])[0]!.glazingOf).toBeUndefined();
        // only the darkest opening class (the glazing) is matched: a lighter one (frames, reflections) the colour of weathered stone is not
        const two = [...classes.slice(0, 3), classes[3], { meanLab: [49.5, 1.5, 1.5] as [number, number, number], openings: true }];
        const m2 = matchGlazing(two, [stone, stone, stone, { roughness: 0.08, metalness: 0, conf: 90 }, { roughness: 0.08, metalness: 0, conf: 90 }]);
        expect(m2[0]!.glazingOf).toBe(3);
        expect(m2[1]!.glazingOf).toBeUndefined();
        // no class inside the openings: nothing to match
        expect(matchGlazing(classes.slice(0, 3), [stone, stone, stone]).every(f => f!.glazingOf === undefined)).toBe(true);
    });

    it('asks for numbers per row, never a material category to route on', () => {
        const p = finishPrompt([{ meanLab: [38, 0, 0], share: 0.2, wall: false }, { meanLab: [70, 1, 2], share: 0.5, wall: true }], { building: 'Penn 2' });
        expect(p).toContain('row 2');
        expect(p).toContain('"roughness"');
        expect(p).toContain('"metalness"');
        expect(p).toContain('A dark colour is not metal');
        // the expert is told the reference and the artists' rules, and asked for grain and coverage
        expect(p).toMatch(/\d+\. dressed limestone or sandstone.*roughness 0\.7-0\.95, metalness 0/);
        expect(p).toContain('"ref"');
        expect(p).toContain('Metalness is 0 or 1, never in between');
        expect(p).toContain('"grain"');
        expect(p).toContain('"coverage"');
    });
});
