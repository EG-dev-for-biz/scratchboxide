import * as path from 'path';
import * as fs from 'fs';
import { AlgorithmicUvEngine } from '../packages/core/src/node/spatial/AlgorithmicUvEngine';

async function main() {
  const inputGlbPath = path.resolve(__dirname, '../public/models/spce_scan_studio_raw_tile.glb');
  const outputGlbPath = path.resolve(__dirname, '../public/models/nyc_empire_state_building_pbr_enhanced.glb');

  console.log('[Algorithmic UV Engine] Processing ESB model with NOAA solar inverse delighting, Toksvig AA & KHR extensions...');
  const t0 = Date.now();
  const result = await AlgorithmicUvEngine.processGlb({
    inputGlbPath,
    outputGlbPath,
    mode: 'preserve-100-lock',
    pbrDecomposition: {
      enableAlbedoDeLighting: true,
      enableSolarInverseDelighting: true,
      solarDelighting: {
        latitude: 40.74844,
        longitude: -73.98566,
        timestampIso: '2024-06-21T17:00:00Z',
        regularizationEpsilon: 0.18,
        directSunWeight: 0.65,
        ambientSkyWeight: 0.35
      },
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
    toksvigMipLevelsGenerated: result.toksvigMipLevelsGenerated,
    executionTimeMs: result.executionTimeMs
  }, null, 2));
}

main().catch(err => {
  console.error('[Algorithmic UV Engine] Fatal error:', err);
  process.exit(1);
});
