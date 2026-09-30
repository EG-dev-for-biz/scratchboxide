/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Universal3DStructureFoundation } from '../src/node/spatial/Universal3DStructureFoundation';
import { ContinuousBiophysicalFields } from '../src/common/adaptive-material-types';

describe('Universal3DStructureFoundation', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'u3d-struct-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('synthesizes procedural canonical 3D structure and computes bounding volume', () => {
    const struct = Universal3DStructureFoundation.createFromProcedural('box', {
      scale: 2.0,
      center: [0, 2.0, 0],
      numViews: 12,
      pointDensity: 500
    });

    expect(struct.name).toBe('Procedural_BOX');
    expect(struct.points.length).toBeGreaterThan(100);
    expect(struct.cameras.length).toBe(12);
    expect(struct.mesh.vertexCount).toBe(8);
    expect(struct.mesh.triangleCount).toBe(12);

    const bbox = struct.boundingBox;
    expect(bbox.min[0]).toBeCloseTo(-2.0, 1);
    expect(bbox.max[0]).toBeCloseTo(2.0, 1);
    expect(bbox.center[1]).toBeCloseTo(2.0, 1);
    expect(bbox.boundingSphereRadius).toBeGreaterThan(0);

    const hull = struct.collisionHull;
    expect(hull.type).toBe('obb');
    expect(hull.dimensions[0]).toBeCloseTo(4.0, 1);
    expect(hull.convexVertices?.length).toBe(8);
    expect(hull.indices?.length).toBe(36);
  });

  it('projects canonical structure into COLMAP format', () => {
    const struct = Universal3DStructureFoundation.createFromProcedural('sphere', {
      scale: 1.5,
      numViews: 8,
      pointDensity: 200
    });

    const colmap = struct.toColmap();
    expect(colmap.camerasText).toContain('1 PINHOLE');
    expect(colmap.imagesText).toContain('view_000.png');
    expect(colmap.points3DText).toContain('# 3D point list with one line of data per point:');
    expect(colmap.points3DText.split('\n').length).toBeGreaterThan(50);
  });

  it('projects canonical structure into Nerfstudio format (transforms.json + sparse_pcd.ply)', () => {
    const struct = Universal3DStructureFoundation.createFromProcedural('cylinder', {
      scale: 1.0,
      numViews: 10,
      pointDensity: 300
    });

    const nerf = struct.toNerfstudio();
    const parsed = JSON.parse(nerf.transformsJson);
    expect(parsed.fl_x).toBeGreaterThan(0);
    expect(parsed.frames.length).toBe(10);
    expect(parsed.frames[0].transform_matrix.length).toBe(4);

    expect(nerf.sparsePcdPly).toContain('ply');
    expect(nerf.sparsePcdPly).toContain('format ascii 1.0');
    expect(nerf.sparsePcdPly).toContain('element vertex');
  });

  it('projects canonical structure into Video Diffusion Camera Blockout (<VIDEO_REF_0>)', () => {
    const struct = Universal3DStructureFoundation.createFromProcedural('box', {
      scale: 1.0,
      numViews: 24
    });

    const blockout = struct.toVideoCameraBlockout(24);
    expect(blockout.videoRef).toBe('<VIDEO_REF_0>');
    expect(blockout.fps).toBe(24);
    expect(blockout.frameCount).toBe(24);
    expect(blockout.durationSeconds).toBeCloseTo(23 / 24, 2);
    expect(blockout.frames.length).toBe(24);
    expect(blockout.frames[0].c2wMatrix.length).toBe(16);
  });

  it('projects canonical structure into RFC 7946 GeoJSON anchored to WGS-84 coordinates', () => {
    const anchor = {
      lat: 41.8902,
      lng: 12.4922,
      elevationMeters: 50.0
    };

    const struct = Universal3DStructureFoundation.createFromProcedural('box', {
      scale: 1.0,
      numViews: 6,
      anchor
    });

    const geoJson = struct.toGeoJson();
    expect(geoJson.type).toBe('FeatureCollection');
    expect(geoJson.features.length).toBe(7); // 1 origin + 6 camera stations

    const origin = geoJson.features[0];
    expect(origin.properties.type).toBe('structure_origin');
    expect(origin.geometry.coordinates[0]).toBeCloseTo(12.4922, 4);
    expect(origin.geometry.coordinates[1]).toBeCloseTo(41.8902, 4);

    const cam1 = geoJson.features[1];
    expect(cam1.properties.type).toBe('camera_station');
    expect(cam1.geometry.coordinates.length).toBe(3);
  });

  it('projects canonical structure into valid standard binary glTF 2.0 (.glb)', () => {
    const struct = Universal3DStructureFoundation.createFromProcedural('box', {
      scale: 1.0
    });

    const glb = struct.toGlbBuffer();
    expect(glb.length).toBeGreaterThan(100);

    // Verify 12-byte glTF 2.0 header
    const magic = glb.readUInt32LE(0);
    const version = glb.readUInt32LE(4);
    const totalLength = glb.readUInt32LE(8);

    expect(magic).toBe(0x46546C67); // 'glTF'
    expect(version).toBe(2);
    expect(totalLength).toBe(glb.length);

    // Verify JSON chunk
    const jsonLength = glb.readUInt32LE(12);
    const jsonChunkType = glb.readUInt32LE(16);
    expect(jsonChunkType).toBe(0x4E4F534A); // 'JSON'

    const jsonText = glb.toString('utf8', 20, 20 + jsonLength).trim();
    const parsedGltf = JSON.parse(jsonText);
    expect(parsedGltf.asset.version).toBe('2.0');
    expect(parsedGltf.meshes[0].primitives[0].mode).toBe(4); // TRIANGLES
  });

  it('exports all multi-format representations to disk concurrently', async () => {
    const struct = Universal3DStructureFoundation.createFromProcedural('box', {
      name: 'TestBuildingMassing',
      scale: 3.0,
      numViews: 12,
      anchor: { lat: 40.7484, lng: -73.9857, elevationMeters: 10.0 }
    });

    const outDir = path.join(tempDir, 'export_run');
    const result = await struct.exportToDisk(outDir, [
      'glb',
      'colmap',
      'nerfstudio',
      'video_blockout',
      'geojson'
    ]);

    expect(fs.existsSync(result.filesWritten!.glb)).toBe(true);
    expect(fs.existsSync(result.filesWritten!.colmapCameras)).toBe(true);
    expect(fs.existsSync(result.filesWritten!.colmapImages)).toBe(true);
    expect(fs.existsSync(result.filesWritten!.colmapPoints)).toBe(true);
    expect(fs.existsSync(result.filesWritten!.nerfTransforms)).toBe(true);
    expect(fs.existsSync(result.filesWritten!.nerfPcd)).toBe(true);
    expect(fs.existsSync(result.filesWritten!.videoBlockout)).toBe(true);
    expect(fs.existsSync(result.filesWritten!.geoJson)).toBe(true);

    const savedTransforms = JSON.parse(fs.readFileSync(result.filesWritten!.nerfTransforms, 'utf8'));
    expect(savedTransforms.frames.length).toBe(12);

    const savedBlockout = JSON.parse(fs.readFileSync(result.filesWritten!.videoBlockout, 'utf8'));
    expect(savedBlockout.videoRef).toBe('<VIDEO_REF_0>');
    expect(savedBlockout.frames.length).toBe(12);
  });

  it('computes tight Oriented Bounding Box (OBB) via PCA on rotated 3D geometry', () => {
    // Construct a long thin bar (10m x 2m x 2m) rotated by 45 degrees in XZ
    const angle = Math.PI / 4;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const rawBox = Universal3DStructureFoundation.createFromProcedural('box', {
      scale: 1.0
    });
    // Scale box to [10, 2, 2] and rotate 45 deg around Y
    const origVerts = rawBox.mesh.vertices;
    const rotatedVerts = new Float32Array(origVerts.length);
    for (let i = 0; i < origVerts.length; i += 3) {
      const x = origVerts[i] * 5.0; // half length 5
      const y = origVerts[i + 1] * 1.0;
      const z = origVerts[i + 2] * 1.0;
      rotatedVerts[i] = cos * x - sin * z;
      rotatedVerts[i + 1] = y;
      rotatedVerts[i + 2] = sin * x + cos * z;
    }

    const rotatedStruct = new Universal3DStructureFoundation({
      name: 'RotatedDiagonalBuilding',
      mesh: {
        vertices: rotatedVerts,
        indices: rawBox.mesh.indices,
        vertexCount: rawBox.mesh.vertexCount,
        triangleCount: rawBox.mesh.triangleCount
      }
    });

    const obb = rotatedStruct.computeCollisionEnvelope({ mode: 'obb' });
    const aabb = rotatedStruct.computeCollisionEnvelope({ mode: 'aabb' });

    expect(obb.type).toBe('obb');
    expect(aabb.type).toBe('box');

    // OBB should capture the true dimensions ~[10, 2, 2]
    const sortedDims = [...obb.dimensions].sort((a, b) => b - a);
    expect(sortedDims[0]).toBeCloseTo(10.0, 1);
    expect(sortedDims[1]).toBeCloseTo(2.0, 1);
    expect(sortedDims[2]).toBeCloseTo(2.0, 1);

    // OBB volume should be substantially smaller than AABB volume (no diagonal wasted space)
    const obbVol = obb.dimensions[0] * obb.dimensions[1] * obb.dimensions[2];
    const aabbVol = aabb.dimensions[0] * aabb.dimensions[1] * aabb.dimensions[2];
    expect(obbVol).toBeLessThan(aabbVol * 0.7); // At least 30% tighter!
  });

  it('computes Inflated Bumper with safety margin for camera flight and drone clearance', () => {
    const struct = Universal3DStructureFoundation.createFromProcedural('box', {
      scale: 2.0
    });

    const bumper = struct.computeCollisionEnvelope({
      mode: 'inflated_bumper',
      safetyMarginMeters: 2.5
    });

    expect(bumper.type).toBe('inflated_bumper');
    expect(bumper.safetyMarginMeters).toBe(2.5);
    // Base box scale 2.0 has dimensions [4, 4, 4]. Inflated with 2.5m bumper adds 5.0m to each dimension -> [9, 9, 9]
    expect(bumper.dimensions[0]).toBeCloseTo(9.0, 1);
    expect(bumper.dimensions[1]).toBeCloseTo(9.0, 1);
    expect(bumper.dimensions[2]).toBeCloseTo(9.0, 1);
  });

  it('exports collision hull as both JSON and Wavefront OBJ (.obj) to disk', async () => {
    const struct = Universal3DStructureFoundation.createFromProcedural('box', {
      name: 'CollisionExportTest',
      scale: 1.5
    });

    const outDir = path.join(tempDir, 'collision_export_run');
    const result = await struct.exportToDisk(outDir, ['collision_hull'], {
      collisionOptions: { mode: 'inflated_bumper', safetyMarginMeters: 1.0 }
    });

    expect(result.filesWritten!.collisionHullJson).toBeDefined();
    expect(result.filesWritten!.collisionHullObj).toBeDefined();
    expect(fs.existsSync(result.filesWritten!.collisionHullJson)).toBe(true);
    expect(fs.existsSync(result.filesWritten!.collisionHullObj)).toBe(true);

    const jsonContent = JSON.parse(fs.readFileSync(result.filesWritten!.collisionHullJson, 'utf8'));
    expect(jsonContent.type).toBe('inflated_bumper');
    expect(jsonContent.safetyMarginMeters).toBe(1.0);
    expect(jsonContent.convexVertices.length).toBe(8);

    const objContent = fs.readFileSync(result.filesWritten!.collisionHullObj, 'utf8');
    expect(objContent).toContain('# Scratchbox IDE Collision Hull: inflated_bumper');
    expect(objContent).toContain('v ');
    expect(objContent).toContain('f ');
    // 8 vertices and 12 triangular faces
    const vCount = objContent.split('\n').filter(l => l.startsWith('v ')).length;
    const fCount = objContent.split('\n').filter(l => l.startsWith('f ')).length;
    expect(vCount).toBe(8);
    expect(fCount).toBe(12);
  });

  it('creates procedural structure with PBR material preset and procedural textures', () => {
    const struct = Universal3DStructureFoundation.createFromProcedural('box', {
      materialPreset: 'titanium',
      synthesizePbrTextures: true,
      textureArchetype: 'brushed_metal',
      pointDensity: 200
    });

    expect(struct.materials.length).toBe(1);
    const mat = struct.primaryMaterial;
    expect(mat.name).toContain('titanium');
    expect(mat.metallicFactor).toBeCloseTo(0.9, 1);
    expect(mat.roughnessFactor).toBeCloseTo(0.22, 1);

    expect(struct.textures.length).toBeGreaterThanOrEqual(3);
    const albedoTex = struct.textures.find(t => t.type === 'albedo');
    const normalTex = struct.textures.find(t => t.type === 'normal');
    const ormTex = struct.textures.find(t => t.type === 'metallicRoughness');

    expect(albedoTex).toBeDefined();
    expect(normalTex).toBeDefined();
    expect(ormTex).toBeDefined();

    expect(albedoTex!.width).toBe(256);
    expect(albedoTex!.height).toBe(256);
  });

  it('samples bilinear albedo and ORM from texture maps at UV coordinates', () => {
    const struct = Universal3DStructureFoundation.createFromProcedural('sphere', {
      materialPreset: 'gold',
      synthesizePbrTextures: true,
      textureArchetype: 'brushed_metal'
    });

    const albedoCenter = struct.sampleAlbedoAtUv(0.5, 0.5);
    expect(albedoCenter.length).toBe(3);
    // Gold is yellowish: R > 150, G > 100
    expect(albedoCenter[0]).toBeGreaterThan(150);
    expect(albedoCenter[1]).toBeGreaterThan(100);

    const ormCenter = struct.sampleOrmAtUv(0.5, 0.5);
    // ORM: occlusion, roughness, metallic. Gold is highly metallic: metallic > 0.8
    expect(ormCenter.metallic).toBeGreaterThan(0.8);
    expect(ormCenter.roughness).toBeGreaterThan(0);
  });

  it('resynchronizes point constellation with sampled texture colors and PBR properties', () => {
    const struct = Universal3DStructureFoundation.createFromProcedural('cylinder', {
      materialPreset: 'gold',
      synthesizePbrTextures: true,
      textureArchetype: 'brushed_metal',
      pointDensity: 300
    });

    expect(struct.points.length).toBeGreaterThan(150);
    const pt = struct.points[0];
    expect(pt.color).toBeDefined();
    expect(pt.color[0]).toBeGreaterThan(150); // Gold red component
    expect(pt.roughness).toBeDefined();
    expect(pt.metallic).toBeDefined();
    expect(pt.metallic).toBeGreaterThan(0.8); // Metallic > 0.8
    expect(pt.uv).toBeDefined();
    expect(pt.uv![0]).toBeGreaterThanOrEqual(0);
    expect(pt.uv![0]).toBeLessThanOrEqual(1);
  });

  it('projects into binary glTF 2.0 (.glb) with embedded PBR materials and textures', () => {
    const struct = Universal3DStructureFoundation.createFromProcedural('box', {
      materialPreset: 'titanium',
      synthesizePbrTextures: true,
      textureArchetype: 'brushed_metal'
    });

    const glb = struct.toGlbBuffer();
    expect(glb.length).toBeGreaterThan(1000);

    // Verify 12-byte header
    expect(glb.readUInt32LE(0)).toBe(0x46546C67);
    expect(glb.readUInt32LE(4)).toBe(2);

    const jsonLength = glb.readUInt32LE(12);
    const jsonText = glb.toString('utf8', 20, 20 + jsonLength).trim();
    const gltf = JSON.parse(jsonText);

    expect(gltf.materials).toBeDefined();
    expect(gltf.materials.length).toBe(1);
    expect(gltf.materials[0].pbrMetallicRoughness.baseColorTexture).toBeDefined();
    expect(gltf.materials[0].pbrMetallicRoughness.metallicRoughnessTexture).toBeDefined();
    expect(gltf.textures.length).toBeGreaterThanOrEqual(3);
    expect(gltf.images.length).toBeGreaterThanOrEqual(3);
    expect(gltf.images[0].bufferView).toBeDefined();
  });

  it('ingests binary glTF 2.0 (.glb) via createFromGlb with extracted materials and textures', () => {
    const originalStruct = Universal3DStructureFoundation.createFromProcedural('sphere', {
      materialPreset: 'gold',
      synthesizePbrTextures: true,
      textureArchetype: 'brushed_metal',
      pointDensity: 200
    });

    const glbBuffer = originalStruct.toGlbBuffer();
    const ingested = Universal3DStructureFoundation.createFromGlb(glbBuffer, {
      name: 'ReconstructedGoldSphere'
    });

    expect(ingested.name).toBe('ReconstructedGoldSphere');
    expect(ingested.mesh.vertexCount).toBe(originalStruct.mesh.vertexCount);
    expect(ingested.mesh.triangleCount).toBe(originalStruct.mesh.triangleCount);
    expect(ingested.mesh.normals).toBeDefined();
    expect(ingested.mesh.uvs).toBeDefined();
    expect(ingested.materials.length).toBe(1);
    expect(ingested.textures.length).toBe(originalStruct.textures.length);

    // Point constellation resynchronization verification
    expect(ingested.points.length).toBeGreaterThan(100);
    expect(ingested.points[0].color).toBeDefined();
  });

  it('ingests continuous biophysical fields via createFromBiophysicalFields', () => {
    const box = Universal3DStructureFoundation.createFromProcedural('box', { scale: 1.0 });
    const width = 64;
    const height = 64;

    const albedoRgba = new Uint8Array(width * height * 4);
    const normalRgb = new Uint8Array(width * height * 3);
    const ormRgb = new Uint8Array(width * height * 3);

    for (let i = 0; i < width * height; i++) {
      albedoRgba[i * 4] = 220;     // R
      albedoRgba[i * 4 + 1] = 180; // G
      albedoRgba[i * 4 + 2] = 140; // B
      albedoRgba[i * 4 + 3] = 255; // A

      normalRgb[i * 3] = 128;     // Nx = 0
      normalRgb[i * 3 + 1] = 128; // Ny = 0
      normalRgb[i * 3 + 2] = 255; // Nz = 1

      ormRgb[i * 3] = 255;        // AO
      ormRgb[i * 3 + 1] = 75;     // Roughness (0.3)
      ormRgb[i * 3 + 2] = 230;    // Metallic (0.9)
    }

    const fields: ContinuousBiophysicalFields = {
      width,
      height,
      albedoRgba,
      normalRgb,
      roughness: new Float32Array(width * height).fill(0.3),
      metallic: new Float32Array(width * height).fill(0.9),
      ambientOcclusion: new Float32Array(width * height).fill(1.0),
      ormRgb
    };

    const biophysStruct = Universal3DStructureFoundation.createFromBiophysicalFields(box.mesh, fields, {
      name: 'BiophysBoxTest'
    });

    expect(biophysStruct.name).toBe('BiophysBoxTest');
    expect(biophysStruct.textures.length).toBe(3);
    expect(biophysStruct.materials.length).toBe(1);
    expect(biophysStruct.primaryMaterial.baseColorTextureId).toBeDefined();

    // Verify sampled albedo at UV
    const sampledAlbedo = biophysStruct.sampleAlbedoAtUv(0.5, 0.5);
    expect(sampledAlbedo[0]).toBeCloseTo(220, 1);
    expect(sampledAlbedo[1]).toBeCloseTo(180, 1);
  });

  it('exports textures to disk in exportToDisk alongside other multi-format assets', async () => {
    const struct = Universal3DStructureFoundation.createFromProcedural('box', {
      name: 'PbrDiskExportTest',
      materialPreset: 'titanium',
      synthesizePbrTextures: true,
      textureArchetype: 'brushed_metal'
    });

    const outDir = path.join(tempDir, 'pbr_export_run');
    const result = await struct.exportToDisk(outDir, ['glb', 'colmap', 'nerfstudio']);

    expect(result.textureFiles).toBeDefined();
    expect(Object.keys(result.textureFiles!).length).toBeGreaterThanOrEqual(3);

    for (const [texId, filePath] of Object.entries(result.textureFiles!)) {
      expect(fs.existsSync(filePath)).toBe(true);
      expect(filePath).toContain(path.join(outDir, 'textures'));
    }
  });

  it('generates project manifest markdown and exports scene_manifest.md to project folder', async () => {
    const struct = Universal3DStructureFoundation.createBabylonianZigguratComplex({
      name: 'BabylonZigguratProjectTest'
    });

    const markdown = struct.generateManifestMarkdown();
    expect(markdown).toContain('# 3D Scene Project Manifest: BabylonZigguratProjectTest');
    expect(markdown).toContain('Ziggurat of Etemenanki');
    expect(markdown).toContain('32.536300°N');
    expect(markdown).toContain('BabylonianMudbrick');
    expect(markdown).toContain('GlazedLapisLazuli');
    expect(markdown).toContain('BeatenGoldLeaf');
    expect(markdown).toContain('projects/BabylonZigguratProjectTest/');

    const outDir = path.join(tempDir, 'projects', 'BabylonZigguratProjectTest');
    const result = await struct.exportToDisk(outDir, ['glb', 'manifest', 'video_blockout']);

    expect(result.manifestMarkdown).toBeDefined();
    expect(fs.existsSync(path.join(outDir, 'BabylonZigguratProjectTest_manifest.md'))).toBe(true);
    expect(fs.existsSync(path.join(outDir, 'scene_manifest.md'))).toBe(true);
    expect(fs.existsSync(path.join(outDir, 'BabylonZigguratProjectTest.glb'))).toBe(true);
    expect(fs.existsSync(path.join(outDir, 'BabylonZigguratProjectTest_video_blockout.json'))).toBe(true);
  });

  it('synthesizes complex Alpine Matterhorn Mountain Valley structure with continuous terrain and chalets', async () => {
    const alpine = Universal3DStructureFoundation.createAlpineMatterhornComplex({
      name: 'AlpineMatterhornValleyTest'
    });

    expect(alpine.name).toBe('AlpineMatterhornValleyTest');
    expect(alpine.mesh.vertexCount).toBeGreaterThan(5000);
    expect(alpine.mesh.triangleCount).toBeGreaterThan(5000);
    expect(alpine.materials.length).toBeGreaterThanOrEqual(5);
    expect(alpine.materials.some(m => m.name === 'MatterhornGneiss')).toBe(true);
    expect(alpine.materials.some(m => m.name === 'AgedLarchTimber')).toBe(true);
    expect(alpine.materials.some(m => m.name === 'GlacialRiver')).toBe(true);
    expect(alpine.anchor?.formattedAddress).toContain('Matterhorn Alpine Valley');
    expect(alpine.cameras.length).toBeGreaterThanOrEqual(24);
    expect(alpine.points.length).toBeGreaterThanOrEqual(5000);

    const outDir = path.join(tempDir, 'projects', 'AlpineMatterhornValleyTest');
    const result = await alpine.exportToDisk(outDir, ['glb', 'manifest', 'colmap', 'nerfstudio']);

    expect(fs.existsSync(path.join(outDir, 'AlpineMatterhornValleyTest.glb'))).toBe(true);
    expect(fs.existsSync(path.join(outDir, 'AlpineMatterhornValleyTest_manifest.md'))).toBe(true);
    expect(fs.existsSync(path.join(outDir, 'scene_manifest.md'))).toBe(true);
    expect(fs.existsSync(path.join(outDir, 'transforms.json'))).toBe(true);
    expect(fs.existsSync(path.join(outDir, 'sparse_pcd.ply'))).toBe(true);
  });
});

