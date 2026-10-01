/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as THREE from 'three';
import { LocalTangentPlane, LatLngAlt, Vec3 } from '../../../../common/coordinate/LocalTangentPlane';
import { GeoFrame } from '../../../../common/coordinate/GeoFrame';
import {
  GeoAnchorDeploymentContract,
  ARPlacementEntity,
  AltitudeResolutionMode,
  GeoAnchor4D
} from '../../../../common/geospatial-4d-protocol';
import type {
  GoogleRoadCorridor,
  GoogleParcelEnvelope
} from '../google-vector-mapping-service';

export type CalibrationSource = 'sensor' | 'manual-pin' | 'anchor-origin' | 'manual-adjustment';

export interface GeospatialAlignmentState {
  isAligned: boolean;
  calibrationSource: CalibrationSource;
  accuracyMeters: number;
  headingOffsetDeg: number;
  elevationOffsetMeters: number;
  originGeoAnchor: {
    lat: number;
    lng: number;
    alt: number;
    geoidHeight?: number;
  };
  translationOffset: [number, number, number];
  alignmentMatrix: THREE.Matrix4;
  lastCalibratedTimestampMs: number;
}

export interface DeviceSensorSample {
  lat: number;
  lng: number;
  alt?: number;
  accuracyMeters?: number;
  headingDeg?: number; // 0 to 360 clockwise from True North
}

export interface WebXRViewerPose {
  position: [number, number, number]; // [x, y, z] in WebXR local-floor
  quaternion?: [number, number, number, number]; // [x, y, z, w]
}

export interface WebXRGeospatialBridgeOptions {
  contract?: GeoAnchorDeploymentContract;
  origin?: GeoAnchor4D;
  geoidHeight?: number;
  initialHeadingOffsetDeg?: number;
}

export interface ProjectedPlacement {
  placement: ARPlacementEntity;
  webXRPosition: THREE.Vector3;
  webXRQuaternion: THREE.Quaternion;
  webXRScale: THREE.Vector3;
  distanceFromViewerMeters: number;
}

/**
 * High-precision coordinate transformation and spatial tracking engine that bridges
 * WGS-84 geodetic coordinates, True North compass headings, and GeoAnchorDeploymentContract
 * with WebXR's local metric coordinate space ('local-floor', 1 unit = 1 meter).
 */
export class WebXRGeospatialAnchorBridge {
  private ltp: LocalTangentPlane;
  private geoFrame: GeoFrame;
  private originAnchor: GeoAnchor4D;
  private contract: GeoAnchorDeploymentContract | null = null;

  // Rigid 3D affine transform mapping ENU Tangent Plane (metric) -> WebXR metric space
  // P_xr = R_y(yawOffset) * P_enu + translationOffset
  private yawOffsetRad: number = 0; // rotation around +Y (Up) in radians
  private translationOffset: THREE.Vector3 = new THREE.Vector3(0, 0, 0);
  private alignmentMatrix: THREE.Matrix4 = new THREE.Matrix4();
  private invAlignmentMatrix: THREE.Matrix4 = new THREE.Matrix4();

  private isAligned: boolean = false;
  private calibrationSource: CalibrationSource = 'anchor-origin';
  private accuracyMeters: number = 0;
  private lastCalibratedTimestampMs: number = 0;

  constructor(options: WebXRGeospatialBridgeOptions = {}) {
    if (options.contract) {
      this.contract = options.contract;
      this.originAnchor = {
        lat: options.contract.spatialCluster.originGeodetic.latitude,
        lng: options.contract.spatialCluster.originGeodetic.longitude,
        alt: options.contract.spatialCluster.originGeodetic.altitudeMsl ?? 0,
        geoidHeight: 0
      };
    } else if (options.origin) {
      this.originAnchor = {
        lat: options.origin.lat,
        lng: options.origin.lng,
        alt: options.origin.alt ?? 0,
        geoidHeight: options.origin.geoidHeight ?? options.geoidHeight ?? 0
      };
    } else {
      // Default to ESB coordinates as fallback origin
      this.originAnchor = {
        lat: 40.7484405,
        lng: -73.9856644,
        alt: 18.53,
        geoidHeight: 0
      };
    }

    this.ltp = new LocalTangentPlane(
      {
        lat: this.originAnchor.lat,
        lng: this.originAnchor.lng,
        alt: this.originAnchor.alt
      },
      this.originAnchor.geoidHeight ?? 0
    );

    // Standard metric scale for WebXR: 1 scene unit = 1 meter
    this.geoFrame = new GeoFrame(this.originAnchor, 1.0);

    if (options.initialHeadingOffsetDeg !== undefined) {
      this.yawOffsetRad = (options.initialHeadingOffsetDeg * Math.PI) / 180;
    }

    this.updateMatrices();
  }

