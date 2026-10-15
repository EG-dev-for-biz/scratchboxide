/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { test } from 'vitest';
import * as assert from 'assert';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs-extra';
import {
  Google3DTileBlockoutPipelineService,
  GeoAnchor,
  DEFAULT_GOOGLE_MAPS_TILES_API_KEY,
  geocode3DTilesAddress,
  create3DTilesTrajectory,
  create3DTilesOrbitTrajectory,
  create3DTilesPushInTrajectory,
  runGoogle3DTilesPipeline,
  getGoogle3DTilesFullTexture,
  getGoogle3DTilesClay,
  runTileClayBlockoutRunner
} from '../src/node/spatial/Google3DTileBlockoutPipelineService';
import {
  buildBlockoutOmniPipelinePlan
} from '../src/browser/generative-canvas/services/video/omniVideoPromptService';
import { MediaAssetRef } from '../src/common/media-generation-protocol';
import { REPO_ROOT, requireAsset, withReason } from './helpers/requirements';
import { LocationUnresolvedError } from '../src/common/errors/pipeline-errors';

// Gitignored 72-frame / 24 fps ESB flight path that the trajectory, runner, pipeline and clearance-audit
// checks (Tests 2, 3, 4, 6, 7) are written against.
const CAMERA_PATH_FILE = path.join(REPO_ROOT, 'public/models/google_tiles_camera_path.json');
const cameraPathAsset = requireAsset('public/models/google_tiles_camera_path.json');

