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
import * as os from 'os';
import {
  Universal3DObjectSeparationService,
  type UniversalSeparationOptions,
  type UniversalSeparatedScene
} from '../src/node/spatial/Universal3DObjectSeparationService';
import { BoundingBoxComparisonService } from '../src/node/spatial/BoundingBoxComparisonService';
import { GoogleTileAlignmentOptimizer } from '../src/node/spatial/GoogleTileAlignmentOptimizer';
import { AlgorithmicUvEngine } from '../src/node/spatial/AlgorithmicUvEngine';
import { REPO_ROOT, requireAsset, withReason } from './helpers/requirements';

/**
 * The canonical Colosseum mesh. public/models/ is gitignored, but the identical file is tracked as the Cloud Run
 * spatial-separator asset (deploy/cloud-run/spatial-separator/assets/colosseum_clay.glb, added in 6bb97f1).
 */
function resolveCanonicalColosseumGlb(): string {
  const candidates = [
    'public/models/colosseum_grounded.glb',
    'public/models/colosseum_clay.glb',
    'deploy/cloud-run/spatial-separator/assets/colosseum_clay.glb'
  ].map(p => path.join(REPO_ROOT, p));
  return candidates.find(p => fs.existsSync(p)) ?? candidates[candidates.length - 1];
}

// Raw Google 3D Tile captures of Washington Square Arch (gitignored; no producer script in the repo).
const ARCH_RAW = 'public/models/washington_square_arch_nyc_raw.glb';
const ARCH_HQ = 'public/models/washington_arch_hq.glb';
const ARCH_TILE_100M = 'public/tiles/washington_square_arch_100m.glb';
const archRaw = requireAsset(ARCH_RAW);
const archHq = requireAsset(ARCH_HQ);
const archTile = requireAsset(ARCH_TILE_100M);