  // ============================================================================
  // Calibration & Alignment Modes
  // ============================================================================

  /**
   * Aligns the bridge assuming WebXR origin (0, 0, 0) corresponds directly
   * to the anchor origin (lat0, lng0, alt0) with an optional compass heading offset.
   */
  public calibrateAnchorOrigin(headingOffsetDeg: number = 0): GeospatialAlignmentState {
    this.yawOffsetRad = (headingOffsetDeg * Math.PI) / 180;
    this.translationOffset.set(0, 0, 0);
    this.isAligned = true;
    this.calibrationSource = 'anchor-origin';
    this.accuracyMeters = 0.05; // 5cm nominal anchor accuracy
    this.lastCalibratedTimestampMs = Date.now();
    this.updateMatrices();
    return this.getAlignmentState();
  }

  /**
   * Autonomously calibrates the bridge by correlating a physical device GPS reading
   * and compass heading with the device's current WebXR viewer pose.
   */
  public calibrateSensors(
    sensor: DeviceSensorSample,
    viewerPose: WebXRViewerPose
  ): GeospatialAlignmentState {
    // 1. Convert device geodetic position to metric ENU relative to anchor origin
    const devEnuVec = this.ltp.toLocal({
      lat: sensor.lat,
      lng: sensor.lng,
      alt: sensor.alt ?? this.originAnchor.alt ?? 0
    });
    const pDevEnu = new THREE.Vector3(devEnuVec[0], devEnuVec[1], devEnuVec[2]);

    // 2. Viewer position in WebXR
    const pDevXr = new THREE.Vector3(
      viewerPose.position[0],
      viewerPose.position[1],
      viewerPose.position[2]
    );

    // 3. Compute Yaw Offset
    if (sensor.headingDeg !== undefined && viewerPose.quaternion) {
      // In Three.js ENU: North is -Z, East is +X, South is +Z, West is -X.
      // Heading clockwise from North in radians:
      const compassRad = (sensor.headingDeg * Math.PI) / 180;
      // In ENU, heading corresponds to yaw rotation around Y: yaw_enu = -compassRad
      const yawEnu = -compassRad;

      // Extract yaw angle in WebXR from viewer quaternion
      const qXr = new THREE.Quaternion(
        viewerPose.quaternion[0],
        viewerPose.quaternion[1],
        viewerPose.quaternion[2],
        viewerPose.quaternion[3]
      );
      const forwardXr = new THREE.Vector3(0, 0, -1).applyQuaternion(qXr);
      // Yaw angle in WebXR horizontal plane:
      const yawXr = Math.atan2(-forwardXr.x, -forwardXr.z);

      // Offset rotation mapping ENU to WebXR:
      this.yawOffsetRad = yawXr - yawEnu;
    }

    // 4. Compute Translation Offset:
    // P_dev_xr = R_y(yawOffset) * P_dev_enu + translationOffset
    // => translationOffset = P_dev_xr - R_y(yawOffset) * P_dev_enu
    const rotatedEnu = pDevEnu.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yawOffsetRad);
    this.translationOffset.copy(pDevXr).sub(rotatedEnu);

    this.isAligned = true;
    this.calibrationSource = 'sensor';
    this.accuracyMeters = sensor.accuracyMeters ?? 3.5;
    this.lastCalibratedTimestampMs = Date.now();
    this.updateMatrices();

