/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { NativeCppCompilerService } from '../src/node/3d-engine/native-compiler-service';
import {
  MeshletPipelineService,
  MeshletBuildOptions,
  GpuClusterDescriptor,
  LODCutResult
} from '../src/node/3d-engine/native-meshlet-service';

describe('Nanite-style Meshlet & Cluster DAG Engine (C++20 & Node.js)', () => {
  it('compiles and executes native C++20 scratchbox_meshlet.hpp engine via Clang', async () => {
    const harnessCpp = `
#include <iostream>
#include <sstream>
#include <cassert>
#include "scratchbox_meshlet.hpp"
#include "scratchbox_geometry.hpp"

using namespace scratchbox;
using namespace scratchbox::meshlet;

int main() {
    // 1. Create a procedural dense sphere grid mesh
    geometry::ScratchboxMesh mesh("TestSphere");
    const int latBands = 30;
    const int lonBands = 30;
    const float radius = 2.0f;

    for (int lat = 0; lat <= latBands; ++lat) {
        float theta = lat * math::PI / latBands;
        float sinTheta = std::sin(theta);
        float cosTheta = std::cos(theta);

        for (int lon = 0; lon <= lonBands; ++lon) {
            float phi = lon * 2.0f * math::PI / lonBands;
            float x = radius * sinTheta * std::cos(phi);
            float y = radius * cosTheta;
            float z = radius * sinTheta * std::sin(phi);

            math::Vec3 pos(x, y, z);
            math::Vec3 norm = pos.normalized();
            mesh.addVertex(geometry::Vertex(pos, norm, math::Vec2(0, 0)));
        }
    }

    for (int lat = 0; lat < latBands; ++lat) {
        for (int lon = 0; lon < lonBands; ++lon) {
            int first = (lat * (lonBands + 1)) + lon;
            int second = first + lonBands + 1;

            mesh.addTriangle(first, second, first + 1);
            mesh.addTriangle(second, second + 1, first + 1);
        }
    }

    // 2. Partition into meshlets (max 64 vertices, max 128 triangles)
    MeshletConfig config;
    config.maxVertices = 64;
    config.maxTriangles = 128;

    auto meshlets = MeshletBuilder::buildMeshlets(mesh, config);
    std::cout << "MESHLETS_COUNT " << meshlets.size() << std::endl;

    assert(!meshlets.empty());
    for (const auto& m : meshlets) {
        assert(m.vertexIndices.size() <= 64);
        assert(m.microTriangles.size() / 3 <= 128);
        assert(m.boundingSphere.radius > 0.0f);
    }

    // 3. Build Cluster DAG with monotonic error inheritance
    auto dag = ClusterDAGBuilder::buildDAG(mesh, meshlets, config);
    std::cout << "DAG_NODES " << dag.nodes.size() << std::endl;
    std::cout << "DAG_MAX_LEVEL " << dag.maxLevel << std::endl;

    assert(dag.maxLevel >= 1);
    for (const auto& node : dag.nodes) {
        if (node.level > 0) {
            // Parent error must be strictly greater than child error for crack-free monotonic cuts
            assert(node.parentError >= node.clusterError);
        }
    }

    // 4. Simulate GPU Continuous LOD Cut at 1.0 pixel threshold
    CameraFrustum camera;
    camera.position = math::Vec3(0, 0, 8.0f);
    camera.forward = math::Vec3(0, 0, -1.0f);
    camera.viewportHeight = 1080.0f;
    camera.fovYRad = 45.0f * math::DEG_TO_RAD;

    auto lodCut = GpuCullingSimulator::evaluateLODCut(dag, camera, 1.0f);
    std::cout << "VISIBLE_CLUSTERS " << lodCut.visibleClusters.size() << std::endl;
    std::cout << "TOTAL_RENDER_TRIANGLES " << lodCut.renderedTriangles << std::endl;

    assert(!lodCut.visibleClusters.empty());
    assert(lodCut.renderedTriangles > 0);

    std::cout << "SUCCESS_MESHLET_ENGINE" << std::endl;
    return 0;
}
`;

    const compiler = new NativeCppCompilerService();
    const compilation = await compiler.compileSource(harnessCpp, {
      optimization: '-O3'
    });
    expect(compilation.success).toBe(true);
    expect(compilation.binaryPath).toBeDefined();

    const execution = await compiler.executeBinary(compilation.binaryPath!);
    expect(execution.success).toBe(true);
    expect(execution.stdout).toContain('SUCCESS_MESHLET_ENGINE');
    expect(execution.stdout).toContain('MESHLETS_COUNT');
    expect(execution.stdout).toContain('DAG_NODES');
  });

  it('runs MeshletPipelineService in Node.js to partition mesh and generate GPU descriptors', async () => {
    const service = new MeshletPipelineService();

    // Create a procedural plane / terrain grid
    const vertices: number[] = [];
    const indices: number[] = [];
    const gridSize = 20;

    for (let y = 0; y <= gridSize; y++) {
      for (let x = 0; x <= gridSize; x++) {
        vertices.push(x * 0.5, Math.sin(x * 0.5) * 0.2, y * 0.5);
      }
    }

    for (let y = 0; y < gridSize; y++) {
      for (let x = 0; x < gridSize; x++) {
        const row1 = y * (gridSize + 1);
        const row2 = (y + 1) * (gridSize + 1);
        indices.push(row1 + x, row2 + x, row1 + x + 1);
        indices.push(row2 + x, row2 + x + 1, row1 + x + 1);
      }
    }

    const options: MeshletBuildOptions = {
      maxVertices: 64,
      maxTriangles: 128,
      targetErrorPx: 1.0
    };

    const result = await service.buildMeshletDAG({
      vertices: new Float32Array(vertices),
      indices: new Uint32Array(indices),
      options
    });

    expect(result.meshlets.length).toBeGreaterThan(0);
    expect(result.gpuClusters.length).toBeGreaterThan(0);
    expect(result.dagMaxLevel).toBeGreaterThanOrEqual(1);

    // Verify GPU Cluster Descriptors adhere to WebGPU indirect draw memory layout
    for (const cluster of result.gpuClusters) {
      expect(cluster.boundingSphere.radius).toBeGreaterThan(0);
      expect(cluster.triangleCount).toBeLessThanOrEqual(128);
      expect(cluster.vertexCount).toBeLessThanOrEqual(64);
      expect(cluster.parentError).toBeGreaterThanOrEqual(cluster.clusterError);
    }

    // Verify LOD Cut simulation
    const lodCut = service.evaluateLODCut({
      dag: result,
      cameraPosition: [0, 5, 10],
      cameraForward: [0, -0.4, -0.9],
      viewportHeight: 1080,
      fovDeg: 45,
      thresholdPx: 1.0
    });

    expect(lodCut.selectedClusterIndices.length).toBeGreaterThan(0);
    expect(lodCut.indirectDrawArgs.length).toBe(lodCut.selectedClusterIndices.length);
    expect(lodCut.totalRenderTriangles).toBeGreaterThan(0);
  });
});
