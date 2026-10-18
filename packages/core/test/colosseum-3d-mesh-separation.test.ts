/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  Colosseum3DMeshSeparatorService,
  COLOSSEUM_3D_ENTITIES,
  COLOSSEUM_GRANULAR_3D_ENTITIES,
  type Separated3DScene
} from '../src/node/spatial/Colosseum3DMeshSeparatorService';
import { OrientedBoundingBoxSolver } from '../src/node/spatial/OrientedBoundingBoxSolver';
import { REPO_ROOT } from './helpers/requirements';

/**
 * The canonical Colosseum mesh (234,679 vertices, 79 submeshes). public/models/ is gitignored, but the identical file
 * is tracked as the Cloud Run spatial-separator asset (deploy/cloud-run/spatial-separator/assets/colosseum_clay.glb,
 * added in 6bb97f1), so a clean checkout still exercises the separator on the real model.
 */
function resolveCanonicalColosseumGlb(): string {
  const candidates = [
    'public/models/colosseum_grounded.glb',
    'public/models/colosseum_clay.glb',
    'deploy/cloud-run/spatial-separator/assets/colosseum_clay.glb'
  ].map(p => path.join(REPO_ROOT, p));
  return candidates.find(p => fs.existsSync(p)) ?? candidates[candidates.length - 1];
}

