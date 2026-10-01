/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * High-performance 2D elevation rasterization and O(1) bilinear interpolation sampler.
 * Inspired by Christoph Holtmann's heightmap-generator.
 *
 * Replaces expensive O(N) CPU raycasts with microsecond O(1) mathematical ground sampling
 * across dense 3D photogrammetry terrain and custom geometry.
 */

export interface HeightfieldBounds {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

export type HeightfieldPrecision = 'float32' | 'uint16';

export interface HeightfieldOptions {
  bounds: HeightfieldBounds;
  gridWidth: number;
  gridHeight: number;
  precision?: HeightfieldPrecision;
  minElevation?: number;
  maxElevation?: number;
  noDataValue?: number;
}

export class HeightfieldRaster {
  public readonly bounds: HeightfieldBounds;
  public readonly gridWidth: number;
  public readonly gridHeight: number;
  public readonly precision: HeightfieldPrecision;
  public readonly cellSizeX: number;
  public readonly cellSizeZ: number;

  private float32Data?: Float32Array;
  private uint16Data?: Uint16Array;
  private minElevation: number;
  private maxElevation: number;
  private elevationScale: number;
  private elevationOffset: number;
  public readonly noDataValue: number;

  constructor(options: HeightfieldOptions) {
    this.bounds = { ...options.bounds };
    this.gridWidth = Math.max(2, Math.floor(options.gridWidth));
    this.gridHeight = Math.max(2, Math.floor(options.gridHeight));
    this.precision = options.precision || 'float32';
    this.noDataValue = options.noDataValue ?? -9999.0;

    const spanX = Math.max(1e-4, this.bounds.maxX - this.bounds.minX);
    const spanZ = Math.max(1e-4, this.bounds.maxZ - this.bounds.minZ);
    this.cellSizeX = spanX / (this.gridWidth - 1);
    this.cellSizeZ = spanZ / (this.gridHeight - 1);

    this.minElevation = options.minElevation ?? -500;
    this.maxElevation = options.maxElevation ?? 9000;
    this.elevationOffset = this.minElevation;
    const elevationSpan = Math.max(1e-3, this.maxElevation - this.minElevation);
    this.elevationScale = 65535 / elevationSpan;

    const totalCells = this.gridWidth * this.gridHeight;
    if (this.precision === 'uint16') {
      this.uint16Data = new Uint16Array(totalCells);
    } else {
      this.float32Data = new Float32Array(totalCells);
      this.float32Data.fill(this.noDataValue);
    }
  }

  /**
   * Returns whether a given (x, z) world coordinate falls within this raster's bounds.
   */
  public contains(x: number, z: number): boolean {
    return (
      x >= this.bounds.minX &&
      x <= this.bounds.maxX &&
      z >= this.bounds.minZ &&
      z <= this.bounds.maxZ
    );
  }

  /**
   * Sets elevation at grid indices (col, row).
   */
  public setElevation(col: number, row: number, height: number): void {
    if (col < 0 || col >= this.gridWidth || row < 0 || row >= this.gridHeight) return;
    const idx = row * this.gridWidth + col;

    if (this.precision === 'uint16') {
      const clamped = Math.max(this.minElevation, Math.min(this.maxElevation, height));
      const quantized = Math.round((clamped - this.elevationOffset) * this.elevationScale);
      this.uint16Data![idx] = Math.max(0, Math.min(65535, quantized));
    } else {
      this.float32Data![idx] = height;
    }
  }

  /**
   * Gets direct cell elevation at grid indices (col, row).
   */
  public getElevation(col: number, row: number): number {
    const c = Math.max(0, Math.min(this.gridWidth - 1, col));
    const r = Math.max(0, Math.min(this.gridHeight - 1, row));
    const idx = r * this.gridWidth + c;

    if (this.precision === 'uint16') {
      const q = this.uint16Data![idx]!;
      return this.elevationOffset + q / this.elevationScale;
    }
    return this.float32Data![idx]!;
  }

  /**
   * High-speed O(1) Bilinear Interpolation Sampling.
   * Given any world (x, z) coordinate, computes continuous smooth ground height.
   */
  public sampleBilinear(x: number, z: number): number | null {
    if (!this.contains(x, z)) {
      return null;
    }

    const normX = (x - this.bounds.minX) / (this.bounds.maxX - this.bounds.minX);
    const normZ = (z - this.bounds.minZ) / (this.bounds.maxZ - this.bounds.minZ);

    const gx = normX * (this.gridWidth - 1);
    const gz = normZ * (this.gridHeight - 1);

    const i = Math.floor(gx);
    const j = Math.floor(gz);

    const i0 = Math.max(0, Math.min(this.gridWidth - 1, i));
    const i1 = Math.min(this.gridWidth - 1, i0 + 1);
    const j0 = Math.max(0, Math.min(this.gridHeight - 1, j));
    const j1 = Math.min(this.gridHeight - 1, j0 + 1);

    const s = gx - i;
    const t = gz - j;

    const h00 = this.getElevation(i0, j0);
    const h10 = this.getElevation(i1, j0);
    const h01 = this.getElevation(i0, j1);
    const h11 = this.getElevation(i1, j1);

    // If any corner is uninitialized/noData, return fallback or valid average
    if (h00 === this.noDataValue || h10 === this.noDataValue || h01 === this.noDataValue || h11 === this.noDataValue) {
      const valid = [h00, h10, h01, h11].filter(v => v !== this.noDataValue);
      if (valid.length === 0) return null;
      return valid.reduce((a, b) => a + b, 0) / valid.length;
    }

    // Bilinear interpolation formula:
    // f(s, t) = (1-s)(1-t) h00 + s(1-t) h10 + (1-s)t h01 + st h11
    const top = (1.0 - s) * h00 + s * h10;
    const bottom = (1.0 - s) * h01 + s * h11;
    return (1.0 - t) * top + t * bottom;
  }

  /**
   * Bakes elevation grid from a ground elevation sampling function (e.g. raycaster).
   */
  public bake(sampleFn: (x: number, z: number) => number | null): void {
    for (let r = 0; r < this.gridHeight; r++) {
      const t = r / (this.gridHeight - 1);
      const z = this.bounds.minZ + t * (this.bounds.maxZ - this.bounds.minZ);
      for (let c = 0; c < this.gridWidth; c++) {
        const s = c / (this.gridWidth - 1);
        const x = this.bounds.minX + s * (this.bounds.maxX - this.bounds.minX);
        const h = sampleFn(x, z);
        if (h !== null && h !== undefined) {
          this.setElevation(c, r, h);
        }
      }
    }
  }

  /**
   * Exports raw buffer representation (Float32Array or Uint16Array).
   */
  public getRawBuffer(): ArrayBuffer {
    return (this.precision === 'uint16'
      ? this.uint16Data!.buffer
      : this.float32Data!.buffer) as ArrayBuffer;
  }
}
