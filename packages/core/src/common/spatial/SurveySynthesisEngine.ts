/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { LocalTangentPlane } from '../coordinate/LocalTangentPlane';
import type {
  ColmapCameraModel,
  ColmapCameraPose,
  ColmapCameraIntrinsics,
  GeodeticAnchor,
  SurveyPatternConfig,
  ColmapGeoJsonFeatureCollection
} from './colmap-vector-reference-types';

/**
 * Survey Synthesis Engine: the single source of camera truth for photogrammetric survey stations.
 *
 * Pure math, no I/O, runs in browser and Node. Produces 6-DoF stations in the Scratchbox local
 * frame (X = east, Y = up, Z = south) anchored on a WGS-84 geodetic origin, and converts them to
 * and from COLMAP text, RFC 7946 GeoJSON, and pinhole intrinsics. The same station record drives
 * blockout rendering, the AI Beautify prompt, and depth-to-splat unprojection so no stage
 * re-derives a pose.
 */

type V3 = [number, number, number];

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;

const norm = (v: V3): V3 => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

const catmullRom = (p0: V3, p1: V3, p2: V3, p3: V3, t: number): V3 => {
  const t2 = t * t;
  const t3 = t2 * t;
  const f0 = -0.5 * t3 + t2 - 0.5 * t;
  const f1 = 1.5 * t3 - 2.5 * t2 + 1.0;
  const f2 = -1.5 * t3 + 2.0 * t2 + 0.5 * t;
  const f3 = 0.5 * t3 - 0.5 * t2;
  return [
    p0[0] * f0 + p1[0] * f1 + p2[0] * f2 + p3[0] * f3,
    p0[1] * f0 + p1[1] * f1 + p2[1] * f2 + p3[1] * f3,
    p0[2] * f0 + p1[2] * f1 + p2[2] * f2 + p3[2] * f3
  ];
};

export interface StationOptics { focalLengthMm: number; sensorWidthMm: number; aspectRatio?: number }

export interface PinholeIntrinsics {
  width: number; height: number;
  fx: number; fy: number; cx: number; cy: number;
  horizontalFovDegrees: number; verticalFovDegrees: number;
}

/** Horizontal FOV (degrees) of a full-frame-equivalent lens. */
export function horizontalFovDegrees(focalLengthMm: number, sensorWidthMm = 36): number {
  return 2 * Math.atan((sensorWidthMm / 2) / focalLengthMm) * DEG;
}

/** Yaw clockwise from north (-Z) and pitch (up positive) of a forward vector. */
export function yawPitchFromForward(fwd: V3): { yawDegrees: number; pitchDegrees: number } {
  const yaw = ((Math.atan2(fwd[0], -fwd[2]) * DEG) + 360) % 360;
  const pitch = Math.asin(Math.max(-1, Math.min(1, fwd[1]))) * DEG;
  return { yawDegrees: yaw, pitchDegrees: pitch };
}

/** Camera basis (right, up, forward) in world space for a forward vector and world-up. */
export function cameraBasis(fwd: V3, worldUp: V3 = [0, 1, 0]): { right: V3; up: V3; forward: V3 } {
  const f = norm(fwd);
  let r = cross(f, worldUp);
  if (Math.hypot(r[0], r[1], r[2]) < 1e-6) r = [1, 0, 0];
  r = norm(r);
  const u = norm(cross(r, f));
  return { right: r, up: u, forward: f };
}

/** Pinhole intrinsics for a station rendered at width x height (square pixels; horizontal fov is authoritative). */
export function stationToPinhole(pose: ColmapCameraPose, width: number, height: number): PinholeIntrinsics {
  const fx = width / (2 * Math.tan((pose.fovDegrees / 2) * RAD));
  const fy = fx;
  const verticalFovDegrees = 2 * Math.atan(height / (2 * fy)) * DEG;
  return { width, height, fx, fy, cx: width / 2, cy: height / 2, horizontalFovDegrees: pose.fovDegrees, verticalFovDegrees };
}

/** Builds a station from an eye position and look-at target (local frame). */
export function normalizeAnchor(anchor: GeodeticAnchor): GeodeticAnchor {
  const elevation = anchor.elevationMeters ?? (anchor as any).altMeters ?? (anchor as any).altitudeMeters ?? 0;
  return { ...anchor, elevationMeters: elevation };
}

export function stationFromLookAt(
  id: number,
  eye: V3,
  target: V3,
  optics: StationOptics,
  anchor: GeodeticAnchor,
  extras: Partial<ColmapCameraPose> = {}
): ColmapCameraPose {
  const safeAnchor = normalizeAnchor(anchor);
  const ltp = new LocalTangentPlane({ lat: safeAnchor.lat, lng: safeAnchor.lng, alt: safeAnchor.elevationMeters });
  const fwd = norm([target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]]);
  const { yawDegrees, pitchDegrees } = yawPitchFromForward(fwd);
  const fov = horizontalFovDegrees(optics.focalLengthMm, optics.sensorWidthMm);
  const wgs = ltp.toLatLng(eye);
  return {
    id,
    name: extras.name || `STATION_${String(id).padStart(2, '0')}`,
    imageName: extras.imageName || `station_${String(id).padStart(3, '0')}.jpg`,
    positionLocalENU: [eye[0], eye[1], eye[2]],
    forwardVector: fwd,
    upVector: [0, 1, 0],
    yawDegrees: Number(yawDegrees.toFixed(4)),
    pitchDegrees: Number(pitchDegrees.toFixed(4)),
    rollDegrees: 0,
    focalLengthMm: optics.focalLengthMm,
    sensorWidthMm: optics.sensorWidthMm,
    fovDegrees: Number(fov.toFixed(4)),
    aspectRatio: optics.aspectRatio ?? 16 / 9,
    coordinatesWGS84: { lat: Number(wgs.lat.toFixed(8)), lng: Number(wgs.lng.toFixed(8)), elevation: Number((wgs.alt ?? safeAnchor.elevationMeters + eye[1]).toFixed(3)) },
    groundElevationASL: safeAnchor.elevationMeters,
    cameraHeightAboveGround: Number(eye[1].toFixed(3)),
    cameraAltitude: Number(eye[1].toFixed(3)),
    frustumFootprintWGS84: SurveySynthesisEngine.frustumGroundFootprint(eye, fwd, fov, optics.aspectRatio ?? 16 / 9, ltp),
    ...extras
  };
}

export interface RankOptions {
  maxCount: number;
  minMeshCoverage?: number;   // default 0.6
  maxSkyFraction?: number;    // default 0.6 (a level street shot is ~50% sky)
}

