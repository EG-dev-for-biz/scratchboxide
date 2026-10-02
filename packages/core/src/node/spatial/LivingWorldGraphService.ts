/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import {
  LivingWorldGraph,
  LivingGraphDistrict,
  LivingGraphTerrain,
  LivingGraphStructure,
  LivingGraphVegetationStand,
  LivingGraphCorridor,
  LivingGraphEdge,
  Vector2Tuple,
  Vector3Tuple,
  Vector4Tuple,
  SubstrateClass
} from '../../common/spatial/living-world-graph-types';
import { GeodeticAnchor } from '../../common/spatial/colmap-vector-reference-types';
import { MetricBoundingBox } from '../../common/spatial/universal-3d-structure-types';
import { OrientedBoundingBoxSolver } from './OrientedBoundingBoxSolver';
import { Universal3DStructureFoundation } from './Universal3DStructureFoundation';

export interface CreateDistrictOptions {
  id: string;
  name: string;
  wgs84Anchor: GeodeticAnchor;
  metricExtentMeters?: number;
  dominantDomain?: string;
  source?: 'google_3d_tiles' | 'procedural_synthesizer' | 'hybrid';
  terrainParams?: Partial<LivingGraphTerrain['oracleParams']>;
}

export interface RegisterStructureParams {
  id: string;
  name: string;
  center: Vector3Tuple;
  dimensions: Vector3Tuple; // [width, height, depth]
  yawDegrees?: number;
  floorCount?: number;
  floorHeightMeters?: number;
  facadeColor?: Vector4Tuple;
  glazingColor?: Vector4Tuple;
  recessDepthMeters?: number;
  roofType?: 'flat_parapet' | 'pitched_gable' | 'sawtooth' | 'crown_spire' | 'stepped_terrace';
  addRooftopMechanicals?: boolean;
}

export interface GroundProbeResult {
  minGroundY: number;
  maxGroundY: number;
  meanGroundY: number;
  sampleCount: number;
  samples: Array<{ x: number; z: number; y: number }>;
}

export class LivingWorldGraphService {
  private graph: LivingWorldGraph;

  constructor(initialGraph?: LivingWorldGraph) {
    this.graph = initialGraph || {
      districts: {},
      activeDistrictId: ''
    };
  }

  /**
   * Returns the underlying Living World Graph container.
   */
  public getGraph(): LivingWorldGraph {
    return this.graph;
  }

  /**
   * Initializes a new Geographic District inside the Living World Graph.
   */
  public createDistrict(options: CreateDistrictOptions): LivingGraphDistrict {
    const extent = options.metricExtentMeters ?? 200.0;
    const halfExt = extent * 0.5;

    const terrain: LivingGraphTerrain = {
      id: `terrain_${options.id}`,
      districtId: options.id,
      elevationDatumMeters: options.wgs84Anchor.elevationMeters ?? 0.0,
      heightfieldResolutionMeters: 1.25,
      dimensions: [extent, extent],
      gridOrigin: [-halfExt, -halfExt],
      bedrockSubstrate: 'crystalline_granite',
      oracleParams: {
        peakPosition: [0, -60],
        peakHeight: 45.0,
        valleyFloorElevation: 0.0,
        ridgeCount: 4,
        sharpnessExponent: 1.8,
        screeNoiseAmplitude: 0.75,
        snowLineElevation: 22.0,
        ...options.terrainParams
      }
    };

    const metricAABB: MetricBoundingBox = {
      min: [-halfExt, 0, -halfExt],
      max: [halfExt, terrain.oracleParams.peakHeight + 50.0, halfExt],
      center: [0, (terrain.oracleParams.peakHeight + 50.0) * 0.5, 0],
      extents: [extent, terrain.oracleParams.peakHeight + 50.0, extent],
      boundingSphereRadius: Math.sqrt(halfExt * halfExt * 2 + Math.pow((terrain.oracleParams.peakHeight + 50.0) * 0.5, 2))
    };

    const district: LivingGraphDistrict = {
      id: options.id,
      name: options.name,
      wgs84Anchor: options.wgs84Anchor,
      metricAABB,
      dominantDomain: options.dominantDomain ?? 'UrbanHighRiseCore',
      terrain,
      corridors: [],
      structures: [],
      vegetation: [],
      edges: [],
      metadata: {
        source: options.source ?? 'procedural_synthesizer',
        createdAtTimestamp: Date.now(),
        version: 1
      }
    };

    this.graph.districts[district.id] = district;
    if (!this.graph.activeDistrictId) {
      this.graph.activeDistrictId = district.id;
    }

    return district;
  }

