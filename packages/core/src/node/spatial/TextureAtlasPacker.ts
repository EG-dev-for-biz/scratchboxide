/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Texture Atlas Packer and UV Coordinate Remapping Pipeline.
 * Borrowed and adapted from chenyingshu/google_3dtile_collection (imagepacker).
 *
 * Merges dozens/hundreds of individual tile textures into a single unified
 * texture atlas, dramatically reducing draw calls and enabling single-draw-call
 * rendering in game engines and web 3D viewports.
 *
 * UV Transformation Formula:
 *   u_new = u * scale_x + offset_x
 *   v_new = v * scale_y + offset_y
 * where:
 *   scale_x = width_sub / width_atlas
 *   scale_y = height_sub / height_atlas
 *   offset_x = x_sub / width_atlas
 *   offset_y = y_sub / height_atlas
 */

export interface TextureItem {
  id: string | number;
  width: number;
  height: number;
  data?: Uint8Array | Buffer; // RGBA pixel buffer
}

export interface PackedRect {
  id: string | number;
  x: number;
  y: number;
  width: number;
  height: number;
  scaleX: number;
  scaleY: number;
  offsetX: number;
  offsetY: number;
}

export interface AtlasResult {
  width: number;
  height: number;
  rects: Map<string | number, PackedRect>;
  rectList: PackedRect[];
  pixelData?: Uint8Array;
}

export interface AtlasPackerOptions {
  maxWidth?: number;
  maxHeight?: number;
  padding?: number;
  powerOfTwo?: boolean;
}

export class TextureAtlasPacker {
  private items: TextureItem[] = [];
  private padding: number;
  private maxWidth: number;
  private maxHeight: number;
  private powerOfTwo: boolean;

  constructor(options: AtlasPackerOptions = {}) {
    this.padding = options.padding ?? 2;
    this.maxWidth = options.maxWidth ?? 4096;
    this.maxHeight = options.maxHeight ?? 4096;
    this.powerOfTwo = options.powerOfTwo ?? true;
  }

  /**
   * Adds an item to be packed.
   */
  public addTexture(item: TextureItem): void {
    this.items.push(item);
  }

  /**
   * Packs all added texture items using a high-density 2D shelf-bin packing algorithm.
   */
  public pack(): AtlasResult {
    // Sort items by height descending for optimal shelf packing density
    const sorted = [...this.items].sort((a, b) => b.height - a.height);

    let curX = this.padding;
    let curY = this.padding;
    let rowHeight = 0;
    let maxAtlasW = 0;
    let maxAtlasH = 0;

    const placements: Array<{ item: TextureItem; x: number; y: number }> = [];

    for (const item of sorted) {
      const requiredW = item.width + this.padding;
      const requiredH = item.height + this.padding;

      // If item exceeds line width, advance to next shelf row
      if (curX + requiredW > this.maxWidth) {
        curX = this.padding;
        curY += rowHeight + this.padding;
        rowHeight = 0;
      }

      placements.push({ item, x: curX, y: curY });

      curX += requiredW;
      rowHeight = Math.max(rowHeight, item.height);

      maxAtlasW = Math.max(maxAtlasW, curX);
      maxAtlasH = Math.max(maxAtlasH, curY + requiredH);
    }

    // Determine final atlas dimensions
    let atlasW = maxAtlasW;
    let atlasH = maxAtlasH;

    if (this.powerOfTwo) {
      atlasW = this.nextPowerOfTwo(atlasW);
      atlasH = this.nextPowerOfTwo(atlasH);
    }

    atlasW = Math.min(this.maxWidth, Math.max(64, atlasW));
    atlasH = Math.min(this.maxHeight, Math.max(64, atlasH));

    const rects = new Map<string | number, PackedRect>();
    const rectList: PackedRect[] = [];

    // Compute normalized scale and offset
    for (const p of placements) {
      const scaleX = p.item.width / atlasW;
      const scaleY = p.item.height / atlasH;
      const offsetX = p.x / atlasW;
      const offsetY = p.y / atlasH;

      const rect: PackedRect = {
        id: p.item.id,
        x: p.x,
        y: p.y,
        width: p.item.width,
        height: p.item.height,
        scaleX,
        scaleY,
        offsetX,
        offsetY
      };

      rects.set(p.item.id, rect);
      rectList.push(rect);
    }

    // If raw pixel data is provided on items, composite into single RGBA buffer
    let pixelData: Uint8Array | undefined;
    const hasPixels = placements.some(p => p.item.data && p.item.data.length > 0);
    if (hasPixels) {
      pixelData = new Uint8Array(atlasW * atlasH * 4);
      for (const p of placements) {
        if (!p.item.data) continue;
        const src = p.item.data;
        const srcW = p.item.width;
        const srcH = p.item.height;

        for (let row = 0; row < srcH; row++) {
          const srcOffset = row * srcW * 4;
          const dstOffset = ((p.y + row) * atlasW + p.x) * 4;
          const rowBytes = srcW * 4;
          pixelData.set(src.subarray(srcOffset, srcOffset + rowBytes), dstOffset);
        }
      }
    }

    return {
      width: atlasW,
      height: atlasH,
      rects,
      rectList,
      pixelData
    };
  }

  /**
   * Transforms raw UV coordinates (u, v) based on the sub-texture rect:
   *   u_new = u * scaleX + offsetX
   *   v_new = v * scaleY + offsetY
   *
   * Accepts Float32Array containing interleaved [u0, v0, u1, v1, ...] and returns
   * a remapped Float32Array.
   */
  public static remapUVs(
    uvs: Float32Array,
    rect: PackedRect,
    flipY = false
  ): Float32Array {
    const count = uvs.length;
    const out = new Float32Array(count);

    for (let i = 0; i < count; i += 2) {
      const u = uvs[i]!;
      const v = uvs[i + 1]!;

      // Chenyingshu UV transformation formula
      out[i] = u * rect.scaleX + rect.offsetX;

      if (flipY) {
        // Handle inverted OpenGL/DirectX texture conventions
        const vFlipped = 1.0 - v;
        const newV = vFlipped * rect.scaleY + rect.offsetY;
        out[i + 1] = 1.0 - newV;
      } else {
        out[i + 1] = v * rect.scaleY + rect.offsetY;
      }
    }

    return out;
  }

  private nextPowerOfTwo(val: number): number {
    let p = 1;
    while (p < val && p < this.maxWidth) {
      p <<= 1;
    }
    return p;
  }
}