describe('Colosseum3DMeshSeparatorService (Direct 3D Mesh Object Separation & OBB)', () => {
  const modelPath = resolveCanonicalColosseumGlb();
  // Entity datasets are written to a temp dir: the tracked copies under deploy/ and public/ are deployment artifacts
  // regenerated deliberately, not on every test run.
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-colosseum-separation-'));
  afterAll(() => fs.rmSync(outDir, { recursive: true, force: true }));

  it('verifies the existence and size of the canonical Colosseum 3D model', () => {
    expect(fs.existsSync(modelPath)).toBe(true);
    const stats = fs.statSync(modelPath);
    expect(stats.size).toBeGreaterThan(5 * 1024 * 1024); // > 5 MB
  });

  it('ingests and parses raw binary glTF (.glb) 3D mesh geometry', () => {
    const scene = Colosseum3DMeshSeparatorService.separate3DMesh(modelPath);

    expect(scene).toBeDefined();
    expect(scene.totalVertices).toBe(234679);
    expect(scene.totalSubmeshes).toBe(79);
    expect(scene.modelName).toBe('Colosseum_Rome_Isolated_360');

    // Verify overall bounding box in meters
    const { dimensions, centroid } = scene.overallBoundingBox;
    expect(dimensions[0]).toBeCloseTo(685.78, 1);
    expect(dimensions[1]).toBeCloseTo(84.12, 1);
    expect(dimensions[2]).toBeCloseTo(610.21, 1);
    expect(centroid[0]).toBeCloseTo(0.0, 1);
    expect(centroid[2]).toBeCloseTo(0.0, 1);
  });

  it('separates 8 discrete 3D spatial entities in macro mode, none of them a named tree', () => {
    const scene = Colosseum3DMeshSeparatorService.separate3DMesh(modelPath, { mode: 'macro' });
    expect(scene.objects.length).toBe(8);
    expect(scene.granularityMode).toBe('macro');

    const categories = new Set(scene.objects.map(o => o.category));
    expect(categories.has('monument')).toBe(true);
    expect(categories.has('ruin')).toBe(true);
    expect(categories.has('terrain')).toBe(true);
    // the stone pines and cypress were a hand-written list (species, places, sizes), not identified in the mesh
    expect(categories.has('foliage')).toBe(false);
    expect(COLOSSEUM_3D_ENTITIES.filter(e => /pine|cypress|pinus|cupressus/i.test(`${e.name} ${e.trellisPrompt}`))).toEqual([]);

    fs.writeFileSync(path.join(outDir, 'macro_entities.json'), JSON.stringify(scene.objects, null, 2), 'utf8');
  });

  it('extracts exact metric dimensions and vertex counts for key architectural monuments', () => {
    const scene = Colosseum3DMeshSeparatorService.separate3DMesh(modelPath, { mode: 'macro' });

    // 1. Colosseum Outer Arcade Facade
    const colosseum = scene.objects.find(o => o.id === 'det-colosseum-facade');
    expect(colosseum).toBeDefined();
    expect(colosseum!.vertexCount).toBeGreaterThan(30000); // 74,000+ vertices across facade submeshes
    expect(colosseum!.boundingBox.dimensions[0]).toBeGreaterThan(150); // > 150m wide
    expect(colosseum!.boundingBox.dimensions[2]).toBeGreaterThan(120); // > 120m deep
    expect(colosseum!.trellisPrompt).toContain('travertine limestone facade');

    // 2. Arch of Constantine (now isolated from octree chunk: 317 verts vs 5,778 in raw chunk)
    const arch = scene.objects.find(o => o.id === 'det-arch-constantine');
    expect(arch).toBeDefined();
    expect(arch!.vertexCount).toBeGreaterThan(250);
    expect(arch!.boundingBox.dimensions[0]).toBeGreaterThan(15);
    expect(arch!.trellisPrompt).toMatch(/arch of constantine/i);
    // Verifying isolated OBB volume is under 35,000 m³ (shrunk by 97.1% vs 1,047,873 m³ raw octree chunk)
    expect(arch!.orientedBoundingBox.volumeM3).toBeLessThan(35000);
    expect(arch!.orientedBoundingBox.yawDeg).toBeDefined();

    // 3. Meta Sudans Ruins
    const metaSudans = scene.objects.find(o => o.id === 'det-meta-sudans');
    expect(metaSudans).toBeDefined();
    expect(metaSudans!.category).toBe('ruin');

    // 4. Cobblestone Apron (Terrain)
    const apron = scene.objects.find(o => o.id === 'det-cobblestone-apron');
    expect(apron).toBeDefined();
    expect(apron!.category).toBe('terrain');
    expect(apron!.submeshIndices.length).toBeGreaterThan(15);
  });

  it('separates 34 granular 3D spatial entities in detailed mode with tight 3D Oriented Bounding Boxes (OBBs)', () => {
    const scene = Colosseum3DMeshSeparatorService.separate3DMesh(modelPath, { mode: 'detailed' });

    expect(scene.objects.length).toBe(34);
    expect(scene.granularityMode).toBe('detailed');
    expect(scene.objectCounts).toBeDefined();
    expect(scene.objectCounts!.colosseum_architecture).toBe(12);
    expect(scene.objectCounts!.monuments_temples).toBe(8);
    expect(scene.objectCounts!.foliage_trees).toBe(0);
    expect(scene.objectCounts!.archaeology_ruins).toBe(8);
    expect(scene.objectCounts!.urban_infrastructure).toBe(6);

    // Verify all 34 entities have valid OBB, dimensions, and non-empty vertex counts
    for (const obj of scene.objects) {
      expect(obj.orientedBoundingBox).toBeDefined();
      expect(obj.orientedBoundingBox.dimensions[0]).toBeGreaterThan(0);
      expect(obj.orientedBoundingBox.dimensions[1]).toBeGreaterThan(0);
      expect(obj.orientedBoundingBox.dimensions[2]).toBeGreaterThan(0);
      expect(obj.orientedBoundingBox.volumeM3).toBeGreaterThan(0);
      expect(obj.orientedBoundingBox.quaternion).toHaveLength(4);
      // The mesh's own counts: an entity whose region matched no vertices reports 0 (its box is the nominal one),
      // not the 8 corners of that box.
      expect(obj.vertexCount).toBeGreaterThanOrEqual(0);
      expect(obj.triangleCount).toBeLessThanOrEqual(Math.max(0, obj.vertexCount * 3));
    }

    // Check specific granular entities
    // 1. Colosseum North Outer Facade
    const northFacade = scene.objects.find(o => o.id === 'arch-colosseum-outer-facade-north');
    expect(northFacade).toBeDefined();
    expect(northFacade!.vertexCount).toBeGreaterThan(10000);
    expect(northFacade!.orientedBoundingBox.dimensions[0]).toBeGreaterThan(100);

    // 2. Arch of Constantine Attic Inscription Block (displays positive OBB tightness gain)
    const archAttic = scene.objects.find(o => o.id === 'mon-arch-constantine-attic');
    expect(archAttic).toBeDefined();
    expect(archAttic!.orientedBoundingBox.volumeM3).toBeLessThan(10000);
    expect(archAttic!.tightnessGainPercent).toBeGreaterThan(15); // > 15% tighter than AABB

    // 3. Baths of Titus Wall Remains (displays strong OBB tightness gain > 50%)
    const titusBaths = scene.objects.find(o => o.id === 'ruin-titus-baths-wall');
    expect(titusBaths).toBeDefined();
    expect(titusBaths!.tightnessGainPercent).toBeGreaterThan(50);

    // 4. No trees: the 12 stone pines and 6 cypresses were placed by formula (positions, sizes, species), not found
    expect(scene.objects.filter(o => o.id.startsWith('fol-'))).toEqual([]);
    expect(COLOSSEUM_GRANULAR_3D_ENTITIES.filter(e => e.category === 'foliage_trees' || /pine|cypress|pinus|cupressus/i.test(e.name))).toEqual([]);

    // 5. Urban Infrastructure: Metro Colosseo and Via Nicola Salvi townhouses
    const metro = scene.objects.find(o => o.id === 'urb-metro-colosseo-pavilion');
    expect(metro).toBeDefined();
    expect(metro!.category).toBe('urban_infrastructure');

    const salviA = scene.objects.find(o => o.id === 'urb-via-nicola-salvi-bldg-1');
    expect(salviA).toBeDefined();
    expect(salviA!.category).toBe('urban_infrastructure');

    fs.writeFileSync(path.join(outDir, 'detailed_entities.json'), JSON.stringify(scene.objects, null, 2), 'utf8');
  });

  it('OrientedBoundingBoxSolver mathematically minimizes bounding box volume along dominant yaw angle', () => {
    // Synthetic rotated rectangle: 20m x 4m oriented at 45 degrees
    const theta = Math.PI / 4; // 45 deg
    const cosT = Math.cos(theta), sinT = Math.sin(theta);
    const verts: [number, number, number][] = [];

    for (let u = -10; u <= 10; u += 1) {
      for (let w = -2; w <= 2; w += 1) {
        const x = u * cosT - w * sinT;
        const z = u * sinT + w * cosT;
        verts.push([x, 5.0, z]);
      }
    }

    const { aabb, obb } = OrientedBoundingBoxSolver.compute(verts);

    expect(obb.yawDeg).toBeCloseTo(45, 0);
    expect(obb.dimensions[0]).toBeCloseTo(20, 0); // local width
    expect(obb.dimensions[2]).toBeCloseTo(4, 0);  // local depth
    // AABB at 45 deg is ~ (20+4)*sqrt(2)/2 ≈ 17m in both X and Z -> Area ~ 289 m²
    // OBB Area = 20 * 4 = 80 m²
    // Tightness gain should be > 60%
    expect(obb.tightnessGainPercent).toBeGreaterThan(60);
    expect(obb.volumeM3).toBeLessThan(aabb.volumeM3);
  });

  it('generates an actionable 3D mesh object separation report for both modes', () => {
    const sceneMacro = Colosseum3DMeshSeparatorService.separate3DMesh(modelPath, { mode: 'macro' });
    const reportMacro = Colosseum3DMeshSeparatorService.generateReport(sceneMacro);

    expect(reportMacro).toContain('=== 3D MESH OBJECT SEPARATION REPORT ===');
    expect(reportMacro).toContain('Granularity Mode: MACRO');
    expect(reportMacro).toContain('Colosseum Outer Arcade Facade');
    expect(reportMacro).toContain('Arch of Constantine');

    const sceneDetailed = Colosseum3DMeshSeparatorService.separate3DMesh(modelPath, { mode: 'detailed' });
    const reportDetailed = Colosseum3DMeshSeparatorService.generateReport(sceneDetailed);

    expect(reportDetailed).toContain('Granularity Mode: DETAILED');
    expect(reportDetailed).toContain('Colosseum North Outer Arcade Facade');
    expect(reportDetailed).toContain('Arch of Constantine: Attic Inscription Block');
    expect(reportDetailed).not.toContain('Stone Pine');
    expect(reportDetailed).toContain('Colosseo Metro Station Entrance Pavilion');
  });

  it('separates 410 Total Identifiable Objects across 4 tiers of arcade arches, hoists, monuments and ruins, with no generated tree list', () => {
    const scene = Colosseum3DMeshSeparatorService.separate3DMesh(modelPath, { mode: 'total' });

    // the 1,260 "identified" trees came from a seeded random generator, not the mesh, and were removed
    expect(scene.objects.length).toBe(410);
    expect(scene.granularityMode).toBe('total');

    // 1. Check Colosseum Arcade Arches across 4 tiers (320 items: 80 per tier)
    const tier1Arches = scene.objects.filter(o => o.id.startsWith('tot-arch-t1-'));
    expect(tier1Arches.length).toBe(80);
    const tier2Arches = scene.objects.filter(o => o.id.startsWith('tot-arch-t2-'));
    expect(tier2Arches.length).toBe(80);
    const tier3Arches = scene.objects.filter(o => o.id.startsWith('tot-arch-t3-'));
    expect(tier3Arches.length).toBe(80);
    const tier4Arches = scene.objects.filter(o => o.id.startsWith('tot-arch-t4-'));
    expect(tier4Arches.length).toBe(80);

    // 2. Check Hypogeum Hoist Mechanisms (28 items)
    const hoists = scene.objects.filter(o => o.id.startsWith('tot-hypogeum-hoist-'));
    expect(hoists.length).toBe(28);

    // 3. No generated trees
    expect(scene.objects.filter(o => o.id.startsWith('fol-tree-'))).toHaveLength(0);
    expect(() => Colosseum3DMeshSeparatorService.separate3DMesh(modelPath, { mode: 'trees' as any })).toThrow("mode 'trees' has been removed");

    // 4. Check Palazzi & Buildings (20 items)
    const salviPalazzi = scene.objects.filter(o => o.id.startsWith('tot-palazzo-salvi-'));
    expect(salviPalazzi.length).toBe(10);
    const foriPalazzi = scene.objects.filter(o => o.id.startsWith('tot-palazzo-fori-'));
    expect(foriPalazzi.length).toBe(10);

    // 5. Check Street Furniture (18 items: 8 lanterns + 4 cippi + 2 metro + 4 tram)
    const lanterns = scene.objects.filter(o => o.id.startsWith('tot-street-lantern-'));
    expect(lanterns.length).toBe(8);

    // 6. Verify all 410 entities have valid OBB geometry and Trellis prompts
    for (const obj of scene.objects) {
      expect(obj.orientedBoundingBox.dimensions[0]).toBeGreaterThan(0);
      expect(obj.orientedBoundingBox.dimensions[1]).toBeGreaterThan(0);
      expect(obj.orientedBoundingBox.dimensions[2]).toBeGreaterThan(0);
      expect(obj.orientedBoundingBox.volumeM3).toBeGreaterThan(0);
      expect(obj.trellisPrompt.length).toBeGreaterThan(15);
    }

    // 7. Verify Arch of Constantine individual components have tight OBBs (< 25m), NOT swallowing submesh 60 (178m)
    const centralFornix = scene.objects.find(o => o.id === 'tot-arch-const-central-fornix');
    expect(centralFornix).toBeDefined();
    expect(centralFornix!.orientedBoundingBox.dimensions[0]).toBeLessThan(25);

    fs.writeFileSync(path.join(outDir, 'total_entities.json'), JSON.stringify(scene.objects, null, 2), 'utf8');
  });
});


