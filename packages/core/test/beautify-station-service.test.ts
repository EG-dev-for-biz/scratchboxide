/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs-extra';
import * as path from 'path';
import { stationFromLookAt } from '../src/common/spatial/SurveySynthesisEngine';
import { SurveyStationRenderService } from '../src/node/spatial/SurveyStationRenderService';
import { BeautifyStationService, warpStationImage, type StationImageGenerator } from '../src/node/spatial/BeautifyStationService';
import { decodePng, encodePng } from '../src/node/texture-processing';
import type { GeodeticAnchor } from '../src/common/spatial/colmap-vector-reference-types';

const ANCHOR: GeodeticAnchor = { lat: -33.8568, lng: 151.2153, elevationMeters: 12, headingDeg: 0, formattedAddress: 'test' };
const GLB = path.resolve(process.cwd(), 'build/test_survey_render/box_ground.glb'); // written by survey-station-render.test.ts
const SHOTS = path.resolve(process.cwd(), 'docs/screenshots');
const OPTICS = { focalLengthMm: 28, sensorWidthMm: 36 };

/** Mock "Nano Banana": returns the blockout recoloured (warm stone), optionally shifted horizontally by `shiftPx`. */
function mockGenerator(shiftPx = 0, calls: any[] = []): StationImageGenerator {
    return {
        name: `mock(shift=${shiftPx})`,
        async generate(args) {
            calls.push({ prompt: args.prompt, hasReference: !!args.referencePng, hasMask: !!args.maskPng, aspectRatio: args.aspectRatio });
            const b = decodePng(args.blockoutPng);
            const out = Buffer.alloc(b.rgba.length);
            for (let y = 0; y < b.height; y++) for (let x = 0; x < b.width; x++) {
                const sx = Math.min(b.width - 1, Math.max(0, x - shiftPx));
                const si = (y * b.width + sx) * 4, di = (y * b.width + x) * 4;
                const isSky = b.rgba[si + 2] > 170 && b.rgba[si] < 140;
                if (isSky) { out[di] = 135; out[di + 1] = 170; out[di + 2] = 215; }
                else { const l = b.rgba[si]; out[di] = Math.min(255, l * 1.15 + 20); out[di + 1] = l * 0.95 + 10; out[di + 2] = l * 0.75; }
                out[di + 3] = 255;
            }
            return encodePng(b.width, b.height, out);
        }
    };
}

