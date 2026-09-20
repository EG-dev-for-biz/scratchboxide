#!/usr/bin/env node
/********************************************************************************
 * Google Maps 3D Tiles Studio Clay Downloader
 * 
 * Streams Google Maps Photorealistic 3D Tiles for any location or address,
 * strips all photographic/diffuse textures, applies studio grey clay PBR,
 * and exports standardized binary glTF 2.0 (.glb) meshes directly to disk.
 ********************************************************************************/

const path = require('path');
const fs = require('fs');

async function main() {
  const args = process.argv.slice(2);
  let locationQuery = null;
  let customDest = null;
  let radiusMeters = 350;
  let batchFile = null;
  let clayPreset = 'studio-grey';

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--location' || args[i] === '-l') && args[i + 1]) locationQuery = args[++i];
    if ((args[i] === '--dest' || args[i] === '-d') && args[i + 1]) customDest = args[++i];
    if ((args[i] === '--radius' || args[i] === '-r') && args[i + 1]) radiusMeters = parseFloat(args[++i]);
    if ((args[i] === '--batch' || args[i] === '-b') && args[i + 1]) batchFile = args[++i];
    if (args[i] === '--preset' && args[i + 1]) clayPreset = args[++i];
  }

  // Resolve target directory
  const destDir = customDest || (
    fs.existsSync('/Volumes/G-RAID MIRROR') 
      ? '/Volumes/G-RAID MIRROR/google_clay_tiles' 
      : path.join(process.cwd(), 'data', 'google_clay_tiles')
  );

  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  // Load the core service
  let getGoogle3DTilesClay;
  try {
    const mod = require('../packages/core/dist/node/spatial/Google3DTileBlockoutPipelineService.js');
    getGoogle3DTilesClay = mod.getGoogle3DTilesClay;
  } catch (err) {
    try {
      // Fallback for ts-node / tsx
      require('ts-node/register');
      const mod = require('../packages/core/src/node/spatial/Google3DTileBlockoutPipelineService.ts');
      getGoogle3DTilesClay = mod.getGoogle3DTilesClay;
    } catch (e) {
      console.error('[Error] Could not load Google3DTileBlockoutPipelineService:', err.message);
      process.exit(1);
    }
  }

  console.log('================================================================');
  console.log('       GOOGLE MAPS 3D TILES — STUDIO CLAY INGESTION            ');
  console.log('================================================================');
  console.log(` Target Storage Path : ${destDir}`);
  console.log(` Render Mode         : Studio Grey Clay (No Photographic Textures)`);
  console.log(` Clay Preset         : ${clayPreset}`);
  console.log(` LOD Quality Target  : Leaf Octree LOD (errorTarget <= 0.5)`);
  console.log('----------------------------------------------------------------');

  const targets = [];
  if (batchFile && fs.existsSync(batchFile)) {
    const raw = JSON.parse(fs.readFileSync(batchFile, 'utf8'));
    targets.push(...raw);
  } else if (locationQuery) {
    targets.push({ query: locationQuery, radiusMeters });
  } else {
    // Default high-profile sample if no argument provided
    targets.push({
      name: 'Midtown_Manhattan_ESB',
      query: 'Empire State Building, NYC (40.748400, -73.985700)',
      radiusMeters: 400
    });
  }

  for (const target of targets) {
    const name = target.name || target.query.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
    const outputGlbPath = path.join(destDir, `${name}_clay.glb`);

    console.log(`\n[Ingesting] ${target.query}`);
    console.log(`  -> Output GLB: ${outputGlbPath}`);

    try {
      const startTime = Date.now();
      const result = await getGoogle3DTilesClay(target.query, {
        outputGlbPath,
        radiusMeters: target.radiusMeters || radiusMeters,
        clayPreset,
        lodQuality: {
          errorTarget: 0.5,
          maxSettleWaitMs: 12000
        }
      });

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const stats = fs.existsSync(outputGlbPath) ? fs.statSync(outputGlbPath) : null;
      const sizeMB = stats ? (stats.size / (1024 * 1024)).toFixed(2) : '0';

      console.log(`  ✓ [DONE] Exported in ${elapsed}s: ${sizeMB} MB`);
      if (result.mesh) {
        console.log(`    - Vertices : ${result.mesh.vertexCount?.toLocaleString() || 'N/A'}`);
        console.log(`    - Triangles: ${result.mesh.triangleCount?.toLocaleString() || 'N/A'}`);
      }
    } catch (err) {
      console.error(`  ✗ [FAILED] ${err.message}`);
    }
  }

  console.log('\n================================================================');
  console.log(' Ingestion complete. All clay 3D models saved to disk.');
  console.log('================================================================\n');
}

if (require.main === module) {
  main().catch(err => {
    console.error('[Fatal Error]', err);
    process.exit(1);
  });
}
