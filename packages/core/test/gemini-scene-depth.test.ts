/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import { GeminiSceneDepthService } from '../src/node/spatial/GeminiSceneDepthService';
import { ImageToSplatService } from '../src/node/3d-engine/image-to-splat-service';
import { SceneDepthAnnotation } from '../src/common/scene-depth-protocol';

describe('GeminiSceneDepthService (Multimodal Metric Depth Analyst & 3DGS)', () => {
    const service = new GeminiSceneDepthService();

    const sampleAnnotation: SceneDepthAnnotation = {
        sceneType: 'street',
        parts: {
            pedestrian: {
                label: 'Walking Pedestrian',
                z: 2.0, // 2m in front of origin (distance from camera at +5 is 3m)
                imageX: 0.5,
                imageY: 0.6,
                width: 0.15,
                height: 0.35,
                reason: 'Primary foreground human subject with distinct feet contact on pavement.'
            },
            parked_car: {
                label: 'Sedan Vehicle',
                z: 0.0, // at origin (distance from camera at +5 is 5m)
                imageX: 0.75,
                imageY: 0.5,
                width: 0.3,
                height: 0.2,
                reason: 'Midground vehicle occluded partially by sidewalk edge.'
            },
            distant_building: {
                label: 'Skyscraper Facade',
                z: -10.0, // 10m behind origin (distance from camera at +5 is 15m)
                imageX: 0.3,
                imageY: 0.2,
                width: 0.5,
                height: 0.4,
                reason: 'Atmospheric aerial haze and reduced high-frequency edge contrast.'
            }
        },
        z_ranges: {
            near: [1.0, 3.5],
            mid: [-1.0, 0.5],
            far: [-15.0, -5.0]
        }
    };

    it('should build depth system prompt specifying Three.js conventions and metric constraints', () => {
        const prompt = service.buildDepthSystemPrompt();

        expect(prompt).toContain('Z = +5.0');
        expect(prompt).toContain('Three.js');
        expect(prompt).toContain('Occlusion Boundaries');
        expect(prompt).toContain('Contact Shadows');
        expect(prompt).toContain('parts');
        expect(prompt).toContain('z_ranges');
    });

    it('should enrich 2D depth parts with metric 3D world coordinates via pinhole projection', () => {
        const enriched = service.enrichDepthAnnotation(sampleAnnotation, {
            aspectRatio: 16 / 9,
            sceneWidthUnits: 6.0
        });

        expect(enriched.parts.pedestrian).toBeDefined();
        // Centered imageX = 0.5 should unproject to worldX = 0
        expect(enriched.parts.pedestrian.worldX).toBeCloseTo(0.0, 2);
        // worldZ should match annotated metric Z = 2.0
        expect(enriched.parts.pedestrian.worldZ).toBeCloseTo(2.0, 2);

        // Right side car at imageX = 0.75 should have positive worldX
        expect(enriched.parts.parked_car.worldX).toBeGreaterThan(0.5);
        expect(enriched.parts.parked_car.worldZ).toBeCloseTo(0.0, 2);

        // Distant building at imageY = 0.2 (top of image) should have positive worldY (up)
        expect(enriched.parts.distant_building.worldY).toBeGreaterThan(0.5);
        expect(enriched.parts.distant_building.worldZ).toBeCloseTo(-10.0, 2);
    });

    it('should synthesize continuous metric depth buffer with distance gradient and Gaussian blending', () => {
        const W = 64;
        const H = 36;
        const depthResult = service.synthesizeMetricDepthBuffer(sampleAnnotation, {
            width: W,
            height: H,
            nearDepth: 1.0,
            farDepth: 25.0
        });

        expect(depthResult.width).toBe(W);
        expect(depthResult.height).toBe(H);
        expect(depthResult.metricDepths.length).toBe(W * H);
        expect(depthResult.minDepth).toBeGreaterThanOrEqual(1.0);
        expect(depthResult.maxDepth).toBeLessThanOrEqual(25.0);

        // Pedestrian is at (0.5, 0.6) with z=2.0 -> camera distance ≈ 3.0m
        const pedIdx = Math.floor(0.6 * H) * W + Math.floor(0.5 * W);
        const pedDist = depthResult.metricDepths[pedIdx];

        // Building is at (0.3, 0.2) with z=-10.0 -> camera distance ≈ 15.0m
        const bldIdx = Math.floor(0.2 * H) * W + Math.floor(0.3 * W);
        const bldDist = depthResult.metricDepths[bldIdx];

        // The pedestrian MUST be significantly closer to the camera than the distant building
        expect(pedDist).toBeLessThan(bldDist);
        expect(bldDist - pedDist).toBeGreaterThan(2.5);
    });

    it('should seamlessly integrate with ImageToSplatService to produce 3D Gaussian Splats', () => {
        const W = 32;
        const H = 32;
        const dummyRgb = new Uint8Array(W * H * 3);
        dummyRgb.fill(180); // mid-grey texture

        // Convert 2D image directly into 3D Gaussian Splats using our semantic depth annotation
        const splats = ImageToSplatService.convertSingleImageToSplat({
            rgbPixels: dummyRgb,
            width: W,
            height: H,
            channels: 3,
            sceneDepthAnnotation: sampleAnnotation,
            stride: 2,
            minDepth: 0.5,
            maxDepth: 30.0
        });

        expect(splats.length).toBeGreaterThan(100);

        // Each splat must have valid metric 3D position, scales, rotation quaternion, and color
        for (const s of splats.slice(0, 10)) {
            expect(s.position.length).toBe(3);
            expect(s.scale.length).toBe(3);
            expect(s.quaternion?.length).toBe(4);
            expect(s.colorRgb.length).toBe(3);
            expect(s.opacity).toBeGreaterThan(0.0);
            expect(isNaN(s.position[0])).toBe(false);
            expect(isNaN(s.position[1])).toBe(false);
            expect(isNaN(s.position[2])).toBe(false);
        }
    });

    it('should provide offline fallback analysis producing valid scene depth response and depth map', async () => {
        const dummyBuffer = Buffer.from('mock-camera-frame-data');
        const response = await service.analyzeSceneDepth({
            image: dummyBuffer,
            generateDepthMap: true,
            depthMapResolution: { width: 32, height: 18 }
        });

        expect(response.success).toBe(true);
        expect(response.confidence).toBeGreaterThan(0.7);
        expect(response.annotation).toBeDefined();
        expect(response.enriched).toBeDefined();
        expect(response.depthMap).toBeDefined();
        if (response.depthMap) {
            expect(response.depthMap.width).toBe(32);
            expect(response.depthMap.height).toBe(18);
            expect(response.depthMap.metricDepths.length).toBe(32 * 18);
        }
    });
});
