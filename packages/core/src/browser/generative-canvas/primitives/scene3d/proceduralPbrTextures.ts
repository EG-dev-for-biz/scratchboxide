/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as THREE from 'three';

export interface MaterialPresetConfig {
    color: number;
    roughness: number;
    metalness: number;
    clearcoat?: number;
    clearcoatRoughness?: number;
    transmission?: number;
    ior?: number;
    sheen?: number;
    normalScale?: number;
}

export interface ProceduralPbrTextures {
    normalMap: THREE.DataTexture;
    roughnessMap: THREE.DataTexture;
}

const proceduralTextureCache = new Map<string, ProceduralPbrTextures>();

function pseudoNoise(x: number, y: number, seed: number): number {
    const n = Math.sin(x * 12.9898 + y * 78.233 + seed * 43.123) * 43758.5453123;
    return n - Math.floor(n);
}

/**
 * Returns physical material defaults for a named material preset.
 */
export function getPresetConfig(preset: string): MaterialPresetConfig | null {
    const key = preset.toLowerCase().trim();
    if (key.includes('mudbrick') || key.includes('adobe') || key.includes('terracotta') || key.includes('brick')) {
        return { color: 0xc48c5c, roughness: 0.88, metalness: 0.02, normalScale: 0.8 };
    }
    if (key.includes('lapis') || key.includes('glazed') || key.includes('ceramic')) {
        return { color: 0x0f3b82, roughness: 0.18, metalness: 0.12, clearcoat: 0.95, clearcoatRoughness: 0.1, ior: 1.54, normalScale: 0.25 };
    }
    if (key.includes('gold') || key.includes('brass') || key.includes('bronze_hammered')) {
        return { color: 0xf5c33b, roughness: 0.32, metalness: 0.96, clearcoat: 0.2, normalScale: 0.6 };
    }
    if (key.includes('snow') || key.includes('ice') || key.includes('glacier')) {
        return { color: 0xf4f7fb, roughness: 0.42, metalness: 0.02, transmission: 0.12, clearcoat: 0.5, ior: 1.31, normalScale: 0.5 };
    }
    if (key.includes('bark') || key.includes('wood') || key.includes('timber')) {
        return { color: 0x4a3424, roughness: 0.92, metalness: 0.02, normalScale: 0.9 };
    }
    if (key.includes('concrete') || key.includes('stone') || key.includes('granite') || key.includes('rock')) {
        return { color: 0x888b90, roughness: 0.82, metalness: 0.05, normalScale: 0.65 };
    }
    if (key.includes('bronze') || key.includes('copper') || key.includes('patina')) {
        return { color: 0x46887e, roughness: 0.65, metalness: 0.82, normalScale: 0.5 };
    }
    return null;
}

/**
 * Procedurally generates high-frequency normal and roughness micro-textures for material presets
 * using standard DataTexture (zero DOM dependency, works in all Three.js renderers).
 */
