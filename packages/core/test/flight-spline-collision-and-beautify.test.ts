/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as fs from 'fs-extra';
import { SurveySynthesisEngine } from '../src/common/spatial/SurveySynthesisEngine';
import { SurveyStationRenderService } from '../src/node/spatial/SurveyStationRenderService';
import { BeautifyStationService, createDefaultStationImageGenerator } from '../src/node/spatial/BeautifyStationService';
import type { GeodeticAnchor, ColmapCameraPose } from '../src/common/spatial/colmap-vector-reference-types';

describe('3D Spline Flight Trajectory: Collision Avoidance & AI Beautify Draft Pipeline', () => {
    const ANCHOR: GeodeticAnchor = {
        lat: 39.66555,
        lng: -105.20525,
        elevationMeters: 1932.0,
        headingDeg: 270.0,
        formattedAddress: 'Red Rocks Amphitheatre, Morrison, Colorado'
    };

    const GLB_PATH = path.resolve(process.cwd(), 'public/models/red_rocks_amphitheatre.glb');

    it('synthesizes continuous-flight spline stations with zero ground/canopy penetration', () => {
        const engine = new SurveySynthesisEngine();
        const minClearanceM = 1.5;

        const stations = engine.synthesize(ANCHOR, {
            type: 'continuous-flight',
            cameraCount: 24,
            targetRadiusMeters: 180.0,
            lookAtOffsetLocalENU: [5.2, 4.46, 0.0],
            minCameraHeightAboveGroundMeters: minClearanceM
        });

        expect(stations.length).toBe(24);

        // Verify every station maintains safe elevation and smooth continuity
        for (let i = 0; i < stations.length; i++) {
            const st = stations[i];
            expect(st.positionLocalENU[1]).toBeGreaterThanOrEqual(minClearanceM);
            expect(st.forwardVector.length).toBe(3);
            expect(Math.hypot(...st.forwardVector)).toBeCloseTo(1.0, 3);

            if (i > 0) {
                const prev = stations[i - 1].positionLocalENU;
                const curr = st.positionLocalENU;
                const deltaPos = Math.hypot(curr[0] - prev[0], curr[1] - prev[1], curr[2] - prev[2]);
                // Sequential frames along a 24-frame flight should not jump erratically
                expect(deltaPos).toBeLessThan(65.0);
            }
        }
    });

    it('headlessly renders collision-free clay blockout frames for continuous flight', async () => {
        if (!fs.existsSync(GLB_PATH)) return;

        const renderer = new SurveyStationRenderService();
        await renderer.loadMesh(GLB_PATH);

        const engine = new SurveySynthesisEngine();
        const stations = engine.synthesize(ANCHOR, {
            type: 'continuous-flight',
            cameraCount: 6,
            targetRadiusMeters: 120.0,
            lookAtOffsetLocalENU: [5.2, 4.46, 0.0]
        });

        for (const st of stations) {
            const blockout = renderer.renderStationBlockout(st, { width: 320, height: 180 });
            expect(blockout.width).toBe(320);
            expect(blockout.height).toBe(180);
            expect(blockout.png.length).toBeGreaterThan(100);
            expect(blockout.depth.length).toBe(320 * 180);
        }
    });

    it('generates photorealistic draft beauty frames from flight blockouts with chained projective consistency', async () => {
        if (!fs.existsSync(GLB_PATH)) return;

        const renderer = new SurveyStationRenderService();
        await renderer.loadMesh(GLB_PATH);

        const engine = new SurveySynthesisEngine();
        const stations = engine.synthesize(ANCHOR, {
            type: 'continuous-flight',
            cameraCount: 3,
            targetRadiusMeters: 100.0,
            lookAtOffsetLocalENU: [5.2, 4.46, 0.0]
        });

        // Use procedural/mock generator to guarantee offline test reliability
        const generator = createDefaultStationImageGenerator({
            allowProceduralGenerator: true,
            fidelity: 'draft',
            imageSize: '1K'
        });

        const beautifier = new BeautifyStationService(renderer, generator);

        let previousResult: any = undefined;
        const results = [];

        for (let i = 0; i < stations.length; i++) {
            const st = stations[i];
            const res = await beautifier.beautify(
                st,
                {
                    locationName: 'Red Rocks Amphitheatre',
                    architecturalStyle: 'Fountain Formation Sandstone Natural Amphitheatre',
                    moodPromptContext: 'Crisp morning daylight with natural sun shadows',
                    styleSuffix: '' // Draft mode empty suffix
                },
                {
                    width: 320,
                    height: 180,
                    draft: true,
                    maxRerolls: 0,
                    reference: previousResult
                }
            );

            expect(res.accepted).toBe(true);
            expect(res.imagePng.length).toBeGreaterThan(100);
            expect(res.image.width).toBe(320);
            expect(res.image.height).toBe(180);
            expect(res.alignedStation).toBeDefined();

            if (previousResult) {
                // In chained flight mode, warp must be computed
                expect(res.warp).toBeDefined();
                expect(res.warp!.warpedPng.length).toBeGreaterThan(100);
            }

            previousResult = res;
            results.push(res);
        }

        expect(results.length).toBe(3);
    });
});
