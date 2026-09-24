#!/usr/bin/env tsx
/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as fs from 'fs';
import * as path from 'path';
import { Google3DTileCrawlerBaker } from '../../packages/core/src/node/spatial/Google3DTileCrawlerBaker';
import { SurveyStationRenderService } from '../../packages/core/src/node/spatial/SurveyStationRenderService';
import { BeautifyStationService, createDefaultStationImageGenerator } from '../../packages/core/src/node/spatial/BeautifyStationService';
import { stationFromLookAt, cameraBasis } from '../../packages/core/src/common/spatial/SurveySynthesisEngine';
import type { GeodeticAnchor } from '../../packages/core/src/common/spatial/colmap-vector-reference-types';

interface CliArgs {
  lat: number;
  lng: number;
  alt: number;
  radius: number;
  outputGlb: string;
  apiKey?: string;
  mock: boolean;
  multiScene: boolean;
  draft: boolean;
  stations: number;
  draftWidth: number;
  draftHeight: number;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const parsed: CliArgs = {
    lat: 40.7128,
    lng: -74.0060,
    alt: 10,
    radius: 120,
    outputGlb: './output_tile.glb',
    mock: false,
    multiScene: false,
    draft: true,
    stations: 4,
    draftWidth: 768,
    draftHeight: 432
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--lat' && args[i + 1]) parsed.lat = parseFloat(args[++i]);
    else if (arg === '--lng' && args[i + 1]) parsed.lng = parseFloat(args[++i]);
    else if (arg === '--alt' && args[i + 1]) parsed.alt = parseFloat(args[++i]);
    else if (arg === '--radius' && args[i + 1]) parsed.radius = parseFloat(args[++i]);
    else if (arg === '--output_glb' && args[i + 1]) parsed.outputGlb = args[++i];
    else if (arg === '--apiKey' && args[i + 1]) parsed.apiKey = args[++i];
    else if (arg === '--mock') parsed.mock = true;
    else if (arg === '--multi_scene') parsed.multiScene = true;
    else if (arg === '--draft') parsed.draft = true;
    else if (arg === '--production') parsed.draft = false;
    else if (arg === '--stations' && args[i + 1]) parsed.stations = parseInt(args[++i], 10);
    else if (arg === '--draft_width' && args[i + 1]) parsed.draftWidth = parseInt(args[++i], 10);
    else if (arg === '--draft_height' && args[i + 1]) parsed.draftHeight = parseInt(args[++i], 10);
  }

  // Fallback to secrets.json if no API key provided
  if (!parsed.apiKey && !parsed.mock) {
    const secretsPath = path.resolve(process.cwd(), 'secrets.json');
    if (fs.existsSync(secretsPath)) {
      try {
        const sec = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
        parsed.apiKey = sec.GOOGLE_MAPS_API_KEY || sec.GOOGLE_CLOUD_API_KEY;
      } catch {}
    }
  }

  return parsed;
}

