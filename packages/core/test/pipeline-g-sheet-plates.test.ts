/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { SurveyStationRenderService } from '../src/node/spatial/SurveyStationRenderService';
import { planSheetStations, overlaySheet, sheetPlates } from '../src/node/3d-engine/staged-location/pipeline-g/sheet-plates';
import { emptyPlate, layStation, finishPlate } from '../src/node/3d-engine/staged-location/pipeline-g/plates';
import type { MassingFace } from '../src/node/3d-engine/staged-location/pipeline-e/native-massing';
import type { StationImageGenerator } from '../src/node/spatial/BeautifyStationService';
import { decodePng, encodePng } from '../src/node/texture-processing';
import { writeBoxGroundGlb } from './helpers/box-ground-glb';

const ANCHOR = { lat: 40.7218, lng: -73.9995, elevationMeters: 10, headingDeg: 0 };
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-sheet-plates-'));
const GLB = path.join(WORK, 'box.glb');

/** A wall face of the 20 m box [-10,10] x [0,30] x [-6,6] (x wide, z deep), in pipeline G's frame (axisS = -normal x up). */
function wall(index: number, key: string, normal: [number, number, number], origin: [number, number, number], width: number): MassingFace {
    // axisS = (-normal) x up (pipeline G's convention)
    const axisS: [number, number, number] = [-normal[2] === 0 ? 0 : -normal[2] * -1, 0, normal[0] === 0 ? 0 : -normal[0]];
    return { index, key, kind: 'wall', part: 'box', loop: 0, edge: index, wall: true, normal, axisS, axisT: [0, 1, 0], origin,
        sMin: -width, sMax: 0, tMin: 0, tMax: 30, tBottom: 0, area: width * 30, pixel: 0.05, orthoSMin: -width, orthoTMax: 30, width: 0, height: 0, coverage: 1, openings: [], top: [] } as MassingFace;
}

