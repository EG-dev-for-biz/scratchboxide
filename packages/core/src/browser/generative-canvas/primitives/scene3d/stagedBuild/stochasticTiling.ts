/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The viewport's renderer for the hex-tiling flag a library material carries (glTF material extras
 * `sbStochasticTiling`, written by staged-location/surface-materials.ts): a tiling map is sampled three times per texel,
 * once in each of the three hexagonal cells around it, each cell with its own random offset and rotation, and the three
 * blended with luminance-weighted, sharpened barycentric weights (Mikkelsen 2022, "Practical Real-Time Hex-Tiling",
 * JCGT 11(2); after Heitz and Neyret 2018). The colour, roughness/metalness and normal maps share the cells and weights;
 * the normal of a rotated sample is rotated back. Removes the visible repeat of any tileable map without a macro texture.
 * The data is the flag; this adapter only renders it.
 */

import * as THREE from 'three';

export interface StochasticTilingFlag {
    /** Hex cells per texture tile (larger: smaller cells). */
    cellsPerTile?: number;
    /** Random rotation per cell, radians either way. */
    rotation?: number;
    /** How much the blend favours the brighter sample (0: plain barycentric). */
    luminanceFalloff?: number;
    /** Sharpening exponent of the barycentric weights. */
    weightExponent?: number;
}

const APPLIED = 'sbStochasticTilingApplied';

const DECL = /* glsl */`
uniform float sbHexScale;
uniform float sbHexRot;
uniform float sbHexFall;
uniform float sbHexExp;
vec2 sbHexSt1, sbHexSt2, sbHexSt3;
mat2 sbHexQ1, sbHexQ2, sbHexQ3;
vec3 sbHexW;
vec2 sbHexDx, sbHexDy;
vec2 sbHexHash(vec2 p) { vec2 r = mat2(127.1, 311.7, 269.5, 183.3) * p; return fract(sin(r) * 43758.5453); }
mat2 sbHexRotation(ivec2 v) {
    float a = abs(float(v.x * v.y)) + abs(float(v.x + v.y)) + PI;
    a = mod(a, 2.0 * PI);
    if (a > PI) a -= 2.0 * PI;
    a *= sbHexRot;
    float c = cos(a), s = sin(a);
    return mat2(c, s, -s, c);
}
vec2 sbHexCentre(ivec2 v) { return mat2(1.0, 0.5, 0.0, 0.8660254) * vec2(v) / 3.4641016; }
void sbHexSetup(vec2 st) {
    sbHexDx = dFdx(st); sbHexDy = dFdy(st);
    vec2 g = st * sbHexScale;
    vec2 sk = mat2(1.0, -0.57735027, 0.0, 1.15470054) * (g * 3.4641016);
    ivec2 base = ivec2(floor(sk));
    vec3 t = vec3(fract(sk), 0.0);
    t.z = 1.0 - t.x - t.y;
    float s = step(0.0, -t.z), s2 = 2.0 * s - 1.0;
    vec3 w = vec3(-t.z * s2, s - t.y * s2, s - t.x * s2);
    ivec2 v1 = base + ivec2(int(s), int(s)), v2 = base + ivec2(int(s), int(1.0 - s)), v3 = base + ivec2(int(1.0 - s), int(s));
    sbHexQ1 = sbHexRotation(v1); sbHexQ2 = sbHexRotation(v2); sbHexQ3 = sbHexRotation(v3);
    vec2 c1 = sbHexCentre(v1) / sbHexScale, c2 = sbHexCentre(v2) / sbHexScale, c3 = sbHexCentre(v3) / sbHexScale;
    sbHexSt1 = sbHexQ1 * (st - c1) + c1 + sbHexHash(vec2(v1));
    sbHexSt2 = sbHexQ2 * (st - c2) + c2 + sbHexHash(vec2(v2));
    sbHexSt3 = sbHexQ3 * (st - c3) + c3 + sbHexHash(vec2(v3));
    sbHexW = w;
}
vec4 sbHexSample(sampler2D tex, int k) {
    if (k == 1) return textureGrad(tex, sbHexSt1, sbHexQ1 * sbHexDx, sbHexQ1 * sbHexDy);
    if (k == 2) return textureGrad(tex, sbHexSt2, sbHexQ2 * sbHexDx, sbHexQ2 * sbHexDy);
    return textureGrad(tex, sbHexSt3, sbHexQ3 * sbHexDx, sbHexQ3 * sbHexDy);
}
/** The colour map's three samples set the blend weights every other map reuses. */
vec4 sbHexColour(sampler2D tex) {
    vec4 a = sbHexSample(tex, 1), b = sbHexSample(tex, 2), c = sbHexSample(tex, 3);
    vec3 lw = vec3(0.299, 0.587, 0.114);
    vec3 d = mix(vec3(1.0), vec3(dot(a.rgb, lw), dot(b.rgb, lw), dot(c.rgb, lw)), sbHexFall);
    vec3 W = d * pow(max(sbHexW, vec3(0.0)), vec3(sbHexExp));
    sbHexW = W / max(1e-6, W.x + W.y + W.z);
    return sbHexW.x * a + sbHexW.y * b + sbHexW.z * c;
}
vec4 sbHexBlend(sampler2D tex) { return sbHexW.x * sbHexSample(tex, 1) + sbHexW.y * sbHexSample(tex, 2) + sbHexW.z * sbHexSample(tex, 3); }
`;