async function runBlockoutPipelineTests() {
  console.log('🏛️ Running Google 3D Tile Blockout Video Pipeline Test Suite...\n');

  const service = new Google3DTileBlockoutPipelineService();

  // =========================================================================
  // Test 1: Geodetic WGS-84 to Local ENU Matrix Transformation
  // =========================================================================
  console.log('Testing 1: Geodetic WGS-84 to Local ENU Matrix Transformation...');
  {
    const esbOrigin: GeoAnchor = {
      lat: 40.7484405,
      lng: -73.9856644,
      elevation: 15.0,
      landmarkName: 'Empire State Building Midtown Manhattan'
    };

    const { matrixValues, matrix4x4 } = service.buildLocalTransformMatrix(esbOrigin, -30.0);

    assert.strictEqual(matrixValues.length, 16, 'Matrix must contain 16 numbers');
    assert.strictEqual(matrix4x4.length, 4, 'Matrix4x4 must have 4 rows');
    assert.strictEqual(matrix4x4[3][3], 1, 'Affine component [3][3] must equal 1');
    assert.strictEqual(matrix4x4[3][0], 0, 'Affine component [3][0] must equal 0');
    assert.strictEqual(matrix4x4[3][1], 0, 'Affine component [3][1] must equal 0');
    assert.strictEqual(matrix4x4[3][2], 0, 'Affine component [3][2] must equal 0');

    // Test row vector lengths (orthonormal rotation sub-matrix)
    const lenX = Math.hypot(matrix4x4[0][0], matrix4x4[0][1], matrix4x4[0][2]);
    const lenY = Math.hypot(matrix4x4[1][0], matrix4x4[1][1], matrix4x4[1][2]);
    const lenZ = Math.hypot(matrix4x4[2][0], matrix4x4[2][1], matrix4x4[2][2]);

    assert.ok(Math.abs(lenX - 1.0) < 1e-4, 'X axis must be unit length');
    assert.ok(Math.abs(lenY - 1.0) < 1e-4, 'Y axis must be unit length');
    assert.ok(Math.abs(lenZ - 1.0) < 1e-4, 'Z axis must be unit length');

    // Test orthogonality (dot products between axes must be ~0)
    const dotXY = matrix4x4[0][0] * matrix4x4[1][0] + matrix4x4[0][1] * matrix4x4[1][1] + matrix4x4[0][2] * matrix4x4[1][2];
    const dotYZ = matrix4x4[1][0] * matrix4x4[2][0] + matrix4x4[1][1] * matrix4x4[2][1] + matrix4x4[1][2] * matrix4x4[2][2];
    const dotZX = matrix4x4[2][0] * matrix4x4[0][0] + matrix4x4[2][1] * matrix4x4[0][1] + matrix4x4[2][2] * matrix4x4[0][2];

    assert.ok(Math.abs(dotXY) < 1e-4, 'X and Y axes must be orthogonal');
    assert.ok(Math.abs(dotYZ) < 1e-4, 'Y and Z axes must be orthogonal');
    assert.ok(Math.abs(dotZX) < 1e-4, 'Z and X axes must be orthogonal');

    console.log('  ✓ Test 1 Passed: Orthonormal WGS-84 tangent plane matrix validated');
  }

  // =========================================================================
  // Test 5: Integration with 3-Stage Dual-Conditioned Omni Pipeline Plan
  // =========================================================================
  console.log('Testing 5: Integration with 3-Stage Dual-Conditioned Omni Pipeline Plan...');
  {
    const blockoutVideoAsset: MediaAssetRef = {
      id: 'asset-blockout-vid-001',
      uri: 'file:///workspace/public/videos/google_tiles_clay_blockout_camera.mp4',
      mimeType: 'video/mp4',
      kind: 'video',
      contentHash: 'hash-blockout-vid-001',
      byteLength: 20480,
      relativePath: '.scratchbox/media/google_tiles_clay_blockout_camera.mp4',
      createdAt: Date.now()
    };

    const blockoutFrame1Asset: MediaAssetRef = {
      id: 'asset-blockout-frame1-001',
      uri: 'file:///workspace/public/models/blockout_first_frame.jpg',
      mimeType: 'image/jpeg',
      kind: 'image',
      contentHash: 'hash-blockout-frame1-001',
      byteLength: 4096,
      relativePath: '.scratchbox/media/blockout_first_frame.jpg',
      createdAt: Date.now()
    };

    const omniPlan = buildBlockoutOmniPipelinePlan({
      locationName: 'Midtown Manhattan Empire State Building along 5th Avenue',
      coordinates: { lat: 40.7484405, lng: -73.9856644 },
      heading: 0,
      workspaceRoot: '/tmp/workspace',
      idempotencyKey: 'test-blockout-omni-001',
      blockoutVideoAsset,
      blockoutFrame1Asset,
      stylePreset: 'photoreal-urban'
    });

    assert.strictEqual(omniPlan.videoRef, '<VIDEO_REF_0>');
    assert.strictEqual(omniPlan.imageRef, '<IMAGE_REF_0>');
    assert.strictEqual(omniPlan.stage1BlockoutFrameExtraction.rawFrame1Asset?.uri, blockoutFrame1Asset.uri);
    assert.strictEqual(omniPlan.omniVideoRequest.referenceAssets?.[0]?.uri, blockoutVideoAsset.uri);
    assert.ok(omniPlan.stage2NanoBananaRestyle.prompt.includes('Transform this photorealistic 3D tiles rendering of Midtown Manhattan Empire State Building along 5th Avenue'));
    assert.ok(omniPlan.omniVideoRequest.prompt.includes('Follow the 6-DoF camera trajectory, depth parallax, vanishing points, and geometric boundaries of <VIDEO_REF_0>.'));

    console.log('  ✓ Test 5 Passed: Blockout pipeline output seamlessly binds into 3-Stage Dual Omni pipeline plan');
  }

  // =========================================================================
  // Test 8: Zero-Preset & No-Fallback Geocoding Resolution
  // =========================================================================
  console.log('Testing 8: Zero-Preset & No-Fallback Geocoding Resolution...');
  {
    // A: Text that is entirely a coordinate pair is used as given; no elevation is invented
    const midtownAnchor = await geocode3DTilesAddress('40.748400, -73.985700');
    assert.strictEqual(midtownAnchor.lat, 40.7484, 'Latitude must match Midtown coordinate 40.748400');
    assert.strictEqual(midtownAnchor.lng, -73.9857, 'Longitude must match Midtown coordinate -73.985700');
    assert.strictEqual(midtownAnchor.elevation, undefined, 'No elevation was stated, so none is reported');
    assert.strictEqual(midtownAnchor.formattedAddress, '40.748400, -73.985700');

    // B: Explicit coordinate object keeps its stated elevation
    const tokyoObj = await service.resolveAddress({ lat: 35.6586, lng: 139.7454, elevation: 25.0 });
    assert.strictEqual(tokyoObj.lat, 35.6586, 'Latitude must match');
    assert.strictEqual(tokyoObj.lng, 139.7454, 'Longitude must match');
    assert.strictEqual(tokyoObj.elevation, 25.0, 'Elevation must match');

    // C: Hemisphere notation
    const eiffelAnchor = await service.resolveAddress('48.8584° N, 2.2945° E');
    assert.strictEqual(eiffelAnchor.lat, 48.8584, 'Eiffel Tower lat must match');
    assert.strictEqual(eiffelAnchor.lng, 2.2945, 'Eiffel Tower lng must match');

    // D: Anything else is a place name for Google Places; without a Maps key it throws (no table, no regex)
    const savedKeys = { g: process.env.GOOGLE_MAPS_API_KEY, m: process.env.MAP_TILES_API_KEY };
    delete process.env.GOOGLE_MAPS_API_KEY;
    delete process.env.MAP_TILES_API_KEY;
    try {
      for (const query of ['Unknown Custom NonPreset Plaza', 'Midtown Manhattan, coordinates: 40.748400, -73.985700', 'Pier 39, 2 Beach St, San Francisco']) {
        await assert.rejects(
          service.resolveAddress(query),
          (err: any) => err instanceof LocationUnresolvedError && err.query === query && /no Google Maps API key/.test(err.message),
          `"${query}" must not be resolved without Google Places`
        );
      }
    } finally {
      if (savedKeys.g !== undefined) process.env.GOOGLE_MAPS_API_KEY = savedKeys.g;
      if (savedKeys.m !== undefined) process.env.MAP_TILES_API_KEY = savedKeys.m;
    }
    await assert.rejects(service.resolveAddress('0, 0'), LocationUnresolvedError, '(0, 0) is rejected');
    await assert.rejects(service.resolveAddress({ lat: 0, lng: 0 }), LocationUnresolvedError, '{ lat: 0, lng: 0 } is rejected');
    await assert.rejects(service.resolveAddress('95, 10'), LocationUnresolvedError, 'out-of-range latitude is rejected');

    console.log('  ✓ Test 8 Passed: Zero presets, no procedural fallback, strict coordinate extraction & validation verified');
  }

  // =========================================================================
  // Test 9: Procedural Trajectory Creation & Multi-Waypoint Pre-Warming
  // =========================================================================
  console.log('Testing 9: Procedural Trajectory Creation & Multi-Waypoint Pre-Warming...');
  {
    const anchor: GeoAnchor = {
      lat: 40.748400,
      lng: -73.985700,
      elevation: 15.0,
      landmarkName: 'Midtown Manhattan, coordinates: 40.748400, -73.985700'
    };

    const pathData = create3DTilesTrajectory(anchor, {
      durationSec: 3.0,
      fps: 24,
      corridorRadiusMeters: 380,
      startAltitudeMeters: 290,
      endAltitudeMeters: 175
    });

    assert.strictEqual(pathData.totalFrames, 72, 'Corridor must generate exactly 72 frames (3.0s @ 24fps)');
    assert.strictEqual(pathData.fps, 24, 'FPS must be 24');
    assert.strictEqual(pathData.durationSec, 3.0, 'Duration must be 3.0s');
    assert.strictEqual(pathData.frames.length, 72, 'Frames length must be 72');

    // Verify key pre-warming waypoints exist: [0, 18, 36, 54, 71]
    const prewarmWaypoints = [0, 18, 36, 54, 71];
    for (const wp of prewarmWaypoints) {
      const frame = pathData.frames[wp];
      assert.ok(frame, `Waypoint frame ${wp} must exist`);
      assert.strictEqual(frame.frame, wp);
      assert.strictEqual(frame.position.length, 3);
      assert.strictEqual(frame.target.length, 3);
      assert.strictEqual(frame.up.length, 3);
      assert.ok(frame.fov >= 35 && frame.fov <= 85, 'FOV must be realistic camera FOV');
    }

    // Verify continuous smooth descent from start altitude to end altitude
    const startAlt = pathData.frames[0].position[1];
    const endAlt = pathData.frames[71].position[1];
    assert.ok(startAlt > endAlt, `Camera must smoothly descend (start ${startAlt}m > end ${endAlt}m)`);

    console.log('  ✓ Test 9 Passed: 72-frame flight corridor correctly pre-warms waypoints [0, 18, 36, 54, 71]');
  }

  // =========================================================================
  // Test 10: High-Fidelity Codebase API with Full Texture & Grey Box Modes
  // =========================================================================
  console.log('Testing 10: High-Fidelity Codebase API with Full Texture & Grey Box Modes...');
  {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scratchbox-tile-api-test-'));

    // A: Full Texture mode with Midtown Manhattan address
    const fullTextureVideo = path.join(tmpDir, 'full_texture.mp4');
    const fullTextureGlb = path.join(tmpDir, 'full_texture.glb');
    const fullTextureManifest = path.join(tmpDir, 'full_texture_manifest.json');
    const fullTextureResult = await runGoogle3DTilesPipeline({
      address: '40.748400, -73.985700',
      mode: 'full-texture',
      lodQuality: {
        errorTarget: 0.5,
        virtualSseWidth: 3840,
        virtualSseHeight: 2160
      },
      offlineMock: true,
      output: {
        outputVideoPath: fullTextureVideo,
        outputGlbPath: fullTextureGlb,
        manifestPath: fullTextureManifest
      }
    });

    assert.strictEqual(fullTextureResult.success, true);
    assert.strictEqual(fullTextureResult.geoAnchor.lat, 40.748400);
    assert.strictEqual(fullTextureResult.geoAnchor.lng, -73.985700);
    assert.strictEqual(fullTextureResult.tileMetrics.renderMode, 'textured');
    assert.ok(fullTextureResult.tileMetrics.errorTarget <= 0.5, 'Error target must be <= 0.5');
    assert.strictEqual(fullTextureResult.frameCount, 72, 'Default corridor produces 72 frames');
    assert.ok(fullTextureResult.glbBuffer instanceof Buffer, 'Result must include glbBuffer');
    assert.strictEqual(fullTextureResult.glbBuffer.toString('ascii', 0, 4), 'glTF', 'glbBuffer must start with glTF magic header');
    assert.ok(fs.existsSync(fullTextureGlb), 'Exported .glb mesh file must exist on disk');
    assert.ok(fullTextureResult.mesh.vertexCount > 0, 'Mesh must report vertex count');

    // B: Grey Box mode with explicit coordinates
    const greyBoxVideo = path.join(tmpDir, 'greybox.mp4');
    const greyBoxGlb = path.join(tmpDir, 'greybox.glb');
    const greyBoxManifest = path.join(tmpDir, 'greybox_manifest.json');
    const greyBoxResult = await runGoogle3DTilesPipeline({
      address: '35.6586, 139.7454',
      mode: 'greybox',
      lodQuality: {
        errorTarget: 0.5,
        virtualSseWidth: 3840,
        virtualSseHeight: 2160
      },
      offlineMock: true,
      output: {
        outputVideoPath: greyBoxVideo,
        outputGlbPath: greyBoxGlb,
        manifestPath: greyBoxManifest
      }
    });

    assert.strictEqual(greyBoxResult.success, true);
    assert.strictEqual(greyBoxResult.geoAnchor.lat, 35.6586);
    assert.strictEqual(greyBoxResult.geoAnchor.lng, 139.7454);
    assert.strictEqual(greyBoxResult.tileMetrics.renderMode, 'clay');
    assert.ok(greyBoxResult.tileMetrics.errorTarget <= 0.5, 'Error target must be <= 0.5');
    assert.strictEqual(greyBoxResult.frameCount, 72);
    assert.ok(greyBoxResult.glbBuffer instanceof Buffer);
    assert.strictEqual(greyBoxResult.glbBuffer.toString('ascii', 0, 4), 'glTF');
    assert.ok(fs.existsSync(greyBoxGlb));
    assert.ok(greyBoxResult.mesh.triangleCount > 0);

    await fs.remove(tmpDir);
    console.log('  ✓ Test 10 Passed: High-fidelity API executes full-texture and greybox modes and returns valid 3D GLB objects');
  }

  // =========================================================================
  // Test 11: Dedicated Zero-Preset APIs (getGoogle3DTilesFullTexture & getGoogle3DTilesClay)
  // =========================================================================
  console.log('Testing 11: Dedicated Zero-Preset 3D Object APIs (Full Texture & Clay)...');
  {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scratchbox-tile-dual-api-test-'));

    // A: Dedicated Full Texture API
    const fullTextureGlbPath = path.join(tmpDir, 'textured_area.glb');
    const textureRes = await getGoogle3DTilesFullTexture(
      '40.748400, -73.985700',
      {
        offlineMock: true,
        outputGlbPath: fullTextureGlbPath
      }
    );

    assert.strictEqual(textureRes.success, true);
    assert.strictEqual(textureRes.mode, 'full-texture');
    assert.strictEqual(textureRes.geoAnchor.lat, 40.748400);
    assert.strictEqual(textureRes.geoAnchor.lng, -73.985700);
    assert.ok(textureRes.glbBuffer instanceof Buffer, 'Must return binary glbBuffer');
    assert.strictEqual(textureRes.glbBuffer.toString('ascii', 0, 4), 'glTF', 'glTF magic 0x46546C67 must be present');
    assert.ok(fs.existsSync(textureRes.glbPath), 'GLB file must exist on disk');
    assert.strictEqual(textureRes.glbPath, fullTextureGlbPath);
    assert.ok(textureRes.mesh.vertexCount > 0, 'Vertex count must be > 0');
    assert.ok(textureRes.mesh.triangleCount > 0, 'Triangle count must be > 0');
    assert.strictEqual(textureRes.quality.errorTarget, 0.5);
    // offlineMock is a synthetic placeholder: the result says so and claims no 4K leaf-LOD tiles
    assert.strictEqual(textureRes.mock, true);
    assert.match(textureRes.quality.source || '', /offline mock/);
    assert.strictEqual(textureRes.quality.leafLodSettled, false);
    assert.strictEqual(textureRes.resolvedAddress, '40.748400, -73.985700');
    assert.ok(fs.existsSync(textureRes.render.videoPath), 'Render video must exist');

    // B: Dedicated Clay / Grey Box API
    const clayGlbPath = path.join(tmpDir, 'clay_area.glb');
    const clayRes = await getGoogle3DTilesClay(
      { lat: 48.8584, lng: 2.2945, landmarkName: 'Paris Region' },
      {
        offlineMock: true,
        outputGlbPath: clayGlbPath
      }
    );

    assert.strictEqual(clayRes.success, true);
    assert.strictEqual(clayRes.mode, 'clay');
    assert.strictEqual(clayRes.geoAnchor.lat, 48.8584);
    assert.strictEqual(clayRes.geoAnchor.lng, 2.2945);
    assert.ok(clayRes.glbBuffer instanceof Buffer);
    assert.strictEqual(clayRes.glbBuffer.toString('ascii', 0, 4), 'glTF');
    assert.ok(fs.existsSync(clayRes.glbPath));
    assert.strictEqual(clayRes.glbPath, clayGlbPath);
    assert.ok(clayRes.mesh.vertexCount > 0);
    assert.ok(clayRes.mesh.triangleCount > 0);
    assert.strictEqual(clayRes.quality.errorTarget, 0.5);
    assert.strictEqual(clayRes.mock, true);
    assert.match(clayRes.quality.source || '', /offline mock/);
    assert.ok(fs.existsSync(clayRes.render.videoPath));

    await fs.remove(tmpDir);
    console.log('  ✓ Test 11 Passed: getGoogle3DTilesFullTexture and getGoogle3DTilesClay return verified high-fidelity 3D objects');
  }

  // =========================================================================
  // Test 12: Codified Google Maps 3D Tile Clay Blockout Runner (<VIDEO_REF_0>)
  // =========================================================================
  console.log('Testing 12: Codified Google Maps 3D Tile Clay Blockout Runner (<VIDEO_REF_0>)...');
  {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scratchbox-tile-clay-runner-test-'));

    // A: Test trajectory presets: cinematic_arc, orbit_360, canyon_push
    const anchor: GeoAnchor = { lat: 35.6586, lng: 139.7454, elevation: 25.0, landmarkName: 'Tokyo Tower' };
    const orbitPath = create3DTilesOrbitTrajectory(anchor, { corridorRadiusMeters: 200, fps: 24, durationSec: 3.0 });
    assert.strictEqual(orbitPath.totalFrames, 72);
    assert.strictEqual(orbitPath.frames.length, 72);
    assert.strictEqual(orbitPath.origin.landmarkName, 'Tokyo Tower');

    const pushInPath = create3DTilesPushInTrajectory(anchor, { corridorDistanceMeters: 180, fps: 24, durationSec: 3.0 });
    assert.strictEqual(pushInPath.totalFrames, 72);
    assert.strictEqual(pushInPath.frames.length, 72);
    const startDist = Math.hypot(pushInPath.frames[0].position[0], pushInPath.frames[0].position[2]);
    const endDist = Math.hypot(pushInPath.frames[71].position[0], pushInPath.frames[71].position[2]);
    assert.ok(endDist < startDist, 'Push-in trajectory must end closer to the target than it started');

    // B: Execute runTileClayBlockoutRunner with canyon_push and studio-grey clay
    const outVideo = path.join(tmpDir, 'clay_canyon_blockout.mp4');
    const outGlb = path.join(tmpDir, 'clay_canyon_massing.glb');
    const outPng = path.join(tmpDir, 'clay_canyon_frame_00.png');

    const runnerRes = await runTileClayBlockoutRunner({
      query: anchor,
      trajectoryPreset: 'canyon_push',
      clayPreset: 'studio-grey',
      outputVideoPath: outVideo,
      outputGlbPath: outGlb,
      firstFramePngPath: outPng,
      offlineMock: true
    });

    assert.strictEqual(runnerRes.success, true);
    assert.strictEqual(runnerRes.videoRef, '<VIDEO_REF_0>', 'videoRef must strictly be <VIDEO_REF_0>');
    assert.strictEqual(runnerRes.blockoutVideoPath, outVideo);
    assert.ok(fs.existsSync(runnerRes.blockoutVideoPath), 'Blockout video must exist on disk');
    assert.strictEqual(runnerRes.startFramePngPath, outPng);
    assert.ok(fs.existsSync(runnerRes.startFramePngPath), 'Start frame PNG must exist on disk');
    assert.strictEqual(runnerRes.clayGlbPath, outGlb);
    assert.ok(fs.existsSync(runnerRes.clayGlbPath), 'Clay GLB massing must exist on disk');
    assert.strictEqual(runnerRes.frameCount, 72);
    assert.strictEqual(runnerRes.fps, 24);
    assert.strictEqual(runnerRes.durationSec, 3.0);
    assert.ok(runnerRes.meshStats.vertexCount > 0, 'Vertex count must be > 0');
    assert.strictEqual(runnerRes.geoAnchor.landmarkName, 'Tokyo Tower');

    await fs.remove(tmpDir);
    console.log('  ✓ Test 12 Passed: Codified Tile Clay Blockout Runner outputs verified <VIDEO_REF_0>, Frame 0 PNG, and GLB massing');
  }

  console.log('\n🎉 ALL GOOGLE 3D TILE BLOCKOUT PIPELINE TESTS PASSED!\n');
}

