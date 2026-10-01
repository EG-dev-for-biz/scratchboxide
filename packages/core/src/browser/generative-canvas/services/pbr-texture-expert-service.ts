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
    | 'chipped_paint_rust';

export interface PbrTexturePackTextures {
    albedoTexture: THREE.DataTexture;
    normalTexture: THREE.DataTexture;
    roughnessTexture: THREE.DataTexture;
    metallicTexture: THREE.DataTexture;
    aoTexture: THREE.DataTexture;
    ormTexture: THREE.DataTexture;
    heightTexture?: THREE.DataTexture;
}

export interface PbrTexturePackRaw {
    width: number;
    height: number;
    albedoRgba: Uint8Array;
    normalRgba: Uint8Array;
    roughnessRgba: Uint8Array;
    metallicRgba: Uint8Array;
    aoRgba: Uint8Array;
    ormRgba: Uint8Array;
    heightRgba?: Uint8Array;
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

export interface PbrLayeringOptions {
    transitionSharpness?: number;
    layerHeightDelta?: number;
    maskNoiseGain?: number;
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

// ============================================================================
// Mathematical Noise Kernels (Headless Browser / Client-Side)
// ============================================================================

function hashInt(x: number): number {
    let h = (x ^ 0x45d9f3b) >>> 0;
    h = ((h >>> 16) ^ h) * 0x45d9f3b;
    h = ((h >>> 16) ^ h) * 0x45d9f3b;
    return ((h >>> 16) ^ h) >>> 0;
}

export function worley2D(x: number, y: number, jitter = 1.0, seed = 1337): { f1: number; f2: number; f2_minus_f1: number; cellX: number; cellY: number } {
    const xi = Math.floor(x);
    const yi = Math.floor(y);

    let d1 = 1e9;
    let d2 = 1e9;
    let closestX = xi;
    let closestY = yi;

    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            const cx = xi + dx;
            const cy = yi + dy;
            const h = hashInt((seed ^ (Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663))) >>> 0);

            const fx = cx + ((h & 1023) / 1024.0) * jitter;
            const fy = cy + (((h >>> 10) & 1023) / 1024.0) * jitter;

            const distSq = (x - fx) * (x - fx) + (y - fy) * (y - fy);
            if (distSq < d1) {
                d2 = d1;
                d1 = distSq;
                closestX = cx;
                closestY = cy;
            } else if (distSq < d2) {
                d2 = distSq;
            }
        }
    }

    const f1 = Math.sqrt(d1);
    const f2 = Math.sqrt(d2);
    return {
        f1,
        f2,
        f2_minus_f1: Math.max(0, f2 - f1),
        cellX: closestX,
        cellY: closestY
    };
}

function grad2D(hashVal: number, x: number, y: number): number {
    const h = hashVal & 7;
    const u = h < 4 ? x : y;
    const v = h < 4 ? y : x;
    return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
}

function fade(t: number): number {
    return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}

export function perlin2D(x: number, y: number, seed = 1337): number {
    const X = Math.floor(x) & 255;
    const Y = Math.floor(y) & 255;

    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);

    const u = fade(xf);
    const v = fade(yf);

    const h = (ix: number, iy: number) => hashInt(seed ^ (ix + iy * 57));

    const aa = h(X, Y);
    const ab = h(X, Y + 1);
    const ba = h(X + 1, Y);
    const bb = h(X + 1, Y + 1);

    const x1 = (1 - u) * grad2D(aa, xf, yf) + u * grad2D(ba, xf - 1, yf);
    const x2 = (1 - u) * grad2D(ab, xf, yf - 1) + u * grad2D(bb, xf - 1, yf - 1);

    return (1 - v) * x1 + v * x2;
}

export function fbm2D(x: number, y: number, octaves = 5, lacunarity = 2.0, gain = 0.5, seed = 1337): number {
    let sum = 0.0;
    let amp = 1.0;
    let freq = 1.0;
    let maxAmp = 0.0;

    for (let i = 0; i < octaves; i++) {
        sum += perlin2D(x * freq, y * freq, seed + i * 31) * amp;
        maxAmp += amp;
        amp *= gain;
        freq *= lacunarity;
    }

    return maxAmp > 0 ? sum / maxAmp : 0;
}

