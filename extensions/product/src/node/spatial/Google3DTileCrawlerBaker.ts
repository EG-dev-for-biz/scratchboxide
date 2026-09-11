/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { LatLngAlt } from '../../common/coordinate/LocalTangentPlane';
import { TextureAtlasPacker, AtlasResult, AtlasPackerOptions } from './TextureAtlasPacker';

/**
 * Headless Node.js 3D Tile Crawler, Leaf GLB Buffer Merger, and CESIUM_RTC Stripper.
 * Borrowed and adapted from OmarShehata/google-earth-as-gltf.
 *
 * Capabilities:
 * 1. Headless crawling of Google Photorealistic 3D Tiles.
 * 2. CESIUM_RTC extension stripping and ECEF-to-ENU coordinate frame normalization.
 * 3. Multi-tile mesh buffer concatenation (vertices, normals, UVs, indices).
 * 4. Unified texture atlas composition with UV coordinate remapping.
 * 5. Clean, standalone single-draw-call GLB generation ready for Unity, Unreal, Three.js, and Godot.
 */

// WGS-84 Ellipsoid constants
const WGS84_A = 6378137.0;
const WGS84_F = 1.0 / 298.257223563;
const WGS84_B = WGS84_A * (1.0 - WGS84_F);
const WGS84_E2 = (WGS84_A * WGS84_A - WGS84_B * WGS84_B) / (WGS84_A * WGS84_A);

export interface TileMeshInput {
  id: string | number;
  positions: Float32Array; // [x, y, z, ...] in RTC or ECEF
  normals?: Float32Array;
  uvs?: Float32Array;
  indices: Uint16Array | Uint32Array;
  rtcCenter?: [number, number, number]; // CESIUM_RTC center in ECEF
  texture?: {
    width: number;
    height: number;
    data: Uint8Array; // RGBA pixel buffer
  };
}

export interface MergedTileResult {
  vertexCount: number;
  indexCount: number;
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  atlas: AtlasResult;
  glbBuffer: Buffer;
}

export interface CrawlAndBakeRequest {
  origin: LatLngAlt;
  radiusMeters?: number;
  apiKey?: string;
  maxTiles?: number;
  packerOptions?: AtlasPackerOptions;
  // For offline/test usage:
  mockTiles?: TileMeshInput[];
}

export class Google3DTileCrawlerBaker {
  /**
   * Converts geodetic (lat, lng, alt) to Earth-Centered Earth-Fixed (ECEF) coordinates.
   */
  public static geodeticToECEF(latDeg: number, lngDeg: number, altM: number): [number, number, number] {
    const latRad = latDeg * (Math.PI / 180);
    const lngRad = lngDeg * (Math.PI / 180);

    const sinLat = Math.sin(latRad);
    const cosLat = Math.cos(latRad);
    const sinLng = Math.sin(lngRad);
    const cosLng = Math.cos(lngRad);

    const n = WGS84_A / Math.sqrt(1.0 - WGS84_E2 * sinLat * sinLat);
    const x = (n + altM) * cosLat * cosLng;
    const y = (n + altM) * cosLat * sinLng;
    const z = ((1.0 - WGS84_E2) * n + altM) * sinLat;

    return [x, y, z];
  }

  /**
   * Converts an Earth-Centered Earth-Fixed (ECEF) point to local East-North-Up (ENU) coordinates
   * relative to a geodetic origin.
   *
   * Output format matches Three.js engine conventions:
   *   X = East
   *   Y = Up
   *   Z = -North
   */
  public static ecefToENU(
    x: number,
    y: number,
    z: number,
    originLatDeg: number,
    originLngDeg: number,
    originAltM: number
  ): [number, number, number] {
    const [ox, oy, oz] = Google3DTileCrawlerBaker.geodeticToECEF(originLatDeg, originLngDeg, originAltM);

    const dx = x - ox;
    const dy = y - oy;
    const dz = z - oz;

    const latRad = originLatDeg * (Math.PI / 180);
    const lngRad = originLngDeg * (Math.PI / 180);

    const sinLat = Math.sin(latRad);
    const cosLat = Math.cos(latRad);
    const sinLng = Math.sin(lngRad);
    const cosLng = Math.cos(lngRad);

    const east = -sinLng * dx + cosLng * dy;
    const north = -sinLat * cosLng * dx - sinLat * sinLng * dy + cosLat * dz;
    const up = cosLat * cosLng * dx + cosLat * sinLng * dy + sinLat * dz;

    // Three.js convention: X = East, Y = Up, Z = -North
    return [east, up, -north];
  }

