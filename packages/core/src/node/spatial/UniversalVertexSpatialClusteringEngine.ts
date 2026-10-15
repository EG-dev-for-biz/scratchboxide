/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Universal Vertex Spatial Clustering Engine
 * Decomposes continuous real-world 3D triangle soups (Google 3D Tiles, photogrammetry)
 * at the vertex and surface-normal level into discrete semantic entities:
 * 1. Terrain Ground Apron & Plaza Datum
 * 2. Discrete Architectural Buildings & Facade Envelopes
 * 3. Urban Infrastructure & Ground-level Props
 * It does not separate trees: from geometry alone a crown cannot be told from facade relief or a rooftop unit. Trees
 * are measured from the photo tiles (tile_vegetation, through google_3d_tiles_get_clay). Nor vehicles (a car-sized box
 * near the ground is as often a kiosk or a lump of drape), nor what a structure is: the structure at the anchor is
 * named only from what the caller says stands there, and buildings are described by their measured size.
 ********************************************************************************/

import type {
  UniversalSpatialCategory,
  DownstreamGeneratorRouting
} from './Universal3DObjectSeparationService';

export interface SubmeshGeometryInput {
  submeshIndex: number;
  min: [number, number, number];
  max: [number, number, number];
  count: number;
  positions: Float32Array | null;
  indices?: Uint16Array | Uint32Array | null;
  normals?: Float32Array | null;
  uvs?: Float32Array | null;
}

export interface VertexClusteringOptions {
  granularity?: 'macro' | 'detailed' | 'total' | 'all';
  minVerticesPerEntity?: number;
  buildingMinHeightMeters?: number;
  gridCellSizeMeters?: number;
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
  geoAnchor?: {
    name?: string;
    lat?: number;
    lng?: number;
    altitudeMeters?: number;
  };
}

export interface DecomposedCluster {
  id: string;
  name: string;
  category: UniversalSpatialCategory;
  submeshIndices: number[];
  extractedVertices: [number, number, number][];
  /** Submesh-local vertex indices (paired element-wise with `vertexSubmeshIndices`). */
  vertexIndices?: number[];
  /** glTF mesh index owning each entry of `vertexIndices`, making multi-submesh assignment unambiguous. */
  vertexSubmeshIndices?: number[];
  colorHex: string;
  prompt: string;
  roughness: number;
  metalness: number;
  routingRecommendation?: DownstreamGeneratorRouting;
  buildingMetadata?: {
    heightMeters: number;
    footprintM2: number;
  };
  vehicleMetadata?: {
    vehicleType: 'sedan' | 'suv' | 'van_truck' | 'compact';
    lengthMeters: number;
    widthMeters: number;
    heightMeters: number;
    headingDeg: number;
    groundElevationMeters: number;
    estimatedWheelbaseMeters?: number;
  };
  landmarkMetadata?: {
    landmarkType: 'triumphal_arch' | 'obelisk_spire' | 'amphitheatre' | 'historic_monument' | 'sculptural_focal_point' | (string & {});
    historicName: string;
    architecturalStyle: string;
    prominenceRatio: number;
    portalPassageDimensions?: [number, number, number];
  };
}

interface VertexRecord {
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
  u?: number;
  v?: number;
  vertexIndex: number;
  submeshIndex: number;
  tag: 'unassigned' | 'terrain' | 'landmark' | 'building' | 'prop';
}

