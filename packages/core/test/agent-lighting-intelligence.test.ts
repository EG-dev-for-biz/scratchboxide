/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import {
    stopsToRatio,
    ratioToStops,
    evToLux,
    luxToEv,
    candelasToLux,
    luxToCandelas,
    lumensToCandelas,
    calculatePenumbraSoftness,
    planckianKelvinToRgb,
    rgbToPlanckianKelvin
} from '../src/common/spatial/photometric-units';

describe('Agent Lighting Intelligence - Unit 1: Photometric Math & Units', () => {
    describe('Photographic Stop Ratios (Inverse Square & Exposure Stops)', () => {
        it('should convert exposure stops to linear illuminance ratio', () => {
            expect(stopsToRatio(0)).toBe(1.0);
            expect(stopsToRatio(1)).toBe(2.0);
            expect(stopsToRatio(2)).toBe(4.0); // 4:1 key-to-fill = 2 stops
            expect(stopsToRatio(3)).toBe(8.0);
            expect(stopsToRatio(-1)).toBe(0.5);
            expect(stopsToRatio(-2)).toBe(0.25);
        });

        it('should convert linear illuminance ratio back to exposure stops', () => {
            expect(ratioToStops(1.0)).toBeCloseTo(0.0, 5);
            expect(ratioToStops(2.0)).toBeCloseTo(1.0, 5);
            expect(ratioToStops(4.0)).toBeCloseTo(2.0, 5);
            expect(ratioToStops(8.0)).toBeCloseTo(3.0, 5);
            expect(ratioToStops(16.0)).toBeCloseTo(4.0, 5);
        });
    });

    describe('Exposure Value (EV) & Lux Conversions', () => {
        it('should correctly convert EV100 to lux (incident light meter standard)', () => {
            // EV 0 at ISO 100 is ~2.5 lux
            expect(evToLux(0)).toBeCloseTo(2.5, 2);
            // Midday sunlight ~EV 15 -> ~81,920 lux
            const middayLux = evToLux(15);
            expect(middayLux).toBeGreaterThan(80000);
            expect(middayLux).toBeLessThan(85000);

            // Invert back to EV
            expect(luxToEv(middayLux)).toBeCloseTo(15.0, 2);
            expect(luxToEv(2.5)).toBeCloseTo(0.0, 2);
        });
    });

    describe('Candelas, Lumens, and Inverse-Square Distance Falloff', () => {
        it('should compute illuminance at distance using inverse-square law', () => {
            const intensityCandelas = 1000.0;
            // E = I / d^2
            expect(candelasToLux(intensityCandelas, 1.0)).toBe(1000.0);
            expect(candelasToLux(intensityCandelas, 2.0)).toBe(250.0);
            expect(candelasToLux(intensityCandelas, 10.0)).toBe(10.0);

            // Invert back to Candelas
            expect(luxToCandelas(250.0, 2.0)).toBe(1000.0);
        });

        it('should compute candelas from lumens over cone apex angle', () => {
            // 1000 lumens distributed into 60-degree cone (pi/3 radians)
            const cd = lumensToCandelas(1000.0, Math.PI / 3);
            expect(cd).toBeGreaterThan(1100);
            expect(cd).toBeLessThan(1250);
        });

        it('should compute geometric shadow penumbra width based on light source size', () => {
            // Large softbox (0.6m radius), 2m to subject, 1m from subject to floor
            // Penumbra = 2 * r_light * (d_floor / d_light) = 2 * 0.6 * (1.0 / 2.0) = 0.6m
            const penumbraSoftbox = calculatePenumbraSoftness(0.6, 2.0, 1.0);
            expect(penumbraSoftbox).toBeCloseTo(0.6, 2);

            // Point source (0.01m radius) at same distance produces sharp penumbra (0.01m)
            const penumbraPoint = calculatePenumbraSoftness(0.01, 2.0, 1.0);
            expect(penumbraPoint).toBeCloseTo(0.01, 2);
            expect(penumbraSoftbox).toBeGreaterThan(penumbraPoint * 50);
        });
    });

    describe('Planckian Locus Blackbody CCT Radiometry', () => {
        it('should convert Kelvin to linear RGB and match color standards', () => {
            const candle = planckianKelvinToRgb(1850);
            expect(candle.r).toBeGreaterThan(candle.g);
            expect(candle.g).toBeGreaterThan(candle.b);
            expect(candle.b).toBeLessThan(0.1); // warm red/amber

            const d65Noon = planckianKelvinToRgb(6500);
            expect(d65Noon.r).toBeCloseTo(d65Noon.g, 1);
            expect(d65Noon.g).toBeCloseTo(d65Noon.b, 1); // neutral white

            const skyBlue = planckianKelvinToRgb(10000);
            expect(skyBlue.b).toBeGreaterThan(skyBlue.r); // cool blue
        });

        it('should invert RGB chromaticity back to Kelvin via McCamy approximation', () => {
            expect(rgbToPlanckianKelvin(255, 140, 40)).toBeLessThan(2500); // candle/tungsten
            expect(rgbToPlanckianKelvin(250, 248, 255)).toBeGreaterThan(6000); // noon
            expect(rgbToPlanckianKelvin(120, 170, 255)).toBeGreaterThan(9000); // zenith blue
        });
    });
});

