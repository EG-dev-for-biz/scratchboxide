/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import { SplatService, ImageToSplatService } from '../src/node/3d-engine/splat-service';

describe('360-Degree Omnidirectional Gaussian Splatting World', () => {
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
        const width = 60, height = 30;
        const rgb = new Uint8Array(width * height * 3).map((_, i) => (i * 37) % 256);
        const depth = new Float32Array(width * height).map((_, i) => 2 + (i % 17));
        const splats = SplatService.unprojectEquirectangularPanorama(rgb, width, height, depth);
        expect(splats.length).toBeGreaterThan(0);

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

