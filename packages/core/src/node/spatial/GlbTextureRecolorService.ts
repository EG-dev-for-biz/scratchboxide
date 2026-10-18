/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This program and the accompanying materials are modern C++20 and Node.js
 * services for 3D geospatial processing and material harmonization.
 ********************************************************************************/

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { decodeImageToRgba, encodeRgbaToJpeg, encodeRgbaToPng } from '../image-codec-ffmpeg';

/**
 * CIELAB Target Color Swatch
 */
export interface LabColor {
  L: number; // 0 to 100
  a: number; // -128 to 127 (Green to Red)
  b: number; // -128 to 127 (Blue to Yellow)
}

/**
 * Nano Banana Method 2 Palette Definition in CIELAB
 */
export interface NanoBananaGlbPalette {
  shadow: LabColor;
  midtone: LabColor;
  highlight: LabColor;
  accent?: LabColor;
}

/**
 * Material segmentation and protection options
 */
export interface MaterialSegmentationOptions {
  enableSegmentation?: boolean;
  protectFoliage?: boolean;
  foliageColor?: LabColor;
  protectAsphalt?: boolean;
  asphaltColor?: LabColor;
}

/**
 * Physically-based rendering (PBR) texture channel synthesis
 */
export interface PbrSynthesisOptions {
  generateNormalMaps?: boolean;
  normalStrength?: number; // default 2.0
  generateRoughnessMaps?: boolean;
  masonryRoughness?: number; // default 0.88
  foliageRoughness?: number; // default 0.72
  asphaltRoughness?: number; // default 0.48 (twilight wet sheen)
}

/**
 * Options for GLB Texture Re-grade
 */
export interface GlbRecolorOptions {
  palette?: NanoBananaGlbPalette;
  shadowLift?: number; // 0.0 to 1.0 (default 0.7)
  highlightCompress?: number; // 0.0 to 1.0 (default 0.4)
  midtoneWeight?: number; // 0.0 to 1.0 (default 0.75)
  concurrency?: number; // parallel image processing limit (default 8)
  jpegQuality?: number; // ffmpeg q:v 1 to 5 (default 2)
  segmentation?: MaterialSegmentationOptions;
  pbr?: PbrSynthesisOptions;
}

/**
 * Result metrics from GLB Texture Re-grade
 */
export interface GlbRecolorResult {
  success: boolean;
  inputGlbPath: string;
  outputGlbPath: string;
  /** Embedded textures that were actually recoloured. */
  textureCount: number;
  /** Embedded textures that could not be decoded/recoloured/encoded; their original bytes are kept unchanged. */
  failedTextures: Array<{ imageIndex: number; reason: string }>;
  /** True when every non-image bufferView in the written GLB is byte-identical to the input (re-read and compared). */
  geometryBytesIdentical: boolean;
  originalByteLength: number;
  recoloredByteLength: number;
  durationMs: number;
  palette: NanoBananaGlbPalette;
  pbrGenerated?: {
    normalMapCount: number;
    roughnessMapCount: number;
  };
}

/**
 * Default Twilight Palette (Extracted from Nano Banana Reference Look)
 * - Shadows: Prussian Blue (#0B192C)
 * - Midtones: Warm Terracotta Facade (#E06B55)
 * - Highlights: Sunburst Amber Portal Glow (#FFB84C)
 * - Accent: Electric Cerulean Sky Rim (#1E90FF)
 */
export const DEFAULT_NANO_BANANA_GLB_PALETTE: NanoBananaGlbPalette = {
  shadow: { L: 14.0, a: 1.5, b: -14.6 },
  midtone: { L: 56.0, a: 38.0, b: 30.0 },
  highlight: { L: 78.0, a: 16.0, b: 58.0 },
  accent: { L: 59.4, a: 10.0, b: -63.4 }
};

/**
 * Default Foliage Color in CIELAB: Dusk Cypress Emerald (#1D3B2E)
 */
export const DEFAULT_FOLIAGE_LAB: LabColor = {
  L: 24.0,
  a: -18.0,
  b: 12.0
};

/**
 * Default Asphalt / Roadway Color in CIELAB: Twilight Slate (#232832)
 */
export const DEFAULT_ASPHALT_LAB: LabColor = {
  L: 19.0,
  a: -1.5,
  b: -6.0
};

/**
 * Well-known architectural lighting presets for 3D Tile GLB recoloring
 */
export const GLB_RECOLOR_PRESETS: Record<string, NanoBananaGlbPalette> = {
  dusk_twilight: DEFAULT_NANO_BANANA_GLB_PALETTE,
  golden_hour: {
    shadow: { L: 14.5, a: 11.2, b: 17.5 },
    midtone: { L: 67.5, a: 14.2, b: 50.8 },
    highlight: { L: 95.8, a: -3.5, b: 18.5 },
    accent: { L: 72.0, a: 22.0, b: 65.0 }
  },
  cyberpunk_neon: {
    shadow: { L: 5.2, a: 4.8, b: -9.5 },
    midtone: { L: 54.0, a: 88.0, b: -6.0 },
    highlight: { L: 86.5, a: -43.0, b: -21.0 },
    accent: { L: 78.0, a: 60.0, b: -40.0 }
  },
  monochrome_noir: {
    shadow: { L: 6.5, a: 0.0, b: 0.0 },
    midtone: { L: 56.5, a: 0.0, b: 0.0 },
    highlight: { L: 94.0, a: 0.0, b: 0.0 },
    accent: { L: 80.0, a: 0.0, b: 0.0 }
  },
  sophisticated_v2_realistic: {
    shadow: { L: 16.0, a: 1.0, b: -8.0 },
    midtone: { L: 66.0, a: 14.0, b: 22.0 },
    highlight: { L: 88.0, a: 8.0, b: 26.0 },
    accent: { L: 60.0, a: 4.0, b: -20.0 }
  },
  realistic_travertine: {
    shadow: { L: 18.0, a: 2.0, b: -4.0 },
    midtone: { L: 72.0, a: 8.5, b: 20.0 },
    highlight: { L: 92.0, a: 4.0, b: 16.0 },
    accent: { L: 65.0, a: -6.0, b: 16.0 }
  }
};

