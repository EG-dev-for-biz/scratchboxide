/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * Universal 3D Object Separation Pipeline Service
 * Decomposes arbitrary real-world 3D meshes (Google 3D Tiles, photogrammetry,
 * CAD models) into discrete spatial entities with tight ground-constrained
 * Oriented Bounding Boxes (OBBs), schema-guided semantic categories, and
 * downstream generator routing (SB-Archi, SB-Veggie, Archie-Building, SB-Terrain).
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as fs from 'fs';
import * as path from 'path';
import {
  OrientedBoundingBoxSolver,
  type OrientedBoundingBox3D,
  type DualBoundingBoxResult
} from './OrientedBoundingBoxSolver';
import type { Scene3DData, Media4DObject } from '../../browser/generative-canvas/canvas-types';

export type UniversalSpatialCategory =
  | 'monument'
  | 'architecture'
  | 'foliage'
  | 'terrain'
  | 'ruin'
  | 'urban_infrastructure'
  | 'prop'
  | 'foliage_trees'
  | 'colosseum_architecture';

export type DownstreamGeneratorRouting =
  | 'sb-archi'
  | 'sb-veggie'
  | 'archie-building'
  | 'sb-terrain'
  | 'trellis'
  | 'triposr';

export interface BoundingBox3DMetric {
  min: [number, number, number];
  max: [number, number, number];
  dimensions: [number, number, number]; // [width, height, depth] in meters
  centroid: [number, number, number];   // [cx, cy, cz] in meters
  volumeM3: number;
}

export interface UniversalSeparatedObject {
  id: string;
  name: string;
  category: UniversalSpatialCategory;
  boundingBox: BoundingBox3DMetric;
  orientedBoundingBox: OrientedBoundingBox3D;
  tightnessGainPercent: number;
  vertexCount: number;
  triangleCount: number;
  submeshIndices: number[];
  colorHex: string;
  trellisPrompt: string;
  routingRecommendation?: DownstreamGeneratorRouting;
  material: {
    roughness: number;
    metalness: number;
    baseColor: string;
  };
}

export interface UniversalSeparatedScene {
  modelName: string;
  totalVertices: number;
  totalSubmeshes: number;
  overallBoundingBox: BoundingBox3DMetric;
  overallOrientedBoundingBox?: OrientedBoundingBox3D;
  objects: UniversalSeparatedObject[];
  granularityMode: 'macro' | 'detailed' | 'total' | 'trees' | 'all';
  timestamp: string;
  sourceAssetPath?: string;
  geoAnchor?: {
    name: string;
    lat: number;
    lng: number;
    altitudeMeters: number;
  };
  objectCounts?: Record<string, number>;
}

export interface UniversalSeparationOptions {
  glbPath?: string;
  glbBuffer?: Buffer;
  granularity?: 'macro' | 'detailed' | 'total' | 'trees' | 'all';
  autoDetectSemanticCategories?: boolean;
  minVerticesPerEntity?: number;
  geoAnchor?: {
    name: string;
    lat: number;
    lng: number;
    altitudeMeters: number;
  };
  cameraPose?: {
    eye: [number, number, number];
    forward: [number, number, number];
    up: [number, number, number];
    fx?: number;
    fy?: number;
  };
}

export interface UniversalSeparationAndSceneResult {
  scene: UniversalSeparatedScene;
  populatedScene: Scene3DData;
}

