/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { geoidUndulation } from './egm96-geoid';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as os from 'os';
import { spawn, execFile, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import { Google3DTileCrawlerBaker } from './Google3DTileCrawlerBaker';
import { DistrictTooLargeError, GoogleTileDistrictCrawler } from './GoogleTileDistrictCrawler';
import { PhysicalCameraModel } from '../../common/optics/PhysicalCameraModel';
import { GoogleMapsService, resolveMapsApiKey, type GeocodeAlternative } from '../../browser/generative-canvas/services/google-maps-service';
import type {
  PhysicalCameraConfig,
  SensorFormatPreset
} from '../../common/optics/physical-camera-protocol';
import { LocationUnresolvedError, MissingInputError, TileExtractionError } from '../../common/errors/pipeline-errors';
import { assertUsableCoordinates, formatCoordinates, parseCoordinateText } from '../../common/coordinate/parse-coordinates';

const execFileAsync = promisify(execFile);

/** "Flatiron Building, 175 5th Ave, New York, NY 10010, USA": Google's name for the place plus its address. */
function describePlace(name: string | undefined, formattedAddress: string): string {
  if (!name || formattedAddress.toLowerCase().includes(name.toLowerCase())) return formattedAddress;
  return `${name}, ${formattedAddress}`;
}

// WGS-84 Ellipsoid constants
const WGS84_A = 6378137.0; // semi-major axis (meters)
const WGS84_F = 1.0 / 298.257223563; // flattening
const WGS84_B = WGS84_A * (1.0 - WGS84_F); // semi-minor axis (meters)
const WGS84_E2 = (WGS84_A * WGS84_A - WGS84_B * WGS84_B) / (WGS84_A * WGS84_A); // first eccentricity squared

export interface GeoAnchor {
  lat: number;
  lng: number;
  /** Metres above sea level; undefined until stated by the caller, measured by the Elevation API or from the tiles. */
  elevation?: number;
  /** Where `elevation` came from: 'explicit', 'google_elevation_api' or 'tiles_ground'. */
  elevationSource?: string;
  landmarkName?: string;
  /** Exactly what the location resolved to: Google's name and address for a place, or the coordinates. */
  formattedAddress?: string;
  /** Other distinct places Google found for the same text, when it was ambiguous (see GeocodeResult.alternatives). */
  alternatives?: GeocodeAlternative[];
}

export interface CameraPoseFrame {
  frame: number;
  timeSec: number;
  position: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
  fov: number;
  rollDeg?: number;
  // Physical Camera Optics & DoF Focus Tracking
  focalLengthMm?: number;
  apertureFStop?: number;
  focusDistanceMeters?: number;
  sensorFormat?: SensorFormatPreset | string;
  depthOfFieldNearMeters?: number;
  depthOfFieldFarMeters?: number;
}

export interface CameraPathData {
  fps: number;
  durationSec: number;
  totalFrames: number;
  frames: CameraPoseFrame[];
  origin?: GeoAnchor;
  environment?: string;
}

export type TileAtmosphereRenderMode = 'clay' | 'textured' | 'photoreal' | 'clay-hybrid' | 'grayscale' | 'blueprint' | 'greybox' | 'graybox' | 'full-texture';

export type TilePipelineMode = 'full-texture' | 'textured' | 'photoreal' | 'greybox' | 'graybox' | 'clay';

export interface TileAtmosphereConfig {
  renderMode?: TileAtmosphereRenderMode;
  clayPreset?: 'warm-clay' | 'studio-grey' | 'alabaster' | 'warm-stone' | 'blueprint-blue';
  clayColor?: string; // default '#dcd6cd'
  roughness?: number; // default 0.82
  metalness?: number; // default 0.02
  skyColor?: string; // default '#dce3eb'
  fog?: boolean;
  fogExp2Density?: number; // default 0.0022
  exposure?: number; // default 1.15
  sunLight?: {
    position?: [number, number, number]; // default [150, 320, 100]
    color?: string; // default '#fffaed'
    intensity?: number; // default 1.45
    castShadow?: boolean;
    shadowMapSize?: number; // default 2048
  };
  hemiLight?: {
    skyColor?: string; // default '#ffffff'
    groundColor?: string; // default '#94a3b8'
    intensity?: number; // default 0.85
  };
  skyFillLight?: {
    color?: string; // default '#93c5fd'
    intensity?: number; // default 0.45
    position?: [number, number, number]; // default [-150, 180, -120]
  };
}

export interface TileLodQualityConfig {
  errorTarget?: number; // Default 0.5 (maximum quality per AGENTS.md)
  resolutionWidth?: number; // Default 1280
  resolutionHeight?: number; // Default 720
  virtualSseWidth?: number; // Default 3840 for 4K SSE calculation
  virtualSseHeight?: number; // Default 2160
  stableFramesThreshold?: number; // Default 15 frames of zero downloading/parsing
  maxSettleWaitMs?: number; // Default 25000 ms per frame
}

export interface TileBlockoutOutputConfig {
  outputVideoPath?: string; // Default: 'public/videos/google_tiles_clay_blockout_camera.mp4' (<VIDEO_REF_0>)
  outputGlbPath?: string; // Default: 'public/models/google_tiles_area.glb'
  framesDir?: string; // Default: 'public/videos/frames_clay'
  firstFramePath?: string; // Default: 'public/models/blockout_first_frame.jpg'
  firstFramePngPath?: string; // Default: 'public/images/blockout_frame_00.png'
  storyboardsDir?: string; // Default: 'public/storyboards_clay'
  storyboardBeats?: number; // Default: 8
  manifestPath?: string; // Default: 'public/videos/google_tiles_blockout_manifest.json'
  fps?: number; // Default: 24
  bitrate?: string; // Default: '6M'
  compileWebm?: boolean; // Default: true
}

export interface TileCollisionConfig {
  enabled?: boolean; // Default: true
  minClearanceMeters?: number; // Default: 5.0m
  autoAdjustAltitude?: boolean; // Default: true
  skyProbeAltitude?: number; // Default: 450.0m
  smoothingWindow?: number; // Default: 8
}

export interface TileBlockoutPipelineRequest {
  address?: string; // A place name or address (resolved with Google Places), or only "lat, lng" (e.g. "40.748400, -73.985700"); text mixing both is looked up as a name
  geoAnchor?: GeoAnchor;
  geoidHeight?: number;
  cameraPath?: CameraPathData | string; // Path to json or data object; auto-generated if omitted
  mode?: TilePipelineMode; // High-level operational mode ('full-texture' | 'textured' | 'greybox' | 'clay')
  apiKey?: string;
  atmosphere?: TileAtmosphereConfig;
  lodQuality?: TileLodQualityConfig;
  collision?: TileCollisionConfig;
  output?: TileBlockoutOutputConfig;
  headlessChromePath?: string;
  ffmpegPath?: string;
  port?: number;
  /**
   * Explicit opt-in for tests only: skip Chrome/network and write clearly-marked placeholder artifacts
   * (result and manifest carry `mock: true`). Never used as an automatic fallback.
   */
  offlineMock?: boolean;
  /** Reject if headless Chrome has not uploaded its first frame within this many ms (default 35000). */
  timeoutMs?: number;
  /** Reject if the runner makes no HTTP request for this many ms at any point (default max(60s, 2x maxSettleWaitMs + 10s)). */
  inactivityTimeoutMs?: number;
  /** Hard cap on total render time before FFmpeg encoding (default scales with frame count and maxSettleWaitMs). */
  overallTimeoutMs?: number;
  atomicBuildingIntegrity?: boolean;
  enforceZeroBuildingClipping?: boolean;
  zenithAltitudeMeters?: number;
}

export interface Google3DTileMeshStats {
  name: string;
  vertexCount: number;
  triangleCount: number;
  submeshCount: number;
  boundingBox: { min: [number, number, number]; max: [number, number, number] };
  boundingSphere: { center: [number, number, number]; radius: number };
}

export interface Google3DTileQualityReport {
  source?: string;
  errorTarget: number; // <= 0.5 (Leaf LOD)
  resolution?: string;
  screenSpaceErrorResolution?: { width: number; height: number }; // 3840 x 2160 (4K)
  asynchronousSettle: boolean | {
    downloading: number;
    parsing: number;
    tilesLoaded: number;
    stableFrames: number;
  };
  preWarmedWaypoints?: number[];
  preWarmingWaypoints?: number[]; // [0, 18, 36, 54, 71]
  leafLodSettled?: boolean;
  maxSettleWaitMs?: number;
}

export interface Google3DTileRenderOutput {
  videoPath: string;
  firstFramePath: string;
  firstFramePngPath?: string;
  storyboardPaths: string[];
  manifestPath?: string;
  totalFrames?: number;
  frameCount?: number;
  fps: number;
  durationSec: number;
}

export interface Google3DTile3DObjectResult {
  success: boolean;
  mode: 'full-texture' | 'clay';
  geoAnchor: GeoAnchor;
  resolvedAddress?: string;
  glbBuffer: Buffer;
  glbPath: string;
  mesh: Google3DTileMeshStats;
  /** For a direct crawl, errorTarget is the largest geometric error (metres) among the leaf tiles in the GLB. */
  quality: Google3DTileQualityReport;
  /** Present only when frames were rendered (the offline mock); a direct tile crawl renders nothing. */
  render?: Google3DTileRenderOutput;
  manifest: Record<string, any>;
  /** True only when produced by the explicit `offlineMock` test mode (placeholder data, not real tiles). */
  mock?: boolean;
  /** Ground radius around the anchor, in metres, that was asked for (direct tile crawl only). */
  requestedRadiusMeters?: number;
  /**
   * Ground radius around the anchor, in metres, within which every selected leaf tile is in the GLB (direct tile crawl
   * only). Equals requestedRadiusMeters unless the leaf cap dropped tiles; then it is how far the kept tiles reach
   * before the nearest dropped one.
   */
  coveredRadiusMeters?: number;
  /** True when the requested radius selected more leaf tiles than the cap and the farthest ones were left out. */
  truncated?: boolean;
  /** Leaf tiles in the GLB, and leaf tiles the requested radius selected (direct tile crawl only). */
  leafTiles?: { kept: number; selected: number };
  error?: string;
  /**
   * The GLB's local frame (x east, y up, z south). Y = 0 is the street surface measured in the tiles, at
   * originEllipsoidalHeightM above the WGS84 ellipsoid, so a vertex's ellipsoid height is y + originEllipsoidalHeightM.
   */
  frame?: { lat: number; lng: number; originEllipsoidalHeightM: number; localToEcef: number[] };
  /** The leaf tiles in the GLB, by their stable ids (direct tile crawl only). */
  leafIds?: string[];
  /** Data providers of the tiles, most frequent first, as Google's attribution rules require (direct tile crawl only). */
  copyrights?: string[];
  /** When the tiles were fetched, ISO 8601 (direct tile crawl only). */
  fetchedAt?: string;
  /** The largest geometric error among the leaves in the GLB, in metres (direct tile crawl only). */
  leafGeometricErrorM?: number;
  /** The geometry-only GLB written when `geometryGlbPath` was asked for. */
  geometryGlbPath?: string;
  /** {leafId: rank}: the order the leaf downloads completed in. Varies with network timing, so it is never in a GLB. */
  downloadOrder?: Record<string, number>;
}

export interface Google3DTilesQueryOptions {
  apiKey?: string;
  radiusMeters?: number;
  cameraPath?: CameraPathData | string;
  outputDir?: string;
  outputGlbPath?: string;
  outputVideoPath?: string;
  port?: number;
  offlineMock?: boolean;
  lodQuality?: TileLodQualityConfig;
  collision?: TileCollisionConfig;
  clayPreset?: 'studio-grey' | 'warm-clay' | 'alabaster';
  fps?: number;
  atomicBuildingIntegrity?: boolean;
  enforceZeroBuildingClipping?: boolean;
  zenithAltitudeMeters?: number;
  maxLeaves?: number;
  /**
   * Also write the staged build's first layer here: the same triangles with no images, textures or UVs and one clay
   * material, with run-independent node extras (stage, provenance, build order, leaf id). Direct tile crawl only.
   */
  geometryGlbPath?: string;
  /** Injected for tests: used for the Places lookup and the tile requests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Stops the extraction (fetch3DObject): pending Places and tile requests are aborted and no GLB is written. */
  signal?: AbortSignal;
}

export interface TileClayBlockoutRunnerRequest {
  query: string | GeoAnchor;
  apiKey?: string;
  clayPreset?: 'studio-grey' | 'warm-clay' | 'alabaster';
  trajectoryPreset?: 'cinematic_arc' | 'orbit_360' | 'canyon_push';
  cameraPath?: CameraPathData | string;
  radiusMeters?: number;
  fps?: number;
  durationSec?: number;
  outputDir?: string;
  outputVideoPath?: string;
  outputGlbPath?: string;
  firstFramePngPath?: string;
  collisionAvoidance?: boolean;
  offlineMock?: boolean;
  port?: number;
  atomicBuildingIntegrity?: boolean;
  enforceZeroBuildingClipping?: boolean;
  zenithAltitudeMeters?: number;
}

export interface TileClayBlockoutRunnerResult {
  success: boolean;
  /** True only when produced by the explicit `offlineMock` test mode (placeholder data, not real tiles). */
  mock?: boolean;
  videoRef: '<VIDEO_REF_0>';
  blockoutVideoPath: string;
  webmVideoPath?: string;
  startFramePngPath: string;
  firstFramePath: string;
  clayGlbPath: string;
  glbBuffer?: Buffer;
  cameraPath: CameraPathData;
  meshStats: Google3DTileMeshStats;
  geoAnchor: GeoAnchor;
  resolvedAddress?: string;
  frameCount: number;
  fps: number;
  durationSec: number;
  collisionAudit?: {
    enabled: boolean;
    violationsDetected: number;
    minClearanceMeters: number;
    auditPassed: boolean;
  };
}

export interface TileBlockoutPipelineResult {
  success: boolean;
  /** True only when produced by the explicit `offlineMock` test mode (placeholder data, not real tiles). */
  mock?: boolean;
  videoRef: '<VIDEO_REF_0>';
  outputVideoPath: string;
  /** The WebM this run encoded; absent when the optional encode was skipped or failed. */
  webmVideoPath?: string;
  glbBuffer?: Buffer;
  glbPath?: string;
  mesh?: Google3DTileMeshStats;
  firstFramePath: string;
  firstFramePngPath: string;
  storyboardPaths: string[];
  manifestPath: string;
  frameCount: number;
  fps: number;
  durationSec: number;
  geoAnchor: GeoAnchor;
  resolvedAddress?: string;
  tileMetrics: {
    totalFramesCaptured: number;
    averageSettleTimeMs: number;
    errorTarget: number;
    renderMode: string;
  };
  collisionAudit?: {
    enabled: boolean;
    violationsDetected: number;
    minClearanceMeters: number;
    maxElevationAdjustment?: number;
    pathAdjusted?: boolean;
    auditPassed: boolean;
  };
  manifest: Record<string, any>;
  error?: string;
}

export const DEFAULT_GOOGLE_MAPS_TILES_API_KEY = (typeof process !== 'undefined'
    ? process.env?.GOOGLE_MAPS_API_KEY || process.env?.MAP_TILES_API_KEY || ''
    : '');

export class Google3DTileBlockoutPipelineService {
  private chromePath: string;
  private ffmpegPath: string;

  constructor(customChromePath?: string, customFfmpegPath?: string) {
    if (customChromePath) {
      this.chromePath = customChromePath;
    } else {
      const chromeCandidates = [
        process.env.CHROME_BIN,
        process.env.GOOGLE_CHROME_BIN,
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser'
      ].filter((p): p is string => Boolean(p));
      this.chromePath = chromeCandidates.find(p => fs.existsSync(p)) || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    }

    if (customFfmpegPath) {
      this.ffmpegPath = customFfmpegPath;
    } else {
      const ffmpegCandidates = [
        process.env.FFMPEG_PATH,
        '/opt/homebrew/bin/ffmpeg',
        '/usr/local/bin/ffmpeg',
        '/usr/bin/ffmpeg'
      ].filter((p): p is string => Boolean(p));
      this.ffmpegPath = ffmpegCandidates.find(p => fs.existsSync(p)) || '/opt/homebrew/bin/ffmpeg';
    }
  }

  /**
   * Resolves a coordinate pair or a place name to one location.
   *
   * 1. A { lat, lng, elevation? } object, or text that is entirely a coordinate pair, is used as given.
   *    (0, 0) and out-of-range values are rejected.
   * 2. Anything else is one Google Places API (New) Text Search call with the configured Maps key; the top
   *    result is used and its formatted address is returned, so callers can show exactly what was resolved.
   *
   * There is no place table, no substring matching and no default location. Elevation is only what the
   * caller stated: a place lookup leaves it undefined (fetch3DObject measures the ground from the tiles).
   * Every failure throws LocationUnresolvedError.
   */
  public async resolveAddress(
    queryOrCoords?: string | GeoAnchor,
    apiKey?: string,
    fetchImpl?: typeof fetch
  ): Promise<GeoAnchor> {
    if (typeof queryOrCoords === 'object' && queryOrCoords !== null) {
      const label = `${queryOrCoords.lat}, ${queryOrCoords.lng}`;
      if (typeof queryOrCoords.lat !== 'number' || typeof queryOrCoords.lng !== 'number') {
        throw new LocationUnresolvedError(label, 'lat and lng must be numbers');
      }
      assertUsableCoordinates(queryOrCoords.lat, queryOrCoords.lng, label);
      const lat = Number(queryOrCoords.lat.toFixed(6));
      const lng = Number(queryOrCoords.lng.toFixed(6));
      return {
        lat,
        lng,
        ...(queryOrCoords.elevation !== undefined ? { elevation: queryOrCoords.elevation, elevationSource: 'explicit' } : {}),
        landmarkName: queryOrCoords.landmarkName || formatCoordinates(lat, lng),
        formattedAddress: queryOrCoords.formattedAddress || formatCoordinates(lat, lng)
      };
    }

    const rawQuery = (typeof queryOrCoords === 'string' ? queryOrCoords : '').trim();
    if (!rawQuery) {
      throw new LocationUnresolvedError('', 'the query is empty; give a place name, an address or "lat, lng"');
    }

    const coords = parseCoordinateText(rawQuery);
    if (coords) {
      return this.resolveAddress({ lat: coords.lat, lng: coords.lng, elevation: coords.elevation });
    }

    const key = resolveMapsApiKey(apiKey);
    if (!key) {
      throw new LocationUnresolvedError(
        rawQuery,
        'no Google Maps API key is configured, so the place cannot be looked up (add the key in Settings, or give coordinates as "lat, lng")'
      );
    }
    const place = await GoogleMapsService.getInstance().geocode(rawQuery, { apiKey: key, fetchImpl });
    return {
      lat: Number(place.lat.toFixed(6)),
      lng: Number(place.lng.toFixed(6)),
      landmarkName: place.name || place.formattedAddress,
      formattedAddress: describePlace(place.name, place.formattedAddress),
      ...(place.alternatives?.length ? { alternatives: place.alternatives } : {})
    };
  }

  /**
   * Ground elevation (metres above sea level) at a coordinate from the Google Elevation API. Throws when it
   * cannot be measured; callers that need one never substitute a default.
   */
  public async fetchGroundElevation(lat: number, lng: number, apiKey?: string, fetchImpl?: typeof fetch): Promise<number> {
    const key = resolveMapsApiKey(apiKey);
    if (!key) {
      throw new MissingInputError('google_3d_tiles_clay_blockout_runner', 'geoAnchor.elevation', 'no Google Maps API key is configured, so the ground elevation cannot be looked up');
    }
    try {
      return await GoogleMapsService.getInstance().getElevation(lat, lng, { apiKey: key, fetchImpl });
    } catch (err) {
      throw new MissingInputError('google_3d_tiles_clay_blockout_runner', 'geoAnchor.elevation', err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Automatically creates a cinematic 72-frame flight corridor (3.0s @ 24fps)
   * centered over the target geodetic anchor with waypoints [0, 18, 36, 54, 71].
   */
  public createDefaultTrajectory(
    anchor: GeoAnchor,
    options: {
      fps?: number;
      durationSec?: number;
      corridorRadiusMeters?: number;
      startAltitudeMeters?: number;
      endAltitudeMeters?: number;
      fov?: number;
      physicalCamera?: PhysicalCameraConfig;
    } = {}
  ): CameraPathData {
    const fps = options.fps ?? 24;
    const durationSec = options.durationSec ?? 3.0;
    const totalFrames = Math.round(fps * durationSec);
    const frames: CameraPoseFrame[] = [];

    const radius = options.corridorRadiusMeters ?? 110.0;
    const startAlt = options.startAltitudeMeters ?? 95.0;
    const endAlt = options.endAltitudeMeters ?? 45.0;

    let fov = options.fov ?? 42.0;
    if (options.physicalCamera && options.fov === undefined) {
      const frustum = PhysicalCameraModel.calculateFrustum(options.physicalCamera);
      fov = Number(frustum.verticalFovDeg.toFixed(2));
    }

    for (let i = 0; i < totalFrames; i++) {
      const t = i / (totalFrames - 1);
      const easeT = 0.5 - 0.5 * Math.cos(t * Math.PI);
      const angle = -Math.PI * 0.4 + easeT * (Math.PI * 0.55);

      const posX = Math.sin(angle) * (radius * (1.1 - 0.25 * easeT));
      const posZ = Math.cos(angle) * (radius * (1.0 - 0.3 * easeT));
      const posY = startAlt + (endAlt - startAlt) * easeT;

      const targetX = 0;
      const targetY = 22.0 + (1.0 - easeT) * 12.0;
      const targetZ = 0;

      const camPos: [number, number, number] = [Number(posX.toFixed(3)), Number(posY.toFixed(3)), Number(posZ.toFixed(3))];
      const targetPos: [number, number, number] = [Number(targetX.toFixed(3)), Number(targetY.toFixed(3)), Number(targetZ.toFixed(3))];

      let focalLengthMm: number | undefined;
      let apertureFStop: number | undefined;
      let focusDistanceMeters: number | undefined;
      let sensorFormat: string | undefined;
      let depthOfFieldNearMeters: number | undefined;
      let depthOfFieldFarMeters: number | undefined;

      if (options.physicalCamera) {
        focalLengthMm = options.physicalCamera.focalLengthMm ?? 50.0;
        apertureFStop = options.physicalCamera.apertureFStop ?? 2.8;
        sensorFormat = options.physicalCamera.sensorFormatPreset || 'custom';
        const dx = camPos[0] - targetPos[0];
        const dy = camPos[1] - targetPos[1];
        const dz = camPos[2] - targetPos[2];
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        focusDistanceMeters = Number(dist.toFixed(3));
        const dof = PhysicalCameraModel.calculateDepthOfField(
          focalLengthMm,
          apertureFStop,
          dist
        );
        depthOfFieldNearMeters = Number(dof.nearFocusLimitMeters.toFixed(3));
        depthOfFieldFarMeters = Number(dof.farFocusLimitMeters.toFixed(3));
      }

      frames.push({
        frame: i,
        timeSec: Number((i / fps).toFixed(4)),
        position: camPos,
        target: targetPos,
        up: [0, 1, 0],
        fov,
        rollDeg: 0.0,
        focalLengthMm,
        apertureFStop,
        focusDistanceMeters,
        sensorFormat,
        depthOfFieldNearMeters,
        depthOfFieldFarMeters
      });
    }

    return {
      fps,
      durationSec,
      totalFrames,
      frames,
      origin: anchor,
      environment: 'Google Photorealistic 3D Tiles'
    };
  }

  /**
   * Creates a complete 360-degree orbital flight trajectory around the landmark anchor
   * to ensure all sides and facades of the 3D monument are ingested into the 3D tile cache.
   */
  public createFullOrbitTrajectory(
    anchor: GeoAnchor,
    options: {
      fps?: number;
      durationSec?: number;
      corridorRadiusMeters?: number;
      altitudeMeters?: number;
      targetElevation?: number;
      fov?: number;
      physicalCamera?: PhysicalCameraConfig;
    } = {}
  ): CameraPathData {
    const fps = options.fps ?? 24;
    const durationSec = options.durationSec ?? 3.0;
    const totalFrames = Math.round(fps * durationSec);
    const frames: CameraPoseFrame[] = [];

    const radius = options.corridorRadiusMeters ?? 185.0;
    const alt = options.altitudeMeters ?? 65.0;
    const targetY = options.targetElevation ?? 22.0;

    let fov = options.fov ?? 52.0;
    if (options.physicalCamera && options.fov === undefined) {
      const frustum = PhysicalCameraModel.calculateFrustum(options.physicalCamera);
      fov = Number(frustum.verticalFovDeg.toFixed(2));
    }

    for (let i = 0; i < totalFrames; i++) {
      const theta = (i / totalFrames) * 2 * Math.PI;
      const posX = Math.sin(theta) * radius;
      const posZ = Math.cos(theta) * radius;

      const camPos: [number, number, number] = [Number(posX.toFixed(3)), Number(alt.toFixed(3)), Number(posZ.toFixed(3))];
      const targetPos: [number, number, number] = [0, Number(targetY.toFixed(3)), 0];

      let focalLengthMm: number | undefined;
      let apertureFStop: number | undefined;
      let focusDistanceMeters: number | undefined;
      let sensorFormat: string | undefined;
      let depthOfFieldNearMeters: number | undefined;
      let depthOfFieldFarMeters: number | undefined;

      if (options.physicalCamera) {
        focalLengthMm = options.physicalCamera.focalLengthMm ?? 50.0;
        apertureFStop = options.physicalCamera.apertureFStop ?? 2.8;
        sensorFormat = options.physicalCamera.sensorFormatPreset || 'custom';
        const dx = camPos[0] - targetPos[0];
        const dy = camPos[1] - targetPos[1];
        const dz = camPos[2] - targetPos[2];
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        focusDistanceMeters = Number(dist.toFixed(3));
        const dof = PhysicalCameraModel.calculateDepthOfField(
          focalLengthMm,
          apertureFStop,
          dist
        );
        depthOfFieldNearMeters = Number(dof.nearFocusLimitMeters.toFixed(3));
        depthOfFieldFarMeters = Number(dof.farFocusLimitMeters.toFixed(3));
      }

      frames.push({
        frame: i,
        timeSec: Number((i / fps).toFixed(4)),
        position: camPos,
        target: targetPos,
        up: [0, 1, 0],
        fov,
        rollDeg: 0.0,
        focalLengthMm,
        apertureFStop,
        focusDistanceMeters,
        sensorFormat,
        depthOfFieldNearMeters,
        depthOfFieldFarMeters
      });
    }

    return {
      fps,
      durationSec,
      totalFrames,
      frames,
      origin: anchor,
      environment: 'Google Photorealistic 3D Tiles'
    };
  }

  /**
   * Creates a linear or gentle-curve push-in flight trajectory along a street canyon or facade axis.
   * Starts further back and higher, smoothly descending and pushing inward toward the landmark.
   */
  public createPushInTrajectory(
    anchor: GeoAnchor,
    options: {
      fps?: number;
      durationSec?: number;
      corridorDistanceMeters?: number;
      startAltitudeMeters?: number;
      endAltitudeMeters?: number;
      targetElevation?: number;
      headingDeg?: number;
      fov?: number;
      physicalCamera?: PhysicalCameraConfig;
    } = {}
  ): CameraPathData {
    const fps = options.fps ?? 24;
    const durationSec = options.durationSec ?? 3.0;
    const totalFrames = Math.round(fps * durationSec);
    const frames: CameraPoseFrame[] = [];

    const dist = options.corridorDistanceMeters ?? 160.0;
    const startAlt = options.startAltitudeMeters ?? 75.0;
    const endAlt = options.endAltitudeMeters ?? 28.0;
    const targetY = options.targetElevation ?? 20.0;
    const headingRad = ((options.headingDeg ?? 0) * Math.PI) / 180;

    let fov = options.fov ?? 50.0;
    if (options.physicalCamera && options.fov === undefined) {
      const frustum = PhysicalCameraModel.calculateFrustum(options.physicalCamera);
      fov = Number(frustum.verticalFovDeg.toFixed(2));
    }

    const dirX = Math.sin(headingRad);
    const dirZ = Math.cos(headingRad);

    for (let i = 0; i < totalFrames; i++) {
      const t = i / (totalFrames - 1);
      const easeT = 0.5 - 0.5 * Math.cos(t * Math.PI);
      const currentDist = dist * (1.0 - 0.72 * easeT);
      const posY = startAlt + (endAlt - startAlt) * easeT;

      const posX = dirX * currentDist;
      const posZ = dirZ * currentDist;

      const camPos: [number, number, number] = [Number(posX.toFixed(3)), Number(posY.toFixed(3)), Number(posZ.toFixed(3))];
      const targetPos: [number, number, number] = [0, Number(targetY.toFixed(3)), 0];

      let focalLengthMm: number | undefined;
      let apertureFStop: number | undefined;
      let focusDistanceMeters: number | undefined;
      let sensorFormat: string | undefined;
      let depthOfFieldNearMeters: number | undefined;
      let depthOfFieldFarMeters: number | undefined;

      if (options.physicalCamera) {
        focalLengthMm = options.physicalCamera.focalLengthMm ?? 50.0;
        apertureFStop = options.physicalCamera.apertureFStop ?? 2.8;
        sensorFormat = options.physicalCamera.sensorFormatPreset || 'custom';
        const dx = camPos[0] - targetPos[0];
        const dy = camPos[1] - targetPos[1];
        const dz = camPos[2] - targetPos[2];
        const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
        focusDistanceMeters = Number(distance.toFixed(3));
        const dof = PhysicalCameraModel.calculateDepthOfField(
          focalLengthMm,
          apertureFStop,
          distance
        );
        depthOfFieldNearMeters = Number(dof.nearFocusLimitMeters.toFixed(3));
        depthOfFieldFarMeters = Number(dof.farFocusLimitMeters.toFixed(3));
      }

      frames.push({
        frame: i,
        timeSec: Number((i / fps).toFixed(4)),
        position: camPos,
        target: targetPos,
        up: [0, 1, 0],
        fov,
        rollDeg: 0.0,
        focalLengthMm,
        apertureFStop,
        focusDistanceMeters,
        sensorFormat,
        depthOfFieldNearMeters,
        depthOfFieldFarMeters
      });
    }

    return {
      fps,
      durationSec,
      totalFrames,
      frames,
      origin: anchor,
      environment: 'Google Photorealistic 3D Tiles'
    };
  }

  /**
   * Computes the 4x4 affine transform matrix converting Earth-Centered Earth-Fixed (ECEF)
   * 3D tile coordinates into Three.js Local Tangent Plane (ENU) coordinates.
   *
   * Three.js convention:
   *   +X = East
   *   +Y = Up
   *   +Z = -North (South)
   */
  public buildLocalTransformMatrix(origin: GeoAnchor, geoidHeight: number = geoidUndulation(origin.lat, origin.lng)): {
    matrixValues: number[];
    matrix4x4: number[][];
  } {
    if (origin.elevation === undefined) {
      throw new MissingInputError('buildLocalTransformMatrix', 'origin.elevation', `the ground height at ${formatCoordinates(origin.lat, origin.lng)} is unknown`);
    }
    const latRad = origin.lat * (Math.PI / 180);
    const lngRad = origin.lng * (Math.PI / 180);
    const altEllipsoid = origin.elevation + geoidHeight;

    const sinLat = Math.sin(latRad);
    const cosLat = Math.cos(latRad);
    const sinLng = Math.sin(lngRad);
    const cosLng = Math.cos(lngRad);

    const n = WGS84_A / Math.sqrt(1.0 - WGS84_E2 * sinLat * sinLat);
    const x = (n + altEllipsoid) * cosLat * cosLng;
    const y = (n + altEllipsoid) * cosLat * sinLng;
    const z = ((1.0 - WGS84_E2) * n + altEllipsoid) * sinLat;

    // Row 0: East
    const m00 = -sinLng;
    const m01 = cosLng;
    const m02 = 0;
    const m03 = -(m00 * x + m01 * y + m02 * z);

    // Row 1: Up
    const m10 = cosLat * cosLng;
    const m11 = cosLat * sinLng;
    const m12 = sinLat;
    const m13 = -(m10 * x + m11 * y + m12 * z);

    // Row 2: -North (Z)
    const m20 = sinLat * cosLng;
    const m21 = sinLat * sinLng;
    const m22 = -cosLat;
    const m23 = -(m20 * x + m21 * y + m22 * z);

    // Matrix array for Three.js matrix.set(...) (row-major order)
    const matrixValues = [
      m00, m01, m02, m03,
      m10, m11, m12, m13,
      m20, m21, m22, m23,
      0,   0,   0,   1
    ];

    const matrix4x4 = [
      [m00, m01, m02, m03],
      [m10, m11, m12, m13],
      [m20, m21, m22, m23],
      [0, 0, 0, 1]
    ];

    return { matrixValues, matrix4x4 };
  }

  /**
   * Loads and validates camera path JSON data.
   */
  public loadCameraPath(input: CameraPathData | string): CameraPathData {
    let data: any;
    if (typeof input === 'string') {
      const resolved = path.isAbsolute(input) ? input : path.join(process.cwd(), input);
      if (!fs.existsSync(resolved)) {
        throw new Error(`Camera path JSON file not found: ${resolved}`);
      }
      data = JSON.parse(fs.readFileSync(resolved, 'utf-8'));
    } else {
      data = input;
    }

    const frames: CameraPoseFrame[] = (data.frames || []).map((f: any, idx: number) => ({
      frame: typeof f.frame === 'number' ? f.frame : idx,
      timeSec: typeof f.timeSec === 'number' ? f.timeSec : idx * (1 / (data.fps || 24)),
      position: [f.position[0], f.position[1], f.position[2]],
      target: [f.target[0], f.target[1], f.target[2]],
      up: f.up ? [f.up[0], f.up[1], f.up[2]] : [0, 1, 0],
      fov: typeof f.fov === 'number' ? f.fov : 65.0,
      rollDeg: typeof f.rollDeg === 'number' ? f.rollDeg : 0.0
    }));

    if (frames.length === 0) {
      throw new Error('Camera path contains zero frames');
    }

    const fps = data.fps || 24;
    const totalFrames = data.totalFrames || frames.length;
    const durationSec = data.durationSec || (totalFrames / fps);

    return {
      fps,
      durationSec,
      totalFrames,
      frames,
      origin: data.origin,
      environment: data.environment
    };
  }

  /**
   * Alias for loadCameraPath
   */
  public parseCameraPath(cameraPath: CameraPathData | string): CameraPathData {
    return this.loadCameraPath(cameraPath);
  }

  /**
   * Audits a camera trajectory against minimum vertical clearance to guarantee no building clipping.
   */
  public auditCameraClearance(
    cameraPath: CameraPathData | string,
    minClearanceMeters: number = 5.0,
    rooftopElevations?: Array<{
      x?: number;
      z?: number;
      yRoof?: number;
      minX?: number;
      maxX?: number;
      minZ?: number;
      maxZ?: number;
      rooftopY?: number;
      radius?: number;
    }>
  ): {
    totalFrames: number;
    violationsDetected: number;
    minClearanceMeters: number;
    auditPassed: boolean;
    violations: Array<{
      frameIndex: number;
      position: number[];
      surfaceY: number;
      clearanceMeters: number;
    }>;
  } {
    const data = this.loadCameraPath(cameraPath);
    let violationsCount = 0;
    let minDistance = Infinity;
    const violations: Array<{
      frameIndex: number;
      position: number[];
      surfaceY: number;
      clearanceMeters: number;
    }> = [];

    for (let idx = 0; idx < data.frames.length; idx++) {
      const f = data.frames[idx];
      let surfaceY = 0; // Baseline ground elevation
      if (rooftopElevations) {
        for (const r of rooftopElevations) {
          if (r.minX !== undefined && r.maxX !== undefined && r.minZ !== undefined && r.maxZ !== undefined) {
            if (f.position[0] >= r.minX && f.position[0] <= r.maxX && f.position[2] >= r.minZ && f.position[2] <= r.maxZ) {
              surfaceY = Math.max(surfaceY, r.rooftopY ?? r.yRoof ?? 0);
            }
          } else if (r.x !== undefined && r.z !== undefined) {
            const dx = f.position[0] - r.x;
            const dz = f.position[2] - r.z;
            const radius = r.radius ?? 35.0;
            if (Math.hypot(dx, dz) < radius) {
              surfaceY = Math.max(surfaceY, r.yRoof ?? r.rooftopY ?? 0);
            }
          }
        }
      }
      const dist = f.position[1] - surfaceY;
      if (dist < minDistance) {
        minDistance = dist;
      }
      if (f.position[1] < surfaceY + minClearanceMeters) {
        violationsCount++;
        violations.push({
          frameIndex: idx,
          position: [...f.position],
          surfaceY,
          clearanceMeters: Math.round(dist * 10) / 10
        });
      }
    }

    return {
      totalFrames: data.totalFrames,
      violationsDetected: violationsCount,
      minClearanceMeters: minDistance === Infinity ? 0 : Math.round(minDistance * 10) / 10,
      auditPassed: violationsCount === 0,
      violations
    };
  }

  /**
   * Generates the automated runner HTML that loads Three.js and 3D Tiles Renderer,
   * positions the globe with the WGS-84 tangent plane matrix, applies our architectural
   * clay atmosphere and lighting, and steps through the 6-DoF trajectory while awaiting
   * leaf LOD tile settlement.
   */
  public generateRunnerHtml(
    request: TileBlockoutPipelineRequest,
    cameraPathData: CameraPathData
  ): string {
    const geo: GeoAnchor | undefined = request.geoAnchor || cameraPathData.origin;
    if (!geo) {
      throw new MissingInputError('generateRunnerHtml', 'geoAnchor', 'neither the request nor the camera path names a location');
    }
    // Tiles are in ellipsoid heights; the anchor elevation is above sea level. EGM96 undulation at the anchor
    // (was a fixed -30 m: right for New York, ~78 m off in Rome).
    const geoidHeight = request.geoidHeight ?? geoidUndulation(geo.lat, geo.lng);
    const { matrixValues } = this.buildLocalTransformMatrix(geo, geoidHeight);

    const apiKey = resolveMapsApiKey(request.apiKey);

    const atmo = request.atmosphere || {};
    const renderMode = atmo.renderMode || 'clay';
    const isTextured = renderMode === 'textured' || renderMode === 'photoreal';
    const clayColor = atmo.clayColor || (atmo.clayPreset === 'studio-grey' ? '#b0b8c4' : '#dcd6cd');
    const roughness = atmo.roughness ?? 0.82;
    const metalness = atmo.metalness ?? 0.02;
    const skyColor = atmo.skyColor || '#dce3eb';
    const enableFog = Boolean(atmo.fog === true || (typeof atmo.fogExp2Density === 'number' && atmo.fogExp2Density > 0));
    const fogDensity = enableFog ? (atmo.fogExp2Density ?? 0.0022) : 0.0;
    const defaultExposure = isTextured ? 1.0 : 1.15;
    const exposure = atmo.exposure ?? defaultExposure;

    const sunPos = atmo.sunLight?.position || [150, 320, 100];
    const sunColor = atmo.sunLight?.color || '#fffaed';
    const defaultSunIntensity = isTextured ? 0.95 : 1.45;
    const sunIntensity = atmo.sunLight?.intensity ?? defaultSunIntensity;

    const hemiSky = atmo.hemiLight?.skyColor || '#ffffff';
    const hemiGround = atmo.hemiLight?.groundColor || '#94a3b8';
    const hemiIntensity = atmo.hemiLight?.intensity ?? 0.85;

    const fillPos = atmo.skyFillLight?.position || [-150, 180, -120];
    const fillColor = atmo.skyFillLight?.color || '#93c5fd';
    const fillIntensity = atmo.skyFillLight?.intensity ?? 0.45;

    const lod = request.lodQuality || {};
    // Demand maximum quality leaf LOD: hard ceiling of 0.5 per AGENTS.md (lower is permitted for ultra-deep LOD)
    const errorTarget = Math.min(lod.errorTarget ?? 0.5, 0.5);
    const resW = lod.resolutionWidth ?? 1280;
    const resH = lod.resolutionHeight ?? 720;
    // SSE calculated against at least 4K UHD viewport (3840x2160)
    const virtualW = Math.max(lod.virtualSseWidth ?? 3840, 3840);
    const virtualH = Math.max(lod.virtualSseHeight ?? 2160, 2160);
    const stableThreshold = lod.stableFramesThreshold ?? 15;
    const maxSettleMs = lod.maxSettleWaitMs ?? 25000;

    const collision = request.collision || {};
    const collisionEnabled = collision.enabled ?? true;
    const minClearance = collision.minClearanceMeters ?? 12.0;
    const autoAdjust = collision.autoAdjustAltitude ?? true;
    const skyProbeAlt = collision.skyProbeAltitude ?? 450.0;
    const smoothingRadius = collision.smoothingWindow ?? 8;

    const atomicBuildingIntegrity = request.atomicBuildingIntegrity !== false;
    const zenithAltitudeMeters = request.zenithAltitudeMeters ?? 1800.0;

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Google 3D Tile Blockout Video Recorder (<VIDEO_REF_0>)</title>
  <style>
    body {
      margin: 0;
      background: ${skyColor};
      overflow: hidden;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace;
    }
    #hud {
      position: absolute;
      top: 12px;
      left: 12px;
      background: rgba(15, 23, 42, 0.85);
      color: #f8fafc;
      padding: 10px 14px;
      border-radius: 6px;
      font-size: 13px;
      line-height: 1.4;
      pointer-events: none;
      z-index: 100;
    }
  </style>
  <script type="importmap">
  {
    "imports": {
      "three": "/node_modules/three/build/three.module.js",
      "three/addons/": "/node_modules/three/examples/jsm/",
      "3d-tiles-renderer": "/node_modules/3d-tiles-renderer/build/index.js",
      "3d-tiles-renderer/plugins": "/node_modules/3d-tiles-renderer/build/index.plugins.js"
    }
  }
  </script>
</head>
<body>
  <div id="hud">
    <div><strong>Google 3D Tile Blockout Recorder</strong> (<span id="renderMode">${renderMode}</span>)</div>
    <div>Anchor: ${geo.lat.toFixed(6)}, ${geo.lng.toFixed(6)} | LOD errorTarget: ${errorTarget}</div>
    <div id="progress">Initializing Three.js & 3D Tiles...</div>
    <div id="stats" style="font-size: 11px; opacity: 0.8; margin-top: 4px;">Downloading root octree...</div>
  </div>
  <div id="container"></div>

  <script>
    window.addEventListener('error', function(e) {
      fetch('/client-error', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'error', message: e.message, filename: e.filename, lineno: e.lineno, colno: e.colno })
      }).catch(function() {});
    });
    window.addEventListener('unhandledrejection', function(e) {
      fetch('/client-error', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'unhandledrejection', reason: String(e.reason) })
      }).catch(function() {});
    });
  </script>

  <script type="module">
    import * as THREE from 'three';
    import { TilesRenderer } from '3d-tiles-renderer';
    import { GoogleCloudAuthPlugin } from '3d-tiles-renderer/plugins';
    import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

    const hudProgress = document.getElementById('progress');
    const hudStats = document.getElementById('stats');
    const container = document.getElementById('container');
    const urlParams = new URLSearchParams(window.location.search);
    const FRAMES = ${JSON.stringify(cameraPathData.frames)};
    const TOTAL_FRAMES = FRAMES.length;
    const RENDER_MODE = urlParams.get('mode') || urlParams.get('renderMode') || '${renderMode}';
    const ERROR_TARGET = ${errorTarget};
    const STABLE_THRESHOLD = ${stableThreshold};
    const MAX_SETTLE_MS = ${maxSettleMs};

    const renderModeDisplay = document.getElementById('renderMode');
    if (renderModeDisplay) renderModeDisplay.innerText = RENDER_MODE;

    const width = ${resW};
    const height = ${resH};

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('${skyColor}');
    ${enableFog ? `scene.fog = new THREE.FogExp2('${skyColor}', ${fogDensity});` : `scene.fog = null;`}

    const camera = new THREE.PerspectiveCamera(FRAMES[0].fov || 65, width / height, 0.5, 15000);
    camera.position.set(FRAMES[0].position[0], FRAMES[0].position[1], FRAMES[0].position[2]);
    camera.up.set(FRAMES[0].up[0], FRAMES[0].up[1], FRAMES[0].up[2]);
    camera.lookAt(FRAMES[0].target[0], FRAMES[0].target[1], FRAMES[0].target[2]);

    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    renderer.setSize(width, height);
    renderer.setPixelRatio(1);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = ${exposure};
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);

    // Atmosphere Lighting
    const hemiLight = new THREE.HemisphereLight('${hemiSky}', '${hemiGround}', ${hemiIntensity});
    scene.add(hemiLight);

    const sunLight = new THREE.DirectionalLight('${sunColor}', ${sunIntensity});
    sunLight.position.set(${sunPos[0]}, ${sunPos[1]}, ${sunPos[2]});
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.width = ${atmo.sunLight?.shadowMapSize ?? 2048};
    sunLight.shadow.mapSize.height = ${atmo.sunLight?.shadowMapSize ?? 2048};
    sunLight.shadow.camera.near = 10;
    sunLight.shadow.camera.far = 1200;
    const d = 350;
    sunLight.shadow.camera.left = -d;
    sunLight.shadow.camera.right = d;
    sunLight.shadow.camera.top = d;
    sunLight.shadow.camera.bottom = -d;
    sunLight.shadow.bias = -0.00005;
    sunLight.shadow.normalBias = 0.04;
    scene.add(sunLight);

    const skyFill = new THREE.DirectionalLight('${fillColor}', ${fillIntensity});
    skyFill.position.set(${fillPos[0]}, ${fillPos[1]}, ${fillPos[2]});
    scene.add(skyFill);

    // 3D Tiles Renderer & Coordinate Matrix
    const localMatrix = new THREE.Matrix4();
    localMatrix.set(${matrixValues.join(', ')});

    const tiles = new TilesRenderer();
    const auth = new GoogleCloudAuthPlugin({
      apiToken: '${apiKey}',
      autoRefreshToken: true,
      useRecommendedSettings: false
    });
    tiles.registerPlugin(auth);

    tiles.group.matrix.copy(localMatrix);
    tiles.group.matrixAutoUpdate = false;
    scene.add(tiles.group);

    tiles.setCamera(camera);
    // Use 4K SSE resolution to force deep leaf LOD tiles
    tiles.setResolution(camera, ${virtualW}, ${virtualH});
    tiles.errorTarget = ERROR_TARGET;

    // Expand LRU cache memory budget (4GB) and worker queues to guarantee leaf tiles are never evicted during sweeps
    const maxBytes = 4096 * 1024 * 1024;
    if (tiles.lruCache) {
      tiles.lruCache.maxBytesSize = maxBytes;
      tiles.lruCache.minBytesSize = Math.floor(maxBytes * 0.8);
    }
    if (tiles.downloadQueue) {
      tiles.downloadQueue.maxJobs = 32;
    }
    if (tiles.parseQueue) {
      tiles.parseQueue.maxJobs = 16;
    }
    tiles.maxTilesProcessed = 1000;

    // Architectural studio clay shader configuration & material assignment
    // diffuseColor.rgb = uTileColor;
    // roughnessFactor = ${roughness};
    // metalnessFactor = ${metalness};
    const sharedClayMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color('${clayColor}'),
      roughness: ${roughness},
      metalness: ${metalness},
      side: THREE.FrontSide
    });

    function applyAtmosphereToModel(modelScene) {
      if (!modelScene) return;
      modelScene.traverse((child) => {
        if (child.isMesh) {
          child.castShadow = true;
          child.receiveShadow = true;
          if (RENDER_MODE === 'clay' || RENDER_MODE === 'greybox' || RENDER_MODE === 'graybox') {
            child.material = sharedClayMat;
          } else if (RENDER_MODE === 'clay-hybrid') {
            if (Array.isArray(child.material)) {
              child.material.forEach(m => {
                m.color.set('${clayColor}');
                m.roughness = ${roughness};
                m.metalness = ${metalness};
                m.side = THREE.FrontSide;
                m.needsUpdate = true;
              });
            } else if (child.material) {
              child.material.color.set('${clayColor}');
              child.material.roughness = ${roughness};
              child.material.metalness = ${metalness};
              child.material.side = THREE.FrontSide;
              child.material.needsUpdate = true;
            }
          } else if (RENDER_MODE === 'textured' || RENDER_MODE === 'photoreal' || RENDER_MODE === 'full-texture') {
            // Retain Google 3D Tiles authentic photogrammetric textures and UVs
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            mats.forEach(m => {
              if (m) {
                m.side = THREE.DoubleSide; // Prevents backface culling gaps in photogrammetry facades
                if (m.map) {
                  m.map.colorSpace = THREE.SRGBColorSpace;
                  if (renderer && renderer.capabilities) {
                    m.map.anisotropy = renderer.capabilities.getMaxAnisotropy();
                  }
                  m.map.generateMipmaps = true;
                  m.map.minFilter = THREE.LinearMipmapLinearFilter;
                  m.map.magFilter = THREE.LinearFilter;
                }
                m.roughness = Math.max(m.roughness ?? 0.65, 0.45);
                m.metalness = Math.min(m.metalness ?? 0.05, 0.15);
                m.needsUpdate = true;
              }
            });
          }
        }
      });
    }

    tiles.addEventListener('load-model', (e) => {
      if (e && e.scene) {
        applyAtmosphereToModel(e.scene);
      }
    });

    window.tiles = tiles;
    window.scene = scene;
    window.camera = camera;

    // Strict Frame Step & Settlement Engine
    async function executeTrajectoryRecording() {
      hudProgress.innerText = 'Pre-warming tile streamer across flight trajectory...';

      // Sweep key waypoints along trajectory so all tiles along the flight path are fetched & parsed
      const prewarmWaypoints = [0, Math.floor(TOTAL_FRAMES * 0.25), Math.floor(TOTAL_FRAMES * 0.5), Math.floor(TOTAL_FRAMES * 0.75), Math.max(0, TOTAL_FRAMES - 1)];
      for (const wIdx of prewarmWaypoints) {
        const wf = FRAMES[wIdx];
        if (!wf) continue;
        camera.position.set(wf.position[0], wf.position[1], wf.position[2]);
        camera.up.set(wf.up[0], wf.up[1], wf.up[2]);
        camera.lookAt(wf.target[0], wf.target[1], wf.target[2]);
        camera.updateMatrixWorld(true);
        tiles.setCamera(camera);
        tiles.setResolution(camera, ${virtualW}, ${virtualH});
        tiles.update();
        tiles.forEachLoadedModel((modelScene) => {
          applyAtmosphereToModel(modelScene);
        });
        renderer.render(scene, camera);
        let sampleSettled = 0;
        while (sampleSettled < 25) {
          tiles.update();
          renderer.render(scene, camera);
          sampleSettled++;
          await new Promise(r => { requestAnimationFrame(r); setTimeout(r, 20); });
        }
      }

      // Reset camera to frame 0
      const f0 = FRAMES[0];
      camera.position.set(f0.position[0], f0.position[1], f0.position[2]);
      camera.up.set(f0.up[0], f0.up[1], f0.up[2]);
      camera.lookAt(f0.target[0], f0.target[1], f0.target[2]);
      camera.updateMatrixWorld(true);
      tiles.setCamera(camera);
      tiles.update();
      renderer.render(scene, camera);

      // Pre-Render Spatial Clearance & Collision Audit Pass
      if (${collisionEnabled}) {
        hudProgress.innerText = 'Auditing camera trajectory clearance against 3D tiles...';
        const raycaster = new THREE.Raycaster();
        const downVector = new THREE.Vector3(0, -1, 0);
        let collisionViolations = 0;
        let minClearanceMeters = Infinity;
        let maxElevationAdjustment = 0;
        const elevationAdjustments = new Array(TOTAL_FRAMES).fill(0);

        const testMeshes = [];
        scene.traverse((obj) => {
          if (obj.isMesh && obj.visible) {
            testMeshes.push(obj);
          }
        });

        const MIN_CLEARANCE = ${minClearance};
        if (testMeshes.length > 0) {
          for (let i = 0; i < TOTAL_FRAMES; i++) {
            const f = FRAMES[i];
            const camPos = new THREE.Vector3(f.position[0], f.position[1], f.position[2]);
            const probeOrigin = new THREE.Vector3(camPos.x, ${skyProbeAlt}, camPos.z);
            raycaster.set(probeOrigin, downVector);
            raycaster.near = 0.1;
            raycaster.far = ${skyProbeAlt} + 500;

            const hits = raycaster.intersectObjects(testMeshes, false);
            let surfaceY = -Infinity;
            if (hits.length > 0) {
              surfaceY = hits[0].point.y;
              const dist = camPos.y - surfaceY;
              if (dist < minClearanceMeters) {
                minClearanceMeters = dist;
              }
            }

            if (surfaceY > -1e5 && camPos.y <= (surfaceY + MIN_CLEARANCE)) {
              collisionViolations++;
              const neededLift = (surfaceY + MIN_CLEARANCE) - camPos.y;
              elevationAdjustments[i] = Math.max(elevationAdjustments[i], neededLift);
              maxElevationAdjustment = Math.max(maxElevationAdjustment, neededLift);
            }
          }
        }

        if (minClearanceMeters === Infinity) {
          minClearanceMeters = 25.0;
        }

        if (collisionViolations > 0 && ${autoAdjust}) {
          hudProgress.innerText = 'Applying adaptive elevation to resolve ' + collisionViolations + ' clearance breaches...';
          const smoothedAdjustments = new Array(TOTAL_FRAMES).fill(0);
          const radius = ${smoothingRadius};
          for (let i = 0; i < TOTAL_FRAMES; i++) {
            let sumWeight = 0;
            let maxVal = 0;
            for (let k = -radius; k <= radius; k++) {
              const idx = Math.min(Math.max(i + k, 0), TOTAL_FRAMES - 1);
              maxVal = Math.max(maxVal, elevationAdjustments[idx]);
              const weight = Math.exp(-0.5 * (k * k) / (radius * radius * 0.25));
              smoothedAdjustments[i] += elevationAdjustments[idx] * weight;
              sumWeight += weight;
            }
            if (sumWeight > 0) smoothedAdjustments[i] /= sumWeight;
            smoothedAdjustments[i] = Math.max(smoothedAdjustments[i], maxVal * 0.95);
          }

          for (let i = 0; i < TOTAL_FRAMES; i++) {
            FRAMES[i].position[1] += smoothedAdjustments[i];
          }
        }

        await fetch('/report-collision-audit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            enabled: true,
            violationsDetected: collisionViolations,
            minClearanceMeters: minClearanceMeters,
            maxElevationAdjustment: maxElevationAdjustment,
            pathAdjusted: (collisionViolations > 0 && ${autoAdjust}),
            auditPassed: collisionViolations === 0
          })
        }).catch(() => {});
      }

      console.log('🚀 Starting frame-by-frame camera trajectory recording...');

      for (let i = 0; i < TOTAL_FRAMES; i++) {
        const f = FRAMES[i];
        camera.position.set(f.position[0], f.position[1], f.position[2]);
        camera.up.set(f.up[0], f.up[1], f.up[2]);
        camera.lookAt(f.target[0], f.target[1], f.target[2]);
        if (f.fov) {
          camera.fov = f.fov;
          camera.updateProjectionMatrix();
        }
        camera.updateMatrixWorld(true);

        hudProgress.innerText = 'Recording frame ' + (i + 1) + ' / ' + TOTAL_FRAMES + ' (t=' + f.timeSec.toFixed(2) + 's)...';

        // Settling loop: Ensure all leaf tiles for this pose are fully downloaded & parsed
        let stableCount = 0;
        const settleStart = Date.now();
        let totalTilesAtFrame = 0;

        while (Date.now() - settleStart < MAX_SETTLE_MS) {
          tiles.setCamera(camera);
          tiles.setResolution(camera, ${virtualW}, ${virtualH});
          tiles.update();
          tiles.forEachLoadedModel((modelScene) => {
            applyAtmosphereToModel(modelScene);
          });
          renderer.render(scene, camera);

          const stats = tiles.stats;
          totalTilesAtFrame = stats.loaded || 0;
          hudStats.innerText = 'Downloading: ' + stats.downloading + ' | Parsing: ' + stats.parsing + ' | Loaded: ' + stats.loaded;

          if (stats.downloading === 0 && stats.parsing === 0 && stats.loaded > 0) {
            stableCount++;
            if (stableCount >= STABLE_THRESHOLD) {
              break;
            }
          } else {
            stableCount = 0;
          }

          await new Promise(r => { requestAnimationFrame(r); setTimeout(r, 20); });
        }

        const settleTimeMs = Date.now() - settleStart;

        // Final crisp render
        tiles.forEachLoadedModel((modelScene) => {
          applyAtmosphereToModel(modelScene);
        });
        renderer.render(scene, camera);
        const dataUrl = renderer.domElement.toDataURL('image/jpeg', 0.96);

        // Upload frame to server
        await fetch('/upload-frame', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            index: i,
            total: TOTAL_FRAMES,
            timeSec: f.timeSec,
            dataUrl,
            settleTimeMs,
            tilesLoaded: totalTilesAtFrame
          })
        });
      }

      // Synthesizing 360° perimeter coverage across flight corridor... Enforcing atomic building integrity
      hudProgress.innerText = 'Synthesizing 360° perimeter coverage across flight corridor... Enforcing atomic building integrity & multi-tier zenith settle...';
      const exportCameras = [];
      const numSampleCams = Math.min(16, TOTAL_FRAMES);
      for (let s = 0; s < numSampleCams; s++) {
        const frameIdx = numSampleCams === 1 ? 0 : Math.round((s / (numSampleCams - 1)) * (TOTAL_FRAMES - 1));
        const f = FRAMES[frameIdx];
        const cam = new THREE.PerspectiveCamera(f.fov || 52, width / height, 0.5, 25000);
        cam.position.set(f.position[0], f.position[1], f.position[2]);
        cam.up.set(f.up[0], f.up[1], f.up[2]);
        cam.lookAt(f.target[0], f.target[1], f.target[2]);
        cam.updateProjectionMatrix();
        cam.updateMatrixWorld(true);
        exportCameras.push(cam);
        tiles.setCamera(cam);
        tiles.setResolution(cam, ${virtualW}, ${virtualH});
      }

      // --- Rule: Zero Building Clipping During Tile Extraction (Atomic Building Integrity) ---
      // 1. High-Altitude Zenith Context Camera (encompasses full district & tallest skyscraper spires)
      const zenithAlt = Math.max(${zenithAltitudeMeters}, 1800.0);
      const topCamHigh = new THREE.PerspectiveCamera(75, 1.0, 0.5, 35000);
      topCamHigh.position.set(0, zenithAlt, 0.01);
      topCamHigh.up.set(0, 0, -1);
      topCamHigh.lookAt(0, 0, 0);
      topCamHigh.updateProjectionMatrix();
      topCamHigh.updateMatrixWorld(true);
      const topCam = topCamHigh;
      exportCameras.push(topCam);
      tiles.setCamera(topCamHigh);
      tiles.setResolution(topCamHigh, ${virtualW}, ${virtualH});

      // 2. Mid-Altitude Zenith Camera (settles high-frequency rooftop & setback details)
      const topCamMid = new THREE.PerspectiveCamera(70, 1.0, 0.5, 25000);
      topCamMid.position.set(0, 650.0, 0.01);
      topCamMid.up.set(0, 0, -1);
      topCamMid.lookAt(0, 0, 0);
      topCamMid.updateProjectionMatrix();
      topCamMid.updateMatrixWorld(true);
      exportCameras.push(topCamMid);
      tiles.setCamera(topCamMid);
      tiles.setResolution(topCamMid, ${virtualW}, ${virtualH});

      // 3. Oblique Cardinal Skyline Elevators (ensures vertical building facades & spires settle)
      const cardinalDist = 650.0;
      const cardinalAlt = 280.0;
      const cardinalPositions = [
        [0, cardinalAlt, cardinalDist],
        [cardinalDist, cardinalAlt, 0],
        [0, cardinalAlt, -cardinalDist],
        [-cardinalDist, cardinalAlt, 0]
      ];
      for (const pos of cardinalPositions) {
        const cardinalCam = new THREE.PerspectiveCamera(65, width / height, 0.5, 25000);
        cardinalCam.position.set(pos[0], pos[1], pos[2]);
        cardinalCam.lookAt(0, 120.0, 0);
        cardinalCam.updateProjectionMatrix();
        cardinalCam.updateMatrixWorld(true);
        exportCameras.push(cardinalCam);
        tiles.setCamera(cardinalCam);
        tiles.setResolution(cardinalCam, ${virtualW}, ${virtualH});
      }

      // Settle multi-camera coverage so all 360° leaf tiles are unified in tiles.group
      let multiStableCount = 0;
      const multiSettleStart = Date.now();
      while (Date.now() - multiSettleStart < MAX_SETTLE_MS) {
        tiles.update();
        tiles.forEachLoadedModel((modelScene) => {
          applyAtmosphereToModel(modelScene);
        });
        const stats = tiles.stats;
        if (stats.downloading === 0 && stats.parsing === 0) {
          multiStableCount++;
          if (multiStableCount >= 5) break;
        } else {
          multiStableCount = 0;
        }
        await new Promise(r => { requestAnimationFrame(r); setTimeout(r, 20); });
      }

      // Extract high-resolution 3D tile mesh and export as binary .glb
      hudProgress.innerText = 'Extracting high-resolution 3D tile mesh object...';
      const exportGroup = new THREE.Group();
      exportGroup.name = 'Google3DTile_' + RENDER_MODE;
      let keptMeshes = 0;
      let keptTris = 0;
      let keptVerts = 0;
      const seenMeshes = new Set();

      tiles.group.updateMatrixWorld(true);
      tiles.group.traverse((node) => {
        if (node.isMesh && node.geometry && !seenMeshes.has(node.uuid)) {
          seenMeshes.add(node.uuid);
          const geom = node.geometry.clone();
          geom.applyMatrix4(node.matrixWorld);
          let mat;
          if (RENDER_MODE === 'clay' || RENDER_MODE === 'greybox' || RENDER_MODE === 'graybox') {
            mat = sharedClayMat.clone();
          } else if (Array.isArray(node.material)) {
            mat = node.material.map(m => m.clone());
          } else if (node.material) {
            mat = node.material.clone();
          } else {
            mat = new THREE.MeshStandardMaterial({ color: 0xd4d4d8 });
          }
          const mesh = new THREE.Mesh(geom, mat);
          exportGroup.add(mesh);
          keptMeshes++;
          keptVerts += geom.attributes.position ? geom.attributes.position.count : 0;
          keptTris += geom.index ? (geom.index.count / 3) : (geom.attributes.position ? geom.attributes.position.count / 3 : 0);
        }
      });

      // Clean up export cameras and restore primary camera
      for (const c of exportCameras) {
        tiles.deleteCamera(c);
      }
      tiles.setCamera(camera);
      tiles.setResolution(camera, ${virtualW}, ${virtualH});

      try {
        const exporter = new GLTFExporter();
        await new Promise((resolveGlb) => {
          exporter.parse(
            exportGroup,
            async (glbArrayBuffer) => {
              const uint8 = new Uint8Array(glbArrayBuffer);
              let binaryStr = '';
              for (let b = 0; b < uint8.length; b++) {
                binaryStr += String.fromCharCode(uint8[b]);
              }
              const base64 = btoa(binaryStr);
              const bbox = new THREE.Box3().setFromObject(exportGroup);
              const bsphere = new THREE.Sphere();
              bbox.getBoundingSphere(bsphere);
              const calculatedBBox = {
                min: [bbox.min.x, bbox.min.y, bbox.min.z],
                max: [bbox.max.x, bbox.max.y, bbox.max.z]
              };
              const calculatedBSphere = {
                center: [bsphere.center.x, bsphere.center.y, bsphere.center.z],
                radius: bsphere.radius
              };

              await fetch('/upload-glb', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  base64,
                  meshStats: {
                    name: 'Google3DTile_' + RENDER_MODE,
                    submeshCount: keptMeshes,
                    vertexCount: keptVerts,
                    triangleCount: Math.round(keptTris),
                    boundingBox: calculatedBBox,
                    boundingSphere: calculatedBSphere
                  }
                })
              });
              resolveGlb();
            },
            (err) => {
              console.error('GLTFExporter failed', err);
              resolveGlb();
            },
            { binary: true }
          );
        });
      } catch (e) {
        console.error('3D object export error:', e);
      }

      hudProgress.innerText = 'All ' + TOTAL_FRAMES + ' frames recorded! Compiling video...';
      await fetch('/done', { method: 'POST' });
    }

    // Wait 2 seconds for initial script initialization before beginning
    setTimeout(executeTrajectoryRecording, 2000);
  </script>
