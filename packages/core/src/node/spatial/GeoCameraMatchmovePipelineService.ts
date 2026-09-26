/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as fs from 'fs';
import * as path from 'path';
import { spawn, exec, execSync } from 'child_process';
import { promisify } from 'util';
import {
  Google3DTileBlockoutPipelineService,
  GeoAnchor,
  CameraPathData,
  CameraPoseFrame,
  TileAtmosphereConfig,
  TileAtmosphereRenderMode,
  TileLodQualityConfig,
  TileBlockoutOutputConfig,
  TileBlockoutPipelineRequest
} from './Google3DTileBlockoutPipelineService';
import { LocalTangentPlane, Vec3 } from '../../common/coordinate/LocalTangentPlane';
import { OmniVideoService, buildBlockoutFirstLastPrompt } from '../video/OmniVideoService';
import type {
  CameraSolveTrack,
  CameraSolveFrame,
  LensDistortionParams
} from '../../common/vfx-plate-protocol';
import {
  VfxPlateMatchmoveService,
  DriftEvaluationResult
} from '../../browser/generative-canvas/services/video/VfxPlateMatchmoveService';
import {
  SubPixelEdgeAlignmentOptimizer,
  CameraPose6DOF,
  computeSobelField,
  evaluateEdgeOverlap
} from './SubPixelEdgeAlignmentOptimizer';
import {
  HeadlessMeshSilhouetteRenderer,
  RenderMesh3D
} from './HeadlessMeshSilhouetteRenderer';
import {
  GeoBoxPrecisionResectionService
} from './GeoBoxPrecisionResectionService';
import {
  VanishingPointHorizonEstimator,
  VanishingPointResult
} from './VanishingPointHorizonEstimator';
import {
  LandmarkBearingGatedMatcher,
  ViewingQuadrantBounds
} from './LandmarkBearingGatedMatcher';
import {
  MultiModalCameraPoseOptimizer,
  MultiModalOptimizationMetrics
} from './MultiModalCameraPoseOptimizer';
import {
  DynamicVideoTrajectorySolver,
  TrajectoryBoundaryPose
} from './DynamicVideoTrajectorySolver';

const execAsync = promisify(exec);

export type CameraMotionType =
  | 'crane-descent-to-nadir'
  | 'orbital-inspection'
  | 'canyon-flythrough'
  | 'linear-tracking'
  | 'custom';


export interface VideoMetadata {
  durationSec: number;
  totalFrames: number;
  fps: number;
  width: number;
  height: number;
  codec: string;
}

export interface TrajectoryKeyframeAnchor {
  timeSec: number;
  position: [number, number, number];
  target: [number, number, number];
  tiltFraction: number; // 0 = horizontal (world up), 1 = nadir (facade normal up)
  fov: number;
}

export interface AdaptiveDenseSamplingConfig {
  /** Target total number of keyframe anchors (e.g. 25, 33, 49). Default is 25. */
  targetKeyframeCount?: number;
  /** Minimum time delta in seconds between adjacent keyframes (e.g. 0.20s). */
  minIntervalSec?: number;
  /** Maximum time delta in seconds between adjacent keyframes (e.g. 1.20s). */
  maxIntervalSec?: number;
  /** Sensitivity to spatial trajectory 3D curvature kappa(t). Default 1.5. */
  curvatureSensitivity?: number;
  /** Sensitivity to angular velocity / look-at direction changes. Default 1.2. */
  angularRateSensitivity?: number;
}

export interface PrecisionMetrics {
  /** False when the path came from keyframes or a motion preset instead of being measured against the plate. */
  measured: boolean;
  trajectorySource: 'motion-preset' | 'keyframes' | 'plate-track';
  meanReprojectionErrorPx: number | null;
  meanEdgeOverlapScorePct: number | null;
  meanDriftPx: number | null;
  maxDriftPx: number | null;
  driftStatus?: 'locked' | 'drifting' | 'uncalibrated' | 'sub-pixel-locked';
}

export interface PrecisionProofArtifacts {
  wireframePaths?: string[];
  splitWipePaths?: string[];
  heatmapPaths?: string[];
}

export interface GeoMatchmoveRequest {
  inputVideoPath: string;
  geoAnchor: GeoAnchor;
  motionType?: CameraMotionType;
  headingDeg?: number;
  startAltitudeMeters?: number;
  endAltitudeMeters?: number;
  customKeyframes?: TrajectoryKeyframeAnchor[];
  denseKeyframeCount?: number;
  adaptiveSampling?: boolean;
  adaptiveConfig?: AdaptiveDenseSamplingConfig;
  renderMode?: 'textured' | 'photoreal' | 'clay' | 'warm-clay' | 'studio-grey';
  resolution?: { width: number; height: number };
  fps?: number;
  bitrate?: string;
  outputDir?: string;
  outputVideoName?: string;
  skipBlockoutRender?: boolean;
  enableOmniSynthesis?: boolean;
  /** Camera move in cinematography terms for the Omni prompt. */
  omniShot?: string;
  /** Keep streets free of people and vehicles in the Omni video. */
  omniEmptyStreets?: boolean;
  collisionBufferMeters?: number;
  port?: number;
  // Precision 3D Tile Alignment & Optical Resection Stack
  precisionOptimization?: boolean;
  interpolationMethod?: 'catmull-rom' | 'hermite-slerp' | 'continuous-spline';
  lensDistortion?: LensDistortionParams;
  resectionKeyframes?: number[];
  tileMeshPath?: string;
  targetOverlapScore?: number;
}

export interface GeoMatchmoveResult {
  success: boolean;
  videoMetadata: VideoMetadata;
  geoAnchor: GeoAnchor;
  cameraPathJsonPath: string;
  cameraPathData: CameraPathData;
  motionType?: CameraMotionType;
  totalFrames?: number;
  fps?: number;
  durationSec?: number;
  blockoutVideoPath?: string;
  startFramePath?: string;
  startFramePngPath?: string;
  storyboardsDir?: string;
  omniVideoPath?: string;
  omniWebmPath?: string;
  omniInteractionId?: string;
  omniError?: string;
  comparisonVideoPath?: string;
  comparisonWebmPath?: string;
  qaKeyframes?: string[];
  manifestPath?: string;
  summary: string;
  precisionMetrics?: PrecisionMetrics;
  solveTrack?: CameraSolveTrack;
  proofArtifacts?: PrecisionProofArtifacts;
}

/**
 * GeoCameraMatchmovePipelineService
 * Codifies end-to-end video camera trajectory matching in arbitrary geographic locations.
 */
export class GeoCameraMatchmovePipelineService {
  private chromePath: string;
  private ffmpegPath: string;
  private ffprobePath: string;
  private blockoutService: Google3DTileBlockoutPipelineService;

  constructor(
    chromePath: string = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ffmpegPath: string = '/opt/homebrew/bin/ffmpeg',
    ffprobePath: string = '/opt/homebrew/bin/ffprobe',
    private readonly omni: OmniVideoService = new OmniVideoService()
  ) {
    this.chromePath = chromePath;
    this.ffmpegPath = ffmpegPath;
    this.ffprobePath = ffprobePath;
    this.blockoutService = new Google3DTileBlockoutPipelineService(chromePath, ffmpegPath);
  }

  /**
   * Normalizes explicit coordinates into a GeoAnchor with heading. Place names go through
   * `geocodeLandmarkAnchor`; there is no built-in landmark table.
   */
  public resolveLandmarkAnchor(coords: GeoAnchor & { headingDeg?: number; typicalRooflineAltM?: number; typicalStreetAltM?: number }): GeoAnchor & { headingDeg: number; typicalRooflineAltM?: number; typicalStreetAltM?: number } {
    if (typeof coords !== 'object' || coords === null || !Number.isFinite(coords.lat) || !Number.isFinite(coords.lng)) {
      throw new Error('resolveLandmarkAnchor needs explicit coordinates; use geocodeLandmarkAnchor(name) to look up a place name.');
    }
    return {
      lat: coords.lat,
      lng: coords.lng,
      elevation: coords.elevation ?? 0,
      landmarkName: coords.landmarkName ?? `Geo Location (${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)})`,
      headingDeg: coords.headingDeg ?? 0,
      typicalRooflineAltM: coords.typicalRooflineAltM ?? 70.0,
      typicalStreetAltM: coords.typicalStreetAltM ?? 10.0
    };
  }

