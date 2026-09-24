import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { AlgorithmicUvEngine } from '../packages/core/src/node/spatial/AlgorithmicUvEngine';

async function scaleAndSharpen(inputPath: string, targetW: number, targetH: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const vf = `scale=${targetW}:${targetH}:flags=lanczos+accurate_rnd,unsharp=5:5:2.0:5:5:0.2`;
    const proc = spawn('ffmpeg', ['-v', 'error', '-y', '-i', inputPath, '-vf', vf, '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1']);
    const chunks: Buffer[] = [];
    proc.stdout.on('data', c => chunks.push(c));
    proc.on('close', code => {
      if (code !== 0) reject(new Error(`ffmpeg scale filter failed with code ${code}`));
      else resolve(Buffer.concat(chunks));
    });
  });
}

async function encodeJpeg(rgbaBuf: Uint8Array, w: number, h: number, outputPath: string, qv: number = 2): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-v', 'error',
      '-y',
      '-f', 'rawvideo',
      '-pix_fmt', 'rgba',
      '-s', `${w}x${h}`,
      '-i', 'pipe:0',
      '-q:v', `${qv}`,
      outputPath
    ]);
    proc.on('close', code => {
      if (code !== 0) reject(new Error(`ffmpeg encode jpeg failed with code ${code}`));
      else resolve();
    });
    proc.stdin.write(Buffer.from(rgbaBuf));
    proc.stdin.end();
  });
}

async function encodePng(rgbaBuf: Uint8Array, w: number, h: number, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-v', 'error',
      '-y',
      '-f', 'rawvideo',
      '-pix_fmt', 'rgba',
      '-s', `${w}x${h}`,
      '-i', 'pipe:0',
      outputPath
    ]);
    proc.on('close', code => {
      if (code !== 0) reject(new Error(`ffmpeg encode png failed with code ${code}`));
      else resolve();
    });
    proc.stdin.write(Buffer.from(rgbaBuf));
    proc.stdin.end();
  });
}

async function run() {
  const W = 1024;
  const H = 1024;
  console.log(`=== Synthesizing 1K (${W}x${H}) PBR Suite for NYC ESB ===\n`);

  const textures = [
    {
      id: 8,
      name: 'Limestone Tower Shaft',
      orig: path.resolve('public/models/nyc_esb_stone_texture_8_orig.jpg'),
      outPrefix: 'public/models/nyc_esb_stone_texture_8',
      contract: {
        roughness: 0.72,
        normalStrength: 3.2,
        hbaoIntensity: 0.55,
        strataFrequency: 140.0,
        cavitationDepthPower: 42.0
      }
    },
    {
      id: 42,
      name: 'Art Deco Setbacks',
      orig: path.resolve('public/models/nyc_esb_setback_texture_42_orig.jpg'),
      outPrefix: 'public/models/nyc_esb_setback_texture_42',
      contract: {
        roughness: 0.65,
        normalStrength: 3.8,
        hbaoIntensity: 0.60,
        strataFrequency: 120.0,
        cavitationDepthPower: 38.0
      }
    },
    {
      id: 33,
      name: '5th Ave Street & Asphalt',
      orig: path.resolve('public/models/nyc_esb_street_texture_33_orig.jpg'),
      outPrefix: 'public/models/nyc_esb_street_texture_33',
      contract: {
        roughness: 0.88,
        normalStrength: 2.2,
        hbaoIntensity: 0.35,
        strataFrequency: 0.0,
        cavitationDepthPower: 12.0
      }
    }
  ];

  for (const tex of textures) {
    const t0 = performance.now();
    console.log(`Processing Texture ${tex.id} (${tex.name})...`);
    
    // 1. 2x Super-Resolution to 1K
    const rgba = await scaleAndSharpen(tex.orig, W, H);
    
    // 2. Biophysical PBR Decomposition at 1K
    const pbr = await AlgorithmicUvEngine.decomposePbr(
      new Uint8Array(rgba),
      {
        enableAlbedoDeLighting: false,
        enableMultiFrequencyNormals: true,
        enableBiophysicalRoughness: true,
        enableHbaoMicroCavity: true,
        packOrm: true,
        biophysicalContract: tex.contract
      },
      W,
      H
    );

    const elapsedMs = (performance.now() - t0).toFixed(1);
    console.log(`  Decomposition complete in ${elapsedMs} ms across ${W * H} texels`);

    // 3. Write 1K maps to public/models
    const enhPath = `${tex.outPrefix}_enhanced_1k.jpg`;
    const normPath = `${tex.outPrefix}_normal_1k.jpg`;
    const roughPath = `${tex.outPrefix}_roughness_1k.jpg`;
    const ormPath = `${tex.outPrefix}_orm_1k.png`;

    await encodeJpeg(pbr.albedo, W, H, enhPath, 2);
    if (pbr.normal) await encodeJpeg(pbr.normal, W, H, normPath, 2);
    if (pbr.roughness) await encodeJpeg(pbr.roughness, W, H, roughPath, 2);
    if (pbr.orm) await encodePng(pbr.orm, W, H, ormPath);

    console.log(`  Saved 1K Maps:`);
    console.log(`    Albedo:    ${enhPath}`);
    console.log(`    Normal:    ${normPath}`);
    console.log(`    Roughness: ${roughPath}`);
    console.log(`    ORM:       ${ormPath}\n`);
  }

  console.log('=== All 1K PBR Texture Suites Successfully Generated ===');
}

run().catch(err => {
  console.error('Fatal error generating 1K PBR suite:', err);
  process.exit(1);
});
