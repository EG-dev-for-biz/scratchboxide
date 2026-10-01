/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import {
  UniversalSurfaceMesh,
  UniversalPbrMaterial,
  UniversalTextureMap,
  MetricBoundingBox
} from '../../common/spatial/universal-3d-structure-types';
import {
  ProceduralCameraPose,
  ProceduralPoint3D,
  ProceduralSfMDatasetService,
  Vector3Tuple
} from './ProceduralSfMDatasetService';
import { GeodeticAnchor } from '../../common/spatial/colmap-vector-reference-types';
import { synthesizeProceduralPbr } from '../texture-processing';

/**
 * Procedural Geometry Mesh Builder helper for accumulating vertices, indices, normals, and UVs.
 */
class MeshAccumulator {
  public vertices: number[] = [];
  public normals: number[] = [];
  public uvs: number[] = [];
  public colors: number[] = [];
  public indices: number[] = [];

  public addVertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number, r = 1, g = 1, b = 1): number {
    const idx = this.vertices.length / 3;
    this.vertices.push(x, y, z);
    this.normals.push(nx, ny, nz);
    this.uvs.push(u, v);
    this.colors.push(r, g, b);
    return idx;
  }

  public addTriangle(i0: number, i1: number, i2: number): void {
    this.indices.push(i0, i1, i2);
  }

  public addQuad(i0: number, i1: number, i2: number, i3: number): void {
    this.indices.push(i0, i1, i2);
    this.indices.push(i0, i2, i3);
  }

  public addBox(
    cx: number, cy: number, cz: number,
    wx: number, wy: number, wz: number,
    r = 1, g = 1, b = 1,
    uvScale = 1
  ): void {
    const hx = wx * 0.5;
    const hy = wy * 0.5;
    const hz = wz * 0.5;

    // +Y Top
    let v0 = this.addVertex(cx - hx, cy + hy, cz - hz, 0, 1, 0, 0, 0, r, g, b);
    let v1 = this.addVertex(cx + hx, cy + hy, cz - hz, 0, 1, 0, uvScale, 0, r, g, b);
    let v2 = this.addVertex(cx + hx, cy + hy, cz + hz, 0, 1, 0, uvScale, uvScale, r, g, b);
    let v3 = this.addVertex(cx - hx, cy + hy, cz + hz, 0, 1, 0, 0, uvScale, r, g, b);
    this.addQuad(v0, v1, v2, v3);

    // -Y Bottom
    v0 = this.addVertex(cx - hx, cy - hy, cz + hz, 0, -1, 0, 0, 0, r, g, b);
    v1 = this.addVertex(cx + hx, cy - hy, cz + hz, 0, -1, 0, uvScale, 0, r, g, b);
    v2 = this.addVertex(cx + hx, cy - hy, cz - hz, 0, -1, 0, uvScale, uvScale, r, g, b);
    v3 = this.addVertex(cx - hx, cy - hy, cz - hz, 0, -1, 0, 0, uvScale, r, g, b);
    this.addQuad(v0, v1, v2, v3);

    // +Z Front
    v0 = this.addVertex(cx - hx, cy - hy, cz + hz, 0, 0, 1, 0, 0, r, g, b);
    v1 = this.addVertex(cx + hx, cy - hy, cz + hz, 0, 0, 1, uvScale, 0, r, g, b);
    v2 = this.addVertex(cx + hx, cy + hy, cz + hz, 0, 0, 1, uvScale, uvScale, r, g, b);
    v3 = this.addVertex(cx - hx, cy + hy, cz + hz, 0, 0, 1, 0, uvScale, r, g, b);
    this.addQuad(v0, v1, v2, v3);

    // -Z Back
    v0 = this.addVertex(cx + hx, cy - hy, cz - hz, 0, 0, -1, 0, 0, r, g, b);
    v1 = this.addVertex(cx - hx, cy - hy, cz - hz, 0, 0, -1, uvScale, 0, r, g, b);
    v2 = this.addVertex(cx - hx, cy + hy, cz - hz, 0, 0, -1, uvScale, uvScale, r, g, b);
    v3 = this.addVertex(cx + hx, cy + hy, cz - hz, 0, 0, -1, 0, uvScale, r, g, b);
    this.addQuad(v0, v1, v2, v3);

    // +X Right
    v0 = this.addVertex(cx + hx, cy - hy, cz + hz, 1, 0, 0, 0, 0, r, g, b);
    v1 = this.addVertex(cx + hx, cy - hy, cz - hz, 1, 0, 0, uvScale, 0, r, g, b);
    v2 = this.addVertex(cx + hx, cy + hy, cz - hz, 1, 0, 0, uvScale, uvScale, r, g, b);
    v3 = this.addVertex(cx + hx, cy + hy, cz + hz, 1, 0, 0, 0, uvScale, r, g, b);
    this.addQuad(v0, v1, v2, v3);

    // -X Left
    v0 = this.addVertex(cx - hx, cy - hy, cz - hz, -1, 0, 0, 0, 0, r, g, b);
    v1 = this.addVertex(cx - hx, cy - hy, cz + hz, -1, 0, 0, uvScale, 0, r, g, b);
    v2 = this.addVertex(cx - hx, cy + hy, cz + hz, -1, 0, 0, uvScale, uvScale, r, g, b);
    v3 = this.addVertex(cx - hx, cy + hy, cz - hz, -1, 0, 0, 0, uvScale, r, g, b);
    this.addQuad(v0, v1, v2, v3);
  }

  public toSurfaceMesh(): UniversalSurfaceMesh {
    return {
      vertices: new Float32Array(this.vertices),
      normals: new Float32Array(this.normals),
      uvs: new Float32Array(this.uvs),
      colors: new Float32Array(this.colors),
      indices: new Uint32Array(this.indices),
      vertexCount: this.vertices.length / 3,
      triangleCount: this.indices.length / 3
    };
  }
}

