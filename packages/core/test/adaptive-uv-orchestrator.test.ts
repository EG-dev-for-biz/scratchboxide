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

describe('AdaptiveUvOrchestrator.probeTopology reports what it measured and the rule that routed it', () => {
  // createMockGlb: per mesh one triangle (-w/2,0,-d/2) (w/2,0,-d/2) (0,h,d/2); no node places the meshes
  it('the caller-given organic domain routes to carrier_conformal_sheet, and the result says the caller decided', () => {
    const probe = AdaptiveUvOrchestrator.probeTopology(createMockGlb({ submeshCount: 1, height: 12.0, width: 1.0, depth: 1.0 }), 'organic');
    expect(probe.domainClassification).toBe('organic');
    expect(probe.domainSource).toBe('caller');
    expect(probe.recommendedStrategy).toBe('carrier_conformal_sheet');
    expect(probe.routingRule).toMatch(/given by the caller/);
    expect(probe.methodThatRuns).toMatch(/^box_projection_uv/);
    expect(probe.bounds.dimensions).toEqual([1, 12, 1]);
    expect(probe.boundsSpace).toBe('mesh_local_unplaced');
    expect(probe.triangleCount).toBe(1);
    expect(probe.vertexCount).toBe(3);
    expect(probe).not.toHaveProperty('organicityIndex');
    expect(probe).not.toHaveProperty('confidenceScore');
    expect(probe).not.toHaveProperty('seamStrategy');
  });

  it('a 50 m tall, 20 m wide mesh fires the tall-slender rule, and the measured ratio is in the rule text', () => {
    const probe = AdaptiveUvOrchestrator.probeTopology(createMockGlb({ submeshCount: 1, height: 50.0, width: 20.0, depth: 20.0 }), 'nonorganic');
    expect(probe.domainClassification).toBe('nonorganic');
    expect(probe.rules).toEqual({ tallSlender: true, manyTexturedMeshes: false, elongatedUntextured: false });
    expect(probe.recommendedStrategy).toBe('elevation_stratified_conformal');
    expect(probe.routingRule).toContain('height 50.00 m >= 35');
    expect(probe.routingRule).toContain('= 2.500 >= 1.5');
    expect(probe.seams).toMatch(/existing UVs/);
  });

  it('12 textured meshes fire the many-textured-meshes rule', () => {
    const probe = AdaptiveUvOrchestrator.probeTopology(createMockGlb({ submeshCount: 12, height: 10.0, width: 30.0, depth: 30.0, hasTexture: true }));
    expect(probe.submeshCount).toBe(12);
    expect(probe.imageCount).toBe(1);
    expect(probe.hasPrebakedTextures).toBe(true);
    expect(probe.rules.manyTexturedMeshes).toBe(true);
    expect(probe.recommendedStrategy).toBe('recipe_hybrid');
    expect(probe.routingRule).toContain('12 meshes >= 10');
    expect(probe.domainSource).toBe('routing_rule');
  });

  it('an elongated untextured mesh is classified organic by the rule, a squat one falls through to the default', () => {
    const tall = AdaptiveUvOrchestrator.probeTopology(createMockGlb({ submeshCount: 1, height: 6.0, width: 1.0, depth: 1.0 }));
    expect(tall.rules.elongatedUntextured).toBe(true);
    expect(tall.domainClassification).toBe('organic');
    expect(tall.domainSource).toBe('routing_rule');
    const squat = AdaptiveUvOrchestrator.probeTopology(createMockGlb({ submeshCount: 1, height: 2.0, width: 2.0, depth: 2.0 }));
    expect(squat.domainClassification).toBe('nonorganic');
    expect(squat.recommendedStrategy).toBe('height_blended_triplanar');
    expect(squat.routingRule).toMatch(/^no other rule fired/);
    expect(squat.seams).toMatch(/different axes/);
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
