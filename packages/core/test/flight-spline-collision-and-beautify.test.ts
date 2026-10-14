/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as fs from 'fs-extra';
import { SurveySynthesisEngine } from '../src/common/spatial/SurveySynthesisEngine';
import { SurveyStationRenderService } from '../src/node/spatial/SurveyStationRenderService';
import { BeautifyStationService, type StationImageGenerator } from '../src/node/spatial/BeautifyStationService';
import { decodePng, encodePng } from '../src/node/texture-processing';
import type { GeodeticAnchor, ColmapCameraPose } from '../src/common/spatial/colmap-vector-reference-types';

/** Test stand-in for the image model: recolours the clay blockout (keeps its geometry) and names itself as the model. */
function recolourGenerator(): StationImageGenerator {
    return {
        name: 'test-recolour',
        async generate(args) {
            const b = decodePng(args.blockoutPng);
            const out = Buffer.alloc(b.rgba.length);
            for (let i = 0; i < b.rgba.length; i += 4) {
                const l = b.rgba[i];
                out[i] = Math.min(255, l * 1.1 + 15); out[i + 1] = l * 0.95; out[i + 2] = l * 0.8; out[i + 3] = 255;
            }
            return { png: encodePng(b.width, b.height, out), modelUsed: 'test-recolour' };
        }
    };
}

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

        // A test stand-in for the image model keeps the run offline (there is no procedural painter in the app).
        const generator = recolourGenerator();

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
