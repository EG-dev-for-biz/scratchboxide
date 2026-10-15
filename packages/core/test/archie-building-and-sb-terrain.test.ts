/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Test suite for Universal Archie Building Structure Refinement and SB-Terrain slope materials. Materials are
 * continuous values the caller gives (no named palettes or surface classes), and the operators edit the named
 * scene meshes in place, keeping their parents' transforms.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
    ArchieBuildingRefiner,
    smoothFacadeNormals,
    generateWatertightPlinth,
    type ArchieMaterialParameters,
    type ArchieRefinedBuildingResult
} from '../src/browser/generative-canvas/services/spatial/ArchieBuildingRefiner';
import {
    SbTerrainGroundEngine,
    measureSurfaceSlope,
    materialAtSlope,
    validateSlopeStops,
    type SlopeMaterialStop
} from '../src/browser/generative-canvas/services/spatial/SbTerrainGroundEngine';

/** A weathered sandstone, as continuous values (any material the caller chooses is described the same way). */
const SANDSTONE: ArchieMaterialParameters = { color: [0.78, 0.62, 0.45], roughness: 0.86, metalness: 0.02 };
/** A slope ramp chosen for one kind of ground: level -> 0.2 roughness dark, steep -> rough light. */
const RAMP: SlopeMaterialStop[] = [
    { slopeDeg: 0, color: [0.2, 0.2, 0.22], roughness: 0.4, metalness: 0.1 },
    { slopeDeg: 60, color: [0.8, 0.7, 0.6], roughness: 1.0, metalness: 0.0 }
];

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

        const plinthMaterial = new THREE.MeshStandardMaterial();
        const plinthMesh = generateWatertightPlinth(buildingGeom, {
            plinthDepth: 3.0,
            plinthPadding: 0.4,
            material: plinthMaterial
        });
        expect(plinthMesh.material).toBe(plinthMaterial);

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
            material: SANDSTONE,
            plinthDepth: 2.0,
            plinthPadding: 0.3
        });

        expect(result.group).toBeInstanceOf(THREE.Group);
        expect(result.refinedMesh).toBeInstanceOf(THREE.Mesh);
        expect(result.plinthMesh).toBeInstanceOf(THREE.Mesh);
        expect(result.metrics.vertexCount).toBeGreaterThan(0);
        expect(result.metrics.plinthDepthMeters).toBe(2.0);
        expect(result.metrics.facadeVerticesSmoothed).toBeGreaterThan(0);

        // The material is exactly the one given; the plinth takes it too when none is given for the plinth.
        const mat = result.refinedMesh.material as THREE.MeshStandardMaterial;
        expect(mat.isMeshStandardMaterial).toBe(true);
        expect(mat.roughness).toBe(0.86);
        expect(mat.metalness).toBe(0.02);
        expect(mat.color.getHexString(THREE.SRGBColorSpace)).toBe(new THREE.Color().setRGB(0.78, 0.62, 0.45, THREE.SRGBColorSpace).getHexString(THREE.SRGBColorSpace));
        expect(result.plinthMesh.material).toBe(mat);
    });

    it('ArchieBuildingRefiner takes any material as continuous values, and refuses a missing or out-of-range one', () => {
        const refiner = new ArchieBuildingRefiner();
        const geom = new THREE.BoxGeometry(10, 10, 10);
        geom.translate(0, 5, 0);
        // A material no list would have: bioluminescent fungal stone (whatever the scene calls for).
        const fungal = refiner.refineBuilding(geom, { material: { color: [0.1, 0.9, 0.7], roughness: 0.33, metalness: 0.0 }, plinthMaterial: { color: [0.05, 0.05, 0.08], roughness: 0.95, metalness: 0.0 } });
        expect((fungal.refinedMesh.material as THREE.MeshStandardMaterial).roughness).toBe(0.33);
        expect((fungal.plinthMesh.material as THREE.MeshStandardMaterial).roughness).toBe(0.95);

        expect(() => refiner.refineBuilding(geom, {})).toThrow(/the building material needs \{ color: \[r, g, b\] in 0\.\.1/);
        expect(() => refiner.refineBuilding(geom, { material: { color: [1.2, 0.5, 0.5], roughness: 0.5, metalness: 0 } })).toThrow(/the building material needs/);
        expect(() => refiner.refineBuilding(geom, { material: SANDSTONE, plinthMaterial: { color: [0.5, 0.5, 0.5], roughness: -1, metalness: 0 } })).toThrow(/the plinth material needs/);
        expect(() => refiner.refineBuilding(geom, { palette: 'limestone' } as any)).toThrow(/the building material needs/);
    });

    it('the refined group takes the source mesh\'s own transform, so the building stays where it was under its parent', () => {
        const parent = new THREE.Group();
        parent.position.set(500, 20, -300);
        parent.rotation.y = Math.PI / 3;
        const geom = new THREE.BoxGeometry(12, 18, 12);
        geom.translate(0, 9, 0);
        const source = new THREE.Mesh(geom, new THREE.MeshStandardMaterial());
        source.position.set(10, 0, 4);
        source.rotation.y = 0.4;
        source.scale.set(2, 2, 2);
        parent.add(source);
        parent.updateMatrixWorld(true);
        const before = new THREE.Box3().setFromObject(source);

        const result = new ArchieBuildingRefiner().refineBuilding(source, { material: SANDSTONE });
        parent.add(result.group);
        parent.remove(source);
        parent.updateMatrixWorld(true);
        const after = new THREE.Box3().setFromObject(result.refinedMesh);
        expect(after.min.distanceTo(before.min)).toBeLessThan(1e-6);
        expect(after.max.distanceTo(before.max)).toBeLessThan(1e-6);
        // The plinth sits under the building's base in the same frame: rotated and scaled with it, so its footprint
        // covers the building's (it used to be offset by the source position only, at the unscaled size).
        const plinth = new THREE.Box3().setFromObject(result.plinthMesh);
        expect(plinth.max.y).toBeLessThan(before.min.y + 1);
        expect(plinth.min.x).toBeLessThanOrEqual(before.min.x);
        expect(plinth.max.x).toBeGreaterThanOrEqual(before.max.x);
        expect(plinth.min.z).toBeLessThanOrEqual(before.min.z);
        expect(plinth.max.z).toBeGreaterThanOrEqual(before.max.z);
    });
});

