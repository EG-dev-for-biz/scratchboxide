/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as path from 'path';
import * as fs from 'fs-extra';
import { SurveySynthesisEngine } from '../packages/core/src/common/spatial/SurveySynthesisEngine';
import { SurveySplatPipelineService } from '../packages/core/src/node/spatial/SurveySplatPipelineService';
import { createDefaultStationImageGenerator } from '../packages/core/src/node/spatial/BeautifyStationService';
import type { GeodeticAnchor } from '../packages/core/src/common/spatial/colmap-vector-reference-types';
import { SplatService } from '../packages/core/src/node/3d-engine/splat-service';

async function main() {
  const rootDir = path.resolve(__dirname, '..');
  const glbPath = path.join(rootDir, 'public/models/red_rocks_amphitheatre.glb');
  const outDir = path.join(rootDir, 'public/tilesets/red_rocks');

  console.log('========================================================================');
  console.log('🎸 RECONSTRUCTING RED ROCKS AMPHITHEATRE AS 3D GAUSSIAN SPLATS (3DGS)');
  console.log('========================================================================');

  if (!fs.existsSync(glbPath)) {
    throw new Error(`Input Red Rocks 3D Tiles GLB not found at: ${glbPath}`);
  }

  const ANCHOR: GeodeticAnchor = {
    lat: 39.66555,
    lng: -105.20525,
    elevationMeters: 1932.0,
    headingDeg: 285.0,
    formattedAddress: 'Red Rocks Amphitheatre, Morrison, Colorado, USA'
  };

  const engine = new SurveySynthesisEngine();

  // Synthesize 12 survey stations across 3 altitude tiers around Red Rocks acoustic center
  console.log('[1/4] Synthesizing 12 multi-tier survey stations around Red Rocks...');
  const stations = engine.synthesize(ANCHOR, {
    type: 'orbital-multi-tier',
    targetRadiusMeters: 95.0,
    cameraCount: 12,
    focalLengthMm: 28,
    lookAtOffsetLocalENU: [5.2, 4.46, 0.0], // Aligned to Red Rocks stage center
    altitudeTiersMeters: [
      ANCHOR.elevationMeters + 12.0, // Stage & FOH eye level
      ANCHOR.elevationMeters + 35.0, // Middle acoustic seating bowl & sandstone base
      ANCHOR.elevationMeters + 70.0  // Upper canyon rim overview
    ]
  });

  console.log(`Generated ${stations.length} survey camera stations.`);

  // Station images come from the image model (there is no procedural painter); this run makes billed calls.
  const generator = createDefaultStationImageGenerator();
  const pipeline = new SurveySplatPipelineService({ generator });

  console.log('[2/4] Running SurveySplatPipelineService: Render -> Beautify -> Bake -> Fuse -> 3D Tiles...');
  const t0 = Date.now();

  const result = await pipeline.run({
    glbPath,
    anchor: ANCHOR,
    stations,
    outDir,
    beautify: {
      locationName: 'Red Rocks Amphitheatre',
      moodPromptContext: 'Warm golden hour sunlight over towering red sandstone rock formations, acoustic amphitheater seating, and natural concert stage.'
    },
    renderWidth: 960,
    bakeStride: 2,
    mode: 'chained',
    clean: true,
    forceRebake: true,
    cropRadius: 180.0,
    isoDate: '2026-06-21T19:30:00Z'
  }, (progress, msg) => {
    console.log(`  [Progress ${(progress * 100).toFixed(0)}%] ${msg || ''}`);
  });

  const durationSec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[3/4] Pipeline completed in ${durationSec}s!`);
  console.log(`  -> Fused Splat Count: ${result.fusedSplatCount.toLocaleString()} 3D Gaussians`);
  console.log(`  -> Fused Splat File: ${result.fusedSplatPath} (${(fs.statSync(result.fusedSplatPath).size / 1024 / 1024).toFixed(2)} MB)`);
  console.log(`  -> 3D Tileset: ${result.tilesetPath}`);

  // Also encode compressed .spz for ultra-fast web streaming
  console.log('[4/4] Generating compressed SPZ representation for web streaming...');
  const splatService = new SplatService();
  const spzPath = path.join(outDir, 'fused.spz');
  await splatService.runPipeline({
    inputPath: result.fusedSplatPath,
    outSpzPath: spzPath
  });

  if (fs.existsSync(spzPath)) {
    console.log(`  -> Compressed SPZ: ${spzPath} (${(fs.statSync(spzPath).size / 1024 / 1024).toFixed(2)} MB)`);
  }

  // Copy fused.splat and fused.spz to public/models/ for direct model viewer convenience
  const pubModelSplat = path.join(rootDir, 'public/models/red_rocks_venue.splat');
  const pubModelSpz = path.join(rootDir, 'public/models/red_rocks_venue.spz');
  fs.copyFileSync(result.fusedSplatPath, pubModelSplat);
  if (fs.existsSync(spzPath)) {
    fs.copyFileSync(spzPath, pubModelSpz);
  }
  console.log(`  -> Copied to ${pubModelSplat} and ${pubModelSpz}`);

  console.log('========================================================================');
  console.log('🎉 RED ROCKS 3D GAUSSIAN SPLATS VENUE RECONSTRUCTION COMPLETE!');
  console.log('========================================================================');
}

main().catch(err => {
  console.error('Fatal pipeline error:', err);
  process.exit(1);
});
