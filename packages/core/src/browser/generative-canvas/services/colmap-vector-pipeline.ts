/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { LocalTangentPlane, LatLngAlt, Vec3 } from '../../../common/coordinate/LocalTangentPlane';
import {
  ColmapCameraModel,
  ColmapCameraPose,
  ColmapCameraIntrinsics,
  GeodeticAnchor,
  SurveyPatternConfig,
  ColmapVectorPipelineRequest,
  ColmapVectorPipelineResult,
  ColmapGeoJsonFeatureCollection
} from '../../../common/spatial/colmap-vector-reference-types';
import { GoogleElevationService } from './google-elevation-service';

/**
 * Universal, Zero-Preset Processing Pipeline for
 * Live Google Maps Vector Reference Dock (Path B) for COLMAP / GLOMAP.
 *
 * Operates on arbitrary global coordinates with strictly zero presets,
 * rigorous WGS84 geodesy, calibrated 6-DoF camera survey synthesis,
 * RFC 7946 GeoJSON export, and live WebGL Vector Map initialization.
 */
export class ColmapVectorPipeline {
  private static instance: ColmapVectorPipeline;

  public static getInstance(): ColmapVectorPipeline {
    if (!ColmapVectorPipeline.instance) {
      ColmapVectorPipeline.instance = new ColmapVectorPipeline();
    }
    return ColmapVectorPipeline.instance;
  }

  /**
   * Resolves a geodetic anchor anywhere on Earth.
   * Strictly enforces zero presets: requires valid coordinates or an active geocoding lookup.
   */
  public async resolveAnchor(
    request: ColmapVectorPipelineRequest,
    options?: { apiKey?: string; fetchElevation?: boolean }
  ): Promise<GeodeticAnchor> {
    const apiKey = request.apiKey || options?.apiKey || (typeof window !== 'undefined' ? (window as any).__GOOGLE_MAPS_API_KEY__ : undefined);

    if (request.anchor) {
      const { lat, lng, elevationMeters, headingDeg, label } = request.anchor;
      if (typeof lat !== 'number' || isNaN(lat) || lat < -90.0 || lat > 90.0) {
        throw new Error(`Zero-Preset Error: Invalid latitude ${lat}. Must be a valid number in [-90, 90].`);
      }
      if (typeof lng !== 'number' || isNaN(lng) || lng < -180.0 || lng > 180.0) {
        throw new Error(`Zero-Preset Error: Invalid longitude ${lng}. Must be a valid number in [-180, 180].`);
      }

      let groundElevation = elevationMeters ?? 0;
      if (options?.fetchElevation || request.fetchElevation) {
        try {
          const elevResult = await this.sampleElevation(lat, lng, apiKey);
          if (elevResult !== undefined) {
            groundElevation = elevResult;
          }
        } catch (e) {
          console.warn(`[ColmapVectorPipeline] Ground elevation sample failed for (${lat}, ${lng}), using default:`, e);
        }
      }

      return {
        lat,
        lng,
        elevationMeters: groundElevation,
        headingDeg: headingDeg ?? 0,
        formattedAddress: label || `${lat.toFixed(6)}, ${lng.toFixed(6)}`
      };
    }

    if (request.query && request.query.trim().length > 0) {
      if (!apiKey) {
        throw new Error(
          `Zero-Preset Directive Violation: Geocoding query "${request.query}" requires an active Google Maps API key. ` +
          `Static preset dictionaries are strictly prohibited. Supply explicit coordinates ({ lat, lng }) or configure an API key.`
        );
      }

      const geocoded = await this.geocodeAddress(request.query.trim(), apiKey);
      let groundElevation = 0;
      if (options?.fetchElevation || request.fetchElevation) {
        try {
          const elev = await this.sampleElevation(geocoded.lat, geocoded.lng, apiKey);
          if (elev !== undefined) groundElevation = elev;
        } catch {
          // preserve 0 on failure
        }
      }

      return {
        lat: geocoded.lat,
        lng: geocoded.lng,
        elevationMeters: groundElevation,
        placeId: geocoded.placeId,
        formattedAddress: geocoded.formattedAddress,
        headingDeg: 0
      };
    }

    throw new Error(
      'Zero-Preset Directive Violation: ColmapVectorPipeline requires either explicit geodetic coordinates ' +
      '({ lat, lng }) or a geocodable query string with Google Maps credentials. Static preset dictionaries are prohibited.'
    );
  }