export class SurveySynthesisEngine {
  /** Procedural survey pattern around an anchor. Zero presets: every parameter comes from the config. */
  synthesize(anchor: GeodeticAnchor, config: SurveyPatternConfig): ColmapCameraPose[] {
    const safeAnchor = normalizeAnchor(anchor);
    const count = Math.max(3, config.cameraCount || 15);
    const radius = Math.max(10, config.targetRadiusMeters || 120);
    const optics: StationOptics = { focalLengthMm: config.focalLengthMm || 35, sensorWidthMm: config.sensorWidthMm || 36, aspectRatio: config.aspectRatio ?? 16 / 9 };
    const lookAt: V3 = config.lookAtOffsetLocalENU || [0, 20, 0];
    const poses: ColmapCameraPose[] = [];

    const minGroundClearance = Math.max(0.5, config.minCameraHeightAboveGroundMeters ?? 1.5);

    switch (config.type) {
      case 'foveated-multi-tier': {
        // 3-Tier Foveated Survey Pattern (weighted to Tiers 1 & 2 for high facade resolution):
        // Tier 1 (Street Walkway): 12 stations at Y = 2-4m (3.0m), standoff 20-30m, 50mm lens
        // Tier 2 (Facade Ring): 8 stations at Y = 25-35m (30.0m), standoff 40-60m, 35mm lens
        // Tier 3 (Perimeter/Macro Orbit): 4 stations at Y = 75m, macro standoff, 24mm lens
        const tierCounts = count === 24 ? [12, 8, 4] : [Math.ceil(count * 0.5), Math.ceil(count * 0.33), Math.max(1, count - Math.ceil(count * 0.5) - Math.ceil(count * 0.33))];
        const defaultRadii = [
          Math.max(15, Math.min(radius * 0.35, 25)),
          Math.max(35, Math.min(radius * 0.65, 50)),
          Math.max(90, Math.min(radius * 1.15, 120))
        ];
        const defaultAlts = [Math.max(minGroundClearance, 3.0), 30.0, 75.0];
        const defaultTargets: V3[] = [
          [lookAt[0], 6.0, lookAt[2]],
          [lookAt[0], 28.0, lookAt[2]],
          [lookAt[0], 20.0, lookAt[2]]
        ];
        const defaultFocals = [50, 35, 24];
        const tierNames = ['TIER_1_STREET', 'TIER_2_FACADE', 'TIER_3_AERIAL'];

        let id = 1;
        for (let t = 0; t < 3 && poses.length < count; t++) {
          const tCount = tierCounts[t];
          const tRadius = config.tierRadiiMeters && config.tierRadiiMeters[t] !== undefined
            ? config.tierRadiiMeters[t]
            : defaultRadii[t];
          const tAlt = config.altitudeTiersMeters && config.altitudeTiersMeters[t] !== undefined
            ? Math.max(minGroundClearance, config.altitudeTiersMeters[t] - safeAnchor.elevationMeters)
            : defaultAlts[t];
          const tTarget: V3 = config.lookAtTiersOffsetLocalENU && config.lookAtTiersOffsetLocalENU[t]
            ? config.lookAtTiersOffsetLocalENU[t]
            : defaultTargets[t];
          const tFocal = defaultFocals[t];

          const tierOptics: StationOptics = {
            focalLengthMm: tFocal,
            sensorWidthMm: config.sensorWidthMm || 36,
            aspectRatio: config.aspectRatio ?? 16 / 9
          };
          const offset = t * (Math.PI / Math.max(1, tCount));
          for (let i = 0; i < tCount && poses.length < count; i++) {
            const theta = (2 * Math.PI * i) / tCount + offset;
            const eye: V3 = [tTarget[0] + tRadius * Math.sin(theta), tAlt, tTarget[2] + tRadius * Math.cos(theta)];
            poses.push(stationFromLookAt(id, eye, tTarget, tierOptics, safeAnchor, {
              name: `ORBIT_${tierNames[t]}_STATION_${String(id).padStart(2, '0')}`,
              cameraAltitude: tAlt,
              cameraHeightAboveGround: tAlt
            }));
            id++;
          }
        }
        break;
      }

      case 'amphitheatre-complete': {
        // 6-Tier Amphitheatre & Monument Watertight Survey Pattern:
        // Tier 1 (Street Walkway & Doric Arches): 24 stations at Y = 3.5m, radius 110m, look at Y = 6m, 35mm lens
        // Tier 2 (Exterior Mid-Facade): 24 stations at Y = 20.0m, radius 130m, look at Y = 22m, 35mm lens
        // Tier 3 (Exterior Upper Attic): 16 stations at Y = 38.0m, radius 150m, look at Y = 44m, 50mm lens
        // Tier 4 (Arena Floor & Hypogeum Rim): 16 stations at Y = 4.5m, radius 28m, looking OUTWARD/UP at seating, 24mm lens
        // Tier 5 (Interior Mid-Cavea Seating Ring): 16 stations at Y = 20.0m, radius 55m, looking ACROSS/DOWN, 28mm lens
        // Tier 6 (Oblique Attic Rim & Cornice): 16 stations at Y = 65.0m, radius 85m, looking DOWN at top rim, 35mm lens
        let tierAllocations: { name: string; count: number; altENU: number; radius: number; focalLengthMm: number; mode: 'inward' | 'outward-up' | 'across-down' | 'rim-down'; targetY: number }[];

        if (count <= 40) {
          tierAllocations = [
            { name: 'TIER_1_STREET', count: 12, altENU: Math.max(minGroundClearance, 3.5), radius: 110, focalLengthMm: 35, mode: 'inward', targetY: 6.0 },
            { name: 'TIER_2_FACADE', count: 8, altENU: 20.0, radius: 130, focalLengthMm: 35, mode: 'inward', targetY: 22.0 },
            { name: 'TIER_3_ATTIC', count: 4, altENU: 38.0, radius: 150, focalLengthMm: 50, mode: 'inward', targetY: 44.0 },
            { name: 'TIER_4_ARENA_FLOOR', count: 8, altENU: 4.5, radius: 28, focalLengthMm: 24, mode: 'outward-up', targetY: 22.0 },
            { name: 'TIER_5_CAVEA_SEATING', count: 8, altENU: 20.0, radius: 55, focalLengthMm: 28, mode: 'across-down', targetY: 8.0 }
          ];
        } else {
          const baseCounts = count === 112 ? [24, 24, 16, 16, 16, 16] : [
            Math.round(count * 0.22),
            Math.round(count * 0.22),
            Math.round(count * 0.14),
            Math.round(count * 0.14),
            Math.round(count * 0.14),
            Math.max(1, count - 2 * Math.round(count * 0.22) - 3 * Math.round(count * 0.14))
          ];
          tierAllocations = [
            { name: 'TIER_1_STREET', count: baseCounts[0], altENU: Math.max(minGroundClearance, 3.5), radius: 110, focalLengthMm: 35, mode: 'inward', targetY: 6.0 },
            { name: 'TIER_2_FACADE', count: baseCounts[1], altENU: 20.0, radius: 130, focalLengthMm: 35, mode: 'inward', targetY: 22.0 },
            { name: 'TIER_3_ATTIC', count: baseCounts[2], altENU: 38.0, radius: 150, focalLengthMm: 50, mode: 'inward', targetY: 44.0 },
            { name: 'TIER_4_ARENA_FLOOR', count: baseCounts[3], altENU: 4.5, radius: 28, focalLengthMm: 24, mode: 'outward-up', targetY: 22.0 },
            { name: 'TIER_5_CAVEA_SEATING', count: baseCounts[4], altENU: 20.0, radius: 55, focalLengthMm: 28, mode: 'across-down', targetY: 8.0 },
            { name: 'TIER_6_RIM_SURVEY', count: baseCounts[5], altENU: 65.0, radius: 85, focalLengthMm: 35, mode: 'rim-down', targetY: 35.0 }
          ];
        }

        const arXZ = config.aspectRatioXZ && config.aspectRatioXZ > 0 ? config.aspectRatioXZ : 1.0;
        const scaleX = Math.sqrt(arXZ);
        const scaleZ = 1.0 / Math.sqrt(arXZ);

        let id = 1;
        for (let t = 0; t < tierAllocations.length && poses.length < count; t++) {
          const tier = tierAllocations[t];
          const tierOptics: StationOptics = {
            focalLengthMm: tier.focalLengthMm,
            sensorWidthMm: config.sensorWidthMm || 36,
            aspectRatio: config.aspectRatio ?? 16 / 9
          };
          const offset = t * (Math.PI / Math.max(1, tier.count));
          for (let i = 0; i < tier.count && poses.length < count; i++) {
            const theta = (2 * Math.PI * i) / tier.count + offset;
            const eyeX = lookAt[0] + tier.radius * scaleX * Math.sin(theta);
            const eyeY = tier.altENU;
            const eyeZ = lookAt[2] + tier.radius * scaleZ * Math.cos(theta);
            const eye: V3 = [eyeX, eyeY, eyeZ];

            let target: V3;
            if (tier.mode === 'inward') {
              target = [lookAt[0], tier.targetY, lookAt[2]];
            } else if (tier.mode === 'outward-up') {
              const lookDist = 75.0;
              target = [lookAt[0] + lookDist * scaleX * Math.sin(theta), tier.targetY, lookAt[2] + lookDist * scaleZ * Math.cos(theta)];
            } else if (tier.mode === 'across-down') {
              const oppositeDist = 25.0;
              target = [lookAt[0] - oppositeDist * scaleX * Math.sin(theta), tier.targetY, lookAt[2] - oppositeDist * scaleZ * Math.cos(theta)];
            } else {
              target = [lookAt[0] + tier.radius * 0.85 * scaleX * Math.sin(theta), tier.targetY, lookAt[2] + tier.radius * 0.85 * scaleZ * Math.cos(theta)];
            }

            poses.push(stationFromLookAt(id, eye, target, tierOptics, safeAnchor, {
              name: `AMPHITHEATRE_${tier.name}_STATION_${String(id).padStart(2, '0')}`,
              cameraAltitude: eyeY,
              cameraHeightAboveGround: eyeY
            }));
            id++;
          }
        }
        break;
      }

      case 'orbital-multi-tier': {
        const hasCustomTiers = Array.isArray(config.altitudeTiersMeters) && config.altitudeTiersMeters.length > 0;
        const isMacro28 = !hasCustomTiers && (count === 28 || (radius >= 100 && count >= 24));
        if (isMacro28) {
          // Macro landmark 3-tier foveated distribution:
          // Tier 1 (Street Walkway): 12 stations (1.7m-3.5m altitude, 15m-25m standoff, 50mm lens)
          // Tier 2 (Facade Ring): 12 stations (25m-35m altitude, 35m-50m standoff, 35mm lens)
          // Tier 3 (Perimeter Orbit): 8 stations (75m altitude, 90m-120m standoff, 24mm lens)
          const tierSpecs = [
            { count: 12, altENU: Math.max(minGroundClearance, 2.5), tierRadius: Math.max(15, Math.min(radius * 0.35, 25)), targetY: 2.5, focalLengthMm: config.focalLengthMm || 50, name: 'TIER_1_STREET' },
            { count: 12, altENU: 30, tierRadius: Math.max(35, Math.min(radius * 0.65, 50)), targetY: 25, focalLengthMm: config.focalLengthMm || 35, name: 'TIER_2_FACADE' },
            { count: 8, altENU: 75, tierRadius: Math.max(90, Math.min(radius * 1.15, 120)), targetY: 35, focalLengthMm: config.focalLengthMm || 24, name: 'TIER_3_AERIAL' }
          ];
          let id = 1;
          for (let t = 0; t < tierSpecs.length; t++) {
            const spec = tierSpecs[t];
            const tierOptics: StationOptics = {
              focalLengthMm: spec.focalLengthMm,
              sensorWidthMm: config.sensorWidthMm || 36,
              aspectRatio: config.aspectRatio ?? 16 / 9
            };
            const offset = t * (Math.PI / spec.count);
            for (let i = 0; i < spec.count && poses.length < count; i++) {
              const theta = (2 * Math.PI * i) / spec.count + offset;
              const eye: V3 = [lookAt[0] + spec.tierRadius * Math.sin(theta), spec.altENU, lookAt[2] + spec.tierRadius * Math.cos(theta)];
              const target: V3 = [lookAt[0], spec.targetY, lookAt[2]];
              poses.push(stationFromLookAt(id, eye, target, tierOptics, anchor, {
                name: `ORBIT_${spec.name}_STATION_${String(id).padStart(2, '0')}`,
                cameraAltitude: spec.altENU,
                cameraHeightAboveGround: spec.altENU
              }));
              id++;
            }
          }
          break;
        }

        const tiers = config.altitudeTiersMeters && config.altitudeTiersMeters.length > 0
          ? config.altitudeTiersMeters
          : [safeAnchor.elevationMeters + 25, safeAnchor.elevationMeters + 75, safeAnchor.elevationMeters + 140];
        const perTier = Math.ceil(count / tiers.length);
        let id = 1;
        for (let t = 0; t < tiers.length; t++) {
          const tierRadius = config.tierRadiiMeters && config.tierRadiiMeters[t] !== undefined
            ? config.tierRadiiMeters[t]
            : radius * (1 + t * 0.2);
          const offset = t * (Math.PI / perTier);
          const tierAltENU = Math.max(minGroundClearance, tiers[t] - safeAnchor.elevationMeters);
          const tierLookAt: V3 = config.lookAtTiersOffsetLocalENU && config.lookAtTiersOffsetLocalENU[t]
            ? config.lookAtTiersOffsetLocalENU[t]
            : lookAt;
          for (let i = 0; i < perTier && poses.length < count; i++) {
            const theta = (2 * Math.PI * i) / perTier + offset;
            const eye: V3 = [tierLookAt[0] + tierRadius * Math.sin(theta), tierAltENU, tierLookAt[2] + tierRadius * Math.cos(theta)];
            poses.push(stationFromLookAt(id, eye, tierLookAt, optics, safeAnchor, {
              name: `ORBIT_TIER_${t + 1}_STATION_${String(id).padStart(2, '0')}`,
              cameraAltitude: tierAltENU,
              cameraHeightAboveGround: tierAltENU
            }));
            id++;
          }
        }
        break;
      }
      case 'district-complete': {
        // 6-Tier Inside-Out Hierarchical Photogrammetric Survey Pattern:
        // Tier 1 (Stage Ground & Deck Perimeter): ~15% of stations (standoff 12m-25m, eye-level Y = lookAt[1] + 1.8m..3.2m), looking directly at stage floor/apron/performer
        // Tier 2 (Overhead Stage Canopy & Roof Crown): ~12% of stations (standoff 16m-30m, elevated Y = lookAt[1] + 16m..22m, tilted downward -35°..-50° onto pavilion roof)
        // Tier 3 (Under-Canopy Soffit & Backstage Ramps): ~10% of stations (standoff 10m-18m, elevated Y = lookAt[1] + 1.2m..2.0m, tilted upward +30°..+45° under the roof)
        // Tier 4 (Inner Amphitheatre Basin & Terraced Steps): ~18% of stations (standoff 45m-85m, Y = lookAt[1] + 18m..28m, pitch -18°..-25°), covering seating bowl & soundboard
        // Tier 5 (Upper Concourse & Monolithic Cliffs): ~20% of stations (standoff 110m-180m, Y = lookAt[1] + 45m..75m), covering Visitor Center, Creation Rock & Ship Rock
        // Tier 6 (Macro Landscape & Orthogonal Nadir Topographic Matrix): ~25% of stations (standoff 220m-320m + 2D orthogonal nadir grid covering full 450m landscape from Y = 140m..160m)
        const c1 = Math.max(4, Math.round(count * 0.15));
        const c2 = Math.max(4, Math.round(count * 0.12));
        const c3 = Math.max(4, Math.round(count * 0.10));
        const c4 = Math.max(4, Math.round(count * 0.18));
        const c5 = Math.max(4, Math.round(count * 0.20));
        const c6 = count - (c1 + c2 + c3 + c4 + c5);

        let id = 1;
        // Tier 1: Stage Ground & Deck Perimeter (Standoff ~0.07 * R)
        const r1 = Math.max(12, Math.min(26, radius * 0.07));
        const opt1: StationOptics = { focalLengthMm: config.focalLengthMm || 35, sensorWidthMm: config.sensorWidthMm || 36, aspectRatio: config.aspectRatio ?? 16 / 9 };
        for (let i = 0; i < c1 && poses.length < count; i++) {
          const theta = (2 * Math.PI * i) / c1;
          const eyeY1 = Math.max(minGroundClearance, lookAt[1] + 2.2);
          const eye: V3 = [lookAt[0] + r1 * Math.sin(theta), eyeY1, lookAt[2] + r1 * Math.cos(theta)];
          const target: V3 = [lookAt[0], lookAt[1] + 1.2, lookAt[2]];
          poses.push(stationFromLookAt(id, eye, target, opt1, safeAnchor, {
            name: `DISTRICT_TIER_1_FOCAL_${String(id).padStart(2, '0')}`,
            cameraAltitude: eyeY1,
            cameraHeightAboveGround: eyeY1
          }));
          id++;
        }

        // Tier 2: Overhead Stage Canopy & Roof Crown (Standoff ~0.10 * R, downward pitch -35° to -50°)
        const r2 = Math.max(18, Math.min(35, radius * 0.10));
        const eyeY2 = Math.max(minGroundClearance, lookAt[1] + 18.5);
        const opt2: StationOptics = { focalLengthMm: 30, sensorWidthMm: config.sensorWidthMm || 36, aspectRatio: config.aspectRatio ?? 16 / 9 };
        const offset2 = Math.PI / c2;
        for (let i = 0; i < c2 && poses.length < count; i++) {
          const theta = (2 * Math.PI * i) / c2 + offset2;
          const eye: V3 = [lookAt[0] + r2 * Math.sin(theta), eyeY2, lookAt[2] + r2 * Math.cos(theta)];
          const target: V3 = [lookAt[0], lookAt[1] + 8.5, lookAt[2]];
          poses.push(stationFromLookAt(id, eye, target, opt2, safeAnchor, {
            name: `DISTRICT_TIER_2_ROOF_${String(id).padStart(2, '0')}`,
            cameraAltitude: eyeY2,
            cameraHeightAboveGround: eyeY2
          }));
          id++;
        }

        // Tier 3: Under-Canopy Soffit & Backstage Ramps (Standoff ~0.05 * R, upward pitch +35° to +55°)
        const r3 = Math.max(8, Math.min(18, radius * 0.05));
        const eyeY3 = Math.max(minGroundClearance, lookAt[1] + 1.4);
        const opt3: StationOptics = { focalLengthMm: 28, sensorWidthMm: config.sensorWidthMm || 36, aspectRatio: config.aspectRatio ?? 16 / 9 };
        const offset3 = (Math.PI * 0.5) / c3;
        for (let i = 0; i < c3 && poses.length < count; i++) {
          const theta = (2 * Math.PI * i) / c3 + offset3;
          const eye: V3 = [lookAt[0] + r3 * Math.sin(theta), eyeY3, lookAt[2] + r3 * Math.cos(theta)];
          const target: V3 = [lookAt[0], lookAt[1] + 11.5, lookAt[2]];
          poses.push(stationFromLookAt(id, eye, target, opt3, safeAnchor, {
            name: `DISTRICT_TIER_3_SOFFIT_${String(id).padStart(2, '0')}`,
            cameraAltitude: eyeY3,
            cameraHeightAboveGround: eyeY3
          }));
          id++;
        }

        // Tier 4: Inner Amphitheatre Basin & Terraced Steps (Standoff ~0.25 * R, pitch -18° to -25°)
        const r4 = Math.max(45, radius * 0.25);
        const eyeY4 = Math.max(minGroundClearance, lookAt[1] + 18.0);
        const opt4: StationOptics = { focalLengthMm: 28, sensorWidthMm: config.sensorWidthMm || 36, aspectRatio: config.aspectRatio ?? 16 / 9 };
        const offset4 = Math.PI / c4;
        for (let i = 0; i < c4 && poses.length < count; i++) {
          const theta = (2 * Math.PI * i) / c4 + offset4;
          const eye: V3 = [lookAt[0] + r4 * Math.sin(theta), eyeY4, lookAt[2] + r4 * Math.cos(theta)];
          const target: V3 = [lookAt[0], lookAt[1] + 3.0, lookAt[2]];
          poses.push(stationFromLookAt(id, eye, target, opt4, safeAnchor, {
            name: `DISTRICT_TIER_4_OBLIQUE_BASIN_${String(id).padStart(2, '0')}`,
            cameraAltitude: eyeY4,
            cameraHeightAboveGround: eyeY4
          }));
          id++;
        }

        // Tier 5: Upper Concourse & Monolithic Cliffs (Standoff ~0.55 * R)
        const r5 = Math.max(100, radius * 0.52);
        const eyeY5 = Math.max(minGroundClearance, lookAt[1] + 55.0);
        const opt5: StationOptics = { focalLengthMm: 24, sensorWidthMm: config.sensorWidthMm || 36, aspectRatio: config.aspectRatio ?? 16 / 9 };
        const offset5 = (Math.PI * 0.35) / c5;
        for (let i = 0; i < c5 && poses.length < count; i++) {
          const theta = (2 * Math.PI * i) / c5 + offset5;
          const eye: V3 = [lookAt[0] + r5 * Math.sin(theta), eyeY5, lookAt[2] + r5 * Math.cos(theta)];
          const target: V3 = [lookAt[0], lookAt[1] + 5.0, lookAt[2]];
          poses.push(stationFromLookAt(id, eye, target, opt5, safeAnchor, {
            name: `DISTRICT_TIER_5_PERIMETER_${String(id).padStart(2, '0')}`,
            cameraAltitude: eyeY5,
            cameraHeightAboveGround: eyeY5
          }));
          id++;
        }

        // Tier 6: High-Altitude Nadir & Orthogonal Terrain Grid
        // 2D orthogonal matrix covering [-0.85*R, +0.85*R] x [-0.85*R, +0.85*R]
        // Looking directly downward (-Y) with perpendicular rays (cos theta ~ 1.0)
        const gridCols = Math.ceil(Math.sqrt(c6 * (16 / 9)));
        const gridRows = Math.ceil(c6 / gridCols);
        const gridAlt = Math.max(minGroundClearance, lookAt[1] + 155.0);
        const gridSpan = radius * 1.7; // Full diameter span
        const opt6: StationOptics = { focalLengthMm: 24, sensorWidthMm: config.sensorWidthMm || 36, aspectRatio: config.aspectRatio ?? 16 / 9 };

        for (let r = 0; r < gridRows && poses.length < count; r++) {
          const ty = gridRows > 1 ? (r / (gridRows - 1) - 0.5) : 0;
          for (let c = 0; c < gridCols && poses.length < count; c++) {
            const tx = gridCols > 1 ? (c / (gridCols - 1) - 0.5) : 0;
            const eyeX = lookAt[0] + tx * gridSpan;
            const eyeZ = lookAt[2] + ty * gridSpan;
            const eye: V3 = [eyeX, gridAlt, eyeZ];
            const targetX = eyeX * 0.15 + lookAt[0] * 0.85;
            const targetZ = eyeZ * 0.15 + lookAt[2] * 0.85;
            const target: V3 = [targetX, lookAt[1], targetZ];
            poses.push(stationFromLookAt(id, eye, target, opt6, safeAnchor, {
              name: `DISTRICT_TIER_6_NADIR_R${r + 1}_C${c + 1}_${String(id).padStart(2, '0')}`,
              cameraAltitude: gridAlt,
              cameraHeightAboveGround: gridAlt
            }));
            id++;
          }
        }
        break;
      }
      case 'facade-lawnmower': {
        const h = (anchor.headingDeg || 0) * RAD;
        const n: [number, number] = [Math.sin(h), Math.cos(h)];
        const tg: [number, number] = [-n[1], n[0]];
        const widthM = radius * 1.5;
        const minAlt = Math.max(minGroundClearance, 10), maxAlt = 120, rows = 3;
        const cols = Math.ceil(count / rows);
        let id = 1;
        for (let r = 0; r < rows; r++) {
          const y = minAlt + (r * (maxAlt - minAlt)) / (rows - 1);
          for (let c = 0; c < cols && poses.length < count; c++) {
            const t = cols > 1 ? c / (cols - 1) - 0.5 : 0;
            const eye: V3 = [t * widthM * tg[0] + radius * n[0], y, t * widthM * tg[1] + radius * n[1]];
            const target: V3 = [eye[0] - n[0], y, eye[2] - n[1]];
            poses.push(stationFromLookAt(id, eye, target, optics, anchor, {
              name: `FACADE_ROW_${r + 1}_COL_${String(c + 1).padStart(2, '0')}`, imageName: `facade_${String(id).padStart(3, '0')}.jpg`
            }));
            id++;
          }
        }
        break;
      }
      case 'continuous-flight': {
        // Continuous 6-DOF Spline Flight Trajectory:
        // Simulates a smooth, cinematic camera/drone flight weaving through the space.
        // Provides dense sequential frame overlap (65-80%) eliminating sudden perspective gaps.
        const defaultWaypoints: Array<{ pos: V3; tgt: V3; focal?: number }> = [
          // 1. Stage Front Low (VIP Front perspective)
          { pos: [lookAt[0], lookAt[1] + 2.0, lookAt[2] + 0.08 * radius], tgt: [lookAt[0], lookAt[1] + 1.2, lookAt[2]], focal: 35 },
          // 2. Stage Right Wing Sweep
          { pos: [lookAt[0] + 0.09 * radius, lookAt[1] + 2.4, lookAt[2] + 0.03 * radius], tgt: [lookAt[0], lookAt[1] + 1.2, lookAt[2]], focal: 30 },
          // 3. Under Canopy & Soffit Upward Banking
          { pos: [lookAt[0] + 0.04 * radius, lookAt[1] + 1.5, lookAt[2] - 0.04 * radius], tgt: [lookAt[0], lookAt[1] + 12.0, lookAt[2]], focal: 28 },
          // 4. Backstage Ramp / North Exit
          { pos: [lookAt[0] - 0.06 * radius, lookAt[1] + 3.2, lookAt[2] - 0.08 * radius], tgt: [lookAt[0], lookAt[1] + 4.0, lookAt[2]], focal: 32 },
          // 5. Creation Rock (North Monolith) Chute Banking
          { pos: [lookAt[0] - 0.20 * radius, lookAt[1] + 16.0, lookAt[2] - 0.02 * radius], tgt: [lookAt[0] - 0.12 * radius, lookAt[1] + 20.0, lookAt[2] + 0.10 * radius], focal: 28 },
          // 6. Soundboard / Mix Board Elevation
          { pos: [lookAt[0], lookAt[1] + 8.5, lookAt[2] + 0.22 * radius], tgt: [lookAt[0], lookAt[1] + 2.2, lookAt[2]], focal: 35 },
          // 7. Raked Amphitheatre Seating Bowl Ascending Climb
          { pos: [lookAt[0] + 0.12 * radius, lookAt[1] + 20.0, lookAt[2] + 0.45 * radius], tgt: [lookAt[0], lookAt[1] + 3.0, lookAt[2]], focal: 35 },
          // 8. Ship Rock (South Monolith) Ridge Banking
          { pos: [lookAt[0] + 0.28 * radius, lookAt[1] + 35.0, lookAt[2] + 0.35 * radius], tgt: [lookAt[0] + 0.15 * radius, lookAt[1] + 22.0, lookAt[2]], focal: 32 },
          // 9. Top Concourse Promenade
          { pos: [lookAt[0], lookAt[1] + 36.0, lookAt[2] + 0.65 * radius], tgt: [lookAt[0], lookAt[1] + 4.0, lookAt[2]], focal: 35 },
          // 10. Aerial Overview Apex Corkscrew
          { pos: [lookAt[0] - 0.22 * radius, lookAt[1] + 55.0, lookAt[2] + 0.40 * radius], tgt: [lookAt[0], lookAt[1] + 10.0, lookAt[2]], focal: 28 },
          // 11. Mid Descent Arc
          { pos: [lookAt[0] - 0.15 * radius, lookAt[1] + 28.0, lookAt[2] + 0.25 * radius], tgt: [lookAt[0], lookAt[1] + 3.0, lookAt[2]], focal: 32 },
          // 12. Final Approach toward Stage
          { pos: [lookAt[0] - 0.05 * radius, lookAt[1] + 8.0, lookAt[2] + 0.14 * radius], tgt: [lookAt[0], lookAt[1] + 1.8, lookAt[2]], focal: 35 }
        ];

        const waypoints = (config.flightWaypoints && config.flightWaypoints.length >= 4)
          ? config.flightWaypoints.map(w => ({
              pos: w.position as V3,
              tgt: w.target as V3,
              focal: w.fov ? (36 / (2 * Math.tan((w.fov / 2) * RAD))) : (config.focalLengthMm || 35)
            }))
          : defaultWaypoints;

        const numWp = waypoints.length;
        for (let i = 0; i < count; i++) {
          const u = i / count;
          const param = u * numWp;
          const segIdx = Math.floor(param) % numWp;
          const localT = param - Math.floor(param);

          const i0 = (segIdx - 1 + numWp) % numWp;
          const i1 = segIdx % numWp;
          const i2 = (segIdx + 1) % numWp;
          const i3 = (segIdx + 2) % numWp;

          const p0 = waypoints[i0].pos;
          const p1 = waypoints[i1].pos;
          const p2 = waypoints[i2].pos;
          const p3 = waypoints[i3].pos;

          const t0 = waypoints[i0].tgt;
          const t1 = waypoints[i1].tgt;
          const t2 = waypoints[i2].tgt;
          const t3 = waypoints[i3].tgt;

          const eyePos = catmullRom(p0, p1, p2, p3, localT);
          const tgtPos = catmullRom(t0, t1, t2, t3, localT);
          const f1Focal = waypoints[i1].focal ?? (config.focalLengthMm || 35);
          const f2Focal = waypoints[i2].focal ?? (config.focalLengthMm || 35);
          const interpFocal = f1Focal * (1 - localT) + f2Focal * localT;

          eyePos[1] = Math.max(minGroundClearance, eyePos[1]);

          const frameOptics: StationOptics = {
            focalLengthMm: interpFocal,
            sensorWidthMm: config.sensorWidthMm || 36,
            aspectRatio: config.aspectRatio ?? 16 / 9
          };

          const stationPose = stationFromLookAt(i + 1, eyePos, tgtPos, frameOptics, safeAnchor, {
            name: `FLIGHT_FRAME_${String(i + 1).padStart(3, '0')}`,
            imageName: `flight_frame_${String(i + 1).padStart(3, '0')}.jpg`,
            cameraAltitude: eyePos[1],
            cameraHeightAboveGround: eyePos[1]
          });
          poses.push(stationPose);
        }
        break;
      }
      default: {
        const heading = config.corridorHeadingDeg ?? anchor.headingDeg ?? 0;
        const h = heading * RAD;
        const lengthM = config.corridorLengthMeters || radius * 3;
        const step = lengthM / Math.max(1, count - 1);
        const isNadir = config.type === 'nadir-grid';
        const y = isNadir ? 180 : Math.max(minGroundClearance, config.cameraHeightMeters ?? 25);
        for (let i = 0; i < count; i++) {
          const d = -lengthM / 2 + i * step;
          // heading clockwise from north: north = -Z, east = +X
          const eye: V3 = [d * Math.sin(h), y, -d * Math.cos(h)];
          const target: V3 = isNadir ? [eye[0] + 0.001, 0, eye[2]] : [eye[0] + Math.sin(h), y, eye[2] - Math.cos(h)];
          poses.push(stationFromLookAt(i + 1, eye, target, optics, anchor, {
            name: `${(config.type as string).toUpperCase()}_STATION_${String(i + 1).padStart(2, '0')}`, imageName: `corridor_${String(i + 1).padStart(3, '0')}.jpg`
          }));
        }
        break;
      }
    }
    return poses;
  }

