/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import {
  CameraRelativeRTC,
  WGS84_SEMI_MAJOR_AXIS_A,
  WGS84_FLATTENING_F
} from '../src/common/coordinate/CameraRelativeRTC';
import type { SpatialGeodeticAnchor } from '../src/common/spatial/spatial-generative-protocol';
import { SpatialAffordanceExtractor } from '../src/browser/generative-canvas/services/spatial/SpatialAffordanceExtractor';
import { SoftZDepthInterleaver } from '../src/browser/generative-canvas/services/spatial/SoftZDepthInterleaver';
import { RadiometricSolarHarmonizer } from '../src/browser/generative-canvas/services/spatial/RadiometricSolarHarmonizer';
import {
  DualPayloadOctreeStreamer,
  type DualPayloadNode
} from '../src/browser/generative-canvas/services/spatial/DualPayloadOctreeStreamer';
import { SpatialGenerativeRuntime } from '../src/browser/generative-canvas/services/spatial/SpatialGenerativeRuntime';

describe('Spatial Generative Runtime & Engine (Proprietary Competitor)', () => {
  // Landmark: San Francisco Ferry Building
  const SF_FERRY_BUILDING: SpatialGeodeticAnchor = {
    latitude: 37.7955,
    longitude: -122.3937,
    altitudeMsl: 4.5
  };

  // Landmark: Transamerica Pyramid (nearby)
  const SF_TRANSAMERICA: SpatialGeodeticAnchor = {
    latitude: 37.7952,
    longitude: -122.4028,
    altitudeMsl: 10.0
  };

  describe('Moat 1: Camera-Relative RTC Double-Precision Math Engine', () => {
    it('should compute exact WGS-84 to ECEF and round-trip with sub-millimeter precision', () => {
      const ecef = CameraRelativeRTC.geodeticToEcef(
        SF_FERRY_BUILDING.latitude,
        SF_FERRY_BUILDING.longitude,
        SF_FERRY_BUILDING.altitudeMsl
      );

      expect(ecef[0]).toBeTypeOf('number');
      expect(ecef[1]).toBeTypeOf('number');
      expect(ecef[2]).toBeTypeOf('number');

      // Round-trip back to geodetic via Bowring's closed-form algorithm
      const roundTrip = CameraRelativeRTC.ecefToGeodetic(ecef[0], ecef[1], ecef[2]);

      expect(roundTrip.latitude).toBeCloseTo(SF_FERRY_BUILDING.latitude, 7);
      expect(roundTrip.longitude).toBeCloseTo(SF_FERRY_BUILDING.longitude, 7);
      expect(roundTrip.altitudeMsl).toBeCloseTo(SF_FERRY_BUILDING.altitudeMsl, 3); // within 1 mm
    });

    it('should compute local camera-relative Three.js coordinates (+X East, +Y Up, -Z North)', () => {
      const rtc = new CameraRelativeRTC(SF_FERRY_BUILDING);
      rtc.setCameraPositionGeodetic(SF_FERRY_BUILDING);

      // Ferry building relative to itself should be at origin
      const originRel = rtc.geodeticToCameraRelativeThree(SF_FERRY_BUILDING);
      expect(originRel[0]).toBeCloseTo(0, 3);
      expect(originRel[1]).toBeCloseTo(0, 3);
      expect(originRel[2]).toBeCloseTo(0, 3);

      // Transamerica Pyramid is West of Ferry Building (so East is negative, X < 0)
      const transRel = rtc.geodeticToCameraRelativeThree(SF_TRANSAMERICA);
      expect(transRel[0]).toBeLessThan(0); // West = negative East (+X)
      expect(transRel[1]).toBeGreaterThan(0); // Higher elevation (10m vs 4.5m)
    });

    it('should accurately split float64 into high and low float32 components for GPU shaders', () => {
      const value = -2706503.456789;
      const [high, low] = CameraRelativeRTC.splitFloat32(value);

      // Reconstructed sum must match original to within double precision
      const reconstructed = high + low;
      expect(Math.abs(reconstructed - value)).toBeLessThan(1e-6);

      const vecSplit = CameraRelativeRTC.splitVec3Float32(1234567.89, -987654.32, 555555.55);
      expect(vecSplit.high[0] + vecSplit.low[0]).toBeCloseTo(1234567.89, 4);
      expect(vecSplit.high[1] + vecSplit.low[1]).toBeCloseTo(-987654.32, 4);
      expect(vecSplit.high[2] + vecSplit.low[2]).toBeCloseTo(555555.55, 4);
    });

    it('should compute Tait-Bryan orientation matrix for Heading, Pitch, and Roll', () => {
      // 90 degrees heading (East)
      const matrix90 = CameraRelativeRTC.computeOrientationMatrix(90, 0, 0);
      expect(matrix90.length).toBe(16);
      expect(matrix90[15]).toBe(1); // Homogeneous 4x4
    });
  });

  describe('Moat 2: Affordance-Aware Geospatial Anchors & AI Conditioning', () => {
    it('should extract physical affordances and authentic NOAA solar ephemeris', () => {
      const summerSolsticeNoon = new Date('2026-06-21T19:00:00Z'); // ~12:00 PM Pacific Daylight Time
      const affordance = SpatialAffordanceExtractor.extractAffordance({
        anchor: SF_FERRY_BUILDING,
        targetDate: summerSolsticeNoon,
        searchRadiusMeters: 40
      });

      expect(affordance.anchor.latitude).toBe(SF_FERRY_BUILDING.latitude);
      expect(affordance.solarElevationDeg).toBeGreaterThan(60); // High summer sun
      expect(affordance.solarVector[1]).toBeGreaterThan(0.8); // Direct downward illumination (+Y Up)
      expect(affordance.boundingEnvelope.dimensions[0]).toBe(40);
      expect(affordance.recommendedStandoffMeters).toBeGreaterThanOrEqual(15);
    });

    it('should build structured generative prompt directives for AI models', () => {
      const summerDate = new Date('2026-06-21T19:00:00Z');
      const affordance = SpatialAffordanceExtractor.extractAffordance({
        anchor: SF_FERRY_BUILDING,
        targetDate: summerDate
      });

      const conditioning = SpatialAffordanceExtractor.buildGenerativeSpatialConditioning(
        affordance,
        'Futuristic kinetic pavilion with solar canopy',
        '16:9'
      );

      expect(conditioning.promptDirectives).toContain('Futuristic kinetic pavilion with solar canopy');
      expect(conditioning.promptDirectives).toContain('16:9');
      expect(conditioning.promptDirectives).toContain('Subject distance:');
      expect(conditioning.spatialContextSummary).toContain('latitude 37.795500');
      expect(conditioning.normalizedBbox.widthMeters).toBeGreaterThan(0);
    });
  });

  describe('Moat 3: Soft-Z Depth Interleaver & Peeling', () => {
    it('should analytically compute continuous smooth Soft-Z depth factor without clipping discontinuities', () => {
      const epsilon = 0.1; // 10 cm softness band
      const tileDepth = 10.0;

      // Case A: Splat is well behind tile geometry (occluded) -> factor 0.0
      const behindFactor = SoftZDepthInterleaver.evaluateSoftZFactor(tileDepth, 10.2, epsilon);
      expect(behindFactor).toBe(0.0);

      // Case B: Splat is exactly on tile surface -> factor 0.5
      const surfaceFactor = SoftZDepthInterleaver.evaluateSoftZFactor(tileDepth, 10.0, epsilon);
      expect(surfaceFactor).toBeCloseTo(0.5, 4);

      // Case C: Splat is well in front of tile geometry -> factor 1.0
      const frontFactor = SoftZDepthInterleaver.evaluateSoftZFactor(tileDepth, 9.8, epsilon);
      expect(frontFactor).toBe(1.0);

      // Monotonic continuity across [-epsilon, +epsilon]
      const step1 = SoftZDepthInterleaver.evaluateSoftZFactor(tileDepth, 10.05, epsilon); // 0.25
      const step2 = SoftZDepthInterleaver.evaluateSoftZFactor(tileDepth, 9.95, epsilon);  // 0.75
      expect(step1).toBeCloseTo(0.25, 4);
      expect(step2).toBeCloseTo(0.75, 4);
      expect(step1).toBeLessThan(surfaceFactor);
      expect(surfaceFactor).toBeLessThan(step2);
    });

    it('should inject Soft-Z shader uniforms and defines into custom materials', () => {
      // Mock minimal renderer
      const mockRenderer = {
        getRenderTarget: () => null,
        setRenderTarget: () => {},
        clear: () => {},
        render: () => {},
        autoClear: true
      } as unknown as THREE.WebGLRenderer;

      const interleaver = new SoftZDepthInterleaver({
        renderer: mockRenderer,
        width: 800,
        height: 600,
        defaultEpsilonMeters: 0.08
      });

      expect(interleaver.getEpsilonMeters()).toBe(0.08);

      const mat = new THREE.ShaderMaterial({
        vertexShader: 'void main() { gl_Position = vec4(0.0); }',
        fragmentShader: 'void main() { gl_FragColor = vec4(1.0); }'
      });

      const camera = new THREE.PerspectiveCamera(60, 1.33, 0.5, 500);
      interleaver.injectSoftZUniforms(mat, camera, 0.05);

      expect(mat.defines?.USE_SOFT_Z).toBe(1);
      expect(mat.uniforms.uNear.value).toBe(0.5);
      expect(mat.uniforms.uFar.value).toBe(500);
      expect(mat.uniforms.uSoftDepthEpsilon.value).toBe(0.05);

      interleaver.dispose();
    });
  });

  describe('Moat 4: Radiometric Solar De-lighting Harmonizer', () => {
    it('should classify diurnal lighting phases and interpolate Planckian blackbody temperatures', () => {
      expect(RadiometricSolarHarmonizer.classifyDiurnalPhase(-20)).toBe('astronomical_night');
      expect(RadiometricSolarHarmonizer.classifyDiurnalPhase(-8)).toBe('civil_twilight');
      expect(RadiometricSolarHarmonizer.classifyDiurnalPhase(5)).toBe('golden_hour');
      expect(RadiometricSolarHarmonizer.classifyDiurnalPhase(25)).toBe('morning');
      expect(RadiometricSolarHarmonizer.classifyDiurnalPhase(70)).toBe('solar_noon');

      const nightProfile = RadiometricSolarHarmonizer.getDiurnalPhotometrics(-15);
      expect(nightProfile.intensity).toBeLessThan(0.1);

      const goldenProfile = RadiometricSolarHarmonizer.getDiurnalPhotometrics(6);
      expect(goldenProfile.kelvin).toBeGreaterThanOrEqual(3000);
      expect(goldenProfile.kelvin).toBeLessThanOrEqual(4500);

      const noonProfile = RadiometricSolarHarmonizer.getDiurnalPhotometrics(70);
      expect(noonProfile.intensity).toBeGreaterThan(1.0);
      expect(noonProfile.kelvin).toBeCloseTo(6500, -2);
    });

    it('should convert Kelvin blackbody temperatures to authentic linear RGB colors', () => {
      const warmGolden = RadiometricSolarHarmonizer.kelvinToRGB(3200);
      expect(warmGolden.r).toBeGreaterThan(warmGolden.b); // Warm has higher red than blue

      const crispDaylight = RadiometricSolarHarmonizer.kelvinToRGB(6500);
      expect(crispDaylight.r).toBeCloseTo(1.0, 1);
      expect(crispDaylight.b).toBeCloseTo(1.0, 1);
    });

    it('should dynamically update Three.js sun and ambient sky lights', () => {
      const harmonizer = new RadiometricSolarHarmonizer(SF_FERRY_BUILDING);
      const scene = new THREE.Scene();
      harmonizer.attachToScene(scene);

      expect(scene.children.length).toBe(2);

      const state = harmonizer.updateLighting();
      expect(state.solarVector.length()).toBeCloseTo(1.0, 3);
      expect(state.sunIntensity).toBeGreaterThan(0);

      harmonizer.dispose();
    });
  });

  describe('Moat 5: Dual-Payload Unified Octree Streamer', () => {
    it('should calculate standard Screen-Space Error (SSE) accurately', () => {
      const geometricError = 5.0; // 5 meters
      const distance = 100.0; // 100 meters
      const fov = 60.0; // 60 degrees
      const viewportHeight = 1080; // pixels

      const sse = DualPayloadOctreeStreamer.computeScreenSpaceError(
        geometricError,
        distance,
        fov,
        viewportHeight
      );

      // Analytical verification:
      // tan(30 deg) = 0.57735
      // 5 * 1080 / (2 * 100 * 0.57735) = 5400 / 115.47 = ~46.76 pixels
      expect(sse).toBeCloseTo(46.76, 1);
    });

    it('should dynamically adapt splat budget based on frame telemetry', () => {
      const camera = new THREE.PerspectiveCamera(60, 1.77, 0.1, 1000);
      const streamer = new DualPayloadOctreeStreamer({
        camera,
        maxSplatBudget: 1000000,
        targetFrameDurationMs: 16.6
      });

      const initialBudget = streamer.getCurrentSplatBudget();
      expect(initialBudget).toBe(1000000);

      // Simulate heavy frame (30ms > 16.6ms) -> should throttle budget down
      streamer.reportFrameTelemetry(30.0);
      const throttledBudget = streamer.getCurrentSplatBudget();
      expect(throttledBudget).toBeLessThan(initialBudget);

      // Simulate fast frame (8ms < 16.6ms) -> should ramp budget back up
      streamer.reportFrameTelemetry(8.0);
      expect(streamer.getCurrentSplatBudget()).toBeGreaterThan(throttledBudget);

      streamer.dispose();
    });

    it('should refine nodes during octree traversal based on SSE', () => {
      const camera = new THREE.PerspectiveCamera(60, 1.77, 0.1, 1000);
      camera.position.set(0, 0, 50);
      camera.lookAt(0, 0, 0);
      camera.updateMatrixWorld();

      const streamer = new DualPayloadOctreeStreamer({
        camera,
        errorTarget: 2.0 // Strict target requiring refinement
      });

      const rootNode: DualPayloadNode = {
        id: 'root-0',
        boundingSphere: new THREE.Sphere(new THREE.Vector3(0, 0, 0), 20),
        geometricError: 10.0, // High error -> should refine
        splatCount: 10000,
        children: [
          {
            id: 'child-0',
            boundingSphere: new THREE.Sphere(new THREE.Vector3(-5, 0, 0), 10),
            geometricError: 0.5,
            splatCount: 5000
          },
          {
            id: 'child-1',
            boundingSphere: new THREE.Sphere(new THREE.Vector3(5, 0, 0), 10),
            geometricError: 0.5,
            splatCount: 5000
          }
        ]
      };

      streamer.addRootNode(rootNode);
      streamer.update(1080);

      expect(streamer.getVisibleSplatCount()).toBe(10000); // 2 children * 5000 splats

      streamer.dispose();
    });
  });

  describe('Master Facade: SpatialGenerativeRuntime Integration', () => {
    let runtime: SpatialGenerativeRuntime;

    beforeEach(() => {
      runtime = new SpatialGenerativeRuntime({
        originAnchor: SF_FERRY_BUILDING,
        enableSoftZCompositing: false,
        enableRadiometricHarmonization: true
      });
    });

    afterEach(() => {
      runtime.dispose();
    });

    it('should initialize scene graphs, RTC kernel, and solar harmonizer', () => {
      expect(runtime.scene).toBeDefined();
      expect(runtime.camera).toBeDefined();
      expect(runtime.tileGroup).toBeDefined();
      expect(runtime.generativeMediaGroup).toBeDefined();
      expect(runtime.rtcKernel.getOrigin().latitude).toBe(SF_FERRY_BUILDING.latitude);
    });

    it('should anchor, retrieve, and remove generative 3DGS, neural video, and mesh entities', async () => {
      // 1. Anchor a 3D Gaussian Splat
      const splatObj = await runtime.anchorGenerativeMedia({
        id: 'monument-splat-01',
        sourceType: 'gaussian-splat-spz',
        url: '/assets/splats/monument.spz',
        anchor: SF_TRANSAMERICA,
        headingPitchRollDeg: [45, 0, 0],
        scaleMeters: [2, 2, 2]
      });

      expect(splatObj).toBeDefined();
      expect(runtime.generativeMediaGroup.children.length).toBe(1);
      expect(runtime.getGenerativeMedia('monument-splat-01')?.sourceType).toBe('gaussian-splat-spz');

      // 2. Anchor a Neural Video Plate
      await runtime.anchorGenerativeMedia({
        id: 'kinetic-video-01',
        sourceType: 'neural-video-quad',
        url: '/assets/videos/hero_plate.mp4',
        anchor: SF_FERRY_BUILDING,
        offsetMeters: [0, 5, 2]
      });

      expect(runtime.getAllGenerativeMedia().length).toBe(2);

      // 3. Remove entity
      const removed = runtime.removeGenerativeMedia('monument-splat-01');
      expect(removed).toBe(true);
      expect(runtime.getAllGenerativeMedia().length).toBe(1);
      expect(runtime.getGenerativeMedia('monument-splat-01')).toBeUndefined();
    });

    it('should extract spatial affordances and generate AI prompt conditioning', () => {
      const conditioning = runtime.buildGenerativePrompt('Futuristic carbon-negative sculpture');
      expect(conditioning.promptDirectives).toContain('Futuristic carbon-negative sculpture');
      expect(conditioning.spatialContextSummary).toContain('latitude 37.795500');
    });

    it('should execute frame update loop and produce runtime telemetry metrics', () => {
      const metrics = runtime.update(performance.now() + 16.6);
      expect(metrics.fps).toBeGreaterThan(0);
      expect(metrics.cameraAltitudeMeters).toBe(50);
      expect(metrics.radiometricPhase).toBeDefined();
      expect(metrics.splatBudget).toBeGreaterThan(0);
    });
  });
});
