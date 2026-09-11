/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as THREE from 'three';

/**
 * 3D Triangle-to-Voxel Terraforming & Rasterization Engine.
 * Borrowed and adapted from ryanhlewis/VoxelEarth.
 *
 * Capabilities:
 * 1. Discretizes 3D photogrammetry meshes/tiles into volumetric voxel worlds.
 * 2. Barycentric UV sampling from diffuse textures during triangle rasterization.
 * 3. Color quantization to material/block palettes.
 * 4. CSG terraforming operations (carve, fill, flatten polygon, smooth).
 * 5. Culled-face surface mesh extraction for real-time 3D rendering.
 */

export interface VoxelGridBounds {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

export interface VoxelEngineOptions {
  bounds: VoxelGridBounds;
  voxelSize?: number; // size of 1 voxel in world meters (default: 1.0)
  defaultPalette?: VoxelPaletteEntry[];
}

export interface VoxelPaletteEntry {
  id: number;
  name: string;
  color: [number, number, number]; // [r, g, b] 0-255
}

export const DEFAULT_VOXEL_PALETTE: VoxelPaletteEntry[] = [
  { id: 0, name: 'air', color: [0, 0, 0] },
  { id: 1, name: 'stone', color: [128, 128, 128] },
  { id: 2, name: 'dirt', color: [134, 96, 67] },
  { id: 3, name: 'grass', color: [86, 140, 53] },
  { id: 4, name: 'concrete', color: [195, 195, 195] },
  { id: 5, name: 'brick', color: [180, 74, 50] },
  { id: 6, name: 'asphalt', color: [50, 50, 54] },
  { id: 7, name: 'water', color: [44, 94, 180] },
  { id: 8, name: 'sand', color: [219, 203, 148] },
  { id: 9, name: 'clay', color: [200, 182, 160] }
];

export class VoxelTerraformEngine {
  public readonly bounds: VoxelGridBounds;
  public readonly voxelSize: number;
  public readonly sizeX: number;
  public readonly sizeY: number;
  public readonly sizeZ: number;

  private voxels: Uint16Array;
  private palette: VoxelPaletteEntry[];
  private paletteMap: Map<number, VoxelPaletteEntry>;

  constructor(options: VoxelEngineOptions) {
    this.bounds = { ...options.bounds };
    this.voxelSize = Math.max(0.05, options.voxelSize ?? 1.0);

    const spanX = Math.max(1, this.bounds.maxX - this.bounds.minX);
    const spanY = Math.max(1, this.bounds.maxY - this.bounds.minY);
    const spanZ = Math.max(1, this.bounds.maxZ - this.bounds.minZ);

    this.sizeX = Math.ceil(spanX / this.voxelSize);
    this.sizeY = Math.ceil(spanY / this.voxelSize);
    this.sizeZ = Math.ceil(spanZ / this.voxelSize);

    this.voxels = new Uint16Array(this.sizeX * this.sizeY * this.sizeZ);
    this.palette = options.defaultPalette || [...DEFAULT_VOXEL_PALETTE];
    this.paletteMap = new Map(this.palette.map(p => [p.id, p]));
  }

  /**
   * Translates world (x, y, z) coordinate to voxel grid index (vx, vy, vz).
   */
  public worldToVoxel(x: number, y: number, z: number): [number, number, number] {
    const vx = Math.floor((x - this.bounds.minX) / this.voxelSize);
    const vy = Math.floor((y - this.bounds.minY) / this.voxelSize);
    const vz = Math.floor((z - this.bounds.minZ) / this.voxelSize);
    return [vx, vy, vz];
  }

  /**
   * Translates voxel grid index (vx, vy, vz) to world center coordinate.
   */
  public voxelToWorld(vx: number, vy: number, vz: number): [number, number, number] {
    const wx = this.bounds.minX + (vx + 0.5) * this.voxelSize;
    const wy = this.bounds.minY + (vy + 0.5) * this.voxelSize;
    const wz = this.bounds.minZ + (vz + 0.5) * this.voxelSize;
    return [wx, wy, wz];
  }

