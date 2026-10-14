/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Universal Vertex Spatial Clustering Engine
 * Decomposes continuous real-world 3D triangle soups (Google 3D Tiles, photogrammetry)
 * at the vertex and surface-normal level into discrete semantic entities:
 * 1. Terrain Ground Apron & Plaza Datum
 * 2. Individual Botanical Trees (Crown Apex & Radial Watershed Clustering)
 * 3. Discrete Architectural Buildings & Facade Envelopes
 * 4. Urban Infrastructure & Ground-level Props
 ********************************************************************************/

import {
  OrientedBoundingBoxSolver,
  type DualBoundingBoxResult
} from './OrientedBoundingBoxSolver';
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
  granularity?: 'macro' | 'detailed' | 'total' | 'trees' | 'all';
  minVerticesPerEntity?: number;
  treeApexMinHeightMeters?: number;
  treeApexMaxHeightMeters?: number;
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
  treeMetadata?: {
    species: 'pinus_pinea' | 'quercus_ilex' | 'cupressus_sempervirens' | 'olea_europaea' | 'laurus_nobilis';
    scientificName: string;
    canopyHeightMeters: number;
    crownDiameterMeters: number;
    crownVolumeM3: number;
    groundElevationMeters: number;
  };
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
  tag: 'unassigned' | 'terrain' | 'tree' | 'landmark' | 'building' | 'vehicle' | 'prop';
}

