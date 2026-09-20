/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import { SplatService, ImageToSplatService } from '../src/node/3d-engine/splat-service';

describe('360-Degree Omnidirectional Gaussian Splatting World', () => {
    it('generates full 360-degree spherical coverage in all 4 cardinal sectors', () => {
        const splats = SplatService.generate360EquirectangularSplats({
            worldType: 'san_marco',
            yawSteps: 72,
            pitchSteps: 36,
            eyeHeight: 1.7
        });

        expect(splats.length).toBeGreaterThan(1000);

        let hasNorth = false;
        let hasEast = false;
        let hasSouth = false;
        let hasWest = false;
        let hasNadir = false;
        let hasZenith = false;

        for (const s of splats) {
            const [x, y, z] = s.position;

            // Cardinal direction tests
            if (z < -15.0 && Math.abs(x) < 20.0) hasNorth = true;
            if (x > 15.0 && Math.abs(z) < 20.0) hasEast = true;
            if (z > 15.0 && Math.abs(x) < 20.0) hasSouth = true;
            if (x < -15.0 && Math.abs(z) < 20.0) hasWest = true;

            // Elevation tests
            if (y <= 0.05) hasNadir = true;
            if (y > 30.0) hasZenith = true;
        }

        expect(hasNorth).toBe(true);
        expect(hasEast).toBe(true);
        expect(hasSouth).toBe(true);
        expect(hasWest).toBe(true);
        expect(hasNadir).toBe(true);
        expect(hasZenith).toBe(true);
    });

    it('maintains clear observer space around human eye position (0, 1.7, 0)', () => {
        const eye = [0, 1.7, 0];
        const splats = SplatService.generate360EquirectangularSplats({
            worldType: 'san_marco',
            yawSteps: 60,
            pitchSteps: 30,
            eyeHeight: 1.7
        });

        let minRadialDist = Infinity;
        for (const s of splats) {
            const dx = s.position[0] - eye[0];
            const dy = s.position[1] - eye[1];
            const dz = s.position[2] - eye[2];
            const dist = Math.hypot(dx, dy, dz);
            if (dist < minRadialDist) {
                minRadialDist = dist;
            }
        }

        // Observer must have at least 1.4m clearance to avoid immediate eye clipping
        expect(minRadialDist).toBeGreaterThan(1.4);
    });

    it('generates Cyber Shibuya 360 with soaring vertical towers and cyber neon colors', () => {
        const splats = SplatService.generate360EquirectangularSplats({
            worldType: 'cyber_shibuya',
            yawSteps: 72,
            pitchSteps: 36,
            eyeHeight: 1.7
        });

        let maxY = -Infinity;
        let hasCyanNeon = false;
        let hasMagentaNeon = false;

        for (const s of splats) {
            if (s.position[1] > maxY) maxY = s.position[1];

            const [r, g, b] = s.colorRgb;
            // Cyan: high green & blue, low red
            if (b > 0.8 && g > 0.7 && r < 0.3) hasCyanNeon = true;
            // Magenta: high red & blue, low green
            if (r > 0.8 && b > 0.5 && g < 0.3) hasMagentaNeon = true;
        }

        expect(maxY).toBeGreaterThan(50.0);
        expect(hasCyanNeon).toBe(true);
        expect(hasMagentaNeon).toBe(true);
    });

    it('unprojects custom 2:1 equirectangular panorama image into 3D Gaussian splats', () => {
        const width = 120;
        const height = 60;
        const rgbBuffer = new Uint8Array(width * height * 3);

        // Fill with synthetic panorama gradient (blue sky on top, green earth below)
        for (let y = 0; y < height; ++y) {
            for (let x = 0; x < width; ++x) {
                const idx = (y * width + x) * 3;
                if (y < height / 2) {
                    rgbBuffer[idx] = 60;     // R
                    rgbBuffer[idx + 1] = 140; // G
                    rgbBuffer[idx + 2] = 240; // B (Sky)
                } else {
                    rgbBuffer[idx] = 80;     // R
                    rgbBuffer[idx + 1] = 180; // G (Grass)
                    rgbBuffer[idx + 2] = 60;  // B
                }
            }
        }

        const splats = SplatService.unprojectEquirectangularPanorama(rgbBuffer, width, height);
        expect(splats.length).toBeGreaterThan(500);

        // Verify bounds
        const [first] = splats;
        expect(first.position.length).toBe(3);
        expect(first.scale[0]).toBeGreaterThan(0);
        expect(first.opacity).toBeGreaterThan(0.5);
    });

    it('serializes and deserializes 360-degree Gaussian splats with strict 32-byte stride', () => {
        const splats = SplatService.generate360EquirectangularSplats({
            worldType: 'san_marco',
            yawSteps: 30,
            pitchSteps: 15
        });

        // Convert SplatPoint[] to BakedGaussian[]
        const baked = splats.map(s => ({
            position: s.position,
            scale: s.scale,
            color: s.colorRgb,
            opacity: s.opacity,
            quaternion: s.quaternion || [0, 0, 0, 1]
        }));

        const buffer = SplatService.serializeSplatBuffer(baked);
        expect(buffer.length).toBe(splats.length * 32);

        const decoded = SplatService.parseSplatBuffer(buffer);
        expect(decoded.length).toBe(splats.length);

        // Verify precision of first splat
        expect(decoded[0].position[0]).toBeCloseTo(splats[0].position[0], 2);
        expect(decoded[0].position[1]).toBeCloseTo(splats[0].position[1], 2);
        expect(decoded[0].position[2]).toBeCloseTo(splats[0].position[2], 2);
    });

    it('unprojects equirectangular panorama into 3DGS with ImageToSplatService', () => {
        const width = 64;
        const height = 32;
        const rgb = new Uint8Array(width * height * 3);
        for (let i = 0; i < rgb.length; i += 3) {
            rgb[i] = 180;
            rgb[i + 1] = 200;
            rgb[i + 2] = 220;
        }

        const splats = ImageToSplatService.convertEquirectangularToSplats({
            rgbPixels: rgb,
            width,
            height,
            stride: 2,
            eyeHeight: 1.70,
            maxRadius: 50.0
        });

        expect(splats.length).toBe((width / 2) * (height / 2));
        expect(splats[0].position.length).toBe(3);
        expect(splats[0].quaternion?.length).toBe(4);
        expect(splats[0].opacity).toBe(1.0);
    });

    it('measures exact 3D Euclidean metric distance between spatial points', () => {
        const p1: [number, number, number] = [0, 0, 0];
        const p2: [number, number, number] = [3, 4, 0]; // 3-4-5 triangle

        const result = ImageToSplatService.measureDistance(p1, p2);
        expect(result.meters).toBeCloseTo(5.0, 4);
        expect(result.feet).toBeCloseTo(5.0 * 3.28084, 4);
        expect(result.deltaX).toBe(3);
        expect(result.deltaY).toBe(4);
        expect(result.deltaZ).toBe(0);
    });
});

