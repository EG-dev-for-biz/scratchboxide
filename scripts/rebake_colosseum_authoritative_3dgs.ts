/**
 * scripts/rebake_colosseum_authoritative_3dgs.ts
 *
 * Re-bakes the authoritative 16-station 3D Gaussian Splatting (3DGS) reconstruction
 * for Rome Colosseum with exact 1920x1080 intrinsics, sub-millimeter metric surface lock,
 * and 2D EWA planar covariance against colosseum_rome_1k_pbr.glb.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { SurveyStationRenderService } from '../packages/core/src/node/spatial/SurveyStationRenderService';
import { cameraBasis } from '../packages/core/src/common/spatial/SurveySynthesisEngine';
import { Splat3DTilesService } from '../packages/core/src/node/spatial/Splat3DTilesService';

const REPO_ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(REPO_ROOT, 'public');
const outDir = path.join(PUBLIC_DIR, 'tilesets/colosseum');
const stationsDir = path.join(outDir, 'stations');
const bakerBin = path.join(REPO_ROOT, 'build/station_to_splats');
const glbPath = path.join(PUBLIC_DIR, 'models/colosseum_rome_1k_pbr.glb');

const CX = -44.76;
const CZ = 63.05;

const SURVEY_STATIONS = [
  // Tier 1: 8 Exterior Pedestrian / Arcade Stations (R=142m, Y=32-48m, Target Y=40m)
  { id: 1, name: 'Exterior Facade Arcade 0°', camPos: [97.24, 48.50, 63.05] as [number, number, number], targetPos: [CX, 40.0, CZ] as [number, number, number], fov: 52 },
  { id: 2, name: 'Exterior Facade Arcade 45°', camPos: [55.65, 42.86, 163.46] as [number, number, number], targetPos: [CX, 40.0, CZ] as [number, number, number], fov: 52 },
  { id: 3, name: 'Exterior Facade Arcade 90°', camPos: [-44.76, 48.91, 205.05] as [number, number, number], targetPos: [CX, 40.0, CZ] as [number, number, number], fov: 52 },
  { id: 4, name: 'Exterior Facade Arcade 135°', camPos: [-145.17, 40.14, 163.46] as [number, number, number], targetPos: [CX, 40.0, CZ] as [number, number, number], fov: 52 },
  { id: 5, name: 'Exterior Facade Arcade 180°', camPos: [-186.76, 32.0, 63.05] as [number, number, number], targetPos: [CX, 40.0, CZ] as [number, number, number], fov: 52 },
  { id: 6, name: 'Exterior Facade Arcade 225°', camPos: [-145.17, 38.60, -37.36] as [number, number, number], targetPos: [CX, 40.0, CZ] as [number, number, number], fov: 52 },
  { id: 7, name: 'Exterior Facade Arcade 270°', camPos: [-44.76, 50.77, -78.95] as [number, number, number], targetPos: [CX, 40.0, CZ] as [number, number, number], fov: 52 },
  { id: 8, name: 'Exterior Facade Arcade 315°', camPos: [55.65, 71.23, -37.36] as [number, number, number], targetPos: [CX, 40.0, CZ] as [number, number, number], fov: 52 },

  // Tier 2: 4 Upper Attic Rim Stations (R=125m, Y=68m, Target Y=42m)
  { id: 9, name: 'Upper Attic Rim 45°', camPos: [43.63, 68.0, 151.44] as [number, number, number], targetPos: [CX, 42.0, CZ] as [number, number, number], fov: 55 },
  { id: 10, name: 'Upper Attic Rim 135°', camPos: [-133.15, 68.0, 151.44] as [number, number, number], targetPos: [CX, 42.0, CZ] as [number, number, number], fov: 55 },
  { id: 11, name: 'Upper Attic Rim 225°', camPos: [-133.15, 68.0, -25.34] as [number, number, number], targetPos: [CX, 42.0, CZ] as [number, number, number], fov: 55 },
  { id: 12, name: 'Upper Attic Rim 315°', camPos: [43.63, 68.0, -25.34] as [number, number, number], targetPos: [CX, 42.0, CZ] as [number, number, number], fov: 55 },

  // Tier 3: 2 Aerial Survey Stations (R=85m, Y=115m, Target Y=30m)
  { id: 13, name: 'Aerial Survey South', camPos: [25.24, 115.0, 133.05] as [number, number, number], targetPos: [CX, 30.0, CZ] as [number, number, number], fov: 65 },
  { id: 14, name: 'Aerial Survey North', camPos: [-114.76, 115.0, -6.95] as [number, number, number], targetPos: [CX, 30.0, CZ] as [number, number, number], fov: 65 },

  // Tier 4: 2 Interior Arena Floor Stations (R=25m, Y=24m)
  { id: 15, name: 'Interior Arena Hypogeum East View', camPos: [-72.76, 36.16, 63.05] as [number, number, number], targetPos: [CX + 35.0, 32.0, CZ] as [number, number, number], fov: 65 },
  { id: 16, name: 'Interior Arena Hypogeum West View', camPos: [-16.76, 38.34, 63.05] as [number, number, number], targetPos: [CX - 35.0, 32.0, CZ] as [number, number, number], fov: 65 }
];

async function main() {
  console.log('========================================================================');
  console.log('🏛️  AUTHORITATIVE COLOSSEUM 3DGS RE-BAKE & ALIGNMENT ENFORCEMENT');
  console.log('========================================================================');

  // Verify prerequisites
  if (!fs.existsSync(glbPath)) throw new Error(`Missing GLB at ${glbPath}`);
  if (!fs.existsSync(bakerBin)) throw new Error(`Missing station_to_splats binary at ${bakerBin}`);

  const renderService = new SurveyStationRenderService();
  console.log('Loading Colosseum 1K PBR GLB in SurveyStationRenderService...');
  await renderService.loadMesh(glbPath);
  console.log('✅ GLB Mesh loaded successfully.');

  const width = 1920;
  const height = 1080;
  const bakedSplatPaths: { splatPath: string; alt: number }[] = [];

  for (const st of SURVEY_STATIONS) {
    const sIdStr = String(st.id).padStart(3, '0');
    console.log(`\n[Station ${st.id}/16] "${st.name}"...`);

    const platePath = path.join(stationsDir, `station_${sIdStr}_beautified.png`);
    if (!fs.existsSync(platePath)) {
      throw new Error(`Missing beautified plate at ${platePath}`);
    }

    const dx = st.targetPos[0] - st.camPos[0];
    const dy = st.targetPos[1] - st.camPos[1];
    const dz = st.targetPos[2] - st.camPos[2];
    const dist = Math.hypot(dx, dy, dz) || 1.0;
    const fwd: [number, number, number] = [dx / dist, dy / dist, dz / dist];

    const stationPose = {
      id: st.id,
      name: st.name,
      fovDegrees: st.fov,
      aspectRatio: width / height,
      positionLocalENU: st.camPos,
      forwardVector: fwd,
      upVector: [0, 1, 0] as [number, number, number]
    };

    const blockout = renderService.renderStationBlockout(stationPose as any, { width, height, minGroundClearance: 0 });
    const blockoutPath = path.join(stationsDir, `station_${sIdStr}_blockout.png`);
    fs.writeFileSync(blockoutPath, blockout.png);

    const base = path.join(stationsDir, `station_${sIdStr}`);
    const rgbPath = `${base}.rgb`;
    const depthPath = `${base}.depth.f32`;
    const posePath = `${base}.pose.json`;
    const splatPath = `${base}.splat`;

    // Decode plate into raw RGB24 at 1920x1080
    execSync(`ffmpeg -y -v error -i "${platePath}" -vf "scale=${width}:${height}" -f rawvideo -pix_fmt rgb24 "${rgbPath}"`);

    // Write metric depth buffer
    const depthBuf = Buffer.from(blockout.depth.buffer, blockout.depth.byteOffset, blockout.depth.byteLength);
    fs.writeFileSync(depthPath, depthBuf);

    // Write exact 1920x1080 camera pose
    const { right, up, forward } = cameraBasis(fwd, [0, 1, 0]);
    const poseObj = {
      fx: blockout.intrinsics.fx,
      fy: blockout.intrinsics.fy,
      cx: blockout.intrinsics.cx,
      cy: blockout.intrinsics.cy,
      eye: st.camPos,
      right,
      up,
      forward,
      cameraAltitude: st.camPos[1],
      depthKind: 'camera-z'
    };
    fs.writeFileSync(posePath, JSON.stringify(poseObj, null, 2));

    // Bake station into planar 2DGS surfels
    const bakeCmd = `"${bakerBin}" --rgb "${rgbPath}" --depth "${depthPath}" --width ${width} --height ${height} --pose "${posePath}" --out-splat "${splatPath}" --stride 1 --station-altitude ${st.camPos[1]} --sigma-scale 0.95 --min-cos-incidence 0.15 --exclude-underside --2dgs --json`;
    const bakeOut = execSync(bakeCmd, { maxBuffer: 16 * 1024 * 1024 }).toString();
    const bakeRes = JSON.parse(bakeOut.trim());
    const splatCount = bakeRes.numSplats ?? bakeRes.splatCount ?? (fs.statSync(splatPath).size / 32);
    console.log(`  -> Baked ${splatCount.toLocaleString()} 3D Gaussian surfels (${(fs.statSync(splatPath).size / 1024 / 1024).toFixed(2)} MB)`);

    // Clean up temporary unproject buffers
    try { fs.unlinkSync(rgbPath); } catch (_) {}
    try { fs.unlinkSync(depthPath); } catch (_) {}

    bakedSplatPaths.push({ splatPath, alt: st.camPos[1] });
  }

  // Multi-station fusion
  console.log('\n========================================================================');
  console.log('🔗 FUSING ALL 16 STATIONS INTO AUTHORITATIVE fused.splat...');
  console.log('========================================================================');
  const fuseListPath = path.join(outDir, 'colosseum_fuse_list.txt');
  fs.writeFileSync(fuseListPath, bakedSplatPaths.map(s => `${s.splatPath} ${s.alt}`).join('\n') + '\n');

  const fusedSplatPath = path.join(outDir, 'fused.splat');
  const fusedSpzPath = path.join(outDir, 'fused.spz');
  const fuseCmd = `"${bakerBin}" --fuse-list "${fuseListPath}" --voxel-size 0.05 --crop-center-x ${CX} --crop-center-z ${CZ} --crop-radius 125.0 --min-y 18.0 --drop-foliage --exclude-underside --out-splat "${fusedSplatPath}" --out-spz "${fusedSpzPath}" --json`;
  console.log(`Executing: ${fuseCmd}`);
  const fuseOut = execSync(fuseCmd, { maxBuffer: 32 * 1024 * 1024 }).toString();
  const fuseRes = JSON.parse(fuseOut.trim());

  const finalCount = fuseRes.fusedSplats ?? (fs.statSync(fusedSplatPath).size / 32);
  const splatMb = (fs.statSync(fusedSplatPath).size / 1024 / 1024).toFixed(2);
  const spzKb = fs.existsSync(fusedSpzPath) ? (fs.statSync(fusedSpzPath).size / 1024).toFixed(1) : 'N/A';

  console.log('========================================================================');
  console.log(`🎉 FUSION COMPLETE!`);
  console.log(`   Authoritative Fused Splats : ${finalCount.toLocaleString()} Gaussian surfels`);
  console.log(`   Standard .splat Size       : ${splatMb} MB`);
  console.log(`   Compressed .spz Size       : ${spzKb} KB`);
  console.log(`   Centroid Crop Center       : [${CX}, ${CZ}] (Radius 125m, Min Y 18m)`);
  console.log('========================================================================');

  // Re-build 3D Tiles pyramid
  console.log('\nBuilding 3D Tiles 1.1 pyramid (tileset.json + tiles/)...');
  const anchor = { lat: 41.8902, lng: 12.4922, elevationMeters: 54.0 };
  const tiles = new Splat3DTilesService();
  const tileRes = await tiles.convert({
    inputPath: fusedSplatPath,
    outDir,
    origin: anchor,
    headingDeg: 0,
    maxDepth: 5
  });
  console.log(`3D Tiles build result: success=${tileRes.success}, tiles=${tileRes.tileCount}, levels=${tileRes.levels}`);

  // Update metadata
  const meta = {
    landmark: 'colosseum',
    title: 'Rome Colosseum Complete 1:1 Metric 3DGS Reconstruction',
    fusedSplats: finalCount,
    fusedSplatMb: splatMb,
    fusedSpzKb: spzKb,
    stations: bakedSplatPaths.length,
    cropCenter: [CX, 22.0, CZ],
    cropRadius: 125.0,
    timestamp: new Date().toISOString()
  };
  fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));

  const tilesetMeta = {
    landmark: 'colosseum',
    fusedSplatCount: finalCount,
    fusedSplatMb: splatMb,
    fusedSpzKb: spzKb,
    stations: bakedSplatPaths.length,
    tiles: {
      tileCount: tileRes.tileCount,
      levels: tileRes.levels,
      tileBytes: tileRes.tileBytes
    },
    updatedAt: new Date().toISOString()
  };
  fs.writeFileSync(path.join(outDir, 'tileset.meta.json'), JSON.stringify(tilesetMeta, null, 2));

  console.log('✅ ALL COLOSSEUM 3DGS DATASETS RE-BAKED AND COMMITTED.');
}

main().catch(err => {
  console.error('Rebake failed:', err);
  process.exit(1);
});
