/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as THREE from 'three';
import {
  DEFAULT_ADAPTIVE_STYLE_CONTRACT,
  AdaptiveWorldStyleContract,
  AdaptiveTileShaderPatcher,
  AdaptiveStyleComposer,
  AdaptiveDomainStyleService,
  AdaptiveStyleDeconstructionService
} from '../src/node';
import { REPO_ROOT, HOW_TO, requireBinary, withReason } from './helpers/requirements';
import { encodePng } from '../src/node/texture-processing';
import { VisionUnavailableError } from '../src/common/errors/pipeline-errors';

/** A complete contract as a vision model would answer it, with some photometric values overridden. */
function modelContract(photometric: Partial<AdaptiveWorldStyleContract['photometric']>): AdaptiveWorldStyleContract {
  const c = JSON.parse(JSON.stringify(DEFAULT_ADAPTIVE_STYLE_CONTRACT)) as AdaptiveWorldStyleContract;
  delete (c as any).cameraProjection;
  Object.assign(c.photometric, photometric);
  return c;
}

/** A GenAI client whose generateContent answers `text` and records each request. */
function fakeVisionClient(text: string): { client: any; calls: any[] } {
  const calls: any[] = [];
  return { calls, client: { models: { generateContent: async (req: any) => { calls.push(req); return { text }; } } } };
}

// GlbTextureRecolorService decodes and re-encodes every texture by spawning `ffmpeg` from PATH.
const ffmpeg = requireBinary('ffmpeg', HOW_TO.ffmpeg);