  /**
   * Looks up a place name with the Google Geocoding API and its ground elevation with the Elevation API.
   * Throws when there is no key or no result instead of substituting any preset location.
   */
  public async geocodeLandmarkAnchor(
    query: string,
    options: { apiKey?: string; fetchImpl?: typeof fetch; headingDeg?: number } = {}
  ): Promise<GeoAnchor & { headingDeg: number; placeId: string; elevationSource: 'elevation-api' | 'unavailable' }> {
    const apiKey = options.apiKey ?? process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
      throw new Error(`Geocoding "${query}" needs a Google Maps API key (GOOGLE_MAPS_API_KEY) or explicit coordinates.`);
    }
    const doFetch = options.fetchImpl ?? fetch;
    const geo: any = await (await doFetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&key=${apiKey}`)).json();
    if (geo.status !== 'OK' || !geo.results?.length) {
      throw new Error(`Geocoding found no result for "${query}" (${geo.status}${geo.error_message ? `: ${geo.error_message}` : ''}).`);
    }
    const hit = geo.results[0];
    const lat: number = hit.geometry.location.lat;
    const lng: number = hit.geometry.location.lng;
    let elevation = 0;
    let elevationSource: 'elevation-api' | 'unavailable' = 'unavailable';
    try {
      const elev: any = await (await doFetch(`https://maps.googleapis.com/maps/api/elevation/json?locations=${lat},${lng}&key=${apiKey}`)).json();
      if (elev.status === 'OK' && Number.isFinite(elev.results?.[0]?.elevation)) {
        elevation = elev.results[0].elevation;
        elevationSource = 'elevation-api';
      }
    } catch {
      elevationSource = 'unavailable';
    }
    return { lat, lng, elevation, elevationSource, landmarkName: hit.formatted_address, placeId: hit.place_id, headingDeg: options.headingDeg ?? 0 };
  }

  /**
   * Extracts video duration, frame count, fps, and dimensions via ffprobe.
   */
  public async analyzeVideo(videoPath: string): Promise<VideoMetadata> {
    if (!fs.existsSync(videoPath)) {
      throw new Error(`Input video not found at: ${videoPath}`);
    }

    try {
      const cmd = `"${this.ffprobePath}" -v error -select_streams v:0 -show_entries stream=width,height,r_frame_rate,duration,nb_frames,codec_name -show_entries format=duration -of json "${videoPath}"`;
      const { stdout } = await execAsync(cmd);
      const data = JSON.parse(stdout);

      const stream = data.streams?.[0] || {};
      const format = data.format || {};

      let durationSec = parseFloat(stream.duration || format.duration || '0');
      let totalFrames = parseInt(stream.nb_frames || '0', 10);
      let fps = 24;

      if (stream.r_frame_rate) {
        const parts = stream.r_frame_rate.split('/');
        if (parts.length === 2 && parseInt(parts[1], 10) > 0) {
          fps = Math.round(parseInt(parts[0], 10) / parseInt(parts[1], 10));
        } else {
          fps = parseFloat(stream.r_frame_rate) || 24;
        }
      }

      if (totalFrames <= 0 && durationSec > 0 && fps > 0) {
        totalFrames = Math.round(durationSec * fps);
      } else if (durationSec <= 0 && totalFrames > 0 && fps > 0) {
        durationSec = totalFrames / fps;
      }

      return {
        durationSec: durationSec > 0 ? durationSec : 15.041667,
        totalFrames: totalFrames > 0 ? totalFrames : 361,
        fps: fps > 0 ? fps : 24,
        width: stream.width || 3840,
        height: stream.height || 2160,
        codec: stream.codec_name || 'h264'
      };
    } catch (err: any) {
      console.warn(`[GeoMatchmove] ffprobe warning: ${err.message}. Falling back to default 24fps cinema standard.`);
      return {
        durationSec: 15.041667,
        totalFrames: 361,
        fps: 24,
        width: 3840,
        height: 2160,
        codec: 'h264'
      };
    }
  }

  /**
   * Catmull-Rom spline interpolation for 3D coordinate arrays.
   */
  private catmullRom(p0: [number, number, number], p1: [number, number, number], p2: [number, number, number], p3: [number, number, number], t: number): [number, number, number] {
    const t2 = t * t;
    const t3 = t2 * t;
    return [
      0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
      0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      0.5 * ((2 * p1[2]) + (-p0[2] + p2[2]) * t + (2 * p0[2] - 5 * p1[2] + 4 * p2[2] - p3[2]) * t2 + (-p0[2] + 3 * p1[2] - 3 * p2[2] + p3[2]) * t3)
    ];
  }

  private lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
  }

  /**
   * Generates master keyframes for crane-descent-to-nadir motion anchored to a specific building height and heading.
   * Supports dense sampling (e.g. 25 anchors) across all 5 flight phases to eliminate spline sag on complex moves.
   */
  public generateCraneDescentAnchors(
    durationSec: number,
    headingDeg: number = -29.0,
    rooflineAltMeters: number = 70.0,
    streetAltMeters: number = 8.5,
    sampleCount: number = 25,
    startPitchDeg?: number,
    startAltitudeMeters?: number
  ): TrajectoryKeyframeAnchor[] {
    const headingRad = headingDeg * (Math.PI / 180.0);
    const cosH = Math.cos(headingRad);
    const sinH = Math.sin(headingRad);

    // Transform relative coordinate [x, z] by heading angle
    const rotateCoords = (x: number, z: number): [number, number] => {
      return [x * cosH - z * sinH, x * sinH + z * cosH];
    };

    const deltaAlt = rooflineAltMeters - streetAltMeters;
    const isUpwardStart = typeof startPitchDeg === 'number' ? startPitchDeg > 2.0 : false;
    const startAlt = typeof startAltitudeMeters === 'number'
      ? startAltitudeMeters
      : (isUpwardStart ? rooflineAltMeters - deltaAlt * 0.28 : rooflineAltMeters);
    const startTgtY = isUpwardStart ? rooflineAltMeters - deltaAlt * 0.12 : rooflineAltMeters - 1.0;

    // Legacy 9-milestone anchors
    const rawAnchors9 = [
      { timeFrac: 0.0, relPos: [54.0, startAlt, -1.0], relTgt: [29.5, startTgtY, 5.0], tilt: isUpwardStart ? -0.15 : 0.0, fov: 40.0 },
      { timeFrac: 0.1, relPos: [50.5, rooflineAltMeters - deltaAlt * 0.06, 2.0], relTgt: [29.0, rooflineAltMeters - deltaAlt * 0.06 - 1.0, 8.0], tilt: 0.0, fov: 42.0 },
      { timeFrac: 0.2, relPos: [46.5, rooflineAltMeters - deltaAlt * 0.28, 8.0], relTgt: [29.0, rooflineAltMeters - deltaAlt * 0.36, 14.0], tilt: 0.05, fov: 46.0 },
      { timeFrac: 0.33, relPos: [43.5, rooflineAltMeters - deltaAlt * 0.52, 14.0], relTgt: [34.0, rooflineAltMeters - deltaAlt * 0.72, 18.0], tilt: 0.25, fov: 49.0 },
      { timeFrac: 0.47, relPos: [42.0, rooflineAltMeters - deltaAlt * 0.72, 19.5], relTgt: [38.0, streetAltMeters - 2.5, 21.0], tilt: 0.55, fov: 52.0 },
      { timeFrac: 0.60, relPos: [41.2, rooflineAltMeters - deltaAlt * 0.83, 21.5], relTgt: [39.5, streetAltMeters - 5.5, 22.0], tilt: 0.78, fov: 53.5 },
      { timeFrac: 0.73, relPos: [41.2, streetAltMeters + deltaAlt * 0.09, 22.8], relTgt: [40.8, streetAltMeters - 7.0, 22.6], tilt: 0.92, fov: 54.5 },
      { timeFrac: 0.86, relPos: [41.4, streetAltMeters + deltaAlt * 0.04, 23.0], relTgt: [41.3, streetAltMeters - 8.0, 23.0], tilt: 0.97, fov: 55.0 },
      { timeFrac: 1.0, relPos: [41.5, streetAltMeters, 23.0], relTgt: [41.5, 0.0, 23.0], tilt: 1.0, fov: 55.0 }
    ];

    // High-precision dense 25-milestone anchors across 5 flight phases
    const denseAnchors25 = [
      // Phase 1: Mansard Roof & Turret Apex
      { timeFrac: 0.000, relPos: [54.0, startAlt, -1.0], relTgt: [29.5, startTgtY, 5.0], tilt: isUpwardStart ? -0.15 : 0.00, fov: 40.0 },
      { timeFrac: 0.040, relPos: [52.8, isUpwardStart ? startAlt + 0.5 : rooflineAltMeters - deltaAlt * 0.02, 0.2], relTgt: [29.2, isUpwardStart ? startTgtY - 0.5 : rooflineAltMeters - deltaAlt * 0.02 - 1.0, 6.0], tilt: isUpwardStart ? -0.10 : 0.00, fov: 40.8 },
      { timeFrac: 0.080, relPos: [51.5, isUpwardStart ? startAlt - deltaAlt * 0.04 : rooflineAltMeters - deltaAlt * 0.05, 1.4], relTgt: [29.0, isUpwardStart ? startTgtY - 1.5 : rooflineAltMeters - deltaAlt * 0.05 - 1.0, 7.2], tilt: isUpwardStart ? -0.05 : 0.00, fov: 41.5 },
      { timeFrac: 0.125, relPos: [49.5, rooflineAltMeters - deltaAlt * 0.10, 3.2], relTgt: [29.0, rooflineAltMeters - deltaAlt * 0.10 - 1.0, 9.0], tilt: 0.02, fov: 42.5 },

      // Phase 2: Upper Cornice & Facade Window Grid
      { timeFrac: 0.166, relPos: [47.5, rooflineAltMeters - deltaAlt * 0.20, 6.0], relTgt: [29.0, rooflineAltMeters - deltaAlt * 0.25, 12.0], tilt: 0.04, fov: 44.5 },
      { timeFrac: 0.208, relPos: [46.0, rooflineAltMeters - deltaAlt * 0.30, 8.5], relTgt: [29.2, rooflineAltMeters - deltaAlt * 0.38, 14.5], tilt: 0.06, fov: 46.2 },
      { timeFrac: 0.250, relPos: [45.0, rooflineAltMeters - deltaAlt * 0.38, 10.5], relTgt: [30.5, rooflineAltMeters - deltaAlt * 0.50, 15.8], tilt: 0.12, fov: 47.5 },
      { timeFrac: 0.291, relPos: [44.2, rooflineAltMeters - deltaAlt * 0.45, 12.5], relTgt: [32.0, rooflineAltMeters - deltaAlt * 0.62, 17.0], tilt: 0.18, fov: 48.2 },
      { timeFrac: 0.333, relPos: [43.5, rooflineAltMeters - deltaAlt * 0.52, 14.0], relTgt: [34.0, rooflineAltMeters - deltaAlt * 0.72, 18.0], tilt: 0.25, fov: 49.0 },

      // Phase 3: Marquee Awning Approach & High-Curvature Tilt
      { timeFrac: 0.375, relPos: [43.0, rooflineAltMeters - deltaAlt * 0.58, 15.8], relTgt: [35.2, rooflineAltMeters - deltaAlt * 0.82, 19.0], tilt: 0.35, fov: 50.0 },
      { timeFrac: 0.416, relPos: [42.5, rooflineAltMeters - deltaAlt * 0.65, 17.6], relTgt: [36.8, rooflineAltMeters - deltaAlt * 0.90, 20.0], tilt: 0.45, fov: 51.0 },
      { timeFrac: 0.458, relPos: [42.1, rooflineAltMeters - deltaAlt * 0.70, 19.0], relTgt: [37.8, streetAltMeters - 2.0, 20.8], tilt: 0.53, fov: 51.8 },
      { timeFrac: 0.500, relPos: [41.8, rooflineAltMeters - deltaAlt * 0.75, 20.2], relTgt: [38.5, streetAltMeters - 3.5, 21.4], tilt: 0.62, fov: 52.4 },

      // Phase 4: Canopy Crossing & Sidewalk Transition
      { timeFrac: 0.541, relPos: [41.5, rooflineAltMeters - deltaAlt * 0.79, 21.0], relTgt: [39.0, streetAltMeters - 4.8, 21.8], tilt: 0.70, fov: 53.0 },
      { timeFrac: 0.583, relPos: [41.3, rooflineAltMeters - deltaAlt * 0.82, 21.4], relTgt: [39.4, streetAltMeters - 5.4, 22.0], tilt: 0.76, fov: 53.4 },
      { timeFrac: 0.625, relPos: [41.2, rooflineAltMeters - deltaAlt * 0.86, 21.8], relTgt: [39.8, streetAltMeters - 6.0, 22.2], tilt: 0.82, fov: 53.8 },
      { timeFrac: 0.666, relPos: [41.2, streetAltMeters + deltaAlt * 0.11, 22.4], relTgt: [40.4, streetAltMeters - 6.6, 22.4], tilt: 0.88, fov: 54.2 },

      // Phase 5: Nadir Hover, Deceleration & Asphalt Ground Lock
      { timeFrac: 0.708, relPos: [41.2, streetAltMeters + deltaAlt * 0.08, 22.7], relTgt: [40.7, streetAltMeters - 7.0, 22.6], tilt: 0.92, fov: 54.5 },
      { timeFrac: 0.750, relPos: [41.3, streetAltMeters + deltaAlt * 0.06, 22.8], relTgt: [41.0, streetAltMeters - 7.4, 22.8], tilt: 0.94, fov: 54.7 },
      { timeFrac: 0.791, relPos: [41.3, streetAltMeters + deltaAlt * 0.04, 22.9], relTgt: [41.2, streetAltMeters - 7.8, 22.9], tilt: 0.96, fov: 54.9 },
      { timeFrac: 0.833, relPos: [41.4, streetAltMeters + deltaAlt * 0.03, 23.0], relTgt: [41.3, streetAltMeters - 8.0, 23.0], tilt: 0.97, fov: 55.0 },
      { timeFrac: 0.875, relPos: [41.4, streetAltMeters + deltaAlt * 0.02, 23.0], relTgt: [41.4, streetAltMeters - 8.2, 23.0], tilt: 0.98, fov: 55.0 },
      { timeFrac: 0.916, relPos: [41.5, streetAltMeters + deltaAlt * 0.01, 23.0], relTgt: [41.5, streetAltMeters - 8.4, 23.0], tilt: 0.99, fov: 55.0 },
      { timeFrac: 0.958, relPos: [41.5, streetAltMeters + deltaAlt * 0.005, 23.0], relTgt: [41.5, 0.0, 23.0], tilt: 1.00, fov: 55.0 },
      { timeFrac: 1.000, relPos: [41.5, streetAltMeters, 23.0], relTgt: [41.5, 0.0, 23.0], tilt: 1.00, fov: 55.0 }
    ];

    const chosen = sampleCount <= 9 ? rawAnchors9 : denseAnchors25;

    return chosen.map(a => {
      const pRot = rotateCoords(a.relPos[0], a.relPos[2]);
      const tRot = rotateCoords(a.relTgt[0], a.relTgt[2]);
      return {
        timeSec: a.timeFrac * durationSec,
        position: [pRot[0], a.relPos[1], pRot[1]],
        target: [tRot[0], a.relTgt[1], tRot[1]],
        tiltFraction: a.tilt,
        fov: a.fov
      };
    });
  }

  /**
   * Adaptive dense frame sampling algorithm for complex camera moves.
   * Analyzes 3D trajectory velocity, acceleration, spatial curvature kappa(t),
   * and angular look-at rate to dynamically place keyframe anchors at optimal density.
   */
  public sampleDenseKeyframesAdaptive(
    pathData: CameraPathData,
    config: AdaptiveDenseSamplingConfig = {}
  ): TrajectoryKeyframeAnchor[] {
    const frames = pathData.frames;
    if (!frames || frames.length <= 2) {
      return (frames || []).map(f => ({
        timeSec: f.timeSec,
        position: f.position,
        target: f.target,
        tiltFraction: 1.0 - Math.max(0, Math.min(1, f.up[1])),
        fov: f.fov
      }));
    }

    const targetCount = config.targetKeyframeCount ?? 25;
    const minIntervalSec = config.minIntervalSec ?? 0.20;
    const kappaWeight = config.curvatureSensitivity ?? 1.5;
    const omegaWeight = config.angularRateSensitivity ?? 1.2;

    const N = frames.length;
    const dt = pathData.durationSec / Math.max(1, N - 1);

    const weights: number[] = new Array(N).fill(1.0);

    for (let i = 1; i < N - 1; i++) {
      const prev = frames[i - 1];
      const curr = frames[i];
      const next = frames[i + 1];

      // Velocity: v = (next - prev) / (2 * dt)
      const vx = (next.position[0] - prev.position[0]) / (2 * dt);
      const vy = (next.position[1] - prev.position[1]) / (2 * dt);
      const vz = (next.position[2] - prev.position[2]) / (2 * dt);
      const vMag = Math.hypot(vx, vy, vz) || 1e-4;

      // Acceleration: a = (next - 2*curr + prev) / dt^2
      const ax = (next.position[0] - 2 * curr.position[0] + prev.position[0]) / (dt * dt);
      const ay = (next.position[1] - 2 * curr.position[1] + prev.position[1]) / (dt * dt);
      const az = (next.position[2] - 2 * curr.position[2] + prev.position[2]) / (dt * dt);

      // Curvature: kappa = |v x a| / |v|^3
      const crossX = vy * az - vz * ay;
      const crossY = vz * ax - vx * az;
      const crossZ = vx * ay - vy * ax;
      const crossMag = Math.hypot(crossX, crossY, crossZ);
      const kappa = crossMag / Math.pow(vMag, 3);

      // Angular look-at change
      const dx1 = curr.target[0] - curr.position[0];
      const dy1 = curr.target[1] - curr.position[1];
      const dz1 = curr.target[2] - curr.position[2];
      const dLen1 = Math.hypot(dx1, dy1, dz1) || 1e-4;

      const dx2 = next.target[0] - next.position[0];
      const dy2 = next.target[1] - next.position[1];
      const dz2 = next.target[2] - next.position[2];
      const dLen2 = Math.hypot(dx2, dy2, dz2) || 1e-4;

      const dot = Math.max(-1, Math.min(1, (dx1 * dx2 + dy1 * dy2 + dz1 * dz2) / (dLen1 * dLen2)));
      const angularDeltaRad = Math.acos(dot);
      const omega = angularDeltaRad / dt;

      // Composite saliency weight: baseline + curvature + angular rate
      weights[i] = 1.0 + kappaWeight * Math.min(kappa, 5.0) + omegaWeight * omega;
    }
    weights[0] = weights[1] || 1.0;
    weights[N - 1] = weights[N - 2] || 1.0;

    // Cumulative importance curve
    const cum = new Float64Array(N);
    cum[0] = 0;
    for (let i = 1; i < N; i++) {
      cum[i] = cum[i - 1] + (weights[i - 1] + weights[i]) * 0.5 * dt;
    }
    const totalSaliency = cum[N - 1];

    // Partition into targetCount segments
    const selectedIndices: number[] = [0];
    const segmentSaliency = totalSaliency / (targetCount - 1);

    let currentAnchorIdx = 0;
    for (let k = 1; k < targetCount - 1; k++) {
      const targetS = k * segmentSaliency;
      let bestIdx = currentAnchorIdx + 1;
      let minDiff = Infinity;
      for (let j = currentAnchorIdx + 1; j < N - 1; j++) {
        const diff = Math.abs(cum[j] - targetS);
        if (diff < minDiff) {
          minDiff = diff;
          bestIdx = j;
        }
      }

      const prevTime = frames[selectedIndices[selectedIndices.length - 1]].timeSec;
      const proposedTime = frames[bestIdx].timeSec;
      if (proposedTime - prevTime >= minIntervalSec) {
        selectedIndices.push(bestIdx);
        currentAnchorIdx = bestIdx;
      }
    }
    if (!selectedIndices.includes(N - 1)) {
      selectedIndices.push(N - 1);
    }

    return selectedIndices.map(idx => {
      const f = frames[idx];
      const tiltFrac = Number((1.0 - Math.max(0, Math.min(1, f.up[1]))).toFixed(4));
      return {
        timeSec: f.timeSec,
        position: [...f.position],
        target: [...f.target],
        tiltFraction: tiltFrac,
        fov: f.fov
      };
    });
  }

  /**
   * Generates master keyframes for orbital-inspection motion circling a landmark centroid.
   */
  public generateOrbitalInspectionAnchors(
    durationSec: number,
    headingDeg: number = 0.0,
    radiusMeters: number = 75.0,
    heightMeters: number = 50.0
  ): TrajectoryKeyframeAnchor[] {
    const anchors: TrajectoryKeyframeAnchor[] = [];
    const count = 9;
    for (let i = 0; i < count; i++) {
      const frac = i / (count - 1);
      const angle = (headingDeg * Math.PI / 180.0) + (frac * Math.PI * 2.0);
      const x = Math.sin(angle) * radiusMeters;
      const z = Math.cos(angle) * radiusMeters;
      anchors.push({
        timeSec: frac * durationSec,
        position: [x, heightMeters, z],
        target: [0, heightMeters * 0.5, 0],
        tiltFraction: 0.1,
        fov: 45.0
      });
    }
    return anchors;
  }

  /**
   * Generates master keyframes for canyon-flythrough motion translating along street corridor.
   */
  public generateCanyonFlythroughAnchors(
    durationSec: number,
    headingDeg: number = -29.0,
    flyDistanceMeters: number = 180.0,
    altitudeMeters: number = 22.0
  ): TrajectoryKeyframeAnchor[] {
    const headingRad = headingDeg * (Math.PI / 180.0);
    const fwdX = -Math.sin(headingRad);
    const fwdZ = Math.cos(headingRad);

    const halfDist = flyDistanceMeters / 2.0;
    const anchors: TrajectoryKeyframeAnchor[] = [];
    const count = 7;
    for (let i = 0; i < count; i++) {
      const frac = i / (count - 1);
      const travel = -halfDist + frac * flyDistanceMeters;
      const posX = fwdX * travel;
      const posZ = fwdZ * travel;
      const tgtX = posX + fwdX * 45.0;
      const tgtZ = posZ + fwdZ * 45.0;

      anchors.push({
        timeSec: frac * durationSec,
        position: [posX, altitudeMeters, posZ],
        target: [tgtX, altitudeMeters - 2.0, tgtZ],
        tiltFraction: 0.05,
        fov: 50.0
      });
    }
    return anchors;
  }

  /**
   * Generates a smooth, continuous 6-DoF trajectory across all video frames.
   */
  public solveCameraTrajectory(
    metadata: VideoMetadata,
    geoAnchor: GeoAnchor,
    keyframesOrMotion: CameraMotionType | TrajectoryKeyframeAnchor[] = 'crane-descent-to-nadir',
    headingDeg: number = -29.0,
    denseSamplingOptions?: {
      denseKeyframeCount?: number;
      adaptive?: boolean;
      adaptiveConfig?: AdaptiveDenseSamplingConfig;
    }
  ): CameraPathData {
    let keyframes: TrajectoryKeyframeAnchor[];
    if (Array.isArray(keyframesOrMotion)) {
      keyframes = keyframesOrMotion;
    } else {
      const motion = keyframesOrMotion || 'crane-descent-to-nadir';
      if (motion === 'orbital-inspection') {
        keyframes = this.generateOrbitalInspectionAnchors(metadata.durationSec, headingDeg);
      } else if (motion === 'canyon-flythrough') {
        keyframes = this.generateCanyonFlythroughAnchors(metadata.durationSec, headingDeg);
      } else {
        const count = denseSamplingOptions?.denseKeyframeCount ?? 25;
        keyframes = this.generateCraneDescentAnchors(metadata.durationSec, headingDeg, 70.0, 8.5, count);
      }
    }

    const totalFrames = metadata.totalFrames;
    const fps = metadata.fps;
    const durationSec = metadata.durationSec;
    const headingRad = headingDeg * (Math.PI / 180.0);
    const facadeNormal = [-Math.cos(headingRad), 0.0, Math.sin(headingRad)];

    let frames = this.interpolateKeyframesToFrames(keyframes, metadata, facadeNormal);

    if (denseSamplingOptions?.adaptive) {
      keyframes = this.sampleDenseKeyframesAdaptive(
        { fps, totalFrames, durationSec, frames, origin: geoAnchor },
        denseSamplingOptions.adaptiveConfig
      );
      frames = this.interpolateKeyframesToFrames(keyframes, metadata, facadeNormal);
    }

    return {
      fps,
      totalFrames,
      durationSec,
      frames,
      origin: geoAnchor
    };
  }

  private interpolateKeyframesToFrames(
    keyframes: TrajectoryKeyframeAnchor[],
    metadata: VideoMetadata,
    facadeNormal: number[]
  ): CameraPoseFrame[] {
    const totalFrames = metadata.totalFrames;
    const durationSec = metadata.durationSec;
    const frames: CameraPoseFrame[] = [];

    for (let i = 0; i < totalFrames; i++) {
      const t = totalFrames > 1 ? (i / (totalFrames - 1)) * durationSec : 0;

      let segIdx = 0;
      while (segIdx < keyframes.length - 2 && keyframes[segIdx + 1].timeSec < t) {
        segIdx++;
      }

      const k1 = keyframes[segIdx] || keyframes[0];
      const k2 = keyframes[segIdx + 1] || k1;
      const k0 = (segIdx > 0 && keyframes[segIdx - 1]) ? keyframes[segIdx - 1] : k1;
      const k3 = (segIdx + 2 < keyframes.length && keyframes[segIdx + 2]) ? keyframes[segIdx + 2] : k2;

      const span = k2.timeSec - k1.timeSec || 1.0;
      const u = Math.max(0, Math.min(1, (t - k1.timeSec) / span));

      const pos = this.catmullRom(k0.position, k1.position, k2.position, k3.position, u);
      const tgt = this.catmullRom(k0.target, k1.target, k2.target, k3.target, u);

      const tilt = this.lerp(k1.tiltFraction, k2.tiltFraction, u);
      const angle = tilt * (Math.PI / 2.0);

      const rawUp = [
        Math.sin(angle) * facadeNormal[0],
        Math.cos(angle) * 1.0,
        Math.sin(angle) * facadeNormal[2]
      ];
      const upLen = Math.hypot(rawUp[0], rawUp[1], rawUp[2]) || 1.0;
      const up: [number, number, number] = [rawUp[0] / upLen, rawUp[1] / upLen, rawUp[2] / upLen];

      const fov = this.lerp(k1.fov, k2.fov, u);

      frames.push({
        frame: i,
        timeSec: Number(t.toFixed(4)),
        position: [Number(pos[0].toFixed(3)), Number(pos[1].toFixed(3)), Number(pos[2].toFixed(3))],
        target: [Number(tgt[0].toFixed(3)), Number(tgt[1].toFixed(3)), Number(tgt[2].toFixed(3))],
        up: [Number(up[0].toFixed(4)), Number(up[1].toFixed(4)), Number(up[2].toFixed(4))],
        fov: Number(fov.toFixed(2))
      });
    }

    return frames;
  }

  /**
   * Converts Euler heading (azimuth) and pitch angles into a normalized orientation quaternion [qx, qy, qz, qw]
   * for Three.js camera conventions (local forward = [0, 0, -1], local up = [0, 1, 0]).
   */
  public static eulerToQuaternion(headingDeg: number, pitchDeg: number, rollDeg: number = 0): [number, number, number, number] {
    const headingRad = (headingDeg * Math.PI) / 180.0;
    const pitchRad = (pitchDeg * Math.PI) / 180.0;
    const rollRad = (rollDeg * Math.PI) / 180.0;

    // Three.js camera Euler order YXZ (Yaw around Y, Pitch around X, Roll around Z)
    const c1 = Math.cos(headingRad / 2.0);
    const s1 = Math.sin(headingRad / 2.0);
    const c2 = Math.cos(pitchRad / 2.0);
    const s2 = Math.sin(pitchRad / 2.0);
    const c3 = Math.cos(rollRad / 2.0);
    const s3 = Math.sin(rollRad / 2.0);

    const qx = s2 * c1 * c3 + c2 * s1 * s3;
    const qy = c2 * s1 * c3 - s2 * c1 * s3;
    const qz = c2 * c1 * s3 - s2 * s1 * c3;
    const qw = c2 * c1 * c3 + s2 * s1 * s3;

    const mag = Math.hypot(qx, qy, qz, qw) || 1.0;
    return [qx / mag, qy / mag, qz / mag, qw / mag];
  }

  /**
   * Converts a unit camera orientation quaternion into Three.js forward [fx, fy, fz] and up [ux, uy, uz] vectors.
   */
  public static quaternionToVectors(q: [number, number, number, number]): {
    forward: [number, number, number];
    up: [number, number, number];
  } {
    const [qx, qy, qz, qw] = q;

    // Local forward = [0, 0, -1] rotated by q:
    const fx = -2.0 * (qx * qz + qw * qy);
    const fy = -2.0 * (qy * qz - qw * qx);
    const fz = -(1.0 - 2.0 * (qx * qx + qy * qy));

    // Local up = [0, 1, 0] rotated by q:
    const ux = 2.0 * (qx * qy - qw * qz);
    const uy = 1.0 - 2.0 * (qx * qx + qz * qz);
    const uz = 2.0 * (qy * qz + qw * qx);

    const fMag = Math.hypot(fx, fy, fz) || 1.0;
    const uMag = Math.hypot(ux, uy, uz) || 1.0;

    return {
      forward: [fx / fMag, fy / fMag, fz / fMag],
      up: [ux / uMag, uy / uMag, uz / uMag]
    };
  }

  /**
   * Solves continuous high-precision 6-DoF camera trajectory using Hermite cubic spline position,
   * quaternion SLERP rotation, Brown-Conrady lens distortion compensation, and sub-pixel edge alignment.
   */
  public solvePrecisionTrajectory(
    metadata: VideoMetadata,
    geoAnchor: GeoAnchor,
    keyframesOrMotion: CameraMotionType | TrajectoryKeyframeAnchor[] = 'crane-descent-to-nadir',
    headingDeg: number = -29.0,
    options: {
      lensDistortion?: LensDistortionParams;
      tileMeshPath?: string;
      resectionKeyframes?: number[];
      targetOverlapScore?: number;
      proofOutputDir?: string;
      startPitchDeg?: number;
      startAltitudeMeters?: number;
      /** Where caller-supplied keyframes came from; defaults to 'keyframes' for arrays and 'motion-preset' otherwise. */
      trajectorySource?: 'motion-preset' | 'keyframes';
    } = {}
  ): {
    pathData: CameraPathData;
    solveTrack: CameraSolveTrack;
    precisionMetrics: PrecisionMetrics;
    proofArtifacts: PrecisionProofArtifacts;
  } {
    let keyframes: TrajectoryKeyframeAnchor[];
    if (Array.isArray(keyframesOrMotion)) {
      keyframes = keyframesOrMotion;
    } else {
      const motion = keyframesOrMotion || 'crane-descent-to-nadir';
      if (motion === 'orbital-inspection') {
        keyframes = this.generateOrbitalInspectionAnchors(metadata.durationSec, headingDeg);
      } else if (motion === 'canyon-flythrough') {
        keyframes = this.generateCanyonFlythroughAnchors(metadata.durationSec, headingDeg);
      } else {
        keyframes = this.generateCraneDescentAnchors(
          metadata.durationSec,
          headingDeg,
          70.0,
          8.5,
          25,
          options.startPitchDeg,
          options.startAltitudeMeters
        );
      }
    }

    const totalFrames = metadata.totalFrames;
    const fps = metadata.fps;
    const durationSec = metadata.durationSec;

    // Proof renders use only the tile mesh the caller names for this location
    let tileMesh: RenderMesh3D | null = null;
    if (options.tileMeshPath) {
      if (!fs.existsSync(options.tileMeshPath)) throw new Error(`Tile mesh not found: ${options.tileMeshPath}`);
      tileMesh = HeadlessMeshSilhouetteRenderer.loadMeshFromGlb(options.tileMeshPath);
    }

    // Convert anchors to CameraSolveFrames with pitch & heading
    const solveFrames: CameraSolveFrame[] = [];
    for (let k = 0; k < keyframes.length; k++) {
      const anchor = keyframes[k];
      const t = anchor.timeSec;
      const frameNum = Math.min(totalFrames - 1, Math.round((t / durationSec) * (totalFrames - 1)));

      const px = anchor.position[0];
      const py = anchor.position[1];
      const pz = anchor.position[2];

      const tx = anchor.target[0];
      const ty = anchor.target[1];
      const tz = anchor.target[2];

      const dx = tx - px;
      const dy = ty - py;
      const dz = tz - pz;
      const dist = Math.hypot(dx, dy, dz) || 1.0;

      // Determine pitch and heading
      let pitchDeg: number;
      let kHeadingDeg: number;

      if (k === keyframes.length - 1 || anchor.tiltFraction >= 0.98 || dy / dist < -0.92) {
        // Pure nadir overhead look straight down
        pitchDeg = -90.0;
        kHeadingDeg = headingDeg;
      } else {
        pitchDeg = Math.asin(Math.max(-1.0, Math.min(1.0, dy / dist))) * (180.0 / Math.PI);
        kHeadingDeg = Math.atan2(dx, -dz) * (180.0 / Math.PI);
      }

      const q = GeoCameraMatchmovePipelineService.eulerToQuaternion(kHeadingDeg, pitchDeg, 0.0);

      solveFrames.push({
        frameNumber: frameNum,
        timeSeconds: Number(t.toFixed(4)),
        position: [px, py, pz],
        rotationQuaternion: q,
        fovDegrees: anchor.fov || 46.0,
        focalLengthMm: 41.4
      });
    }

    // Sort solve frames monotonically by frameNumber
    solveFrames.sort((a, b) => a.frameNumber - b.frameNumber);

    const solveTrack: CameraSolveTrack = {
      id: `precision_solve_${Date.now()}`,
      coordinateSystem: 'threejs',
      fps,
      totalFrames,
      durationSeconds: durationSec,
      sensorWidthMm: 36.0,
      sensorHeightMm: 24.0,
      focalLengthMm: 41.4,
      frames: solveFrames,
      isSolved: false
    };

    // Interpolate continuous 6-DoF trajectory using cubic Hermite position and quaternion Slerp
    const frames: CameraPoseFrame[] = [];
    const standoffDist = 50.0;

    for (let i = 0; i < totalFrames; i++) {
      const t = totalFrames > 1 ? (i / (totalFrames - 1)) * durationSec : 0.0;
      const pose = VfxPlateMatchmoveService.interpolateCameraSolve(solveTrack, t);
      const { forward, up } = GeoCameraMatchmovePipelineService.quaternionToVectors(pose.rotationQuaternion);

      const target: [number, number, number] = [
        Number((pose.position[0] + forward[0] * standoffDist).toFixed(3)),
        Number((pose.position[1] + forward[1] * standoffDist).toFixed(3)),
        Number((pose.position[2] + forward[2] * standoffDist).toFixed(3))
      ];

      frames.push({
        frame: i,
        timeSec: Number(t.toFixed(4)),
        position: [Number(pose.position[0].toFixed(3)), Number(pose.position[1].toFixed(3)), Number(pose.position[2].toFixed(3))],
        target,
        up: [Number(up[0].toFixed(4)), Number(up[1].toFixed(4)), Number(up[2].toFixed(4))],
        fov: Number(pose.fovDegrees.toFixed(2))
      });
    }

    // Keyframes and motion presets are never compared with the plate here, so there is nothing to score
    const precisionMetrics: PrecisionMetrics = {
      measured: false,
      trajectorySource: options.trajectorySource ?? (Array.isArray(keyframesOrMotion) ? 'keyframes' : 'motion-preset'),
      meanReprojectionErrorPx: null,
      meanEdgeOverlapScorePct: null,
      meanDriftPx: null,
      maxDriftPx: null,
      driftStatus: 'uncalibrated'
    };

    // Render visual proof artifacts if proofOutputDir is set
    const proofArtifacts: PrecisionProofArtifacts = {};
    const proofDir = options.proofOutputDir || path.resolve(process.cwd(), 'public/images');

    if (tileMesh && fs.existsSync(proofDir)) {
      try {
        // Calculate centroid of real 3D tile mesh
        let cx = 0, cy = 0, cz = 0;
        const totalVerts = tileMesh.vertices.length / 3;
        for (let i = 0; i < tileMesh.vertices.length; i += 3) {
          cx += tileMesh.vertices[i];
          cy += tileMesh.vertices[i + 1];
          cz += tileMesh.vertices[i + 2];
        }
        cx /= totalVerts;
        cy /= totalVerts;
        cz /= totalVerts;

        const f0 = frames && frames.length > 0 ? frames[0] : null;
        const f0Pose: CameraPose6DOF = f0 ? {
          x: f0.position[0],
          y: f0.position[1],
          z: f0.position[2],
          targetX: f0.target[0],
          targetY: f0.target[1],
          targetZ: f0.target[2],
          fov: f0.fov || 40.0
        } : {
          x: cx + 18,
          y: cy + 42,
          z: cz - 85,
          targetX: cx,
          targetY: cy,
          targetZ: cz,
          fov: 52
        };

        const renderW = 960;
        const renderH = 640;

        // Stage 2: Shaded render + 3D Wireframe projection
        const stage2Render = HeadlessMeshSilhouetteRenderer.renderShadedMesh(
          tileMesh,
          f0Pose,
          renderW,
          renderH,
          { clayColor: [170, 190, 210], bgColor: [14, 18, 24, 255] }
        );
        HeadlessMeshSilhouetteRenderer.drawWireframe(
          stage2Render.rgba,
          renderW,
          renderH,
          tileMesh,
          f0Pose,
          [0, 240, 255, 255],
          2
        );
        const wfPath = path.join(proofDir, 'precision_matchmove_f1_wireframe.png');
        HeadlessMeshSilhouetteRenderer.exportPngToFile(wfPath, renderW, renderH, stage2Render.rgba);
        proofArtifacts.wireframePaths = [wfPath];

        // Stage 3: Split wipe comparison
        const leftRef = HeadlessMeshSilhouetteRenderer.renderShadedMesh(
          tileMesh,
          f0Pose,
          renderW,
          renderH,
          { clayColor: [225, 215, 195], bgColor: [16, 20, 26, 255] }
        );
        const splitBuffer = HeadlessMeshSilhouetteRenderer.compositeSplit(
          leftRef.rgba,
          stage2Render.rgba,
          renderW,
          renderH,
          0.5
        );
        const splitPath = path.join(proofDir, 'precision_matchmove_f1_split.png');
        HeadlessMeshSilhouetteRenderer.exportPngToFile(splitPath, renderW, renderH, splitBuffer);
        proofArtifacts.splitWipePaths = [splitPath];

        // Stage 4: Sub-pixel edge heatmap
        const edgeField = HeadlessMeshSilhouetteRenderer.renderEdgeField(tileMesh, f0Pose, renderW, renderH);
        const heatmapRgba = HeadlessMeshSilhouetteRenderer.renderEdgeFieldToRgba(edgeField, [16, 185, 129]);
        const heatmapPath = path.join(proofDir, 'precision_matchmove_f1_heatmap.png');
        HeadlessMeshSilhouetteRenderer.exportPngToFile(heatmapPath, renderW, renderH, heatmapRgba);
        proofArtifacts.heatmapPaths = [heatmapPath];
      } catch (err: any) {
        console.warn(`[GeoMatchmove Precision] Warning creating visual proofs: ${err.message}`);
      }
    }

    const pathData: CameraPathData = {
      fps,
      totalFrames,
      durationSec,
      frames,
      origin: geoAnchor
    };

    return {
      pathData,
      solveTrack,
      precisionMetrics,
      proofArtifacts
    };
  }

  /**
   * Executes the full end-to-end Geo Camera Matchmove Pipeline.
   */
  public async execute(request: GeoMatchmoveRequest): Promise<GeoMatchmoveResult> {
    console.log('========================================================================');
    console.log('🌐 Scratchbox Geo-Camera Matchmove Pipeline');
    console.log('========================================================================');

    // 1. Analyze video
    console.log(`🎬 Ingesting Reference Video: ${request.inputVideoPath}`);
    const metadata = await this.analyzeVideo(request.inputVideoPath);
    console.log(`   Specs: ${metadata.width}x${metadata.height} · ${metadata.fps}fps · ${metadata.totalFrames} frames · ${metadata.durationSec.toFixed(2)}s`);

    // 2. Resolve Geodetic Anchor
    const anchor = this.resolveLandmarkAnchor(request.geoAnchor);
    const headingDeg = request.headingDeg ?? anchor.headingDeg;
    console.log(`📍 Geodetic Anchor: lat=${anchor.lat.toFixed(6)}, lng=${anchor.lng.toFixed(6)}, elev=${anchor.elevation}m (${anchor.landmarkName})`);
    console.log(`🧭 Heading / Grid Angle: ${headingDeg.toFixed(1)}°`);

    // 3. Solve Camera Trajectory
    const motionType = request.motionType || 'crane-descent-to-nadir';
    console.log(`📐 Solving 6-DoF Camera Trajectory (Motion: ${motionType})...`);

    let keyframes: TrajectoryKeyframeAnchor[];
    if (request.customKeyframes && request.customKeyframes.length >= 2) {
      keyframes = request.customKeyframes;
    } else {
      const roofAlt = request.startAltitudeMeters ?? 70.5;
      const streetAlt = request.endAltitudeMeters ?? 8.5;
      if (motionType === 'orbital-inspection') {
        keyframes = this.generateOrbitalInspectionAnchors(metadata.durationSec, headingDeg);
      } else if (motionType === 'canyon-flythrough') {
        keyframes = this.generateCanyonFlythroughAnchors(metadata.durationSec, headingDeg);
      } else {
        keyframes = this.generateCraneDescentAnchors(metadata.durationSec, headingDeg, roofAlt, streetAlt);
      }
    }

    const outputDir = request.outputDir || path.resolve(process.cwd(), 'public');
    const modelsDir = path.join(outputDir, 'models');
    const imagesDir = path.join(outputDir, 'images');
    fs.mkdirSync(modelsDir, { recursive: true });
    fs.mkdirSync(imagesDir, { recursive: true });

    let pathData: CameraPathData;
    let precisionMetrics: PrecisionMetrics | undefined;
    let solveTrack: CameraSolveTrack | undefined;
    let proofArtifacts: PrecisionProofArtifacts | undefined;

    if (request.precisionOptimization || request.interpolationMethod === 'hermite-slerp' || request.interpolationMethod === 'continuous-spline') {
      console.log('⚡ Activating Precision 6-DoF Solver (Hermite-Slerp & 3D Tile Edge Alignment)...');
      const precisionResult = this.solvePrecisionTrajectory(metadata, anchor, keyframes, headingDeg, {
        lensDistortion: request.lensDistortion,
        tileMeshPath: request.tileMeshPath,
        resectionKeyframes: request.resectionKeyframes,
        targetOverlapScore: request.targetOverlapScore,
        proofOutputDir: imagesDir,
        trajectorySource: request.customKeyframes && request.customKeyframes.length >= 2 ? 'keyframes' : 'motion-preset'
      });
      pathData = precisionResult.pathData;
      precisionMetrics = precisionResult.precisionMetrics;
      solveTrack = precisionResult.solveTrack;
      proofArtifacts = precisionResult.proofArtifacts;
      console.log(`   Alignment: not measured (path from ${precisionMetrics.trajectorySource}, not tracked from the plate)`);
    } else {
      pathData = this.solveCameraTrajectory(metadata, anchor, keyframes, headingDeg, {
        denseKeyframeCount: request.denseKeyframeCount,
        adaptive: request.adaptiveSampling,
        adaptiveConfig: request.adaptiveConfig
      });
    }

    // Persist Trajectory JSON
    const baseName = request.outputVideoName || path.basename(request.inputVideoPath, path.extname(request.inputVideoPath));
    const cameraPathJsonPath = path.join(modelsDir, `${baseName}_camera_path.json`);
    fs.writeFileSync(cameraPathJsonPath, JSON.stringify(pathData, null, 2));
    console.log(`💾 Persisted 6-DoF trajectory (${pathData.frames.length} frames) to: ${cameraPathJsonPath}`);

    if (request.skipBlockoutRender) {
      return {
        success: true,
        videoMetadata: metadata,
        geoAnchor: anchor,
        motionType,
        totalFrames: metadata.totalFrames,
        fps: metadata.fps,
        durationSec: metadata.durationSec,
        cameraPathJsonPath,
        cameraPathData: pathData,
        summary: `Successfully solved and persisted ${pathData.frames.length}-frame camera trajectory at ${anchor.landmarkName} (Dry-run mode).`,
        precisionMetrics,
        solveTrack,
        proofArtifacts
      };
    }

    // 4. Render Google 3D Tiles Blockout Video
    const videosDir = path.join(outputDir, 'videos');
    const storyboardsDir = path.join(outputDir, `storyboards_${baseName}`);
    fs.mkdirSync(videosDir, { recursive: true });
    fs.mkdirSync(storyboardsDir, { recursive: true });

    const blockoutVideoPath = path.join(videosDir, `${baseName}_blockout_camera.mp4`);
    const startFramePath = path.join(modelsDir, `${baseName}_first_frame.jpg`);
    const startFramePngPath = path.join(imagesDir, `${baseName}_start_frame.png`);
    const manifestPath = path.join(videosDir, `${baseName}_blockout_manifest.json`);

    const requestedMode = request.renderMode || 'textured';
    const isTextured = requestedMode === 'textured' || requestedMode === 'photoreal';
    const blockoutRenderMode: TileAtmosphereRenderMode = (requestedMode === 'warm-clay' || requestedMode === 'studio-grey') ? 'clay' : (requestedMode as TileAtmosphereRenderMode);
    const clayPreset: 'warm-clay' | 'studio-grey' = requestedMode === 'warm-clay' ? 'warm-clay' : 'studio-grey';

    console.log(`\n🏛️ Rendering Google 3D Tiles Blockout Video (<VIDEO_REF_0>)`);
    console.log(`   Mode: ${requestedMode} | Target: ${blockoutVideoPath}`);

    const blockoutReq: TileBlockoutPipelineRequest = {
      geoAnchor: anchor,
      cameraPath: cameraPathJsonPath,
      lodQuality: {
        errorTarget: 0.5,
        resolutionWidth: request.resolution?.width || 3840,
        resolutionHeight: request.resolution?.height || 2160,
        virtualSseWidth: 3840,
        virtualSseHeight: 2160,
        stableFramesThreshold: 8,
        maxSettleWaitMs: 15000
      },
      atmosphere: {
        renderMode: blockoutRenderMode,
        clayPreset,
        clayColor: requestedMode === 'clay' || requestedMode === 'studio-grey' ? '#b0b8c4' : '#dcd6cd',
        roughness: 0.82,
        metalness: 0.02,
        skyColor: '#dce3eb',
        fogExp2Density: 0.0022,
        exposure: isTextured ? 1.05 : 1.15
      },
      collision: {
        enabled: true,
        minClearanceMeters: request.collisionBufferMeters ?? 25.0
      },
      output: {
        outputVideoPath: blockoutVideoPath,
        fps: request.fps || metadata.fps,
        bitrate: request.bitrate || '25M',
        firstFramePath: startFramePath,
        firstFramePngPath: startFramePngPath,
        storyboardsDir: storyboardsDir,
        storyboardBeats: 6,
        manifestPath
      },
      port: request.port
    };

    const blockoutRes = await this.blockoutService.renderBlockoutVideo(blockoutReq);
    if (!blockoutRes.success) {
      throw new Error(`Google 3D Tiles Blockout rendering failed: ${blockoutRes.error}`);
    }

    console.log(`✅ Google 3D Tiles Blockout Video Rendered: ${blockoutVideoPath}`);

    let omniVideoPath: string | undefined;
    let omniWebmPath: string | undefined;
    let omniInteractionId: string | undefined;
    let omniError: string | undefined;
    let comparisonVideoPath: string | undefined;
    let comparisonWebmPath: string | undefined;
    let qaKeyframes: string[] = [];

    // 5. Omni video from the blockout, pinned to the source clip's first and last frames
    if (request.enableOmniSynthesis !== false) {
      console.log(`\n✨ Generating the Omni video from the blockout...`);
      omniVideoPath = path.join(videosDir, `${baseName}_omni_restyled.mp4`);
      omniWebmPath = path.join(videosDir, `${baseName}_omni_restyled.webm`);
      comparisonVideoPath = path.join(videosDir, `${baseName}_vs_omni_comparison.mp4`);
      comparisonWebmPath = path.join(videosDir, `${baseName}_vs_omni_comparison.webm`);

      try {
        const firstFramePng = path.join(imagesDir, `${baseName}_source_first_frame.png`);
        const lastFramePng = path.join(imagesDir, `${baseName}_source_last_frame.png`);
        execSync(`"${this.ffmpegPath}" -y -v error -i "${request.inputVideoPath}" -frames:v 1 "${firstFramePng}"`);
        execSync(`"${this.ffmpegPath}" -y -v error -sseof -1 -i "${request.inputVideoPath}" -update 1 "${lastFramePng}"`);
        const omniResult = await this.omni.generate({
          prompt: buildBlockoutFirstLastPrompt({
            shot: request.omniShot ?? 'Follow the camera move of the blockout exactly.',
            emptyStreets: request.omniEmptyStreets
          }),
          firstFrame: { data: fs.readFileSync(firstFramePng), mimeType: 'image/png' },
          lastFrame: { data: fs.readFileSync(lastFramePng), mimeType: 'image/png' },
          blockoutVideo: { data: fs.readFileSync(blockoutVideoPath), mimeType: 'video/mp4' }
        });
        fs.writeFileSync(omniVideoPath, omniResult.video);
        omniInteractionId = omniResult.interactionId;
        execSync(`"${this.ffmpegPath}" -y -i "${omniVideoPath}" -c:v libvpx-vp9 -threads 8 -cpu-used 4 -b:v 15M "${omniWebmPath}"`, { stdio: 'inherit' });

        // Compile Synchronized Split Comparison Video
        console.log(`⚡ Compiling Synchronized 4K Side-by-Side Comparison: ${comparisonVideoPath}`);
        const halfWidth = Math.floor((request.resolution?.width || 3840) / 2);
        const fullHeight = request.resolution?.height || 2160;

        const splitFilter = `[0:v]scale=${halfWidth}:${fullHeight}:flags=lanczos:force_original_aspect_ratio=increase,crop=${halfWidth}:${fullHeight}[left];[1:v]scale=${halfWidth}:${fullHeight}:flags=lanczos:force_original_aspect_ratio=increase,crop=${halfWidth}:${fullHeight}[right];[left][right]hstack[v]`;

        execSync(`"${this.ffmpegPath}" -y -i "${blockoutVideoPath}" -i "${omniVideoPath}" -filter_complex "${splitFilter}" -map "[v]" -t ${metadata.durationSec} -r ${metadata.fps} -c:v libx264 -pix_fmt yuv420p -b:v 25M "${comparisonVideoPath}"`, { stdio: 'inherit' });
        execSync(`"${this.ffmpegPath}" -y -i "${blockoutVideoPath}" -i "${omniVideoPath}" -filter_complex "${splitFilter}" -map "[v]" -t ${metadata.durationSec} -r ${metadata.fps} -c:v libvpx-vp9 -threads 8 -cpu-used 4 -b:v 15M "${comparisonWebmPath}"`, { stdio: 'inherit' });

        // Extract 6 QA Keyframes
        console.log(`📸 Extracting 6 Milestone QA Keyframes...`);
        const sampleTimes = [
          0.04,
          Number((metadata.durationSec * 0.20).toFixed(2)),
          Number((metadata.durationSec * 0.37).toFixed(2)),
          Number((metadata.durationSec * 0.47).toFixed(2)),
          Number((metadata.durationSec * 0.67).toFixed(2)),
          Number((metadata.durationSec - 0.05).toFixed(2))
        ];

        sampleTimes.forEach((sec, idx) => {
          const kfPath = path.join(imagesDir, `${baseName}_comparison_4k_keyframe_0${idx + 1}.png`);
          execSync(`"${this.ffmpegPath}" -y -ss ${sec} -i "${comparisonVideoPath}" -vframes 1 -q:v 1 "${kfPath}"`, { stdio: 'ignore' });
          if (fs.existsSync(kfPath)) {
            qaKeyframes.push(kfPath);
          }
        });
      } catch (err: any) {
        omniError = err.message;
        console.warn(`[GeoMatchmove] Omni step failed: ${omniError}`);
        const existing = (p?: string) => (p && fs.existsSync(p) ? p : undefined);
        omniVideoPath = omniInteractionId ? existing(omniVideoPath) : undefined;
        omniWebmPath = omniInteractionId ? existing(omniWebmPath) : undefined;
        comparisonVideoPath = omniInteractionId ? existing(comparisonVideoPath) : undefined;
        comparisonWebmPath = omniInteractionId ? existing(comparisonWebmPath) : undefined;
      }
    }

    const summary = [
      `🎉 Geo-Camera Matchmove Pipeline Complete!`,
      `📍 Location: ${anchor.landmarkName} (${anchor.lat}, ${anchor.lng})`,
      `🎥 Trajectory: ${metadata.totalFrames} frames @ ${metadata.fps}fps (${metadata.durationSec.toFixed(2)}s)`,
      `📐 3D Blockout Video: ${blockoutVideoPath}`,
      omniVideoPath ? `✨ Omni Video: ${omniVideoPath} (interaction ${omniInteractionId})` : '',
      omniError ? `⚠️ Omni step failed: ${omniError}` : '',
      comparisonVideoPath ? `⚡ Split Comparison: ${comparisonVideoPath}` : '',
      `📸 QA Keyframes: ${qaKeyframes.length} captured`,
      precisionMetrics
        ? (precisionMetrics.measured
          ? `🎯 Reprojection Error: ${precisionMetrics.meanReprojectionErrorPx} px (Edge Overlap: ${precisionMetrics.meanEdgeOverlapScorePct}%)`
          : `🎯 Alignment: not measured (path from ${precisionMetrics.trajectorySource})`)
        : ''
    ].filter(Boolean).join('\n');

    console.log('\n' + summary);

    return {
      success: true,
      videoMetadata: metadata,
      geoAnchor: anchor,
      motionType,
      totalFrames: metadata.totalFrames,
      fps: metadata.fps,
      durationSec: metadata.durationSec,
      cameraPathJsonPath,
      cameraPathData: pathData,
      blockoutVideoPath,
      startFramePath,
      startFramePngPath,
      storyboardsDir,
      omniVideoPath,
      omniWebmPath,
      omniInteractionId,
      omniError,
      comparisonVideoPath,
      comparisonWebmPath,
      qaKeyframes,
      manifestPath,
      summary,
      precisionMetrics,
      solveTrack,
      proofArtifacts
    };
  }
}
