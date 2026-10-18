/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs-extra';
import * as path from 'path';
import { SurveySynthesisEngine, stationFromLookAt } from '../src/common/spatial/SurveySynthesisEngine';
import { SurveyStationRenderService } from '../src/node/spatial/SurveyStationRenderService';
import type { GeodeticAnchor } from '../src/common/spatial/colmap-vector-reference-types';
import { writeBoxGroundGlb } from './helpers/box-ground-glb';

const ANCHOR: GeodeticAnchor = { lat: -33.8568, lng: 151.2153, elevationMeters: 12, headingDeg: 0, formattedAddress: 'test' };
const OUT = path.resolve(process.cwd(), 'build/test_survey_render');
const SHOTS = path.resolve(process.cwd(), 'docs/screenshots');

describe('SurveyStationRenderService: pose-exact blockout render + station enrichment', () => {
    const glbPath = path.join(OUT, 'box_ground.glb');
    let service: SurveyStationRenderService;

    beforeAll(async () => {
        await fs.emptyDir(OUT);
        // 10 m cube centred at origin (x,z in [-5,5]), 20 m tall, on a 200 m ground plane
        writeBoxGroundGlb(glbPath, [-5, 0, -5], [5, 20, 5], 100);
        service = new SurveyStationRenderService();
        await service.loadMesh(glbPath);
    });

    it('depth at the image centre equals the analytic distance to the box face (camera-z, metres)', () => {
        // Eye 40 m south of the +Z face (z = 5), level, looking north: centre ray hits the face at z-distance 35 m
        const st = stationFromLookAt(1, [0, 10, 45], [0, 10, 0], { focalLengthMm: 28, sensorWidthMm: 36 }, ANCHOR);
        const r = service.renderStationBlockout(st, { width: 640, height: 360 });
        expect(r.depthKind).toBe('camera-z');
        const c = r.depth[(180) * 640 + 320];
        expect(c).toBeCloseTo(40, 1);
        expect(r.intrinsics.fx).toBeCloseTo(640 / (2 * Math.tan((st.fovDegrees / 2) * Math.PI / 180)), 3);
    });

    it('silhouette bbox of the box matches its analytic projection to within 1 px', () => {
        const st = stationFromLookAt(1, [0, 10, 45], [0, 10, 0], { focalLengthMm: 28, sensorWidthMm: 36 }, ANCHOR);
        const W = 640, H = 360;
        const r = service.renderStationBlockout(st, { width: W, height: H });
        // Box pixels: depth < ground depth along that column. Use rows where the box is: box spans x in [-5,5] at z-distance 40
        const fx = r.intrinsics.fx;
        const expectedHalfWidthPx = (5 / 40) * fx;
        // find leftmost/rightmost pixel in the middle row whose depth is ~40 (box face), not the ground
        let left = W, right = -1;
        for (let x = 0; x < W; x++) { const d = r.depth[180 * W + x]; if (Math.abs(d - 40) < 0.5) { left = Math.min(left, x); right = Math.max(right, x); } }
        expect(left).toBeGreaterThanOrEqual(Math.floor(W / 2 - expectedHalfWidthPx) - 1);
        expect(left).toBeLessThanOrEqual(Math.floor(W / 2 - expectedHalfWidthPx) + 1);
        expect(right).toBeGreaterThanOrEqual(Math.ceil(W / 2 + expectedHalfWidthPx) - 2);
        expect(right).toBeLessThanOrEqual(Math.ceil(W / 2 + expectedHalfWidthPx) + 1);
    });

    it('writes a PNG blockout per station that a human can review', async () => {
        const engine = new SurveySynthesisEngine();
        const poses = engine.synthesize(ANCHOR, { type: 'orbital-multi-tier', targetRadiusMeters: 40, cameraCount: 3, focalLengthMm: 28, lookAtOffsetLocalENU: [0, 10, 0] });
        for (const p of poses) {
            const r = service.renderStationBlockout(p, { width: 960, height: 540 });
            const png = path.join(OUT, `station_${p.id}.png`);
            await fs.outputFile(png, r.png);
            expect((await fs.stat(png)).size).toBeGreaterThan(2000);
        }
        await fs.ensureDir(SHOTS);
        await fs.copy(path.join(OUT, 'station_1.png'), path.join(SHOTS, '33_survey_station_blockout_synthetic.png'));
    });

    it('enrichment: standoff, horizon row, sky fraction, mesh coverage and solar are grounded in the mesh/ephemeris', () => {
        const level = stationFromLookAt(1, [0, 10, 45], [0, 10, 0], { focalLengthMm: 28, sensorWidthMm: 36 }, ANCHOR);
        const lookingUp = stationFromLookAt(2, [0, 10, 45], [0, 200, 45 - 20], { focalLengthMm: 28, sensorWidthMm: 36 }, ANCHOR);
        const farAway = stationFromLookAt(3, [0, 10, 900], [0, 10, 1000], { focalLengthMm: 28, sensorWidthMm: 36 }, ANCHOR); // frustum entirely off the 200 m ground
        const [e1, e2, e3] = service.enrichStations([level, lookingUp, farAway], { width: 320, height: 180, isoDate: '2026-06-21T02:00:00Z' });

        expect(e1.beautify!.standoffMeters).toBeCloseTo(40, 0);
        expect(e1.beautify!.horizonRowFraction).toBeCloseTo(0.5, 2);      // level camera: horizon at mid-height
        expect(e1.beautify!.skyFraction).toBeGreaterThan(0.4);            // upper half is empty above a 20 m box
        expect(e1.beautify!.skyFraction).toBeLessThan(0.65);
        expect(e1.beautify!.meshCoverageFraction).toBeGreaterThan(0.9);   // footprint on the 200 m ground
        expect(e1.beautify!.solar!.isoDate).toBe('2026-06-21T02:00:00Z');
        // 2026-06-21 02:00Z = ~solar noon in Sydney at the June solstice: sun due north, elevation ~ 90 - 33.86 - 23.44
        expect(e1.beautify!.solar!.elevationDegrees).toBeGreaterThan(31);
        expect(e1.beautify!.solar!.elevationDegrees).toBeLessThan(34);
        const az = e1.beautify!.solar!.azimuthDegrees;
        expect(Math.min(az, 360 - az)).toBeLessThan(6);

        expect(e2.beautify!.skyFraction).toBeGreaterThan(0.9);            // looking up: nothing but sky
        expect(e2.beautify!.horizonRowFraction).toBeGreaterThan(0.9);     // horizon pushed to / below the bottom edge
        expect(e2.beautify!.standoffMeters).toBeUndefined();

        expect(e3.beautify!.meshCoverageFraction).toBeLessThan(0.1);
    });

    it('rankForBeautify uses the enriched metrics to drop the sky and off-mesh stations', () => {
        const engine = new SurveySynthesisEngine();
        const level = stationFromLookAt(1, [0, 10, 45], [0, 10, 0], { focalLengthMm: 28, sensorWidthMm: 36 }, ANCHOR);
        const lookingUp = stationFromLookAt(2, [0, 10, 45], [0, 200, 25], { focalLengthMm: 28, sensorWidthMm: 36 }, ANCHOR);
        const side = stationFromLookAt(3, [45, 10, 0], [0, 10, 0], { focalLengthMm: 28, sensorWidthMm: 36 }, ANCHOR);
        const enriched = service.enrichStations([level, lookingUp, side], { width: 160, height: 90, isoDate: '2026-06-21T02:00:00Z' });
        const ranked = engine.rankForBeautify(enriched, { maxCount: 3 });
        expect(ranked.map(p => p.id).sort()).toEqual([1, 3]);
    });
});