async function main() {
  const options = parseArgs();

  const crawler = new Google3DTileCrawlerBaker();
  const result = await crawler.crawlAndBake({
    origin: {
      lat: options.lat,
      lng: options.lng,
      alt: options.alt
    },
    radiusMeters: options.radius,
    apiKey: options.apiKey
  });

  const outDir = path.dirname(path.resolve(options.outputGlb));
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  fs.writeFileSync(options.outputGlb, result.glbBuffer);

  const stats: any = {
    vertexCount: result.vertexCount,
    indexCount: result.indexCount,
    triangleCount: Math.round(result.indexCount / 3),
    byteLength: result.glbBuffer.length,
    outputPath: options.outputGlb,
    isStandardGlb: result.glbBuffer.slice(0, 4).toString('utf8') === 'glTF'
  };

  if (options.multiScene) {
    const stationsDir = path.join(outDir, 'stations');
    if (!fs.existsSync(stationsDir)) {
      fs.mkdirSync(stationsDir, { recursive: true });
    }

    const renderer = new SurveyStationRenderService();
    await renderer.loadMesh(result.glbBuffer);
    const bounds = renderer.getMeshBounds() || { min: [-25, 0, -25], max: [25, 45, 25] };

    const center: [number, number, number] = [
      (bounds.min[0] + bounds.max[0]) / 2,
      (bounds.min[1] + bounds.max[1]) / 2,
      (bounds.min[2] + bounds.max[2]) / 2
    ];
    const heightSpan = Math.max(12, bounds.max[1] - bounds.min[1]);
    const extentRadius = Math.max(15, Math.hypot(bounds.max[0] - bounds.min[0], bounds.max[2] - bounds.min[2]) / 2);
    const standoffDist = Math.max(28, extentRadius * 2.2);

    const anchor: GeodeticAnchor = {
      lat: options.lat,
      lng: options.lng,
      elevationMeters: options.alt,
      headingDeg: 0,
      formattedAddress: 'Urban Entity'
    };

    const width = options.draftWidth || 768;
    const height = options.draftHeight || 432;
    const optics = {
      focalLengthMm: 28,
      sensorWidthMm: 36,
      aspectRatio: width / height
    };

    const generator = createDefaultStationImageGenerator();
    const beautifyService = new BeautifyStationService(renderer, generator);

    const numStations = Math.max(1, options.stations || 4);
    const stationOutputs: any[] = [];
    const nerfstudioFrames: any[] = [];
    let defaultIntrinsics: any = null;

    for (let k = 0; k < numStations; k++) {
      const angleRad = (k * 2 * Math.PI) / numStations;
      const eyeX = center[0] + standoffDist * Math.sin(angleRad);
      const eyeZ = center[2] + standoffDist * Math.cos(angleRad);
      const eyeY = center[1] + heightSpan * 0.45;

      const station = stationFromLookAt(k, [eyeX, eyeY, eyeZ], center, optics, anchor);
      const enrichedStation = renderer.enrichStations([station])[0];

      const blockout = renderer.renderStationBlockout(enrichedStation, { width, height });
      if (!defaultIntrinsics) {
        defaultIntrinsics = blockout.intrinsics;
      }

      const beautifyRes = await beautifyService.beautify(
        enrichedStation,
        {
          locationName: `Urban Structure ${k}`,
          moodPromptContext: 'Overcast soft diffused daylight, architectural photography, 5500K neutral color temperature. ',
          styleSuffix: ' Crisp architectural facade, clear windows and fine material definition.'
        },
        {
          draft: options.draft,
          maxRerolls: 0,
          width,
          height
        }
      );

      const kStr = String(k).padStart(2, '0');
      const blockoutRel = `stations/station_${kStr}_blockout.png`;
      const beautifyRel = `stations/station_${kStr}_beautify.png`;
      const depthRel = `stations/station_${kStr}_depth.raw`;

      const blockoutAbs = path.join(outDir, blockoutRel);
      const beautifyAbs = path.join(outDir, beautifyRel);
      const depthAbs = path.join(outDir, depthRel);

      fs.writeFileSync(blockoutAbs, blockout.png);
      fs.writeFileSync(beautifyAbs, beautifyRes.imagePng);
      fs.writeFileSync(depthAbs, Buffer.from(blockout.depth.buffer));

      const basis = cameraBasis(enrichedStation.forwardVector, enrichedStation.upVector || [0, 1, 0]);
      // Nerfstudio OpenGL coordinate frame: +X right, +Y up, -Z forward (c2w)
      const transformMatrix = [
        [basis.right[0], basis.up[0], -basis.forward[0], enrichedStation.positionLocalENU[0]],
        [basis.right[1], basis.up[1], -basis.forward[1], enrichedStation.positionLocalENU[1]],
        [basis.right[2], basis.up[2], -basis.forward[2], enrichedStation.positionLocalENU[2]],
        [0, 0, 0, 1]
      ];

      nerfstudioFrames.push({
        file_path: beautifyRel,
        blockout_path: blockoutRel,
        depth_file_path: depthRel,
        transform_matrix: transformMatrix,
        yaw_deg: enrichedStation.yawDegrees,
        pitch_deg: enrichedStation.pitchDegrees,
        qc: beautifyRes.qc
      });

      stationOutputs.push({
        stationId: k,
        azimuthDeg: Math.round((angleRad * 180) / Math.PI),
        beautifyPath: beautifyAbs,
        blockoutPath: blockoutAbs,
        depthPath: depthAbs,
        qc: beautifyRes.qc
      });
    }

    const transformsJson = {
      camera_model: 'PINHOLE',
      fl_x: defaultIntrinsics?.fx || 600,
      fl_y: defaultIntrinsics?.fy || 600,
      cx: defaultIntrinsics?.cx || width / 2,
      cy: defaultIntrinsics?.cy || height / 2,
      w: width,
      h: height,
      draft_mode: options.draft,
      frames: nerfstudioFrames
    };

    const transformsPath = path.join(outDir, 'transforms.json');
    fs.writeFileSync(transformsPath, JSON.stringify(transformsJson, null, 2));

    stats.multiScene = {
      stationCount: numStations,
      draftMode: options.draft,
      width,
      height,
      transformsPath,
      stations: stationOutputs
    };
  }

  console.log(JSON.stringify(stats));
}

main().catch((err) => {
  console.error(JSON.stringify({ error: String(err), stack: err.stack }));
  process.exit(1);
});