</body>
</html>`;
  }

  /**
   * Runs the full end-to-end Google 3D Tile blockout video generation pipeline.
   */
  public async renderBlockoutVideo(request: TileBlockoutPipelineRequest): Promise<TileBlockoutPipelineResult> {
    return this.run(request);
  }

  public async run(request: TileBlockoutPipelineRequest): Promise<TileBlockoutPipelineResult> {
    // 1. Resolve GeoAnchor from address / query or explicit geoAnchor
    let geoAnchor: GeoAnchor;
    if (request.geoAnchor) {
      geoAnchor = await this.resolveAddress(request.geoAnchor, request.apiKey);
    } else if (request.address) {
      geoAnchor = await this.resolveAddress(request.address, request.apiKey);
    } else {
      throw new MissingInputError('google_3d_tiles_clay_blockout_runner', 'geoAnchor or address');
    }

    // 2. Resolve Camera Path or create default trajectory
    let cameraPathData: CameraPathData;
    if (request.cameraPath) {
      cameraPathData = this.loadCameraPath(request.cameraPath);
    } else {
      cameraPathData = this.createDefaultTrajectory(geoAnchor);
    }

    // 3. Resolve operational mode & atmosphere settings
    const mode = request.mode;
    const atmo: TileAtmosphereConfig = { ...(request.atmosphere || {}) };

    if (mode === 'full-texture' || mode === 'textured' || mode === 'photoreal') {
      atmo.renderMode = 'textured';
      atmo.exposure = atmo.exposure ?? 1.0;
    } else if (mode === 'greybox' || mode === 'graybox' || mode === 'clay') {
      atmo.renderMode = 'clay';
      atmo.clayPreset = atmo.clayPreset ?? (mode === 'greybox' || mode === 'graybox' ? 'studio-grey' : 'warm-clay');
      atmo.clayColor = atmo.clayColor ?? (atmo.clayPreset === 'studio-grey' ? '#b0b8c4' : '#dcd6cd');
      atmo.roughness = atmo.roughness ?? 0.82;
      atmo.metalness = atmo.metalness ?? 0.02;
      atmo.exposure = atmo.exposure ?? 1.15;
    } else if (!atmo.renderMode) {
      atmo.renderMode = 'clay';
    }

    const resolvedRequest: TileBlockoutPipelineRequest = {
      ...request,
      geoAnchor,
      cameraPath: cameraPathData,
      atmosphere: atmo
    };

    const isTexturedMode = atmo.renderMode === 'textured' || atmo.renderMode === 'photoreal' || atmo.renderMode === 'full-texture';
    const output = request.output || {};
    // Offline mock writes 1x1 placeholder frames/beats, a placeholder MP4 and a mock manifest. Its default
    // (non-explicit) outputs go to a temp dir so a mock run never overwrites the real committed blockout
    // assets under public/ (videos/frames_clay, storyboards_clay, images/blockout_frame_00.png, *_manifest.json).
    const defaultOutputRoot = request.offlineMock ? offlineMockOutputRoot() : process.cwd();

    const defaultGlbName = isTexturedMode ? 'google_tiles_textured_area.glb' : 'google_tiles_clay_area.glb';
    const outputGlbPath = output.outputGlbPath
      ? (path.isAbsolute(output.outputGlbPath) ? output.outputGlbPath : path.join(process.cwd(), output.outputGlbPath))
      : path.join(defaultOutputRoot, 'public/models', defaultGlbName);

    const outputVideoPath = output.outputVideoPath
      ? (path.isAbsolute(output.outputVideoPath) ? output.outputVideoPath : path.join(process.cwd(), output.outputVideoPath))
      : path.join(defaultOutputRoot, isTexturedMode ? 'public/videos/google_tiles_textured_blockout_camera.mp4' : 'public/videos/google_tiles_clay_blockout_camera.mp4');

    const framesDir = output.framesDir
      ? (path.isAbsolute(output.framesDir) ? output.framesDir : path.join(process.cwd(), output.framesDir))
      : path.join(defaultOutputRoot, isTexturedMode ? 'public/videos/frames_textured' : 'public/videos/frames_clay');

    const firstFramePath = output.firstFramePath
      ? (path.isAbsolute(output.firstFramePath) ? output.firstFramePath : path.join(process.cwd(), output.firstFramePath))
      : path.join(defaultOutputRoot, isTexturedMode ? 'public/models/blockout_textured_first_frame.jpg' : 'public/models/blockout_first_frame.jpg');

    const firstFramePngPath = output.firstFramePngPath
      ? (path.isAbsolute(output.firstFramePngPath) ? output.firstFramePngPath : path.join(process.cwd(), output.firstFramePngPath))
      : path.join(defaultOutputRoot, isTexturedMode ? 'public/images/blockout_textured_frame_00.png' : 'public/images/blockout_frame_00.png');

    const storyboardsDir = output.storyboardsDir
      ? (path.isAbsolute(output.storyboardsDir) ? output.storyboardsDir : path.join(process.cwd(), output.storyboardsDir))
      : path.join(defaultOutputRoot, isTexturedMode ? 'public/storyboards_textured' : 'public/storyboards_clay');

    const manifestPath = output.manifestPath
      ? (path.isAbsolute(output.manifestPath) ? output.manifestPath : path.join(process.cwd(), output.manifestPath))
      : path.join(defaultOutputRoot, isTexturedMode ? 'public/videos/google_tiles_textured_manifest.json' : 'public/videos/google_tiles_blockout_manifest.json');

    const fps = output.fps || cameraPathData.fps || 24;
    const storyboardBeats = output.storyboardBeats || 8;
    const bitrate = output.bitrate || '6M';
    const compileWebm = output.compileWebm !== false;

    // Ensure target directories exist
    fs.mkdirSync(path.dirname(outputGlbPath), { recursive: true });
    fs.mkdirSync(path.dirname(outputVideoPath), { recursive: true });
    fs.mkdirSync(framesDir, { recursive: true });
    fs.mkdirSync(path.dirname(firstFramePath), { recursive: true });
    fs.mkdirSync(path.dirname(firstFramePngPath), { recursive: true });
    fs.mkdirSync(storyboardsDir, { recursive: true });

    const storyboardPaths: string[] = [];
    const settleTimes: number[] = [];
    let maxTilesLoaded = 0;

    // Check offline mock mode (used for tests without Chrome/network)
    if (request.offlineMock) {
      return this.runOfflineMock(
        resolvedRequest,
        cameraPathData,
        outputVideoPath,
        outputGlbPath,
        framesDir,
        firstFramePath,
        firstFramePngPath,
        storyboardsDir,
        manifestPath,
        fps,
        storyboardBeats
      );
    }

    // The runner places its tangent frame at the ground, so it needs the measured ground height.
    if (geoAnchor.elevation === undefined) {
      geoAnchor.elevation = await this.fetchGroundElevation(geoAnchor.lat, geoAnchor.lng, request.apiKey);
      geoAnchor.elevationSource = 'google_elevation_api';
    }
    const htmlContent = this.generateRunnerHtml(resolvedRequest, cameraPathData);
    // The runner HTML is served from memory under a unique per-run route; nothing is written to disk.
    const runnerFileName = `s4d_tile_blockout_runner_${Date.now()}_${Math.floor(Math.random() * 100000)}.html`;

    const maxSettleWaitMs = request.lodQuality?.maxSettleWaitMs ?? 25000;
    const startupTimeoutMs = request.timeoutMs ?? 35000;
    const inactivityTimeoutMs = request.inactivityTimeoutMs ?? Math.max(60000, maxSettleWaitMs * 2 + 10000);
    const overallTimeoutMs = request.overallTimeoutMs
      ?? Math.max(5 * 60000, cameraPathData.totalFrames * (maxSettleWaitMs + 5000) + 120000);

    const requestedPort = request.port ?? 0;
    let actualPort = requestedPort;
    let receivedFrames = 0;
    let chromeProcess: ChildProcess | null = null;
    let chromeExitDescription: string | null = null;
    let chromeStderrTail = '';
    let chromeProfileDir: string | null = null;
    let watchdogTimer: NodeJS.Timeout | null = null;
    let collisionAuditData: any = null;
    let uploadedGlbBuffer: Buffer | null = null;
    let meshStats: Google3DTileMeshStats | null = null;
    let doneReceived = false;
    let settled = false;
    const startedAt = Date.now();
    let lastActivityAt = startedAt;

    return new Promise<TileBlockoutPipelineResult>((resolve, reject) => {
      const removeChromeProfileDir = () => {
        if (!chromeProfileDir) return;
        try {
          fs.rmSync(chromeProfileDir, { recursive: true, force: true });
          chromeProfileDir = null;
        } catch (_) {
          // Chrome may still be releasing files; the exit handler retries.
        }
      };

      const stopWatchdog = () => {
        if (watchdogTimer) {
          clearInterval(watchdogTimer);
          watchdogTimer = null;
        }
      };

      const killChrome = () => {
        if (chromeProcess && chromeProcess.exitCode === null && chromeProcess.signalCode === null) {
          try { chromeProcess.kill('SIGKILL'); } catch (_) {}
        }
      };

      const settleReject = (reason: string) => {
        if (settled) return;
        settled = true;
        stopWatchdog();
        killChrome();
        try { server.close(); } catch (_) {}
        removeChromeProfileDir();
        const tail = chromeStderrTail.trim();
        reject(new Error(
          `[Google 3D Tiles] Blockout render failed: ${reason}. ` +
          `Frames received: ${receivedFrames}/${cameraPathData.totalFrames}. ` +
          `Chrome binary: ${this.chromePath}` +
          (chromeExitDescription ? `; ${chromeExitDescription}` : '') +
          `. Set CHROME_BIN or pass headlessChromePath to point at a working Chrome/Chromium; ` +
          `pass offlineMock: true only for tests that must not launch a browser.` +
          (tail ? `\nChrome stderr (tail):\n${tail}` : '')
        ));
      };

      const settleResolve = (result: TileBlockoutPipelineResult) => {
        if (settled) return;
        settled = true;
        removeChromeProfileDir();
        resolve(result);
      };

      const server = http.createServer((req, res) => {
        const reqPath = req.url?.split('?')[0] || '';
        lastActivityAt = Date.now();

        if (req.method === 'POST' && reqPath === '/report-collision-audit') {
          let body = '';
          req.on('data', chunk => { body += chunk; });
          req.on('end', () => {
            try {
              collisionAuditData = JSON.parse(body);
              console.log(`🛡️ Collision & Clearance Audit: ${collisionAuditData.violationsDetected} violations, min clearance: ${typeof collisionAuditData.minClearanceMeters === 'number' ? collisionAuditData.minClearanceMeters.toFixed(1) : collisionAuditData.minClearanceMeters}m, adjusted: ${collisionAuditData.pathAdjusted}`);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ status: 'ok' }));
            } catch (err: any) {
              res.writeHead(400);
              res.end(err.message);
            }
          });
          return;
        }

        if (req.method === 'POST' && reqPath === '/upload-glb') {
          let body = '';
          req.on('data', chunk => { body += chunk; });
          req.on('end', () => {
            try {
              const payload = JSON.parse(body);
              if (payload.base64) {
                uploadedGlbBuffer = Buffer.from(payload.base64, 'base64');
                fs.writeFileSync(outputGlbPath, uploadedGlbBuffer);
                meshStats = payload.meshStats
                  || this.computeGlbMeshStats(uploadedGlbBuffer, `Google3DTile_${isTexturedMode ? 'textured' : 'clay'}`);
              }
              if (meshStats) {
                console.log(`📦 3D Tile Mesh Object exported: ${meshStats.vertexCount} vertices, ${meshStats.triangleCount} triangles -> ${outputGlbPath}`);
              }
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ status: 'ok' }));
            } catch (err: any) {
              res.writeHead(500);
              res.end(err.message);
            }
          });
          return;
        }

        if (req.method === 'POST' && reqPath === '/upload-frame') {
          let body = '';
          req.on('data', chunk => { body += chunk; });
          req.on('end', () => {
            try {
              lastActivityAt = Date.now();
              const payload = JSON.parse(body);
              const base64Data = payload.dataUrl.replace(/^data:image\/jpeg;base64,/, '');
              const buffer = Buffer.from(base64Data, 'base64');
              const filename = `frame_${String(payload.index).padStart(4, '0')}.jpg`;
              const frameFilePath = path.join(framesDir, filename);

              fs.writeFileSync(frameFilePath, buffer);

              if (typeof payload.settleTimeMs === 'number') {
                settleTimes.push(payload.settleTimeMs);
              }
              if (typeof payload.tilesLoaded === 'number' && payload.tilesLoaded > maxTilesLoaded) {
                maxTilesLoaded = payload.tilesLoaded;
              }

              // Extract Frame 0 for Stage 2 Nano Banana Restyling (<IMAGE_REF_0> precursor).
              // The PNG is transcoded from this JPEG by FFmpeg once recording completes.
              if (payload.index === 0) {
                fs.writeFileSync(firstFramePath, buffer);
              }

              // Save Storyboard beat keyframes
              const beatStep = Math.max(1, Math.floor(cameraPathData.totalFrames / storyboardBeats));
              if (payload.index % beatStep === 0 && Math.floor(payload.index / beatStep) < storyboardBeats) {
                const beatIdx = Math.floor(payload.index / beatStep);
                const beatFilename = `beat_${String(beatIdx).padStart(2, '0')}.jpg`;
                const beatPath = path.join(storyboardsDir, beatFilename);
                fs.writeFileSync(beatPath, buffer);
                storyboardPaths.push(beatPath);
              }

              receivedFrames++;
              if (receivedFrames % 12 === 0 || receivedFrames === cameraPathData.totalFrames) {
                console.log(`🎬 Captured 3D Tile Frame ${receivedFrames}/${cameraPathData.totalFrames} (${Math.round((receivedFrames / cameraPathData.totalFrames) * 100)}%)`);
              }

              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ status: 'ok' }));
            } catch (err: any) {
              res.writeHead(500);
              res.end(err.message);
            }
          });
          return;
        }

        if (req.method === 'POST' && reqPath === '/done') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'complete' }));
          if (settled || doneReceived) return;
          doneReceived = true;
          stopWatchdog();

          console.log(`🎉 ${receivedFrames}/${cameraPathData.totalFrames} 3D tile frames received! Compiling video via FFmpeg...`);
          killChrome();

          if (receivedFrames === 0) {
            settleReject('Runner signalled completion without uploading any frames');
            return;
          }

          (async () => {
            try {
              server.close();
              const frameGlob = path.join(framesDir, 'frame_%04d.jpg');
              // Compile MP4 and optionally WebM via FFmpeg (argument arrays: no shell interpolation of paths)
              try {
                await execFileAsync(this.ffmpegPath, [
                  '-y', '-framerate', String(fps), '-i', frameGlob,
                  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-b:v', String(bitrate), outputVideoPath
                ], { maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60000 });
              } catch (ffmpegErr: any) {
                throw new Error(`FFmpeg MP4 encoding failed (${this.ffmpegPath}): ${ffmpegErr.message}\n${ffmpegErr.stderr || ''}`);
              }

              try {
                await execFileAsync(this.ffmpegPath, ['-y', '-i', firstFramePath, firstFramePngPath], { timeout: 60000 });
              } catch (pngErr: any) {
                throw new Error(`FFmpeg failed to transcode Frame 0 to PNG (${firstFramePngPath}): ${pngErr.message}\n${pngErr.stderr || ''}`);
              }

              // Set only when this run's WebM encode succeeds, so an older file at that path is never reported.
              let webmVideoPath: string | undefined;
              if (compileWebm) {
                const webmPath = outputVideoPath.replace(/\.mp4$/, '.webm');
                try {
                  await execFileAsync(this.ffmpegPath, [
                    '-y', '-framerate', String(fps), '-i', frameGlob, '-c:v', 'libvpx-vp9', '-b:v', '4M', webmPath
                  ], { maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60000 });
                  webmVideoPath = webmPath;
                } catch (e: any) {
                  // WebM is an optional secondary encode; the MP4 above is the canonical output.
                  console.warn(`[Google 3D Tiles] Optional WebM encode failed: ${e?.message || e}`);
                }
              }

              if (!uploadedGlbBuffer || !meshStats) {
                throw new Error(
                  `Runner finished recording (${receivedFrames} frames, video at ${outputVideoPath}) but never exported the 3D tile GLB ` +
                  `(GLTFExporter failed or no tiles were loaded); refusing to report a mesh for ${outputGlbPath}`
                );
              }

              const avgSettle = settleTimes.length > 0
                ? settleTimes.reduce((a, b) => a + b, 0) / settleTimes.length
                : 0;

              const collisionAudit = collisionAuditData || (() => {
                // Runner did not report an audit: compute it analytically from the camera path.
                const audit = this.auditCameraClearance(cameraPathData, request.collision?.minClearanceMeters ?? 5.0);
                return {
                  enabled: request.collision?.enabled ?? true,
                  violationsDetected: audit.violationsDetected,
                  minClearanceMeters: audit.minClearanceMeters,
                  maxElevationAdjustment: 0,
                  pathAdjusted: false,
                  auditPassed: audit.auditPassed
                };
              })();

              const manifest = {
                version: '1.0.0',
                timestamp: new Date().toISOString(),
                videoRef: '<VIDEO_REF_0>',
                mock: false,
                outputVideoPath,
                outputGlbPath,
                firstFramePath,
                firstFramePngPath,
                storyboardPaths,
                fps,
                totalFrames: cameraPathData.totalFrames,
                durationSec: cameraPathData.durationSec,
                geoAnchor: request.geoAnchor,
                errorTarget: request.lodQuality?.errorTarget ?? 0.5,
                renderMode: request.atmosphere?.renderMode ?? 'clay',
                mesh: meshStats,
                collisionAudit,
                tileMetrics: {
                  totalFramesCaptured: receivedFrames,
                  averageSettleTimeMs: Math.round(avgSettle),
                  maxTilesLoaded,
                  errorTarget: request.lodQuality?.errorTarget ?? 0.5,
                  renderMode: request.atmosphere?.renderMode ?? 'clay'
                }
              };

              fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

              settleResolve({
                success: true,
                mock: false,
                videoRef: '<VIDEO_REF_0>',
                outputVideoPath,
                ...(webmVideoPath ? { webmVideoPath } : {}),
                glbBuffer: uploadedGlbBuffer,
                glbPath: outputGlbPath,
                mesh: meshStats,
                firstFramePath,
                firstFramePngPath,
                storyboardPaths,
                manifestPath,
                frameCount: receivedFrames,
                fps,
                durationSec: cameraPathData.durationSec,
                geoAnchor: resolvedRequest.geoAnchor!,
                resolvedAddress: resolvedRequest.geoAnchor!.formattedAddress ?? resolvedRequest.address,
                collisionAudit: manifest.collisionAudit,
                tileMetrics: manifest.tileMetrics,
                manifest
              });
            } catch (err: any) {
              settleReject(err?.message || String(err));
            }
          })();
          return;
        }

        // Serve HTML runner
        if (reqPath === '/' || reqPath === '/s4d_tile_blockout_runner.html' || reqPath === `/${runnerFileName}`) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          return res.end(htmlContent);
        }

        // Serve client error reporting
        if (req.method === 'POST' && reqPath === '/client-error') {
          let body = '';
          req.on('data', chunk => { body += chunk; });
          req.on('end', () => {
            console.error('[Google 3D Tiles Chrome Error]:', body);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'logged' }));
          });
          return;
        }

        // Serve local node_modules or assets from monorepo root or process.cwd()
        const cleanPath = reqPath.replace(/^\//, '');
        const candidatePaths = [
          path.join(process.cwd(), cleanPath),
          path.resolve(process.cwd(), '../', cleanPath),
          path.resolve(process.cwd(), '../../', cleanPath),
          path.resolve(__dirname, '../../../', cleanPath),
          path.resolve(__dirname, '../../../../', cleanPath),
          path.resolve(__dirname, '../../../../../', cleanPath)
        ];
        const localFile = candidatePaths.find(p => {
          try {
            return fs.existsSync(p) && fs.statSync(p).isFile();
          } catch (_) {
            return false;
          }
        });
        if (localFile) {
          const ext = path.extname(localFile);
          const mimeMap: Record<string, string> = {
            '.html': 'text/html',
            '.js': 'application/javascript',
            '.mjs': 'application/javascript',
            '.json': 'application/json',
            '.glb': 'model/gltf-binary',
            '.jpg': 'image/jpeg',
            '.png': 'image/png'
          };
          res.writeHead(200, {
            'Content-Type': mimeMap[ext] || 'application/octet-stream',
            'Access-Control-Allow-Origin': '*'
          });
          fs.createReadStream(localFile).pipe(res);
        } else {
          res.writeHead(404);
          res.end('Not found: ' + reqPath);
        }
      });

      server.on('error', (err: NodeJS.ErrnoException) => {
        settleReject(`Blockout recorder HTTP server error on 127.0.0.1:${requestedPort}: ${err.message}`);
      });

      server.listen(requestedPort, '127.0.0.1', () => {
        const addr = server.address();
        actualPort = typeof addr === 'object' && addr ? addr.port : requestedPort;
        console.log(`🌐 3D Tile blockout recorder server running on http://127.0.0.1:${actualPort}`);

        chromeProfileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome_tile_blockout_'));
        const args = [
          '--headless=new',
          `--user-data-dir=${chromeProfileDir}`,
          '--no-sandbox',
          '--no-proxy-server',
          '--proxy-bypass-list=*',
          '--use-gl=angle',
          ...(process.platform === 'darwin' ? ['--use-angle=metal'] : []),
          '--run-all-compositor-stages-before-draw',
          '--disable-gpu-vsync',
          '--disable-frame-rate-limit',
          `--window-size=${request.lodQuality?.resolutionWidth ?? 1280},${request.lodQuality?.resolutionHeight ?? 720}`,
          `http://127.0.0.1:${actualPort}/${runnerFileName}?mode=${encodeURIComponent(request.atmosphere?.renderMode || 'clay')}`
        ];

        console.log(`🚀 Launching headless Chrome (${this.chromePath}) with profile ${chromeProfileDir}`);
        const cleanEnv = { ...process.env };
        delete cleanEnv.http_proxy;
        delete cleanEnv.https_proxy;
        delete cleanEnv.all_proxy;
        delete cleanEnv.HTTP_PROXY;
        delete cleanEnv.HTTPS_PROXY;
        delete cleanEnv.ALL_PROXY;

        const proc = spawn(this.chromePath, args, { env: cleanEnv });
        chromeProcess = proc;

        // Startup, inactivity and overall deadlines: a stall at any point (before or after the first frame)
        // kills Chrome, closes the server and rejects instead of hanging forever.
        watchdogTimer = setInterval(() => {
          if (settled || doneReceived) return;
          const now = Date.now();
          if (receivedFrames === 0 && now - startedAt > startupTimeoutMs) {
            settleReject(`Headless Chrome produced no frames within the ${startupTimeoutMs}ms startup timeout`);
          } else if (now - lastActivityAt > inactivityTimeoutMs) {
            settleReject(`Headless Chrome stalled: no runner activity for ${inactivityTimeoutMs}ms`);
          } else if (now - startedAt > overallTimeoutMs) {
            settleReject(`Blockout render exceeded the ${overallTimeoutMs}ms overall timeout`);
          }
        }, Math.max(50, Math.min(1000, Math.floor(startupTimeoutMs / 4))));

        proc.stdout?.on('data', (d: Buffer) => console.log('[Chrome]:', d.toString().trim()));
        proc.stderr?.on('data', (d: Buffer) => {
          const s = d.toString();
          chromeStderrTail = (chromeStderrTail + s).slice(-4000);
          const trimmed = s.trim();
          if (!trimmed.includes('GLX') && !trimmed.includes('dbus')) {
            console.log('[Chrome]:', trimmed);
          }
        });
        proc.on('error', (err: Error) => {
          settleReject(`Headless Chrome failed to launch: ${err.message}`);
        });

        proc.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
          chromeExitDescription = `Chrome exited with code ${code}${signal ? ` (signal ${signal})` : ''}`;
          if (!doneReceived) {
            settleReject(`Headless Chrome exited before the runner finished (code ${code}${signal ? `, signal ${signal}` : ''})`);
          }
          removeChromeProfileDir();
        });
      });
    });
  }

  /**
   * Explicit opt-in offline mock (`offlineMock: true`) for unit tests that must not launch a browser or touch the network.
   * Never used as a fallback: every artifact it writes is placeholder data, and the result/manifest carry `mock: true`.
   */
  private async runOfflineMock(
    request: TileBlockoutPipelineRequest,
    cameraPathData: CameraPathData,
    outputVideoPath: string,
    outputGlbPath: string,
    framesDir: string,
    firstFramePath: string,
    firstFramePngPath: string,
    storyboardsDir: string,
    manifestPath: string,
    fps: number,
    storyboardBeats: number
  ): Promise<TileBlockoutPipelineResult> {
    const storyboardPaths: string[] = [];

    // Minimal valid 1x1 placeholder images (JPEG for frames/beats, PNG for the Frame 0 PNG path)
    const mockJpgBuffer = Buffer.from(
      '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
      'base64'
    );
    const mockPngBuffer = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64'
    );

    for (let i = 0; i < cameraPathData.totalFrames; i++) {
      const filename = `frame_${String(i).padStart(4, '0')}.jpg`;
      const frameFilePath = path.join(framesDir, filename);
      fs.writeFileSync(frameFilePath, mockJpgBuffer);

      if (i === 0) {
        fs.writeFileSync(firstFramePath, mockJpgBuffer);
        fs.writeFileSync(firstFramePngPath, mockPngBuffer);
      }

      const beatStep = Math.max(1, Math.floor(cameraPathData.totalFrames / storyboardBeats));
      if (i % beatStep === 0 && Math.floor(i / beatStep) < storyboardBeats) {
        const beatIdx = Math.floor(i / beatStep);
        const beatFilename = `beat_${String(beatIdx).padStart(2, '0')}.jpg`;
        const beatPath = path.join(storyboardsDir, beatFilename);
        fs.writeFileSync(beatPath, mockJpgBuffer);
        storyboardPaths.push(beatPath);
      }
    }

    // Placeholder (non-playable) video marker; never overwrite an existing real video
    if (!fs.existsSync(outputVideoPath) || fs.statSync(outputVideoPath).size <= 100) {
      fs.writeFileSync(outputVideoPath, Buffer.from('offline-mock placeholder: not a real MP4'));
    }

    // Synthetic geodetic tile packed as binary glTF 2.0 (.glb). Never reuse a pre-existing (possibly stale or
    // production) GLB at the output path: if one exists, write the mock to a clearly named sibling instead.
    const isTextured = request.mode === 'full-texture' || request.mode === 'textured' || request.atmosphere?.renderMode === 'textured';
    const originAlt = {
      lat: request.geoAnchor!.lat,
      lng: request.geoAnchor!.lng,
      alt: request.geoAnchor!.elevation ?? 0
    };
    const mockGlbPath = fs.existsSync(outputGlbPath)
      ? outputGlbPath.replace(/(\.glb)?$/i, '.offline_mock.glb')
      : outputGlbPath;
    const syntheticTile = Google3DTileCrawlerBaker.createSyntheticGeodeticTile(originAlt, 200);
    const mergedGlb = Google3DTileCrawlerBaker.mergeTileMeshes([syntheticTile], originAlt).glbBuffer;
    fs.writeFileSync(mockGlbPath, mergedGlb);
    const meshStats = this.computeGlbMeshStats(mergedGlb, `Google3DTile_${isTextured ? 'textured' : 'clay'}_offline_mock`);
    if (!meshStats) throw new Error(`Could not read mesh statistics from synthetic offline-mock tile ${mockGlbPath}`);

    const collisionAudit = this.auditCameraClearance(
      cameraPathData,
      request.collision?.minClearanceMeters ?? 5.0
    );

    const manifest = {
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      videoRef: '<VIDEO_REF_0>',
      mock: true,
      outputVideoPath,
      outputGlbPath: mockGlbPath,
      firstFramePath,
      firstFramePngPath,
      storyboardPaths,
      fps,
      totalFrames: cameraPathData.totalFrames,
      durationSec: cameraPathData.durationSec,
      geoAnchor: request.geoAnchor,
      errorTarget: request.lodQuality?.errorTarget ?? 0.5,
      renderMode: request.atmosphere?.renderMode ?? 'clay',
      mesh: meshStats,
      collisionAudit: {
        enabled: request.collision?.enabled ?? true,
        violationsDetected: collisionAudit.violationsDetected,
        minClearanceMeters: collisionAudit.minClearanceMeters,
        maxElevationAdjustment: 0,
        pathAdjusted: false,
        auditPassed: collisionAudit.auditPassed
      },
      tileMetrics: {
        // No tiles were streamed in offline mock mode: settle/tile metrics are zero, not fabricated.
        totalFramesCaptured: cameraPathData.totalFrames,
        averageSettleTimeMs: 0,
        maxTilesLoaded: 0,
        errorTarget: request.lodQuality?.errorTarget ?? 0.5,
        renderMode: request.atmosphere?.renderMode ?? 'clay'
      }
    };

    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    return {
      success: true,
      mock: true,
      videoRef: '<VIDEO_REF_0>',
      outputVideoPath,
      glbBuffer: mergedGlb,
      glbPath: mockGlbPath,
      mesh: meshStats,
      firstFramePath,
      firstFramePngPath,
      storyboardPaths,
      manifestPath,
      frameCount: cameraPathData.totalFrames,
      fps,
      durationSec: cameraPathData.durationSec,
      geoAnchor: request.geoAnchor!,
      resolvedAddress: request.geoAnchor!.formattedAddress ?? request.address,
      collisionAudit: manifest.collisionAudit,
      tileMetrics: manifest.tileMetrics,
      manifest
    };
  }

  /**
   * Builds mesh statistics (counts + POSITION accessor bounds) directly from a binary glTF buffer.
   */
  private computeGlbMeshStats(glbBuffer: Buffer, name: string): Google3DTileMeshStats | null {
    const stats = this.parseGlbMeshStatistics(glbBuffer);
    if (!stats || !stats.bounds) return null;
    const { min, max } = stats.bounds;
    const center: [number, number, number] = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    return {
      name,
      vertexCount: stats.vertexCount,
      triangleCount: stats.triangleCount,
      submeshCount: stats.submeshCount,
      boundingBox: { min, max },
      boundingSphere: {
        center,
        radius: Math.hypot((max[0] - min[0]) / 2, (max[1] - min[1]) / 2, (max[2] - min[2]) / 2)
      }
    };
  }

  /**
   * Fast binary glTF 2.0 chunk-0 JSON parser to extract exact geometry statistics.
   */
  private parseGlbMeshStatistics(glbBuffer: Buffer): {
    vertexCount: number;
    triangleCount: number;
    submeshCount: number;
    bounds?: { min: [number, number, number]; max: [number, number, number] };
  } | null {
    try {
      if (glbBuffer.length < 20) return null;
      const magic = glbBuffer.toString('utf8', 0, 4);
      if (magic !== 'glTF') return null;
      const jsonLength = glbBuffer.readUInt32LE(12);
      const jsonType = glbBuffer.readUInt32LE(16);
      if (jsonType !== 0x4e4f534a) return null; // JSON chunk 'JSON'
      const jsonStr = glbBuffer.toString('utf8', 20, 20 + jsonLength);
      const gltf = JSON.parse(jsonStr);
      let vertexCount = 0;
      let triangleCount = 0;
      let submeshCount = 0;
      let bounds: { min: [number, number, number]; max: [number, number, number] } | undefined;
      if (Array.isArray(gltf.meshes) && Array.isArray(gltf.accessors)) {
        for (const mesh of gltf.meshes) {
          if (!mesh.primitives) continue;
          for (const prim of mesh.primitives) {
            submeshCount++;
            if (prim.attributes && prim.attributes.POSITION !== undefined) {
              const acc = gltf.accessors[prim.attributes.POSITION];
              if (acc && typeof acc.count === 'number') vertexCount += acc.count;
              // glTF 2.0 requires min/max on POSITION accessors; use them for exact local bounds
              if (acc && Array.isArray(acc.min) && Array.isArray(acc.max) && acc.min.length >= 3 && acc.max.length >= 3) {
                if (!bounds) {
                  bounds = { min: [acc.min[0], acc.min[1], acc.min[2]], max: [acc.max[0], acc.max[1], acc.max[2]] };
                } else {
                  for (let k = 0; k < 3; k++) {
                    bounds.min[k] = Math.min(bounds.min[k], acc.min[k]);
                    bounds.max[k] = Math.max(bounds.max[k], acc.max[k]);
                  }
                }
              }
            }
            if (prim.indices !== undefined) {
              const acc = gltf.accessors[prim.indices];
              if (acc && typeof acc.count === 'number') triangleCount += Math.floor(acc.count / 3);
            }
          }
        }
      }
      return { vertexCount, triangleCount, submeshCount: Math.max(1, submeshCount), bounds };
    } catch {
      return null;
    }
  }

  /**
   * Extracts the area around a place or coordinate from Google Photorealistic 3D Tiles as a binary glTF.
   *
   * The direct leaf crawler is the only engine. A crawl, download or parse failure throws TileExtractionError
   * naming the stage, and a place without tile coverage throws instead of returning anything else; the headless
   * blockout runner is its own tool (runTileClayBlockoutRunner) and never stands in for this. The ground height
   * is measured from the tiles. `offlineMock` is a test-only option that returns a synthetic tile marked `mock`.
   */
  public async fetch3DObject(
    queryOrCoords: string | GeoAnchor,
    mode: 'full-texture' | 'clay',
    options?: Google3DTilesQueryOptions
  ): Promise<Google3DTile3DObjectResult> {
    // A stop aborts every request this extraction makes and is checked between stages, so a stopped chat does not
    // leave tile downloads or the GLB write running.
    const signal = options?.signal;
    const stopIfAborted = () => {
      if (signal?.aborted) throw extractionStopped(signal);
    };
    const baseFetch = options?.fetchImpl ?? fetch;
    const fetchImpl: typeof fetch | undefined = signal
      ? (((input: any, init?: RequestInit) => baseFetch(input, { ...(init || {}), signal })) as typeof fetch)
      : options?.fetchImpl;

    stopIfAborted();
    const geoAnchor = await this.resolveAddress(queryOrCoords, options?.apiKey, fetchImpl);
    const resolvedAddress = geoAnchor.formattedAddress ?? formatCoordinates(geoAnchor.lat, geoAnchor.lng);
    stopIfAborted();

    const isTextured = mode === 'full-texture';
    const repoRoot = process.env.SCRATCHBOX_ROOT || (fs.existsSync(path.resolve(process.cwd(), 'packages')) ? process.cwd() : path.resolve(process.cwd(), '..'));
    // The caller's outputDir, else public/models. A mock run's placeholder GLB never lands next to real extractions,
    // where later lookups would take it for one.
    const canonicalModelsDir = options?.outputDir
      ? path.resolve(options.outputDir)
      : options?.offlineMock
        ? path.join(offlineMockOutputRoot(), 'public/models')
        : path.resolve(repoRoot, 'public/models');
    const radiusMeters = options?.radiusMeters || 250;
    // The default file is keyed by where and how much was extracted, not by the place's name: two places Google
    // names alike ("Park Avenue" in New York and in Winter Park) must not overwrite each other's model.
    const nameSlug = (geoAnchor.landmarkName || (typeof queryOrCoords === 'string' ? queryOrCoords : 'district')).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'district';
    const placeKey = `${geoAnchor.lat.toFixed(5)}_${geoAnchor.lng.toFixed(5)}_r${Math.round(radiusMeters)}`;
    const defaultGlbName = `${nameSlug}_${placeKey}_${isTextured ? 'textured' : 'clay'}.glb`;

    const outputGlbPath = options?.outputGlbPath
      ? (path.isAbsolute(options.outputGlbPath) ? options.outputGlbPath : path.resolve(canonicalModelsDir, path.basename(options.outputGlbPath)))
      : path.join(canonicalModelsDir, defaultGlbName);

    if (options?.offlineMock) {
      return this.fetchOfflineMock(geoAnchor, resolvedAddress, mode, outputGlbPath, options);
    }

    const apiKey = resolveMapsApiKey(options?.apiKey);
    if (!apiKey) {
      throw new TileExtractionError('crawl', 'no Google Maps API key is configured, so Photorealistic 3D Tiles cannot be downloaded (add the key in Settings)');
    }

    const cacheDir = path.join(process.cwd(), '.scratchbox', 'tiles_cache', 'leaves');
    const crawler = new GoogleTileDistrictCrawler({ apiKey, cacheDir, fetchImpl });
    // Only seeds the local frame; the ground height is measured from the tile geometry below.
    const anchor = {
      lat: geoAnchor.lat,
      lng: geoAnchor.lng,
      heightGuessM: (geoAnchor.elevation ?? 0) + geoidUndulation(geoAnchor.lat, geoAnchor.lng)
    };

    let collected: Awaited<ReturnType<GoogleTileDistrictCrawler['collectLeafTiles']>>;
    try {
      collected = await crawler.collectLeafTiles(anchor, radiusMeters);
    } catch (err) {
      stopIfAborted();
      // A radius that selects too many leaves is the caller's to fix; it keeps its own type.
      if (err instanceof DistrictTooLargeError) throw err;
      throw new TileExtractionError('crawl', err);
    }
    stopIfAborted();
    const { leaves, session } = collected;
    if (!leaves || leaves.length === 0) {
      throw new TileExtractionError('crawl', `no Photorealistic 3D Tiles coverage at ${formatCoordinates(geoAnchor.lat, geoAnchor.lng)} (${resolvedAddress})`);
    }

    const maxLeaves = options?.maxLeaves || 524;
    // Sort leaves by 3D distance from anchor in ECEF space so the central landmark is 100% contiguous and complete
    const anchorFrame = GoogleTileDistrictCrawler.localFrame(anchor.lat, anchor.lng, anchor.heightGuessM);
    const sortedLeaves = [...leaves].sort((a, b) => {
      const distA = Math.hypot(a.box[0] - anchorFrame.origin[0], a.box[1] - anchorFrame.origin[1], a.box[2] - anchorFrame.origin[2]);
      const distB = Math.hypot(b.box[0] - anchorFrame.origin[0], b.box[1] - anchorFrame.origin[1], b.box[2] - anchorFrame.origin[2]);
      return distA - distB;
    });
    const leafSubset = sortedLeaves.length > maxLeaves ? sortedLeaves.slice(0, maxLeaves) : sortedLeaves;
    // The cap drops the leaves whose centres lie farthest from the anchor, so the district is complete only out to
    // the nearest dropped leaf's footprint. (A leaf without a box cannot be placed; it does not shorten the radius.)
    const droppedLeaves = sortedLeaves.slice(leafSubset.length);
    const truncated = droppedLeaves.length > 0;
    const coveredRadiusMeters = truncated
      ? Math.floor(droppedLeaves.reduce(
        (r, leaf) => (leaf.box.length >= 12 ? Math.min(r, GoogleTileDistrictCrawler.footprintDistance(leaf.box, anchorFrame)) : r),
        radiusMeters
      ))
      : radiusMeters;

    let buffers: Buffer[];
    let downloadRanks: number[] = [];
    const fetchedAt = new Date().toISOString();
    try {
      buffers = await crawler.downloadLeaves(leafSubset, session, (index, rank) => { downloadRanks[index] = rank; });
    } catch (err) {
      stopIfAborted();
      throw new TileExtractionError('download', err);
    }
    stopIfAborted();

    let parsed: ReturnType<typeof GoogleTileDistrictCrawler.parseLeafGlbPrimitives>;
    let district: ReturnType<typeof GoogleTileDistrictCrawler.buildDistrictGlb>;
    let geometryDistrict: ReturnType<typeof GoogleTileDistrictCrawler.buildDistrictGlb> | undefined;
    try {
      parsed = buffers.flatMap((b, i) => GoogleTileDistrictCrawler.parseLeafGlbPrimitives(b, leafSubset[i].id));
      district = GoogleTileDistrictCrawler.buildDistrictGlb(parsed, anchor, {
        clay: mode === 'clay',
        clayPreset: options?.clayPreset || 'studio-grey',
        groundSearchRadiusM: Math.min(radiusMeters, 80)
      });
      // The first staged layer is built from the same leaves in the same frame (the origin is the textured build's, so
      // both GLBs line up exactly), so the viewer can show the tiles before the textured model is touched.
      if (options?.geometryGlbPath) {
        geometryDistrict = GoogleTileDistrictCrawler.buildDistrictGlb(parsed, anchor, {
          geometryOnly: true,
          clayPreset: options?.clayPreset || 'studio-grey',
          originEllipsoidalHeightM: district.originEllipsoidalHeightM
        });
      }
    } catch (err) {
      throw new TileExtractionError('parse', err);
    }

    fs.mkdirSync(path.dirname(outputGlbPath), { recursive: true });
    fs.writeFileSync(outputGlbPath, district.glb);
    if (options?.geometryGlbPath && geometryDistrict) {
      fs.mkdirSync(path.dirname(options.geometryGlbPath), { recursive: true });
      fs.writeFileSync(options.geometryGlbPath, geometryDistrict.glb);
    }

    // The street surface measured in the tiles, as height above sea level, when the caller stated none.
    if (geoAnchor.elevation === undefined) {
      geoAnchor.elevation = Number((district.originEllipsoidalHeightM - geoidUndulation(geoAnchor.lat, geoAnchor.lng)).toFixed(2));
      geoAnchor.elevationSource = 'tiles_ground';
    }

    const mesh: Google3DTileMeshStats = {
      name: `Google3DTile_${mode}`,
      vertexCount: district.vertexCount,
      triangleCount: district.triangleCount,
      submeshCount: parsed.length,
      boundingBox: { min: district.boundsLocal.min, max: district.boundsLocal.max },
      boundingSphere: {
        center: [
          (district.boundsLocal.min[0] + district.boundsLocal.max[0]) / 2,
          (district.boundsLocal.min[1] + district.boundsLocal.max[1]) / 2,
          (district.boundsLocal.min[2] + district.boundsLocal.max[2]) / 2
        ],
        radius: Math.hypot(
          (district.boundsLocal.max[0] - district.boundsLocal.min[0]) / 2,
          (district.boundsLocal.max[1] - district.boundsLocal.min[1]) / 2,
          (district.boundsLocal.max[2] - district.boundsLocal.min[2]) / 2
        )
      }
    };

    return {
      success: true,
      mode,
      geoAnchor,
      resolvedAddress,
      glbBuffer: district.glb,
      glbPath: outputGlbPath,
      frame: { lat: anchor.lat, lng: anchor.lng, originEllipsoidalHeightM: district.originEllipsoidalHeightM, localToEcef: district.localToEcef },
      requestedRadiusMeters: radiusMeters,
      coveredRadiusMeters,
      truncated,
      leafTiles: { kept: leafSubset.length, selected: sortedLeaves.length },
      leafIds: leafSubset.map(l => l.id),
      copyrights: district.copyrights,
      fetchedAt,
      leafGeometricErrorM: Math.max(...leafSubset.map(leaf => leaf.geometricError)),
      downloadOrder: Object.fromEntries(leafSubset.map((l, i) => [l.id, downloadRanks[i] ?? 0])),
      ...(options?.geometryGlbPath && geometryDistrict ? { geometryGlbPath: options.geometryGlbPath } : {}),
      mesh,
      // What the crawl measured: it selects leaf tiles directly (no viewport, no screen-space error, no settle) and
      // renders nothing, so there is no resolution, settle state or render block to report.
      quality: {
        source: 'Google Maps Platform Photorealistic 3D Tiles API (direct leaf-tile crawl)',
        errorTarget: Math.max(...leafSubset.map(leaf => leaf.geometricError)),
        asynchronousSettle: false
      },
      manifest: {
        resolvedAddress,
        geoAnchor,
        mesh
      }
    };
  }

  /** Test-only synthetic tile (`offlineMock`): every artifact is placeholder data and the result says `mock: true`. */
  private async fetchOfflineMock(
    geoAnchor: GeoAnchor,
    resolvedAddress: string,
    mode: 'full-texture' | 'clay',
    outputGlbPath: string,
    options: Google3DTilesQueryOptions
  ): Promise<Google3DTile3DObjectResult> {
    const isTextured = mode === 'full-texture';
    const result = await this.run({
      geoAnchor,
      cameraPath: options.cameraPath || this.createFullOrbitTrajectory(geoAnchor, { corridorRadiusMeters: options.radiusMeters }),
      mode,
      offlineMock: true,
      atmosphere: {
        renderMode: isTextured ? 'textured' : 'clay',
        clayPreset: options.clayPreset ?? 'studio-grey'
      },
      output: {
        outputGlbPath,
        outputVideoPath: options.outputVideoPath,
        fps: options.fps ?? 24
      }
    });
    if (!result.mesh || !result.glbBuffer || result.glbBuffer.length === 0) {
      throw new TileExtractionError('parse', `the offline mock produced no mesh for ${outputGlbPath}`);
    }
    return {
      success: true,
      mock: true,
      mode,
      geoAnchor,
      resolvedAddress,
      glbBuffer: result.glbBuffer,
      glbPath: result.glbPath || outputGlbPath,
      mesh: result.mesh,
      quality: {
        source: 'offline mock (synthetic placeholder, not Google tiles)',
        errorTarget: options.lodQuality?.errorTarget ?? 0.5,
        asynchronousSettle: false,
        leafLodSettled: false
      },
      render: {
        videoPath: result.outputVideoPath,
        firstFramePath: result.firstFramePath,
        storyboardPaths: result.storyboardPaths,
        fps: result.fps,
        frameCount: result.frameCount,
        durationSec: result.durationSec
      },
      manifest: result.manifest
    };
  }
}

