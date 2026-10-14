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

describe('AdaptiveUvOrchestrator Live Continuous Multi-Domain Demonstration', () => {
  afterAll(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));

  it('1. Analyzes Organic Articulated Anatomy (Omega -> 1.0) and assigns SO(3) Carrier Sheets with Natural Occlusion Geodesics', async () => {
    // Generate a mock articulated limb / digit chain (organic anatomy)
    const organicProbe = AdaptiveUvOrchestrator.probeTopology(DIGIT_CHAIN_GLB, 'organic');

    console.log('\n--- [ORCHESTRATOR PROBE 1: ORGANIC ARTICULATED ANATOMY] ---');
    console.log(`Domain: ${organicProbe.domainClassification}`);
    console.log(`Organicity Index (\u03a9): ${organicProbe.organicityIndex.toFixed(2)} [1.0 = Pure Organic Anatomy]`);
    console.log(`Recommended UV Strategy: ${organicProbe.recommendedStrategy}`);
    console.log(`Seam Placement: ${organicProbe.seamStrategy.seamPlacement}`);
    console.log(`Seam Mitigation: ${organicProbe.seamStrategy.seamMitigationMethod}`);
    console.log(`Recommended Gutter Padding: ${organicProbe.seamStrategy.recommendedGutterPaddingPx}px`);
    console.log(`MikkTSpace Handedness Guaranteed: ${organicProbe.seamStrategy.tangentSpaceHandednessGuaranteed}`);
    console.log(`Seam Rationale: ${organicProbe.seamStrategy.seamRationale}`);

    expect(organicProbe.domainClassification).toBe('organic');
    expect(organicProbe.organicityIndex).toBe(1.0);
    expect(organicProbe.recommendedStrategy).toBe('carrier_conformal_sheet');
    expect(organicProbe.seamStrategy.seamPlacement).toBe('natural_occlusion_geodesics');
    expect(organicProbe.seamStrategy.seamMitigationMethod).toBe('hermite_margin_overlap');
    expect(organicProbe.seamStrategy.recommendedGutterPaddingPx).toBe(8);
    expect(organicProbe.seamStrategy.tangentSpaceHandednessGuaranteed).toBe(true);
  });

  it.skipIf(!esbRaw.ok)(withReason('2. Analyzes High-Rise Architecture (Omega -> 0.0, Y >= 35m) and assigns Elevation-Stratified Conformal with Reveal Seams', esbRaw), async () => {
    const esbPath = path.join(REPO_ROOT, ESB_RAW);
    expect(fs.existsSync(esbPath)).toBe(true);

    const esbProbe = AdaptiveUvOrchestrator.probeTopology(esbPath);

    console.log('\n--- [ORCHESTRATOR PROBE 2: HIGH-RISE ARCHITECTURE (EMPIRE STATE BUILDING)] ---');
    console.log(`Domain: ${esbProbe.domainClassification}`);
    console.log(`Organicity Index (\u03a9): ${esbProbe.organicityIndex.toFixed(2)} [0.0 = Inorganic Mineral/Hard-Surface]`);
    console.log(`Dimensions (m): [${esbProbe.bounds.dimensions.map(d => d.toFixed(1)).join(', ')}]`);
    console.log(`Height: ${esbProbe.bounds.dimensions[1].toFixed(1)}m (>= 35m: ${esbProbe.isHighRiseArchitecture})`);
    console.log(`Recommended UV Strategy: ${esbProbe.recommendedStrategy}`);
    console.log(`Seam Placement: ${esbProbe.seamStrategy.seamPlacement}`);
    console.log(`Seam Mitigation: ${esbProbe.seamStrategy.seamMitigationMethod}`);
    console.log(`Recommended Gutter Padding: ${esbProbe.seamStrategy.recommendedGutterPaddingPx}px`);
    console.log(`Rationale: ${esbProbe.rationale}`);

    expect(esbProbe.domainClassification).toBe('nonorganic');
    expect(esbProbe.isHighRiseArchitecture).toBe(true);
    expect(esbProbe.recommendedStrategy).toBe('elevation_stratified_conformal');
    expect(esbProbe.seamStrategy.seamPlacement).toBe('architectural_reveals_and_mullions');
    expect(esbProbe.seamStrategy.seamMitigationMethod).toBe('gutter_dilation_clamping');
    expect(esbProbe.seamStrategy.recommendedGutterPaddingPx).toBe(16);
  });

  it.skipIf(!colosseumMasterPbr.ok)(withReason('3. Analyzes Massive Photogrammetric Scan and assigns Recipe Hybrid PBR with Welded Seams', colosseumMasterPbr), async () => {
    const colosseumPath = path.join(REPO_ROOT, COLOSSEUM_MASTER_PBR);
    expect(fs.existsSync(colosseumPath)).toBe(true);

    const scanProbe = AdaptiveUvOrchestrator.probeTopology(colosseumPath);

    console.log('\n--- [ORCHESTRATOR PROBE 3: MASSIVE PHOTOGRAMMETRIC SCAN (COLOSSEUM)] ---');
    console.log(`Domain: ${scanProbe.domainClassification}`);
    console.log(`Submesh Count: ${scanProbe.submeshCount} (>= 10 submeshes: ${scanProbe.isMassiveScan})`);
    console.log(`Has Pre-Baked Textures: ${scanProbe.hasPrebakedTextures}`);
    console.log(`Total Triangles: ${scanProbe.triangleCount.toLocaleString()}`);
    console.log(`Recommended UV Strategy: ${scanProbe.recommendedStrategy}`);
    console.log(`Seam Placement: ${scanProbe.seamStrategy.seamPlacement}`);
    console.log(`Seam Mitigation: ${scanProbe.seamStrategy.seamMitigationMethod}`);
    console.log(`Seam Rationale: ${scanProbe.seamStrategy.seamRationale}`);

    expect(scanProbe.domainClassification).toBe('nonorganic');
    expect(scanProbe.isMassiveScan).toBe(true);
    expect(scanProbe.recommendedStrategy).toBe('recipe_hybrid');
    expect(scanProbe.seamStrategy.seamPlacement).toBe('photogrammetric_boundary_welded');
    expect(scanProbe.seamStrategy.seamMitigationMethod).toBe('affine_edge_altitude_bevel');
  });

  it('4. Analyzes Rigid Mechanical CAD / Prop and assigns Continuous Height-Blended Triplanar with Zero Seams', async () => {
    const propPath = CAD_PROP_GLB;
    expect(fs.existsSync(propPath)).toBe(true);

    const propProbe = AdaptiveUvOrchestrator.probeTopology(propPath);

    console.log('\n--- [ORCHESTRATOR PROBE 4: RIGID CAD / MECHANICAL PROP] ---');
    console.log(`Domain: ${propProbe.domainClassification}`);
    console.log(`Organicity Index (\u03a9): ${propProbe.organicityIndex.toFixed(2)}`);
    console.log(`Dimensions (m): [${propProbe.bounds.dimensions.map(d => d.toFixed(1)).join(', ')}]`);
    console.log(`Recommended UV Strategy: ${propProbe.recommendedStrategy}`);
    console.log(`Seam Placement: ${propProbe.seamStrategy.seamPlacement}`);
    console.log(`Seam Mitigation: ${propProbe.seamStrategy.seamMitigationMethod}`);
    console.log(`Recommended Gutter Padding: ${propProbe.seamStrategy.recommendedGutterPaddingPx}px`);

    expect(propProbe.domainClassification).toBe('nonorganic');
    expect(propProbe.recommendedStrategy).toBe('height_blended_triplanar');
    expect(propProbe.seamStrategy.seamPlacement).toBe('zero_seams_continuous');
    expect(propProbe.seamStrategy.seamMitigationMethod).toBe('triplanar_height_blended');
    expect(propProbe.seamStrategy.recommendedGutterPaddingPx).toBe(0);
  });

  it('5. Executes applyAdaptivePbr with Recipe Hybrid & Seam Healing', async () => {
    const propPath = CAD_PROP_GLB;
    const result = await AdaptiveUvOrchestrator.applyAdaptivePbr({
      inputGlbPath: propPath,
      strategy: 'recipe_hybrid',
      recipeOutputMode: 'webgl-recipe'
    });

    console.log('\n--- [ORCHESTRATOR EXECUTION RESULT] ---');
    console.log(`Applied Strategy: ${result.appliedStrategy}`);
    console.log(`Domain Classification: ${result.domainClassification}`);
    console.log(`Seam Placement: ${result.seamStrategy.seamPlacement}`);
    console.log(`Seam Mitigation: ${result.seamStrategy.seamMitigationMethod}`);
    console.log(`Execution Time: ${result.executionTimeMs}ms`);
    console.log(`GLB Buffer Size: ${result.glbBuffer?.length} bytes`);

    expect(result.appliedStrategy).toBe('recipe_hybrid');
    expect(result.glbBuffer).toBeDefined();
    expect(result.glbBuffer!.readUInt32LE(0)).toBe(0x46546c67); // glTF magic
  });
});
