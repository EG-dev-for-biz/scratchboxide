/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as THREE from 'three';

export interface CubeLutData {
    title: string;
    size: number;
    data: Float32Array; // RGBA float values
    domainMin: [number, number, number];
    domainMax: [number, number, number];
}

/**
 * Parses an industry-standard .cube 3D LUT file content.
 */
export function parseCubeLut(text: string): CubeLutData {
    const lines = text.split(/\r?\n/);
    let size = 0;
    let title = 'Custom LUT';
    const domainMin: [number, number, number] = [0, 0, 0];
    const domainMax: [number, number, number] = [1, 1, 1];
    const rawRgb: number[] = [];

    for (let line of lines) {
        line = line.trim();
        if (!line || line.startsWith('#')) continue;

        const parts = line.split(/\s+/);
        const tag = parts[0].toUpperCase();

        if (tag === 'TITLE') {
            title = parts.slice(1).join(' ').replace(/^["']|["']$/g, '');
        } else if (tag === 'LUT_3D_SIZE') {
            size = parseInt(parts[1], 10);
        } else if (tag === 'DOMAIN_MIN') {
            domainMin[0] = parseFloat(parts[1]);
            domainMin[1] = parseFloat(parts[2]);
            domainMin[2] = parseFloat(parts[3]);
        } else if (tag === 'DOMAIN_MAX') {
            domainMax[0] = parseFloat(parts[1]);
            domainMax[1] = parseFloat(parts[2]);
            domainMax[2] = parseFloat(parts[3]);
        } else if (parts.length === 3) {
            const r = parseFloat(parts[0]);
            const g = parseFloat(parts[1]);
            const b = parseFloat(parts[2]);
            if (!isNaN(r) && !isNaN(g) && !isNaN(b)) {
                rawRgb.push(r, g, b);
            }
        }
    }

    if (size === 0) {
        const count = rawRgb.length / 3;
        size = Math.round(Math.cbrt(count));
    }

    const totalSamples = size * size * size;
    const rgba = new Float32Array(totalSamples * 4);

    for (let i = 0; i < totalSamples; i++) {
        const r = rawRgb[i * 3] ?? 0;
        const g = rawRgb[i * 3 + 1] ?? 0;
        const b = rawRgb[i * 3 + 2] ?? 0;
        rgba[i * 4] = r;
        rgba[i * 4 + 1] = g;
        rgba[i * 4 + 2] = b;
        rgba[i * 4 + 3] = 1.0;
    }

    return { title, size, data: rgba, domainMin, domainMax };
}

/**
 * Creates a Three.js Data3DTexture from parsed LUT data.
 */
export function createData3DTexture(lut: CubeLutData): THREE.Data3DTexture {
    const texture = new THREE.Data3DTexture(lut.data, lut.size, lut.size, lut.size);
    texture.format = THREE.RGBAFormat;
    texture.type = THREE.FloatType;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.wrapR = THREE.ClampToEdgeWrapping;
    texture.needsUpdate = true;
    return texture;
}

/**
 * Generates built-in procedural 3D LUT textures for instant grading.
 */
export function generateProceduralLut(type: 'teal-orange' | 'cyberpunk' | 'vintage' | 'noir' | 'neutral', size = 16): THREE.Data3DTexture {
    const total = size * size * size;
    const data = new Float32Array(total * 4);

    for (let b = 0; b < size; b++) {
        for (let g = 0; g < size; g++) {
            for (let r = 0; r < size; r++) {
                const idx = (b * size * size + g * size + r) * 4;
                let rf = r / (size - 1);
                let gf = g / (size - 1);
                let bf = b / (size - 1);

                if (type === 'teal-orange') {
                    // Push shadows towards cyan/teal, highlights towards orange/gold
                    const luma = 0.2126 * rf + 0.7152 * gf + 0.0722 * bf;
                    if (luma < 0.5) {
                        bf = Math.min(1.0, bf * 1.25 + 0.05);
                        gf = Math.min(1.0, gf * 1.1 + 0.02);
                        rf = Math.max(0.0, rf * 0.85);
                    } else {
                        rf = Math.min(1.0, rf * 1.2 + 0.05);
                        gf = Math.min(1.0, gf * 1.05);
                        bf = Math.max(0.0, bf * 0.75);
                    }
                } else if (type === 'cyberpunk') {
                    // Magenta highlights and deep neon cyan shadows
                    const luma = 0.2126 * rf + 0.7152 * gf + 0.0722 * bf;
                    rf = Math.min(1.0, rf * 1.3 + (1.0 - luma) * 0.1);
                    gf = Math.min(1.0, gf * 0.85 + (1.0 - luma) * 0.2);
                    bf = Math.min(1.0, bf * 1.4 + 0.1);
                } else if (type === 'vintage') {
                    // Warm golden fade, lifted blacks, compressed highlights
                    rf = Math.min(1.0, rf * 1.1 + 0.05);
                    gf = Math.min(1.0, gf * 1.02 + 0.04);
                    bf = Math.min(1.0, Math.max(0.08, bf * 0.85 + 0.03));
                } else if (type === 'noir') {
                    // High-contrast monochromatic
                    const luma = 0.299 * rf + 0.587 * gf + 0.114 * bf;
                    const contrast = (luma - 0.5) * 1.35 + 0.5;
                    const cClamped = Math.max(0.0, Math.min(1.0, contrast));
                    rf = cClamped;
                    gf = cClamped;
                    bf = cClamped;
                }

                data[idx] = Math.max(0, Math.min(1, rf));
                data[idx + 1] = Math.max(0, Math.min(1, gf));
                data[idx + 2] = Math.max(0, Math.min(1, bf));
                data[idx + 3] = 1.0;
            }
        }
    }

    const lut: CubeLutData = {
        title: type,
        size,
        data,
        domainMin: [0, 0, 0],
        domainMax: [1, 1, 1]
    };
    return createData3DTexture(lut);
}
