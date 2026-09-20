const path = require('path');
const fs = require('fs');
const {
  GlbTextureRecolorService,
  DEFAULT_NANO_BANANA_GLB_PALETTE,
  DEFAULT_FOLIAGE_LAB,
  DEFAULT_ASPHALT_LAB
} = require('../packages/core/dist/node/spatial/GlbTextureRecolorService.js');

async function main() {
  const inputGlb = path.resolve(__dirname, '../public/models/colosseum_rome_textured.glb');
  const outputGlb = path.resolve(__dirname, '../public/models/colosseum_rome_sophisticated_recolored.glb');

  console.log('🏛️ Starting Architecture 2 v2 (Sophisticated) Texture Atlas Re-grade on Real Colosseum GLB...');
  console.log('Input:', inputGlb);
  console.log('Output:', outputGlb);

  const t0 = performance.now();
  const result = await GlbTextureRecolorService.recolorGlb(inputGlb, outputGlb, {
    concurrency: 12,
    shadowLift: 0.7,
    highlightCompress: 0.4,
    midtoneWeight: 0.75,
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
      normalStrength: 2.2,
      generateRoughnessMaps: true,
      masonryRoughness: 0.88,
      foliageRoughness: 0.72,
      asphaltRoughness: 0.48
    }
  });

  const totalTime = ((performance.now() - t0) / 1000).toFixed(2);
  console.log('\n✅ Successfully synthesized Sophisticated Colosseum GLB!');
  console.log(`- Textures Processed: ${result.textureCount}`);
  console.log(`- Original Size: ${(result.originalByteLength / 1024 / 1024).toFixed(2)} MB`);
  console.log(`- Recolored + PBR Size: ${(result.recoloredByteLength / 1024 / 1024).toFixed(2)} MB`);
  console.log(`- Normal Maps Attached: ${result.pbrGenerated?.normalMapCount || 0}`);
  console.log(`- Roughness Maps Attached: ${result.pbrGenerated?.roughnessMapCount || 0}`);
  console.log(`- Total Duration: ${totalTime}s`);
}

main().catch(err => {
  console.error('❌ Error executing sophisticated recolor:', err);
  process.exit(1);
});
