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
import {
  MetricBoundingBox,
  UniversalSurfaceMesh,
  UniversalCollisionHull,
  CollisionEnvelopeOptions,
  VideoDiffusionCameraBlockout,
  Target3DFormat,
  Universal3DStructureInitOptions,
  MultiFormatExportResult,
  UniversalPbrMaterial,
  UniversalTextureMap,
  UniversalTextureType,
  MaterialPresetName,
  PbrAlphaMode
} from '../../common/spatial/universal-3d-structure-types';
import {
  UniversalAnimationClip,
  UniversalAnimationTrack,
  toCameraSolveTrack,
  fromCameraSolveTrack,
  fromVideoDiffusionCameraBlockout
} from '../../common/spatial/universal-animation-types';
import type { CameraSolveTrack } from '../../common/vfx-plate-protocol';
import {
  ProceduralSfMDatasetService,
  ProceduralCameraPose,
  ProceduralPoint3D,
  Vector3Tuple
} from './ProceduralSfMDatasetService';
import { GeodeticAnchor } from '../../common/spatial/colmap-vector-reference-types';
import { LocalTangentPlane } from '../../common/coordinate/LocalTangentPlane';
import { decodePng, encodePng, synthesizeProceduralPbr } from '../texture-processing';
import { ContinuousBiophysicalFields } from '../../common/adaptive-material-types';
import {
  buildBabylonianZigguratStructure,
  buildAlpineMatterhornStructure
} from './ComplexProcedural3DGenerator';
import {
  UniversalArchiBridgeService,
  SupportedArchiTypology,
  ARCHI_TYPOLOGY_ADAPTERS
} from './UniversalArchiBridgeService';
import * as THREE from 'three';
import type { Scene3DData } from '../../browser/generative-canvas/canvas-types';

/**
 * Universal 3D Structure Foundation
 *
 * The single canonical source of truth for 3D spatial structure.
 * Maintains metric ground-truth geometry, surface constellations, and calibrated camera rigs,
 * with deterministic adapters projecting into any downstream 3D format:
 * - GLB / glTF 2.0 (Viewports, Three.js, Unreal, Blender)
 * - COLMAP (Photogrammetry, GLOMAP, bundle adjustment)
 * - Nerfstudio (3D Gaussian Splatting, NeRF, Splatfacto)
 * - Video Diffusion Blockouts (<VIDEO_REF_0>, Google Omni 1.1, Veo, Sora)
 * - Collision & Navigation Hulls (Physics engines, obstacle avoidance)
 * - WGS-84 RFC 7946 GeoJSON (GIS, Google Maps Platform)
 */
export class Universal3DStructureFoundation {
  public readonly id: string;
  public readonly name: string;
  public readonly anchor?: GeodeticAnchor;
  public readonly mesh: UniversalSurfaceMesh;
  public readonly materials: UniversalPbrMaterial[];
  public readonly textures: UniversalTextureMap[];
  public readonly points: ProceduralPoint3D[];
  public readonly cameras: ProceduralCameraPose[];
  public readonly boundingBox: MetricBoundingBox;
  public readonly collisionHull: UniversalCollisionHull;
  public animations: UniversalAnimationClip[];
  public readonly tags: string[];
  public readonly metadata: Record<string, any>;

  private _decodedTextureCache: Map<string, { width: number; height: number; rgba: Buffer }> = new Map();

