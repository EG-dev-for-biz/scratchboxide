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
import { stationFromLookAt } from '../src/common/spatial/SurveySynthesisEngine';
import { SurveyStationRenderService } from '../src/node/spatial/SurveyStationRenderService';
import { beautifyCharacterSheet } from '../src/node/spatial/building-character-sheet';
import { registerBeautifyHandlers } from '../src/node/spatial/survey-router';
import type { StationImageGenerator } from '../src/node/spatial/BeautifyStationService';
import { CHARACTER_SHEET_FRAMING_LOCK, EVEN_LIGHT_SENTENCE, buildCharacterSheetPrompt } from '../src/browser/generative-canvas/services/location-beautify-service';
import { decodePng, encodePng } from '../src/node/texture-processing';
import type { GeodeticAnchor } from '../src/common/spatial/colmap-vector-reference-types';
import { writeBoxGroundGlb } from './helpers/box-ground-glb';

const ANCHOR: GeodeticAnchor = { lat: 40.7218, lng: -73.9995, elevationMeters: 10, headingDeg: 0, formattedAddress: 'test' };
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-char-sheet-'));
const GLB = path.join(WORK, 'box.glb');
const OPTICS = { focalLengthMm: 28, sensorWidthMm: 36 };
const PW = 320;

interface Call { prompt: string; width: number; height: number; aspectRatio: string; imageSize?: string }

/**
 * Answers with the reference sheet itself (a geometry-perfect "photograph"), scaled by `scale`, optionally with the
 * structure in quadrant `widenQuadrant` painted `widenPx` further right above the horizon.
 */
function sheetGenerator(calls: Call[], opts: { scale?: number; widenQuadrant?: number; widenPx?: number } = {}): StationImageGenerator {
    return {
        name: 'sheet-echo',
        async generate(args) {
            calls.push({ prompt: args.prompt, width: args.width, height: args.height, aspectRatio: args.aspectRatio, imageSize: args.imageSize });
            const src = decodePng(args.blockoutPng);
            const rgba = Buffer.from(src.rgba), W = src.width, H = src.height;
            if (opts.widenQuadrant !== undefined) {
                const ox = (opts.widenQuadrant % 2) * (W / 2), oy = Math.floor(opts.widenQuadrant / 2) * (H / 2);
                for (let y = oy; y < oy + H / 4; y++) {
                    let last = -1;
                    for (let x = ox; x < ox + W / 2; x++) { const i = (y * W + x) * 4; if (!(rgba[i] === 255 && rgba[i + 1] === 255 && rgba[i + 2] === 255)) last = x; }
                    if (last < 0) continue;
                    for (let x = last + 1; x <= Math.min(ox + W / 2 - 1, last + (opts.widenPx ?? 40)); x++) rgba.copy(rgba, (y * W + x) * 4, (y * W + last) * 4, (y * W + last) * 4 + 4);
                }
            }
            const s = opts.scale ?? 1, OW = Math.round(W * s), OH = Math.round(H * s), out = Buffer.alloc(OW * OH * 4);
            for (let y = 0; y < OH; y++) for (let x = 0; x < OW; x++) rgba.copy(out, (y * OW + x) * 4, (Math.min(H - 1, Math.floor(y / s)) * W + Math.min(W - 1, Math.floor(x / s))) * 4, (Math.min(H - 1, Math.floor(y / s)) * W + Math.min(W - 1, Math.floor(x / s))) * 4 + 4);
            return { png: encodePng(OW, OH, out), modelUsed: 'gemini-3.1-flash-image' };
        }
    };
}

