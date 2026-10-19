/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/


import * as THREE from 'three';
import type { TreeCrownExtras } from '../../../../../common/spatial/staged-location-contracts';

/**
 * Soft crown ("envelope") normals for the leaves of a tree. The trees GLB carries, per tree, an ellipsoid fitted to its
 * delivered leaves (extras sbTree.crown, written by the native trees writer). The leaves of every level are shaded with
 * a blend of their own normal and the ellipsoid's normal at the vertex (its gradient), tilted a little toward the sky, so
 * a crown reads as one soft volume instead of faceted cards or rocky masses. Wood is never touched.
 *
 * Leaf clusters are instanced and their geometry is shared by every tree, so nothing is baked: each leaf mesh gets a light
 * geometry of its own that shares the cluster's buffers and adds the crown as three instanced attributes with a divisor
 * past the instance count (one value for the whole mesh, i.e. per tree and level), in the mesh's own frame as a quadric:
 * centre c and symmetric matrix S, with gradient S (x - c). The normal matrix then takes the gradient to view space as it
 * does a normal. The level is the centre's w, and picks the blend and the per-leaf noise from shared uniforms, so the
 * factors are adjustable at run time for every tree at once.
 *
 * The leaf material is a variant of the mesh's base (the shared clay, or the loader's material) that only leaf meshes
 * wear; the dither variants of treeLodFade are made from it, so a crossfade keeps the soft shading. A leaf card's own
 * normal is first turned to face the crown normal, and the fragment stage does not flip the normal of a back face, so the
 * underside of a card is not dark.
 */

export interface CrownShadingOptions {
    /** Off: leaves wear the plain base material (for comparison). */
    enabled: boolean;
    /** Share of the crown normal in the leaf normal at level 0 (near), 1 (mid), 2 (far). */
    blend: [number, number, number];
    /** How far the crown normal tilts toward world up (added to the unit normal before renormalising). */
    skyBias: number;
    /** Amplitude of the per-leaf normal noise at each level, so a near crown does not read as a balloon. */
    noise: [number, number, number];
}

export const DEFAULT_CROWN_SHADING: Readonly<CrownShadingOptions> = Object.freeze<CrownShadingOptions>({ enabled: true, blend: [0.7, 0.9, 1.0], skyBias: 0.18, noise: [0.3, 0.12, 0] });

const uniforms = {
    uSbCrownBlend: { value: new THREE.Vector3(...DEFAULT_CROWN_SHADING.blend) },
    uSbCrownNoise: { value: new THREE.Vector3(...DEFAULT_CROWN_SHADING.noise) },
    uSbCrownSky: { value: DEFAULT_CROWN_SHADING.skyBias }
};

/** The uniforms every crown variant shares (one set for all trees). */
export const crownShadingUniforms = (): Readonly<typeof uniforms> => uniforms;

/** Writes the adjustable factors into the shared uniforms (clamped to their meaningful ranges). */
export function setCrownShadingUniforms(o: Pick<CrownShadingOptions, 'blend' | 'skyBias' | 'noise'>): void {
    const c01 = (x: number) => Math.min(1, Math.max(0, Number.isFinite(x) ? x : 0));
    uniforms.uSbCrownBlend.value.set(c01(o.blend[0]), c01(o.blend[1]), c01(o.blend[2]));
    uniforms.uSbCrownNoise.value.set(Math.max(0, o.noise[0] || 0), Math.max(0, o.noise[1] || 0), Math.max(0, o.noise[2] || 0));
    uniforms.uSbCrownSky.value = Math.max(0, Number.isFinite(o.skyBias) ? o.skyBias : 0);
}

/** Options completed from the defaults (a partial override from scene data or a console hook). */
export function resolveCrownShading(o: Partial<CrownShadingOptions> | undefined | null): CrownShadingOptions {
    const d = DEFAULT_CROWN_SHADING;
    const triple = (v: unknown, def: readonly number[]): [number, number, number] =>
        Array.isArray(v) && v.length === 3 && v.every(x => typeof x === 'number' && Number.isFinite(x)) ? [v[0], v[1], v[2]] : [def[0], def[1], def[2]];
    return {
        enabled: o?.enabled ?? d.enabled,
        blend: triple(o?.blend, d.blend),
        skyBias: typeof o?.skyBias === 'number' && Number.isFinite(o.skyBias) ? o.skyBias : d.skyBias,
        noise: triple(o?.noise, d.noise)
    };
}

/** The blend factor and noise amplitude the shader picks for a level, from the shared uniforms (mirrors the GLSL). */
export function crownLevelFactors(level: number): { blend: number; noise: number } {
    const k = level < 0.5 ? 'x' : level < 1.5 ? 'y' : 'z';
    return { blend: uniforms.uSbCrownBlend.value[k], noise: uniforms.uSbCrownNoise.value[k] };
}

