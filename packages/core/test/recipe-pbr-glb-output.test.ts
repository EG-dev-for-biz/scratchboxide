import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const MODELS = path.resolve(__dirname, '../../../public/models');
const SOURCE = path.join(MODELS, 'colosseum_rome_textured.glb');
const JPEG_GLB = path.join(MODELS, 'colosseum_rome_recipe_pbr.glb');
const KTX2_GLB = path.join(MODELS, 'colosseum_rome_recipe_pbr_ktx2.glb');
const KTX2_MAGIC = Buffer.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);

function readGlb(file: string) {
  const buf = fs.readFileSync(file);
  expect(buf.readUInt32LE(0)).toBe(0x46546c67);
  expect(buf.readUInt32LE(8)).toBe(buf.length);
  const jsonLen = buf.readUInt32LE(12);
  const gltf = JSON.parse(buf.toString('utf8', 20, 20 + jsonLen));
  const binStart = 20 + jsonLen;
  const bin = buf.subarray(binStart + 8, binStart + 8 + buf.readUInt32LE(binStart));
  const view = (i: number) => {
    const bv = gltf.bufferViews[i];
    return bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
  };
  return { gltf, bin, view };
}

function expectValidBuffers(gltf: any, binLength: number) {
  for (const bv of gltf.bufferViews) expect((bv.byteOffset || 0) + bv.byteLength).toBeLessThanOrEqual(binLength);
  const sizes: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
  const comps: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
  for (const acc of gltf.accessors) {
    const bv = gltf.bufferViews[acc.bufferView];
    const elem = sizes[acc.componentType] * comps[acc.type];
    const stride = bv.byteStride || elem;
    expect((acc.byteOffset || 0) + stride * (acc.count - 1) + elem).toBeLessThanOrEqual(bv.byteLength);
  }
}

function expectDetailMaps(gltf: any) {
  const recipe = gltf.scenes[gltf.scene ?? 0].extras.scratchboxRecipe;
  for (const kind of ['stone', 'asphalt', 'foliage']) {
    expect(fs.existsSync(path.join(MODELS, recipe.detailMaps[kind].uri))).toBe(true);
  }
  return recipe;
}

describe.skipIf(!fs.existsSync(JPEG_GLB))('Recipe PBR GLB (original JPEG textures)', () => {
  it('keeps every source image byte-for-byte and declares mesh quantization', () => {
    const src = readGlb(SOURCE);
    const out = readGlb(JPEG_GLB);
    expectValidBuffers(out.gltf, out.bin.length);
    expect(out.gltf.extensionsRequired).toContain('KHR_mesh_quantization');
    expect(out.gltf.images.length).toBe(src.gltf.images.length);
    out.gltf.images.forEach((img: any, i: number) => {
      expect(img.mimeType).toBe(src.gltf.images[i].mimeType);
      expect(out.view(img.bufferView).equals(src.view(src.gltf.images[i].bufferView))).toBe(true);
    });
    expect(expectDetailMaps(out.gltf).textureFormat).toBe('jpeg');
  });
});

describe.skipIf(!fs.existsSync(SOURCE))('Recipe PBR GLB (KTX2 / Basis Universal textures)', () => {
  it('stores one mipmapped KTX2 image per texture via KHR_texture_basisu', () => {
    expect(fs.existsSync(KTX2_GLB)).toBe(true);
    const src = readGlb(SOURCE);
    const out = readGlb(KTX2_GLB);
    expectValidBuffers(out.gltf, out.bin.length);
    expect(out.gltf.extensionsRequired).toEqual(expect.arrayContaining(['KHR_mesh_quantization', 'KHR_texture_basisu']));
    expect(out.gltf.textures.length).toBe(src.gltf.textures.length);
    for (const tex of out.gltf.textures) {
      const source = tex.extensions?.KHR_texture_basisu?.source;
      expect(source).toBeTypeOf('number');
      const img = out.gltf.images[source];
      expect(img.mimeType).toBe('image/ktx2');
      const bytes = out.view(img.bufferView);
      expect(bytes.subarray(0, 12).equals(KTX2_MAGIC)).toBe(true);
      expect(bytes.readUInt32LE(40)).toBeGreaterThan(1); // levelCount: mipmaps present
    }
    const recipe = expectDetailMaps(out.gltf);
    expect(recipe.textureFormat).toMatch(/^ktx2-(etc1s|uastc)$/);
    expect(recipe.stats.estimatedTextureVramMb).toBeLessThan(150);
  });
});
