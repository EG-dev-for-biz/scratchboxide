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
    ImageToSplatService,
    GoogleSpatialInpaintingService
} from '../src/node/3d-engine/splat-service';

describe('DepthBox Parity Pipeline', () => {
    const W = 64;
    const H = 64;

    // Helper: generate synthetic scene with foreground monolith on background
    function createSyntheticScene() {
        const rgb = new Uint8Array(W * H * 3);
        const depths = new Float32Array(W * H);

        for (let y = 0; y < H; ++y) {
            const ny = y / H;
            for (let x = 0; x < W; ++x) {
                const nx = x / W;
                const idx = y * W + x;

                if (ny > 0.70) {
                    // Ground plane
                    depths[idx] = 2.0 + (1.0 - ny) * 8.0;
                    rgb[idx * 3 + 0] = 60;
                    rgb[idx * 3 + 1] = 65;
                    rgb[idx * 3 + 2] = 70;
                } else if (nx > 0.35 && nx < 0.65 && ny > 0.20) {
                    // Foreground monolith (distinct depth step: 5m vs 25m)
                    depths[idx] = 5.0;
                    rgb[idx * 3 + 0] = 220;
                    rgb[idx * 3 + 1] = 180;
                    rgb[idx * 3 + 2] = 120;
                } else {
                    // Background wall/sky
                    depths[idx] = 25.0;
                    rgb[idx * 3 + 0] = 80;
                    rgb[idx * 3 + 1] = 120;
                    rgb[idx * 3 + 2] = 190;
                }
            }
        }
        return { rgb, depths };
    }

    it('synthesizes secondary background splats via multi-layer occlusion inpainting', () => {
        const { rgb, depths } = createSyntheticScene();

        // 1. Single layer baseline
        const singleSplats = ImageToSplatService.convertSingleImageToSplat({
            rgbPixels: rgb,
            width: W,
            height: H,
            metricDepths: depths,
            stride: 2
        });

        // 2. Dual layer inpainting
        const dualSplats = ImageToSplatService.convertSingleImageWithInpainting({
            rgbPixels: rgb,
            width: W,
            height: H,
            metricDepths: depths,
            stride: 2
        });

        expect(dualSplats.length).toBeGreaterThan(singleSplats.length);

        // Verify newly synthesized background splats exist behind foreground depths
        const backgroundInfilled = dualSplats.filter(s => {
            const dist = Math.hypot(s.position[0], s.position[1], s.position[2]);
            return dist > 15.0 && s.opacity === 0.88;
        });

        expect(backgroundInfilled.length).toBeGreaterThan(0);
        for (const s of backgroundInfilled) {
            expect(s.scale[0]).toBeGreaterThan(0);
            expect(s.scale[1]).toBeGreaterThan(0);
            expect(s.scale[2]).toBeGreaterThan(0);
            expect(s.quaternion).toBeDefined();
        }
    });

    it('extracts low-poly physics collision mesh with ground plane and obstacle hulls', () => {
        const { depths } = createSyntheticScene();

        const collider = ImageToSplatService.extractPhysicsColliders({
            width: W,
            height: H,
            metricDepths: depths,
            fovDegrees: 65.0
        });

        expect(collider).toBeDefined();
        expect(collider.groundElevation).toBeLessThan(0); // Ground is below eye level
        expect(collider.positions.length).toBeGreaterThan(0);
        expect(collider.indices.length).toBeGreaterThan(0);
        expect(collider.normals.length).toBe(collider.positions.length);
        expect(collider.boundingBoxes.length).toBeGreaterThan(0);

        // Check center obstacle collider
        const centerBox = collider.boundingBoxes.find(b => b.name === 'collider_center');
        expect(centerBox).toBeDefined();
        if (centerBox) {
            expect(centerBox.extents[0]).toBeGreaterThan(0);
            expect(centerBox.extents[1]).toBeGreaterThan(0);
            expect(centerBox.extents[2]).toBeGreaterThan(0);
        }
    });

    it('generates a compliant binary glTF 2.0 (.glb) container for the physics collider', () => {
        const { depths } = createSyntheticScene();

        const collider = ImageToSplatService.extractPhysicsColliders({
            width: W,
            height: H,
            metricDepths: depths
        });

        const glb = ImageToSplatService.generatePhysicsColliderGlb(collider);
        expect(glb).toBeInstanceOf(Uint8Array);
        expect(glb.length).toBeGreaterThan(100);

        const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);

        // 1. Verify 12-byte glTF Header
        const magic = dv.getUint32(0, true);
        const version = dv.getUint32(4, true);
        const totalLength = dv.getUint32(8, true);

        expect(magic).toBe(0x46546C67); // 'glTF'
        expect(version).toBe(2);
        expect(totalLength).toBe(glb.length);

        // 2. Verify JSON Chunk
        const jsonLength = dv.getUint32(12, true);
        const jsonType = dv.getUint32(16, true);
        expect(jsonType).toBe(0x4E4F534A); // 'JSON'

        const jsonBytes = glb.subarray(20, 20 + jsonLength);
        const jsonStr = new TextDecoder().decode(jsonBytes).trim();
        const gltf = JSON.parse(jsonStr);

        expect(gltf.asset.version).toBe('2.0');
        expect(gltf.meshes).toBeDefined();
        expect(gltf.accessors.length).toBe(3); // indices, positions, normals
        expect(gltf.bufferViews.length).toBe(3);

        // 3. Verify BIN Chunk
        const binHeaderOffset = 20 + jsonLength;
        const binLength = dv.getUint32(binHeaderOffset + 0, true);
        const binType = dv.getUint32(binHeaderOffset + 4, true);

        expect(binType).toBe(0x004E4942); // 'BIN\0'
        expect(binLength).toBe(glb.length - (binHeaderOffset + 8));
    });

    it('executes GoogleSpatialInpaintingService with structured schema deconstruction and fallback', async () => {
        const service = new GoogleSpatialInpaintingService();

        const deconstruction = await service.deconstructScene({
            prompt: 'Futuristic Neo-Tokyo Shibuya crosswalk with glowing skyscrapers',
            imageWidth: 640,
            imageHeight: 480,
            fovDegrees: 65.0
        });

        expect(deconstruction).toBeDefined();
        expect(deconstruction.groundPlane.elevationMeters).toBeLessThan(0);
        expect(deconstruction.groundPlane.walkableAreaRatio).toBeGreaterThan(0);
        expect(deconstruction.foregroundSilhouettes.length).toBeGreaterThan(0);
        expect(deconstruction.boxColliders.length).toBeGreaterThan(0);
        expect(deconstruction.backgroundPrior.dominantEnvironment).toBeDefined();
        expect(['google-genai', 'heuristic-fallback']).toContain(deconstruction.source);
    });

    it('evaluates normal-based physical relighting across atmospheric presets', () => {
        const { rgb, depths } = createSyntheticScene();

        const baseSplats = ImageToSplatService.convertSingleImageToSplat({
            rgbPixels: rgb,
            width: W,
            height: H,
            metricDepths: depths,
            stride: 2
        });

        // 1. Verify all presets load with valid physical bounds
        const presets = ['noon', 'golden', 'sunset', 'midnight'] as const;
        for (const p of presets) {
            const env = ImageToSplatService.getAtmospherePreset(p);
            expect(env.preset).toBe(p);
            expect(env.sunIntensity).toBeGreaterThan(0);
            expect(env.fogDensity).toBeGreaterThan(0);
            expect(env.sunDirection.length).toBe(3);
            expect(env.sunColor.length).toBe(3);
        }

        // 2. Relight with Golden Hour preset
        const goldenEnv = ImageToSplatService.getAtmospherePreset('golden');
        const relitSplats = ImageToSplatService.relightSplatPoints(baseSplats, goldenEnv, 1.0);

        expect(relitSplats.length).toBe(baseSplats.length);

        // Check that warm golden sun tint is imparted to lit splats
        let warmTintCount = 0;
        for (let i = 0; i < relitSplats.length; i++) {
            const relit = relitSplats[i].colorRgb;
            // Golden hour sun color has high red/green relative to blue
            if (relit[0] >= relit[2]) {
                warmTintCount++;
            }
        }
        expect(warmTintCount).toBeGreaterThan(0);

        // Check that mixFactor = 0 preserves original base albedo exactly
        const zeroRelit = ImageToSplatService.relightSplatPoints(baseSplats, goldenEnv, 0.0);
        for (let i = 0; i < Math.min(20, baseSplats.length); i++) {
            expect(zeroRelit[i].colorRgb[0]).toBeCloseTo(baseSplats[i].colorRgb[0], 5);
            expect(zeroRelit[i].colorRgb[1]).toBeCloseTo(baseSplats[i].colorRgb[1], 5);
            expect(zeroRelit[i].colorRgb[2]).toBeCloseTo(baseSplats[i].colorRgb[2], 5);
        }
    });
});
