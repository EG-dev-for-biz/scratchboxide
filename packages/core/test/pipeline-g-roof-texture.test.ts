/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline G's roof texture (pipeline-g/roof-texture.ts), with a stand-in image client (no model is called): the roof
 * station stands above a 30 x 20 m roof looking down 10 degrees off vertical with all of it in frame; a redraw that keeps
 * the plate's edges is written over the roof's paint (labelled with the roof source), one that moves them is refused and
 * the paint kept; the prompt says what no camera saw is continued as the roof.
 */

import { describe, expect, it } from 'vitest';
import { SurveyStationRenderService } from '../src/node/spatial/SurveyStationRenderService';
import type { MassingFace } from '../src/node/3d-engine/staged-location/pipeline-e/native-massing';
import type { PlateModelClient } from '../src/node/3d-engine/staged-location/pipeline-e/enhance';
import { decodeImageInMemory } from '../src/node/3d-engine/staged-location/tile-texture-transfer';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';
import { closePlateGaps, redrawRoof, roofPlatePrompt, roofStations } from '../src/node/3d-engine/staged-location/pipeline-g/roof-texture';
import { emptyPlate, finishPlate } from '../src/node/3d-engine/staged-location/pipeline-g/plates';

/** A 30 x 20 m flat roof at y = 12: s east from x = 0, t north (−z) from z = 0, facing up. */
const ROOF: MassingFace = {
    index: 7, key: 'r:p:0', kind: 'roof', part: 'p', loop: 0, edge: -1, wall: false,
    normal: [0, 1, 0], axisS: [1, 0, 0], axisT: [0, 0, -1], origin: [0, 12, 0],
    sMin: 0, sMax: 30, tMin: 0, tMax: 20, tBottom: 0, area: 600, pixel: 0.1, orthoSMin: 0, orthoTMax: 20, width: 300, height: 200, coverage: 1, openings: [], top: []
};

/** A roof texture: membrane grey with dark joints every `pitch` px (2 m), and a hatch at `hatchX`. */
function roofImage(pitch = 20, hatchX = 120): Uint8Array {
    const W = ROOF.width, H = ROOF.height, out = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const joint = x % pitch < 2 || y % pitch < 2, hatch = x > hatchX && x < hatchX + 30 && y > 80 && y < 110;
        const v = hatch ? 60 : joint ? 90 : 170;
        out.set([v, v, v + 5, 255], (y * W + x) * 4);
    }
    return out;
}

