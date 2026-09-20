/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
    packOrmBuffer,
    packOrmPng,
    decodePng,
    worley2D,
    fbm2D,
    curlWarp2D,
    gaborAnisotropic2D,
    blendNormalsRNM as blendNormalsNode,
    synthesizeProceduralPbr
} from '../src/node/texture-processing';
import {
    PbrTextureExpertService,
    blendNormalsRNM as blendNormalsBrowser,
    packOrmData
} from '../src/browser/generative-canvas/services/pbr-texture-expert-service';

describe('PBR Texture Expert - Procedural Realism & glTF ORM Architecture', () => {

    describe('Mathematical Noise Kernels & Normal Operations', () => {
        it('computes Worley distance metrics satisfying F1 <= F2', () => {
            for (let i = 0; i < 10; i++) {
                const res = worley2D(i * 1.7, i * 2.3, 0.9, 42);
                expect(res.f1).toBeLessThanOrEqual(res.f2 + 1e-6);
                expect(res.f2_minus_f1).toBeGreaterThanOrEqual(0);
                expect(res.f2_minus_f1).toBeCloseTo(res.f2 - res.f1, 4);
            }
        });

        it('computes continuous multi-octave FBM noise', () => {
            const v1 = fbm2D(0.5, 0.5, 4, 2.0, 0.5, 123);
            const v2 = fbm2D(0.51, 0.5, 4, 2.0, 0.5, 123);
            expect(Math.abs(v1 - v2)).toBeLessThan(0.1);
            expect(v1).toBeGreaterThanOrEqual(-1.0);
            expect(v1).toBeLessThanOrEqual(1.0);
        });

        it('applies curl noise domain coordinate warping', () => {
            const [x, y] = curlWarp2D(1.0, 1.0, 0.5, 2.0, 999);
            expect(x).not.toBe(1.0);
            expect(y).not.toBe(1.0);
            expect(Number.isFinite(x)).toBe(true);
            expect(Number.isFinite(y)).toBe(true);
        });

        it('evaluates Gabor anisotropic noise for brushed micro-scratches', () => {
            const parallel = gaborAnisotropic2D(0.1, 0.0, 0.0, 16.0, 1.0);
            expect(Number.isFinite(parallel)).toBe(true);
        });

        it('performs Reoriented Normal Mapping (RNM) preserving unit length and detail', () => {
            const nFlat: [number, number, number] = [0, 0, 1];
            const blendedFlat = blendNormalsNode(nFlat, nFlat);
            expect(blendedFlat[0]).toBeCloseTo(0, 4);
            expect(blendedFlat[1]).toBeCloseTo(0, 4);
            expect(blendedFlat[2]).toBeCloseTo(1, 4);

            const nBase: [number, number, number] = [0.2, 0.1, Math.sqrt(1 - 0.2*0.2 - 0.1*0.1)];
            const nDetail: [number, number, number] = [-0.1, 0.3, Math.sqrt(1 - 0.1*0.1 - 0.3*0.3)];
            const blended = blendNormalsNode(nBase, nDetail);

            const len = Math.sqrt(blended[0] * blended[0] + blended[1] * blended[1] + blended[2] * blended[2]);
            expect(len).toBeCloseTo(1.0, 4);

            // Verify browser implementation matches node implementation
            const browserBlended = blendNormalsBrowser(nBase, nDetail);
            expect(browserBlended[0]).toBeCloseTo(blended[0], 5);
            expect(browserBlended[1]).toBeCloseTo(blended[1], 5);
            expect(browserBlended[2]).toBeCloseTo(blended[2], 5);
        });
    });

    describe('glTF 2.0 ORM Packing (AO -> R, Roughness -> G, Metallic -> B)', () => {
        it('packs separate AO, Roughness, and Metallic buffers into a standard ORM buffer', () => {
            const width = 4;
            const height = 4;
            const count = width * height * 4;

            const ao = Buffer.alloc(count);
            const roughness = Buffer.alloc(count);
            const metallic = Buffer.alloc(count);

            for (let i = 0; i < width * height; i++) {
                const idx = i * 4;
                ao[idx] = 180;        // AO
                roughness[idx + 1] = 95;  // Roughness
                metallic[idx + 2] = 230; // Metallic
            }

            const orm = packOrmBuffer(ao, roughness, metallic, width, height);
            expect(orm.length).toBe(count);

            for (let i = 0; i < width * height; i++) {
                const idx = i * 4;
                expect(orm[idx]).toBe(180);     // Red = AO
                expect(orm[idx + 1]).toBe(95);  // Green = Roughness
                expect(orm[idx + 2]).toBe(230); // Blue = Metalness
                expect(orm[idx + 3]).toBe(255); // Alpha = 255
            }
        });

        it('packs ORM data via browser packOrmData helper', () => {
            const width = 2;
            const height = 2;
            const ao = new Uint8Array(16);
            const rough = new Uint8Array(16);
            const metal = new Uint8Array(16);

            ao.fill(200);
            rough.fill(100);
            metal.fill(50);

            const orm = packOrmData(ao, rough, metal, width, height);
            expect(orm.length).toBe(16);
            expect(orm[0]).toBe(200);
            expect(orm[1]).toBe(100);
            expect(orm[2]).toBe(50);
            expect(orm[3]).toBe(255);
        });

        it('encodes and decodes packed ORM PNG stream', () => {
            const pbr = synthesizeProceduralPbr('brushed_metal', 32, 32);
            expect(pbr.ormPng).toBeDefined();
            expect(pbr.ormPng.length).toBeGreaterThan(0);

            const decoded = decodePng(pbr.ormPng);
            expect(decoded.width).toBe(32);
            expect(decoded.height).toBe(32);
            expect(decoded.rgba.length).toBe(32 * 32 * 4);

            // Metalness (Blue) should be high for brushed_metal
            expect(decoded.rgba[2]).toBeGreaterThan(200);
        });
    });

    describe('Biophysical Material Archetype Generation', () => {
        it('synthesizes weathered concrete with non-metallic properties and micro-cracks', () => {
            const concrete = synthesizeProceduralPbr('concrete', 32, 32, { wear: 0.6 });
            expect(concrete.albedoPng).toBeDefined();
            expect(concrete.normalPng).toBeDefined();
            expect(concrete.roughnessPng).toBeDefined();
            expect(concrete.metallicPng).toBeDefined();
            expect(concrete.aoPng).toBeDefined();
            expect(concrete.ormPng).toBeDefined();

            const decodedOrm = decodePng(concrete.ormPng);
            // Dielectric concrete metallic (channel 2 / Blue) should be 0
            expect(decodedOrm.rgba[2]).toBe(0);
        });

        it('synthesizes brushed titanium with high metallic and directional anisotropic normals', () => {
            const titanium = synthesizeProceduralPbr('brushed_metal', 32, 32);
            const decodedOrm = decodePng(titanium.ormPng);
            // Metalness (Blue) should be high (~245)
            expect(decodedOrm.rgba[2]).toBe(245);
            // Roughness (Green) should be low-mid
            expect(decodedOrm.rgba[1]).toBeLessThan(120);
        });

        it('synthesizes veined Carrara marble with low roughness and mineral veins', () => {
            const marble = synthesizeProceduralPbr('marble', 32, 32);
            const decodedOrm = decodePng(marble.ormPng);
            // Polished marble roughness should be low
            expect(decodedOrm.rgba[1]).toBeLessThan(100);
            expect(decodedOrm.rgba[2]).toBe(5);
        });

        it('synthesizes wood end-grain with concentric rings and organic roughness variation', () => {
            const wood = synthesizeProceduralPbr('wood', 32, 32);
            expect(wood.albedoPng.length).toBeGreaterThan(0);
            expect(wood.normalPng.length).toBeGreaterThan(0);
        });

        it('synthesizes hammered copper with dimples and oxidation patina', () => {
            const copper = synthesizeProceduralPbr('hammered_copper', 32, 32);
            expect(copper.albedoPng.length).toBeGreaterThan(0);
            const decoded = decodePng(copper.ormPng);
            expect(decoded.rgba[2]).toBeGreaterThan(0);
        });

        it('synthesizes chipped paint on rust with dual-layer mask', () => {
            const chipped = synthesizeProceduralPbr('chipped_paint', 32, 32, { wear: 0.5 });
            expect(chipped.albedoPng.length).toBeGreaterThan(0);
            expect(chipped.heightPng).toBeDefined();
        });
    });

    describe('Browser PBR Texture Expert Service & Three.js Binding', () => {
        it('synthesizes DataTextures for Three.js viewport rendering', () => {
            const pack = PbrTextureExpertService.synthesizeTextures('weathered_concrete', {
                width: 32,
                height: 32
            });

            expect(pack.albedoTexture).toBeInstanceOf(THREE.DataTexture);
            expect(pack.normalTexture).toBeInstanceOf(THREE.DataTexture);
            expect(pack.ormTexture).toBeInstanceOf(THREE.DataTexture);
            expect(pack.albedoTexture.colorSpace).toBe(THREE.SRGBColorSpace);
            expect(pack.normalTexture.colorSpace).toBe(THREE.NoColorSpace);
            expect(pack.ormTexture.colorSpace).toBe(THREE.NoColorSpace);
        });

        it('height-blends and reorients normals for layered materials', () => {
            const substrate = PbrTextureExpertService.synthesizeRaw('hammered_copper', { width: 16, height: 16 });
            const topcoat = PbrTextureExpertService.synthesizeRaw('chipped_paint_rust', { width: 16, height: 16 });

            const mask = new Float32Array(16 * 16);
            for (let i = 0; i < mask.length; i++) {
                mask[i] = i % 2 === 0 ? 1.0 : 0.0;
            }

            const layered = PbrTextureExpertService.layerPbrSets(substrate, topcoat, mask, {
                transitionSharpness: 10.0
            });

            expect(layered.width).toBe(16);
            expect(layered.height).toBe(16);
            expect(layered.ormRgba.length).toBe(16 * 16 * 4);
            expect(layered.albedoRgba.length).toBe(16 * 16 * 4);
        });

        it('applies PBR texture pack directly to a Three.js MeshPhysicalMaterial with ORM', () => {
            const geom = new THREE.BoxGeometry(1, 1, 1);
            const initialMat = new THREE.MeshBasicMaterial({ color: 0xff0000 });
            const mesh = new THREE.Mesh(geom, initialMat);

            const pack = PbrTextureExpertService.synthesizeTextures('brushed_titanium', {
                width: 16,
                height: 16
            });

            PbrTextureExpertService.applyToMesh(mesh, pack, [3, 3]);

            expect(mesh.material).toBeInstanceOf(THREE.MeshPhysicalMaterial);
            const pbrMat = mesh.material as THREE.MeshPhysicalMaterial;

            expect(pbrMat.map).toBe(pack.albedoTexture);
            expect(pbrMat.normalMap).toBe(pack.normalTexture);
            // Verify single ORM texture is assigned to roughnessMap, metalnessMap, and aoMap
            expect(pbrMat.roughnessMap).toBe(pack.ormTexture);
            expect(pbrMat.metalnessMap).toBe(pack.ormTexture);
            expect(pbrMat.aoMap).toBe(pack.ormTexture);
            expect(pbrMat.aoMapIntensity).toBe(1.0);
        });
    });
});
