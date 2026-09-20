/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { LatLngAlt, LocalTangentPlane, Vec3 } from '../../common/coordinate/LocalTangentPlane';
import {
  Entity4D,
  GeospatialSemanticClass,
  OccupancyGrid4D,
  OccupancyGrid4DMetadata
} from '../../common/geospatial-4d-protocol';
import { TemporalSimulationSolver } from './TemporalSimulationSolver';
import { OccSoraBridge, S4DTrajectoryPrompt } from './OccSoraBridge';

export interface SyntheticBuildingSpec {
  centerENU: [number, number]; // [x, y] in meters
  width: number;               // size in X
  depth: number;               // size in Y
  height: number;              // height in Z
}

export interface Synthetic4DGenerationConfig {
  origin: LatLngAlt;
  splinePoints: Vec3[];
  dimensions?: [number, number, number, number]; // [T, X, Y, Z], default [16, 64, 64, 32] for synthetic batches
  voxelSizeMeters?: [number, number, number];    // default [2.0, 2.0, 2.0]
  buildings?: SyntheticBuildingSpec[];
  terrainBaseElevation?: number;                 // Z level for ground, default 0.0
  agentType?: 'air' | 'ground';
  timeStepMs?: number;                           // default 250ms
}

export interface Synthetic4DDatasetItem {
  id: string;
  prompt: S4DTrajectoryPrompt;
  occupancyGrid: OccupancyGrid4D;
  classHistogram: Record<number, number>;
}

/**
 * Synthetic4DDataGenerator
 * Generates paired (6-DOF Trajectory Prompt, 4D Occupancy Grid) training items for S4D.
 */
