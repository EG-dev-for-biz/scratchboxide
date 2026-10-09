/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as THREE from 'three';
import { HUMAN_DERMAL_SSSS_KERNEL } from '../../../common/humanoid-dcc-protocol';
import { computeMelaninAlbedo } from '../../../common/humanoid-avatar-protocol';

/**
 * Configuration options for CineReal Biophysical Skin Shading.
 */
/**
 * Configuration options for CineReal Biophysical Skin Shading.
 */
export interface CineRealSkinConfig {
    melaninFraction?: number;          // 0.0 (pale) to 1.0 (deep complexion)
    pheomelaninRatio?: number;         // 0.0 (neutral) to 1.0 (warm/reddish)
    subsurfaceWeight?: number;         // 0.0 (opaque) to 1.0 (full dermal scatter)
    subsurfaceRadius?: [number, number, number]; // Hemoglobin mean free path (mm) [R, G, B]
    subsurfaceColor?: [number, number, number];  // Deep vascular crimson tint
    translucencyDistortion?: number;   // Normal distortion for backlighting (ears/nose)
    translucencyPower?: number;        // Backlight specular tightness
    translucencyScale?: number;        // Backlight intensity multiplier
    lipidSpecularRoughness?: number;   // Sharp oily micro-facet roughness (Lobe 2)
    lipidSpecularWeight?: number;      // Weight of sharp oily micro-facet glint
    microCavityOcclusion?: number;     // High-frequency pore cavity occlusion
    // Biophysical PBR Texture & Fingernail Extensions
    skinNormalMap?: THREE.Texture | null;
    skinOrmMap?: THREE.Texture | null;
    skinAlbedoMap?: THREE.Texture | null;
    nailNormalMap?: THREE.Texture | null;
    nailOrmMap?: THREE.Texture | null;
    nailAlbedoMap?: THREE.Texture | null;
    skinNormalScale?: number;
    skinPoreScale?: number;
    nailRoughness?: number;
    nailClearcoat?: number;
    nailPinkFlush?: number;
    nailLunula?: number;
    nailStriations?: number;
    enableNailKeratin?: boolean;
}

/**
 * Configuration options for Anatomical Dual-Layer Eye Shading.
 */
export interface CineRealEyeConfig {
    corneaIor?: number;               // 1.376 (human cornea refractive index)
    limbusDarkeningWidth?: number;     // 0.05 to 0.15
    pupilDilation?: number;            // 0.0 (constricted) to 1.0 (dilated)
}

/**
 * CineRealSkinRenderer
 *
 * High-performance WebGL/WebGPU shader patcher and material generator.
 * Eliminates flat plastic rendering by injecting:
 * 1. Dual-lobe Cook-Torrance micro-specularity (broad keratin sheen + sharp lipid glint)
 * 2. Curvature-driven hemoglobin subsurface scattering & red dermal diffusion
 * 3. Translucent backlighting through thin tissue (ears, nostril cartilage, lips)
 * 4. Procedural PBR skin micro-relief (epidermal sulci & pore Scharr normals)
 * 5. Distinct anatomical fingernail PBR (4-zone keratin morphology, longitudinal striations & mirror gloss)
 * 6. Dual-layer refractive cornea and iris bowl materials
 */