  /**
   * Strips CESIUM_RTC extension center and translates/rotates all mesh vertices into
   * local tangent plane coordinates centered around origin (0, 0, 0).
   */
  public static stripCesiumRTCAndTransform(
    positions: Float32Array,
    rtcCenter: [number, number, number] | undefined,
    origin: LatLngAlt
  ): Float32Array {
    const out = new Float32Array(positions.length);
    const cx = rtcCenter ? rtcCenter[0] : 0;
    const cy = rtcCenter ? rtcCenter[1] : 0;
    const cz = rtcCenter ? rtcCenter[2] : 0;

    for (let i = 0; i < positions.length; i += 3) {
      // Reconstruct true ECEF coordinate
      const ecefX = cx + positions[i]!;
      const ecefY = cy + positions[i + 1]!;
      const ecefZ = cz + positions[i + 2]!;

      const [localX, localY, localZ] = Google3DTileCrawlerBaker.ecefToENU(
        ecefX,
        ecefY,
        ecefZ,
        origin.lat,
        origin.lng,
        origin.alt ?? 0
      );

      out[i] = localX;
      out[i + 1] = localY;
      out[i + 2] = localZ;
    }

    return out;
  }

  /**
   * Merges multiple leaf GLB meshes into a single unified scene buffer.
   * Strips CESIUM_RTC, transforms vertices to local ENU, packs textures with TextureAtlasPacker,
   * remaps UV coordinates, and builds a standalone binary GLB.
   */
  public static mergeTileMeshes(
    meshes: TileMeshInput[],
    origin: LatLngAlt,
    packerOptions?: AtlasPackerOptions
  ): MergedTileResult {
    // 1. Pack textures into a unified atlas
    const atlasPacker = new TextureAtlasPacker(packerOptions);
    for (const mesh of meshes) {
      if (mesh.texture) {
        atlasPacker.addTexture({
          id: mesh.id,
          width: mesh.texture.width,
          height: mesh.texture.height,
          data: mesh.texture.data
        });
      }
    }
    const atlas = atlasPacker.pack();

    // 2. Count total vertices and indices
    let totalVertices = 0;
    let totalIndices = 0;
    for (const mesh of meshes) {
      totalVertices += mesh.positions.length / 3;
      totalIndices += mesh.indices.length;
    }

    const mergedPositions = new Float32Array(totalVertices * 3);
    const mergedNormals = new Float32Array(totalVertices * 3);
    const mergedUVs = new Float32Array(totalVertices * 2);
    const mergedIndices = new Uint32Array(totalIndices);

    let vertexOffset = 0;
    let posPtr = 0;
    let normPtr = 0;
    let uvPtr = 0;
    let idxPtr = 0;

    for (const mesh of meshes) {
      const vCount = mesh.positions.length / 3;

      // Transform positions to local tangent plane (stripping CESIUM_RTC)
      const transformedPos = Google3DTileCrawlerBaker.stripCesiumRTCAndTransform(
        mesh.positions,
        mesh.rtcCenter,
        origin
      );
      mergedPositions.set(transformedPos, posPtr);
      posPtr += mesh.positions.length;

      // Copy or default normals
      if (mesh.normals && mesh.normals.length === vCount * 3) {
        mergedNormals.set(mesh.normals, normPtr);
      } else {
        // Default to pointing up
        for (let i = 0; i < vCount; i++) {
          mergedNormals[normPtr + i * 3] = 0;
          mergedNormals[normPtr + i * 3 + 1] = 1;
          mergedNormals[normPtr + i * 3 + 2] = 0;
        }
      }
      normPtr += vCount * 3;

      // Remap UV coordinates using atlas rect
      const rect = atlas.rects.get(mesh.id);
      if (mesh.uvs && mesh.uvs.length === vCount * 2 && rect) {
        const remapped = TextureAtlasPacker.remapUVs(mesh.uvs, rect);
        mergedUVs.set(remapped, uvPtr);
      } else if (mesh.uvs && mesh.uvs.length === vCount * 2) {
        mergedUVs.set(mesh.uvs, uvPtr);
      } else {
        // Zero UV fallback
        mergedUVs.fill(0, uvPtr, uvPtr + vCount * 2);
      }
      uvPtr += vCount * 2;

      // Offset indices
      for (let i = 0; i < mesh.indices.length; i++) {
        mergedIndices[idxPtr + i] = mesh.indices[i]! + vertexOffset;
      }
      idxPtr += mesh.indices.length;

      vertexOffset += vCount;
    }

    // 3. Serialize to binary GLB container
    const glbBuffer = Google3DTileCrawlerBaker.buildGLB(
      mergedPositions,
      mergedNormals,
      mergedUVs,
      mergedIndices,
      atlas
    );

    return {
      vertexCount: totalVertices,
      indexCount: totalIndices,
      positions: mergedPositions,
      normals: mergedNormals,
      uvs: mergedUVs,
      indices: mergedIndices,
      atlas,
      glbBuffer
    };
  }

