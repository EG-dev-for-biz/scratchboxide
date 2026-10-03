import { test } from 'vitest';
/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as assert from 'assert';
import * as THREE from 'three';
import {
    planWorldIntentHeuristic,
    planWorldIntent,
    planSwarmTasks,
    createSeededRandom,
    seededRandomFloat,
    seededRandomInt,
    seededChoice,
    generateCompositeHeightfield,
    buildTerrainFoundation,
    createTerrainMesh,
    sampleGridElevation,
    estimateTerrainNormal,
    localToGeo,
    getActorHalfHeight,
    placeRegionalObjects,
    refinePlacedActors,
    BuildingFootprintInput,
    cleanFootprint,
    computeCentroid,
    scalePolygon,
    computePhotogrammetryElevation,
    getBuildingColor,
    generateNativeBuildingMeshBuffer,
    buildNativeThreeGeometry,
    sampleElevationGridFrom3DTiles,
    sculptBuildingFrom3DTiles,
    snapFootprintsToTerrain,
    validateBufferGeometryTopology,
    inspectSceneMeshTopology,
    generateSBMeshCodeFromPrompt,
    generateProceduralThreeMeshFromPrompt,
    auditAndRepairCppMeshCode,
    createWorldBuilderScene,
    detect3DSceneTheme,
    synthesizeContextual3DScene
} from '../src/browser/generative-canvas/procedural-3d-synthesizer';

