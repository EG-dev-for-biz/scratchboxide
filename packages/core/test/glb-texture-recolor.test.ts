import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  GlbTextureRecolorService,
  DEFAULT_NANO_BANANA_GLB_PALETTE
} from '../src/node/spatial/GlbTextureRecolorService';

describe('GlbTextureRecolorService (Architecture 2: Offline Texture Atlas Re-grade)', () => {
  it('accurately parses JPEG and PNG header dimensions without dependencies', () => {
    // 1. Synthetic 2x2 PNG
    const pngHeader = Buffer.from([
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // signature
      0x00, 0x00, 0x00, 0x0D,                         // IHDR length 13
      0x49, 0x48, 0x44, 0x52,                         // 'IHDR'
      0x00, 0x00, 0x01, 0x00,                         // width: 256
      0x00, 0x00, 0x02, 0x00                          // height: 512
    ]);
    const dimsPng = GlbTextureRecolorService.parseImageDimensions(pngHeader);
    expect(dimsPng).toEqual({ width: 256, height: 512 });

    // 2. Synthetic JPEG SOF0
    const jpegHeader = Buffer.from([
      0xFF, 0xD8,                                     // SOI
      0xFF, 0xE0, 0x00, 0x04, 0x00, 0x00,             // APP0
      0xFF, 0xC0, 0x00, 0x11, 0x08,                   // SOF0: precision 8
      0x01, 0x00,                                     // height: 256
      0x00, 0x80                                      // width: 128
    ]);
    const dimsJpeg = GlbTextureRecolorService.parseImageDimensions(jpegHeader);
    expect(dimsJpeg).toEqual({ width: 128, height: 256 });
  });

  it('performs accurate sRGB <-> CIELAB round-trip conversions', () => {
    const testColors: [number, number, number][] = [
      [255, 255, 255],
      [0, 0, 0],
      [224, 107, 85], // Terracotta
      [11, 25, 44],   // Prussian Blue
      [255, 184, 76]  // Amber
    ];

    for (const [r, g, b] of testColors) {
      const [L, a, bLab] = GlbTextureRecolorService.rgbToLab(r, g, b);
      const [recR, recG, recB] = GlbTextureRecolorService.labToRgb(L, a, bLab);

      // Quantization error should be minimal (within 2 intensity levels)
      expect(Math.abs(recR - r)).toBeLessThanOrEqual(2);
      expect(Math.abs(recG - g)).toBeLessThanOrEqual(2);
      expect(Math.abs(recB - b)).toBeLessThanOrEqual(2);
    }
  });

  it('transforms shadow, midtone, and highlight regions toward the target palette', () => {
    // 3 pixels: shadow (dark gray), midtone (travertine beige), highlight (near-white)
    const rawRgba = Buffer.from([
      20, 20, 20, 255,       // dark shadow (L ~ 7)
      180, 170, 150, 255,    // travertine midtone (L ~ 70)
      245, 245, 240, 255     // highlight (L ~ 96)
    ]);

    const transformed = GlbTextureRecolorService.transformRgbaInCielab(
      rawRgba,
      DEFAULT_NANO_BANANA_GLB_PALETTE,
      0.7,
      0.4,
      0.75
    );

    // Pixel 0 (shadow) should have shifted to Prussian Blue (blue > red)
    const shadowR = transformed[0]!;
    const shadowB = transformed[2]!;
    expect(shadowB).toBeGreaterThan(shadowR);

    // Pixel 1 (travertine midtone) should have shifted to warm terracotta (red > blue)
    const midR = transformed[4]!;
    const midG = transformed[5]!;
    const midB = transformed[6]!;
    expect(midR).toBeGreaterThan(midG);
    expect(midG).toBeGreaterThan(midB);

    // Pixel 2 (highlight) should be warmed by amber tone
    const hiR = transformed[8]!;
    const hiG = transformed[9]!;
    const hiB = transformed[10]!;
    expect(hiR).toBeGreaterThan(hiB);
  });

  it('accurately segments foliage and asphalt from travertine masonry', () => {
    // 3 pixels:
    // Pixel 0: Foliage green (r=45, g=115, b=45)
    // Pixel 1: Asphalt gray (r=40, g=42, b=45, neutral L~18, C~2)
    // Pixel 2: Travertine stone (r=180, g=160, b=140)
    const rawRgba = Buffer.from([
      45, 115, 45, 255,
      40, 42, 45, 255,
      180, 160, 140, 255
    ]);

    const result = GlbTextureRecolorService.transformRgbaWithSegmentation(
      rawRgba,
      3,
      1,
      DEFAULT_NANO_BANANA_GLB_PALETTE,
      0.7,
      0.4,
      0.75,
      {
        enableSegmentation: true,
        protectFoliage: true,
        foliageColor: { L: 24, a: -18, b: 12 },
        protectAsphalt: true,
        asphaltColor: { L: 19, a: -1.5, b: -6 }
      },
      {
        generateNormalMaps: true,
        normalStrength: 2.0,
        generateRoughnessMaps: true,
        masonryRoughness: 0.88,
        foliageRoughness: 0.72,
        asphaltRoughness: 0.48
      }
    );

    // Pixel 0 (foliage): Green channel must dominate (protected foliage olive/green)
    const foliageR = result.recoloredRgba[0]!;
    const foliageG = result.recoloredRgba[1]!;
    const foliageB = result.recoloredRgba[2]!;
    expect(foliageG).toBeGreaterThan(foliageR);
    expect(foliageG).toBeGreaterThan(foliageB);

    // Pixel 1 (asphalt): Cool slate tone (blue >= red, low saturation)
    const asphaltR = result.recoloredRgba[4]!;
    const asphaltB = result.recoloredRgba[6]!;
    expect(asphaltB).toBeGreaterThanOrEqual(asphaltR);

    // Pixel 2 (masonry): Warm terracotta (red > green > blue)
    const masonR = result.recoloredRgba[8]!;
    const masonG = result.recoloredRgba[9]!;
    const masonB = result.recoloredRgba[10]!;
    expect(masonR).toBeGreaterThan(masonG);
    expect(masonG).toBeGreaterThan(masonB);

    // PBR Channels
    expect(result.normalRgba).toBeDefined();
    expect(result.roughnessRgba).toBeDefined();
    expect(result.normalRgba!.length).toBe(rawRgba.length);
    expect(result.roughnessRgba!.length).toBe(rawRgba.length);

    // Verify roughness values in Green channel
    const foliageRoughness = result.roughnessRgba![1]!; // Green channel
    const asphaltRoughness = result.roughnessRgba![5]!; // Green channel
    const masonryRoughness = result.roughnessRgba![9]!; // Green channel
    expect(asphaltRoughness).toBeLessThan(masonryRoughness);
    expect(asphaltRoughness).toBeLessThan(foliageRoughness);
  });

  it('processes a real Google 3D Tile GLB model and preserves 100% geometric integrity', async () => {
    const inputGlb = path.resolve(__dirname, '../../public/models/google_tiles_textured_area.glb');
    if (!fs.existsSync(inputGlb)) {
      console.warn('Skipping integration test: test asset not present at', inputGlb);
      return;
    }

    const testOutputDir = path.resolve(__dirname, 'temp_recolor_output');
    const outputGlb = path.join(testOutputDir, 'test_nyc_recolored.glb');

    try {
      const result = await GlbTextureRecolorService.recolorGlb(inputGlb, outputGlb, {
        concurrency: 4
      });

      expect(result.success).toBe(true);
      expect(result.textureCount).toBeGreaterThan(0);
      expect(fs.existsSync(outputGlb)).toBe(true);

      // Verify output GLB structure
      const outBuf = fs.readFileSync(outputGlb);
      expect(outBuf.readUInt32LE(0)).toBe(0x46546C67); // 'glTF'
      expect(outBuf.readUInt32LE(4)).toBe(2);          // version 2

      const jsonLen = outBuf.readUInt32LE(12);
      expect(outBuf.readUInt32LE(16)).toBe(0x4E4F534A); // 'JSON'
      const gltfOut = JSON.parse(outBuf.toString('utf8', 20, 20 + jsonLen));

      // Inspect that geometry bufferViews exist and are valid
      expect(gltfOut.meshes.length).toBeGreaterThan(0);
      expect(gltfOut.bufferViews.length).toBeGreaterThan(0);

      const inBuf = fs.readFileSync(inputGlb);
      const inJsonLen = inBuf.readUInt32LE(12);
      const gltfIn = JSON.parse(inBuf.toString('utf8', 20, 20 + inJsonLen));

      // Geometry vertex counts and triangle counts must match EXACTLY
      expect(gltfOut.meshes.length).toBe(gltfIn.meshes.length);
      expect(gltfOut.accessors.length).toBe(gltfIn.accessors.length);
      for (let i = 0; i < gltfIn.accessors.length; i++) {
        expect(gltfOut.accessors[i].count).toBe(gltfIn.accessors[i].count);
        expect(gltfOut.accessors[i].type).toBe(gltfIn.accessors[i].type);
        expect(gltfOut.accessors[i].componentType).toBe(gltfIn.accessors[i].componentType);
      }
    } finally {
      if (fs.existsSync(testOutputDir)) {
        fs.rmSync(testOutputDir, { recursive: true, force: true });
      }
    }
  }, 30000);
});
