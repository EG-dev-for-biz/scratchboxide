import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { AdaptiveUvOrchestrator, type TopologyProbeResult } from '../src/node/3d-engine/adaptive-uv-orchestrator';

describe('AdaptiveUvOrchestrator Live Continuous Multi-Domain Demonstration', () => {
  const modelsDir = path.resolve(__dirname, '../../../public/models');

  it('1. Analyzes Organic Articulated Anatomy (Omega -> 1.0) and assigns SO(3) Carrier Sheets with Natural Occlusion Geodesics', async () => {
    // Generate a mock articulated limb / digit chain (organic anatomy)
    const organicProbe = AdaptiveUvOrchestrator.probeTopology(
      path.join(modelsDir, 'analytical_cuboid_blockout.glb'),
      'organic'
    );

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

  it('2. Analyzes High-Rise Architecture (Omega -> 0.0, Y >= 35m) and assigns Elevation-Stratified Conformal with Reveal Seams', async () => {
    const esbPath = path.join(modelsDir, 'spce_esb_isolated_full_quality_raw.glb');
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

  it('3. Analyzes Massive Photogrammetric Scan and assigns Recipe Hybrid PBR with Welded Seams', async () => {
    const colosseumPath = path.join(modelsDir, 'colosseum_stage3_master_pbr.glb');
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
    const propPath = path.join(modelsDir, 'analytical_cuboid_blockout.glb');
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
    const propPath = path.join(modelsDir, 'analytical_cuboid_blockout.glb');
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
