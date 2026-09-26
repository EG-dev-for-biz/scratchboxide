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
import * as fs from 'fs';
import {
    PhotometricUsdBridgeService,
    type UsdExportOptions,
    matchLightingToReference,
    matchImageAndLightingToLocation,
    type MatchLightingReferenceOptions
} from '../src/node/spatial/PhotometricUsdBridgeService';
import {
    PhotometricLightingRigData,
    planckianKelvinToRgb
} from '../src/common/spatial/photometric-units';
import { LightingGafferService } from '../src/browser/generative-canvas/services/atmosphere/LightingGafferService';
import { LIGHTING_TOOL_DECLARATIONS, lightingHandlers } from '../src/node/gemini/tools/lighting-tools';

describe('Photometric OpenUSD Bridge & Reference Lighting Matching Suite', () => {

    const sampleRig: PhotometricLightingRigData = {
        rigId: 'rig_plaza_afternoon',
        name: 'The Plaza Hotel Calibrated Afternoon Lighting',
        style: 'daylight',
        keyToFillRatio: 3.5,
        keyToFillStops: 1.8,
        ambientSphericalHarmonics: [
            [0.28, 0.32, 0.38],
            [0.05, 0.06, 0.08],
            [0.02, 0.03, 0.04],
            [0.01, 0.01, 0.02],
            [0.00, 0.00, 0.00],
            [0.00, 0.00, 0.00],
            [0.00, 0.00, 0.00],
            [0.00, 0.00, 0.00],
            [0.00, 0.00, 0.00]
        ],
        lights: [
            {
                id: 'key_sun',
                name: 'Direct Sunlight (Key)',
                type: 'directional',
                role: 'key',
                position: [56.0, 100.0, 80.0],
                direction: [-0.35, -0.72, -0.59],
                cctKelvin: 5200,
                colorLinearRgb: [1.0, 0.92, 0.82],
                intensityLux: 82000.0,
                penumbraSoftness: 0.22,
                castShadow: true,
                shadowBias: 0.0005
            },
            {
                id: 'fill_sky',
                name: 'Sky Hemisphere (Fill)',
                type: 'area_rect',
                role: 'fill',
                position: [-40.0, 50.0, -30.0],
                direction: [0.35, -0.65, 0.55],
                cctKelvin: 7200,
                colorLinearRgb: [0.72, 0.85, 1.0],
                intensityLux: 23400.0,
                exposureStopsDelta: -1.8,
                penumbraSoftness: 0.95,
                castShadow: false
            }
        ]
    };

    const sampleCamera = {
        position: [52.0, 3.0, 24.0] as [number, number, number],
        target: [28.0, 48.0, 8.0] as [number, number, number],
        fovDeg: 54.0,
        focalLengthMm: 28.0,
        sensorWidthMm: 36.0,
        sensorHeightMm: 24.0
    };

    // -------------------------------------------------------------------------
    // Unit 1: OpenUSD (.usda) Schema Export & Validation
    // -------------------------------------------------------------------------
    describe('1. OpenUSD UsdLux Document Generation', () => {
        it('should generate valid ASCII OpenUSD (.usda) conforming to UsdLux specifications', () => {
            const usda = PhotometricUsdBridgeService.generateUsda(sampleRig, {
                camera: sampleCamera,
                assetName: 'ThePlazaHotel'
            });

            expect(usda).toContain('#usda 1.0');
            expect(usda).toContain('def "World"');
            expect(usda).toContain('def UsdLuxDistantLight "key_sun"');
            expect(usda).toContain('inputs:intensity = 82000');
            expect(usda).toContain('inputs:colorTemperature = 5200');
            expect(usda).toContain('inputs:enableColorTemperature = 1');
            expect(usda).toContain('def UsdLuxRectLight "fill_sky"');
            expect(usda).toContain('def Camera "ResectedCamera"');
            expect(usda).toContain('focalLength = 28');
            expect(usda).toContain('horizontalAperture = 36');
        });

        it('should export USDA and MaterialX files to disk cleanly', () => {
            const outUsdPath = path.join(process.cwd(), 'public/data/test_lighting_export.usda');
            const result = PhotometricUsdBridgeService.exportToUsd(sampleRig, {
                outputPath: outUsdPath,
                camera: sampleCamera,
                exportMaterialX: true
            });

            expect(result.success).toBe(true);
            expect(fs.existsSync(outUsdPath)).toBe(true);
            expect(result.usdaFilePath).toBe(outUsdPath);
            expect(result.mtlxFilePath).toBeDefined();
            expect(fs.existsSync(result.mtlxFilePath!)).toBe(true);

            // Clean up
            try {
                fs.unlinkSync(outUsdPath);
                if (result.mtlxFilePath) fs.unlinkSync(result.mtlxFilePath);
            } catch (e) {}
        });
    });

    // -------------------------------------------------------------------------
    // Unit 2: MaterialX (.mtlx) Document Generation
    // -------------------------------------------------------------------------
    describe('2. MaterialX Document Generation', () => {
        it('should generate valid MaterialX XML conforming to standard surface schema', () => {
            const mtlx = PhotometricUsdBridgeService.generateMaterialX({
                materialName: 'PlazaTravertine',
                stoneType: 'travertine',
                roughness: 0.82,
                delightUniforms: {
                    uShadowLift: 0.60,
                    uHighlightCompress: 0.45
                }
            });

            expect(mtlx).toContain('<?xml version="1.0"?>');
            expect(mtlx).toContain('<materialx version="1.38">');
            expect(mtlx).toContain('standard_surface');
            expect(mtlx).toContain('name="base_color"');
            expect(mtlx).toContain('surfacematerial');
        });
    });

    // -------------------------------------------------------------------------
    // Unit 3: Automated Reference Image Lighting Matching
    // -------------------------------------------------------------------------
    describe('3. Automated matchLightingToReference Pipeline', () => {
        it('should analyze reference image, solve physical light angles, and build matching rig', async () => {
            const testImgPath = path.join(process.cwd(), 'public/test_images/the_plaza_hotel_user_photo.jpg');
            const result = await matchLightingToReference({
                imagePath: testImgPath,
                landmarkName: 'The Plaza Hotel',
                geodeticCoords: { lat: 40.7646, lng: -73.9743 },
                cameraHeadingDeg: 215.3,
                cameraPitchDeg: 5.2,
                stoneType: 'travertine',
                autoExportUsd: true
            });

            expect(result.success).toBe(true);
            expect(result.rig).toBeDefined();
            expect(result.rig.lights.length).toBeGreaterThanOrEqual(2);

            // Key light must be physically populated
            const key = result.rig.lights.find(l => l.role === 'key');
            expect(key).toBeDefined();
            expect(key!.cctKelvin).toBeGreaterThan(2500);
            expect(key!.cctKelvin).toBeLessThan(7500);
            expect(key!.intensityLux).toBeGreaterThan(1000);

            // Three.js shader uniforms must be populated for direct viewport injection
            expect(result.threeJsUniforms).toBeDefined();
            expect(result.threeJsUniforms.uSunDirection).toBeDefined();
            expect(result.threeJsUniforms.uSunColor).toBeDefined();
            expect(result.threeJsUniforms.uShadowLift).toBeGreaterThan(0.1);

            // USD export file verified
            expect(result.usdExportPath).toBeDefined();
            expect(fs.existsSync(result.usdExportPath!)).toBe(true);

            // Clean up test file
            try {
                if (result.usdExportPath) fs.unlinkSync(result.usdExportPath);
            } catch (e) {}
        });
    });

    // -------------------------------------------------------------------------
    // Unit 4: Gemini Agent Tools Integration
    // -------------------------------------------------------------------------
    describe('4. Gemini Agent Tool Declarations and Handlers', () => {
        it('should register lighting_export_usd and lighting_match_reference tools', () => {
            const toolNames = LIGHTING_TOOL_DECLARATIONS.map(t => t.name);
            expect(toolNames).toContain('lighting_export_usd');
            expect(toolNames).toContain('lighting_match_reference');
        });

        it('should execute lighting_match_reference handler cleanly', async () => {
            const testImgPath = path.join(process.cwd(), 'public/test_images/the_plaza_hotel_user_photo.jpg');
            const handler = lightingHandlers.lighting_match_reference;
            const res = await handler({
                imagePath: testImgPath,
                landmarkName: 'The Plaza Hotel',
                stoneType: 'travertine'
            }, {} as any);

            expect(res.resultPayload).toBeDefined();
            expect(res.resultPayload.success).toBe(true);
            expect(res.resultPayload.rig).toBeDefined();
            expect(res.summaryResult).toContain('Matched physical scene lighting to reference');
        });
    });

    // -------------------------------------------------------------------------
    // Unit 5: Match Image and Lighting to Existing Matched Location
    // -------------------------------------------------------------------------
    describe('5. Match Image and Lighting to Established Location', () => {
        it('should inversely light scene and align camera from image after location match is made', async () => {
            const testImgPath = path.join(process.cwd(), 'public/test_images/the_plaza_hotel_user_photo.jpg');
            const result = await matchImageAndLightingToLocation({
                imagePath: testImgPath,
                locationName: 'The Plaza Hotel',
                geodeticCoords: { lat: 40.7646, lng: -73.9743, altitudeMeters: 18.0 },
                autoAlignCamera: true,
                autoExportUsd: true
            });

            expect(result.success).toBe(true);
            expect(result.location.name).toContain('The Plaza');
            expect(result.lightingRig).toBeDefined();
            expect(result.threeJsUniforms).toBeDefined();
            expect(result.cameraPose).toBeDefined();
            expect(result.cameraPose?.standoffMeters).toBeGreaterThan(10);
            expect(result.usdExportPath).toBeDefined();
            expect(fs.existsSync(result.usdExportPath!)).toBe(true);

            // Clean up
            try {
                if (result.usdExportPath) fs.unlinkSync(result.usdExportPath);
                if (result.mtlxExportPath) fs.unlinkSync(result.mtlxExportPath);
            } catch (e) {}
        });

        it('should execute lighting_match_image_to_location tool handler', async () => {
            const testImgPath = path.join(process.cwd(), 'public/test_images/the_plaza_hotel_user_photo.jpg');
            const handler = lightingHandlers.lighting_match_image_to_location;
            const res = await handler({
                imagePath: testImgPath,
                locationName: 'The Plaza Hotel',
                geodeticCoords: { lat: 40.7646, lng: -73.9743 }
            }, {} as any);

            expect(res.resultPayload).toBeDefined();
            expect(res.resultPayload.success).toBe(true);
            expect(res.resultPayload.lightingRig).toBeDefined();
            expect(res.summaryResult).toContain('Successfully matched both image camera pose and physical lighting');
        });
    });
});