export class UniversalVertexSpatialClusteringEngine {
  /**
   * Decomposes arbitrary 3D submesh geometry at vertex resolution into the ground, the structure at the anchor,
   * building envelopes and the remainder. It names nothing geometry cannot show: no trees, no vehicles, no styles.
   */
  public static decompose(
    submeshes: SubmeshGeometryInput[],
    overallMin: [number, number, number],
    overallMax: [number, number, number],
    options?: VertexClusteringOptions
  ): DecomposedCluster[] {
    const totalHeight = Math.max(1.0, overallMax[1] - overallMin[1]);
    const totalWidth = Math.max(1.0, overallMax[0] - overallMin[0]);
    const totalDepth = Math.max(1.0, overallMax[2] - overallMin[2]);
    const granularity: string = options?.granularity || 'detailed';
    if (granularity === 'trees') {
      throw new Error("UniversalVertexSpatialClusteringEngine: granularity 'trees' has been removed. Geometry alone cannot tell a tree crown from facade relief or a rooftop unit, so this engine names no trees; google_3d_tiles_get_clay measures a location's trees from its photo tiles (colour, roughness and height above the ground) and rebuilds them as SB-Veggie trees.");
    }

    // 1. Gather all vertices with computed/extracted surface normals
    const allVertices: VertexRecord[] = [];

    for (const sm of submeshes) {
      if (!sm.positions || sm.count === 0) continue;
      const pos = sm.positions;
      const numV = sm.count;
      const normals = sm.normals;
      const indices = sm.indices;

      // Compute vertex normals if missing and indices exist
      let computedNormals: Float32Array | null = null;
      if (!normals && indices && indices.length >= 3) {
        computedNormals = new Float32Array(numV * 3);
        const triCount = Math.floor(indices.length / 3);
        const triStep = Math.max(1, Math.floor(triCount / 25000));
        for (let t = 0; t < triCount; t += triStep) {
          const i0 = indices[t * 3]!;
          const i1 = indices[t * 3 + 1]!;
          const i2 = indices[t * 3 + 2]!;
          if (i0 >= numV || i1 >= numV || i2 >= numV) continue;

          const ax = pos[i1 * 3]! - pos[i0 * 3]!;
          const ay = pos[i1 * 3 + 1]! - pos[i0 * 3 + 1]!;
          const az = pos[i1 * 3 + 2]! - pos[i0 * 3 + 2]!;

          const bx = pos[i2 * 3]! - pos[i0 * 3]!;
          const by = pos[i2 * 3 + 1]! - pos[i0 * 3 + 1]!;
          const bz = pos[i2 * 3 + 2]! - pos[i0 * 3 + 2]!;

          // Cross product
          const nx = ay * bz - az * by;
          const ny = az * bx - ax * bz;
          const nz = ax * by - ay * bx;

          // Accumulate area-weighted normal
          for (const idx of [i0, i1, i2]) {
            computedNormals[idx * 3] += nx;
            computedNormals[idx * 3 + 1] += ny;
            computedNormals[idx * 3 + 2] += nz;
          }
        }

        // Normalize
        for (let v = 0; v < numV; v++) {
          const nx = computedNormals[v * 3]!;
          const ny = computedNormals[v * 3 + 1]!;
          const nz = computedNormals[v * 3 + 2]!;
          const len = Math.hypot(nx, ny, nz);
          if (len > 1e-6) {
            computedNormals[v * 3] /= len;
            computedNormals[v * 3 + 1] /= len;
            computedNormals[v * 3 + 2] /= len;
          } else {
            computedNormals[v * 3 + 1] = 1.0; // Upward default
          }
        }
      }

      // Sampling step to keep runtime sub-50ms on huge point sets
      const step = Math.max(1, Math.floor(numV / 12000));
      for (let i = 0; i < numV; i += step) {
        const x = pos[i * 3]!;
        const y = pos[i * 3 + 1]!;
        const z = pos[i * 3 + 2]!;

        let nx = 0, ny = 1, nz = 0;
        if (normals) {
          nx = normals[i * 3] || 0;
          ny = normals[i * 3 + 1] || 1;
          nz = normals[i * 3 + 2] || 0;
        } else if (computedNormals) {
          nx = computedNormals[i * 3] || 0;
          ny = computedNormals[i * 3 + 1] || 1;
          nz = computedNormals[i * 3 + 2] || 0;
        }

        const u = sm.uvs ? sm.uvs[i * 2] || 0 : 0;
        const v = sm.uvs ? sm.uvs[i * 2 + 1] || 0 : 0;

        allVertices.push({
          x, y, z,
          nx, ny, nz,
          u, v,
          vertexIndex: i,
          submeshIndex: sm.submeshIndex,
          tag: 'unassigned'
        });
      }
    }

    if (allVertices.length === 0) {
      return [];
    }

    // 2. Determine ground datum elevation
    // Sample lowest upward-facing vertices (ny >= 0.70)
    const upwardY = allVertices
      .filter(v => v.ny >= 0.70)
      .map(v => v.y)
      .sort((a, b) => a - b);
    
    const groundDatumY = upwardY.length > 10
      ? upwardY[Math.floor(upwardY.length * 0.05)]!
      : overallMin[1];

    const clusters: DecomposedCluster[] = [];

    // 3. Stage 1: Terrain Ground Apron & Plaza Datum
    const terrainVerts: VertexRecord[] = [];
    for (const v of allVertices) {
      const h = v.y - groundDatumY;
      if (h <= 1.8 && v.ny >= 0.60) {
        v.tag = 'terrain';
        terrainVerts.push(v);
      }
    }

    if (terrainVerts.length > 0) {
      const submeshSet = new Set(terrainVerts.map(v => v.submeshIndex));
      clusters.push({
        id: 'sep-terrain-ground-datum',
        name: 'Terrain Ground Apron & Plaza Datum',
        category: 'terrain',
        submeshIndices: Array.from(submeshSet),
        extractedVertices: terrainVerts.map(v => [v.x, v.y, v.z]),
        vertexIndices: terrainVerts.map(v => v.vertexIndex),
        vertexSubmeshIndices: terrainVerts.map(v => v.submeshIndex),
        colorHex: '#64748b',
        prompt: 'Pedestrian ground pavement and geological apron datum with tactile surface materials',
        roughness: 0.90,
        metalness: 0.04,
        routingRecommendation: 'sb-terrain'
      });
    }

    // 4. Stage 1.5: The structure at the anchor, only where the caller says it stands (focalInterestBounds). Without
    // bounds there is no such stage: a fixed box at the origin (it used to be the Washington Square Arch's footprint
    // and height) cuts whatever stands there, of whatever size, and calls it the landmark. Missing horizontal limits
    // are unbounded, and so is the height (never cut through a building's top).
    const focal = options?.focalInterestBounds;
    const focalMinX = focal?.minX ?? -Infinity;
    const focalMaxX = focal?.maxX ?? Infinity;
    const focalMinZ = focal?.minZ ?? -Infinity;
    const focalMaxZ = focal?.maxZ ?? Infinity;
    const focalMinH = focal?.minH ?? 0.5;
    const focalMaxH = focal?.maxH ?? Infinity;

    const landmarkCandidates = !focal ? [] : allVertices.filter(v => {
      if (v.tag !== 'unassigned') return false;
      const h = v.y - groundDatumY;
      return v.x >= focalMinX && v.x <= focalMaxX &&
             v.z >= focalMinZ && v.z <= focalMaxZ &&
             h >= focalMinH && h <= focalMaxH;
    });

    if (landmarkCandidates.length >= 25) {
      for (const v of landmarkCandidates) v.tag = 'landmark';
      const submeshSet = new Set(landmarkCandidates.map(v => v.submeshIndex));

      // Named only from what the caller says stands at the anchor (landmarkName, landmarkType, architecturalStyle):
      // geometry alone does not say what a structure is, and no name or description is guessed from a model name.
      let lMinX = Infinity, lMaxX = -Infinity, lMinY = Infinity, lMaxY = -Infinity, lMinZ = Infinity, lMaxZ = -Infinity;
      for (const v of landmarkCandidates) {
        lMinX = Math.min(lMinX, v.x); lMaxX = Math.max(lMaxX, v.x);
        lMinY = Math.min(lMinY, v.y); lMaxY = Math.max(lMaxY, v.y);
        lMinZ = Math.min(lMinZ, v.z); lMaxZ = Math.max(lMaxZ, v.z);
      }
      const measured = `${(lMaxX - lMinX).toFixed(1)} m x ${(lMaxZ - lMinZ).toFixed(1)} m, ${(lMaxY - lMinY).toFixed(1)} m tall`;
      const landmarkId = options?.landmarkName
        ? `landmark-${options.landmarkName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
        : 'landmark-anchor-structure';
      const landmarkName = options?.landmarkName || 'Structure at the anchor';
      const landmarkType = options?.landmarkType || 'structure';
      const architecturalStyle = options?.architecturalStyle || '';
      const described = [options?.landmarkName, options?.architecturalStyle].filter(Boolean).join(', ');
      const landmarkPrompt = `${described || 'Structure at the anchor'} (${measured})`;

      clusters.push({
        id: landmarkId,
        name: landmarkName,
        category: 'landmark',
        submeshIndices: Array.from(submeshSet),
        extractedVertices: landmarkCandidates.map(v => [v.x, v.y, v.z]),
        vertexIndices: landmarkCandidates.map(v => v.vertexIndex),
        vertexSubmeshIndices: landmarkCandidates.map(v => v.submeshIndex),
        colorHex: '#e11d48',
        prompt: landmarkPrompt,
        roughness: 0.82,
        metalness: 0.03,
        routingRecommendation: 'sb-archi',
        landmarkMetadata: {
          landmarkType,
          historicName: landmarkName,
          architecturalStyle,
          prominenceRatio: 1.0
        }
      });
    }

    // 5. No tree stage. Local height peaks with scattered normals are as often facade relief, cornices or rooftop
    //    units as crowns (on the Flatiron extraction such a stage named 359 peaks trees, among them 30 m facades, and
    //    gave each a species from its aspect ratio); nothing here can tell them apart, so nothing is called a tree.

    // 6. No vehicle stage. A box of the right size near the ground is as often a kiosk, a planter, a parked trailer or
    //    a lump of the scan's drape as a car (on the Flatiron extraction such a stage, with a street corridor fixed in
    //    the Colosseum's frame, named 35 "Commercial Delivery Van" / "Urban SUV" / "Passenger Sedan" clusters by their
    //    box sizes); nothing here can tell them apart, so nothing is called a vehicle.

    // 7. Stage 3: Building Structures & Architectural Facades
    // Vertices that are vertical (|ny| <= 0.40) or elevated roof surfaces (h > 4.0m)
    const buildingCandidates: VertexRecord[] = [];
    for (const v of allVertices) {
      if (v.tag !== 'unassigned') continue;
      const h = v.y - groundDatumY;
      if (h >= 2.0 && (Math.abs(v.ny) <= 0.45 || h >= 5.0)) {
        buildingCandidates.push(v);
      }
    }

    // Spatial clustering of building candidates on XZ plane (cell size ~3.6m)
    const bldGrid = new Map<string, VertexRecord[]>();
    const bldCellSize = 3.6;

    for (const v of buildingCandidates) {
      const gx = Math.floor(v.x / bldCellSize);
      const gz = Math.floor(v.z / bldCellSize);
      const key = `${gx}_${gz}`;
      let cell = bldGrid.get(key);
      if (!cell) {
        cell = [];
        bldGrid.set(key, cell);
      }
      cell.push(v);
    }

    // Connected components across adjacent cells
    const visitedKeys = new Set<string>();
    let bldCounter = 1;

    bldGrid.forEach((_pts, startKey) => {
      if (visitedKeys.has(startKey)) return;

      const clusterVerts: VertexRecord[] = [];
      const queue: string[] = [startKey];
      visitedKeys.add(startKey);

      while (queue.length > 0) {
        const curKey = queue.pop()!;
        const pts = bldGrid.get(curKey);
        if (pts) {
          for (const p of pts) {
            p.tag = 'building';
            clusterVerts.push(p);
          }
        }

        const [cxStr, czStr] = curKey.split('_');
        const cx = parseInt(cxStr!, 10);
        const cz = parseInt(czStr!, 10);

        for (let dx = -1; dx <= 1; dx++) {
          for (let dz = -1; dz <= 1; dz++) {
            if (dx === 0 && dz === 0) continue;
            const nKey = `${cx + dx}_${cz + dz}`;
            if (bldGrid.has(nKey) && !visitedKeys.has(nKey)) {
              visitedKeys.add(nKey);
              queue.push(nKey);
            }
          }
        }
      }

      if (clusterVerts.length >= 20) {
        let bMinY = Infinity, bMaxY = -Infinity;
        let bMinX = Infinity, bMaxX = -Infinity;
        let bMinZ = Infinity, bMaxZ = -Infinity;
        const submeshSet = new Set<number>();

        for (const p of clusterVerts) {
          if (p.x < bMinX) bMinX = p.x;
          if (p.x > bMaxX) bMaxX = p.x;
          if (p.y < bMinY) bMinY = p.y;
          if (p.y > bMaxY) bMaxY = p.y;
          if (p.z < bMinZ) bMinZ = p.z;
          if (p.z > bMaxZ) bMaxZ = p.z;
          submeshSet.add(p.submeshIndex);
        }

        const bHeight = bMaxY - bMinY;
        const bWidth = bMaxX - bMinX;
        const bDepth = bMaxZ - bMinZ;
        const footprintM2 = bWidth * bDepth;

        const category: UniversalSpatialCategory = 'architecture';
        // named and described by what was measured: its use and style are not in the geometry
        const bName = `Building Envelope #${bldCounter}`;

        clusters.push({
          id: `arch-building-${String(bldCounter).padStart(3, '0')}`,
          name: bName,
          category,
          submeshIndices: Array.from(submeshSet),
          extractedVertices: clusterVerts.map(v => [v.x, v.y, v.z]),
          vertexIndices: clusterVerts.map(v => v.vertexIndex),
          vertexSubmeshIndices: clusterVerts.map(v => v.submeshIndex),
          colorHex: '#38bdf8',
          prompt: `Building envelope, ${bWidth.toFixed(1)} m x ${bDepth.toFixed(1)} m footprint, ${bHeight.toFixed(1)} m tall`,
          roughness: 0.85,
          metalness: 0.02,
          routingRecommendation: 'archie-building',
          buildingMetadata: {
            heightMeters: bHeight,
            footprintM2
          }
        });

        bldCounter++;
      }
    });

    // 6. Stage 4: Urban Infrastructure & Ground Props (Residuals)
    const residualVerts = allVertices.filter(v => v.tag === 'unassigned');
    if (residualVerts.length >= 10) {
      const submeshSet = new Set(residualVerts.map(v => v.submeshIndex));
      clusters.push({
        id: 'infra-urban-props',
        name: 'Ground Urban Infrastructure & Peripheral Props',
        category: 'urban_infrastructure',
        submeshIndices: Array.from(submeshSet),
        extractedVertices: residualVerts.map(v => [v.x, v.y, v.z]),
        vertexIndices: residualVerts.map(v => v.vertexIndex),
        vertexSubmeshIndices: residualVerts.map(v => v.submeshIndex),
        colorHex: '#f59e0b',
        prompt: 'Pedestrian street furniture, bollards, curbs, and surrounding urban infrastructure elements',
        roughness: 0.88,
        metalness: 0.05,
        routingRecommendation: 'archie-building'
      });
    }

    return clusters;
  }
}
