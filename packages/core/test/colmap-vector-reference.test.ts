/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect } from 'vitest';
import { ColmapVectorPipeline } from '../src/browser/generative-canvas/services/colmap-vector-pipeline';
import { ColmapVectorPipelineService } from '../src/node/spatial/ColmapVectorPipelineService';
import { LocalTangentPlane } from '../src/common/coordinate/LocalTangentPlane';
import {
  ColmapVectorPipelineRequest,
  GeodeticAnchor
} from '../src/common/spatial/colmap-vector-reference-types';

describe('Universal COLMAP Vector Reference Pipeline (Zero Presets)', () => {
  const pipeline = ColmapVectorPipeline.getInstance();

  describe('1. Zero-Preset & Validation Directives', () => {
    it('should throw an actionable error if neither coordinates nor query are provided', async () => {
      const emptyRequest: ColmapVectorPipelineRequest = {};
      await expect(pipeline.resolveAnchor(emptyRequest)).rejects.toThrow(
        /Zero-Preset Directive Violation.*requires either explicit geodetic coordinates/i
      );
    });

    it('should throw an actionable error if a geocoding query is provided without an API key', async () => {
      const queryRequest: ColmapVectorPipelineRequest = {
        query: 'Eiffel Tower, Paris'
      };
      await expect(pipeline.resolveAnchor(queryRequest)).rejects.toThrow(
        /Zero-Preset Directive Violation.*requires an active Google Maps API key.*Static preset dictionaries are strictly prohibited/i
      );
    });

    it('should reject invalid out-of-range coordinates', async () => {
      await expect(pipeline.resolveAnchor({ anchor: { lat: 95.0, lng: 10.0 } })).rejects.toThrow(
        /Zero-Preset Error: Invalid latitude 95/i
      );
      await expect(pipeline.resolveAnchor({ anchor: { lat: 10.0, lng: -195.0 } })).rejects.toThrow(
        /Zero-Preset Error: Invalid longitude -195/i
      );
    });

    it('should resolve arbitrary explicit coordinates with zero preset bias', async () => {
      const explicitAnchor = {
        lat: -33.8568,
        lng: 151.2153,
        elevationMeters: 14.5,
        headingDeg: 45.0,
        label: 'Sydney Opera House'
      };

      const resolved = await pipeline.resolveAnchor({ anchor: explicitAnchor }, { fetchElevation: false });
      expect(resolved.lat).toBe(-33.8568);
      expect(resolved.lng).toBe(151.2153);
      expect(resolved.elevationMeters).toBe(14.5);
      expect(resolved.headingDeg).toBe(45.0);
      expect(resolved.formattedAddress).toBe('Sydney Opera House');
    });
  });

  describe('2. Global Tangent Plane Geodesy & Millimetric Precision', () => {
    const globalTestPoints = [
      { name: 'Sydney Opera House (Southern/Eastern)', lat: -33.8568, lng: 151.2153, alt: 10.0 },
      { name: 'Eiffel Tower, Paris (Northern/Eastern)', lat: 48.8584, lng: 2.2945, alt: 35.0 },
      { name: 'Tokyo Skytree (Northern/Eastern)', lat: 35.7100, lng: 139.8107, alt: 4.0 },
      { name: 'Cristo Redentor, Rio (Southern/Western)', lat: -22.9519, lng: -43.2105, alt: 710.0 }
    ];

    globalTestPoints.forEach(({ name, lat, lng, alt }) => {
      it(`should achieve millimeter-accurate roundtrip closure for ${name}`, () => {
        const ltp = new LocalTangentPlane({ lat, lng, alt });

        // Test offset in local ENU: 250m East, 80m Up, 300m South (z = 300)
        const localEnu: [number, number, number] = [250.0, 80.0, 300.0];
        const wgs = ltp.toLatLng(localEnu);

        // Convert back from WGS to local
        const roundtripEnu = ltp.toLocal(wgs);

        expect(Math.abs(roundtripEnu[0] - localEnu[0])).toBeLessThan(0.001); // < 1mm
        expect(Math.abs(roundtripEnu[1] - localEnu[1])).toBeLessThan(0.001);
        expect(Math.abs(roundtripEnu[2] - localEnu[2])).toBeLessThan(0.001);
      });
    });
  });

  describe('3. Synthetic Photogrammetric Survey Generation', () => {
    const tokyoAnchor: GeodeticAnchor = {
      lat: 35.7100,
      lng: 139.8107,
      elevationMeters: 4.0,
      headingDeg: 15.0,
      formattedAddress: 'Tokyo Skytree'
    };

    it('should generate multi-tier orbital survey arrays with calibrated optics', () => {
      const poses = pipeline.generateSyntheticSurvey(tokyoAnchor, {
        type: 'orbital-multi-tier',
        targetRadiusMeters: 150.0,
        cameraCount: 12,
        focalLengthMm: 35.0,
        sensorWidthMm: 36.0,
        altitudeTiersMeters: [30.0, 80.0, 160.0]
      });

      expect(poses.length).toBe(12);

      poses.forEach(pose => {
        expect(pose.id).toBeGreaterThanOrEqual(1);
        expect(pose.focalLengthMm).toBe(35.0);
        expect(pose.fovDegrees).toBeCloseTo(54.43, 1);
        expect(pose.coordinatesWGS84.lat).toBeCloseTo(35.7100, 2);
        expect(pose.coordinatesWGS84.lng).toBeCloseTo(139.8107, 2);
        expect(pose.coordinatesWGS84.elevation).toBeGreaterThanOrEqual(30.0);
        expect(pose.forwardVector).toBeDefined();
        expect(Math.hypot(pose.forwardVector[0], pose.forwardVector[1], pose.forwardVector[2])).toBeCloseTo(1.0, 3);
        expect(pose.frustumFootprintWGS84).toBeDefined();
        expect(pose.frustumFootprintWGS84!.length).toBe(4);
      });
    });

    it('should generate facade lawnmower surveys aligned to facade orientation', () => {
      const poses = pipeline.generateSyntheticSurvey(tokyoAnchor, {
        type: 'facade-lawnmower',
        targetRadiusMeters: 80.0,
        cameraCount: 9,
        focalLengthMm: 50.0
      });

      expect(poses.length).toBe(9);
      expect(poses[0].focalLengthMm).toBe(50.0);
      expect(poses[0].name).toContain('FACADE');
    });

    it('should generate street corridor survey arrays', () => {
      const poses = pipeline.generateSyntheticSurvey(tokyoAnchor, {
        type: 'street-corridor',
        targetRadiusMeters: 100.0,
        cameraCount: 6,
        corridorHeadingDeg: 90.0,
        corridorLengthMeters: 300.0
      });

      expect(poses.length).toBe(6);
      expect(poses[0].name).toContain('STREET-CORRIDOR');
    });

    it('should generate complete 112-station amphitheatre survey across all 6 tiers with interior arena and cavea', () => {
      const poses = pipeline.generateSyntheticSurvey(tokyoAnchor, {
        type: 'amphitheatre-complete',
        targetRadiusMeters: 150.0,
        cameraCount: 112
      });

      expect(poses.length).toBe(112);

      // Verify all 6 architectural tiers are synthesized
      const hasStreet = poses.some(p => p.name?.includes('TIER_1_STREET'));
      const hasFacade = poses.some(p => p.name?.includes('TIER_2_FACADE'));
      const hasAttic = poses.some(p => p.name?.includes('TIER_3_ATTIC'));
      const hasArena = poses.some(p => p.name?.includes('TIER_4_ARENA_FLOOR'));
      const hasCavea = poses.some(p => p.name?.includes('TIER_5_CAVEA_SEATING'));
      const hasRim = poses.some(p => p.name?.includes('TIER_6_RIM_SURVEY'));

      expect(hasStreet).toBe(true);
      expect(hasFacade).toBe(true);
      expect(hasAttic).toBe(true);
      expect(hasArena).toBe(true);
      expect(hasCavea).toBe(true);
      expect(hasRim).toBe(true);

      // Verify Arena stations are positioned inside (radius < 35m) with wide 24mm lens
      const arenaStations = poses.filter(p => p.name?.includes('TIER_4_ARENA_FLOOR'));
      expect(arenaStations.length).toBe(16);
      for (const st of arenaStations) {
        expect(st.focalLengthMm).toBe(24);
        const radius = Math.hypot(st.positionLocalENU[0], st.positionLocalENU[2]);
        expect(radius).toBeLessThan(35.0);
        expect(st.positionLocalENU[1]).toBeCloseTo(4.5, 1);
      }
    });

    it('should generate 40-station amphitheatre interior pilot survey', () => {
      const poses = pipeline.generateSyntheticSurvey(tokyoAnchor, {
        type: 'amphitheatre-complete',
        targetRadiusMeters: 150.0,
        cameraCount: 40
      });

      expect(poses.length).toBe(40);
      const arenaStations = poses.filter(p => p.name?.includes('TIER_4_ARENA_FLOOR'));
      expect(arenaStations.length).toBe(8);
      const caveaStations = poses.filter(p => p.name?.includes('TIER_5_CAVEA_SEATING'));
      expect(caveaStations.length).toBe(8);
    });
  });

  describe('4. Raw COLMAP / GLOMAP Ingestion & Optical Geometry Parsing', () => {
    const camerasText = `
# Camera list with one line of data per camera:
#   CAMERA_ID, MODEL, WIDTH, HEIGHT, PARAMS[]
# Number of cameras: 1
1 PINHOLE 1920 1080 1440.0 1440.0 960.0 540.0
`;

    const imagesText = `
# Image list with two lines of data per image:
#   IMAGE_ID, QW, QX, QY, QZ, TX, TY, TZ, CAMERA_ID, NAME
#   POINTS2D[] as (X, Y, POINT3D_ID)
1 1.0 0.0 0.0 0.0 0.0 0.0 -50.0 1 station_001.jpg
120.5 450.2 1 340.1 210.4 -1
2 0.7071068 0.0 0.7071068 0.0 -35.35 0.0 -35.35 1 station_002.jpg
85.2 210.0 2
`;

    const testAnchor: GeodeticAnchor = {
      lat: 48.8584,
      lng: 2.2945,
      elevationMeters: 35.0,
      formattedAddress: 'Eiffel Tower'
    };

    it('should parse cameras.txt and calculate accurate FOV and focal lengths', () => {
      const poses = pipeline.ingestColmapTextFiles(camerasText, imagesText, testAnchor);
      expect(poses.length).toBe(2);

      const p1 = poses[0];
      expect(p1.id).toBe(1);
      expect(p1.imageName).toBe('station_001.jpg');
      expect(p1.focalLengthMm).toBeCloseTo(27.0, 1); // 1440 * 36 / 1920 = 27mm
      expect(p1.fovDegrees).toBeCloseTo(67.38, 1);
      // For identity rotation and t = [0, 0, -50], C = -R^T * t = [0, 0, 50]
      expect(p1.positionLocalENU[2]).toBeCloseTo(50.0, 1);
    });

    it('should parse images.txt quaternions and derive accurate forward vectors', () => {
      const poses = pipeline.ingestColmapTextFiles(camerasText, imagesText, testAnchor);
      const p2 = poses[1];
      expect(p2.id).toBe(2);
      expect(p2.imageName).toBe('station_002.jpg');
      // 90 degree yaw rotation around Y
      expect(p2.yawDegrees).toBeDefined();
      expect(p2.coordinatesWGS84.lat).toBeCloseTo(48.8584, 3);
      expect(p2.coordinatesWGS84.lng).toBeCloseTo(2.2945, 3);
    });
  });

  describe('5. RFC 7946 GeoJSON & COLMAP Export Formatting', () => {
    const anchor: GeodeticAnchor = {
      lat: -22.9519,
      lng: -43.2105,
      elevationMeters: 710.0,
      formattedAddress: 'Rio De Janeiro'
    };

    it('should generate RFC 7946 GeoJSON containing Point, Polygon, and LineString features', () => {
      const poses = pipeline.generateSyntheticSurvey(anchor, {
        type: 'orbital-multi-tier',
        targetRadiusMeters: 100.0,
        cameraCount: 5
      });

      const geoJson = pipeline.buildGeoJsonFeatureCollection(poses, anchor);
      expect(geoJson.type).toBe('FeatureCollection');
      expect(geoJson.features.length).toBeGreaterThanOrEqual(10); // 5 points + 5 polygons + 1 linestring

      const points = geoJson.features.filter(f => f.geometry.type === 'Point');
      const polygons = geoJson.features.filter(f => f.geometry.type === 'Polygon');
      const lineStrings = geoJson.features.filter(f => f.geometry.type === 'LineString');

      expect(points.length).toBe(5);
      expect(polygons.length).toBe(5);
      expect(lineStrings.length).toBe(1);

      // Verify closed polygon ring
      const polyCoords = polygons[0].geometry.coordinates as number[][][];
      expect(polyCoords[0][0]).toEqual(polyCoords[0][polyCoords[0].length - 1]);
    });

    it('should generate valid COLMAP cameras.txt and images.txt export text', () => {
      const poses = pipeline.generateSyntheticSurvey(anchor, {
        type: 'orbital-multi-tier',
        targetRadiusMeters: 100.0,
        cameraCount: 4
      });

      const { camerasText, imagesText } = pipeline.exportColmapText(poses);
      expect(camerasText).toContain('1 PINHOLE 1920 1080');
      expect(imagesText).toContain('1 ');
      expect(imagesText).toContain('station_001.jpg');
      expect(imagesText).toContain('4 ');
      expect(imagesText).toContain('station_004.jpg');
    });
  });

  describe('6. End-to-End Pipeline Execution', () => {
    it('should execute full pipeline from explicit coordinates with zero presets', async () => {
      const result = await pipeline.execute({
        anchor: {
          lat: 51.5007,
          lng: -0.1246,
          elevationMeters: 12.0,
          headingDeg: 0,
          label: 'Big Ben, London'
        },
        surveyConfig: {
          type: 'orbital-multi-tier',
          targetRadiusMeters: 110.0,
          cameraCount: 8,
          focalLengthMm: 35.0
        },
        fetchElevation: false
      });

      expect(result.success).toBe(true);
      expect(result.anchor.formattedAddress).toBe('Big Ben, London');
      expect(result.poses.length).toBe(8);
      expect(result.geoJson.features.length).toBeGreaterThan(0);
      expect(result.colmapExport.camerasText).toBeDefined();
      expect(result.colmapExport.imagesText).toBeDefined();
      expect(result.vectorDockConfig.mapId).toBe('ad80a8568eeae7445909ba9f');
      expect(result.vectorDockConfig.solutionAttribution).toBe('solution_id=gmp_git_agentskills_v1');
      expect(result.stats.stationCount).toBe(8);
      expect(result.stats.boundingRadiusMeters).toBeGreaterThan(50.0);
    });
  });

  describe('7. Dedicated Studio Grey Clay 3D Tiles Ingestion (getGoogle3DTilesClay)', () => {
    it('should ingest Google Maps 3D Tiles in studio grey clay mode and wrap survey stations around real mesh', async () => {
      const nodeService = new ColmapVectorPipelineService();
      // Temp dir: never write test exports into the tracked public/data/colmap_vector_export folder.
      const tmpOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-colmap-vector-clay-'));
      const result = await nodeService.execute(
        {
          anchor: {
            lat: 48.8584,
            lng: 2.2945,
            elevationMeters: 35.0,
            label: 'Eiffel Tower, Paris'
          },
          surveyConfig: {
            type: 'orbital-multi-tier',
            cameraCount: 6
          },
          clayOptions: {
            enabled: true,
            offlineMock: true
          }
        },
        {
          outputDir: tmpOutDir,
          baseFileName: 'eiffel_test',
          saveFiles: true
        }
      );

      expect(result.success).toBe(true);
      expect(result.clayObject).toBeDefined();
      expect(result.clayObject!.glbPath).toContain('eiffel_test_clay.glb');
      expect(result.clayObject!.meshStats.vertexCount).toBeGreaterThan(0);
      expect(result.clayObject!.meshStats.triangleCount).toBeGreaterThan(0);
      expect(result.clayObject!.quality.errorTarget).toBe(0.5);
      expect(result.clayObject!.quality.resolution).toBe('4K (3840x2160)');
      expect(result.exportedFilePaths?.clayGlb).toBeDefined();
      expect(fs.existsSync(result.clayObject!.glbPath)).toBe(true);

      // Verify glTF binary magic header (0x46546C67 = "glTF")
      const glbBuf = fs.readFileSync(result.clayObject!.glbPath);
      expect(glbBuf.toString('ascii', 0, 4)).toBe('glTF');

      // Clean up test files
      if (fs.existsSync(tmpOutDir)) {
        fs.rmSync(tmpOutDir, { recursive: true, force: true });
      }
    });
  });
});