/**
 * Convert HEX color string (#RGB, #RRGGBB) to CIELAB LabColor
 */
export function hexToLab(hex: string): LabColor {
  const cleanHex = hex.replace('#', '').trim();
  let r = 0, g = 0, b = 0;
  if (cleanHex.length === 3) {
    r = parseInt(cleanHex[0] + cleanHex[0], 16);
    g = parseInt(cleanHex[1] + cleanHex[1], 16);
    b = parseInt(cleanHex[2] + cleanHex[2], 16);
  } else if (cleanHex.length === 6) {
    r = parseInt(cleanHex.substring(0, 2), 16);
    g = parseInt(cleanHex.substring(2, 4), 16);
    b = parseInt(cleanHex.substring(4, 6), 16);
  }
  const [L, a, bVal] = GlbTextureRecolorService.rgbToLab(r, g, b);
  return { L, a, b: bVal };
}

/**
 * High-level programmatic API options for 3D Tile GLB recoloring
 */
export interface GlbRecolorApiOptions {
  /** Path to input .glb file or raw binary buffer. */
  inputGlb: string | Buffer;
  /** Path where output recolored .glb will be saved. If omitted, returns glbBuffer in memory. */
  outputGlbPath?: string;
  /** Preset architectural lighting palette. Default: 'dusk_twilight'. */
  palettePreset?: 'dusk_twilight' | 'golden_hour' | 'cyberpunk_neon' | 'monochrome_noir' | 'custom';
  /** Custom palette swatch definitions (HEX or CIELAB). */
  customPalette?: {
    shadowHex?: string;
    midtoneHex?: string;
    highlightHex?: string;
    accentHex?: string;
  } | Partial<NanoBananaGlbPalette>;
  /** Material segmentation configuration (protects foliage & roadways). Enabled by default. */
  segmentation?: {
    enableSegmentation?: boolean;
    protectFoliage?: boolean;
    foliageHex?: string;
    protectAsphalt?: boolean;
    asphaltHex?: string;
  };
  /** Physically Based Rendering (PBR) texture synthesis options. Enabled by default. */
  pbr?: {
    generateNormalMaps?: boolean;
    normalStrength?: number; // Default 2.0
    generateRoughnessMaps?: boolean;
    masonryRoughness?: number; // Default 0.88
    foliageRoughness?: number; // Default 0.72
    asphaltRoughness?: number; // Default 0.48
  };
  shadowLift?: number; // Default 0.7
  highlightCompress?: number; // Default 0.4
  concurrency?: number; // Default 12
  jpegQuality?: number; // Default 2
}

/**
 * Result returned by recolor3DTilesGlb API
 */
export interface GlbRecolorApiResult {
  success: boolean;
  inputGlbPath?: string;
  outputGlbPath?: string;
  glbBuffer: Buffer;
  /** Embedded textures that were actually recoloured. */
  textureCount: number;
  /** Embedded textures left unchanged because they failed, with the reason. */
  failedTextures: Array<{ imageIndex: number; reason: string }>;
  /** Every non-image bufferView of the output was re-read and compared byte-for-byte with the input. */
  geometryBytesIdentical: boolean;
  normalMapCount: number;
  roughnessMapCount: number;
  originalByteLength: number;
  recoloredByteLength: number;
  durationMs: number;
  paletteUsed: NanoBananaGlbPalette;
  summary: string;
}

interface ProcessedImageChannels {
  imageIndex: number;
  bvIndex: number;
  recoloredBuf: Buffer;
  normalBuf?: Buffer;
  roughnessBuf?: Buffer;
  /** Set when the texture could not be processed; recoloredBuf is then the original bytes. */
  failure?: string;
}

/**
 * Architecture 2: Offline Texture Atlas Re-grade Service for 3D Tile GLBs (v2 Sophisticated)
 * 
 * Supports:
 * 1. CIELAB Hue-Aware Material Segmentation (protects green foliage and slate asphalt).
 * 2. Intrinsic shadow de-lighting and Prussian Blue crevice lift.
 * 3. PBR Normal Map & Roughness Map synthesis from photogrammetry albedo.
 * 4. Geometry bufferViews copied byte-for-byte (verified on the written GLB, reported as geometryBytesIdentical).
 */
export class GlbTextureRecolorService {