/**
 * The crown ellipsoid as a quadric in a mesh's own frame. `meshToTree` maps the mesh's frame (where its instance matrices
 * put the vertices) into the tree node's frame (where the crown is). Returns the centre (xyz, w = level) and the symmetric
 * matrix S as its diagonal (xx, yy, zz) and off-diagonal (xy, xz, yz), scaled so its largest entry is 1 (the gradient's
 * direction is all the shader needs).
 */
export function crownQuadricInMeshFrame(crown: TreeCrownExtras, meshToTree: THREE.Matrix4, level: number): { c: [number, number, number, number]; s0: [number, number, number]; s1: [number, number, number] } {
    const [r0, r1, r2] = crown.radii.map(r => Math.max(1e-3, r));
    const cy = Math.cos(crown.yawRad), sy = Math.sin(crown.yawRad);
    const axes: Array<[THREE.Vector3, number]> = [[new THREE.Vector3(cy, 0, sy), r0], [new THREE.Vector3(0, 1, 0), r1], [new THREE.Vector3(-sy, 0, cy), r2]];
    const q = new THREE.Matrix3().set(0, 0, 0, 0, 0, 0, 0, 0, 0);
    for (const [a, r] of axes) {
        const w = 1 / (r * r);
        const e = q.elements;    // column-major; the matrix is symmetric so the order does not matter
        e[0] += w * a.x * a.x; e[1] += w * a.x * a.y; e[2] += w * a.x * a.z;
        e[3] += w * a.y * a.x; e[4] += w * a.y * a.y; e[5] += w * a.y * a.z;
        e[6] += w * a.z * a.x; e[7] += w * a.z * a.y; e[8] += w * a.z * a.z;
    }
    const t = new THREE.Matrix3().setFromMatrix4(meshToTree);
    // S = T^T Q T
    const s = t.clone().transpose().multiply(q).multiply(t);
    const e = s.elements;
    const sxx = e[0], syy = e[4], szz = e[8], sxy = 0.5 * (e[1] + e[3]), sxz = 0.5 * (e[2] + e[6]), syz = 0.5 * (e[5] + e[7]);
    const scale = Math.max(Math.abs(sxx), Math.abs(syy), Math.abs(szz), Math.abs(sxy), Math.abs(sxz), Math.abs(syz), 1e-30);
    const centre = new THREE.Vector3(...crown.centre).applyMatrix4(meshToTree.clone().invert());
    return { c: [centre.x, centre.y, centre.z, level], s0: [sxx / scale, syy / scale, szz / scale], s1: [sxy / scale, sxz / scale, syz / scale] };
}

/** One value for every instance of a mesh (and for a plain mesh, which draws as instance 0). */
const PER_MESH_DIVISOR = 1 << 30;

/**
 * Gives `mesh` its own geometry that shares every buffer of the current one and adds the crown attributes. The shared
 * attributes stay one GPU buffer each (the renderer keys buffers by attribute). A mesh that already has its own geometry
 * (a second call) has its crown values updated in place.
 */
export function attachCrownAttributes(mesh: THREE.Mesh, quadric: ReturnType<typeof crownQuadricInMeshFrame>): void {
    const g = mesh.geometry as THREE.BufferGeometry;
    const set = (geom: THREE.BufferGeometry, name: string, v: number[]) => {
        const a = geom.getAttribute(name) as THREE.InstancedBufferAttribute | undefined;
        if (a && (a as THREE.InstancedBufferAttribute).isInstancedBufferAttribute) {
            (a.array as Float32Array).set(v);
            a.needsUpdate = true;
            return;
        }
        geom.setAttribute(name, new THREE.InstancedBufferAttribute(new Float32Array(v), v.length, false, PER_MESH_DIVISOR));
    };
    let own = g;
    if (!g.userData?.sbCrownOwn) {
        own = new THREE.BufferGeometry();
        own.name = g.name;
        own.setIndex(g.index);
        for (const [name, attr] of Object.entries(g.attributes)) own.setAttribute(name, attr);
        for (const [name, list] of Object.entries(g.morphAttributes)) (own.morphAttributes as Record<string, Array<THREE.BufferAttribute | THREE.InterleavedBufferAttribute>>)[name] = list;
        own.morphTargetsRelative = g.morphTargetsRelative;
        for (const grp of g.groups) own.addGroup(grp.start, grp.count, grp.materialIndex);
        own.drawRange = { ...g.drawRange };
        if (g.boundingBox) own.boundingBox = g.boundingBox.clone();
        if (g.boundingSphere) own.boundingSphere = g.boundingSphere.clone();
        own.userData = { ...g.userData, sbCrownOwn: true };
        mesh.geometry = own;
    }
    set(own, 'sbCrownC', quadric.c);
    set(own, 'sbCrownS0', quadric.s0);
    set(own, 'sbCrownS1', quadric.s1);
}

