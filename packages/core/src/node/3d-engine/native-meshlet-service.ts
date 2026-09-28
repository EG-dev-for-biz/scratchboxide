/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

export interface MeshletBuildOptions {
  maxVertices?: number;
  maxTriangles?: number;
  targetErrorPx?: number;
}

export interface MeshletData {
  id: number;
  lodLevel: number;
  vertexIndices: number[];
  microTriangles: number[];
  boundingSphere: {
    center: [number, number, number];
    radius: number;
  };
  clusterError: number;
  parentError: number;
}

export interface GpuClusterDescriptor {
  clusterId: number;
  level: number;
  boundingSphere: {
    center: [number, number, number];
    radius: number;
  };
  coneAxis: [number, number, number];
  coneCutoff: number;
  clusterError: number;
  parentError: number;
  vertexOffset: number;
  vertexCount: number;
  indexOffset: number;
  triangleCount: number;
}

export interface MeshletDAGResult {
  meshlets: MeshletData[];
  gpuClusters: GpuClusterDescriptor[];
  dagMaxLevel: number;
  rootClusterIds: number[];
  leafClusterIds: number[];
  nodes: {
    id: number;
    level: number;
    children: number[];
    parents: number[];
    clusterError: number;
    parentError: number;
    boundingSphere: {
      center: [number, number, number];
      radius: number;
    };
    meshlet: MeshletData;
  }[];
}

export interface WebGpuIndirectDrawArgs {
  indexCount: number;
  instanceCount: number;
  firstIndex: number;
  baseVertex: number;
  firstInstance: number;
}

export interface LODCutResult {
  selectedClusterIndices: number[];
  indirectDrawArgs: WebGpuIndirectDrawArgs[];
  totalRenderTriangles: number;
}

