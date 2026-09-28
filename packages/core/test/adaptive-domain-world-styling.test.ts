/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  DEFAULT_ADAPTIVE_STYLE_CONTRACT,
  AdaptiveWorldStyleContract,
  AdaptiveTileShaderPatcher,
  AdaptiveStyleComposer,
  AdaptiveDomainStyleService,
  AdaptiveStyleDeconstructionService
} from '../src/node';

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
    it('runs fast offline heuristic deconstruction for Comic preset', () => {
      const service = new AdaptiveStyleDeconstructionService();
      const contract = service.deconstructHeuristic(
        'mock_image.png',
        undefined,
        'Please apply a stylish comic book outline look'
      );

      expect(contract.stylizationFilter.quantizationBands).toBe(4);
      expect(contract.geometricContours.enabled).toBe(true);
      expect(contract.geometricContours.lineWidth).toBe(2.0);
      expect(contract.photometric.shadowLift).toBe(0.6);
    });

    it('runs fast offline heuristic deconstruction for Golden Hour sunset preset', () => {
      const service = new AdaptiveStyleDeconstructionService();
      const contract = service.deconstructHeuristic(
        'mock_image.png',
        undefined,
        'A warm sunset establishing view at twilight'
      );

      expect(contract.photometric.colorTemperatureK).toBe(3200);
      expect(contract.photometric.colorGradingWheel.gain.r).toBeGreaterThan(1.0);
      expect(contract.photometric.colorGradingWheel.lift.b).toBeGreaterThan(0.2);
    });

    it('creates camera projection anchor inside contract when camera pose is provided', () => {
      const service = new AdaptiveStyleDeconstructionService();
      const contract = service.deconstructHeuristic(
        'public/images/ref.png',
        { position: [100, 100, 100], target: [0, 0, 0], fov: 45 },
        'hyperrealistic daylight view'
      );

      expect(contract.cameraProjection).toBeDefined();
      expect(contract.cameraProjection?.enabled).toBe(true);
      expect(contract.cameraProjection?.referenceImageUri).toBe('public/images/ref.png');
      expect(contract.cameraProjection?.fovDeg).toBe(45);
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

    it('coordinates autonomous one-shot GLB restyling via restyleWorld', async () => {
      const result = await AdaptiveDomainStyleService.restyleWorld({
        referenceImage: 'mock_image.png',
        inputGlbPath: 'public/colosseum_clay.glb',
        outputPath: 'public/colosseum_clay_styled_test.glb',
        promptHint: 'A glowing sunset with deep golden light',
        fidelity: 'fast-analytical'
      });

      expect(result.success).toBe(true);
      expect(result.contract).toBeDefined();
      expect(result.palette).toBeDefined();
      expect(result.outputGlbPath).toContain('_styled_test.glb');
    });
  });
});