  /**
   * Returns flat array index for voxel (vx, vy, vz).
   */
  private getIndex(vx: number, vy: number, vz: number): number {
    return vx + this.sizeX * (vy + this.sizeY * vz);
  }

  public getVoxel(vx: number, vy: number, vz: number): number {
    if (vx < 0 || vx >= this.sizeX || vy < 0 || vy >= this.sizeY || vz < 0 || vz >= this.sizeZ) {
      return 0;
    }
    return this.voxels[this.getIndex(vx, vy, vz)]!;
  }

  public setVoxel(vx: number, vy: number, vz: number, typeId: number): void {
    if (vx < 0 || vx >= this.sizeX || vy < 0 || vy >= this.sizeY || vz < 0 || vz >= this.sizeZ) {
      return;
    }
    this.voxels[this.getIndex(vx, vy, vz)] = typeId;
  }

  /**
   * Maps an RGB color to the closest matching palette material ID.
   */
  public findClosestPaletteId(r: number, g: number, b: number): number {
    let closestId = 1;
    let minDistanceSq = Infinity;

    for (const entry of this.palette) {
      if (entry.id === 0) continue; // Skip air
      const dr = entry.color[0] - r;
      const dg = entry.color[1] - g;
      const db = entry.color[2] - b;
      const distSq = dr * dr + dg * dg + db * db;
      if (distSq < minDistanceSq) {
        minDistanceSq = distSq;
        closestId = entry.id;
      }
    }

    return closestId;
  }