/**
 * Computes tight metric bounding box for a mesh.
 */
function computeBoundingBox(mesh: UniversalSurfaceMesh): MetricBoundingBox {
  const v = mesh.vertices;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (let i = 0; i < v.length; i += 3) {
    const x = v[i], y = v[i + 1], z = v[i + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }

  const cx = (minX + maxX) * 0.5;
  const cy = (minY + maxY) * 0.5;
  const cz = (minZ + maxZ) * 0.5;
  const ex = (maxX - minX) * 0.5;
  const ey = (maxY - minY) * 0.5;
  const ez = (maxZ - minZ) * 0.5;

  return {
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
    center: [cx, cy, cz],
    extents: [ex, ey, ez],
    boundingSphereRadius: Math.sqrt(ex * ex + ey * ey + ez * ez)
  };
}

/**
 * Generator for the complex Babylonian Ziggurat of Etemenanki & Astrolabe Observatory.
 */
export function buildBabylonianZigguratStructure(options?: {
  name?: string;
  numViews?: number;
}): {
  mesh: UniversalSurfaceMesh;
  materials: UniversalPbrMaterial[];
  textures: UniversalTextureMap[];
  cameras: ProceduralCameraPose[];
  boundingBox: MetricBoundingBox;
  anchor: GeodeticAnchor;
} {
  const name = options?.name || 'babylonian_ziggurat_observatory';
  const acc = new MeshAccumulator();

  // ==========================================
  // 1. TIER 1: Massive Sloped Mudbrick Platform
  // ==========================================
  const t1W = 32, t1L = 26, t1H = 6.5;
  acc.addBox(0, t1H * 0.5, 0, t1W, t1H, t1L, 0.74, 0.59, 0.43, 4.0);

  // 14 Rectangular Buttresses along Tier 1 walls
  const buttressCountX = 5;
  for (let i = 0; i < buttressCountX; i++) {
    const bx = -t1W * 0.4 + i * (t1W * 0.8 / (buttressCountX - 1));
    acc.addBox(bx, t1H * 0.5, t1L * 0.5 + 0.6, 2.2, t1H + 0.2, 1.2, 0.68, 0.54, 0.38, 2.0);
    acc.addBox(bx, t1H * 0.5, -t1L * 0.5 - 0.6, 2.2, t1H + 0.2, 1.2, 0.68, 0.54, 0.38, 2.0);
  }
  const buttressCountZ = 4;
  for (let i = 0; i < buttressCountZ; i++) {
    const bz = -t1L * 0.35 + i * (t1L * 0.7 / (buttressCountZ - 1));
    acc.addBox(t1W * 0.5 + 0.6, t1H * 0.5, bz, 1.2, t1H + 0.2, 2.2, 0.68, 0.54, 0.38, 2.0);
    acc.addBox(-t1W * 0.5 - 0.6, t1H * 0.5, bz, 1.2, t1H + 0.2, 2.2, 0.68, 0.54, 0.38, 2.0);
  }

  // ==========================================
  // 2. MONUMENTAL CENTRAL AXIAL STAIRCASE
  // ==========================================
  const numSteps = 28;
  const stairWidth = 4.2;
  const stairRun = 14.0;
  const stairHeight = t1H + 4.8;
  for (let s = 0; s < numSteps; s++) {
    const t = s / numSteps;
    const sy = t * stairHeight;
    const sz = t1L * 0.5 + (1.0 - t) * stairRun;
    const stepDepth = (stairRun / numSteps) * 1.05;
    const stepRise = stairHeight / numSteps;
    acc.addBox(0, sy + stepRise * 0.5, sz, stairWidth, stepRise, stepDepth, 0.78, 0.64, 0.48, 1.0);
  }

  // Flanking Parapet Walls for Central Stairs
  acc.addBox(-stairWidth * 0.5 - 0.3, stairHeight * 0.45, t1L * 0.5 + stairRun * 0.5, 0.6, stairHeight * 0.9, stairRun, 0.70, 0.55, 0.40, 3.0);
  acc.addBox(stairWidth * 0.5 + 0.3, stairHeight * 0.45, t1L * 0.5 + stairRun * 0.5, 0.6, stairHeight * 0.9, stairRun, 0.70, 0.55, 0.40, 3.0);

  // Symmetrical Flanking Wing Staircases
  const wingSteps = 18;
  for (let s = 0; s < wingSteps; s++) {
    const t = s / wingSteps;
    const sy = t * t1H;
    const sxL = -t1W * 0.5 + t * (t1W * 0.5 - stairWidth * 0.6);
    const sxR = t1W * 0.5 - t * (t1W * 0.5 - stairWidth * 0.6);
    const sz = t1L * 0.5 + 1.2;
    acc.addBox(sxL, sy + (t1H / wingSteps) * 0.5, sz, 2.0, t1H / wingSteps, 2.4, 0.76, 0.62, 0.46, 1.0);
    acc.addBox(sxR, sy + (t1H / wingSteps) * 0.5, sz, 2.0, t1H / wingSteps, 2.4, 0.76, 0.62, 0.46, 1.0);
  }

  // ==========================================
  // 3. TIER 2: Glazed Lapis Lazuli Brick Terrace
  // ==========================================
  const t2W = 20, t2L = 16, t2H = 4.8;
  const t2Y = t1H + t2H * 0.5;
  acc.addBox(0, t2Y, 0, t2W, t2H, t2L, 0.10, 0.24, 0.68, 3.0);

  // Glazed Brick Parapet & Battlements
  acc.addBox(0, t1H + t2H + 0.5, t2L * 0.5, t2W, 1.0, 0.6, 0.08, 0.20, 0.62, 2.0);
  acc.addBox(0, t1H + t2H + 0.5, -t2L * 0.5, t2W, 1.0, 0.6, 0.08, 0.20, 0.62, 2.0);
  acc.addBox(t2W * 0.5, t1H + t2H + 0.5, 0, 0.6, 1.0, t2L, 0.08, 0.20, 0.62, 2.0);
  acc.addBox(-t2W * 0.5, t1H + t2H + 0.5, 0, 0.6, 1.0, t2L, 0.08, 0.20, 0.62, 2.0);

  // Arched Portal Gateway to Shrine
  acc.addBox(0, t1H + t2H * 0.5, t2L * 0.5 + 0.5, 5.0, 4.0, 1.0, 0.12, 0.28, 0.74, 1.5);
  acc.addBox(0, t1H + 1.8, t2L * 0.5 + 0.6, 2.8, 3.6, 0.8, 0.05, 0.05, 0.08, 1.0); // Shadow entrance void

  // ==========================================
  // 4. TIER 3: Summit Gold Sanctuary Shrine
  // ==========================================
  const t3W = 11, t3L = 9, t3H = 3.8;
  const t3Y = t1H + t2H + t3H * 0.5;
  acc.addBox(0, t3Y, 0, t3W, t3H, t3L, 0.98, 0.82, 0.26, 2.0);

  // Overhanging Egyptian-Gorge Cornice on Gold Shrine
  acc.addBox(0, t1H + t2H + t3H + 0.3, 0, t3W + 1.2, 0.6, t3L + 1.2, 1.0, 0.86, 0.32, 2.0);

  // ==========================================
  // 5. SUMMIT ARMILLARY ASTROLABE OBSERVATORY
  // ==========================================
  const astrolabeBaseY = t1H + t2H + t3H + 0.6;
  // Circular stepped plinth (approximated with octagonal prism)
  const plinthRad = 2.4, plinthH = 0.8;
  const numSides = 12;
  for (let i = 0; i < numSides; i++) {
    const a0 = (i * Math.PI * 2) / numSides;
    const a1 = ((i + 1) * Math.PI * 2) / numSides;
    const x0 = Math.cos(a0) * plinthRad, z0 = Math.sin(a0) * plinthRad;
    const x1 = Math.cos(a1) * plinthRad, z1 = Math.sin(a1) * plinthRad;
    const v0 = acc.addVertex(0, astrolabeBaseY + plinthH, 0, 0, 1, 0, 0.5, 0.5, 0.85, 0.85, 0.88);
    const v1 = acc.addVertex(x0, astrolabeBaseY + plinthH, z0, 0, 1, 0, 0.5 + x0 * 0.2, 0.5 + z0 * 0.2, 0.85, 0.85, 0.88);
    const v2 = acc.addVertex(x1, astrolabeBaseY + plinthH, z1, 0, 1, 0, 0.5 + x1 * 0.2, 0.5 + z1 * 0.2, 0.85, 0.85, 0.88);
    acc.addTriangle(v0, v1, v2);

    const vSide0 = acc.addVertex(x0, astrolabeBaseY, z0, x0, 0, z0, 0, 0, 0.8, 0.8, 0.82);
    const vSide1 = acc.addVertex(x1, astrolabeBaseY, z1, x1, 0, z1, 1, 0, 0.8, 0.8, 0.82);
    const vSide2 = acc.addVertex(x1, astrolabeBaseY + plinthH, z1, x1, 0, z1, 1, 1, 0.8, 0.8, 0.82);
    const vSide3 = acc.addVertex(x0, astrolabeBaseY + plinthH, z0, x0, 0, z0, 0, 1, 0.8, 0.8, 0.82);
    acc.addQuad(vSide0, vSide1, vSide2, vSide3);
  }

  // Astrolabe Bronze Armillary Rings
  const ringCenterY = astrolabeBaseY + plinthH + 1.8;
  const ringRad = 2.0;
  const ringSegs = 24;
  for (let i = 0; i < ringSegs; i++) {
    const a0 = (i * Math.PI * 2) / ringSegs;
    const a1 = ((i + 1) * Math.PI * 2) / ringSegs;
    // Meridian Ring (Vertical in Y-Z plane)
    acc.addBox(
      0, ringCenterY + Math.sin((a0 + a1) * 0.5) * ringRad, Math.cos((a0 + a1) * 0.5) * ringRad,
      0.18, 0.18, (2 * Math.PI * ringRad) / ringSegs * 1.1,
      0.34, 0.46, 0.38, 1.0
    );
    // Equatorial Ring (Horizontal in X-Z plane tilted 30 deg)
    const rx = Math.cos((a0 + a1) * 0.5) * ringRad * 0.95;
    const rz = Math.sin((a0 + a1) * 0.5) * ringRad * 0.95;
    const ry = ringCenterY + rx * 0.5;
    acc.addBox(rx, ry, rz, 0.18, 0.18, (2 * Math.PI * ringRad) / ringSegs * 1.1, 0.36, 0.48, 0.40, 1.0);
  }
  // Central Golden Celestial Sphere
  acc.addBox(0, ringCenterY, 0, 0.8, 0.8, 0.8, 0.98, 0.85, 0.30, 1.0);

  // ==========================================
  // 6. CORNER FIRE BRAZIER CAULDRONS
  // ==========================================
  const brazierOffsets = [
    [-t2W * 0.45, t1H + t2H, -t2L * 0.45],
    [t2W * 0.45, t1H + t2H, -t2L * 0.45],
    [-t2W * 0.45, t1H + t2H, t2L * 0.45],
    [t2W * 0.45, t1H + t2H, t2L * 0.45]
  ];
  for (const [bx, by, bz] of brazierOffsets) {
    // Tripod Legs
    acc.addBox(bx - 0.4, by + 0.6, bz - 0.4, 0.14, 1.2, 0.14, 0.28, 0.38, 0.32, 1.0);
    acc.addBox(bx + 0.4, by + 0.6, bz - 0.4, 0.14, 1.2, 0.14, 0.28, 0.38, 0.32, 1.0);
    acc.addBox(bx, by + 0.6, bz + 0.4, 0.14, 1.2, 0.14, 0.28, 0.38, 0.32, 1.0);
    // Bronze Cauldron Bowl
    acc.addBox(bx, by + 1.2, bz, 1.4, 0.5, 1.4, 0.32, 0.42, 0.36, 1.0);
    // Glowing Emissive Fire Ember Core
    acc.addBox(bx, by + 1.5, bz, 0.9, 0.4, 0.9, 1.0, 0.58, 0.12, 1.0);
  }

  const mesh = acc.toSurfaceMesh();
  const bbox = computeBoundingBox(mesh);

  // ==========================================
  // MATERIALS & TEXTURES
  // ==========================================
  const mudbrickPbr = synthesizeProceduralPbr('concrete', 512, 512);
  const lapisPbr = synthesizeProceduralPbr('chipped_paint', 512, 512);
  const goldPbr = synthesizeProceduralPbr('hammered_copper', 512, 512);

  const textures: UniversalTextureMap[] = [
    {
      id: `${name}_mudbrick_albedo`,
      type: 'albedo',
      width: 512,
      height: 512,
      channels: 4,
      buffer: mudbrickPbr.albedoPng,
      mimeType: 'image/png'
    },
    {
      id: `${name}_mudbrick_orm`,
      type: 'metallicRoughness',
      width: 512,
      height: 512,
      channels: 4,
      buffer: mudbrickPbr.ormPng,
      mimeType: 'image/png'
    },
    {
      id: `${name}_mudbrick_normal`,
      type: 'normal',
      width: 512,
      height: 512,
      channels: 4,
      buffer: mudbrickPbr.normalPng,
      mimeType: 'image/png'
    },
    {
      id: `${name}_lapis_albedo`,
      type: 'albedo',
      width: 512,
      height: 512,
      channels: 4,
      buffer: lapisPbr.albedoPng,
      mimeType: 'image/png'
    },
    {
      id: `${name}_gold_albedo`,
      type: 'albedo',
      width: 512,
      height: 512,
      channels: 4,
      buffer: goldPbr.albedoPng,
      mimeType: 'image/png'
    }
  ];

  const materials: UniversalPbrMaterial[] = [
    {
      name: 'BabylonianMudbrick',
      baseColorFactor: [0.74, 0.59, 0.43, 1.0],
      roughnessFactor: 0.88,
      metallicFactor: 0.02,
      baseColorTextureId: `${name}_mudbrick_albedo`,
      metallicRoughnessTextureId: `${name}_mudbrick_orm`,
      normalTextureId: `${name}_mudbrick_normal`
    },
    {
      name: 'GlazedLapisLazuli',
      baseColorFactor: [0.10, 0.24, 0.68, 1.0],
      roughnessFactor: 0.22,
      metallicFactor: 0.15,
      baseColorTextureId: `${name}_lapis_albedo`
    },
    {
      name: 'BeatenGoldLeaf',
      baseColorFactor: [0.98, 0.82, 0.26, 1.0],
      roughnessFactor: 0.26,
      metallicFactor: 0.94,
      baseColorTextureId: `${name}_gold_albedo`
    },
    {
      name: 'PatinatedBronze',
      baseColorFactor: [0.34, 0.46, 0.38, 1.0],
      roughnessFactor: 0.44,
      metallicFactor: 0.80
    },
    {
      name: 'BrazierFlame',
      baseColorFactor: [1.0, 0.58, 0.12, 1.0],
      roughnessFactor: 0.1,
      metallicFactor: 0.0,
      emissiveFactor: [1.0, 0.55, 0.1],
      emissiveStrength: 5.0
    }
  ];

  // ==========================================
  // CAMERAS: Exact vantage matching scene_2_photorealistic_final.png
  // ==========================================
  const numViews = options?.numViews ?? 24;
  const heroIntrinsics = ProceduralSfMDatasetService.calculateIntrinsics(1920, 1080, 50.0);
  const cameras: ProceduralCameraPose[] = [
    // Hero View matching ground truth scene_2_photorealistic_final.png
    ProceduralSfMDatasetService.buildCameraPose(
      0,
      'hero_photorealistic_vantage',
      [-12.6, 13.1, 18.7],
      [0.0, 2.1, 0.0],
      heroIntrinsics,
      [0.0, 1.0, 0.0]
    ),
    // 24 Orbital Survey poses
    ...ProceduralSfMDatasetService.generateTrajectory({
      trajectory: 'orbital_fibonacci',
      numViews: numViews - 1,
      target: [0, bbox.extents[1] * 0.8, 0],
      radius: bbox.boundingSphereRadius * 1.8
    })
  ];

  const anchor: GeodeticAnchor = {
    lat: 32.5363,
    lng: 44.4208,
    elevationMeters: 25.0,
    headingDeg: 12.0,
    formattedAddress: 'Ziggurat of Etemenanki, Babylon, Babil Governorate, Iraq'
  };

  return { mesh, materials, textures, cameras, boundingBox: bbox, anchor };
}

/**
 * Generator for the complex Alpine Mountain Valley with Matterhorn Pyramidal Peak,
 * Meandering River Canyon, and Traditional Swiss Chalets.
 */
export function buildAlpineMatterhornStructure(options?: {
  name?: string;
  numViews?: number;
}): {
  mesh: UniversalSurfaceMesh;
  materials: UniversalPbrMaterial[];
  textures: UniversalTextureMap[];
  cameras: ProceduralCameraPose[];
  boundingBox: MetricBoundingBox;
  anchor: GeodeticAnchor;
} {
  const name = options?.name || 'alpine_matterhorn_valley';
  const acc = new MeshAccumulator();

  // ==========================================
  // 1. TOPOGRAPHICAL TERRAIN & GLACIAL CANYON (70% Primary Form)
  // Grid 96x96 spanning 120m x 120m
  // ==========================================
  const gridRes = 96;
  const worldSize = 120.0;
  const step = worldSize / (gridRes - 1);
  const halfSize = worldSize * 0.5;

  // Simple deterministic pseudo-random noise for continuous FBM
  function noise2D(x: number, z: number): number {
    const s = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
    return s - Math.floor(s);
  }

  function smoothNoise(x: number, z: number): number {
    const ix = Math.floor(x);
    const iz = Math.floor(z);
    const fx = x - ix;
    const fz = z - iz;
    const sx = fx * fx * (3.0 - 2.0 * fx);
    const sz = fz * fz * (3.0 - 2.0 * fz);

    const n00 = noise2D(ix, iz);
    const n10 = noise2D(ix + 1, iz);
    const n01 = noise2D(ix, iz + 1);
    const n11 = noise2D(ix + 1, iz + 1);

    const nx0 = n00 * (1 - sx) + n10 * sx;
    const nx1 = n01 * (1 - sx) + n11 * sx;
    return nx0 * (1 - sz) + nx1 * sz;
  }

  function fbm(x: number, z: number, octaves = 4): number {
    let val = 0;
    let amp = 0.5;
    let freq = 1.0;
    for (let o = 0; o < octaves; o++) {
      val += smoothNoise(x * freq, z * freq) * amp;
      freq *= 2.05;
      amp *= 0.5;
    }
    return val;
  }

  // Terrain height function H(x, z)
  function getTerrainHeight(x: number, z: number): number {
    // Meandering river centerline x_r(z)
    const xr = 14.0 * Math.sin(z * 0.04) + 4.0 * Math.cos(z * 0.1);
    const distToRiver = Math.abs(x - xr);

    // River depression
    const riverTrough = -3.2 * Math.exp(-Math.pow(distToRiver / 4.5, 2));

    // Forehills undulating moraine
    const moraine = fbm(x * 0.025 + 5.0, z * 0.025 + 5.0, 4) * 5.0;

    // Matterhorn Peak in the background (z < -10)
    let mountain = 0;
    if (z < 10) {
      const peakX = -12.0;
      const peakZ = -46.0;
      const dx = x - peakX;
      const dz = z - peakZ;
      const distToPeak = Math.sqrt(dx * dx + dz * dz);
      const angle = Math.atan2(dz, dx);

      // Pyramidal 4-ridge horn modulation
      const ridgeMod = Math.pow(Math.abs(Math.sin(angle * 2.0)), 0.6) * 0.35 + 0.65;
      const hornProfile = Math.max(0, 1.0 - distToPeak / 48.0);
      const peakElevation = Math.pow(hornProfile, 2.2) * 36.0 * ridgeMod;

      // Serrated knife-edge arêtes noise
      const rockRelief = fbm(x * 0.12, z * 0.12, 3) * 4.5 * hornProfile;
      mountain = peakElevation + rockRelief;
    }

    // Left & Right Valley Canyon Walls
    const valleyWallL = Math.max(0, (-x - 22.0) * 0.45);
    const valleyWallR = Math.max(0, (x - 24.0) * 0.45);

    return moraine + riverTrough + mountain + valleyWallL + valleyWallR;
  }

  // Generate grid vertices
  const gridIndices: number[][] = [];
  for (let j = 0; j < gridRes; j++) {
    gridIndices[j] = [];
    const z = -halfSize + j * step;
    for (let i = 0; i < gridRes; i++) {
      const x = -halfSize + i * step;
      const y = getTerrainHeight(x, z);

      // Analytical normal via central difference
      const delta = 0.5;
      const yL = getTerrainHeight(x - delta, z);
      const yR = getTerrainHeight(x + delta, z);
      const yD = getTerrainHeight(x, z - delta);
      const yU = getTerrainHeight(x, z + delta);
      let nx = yL - yR;
      let ny = 2.0 * delta;
      let nz = yD - yU;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1.0;
      nx /= len; ny /= len; nz /= len;

      const u = i / (gridRes - 1);
      const v = j / (gridRes - 1);

      // Vertex color blending: grass green -> rock grey -> snow white
      let r = 0.28, g = 0.42, b = 0.16; // meadow grass
      if (y > 22.0) {
        // High snow peak
        r = 0.96; g = 0.98; b = 1.0;
      } else if (y > 11.0 || ny < 0.65) {
        // Rock cliff / scree
        r = 0.38; g = 0.37; b = 0.36;
      }

      const idx = acc.addVertex(x, y, z, nx, ny, nz, u * 12.0, v * 12.0, r, g, b);
      gridIndices[j][i] = idx;
    }
  }

  // Generate grid triangle faces
  for (let j = 0; j < gridRes - 1; j++) {
    for (let i = 0; i < gridRes - 1; i++) {
      const i0 = gridIndices[j][i];
      const i1 = gridIndices[j][i + 1];
      const i2 = gridIndices[j + 1][i + 1];
      const i3 = gridIndices[j + 1][i];
      acc.addQuad(i0, i1, i2, i3);
    }
  }

  // ==========================================
  // 2. MEANDERING GLACIAL RIVER WATER MESH
  // ==========================================
  const riverSegs = 48;
  const riverWidth = 7.0;
  for (let s = 0; s < riverSegs - 1; s++) {
    const t0 = s / (riverSegs - 1);
    const t1 = (s + 1) / (riverSegs - 1);
    const z0 = -halfSize * 0.9 + t0 * (worldSize * 0.9);
    const z1 = -halfSize * 0.9 + t1 * (worldSize * 0.9);
    const xr0 = 14.0 * Math.sin(z0 * 0.04) + 4.0 * Math.cos(z0 * 0.1);
    const xr1 = 14.0 * Math.sin(z1 * 0.04) + 4.0 * Math.cos(z1 * 0.1);
    const y0 = getTerrainHeight(xr0, z0) + 0.3;
    const y1 = getTerrainHeight(xr1, z1) + 0.3;

    const v0 = acc.addVertex(xr0 - riverWidth * 0.5, y0, z0, 0, 1, 0, 0, t0 * 6.0, 0.20, 0.70, 0.88);
    const v1 = acc.addVertex(xr0 + riverWidth * 0.5, y0, z0, 0, 1, 0, 1, t0 * 6.0, 0.20, 0.70, 0.88);
    const v2 = acc.addVertex(xr1 + riverWidth * 0.5, y1, z1, 0, 1, 0, 1, t1 * 6.0, 0.20, 0.70, 0.88);
    const v3 = acc.addVertex(xr1 - riverWidth * 0.5, y1, z1, 0, 1, 0, 0, t1 * 6.0, 0.20, 0.70, 0.88);
    acc.addQuad(v0, v1, v2, v3);
  }

  // ==========================================
  // 3. TRADITIONAL SWISS CHALET HAMLET (20% Secondary Form)
  // 5 Detailed Chalets with stone plinths, timber logs, gables & chimneys
  // ==========================================
  const chalets = [
    { x: -14.0, z: 12.0, w: 5.8, l: 7.2, h: 3.4, rot: 0.25 },
    { x: 12.0, z: 18.0, w: 6.2, l: 8.0, h: 3.6, rot: -0.35 },
    { x: -6.0, z: 24.0, w: 5.2, l: 6.4, h: 3.2, rot: 0.10 },
    { x: 18.0, z: 5.0, w: 5.6, l: 6.8, h: 3.4, rot: -0.50 },
    { x: -22.0, z: -2.0, w: 6.0, l: 7.5, h: 3.5, rot: 0.40 }
  ];

  for (const c of chalets) {
    const groundY = getTerrainHeight(c.x, c.z);
    const plinthH = 1.4;

    // Fieldstone Plinth Base
    acc.addBox(c.x, groundY + plinthH * 0.5, c.z, c.w + 0.4, plinthH, c.l + 0.4, 0.45, 0.42, 0.38, 2.0);

    // Squared Timber Log Wall Body
    const bodyY = groundY + plinthH + c.h * 0.5;
    acc.addBox(c.x, bodyY, c.z, c.w, c.h, c.l, 0.34, 0.22, 0.14, 2.0);

    // Pitched Gable Roof with Overhanging Eaves
    const roofY = groundY + plinthH + c.h;
    const roofEaves = 1.2;
    const roofW = c.w + roofEaves * 2;
    const roofL = c.l + roofEaves * 2;
    const roofRidgeH = 2.4;

    // Left Roof Slope
    const vL0 = acc.addVertex(c.x - roofW * 0.5, roofY, c.z - roofL * 0.5, -0.6, 0.8, 0, 0, 0, 0.22, 0.18, 0.15);
    const vL1 = acc.addVertex(c.x, roofY + roofRidgeH, c.z - roofL * 0.5, -0.6, 0.8, 0, 1, 0, 0.22, 0.18, 0.15);
    const vL2 = acc.addVertex(c.x, roofY + roofRidgeH, c.z + roofL * 0.5, -0.6, 0.8, 0, 1, 1, 0.22, 0.18, 0.15);
    const vL3 = acc.addVertex(c.x - roofW * 0.5, roofY, c.z + roofL * 0.5, -0.6, 0.8, 0, 0, 1, 0.22, 0.18, 0.15);
    acc.addQuad(vL0, vL1, vL2, vL3);

    // Right Roof Slope
    const vR0 = acc.addVertex(c.x, roofY + roofRidgeH, c.z - roofL * 0.5, 0.6, 0.8, 0, 0, 0, 0.22, 0.18, 0.15);
    const vR1 = acc.addVertex(c.x + roofW * 0.5, roofY, c.z - roofL * 0.5, 0.6, 0.8, 0, 1, 0, 0.22, 0.18, 0.15);
    const vR2 = acc.addVertex(c.x + roofW * 0.5, roofY, c.z + roofL * 0.5, 0.6, 0.8, 0, 1, 1, 0.22, 0.18, 0.15);
    const vR3 = acc.addVertex(c.x, roofY + roofRidgeH, c.z + roofL * 0.5, 0.6, 0.8, 0, 0, 1, 0.22, 0.18, 0.15);
    acc.addQuad(vR0, vR1, vR2, vR3);

    // Granite Chimneystack
    acc.addBox(c.x + c.w * 0.25, roofY + roofRidgeH * 0.6, c.z - c.l * 0.2, 0.8, roofRidgeH + 1.0, 0.8, 0.40, 0.38, 0.36, 1.0);

    // Timber Balcony with Railings
    acc.addBox(c.x, groundY + plinthH + 1.2, c.z + c.l * 0.5 + 0.6, c.w * 0.9, 0.18, 1.2, 0.42, 0.28, 0.18, 1.0);
    acc.addBox(c.x, groundY + plinthH + 1.8, c.z + c.l * 0.5 + 1.1, c.w * 0.9, 0.9, 0.1, 0.38, 0.24, 0.14, 1.0);

    // Illuminated Multi-Pane Windows (Warm Emissive Amber Glow)
    acc.addBox(c.x - c.w * 0.25, groundY + plinthH + 1.8, c.z + c.l * 0.5 + 0.05, 1.0, 1.2, 0.1, 1.0, 0.85, 0.45, 1.0);
    acc.addBox(c.x + c.w * 0.25, groundY + plinthH + 1.8, c.z + c.l * 0.5 + 0.05, 1.0, 1.2, 0.1, 1.0, 0.85, 0.45, 1.0);
  }

  // ==========================================
  // 4. STRATIFIED ALPINE SPRUCE FOREST (10% Tertiary Form)
  // Multi-tier spruce trees on valley slopes
  // ==========================================
  const treePositions = [
    [-24, 16], [-28, 8], [-22, 2], [-18, -8], [-26, -16],
    [24, 22], [28, 14], [22, 8], [26, -4], [30, -14],
    [-8, 32], [6, 30], [-14, -22], [14, -24], [-4, -30]
  ];

  for (const [tx, tz] of treePositions) {
    const ty = getTerrainHeight(tx, tz);
    if (ty < 18.0) {
      // Trunk
      acc.addBox(tx, ty + 1.5, tz, 0.5, 3.0, 0.5, 0.28, 0.18, 0.12, 1.0);

      // 3 Tiered Foliage Cones (approximated with octagons)
      const tiers = [
        { y: ty + 2.5, rad: 2.8, h: 2.2 },
        { y: ty + 4.2, rad: 2.1, h: 2.0 },
        { y: ty + 5.8, rad: 1.3, h: 1.8 }
      ];
      for (const tier of tiers) {
        const segs = 8;
        for (let i = 0; i < segs; i++) {
          const a0 = (i * Math.PI * 2) / segs;
          const a1 = ((i + 1) * Math.PI * 2) / segs;
          const x0 = tx + Math.cos(a0) * tier.rad;
          const z0 = tz + Math.sin(a0) * tier.rad;
          const x1 = tx + Math.cos(a1) * tier.rad;
          const z1 = tz + Math.sin(a1) * tier.rad;

          const apex = acc.addVertex(tx, tier.y + tier.h, tz, 0, 1, 0, 0.5, 1.0, 0.12, 0.28, 0.14);
          const v0 = acc.addVertex(x0, tier.y, z0, Math.cos(a0), 0.3, Math.sin(a0), 0, 0, 0.12, 0.28, 0.14);
          const v1 = acc.addVertex(x1, tier.y, z1, Math.cos(a1), 0.3, Math.sin(a1), 1, 0, 0.12, 0.28, 0.14);
          acc.addTriangle(apex, v0, v1);
        }
      }
    }
  }

  const mesh = acc.toSurfaceMesh();
  const bbox = computeBoundingBox(mesh);

  // ==========================================
  // MATERIALS & TEXTURES
  // ==========================================
  const rockPbr = synthesizeProceduralPbr('concrete', 512, 512);
  const woodPbr = synthesizeProceduralPbr('wood', 512, 512);

  const textures: UniversalTextureMap[] = [
    {
      id: `${name}_rock_albedo`,
      type: 'albedo',
      width: 512,
      height: 512,
      channels: 4,
      buffer: rockPbr.albedoPng,
      mimeType: 'image/png'
    },
    {
      id: `${name}_rock_orm`,
      type: 'metallicRoughness',
      width: 512,
      height: 512,
      channels: 4,
      buffer: rockPbr.ormPng,
      mimeType: 'image/png'
    },
    {
      id: `${name}_rock_normal`,
      type: 'normal',
      width: 512,
      height: 512,
      channels: 4,
      buffer: rockPbr.normalPng,
      mimeType: 'image/png'
    },
    {
      id: `${name}_wood_albedo`,
      type: 'albedo',
      width: 512,
      height: 512,
      channels: 4,
      buffer: woodPbr.albedoPng,
      mimeType: 'image/png'
    }
  ];

  const materials: UniversalPbrMaterial[] = [
    {
      name: 'MatterhornGneiss',
      baseColorFactor: [0.38, 0.37, 0.36, 1.0],
      roughnessFactor: 0.88,
      metallicFactor: 0.08,
      baseColorTextureId: `${name}_rock_albedo`,
      metallicRoughnessTextureId: `${name}_rock_orm`,
      normalTextureId: `${name}_rock_normal`
    },
    {
      name: 'MatterhornSnow',
      baseColorFactor: [0.96, 0.98, 1.0, 1.0],
      roughnessFactor: 0.52,
      metallicFactor: 0.02
    },
    {
      name: 'AgedLarchTimber',
      baseColorFactor: [0.34, 0.22, 0.14, 1.0],
      roughnessFactor: 0.76,
      metallicFactor: 0.04,
      baseColorTextureId: `${name}_wood_albedo`
    },
    {
      name: 'ChaletCedarRoof',
      baseColorFactor: [0.22, 0.18, 0.15, 1.0],
      roughnessFactor: 0.84,
      metallicFactor: 0.02
    },
    {
      name: 'AlpineMeadowTurf',
      baseColorFactor: [0.28, 0.42, 0.16, 1.0],
      roughnessFactor: 0.90,
      metallicFactor: 0.02
    },
    {
      name: 'GlacialRiver',
      baseColorFactor: [0.20, 0.70, 0.88, 0.9],
      roughnessFactor: 0.08,
      metallicFactor: 0.12,
      transmissionFactor: 0.90
    }
  ];

  // ==========================================
  // CAMERAS: Exact vantage matching chat_image_to_3d_alpine_valley.png
  // ==========================================
  const numViews = options?.numViews ?? 24;
  const heroIntrinsics = ProceduralSfMDatasetService.calculateIntrinsics(1920, 1080, 52.0);
  const cameras: ProceduralCameraPose[] = [
    // Hero View across the hamlet toward the peak
    ProceduralSfMDatasetService.buildCameraPose(
      0,
      'hero_alpine_valley_vantage',
      [18.0, 14.5, 38.0],
      [-4.0, 6.0, -15.0],
      heroIntrinsics,
      [0.0, 1.0, 0.0]
    ),
    // 24 Orbital Survey poses
    ...ProceduralSfMDatasetService.generateTrajectory({
      trajectory: 'orbital_fibonacci',
      numViews: numViews - 1,
      target: [0, 8.0, 0],
      radius: bbox.boundingSphereRadius * 1.5
    })
  ];

  const anchor: GeodeticAnchor = {
    lat: 45.9763,
    lng: 7.7491,
    elevationMeters: 1620.0,
    headingDeg: 340.0,
    formattedAddress: 'Matterhorn Alpine Valley, Zermatt, Canton of Valais, Switzerland'
  };

  return { mesh, materials, textures, cameras, boundingBox: bbox, anchor };
}
