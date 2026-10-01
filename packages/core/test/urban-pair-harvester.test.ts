/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { Google3DTileCrawlerBaker } from '../src/node/spatial/Google3DTileCrawlerBaker';
import { SurveyStationRenderService } from '../src/node/spatial/SurveyStationRenderService';
import { BeautifyStationService, createDefaultStationImageGenerator } from '../src/node/spatial/BeautifyStationService';
import { stationFromLookAt, cameraBasis } from '../src/common/spatial/SurveySynthesisEngine';
import type { GeodeticAnchor } from '../src/common/spatial/colmap-vector-reference-types';

describe('Urban Pair Harvesting & Ingestion Pipeline', () => {
  it('converts geodetic coordinates to ECEF and local ENU with zero distortion', () => {
    const lat = 40.7128;
    const lng = -74.0060;
    const alt = 15.0;

    const ecef = Google3DTileCrawlerBaker.geodeticToECEF(lat, lng, alt);
    expect(ecef).toHaveLength(3);
    expect(ecef[0]).not.toBeNaN();
    expect(ecef[1]).not.toBeNaN();
    expect(ecef[2]).not.toBeNaN();

    // ENU relative to itself must be [0, 0, 0]
    const enu = Google3DTileCrawlerBaker.ecefToENU(ecef[0], ecef[1], ecef[2], lat, lng, alt);
    expect(Math.abs(enu[0])).toBeLessThan(1e-4);
    expect(Math.abs(enu[1])).toBeLessThan(1e-4);
    expect(Math.abs(enu[2])).toBeLessThan(1e-4);
  });

  it('creates and serializes a standard binary glTF 2.0 (.glb) container', () => {
    const origin = { lat: 40.7128, lng: -74.0060, alt: 10 };
    const syntheticTile = Google3DTileCrawlerBaker.createSyntheticGeodeticTile(origin, 100);
    expect(syntheticTile.positions.length).toBeGreaterThan(0);
    expect(syntheticTile.indices.length).toBeGreaterThan(0);

    const merged = Google3DTileCrawlerBaker.mergeTileMeshes([syntheticTile], origin);
    expect(merged.glbBuffer).toBeDefined();
    expect(merged.glbBuffer.length).toBeGreaterThan(100);

    // Verify magic glTF header 0x46546C67 ("glTF")
    const magic = merged.glbBuffer.slice(0, 4).toString('utf8');
    expect(magic).toBe('glTF');

    // Verify glTF version 2
    const version = merged.glbBuffer.readUInt32LE(4);
    expect(version).toBe(2);

    // Verify byteLength field matches buffer length
    const totalLen = merged.glbBuffer.readUInt32LE(8);
    expect(totalLen).toBe(merged.glbBuffer.length);
  });

  it('bakes explicitly supplied tiles into a GLB', async () => {
    const origin = { lat: 35.6762, lng: 139.6503, alt: 20 };
    const crawler = new Google3DTileCrawlerBaker();
    const result = await crawler.crawlAndBake({
      origin,
      radiusMeters: 80,
      mockTiles: [Google3DTileCrawlerBaker.createSyntheticGeodeticTile(origin, 80)]
    });

    expect(result.vertexCount).toBeGreaterThan(0);
    expect(result.indexCount).toBeGreaterThan(0);
    expect(result.glbBuffer.slice(0, 4).toString('utf8')).toBe('glTF');
  });

  it('simulates checkpoint resumption logic to prevent duplicate ingestion', () => {
    const completedIds = new Set(['bldg_manhattan_00000', 'bldg_manhattan_00001']);
    const candidateIds = ['bldg_manhattan_00000', 'bldg_manhattan_00001', 'bldg_manhattan_00002'];

    const pending = candidateIds.filter((id) => !completedIds.has(id));
    expect(pending).toEqual(['bldg_manhattan_00002']);
  });

  it('executes multi-scene capture in draft mode pairing 3D tiles with AI Beautify perspective', async () => {
    const origin = { lat: 40.7128, lng: -74.0060, alt: 10 };
    const crawler = new Google3DTileCrawlerBaker();
    const result = await crawler.crawlAndBake({
      origin,
      radiusMeters: 60,
      mockTiles: [Google3DTileCrawlerBaker.createSyntheticGeodeticTile(origin, 60)]
    });

    const renderer = new SurveyStationRenderService();
    await renderer.loadMesh(result.glbBuffer);
    const bounds = renderer.getMeshBounds() || { min: [-20, 0, -20], max: [20, 30, 20] };

    const center: [number, number, number] = [
      (bounds.min[0] + bounds.max[0]) / 2,
      (bounds.min[1] + bounds.max[1]) / 2,
      (bounds.min[2] + bounds.max[2]) / 2
    ];
    const standoffDist = 35.0;
    const anchor: GeodeticAnchor = {
      lat: 40.7128,
      lng: -74.0060,
      elevationMeters: 10,
      headingDeg: 0,
      formattedAddress: 'Manhattan Test Tower'
    };
    const optics = { focalLengthMm: 28, sensorWidthMm: 36, aspectRatio: 16 / 9 };
    const generator = createDefaultStationImageGenerator({ allowProceduralGenerator: true });
    const beautifySvc = new BeautifyStationService(renderer, generator);

    const stationCount = 4;
    const frames: any[] = [];

    for (let k = 0; k < stationCount; k++) {
      const angle = (k * 2 * Math.PI) / stationCount;
      const eye: [number, number, number] = [
        center[0] + standoffDist * Math.sin(angle),
        center[1] + 12.0,
        center[2] + standoffDist * Math.cos(angle)
      ];

      const station = stationFromLookAt(k, eye, center, optics, anchor);
      const enriched = renderer.enrichStations([station])[0];
      const blockout = renderer.renderStationBlockout(enriched, { width: 320, height: 180 });

      expect(blockout.png).toBeDefined();
      expect(blockout.png.length).toBeGreaterThan(100);
      expect(blockout.depth.length).toBe(320 * 180);

      const beautifyRes = await beautifySvc.beautify(
        enriched,
        { locationName: `Test Building View ${k}` },
        { draft: true, maxRerolls: 0, width: 320, height: 180 }
      );

      expect(beautifyRes.imagePng).toBeDefined();
      expect(beautifyRes.imagePng.length).toBeGreaterThan(100);
      expect(beautifyRes.attempts).toBe(1); // 1-shot turnaround in draft mode

      const basis = cameraBasis(enriched.forwardVector, enriched.upVector || [0, 1, 0]);
      const c2w = [
        [basis.right[0], basis.up[0], -basis.forward[0], enriched.positionLocalENU[0]],
        [basis.right[1], basis.up[1], -basis.forward[1], enriched.positionLocalENU[1]],
        [basis.right[2], basis.up[2], -basis.forward[2], enriched.positionLocalENU[2]],
        [0, 0, 0, 1]
      ];

      frames.push({
        station_id: k,
        transform_matrix: c2w,
        overlap_percent: beautifyRes.qc.overlapPercent
      });
    }

    expect(frames).toHaveLength(4);
    // Verify distinct orbital angles
    expect(frames[0].transform_matrix[0][0]).not.toBeCloseTo(frames[1].transform_matrix[0][0], 1);
  });
});