  public static async recolorGlb(
    inputGlbPath: string,
    outputGlbPath: string,
    options: GlbRecolorOptions = {}
  ): Promise<GlbRecolorResult> {
    const startTime = performance.now();
    const palette = options.palette || DEFAULT_NANO_BANANA_GLB_PALETTE;
    const concurrency = options.concurrency || 8;
    const shadowLift = options.shadowLift ?? 0.7;
    const highlightCompress = options.highlightCompress ?? 0.4;
    const midtoneWeight = options.midtoneWeight ?? 0.75;
    const jpegQuality = options.jpegQuality || 2;

    const segmentation: Required<MaterialSegmentationOptions> = {
      enableSegmentation: options.segmentation?.enableSegmentation ?? true,
      protectFoliage: options.segmentation?.protectFoliage ?? true,
      foliageColor: options.segmentation?.foliageColor || DEFAULT_FOLIAGE_LAB,
      protectAsphalt: options.segmentation?.protectAsphalt ?? true,
      asphaltColor: options.segmentation?.asphaltColor || DEFAULT_ASPHALT_LAB
    };

    const pbr: Required<PbrSynthesisOptions> = {
      generateNormalMaps: options.pbr?.generateNormalMaps ?? false,
      normalStrength: options.pbr?.normalStrength ?? 2.0,
      generateRoughnessMaps: options.pbr?.generateRoughnessMaps ?? false,
      masonryRoughness: options.pbr?.masonryRoughness ?? 0.88,
      foliageRoughness: options.pbr?.foliageRoughness ?? 0.72,
      asphaltRoughness: options.pbr?.asphaltRoughness ?? 0.48
    };

    if (!fs.existsSync(inputGlbPath)) {
      throw new Error(`Input GLB not found at: ${inputGlbPath}`);
    }

    const glbBuffer = fs.readFileSync(inputGlbPath);
    const originalByteLength = glbBuffer.length;

    // 1. Verify GLB Header
    const magic = glbBuffer.readUInt32LE(0);
    if (magic !== 0x46546C67) {
      throw new Error(`Invalid GLB magic header: 0x${magic.toString(16)}. Expected 0x46546C67 ('glTF')`);
    }
    const version = glbBuffer.readUInt32LE(4);
    if (version !== 2) {
      throw new Error(`Unsupported GLB version: ${version}. Expected version 2`);
    }

    // 2. Parse JSON Chunk
    const jsonChunkLength = glbBuffer.readUInt32LE(12);
    const jsonChunkType = glbBuffer.readUInt32LE(16);
    if (jsonChunkType !== 0x4E4F534A) {
      throw new Error(`Invalid JSON chunk type: 0x${jsonChunkType.toString(16)}`);
    }

    const jsonStr = glbBuffer.toString('utf8', 20, 20 + jsonChunkLength);
    const gltf = JSON.parse(jsonStr);

    // 3. Locate Binary (BIN) Chunk
    const binChunkHeaderOffset = 20 + jsonChunkLength;
    if (binChunkHeaderOffset >= glbBuffer.length) {
      throw new Error('GLB does not contain a binary chunk');
    }

    const binChunkLength = glbBuffer.readUInt32LE(binChunkHeaderOffset);
    const binChunkType = glbBuffer.readUInt32LE(binChunkHeaderOffset + 4);
    if (binChunkType !== 0x004E4942) {
      throw new Error(`Invalid BIN chunk type: 0x${binChunkType.toString(16)}`);
    }

    const binChunkDataOffset = binChunkHeaderOffset + 8;
    const binBuffer = glbBuffer.subarray(binChunkDataOffset, binChunkDataOffset + binChunkLength);

    // 4. Identify Image BufferViews
    const images: any[] = gltf.images || [];
    const imageBvIndices = new Set<number>();
    images.forEach(img => {
      if (typeof img.bufferView === 'number') {
        imageBvIndices.add(img.bufferView);
      }
    });

    const bufferViews: any[] = gltf.bufferViews || [];
    const processedBufferViews: Buffer[] = new Array(bufferViews.length);

    // Extract untouched geometric / accessor buffer views first (100% bit-for-bit lock)
    for (let i = 0; i < bufferViews.length; i++) {
      if (!imageBvIndices.has(i)) {
        const bv = bufferViews[i];
        const offset = bv.byteOffset || 0;
        const len = bv.byteLength;
        processedBufferViews[i] = Buffer.from(binBuffer.subarray(offset, offset + len));
      }
    }

    // Prepare image tasks
    interface ImageTask {
      imageIndex: number;
      bvIndex: number;
      buffer: Buffer;
      mimeType: string;
    }

    const imageTasks: ImageTask[] = [];
    images.forEach((img, idx) => {
      if (typeof img.bufferView === 'number') {
        const bv = bufferViews[img.bufferView];
        const offset = bv.byteOffset || 0;
        const len = bv.byteLength;
        const slice = Buffer.from(binBuffer.subarray(offset, offset + len));
        imageTasks.push({
          imageIndex: idx,
          bvIndex: img.bufferView,
          buffer: slice,
          mimeType: img.mimeType || 'image/jpeg'
        });
      }
    });

    // 5. Parallel Texture Processing
    const channelResults: ProcessedImageChannels[] = [];
    const failedTextures: Array<{ imageIndex: number; reason: string }> = [];
    const originalBufferViewCount = bufferViews.length;
    await this.processImageTasksInPool(
      imageTasks,
      concurrency,
      palette,
      shadowLift,
      highlightCompress,
      midtoneWeight,
      jpegQuality,
      segmentation,
      pbr,
      result => {
        processedBufferViews[result.bvIndex] = result.recoloredBuf;
        if (result.failure) {
          failedTextures.push({ imageIndex: result.imageIndex, reason: result.failure });
        } else {
          channelResults.push(result);
        }
      }
    );
    failedTextures.sort((x, y) => x.imageIndex - y.imageIndex);

    // 6. Integrate Synthesized PBR Texture Channels into glTF
    let normalMapCount = 0;
    let roughnessMapCount = 0;

    if (pbr.generateNormalMaps || pbr.generateRoughnessMaps) {
      if (!gltf.textures) gltf.textures = [];
      if (!gltf.materials) gltf.materials = [];
      if (!gltf.samplers) gltf.samplers = [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }];

      // Remove KHR_materials_unlit from extensionsUsed
      if (Array.isArray(gltf.extensionsUsed)) {
        gltf.extensionsUsed = gltf.extensionsUsed.filter((ext: string) => ext !== 'KHR_materials_unlit');
      }

      // Map from imageIndex to channels
      const channelMap = new Map<number, ProcessedImageChannels>();
      for (const ch of channelResults) {
        channelMap.set(ch.imageIndex, ch);
      }

      for (let matIdx = 0; matIdx < gltf.materials.length; matIdx++) {
        const mat = gltf.materials[matIdx];
        if (!mat) continue;

        // Remove unlit extension from material so Three.js renders full MeshStandardMaterial
        if (mat.extensions && mat.extensions.KHR_materials_unlit) {
          delete mat.extensions.KHR_materials_unlit;
          if (Object.keys(mat.extensions).length === 0) {
            delete mat.extensions;
          }
        }

        const baseTexIdx = mat.pbrMetallicRoughness?.baseColorTexture?.index;
        if (typeof baseTexIdx === 'number' && gltf.textures[baseTexIdx]) {
          const imgIdx = gltf.textures[baseTexIdx].source;
          const ch = channelMap.get(imgIdx);
          const samplerIdx = gltf.textures[baseTexIdx].sampler ?? 0;

          if (ch) {
            // Attach Normal Map
            if (pbr.generateNormalMaps && ch.normalBuf) {
              const newBvIdx = bufferViews.length;
              bufferViews.push({ buffer: 0, byteOffset: 0, byteLength: ch.normalBuf.length });
              processedBufferViews.push(ch.normalBuf);

              const newImgIdx = images.length;
              images.push({ bufferView: newBvIdx, mimeType: 'image/jpeg' });

              const newTexIdx = gltf.textures.length;
              gltf.textures.push({ sampler: samplerIdx, source: newImgIdx });

              mat.normalTexture = { index: newTexIdx, scale: 1.0 };
              normalMapCount++;
            }

            // Attach Roughness Map
            if (pbr.generateRoughnessMaps && ch.roughnessBuf) {
              const newBvIdx = bufferViews.length;
              bufferViews.push({ buffer: 0, byteOffset: 0, byteLength: ch.roughnessBuf.length });
              processedBufferViews.push(ch.roughnessBuf);

              const newImgIdx = images.length;
              images.push({ bufferView: newBvIdx, mimeType: 'image/jpeg' });

              const newTexIdx = gltf.textures.length;
              gltf.textures.push({ sampler: samplerIdx, source: newImgIdx });

              if (!mat.pbrMetallicRoughness) mat.pbrMetallicRoughness = {};
              mat.pbrMetallicRoughness.metallicRoughnessTexture = { index: newTexIdx };
              mat.pbrMetallicRoughness.roughnessFactor = 1.0;
              mat.pbrMetallicRoughness.metallicFactor = 1.0;
              roughnessMapCount++;
            }
          }
        }
      }
    }

