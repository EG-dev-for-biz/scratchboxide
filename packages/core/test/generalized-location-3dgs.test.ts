/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'path';
import * as fs from 'fs-extra';
import {
    calibrateStoneAlbedoRgba,
    encodePng,
    decodePng,
    type StoneAlbedoPreset
} from '../src/node/texture-processing';
import { SurveyStationRenderService } from '../src/node/spatial/SurveyStationRenderService';
import { SurveySynthesisEngine, stationFromLookAt } from '../src/common/spatial/SurveySynthesisEngine';
import { Location3DGaussianSplatService } from '../src/node/spatial/Location3DGaussianSplatService';
import type { GeodeticAnchor } from '../src/common/spatial/colmap-vector-reference-types';

describe('Generalized Location 3DGS Pipeline & Tools', () => {
    const TEST_DIR = path.resolve(process.cwd(), 'build/test_generalized_3dgs');

    beforeAll(async () => {
        await fs.ensureDir(TEST_DIR);
    });

    describe('1. Universal Stone Albedo & Radiometric De-Lighting Calibrator', () => {
        it('de-lights and calibrates authentic stone albedo for sandstone', () => {
            const width = 16, height = 16;
            const rawRgba = Buffer.alloc(width * height * 4);

            // Populate with a bluish/violet washed stone pixel (e.g. baked sky haze on rock)
            for (let i = 0; i < width * height; i++) {
                rawRgba[i * 4 + 0] = 100; // Red
                rawRgba[i * 4 + 1] = 90;  // Green
                rawRgba[i * 4 + 2] = 110; // Blue (excess atmospheric wash)
                rawRgba[i * 4 + 3] = 255;
            }

            const calibrated = calibrateStoneAlbedoRgba(rawRgba, width, height, {
                stoneType: 'sandstone',
                shadowLift: 0.60,
                highlightCompress: 0.45,
                hazeReduction: 0.50
            });

            expect(calibrated.length).toBe(rawRgba.length);
            // Sandstone should boost warm iron oxide (R) and attenuate atmospheric blue (B)
            expect(calibrated[0]).toBeGreaterThan(rawRgba[0]); // R boosted
            expect(calibrated[2]).toBeLessThan(rawRgba[2]);    // B attenuated
            expect(calibrated[3]).toBe(255);                   // Alpha preserved
        });

        it('supports travertine, limestone, marble, and neutral stone profiles', () => {
            const width = 8, height = 8;
            const rawRgba = Buffer.alloc(width * height * 4);
            rawRgba.fill(128);

            const profiles: StoneAlbedoPreset[] = ['travertine', 'limestone', 'marble', 'neutral', 'granite', 'concrete'];
            for (const stoneType of profiles) {
                const res = calibrateStoneAlbedoRgba(rawRgba, width, height, { stoneType });
                expect(res.length).toBe(rawRgba.length);
                expect(res[0]).toBeGreaterThan(0);
            }
        });
    });

    describe('2. SurveyStationRenderService: Unified Multi-Modal Provider', () => {
        const ANCHOR: GeodeticAnchor = {
            lat: 39.6655,
            lng: -105.2052,
            elevationMeters: 1932.0,
            headingDeg: 285.0
        };

        it('renders software clay blockouts using renderStation({ renderMode: "clay" })', async () => {
            const renderer = new SurveyStationRenderService();
            const glbPath = path.resolve(process.cwd(), 'public/models/red_rocks_amphitheatre.glb');
            if (!fs.existsSync(glbPath)) {
                return; // Skip if large model absent
            }
            await renderer.loadMesh(glbPath);

            const station = stationFromLookAt(
                1,
                [-20.0, 15.0, 0.0],
                [4.0, 6.0, 0.0],
                { focalLengthMm: 35, sensorWidthMm: 36 },
                ANCHOR
            );

            const render = await renderer.renderStation(station, {
                renderMode: 'clay',
                width: 320,
                height: 180
            });

            expect(render.width).toBe(320);
            expect(render.height).toBe(180);
            expect(render.depth.length).toBe(320 * 180);
            expect(render.depthKind).toBe('camera-z');
            expect(render.rgba.length).toBe(320 * 180 * 4);
            expect(render.png.length).toBeGreaterThan(100);
        });

        it('renders path-traced albedo and depth using renderStation({ renderMode: "albedo" })', async () => {
            const renderer = new SurveyStationRenderService();
            const glbPath = path.resolve(process.cwd(), 'public/models/red_rocks_amphitheatre.glb');
            if (!fs.existsSync(glbPath)) {
                return;
            }
            await renderer.loadMesh(glbPath);

            const station = stationFromLookAt(
                1,
                [-20.0, 15.0, 0.0],
                [4.0, 6.0, 0.0],
                { focalLengthMm: 35, sensorWidthMm: 36 },
                ANCHOR
            );

            const render = await renderer.renderStation(station, {
                renderMode: 'albedo',
                glbPath,
                width: 320,
                height: 180,
                samplesPerPixel: 1,
                stoneType: 'sandstone'
            });

            expect(render.width).toBe(320);
            expect(render.height).toBe(180);
            expect(render.depth.length).toBe(320 * 180);
            expect(render.depthKind).toBe('camera-z');
            expect(render.rgba.length).toBe(320 * 180 * 4);
            expect(render.png.length).toBeGreaterThan(100);
            // Verify depth is valid metric values
            let validDepths = 0;
            for (let i = 0; i < render.depth.length; i++) {
                if (render.depth[i] > 0.5 && render.depth[i] < 500.0) validDepths++;
            }
            expect(validDepths).toBeGreaterThan(1000);
        });
    });

    describe('3. Location3DGaussianSplatService: Zero-Preset Survey Pattern Configuration', () => {
        const ANCHOR: GeodeticAnchor = {
            lat: 41.8902,
            lng: 12.4922,
            elevationMeters: 50.0,
            headingDeg: 180.0,
            formattedAddress: 'Colosseum, Rome, Italy'
        };

        it('dynamically generates amphitheatre-complete survey pattern across 5 altitude tiers', () => {
            const engine = new SurveySynthesisEngine();
            const stations = engine.synthesize(ANCHOR, {
                type: 'amphitheatre-complete',
                cameraCount: 24,
                targetRadiusMeters: 90.0,
                aspectRatioXZ: 1.18,
                focalLengthMm: 35
            });

            expect(stations.length).toBe(24);
            const tierIndices = new Set(stations.map(s => s.name.split('_')[2]));
            expect(tierIndices.size).toBeGreaterThanOrEqual(3);
        });

        it('dynamically generates district-complete survey pattern across hierarchical tiers including nadir grid', () => {
            const engine = new SurveySynthesisEngine();
            const stations = engine.synthesize(ANCHOR, {
                type: 'district-complete',
                cameraCount: 48,
                targetRadiusMeters: 280.0,
                focalLengthMm: 35
            });

            expect(stations.length).toBe(48);
            const hasFocal = stations.some(s => s.name.includes('TIER_1_FOCAL'));
            const hasRoof = stations.some(s => s.name.includes('TIER_2_ROOF'));
            const hasSoffit = stations.some(s => s.name.includes('TIER_3_SOFFIT'));
            const hasBasin = stations.some(s => s.name.includes('TIER_4_OBLIQUE_BASIN'));
            const hasPerimeter = stations.some(s => s.name.includes('TIER_5_PERIMETER'));
            const hasNadir = stations.some(s => s.name.includes('TIER_6_NADIR'));

            expect(hasFocal).toBe(true);
            expect(hasRoof).toBe(true);
            expect(hasSoffit).toBe(true);
            expect(hasBasin).toBe(true);
            expect(hasPerimeter).toBe(true);
            expect(hasNadir).toBe(true);
        });

        it('dynamically generates continuous-flight survey pattern with smooth kinematic spline interpolation', () => {
            const engine = new SurveySynthesisEngine();
            const stations = engine.synthesize(ANCHOR, {
                type: 'continuous-flight',
                cameraCount: 36,
                targetRadiusMeters: 150.0,
                focalLengthMm: 35
            });

            expect(stations.length).toBe(36);
            for (let i = 0; i < stations.length; i++) {
                expect(stations[i].name).toBe(`FLIGHT_FRAME_${String(i + 1).padStart(3, '0')}`);
                expect(stations[i].positionLocalENU[1]).toBeGreaterThanOrEqual(1.5);
                // Verify sequential spatial proximity (distance between consecutive frames should be smooth, not jumping randomly)
                if (i > 0) {
                    const prev = stations[i - 1].positionLocalENU;
                    const curr = stations[i].positionLocalENU;
                    const stepDist = Math.hypot(curr[0] - prev[0], curr[1] - prev[1], curr[2] - prev[2]);
                    expect(stepDist).toBeLessThan(45.0); // Smooth continuous movement
                }
            }
        });

        it('synthesizes multi-station location splats using generalized parameters', async () => {
            const svc = new Location3DGaussianSplatService();
            const glbPath = path.resolve(process.cwd(), 'public/models/red_rocks_amphitheatre.glb');
            if (!fs.existsSync(glbPath)) {
                return;
            }

            // Test location specification with explicit survey pattern and stone calibration
            const res = await svc.synthesize({
                location: 'Red Rocks Amphitheatre',
                lat: 39.6655,
                lng: -105.2052,
                elevation: 1932.0,
                cameraCount: 4,
                surveyPattern: 'orbital-multi-tier',
                stoneType: 'sandstone',
                use2dgs: true,
                bakeStride: 2,
                outDir: path.join(TEST_DIR, 'red_rocks_generalized'),
                forceRebake: false
            });

            expect(res.success).toBe(true);
            expect(res.splatCount).toBeGreaterThan(10000);
            expect(fs.existsSync(res.splatPath)).toBe(true);
            expect(fs.existsSync(res.tilesetPath)).toBe(true);
        });

        it('supports draft mode with empty style suffix for fast iteration', async () => {
            const svc = new Location3DGaussianSplatService();
            let capturedPrompt = '';
            let capturedFidelity: string | undefined;

            const dummyGenerator = {
                name: 'test-draft-generator',
                fidelity: 'draft' as const,
                async generate(args: { prompt: string; blockoutPng: Buffer }) {
                    capturedPrompt = args.prompt;
                    return args.blockoutPng;
                }
            };

            const glbPath = path.resolve(process.cwd(), 'public/models/red_rocks_amphitheatre.glb');
            if (!fs.existsSync(glbPath)) return;

            const res = await svc.generate({
                location: 'Red Rocks Amphitheatre',
                lat: 39.6655,
                lng: -105.2052,
                cameraCount: 2,
                draft: true,
                styleSuffix: '', // explicitly empty
                generator: dummyGenerator,
                outDir: path.join(TEST_DIR, 'red_rocks_draft_test'),
                forceRebake: true
            });

            expect(res.success).toBe(true);
            // Verify styleSuffix is omitted from prompt
            expect(capturedPrompt).not.toContain('Editorial architectural');
            expect(capturedPrompt).not.toContain('cinematic-film');
            expect(capturedPrompt).toContain('CRITICAL FRAMING RULES');
        });
    });
});