describe('Agent Lighting Intelligence - Unit 2: Photographic Gaffer Engine & Modifiers', () => {
    it('should build a calibrated Rembrandt lighting rig with exact 4:1 (2-stop) ratio', async () => {
        const { LightingGafferService } = await import('../src/browser/generative-canvas/services/atmosphere/LightingGafferService');
        const rig = LightingGafferService.buildGafferRig('rembrandt', {
            keyToFillRatio: 4.0,
            keyKelvin: 4200,
            fillKelvin: 7500,
            subjectPosition: [0, 1, 0],
            goboCookie: 'venetian_blinds'
        });

        expect(rig.style).toBe('rembrandt');
        expect(rig.keyToFillRatio).toBe(4.0);
        expect(rig.keyToFillStops).toBe(2.0);

        const key = rig.lights.find(l => l.role === 'key');
        const fill = rig.lights.find(l => l.role === 'fill');
        const rim = rig.lights.find(l => l.role === 'rim');

        expect(key).toBeDefined();
        expect(fill).toBeDefined();
        expect(rim).toBeDefined();

        // Key light should be ~45 degrees from subject
        expect(key!.cctKelvin).toBe(4200);
        expect(key!.goboCookieTexture).toBe('venetian_blinds');
        expect(key!.castShadow).toBe(true);

        // Fill light should be 2 stops lower (-2.0) than key
        expect(fill!.exposureStopsDelta).toBe(-2.0);
        expect(fill!.cctKelvin).toBe(7500);
        expect(fill!.castShadow).toBe(false); // Fill should never cast secondary harsh shadows
    });

    it('should build a Paramount/Butterfly glamour rig with high frontal key', async () => {
        const { LightingGafferService } = await import('../src/browser/generative-canvas/services/atmosphere/LightingGafferService');
        const rig = LightingGafferService.buildGafferRig('butterfly', {
            keyToFillRatio: 2.0,
            keyKelvin: 5600
        });

        expect(rig.style).toBe('butterfly');
        expect(rig.keyToFillRatio).toBe(2.0);
        expect(rig.keyToFillStops).toBe(1.0);

        const key = rig.lights.find(l => l.role === 'key');
        expect(key).toBeDefined();
        // High frontal key: X near 0, Y significantly higher than Z
        expect(Math.abs(key!.position[0])).toBeLessThan(0.5);
        expect(key!.position[1]).toBeGreaterThan(key!.position[2] * 0.8);
    });

    it('should generate procedural gobo patterns as clean SVG data URIs', async () => {
        const { LightingGafferService } = await import('../src/browser/generative-canvas/services/atmosphere/LightingGafferService');
        const venetian = LightingGafferService.createProceduralGoboDataUri('venetian_blinds');
        expect(venetian).toContain('data:image/svg+xml');
        expect(decodeURIComponent(venetian)).toContain('<rect');

        const windowMullions = LightingGafferService.createProceduralGoboDataUri('window_mullions');
        expect(windowMullions).toContain('data:image/svg+xml');
        expect(decodeURIComponent(windowMullions)).toContain('<path');

        const treeCanopy = LightingGafferService.createProceduralGoboDataUri('tree_canopy');
        expect(treeCanopy).toContain('data:image/svg+xml');
        expect(decodeURIComponent(treeCanopy)).toContain('<circle');
    });
});

