/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as THREE from 'three';
import type { RendererStack, SliceHandle } from './types';

export interface CustomShaderDefinition {
    vertexShader?: string;
    fragmentShader?: string;
    uniforms?: Record<string, { value: any }>;
    transparent?: boolean;
}

export interface CustomShadersHandle extends SliceHandle {
    materials: THREE.ShaderMaterial[];
}

/**
 * Compiles the schema's custom ShaderMaterials. They are not attached to geometry here (scripts
 * and operators pick them up); the render loop only ticks their `uTime`/`uCameraPosition`.
 */
export function syncCustomShaders(
    stack: RendererStack,
    shaders: Record<string, CustomShaderDefinition> | undefined | null
): CustomShadersHandle {
    const { container, camera } = stack;
    const width = container.clientWidth || 500;
    const height = container.clientHeight || 450;
    const materials: THREE.ShaderMaterial[] = [];

    if (shaders && typeof shaders === 'object') {
        for (const shaderDef of Object.values(shaders)) {
            if (!shaderDef?.vertexShader || !shaderDef.fragmentShader) continue;
            try {
                materials.push(new THREE.ShaderMaterial({
                    vertexShader: shaderDef.vertexShader,
                    fragmentShader: shaderDef.fragmentShader,
                    uniforms: {
                        uTime: { value: 0 },
                        uResolution: { value: new THREE.Vector2(width, height) },
                        uCameraPosition: { value: camera.position },
                        ...(shaderDef.uniforms || {})
                    },
                    transparent: shaderDef.transparent ?? true,
                    depthWrite: false
                }));
            } catch (sErr) {
                console.warn('[3D Custom Shader Compilation Warning]:', sErr);
            }
        }
    }

    return {
        materials,
        dispose: () => {
            for (const mat of materials) mat.dispose();
            materials.length = 0;
        }
    };
}

/** Per-frame uniform update shared by the render loop. */
export function tickCustomShaders(materials: THREE.ShaderMaterial[], time: number, cameraPosition: THREE.Vector3): void {
    for (const cMat of materials) {
        if (cMat.uniforms.uTime) cMat.uniforms.uTime.value = time;
        if (cMat.uniforms.time) cMat.uniforms.time.value = time;
        if (cMat.uniforms.uCameraPosition) cMat.uniforms.uCameraPosition.value.copy(cameraPosition);
    }
}