export function getProceduralPbrTextures(preset: string): ProceduralPbrTextures {
    const key = preset.toLowerCase().trim();
    if (proceduralTextureCache.has(key)) {
        return proceduralTextureCache.get(key)!;
    }

    const size = 128;
    const normalData = new Uint8Array(size * size * 4);
    const roughnessData = new Uint8Array(size * size * 4);

    if (key.includes('mudbrick') || key.includes('adobe') || key.includes('brick')) {
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const idx = (y * size + x) * 4;
                const isGroove = (x % 32 < 2) || (y % 16 < 2);
                const grain = (pseudoNoise(x, y, 1.0) - 0.5) * 0.4;
                const baseDx = isGroove ? (x % 32 < 2 ? 0.6 : 0) : grain;
                const baseDy = isGroove ? (y % 16 < 2 ? 0.6 : 0) : grain;

                const nx = Math.max(-1, Math.min(1, baseDx));
                const ny = Math.max(-1, Math.min(1, baseDy));
                const nz = Math.sqrt(Math.max(0, 1.0 - nx * nx - ny * ny));

                normalData[idx] = Math.floor((nx * 0.5 + 0.5) * 255);
                normalData[idx + 1] = Math.floor((ny * 0.5 + 0.5) * 255);
                normalData[idx + 2] = Math.floor((nz * 0.5 + 0.5) * 255);
                normalData[idx + 3] = 255;

                const r = isGroove ? 245 : Math.floor((0.85 + grain * 0.2) * 255);
                roughnessData[idx] = r;
                roughnessData[idx + 1] = r;
                roughnessData[idx + 2] = r;
                roughnessData[idx + 3] = 255;
            }
        }
    } else if (key.includes('gold') || key.includes('brass') || key.includes('metal')) {
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const idx = (y * size + x) * 4;
                const cx = (Math.floor(x / 16) + 0.5) * 16;
                const cy = (Math.floor(y / 16) + 0.5) * 16;
                const dx = (x - cx) / 8.0;
                const dy = (y - cy) / 8.0;
                const distSq = dx * dx + dy * dy;
                const dimple = distSq < 1.0 ? Math.sin((1.0 - distSq) * Math.PI) * 0.45 : 0;

                const nx = dx * dimple;
                const ny = dy * dimple;
                const nz = Math.sqrt(Math.max(0, 1.0 - nx * nx - ny * ny));

                normalData[idx] = Math.floor((nx * 0.5 + 0.5) * 255);
                normalData[idx + 1] = Math.floor((ny * 0.5 + 0.5) * 255);
                normalData[idx + 2] = Math.floor((nz * 0.5 + 0.5) * 255);
                normalData[idx + 3] = 255;

                const r = Math.floor((0.28 + dimple * 0.18) * 255);
                roughnessData[idx] = r;
                roughnessData[idx + 1] = r;
                roughnessData[idx + 2] = r;
                roughnessData[idx + 3] = 255;
            }
        }
    } else if (key.includes('snow') || key.includes('ice') || key.includes('glacier')) {
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const idx = (y * size + x) * 4;
                const sparkle = (pseudoNoise(x, y, 7.0) > 0.88 ? 0.45 : 0.0) + (pseudoNoise(x * 2, y * 2, 3.0) - 0.5) * 0.22;
                const nx = sparkle * 0.5;
                const ny = sparkle * 0.5;
                const nz = Math.sqrt(Math.max(0, 1.0 - nx * nx - ny * ny));

                normalData[idx] = Math.floor((nx * 0.5 + 0.5) * 255);
                normalData[idx + 1] = Math.floor((ny * 0.5 + 0.5) * 255);
                normalData[idx + 2] = Math.floor((nz * 0.5 + 0.5) * 255);
                normalData[idx + 3] = 255;

                const r = Math.floor((0.42 + (pseudoNoise(x, y, 2.0) - 0.5) * 0.2) * 255);
                roughnessData[idx] = r;
                roughnessData[idx + 1] = r;
                roughnessData[idx + 2] = r;
                roughnessData[idx + 3] = 255;
            }
        }
    } else if (key.includes('bark') || key.includes('wood')) {
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const idx = (y * size + x) * 4;
                const furrow = Math.sin(x * 0.4 + pseudoNoise(0, y, 5.0) * 1.5) * 0.55;
                const nx = furrow * 0.65;
                const ny = (pseudoNoise(x, y, 4.0) - 0.5) * 0.15;
                const nz = Math.sqrt(Math.max(0, 1.0 - nx * nx - ny * ny));

                normalData[idx] = Math.floor((nx * 0.5 + 0.5) * 255);
                normalData[idx + 1] = Math.floor((ny * 0.5 + 0.5) * 255);
                normalData[idx + 2] = Math.floor((nz * 0.5 + 0.5) * 255);
                normalData[idx + 3] = 255;

                const r = Math.floor((0.90 + furrow * 0.08) * 255);
                roughnessData[idx] = r;
                roughnessData[idx + 1] = r;
                roughnessData[idx + 2] = r;
                roughnessData[idx + 3] = 255;
            }
        }
    } else {
        // Mineral stone / granite / concrete
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const idx = (y * size + x) * 4;
                const grain = (pseudoNoise(x, y, 9.0) - 0.5) * 0.3;
                const nx = grain;
                const ny = grain;
                const nz = Math.sqrt(Math.max(0, 1.0 - nx * nx - ny * ny));

                normalData[idx] = Math.floor((nx * 0.5 + 0.5) * 255);
                normalData[idx + 1] = Math.floor((ny * 0.5 + 0.5) * 255);
                normalData[idx + 2] = Math.floor((nz * 0.5 + 0.5) * 255);
                normalData[idx + 3] = 255;

                const r = Math.floor((0.80 + grain * 0.15) * 255);
                roughnessData[idx] = r;
                roughnessData[idx + 1] = r;
                roughnessData[idx + 2] = r;
                roughnessData[idx + 3] = 255;
            }
        }
    }

    const normTex = new THREE.DataTexture(normalData, size, size, THREE.RGBAFormat);
    normTex.wrapS = THREE.RepeatWrapping;
    normTex.wrapT = THREE.RepeatWrapping;
    normTex.repeat.set(4, 4);
    normTex.needsUpdate = true;

    const roughTex = new THREE.DataTexture(roughnessData, size, size, THREE.RGBAFormat);
    roughTex.wrapS = THREE.RepeatWrapping;
    roughTex.wrapT = THREE.RepeatWrapping;
    roughTex.repeat.set(4, 4);
    roughTex.needsUpdate = true;

    const res = { normalMap: normTex, roughnessMap: roughTex };
    proceduralTextureCache.set(key, res);
    return res;
}
