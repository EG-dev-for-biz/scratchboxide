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
import * as fs from 'fs';
import {
  Universal3DObjectSeparationService,
  type UniversalSeparationOptions,
  type UniversalSeparatedScene
} from '../src/node/spatial/Universal3DObjectSeparationService';

describe('Universal3DObjectSeparationService (Zero-Preset 3D Entity Separation)', () => {
  const colosseumModelPath = fs.existsSync(path.resolve(__dirname, '../../../public/models/colosseum_grounded.glb'))
    ? path.resolve(__dirname, '../../../public/models/colosseum_grounded.glb')
    : path.resolve(__dirname, '../../../public/models/colosseum_clay.glb');

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

  it('performs vertex-level Tree Apex & Facade clustering on raw Google 3D Tile (Washington Square Arch)', async () => {
    const archPath = path.resolve(__dirname, '../../../public/models/washington_square_arch_nyc_raw.glb');
    if (!fs.existsSync(archPath)) return;

    const scene = Universal3DObjectSeparationService.separate3DMesh(archPath, {
      granularity: 'detailed',
      autoDetectSemanticCategories: true
    });

    expect(scene).toBeDefined();
    expect(scene.totalVertices).toBe(4277);
    expect(scene.objects.length).toBeGreaterThanOrEqual(25);

    // Verify categories breakdown
    const categories = new Set(scene.objects.map(o => o.category));
    expect(categories.has('terrain')).toBe(true);
    expect(categories.has('foliage_trees')).toBe(true);
    expect(categories.has('monument') || categories.has('architecture')).toBe(true);

    // Verify individual trees
    const treeEntities = scene.objects.filter(o => o.category === 'foliage_trees');
    expect(treeEntities.length).toBeGreaterThanOrEqual(15);

    for (const tree of treeEntities) {
      expect(tree.orientedBoundingBox).toBeDefined();
      expect(tree.orientedBoundingBox.dimensions[0]).toBeGreaterThan(0);
      expect(tree.orientedBoundingBox.dimensions[1]).toBeGreaterThan(0);
      expect(tree.orientedBoundingBox.dimensions[2]).toBeGreaterThan(0);
      expect(tree.routingRecommendation).toBe('sb-veggie');

      // Verify botanical metadata
      expect(tree.treeMetadata).toBeDefined();
      expect(['quercus_ilex', 'pinus_pinea', 'cupressus_sempervirens', 'olea_europaea', 'laurus_nobilis']).toContain(tree.treeMetadata.species);
      expect(tree.treeMetadata.canopyHeightMeters).toBeGreaterThan(0);
      expect(tree.treeMetadata.crownDiameterMeters).toBeGreaterThan(0);
      expect(tree.treeMetadata.crownVolumeM3).toBeGreaterThan(0);
    }

    // Verify terrain ground apron
    const terrainEntity = scene.objects.find(o => o.category === 'terrain');
    expect(terrainEntity).toBeDefined();
    expect(terrainEntity!.routingRecommendation).toBe('sb-terrain');
    expect(terrainEntity!.orientedBoundingBox.dimensions[0]).toBeGreaterThan(30);

    // Verify architecture & monument facades
    const structuralEntities = scene.objects.filter(o => o.category === 'monument' || o.category === 'architecture');
    expect(structuralEntities.length).toBeGreaterThanOrEqual(2);
    for (const struct of structuralEntities) {
      expect(['sb-archi', 'archie-building']).toContain(struct.routingRecommendation);
      expect(struct.vertexCount).toBeGreaterThan(0);
    }
  });
});