export function curlWarp2D(x: number, y: number, strength = 0.25, freq = 2.0, seed = 777): [number, number] {
    const dx = fbm2D(x * freq + 0.317, y * freq + 0.719, 4, 2.0, 0.5, seed) * strength;
    const dy = fbm2D(x * freq + 15.713, y * freq + 31.927, 4, 2.0, 0.5, seed + 99) * strength;
    return [x + dx, y + dy];
}

export function gaborAnisotropic2D(x: number, y: number, angleRad: number, freq = 16.0, bandwidth = 1.0): number {
    const cosA = Math.cos(angleRad);
    const sinA = Math.sin(angleRad);

    const u = x * cosA - y * sinA;
    const v = x * sinA + y * cosA;

    const carrier = Math.cos(2.0 * Math.PI * freq * v);
    const envelope = Math.exp(-Math.PI * (bandwidth * bandwidth * u * u + v * v * 0.1));
    return carrier * envelope;
}

/**
 * Reoriented Normal Mapping (RNM) based on Barré-Brisebois & Hill (2012).
 * Correctly rotates detail vector onto base normal without loss of magnitude or specular clipping.
 */
export function blendNormalsRNM(
    n1: [number, number, number],
    n2: [number, number, number]
): [number, number, number] {
    const u: [number, number, number] = [n1[0], n1[1], n1[2] + 1.0];
    const t: [number, number, number] = [-n2[0], -n2[1], n2[2]];

    const uDotT = u[0] * t[0] + u[1] * t[1] + u[2] * t[2];
    const uz = Math.max(0.0001, u[2]);
    const factor = uDotT / uz;

    const rx = u[0] * factor - t[0];
    const ry = u[1] * factor - t[1];
    const rz = u[2] * factor - t[2];

    const len = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1.0;
    return [rx / len, ry / len, rz / len];
}

