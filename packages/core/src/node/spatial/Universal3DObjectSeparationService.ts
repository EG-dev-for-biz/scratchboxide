/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Universal 3D Object Separation Pipeline Service
 * Decomposes arbitrary real-world 3D meshes (Google 3D Tiles, photogrammetry,
 * CAD models) into discrete spatial entities with tight ground-constrained
 * Oriented Bounding Boxes (OBBs), schema-guided semantic categories, and
 * downstream generator routing (SB-Archi, SB-Veggie, Archie-Building, SB-Terrain).
 ********************************************************************************/

import * as fs from 'fs';
import * as path from 'path';
import {
  OrientedBoundingBoxSolver,
  type OrientedBoundingBox3D,
  type DualBoundingBoxResult
} from './OrientedBoundingBoxSolver';
import {
  UniversalVertexSpatialClusteringEngine,
  vertexSampleStride,
  type SubmeshGeometryInput,
  type DecomposedCluster
} from './UniversalVertexSpatialClusteringEngine';
import type { Scene3DData, Media4DObject } from '../../browser/generative-canvas/canvas-types';
import { GltfBinaryPacker } from '../3d-engine/gltf-binary-packer';

export type UniversalSpatialCategory =
  | 'landmark'
  | 'vehicle'
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
  | 'sb-vehicle'
  | 'archie-building'
  | 'sb-terrain'
  | 'trellis'
  | 'triposr';

export interface VehicleMetadata {
  vehicleType: 'sedan' | 'suv' | 'van_truck' | 'compact';
  lengthMeters: number;
  widthMeters: number;
  heightMeters: number;
  headingDeg: number;
  groundElevationMeters: number;
  estimatedWheelbaseMeters?: number;
}

export interface LandmarkMetadata {
  landmarkType: 'triumphal_arch' | 'obelisk_spire' | 'amphitheatre' | 'historic_monument' | 'sculptural_focal_point' | (string & {});
  historicName: string;
  architecturalStyle: string;
  prominenceRatio: number;
  portalPassageDimensions?: [number, number, number];
}

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
  /** Vertices the object owns. Omitted when its vertices were only sampled (see sampledVertexCount). */
  vertexCount?: number;
  /** Triangles the object owns (for vertex clusters: triangles whose three vertices are all in it). Omitted when sampled. */
  triangleCount?: number;
  /** Set instead of vertexCount/triangleCount when the clustering sampled the source vertices: how many it kept. */
  sampledVertexCount?: number;
  submeshIndices: number[];
  vertexIndices?: number[];
  extractedVertices?: [number, number, number][];
  colorHex: string;
  trellisPrompt: string;
  routingRecommendation?: DownstreamGeneratorRouting;
  material: {
    roughness: number;
    metalness: number;
    baseColor: string;
  };
  treeMetadata?: any;
  buildingMetadata?: any;
  vehicleMetadata?: VehicleMetadata;
  landmarkMetadata?: LandmarkMetadata;
}

export interface UniversalSeparatedScene {
  modelName: string;
  totalVertices: number;
  totalSubmeshes: number;
  overallBoundingBox: BoundingBox3DMetric;
  overallOrientedBoundingBox?: OrientedBoundingBox3D;
  objects: UniversalSeparatedObject[];
  granularityMode: 'macro' | 'detailed' | 'total' | 'all';
  timestamp: string;
  sourceAssetPath?: string;
  geoAnchor?: {
    name: string;
    lat: number;
    lng: number;
    altitudeMeters: number;
  };
  objectCounts?: Record<string, number>;
  totalEntities: number;
  overallVertexCount: number;
  categoryCounts: Record<string, number>;
}

export interface UniversalSeparationOptions {
  glbPath?: string;
  glbBuffer?: Buffer;
  granularity?: 'macro' | 'detailed' | 'total' | 'all';
  autoDetectSemanticCategories?: boolean;
  enableVertexClustering?: boolean;
  minVerticesPerEntity?: number;
  clusterDistance?: number;
  mode?: string;
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
  focalInterestBounds?: {
    minX?: number;
    maxX?: number;
    minZ?: number;
    maxZ?: number;
    minH?: number;
    maxH?: number;
  };
  landmarkName?: string;
  landmarkType?: 'triumphal_arch' | 'obelisk_spire' | 'amphitheatre' | 'historic_monument' | 'sculptural_focal_point' | (string & {});
  architecturalStyle?: string;
  modelName?: string;
  outputGlbPath?: string;
  localUvProjection?: boolean;
  facadeUvScale?: number;
  /**
   * When true, each separated object carries its raw `extractedVertices` point list.
   * Off by default: the point lists are large and bloat serialized/JSON payloads.
   */
  includeExtractedVertices?: boolean;
}