describe('Agent Lighting Intelligence - Unit 3: Inverse Photometric Image Decomposer', () => {
    it('should inversely estimate key light direction from ground cast shadows', async () => {
        const { InverseLightingEstimatorService } = await import('../src/node/spatial/InverseLightingEstimatorService');

        const width = 100;
        const height = 100;
        const pixels = new Uint8Array(width * height * 4);

        // Populate a scene with illuminated warm ground (bottom half) and a shadow on the left side
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = (y * width + x) * 4;
                if (y < 40) {
                    // Sky region (blueish)
                    pixels[idx] = 120;
                    pixels[idx + 1] = 170;
                    pixels[idx + 2] = 230;
                    pixels[idx + 3] = 255;
                } else {
                    // Ground plane: base is warm stone
                    const isShadow = (x >= 15 && x <= 45 && y >= 60 && y <= 90);
                    if (isShadow) {
                        // Cast shadow: significantly darker, tinted with sky ambient
                        pixels[idx] = 45;
                        pixels[idx + 1] = 55;
                        pixels[idx + 2] = 80;
                        pixels[idx + 3] = 255;
                    } else {
                        // Direct sunlight: bright warm travertine
                        pixels[idx] = 230;
                        pixels[idx + 1] = 210;
                        pixels[idx + 2] = 175;
                        pixels[idx + 3] = 255;
                    }
                }
            }
        }

        const result = await InverseLightingEstimatorService.decomposePixels(pixels, width, height, {
            hfovDeg: 60,
            vfovDeg: 45
        });

        expect(result.success).toBe(true);
        expect(result.keyLight).toBeDefined();
        // Since the shadow is on the left (x=15..45), the light source must be on the right (azimuth > 180° or positive X)
        expect(result.keyLight.direction[0]).toBeLessThan(0); // light travels right-to-left
        expect(result.keyLight.cctKelvin).toBeGreaterThan(3000);
        expect(result.keyLight.cctKelvin).toBeLessThan(6500);

        // Spherical harmonics ambient should have 9 coefficients for each RGB channel
        expect(result.sphericalHarmonics).toBeDefined();
        expect(result.sphericalHarmonics.length).toBe(9);
        expect(result.sphericalHarmonics[0].length).toBe(3);

        // Shadow penumbra analysis
        expect(result.shadowSharpness).toBeDefined();
        expect(result.rig).toBeDefined();
        expect(result.rig.lights.length).toBeGreaterThanOrEqual(2); // At least key and fill
    });
});

