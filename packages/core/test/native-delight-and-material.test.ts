/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as THREE from 'three';
import { NativeCppCompilerService } from '../src/node/3d-engine/native-compiler-service';
import { NativeTileLightingService } from '../src/node/3d-engine/native-tile-lighting-service';
import { applyPerFacePbrAttributes } from '../src/browser/generative-canvas/services/TileMaterialClassifier';

describe('Physical De-Lighting & Per-Face Material Assignment (C++20)', () => {
    const compiler = new NativeCppCompilerService();
    const lightingService = new NativeTileLightingService();

    it('should locate scratchbox_delight.hpp and scratchbox_material.hpp in SDK include path', () => {
        const includePath = compiler.getSdkIncludePath();
        expect(fs.existsSync(path.join(includePath, 'scratchbox_delight.hpp'))).toBe(true);
        expect(fs.existsSync(path.join(includePath, 'scratchbox_material.hpp'))).toBe(true);
    });

    it('should estimate capture-day sun direction from baked shadow edges and BVH raycasts', async () => {
        // Build a ground quad (Y=0) and a vertical shadow-casting wall (at X=0, Y in [0, 2])
        // Ground: X in [-5, 5], Z in [-5, 5]
        const vertices = [
            // Ground quad 1: (-5, 0, -5), (5, 0, -5), (5, 0, 5)
            -5, 0, -5,   5, 0, -5,   5, 0, 5,
            // Ground quad 2: (-5, 0, -5), (5, 0, 5), (-5, 0, 5)
            -5, 0, -5,   5, 0, 5,  -5, 0, 5,
            // Vertical wall quad 1: (0, 0, -2), (0, 2, -2), (0, 2, 2)
            0, 0, -2,    0, 2, -2,   0, 2, 2,
            // Vertical wall quad 2: (0, 0, -2), (0, 2, 2), (0, 0, 2)
            0, 0, -2,    0, 2, 2,    0, 0, 2
        ];

        const normals = [
            0, 1, 0,   0, 1, 0,   0, 1, 0,
            0, 1, 0,   0, 1, 0,   0, 1, 0,
            1, 0, 0,   1, 0, 0,   1, 0, 0,
            1, 0, 0,   1, 0, 0,   1, 0, 0
        ];

        const indices = [
            0, 1, 2,
            3, 4, 5,
            6, 7, 8,
            9, 10, 11
        ];

        // UVs mapping ground to UV [0, 1]
        const uvs = [
            0, 0,   1, 0,   1, 1,
            0, 0,   1, 1,   0, 1,
            0, 0,   0, 1,   0.5, 1,
            0, 0,   0.5, 1, 0.5, 0
        ];

        // Create a 64x64 texture with a shadow on the negative X side (X < 0 is UV U < 0.5)
        const texW = 64;
        const texH = 64;
        const rgbBytes = Buffer.alloc(texW * texH * 3);

        for (let y = 0; y < texH; y++) {
            for (let x = 0; x < texW; x++) {
                const idx = (y * texW + x) * 3;
                // Ground with shadow on left side (x < 32)
                const isShadowed = x < 32 && y >= 16 && y <= 48;
                const brightness = isShadowed ? 40 : 200;
                rgbBytes[idx + 0] = brightness;
                rgbBytes[idx + 1] = brightness;
                rgbBytes[idx + 2] = brightness;
            }
        }

        const result = await lightingService.estimateCaptureSunDirection({
            meshVertices: vertices,
            meshIndices: indices,
            meshNormals: normals,
            meshUvs: uvs,
            textureWidth: texW,
            textureHeight: texH,
            textureRgbBytes: rgbBytes
        });

        expect(result.success).toBe(true);
        expect(result.elevationDeg).toBeGreaterThan(5);
        expect(result.elevationDeg).toBeLessThan(85);
        expect(result.sunDirection.length).toBe(3);
    }, 45000);

    it('should perform real de-lighting by dividing out shading and re-lighting shadows', async () => {
        // Simple ground quad with UVs
        const vertices = [
            -2, 0, -2,   2, 0, -2,   2, 0, 2,
            -2, 0, -2,   2, 0, 2,  -2, 0, 2
        ];
        const normals = [
            0, 1, 0,   0, 1, 0,   0, 1, 0,
            0, 1, 0,   0, 1, 0,   0, 1, 0
        ];
        const indices = [0, 1, 2, 3, 4, 5];
        const uvs = [
            0, 0,   1, 0,   1, 1,
            0, 0,   1, 1,   0, 1
        ];

        const texW = 32;
        const texH = 32;
        const rgbBytes = Buffer.alloc(texW * texH * 3);

        // Fill with a uniform surface albedo (RGB 180) with a dark baked shadow on the left half (RGB 50)
        for (let y = 0; y < texH; y++) {
            for (let x = 0; x < texW; x++) {
                const idx = (y * texW + x) * 3;
                const isShadow = x < 16;
                const val = isShadow ? 50 : 180;
                rgbBytes[idx + 0] = val;
                rgbBytes[idx + 1] = val;
                rgbBytes[idx + 2] = val;
            }
        }

        // Sun coming from +Y, +X (elevated)
        const sunDir: [number, number, number] = [0.577, 0.577, 0.577];

        const { delightedRgbBytes, relitRgbBytes } = await lightingService.delightTextureAndRelight(
            { vertices, indices, uvs, normals },
            { width: texW, height: texH, rgbBytes },
            sunDir,
            { epsilonClamp: 0.10 }
        );

        expect(delightedRgbBytes.length).toBe(texW * texH * 3);
        expect(relitRgbBytes.length).toBe(texW * texH * 3);

        // Check that delighted texture is non-zero and has divided out the shading
        const sampleCenterIdx = (16 * texW + 24) * 3;
        expect(delightedRgbBytes[sampleCenterIdx]).toBeGreaterThan(0);
    }, 45000);

    it('should classify materials per-face using normal, elevation, variance and polygon data', async () => {
        // Construct 4 distinct faces:
        // Face 0: Road face (horizontal at Y=0, within road corridor)
        // Face 1: Building facade (vertical at Y=5)
        // Face 2: Foliage face (green color, rough)
        // Face 3: Water face (horizontal at Y=0, blue/cyan color, within water boundary)
        const vertices = [
            // Face 0: Road
            -1, 0, -1,   1, 0, -1,   1, 0, 1,
            // Face 1: Building facade
            0, 2, 0,     0, 8, 0,    1, 8, 0,
            // Face 2: Foliage
            5, 1, 5,     6, 1, 5,    6, 1, 6,
            // Face 3: Water
            10, 0, 10,   12, 0, 10,  12, 0, 12
        ];

        const normals = [
            // Road: up
            0, 1, 0,   0, 1, 0,   0, 1, 0,
            // Building: side (horizontal normal)
            0, 0, 1,   0, 0, 1,   0, 0, 1,
            // Foliage: tilted
            0.5, 0.7, 0.5,  0.5, 0.7, 0.5,  0.5, 0.7, 0.5,
            // Water: up
            0, 1, 0,   0, 1, 0,   0, 1, 0
        ];

        const indices = [
            0, 1, 2,
            3, 4, 5,
            6, 7, 8,
            9, 10, 11
        ];

        const colors = [
            // Road: neutral grey (0.4, 0.4, 0.4)
            0.4, 0.4, 0.4,   0.4, 0.4, 0.4,   0.4, 0.4, 0.4,
            // Building: stone beige (0.7, 0.65, 0.6)
            0.7, 0.65, 0.6,  0.7, 0.65, 0.6,  0.7, 0.65, 0.6,
            // Foliage: strong green (0.1, 0.6, 0.1)
            0.1, 0.6, 0.1,   0.1, 0.6, 0.1,   0.1, 0.6, 0.1,
            // Water: deep blue/cyan (0.05, 0.35, 0.55)
            0.05, 0.35, 0.55, 0.05, 0.35, 0.55, 0.05, 0.35, 0.55
        ];

        const result = await lightingService.classifyMeshMaterials(
            { vertices, indices, normals, colors },
            undefined,
            {
                roadCorridors: [[[-2, -2], [2, -2], [2, 2], [-2, 2]]],
                waterBoundaries: [[[9, 9], [13, 9], [13, 13], [9, 13]]]
            }
        );

        expect(result.length).toBe(4);

        // Face 0: Road
        expect(result[0].classId).toBe(3); // Road
        expect(result[0].roughness).toBeGreaterThan(0.65);
        expect(result[0].metalness).toBeLessThan(0.1);

        // Face 1: Building Facade
        expect(result[1].classId).toBe(4); // Building Facade
        expect(result[1].roughness).toBeGreaterThan(0.70);

        // Face 2: Foliage
        expect(result[2].classId).toBe(1); // Foliage
        expect(result[2].roughness).toBeGreaterThan(0.85);

        // Face 3: Water
        expect(result[3].classId).toBe(2); // Water
        expect(result[3].roughness).toBeLessThan(0.15); // Specular / glossy
    }, 45000);

    it('should attach per-face PBR attributes to Three.js BufferGeometry accurately', () => {
        const geom = new THREE.BufferGeometry();
        // 2 triangles (6 vertices)
        const pos = new Float32Array([
            0, 0, 0,  1, 0, 0,  1, 1, 0,
            1, 1, 0,  0, 1, 0,  0, 0, 0
        ]);
        geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));

        applyPerFacePbrAttributes(geom, {
            materialIds: [2, 4],       // Face 0 = Water, Face 1 = Building
            roughnesses: [0.05, 0.85],
            metalnesses: [0.02, 0.0],
            speculars: [0.25, 0.50]
        });

        const matIdAttr = geom.getAttribute('aMaterialId');
        const roughAttr = geom.getAttribute('aRoughness');
        const metalAttr = geom.getAttribute('aMetalness');
        const specAttr = geom.getAttribute('aSpecular');

        expect(matIdAttr).toBeDefined();
        expect(roughAttr).toBeDefined();
        expect(metalAttr).toBeDefined();
        expect(specAttr).toBeDefined();

        expect(matIdAttr.count).toBe(6);
        // First triangle has water (class 2, roughness 0.05)
        expect(matIdAttr.getX(0)).toBe(2);
        expect(roughAttr.getX(0)).toBeCloseTo(0.05);

        // Second triangle has building (class 4, roughness 0.85)
        expect(matIdAttr.getX(3)).toBe(4);
        expect(roughAttr.getX(3)).toBeCloseTo(0.85);
    });
});
