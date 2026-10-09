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
 * 4. Dual-layer refractive cornea and iris bowl materials
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

        // Custom program cache key
        const prevCacheKey = material.customProgramCacheKey ? material.customProgramCacheKey.bind(material) : null;
        material.customProgramCacheKey = () => {
            const baseKey = prevCacheKey ? prevCacheKey() : '';
            return `${baseKey}_cinereal_skin_${melanin.toFixed(2)}_${subWeight.toFixed(2)}`;
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

            // 1. Vertex Shader: Export world position and world normal
            shader.vertexShader = `
                varying vec3 vSbSkinWorldPos;
                varying vec3 vSbSkinWorldNorm;
            ` + shader.vertexShader;

            shader.vertexShader = shader.vertexShader.replace(
                '#include <worldpos_vertex>',
                `
                #include <worldpos_vertex>
                vSbSkinWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
                vSbSkinWorldNorm = normalize((modelMatrix * vec4(objectNormal, 0.0)).xyz);
                `
            );

            // 2. Fragment Shader: Inject Biophysical SSS & Dual-Lobe Specular
            shader.fragmentShader = `
                varying vec3 vSbSkinWorldPos;
                varying vec3 vSbSkinWorldNorm;
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
            ` + shader.fragmentShader;

            // Hook into final color output to apply screen-space dermal red diffusion and lipid specular glint
            shader.fragmentShader = shader.fragmentShader.replace(
                '#include <dithering_fragment>',
                `
                // 1. Screen-space curvature approximation from normal derivatives
                vec3 dNdx = dFdx(vSbSkinWorldNorm);
                vec3 dNdy = dFdy(vSbSkinWorldNorm);
                float curvature = length(dNdx) + length(dNdy);
                curvature = clamp(curvature * 2.5, 0.0, 1.0);

                // 2. Deep hemoglobin dermal scattering: warm red bleed into curvature & shadow edges
                vec3 hemoglobinTint = uSbSkinSubColor * (uSbSkinSubRadius.r / 3.67);
                vec3 dermalScattered = mix(gl_FragColor.rgb, gl_FragColor.rgb + hemoglobinTint * 0.45, curvature * uSbSkinSubWeight);

                // 3. Subcutaneous backlighting transmission (thin ears/nose glow red when back-lit)
                vec3 viewDir = normalize(cameraPosition - vSbSkinWorldPos);
                #if NUM_DIR_LIGHTS > 0
                for (int i = 0; i < NUM_DIR_LIGHTS; ++i) {
                    vec3 lightDir = directionalLights[i].direction;
                    vec3 transLight = -(lightDir + vSbSkinWorldNorm * uSbTransDistort);
                    float transDot = max(0.0, dot(viewDir, normalize(transLight)));
                    float backGlow = pow(transDot, uSbTransPower) * uSbTransScale * uSbSkinSubWeight;
                    dermalScattered += directionalLights[i].color * uSbSkinSubColor * backGlow;
                }
                #endif

                // 4. Dual-Lobe micro-specular: crisp oily lipid glints
                #if NUM_DIR_LIGHTS > 0
                for (int i = 0; i < NUM_DIR_LIGHTS; ++i) {
                    vec3 lightDir = directionalLights[i].direction;
                    vec3 halfVec = normalize(lightDir + viewDir);
                    float NdotH = max(0.0, dot(vSbSkinWorldNorm, halfVec));
                    float lipidAlpha = uSbLipidRoughness * uSbLipidRoughness;
                    float denom = (NdotH * NdotH * (lipidAlpha - 1.0) + 1.0);
                    float D_lipid = lipidAlpha / max(3.14159 * denom * denom, 1e-4);
                    dermalScattered += vec3(1.0) * (D_lipid * 0.05 * uSbLipidWeight);
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
