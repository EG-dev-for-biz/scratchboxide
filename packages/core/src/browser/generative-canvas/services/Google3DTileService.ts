/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as THREE from 'three';
import type { LocalTileBounds, SlippyTileXYZ } from './TileBoundAligner';
import type { ClayPresetId } from './TileClayProcessor';

export type { ClayPresetId };
import { GoogleMapsService, GeocodeResult } from './google-maps-service';
import type { Media4DObject, Scene3DData } from '../canvas-types';
import { LocationUnresolvedError, TileExtractionError } from '../../../common/errors/pipeline-errors';
import { assertUsableCoordinates, formatCoordinates, parseCoordinateText } from '../../../common/coordinate/parse-coordinates';
import { UniversalTextureInducer, classifyGeometrySurfaces, ArchitecturalZone } from './UniversalTextureInducer';

export { UniversalTextureInducer, classifyGeometrySurfaces, ArchitecturalZone };

export interface TileIngestionOptions {
  query?: string;
  lat?: number;
  lng?: number;
  elevation?: number;
  zoom?: number;
  radiusMeters?: number;
  clayPreset?: ClayPresetId;
  customColor?: number | string;
  includeTerrain?: boolean;
  includeBuildings?: boolean;
  detailLevel?: 'low' | 'medium' | 'high';
  name?: string;
  generateGlb?: boolean;
}

export interface TileIngestionStats {
  buildingCount: number;
  vertexCount: number;
  faceCount: number;
  elevationSpanMeters: number;
  terrainAreaSqMeters: number;
}

export interface TileIngestionResult {
  success: boolean;
  mesh: THREE.Mesh | THREE.Group;
  media4DObject: Media4DObject;
  customMeshDefinition?: NonNullable<Scene3DData['customMeshes']>[number];
  buildingMeshes?: NonNullable<Scene3DData['customMeshes']>;
  geoAnchor: {
    lat: number;
    lng: number;
    elevation: number;
    landmarkName?: string;
    formattedAddress?: string;
  };
  tileXYZ: SlippyTileXYZ;
  bounds: LocalTileBounds;
  stats: TileIngestionStats;
  glbBuffer?: ArrayBuffer;
}

/** A location resolved from explicit coordinates or a Google Places lookup. */
export interface ResolvedTileLocation {
  lat: number;
  lng: number;
  /** Metres above sea level: as stated by the caller or from the Elevation API; undefined when neither gave one. */
  elevation?: number;
  elevationSource?: string;
  datum?: string;
  landmarkName?: string;
  formattedAddress?: string;
  isResolved: boolean;
}

export class Google3DTileService {
  private static instance: Google3DTileService;

  public static getInstance(): Google3DTileService {
    if (!Google3DTileService.instance) {
      Google3DTileService.instance = new Google3DTileService();
    }
    return Google3DTileService.instance;
  }

  /**
   * Resolves explicit coordinates (an object, or text that is entirely "lat, lng") to a geodetic anchor.
   * A place name needs Google Places, so it throws here: use resolveLocation. Nothing maps words to places,
   * and elevation is only what the caller stated.
   */
  public resolveLocationSync(
    queryOrCoords: string | { lat: number; lng: number; elevation?: number }
  ): ResolvedTileLocation {
    if (typeof queryOrCoords === 'object') {
      const label = formatCoordinates(queryOrCoords.lat, queryOrCoords.lng);
      assertUsableCoordinates(queryOrCoords.lat, queryOrCoords.lng, label);
      return {
        lat: queryOrCoords.lat,
        lng: queryOrCoords.lng,
        ...(queryOrCoords.elevation !== undefined ? { elevation: queryOrCoords.elevation, elevationSource: 'explicit' } : {}),
        datum: 'MSL_EGM96',
        landmarkName: label,
        formattedAddress: label,
        isResolved: true
      };
    }

    const query = queryOrCoords.trim();
    const coords = parseCoordinateText(query);
    if (!coords) {
      throw new LocationUnresolvedError(query, 'only coordinates resolve without the network; look the place up with resolveLocation (Google Places)');
    }
    return this.resolveLocationSync(coords);
  }

  /**
   * Resolves a place name, address or coordinates. Place names are one Google Places Text Search call
   * (GoogleMapsService.geocode); the ground elevation comes from the Elevation API, and stays undefined
   * when that is unavailable. Failures throw LocationUnresolvedError.
   */
  public async resolveLocation(
    queryOrCoords: string | { lat: number; lng: number; elevation?: number }
  ): Promise<ResolvedTileLocation> {
    const mapsService = GoogleMapsService.getInstance();
    let resolved: ResolvedTileLocation;
    if (typeof queryOrCoords === 'object' || parseCoordinateText(queryOrCoords.trim())) {
      resolved = this.resolveLocationSync(queryOrCoords);
    } else {
      const geoResult: GeocodeResult = await mapsService.geocode(queryOrCoords);
      resolved = {
        lat: geoResult.lat,
        lng: geoResult.lng,
        datum: 'MSL_EGM96',
        landmarkName: geoResult.name || geoResult.formattedAddress,
        formattedAddress: geoResult.formattedAddress,
        isResolved: true
      };
    }

    if (resolved.elevation === undefined) {
      try {
        resolved.elevation = await mapsService.getElevation(resolved.lat, resolved.lng);
        resolved.elevationSource = 'google_elevation_api';
      } catch {
        // No measured ground height: elevation stays undefined rather than guessed.
      }
    }
    return resolved;
  }

