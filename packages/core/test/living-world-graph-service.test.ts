import { describe, it, expect } from 'vitest';
import { LivingWorldGraphService } from '../src/node/spatial/LivingWorldGraphService';

describe('LivingWorldGraphService', () => {
  it('should create a district with continuous bedrock elevation oracle and WGS-84 anchor', () => {
    const service = new LivingWorldGraphService();
    const district = service.createDistrict({
      id: 'district_arctic_ridge',
      name: 'Arctic Massif Research District',
      wgs84Anchor: {
        latitude: 78.2232,
        longitude: 15.6267,
        elevationMeters: 450.0
      },
      metricExtentMeters: 250.0,
      dominantDomain: 'MountainAlpineCanyon',
      terrainParams: {
        peakHeight: 65.0,
        valleyFloorElevation: 0.0
      }
    });

    expect(district.id).toBe('district_arctic_ridge');
    expect(district.wgs84Anchor.latitude).toBe(78.2232);
    expect(district.dominantDomain).toBe('MountainAlpineCanyon');
    expect(district.terrain.oracleParams.peakHeight).toBe(65.0);
    expect(district.metricAABB.extents[0]).toBe(250.0);
  });

  it('should evaluate continuous elevation H(x, z) and analytical surface normal', () => {
    const service = new LivingWorldGraphService();
    service.createDistrict({
      id: 'district_alpine',
      name: 'Alpine Valley',
      wgs84Anchor: { latitude: 45.0, longitude: 6.8, elevationMeters: 1200.0 }
    });

    const hPeak = service.evaluateTerrainHeight('district_alpine', 0, -60);
    const hValley = service.evaluateTerrainHeight('district_alpine', 0, 20);

    // Peak height should be significantly higher than valley floor
    expect(hPeak).toBeGreaterThan(hValley);
    expect(hPeak).toBeGreaterThan(30.0);

    const normal = service.evaluateTerrainNormal('district_alpine', 10, 10);
    expect(normal).toHaveLength(3);
    const length = Math.sqrt(normal[0] ** 2 + normal[1] ** 2 + normal[2] ** 2);
    expect(length).toBeCloseTo(1.0, 3);
    expect(normal[1]).toBeGreaterThan(0); // Up vector is positive
  });

  it('should probe ground across rotated OBB footprint and clamp foundation plinth', () => {
    const service = new LivingWorldGraphService();
    service.createDistrict({
      id: 'district_outpost',
      name: 'Research Outpost',
      wgs84Anchor: { latitude: 70.0, longitude: 25.0, elevationMeters: 100.0 }
    });

    const probe = service.probeGroundOBB('district_outpost', [0, 0, 0], 12.0, 8.0, 25.0);
    expect(probe.sampleCount).toBe(9);
    expect(probe.minGroundY).toBeLessThanOrEqual(probe.maxGroundY);

    // Register an architectural structure
    const structure = service.registerStructure('district_outpost', {
      id: 'bldg_command_module',
      name: 'Command Module',
      center: [0, 0, 0],
      dimensions: [24.0, 10.0, 16.0],
      yawDegrees: 25.0,
      recessDepthMeters: 0.35,
      addRooftopMechanicals: true
    });

    expect(structure.id).toBe('bldg_command_module');
    expect(structure.orientedBoundingBox.yawDegrees).toBe(25.0);
    // Plinth skirt bottom must be sunk below the lowest sampled ground point to prevent levitation
    expect(structure.foundationPlinth.skirtBottomElevationY).toBeLessThan(probe.minGroundY);
    expect(structure.foundationPlinth.embedDepthMeters).toBeGreaterThan(3.5);

    // Check fenestration bays
    expect(structure.facades).toHaveLength(4);
    for (const facade of structure.facades) {
      expect(facade.fenestrationBays.length).toBeGreaterThan(0);
      expect(facade.fenestrationBays[0].recessDepthMeters).toBe(0.35);
      expect(facade.fenestrationBays[0].drainageSillTiltDeg).toBe(12.0);
    }

    // Check rooftop units
    expect(structure.roof.mechanicalUnits.length).toBeGreaterThanOrEqual(3);
    const types = structure.roof.mechanicalUnits.map(u => u.type);
    expect(types).toContain('hvac_condenser');
    expect(types).toContain('communications_spire');

    // Check relational edges
    const district = service.getDistrict('district_outpost');
    const groundedEdge = district.edges.find(e => e.sourceId === structure.id && e.type === 'GROUNDED_ON');
    expect(groundedEdge).toBeDefined();
    expect(groundedEdge?.targetId).toBe(district.terrain.id);
  });

  it('should enforce compound exclusion and root collar ground sinking for vegetation stands', () => {
    const service = new LivingWorldGraphService();
    service.createDistrict({
      id: 'district_eco',
      name: 'Ecological Valley',
      wgs84Anchor: { latitude: 60.0, longitude: 10.0, elevationMeters: 200.0 }
    });

    // Place structure at origin
    service.registerStructure('district_eco', {
      id: 'bldg_lab',
      name: 'Research Lab',
      center: [0, 0, 0],
      dimensions: [20.0, 8.0, 20.0]
    });

    // Try placing trees: one inside building, one outside in valley
    const stands = service.registerVegetationStands('district_eco', [
      { id: 'tree_inside', position: [0, 0], canopyTier: 0 }, // Inside building footprint -> should be rejected!
      { id: 'tree_outside', position: [35, 35], canopyTier: 0 }, // Outside -> should be accepted
      { id: 'shrub_outside', position: [36, 38], canopyTier: 2 } // Groundcover -> should be accepted
    ]);

    expect(stands.map(s => s.id)).not.toContain('tree_inside');
    expect(stands.map(s => s.id)).toContain('tree_outside');
    expect(stands.map(s => s.id)).toContain('shrub_outside');

    const tree = stands.find(s => s.id === 'tree_outside')!;
    const groundY = service.evaluateTerrainHeight('district_eco', 35, 35);
    // Trunk root collar must be embedded below ground level to eliminate levitation
    expect(tree.position[1]).toBeCloseTo(groundY - tree.rootCollarEmbedDepthMeters, 3);
  });
});
