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
import { SurveyStationRenderService, type StationBlockoutRender } from '../src/node/spatial/SurveyStationRenderService';
import { beautifyCharacterSheet, checkPanelColour, MAX_PANEL_COLOUR_SHIFT } from '../src/node/spatial/building-character-sheet';
import type { StationImageGenerator } from '../src/node/spatial/BeautifyStationService';
import { decodePng, encodePng } from '../src/node/texture-processing';
import type { GeodeticAnchor } from '../src/common/spatial/colmap-vector-reference-types';
import { writeBoxGroundGlb } from './helpers/box-ground-glb';

const ANCHOR: GeodeticAnchor = { lat: 40.7218, lng: -73.9995, elevationMeters: 10, headingDeg: 0, formattedAddress: 'test' };
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-sheet-best-of-'));
const GLB = path.join(WORK, 'box.glb');
const PW = 320;

/** A reference render: a W x H frame, the structure (silhouette) in its middle, painted `rgb`. */
function reference(W: number, H: number, rgb: [number, number, number]): StationBlockoutRender {
    const rgba = Buffer.alloc(W * H * 4), silhouette = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x, inside = x > W / 4 && x < 3 * W / 4 && y > H / 4 && y < 3 * H / 4;
        silhouette[i] = inside ? 255 : 0;
        rgba.set(inside ? [...rgb, 255] : [0, 0, 0, 255], i * 4);
    }
    return { width: W, height: H, rgba, silhouette } as unknown as StationBlockoutRender;
}
const paint = (W: number, H: number, rgb: [number, number, number]) => { const b = Buffer.alloc(W * H * 4); for (let i = 0; i < W * H; i++) b.set([...rgb, 255], i * 4); return b; };
/**
 * The reference sheet drawn, not echoed: its clay recoloured as a model's stone would be, the white sheet left white (an
 * echoed reference fails the outline check since 8056aebd). Any lines a stand-in draws go on after this.
 */
function drawn(rgba: Buffer): Buffer {
    for (let i = 0; i < rgba.length; i += 4) if (!(rgba[i] === 255 && rgba[i + 1] === 255 && rgba[i + 2] === 255)) { const l = rgba[i]; rgba[i] = Math.min(255, l * 1.15 + 20); rgba[i + 1] = Math.min(255, l * 0.95 + 10); rgba[i + 2] = l * 0.75; }
    return rgba;
}

