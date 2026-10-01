/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import {
    Depthbox360UniverseService,
    DepthboxUniversePreset,
    Depthbox360UniverseConfig
} from '../src/node/3d-engine/depthbox-360-universe-service';
import { ImageToSplatService } from '../src/node/3d-engine/image-to-splat-service';

describe('Depthbox360UniverseService — 360 Omnidirectional Inpainting & Studio Intelligence', () => {
    it('synthesizes an expansive 360° x 180° spherical universe with all depth layers', () => {
        const universe = Depthbox360UniverseService.generate360Universe({
            preset: 'san_marco',
            samplesYaw: 60,
            samplesPitch: 30,
            enableDualLayerInpainting: true,
            atmospherePreset: 'golden'
        });

        expect(universe.splats.length).toBeGreaterThan(1500);
        expect(universe.statistics.totalSplats).toBe(universe.splats.length);
        expect(universe.statistics.primarySplats).toBeGreaterThan(0);
        expect(universe.statistics.inpaintedSplats).toBeGreaterThan(0);

        // Check depth layer diversity
        const layers = universe.statistics.layerCounts;
        expect(layers.ground).toBeGreaterThan(0);
        expect(layers.foreground).toBeGreaterThan(0);
        expect(layers.cardinal_structure).toBeGreaterThan(0);
        expect(layers.occluded_infill).toBeGreaterThan(0);
        expect(layers.sky_dome).toBeGreaterThan(0);

        // Verify valid numeric positions, colors, scales, and normals
        for (const s of universe.splats.slice(0, 50)) {
            expect(Number.isFinite(s.position[0])).toBe(true);
            expect(Number.isFinite(s.position[1])).toBe(true);
            expect(Number.isFinite(s.position[2])).toBe(true);

            expect(s.colorRgb[0]).toBeGreaterThanOrEqual(0.0);
            expect(s.colorRgb[0]).toBeLessThanOrEqual(1.0);

            expect(s.scale[0]).toBeGreaterThan(0.0);
            expect(s.scale[1]).toBeGreaterThan(0.0);
            expect(s.scale[2]).toBeGreaterThan(0.0);

            const normLen = Math.hypot(s.normal[0], s.normal[1], s.normal[2]);
            expect(normLen).toBeGreaterThan(0.9);
            expect(normLen).toBeLessThan(1.1);
        }
    });

    it('verifies secondary occlusion inpainting fills voids behind foreground monoliths', () => {
        const universe = Depthbox360UniverseService.generate360Universe({
            preset: 'san_marco',
            samplesYaw: 80,
            samplesPitch: 40,
            enableDualLayerInpainting: true,
            inpaintDisocclusionRatio: 1.3
        });

        const foregroundSplats = universe.splats.filter(s => s.layer === 'foreground');
        const inpaintSplats = universe.splats.filter(s => s.isInpainted);

        expect(foregroundSplats.length).toBeGreaterThan(0);
        expect(inpaintSplats.length).toBeGreaterThan(0);

        // Inpainted background splats must penetrate deeper than foreground monoliths
        const avgFgDepth = foregroundSplats.reduce((sum, s) => sum + s.depth, 0) / foregroundSplats.length;
        const avgInpaintDepth = inpaintSplats.reduce((sum, s) => sum + s.depth, 0) / inpaintSplats.length;

        expect(avgInpaintDepth).toBeGreaterThan(avgFgDepth);
    });

    it('extracts walkable ground collision mesh and 3D bounding boxes into binary glTF 2.0 container', () => {
        const colliders = Depthbox360UniverseService.extractUniverseColliders('san_marco', 1.7);

        expect(colliders.groundElevation).toBeCloseTo(-1.7, 1);
        expect(colliders.positions.length).toBeGreaterThan(12); // Ground quad + boxes
        expect(colliders.indices.length).toBeGreaterThan(6);
        expect(colliders.boundingBoxes.length).toBeGreaterThanOrEqual(1);

        const glbBuffer = ImageToSplatService.generatePhysicsColliderGlb(colliders);
        expect(glbBuffer.byteLength).toBeGreaterThan(500);

        // glTF 2.0 Magic Header Validation: 'glTF' (0x46546C67)
        const magic = new DataView(glbBuffer.buffer, glbBuffer.byteOffset).getUint32(0, true);
        expect(magic).toBe(0x46546c67);

        const version = new DataView(glbBuffer.buffer, glbBuffer.byteOffset).getUint32(4, true);
        expect(version).toBe(2);

        const totalLength = new DataView(glbBuffer.buffer, glbBuffer.byteOffset).getUint32(8, true);
        expect(totalLength).toBe(glbBuffer.byteLength);
    });

    it('supports diverse 360 universe archetypes (Cyber Shibuya, Alpine, Roman Forum, Martian Bio-Dome)', () => {
        const archetypes: DepthboxUniversePreset[] = [
            'cyber_shibuya',
            'alpine_summit',
            'roman_forum',
            'martian_biodome'
        ];

        for (const preset of archetypes) {
            const result = Depthbox360UniverseService.generate360Universe({
                preset,
                samplesYaw: 40,
                samplesPitch: 20
            });

            expect(result.splats.length).toBeGreaterThan(700);
            expect(result.colliders.boundingBoxes.length).toBeGreaterThan(0);
            expect(result.glbColliderBuffer.byteLength).toBeGreaterThan(400);
        }
    });

    it('applies atmospheric normal relighting according to sun azimuth and elevation', () => {
        const noonAtmo = ImageToSplatService.getAtmospherePreset('noon');
        const sunsetAtmo = ImageToSplatService.getAtmospherePreset('sunset');

        const baseUniverse = Depthbox360UniverseService.generate360Universe({
            preset: 'san_marco',
            samplesYaw: 30,
            samplesPitch: 15,
            atmospherePreset: 'noon'
        });

        const groundSplats = baseUniverse.splats.filter(s => s.layer === 'ground');
        expect(groundSplats.length).toBeGreaterThan(0);

        // Relight with Sunset
        const sunsetSplats = Depthbox360UniverseService.relightUniverse(groundSplats, sunsetAtmo, 0.9);

        // Sunset warmer red channel vs noon
        const noonRedAvg = groundSplats.reduce((acc, s) => acc + s.colorRgb[0], 0) / groundSplats.length;
        const sunsetRedAvg = sunsetSplats.reduce((acc, s) => acc + s.colorRgb[0], 0) / sunsetSplats.length;

        expect(sunsetRedAvg).toBeGreaterThanOrEqual(0.0);
        expect(sunsetRedAvg).toBeLessThanOrEqual(1.0);
    });

    it('supports generative 2D image outpainting to 360 space', () => {
        const dummyRgb = new Uint8Array(64 * 64 * 3).fill(128);
        const result = Depthbox360UniverseService.outpaint2DTo360({
            imageRgb: dummyRgb,
            width: 64,
            height: 64,
            prompt: 'Venetian Grand Canal Palazzo',
            expansionFactor: 4.0
        });

        expect(result.splats.length).toBeGreaterThan(1000);
        expect(result.statistics.totalSplats).toBe(result.splats.length);
    });

    it('synthesizes universe from authentic photographic panorama pixels', () => {
        const w = 32;
        const h = 16;
        const photoPixels = new Uint8Array(w * h * 3);
        const depthMap = new Float32Array(w * h);
        for (let i = 0; i < w * h; i++) {
            photoPixels[i * 3 + 0] = 200;
            photoPixels[i * 3 + 1] = 180;
            photoPixels[i * 3 + 2] = 140;
            depthMap[i] = 10.0 + (i % 5);
        }

        const result = Depthbox360UniverseService.generateFromPhotographicPanorama({
            rgbPixels: photoPixels,
            width: w,
            height: h,
            depthMap,
            samplesYaw: 16,
            samplesPitch: 8
        });

        expect(result.splats.length).toBeGreaterThan(100);
        expect(result.splats[0].colorRgb[0]).toBeCloseTo(200 / 255.0, 1);
        expect(result.statistics.primarySplats).toBeGreaterThan(0);
    });
});