export class MeshletPipelineService {
  /**
   * Partitions vertices and indices into bounded meshlets and constructs a cluster DAG.
   */
  public async buildMeshletDAG(input: {
    vertices: Float32Array;
    indices: Uint32Array;
    options?: MeshletBuildOptions;
  }): Promise<MeshletDAGResult> {
    const maxVerts = input.options?.maxVertices ?? 64;
    const maxTris = input.options?.maxTriangles ?? 128;
    const totalTriangles = Math.floor(input.indices.length / 3);

    const meshlets: MeshletData[] = [];
    const triUsed = new Uint8Array(totalTriangles);

    // Build vertex-to-triangle map for adjacency
    const vertToTri: number[][] = [];
    const numVerts = Math.floor(input.vertices.length / 3);
    for (let i = 0; i < numVerts; i++) {
      vertToTri.push([]);
    }
    for (let t = 0; t < totalTriangles; t++) {
      vertToTri[input.indices[t * 3 + 0]].push(t);
      vertToTri[input.indices[t * 3 + 1]].push(t);
      vertToTri[input.indices[t * 3 + 2]].push(t);
    }

    let nextMeshletId = 0;

    for (let seed = 0; seed < totalTriangles; seed++) {
      if (triUsed[seed]) continue;

      const vertexIndices: number[] = [];
      const microTriangles: number[] = [];
      const globalToLocal = new Map<number, number>();
      const queue: number[] = [seed];

      while (queue.length > 0 && microTriangles.length / 3 < maxTris) {
        const t = queue.pop()!;
        if (triUsed[t]) continue;

        const i0 = input.indices[t * 3 + 0];
        const i1 = input.indices[t * 3 + 1];
        const i2 = input.indices[t * 3 + 2];

        let newVertCount = 0;
        if (!globalToLocal.has(i0)) newVertCount++;
        if (!globalToLocal.has(i1)) newVertCount++;
        if (!globalToLocal.has(i2)) newVertCount++;

        if (vertexIndices.length + newVertCount > maxVerts) {
          continue;
        }

        triUsed[t] = 1;

        const getLocal = (g: number): number => {
          if (globalToLocal.has(g)) return globalToLocal.get(g)!;
          const loc = vertexIndices.length;
          vertexIndices.push(g);
          globalToLocal.set(g, loc);
          return loc;
        };

        const l0 = getLocal(i0);
        const l1 = getLocal(i1);
        const l2 = getLocal(i2);

        microTriangles.push(l0, l1, l2);

        // Add neighbors to queue
        for (const adj of vertToTri[i0]) if (!triUsed[adj]) queue.push(adj);
        for (const adj of vertToTri[i1]) if (!triUsed[adj]) queue.push(adj);
        for (const adj of vertToTri[i2]) if (!triUsed[adj]) queue.push(adj);
      }

      if (microTriangles.length > 0) {
        // Compute bounding sphere
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

        for (const vIdx of vertexIndices) {
          const vx = input.vertices[vIdx * 3 + 0];
          const vy = input.vertices[vIdx * 3 + 1];
          const vz = input.vertices[vIdx * 3 + 2];
          minX = Math.min(minX, vx); minY = Math.min(minY, vy); minZ = Math.min(minZ, vz);
          maxX = Math.max(maxX, vx); maxY = Math.max(maxY, vy); maxZ = Math.max(maxZ, vz);
        }

        const cx = (minX + maxX) * 0.5;
        const cy = (minY + maxY) * 0.5;
        const cz = (minZ + maxZ) * 0.5;

        let maxDistSq = 0;
        for (const vIdx of vertexIndices) {
          const dx = input.vertices[vIdx * 3 + 0] - cx;
          const dy = input.vertices[vIdx * 3 + 1] - cy;
          const dz = input.vertices[vIdx * 3 + 2] - cz;
          maxDistSq = Math.max(maxDistSq, dx * dx + dy * dy + dz * dz);
        }

        meshlets.push({
          id: nextMeshletId++,
          lodLevel: 0,
          vertexIndices,
          microTriangles,
          boundingSphere: {
            center: [cx, cy, cz],
            radius: Math.sqrt(maxDistSq)
          },
          clusterError: 0.0,
          parentError: 1e8
        });
      }
    }

    // Build DAG nodes
    const nodes: MeshletDAGResult['nodes'] = [];
    const leafClusterIds: number[] = [];

    for (const m of meshlets) {
      leafClusterIds.push(m.id);
      nodes.push({
        id: m.id,
        level: 0,
        children: [],
        parents: [],
        clusterError: 0.0,
        parentError: 1e8,
        boundingSphere: m.boundingSphere,
        meshlet: m
      });
    }

    // Build hierarchy (Level 1)
    let currentLevelIds = [...leafClusterIds];
    let level = 1;

    while (currentLevelIds.length > 1 && level <= 4) {
      const nextLevelIds: number[] = [];
      const groupSize = 4;

      for (let i = 0; i < currentLevelIds.length; i += groupSize) {
        const count = Math.min(groupSize, currentLevelIds.length - i);
        const children = currentLevelIds.slice(i, i + count);

        // Group bounds
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        let maxChildErr = 0;

        for (const cId of children) {
          const cn = nodes[cId];
          maxChildErr = Math.max(maxChildErr, cn.clusterError);
          const r = cn.boundingSphere.radius;
          minX = Math.min(minX, cn.boundingSphere.center[0] - r);
          minY = Math.min(minY, cn.boundingSphere.center[1] - r);
          minZ = Math.min(minZ, cn.boundingSphere.center[2] - r);
          maxX = Math.max(maxX, cn.boundingSphere.center[0] + r);
          maxY = Math.max(maxY, cn.boundingSphere.center[1] + r);
          maxZ = Math.max(maxZ, cn.boundingSphere.center[2] + r);
        }

        const cx = (minX + maxX) * 0.5;
        const cy = (minY + maxY) * 0.5;
        const cz = (minZ + maxZ) * 0.5;
        const r = Math.sqrt((maxX - minX) ** 2 + (maxY - minY) ** 2 + (maxZ - minZ) ** 2) * 0.5;

        // Decimation geometric error + monotonic inheritance
        const parentError = maxChildErr + Math.max(0.01, r * 0.08);

        const parentNodeId = nodes.length;
        const parentMeshlet: MeshletData = {
          id: parentNodeId,
          lodLevel: level,
          vertexIndices: nodes[children[0]].meshlet.vertexIndices.slice(0, 32),
          microTriangles: nodes[children[0]].meshlet.microTriangles.slice(0, 48),
          boundingSphere: { center: [cx, cy, cz], radius: r },
          clusterError: parentError,
          parentError: 1e8
        };

        for (const cId of children) {
          nodes[cId].parents.push(parentNodeId);
          nodes[cId].parentError = parentError;
          nodes[cId].meshlet.parentError = parentError;
        }

        nodes.push({
          id: parentNodeId,
          level,
          children,
          parents: [],
          clusterError: parentError,
          parentError: 1e8,
          boundingSphere: parentMeshlet.boundingSphere,
          meshlet: parentMeshlet
        });

        nextLevelIds.push(parentNodeId);
      }

      currentLevelIds = nextLevelIds;
      level++;
    }

    // Build GPU descriptors
    const gpuClusters: GpuClusterDescriptor[] = [];
    let vertOffset = 0;
    let idxOffset = 0;

    for (const node of nodes) {
      const vCount = node.meshlet.vertexIndices.length;
      const tCount = Math.floor(node.meshlet.microTriangles.length / 3);

      gpuClusters.push({
        clusterId: node.id,
        level: node.level,
        boundingSphere: node.boundingSphere,
        coneAxis: [0, 1, 0],
        coneCutoff: -1.0,
        clusterError: node.clusterError,
        parentError: node.parentError,
        vertexOffset: vertOffset,
        vertexCount: vCount,
        indexOffset: idxOffset,
        triangleCount: tCount
      });

      vertOffset += vCount;
      idxOffset += node.meshlet.microTriangles.length;
    }

    return {
      meshlets,
      gpuClusters,
      dagMaxLevel: level - 1,
      rootClusterIds: currentLevelIds,
      leafClusterIds,
      nodes
    };
  }

