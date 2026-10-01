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

  describe('recolor3DTilesGlb Programmatic API', () => {
    it('executes in mock mode returning compliant GlbRecolorApiResult', async () => {
      const result = await recolor3DTilesGlb({
        inputGlb: '/fake/path/colosseum.glb',
        palettePreset: 'dusk_twilight',
        mockExecution: true
      });

      expect(result.success).toBe(true);
      expect(result.driftMm).toBe(0.000);
      expect(result.textureCount).toBe(1);
      expect(result.normalMapCount).toBe(1);
      expect(result.roughnessMapCount).toBe(1);
      expect(result.glbBuffer).toBeDefined();
      expect(result.glbBuffer.length).toBeGreaterThan(12);
      expect(result.paletteUsed).toEqual(DEFAULT_NANO_BANANA_GLB_PALETTE);
      expect(result.summary).toContain('3D Tile GLB recolored successfully');
    });

    it('supports custom output file writing in mock mode', async () => {
      const tempOut = path.join(os.tmpdir(), `test_recolor_${Date.now()}.glb`);
      try {
        const result = await recolor3DTilesGlb({
          inputGlb: '/fake/path/colosseum.glb',
          outputGlbPath: tempOut,
          palettePreset: 'golden_hour',
          mockExecution: true
        });

        expect(result.success).toBe(true);
        expect(result.outputGlbPath).toBe(tempOut);
        expect(fs.existsSync(tempOut)).toBe(true);
        expect(result.paletteUsed).toEqual(GLB_RECOLOR_PRESETS.golden_hour);
      } finally {
        if (fs.existsSync(tempOut)) fs.unlinkSync(tempOut);
      }
    });

    it('resolves cyberpunk_neon and monochrome_noir presets', async () => {
      const neonRes = await recolor3DTilesGlb({
        inputGlb: '/fake/model.glb',
        palettePreset: 'cyberpunk_neon',
        mockExecution: true
      });
      expect(neonRes.paletteUsed.midtone.a).toBeGreaterThan(50); // High vibrant magenta a*

      const noirRes = await recolor3DTilesGlb({
        inputGlb: '/fake/model.glb',
        palettePreset: 'monochrome_noir',
        mockExecution: true
      });
      expect(noirRes.paletteUsed.midtone.a).toBeCloseTo(0, 1);
      expect(noirRes.paletteUsed.midtone.b).toBeCloseTo(0, 1);
    });

    it('accepts custom hex color swatches in customPalette', async () => {
      const customRes = await recolor3DTilesGlb({
        inputGlb: '/fake/model.glb',
        customPalette: {
          shadowHex: '#001122',
          midtoneHex: '#DDAA55',
          highlightHex: '#FFFFAA'
        },
        mockExecution: true
      });

      expect(customRes.paletteUsed.shadow.L).toBeGreaterThan(0);
      expect(customRes.paletteUsed.midtone.b).toBeGreaterThan(20);
      expect(customRes.paletteUsed.highlight.L).toBeGreaterThan(85);
    });

    it('exposes static GlbTextureRecolorService.recolor alias', async () => {
      const res = await GlbTextureRecolorService.recolor({
        inputGlb: '/fake/model.glb',
        mockExecution: true
      });
      expect(res.success).toBe(true);
      expect(res.driftMm).toBe(0.000);
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

    it('executes via tool registry dispatch in mock mode', async () => {
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

      expect(result.exec.status).toBe('completed');
      expect(result.resultPayload).toBeDefined();
      const payload = result.resultPayload as any;
      expect(payload.success).toBe(true);
      expect(payload.textureCount).toBe(1);
      expect(payload.driftMm).toBe(0.000);
      expect(payload.normalMapCount).toBe(1);
      expect(payload.roughnessMapCount).toBe(1);
      expect(result.exec.summaryResult).toContain('recolored successfully');
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
        expect(capability.recommendedResolutionRoute).toBe('tier1-native');
        expect(capability.tier1Assessment.canSolveNatively).toBe(true);
        expect(capability.tier1Assessment.primaryNativeEngine).toBe('cpp-3d-engine');
        expect(capability.tier1Assessment.suggestedNativeAction?.serviceOrTool).toMatch(/recolor3DTilesGlb|google_3d_tiles_recolor_glb/);
      }
    });
  });

});
