/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Test suite for Universal Archie Building Structure Refinement &
 * SB-Terrain Multi-Material Ground Engine.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
    ArchieBuildingRefiner,
    smoothFacadeNormals,
    generateWatertightPlinth,
    type ArchieBuildingRefineOptions,
    type ArchieRefinedBuildingResult
} from '../src/browser/generative-canvas/services/spatial/ArchieBuildingRefiner';
import {
    SbTerrainGroundEngine,
    classifyTerrainSurfaceType,
    createProceduralRockStrataTexture,
    createProceduralGrassTexture,
    createProceduralCobblestoneTexture,
    type TerrainSurfaceType,
    type SbTerrainClassificationResult
} from '../src/browser/generative-canvas/services/spatial/SbTerrainGroundEngine';

describe('Archie Authentic Building Structure Refinement (Universal)', () => {

    it('smoothFacadeNormals: projects vertical facade normals into horizontal XZ plane and preserves roofs', () => {
        const geom = new THREE.BufferGeometry();
        // 3 vertices: one vertical wall, one horizontal roof, one angled Mansard roof
        const positions = new Float32Array([
            0, 0, 0,
            0, 5, 0,
            5, 5, 0,
            0, 10, 0,
            5, 10, 0,
            5, 10, 5,
        ]);
        const normals = new Float32Array([
            0.8, 0.2, 0.5,    // |Ny| = 0.2 < 0.38 -> vertical facade with sensor noise
            -0.7, 0.15, 0.6,   // |Ny| = 0.15 < 0.38 -> vertical facade with sensor noise
            0.0, 1.0, 0.0,    // |Ny| = 1.0 >= 0.38 -> horizontal roof deck
            0.0, 0.98, 0.1,   // |Ny| = 0.98 >= 0.38 -> nearly flat roof
            0.5, 0.7, 0.3,    // |Ny| = 0.70 >= 0.38 -> pitched roof
            0.6, 0.25, -0.6   // |Ny| = 0.25 < 0.38 -> vertical facade
        ]);

        geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geom.setAttribute('normal', new THREE.BufferAttribute(normals, 3));

        const smoothed = smoothFacadeNormals(geom, { maxFacadeNormalY: 0.38 });
        const smoothedNormals = smoothed.getAttribute('normal') as THREE.BufferAttribute;

        // Vertex 0: vertical wall should have Ny = 0 and unit length
        expect(smoothedNormals.getY(0)).toBeCloseTo(0.0, 5);
        const len0 = Math.hypot(smoothedNormals.getX(0), smoothedNormals.getZ(0));
        expect(len0).toBeCloseTo(1.0, 4);

        // Vertex 1: vertical wall should have Ny = 0 and unit length
        expect(smoothedNormals.getY(1)).toBeCloseTo(0.0, 5);
        const len1 = Math.hypot(smoothedNormals.getX(1), smoothedNormals.getZ(1));
        expect(len1).toBeCloseTo(1.0, 4);

        // Vertex 2: horizontal roof deck (Ny = 1.0) must be completely preserved
        expect(smoothedNormals.getY(2)).toBeCloseTo(1.0, 5);
        expect(smoothedNormals.getX(2)).toBeCloseTo(0.0, 5);
        expect(smoothedNormals.getZ(2)).toBeCloseTo(0.0, 5);

        // Vertex 3: flat roof (Ny = 0.98) must not be zeroed out
        expect(smoothedNormals.getY(3)).toBeCloseTo(0.98, 2);

        // Vertex 4: pitched roof (Ny = 0.7) must not be zeroed out
        expect(smoothedNormals.getY(4)).toBeCloseTo(0.7, 2);

        // Vertex 5: vertical wall should have Ny = 0 and unit length
        expect(smoothedNormals.getY(5)).toBeCloseTo(0.0, 5);
        const len5 = Math.hypot(smoothedNormals.getX(5), smoothedNormals.getZ(5));
        expect(len5).toBeCloseTo(1.0, 4);
    });

    it('generateWatertightPlinth: creates a watertight foundation plinth beneath the building base', () => {
        const buildingGeom = new THREE.BoxGeometry(10, 20, 15);
        // Translate building so base is at Y = 5
        buildingGeom.translate(20, 15, -30); // Y ranges from 5 to 25

        const plinthMesh = generateWatertightPlinth(buildingGeom, {
            plinthDepth: 3.0,
            plinthPadding: 0.4
        });

        expect(plinthMesh).toBeInstanceOf(THREE.Mesh);
        const plinthBbox = new THREE.Box3().setFromObject(plinthMesh);

        // Plinth top should align with building bottom (Y=5) with slight overlap
        expect(plinthBbox.max.y).toBeCloseTo(5.1, 1);
        // Plinth bottom should extend down by plinthDepth (5 - 3 = 2)
        expect(plinthBbox.min.y).toBeCloseTo(2.1, 1);

        // Plinth width & depth should include padding: (10 + 2*0.4 = 10.8) and (15 + 2*0.4 = 15.8)
        const size = new THREE.Vector3();
        plinthBbox.getSize(size);
        expect(size.x).toBeCloseTo(10.8, 1);
        expect(size.z).toBeCloseTo(15.8, 1);
        expect(size.y).toBeCloseTo(3.0, 1);
    });

    it('ArchieBuildingRefiner.refineBuilding: refines building with facade smoothing, plinth, and PBR material', () => {
        const buildingGeom = new THREE.BoxGeometry(12, 18, 12);
        buildingGeom.translate(0, 9, 0); // Y in [0, 18]
        const buildingMesh = new THREE.Mesh(buildingGeom, new THREE.MeshBasicMaterial());

        const refiner = new ArchieBuildingRefiner();
        const result: ArchieRefinedBuildingResult = refiner.refineBuilding(buildingMesh, {
            palette: 'roman_ochre',
            plinthDepth: 2.0,
            plinthPadding: 0.3
        });

        expect(result.group).toBeInstanceOf(THREE.Group);
        expect(result.refinedMesh).toBeInstanceOf(THREE.Mesh);
        expect(result.plinthMesh).toBeInstanceOf(THREE.Mesh);
        expect(result.metrics.vertexCount).toBeGreaterThan(0);
        expect(result.metrics.plinthDepthMeters).toBe(2.0);
        expect(result.metrics.facadeVerticesSmoothed).toBeGreaterThan(0);

        // Check assigned material has realistic PBR properties
        const mat = result.refinedMesh.material as THREE.MeshStandardMaterial;
        expect(mat.isMeshStandardMaterial).toBe(true);
        expect(mat.roughness).toBeGreaterThan(0.7);
        expect(mat.metalness).toBeLessThan(0.1);
    });

    it('ArchieBuildingRefiner supports arbitrary global architecture palettes (Limestone, Brick, Granite)', () => {
        const refiner = new ArchieBuildingRefiner();
        const geom = new THREE.BoxGeometry(10, 10, 10);
        geom.translate(0, 5, 0);

        const limestoneResult = refiner.refineBuilding(geom, { palette: 'limestone' });
        expect((limestoneResult.refinedMesh.material as THREE.MeshStandardMaterial).roughness).toBeCloseTo(0.82, 2);

        const brickResult = refiner.refineBuilding(geom, { palette: 'imperial_brick' });
        expect((brickResult.refinedMesh.material as THREE.MeshStandardMaterial).roughness).toBeCloseTo(0.90, 2);

        const bronzeResult = refiner.refineBuilding(geom, { palette: 'metro_bronze' });
        expect((bronzeResult.refinedMesh.material as THREE.MeshStandardMaterial).metalness).toBeCloseTo(0.65, 2);
    });
});

