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
import {
  GeoCameraMatchmovePipelineService,
  CameraMotionType,
  GeoMatchmoveRequest
} from '@scratchbox/core/node';

export async function matchmoveCommand(args: string[]): Promise<void> {
  const videoPath = args[0];
  if (!videoPath || videoPath.startsWith('--')) {
    console.error('Error: Input video path required.');
    console.error('Usage: sbox matchmove <input_video.mp4> [--lat <lat> --lng <lng> | --landmark <name>] [options]');
    console.error('\nOptions:');
    console.error('  --landmark <name>         Pre-configured landmark (e.g. "The Plaza Hotel", "Empire State Building")');
    console.error('  --lat <deg> --lng <deg>   Explicit geographic coordinates');
    console.error('  --alt <meters>            Elevation in meters MSL (default: landmark or 0)');
    console.error('  --heading <deg>           Building facade / street grid angle (default: landmark or 0)');
    console.error('  --motion <type>           Camera motion preset (crane-descent-to-nadir, orbital-inspection, canyon-flythrough)');
    console.error('  --render-mode <mode>      Blockout atmosphere mode: textured (default) or clay');
    console.error('  --resolution <4k|1080p>   Resolution: 4k (3840x2160, default) or 1080p (1920x1080)');
    console.error('  --out-dir <dir>           Output directory (default: public/)');
    console.error('  --name <name>             Base identifier for output assets');
    console.error('  --dry-run                 Solve 6-DoF trajectory JSON without launching 3D browser render');
    process.exitCode = 1;
    return;
  }

  const getArg = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : undefined;
  };

  const hasFlag = (flag: string): boolean => args.includes(flag);

  const resolvedVideo = path.isAbsolute(videoPath) ? videoPath : path.resolve(process.cwd(), videoPath);
  if (!fs.existsSync(resolvedVideo)) {
    console.error(`Error: Input video file not found: ${resolvedVideo}`);
    process.exitCode = 1;
    return;
  }

  const landmarkArg = getArg('--landmark');
  const latStr = getArg('--lat');
  const lngStr = getArg('--lng');

  if (!landmarkArg && (!latStr || !lngStr)) {
    console.error('Error: Geographic target required. Provide either --landmark <name> or --lat <deg> --lng <deg>.');
    process.exitCode = 1;
    return;
  }

  const pipeline = new GeoCameraMatchmovePipelineService();

  let geoAnchor: any;
  if (landmarkArg) {
    geoAnchor = pipeline.resolveLandmarkAnchor(landmarkArg);
  } else {
    const lat = parseFloat(latStr!);
    const lng = parseFloat(lngStr!);
    if (isNaN(lat) || isNaN(lng)) {
      console.error('Error: Coordinates --lat and --lng must be valid numbers.');
      process.exitCode = 1;
      return;
    }
    const alt = getArg('--alt') ? parseFloat(getArg('--alt')!) : 0;
    geoAnchor = {
      lat,
      lng,
      elevation: alt,
      landmarkName: getArg('--name') || `Location (${lat.toFixed(4)}, ${lng.toFixed(4)})`
    };
  }

  const motionType = (getArg('--motion') as CameraMotionType) || 'crane-descent-to-nadir';
  const headingArg = getArg('--heading');
  const headingDeg = headingArg ? parseFloat(headingArg) : geoAnchor.headingDeg ?? 0;
  const renderMode = (getArg('--render-mode') as any) || 'textured';
  const resArg = getArg('--resolution') || '4k';
  const resolution = resArg === '1080p' ? { width: 1920, height: 1080 } : { width: 3840, height: 2160 };
  const dryRun = hasFlag('--dry-run');
  const outDir = getArg('--out-dir') ? path.resolve(process.cwd(), getArg('--out-dir')!) : path.resolve(process.cwd(), 'public');
  const outputName = getArg('--name');

  const request: GeoMatchmoveRequest = {
    inputVideoPath: resolvedVideo,
    geoAnchor,
    motionType,
    headingDeg,
    renderMode,
    resolution,
    outputDir: outDir,
    outputVideoName: outputName,
    skipBlockoutRender: dryRun
  };

  try {
    const result = await pipeline.execute(request);
    console.log(`\nSuccess: ${result.summary}`);
  } catch (err: any) {
    console.error(`\nPipeline Error: ${err.message}`);
    process.exitCode = 1;
  }
}