  /**
   * Simulates WebGPU compute culling and continuous screen-space error LOD cut.
   */
  public evaluateLODCut(params: {
    dag: MeshletDAGResult;
    cameraPosition: [number, number, number];
    cameraForward: [number, number, number];
    viewportHeight: number;
    fovDeg: number;
    thresholdPx: number;
  }): LODCutResult {
    const { dag, cameraPosition, cameraForward, viewportHeight, fovDeg, thresholdPx } = params;
    const cotHalfFov = 1.0 / Math.tan((fovDeg * Math.PI) / 360.0);
    const selected: number[] = [];

    const computeSSE = (sphere: { center: [number, number, number]; radius: number }, geomErr: number): number => {
      const dx = sphere.center[0] - cameraPosition[0];
      const dy = sphere.center[1] - cameraPosition[1];
      const dz = sphere.center[2] - cameraPosition[2];
      const dist = Math.max(0.001, Math.sqrt(dx * dx + dy * dy + dz * dz) - sphere.radius);
      return (geomErr / dist) * (viewportHeight * 0.5 * cotHalfFov);
    };

    // Breadth/Depth traversal from roots to leaves
    const stack = [...dag.rootClusterIds];
    const visited = new Set<number>();

    while (stack.length > 0) {
      const nodeId = stack.pop()!;
      if (visited.has(nodeId)) continue;
      visited.add(nodeId);

      const node = dag.nodes[nodeId];

      // Frustum culling (distance along forward)
      const toX = node.boundingSphere.center[0] - cameraPosition[0];
      const toY = node.boundingSphere.center[1] - cameraPosition[1];
      const toZ = node.boundingSphere.center[2] - cameraPosition[2];
      const distForward = toX * cameraForward[0] + toY * cameraForward[1] + toZ * cameraForward[2];

      if (distForward + node.boundingSphere.radius < 0) {
        // Behind camera
        continue;
      }

      // Continuous LOD Cut
      const clusterSSE = computeSSE(node.boundingSphere, node.clusterError);

      if (clusterSSE <= thresholdPx || node.children.length === 0) {
        selected.push(nodeId);
      } else {
        for (const c of node.children) {
          stack.push(c);
        }
      }
    }

    // Generate WebGPU indirect draw commands
    const indirectDrawArgs: WebGpuIndirectDrawArgs[] = [];
    let totalRenderTriangles = 0;
    let firstIndex = 0;

    for (const clusterId of selected) {
      const node = dag.nodes[clusterId];
      const idxCount = node.meshlet.microTriangles.length;

      indirectDrawArgs.push({
        indexCount: idxCount,
        instanceCount: 1,
        firstIndex,
        baseVertex: 0,
        firstInstance: 0
      });

      firstIndex += idxCount;
      totalRenderTriangles += Math.floor(idxCount / 3);
    }

    return {
      selectedClusterIndices: selected,
      indirectDrawArgs,
      totalRenderTriangles
    };
  }
}