    // 7. Reassemble BIN Chunk with 4-byte Alignment
    const align4 = (len: number) => (len + 3) & ~3;
    const alignedSlices: Buffer[] = [];
    let currentOffset = 0;

    for (let i = 0; i < bufferViews.length; i++) {
      const origBv = bufferViews[i];
      const slice = processedBufferViews[i];
      const paddedLength = align4(slice.length);
      const paddedBuffer = Buffer.alloc(paddedLength, 0);
      slice.copy(paddedBuffer, 0);

      origBv.byteOffset = currentOffset;
      origBv.byteLength = slice.length;

      alignedSlices.push(paddedBuffer);
      currentOffset += paddedLength;
    }

    const newBinChunk = Buffer.concat(alignedSlices);
    if (gltf.buffers && gltf.buffers[0]) {
      gltf.buffers[0].byteLength = newBinChunk.length;
    }

    // 8. Serialize JSON Chunk with 4-byte Space Padding (0x20)
    const newJsonStr = JSON.stringify(gltf);
    let newJsonBuf = Buffer.from(newJsonStr, 'utf8');
    const jsonPadding = (4 - (newJsonBuf.length % 4)) % 4;
    if (jsonPadding > 0) {
      newJsonBuf = Buffer.concat([newJsonBuf, Buffer.alloc(jsonPadding, 0x20)]);
    }

    // 9. Pack Final Binary GLB
    const totalGlbLength = 12 + 8 + newJsonBuf.length + 8 + newBinChunk.length;
    const finalGlbBuffer = Buffer.alloc(totalGlbLength);

    // GLB Header
    finalGlbBuffer.writeUInt32LE(0x46546C67, 0); // magic
    finalGlbBuffer.writeUInt32LE(2, 4);          // version
    finalGlbBuffer.writeUInt32LE(totalGlbLength, 8); // total length

    // Chunk 0: JSON
    finalGlbBuffer.writeUInt32LE(newJsonBuf.length, 12);
    finalGlbBuffer.writeUInt32LE(0x4E4F534A, 16); // JSON
    newJsonBuf.copy(finalGlbBuffer, 20);

    // Chunk 1: BIN
    const binHeaderOffset = 20 + newJsonBuf.length;
    finalGlbBuffer.writeUInt32LE(newBinChunk.length, binHeaderOffset);
    finalGlbBuffer.writeUInt32LE(0x004E4942, binHeaderOffset + 4); // BIN
    newBinChunk.copy(finalGlbBuffer, binHeaderOffset + 8);

    // Write file
    const outputDir = path.dirname(outputGlbPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    fs.writeFileSync(outputGlbPath, finalGlbBuffer);

    // Re-read the written GLB and compare every original non-image bufferView with the input bytes.
    const geometryBytesIdentical = this.nonImageBufferViewsMatch(glbBuffer, fs.readFileSync(outputGlbPath), imageBvIndices, originalBufferViewCount);

    const durationMs = performance.now() - startTime;
    return {
      success: channelResults.length > 0,
      inputGlbPath,
      outputGlbPath,
      textureCount: channelResults.length,
      failedTextures,
      geometryBytesIdentical,
      originalByteLength,
      recoloredByteLength: finalGlbBuffer.length,
      durationMs,
      palette,
      pbrGenerated: (pbr.generateNormalMaps || pbr.generateRoughnessMaps) ? {
        normalMapCount,
        roughnessMapCount
      } : undefined
    };
  }