export class Synthetic4DDataGenerator {
  /**
   * Synthesizes a paired 4D training sequence with static terrain, buildings, and a dynamic moving agent.
   */
  public static generateSequence(config: Synthetic4DGenerationConfig): Synthetic4DDatasetItem {
    const dimensions = config.dimensions || [16, 64, 64, 32];
    const voxelSize = config.voxelSizeMeters || [2.0, 2.0, 2.0];
    const [T, dimX, dimY, dimZ] = dimensions;
    const [vx, vy, vz] = voxelSize;
    const timeStepMs = config.timeStepMs || 250;
    const terrainBase = config.terrainBaseElevation ?? 0.0;

    // 1. Create base entity and simulate 6-DOF spline track
    const baseEntity: Entity4D = {
      id: `synthetic_agent_${Date.now()}`,
      name: 'Synthetic Drone Flight Track',
      space: {
        geoAnchor: config.origin,
        localTransform: {
          position: [0, 0, 0],
          scale: [1, 1, 1]
        }
      },
      time: {
        startMs: 0,
        durationMs: T * timeStepMs,
        isContinuous: false
      },
      environment: {
        weather: {
          conditions: 'sunny'
        }
      },
      content: { type: 'mesh-glb', durableUri: '' },
      behavior: {},
      lineage: { worldBranchId: 'earth/main', version: 1 }
    };

    const simulatedEntity = TemporalSimulationSolver.simulateSplineTrack(
      baseEntity,
      config.origin,
      config.splinePoints,
      timeStepMs
    );

    const prompt = OccSoraBridge.serializeTrajectoryPrompt(simulatedEntity, config.origin);

    // 2. Allocate 4D voxel grid tensor: [T, X, Y, Z]
    const totalVoxelsPerTimeStep = dimX * dimY * dimZ;
    const totalVoxels = T * totalVoxelsPerTimeStep;
    const grid = new Uint8Array(totalVoxels);
    const classHistogram: Record<number, number> = {};

    // Calculate grid bounding offsets (centered on [0, 0, terrainBase])
    const halfX = (dimX * vx) / 2.0;
    const halfY = (dimY * vy) / 2.0;
    const minZ = terrainBase - 4.0 * vz; // Allow a few subterranean voxels

    const getVoxelIndex = (t: number, x: number, y: number, z: number): number => {
      return t * (dimX * dimY * dimZ) + x * (dimY * dimZ) + y * dimZ + z;
    };

    // 3. Bake static environment (Terrain & Buildings) across all time steps
    const buildings = config.buildings || [];

    for (let x = 0; x < dimX; ++x) {
      const posX = -halfX + (x + 0.5) * vx;
      for (let y = 0; y < dimY; ++y) {
        const posY = -halfY + (y + 0.5) * vy;

        // Check if inside any synthetic building footprint
        let inBuilding = false;
        let buildingMaxZ = terrainBase;

        for (const b of buildings) {
          const dx = Math.abs(posX - b.centerENU[0]);
          const dy = Math.abs(posY - b.centerENU[1]);
          if (dx <= b.width / 2.0 && dy <= b.depth / 2.0) {
            inBuilding = true;
            buildingMaxZ = terrainBase + b.height;
            break;
          }
        }

        for (let z = 0; z < dimZ; ++z) {
          const posZ = minZ + (z + 0.5) * vz;
          let semanticClass = GeospatialSemanticClass.AIRSPACE;

          if (posZ <= terrainBase) {
            semanticClass = GeospatialSemanticClass.TERRAIN;
          } else if (inBuilding && posZ <= buildingMaxZ) {
            // Distinguish facade boundary from interior core
            semanticClass = (posZ >= buildingMaxZ - vz)
              ? GeospatialSemanticClass.BUILDING_FACADE
              : GeospatialSemanticClass.BUILDING_INTERIOR;
          }

          if (semanticClass !== GeospatialSemanticClass.AIRSPACE) {
            for (let t = 0; t < T; ++t) {
              const idx = getVoxelIndex(t, x, y, z);
              grid[idx] = semanticClass;
            }
          }
        }
      }
    }

    // 4. Inject dynamic moving agent at each time step along trajectory
    const agentSemantic = (config.agentType === 'ground')
      ? GeospatialSemanticClass.DYNAMIC_GROUND_AGENT
      : GeospatialSemanticClass.DYNAMIC_AIR_AGENT;

    const waypoints = prompt.waypoints;

    for (let t = 0; t < T; ++t) {
      if (t >= waypoints.length) break;
      const wp = waypoints[t];

      // Convert waypoint position to voxel coordinates
      const gx = Math.floor((wp.x + halfX) / vx);
      const gy = Math.floor((wp.y + halfY) / vy);
      const gz = Math.floor((wp.z - minZ) / vz);

      // Rasterize a 2x2x2 agent bounding volume
      for (let dx = -1; dx <= 0; ++dx) {
        for (let dy = -1; dy <= 0; ++dy) {
          for (let dz = -1; dz <= 0; ++dz) {
            const ax = gx + dx;
            const ay = gy + dy;
            const az = gz + dz;

            if (ax >= 0 && ax < dimX && ay >= 0 && ay < dimY && az >= 0 && az < dimZ) {
              const idx = getVoxelIndex(t, ax, ay, az);
              grid[idx] = agentSemantic;
            }
          }
        }
      }
    }

    // 5. Compute class histogram for verification and loss weighting
    for (let i = 0; i < grid.length; ++i) {
      const cls = grid[i];
      classHistogram[cls] = (classHistogram[cls] || 0) + 1;
    }

    // 6. Run-length encode the dense voxel grid
    const sparseRle = OccSoraBridge.rleEncode(grid);

    const metadata: OccupancyGrid4DMetadata = {
      dimensions,
      voxelSizeMeters: voxelSize,
      originENU: [0, 0, terrainBase],
      classes: {
        [GeospatialSemanticClass.AIRSPACE]: 'Airspace',
        [GeospatialSemanticClass.TERRAIN]: 'Terrain',
        [GeospatialSemanticClass.WATER]: 'Water',
        [GeospatialSemanticClass.BUILDING_FACADE]: 'Building Facade',
        [GeospatialSemanticClass.BUILDING_INTERIOR]: 'Building Interior',
        [GeospatialSemanticClass.VEGETATION]: 'Vegetation',
        [GeospatialSemanticClass.TRANSIT_ROAD]: 'Transit Road',
        [GeospatialSemanticClass.DYNAMIC_AIR_AGENT]: 'Dynamic Air Agent',
        [GeospatialSemanticClass.DYNAMIC_GROUND_AGENT]: 'Dynamic Ground Agent',
        [GeospatialSemanticClass.DYNAMIC_HAZARD]: 'Dynamic Hazard'
      },
      timeStepMs
    };

    return {
      id: `s4d_item_${Date.now()}`,
      prompt,
      occupancyGrid: {
        metadata,
        sparseRleBytes: sparseRle
      },
      classHistogram
    };
  }
}
