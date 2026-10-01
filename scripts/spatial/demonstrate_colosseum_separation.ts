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
import { ColosseumObjectSeparationService } from '../../packages/core/src/node/spatial/ColosseumObjectSeparationService';

async function main() {
  console.log('🏛️ Initializing Colosseum Object Separation & Scene Population Pipeline...');

  const service = new ColosseumObjectSeparationService();
  const stationPosePath = path.resolve(__dirname, '../../public/tilesets/colosseum/stations/station_002.pose.json');
  const stationImgPath = path.resolve(__dirname, '../../public/tilesets/colosseum/stations/station_002_beautified.png');
  const outDir = path.resolve(__dirname, '../../public/tilesets/colosseum');

  const result = await service.separateAndPopulateScene(stationPosePath, stationImgPath);

  console.log(`📍 Scene Anchor: ${result.anchor.name}`);
  console.log(`📡 Anchor Coordinates: Lat ${result.anchor.lat}, Lng ${result.anchor.lng}, Elev ${result.anchor.elevationMeters}m`);
  console.log(`🔍 Detected ${result.separatedObjects.length} discrete entities:`);

  for (const obj of result.separatedObjects) {
    console.log(`  • [${obj.category.toUpperCase()}] ${obj.label}`);
    console.log(`    - 2D Bounding Box: [ymin:${obj.geminiBox2d[0]}, xmin:${obj.geminiBox2d[1]}, ymax:${obj.geminiBox2d[2]}, xmax:${obj.geminiBox2d[3]}]`);
    if (obj.geminiBox3d) {
      console.log(`    - Google Gemini 3D Box: Center=[${obj.geminiBox3d.center.join(', ')}], Size=[${obj.geminiBox3d.size.join(', ')}]m`);
    }
    console.log(`    - Metric ENU: X=${obj.metricPositionENU[0]}m, Y=${obj.metricPositionENU[1]}m, Z=${obj.metricPositionENU[2]}m`);
    console.log(`    - Dimensions: ${obj.metricDimensions[0]}m(W) x ${obj.metricDimensions[1]}m(H) x ${obj.metricDimensions[2]}m(D)`);
    if (obj.matchedPlaceId) {
      console.log(`    - Google Places API Match: ${obj.matchedPlaceId}`);
    }
    console.log(`    - TRELLIS 2 Target GLB: ${obj.trellisTargetGlbPath}`);
  }

  // 1. Export Populated Scene JSON
  const sceneJsonPath = path.join(outDir, 'colosseum_populated_trellis_scene.json');
  fs.writeJsonSync(sceneJsonPath, result.populatedScene, { spaces: 2 });
  console.log(`💾 Saved Populated Scene3DData to: ${sceneJsonPath}`);

  // 2. Generate Interactive Visual HTML Overlay
  const colorPalette: Record<string, string> = {
    'det-colosseum-facade': '#38bdf8', // Light blue
    'det-arch-of-constantine': '#fbbf24', // Gold
    'det-meta-sudans': '#e879f9', // Magenta
    'det-temple-venus-roma': '#c084fc', // Purple
    'det-velian-brick-ruins': '#fb923c', // Orange
    'det-foundation-stone-blocks': '#94a3b8', // Slate grey
    'det-umbrella-pine-tree': '#4ade80', // Green
    'det-umbrella-pine-tree-2': '#22c55e', // Emerald Green
    'det-cypress-tree-1': '#10b981', // Teal Green
    'det-church-campanile': '#f43f5e', // Rose
    'det-piazza-terrain': '#64748b' // Slate
  };

  const svgRectangles = result.separatedObjects.map((obj, idx) => {
    const [ymin, xmin, ymax, xmax] = obj.geminiBox2d;
    const top = ymin / 10;
    const left = xmin / 10;
    const width = (xmax - xmin) / 10;
    const height = (ymax - ymin) / 10;
    const color = colorPalette[obj.id] || '#38bdf8';
    // Offset labels vertically or place inside if at top edge to prevent collisions
    const isTop = top < 5;
    const labelPos = isTop ? 'bottom: -22px; top: auto;' : (idx % 2 === 1 ? 'top: -26px;' : 'top: -22px;');

    return `
      <!-- ${obj.label} -->
      <div class="bbox" style="top: ${top}%; left: ${left}%; width: ${width}%; height: ${height}%; border-color: ${color};">
        <div class="bbox-label" style="background: ${color}; ${labelPos}">
          <strong>${obj.label}</strong>
          <span class="sub-label">[${obj.metricPositionENU[0]}m, ${obj.metricPositionENU[1]}m, ${obj.metricPositionENU[2]}m]</span>
        </div>
      </div>
    `;
  }).join('\n');

  const cardsHtml = result.separatedObjects.map((obj) => {
    const color = colorPalette[obj.id] || '#38bdf8';
    return `
      <div class="card" style="border-left: 4px solid ${color};">
        <div class="card-title" style="color: ${color};">${obj.label}</div>
        <div class="badge">${obj.category.toUpperCase()}</div>
        ${obj.matchedPlaceId ? `<div class="badge places">Places API: ${obj.matchedPlaceId}</div>` : ''}
        ${obj.geminiBox3d ? `<div class="badge" style="background: #1e293b; border: 1px solid ${color}; color: ${color};">Gemini 3D Box: ${obj.geminiBox3d.size[0]}m &times; ${obj.geminiBox3d.size[1]}m &times; ${obj.geminiBox3d.size[2]}m</div>` : ''}
        <div class="meta-row"><strong>3D Position (ENU):</strong> [${obj.metricPositionENU[0]}m, ${obj.metricPositionENU[1]}m, ${obj.metricPositionENU[2]}m]</div>
        <div class="meta-row"><strong>Metric Bounds:</strong> ${obj.metricDimensions[0]}m(W) &times; ${obj.metricDimensions[1]}m(H) &times; ${obj.metricDimensions[2]}m(D)</div>
        <div class="meta-row"><strong>TRELLIS 2 Target:</strong> <code>${obj.trellisTargetGlbPath}</code></div>
        <div class="meta-row prompt"><strong>TRELLIS Prompt:</strong> "${obj.trellisPrompt}"</div>
      </div>
    `;
  }).join('\n');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Colosseum Object Separation & Scene Population Viewer</title>
  <style>
    body {
      margin: 0;
      padding: 24px;
      background: #0f172a;
      color: #f8fafc;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    h1 { margin-top: 0; font-size: 24px; display: flex; align-items: center; gap: 10px; }
    .subtitle { color: #94a3b8; font-size: 14px; margin-bottom: 24px; }
    .grid { display: grid; grid-template-columns: 65% 35%; gap: 24px; }
    .viewer-container {
      position: relative;
      background: #000;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5);
    }
    .base-image { width: 100%; display: block; border-radius: 12px; }
    .bbox-overlay { position: absolute; inset: 0; pointer-events: none; }
    .bbox {
      position: absolute;
      border: 2px solid;
      box-sizing: border-box;
      pointer-events: auto;
      transition: all 0.2s ease;
      background: rgba(255, 255, 255, 0.05);
    }
    .bbox:hover {
      background: rgba(255, 255, 255, 0.15);
      border-width: 3px;
      z-index: 50;
    }
    .bbox-label {
      position: absolute;
      top: -24px;
      left: -2px;
      color: #000;
      font-size: 11px;
      font-weight: 600;
      padding: 2px 6px;
      border-radius: 4px 4px 0 0;
      white-space: nowrap;
    }
    .sub-label { font-size: 9px; opacity: 0.85; font-weight: normal; }
    .cards-container {
      display: flex;
      flex-direction: column;
      gap: 12px;
      max-height: 800px;
      overflow-y: auto;
      padding-right: 8px;
    }
    .card {
      background: #1e293b;
      padding: 14px;
      border-radius: 8px;
      font-size: 13px;
    }
    .card-title { font-size: 15px; font-weight: bold; margin-bottom: 6px; }
    .badge {
      display: inline-block;
      font-size: 10px;
      background: #334155;
      padding: 2px 6px;
      border-radius: 4px;
      margin-bottom: 8px;
    }
    .badge.places { background: #0369a1; color: #bae6fd; margin-left: 6px; }
    .meta-row { margin-top: 4px; color: #cbd5e1; }
    .meta-row.prompt {
      margin-top: 8px;
      font-style: italic;
      color: #94a3b8;
      background: #0f172a;
      padding: 8px;
      border-radius: 6px;
      border-left: 2px solid #64748b;
    }
    code { font-family: monospace; color: #38bdf8; font-size: 12px; }
  </style>
</head>
<body>
  <h1>🏛️ Colosseum Multi-Modal Object Separation & TRELLIS 2 Population</h1>
  <div class="subtitle">
    Cross-modal fusion of Google Places API entities, Gemini 3.7 vision bounding boxes, and camera metric depth unprojection
  </div>

  <div class="grid">
    <div class="viewer-container">
      <img class="base-image" src="stations/station_002_beautified.png" alt="Colosseum Station 002 Beautified">
      <div class="bbox-overlay">
        ${svgRectangles}
      </div>
    </div>

    <div class="cards-container">
      ${cardsHtml}
    </div>
  </div>
</body>
</html>`;

  const htmlPath = path.join(outDir, 'colosseum_object_separation_viewer.html');
  fs.writeFileSync(htmlPath, html, 'utf-8');
  console.log(`🌐 Generated Interactive Viewer at: ${htmlPath}`);
  console.log('✨ Colosseum Object Separation Pipeline completed successfully.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