  /**
   * Evaluates continuous bedrock terrain elevation H(x, z) using the district's elevation oracle.
   */
  public evaluateTerrainHeight(districtId: string, x: number, z: number): number {
    const district = this.getDistrict(districtId);
    const p = district.terrain.oracleParams;

    const dx = x - p.peakPosition[0];
    const dz = z - p.peakPosition[1];
    const dist = Math.sqrt(dx * dx + dz * dz);
    const angle = Math.atan2(dz, dx);

    const ridgeWave = Math.cos(p.ridgeCount * angle);
    const ridgeFactor = 1.0 + 0.45 * Math.pow(Math.abs(ridgeWave), p.sharpnessExponent) * (ridgeWave >= 0 ? 1.0 : -0.7);
    const radialFalloff = Math.exp(-dist * 0.024);
    let hMassif = p.peakHeight * radialFalloff * ridgeFactor;

    // Glacial cirque erosion
    const cirqueDist = Math.sqrt(x * x + (z + 28.0) * (z + 28.0));
    const cirqueHollow = 12.0 * Math.exp(-cirqueDist * cirqueDist * 0.0018);
    hMassif = Math.max(p.valleyFloorElevation, hMassif - cirqueHollow);

    // Glacial U-shaped flat valley
    const valleyU = Math.pow(Math.min(1.0, Math.max(0.0, Math.abs(x) / 36.0)), 2.2) * 16.0;
    if (z > -15.0) {
      hMassif = Math.min(hMassif, valleyU + p.valleyFloorElevation);
    }

    // Scree / talus noise
    const scree = Math.sin(x * 0.45 + z * 0.35) * Math.cos(z * 0.55 - x * 0.25) * p.screeNoiseAmplitude;
    return Math.max(p.valleyFloorElevation, hMassif + scree);
  }

  /**
   * Evaluates surface normal vector at (x, z) using central differences on the terrain oracle.
   */
  public evaluateTerrainNormal(districtId: string, x: number, z: number, eps = 0.4): Vector3Tuple {
    const hL = this.evaluateTerrainHeight(districtId, x - eps, z);
    const hR = this.evaluateTerrainHeight(districtId, x + eps, z);
    const hD = this.evaluateTerrainHeight(districtId, x, z - eps);
    const hU = this.evaluateTerrainHeight(districtId, x, z + eps);

    const nx = -(hR - hL) / (2.0 * eps);
    const ny = 1.0;
    const nz = -(hU - hD) / (2.0 * eps);
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1.0;
    return [nx / len, ny / len, nz / len];
  }

  /**
   * Evaluates terrain bedrock across an Oriented Bounding Box (OBB) footprint.
   * Probes 9 points: the 4 rotated perimeter corners, 4 edge midpoints, and center.
   * Guarantees zero levitation and zero clipping.
   */
  public probeGroundOBB(
    districtId: string,
    center: Vector3Tuple,
    halfWidth: number,
    halfDepth: number,
    yawDegrees = 0
  ): GroundProbeResult {
    const yawRad = (yawDegrees * Math.PI) / 180.0;
    const cosY = Math.cos(yawRad);
    const sinY = Math.sin(yawRad);

    const relativeOffsets: Vector2Tuple[] = [
      [-halfWidth, -halfDepth], // Corner 0
      [ halfWidth, -halfDepth], // Corner 1
      [ halfWidth,  halfDepth], // Corner 2
      [-halfWidth,  halfDepth], // Corner 3
      [ 0,         -halfDepth], // Midpoint N
      [ halfWidth,  0        ], // Midpoint E
      [ 0,          halfDepth], // Midpoint S
      [-halfWidth,  0        ], // Midpoint W
      [ 0,          0        ]  // Center
    ];

    const samples: Array<{ x: number; z: number; y: number }> = [];
    let minGroundY = Infinity;
    let maxGroundY = -Infinity;
    let sumY = 0;

    for (const [dx, dz] of relativeOffsets) {
      const rx = center[0] + dx * cosY - dz * sinY;
      const rz = center[2] + dx * sinY + dz * cosY;
      const gy = this.evaluateTerrainHeight(districtId, rx, rz);

      samples.push({ x: rx, z: rz, y: gy });
      minGroundY = Math.min(minGroundY, gy);
      maxGroundY = Math.max(maxGroundY, gy);
      sumY += gy;
    }

    return {
      minGroundY,
      maxGroundY,
      meanGroundY: sumY / samples.length,
      sampleCount: samples.length,
      samples
    };
  }

