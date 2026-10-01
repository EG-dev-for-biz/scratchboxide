/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import {
  Entity4D,
  Universal4DSceneDocument,
  GeoAnchorDeploymentContract,
  ARPlacementEntity,
  AltitudeResolutionMode,
  WeatherConditions
} from '../../common/geospatial-4d-protocol';
import { GeoFrame } from '../../common/coordinate/GeoFrame';
import { getSolarPosition } from '../../common/coordinate/solarPosition';
import { WeatherApiService } from './WeatherApiService';
import { GoogleMidtownVectorMapping } from '../../browser/generative-canvas/services/google-vector-mapping-service';

export interface DeploymentCompileOptions {
  /** Root reference frame for the authoring scene. Required to invert local Three.js coordinates to WGS-84. */
  geoFrame: GeoFrame;
  /** Scene document or list of 4D entities to compile. */
  scene: Universal4DSceneDocument | Entity4D[];
  /** Target multiverse branch to filter/deploy. Defaults to 'earth/main'. */
  targetBranchId?: string;
  /** Explicit astronomical instant. Defaults to current date and time. */
  timestamp?: Date;
  /** Explicit weather override, or boolean flag to fetch live weather via WeatherApiService. Defaults to true. */
  weather?: WeatherConditions | boolean;
  /** Optional vector map mapping context (Google Road Corridors, Parcels, Landmarks). */
  vectorMap?: GoogleMidtownVectorMapping;
  /** Default altitude resolution mode for grounded entities without explicit semantics. Defaults to 'terrain'. */
  defaultAltitudeMode?: AltitudeResolutionMode;
  /** Mobile 3D Gaussian Splatting execution parameters. */
  splatConfig?: {
    maxSplatBudgetMobile?: number;
    lodDistanceVoxelizeMeters?: number;
    depthOcclusionEnabled?: boolean;
  };
}

export class DeploymentManifestCompiler {
  /**
   * Compiles an authoring scene document or entity list into a deterministic,
   * high-precision GeoAnchorDeploymentContract ready for mobile ARCore consumption.
   */
  public static async compile(options: DeploymentCompileOptions): Promise<GeoAnchorDeploymentContract> {
    const geoFrame = options.geoFrame;
    const origin = geoFrame.anchor;
    const now = options.timestamp ?? new Date();
    const branchId = options.targetBranchId ?? 'earth/main';
    const defaultAltMode = options.defaultAltitudeMode ?? 'terrain';

    // 1. Resolve Astronomical Ephemeris via NOAA Solar Position equations
    const solar = getSolarPosition(now, origin.lat, origin.lng);
    const solarElevationDeg = (solar.altitude * 180) / Math.PI;
    const solarAzimuthDeg = (solar.azimuth * 180) / Math.PI;

    // Approximate Planckian blackbody temperature & direct intensity derived from solar elevation
    const isAboveHorizon = solarElevationDeg > 0;
    const colorTempK = isAboveHorizon
      ? Math.min(6500, Math.max(2000, 2000 + solarElevationDeg * 60))
      : 1800;
    const directIntensity = isAboveHorizon
      ? Math.max(0.0, Math.sin(solar.altitude) * 1.1)
      : 0.0;
    const sunRgb = this.kelvinToRgb(colorTempK);

    // 2. Resolve Atmospheric Weather State
    let weatherProfile: WeatherConditions | undefined;
    if (typeof options.weather === 'object' && options.weather !== null) {
      weatherProfile = options.weather;
    } else if (options.weather !== false) {
      try {
        weatherProfile = await WeatherApiService.fetchNuancedWeather(origin.lat, origin.lng, now);
      } catch (err) {
        // Fallback default sunny profile if offline
        weatherProfile = {
          conditions: 'sunny',
          fogDensity: 0.0,
          ambientTemperatureC: 20.0,
          precipitationMmHr: 0.0
        };
      }
    }

    // 3. Extract and Filter Scene Entities
    const rawEntities = Array.isArray(options.scene) ? options.scene : options.scene.entities;
    const matchingEntities = rawEntities.filter(e => {
      // If entity specifies a lineage branch, match targetBranchId; otherwise allow if main
      if (!e.lineage || !e.lineage.worldBranchId) return true;
      return e.lineage.worldBranchId === branchId;
    });

    // 4. Invert Local Scene Offsets to 64-bit WGS-84 Coordinates
    const placements: ARPlacementEntity[] = matchingEntities.map(entity => {
      return this.compileEntity(entity, geoFrame, defaultAltMode, branchId);
    });

    // 5. Compile Optional Vector Map Context
    let vectorMapContext: GeoAnchorDeploymentContract['vectorMapContext'];
    if (options.vectorMap) {
      vectorMapContext = {
        roadCorridors: options.vectorMap.roads?.map(road => ({
          id: road.id,
          name: road.name,
          type: road.type,
          widthMeters: road.widthMeters,
          lanes: road.lanes,
          coordinatesWGS84: road.coordinatesWGS84
        })),
        parcels: options.vectorMap.parcels?.map(parcel => ({
          id: parcel.id,
          name: parcel.name,
          isLandmark: parcel.isLandmark,
          heightMeters: parcel.heightMeters,
          polygonWGS84: parcel.coordinatesWGS84
        }))
      };
    }

    // 6. Assemble Contract
    const contract: GeoAnchorDeploymentContract = {
      schemaVersion: '1.2.0',
      frameContract: 'sbox-enu-yup-v1',
      timestamp: now.toISOString(),
      spatialCluster: {
        geoAnchorKey: `geo:${origin.lat.toFixed(4)}:${origin.lng.toFixed(4)}`,
        originGeodetic: {
          latitude: origin.lat,
          longitude: origin.lng,
          altitudeMsl: origin.alt
        }
      },
      environment: {
        sunVector: {
          azimuthDeg: solarAzimuthDeg,
          elevationDeg: solarElevationDeg,
          colorTemperatureK: colorTempK,
          normalizedSunRgb: sunRgb,
          directIntensity
        },
        weather: weatherProfile ? {
          conditions: (weatherProfile.conditions === 'stormy' ? 'rainy' : weatherProfile.conditions) as any,
          precipitationMmHr: weatherProfile.precipitationMmHr ?? 0.0,
          fogDensity: weatherProfile.fogDensity ?? 0.0,
          wetnessFactor: (weatherProfile.precipitationMmHr ?? 0.0) > 0 ? 1.0 : 0.0
        } : undefined
      },
      vectorMapContext,
      splatRenderingConfig: options.splatConfig ?? {
        maxSplatBudgetMobile: 500000,
        lodDistanceVoxelizeMeters: 25.0,
        depthOcclusionEnabled: true
      },
      placements
    };

    return contract;
  }

