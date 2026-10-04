#!/usr/bin/env node
/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Geospatial Tile Extraction CLI
 * Fetches real-world 3D tiles for a query, runs the shape extraction pipeline,
 * and emits an extracted manifest with vegetation anchors and GLB path.
 ********************************************************************************/

import * as path from 'path';
import { GeospatialTileExtractionBridge } from '../packages/core/src/node/spatial/GeospatialTileExtractionBridge';

async function main() {
  const args = process.argv.slice(2);
  let query = '';
  let outputDir = '';
  let mode: 'full_texture' | 'clay' = 'full_texture';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--query' && args[i + 1]) {
      query = args[i + 1];
      i++;
    } else if (args[i] === '--out' && args[i + 1]) {
      outputDir = args[i + 1];
      i++;
    } else if (args[i] === '--clay') {
      mode = 'clay';
    }
  }

  if (!query) {
    console.error(JSON.stringify({ success: false, error: 'Missing --query argument' }));
    process.exit(1);
  }

  try {
    const bridge = GeospatialTileExtractionBridge.getInstance();
    const result = await bridge.ingestAndExtract(query, {
      outputDir: outputDir || undefined,
      mode
    });

    console.log(JSON.stringify({
      success: true,
      query: result.manifest.query,
      resolvedAddress: result.manifest.resolvedAddress,
      lat: result.manifest.lat,
      lng: result.manifest.lng,
      glbPath: result.glbPath,
      manifestPath: result.manifestPath,
      vegetationCount: result.manifest.vegetationCount,
      architectureCount: result.manifest.architectureCount,
      terrainCount: result.manifest.terrainCount
    }));
    process.exit(0);
  } catch (err: any) {
    console.error(JSON.stringify({ success: false, error: err?.message || String(err) }));
    process.exit(1);
  }
}

main();
