/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
    CinematicBokehPass,
    generatePoissonDiskKernel
} from '../src/browser/generative-canvas/services/optics/CinematicBokehPass';
import { Video3DLayerRenderer } from '../src/browser/generative-canvas/services/video/Video3DLayerRenderer';
import type { TimelineElement } from '../src/browser/generative-canvas/services/video/videoTypes';

function createMockRenderer(): THREE.WebGLRenderer {
    return {
        setSize: () => {},
        getRenderTarget: () => null,
        setRenderTarget: () => {},
        setClearColor: () => {},
        clear: () => {},
        render: () => {},
        dispose: () => {}
    } as unknown as THREE.WebGLRenderer;
}

describe('CinematicBokehPass (GLSL Poisson Disk Blur & CoC Optics)', () => {
    it('generates a 24-tap golden angle Poisson disk distribution', () => {
        const kernel = generatePoissonDiskKernel();
        // 24 samples * 2 floats (x, y) = 48 floats
        expect(kernel.length).toBe(48);

        // Verify all points are inside the unit circle (r <= 1.0)
        for (let i = 0; i < 24; i++) {
            const x = kernel[i * 2];
            const y = kernel[i * 2 + 1];
            const radius = Math.sqrt(x * x + y * y);
            expect(radius).toBeLessThanOrEqual(1.0001);
        }
    });

    it('initializes shader uniforms from optical configuration', () => {
        const camera = new THREE.PerspectiveCamera(35, 16 / 9, 0.5, 500);
        const pass = new CinematicBokehPass({
            width: 1920,
            height: 1080,
            camera,
            focalLengthMm: 50,
            apertureFStop: 1.8,
            focusDistanceMeters: 4.5,
            sensorHeightMm: 24,
            anamorphicRatio: 1.33,
            maxBlurRadiusPixels: 28.0
        });

        const uniforms = pass.uniforms;
        expect(uniforms.focusDistance.value).toBe(4.5);
        expect(uniforms.focalLength.value).toBe(0.05); // 50mm = 0.05m
        expect(uniforms.fStop.value).toBe(1.8);
        expect(uniforms.sensorHeight.value).toBe(0.024); // 24mm = 0.024m
        expect(uniforms.anamorphicRatio.value).toBe(1.33);
        expect(uniforms.cameraNear.value).toBe(0.5);
        expect(uniforms.cameraFar.value).toBe(500);
        expect(uniforms.maxBlurRadius.value).toBe(28.0);
        expect(uniforms.resolution.value.x).toBe(1920);
        expect(uniforms.resolution.value.y).toBe(1080);

        pass.dispose();
    });

    it('updates focus distance and optical parameters dynamically', () => {
        const camera = new THREE.PerspectiveCamera(45, 16 / 9, 0.1, 1000);
        const pass = new CinematicBokehPass({
            width: 1280,
            height: 720,
            camera
        });

        // Dynamic rack focus shift
        pass.setFocusDistance(12.75);
        expect(pass.uniforms.focusDistance.value).toBe(12.75);

        // Dynamic lens swap to 85mm f/1.4 anamorphic
        pass.setOpticalParameters(85, 1.4, 2.0);
        expect(pass.uniforms.focalLength.value).toBe(0.085);
        expect(pass.uniforms.fStop.value).toBe(1.4);
        expect(pass.uniforms.anamorphicRatio.value).toBe(2.0);

        // Update from complete config
        pass.updateFromConfig({
            sensorFormatPreset: 'super_35',
            focalLengthMm: 35,
            apertureFStop: 2.0,
            focusDistanceMeters: 3.2,
            anamorphicRatio: 1.0,
            maxBlurRadiusPixels: 35.0
        });

        expect(pass.uniforms.focalLength.value).toBe(0.035);
        expect(pass.uniforms.fStop.value).toBe(2.0);
        expect(pass.uniforms.focusDistance.value).toBe(3.2);
        expect(pass.uniforms.sensorHeight.value).toBe(0.01866); // Super 35 height 18.66mm
        expect(pass.uniforms.anamorphicRatio.value).toBe(1.0);
        expect(pass.uniforms.maxBlurRadius.value).toBe(35.0);

        pass.dispose();
    });
});

describe('Video3DLayerRenderer Physical Camera & Depth-of-Field Integration', () => {
    it('initializes DepthTexture attachment on internal render target', () => {
        const mockRenderer = createMockRenderer();
        const layerRenderer = new Video3DLayerRenderer({
            width: 1920,
            height: 1080,
            renderer: mockRenderer
        });

        const rt = layerRenderer.getRenderTarget();
        expect(rt.depthTexture).toBeDefined();
        expect(rt.depthTexture).toBeInstanceOf(THREE.DepthTexture);

        layerRenderer.dispose();
    });

    it('enables and disables cinematic depth-of-field mode', () => {
        const mockRenderer = createMockRenderer();
        const layerRenderer = new Video3DLayerRenderer({
            width: 1920,
            height: 1080,
            renderer: mockRenderer
        });

        expect(layerRenderer.isDepthOfFieldEnabled()).toBe(false);

        layerRenderer.enableCinematicDoF({
            sensorFormatPreset: 'full_frame_35mm',
            focalLengthMm: 50,
            apertureFStop: 1.8,
            focusDistanceMeters: 5.0
        });

        expect(layerRenderer.isDepthOfFieldEnabled()).toBe(true);
        const config = layerRenderer.getPhysicalCameraConfig();
        expect(config).toBeDefined();
        expect(config?.focalLengthMm).toBe(50);
        expect(config?.apertureFStop).toBe(1.8);

        layerRenderer.disableCinematicDoF();
        expect(layerRenderer.isDepthOfFieldEnabled()).toBe(false);

        layerRenderer.dispose();
    });

    it('tracks 3D focus target distance during renderAtTime', () => {
        const mockRenderer = createMockRenderer();
        const layerRenderer = new Video3DLayerRenderer({
            width: 1920,
            height: 1080,
            renderer: mockRenderer
        });

        layerRenderer.enableCinematicDoF({
            sensorFormatPreset: 'full_frame_35mm',
            focalLengthMm: 85,
            apertureFStop: 1.4,
            focusDistanceMeters: 2.0
        });

        // Set focus target in world space (e.g., hero building at [0, 0, 0])
        layerRenderer.setFocusTarget([0, 0, 0]);

        const element: TimelineElement = {
            id: 'elem-3d-scene',
            trackId: 'track-1',
            type: '3d-scene',
            startSec: 0,
            durationSec: 5,
            inPointSec: 0,
            outPointSec: 5,
            content: {
                sceneData: {
                    nodes: [],
                    camera: {
                        position: [0, 10, 40], // Distance to [0, 0, 0] is sqrt(10^2 + 40^2) = ~41.23m
                        target: [0, 0, 0],
                        fov: 30,
                        physicalCamera: {
                            sensorFormatPreset: 'full_frame_35mm',
                            focalLengthMm: 85,
                            apertureFStop: 1.4
                        }
                    }
                }
            }
        };

        // Render frame at time 0.1
        layerRenderer.renderAtTime(0.1, element);

        // Focus distance should have smoothly tracked towards ~41.23m from 2.0m
        const trackedDist = layerRenderer.getCurrentFocusDistance();
        expect(trackedDist).toBeGreaterThan(2.0);
        expect(trackedDist).toBeLessThanOrEqual(42.0);

        layerRenderer.dispose();
    });
});
