/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A staged layer's photo twin is drawn lit (litPhotoTwins.ts): its unlit photo materials (MeshBasicMaterial with a map)
 * become MeshStandardMaterial with the same photo as albedo, so the sun's shadow falls on it. The lit material keeps the
 * back-face shadow side, the rebuilt facades' depth bias and the shared userData the confidence texture arrives in later,
 * and the staged reveal's clone of it chains the twin's own shader patch as it did the unlit one's.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { drawPhotoTwinsLit, unlitPhotoMaterialOf } from '../src/browser/generative-canvas/primitives/scene3d/stagedBuild/litPhotoTwins';
import { KEEP_AUTHORED_MATERIAL_KEY } from '../src/browser/generative-canvas/primitives/scene3d/stagedBuild/texturedTwinModel';
import { CONFIDENCE_MAP_KEY, FRONT_BIAS_KEY, confidenceMapOf, createStagedMaterial } from '../src/browser/generative-canvas/primitives/scene3d/stagedBuild/revealMaterial';
import { castShadowsFromBackFaces } from '../src/browser/generative-canvas/primitives/scene3d/shadowSides';

function scanGeometry(withNormals: boolean): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1], 2));
    if (withNormals) g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
    return g;
}

function twinMesh(material: THREE.Material, withNormals = false): THREE.Mesh {
    const mesh = new THREE.Mesh(scanGeometry(withNormals), material);
    mesh.userData[KEEP_AUTHORED_MATERIAL_KEY] = true;
    return mesh;
}

describe('photo twins drawn lit', () => {
    it('an unlit photo surface becomes a lit one with the same photo, keeping its shadow side, depth bias and userData', () => {
        const photo = new THREE.Texture();
        const basic = new THREE.MeshBasicMaterial({ map: photo, side: THREE.DoubleSide, name: 'facade_photo', color: 0xeeeeee });
        basic.userData.sbTexture = { confidenceTexture: 3 };
        basic.userData[FRONT_BIAS_KEY] = true;
        basic.polygonOffset = true; basic.polygonOffsetFactor = -1; basic.polygonOffsetUnits = -2;
        const root = new THREE.Group();
        const flat = twinMesh(basic), smooth = twinMesh(basic, true), shared = twinMesh(basic);
        root.add(flat, smooth, shared);
        expect(castShadowsFromBackFaces(root)).toBe(1);

        expect(drawPhotoTwinsLit(root)).toBe(3);
        const lit = flat.material as THREE.MeshStandardMaterial;
        expect(lit.isMeshStandardMaterial).toBe(true);
        expect(lit.map).toBe(photo);
        expect(lit.color.getHex()).toBe(0xeeeeee);
        expect(lit.roughness).toBe(1);
        expect(lit.metalness).toBe(0);
        expect(lit.name).toBe('facade_photo');
        expect(lit.side).toBe(THREE.DoubleSide);
        expect(lit.shadowSide).toBe(THREE.BackSide);
        expect([lit.polygonOffset, lit.polygonOffsetFactor, lit.polygonOffsetUnits]).toEqual([true, -1, -2]);
        expect(unlitPhotoMaterialOf(lit)).toBe(basic);
        // a scan without normals is flat-shaded from its faces; with normals it is smooth; a shared material stays shared
        expect(lit.flatShading).toBe(true);
        expect((smooth.material as THREE.MeshStandardMaterial).flatShading).toBe(false);
        expect(shared.material).toBe(lit);
        // userData is the twin's own: the confidence texture prepareTexturedTwinModel loads afterwards reaches the lit material
        expect(lit.userData).toBe(basic.userData);
        const confidence = new THREE.Texture();
        basic.userData[CONFIDENCE_MAP_KEY] = confidence;
        expect(confidenceMapOf(lit)).toBe(confidence);
        // a second pass changes nothing
        expect(drawPhotoTwinsLit(root)).toBe(0);
    });

    it('takes the photo\'s own colour, not one scaled for the camera\'s exposure', () => {
        const basic = new THREE.MeshBasicMaterial({ map: new THREE.Texture(), color: 0x808080 });
        basic.userData.sbUnlitBaseColor = basic.color.clone();
        basic.color.multiplyScalar(1 / 9);
        const mesh = twinMesh(basic);
        drawPhotoTwinsLit(mesh);
        expect((mesh.material as THREE.MeshStandardMaterial).color.getHex()).toBe(0x808080);
    });

    it('leaves alone what is not a twin\'s unlit photo: other models, lit materials, untextured unlit ones', () => {
        const notTwin = new THREE.Mesh(scanGeometry(false), new THREE.MeshBasicMaterial({ map: new THREE.Texture() }));
        const lit = new THREE.MeshStandardMaterial({ map: new THREE.Texture() });
        const plain = new THREE.MeshBasicMaterial({ color: 0xff0000 });
        const multi = twinMesh(lit);
        multi.material = [lit, plain];
        const root = new THREE.Group().add(notTwin, multi);
        expect(drawPhotoTwinsLit(root)).toBe(0);
        expect((notTwin.material as THREE.Material).type).toBe('MeshBasicMaterial');
        expect(multi.material).toEqual([lit, plain]);
    });

    it('the staged reveal clones the lit material and chains the twin\'s own shader patch after it', () => {
        const basic = new THREE.MeshBasicMaterial({ map: new THREE.Texture(), side: THREE.DoubleSide });
        basic.onBeforeCompile = shader => { shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', '#include <map_fragment>\n// twin-patch'); };
        const mesh = twinMesh(basic);
        castShadowsFromBackFaces(mesh);
        drawPhotoTwinsLit(mesh);
        const lit = mesh.material as THREE.MeshStandardMaterial;
        const reveal = createStagedMaterial(mesh, lit, 'reveal', 1) as THREE.MeshStandardMaterial;
        expect(reveal.isMeshStandardMaterial).toBe(true);
        expect(reveal.map).toBe(lit.map);
        expect(reveal.shadowSide).toBe(THREE.BackSide);
        const shader = {
            uniforms: {}, defines: {},
            vertexShader: THREE.ShaderLib.standard.vertexShader,
            fragmentShader: THREE.ShaderLib.standard.fragmentShader
        } as unknown as THREE.WebGLProgramParametersWithUniforms;
        reveal.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
        expect(shader.fragmentShader).toContain('// twin-patch');
        expect(shader.fragmentShader).toContain('uSbProgress');
        // the patch is part of the program's key, so the lit twin does not share a program with an unpatched material
        expect(lit.customProgramCacheKey()).toBe(basic.customProgramCacheKey());
    });
});