describe('character sheet colour gate and best of N', () => {
    let renderer: SurveyStationRenderService;
    const stations = () => renderer.enrichStations(
        [[0, 10, 45], [45, 10, 0], [0, 10, -45], [-45, 10, 0]].map((eye, i) => stationFromLookAt(i + 1, eye as [number, number, number], [0, 10, 0], { focalLengthMm: 28, sensorWidthMm: 36 }, ANCHOR)));
    beforeAll(async () => { writeBoxGroundGlb(GLB, [-5, 0, -5], [5, 20, 5], 100); renderer = new SurveyStationRenderService(); await renderer.loadMesh(GLB); });
    afterAll(() => fs.removeSync(WORK));

    it('the colour gate lets lightness change but fails a repainted material', () => {
        const ref = reference(200, 120, [110, 112, 122]);                                   // the tiles' blue-grey cast iron
        const lighter = checkPanelColour(ref, paint(200, 120, [190, 190, 192]), 200, 120);   // de-lit, neutral grey
        expect(lighter.passed).toBe(true);
        expect(lighter.shift).toBeLessThan(MAX_PANEL_COLOUR_SHIFT);
        const brick = checkPanelColour(ref, paint(200, 120, [150, 62, 48]), 200, 120);       // repainted red brick
        expect(brick.passed).toBe(false);
        expect(brick.shift).toBeGreaterThan(30);
        expect(brick.reason).toContain('repainted');
    });

    it('generates the candidates of a round in parallel, records every one, and keeps the best', async () => {
        let n = 0;
        const calls: number[] = [];
        // candidate 1 and 2 draw dividing lines between the quadrants; candidate 3 is clean
        const gen: StationImageGenerator = {
            name: 'three-candidates',
            async generate(args) {
                const k = ++n; calls.push(k);
                const s = decodePng(args.blockoutPng); const rgba = drawn(Buffer.from(s.rgba));
                if (k < 3) for (let t = 0; t < 2; t++) for (let y = 0; y < s.height; y++) { const i = (y * s.width + s.width / 2 - 1 + t) * 4; rgba[i] = rgba[i + 1] = rgba[i + 2] = 20; }
                return encodePng(s.width, s.height, rgba);
            }
        };
        const res = await beautifyCharacterSheet(renderer, gen, stations(), 'Test Box', { panelWidth: PW, renderMode: 'clay', maxRerolls: 1, candidates: 3 });
        expect(calls).toHaveLength(3);                // one round of three: the third passed, so no second round
        expect(res.attempts).toBe(3);
        expect(res.tried).toHaveLength(3);
        expect(res.tried!.map(t => t.bordersPassed)).toEqual([false, false, true]);
        expect(res.accepted).toBe(true);
        expect(res.borders.passed).toBe(true);
    });

    it('with a score, keeps sampling until two sheets pass and keeps the higher-scoring one; failed sheets are never scored', async () => {
        let n = 0;
        // sheet 2 draws dividing lines (fails); sheets 1 and 3 are clean; the score prefers sheet 3
        const gen: StationImageGenerator = {
            name: 'scored',
            async generate(args) {
                const k = ++n; const s = decodePng(args.blockoutPng); const rgba = drawn(Buffer.from(s.rgba));
                if (k === 2) for (let t = 0; t < 2; t++) for (let y = 0; y < s.height; y++) { const i = (y * s.width + s.width / 2 - 1 + t) * 4; rgba[i] = rgba[i + 1] = rgba[i + 2] = 20; }
                rgba[0] = k;                           // a mark the score reads back: which draw this sheet was
                return encodePng(s.width, s.height, rgba);
            }
        };
        const scored: number[] = [];
        const res = await beautifyCharacterSheet(renderer, gen, stations(), 'Test Box', {
            panelWidth: PW, renderMode: 'clay', maxRerolls: 3, candidates: 1, keepAccepted: 2,
            score: async sheet => { const k = decodePng(sheet.sheetPng).rgba[0]; scored.push(k); return { value: k === 3 ? 0.9 : 0.2, detail: { draw: k } }; }
        });
        expect(res.attempts).toBe(3);                // 1 (passes), 2 (fails), 3 (passes): two accepted, stop
        expect(scored.sort()).toEqual([1, 3]);        // the failed sheet was not scored
        expect(res.score?.value).toBe(0.9);
        expect((res.score?.detail as any).draw).toBe(3);
        expect(res.tried!.map(t => t.score)).toEqual([0.2, undefined, 0.9]);
    });

    it('scores a near-miss sheet (one failing panel) as usable, leaving its failing panel marked', async () => {
        let n = 0;
        // every sheet widens the building in quadrant 1 (one failing panel); with scoreMaxFailingPanels 1 they are usable
        const gen: StationImageGenerator = {
            name: 'near-miss',
            async generate(args) {
                n++; const s = decodePng(args.blockoutPng); const rgba = drawn(Buffer.from(s.rgba)), W = s.width, H = s.height;
                for (let y = 0; y < H / 4; y++) {
                    let last = -1;
                    for (let x = W / 2; x < W; x++) { const i = (y * W + x) * 4; if (!(rgba[i] === 255 && rgba[i + 1] === 255 && rgba[i + 2] === 255)) last = x; }
                    if (last >= 0) for (let x = last + 1; x <= Math.min(W - 1, last + 40); x++) rgba.copy(rgba, (y * W + x) * 4, (y * W + last) * 4, (y * W + last) * 4 + 4);
                }
                return encodePng(W, H, rgba);
            }
        };
        const res = await beautifyCharacterSheet(renderer, gen, stations(), 'Test Box', {
            panelWidth: PW, renderMode: 'clay', maxRerolls: 2, candidates: 1, keepAccepted: 2, scoreMaxFailingPanels: 1,
            score: async sheet => ({ value: sheet.panels.filter(p => p.qc.passed).length })
        });
        expect(n).toBe(2);                            // two usable sheets collected, then it stops
        expect(res.accepted).toBe(false);             // honest: a panel failed
        expect(res.usable).toBe(true);
        expect(res.panels[1].qc.passed).toBe(false);  // the caller leaves this panel out
        expect(res.panels.filter(p => p.qc.passed)).toHaveLength(3);
        expect(res.score?.value).toBe(3);
    });

    it('with no good candidate it spends every round and returns the best it saw', async () => {
        const gen: StationImageGenerator = {
            name: 'always-lined',
            async generate(args) {
                const s = decodePng(args.blockoutPng); const rgba = drawn(Buffer.from(s.rgba));
                for (let t = 0; t < 2; t++) for (let y = 0; y < s.height; y++) { const i = (y * s.width + s.width / 2 - 1 + t) * 4; rgba[i] = rgba[i + 1] = rgba[i + 2] = 20; }
                return encodePng(s.width, s.height, rgba);
            }
        };
        const res = await beautifyCharacterSheet(renderer, gen, stations(), 'Test Box', { panelWidth: PW, renderMode: 'clay', maxRerolls: 1, candidates: 2 });
        expect(res.attempts).toBe(4);                 // 2 rounds x 2 candidates
        expect(res.tried).toHaveLength(4);
        expect(res.accepted).toBe(false);
    });
});