describe('SB-Terrain Multi-Material Ground Engine (Universal)', () => {

    it('classifyTerrainSurfaceType: classifies arbitrary surface by slope, planarity and relief', () => {
        // Flat plaza / street (horizontal normals Ny ~ 1.0, slope 0 deg)
        const flatGeom = new THREE.PlaneGeometry(10, 10, 4, 4);
        flatGeom.rotateX(-Math.PI / 2); // points strictly +Y (slope 0°)
        const flatType = classifyTerrainSurfaceType(flatGeom);
        expect(flatType).toBe('pavement');

        // Steep cliff / rock scarp (slope 45° > 32° threshold)
        const cliffGeom = new THREE.PlaneGeometry(10, 10, 4, 4);
        cliffGeom.rotateX(-Math.PI / 2 + Math.PI / 4); // tilted 45° from horizontal
        const cliffType = classifyTerrainSurfaceType(cliffGeom, { rockSlopeThresholdDeg: 32 });
        expect(cliffType).toBe('rock');

        // Gentle slope / lawn (slope ~ 20°, between 10° and 32°)
        const lawnGeom = new THREE.PlaneGeometry(10, 10, 4, 4);
        lawnGeom.rotateX(-Math.PI / 2 + Math.PI / 9); // tilted 20° from horizontal
        const lawnType = classifyTerrainSurfaceType(lawnGeom);
        expect(lawnType).toBe('grass');
    });

    it('generates procedural bump textures for rock strata, grass soil, and cobblestone pavers', () => {
        const rockTex = createProceduralRockStrataTexture();
        expect(rockTex).toBeDefined();
        expect(rockTex.wrapS).toBe(THREE.RepeatWrapping);
        expect(rockTex.wrapT).toBe(THREE.RepeatWrapping);

        const grassTex = createProceduralGrassTexture();
        expect(grassTex).toBeDefined();
        expect(grassTex.wrapS).toBe(THREE.RepeatWrapping);

        const cobblestoneTex = createProceduralCobblestoneTexture();
        expect(cobblestoneTex).toBeDefined();
        expect(cobblestoneTex.wrapS).toBe(THREE.RepeatWrapping);
    });

    it('SbTerrainGroundEngine: processes a collection of arbitrary ground submeshes into 3 distinct material systems', () => {
        const engine = new SbTerrainGroundEngine();

        // Create 3 synthetic ground submeshes
        // 1. Flat plaza (pavement)
        const pavementGeom = new THREE.PlaneGeometry(20, 20, 4, 4);
        pavementGeom.rotateX(-Math.PI / 2);
        const pavementMesh = new THREE.Mesh(pavementGeom);
        pavementMesh.name = 'district_plaza_01';

        // 2. Grassy mound (grass: 20 deg slope from ground)
        const grassGeom = new THREE.PlaneGeometry(20, 20, 4, 4);
        grassGeom.rotateX(-Math.PI / 2 + Math.PI / 9);
        const grassMesh = new THREE.Mesh(grassGeom);
        grassMesh.name = 'park_lawn_02';

        // 3. Steep rock scarp (rock: 60 deg slope from ground)
        const rockGeom = new THREE.PlaneGeometry(20, 20, 4, 4);
        rockGeom.rotateX(-Math.PI / 2 + Math.PI / 3);
        const rockMesh = new THREE.Mesh(rockGeom);
        rockMesh.name = 'bedrock_escarpment_03';

        const result: SbTerrainClassificationResult = engine.classifyAndRenderTerrain([
            pavementMesh,
            grassMesh,
            rockMesh
        ]);

        expect(result.terrainGroup).toBeInstanceOf(THREE.Group);
        expect(result.rocksGroup.children.length).toBe(1);
        expect(result.grassGroup.children.length).toBe(1);
        expect(result.pavementGroup.children.length).toBe(1);
        expect(result.metrics.totalSubmeshes).toBe(3);
        expect(result.metrics.rockCount).toBe(1);
        expect(result.metrics.grassCount).toBe(1);
        expect(result.metrics.pavementCount).toBe(1);

        // Verify layer filtering controls
        engine.setLayer('rocks');
        expect(result.rocksGroup.visible).toBe(true);
        expect(result.grassGroup.visible).toBe(false);
        expect(result.pavementGroup.visible).toBe(false);

        engine.setLayer('grass');
        expect(result.rocksGroup.visible).toBe(false);
        expect(result.grassGroup.visible).toBe(true);
        expect(result.pavementGroup.visible).toBe(false);

        engine.setLayer('all');
        expect(result.rocksGroup.visible).toBe(true);
        expect(result.grassGroup.visible).toBe(true);
        expect(result.pavementGroup.visible).toBe(true);
    });

    it('works on arbitrary worldwide complex terrain groups with automatic submesh segmentation', () => {
        const engine = new SbTerrainGroundEngine();
        const terrainRoot = new THREE.Group();

        // 10 varied submeshes
        for (let i = 0; i < 10; i++) {
            const geom = new THREE.PlaneGeometry(10, 10, 2, 2);
            // tilt varying between 0 and 60 degrees
            const tilt = (i / 10) * (Math.PI / 3);
            geom.rotateX(-tilt);
            const m = new THREE.Mesh(geom);
            m.name = `terrain_chunk_${i}`;
            terrainRoot.add(m);
        }

        const result = engine.classifyAndRenderTerrain(terrainRoot);
        expect(result.metrics.totalSubmeshes).toBe(10);
        expect(result.metrics.rockCount + result.metrics.grassCount + result.metrics.pavementCount).toBe(10);
    });

    it('In-App Gemini Agent Tools: archie_refine_building_structure and sb_terrain_classify_materials are not offered (they refined a demo box and three demo planes, never the scene)', async () => {
        const { createDefaultToolRegistry } = await import('../src/node/gemini/tool-registry');
        const registry = createDefaultToolRegistry();

        expect(registry.get('archie_refine_building_structure')).toBeUndefined();
        expect(registry.get('sb_terrain_classify_materials')).toBeUndefined();
        expect(registry.declarations().map(d => d.name)).not.toContain('archie_refine_building_structure');
        expect(registry.declarations().map(d => d.name)).not.toContain('sb_terrain_classify_materials');

        // The canvas operators below act on the live scene's own meshes and stay available.
    });

    it('ArchieBuildingRefiner refuses a missing or unknown palette instead of painting Roman ochre', () => {
        const refiner = new ArchieBuildingRefiner();
        const geom = new THREE.BoxGeometry(10, 10, 10);
        expect(() => refiner.refineBuilding(geom, {})).toThrow(/no palette given; give one of .*limestone/);
        expect(() => refiner.refineBuilding(geom, { palette: 'gothic_obsidian' as any })).toThrow(/unknown palette 'gothic_obsidian'/);
    });

    it('Direct-Dispatch Canvas Operators edit the mesh named in the live scene, and fail (adding nothing) when it is not there', async () => {
        const { DirectDispatchOperatorEngine } = await import('../src/browser/generative-canvas/services/direct-dispatch-operator-engine');

        // The review's probe: an empty scene. Both operators used to build a demo box / demo planes and succeed.
        const empty = new DirectDispatchOperatorEngine();
        const emptyScene = new THREE.Scene();
        empty.attachThreeScene(emptyScene);
        const refineEmpty = empty.dispatch('sb_refine_building_structure', { palette: 'limestone', plinthDepth: 2.0 });
        expect(refineEmpty.success).toBe(false);
        expect(refineEmpty.error).toContain('needs targetMeshId');
        const terrainEmpty = empty.dispatch('sb_classify_terrain_materials', { targetMeshId: 'ground', layer: 'rocks' });
        expect(terrainEmpty.success).toBe(false);
        expect(terrainEmpty.error).toContain("no mesh named or with id 'ground'");
        expect(emptyScene.children.length).toBe(0);

        // No viewport attached (the server-side dispatch): nothing to edit, so it fails.
        const headless = new DirectDispatchOperatorEngine().dispatch('sb_refine_building_structure', { targetMeshId: 'palazzo', palette: 'limestone' });
        expect(headless.success).toBe(false);
        expect(headless.error).toContain('no viewport is attached');

        // A scene with a building named something that matches no keyword, and a ground mesh.
        const engine = new DirectDispatchOperatorEngine();
        const scene = new THREE.Scene();
        engine.attachThreeScene(scene);
        const buildingGeom = new THREE.BoxGeometry(12, 18, 12);
        buildingGeom.translate(0, 9, 0);
        const building = new THREE.Mesh(buildingGeom, new THREE.MeshStandardMaterial());
        building.name = 'tile_mesh_0042';
        scene.add(building);
        const groundGeom = new THREE.PlaneGeometry(20, 20, 4, 4);
        groundGeom.rotateX(-Math.PI / 2);
        const ground = new THREE.Mesh(groundGeom);
        ground.name = 'tile_mesh_0043';
        scene.add(ground);

        // A keyword-named decoy is not picked when the named mesh is missing.
        const decoy = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
        decoy.name = 'building_decoy';
        scene.add(decoy);
        const missing = engine.dispatch('sb_refine_building_structure', { targetMeshId: 'tile_mesh_9999', palette: 'limestone' });
        expect(missing.success).toBe(false);
        expect(missing.error).toContain("'tile_mesh_0042'");
        expect(scene.getObjectByName('building_decoy')).toBe(decoy);

        const noPalette = engine.dispatch('sb_refine_building_structure', { targetMeshId: 'tile_mesh_0042' });
        expect(noPalette.success).toBe(false);
        expect(noPalette.error).toContain('no palette given');

        const refineRes = engine.dispatch('sb_refine_building_structure', { targetMeshId: 'tile_mesh_0042', palette: 'limestone', plinthDepth: 2.0 });
        expect(refineRes.success).toBe(true);
        expect(refineRes.data.palette).toBe('limestone');
        expect(refineRes.data.metrics.vertexCount).toBe(buildingGeom.getAttribute('position').count);
        expect(scene.getObjectByName('tile_mesh_0042')).toBeUndefined();
        expect(scene.getObjectByName('archie_refined_tile_mesh_0042')).toBeDefined();

        const terrainRes = engine.dispatch('sb_classify_terrain_materials', { targetMeshId: 'tile_mesh_0043', layer: 'rocks' });
        expect(terrainRes.success).toBe(true);
        expect(terrainRes.data.layer).toBe('rocks');
        expect(terrainRes.data.metrics.totalSubmeshes).toBe(1);
        expect(terrainRes.data.metrics.pavementCount).toBe(1);
    });
});
