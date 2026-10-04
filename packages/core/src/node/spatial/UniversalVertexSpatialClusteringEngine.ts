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
}

export interface VertexClusteringOptions {
  granularity?: 'macro' | 'detailed' | 'total' | 'trees' | 'all';
  minVerticesPerEntity?: number;
  treeApexMinHeightMeters?: number;
  treeApexMaxHeightMeters?: number;
  buildingMinHeightMeters?: number;
  gridCellSizeMeters?: number;
}

export interface DecomposedCluster {
  id: string;
  name: string;
  category: UniversalSpatialCategory;
  submeshIndices: number[];
  extractedVertices: [number, number, number][];
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
}

interface VertexRecord {
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
  submeshIndex: number;
  tag: 'unassigned' | 'terrain' | 'tree' | 'building' | 'prop';
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

        allVertices.push({
          x, y, z,
          nx, ny, nz,
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
        colorHex: '#64748b',
        prompt: 'Pedestrian ground pavement and geological apron datum with tactile surface materials',
        roughness: 0.90,
        metalness: 0.04,
        routingRecommendation: 'sb-terrain'
      });
    }

    // 4. Stage 2: Tree Apex Detection & Radial Canopy Extraction
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

    // 5. Stage 3: Building Structures & Architectural Facades
    // Vertices that are vertical (|ny| <= 0.40) or elevated roof surfaces (h > 4.0m)
    const buildingCandidates: VertexRecord[] = [];
    for (const v of allVertices) {
      if (v.tag !== 'unassigned') continue;
      const h = v.y - groundDatumY;
      if (h >= 2.0 && (Math.abs(v.ny) <= 0.45 || h >= 5.0)) {
        buildingCandidates.push(v);
      }
    }

    // Spatial clustering of building candidates on XZ plane (cell size ~5.0m)
    const bldGrid = new Map<string, VertexRecord[]>();
    const bldCellSize = 5.5;

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

        const isMonument = bHeight > 18.0 || bWidth > 35.0 || bDepth > 35.0;
        const category: UniversalSpatialCategory = isMonument ? 'monument' : 'architecture';

        clusters.push({
          id: isMonument ? `mon-structure-${String(bldCounter).padStart(3, '0')}` : `arch-building-${String(bldCounter).padStart(3, '0')}`,
          name: isMonument ? `Architectural Monument Facade #${bldCounter}` : `Building Structure Envelope #${bldCounter}`,
          category,
          submeshIndices: Array.from(submeshSet),
          extractedVertices: clusterVerts.map(v => [v.x, v.y, v.z]),
          colorHex: isMonument ? '#3b82f6' : '#fbbf24',
          prompt: isMonument
            ? `Monolithic architectural monument with classical orders and masonry relief, height ${bHeight.toFixed(1)}m`
            : `Urban architectural building structure envelope with regular fenestration and vertical facade planes, height ${bHeight.toFixed(1)}m`,
          roughness: 0.85,
          metalness: 0.02,
          routingRecommendation: isMonument ? 'sb-archi' : 'archie-building',
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
