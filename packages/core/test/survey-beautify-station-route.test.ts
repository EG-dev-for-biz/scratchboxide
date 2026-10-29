/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { stationFromLookAt } from '../src/common/spatial/SurveySynthesisEngine';
import { SurveyStationRenderService } from '../src/node/spatial/SurveyStationRenderService';
import { registerBeautifyHandlers } from '../src/node/spatial/survey-router';
import type { StationImageGenerator } from '../src/node/spatial/BeautifyStationService';
import { decodePng, encodePng } from '../src/node/texture-processing';
import { EVEN_LIGHT_SENTENCE, OUTLINE_LOCK_SENTENCE } from '../src/browser/generative-canvas/services/location-beautify-service';
import type { GeodeticAnchor } from '../src/common/spatial/colmap-vector-reference-types';
import { writeBoxGroundGlb } from './helpers/box-ground-glb';

const ANCHOR: GeodeticAnchor = { lat: 40.7218, lng: -73.9995, elevationMeters: 10, headingDeg: 0, formattedAddress: 'test' };
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-beautify-route-'));
const GLB = path.join(WORK, 'box.glb');
writeBoxGroundGlb(GLB, [-5, 0, -5], [5, 20, 5], 100);
afterAll(() => fs.removeSync(WORK));

/** Hands the reference render back unchanged (a geometry-perfect "photograph"), recording each prompt. */
function echoGenerator(prompts: string[]): StationImageGenerator {
    return { name: 'echo', async generate(args) { prompts.push(args.prompt); return args.blockoutPng; } };
}
/** The reference drawn: its clay recoloured as a model's stone would be (an echoed reference fails building-survey mode's outline check). */
function drawnGenerator(prompts: string[]): StationImageGenerator {
    return {
        name: 'drawn',
        async generate(args) {
            prompts.push(args.prompt);
            const b = decodePng(args.blockoutPng), out = Buffer.from(b.rgba);
            for (let i = 0; i < out.length; i += 4) { const l = out[i]; out[i] = Math.min(255, l * 1.15 + 20); out[i + 1] = Math.min(255, l * 0.95 + 10); out[i + 2] = l * 0.75; }
            return encodePng(b.width, b.height, out);
        }
    };
}

async function plannedStation(id: number, isoDate: string) {
    const r = new SurveyStationRenderService();
    await r.loadMesh(GLB);
    return r.enrichStations([stationFromLookAt(id, [0, 10, 45], [0, 10, 0], { focalLengthMm: 28, sensorWidthMm: 36 }, ANCHOR)], { isoDate })[0];
}

describe('survey_beautify_station route', () => {
    it('lights evenly by default; scene lighting takes the sun of the instant the stations were planned for, not of the call', async () => {
        const planned = await plannedStation(1, '2026-10-23T16:00:00Z');   // midday in New York: the sun is up
        const prompts: string[] = [];
        const deps = registerBeautifyHandlers({}, echoGenerator(prompts), WORK);
        const even = await deps.beautifyStation!({ station: planned, glbPath: GLB, locationName: 'Test Box', width: 320, maxRerolls: 0, outDir: path.join(WORK, 'even') }, () => {});
        expect(even.prompt).toContain(EVEN_LIGHT_SENTENCE);
        expect(even.prompt).not.toContain('Sun:');

        const scene = await deps.beautifyStation!({ station: planned, glbPath: GLB, locationName: 'Test Box', width: 320, maxRerolls: 0, lighting: 'scene', outDir: path.join(WORK, 'scene') }, () => {});
        const elev = Math.round(planned.beautify!.solar!.elevationDegrees);
        expect(elev).toBeGreaterThan(20);
        expect(scene.prompt).toContain(`elevation ${elev}° above the horizon`);
        expect(scene.prompt).not.toContain(EVEN_LIGHT_SENTENCE);
    });

    it('building-survey mode locks and checks the outline and reports the fit', async () => {
        const planned = await plannedStation(2, '2026-10-23T16:00:00Z');
        const prompts: string[] = [];
        const deps = registerBeautifyHandlers({}, drawnGenerator(prompts), WORK);
        const res = await deps.beautifyStation!({ station: planned, glbPath: GLB, locationName: 'Test Box', width: 320, maxRerolls: 0, mode: 'building-survey', renderMode: 'clay', outDir: path.join(WORK, 'survey') }, () => {});
        expect(prompts[0]).toContain(OUTLINE_LOCK_SENTENCE);
        expect(res.qc.outline.checked).toBe(true);
        expect(res.qc.outline.overflow).toBeLessThan(0.03);
        expect(res.accepted).toBe(true);
        expect(await fs.pathExists(res.imagePath)).toBe(true);
    });
});