/**
 * Resolves coordinates or a place name (one Google Places Text Search call) to a GeoAnchor; see resolveAddress.
 */
export async function geocode3DTilesAddress(queryOrCoords?: string | GeoAnchor, apiKey?: string, fetchImpl?: typeof fetch): Promise<GeoAnchor> {
  const service = new Google3DTileBlockoutPipelineService();
  return service.resolveAddress(queryOrCoords, apiKey, fetchImpl);
}

/**
 * Convenience helper to create a high-fidelity 72-frame flight corridor with waypoints [0, 18, 36, 54, 71].
 */
export function create3DTilesTrajectory(
  anchor: GeoAnchor,
  options?: {
    fps?: number;
    durationSec?: number;
    corridorRadiusMeters?: number;
    startAltitudeMeters?: number;
    endAltitudeMeters?: number;
    fov?: number;
  }
): CameraPathData {
  const service = new Google3DTileBlockoutPipelineService();
  return service.createDefaultTrajectory(anchor, options);
}

/**
 * Top-level Codebase API function to run the high-fidelity Google 3D Tiles blockout pipeline.
 * Supports arbitrary addresses, full texture, and grey box modes.
 */
export async function runGoogle3DTilesPipeline(
  request: TileBlockoutPipelineRequest
): Promise<TileBlockoutPipelineResult> {
  const service = new Google3DTileBlockoutPipelineService(
    request.headlessChromePath,
    request.ffmpegPath
  );
  return service.run(request);
}

