#!/usr/bin/env node
/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

const path = require('path');
const fs = require('fs');

async function main() {
  const args = process.argv.slice(2);

  const getArg = (flag) => {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : undefined;
  };
  const hasFlag = (flag) => args.includes(flag);

  if (hasFlag('--help') || hasFlag('-h') || args.length === 0) {
    console.log(`
Scratchbox IDE - Universal Google 3D Tiles Clay & COLMAP Photogrammetry Pipeline
Primary 3D Reference: Google Photorealistic 3D Tiles Studio Grey Clay 3D Object (.glb)
Zero-Preset Photogrammetry Survey & Metric Calibration Engine

Usage:
  node scripts/run_colmap_vector_pipeline.cjs [options]

Target Location Options (Must provide either coordinates or query):
  --lat <number>          Latitude in decimal degrees [-90, 90]
  --lng <number>          Longitude in decimal degrees [-180, 180]
  --alt <number>          Elevation / ground datum in meters ASL (default: sampled or 0)
  --heading <number>      Compass heading / street grid orientation (default: 0)
  --query "<address>"     Address / location query for live Google Geocoding API

Survey Synthesis Options:
  --pattern <type>        Survey pattern: orbital-multi-tier (default), facade-lawnmower,
                          street-corridor, nadir-grid
  --cameras <number>      Number of survey stations (default: 15)
  --radius <number>       Survey radius in meters (default: 120)
  --focal-length <mm>     Lens focal length in mm (default: 35)

COLMAP Ingestion Options:
  --sparse-dir <dir>      Path to COLMAP sparse directory containing cameras.txt and images.txt

Output Options:
  --out-dir <dir>         Output directory for exported files (default: public/data/colmap_vector_export)
  --name <prefix>         Prefix for exported files (default: colmap_vector)
  --api-key <key>         Google Maps Platform API key (default: read from secrets or env)
`);
    process.exit(0);
  }

  // Dynamically load module via ts-node
  let ColmapVectorPipelineService;
  try {
    require('ts-node').register({ transpileOnly: true });
    const mod = require(path.resolve(__dirname, '../packages/core/src/node/spatial/ColmapVectorPipelineService.ts'));
    ColmapVectorPipelineService = mod.ColmapVectorPipelineService;
  } catch (err) {
    console.error('Failed to load ColmapVectorPipelineService:', err.message);
    process.exit(1);
  }

  const service = new ColmapVectorPipelineService();

  const latStr = getArg('--lat');
  const lngStr = getArg('--lng');
  const queryStr = getArg('--query');

  if (!queryStr && (!latStr || !lngStr)) {
    console.error('Error: Must supply either --lat and --lng OR --query "<location>". Zero presets enforced.');
    process.exit(1);
  }

  let anchor = undefined;
  if (latStr && lngStr) {
    const lat = parseFloat(latStr);
    const lng = parseFloat(lngStr);
    if (isNaN(lat) || isNaN(lng)) {
      console.error('Error: --lat and --lng must be valid numbers.');
      process.exit(1);
    }
    anchor = {
      lat,
      lng,
      elevationMeters: getArg('--alt') ? parseFloat(getArg('--alt')) : undefined,
      headingDeg: getArg('--heading') ? parseFloat(getArg('--heading')) : 0,
      label: getArg('--name') || `Location (${lat.toFixed(4)}, ${lng.toFixed(4)})`
    };
  }

  const pattern = getArg('--pattern') || 'orbital-multi-tier';
  const cameras = getArg('--cameras') ? parseInt(getArg('--cameras'), 10) : 15;
  const radius = getArg('--radius') ? parseFloat(getArg('--radius')) : 120;
  const focalLength = getArg('--focal-length') ? parseFloat(getArg('--focal-length')) : 35;
  const disableClay = hasFlag('--no-clay');
  const offlineMock = hasFlag('--offline-mock');

  const request = {
    anchor,
    query: queryStr,
    apiKey: getArg('--api-key'),
    surveyConfig: {
      type: pattern,
      cameraCount: cameras,
      targetRadiusMeters: radius,
      focalLengthMm: focalLength,
      sensorWidthMm: 36.0
    },
    fetchElevation: true,
    clayOptions: {
      enabled: !disableClay,
      offlineMock: offlineMock
    }
  };

  const outDir = getArg('--out-dir') || 'public/data/colmap_vector_export';
  const name = getArg('--name') || (queryStr ? queryStr.toLowerCase().replace(/[^a-z0-9]+/g, '_') : 'colmap_vector');

  console.log('🚀 Executing Universal COLMAP Vector Reference Pipeline (Zero Presets)...');
  if (queryStr) console.log(`   Target Query: "${queryStr}"`);
  if (anchor) console.log(`   Target Coordinates: (${anchor.lat}, ${anchor.lng})`);
  console.log(`   Survey Pattern: ${pattern} (${cameras} cameras, radius ${radius}m)`);
  console.log(`   Studio Grey Clay 3D Tiles: ${!disableClay ? 'ENABLED (getGoogle3DTilesClay)' : 'DISABLED'}`);

  try {
    const result = await service.execute(request, {
      sparseDir: getArg('--sparse-dir'),
      outputDir: outDir,
      baseFileName: name,
      saveFiles: true
    });

    console.log('\n✅ Pipeline Succeeded!');
    console.log(`   Resolved Anchor: ${result.anchor.formattedAddress}`);
    console.log(`   Coordinates: ${result.anchor.lat.toFixed(6)}°N, ${result.anchor.lng.toFixed(6)}°E (Ground Datum: ${result.anchor.elevationMeters.toFixed(1)}m ASL)`);
    console.log(`   Stations Generated: ${result.stats.stationCount}`);
    console.log(`   Altitude Range: ${result.stats.minAltitudeASL}m - ${result.stats.maxAltitudeASL}m ASL (avg: ${result.stats.avgAltitudeASL}m)`);
    console.log(`   Bounding Radius: ${result.stats.boundingRadiusMeters}m`);
    if (result.clayObject) {
      console.log('\n🏛️  Google Photorealistic 3D Tiles (Studio Grey Clay):');
      console.log(`   • GLB Path: ${result.clayObject.glbPath}`);
      console.log(`   • Vertices: ${result.clayObject.meshStats.vertexCount.toLocaleString()}, Triangles: ${result.clayObject.meshStats.triangleCount.toLocaleString()}`);
      console.log(`   • Leaf LOD Error Target: ${result.clayObject.quality.errorTarget} (Quality: ${result.clayObject.quality.resolution})`);
    }
    console.log('\n📁 Exported Files:');
    if (result.exportedFilePaths) {
      Object.entries(result.exportedFilePaths).forEach(([k, p]) => {
        console.log(`   • ${k}: ${p}`);
      });
    }
  } catch (err) {
    console.error('\n❌ Pipeline Execution Failed:', err.message);
    process.exit(1);
  }
}

main();