describe('building-survey character sheet', () => {
    let renderer: SurveyStationRenderService;
    // a 10 m x 20 m box seen level from mid-height, 45 m out, from four sides
    const stations = () => renderer.enrichStations(
        [[0, 10, 45], [45, 10, 0], [0, 10, -45], [-45, 10, 0]].map((eye, i) => stationFromLookAt(i + 1, eye as [number, number, number], [0, 10, 0], OPTICS, ANCHOR)));
    beforeAll(async () => {
        writeBoxGroundGlb(GLB, [-5, 0, -5], [5, 20, 5], 100);
        renderer = new SurveyStationRenderService();
        await renderer.loadMesh(GLB);
    });
    afterAll(() => fs.removeSync(WORK));

    it('asks for one 4K image of a 2 x 2 sheet with the framing lock, splits it into the four stations, and accepts a faithful sheet', async () => {
        const calls: Call[] = [];
        const res = await beautifyCharacterSheet(renderer, sheetGenerator(calls), stations(), 'Test Box', { panelWidth: PW, renderMode: 'clay', maxRerolls: 1 });
        expect(calls).toHaveLength(1);
        expect(calls[0].imageSize).toBe('4K');
        expect(calls[0].aspectRatio).toBe('16:9');
        expect([calls[0].width, calls[0].height]).toEqual([2 * PW, 2 * 180]);
        expect(calls[0].prompt).toContain(CHARACTER_SHEET_FRAMING_LOCK);
        expect(calls[0].prompt).toContain(EVEN_LIGHT_SENTENCE);
        expect(calls[0].prompt).not.toContain('Sun:');
        // the reference sheet: white margins, a structure in each quadrant
        const sheet = decodePng(res.inputPng);
        expect([sheet.width, sheet.height]).toEqual([2 * PW, 360]);
        expect(Array.from(sheet.rgba.subarray(0, 4))).toEqual([255, 255, 255, 255]);
        expect(res.panels.map(p => p.station.id)).toEqual([1, 2, 3, 4]);
        for (const p of res.panels) {
            expect([decodePng(p.imagePng).width, decodePng(p.imagePng).height]).toEqual([PW, 180]);
            expect(p.qc.outline?.checked).toBe(true);
            expect(p.qc.outline!.overflow).toBeLessThan(0.03);
            expect(p.qc.passed).toBe(true);
        }
        expect(res.accepted).toBe(true);
        expect(res.modelUsed).toBe('gemini-3.1-flash-image');
    });

    it('splits a sheet the model answered at its own resolution back onto the station frames', async () => {
        const res = await beautifyCharacterSheet(renderer, sheetGenerator([], { scale: 1.7 }), stations(), 'Test Box', { panelWidth: PW, renderMode: 'clay', maxRerolls: 0 });
        expect(res.accepted).toBe(true);
        expect(res.panels.every(p => p.qc.outline!.overflow < 0.03)).toBe(true);
    });

    it('rejects and regenerates the whole sheet when one panel leaves its outline, naming that panel', async () => {
        const calls: Call[] = [];
        const res = await beautifyCharacterSheet(renderer, sheetGenerator(calls, { widenQuadrant: 1, widenPx: 40 }), stations(), 'Test Box', { panelWidth: PW, renderMode: 'clay', maxRerolls: 1 });
        expect(calls).toHaveLength(2);
        expect(res.attempts).toBe(2);
        expect(res.accepted).toBe(false);
        expect(res.panels[1].qc.passed).toBe(false);
        expect(res.panels[1].qc.outline!.overflow).toBeGreaterThan(0.1);
        expect(res.panels[1].qc.reason).toContain('outside the scan outline');
        for (const q of [0, 2, 3]) expect(res.panels[q].qc.passed).toBe(true);
    });

    it('takes exactly four stations of one aspect ratio', async () => {
        await expect(beautifyCharacterSheet(renderer, sheetGenerator([]), stations().slice(0, 3), 'Test Box', { renderMode: 'clay' })).rejects.toThrow(/four stations, got 3/);
        expect(() => buildCharacterSheetPrompt({ locationName: 'x', stations: stations().slice(0, 2) })).toThrow(/four views, got 2/);
        await expect(beautifyCharacterSheet(renderer, sheetGenerator([]), stations(), 'Test Box', { renderMode: 'textured' })).rejects.toThrow(/needs glbPath/);
    });

    it('the survey route writes the sheet and each panel with its QC', async () => {
        const deps = registerBeautifyHandlers({}, sheetGenerator([]), WORK);
        const res = await deps.beautifySheet!({ stations: stations(), glbPath: GLB, locationName: 'Test Box', renderMode: 'clay', maxRerolls: 0, outDir: path.join(WORK, 'route') }, () => {});
        expect(res.accepted).toBe(true);
        expect(await fs.pathExists(res.sheetPath)).toBe(true);
        expect(await fs.pathExists(res.referencePath)).toBe(true);
        expect(res.panels).toHaveLength(4);
        for (const p of res.panels) { expect(await fs.pathExists(p.imagePath)).toBe(true); expect(p.qc.outline.checked).toBe(true); }
        await expect(deps.beautifySheet!({ stations: stations().slice(0, 2), glbPath: GLB }, () => {})).rejects.toThrow(/four stations/);
    });
});
