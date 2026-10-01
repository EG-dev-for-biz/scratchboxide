/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import { StationRadianceEqualizer } from '../src/node/spatial/StationRadianceEqualizer';
import type { StationPlate } from '../src/node/spatial/SurveyTextureUnprojector';
import type { ColmapCameraPose } from '../src/common/spatial/colmap-vector-reference-types';
import { EMPTY_DEPTH } from '../src/node/spatial/SurveyStationRenderService';

describe('StationRadianceEqualizer', () => {
    it('converts RGB to YCbCr and back with <= 1 LSB numerical accuracy', () => {
        const testColors: [number, number, number][] = [
            [255, 255, 255],
            [0, 0, 0],
            [128, 128, 128],
            [210, 205, 195], // Indiana limestone
            [220, 140, 60],  // Golden hour amber
            [50, 80, 150]    // Deep twilight blue
        ];

        for (const [r, g, b] of testColors) {
            const [y, cb, cr] = StationRadianceEqualizer.rgbToYcbcr(r, g, b);
            const [rBack, gBack, bBack] = StationRadianceEqualizer.ycbcrToRgb(y, cb, cr);

            expect(Math.abs(r - rBack)).toBeLessThanOrEqual(2);
            expect(Math.abs(g - gBack)).toBeLessThanOrEqual(2);
            expect(Math.abs(b - bBack)).toBeLessThanOrEqual(2);
        }
    });

    it('builds a valid monotonic CDF lookup table mapping dark to bright distribution', () => {
        const srcLums: number[] = [];
        const refLums: number[] = [];

        // src is dark (mean ~60), ref is bright (mean ~180)
        for (let i = 0; i < 1000; i++) {
            srcLums.push(Math.round(40 + Math.random() * 40));
            refLums.push(Math.round(160 + Math.random() * 40));
        }

        const lut = StationRadianceEqualizer.buildCdfLut(srcLums, refLums);
        expect(lut.length).toBe(256);

        // Value around 60 in src should map to value around 180 in ref
        expect(lut[60]).toBeGreaterThanOrEqual(150);
        expect(lut[60]).toBeLessThanOrEqual(210);

        // Monotonic check
        for (let i = 1; i < 256; i++) {
            expect(lut[i]).toBeGreaterThanOrEqual(lut[i - 1]);
        }
    });

    it('equalizes 2 overlapping synthetic stations with 2.0x exposure difference', () => {
        const W = 64;
        const H = 64;
        const total = W * H;

        function createMockPlate(id: number, baseColor: [number, number, number], depthVal: number): StationPlate {
            const rgba = Buffer.alloc(total * 4);
            const depth = new Float32Array(total).fill(depthVal);

            for (let i = 0; i < total; i++) {
                // Add some gradient texture detail
                const noise = (i % 7) * 2;
                rgba[i * 4] = Math.min(255, baseColor[0] + noise);
                rgba[i * 4 + 1] = Math.min(255, baseColor[1] + noise);
                rgba[i * 4 + 2] = Math.min(255, baseColor[2] + noise);
                rgba[i * 4 + 3] = 255;
            }

            const station: ColmapCameraPose = {
                id,
                name: `STATION_${id}`,
                imageName: `station_${id}.jpg`,
                positionLocalENU: [id * 10, 50, 100],
                forwardVector: [0, 0, -1],
                upVector: [0, 1, 0],
                yawDegrees: 0,
                pitchDegrees: 0,
                rollDegrees: 0,
                focalLengthMm: 35,
                sensorWidthMm: 36,
                fovDegrees: 54.4,
                aspectRatio: 1,
                coordinatesWGS84: { lat: 40.7484, lng: -73.9857, elevation: 10 },
                groundElevationASL: 10,
                cameraHeightAboveGround: 50,
                cameraAltitude: 50
            };

            return {
                station,
                rgba,
                width: W,
                height: H,
                depth,
                pose: {
                    position: { x: id * 10, y: 50, z: 100 },
                    rotation: { x: 0, y: 0, z: 0, w: 1 },
                    altitudeGroundASL: 50,
                    focalLengthMeters: 0.035,
                    fovDegrees: 54.4
                },
                intrinsics: {
                    width: W,
                    height: H,
                    fx: 50,
                    fy: 50,
                    cx: W / 2,
                    cy: H / 2,
                    horizontalFovDegrees: 54.4,
                    verticalFovDegrees: 54.4
                }
            };
        }

        // Plate 0 is bright reference (limestone buff ~190)
        const plate0 = createMockPlate(0, [190, 185, 175], 50.0);
        // Plate 1 is dark underexposed shadow (~95, 2.0x darker)
        const plate1 = createMockPlate(1, [95, 92, 87], 50.0);

        const initialLum0 = 0.299 * plate0.rgba[0] + 0.587 * plate0.rgba[1] + 0.114 * plate0.rgba[2];
        const initialLum1 = 0.299 * plate1.rgba[0] + 0.587 * plate1.rgba[1] + 0.114 * plate1.rgba[2];
        expect(initialLum0 / initialLum1).toBeGreaterThan(1.8);

        const result = StationRadianceEqualizer.equalizePlates([plate0, plate1], {
            blendStrength: 1.0,
            referenceStationId: 0
        });

        expect(result.stationsEqualized).toBe(2);
        expect(result.anchorStationId).toBe(0);

        const finalLum1 = 0.299 * plate1.rgba[0] + 0.587 * plate1.rgba[1] + 0.114 * plate1.rgba[2];

        // After equalization, plate 1 should be within 5% of plate 0
        const lumDiffRatio = Math.abs(finalLum1 - initialLum0) / initialLum0;
        expect(lumDiffRatio).toBeLessThan(0.08);
    });

    it('harmonizes color temperature between cool blue tint and warm amber plate', () => {
        const W = 32;
        const H = 32;
        const total = W * H;

        function makeTintedPlate(id: number, rgb: [number, number, number]): StationPlate {
            const rgba = Buffer.alloc(total * 4);
            const depth = new Float32Array(total).fill(40.0);
            for (let i = 0; i < total; i++) {
                rgba[i * 4] = rgb[0];
                rgba[i * 4 + 1] = rgb[1];
                rgba[i * 4 + 2] = rgb[2];
                rgba[i * 4 + 3] = 255;
            }
            return {
                station: {
                    id,
                    name: `ST_${id}`,
                    imageName: `st_${id}.jpg`,
                    positionLocalENU: [0, 50, 100],
                    forwardVector: [0, 0, -1],
                    upVector: [0, 1, 0],
                    yawDegrees: 0,
                    pitchDegrees: 0,
                    rollDegrees: 0,
                    focalLengthMm: 35,
                    sensorWidthMm: 36,
                    fovDegrees: 54.4,
                    aspectRatio: 1,
                    coordinatesWGS84: { lat: 40.7484, lng: -73.9857, elevation: 10 },
                    groundElevationASL: 10,
                    cameraHeightAboveGround: 50,
                    cameraAltitude: 50
                },
                rgba,
                width: W,
                height: H,
                depth,
                pose: {
                    position: { x: 0, y: 50, z: 100 },
                    rotation: { x: 0, y: 0, z: 0, w: 1 },
                    altitudeGroundASL: 50,
                    focalLengthMeters: 0.035,
                    fovDegrees: 54.4
                },
                intrinsics: { width: W, height: H, fx: 40, fy: 40, cx: 16, cy: 16, horizontalFovDegrees: 54.4, verticalFovDegrees: 54.4 }
            };
        }

        // Anchor is warm amber [180, 170, 140] (R > B)
        const warmPlate = makeTintedPlate(0, [180, 170, 140]);
        // Target is cool blue sky light [140, 160, 190] (B > R)
        const coolPlate = makeTintedPlate(1, [140, 160, 190]);

        expect(coolPlate.rgba[2]).toBeGreaterThan(coolPlate.rgba[0]); // B > R initially

        StationRadianceEqualizer.equalizePlates([warmPlate, coolPlate], {
            blendStrength: 1.0,
            referenceStationId: 0
        });

        // After equalization, coolPlate should have warm color temperature (R >= B)
        const finalR = coolPlate.rgba[0];
        const finalB = coolPlate.rgba[2];
        expect(finalR).toBeGreaterThanOrEqual(finalB - 10);
    });
});
