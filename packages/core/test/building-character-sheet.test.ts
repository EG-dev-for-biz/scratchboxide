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
import { beautifyCharacterSheet, checkPanelColour, checkSheetBorders, MAX_PANEL_COLOUR_SHIFT } from '../src/node/spatial/building-character-sheet';
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
function sheetGenerator(calls: Call[], opts: { scale?: number; widenQuadrant?: number; widenPx?: number; dividers?: boolean; frame?: boolean } = {}): StationImageGenerator {
    return {
        name: 'sheet-drawn',
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
            // drawn, not echoed: the clay is recoloured as a model's stone would be (an echoed reference fails the outline check)
            for (let i = 0; i < W * H * 4; i += 4) if (!(rgba[i] === 255 && rgba[i + 1] === 255 && rgba[i + 2] === 255)) { const l = rgba[i]; rgba[i] = Math.min(255, l * 1.15 + 20); rgba[i + 1] = Math.min(255, l * 0.95 + 10); rgba[i + 2] = l * 0.75; }
            const ink = (x: number, y: number) => { const i = (y * W + x) * 4; rgba[i] = rgba[i + 1] = rgba[i + 2] = 20; };
            if (opts.dividers) for (let t = 0; t < 2; t++) { for (let y = 0; y < H; y++) ink(W / 2 - 1 + t, y); for (let x = 0; x < W; x++) ink(x, H / 2 - 1 + t); }
            if (opts.frame) for (let t = 0; t < 2; t++) { for (let y = 0; y < H; y++) { ink(t + 1, y); ink(W - 2 - t, y); } for (let x = 0; x < W; x++) { ink(x, t + 1); ink(x, H - 2 - t); } }
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
        expect(res.borders).toEqual({ passed: true, lines: [], reason: undefined });
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

    it('rejects and regenerates a sheet with dividing lines between the quadrants', async () => {
        const calls: Call[] = [];
        const res = await beautifyCharacterSheet(renderer, sheetGenerator(calls, { dividers: true }), stations(), 'Test Box', { panelWidth: PW, renderMode: 'clay', maxRerolls: 1 });
        expect(calls).toHaveLength(2);
        expect(res.accepted).toBe(false);
        expect(res.borders.passed).toBe(false);
        // the top panels' ground fills the horizontal divider's band in this scene, so only the vertical one can be judged
        expect(res.borders.lines.map(l => l.band)).toEqual(['vertical divider']);
        expect(res.borders.lines.every(l => l.coverage > 0.9)).toBe(true);
        expect(res.borders.reason).toContain('vertical divider');
    });

    it('catches a frame drawn round the sheet on its outer edges, and still sees lines in a sheet answered at another resolution', async () => {
        const framed = await beautifyCharacterSheet(renderer, sheetGenerator([], { frame: true }), stations(), 'Test Box', { panelWidth: PW, renderMode: 'clay', maxRerolls: 0 });
        // the ground plane runs along the whole bottom edge in this scene, so there is no background there to judge
        expect(framed.borders.lines.map(l => l.band).sort()).toEqual(['left edge', 'right edge', 'top edge']);
        expect(framed.accepted).toBe(false);
        const scaled = await beautifyCharacterSheet(renderer, sheetGenerator([], { dividers: true, scale: 1.7 }), stations(), 'Test Box', { panelWidth: PW, renderMode: 'clay', maxRerolls: 0 });
        expect(scaled.borders.passed).toBe(false);
    });

    it('checkSheetBorders on its own: a clean sheet passes, the same sheet with dividers fails, structure reaching a band is not a line', async () => {
        const st = stations();
        const blockouts = st.map(x => renderer.renderStationBlockout(x, { width: PW, height: 180 }));
        const clean = await beautifyCharacterSheet(renderer, sheetGenerator([]), st, 'Test Box', { panelWidth: PW, renderMode: 'clay', maxRerolls: 0 });
        const sheet = decodePng(clean.inputPng);
        expect(checkSheetBorders(sheet.rgba, sheet.width, sheet.height, blockouts).passed).toBe(true);
        const lined = Buffer.from(sheet.rgba);
        for (let y = 0; y < sheet.height; y++) for (const x of [sheet.width / 2 - 1, sheet.width / 2]) { const i = (y * sheet.width + x) * 4; lined[i] = lined[i + 1] = lined[i + 2] = 20; }
        const hit = checkSheetBorders(lined, sheet.width, sheet.height, blockouts);
        expect(hit.lines.map(l => l.band)).toEqual(['vertical divider']);
        // without the panels' silhouettes, the ground reaching the borders would itself read as lines
        expect(checkSheetBorders(sheet.rgba, sheet.width, sheet.height, []).passed).toBe(false);
    });

    it('colour gate: lightness may change, a repainted material (hue/chroma swing) fails', () => {
        // a 40 x 20 reference: a cool grey structure (the tile photos' blue-purple cast) in the middle, nothing around it
        const W = 40, H = 20, rgba = Buffer.alloc(W * H * 4, 255), silhouette = new Uint8Array(W * H);
        for (let y = 4; y < 16; y++) for (let x = 8; x < 32; x++) { const i = (y * W + x) * 4; rgba[i] = 92; rgba[i + 1] = 92; rgba[i + 2] = 112; silhouette[y * W + x] = 255; }
        const ref = { width: W, height: H, rgba, silhouette } as any;
        const paint = (r: number, g: number, b: number) => { const out = Buffer.alloc(W * H * 4, 255); for (let i = 0; i < W * H; i++) if (silhouette[i]) { out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; } return out; };
        // de-lit to a lighter neutral grey: kept
        const neutral = checkPanelColour(ref, paint(128, 128, 132), W, H);
        expect(neutral.passed).toBe(true);
        expect(neutral.shift).toBeLessThan(MAX_PANEL_COLOUR_SHIFT);
        expect(neutral.panelLab[0]).toBeGreaterThan(neutral.referenceLab[0]);
        // repainted as red brick: rejected, and said why
        const brick = checkPanelColour(ref, paint(150, 70, 55), W, H);
        expect(brick.passed).toBe(false);
        expect(brick.shift).toBeGreaterThan(MAX_PANEL_COLOUR_SHIFT);
        expect(brick.reason).toContain('repainted');
        // the image may come back at another size: it is sampled onto the reference's frame
        const big = Buffer.alloc(W * 2 * H * 2 * 4, 255);
        for (let y = 0; y < H * 2; y++) for (let x = 0; x < W * 2; x++) if (silhouette[Math.floor(y / 2) * W + Math.floor(x / 2)]) { const i = (y * W * 2 + x) * 4; big[i] = 150; big[i + 1] = 70; big[i + 2] = 55; }
        expect(checkPanelColour(ref, big, W * 2, H * 2).passed).toBe(false);
    });

    it('a clay reference carries no colour, so its panels are not colour-gated', async () => {
        const res = await beautifyCharacterSheet(renderer, sheetGenerator([]), stations(), 'Test Box', { panelWidth: PW, renderMode: 'clay', maxRerolls: 0 });
        expect(res.panels.every(p => p.colour === undefined)).toBe(true);
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
        expect(res.borders.passed).toBe(true);
        expect(await fs.pathExists(res.sheetPath)).toBe(true);
        expect(await fs.pathExists(res.referencePath)).toBe(true);
        expect(res.panels).toHaveLength(4);
        for (const p of res.panels) { expect(await fs.pathExists(p.imagePath)).toBe(true); expect(p.qc.outline.checked).toBe(true); }
        await expect(deps.beautifySheet!({ stations: stations().slice(0, 2), glbPath: GLB }, () => {})).rejects.toThrow(/four stations/);
    });
});
