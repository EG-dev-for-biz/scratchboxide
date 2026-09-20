const path = require('path');
const { GlbTextureRecolorService, DEFAULT_NANO_BANANA_GLB_PALETTE } = require('../packages/core/dist/node/spatial/GlbTextureRecolorService.js');

async function main() {
  const inputGlb = path.resolve(__dirname, '../public/models/colosseum_rome_textured.glb');
  const outputGlb = path.resolve(__dirname, '../public/models/colosseum_rome_recolored.glb');

  console.log('🏛️ Starting Architecture 2 Offline Texture Atlas Re-grade on Real Colosseum GLB...');
  console.log('Input:', inputGlb);
  console.log('Output:', outputGlb);

  const t0 = performance.now();
  const result = await GlbTextureRecolorService.recolorGlb(inputGlb, outputGlb, {
    concurrency: 8,
    shadowLift: 0.7,
    highlightCompress: 0.4,
    midtoneWeight: 0.75,
    jpegQuality: 2
  });

  const totalTime = ((performance.now() - t0) / 1000).toFixed(2);
  console.log('\n✅ Successfully recolored Colosseum GLB!');
  console.log(`- Textures Processed: ${result.textureCount}`);
  console.log(`- Original Size: ${(result.originalByteLength / 1024 / 1024).toFixed(2)} MB`);
  console.log(`- Recolored Size: ${(result.recoloredByteLength / 1024 / 1024).toFixed(2)} MB`);
  console.log(`- Total Duration: ${totalTime}s`);
}

main().catch(err => {
  console.error('❌ Error recoloring Colosseum GLB:', err);
  process.exit(1);
});
