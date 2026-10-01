/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as THREE from 'three';
import {
  AdaptiveWorldStyleContract,
  DEFAULT_ADAPTIVE_STYLE_CONTRACT
} from '../../../../common/spatial/adaptive-style-contract';
import { AdaptiveTileShaderPatcher } from './AdaptiveTileShaderPatcher';
import { AdaptiveStyleComposer } from './AdaptiveStyleComposer';

export interface StyleApplyHandle {
  setWeight(weight: number): void;
  updateContract(contract: AdaptiveWorldStyleContract): void;
  dispose(): void;
}

export class AdaptiveDomainStyleService {
  /**
   * Translates the grading wheel values in a contract into a CIELAB palette compatible with
   * GlbTextureRecolorService, ensuring 3D state synchronization between shaders and exported files.
   */
  public static contractToGlbPalette(contract: AdaptiveWorldStyleContract): any {
    const lift = contract.photometric.colorGradingWheel.lift;
    const gamma = contract.photometric.colorGradingWheel.gamma;
    const gain = contract.photometric.colorGradingWheel.gain;

    const rgbToLab = (r: number, g: number, b: number) => {
      let rLin = Math.max(0, Math.min(1, r));
      let gLin = Math.max(0, Math.min(1, g));
      let bLin = Math.max(0, Math.min(1, b));

      rLin = rLin > 0.04045 ? Math.pow((rLin + 0.055) / 1.055, 2.4) : rLin / 12.92;
      gLin = gLin > 0.04045 ? Math.pow((gLin + 0.055) / 1.055, 2.4) : gLin / 12.92;
      bLin = bLin > 0.04045 ? Math.pow((bLin + 0.055) / 1.055, 2.4) : bLin / 12.92;

      const x = rLin * 0.4124564 + gLin * 0.3575761 + bLin * 0.1804375;
      const y = rLin * 0.2126729 + gLin * 0.7151522 + bLin * 0.0721750;
      const z = rLin * 0.0193339 + gLin * 0.1191920 + bLin * 0.9503041;

      const xn = 0.95047; const yn = 1.00000; const zn = 1.08883;
      const xr = x / xn; const yr = y / yn; const zr = z / zn;

      const fx = xr > 0.008856 ? Math.cbrt(xr) : (7.787 * xr) + (16.0 / 116.0);
      const fy = yr > 0.008856 ? Math.cbrt(yr) : (7.787 * yr) + (16.0 / 116.0);
      const fz = zr > 0.008856 ? Math.cbrt(zr) : (7.787 * zr) + (16.0 / 116.0);

      const L = (116.0 * fy) - 16.0;
      const a = 500.0 * (fx - fy);
      const bStar = 200.0 * (fy - fz);

      return { L, a, b: bStar };
    };

    // Scaled to match the dark shadow targets and vibrant highlights of the re-grading engine
    return {
      shadow: rgbToLab(lift.r * 0.15, lift.g * 0.15, lift.b * 0.15),
      midtone: rgbToLab(gamma.r, gamma.g, gamma.b),
      highlight: rgbToLab(gain.r, gain.g, gain.b)
    };
  }