async function runCameraPathPipelineTests() {
  const service = new Google3DTileBlockoutPipelineService();

  // =========================================================================
  // Test 2: Camera Trajectory Path Loading & Validation
  // =========================================================================
  console.log('Testing 2: Camera Trajectory Path Loading & Validation...');
  {
    const pathFile = CAMERA_PATH_FILE;
    const pathData = service.loadCameraPath(pathFile);

    assert.strictEqual(pathData.fps, 24, 'Camera path fps must be 24');
    assert.strictEqual(pathData.totalFrames, 72, 'Camera path must contain 72 frames');
    assert.strictEqual(pathData.frames.length, 72, 'Frames array length must be 72');

    const f0 = pathData.frames[0];
    assert.strictEqual(f0.frame, 0);
    assert.strictEqual(f0.timeSec, 0.0);
    assert.strictEqual(f0.position.length, 3);
    assert.strictEqual(f0.target.length, 3);
    assert.strictEqual(f0.up.length, 3);
    assert.strictEqual(f0.fov, 65.0);

    const f71 = pathData.frames[71];
    assert.strictEqual(f71.frame, 71);
    assert.ok(Math.abs(f71.timeSec - 2.958) < 0.05);

    console.log('  ✓ Test 2 Passed: 6-DoF trajectory data parsed and validated');
  }

  // =========================================================================
  // Test 3: Automated HTML Runner Generation & Atmosphere Injection
  // =========================================================================
  console.log('Testing 3: Automated HTML Runner Generation & Atmosphere Injection...');
  {
    const esbOrigin: GeoAnchor = {
      lat: 40.7484405,
      lng: -73.9856644,
      elevation: 15.0
    };

    const pathFile = CAMERA_PATH_FILE;
    const pathData = service.loadCameraPath(pathFile);

    const html = service.generateRunnerHtml({
      geoAnchor: esbOrigin,
      cameraPath: pathData,
      apiKey: DEFAULT_GOOGLE_MAPS_TILES_API_KEY || 'AIzaSyMockKeyForTesting_12345',
      atmosphere: {
        renderMode: 'clay',
        clayPreset: 'warm-clay',
        clayColor: '#dcd6cd',
        roughness: 0.82,
        metalness: 0.02,
        skyColor: '#dce3eb',
        fogExp2Density: 0.0022,
        exposure: 1.15
      },
      lodQuality: {
        errorTarget: 0.5,
        resolutionWidth: 1280,
        resolutionHeight: 720,
        virtualSseWidth: 3840,
        virtualSseHeight: 2160,
        stableFramesThreshold: 15,
        maxSettleWaitMs: 20000
      }
    }, pathData);

    // Assert script imports and three.js components
    assert.ok(html.includes('"3d-tiles-renderer": "/node_modules/3d-tiles-renderer/build/index.js"'));
    assert.ok(html.includes('"three": "/node_modules/three/build/three.module.js"'));
    assert.ok(html.includes('GoogleCloudAuthPlugin'));

    // Assert LOD Quality & Atmosphere directives
    assert.ok(html.includes('const ERROR_TARGET = 0.5;'), 'Must demand errorTarget 0.5');
    assert.ok(html.includes('tiles.setResolution(camera, 3840, 2160);'), 'Must calculate SSE against 4K viewport');
    assert.ok(html.includes("scene.background = new THREE.Color('#dce3eb');"), 'Must inject sky color');
    assert.ok(html.includes("scene.fog = new THREE.FogExp2('#dce3eb', 0.0022);"), 'Must inject FogExp2');
    assert.ok(html.includes('diffuseColor.rgb = uTileColor;'), 'Must inject clay shader albedo override');
    assert.ok(html.includes('roughnessFactor = 0.82;'), 'Must inject clay roughness');
    assert.ok(html.includes('metalnessFactor = 0.02;'), 'Must inject clay metalness');

    // Assert strict per-frame settlement
    assert.ok(html.includes('stats.downloading === 0 && stats.parsing === 0'), 'Must wait for tile download and parse queue drain');
    assert.ok(html.includes('const STABLE_THRESHOLD = 15;'), 'Must enforce stable settlement window');

    // Assert 360° perimeter frustum coverage synthesis prior to GLB mesh extraction
    assert.ok(html.includes('Synthesizing 360° perimeter coverage across flight corridor'), 'Must synthesize 360° perimeter coverage before GLB extraction');
    assert.ok(html.includes('exportCameras.push(cam)'), 'Must register multi-camera orbital array for perimeter coverage');
    assert.ok(html.includes('exportCameras.push(topCam)'), 'Must register high-angle contextual camera for full footprint coverage');
    assert.ok(html.includes('seenMeshes.has(node.uuid)'), 'Must deduplicate meshes via seenMeshes set');
    assert.ok(html.includes('tiles.deleteCamera(c)'), 'Must clean up export cameras and restore primary camera');

    console.log('  ✓ Test 3 Passed: HTML runner properly injects atmosphere, 3D tiles, 360° perimeter synthesis, and settlement logic');
  }

  // =========================================================================
  // Test 4: Pipeline Execution, Output Artifacts & Manifest Generation
  // =========================================================================
  console.log('Testing 4: Pipeline Execution, Output Artifacts & Manifest Generation...');
  {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scratchbox-tile-blockout-test-'));

    const testVideoPath = path.join(tmpDir, 'test_blockout_camera.mp4');
    const testFramesDir = path.join(tmpDir, 'frames');
    const testFirstFrame = path.join(tmpDir, 'blockout_first_frame.jpg');
    const testFirstFramePng = path.join(tmpDir, 'blockout_first_frame.png');
    const testStoryboardsDir = path.join(tmpDir, 'storyboards');
    const testManifestPath = path.join(tmpDir, 'blockout_manifest.json');

    const result = await service.run({
      geoAnchor: {
        lat: 40.7484405,
        lng: -73.9856644,
        elevation: 15.0,
        landmarkName: 'Empire State Building'
      },
      cameraPath: CAMERA_PATH_FILE,
      offlineMock: true,
      output: {
        outputVideoPath: testVideoPath,
        framesDir: testFramesDir,
        firstFramePath: testFirstFrame,
        firstFramePngPath: testFirstFramePng,
        storyboardsDir: testStoryboardsDir,
        manifestPath: testManifestPath,
        outputGlbPath: path.join(tmpDir, 'google_tiles_clay_area.glb'),
        fps: 24,
        storyboardBeats: 8
      }
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.videoRef, '<VIDEO_REF_0>');
    assert.strictEqual(result.frameCount, 72);
    assert.strictEqual(result.fps, 24);
    assert.strictEqual(result.durationSec, 3);
    assert.strictEqual(result.tileMetrics.errorTarget, 0.5);
    assert.strictEqual(result.tileMetrics.renderMode, 'clay');

    // Assert files exist on disk
    assert.ok(fs.existsSync(testVideoPath), 'Output video file must exist');
    assert.ok(fs.existsSync(testFirstFrame), 'First frame JPG must exist');
    assert.ok(fs.existsSync(testFirstFramePng), 'First frame PNG must exist');
    assert.ok(fs.existsSync(testManifestPath), 'Manifest JSON must exist');

    // Assert storyboard beats
    assert.strictEqual(result.storyboardPaths.length, 8, 'Must generate 8 storyboard beats');
    for (const bPath of result.storyboardPaths) {
      assert.ok(fs.existsSync(bPath), `Storyboard file must exist: ${bPath}`);
    }

    // Verify manifest contents
    const manifest = fs.readJsonSync(testManifestPath);
    assert.strictEqual(manifest.videoRef, '<VIDEO_REF_0>');
    assert.strictEqual(manifest.totalFrames, 72);
    assert.strictEqual(manifest.geoAnchor.lat, 40.7484405);
    assert.strictEqual(manifest.errorTarget, 0.5);

    // Assert collision audit
    assert.ok(result.collisionAudit, 'Result must include collisionAudit');
    assert.strictEqual(result.collisionAudit.auditPassed, true, 'Audit must pass on safe path');
    assert.strictEqual(result.collisionAudit.violationsDetected, 0, 'No collisions detected');
    assert.ok(result.collisionAudit.minClearanceMeters >= 5.0, 'Min clearance must meet threshold');
    assert.strictEqual(manifest.collisionAudit?.auditPassed, true, 'Manifest must record auditPassed');

    // Clean up tmp test directory
    await fs.remove(tmpDir);

    console.log('  ✓ Test 4 Passed: Pipeline execution outputs, Frame 0 still, storyboards, manifest, and collision audit validated');
  }

  // =========================================================================
  // Test 6: Spatial Clearance and Collision Audit Prevents Perspective Clipping
  // =========================================================================
  console.log('Testing 6: Spatial Clearance and Collision Audit Prevents Perspective Clipping...');
  {
    const cameraPathData = service.parseCameraPath(
      CAMERA_PATH_FILE
    );

    // Audit safe camera path
    const safeAudit = service.auditCameraClearance(cameraPathData, 10.0);
    assert.strictEqual(safeAudit.auditPassed, true, 'Safe camera trajectory must pass clearance audit');
    assert.strictEqual(safeAudit.violationsDetected, 0, 'No clearance violations on safe corridor');
    assert.ok(safeAudit.minClearanceMeters >= 10.0, 'Clearance must exceed 10m buffer');

    // Simulate colliding trajectory dipping below rooftop level (e.g. y = 35m in building footprint)
    const collidingPathData = {
      ...cameraPathData,
      frames: cameraPathData.frames.map((f, idx) => {
        if (idx === 24) {
          // Force frame 24 to dip into rooftop
          return { ...f, position: [f.position[0], 35.0, f.position[2]] as [number, number, number] };
        }
        return f;
      })
    };

    const mockRooftopElevations = [
      { minX: 140, maxX: 170, minZ: -260, maxZ: -230, rooftopY: 50.0 }
    ];

    const collidingAudit = service.auditCameraClearance(collidingPathData, 10.0, mockRooftopElevations);
    assert.strictEqual(collidingAudit.auditPassed, false, 'Colliding trajectory must fail clearance audit');
    assert.strictEqual(collidingAudit.violationsDetected, 1, 'Exactly one breach detected');
    assert.strictEqual(collidingAudit.violations[0].frameIndex, 24, 'Frame 24 identified as violator');
    assert.strictEqual(collidingAudit.violations[0].clearanceMeters, -15.0, 'Reports penetration depth (-15m)');

    console.log('  ✓ Test 6 Passed: Pre-render spatial collision detection detects perspective breaches and calculates clearance buffer');
  }

  // =========================================================================
  // Test 7: Photorealistic Textured Mode Runner Generation & Pipeline Output
  // =========================================================================
  console.log('Testing 7: Photorealistic Textured Mode Runner Generation & Pipeline Output...');
  {
    const esbOrigin: GeoAnchor = {
      lat: 40.7484405,
      lng: -73.9856644,
      elevation: 15.0,
      landmarkName: 'Empire State Building Midtown Manhattan'
    };

    const pathFile = CAMERA_PATH_FILE;
    const pathData = service.loadCameraPath(pathFile);

    const texturedHtml = service.generateRunnerHtml({
      geoAnchor: esbOrigin,
      cameraPath: pathData,
      apiKey: DEFAULT_GOOGLE_MAPS_TILES_API_KEY || 'AIzaSyMockKeyForTesting_12345',
      atmosphere: {
        renderMode: 'textured'
      },
      lodQuality: {
        errorTarget: 0.5,
        resolutionWidth: 3840,
        resolutionHeight: 2160
      }
    }, pathData);

    // Assert textured mode configuration
    assert.ok(texturedHtml.includes("RENDER_MODE = urlParams.get('mode') || urlParams.get('renderMode') || 'textured'"), 'Must default to textured mode in script');
    assert.ok(texturedHtml.includes('RENDER_MODE === \'textured\' || RENDER_MODE === \'photoreal\''), 'Must have branch preserving textures');
    assert.ok(texturedHtml.includes('m.side = THREE.DoubleSide;'), 'Must configure double-sided face rendering for photogrammetry facades');
    assert.ok(texturedHtml.includes('m.map.colorSpace = THREE.SRGBColorSpace;'), 'Must preserve sRGB color space on diffuse texture maps');
    assert.ok(texturedHtml.includes('renderer.toneMappingExposure = 1;'), 'Must use balanced exposure for photorealistic textures');
    assert.ok(texturedHtml.includes("new THREE.DirectionalLight('#fffaed', 0.95);"), 'Must use balanced sunlight intensity to avoid washing out baked sunlight');

    // Run pipeline in textured mode with offlineMock
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scratchbox-tile-textured-test-'));
    const testVideoPath = path.join(tmpDir, 'textured_camera.mp4');
    const testFramesDir = path.join(tmpDir, 'frames');
    const testFirstFrame = path.join(tmpDir, 'textured_first_frame.jpg');
    const testFirstFramePng = path.join(tmpDir, 'textured_first_frame.png');
    const testManifestPath = path.join(tmpDir, 'textured_manifest.json');

    const result = await service.run({
      geoAnchor: esbOrigin,
      cameraPath: pathFile,
      atmosphere: {
        renderMode: 'textured'
      },
      offlineMock: true,
      output: {
        outputVideoPath: testVideoPath,
        framesDir: testFramesDir,
        firstFramePath: testFirstFrame,
        firstFramePngPath: testFirstFramePng,
        manifestPath: testManifestPath,
        storyboardsDir: path.join(tmpDir, 'storyboards'),
        outputGlbPath: path.join(tmpDir, 'google_tiles_textured_area.glb')
      }
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.tileMetrics.renderMode, 'textured', 'Metrics must report textured renderMode');
    assert.ok(fs.existsSync(testManifestPath), 'Manifest JSON must exist');
    const manifest = fs.readJsonSync(testManifestPath);
    assert.strictEqual(manifest.renderMode, 'textured', 'Manifest must record textured renderMode');

    await fs.remove(tmpDir);

    console.log('  ✓ Test 7 Passed: Photorealistic textured mode runner preserves PBR diffuse textures and records manifest');
  }

  // =========================================================================
}

test('Google 3D Tile Blockout Video Pipeline Test Suite', async () => {
  await runBlockoutPipelineTests();
});

test.skipIf(!cameraPathAsset.ok)(withReason('Google 3D Tile Blockout camera-path loading, runner generation, pipeline run and clearance audit', cameraPathAsset), async () => {
  await runCameraPathPipelineTests();
});

// =========================================================================
// No silent fake success: offline mock is explicit opt-in and Chrome failures reject
// =========================================================================

const failureAnchor: GeoAnchor = { lat: 40.7484405, lng: -73.9856644, elevation: 15.0, landmarkName: 'Empire State Building' };

function listChromeProfileDirs(): string[] {
  return fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('chrome_tile_blockout_'));
}

async function makeFailureOutputs(prefix: string) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return {
    tmpDir,
    output: {
      outputVideoPath: path.join(tmpDir, 'blockout.mp4'),
      outputGlbPath: path.join(tmpDir, 'area.glb'),
      framesDir: path.join(tmpDir, 'frames'),
      firstFramePath: path.join(tmpDir, 'first.jpg'),
      firstFramePngPath: path.join(tmpDir, 'first.png'),
      storyboardsDir: path.join(tmpDir, 'storyboards'),
      manifestPath: path.join(tmpDir, 'manifest.json'),
      compileWebm: false
    }
  };
}

