/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import {
  Universal3DObjectSeparationService,
  type UniversalSeparationOptions,
  type UniversalSeparatedScene
} from '../src/node/spatial/Universal3DObjectSeparationService';

describe('Universal3DObjectSeparationService (Zero-Preset 3D Entity Separation)', () => {
  const colosseumModelPath = path.resolve(__dirname, '../../../public/models/colosseum_clay.glb');

  it('separates arbitrary 3D geometry into discrete spatial entities without hardcoded presets', async () => {
    const service = new Universal3DObjectSeparationService();

    // 1. Ingest model geometry
    const scene: UniversalSeparatedScene = await service.separate({
      glbPath: colosseumModelPath,
      granularity: 'macro',
      autoDetectSemanticCategories: true,
      geoAnchor: {
        name: 'Target Archaeological Site',
        lat: 41.8902,
        lng: 12.4922,
        altitudeMeters: 22.8
      }
    });

    expect(scene).toBeDefined();
    expect(scene.totalVertices).toBeGreaterThan(100000);
    expect(scene.objects.length).toBeGreaterThanOrEqual(5);

    // Verify overall bounding box in meters
    const { dimensions, centroid } = scene.overallBoundingBox;
    expect(dimensions[0]).toBeGreaterThan(100); // Width
    expect(dimensions[1]).toBeGreaterThan(20);  // Height
    expect(dimensions[2]).toBeGreaterThan(100); // Depth
    expect(centroid).toBeDefined();

    // Verify each separated entity has valid geometry, tight OBB, and metadata
    for (const obj of scene.objects) {
      expect(obj.id).toBeDefined();
      expect(obj.name).toBeDefined();
      expect(obj.category).toBeDefined();
      expect(obj.orientedBoundingBox).toBeDefined();
      expect(obj.orientedBoundingBox.dimensions[0]).toBeGreaterThan(0);
      expect(obj.orientedBoundingBox.dimensions[1]).toBeGreaterThan(0);
      expect(obj.orientedBoundingBox.dimensions[2]).toBeGreaterThan(0);
      expect(obj.orientedBoundingBox.volumeM3).toBeGreaterThan(0);
      expect(obj.orientedBoundingBox.tightnessGainPercent).toBeGreaterThanOrEqual(0);
      expect(obj.vertexCount).toBeGreaterThan(0);
      expect(obj.submeshIndices.length).toBeGreaterThan(0);
    }
  });

  it('routes detected entities to appropriate downstream generators (botanical, archi, terrain, building)', async () => {
    const service = new Universal3DObjectSeparationService();

    const scene = await service.separate({
      glbPath: colosseumModelPath,
      granularity: 'macro',
      autoDetectSemanticCategories: true
    });

    const categories = new Set(scene.objects.map(o => o.category));
    expect(categories.has('monument') || categories.has('colosseum_architecture')).toBe(true);
    expect(categories.has('foliage') || categories.has('foliage_trees')).toBe(true);
    expect(categories.has('terrain')).toBe(true);

    // Verify foliage routing metadata
    const foliageObjs = scene.objects.filter(o => o.category === 'foliage' || o.category === 'foliage_trees');
    expect(foliageObjs.length).toBeGreaterThan(0);
    for (const fol of foliageObjs) {
      expect(fol.routingRecommendation).toBe('sb-veggie');
    }

    // Verify monument routing metadata
    const monumentObjs = scene.objects.filter(o => o.category === 'monument' || o.category === 'colosseum_architecture');
    expect(monumentObjs.length).toBeGreaterThan(0);
    for (const mon of monumentObjs) {
      expect(['sb-archi', 'archie-building'].includes(mon.routingRecommendation!)).toBe(true);
    }

    // Verify terrain routing metadata
    const terrainObjs = scene.objects.filter(o => o.category === 'terrain');
    expect(terrainObjs.length).toBeGreaterThan(0);
    for (const ter of terrainObjs) {
      expect(ter.routingRecommendation).toBe('sb-terrain');
    }
  });

  it('synthesizes canonical Scene3DData with Media4DObject contracts', async () => {
    const service = new Universal3DObjectSeparationService();

    const result = await service.separateAndPopulateScene({
      glbPath: colosseumModelPath,
      granularity: 'macro'
    });

    expect(result.populatedScene).toBeDefined();
    expect(result.populatedScene.objects.length).toBe(result.scene.objects.length);

    for (const obj of result.populatedScene.objects) {
      expect(obj.id).toBeDefined();
      expect(obj.content.type).toBe('3d-model');
      expect(obj.space.spatial3d).toBeDefined();
      expect(obj.space.spatial3d?.position).toBeDefined();
      expect(obj.space.spatial3d?.boundingBox).toBeDefined();
    }
  });
});