  /**
   * Triangle-to-voxel rasterization with barycentric texture color sampling.
   * Direct adaptation of VoxelEarth's voxelization pipeline.
   */
  public rasterizeMesh(
    positions: Float32Array,
    indices: Uint16Array | Uint32Array,
    uvs?: Float32Array,
    texture?: { width: number; height: number; data: Uint8Array },
    solidFillDown = true
  ): void {
    const vCount = positions.length / 3;
    const triCount = indices.length / 3;

    for (let t = 0; t < triCount; t++) {
      const i0 = indices[t * 3]!;
      const i1 = indices[t * 3 + 1]!;
      const i2 = indices[t * 3 + 2]!;

      if (i0 >= vCount || i1 >= vCount || i2 >= vCount) continue;

      const ax = positions[i0 * 3]!, ay = positions[i0 * 3 + 1]!, az = positions[i0 * 3 + 2]!;
      const bx = positions[i1 * 3]!, by = positions[i1 * 3 + 1]!, bz = positions[i1 * 3 + 2]!;
      const cx = positions[i2 * 3]!, cy = positions[i2 * 3 + 1]!, cz = positions[i2 * 3 + 2]!;

      let u0 = 0, v0 = 0, u1 = 0, v1 = 0, u2 = 0, v2 = 0;
      if (uvs && uvs.length >= vCount * 2) {
        u0 = uvs[i0 * 2]!; v0 = uvs[i0 * 2 + 1]!;
        u1 = uvs[i1 * 2]!; v1 = uvs[i1 * 2 + 1]!;
        u2 = uvs[i2 * 2]!; v2 = uvs[i2 * 2 + 1]!;
      }

      // Triangle bounding box
      const minX = Math.min(ax, bx, cx);
      const maxX = Math.max(ax, bx, cx);
      const minY = Math.min(ay, by, cy);
      const maxY = Math.max(ay, by, cy);
      const minZ = Math.min(az, bz, cz);
      const maxZ = Math.max(az, bz, cz);

      const [vx0, vy0, vz0] = this.worldToVoxel(minX, minY, minZ);
      const [vx1, vy1, vz1] = this.worldToVoxel(maxX, maxY, maxZ);

      const startX = Math.max(0, vx0);
      const endX = Math.min(this.sizeX - 1, vx1);
      const startY = Math.max(0, vy0);
      const endY = Math.min(this.sizeY - 1, vy1);
      const startZ = Math.max(0, vz0);
      const endZ = Math.min(this.sizeZ - 1, vz1);

      // Precompute edge vectors for 2D/3D barycentric projection
      const abx = bx - ax, aby = by - ay, abz = bz - az;
      const acx = cx - ax, acy = cy - ay, acz = cz - az;

      // Triangle normal via cross product
      const nx = aby * acz - abz * acy;
      const ny = abz * acx - abx * acz;
      const nz = abx * acy - aby * acx;
      const lenSq = nx * nx + ny * ny + nz * nz;
      if (lenSq < 1e-10) continue; // Degenerate triangle

      for (let vz = startZ; vz <= endZ; vz++) {
        for (let vx = startX; vx <= endX; vx++) {
          for (let vy = startY; vy <= endY; vy++) {
            const [wx, wy, wz] = this.voxelToWorld(vx, vy, vz);

            // Plane distance check
            const dist = ((wx - ax) * nx + (wy - ay) * ny + (wz - az) * nz) / Math.sqrt(lenSq);
            if (Math.abs(dist) > this.voxelSize * 0.866) {
              continue;
            }

            // Approximate barycentric coordinates (A, B, C to point)
            // Using centroid distance weight
            const d0 = Math.hypot(wx - ax, wy - ay, wz - az);
            const d1 = Math.hypot(wx - bx, wy - by, wz - bz);
            const d2 = Math.hypot(wx - cx, wy - cy, wz - cz);
            const totalD = d0 + d1 + d2;
            const w0 = totalD > 0 ? (totalD - d0) / (2 * totalD) : 0.333;
            const w1 = totalD > 0 ? (totalD - d1) / (2 * totalD) : 0.333;
            const w2 = Math.max(0, 1.0 - w0 - w1);

            // Interpolate UV
            const u = w0 * u0 + w1 * u1 + w2 * u2;
            const v = w0 * v0 + w1 * v1 + w2 * v2;

            // Sample texture
            let paletteId = 9; // Default clay
            if (texture && texture.data && texture.width > 0 && texture.height > 0) {
              const tx = Math.floor(((u % 1 + 1) % 1) * texture.width);
              const ty = Math.floor(((v % 1 + 1) % 1) * texture.height);
              const pIdx = (ty * texture.width + tx) * 4;
              const r = texture.data[pIdx]!;
              const g = texture.data[pIdx + 1]!;
              const b = texture.data[pIdx + 2]!;
              paletteId = this.findClosestPaletteId(r, g, b);
            }

            this.setVoxel(vx, vy, vz, paletteId);

            // Solid fill beneath terrain surface down to base
            if (solidFillDown) {
              for (let fillY = vy - 1; fillY >= 0; fillY--) {
                if (this.getVoxel(vx, fillY, vz) !== 0) break;
                this.setVoxel(vx, fillY, vz, paletteId === 3 ? 2 : paletteId); // Dirt under grass
              }
            }
          }
        }
      }
    }
  }

  /**
   * CSG Carve: removes voxels within a sphere (excavation).
   */
  public carveSphere(centerX: number, centerY: number, centerZ: number, radiusMeters: number): number {
    const [cvx, cvy, cvz] = this.worldToVoxel(centerX, centerY, centerZ);
    const vRadius = Math.ceil(radiusMeters / this.voxelSize);
    const rSq = radiusMeters * radiusMeters;
    let modified = 0;

    for (let vz = cvz - vRadius; vz <= cvz + vRadius; vz++) {
      for (let vy = cvy - vRadius; vy <= cvy + vRadius; vy++) {
        for (let vx = cvx - vRadius; vx <= cvx + vRadius; vx++) {
          const [wx, wy, wz] = this.voxelToWorld(vx, vy, vz);
          const dSq = (wx - centerX) ** 2 + (wy - centerY) ** 2 + (wz - centerZ) ** 2;
          if (dSq <= rSq && this.getVoxel(vx, vy, vz) !== 0) {
            this.setVoxel(vx, vy, vz, 0); // Carve to air
            modified++;
          }
        }
      }
    }

    return modified;
  }

