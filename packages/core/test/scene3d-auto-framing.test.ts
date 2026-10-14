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
    getPresetConfig
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

    it('frames a small prop (a ~0.5 m stool) closely instead of from a fixed 15 m', () => {
        const scene = new THREE.Scene();
        const stool = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.45, 0.4), new THREE.MeshStandardMaterial());
        stool.position.set(0, 0.225, 0);
        scene.add(stool);

        const bounds = computeSceneGeometryBounds(scene);
        const autoFrame = calculateStandoffCamera(bounds, undefined, { fovDegrees: 45, force: true });
        expect(autoFrame).not.toBeNull();
        // Fills the frame: radius / sin(fov / 2) * margin, about 1.3 m here.
        expect(autoFrame!.distance).toBeLessThan(3);
        expect(autoFrame!.distance).toBeGreaterThan(bounds.sphere.radius * 1.5);
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

describe('Procedural PBR Material Presets (Pure Physical Config)', () => {
    it('resolves mudbrick weathered preset with physical roughness and normal scale parameters', () => {
        const cfg = getPresetConfig('mudbrick_weathered');
        expect(cfg).not.toBeNull();
        expect(cfg!.roughness).toBeGreaterThan(0.8);
        expect(cfg!.metalness).toBeLessThan(0.05);
        expect(cfg!.normalScale).toBe(0.8);
    });

    it('resolves hammered gold preset with high metallic and low roughness', () => {
        const cfg = getPresetConfig('hammered_gold');
        expect(cfg).not.toBeNull();
        expect(cfg!.metalness).toBeGreaterThan(0.9);
        expect(cfg!.roughness).toBeLessThan(0.4);
        expect(cfg!.clearcoat).toBe(0.2);
    });

    it('resolves alpine snow preset with transmission, clearcoat and dielectric IOR', () => {
        const cfg = getPresetConfig('alpine_snow');
        expect(cfg).not.toBeNull();
        expect(cfg!.clearcoat).toBeGreaterThan(0.4);
        expect(cfg!.transmission).toBeGreaterThan(0.1);
        expect(cfg!.ior).toBe(1.31);
    });
});