test('offlineMock results are explicitly marked mock, never reuse a pre-existing GLB, and carry no fabricated tile metrics', async () => {
  const service = new Google3DTileBlockoutPipelineService();
  const { tmpDir, output } = await makeFailureOutputs('scratchbox-tile-mock-marking-');
  try {
    // A pre-existing (stale / production) GLB at the output path must be neither reused nor overwritten
    const staleBytes = Buffer.from('glTF-stale-production-asset');
    await fs.writeFile(output.outputGlbPath, staleBytes);

    const result = await service.run({
      geoAnchor: failureAnchor,
      cameraPath: create3DTilesTrajectory(failureAnchor, { durationSec: 0.5, fps: 8 }),
      offlineMock: true,
      output
    });

    assert.strictEqual(result.mock, true, 'Offline mock results must be flagged mock: true');
    assert.strictEqual(result.manifest.mock, true, 'Offline mock manifest must be flagged mock: true');
    assert.strictEqual(result.tileMetrics.averageSettleTimeMs, 0, 'No fabricated settle time');
    assert.strictEqual(result.manifest.tileMetrics.maxTilesLoaded, 0, 'No fabricated tile counts');
    assert.ok(fs.readFileSync(output.outputGlbPath).equals(staleBytes), 'Pre-existing GLB must not be overwritten');
    assert.notStrictEqual(result.glbPath, output.outputGlbPath, 'Pre-existing GLB must not be reported as the mock output');
    assert.ok(result.glbPath!.endsWith('.offline_mock.glb'));
    assert.strictEqual(result.glbBuffer!.toString('ascii', 0, 4), 'glTF');
    assert.ok(result.glbBuffer!.equals(fs.readFileSync(result.glbPath!)));
    // Bounds come from the GLB POSITION accessors, not a fixed placeholder box
    assert.notDeepStrictEqual(result.mesh!.boundingBox, { min: [-100, -10, -100], max: [100, 200, 100] });
    // The PNG path holds real PNG bytes (not JPEG bytes)
    const png = fs.readFileSync(output.firstFramePngPath);
    assert.strictEqual(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'First frame PNG must be a real PNG');

    const fetched = await getGoogle3DTilesClay(failureAnchor, { offlineMock: true, outputGlbPath: path.join(tmpDir, 'clay_api.glb') });
    assert.strictEqual(fetched.mock, true, 'fetch3DObject must propagate the mock flag');
    assert.strictEqual(fetched.quality.leafLodSettled, false, 'Mock results must not claim leaf LOD settlement');
  } finally {
    await fs.remove(tmpDir);
  }
}, 120_000);

