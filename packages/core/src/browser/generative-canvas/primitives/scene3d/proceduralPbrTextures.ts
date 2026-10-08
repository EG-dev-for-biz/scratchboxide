/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

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

/**
 * Returns physical material defaults for a named material configuration.
 * Adheres to Adaptive Domain Architecture (ADA): continuous physical parameters,
 * zero Three.js texture synthesis methods (all procedural texture generation
 * resides natively in C++20 engine or streaming GLB).
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
