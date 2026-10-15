/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { SurveySynthesisEngine } from '../../../common/spatial/SurveySynthesisEngine';
import {
  ColmapCameraPose,
  GeodeticAnchor,
  SurveyPatternConfig,
  ColmapVectorPipelineRequest,
  ColmapVectorPipelineResult,
  ColmapGeoJsonFeatureCollection
} from '../../../common/spatial/colmap-vector-reference-types';
import { GoogleElevationService } from './google-elevation-service';
import { GoogleMapsService } from './google-maps-service';
import { MissingInputError } from '../../../common/errors/pipeline-errors';

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

      // The stated ground elevation, else the Elevation API's (when asked for); never a default.
      const groundElevation = typeof elevationMeters === 'number' && Number.isFinite(elevationMeters)
        ? elevationMeters
        : await this.requireElevation(lat, lng, apiKey, !!(options?.fetchElevation || request.fetchElevation));

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
      const groundElevation = await this.requireElevation(geocoded.lat, geocoded.lng, apiKey, !!(options?.fetchElevation || request.fetchElevation));

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
   * Ground elevation ASL from the Elevation API (the local proxy, else GoogleElevationService). Without
   * fetchElevation, or when both fail, this throws: the survey's heights are not built on an invented 0 m.
   */
  private async requireElevation(lat: number, lng: number, apiKey: string | undefined, fetchElevation: boolean): Promise<number> {
    const where = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
    if (!fetchElevation) {
      throw new MissingInputError('ColmapVectorPipeline', 'anchor.elevationMeters', `no ground elevation was given for ${where}; give elevationMeters or set fetchElevation`);
    }
    const failures: string[] = [];
    if (typeof fetch !== 'undefined') {
      try {
        const proxyUrl = `/api/elevation?locations=${lat},${lng}${apiKey ? `&key=${encodeURIComponent(apiKey)}` : ''}`;
        const resp = await fetch(proxyUrl);
        if (resp.ok) {
          const data = await resp.json();
          if (data.results && data.results.length > 0 && typeof data.results[0].elevation === 'number') {
            return data.results[0].elevation;
          }
          failures.push('the elevation proxy returned no result');
        } else {
          failures.push(`the elevation proxy returned HTTP ${resp.status}`);
        }
      } catch (err) {
        failures.push(`the elevation proxy failed (${err instanceof Error ? err.message : String(err)})`);
      }
    }
    try {
      const results = await GoogleElevationService.getInstance().getElevationForLocations([{ lat, lng }]);
      return results[0].elevation;
    } catch (err) {
      failures.push(`the Elevation API failed (${err instanceof Error ? err.message : String(err)})`);
    }
    throw new MissingInputError('ColmapVectorPipeline', 'anchor.elevationMeters', `the ground elevation at ${where} is unknown: ${failures.join('; ')}`);
  }

  /**
   * Resolves a coordinate string or a place name with GoogleMapsService.geocode: coordinates are used as given,
   * anything else is one Google Places Text Search call. Failures throw LocationUnresolvedError.
   */
  private async geocodeAddress(query: string, apiKey?: string): Promise<{ lat: number; lng: number; formattedAddress: string; placeId?: string }> {
    const place = await GoogleMapsService.getInstance().geocode(query, { apiKey });
    return {
      lat: Number(place.lat.toFixed(6)),
      lng: Number(place.lng.toFixed(6)),
      formattedAddress: place.name && !place.formattedAddress.includes(place.name) ? `${place.name}, ${place.formattedAddress}` : place.formattedAddress,
      placeId: place.placeId
    };
  }

  private readonly engine = new SurveySynthesisEngine();

  /** Procedurally synthesized 6-DoF survey array (delegates to the shared SurveySynthesisEngine). */
  public generateSyntheticSurvey(anchor: GeodeticAnchor, config: SurveyPatternConfig): ColmapCameraPose[] {
    return this.engine.synthesize(anchor, config);
  }

  /** Parses COLMAP / GLOMAP cameras.txt + images.txt into anchored stations. */
  public ingestColmapTextFiles(camerasText: string, imagesText: string, anchor: GeodeticAnchor): ColmapCameraPose[] {
    return this.engine.fromColmapText(camerasText, imagesText, anchor);
  }

  /** RFC 7946 GeoJSON of stations, footprints and trajectory. */
  public buildGeoJsonFeatureCollection(poses: ColmapCameraPose[], anchor: GeodeticAnchor): ColmapGeoJsonFeatureCollection {
    return this.engine.toGeoJson(poses, anchor);
  }

  /** COLMAP cameras.txt / images.txt (camera-from-world, round-trips through ingestColmapTextFiles). */
  public exportColmapText(poses: ColmapCameraPose[]): { camerasText: string; imagesText: string } {
    return this.engine.toColmapText(poses);
  }

  /** Ranks stations for AI Beautify using their mesh-derived metrics (see SurveyStationRenderService.enrichStations). */
  public rankStationsForBeautify(poses: ColmapCameraPose[], maxCount: number): ColmapCameraPose[] {
    return this.engine.rankForBeautify(poses, { maxCount });
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