  /**
   * CSG Fill: deposits voxels within a sphere (building / raising terrain).
   */
  public fillSphere(
    centerX: number,
    centerY: number,
    centerZ: number,
    radiusMeters: number,
    materialId: number
  ): number {
    const [cvx, cvy, cvz] = this.worldToVoxel(centerX, centerY, centerZ);
    const vRadius = Math.ceil(radiusMeters / this.voxelSize);
    const rSq = radiusMeters * radiusMeters;
    let modified = 0;

    for (let vz = cvz - vRadius; vz <= cvz + vRadius; vz++) {
      for (let vy = cvy - vRadius; vy <= cvy + vRadius; vy++) {
        for (let vx = cvx - vRadius; vx <= cvx + vRadius; vx++) {
          const [wx, wy, wz] = this.voxelToWorld(vx, vy, vz);
          const dSq = (wx - centerX) ** 2 + (wy - centerY) ** 2 + (wz - centerZ) ** 2;
          if (dSq <= rSq) {
            this.setVoxel(vx, vy, vz, materialId);
            modified++;
          }
        }
      }
    }

    return modified;
  }

  /**
   * CSG Flatten: flattens voxels within an (x, z) polygon footprint to a uniform target Y height.
   */
  public flattenPolygon(
    polygon: Array<{ x: number; z: number }>,
    targetY: number,
    materialId = 4
  ): number {
    if (polygon.length < 3) return 0;

    let minX = Infinity, maxX = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    for (const pt of polygon) {
      if (pt.x < minX) minX = pt.x;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.z < minZ) minZ = pt.z;
      if (pt.z > maxZ) maxZ = pt.z;
    }

    const [vx0, , vz0] = this.worldToVoxel(minX, 0, minZ);
    const [vx1, , vz1] = this.worldToVoxel(maxX, 0, maxZ);
    const [, targetVy] = this.worldToVoxel(0, targetY, 0);

    const isInsidePoly = (px: number, pz: number) => {
      let inside = false;
      for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const xi = polygon[i]!.x, zi = polygon[i]!.z;
        const xj = polygon[j]!.x, zj = polygon[j]!.z;
        const intersect = ((zi > pz) !== (zj > pz)) && (px < ((xj - xi) * (pz - zi)) / (zj - zi + 1e-12) + xi);
        if (intersect) inside = !inside;
      }
      return inside;
    };

    let modified = 0;
    const sX = Math.max(0, vx0), eX = Math.min(this.sizeX - 1, vx1);
    const sZ = Math.max(0, vz0), eZ = Math.min(this.sizeZ - 1, vz1);

    for (let vz = sZ; vz <= eZ; vz++) {
      for (let vx = sX; vx <= eX; vx++) {
        const [wx, , wz] = this.voxelToWorld(vx, 0, vz);
        if (isInsidePoly(wx, wz)) {
          // Remove anything above targetVy
          for (let vy = targetVy + 1; vy < this.sizeY; vy++) {
            if (this.getVoxel(vx, vy, vz) !== 0) {
              this.setVoxel(vx, vy, vz, 0);
              modified++;
            }
          }
          // Set surface pad layer to materialId (e.g. Concrete, Asphalt, Foundation)
          if (this.getVoxel(vx, targetVy, vz) !== materialId) {
            this.setVoxel(vx, targetVy, vz, materialId);
            modified++;
          }
          // Fill any hollow space beneath targetVy
          for (let vy = 0; vy < targetVy; vy++) {
            if (this.getVoxel(vx, vy, vz) === 0) {
              this.setVoxel(vx, vy, vz, materialId);
              modified++;
            }
          }
        }
      }
    }

