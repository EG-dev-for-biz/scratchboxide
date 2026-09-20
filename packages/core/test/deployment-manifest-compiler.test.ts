/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import { GeoFrame } from '../src/common/coordinate/GeoFrame';
import { DeploymentManifestCompiler } from '../src/node/spatial/DeploymentManifestCompiler';
import {
  Entity4D,
  Universal4DSceneDocument
} from '../src/common/geospatial-4d-protocol';
import {
  ESB_GOOGLE_GEODETIC_ANCHOR,
  GoogleMidtownVectorMapping,
  GOOGLE_CLOUD_ROADMAP_NO_LABELS_STYLE
} from '../src/browser/generative-canvas/services/google-vector-mapping-service';

describe('DeploymentManifestCompiler (ARCore Geospatial + Splats + Vectors)', () => {
  // Empire State Building Geodetic Anchor
  const esbGeoFrame = new GeoFrame({
    lat: ESB_GOOGLE_GEODETIC_ANCHOR.lat,
    lng: ESB_GOOGLE_GEODETIC_ANCHOR.lng,
    alt: ESB_GOOGLE_GEODETIC_ANCHOR.elevation
  });

  it('1. should compile local Three.js coordinates into 64-bit WGS-84 geodetic coordinates', async () => {
    // Entity located 100 meters East (+X) and 50 meters North (-Z in Three.js)
    const localPosition: [number, number, number] = [
      100 * esbGeoFrame.scaleFactor,
      0,
      -50 * esbGeoFrame.scaleFactor
    ];

    const entity: Entity4D = {
      id: 'entity-sculpture-01',
      name: 'Interactive Kinetic Sculpture',
      space: {
        localTransform: {
          position: localPosition
        }
      },
      time: { startMs: 0, durationMs: 0 },
      environment: {},
      content: {
        type: 'mesh-glb',
        durableUri: 'https://vault.scratchbox.dev/models/kinetic_sculpture.glb'
      },
      behavior: {},
      lineage: { worldBranchId: 'earth/main', version: 1 }
    };

    const contract = await DeploymentManifestCompiler.compile({
      geoFrame: esbGeoFrame,
      scene: [entity],
      weather: false // offline mode
    });

    expect(contract.placements).toHaveLength(1);
    const placement = contract.placements[0];

    expect(placement.entityId).toBe('entity-sculpture-01');
    expect(placement.altitudeResolution.mode).toBe('terrain');
    // Longitude should be East (greater than origin lng)
    expect(placement.targetGeodetic.longitude).toBeGreaterThan(ESB_GOOGLE_GEODETIC_ANCHOR.lng);
    // Latitude should be North (greater than origin lat)
    expect(placement.targetGeodetic.latitude).toBeGreaterThan(ESB_GOOGLE_GEODETIC_ANCHOR.lat);

    // Re-inverting back to scene coordinates must match original local position within 1mm precision
    const reinvertedPos = esbGeoFrame.toScene({
      lat: placement.targetGeodetic.latitude,
      lng: placement.targetGeodetic.longitude,
      alt: 0
    });

    expect(reinvertedPos[0]).toBeCloseTo(localPosition[0], 2);
    expect(reinvertedPos[2]).toBeCloseTo(localPosition[2], 2);
  });

  it('2. should automatically infer rooftop altitude resolution mode for elevated structures', async () => {
    const roofEntity: Entity4D = {
      id: 'entity-rooftop-pavilion',
      name: 'Observation Deck Rooftop Pavilion',
      space: {
        localTransform: {
          position: [0, 380 * esbGeoFrame.scaleFactor, 0]
        }
      },
      time: { startMs: 0, durationMs: 0 },
      environment: {},
      content: {
        type: 'mesh-glb',
        durableUri: 'https://vault.scratchbox.dev/models/roof_pavilion.glb'
      },
      behavior: {},
      lineage: { worldBranchId: 'earth/main', version: 1 }
    };

    const contract = await DeploymentManifestCompiler.compile({
      geoFrame: esbGeoFrame,
      scene: [roofEntity],
      weather: false
    });

    expect(contract.placements[0].altitudeResolution.mode).toBe('rooftop');
  });

  it('3. should calculate NOAA solar ephemeris, Kelvin temperatures, and sun RGB vectors', async () => {
    const noonDate = new Date('2026-06-21T16:00:00Z'); // Summer solstice around solar noon in NY
    const contract = await DeploymentManifestCompiler.compile({
      geoFrame: esbGeoFrame,
      scene: [],
      timestamp: noonDate,
      weather: false
    });

    const sun = contract.environment?.sunVector;
    expect(sun).toBeDefined();
    expect(sun!.elevationDeg).toBeGreaterThan(45.0); // High summer sun
    expect(sun!.colorTemperatureK).toBeGreaterThan(4500); // Warm-daylight white
    expect(sun!.normalizedSunRgb[0]).toBeGreaterThan(0.7); // Bright sunlight
    expect(sun!.directIntensity).toBeGreaterThan(0.7);
  });

  it('4. should correctly package 3D Gaussian Splats (.spz) with mobile budget configuration', async () => {
    const splatEntity: Entity4D = {
      id: 'entity-statue-splat',
      name: 'Photoreal Facade Portal',
      space: {
        localTransform: {
          position: [10, 0, 10]
        }
      },
      time: { startMs: 0, durationMs: 0 },
      environment: {},
      content: {
        type: 'gaussian-splat',
        durableUri: 'https://vault.scratchbox.dev/splats/esb_facade.spz',
        metadata: {
          pointCount: 420000
        }
      },
      behavior: {},
      lineage: { worldBranchId: 'earth/main', version: 1 }
    };

    const contract = await DeploymentManifestCompiler.compile({
      geoFrame: esbGeoFrame,
      scene: [splatEntity],
      weather: false,
      splatConfig: {
        maxSplatBudgetMobile: 500000,
        lodDistanceVoxelizeMeters: 20.0,
        depthOcclusionEnabled: true
      }
    });

    const placement = contract.placements[0];
    expect(placement.asset.assetType).toBe('gaussian-splat');
    expect(placement.asset.durableSplatUri).toBe('https://vault.scratchbox.dev/splats/esb_facade.spz');
    expect(placement.asset.splatFormat).toBe('spz');
    expect(placement.asset.splatCount).toBe(420000);

    expect(contract.splatRenderingConfig).toBeDefined();
    expect(contract.splatRenderingConfig?.maxSplatBudgetMobile).toBe(500000);
    expect(contract.splatRenderingConfig?.depthOcclusionEnabled).toBe(true);
  });

  it('5. should embed Vector Map road corridors and parcel envelopes for ARCore geofencing', async () => {
    const mockVectorMapping: GoogleMidtownVectorMapping = {
      version: '1.0.0',
      source: 'google_maps_platform_reference',
      anchor: ESB_GOOGLE_GEODETIC_ANCHOR,
      styling: GOOGLE_CLOUD_ROADMAP_NO_LABELS_STYLE,
      gridBearingDegrees: 29.0,
      roads: [
        {
          id: 'road-5th-ave',
          name: '5th Avenue',
          type: 'avenue',
          widthMeters: 30.0,
          lanes: 5,
          pointsLocalENU: [[-30, 0], [30, 0]],
          coordinatesWGS84: [[-73.9856, 40.7484], [-73.9858, 40.7486]]
        }
      ],
      parcels: [
        {
          id: 'parcel-esb',
          name: 'Empire State Building Landmark Parcel',
          blockNumber: 835,
          isLandmark: true,
          baseElevation: 15.0,
          heightMeters: 443.2,
          polygonLocalENU: [[-40, -40], [40, -40], [40, 40], [-40, 40]],
          coordinatesWGS84: [[-73.9856, 40.7484], [-73.9850, 40.7484], [-73.9850, 40.7490], [-73.9856, 40.7490]]
        }
      ]
    };

    const contract = await DeploymentManifestCompiler.compile({
      geoFrame: esbGeoFrame,
      scene: [],
      vectorMap: mockVectorMapping,
      weather: false
    });

    expect(contract.vectorMapContext).toBeDefined();
    expect(contract.vectorMapContext?.roadCorridors).toHaveLength(1);
    expect(contract.vectorMapContext?.roadCorridors?.[0].name).toBe('5th Avenue');
    expect(contract.vectorMapContext?.roadCorridors?.[0].widthMeters).toBe(30.0);

    expect(contract.vectorMapContext?.parcels).toHaveLength(1);
    expect(contract.vectorMapContext?.parcels?.[0].isLandmark).toBe(true);
    expect(contract.vectorMapContext?.parcels?.[0].heightMeters).toBe(443.2);
  });

  it('6. should strictly isolate multiverse reality branches', async () => {
    const mainEntity: Entity4D = {
      id: 'entity-main-01',
      name: 'Present Day Transit Beacon',
      space: { localTransform: { position: [0, 0, 0] } },
      time: { startMs: 0, durationMs: 0 },
      environment: {},
      content: { type: 'mesh-glb', durableUri: 'asset://beacon.glb' },
      behavior: {},
      lineage: { worldBranchId: 'earth/main', version: 1 }
    };

    const historyEntity: Entity4D = {
      id: 'entity-hist-01',
      name: 'Waldorf-Astoria 1893 Facade (Pre-ESB)',
      space: { localTransform: { position: [0, 0, 0] } },
      time: { startMs: 0, durationMs: 0 },
      environment: {},
      content: { type: 'mesh-glb', durableUri: 'asset://waldorf.glb' },
      behavior: {},
      lineage: { worldBranchId: 'earth/historical-1893', version: 1 }
    };

    // Compile for earth/main
    const mainContract = await DeploymentManifestCompiler.compile({
      geoFrame: esbGeoFrame,
      scene: [mainEntity, historyEntity],
      targetBranchId: 'earth/main',
      weather: false
    });

    expect(mainContract.placements).toHaveLength(1);
    expect(mainContract.placements[0].entityId).toBe('entity-main-01');

    // Compile for earth/historical-1893
    const histContract = await DeploymentManifestCompiler.compile({
      geoFrame: esbGeoFrame,
      scene: [mainEntity, historyEntity],
      targetBranchId: 'earth/historical-1893',
      weather: false
    });

    expect(histContract.placements).toHaveLength(1);
    expect(histContract.placements[0].entityId).toBe('entity-hist-01');
  });

  it('7. should validate contract schema and detect invalid coordinates', async () => {
    const validContract = await DeploymentManifestCompiler.compile({
      geoFrame: esbGeoFrame,
      scene: [],
      weather: false
    });

    const validation = DeploymentManifestCompiler.validateContract(validContract);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toHaveLength(0);

    // Corrupt latitude
    const corrupted = JSON.parse(JSON.stringify(validContract));
    corrupted.spatialCluster.originGeodetic.latitude = 120.0; // Invalid lat > 90

    const badValidation = DeploymentManifestCompiler.validateContract(corrupted);
    expect(badValidation.valid).toBe(false);
    expect(badValidation.errors.length).toBeGreaterThan(0);
  });
});