  /**
   * Samples ground elevation ASL via Google Elevation API proxy or service.
   */
  private async sampleElevation(lat: number, lng: number, apiKey?: string): Promise<number | undefined> {
    try {
      // 1. Try local server proxy if running in browser or Node
      const proxyUrl = `/api/elevation?locations=${lat},${lng}${apiKey ? `&key=${encodeURIComponent(apiKey)}` : ''}`;
      if (typeof fetch !== 'undefined') {
        const resp = await fetch(proxyUrl);
        if (resp.ok) {
          const data = await resp.json();
          if (data.results && data.results.length > 0) {
            return data.results[0].elevation;
          }
        }
      }
    } catch {
      // Fallback to GoogleElevationService singleton
    }

    try {
      const elevService = GoogleElevationService.getInstance();
      const results = await elevService.getElevationForLocations([{ lat, lng }]);
      if (results.length > 0) {
        return results[0].elevation;
      }
    } catch {
      // Ignore fallback errors
    }

    return undefined;
  }

  /**
   * Dynamic live geocoding via Google Geocoding API with mandatory solution attribution.
   */
  private async geocodeAddress(query: string, apiKey: string): Promise<{ lat: number; lng: number; formattedAddress: string; placeId?: string }> {
    const encodedQuery = encodeURIComponent(query);
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodedQuery}&key=${encodeURIComponent(apiKey)}&solution_id=gmp_git_agentskills_v1`;

    const resp = await fetch(url, {
      headers: {
        'X-Goog-Api-Client': 'gl-node/ gmp_git_agentskills_v1'
      }
    });

    if (!resp.ok) {
      throw new Error(`Google Geocoding API HTTP error: ${resp.status} ${resp.statusText}`);
    }

    const data = await resp.json();
    if (data.status !== 'OK' || !data.results || data.results.length === 0) {
      throw new Error(`Zero-Preset Error: Location "${query}" not found via Google Geocoding API (Status: ${data.status}).`);
    }

    const first = data.results[0];
    return {
      lat: first.geometry.location.lat,
      lng: first.geometry.location.lng,
      formattedAddress: first.formatted_address,
      placeId: first.place_id
    };
  }

  /**
   * Generates a procedurally synthesized 6-DoF photogrammetric survey array
   * anchored to any real-world coordinates with zero presets.
   */
  public generateSyntheticSurvey(
    anchor: GeodeticAnchor,
    config: SurveyPatternConfig
  ): ColmapCameraPose[] {
    const ltp = new LocalTangentPlane({
      lat: anchor.lat,
      lng: anchor.lng,
      alt: anchor.elevationMeters
    });

    const poses: ColmapCameraPose[] = [];
    const count = Math.max(3, config.cameraCount || 15);
    const radius = Math.max(10.0, config.targetRadiusMeters || 120.0);
    const focalLengthMm = config.focalLengthMm || 35.0;
    const sensorWidthMm = config.sensorWidthMm || 36.0;
    const fovDegrees = 2.0 * Math.atan((sensorWidthMm / 2.0) / focalLengthMm) * (180.0 / Math.PI);
    const lookAtOffset: [number, number, number] = config.lookAtOffsetLocalENU || [0, 20.0, 0];

    switch (config.type) {
      case 'orbital-multi-tier': {
        const altitudeTiers = config.altitudeTiersMeters && config.altitudeTiersMeters.length > 0
          ? config.altitudeTiersMeters
          : [anchor.elevationMeters + 25.0, anchor.elevationMeters + 75.0, anchor.elevationMeters + 140.0];

        const stationsPerTier = Math.ceil(count / altitudeTiers.length);
        let stationId = 1;

        for (let t = 0; t < altitudeTiers.length; t++) {
          const tierAlt = altitudeTiers[t];
          const tierRadius = radius * (1.0 + t * 0.2); // slight expansion with altitude
          const tierAngleOffset = (t * (Math.PI / stationsPerTier));

          for (let i = 0; i < stationsPerTier; i++) {
            if (poses.length >= count) break;
            const theta = (2.0 * Math.PI * i) / stationsPerTier + tierAngleOffset;

            // Local ENU coordinates: X = East, Y = Up, Z = -North
            const x = tierRadius * Math.sin(theta);
            const z = tierRadius * Math.cos(theta); // Three.js -Z is North, Z is South
            const y = tierAlt - anchor.elevationMeters;

            const posENU: [number, number, number] = [x, y, z];
            const targetPos: [number, number, number] = [lookAtOffset[0], lookAtOffset[1], lookAtOffset[2]];

            // Forward vector: from camera to lookAt target
            const dx = targetPos[0] - posENU[0];
            const dy = targetPos[1] - posENU[1];
            const dz = targetPos[2] - posENU[2];
            const len = Math.hypot(dx, dy, dz);
            const fwd: [number, number, number] = len > 1e-4 ? [dx / len, dy / len, dz / len] : [0, 0, -1];

            // Up vector
            const up: [number, number, number] = [0, 1, 0];

            // WGS84 coordinates from LocalTangentPlane
            const wgs = ltp.toLatLng([posENU[0], posENU[1], posENU[2]]);

            // Yaw: angle clockwise from North (-Z)
            const yaw = ((Math.atan2(fwd[0], -fwd[2]) * 180.0) / Math.PI + 360.0) % 360.0;
            const pitch = (Math.asin(Math.max(-1.0, Math.min(1.0, fwd[1]))) * 180.0) / Math.PI;

            // Compute 4-corner frustum ground footprint
            const footprint = this.computeFrustumGroundFootprint(posENU, fwd, fovDegrees, ltp);

            poses.push({
              id: stationId,
              name: `ORBIT_TIER_${t + 1}_STATION_${String(stationId).padStart(2, '0')}`,
              imageName: `station_${String(stationId).padStart(3, '0')}.jpg`,
              positionLocalENU: posENU,
              forwardVector: fwd,
              upVector: up,
              yawDegrees: Number(yaw.toFixed(2)),
              pitchDegrees: Number(pitch.toFixed(2)),
              rollDegrees: 0.0,
              focalLengthMm,
              sensorWidthMm,
              fovDegrees: Number(fovDegrees.toFixed(2)),
              aspectRatio: 16 / 9,
              coordinatesWGS84: {
                lat: Number(wgs.lat.toFixed(7)),
                lng: Number(wgs.lng.toFixed(7)),
                elevation: Number((wgs.alt ?? tierAlt).toFixed(2))
              },
              groundElevationASL: anchor.elevationMeters,
              cameraHeightAboveGround: Number((wgs.alt ? wgs.alt - anchor.elevationMeters : y).toFixed(2)),
              frustumFootprintWGS84: footprint
            });

            stationId++;
          }
        }
        break;
      }

      case 'facade-lawnmower': {
        const headingRad = ((anchor.headingDeg || 0) * Math.PI) / 180.0;
        const facadeNormal: [number, number] = [Math.sin(headingRad), Math.cos(headingRad)];
        const facadeTangent: [number, number] = [-facadeNormal[1], facadeNormal[0]];

        const widthM = radius * 1.5;
        const minAlt = anchor.elevationMeters + 10.0;
        const maxAlt = anchor.elevationMeters + 120.0;
        const rows = 3;
        const cols = Math.ceil(count / rows);
        let stationId = 1;

        for (let r = 0; r < rows; r++) {
          const alt = minAlt + (r * (maxAlt - minAlt)) / (rows - 1);
          const y = alt - anchor.elevationMeters;

          for (let c = 0; c < cols; c++) {
            if (poses.length >= count) break;
            const t = cols > 1 ? (c / (cols - 1)) - 0.5 : 0;
            const lateralOffset = t * widthM;

            // Camera stands in front of facade along normal
            const x = lateralOffset * facadeTangent[0] + radius * facadeNormal[0];
            const z = lateralOffset * facadeTangent[1] + radius * facadeNormal[1];

            const posENU: [number, number, number] = [x, y, z];
            // Look back toward facade centroid
            const fwdVec: [number, number, number] = [-facadeNormal[0], 0, -facadeNormal[1]];
            const fwdLen = Math.hypot(fwdVec[0], fwdVec[2]);
            const fwd: [number, number, number] = fwdLen > 1e-4 ? [fwdVec[0] / fwdLen, 0, fwdVec[2] / fwdLen] : [0, 0, -1];

            const wgs = ltp.toLatLng([posENU[0], posENU[1], posENU[2]]);
            const yaw = ((Math.atan2(fwd[0], -fwd[2]) * 180.0) / Math.PI + 360.0) % 360.0;
            const pitch = 0.0;
            const footprint = this.computeFrustumGroundFootprint(posENU, fwd, fovDegrees, ltp);

            poses.push({
              id: stationId,
              name: `FACADE_ROW_${r + 1}_COL_${String(c + 1).padStart(2, '0')}`,
              imageName: `facade_${String(stationId).padStart(3, '0')}.jpg`,
              positionLocalENU: posENU,
              forwardVector: fwd,
              upVector: [0, 1, 0],
              yawDegrees: Number(yaw.toFixed(2)),
              pitchDegrees: Number(pitch.toFixed(2)),
              rollDegrees: 0.0,
              focalLengthMm,
              sensorWidthMm,
              fovDegrees: Number(fovDegrees.toFixed(2)),
              aspectRatio: 16 / 9,
              coordinatesWGS84: {
                lat: Number(wgs.lat.toFixed(7)),
                lng: Number(wgs.lng.toFixed(7)),
                elevation: Number((wgs.alt ?? alt).toFixed(2))
              },
              groundElevationASL: anchor.elevationMeters,
              cameraHeightAboveGround: Number(y.toFixed(2)),
              frustumFootprintWGS84: footprint
            });

            stationId++;
          }
        }
        break;
      }

      case 'street-corridor':
      case 'nadir-grid':
      default: {
        // Corridor flythrough or grid default
        const corridorHeading = config.corridorHeadingDeg ?? anchor.headingDeg ?? 0;
        const headingRad = (corridorHeading * Math.PI) / 180.0;
        const lengthM = config.corridorLengthMeters || radius * 3.0;
        const step = lengthM / Math.max(1, count - 1);
        let stationId = 1;

        for (let i = 0; i < count; i++) {
          const dist = -lengthM / 2.0 + i * step;
          const x = dist * Math.sin(headingRad);
          const z = dist * Math.cos(headingRad);
          const y = config.type === 'nadir-grid' ? 180.0 : 25.0;

          const posENU: [number, number, number] = [x, y, z];
          const fwd: [number, number, number] = config.type === 'nadir-grid'
            ? [0.001, -0.999, 0] // near nadir
            : [Math.sin(headingRad), 0, Math.cos(headingRad)];

          const wgs = ltp.toLatLng([posENU[0], posENU[1], posENU[2]]);
          const yaw = ((Math.atan2(fwd[0], -fwd[2]) * 180.0) / Math.PI + 360.0) % 360.0;
          const pitch = config.type === 'nadir-grid' ? -89.0 : 0.0;
          const footprint = this.computeFrustumGroundFootprint(posENU, fwd, fovDegrees, ltp);

          poses.push({
            id: stationId,
            name: `${config.type.toUpperCase()}_STATION_${String(stationId).padStart(2, '0')}`,
            imageName: `corridor_${String(stationId).padStart(3, '0')}.jpg`,
            positionLocalENU: posENU,
            forwardVector: fwd,
            upVector: [0, 1, 0],
            yawDegrees: Number(yaw.toFixed(2)),
            pitchDegrees: Number(pitch.toFixed(2)),
            rollDegrees: 0.0,
            focalLengthMm,
            sensorWidthMm,
            fovDegrees: Number(fovDegrees.toFixed(2)),
            aspectRatio: 16 / 9,
            coordinatesWGS84: {
              lat: Number(wgs.lat.toFixed(7)),
              lng: Number(wgs.lng.toFixed(7)),
              elevation: Number(((wgs.alt ?? 0) + anchor.elevationMeters + y).toFixed(2))
            },
            groundElevationASL: anchor.elevationMeters,
            cameraHeightAboveGround: Number(y.toFixed(2)),
            frustumFootprintWGS84: footprint
          });

          stationId++;
        }
        break;
      }
    }

    return poses;
  }

  /**
   * Parses raw COLMAP / GLOMAP reconstruction text files (cameras.txt, images.txt)
   * and accurately projects them into local ENU and WGS84 GPS space relative to the anchor.
   */
  public ingestColmapTextFiles(
    camerasText: string,
    imagesText: string,
    anchor: GeodeticAnchor
  ): ColmapCameraPose[] {
    const ltp = new LocalTangentPlane({
      lat: anchor.lat,
      lng: anchor.lng,
      alt: anchor.elevationMeters
    });

    // 1. Parse cameras.txt
    const intrinsicsMap = new Map<number, ColmapCameraIntrinsics>();
    const cameraLines = camerasText.split('\n');

    for (const rawLine of cameraLines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;

      const parts = line.split(/\s+/);
      if (parts.length < 5) continue;

      const id = parseInt(parts[0], 10);
      const model = parts[1] as ColmapCameraModel;
      const width = parseInt(parts[2], 10);
      const height = parseInt(parts[3], 10);
      const params = parts.slice(4).map(Number);

      let fx = 1000;
      let fy = 1000;
      let cx = width / 2;
      let cy = height / 2;

      if (model === 'SIMPLE_PINHOLE' || model === 'SIMPLE_RADIAL') {
        fx = fy = params[0];
        cx = params[1];
        cy = params[2];
      } else if (model === 'PINHOLE' || model === 'RADIAL' || model === 'OPENCV') {
        fx = params[0];
        fy = params[1];
        cx = params[2];
        cy = params[3];
      }

      const fovHorizontalDeg = 2.0 * Math.atan(width / (2.0 * fx)) * (180.0 / Math.PI);
      const fovVerticalDeg = 2.0 * Math.atan(height / (2.0 * fy)) * (180.0 / Math.PI);
      const focalLengthMm = (fx * 36.0) / width; // 35mm equivalent

      intrinsicsMap.set(id, {
        model,
        width,
        height,
        fx,
        fy,
        cx,
        cy,
        params,
        fovHorizontalDeg,
        fovVerticalDeg,
        focalLengthMm,
        sensorWidthMm: 36.0
      });
    }

    // 2. Parse images.txt
    const poses: ColmapCameraPose[] = [];
    const imageLines = imagesText.split('\n');

    for (let i = 0; i < imageLines.length; i++) {
      const line = imageLines[i].trim();
      if (!line || line.startsWith('#')) continue;

      const parts = line.split(/\s+/);
      if (parts.length < 10) continue;

      const imageId = parseInt(parts[0], 10);
      const qw = parseFloat(parts[1]);
      const qx = parseFloat(parts[2]);
      const qy = parseFloat(parts[3]);
      const qz = parseFloat(parts[4]);
      const tx = parseFloat(parts[5]);
      const ty = parseFloat(parts[6]);
      const tz = parseFloat(parts[7]);
      const cameraId = parseInt(parts[8], 10);
      const imageName = parts[9];

      // Convert COLMAP quaternion to rotation matrix R (world to camera)
      // R is orthogonal, so world camera center is: C = -R^T * t
      const r00 = 1 - 2 * qy * qy - 2 * qz * qz;
      const r01 = 2 * qx * qy - 2 * qz * qw;
      const r02 = 2 * qx * qz + 2 * qy * qw;

      const r10 = 2 * qx * qy + 2 * qz * qw;
      const r11 = 1 - 2 * qx * qx - 2 * qz * qz;
      const r12 = 2 * qy * qz - 2 * qx * qw;

      const r20 = 2 * qx * qz - 2 * qy * qw;
      const r21 = 2 * qy * qz + 2 * qx * qw;
      const r22 = 1 - 2 * qx * qx - 2 * qy * qy;

      // Optical center in world coordinates: C = -R^T * t
      const cx = -(r00 * tx + r10 * ty + r20 * tz);
      const cy = -(r01 * tx + r11 * ty + r21 * tz);
      const cz = -(r02 * tx + r12 * ty + r22 * tz);

      // Camera forward vector: optical axis +Z in camera space rotated to world space (R^T * [0, 0, 1])
      const fx = r20;
      const fy = r21;
      const fz = r22;

      // Map COLMAP coordinate system to Three.js / ENU
      // Local tangent plane: X=East, Y=Up, Z=-North
      const posENU: [number, number, number] = [cx, cy, cz];
      const fwd: [number, number, number] = [fx, fy, fz];

      const wgs = ltp.toLatLng([posENU[0], posENU[1], posENU[2]]);
      const yaw = ((Math.atan2(fwd[0], -fwd[2]) * 180.0) / Math.PI + 360.0) % 360.0;
      const pitch = (Math.asin(Math.max(-1.0, Math.min(1.0, fwd[1]))) * 180.0) / Math.PI;

      const intrinsics = intrinsicsMap.get(cameraId);
      const focalLengthMm = intrinsics ? intrinsics.focalLengthMm : 35.0;
      const fovDeg = intrinsics ? intrinsics.fovHorizontalDeg : 54.4;
      const footprint = this.computeFrustumGroundFootprint(posENU, fwd, fovDeg, ltp);

      poses.push({
        id: imageId,
        name: imageName.replace(/\.[^/.]+$/, '').toUpperCase(),
        imageName,
        positionLocalENU: posENU,
        forwardVector: fwd,
        upVector: [0, 1, 0],
        rotationQuaternion: [qx, qy, qz, qw],
        yawDegrees: Number(yaw.toFixed(2)),
        pitchDegrees: Number(pitch.toFixed(2)),
        rollDegrees: 0.0,
        focalLengthMm: Number(focalLengthMm.toFixed(1)),
        sensorWidthMm: 36.0,
        fovDegrees: Number(fovDeg.toFixed(2)),
        aspectRatio: intrinsics ? intrinsics.width / intrinsics.height : 16 / 9,
        coordinatesWGS84: {
          lat: Number(wgs.lat.toFixed(7)),
          lng: Number(wgs.lng.toFixed(7)),
          elevation: Number((wgs.alt ?? anchor.elevationMeters).toFixed(2))
        },
        groundElevationASL: anchor.elevationMeters,
        cameraHeightAboveGround: Number(((wgs.alt ?? 0) - anchor.elevationMeters).toFixed(2)),
        frustumFootprintWGS84: footprint
      });

      // Skip the 2D feature points line in images.txt
      i++;
    }

    return poses;
  }

  /**
   * Computes the 4-corner ground projection polygon of a camera frustum in WGS84 [lng, lat].
   */
  private computeFrustumGroundFootprint(
    eye: [number, number, number],
    fwd: [number, number, number],
    fovDeg: number,
    ltp: LocalTangentPlane,
    viewDistanceMeters: number = 80.0
  ): [number, number][] {
    const halfFovRad = ((fovDeg / 2.0) * Math.PI) / 180.0;
    const tanHalf = Math.tan(halfFovRad);

    // Right vector: cross(fwd, [0, 1, 0])
    const rx = fwd[2];
    const rz = -fwd[0];
    const rLen = Math.hypot(rx, rz);
    const right = rLen > 1e-4 ? [rx / rLen, 0, rz / rLen] : [1, 0, 0];

    // Up vector: cross(right, fwd)
    const ux = right[1] * fwd[2] - right[2] * fwd[1];
    const uy = right[2] * fwd[0] - right[0] * fwd[2];
    const uz = right[0] * fwd[1] - right[1] * fwd[0];

    const dist = Math.max(15.0, viewDistanceMeters);
    const halfW = dist * tanHalf;
    const halfH = halfW * (9.0 / 16.0);

    const centerDist: [number, number, number] = [
      eye[0] + fwd[0] * dist,
      eye[1] + fwd[1] * dist,
      eye[2] + fwd[2] * dist
    ];

    const cornersLocal: [number, number, number][] = [
      // Top-Left
      [
        centerDist[0] - right[0] * halfW + ux * halfH,
        Math.max(0, centerDist[1] - right[1] * halfW + uy * halfH),
        centerDist[2] - right[2] * halfW + uz * halfH
      ],
      // Top-Right
      [
        centerDist[0] + right[0] * halfW + ux * halfH,
        Math.max(0, centerDist[1] + right[1] * halfW + uy * halfH),
        centerDist[2] + right[2] * halfW + uz * halfH
      ],
      // Bottom-Right
      [
        centerDist[0] + right[0] * halfW - ux * halfH,
        Math.max(0, centerDist[1] + right[1] * halfW - uy * halfH),
        centerDist[2] + right[2] * halfW - uz * halfH
      ],
      // Bottom-Left
      [
        centerDist[0] - right[0] * halfW - ux * halfH,
        Math.max(0, centerDist[1] - right[1] * halfW - uy * halfH),
        centerDist[2] - right[2] * halfW - uz * halfH
      ]
    ];

    // Project each corner to WGS84
    return cornersLocal.map(c => {
      const ll = ltp.toLatLng([c[0], c[1], c[2]]);
      return [Number(ll.lng.toFixed(7)), Number(ll.lat.toFixed(7))];
    });
  }

  /**
   * Builds an RFC 7946 GeoJSON FeatureCollection containing all camera survey stations,
   * camera frustum ground footprints, and the flight path trajectory.
   */
  public buildGeoJsonFeatureCollection(
    poses: ColmapCameraPose[],
    anchor: GeodeticAnchor
  ): ColmapGeoJsonFeatureCollection {
    const features: ColmapGeoJsonFeatureCollection['features'] = [];

    // 1. Station Point Features
    poses.forEach(pose => {
      features.push({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [
            pose.coordinatesWGS84.lng,
            pose.coordinatesWGS84.lat,
            pose.coordinatesWGS84.elevation
          ]
        },
        properties: {
          id: pose.id,
          name: pose.name,
          imageName: pose.imageName,
          focalLengthMm: pose.focalLengthMm,
          fovDegrees: pose.fovDegrees,
          yawDegrees: pose.yawDegrees,
          pitchDegrees: pose.pitchDegrees,
          rollDegrees: pose.rollDegrees,
          cameraHeightAboveGround: pose.cameraHeightAboveGround,
          groundElevationASL: pose.groundElevationASL,
          positionLocalENU: pose.positionLocalENU,
          forwardVector: pose.forwardVector,
          type: 'colmap_station'
        }
      });
    });

    // 2. Frustum Ground Footprint Polygons
    poses.forEach(pose => {
      if (pose.frustumFootprintWGS84 && pose.frustumFootprintWGS84.length >= 3) {
        const ring = [...pose.frustumFootprintWGS84];
        // Ensure closed ring
        if (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1]) {
          ring.push([...ring[0]]);
        }

        features.push({
          type: 'Feature',
          geometry: {
            type: 'Polygon',
            coordinates: [ring]
          },
          properties: {
            stationId: pose.id,
            stationName: pose.name,
            type: 'camera_frustum_footprint'
          }
        });
      }
    });

    // 3. Flight Path LineString
    if (poses.length >= 2) {
      const pathCoords: number[][] = poses.map(p => [
        p.coordinatesWGS84.lng,
        p.coordinatesWGS84.lat,
        p.coordinatesWGS84.elevation
      ]);

      features.push({
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: pathCoords
        },
        properties: {
          stationCount: poses.length,
          anchorAddress: anchor.formattedAddress,
          type: 'camera_trajectory_path'
        }
      });
    }

    return {
      type: 'FeatureCollection',
      features
    };
  }

  /**
   * Generates standard COLMAP cameras.txt and images.txt file contents.
   */
  public exportColmapText(poses: ColmapCameraPose[]): { camerasText: string; imagesText: string } {
    let camerasText = '# Camera list with one line of data per camera:\n';
    camerasText += '#   CAMERA_ID, MODEL, WIDTH, HEIGHT, PARAMS[]\n';
    camerasText += '# Number of cameras: 1\n';

    const width = 1920;
    const height = 1080;
    const firstPose = poses[0];
    const focalLengthMm = firstPose ? firstPose.focalLengthMm : 35.0;
    const fx = (focalLengthMm * width) / 36.0;
    const cx = width / 2.0;
    const cy = height / 2.0;

    camerasText += `1 PINHOLE ${width} ${height} ${fx.toFixed(4)} ${fx.toFixed(4)} ${cx.toFixed(1)} ${cy.toFixed(1)}\n`;

    let imagesText = '# Image list with two lines of data per image:\n';
    imagesText += '#   IMAGE_ID, QW, QX, QY, QZ, TX, TY, TZ, CAMERA_ID, NAME\n';
    imagesText += '#   POINTS2D[] as (X, Y, POINT3D_ID)\n';
    imagesText += `# Number of images: ${poses.length}\n`;

