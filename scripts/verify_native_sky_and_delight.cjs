const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

async function encodePng(rgbaBuf, w, h) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-v', 'error',
      '-f', 'rawvideo',
      '-pix_fmt', 'rgba',
      '-s', `${w}x${h}`,
      '-i', 'pipe:0',
      '-f', 'image2pipe',
      '-c:v', 'png',
      '-compression_level', '4',
      'pipe:1'
    ]);
    const chunks = [];
    proc.stdout.on('data', c => chunks.push(c));
    proc.on('close', code => {
      if (code !== 0) reject(new Error(`ffmpeg encode png failed with code ${code}`));
      else resolve(Buffer.concat(chunks));
    });
    proc.stdin.write(rgbaBuf);
    proc.stdin.end();
  });
}

async function run() {
  const { NativeSkyService } = await import('../packages/core/dist/node/3d-engine/native-sky-service.js');

  const skyService = new NativeSkyService();
  const W = 512;
  const H = 256;

  console.log('1. Generating Midday Physical Sky (C++20 PhysicalSky)...');
  const midday = await skyService.generatePhysicalSkyEquirectangular({
    sunDirection: [0.1, 0.95, 0.2],
    params: {
      observerAltitudeMeters: 0,
      airDensity: 1.0,
      dustDensity: 1.0,
      ozoneDensity: 1.0,
      sunIntensity: 1.0
    },
    width: W,
    height: H
  });

  if (!midday.success) {
    throw new Error(`Midday sky generation failed: ${midday.error}`);
  }

  // Convert floats to 8-bit RGBA with simple tone-mapping
  const middayRgba = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const r = midday.rgbFloats[i * 3 + 0];
    const g = midday.rgbFloats[i * 3 + 1];
    const b = midday.rgbFloats[i * 3 + 2];
    // Simple Reinhard tone mapping for HDR float radiance: c / (1 + c)
    const map = v => Math.min(255, Math.floor((v / (1.0 + v * 0.4)) * 255));
    middayRgba[i * 4 + 0] = map(r * 4.0);
    middayRgba[i * 4 + 1] = map(g * 4.0);
    middayRgba[i * 4 + 2] = map(b * 4.0);
    middayRgba[i * 4 + 3] = 255;
  }

  const middayPng = await encodePng(middayRgba, W, H);
  const middayPath = path.resolve(__dirname, '../docs/screenshots/96_native_cpp_physical_sky_midday.png');
  fs.writeFileSync(middayPath, middayPng);
  console.log(`Saved Midday Physical Sky Proof: ${middayPath} (${(middayPng.length / 1024).toFixed(1)} KB)`);

  console.log('2. Generating Sunset / Golden Hour Physical Sky (C++20 PhysicalSky)...');
  const sunset = await skyService.generatePhysicalSkyEquirectangular({
    sunDirection: [0.0, 0.08, 0.996], // ~4.6 deg elevation
    params: {
      observerAltitudeMeters: 0,
      airDensity: 1.2,
      dustDensity: 2.8, // Heavy evening aerosol Mie scattering
      ozoneDensity: 1.1,
      sunIntensity: 1.0
    },
    width: W,
    height: H
  });

  if (!sunset.success) {
    throw new Error(`Sunset sky generation failed: ${sunset.error}`);
  }

  const sunsetRgba = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const r = sunset.rgbFloats[i * 3 + 0];
    const g = sunset.rgbFloats[i * 3 + 1];
    const b = sunset.rgbFloats[i * 3 + 2];
    const map = v => Math.min(255, Math.floor((v / (1.0 + v * 0.35)) * 255));
    sunsetRgba[i * 4 + 0] = map(r * 5.0);
    sunsetRgba[i * 4 + 1] = map(g * 5.0);
    sunsetRgba[i * 4 + 2] = map(b * 5.0);
    sunsetRgba[i * 4 + 3] = 255;
  }

  const sunsetPng = await encodePng(sunsetRgba, W, H);
  const sunsetPath = path.resolve(__dirname, '../docs/screenshots/97_native_cpp_physical_sky_sunset.png');
  fs.writeFileSync(sunsetPath, sunsetPng);
  console.log(`Saved Sunset Physical Sky Proof: ${sunsetPath} (${(sunsetPng.length / 1024).toFixed(1)} KB)`);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
