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
export function stationFromLookAt(
  id: number,
  eye: V3,
  target: V3,
  optics: StationOptics,
  anchor: GeodeticAnchor,
  extras: Partial<ColmapCameraPose> = {}
): ColmapCameraPose {
  const ltp = new LocalTangentPlane({ lat: anchor.lat, lng: anchor.lng, alt: anchor.elevationMeters });
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
    coordinatesWGS84: { lat: Number(wgs.lat.toFixed(8)), lng: Number(wgs.lng.toFixed(8)), elevation: Number((wgs.alt ?? anchor.elevationMeters + eye[1]).toFixed(3)) },
    groundElevationASL: anchor.elevationMeters,
    cameraHeightAboveGround: Number(eye[1].toFixed(3)),
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
    const count = Math.max(3, config.cameraCount || 15);
    const radius = Math.max(10, config.targetRadiusMeters || 120);
    const optics: StationOptics = { focalLengthMm: config.focalLengthMm || 35, sensorWidthMm: config.sensorWidthMm || 36, aspectRatio: config.aspectRatio ?? 16 / 9 };
    const lookAt: V3 = config.lookAtOffsetLocalENU || [0, 20, 0];
    const poses: ColmapCameraPose[] = [];

    switch (config.type) {
      case 'orbital-multi-tier': {
        const tiers = config.altitudeTiersMeters && config.altitudeTiersMeters.length > 0
          ? config.altitudeTiersMeters
          : [anchor.elevationMeters + 25, anchor.elevationMeters + 75, anchor.elevationMeters + 140];
        const perTier = Math.ceil(count / tiers.length);
        let id = 1;
        for (let t = 0; t < tiers.length; t++) {
          const tierRadius = radius * (1 + t * 0.2);
          const offset = t * (Math.PI / perTier);
          for (let i = 0; i < perTier && poses.length < count; i++) {
            const theta = (2 * Math.PI * i) / perTier + offset;
            const eye: V3 = [tierRadius * Math.sin(theta), tiers[t] - anchor.elevationMeters, tierRadius * Math.cos(theta)];
            poses.push(stationFromLookAt(id, eye, lookAt, optics, anchor, {
              name: `ORBIT_TIER_${t + 1}_STATION_${String(id).padStart(2, '0')}`
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
        const minAlt = 10, maxAlt = 120, rows = 3;
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
      case 'street-corridor':
      case 'nadir-grid':
      default: {
        const heading = config.corridorHeadingDeg ?? anchor.headingDeg ?? 0;
        const h = heading * RAD;
        const lengthM = config.corridorLengthMeters || radius * 3;
        const step = lengthM / Math.max(1, count - 1);
        const isNadir = config.type === 'nadir-grid';
        const y = isNadir ? 180 : (config.cameraHeightMeters ?? 25);
        for (let i = 0; i < count; i++) {
          const d = -lengthM / 2 + i * step;
          // heading clockwise from north: north = -Z, east = +X
          const eye: V3 = [d * Math.sin(h), y, -d * Math.cos(h)];
          const target: V3 = isNadir ? [eye[0] + 0.001, 0, eye[2]] : [eye[0] + Math.sin(h), y, eye[2] - Math.cos(h)];
          poses.push(stationFromLookAt(i + 1, eye, target, optics, anchor, {
            name: `${config.type.toUpperCase()}_STATION_${String(i + 1).padStart(2, '0')}`, imageName: `corridor_${String(i + 1).padStart(3, '0')}.jpg`
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
    const ltp = new LocalTangentPlane({ lat: anchor.lat, lng: anchor.lng, alt: anchor.elevationMeters });
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
        coordinatesWGS84: { lat: Number(wgs.lat.toFixed(8)), lng: Number(wgs.lng.toFixed(8)), elevation: Number((wgs.alt ?? anchor.elevationMeters).toFixed(3)) },
        groundElevationASL: anchor.elevationMeters,
        cameraHeightAboveGround: Number(((wgs.alt ?? 0) - anchor.elevationMeters).toFixed(3)),
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