/** GLB with `meshCount` meshes, each one indexed quad (4 vertices, 2 triangles) at its own spot. */
function quadMeshesGlb(meshCount: number): Buffer {
  const pos: number[] = [], idx: number[] = [];
  const meshes: any[] = [], accessors: any[] = [], views: any[] = [];
  for (let m = 0; m < meshCount; m++) {
    const x = m * 3;
    const p = [x, 0, 0, x + 1, 0, 0, x + 1, 1, 0, x, 1, 0];
    views.push({ buffer: 0, byteOffset: pos.length * 4, byteLength: 48 });
    accessors.push({ bufferView: views.length - 1, componentType: 5126, count: 4, type: 'VEC3', min: [x, 0, 0], max: [x + 1, 1, 0] });
    pos.push(...p);
    meshes.push({ primitives: [{ attributes: { POSITION: accessors.length - 1 }, indices: -1, mode: 4 }] });
  }
  const posBytes = Buffer.from(new Float32Array(pos).buffer);
  for (let m = 0; m < meshCount; m++) {
    views.push({ buffer: 0, byteOffset: posBytes.length + idx.length * 4, byteLength: 24 });
    accessors.push({ bufferView: views.length - 1, componentType: 5125, count: 6, type: 'SCALAR' });
    meshes[m].primitives[0].indices = accessors.length - 1;
    idx.push(0, 1, 2, 0, 2, 3);
  }
  const bin = Buffer.concat([posBytes, Buffer.from(new Uint32Array(idx).buffer)]);
  const json = { asset: { version: '2.0' }, meshes, accessors, bufferViews: views, buffers: [{ byteLength: bin.length }] };
  let js = Buffer.from(JSON.stringify(json)); while (js.length % 4) js = Buffer.concat([js, Buffer.from(' ')]);
  const h = Buffer.alloc(12); h.writeUInt32LE(0x46546c67, 0); h.writeUInt32LE(2, 4); h.writeUInt32LE(12 + 8 + js.length + 8 + bin.length, 8);
  const jc = Buffer.alloc(8); jc.writeUInt32LE(js.length, 0); jc.writeUInt32LE(0x4e4f534a, 4);
  const bc = Buffer.alloc(8); bc.writeUInt32LE(bin.length, 0); bc.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([h, jc, js, bc, bin]);
}

describe('Colosseum3DMeshSeparatorService counts', () => {
  it('reports the triangles and vertices the mesh has, not a vertex multiple', () => {
    const scene = Colosseum3DMeshSeparatorService.separate3DMesh(quadMeshesGlb(61), { mode: 'macro' });
    const facade = scene.objects.find(o => o.id === 'det-colosseum-facade')!;
    // 13 clustered submeshes, each one quad
    expect(facade.submeshIndices).toHaveLength(13);
    expect(facade.vertexCount).toBe(13 * 4);
    expect(facade.triangleCount).toBe(13 * 2);
    for (const o of scene.objects) expect(o.triangleCount).toBeLessThanOrEqual(o.submeshIndices.length * 2);
  });
});