const MAP = 'vec4 sampledDiffuseColor = texture2D( map, vMapUv );';
const ROUGH = 'vec4 texelRoughness = texture2D( roughnessMap, vRoughnessMapUv );';
const METAL = 'vec4 texelMetalness = texture2D( metalnessMap, vMetalnessMapUv );';
const NORMAL = 'vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;';
// each rotated sample's normal is turned back by its cell's rotation (in the UV frame, after normalScale, which is where
// the derivative tangent frame's axes are u and v); divided by normalScale again because the chunk multiplies it next
const NORMAL_HEX = /* glsl */`
    vec3 sbN1 = sbHexSample(normalMap, 1).xyz * 2.0 - 1.0; sbN1.xy = transpose(sbHexQ1) * (sbN1.xy * normalScale);
    vec3 sbN2 = sbHexSample(normalMap, 2).xyz * 2.0 - 1.0; sbN2.xy = transpose(sbHexQ2) * (sbN2.xy * normalScale);
    vec3 sbN3 = sbHexSample(normalMap, 3).xyz * 2.0 - 1.0; sbN3.xy = transpose(sbHexQ3) * (sbN3.xy * normalScale);
    vec3 mapN = normalize(sbHexW.x * sbN1 + sbHexW.y * sbN2 + sbHexW.z * sbN3);
    mapN.xy /= normalScale;
`;

/** Patches the fragment shader source (exported for tests). Returns the source unchanged when it has no colour map sample. */
export function hexTilingFragment(src: string): string {
    if (!src.includes(MAP)) return src;
    return src
        .replace('#include <common>', `#include <common>\n${DECL}`)
        .replace(MAP, `sbHexSetup( vMapUv );\n\tvec4 sampledDiffuseColor = sbHexColour( map );`)
        .replace(ROUGH, 'vec4 texelRoughness = sbHexBlend( roughnessMap );')
        .replace(METAL, 'vec4 texelMetalness = sbHexBlend( metalnessMap );')
        .replace(NORMAL, NORMAL_HEX);
}

function flagOf(m: THREE.Material): StochasticTilingFlag | undefined {
    const f = (m.userData as { sbStochasticTiling?: StochasticTilingFlag } | undefined)?.sbStochasticTiling;
    return f && typeof f === 'object' ? f : undefined;
}

/**
 * Applies the flag to every material of `root` that carries it and has a colour map (chained after any shader patch the
 * material already has). Returns how many materials were patched.
 */
export function applyStochasticTiling(root: THREE.Object3D): number {
    let n = 0;
    root.traverse(o => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
            const flag = m ? flagOf(m) : undefined;
            const mat = m as THREE.MeshStandardMaterial;
            if (!flag || !mat.map || mat.userData[APPLIED]) continue;
            const uniforms = {
                sbHexScale: { value: flag.cellsPerTile ?? 1.6 },
                sbHexRot: { value: flag.rotation ?? 0.6 },
                sbHexFall: { value: flag.luminanceFalloff ?? 0.6 },
                sbHexExp: { value: flag.weightExponent ?? 7 }
            };
            const prior = mat.onBeforeCompile;
            const priorKey = mat.customProgramCacheKey?.bind(mat);
            mat.onBeforeCompile = (shader, renderer) => {
                prior?.call(mat, shader, renderer);
                Object.assign(shader.uniforms, uniforms);
                shader.fragmentShader = hexTilingFragment(shader.fragmentShader);
            };
            mat.customProgramCacheKey = () => `${priorKey ? priorKey() : ''}|sb-hex-tiling/1`;
            mat.userData[APPLIED] = true;
            mat.needsUpdate = true;
            n++;
        }
    });
    return n;
}
