/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import {
  recolor3DTilesGlb,
  GlbTextureRecolorService,
  GLB_RECOLOR_PRESETS,
  DEFAULT_NANO_BANANA_GLB_PALETTE,
  hexToLab
} from '../src/node/spatial/GlbTextureRecolorService';
import { createDefaultToolRegistry } from '../src/node/gemini/tool-registry';
import { encodePng } from '../src/node/texture-processing';
import { TaskCapabilityResolver } from '../src/node/agent/task-capability-resolver';

describe('Sophisticated 3D Tile Recoloring Engine v2 - API & Tool Suite', () => {

  describe('hexToLab Color Converter', () => {
    it('converts 6-digit hex colors to accurate CIELAB space', () => {
      // White #FFFFFF
      const whiteLab = hexToLab('#FFFFFF');
      expect(whiteLab.L).toBeCloseTo(100, 0);
      expect(Math.abs(whiteLab.a)).toBeLessThan(1.0);
      expect(Math.abs(whiteLab.b)).toBeLessThan(1.0);

      // Black #000000
      const blackLab = hexToLab('#000000');
      expect(blackLab.L).toBeCloseTo(0, 0);

      // Prussian Blue #0B192C
      const blueLab = hexToLab('#0B192C');
      expect(blueLab.L).toBeGreaterThan(5);
      expect(blueLab.L).toBeLessThan(20);
      expect(blueLab.b).toBeLessThan(0); // Blue coordinate is negative
    });

    it('converts 3-digit short hex colors', () => {
      const redShort = hexToLab('#F00');
      const redFull = hexToLab('#FF0000');
      expect(redShort.L).toBeCloseTo(redFull.L, 1);
      expect(redShort.a).toBeCloseTo(redFull.a, 1);
      expect(redShort.b).toBeCloseTo(redFull.b, 1);
    });
  });

  /** Real GLB: one triangle (positions bufferView) plus the given embedded images, the first bound as baseColorTexture. */
  function buildTexturedGlb(images: Buffer[]): Buffer {
    const positions = Buffer.alloc(36);
    [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((v, i) => positions.writeFloatLE(v, i * 4));
    const views: Buffer[] = [positions, ...images];
    const bufferViews: any[] = [];
    let offset = 0;
    for (const v of views) {
      bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: v.length });
      offset += (v.length + 3) & ~3;
    }
    const bin = Buffer.concat(views.map(v => Buffer.concat([v, Buffer.alloc(((v.length + 3) & ~3) - v.length)])));
    const gltf = {
      asset: { version: '2.0' },
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
      materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
      textures: images.map((_, i) => ({ source: i })),
      images: images.map((_, i) => ({ bufferView: i + 1, mimeType: 'image/png' })),
      bufferViews,
      buffers: [{ byteLength: bin.length }]
    };
    let json = Buffer.from(JSON.stringify(gltf));
    json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
    const header = Buffer.alloc(12);
    header.writeUInt32LE(0x46546c67, 0);
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
    const jh = Buffer.alloc(8); jh.writeUInt32LE(json.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
    const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004e4942, 4);
    return Buffer.concat([header, jh, json, bh, bin]);
  }

  function facadePng(): Buffer {
    const w = 8, h = 8;
    const rgba = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      rgba[i * 4] = 40 + i * 3; rgba[i * 4 + 1] = 90; rgba[i * 4 + 2] = 150 - i; rgba[i * 4 + 3] = 255;
    }
    return encodePng(w, h, rgba);
  }

  function readImage(glb: Buffer, imageIndex: number): Buffer {
    const jsonLength = glb.readUInt32LE(12);
    const gltf = JSON.parse(glb.toString('utf8', 20, 20 + jsonLength));
    const bin = glb.subarray(20 + jsonLength + 8);
    const bv = gltf.bufferViews[gltf.images[imageIndex].bufferView];
    return bin.subarray(bv.byteOffset, bv.byteOffset + bv.byteLength);
  }

  describe('recolor3DTilesGlb Programmatic API', () => {
    it('recolours a real embedded texture, reports an undecodable one as failed, and verifies geometry bytes', async () => {
      const original = facadePng();
      const corrupt = Buffer.from('\x89PNG this is not really a png at all', 'latin1');
      const result = await recolor3DTilesGlb({
        inputGlb: buildTexturedGlb([original, corrupt]),
        palettePreset: 'dusk_twilight',
        pbr: { generateNormalMaps: false, generateRoughnessMaps: false }
      });

      expect(result.success).toBe(true);
      expect(result.textureCount).toBe(1);
      expect(result.failedTextures.map(f => f.imageIndex)).toEqual([1]);
      expect(result.summary).toContain('1 texture(s) failed');
      expect(result.geometryBytesIdentical).toBe(true);
      expect((result as any).driftMm).toBeUndefined();
      const recoloured = readImage(result.glbBuffer, 0);
      expect(recoloured.subarray(1, 4).toString('latin1')).toBe('PNG');
      expect(recoloured.equals(original)).toBe(false);
      expect(readImage(result.glbBuffer, 1).equals(corrupt)).toBe(true);
      expect(result.paletteUsed).toEqual(DEFAULT_NANO_BANANA_GLB_PALETTE);
    });

    it('fails (success false, nothing counted) when no texture could be recoloured', async () => {
      const result = await recolor3DTilesGlb({
        inputGlb: buildTexturedGlb([Buffer.from('not an image at all, just bytes')]),
        pbr: { generateNormalMaps: false, generateRoughnessMaps: false }
      });
      expect(result.success).toBe(false);
      expect(result.textureCount).toBe(0);
      expect(result.failedTextures.length).toBe(1);
      expect(result.summary).toContain('No texture was recoloured');
    });

    it('writes the output file and resolves presets and custom swatches', async () => {
      const tempOut = path.join(os.tmpdir(), `test_recolor_${Date.now()}.glb`);
      try {
        const result = await recolor3DTilesGlb({
          inputGlb: buildTexturedGlb([facadePng()]),
          outputGlbPath: tempOut,
          palettePreset: 'golden_hour',
          pbr: { generateNormalMaps: false, generateRoughnessMaps: false }
        });
        expect(result.outputGlbPath).toBe(tempOut);
        expect(fs.readFileSync(tempOut).equals(result.glbBuffer)).toBe(true);
        expect(result.paletteUsed).toEqual(GLB_RECOLOR_PRESETS.golden_hour);
      } finally {
        if (fs.existsSync(tempOut)) fs.unlinkSync(tempOut);
      }

      expect(GLB_RECOLOR_PRESETS.cyberpunk_neon.midtone.a).toBeGreaterThan(50);
      expect(GLB_RECOLOR_PRESETS.monochrome_noir.midtone.a).toBeCloseTo(0, 1);

      const customRes = await GlbTextureRecolorService.recolor({
        inputGlb: buildTexturedGlb([facadePng()]),
        customPalette: { shadowHex: '#001122', midtoneHex: '#DDAA55', highlightHex: '#FFFFAA' },
        pbr: { generateNormalMaps: false, generateRoughnessMaps: false }
      });
      expect(customRes.paletteUsed.shadow.L).toBeGreaterThan(0);
      expect(customRes.paletteUsed.midtone.b).toBeGreaterThan(20);
      expect(customRes.paletteUsed.highlight.L).toBeGreaterThan(85);
    });
  });

  describe('google_3d_tiles_recolor_glb Gemini Agent Tool', () => {
    it('is registered in default tool registry with complete schema', () => {
      const registry = createDefaultToolRegistry();
      const declarations = registry.declarations();
      const recolorTool = declarations.find(d => d.name === 'google_3d_tiles_recolor_glb');

      expect(recolorTool).toBeDefined();
      expect(recolorTool?.description).toContain('Sophisticated v2 Architecture 2');
      expect(recolorTool?.parameters.properties.inputGlbPath).toBeDefined();
      expect(recolorTool?.parameters.properties.palettePreset).toBeDefined();
      expect(recolorTool?.parameters.properties.protectFoliage).toBeDefined();
      expect(recolorTool?.parameters.properties.protectAsphalt).toBeDefined();
      expect(recolorTool?.parameters.properties.generatePbrNormals).toBeDefined();
      expect(recolorTool?.parameters.properties.generatePbrRoughness).toBeDefined();
    });

    it('the tool ignores mockExecution: a missing input file fails instead of a placeholder "recolored successfully"', async () => {
      const registry = createDefaultToolRegistry();
      const result = await registry.dispatch('google_3d_tiles_recolor_glb', {
        inputGlbPath: '/models/colosseum.glb',
        palettePreset: 'golden_hour',
        protectFoliage: true,
        protectAsphalt: true,
        generatePbrNormals: true,
        generatePbrRoughness: true,
        mockExecution: true
      }, {} as any);

      expect(result.exec.status).toBe('failed');
      expect(result.exec.summaryResult).not.toContain('recolored successfully');
    });
  });

  describe('Two-Tier Task Capability Resolver', () => {
    it('routes 3D tile recoloring prompts to Tier 1 Native', () => {
      const prompts = [
        'recolor 3d tile glb with dusk twilight palette',
        're-color photogrammetric 3d tile model and protect foliage',
        'apply architecture 2 offline texture atlas re-grade to colosseum.glb',
        'synthesize pbr normal and roughness maps for 3d tiles model'
      ];

      for (const prompt of prompts) {
        const capability = TaskCapabilityResolver.resolveTaskCapability(prompt);
        expect(capability.canSolveNatively).toBe(true);
        expect(capability.tier1Assessment.canSolveNatively).toBe(true);
        expect(capability.tier1Assessment.primaryNativeEngine).toBe('cpp-3d-engine');
        expect(capability.tier1Assessment.suggestedNativeAction?.serviceOrTool).toMatch(/recolor3DTilesGlb|google_3d_tiles_recolor_glb/);
      }
    });
  });

});