  /**
   * Compiles an individual Entity4D into a high-precision ARPlacementEntity.
   */
  public static compileEntity(
    entity: Entity4D,
    geoFrame: GeoFrame,
    defaultAltMode: AltitudeResolutionMode = 'terrain',
    branchId: string = 'earth/main'
  ): ARPlacementEntity {
    // 1. Resolve Exact 64-bit WGS-84 Coordinates
    let targetLat = geoFrame.anchor.lat;
    let targetLng = geoFrame.anchor.lng;

    if (entity.space.geoAnchor?.lat !== undefined && entity.space.geoAnchor?.lng !== undefined) {
      targetLat = entity.space.geoAnchor.lat;
      targetLng = entity.space.geoAnchor.lng;
    } else if (entity.space.localTransform?.position) {
      const geodetic = geoFrame.toGeo(entity.space.localTransform.position);
      targetLat = geodetic.lat;
      targetLng = geodetic.lng;
    }

    // 2. Infer Altitude Resolution Mode
    let altMode: AltitudeResolutionMode = defaultAltMode;
    const nameLower = (entity.name || '').toLowerCase();
    const type = entity.content?.type;

    if (nameLower.includes('roof') || nameLower.includes('deck') || nameLower.includes('helipad') || nameLower.includes('parapet')) {
      altMode = 'rooftop';
    } else if (type === 'vector-geojson' && nameLower.includes('facade')) {
      altMode = 'streetscape_facade';
    } else if (entity.space.geoAnchor?.alt !== undefined && entity.space.geoAnchor.alt > 50.0 && !nameLower.includes('ground')) {
      altMode = 'wgs84';
    }

    // 3. Resolve Orientation & Heading
    let headingDeg = 0;
    if (entity.space.geoAnchor?.heading !== undefined) {
      headingDeg = entity.space.geoAnchor.heading;
    } else if (entity.space.localTransform?.rotationQuaternion) {
      const q = entity.space.localTransform.rotationQuaternion;
      // Convert quaternion to yaw heading: yaw = atan2(2*(w*y + x*z), 1 - 2*(y^2 + z^2))
      const yawRad = Math.atan2(2 * (q[3] * q[1] + q[0] * q[2]), 1 - 2 * (q[1] * q[1] + q[2] * q[2]));
      headingDeg = (yawRad * 180) / Math.PI;
      if (headingDeg < 0) headingDeg += 360;
    }

    // 4. Resolve Scale
    const scale: [number, number, number] = entity.space.localTransform?.scale
      ? [entity.space.localTransform.scale[0], entity.space.localTransform.scale[1], entity.space.localTransform.scale[2]]
      : [1.0, 1.0, 1.0];

    // 5. Construct Asset Payload
    const content = entity.content;
    let assetType: ARPlacementEntity['asset']['assetType'] = 'mesh-glb';
    let durableGlbUri: string | undefined;
    let durableSplatUri: string | undefined;
    let splatFormat: 'splat' | 'spz' | undefined;
    let splatCount: number | undefined;

    if (content?.type === 'gaussian-splat') {
      assetType = 'gaussian-splat';
      durableSplatUri = content.durableUri;
      splatFormat = content.durableUri.toLowerCase().endsWith('.spz') ? 'spz' : 'splat';
      splatCount = content.metadata?.pointCount ?? content.metadata?.splatCount;
    } else if (content?.type === 'vector-geojson') {
      assetType = nameLower.includes('corridor') || nameLower.includes('road') ? 'vector-corridor' : 'vector-parcel';
    } else {
      assetType = 'mesh-glb';
      durableGlbUri = content?.durableUri || `asset://${entity.id}.glb`;
    }

    return {
      entityId: entity.id,
      entityName: entity.name,
      targetGeodetic: {
        latitude: targetLat,
        longitude: targetLng
      },
      altitudeResolution: {
        mode: altMode,
        offsetMeters: 0.0,
        fallbackAltitudeWgs84: entity.space.geoAnchor?.alt
      },
      orientation: {
        headingDeg,
        rotationQuaternion: entity.space.localTransform?.rotationQuaternion
      },
      scaleMeters: scale,
      asset: {
        assetId: `asset-${entity.id}`,
        assetType,
        durableGlbUri,
        durableSplatUri,
        splatFormat,
        splatCount,
        lodProxyGlbUri: content?.lodPyramid?.lowProxyUri,
        pbrConfig: {
          metallicFactor: 0.1,
          roughnessFactor: 0.6,
          weatherReactive: true
        }
      },
      interaction: {
        occlusionMode: 'streetscape_depth',
        enablePhysicalCollisions: entity.behavior?.physics !== undefined,
        massKg: entity.behavior?.physics?.mass
      },
      multiverseBranchId: entity.lineage?.worldBranchId || branchId
    };
  }

