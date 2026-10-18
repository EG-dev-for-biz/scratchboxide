import * as path from 'path';
import * as fs from 'fs';
import { AlgorithmicUvEngine } from '../packages/core/src/node/spatial/AlgorithmicUvEngine';

async function main() {
  const inputGlbPath = path.resolve(__dirname, '../public/models/spce_scan_studio_raw_tile.glb');
  const outputGlbPath = path.resolve(__dirname, '../public/models/nyc_empire_state_building_pbr_enhanced.glb');

  console.log('[Algorithmic UV Engine] Processing ESB model with Toksvig AA & KHR extensions...');
  const t0 = Date.now();
  const result = await AlgorithmicUvEngine.processGlb({
    inputGlbPath,
    outputGlbPath,
    mode: 'preserve-100-lock',
    pbrDecomposition: {
      enableAlbedoDeLighting: true,
      // No solar de-lighting: the capture instant of the tile imagery is not known, and no date is assumed.
      enableHeightStratifiedDeLighting: true,
      enableMultiFrequencyNormals: true,
      enableBiophysicalRoughness: true,
      enableHbaoMicroCavity: true,
      enableToksvigFiltering: true,
      enableToksvigMipPyramid: true,
      toksvigMipLevels: 4
    },
    enableBoundarySeamWelding: true,
    boundaryToleranceMeters: 0.05,
    khrMaterials: {
      enableKhrMaterialsExtensions: true,
      enableTransmission: true,
      transmissionFactor: 0.92,
      ior: 1.52,
      enableAnisotropy: true,
      anisotropyStrength: 0.85,
      enableClearcoat: true,
      clearcoatFactor: 0.85
    }
  });

  const durationMs = Date.now() - t0;
  console.log('[Algorithmic UV Engine] Complete in', durationMs, 'ms:');
  console.log(JSON.stringify({
    success: result.success,
    triangles: result.trianglesProcessed,
    vertices: result.verticesProcessed,
    texels: result.texelsProcessed,
    solarDelightingApplied: result.solarDelightingApplied,
    solarSunVector: result.solarSunVector,
    khrExtensionsInjected: result.khrExtensionsInjected,
    boundaryWeldingResult: result.boundaryWeldingResult,
    imagesProcessed: result.imagesProcessed,
    imagesFailed: result.imagesFailed,
    attachments: result.attachments,
    executionTimeMs: result.executionTimeMs
  }, null, 2));
}

main().catch(err => {
  console.error('[Algorithmic UV Engine] Fatal error:', err);
  process.exit(1);
});