  /**
   * One-Shot Autonomous World Restyling (Node.js/Headless/Script environment only).
   */
  public static async restyleWorld(request: {
    referenceImage: string | Buffer;
    inputGlbPath: string;
    cameraPose?: { position: [number, number, number]; target: [number, number, number]; fov: number };
    outputPath?: string;
    fidelity?: 'fast-analytical' | 'balanced' | 'deep-multimodal';
    promptHint?: string;
    protectFoliage?: boolean;
    protectAsphalt?: boolean;
  }): Promise<any> {
    if (typeof window !== 'undefined') {
      throw new Error('restyleWorld is only supported in Node.js / server runtime.');
    }
    const nodeSpatialPath = '../../../../node/spatial/';
    const { AdaptiveStyleDeconstructionService } = await import(/* @vite-ignore */ `${nodeSpatialPath}AdaptiveStyleDeconstructionService`);
    const { recolor3DTilesGlb } = await import(/* @vite-ignore */ `${nodeSpatialPath}GlbTextureRecolorService`);

    const service = new AdaptiveStyleDeconstructionService();
    const contract = await service.deconstructStyle(request.referenceImage, request.cameraPose, {
      fidelity: request.fidelity || 'fast-analytical',
      promptHint: request.promptHint
    });

    const palette = this.contractToGlbPalette(contract);

    const result = await recolor3DTilesGlb({
      inputGlb: request.inputGlbPath,
      outputGlbPath: request.outputPath,
      customPalette: palette,
      segmentation: {
        enableSegmentation: true,
        protectFoliage: request.protectFoliage !== false,
        protectAsphalt: request.protectAsphalt !== false
      },
      pbr: {
        generateNormalMaps: true,
        generateRoughnessMaps: true,
        normalStrength: 2.0
      },
      shadowLift: contract.photometric.shadowLift,
      highlightCompress: contract.photometric.highlightCompress
    });

    return {
      success: result.success,
      contract,
      palette,
      outputGlbPath: result.outputGlbPath,
      textureCount: result.textureCount,
      originalByteLength: result.originalByteLength,
      recoloredByteLength: result.recoloredByteLength
    };
  }

  /**
   * Applies any AdaptiveWorldStyleContract directly to a Three.js Object3D, Mesh, or Scene.

   * Patches materials recursively.
   */
  public static applyToScene(
    sceneOrObject: THREE.Object3D,
    styleContract: AdaptiveWorldStyleContract,
    options: {
      enableProjectiveTexture?: boolean;
      projectiveTexture?: THREE.Texture;
      detailNormalMap?: THREE.Texture;
    } = {}
  ): StyleApplyHandle {
    const patchedMaterials: Set<THREE.Material> = new Set();

    const patch = (obj: THREE.Object3D) => {
      if ((obj as THREE.Mesh).isMesh && (obj as THREE.Mesh).material) {
        const mesh = obj as THREE.Mesh;
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const mat of materials) {
          if (!patchedMaterials.has(mat)) {
            AdaptiveTileShaderPatcher.patchMaterial(mat, styleContract, {
              detailNormalMap: options.detailNormalMap,
              projectiveTexture: options.projectiveTexture
            });
            patchedMaterials.add(mat);
          }
        }
      }
    };

    sceneOrObject.traverse(patch);

    return {
      setWeight(weight: number) {
        // Adjust style uniforms strength
        for (const mat of patchedMaterials) {
          const uniforms = (mat as any).userData?.sbAdaptiveUniforms;
          if (uniforms) {
            if (uniforms.uShadowLift) uniforms.uShadowLift.value = styleContract.photometric.shadowLift * weight;
            if (uniforms.uHighlightCompress) uniforms.uHighlightCompress.value = styleContract.photometric.highlightCompress * weight;
            if (uniforms.uNormalPerturbationScale) uniforms.uNormalPerturbationScale.value = styleContract.microSurface.normalPerturbationScale * weight;
            if (uniforms.uProjEnabled) uniforms.uProjEnabled.value = (styleContract.cameraProjection?.enabled ? 1.0 : 0.0) * weight;
          }
        }
      },
      updateContract(contract: AdaptiveWorldStyleContract) {
        for (const mat of patchedMaterials) {
          AdaptiveTileShaderPatcher.updateMaterialStyle(mat, contract);
        }
      },
      dispose() {
        for (const mat of patchedMaterials) {
          delete (mat as any).userData?.sbAdaptiveStyled;
          delete (mat as any).userData?.sbAdaptiveUniforms;
          mat.needsUpdate = true;
        }
        patchedMaterials.clear();
      }
    };
  }

  /**
   * Instantiates a unified screen-space post-processing style compositor for Kuwahara, outlines, and LUT.
   */
  public static composeStylePostProcess(
    styleContract: AdaptiveWorldStyleContract
  ): AdaptiveStyleComposer {
    return new AdaptiveStyleComposer(styleContract);
  }
}