export interface PartAwareGlbResult {
  glbBuffer: Buffer;
  scene: UniversalSeparatedScene;
  materialCount: number;
  primitiveCount: number;
  entityCount: number;
  outputPath?: string;
}

export interface UniversalSeparationAndSceneResult {
  scene: UniversalSeparatedScene;
  populatedScene: Scene3DData;
}

export class Universal3DObjectSeparationService {
  /**
   * Synchronous / static bridge to separate an arbitrary 3D model (GLB buffer or path).
   */
  public static separate3DMesh(
    glbInput: Buffer | string,
    options?: Partial<UniversalSeparationOptions>
  ): UniversalSeparatedScene {
    const service = new Universal3DObjectSeparationService();
    const opts: UniversalSeparationOptions = {
      glbBuffer: Buffer.isBuffer(glbInput) ? glbInput : (options?.glbBuffer ?? undefined),
      glbPath: typeof glbInput === 'string' ? glbInput : options?.glbPath,
      clusterDistance: options?.clusterDistance ?? 1.5,
      ...options
    };
    return service.separateSync(opts);
  }

  /**
   * Separates an arbitrary 3D model (GLB buffer or path) into discrete 3D spatial entities.
   */
  public async separate(options: UniversalSeparationOptions): Promise<UniversalSeparatedScene> {
    return this.separateSync(options);
  }