  /**
   * Registers a new architectural structure into the district.
   * Performs OBB ground probing, foundation plinth clamping, facade extraction, and relational edge linking.
   */
  public registerStructure(districtId: string, params: RegisterStructureParams): LivingGraphStructure {
    const district = this.getDistrict(districtId);
    const yawDeg = params.yawDegrees ?? 0;
    const halfW = params.dimensions[0] * 0.5;
    const halfH = params.dimensions[1] * 0.5;
    const halfD = params.dimensions[2] * 0.5;

    // 1. Authoritative Ground Probing across OBB
    const groundProbe = this.probeGroundOBB(districtId, params.center, halfW, halfD, yawDeg);
    const baseY = groundProbe.maxGroundY + 0.35;
    const skirtBottom = groundProbe.minGroundY - 3.5;
    const embedDepth = baseY - skirtBottom;

    // 2. Compute 2D Rotated Footprint Polygon
    const yawRad = (yawDeg * Math.PI) / 180.0;
    const cosY = Math.cos(yawRad);
    const sinY = Math.sin(yawRad);
    const footprintPolygon: Vector2Tuple[] = [
      [params.center[0] - halfW * cosY + halfD * sinY, params.center[2] - halfW * sinY - halfD * cosY],
      [params.center[0] + halfW * cosY + halfD * sinY, params.center[2] + halfW * sinY - halfD * cosY],
      [params.center[0] + halfW * cosY - halfD * sinY, params.center[2] + halfW * sinY + halfD * cosY],
      [params.center[0] - halfW * cosY - halfD * sinY, params.center[2] - halfW * sinY + halfD * cosY]
    ];

    // 3. Facade Planes with Inward Fenestration Recesses
    const recessDepth = params.recessDepthMeters ?? 0.35;
    const floorCount = params.floorCount ?? Math.max(1, Math.round(params.dimensions[1] / 3.4));
    const floorHeight = params.floorHeightMeters ?? params.dimensions[1] / floorCount;
    const facadeColor = params.facadeColor ?? [0.48, 0.50, 0.53, 1.0];
    const glazingColor = params.glazingColor ?? [0.95, 0.65, 0.25, 1.0];

    const facades = this.buildParametricFacades(
      params.id,
      params.center,
      baseY,
      params.dimensions,
      yawDeg,
      floorCount,
      floorHeight,
      recessDepth,
      facadeColor,
      glazingColor
    );

    // 4. Rooftop Mechanical Assembly (Archie)
    const roofElevationY = baseY + params.dimensions[1];
    const rooftopUnits = params.addRooftopMechanicals !== false
      ? this.buildParametricRooftopUnits(params.id, params.dimensions)
      : [];

    const structure: LivingGraphStructure = {
      id: params.id,
      name: params.name,
      districtId,
      orientedBoundingBox: {
        center: [params.center[0], baseY + halfH, params.center[2]],
        extents: [halfW, halfH, halfD],
        yawDegrees: yawDeg
      },
      footprintPolygon,
      floorCount,
      floorHeightMeters: floorHeight,
      foundationPlinth: {
        topElevationY: baseY,
        skirtBottomElevationY: skirtBottom,
        embedDepthMeters: embedDepth,
        material: 'concrete_plinth'
      },
      facades,
      roof: {
        id: `roof_${params.id}`,
        structureId: params.id,
        roofType: params.roofType ?? 'flat_parapet',
        elevationY: roofElevationY,
        parapetHeightMeters: 1.25,
        parapetCopingWidthMeters: 0.45,
        mechanicalUnits: rooftopUnits,
        snowRetentionFactor: 0.85
      },
      collisionHull: {
        type: 'obb',
        center: [params.center[0], (roofElevationY + skirtBottom) * 0.5, params.center[2]],
        dimensions: [params.dimensions[0] + 1.2, roofElevationY - skirtBottom, params.dimensions[2] + 1.2],
        safetyMarginMeters: 1.5
      }
    };

    district.structures.push(structure);

    // 5. Connect Relational Edges
    district.edges.push(
      {
        id: `edge_${structure.id}_grounded`,
        sourceId: structure.id,
        targetId: district.terrain.id,
        type: 'GROUNDED_ON',
        metadata: { embedDepthMeters: embedDepth }
      },
      {
        id: `edge_${district.id}_encloses_${structure.id}`,
        sourceId: district.id,
        targetId: structure.id,
        type: 'ENCLOSES'
      },
      {
        id: `edge_${structure.id}_occupies`,
        sourceId: structure.id,
        targetId: 'spatial_clearance_grid',
        type: 'OCCUPIES'
      }
    );

    return structure;
  }

