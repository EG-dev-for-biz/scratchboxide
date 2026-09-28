const fs = require('fs');
const path = require('path');

const rootDir = process.cwd();
const publicDir = path.join(rootDir, 'public');
const distDir = path.join(rootDir, 'desktop-app/dist');

const demos = [
  'colosseum_recolor_proof.html',
  'spatial_photoreal_3dgs_demo.html',
  'agent_lighting_proof.html',
  'nano_banana_texture_upscale_experiment.html',
  'geobox_eval_report.html',
  'vfx_plate_anti_drift_demo.html',
  'colmap_visualizer.html',
  'botanical_visualizer.html',
  'plaza_matchmove_demo.html',
  'geobox_demo.html',
  's4d_multi_gallery.html',
  'red_rocks_performer_demo.html',
  'universal_architecture_terrain_demo.html',
  'forest_3d_viewer.html',
  'video_to_4d_performer_studio.html',
  'adaptive_matchmove_studio.html',
  'person_matchmove_studio.html',
  'google_360_panorama_studio.html',
  'depthbox_image_to_3dgs.html',
  'asset_demo_studio.html'
];

console.log('======================================================================');
console.log('🔍 VERIFYING ALL 20 SHOWCASE DEMOS & ASSET PACKAGES');
console.log('======================================================================\n');

let allPassed = true;
const summary = [];

for (const demoFile of demos) {
  const pubHtml = path.join(publicDir, demoFile);
  const distHtml = path.join(distDir, demoFile);

  const existsPub = fs.existsSync(pubHtml);
  const existsDist = fs.existsSync(distHtml);

  if (!existsPub || !existsDist) {
    console.error(`❌ HTML Missing: ${demoFile} (public: ${existsPub}, dist: ${existsDist})`);
    allPassed = false;
    summary.push({ demo: demoFile, status: 'HTML_MISSING' });
    continue;
  }

  const content = fs.readFileSync(pubHtml, 'utf8');

  // Find all asset references
  const assetRegex = /(?:src|href|url|file|durableUri|sourcePath|sourceVideoUri|glbUrl)\s*[:=]\s*['"]([^'"]+\.(?:glb|gltf|mp4|webm|splat|spz|ply|jpg|jpeg|png|json))['"]/gi;
  let match;
  const assets = new Set();

  while ((match = assetRegex.exec(content)) !== null) {
    const raw = match[1];
    if (raw.startsWith('http:') || raw.startsWith('https:') || raw.startsWith('data:') || raw.startsWith('#') || raw.startsWith('//')) {
      continue;
    }
    assets.add(raw.replace(/^\.\//, '').replace(/^\//, ''));
  }

  let missingCount = 0;
  const missingList = [];

  for (const assetRel of assets) {
    // skip dynamic placeholders like [0], {id}, etc.
    if (assetRel.includes('${') || assetRel.includes('{') || assetRel.includes('...')) continue;

    const pPub = path.join(publicDir, assetRel);
    const pDist = path.join(distDir, assetRel);

    const pubOk = fs.existsSync(pPub) && fs.statSync(pPub).size > 0;
    const distOk = fs.existsSync(pDist) && fs.statSync(pDist).size > 0;

    if (!pubOk && !distOk) {
      // Check if it exists in root or models
      const pRoot = path.join(rootDir, assetRel);
      if (!fs.existsSync(pRoot)) {
        missingCount++;
        missingList.push(assetRel);
      }
    }
  }

  if (missingCount > 0) {
    console.warn(`⚠️ ${demoFile}: ${assets.size} assets referenced, ${missingCount} missing:`);
    missingList.slice(0, 5).forEach(m => console.warn(`     - ${m}`));
    summary.push({ demo: demoFile, assets: assets.size, missing: missingCount, status: 'WARN_MISSING_ASSETS' });
  } else {
    console.log(`✅ ${demoFile.padEnd(45)}: Verified (${assets.size} assets bound)`);
    summary.push({ demo: demoFile, assets: assets.size, missing: 0, status: 'OK' });
  }
}

console.log('\n======================================================================');
const okCount = summary.filter(s => s.status === 'OK').length;
console.log(`AUDIT COMPLETE: ${okCount}/${demos.length} demos 100% verified with zero missing assets.`);
console.log('======================================================================');