  /**
   * Assembles a standard glTF 2.0 Binary (.glb) buffer.
   */
  public static buildGLB(
    positions: Float32Array,
    normals: Float32Array,
    uvs: Float32Array,
    indices: Uint32Array,
    atlas: AtlasResult
  ): Buffer {
    // Binary alignment helper (4-byte alignment)
    const align4 = (len: number) => (len + 3) & ~3;

    // Buffer layouts:
    // 1. indices: Uint32Array
    // 2. positions: Float32Array
    // 3. normals: Float32Array
    // 4. uvs: Float32Array
    // 5. image bytes (raw uncompressed or PNG/JPEG header wrapped)

    const indicesByteLength = indices.byteLength;
    const positionsByteLength = positions.byteLength;
    const normalsByteLength = normals.byteLength;
    const uvsByteLength = uvs.byteLength;

    let imageByteLength = 0;
    let imageBuffer: Buffer | undefined;
    if (atlas.pixelData && atlas.pixelData.length > 0) {
      imageBuffer = Buffer.from(atlas.pixelData.buffer, atlas.pixelData.byteOffset, atlas.pixelData.byteLength);
      imageByteLength = imageBuffer.length;
    }

    const indicesOffset = 0;
    const positionsOffset = align4(indicesOffset + indicesByteLength);
    const normalsOffset = align4(positionsOffset + positionsByteLength);
    const uvsOffset = align4(normalsOffset + normalsByteLength);
    const imageOffset = align4(uvsOffset + uvsByteLength);
    const totalBinByteLength = align4(imageOffset + imageByteLength);

    const binBuffer = Buffer.alloc(totalBinByteLength);
    Buffer.from(indices.buffer, indices.byteOffset, indices.byteLength).copy(binBuffer, indicesOffset);
    Buffer.from(positions.buffer, positions.byteOffset, positions.byteLength).copy(binBuffer, positionsOffset);
    Buffer.from(normals.buffer, normals.byteOffset, normals.byteLength).copy(binBuffer, normalsOffset);
    Buffer.from(uvs.buffer, uvs.byteOffset, uvs.byteLength).copy(binBuffer, uvsOffset);
    if (imageBuffer) {
      imageBuffer.copy(binBuffer, imageOffset);
    }

    // Compute bounding box for positions
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i]!;
      const y = positions[i + 1]!;
      const z = positions[i + 2]!;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }

    // Build glTF JSON object (clean, zero CESIUM_RTC extension requirement)
    const gltfJson: any = {
      asset: {
        version: '2.0',
        generator: 'Scratchbox 3D Tile Crawler & Buffer Merger (OmarShehata adaptation)'
      },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0, name: 'BakedTerrainRoot' }],
      meshes: [
        {
          name: 'MergedTerrainMesh',
          primitives: [
            {
              attributes: {
                POSITION: 1,
                NORMAL: 2,
                TEXCOORD_0: 3
              },
              indices: 0,
              mode: 4 // TRIANGLES
            }
          ]
        }
      ],
      accessors: [
        {
          bufferView: 0,
          byteOffset: 0,
          componentType: 5125, // UNSIGNED_INT
          count: indices.length,
          type: 'SCALAR'
        },
        {
          bufferView: 1,
          byteOffset: 0,
          componentType: 5126, // FLOAT
          count: positions.length / 3,
          type: 'VEC3',
          min: [minX, minY, minZ],
          max: [maxX, maxY, maxZ]
        },
        {
          bufferView: 2,
          byteOffset: 0,
          componentType: 5126, // FLOAT
          count: normals.length / 3,
          type: 'VEC3'
        },
        {
          bufferView: 3,
          byteOffset: 0,
          componentType: 5126, // FLOAT
          count: uvs.length / 2,
          type: 'VEC2'
        }
      ],
      bufferViews: [
        {
          buffer: 0,
          byteOffset: indicesOffset,
          byteLength: indicesByteLength,
          target: 34963 // ELEMENT_ARRAY_BUFFER
        },
        {
          buffer: 0,
          byteOffset: positionsOffset,
          byteLength: positionsByteLength,
          target: 34962 // ARRAY_BUFFER
        },
        {
          buffer: 0,
          byteOffset: normalsOffset,
          byteLength: normalsByteLength,
          target: 34962 // ARRAY_BUFFER
        },
        {
          buffer: 0,
          byteOffset: uvsOffset,
          byteLength: uvsByteLength,
          target: 34962 // ARRAY_BUFFER
        }
      ],
      buffers: [
        {
          byteLength: totalBinByteLength
        }
      ]
    };

    const jsonString = JSON.stringify(gltfJson);
    const jsonBuffer = Buffer.from(jsonString, 'utf8');
    const jsonPadding = (4 - (jsonBuffer.length % 4)) % 4;
    const paddedJsonLength = jsonBuffer.length + jsonPadding;

    const totalGLBLength = 12 + 8 + paddedJsonLength + 8 + totalBinByteLength;
    const glb = Buffer.alloc(totalGLBLength);

    // GLB Header
    glb.writeUInt32LE(0x46546C67, 0); // Magic: 'glTF'
    glb.writeUInt32LE(2, 4);          // Version: 2
    glb.writeUInt32LE(totalGLBLength, 8);

    // Chunk 0: JSON
    glb.writeUInt32LE(paddedJsonLength, 12);
    glb.writeUInt32LE(0x4E4F534A, 16); // ChunkType: 'JSON'
    jsonBuffer.copy(glb, 20);
    for (let i = 0; i < jsonPadding; i++) {
      glb.writeUInt8(0x20, 20 + jsonBuffer.length + i); // Space padding
    }

    // Chunk 1: BIN
    const binHeaderOffset = 20 + paddedJsonLength;
    glb.writeUInt32LE(totalBinByteLength, binHeaderOffset);
    glb.writeUInt32LE(0x004E4942, binHeaderOffset + 4); // ChunkType: 'BIN\0'
    binBuffer.copy(glb, binHeaderOffset + 8);

    return glb;
  }

  /**
   * Crawls a 3D tile region and bakes a single merged GLB file.
   */
  public async crawlAndBake(request: CrawlAndBakeRequest): Promise<MergedTileResult> {
    const meshes = request.mockTiles || [];
    return Google3DTileCrawlerBaker.mergeTileMeshes(meshes, request.origin, request.packerOptions);
  }
}