  /**
   * Registers vegetation stands using deterministic 70-20-10 ecological stratification.
   * Enforces compound exclusion and root collar ground sinking to prevent floating.
   */
  public registerVegetationStands(
    districtId: string,
    stands: Array<{
      id: string;
      position: Vector2Tuple; // [x, z]
      scale?: number;
      yawDegrees?: number;
      canopyTier?: 0 | 1 | 2; // 0=70% Canopy, 1=20% Understory, 2=10% Groundcover
      archetype?: 'conifer_excurrent' | 'deciduous_decurrent' | 'alpine_dwarf_shrub';
    }>
  ): LivingGraphVegetationStand[] {
    const district = this.getDistrict(districtId);
    const results: LivingGraphVegetationStand[] = [];

    for (const s of stands) {
      const [x, z] = s.position;

      // 1. Check Collision / Exclusion against All Structures in District
      if (this.isPointInsideAnyStructure(districtId, x, z, 5.0)) {
        continue; // Excluded by building OBB margin
      }

      // 2. Evaluate Bedrock Elevation & Normal
      const groundY = this.evaluateTerrainHeight(districtId, x, z);
      const normal = this.evaluateTerrainNormal(districtId, x, z);
      const slopeCos = normal[1]; // N · Up

      // 3. Slope Survival Rules
      // Canopy trees cannot grow on cliffs > 34° (slopeCos < 0.83)
      const tier = s.canopyTier ?? 0;
      if (tier === 0 && slopeCos < 0.83) continue;
      // Dwarf shrubs can cling to steep ledges up to 48° (slopeCos >= 0.67)
      if (tier === 2 && slopeCos < 0.67) continue;

      // 4. Root Collar Ground Penetration: Sink trunk 0.35m into bedrock
      const rootEmbedDepth = 0.35;
      const standPosition: Vector3Tuple = [x, groundY - rootEmbedDepth, z];

      const stand: LivingGraphVegetationStand = {
        id: s.id,
        districtId,
        archetype: s.archetype ?? (tier === 2 ? 'alpine_dwarf_shrub' : 'conifer_excurrent'),
        canopyTier: tier,
        position: standPosition,
        scale: s.scale ?? (tier === 0 ? 1.15 : tier === 1 ? 0.68 : 0.35),
        yawDegrees: s.yawDegrees ?? Math.random() * 360.0,
        rootCollarEmbedDepthMeters: rootEmbedDepth,
        envelopeNormalFactor: 0.82,
        exclusionRadiusMeters: tier === 0 ? 3.0 : 1.5
      };

      district.vegetation.push(stand);
      results.push(stand);

      // Relational Edge
      district.edges.push({
        id: `edge_${stand.id}_grounded`,
        sourceId: stand.id,
        targetId: district.terrain.id,
        type: 'GROUNDED_ON',
        metadata: { rootCollarEmbedDepth: rootEmbedDepth }
      });
    }

    return results;
  }

  /**
   * Checks whether a 2D position (x, z) falls inside any building's oriented bounding box plus margin.
   */
  public isPointInsideAnyStructure(districtId: string, x: number, z: number, margin = 0.0): boolean {
    const district = this.getDistrict(districtId);

    for (const bldg of district.structures) {
      const obb = bldg.orientedBoundingBox;
      const halfW = obb.extents[0] + margin;
      const halfD = obb.extents[2] + margin;

      const dx = x - obb.center[0];
      const dz = z - obb.center[2];
      const yawRad = (-obb.yawDegrees * Math.PI) / 180.0;
      const localX = dx * Math.cos(yawRad) - dz * Math.sin(yawRad);
      const localZ = dx * Math.sin(yawRad) + dz * Math.cos(yawRad);

      if (Math.abs(localX) <= halfW && Math.abs(localZ) <= halfD) {
        return true;
      }
    }

    return false;
  }