describe('Agent Lighting Intelligence - Unit 4: Closed-Loop Photometric Matchmove Optimizer', () => {
    it('should iteratively optimize perturbed lighting rig to achieve >=95% photometric correlation', async () => {
        const { ClosedLoopLightingOptimizerService } = await import('../src/node/spatial/ClosedLoopLightingOptimizerService');
        const { LightingGafferService } = await import('../src/browser/generative-canvas/services/atmosphere/LightingGafferService');

        const width = 64;
        const height = 64;

        // Ground-truth lighting: azimuth 135 deg, elevation 45 deg
        const groundTruthAzimuth = 135.0;
        const groundTruthElevation = 45.0;

        // Generate synthetic reference target plate with known ground-truth shadow
        const targetPixels = ClosedLoopLightingOptimizerService.renderSyntheticShadowPlate(
            width,
            height,
            groundTruthAzimuth,
            groundTruthElevation
        );

        // Initial hypothesis perturbed by +15° azimuth and -10° elevation
        const perturbedAzimuth = 150.0;
        const perturbedElevation = 35.0;
        const initialRig = LightingGafferService.buildGafferRig('three_point', {
            keyToFillRatio: 3.0
        });

        // Mutate initial key to perturbed angles
        const key = initialRig.lights.find(l => l.role === 'key');
        if (key) {
            key.position = [
                Math.sin(perturbedAzimuth * Math.PI / 180) * 10,
                Math.sin(perturbedElevation * Math.PI / 180) * 10,
                Math.cos(perturbedAzimuth * Math.PI / 180) * 10
            ];
        }

        const optimization = await ClosedLoopLightingOptimizerService.optimizeSyntheticPlate(
            targetPixels,
            width,
            height,
            initialRig,
            {
                maxIterations: 20,
                targetCorrelationScore: 0.95
            }
        );

        expect(optimization.success).toBe(true);
        expect(optimization.finalCorrelationScore).toBeGreaterThanOrEqual(0.95);
        expect(optimization.iterations).toBeLessThanOrEqual(20);
        expect(optimization.optimizedRig).toBeDefined();
        expect(optimization.resectedAzimuthDeg).toBeCloseTo(groundTruthAzimuth, 0); // Within ~1-2 degrees
        expect(optimization.resectedElevationDeg).toBeCloseTo(groundTruthElevation, 0);
    });
});

describe('Agent Lighting Intelligence - Unit 5: Gemini Agent Domain Pack & Operator Routing', () => {
    it('should expose lighting tool declarations and execute lighting_configure_gaffer_rig handler', async () => {
        const { LIGHTING_TOOL_DECLARATIONS, lightingHandlers } = await import('../src/node/gemini/tools/lighting-tools');

        const toolNames = LIGHTING_TOOL_DECLARATIONS.map(t => t.name);
        expect(toolNames).toContain('lighting_estimate_from_photo');
        expect(toolNames).toContain('lighting_configure_gaffer_rig');
        expect(toolNames).toContain('lighting_optimize_closed_loop');

        const handler = lightingHandlers.lighting_configure_gaffer_rig;
        const res = await handler({
            style: 'noir',
            keyToFillRatio: 8.0,
            keyKelvin: 3800
        }, {} as any);

        expect(res.resultPayload).toBeDefined();
        expect(res.resultPayload.success).toBe(true);
        expect(res.resultPayload.style).toBe('noir');
        expect(res.resultPayload.keyToFillRatio).toBe(8.0);
        expect(res.resultPayload.keyToFillStops).toBe(3.0);
        expect(res.summaryResult).toContain('NOIR');
        expect(res.summaryResult).toContain('8:1');
    });

    it('should execute lighting_optimize_closed_loop handler and report convergence score', async () => {
        const { lightingHandlers } = await import('../src/node/gemini/tools/lighting-tools');
        const handler = lightingHandlers.lighting_optimize_closed_loop;

        const res = await handler({
            targetImagePath: 'mock_target.png',
            initialRigStyle: 'three_point',
            targetCorrelationScore: 0.95,
            maxIterations: 15
        }, {} as any);

        expect(res.resultPayload.success).toBe(true);
        expect(res.resultPayload.finalCorrelationScore).toBeGreaterThanOrEqual(0.95);
        expect(res.summaryResult).toContain('Closed-loop lighting optimization converged');
        expect(res.summaryResult).toContain('% correlation');
    });

    it('should route cinematic lighting requests to Tier 1 native capabilities via task-capability-resolver', async () => {
        const { resolveTaskCapability } = await import('../src/node/agent/task-capability-resolver');

        const capability = await resolveTaskCapability({
            userGoal: 'Create a dramatic Rembrandt lighting setup with a 4:1 key-to-fill ratio and venetian blinds shadow'
        });

        expect(capability.tier).toBe('tier1-native');
        expect(capability.tier1Assessment.canSolveNatively).toBe(true);
        expect(capability.tier1Assessment.primaryNativeEngine).toBe('threejs-webgl');
        expect(capability.tier1Assessment.nativeCapabilitiesUsed.some(c => c.includes('LightingGafferService'))).toBe(true);
        expect(capability.tier1Assessment.suggestedNativeAction?.details).toContain('lighting_configure_gaffer_rig');
    });
});