  /**
   * Concurrency worker pool for image decoding, transformation, and encoding
   */
  private static async processImageTasksInPool(
    tasks: Array<{ imageIndex: number; bvIndex: number; buffer: Buffer; mimeType: string }>,
    concurrency: number,
    palette: NanoBananaGlbPalette,
    shadowLift: number,
    highlightCompress: number,
    midtoneWeight: number,
    jpegQuality: number,
    segmentation: Required<MaterialSegmentationOptions>,
    pbr: Required<PbrSynthesisOptions>,
    onCompleted: (result: ProcessedImageChannels) => void
  ): Promise<void> {
    let index = 0;
    const worker = async () => {
      while (index < tasks.length) {
        const currentIdx = index++;
        const task = tasks[currentIdx]!;
        try {
          const result = await this.processSingleImage(
            task.imageIndex,
            task.bvIndex,
            task.buffer,
            task.mimeType,
            palette,
            shadowLift,
            highlightCompress,
            midtoneWeight,
            jpegQuality,
            segmentation,
            pbr
          );
          onCompleted(result);
        } catch (err) {
          // Keep the original bytes so the GLB stays valid, and report the texture as failed (not recoloured).
          onCompleted({
            imageIndex: task.imageIndex,
            bvIndex: task.bvIndex,
            recoloredBuf: task.buffer,
            failure: err instanceof Error ? err.message : String(err)
          });
        }
      }
    };

    const pool = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker());
    await Promise.all(pool);
  }

  /**
   * Process a single texture image: decode, segment, synthesize normal/roughness, and re-encode
   */
  private static async processSingleImage(
    imageIndex: number,
    bvIndex: number,
    imgBuffer: Buffer,
    mimeType: string,
    palette: NanoBananaGlbPalette,
    shadowLift: number,
    highlightCompress: number,
    midtoneWeight: number,
    jpegQuality: number,
    segmentation: Required<MaterialSegmentationOptions>,
    pbr: Required<PbrSynthesisOptions>
  ): Promise<ProcessedImageChannels> {
    // 1. Decode Image to Raw RGBA (throws on an unknown format or a failed decode)
    const decoded = await decodeImageToRgba(imgBuffer);
    const dims = { width: decoded.width, height: decoded.height };
    const rawRgba = decoded.rgba;
    if (rawRgba.length !== dims.width * dims.height * 4) {
      throw new Error(`decoded ${rawRgba.length} bytes for a ${dims.width}x${dims.height} image`);
    }

    // 2. Apply Segmentation & Material Synthesis
    const { recoloredRgba, normalRgba, roughnessRgba } = this.transformRgbaWithSegmentation(
      rawRgba,
      dims.width,
      dims.height,
      palette,
      shadowLift,
      highlightCompress,
      midtoneWeight,
      segmentation,
      pbr
    );

    // 3. Re-encode Recycled Channels
    const isPng = mimeType.includes('png');
    const recoloredBuf = await this.encodeFromRgba(recoloredRgba, dims.width, dims.height, isPng, jpegQuality);

    let normalBuf: Buffer | undefined;
    if (pbr.generateNormalMaps && normalRgba) {
      normalBuf = await this.encodeFromRgba(normalRgba, dims.width, dims.height, false, jpegQuality);
    }

    let roughnessBuf: Buffer | undefined;
    if (pbr.generateRoughnessMaps && roughnessRgba) {
      roughnessBuf = await this.encodeFromRgba(roughnessRgba, dims.width, dims.height, false, jpegQuality);
    }

    return {
      imageIndex,
      bvIndex,
      recoloredBuf,
      normalBuf,
      roughnessBuf
    };
  }

  /** Splits a GLB into its parsed JSON and BIN chunk. */
  private static readGlbChunks(glb: Buffer): { gltf: any; bin: Buffer } {
    const jsonLength = glb.readUInt32LE(12);
    const gltf = JSON.parse(glb.toString('utf8', 20, 20 + jsonLength));
    const binHeader = 20 + jsonLength;
    const binLength = glb.readUInt32LE(binHeader);
    return { gltf, bin: glb.subarray(binHeader + 8, binHeader + 8 + binLength) };
  }

  /** True when bufferViews [0, count) that are not images hold identical bytes in both GLBs. */
  private static nonImageBufferViewsMatch(input: Buffer, output: Buffer, imageBvIndices: Set<number>, count: number): boolean {
    const a = this.readGlbChunks(input);
    const b = this.readGlbChunks(output);
    for (let i = 0; i < count; i++) {
      if (imageBvIndices.has(i)) continue;
      const va = a.gltf.bufferViews?.[i];
      const vb = b.gltf.bufferViews?.[i];
      if (!va || !vb || va.byteLength !== vb.byteLength) return false;
      const sa = a.bin.subarray(va.byteOffset || 0, (va.byteOffset || 0) + va.byteLength);
      const sb = b.bin.subarray(vb.byteOffset || 0, (vb.byteOffset || 0) + vb.byteLength);
      if (!sa.equals(sb)) return false;
    }
    return true;
  }

  /**
   * Legacy / backward-compatible CIELAB transform helper
   */
  public static transformRgbaInCielab(
    raw: Buffer,
    palette: NanoBananaGlbPalette,
    shadowLift: number,
    highlightCompress: number,
    midtoneWeight: number
  ): Buffer {
    const res = this.transformRgbaWithSegmentation(
      raw,
      raw.length / 4,
      1,
      palette,
      shadowLift,
      highlightCompress,
      midtoneWeight,
      {
        enableSegmentation: false,
        protectFoliage: false,
        foliageColor: DEFAULT_FOLIAGE_LAB,
        protectAsphalt: false,
        asphaltColor: DEFAULT_ASPHALT_LAB
      },
      {
        generateNormalMaps: false,
        normalStrength: 2.0,
        generateRoughnessMaps: false,
        masonryRoughness: 0.88,
        foliageRoughness: 0.72,
        asphaltRoughness: 0.48
      }
    );
    return res.recoloredRgba;
  }

  /**
   * Fast header dimension parser for JPEG & PNG
   */
  public static parseImageDimensions(buf: Buffer): { width: number; height: number } | null {
    if (buf.length < 16) return null;

    // JPEG detection: 0xFFD8
    if (buf[0] === 0xFF && buf[1] === 0xD8) {
      let i = 2;
      while (i < buf.length) {
        if (buf[i] !== 0xFF) { i++; continue; }
        const marker = buf[i + 1];
        if (marker === 0xC0 || marker === 0xC2) {
          const height = buf.readUInt16BE(i + 5);
          const width = buf.readUInt16BE(i + 7);
          return { width, height };
        }
        const len = buf.readUInt16BE(i + 2);
        i += 2 + len;
      }
      return null;
    }

    // PNG detection: \x89PNG\r\n\x1a\n
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
      const width = buf.readUInt32BE(16);
      const height = buf.readUInt32BE(20);
      return { width, height };
    }

    return null;
  }

  /**
   * Encode raw RGBA into PNG, or JPEG at an ffmpeg-style qscale (1 best .. 31), failing loudly (never empty bytes).
   */
  private static encodeFromRgba(
    rgbaBuf: Buffer,
    width: number,
    height: number,
    isPng: boolean,
    qscale: number
  ): Promise<Buffer> {
    if (isPng) return encodeRgbaToPng(rgbaBuf, width, height);
    const quality = Math.max(1, Math.min(100, 100 - (Math.max(1, qscale) - 1) * 5));
    return encodeRgbaToJpeg(rgbaBuf, width, height, { quality });
  }

  /**
   * Unified Single-Pass RGBA Material Segmentation & PBR Channel Generation
   */
  public static transformRgbaWithSegmentation(
    raw: Buffer,
    width: number,
    height: number,
    palette: NanoBananaGlbPalette,
    shadowLift: number,
    highlightCompress: number,
    midtoneWeight: number,
    segmentation: Required<MaterialSegmentationOptions>,
    pbr: Required<PbrSynthesisOptions>
  ): { recoloredRgba: Buffer; normalRgba?: Buffer; roughnessRgba?: Buffer } {
    const pixelCount = width * height;
    const recolored = Buffer.alloc(raw.length);
    const lumArray = new Float32Array(pixelCount);
    const roughnessArray = new Float32Array(pixelCount);

    const prussian = palette.shadow;
    const terracotta = palette.midtone;
    const amber = palette.highlight;
    const foliage = segmentation.foliageColor;
    const asphalt = segmentation.asphaltColor;

    for (let i = 0; i < raw.length; i += 4) {
      const pIdx = i / 4;
      const r = raw[i]!;
      const g = raw[i + 1]!;
      const b = raw[i + 2]!;
      const a = raw[i + 3]!;

      // Convert sRGB to CIELAB
      const [L, srcA, srcB] = this.rgbToLab(r, g, b);
      lumArray[pIdx] = L;

      // Compute hue angle and chroma
      const C = Math.sqrt(srcA * srcA + srcB * srcB);
      let h = Math.atan2(srcB, srcA) * (180.0 / Math.PI);
      if (h < 0) h += 360;

      const exG = (2.0 * g - r - b) / 255.0;

      let targetL = L;
      let targetA = srcA;
      let targetB = srcB;
      let roughness = pbr.masonryRoughness;

      if (segmentation.enableSegmentation && segmentation.protectFoliage &&
          ((h >= 88 && h <= 170 && srcA < 0 && C > 5.0) || (exG > 0.04 && g > r && g > b))) {
        // === FOLIAGE / VEGETATION (Cypress Dusk Emerald) ===
        targetL = Math.max(12, L * 0.88);
        targetA = srcA * 0.25 + foliage.a * 0.75;
        targetB = srcB * 0.25 + foliage.b * 0.75;
        roughness = pbr.foliageRoughness;
      } else if (segmentation.enableSegmentation && segmentation.protectAsphalt &&
                 (C < 8.5 && L >= 16 && L <= 58)) {
        // === ASPHALT / ROADWAY / PAVING (Twilight Slate) ===
        targetL = L * 0.85;
        targetA = srcA * 0.35 + asphalt.a * 0.65;
        targetB = srcB * 0.35 + asphalt.b * 0.65;
        roughness = pbr.asphaltRoughness; // Smooth for wet twilight specular sheen
      } else {
        // === ARCHITECTURAL MASONRY / TRAVERTINE WALLS ===
        roughness = pbr.masonryRoughness;
        if (L < 35) {
          // Shadow Crevice -> Prussian Blue Fill & Lift
          const t = Math.max(0, 1 - L / 35);
          targetL = L * (1 - t) + (prussian.L + 8 * shadowLift) * t;
          targetA = srcA * (1 - t * 0.8) + prussian.a * (t * 0.8);
          targetB = srcB * (1 - t * 0.8) + prussian.b * (t * 0.8);
        } else if (L > 75) {
          // Highlight -> Warm Amber Tone & Soft Compression
          const t = Math.min(1, (L - 75) / 25);
          targetL = 75 + (L - 75) * (1.0 - highlightCompress);
          targetA = srcA * (1 - t * 0.85) + amber.a * (t * 0.85);
          targetB = srcB * (1 - t * 0.85) + amber.b * (t * 0.85);
        } else {
          // Midtones -> Warm Terracotta Facade
          const t = midtoneWeight;
          targetL = L * 0.95;
          targetA = srcA * (1 - t) + terracotta.a * t;
          targetB = srcB * (1 - t) + terracotta.b * t;
        }
      }

      roughnessArray[pIdx] = roughness;

      // Convert CIELAB back to sRGB
      const [outR, outG, outB] = this.labToRgb(targetL, targetA, targetB);
      recolored[i] = outR;
      recolored[i + 1] = outG;
      recolored[i + 2] = outB;
      recolored[i + 3] = a;
    }

    // Synthesize Normal Map (Sobel gradient on luminance)
    let normalRgba: Buffer | undefined;
    if (pbr.generateNormalMaps) {
      normalRgba = Buffer.alloc(raw.length);
      const str = pbr.normalStrength;

      for (let y = 0; y < height; y++) {
        const y0 = Math.max(0, y - 1);
        const y1 = Math.min(height - 1, y + 1);

        for (let x = 0; x < width; x++) {
          const x0 = Math.max(0, x - 1);
          const x1 = Math.min(width - 1, x + 1);

          const lLeft = lumArray[y * width + x0]!;
          const lRight = lumArray[y * width + x1]!;
          const lUp = lumArray[y0 * width + x]!;
          const lDown = lumArray[y1 * width + x]!;

          const dU = (lRight - lLeft) / 255.0;
          const dV = (lDown - lUp) / 255.0;

          let nx = -dU * str;
          let ny = -dV * str;
          let nz = 1.0;

          const invLen = 1.0 / Math.sqrt(nx * nx + ny * ny + nz * nz);
          nx *= invLen;
          ny *= invLen;
          nz *= invLen;

          const pIdx = (y * width + x) * 4;
          normalRgba[pIdx] = Math.round((nx * 0.5 + 0.5) * 255.0);
          normalRgba[pIdx + 1] = Math.round((ny * 0.5 + 0.5) * 255.0);
          normalRgba[pIdx + 2] = Math.round((nz * 0.5 + 0.5) * 255.0);
          normalRgba[pIdx + 3] = 255;
        }
      }
    }

    // Synthesize Roughness Map (Green = Roughness, Blue = Metalness)
    let roughnessRgba: Buffer | undefined;
    if (pbr.generateRoughnessMaps) {
      roughnessRgba = Buffer.alloc(raw.length);
      for (let i = 0; i < pixelCount; i++) {
        const pIdx = i * 4;
        const rVal = Math.round(roughnessArray[i]! * 255.0);
        roughnessRgba[pIdx] = 255;      // Red (unused / AO)
        roughnessRgba[pIdx + 1] = rVal; // Green (Roughness)
        roughnessRgba[pIdx + 2] = 0;    // Blue (Metalness = 0)
        roughnessRgba[pIdx + 3] = 255;  // Alpha
      }
    }

    return { recoloredRgba: recolored, normalRgba, roughnessRgba };
  }

  // --- Fast Color Math Utilities ---

  private static srgbToLinear(c: number): number {
    const norm = c / 255;
    return norm <= 0.04045 ? norm / 12.92 : Math.pow((norm + 0.055) / 1.055, 2.4);
  }

  private static fLab(t: number): number {
    return t > 0.008856 ? Math.cbrt(t) : (7.787 * t) + (16 / 116);
  }

  private static invF(t: number): number {
    const t3 = t * t * t;
    return t3 > 0.008856 ? t3 : (t - 16 / 116) / 7.787;
  }

  public static rgbToLab(r: number, g: number, b: number): [number, number, number] {
    const rL = this.srgbToLinear(r);
    const gL = this.srgbToLinear(g);
    const bL = this.srgbToLinear(b);

    const x = rL * 0.4124564 + gL * 0.3575761 + bL * 0.1804375;
    const y = rL * 0.2126729 + gL * 0.7151522 + bL * 0.0721750;
    const z = rL * 0.0193339 + gL * 0.1191920 + bL * 0.9503041;

    const xn = 0.95047;
    const yn = 1.00000;
    const zn = 1.08883;

    const fx = this.fLab(x / xn);
    const fy = this.fLab(y / yn);
    const fz = this.fLab(z / zn);

    const L = 116 * fy - 16;
    const a = 500 * (fx - fy);
    const bVal = 200 * (fy - fz);

    return [L, a, bVal];
  }

  public static labToRgb(L: number, a: number, b: number): [number, number, number] {
    const fy = (L + 16) / 116;
    const fx = a / 500 + fy;
    const fz = fy - b / 200;

    const xn = 0.95047;
    const yn = 1.00000;
    const zn = 1.08883;

    const x = xn * this.invF(fx);
    const y = yn * this.invF(fy);
    const z = zn * this.invF(fz);

    const rL = x * 3.2404542 - y * 1.5371385 - z * 0.4985314;
    const gL = -x * 0.9692660 + y * 1.8760108 + z * 0.0415560;
    const bL = x * 0.0556434 - y * 0.2040259 + z * 1.0572252;

    const toSrgb = (c: number) => {
      const clamped = Math.max(0, Math.min(1, c));
      const val = clamped <= 0.0031308
        ? 12.92 * clamped
        : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
      return Math.round(val * 255);
    };

    return [toSrgb(rL), toSrgb(gL), toSrgb(bL)];
  }

  /**
   * High-level programmatic API method for recoloring a 3D Tile GLB model
   */
  public static async recolor(options: GlbRecolorApiOptions): Promise<GlbRecolorApiResult> {
    return recolor3DTilesGlb(options);
  }
}