const CROWN_VARIANT = 'sbCrownVariant';

export const isCrownVariant = (m: THREE.Material | THREE.Material[] | null | undefined): boolean =>
    !!m && !Array.isArray(m) && m.userData?.[CROWN_VARIANT] === true;

/** Materials that light with a normal (and so have the vNormal varying the crown writes). */
export const supportsCrownShading = (m: THREE.Material): boolean => {
    const x = m as THREE.Material & Record<string, unknown>;
    return !!(x.isMeshStandardMaterial || x.isMeshLambertMaterial || x.isMeshPhongMaterial || x.isMeshToonMaterial);
};

/** Vertex code: after the projection, replaces the leaf's normal varying with the blend toward the crown normal. */
export const CROWN_VERTEX_PARS = `
attribute vec4 sbCrownC;
attribute vec3 sbCrownS0;
attribute vec3 sbCrownS1;
uniform vec3 uSbCrownBlend;
uniform vec3 uSbCrownNoise;
uniform float uSbCrownSky;
`;

export const CROWN_VERTEX_MAIN = `
#ifndef FLAT_SHADED
{
    vec4 sbLocal = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
    sbLocal = instanceMatrix * sbLocal;
#endif
    vec3 sbD = sbLocal.xyz - sbCrownC.xyz;
    vec3 sbG = vec3(
        dot( vec3( sbCrownS0.x, sbCrownS1.x, sbCrownS1.y ), sbD ),
        dot( vec3( sbCrownS1.x, sbCrownS0.y, sbCrownS1.z ), sbD ),
        dot( vec3( sbCrownS1.y, sbCrownS1.z, sbCrownS0.z ), sbD ) );
    vec3 sbUp = normalize( mat3( viewMatrix ) * vec3( 0.0, 1.0, 0.0 ) );
    vec3 sbN = dot( sbG, sbG ) > 1e-20 ? normalize( normalMatrix * sbG ) : sbUp;
    float sbLvl = sbCrownC.w;
    vec3 sbSel = vec3( 1.0 - step( 0.5, sbLvl ), step( 0.5, sbLvl ) * ( 1.0 - step( 1.5, sbLvl ) ), step( 1.5, sbLvl ) );
    float sbW = dot( uSbCrownBlend, sbSel );
    float sbAmp = dot( uSbCrownNoise, sbSel );
    // per-leaf noise: smooth in the leaf's own normal (one leaf, one direction), varied by the cluster's place
#ifdef USE_INSTANCING
    vec3 sbSeed = instanceMatrix[3].xyz;
#else
    vec3 sbSeed = vec3( 0.0 );
#endif
    float sbH = fract( sin( dot( floor( sbSeed * 1024.0 ), vec3( 12.9898, 78.233, 37.719 ) ) ) * 43758.5453 ) * 6.2831853;
    vec3 sbJ = sin( objectNormal * vec3( 7.13, 9.31, 8.77 ) + vec3( sbH, sbH * 1.7, sbH * 2.3 ) );
    sbN = normalize( sbN + uSbCrownSky * sbUp + sbAmp * normalMatrix * sbJ );
    vec3 sbOwn = normalize( vNormal );
    if ( dot( sbOwn, sbN ) < 0.0 ) sbOwn = - sbOwn;
    vNormal = normalize( mix( sbOwn, sbN, sbW ) );
}
#endif
`;

/** normal_fragment_begin without the back-face flip: the crown normal already faces the viewer's side of the crown. */
export const crownNormalFragmentBegin = (): string => {
    const chunk = THREE.ShaderChunk.normal_fragment_begin;
    const out = chunk.replace('float faceDirection = gl_FrontFacing ? 1.0 : - 1.0;', 'float faceDirection = 1.0;');
    if (out === chunk) throw new Error('treeCrownShading: three.js normal_fragment_begin no longer has the faceDirection line this patch replaces');
    return out;
};

/** A variant of `base` that shades with the crown normal. Only leaf meshes that carry the crown attributes wear it. */
export function makeCrownVariant(base: THREE.Material): THREE.Material {
    const mat = base.clone();
    mat.userData = { ...base.userData, [CROWN_VARIANT]: true };
    const baseKey = base.customProgramCacheKey?.call(base) ?? '';
    mat.customProgramCacheKey = () => `${baseKey}|sbcrown`;
    mat.onBeforeCompile = (shader, renderer) => {
        base.onBeforeCompile?.call(base, shader, renderer);
        Object.assign(shader.uniforms, uniforms);
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', `#include <common>\n${CROWN_VERTEX_PARS}`)
            .replace('#include <project_vertex>', `#include <project_vertex>\n${CROWN_VERTEX_MAIN}`);
        shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_begin>', crownNormalFragmentBegin());
    };
    mat.needsUpdate = true;
    return mat;
}
