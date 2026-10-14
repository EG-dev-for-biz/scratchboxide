import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { AdaptiveUvOrchestrator } from '../src/node/3d-engine/adaptive-uv-orchestrator';
import { GltfBinaryPacker } from '../src/node/3d-engine/gltf-binary-packer';

function createMockGlb(options: {
  submeshCount: number;
  height: number;
  width: number;
  depth: number;
  hasTexture?: boolean;
}): Buffer {
  const { submeshCount, height, width, depth, hasTexture } = options;
  const bufferViews: Buffer[] = [];
  const accessors: any[] = [];
  const meshes: any[] = [];

  for (let m = 0; m < submeshCount; m++) {
    // 3 vertices for a single triangle
    const positions = new Float32Array([
      -width / 2, 0, -depth / 2,
      width / 2, 0, -depth / 2,
      0, height, depth / 2
    ]);
    const normals = new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]);
    const uvs = new Float32Array([0, 0, 1, 0, 0.5, 1]);
    const indices = new Uint32Array([0, 1, 2]);

    const posBv = bufferViews.length;
    bufferViews.push(Buffer.from(positions.buffer));
    const posAcc = accessors.length;
    accessors.push({
      bufferView: posBv,
      componentType: 5126,
      count: 3,
      type: 'VEC3'
    });

    const normBv = bufferViews.length;
    bufferViews.push(Buffer.from(normals.buffer));
    const normAcc = accessors.length;
    accessors.push({
      bufferView: normBv,
      componentType: 5126,
      count: 3,
      type: 'VEC3'
    });

    const uvBv = bufferViews.length;
    bufferViews.push(Buffer.from(uvs.buffer));
    const uvAcc = accessors.length;
    accessors.push({
      bufferView: uvBv,
      componentType: 5126,
      count: 3,
      type: 'VEC2'
    });

    const idxBv = bufferViews.length;
    bufferViews.push(Buffer.from(indices.buffer));
    const idxAcc = accessors.length;
    accessors.push({
      bufferView: idxBv,
      componentType: 5125,
      count: 3,
      type: 'SCALAR'
    });

    meshes.push({
      primitives: [{
        attributes: {
          POSITION: posAcc,
          NORMAL: normAcc,
          TEXCOORD_0: uvAcc
        },
        indices: idxAcc
      }]
    });
  }

  const gltf: any = {
    asset: { version: '2.0', generator: 'TestGlb' },
    meshes,
    accessors,
    bufferViews: bufferViews.map(bv => ({
      buffer: 0,
      byteOffset: 0,
      byteLength: bv.length
    }))
  };

  if (hasTexture) {
    const dummyPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const imgBv = bufferViews.length;
    bufferViews.push(dummyPng);
    gltf.bufferViews.push({ buffer: 0, byteOffset: 0, byteLength: dummyPng.length });
    gltf.images = [{ bufferView: imgBv, mimeType: 'image/png' }];
  }

  return GltfBinaryPacker.packGlb(gltf, bufferViews).glbBuffer;
}

describe('AdaptiveUvOrchestrator Scenario-Adaptive Evaluation & Seam Mitigation', () => {
  it('classifies organic articulated anatomy and assigns Carrier Sheet with natural occlusion seams', () => {
    // Slender aspect ratio (Y=12m, X=1m, Z=1m) => ratio 12.0
    const glb = createMockGlb({ submeshCount: 1, height: 12.0, width: 1.0, depth: 1.0 });
    const probe = AdaptiveUvOrchestrator.probeTopology(glb, 'organic');

    expect(probe.domainClassification).toBe('organic');
    expect(probe.organicityIndex).toBe(1.0);
    expect(probe.recommendedStrategy).toBe('carrier_conformal_sheet');
    expect(probe.seamStrategy.seamPlacement).toBe('natural_occlusion_geodesics');
    expect(probe.seamStrategy.seamMitigationMethod).toBe('hermite_margin_overlap');
    expect(probe.seamStrategy.recommendedGutterPaddingPx).toBe(8);
    expect(probe.seamStrategy.tangentSpaceHandednessGuaranteed).toBe(true);
    expect(probe.seamStrategy.seamRationale).toContain('lateral neutral lines');
  });

  it('classifies high-rise vertical architecture and assigns Elevation-Stratified Conformal with reveal seams', () => {
    // High-rise: Height = 50m, Width = 20m, Depth = 20m (aspect ratio >= 1.5, Height >= 35m)
    const glb = createMockGlb({ submeshCount: 1, height: 50.0, width: 20.0, depth: 20.0 });
    const probe = AdaptiveUvOrchestrator.probeTopology(glb, 'nonorganic');

    expect(probe.domainClassification).toBe('nonorganic');
    expect(probe.organicityIndex).toBe(0.0);
    expect(probe.isHighRiseArchitecture).toBe(true);
    expect(probe.recommendedStrategy).toBe('elevation_stratified_conformal');
    expect(probe.seamStrategy.seamPlacement).toBe('architectural_reveals_and_mullions');
    expect(probe.seamStrategy.seamMitigationMethod).toBe('gutter_dilation_clamping');
    expect(probe.seamStrategy.recommendedGutterPaddingPx).toBe(16);
    expect(probe.seamStrategy.tangentSpaceHandednessGuaranteed).toBe(true);
  });

  it('classifies massive photogrammetric scans and assigns Recipe Hybrid with welded boundaries', () => {
    // 12 submeshes + pre-baked texture
    const glb = createMockGlb({ submeshCount: 12, height: 10.0, width: 30.0, depth: 30.0, hasTexture: true });
    const probe = AdaptiveUvOrchestrator.probeTopology(glb);

    expect(probe.domainClassification).toBe('nonorganic');
    expect(probe.isMassiveScan).toBe(true);
    expect(probe.recommendedStrategy).toBe('recipe_hybrid');
    expect(probe.seamStrategy.seamPlacement).toBe('photogrammetric_boundary_welded');
    expect(probe.seamStrategy.seamMitigationMethod).toBe('affine_edge_altitude_bevel');
    expect(probe.seamStrategy.tangentSpaceHandednessGuaranteed).toBe(true);
  });

  it('classifies standard mechanical props / CAD and assigns Height-Blended Triplanar with zero seams', () => {
    // Regular boxy prop (Height = 2m, Width = 2m, Depth = 2m)
    const glb = createMockGlb({ submeshCount: 1, height: 2.0, width: 2.0, depth: 2.0 });
    const probe = AdaptiveUvOrchestrator.probeTopology(glb);

    expect(probe.domainClassification).toBe('nonorganic');
    expect(probe.recommendedStrategy).toBe('height_blended_triplanar');
    expect(probe.seamStrategy.seamPlacement).toBe('zero_seams_continuous');
    expect(probe.seamStrategy.seamMitigationMethod).toBe('triplanar_height_blended');
    expect(probe.seamStrategy.recommendedGutterPaddingPx).toBe(0);
  });

  it('executes applyAdaptivePbr for recipe_hybrid strategy successfully', async () => {
    const glb = createMockGlb({ submeshCount: 2, height: 5.0, width: 5.0, depth: 5.0 });
    const result = await AdaptiveUvOrchestrator.applyAdaptivePbr({
      inputGlbBuffer: glb,
      strategy: 'recipe_hybrid',
      recipeOutputMode: 'webgl-recipe'
    });

    expect(result.appliedStrategy).toBe('recipe_hybrid');
    expect(result.glbBuffer).toBeDefined();
    expect(result.glbBuffer!.readUInt32LE(0)).toBe(0x46546c67); // glTF magic 'glTF'
  });
});