  /**
   * The viewport cannot fetch Google Photorealistic 3D Tiles: extraction runs on the server
   * (google_3d_tiles_get_clay / fetch3DObject), which crawls the real tiles. This always throws, so a caller
   * shows the error instead of a mesh; it never synthesizes terrain or buildings and labels them as Google tiles.
   */
  public async ingestTileRegion(options: TileIngestionOptions = {}): Promise<TileIngestionResult> {
    const place = options.query?.trim() || (options.lat !== undefined && options.lng !== undefined ? formatCoordinates(options.lat, options.lng) : 'the requested place');
    throw new TileExtractionError(
      'crawl',
      `Google 3D Tiles for ${place} cannot be fetched from the viewport; ask for the place in chat so google_3d_tiles_get_clay extracts the real tiles on the server`
    );
  }

  /**
   * Synchronously synthesizes a valid standard Binary GLTF (.glb) buffer from Three.js Object3D.
   */
  public synthesizeGlbTileBufferSync(root: THREE.Object3D): ArrayBuffer {
    const mesh = (root as THREE.Mesh).isMesh ? (root as THREE.Mesh) : (root.children[0] as THREE.Mesh);
    if (!mesh || !mesh.geometry) {
      return new ArrayBuffer(0);
    }

    const geom = mesh.geometry;
    const posAttr = geom.getAttribute('position') as THREE.BufferAttribute;
    const normAttr = geom.getAttribute('normal') as THREE.BufferAttribute;
    const indexAttr = geom.getIndex();

    if (!posAttr) return new ArrayBuffer(0);

    const posArray = posAttr.array as Float32Array;
    const normArray = normAttr ? (normAttr.array as Float32Array) : new Float32Array(posArray.length);
    const indexArray = indexAttr
      ? (indexAttr.array as Uint16Array | Uint32Array)
      : new Uint32Array(posArray.length / 3).map((_, i) => i);

    // Build raw binary buffer
    const posByteLength = posArray.byteLength;
    const normByteLength = normArray.byteLength;
    const indexByteLength = indexArray.byteLength;
    const totalBinLength = posByteLength + normByteLength + indexByteLength;

    const binBuffer = new Uint8Array(totalBinLength);
    binBuffer.set(new Uint8Array(posArray.buffer, posArray.byteOffset, posByteLength), 0);
    binBuffer.set(new Uint8Array(normArray.buffer, normArray.byteOffset, normByteLength), posByteLength);
    binBuffer.set(new Uint8Array(indexArray.buffer, indexArray.byteOffset, indexByteLength), posByteLength + normByteLength);

    const gltfJson = {
      asset: { version: '2.0', generator: 'Scratchbox 3D Tile Ingestion Engine' },
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0, name: root.name || '3DMapTile' }],
      meshes: [
        {
          primitives: [
            {
              attributes: { POSITION: 0, NORMAL: 1 },
              indices: 2,
              mode: 4
            }
          ]
        }
      ],
      accessors: [
        {
          bufferView: 0,
          componentType: 5126, // FLOAT
          count: posAttr.count,
          type: 'VEC3'
        },
        {
          bufferView: 1,
          componentType: 5126, // FLOAT
          count: posAttr.count,
          type: 'VEC3'
        },
        {
          bufferView: 2,
          componentType: indexArray instanceof Uint32Array ? 5125 : 5123, // UNSIGNED_INT or UNSIGNED_SHORT
          count: indexAttr ? indexAttr.count : posAttr.count,
          type: 'SCALAR'
        }
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: posByteLength, target: 34962 },
        { buffer: 0, byteOffset: posByteLength, byteLength: normByteLength, target: 34962 },
        { buffer: 0, byteOffset: posByteLength + normByteLength, byteLength: indexByteLength, target: 34963 }
      ],
      buffers: [{ byteLength: totalBinLength }]
    };

    const jsonText = JSON.stringify(gltfJson);
    const jsonEncoded = new TextEncoder().encode(jsonText);
    const jsonPaddedLength = Math.ceil(jsonEncoded.length / 4) * 4;
    const binPaddedLength = Math.ceil(totalBinLength / 4) * 4;

    const totalGlbLength = 12 + 8 + jsonPaddedLength + 8 + binPaddedLength;
    const glbBuffer = new ArrayBuffer(totalGlbLength);
    const dataView = new DataView(glbBuffer);

    // GLB Header
    dataView.setUint32(0, 0x46546c67, true); // Magic: 'glTF'
    dataView.setUint32(4, 2, true);          // Version: 2
    dataView.setUint32(8, totalGlbLength, true);

    // JSON Chunk Header
    dataView.setUint32(12, jsonPaddedLength, true);
    dataView.setUint32(16, 0x4e4f534a, true); // 'JSON'

    const glbUint8 = new Uint8Array(glbBuffer);
    glbUint8.set(jsonEncoded, 20);
    for (let i = 20 + jsonEncoded.length; i < 20 + jsonPaddedLength; i++) {
      glbUint8[i] = 0x20; // space padding
    }

    // BIN Chunk Header
    const binHeaderOffset = 20 + jsonPaddedLength;
    dataView.setUint32(binHeaderOffset, binPaddedLength, true);
    dataView.setUint32(binHeaderOffset + 4, 0x004e4942, true); // 'BIN\0'

    glbUint8.set(binBuffer, binHeaderOffset + 8);

    return glbBuffer;
  }

  /**
   * Synthesizes a valid standard Binary GLTF (.glb) buffer from Three.js Object3D.
   */
  public async synthesizeGlbTileBuffer(root: THREE.Object3D): Promise<ArrayBuffer> {
    return this.synthesizeGlbTileBufferSync(root);
  }
}