  /**
   * Helper to convert blackbody Kelvin temperature to normalized RGB values.
   */
  private static kelvinToRgb(kelvin: number): [number, number, number] {
    const temp = kelvin / 100.0;
    let r: number, g: number, b: number;

    // Red
    if (temp <= 66) {
      r = 255;
    } else {
      r = temp - 60;
      r = 329.698727446 * Math.pow(r, -0.1332047592);
      r = Math.min(255, Math.max(0, r));
    }

    // Green
    if (temp <= 66) {
      g = temp;
      g = 99.4708025861 * Math.log(g) - 161.1195681661;
      g = Math.min(255, Math.max(0, g));
    } else {
      g = temp - 60;
      g = 288.1221695283 * Math.pow(g, -0.0755148492);
      g = Math.min(255, Math.max(0, g));
    }

    // Blue
    if (temp >= 66) {
      b = 255;
    } else if (temp <= 19) {
      b = 0;
    } else {
      b = temp - 10;
      b = 138.5177312231 * Math.log(b) - 305.0447927307;
      b = Math.min(255, Math.max(0, b));
    }

    return [r / 255.0, g / 255.0, b / 255.0];
  }

  /**
   * Validates a compiled deployment contract for strict geodetic and structural constraints.
   */
  public static validateContract(contract: GeoAnchorDeploymentContract): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!contract.spatialCluster?.originGeodetic) {
      errors.push('Contract missing spatialCluster.originGeodetic');
    } else {
      const { latitude, longitude } = contract.spatialCluster.originGeodetic;
      if (latitude < -90 || latitude > 90) errors.push(`Invalid cluster latitude: ${latitude}`);
      if (longitude < -180 || longitude > 180) errors.push(`Invalid cluster longitude: ${longitude}`);
    }

    if (!Array.isArray(contract.placements)) {
      errors.push('Contract placements must be an array');
    } else {
      contract.placements.forEach((p, idx) => {
        if (!p.entityId) errors.push(`Placement #${idx} missing entityId`);
        if (p.targetGeodetic.latitude < -90 || p.targetGeodetic.latitude > 90) {
          errors.push(`Placement ${p.entityId} has out-of-range latitude: ${p.targetGeodetic.latitude}`);
        }
        if (p.targetGeodetic.longitude < -180 || p.targetGeodetic.longitude > 180) {
          errors.push(`Placement ${p.entityId} has out-of-range longitude: ${p.targetGeodetic.longitude}`);
        }
        if (p.orientation.headingDeg < 0 || p.orientation.headingDeg > 360) {
          errors.push(`Placement ${p.entityId} has out-of-range heading: ${p.orientation.headingDeg}`);
        }
        if (p.asset.assetType === 'gaussian-splat' && !p.asset.durableSplatUri) {
          errors.push(`Placement ${p.entityId} is gaussian-splat but lacks durableSplatUri`);
        }
      });
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Serializes a contract to a formatted JSON string.
   */
  public static serializeJson(contract: GeoAnchorDeploymentContract, pretty: boolean = true): string {
    return JSON.stringify(contract, null, pretty ? 2 : undefined);
  }
}
