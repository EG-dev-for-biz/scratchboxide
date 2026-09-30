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
    expect(hull.type).toBe('box');
    expect(hull.dimensions[0]).toBeCloseTo(4.0, 1);
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
});
