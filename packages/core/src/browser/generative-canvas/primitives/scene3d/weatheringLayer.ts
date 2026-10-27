/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The weathering layer of a built GLB (SB_material_weathering, written by sb.write_textured_building's default
 * weathering mode): a unique RGBA atlas on the surfaces' second UV set, alpha-blended over their own (tiled) base
 * colour. It replaces an overlay shell that doubled the weathered triangles; rendering only, the bake is the engine's.
 * A GLB opened elsewhere ignores the extension and shows the surfaces unweathered. A uv1 outside 0..1 means unweathered.
 */

import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';

const VERTEX_DECL = `
#ifndef USE_UV1
attribute vec2 uv1;
#endif
varying vec2 vSbWeatherUv;
`;
const FRAGMENT_DECL = `
uniform sampler2D sbWeatheringMap;
varying vec2 vSbWeatherUv;
`;
const FRAGMENT_BLEND = `
#include <color_fragment>
if (vSbWeatherUv.x >= 0.0 && vSbWeatherUv.y >= 0.0) {
    vec4 sbW = texture2D(sbWeatheringMap, vSbWeatherUv);
    diffuseColor.rgb = mix(diffuseColor.rgb, sbW.rgb, sbW.a);
}
`;

/** Blends each weathered material's atlas over it; resolves to the number of materials patched. */
export async function applyWeatheringLayer(gltf: GLTF): Promise<number> {
    const wanted = new Map<THREE.Material, number>();
    gltf.scene.traverse(o => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh || !mesh.geometry?.attributes?.uv1) return;
        for (const mat of ([] as THREE.Material[]).concat(mesh.material)) {
            const ext = (mat.userData?.gltfExtensions as Record<string, any> | undefined)?.SB_material_weathering;
            if (typeof ext?.texture?.index === 'number') wanted.set(mat, ext.texture.index);
        }
    });
    let patched = 0;
    for (const [mat, index] of wanted) {
        const tex = (await gltf.parser.getDependency('texture', index)) as THREE.Texture;
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.needsUpdate = true;
        const prior = mat.onBeforeCompile;
        const priorKey = mat.customProgramCacheKey.bind(mat);
        mat.onBeforeCompile = (shader, renderer) => {
            prior.call(mat, shader, renderer);
            shader.uniforms.sbWeatheringMap = { value: tex };
            shader.vertexShader = shader.vertexShader
                .replace('#include <common>', `#include <common>\n${VERTEX_DECL}`)
                .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSbWeatherUv = uv1;');
            shader.fragmentShader = shader.fragmentShader
                .replace('#include <common>', `#include <common>\n${FRAGMENT_DECL}`)
                .replace('#include <color_fragment>', FRAGMENT_BLEND);
        };
        mat.customProgramCacheKey = () => `${priorKey()}|sb-weathering-v1`;
        mat.userData.sbWeatheringMap = tex;
        mat.needsUpdate = true;
        patched++;
    }
    return patched;
}
