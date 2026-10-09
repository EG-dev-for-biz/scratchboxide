import { describe, it, expect, vi } from 'vitest';
import {
    SpatialVectorDataService,
    UniversalBuildingFeature,
    UniversalRoadFeature,
    SpatialVectorDataSet
} from '../src/node/spatial/SpatialVectorDataService';
import { GoogleVectorTileService } from '../src/node/spatial/GoogleVectorTileService';
import { LocalTangentPlane } from '../src/common/coordinate/LocalTangentPlane';

describe('SpatialVectorDataService & Universal Spatial Intelligence API', () => {
    const lat = 40.7484; // Empire State Building
    const lng = -73.9857;

    it('generates canonical Universal Spatial URNs adhering to schema', () => {
        const id1 = SpatialVectorDataService.generateUniversalSpatialId('building', 'dr5regw3p2', 'empire-state-building');
        expect(id1).toBe('urn:scratchbox:spatial:building:dr5regw3p2:empire-state-building');

        const id2 = SpatialVectorDataService.generateUniversalSpatialId('road', 'dr5regw3p2', '5th-ave-seg-0');
        expect(id2).toBe('urn:scratchbox:spatial:road:dr5regw3p2:5th-ave-seg-0');

        // Handles special characters cleanly
        const id3 = SpatialVectorDataService.generateUniversalSpatialId('poi', 'dr5regw3p2', 'Joe\'s Pizza #1!');
        expect(id3).toBe('urn:scratchbox:spatial:poi:dr5regw3p2:Joe_s_Pizza__1_');
    });

    it('queries vector tiles, projects to sub-millimeter ENU, and enforces reality grounding', async () => {
        // Mock decodeTileBuffer
        const origDecode = GoogleVectorTileService.decodeTileBuffer;
        GoogleVectorTileService.decodeTileBuffer = () => ({
            buildings: [
                {
                    id: 'bldg-esb',
                    type: 'Polygon',
                    ring: [
                        [lng - 0.0004, lat - 0.0004],
                        [lng + 0.0004, lat - 0.0004],
                        [lng + 0.0004, lat + 0.0004],
                        [lng - 0.0004, lat + 0.0004]
                    ],
                    properties: {
                        name: 'Empire State Building',
                        height: '381.0',
                        'building:levels': '102',
                        type: 'commercial'
                    }
                },
                {
                    id: 'bldg-unverified',
                    type: 'Polygon',
                    ring: [
                        [lng + 0.0010, lat + 0.0010],
                        [lng + 0.0015, lat + 0.0010],
                        [lng + 0.0015, lat + 0.0015],
                        [lng + 0.0010, lat + 0.0015]
                    ],
                    properties: {
                        name: 'Unknown Annex'
                        // No height, no levels - heightM must be null!
                    }
                }
            ],
            roads: [
                {
                    id: 'road-5th-ave',
                    type: 'LineString',
                    points: [
                        [lng - 0.001, lat - 0.002],
                        [lng - 0.001, lat + 0.002]
                    ],
                    properties: {
                        name: '5th Avenue',
                        class: 'arterial',
                        lanes: 4,
                        oneway: true,
                        maxspeed: '50'
                    }
                },
                {
                    id: 'road-overpass',
                    type: 'LineString',
                    points: [
                        [lng - 0.002, lat],
                        [lng + 0.002, lat]
                    ],
                    properties: {
                        name: 'Midtown Skyway',
                        class: 'motorway',
                        bridge: 'yes',
                        layer: '2'
                    }
                }
            ],
            landuse: [
                {
                    id: 'landuse-greeley-sq',
                    type: 'Polygon',
                    ring: [
                        [lng - 0.002, lat - 0.001],
                        [lng - 0.001, lat - 0.001],
                        [lng - 0.001, lat - 0.0005],
                        [lng - 0.002, lat - 0.0005]
                    ],
                    properties: {
                        name: 'Greeley Square Park',
                        class: 'park'
                    }
                }
            ],
            water: [
                {
                    id: 'water-pond',
                    type: 'Polygon',
                    ring: [
                        [lng - 0.003, lat - 0.003],
                        [lng - 0.002, lat - 0.003],
                        [lng - 0.002, lat - 0.002],
                        [lng - 0.003, lat - 0.002]
                    ],
                    properties: {
                        name: 'Reflecting Basin',
                        type: 'basin'
                    }
                }
            ],
            pois: [
                {
                    id: 'poi-observation-deck',
                    type: 'Point',
                    point: [lng, lat],
                    properties: {
                        name: 'Empire State Observation Deck',
                        amenity: 'attraction'
                    }
                }
            ]
        });

        // Mock fetchVectorTile so network is bypassed
        const origFetch = GoogleVectorTileService.fetchVectorTile;
        GoogleVectorTileService.fetchVectorTile = async (x, y, z) => {
            return GoogleVectorTileService.decodeTileBuffer(new ArrayBuffer(0), x, y, z);
        };

        try {
            const dataset = await SpatialVectorDataService.querySpatialVectorData({
                latitude: lat,
                longitude: lng,
                radiusMeters: 200
            });

            expect(dataset.geohash).toBeDefined();
            expect(dataset.anchor.latitude).toBe(lat);
            expect(dataset.anchor.longitude).toBe(lng);

            // Verify Reality Grounding Invariant
            expect(dataset.vegetationNotice).toContain('REALITY GROUNDING INVARIANT');
            expect(dataset.vegetationNotice).toContain('Google 3D Photorealistic Tiles');

            // Verify Buildings
            expect(dataset.buildings.length).toBeGreaterThanOrEqual(2);
            const esb = dataset.buildings.find(b => b.name === 'Empire State Building')!;
            expect(esb).toBeDefined();
            expect(esb.universalId).toContain('urn:scratchbox:spatial:building:');
            expect(esb.heightM).toBe(381.0);
            expect(esb.isHeightVerified).toBe(true);
            expect(esb.levels).toBe(102);
            expect(esb.areaM2).toBeGreaterThan(0);

            // Verify Unverified Building does NOT guess height
            const unverified = dataset.buildings.find(b => b.name === 'Unknown Annex')!;
            expect(unverified).toBeDefined();
            expect(unverified.heightM).toBeNull();
            expect(unverified.isHeightVerified).toBe(false);

            // Verify Roads & Kinematics
            expect(dataset.roads.length).toBeGreaterThanOrEqual(2);
            const fifthAve = dataset.roads.find(r => r.name === '5th Avenue')!;
            expect(fifthAve).toBeDefined();
            expect(fifthAve.universalId).toContain('urn:scratchbox:spatial:road:');
            expect(fifthAve.lanes).toBe(4);
            expect(fifthAve.laneCenterlinesEnu.length).toBe(4);
            expect(fifthAve.oneWay).toBe(true);
            expect(fifthAve.speedLimitKmh).toBe(50);
            expect(fifthAve.isBridge).toBe(false);

            const skyway = dataset.roads.find(r => r.name === 'Midtown Skyway')!;
            expect(skyway).toBeDefined();
            expect(skyway.isBridge).toBe(true);
            expect(skyway.layerIndex).toBe(2);

            // Verify Landuse
            const park = dataset.landuse.find(l => l.name === 'Greeley Square Park')!;
            expect(park).toBeDefined();
            expect(park.surfaceFriction).toBe(0.5);
            expect(park.acousticProfile).toBe('absorptive_foliage');

            // Verify Water
            const pond = dataset.water.find(w => w.name === 'Reflecting Basin')!;
            expect(pond).toBeDefined();
            expect(pond.areaM2).toBeGreaterThan(0);

            // Verify POIs
            const poi = dataset.pois.find(p => p.name === 'Empire State Observation Deck')!;
            expect(poi).toBeDefined();
            expect(poi.category).toBe('attraction');

            // Verify Sub-millimeter co-registration with LocalTangentPlane
            const ltp = new LocalTangentPlane({ lat, lng, alt: 0 });
            const directLocal = ltp.toLocal({ lat, lng, alt: 0 });
            expect(Math.abs(directLocal[0])).toBeLessThan(0.001);
            expect(Math.abs(directLocal[1])).toBeLessThan(0.001);
            expect(Math.abs(directLocal[2])).toBeLessThan(0.001);

            // Test Spatial Query: queryBuildingAt
            const insideEsb = SpatialVectorDataService.queryBuildingAt(dataset, [esb.centroidEnu[0], 0, esb.centroidEnu[2]]);
            expect(insideEsb).toBeDefined();
            expect(insideEsb?.name).toBe('Empire State Building');

            const farAway = SpatialVectorDataService.queryBuildingAt(dataset, [5000, 0, 5000]);
            expect(farAway).toBeUndefined();

            // Test Spatial Query: queryNearestRoad
            const nearRoad = SpatialVectorDataService.queryNearestRoad(dataset, [fifthAve.localPathEnu[0][0] + 2.0, 0, fifthAve.localPathEnu[0][2]]);
            expect(nearRoad).toBeDefined();
            expect(nearRoad?.road.name).toBe('5th Avenue');
            expect(nearRoad?.distanceM).toBeCloseTo(2.0, 1);
            expect(nearRoad?.laneIndex).toBeDefined();
            expect(nearRoad?.headingDeg).toBeDefined();

            // Test Excavation Stencil Generation
            const stencil = SpatialVectorDataService.generateExcavationStencil(esb);
            expect(stencil.universalId).toBe(esb.universalId);
            expect(stencil.boundingBox.length).toBe(6);
            expect(stencil.stencilPolygonEnu.length).toBe(esb.localPolygonEnu.length);
            expect(stencil.boundingBox[4]).toBeCloseTo(381.0, 1); // Bounding box maxY matches height accounting for WGS84 curvature

            // Test Kinematic Graph Generation
            const graph = SpatialVectorDataService.generateKinematicGraph(dataset);
            expect(graph.nodes.length).toBeGreaterThan(0);
            expect(graph.roads.length).toBe(dataset.roads.length);

            // Test Semantic 3D Annotations
            const annotations = SpatialVectorDataService.generateSemantic3DAnnotations(dataset);
            expect(annotations.length).toBeGreaterThan(0);
            const esbAnnotation = annotations.find(a => a.universalId === esb.universalId);
            expect(esbAnnotation).toBeDefined();
            expect(esbAnnotation?.title).toBe('Empire State Building');
            expect(esbAnnotation?.position[1]).toBeGreaterThan(381.0); // Billboard hovering above rooftop

            // Test Intelligent Staging Anchors (Kinematic Flow / Vehicles)
            const flowAnchors = SpatialVectorDataService.solveStagingAnchors(dataset, {
                mobilityAffinity: 'flow',
                preferredSurface: 'road_lane',
                maxCandidates: 5
            });
            expect(flowAnchors.length).toBeGreaterThan(0);
            const topFlow = flowAnchors[0];
            expect(topFlow.surfaceType).toBe('road_lane');
            expect(topFlow.roadName).toBe('5th Avenue');
            expect(topFlow.headingDeg).toBeDefined();
            expect(topFlow.confidenceScore).toBeGreaterThan(0.7);
            expect(topFlow.buildingCollisionChecked).toBe(true);

            // Test Intelligent Staging Anchors (Stagnation / Architectural Plazas)
            const plazaAnchors = SpatialVectorDataService.solveStagingAnchors(dataset, {
                mobilityAffinity: 'stagnation',
                preferredSurface: 'plaza',
                maxCandidates: 5
            });
            expect(plazaAnchors.length).toBeGreaterThan(0);
            const topPlaza = plazaAnchors.find(a => a.surfaceType === 'plaza' || a.surfaceType === 'park');
            expect(topPlaza).toBeDefined();
            expect(topPlaza?.clearanceRadiusM).toBeGreaterThanOrEqual(5.0);

            // Test Intelligent Staging Anchors (Perimeter / Sidewalks)
            const sidewalkAnchors = SpatialVectorDataService.solveStagingAnchors(dataset, {
                mobilityAffinity: 'perimeter',
                preferredSurface: 'sidewalk',
                maxCandidates: 5
            });
            expect(sidewalkAnchors.length).toBeGreaterThan(0);
            const topSidewalk = sidewalkAnchors.find(a => a.surfaceType === 'sidewalk');
            expect(topSidewalk).toBeDefined();
            expect(topSidewalk?.position[1]).toBeCloseTo(0.17, 2); // Curb elevation

            // Test Anti-Collision Invariant: None of the anchors intersect building footprints
            for (const anchor of [...flowAnchors, ...plazaAnchors, ...sidewalkAnchors]) {
                const insideBuilding = SpatialVectorDataService.queryBuildingAt(dataset, anchor.position);
                expect(insideBuilding).toBeUndefined();
            }

        } finally {
            GoogleVectorTileService.decodeTileBuffer = origDecode;
            GoogleVectorTileService.fetchVectorTile = origFetch;
        }
    });

    it('adheres to ADA standards: open literals, continuous parameters, and analytical heading math', async () => {
        const origDecode = GoogleVectorTileService.decodeTileBuffer;
        GoogleVectorTileService.decodeTileBuffer = () => ({
            buildings: [],
            roads: [
                {
                    id: 'alien-conduit',
                    type: 'LineString',
                    points: [
                        [lng, lat],
                        [lng + 0.001, lat] // Direct East
                    ],
                    properties: {
                        name: 'Bioluminescent Mag-Conduit',
                        class: 'cryo_hyperloop_conduit', // Novel extraterrestrial road class (Alien Planet Test)
                        width: '14.75', // Continuous physical width in meters
                        lanes: 6,
                        surface: 'superconducting_graphene'
                    }
                }
            ],
            landuse: [
                {
                    id: 'geothermal-basin',
                    type: 'Polygon',
                    ring: [
                        [lng, lat],
                        [lng + 0.001, lat],
                        [lng + 0.001, lat + 0.001],
                        [lng, lat + 0.001]
                    ],
                    properties: {
                        name: 'Methane Geyser Basin',
                        class: 'geothermal_sulfur_flats', // Novel extraterrestrial landuse (Alien Planet Test)
                        surface_friction: '0.94' // Continuous physical friction coefficient
                    }
                }
            ],
            water: []
        });

        const origFetch = GoogleVectorTileService.fetchVectorTile;
        GoogleVectorTileService.fetchVectorTile = async (x, y, z) => {
            return GoogleVectorTileService.decodeTileBuffer(new ArrayBuffer(0), x, y, z);
        };

        try {
            const dataset = await SpatialVectorDataService.querySpatialVectorData({
                latitude: lat,
                longitude: lng,
                radiusMeters: 500
            });

            // Verify continuous physical parameter ingestion
            const road = dataset.roads[0];
            expect(road.widthM).toBe(14.75); // Exact continuous metric width honored
            expect(road.roadClass).toBe('cryo_hyperloop_conduit');

            // Eastward path: dx > 0, dz = 0 -> True heading should be exactly 90 degrees (East)
            expect(road.headingStartDeg).toBeCloseTo(90.0, 1);

            const basin = dataset.landuse[0];
            expect(basin.surfaceFriction).toBe(0.94); // Exact continuous friction honored
            expect(basin.landuseType).toBe('geothermal_sulfur_flats');

            // Solve staging anchor on the novel continuous road
            const anchors = SpatialVectorDataService.solveStagingAnchors(dataset, {
                mobilityAffinity: 'flow',
                preferredSurface: 'road_lane'
            });
            expect(anchors.length).toBeGreaterThan(0);
            expect(anchors[0].headingDeg).toBeCloseTo(90.0, 1);
            expect(anchors[0].forwardVec[0]).toBeGreaterThan(0.99); // Points East (+X)
        } finally {
            GoogleVectorTileService.decodeTileBuffer = origDecode;
            GoogleVectorTileService.fetchVectorTile = origFetch;
        }
    });
});