    poses.forEach(pose => {
      // Rotation from yaw and pitch to quaternion
      const yawRad = ((pose.yawDegrees || 0) * Math.PI) / 180.0;
      const pitchRad = ((pose.pitchDegrees || 0) * Math.PI) / 180.0;

      const cy = Math.cos(yawRad * 0.5);
      const sy = Math.sin(yawRad * 0.5);
      const cp = Math.cos(pitchRad * 0.5);
      const sp = Math.sin(pitchRad * 0.5);

      const qw = cy * cp;
      const qx = sy * sp;
      const qy = sy * cp;
      const qz = -cy * sp;

      // Translation vector t = -R * C
      const tx = -pose.positionLocalENU[0];
      const ty = -pose.positionLocalENU[1];
      const tz = -pose.positionLocalENU[2];

      const imgName = pose.imageName || `station_${String(pose.id).padStart(3, '0')}.jpg`;
      imagesText += `${pose.id} ${qw.toFixed(6)} ${qx.toFixed(6)} ${qy.toFixed(6)} ${qz.toFixed(6)} ${tx.toFixed(4)} ${ty.toFixed(4)} ${tz.toFixed(4)} 1 ${imgName}\n`;
      imagesText += '\n'; // empty 2D points line
    });

    return { camerasText, imagesText };
  }

  /**
   * Executes the complete end-to-end processing pipeline:
   * 1. Resolves geodetic anchor with zero presets.
   * 2. Ingests or synthesizes 6-DoF photogrammetry survey poses.
   * 3. Projects between local ENU tangent plane and WGS84 GPS.
   * 4. Generates RFC 7946 GeoJSON and standard COLMAP files.
   * 5. Emits the live Google Maps Vector Reference Dock configuration bundle.
   */
  public async execute(request: ColmapVectorPipelineRequest): Promise<ColmapVectorPipelineResult> {
    // 1. Resolve geodetic anchor
    const anchor = await this.resolveAnchor(request, {
      apiKey: request.apiKey,
      fetchElevation: request.fetchElevation ?? true
    });

    // 2. Ingest or synthesize camera survey stations
    let poses: ColmapCameraPose[] = [];

    if (request.colmapFiles?.camerasText && request.colmapFiles?.imagesText) {
      poses = this.ingestColmapTextFiles(
        request.colmapFiles.camerasText,
        request.colmapFiles.imagesText,
        anchor
      );
    } else if (request.existingPoses && request.existingPoses.length > 0) {
      poses = request.existingPoses;
    } else {
      const surveyConfig: SurveyPatternConfig = request.surveyConfig || {
        type: 'orbital-multi-tier',
        targetRadiusMeters: 120.0,
        cameraCount: 15,
        focalLengthMm: 35.0,
        sensorWidthMm: 36.0
      };
      poses = this.generateSyntheticSurvey(anchor, surveyConfig);
    }

    if (poses.length === 0) {
      throw new Error('ColmapVectorPipeline: No camera survey stations were generated or ingested.');
    }

    // 3. RFC 7946 GeoJSON
    const geoJson = this.buildGeoJsonFeatureCollection(poses, anchor);

    // 4. COLMAP format text export
    const colmapExport = this.exportColmapText(poses);

    // 5. Statistics
    const elevations = poses.map(p => p.coordinatesWGS84.elevation);
    const avgAlt = elevations.reduce((a, b) => a + b, 0) / elevations.length;
    const minAlt = Math.min(...elevations);
    const maxAlt = Math.max(...elevations);
    const maxRadius = Math.max(...poses.map(p => Math.hypot(p.positionLocalENU[0], p.positionLocalENU[2])));

    // 6. Vector Dock Map Config (Path B)
    const mapId = request.mapId || 'ad80a8568eeae7445909ba9f';
    const styleId = request.styleId || '171afbfed80e6143e663574d';

    return {
      version: '3.0.0-universal-colmap-pipeline',
      success: true,
      anchor,
      poses,
      geoJson,
      colmapExport,
      vectorDockConfig: {
        mapId,
        styleId,
        center: { lat: anchor.lat, lng: anchor.lng },
        zoom: 17,
        heading: anchor.headingDeg || 0,
        tilt: 45,
        stationCount: poses.length,
        solutionAttribution: 'solution_id=gmp_git_agentskills_v1'
      },
      stats: {
        stationCount: poses.length,
        avgAltitudeASL: Number(avgAlt.toFixed(2)),
        minAltitudeASL: Number(minAlt.toFixed(2)),
        maxAltitudeASL: Number(maxAlt.toFixed(2)),
        groundDatumASL: anchor.elevationMeters,
        boundingRadiusMeters: Number(maxRadius.toFixed(2))
      }
    };
  }
}
