/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The viewer side of the staged builds' material extras (extras.sbMaterial): a textured twin whose material carries them
 * is drawn with the scene's own reflection probe: a cube render of the scene from the layer's centre with the layer's own
 * extent clipped away by the near plane (so the probe sees the street, the neighbours and the sky, not the building's
 * inside), prefiltered (PMREM) and set as the material's environment. It moves with the camera like a reflection, never
 * painted on. Where a reflection points below the horizon it sees ground of GROUND_ALBEDO under the scene's sky and sun,
 * never brighter (whatever the probe drew there); the probe's diffuse light is left out (the scene's sky fill already lights
 * the photos), and the roughness rises where the normal varies within a pixel (specular anti-aliasing), so a distant
 * facade does not shimmer.
 *
 *  - Without a parameters texture (pipeline K's material regions, one material path for every surface; user decision,
 *    2026-11-05): every texel reflects the probe by its own roughness and metalness (the twin's metallic-roughness
 *    texture, from the library set of its detected material), nothing gated on a kind of surface.
 *  - With a parameters texture (the facade material reading of the texture pass, facade-materials.ts, and pipeline E's
 *    openings): texels read as glass reflect it scaled by their weight (parameters R / 255, the reading's confidence), with a
 *    roughness floor (GLASS_MIN_ROUGHNESS); metal texels (B > 0) whole; every other texel the scene's direct light only.
 *    Measured coursing: the kernel's course profile (a tangent-space normal over one pitch) is applied by world height at
 *    each reading's pitch and phase, where the parameters texture (G = reading + 1) says so; the relief fades out where a
 *    course is smaller than a pixel. Albedo is untouched.
 *
 * Textures are read raw (no colour conversion); the parameters with nearest sampling so an index is never blended.
 */

import * as THREE from 'three';
import { ReflectionProbeRenderer } from '../reflectionProbe';

interface SbMaterialExtras {
    paramsTexture?: number;
    courseTexture?: number;
    courses?: Array<{ pitchM: number; phaseM: number; jointWidthM: number }>;
    provenanceIndices?: number[];
}

interface GltfLike {
    scene: THREE.Object3D;
    parser?: { getDependency: (type: string, index: number) => Promise<unknown> };
}

/** Provenance source of the texture pass's reading texels (facade-materials.ts FACADE_MATERIAL_SOURCE). */
export const FACADE_MATERIAL_SOURCE = 'facade-material-reading';

/** The most coursing readings one material carries (the uniform array's size). */
export const MAX_COURSES = 8;
export const FACADE_MATERIAL_KEY = 'sbFacadeMaterial';

export function sbMaterialOf(m: THREE.Material | undefined): SbMaterialExtras | undefined {
    const e = (m?.userData as { sbMaterial?: SbMaterialExtras } | undefined)?.sbMaterial;
    return e && typeof e === 'object' ? e : undefined;
}

/** Whether a material carries the extras (and so takes the probe). */
export function hasFacadeMaterial(m: THREE.Material | undefined): boolean {
    return !!(m && (m.userData as Record<string, unknown>)[FACADE_MATERIAL_KEY]);
}

const VERTEX_DECL = 'varying vec3 vSbWPos;';
const VERTEX_BODY = 'vSbWPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;';
const FRAGMENT_DECL = `
varying vec3 vSbWPos;
uniform sampler2D uSbMatParams;
uniform sampler2D uSbCourses;
uniform vec4 uSbCourse[ ${MAX_COURSES} ];
uniform float uSbCourseWidth;
uniform float uSbGroundAlbedo;
`;
/**
 * The least roughness glass is drawn with (generated): window glass in place carries dust, film and the slight waviness
 * of float glass, so its reflection is always a touch diffused, never the measured 0.05 of clean float glass alone. 0.12
 * spread the sun's image over a dozen bays as one soft ball (Empire State Building, 2026-10-28: glint pixels 1,117 at
 * 0.12, 575 at 0.08, the largest piece 33% of them, 27% at 0.08).
 */
export const GLASS_MIN_ROUGHNESS = 0.08;

/** The ground's albedo a surface reflects below the horizon (generated: asphalt and stone, 0.1-0.2; gaffer skill, section 1). */
export const GROUND_ALBEDO = 0.15;

/**
 * Before the lights: with a parameters texture the glass roughness floor (GLASS_MIN_ROUGHNESS), then specular anti-aliasing: where the shading
 * normal changes faster than a pixel can show (pane edges, relief, distant facades), the roughness rises by the normal's
 * spread over the pixel (Kaplanyan-Tokuyoshi), so a smooth surface the pixel cannot resolve settles into an even sheen
 * instead of shimmering as the view moves.
 */
const FRAGMENT_SPECULAR_AA = `
    {
        // glass in place is never a perfect mirror (dust, film, the waviness of float glass): a floor on its roughness
        #if defined( USE_MAP ) && defined( SB_PARAMS )
        if ( texture2D( uSbMatParams, vMapUv ).r > 0.0 ) roughnessFactor = max( roughnessFactor, ${GLASS_MIN_ROUGHNESS.toFixed(3)} );
        #endif
        vec3 sbDn = fwidth( normal );
        float sbVar = clamp( 0.5 * dot( sbDn, sbDn ), 0.0, 0.18 );
        roughnessFactor = min( 1.0, sqrt( roughnessFactor * roughnessFactor + sbVar ) );
    }
#include <lights_physical_fragment>
`;

/** After the normal maps: the measured courses' relief, by world height. */
const FRAGMENT_COURSES = `
#include <normal_fragment_maps>
#if defined( USE_MAP ) && defined( SB_COURSES )
    {
        vec4 sbParams = texture2D( uSbMatParams, vMapUv );
        int sbCi = int( floor( sbParams.g * 255.0 + 0.5 ) ) - 1;
        if ( sbCi >= 0 && sbCi < ${MAX_COURSES} ) {
            vec4 sbC = uSbCourse[ sbCi ];
            float sbV = ( vSbWPos.y - sbC.y ) / max( 1e-4, sbC.x );
            float sbFade = 1.0 - smoothstep( 0.2, 0.45, fwidth( sbV ) );
            if ( sbFade > 0.0 ) {
                vec3 sbTn = texture2D( uSbCourses, vec2( ( float( sbCi ) * 4.0 + 2.0 ) / uSbCourseWidth, fract( sbV ) ) ).xyz * 2.0 - 1.0;
                vec3 sbUp = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
                vec3 sbB = sbUp - normal * dot( sbUp, normal );
                float sbBl = length( sbB );
                if ( sbBl > 0.3 ) {
                    sbB /= sbBl;
                    vec3 sbT = cross( sbB, normal );
                    vec3 sbN = normalize( sbTn.z * normal + sbTn.y * sbB + sbTn.x * sbT );
                    normal = normalize( mix( normal, sbN, sbFade ) );
                }
            }
        }
    }
#endif
`;
/**
 * The probe's reflection: without parameters every texel by its own roughness and metalness; with them only the texels read
 * as glass (params R > 0, scaled by that weight) or metal (B > 0), the walls keeping exactly the lighting they had.
 */
const FRAGMENT_ENV_GATE = `
#include <lights_fragment_maps>
#if defined( USE_ENVMAP )
    {
        #if defined( USE_MAP ) && defined( SB_PARAMS )
        vec4 sbP = texture2D( uSbMatParams, vMapUv );
        float sbEnv = sbP.b > 0.0 ? 1.0 : sbP.r;
        #else
        float sbEnv = 1.0;
        #endif
        // below the horizon a reflection sees the ground (gaffer skill, section 2): no brighter than ground of albedo
        // uSbGroundAlbedo under the scene's sky and sun would send back, whatever the probe drew there
        if ( uSbGroundAlbedo > 0.0 ) {
            vec3 sbRwG = inverseTransformDirection( reflect( - geometryViewDir, normal ), viewMatrix );
            vec3 sbUpV = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
            vec3 sbEg = getIBLIrradiance( sbUpV );
            #if NUM_DIR_LIGHTS > 0
            for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) sbEg += directionalLights[ i ].color * max( 0.0, dot( directionalLights[ i ].direction, sbUpV ) );
            #endif
            // the sky's sun is drawn as a SunLight (cascaded shadows, sunShadowCascades.ts)
            #if NUM_SUN_LIGHTS > 0
            for ( int i = 0; i < NUM_SUN_LIGHTS; i ++ ) sbEg += sunLights[ i ].color * max( 0.0, dot( sunLights[ i ].direction, sbUpV ) );
            #endif
            vec3 sbGround = uSbGroundAlbedo * RECIPROCAL_PI * sbEg;
            float sbAbove = smoothstep( -0.03, 0.03, sbRwG.y );
            radiance = mix( min( radiance, sbGround ), radiance, sbAbove );
        }
        // the probe's diffuse light only on metal read by the parameters: every photo is already lit by the scene's sky
        // fill (the hemisphere light), so adding the probe's irradiance lit its colour twice (a metal's diffuse is ~0 anyway)
        #if defined( USE_MAP ) && defined( SB_PARAMS )
        iblIrradiance *= sbP.b > 0.0 ? 1.0 : 0.0;
        #else
        iblIrradiance *= 0.0;
        #endif
        radiance *= sbEnv;
    }
#endif
`;

function rawTexture(tex: THREE.Texture, nearest: boolean, repeatT: boolean): THREE.Texture {
    tex.colorSpace = THREE.NoColorSpace;
    tex.magFilter = nearest ? THREE.NearestFilter : THREE.LinearFilter;
    tex.minFilter = nearest ? THREE.NearestFilter : THREE.LinearFilter;
    tex.generateMipmaps = false;
    if (repeatT) tex.wrapT = THREE.RepeatWrapping;
    tex.needsUpdate = true;
    return tex;
}

/**
 * Loads the reading's textures of a just-loaded twin and patches its materials (see the file comment). Resolves with the
 * number of materials patched; a texture that fails to load leaves its material as the plain photo and is reported.
 */
export async function prepareFacadeMaterials(gltf: GltfLike): Promise<number> {
    const mats = new Set<THREE.MeshStandardMaterial>();
    gltf.scene.traverse(o => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) if (m && sbMaterialOf(m) && (m as THREE.MeshStandardMaterial).isMeshStandardMaterial) mats.add(m as THREE.MeshStandardMaterial);
    });
    const parser = gltf.parser;
    if (!mats.size || !parser) return 0;
    let patched = 0;
    for (const mat of mats) {
        const ex = sbMaterialOf(mat)!;
        try {
            const params = typeof ex.paramsTexture === 'number' ? rawTexture(await parser.getDependency('texture', ex.paramsTexture) as THREE.Texture, true, false) : undefined;
            const courseTex = typeof ex.courseTexture === 'number' ? rawTexture(await parser.getDependency('texture', ex.courseTexture) as THREE.Texture, false, true) : undefined;
            const courses = (ex.courses ?? []).slice(0, MAX_COURSES);
            mat.userData[FACADE_MATERIAL_KEY] = true;
            const withParams = !!params, withCourses = withParams && !!courseTex && courses.length > 0;
            const uniforms = {
                uSbMatParams: { value: params ?? null },
                uSbCourses: { value: courseTex ?? params ?? null },
                uSbCourse: { value: Array.from({ length: MAX_COURSES }, (_, i) => new THREE.Vector4(courses[i]?.pitchM ?? 1, courses[i]?.phaseM ?? 0, 0, 0)) },
                uSbCourseWidth: { value: (courseTex?.image as { width?: number } | undefined)?.width ?? Math.max(4, courses.length * 4) },
                // the ground a surface reflects below the horizon: street and stone (generated: a typical albedo)
                uSbGroundAlbedo: { value: GROUND_ALBEDO }
            };
            mat.userData.sbGroundAlbedo = uniforms.uSbGroundAlbedo;
            mat.defines = { ...(mat.defines ?? {}), ...(withParams ? { SB_PARAMS: '' } : {}), ...(withCourses ? { SB_COURSES: '' } : {}) };
            const prior = mat.onBeforeCompile;
            mat.onBeforeCompile = (shader, renderer) => {
                prior?.call(mat, shader, renderer);
                Object.assign(shader.uniforms, uniforms);
                shader.vertexShader = shader.vertexShader
                    .replace('#include <common>', `#include <common>\n${VERTEX_DECL}`)
                    .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERTEX_BODY}`);
                shader.fragmentShader = shader.fragmentShader
                    .replace('#include <common>', `#include <common>\n${FRAGMENT_DECL}`)
                    .replace('#include <normal_fragment_maps>', FRAGMENT_COURSES)
                    .replace('#include <lights_physical_fragment>', FRAGMENT_SPECULAR_AA)
                    .replace('#include <lights_fragment_maps>', FRAGMENT_ENV_GATE);
            };
            mat.customProgramCacheKey = () => `sb-facade-v9:${withParams ? 'p' : 'n'}:${withCourses ? courses.length : 0}`;
            mat.needsUpdate = true;
            patched++;
        } catch (err) {
            console.warn('[staged textures] the facade material textures did not load; the surface keeps the plain photo:', err);
        }
    }
    return patched;
}

