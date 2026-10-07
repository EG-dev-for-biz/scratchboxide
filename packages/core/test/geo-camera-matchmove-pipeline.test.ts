/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { test, describe } from 'vitest';
import * as assert from 'assert';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs-extra';
import {
  GeoCameraMatchmovePipelineService,
  GeoMatchmoveRequest
} from '../src/node/spatial/GeoCameraMatchmovePipelineService';

describe('GeoCameraMatchmovePipelineService Test Suite', () => {
  const service = new GeoCameraMatchmovePipelineService();

  const PLAZA = { lat: 40.7646318, lng: -73.9743251, elevation: 18.0, landmarkName: 'The Plaza Hotel', headingDeg: -29.0 };
  const ESB = { lat: 40.748817, lng: -73.985428, elevation: 15.0, landmarkName: 'Empire State Building', headingDeg: -29.0 };
  const EIFFEL = { lat: 48.85837, lng: 2.294481, elevation: 35.0, landmarkName: 'Eiffel Tower', headingDeg: 0.0 };

  const geocodeFetch = (geocodeBody: any, elevationBody: any = { status: 'OK', results: [{ elevation: 18.66 }] }) => (async (input: any) => {
    const url = String(input);
    const body = url.includes('/geocode/') ? geocodeBody : elevationBody;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  test('1. Geodetic anchors resolve through coordinates and Vector Tiles; Google Geocoding API is strictly disabled', async () => {
    // 1. Direct coordinate parsing
    const coordAnchor = await service.geocodeLandmarkAnchor('40.764632, -73.974325, 18.66');
    assert.strictEqual(coordAnchor.lat, 40.764632);
    assert.strictEqual(coordAnchor.lng, -73.974325);
    assert.strictEqual(coordAnchor.elevation, 18.66);

    // 2. Google Vector Tile resolution
    const vectorAnchor = await service.geocodeLandmarkAnchor('Empire State Building');
    assert.strictEqual(Number(vectorAnchor.lat.toFixed(4)), 40.7484);
    assert.strictEqual(Number(vectorAnchor.lng.toFixed(4)), -73.9857);

    // 3. Unresolvable query without coordinates or vector match throws strict zero-geocoding error
    await assert.rejects(
      service.geocodeLandmarkAnchor('NonExistentCustomFantasyTower'),
      /Google Geocoding API is strictly disabled/i
    );

    const explicit = service.resolveLandmarkAnchor(PLAZA);
    assert.strictEqual(explicit.lat, PLAZA.lat);
    assert.strictEqual(explicit.headingDeg, -29.0);
  });

  test('2. 6-DoF Spline Trajectory Solver (crane-descent-to-nadir)', () => {
    const plazaAnchor = service.resolveLandmarkAnchor(PLAZA);
    const mockMetadata = {
      durationSec: 15.0,
      fps: 24,
      totalFrames: 360,
      width: 3840,
      height: 2160,
      codec: 'h264'
    };

    const trajectory = service.solveCameraTrajectory(
      mockMetadata,
      plazaAnchor,
      'crane-descent-to-nadir',
      plazaAnchor.headingDeg
    );

    assert.strictEqual(trajectory.fps, 24);
    assert.strictEqual(trajectory.totalFrames, 360);
    assert.strictEqual(trajectory.frames.length, 360);

    // Frame 0: Horizontal roofline perspective
    const frame0 = trajectory.frames[0];
    assert.strictEqual(frame0.frame, 0);
    assert.strictEqual(frame0.timeSec, 0);
    assert.strictEqual(frame0.fov, 40, 'Starting FOV should be 40°');
    assert.ok(frame0.position[1] >= 65, 'Frame 0 height should be near roofline');
    // Up-vector at frame 0 should be pure world-up [0, 1, 0]
    assert.strictEqual(frame0.up[1], 1, 'Up vector Y should be 1 at start');

    // Last frame: Nadir overhead looking straight down
    const lastFrame = trajectory.frames[359];
    assert.strictEqual(lastFrame.frame, 359);
    assert.strictEqual(lastFrame.fov, 55, 'Ending FOV should be wide (55°)');
    assert.ok(lastFrame.position[1] <= 12, 'Last frame height should be close to ground');
    // Look-at target should be directly underneath camera position
    assert.ok(Math.abs(lastFrame.position[0] - lastFrame.target[0]) < 1e-2, 'Nadir X target should equal camera X');
    assert.ok(Math.abs(lastFrame.position[2] - lastFrame.target[2]) < 1e-2, 'Nadir Z target should equal camera Z');
    assert.strictEqual(lastFrame.target[1], 0, 'Nadir Y target should point at ground level 0');

    // Up-vector at nadir should NOT be [0, 1, 0] (which causes gimbal lock singularity)
    // Instead it must be horizontal facade normal
    assert.strictEqual(lastFrame.up[1], 0, 'Up vector Y should be 0 at pure nadir to avoid singularity');
    const upMag = Math.hypot(lastFrame.up[0], lastFrame.up[2]);
    assert.ok(Math.abs(upMag - 1.0) < 1e-3, 'Up vector horizontal magnitude must be unit length 1.0');
  });

  test('3. Trajectory Presets: orbital-inspection & canyon-flythrough', () => {
    const eiffelAnchor = service.resolveLandmarkAnchor(EIFFEL);
    const mockMetadata = {
      durationSec: 10.0,
      fps: 30,
      totalFrames: 300,
      width: 1920,
      height: 1080,
      codec: 'h264'
    };

    // Orbital inspection
    const orbit = service.solveCameraTrajectory(
      mockMetadata,
      eiffelAnchor,
      'orbital-inspection',
      0
    );
    assert.strictEqual(orbit.totalFrames, 300);
    // Radial distance from target should remain stable
    const r0 = Math.hypot(orbit.frames[0].position[0], orbit.frames[0].position[2]);
    const r150 = Math.hypot(orbit.frames[150].position[0], orbit.frames[150].position[2]);
    assert.ok(Math.abs(r0 - r150) < 10, 'Orbital radius should remain approximately consistent');

    // Canyon flythrough
    const canyon = service.solveCameraTrajectory(
      mockMetadata,
      service.resolveLandmarkAnchor(ESB),
      'canyon-flythrough',
      -29.0
    );
    assert.strictEqual(canyon.totalFrames, 300);
    // Position should translate forward over time
    const startPos = canyon.frames[0].position;
    const endPos = canyon.frames[299].position;
    const dist = Math.hypot(endPos[0] - startPos[0], endPos[2] - startPos[2]);
    assert.ok(dist > 50, 'Canyon flythrough must travel along street vector');
  });

  test('4. End-to-End Dry-Run Execution & Trajectory File Persistence', async () => {
    const tmpDir = path.join(os.tmpdir(), `sbox_matchmove_test_${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    try {
      const referenceVideo = path.join(process.cwd(), 'reference_video_32.mp4');
      const request: GeoMatchmoveRequest = {
        inputVideoPath: referenceVideo,
        geoAnchor: service.resolveLandmarkAnchor(PLAZA),
        motionType: 'crane-descent-to-nadir',
        outputDir: tmpDir,
        outputVideoName: 'plaza_test_run',
        skipBlockoutRender: true
      };

      const result = await service.execute(request);

      assert.ok(result.success, 'Result must be success');
      assert.strictEqual(result.motionType, 'crane-descent-to-nadir');
      assert.strictEqual(result.totalFrames, 361);
      assert.strictEqual(result.fps, 24);
      assert.ok(fs.existsSync(result.cameraPathJsonPath), 'Camera path JSON must be created on disk');

      const savedJson = fs.readJsonSync(result.cameraPathJsonPath);
      assert.strictEqual(savedJson.totalFrames, 361);
      assert.strictEqual(savedJson.frames.length, 361);
      assert.strictEqual(savedJson.origin.landmarkName, 'The Plaza Hotel');
    } finally {
      fs.removeSync(tmpDir);
    }
  });

  test('5. Dense 25-Milestone Frame Sampling for Complex Moves', () => {
    const plazaAnchor = service.resolveLandmarkAnchor(PLAZA);
    const mockMetadata = {
      durationSec: 15.04,
      fps: 24,
      totalFrames: 361,
      width: 3840,
      height: 2160,
      codec: 'h264'
    };

    // Generate dense 25-milestone anchors
    const denseAnchors = service.generateCraneDescentAnchors(
      mockMetadata.durationSec,
      plazaAnchor.headingDeg,
      70.0,
      8.5,
      25
    );

    assert.strictEqual(denseAnchors.length, 25, 'Dense anchors must have exactly 25 milestones');
    assert.strictEqual(denseAnchors[0].timeSec, 0.0, 'Initial anchor must start at t=0');
    assert.strictEqual(denseAnchors[24].timeSec, mockMetadata.durationSec, 'Final anchor must end at durationSec');

    // Solve trajectory with dense anchors
    const trajectory = service.solveCameraTrajectory(
      mockMetadata,
      plazaAnchor,
      denseAnchors,
      plazaAnchor.headingDeg
    );

    assert.strictEqual(trajectory.frames.length, 361);

    // Verify continuous descent without height inversions (monotonic descent)
    for (let i = 1; i < trajectory.frames.length; i++) {
      const prevY = trajectory.frames[i - 1].position[1];
      const currY = trajectory.frames[i].position[1];
      assert.ok(currY <= prevY + 1e-2, `Frame ${i} height must monotonically descend (prev: ${prevY}, curr: ${currY})`);
    }

    // Verify tilt monotonically increases from 0 (horizontal) to 1 (nadir)
    for (let i = 1; i < trajectory.frames.length; i++) {
      const prevTilt = 1.0 - trajectory.frames[i - 1].up[1];
      const currTilt = 1.0 - trajectory.frames[i].up[1];
      assert.ok(currTilt >= prevTilt - 1e-2, `Frame ${i} tilt must increase towards nadir`);
    }
  });

  test('6. Adaptive Curvature & Angular Rate Keyframe Extraction', () => {
    const plazaAnchor = service.resolveLandmarkAnchor(PLAZA);
    const mockMetadata = {
      durationSec: 15.04,
      fps: 24,
      totalFrames: 361,
      width: 3840,
      height: 2160,
      codec: 'h264'
    };

    const initialTrajectory = service.solveCameraTrajectory(
      mockMetadata,
      plazaAnchor,
      'crane-descent-to-nadir',
      plazaAnchor.headingDeg
    );

    const adaptiveAnchors = service.sampleDenseKeyframesAdaptive(initialTrajectory, {
      targetKeyframeCount: 25,
      minIntervalSec: 0.20,
      curvatureSensitivity: 1.5,
      angularRateSensitivity: 1.2
    });

    assert.ok(adaptiveAnchors.length >= 20, 'Adaptive sampler must yield dense keyframes');
    assert.strictEqual(adaptiveAnchors[0].timeSec, 0.0, 'First adaptive anchor must be t=0');
    assert.strictEqual(adaptiveAnchors[adaptiveAnchors.length - 1].timeSec, Number(mockMetadata.durationSec.toFixed(4)));

    // Verify keyframes are clustered around high-curvature inflection (canopy crossing around t=6-8s)
    const midSectionAnchors = adaptiveAnchors.filter(a => a.timeSec >= 5.0 && a.timeSec <= 9.0);
    assert.ok(midSectionAnchors.length >= 5, 'High-curvature canopy transition must have dense keyframe concentration');
  });

  test('7. Precision 6-DoF Solver (Hermite-Slerp & Sub-Pixel 3D Tile Edge Alignment)', async () => {
    const plazaAnchor = service.resolveLandmarkAnchor(PLAZA);
    const mockMetadata = {
      durationSec: 15.04,
      fps: 24,
      totalFrames: 361,
      width: 3840,
      height: 2160,
      codec: 'h264'
    };

    const denseAnchors = service.generateCraneDescentAnchors(
      mockMetadata.durationSec,
      plazaAnchor.headingDeg,
      70.0,
      8.5,
      25
    );

    const precisionResult = service.solvePrecisionTrajectory(
      mockMetadata,
      plazaAnchor,
      denseAnchors,
      plazaAnchor.headingDeg,
      {
        lensDistortion: { k1: -0.015, k2: 0.002, p1: 0, p2: 0 },
        tileMeshPath: path.resolve(process.cwd(), 'public/models/google_tiles_textured_area.glb')
      }
    );

    assert.ok(precisionResult.pathData, 'Precision path data must be produced');
    assert.strictEqual(precisionResult.pathData.frames.length, 361, 'Continuous interpolated frames must equal 361');
    assert.strictEqual(precisionResult.pathData.fps, 24);

    // Frame 0 pitch validation (slight downward pitch looking at Plaza roof)
    const f0 = precisionResult.pathData.frames[0];
    const f0DeltaY = f0.target[1] - f0.position[1];
    const f0Dist = Math.hypot(f0.target[0] - f0.position[0], f0.target[2] - f0.position[2]);
    const f0PitchDeg = (Math.atan2(f0DeltaY, f0Dist) * 180.0) / Math.PI;
    assert.ok(Math.abs(f0PitchDeg - (-2.27)) < 1.0, `Initial pitch should be ~ -2.27 deg, got ${f0PitchDeg}`);

    // Final frame nadir pitch validation (-90 deg looking straight down)
    const fFinal = precisionResult.pathData.frames[360];
    const fFinalHorizDist = Math.hypot(fFinal.target[0] - fFinal.position[0], fFinal.target[2] - fFinal.position[2]);
    assert.ok(fFinalHorizDist < 0.05, `Final frame target must be directly below camera (horizontal offset < 0.05m, got ${fFinalHorizDist})`);
    assert.ok(fFinal.position[1] > fFinal.target[1], 'Final frame camera must be above target');

    // Camera up vector at nadir must be orthogonal to forward vector (no collinear lookAt singularity)
    assert.ok(Math.abs(fFinal.up[1]) < 0.01, `Final frame up Y should be 0, got ${fFinal.up[1]}`);
    assert.ok(Math.abs(Math.hypot(fFinal.up[0], fFinal.up[1], fFinal.up[2]) - 1.0) < 1e-4, 'Up vector must be unit length');

    // Orientation quaternions in solveTrack must be normalized unit quaternions
    assert.ok(precisionResult.solveTrack, 'Solve track must be present');
    assert.strictEqual(precisionResult.solveTrack.frames.length, 25, 'Solve track keyframes must match milestones');
    for (const frame of precisionResult.solveTrack.frames) {
      const q = frame.rotationQuaternion;
      const qNorm = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
      assert.ok(Math.abs(qNorm - 1.0) < 1e-4, `Orientation quaternion must be normalized, got ${qNorm}`);
    }

    // A trajectory built from keyframes is not measured against the plate, so it must not report alignment scores
    const metrics = precisionResult.precisionMetrics;
    assert.strictEqual(metrics.measured, false);
    assert.strictEqual(metrics.trajectorySource, 'keyframes');
    assert.strictEqual(metrics.meanReprojectionErrorPx, null);
    assert.strictEqual(metrics.meanEdgeOverlapScorePct, null);
    assert.strictEqual(metrics.meanDriftPx, null);
    assert.strictEqual(metrics.driftStatus, 'uncalibrated');
    assert.strictEqual(precisionResult.solveTrack.isSolved, false);
    assert.ok(precisionResult.solveTrack.frames.every(f => f.reprojectionErrorPx === undefined), 'Keyframes carry no invented residuals');

    // Test End-to-End Dry-Run with Precision Flag
    const tmpDir = path.join(os.tmpdir(), `sbox_precision_matchmove_test_${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
      const referenceVideo = path.join(process.cwd(), 'reference_video_32.mp4');
      const req: GeoMatchmoveRequest = {
        inputVideoPath: referenceVideo,
        geoAnchor: plazaAnchor,
        motionType: 'crane-descent-to-nadir',
        outputDir: tmpDir,
        outputVideoName: 'plaza_precision_test',
        skipBlockoutRender: true,
        precisionOptimization: true,
        lensDistortion: { k1: -0.015, k2: 0.002, p1: 0, p2: 0 }
      };

      const result = await service.execute(req);
      assert.ok(result.success, 'Pipeline must succeed');
      assert.ok(result.precisionMetrics, 'Result must contain precisionMetrics');
      assert.strictEqual(result.precisionMetrics.measured, false);
      assert.strictEqual(result.precisionMetrics.trajectorySource, 'motion-preset');
      assert.ok(result.solveTrack, 'Result must contain solveTrack');
      assert.strictEqual(result.solveTrack.frames.length, 25);
    } finally {
      fs.removeSync(tmpDir);
    }
  });
});
