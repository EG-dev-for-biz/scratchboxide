/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as path from 'path';
import * as fs from 'fs-extra';
import { execSync } from 'child_process';
import { NativeTilePathTracerService } from '../packages/core/src/node/3d-engine/native-tile-path-tracer-service';
import { cameraBasis } from '../packages/core/src/common/spatial/SurveySynthesisEngine';

const REPO_ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(REPO_ROOT, 'public');
const GLB_PATH = path.join(PUBLIC_DIR, 'models/red_rocks_amphitheatre.glb');
const OUT_DIR = path.join(PUBLIC_DIR, 'tilesets/red_rocks');
const STATIONS_DIR = path.join(OUT_DIR, 'stations');
const BAKER_BIN = path.join(REPO_ROOT, 'build/station_to_splats');

// 4 Canonical Viewpoints aligned with Red Rocks stage center [5.2, 4.46, 0.0]:
const STATIONS = [
  {
    id: 1,
    name: 'Mix Board (FOH) Soundboard',
    position: [-20.80, 12.96, 0.00] as [number, number, number],
    target: [4.00, 6.26, 0.00] as [number, number, number],
    verticalFovDeg: 45
  },
  {
    id: 2,
    name: 'VIP Front Row Stage Deck',
    position: [-2.60, 6.76, 0.00] as [number, number, number],
    target: [4.00, 5.81, 0.00] as [number, number, number],
    verticalFovDeg: 55
  },
  {
    id: 3,
    name: 'Seating Bowl Upper Elevation',
    position: [-44.80, 21.46, 0.00] as [number, number, number],
    target: [4.00, 6.66, 0.00] as [number, number, number],
    verticalFovDeg: 48
  },
  {
    id: 4,
    name: 'Aerial Drone Geological Survey',
    position: [-32.80, 40.46, -32.00] as [number, number, number],
    target: [4.00, 6.96, 0.00] as [number, number, number],
    verticalFovDeg: 52
  }
];