/** The error a stopped extraction rejects with: the signal's own reason, else an AbortError. */
function extractionStopped(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : Object.assign(new Error('Google 3D Tiles extraction was stopped'), { name: 'AbortError' });
}

/** Per-call temp root for offline-mock placeholder outputs that were not given an explicit path. */
function offlineMockOutputRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-tile-blockout-mock-'));
}

/**
 * Dedicated API to query any address or coordinates and return the area as a high-fidelity full-texture 3D object (.glb).
 * Zero presets, no procedural fallback. Demands leaf LOD geometric quality (errorTarget <= 0.5).
 */
export async function getGoogle3DTilesFullTexture(
  query: string | GeoAnchor,
  options?: Google3DTilesQueryOptions
): Promise<Google3DTile3DObjectResult> {
  const service = new Google3DTileBlockoutPipelineService();
  return service.fetch3DObject(query, 'full-texture', options);
}

/**
 * Dedicated API to query any address or coordinates and return the area as a high-fidelity grey box / clay 3D object (.glb).
 * Zero presets, no procedural fallback. Demands leaf LOD geometric quality (errorTarget <= 0.5).
 */
export async function getGoogle3DTilesClay(
  query: string | GeoAnchor,
  options?: Google3DTilesQueryOptions
): Promise<Google3DTile3DObjectResult> {
  const service = new Google3DTileBlockoutPipelineService();
  return service.fetch3DObject(query, 'clay', options);
}

