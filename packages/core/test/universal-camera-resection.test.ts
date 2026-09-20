/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import {
  VanishingPointHorizonEstimator,
  LandmarkBearingGatedMatcher,
  MultiModalCameraPoseOptimizer,
  DynamicVideoTrajectorySolver,
  TrajectoryBoundaryPose
} from '../src/node';
import {
  GeoCameraMatchmovePipelineService
} from '../src/node/spatial/GeoCameraMatchmovePipelineService';
import {
  RenderMesh3D
} from '../src/node/spatial/HeadlessMeshSilhouetteRenderer';
import {
  CameraPose6DOF,
  SobelEdgeField
} from '../src/node/spatial/SubPixelEdgeAlignmentOptimizer';

describe('Universal Camera Resection & Spatial POV Alignment Architecture', () => {

  // =========================================================================
  // 1. VanishingPointHorizonEstimator Tests
  // =========================================================================
  describe('1. VanishingPointHorizonEstimator', () => {
    it('accurately estimates upward pitch and optical horizon from upward-converging vertical facade lines', () => {
      const width = 1920;
      const height = 1080;
      const fovYDeg = 40.0;
      const cy = height / 2; // 540

      // Lines precisely converging to Zenith Vanishing Point at (960, 160.5)
      // deltaY = 540 - 160.5 = 379.5 px; fy = 1483.5 px => tan(pitch) = 0.2558 => pitch ~ 14.35 deg (looking upward)
      const lines = [
        { x1: 600, y1: 950, x2: 828, y2: 450 },
        { x1: 780, y1: 950, x2: 894, y2: 450 },
        { x1: 1140, y1: 950, x2: 1026, y2: 450 },
        { x1: 1320, y1: 950, x2: 1092, y2: 450 }
      ];

      const result = VanishingPointHorizonEstimator.estimatePitchFromVerticalLines(lines, width, height, fovYDeg);

      expect(result.classification).toBe('looking-upward');
      expect(result.pitchDeg).toBeGreaterThan(12.0);
      expect(result.pitchDeg).toBeLessThan(17.0);
      expect(result.zenithVp).not.toBeNull();
      expect(result.zenithVp![1]).toBeLessThan(cy); // Vanishing point is above screen center (vz < 540)
      expect(result.horizonLine).not.toBeNull();
      expect(result.horizonLine!.horizonYAtCenter).toBeGreaterThan(cy); // Optical horizon is depressed below screen center
      expect(result.metrics.confidence).toBeGreaterThan(0.5);
    });

    it('accurately identifies downward pitch when vertical facade lines converge downward', () => {
      const width = 1920;
      const height = 1080;
      const fovYDeg = 40.0;
      const cy = height / 2; // 540

      // Lines converging downward to Nadir Vanishing Point at (960, 1400)
      // deltaY = 540 - 1400 = -860 px => tan(pitch) = -860 / 1483.5 = -0.5797 => pitch ~ -30.1 deg (looking downward)
      const lines = [
        { x1: 600, y1: 200, x2: 750, y2: 700 },
        { x1: 780, y1: 200, x2: 855, y2: 700 },
        { x1: 1140, y1: 200, x2: 1065, y2: 700 },
        { x1: 1320, y1: 200, x2: 1170, y2: 700 }
      ];

      const result = VanishingPointHorizonEstimator.estimatePitchFromVerticalLines(lines, width, height, fovYDeg);

      expect(result.classification).toBe('looking-downward');
      expect(result.pitchDeg).toBeLessThan(-20.0);
      expect(result.zenithVp).not.toBeNull();
      expect(result.zenithVp![1]).toBeGreaterThan(cy); // Vanishing point is below screen center (vz > 540)
    });

    it('bounds camera eye-level altitude when looking upward, preventing the 82m altitude overshoot trap', () => {
      const pitchDeg = 14.0;
      const standoffDistanceMeters = 25.2;
      const targetFeatureApexY = 62.6; // Turret dome apex at 62.6m

      const bounds = VanishingPointHorizonEstimator.estimateAltitudeBounds(pitchDeg, standoffDistanceMeters, targetFeatureApexY);

      expect(bounds.isUpwardGated).toBe(true);
      expect(bounds.maxAltitudeMeters).toBe(targetFeatureApexY);
      expect(bounds.estimatedAltitudeMeters).toBeCloseTo(56.5, 1);
      expect(bounds.minAltitudeMeters).toBeGreaterThanOrEqual(0.0);
      expect(bounds.estimatedAltitudeMeters).toBeLessThan(targetFeatureApexY);
    });
  });

  // =========================================================================
  // 2. LandmarkBearingGatedMatcher Tests
  // =========================================================================
  describe('2. LandmarkBearingGatedMatcher', () => {
    const buildSyntheticBuildingMesh = (): RenderMesh3D => {
      const vertices: number[] = [];
      const indices: number[] = [];

      const addQuad = (p0: number[], p1: number[], p2: number[], p3: number[]) => {
        const baseIdx = vertices.length / 3;
        vertices.push(...p0, ...p1, ...p2, ...p3);
        indices.push(baseIdx, baseIdx + 1, baseIdx + 2, baseIdx, baseIdx + 2, baseIdx + 3);
      };

      // East facade: X = 20, Y in [0, 60], Z in [-20, 20]
      addQuad([20, 0, -20], [20, 0, 20], [20, 60, 20], [20, 60, -20]);
      // West facade: X = -20
      addQuad([-20, 0, 20], [-20, 0, -20], [-20, 60, -20], [-20, 60, 20]);
      // North facade: Z = -20
      addQuad([-20, 0, -20], [20, 0, -20], [20, 60, -20], [-20, 60, -20]);
      // South facade: Z = 20
      addQuad([20, 0, 20], [-20, 0, 20], [-20, 60, 20], [20, 60, 20]);
      // Roof plane: Y = 60
      addQuad([-20, 60, -20], [-20, 60, 20], [20, 60, 20], [20, 60, -20]);

      // Northeast turret apex at [18, 65, -18]
      addQuad([16, 60, -20], [20, 60, -20], [20, 65, -16], [16, 65, -16]);

      return {
        vertices: new Float32Array(vertices),
        indices: new Uint32Array(indices)
      };
    };

    it('extracts facade planes and exterior corner features from 3D mesh', () => {
      const mesh = buildSyntheticBuildingMesh();
      const facades = LandmarkBearingGatedMatcher.extractFacadePlanes(mesh);
      expect(facades.length).toBe(4);

      const eastFacade = facades.find(f => f.name === 'East_Facade');
      expect(eastFacade).toBeDefined();
      expect(eastFacade!.normal[0]).toBe(1); // Outward +X

      const corners = LandmarkBearingGatedMatcher.extractExteriorCorners(mesh);
      expect(corners.length).toBe(4);

      const neCorner = corners.find(c => c.id === 'Corner_NorthEast');
      expect(neCorner).toBeDefined();
      expect(neCorner!.position[0]).toBeGreaterThan(10); // +X (East)
      expect(neCorner!.position[2]).toBeLessThan(0);     // -Z (North)
      expect(neCorner!.position[1]).toBeGreaterThan(50); // High Y (roof/turret)
    });

    it('gates viewing quadrant bounds to the northeast exterior for camera at Grand Army Plaza (heading -29°)', () => {
      const mesh = buildSyntheticBuildingMesh();
      const bounds = LandmarkBearingGatedMatcher.resolveQuadrantBounds(mesh, {
        headingHintDeg: -29.0
      });

      expect(bounds.quadrant).toBe('NE');
      expect(bounds.primaryCorner).not.toBeNull();
      expect(bounds.primaryCorner!.id).toBe('Corner_NorthEast');
      // Camera X position bounds must be strictly East (+X) of facade
      expect(bounds.cameraPositionBounds.minX).toBeGreaterThanOrEqual(20.0);
      expect(bounds.cameraPositionBounds.maxX).toBeGreaterThan(bounds.cameraPositionBounds.minX);
      // Validates rejection of interior central pediment
      expect(bounds.rejectedFeaturesDescription[0]).toContain('Central_Mansard_Pediment');
    });
  });

  // =========================================================================
  // 3. MultiModalCameraPoseOptimizer Tests
  // =========================================================================
  describe('3. MultiModalCameraPoseOptimizer', () => {
    const mesh: RenderMesh3D = {
      vertices: new Float32Array([
        20, 0, -20, 20, 0, 20, 20, 60, 20,
        20, 60, 20, 20, 60, -20, 20, 0, -20
      ]),
      indices: new Uint32Array([0, 1, 2, 3, 4, 5])
    };
    const quadrantBounds = LandmarkBearingGatedMatcher.resolveQuadrantBounds(mesh, { headingHintDeg: -29.0 });

    const syntheticQueryField: SobelEdgeField = {
      width: 64,
      height: 64,
      magnitudes: new Float32Array(64 * 64).fill(1.0),
      gradX: new Float32Array(64 * 64).fill(1.0),
      gradY: new Float32Array(64 * 64).fill(0.0),
      meanMagnitude: 1.0
    };

    const renderMock = (pose: CameraPose6DOF): SobelEdgeField => ({
      width: 64,
      height: 64,
      magnitudes: new Float32Array(64 * 64).fill(1.0),
      gradX: new Float32Array(64 * 64).fill(1.0),
      gradY: new Float32Array(64 * 64).fill(0.0),
      meanMagnitude: 1.0
    });

    it('penalizes downward pitch and roof exposure when looking upward, breaking the central pediment local minimum', () => {
      // False minimum: camera elevated at 70m looking down at 69m (dy = -1.0)
      const falseMinPose: CameraPose6DOF = {
        x: 54.0, y: 70.0, z: -1.0,
        targetX: 29.5, targetY: 69.0, targetZ: 5.0,
        fov: 40.0
      };

      // True upward pose: camera at eye-level 53m looking up at 62.6m (dy = +9.6)
      const trueUpwardPose: CameraPose6DOF = {
        x: 54.0, y: 53.0, z: -1.0,
        targetX: 29.5, targetY: 62.6, targetZ: 5.0,
        fov: 40.0
      };

      const vpResult = VanishingPointHorizonEstimator.estimatePitchFromVerticalLines([
        { x1: 600, y1: 950, x2: 828, y2: 450 },
        { x1: 1320, y1: 950, x2: 1092, y2: 450 }
      ]);

      const evalFalseMin = MultiModalCameraPoseOptimizer.computePoseLoss(
        falseMinPose,
        syntheticQueryField,
        renderMock,
        vpResult,
        quadrantBounds
      );

      const evalTrueUpward = MultiModalCameraPoseOptimizer.computePoseLoss(
        trueUpwardPose,
        syntheticQueryField,
        renderMock,
        vpResult,
        quadrantBounds
      );

      // Total loss for false minimum must be significantly higher due to VP and normal penalties
      expect(evalFalseMin.totalLoss).toBeGreaterThan(evalTrueUpward.totalLoss);
      expect(evalFalseMin.normalLoss).toBeGreaterThan(5.0); // Severe normal penalty for looking down
      expect(evalTrueUpward.normalLoss).toBe(0.0);           // Zero normal penalty for valid upward look
    });

    it('recovers true upward pose from multi-hypothesis global search', () => {
      const vpResult = VanishingPointHorizonEstimator.estimatePitchFromVerticalLines([
        { x1: 600, y1: 950, x2: 828, y2: 450 },
        { x1: 1320, y1: 950, x2: 1092, y2: 450 }
      ]);

      const optResult = MultiModalCameraPoseOptimizer.optimizeGlobalPose(
        syntheticQueryField,
        renderMock,
        vpResult,
        quadrantBounds,
        {
          gridStepsX: 3,
          gridStepsY: 3,
          gridStepsZ: 2,
          refinementIters: 5
        }
      );

      expect(optResult.converged).toBe(true);
      expect(optResult.bestPose.x).toBeGreaterThanOrEqual(quadrantBounds.cameraPositionBounds.minX);
      expect(optResult.normalPenalty).toBe(0.0); // Converged on a valid upward look
    });
  });

  // =========================================================================
  // 4. DynamicVideoTrajectorySolver Tests
  // =========================================================================
  describe('4. DynamicVideoTrajectorySolver', () => {
    it('synthesizes a smooth C2 continuous trajectory connecting Frame 0 upward look to Final Frame nadir look', () => {
      const startPose: TrajectoryBoundaryPose = {
        timeSec: 0.0,
        position: [54.0, 53.0, -1.0],
        target: [29.5, 62.6, 5.0],
        fov: 40.0
      };

      const finalPose: TrajectoryBoundaryPose = {
        timeSec: 12.0,
        position: [41.5, 8.5, 23.0],
        target: [41.5, 0.0, 23.0],
        fov: 55.0
      };

      const trajectory = DynamicVideoTrajectorySolver.synthesizeTrajectory(
        startPose,
        finalPose,
        { durationSec: 12.0, totalFrames: 360, fps: 30.0 }
      );

      expect(trajectory.frames.length).toBe(360);
      expect(trajectory.durationSec).toBe(12.0);
      expect(trajectory.fps).toBe(30.0);

      // Frame 0 exact boundary checks
      const frame0 = trajectory.frames[0];
      expect(frame0.frame).toBe(0);
      expect(frame0.position[1]).toBeCloseTo(53.0, 2);
      expect(frame0.fov).toBeCloseTo(40.0, 1);

      // Final frame boundary checks
      const frameLast = trajectory.frames[359];
      expect(frameLast.frame).toBe(359);
      expect(frameLast.position[1]).toBeCloseTo(8.5, 1);
      expect(frameLast.fov).toBeCloseTo(55.0, 1);

      // Monotonic descent check
      expect(frame0.position[1]).toBeGreaterThan(frameLast.position[1]);

      // Verify intermediate milestone continuity (Frame 180 ~ midpoint)
      const frameMid = trajectory.frames[180];
      expect(frameMid.position[1]).toBeLessThan(frame0.position[1]);
      expect(frameMid.position[1]).toBeGreaterThan(frameLast.position[1]);
    });
  });

  // =========================================================================
  // 5. GeoCameraMatchmovePipelineService Integration
  // =========================================================================
  describe('5. GeoCameraMatchmovePipelineService End-to-End Integration', () => {
    const pipelineService = new GeoCameraMatchmovePipelineService();

    it('generates crane descent anchors with authentic upward tilt when startPitchDeg is positive', () => {
      const anchors = pipelineService.generateCraneDescentAnchors(
        12.0,
        -29.0,
        70.0,
        8.5,
        25,
        14.0, // Upward pitch
        53.0  // Eye-level altitude
      );

      expect(anchors.length).toBe(25);
      const startAnchor = anchors[0];
      expect(startAnchor.timeSec).toBe(0.0);
      expect(startAnchor.position[1]).toBe(53.0);
      expect(startAnchor.target[1]).toBeGreaterThan(53.0); // Looking UP!
      expect(startAnchor.tiltFraction).toBeLessThan(0.0);  // Negative tilt indicates upward orientation

      const lastAnchor = anchors[24];
      expect(lastAnchor.timeSec).toBe(12.0);
      expect(lastAnchor.position[1]).toBe(8.5);
      expect(lastAnchor.target[1]).toBe(0.0);
      expect(lastAnchor.tiltFraction).toBe(1.0);
    });

    it('solves precision trajectory with upward Frame 0 orientation when startPitchDeg option is passed', () => {
      const metadata = {
        width: 1920,
        height: 1080,
        fps: 30,
        totalFrames: 360,
        durationSec: 12.0
      };

      const geoAnchor = {
        name: 'The Plaza Hotel',
        targetCoords: { lat: 40.764500, lng: -73.974400, altitudeMeters: 18.0 },
        vantageCoords: { lat: 40.764800, lng: -73.974000, altitudeMeters: 82.0 },
        groundElevation: 18.0,
        standoffDistanceMeters: 75.0,
        headingDeg: -29.0,
        pitchDeg: 14.0
      };

      const solution = pipelineService.solvePrecisionTrajectory(
        metadata,
        geoAnchor,
        'crane-descent-to-nadir',
        -29.0,
        {
          startPitchDeg: 14.0,
          startAltitudeMeters: 53.0
        }
      );

      expect(solution.pathData.frames.length).toBe(360);
      expect(solution.solveTrack.frames.length).toBe(25);

      // Frame 0 forward vector check
      const frame0Solve = solution.solveTrack.frames[0];
      const { forward } = GeoCameraMatchmovePipelineService.quaternionToVectors(frame0Solve.rotationQuaternion);
      
      // forward.y must be positive (looking UPWARD at the turret!)
      expect(forward[1]).toBeGreaterThan(0.05);
      expect(frame0Solve.position[1]).toBeCloseTo(53.0, 1);

      // Frame 24 (final frame) forward vector check (nadir straight down)
      const frameLastSolve = solution.solveTrack.frames[24];
      const forwardLast = GeoCameraMatchmovePipelineService.quaternionToVectors(frameLastSolve.rotationQuaternion).forward;
      expect(forwardLast[1]).toBeLessThan(-0.95); // Looking almost straight down -Y
    });
  });
});