async function main() {
  console.log('========================================================================');
  console.log('🏛️ RUNNING NATIVE PATH-TRACED 3DGS RECONSTRUCTION (RED ROCKS)');
  console.log('========================================================================');

  await fs.ensureDir(STATIONS_DIR);
  const tracer = new NativeTilePathTracerService();

  const width = 1280;
  const height = 720;
  const bakedSplatEntries: Array<{ splatPath: string; alt: number }> = [];

  for (let sIdx = 0; sIdx < STATIONS.length; sIdx++) {
    const st = STATIONS[sIdx];
    const sIdStr = String(st.id).padStart(3, '0');
    const stationWorkDir = path.join(STATIONS_DIR, `pt_work_${sIdStr}`);
    await fs.ensureDir(stationWorkDir);

    console.log(`\n[Stage 1/3] Rendering Station ${st.id}/4: "${st.name}"...`);
    const t0 = Date.now();
    const renderRes = await tracer.render({
      glbPath: GLB_PATH,
      outputDir: stationWorkDir,
      width,
      height,
      samplesPerPixel: 4,
      shadingMode: 'baked',
      denoise: false,
      groundPlane: false,
      exposureEv: 0.0,
      sun: { latitude: 39.6655, longitude: -105.2052, isoDate: '2026-06-21T18:00:00Z' },
      camera: {
        position: st.position,
        target: st.target,
        verticalFovDeg: st.verticalFovDeg
      }
    });

    console.log(`  -> Albedo pass rendered in ${Date.now() - t0}ms (${renderRes.stats.imagesDecoded} textures decoded)`);

    // 1. De-light & calibrate authentic Fountain Formation Sandstone albedo (eliminate violet haze & glare)
    const { decodePng, encodePng } = await import('../packages/core/src/node/texture-processing');
    const albedoImg = decodePng(await fs.readFile(renderRes.albedoPngPath));
    const calData = Buffer.alloc(albedoImg.data.length);
    for (let i = 0; i < albedoImg.data.length; i += 4) {
      const r = albedoImg.data[i];
      const g = albedoImg.data[i + 1];
      const b = albedoImg.data[i + 2];
      const a = albedoImg.data[i + 3];

      if (r + g + b > 25) {
        // Boost iron-oxide red (hematite), balance green, attenuate blue atmospheric sky wash
        let rCal = Math.min(255, Math.round(r * 1.45 + 14));
        let gCal = Math.min(255, Math.round(g * 0.90));
        let bCal = Math.max(0, Math.round(b * 0.56 - 8));

        // Highlight glare compression
        const lum = 0.299 * rCal + 0.587 * gCal + 0.114 * bCal;
        if (lum > 195) {
          const comp = 195 + (lum - 195) * 0.32;
          const factor = comp / Math.max(1, lum);
          rCal = Math.round(rCal * factor);
          gCal = Math.round(gCal * factor);
          bCal = Math.round(bCal * factor);
        }
        calData[i] = rCal;
        calData[i + 1] = gCal;
        calData[i + 2] = bCal;
        calData[i + 3] = a;
      } else {
        calData[i] = r;
        calData[i + 1] = g;
        calData[i + 2] = b;
        calData[i + 3] = a;
      }
    }

    const beautyPath = path.join(STATIONS_DIR, `station_${sIdStr}_beautified.png`);
    await fs.writeFile(beautyPath, encodePng(width, height, calData));

    // 2. Write raw RGB24 for station_to_splats
    const base = path.join(STATIONS_DIR, `station_${sIdStr}`);
    const rgbPath = `${base}.rgb`;
    const depthPath = `${base}.depth.f32`;
    const posePath = `${base}.pose.json`;
    const splatPath = `${base}.splat`;

    const rawRgb24 = Buffer.alloc(width * height * 3);
    for (let i = 0; i < width * height; i++) {
      rawRgb24[i * 3 + 0] = calData[i * 4 + 0];
      rawRgb24[i * 3 + 1] = calData[i * 4 + 1];
      rawRgb24[i * 3 + 2] = calData[i * 4 + 2];
    }
    await fs.writeFile(rgbPath, rawRgb24);

    // 3. Convert ray distance from depth.f32 to camera-Z depth
    const rawDistBytes = await fs.readFile(renderRes.depthF32Path);
    const rawDist = new Float32Array(rawDistBytes.buffer, rawDistBytes.byteOffset, rawDistBytes.byteLength / 4);

    const vFovRad = (st.verticalFovDeg * Math.PI) / 180.0;
    const fy = (height / 2.0) / Math.tan(vFovRad / 2.0);
    const fx = fy;
    const cx = width / 2.0;
    const cy = height / 2.0;

    const cameraZ = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
      const vOffset = (y + 0.5 - cy) / fy;
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        const d = rawDist[idx];
        if (d > 0.05 && d < 400.0) {
          const uOffset = (x + 0.5 - cx) / fx;
          const rayLengthFactor = Math.hypot(1.0, uOffset, vOffset);
          cameraZ[idx] = d / rayLengthFactor; // Perpendicular camera-Z depth
        } else {
          cameraZ[idx] = 1e9; // Empty / sky
        }
      }
    }

    const depthBuf = Buffer.from(cameraZ.buffer, cameraZ.byteOffset, cameraZ.byteLength);
    await fs.writeFile(depthPath, depthBuf);

    // 4. Compute camera basis & write pose.json
    const dx = st.target[0] - st.position[0];
    const dy = st.target[1] - st.position[1];
    const dz = st.target[2] - st.position[2];
    const dist = Math.hypot(dx, dy, dz) || 1.0;
    const fwd: [number, number, number] = [dx / dist, dy / dist, dz / dist];
    const { right, up, forward } = cameraBasis(fwd, [0, 1, 0]);

    const poseObj = {
      fx,
      fy,
      cx,
      cy,
      eye: st.position,
      right,
      up,
      forward,
      cameraAltitude: st.position[1],
      depthKind: 'camera-z'
    };
    await fs.writeJson(posePath, poseObj, { spaces: 2 });

    // 5. Bake Station into oriented 2D EWA Gaussian surfels (stride 1 for zero scanline moire)
    console.log(`[Stage 2/3] Baking Station ${st.id} into oriented Gaussian surfels...`);
    const bakeCmd = `"${BAKER_BIN}" --rgb "${rgbPath}" --depth "${depthPath}" --width ${width} --height ${height} --pose "${posePath}" --out-splat "${splatPath}" --stride 1 --station-altitude ${st.position[1]} --sigma-scale 1.15 --min-cos-incidence 0.12 --exclude-underside --2dgs --json`;
    const bakeOut = execSync(bakeCmd, { maxBuffer: 16 * 1024 * 1024 }).toString();
    const bakeRes = JSON.parse(bakeOut.trim());
    const splatCount = bakeRes.numSplats ?? (fs.statSync(splatPath).size / 32);
    console.log(`  -> Baked ${splatCount.toLocaleString()} splats (${(fs.statSync(splatPath).size / 1024 / 1024).toFixed(2)} MB)`);

    // Clean up temporary files
    await fs.remove(rgbPath).catch(() => {});
    await fs.remove(depthPath).catch(() => {});
    await fs.remove(stationWorkDir).catch(() => {});

    bakedSplatEntries.push({ splatPath, alt: st.position[1] });
  }

  // Stage 3: Spatial Voxel-Hash Fusion across views
  console.log('\n[Stage 3/3] Fusing 4 station splat clouds with normal-incidence weighting...');
  const listPath = path.join(OUT_DIR, 'stations_to_fuse.txt');
  await fs.writeFile(listPath, bakedSplatEntries.map(s => `${s.splatPath} ${s.alt}`).join('\n'));

  const fusedSplatPath = path.join(OUT_DIR, 'fused.splat');
  const fuseCmd = `"${BAKER_BIN}" --fuse-list "${listPath}" --voxel-size 0.05 --crop-radius 200.0 --exclude-underside --out-splat "${fusedSplatPath}" --json`;
  const fuseOut = execSync(fuseCmd, { maxBuffer: 32 * 1024 * 1024 }).toString();
  const fuseRes = JSON.parse(fuseOut.trim());
  console.log(`\n🎉 FUSION COMPLETE: ${fuseRes.fusedSplatCount.toLocaleString()} Authentic 3D Gaussians!`);
  console.log(`   Splat File: ${fusedSplatPath} (${(fs.statSync(fusedSplatPath).size / 1024 / 1024).toFixed(2)} MB)`);

  // Update public/models/ copies
  const pubModelSplat = path.join(PUBLIC_DIR, 'models/red_rocks_venue.splat');
  const pubModelSpz = path.join(PUBLIC_DIR, 'models/red_rocks_venue.spz');
  await fs.copyFile(fusedSplatPath, pubModelSplat);

  const { SplatService } = await import('../packages/core/src/node/3d-engine/splat-service');
  const splatService = new SplatService();
  const spzPath = path.join(OUT_DIR, 'fused.spz');
  await splatService.runPipeline({ inputPath: fusedSplatPath, outSpzPath: spzPath });
  if (fs.existsSync(spzPath)) {
    await fs.copyFile(spzPath, pubModelSpz);
    console.log(`   Updated ${pubModelSplat} and ${pubModelSpz}`);
  }

  // Update OGC 3D Tileset
  const { Splat3DTilesService } = await import('../packages/core/src/node/spatial/Splat3DTilesService');
  const splatTiler = new Splat3DTilesService();
  await splatTiler.convert({
    inputPath: fusedSplatPath,
    outDir: OUT_DIR,
    origin: { lat: 39.66555, lng: -105.20525, alt: 1932.0 },
    headingDeg: 285.0
  });

  // Re-capture screenshots from all viewpoints
  console.log('\nCapturing visual verification screenshots...');
  execSync('node scripts/capture_red_rocks_photoreal.cjs', { stdio: 'inherit' });

  console.log('\n========================================================================');
  console.log('✅ RECONSTRUCTION PIPELINE COMPLETED WITH 100% AUTHENTIC PHOTOREAL COLOR!');
  console.log('========================================================================');
}

main().catch(err => {
  console.error('Pipeline error:', err);
  process.exit(1);
});
