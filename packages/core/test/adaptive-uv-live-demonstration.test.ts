import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AdaptiveUvOrchestrator, type TopologyProbeResult } from '../src/node/3d-engine/adaptive-uv-orchestrator';
import { GltfBinaryPacker } from '../src/node/3d-engine/gltf-binary-packer';
import { REPO_ROOT, requireAsset, withReason } from './helpers/requirements';

type Box = { min: [number, number, number]; max: [number, number, number] };

/** Untextured GLB with one mesh (position, normal, per-face UV, indices) per axis-aligned box. */
function packBoxesGlb(boxes: Box[]): Buffer {
  const views: Buffer[] = [];
  const gltf: any = { asset: { version: '2.0', generator: 'adaptive-uv-test-fixture' }, scene: 0, scenes: [{ nodes: [] }], nodes: [], meshes: [], accessors: [], bufferViews: [] };
  const addView = (b: Buffer, target: number) => { views.push(b); gltf.bufferViews.push({ buffer: 0, target }); return views.length - 1; };
  // 6 faces x 4 corners; each face: outward normal and the corner selectors along x/y/z
  const faces: Array<{ n: [number, number, number]; c: Array<[number, number, number]> }> = [
    { n: [1, 0, 0], c: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]] },
    { n: [-1, 0, 0], c: [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]] },
    { n: [0, 1, 0], c: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]] },
    { n: [0, -1, 0], c: [[0, 0, 1], [0, 0, 0], [1, 0, 0], [1, 0, 1]] },
    { n: [0, 0, 1], c: [[1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]] },
    { n: [0, 0, -1], c: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]] }
  ];
  boxes.forEach((b, i) => {
    const pos: number[] = [], nrm: number[] = [], uv: number[] = [], idx: number[] = [];
    for (const f of faces) {
      const base = pos.length / 3;
      for (const c of f.c) { for (let k = 0; k < 3; k++) pos.push(c[k] ? b.max[k] : b.min[k]); nrm.push(...f.n); }
      uv.push(0, 0, 0, 1, 1, 1, 1, 0);
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    const a = gltf.accessors.length;
    gltf.accessors.push({ bufferView: addView(Buffer.from(new Float32Array(pos).buffer), 34962), componentType: 5126, count: pos.length / 3, type: 'VEC3', min: [...b.min], max: [...b.max] });
    gltf.accessors.push({ bufferView: addView(Buffer.from(new Float32Array(nrm).buffer), 34962), componentType: 5126, count: nrm.length / 3, type: 'VEC3' });
    gltf.accessors.push({ bufferView: addView(Buffer.from(new Float32Array(uv).buffer), 34962), componentType: 5126, count: uv.length / 2, type: 'VEC2' });
    gltf.accessors.push({ bufferView: addView(Buffer.from(new Uint32Array(idx).buffer), 34963), componentType: 5125, count: idx.length, type: 'SCALAR' });
    gltf.meshes.push({ primitives: [{ mode: 4, attributes: { POSITION: a, NORMAL: a + 1, TEXCOORD_0: a + 2 }, indices: a + 3 }] });
    gltf.nodes.push({ mesh: i, name: `box_${i}` });
    gltf.scenes[0].nodes.push(i);
  });
  return GltfBinaryPacker.packGlb(gltf, views, true).glbBuffer;
}

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-adaptive-uv-'));
// Articulated digit chain: four stacked phalanx segments, 2 cm thick and 17 cm long (slender, untextured).
const DIGIT_CHAIN_GLB = path.join(fixtureDir, 'digit_chain.glb');
fs.writeFileSync(DIGIT_CHAIN_GLB, packBoxesGlb([0, 1, 2, 3].map(k => ({
  min: [-0.01, k * 0.0425, -0.01], max: [0.01, k * 0.0425 + 0.04, 0.01]
}) as Box)));
// Rigid mechanical CAD prop: a machined base block with an offset housing on top (untextured, low-rise, 2 parts).
const CAD_PROP_GLB = path.join(fixtureDir, 'cad_prop.glb');
fs.writeFileSync(CAD_PROP_GLB, packBoxesGlb([
  { min: [-2, 0, -1.5], max: [2, 1, 1.5] },
  { min: [-0.5, 1, -0.5], max: [1, 2.5, 0.5] }
]));