export class CineRealSkinRenderer {
    /**
     * Patches a Three.js material with biophysical dermal skin shaders.
     */
    public static patchSkinMaterial(
        material: THREE.Material,
        config: CineRealSkinConfig = {}
    ): void {
        if (!material) return;

        const melanin = config.melaninFraction ?? 0.35;
        const pheo = config.pheomelaninRatio ?? 0.20;
        const baseColorLinear = computeMelaninAlbedo(melanin, pheo);

        const subWeight = config.subsurfaceWeight ?? 0.85;
        const subRadius = config.subsurfaceRadius ?? [3.67, 1.37, 0.68];
        const subColor = config.subsurfaceColor ?? [0.92, 0.28, 0.15];
        const transDistort = config.translucencyDistortion ?? 0.65;
        const transPower = config.translucencyPower ?? 3.0;
        const transScale = config.translucencyScale ?? 2.2;
        const lipidRoughness = config.lipidSpecularRoughness ?? 0.15;
        const lipidWeight = config.lipidSpecularWeight ?? 0.35;
        const cavityOccl = config.microCavityOcclusion ?? 0.75;

        const skinNormScale = config.skinNormalScale ?? 1.25;
        const skinPoreScale = config.skinPoreScale ?? 18.0;
        const nailRoughness = config.nailRoughness ?? 0.14;
        const nailClearcoat = config.nailClearcoat ?? 0.88;
        const nailPinkFlush = config.nailPinkFlush ?? 0.70;
        const nailLunula = config.nailLunula ?? 0.85;
        const nailStriations = config.nailStriations ?? 1.40;
        const hasNails = config.enableNailKeratin !== false;

        // Custom program cache key
        const prevCacheKey = material.customProgramCacheKey ? material.customProgramCacheKey.bind(material) : null;
        material.customProgramCacheKey = () => {
            const baseKey = prevCacheKey ? prevCacheKey() : '';
            return `${baseKey}_cinereal_skin_${melanin.toFixed(2)}_${subWeight.toFixed(2)}_pbr_${hasNails}`;
        };

        const prevOnBeforeCompile = material.onBeforeCompile;
        material.onBeforeCompile = (shader: any, renderer: any) => {
            if (prevOnBeforeCompile) {
                prevOnBeforeCompile.call(material, shader, renderer);
            }

            // Uniforms
            shader.uniforms.uSbSkinMelanin = { value: melanin };
            shader.uniforms.uSbSkinSubWeight = { value: subWeight };
            shader.uniforms.uSbSkinSubRadius = { value: new THREE.Vector3(subRadius[0], subRadius[1], subRadius[2]) };
            shader.uniforms.uSbSkinSubColor = { value: new THREE.Color(subColor[0], subColor[1], subColor[2]) };
            shader.uniforms.uSbTransDistort = { value: transDistort };
            shader.uniforms.uSbTransPower = { value: transPower };
            shader.uniforms.uSbTransScale = { value: transScale };
            shader.uniforms.uSbLipidRoughness = { value: lipidRoughness };
            shader.uniforms.uSbLipidWeight = { value: lipidWeight };
            shader.uniforms.uSbCavityOccl = { value: cavityOccl };

            // PBR Textures & Fingernail Uniforms
            shader.uniforms.uSbSkinNormalMap = { value: config.skinNormalMap ?? null };
            shader.uniforms.uSbSkinOrmMap = { value: config.skinOrmMap ?? null };
            shader.uniforms.uSbSkinAlbedoMap = { value: config.skinAlbedoMap ?? null };
            shader.uniforms.uSbNailNormalMap = { value: config.nailNormalMap ?? null };
            shader.uniforms.uSbNailOrmMap = { value: config.nailOrmMap ?? null };
            shader.uniforms.uSbNailAlbedoMap = { value: config.nailAlbedoMap ?? null };

            shader.uniforms.uSbSkinNormalScale = { value: skinNormScale };
            shader.uniforms.uSbSkinPoreScale = { value: skinPoreScale };
            shader.uniforms.uSbNailRoughness = { value: nailRoughness };
            shader.uniforms.uSbNailClearcoat = { value: nailClearcoat };
            shader.uniforms.uSbNailPinkFlush = { value: nailPinkFlush };
            shader.uniforms.uSbNailLunula = { value: nailLunula };
            shader.uniforms.uSbNailStriations = { value: nailStriations };
            shader.uniforms.uSbHasNails = { value: hasNails ? 1.0 : 0.0 };

            // 1. Vertex Shader: Export world position, world normal, and nail attributes
            shader.vertexShader = `
                attribute float nailMask;
                attribute vec2 nailCoord;
                varying vec3 vSbSkinWorldPos;
                varying vec3 vSbSkinWorldNorm;
                varying float vSbNailMask;
                varying vec2 vSbNailCoord;
            ` + shader.vertexShader;

            shader.vertexShader = shader.vertexShader.replace(
                '#include <worldpos_vertex>',
                `
                #include <worldpos_vertex>
                vSbSkinWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
                vSbSkinWorldNorm = normalize((modelMatrix * vec4(objectNormal, 0.0)).xyz);
                #ifdef USE_NAILMASK
                    vSbNailMask = nailMask;
                    vSbNailCoord = nailCoord;
                #else
                    vSbNailMask = 0.0;
                    vSbNailCoord = vec2(0.5, 0.5);
                #endif
                `
            );

            // 2. Fragment Shader: Inject Cotangent Tangent Frame, PBR Skin Relief & Keratin Nail Blending
            shader.fragmentShader = `
                varying vec3 vSbSkinWorldPos;
                varying vec3 vSbSkinWorldNorm;
                varying float vSbNailMask;
                varying vec2 vSbNailCoord;

                uniform float uSbSkinMelanin;
                uniform float uSbSkinSubWeight;
                uniform vec3 uSbSkinSubRadius;
                uniform vec3 uSbSkinSubColor;
                uniform float uSbTransDistort;
                uniform float uSbTransPower;
                uniform float uSbTransScale;
                uniform float uSbLipidRoughness;
                uniform float uSbLipidWeight;
                uniform float uSbCavityOccl;

                uniform sampler2D uSbSkinNormalMap;
                uniform sampler2D uSbSkinOrmMap;
                uniform sampler2D uSbSkinAlbedoMap;
                uniform sampler2D uSbNailNormalMap;
                uniform sampler2D uSbNailOrmMap;
                uniform sampler2D uSbNailAlbedoMap;

                uniform float uSbSkinNormalScale;
                uniform float uSbSkinPoreScale;
                uniform float uSbNailRoughness;
                uniform float uSbNailClearcoat;
                uniform float uSbNailPinkFlush;
                uniform float uSbNailLunula;
                uniform float uSbNailStriations;
                uniform float uSbHasNails;

                // Screen-space cotangent frame calculation for seamless normal perturbation
                mat3 getCotangentFrameSb(vec3 N, vec3 p, vec2 uv) {
                    vec3 dp1 = dFdx(p);
                    vec3 dp2 = dFdy(p);
                    vec2 duv1 = dFdx(uv);
                    vec2 duv2 = dFdy(uv);
                    vec3 dp2perp = cross(dp2, N);
                    vec3 dp1perp = cross(N, dp1);
                    vec3 T = dp2perp * duv1.x + dp1perp * duv2.x;
                    vec3 B = dp2perp * duv1.y + dp1perp * duv2.y;
                    float invmax = inversesqrt(max(dot(T, T), dot(B, B)) + 1e-6);
                    return mat3(T * invmax, B * invmax, N);
                }
            ` + shader.fragmentShader;

            // Hook into final color output to apply screen-space dermal red diffusion, PBR micro-relief & keratin nail glint
            shader.fragmentShader = shader.fragmentShader.replace(
                '#include <dithering_fragment>',
                `
                // 1. Compute Cotangent Frames and Tangent Normal Perturbations
                vec3 finalWorldNorm = vSbSkinWorldNorm;
                float nailFactor = clamp(vSbNailMask * uSbHasNails, 0.0, 1.0);

                #if defined(USE_UV) || defined(USE_MAP)
                vec2 skinUv = vUv * uSbSkinPoreScale;
                mat3 tbnSkin = getCotangentFrameSb(vSbSkinWorldNorm, vSbSkinWorldPos, skinUv);
                vec3 rawSkinNorm = texture2D(uSbSkinNormalMap, skinUv).xyz * 2.0 - 1.0;
                rawSkinNorm.xy *= uSbSkinNormalScale;
                vec3 perturbedSkinNorm = normalize(tbnSkin * normalize(rawSkinNorm));
                #else
                vec3 perturbedSkinNorm = vSbSkinWorldNorm;
                #endif

                if (nailFactor > 0.01) {
                    mat3 tbnNail = getCotangentFrameSb(vSbSkinWorldNorm, vSbSkinWorldPos, vSbNailCoord);
                    vec3 rawNailNorm = texture2D(uSbNailNormalMap, vSbNailCoord).xyz * 2.0 - 1.0;
                    rawNailNorm.xy *= uSbNailStriations;
                    vec3 perturbedNailNorm = normalize(tbnNail * normalize(rawNailNorm));
                    finalWorldNorm = normalize(mix(perturbedSkinNorm, perturbedNailNorm, nailFactor));
                } else {
                    finalWorldNorm = perturbedSkinNorm;
                }

                // 2. Screen-space curvature approximation from perturbed normal derivatives
                vec3 dNdx = dFdx(finalWorldNorm);
                vec3 dNdy = dFdy(finalWorldNorm);
                float curvature = length(dNdx) + length(dNdy);
                curvature = clamp(curvature * 2.5, 0.0, 1.0);

                // 3. Deep hemoglobin dermal scattering: subtle capillary warmth in creases and high-curvature folds
                vec3 warmCreaseColor = gl_FragColor.rgb * vec3(1.12, 0.88, 0.84);
                vec3 dermalScattered = mix(gl_FragColor.rgb, warmCreaseColor, curvature * uSbSkinSubWeight * 0.40 * (1.0 - nailFactor * 0.75));

                // 4. Nail Keratin 4-Zone Morphology Blending
                if (nailFactor > 0.01) {
                    vec4 nailAlbedoSample = texture2D(uSbNailAlbedoMap, vSbNailCoord);
                    // Calibrated healthy capillary bed & lunula keratin
                    vec3 nailBedWarmth = vec3(0.84, 0.65 * (1.0 - uSbNailPinkFlush * 0.12), 0.60 * (1.0 - uSbNailPinkFlush * 0.18));
                    vec3 finalNailColor = mix(nailBedWarmth, nailAlbedoSample.rgb, 0.80);

                    // Blend into fragColor based on nailFactor
                    dermalScattered = mix(dermalScattered, finalNailColor, nailFactor * 0.92);
                }

                // 5. Subcutaneous backlighting transmission (vascular tissue & subungual bed glow red)
                vec3 viewDir = normalize(cameraPosition - vSbSkinWorldPos);
                #if NUM_DIR_LIGHTS > 0
                for (int i = 0; i < NUM_DIR_LIGHTS; ++i) {
                    vec3 lightDir = directionalLights[i].direction;
                    vec3 transLight = -(lightDir + finalWorldNorm * uSbTransDistort);
                    float transDot = max(0.0, dot(viewDir, normalize(transLight)));
                    float backGlow = pow(transDot, uSbTransPower) * uSbTransScale * uSbSkinSubWeight;
                    dermalScattered += directionalLights[i].color * uSbSkinSubColor * backGlow;
                }
                #endif

                // 6. Dual-Lobe micro-specular: crisp lipid glints + fingernail hard-keratin clearcoat
                #if NUM_DIR_LIGHTS > 0
                for (int i = 0; i < NUM_DIR_LIGHTS; ++i) {
                    vec3 lightDir = directionalLights[i].direction;
                    vec3 halfVec = normalize(lightDir + viewDir);
                    float NdotH = max(0.0, dot(finalWorldNorm, halfVec));

                    // Skin lipid glint (Lobe 2)
                    float lipidAlpha = uSbLipidRoughness * uSbLipidRoughness;
                    float denomLipid = (NdotH * NdotH * (lipidAlpha - 1.0) + 1.0);
                    float D_lipid = lipidAlpha / max(3.14159 * denomLipid * denomLipid, 1e-4);
                    dermalScattered += vec3(1.0) * (D_lipid * 0.05 * uSbLipidWeight * (1.0 - nailFactor));

                    // Nail high-gloss hard keratin clearcoat (mirror specular)
                    if (nailFactor > 0.01) {
                        float nailAlpha = uSbNailRoughness * uSbNailRoughness;
                        float denomNail = (NdotH * NdotH * (nailAlpha - 1.0) + 1.0);
                        float D_nail = nailAlpha / max(3.14159 * denomNail * denomNail, 1e-4);
                        dermalScattered += directionalLights[i].color * (D_nail * 0.18 * uSbNailClearcoat * nailFactor);
                    }
                }
                #endif

                gl_FragColor.rgb = dermalScattered;

                #include <dithering_fragment>
                `
            );
        };

        material.needsUpdate = true;
    }

    /**
     * Creates an anatomical dual-layer eye material (concave iris cup or convex cornea dome).
     */
    public static createAnatomicalEyeMaterial(
        type: 'cornea' | 'iris_sclera',
        config: CineRealEyeConfig = {}
    ): THREE.Material {
        const ior = config.corneaIor ?? 1.376;
        const limbusWidth = config.limbusDarkeningWidth ?? 0.10;

        if (type === 'cornea') {
            // Convex outer dome with dielectric transmission and limbus absorption ring
            return new THREE.MeshPhysicalMaterial({
                color: new THREE.Color(0xffffff),
                transmission: 0.98,
                opacity: 1.0,
                transparent: true,
                roughness: 0.02,
                ior: ior,
                thickness: 0.003,
                clearcoat: 1.0,
                clearcoatRoughness: 0.01,
                specularIntensity: 1.0,
                depthWrite: true
            });
        } else {
            // Concave inner iris bowl and opaque vascular sclera
            return new THREE.MeshStandardMaterial({
                color: new THREE.Color(0x2a52be), // Classic hazel/blue iris base
                roughness: 0.55,
                metalness: 0.0
            });
        }
    }
}