test('missing Chrome binary rejects with an actionable error instead of falling back to mock output', async () => {
  const missingChrome = path.join(os.tmpdir(), `no-such-chrome-${Date.now()}`);
  const service = new Google3DTileBlockoutPipelineService(missingChrome);
  const { tmpDir, output } = await makeFailureOutputs('scratchbox-tile-missing-chrome-');
  const profilesBefore = new Set(listChromeProfileDirs());
  try {
    await assert.rejects(
      service.run({
        geoAnchor: failureAnchor,
        cameraPath: create3DTilesTrajectory(failureAnchor, { durationSec: 0.5, fps: 8 }),
        output
      }),
      (err: Error) => {
        assert.match(err.message, /Headless Chrome failed to launch/);
        assert.ok(err.message.includes(missingChrome), 'Error must name the Chrome binary');
        assert.match(err.message, /CHROME_BIN/);
        return true;
      }
    );
    assert.ok(!fs.existsSync(output.outputVideoPath), 'No placeholder video may be written on failure');
    assert.ok(!fs.existsSync(output.manifestPath), 'No manifest may be written on failure');
    assert.ok(!fs.existsSync(output.firstFramePngPath), 'No placeholder first frame may be written on failure');
    assert.ok(!fs.existsSync(output.outputGlbPath), 'No synthetic GLB may be written on failure');
    const leaked = listChromeProfileDirs().filter(d => !profilesBefore.has(d));
    assert.deepStrictEqual(leaked, [], 'Chrome profile dir must be removed on failure');
  } finally {
    await fs.remove(tmpDir);
  }
}, 60_000);