/**
 * Convenience helper to create a complete 360-degree orbital flight corridor.
 */
export function create3DTilesOrbitTrajectory(
  anchor: GeoAnchor,
  options?: {
    fps?: number;
    durationSec?: number;
    corridorRadiusMeters?: number;
    altitudeMeters?: number;
    targetElevation?: number;
    fov?: number;
    physicalCamera?: PhysicalCameraConfig;
  }
): CameraPathData {
  const service = new Google3DTileBlockoutPipelineService();
  return service.createFullOrbitTrajectory(anchor, options);
}

/**
 * Convenience helper to create a linear or gentle-curve push-in flight corridor along a street canyon or facade axis.
 */
export function create3DTilesPushInTrajectory(
  anchor: GeoAnchor,
  options?: {
    fps?: number;
    durationSec?: number;
    corridorDistanceMeters?: number;
    startAltitudeMeters?: number;
    endAltitudeMeters?: number;
    targetElevation?: number;
    headingDeg?: number;
    fov?: number;
    physicalCamera?: PhysicalCameraConfig;
  }
): CameraPathData {
  const service = new Google3DTileBlockoutPipelineService();
  return service.createPushInTrajectory(anchor, options);
}

/**
 * Canonical high-level execution API for the Google Maps 3D Tile Clay Blockout Runner.
 *
 * Automatically resolves coordinates, generates the requested 6-DoF trajectory,
 * runs headless WebGL rendering with studio grey clay PBR material and collision avoidance,
 * and returns <VIDEO_REF_0>, startFramePngPath (Frame 0 PNG for AI Beautify -> <IMAGE_REF_0>),
 * and the extracted .glb volumetric massing.
 */
