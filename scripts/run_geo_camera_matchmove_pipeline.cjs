#!/usr/bin/env node
/********************************************************************************
 * Geo-Camera Matchmove Pipeline Runner
 *
 * Matches camera movement from any input video into target geographic coordinates
 * or landmark locations using Google Photorealistic 3D Tiles and Omni 1.1.
 *
 * Usage:
 *   node scripts/run_geo_camera_matchmove_pipeline.cjs --video reference.mp4 --landmark "The Plaza Hotel" [options]
 *   node scripts/run_geo_camera_matchmove_pipeline.cjs --video reference.mp4 --lat 40.7645 --lng -73.9744 --elevation 18.0 [options]
 ********************************************************************************/

const path = require('path');
const fs = require('fs');

const { GeoCameraMatchmovePipelineService } = require('../packages/core/dist/node/spatial/GeoCameraMatchmovePipelineService.js');

const args = process.argv.slice(2);
function getArg(flag, defaultValue) {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return defaultValue;
}

const hasFlag = (flag) => args.includes(flag);

async function main() {
  const videoInput = getArg('--video') || getArg('-i') || args[0];
  if (!videoInput || videoInput.startsWith('--')) {
    console.log(`
========================================================================
🌐 Scratchbox Geo-Camera Matchmove Pipeline Runner
========================================================================
Usage:
  node scripts/run_geo_camera_matchmove_pipeline.cjs --video <file.mp4> [options]

Required:
  --video <path>            Input reference video file (.mp4, .mov, etc.)
  --landmark <name>         Landmark preset (e.g. "The Plaza Hotel", "Empire State Building")
    OR
  --lat <deg> --lng <deg>   Target geographic latitude & longitude

Options:
  --alt <meters>            Target elevation MSL (default: landmark or 0)
  --heading <deg>           Building facade or street grid heading (default: landmark or 0)
  --motion <preset>         Camera motion: crane-descent-to-nadir (default), orbital-inspection, canyon-flythrough
  --render-mode <mode>      Atmosphere mode: textured (default), clay, warm-clay, studio-grey
  --resolution <4k|1080p>   Output resolution: 4k (default) or 1080p
  --fps <number>            Framerate (default: inferred from video or 24)
  --name <id>               Output asset base identifier
  --out-dir <dir>           Output directory (default: public/)
  --dry-run                 Compute and persist 6-DoF trajectory JSON without launching 3D browser render
  --port <number>           Internal web server port (default: 8105)
  --precision               Enable 100% sub-pixel 3D tile edge alignment & Hermite-Slerp interpolation
  --lens-k1 <value>         Brown-Conrady radial distortion coefficient k1 (e.g. -0.015)
  --lens-k2 <value>         Brown-Conrady radial distortion coefficient k2 (e.g. 0.002)
  --tile-mesh <path>        Path to authentic Google 3D Tiles .glb for silhouette edge resectioning
  --interpolation <method>  Interpolation method: hermite-slerp (default with --precision) or catmull-rom
========================================================================
`);
    process.exit(1);
  }

  const resolvedVideo = path.isAbsolute(videoInput) ? videoInput : path.resolve(process.cwd(), videoInput);
  if (!fs.existsSync(resolvedVideo)) {
    console.error(`❌ Error: Input video file not found: ${resolvedVideo}`);
    process.exit(1);
  }

  const pipeline = new GeoCameraMatchmovePipelineService();

  const landmark = getArg('--landmark');
  const latStr = getArg('--lat');
  const lngStr = getArg('--lng');

  let geoAnchor;
  if (landmark) {
    geoAnchor = pipeline.resolveLandmarkAnchor(landmark);
  } else if (latStr && lngStr) {
    const lat = parseFloat(latStr);
    const lng = parseFloat(lngStr);
    const alt = parseFloat(getArg('--alt', '0'));
    geoAnchor = {
      lat,
      lng,
      elevation: alt,
      landmarkName: getArg('--name', `Geo Target (${lat.toFixed(4)}, ${lng.toFixed(4)})`)
    };
  } else {
    console.error('❌ Error: Target location required. Specify --landmark <name> or --lat <deg> --lng <deg>.');
    process.exit(1);
  }

  const motionType = getArg('--motion', 'crane-descent-to-nadir');
  const headingArg = getArg('--heading');
  const headingDeg = headingArg !== undefined ? parseFloat(headingArg) : (geoAnchor.headingDeg ?? 0);
  const renderMode = getArg('--render-mode', 'textured');
  const resArg = getArg('--resolution', '4k');
  const resolution = resArg === '1080p' ? { width: 1920, height: 1080 } : { width: 3840, height: 2160 };
  const dryRun = hasFlag('--dry-run');
  const outDir = path.resolve(process.cwd(), getArg('--out-dir', 'public'));
  const outputName = getArg('--name');
  const port = parseInt(getArg('--port', '8105'), 10);

  const precision = hasFlag('--precision');
  const interpolation = getArg('--interpolation', precision ? 'hermite-slerp' : 'catmull-rom');
  const lensK1 = getArg('--lens-k1');
  const lensK2 = getArg('--lens-k2');
  let lensDistortion = undefined;
  if (lensK1 !== undefined || lensK2 !== undefined) {
    lensDistortion = {
      k1: lensK1 !== undefined ? parseFloat(lensK1) : 0,
      k2: lensK2 !== undefined ? parseFloat(lensK2) : 0,
      p1: 0,
      p2: 0
    };
  }
  const tileMesh = getArg('--tile-mesh');

  const request = {
    inputVideoPath: resolvedVideo,
    geoAnchor,
    motionType,
    headingDeg,
    renderMode,
    resolution,
    outputDir: outDir,
    outputVideoName: outputName,
    skipBlockoutRender: dryRun,
    port,
    precisionOptimization: precision,
    interpolationMethod: interpolation,
    lensDistortion,
    tileMeshPath: tileMesh ? path.resolve(process.cwd(), tileMesh) : undefined
  };

  try {
    const result = await pipeline.execute(request);
    console.log('\n========================================================================');
    console.log('✅ Pipeline Execution Succeeded!');
    console.log(`📁 Camera Path:     ${result.cameraPathJsonPath}`);
    if (result.blockoutVideoPath) console.log(`🎥 Blockout Video:   ${result.blockoutVideoPath}`);
    if (result.omniVideoPath) console.log(`✨ Restyled Video:   ${result.omniVideoPath}`);
    if (result.comparisonVideoPath) console.log(`⚡ Split Comparison: ${result.comparisonVideoPath}`);
    if (result.precisionMetrics) {
      console.log(`🎯 Edge Overlap:     ${result.precisionMetrics.meanEdgeOverlapScorePct}%`);
      console.log(`📐 Reprojection Err: ${result.precisionMetrics.meanReprojectionErrorPx} px`);
      console.log(`🔒 Marker Drift:     ${result.precisionMetrics.meanDriftPx} px (Max: ${result.precisionMetrics.maxDriftPx} px)`);
    }
    console.log('========================================================================');
  } catch (err) {
    console.error('\n❌ Pipeline Execution Failed:', err.message);
    process.exit(1);
  }
}

main();