test('Chrome exiting non-zero rejects with the exit code and stderr tail', async () => {
  const { tmpDir, output } = await makeFailureOutputs('scratchbox-tile-chrome-exit-');
  const fakeChrome = path.join(tmpDir, 'fake-chrome.sh');
  await fs.writeFile(fakeChrome, '#!/bin/sh\necho "FATAL: GPU process unavailable" 1>&2\nexit 21\n', { mode: 0o755 });
  const service = new Google3DTileBlockoutPipelineService(fakeChrome);
  try {
    await assert.rejects(
      service.run({
        geoAnchor: failureAnchor,
        cameraPath: create3DTilesTrajectory(failureAnchor, { durationSec: 0.5, fps: 8 }),
        output
      }),
      (err: Error) => {
        assert.match(err.message, /exited before the runner finished \(code 21/);
        assert.match(err.message, /FATAL: GPU process unavailable/);
        return true;
      }
    );
    assert.ok(!fs.existsSync(output.outputVideoPath));
    assert.ok(!fs.existsSync(output.manifestPath));
  } finally {
    await fs.remove(tmpDir);
  }
}, 60_000);

test('a runner that stalls after the first frame is killed by the inactivity timeout and rejects', async () => {
  const { tmpDir, output } = await makeFailureOutputs('scratchbox-tile-chrome-stall-');
  // Fake "Chrome": uploads one frame to the recorder URL (last argv), then hangs forever.
  const fakeChrome = path.join(tmpDir, 'fake-chrome-stall.cjs');
  await fs.writeFile(fakeChrome, `#!${process.execPath}
const http = require('http');
const url = new URL(process.argv[process.argv.length - 1]);
const body = JSON.stringify({ index: 0, dataUrl: 'data:image/jpeg;base64,/9j/4AAQ', settleTimeMs: 5, tilesLoaded: 1 });
const req = http.request({ host: url.hostname, port: url.port, path: '/upload-frame', method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => res.resume());
req.end(body);
setInterval(() => {}, 1000);
`, { mode: 0o755 });
  const service = new Google3DTileBlockoutPipelineService(fakeChrome);
  const startedAt = Date.now();
  try {
    await assert.rejects(
      service.run({
        geoAnchor: failureAnchor,
        cameraPath: create3DTilesTrajectory(failureAnchor, { durationSec: 0.5, fps: 8 }),
        timeoutMs: 10_000,
        inactivityTimeoutMs: 1_500,
        output
      }),
      (err: Error) => {
        assert.match(err.message, /stalled: no runner activity for 1500ms/);
        assert.match(err.message, /Frames received: 1\//);
        return true;
      }
    );
    assert.ok(Date.now() - startedAt < 9_000, 'Inactivity timeout must fire well before the startup timeout');
    assert.ok(fs.existsSync(path.join(output.framesDir, 'frame_0000.jpg')), 'The real uploaded frame is kept for diagnosis');
    assert.ok(!fs.existsSync(output.outputVideoPath), 'No video may be reported for a stalled run');
    assert.ok(!fs.existsSync(output.manifestPath));
  } finally {
    await fs.remove(tmpDir);
  }
}, 60_000);
