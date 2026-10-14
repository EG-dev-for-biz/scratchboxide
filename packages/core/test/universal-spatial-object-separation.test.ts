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
import { BoundingBoxComparisonService } from '../src/node/spatial/BoundingBoxComparisonService';
import { GoogleTileAlignmentOptimizer } from '../src/node/spatial/GoogleTileAlignmentOptimizer';
import { AlgorithmicUvEngine } from '../src/node/spatial/AlgorithmicUvEngine';

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

  it('performs high-resolution semantic separation on HQ Leaf 3D Tile (Landmarks, Vehicles, Trees, Architecture)', async () => {
    const hqPath = path.resolve(__dirname, '../../../public/models/washington_arch_hq.glb');
    if (!fs.existsSync(hqPath)) return;

    const scene = Universal3DObjectSeparationService.separate3DMesh(hqPath, {
      granularity: 'detailed',
      autoDetectSemanticCategories: true,
      landmarkName: 'Washington Square Arch',
      landmarkType: 'triumphal_arch'
    });

    expect(scene).toBeDefined();
    expect(scene.totalVertices).toBe(295217);
    expect(scene.totalSubmeshes).toBe(94);
    expect(scene.objects.length).toBeGreaterThanOrEqual(180);

    // 1. Primary Landmark Verification
    const landmarks = scene.objects.filter(o => o.category === 'landmark');
    expect(landmarks.length).toBe(1);
    const arch = landmarks[0]!;
    expect(arch.name).toContain('Washington Square Arch');
    expect(arch.landmarkMetadata).toBeDefined();
    expect(arch.landmarkMetadata?.landmarkType).toBe('triumphal_arch');
    expect(arch.landmarkMetadata?.architecturalStyle).toContain('Neoclassical');
    expect(arch.routingRecommendation).toBe('sb-archi');
    expect(arch.vertexCount).toBeGreaterThan(1500);

    // 2. Ground-Level Vehicle Verification
    const vehicles = scene.objects.filter(o => o.category === 'vehicle');
    expect(vehicles.length).toBeGreaterThanOrEqual(12);
    for (const v of vehicles) {
      expect(v.vehicleMetadata).toBeDefined();
      expect(['sedan', 'suv', 'van_truck', 'compact']).toContain(v.vehicleMetadata?.vehicleType);
      expect(v.vehicleMetadata?.lengthMeters).toBeGreaterThanOrEqual(2.5);
      expect(v.vehicleMetadata?.lengthMeters).toBeLessThanOrEqual(8.5);
      expect(v.vehicleMetadata?.headingDeg).toBeDefined();
      expect(v.routingRecommendation).toBe('sb-vehicle');
    }

    // 3. Botanical Trees Verification
    const trees = scene.objects.filter(o => o.category === 'foliage_trees');
    expect(trees.length).toBeGreaterThanOrEqual(150);
    const oaks = trees.filter(t => t.treeMetadata?.species === 'quercus_ilex');
    expect(oaks.length).toBeGreaterThan(50);
  });

  it('verifies BoundingBoxComparisonService metrology and GoogleTileAlignmentOptimizer asset docking contracts on separated entities', async () => {
    const hqPath = path.resolve(__dirname, '../../../public/models/washington_arch_hq.glb');
    if (!fs.existsSync(hqPath)) return;

    const scene = Universal3DObjectSeparationService.separate3DMesh(hqPath, {
      granularity: 'detailed',
      autoDetectSemanticCategories: true
    });

    expect(scene).toBeDefined();

    // 1. Verify BoundingBoxComparisonService metrology on Vehicles
    const vehicles = scene.objects.filter(o => o.category === 'vehicle');
    expect(vehicles.length).toBeGreaterThanOrEqual(12);

    for (const v of vehicles) {
      const obb = v.orientedBoundingBox;
      expect(obb).toBeDefined();

      const cornersOBB = BoundingBoxComparisonService.computeCornersOBB(obb);
      expect(cornersOBB.length).toBe(8);

      // Derive AABB from corners
      const minX = Math.min(...cornersOBB.map(c => c[0]));
      const maxX = Math.max(...cornersOBB.map(c => c[0]));
      const minY = Math.min(...cornersOBB.map(c => c[1]));
      const maxY = Math.max(...cornersOBB.map(c => c[1]));
      const minZ = Math.min(...cornersOBB.map(c => c[2]));
      const maxZ = Math.max(...cornersOBB.map(c => c[2]));

      const aabb = {
        min: [minX, minY, minZ] as [number, number, number],
        max: [maxX, maxY, maxZ] as [number, number, number],
        dimensions: [maxX - minX, maxY - minY, maxZ - minZ] as [number, number, number],
        volumeM3: (maxX - minX) * (maxY - minY) * (maxZ - minZ),
        centroid: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2] as [number, number, number]
      };

      const metrology = BoundingBoxComparisonService.computeMetrology(aabb, obb);
      expect(metrology.volumeAABBM3).toBeGreaterThan(0);
      expect(metrology.volumeOBBM3).toBeGreaterThan(0);
      expect(metrology.airPenaltyRatio).toBeGreaterThanOrEqual(1.0);
      expect(metrology.tightnessGainPercent).toBeGreaterThanOrEqual(0);
    }

    // 2. Verify GoogleTileAlignmentOptimizer docking contracts on Vehicle #1
    const targetCar = vehicles[0]!;
    const generativeVanBounds = {
      min: [-1.05, 0, -2.5] as [number, number, number],
      max: [1.05, 2.4, 2.5] as [number, number, number],
      dimensions: [2.1, 2.4, 5.0] as [number, number, number],
      centroid: [0, 1.2, 0] as [number, number, number]
    };

    const targetTileBounds = {
      min: [
        targetCar.orientedBoundingBox.center[0] - targetCar.orientedBoundingBox.dimensions[0] / 2,
        targetCar.orientedBoundingBox.center[1] - targetCar.orientedBoundingBox.dimensions[1] / 2,
        targetCar.orientedBoundingBox.center[2] - targetCar.orientedBoundingBox.dimensions[2] / 2
      ] as [number, number, number],
      max: [
        targetCar.orientedBoundingBox.center[0] + targetCar.orientedBoundingBox.dimensions[0] / 2,
        targetCar.orientedBoundingBox.center[1] + targetCar.orientedBoundingBox.dimensions[1] / 2,
        targetCar.orientedBoundingBox.center[2] + targetCar.orientedBoundingBox.dimensions[2] / 2
      ] as [number, number, number],
      dimensions: targetCar.orientedBoundingBox.dimensions,
      centroid: targetCar.orientedBoundingBox.center
    };

    const alignment = GoogleTileAlignmentOptimizer.computeMetricAlignment(
      generativeVanBounds,
      targetTileBounds,
      {
        preserveAspectRatio: true,
        groundSnap: true,
        initialYawDeg: targetCar.vehicleMetadata?.headingDeg || 0
      }
    );

    expect(alignment).toBeDefined();
    expect(alignment.scale[0]).toBeGreaterThan(0);
    expect(alignment.scale[1]).toBeGreaterThan(0);
    expect(alignment.scale[2]).toBeGreaterThan(0);
    expect(alignment.translation).toBeDefined();
    // Verify ground snap: lowest vertex of source placed exactly at lowest vertex of target
    const sourceBottomY = generativeVanBounds.min[1] * alignment.scale[1] + alignment.translation[1];
    expect(Math.abs(sourceBottomY - targetTileBounds.min[1])).toBeLessThan(0.001);
    expect(alignment.transformMatrix4x4.length).toBe(16);
  });

  it('partitions fused 3D tile geometry into part-aware glTF primitives with independent PBR materials and local OBB UV coordinates', async () => {
    const tileGlbPath = path.resolve(__dirname, '../../../public/tiles/washington_square_arch_100m.glb');
    if (!fs.existsSync(tileGlbPath)) return;

    const outGlbPath = path.resolve(__dirname, '../../../public/tiles/washington_square_arch_part_aware.glb');

    const result = Universal3DObjectSeparationService.generatePartAwareGlb({
      glbPath: tileGlbPath,
      granularity: 'all',
      outputGlbPath: outGlbPath,
      localUvProjection: true,
      facadeUvScale: 0.25,
      focalInterestBounds: {
        minX: -16.5,
        maxX: 16.5,
        minZ: -8.5,
        maxZ: 8.5
      },
      landmarkName: 'Washington Square Arch',
      landmarkType: 'triumphal_arch'
    });

    expect(result.glbBuffer).toBeDefined();
    expect(result.glbBuffer.length).toBeGreaterThan(1000);
    expect(result.materialCount).toBeGreaterThan(1);
    expect(result.primitiveCount).toBeGreaterThan(1);
    expect(result.entityCount).toBeGreaterThan(1);

    // Parse the generated part-aware GLB
    const parsed = AlgorithmicUvEngine.parseGlb(result.glbBuffer);
    expect(parsed.json.materials.length).toBe(result.materialCount);
    expect(parsed.json.meshes[0].primitives.length).toBe(result.primitiveCount);

    // Verify materials have dedicated part categories in extras
    const categories = parsed.json.materials.map((m: any) => m.extras?.category);
    expect(categories).toContain('landmark');
    expect(categories.some((c: string) => c === 'foliage_trees' || c === 'architecture' || c === 'terrain')).toBe(true);

    // Verify each primitive has local OBB-conformal UV coordinates (TEXCOORD_0)
    for (const prim of parsed.json.meshes[0].primitives) {
      expect(prim.attributes.POSITION).toBeDefined();
      expect(prim.attributes.TEXCOORD_0).toBeDefined();
      expect(prim.material).toBeDefined();
      const mat = parsed.json.materials[prim.material];
      expect(mat.pbrMetallicRoughness).toBeDefined();
      expect(mat.pbrMetallicRoughness.baseColorFactor).toBeDefined();
      expect(mat.pbrMetallicRoughness.roughnessFactor).toBeGreaterThan(0);
    }

    // Verify integration with AlgorithmicUvEngine part-aware PBR processing
    const uvResult = await AlgorithmicUvEngine.processGlb({
      inputGlbBuffer: result.glbBuffer,
      enablePartAwarePbr: true,
      detailSynthesis: {
        protectRoads: true,
        protectFoliage: true
      }
    });

    expect(uvResult.outputGlbBuffer?.length ?? 0).toBeGreaterThan(1000);
    expect(uvResult.verticesProcessed).toBeGreaterThan(0);

    // Cleanup generated file
    if (fs.existsSync(outGlbPath)) {
      fs.unlinkSync(outGlbPath);
    }
  });
});