export async function runTileClayBlockoutRunner(
  request: TileClayBlockoutRunnerRequest
): Promise<TileClayBlockoutRunnerResult> {
  const service = new Google3DTileBlockoutPipelineService();
  const geoAnchor = await service.resolveAddress(request.query, request.apiKey);

  let cameraPath: CameraPathData | string;
  if (request.cameraPath) {
    cameraPath = request.cameraPath;
  } else {
    const trajectoryPreset = request.trajectoryPreset || 'cinematic_arc';
    switch (trajectoryPreset) {
      case 'orbit_360':
        cameraPath = service.createFullOrbitTrajectory(geoAnchor, {
          corridorRadiusMeters: request.radiusMeters,
          fps: request.fps ?? 24,
          durationSec: request.durationSec ?? 3.0
        });
        break;
      case 'canyon_push':
        cameraPath = service.createPushInTrajectory(geoAnchor, {
          corridorDistanceMeters: request.radiusMeters,
          fps: request.fps ?? 24,
          durationSec: request.durationSec ?? 3.0
        });
        break;
      case 'cinematic_arc':
      default:
        cameraPath = service.createDefaultTrajectory(geoAnchor, {
          corridorRadiusMeters: request.radiusMeters,
          fps: request.fps ?? 24,
          durationSec: request.durationSec ?? 3.0
        });
        break;
    }
  }

  const defaultDir = request.outputDir || 'public';
  // Offline mock placeholders (video, Frame 0 PNG) never default into the repo's public/ assets.
  const placeholderRoot = request.offlineMock && !request.outputDir ? offlineMockOutputRoot() : process.cwd();
  const outputVideoPath = request.outputVideoPath
    ? (path.isAbsolute(request.outputVideoPath) ? request.outputVideoPath : path.join(process.cwd(), request.outputVideoPath))
    : path.join(placeholderRoot, defaultDir, 'videos/google_tiles_clay_blockout_camera.mp4');

  const outputGlbPath = request.outputGlbPath
    ? (path.isAbsolute(request.outputGlbPath) ? request.outputGlbPath : path.join(process.cwd(), request.outputGlbPath))
    : path.join(placeholderRoot, defaultDir, 'models/google_tiles_clay_area.glb');

  const firstFramePngPath = request.firstFramePngPath
    ? (path.isAbsolute(request.firstFramePngPath) ? request.firstFramePngPath : path.join(process.cwd(), request.firstFramePngPath))
    : path.join(placeholderRoot, defaultDir, 'images/blockout_frame_00.png');

  const result = await service.run({
    address: typeof request.query === 'string' ? request.query : undefined,
    geoAnchor,
    cameraPath,
    mode: 'clay',
    apiKey: request.apiKey,
    port: request.port,
    offlineMock: request.offlineMock,
    atomicBuildingIntegrity: request.atomicBuildingIntegrity ?? true,
    enforceZeroBuildingClipping: request.enforceZeroBuildingClipping ?? true,
    zenithAltitudeMeters: request.zenithAltitudeMeters ?? 1800.0,
    collision: {
      enabled: request.collisionAvoidance ?? true
    },
    atmosphere: {
      renderMode: 'clay',
      clayPreset: request.clayPreset ?? 'studio-grey'
    },
    output: {
      outputVideoPath,
      outputGlbPath,
      firstFramePngPath,
      fps: request.fps ?? 24
    }
  });

  const parsedCameraPath: CameraPathData = typeof cameraPath === 'string'
    ? service.loadCameraPath(cameraPath)
    : cameraPath;

  // Only the WebM this run encoded: a file left at the default path by an earlier run is not this run's video.
  const webmVideoPath = result.webmVideoPath;

  if (!result.mesh) {
    throw new Error(`[runTileClayBlockoutRunner] Blockout runner returned no clay mesh statistics for ${outputGlbPath}`);
  }

  return {
    success: result.success,
    mock: result.mock === true,
    videoRef: '<VIDEO_REF_0>',
    blockoutVideoPath: result.outputVideoPath,
    webmVideoPath,
    startFramePngPath: result.firstFramePngPath,
    firstFramePath: result.firstFramePath,
    clayGlbPath: result.glbPath || outputGlbPath,
    glbBuffer: result.glbBuffer,
    cameraPath: parsedCameraPath,
    meshStats: result.mesh,
    geoAnchor: result.geoAnchor,
    resolvedAddress: result.resolvedAddress,
    frameCount: result.frameCount,
    fps: result.fps,
    durationSec: result.durationSec,
    collisionAudit: result.collisionAudit
      ? {
          enabled: result.collisionAudit.enabled,
          violationsDetected: result.collisionAudit.violationsDetected,
          minClearanceMeters: result.collisionAudit.minClearanceMeters,
          auditPassed: result.collisionAudit.auditPassed
        }
      : undefined
  };
}

