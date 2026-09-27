/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import { LatLngAlt, Vec3 } from '../src/common/coordinate/LocalTangentPlane';
import {
  Entity4D,
  GeospatialSemanticClass,
  OccupancyGrid4D
} from '../src/common/geospatial-4d-protocol';
import { S4DWorldModelBridge, OccSoraBridge, S4DTrajectoryPrompt } from '../src/node/spatial/S4DWorldModelBridge';
import { Synthetic4DDataGenerator } from '../src/node/spatial/Synthetic4DDataGenerator';
import { TemporalSimulationSolver } from '../src/node/spatial/TemporalSimulationSolver';

describe('S4DWorldModelBridge & Scratchbox-4D (S4D) World Model Architecture', () => {
  // San Francisco Financial District
  const originSF: LatLngAlt = {
    lat: 37.7937,
    lng: -122.3965,
    alt: 10.0
  };

  it('should maintain backward-compatible alias OccSoraBridge === S4DWorldModelBridge', () => {
    expect(OccSoraBridge).toBe(S4DWorldModelBridge);
  });

  it('should serialize Catmull-Rom spline telemetry into 6-DOF S4D trajectory prompts', () => {
    const baseEntity: Entity4D = {
      id: 'drone_surveyor_01',
      name: 'Autonomous Lidar Drone',
      space: {
        geoAnchor: originSF,
        localTransform: {
          position: [0, 0, 0],
          scale: [1, 1, 1]
        }
      },
      time: {
        startMs: 0,
        durationMs: 4000,
        isContinuous: false
      },
      environment: {
        weather: {
          conditions: 'sunny'
        }
      },
      content: { type: 'mesh-glb', durableUri: 'drone.glb' },
      behavior: {},
      lineage: { worldBranchId: 'earth/main', version: 1 }
    };

    // 4 control points forming an aerial arc over Market Street
    const splinePoints: Vec3[] = [
      [0, 0, 20],
      [50, 25, 35],
      [100, 80, 50],
      [150, 120, 25]
    ];

    const simulatedEntity = TemporalSimulationSolver.simulateSplineTrack(
      baseEntity,
      originSF,
      splinePoints,
      250 // 250ms steps -> 16 steps over 4s
    );

    expect(simulatedEntity.behavior.telemetryStream).toBeDefined();
    expect(simulatedEntity.behavior.telemetryStream!.length).toBeGreaterThanOrEqual(16);

    const prompt = S4DWorldModelBridge.serializeTrajectoryPrompt(simulatedEntity, originSF);

    expect(prompt.entityId).toBe('drone_surveyor_01');
    expect(prompt.waypoints.length).toBe(simulatedEntity.behavior.telemetryStream!.length);
    expect(prompt.waypoints[0].z).toBeCloseTo(25.0, 0);

    // Verify 6-DOF kinematics attributes
    const wpMid = prompt.waypoints[8];
    expect(wpMid.speedKmh).toBeGreaterThan(0);
    expect(wpMid.yawDeg).toBeDefined();
    expect(wpMid.pitchDeg).toBeDefined();

    // Verify continuity check
    const validation = S4DWorldModelBridge.validateTrajectoryContinuity(prompt);
    expect(validation.valid).toBe(true);
    expect(validation.totalDistanceMeters).toBeGreaterThan(50);
    expect(validation.warnings.length).toBe(0);
  });

  it('should synthesize paired 4D occupancy training data with terrain, buildings, and dynamic agents', () => {
    const splinePoints: Vec3[] = [
      [-40, -40, 15],
      [-10, 0, 20],
      [20, 20, 25],
      [50, 50, 30]
    ];

    const datasetItem = Synthetic4DDataGenerator.generateSequence({
      origin: originSF,
      splinePoints,
      dimensions: [8, 32, 32, 16], // compact test grid
      voxelSizeMeters: [4.0, 4.0, 4.0],
      terrainBaseElevation: 0.0,
      buildings: [
        {
          centerENU: [10, 10],
          width: 20,
          depth: 20,
          height: 35
        }
      ],
      agentType: 'air',
      timeStepMs: 500
    });

    expect(datasetItem.id).toMatch(/^s4d_item_/);
    expect(datasetItem.occupancyGrid.metadata.dimensions).toEqual([8, 32, 32, 16]);
    expect(datasetItem.occupancyGrid.sparseRleBytes).toBeDefined();

    // Verify semantic class presence
    const hist = datasetItem.classHistogram;
    expect(hist[GeospatialSemanticClass.TERRAIN]).toBeGreaterThan(0);
    expect(hist[GeospatialSemanticClass.BUILDING_FACADE]).toBeGreaterThan(0);
    expect(hist[GeospatialSemanticClass.DYNAMIC_AIR_AGENT]).toBeGreaterThan(0);
    expect(hist[GeospatialSemanticClass.AIRSPACE]).toBeGreaterThan(0);
  });

  it('should perform 100% lossless RLE compression and decompression on voxel arrays', () => {
    const totalVoxels = 8 * 32 * 32 * 16;
    const testVoxels = new Uint8Array(totalVoxels);

    // Create chunks of empty space, terrain, and building voxels
    testVoxels.fill(GeospatialSemanticClass.AIRSPACE, 0, 5000);
    testVoxels.fill(GeospatialSemanticClass.TERRAIN, 5000, 10000);
    testVoxels.fill(GeospatialSemanticClass.BUILDING_FACADE, 10000, 15000);
    testVoxels.fill(GeospatialSemanticClass.DYNAMIC_AIR_AGENT, 15000, totalVoxels);

    const rle = S4DWorldModelBridge.rleEncode(testVoxels);
    expect(typeof rle).toBe('string');
    expect(rle.length).toBeLessThan(testVoxels.length); // High compression ratio

    const decoded = S4DWorldModelBridge.rleDecode(rle, totalVoxels);
    expect(decoded.length).toBe(totalVoxels);

    // Verify byte-for-byte exact equality
    let isIdentical = true;
    for (let i = 0; i < totalVoxels; ++i) {
      if (decoded[i] !== testVoxels[i]) {
        isIdentical = false;
        break;
      }
    }
    expect(isIdentical).toBe(true);
  });

  it('should wrap S4D output into a formal Entity4D with occupancy-4d content representation', () => {
    const dummyPrompt: S4DTrajectoryPrompt = {
      entityId: 'drone_alpha',
      originWGS84: originSF,
      timeStepMs: 250,
      totalDurationMs: 4000,
      waypoints: [
        { x: 0, y: 0, z: 10, yawDeg: 0, pitchDeg: 0, rollDeg: 0, speedKmh: 15, timestampMs: 0 },
        { x: 10, y: 10, z: 15, yawDeg: 45, pitchDeg: 5, rollDeg: 2, speedKmh: 20, timestampMs: 250 }
      ],
      bounds: {
        min: [-32, -32, 0],
        max: [32, 32, 40]
      }
    };

    const occupancyGrid: OccupancyGrid4D = {
      metadata: {
        dimensions: [16, 128, 128, 64],
        voxelSizeMeters: [1.0, 1.0, 1.0],
        originENU: [0, 0, 0],
        classes: { 0: 'Airspace', 1: 'Terrain' },
        timeStepMs: 250
      },
      denseTensorUri: 'scratchbox://models/s4d_rollout_01.h5'
    };

    const entity = S4DWorldModelBridge.createOccupancyEntity(
      'simulated_world_chunk_01',
      'SF Financial District 4D Rollout',
      dummyPrompt,
      occupancyGrid
    );

    expect(entity.id).toBe('simulated_world_chunk_01');
    expect(entity.content.type).toBe('occupancy-4d');
    expect(entity.content.occupancy4D).toBeDefined();
    expect(entity.content.occupancy4D!.metadata.dimensions).toEqual([16, 128, 128, 64]);
    expect(entity.space.geoAnchor?.lat).toBe(originSF.lat);
    expect(entity.behavior.telemetryStream!.length).toBe(2);
  });
});
