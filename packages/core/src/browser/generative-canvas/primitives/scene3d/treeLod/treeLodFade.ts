/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/


import * as THREE from 'three';
import { markDissolveVariant } from '../stagedBuild/revealMaterial';
import { FADE_STEPS } from './treeLodMath';

/**
 * The dissolve between two levels of one tree. A level that shares the hash interval with its neighbour wears a
 * variant of the tree's one material: a clone with the same colour that only drops what is outside [lo, hi) of the
 * hash. Wood (plain meshes) drops fragments by a screen-space interleaved-gradient noise, the same noise for both
 * levels, so the two complement exactly. Leaf clusters (instanced meshes) drop whole instances by a hash of the
 * instance's position in the tree, so a cluster that is the same place at level 0 and level 1 gets the same hash and
 * is drawn by exactly one of them. A tree outside any crossfade wears the plain material, with no discard at all.
 */

const VARIANT = 'sbLodVariant';

export const isFadeVariant = (m: THREE.Material | THREE.Material[] | null | undefined): boolean =>
    !!m && !Array.isArray(m) && m.userData?.[VARIANT] === true;

export function makeFadeVariant(base: THREE.Material, loStep: number, hiStep: number, instanced: boolean): THREE.Material {
    const mat = base.clone();
    mat.userData = { ...base.userData, [VARIANT]: true };
    const range = { value: new THREE.Vector2(loStep / FADE_STEPS, hiStep / FADE_STEPS) };
    const baseKey = base.customProgramCacheKey?.call(base) ?? '';
    mat.customProgramCacheKey = () => `${baseKey}|sbfade${instanced ? 'I' : 'P'}`;
    mat.onBeforeCompile = (shader, renderer) => {
        base.onBeforeCompile?.call(base, shader, renderer);
        shader.uniforms.uSbRange = range;
        const decl = 'uniform vec2 uSbRange;\n';
        if (instanced) {
            shader.vertexShader = shader.vertexShader
                .replace('#include <common>', `#include <common>\n${decl}`)
                .replace('#include <project_vertex>', `#include <project_vertex>
#ifdef USE_INSTANCING
{
    vec3 sbp = floor(instanceMatrix[3].xyz * 64.0);
    float sbh = fract(sin(dot(sbp, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
    if (sbh < uSbRange.x || sbh >= uSbRange.y) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
#endif`);
        } else {
            shader.fragmentShader = shader.fragmentShader
                .replace('#include <common>', `#include <common>\n${decl}`)
                .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
{
    float sbn = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    if (sbn < uSbRange.x || sbn >= uSbRange.y) discard;
}`);
        }
    };
    mat.needsUpdate = true;
    // a staged build's reveal of this level draws the base, whole (the range moves on, a held staged material would not)
    markDissolveVariant(mat, base);
    return mat;
}
