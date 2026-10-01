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
import { SplatService } from '@scratchbox/core/node';

export async function splatCommand(args: string[]): Promise<void> {
  const getArg = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : undefined;
  };

  const isSynthetic = args.includes('--synthetic');
  const countArg = getArg('--count');
  const count = countArg ? parseInt(countArg, 10) : undefined;

  let resolvedInput: string | undefined = undefined;

  if (!isSynthetic) {
    const inputFile = args[0];
    if (!inputFile || inputFile.startsWith('-')) {
      console.error('Error: Input splat file required (.splat, .spz, or .ply), or specify --synthetic.');
      console.error('Usage: sbox splat [<input> | --synthetic] [--count <N>] [--to-glb out.glb] [--to-spz out.spz] [--to-splat out.splat] [--voxelize <leafSize>]');
      process.exitCode = 1;
      return;
    }

    resolvedInput = path.resolve(process.cwd(), inputFile);
    if (!(await fs.pathExists(resolvedInput))) {
      console.error(`Error: Input file '${resolvedInput}' not found.`);
      process.exitCode = 1;
      return;
    }
  }

  const outputGlb = getArg('--to-glb') ? path.resolve(process.cwd(), getArg('--to-glb')!) : undefined;
  const outputSpz = getArg('--to-spz') ? path.resolve(process.cwd(), getArg('--to-spz')!) : undefined;
  const outputSplat = getArg('--to-splat') ? path.resolve(process.cwd(), getArg('--to-splat')!) : undefined;
  const voxelizeArg = getArg('--voxelize') || getArg('--voxel-size');
  const voxelizeLeafSize = voxelizeArg ? parseFloat(voxelizeArg) : undefined;
  const fuseArg = getArg('--fuse');
  const densifyArg = getArg('--densify');
  const densifyMaxScale = densifyArg ? parseFloat(densifyArg) : undefined;

  // Handle multi-view fusion if --fuse is specified
  if (fuseArg && resolvedInput) {
    const fuseFile = path.resolve(process.cwd(), fuseArg);
    if (!await fs.pathExists(fuseFile)) {
      console.error(`Error: File to fuse '${fuseFile}' not found.`);
      process.exitCode = 1;
      return;
    }

    console.log(`Fusing multi-view 3DGS captures: ${path.basename(resolvedInput)} + ${path.basename(fuseFile)}...`);
    const buf1 = await fs.readFile(resolvedInput);
    const buf2 = await fs.readFile(fuseFile);

    const pts1 = SplatService.parseSplatBuffer(buf1.buffer.slice(buf1.byteOffset, buf1.byteOffset + buf1.byteLength));
    const pts2 = SplatService.parseSplatBuffer(buf2.buffer.slice(buf2.byteOffset, buf2.byteOffset + buf2.byteLength));

    const fused = SplatService.fuseMultiViewSplats([pts1, pts2], {
      voxelSize: voxelizeLeafSize || 0.05,
      densifyMaxScale
    });

    const targetOutput = outputSplat || path.resolve(process.cwd(), 'fused_world.splat');
    const outBuffer = SplatService.serializeSplatBuffer(fused);
    await fs.writeFile(targetOutput, Buffer.from(outBuffer));

    console.log(`Successfully fused ${pts1.length} + ${pts2.length} splats -> ${fused.length} optimized Gaussians.`);
    console.log(`Saved to: ${path.relative(process.cwd(), targetOutput)}`);
    return;
  }

  console.log(isSynthetic ? `Generating ${count || 1000} synthetic Gaussian Splats...` : `Processing Gaussian Splats: ${path.basename(resolvedInput!)}...`);
  const service = new SplatService();

  const startTime = Date.now();
  const result = await service.runPipeline({
    inputPath: resolvedInput,
    synthetic: isSynthetic,
    count,
    outputGlbPath: outputGlb,
    outputSpzPath: outputSpz,
    outputSplatPath: outputSplat,
    voxelizeLeafSize
  });

  const elapsed = Date.now() - startTime;

  if (!result.success) {
    console.error(`\nSplat Processing Failed (${elapsed}ms):`);
    console.error(result.error);
    process.exitCode = 1;
    return;
  }

  console.log(`\nProcessed ${result.splatCount} Gaussians in ${elapsed}ms:`);
  if (result.glbPath) console.log(`  - glTF 2.0 Binary: ${path.relative(process.cwd(), result.glbPath)}`);
  if (result.spzPath) console.log(`  - Compressed SPZ:  ${path.relative(process.cwd(), result.spzPath)}`);
  if (result.splatPath) console.log(`  - Raw Splat:       ${path.relative(process.cwd(), result.splatPath)}`);
}
