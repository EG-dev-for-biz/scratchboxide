import { describe, it, expect } from 'vitest';
import {
  buildSubmeshAdjacency,
  evaluateGeometricNormal,
  pointSegmentDistance,
  VirtualBevelKernel
} from '../src/node/3d-engine/virtual-bevel-kernel';

describe('Phase 3: 5mm Virtual Specular Bevel & Curvature Anti-Faceting Normal Kernel', () => {

  it('classifies 90 deg dihedral angles as sharp edges (>45 deg) with normalized chamfer normals', () => {
    // 2 triangles sharing an edge along Y axis (from (0,0,0) to (0,1,0)):
    // Triangle 0: on XY plane with normal [0, 0, 1]
    // Triangle 1: on YZ plane with normal [1, 0, 0]
    const positions = new Float32Array([
      // T0: (0,0,0), (0,1,0), (-1,0,0) -> normal [0, 0, 1]
      0, 0, 0,   0, 1, 0,   -1, 0, 0,
      // T1: (0,0,0), (0,0,-1), (0,1,0) -> normal [1, 0, 0]
      0, 0, 0,   0, 0, -1,  0, 1, 0
    ]);
    const indices = new Uint16Array([
      0, 1, 2,
      3, 4, 5
    ]);
    const uvs = new Float32Array([
      0, 0,  0, 1,  1, 0,
      0, 0,  1, 0,  0, 1
    ]);

    const graph = buildSubmeshAdjacency(positions, indices, uvs, 0.001);

    expect(graph.triangles.length).toBe(2);
    expect(graph.sharpEdgeCount).toBe(1);
    expect(graph.smoothEdgeCount).toBe(0);

    const t0 = graph.triangles[0];
    const t1 = graph.triangles[1];
    expect(t0.hasSharpEdge).toBe(true);
    expect(t1.hasSharpEdge).toBe(true);

    const edge = t0.sharpEdges[0];
    expect(edge.dihedralAngleDeg).toBeCloseTo(90.0, 1);
    expect(edge.isSharp).toBe(true);

    // Chamfer normal should bisect [0,0,1] and [1,0,0] -> [1/√2, 0, 1/√2]
    const invSqrt2 = 1.0 / Math.sqrt(2);
    expect(edge.chamferNormal[0]).toBeCloseTo(invSqrt2, 3);
    expect(edge.chamferNormal[1]).toBeCloseTo(0.0, 3);
    expect(edge.chamferNormal[2]).toBeCloseTo(invSqrt2, 3);
  });

  it('computes 5mm virtual bevel normal with smooth cosine falloff and edge burnish', () => {
    // Sharp 90° corner
    const positions = new Float32Array([
      0, 0, 0,   0, 1, 0,   -1, 0, 0,
      0, 0, 0,   0, 0, -1,  0, 1, 0
    ]);
    const indices = new Uint16Array([0, 1, 2, 3, 4, 5]);
    const uvs = new Float32Array([0, 0, 0, 1, 1, 0, 0, 0, 1, 0, 0, 1]);
    const graph = buildSubmeshAdjacency(positions, indices, uvs, 0.001);

    // Test point 1: exactly on the edge at (0, 0.5, 0)
    const pOnEdge: [number, number, number] = [0.0, 0.5, 0.0];
    const resEdge = evaluateGeometricNormal(graph, 0, pOnEdge, [0.5, 0.5, 0.0], 0.005);

    expect(resEdge.isBevel).toBe(true);
    expect(resEdge.bevelDistanceMeters).toBeCloseTo(0.0, 5);
    expect(resEdge.bevelWeight).toBeCloseTo(1.0, 3);
    // At d=0, world normal should be chamfer normal [1/√2, 0, 1/√2]
    const invSqrt2 = 1.0 / Math.sqrt(2);
    expect(resEdge.worldNormal[0]).toBeCloseTo(invSqrt2, 3);
    expect(resEdge.worldNormal[2]).toBeCloseTo(invSqrt2, 3);
    // Roughness modifier should be -0.08 (specular burnish)
    expect(resEdge.roughnessModifier).toBeCloseTo(-0.08, 3);

    // Test point 2: 2.5 mm away from edge along X axis at (-0.0025, 0.5, 0)
    const pMid: [number, number, number] = [-0.0025, 0.5, 0.0];
    const resMid = evaluateGeometricNormal(graph, 0, pMid, [0.4975, 0.5, 0.0025], 0.005);
    expect(resMid.isBevel).toBe(true);
    expect(resMid.bevelDistanceMeters).toBeCloseTo(0.0025, 4);
    // Cosine profile at u=0.5: 0.5 * (1 + cos(pi * 0.5)) = 0.5
    expect(resMid.bevelWeight).toBeCloseTo(0.5, 3);
    expect(resMid.roughnessModifier).toBeCloseTo(-0.04, 3);

    // Test point 3: 10 mm away from edge at (-0.010, 0.5, 0)
    const pFar: [number, number, number] = [-0.010, 0.5, 0.0];
    const resFar = evaluateGeometricNormal(graph, 0, pFar, [0.49, 0.5, 0.01], 0.005);
    expect(resFar.isBevel).toBe(false);
    expect(resFar.bevelWeight).toBe(0.0);
    // Away from edge, world normal is pure face normal [0, 0, 1]
    expect(resFar.worldNormal[0]).toBeCloseTo(0.0, 3);
    expect(resFar.worldNormal[1]).toBeCloseTo(0.0, 3);
    expect(resFar.worldNormal[2]).toBeCloseTo(1.0, 3);
    expect(resFar.roughnessModifier).toBe(0.0);
  });

  it('guarantees C0 normal continuity across shared sharp edge', () => {
    // Sharp 90° corner between T0 and T1
    const positions = new Float32Array([
      0, 0, 0,   0, 1, 0,   -1, 0, 0,
      0, 0, 0,   0, 0, -1,  0, 1, 0
    ]);
    const indices = new Uint16Array([0, 1, 2, 3, 4, 5]);
    const graph = buildSubmeshAdjacency(positions, indices, null, 0.001);

    const edgePoint: [number, number, number] = [0.0, 0.3, 0.0];
    const resT0 = evaluateGeometricNormal(graph, 0, edgePoint, [0.7, 0.3, 0.0], 0.005);
    const resT1 = evaluateGeometricNormal(graph, 1, edgePoint, [0.7, 0.0, 0.3], 0.005);

    // Both triangles evaluate to the exact same world normal at the edge!
    expect(resT0.worldNormal[0]).toBeCloseTo(resT1.worldNormal[0], 4);
    expect(resT0.worldNormal[1]).toBeCloseTo(resT1.worldNormal[1], 4);
    expect(resT0.worldNormal[2]).toBeCloseTo(resT1.worldNormal[2], 4);
  });

  it('eliminates polygonal facet banding across curved arch / cylinder segments', () => {
    // Construct a discretized circular arch segment: 3 quads (6 triangles) curved around Y axis
    // Dihedral angle between adjacent facets is ~15° (<= 45° smooth curvature)
    const angleStep = (15.0 * Math.PI) / 180.0;
    const r = 1.0;
    const posList: number[] = [];
    const idxList: number[] = [];

    const numSegments = 3;
    for (let s = 0; s <= numSegments; s++) {
      const theta = s * angleStep;
      const x = r * Math.sin(theta);
      const z = r * Math.cos(theta);
      // Bottom vertex
      posList.push(x, 0.0, z);
      // Top vertex
      posList.push(x, 1.0, z);
    }

    for (let s = 0; s < numSegments; s++) {
      const v0 = s * 2;
      const v1 = s * 2 + 1;
      const v2 = (s + 1) * 2;
      const v3 = (s + 1) * 2 + 1;

      // Tri A
      idxList.push(v0, v1, v2);
      // Tri B
      idxList.push(v2, v1, v3);
    }

    const positions = new Float32Array(posList);
    const indices = new Uint16Array(idxList);

    const graph = buildSubmeshAdjacency(positions, indices, null, 0.001);

    expect(graph.sharpEdgeCount).toBe(0); // All dihedral angles ~15° < 45°
    expect(graph.smoothEdgeCount).toBeGreaterThan(0);

    // Middle triangle (curved arch facet)
    const midTri = graph.triangles[2];
    expect(midTri.isCurvedSurface).toBe(true);

    // Evaluate barycentric points across the facet
    const pCenter: [number, number, number] = [
      (midTri.v0[0] + midTri.v1[0] + midTri.v2[0]) / 3,
      (midTri.v0[1] + midTri.v1[1] + midTri.v2[1]) / 3,
      (midTri.v0[2] + midTri.v1[2] + midTri.v2[2]) / 3
    ];
    const resCenter = evaluateGeometricNormal(graph, 2, pCenter, [0.333, 0.333, 0.334], 0.005);

    expect(resCenter.isAntiFaceted).toBe(true);
    // Smooth normal varies continuously across the polygon
    expect(resCenter.worldNormal[0]**2 + resCenter.worldNormal[1]**2 + resCenter.worldNormal[2]**2).toBeCloseTo(1.0, 4);
  });

  it('guarantees 0.000 mm geometric drift lock', () => {
    const originalPositions = new Float32Array([
      1.234, 5.678, 9.012,
      2.345, 6.789, 0.123,
      3.456, 7.890, 1.234
    ]);
    const clonedPositions = new Float32Array(originalPositions);
    const indices = new Uint16Array([0, 1, 2]);
    const clonedIndices = new Uint16Array(indices);

    const graph = buildSubmeshAdjacency(clonedPositions, clonedIndices, null, 0.001);
    evaluateGeometricNormal(graph, 0, [2.0, 6.0, 3.0], [0.33, 0.33, 0.34], 0.005);

    // Exact byte equality: not a single coordinate modified
    for (let i = 0; i < originalPositions.length; i++) {
      expect(clonedPositions[i]).toBe(originalPositions[i]);
    }
    for (let i = 0; i < indices.length; i++) {
      expect(clonedIndices[i]).toBe(indices[i]);
    }
  });

  it('exports normalized tangent-space vectors compatible with standard glTF 2.0 PBR', () => {
    const positions = new Float32Array([0, 0, 0,  0, 1, 0,  -1, 0, 0]);
    const indices = new Uint16Array([0, 1, 2]);
    const uvs = new Float32Array([0, 0,  0, 1,  1, 0]);
    const graph = buildSubmeshAdjacency(positions, indices, uvs, 0.001);

    const res = evaluateGeometricNormal(graph, 0, [-0.5, 0.2, 0.0], [0.3, 0.2, 0.5], 0.005);

    const [tx, ty, tz] = res.tangentNormal;
    const len = Math.sqrt(tx * tx + ty * ty + tz * tz);
    expect(len).toBeCloseTo(1.0, 4);
    // Normal map z-component should face outward
    expect(tz).toBeGreaterThan(0.0);
  });
});