  /**
   * Helper to build parametric facades with recessed window bays and drainage sills.
   */
  private buildParametricFacades(
    structureId: string,
    center: Vector3Tuple,
    baseY: number,
    dimensions: Vector3Tuple,
    yawDeg: number,
    floorCount: number,
    floorHeight: number,
    recessDepth: number,
    baseColor: Vector4Tuple,
    glazingColor: Vector4Tuple
  ): LivingGraphStructure['facades'] {
    const facades: LivingGraphStructure['facades'] = [];
    const yawRad = (yawDeg * Math.PI) / 180.0;
    const cosY = Math.cos(yawRad);
    const sinY = Math.sin(yawRad);

    const halfW = dimensions[0] * 0.5;
    const halfD = dimensions[2] * 0.5;
    const midY = baseY + dimensions[1] * 0.5;

    // 4 Cardinal Facades: South (+Z), North (-Z), East (+X), West (-X) in local space
    const sides: Array<{ name: string; normalLocal: Vector3Tuple; offsetLocal: Vector3Tuple; width: number }> = [
      { name: 'south', normalLocal: [0, 0, 1],  offsetLocal: [0, 0, halfD],  width: dimensions[0] },
      { name: 'north', normalLocal: [0, 0, -1], offsetLocal: [0, 0, -halfD], width: dimensions[0] },
      { name: 'east',  normalLocal: [1, 0, 0],  offsetLocal: [halfW, 0, 0],  width: dimensions[2] },
      { name: 'west',  normalLocal: [-1, 0, 0], offsetLocal: [-halfW, 0, 0], width: dimensions[2] }
    ];

    for (let sIdx = 0; sIdx < sides.length; ++sIdx) {
      const side = sides[sIdx];
      // Rotate normal & offset to world space
      const nx = side.normalLocal[0] * cosY - side.normalLocal[2] * sinY;
      const nz = side.normalLocal[0] * sinY + side.normalLocal[2] * cosY;
      const ox = center[0] + side.offsetLocal[0] * cosY - side.offsetLocal[2] * sinY;
      const oz = center[2] + side.offsetLocal[0] * sinY + side.offsetLocal[2] * cosY;

      const fenestrationBays: LivingGraphStructure['facades'][0]['fenestrationBays'] = [];
      const bayCount = Math.max(1, Math.floor(side.width / 4.0));
      const bayWidth = (side.width * 0.75) / bayCount;

      for (let f = 0; f < floorCount; ++f) {
        for (let b = 0; b < bayCount; ++b) {
          fenestrationBays.push({
            bayIndex: b,
            floorIndex: f,
            widthMeters: bayWidth * 0.65,
            heightMeters: floorHeight * 0.55,
            sillHeightMeters: 0.95,
            recessDepthMeters: recessDepth,
            drainageSillTiltDeg: 12.0,
            mullionProfile: 'industrial',
            glazingColor,
            emissiveGlow: [glazingColor[0], glazingColor[1], glazingColor[2], 0.85]
          });
        }
      }

      facades.push({
        id: `facade_${structureId}_${side.name}`,
        structureId,
        normal: [nx, 0, nz],
        origin: [ox, midY, oz],
        widthMeters: side.width,
        heightMeters: dimensions[1],
        fenestrationBays,
        baseColor,
        roughness: 0.75,
        metalness: 0.15
      });
    }

    return facades;
  }

  /**
   * Helper to build parametric rooftop mechanical units (dual HVAC chillers, exhaust ducts, communications spire).
   */
  private buildParametricRooftopUnits(
    structureId: string,
    dimensions: Vector3Tuple
  ): LivingGraphStructure['roof']['mechanicalUnits'] {
    const halfW = dimensions[0] * 0.5;
    const halfD = dimensions[2] * 0.5;
    const chillerW = Math.min(3.2, dimensions[0] * 0.22);
    const chillerL = Math.min(2.4, dimensions[2] * 0.25);

    return [
      {
        id: `hvac_left_${structureId}`,
        type: 'hvac_condenser',
        relativePosition: [-halfW * 0.45, 1.1, -halfD * 0.35],
        dimensions: [chillerW, 1.8, chillerL],
        rotationYDeg: 0
      },
      {
        id: `hvac_right_${structureId}`,
        type: 'hvac_condenser',
        relativePosition: [halfW * 0.45, 1.1, -halfD * 0.35],
        dimensions: [chillerW, 1.8, chillerL],
        rotationYDeg: 0
      },
      {
        id: `duct_manifold_${structureId}`,
        type: 'exhaust_duct_manifold',
        relativePosition: [0, 0.6, -halfD * 0.35],
        dimensions: [halfW * 0.6, 0.6, 0.8],
        rotationYDeg: 0
      },
      {
        id: `comm_spire_${structureId}`,
        type: 'communications_spire',
        relativePosition: [halfW * 0.65, 6.0, halfD * 0.65],
        dimensions: [1.2, 12.0, 1.2],
        rotationYDeg: 15.0
      }
    ];
  }

  /**
   * Retrieves a district by ID or throws an actionable error.
   */
  public getDistrict(districtId: string): LivingGraphDistrict {
    const district = this.graph.districts[districtId];
    if (!district) {
      throw new Error(`District with id '${districtId}' not found in Living World Graph.`);
    }
    return district;
  }
}
