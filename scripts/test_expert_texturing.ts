/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * Test Harness for Master-Class PBR Texture Application Service.
 ********************************************************************************/

import * as THREE from 'three';
import { PbrTextureExpertService } from '../packages/core/src/browser/generative-canvas/services/pbr-texture-expert-service';

function createMockTexture(width: number, height: number): THREE.DataTexture {
    const size = width * height * 4;
    const data = new Uint8Array(size);
    for (let i = 0; i < size; i += 4) {
        data[i] = 200;
        data[i + 1] = 180;
        data[i + 2] = 160;
        data[i + 3] = 255;
    }
    const tex = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
    tex.needsUpdate = true;
    return tex;
}

function runTests() {
    console.log('Testing Master-Class PBR Texture Application Service...');

    // 1. Create test mesh (e.g. 20m x 40m x 10m building facade chunk)
    const geometry = new THREE.BoxGeometry(20, 40, 10);
    const material = new THREE.MeshPhysicalMaterial({ color: 0xffffff });
    const mesh = new THREE.Mesh(geometry, material);

    // 2. Compute Texel Repeats
    const [repU, repV] = PbrTextureExpertService.computeMeshTexelRepeats(mesh, 1024, 1024, 512);
    console.log(`-> Computed Metric UV Repeats: U=${repU.toFixed(2)}, V=${repV.toFixed(2)}`);
    if (repU < 5 || repV < 10) {
        throw new Error(`Expected higher repeat values for 20x40m mesh with 512 px/m density! Got: [${repU}, ${repV}]`);
    }

    // 3. Create mock texture pack
    const pack = {
        albedoTexture: createMockTexture(1024, 1024),
        normalTexture: createMockTexture(1024, 1024),
        roughnessTexture: createMockTexture(1024, 1024),
        metallicTexture: createMockTexture(1024, 1024),
        aoTexture: createMockTexture(1024, 1024),
        ormTexture: createMockTexture(1024, 1024),
        heightTexture: createMockTexture(1024, 1024)
    };

    // 4. Apply Expert PBR with all master-class features
    PbrTextureExpertService.applyExpertPbrToMesh(mesh, pack, {
        texelDensityPxPerMeter: 512,
        anisotropy: 16,
        enableAntiTiling: true,
        enableToksvig: true,
        enableWeathering: true,
        enableParallaxOcclusion: true,
        parallaxDepthScale: 0.04,
        normalScale: 2.5,
        clearcoat: 0.2,
        clearcoatRoughness: 0.08,
        weathering: {
            dirtIntensity: 0.45,
            rainStreakIntensity: 0.5,
            edgeWearIntensity: 0.3
        }
    });

    const pbrMat = mesh.material as THREE.MeshPhysicalMaterial;
    console.log('-> Applied Material Verification:');
    console.log(`   IOR: ${pbrMat.ior} (Expected: 1.5)`);
    console.log(`   Normal Scale: (${pbrMat.normalScale.x}, ${pbrMat.normalScale.y}) (Expected: 2.5)`);
    console.log(`   Clearcoat: ${pbrMat.clearcoat} (Expected: 0.2)`);
    console.log(`   Texture Repeat U: ${pack.albedoTexture.repeat.x.toFixed(2)}`);
    console.log(`   Texture Anisotropy: ${pack.albedoTexture.anisotropy} (Expected: 16)`);

    if (Math.abs(pbrMat.ior - 1.5) > 1e-4) throw new Error('Incorrect IOR');
    if (Math.abs(pbrMat.normalScale.x - 2.5) > 1e-4) throw new Error('Incorrect NormalScale');
    if (pack.albedoTexture.anisotropy !== 16) throw new Error('Incorrect Anisotropy');
    if (!pbrMat.onBeforeCompile) throw new Error('onBeforeCompile hook should be registered');

    console.log('ALL MASTER-CLASS TEXTURE APPLICATION TESTS PASSED!');
}

runTests();
