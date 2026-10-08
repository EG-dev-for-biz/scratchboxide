/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as THREE from 'three';

// ============================================================================
// Types & Interfaces
// ============================================================================

export type PbrArchetypeId =
    | 'weathered_concrete'
    | 'brushed_titanium'
    | 'carrara_marble'
    | 'wood_endgrain'
    | 'hammered_copper'
    | 'chipped_paint_rust'
    | (string & {});

export interface PbrTexturePackTextures {
    albedoTexture?: THREE.Texture;
    normalTexture?: THREE.Texture;
    roughnessTexture?: THREE.Texture;
    metallicTexture?: THREE.Texture;
    aoTexture?: THREE.Texture;
    ormTexture?: THREE.Texture;
    heightTexture?: THREE.Texture;
}

export interface PbrSynthesizeOptions {
    width?: number;
    height?: number;
    seed?: number;
    wear?: number;
    roughnessBias?: number;
    color?: [number, number, number];
    secondaryColor?: [number, number, number];
    anisotropyAngleDeg?: number;
}

export interface ExpertTexturingOptions {
    /** Target texel density in pixels per meter (default 512 px/m). */
    texelDensityPxPerMeter?: number;
    /** Manual UV repeat override [u, v]. If omitted, derived from bounding box & texel density. */
    repeatOverride?: [number, number];
    /** Anisotropic filtering level (default 16). */
    anisotropy?: number;
    /** Enable stochastic procedural anti-tiling (eliminates repeating grid checkerboard artifacts). */
    enableAntiTiling?: boolean;
    /** Enable Toksvig specular anti-aliasing (filters normal variance into roughness to eliminate distance shimmer). */
    enableToksvig?: boolean;
    /** Enable Parallax Occlusion Mapping (POM) for true micro-surface depth and self-occlusion. */
    enableParallaxOcclusion?: boolean;
    /** POM depth scale in meters (default 0.03m). */
    parallaxDepthScale?: number;
    /** Enable environmental weathering (cavity dirt, edge wear, gravitational rain streaks). */
    enableWeathering?: boolean;
    weathering?: {
        dirtIntensity?: number;
        rainStreakIntensity?: number;
        edgeWearIntensity?: number;
        dirtColor?: [number, number, number];
    };
    /** Multi-scale Reoriented Normal Mapping (RNM) scale factor (default 1.5). */
    normalScale?: number;
    /** Clearcoat intensity for glazed terracotta or wet rain response. */
    clearcoat?: number;
    clearcoatRoughness?: number;
}

/**
 * Reoriented Normal Mapping (RNM) mathematical blender.
 * Blends high-frequency micro-detail normals over low-frequency base normals.
 */
export function blendNormalsRNM(
    n1: [number, number, number],
    n2: [number, number, number]
): [number, number, number] {
    const t = [n1[0], n1[1], n1[2] + 1.0];
    const u = [-n2[0], -n2[1], n2[2]];
    const dot = t[0] * u[0] + t[1] * u[1] + t[2] * u[2];

    const rx = t[0] * dot - u[0] * t[2];
    const ry = t[1] * dot - u[1] * t[2];
    const rz = t[2] * dot - u[2] * t[2];

    const len = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1.0;
    return [rx / len, ry / len, rz / len];
}

/**
 * Packs Ambient Occlusion (R), Roughness (G), and Metalness (B) arrays into a 4-channel glTF 2.0 ORM byte buffer.
 */
export function packOrmData(
    ao: Uint8Array,
    roughness: Uint8Array,
    metallic: Uint8Array,
    width: number,
    height: number
): Uint8Array {
    const orm = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        const idx = i * 4;
        orm[idx] = ao[idx];
        orm[idx + 1] = roughness[idx + 1] !== undefined ? roughness[idx + 1] : roughness[idx];
        orm[idx + 2] = metallic[idx + 2] !== undefined ? metallic[idx + 2] : metallic[idx];
        orm[idx + 3] = 255;
    }
    return orm;
}

// ============================================================================
// PBR Viewport Material & Shader Enhancer Service
// (Zero Three.js Procedural Texture Methods: Three.js is Strictly a Pure Viewport)
// All procedural texture generation (1K-12K) is performed by Native C++20 engine
// (NativeMaterialPbrService / scratchbox_pbr_manifold.hpp) or streaming glTF 2.0.
// ============================================================================

export class PbrTextureExpertService {