describe('SB-Terrain slope materials (Universal)', () => {
    const tilted = (deg: number, name: string) => {
        const geom = new THREE.PlaneGeometry(20, 20, 4, 4);
        geom.rotateX(-Math.PI / 2 + THREE.MathUtils.degToRad(deg));
        const mesh = new THREE.Mesh(geom, new THREE.MeshBasicMaterial());
        mesh.name = name;
        return mesh;
    };

    it('measures slope as continuous values, with no surface class', () => {
        for (const deg of [0, 17, 45, 72]) {
            const m = measureSurfaceSlope(tilted(deg, `s${deg}`));
            expect(m.meanSlopeDeg).toBeCloseTo(deg, 3);
            expect(Object.keys(m).sort()).toEqual(['meanSlopeDeg', 'planarityRatio', 'steepnessRatio', 'vertexCount']);
        }
        expect(measureSurfaceSlope(tilted(0, 'flat')).planarityRatio).toBe(1);
        expect(measureSurfaceSlope(tilted(72, 'steep')).steepnessRatio).toBe(1);
    });

    it('interpolates the caller\'s ramp linearly between stops and holds the end stops beyond them', () => {
        const stops = validateSlopeStops(RAMP);
        const mid = materialAtSlope(stops, 30);
        [0.5, 0.45, 0.41].forEach((c, i) => expect(mid.color[i]).toBeCloseTo(c, 9));
        expect(mid.roughness).toBeCloseTo(0.7, 9);
        expect(mid.metalness).toBeCloseTo(0.05, 9);
        expect(materialAtSlope(stops, -5).roughness).toBe(0.4);
        expect(materialAtSlope(stops, 85).roughness).toBe(1.0);
        expect(() => validateSlopeStops([])).toThrow(/at least one stop/);
        expect(() => validateSlopeStops([{ slopeDeg: 10, color: [0.5, 0.5], roughness: 0.5, metalness: 0 } as any])).toThrow(/stop 0 must be/);
    });

    it('applySlopeMaterials gives each mesh its slope\'s material in place, keeping its parent and transform', () => {
        const root = new THREE.Group();
        root.position.set(0, 100, 0);
        const level = tilted(0, 'chunk_level');
        const steep = tilted(60, 'chunk_steep');
        steep.position.set(30, 0, 0);
        root.add(level, steep);
        const result = new SbTerrainGroundEngine().applySlopeMaterials([level, steep], { stops: RAMP });
        expect(result.meshes.map(m => m.name)).toEqual(['chunk_level', 'chunk_steep']);
        expect((level.material as THREE.MeshStandardMaterial).roughness).toBeCloseTo(0.4, 6);
        expect((steep.material as THREE.MeshStandardMaterial).roughness).toBeCloseTo(1.0, 3);
        expect(level.parent).toBe(root);
        expect(steep.position.x).toBe(30);

        // An invalid ramp changes nothing.
        const untouched = level.material;
        expect(() => new SbTerrainGroundEngine().applySlopeMaterials([level], { stops: [] })).toThrow(/at least one stop/);
        expect(level.material).toBe(untouched);
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

    it('Direct-Dispatch Canvas Operators edit the meshes named in the live scene in place, and fail (adding nothing) when they are not there', async () => {
        const { DirectDispatchOperatorEngine } = await import('../src/browser/generative-canvas/services/direct-dispatch-operator-engine');

        // The review's probe: an empty scene. Both operators used to build a demo box / demo planes and succeed.
        const empty = new DirectDispatchOperatorEngine();
        const emptyScene = new THREE.Scene();
        empty.attachThreeScene(emptyScene);
        const refineEmpty = empty.dispatch('sb_refine_building_structure', { material: SANDSTONE, plinthDepth: 2.0 });
        expect(refineEmpty.success).toBe(false);
        expect(refineEmpty.error).toContain('needs targetMeshId');
        const terrainEmpty = empty.dispatch('sb_apply_slope_materials', { targetMeshId: 'ground', stops: RAMP });
        expect(terrainEmpty.success).toBe(false);
        expect(terrainEmpty.error).toContain("no mesh named or with id 'ground'");
        expect(emptyScene.children.length).toBe(0);
        // The old classifier, with its closed rock/grass/pavement classes, is gone.
        expect(empty.dispatch('sb_classify_terrain_materials', { targetMeshId: 'ground' }).success).toBe(false);

        // No viewport attached (the server-side dispatch): nothing to edit, so it fails.
        const headless = new DirectDispatchOperatorEngine().dispatch('sb_refine_building_structure', { targetMeshId: 'palazzo', material: SANDSTONE });
        expect(headless.success).toBe(false);
        expect(headless.error).toContain('no viewport is attached');

        // A scene whose tiles sit under a rotated, translated tiles group: two buildings share a name, plus a ground mesh.
        const engine = new DirectDispatchOperatorEngine();
        const scene = new THREE.Scene();
        engine.attachThreeScene(scene);
        const tiles = new THREE.Group();
        tiles.name = 'tiles_root';
        tiles.position.set(-200, 5, 80);
        tiles.rotation.y = 0.7;
        scene.add(tiles);
        const makeBuilding = (x: number) => {
            const g = new THREE.BoxGeometry(12, 18, 12);
            g.translate(0, 9, 0);
            const b = new THREE.Mesh(g, new THREE.MeshStandardMaterial());
            b.name = 'tile_mesh_0042';
            b.position.set(x, 0, 0);
            tiles.add(b);
            return b;
        };
        const buildings = [makeBuilding(0), makeBuilding(40)];
        const groundGeom = new THREE.PlaneGeometry(20, 20, 4, 4);
        groundGeom.rotateX(-Math.PI / 2);
        const ground = new THREE.Mesh(groundGeom);
        ground.name = 'tile_mesh_0043';
        tiles.add(ground);
        scene.updateMatrixWorld(true);
        const worldBoxes = buildings.map(b => new THREE.Box3().setFromObject(b));

        // A keyword-named decoy is not picked when the named mesh is missing.
        const decoy = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
        decoy.name = 'building_decoy';
        scene.add(decoy);
        const missing = engine.dispatch('sb_refine_building_structure', { targetMeshId: 'tile_mesh_9999', material: SANDSTONE });
        expect(missing.success).toBe(false);
        expect(missing.error).toContain("'tile_mesh_0042'");
        expect(scene.getObjectByName('building_decoy')).toBe(decoy);

        const noMaterial = engine.dispatch('sb_refine_building_structure', { targetMeshId: 'tile_mesh_0042' });
        expect(noMaterial.success).toBe(false);
        expect(noMaterial.error).toContain('the building material needs');
        expect(tiles.children.filter(c => c.name === 'tile_mesh_0042')).toHaveLength(2);

        const refineRes = engine.dispatch('sb_refine_building_structure', { targetMeshId: 'tile_mesh_0042', material: SANDSTONE, plinthDepth: 2.0 });
        expect(refineRes.success).toBe(true);
        expect(refineRes.data.refinedCount).toBe(2);
        expect(refineRes.data.buildings.every((b: any) => b.parentName === 'tiles_root')).toBe(true);
        expect(scene.getObjectByName('tile_mesh_0042')).toBeUndefined();
        scene.updateMatrixWorld(true);
        const refined = tiles.children.filter(c => c.name === 'archie_building_group_tile_mesh_0042').map(g => g.getObjectByName('archie_refined_tile_mesh_0042')!);
        expect(refined).toHaveLength(2);
        refined.forEach((mesh, i) => {
            const box = new THREE.Box3().setFromObject(mesh);
            expect(box.min.distanceTo(worldBoxes[i].min)).toBeLessThan(1e-6);
            expect(box.max.distanceTo(worldBoxes[i].max)).toBeLessThan(1e-6);
        });

        const terrainRes = engine.dispatch('sb_apply_slope_materials', { targetMeshId: 'tile_mesh_0043', stops: RAMP });
        expect(terrainRes.success).toBe(true);
        expect(terrainRes.data.meshes).toHaveLength(1);
        expect(terrainRes.data.meshes[0].meanSlopeDeg).toBeCloseTo(0, 4);
        expect(ground.parent).toBe(tiles);
        expect((ground.material as THREE.MeshStandardMaterial).roughness).toBeCloseTo(0.4, 6);
    });
});

describe('Slope and building refinement work in world space (+Y up), through the whole parent chain', () => {
    /** A parent that turns a Z-up asset upright, as a reorienting GLB root or a tiles frame does. */
    const zUpParent = () => {
        const parent = new THREE.Group();
        parent.name = 'z_up_root';
        parent.rotation.x = -Math.PI / 2;
        parent.position.set(50, 3, -20);
        return parent;
    };

    it('a ground built in its local XY plane under an X-rotated parent measures level, and a locally "flat" one vertical', async () => {
        const { DirectDispatchOperatorEngine } = await import('../src/browser/generative-canvas/services/direct-dispatch-operator-engine');
        const engine = new DirectDispatchOperatorEngine();
        const scene = new THREE.Scene();
        engine.attachThreeScene(scene);
        const parent = zUpParent();
        scene.add(parent);
        // The review's probe P1: PlaneGeometry lies in XY (normals +Z); the parent turns +Z into world +Y.
        const ground = new THREE.Mesh(new THREE.PlaneGeometry(20, 20, 4, 4));
        ground.name = 'z_up_ground';
        parent.add(ground);
        // Level in its own frame (normals +Y) is a wall in the world once the parent turns it.
        const wallGeom = new THREE.PlaneGeometry(20, 20, 4, 4);
        wallGeom.rotateX(-Math.PI / 2);
        const wall = new THREE.Mesh(wallGeom);
        wall.name = 'z_up_wall';
        parent.add(wall);

        const level = measureSurfaceSlope(ground);
        expect(level.meanSlopeDeg).toBeCloseTo(0, 4);
        expect(level.planarityRatio).toBe(1);
        expect(level.steepnessRatio).toBe(0);
        expect(measureSurfaceSlope(wall).meanSlopeDeg).toBeCloseTo(90, 4);

        const res = engine.dispatch('sb_apply_slope_materials', { targetMeshId: 'z_up_ground', stops: RAMP });
        expect(res.success).toBe(true);
        expect(res.data.meshes[0].meanSlopeDeg).toBeCloseTo(0, 4);
        // The level end of the ramp (roughness 0.4), not the steep end (1.0) it got from local +Y.
        expect((ground.material as THREE.MeshStandardMaterial).roughness).toBeCloseTo(0.4, 6);
        expect(ground.parent).toBe(parent);
    });

    it('a building standing along local +Z under an X-rotated parent gets vertical facades and a level plinth beneath it', async () => {
        const { DirectDispatchOperatorEngine } = await import('../src/browser/generative-canvas/services/direct-dispatch-operator-engine');
        const engine = new DirectDispatchOperatorEngine();
        const scene = new THREE.Scene();
        engine.attachThreeScene(scene);
        const parent = zUpParent();
        scene.add(parent);
        // The review's probe P1b: an 18 m building along local +Z (world up), 12 x 12 m footprint.
        const geom = new THREE.BoxGeometry(12, 12, 18);
        geom.translate(0, 0, 9);
        // Scanner noise on the four facades: a small tilt towards local +Z, which is world up.
        const normals = geom.getAttribute('normal');
        for (let i = 0; i < normals.count; i++) {
            if (Math.abs(normals.getZ(i)) < 0.5) {
                const n = new THREE.Vector3(normals.getX(i), normals.getY(i), 0.2).normalize();
                normals.setXYZ(i, n.x, n.y, n.z);
            }
        }
        const building = new THREE.Mesh(geom, new THREE.MeshStandardMaterial());
        building.name = 'z_up_building';
        building.position.set(4, -6, 0);
        building.rotation.z = 0.3;
        parent.add(building);
        scene.updateMatrixWorld(true);
        const before = new THREE.Box3().setFromObject(building);
        expect(before.max.y - before.min.y).toBeCloseTo(18, 4);

        const res = engine.dispatch('sb_refine_building_structure', { targetMeshId: 'z_up_building', material: SANDSTONE, plinthDepth: 2.0, plinthPadding: 0.3 });
        expect(res.success).toBe(true);
        scene.updateMatrixWorld(true);
        const refined = scene.getObjectByName('archie_refined_z_up_building') as THREE.Mesh;
        const plinth = scene.getObjectByName('archie_plinth_z_up_building') as THREE.Mesh;
        expect(refined.parent?.parent).toBe(parent);

        // The building did not move.
        const after = new THREE.Box3().setFromObject(refined);
        expect(after.min.distanceTo(before.min)).toBeLessThan(1e-6);
        expect(after.max.distanceTo(before.max)).toBeLessThan(1e-6);

        // The plinth lies under the building (it was a vertical slab against one facade): its top 0.1 m into the
        // base, 2 m deep, and its footprint covering the building's.
        const base = new THREE.Box3().setFromObject(plinth);
        expect(base.max.y).toBeCloseTo(before.min.y + 0.1, 4);
        expect(base.min.y).toBeCloseTo(before.min.y + 0.1 - 2.0, 4);
        expect(base.min.x).toBeLessThanOrEqual(before.min.x);
        expect(base.max.x).toBeGreaterThanOrEqual(before.max.x);
        expect(base.min.z).toBeLessThanOrEqual(before.min.z);
        expect(base.max.z).toBeGreaterThanOrEqual(before.max.z);
        // Sides along the building's heading: 12 m + 2 x 0.3 m square.
        expect(res.data.buildings[0].metrics.plinthWidthMeters).toBeCloseTo(12.6, 4);
        expect(res.data.buildings[0].metrics.plinthLengthMeters).toBeCloseTo(12.6, 4);

        // Facade normals are horizontal in the world; the roof's still points up.
        const toWorld = new THREE.Matrix3().getNormalMatrix(refined.matrixWorld);
        const out = refined.geometry.getAttribute('normal');
        let facades = 0, roof = 0;
        for (let i = 0; i < out.count; i++) {
            const n = new THREE.Vector3().fromBufferAttribute(out, i).applyMatrix3(toWorld).normalize();
            if (Math.abs(n.y) < 0.5) {
                facades++;
                expect(Math.abs(n.y)).toBeLessThan(1e-4);
            } else if (n.y > 0.5) {
                roof++;
                expect(n.y).toBeCloseTo(1, 5);
            }
        }
        expect(facades).toBe(16);
        expect(roof).toBe(4);
        expect(res.data.buildings[0].metrics.facadeVerticesSmoothed).toBe(16);
    });
});