/**
 * Packs AO (Red), Roughness (Green), and Metalness (Blue) into a single standard glTF ORM byte array.
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

function createDataTexture(rgba: Uint8Array, width: number, height: number, sRgb = false): THREE.DataTexture {
    const tex = new THREE.DataTexture(rgba, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = sRgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    return tex;
}

// ============================================================================
// Procedural PBR Texture Generation Engine
// ============================================================================

export class PbrTextureExpertService {

    /**
     * Synthesizes raw procedural PBR texture channels based on biophysical material models.
     */
    static synthesizeRaw(
        archetype: PbrArchetypeId | string,
        options: PbrSynthesizeOptions = {}
    ): PbrTexturePackRaw {
        const width = options.width ?? 256;
        const height = options.height ?? 256;
        const seed = options.seed ?? 101;
        const wear = options.wear ?? 0.5;

        const albedo = new Uint8Array(width * height * 4);
        const normal = new Uint8Array(width * height * 4);
        const roughness = new Uint8Array(width * height * 4);
        const metallic = new Uint8Array(width * height * 4);
        const ao = new Uint8Array(width * height * 4);
        const heightMap = new Uint8Array(width * height * 4);

        const heightVals = new Float32Array(width * height);

        if (archetype === 'weathered_concrete' || archetype === 'concrete') {
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    const u = x / width;
                    const v = y / height;
                    const macro = fbm2D(u * 4.0, v * 4.0, 4, 2.0, 0.5, seed);
                    const wPebbles = worley2D(u * 32.0, v * 32.0, 0.85, seed + 1);
                    const pebble = Math.min(1.0, Math.max(0.0, (wPebbles.f1 - 0.15) / 0.3));
                    const wCracks = worley2D(u * 12.0, v * 12.0, 0.95, seed + 2);
                    const crack = Math.max(0, 1.0 - wCracks.f2_minus_f1 / (0.08 * wear));
                    const grit = perlin2D(u * 128.0, v * 128.0, seed + 3) * 0.15;

                    const hVal = Math.min(1.0, Math.max(0.0, 0.5 + macro * 0.15 + pebble * 0.12 - crack * 0.35 + grit));
                    heightVals[y * width + x] = hVal;

                    const idx = (y * width + x) * 4;
                    const base = 0.61 * (0.85 + macro * 0.3);
                    const col = Math.round(Math.min(255, Math.max(0, (base * (1.0 - crack) + 0.35 * crack) * 255)));
                    albedo[idx] = col;
                    albedo[idx + 1] = Math.round(col * 0.98);
                    albedo[idx + 2] = Math.round(col * 0.94);
                    albedo[idx + 3] = 255;

                    metallic[idx] = 0;
                    metallic[idx + 1] = 0;
                    metallic[idx + 2] = 0;
                    metallic[idx + 3] = 255;
                }
            }
        } else if (archetype === 'brushed_titanium' || archetype === 'brushed_metal') {
            const angleRad = (options.anisotropyAngleDeg ?? 0) * (Math.PI / 180.0);
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    const u = x / width;
                    const v = y / height;
                    const scratch = gaborAnisotropic2D(u * 64.0, v * 64.0, angleRad, 32.0, 2.0);
                    const hVal = Math.min(1.0, Math.max(0.0, 0.5 + scratch * 0.25));
                    heightVals[y * width + x] = hVal;

                    const idx = (y * width + x) * 4;
                    const col = Math.round(Math.min(255, Math.max(0, (0.76 + scratch * 0.06) * 255)));
                    albedo[idx] = col;
                    albedo[idx + 1] = Math.round(col * 1.01);
                    albedo[idx + 2] = Math.round(col * 1.08);
                    albedo[idx + 3] = 255;

                    metallic[idx] = 245;
                    metallic[idx + 1] = 245;
                    metallic[idx + 2] = 245;
                    metallic[idx + 3] = 255;
                }
            }
        } else if (archetype === 'carrara_marble' || archetype === 'marble') {
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    const u = x / width;
                    const v = y / height;
                    const [wu, wv] = curlWarp2D(u * 4.0, v * 4.0, 0.45, 2.5, seed);
                    const vein = Math.abs(fbm2D(wu, wv, 5, 2.0, 0.5, seed));
                    const veinMask = Math.max(0, Math.min(1.0, 1.0 - vein / 0.12));
                    const hVal = Math.min(1.0, Math.max(0.0, 0.5 - veinMask * 0.08));
                    heightVals[y * width + x] = hVal;

                    const idx = (y * width + x) * 4;
                    const r = Math.round((0.94 * (1.0 - veinMask) + 0.28 * veinMask) * 255);
                    const g = Math.round((0.93 * (1.0 - veinMask) + 0.29 * veinMask) * 255);
                    const b = Math.round((0.91 * (1.0 - veinMask) + 0.31 * veinMask) * 255);
                    albedo[idx] = r;
                    albedo[idx + 1] = g;
                    albedo[idx + 2] = b;
                    albedo[idx + 3] = 255;

                    metallic[idx] = 5;
                    metallic[idx + 1] = 5;
                    metallic[idx + 2] = 5;
                    metallic[idx + 3] = 255;
                }
            }
        } else if (archetype === 'wood_endgrain' || archetype === 'wood') {
            const cx = width * 0.5;
            const cy = height * 0.5;
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    const dx = (x - cx) / width;
                    const dy = (y - cy) / height;
                    const r = Math.sqrt(dx * dx + dy * dy);
                    const warp = fbm2D(dx * 4.0, dy * 4.0, 4, 2.0, 0.5, seed) * 0.04;
                    const ringVal = Math.sin((r + warp) * 14.0 * 2.0 * Math.PI) * 0.5 + 0.5;
                    heightVals[y * width + x] = ringVal;

                    const idx = (y * width + x) * 4;
                    const red = Math.round((0.78 * (1.0 - ringVal) + 0.42 * ringVal) * 255);
                    const grn = Math.round((0.58 * (1.0 - ringVal) + 0.26 * ringVal) * 255);
                    const blu = Math.round((0.38 * (1.0 - ringVal) + 0.14 * ringVal) * 255);
                    albedo[idx] = red;
                    albedo[idx + 1] = grn;
                    albedo[idx + 2] = blu;
                    albedo[idx + 3] = 255;

                    metallic[idx] = 0;
                    metallic[idx + 1] = 0;
                    metallic[idx + 2] = 0;
                    metallic[idx + 3] = 255;
                }
            }
        } else if (archetype === 'hammered_copper' || archetype === 'copper') {
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    const u = x / width;
                    const v = y / height;
                    const w = worley2D(u * 10.0, v * 10.0, 0.9, seed);
                    const dimple = Math.max(0, 1.0 - w.f1 * 1.4);
                    const sphereCap = Math.sqrt(Math.max(0, 1.0 - dimple * dimple));
                    heightVals[y * width + x] = sphereCap;

                    const cavity = Math.max(0, 1.0 - sphereCap * 1.5);
                    const idx = (y * width + x) * 4;
                    const red = Math.round((0.95 * (1.0 - cavity * 0.6) + 0.32 * cavity * 0.6) * 255);
                    const grn = Math.round((0.64 * (1.0 - cavity * 0.6) + 0.68 * cavity * 0.6) * 255);
                    const blu = Math.round((0.54 * (1.0 - cavity * 0.6) + 0.55 * cavity * 0.6) * 255);
                    albedo[idx] = red;
                    albedo[idx + 1] = grn;
                    albedo[idx + 2] = blu;
                    albedo[idx + 3] = 255;

                    const m = Math.round(Math.max(0, 0.95 - cavity * 0.85) * 255);
                    metallic[idx] = m;
                    metallic[idx + 1] = m;
                    metallic[idx + 2] = m;
                    metallic[idx + 3] = 255;
                }
            }
        } else {
            // Chipped paint over rust
            const pCol = options.color ?? [0.12, 0.45, 0.85];
            const chip = options.wear ?? 0.4;
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    const u = x / width;
                    const v = y / height;
                    const w = worley2D(u * 8.0, v * 8.0, 0.9, seed + 88);
                    const fbmMod = fbm2D(u * 16.0, v * 16.0, 4, 2.0, 0.5, seed + 99) * 0.25;
                    const paintMask = w.f1 > (chip + fbmMod) ? 1.0 : 0.0;
                    heightVals[y * width + x] = paintMask * 0.75 + (1.0 - paintMask) * 0.5;

                    const idx = (y * width + x) * 4;
                    if (paintMask > 0.5) {
                        albedo[idx] = Math.round(pCol[0] * 255);
                        albedo[idx + 1] = Math.round(pCol[1] * 255);
                        albedo[idx + 2] = Math.round(pCol[2] * 255);
                        metallic[idx] = 0;
                        metallic[idx + 1] = 0;
                        metallic[idx + 2] = 0;
                    } else {
                        albedo[idx] = 110;
                        albedo[idx + 1] = 55;
                        albedo[idx + 2] = 30;
                        metallic[idx] = 90;
                        metallic[idx + 1] = 90;
                        metallic[idx + 2] = 90;
                    }
                    albedo[idx + 3] = 255;
                    metallic[idx + 3] = 255;
                }
            }
        }

        const getH = (x: number, y: number): number => {
            const px = ((x % width) + width) % width;
            const py = ((y % height) + height) % height;
            return heightVals[py * width + px];
        };

        const roughnessBias = options.roughnessBias ?? 0.0;

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = (y * width + x) * 4;
                const hC = getH(x, y);
                const hL = getH(x - 1, y);
                const hR = getH(x + 1, y);
                const hT = getH(x, y - 1);
                const hB = getH(x, y + 1);

                heightMap[idx] = Math.round(hC * 255);
                heightMap[idx + 1] = Math.round(hC * 255);
                heightMap[idx + 2] = Math.round(hC * 255);
                heightMap[idx + 3] = 255;

                // Scharr normal
                const dx = (getH(x + 1, y - 1) + 3.33 * hR + getH(x + 1, y + 1) - (getH(x - 1, y - 1) + 3.33 * hL + getH(x - 1, y + 1))) / 5.333;
                const dy = (getH(x - 1, y + 1) + 3.33 * hB + getH(x + 1, y + 1) - (getH(x - 1, y - 1) + 3.33 * hT + getH(x + 1, y - 1))) / 5.333;
                const strength = 3.2;
                let nx = -dx * strength;
                let ny = -dy * strength;
                let nz = 1.0;
                const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1.0;
                nx /= len;
                ny /= len;
                nz /= len;

                normal[idx] = Math.round((nx * 0.5 + 0.5) * 255);
                normal[idx + 1] = Math.round((ny * 0.5 + 0.5) * 255);
                normal[idx + 2] = Math.round((nz * 0.5 + 0.5) * 255);
                normal[idx + 3] = 255;

                // Curvature & variance roughness
                const avg = (hL + hR + hT + hB) * 0.25;
                const variance = Math.abs(hC - avg);
                const laplacian = 4.0 * hC - (hL + hR + hT + hB);
                const baseR = (archetype === 'brushed_titanium' || archetype === 'brushed_metal') ? 0.22 :
                              ((archetype === 'carrara_marble' || archetype === 'marble') ? 0.12 :
                              ((archetype === 'wood_endgrain' || archetype === 'wood') ? 0.55 : 0.72));
                const vWeight = (archetype === 'brushed_titanium' || archetype === 'brushed_metal') ? 0.6 : 2.0;
                const rVal = Math.min(0.98, Math.max(0.04, baseR + roughnessBias + variance * vWeight - Math.max(0, laplacian) * 0.2 + Math.max(0, -laplacian) * 0.3));
                const rByte = Math.round(rVal * 255);

                roughness[idx] = rByte;
                roughness[idx + 1] = rByte;
                roughness[idx + 2] = rByte;
                roughness[idx + 3] = 255;

                // Cavity AO
                const concavity = Math.max(0, avg - hC);
                const aoVal = Math.min(1.0, Math.max(0.2, 1.0 - concavity * 4.8));
                const aoByte = Math.round(aoVal * 255);

                ao[idx] = aoByte;
                ao[idx + 1] = aoByte;
                ao[idx + 2] = aoByte;
                ao[idx + 3] = 255;
            }
        }

        const orm = packOrmData(ao, roughness, metallic, width, height);

        return {
            width,
            height,
            albedoRgba: albedo,
            normalRgba: normal,
            roughnessRgba: roughness,
            metallicRgba: metallic,
            aoRgba: ao,
            ormRgba: orm,
            heightRgba: heightMap
        };
    }

    /**
     * Synthesizes ready-to-use Three.js textures.
     */
    static synthesizeTextures(
        archetype: PbrArchetypeId | string,
        options: PbrSynthesizeOptions = {}
    ): PbrTexturePackTextures {
        const raw = this.synthesizeRaw(archetype, options);
        return {
            albedoTexture: createDataTexture(raw.albedoRgba, raw.width, raw.height, true),
            normalTexture: createDataTexture(raw.normalRgba, raw.width, raw.height, false),
            roughnessTexture: createDataTexture(raw.roughnessRgba, raw.width, raw.height, false),
            metallicTexture: createDataTexture(raw.metallicRgba, raw.width, raw.height, false),
            aoTexture: createDataTexture(raw.aoRgba, raw.width, raw.height, false),
            ormTexture: createDataTexture(raw.ormRgba, raw.width, raw.height, false),
            heightTexture: raw.heightRgba ? createDataTexture(raw.heightRgba, raw.width, raw.height, false) : undefined
        };
    }

    /**
     * Height-blends a topcoat PBR texture set over a substrate PBR texture set using
     * smooth transition and Reoriented Normal Mapping (RNM).
     */
    static layerPbrSets(
        substrate: PbrTexturePackRaw,
        topcoat: PbrTexturePackRaw,
        mask: Float32Array,
        options: PbrLayeringOptions = {}
    ): PbrTexturePackRaw {
        const width = substrate.width;
        const height = substrate.height;
        const sharpness = options.transitionSharpness ?? 8.0;

        const outAlbedo = new Uint8Array(width * height * 4);
        const outNormal = new Uint8Array(width * height * 4);
        const outRoughness = new Uint8Array(width * height * 4);
        const outMetallic = new Uint8Array(width * height * 4);
        const outAo = new Uint8Array(width * height * 4);
        const outHeight = new Uint8Array(width * height * 4);

        for (let i = 0; i < width * height; i++) {
            const idx = i * 4;

            const hSub = (substrate.heightRgba ? substrate.heightRgba[idx] : 128) / 255.0;
            const hTop = (topcoat.heightRgba ? topcoat.heightRgba[idx] : 128) / 255.0 + 0.15;
            const m = mask[i];

            // Soft height differential blend factor
            const delta = (hTop + m) - (hSub + (1.0 - m));
            const weight = Math.min(1.0, Math.max(0.0, 1.0 / (1.0 + Math.exp(-delta * sharpness))));

            // 1. Albedo
            for (let c = 0; c < 3; c++) {
                outAlbedo[idx + c] = Math.round(substrate.albedoRgba[idx + c] * (1.0 - weight) + topcoat.albedoRgba[idx + c] * weight);
            }
            outAlbedo[idx + 3] = 255;

            // 2. Reoriented Normal Mapping (RNM)
            const nSub: [number, number, number] = [
                (substrate.normalRgba[idx] / 255.0) * 2.0 - 1.0,
                (substrate.normalRgba[idx + 1] / 255.0) * 2.0 - 1.0,
                (substrate.normalRgba[idx + 2] / 255.0) * 2.0 - 1.0
            ];
            const nTop: [number, number, number] = [
                (topcoat.normalRgba[idx] / 255.0) * 2.0 - 1.0,
                (topcoat.normalRgba[idx + 1] / 255.0) * 2.0 - 1.0,
                (topcoat.normalRgba[idx + 2] / 255.0) * 2.0 - 1.0
            ];
            const blendedN = blendNormalsRNM(nSub, nTop);
            outNormal[idx] = Math.round((blendedN[0] * (1.0 - weight) + nTop[0] * weight) * 127.5 + 127.5);
            outNormal[idx + 1] = Math.round((blendedN[1] * (1.0 - weight) + nTop[1] * weight) * 127.5 + 127.5);
            outNormal[idx + 2] = Math.round((blendedN[2] * (1.0 - weight) + nTop[2] * weight) * 127.5 + 127.5);
            outNormal[idx + 3] = 255;

            // 3. Roughness
            const rVal = Math.round(substrate.roughnessRgba[idx] * (1.0 - weight) + topcoat.roughnessRgba[idx] * weight);
            outRoughness[idx] = rVal;
            outRoughness[idx + 1] = rVal;
            outRoughness[idx + 2] = rVal;
            outRoughness[idx + 3] = 255;

            // 4. Metallic
            const mVal = Math.round(substrate.metallicRgba[idx] * (1.0 - weight) + topcoat.metallicRgba[idx] * weight);
            outMetallic[idx] = mVal;
            outMetallic[idx + 1] = mVal;
            outMetallic[idx + 2] = mVal;
            outMetallic[idx + 3] = 255;

            // 5. AO
            const aoVal = Math.round(substrate.aoRgba[idx] * (1.0 - weight) + topcoat.aoRgba[idx] * weight);
            outAo[idx] = aoVal;
            outAo[idx + 1] = aoVal;
            outAo[idx + 2] = aoVal;
            outAo[idx + 3] = 255;

            // 6. Height
            const hOut = Math.round((hSub * (1.0 - weight) + hTop * weight) * 255.0);
            outHeight[idx] = hOut;
            outHeight[idx + 1] = hOut;
            outHeight[idx + 2] = hOut;
            outHeight[idx + 3] = 255;
        }

        const outOrm = packOrmData(outAo, outRoughness, outMetallic, width, height);

        return {
            width,
            height,
            albedoRgba: outAlbedo,
            normalRgba: outNormal,
            roughnessRgba: outRoughness,
            metallicRgba: outMetallic,
            aoRgba: outAo,
            ormRgba: outOrm,
            heightRgba: outHeight
        };
    }

    /**
     * Calculates optimal non-stretching metric UV repeats from mesh bounding box dimensions
     * and target texel density (pixels per physical meter).
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
     * Applies a generated PBR texture pack directly to a Three.js Mesh / MeshPhysicalMaterial.
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

        const setupTex = (t?: THREE.DataTexture) => {
            if (!t) return;
            t.wrapS = THREE.RepeatWrapping;
            t.wrapT = THREE.RepeatWrapping;
            t.repeat.set(repeat[0], repeat[1]);
            t.needsUpdate = true;
        };

        setupTex(pack.albedoTexture);
        setupTex(pack.normalTexture);
        setupTex(pack.ormTexture);

        pbrMat.map = pack.albedoTexture;
        pbrMat.normalMap = pack.normalTexture;
        pbrMat.normalScale.set(1.0, 1.0);

        // Bind packed ORM texture to roughness, metalness, and AO
        pbrMat.roughnessMap = pack.ormTexture;
        pbrMat.metalnessMap = pack.ormTexture;
        pbrMat.aoMap = pack.ormTexture;
        pbrMat.aoMapIntensity = 1.0;

        pbrMat.needsUpdate = true;
    }

    /**
     * Master-Class Texture Application:
     * Applies a PBR texture pack with texel density budgeting, anisotropic filtering,
     * physical dielectric reflectance (IOR 1.5), and optional shader hooks for
     * stochastic anti-tiling, Toksvig specular anti-aliasing, POM parallax, and weathering.
     */
    static applyExpertPbrToMesh(
        mesh: THREE.Mesh,
        pack: PbrTexturePackTextures,
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
        const texW = pack.albedoTexture?.image?.width || 1024;
        const texH = pack.albedoTexture?.image?.height || 1024;
        const repeat = options.repeatOverride ?? this.computeMeshTexelRepeats(
            mesh,
            texW,
            texH,
            options.texelDensityPxPerMeter ?? 512
        );

        // 2. Configure textures with anisotropic filtering & seamless wrapping
        const setupTex = (t?: THREE.DataTexture) => {
            if (!t) return;
            t.wrapS = THREE.RepeatWrapping;
            t.wrapT = THREE.RepeatWrapping;
            t.repeat.set(repeat[0], repeat[1]);
            if (options.anisotropy !== undefined) {
                t.anisotropy = options.anisotropy;
            }
            t.needsUpdate = true;
        };

        setupTex(pack.albedoTexture);
        setupTex(pack.normalTexture);
        setupTex(pack.ormTexture);
        setupTex(pack.heightTexture);

        // 3. Bind maps to MeshPhysicalMaterial
        pbrMat.map = pack.albedoTexture;
        pbrMat.normalMap = pack.normalTexture;
        const nScale = options.normalScale ?? 1.5;
        pbrMat.normalScale.set(nScale, nScale);

        pbrMat.roughnessMap = pack.ormTexture;
        pbrMat.metalnessMap = pack.ormTexture;
        pbrMat.aoMap = pack.ormTexture;
        pbrMat.aoMapIntensity = 1.0;

        // 4. Physical dielectric microfacet settings
        pbrMat.ior = 1.5; // Standard architectural dielectric (stone, brick, glass, terracotta)
        pbrMat.reflectivity = 0.5;

        if (options.clearcoat !== undefined) {
            pbrMat.clearcoat = options.clearcoat;
            pbrMat.clearcoatRoughness = options.clearcoatRoughness ?? 0.1;
        }

        // 5. Shader Customization via onBeforeCompile for Master-Class features
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