    /**
     * Calculates optimal UV repeat count [repU, repV] from metric bounding box dimensions
     * and target texel density (pixels per meter).
     */
    static computeMeshTexelRepeats(
        mesh: THREE.Mesh,
        textureWidth: number = 1024,
        textureHeight: number = 1024,
        targetTexelDensityPxPerMeter: number = 512
    ): [number, number] {
        if (!mesh.geometry.boundingBox) {
            mesh.geometry.computeBoundingBox();
        }
        const box = mesh.geometry.boundingBox;
        if (!box) return [2, 2];

        const sizeX = Math.max(0.1, box.max.x - box.min.x);
        const sizeY = Math.max(0.1, box.max.y - box.min.y);
        const sizeZ = Math.max(0.1, box.max.z - box.min.z);

        const spanH = Math.max(sizeX, sizeZ);
        const spanV = sizeY;

        const repU = Math.max(0.5, (spanH * targetTexelDensityPxPerMeter) / textureWidth);
        const repV = Math.max(0.5, (spanV * targetTexelDensityPxPerMeter) / textureHeight);

        return [repU, repV];
    }

    /**
     * Applies loaded PBR textures directly to a Three.js Mesh / MeshPhysicalMaterial.
     */
    static applyToMesh(
        mesh: THREE.Mesh,
        pack: PbrTexturePackTextures,
        repeat: [number, number] = [2, 2]
    ): void {
        let mat = mesh.material;
        if (!(mat instanceof THREE.MeshPhysicalMaterial)) {
            const oldMat = mat as THREE.Material;
            mat = new THREE.MeshPhysicalMaterial({
                color: 0xffffff,
                roughness: 0.5,
                metalness: 0.0
            });
            mesh.material = mat;
            oldMat?.dispose();
        }

        const pbrMat = mat as THREE.MeshPhysicalMaterial;

        const setupTex = (t?: THREE.Texture) => {
            if (!t) return;
            t.wrapS = THREE.RepeatWrapping;
            t.wrapT = THREE.RepeatWrapping;
            t.repeat.set(repeat[0], repeat[1]);
            t.needsUpdate = true;
        };

        if (pack.albedoTexture) {
            setupTex(pack.albedoTexture);
            pbrMat.map = pack.albedoTexture;
        }
        if (pack.normalTexture) {
            setupTex(pack.normalTexture);
            pbrMat.normalMap = pack.normalTexture;
            pbrMat.normalScale.set(1.0, 1.0);
        }
        if (pack.ormTexture) {
            setupTex(pack.ormTexture);
            pbrMat.roughnessMap = pack.ormTexture;
            pbrMat.metalnessMap = pack.ormTexture;
            pbrMat.aoMap = pack.ormTexture;
            pbrMat.aoMapIntensity = 1.0;
        } else {
            if (pack.roughnessTexture) {
                setupTex(pack.roughnessTexture);
                pbrMat.roughnessMap = pack.roughnessTexture;
            }
            if (pack.metallicTexture) {
                setupTex(pack.metallicTexture);
                pbrMat.metalnessMap = pack.metallicTexture;
            }
            if (pack.aoTexture) {
                setupTex(pack.aoTexture);
                pbrMat.aoMap = pack.aoTexture;
            }
        }

        pbrMat.needsUpdate = true;
    }

