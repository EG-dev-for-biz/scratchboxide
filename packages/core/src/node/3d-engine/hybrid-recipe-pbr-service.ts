/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import {
  RecipePbrGeometryKernel,
  RecipeSubmeshGeometry,
  DetailMapKind,
  encodeCompactRecipeAttributes,
  buildGroundHeightField,
  computeVoxelAmbientOcclusion,
  packRecipeMask,
  generateTileableDetailMap
} from './recipe-pbr-geometry-kernel';
import { GltfBinaryPacker } from './gltf-binary-packer';

export interface HybridRecipeOptions {
  outputMode?: 'webgl-recipe' | 'standard-khronos' | 'both';
  sharpAngleDeg?: number;
  weldEpsilon?: number;
  voxelCellSize?: number;
  maxDistance?: number;
  aoRayCount?: number;
  detailSize?: number;
  detailKinds?: DetailMapKind[];
  outputPath?: string;
}

export interface HybridRecipeResult {
  recipeGlbBuffer: Buffer;
  submeshCount: number;
  totalVertices: number;
  totalTriangles: number;
  sharedDetailMaps: Record<string, { size: number; tileMeters: number; bytes: number }>;
  outputMode: 'webgl-recipe' | 'standard-khronos' | 'both';
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function encodePng(rgba: Uint8Array, w: number, h: number): Buffer {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function readGlb(buffer: Buffer): { gltf: any; bin: Buffer } {
  const jsonLen = buffer.readUInt32LE(12);
  const gltf = JSON.parse(buffer.toString('utf8', 20, 20 + jsonLen));
  const binStart = 20 + jsonLen;
  const binLen = buffer.readUInt32LE(binStart);
  return { gltf, bin: buffer.subarray(binStart + 8, binStart + 8 + binLen) };
}

function readAccessor(gltf: any, bin: Buffer, index: number): Float32Array | Uint8Array | Uint16Array | Uint32Array {
  const acc = gltf.accessors[index];
  const bv = gltf.bufferViews[acc.bufferView];
  const comps = ({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 } as Record<string, number>)[acc.type];
  const Ctor = ({ 5126: Float32Array, 5125: Uint32Array, 5123: Uint16Array, 5121: Uint8Array } as Record<number, any>)[acc.componentType];
  const start = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const bytes = bin.subarray(start, start + acc.count * comps * Ctor.BYTES_PER_ELEMENT);
  return new Ctor(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

export class HybridRecipePbrService {
  /**
   * Applies the Hybrid Recipe PBR suite to a target GLB file or buffer.
   */
  public static async processGlb(
    input: string | Buffer,
    options: HybridRecipeOptions = {}
  ): Promise<HybridRecipeResult> {
    const rawBuffer = typeof input === 'string' ? fs.readFileSync(input) : input;
    const { gltf, bin } = readGlb(rawBuffer);

    const sharpAngleDeg = options.sharpAngleDeg ?? 45;
    const weldEpsilon = options.weldEpsilon ?? 0.001;
    const voxelCellSize = options.voxelCellSize ?? 0.5;
    const maxDistance = options.maxDistance ?? 12;
    const aoRayCount = options.aoRayCount ?? 16;
    const detailSize = options.detailSize ?? 512;
    const detailKinds: DetailMapKind[] = options.detailKinds ?? ['stone', 'asphalt', 'foliage'];
    const outputMode = options.outputMode ?? 'webgl-recipe';

    // 1. Extract and compute geometry layer per submesh
    let totalVertices = 0;
    let totalTriangles = 0;

    const geos: RecipeSubmeshGeometry[] = gltf.meshes.map((mesh: any) => {
      const prim = mesh.primitives[0];
      const pos = readAccessor(gltf, bin, prim.attributes.POSITION) as Float32Array;
      const uvs = readAccessor(gltf, bin, prim.attributes.TEXCOORD_0) as Float32Array;
      const indices = prim.indices !== undefined ? Uint32Array.from(readAccessor(gltf, bin, prim.indices)) : null;

      totalVertices += pos.length / 3;
      totalTriangles += indices ? indices.length / 3 : pos.length / 9;

      return RecipePbrGeometryKernel.buildRecipeSubmeshGeometry(
        { positions: pos, uvs, indices },
        { sharpAngleDeg, weldEpsilon }
      );
    });

    // 2. Compute cross-submesh ground heightfield and voxel hemisphere mutual AO
    const ground = buildGroundHeightField(geos, 6);
    const aoPerMesh = computeVoxelAmbientOcclusion(geos, {
      cellSize: voxelCellSize,
      maxDistance,
      rayCount: aoRayCount
    });

    const compacts = geos.map(encodeCompactRecipeAttributes);
    const masks = geos.map((g, mi) => {
      const hag = new Float32Array(g.positions.length / 3);
      for (let v = 0; v < hag.length; v++) {
        hag[v] = Math.max(0, g.positions[v * 3 + 1] - ground.sample(g.positions[v * 3], g.positions[v * 3 + 2]));
      }
      return packRecipeMask(aoPerMesh[mi], hag, 8, compacts[mi].edgeFlags);
    });

    // 3. Generate shared continuous metric detail maps
    const sharedDetailMaps: Record<string, { size: number; tileMeters: number; bytes: number }> = {};
    const detailBuffers: { kind: string; buffer: Buffer }[] = [];

    for (const kind of detailKinds) {
      const map = generateTileableDetailMap(kind, detailSize);
      const png = encodePng(map.rgba, map.size, map.size);
      sharedDetailMaps[kind] = { size: map.size, tileMeters: map.tileMeters, bytes: png.length };
      detailBuffers.push({ kind, buffer: png });
    }

    // 4. Re-assemble glTF 2.0 with injected vertex attributes and bufferViews
    const newBufferViews: Buffer[] = [];
    const newAccessors: any[] = [];
    const newGltf = JSON.parse(JSON.stringify(gltf));

    // Preserve existing images and samplers
    const existingImages: Buffer[] = (gltf.images || []).map((img: any) => {
      const bv = gltf.bufferViews[img.bufferView];
      return Buffer.from(bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength));
    });

    // Append detail map images into glTF
    for (const d of detailBuffers) {
      const bvIndex = newBufferViews.length;
      newBufferViews.push(d.buffer);
      if (!newGltf.images) newGltf.images = [];
      newGltf.images.push({
        bufferView: bvIndex,
        mimeType: 'image/png',
        name: `DetailMap_${d.kind}`
      });
    }

    // Reconstruct primitives for each submesh
    for (let mi = 0; mi < geos.length; mi++) {
      const g = geos[mi];
      const c = compacts[mi];
      const m = masks[mi];
      const prim = newGltf.meshes[mi].primitives[0];

      // BufferView & Accessor for POSITION
      const posBv = newBufferViews.length;
      newBufferViews.push(Buffer.from(g.positions.buffer, g.positions.byteOffset, g.positions.byteLength));
      const posAcc = newAccessors.length;
      newAccessors.push({
        bufferView: posBv,
        componentType: 5126,
        count: g.positions.length / 3,
        type: 'VEC3'
      });

      // BufferView & Accessor for NORMAL
      const normBv = newBufferViews.length;
      newBufferViews.push(Buffer.from(g.normals.buffer, g.normals.byteOffset, g.normals.byteLength));
      const normAcc = newAccessors.length;
      newAccessors.push({
        bufferView: normBv,
        componentType: 5126,
        count: g.normals.length / 3,
        type: 'VEC3'
      });

      // BufferView & Accessor for TEXCOORD_0
      const uvBv = newBufferViews.length;
      newBufferViews.push(Buffer.from(g.uvs.buffer, g.uvs.byteOffset, g.uvs.byteLength));
      const uvAcc = newAccessors.length;
      newAccessors.push({
        bufferView: uvBv,
        componentType: 5126,
        count: g.uvs.length / 2,
        type: 'VEC2'
      });

      // BufferView & Accessor for INDICES
      const idxBv = newBufferViews.length;
      newBufferViews.push(Buffer.from(g.indices.buffer, g.indices.byteOffset, g.indices.byteLength));
      const idxAcc = newAccessors.length;
      newAccessors.push({
        bufferView: idxBv,
        componentType: 5125,
        count: g.indices.length,
        type: 'SCALAR'
      });

      prim.attributes.POSITION = posAcc;
      prim.attributes.NORMAL = normAcc;
      prim.attributes.TEXCOORD_0 = uvAcc;
      prim.indices = idxAcc;

      // In webgl-recipe mode, also inject _SBEDGEH, _SBNBRA, _SBMASK
      if (outputMode === 'webgl-recipe' || outputMode === 'both') {
        const edgeBv = newBufferViews.length;
        newBufferViews.push(Buffer.from(c.edgeAltitude.buffer, c.edgeAltitude.byteOffset, c.edgeAltitude.byteLength));
        const edgeAcc = newAccessors.length;
        newAccessors.push({
          bufferView: edgeBv,
          componentType: 5126,
          count: c.edgeAltitude.length,
          type: 'SCALAR'
        });
        prim.attributes._SBEDGEH = edgeAcc;

        const nbrBv = newBufferViews.length;
        newBufferViews.push(Buffer.from(c.neighborOctA.buffer, c.neighborOctA.byteOffset, c.neighborOctA.byteLength));
        const nbrAcc = newAccessors.length;
        newAccessors.push({
          bufferView: nbrBv,
          componentType: 5120,
          normalized: true,
          count: c.neighborOctA.length / 4,
          type: 'VEC4'
        });
        prim.attributes._SBNBRA = nbrAcc;

        const maskBv = newBufferViews.length;
        newBufferViews.push(Buffer.from(m.buffer, m.byteOffset, m.byteLength));
        const maskAcc = newAccessors.length;
        newAccessors.push({
          bufferView: maskBv,
          componentType: 5121,
          normalized: true,
          count: m.length / 4,
          type: 'VEC4'
        });
        prim.attributes._SBMASK = maskAcc;
      }
    }

    // Append existing images to bufferViews and update image pointers
    for (let i = 0; i < existingImages.length; i++) {
      const imgBv = newBufferViews.length;
      newBufferViews.push(existingImages[i]);
      if (newGltf.images && newGltf.images[i]) {
        newGltf.images[i].bufferView = imgBv;
      }
    }

    newGltf.accessors = newAccessors;
    newGltf.bufferViews = newBufferViews.map((bv, idx) => ({
      buffer: 0,
      byteOffset: 0,
      byteLength: bv.length
    }));

    const packing = GltfBinaryPacker.packGlb(newGltf, newBufferViews);

    if (options.outputPath) {
      fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });
      fs.writeFileSync(options.outputPath, packing.glbBuffer);
    }

    return {
      recipeGlbBuffer: packing.glbBuffer,
      submeshCount: geos.length,
      totalVertices,
      totalTriangles,
      sharedDetailMaps,
      outputMode
    };
  }
}