  /** 4-corner ground footprint [lng, lat] of a frustum sampled at viewDistance (clamped to y >= 0). */
  static frustumGroundFootprint(eye: V3, fwd: V3, fovDeg: number, aspect: number, ltp: LocalTangentPlane, viewDistanceMeters = 80): [number, number][] {
    const { right, up } = cameraBasis(fwd);
    const dist = Math.max(15, viewDistanceMeters);
    const halfW = dist * Math.tan((fovDeg / 2) * RAD);
    const halfH = halfW / aspect;
    const c: V3 = [eye[0] + fwd[0] * dist, eye[1] + fwd[1] * dist, eye[2] + fwd[2] * dist];
    const corner = (sx: number, sy: number): V3 => [
      c[0] + right[0] * halfW * sx + up[0] * halfH * sy,
      Math.max(0, c[1] + right[1] * halfW * sx + up[1] * halfH * sy),
      c[2] + right[2] * halfW * sx + up[2] * halfH * sy
    ];
    return [corner(-1, 1), corner(1, 1), corner(1, -1), corner(-1, -1)].map(p => {
      const ll = ltp.toLatLng(p);
      return [Number(ll.lng.toFixed(8)), Number(ll.lat.toFixed(8))] as [number, number];
    });
  }

  /**
   * COLMAP cameras.txt / images.txt. Convention: images.txt stores camera-from-world (R, t) with the
   * COLMAP camera frame x right, y down, z forward, so R rows are (right, -up, forward) in world
   * coordinates and t = -R C. Ingest inverts this exactly (fromColmapText).
   */
  toColmapText(poses: ColmapCameraPose[], image: { width: number; height: number } = { width: 1920, height: 1080 }): { camerasText: string; imagesText: string } {
    const { width, height } = image;
    const byFocal = new Map<string, number>();
    let camerasText = '# Camera list with one line of data per camera:\n#   CAMERA_ID, MODEL, WIDTH, HEIGHT, PARAMS[]\n';
    const cameraLines: string[] = [];
    const cameraIdFor = (pose: ColmapCameraPose): number => {
      const key = pose.fovDegrees.toFixed(4);
      if (!byFocal.has(key)) {
        const cam = stationToPinhole(pose, width, height);
        byFocal.set(key, byFocal.size + 1);
        cameraLines.push(`${byFocal.size} PINHOLE ${width} ${height} ${cam.fx.toFixed(6)} ${cam.fy.toFixed(6)} ${cam.cx.toFixed(2)} ${cam.cy.toFixed(2)}`);
      }
      return byFocal.get(key)!;
    };

    let imagesText = '# Image list with two lines of data per image:\n#   IMAGE_ID, QW, QX, QY, QZ, TX, TY, TZ, CAMERA_ID, NAME\n#   POINTS2D[] as (X, Y, POINT3D_ID)\n';
    imagesText += `# Number of images: ${poses.length}\n`;
    for (const pose of poses) {
      const camId = cameraIdFor(pose);
      const { right, up, forward } = cameraBasis(pose.forwardVector, pose.upVector || [0, 1, 0]);
      // R_w2c rows
      const R = [right, [-up[0], -up[1], -up[2]] as V3, forward];
      const q = SurveySynthesisEngine.quatFromRotationRows(R);
      const C = pose.positionLocalENU;
      const t = [-dot(R[0], C), -dot(R[1], C), -dot(R[2], C)];
      const name = pose.imageName || `station_${String(pose.id).padStart(3, '0')}.jpg`;
      imagesText += `${pose.id} ${q.w.toFixed(8)} ${q.x.toFixed(8)} ${q.y.toFixed(8)} ${q.z.toFixed(8)} ${t[0].toFixed(6)} ${t[1].toFixed(6)} ${t[2].toFixed(6)} ${camId} ${name}\n\n`;
    }
    camerasText += `# Number of cameras: ${cameraLines.length}\n${cameraLines.join('\n')}\n`;
    return { camerasText, imagesText };
  }

