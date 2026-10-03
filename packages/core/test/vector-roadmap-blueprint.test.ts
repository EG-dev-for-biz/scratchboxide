import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { syncVectorRoadmapBlueprint } from '../src/browser/generative-canvas/primitives/scene3d/syncVectorRoadmapBlueprint';
import type { VectorRoadmapConfig } from '../src/browser/generative-canvas/canvas-types';

describe('syncVectorRoadmapBlueprint', () => {
    it('creates and attaches blueprint mesh when enabled with valid anchor', () => {
        const scene = new THREE.Scene();
        const config: VectorRoadmapConfig = {
            enabled: true,
            groundBlueprint: true,
            groundBlueprintOpacity: 0.8,
            groundBlueprintSize: 600,
            groundElevationOffset: -0.1
        };
        const geoAnchor = {
            lat: 37.7955,
            lng: -122.3937,
            elevation: 3.5,
            landmarkName: 'San Francisco Ferry Building'
        };

        const handle = syncVectorRoadmapBlueprint(scene, null, { config, geoAnchor });
        expect(handle.blueprintMesh).toBeDefined();
        expect(handle.blueprintMesh?.name).toBe('sb-vector-roadmap-blueprint');
        expect(scene.getObjectByName('sb-vector-roadmap-blueprint')).toBe(handle.blueprintMesh);

        // Verify orientation & positioning (geometry rotated flat to ground plane, position.y adjusted to local ground datum)
        const posAttr = (handle.blueprintMesh?.geometry as THREE.BufferGeometry).getAttribute('position');
        expect(posAttr.getY(0)).toBeCloseTo(0); // Y is flat across all vertices in local geometry
        // Local ground surface in Three.js is Y = 0.0m + offset (-0.1) = -0.1m
        expect(handle.blueprintMesh?.position.y).toBeCloseTo(-0.1);
        // Real-world elevation (MSL) is stored in userData
        expect(handle.blueprintMesh?.userData.elevation).toBeCloseTo(3.5);
        expect(handle.blueprintMesh?.userData.elevationSource).toBe('google_elevation');

        // Verify material polygon offset & depth config
        const mat = handle.blueprintMesh?.material as THREE.MeshStandardMaterial;
        expect(mat.polygonOffset).toBe(true);
        expect(mat.polygonOffsetFactor).toBe(-1);
        expect(mat.depthWrite).toBe(false);
        expect(mat.opacity).toBe(0.8);

        // Verify geometry footprint size
        const geom = handle.blueprintMesh?.geometry as THREE.PlaneGeometry;
        expect(geom.parameters.width).toBe(600);
        expect(geom.parameters.height).toBe(600);

        // Dispose
        handle.dispose();
        expect(scene.getObjectByName('sb-vector-roadmap-blueprint')).toBeUndefined();
    });

    it('updates opacity in-place without rebuilding geometry', () => {
        const scene = new THREE.Scene();
        const config: VectorRoadmapConfig = {
            enabled: true,
            groundBlueprint: true,
            groundBlueprintOpacity: 0.5,
            groundBlueprintSize: 500
        };
        const geoAnchor = { lat: 37.7955, lng: -122.3937 };

        const handle1 = syncVectorRoadmapBlueprint(scene, null, { config, geoAnchor });
        const meshRef = handle1.blueprintMesh;
        const geomRef = meshRef?.geometry;

        // Change only opacity
        const updatedConfig: VectorRoadmapConfig = {
            ...config,
            groundBlueprintOpacity: 0.95
        };

        const handle2 = syncVectorRoadmapBlueprint(scene, handle1, { config: updatedConfig, geoAnchor });
        expect(handle2.blueprintMesh).toBe(meshRef);
        expect(handle2.blueprintMesh?.geometry).toBe(geomRef);
        const mat = handle2.blueprintMesh?.material as THREE.MeshStandardMaterial;
        expect(mat.opacity).toBe(0.95);

        handle2.dispose();
    });

    it('removes mesh when groundBlueprint is false', () => {
        const scene = new THREE.Scene();
        const config: VectorRoadmapConfig = {
            enabled: true,
            groundBlueprint: true
        };
        const geoAnchor = { lat: 37.7955, lng: -122.3937 };

        const handle1 = syncVectorRoadmapBlueprint(scene, null, { config, geoAnchor });
        expect(scene.getObjectByName('sb-vector-roadmap-blueprint')).toBeDefined();

        const disabledConfig: VectorRoadmapConfig = {
            enabled: true,
            groundBlueprint: false
        };
        const handle2 = syncVectorRoadmapBlueprint(scene, handle1, { config: disabledConfig, geoAnchor });
        expect(handle2.blueprintMesh).toBeNull();
        expect(scene.getObjectByName('sb-vector-roadmap-blueprint')).toBeUndefined();
    });
});