describe('Universal3DObjectSeparationService (Zero-Preset 3D Entity Separation)', () => {
  const colosseumModelPath = resolveCanonicalColosseumGlb();

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
    expect(scene.objects.length).toBeGreaterThanOrEqual(3);
    // every submesh is reported once, in the category its own geometry put it in (none moved to fill a category)
    const all = scene.objects.flatMap(o => o.submeshIndices);
    expect(new Set(all).size).toBe(all.length);

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

    // Only categories the geometry supports are reported; nothing is moved into a category so that it exists. This
    // model's submeshes measure as tall, low and other structures; none is broad and low enough for terrain. A box
    // shows size, not what a thing is: nothing is called a monument, a ruin or vegetation.
    const categories = new Set(scene.objects.map(o => o.category));
    expect(categories.has('architecture')).toBe(true);
    expect(categories.has('monument')).toBe(false);
    expect(categories.has('ruin')).toBe(false);
    expect(categories.has('terrain')).toBe(false);
    expect(categories.has('foliage')).toBe(false);
    expect(categories.has('foliage_trees')).toBe(false);
    for (const obj of scene.objects) {
      expect(obj.submeshIndices.length).toBeGreaterThan(0);
      expect(obj.name).not.toMatch(/monument|ruin|archaeolog|classical|ancient/i);
      expect(obj.trellisPrompt).not.toMatch(/monument|ruin|archaeolog|classical|ancient/i);
    }

    // Verify structure routing metadata
    const structures = scene.objects.filter(o => o.category === 'architecture');
    expect(structures.length).toBeGreaterThan(0);
    for (const s of structures) {
      expect(s.routingRecommendation).toBe('archie-building');
    }

    // Verify terrain routing metadata (when terrain is detected)
    const terrainObjs = scene.objects.filter(o => o.category === 'terrain');
    for (const ter of terrainObjs) {
      expect(ter.routingRecommendation).toBe('sb-terrain');
    }
  });

  it('names no trees from geometry alone: no tree stage, no species, and granularity "trees" fails with the reason', async () => {
    // vertex-level clustering on a real mesh: local height peaks with scattered normals are facade relief, cornices and
    // rooftop units as often as crowns, so none of them is called a tree or given a species
    const scene = Universal3DObjectSeparationService.separate3DMesh(colosseumModelPath, { granularity: 'detailed', autoDetectSemanticCategories: true });
    expect(scene.objects.length).toBeGreaterThan(0);
    for (const obj of scene.objects) {
      expect(['foliage', 'foliage_trees']).not.toContain(obj.category);
      expect(obj.routingRecommendation).not.toBe('sb-veggie');
      expect((obj as any).treeMetadata).toBeUndefined();
      expect(`${obj.name} ${obj.trellisPrompt}`).not.toMatch(/oak|pine|cypress|botanical/i);
    }
    expect(() => Universal3DObjectSeparationService.separate3DMesh(colosseumModelPath, { granularity: 'trees' as any }))
      .toThrow("granularity 'trees' has been removed");

    // through the agent tool the model sees the same: the call fails with the reason, and the declaration no longer
    // offers the mode
    const { createDefaultToolRegistry } = await import('../src/node/gemini/tool-registry');
    const registry = createDefaultToolRegistry();
    const decl = registry.declarations().find((d: any) => d.name === 'spatial_separate_3d_objects') as any;
    expect(decl.parameters.properties.granularity.enum).not.toContain('trees');
    const out: any = await registry.dispatch('spatial_separate_3d_objects', { glbPath: colosseumModelPath, granularity: 'trees' }, {} as any);
    expect(out.exec.status).toBe('failed');
    expect(JSON.stringify(out)).toContain('google_3d_tiles_get_clay measures');
  });

  it('names no vehicles, and no building use, style or landmark identity, from geometry alone', async () => {
    // a car-sized box near the ground is as often a kiosk, a planter or a lump of the scan's drape as a car; a tall
    // envelope is not "Art Deco residential"; and the structure at the anchor is whatever the caller says it is
    const scene = Universal3DObjectSeparationService.separate3DMesh(colosseumModelPath, { granularity: 'detailed', autoDetectSemanticCategories: true });
    expect(scene.objects.length).toBeGreaterThan(0);
    for (const obj of scene.objects) {
      expect(obj.category).not.toBe('vehicle');
      expect(obj.routingRecommendation).not.toBe('sb-vehicle');
      expect((obj as any).vehicleMetadata).toBeUndefined();
      expect(`${obj.name} ${obj.trellisPrompt}`).not.toMatch(/sedan|suv|van\b|car\b|parked|art deco|residential|townhouse|washington|monument|neoclassical/i);
    }
    const buildings = scene.objects.filter(o => o.category === 'architecture');
    expect(buildings.length).toBeGreaterThan(0);
    for (const b of buildings) expect(b.trellisPrompt).toMatch(/^Building envelope, [\d.]+ m x [\d.]+ m footprint, [\d.]+ m tall$/);
    // no structure is cut out at the origin and called the landmark unless the caller says where it stands
    expect(scene.objects.filter(o => o.category === 'landmark')).toEqual([]);
    // given where it stands, it is named only as the caller names it (or not at all), with its measured size
    const bounds = { minX: -60, maxX: 60, minZ: -60, maxZ: 60 };
    const unnamed = Universal3DObjectSeparationService.separate3DMesh(colosseumModelPath, { granularity: 'detailed', autoDetectSemanticCategories: true, focalInterestBounds: bounds });
    const anchorStructure = unnamed.objects.find(o => o.category === 'landmark');
    expect(anchorStructure?.name).toBe('Structure at the anchor');
    expect(anchorStructure?.trellisPrompt).toMatch(/^Structure at the anchor \([\d.]+ m x [\d.]+ m, [\d.]+ m tall\)$/);
    const named = Universal3DObjectSeparationService.separate3DMesh(colosseumModelPath, { granularity: 'detailed', autoDetectSemanticCategories: true, focalInterestBounds: bounds, landmarkName: 'Colosseum', architecturalStyle: 'Roman amphitheatre' });
    const landmark = named.objects.find(o => o.category === 'landmark');
    expect(landmark?.name).toBe('Colosseum');
    expect(landmark?.trellisPrompt).toMatch(/^Colosseum, Roman amphitheatre \(/);
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

  it.skipIf(!archRaw.ok)(withReason('performs vertex-level facade and terrain clustering on raw Google 3D Tile (Washington Square Arch), naming no trees', archRaw), async () => {
    const archPath = path.join(REPO_ROOT, ARCH_RAW);

    const scene = Universal3DObjectSeparationService.separate3DMesh(archPath, {
      granularity: 'detailed',
      autoDetectSemanticCategories: true
    });

    expect(scene).toBeDefined();
    expect(scene.totalVertices).toBe(4277);
    expect(scene.objects.length).toBeGreaterThan(0);

    // Verify categories breakdown: geometry alone names no trees (they are measured from the photo tiles elsewhere)
    const categories = new Set(scene.objects.map(o => o.category));
    expect(categories.has('terrain')).toBe(true);
    expect(categories.has('foliage_trees')).toBe(false);
    expect(categories.has('monument') || categories.has('architecture')).toBe(true);

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

  it.skipIf(!archHq.ok)(withReason('performs high-resolution separation on HQ Leaf 3D Tile: the landmark named as the caller names it, architecture, and no trees or vehicles named from geometry', archHq), async () => {
    const hqPath = path.join(REPO_ROOT, ARCH_HQ);

    const scene = Universal3DObjectSeparationService.separate3DMesh(hqPath, {
      granularity: 'detailed',
      autoDetectSemanticCategories: true,
      landmarkName: 'Washington Square Arch',
      landmarkType: 'triumphal_arch',
      architecturalStyle: 'Neoclassical triumphal arch',
      // where the caller says the arch stands (the separation guesses no landmark box of its own)
      focalInterestBounds: { minX: -16.5, maxX: 16.5, minZ: -8.5, maxZ: 8.5 }
    });

    expect(scene).toBeDefined();
    expect(scene.totalVertices).toBe(295217);
    expect(scene.totalSubmeshes).toBe(94);
    expect(scene.objects.length).toBeGreaterThan(0);

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

    // 2. No vehicles from geometry alone: a car-sized box near the ground is as often a kiosk or a lump of drape
    expect(scene.objects.filter(o => o.category === 'vehicle')).toHaveLength(0);

    // 3. No trees from geometry alone (no species either)
    expect(scene.objects.filter(o => o.category === 'foliage_trees')).toHaveLength(0);
  });

  it.skipIf(!archHq.ok)(withReason('verifies BoundingBoxComparisonService metrology and GoogleTileAlignmentOptimizer asset docking contracts on separated entities', archHq), async () => {
    const hqPath = path.join(REPO_ROOT, ARCH_HQ);

    const scene = Universal3DObjectSeparationService.separate3DMesh(hqPath, {
      granularity: 'detailed',
      autoDetectSemanticCategories: true
    });

    expect(scene).toBeDefined();

    // 1. Verify BoundingBoxComparisonService metrology on the separated building envelopes
    const buildings = scene.objects.filter(o => o.category === 'architecture');
    expect(buildings.length).toBeGreaterThanOrEqual(2);

    for (const v of buildings) {
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

    // 2. Verify GoogleTileAlignmentOptimizer docking contracts on the first building envelope
    const targetCar = buildings[0]!;
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
        initialYawDeg: targetCar.orientedBoundingBox.yawDeg || 0
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

  it.skipIf(!archTile.ok)(withReason('partitions fused 3D tile geometry into part-aware glTF primitives with independent PBR materials and local OBB UV coordinates', archTile), async () => {
    const tileGlbPath = path.join(REPO_ROOT, ARCH_TILE_100M);

    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-part-aware-'));
    const outGlbPath = path.join(outDir, 'washington_square_arch_part_aware.glb');

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
    expect(categories.some((c: string) => c === 'architecture' || c === 'terrain')).toBe(true);
    expect(categories).not.toContain('foliage_trees');

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
    fs.rmSync(outDir, { recursive: true, force: true });
  });
});