describe('BeautifyStationService: render -> prompt -> generate -> QC -> aligned pose', () => {
    let renderer: SurveyStationRenderService;
    beforeAll(async () => {
        renderer = new SurveyStationRenderService();
        await renderer.loadMesh(GLB);
    });

    it('accepts a geometry-preserving generation: QC passes, aligned pose stays within tolerance, prompt is station-grounded', async () => {
        const station = renderer.enrichStations([stationFromLookAt(1, [0, 10, 45], [0, 10, 0], OPTICS, ANCHOR)], { isoDate: '2026-06-21T02:00:00Z' })[0];
        const calls: any[] = [];
        const svc = new BeautifyStationService(renderer, mockGenerator(0, calls));
        const res = await svc.beautify(station, { locationName: 'Test Box', moodPromptContext: 'Clear noon. ', styleSuffix: ' Photo.' }, { width: 640, height: 360 });
        expect(res.accepted).toBe(true);
        expect(res.attempts).toBe(1);
        expect(res.qc.deltaYawDeg).toBeLessThan(0.15);
        expect(res.qc.deltaPitchDeg).toBeLessThan(0.15);
        expect(res.qc.deltaPositionM).toBeLessThan(0.3);
        expect(res.prompt).toContain('Camera lock: 28mm lens');
        expect(res.prompt).toContain('Sun: azimuth');
        expect(res.prompt).toContain('Subject distance: approximately 40 meters');
        expect(calls[0].aspectRatio).toBe('16:9');
        expect(calls[0].hasReference).toBe(false);
        expect(decodePng(res.imagePng).width).toBe(640);
        await fs.ensureDir(SHOTS);
        await fs.outputFile(path.join(SHOTS, '35_beautify_station_mock_accepted.png'), res.imagePng);
    });

    it('rejects a generation that moved the geometry beyond tolerance and reports the recovered shift', async () => {
        const station = renderer.enrichStations([stationFromLookAt(2, [0, 10, 45], [0, 10, 0], OPTICS, ANCHOR)])[0];
        // 40 px shift at fx ~ 497 px (640 wide, 65.5 deg) = ~4.6 deg of yaw
        const svc = new BeautifyStationService(renderer, mockGenerator(40));
        const res = await svc.beautify(station, { locationName: 'Test Box' }, { width: 640, height: 360, maxRerolls: 1 });
        expect(res.accepted).toBe(false);
        expect(res.attempts).toBe(2);
        expect(res.qc.deltaYawDeg).toBeGreaterThan(1.5);
        expect(res.qc.reason).toMatch(/yaw|position|translation/i);
    });

    it('chained mode: warps the previous accepted image into the new station with a disocclusion mask and passes both to the generator', async () => {
        const a = renderer.enrichStations([stationFromLookAt(1, [0, 10, 45], [0, 10, 0], OPTICS, ANCHOR)])[0];
        const b = renderer.enrichStations([stationFromLookAt(2, [20, 10, 42], [0, 10, 0], OPTICS, ANCHOR)])[0];
        const calls: any[] = [];
        const svc = new BeautifyStationService(renderer, mockGenerator(0, calls));
        const first = await svc.beautify(a, { locationName: 'Test Box' }, { width: 640, height: 360 });
        const second = await svc.beautify(b, { locationName: 'Test Box' }, { width: 640, height: 360, reference: first });
        expect(second.accepted).toBe(true);
        expect(calls[1].hasReference).toBe(true);
        expect(calls[1].hasMask).toBe(true);
        expect(calls[1].prompt).toContain('reference photograph');
        expect(second.warp).toBeDefined();
        // The warp must cover a large part of the frame but leave disocclusion holes
        expect(second.warp!.coveredFraction).toBeGreaterThan(0.3);
        expect(second.warp!.coveredFraction).toBeLessThan(0.98);
        await fs.outputFile(path.join(SHOTS, '36_beautify_station_chained_warp.png'), second.warp!.warpedPng);
    });

    it('warp correctness: a coloured pixel on the box face lands where the target camera projects that 3D point', () => {
        const a = stationFromLookAt(1, [0, 10, 45], [0, 10, 0], OPTICS, ANCHOR);
        const b = stationFromLookAt(2, [15, 10, 42], [0, 10, 0], OPTICS, ANCHOR);
        const W = 320, H = 180;
        const ra = renderer.renderStationBlockout(a, { width: W, height: H });
        const rb = renderer.renderStationBlockout(b, { width: W, height: H });
        // Paint the centre pixel of A red; it sees the box face at (0, 10, 5) 40 m ahead
        const img = Buffer.from(ra.rgba);
        const ci = ((H / 2) * W + W / 2) * 4; img[ci] = 255; img[ci + 1] = 0; img[ci + 2] = 0;
        const warp = warpStationImage({ rgba: img, depth: ra.depth, width: W, height: H, intrinsics: ra.intrinsics, station: a }, { intrinsics: rb.intrinsics, station: b, width: W, height: H });
        // Find the red pixel in the warp
        let rx = -1, ry = -1;
        for (let y = 0; y < H && rx < 0; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4; if (warp.rgba[i] > 200 && warp.rgba[i + 1] < 60) { rx = x; ry = y; break; } }
        expect(rx).toBeGreaterThanOrEqual(0);
        // Analytic projection of world point P = (0, 10, 5) into camera B
        const P = [0, 10, 5];
        const { pose, intrinsics } = SurveyStationRenderService.stationToCameraPose6DOF(b, W, H);
        const f = [pose.targetX - pose.x, pose.targetY - pose.y, pose.targetZ - pose.z]; const fl = Math.hypot(...f); f[0] /= fl; f[1] /= fl; f[2] /= fl;
        const up = [0, 1, 0]; const r = [f[1] * up[2] - f[2] * up[1], f[2] * up[0] - f[0] * up[2], f[0] * up[1] - f[1] * up[0]]; const rl = Math.hypot(...r); r[0] /= rl; r[1] /= rl; r[2] /= rl;
        const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
        const d = [P[0] - pose.x, P[1] - pose.y, P[2] - pose.z];
        const cx = d[0] * r[0] + d[1] * r[1] + d[2] * r[2], cy = d[0] * u[0] + d[1] * u[1] + d[2] * u[2], cz = d[0] * f[0] + d[1] * f[1] + d[2] * f[2];
        const px = intrinsics.cx + intrinsics.fx * cx / cz, py = intrinsics.cy - intrinsics.fy * cy / cz;
        expect(Math.abs(rx - px)).toBeLessThan(2.5);
        expect(Math.abs(ry - py)).toBeLessThan(2.5);
    });
});
