/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as fs from 'fs-extra';
import { ColosseumObjectSeparationService } from '../src/node/spatial/ColosseumObjectSeparationService';

describe('Colosseum Object Separation & TRELLIS Scene Population Pipeline', () => {
  const service = new ColosseumObjectSeparationService();
  const stationPosePath = path.resolve(__dirname, '../../../public/tilesets/colosseum/stations/station_002.pose.json');
  const stationImgPath = path.resolve(__dirname, '../../../public/tilesets/colosseum/stations/station_002_beautified.png');

  it('resolves real-world Places API architectural entities in local ENU coordinates', () => {
    const places = service.getNearbyPlacesEntities();
    expect(places.length).toBeGreaterThanOrEqual(5);

    const colosseum = places.find((p) => p.id === 'colosseum-amphitheater');
    expect(colosseum).toBeDefined();
    expect(colosseum?.localENU[0]).toBeCloseTo(0.0, 1);
    expect(colosseum?.localENU[2]).toBeCloseTo(0.0, 1);

    const archConstantine = places.find((p) => p.id === 'arch-of-constantine');
    expect(archConstantine).toBeDefined();
    // Arch of Constantine is ~137.8m West (X < -100) and ~49.8m South (Z = -North > 30 in Three.js)
    expect(archConstantine?.localENU[0]).toBeLessThan(-100);
    expect(archConstantine?.localENU[2]).toBeGreaterThan(30);
    expect(archConstantine?.heightMeters).toBe(21.0);
  });

  it('detects discrete monuments, ruins, and stone pines with normalized Gemini 2D boxes', async () => {
    const detections = await service.detectVisionObjects(stationImgPath);
    expect(detections.length).toBeGreaterThanOrEqual(6);

    const archDet = detections.find((d) => d.id === 'det-arch-of-constantine');
    expect(archDet).toBeDefined();
    expect(archDet?.box2d).toEqual([530, 530, 720, 645]);
    expect(archDet?.trellisPrompt).toContain('Watertight Roman triumphal arch');

    const pineTree = detections.find((d) => d.id === 'det-umbrella-pine-tree');
    expect(pineTree).toBeDefined();
    expect(pineTree?.category).toBe('foliage');
    expect(pineTree?.trellisPrompt).toContain('Pinus pinea umbrella canopy');
  });

  it('unprojects detections into 3D metric space and populates modular Scene3DData', async () => {
    const result = await service.separateAndPopulateScene(stationPosePath, stationImgPath);

    expect(result.anchor.name).toContain('Colosseum');
    expect(result.separatedObjects.length).toBeGreaterThanOrEqual(6);

    // Verify Arch of Constantine object
    const archObj = result.separatedObjects.find((o) => o.id === 'det-arch-of-constantine');
    expect(archObj).toBeDefined();
    expect(archObj?.matchedPlaceId).toBe('arch-of-constantine');
    expect(archObj?.metricPositionENU[0]).toBeCloseTo(-137.8, 1);
    expect(archObj?.metricDimensions[1]).toBe(21.0); // 21 meters tall
    expect(archObj?.trellisTargetGlbPath).toBe('public/models/trellis_arch-of-constantine.glb');

    // Verify Scene3DData structure
    expect(result.populatedScene.sceneType).toBe('city');
    expect(result.populatedScene.environment?.skybox).toBe('physical-atmosphere');
    expect(result.populatedScene.environment?.kelvinTemperature).toBe(3800); // Golden hour travertine
    expect(result.populatedScene.objects.length).toBe(result.separatedObjects.length);

    // Verify each Media4DObject contract
    for (const obj of result.populatedScene.objects) {
      expect(obj.id).toMatch(/^trellis-/);
      expect(obj.content.type).toBe('3d-model');
      expect(obj.content.durableUri).toMatch(/\.glb$/);
      expect(obj.space.spatial3d).toBeDefined();
      expect(obj.space.boundingBox).toBeDefined();
      expect(obj.lineage?.generation?.model).toBe('trellis-2-dit');
    }
  });
});