  constructor(options: Universal3DStructureInitOptions) {
    this.id = options.id || `struct_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    this.name = options.name || 'Universal_3D_Structure';
    this.anchor = options.anchor;
    this.mesh = options.mesh || {
      vertices: new Float32Array(),
      triangleCount: 0,
      vertexCount: 0
    };
    this.materials = options.materials && options.materials.length > 0
      ? [...options.materials]
      : [options.material || Universal3DStructureFoundation.createDefaultPbrMaterial()];
    this.textures = options.textures ? [...options.textures] : [];
    this.points = options.points ? [...options.points] : [];
    this.cameras = options.cameras || [];
    this.boundingBox = options.boundingBox || Universal3DStructureFoundation.computeBoundingBox(this.mesh);
    this.collisionHull = options.collisionHull || this.computeCollisionEnvelope({ mode: 'obb' });
    this.animations = options.animations ? [...options.animations] : [];
    this.tags = options.tags || ['3d-structure', 'canonical-anchor'];
    this.metadata = options.metadata || {};
  }

  /**
   * Adds an animation clip to this structure.
   */
  public addAnimation(clip: UniversalAnimationClip): void {
    this.animations.push(clip);
  }

  /**
   * Converts the structure's primary camera animation or camera poses into a standard CameraSolveTrack.
   */
  public toCameraSolveTrack(clipIndexOrName?: number | string): CameraSolveTrack | undefined {
    let clip: UniversalAnimationClip | undefined;
    if (typeof clipIndexOrName === 'number') {
      clip = this.animations[clipIndexOrName];
    } else if (typeof clipIndexOrName === 'string') {
      clip = this.animations.find(c => c.id === clipIndexOrName || c.name === clipIndexOrName);
    } else if (this.animations.length > 0) {
      clip = this.animations.find(c => c.tracks.some(t => t.targetNodeId === 'camera' || t.property === 'translation')) || this.animations[0];
    }

    if (clip) {
      return toCameraSolveTrack(clip, { id: `solve_${this.id}`, name: clip.name ? `${this.name} - ${clip.name}` : `${this.name} Camera Solve` });
    }

    // If no explicit clip exists but videoBlockout or cameras exist, construct clip from blockout
    const blockout = this.toVideoCameraBlockout();
    if (blockout && blockout.frames.length > 0) {
      const derivedClip = fromVideoDiffusionCameraBlockout(blockout);
      return toCameraSolveTrack(derivedClip, { id: `solve_${this.id}`, name: `${this.name} Camera Solve` });
    }

    return undefined;
  }

  /**
   * Primary physical material assigned to this structure.
   */
  public get primaryMaterial(): UniversalPbrMaterial {
    return this.materials[0] || Universal3DStructureFoundation.createDefaultPbrMaterial();
  }

  /**
   * Factory: Create standard neutral PBR material.
   */
  public static createDefaultPbrMaterial(name: string = 'default_material'): UniversalPbrMaterial {
    return {
      name,
      baseColorFactor: [1.0, 1.0, 1.0, 1.0],
      metallicFactor: 0.1,
      roughnessFactor: 0.5,
      emissiveFactor: [0, 0, 0],
      ior: 1.5,
      doubleSided: false,
      alphaMode: 'OPAQUE'
    };
  }

  /**
   * Factory: Get physical material preset grounded in C++20 Astra 3D Engine parameters.
   */
  public static getMaterialPreset(preset: MaterialPresetName): UniversalPbrMaterial {
    switch (preset) {
      case 'titanium':
        return {
          name: 'brushed_titanium',
          baseColorFactor: [0.75, 0.77, 0.82, 1.0],
          metallicFactor: 0.95,
          roughnessFactor: 0.22,
          ior: 2.16
        };
      case 'gold':
        return {
          name: 'polished_gold',
          baseColorFactor: [1.0, 0.84, 0.0, 1.0],
          metallicFactor: 0.95,
          roughnessFactor: 0.15,
          ior: 1.35
        };
      case 'chrome':
        return {
          name: 'polished_chrome',
          baseColorFactor: [0.96, 0.97, 0.99, 1.0],
          metallicFactor: 0.98,
          roughnessFactor: 0.06,
          ior: 2.97
        };
      case 'basalt':
        return {
          name: 'volcanic_basalt',
          baseColorFactor: [0.18, 0.17, 0.19, 1.0],
          metallicFactor: 0.05,
          roughnessFactor: 0.88,
          ior: 1.54
        };
      case 'oak':
        return {
          name: 'procedural_oak',
          baseColorFactor: [0.42, 0.28, 0.16, 1.0],
          metallicFactor: 0.02,
          roughnessFactor: 0.82,
          ior: 1.50
        };
      case 'concrete':
        return {
          name: 'architectural_concrete',
          baseColorFactor: [0.65, 0.65, 0.63, 1.0],
          metallicFactor: 0.05,
          roughnessFactor: 0.75,
          ior: 1.52
        };
      case 'clay':
        return {
          name: 'studio_clay_blockout',
          baseColorFactor: [0.86, 0.84, 0.80, 1.0],
          metallicFactor: 0.02,
          roughnessFactor: 0.82,
          ior: 1.50
        };
      case 'default':
      default:
        return Universal3DStructureFoundation.createDefaultPbrMaterial();
    }
  }

  /**
   * Internal helper: Decodes texture map into RGBA pixel buffer and caches it.
   */
  private getDecodedTexture(tex: UniversalTextureMap): { width: number; height: number; rgba: Buffer } | null {
    if (this._decodedTextureCache.has(tex.id)) {
      return this._decodedTextureCache.get(tex.id)!;
    }

    try {
      if (tex.mimeType === 'image/png') {
        const decoded = decodePng(tex.buffer);
        const res = { width: decoded.width, height: decoded.height, rgba: decoded.rgba };
        this._decodedTextureCache.set(tex.id, res);
        return res;
      } else if (tex.mimeType === 'image/raw') {
        const res = { width: tex.width, height: tex.height, rgba: tex.buffer };
        this._decodedTextureCache.set(tex.id, res);
        return res;
      }
    } catch {
      // Decode fallback
    }
    return null;
  }

  /**
   * Samples the base color / albedo at UV coordinate (u, v) using bilinear filtering.
   * Returns [R, G, B] in [0, 255] integer range.
   */
  public sampleAlbedoAtUv(u: number, v: number): [number, number, number] {
    const mat = this.primaryMaterial;
    const factor = mat.baseColorFactor || [1, 1, 1, 1];
    const tex = this.textures.find(t => t.id === mat.baseColorTextureId || t.type === 'albedo');

    if (!tex) {
      return [
        Math.round(Math.min(255, Math.max(0, factor[0] * 255))),
        Math.round(Math.min(255, Math.max(0, factor[1] * 255))),
        Math.round(Math.min(255, Math.max(0, factor[2] * 255)))
      ];
    }

    const decoded = this.getDecodedTexture(tex);
    if (!decoded || decoded.width === 0 || decoded.height === 0) {
      return [
        Math.round(Math.min(255, Math.max(0, factor[0] * 255))),
        Math.round(Math.min(255, Math.max(0, factor[1] * 255))),
        Math.round(Math.min(255, Math.max(0, factor[2] * 255)))
      ];
    }

    // Wrap UV coordinates to [0, 1)
    let uu = u % 1.0;
    if (uu < 0) uu += 1.0;
    let vv = v % 1.0;
    if (vv < 0) vv += 1.0;

    const W = decoded.width;
    const H = decoded.height;
    const px = uu * (W - 1);
    const py = vv * (H - 1);

    const x0 = Math.floor(px);
    const y0 = Math.floor(py);
    const x1 = Math.min(W - 1, x0 + 1);
    const y1 = Math.min(H - 1, y0 + 1);

    const fx = px - x0;
    const fy = py - y0;

    const idx00 = (y0 * W + x0) * 4;
    const idx10 = (y0 * W + x1) * 4;
    const idx01 = (y1 * W + x0) * 4;
    const idx11 = (y1 * W + x1) * 4;

    const rgba = decoded.rgba;
    const r = (1 - fx) * (1 - fy) * rgba[idx00] + fx * (1 - fy) * rgba[idx10] + (1 - fx) * fy * rgba[idx01] + fx * fy * rgba[idx11];
    const g = (1 - fx) * (1 - fy) * rgba[idx00 + 1] + fx * (1 - fy) * rgba[idx10 + 1] + (1 - fx) * fy * rgba[idx01 + 1] + fx * fy * rgba[idx11 + 1];
    const b = (1 - fx) * (1 - fy) * rgba[idx00 + 2] + fx * (1 - fy) * rgba[idx10 + 2] + (1 - fx) * fy * rgba[idx01 + 2] + fx * fy * rgba[idx11 + 2];

    return [
      Math.round(Math.min(255, Math.max(0, r * factor[0]))),
      Math.round(Math.min(255, Math.max(0, g * factor[1]))),
      Math.round(Math.min(255, Math.max(0, b * factor[2])))
    ];
  }

  /**
   * Samples physical ORM (Occlusion, Roughness, Metallic) at UV coordinate (u, v).
   * Values returned in normalized [0, 1] range.
   */
  public sampleOrmAtUv(u: number, v: number): { occlusion: number; roughness: number; metallic: number } {
    const mat = this.primaryMaterial;
    const baseRoughness = mat.roughnessFactor ?? 0.5;
    const baseMetallic = mat.metallicFactor ?? 0.1;
    const tex = this.textures.find(t => t.id === mat.metallicRoughnessTextureId || t.type === 'metallicRoughness');

    if (!tex) {
      return { occlusion: 1.0, roughness: baseRoughness, metallic: baseMetallic };
    }

    const decoded = this.getDecodedTexture(tex);
    if (!decoded || decoded.width === 0 || decoded.height === 0) {
      return { occlusion: 1.0, roughness: baseRoughness, metallic: baseMetallic };
    }

    let uu = u % 1.0;
    if (uu < 0) uu += 1.0;
    let vv = v % 1.0;
    if (vv < 0) vv += 1.0;

    const W = decoded.width;
    const H = decoded.height;
    const px = Math.min(W - 1, Math.max(0, Math.floor(uu * (W - 1))));
    const py = Math.min(H - 1, Math.max(0, Math.floor(vv * (H - 1))));
    const idx = (py * W + px) * 4;

    const ao = (decoded.rgba[idx] ?? 255) / 255.0;
    const rough = ((decoded.rgba[idx + 1] ?? 128) / 255.0) * baseRoughness;
    const metal = ((decoded.rgba[idx + 2] ?? 25) / 255.0) * baseMetallic;

    return {
      occlusion: Math.min(1.0, Math.max(0.0, ao)),
      roughness: Math.min(1.0, Math.max(0.04, rough)),
      metallic: Math.min(1.0, Math.max(0.0, metal))
    };
  }

  /**
   * Attaches or replaces physical material and textures on this structure,
   * automatically resynchronizing surface point constellation properties.
   */
  public attachPbrMaterial(
    material: UniversalPbrMaterial,
    textures?: UniversalTextureMap[],
    options?: { resyncPoints?: boolean; pointDensity?: number }
  ): this {
    this.materials.length = 0;
    this.materials.push(material);
    if (textures) {
      this.textures.length = 0;
      this.textures.push(...textures);
      this._decodedTextureCache.clear();
    }
    if (options?.resyncPoints !== false) {
      this.resynchronizePoints(options?.pointDensity);
    }
    return this;
  }

  /**
   * Resynchronizes surface points with the mesh geometry and PBR texture maps.
   * Points receive exact sampled RGB albedo colors, physical roughness, and metallicity.
   */
  public resynchronizePoints(density?: number): ProceduralPoint3D[] {
    const mesh = this.mesh;
    if (!mesh.vertices || mesh.vertices.length < 9) {
      return this.points;
    }

    const count = density ?? Math.max(this.points.length, 1000);
    const vertices = mesh.vertices;
    const indices = mesh.indices;
    const normals = mesh.normals;
    const uvs = mesh.uvs;

    const numTriangles = mesh.triangleCount || (indices ? indices.length / 3 : vertices.length / 9);
    const newPoints: ProceduralPoint3D[] = [];

    // Precompute cumulative surface areas for area-weighted sampling
    const triAreas = new Float64Array(numTriangles);
    let totalArea = 0;

    for (let t = 0; t < numTriangles; t++) {
      const i0 = indices ? indices[t * 3] : t * 3;
      const i1 = indices ? indices[t * 3 + 1] : t * 3 + 1;
      const i2 = indices ? indices[t * 3 + 2] : t * 3 + 2;

      const p0x = vertices[i0 * 3], p0y = vertices[i0 * 3 + 1], p0z = vertices[i0 * 3 + 2];
      const p1x = vertices[i1 * 3], p1y = vertices[i1 * 3 + 1], p1z = vertices[i1 * 3 + 2];
      const p2x = vertices[i2 * 3], p2y = vertices[i2 * 3 + 1], p2z = vertices[i2 * 3 + 2];

      const ax = p1x - p0x, ay = p1y - p0y, az = p1z - p0z;
      const bx = p2x - p0x, by = p2y - p0y, bz = p2z - p0z;
      const cx = ay * bz - az * by;
      const cy = az * bx - ax * bz;
      const cz = ax * by - ay * bx;
      const area = 0.5 * Math.hypot(cx, cy, cz);
      totalArea += area;
      triAreas[t] = totalArea;
    }

    if (totalArea <= 1e-9) {
      totalArea = 1.0;
    }

    for (let i = 0; i < count; i++) {
      const targetArea = Math.random() * totalArea;
      let triIdx = 0;
      let low = 0, high = numTriangles - 1;
      while (low <= high) {
        const mid = (low + high) >> 1;
        if (triAreas[mid] >= targetArea) {
          triIdx = mid;
          high = mid - 1;
        } else {
          low = mid + 1;
        }
      }

      const i0 = indices ? indices[triIdx * 3] : triIdx * 3;
      const i1 = indices ? indices[triIdx * 3 + 1] : triIdx * 3 + 1;
      const i2 = indices ? indices[triIdx * 3 + 2] : triIdx * 3 + 2;

      // Uniform barycentric coordinates
      const r1 = Math.random();
      const r2 = Math.random();
      const sqrtR1 = Math.sqrt(r1);
      const w0 = 1.0 - sqrtR1;
      const w1 = sqrtR1 * (1.0 - r2);
      const w2 = sqrtR1 * r2;

      // Interpolate position
      const px = w0 * vertices[i0 * 3] + w1 * vertices[i1 * 3] + w2 * vertices[i2 * 3];
      const py = w0 * vertices[i0 * 3 + 1] + w1 * vertices[i1 * 3 + 1] + w2 * vertices[i2 * 3 + 1];
      const pz = w0 * vertices[i0 * 3 + 2] + w1 * vertices[i1 * 3 + 2] + w2 * vertices[i2 * 3 + 2];

      // Interpolate normal
      let nx = 0, ny = 1, nz = 0;
      if (normals && normals.length >= (Math.max(i0, i1, i2) + 1) * 3) {
        nx = w0 * normals[i0 * 3] + w1 * normals[i1 * 3] + w2 * normals[i2 * 3];
        ny = w0 * normals[i0 * 3 + 1] + w1 * normals[i1 * 3 + 1] + w2 * normals[i2 * 3 + 1];
        nz = w0 * normals[i0 * 3 + 2] + w1 * normals[i1 * 3 + 2] + w2 * normals[i2 * 3 + 2];
        const nlen = Math.hypot(nx, ny, nz) || 1.0;
        nx /= nlen; ny /= nlen; nz /= nlen;
      }

      // Interpolate UV
      let u = 0.5, v = 0.5;
      if (uvs && uvs.length >= (Math.max(i0, i1, i2) + 1) * 2) {
        u = w0 * uvs[i0 * 2] + w1 * uvs[i1 * 2] + w2 * uvs[i2 * 2];
        v = w0 * uvs[i0 * 2 + 1] + w1 * uvs[i1 * 2 + 1] + w2 * uvs[i2 * 2 + 1];
      }

      // Sample albedo color & PBR physical parameters
      const color = this.sampleAlbedoAtUv(u, v);
      const orm = this.sampleOrmAtUv(u, v);

      newPoints.push({
        id: i + 1,
        position: [px, py, pz],
        normal: [nx, ny, nz],
        color,
        roughness: orm.roughness,
        metallic: orm.metallic,
        uv: [u, v],
        error: 0.0
      });
    }

    this.points.length = 0;
    this.points.push(...newPoints);
    return this.points;
  }

  /**
   * Computes the metric axis-aligned bounding box and bounding sphere for a mesh.
   */
  public static computeBoundingBox(mesh: UniversalSurfaceMesh): MetricBoundingBox {
    const v = mesh.vertices;
    if (!v || v.length < 3) {
      return {
        min: [-1, -1, -1],
        max: [1, 1, 1],
        center: [0, 0, 0],
        extents: [2, 2, 2],
        boundingSphereRadius: Math.sqrt(3)
      };
    }

    let minX = v[0], minY = v[1], minZ = v[2];
    let maxX = v[0], maxY = v[1], maxZ = v[2];

    for (let i = 3; i < v.length; i += 3) {
      const x = v[i], y = v[i + 1], z = v[i + 2];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }

    const center: Vector3Tuple = [
      (minX + maxX) / 2,
      (minY + maxY) / 2,
      (minZ + maxZ) / 2
    ];
    const extents: Vector3Tuple = [
      maxX - minX,
      maxY - minY,
      maxZ - minZ
    ];
    const radius = Math.hypot(extents[0], extents[1], extents[2]) / 2;

    return {
      min: [minX, minY, minZ],
      max: [maxX, maxY, maxZ],
      center,
      extents,
      boundingSphereRadius: radius
    };
  }

  /**
   * Computes default collision hull from a bounding box.
   */
  public static computeDefaultCollisionHull(bbox: MetricBoundingBox): UniversalCollisionHull {
    return {
      type: 'box',
      center: bbox.center,
      dimensions: bbox.extents,
      radius: bbox.boundingSphereRadius
    };
  }

  /**
   * Cyclic Jacobi eigenvalue algorithm for 3x3 real symmetric matrices.
   * Computes sorted eigenvalues (descending) and orthonormal eigenvectors (columns of V).
   */
  public static jacobiEigen3x3(A_in: number[][]): {
    eigenvalues: [number, number, number];
    eigenvectors: [Vector3Tuple, Vector3Tuple, Vector3Tuple];
  } {
    const A: number[][] = [
      [A_in[0][0], A_in[0][1], A_in[0][2]],
      [A_in[1][0], A_in[1][1], A_in[1][2]],
      [A_in[2][0], A_in[2][1], A_in[2][2]]
    ];

    const V: number[][] = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1]
    ];

    const maxSweeps = 50;
    const eps = 1e-10;

    for (let sweep = 0; sweep < maxSweeps; sweep++) {
      const offDiag = Math.abs(A[0][1]) + Math.abs(A[0][2]) + Math.abs(A[1][2]);
      if (offDiag < eps) {
        break;
      }

      for (let p = 0; p < 2; p++) {
        for (let q = p + 1; q < 3; q++) {
          const app = A[p][p];
          const aqq = A[q][q];
          const apq = A[p][q];

          if (Math.abs(apq) < 1e-12) continue;

          const tau = (aqq - app) / (2.0 * apq);
          const t = Math.sign(tau || 1.0) / (Math.abs(tau) + Math.sqrt(1.0 + tau * tau));
          const c = 1.0 / Math.sqrt(1.0 + t * t);
          const s = t * c;

          // Rotate diagonal and off-diagonal
          A[p][p] = app - t * apq;
          A[q][q] = aqq + t * apq;
          A[p][q] = 0;

          for (let r = 0; r < 3; r++) {
            if (r !== p && r !== q) {
              const min_rp = Math.min(r, p);
              const max_rp = Math.max(r, p);
              const min_rq = Math.min(r, q);
              const max_rq = Math.max(r, q);
              const arp = A[min_rp][max_rp];
              const arq = A[min_rq][max_rq];
              A[min_rp][max_rp] = c * arp - s * arq;
              A[min_rq][max_rq] = s * arp + c * arq;
            }
          }

          // Accumulate eigenvectors
          for (let r = 0; r < 3; r++) {
            const vrp = V[r][p];
            const vrq = V[r][q];
            V[r][p] = c * vrp - s * vrq;
            V[r][q] = s * vrp + c * vrq;
          }
        }
      }
    }

    const pairs = [
      { val: A[0][0], vec: [V[0][0], V[1][0], V[2][0]] as Vector3Tuple },
      { val: A[1][1], vec: [V[0][1], V[1][1], V[2][1]] as Vector3Tuple },
      { val: A[2][2], vec: [V[0][2], V[1][2], V[2][2]] as Vector3Tuple }
    ];

    pairs.sort((a, b) => b.val - a.val);

    for (const p of pairs) {
      const len = Math.hypot(p.vec[0], p.vec[1], p.vec[2]);
      if (len > 1e-9) {
        p.vec[0] /= len;
        p.vec[1] /= len;
        p.vec[2] /= len;
      }
    }

    const u0 = pairs[0].vec;
    const u1 = pairs[1].vec;
    let u2 = pairs[2].vec;

    // Enforce right-handed coordinate system: u2 = u0 x u1
    const cross: Vector3Tuple = [
      u0[1] * u1[2] - u0[2] * u1[1],
      u0[2] * u1[0] - u0[0] * u1[2],
      u0[0] * u1[1] - u0[1] * u1[0]
    ];
    const dot = cross[0] * u2[0] + cross[1] * u2[1] + cross[2] * u2[2];
    if (dot < 0) {
      u2 = [-u2[0], -u2[1], -u2[2]];
    }

    return {
      eigenvalues: [pairs[0].val, pairs[1].val, pairs[2].val],
      eigenvectors: [u0, u1, u2]
    };
  }

  /**
   * Computes a tailored collision envelope (AABB, OBB, or Inflated Bumper) for the structure.
   */
  public computeCollisionEnvelope(options?: CollisionEnvelopeOptions): UniversalCollisionHull {
    const mode = options?.mode || 'obb';
    const margin = Math.max(0, options?.safetyMarginMeters ?? (mode === 'inflated_bumper' ? 1.5 : 0));
    const v = this.mesh.vertices;

    if (!v || v.length < 9 || mode === 'aabb') {
      const bbox = this.boundingBox || Universal3DStructureFoundation.computeBoundingBox(this.mesh);
      const hx = (bbox.extents[0] / 2) + margin;
      const hy = (bbox.extents[1] / 2) + margin;
      const hz = (bbox.extents[2] / 2) + margin;
      const center = bbox.center;

      const corners: Vector3Tuple[] = [
        [center[0] - hx, center[1] - hy, center[2] - hz],
        [center[0] + hx, center[1] - hy, center[2] - hz],
        [center[0] + hx, center[1] + hy, center[2] - hz],
        [center[0] - hx, center[1] + hy, center[2] - hz],
        [center[0] - hx, center[1] - hy, center[2] + hz],
        [center[0] + hx, center[1] - hy, center[2] + hz],
        [center[0] + hx, center[1] + hy, center[2] + hz],
        [center[0] - hx, center[1] + hy, center[2] + hz]
      ];

      return {
        type: mode === 'inflated_bumper' ? 'inflated_bumper' : 'box',
        center,
        dimensions: [hx * 2, hy * 2, hz * 2],
        radius: Math.hypot(hx, hy, hz),
        safetyMarginMeters: margin,
        axes: [
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, 1]
        ],
        rotationMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
        convexVertices: corners,
        indices: [
          0, 2, 1, 0, 3, 2,
          4, 5, 6, 4, 6, 7,
          0, 1, 5, 0, 5, 4,
          2, 3, 7, 2, 7, 6,
          0, 4, 7, 0, 7, 3,
          1, 2, 6, 1, 6, 5
        ]
      };
    }

    // OBB / PCA Mode
    const N = v.length / 3;
    let meanX = 0, meanY = 0, meanZ = 0;
    for (let i = 0; i < v.length; i += 3) {
      meanX += v[i];
      meanY += v[i + 1];
      meanZ += v[i + 2];
    }
    meanX /= N;
    meanY /= N;
    meanZ /= N;

    let c00 = 0, c01 = 0, c02 = 0;
    let c11 = 0, c12 = 0, c22 = 0;

    for (let i = 0; i < v.length; i += 3) {
      const dx = v[i] - meanX;
      const dy = v[i + 1] - meanY;
      const dz = v[i + 2] - meanZ;
      c00 += dx * dx;
      c01 += dx * dy;
      c02 += dx * dz;
      c11 += dy * dy;
      c12 += dy * dz;
      c22 += dz * dz;
    }

    const cov = [
      [c00 / N, c01 / N, c02 / N],
      [c01 / N, c11 / N, c12 / N],
      [c02 / N, c12 / N, c22 / N]
    ];

    const { eigenvectors } = Universal3DStructureFoundation.jacobiEigen3x3(cov);
    const [u0, u1, u2] = eigenvectors;

    let min0 = Infinity, max0 = -Infinity;
    let min1 = Infinity, max1 = -Infinity;
    let min2 = Infinity, max2 = -Infinity;

    for (let i = 0; i < v.length; i += 3) {
      const x = v[i], y = v[i + 1], z = v[i + 2];
      const d0 = x * u0[0] + y * u0[1] + z * u0[2];
      const d1 = x * u1[0] + y * u1[1] + z * u1[2];
      const d2 = x * u2[0] + y * u2[1] + z * u2[2];

      if (d0 < min0) min0 = d0;
      if (d0 > max0) max0 = d0;
      if (d1 < min1) min1 = d1;
      if (d1 > max1) max1 = d1;
      if (d2 < min2) min2 = d2;
      if (d2 > max2) max2 = d2;
    }

    const mid0 = (min0 + max0) / 2;
    const mid1 = (min1 + max1) / 2;
    const mid2 = (min2 + max2) / 2;

    const center: Vector3Tuple = [
      mid0 * u0[0] + mid1 * u1[0] + mid2 * u2[0],
      mid0 * u0[1] + mid1 * u1[1] + mid2 * u2[1],
      mid0 * u0[2] + mid1 * u1[2] + mid2 * u2[2]
    ];

    const h0 = (max0 - min0) / 2 + margin;
    const h1 = (max1 - min1) / 2 + margin;
    const h2 = (max2 - min2) / 2 + margin;

    const signs: [number, number, number][] = [
      [-1, -1, -1],
      [ 1, -1, -1],
      [ 1,  1, -1],
      [-1,  1, -1],
      [-1, -1,  1],
      [ 1, -1,  1],
      [ 1,  1,  1],
      [-1,  1,  1]
    ];

    const corners: Vector3Tuple[] = signs.map(([s0, s1, s2]) => [
      center[0] + s0 * h0 * u0[0] + s1 * h1 * u1[0] + s2 * h2 * u2[0],
      center[1] + s0 * h0 * u0[1] + s1 * h1 * u1[1] + s2 * h2 * u2[1],
      center[2] + s0 * h0 * u0[2] + s1 * h1 * u1[2] + s2 * h2 * u2[2]
    ]);

    const rotMatrix: [number, number, number, number, number, number, number, number, number] = [
      u0[0], u1[0], u2[0],
      u0[1], u1[1], u2[1],
      u0[2], u1[2], u2[2]
    ];

    return {
      type: mode === 'inflated_bumper' ? 'inflated_bumper' : (mode === 'convex_hull' ? 'convex_hull' : 'obb'),
      center,
      dimensions: [h0 * 2, h1 * 2, h2 * 2],
      radius: Math.hypot(h0, h1, h2),
      safetyMarginMeters: margin,
      axes: [u0, u1, u2],
      rotationMatrix: rotMatrix,
      convexVertices: corners,
      indices: [
        0, 2, 1, 0, 3, 2,
        4, 5, 6, 4, 6, 7,
        0, 1, 5, 0, 5, 4,
        2, 3, 7, 2, 7, 6,
        0, 4, 7, 0, 7, 3,
        1, 2, 6, 1, 6, 5
      ]
    };
  }

  /**
   * Serializes a collision hull to Wavefront OBJ format for 3D inspection.
   */
  public static collisionHullToObj(hull: UniversalCollisionHull): string {
    const lines: string[] = [
      `# Scratchbox IDE Collision Hull: ${hull.type}`,
      `# Center: ${hull.center.join(', ')}`,
      `# Dimensions: ${hull.dimensions.join(', ')}`,
      `# Safety Margin: ${hull.safetyMarginMeters || 0}m`
    ];