describe('pipeline G roof texture', () => {
    it('places a station above the roof, looking down at it, all of it in frame', () => {
        const [rs] = roofStations([ROOF], { lat: 41.88, lng: -87.63, elevationMeters: 0 }, 900);
        expect(rs.faces).toEqual([0]);
        const { pose, intrinsics } = SurveyStationRenderService.stationToCameraPose6DOF(rs.station, 1280, 720);
        expect(pose.y).toBeGreaterThan(30);
        const fwd = [pose.targetX - pose.x, pose.targetY - pose.y, pose.targetZ - pose.z], L = Math.hypot(fwd[0], fwd[1], fwd[2]);
        // about 10 degrees off straight down
        expect(Math.acos(-fwd[1] / L) * 180 / Math.PI).toBeCloseTo(10, 0);
        // every roof corner inside the vertical field of view's cone
        for (const [x, z] of [[0, 0], [30, 0], [30, -20], [0, -20]]) {
            const d = [x - pose.x, 12 - pose.y, z - pose.z];
            const cos = (d[0] * fwd[0] + d[1] * fwd[1] + d[2] * fwd[2]) / (Math.hypot(d[0], d[1], d[2]) * L);
            expect(Math.acos(cos) * 180 / Math.PI).toBeLessThan(intrinsics.verticalFovDegrees * 0.5 * 16 / 9);
        }
        // a soffit (facing down) is not a roof
        expect(roofStations([{ ...ROOF, normal: [0, -1, 0] }], { lat: 0, lng: 0, elevationMeters: 0 }, 1)).toEqual([]);
    });

    it('keeps a redraw that holds the plate, and refuses one that moves it', async () => {
        const plate = roofImage(), use = new Uint8Array(ROOF.width * ROOF.height).fill(1);
        // the stand-in model answers the roof it was sent, cleaned (a little brighter), or a different layout (joints every
        // 3.3 m, the hatch moved): a whole-image shift the alignment corrects, a changed layout it cannot
        const answer = (pitch: number, hatchX: number): PlateModelClient => async r => {
            const sent = decodeImageInMemory(Buffer.from(r.image));
            const src = roofImage(pitch, hatchX), W = ROOF.width, H = ROOF.height;
            // the stand-in draws its answer at the size it was sent
            const out = new Uint8Array(sent.width * sent.height * 4);
            for (let y = 0; y < sent.height; y++) for (let x = 0; x < sent.width; x++) {
                const sx = Math.min(W - 1, Math.floor(x * W / sent.width)), sy = Math.min(H - 1, Math.floor(y * H / sent.height));
                for (let c = 0; c < 3; c++) out[(y * sent.width + x) * 4 + c] = Math.min(255, src[(sy * W + sx) * 4 + c] + 10);
                out[(y * sent.width + x) * 4 + 3] = 255;
            }
            return { bytes: new Uint8Array(encodePng(sent.width, sent.height, Buffer.from(out), 4)), modelUsed: 'stand-in' };
        };
        const paint = () => ({ width: ROOF.width, height: ROOF.height, rgba: new Uint8Array(ROOF.width * ROOF.height * 4).fill(40), source: new Uint8Array(ROOF.width * ROOF.height).fill(0) });
        const good = paint();
        const kept = await redrawRoof(ROOF, good, { tex: { ...paint(), rgba: plate }, use, covered: 1 }, { client: answer(20, 120), locationName: 'test', source: 3 });
        expect(kept.accepted).toBe(true);
        expect(good.source.every(s => s === 3)).toBe(true);
        expect(good.rgba[(150 * ROOF.width + 50) * 4]).toBeGreaterThan(150);
        const bad = paint();
        const refused = await redrawRoof(ROOF, bad, { tex: { ...paint(), rgba: plate }, use, covered: 1 }, { client: answer(33, 20), locationName: 'test', source: 3 });
        expect(refused.accepted).toBe(false);
        expect(refused.why).toMatch(/keeps its painted colour/);
        expect(bad.rgba[0]).toBe(40);
    });

    it('closes the gaps a distant station leaves between its pixels, never past the edge of what it saw', () => {
        const pl = finishPlate(emptyPlate(0, ROOF));
        // every third texel hit, over the left half only
        for (let y = 0; y < pl.h; y += 3) for (let x = 0; x < pl.w / 2; x += 3) { const j = y * pl.w + x; pl.relief[j] = 0; pl.rgb.set([200, 100, 50], j * 3); }
        const before = pl.relief.filter(v => !Number.isNaN(v)).length;
        expect(closePlateGaps(pl)).toBeGreaterThan(before * 5);
        // inside the dotted half: filled with the dots' colour
        const j = 31 * pl.w + 31;
        expect(Number.isNaN(pl.relief[j])).toBe(false);
        expect([...pl.rgb.subarray(j * 3, j * 3 + 3)]).toEqual([200, 100, 50]);
        // the right half, which nothing saw, stays unseen
        expect(Number.isNaN(pl.relief[31 * pl.w + Math.floor(pl.w * 0.75)])).toBe(true);
        expect(pl.coverage).toBeGreaterThan(0.45);
        expect(pl.coverage).toBeLessThan(0.55);
    });

    it('asks for the roof continued where no camera saw it', () => {
        const p = roofPlatePrompt({ locationName: 'The Rookery', widthM: 50, heightM: 48, widthPx: 1024, heightPx: 1024 });
        expect(p).toMatch(/straight down/);
        expect(p).toMatch(/mid-grey areas .* fill each as the roof around it continues/);
    });
});