    return this.getAlignmentState();
  }

  /**
   * Manual pin calibration: Calibrates the translation offset by snapping an entity
   * whose geodetic position is known to a measured physical WebXR position
   * (e.g. user pointed an AR hit-test reticle at a physical building entrance or monument).
   */
  public calibrateManualPin(
    targetEntityId: string,
    measuredWebXRPosition: THREE.Vector3
  ): GeospatialAlignmentState {
    let targetGeo: { lat: number; lng: number; alt?: number } | null = null;

    if (this.contract) {
      const entity = this.contract.placements.find(p => p.entityId === targetEntityId);
      if (entity) {
        targetGeo = {
          lat: entity.targetGeodetic.latitude,
          lng: entity.targetGeodetic.longitude,
          alt: entity.altitudeResolution.fallbackAltitudeWgs84 ?? ((this.originAnchor.alt ?? 0) + entity.altitudeResolution.offsetMeters)
        };
      }
    }

    if (!targetGeo) {
      throw new Error(`Target entity '${targetEntityId}' not found in deployment contract for manual pin calibration.`);
    }

    // Compute expected ENU position of target
    const enuVec = this.ltp.toLocal(targetGeo);
    const pTargetEnu = new THREE.Vector3(enuVec[0], enuVec[1], enuVec[2]);

    // Keep current rotation, adjust translation so that:
    // measuredWebXRPosition = R_y(yawOffset) * P_target_enu + translationOffset
    const rotatedEnu = pTargetEnu.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yawOffsetRad);
    this.translationOffset.copy(measuredWebXRPosition).sub(rotatedEnu);

    this.isAligned = true;
    this.calibrationSource = 'manual-pin';
    this.accuracyMeters = 0.02; // 2cm optical/hit-test lock
    this.lastCalibratedTimestampMs = Date.now();
    this.updateMatrices();

    return this.getAlignmentState();
  }

  /**
   * Fine-tunes the yaw rotation by a delta in degrees without shifting the origin.
   */
  public adjustHeading(deltaDeg: number): void {
    this.yawOffsetRad += (deltaDeg * Math.PI) / 180;
    this.calibrationSource = 'manual-adjustment';
    this.updateMatrices();
  }

  /**
   * Fine-tunes vertical elevation in meters.
   */
  public adjustElevation(deltaMeters: number): void {
    this.translationOffset.y += deltaMeters;
    this.calibrationSource = 'manual-adjustment';
    this.updateMatrices();
  }

  /**
   * Fine-tunes horizontal translation in WebXR meters.
   */
  public adjustTranslation(deltaX: number, deltaZ: number): void {
    this.translationOffset.x += deltaX;
    this.translationOffset.z += deltaZ;
    this.calibrationSource = 'manual-adjustment';
    this.updateMatrices();
  }

  // ============================================================================
  // Coordinate & Orientation Conversions
  // ============================================================================

  /**
   * Converts a WGS-84 geodetic coordinate (lat, lng, alt) to WebXR local-floor coordinates.
   */
  public geodeticToWebXR(geo: { lat: number; lng: number; alt?: number }): THREE.Vector3 {
    const enuVec = this.ltp.toLocal({
      lat: geo.lat,
      lng: geo.lng,
      alt: geo.alt ?? this.originAnchor.alt ?? 0
    });

    const v = new THREE.Vector3(enuVec[0], enuVec[1], enuVec[2]);
    v.applyMatrix4(this.alignmentMatrix);
    return v;
  }

  /**
   * Converts a WebXR local-floor coordinate back to WGS-84 geodetic coordinates (lat, lng, alt).
   */
  public webXRToGeodetic(webXRPos: THREE.Vector3): { lat: number; lng: number; alt: number } {
    const vEnu = webXRPos.clone().applyMatrix4(this.invAlignmentMatrix);
    const metricEnu: Vec3 = [vEnu.x, vEnu.y, vEnu.z];
    const res = this.ltp.toLatLng(metricEnu);

    return {
      lat: res.lat,
      lng: res.lng,
      alt: res.alt ?? (this.originAnchor.alt ?? 0)
    };
  }

  /**
   * Converts a compass heading (degrees clockwise from True North) and optional pitch/roll
   * into a WebXR THREE.Quaternion aligned with the current spatial calibration.
   */
  public geodeticHeadingToWebXRQuaternion(
    headingDeg: number,
    pitchDeg: number = 0,
    rollDeg: number = 0
  ): THREE.Quaternion {
    // In Three.js ENU, 0 deg True North points along -Z.
    // Clockwise heading maps to Euler Y = -headingRad.
    const headingRad = (headingDeg * Math.PI) / 180;
    const pitchRad = (pitchDeg * Math.PI) / 180;
    const rollRad = (rollDeg * Math.PI) / 180;

    // Apply orientation in ENU:
    const eulerEnu = new THREE.Euler(pitchRad, -headingRad, rollRad, 'YXZ');
    const qEnu = new THREE.Quaternion().setFromEuler(eulerEnu);

    // Rotate by alignment yaw offset around Y:
    const qAlignment = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      this.yawOffsetRad
    );

    return qAlignment.multiply(qEnu);
  }

  /**
   * Converts a WebXR THREE.Quaternion back to a geodetic compass heading (0 to 360 clockwise from True North).
   */
  public webXRQuaternionToGeodeticHeading(quaternion: THREE.Quaternion): number {
    // Inverse alignment rotation
    const qAlignmentInv = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      -this.yawOffsetRad
    );
    const qEnu = qAlignmentInv.multiply(quaternion.clone());

    // Forward direction in ENU:
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(qEnu);
    // Heading in ENU:
    // At fwd = (0, 0, -1) [North], heading = 0
    // At fwd = (1, 0, 0) [East], heading = 90
    // At fwd = (0, 0, 1) [South], heading = 180
    // At fwd = (-1, 0, 0) [West], heading = 270
    let headingRad = Math.atan2(fwd.x, -fwd.z);
    if (headingRad < 0) {
      headingRad += 2 * Math.PI;
    }

    return (headingRad * 180) / Math.PI;
  }

  // ============================================================================
  // Contract & AR Placement Operations
  // ============================================================================

  /**
   * Loads a GeoAnchorDeploymentContract into the bridge.
   */
  public loadContract(contract: GeoAnchorDeploymentContract): void {
    this.contract = contract;
    this.originAnchor = {
      lat: contract.spatialCluster.originGeodetic.latitude,
      lng: contract.spatialCluster.originGeodetic.longitude,
      alt: contract.spatialCluster.originGeodetic.altitudeMsl ?? 0,
      geoidHeight: 0
    };

    this.ltp = new LocalTangentPlane(
      {
        lat: this.originAnchor.lat,
        lng: this.originAnchor.lng,
        alt: this.originAnchor.alt
      },
      this.originAnchor.geoidHeight ?? 0
    );

    this.geoFrame = new GeoFrame(this.originAnchor, 1.0);
    this.updateMatrices();
  }

  /**
   * Computes the exact WebXR position, quaternion, and scale for an ARPlacementEntity.
   */
  public createPlacementTransform(placement: ARPlacementEntity): {
    position: THREE.Vector3;
    quaternion: THREE.Quaternion;
    scale: THREE.Vector3;
  } {
    // Resolve altitude based on AltitudeResolutionMode
    const alt = this.resolvePlacementAltitude(placement);

    const position = this.geodeticToWebXR({
      lat: placement.targetGeodetic.latitude,
      lng: placement.targetGeodetic.longitude,
      alt
    });

    let quaternion: THREE.Quaternion;
    if (placement.orientation.rotationQuaternion) {
      const [qx, qy, qz, qw] = placement.orientation.rotationQuaternion;
      const qEnu = new THREE.Quaternion(qx, qy, qz, qw);
      const qAlignment = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0),
        this.yawOffsetRad
      );
      quaternion = qAlignment.multiply(qEnu);
    } else {
      quaternion = this.geodeticHeadingToWebXRQuaternion(
        placement.orientation.headingDeg,
        placement.orientation.pitchDeg ?? 0,
        placement.orientation.rollDeg ?? 0
      );
    }

    const scale = new THREE.Vector3(
      placement.scaleMeters[0],
      placement.scaleMeters[1],
      placement.scaleMeters[2]
    );

    return { position, quaternion, scale };
  }

  /**
   * Applies position, orientation, and scale directly to a Three.js Object3D or Mesh.
   */
  public applyPlacementToObject(placement: ARPlacementEntity, object: THREE.Object3D): void {
    const transform = this.createPlacementTransform(placement);
    object.position.copy(transform.position);
    object.quaternion.copy(transform.quaternion);
    object.scale.copy(transform.scale);

    object.userData = {
      ...object.userData,
      geospatial: {
        entityId: placement.entityId,
        entityName: placement.entityName,
        targetGeodetic: placement.targetGeodetic,
        altitudeResolution: placement.altitudeResolution,
        occlusionMode: placement.interaction.occlusionMode
      }
    };
  }

  /**
   * Synchronizes placements from the loaded contract into a Three.js Scene group.
   */
  public syncScenePlacements(
    containerGroup: THREE.Group,
    assetFactory?: (placement: ARPlacementEntity) => THREE.Object3D
  ): Map<string, THREE.Object3D> {
    if (!this.contract) {
      throw new Error('No deployment contract loaded to synchronize placements.');
    }

    const objectMap = new Map<string, THREE.Object3D>();

    for (const placement of this.contract.placements) {
      let object = containerGroup.getObjectByName(placement.entityId);
      if (!object) {
        if (assetFactory) {
          object = assetFactory(placement);
        } else {
          // Default placeholder wireframe box
          const geom = new THREE.BoxGeometry(1, 1, 1);
          const mat = new THREE.MeshBasicMaterial({ color: 0x3b82f6, wireframe: true });
          object = new THREE.Mesh(geom, mat);
        }
        object.name = placement.entityId;
        containerGroup.add(object);
      }

      this.applyPlacementToObject(placement, object);
      objectMap.set(placement.entityId, object);
    }

    return objectMap;
  }

  /**
   * Queries and returns all contract placements within a given radial distance (in meters)
   * from the viewer's current WebXR position.
   */
  public getPlacementsInRadius(
    maxDistanceMeters: number,
    currentWebXRPos: THREE.Vector3 = new THREE.Vector3(0, 0, 0)
  ): ProjectedPlacement[] {
    if (!this.contract) {
      return [];
    }

    const results: ProjectedPlacement[] = [];

    for (const placement of this.contract.placements) {
      const transform = this.createPlacementTransform(placement);
      const distance = transform.position.distanceTo(currentWebXRPos);

      if (distance <= maxDistanceMeters) {
        results.push({
          placement,
          webXRPosition: transform.position,
          webXRQuaternion: transform.quaternion,
          webXRScale: transform.scale,
          distanceFromViewerMeters: distance
        });
      }
    }

    return results.sort((a, b) => a.distanceFromViewerMeters - b.distanceFromViewerMeters);
  }

  /**
   * Exports an updated contract with refreshed geodetic coordinates if objects
   * were modified/dragged in the WebXR session.
   */
  public exportUpdatedContract(sceneContainer?: THREE.Group): GeoAnchorDeploymentContract {
    if (!this.contract) {
      throw new Error('No base deployment contract loaded to export.');
    }

    const updatedPlacements: ARPlacementEntity[] = this.contract.placements.map(placement => {
      let updated = { ...placement };

      if (sceneContainer) {
        const obj = sceneContainer.getObjectByName(placement.entityId);
        if (obj) {
          const geo = this.webXRToGeodetic(obj.position);
          const heading = this.webXRQuaternionToGeodeticHeading(obj.quaternion);

          updated = {
            ...updated,
            targetGeodetic: {
              latitude: Number(geo.lat.toFixed(7)),
              longitude: Number(geo.lng.toFixed(7))
            },
            orientation: {
              ...updated.orientation,
              headingDeg: Number(heading.toFixed(2))
            },
            scaleMeters: [
              Number(obj.scale.x.toFixed(3)),
              Number(obj.scale.y.toFixed(3)),
              Number(obj.scale.z.toFixed(3))
            ]
          };
        }
      }

      return updated;
    });

    return {
      ...this.contract,
      timestamp: new Date().toISOString(),
      placements: updatedPlacements
    };
  }

  // ============================================================================
  // Vector Map Projection (Road Corridors & Parcels)
  // ============================================================================

  /**
   * Projects road corridor centerlines into WebXR Line objects for street navigation / geofencing.
   */
  public projectRoadCorridorsToWebXR(
    corridors?: GoogleRoadCorridor[]
  ): THREE.Line[] {
    const list = corridors ?? this.contract?.vectorMapContext?.roadCorridors ?? [];
    const lines: THREE.Line[] = [];

    for (const corridor of list) {
      const points: THREE.Vector3[] = [];

      for (let i = 0; i < corridor.coordinatesWGS84.length; i++) {
        const [lng, lat] = corridor.coordinatesWGS84[i];
        const alt = (corridor as any).elevationASL ? (corridor as any).elevationASL[i] : (this.originAnchor.alt ?? 0);
        const pos = this.geodeticToWebXR({ lat, lng, alt });
        points.push(pos);
      }

      if (points.length >= 2) {
        const geometry = new THREE.BufferGeometry().setFromPoints(points);
        const material = new THREE.LineBasicMaterial({
          color: corridor.type === 'avenue' ? 0x00f0ff : 0x7000ff,
          linewidth: 2
        });
        const line = new THREE.Line(geometry, material);
        line.name = `road_${corridor.id}`;
        lines.push(line);
      }
    }

    return lines;
  }

  /**
   * Projects parcel boundary polygons into extruded WebXR 3D massing meshes or wireframe envelopes.
   */
  public projectParcelsToWebXR(
    parcels?: Array<GoogleParcelEnvelope | { id: string; name?: string; isLandmark?: boolean; heightMeters: number; polygonWGS84?: [number, number][]; coordinatesWGS84?: [number, number][]; baseElevation?: number }>
  ): THREE.Group {
    const list = parcels ?? this.contract?.vectorMapContext?.parcels ?? [];
    const group = new THREE.Group();
    group.name = 'webxr_parcels_geofence';

    for (const parcel of list as any[]) {
      const coords: [number, number][] = parcel.polygonWGS84 ?? parcel.coordinatesWGS84 ?? [];
      if (coords.length < 3) {
        continue;
      }

      const points2D: THREE.Vector2[] = [];
      let baseHeightXr = 0;

      for (let i = 0; i < coords.length; i++) {
        const [lng, lat] = coords[i];
        const baseAlt = parcel.baseElevation ?? this.originAnchor.alt ?? 0;
        const pos = this.geodeticToWebXR({ lat, lng, alt: baseAlt });
        points2D.push(new THREE.Vector2(pos.x, pos.z));
        baseHeightXr = pos.y;
      }

      const shape = new THREE.Shape(points2D);
      const extrudeSettings: THREE.ExtrudeGeometryOptions = {
        depth: parcel.heightMeters,
        bevelEnabled: false
      };

      const geometry = new THREE.ExtrudeGeometry(shape, extrudeSettings);
      // Extrude goes along +Z; rotate so it extrudes vertically along +Y
      geometry.rotateX(Math.PI / 2);

      const material = new THREE.MeshBasicMaterial({
        color: parcel.isLandmark ? 0xffaa00 : 0x334155,
        wireframe: true,
        transparent: true,
        opacity: 0.6
      });

      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = `parcel_${parcel.id}`;
      mesh.position.y = baseHeightXr;
      group.add(mesh);
    }

    return group;
  }

  // ============================================================================
  // Telemetry & Getters
  // ============================================================================

  public getAlignmentState(): GeospatialAlignmentState {
    return {
      isAligned: this.isAligned,
      calibrationSource: this.calibrationSource,
      accuracyMeters: this.accuracyMeters,
      headingOffsetDeg: (this.yawOffsetRad * 180) / Math.PI,
      elevationOffsetMeters: this.translationOffset.y,
      originGeoAnchor: {
        lat: this.originAnchor.lat,
        lng: this.originAnchor.lng,
        alt: this.originAnchor.alt ?? 0,
        geoidHeight: this.originAnchor.geoidHeight
      },
      translationOffset: [
        this.translationOffset.x,
        this.translationOffset.y,
        this.translationOffset.z
      ],
      alignmentMatrix: this.alignmentMatrix.clone(),
      lastCalibratedTimestampMs: this.lastCalibratedTimestampMs
    };
  }

  public getOriginAnchor(): GeoAnchor4D {
    return { ...this.originAnchor };
  }

  public getContract(): GeoAnchorDeploymentContract | null {
    return this.contract;
  }

  // ============================================================================
  // Internal Helpers
  // ============================================================================

  private resolvePlacementAltitude(placement: ARPlacementEntity): number {
    const mode = placement.altitudeResolution.mode;
    const offset = placement.altitudeResolution.offsetMeters;

    if (mode === 'wgs84' && placement.altitudeResolution.fallbackAltitudeWgs84 !== undefined) {
      return placement.altitudeResolution.fallbackAltitudeWgs84 + offset;
    }

    if (mode === 'rooftop') {
      // Elevated structure offset
      return (this.originAnchor.alt ?? 0) + offset;
    }

    // Default terrain / facade resolution
    return (this.originAnchor.alt ?? 0) + offset;
  }

  private updateMatrices(): void {
    // Rigid transform:
    // P_xr = Translation(translationOffset) * RotationY(yawOffsetRad) * P_enu
    const rotM = new THREE.Matrix4().makeRotationY(this.yawOffsetRad);
    const transM = new THREE.Matrix4().makeTranslation(
      this.translationOffset.x,
      this.translationOffset.y,
      this.translationOffset.z
    );

    this.alignmentMatrix.multiplyMatrices(transM, rotM);
    this.invAlignmentMatrix.copy(this.alignmentMatrix).invert();
  }
}
