const path = require('path');
const fs = require('fs');
const {
  GlbTextureRecolorService,
  DEFAULT_FOLIAGE_LAB,
  DEFAULT_ASPHALT_LAB
} = require('../packages/core/dist/node/spatial/GlbTextureRecolorService.js');

async function main() {
  const inputGlb = path.resolve(__dirname, '../public/models/colosseum_rome_textured.glb');
  const outputGlb = path.resolve(__dirname, '../public/models/colosseum_rome_regrade_realistic.glb');

  console.log('🏛️ Starting Architecture 2 (Realistic Tuned) Texture Atlas Re-grade on Real Colosseum GLB...');
  console.log('Input:', inputGlb);
  console.log('Output:', outputGlb);

  // Tuned for natural realism rather than extreme saturated terracotta:
  // - Balanced warm Roman travertine/aged brick stone tone (a: 14, b: 22 vs extreme a: 38, b: 30)
  // - Midtone weight 0.35 (preserves 65% of authentic photogrammetric stone nuance vs washing out 75%)
  // - Subtle Prussian blue shadow ambient fill without unnatural electric blue
  // - Protected deep cypress emerald foliage (#1D3B2E) and slate roadway asphalt (#232832)
  const REALISTIC_TUNED_PALETTE = {
    shadow: { L: 16.0, a: 1.0, b: -8.0 },
    midtone: { L: 66.0, a: 14.0, b: 22.0 },
    highlight: { L: 88.0, a: 8.0, b: 26.0 },
    accent: { L: 60.0, a: 4.0, b: -20.0 }
  };

  const t0 = performance.now();
  const result = await GlbTextureRecolorService.recolorGlb(inputGlb, outputGlb, {
    concurrency: 12,
    palette: REALISTIC_TUNED_PALETTE,
    shadowLift: 0.65,
    highlightCompress: 0.35,
    midtoneWeight: 0.35,
    jpegQuality: 2,
    segmentation: {
      enableSegmentation: true,
      protectFoliage: true,
      foliageColor: DEFAULT_FOLIAGE_LAB,
      protectAsphalt: true,
      asphaltColor: DEFAULT_ASPHALT_LAB
    },
    pbr: {
      generateNormalMaps: true,
      normalStrength: 1.8,
      generateRoughnessMaps: true,
      masonryRoughness: 0.82,
      foliageRoughness: 0.72,
      asphaltRoughness: 0.50
    }
  });

  const totalTime = ((performance.now() - t0) / 1000).toFixed(2);
  console.log('\n✅ Successfully synthesized Realistic Tuned Colosseum GLB!');
  console.log(`- Textures Processed: ${result.textureCount}`);
  console.log(`- Original Size: ${(result.originalByteLength / 1024 / 1024).toFixed(2)} MB`);
  console.log(`- Recolored + PBR Size: ${(result.recoloredByteLength / 1024 / 1024).toFixed(2)} MB`);
  console.log(`- Normal Maps Attached: ${result.pbrGenerated?.normalMapCount || 0}`);
  console.log(`- Roughness Maps Attached: ${result.pbrGenerated?.roughnessMapCount || 0}`);
  console.log(`- Total Duration: ${totalTime}s`);
}

main().catch(err => {
  console.error('❌ Error executing realistic recolor:', err);
  process.exit(1);
});