  /**
   * Synchronous core separation implementation.
   */
  public separateSync(options: UniversalSeparationOptions): UniversalSeparatedScene {
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

    const submeshData: SubmeshGeometryInput[] = [];

    let totalVertices = 0;
    const overallMin: [number, number, number] = [Infinity, Infinity, Infinity];
    const overallMax: [number, number, number] = [-Infinity, -Infinity, -Infinity];

    const getAccessorData = (accIndex?: number): Float32Array | null => {
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

    const getAccessorIndices = (accIndex?: number): Uint16Array | Uint32Array | null => {
      if (accIndex === undefined || accIndex === null) return null;
      const acc = gltf.accessors?.[accIndex];
      if (!acc || acc.bufferView === undefined) return null;
      const bv = gltf.bufferViews[acc.bufferView];
      const offset = binOffset + (bv.byteOffset || 0) + (acc.byteOffset || 0);
      const count = acc.count || 0;
      if (acc.componentType === 5123) {
        return new Uint16Array(buffer.buffer, buffer.byteOffset + offset, count);
      } else if (acc.componentType === 5125) {
        return new Uint32Array(buffer.buffer, buffer.byteOffset + offset, count);
      } else if (acc.componentType === 5121) {
        // UNSIGNED_BYTE indices (common in Google 3D Tiles): widen so they are not mistaken for a non-indexed mesh.
        return Uint16Array.from(new Uint8Array(buffer.buffer, buffer.byteOffset + offset, count));
      }
      return null;
    };

    const getAccessorVec2 = (accIndex?: number): Float32Array | null => {
      if (accIndex === undefined || accIndex === null) return null;
      const acc = gltf.accessors?.[accIndex];
      if (!acc || acc.bufferView === undefined) return null;
      const bv = gltf.bufferViews[acc.bufferView];
      const offset = binOffset + (bv.byteOffset || 0) + (acc.byteOffset || 0);
      const count = acc.count || 0;
      if (acc.componentType === 5126 && acc.type === 'VEC2') {
        return new Float32Array(buffer.buffer, buffer.byteOffset + offset, count * 2);
      }
      return null;
    };

    if (gltf.meshes && Array.isArray(gltf.meshes)) {
      for (let mIdx = 0; mIdx < gltf.meshes.length; mIdx++) {
        const mesh = gltf.meshes[mIdx];
        const prim = mesh.primitives?.[0];
        if (!prim || prim.attributes?.POSITION === undefined) continue;

        const posAccIdx = prim.attributes.POSITION;
        const normAccIdx = prim.attributes.NORMAL;
        const uvAccIdx = prim.attributes.TEXCOORD_0;
        const indicesAccIdx = prim.indices;

        const acc = gltf.accessors[posAccIdx];
        if (!acc || !acc.min || !acc.max) continue;

        const count = acc.count || 0;
        totalVertices += count;

        const min: [number, number, number] = [acc.min[0], acc.min[1], acc.min[2]];
        const max: [number, number, number] = [acc.max[0], acc.max[1], acc.max[2]];
        const positions = getAccessorData(posAccIdx);
        const normals = getAccessorData(normAccIdx);
        const uvs = getAccessorVec2(uvAccIdx);
        const indices = getAccessorIndices(indicesAccIdx);

        submeshData.push({
          min,
          max,
          count,
          positions,
          indices,
          normals,
          uvs,
          submeshIndex: mIdx
        });

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

    // Partition submeshes or vertices into semantic entity clusters
    const useVertexClustering = (options.granularity && options.granularity !== 'macro') || options.enableVertexClustering === true;

    let clusters: {
      id: string;
      name: string;
      category: UniversalSpatialCategory;
      submeshIndices: number[];
      extractedVertices: [number, number, number][];
      vertexIndices?: number[];
      vertexSubmeshIndices?: number[];
      colorHex: string;
      prompt: string;
      roughness: number;
      metalness: number;
      routingRecommendation?: DownstreamGeneratorRouting;
      treeMetadata?: any;
      buildingMetadata?: any;
    }[] = [];

    if (useVertexClustering) {
      clusters = UniversalVertexSpatialClusteringEngine.decompose(
        submeshData,
        overallMin,
        overallMax,
        {
          granularity: options.granularity,
          minVerticesPerEntity: options.minVerticesPerEntity,
          focalInterestBounds: options.focalInterestBounds,
          landmarkName: options.landmarkName,
          landmarkType: options.landmarkType,
          architecturalStyle: options.architecturalStyle,
          modelName: options.modelName,
          geoAnchor: options.geoAnchor
        }
      );
    }

    if (clusters.length === 0) {
      clusters = this.clusterSubmeshes(submeshData, overallBoundingBox, options);
    }

    const objects: UniversalSeparatedObject[] = clusters.map(cluster => {
      const dualResult: DualBoundingBoxResult = OrientedBoundingBoxSolver.compute(cluster.extractedVertices);
      const aabb = dualResult.aabb;
      const obb = dualResult.obb;
      const counts = this.countClusterGeometry(cluster, submeshData);

      const routingRecommendation = cluster.routingRecommendation || this.determineRoutingRecommendation(cluster.category);

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
        ...counts,
        submeshIndices: cluster.submeshIndices,
        vertexIndices: cluster.vertexIndices,
        ...(options.includeExtractedVertices ? { extractedVertices: cluster.extractedVertices } : {}),
        colorHex: cluster.colorHex,
        trellisPrompt: cluster.prompt,
        routingRecommendation,
        material: {
          roughness: cluster.roughness,
          metalness: cluster.metalness,
          baseColor: cluster.colorHex
        },
        treeMetadata: (cluster as any).treeMetadata,
        buildingMetadata: (cluster as any).buildingMetadata,
        vehicleMetadata: (cluster as any).vehicleMetadata,
        landmarkMetadata: (cluster as any).landmarkMetadata
      };
    });

    this._lastSubmeshData = submeshData;
    // Submesh-qualified vertex ownership, aligned with `objects` by index (kept internal so
    // the public result stays compact).
    this._lastObjectVertexRefs = clusters.map(c =>
      c.vertexIndices && c.vertexSubmeshIndices && c.vertexSubmeshIndices.length === c.vertexIndices.length
        ? { submeshIndices: c.vertexSubmeshIndices, vertexIndices: c.vertexIndices }
        : undefined
    );

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
      objectCounts,
      totalEntities: objects.length,
      overallVertexCount: totalVertices,
      categoryCounts: objectCounts
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

    // Groups by bounding-box shape. A box shows size and height, not what a thing is, so each group is named for its
    // geometry: no monument, ruin or style is read from a size (a midtown block came back as a "classical monument"
    // and "ancient ruins").
    const terrainIndices: number[] = [];
    const tallIndices: number[] = [];
    const architectureIndices: number[] = [];
    const lowIndices: number[] = [];

    for (const sm of submeshes) {
      const idx = sm.submeshIndex;
      const [w, h, d] = [sm.max[0] - sm.min[0], sm.max[1] - sm.min[1], sm.max[2] - sm.min[2]];
      const centerY = (sm.min[1] + sm.max[1]) / 2;
      const relativeElevation = (centerY - groundDatumY) / (totalHeight || 1);
      const horizontalFootprint = Math.max(w, d);

      // Broad, low and near the bottom: ground surfaces
      if (h < 6.0 && horizontalFootprint > overallBox.dimensions[0] * 0.25) {
        terrainIndices.push(idx);
      }
      // (No vegetation heuristic: a bounding box cannot tell a crown from a kiosk or a rooftop unit. Trees are measured
      // from the photo tiles by tile_vegetation, through google_3d_tiles_get_clay.)
      // Low and near the ground
      else if (h >= 1.0 && h <= 8.0 && relativeElevation < 0.25) {
        lowIndices.push(idx);
      }
      // Tall and wide
      else if (h > 15.0 && (w > 20 || d > 20)) {
        tallIndices.push(idx);
      }
      else {
        architectureIndices.push(idx);
      }
    }

    // Only groups the shapes actually filled are reported: a submesh is never moved into a group just so that group
    // exists, and an empty group is not given the whole model's box.
    const clustersConfig = [
      {
        id: 'sep-tall-structures',
        name: 'Tall structures (over 15 m high, over 20 m across)',
        category: 'architecture' as UniversalSpatialCategory,
        indices: tallIndices,
        colorHex: '#3b82f6',
        prompt: 'Structure geometry from the scan, over 15 m high and over 20 m across',
        roughness: 0.85,
        metalness: 0.02
      },
      {
        id: 'sep-terrain-ground',
        name: 'Broad low surfaces (ground)',
        category: 'terrain' as UniversalSpatialCategory,
        indices: terrainIndices,
        colorHex: '#64748b',
        prompt: 'Broad low ground surface geometry from the scan',
        roughness: 0.90,
        metalness: 0.05
      }
    ];

    if (architectureIndices.length > 0) {
      clustersConfig.push({
        id: 'sep-other-structures',
        name: 'Other structures',
        category: 'architecture' as UniversalSpatialCategory,
        indices: architectureIndices,
        colorHex: '#fbbf24',
        prompt: 'Structure geometry from the scan',
        roughness: 0.82,
        metalness: 0.03
      });
    }

    if (lowIndices.length > 0) {
      clustersConfig.push({
        id: 'sep-low-structures',
        name: 'Low structures near the ground (1 to 8 m high)',
        category: 'architecture' as UniversalSpatialCategory,
        indices: lowIndices,
        colorHex: '#f97316',
        prompt: 'Structure geometry from the scan, 1 to 8 m high near the ground',
        roughness: 0.94,
        metalness: 0.01
      });
    }

    return clustersConfig.filter(cfg => cfg.indices.length > 0).map(cfg => {
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

  /**
   * Real vertex/triangle counts for a cluster. A submesh cluster owns whole submeshes; a vertex cluster owns the
   * listed vertices and the triangles whose three vertices it owns. When the vertex clustering sampled any of the
   * submeshes involved, only the sample size is reported.
   */
  private countClusterGeometry(
    cluster: { submeshIndices: number[]; extractedVertices: [number, number, number][]; vertexIndices?: number[]; vertexSubmeshIndices?: number[] },
    submeshes: SubmeshGeometryInput[]
  ): { vertexCount?: number; triangleCount?: number; sampledVertexCount?: number } {
    const bySubmesh = new Map(submeshes.map(sm => [sm.submeshIndex, sm]));
    const trianglesOf = (sm: SubmeshGeometryInput) => Math.floor((sm.indices ? sm.indices.length : sm.count) / 3);

    if (!cluster.vertexIndices || !cluster.vertexSubmeshIndices || cluster.vertexSubmeshIndices.length !== cluster.vertexIndices.length) {
      let vertexCount = 0;
      let triangleCount = 0;
      for (const idx of cluster.submeshIndices) {
        const sm = bySubmesh.get(idx);
        if (!sm) continue;
        vertexCount += sm.count;
        triangleCount += trianglesOf(sm);
      }
      return { vertexCount, triangleCount };
    }

    const owned = new Map<number, Set<number>>();
    for (let i = 0; i < cluster.vertexIndices.length; i++) {
      const smIdx = cluster.vertexSubmeshIndices[i]!;
      let set = owned.get(smIdx);
      if (!set) owned.set(smIdx, (set = new Set()));
      set.add(cluster.vertexIndices[i]!);
    }
    for (const smIdx of owned.keys()) {
      const sm = bySubmesh.get(smIdx);
      if (!sm || vertexSampleStride(sm.count) > 1) {
        return { sampledVertexCount: cluster.vertexIndices.length };
      }
    }
    let triangleCount = 0;
    for (const [smIdx, set] of owned) {
      const sm = bySubmesh.get(smIdx)!;
      const tris = trianglesOf(sm);
      for (let t = 0; t < tris; t++) {
        const i0 = sm.indices ? sm.indices[t * 3]! : t * 3;
        const i1 = sm.indices ? sm.indices[t * 3 + 1]! : t * 3 + 1;
        const i2 = sm.indices ? sm.indices[t * 3 + 2]! : t * 3 + 2;
        if (set.has(i0) && set.has(i1) && set.has(i2)) triangleCount++;
      }
    }
    return { vertexCount: cluster.vertexIndices.length, triangleCount };
  }

  private determineRoutingRecommendation(category: UniversalSpatialCategory): DownstreamGeneratorRouting {
    switch (category) {
      case 'landmark':
      case 'monument':
      case 'ruin':
        return 'sb-archi';
      case 'vehicle':
        return 'sb-vehicle';
      case 'foliage':
      case 'foliage_trees':
        return 'sb-veggie';
      case 'architecture':
      case 'colosseum_architecture':
      case 'urban_infrastructure':
        return 'archie-building';
      case 'terrain':
        return 'sb-terrain';
      case 'prop':
        // Discrete props can optionally use neural mesh diffusion if an asset model is needed
        return 'trellis';
      default:
        // Default to native architectural engine in codebase for all scene structures
        return 'sb-archi';
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

  private _lastSubmeshData?: SubmeshGeometryInput[];
  private _lastObjectVertexRefs?: ({ submeshIndices: number[]; vertexIndices: number[] } | undefined)[];

  /**
   * Partitions continuous 3D tile geometry into discrete glTF primitives with
   * independent PBR material slots and local OBB-conformal UV coordinates.
   * Completely eliminates texture shearing on diagonal facades and cross-domain
   * material bleeding across architecture, roads, vehicles, and foliage.
   */
  public static generatePartAwareGlb(options: UniversalSeparationOptions & {
    outputGlbPath?: string;
    localUvProjection?: boolean;
    facadeUvScale?: number;
  }): PartAwareGlbResult {
    const service = new Universal3DObjectSeparationService();
    return service.generatePartAwareGlb(options);
  }

  public generatePartAwareGlb(options: UniversalSeparationOptions & {
    outputGlbPath?: string;
    localUvProjection?: boolean;
    facadeUvScale?: number;
  }): PartAwareGlbResult {
    const scene = this.separateSync(options);
    const submeshData = this._lastSubmeshData || [];

    const hexToRgba = (hex: string, alpha = 1.0): [number, number, number, number] => {
      let clean = (hex || '#888888').replace('#', '');
      if (clean.length === 3) {
        clean = clean.split('').map(c => c + c).join('');
      }
      const num = parseInt(clean, 16);
      if (isNaN(num)) return [0.7, 0.7, 0.7, alpha];
      const r = ((num >> 16) & 255) / 255;
      const g = ((num >> 8) & 255) / 255;
      const b = (num & 255) / 255;
      return [Number(r.toFixed(4)), Number(g.toFixed(4)), Number(b.toFixed(4)), alpha];
    };

    const outGltf: any = {
      asset: {
        version: '2.0',
        generator: 'Scratchbox Part-Aware 3D Tile Pipeline'
      },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ name: 'SceneRoot', mesh: 0 }],
      meshes: [{ name: scene.modelName || 'Decomposed3DTile', primitives: [] }],
      materials: [],
      accessors: [],
      bufferViews: []
    };
    const bufferViewsArray: Buffer[] = [];

    const addBufferView = (buf: Buffer, isIndex: boolean): number => {
      const idx = bufferViewsArray.length;
      bufferViewsArray.push(buf);
      outGltf.bufferViews.push({
        buffer: 0,
        byteOffset: 0,
        byteLength: buf.length,
        target: isIndex ? 34963 : 34962
      });
      return idx;
    };

    const addAccessor = (
      bvIdx: number,
      compType: number,
      count: number,
      typeStr: string,
      minMax?: { min: number[]; max: number[] }
    ): number => {
      const idx = outGltf.accessors.length;
      outGltf.accessors.push({
        bufferView: bvIdx,
        byteOffset: 0,
        componentType: compType,
        count,
        type: typeStr,
        ...(minMax ? { min: minMax.min, max: minMax.max } : {})
      });
      return idx;
    };

    const hasLocalUv = options.localUvProjection !== false;
    const s = options.facadeUvScale ?? 0.25;

    const pushMaterial = (
      name: string,
      baseColor: string,
      roughness: number,
      metallic: number,
      extras: Record<string, unknown>
    ): number => {
      const [r, g, b, a] = hexToRgba(baseColor);
      outGltf.materials.push({
        name,
        pbrMetallicRoughness: {
          baseColorFactor: [r, g, b, a],
          roughnessFactor: roughness,
          metallicFactor: metallic
        },
        extras
      });
      return outGltf.materials.length - 1;
    };

    // One material per separated object (stable ordering: material i <-> scene.objects[i]).
    const objMaterialIdx: number[] = scene.objects.map(obj =>
      pushMaterial(
        `mat_${obj.category}_${obj.id}`,
        obj.material.baseColor || obj.colorHex,
        obj.material.roughness ?? 0.7,
        obj.material.metalness ?? 0.05,
        {
          category: obj.category,
          partId: obj.id,
          name: obj.name,
          routing: obj.routingRecommendation,
          obb: {
            center: obj.orientedBoundingBox.center,
            dimensions: obj.orientedBoundingBox.dimensions,
            yawDeg: obj.orientedBoundingBox.yawDeg
          }
        }
      )
    );

    // Residual bucket for triangles no object claims: reuse the clustering engine's residual
    // object when present, otherwise lazily create a dedicated residual material/primitive.
    const RESIDUAL_OBJECT_ID = 'infra-urban-props';
    const residualObjIdx = scene.objects.findIndex(o => o.id === RESIDUAL_OBJECT_ID);
    const RESIDUAL_SYNTHETIC = -2;
    const residualKey = residualObjIdx >= 0 ? residualObjIdx : RESIDUAL_SYNTHETIC;
    let syntheticResidualMatIdx = -1;

    // Per-object vertex ownership is qualified by glTF mesh index (submeshIndex), never array position.
    const vertexRefs = this._lastObjectVertexRefs || [];

    const computeVertexNormals = (pos: Float32Array | ArrayLike<number>, vCount: number, tris: ArrayLike<number>): Float32Array => {
      const n = new Float32Array(vCount * 3);
      for (let t = 0; t + 2 < tris.length; t += 3) {
        const i0 = tris[t]!, i1 = tris[t + 1]!, i2 = tris[t + 2]!;
        const ax = pos[i1 * 3]! - pos[i0 * 3]!, ay = pos[i1 * 3 + 1]! - pos[i0 * 3 + 1]!, az = pos[i1 * 3 + 2]! - pos[i0 * 3 + 2]!;
        const bx = pos[i2 * 3]! - pos[i0 * 3]!, by = pos[i2 * 3 + 1]! - pos[i0 * 3 + 1]!, bz = pos[i2 * 3 + 2]! - pos[i0 * 3 + 2]!;
        const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx; // area-weighted
        for (const vi of [i0, i1, i2]) {
          n[vi * 3] += nx; n[vi * 3 + 1] += ny; n[vi * 3 + 2] += nz;
        }
      }
      for (let v = 0; v < vCount; v++) {
        const len = Math.hypot(n[v * 3]!, n[v * 3 + 1]!, n[v * 3 + 2]!);
        if (len > 1e-12) {
          n[v * 3] /= len; n[v * 3 + 1] /= len; n[v * 3 + 2] /= len;
        } else {
          n[v * 3] = 0; n[v * 3 + 1] = 1; n[v * 3 + 2] = 0;
        }
      }
      return n;
    };

    const emitPrimitive = (
      sm: SubmeshGeometryInput,
      normals: Float32Array,
      tris: number[],
      obb: OrientedBoundingBox3D | null,
      matIdx: number
    ): void => {
      const pos = sm.positions!;
      const cosY = Math.cos(-(obb?.yawRad || 0));
      const sinY = Math.sin(-(obb?.yawRad || 0));
      const center = obb?.center ?? [0, 0, 0];

      const localMap = new Map<number, number>();
      const remapIndices: number[] = [];
      const partPositions: number[] = [];
      const partNormals: number[] = [];
      const partUvs: number[] = [];

      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

      for (const origVi of tris) {
        let newVi = localMap.get(origVi);
        if (newVi === undefined) {
          newVi = localMap.size;
          localMap.set(origVi, newVi);

          const px = pos[origVi * 3]!;
          const py = pos[origVi * 3 + 1]!;
          const pz = pos[origVi * 3 + 2]!;

          if (px < minX) minX = px; if (py < minY) minY = py; if (pz < minZ) minZ = pz;
          if (px > maxX) maxX = px; if (py > maxY) maxY = py; if (pz > maxZ) maxZ = pz;

          const nx = normals[origVi * 3]!;
          const ny = normals[origVi * 3 + 1]!;
          const nz = normals[origVi * 3 + 2]!;

          let u = 0, v = 0;
          if (hasLocalUv) {
            const dx = px - center[0];
            const dz = pz - center[2];
            const lx = dx * cosY - dz * sinY;
            const ly = py - center[1];
            const lz = dx * sinY + dz * cosY;

            const lnx = nx * cosY - nz * sinY;
            const lny = ny;
            const lnz = nx * sinY + nz * cosY;

            if (Math.abs(lny) >= 0.70) {
              u = lx * s;
              v = lz * s;
            } else if (Math.abs(lnx) > Math.abs(lnz)) {
              u = lz * s;
              v = ly * s;
            } else {
              u = lx * s;
              v = ly * s;
            }
          } else if (sm.uvs) {
            u = sm.uvs[origVi * 2]!;
            v = sm.uvs[origVi * 2 + 1]!;
          }

          partPositions.push(px, py, pz);
          partNormals.push(nx, ny, nz);
          partUvs.push(u, v);
        }
        remapIndices.push(newVi);
      }

      const partVCount = localMap.size;
      if (partVCount === 0) return;
      const posArr = new Float32Array(partPositions);
      const normArr = new Float32Array(partNormals);
      const uvArr = new Float32Array(partUvs);
      // 65535 is reserved (primitive restart) for UNSIGNED_SHORT, so switch to 32-bit above it.
      const idxArr: Uint16Array | Uint32Array = partVCount > 65535
        ? new Uint32Array(remapIndices)
        : new Uint16Array(remapIndices);
      const idxComponentType = idxArr instanceof Uint32Array ? 5125 : 5123;

      const posBv = addBufferView(Buffer.from(posArr.buffer, posArr.byteOffset, posArr.byteLength), false);
      const posAcc = addAccessor(posBv, 5126, partVCount, 'VEC3', { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] });

      const normBv = addBufferView(Buffer.from(normArr.buffer, normArr.byteOffset, normArr.byteLength), false);
      const normAcc = addAccessor(normBv, 5126, partVCount, 'VEC3');

      const uvBv = addBufferView(Buffer.from(uvArr.buffer, uvArr.byteOffset, uvArr.byteLength), false);
      const uvAcc = addAccessor(uvBv, 5126, partVCount, 'VEC2');

      const idxBv = addBufferView(Buffer.from(idxArr.buffer, idxArr.byteOffset, idxArr.byteLength), true);
      const idxAcc = addAccessor(idxBv, idxComponentType, idxArr.length, 'SCALAR');

      outGltf.meshes[0].primitives.push({
        attributes: {
          POSITION: posAcc,
          NORMAL: normAcc,
          TEXCOORD_0: uvAcc
        },
        indices: idxAcc,
        material: matIdx,
        mode: 4
      });
    };

    // Split every source submesh per triangle across the objects that own its vertices, so
    // each triangle is emitted exactly once (no duplicated geometry / z-fighting).
    for (const sm of submeshData) {
      if (!sm.positions || sm.positions.length === 0) continue;
      const smIdx = sm.submeshIndex;
      const vTotal = Math.floor(sm.positions.length / 3);

      const vertToObj = new Int32Array(vTotal).fill(-1);
      let wholeSubmeshOwner = -1;
      for (let oIdx = 0; oIdx < scene.objects.length; oIdx++) {
        const refs = vertexRefs[oIdx];
        if (refs) {
          for (let k = 0; k < refs.vertexIndices.length; k++) {
            if (refs.submeshIndices[k] !== smIdx) continue;
            const vi = refs.vertexIndices[k]!;
            if (vi >= 0 && vi < vTotal) vertToObj[vi] = oIdx;
          }
        } else if (wholeSubmeshOwner < 0 && scene.objects[oIdx]!.submeshIndices.includes(smIdx)) {
          // Submesh-granular clusters (macro mode) own their whole submesh; first claimant wins.
          wholeSubmeshOwner = oIdx;
        }
      }

      let triIndices: number[];
      if (sm.indices && sm.indices.length > 0) {
        triIndices = Array.from(sm.indices);
      } else {
        triIndices = [];
        for (let i = 0; i < vTotal; i++) triIndices.push(i);
      }

      const normals = sm.normals && sm.normals.length >= vTotal * 3
        ? sm.normals
        : computeVertexNormals(sm.positions, vTotal, triIndices);

      const objTris = new Map<number, number[]>();
      for (let t = 0; t + 2 < triIndices.length; t += 3) {
        const i0 = triIndices[t]!, i1 = triIndices[t + 1]!, i2 = triIndices[t + 2]!;
        if (i0 >= vTotal || i1 >= vTotal || i2 >= vTotal) continue;
        let assigned = vertToObj[i0]!;
        if (assigned < 0) assigned = vertToObj[i1]!;
        if (assigned < 0) assigned = vertToObj[i2]!;
        if (assigned < 0) assigned = wholeSubmeshOwner;
        if (assigned < 0) assigned = residualKey;

        let bucket = objTris.get(assigned);
        if (!bucket) { bucket = []; objTris.set(assigned, bucket); }
        bucket.push(i0, i1, i2);
      }

      for (const [key, tris] of objTris) {
        if (tris.length === 0) continue;
        if (key === RESIDUAL_SYNTHETIC) {
          if (syntheticResidualMatIdx < 0) {
            syntheticResidualMatIdx = pushMaterial('mat_residual_unassigned', '#9ca3af', 0.9, 0.0, {
              category: 'residual',
              partId: 'residual-unassigned',
              name: 'Unassigned Residual Geometry'
            });
          }
          emitPrimitive(sm, normals, tris, null, syntheticResidualMatIdx);
        } else {
          const obj = scene.objects[key]!;
          emitPrimitive(sm, normals, tris, obj.orientedBoundingBox, objMaterialIdx[key]!);
        }
      }
    }

    const packResult = GltfBinaryPacker.packGlb(outGltf, bufferViewsArray, true);
    if (options.outputGlbPath) {
      const dir = path.dirname(options.outputGlbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(options.outputGlbPath, packResult.glbBuffer);
    }

    return {
      glbBuffer: packResult.glbBuffer,
      scene,
      materialCount: outGltf.materials.length,
      primitiveCount: outGltf.meshes[0].primitives.length,
      entityCount: scene.objects.length,
      outputPath: options.outputGlbPath
    };
  }
}
