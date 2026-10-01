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
    computeSceneGeometryBounds,
    calculateStandoffCamera
} from '../src/browser/generative-canvas/primitives/scene3d/autoFraming';
import {
    getPresetConfig,
    getProceduralPbrTextures
} from '../src/browser/generative-canvas/primitives/scene3d/proceduralPbrTextures';

describe('Scene 3D Auto-Framing & Standoff Camera', () => {
    it('returns hasGeometry: false for an empty scene or scene with only lights/helpers', () => {
        const scene = new THREE.Scene();
        scene.add(new THREE.DirectionalLight());
        scene.add(new THREE.AmbientLight());
        const grid = new THREE.GridHelper(100, 100);
        grid.name = 'grid_helper';
        scene.add(grid);

        const bounds = computeSceneGeometryBounds(scene);
        expect(bounds.hasGeometry).toBe(false);
        expect(calculateStandoffCamera(bounds)).toBeNull();
    });

    it('calculates standoff camera when camera is omitted for a 45m monumental structure', () => {
        const scene = new THREE.Scene();
        // 45m x 30m x 45m building
        const geom = new THREE.BoxGeometry(45, 30, 45);
        const mat = new THREE.MeshStandardMaterial();
        const mesh = new THREE.Mesh(geom, mat);
        mesh.position.set(0, 15, 0); // Grounded
        scene.add(mesh);

        const bounds = computeSceneGeometryBounds(scene);
        expect(bounds.hasGeometry).toBe(true);
        expect(bounds.sphere.radius).toBeGreaterThan(25);

        const autoFrame = calculateStandoffCamera(bounds);
        expect(autoFrame).not.toBeNull();
        expect(autoFrame!.autoFramed).toBe(true);
        // Standoff distance must comfortably encompass the 45m structure without wall clipping
        expect(autoFrame!.distance).toBeGreaterThan(50);
        // Elevated at 28 deg elevation
        expect(autoFrame!.position[1]).toBeGreaterThan(bounds.sphere.center.y);
    });

    it('detects camera clipping INSIDE the mesh and automatically backs out to standoff distance', () => {
        const scene = new THREE.Scene();
        const geom = new THREE.BoxGeometry(40, 20, 40);
        const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial());
        mesh.position.set(0, 10, 0);
        scene.add(mesh);

        const bounds = computeSceneGeometryBounds(scene);
        // Camera spawned at [0, 5, 0] inside the box!
        const autoFrame = calculateStandoffCamera(bounds, {
            position: [0, 5, 0],
            target: [0, 5, 0],
            fov: 60
        });

        expect(autoFrame).not.toBeNull();
        expect(autoFrame!.autoFramed).toBe(true);
        // Camera position must now be outside the bounding box
        const newPos = new THREE.Vector3(...autoFrame!.position);
        expect(bounds.box.containsPoint(newPos)).toBe(false);
        expect(autoFrame!.distance).toBeGreaterThan(40);
    });

    it('respects camera pose when user explicitly places camera safely outside the geometry', () => {
        const scene = new THREE.Scene();
        const geom = new THREE.BoxGeometry(10, 10, 10);
        const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial());
        scene.add(mesh);

        const bounds = computeSceneGeometryBounds(scene);
        const autoFrame = calculateStandoffCamera(bounds, {
            position: [60, 40, 60],
            target: [0, 0, 0],
            fov: 60
        });

        expect(autoFrame).not.toBeNull();
        expect(autoFrame!.autoFramed).toBe(false);
        expect(autoFrame!.position).toEqual([60, 40, 60]);
    });
});

describe('Procedural PBR Textures & Material Presets', () => {
    it('resolves mudbrick weathered preset with procedural normal and roughness maps', () => {
        const cfg = getPresetConfig('mudbrick_weathered');
        expect(cfg).not.toBeNull();
        expect(cfg!.roughness).toBeGreaterThan(0.8);
        expect(cfg!.metalness).toBeLessThan(0.05);

        const textures = getProceduralPbrTextures('mudbrick_weathered');
        expect(textures.normalMap).toBeInstanceOf(THREE.DataTexture);
        expect(textures.roughnessMap).toBeInstanceOf(THREE.DataTexture);
        expect(textures.normalMap.image.width).toBe(128);
        expect(textures.normalMap.image.data.length).toBe(128 * 128 * 4);
    });

    it('resolves hammered gold preset with high metallic and hammered dimple normal map', () => {
        const cfg = getPresetConfig('hammered_gold');
        expect(cfg).not.toBeNull();
        expect(cfg!.metalness).toBeGreaterThan(0.9);
        expect(cfg!.roughness).toBeLessThan(0.4);

        const textures = getProceduralPbrTextures('hammered_gold');
        expect(textures.normalMap).toBeInstanceOf(THREE.DataTexture);
    });

    it('resolves alpine snow preset with transmission, clearcoat and sparkling normal map', () => {
        const cfg = getPresetConfig('alpine_snow');
        expect(cfg).not.toBeNull();
        expect(cfg!.clearcoat).toBeGreaterThan(0.4);
        expect(cfg!.transmission).toBeGreaterThan(0.1);

        const textures = getProceduralPbrTextures('alpine_snow');
        expect(textures.normalMap).toBeInstanceOf(THREE.DataTexture);
    });
});