describe('Agent Lighting Intelligence - Unit 6: Acceptance Examples AE1 - AE4', () => {
    it('AE1: Golden Hour Historical Validation (NOAA Ephemeris & Diurnal Radiometry)', async () => {
        const { calculateNOAASolarPosition, computeDiurnalLightingProfile } = await import('../src/browser/generative-canvas/services/atmosphere');

        // San Francisco Summer Solstice Midday
        const sfMidday = calculateNOAASolarPosition(new Date('2026-06-21T20:00:00Z'), 37.77, -122.41);
        expect(sfMidday.elevationDeg).toBeGreaterThan(45.0);
        expect(sfMidday.azimuthDeg).toBeGreaterThan(0.0);
        expect(sfMidday.azimuthDeg).toBeLessThan(360.0);

        // Golden hour elevation test (6.5 degrees)
        const goldenHourElevation = 6.5;
        const diurnal = computeDiurnalLightingProfile(goldenHourElevation);
        expect(diurnal.phase).toBe('Golden Hour');
        expect(diurnal.kelvinTemperature).toBeGreaterThanOrEqual(2000);
        expect(diurnal.kelvinTemperature).toBeLessThanOrEqual(4500);
    });

    it('AE2: 4:1 Dramatic Portrait Contrast Ratio', async () => {
        const { LightingGafferService } = await import('../src/browser/generative-canvas/services/atmosphere/LightingGafferService');

        const rig = LightingGafferService.buildGafferRig('rembrandt', { keyToFillRatio: 4.0 });
        expect(rig.keyToFillRatio).toBe(4.0);
        expect(rig.keyToFillStops).toBe(2.0);

        const key = rig.lights.find(l => l.role === 'key')!;
        const fill = rig.lights.find(l => l.role === 'fill')!;

        expect(key.intensityLux! / fill.intensityLux!).toBeCloseTo(4.0, 1);
        expect(fill.castShadow).toBe(false);
    });

    it('AE3: Inverse Photograph Shadow & Sun Vector Resection', async () => {
        const { ClosedLoopLightingOptimizerService } = await import('../src/node/spatial/ClosedLoopLightingOptimizerService');
        const { LightingGafferService } = await import('../src/browser/generative-canvas/services/atmosphere/LightingGafferService');

        const width = 64;
        const height = 64;
        const groundTruthAzimuth = 135.0;
        const groundTruthElevation = 45.0;

        const targetPlate = ClosedLoopLightingOptimizerService.renderSyntheticShadowPlate(
            width, height, groundTruthAzimuth, groundTruthElevation
        );

        const initialRig = LightingGafferService.buildGafferRig('three_point');
        const opt = await ClosedLoopLightingOptimizerService.optimizeSyntheticPlate(
            targetPlate, width, height, initialRig, { maxIterations: 20, targetCorrelationScore: 0.95 }
        );

        expect(opt.success).toBe(true);
        expect(opt.finalCorrelationScore).toBeGreaterThanOrEqual(0.95);
        expect(Math.abs(opt.resectedAzimuthDeg - groundTruthAzimuth)).toBeLessThanOrEqual(2.5);
    });

    it('AE4: De-Lighted Google 3D Tile Ingestion', async () => {
        const { harmonizeLocationObjectAtmosphere } = await import('../src/browser/generative-canvas/services/atmosphere');

        const harmonization = harmonizeLocationObjectAtmosphere({
            landmarkName: 'Colosseum, Rome',
            preset: 'civil_twilight_dusk',
            stoneType: 'travertine',
            enableArchitecturalBacklighting: true
        });

        expect(harmonization.delightUniforms.uShadowLift).toBeGreaterThanOrEqual(0.50);
        expect(harmonization.delightUniforms.uHighlightCompress).toBeGreaterThanOrEqual(0.40);
        expect(harmonization.delightUniforms.uStoneAlbedoTint[0]).toBeCloseTo(0.86, 1);
        expect(harmonization.architecturalFixtures.length).toBeGreaterThan(0);
    });
});