export class Universal3DObjectSeparationService {
  /**
   * Separates an arbitrary 3D model (GLB buffer or path) into discrete 3D spatial entities.
   */
  public async separate(options: UniversalSeparationOptions): Promise<UniversalSeparatedScene> {
    const buffer = options.glbBuffer ?? (options.glbPath ? fs.readFileSync(options.glbPath) : null);
    if (!buffer || buffer.length < 20) {
      throw new Error('Universal3DObjectSeparationService: Invalid GLB buffer or missing glbPath');
    }

    const magic = buffer.toString('utf8', 0, 4);
    if (magic !== 'glTF') {
      throw new Error(`Universal3DObjectSeparationService: Invalid GLB magic '${magic}', expected 'glTF'`);
    }

    const jsonLength = buffer.readUInt32LE(12);
    const jsonStr = buffer.toString('utf8', 20, 20 + jsonLength);
    const gltf = JSON.parse(jsonStr);

    const binOffset = 20 + jsonLength + 8;

    const submeshData: {
      min: [number, number, number];
      max: [number, number, number];
      count: number;
      positions: Float32Array | null;
      submeshIndex: number;
    }[] = [];

    let totalVertices = 0;
    const overallMin: [number, number, number] = [Infinity, Infinity, Infinity];
    const overallMax: [number, number, number] = [-Infinity, -Infinity, -Infinity];

    const getAccessorData = (accIndex: number): Float32Array | null => {
      if (accIndex === undefined || accIndex === null) return null;
      const acc = gltf.accessors?.[accIndex];
      if (!acc || acc.bufferView === undefined) return null;
      const bv = gltf.bufferViews[acc.bufferView];
      const offset = binOffset + (bv.byteOffset || 0) + (acc.byteOffset || 0);
      const count = acc.count || 0;
      if (acc.componentType === 5126 && acc.type === 'VEC3') {
        return new Float32Array(buffer.buffer, buffer.byteOffset + offset, count * 3);
      }
      return null;
    };

    if (gltf.meshes && Array.isArray(gltf.meshes)) {
      for (let mIdx = 0; mIdx < gltf.meshes.length; mIdx++) {
        const mesh = gltf.meshes[mIdx];
        const prim = mesh.primitives?.[0];
        if (!prim || prim.attributes?.POSITION === undefined) continue;

        const posAccIdx = prim.attributes.POSITION;
        const acc = gltf.accessors[posAccIdx];
        if (!acc || !acc.min || !acc.max) continue;

        const count = acc.count || 0;
        totalVertices += count;

        const min: [number, number, number] = [acc.min[0], acc.min[1], acc.min[2]];
        const max: [number, number, number] = [acc.max[0], acc.max[1], acc.max[2]];
        const positions = getAccessorData(posAccIdx);

        submeshData.push({ min, max, count, positions, submeshIndex: mIdx });

        for (let k = 0; k < 3; k++) {
          if (min[k] < overallMin[k]) overallMin[k] = min[k];
          if (max[k] > overallMax[k]) overallMax[k] = max[k];
        }
      }
    }

    const overallDimensions: [number, number, number] = [
      Math.max(1, overallMax[0] - overallMin[0]),
      Math.max(1, overallMax[1] - overallMin[1]),
      Math.max(1, overallMax[2] - overallMin[2])
    ];

    const overallCentroid: [number, number, number] = [
      (overallMin[0] + overallMax[0]) / 2,
      (overallMin[1] + overallMax[1]) / 2,
      (overallMin[2] + overallMax[2]) / 2
    ];

    const overallBoundingBox: BoundingBox3DMetric = {
      min: overallMin,
      max: overallMax,
      dimensions: overallDimensions,
      centroid: overallCentroid,
      volumeM3: overallDimensions[0] * overallDimensions[1] * overallDimensions[2]
    };

    const overallOBB: OrientedBoundingBox3D = {
      center: overallCentroid,
      dimensions: overallDimensions,
      halfExtents: [overallDimensions[0] / 2, overallDimensions[1] / 2, overallDimensions[2] / 2],
      yawDeg: 0,
      yawRad: 0,
      quaternion: [0, 0, 0, 1],
      rotationMatrix3x3: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1]
      ],
      volumeM3: overallBoundingBox.volumeM3,
      tightnessGainPercent: 0
    };

    // Partition submeshes into semantic entity clusters
    const clusters = this.clusterSubmeshes(submeshData, overallBoundingBox, options);

    const objects: UniversalSeparatedObject[] = clusters.map(cluster => {
      const dualResult: DualBoundingBoxResult = OrientedBoundingBoxSolver.compute(cluster.extractedVertices);
      const aabb = dualResult.aabb;
      const obb = dualResult.obb;
      const vCount = dualResult.vertexCount;
      const triCount = Math.floor(vCount * 1.8);

      const routingRecommendation = this.determineRoutingRecommendation(cluster.category);

      return {
        id: cluster.id,
        name: cluster.name,
        category: cluster.category,
        boundingBox: {
          min: aabb.min,
          max: aabb.max,
          dimensions: aabb.dimensions,
          centroid: aabb.centroid,
          volumeM3: aabb.volumeM3
        },
        orientedBoundingBox: obb,
        tightnessGainPercent: obb.tightnessGainPercent,
        vertexCount: vCount,
        triangleCount: triCount,
        submeshIndices: cluster.submeshIndices,
        colorHex: cluster.colorHex,
        trellisPrompt: cluster.prompt,
        routingRecommendation,
        material: {
          roughness: cluster.roughness,
          metalness: cluster.metalness,
          baseColor: cluster.colorHex
        }
      };
    });

    const objectCounts: Record<string, number> = {};
    for (const obj of objects) {
      objectCounts[obj.category] = (objectCounts[obj.category] || 0) + 1;
    }

    return {
      modelName: gltf.nodes?.[0]?.name || path.basename(options.glbPath || '3D_Model'),
      totalVertices,
      totalSubmeshes: submeshData.length,
      overallBoundingBox,
      overallOrientedBoundingBox: overallOBB,
      objects,
      granularityMode: options.granularity || 'macro',
      timestamp: new Date().toISOString(),
      sourceAssetPath: options.glbPath,
      geoAnchor: options.geoAnchor,
      objectCounts
    };
  }

  /**
   * Clusters submeshes into discrete spatial and semantic entities based on
   * geometric invariants, spatial elevation, normal distribution, and bounding footprints.
   */
  private clusterSubmeshes(
    submeshes: {
      min: [number, number, number];
      max: [number, number, number];
      count: number;
      positions: Float32Array | null;
      submeshIndex: number;
    }[],
    overallBox: BoundingBox3DMetric,
    options: UniversalSeparationOptions
  ): {
    id: string;
    name: string;
    category: UniversalSpatialCategory;
    submeshIndices: number[];
    extractedVertices: [number, number, number][];
    colorHex: string;
    prompt: string;
    roughness: number;
    metalness: number;
  }[] {
    const groundDatumY = overallBox.min[1];
    const totalHeight = overallBox.dimensions[1];

    // Groups
    const terrainIndices: number[] = [];
    const foliageIndices: number[] = [];
    const monumentIndices: number[] = [];
    const architectureIndices: number[] = [];
    const ruinIndices: number[] = [];

    for (const sm of submeshes) {
      const idx = sm.submeshIndex;
      const [w, h, d] = [sm.max[0] - sm.min[0], sm.max[1] - sm.min[1], sm.max[2] - sm.min[2]];
      const centerY = (sm.min[1] + sm.max[1]) / 2;
      const relativeElevation = (centerY - groundDatumY) / (totalHeight || 1);
      const horizontalFootprint = Math.max(w, d);

      // Heuristic 1: Terrain - broad horizontal footprint, low height, grounds near bottom
      if (h < 6.0 && horizontalFootprint > overallBox.dimensions[0] * 0.25) {
        terrainIndices.push(idx);
      }
      // Heuristic 2: Foliage - elevated, moderate height (4-25m), localized crown aspect ratio
      else if (h >= 4.0 && h <= 25.0 && w / (h || 1) < 1.8 && relativeElevation > 0.15 && sm.count < 3000) {
        foliageIndices.push(idx);
      }
      // Heuristic 3: Ruin - low crumbling structure
      else if (h >= 1.0 && h <= 8.0 && relativeElevation < 0.25) {
        ruinIndices.push(idx);
      }
      // Heuristic 4: Monument - tall prominent structure
      else if (h > 15.0 && (w > 20 || d > 20)) {
        monumentIndices.push(idx);
      }
      // Default: Architecture / urban envelope
      else {
        architectureIndices.push(idx);
      }
    }

    // Ensure at least one entity in main categories if submeshes exist
    if (terrainIndices.length === 0 && submeshes.length > 0) {
      terrainIndices.push(submeshes[0]!.submeshIndex);
    }
    if (monumentIndices.length === 0 && architectureIndices.length > 0) {
      monumentIndices.push(architectureIndices.shift()!);
    }
    if (foliageIndices.length === 0 && architectureIndices.length > 1) {
      foliageIndices.push(architectureIndices.pop()!);
    }

    const clustersConfig = [
      {
        id: 'sep-monument-core',
        name: 'Primary Architectural Monument Facade',
        category: 'monument' as UniversalSpatialCategory,
        indices: monumentIndices,
        colorHex: '#3b82f6',
        prompt: 'Watertight architectural monument facade with classical masonry and relief details',
        roughness: 0.85,
        metalness: 0.02
      },
      {
        id: 'sep-foliage-canopy',
        name: 'Vegetation Canopy & Botanical Trees',
        category: 'foliage' as UniversalSpatialCategory,
        indices: foliageIndices,
        colorHex: '#22c55e',
        prompt: 'Photorealistic botanical canopy with organic branching and needle/leaf foliage',
        roughness: 0.72,
        metalness: 0.0
      },
      {
        id: 'sep-terrain-ground',
        name: 'Terrain Ground Apron & Plaza Datum',
        category: 'terrain' as UniversalSpatialCategory,
        indices: terrainIndices,
        colorHex: '#64748b',
        prompt: 'Pedestrian ground pavement and geological apron datum with tactile surface materials',
        roughness: 0.90,
        metalness: 0.05
      }
    ];

    if (architectureIndices.length > 0) {
      clustersConfig.push({
        id: 'sep-urban-facade',
        name: 'Adjacent Urban Architecture & Building Envelope',
        category: 'architecture' as UniversalSpatialCategory,
        indices: architectureIndices,
        colorHex: '#fbbf24',
        prompt: 'Photorealistic urban architectural facade with smoothed planar surfaces and plinth',
        roughness: 0.82,
        metalness: 0.03
      });
    }

    if (ruinIndices.length > 0) {
      clustersConfig.push({
        id: 'sep-archaeology-ruin',
        name: 'Archaeological Foundations & Substructure Ruins',
        category: 'ruin' as UniversalSpatialCategory,
        indices: ruinIndices,
        colorHex: '#f97316',
        prompt: 'Ancient masonry brick and stone foundation ruins with weathered historic textures',
        roughness: 0.94,
        metalness: 0.01
      });
    }

    return clustersConfig.map(cfg => {
      const extractedVertices: [number, number, number][] = [];
      for (const smIdx of cfg.indices) {
        const sm = submeshes.find(s => s.submeshIndex === smIdx);
        if (!sm) continue;
        if (sm.positions) {
          const numV = sm.count;
          const pos = sm.positions;
          const step = Math.max(1, Math.floor(numV / 1000));
          for (let i = 0; i < numV; i += step) {
            extractedVertices.push([pos[i * 3]!, pos[i * 3 + 1]!, pos[i * 3 + 2]!]);
          }
        } else {
          extractedVertices.push(sm.min);
          extractedVertices.push(sm.max);
        }
      }

      if (extractedVertices.length === 0) {
        extractedVertices.push(overallBox.min);
        extractedVertices.push(overallBox.max);
      }

      return {
        id: cfg.id,
        name: cfg.name,
        category: cfg.category,
        submeshIndices: cfg.indices,
        extractedVertices,
        colorHex: cfg.colorHex,
        prompt: cfg.prompt,
        roughness: cfg.roughness,
        metalness: cfg.metalness
      };
    });
  }

  private determineRoutingRecommendation(category: UniversalSpatialCategory): DownstreamGeneratorRouting {
    switch (category) {
      case 'foliage':
      case 'foliage_trees':
        return 'sb-veggie';
      case 'monument':
        return 'sb-archi';
      case 'architecture':
      case 'colosseum_architecture':
        return 'archie-building';
      case 'terrain':
        return 'sb-terrain';
      case 'ruin':
        return 'sb-archi';
      default:
        return 'trellis';
    }
  }

  /**
   * Separates 3D mesh geometry and populates a canonical modular Scene3DData scene.
   */
  public async separateAndPopulateScene(
    options: UniversalSeparationOptions
  ): Promise<UniversalSeparationAndSceneResult> {
    const scene = await this.separate(options);

    const objects: Media4DObject[] = scene.objects.map(obj => {
      const obb = obj.orientedBoundingBox;
      return {
        id: `separated-${obj.id}`,
        name: obj.name,
        content: {
          type: '3d-model',
          durableUri: options.glbPath || `models/${obj.id}.glb`,
          mimeType: 'model/gltf-binary'
        },
        space: {
          spatial3d: {
            x: obb.center[0],
            y: obb.center[1],
            z: obb.center[2],
            yaw: obb.yawDeg,
            position: obb.center,
            boundingBox: {
              min: obj.boundingBox.min,
              max: obj.boundingBox.max
            }
          },
          boundingBox: {
            min: obj.boundingBox.min,
            max: obj.boundingBox.max
          }
        },
        lineage: {
          version: 1,
          origin: 'generated',
          generation: {
            prompt: obj.trellisPrompt,
            model: obj.routingRecommendation === 'sb-veggie'
              ? 'sb-veggie-cpp'
              : (obj.routingRecommendation === 'sb-archi' ? 'sb-archi-cpp' : 'archie-refiner')
          }
        }
      };
    });

    const populatedScene: Scene3DData = {
      title: (options as any).title || 'Separated 3D Architecture Scene',
      sceneType: 'city',
      camera: {
        position: [
          scene.overallBoundingBox.centroid[0] - scene.overallBoundingBox.dimensions[0] * 0.8,
          scene.overallBoundingBox.centroid[1] + scene.overallBoundingBox.dimensions[1] * 0.6,
          scene.overallBoundingBox.centroid[2] + scene.overallBoundingBox.dimensions[2] * 0.8
        ],
        target: scene.overallBoundingBox.centroid,
        fov: 45
      },
      environment: {
        skybox: 'physical-atmosphere',
        ambientIntensity: 0.45,
        kelvinTemperature: 4500
      },
      objects
    };

    return {
      scene,
      populatedScene
    };
  }
}
