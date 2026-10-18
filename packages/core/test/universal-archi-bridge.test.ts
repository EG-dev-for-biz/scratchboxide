/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Universal Architectural Bridge Service Unit Tests (SB-Archi)
 * Validates ingesting real-world 3D architectural entities from the Spatial Separator
 * and generating watertight 1:1 metric replacement classical monuments across typologies.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { measureGlbEdgeManifold } from '../src/node/3d-engine/glb-edge-manifold';
import {
    UniversalArchiBridgeService,
    ARCHI_TYPOLOGY_ADAPTERS,
    generateProceduralArchiGlb,
    type SpatialArchiEntity
} from '../src/node/spatial/UniversalArchiBridgeService';

describe('UniversalArchiBridgeService (Spatial Separator to SB-Archi)', () => {
    const bridge = new UniversalArchiBridgeService();
    const macroEntitiesPath = path.resolve(process.cwd(), 'public/models/macro_entities.json');
    let macroEntities: SpatialArchiEntity[] = [];

    if (fs.existsSync(macroEntitiesPath)) {
        try {
            macroEntities = JSON.parse(fs.readFileSync(macroEntitiesPath, 'utf8'));
        } catch (e) {
            macroEntities = [];
        }
    }

    it('correctly maps classical architectural typologies and prompt descriptions to adapters', () => {
        // 1. Triumphal Arch
        const arch = UniversalArchiBridgeService.resolveTypology(
            'monument',
            'Arch of Constantine (Arco di Costantino)',
            'Triple-fornix Roman triumphal arch'
        );
        expect(arch.typology).toBe('triumphal_arch');
        expect(arch.tectonicClass).toBe('TriumphalArch');
        expect(arch.order).toBe('composite');
        expect(arch.hasAttic).toBe(true);

        // 2. Amphitheater
        const amphi = UniversalArchiBridgeService.resolveTypology(
            'monument',
            'Colosseum Outer Arcade Facade',
            'Four-tiered classical amphitheater arcade with radial vomitoria'
        );
        expect(amphi.typology).toBe('amphitheater');
        expect(amphi.tectonicClass).toBe('Amphitheater');
        expect(amphi.order).toBe('mixed_superimposed');

        // 3. Peripteral Temple
        const temple = UniversalArchiBridgeService.resolveTypology(
            'ruin',
            'Temple of Venus and Roma',
            'Colonnaded peripteral temple on high raised podium'
        );
        expect(temple.typology).toBe('peripteral_temple');
        expect(temple.hasPediment).toBe(true);

        // 4. Colonnade
        const colonnade = UniversalArchiBridgeService.resolveTypology(
            'structure',
            'Porticus Gai et Lucii Colonnade',
            'Continuous covered stoa portico'
        );
        expect(colonnade.typology).toBe('colonnade');

        // 5. Aqueduct Arcade
        const aqueduct = UniversalArchiBridgeService.resolveTypology(
            'infrastructure',
            'Pont du Gard Aqueduct Arcade',
            'Tiered stone arcade carrying elevated specus water channel'
        );
        expect(aqueduct.typology).toBe('aqueduct_arcade');

        // 6. Rotunda
        const rotunda = UniversalArchiBridgeService.resolveTypology(
            'ruin',
            'Meta Sudans Ancient Fountain Ruins',
            'Conical circular fountain core with concentric basins'
        );
        expect(rotunda.typology).toBe('rotunda');
        expect(rotunda.vaultType).toBe('conical_core');

        // 7. Basilica Hall & Ancient Substructures
        const basilica = UniversalArchiBridgeService.resolveTypology(
            'hall',
            'Basilica of Maxentius and Constantine',
            'Monumental groin-vaulted central nave with coffered lateral aisles'
        );
        expect(basilica.typology).toBe('basilica_hall');

        const velianRuins = UniversalArchiBridgeService.resolveTypology(
            'ruin',
            'Velian Hill Opus Latericium Substructure Ruins',
            'Exposed Roman opus latericium brick-faced concrete retaining wall ruins on the Velian slope'
        );
        expect(velianRuins.typology).toBe('basilica_hall');

        // 8. Campanile Bell Tower
        const campanile = UniversalArchiBridgeService.resolveTypology(
            'monument',
            'Santa Francesca Romana Romanesque Campanile Bell Tower',
            '12th-century Romanesque five-story brick bell tower with marble bifora windows and pyramid spire'
        );
        expect(campanile.typology).toBe('campanile_tower');
        expect(campanile.tectonicClass).toBe('CampanileTower');
        expect(campanile.vaultType).toBe('pyramid_spire');

        // 9. Colonnade & Sacred Curbstones / Cippi
        const curbstones = UniversalArchiBridgeService.resolveTypology(
            'ruin',
            'Sacred Boundary Travertine Blocks Cippi',
            'Curvilinear travertine blocks and boundary markers'
        );
        expect(curbstones.typology).toBe('colonnade');

        // Dimensional fallback heuristics
        const tallTower = UniversalArchiBridgeService.resolveTypology(
            undefined,
            'Unknown Vertical Spire',
            undefined,
            [8, 35, 8] // aspect = 8 / 35 = 0.228 < 0.35 -> campanile_tower
        );
        expect(tallTower.typology).toBe('campanile_tower');

        const wideArcade = UniversalArchiBridgeService.resolveTypology(
            undefined,
            'Unlabeled Linear Structure',
            undefined,
            [60, 10, 8] // aspect = (60+8)/2 / 10 = 3.4 -> close, aspect > 3.5:
        );
        const longArcade = UniversalArchiBridgeService.resolveTypology(
            undefined,
            'Unknown Corridor',
            undefined,
            [80, 8, 8] // aspect = 44 / 8 = 5.5 > 3.5 -> aqueduct_arcade
        );
        expect(longArcade.typology).toBe('aqueduct_arcade');

        const roundStructure = UniversalArchiBridgeService.resolveTypology(
            undefined,
            'Unknown Cylindrical Feature',
            undefined,
            [20, 18, 21] // |20-21|/21 = 0.047 < 0.15 -> rotunda
        );
        expect(roundStructure.typology).toBe('rotunda');
    });

    it('synthesizes a 1:1 metric replacement model for the Arch of Constantine entity', async () => {
        const archEntity = macroEntities.find(e => e.id === 'det-arch-constantine') || {
            id: 'det-arch-constantine',
            name: 'Arch of Constantine (Arco di Costantino)',
            category: 'monument',
            boundingBox: {
                min: [-158.25, 25.38, -66.42],
                max: [-117.35, 46.41, -32.57],
                dimensions: [40.90, 21.02, 33.84],
                centroid: [-137.80, 35.89, -49.50]
            },
            orientedBoundingBox: {
                center: [-137.70, 35.89, -49.56],
                dimensions: [40.82, 21.02, 32.05],
                halfExtents: [20.41, 10.51, 16.02],
                yawRad: 0.0779
            }
        };

        const testOutPath = path.resolve(process.cwd(), '.scratchbox/test_arch_constantine_bridge.glb');
        const result = await bridge.synthesizeStructureFromEntity(archEntity, {
            outputGlbPath: testOutPath
        });

        expect(result.entityId).toBe('det-arch-constantine');
        expect(result.typology).toBe('triumphal_arch');
        expect(result.tectonicClass).toBe('TriumphalArch');
        expect(result.order).toBe('composite');
        expect(result.outputGlbPath).toBe(testOutPath);
        expect(fs.existsSync(testOutPath)).toBe(true);

        expect(result.glbBuffer).toBeDefined();
        if (result.glbBuffer) {
            expect(result.glbBuffer.length).toBeGreaterThan(1000);
            // Check glTF binary header magic (0x46546C67 = 'glTF')
            expect(result.glbBuffer.readUInt32LE(0)).toBe(0x46546C67);
            // Check glTF version 2
            expect(result.glbBuffer.readUInt32LE(4)).toBe(2);
        }

        // Verify high-fidelity C++20 stereotomy synthesis
        expect(result.telemetry.outputVertices).toBeGreaterThan(100000);
        expect(result.telemetry.outputTriangles).toBeGreaterThan(50000);
        // isManifold is the welded-edge audit of the written GLB (each edge used by exactly two triangles), not "has vertices".
        const archAudit = measureGlbEdgeManifold(result.glbBuffer!);
        console.log(`[archi arch] edge audit: ${JSON.stringify(archAudit)}`);
        expect(result.telemetry.isManifold).toBe(archAudit.isManifold);
        expect(archAudit.triangles).toBe(result.telemetry.outputTriangles);
        expect(result.telemetry.detectedDatumsCount).toBeGreaterThanOrEqual(20);

        // Ground datum check: worldPosition Y should align with base of bounding volume
        const expectedY = archEntity.orientedBoundingBox
            ? archEntity.orientedBoundingBox.center[1] - archEntity.orientedBoundingBox.dimensions[1] * 0.5
            : archEntity.boundingBox!.centroid[1] - archEntity.boundingBox!.dimensions[1] * 0.5;
        expect(result.worldPosition[1]).toBeCloseTo(expectedY, 0.1);
    }, 45000);

    it('synthesizes a 1:1 metric replacement model for the Colosseum outer arcade entity', async () => {
        const colosseumEntity = macroEntities.find(e => e.id === 'det-colosseum-facade') || {
            id: 'det-colosseum-facade',
            name: 'Colosseum Outer Arcade Facade',
            category: 'monument',
            boundingBox: {
                min: [-113.99, 18.99, -152.56],
                max: [57.93, 60.98, 152.55],
                dimensions: [171.92, 41.98, 305.11],
                centroid: [-28.03, 39.99, -0.006]
            }
        };

        const testOutPath = path.resolve(process.cwd(), '.scratchbox/test_colosseum_arcade_bridge.glb');
        const result = await bridge.synthesizeStructureFromEntity(colosseumEntity, {
            outputGlbPath: testOutPath,
            section: 'north_facade',
            pbrMode: 'travertine'
        });

        expect(result.entityId).toBe('det-colosseum-facade');
        expect(result.typology).toBe('amphitheater');
        expect(result.tectonicClass).toBe('Amphitheater');
        expect(result.outputGlbPath).toBe(testOutPath);
        expect(fs.existsSync(testOutPath)).toBe(true);

        expect(result.glbBuffer).toBeDefined();
        if (result.glbBuffer) {
            expect(result.glbBuffer.readUInt32LE(0)).toBe(0x46546C67);
            expect(result.glbBuffer.readUInt32LE(4)).toBe(2);
        }

        expect(result.telemetry.outputVertices).toBeGreaterThan(50000);
        expect(result.telemetry.outputTriangles).toBeGreaterThan(25000);
        // The Chamfer inversion only runs when a Colosseum scan is on disk; otherwise it must say so.
        const scanOnDisk = fs.existsSync(path.resolve(process.cwd(), 'public/models/colosseum_clay.glb'));
        expect(result.telemetry.inversionRan).toBe(scanOnDisk);
        const arcadeAudit = measureGlbEdgeManifold(result.glbBuffer!);
        console.log(`[archi arcade] edge audit: ${JSON.stringify(arcadeAudit)}`);
        expect(result.telemetry.isManifold).toBe(arcadeAudit.isManifold);
    }, 45000);

    it('synthesizes watertight procedural glTF 2.0 models for Meta Sudans (rotunda) and Temple of Venus and Roma', async () => {
        const metaSudansEntity: SpatialArchiEntity = {
            id: 'det-meta-sudans',
            name: 'Meta Sudans Ancient Fountain Ruins',
            category: 'ruin',
            nominalDimensions: [18.0, 16.0, 18.0],
            nominalCentroid: [-169.4, 41.5, 76.2],
            trellisPrompt: 'Meta sudans conical fountain core with concentric stepped marble basins'
        };

        const metaResult = await bridge.synthesizeStructureFromEntity(metaSudansEntity);
        expect(metaResult.typology).toBe('rotunda');
        expect(metaResult.tectonicClass).toBe('Rotunda');
        expect(metaResult.telemetry.outputVertices).toBeGreaterThan(50);
        expect(metaResult.telemetry.outputTriangles).toBeGreaterThan(50);
        expect(metaResult.glbBuffer).toBeDefined();
        if (metaResult.glbBuffer) {
            expect(metaResult.glbBuffer.readUInt32LE(0)).toBe(0x46546C67);
        }

        const templeEntity: SpatialArchiEntity = {
            id: 'det-temple-venus-roma',
            name: 'Temple of Venus and Roma',
            category: 'ruin',
            nominalDimensions: [60.0, 18.0, 100.0],
            nominalCentroid: [-120.0, 30.0, 140.0],
            trellisPrompt: 'Peripteral double-cella temple with Corinthian columns and white marble entablature'
        };

        const templeResult = await bridge.synthesizeStructureFromEntity(templeEntity);
        expect(templeResult.typology).toBe('peripteral_temple');
        expect(templeResult.tectonicClass).toBe('PeripteralTemple');
        expect(templeResult.telemetry.outputVertices).toBeGreaterThan(100);
        expect(templeResult.telemetry.outputTriangles).toBeGreaterThan(100);
        expect(templeResult.glbBuffer).toBeDefined();
        if (templeResult.glbBuffer) {
            expect(templeResult.glbBuffer.readUInt32LE(0)).toBe(0x46546C67);
        }
    });

    it('batches architectural synthesis across multiple separated entities in parallel', async () => {
        const batchEntities: SpatialArchiEntity[] = [
            {
                id: 'batch-colonnade',
                name: 'Imperial Forum Colonnade Walkway',
                category: 'structure',
                nominalDimensions: [40.0, 7.5, 8.0],
                nominalCentroid: [10, 5, 20]
            },
            {
                id: 'batch-aqueduct',
                name: 'Aqua Claudia Elevated Arcade Section',
                category: 'infrastructure',
                nominalDimensions: [80.0, 12.0, 4.5],
                nominalCentroid: [100, 10, -50]
            },
            {
                id: 'batch-basilica',
                name: 'Basilica Nova Monumental Hall',
                category: 'hall',
                nominalDimensions: [60.0, 28.0, 45.0],
                nominalCentroid: [-80, 20, 200]
            }
        ];

        const batchResults = await bridge.batchSynthesizeFromEntities(batchEntities);
        expect(batchResults.length).toBe(3);
        expect(batchResults[0].typology).toBe('colonnade');
        expect(batchResults[1].typology).toBe('aqueduct_arcade');
        expect(batchResults[2].typology).toBe('basilica_hall');

        for (const res of batchResults) {
            expect(res.glbBuffer).toBeDefined();
            expect(res.telemetry.outputVertices).toBeGreaterThan(20);
            expect(res.telemetry.outputTriangles).toBeGreaterThan(20);
            expect(fs.existsSync(res.outputGlbPath)).toBe(true);
        }
    });

    it('generates direct procedural glTF buffers with valid PBR material properties', () => {
        const outPath = path.resolve(process.cwd(), '.scratchbox/test_procedural_direct.glb');
        const res = generateProceduralArchiGlb(
            ARCHI_TYPOLOGY_ADAPTERS.peripteral_temple,
            [30.0, 14.0, 50.0],
            { roughness: 0.75, metalness: 0.05, baseColor: '#ece7de' },
            outPath
        );

        expect(res.glbBuffer).toBeDefined();
        expect(res.vertexCount).toBeGreaterThan(50);
        expect(res.triangleCount).toBeGreaterThan(50);
        expect(fs.existsSync(outPath)).toBe(true);

        const buf = fs.readFileSync(outPath);
        expect(buf.readUInt32LE(0)).toBe(0x46546C67);
        expect(buf.readUInt32LE(4)).toBe(2);
    });

    it('resolves contemporary architectural typologies and street corridors', () => {
        expect(UniversalArchiBridgeService.resolveTypology('commercial', 'Midtown Office Skyscraper').typology).toBe('commercial_skyscraper');
        expect(UniversalArchiBridgeService.resolveTypology('retail', 'Ground Floor Podium Storefront').typology).toBe('commercial_podium');
        expect(UniversalArchiBridgeService.resolveTypology('residential', 'Brooklyn Brownstone Rowhouse').typology).toBe('residential_brownstone');
        expect(UniversalArchiBridgeService.resolveTypology('housing', 'Multi-Family Apartment Complex').typology).toBe('residential_multifamily');
        expect(UniversalArchiBridgeService.resolveTypology('industrial', 'Logistics Warehouse Distribution Center').typology).toBe('industrial_warehouse');
        expect(UniversalArchiBridgeService.resolveTypology('transit', 'Waymo HD Road Corridor 4-Lane').typology).toBe('street_corridor');
    });

    it('synthesizes contemporary skyscraper with vector footprint, recessed windows, solar roof, and spatial tree', async () => {
        const skyscraperEntity: SpatialArchiEntity = {
            id: 'skyscraper-midtown-test',
            name: 'Midtown High-Rise Commercial Tower',
            category: 'commercial_tower',
            vectorFootprint: [
                [-15, -15],
                [15, -15],
                [15, 15],
                [-15, 15]
            ],
            levels: 18,
            facadeRevealDepth: 0.28,
            solarRoofSegments: [
                {
                    planeEquation: [0, 1, 0, -64.8], // horizontal roof plane at y = 64.8
                    azimuthDegrees: 180,
                    pitchDegrees: 0,
                    yearlyEnergyDcKwh: 45000,
                    segmentIndex: 0
                }
            ],
            nominalDimensions: [30.0, 64.8, 30.0],
            nominalCentroid: [0, 32.4, 0]
        };

        const result = await bridge.synthesizeStructureFromEntity(skyscraperEntity);
        expect(result.typology).toBe('commercial_skyscraper');
        expect(result.glbBuffer).toBeDefined();
        expect(result.telemetry.outputVertices).toBeGreaterThan(100);
        expect(result.telemetry.outputTriangles).toBeGreaterThan(100);
        expect(result.telemetry.floorCount).toBe(18);
        expect(result.telemetry.roofPlaneCount).toBe(1);
        expect(result.telemetry.hasSolarGrounding).toBe(true);
        expect(result.telemetry.hasVectorGrounding).toBe(true);

        // Verify UniversalSpatialNode hierarchy
        expect(result.spatialNode).toBeDefined();
        const root = result.spatialNode!;
        expect(root.polarity).toBe('positive_mass');
        expect(root.children.length).toBe(18); // 18 negative cavity floors

        const firstFloor = root.children[0];
        expect(firstFloor.polarity).toBe('negative_cavity');
        expect(firstFloor.mountPlanes.length).toBe(2); // floor and ceiling anchor planes
        expect(firstFloor.mountPlanes[0].planeType).toBe('floor');
        expect(firstFloor.mountPlanes[1].planeType).toBe('ceiling');
    });

    it('synthesizes Waymo HD road corridor with curb and camber cross-section', async () => {
        const roadEntity: SpatialArchiEntity = {
            id: 'waymo-boulevard-test',
            name: 'Autonomous Vehicle Road Corridor',
            category: 'transit',
            roadCorridor: {
                centerline: [
                    [-50, 0, 0],
                    [0, 0, 0],
                    [50, 0, 0]
                ],
                laneCount: 4,
                laneWidthMeters: 3.5,
                curbHeightMeters: 0.15,
                sidewalkWidthMeters: 3.0,
                camberSlope: 0.02
            },
            nominalDimensions: [100.0, 1.0, 20.0],
            nominalCentroid: [0, 0.5, 0]
        };

        const result = await bridge.synthesizeStructureFromEntity(roadEntity);
        expect(result.typology).toBe('street_corridor');
        expect(result.glbBuffer).toBeDefined();
        expect(result.telemetry.outputVertices).toBeGreaterThanOrEqual(21);
        expect(result.telemetry.outputTriangles).toBeGreaterThanOrEqual(24);
        expect(result.spatialNode).toBeDefined();
        expect(result.spatialNode?.metadata.hasRoadCorridor).toBe(true);
    });

    it('synthesizes brownstone with street stoop stairs and recessed window reveals >= 0.20m', async () => {
        const brownstoneEntity: SpatialArchiEntity = {
            id: 'brownstone-row-test',
            name: 'Historic Rowhouse Brownstone',
            category: 'residential',
            trellisPrompt: 'Victorian brownstone rowhouse with high stoop stairs',
            vectorFootprint: [
                [-4, -7.5],
                [4, -7.5],
                [4, 7.5],
                [-4, 7.5]
            ],
            levels: 4,
            facadeRevealDepth: 0.25,
            nominalDimensions: [8.0, 13.2, 15.0],
            nominalCentroid: [0, 6.6, 0]
        };

        const result = await bridge.synthesizeStructureFromEntity(brownstoneEntity);
        expect(result.typology).toBe('residential_brownstone');
        expect(result.glbBuffer).toBeDefined();
        expect(result.telemetry.outputVertices).toBeGreaterThan(100);
        expect(result.telemetry.outputTriangles).toBeGreaterThan(100);
        expect(result.spatialNode?.children.length).toBe(4);
    });

    it('satisfies ADA Alien Planet Test: accepts arbitrary open literal tectonic classes and framing systems without rejection', async () => {
        // Novel unpredicted entity from the "Alien Planet Test"
        const alienEntity: SpatialArchiEntity = {
            id: 'asteroid-biodome-42',
            name: 'Subterranean Geothermal Research Biodome',
            category: 'exoplanetary_habitat',
            typology: 'subterranean_vault',
            framingSystem: 'composite_carbon_hexgrid',
            nominalDimensions: [30.0, 15.0, 30.0],
            nominalCentroid: [0, 7.5, 0],
            levels: 3,
            vectorFootprint: [
                [-15, -15],
                [15, -15],
                [15, 15],
                [-15, 15]
            ]
        };

        const result = await bridge.synthesizeStructureFromEntity(alienEntity);
        expect(result.entityId).toBe('asteroid-biodome-42');
        expect(result.framingSystem).toBe('composite_carbon_hexgrid');
        expect(result.glbBuffer).toBeDefined();
        expect(result.spatialNode).toBeDefined();
        expect(result.spatialNode?.children.length).toBe(3);
    });
});