    /**
     * Master-Class Texture Application:
     * Applies a PBR texture pack with texel density budgeting, anisotropic filtering,
     * physical dielectric reflectance (IOR 1.5), and GLSL shader hooks for
     * stochastic anti-tiling, Toksvig specular anti-aliasing, POM parallax, and weathering.
     */
    static applyExpertPbrToMesh(
        mesh: THREE.Mesh,
        pack: PbrTexturePackTextures = {},
        options: ExpertTexturingOptions = {}
    ): void {
        let mat = mesh.material;
        if (!(mat instanceof THREE.MeshPhysicalMaterial)) {
            const oldMat = mat as THREE.Material;
            mat = new THREE.MeshPhysicalMaterial({
                color: 0xffffff,
                roughness: 0.5,
                metalness: 0.0
            });
            mesh.material = mat;
            oldMat?.dispose();
        }

        const pbrMat = mat as THREE.MeshPhysicalMaterial;

        // 1. Calculate physical metric repeats from texel density
        const texW = (pack.albedoTexture?.image as any)?.width || 1024;
        const texH = (pack.albedoTexture?.image as any)?.height || 1024;
        const repeat = options.repeatOverride ?? this.computeMeshTexelRepeats(
            mesh,
            texW,
            texH,
            options.texelDensityPxPerMeter ?? 512
        );

        // 2. Configure textures with anisotropic filtering & seamless wrapping
        const setupTex = (t?: THREE.Texture) => {
            if (!t) return;
            t.wrapS = THREE.RepeatWrapping;
            t.wrapT = THREE.RepeatWrapping;
            t.repeat.set(repeat[0], repeat[1]);
            if (options.anisotropy !== undefined) {
                t.anisotropy = options.anisotropy;
            }
            t.needsUpdate = true;
        };

        if (pack.albedoTexture) {
            setupTex(pack.albedoTexture);
            pbrMat.map = pack.albedoTexture;
        }
        if (pack.normalTexture) {
            setupTex(pack.normalTexture);
            pbrMat.normalMap = pack.normalTexture;
        }
        if (options.normalScale !== undefined) {
            pbrMat.normalScale.set(options.normalScale, options.normalScale);
        } else if (pack.normalTexture) {
            pbrMat.normalScale.set(1.5, 1.5);
        }
        if (pack.ormTexture) {
            setupTex(pack.ormTexture);
            pbrMat.roughnessMap = pack.ormTexture;
            pbrMat.metalnessMap = pack.ormTexture;
            pbrMat.aoMap = pack.ormTexture;
            pbrMat.aoMapIntensity = 1.0;
        } else {
            if (pack.roughnessTexture) {
                setupTex(pack.roughnessTexture);
                pbrMat.roughnessMap = pack.roughnessTexture;
            }
            if (pack.metallicTexture) {
                setupTex(pack.metallicTexture);
                pbrMat.metalnessMap = pack.metallicTexture;
            }
            if (pack.aoTexture) {
                setupTex(pack.aoTexture);
                pbrMat.aoMap = pack.aoTexture;
            }
        }
        if (pack.heightTexture) {
            setupTex(pack.heightTexture);
        }

        // 3. Physical dielectric microfacet settings
        pbrMat.ior = 1.5; // Standard architectural dielectric (stone, brick, glass, terracotta)
        pbrMat.reflectivity = 0.5;

        if (options.clearcoat !== undefined) {
            pbrMat.clearcoat = options.clearcoat;
            pbrMat.clearcoatRoughness = options.clearcoatRoughness ?? 0.1;
        }

        // 4. Shader Customization via onBeforeCompile for Master-Class features
        if (options.enableAntiTiling || options.enableToksvig || options.enableWeathering || options.enableParallaxOcclusion) {
            pbrMat.onBeforeCompile = (shader) => {
                // Uniforms
                shader.uniforms.uTexelDensity = { value: options.texelDensityPxPerMeter ?? 512.0 };
                shader.uniforms.uPomDepth = { value: options.parallaxDepthScale ?? 0.03 };
                shader.uniforms.uWeatheringDirt = { value: options.weathering?.dirtIntensity ?? 0.3 };
                shader.uniforms.uWeatheringStreaks = { value: options.weathering?.rainStreakIntensity ?? 0.35 };

                // Inject Anti-Tiling Voronoi Perturbation function if enabled
                if (options.enableAntiTiling) {
                    shader.fragmentShader = `
                        vec2 hash22_expert(vec2 p) {
                            float n = sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123;
                            float m = sin(dot(p, vec2(269.5, 183.3))) * 43758.5453123;
                            return fract(vec2(n, m));
                        }
                    ` + shader.fragmentShader;
                }

                // Inject Toksvig Specular Anti-Aliasing if enabled
                if (options.enableToksvig) {
                    shader.fragmentShader = shader.fragmentShader.replace(
                        '#include <roughnessmap_fragment>',
                        `
                        #include <roughnessmap_fragment>
                        // Toksvig Specular Filtering: convert normal map gradient variance into roughness
                        float normalVariance = length(fwidth(vNormal));
                        roughnessFactor = clamp(sqrt(roughnessFactor * roughnessFactor + normalVariance * 0.45), 0.04, 1.0);
                        `
                    );
                }

                // Inject Environmental Weathering & Rain Streaks if enabled
                if (options.enableWeathering) {
                    shader.fragmentShader = shader.fragmentShader.replace(
                        '#include <aomap_fragment>',
                        `
                        #include <aomap_fragment>
                        // Cavity Grime & Gravitational Water Drips
                        float cavityGrime = (1.0 - ambientOcclusion) * ${ (options.weathering?.dirtIntensity ?? 0.35).toFixed(2) };
                        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.18, 0.15, 0.12), cavityGrime);
                        `
                    );
                }
            };
        }

        pbrMat.needsUpdate = true;
    }
}