    if (hull.convexVertices && hull.convexVertices.length > 0) {
      for (const pt of hull.convexVertices) {
        lines.push(`v ${pt[0].toFixed(4)} ${pt[1].toFixed(4)} ${pt[2].toFixed(4)}`);
      }
      if (hull.indices && hull.indices.length > 0) {
        for (let i = 0; i < hull.indices.length; i += 3) {
          lines.push(`f ${hull.indices[i] + 1} ${hull.indices[i + 1] + 1} ${hull.indices[i + 2] + 1}`);
        }
      }
    }

    return lines.join('\n') + '\n';
  }

  /**
   * Factory: Create structure from procedural geometry.
   */
  public static createFromProcedural(
    shape: 'box' | 'sphere' | 'cylinder' | 'torus',
    options?: {
      name?: string;
      scale?: number;
      center?: Vector3Tuple;
      numViews?: number;
      pointDensity?: number;
      anchor?: GeodeticAnchor;
      materialPreset?: MaterialPresetName;
      material?: UniversalPbrMaterial;
      synthesizePbrTextures?: boolean;
      textureArchetype?: 'concrete' | 'brushed_metal' | 'marble' | 'wood' | 'hammered_copper' | 'chipped_paint';
    }
  ): Universal3DStructureFoundation {
    const scale = options?.scale ?? 1.0;
    const center = options?.center ?? [0, scale, 0];
    const pointDensity = options?.pointDensity ?? 2000;
    const numViews = options?.numViews ?? 24;

    // 1. Procedural Surface Points
    const points = ProceduralSfMDatasetService.sampleProceduralGeometry(shape, pointDensity, scale, center);

    // 2. Procedural Mesh Generation
    const mesh = this.generateProceduralMesh(shape, scale, center);

    // 3. Compute Bounding Box
    const bbox = this.computeBoundingBox(mesh);

    // 4. Procedural Camera Rig (Orbital Fibonacci)
    const cameras = ProceduralSfMDatasetService.generateTrajectory({
      trajectory: 'orbital_fibonacci',
      numViews,
      target: center,
      radius: bbox.boundingSphereRadius * 2.5
    });

    // 5. Material & Textures
    const materials: UniversalPbrMaterial[] = [];
    const textures: UniversalTextureMap[] = [];

    let mat: UniversalPbrMaterial;
    if (options?.material) {
      mat = { ...options.material };
    } else if (options?.materialPreset) {
      mat = Universal3DStructureFoundation.getMaterialPreset(options.materialPreset);
    } else {
      mat = Universal3DStructureFoundation.createDefaultPbrMaterial();
    }

    if (options?.synthesizePbrTextures) {
      const arch = options.textureArchetype || (
        options.materialPreset === 'oak' ? 'wood'
        : options.materialPreset === 'basalt' ? 'concrete'
        : (options.materialPreset === 'titanium' || options.materialPreset === 'chrome' || options.materialPreset === 'gold') ? 'brushed_metal'
        : 'concrete'
      );
      const pbrSet = synthesizeProceduralPbr(arch, 256, 256);
      const albedoId = `tex_albedo_${shape}`;
      const normalId = `tex_normal_${shape}`;
      const ormId = `tex_orm_${shape}`;

      textures.push(
        { id: albedoId, type: 'albedo', width: 256, height: 256, channels: 4, buffer: pbrSet.albedoPng, mimeType: 'image/png' },
        { id: normalId, type: 'normal', width: 256, height: 256, channels: 4, buffer: pbrSet.normalPng, mimeType: 'image/png' },
        { id: ormId, type: 'metallicRoughness', width: 256, height: 256, channels: 4, buffer: pbrSet.ormPng, mimeType: 'image/png' }
      );

      mat.baseColorTextureId = albedoId;
      mat.normalTextureId = normalId;
      mat.metallicRoughnessTextureId = ormId;
    }
    materials.push(mat);

    const foundation = new Universal3DStructureFoundation({
      name: options?.name || `Procedural_${shape.toUpperCase()}`,
      anchor: options?.anchor,
      mesh,
      materials,
      textures,
      points,
      cameras,
      boundingBox: bbox,
      tags: ['procedural', shape, 'canonical-anchor']
    });

    // If custom material or textures present, synchronize surface points
    if (options?.materialPreset || options?.material || options?.synthesizePbrTextures) {
      foundation.resynchronizePoints(pointDensity);
    }

    return foundation;
  }

  /**
   * Generates analytical triangle mesh for procedural primitives.
   */
  private static generateProceduralMesh(
    shape: 'box' | 'sphere' | 'cylinder' | 'torus',
    scale: number,
    center: Vector3Tuple
  ): UniversalSurfaceMesh {
    if (shape === 'box') {
      const s = scale;
      const [cx, cy, cz] = center;
      // 8 vertices of a cube
      const rawVerts = [
        cx - s, cy - s, cz + s,  cx + s, cy - s, cz + s,  cx + s, cy + s, cz + s,  cx - s, cy + s, cz + s,
        cx - s, cy - s, cz - s,  cx - s, cy + s, cz - s,  cx + s, cy + s, cz - s,  cx + s, cy - s, cz - s
      ];
      // 8 UV coordinates
      const rawUvs = [
        0, 0,  1, 0,  1, 1,  0, 1,
        0, 0,  0, 1,  1, 1,  1, 0
      ];
      // 8 vertex normals
      const invSqrt3 = 1.0 / Math.sqrt(3);
      const rawNormals = [
        -invSqrt3, -invSqrt3,  invSqrt3,
         invSqrt3, -invSqrt3,  invSqrt3,
         invSqrt3,  invSqrt3,  invSqrt3,
        -invSqrt3,  invSqrt3,  invSqrt3,
        -invSqrt3, -invSqrt3, -invSqrt3,
        -invSqrt3,  invSqrt3, -invSqrt3,
         invSqrt3,  invSqrt3, -invSqrt3,
         invSqrt3, -invSqrt3, -invSqrt3
      ];
      // 12 triangles (36 indices)
      const rawIndices = [
        0, 1, 2,  0, 2, 3, // front
        1, 7, 6,  1, 6, 2, // right
        7, 4, 5,  7, 5, 6, // back
        4, 0, 3,  4, 3, 5, // left
        3, 2, 6,  3, 6, 5, // top
        4, 7, 1,  4, 1, 0  // bottom
      ];
      return {
        vertices: new Float32Array(rawVerts),
        indices: new Uint32Array(rawIndices),
        normals: new Float32Array(rawNormals),
        uvs: new Float32Array(rawUvs),
        triangleCount: 12,
        vertexCount: 8
      };
    }

    // Sphere / Cylinder / Torus parametric approximation
    const uSegs = 24;
    const vSegs = 16;
    const vertices: number[] = [];
    const indices: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];

    if (shape === 'sphere') {
      for (let j = 0; j <= vSegs; j++) {
        const theta = (j * Math.PI) / vSegs;
        const sinTheta = Math.sin(theta);
        const cosTheta = Math.cos(theta);
        const v = j / vSegs;

        for (let i = 0; i <= uSegs; i++) {
          const phi = (i * 2 * Math.PI) / uSegs;
          const u = i / uSegs;
          const x = Math.cos(phi) * sinTheta;
          const y = cosTheta;
          const z = Math.sin(phi) * sinTheta;

          normals.push(x, y, z);
          uvs.push(u, v);
          vertices.push(center[0] + x * scale, center[1] + y * scale, center[2] + z * scale);
        }
      }

      for (let j = 0; j < vSegs; j++) {
        for (let i = 0; i < uSegs; i++) {
          const first = j * (uSegs + 1) + i;
          const second = first + uSegs + 1;
          indices.push(first, second, first + 1);
          indices.push(second, second + 1, first + 1);
        }
      }
    } else {
      // Cylinder default
      const height = scale * 2;
      for (let j = 0; j <= vSegs; j++) {
        const v = j / vSegs;
        const y = (v - 0.5) * height;
        for (let i = 0; i <= uSegs; i++) {
          const u = i / uSegs;
          const phi = (i * 2 * Math.PI) / uSegs;
          const x = Math.cos(phi);
          const z = Math.sin(phi);
          normals.push(x, 0, z);
          uvs.push(u, v);
          vertices.push(center[0] + x * scale, center[1] + y, center[2] + z * scale);
        }
      }
      for (let j = 0; j < vSegs; j++) {
        for (let i = 0; i < uSegs; i++) {
          const first = j * (uSegs + 1) + i;
          const second = first + uSegs + 1;
          indices.push(first, second, first + 1);
          indices.push(second, second + 1, first + 1);
        }
      }
    }

    return {
      vertices: new Float32Array(vertices),
      indices: new Uint32Array(indices),
      normals: new Float32Array(normals),
      uvs: new Float32Array(uvs),
      triangleCount: indices.length / 3,
      vertexCount: vertices.length / 3
    };
  }

  // ==========================================
  // FORMAT ADAPTERS (Projections Outward)
  // ==========================================

  /**
   * Adapter 1: Standard COLMAP Format
   * Exports cameras.txt, images.txt, points3D.txt.
   */
  public toColmap(): { camerasText: string; imagesText: string; points3DText: string } {
    const bundle = ProceduralSfMDatasetService.serializeBundle(this.cameras, this.points);
    return {
      camerasText: bundle.camerasText,
      imagesText: bundle.imagesText,
      points3DText: bundle.points3DText
    };
  }

  /**
   * Adapter 2: Standard Nerfstudio Format
   * Exports transforms.json and sparse_pcd.ply.
   */
  public toNerfstudio(): { transformsJson: string; sparsePcdPly: string } {
    const bundle = ProceduralSfMDatasetService.serializeBundle(this.cameras, this.points);
    return {
      transformsJson: bundle.transformsJson,
      sparsePcdPly: bundle.sparsePcdPly
    };
  }

  /**
   * Adapter 3: Video Diffusion Camera Blockout (<VIDEO_REF_0>)
   * Exports camera trajectory for Gemini Omni, Veo, Sora.
   */
  public toVideoCameraBlockout(fps: number = 24): VideoDiffusionCameraBlockout {
    const frames = this.cameras.map((cam, idx) => ({
      frameIndex: idx,
      timestampSeconds: Number((idx / fps).toFixed(3)),
      position: cam.position,
      target: cam.target,
      c2wMatrix: cam.c2wMatrixNerfstudio,
      fovDegrees: cam.intrinsics.fovHorizontalDeg
    }));

    const duration = frames.length > 0 ? (frames.length - 1) / fps : 0;

    return {
      videoRef: '<VIDEO_REF_0>',
      fps,
      frameCount: frames.length,
      durationSeconds: Number(duration.toFixed(2)),
      trajectoryType: 'orbit_360',
      startPose: {
        position: this.cameras[0]?.position || [0, 1, 3],
        target: this.cameras[0]?.target || [0, 0, 0],
        fovDegrees: this.cameras[0]?.intrinsics.fovHorizontalDeg || 60
      },
      frames
    };
  }

  /**
   * Adapter 4: Simplified Collision Hull & Navigation Bounds
   */
  public toCollisionHull(options?: CollisionEnvelopeOptions): UniversalCollisionHull {
    if (options) {
      return this.computeCollisionEnvelope(options);
    }
    return this.collisionHull;
  }

  /**
   * Adapter 5: RFC 7946 GeoJSON (WGS-84 GIS projection)
   */
  public toGeoJson(): Record<string, any> {
    const anchor = this.anchor || {
      lat: 41.8902,
      lng: 12.4922,
      elevationMeters: 50.0
    };

    const ltp = new LocalTangentPlane({
      lat: anchor.lat,
      lng: anchor.lng,
      alt: anchor.elevationMeters
    });

    const features: any[] = [];

    // 1. Structure Origin Feature
    features.push({
      type: 'Feature',
      properties: {
        id: this.id,
        name: this.name,
        type: 'structure_origin',
        radiusMeters: this.boundingBox.boundingSphereRadius
      },
      geometry: {
        type: 'Point',
        coordinates: [anchor.lng, anchor.lat, anchor.elevationMeters]
      }
    });

    // 2. Camera Station Points
    for (const cam of this.cameras) {
      const geoPos = ltp.toLatLng(cam.position);
      features.push({
        type: 'Feature',
        properties: {
          id: cam.id,
          name: cam.name,
          type: 'camera_station',
          fov: cam.intrinsics.fovHorizontalDeg
        },
        geometry: {
          type: 'Point',
          coordinates: [
            Number(geoPos.lng.toFixed(7)),
            Number(geoPos.lat.toFixed(7)),
            Number((geoPos.alt ?? anchor.elevationMeters).toFixed(2))
          ]
        }
      });
    }

    return {
      type: 'FeatureCollection',
      features
    };
  }

  /**
   * Adapter 6: Standard binary glTF 2.0 (.glb) Buffer
   * Full Khronos glTF 2.0 binary container with geometry attributes (POSITION, NORMAL,
   * TEXCOORD_0, COLOR_0, INDICES), PBR materials, samplers, and embedded textures.
   */
  public toGlbBuffer(options?: { includeAnimations?: boolean }): Buffer {
    const v = this.mesh.vertices;
    const chunks: Buffer[] = [];
    let totalBinLength = 0;

    const appendChunk = (buf: Buffer): { byteOffset: number; byteLength: number } => {
      const byteOffset = totalBinLength;
      const byteLength = buf.length;
      chunks.push(buf);
      totalBinLength += byteLength;
      const padding = (4 - (byteLength % 4)) % 4;
      if (padding > 0) {
        chunks.push(Buffer.alloc(padding, 0));
        totalBinLength += padding;
      }
      return { byteOffset, byteLength };
    };

    // 1. POSITION Chunk
    const vBuf = Buffer.alloc(v.length * 4);
    for (let i = 0; i < v.length; i++) {
      vBuf.writeFloatLE(v[i], i * 4);
    }
    const posChunk = appendChunk(vBuf);

    // 2. NORMAL Chunk
    let normChunk: { byteOffset: number; byteLength: number } | null = null;
    if (this.mesh.normals && this.mesh.normals.length > 0) {
      const n = this.mesh.normals;
      const nBuf = Buffer.alloc(n.length * 4);
      for (let i = 0; i < n.length; i++) {
        nBuf.writeFloatLE(n[i], i * 4);
      }
      normChunk = appendChunk(nBuf);
    }

    // 3. TEXCOORD_0 Chunk
    let uvChunk: { byteOffset: number; byteLength: number } | null = null;
    if (this.mesh.uvs && this.mesh.uvs.length > 0) {
      const uv = this.mesh.uvs;
      const uvBuf = Buffer.alloc(uv.length * 4);
      for (let i = 0; i < uv.length; i++) {
        uvBuf.writeFloatLE(uv[i], i * 4);
      }
      uvChunk = appendChunk(uvBuf);
    }

    // 4. INDICES Chunk
    let idxChunk: { byteOffset: number; byteLength: number } | null = null;
    if (this.mesh.indices && this.mesh.indices.length > 0) {
      const ind = this.mesh.indices;
      const indBuf = Buffer.alloc(ind.length * 4);
      for (let i = 0; i < ind.length; i++) {
        indBuf.writeUInt32LE(ind[i], i * 4);
      }
      idxChunk = appendChunk(indBuf);
    }

    // 5. Texture Images Chunk
    const imageChunks: { byteOffset: number; byteLength: number; mimeType: string }[] = [];
    for (const tex of this.textures) {
      let imgBuf: Buffer;
      if (tex.mimeType === 'image/raw') {
        imgBuf = encodePng(tex.width, tex.height, tex.buffer);
      } else {
        imgBuf = tex.buffer;
      }
      const chunk = appendChunk(imgBuf);
      imageChunks.push({
        byteOffset: chunk.byteOffset,
        byteLength: chunk.byteLength,
        mimeType: tex.mimeType === 'image/jpeg' ? 'image/jpeg' : 'image/png'
      });
    }

    // Assemble BufferViews
    const bufferViews: any[] = [];
    const bvPos = bufferViews.length;
    bufferViews.push({
      buffer: 0,
      byteOffset: posChunk.byteOffset,
      byteLength: posChunk.byteLength,
      target: 34962 // ARRAY_BUFFER
    });

    let bvNorm: number | null = null;
    if (normChunk) {
      bvNorm = bufferViews.length;
      bufferViews.push({
        buffer: 0,
        byteOffset: normChunk.byteOffset,
        byteLength: normChunk.byteLength,
        target: 34962
      });
    }

    let bvUv: number | null = null;
    if (uvChunk) {
      bvUv = bufferViews.length;
      bufferViews.push({
        buffer: 0,
        byteOffset: uvChunk.byteOffset,
        byteLength: uvChunk.byteLength,
        target: 34962
      });
    }

    let bvIdx: number | null = null;
    if (idxChunk) {
      bvIdx = bufferViews.length;
      bufferViews.push({
        buffer: 0,
        byteOffset: idxChunk.byteOffset,
        byteLength: idxChunk.byteLength,
        target: 34963 // ELEMENT_ARRAY_BUFFER
      });
    }

    const bvImages: number[] = [];
    for (const ic of imageChunks) {
      bvImages.push(bufferViews.length);
      bufferViews.push({
        buffer: 0,
        byteOffset: ic.byteOffset,
        byteLength: ic.byteLength
      });
    }

    // Assemble Accessors
    const accessors: any[] = [];
    const accPos = accessors.length;
    accessors.push({
      bufferView: bvPos,
      byteOffset: 0,
      componentType: 5126, // FLOAT
      count: this.mesh.vertexCount,
      type: 'VEC3',
      min: this.boundingBox.min,
      max: this.boundingBox.max
    });

    let accNorm: number | null = null;
    if (bvNorm !== null) {
      accNorm = accessors.length;
      accessors.push({
        bufferView: bvNorm,
        byteOffset: 0,
        componentType: 5126,
        count: this.mesh.vertexCount,
        type: 'VEC3'
      });
    }

    let accUv: number | null = null;
    if (bvUv !== null) {
      accUv = accessors.length;
      accessors.push({
        bufferView: bvUv,
        byteOffset: 0,
        componentType: 5126,
        count: this.mesh.vertexCount,
        type: 'VEC2'
      });
    }

    let accIdx: number | null = null;
    if (bvIdx !== null && this.mesh.indices) {
      accIdx = accessors.length;
      accessors.push({
        bufferView: bvIdx,
        byteOffset: 0,
        componentType: 5125, // UNSIGNED_INT
        count: this.mesh.indices.length,
        type: 'SCALAR'
      });
    }

    // Images & Samplers & Textures
    const images = imageChunks.map((ic, i) => ({
      bufferView: bvImages[i],
      mimeType: ic.mimeType
    }));

    const samplers = images.length > 0 ? [{
      magFilter: 9729,
      minFilter: 9987,
      wrapS: 10497,
      wrapT: 10497
    }] : undefined;

    const textures = images.map((_, i) => ({
      sampler: 0,
      source: i
    }));

    // Materials
    const materials = this.materials.map(mat => {
      const pbr: any = {
        baseColorFactor: mat.baseColorFactor ?? [1, 1, 1, 1],
        metallicFactor: mat.metallicFactor ?? 0.1,
        roughnessFactor: mat.roughnessFactor ?? 0.5
      };

      const baseColorTexIdx = this.textures.findIndex(t => t.id === mat.baseColorTextureId || t.type === 'albedo');
      if (baseColorTexIdx >= 0 && baseColorTexIdx < textures.length) {
        pbr.baseColorTexture = { index: baseColorTexIdx };
      }

      const mrTexIdx = this.textures.findIndex(t => t.id === mat.metallicRoughnessTextureId || t.type === 'metallicRoughness');
      if (mrTexIdx >= 0 && mrTexIdx < textures.length) {
        pbr.metallicRoughnessTexture = { index: mrTexIdx };
      }

      const normTexIdx = this.textures.findIndex(t => t.id === mat.normalTextureId || t.type === 'normal');
      const normalTexture = normTexIdx >= 0 && normTexIdx < textures.length ? { index: normTexIdx } : undefined;

      const occTexIdx = this.textures.findIndex(t => t.id === mat.occlusionTextureId || t.type === 'occlusion');
      const occlusionTexture = occTexIdx >= 0 && occTexIdx < textures.length ? { index: occTexIdx } : undefined;

      return {
        name: mat.name,
        pbrMetallicRoughness: pbr,
        ...(normalTexture ? { normalTexture } : {}),
        ...(occlusionTexture ? { occlusionTexture } : {}),
        emissiveFactor: mat.emissiveFactor ?? [0, 0, 0],
        doubleSided: mat.doubleSided ?? false,
        alphaMode: mat.alphaMode ?? 'OPAQUE'
      };
    });

    const attributes: Record<string, number> = { POSITION: accPos };
    if (accNorm !== null) attributes.NORMAL = accNorm;
    if (accUv !== null) attributes.TEXCOORD_0 = accUv;

    const primitive: any = {
      attributes,
      mode: 4
    };
    if (accIdx !== null) {
      primitive.indices = accIdx;
    }
    if (materials.length > 0) {
      primitive.material = 0;
    }

    // 6. Universal Animation Tracks & Clips (glTF 2.0 Animations)
    const includeAnim = options?.includeAnimations !== false;
    const effectiveClips: UniversalAnimationClip[] = [];
    if (includeAnim) {
      if (this.animations.length > 0) {
        effectiveClips.push(...this.animations);
      } else {
        const blockout = this.toVideoCameraBlockout();
        if (blockout && blockout.frames.length > 0) {
          effectiveClips.push(fromVideoDiffusionCameraBlockout(blockout));
        }
      }
    }

    const gltfAnimations: any[] = [];
    let hasCameraNode = false;

    for (const clip of effectiveClips) {
      const channels: any[] = [];
      const samplersList: any[] = [];

      for (const track of clip.tracks) {
        if (!track.keyframes || track.keyframes.length === 0) continue;
        const sortedKfs = [...track.keyframes].sort((a, b) => a.timeSeconds - b.timeSeconds);

        // a. INPUT timestamps buffer (SCALAR FLOAT)
        const timeBuf = Buffer.alloc(sortedKfs.length * 4);
        for (let k = 0; k < sortedKfs.length; k++) {
          timeBuf.writeFloatLE(sortedKfs[k].timeSeconds, k * 4);
        }
        const timeChunk = appendChunk(timeBuf);
        const bvTime = bufferViews.length;
        bufferViews.push({
          buffer: 0,
          byteOffset: timeChunk.byteOffset,
          byteLength: timeChunk.byteLength
        });
        const accTime = accessors.length;
        accessors.push({
          bufferView: bvTime,
          byteOffset: 0,
          componentType: 5126, // FLOAT
          count: sortedKfs.length,
          type: 'SCALAR',
          min: [sortedKfs[0].timeSeconds],
          max: [sortedKfs[sortedKfs.length - 1].timeSeconds]
        });

        // b. OUTPUT values buffer
        let gltfPath = 'translation';
        let valType = 'VEC3';
        let bytesPerKf = 12;

        if (track.property === 'rotation') {
          gltfPath = 'rotation';
          valType = 'VEC4';
          bytesPerKf = 16;
        } else if (track.property === 'scale') {
          gltfPath = 'scale';
          valType = 'VEC3';
          bytesPerKf = 12;
        } else if (track.property === 'weight') {
          gltfPath = 'weights';
          valType = 'SCALAR';
          bytesPerKf = 4;
        } else {
          gltfPath = 'translation';
          valType = 'VEC3';
          bytesPerKf = 12;
        }

        const valBuf = Buffer.alloc(sortedKfs.length * bytesPerKf);
        for (let k = 0; k < sortedKfs.length; k++) {
          const val = sortedKfs[k].value;
          if (valType === 'VEC4') {
            const q = Array.isArray(val) ? val : [0, 0, 0, 1];
            valBuf.writeFloatLE(q[0] ?? 0, k * 16);
            valBuf.writeFloatLE(q[1] ?? 0, k * 16 + 4);
            valBuf.writeFloatLE(q[2] ?? 0, k * 16 + 8);
            valBuf.writeFloatLE(q[3] ?? 1, k * 16 + 12);
          } else if (valType === 'VEC3') {
            const v = Array.isArray(val) ? val : [0, 0, 0];
            valBuf.writeFloatLE(v[0] ?? 0, k * 12);
            valBuf.writeFloatLE(v[1] ?? 0, k * 12 + 4);
            valBuf.writeFloatLE(v[2] ?? 0, k * 12 + 8);
          } else {
            const s = typeof val === 'number' ? val : 0;
            valBuf.writeFloatLE(s, k * 4);
          }
        }

        const valChunk = appendChunk(valBuf);
        const bvVal = bufferViews.length;
        bufferViews.push({
          buffer: 0,
          byteOffset: valChunk.byteOffset,
          byteLength: valChunk.byteLength
        });
        const accVal = accessors.length;
        accessors.push({
          bufferView: bvVal,
          byteOffset: 0,
          componentType: 5126,
          count: sortedKfs.length,
          type: valType
        });

        // c. Sampler
        const samplerIndex = samplersList.length;
        const interpolation = track.interpolation === 'step' ? 'STEP' : (track.interpolation === 'cubicspline' ? 'CUBICSPLINE' : 'LINEAR');
        samplersList.push({
          input: accTime,
          interpolation,
          output: accVal
        });

        // d. Target Node
        const isCameraTarget = track.targetNodeId === 'camera';
        if (isCameraTarget) hasCameraNode = true;
        const targetNode = isCameraTarget ? 1 : 0;
        channels.push({
          sampler: samplerIndex,
          target: {
            node: targetNode,
            path: gltfPath
          }
        });
      }

      if (channels.length > 0) {
        gltfAnimations.push({
          name: clip.name,
          channels,
          samplers: samplersList
        });
      }
    }

    const gltfNodes: any[] = [{ mesh: 0, name: this.name }];
    if (hasCameraNode) {
      gltfNodes.push({ name: 'Camera' });
    }

    const gltfJson: any = {
      asset: { version: '2.0', generator: 'Scratchbox_Universal3DStructure' },
      scene: 0,
      scenes: [{ nodes: gltfNodes.map((_, i) => i) }],
      nodes: gltfNodes,
      meshes: [{ primitives: [primitive] }],
      accessors,
      bufferViews,
      buffers: [{ byteLength: totalBinLength }]
    };

    if (materials.length > 0) gltfJson.materials = materials;
    if (textures.length > 0) gltfJson.textures = textures;
    if (images.length > 0) gltfJson.images = images;
    if (samplers) gltfJson.samplers = samplers;
    if (gltfAnimations.length > 0) gltfJson.animations = gltfAnimations;

    const binBuffer = Buffer.concat(chunks, totalBinLength);

    const jsonText = JSON.stringify(gltfJson);
    const jsonPaddedLength = Math.ceil(jsonText.length / 4) * 4;
    const jsonBuffer = Buffer.alloc(jsonPaddedLength, 0x20); // Pad with spaces
    jsonBuffer.write(jsonText, 'utf8');

    const totalLength = 12 + 8 + jsonPaddedLength + 8 + totalBinLength;
    const glb = Buffer.alloc(totalLength);

    // GLB Header
    glb.writeUInt32LE(0x46546C67, 0); // magic: 'glTF'
    glb.writeUInt32LE(2, 4);          // version: 2
    glb.writeUInt32LE(totalLength, 8);// total file length

    // JSON Chunk Header
    glb.writeUInt32LE(jsonPaddedLength, 12);
    glb.writeUInt32LE(0x4E4F534A, 16); // 'JSON'
    jsonBuffer.copy(glb, 20);

    // BIN Chunk Header
    const binOffset = 20 + jsonPaddedLength;
    glb.writeUInt32LE(totalBinLength, binOffset);
    glb.writeUInt32LE(0x004E4942, binOffset + 4); // 'BIN\0'
    binBuffer.copy(glb, binOffset + 8);

    return glb;
  }

  /**
   * Factory: Ingest binary glTF 2.0 (.glb) into a canonical Universal3DStructureFoundation.
   * Extracts geometry, UVs, normals, indices, PBR materials, and embedded textures.
   */
  public static createFromGlb(
    glbBuffer: Buffer,
    options?: {
      name?: string;
      anchor?: GeodeticAnchor;
      numViews?: number;
      resyncPoints?: boolean;
      pointDensity?: number;
    }
  ): Universal3DStructureFoundation {
    if (glbBuffer.length < 20 || glbBuffer.readUInt32LE(0) !== 0x46546C67) {
      throw new Error('Invalid glTF 2.0 binary header');
    }

    let offset = 12;
    let gltf: any = null;
    let binBuffer: Buffer = Buffer.alloc(0);

    while (offset < glbBuffer.length) {
      const chunkLength = glbBuffer.readUInt32LE(offset);
      const chunkType = glbBuffer.readUInt32LE(offset + 4);
      const chunkData = glbBuffer.subarray(offset + 8, offset + 8 + chunkLength);

      if (chunkType === 0x4E4F534A) {
        // 'JSON'
        gltf = JSON.parse(chunkData.toString('utf8'));
      } else if (chunkType === 0x004E4942) {
        // 'BIN\0'
        binBuffer = chunkData;
      }
      offset += 8 + chunkLength;
    }

    if (!gltf || !gltf.meshes || gltf.meshes.length === 0) {
      throw new Error('No meshes found in GLB structure');
    }

    const prim = gltf.meshes[0].primitives?.[0];
    if (!prim || prim.attributes?.POSITION === undefined) {
      throw new Error('No valid mesh primitive with POSITION attribute found');
    }

    const readAccessor = (accIdx: number) => {
      if (accIdx === undefined || !gltf.accessors || !gltf.accessors[accIdx]) return null;
      const acc = gltf.accessors[accIdx];
      const bv = gltf.bufferViews[acc.bufferView];
      const start = (bv.byteOffset || 0) + (acc.byteOffset || 0);
      return { acc, bv, start };
    };

    // 1. POSITION
    const posInfo = readAccessor(prim.attributes.POSITION)!;
    const vertexCount = posInfo.acc.count;
    const vertices = new Float32Array(vertexCount * 3);
    for (let i = 0; i < vertexCount * 3; i++) {
      vertices[i] = binBuffer.readFloatLE(posInfo.start + i * 4);
    }

    // 2. NORMAL
    let normals: Float32Array | undefined;
    if (prim.attributes.NORMAL !== undefined) {
      const normInfo = readAccessor(prim.attributes.NORMAL);
      if (normInfo) {
        normals = new Float32Array(normInfo.acc.count * 3);
        for (let i = 0; i < normInfo.acc.count * 3; i++) {
          normals[i] = binBuffer.readFloatLE(normInfo.start + i * 4);
        }
      }
    }

    // 3. TEXCOORD_0
    let uvs: Float32Array | undefined;
    if (prim.attributes.TEXCOORD_0 !== undefined) {
      const uvInfo = readAccessor(prim.attributes.TEXCOORD_0);
      if (uvInfo) {
        uvs = new Float32Array(uvInfo.acc.count * 2);
        for (let i = 0; i < uvInfo.acc.count * 2; i++) {
          uvs[i] = binBuffer.readFloatLE(uvInfo.start + i * 4);
        }
      }
    }

    // 4. INDICES
    let indices: Uint32Array | undefined;
    let triangleCount = 0;
    if (prim.indices !== undefined) {
      const idxInfo = readAccessor(prim.indices);
      if (idxInfo) {
        indices = new Uint32Array(idxInfo.acc.count);
        if (idxInfo.acc.componentType === 5123) {
          // UNSIGNED_SHORT
          for (let i = 0; i < idxInfo.acc.count; i++) {
            indices[i] = binBuffer.readUInt16LE(idxInfo.start + i * 2);
          }
        } else if (idxInfo.acc.componentType === 5125) {
          // UNSIGNED_INT
          for (let i = 0; i < idxInfo.acc.count; i++) {
            indices[i] = binBuffer.readUInt32LE(idxInfo.start + i * 4);
          }
        } else if (idxInfo.acc.componentType === 5121) {
          // UNSIGNED_BYTE
          for (let i = 0; i < idxInfo.acc.count; i++) {
            indices[i] = binBuffer.readUInt8(idxInfo.start + i);
          }
        }
        triangleCount = indices.length / 3;
      }
    } else {
      triangleCount = vertexCount / 3;
    }

    const mesh: UniversalSurfaceMesh = {
      vertices,
      indices,
      normals,
      uvs,
      vertexCount,
      triangleCount
    };

    // 5. Embedded Images
    const embeddedImages: { buffer: Buffer; mimeType: string }[] = [];
    for (let i = 0; i < (gltf.images?.length || 0); i++) {
      const img = gltf.images[i];
      if (img.bufferView !== undefined) {
        const bv = gltf.bufferViews[img.bufferView];
        const start = bv.byteOffset || 0;
        const buf = Buffer.from(binBuffer.subarray(start, start + bv.byteLength));
        embeddedImages.push({ buffer: buf, mimeType: img.mimeType || 'image/png' });
      }
    }

    // 6. Textures & Materials
    const textures: UniversalTextureMap[] = [];
    const materials: UniversalPbrMaterial[] = [];

    const getOrCreateTexture = (texIdx: number, type: UniversalTextureType, idPrefix: string): string | undefined => {
      if (texIdx === undefined || !gltf.textures || !gltf.textures[texIdx]) return undefined;
      const imgIdx = gltf.textures[texIdx].source ?? texIdx;
      const img = embeddedImages[imgIdx];
      if (!img) return undefined;

      const id = `${idPrefix}_${imgIdx}`;
      if (!textures.some(t => t.id === id)) {
        let width = 256, height = 256;
        try {
          const dec = decodePng(img.buffer);
          width = dec.width;
          height = dec.height;
        } catch {
          // Fallback dimension
        }
        textures.push({
          id,
          type,
          width,
          height,
          channels: 4,
          buffer: img.buffer,
          mimeType: img.mimeType as any
        });
      }
      return id;
    };

    for (let i = 0; i < (gltf.materials?.length || 0); i++) {
      const mat = gltf.materials[i];
      const pbr = mat.pbrMetallicRoughness || {};
      const baseColorTexId = pbr.baseColorTexture !== undefined
        ? getOrCreateTexture(pbr.baseColorTexture.index, 'albedo', 'tex_albedo')
        : undefined;
      const mrTexId = pbr.metallicRoughnessTexture !== undefined
        ? getOrCreateTexture(pbr.metallicRoughnessTexture.index, 'metallicRoughness', 'tex_orm')
        : undefined;
      const normTexId = mat.normalTexture !== undefined
        ? getOrCreateTexture(mat.normalTexture.index, 'normal', 'tex_normal')
        : undefined;
      const occTexId = mat.occlusionTexture !== undefined
        ? getOrCreateTexture(mat.occlusionTexture.index, 'occlusion', 'tex_ao')
        : undefined;

      materials.push({
        name: mat.name || `Material_${i}`,
        baseColorFactor: pbr.baseColorFactor ?? [1, 1, 1, 1],
        metallicFactor: pbr.metallicFactor ?? 0.1,
        roughnessFactor: pbr.roughnessFactor ?? 0.5,
        emissiveFactor: mat.emissiveFactor ?? [0, 0, 0],
        doubleSided: mat.doubleSided ?? false,
        alphaMode: mat.alphaMode ?? 'OPAQUE',
        baseColorTextureId: baseColorTexId,
        metallicRoughnessTextureId: mrTexId,
        normalTextureId: normTexId,
        occlusionTextureId: occTexId
      });
    }

    if (materials.length === 0) {
      materials.push(Universal3DStructureFoundation.createDefaultPbrMaterial('Ingested_GLB_Material'));
    }

    const bbox = Universal3DStructureFoundation.computeBoundingBox(mesh);
    const cameras = ProceduralSfMDatasetService.generateTrajectory({
      trajectory: 'orbital_fibonacci',
      numViews: options?.numViews ?? 24,
      target: bbox.center,
      radius: bbox.boundingSphereRadius * 2.5
    });

    const struct = new Universal3DStructureFoundation({
      name: options?.name || 'Ingested_GLB_Structure',
      anchor: options?.anchor,
      mesh,
      materials,
      textures,
      cameras,
      boundingBox: bbox,
      tags: ['glb-ingested', 'canonical-anchor']
    });

    if (options?.resyncPoints !== false) {
      struct.resynchronizePoints(options?.pointDensity ?? 1500);
    }

    return struct;
  }

  /**
   * Factory: Ingest continuous biophysical fields from AdaptiveMaterialPbrService.
   */
  public static createFromBiophysicalFields(
    mesh: UniversalSurfaceMesh,
    fields: ContinuousBiophysicalFields,
    options?: {
      name?: string;
      anchor?: GeodeticAnchor;
      materialPreset?: MaterialPresetName;
    }
  ): Universal3DStructureFoundation {
    const { width, height } = fields;

    const ensureRgba = (src: Uint8Array | Buffer, channels: number): Buffer => {
      const out = Buffer.alloc(width * height * 4);
      if (channels === 4) {
        Buffer.from(src.buffer, src.byteOffset, src.byteLength).copy(out);
      } else if (channels === 3) {
        for (let i = 0; i < width * height; i++) {
          out[i * 4] = src[i * 3];
          out[i * 4 + 1] = src[i * 3 + 1];
          out[i * 4 + 2] = src[i * 3 + 2];
          out[i * 4 + 3] = 255;
        }
      } else if (channels === 1) {
        for (let i = 0; i < width * height; i++) {
          const val = src[i];
          out[i * 4] = val;
          out[i * 4 + 1] = val;
          out[i * 4 + 2] = val;
          out[i * 4 + 3] = 255;
        }
      }
      return out;
    };

    const albedoRgba = ensureRgba(fields.albedoRgba, 4);
    const normalRgba = ensureRgba(fields.normalRgb, 3);
    const ormRgba = ensureRgba(fields.ormRgb, 3);

    const albedoPng = encodePng(width, height, albedoRgba);
    const normalPng = encodePng(width, height, normalRgba);
    const ormPng = encodePng(width, height, ormRgba);

    const albedoId = `tex_biophys_albedo_${Date.now()}`;
    const normalId = `tex_biophys_normal_${Date.now()}`;
    const ormId = `tex_biophys_orm_${Date.now()}`;

    const textures: UniversalTextureMap[] = [
      { id: albedoId, type: 'albedo', width, height, channels: 4, buffer: albedoPng, mimeType: 'image/png' },
      { id: normalId, type: 'normal', width, height, channels: 4, buffer: normalPng, mimeType: 'image/png' },
      { id: ormId, type: 'metallicRoughness', width, height, channels: 4, buffer: ormPng, mimeType: 'image/png' }
    ];

    const basePreset = options?.materialPreset
      ? Universal3DStructureFoundation.getMaterialPreset(options.materialPreset)
      : Universal3DStructureFoundation.createDefaultPbrMaterial();

    const material: UniversalPbrMaterial = {
      ...basePreset,
      name: options?.name ? `${options.name}_Material` : 'Biophysical_Adaptive_PBR',
      baseColorTextureId: albedoId,
      normalTextureId: normalId,
      metallicRoughnessTextureId: ormId
    };

    const bbox = Universal3DStructureFoundation.computeBoundingBox(mesh);
    const cameras = ProceduralSfMDatasetService.generateTrajectory({
      trajectory: 'orbital_fibonacci',
      numViews: 24,
      target: bbox.center,
      radius: bbox.boundingSphereRadius * 2.5
    });

    const struct = new Universal3DStructureFoundation({
      name: options?.name || 'Biophysical_Structure',
      anchor: options?.anchor,
      mesh,
      materials: [material],
      textures,
      cameras,
      boundingBox: bbox,
      tags: ['biophysical', 'adaptive-pbr', 'canonical-anchor']
    });

    struct.resynchronizePoints(1500);
    return struct;
  }

  /**
   * Factory: Create high-complexity Babylonian Ziggurat & Astrolabe Observatory structure
   * adhering to the 70-20-10 geometric form hierarchy and biophysical PBR materials.
   */
  public static createBabylonianZigguratComplex(options?: {
    name?: string;
    numViews?: number;
    pointDensity?: number;
  }): Universal3DStructureFoundation {
    const data = buildBabylonianZigguratStructure(options);
    const struct = new Universal3DStructureFoundation({
      name: options?.name || 'babylonian_ziggurat_observatory',
      anchor: data.anchor,
      mesh: data.mesh,
      materials: data.materials,
      textures: data.textures,
      cameras: data.cameras,
      boundingBox: data.boundingBox,
      tags: ['ancient_near_east', 'ziggurat', 'astronomy', 'photorealistic', 'canonical-anchor']
    });
    struct.resynchronizePoints(options?.pointDensity ?? 5000);
    return struct;
  }

  /**
   * Factory: Create high-complexity Alpine Matterhorn Mountain Valley & Swiss Chalet Hamlet structure
   * with continuous FBM heightfield, knife-edge arêtes, glacial cirques, river canyon, and timber chalets.
   */
  public static createAlpineMatterhornComplex(options?: {
    name?: string;
    numViews?: number;
    pointDensity?: number;
  }): Universal3DStructureFoundation {
    const data = buildAlpineMatterhornStructure(options);
    const struct = new Universal3DStructureFoundation({
      name: options?.name || 'alpine_matterhorn_valley',
      anchor: data.anchor,
      mesh: data.mesh,
      materials: data.materials,
      textures: data.textures,
      cameras: data.cameras,
      boundingBox: data.boundingBox,
      tags: ['alpine', 'mountain', 'matterhorn', 'timber_chalet', 'photorealistic', 'canonical-anchor']
    });
    struct.resynchronizePoints(options?.pointDensity ?? 6000);
    return struct;
  }

  /**
   * Factory: Synthesizes a watertight, metric classical architectural structure using
   * the native C++20 Archie Engine (scratchbox_sb_archi.hpp / UniversalArchiBridgeService).
   */
  public static async createArchieStructure(options?: {
    typology?: SupportedArchiTypology;
    name?: string;
    widthMeters?: number;
    heightMeters?: number;
    depthMeters?: number;
    anchor?: GeodeticAnchor;
    pointDensity?: number;
    numViews?: number;
  }): Promise<Universal3DStructureFoundation> {
    const typology = options?.typology || 'triumphal_arch';
    const adapter = ARCHI_TYPOLOGY_ADAPTERS[typology] || ARCHI_TYPOLOGY_ADAPTERS.triumphal_arch;
    const width = options?.widthMeters ?? 25.0;
    const height = options?.heightMeters ?? 21.0;
    const depth = options?.depthMeters ?? 7.5;
    const dimensions: [number, number, number] = [width, height, depth];

    const bridge = new UniversalArchiBridgeService();
    const tempDir = path.resolve(process.cwd(), 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    const tempGlb = path.join(tempDir, `archi_${typology}_${Date.now()}.glb`);

    const result = await bridge.synthesizeStructureFromEntity({
      id: `archi_${typology}_${Date.now()}`,
      name: options?.name || adapter.commonName,
      typology,
      nominalDimensions: dimensions,
      nominalCentroid: [0, height * 0.5, 0]
    }, {
      typologyOverride: typology,
      outputGlbPath: tempGlb
    });

    const glbBuffer = result.glbBuffer || (fs.existsSync(tempGlb) ? fs.readFileSync(tempGlb) : undefined);
    if (fs.existsSync(tempGlb)) {
      try { fs.unlinkSync(tempGlb); } catch {}
    }

    if (glbBuffer) {
      return Universal3DStructureFoundation.createFromGlb(glbBuffer, {
        name: options?.name || adapter.commonName,
        anchor: options?.anchor,
        pointDensity: options?.pointDensity ?? 4000,
        numViews: options?.numViews ?? 24
      });
    }

    throw new Error(`Universal3DStructureFoundation: Failed to synthesize Archie structure for typology '${typology}'`);
  }

  /**
   * Factory: Ingest Scene3DData (from generative-canvas / Adaptive Domain Engine / in-memory edits)
   * into the canonical Universal3DStructureFoundation master anchor.
   *
   * Solves hierarchical scene graph transforms (respecting parentId links), transforms all
   * primitives into unified world coordinates, samples surface constellations with PBR physical
   * properties, sets up calibrated camera poses & trajectories, and wires procedural PBR textures.
   */
  public static createFromScene3DData(
    sceneData: Scene3DData,
    options?: {
      name?: string;
      numViews?: number;
      pointDensity?: number;
      synthesizePbrTextures?: boolean;
      textureResolution?: number;
      anchor?: GeodeticAnchor;
    }
  ): Universal3DStructureFoundation {
    const rawMeshes = sceneData.customMeshes && sceneData.customMeshes.length > 0
      ? sceneData.customMeshes
      : [
          {
            id: 'foundation-slab',
            name: 'Foundation Ground Slab',
            type: 'box' as const,
            position: [0, 0, 0] as [number, number, number],
            rotation: [0, 0, 0] as [number, number, number],
            scale: [10, 0.2, 10] as [number, number, number],
            material: { preset: 'concrete', roughness: 0.8, metalness: 0.1 }
          }
        ];

    // 1. Build Mesh Index Map to resolve hierarchical parenting (parentId)
    const meshMap = new Map<string, typeof rawMeshes[0]>();
    for (const m of rawMeshes) {
      meshMap.set(m.id, m);
    }

    const computeWorldMatrix = (m: typeof rawMeshes[0]): THREE.Matrix4 => {
      const chain: typeof m[] = [m];
      let curr = m;
      const visited = new Set<string>([m.id]);
      while (curr.parentId && meshMap.has(curr.parentId)) {
        if (visited.has(curr.parentId)) break; // cycle protection
        visited.add(curr.parentId);
        curr = meshMap.get(curr.parentId)!;
        chain.unshift(curr);
      }
      const worldMatrix = new THREE.Matrix4();
      for (const node of chain) {
        const p = node.position || [0, 0, 0];
        const r = node.rotation || [0, 0, 0];
        const s = node.scale || [1, 1, 1];
        const nodeMat = new THREE.Matrix4().compose(
          new THREE.Vector3(p[0], p[1], p[2]),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(r[0], r[1], r[2], 'XYZ')),
          new THREE.Vector3(s[0], s[1], s[2])
        );
        worldMatrix.multiply(nodeMat);
      }
      return worldMatrix;
    };

    // 2. Helper to create base Three.js geometry for primitives
    const createBaseGeometry = (type?: string): THREE.BufferGeometry => {
      if (type === 'sphere') return new THREE.SphereGeometry(1, 24, 16);
      if (type === 'cylinder') return new THREE.CylinderGeometry(1, 1, 2, 24);
      if (type === 'cone') return new THREE.ConeGeometry(1, 2, 24);
      if (type === 'plane') return new THREE.PlaneGeometry(2, 2);
      if (type === 'torus') return new THREE.TorusGeometry(1, 0.4, 16, 48);
      // Box default (1x1x1 matches Three.js BoxGeometry convention with half-extents ±0.5)
      return new THREE.BoxGeometry(1, 1, 1);
    };

    // 3. Assemble combined surface mesh across all custom meshes
    const allVertices: number[] = [];
    const allNormals: number[] = [];
    const allUvs: number[] = [];
    const allIndices: number[] = [];
    let vertexOffset = 0;

    const materials: UniversalPbrMaterial[] = [];
    const textures: UniversalTextureMap[] = [];

    // Track color / material attributes for point constellation sampling
    interface MeshInfo {
      worldMatrix: THREE.Matrix4;
      type: string;
      colorRgb: [number, number, number];
      roughness: number;
      metallic: number;
    }
    const meshInfos: MeshInfo[] = [];

    for (let mIdx = 0; mIdx < rawMeshes.length; mIdx++) {
      const def = rawMeshes[mIdx];
      const worldMat = computeWorldMatrix(def);
      const normalMat = new THREE.Matrix3().getNormalMatrix(worldMat);

      const geom = createBaseGeometry(def.type);
      const posAttr = geom.getAttribute('position');
      const normAttr = geom.getAttribute('normal');
      const uvAttr = geom.getAttribute('uv');
      const idxAttr = geom.getIndex();

      const v = new THREE.Vector3();
      const n = new THREE.Vector3();

      for (let i = 0; i < posAttr.count; i++) {
        v.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
        v.applyMatrix4(worldMat);
        allVertices.push(v.x, v.y, v.z);

        if (normAttr) {
          n.set(normAttr.getX(i), normAttr.getY(i), normAttr.getZ(i));
          n.applyMatrix3(normalMat).normalize();
          allNormals.push(n.x, n.y, n.z);
        } else {
          allNormals.push(0, 1, 0);
        }

        if (uvAttr) {
          allUvs.push(uvAttr.getX(i), uvAttr.getY(i));
        } else {
          allUvs.push(0, 0);
        }
      }

      if (idxAttr) {
        for (let i = 0; i < idxAttr.count; i++) {
          allIndices.push(idxAttr.getX(i) + vertexOffset);
        }
      } else {
        for (let i = 0; i < posAttr.count; i++) {
          allIndices.push(i + vertexOffset);
        }
      }

      vertexOffset += posAttr.count;
      geom.dispose();

      // Extract physical material & color
      let baseColorRgb: [number, number, number] = [200, 200, 200];
      let roughness = typeof def.material?.roughness === 'number' ? def.material.roughness : 0.5;
      let metallic = typeof def.material?.metalness === 'number' ? def.material.metalness : 0.1;

      // Check preset
      const presetKey = def.material?.preset as MaterialPresetName | undefined;
      let pbrMat: UniversalPbrMaterial;
      if (presetKey && ['titanium', 'gold', 'chrome', 'basalt', 'oak', 'concrete', 'clay'].includes(presetKey)) {
        pbrMat = Universal3DStructureFoundation.getMaterialPreset(presetKey);
        if (pbrMat.baseColorFactor) {
          baseColorRgb = [
            Math.round((pbrMat.baseColorFactor[0] ?? 0.8) * 255),
            Math.round((pbrMat.baseColorFactor[1] ?? 0.8) * 255),
            Math.round((pbrMat.baseColorFactor[2] ?? 0.8) * 255)
          ];
        }
        roughness = pbrMat.roughnessFactor ?? 0.5;
        metallic = pbrMat.metallicFactor ?? 0.1;
      } else {
        // Parse hex color if specified
        if (typeof def.material?.color === 'number') {
          const c = def.material.color;
          baseColorRgb = [(c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff];
        } else if (typeof def.material?.color === 'string') {
          const str = def.material.color.replace('#', '');
          const parsedInt = parseInt(str, 16);
          if (!isNaN(parsedInt)) {
            baseColorRgb = [(parsedInt >> 16) & 0xff, (parsedInt >> 8) & 0xff, parsedInt & 0xff];
          }
        }
        pbrMat = {
          name: `${def.id}_material`,
          baseColorFactor: [baseColorRgb[0] / 255, baseColorRgb[1] / 255, baseColorRgb[2] / 255, 1.0],
          roughnessFactor: roughness,
          metallicFactor: metallic,
          ior: 1.5
        };
      }

      materials.push(pbrMat);

      meshInfos.push({
        worldMatrix: worldMat,
        type: def.type || 'box',
        colorRgb: baseColorRgb,
        roughness,
        metallic
      });
    }

    const combinedMesh: UniversalSurfaceMesh = {
      vertices: new Float32Array(allVertices),
      normals: new Float32Array(allNormals),
      uvs: new Float32Array(allUvs),
      indices: new Uint32Array(allIndices),
      triangleCount: allIndices.length / 3,
      vertexCount: allVertices.length / 3
    };

    // 4. Bounding Box & Collision Hull
    const bbox = Universal3DStructureFoundation.computeBoundingBox(combinedMesh);

    // 5. Procedural PBR Textures (if requested or by default)
    if (options?.synthesizePbrTextures) {
      const texRes = options.textureResolution || 256;
      // Infer archetype from dominant material
      const hasGold = materials.some(m => m.name.includes('gold') || (typeof m.metallicFactor === 'number' && m.metallicFactor > 0.8 && m.baseColorFactor && (m.baseColorFactor[0] ?? 0) > 0.8));
      const hasMetal = materials.some(m => typeof m.metallicFactor === 'number' && m.metallicFactor > 0.7);
      const hasWood = materials.some(m => m.name.includes('oak') || m.name.includes('wood'));
      const archetype = hasGold ? 'hammered_copper' : hasMetal ? 'brushed_metal' : hasWood ? 'wood' : 'concrete';

      const pbrSet = synthesizeProceduralPbr(archetype, texRes, texRes);
      const albedoId = `tex_scene_albedo_${Date.now()}`;
      const normalId = `tex_scene_normal_${Date.now()}`;
      const ormId = `tex_scene_orm_${Date.now()}`;

      textures.push(
        { id: albedoId, type: 'albedo', width: texRes, height: texRes, channels: 4, buffer: pbrSet.albedoPng, mimeType: 'image/png' },
        { id: normalId, type: 'normal', width: texRes, height: texRes, channels: 4, buffer: pbrSet.normalPng, mimeType: 'image/png' },
        { id: ormId, type: 'metallicRoughness', width: texRes, height: texRes, channels: 4, buffer: pbrSet.ormPng, mimeType: 'image/png' }
      );

      if (materials.length > 0) {
        materials[0].baseColorTextureId = albedoId;
        materials[0].normalTextureId = normalId;
        materials[0].metallicRoughnessTextureId = ormId;
      }
    }

    // 6. Surface Point Constellation Sampling
    const totalPointsToSample = options?.pointDensity ?? 3000;
    const pointsPerMesh = Math.max(Math.floor(totalPointsToSample / meshInfos.length), 50);
    const sampledPoints: ProceduralPoint3D[] = [];
    let ptId = 1;

    for (const info of meshInfos) {
      const shapeType = info.type === 'sphere' ? 'sphere' : info.type === 'cylinder' ? 'cylinder' : info.type === 'torus' ? 'torus' : 'box';
      const primitiveScale = shapeType === 'box' ? 0.5 : 1.0;
      const shapePts = ProceduralSfMDatasetService.sampleProceduralGeometry(shapeType, pointsPerMesh, primitiveScale, [0, 0, 0]);
      const v = new THREE.Vector3();
      const n = new THREE.Vector3();
      const normMat = new THREE.Matrix3().getNormalMatrix(info.worldMatrix);

      for (const p of shapePts) {
        v.set(p.position[0], p.position[1], p.position[2]);
        v.applyMatrix4(info.worldMatrix);

        n.set(p.normal[0], p.normal[1], p.normal[2]);
        n.applyMatrix3(normMat).normalize();

        sampledPoints.push({
          id: ptId++,
          position: [v.x, v.y, v.z],
          normal: [n.x, n.y, n.z],
          color: info.colorRgb,
          error: 0.0,
          roughness: info.roughness,
          metallic: info.metallic
        });
      }
    }

    // 7. Calibrated Observation Rig & Trajectory
    const numViews = options?.numViews ?? 24;
    const radius = Math.max(bbox.boundingSphereRadius * 2.2, 5.0);
    const cameras = ProceduralSfMDatasetService.generateTrajectory({
      trajectory: 'orbital_fibonacci',
      numViews,
      target: bbox.center,
      radius
    });

    // If sceneData has an explicit camera pose, prepend it as View 0
    if (sceneData.camera) {
      const camPos: Vector3Tuple = [sceneData.camera.position[0], sceneData.camera.position[1], sceneData.camera.position[2]];
      const camTgt: Vector3Tuple = [sceneData.camera.target[0], sceneData.camera.target[1], sceneData.camera.target[2]];
      const intrinsics = ProceduralSfMDatasetService.calculateIntrinsics(1920, 1080, sceneData.camera.fov || 60);
      const primaryCam = ProceduralSfMDatasetService.buildCameraPose(0, 'view_primary_camera.png', camPos, camTgt, intrinsics);
      cameras.unshift(primaryCam);
    }

    // 8. Geodetic Anchor
    let anchor: GeodeticAnchor | undefined = options?.anchor;
    if (!anchor && sceneData.geoAnchor) {
      const g = sceneData.geoAnchor as any;
      anchor = {
        lat: typeof g.lat === 'number' ? g.lat : (typeof g.latitude === 'number' ? g.latitude : 0),
        lng: typeof g.lng === 'number' ? g.lng : (typeof g.longitude === 'number' ? g.longitude : 0),
        elevationMeters: typeof g.elevation === 'number' ? g.elevation : (typeof g.altitudeMeters === 'number' ? g.altitudeMeters : 0)
      };
    }

    const struct = new Universal3DStructureFoundation({
      id: `u3d_scene_${Date.now()}`,
      name: options?.name || sceneData.title || 'Scene3D_Universal_Foundation',
      anchor,
      mesh: combinedMesh,
      materials,
      textures,
      points: sampledPoints,
      cameras,
      boundingBox: bbox,
      tags: ['scene3d', sceneData.sceneType || 'adaptive', ...(sceneData.domainOrTopic ? [sceneData.domainOrTopic] : []), 'canonical-anchor'],
      metadata: {
        title: sceneData.title,
        sceneType: sceneData.sceneType,
        domainOrTopic: sceneData.domainOrTopic,
        renderMode: sceneData.renderMode,
        customMeshCount: rawMeshes.length,
        operatorCount: sceneData.operatorStack?.length || 0,
        features: sceneData.features,
        environment: sceneData.environment
      }
    });

    return struct;
  }

  /**
   * Generates a comprehensive project manifest markdown document detailing
   * the 6 synchronized layers of the Universal 3D Structure Foundation:
   * 1. Solid Surface Mesh & Geometric Telemetry
   * 2. Calibrated Observation Rig & Optics
   * 3. Biophysical PBR Materials & Texture Maps
   * 4. Point Constellation & 3DGS Gaussian Seeds
   * 5. Bounding Envelopes & Flight Clearance Hulls
   * 6. Geodetic Spatial Anchor & Real-World Solar Ephemeris
   */
  public generateManifestMarkdown(): string {
    const vertCount = this.mesh.vertexCount || (this.mesh.vertices.length / 3);
    const triCount = this.mesh.triangleCount || (this.mesh.indices ? this.mesh.indices.length / 3 : 0);
    const submeshCount = this.materials.length || 1;
    const box = this.boundingBox;
    const dimX = (box.max[0] - box.min[0]).toFixed(2);
    const dimY = (box.max[1] - box.min[1]).toFixed(2);
    const dimZ = (box.max[2] - box.min[2]).toFixed(2);
    const volume = ((box.max[0] - box.min[0]) * (box.max[1] - box.min[1]) * (box.max[2] - box.min[2])).toFixed(2);

    const anchorSection = this.anchor
      ? `| Parameter | Value |
| :--- | :--- |
| **Latitude** | \`${this.anchor.lat.toFixed(6)}°N\` |
| **Longitude** | \`${this.anchor.lng.toFixed(6)}°E\` |
| **Elevation ASL** | \`${this.anchor.elevationMeters.toFixed(2)} m\` |
| **Heading** | \`${this.anchor.headingDeg !== undefined ? this.anchor.headingDeg.toFixed(1) + '°' : 'N/A'}\` |
| **Landmark / Place** | \`${this.anchor.formattedAddress || this.anchor.placeId || 'Canonical Geodetic Anchor'}\` |`
      : `_No real-world geodetic anchor assigned (Local Tangent Plane coordinates)._`;

    const materialsRows = this.materials.length > 0
      ? this.materials.map(m => {
          const col = m.baseColorFactor ? `[${m.baseColorFactor.map(v => v.toFixed(2)).join(', ')}]` : '[1.00, 1.00, 1.00, 1.00]';
          const met = m.metallicFactor !== undefined ? m.metallicFactor.toFixed(2) : '0.10';
          const rough = m.roughnessFactor !== undefined ? m.roughnessFactor.toFixed(2) : '0.50';
          const tex = [
            m.baseColorTextureId ? 'Albedo' : null,
            m.normalTextureId ? 'Normal' : null,
            m.metallicRoughnessTextureId ? 'ORM' : null,
            m.occlusionTextureId ? 'AO' : null
          ].filter(Boolean).join(', ') || 'Procedural Factor';
          return `| **${m.name}** | \`${col}\` | \`${rough}\` | \`${met}\` | \`${m.alphaMode || 'OPAQUE'}\` | ${tex} |`;
        }).join('\n')
      : `| **DefaultMaterial** | \`[1.00, 1.00, 1.00, 1.00]\` | \`0.50\` | \`0.10\` | \`OPAQUE\` | Procedural Factor |`;

    const texturesRows = this.textures.length > 0
      ? this.textures.map(t => `| \`${t.id}\` | \`${t.type}\` | \`${t.width}x${t.height}\` | \`${t.mimeType}\` | \`${t.buffer ? (t.buffer.length / 1024).toFixed(1) + ' KB' : 'N/A'}\` |`).join('\n')
      : `_No external raster texture files attached (procedural shader shading)._`;

    return `# 3D Scene Project Manifest: ${this.name}

> **Universal 3D Structure Foundation (Single Source of Truth)**
> Canonical 6-layer geometric blueprint for real-time WebGL, 3DGS, neural video diffusion, and photogrammetry.

---

## 1. Scene Overview & Identification
- **Project Structure ID**: \`${this.id}\`
- **Asset Name**: \`${this.name}\`
- **Creation Provenance**: \`Universal3DStructureFoundation (C++20 Astra / Biophysical PBR)\`
- **Standardized glTF Export**: \`${this.name}.glb\`

---

## 2. Geodetic Spatial Anchor (WGS-84)
${anchorSection}

---

## 3. Geometric Telemetry (Solid Metric Mesh)
| Metric | Measurement | Description |
| :--- | :--- | :--- |
| **Vertices** | \`${vertCount.toLocaleString()}\` | Total 3D position, normal, and UV coordinates |
| **Triangles** | \`${triCount.toLocaleString()}\` | Indexed triangular facets |
| **Submeshes** | \`${submeshCount}\` | Distinct material slots and drawing groups |
| **Bounding Box Extents** | \`${dimX}m × ${dimY}m × ${dimZ}m\` | Metric AABB width ($X$), height ($Y$), depth ($Z$) |
| **Enclosed Volume** | \`${volume} m³\` | Spatial bounding volume |
| **Centroid** | \`[${((box.min[0] + box.max[0]) * 0.5).toFixed(2)}, ${((box.min[1] + box.max[1]) * 0.5).toFixed(2)}, ${((box.min[2] + box.max[2]) * 0.5).toFixed(2)}]\` | Center of bounding box in local coordinates |

---

## 4. Calibrated Observation Rig (Cameras)
- **Calibrated Poses**: \`${this.cameras.length}\` viewpoints
- **Camera Intrinsics**:
  - Optical Center: \`(c_x = 0.5, c_y = 0.5)\` (Principal point normalized)
  - Focal Length: \`f = 50.0mm\` equivalent pinhole optics
  - Vertical Field of View: \`~44.0° - 55.0°\`
  - Format Support: Nerfstudio \`transforms.json\` (OpenGL) + COLMAP \`cameras.txt\` / \`images.txt\` (OpenCV)

---

## 5. Biophysical PBR Materials & Textures
| Material Name | Base Color | Roughness | Metallic | Alpha Mode | Texture Maps |
| :--- | :--- | :--- | :--- | :--- | :--- |
${materialsRows}

### Texture Map Assets
${typeof texturesRows === 'string' && texturesRows.startsWith('|') ? '| Texture ID | Type | Dimensions | Format | File Size |\n| :--- | :--- | :--- | :--- | :--- |\n' + texturesRows : texturesRows}

---

## 6. Surface Point Constellation (3DGS Splatting Seeds)
- **Synchronized Points**: \`${this.points.length.toLocaleString()}\` points
- **Point Attributes**: Metric position \`(x, y, z)\`, unit normal \`(nx, ny, nz)\`, bilinear-sampled RGB \`(r, g, b)\`, and surface roughness.
- **Resynchronization Method**: Area-weighted barycentric interpolation across triangle faces with bilinear UV texture sampling (\`resynchronizePoints()\`).

---

## 7. Bounding Envelopes & Flight Clearance Hulls
- **Oriented Bounding Box (OBB)**: Computed via cyclic Jacobi eigenvalue decomposition on covariance tensor.
- **Convex Hull / Safety Bumper**: Inflated safety margin for collision avoidance, camera flight choreography, and physics simulation.

---

## 8. Exported Project File Tree
\`\`\`
projects/${this.name}/
├── ${this.name}.glb                  # Standard binary glTF 2.0 with embedded PBR textures
├── ${this.name}_manifest.md         # Comprehensive project manifest (this document)
├── scene_manifest.md                # Canonical alias for IDE project discovery
├── ${this.name}_video_blockout.json # Catmull-Rom trajectory for Google Omni / Veo (<VIDEO_REF_0>)
├── ${this.name}_collision_hull.obj  # Wavefront OBJ collision envelope
├── ${this.name}_spatial.geojson     # RFC 7946 geodetic camera frustum footprints
├── transforms.json                  # Nerfstudio camera observation rig
├── sparse_pcd.ply                   # 3DGS Gaussian splat point cloud
└── textures/                        # Extracted PBR texture maps (Albedo, ORM, Normal)
\`\`\`
`;
  }

  /**
   * Export all formats at once.
   */
  public exportAll(options?: { collisionOptions?: CollisionEnvelopeOptions }): MultiFormatExportResult {
    const colmap = this.toColmap();
    const nerfstudio = this.toNerfstudio();
    const videoBlockout = this.toVideoCameraBlockout();
    const collisionHull = this.toCollisionHull(options?.collisionOptions);
    const geoJson = this.toGeoJson();
    const glbBuffer = this.toGlbBuffer();
    const manifestMarkdown = this.generateManifestMarkdown();
    const textureFiles: Record<string, string> = {};
    const cameraSolveTrack = this.toCameraSolveTrack();

    const formatsExported: Target3DFormat[] = [
      'glb',
      'colmap',
      'nerfstudio',
      'video_blockout',
      'collision_hull',
      'geojson',
      'manifest'
    ];
    if (this.animations.length > 0 || cameraSolveTrack) {
      formatsExported.push('animation_track');
    }

    return {
      structureId: this.id,
      name: this.name,
      formatsExported,
      colmap,
      nerfstudio,
      videoBlockout,
      collisionHull,
      animations: this.animations,
      cameraSolveTrack,
      geoJson,
      glbBuffer,
      manifestMarkdown,
      textureFiles
    };
  }

  /**
   * Export to disk in target directory.
   */
  public async exportToDisk(
    outputDir: string,
    formats: Target3DFormat[] = ['glb', 'colmap', 'nerfstudio', 'video_blockout', 'collision_hull', 'geojson', 'manifest', 'animation_track'],
    options?: { collisionOptions?: CollisionEnvelopeOptions }
  ): Promise<MultiFormatExportResult> {
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const filesWritten: Record<string, string> = {};
    const result = this.exportAll(options);

    if (formats.includes('glb')) {
      const glbPath = path.join(outputDir, `${this.name}.glb`);
      fs.writeFileSync(glbPath, result.glbBuffer!);
      filesWritten.glb = glbPath;
    }

    // Always generate manifest markdown in project directory
    if (formats.includes('manifest') || true) {
      const manifestPath = path.join(outputDir, `${this.name}_manifest.md`);
      fs.writeFileSync(manifestPath, result.manifestMarkdown!, 'utf8');
      filesWritten.manifest = manifestPath;

      const genericManifestPath = path.join(outputDir, 'scene_manifest.md');
      fs.writeFileSync(genericManifestPath, result.manifestMarkdown!, 'utf8');
      filesWritten.genericManifest = genericManifestPath;
    }

    if (this.textures.length > 0) {
      const texDir = path.join(outputDir, 'textures');
      if (!fs.existsSync(texDir)) {
        fs.mkdirSync(texDir, { recursive: true });
      }
      for (const tex of this.textures) {
        const ext = tex.mimeType === 'image/jpeg' ? 'jpg' : 'png';
        const texPath = path.join(texDir, `${this.name}_${tex.type}.${ext}`);
        let buf = tex.buffer;
        if (tex.mimeType === 'image/raw') {
          buf = encodePng(tex.width, tex.height, tex.buffer);
        }
        fs.writeFileSync(texPath, buf);
        result.textureFiles![tex.id] = texPath;
        filesWritten[`texture_${tex.type}`] = texPath;
      }
    }

    if (formats.includes('colmap')) {
      const colmapDir = path.join(outputDir, 'sparse', '0');
      fs.mkdirSync(colmapDir, { recursive: true });
      const camPath = path.join(colmapDir, 'cameras.txt');
      const imgPath = path.join(colmapDir, 'images.txt');
      const ptsPath = path.join(colmapDir, 'points3D.txt');
      fs.writeFileSync(camPath, result.colmap!.camerasText, 'utf8');
      fs.writeFileSync(imgPath, result.colmap!.imagesText, 'utf8');
      fs.writeFileSync(ptsPath, result.colmap!.points3DText, 'utf8');
      filesWritten.colmapCameras = camPath;
      filesWritten.colmapImages = imgPath;
      filesWritten.colmapPoints = ptsPath;
    }

    if (formats.includes('nerfstudio')) {
      const transPath = path.join(outputDir, 'transforms.json');
      const plyPath = path.join(outputDir, 'sparse_pcd.ply');
      fs.writeFileSync(transPath, result.nerfstudio!.transformsJson, 'utf8');
      fs.writeFileSync(plyPath, result.nerfstudio!.sparsePcdPly, 'utf8');
      filesWritten.nerfTransforms = transPath;
      filesWritten.nerfPcd = plyPath;
    }

    if (formats.includes('video_blockout')) {
      const blockoutPath = path.join(outputDir, `${this.name}_video_blockout.json`);
      fs.writeFileSync(blockoutPath, JSON.stringify(result.videoBlockout, null, 2), 'utf8');
      filesWritten.videoBlockout = blockoutPath;
    }

    if (formats.includes('collision_hull') && result.collisionHull) {
      const hullJsonPath = path.join(outputDir, `${this.name}_collision_hull.json`);
      const hullObjPath = path.join(outputDir, `${this.name}_collision_hull.obj`);
      fs.writeFileSync(hullJsonPath, JSON.stringify(result.collisionHull, null, 2), 'utf8');
      fs.writeFileSync(hullObjPath, Universal3DStructureFoundation.collisionHullToObj(result.collisionHull), 'utf8');
      filesWritten.collisionHullJson = hullJsonPath;
      filesWritten.collisionHullObj = hullObjPath;
    }

    if (formats.includes('animation_track')) {
      if (result.animations && result.animations.length > 0) {
        const animPath = path.join(outputDir, `${this.name}_animations.json`);
        fs.writeFileSync(animPath, JSON.stringify(result.animations, null, 2), 'utf8');
        filesWritten.animations = animPath;
      }
      if (result.cameraSolveTrack) {
        const solvePath = path.join(outputDir, `${this.name}_camera_solve.json`);
        fs.writeFileSync(solvePath, JSON.stringify(result.cameraSolveTrack, null, 2), 'utf8');
        filesWritten.cameraSolve = solvePath;
      }
    }

    if (formats.includes('geojson')) {
      const geoPath = path.join(outputDir, `${this.name}_spatial.geojson`);
      fs.writeFileSync(geoPath, JSON.stringify(result.geoJson, null, 2), 'utf8');
      filesWritten.geoJson = geoPath;
    }

    result.filesWritten = filesWritten;
    return result;
  }
}