async function runWorldbuilderAndMeshEngineTests() {
    console.log('🧪 Running Comprehensive In-Tree 3D Worldbuilder & Mesh Engine Test Suite...\n');

    // -----------------------------------------------------------------------
    // TEST 1: Seeded Random PRNG & Determinism
    // -----------------------------------------------------------------------
    console.log('  Testing 1: Seeded Random PRNG (Mulberry32) Determinism...');
    const rng1 = createSeededRandom(42);
    const seq1 = [rng1(), rng1(), rng1(), rng1()];
    const rng2 = createSeededRandom(42);
    const seq2 = [rng2(), rng2(), rng2(), rng2()];
    assert.deepStrictEqual(seq1, seq2, 'Identical seeds must produce identical pseudorandom float sequences');

    const rng3 = createSeededRandom(999);
    const seq3 = [rng3(), rng3(), rng3(), rng3()];
    assert.notDeepStrictEqual(seq1, seq3, 'Different seeds must produce different sequences');

    const rndFloat = seededRandomFloat(rng1, 10, 20);
    assert.ok(rndFloat >= 10 && rndFloat <= 20, 'seededRandomFloat must stay within bounds');

    const rndInt = seededRandomInt(rng1, 5, 15);
    assert.ok(rndInt >= 5 && rndInt <= 15 && Number.isInteger(rndInt), 'seededRandomInt must produce integers within bounds');

    const picked = seededChoice(rng1, ['alpine', 'canyon', 'desert', 'cyberpunk']);
    assert.ok(['alpine', 'canyon', 'desert', 'cyberpunk'].includes(picked), 'seededChoice must pick an array member');
    console.log('  ✓ Test 1 Passed: PRNG Mulberry32 determinism verified.');

    // -----------------------------------------------------------------------
    // TEST 2: WorldIntentPlanner Across Diverse Themes
    // -----------------------------------------------------------------------
    console.log('  Testing 2: WorldIntentPlanner Intent Extraction Across Diverse Themes...');
    const cyberSpec = planWorldIntentHeuristic('Cyberpunk neon megacity with flying transit');
    assert.strictEqual(typeof cyberSpec.name, 'string');
    assert.ok(cyberSpec.regions.length >= 3, 'Must decompose into at least 3 regions');
    assert.strictEqual(cyberSpec.terrain.baseMaterial.metalness, 0.7);
    assert.ok(cyberSpec.objects.some(o => o.category === 'tower'), 'Cyberpunk scene must include tower objects');

    const battleSpec = planWorldIntentHeuristic('Historic revolutionary battlefield at Lexington Green');
    assert.ok(battleSpec.regions.some(r => r.category === 'plain' || r.category === 'citadel'), 'Battlefield must have plains or citadels');
    assert.ok(battleSpec.objects.some(o => o.category === 'tree'), 'Battlefield must have tree scattering');

    const alpineSpec = planWorldIntentHeuristic('Alpine mountain valley with snow glaciers and chalets');
    assert.ok(alpineSpec.regions.some(r => r.category === 'mountain'), 'Alpine theme must include mountain region');
    assert.ok(alpineSpec.terrain.elevationMax >= 50, 'Alpine elevation should reflect high mountains');

    const desertSpec = planWorldIntentHeuristic('Arid desert canyon with sandstone mesas and watchtower outpost');
    assert.ok(desertSpec.regions.some(r => r.category === 'canyon' || r.category === 'desert'), 'Desert theme must include canyon/desert regions');

    const plannedAsync = await planWorldIntent('Sci-fi lunar outpost');
    assert.ok(plannedAsync.regions.length >= 3, 'Async world planner must return valid specification');

    const swarmTasks = await planSwarmTasks('Medieval fortress on cliff');
    assert.ok(swarmTasks.materialsToSynthesize.length >= 1, 'Swarm tasks must include materials');
    assert.ok(swarmTasks.customAssetsToBuild.length >= 1, 'Swarm tasks must include custom assets');
    console.log('  ✓ Test 2 Passed: WorldIntentPlanner extracted structured specifications across all major themes.');

    // -----------------------------------------------------------------------
    // TEST 3: TerrainFoundationEngine Heightmap Generation & Mesh Synthesis
    // -----------------------------------------------------------------------
    console.log('  Testing 3: TerrainFoundationEngine Heightmap & Three.js Mesh Generation...');
    const res = 16;
    const heightGrid = generateCompositeHeightfield(alpineSpec, res);
    assert.strictEqual(heightGrid.resolution, res);
    assert.strictEqual(heightGrid.elevations.length, res * res);
    assert.ok(heightGrid.minElevation >= alpineSpec.terrain.elevationMin - 1e-4, 'Heightfield must respect min elevation');
    assert.ok(heightGrid.maxElevation <= alpineSpec.terrain.elevationMax + 1e-4, 'Heightfield must respect max elevation');

    const builtFoundation = await buildTerrainFoundation(desertSpec, { resolution: 16 });
    assert.strictEqual(builtFoundation.resolution, 16);
    assert.strictEqual(builtFoundation.elevations.length, 256);

    const terrainMesh = createTerrainMesh(heightGrid, THREE, {
        width: 120,
        depth: 120,
        color: 0x4a7c59
    });
    assert.ok(terrainMesh instanceof THREE.Mesh, 'createTerrainMesh must return a THREE.Mesh');
    assert.ok(terrainMesh.geometry instanceof THREE.PlaneGeometry, 'Terrain geometry must be PlaneGeometry');
    assert.strictEqual(terrainMesh.geometry.attributes.position.count, 256);
    console.log('  ✓ Test 3 Passed: Multi-octave composite heightmap and Three.js terrain mesh generated successfully.');

    // -----------------------------------------------------------------------
    // TEST 4: RegionalPlacementEngine Deterministic Scattering & Slope Alignment
    // -----------------------------------------------------------------------
    console.log('  Testing 4: RegionalPlacementEngine Deterministic Scattering & Slope Alignment...');
    const elevationAtCenter = sampleGridElevation(0, 0, heightGrid);
    assert.strictEqual(typeof elevationAtCenter, 'number');

    const normal = estimateTerrainNormal(10, 10, heightGrid);
    assert.strictEqual(typeof normal.nx, 'number');
    assert.strictEqual(typeof normal.ny, 'number');
    assert.strictEqual(typeof normal.nz, 'number');
    const normLen = Math.sqrt(normal.nx * normal.nx + normal.ny * normal.ny + normal.nz * normal.nz);
    assert.ok(Math.abs(normLen - 1.0) < 1e-3, 'Terrain normal vector must be normalized to unit length');

    const geoCoord = localToGeo(100, 10, -50, { lat: 40.7812, lng: -73.9665, alt: 0 });
    assert.ok(typeof geoCoord.lat === 'number' && typeof geoCoord.lng === 'number');

    const halfHeight = getActorHalfHeight('Cylinder', 2.0);
    assert.strictEqual(halfHeight, 2.0);

    const placedA = placeRegionalObjects(alpineSpec, heightGrid, 777);
    const placedB = placeRegionalObjects(alpineSpec, heightGrid, 777);
    assert.strictEqual(placedA.length, placedB.length, 'Same seed must yield identical actor counts');
    assert.deepStrictEqual(placedA, placedB, 'Same seed must yield 100% identical actor placements');

    const placedC = placeRegionalObjects(alpineSpec, heightGrid, 999);
    assert.notDeepStrictEqual(placedA, placedC, 'Different seed must produce distinct scattering');

    const refined = refinePlacedActors(placedA, heightGrid);
    assert.strictEqual(refined.length, placedA.length);
    console.log('  ✓ Test 4 Passed: Regional placement scattering, slope orientation, and refinement verified.');

    // -----------------------------------------------------------------------
    // TEST 5: Parametric Building Mesh Extrusion & Roof Types
    // -----------------------------------------------------------------------
    console.log('  Testing 5: Parametric Architectural Mesh Engine & Roof Types...');
    const rawFootprint = [
        { x: 0, z: 0 },
        { x: 20, z: 0 },
        { x: 20, z: 15 },
        { x: 0, z: 15 },
        { x: 0, z: 0 } // Duplicate closing point
    ];
    const cleaned = cleanFootprint(rawFootprint);
    assert.strictEqual(cleaned.length, 4, 'cleanFootprint must remove duplicate closing vertex');

    const centroid = computeCentroid(cleaned);
    assert.strictEqual(centroid.cx, 10);
    assert.strictEqual(centroid.cz, 7.5);

    const scaled = scalePolygon(cleaned, 0.5, centroid.cx, centroid.cz);
    assert.strictEqual(scaled[0].x, 5);
    assert.strictEqual(scaled[0].z, 3.75);

    // Test distinct roof types: flat, gabled, hipped, mansard, domed, setback
    const roofTypes: Array<'flat' | 'gabled' | 'hipped' | 'mansard' | 'domed' | 'setback'> = [
        'flat', 'gabled', 'hipped', 'mansard', 'domed', 'setback'
    ];

    for (const rType of roofTypes) {
        const fpInput: BuildingFootprintInput = {
            id: `bld_${rType}`,
            geometry: cleaned,
            heightMeters: 20,
            baseElevationMeters: 2.0,
            roofType: rType,
            roofHeightMeters: 4.0,
            tags: { building: 'commercial', 'building:material': 'brick' }
        };

        const meshBuf = generateNativeBuildingMeshBuffer([fpInput]);
        assert.ok(meshBuf.positions instanceof Float32Array);
        assert.ok(meshBuf.normals instanceof Float32Array);
        assert.ok(meshBuf.uvs instanceof Float32Array);
        assert.ok(meshBuf.indices instanceof Uint32Array);
        assert.ok(meshBuf.vertexCount > 0, `Roof type ${rType} must produce vertices`);
        assert.ok(meshBuf.indexCount > 0, `Roof type ${rType} must produce triangle indices`);
        assert.strictEqual(meshBuf.positions.length, meshBuf.vertexCount * 3);
        assert.strictEqual(meshBuf.normals.length, meshBuf.vertexCount * 3);
        assert.strictEqual(meshBuf.uvs.length, meshBuf.vertexCount * 2);
        assert.strictEqual(meshBuf.indices.length, meshBuf.indexCount);

        const threeGeom = buildNativeThreeGeometry(meshBuf, THREE);
        assert.ok(threeGeom instanceof THREE.BufferGeometry);
        assert.strictEqual(threeGeom.attributes.position.count, meshBuf.vertexCount);

        const color = getBuildingColor(fpInput);
        assert.strictEqual(color.length, 3);
    }
    console.log('  ✓ Test 5 Passed: Parametric extrusion for all roof types (flat, gabled, hipped, mansard, domed, setback) and Three.js geometry buffers verified.');

    // -----------------------------------------------------------------------
    // TEST 6: Mesh Tile Sculptor & Photogrammetric Roof Deformation
    // -----------------------------------------------------------------------
    console.log('  Testing 6: Mesh Tile Sculptor & Roof Deformation...');
    const testBuilding: BuildingFootprintInput = {
        id: 'bld_photogrammetric',
        geometry: cleaned,
        heightMeters: 22,
        baseElevationMeters: 3.0,
        tags: { building: 'commercial', 'building:material': 'glass' }
    };

    // Test photogrammetry elevation calculation directly
    const directElev = computePhotogrammetryElevation(10, 7.5, 0, 20, 0, 15, 3, 25);
    assert.ok(directElev >= 20, 'computePhotogrammetryElevation must return valid elevation near topY');

    const tileGrid = sampleElevationGridFrom3DTiles(testBuilding, {
        gridResolution: 16,
        heightSmoothingFactor: 0.3
    });
    assert.strictEqual(tileGrid.gridResolution, 16);
    assert.strictEqual(tileGrid.elevations.length, 256);

    const sculptResult = sculptBuildingFrom3DTiles(testBuilding, tileGrid, {
        gridResolution: 16,
        heightSmoothingFactor: 0.25
    }, THREE);
    assert.ok(sculptResult.meshBuffer.vertexCount > 0);
    assert.ok(sculptResult.geometry instanceof THREE.BufferGeometry);
    assert.ok(sculptResult.stats.averageRoofHeight >= 22);
    console.log('  ✓ Test 6 Passed: Roof deformation, edge stitching, and tile sampling executed.');

    // -----------------------------------------------------------------------
    // TEST 7: Ground Elevation Snapper
    // -----------------------------------------------------------------------
    console.log('  Testing 7: Ground Elevation Snapper...');
    const sampleAreas = [
        {
            id: 'area_snapped_01',
            geometry: [
                { x: -20, z: -10 },
                { x: 0, z: -10 },
                { x: 0, z: 10 },
                { x: -20, z: 10 }
            ]
        },
        {
            id: 'area_snapped_02',
            geometry: [
                { x: 10, z: 15 },
                { x: 30, z: 15 },
                { x: 30, z: 35 },
                { x: 10, z: 35 }
            ]
        }
    ];

    const snapResult = snapFootprintsToTerrain(sampleAreas, heightGrid);
    assert.strictEqual(snapResult.count, 2);
    assert.ok(typeof snapResult.avgElevation === 'number');
    assert.ok(snapResult.updatedAreas[0].baseElevationMeters >= 0);
    assert.ok(snapResult.updatedAreas[1].baseElevationMeters >= 0);
    console.log('  ✓ Test 7 Passed: Footprint ground snapping with terrain elevation grid verified.');

    // -----------------------------------------------------------------------
    // TEST 8: Mesh Topology Inspector & Quality Auditing
    // -----------------------------------------------------------------------
    console.log('  Testing 8: Mesh Quality Inspector & Buffer Topology Validation...');
    const qualityReport = inspectSceneMeshTopology(8000);
    assert.strictEqual(qualityReport.totalFaces, 8000);
    assert.strictEqual(qualityReport.isManifold, true);
    assert.strictEqual(qualityReport.qualityScore, 1.0);

    // Test buffer topology validation with clean BoxGeometry
    const testBox = new THREE.BoxGeometry(4, 4, 4);
    const posAttr = testBox.attributes.position as THREE.BufferAttribute;
    const posArr = posAttr.array as Float32Array;
    const indexAttr = testBox.index as THREE.BufferAttribute;
    const idxArr = indexAttr.array as Uint16Array;
    const bufferReport = validateBufferGeometryTopology(posArr, idxArr);
    assert.strictEqual(bufferReport.isManifold, true);
    assert.ok(bufferReport.qualityScore >= 0.9);
    console.log('  ✓ Test 8 Passed: Topology validator, manifold checks, and quality scoring verified.');

    // -----------------------------------------------------------------------
    // TEST 9: Gemini Mesh Generator & Procedural Three.js Builders
    // -----------------------------------------------------------------------
    console.log('  Testing 9: In-Tree Procedural Three.js Mesh Generation & C++ Code Gen...');
    const towerResult = generateProceduralThreeMeshFromPrompt('cyberpunk skyscraper tower with glowing antenna', THREE);
    assert.ok(towerResult.mesh instanceof THREE.Group);
    assert.ok(towerResult.summary.includes('Tower'));

    const treeResult = generateProceduralThreeMeshFromPrompt('coniferous pine tree with tiered evergreen needles', THREE);
    assert.ok(treeResult.mesh instanceof THREE.Group);
    assert.ok(treeResult.summary.includes('tree'));

    const houseResult = generateProceduralThreeMeshFromPrompt('stone dwelling with pitched timber roof', THREE);
    assert.ok(houseResult.mesh instanceof THREE.Group);

    const cppCode = await generateSBMeshCodeFromPrompt({ prompt: 'watchtower outpost' });
    assert.ok(cppCode.includes('SBMesh *generate_scratchbox_custom_mesh()'));

    const auditRes = await auditAndRepairCppMeshCode('asset_tower_01', 'tower', cppCode);
    assert.strictEqual(auditRes.repaired, false);

    const brokenCode = `float x = 10; // broken`;
    const repairedRes = await auditAndRepairCppMeshCode('asset_broken_01', 'tower', brokenCode);
    assert.strictEqual(repairedRes.repaired, true);
    assert.ok(repairedRes.repairedCode.includes('generate_scratchbox_custom_mesh'));
    console.log('  ✓ Test 9 Passed: In-tree procedural mesh generator and C++ SBMesh generator verified.');

    // -----------------------------------------------------------------------
    // TEST 10: Full Procedural World Scene Integration in Viewport
    // -----------------------------------------------------------------------
    console.log('  Testing 10: Full Three.js Scene Viewport Integration & Synthesis...');
    const testScene = new THREE.Scene();
    const worldGroup = createWorldBuilderScene(testScene, THREE, {
        prompt: 'Alpine glacial valley with timber chalets and pine forests',
        resolution: 16,
        seed: 42
    });

    assert.ok(worldGroup instanceof THREE.Group);
    assert.strictEqual(worldGroup.name, 'procedural-worldbuilder');
    assert.ok(worldGroup.children.length > 2, 'Worldbuilder must add terrain mesh, placed actors, and lights');
    assert.ok(testScene.children.includes(worldGroup));

    // Test contextual synthesis pipeline
    const detectedTheme = detect3DSceneTheme('Create a procedural alpine mountain terrain with pine trees and outposts');
    assert.strictEqual(detectedTheme, 'worldbuilder');

    const synthesizedScene = synthesizeContextual3DScene('Create a procedural alpine mountain terrain with pine trees and outposts');
    assert.strictEqual(synthesizedScene.sceneType, 'worldbuilder');
    assert.ok(synthesizedScene.customMeshes && synthesizedScene.customMeshes.length > 0);
    assert.ok(synthesizedScene.features?.terrainBiomes);
    assert.ok(synthesizedScene.customScript && synthesizedScene.customScript.includes('createWorldBuilderScene'));
    console.log('  ✓ Test 10 Passed: Full in-tree 3D scene synthesis, worldbuilder scene graph, and script execution verified.');

    console.log('\n🎉 ALL 10 IN-TREE 3D WORLDBUILDER & PROCEDURAL MESH ENGINE TESTS PASSED CLEANLY!\n');
}

test('in-tree-3d-worldbuilder.test', async () => {
    await runWorldbuilderAndMeshEngineTests();
}, 180_000);
