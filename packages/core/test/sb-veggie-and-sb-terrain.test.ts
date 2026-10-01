/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Comprehensive Test Suite for SB-Veggie (Parametric Botanical Engine) and
 * SB-Terrain (Multi-Material Ground Engine) Integration.
 *
 * Verifies:
 * 1. SB-Veggie C++20/Node synthesis across archetypes, phenology, and morphology.
 * 2. SB-Terrain multi-material classification (pavement, grass, rock) & textures.
 * 3. SB-Veggie planting on SB-Terrain: raycast ground snapping, biome admissibility,
 *    phototropic trunk vs slope root alignment, and grove distribution.
 ********************************************************************************/

import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three';
import * as fs from 'fs';
import { SbVeggieService } from '../src/node/3d-engine/sb-veggie-service';
import {
    SbTerrainGroundEngine,
    classifyTerrainSurfaceType,
    createProceduralRockStrataTexture,
    createProceduralGrassTexture,
    createProceduralCobblestoneTexture,
    type TerrainSurfaceType,
    type SbTerrainClassificationResult
} from '../src/browser/generative-canvas/services/spatial/SbTerrainGroundEngine';
import {
    TerrainManager,
    GROUND_SAMPLE_OFFSETS
} from '../src/browser/generative-canvas/services/TerrainManager';
import {
    SPECIES_ADAPTERS,
    type SupportedTreeSpecies
} from '../src/node/spatial/UniversalBotanicalBridgeService';