const ESB_RAW = 'public/models/spce_esb_isolated_full_quality_raw.glb';
const COLOSSEUM_MASTER_PBR = 'public/models/colosseum_stage3_master_pbr.glb';
const esbRaw = requireAsset(ESB_RAW, 'scripts/refine_isolated_esb_mesh.py');
const colosseumMasterPbr = requireAsset(COLOSSEUM_MASTER_PBR, 'scripts/apply_master_pbr_pipeline.cjs');

describe('AdaptiveUvOrchestrator probe on real assets: measured values and the rule that routed each', () => {
  afterAll(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));

  it('1. a digit chain with the caller-given organic domain routes to carrier_conformal_sheet (run as box projection)', async () => {
    const probe = AdaptiveUvOrchestrator.probeTopology(DIGIT_CHAIN_GLB, 'organic');
    console.log(`[probe 1] ${probe.rationale}`);
    expect(probe.domainClassification).toBe('organic');
    expect(probe.domainSource).toBe('caller');
    expect(probe.recommendedStrategy).toBe('carrier_conformal_sheet');
    expect(probe.methodThatRuns).toMatch(/^box_projection_uv/);
    expect(probe.triangleCount).toBeGreaterThan(0);
  });

  it.skipIf(!esbRaw.ok)(withReason('2. the Empire State Building mesh fires the tall-slender rule', esbRaw), async () => {
    const probe = AdaptiveUvOrchestrator.probeTopology(path.join(REPO_ROOT, ESB_RAW));
    console.log(`[probe 2] ${probe.rationale}`);
    expect(probe.bounds.dimensions[1]).toBeGreaterThanOrEqual(35);
    expect(probe.rules.tallSlender).toBe(true);
    expect(probe.recommendedStrategy).toBe('elevation_stratified_conformal');
    expect(probe.routingRule).toContain('>= 35');
  });

  it.skipIf(!colosseumMasterPbr.ok)(withReason('3. the Colosseum scan fires the many-textured-meshes rule', colosseumMasterPbr), async () => {
    const probe = AdaptiveUvOrchestrator.probeTopology(path.join(REPO_ROOT, COLOSSEUM_MASTER_PBR));
    console.log(`[probe 3] ${probe.rationale}`);
    expect(probe.submeshCount).toBeGreaterThanOrEqual(10);
    expect(probe.hasPrebakedTextures).toBe(true);
    expect(probe.rules.manyTexturedMeshes).toBe(true);
    expect(probe.recommendedStrategy).toBe('recipe_hybrid');
  });

  it('4. a CAD prop fires no rule and falls through to height_blended_triplanar (run as box projection)', async () => {
    expect(fs.existsSync(CAD_PROP_GLB)).toBe(true);
    const probe = AdaptiveUvOrchestrator.probeTopology(CAD_PROP_GLB);
    console.log(`[probe 4] ${probe.rationale}`);
    expect(probe.domainClassification).toBe('nonorganic');
    expect(probe.recommendedStrategy).toBe('height_blended_triplanar');
    expect(probe.routingRule).toMatch(/^no other rule fired/);
    expect(probe.seams).toMatch(/different axes/);
  });

  it('5. applyAdaptivePbr with recipe_hybrid returns a GLB and names the method', async () => {
    const result = await AdaptiveUvOrchestrator.applyAdaptivePbr({
      inputGlbPath: CAD_PROP_GLB,
      strategy: 'recipe_hybrid',
      recipeOutputMode: 'webgl-recipe'
    });
    expect(result.appliedStrategy).toBe('recipe_hybrid');
    expect(result.appliedMethod.method).toBe('recipe_hybrid_vertex_attributes');
    expect(result.glbBuffer).toBeDefined();
    expect(result.glbBuffer!.readUInt32LE(0)).toBe(0x46546c67); // glTF magic
  });
});