describe('Adaptive Domain Architecture: Universal Styling Engine', () => {

  describe('AdaptiveWorldStyleContract & Default Presets', () => {
    it('verifies DEFAULT_ADAPTIVE_STYLE_CONTRACT is fully populated and valid', () => {
      const contract = DEFAULT_ADAPTIVE_STYLE_CONTRACT;
      expect(contract).toBeDefined();
      expect(contract.photometric).toBeDefined();
      expect(contract.photometric.colorTemperatureK).toBe(6500);
      expect(contract.photometric.shadowLift).toBe(0.45);
      expect(contract.microSurface.detailFrequency).toBe(12.0);
      expect(contract.geometricContours.enabled).toBe(false);
      expect(contract.stylizationFilter.quantizationBands).toBe(0);
    });
  });

  describe('AdaptiveStyleDeconstructionService (Image Analysis)', () => {
    let refPng = '';
    beforeAll(() => {
      refPng = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-style-ref-')), 'ref.png');
      fs.writeFileSync(refPng, encodePng(2, 2, Buffer.alloc(16, 200)));
    });

    it('returns the contract the vision model read, and which model read it', async () => {
      const answer = modelContract({ colorTemperatureK: 3150, shadowLift: 0.71 });
      const { client, calls } = fakeVisionClient(JSON.stringify(answer));
      const service = new AdaptiveStyleDeconstructionService({ client });
      const result = await service.deconstructStyle(refPng, { position: [100, 100, 100], target: [0, 0, 0], fov: 45 }, { promptHint: 'golden hour' });

      expect(result.modelUsed).toBe('gemini-2.5-flash');
      expect(result.contract.photometric.colorTemperatureK).toBe(3150);
      expect(result.contract.photometric.shadowLift).toBe(0.71);
      expect(result.contract.cameraProjection?.referenceImageUri).toBe(refPng);
      expect(result.contract.cameraProjection?.fovDeg).toBe(45);
      // The image itself goes to the model, with the response schema.
      expect(calls).toHaveLength(1);
      expect(calls[0].model).toBe('gemini-2.5-flash');
      expect(calls[0].contents[0].inlineData.data).toBe(fs.readFileSync(refPng).toString('base64'));
      expect(calls[0].config.responseSchema).toBeDefined();
    });

    it('deep-multimodal fidelity reads the image with gemini-2.5-pro', async () => {
      const { client, calls } = fakeVisionClient(JSON.stringify(modelContract({})));
      const result = await new AdaptiveStyleDeconstructionService({ client }).deconstructStyle(refPng, undefined, { fidelity: 'deep-multimodal' });
      expect(result.modelUsed).toBe('gemini-2.5-pro');
      expect(calls[0].model).toBe('gemini-2.5-pro');
    });

    it('fails when the vision model cannot be reached; no contract is guessed from the hint words', async () => {
      const client = { models: { generateContent: async () => { throw Object.assign(new Error('Resource exhausted'), { status: 429 }); } } };
      await expect(new AdaptiveStyleDeconstructionService({ client }).deconstructStyle(refPng, undefined, { promptHint: 'comic book sunset' }))
        .rejects.toBeInstanceOf(VisionUnavailableError);
      await expect(new AdaptiveStyleDeconstructionService({ client: {} }).deconstructStyle(refPng))
        .rejects.toThrow(/no Gemini client is configured/);
      expect((AdaptiveStyleDeconstructionService.prototype as any).deconstructHeuristic).toBeUndefined();
      await expect(new AdaptiveStyleDeconstructionService({ client }).deconstructStyle(refPng, undefined, { fidelity: 'fast-analytical' as any }))
        .rejects.toThrow(/fast-analytical/);
    });

    it('refuses an incomplete or non-JSON answer instead of filling in defaults', async () => {
      const partial = modelContract({}) as any;
      delete partial.photometric.colorTemperatureK;
      delete partial.geometricContours.inkColor;
      await expect(new AdaptiveStyleDeconstructionService({ client: fakeVisionClient(JSON.stringify(partial)).client }).deconstructStyle(refPng))
        .rejects.toThrow(/photometric\.colorTemperatureK, geometricContours\.inkColor/);
      await expect(new AdaptiveStyleDeconstructionService({ client: fakeVisionClient('not json').client }).deconstructStyle(refPng))
        .rejects.toThrow(/not JSON/);
    });

    it('the tool summary names the model that read the style', async () => {
      const { spatialHandlers } = await import('../src/node/gemini/tools/spatial-tools');
      const original = AdaptiveStyleDeconstructionService.prototype.deconstructStyle;
      AdaptiveStyleDeconstructionService.prototype.deconstructStyle = async function () {
        return { contract: modelContract({ colorTemperatureK: 5200 }), modelUsed: 'gemini-2.5-flash' };
      };
      try {
        const res = await spatialHandlers.adaptive_world_style_deconstruct({ referenceImagePath: refPng }, { workspaceRoot: os.tmpdir() } as any);
        expect(res.summaryResult).toContain('gemini-2.5-flash read the style');
        expect(res.summaryResult).toContain('5200 K');
        expect((res.resultPayload as any).modelUsed).toBe('gemini-2.5-flash');
      } finally {
        AdaptiveStyleDeconstructionService.prototype.deconstructStyle = original;
      }
    });
  });

  describe('AdaptiveTileShaderPatcher (onBeforeCompile Material Injector)', () => {
    it('patches THREE.Material and registers sbAdaptiveUniforms', () => {
      const material = new THREE.MeshStandardMaterial({ color: 0xffffff });
      expect((material as any).userData?.sbAdaptiveStyled).toBeUndefined();

      AdaptiveTileShaderPatcher.patchMaterial(material, DEFAULT_ADAPTIVE_STYLE_CONTRACT);

      expect((material as any).userData?.sbAdaptiveStyled).toBe(true);
      expect((material as any).userData?.sbAdaptiveUniforms).toBeDefined();
      expect((material as any).userData?.sbAdaptiveUniforms.uColorTemp.value).toBe(6500);
    });

    it('instantly updates uniforms of pre-patched material', () => {
      const material = new THREE.MeshStandardMaterial({ color: 0xffffff });
      AdaptiveTileShaderPatcher.patchMaterial(material, DEFAULT_ADAPTIVE_STYLE_CONTRACT);

      const updatedContract: AdaptiveWorldStyleContract = JSON.parse(JSON.stringify(DEFAULT_ADAPTIVE_STYLE_CONTRACT));
      updatedContract.photometric.colorTemperatureK = 3200;
      updatedContract.photometric.shadowLift = 0.85;

      AdaptiveTileShaderPatcher.updateMaterialStyle(material, updatedContract);
      expect((material as any).userData?.sbAdaptiveUniforms.uColorTemp.value).toBe(3200);
      expect((material as any).userData?.sbAdaptiveUniforms.uShadowLift.value).toBe(0.85);
    });
  });

  describe('AdaptiveStyleComposer (Fullscreen Post-Processing)', () => {
    it('instantiates custom fullscreen shader material with correct uniforms', () => {
      const composer = new AdaptiveStyleComposer(DEFAULT_ADAPTIVE_STYLE_CONTRACT);
      expect(composer).toBeDefined();

      const updatedContract: AdaptiveWorldStyleContract = JSON.parse(JSON.stringify(DEFAULT_ADAPTIVE_STYLE_CONTRACT));
      updatedContract.stylizationFilter.kuwaharaRadius = 4;
      updatedContract.geometricContours.enabled = true;

      composer.updateStyle(updatedContract);
      composer.dispose();
    });
  });

  describe('AdaptiveDomainStyleService & Pro Color Match Interop', () => {
    it('recursive traverses a scene object and patches materials', () => {
      const scene = new THREE.Scene();
      const mesh1 = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
      const mesh2 = new THREE.Mesh(new THREE.SphereGeometry(), new THREE.MeshStandardMaterial());
      scene.add(mesh1);
      scene.add(mesh2);

      const handle = AdaptiveDomainStyleService.applyToScene(scene, DEFAULT_ADAPTIVE_STYLE_CONTRACT);
      expect(handle).toBeDefined();

      expect((mesh1.material as any).userData?.sbAdaptiveStyled).toBe(true);
      expect((mesh2.material as any).userData?.sbAdaptiveStyled).toBe(true);

      handle.setWeight(0.5);
      handle.dispose();

      expect((mesh1.material as any).userData?.sbAdaptiveStyled).toBeUndefined();
    });

    it('converts a style contract into a CIELAB palette compatible with GlbTextureRecolorService', () => {
      const contract = DEFAULT_ADAPTIVE_STYLE_CONTRACT;
      const palette = AdaptiveDomainStyleService.contractToGlbPalette(contract);

      expect(palette).toBeDefined();
      expect(palette.shadow).toBeDefined();
      expect(palette.midtone).toBeDefined();
      expect(palette.highlight).toBeDefined();
      expect(typeof palette.shadow.L).toBe('number');
      expect(typeof palette.midtone.a).toBe('number');
    });

    it.skipIf(!ffmpeg.ok)(withReason('coordinates autonomous one-shot GLB restyling via restyleWorld', ffmpeg), async () => {
      // Textured Colosseum (79 JPEG textures); public/ copies are gitignored, this identical one is tracked (6bb97f1).
      const inputGlbPath = path.join(REPO_ROOT, 'deploy/cloud-run/spatial-separator/assets/colosseum_clay.glb');
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-restyle-world-'));
      try {
        const refPng = path.join(outDir, 'ref.png');
        fs.writeFileSync(refPng, encodePng(2, 2, Buffer.alloc(16, 180)));
        const result = await AdaptiveDomainStyleService.restyleWorld({
          referenceImage: refPng,
          inputGlbPath,
          outputPath: path.join(outDir, 'colosseum_clay_styled_test.glb'),
          promptHint: 'A glowing sunset with deep golden light',
          client: fakeVisionClient(JSON.stringify(modelContract({ colorTemperatureK: 3000, shadowLift: 0.6 }))).client
        });

        expect(result.success).toBe(true);
        expect(result.modelUsed).toBe('gemini-2.5-flash');
        expect(result.contract.photometric.colorTemperatureK).toBe(3000);
        expect(result.palette).toBeDefined();
        expect(result.outputGlbPath).toContain('_styled_test.glb');
      } finally {
        fs.rmSync(outDir, { recursive: true, force: true });
      }
    }, 300_000);
  });
});