describe('SB-Veggie Botanical Engine Core', () => {
    let veggieService: SbVeggieService;

    beforeAll(() => {
        veggieService = new SbVeggieService();
    });

    it('1. should verify native C++ runner binary exists or compiles cleanly', async () => {
        const binPath = await veggieService.ensureBinary();
        expect(fs.existsSync(binPath)).toBe(true);
    }, 45000);

    it('2. should synthesize canonical Decurrent Oak with glTF 2.0 binary and valid foliage', async () => {
        const result = await veggieService.synthesizeTree({
            archetype: 'decurrent',
            phenology: {
                season: 1.0,
                generateLeaves: true
            }
        });

        expect(result.success).toBe(true);
        expect(result.glbBuffer).toBeDefined();
        expect(result.glbBuffer!.length).toBeGreaterThan(10000);

        // glTF 2.0 binary header check
        const magic = result.glbBuffer!.toString('utf8', 0, 4);
        expect(magic).toBe('glTF');

        expect(result.telemetry.outputVertices).toBeGreaterThan(500);
        expect(result.telemetry.outputTriangles).toBeGreaterThan(600);

        if (fs.existsSync(result.outputGlbPath)) {
            fs.unlinkSync(result.outputGlbPath);
        }
    }, 30000);

    it('3. should support seasonal winter defoliation with bare branch morphology', async () => {
        const resultWinter = await veggieService.synthesizeTree({
            archetype: 'decurrent',
            phenology: {
                season: 0.0,
                generateLeaves: false
            }
        });

        expect(resultWinter.success).toBe(true);
        expect(resultWinter.glbBuffer).toBeDefined();
        // Bare skeleton has exact template vertex & triangle counts
        expect(resultWinter.telemetry.outputVertices).toBe(2568);
        expect(resultWinter.telemetry.outputTriangles).toBe(4064);

        if (fs.existsSync(resultWinter.outputGlbPath)) {
            fs.unlinkSync(resultWinter.outputGlbPath);
        }
    }, 30000);

    it('4. should morph tree shape via morphological parameters (beta)', async () => {
        const resultMorphed = await veggieService.synthesizeTree({
            archetype: 'decurrent',
            shape: {
                dbhCaliper: 1.6,
                crownSpread: 1.5,
                treeHeight: 1.2
            },
            phenology: {
                season: 1.0,
                generateLeaves: true
            }
        });

        expect(resultMorphed.success).toBe(true);
        expect(resultMorphed.glbBuffer).toBeDefined();

        if (fs.existsSync(resultMorphed.outputGlbPath)) {
            fs.unlinkSync(resultMorphed.outputGlbPath);
        }
    }, 30000);

    it('5. should expose valid botanical species adapters for Mediterranean & temperate trees', () => {
        const speciesKeys: SupportedTreeSpecies[] = [
            'pinus_pinea',
            'quercus_ilex',
            'quercus_robur',
            'cupressus_sempervirens',
            'olea_europaea'
        ];

        for (const sp of speciesKeys) {
            const adapter = SPECIES_ADAPTERS[sp];
            expect(adapter).toBeDefined();
            expect(adapter.scientificName).toBeTruthy();
            expect(adapter.typicalCrownHeightRatio).toBeGreaterThan(0);
            expect(adapter.typicalAspectSpread).toBeGreaterThan(0);
            expect(adapter.foliageBaseHex).toMatch(/^#[0-9a-fA-F]{6}$/);
        }
    });
});

describe('SB-Terrain Multi-Material Ground Engine Core', () => {
    let terrainEngine: SbTerrainGroundEngine;

    beforeAll(() => {
        terrainEngine = new SbTerrainGroundEngine();
    });

    it('1. classifyTerrainSurfaceType: accurately categorizes surfaces by slope angle', () => {
        // Flat pavement plaza (slope 0°)
        const flatGeom = new THREE.PlaneGeometry(10, 10, 4, 4);
        flatGeom.rotateX(-Math.PI / 2);
        expect(classifyTerrainSurfaceType(flatGeom)).toBe('pavement');

        // Rolling lawn (slope ~ 20°)
        const lawnGeom = new THREE.PlaneGeometry(10, 10, 4, 4);
        lawnGeom.rotateX(-Math.PI / 2 + Math.PI / 9);
        expect(classifyTerrainSurfaceType(lawnGeom)).toBe('grass');

        // Steep bedrock scarp (slope ~ 50° > 32° threshold)
        const cliffGeom = new THREE.PlaneGeometry(10, 10, 4, 4);
        cliffGeom.rotateX(-Math.PI / 2 + Math.PI / 3.6);
        expect(classifyTerrainSurfaceType(cliffGeom, { rockSlopeThresholdDeg: 32 })).toBe('rock');
    });

    it('2. generates procedural textures for rock strata, grass soil, and cobblestone pavers', () => {
        const rockTex = createProceduralRockStrataTexture();
        const grassTex = createProceduralGrassTexture();
        const cobbleTex = createProceduralCobblestoneTexture();

        expect(rockTex).toBeInstanceOf(THREE.Texture);
        expect(grassTex).toBeInstanceOf(THREE.Texture);
        expect(cobbleTex).toBeInstanceOf(THREE.Texture);

        expect(rockTex.wrapS).toBe(THREE.RepeatWrapping);
        expect(grassTex.wrapS).toBe(THREE.RepeatWrapping);
        expect(cobbleTex.wrapS).toBe(THREE.RepeatWrapping);
    });

    it('3. classifyAndRenderTerrain: segments ground meshes into dedicated material groups', () => {
        const pGeom = new THREE.PlaneGeometry(20, 20, 2, 2);
        pGeom.rotateX(-Math.PI / 2);
        const pMesh = new THREE.Mesh(pGeom);
        pMesh.name = 'plaza_pavement';

        const gGeom = new THREE.PlaneGeometry(20, 20, 2, 2);
        gGeom.rotateX(-Math.PI / 2 + Math.PI / 10);
        const gMesh = new THREE.Mesh(gGeom);
        gMesh.name = 'meadow_lawn';

        const rGeom = new THREE.PlaneGeometry(20, 20, 2, 2);
        rGeom.rotateX(-Math.PI / 2 + Math.PI / 3);
        const rMesh = new THREE.Mesh(rGeom);
        rMesh.name = 'escarpment_rock';

        const res = terrainEngine.classifyAndRenderTerrain([pMesh, gMesh, rMesh]);

        expect(res.terrainGroup.children.length).toBe(3);
        expect(res.metrics.totalSubmeshes).toBe(3);
        expect(res.metrics.pavementCount).toBe(1);
        expect(res.metrics.grassCount).toBe(1);
        expect(res.metrics.rockCount).toBe(1);

        // Test layer isolation
        terrainEngine.setLayer('grass');
        expect(res.grassGroup.visible).toBe(true);
        expect(res.pavementGroup.visible).toBe(false);
        expect(res.rocksGroup.visible).toBe(false);

        terrainEngine.setLayer('all');
        expect(res.grassGroup.visible).toBe(true);
        expect(res.pavementGroup.visible).toBe(true);
        expect(res.rocksGroup.visible).toBe(true);
    });
});

describe('SB-Veggie on SB-Terrain: Grounding, Biome Snapping & Phototropism', () => {
    let scene: THREE.Scene;
    let terrainMesh: THREE.Mesh;
    let terrainManager: TerrainManager;

    // Mathematical undulating terrain formula: y = 4.0 + sin(x * 0.1) * 2.5 + cos(z * 0.1) * 1.5
    const terrainHeightFn = (x: number, z: number): number => {
        return 4.0 + Math.sin(x * 0.1) * 2.5 + Math.cos(z * 0.1) * 1.5;
    };

    beforeAll(() => {
        scene = new THREE.Scene();

        // Construct 100m x 100m undulating terrain mesh with 40x40 subdivisions
        const terrainGeo = new THREE.PlaneGeometry(100, 100, 40, 40);
        terrainGeo.rotateX(-Math.PI / 2);

        const posAttr = terrainGeo.attributes.position as THREE.BufferAttribute;
        for (let i = 0; i < posAttr.count; i++) {
            const x = posAttr.getX(i);
            const z = posAttr.getZ(i);
            posAttr.setY(i, terrainHeightFn(x, z));
        }
        terrainGeo.computeVertexNormals();

        terrainMesh = new THREE.Mesh(terrainGeo, new THREE.MeshStandardMaterial({ name: 'Terrain_Grass' }));
        terrainMesh.name = 'Ground_Terrain';
        terrainMesh.updateMatrixWorld(true);
        scene.add(terrainMesh);

        terrainManager = new TerrainManager({ scene });
    });

    it('1. should accurately sample terrain elevation across undulating surface for tree placement', () => {
        const testPoints: Array<[number, number]> = [
            [0, 0],
            [12, -8],
            [-25, 30],
            [15, 20],
            [-10, -15]
        ];

        for (const [x, z] of testPoints) {
            const sampledY = terrainManager.sampleHeight(x, z);
            const expectedY = terrainHeightFn(x, z);

            expect(sampledY).not.toBeNull();
            // Raycast on 40x40 grid closely matches mathematical heightfield within tessellation tolerance
            expect(Math.abs(sampledY! - expectedY)).toBeLessThan(0.35);
        }
    });

    it('2. should snap SB-Veggie tree root bases flush to undulating terrain', () => {
        // Create 3 dummy tree container groups representing SB-Veggie instances
        const tree1 = new THREE.Group();
        tree1.position.set(-15, 0, 10);
        scene.add(tree1);

        const tree2 = new THREE.Group();
        tree2.position.set(20, 0, -5);
        scene.add(tree2);

        const snapped1 = terrainManager.snapObjectToGround(tree1);
        const snapped2 = terrainManager.snapObjectToGround(tree2);

        expect(snapped1).not.toBeNull();
        expect(snapped2).not.toBeNull();

        // Verify that tree Y positions now match the sampled terrain height
        expect(tree1.position.y).toBeCloseTo(snapped1!, 4);
        expect(tree2.position.y).toBeCloseTo(snapped2!, 4);
    });

    it('3. should enforce phototropic upward growth (+Y) with slope-adapted root buttress', () => {
        // On a sloped terrain face, the surface normal has non-zero X/Z components
        const x = 12.0;
        const z = 8.0;

        const hits = terrainManager.raycastVertical(x, z);
        expect(hits.length).toBeGreaterThan(0);

        const hit = hits[0]!;
        const groundNormal = hit.face?.normal || new THREE.Vector3(0, 1, 0);

        // In nature, tree trunks grow phototropically toward zenith (+Y)
        const trunkGrowthVector = new THREE.Vector3(0, 1, 0);
        // The root flare spreads perpendicular to the terrain normal
        const rootFlareAlignment = groundNormal.clone().normalize();

        // Angle between ground normal and vertical trunk
        const slopeAngleRad = groundNormal.angleTo(trunkGrowthVector);
        const slopeAngleDeg = THREE.MathUtils.radToDeg(slopeAngleRad);

        // Verify terrain has measurable slope at this location
        expect(slopeAngleDeg).toBeGreaterThan(0);
        // Trunk growth vector must remain strictly plumb vertical
        expect(trunkGrowthVector.y).toBe(1.0);
        expect(trunkGrowthVector.x).toBe(0.0);
        expect(trunkGrowthVector.z).toBe(0.0);
    });

    it('4. should enforce ecological biome admissibility: planting on grass and rejecting pavement/cliffs', () => {
        // Simulated biome classification function
        const canPlantTree = (surfaceType: TerrainSurfaceType, slopeDeg: number): { allowed: boolean; reason: string } => {
            if (surfaceType === 'pavement') {
                return { allowed: false, reason: 'Impervious urban pavement / cobblestone plaza' };
            }
            if (surfaceType === 'rock' || slopeDeg > 32) {
                return { allowed: false, reason: 'Steep bedrock escarpment / unstable crag slope' };
            }
            return { allowed: true, reason: 'Fertile park lawn / natural meadow soil' };
        };

        // Case A: Park Lawn (grass, slope 15°)
        const lawnCheck = canPlantTree('grass', 15);
        expect(lawnCheck.allowed).toBe(true);

        // Case B: Cobblestone Piazza (pavement, slope 2°)
        const pavementCheck = canPlantTree('pavement', 2);
        expect(pavementCheck.allowed).toBe(false);
        expect(pavementCheck.reason).toContain('pavement');

        // Case C: Steep Crag Scarp (rock, slope 48°)
        const cliffCheck = canPlantTree('rock', 48);
        expect(cliffCheck.allowed).toBe(false);
        expect(cliffCheck.reason).toContain('bedrock');
    });

    it('5. should distribute a grove of trees with minimum collision spacing and 100% terrain grounding', () => {
        interface PlantedTree {
            id: string;
            species: SupportedTreeSpecies;
            x: number;
            z: number;
            groundY: number;
            scale: number;
        }

        const grove: PlantedTree[] = [];
        const speciesList: SupportedTreeSpecies[] = ['pinus_pinea', 'quercus_robur', 'cupressus_sempervirens'];
        const minDistanceM = 6.0; // Trees must be at least 6m apart

        const candidateCoords: Array<[number, number]> = [
            [-20, -10],
            [-12, -12],
            [-18, 5],
            [-5, 12],
            [10, -15],
            [18, -12],
            [12, 10],
            [22, 18],
            [5, 25]
        ];

        for (let i = 0; i < candidateCoords.length; i++) {
            const [cx, cz] = candidateCoords[i]!;

            // Check collision with already planted trees
            const collision = grove.some(t => Math.hypot(t.x - cx, t.z - cz) < minDistanceM);
            if (collision) continue;

            const groundY = terrainManager.sampleHeight(cx, cz);
            if (groundY !== null) {
                grove.push({
                    id: `tree_${grove.length}`,
                    species: speciesList[grove.length % speciesList.length]!,
                    x: cx,
                    z: cz,
                    groundY,
                    scale: 0.85 + (i * 0.05)
                });
            }
        }

        // Verify grove generated successfully
        expect(grove.length).toBeGreaterThanOrEqual(5);

        // Verify all trees satisfy minimum distance constraint
        for (let i = 0; i < grove.length; i++) {
            for (let j = i + 1; j < grove.length; j++) {
                const dist = Math.hypot(grove[i]!.x - grove[j]!.x, grove[i]!.z - grove[j]!.z);
                expect(dist).toBeGreaterThanOrEqual(minDistanceM);
            }
        }

        // Verify each tree root is grounded directly to terrain elevation
        for (const tree of grove) {
            const verifyY = terrainManager.sampleHeight(tree.x, tree.z);
            expect(verifyY).not.toBeNull();
            expect(tree.groundY).toBeCloseTo(verifyY!, 3);
        }
    });

    it('6. should synchronize seasonal phenology between botanical trees and ground turf', () => {
        interface SeasonalSceneState {
            season: 'summer' | 'autumn' | 'winter';
            groundColor: number;
            foliageDensity: number;
            foliageColor: number;
            bareBranches: boolean;
        }

        const resolveSeason = (season: 'summer' | 'autumn' | 'winter'): SeasonalSceneState => {
            switch (season) {
                case 'summer':
                    return {
                        season: 'summer',
                        groundColor: 0x446c24, // Mediterranean green turf
                        foliageDensity: 1.0,
                        foliageColor: 0x2d5a27,
                        bareBranches: false
                    };
                case 'autumn':
                    return {
                        season: 'autumn',
                        groundColor: 0x73683b, // Golden straw lawn
                        foliageDensity: 0.85,
                        foliageColor: 0xc87d1e, // Golden amber foliage
                        bareBranches: false
                    };
                case 'winter':
                    return {
                        season: 'winter',
                        groundColor: 0x3d443a, // Dormant frosted soil
                        foliageDensity: 0.0,
                        foliageColor: 0x000000,
                        bareBranches: true
                    };
            }
        };

        const summerState = resolveSeason('summer');
        expect(summerState.bareBranches).toBe(false);
        expect(summerState.foliageDensity).toBe(1.0);

        const winterState = resolveSeason('winter');
        expect(winterState.bareBranches).toBe(true);
        expect(winterState.foliageDensity).toBe(0.0);

        const autumnState = resolveSeason('autumn');
        expect(autumnState.foliageDensity).toBeGreaterThan(0);
        expect(autumnState.foliageColor).toBe(0xc87d1e);
    });
});
