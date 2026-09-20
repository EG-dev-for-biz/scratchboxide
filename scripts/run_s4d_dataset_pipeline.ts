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
import { LatLngAlt, Vec3 } from '../packages/core/src/common/coordinate/LocalTangentPlane';
import { GeospatialSemanticClass } from '../packages/core/src/common/geospatial-4d-protocol';
import {
  Synthetic4DDataGenerator,
  SyntheticBuildingSpec
} from '../packages/core/src/node/spatial/Synthetic4DDataGenerator';
import { OccSoraBridge } from '../packages/core/src/node/spatial/OccSoraBridge';

interface DistrictProfile {
  name: string;
  origin: LatLngAlt;
  terrainBase: number;
  buildingCount: number;
  maxBuildingHeight: number;
  defaultAgentType: 'air' | 'ground';
}

const DISTRICT_PROFILES: DistrictProfile[] = [
  {
    name: 'San Francisco Financial District',
    origin: { lat: 37.7937, lng: -122.3965, alt: 12.0 },
    terrainBase: 12.0,
    buildingCount: 6,
    maxBuildingHeight: 70.0,
    defaultAgentType: 'air'
  },
  {
    name: 'Manhattan Midtown Canyon',
    origin: { lat: 40.7484, lng: -73.9857, alt: 15.0 },
    terrainBase: 15.0,
    buildingCount: 8,
    maxBuildingHeight: 90.0,
    defaultAgentType: 'air'
  },
  {
    name: 'Tokyo Shibuya Commercial',
    origin: { lat: 35.6595, lng: 139.7004, alt: 18.0 },
    terrainBase: 18.0,
    buildingCount: 7,
    maxBuildingHeight: 50.0,
    defaultAgentType: 'ground'
  },
  {
    name: 'Alpine Mountain Ridge',
    origin: { lat: 45.9763, lng: 7.7491, alt: 1600.0 },
    terrainBase: 0.0,
    buildingCount: 2,
    maxBuildingHeight: 20.0,
    defaultAgentType: 'air'
  },
  {
    name: 'Dubai Marina Waterfront',
    origin: { lat: 25.0805, lng: 55.1403, alt: 5.0 },
    terrainBase: 5.0,
    buildingCount: 5,
    maxBuildingHeight: 80.0,
    defaultAgentType: 'air'
  }
];

export async function runS4DDatasetPipeline(totalSamples: number = 20, outputDir?: string) {
  const taskIndex = parseInt(process.env.CLOUD_RUN_TASK_INDEX || '0', 10);
  const taskCount = parseInt(process.env.CLOUD_RUN_TASK_COUNT || '1', 10);

  const defaultRoot = process.env.OUTPUT_DIR || (fs.existsSync('/mnt/gcs') ? '/mnt/gcs/s4d_dataset' : path.join(process.cwd(), 'data', 's4d_dataset'));
  const baseDir = outputDir || path.join(defaultRoot, `task_${taskIndex}`);
  fs.mkdirSync(baseDir, { recursive: true });

  console.log(`\n======================================================`);
  console.log(`  🚀 Scratchbox-4D (S4D) Spatiotemporal Dataset Pipeline`);
  console.log(`  Task Index: ${taskIndex} / ${taskCount}`);
  console.log(`  Target Sequence Count: ${totalSamples}`);
  console.log(`  Output Shard Directory: ${baseDir}`);
  console.log(`======================================================\n`);

  const manifest: Array<{ id: string; promptFile: string; tensorFile: string; district: string }> = [];
  const startTime = Date.now();

  for (let i = 0; i < totalSamples; i++) {
    // Round-robin selection of district
    const district = DISTRICT_PROFILES[(i + taskIndex) % DISTRICT_PROFILES.length];

    // Procedural random buildings
    const buildings: SyntheticBuildingSpec[] = [];
    for (let b = 0; b < district.buildingCount; b++) {
      const angle = (b / district.buildingCount) * Math.PI * 2 + (Math.random() * 0.4 - 0.2);
      const dist = 15.0 + Math.random() * 35.0;
      buildings.push({
        centerENU: [Math.cos(angle) * dist, Math.sin(angle) * dist],
        width: 12.0 + Math.random() * 16.0,
        depth: 12.0 + Math.random() * 16.0,
        height: 15.0 + Math.random() * (district.maxBuildingHeight - 15.0)
      });
    }

    // Procedural 6-DOF trajectory spline (aerial survey arc or ground cruise)
    const altitudeOffset = district.defaultAgentType === 'air' ? 25.0 + Math.random() * 30.0 : 4.0;
    const splinePoints: Vec3[] = [
      [-45 + Math.random() * 10, -45 + Math.random() * 10, altitudeOffset],
      [-15 + Math.random() * 10, 5 + Math.random() * 10, altitudeOffset + (Math.random() * 15 - 7)],
      [15 + Math.random() * 10, 25 + Math.random() * 10, altitudeOffset + (Math.random() * 15 - 7)],
      [45 + Math.random() * 10, 45 + Math.random() * 10, altitudeOffset]
    ];

    const datasetItem = Synthetic4DDataGenerator.generateSequence({
      origin: district.origin,
      splinePoints,
      dimensions: [16, 64, 64, 32], // Standard S4D training tensor shape
      voxelSizeMeters: [2.0, 2.0, 2.0],
      terrainBaseElevation: district.terrainBase,
      buildings,
      agentType: district.defaultAgentType,
      timeStepMs: 250
    });

    const promptPath = path.join(baseDir, `${datasetItem.id}_prompt.json`);
    const tensorPath = path.join(baseDir, `${datasetItem.id}_tensor.rle`);

    // Write prompt JSON
    fs.writeFileSync(
      promptPath,
      JSON.stringify(
        {
          id: datasetItem.id,
          district: district.name,
          prompt: datasetItem.prompt,
          metadata: datasetItem.occupancyGrid.metadata,
          histogram: datasetItem.classHistogram
        },
        null,
        2
      )
    );

    // Write RLE compressed binary string
    fs.writeFileSync(tensorPath, datasetItem.occupancyGrid.sparseRleBytes || '', 'utf-8');

    manifest.push({
      id: datasetItem.id,
      promptFile: path.basename(promptPath),
      tensorFile: path.basename(tensorPath),
      district: district.name
    });

    if ((i + 1) % 5 === 0 || i === totalSamples - 1) {
      const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[Batch Progress] Generated ${i + 1}/${totalSamples} sequences (${elapsedSec}s elapsed)`);
    }
  }

  // Write shard manifest
  const manifestPath = path.join(baseDir, 'manifest.json');
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        taskIndex,
        taskCount,
        totalItems: manifest.length,
        timestamp: new Date().toISOString(),
        items: manifest
      },
      null,
      2
    )
  );

  console.log(`\n✅ Shard generation complete! Manifest written to: ${manifestPath}`);
  return { manifestPath, count: manifest.length };
}

// Allow direct CLI execution via node, ts-node, or vite-node
const isDirectCli = process.argv.some(arg => arg.includes('run_s4d_dataset_pipeline'));
if (isDirectCli) {
  const count = parseInt(process.env.BATCH_SIZE || process.argv.find(arg => /^\d+$/.test(arg)) || '10', 10);
  runS4DDatasetPipeline(count).catch(err => {
    console.error('Fatal batch pipeline error:', err);
    process.exit(1);
  });
}