/**
 * The scene's environment as the twin's reflection (see the file comment): one cube render from the model's centre, the
 * model's own extent clipped by the near plane, prefiltered and set on every material of the model that carries the
 * reading. Returns the environment texture (the caller disposes it with the model), or undefined when there is nothing
 * to reflect into.
 */
export function updateFacadeReflections(renderer: THREE.WebGLRenderer, scene: THREE.Scene, model: THREE.Object3D, previous?: THREE.Texture, size = 256): THREE.Texture | undefined {
    const mats: THREE.MeshStandardMaterial[] = [];
    model.traverse(o => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) if (hasFacadeMaterial(m) && (m as THREE.MeshStandardMaterial).isMeshStandardMaterial) mats.push(m as THREE.MeshStandardMaterial);
    });
    if (!mats.length) return undefined;
    const box = new THREE.Box3().setFromObject(model);
    if (box.isEmpty()) return undefined;
    const centre = box.getCenter(new THREE.Vector3()), half = box.getSize(new THREE.Vector3()).multiplyScalar(0.5);
    const near = Math.max(half.x, half.y, half.z) + 0.5;
    // the shared probe capture (reflectionProbe.ts): directions where nothing was drawn see its labelled fallback sky
    const probe = new ReflectionProbeRenderer(renderer, size);
    try {
        const target = probe.capture(scene, { position: centre, near, far: Math.max(near * 50, 5000) });
        const env = target.texture;
        env.userData.sbProbeTarget = target;
        for (const m of mats) { m.envMap = env; m.envMapIntensity = 1; m.needsUpdate = true; }
        // the viewport swaps a mesh's material for its reveal and render-mode looks (clones made before this probe existed)
        // and restores it after: whichever material carrying the reading is drawn gets the probe
        model.traverse(o => {
            const mesh = o as THREE.Mesh;
            if (!mesh.isMesh || mesh.userData.sbFacadeEnvHook) return;
            mesh.userData.sbFacadeEnvHook = true;
            const prior = mesh.onBeforeRender;
            mesh.onBeforeRender = function (...args) {
                const probeEnv = model.userData[ENV_KEY] as THREE.Texture | undefined;
                for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
                    if (probeEnv && hasFacadeMaterial(m) && (m as THREE.MeshStandardMaterial).envMap !== probeEnv) { (m as THREE.MeshStandardMaterial).envMap = probeEnv; m.needsUpdate = true; }
                }
                return prior.apply(this, args);
            };
        });
        disposeFacadeEnv(previous);
        return env;
    } finally {
        probe.dispose();
    }
}

/** Frees a facade probe environment (its render target, when it has one). */
export function disposeFacadeEnv(env: THREE.Texture | undefined): void {
    if (!env) return;
    const target = env.userData?.sbProbeTarget as THREE.WebGLRenderTarget | undefined;
    if (target) target.dispose(); else env.dispose();
}

const ENV_KEY = 'sbFacadeEnv';

/**
 * Re-renders the reflection of every model in the scene that carries the reading (after a layer loads, the neighbours and
 * the other layers are what the probe sees). The previous environment of each is disposed.
 */
export function refreshFacadeReflections(renderer: THREE.WebGLRenderer, scene: THREE.Scene, roots: Iterable<THREE.Object3D>): number {
    let n = 0;
    for (const root of roots) {
        if (!root.parent) continue;
        let has = false;
        root.traverse(o => { const m = (o as THREE.Mesh).material; if (!has && (o as THREE.Mesh).isMesh) for (const x of Array.isArray(m) ? m : [m]) if (hasFacadeMaterial(x)) has = true; });
        if (!has) continue;
        const env = updateFacadeReflections(renderer, scene, root, root.userData[ENV_KEY] as THREE.Texture | undefined);
        if (env) { root.userData[ENV_KEY] = env; n++; }
    }
    return n;
}