  /** Parses COLMAP cameras.txt / images.txt into stations relative to the anchor. */
  fromColmapText(camerasText: string, imagesText: string, anchor: GeodeticAnchor): ColmapCameraPose[] {
    const safeAnchor = normalizeAnchor(anchor);
    const ltp = new LocalTangentPlane({ lat: safeAnchor.lat, lng: safeAnchor.lng, alt: safeAnchor.elevationMeters });
    const intrinsics = new Map<number, ColmapCameraIntrinsics>();
    for (const raw of camerasText.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const p = line.split(/\s+/);
      if (p.length < 5) continue;
      const id = parseInt(p[0], 10);
      const model = p[1] as ColmapCameraModel;
      const width = parseInt(p[2], 10), height = parseInt(p[3], 10);
      const params = p.slice(4).map(Number);
      let fx = 1000, fy = 1000, cx = width / 2, cy = height / 2;
      if (model === 'SIMPLE_PINHOLE' || model === 'SIMPLE_RADIAL' || model === 'SIMPLE_RADIAL_FISHEYE') { fx = fy = params[0]; cx = params[1]; cy = params[2]; }
      else { fx = params[0]; fy = params[1]; cx = params[2]; cy = params[3]; }
      intrinsics.set(id, {
        model, width, height, fx, fy, cx, cy, params,
        fovHorizontalDeg: 2 * Math.atan(width / (2 * fx)) * DEG,
        fovVerticalDeg: 2 * Math.atan(height / (2 * fy)) * DEG,
        focalLengthMm: (fx * 36) / width,
        sensorWidthMm: 36
      });
    }

    const poses: ColmapCameraPose[] = [];
    const lines = imagesText.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith('#')) continue;
      const p = line.split(/\s+/);
      if (p.length < 10) continue;
      const [imageId, qw, qx, qy, qz, tx, ty, tz, cameraId] = p.slice(0, 9).map(Number);
      const imageName = p[9];
      const R = SurveySynthesisEngine.rotationRowsFromQuat(qx, qy, qz, qw); // camera-from-world rows
      // C = -R^T t
      const C: V3 = [
        -(R[0][0] * tx + R[1][0] * ty + R[2][0] * tz),
        -(R[0][1] * tx + R[1][1] * ty + R[2][1] * tz),
        -(R[0][2] * tx + R[1][2] * ty + R[2][2] * tz)
      ];
      const fwd = norm(R[2] as V3);            // camera +z in world
      const up = norm([-R[1][0], -R[1][1], -R[1][2]]); // camera -y in world
      const intr = intrinsics.get(cameraId);
      const fov = intr ? intr.fovHorizontalDeg : 54.4;
      const { yawDegrees, pitchDegrees } = yawPitchFromForward(fwd);
      const wgs = ltp.toLatLng(C);
      const aspect = intr ? intr.width / intr.height : 16 / 9;
      poses.push({
        id: imageId,
        name: imageName.replace(/\.[^/.]+$/, '').toUpperCase(),
        imageName,
        positionLocalENU: C,
        forwardVector: fwd,
        upVector: up,
        rotationQuaternion: [qx, qy, qz, qw],
        yawDegrees: Number(yawDegrees.toFixed(4)),
        pitchDegrees: Number(pitchDegrees.toFixed(4)),
        rollDegrees: 0,
        focalLengthMm: Number((intr ? intr.focalLengthMm : 35).toFixed(3)),
        sensorWidthMm: 36,
        fovDegrees: Number(fov.toFixed(4)),
        aspectRatio: aspect,
        coordinatesWGS84: { lat: Number(wgs.lat.toFixed(8)), lng: Number(wgs.lng.toFixed(8)), elevation: Number((wgs.alt ?? safeAnchor.elevationMeters).toFixed(3)) },
        groundElevationASL: safeAnchor.elevationMeters,
        cameraHeightAboveGround: Number(((wgs.alt ?? 0) - safeAnchor.elevationMeters).toFixed(3)),
        frustumFootprintWGS84: SurveySynthesisEngine.frustumGroundFootprint(C, fwd, fov, aspect, ltp)
      });
      i++; // skip POINTS2D line
    }
    return poses;
  }

  /** RFC 7946 FeatureCollection: station points, frustum footprints, trajectory. */
  toGeoJson(poses: ColmapCameraPose[], anchor: GeodeticAnchor): ColmapGeoJsonFeatureCollection {
    const features: ColmapGeoJsonFeatureCollection['features'] = [];
    for (const pose of poses) {
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [pose.coordinatesWGS84.lng, pose.coordinatesWGS84.lat, pose.coordinatesWGS84.elevation] },
        properties: {
          id: pose.id, name: pose.name, imageName: pose.imageName,
          focalLengthMm: pose.focalLengthMm, fovDegrees: pose.fovDegrees,
          yawDegrees: pose.yawDegrees, pitchDegrees: pose.pitchDegrees, rollDegrees: pose.rollDegrees,
          cameraHeightAboveGround: pose.cameraHeightAboveGround, groundElevationASL: pose.groundElevationASL,
          positionLocalENU: pose.positionLocalENU, forwardVector: pose.forwardVector,
          beautify: pose.beautify,
          type: 'colmap_station'
        }
      });
    }
    for (const pose of poses) {
      if (pose.frustumFootprintWGS84 && pose.frustumFootprintWGS84.length >= 3) {
        const ring = [...pose.frustumFootprintWGS84];
        if (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1]) ring.push([...ring[0]] as [number, number]);
        features.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: { stationId: pose.id, stationName: pose.name, type: 'camera_frustum_footprint' } });
      }
    }
    if (poses.length >= 2) {
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: poses.map(p => [p.coordinatesWGS84.lng, p.coordinatesWGS84.lat, p.coordinatesWGS84.elevation]) },
        properties: { stationCount: poses.length, anchorAddress: anchor.formattedAddress, type: 'camera_trajectory_path' }
      });
    }
    return { type: 'FeatureCollection', features };
  }

  /**
   * Chooses stations for AI Beautify: filter by mesh coverage and sky, then greedy farthest-point
   * selection on viewing direction so the chosen set spans the subject. Deterministic.
   */
  rankForBeautify(poses: ColmapCameraPose[], opts: RankOptions): ColmapCameraPose[] {
    const minCov = opts.minMeshCoverage ?? 0.6;
    const maxSky = opts.maxSkyFraction ?? 0.6;
    const eligible = poses.filter(p => {
      const m = p.beautify;
      if (!m) return true;
      if (m.meshCoverageFraction !== undefined && m.meshCoverageFraction < minCov) return false;
      if (m.skyFraction !== undefined && m.skyFraction > maxSky) return false;
      return true;
    }).slice().sort((a, b) => a.id - b.id);
    if (eligible.length === 0) return [];

    const quality = (p: ColmapCameraPose) => {
      const m = p.beautify;
      const cov = m?.meshCoverageFraction ?? 0.75;
      const sky = m?.skyFraction ?? 0.25;
      return cov * (1 - sky);
    };
    // Seed with the best-quality station (lowest id on ties), then farthest-point on direction
    const chosen: ColmapCameraPose[] = [];
    let seed = eligible[0];
    for (const p of eligible) if (quality(p) > quality(seed) + 1e-9) seed = p;
    chosen.push(seed);
    const remaining = eligible.filter(p => p !== seed);
    while (chosen.length < opts.maxCount && remaining.length > 0) {
      let bestIdx = 0, bestScore = -Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const p = remaining[i];
        let minDist = Infinity;
        for (const c of chosen) {
          const d = 1 - dot(norm(p.forwardVector), norm(c.forwardVector)); // 0 = same direction
          const pos = Math.hypot(p.positionLocalENU[0] - c.positionLocalENU[0], p.positionLocalENU[1] - c.positionLocalENU[1], p.positionLocalENU[2] - c.positionLocalENU[2]);
          minDist = Math.min(minDist, d + pos / 1000);
        }
        const score = minDist * (0.5 + 0.5 * quality(p));
        if (score > bestScore + 1e-12) { bestScore = score; bestIdx = i; }
      }
      chosen.push(remaining.splice(bestIdx, 1)[0]);
    }
    return chosen.map((p, i) => ({ ...p, beautify: { ...(p.beautify || {}), rankScore: Number((1 - i / Math.max(1, chosen.length)).toFixed(4)) } }));
  }

  // ---- quaternion helpers (x, y, z, w) ----
  static quatFromRotationRows(R: V3[]): { x: number; y: number; z: number; w: number } {
    const m00 = R[0][0], m01 = R[0][1], m02 = R[0][2];
    const m10 = R[1][0], m11 = R[1][1], m12 = R[1][2];
    const m20 = R[2][0], m21 = R[2][1], m22 = R[2][2];
    const tr = m00 + m11 + m22;
    let x, y, z, w;
    if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; w = 0.25 * s; x = (m21 - m12) / s; y = (m02 - m20) / s; z = (m10 - m01) / s; }
    else if (m00 > m11 && m00 > m22) { const s = Math.sqrt(1 + m00 - m11 - m22) * 2; w = (m21 - m12) / s; x = 0.25 * s; y = (m01 + m10) / s; z = (m02 + m20) / s; }
    else if (m11 > m22) { const s = Math.sqrt(1 + m11 - m00 - m22) * 2; w = (m02 - m20) / s; x = (m01 + m10) / s; y = 0.25 * s; z = (m12 + m21) / s; }
    else { const s = Math.sqrt(1 + m22 - m00 - m11) * 2; w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = 0.25 * s; }
    return { x, y, z, w };
  }

  static rotationRowsFromQuat(qx: number, qy: number, qz: number, qw: number): V3[] {
    return [
      [1 - 2 * qy * qy - 2 * qz * qz, 2 * qx * qy - 2 * qz * qw, 2 * qx * qz + 2 * qy * qw],
      [2 * qx * qy + 2 * qz * qw, 1 - 2 * qx * qx - 2 * qz * qz, 2 * qy * qz - 2 * qx * qw],
      [2 * qx * qz - 2 * qy * qw, 2 * qy * qz + 2 * qx * qw, 1 - 2 * qx * qx - 2 * qy * qy]
    ];
  }
}
