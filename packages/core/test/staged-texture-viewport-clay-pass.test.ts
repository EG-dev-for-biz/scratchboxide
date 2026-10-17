/**
 * A staged scene carries clayPreset, and the viewport re-applies TileClayProcessor.applyClayMaterial over the whole
 * scene on every scene-data update (the material-mode tool's update among them). A textured twin's meshes are marked
 * to keep their authored material; the clay pass must leave them alone, or "Show real textures" shows clay (found live
 * on Washington Square Arch: every twin mesh carried the clay material after the tool switched the mode).
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { TileClayProcessor } from '../src/browser/generative-canvas/services/TileClayProcessor';
import { KEEP_AUTHORED_MATERIAL_KEY } from '../src/browser/generative-canvas/primitives/scene3d/stagedBuild/texturedTwinModel';

describe('scene-wide clay pass and textured twins', () => {
    it('clays the clay layers and leaves a twin mesh with its photo material', () => {
        const scene = new THREE.Scene();
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
        const clayMesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
        const photo = new THREE.MeshStandardMaterial({ map: new THREE.DataTexture(new Uint8Array([200, 180, 150, 255]), 1, 1) });
        const twinMesh = new THREE.Mesh(geometry, photo);
        twinMesh.userData[KEEP_AUTHORED_MATERIAL_KEY] = true;
        scene.add(clayMesh, twinMesh);
        TileClayProcessor.applyClayMaterial(scene, 'studio-grey' as any);
        expect(clayMesh.userData.isClayMesh).toBe(true);
        expect((clayMesh.material as THREE.MeshStandardMaterial).userData.isClayMaterial).toBe(true);
        expect(twinMesh.material).toBe(photo);
        expect(photo.map).toBeTruthy();
        expect(twinMesh.userData.isClayMesh).toBeUndefined();
    });
});
