/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
    FACS_52_ACTION_UNITS,
    HUMAN_DERMAL_SSSS_KERNEL
} from '../src/common/humanoid-dcc-protocol';
import {
    SbHumanStudioService,
    DccHumanoidObject,
    DccArmature,
    DccPoseBone,
    DccShapeKeys,
    DccPrincipledBsdfMaterial
} from '../src/node/spatial/SbHumanStudioService';
import { CineRealSkinRenderer } from '../src/browser/generative-canvas/services/CineRealSkinRenderer';

describe('DCC Humanoid Studio & Biophysical Skin Pipeline', () => {
    it('1. Verifies 52 FACS action units standard definition', () => {
        expect(FACS_52_ACTION_UNITS.length).toBe(52);
        expect(FACS_52_ACTION_UNITS).toContain('mouthSmileLeft');
        expect(FACS_52_ACTION_UNITS).toContain('mouthSmileRight');
        expect(FACS_52_ACTION_UNITS).toContain('jawOpen');
        expect(FACS_52_ACTION_UNITS).toContain('eyeBlinkLeft');
        expect(FACS_52_ACTION_UNITS).toContain('eyeBlinkRight');
        expect(FACS_52_ACTION_UNITS).toContain('browInnerUp');
    });

    it('2. Poses armature joints using DCC syntax (armature.pose.bones)', () => {
        const human = SbHumanStudioService.create('CineHero');
        expect(human.name).toBe('CineHero');

        const headBone = human.armature.pose.bones['head'];
        expect(headBone).toBeDefined();
        headBone.rotation_euler = [0.1, 0.0, 0.2];
        headBone.location = [0.0, 0.05, 0.0];

        const localMat = headBone.getLocalMatrix();
        expect(localMat.length).toBe(16);
        expect(localMat[12]).toBeCloseTo(0.0);
        expect(localMat[13]).toBeCloseTo(0.05); // Y translation
        expect(localMat[15]).toBe(1.0);
    });

    it('3. Modulates FACS 52 facial shape keys and evaluates vertex morphing', () => {
        const human = SbHumanStudioService.create('FacsCharacter');
        
        // Shape keys access
        const smileBlock = human.shape_keys.key_blocks['mouthSmileLeft'];
        expect(smileBlock).toBeDefined();
        expect(smileBlock.value).toBe(0.0);

        smileBlock.value = 0.85;
        human.shape_keys.key_blocks['jawOpen'].value = 0.70;

        const morphed = human.evaluateMorphedPositions();
        expect(morphed.length).toBeGreaterThan(0);
        
        // Morphing should alter position coordinates
        let hasDisplacement = false;
        for (let i = 0; i < morphed.length; i++) {
            if (Math.abs(morphed[i]) > 1e-4) {
                hasDisplacement = true;
                break;
            }
        }
        expect(hasDisplacement).toBe(true);
    });

    it('4. Computes biophysical melanin absorption and hemoglobin SSS parameters', () => {
        const mat = new DccPrincipledBsdfMaterial();
        mat.updateMelanin(0.42, 0.25);

        // Linear baseColor should be computed with physical melanin absorption
        expect(mat.baseColor[0]).toBeGreaterThan(0.05);
        expect(mat.baseColor[1]).toBeGreaterThan(0.02);
        expect(mat.baseColor[2]).toBeGreaterThan(0.01);
        expect(mat.baseColor[0]).toBeGreaterThan(mat.baseColor[2]); // Red > Blue absorption curve
        expect(mat.subsurfaceRadius).toEqual([3.67, 1.37, 0.68]);
        expect(mat.clearcoat).toBe(0.30);
    });

    it('5. Generates dual-layer anatomical eye geometry (cornea dome + iris cup)', () => {
        const human = SbHumanStudioService.create('EyeTestSubject');
        const eyes = human.buildAnatomicalEyeMeshes();

        expect(eyes.cornea).toBeDefined();
        expect(eyes.irisSclera).toBeDefined();

        expect(eyes.cornea.positions.length).toBeGreaterThan(100);
        expect(eyes.irisSclera.positions.length).toBeGreaterThan(100);
        expect(eyes.cornea.indices.length).toBeGreaterThan(100);

        // Cornea dome should be shifted slightly forward relative to iris bowl
        let maxCorneaZ = -Infinity;
        let maxIrisZ = -Infinity;
        for (let i = 2; i < eyes.cornea.positions.length; i += 3) {
            maxCorneaZ = Math.max(maxCorneaZ, eyes.cornea.positions[i]);
        }
        for (let i = 2; i < eyes.irisSclera.positions.length; i += 3) {
            maxIrisZ = Math.max(maxIrisZ, eyes.irisSclera.positions[i]);
        }
        expect(maxCorneaZ).toBeGreaterThan(maxIrisZ);
    });

    it('6. Exports fully compliant standard glTF 2.0 binary (.glb)', () => {
        const human = SbHumanStudioService.create('GlbHero');
        human.shape_keys.key_blocks['mouthSmileRight'].value = 0.5;
        human.armature.pose.bones['neck'].rotation_euler = [0.05, 0.0, 0.0];

        const glbBuffer = human.exportGlb();
        expect(glbBuffer).toBeInstanceOf(Buffer);
        expect(glbBuffer.length).toBeGreaterThan(100);

        // Validate glTF 2.0 magic bytes ('glTF' = 0x46546C67)
        const magic = glbBuffer.toString('utf8', 0, 4);
        expect(magic).toBe('glTF');
        const version = glbBuffer.readUInt32LE(4);
        expect(version).toBe(2);
    });

    it('7. CineRealSkinRenderer patches Three.js materials with dermal SSS and dual-lobe specular', () => {
        const material = new THREE.MeshStandardMaterial({
            color: 0xffd1b3,
            roughness: 0.5
        });

        CineRealSkinRenderer.patchSkinMaterial(material, {
            melaninFraction: 0.35,
            subsurfaceWeight: 0.85,
            lipidSpecularRoughness: 0.15
        });

        // Trigger onBeforeCompile
        const dummyShader: any = {
            uniforms: {},
            vertexShader: '#include <worldpos_vertex>\n',
            fragmentShader: '#include <dithering_fragment>\n'
        };
        (material as any).onBeforeCompile(dummyShader, {} as any);

        expect(dummyShader.uniforms.uSbSkinMelanin.value).toBe(0.35);
        expect(dummyShader.uniforms.uSbSkinSubWeight.value).toBe(0.85);
        expect(dummyShader.uniforms.uSbLipidRoughness.value).toBe(0.15);
        expect(dummyShader.vertexShader).toContain('vSbSkinWorldNorm');
        expect(dummyShader.fragmentShader).toContain('dermalScattered');
        expect(dummyShader.fragmentShader).toContain('D_lipid');
    });

    it('8. CineRealSkinRenderer creates refractive cornea and pigmented iris materials', () => {
        const corneaMat = CineRealSkinRenderer.createAnatomicalEyeMaterial('cornea', {
            corneaIor: 1.376
        }) as THREE.MeshPhysicalMaterial;

        expect(corneaMat.transmission).toBe(0.98);
        expect(corneaMat.ior).toBe(1.376);
        expect(corneaMat.roughness).toBeCloseTo(0.02);

        const irisMat = CineRealSkinRenderer.createAnatomicalEyeMaterial('iris_sclera') as THREE.MeshStandardMaterial;
        expect(irisMat.roughness).toBe(0.55);
        expect(irisMat.metalness).toBe(0.0);
    });

    it('9. Verifies zero banned terminology across the new studio module', () => {
        // Enforce the rule: zero forbidden terms
        const forbiddenTerms = [
            'meta' + 'human',
            'un' + 'real',
            'blen' + 'der'
        ];

        const inspectedFiles = [
            'packages/core/src/common/humanoid-dcc-protocol.ts',
            'packages/core/src/node/spatial/SbHumanStudioService.ts',
            'packages/core/src/browser/generative-canvas/services/CineRealSkinRenderer.ts'
        ];

        const fs = require('fs');
        for (const relPath of inspectedFiles) {
            const content = fs.readFileSync(relPath, 'utf8').toLowerCase();
            for (const term of forbiddenTerms) {
                expect(content.includes(term.toLowerCase())).toBe(false);
            }
        }
    });
});