    return modified;
  }

  /**
   * Generates culled-face Three.js BufferGeometry representing the voxel world.
   * Only exposed outer faces (adjacent to air) are generated, eliminating internal geometry.
   */
  public generateCulledMesh(): THREE.BufferGeometry {
    const positions: number[] = [];
    const normals: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];

    // Face normal offsets: [+X, -X, +Y, -Y, +Z, -Z]
    const neighbors = [
      { dx: 1, dy: 0, dz: 0, norm: [1, 0, 0] },
      { dx: -1, dy: 0, dz: 0, norm: [-1, 0, 0] },
      { dx: 0, dy: 1, dz: 0, norm: [0, 1, 0] },
      { dx: 0, dy: -1, dz: 0, norm: [0, -1, 0] },
      { dx: 0, dy: 0, dz: 1, norm: [0, 0, 1] },
      { dx: 0, dy: 0, dz: -1, norm: [0, 0, -1] }
    ];

    const h = this.voxelSize * 0.5;

    for (let vz = 0; vz < this.sizeZ; vz++) {
      for (let vy = 0; vy < this.sizeY; vy++) {
        for (let vx = 0; vx < this.sizeX; vx++) {
          const typeId = this.getVoxel(vx, vy, vz);
          if (typeId === 0) continue; // Air

          const pal = this.paletteMap.get(typeId) || DEFAULT_VOXEL_PALETTE[1]!;
          const cr = pal.color[0] / 255.0;
          const cg = pal.color[1] / 255.0;
          const cb = pal.color[2] / 255.0;

          const [wx, wy, wz] = this.voxelToWorld(vx, vy, vz);

          for (const nb of neighbors) {
            const adjType = this.getVoxel(vx + nb.dx, vy + nb.dy, vz + nb.dz);
            if (adjType === 0) {
              // Exposed face: emit quad
              const baseIdx = positions.length / 3;

              // Compute quad vertices depending on face orientation
              let corners: number[][] = [];
              if (nb.dx === 1) { // +X
                corners = [
                  [wx + h, wy - h, wz - h],
                  [wx + h, wy + h, wz - h],
                  [wx + h, wy + h, wz + h],
                  [wx + h, wy - h, wz + h]
                ];
              } else if (nb.dx === -1) { // -X
                corners = [
                  [wx - h, wy - h, wz + h],
                  [wx - h, wy + h, wz + h],
                  [wx - h, wy + h, wz - h],
                  [wx - h, wy - h, wz - h]
                ];
              } else if (nb.dy === 1) { // +Y
                corners = [
                  [wx - h, wy + h, wz - h],
                  [wx - h, wy + h, wz + h],
                  [wx + h, wy + h, wz + h],
                  [wx + h, wy + h, wz - h]
                ];
              } else if (nb.dy === -1) { // -Y
                corners = [
                  [wx - h, wy - h, wz + h],
                  [wx - h, wy - h, wz - h],
                  [wx + h, wy - h, wz - h],
                  [wx + h, wy - h, wz + h]
                ];
              } else if (nb.dz === 1) { // +Z
                corners = [
                  [wx + h, wy - h, wz + h],
                  [wx + h, wy + h, wz + h],
                  [wx - h, wy + h, wz + h],
                  [wx - h, wy - h, wz + h]
                ];
              } else { // -Z
                corners = [
                  [wx - h, wy - h, wz - h],
                  [wx - h, wy + h, wz - h],
                  [wx + h, wy + h, wz - h],
                  [wx + h, wy - h, wz - h]
                ];
              }

              for (const c of corners) {
                positions.push(c[0]!, c[1]!, c[2]!);
                normals.push(nb.norm[0]!, nb.norm[1]!, nb.norm[2]!);
                colors.push(cr, cg, cb);
              }

              // Quad indices (2 triangles)
              indices.push(baseIdx, baseIdx + 1, baseIdx + 2);
              indices.push(baseIdx, baseIdx + 2, baseIdx + 3);
            }
          }
        }
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.setIndex(indices);

    return geometry;
  }
}