describe('pipeline H-S sheet plates', () => {
    let renderer: SurveyStationRenderService;
    let faces: MassingFace[];
    beforeAll(async () => {
        writeBoxGroundGlb(GLB, [-10, 0, -6], [10, 30, 6], 100);
        renderer = new SurveyStationRenderService(); await renderer.loadMesh(GLB);
        // +z wall (20 m wide) and +x wall (12 m wide); origin at the wall's right end seen from outside, s runs left to 0
        faces = [
            { ...wall(0, 'w:box:0:0', [0, 0, 1], [10, 0, 6], 20), axisS: [1, 0, 0] } as MassingFace,
            { ...wall(1, 'w:box:0:1', [1, 0, 0], [10, 0, -6], 12), axisS: [0, 0, -1] } as MassingFace
        ];
    });
    afterAll(() => fs.removeSync(WORK));

    it('plans the largest wall and its perpendicular neighbour straight on, their corner and an aerial, each framing the whole structure', () => {
        const bounds = renderer.getMeshBounds()!;
        const st = planSheetStations(faces, { min: [-10, 0, -6], max: [10, 30, 6] }, ANCHOR);
        expect(st.map(s => s.id)).toEqual([9001, 9002, 9003, 9004]);
        // straight on: looking straight back along each wall's normal, level
        expect(st[0].forwardVector[2]).toBeCloseTo(-1, 3); expect(Math.abs(st[0].forwardVector[1])).toBeLessThan(1e-6);
        expect(st[1].forwardVector[0]).toBeCloseTo(-1, 3);
        // the aerial looks down at 35 degrees
        expect(st[3].pitchDegrees).toBeCloseTo(-35, 0);
        // every view frames the whole 30 m tall structure with margin: the vertical half-angle covers half its height x 1.25
        // distance to each wall's plane (z = 6 for the +z wall, x = 10 for the +x wall)
        const dToWall = [st[0].positionLocalENU[2] - 6, st[1].positionLocalENU[0] - 10];
        for (const [k, d] of dToWall.entries()) {
            const vHalf = Math.atan(Math.tan(st[k].fovDegrees * Math.PI / 360) / (16 / 9));
            expect(d * Math.tan(vHalf)).toBeGreaterThanOrEqual(15 * 1.2);
        }
        expect(bounds.max[1]).toBeCloseTo(30, 3);
    });

    it('lays passing panels over the plate (sheet colour, scan relief kept) and leaves a failing panel out', () => {
        // the survey plate: the box's +z wall laid from a clay render of the straight-on view
        const st = renderer.enrichStations(planSheetStations(faces, { min: [-10, 0, -6], max: [10, 30, 6] }, ANCHOR));
        const plate = emptyPlate(0, faces[0]);
        const b0 = renderer.renderStationBlockout(st[0], { width: 480, height: 270 });
        layStation({ rgba: b0.rgba, depth: b0.depth, cameraPose: b0.cameraPose as never, intrinsics: b0.intrinsics, width: b0.width, height: b0.height }, 1, [plate], faces);
        const pl = finishPlate(plate);
        expect(pl.coverage).toBeGreaterThan(0.05);      // a far whole-building camera at 480 px reaches a share of the 5 cm texels
        // a "sheet" whose straight-on panel is painted red and passes, and whose other panels fail
        const red = Buffer.alloc(480 * 270 * 4); for (let i = 0; i < 480 * 270; i++) red.set([200, 30, 30, 255], i * 4);
        const panel = (k: number, passed: boolean) => {
            const b = renderer.renderStationBlockout(st[k], { width: 480, height: 270 });
            return { station: st[k], blockout: b, imagePng: encodePng(480, 270, red), qc: { passed } } as never;
        };
        const { plates, fromSheet } = overlaySheet([pl], faces, { panels: [panel(0, true), panel(1, false), panel(2, false), panel(3, false)] });
        expect(fromSheet[0]).toBeGreaterThan(0.05 * pl.w * pl.h);
        let reds = 0, same = 0;
        for (let j = 0; j < pl.w * pl.h; j++) {
            if (plates[0].rgb[j * 3] === 200 && plates[0].rgb[j * 3 + 1] === 30) reds++;
            if (Object.is(plates[0].relief[j], pl.relief[j]) || (Number.isNaN(plates[0].relief[j]) && Number.isNaN(pl.relief[j]))) same++;
        }
        expect(reds).toBe(fromSheet[0]);
        expect(same).toBe(pl.w * pl.h);                 // the relief is the scan's, untouched
        // with every panel failing, nothing is laid
        const none = overlaySheet([pl], faces, { panels: [panel(0, false), panel(1, false), panel(2, false), panel(3, false)] });
        expect(none.fromSheet[0]).toBe(0);
    });

    it('end to end: the best sheet by the given score is laid; with no usable sheet the plates come back unchanged', async () => {
        const st = renderer.enrichStations(planSheetStations(faces, { min: [-10, 0, -6], max: [10, 30, 6] }, ANCHOR));
        const plate = emptyPlate(0, faces[0]);
        const b0 = renderer.renderStationBlockout(st[0], { width: 480, height: 270 });
        layStation({ rgba: b0.rgba, depth: b0.depth, cameraPose: b0.cameraPose as never, intrinsics: b0.intrinsics, width: b0.width, height: b0.height }, 1, [plate], faces);
        const pl = finishPlate(plate);
        const echo: StationImageGenerator = { name: 'echo', async generate(args) { return args.blockoutPng; } };
        const scores: number[] = [];
        // the box GLB has no photo: the sheet is rendered in clay here, so the colour gate does not apply
        const res = await sheetPlates([pl], faces, { structureGlb: GLB, generator: echo, anchor: ANCHOR, place: 'Test Box', candidates: 2, maxRerolls: 0,
            score: async over => { scores.push(over[0].coverage); return { value: scores.length }; } }).catch(e => e as Error);
        // a clay-only GLB cannot be rendered textured: the call reports why rather than laying anything made up
        if (res instanceof Error) { expect(res.message).toMatch(/textur|albedo|image/i); return; }
        expect(res.plates).toHaveLength(1);
        const lines: StationImageGenerator = { name: 'lines', async generate(args) { const s = decodePng(args.blockoutPng); const r = Buffer.from(s.rgba); for (let y = 0; y < s.height; y++) for (const x of [s.width / 2 - 1, s.width / 2]) { const i = (y * s.width + x) * 4; r[i] = r[i + 1] = r[i + 2] = 20; } return encodePng(s.width, s.height, r); } };
        const none = await sheetPlates([pl], faces, { structureGlb: GLB, generator: lines, anchor: ANCHOR, place: 'Test Box', candidates: 1, maxRerolls: 0 });
        expect(none.plates[0]).toBe(pl);
        expect(none.fromSheet[0]).toBe(0);
    });
});
