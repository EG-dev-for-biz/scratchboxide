/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A rebuilt facade lying on the plane of the scan it replaces is drawn in front of it (texturedTwinModel.ts
 * biasRebuiltFacades): it gets its own copy of a material it shares with scan pieces, flagged and offset, while the scan's
 * material stays as it was.
 */

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { biasRebuiltFacades } from '../src/browser/generative-canvas/primitives/scene3d/stagedBuild/texturedTwinModel';
import { FRONT_BIAS_KEY } from '../src/browser/generative-canvas/primitives/scene3d/stagedBuild/revealMaterial';

describe('rebuilt facades drawn in front of the scan they replace', () => {
    it('gives a rebuilt facade its own offset copy of a shared material and leaves the scan alone', () => {
        const scene = new THREE.Group();
        const shared = new THREE.MeshStandardMaterial({ name: 'photo' });
        shared.userData.sbTexture = { confidenceTexture: 3 };
        const own = new THREE.MeshStandardMaterial({ name: 'facade only' });
        const geo = new THREE.PlaneGeometry(1, 1);
        const scanPiece = new THREE.Mesh(geo, shared); scanPiece.name = 'relief_m1';
        const facade = new THREE.Mesh(geo, shared); facade.name = 'FacadeLattice_1'; facade.userData.sbFacadeLattice = { windows: {} };
        const facade2 = new THREE.Mesh(geo, own); facade2.userData.sbFacadeLattice = {};
        scene.add(scanPiece, facade, facade2);
        expect(biasRebuiltFacades(scene)).toBe(2);
        expect(scanPiece.material).toBe(shared);
        expect(shared.polygonOffset).toBe(false);
        expect(shared.userData[FRONT_BIAS_KEY]).toBeUndefined();
        const copy = facade.material as THREE.MeshStandardMaterial;
        expect(copy).not.toBe(shared);
        expect(copy.userData[FRONT_BIAS_KEY]).toBe(true);
        expect(copy.userData.sbTexture).toEqual({ confidenceTexture: 3 });
        expect(copy.polygonOffset).toBe(true);
        expect(copy.polygonOffsetFactor).toBeLessThan(0);
        // a material only rebuilt facades use is flagged in place
        expect(facade2.material).toBe(own);
        expect(own.userData[FRONT_BIAS_KEY]).toBe(true);
    });
});