export class UniversalVertexSpatialClusteringEngine {
  /**
   * Decomposes arbitrary 3D submesh geometry at vertex resolution into discrete
   * individual structures, trees, ground aprons, and urban objects.
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
    const granularity = options?.granularity || 'detailed';

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

    if (terrainVerts.length > 0 && granularity !== 'trees') {
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

    // 4. Stage 1.5: Primary Landmark / Focal Architecture Isolation
    // Detects iconic architectural landmarks or focal monuments centered around
    // the capture interest origin or focal coordinates
    const focalMinX = options?.focalInterestBounds?.minX ?? -16.5;
    const focalMaxX = options?.focalInterestBounds?.maxX ?? 16.5;
    const focalMinZ = options?.focalInterestBounds?.minZ ?? -8.5;
    const focalMaxZ = options?.focalInterestBounds?.maxZ ?? 8.5;
    const focalMinH = options?.focalInterestBounds?.minH ?? 0.5;
    const focalMaxH = options?.focalInterestBounds?.maxH ?? 25.5;

    const landmarkCandidates = allVertices.filter(v => {
      if (v.tag !== 'unassigned') return false;
      const h = v.y - groundDatumY;
      return v.x >= focalMinX && v.x <= focalMaxX &&
             v.z >= focalMinZ && v.z <= focalMaxZ &&
             h >= focalMinH && h <= focalMaxH;
    });

    if (landmarkCandidates.length >= 25 && granularity !== 'trees') {
      for (const v of landmarkCandidates) v.tag = 'landmark';
      const submeshSet = new Set(landmarkCandidates.map(v => v.submeshIndex));

      // Resolve landmark naming and metadata adaptively
      const isWashington =
        (options?.landmarkName && /washington/i.test(options.landmarkName)) ||
        (options?.modelName && /washington/i.test(options.modelName)) ||
        (options?.geoAnchor?.name && /washington/i.test(options.geoAnchor.name));

      const landmarkId = options?.landmarkName
        ? `landmark-${options.landmarkName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
        : (isWashington ? 'landmark-washington-arch' : 'landmark-primary-monument');

      const landmarkName = options?.landmarkName ||
        (isWashington ? 'Washington Square Arch (Primary Landmark)' : 'Central Monument (Primary Landmark)');

      const landmarkType = options?.landmarkType ||
        (isWashington ? 'triumphal_arch' : 'historic_monument');

      const architecturalStyle = options?.architecturalStyle ||
        (isWashington ? 'Neoclassical Roman Triumphal Arch' : 'Classical Monolithic Architecture');

      const landmarkPrompt = isWashington
        ? 'Neoclassical white Tuckahoe marble triumphal arch designed by Stanford White with triumphal friezes, spandrel allegorical figures, attic inscriptions, and central vaulted portal passage'
        : `Monumental ${architecturalStyle} structure with sculpted relief, monolithic massing, and architectural friezes`;

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
          prominenceRatio: 1.0,
          portalPassageDimensions: [focalMaxX - focalMinX, focalMaxH - focalMinH, focalMaxZ - focalMinZ]
        }
      });
    }

    // 5. Stage 2: Tree Apex Detection & Radial Canopy Extraction
    const treeApexMinH = options?.treeApexMinHeightMeters ?? 2.8;
    const treeApexMaxH = options?.treeApexMaxHeightMeters ?? 36.0;
    const cellSize = options?.gridCellSizeMeters ?? 2.8;

    // Build 2D spatial elevation grid for remaining candidate vertices
    const grid = new Map<string, {
      maxElevation: number;
      apexVertex: VertexRecord;
      points: VertexRecord[];
      gx: number;
      gz: number;
    }>();

    for (const v of allVertices) {
      if (v.tag !== 'unassigned') continue;
      const h = v.y - groundDatumY;
      if (h >= treeApexMinH && h <= treeApexMaxH) {
        const gx = Math.floor(v.x / cellSize);
        const gz = Math.floor(v.z / cellSize);
        const key = `${gx}_${gz}`;

        let cell = grid.get(key);
        if (!cell) {
          cell = { maxElevation: v.y, apexVertex: v, points: [], gx, gz };
          grid.set(key, cell);
        } else if (v.y > cell.maxElevation) {
          cell.maxElevation = v.y;
          cell.apexVertex = v;
        }
        cell.points.push(v);
      }
    }

    // Identify local maxima (Tree Apex Candidates)
    const apexCells: {
      apexVertex: VertexRecord;
      points: VertexRecord[];
      gx: number;
      gz: number;
      elevation: number;
    }[] = [];

    grid.forEach((cell, key) => {
      let isPeak = true;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          if (dx === 0 && dz === 0) continue;
          const neighborKey = `${cell.gx + dx}_${cell.gz + dz}`;
          const neighbor = grid.get(neighborKey);
          if (neighbor && neighbor.maxElevation > cell.maxElevation) {
            isPeak = false;
            break;
          }
        }
        if (!isPeak) break;
      }

      // Check that cell points have organic normal variance (not a flat horizontal rooftop)
      if (isPeak && cell.points.length >= 4) {
        const meanNy = cell.points.reduce((acc, p) => acc + p.ny, 0) / cell.points.length;
        // Flat roofs have meanNy close to 1.0; foliage has organic scattered normals
        const hasOrganicVariance = meanNy < 0.92;
        if (hasOrganicVariance) {
          apexCells.push({
            apexVertex: cell.apexVertex,
            points: cell.points,
            gx: cell.gx,
            gz: cell.gz,
            elevation: cell.maxElevation
          });
        }
      }
    });

    // Radial canopy watershed clustering from each apex
    let treeCounter = 1;
    for (const apex of apexCells) {
      const hApex = apex.elevation - groundDatumY;
      const crownRadius = Math.min(10.0, Math.max(2.2, hApex * 0.55));
      const crownBaseY = Math.max(groundDatumY + 1.2, apex.elevation - hApex * 0.85);
      const treePoints: VertexRecord[] = [];
      const submeshSet = new Set<number>();

      const radiusCells = Math.ceil(crownRadius / cellSize);
      for (let dx = -radiusCells; dx <= radiusCells; dx++) {
        for (let dz = -radiusCells; dz <= radiusCells; dz++) {
          const cellKey = `${apex.gx + dx}_${apex.gz + dz}`;
          const c = grid.get(cellKey);
          if (!c) continue;
          for (const v of c.points) {
            if (v.tag !== 'unassigned') continue;
            const dist2D = Math.hypot(v.x - apex.apexVertex.x, v.z - apex.apexVertex.z);
            if (dist2D <= crownRadius && v.y >= crownBaseY && v.y <= apex.elevation + 0.5) {
              v.tag = 'tree';
              treePoints.push(v);
              submeshSet.add(v.submeshIndex);
            }
          }
        }
      }

      if (treePoints.length >= 8) {
        let minX = Infinity, maxX = -Infinity;
        let minZ = Infinity, maxZ = -Infinity;
        for (const p of treePoints) {
          if (p.x < minX) minX = p.x;
          if (p.x > maxX) maxX = p.x;
          if (p.z < minZ) minZ = p.z;
          if (p.z > maxZ) maxZ = p.z;
        }

        const crownDiam = Math.max(2.0, Math.max(maxX - minX, maxZ - minZ));
        const canopyH = Math.max(3.0, apex.elevation - crownBaseY);
        const crownVol = (Math.PI / 6) * Math.pow(crownDiam, 2) * canopyH;
        const aspectRatio = canopyH / crownDiam;

        let species: 'pinus_pinea' | 'quercus_ilex' | 'cupressus_sempervirens' = 'quercus_ilex';
        let scientificName = 'Quercus ilex';
        let commonName = 'Mediterranean Holm Oak';

        if (aspectRatio > 2.0) {
          species = 'cupressus_sempervirens';
          scientificName = 'Cupressus sempervirens';
          commonName = 'Italian Columnar Cypress';
        } else if (aspectRatio < 0.90 && crownDiam >= 7.0) {
          species = 'pinus_pinea';
          scientificName = 'Pinus pinea';
          commonName = 'Italian Stone Pine';
        }

        clusters.push({
          id: `fol-tree-${String(treeCounter).padStart(3, '0')}`,
          name: `${commonName} #${treeCounter}`,
          category: 'foliage_trees',
          submeshIndices: Array.from(submeshSet),
          extractedVertices: treePoints.map(v => [v.x, v.y, v.z]),
          vertexIndices: treePoints.map(v => v.vertexIndex),
          vertexSubmeshIndices: treePoints.map(v => v.submeshIndex),
          colorHex: '#22c55e',
          prompt: `Photorealistic mature ${scientificName} (${commonName}) botanical tree with detailed canopy, crown diameter ${crownDiam.toFixed(1)}m, height ${canopyH.toFixed(1)}m`,
          roughness: 0.74,
          metalness: 0.0,
          routingRecommendation: 'sb-veggie',
          treeMetadata: {
            species,
            scientificName,
            canopyHeightMeters: canopyH,
            crownDiameterMeters: crownDiam,
            crownVolumeM3: crownVol,
            groundElevationMeters: groundDatumY
          }
        });

        treeCounter++;
      }
    }

    if (granularity === 'trees') {
      return clusters;
    }

    // 6. Stage 2.5: Ground-Level Vehicle & Car Extraction
    // Detects parked cars, delivery vans, SUVs, and passenger vehicles along street corridors
    const vehicleCandidates = allVertices.filter(v => {
      if (v.tag !== 'unassigned') return false;
      const h = v.y - groundDatumY;
      const inStreetCorridor = v.z <= -10.0 || v.z >= 40.0 || Math.abs(v.x) >= 40.0;
      return inStreetCorridor && h >= 0.25 && h <= 2.9;
    });

    const vGrid = new Map<string, VertexRecord[]>();
    const vCellSize = 1.35;

    for (const v of vehicleCandidates) {
      const gx = Math.floor(v.x / vCellSize);
      const gz = Math.floor(v.z / vCellSize);
      const key = `${gx}_${gz}`;
      let list = vGrid.get(key);
      if (!list) {
        list = [];
        vGrid.set(key, list);
      }
      list.push(v);
    }

    const vVisited = new Set<string>();
    let vehCounter = 1;

    vGrid.forEach((_pts, startKey) => {
      if (vVisited.has(startKey)) return;

      const comp: VertexRecord[] = [];
      const queue = [startKey];
      vVisited.add(startKey);

      while (queue.length > 0) {
        const curKey = queue.pop()!;
        const pts = vGrid.get(curKey);
        if (pts) {
          for (const p of pts) comp.push(p);
        }
        const [cxStr, czStr] = curKey.split('_');
        const cx = parseInt(cxStr!, 10);
        const cz = parseInt(czStr!, 10);

        for (let dx = -1; dx <= 1; dx++) {
          for (let dz = -1; dz <= 1; dz++) {
            if (dx === 0 && dz === 0) continue;
            const nKey = `${cx + dx}_${cz + dz}`;
            if (vGrid.has(nKey) && !vVisited.has(nKey)) {
              vVisited.add(nKey);
              queue.push(nKey);
            }
          }
        }
      }

      if (comp.length >= 10 && comp.length <= 450) {
        const dual = OrientedBoundingBoxSolver.compute(comp.map(v => [v.x, v.y, v.z]));
        const [dim0, dim1, dim2] = dual.obb.dimensions;
        const length = Math.max(dim0, dim2);
        const width = Math.min(dim0, dim2);
        const height = dim1;
        const aspect = length / Math.max(0.5, width);

        if (length >= 2.6 && length <= 8.5 && width >= 1.3 && width <= 3.4 && height >= 0.75 && height <= 3.2 && aspect >= 1.30) {
          for (const p of comp) p.tag = 'vehicle';

          let vType: 'sedan' | 'suv' | 'van_truck' | 'compact' = 'sedan';
          let vName = 'Passenger Sedan';
          if (height > 1.85 || length > 5.5) {
            vType = 'van_truck';
            vName = 'Commercial Delivery Van';
          } else if (height > 1.55) {
            vType = 'suv';
            vName = 'Urban SUV';
          } else if (length < 3.9) {
            vType = 'compact';
            vName = 'Compact City Car';
          }

          const submeshSet = new Set(comp.map(v => v.submeshIndex));
          clusters.push({
            id: `veh-car-${String(vehCounter).padStart(3, '0')}`,
            name: `${vName} #${vehCounter}`,
            category: 'vehicle',
            submeshIndices: Array.from(submeshSet),
            extractedVertices: comp.map(v => [v.x, v.y, v.z]),
            vertexIndices: comp.map(v => v.vertexIndex),
            vertexSubmeshIndices: comp.map(v => v.submeshIndex),
            colorHex: '#f43f5e',
            prompt: `Photorealistic parked ${vName} with ground yaw heading ${dual.obb.yawDeg.toFixed(1)}°, length ${length.toFixed(1)}m, width ${width.toFixed(1)}m`,
            roughness: 0.32,
            metalness: 0.85,
            routingRecommendation: 'sb-vehicle',
            vehicleMetadata: {
              vehicleType: vType,
              lengthMeters: length,
              widthMeters: width,
              heightMeters: height,
              headingDeg: dual.obb.yawDeg,
              groundElevationMeters: groundDatumY,
              estimatedWheelbaseMeters: length * 0.62
            }
          });

          vehCounter++;
        }
      }
    });

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

        const isHighRise = bHeight >= 40.0;
        const bName = isHighRise
          ? `Residential High-Rise Tower Envelope #${bldCounter}`
          : `Perimeter Architectural Building Envelope #${bldCounter}`;
        const category: UniversalSpatialCategory = 'architecture';

        clusters.push({
          id: `arch-building-${String(bldCounter).padStart(3, '0')}`,
          name: bName,
          category,
          submeshIndices: Array.from(submeshSet),
          extractedVertices: clusterVerts.map(v => [v.x, v.y, v.z]),
          vertexIndices: clusterVerts.map(v => v.vertexIndex),
          vertexSubmeshIndices: clusterVerts.map(v => v.submeshIndex),
          colorHex: isHighRise ? '#0284c7' : '#38bdf8',
          prompt: isHighRise
            ? `Art Deco residential high-rise tower envelope with stepped setbacks, vertical piers, and fenestration grid, height ${bHeight.toFixed(1)}m`
            : `Urban residential townhouse architectural envelope with masonry facade planes and cornice moldings, height ${bHeight.toFixed(1)}m`,
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
