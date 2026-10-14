/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import {
    VectorWorldPopulatorService,
    VectorFeatureGraph
} from '../src/node/spatial/VectorWorldPopulatorService';
import { GoogleVectorTileService, DecodedVectorTileData } from '../src/node/spatial/GoogleVectorTileService';

describe('VectorWorldPopulatorService (3D Vector World Population Staging)', () => {
    const mockDecodedData: DecodedVectorTileData = {
        buildings: [
            {
                id: 'bld-empire',
                ring: [
                    [-73.9857, 40.7484],
                    [-73.9850, 40.7484],
                    [-73.9850, 40.7489],
                    [-73.9857, 40.7489],
                    [-73.9857, 40.7484]
                ],
                properties: {
                    height: '120.0',
                    'building:levels': '35',
                    name: 'Empire Tower'
                }
            },
            {
                id: 'bld-residential',
                ring: [
                    [-73.9865, 40.7480],
                    [-73.9860, 40.7480],
                    [-73.9860, 40.7483],
                    [-73.9865, 40.7483],
                    [-73.9865, 40.7480]
                ],
                properties: {
                    type: 'apartments'
                }
            }
        ],
        roads: [
            {
                id: 'road-5th-ave',
                points: [
                    [-73.9860, 40.7470],
                    [-73.9855, 40.7490],
                    [-73.9850, 40.7510]
                ],
                properties: {
                    name: '5th Avenue',
                    class: 'primary',
                    lanes: '4'
                }
            },
            {
                id: 'road-34th-st',
                points: [
                    [-73.9880, 40.7485],
                    [-73.9840, 40.7485]
                ],
                properties: {
                    name: 'W 34th Street',
                    class: 'secondary',
                    lanes: '2'
                }
            }
        ],
        landuse: [
            {
                id: 'park-greeley',
                ring: [
                    [-73.9875, 40.7490],
                    [-73.9868, 40.7490],
                    [-73.9868, 40.7495],
                    [-73.9875, 40.7495],
                    [-73.9875, 40.7490]
                ],
                properties: {
                    class: 'park'
                }
            }
        ],
        water: [
            {
                id: 'water-basin',
                ring: [
                    [-73.9890, 40.7470],
                    [-73.9880, 40.7470],
                    [-73.9880, 40.7475],
                    [-73.9890, 40.7475],
                    [-73.9890, 40.7470]
                ]
            }
        ]
    };

    it('extracts topologically coherent VectorFeatureGraph with SI metric units', () => {
        const graph = VectorWorldPopulatorService.extractFeatureGraph(40.7484, -73.9857, mockDecodedData);

        expect(graph.anchorLat).toBe(40.7484);
        expect(graph.anchorLng).toBe(-73.9857);

        // Roads
        expect(graph.roads.length).toBe(2);
        const fifthAve = graph.roads.find(r => r.name === '5th Avenue')!;
        expect(fifthAve).toBeDefined();
        expect(fifthAve.laneCount).toBe(4);
        expect(fifthAve.widthMeters).toBeGreaterThanOrEqual(14.0);
        expect(fifthAve.totalLengthMeters).toBeGreaterThan(400); // 400+ meters in local ENU

        // Buildings
        expect(graph.buildings.length).toBe(2);
        const empire = graph.buildings.find(b => b.id === 'bld-empire')!;
        expect(empire).toBeDefined();
        expect(empire.heightMeters).toBe(120.0);
        expect(empire.levels).toBe(35);
        expect(empire.centroid.x).toBeCloseTo(29.5, 0);

        // Landuse
        expect(graph.landuse.length).toBe(1);
        expect(graph.landuse[0].type).toBe('park');

        // Water
        expect(graph.water.length).toBe(1);
    });

    it('solves semantic staging for hero assets snapped to road lanes and sidewalks', () => {
        const graph = VectorWorldPopulatorService.extractFeatureGraph(40.7484, -73.9857, mockDecodedData);

        // 1. Snap to road lane
        const lanePlacement = VectorWorldPopulatorService.solveHeroStaging(graph, {
            type: 'lane',
            roadName: '5th Avenue',
            laneIndex: 1,
            distanceAlongM: 100.0
        });

        expect(lanePlacement).toBeDefined();
        expect(lanePlacement!.targetSurface).toBe('road');
        expect(lanePlacement!.surfaceY).toBe(0.02);
        expect(lanePlacement!.roadName).toBe('5th Avenue');
        expect(lanePlacement!.laneIndex).toBe(1);
        // Heading should be non-zero and forward vector normalized
        expect(lanePlacement!.forwardVec[0] ** 2 + lanePlacement!.forwardVec[2] ** 2).toBeCloseTo(1.0, 3);
        expect(typeof lanePlacement!.headingDeg).toBe('number');

        // 2. Snap to sidewalk
        const sidewalkPlacement = VectorWorldPopulatorService.solveHeroStaging(graph, {
            type: 'sidewalk',
            roadName: '5th Avenue',
            side: 'right',
            distanceAlongM: 50.0
        });

        expect(sidewalkPlacement).toBeDefined();
        expect(sidewalkPlacement!.targetSurface).toBe('sidewalk');
        expect(sidewalkPlacement!.surfaceY).toBe(0.17); // 17cm curb/sidewalk height
        expect(sidewalkPlacement!.position[1]).toBe(0.17);

        // 3. Snap to park plaza
        const plazaPlacement = VectorWorldPopulatorService.solveHeroStaging(graph, {
            type: 'plaza',
            landuseIndex: 0
        });

        expect(plazaPlacement).toBeDefined();
        expect(plazaPlacement!.targetSurface).toBe('plaza');
        expect(plazaPlacement!.position[1]).toBe(0.05);
    });

    it('synthesizes a fully populated 3D world with 5-tier cross sections, streetlamps, trees, and traffic', async () => {
        // Mock GoogleVectorTileService.fetchVectorTile to return mockDecodedData
        const fetchSpy = vi.spyOn(GoogleVectorTileService, 'fetchVectorTile').mockResolvedValue(mockDecodedData);

        const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sbx-vector-world-'));
        const outGlb = path.join(outDir, 'test_vector_populated_world.glb');

        const result = await VectorWorldPopulatorService.generatePopulatedWorld({
            latitude: 40.7484,
            longitude: -73.9857,
            zoom: 16,
            radiusTiles: 0, // 1 tile for speedy test
            outputGlbPath: outGlb,
            includeTraffic: true,
            trafficDensity: 1.0, // High density to ensure vehicle instances spawn
            includeStreetlamps: true,
            streetlampPitchMeters: 15.0,
            includeSidewalks: true,
            includeCurbs: true,
            includeLaneMarkings: true,
            buildingArticulation: true,
            heroStaging: {
                type: 'lane',
                roadName: '5th Avenue',
                laneIndex: 2,
                distanceAlongM: 80.0
            }
        });

        fetchSpy.mockRestore();

        expect(result.success).toBe(true);
        expect(result.stats.buildingCount).toBe(2);
        expect(result.stats.roadSegmentCount).toBeGreaterThan(0);
        expect(result.stats.streetlampCount).toBeGreaterThan(0);
        // no invented trees: the populator places none (a location's trees are measured from its photo tiles)
        expect((result.stats as any).treeCount).toBeUndefined();
        expect(result.stats.trafficVehicleCount).toBeGreaterThan(0);
        expect(result.stats.vertexCount).toBeGreaterThan(500);
        expect(result.stats.triangleCount).toBeGreaterThan(200);

        // Check hero placement
        expect(result.heroPlacement).toBeDefined();
        expect(result.heroPlacement!.targetSurface).toBe('road');
        expect(result.heroPlacement!.laneIndex).toBe(2);

        // Verify standard glTF 2.0 binary output
        expect(await fs.pathExists(outGlb)).toBe(true);
        const glbBuffer = await fs.readFile(outGlb);
        expect(glbBuffer.length).toBeGreaterThan(1000);
        const magic = glbBuffer.toString('utf8', 0, 4);
        expect(magic).toBe('glTF');

        // Cleanup test artifact
        await fs.remove(outDir);
    });
});