/**
 * Standalone High-Level API to recolor a 3D Tile GLB model
 * with hue-aware segmentation and PBR normal/roughness synthesis.
 */
export async function recolor3DTilesGlb(options: GlbRecolorApiOptions): Promise<GlbRecolorApiResult> {
  const startTime = performance.now();

  // 1. Resolve Target Palette
  let resolvedPalette: NanoBananaGlbPalette = DEFAULT_NANO_BANANA_GLB_PALETTE;
  if (options.palettePreset && GLB_RECOLOR_PRESETS[options.palettePreset]) {
    resolvedPalette = { ...GLB_RECOLOR_PRESETS[options.palettePreset] };
  }
  if (options.customPalette) {
    const cp = options.customPalette as Record<string, any>;
    if (typeof cp.shadowHex === 'string') resolvedPalette.shadow = hexToLab(cp.shadowHex);
    else if (cp.shadow && typeof cp.shadow.L === 'number') resolvedPalette.shadow = cp.shadow;

    if (typeof cp.midtoneHex === 'string') resolvedPalette.midtone = hexToLab(cp.midtoneHex);
    else if (cp.midtone && typeof cp.midtone.L === 'number') resolvedPalette.midtone = cp.midtone;

    if (typeof cp.highlightHex === 'string') resolvedPalette.highlight = hexToLab(cp.highlightHex);
    else if (cp.highlight && typeof cp.highlight.L === 'number') resolvedPalette.highlight = cp.highlight;

    if (typeof cp.accentHex === 'string') resolvedPalette.accent = hexToLab(cp.accentHex);
    else if (cp.accent && typeof cp.accent.L === 'number') resolvedPalette.accent = cp.accent;
  }

  // 3. Resolve Input Path & Temporary Files
  let tempInputPath: string | undefined;
  let resolvedInputPath: string;
  if (typeof options.inputGlb === 'string') {
    resolvedInputPath = options.inputGlb;
  } else if (Buffer.isBuffer(options.inputGlb)) {
    tempInputPath = path.join(os.tmpdir(), `glb_recolor_in_${Date.now()}_${Math.random().toString(36).slice(2)}.glb`);
    fs.writeFileSync(tempInputPath, options.inputGlb);
    resolvedInputPath = tempInputPath;
  } else {
    throw new Error('recolor3DTilesGlb: "inputGlb" must be a file path string or Buffer.');
  }

  let tempOutputPath: string | undefined;
  let resolvedOutputPath: string;
  if (options.outputGlbPath) {
    resolvedOutputPath = options.outputGlbPath;
    fs.mkdirSync(path.dirname(resolvedOutputPath), { recursive: true });
  } else {
    tempOutputPath = path.join(os.tmpdir(), `glb_recolor_out_${Date.now()}_${Math.random().toString(36).slice(2)}.glb`);
    resolvedOutputPath = tempOutputPath;
  }

  // 4. Construct Segmentation and PBR Options
  const foliageColor = options.segmentation?.foliageHex
    ? hexToLab(options.segmentation.foliageHex)
    : DEFAULT_FOLIAGE_LAB;
  const asphaltColor = options.segmentation?.asphaltHex
    ? hexToLab(options.segmentation.asphaltHex)
    : DEFAULT_ASPHALT_LAB;

  const recolorOptions: GlbRecolorOptions = {
    palette: resolvedPalette,
    shadowLift: options.shadowLift ?? 0.7,
    highlightCompress: options.highlightCompress ?? 0.4,
    concurrency: options.concurrency ?? 12,
    jpegQuality: options.jpegQuality ?? 2,
    segmentation: {
      enableSegmentation: options.segmentation?.enableSegmentation ?? true,
      protectFoliage: options.segmentation?.protectFoliage ?? true,
      foliageColor,
      protectAsphalt: options.segmentation?.protectAsphalt ?? true,
      asphaltColor
    },
    pbr: {
      generateNormalMaps: options.pbr?.generateNormalMaps ?? true,
      normalStrength: options.pbr?.normalStrength ?? 2.0,
      generateRoughnessMaps: options.pbr?.generateRoughnessMaps ?? true,
      masonryRoughness: options.pbr?.masonryRoughness ?? 0.88,
      foliageRoughness: options.pbr?.foliageRoughness ?? 0.72,
      asphaltRoughness: options.pbr?.asphaltRoughness ?? 0.48
    }
  };

  try {
    const recolorResult = await GlbTextureRecolorService.recolorGlb(
      resolvedInputPath,
      resolvedOutputPath,
      recolorOptions
    );

    const outBuffer = fs.readFileSync(resolvedOutputPath);
    const durationMs = Math.round(performance.now() - startTime);

    const normalCount = recolorResult.pbrGenerated?.normalMapCount ?? 0;
    const roughCount = recolorResult.pbrGenerated?.roughnessMapCount ?? 0;

    const failed = recolorResult.failedTextures;
    const failedNote = failed.length > 0
      ? ` ${failed.length} texture(s) failed and were left unchanged: ${failed.map(f => `#${f.imageIndex} (${f.reason})`).join('; ')}.`
      : '';
    const geometryNote = recolorResult.geometryBytesIdentical
      ? ' Geometry bufferViews verified byte-identical to the input.'
      : ' WARNING: geometry bufferViews differ from the input.';
    const summary = recolorResult.success
      ? `Recoloured ${recolorResult.textureCount} embedded texture(s) in ${(durationMs / 1000).toFixed(2)}s, with ${normalCount} normal map(s) and ${roughCount} roughness map(s).${failedNote}${geometryNote}`
      : `No texture was recoloured (${recolorResult.textureCount + failed.length} embedded texture(s) found).${failedNote}`;

    return {
      success: recolorResult.success,
      inputGlbPath: typeof options.inputGlb === 'string' ? options.inputGlb : undefined,
      outputGlbPath: options.outputGlbPath,
      glbBuffer: outBuffer,
      textureCount: recolorResult.textureCount,
      failedTextures: recolorResult.failedTextures,
      geometryBytesIdentical: recolorResult.geometryBytesIdentical,
      normalMapCount: normalCount,
      roughnessMapCount: roughCount,
      originalByteLength: recolorResult.originalByteLength,
      recoloredByteLength: recolorResult.recoloredByteLength,
      durationMs,
      paletteUsed: resolvedPalette,
      summary
    };
  } finally {
    if (tempInputPath && fs.existsSync(tempInputPath)) {
      try { fs.unlinkSync(tempInputPath); } catch {}
    }
    if (tempOutputPath && fs.existsSync(tempOutputPath)) {
      try { fs.unlinkSync(tempOutputPath); } catch {}
    }
  }
}

