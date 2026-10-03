/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

export interface PhotorealismMetricReport {
    exerciseName: string;
    vertexCount: number;
    triangleCount: number;
    densityScore: number;          // 0 - 25
    normalSmoothnessScore: number; // 0 - 25
    aoWeatheringScore: number;     // 0 - 25
    pbrMaterialScore: number;      // 0 - 25
    totalScore: number;            // 0 - 100
    isPhotorealistic: boolean;     // >= 90
    diagnostics: string[];
    materialSummary: {
        name: string;
        metallic: number;
        roughness: number;
        hasVertexColors: boolean;
        hasEmissive: boolean;
    };
    boundingDimensions: { x: number; y: number; z: number };
}

export interface GlbInspectionData {
    vertexCount: number;
    indexCount: number;
    positions: Float32Array;
    normals: Float32Array;
    colors?: Float32Array;
    materialName?: string;
    metallicFactor?: number;
    roughnessFactor?: number;
    emissiveFactor?: [number, number, number];
}

/**
 * Inspects binary glTF 2.0 (GLB) bytes directly to extract geometry and material data.
 */
export function inspectGlbBuffer(glbBytes: Uint8Array): GlbInspectionData {
    const view = new DataView(glbBytes.buffer, glbBytes.byteOffset, glbBytes.byteLength);
    const magic = view.getUint32(0, true);
    if (magic !== 0x46546C67) {
        throw new Error(`Invalid GLB magic: 0x${magic.toString(16)} (expected 0x46546C67)`);
    }

    const version = view.getUint32(4, true);
    if (version !== 2) {
        throw new Error(`Unsupported GLB version: ${version}`);
    }

    // JSON chunk
    const jsonChunkLength = view.getUint32(12, true);
    const jsonChunkType = view.getUint32(16, true);
    if (jsonChunkType !== 0x4E4F534A) {
        throw new Error('Expected JSON chunk at offset 12');
    }

    const jsonBytes = new Uint8Array(glbBytes.buffer, glbBytes.byteOffset + 20, jsonChunkLength);
    const jsonText = new TextDecoder().decode(jsonBytes);
    const gltf = JSON.parse(jsonText.replace(/[\0\s]+$/, ''));

    // BIN chunk
    const binChunkOffset = 20 + jsonChunkLength;
    let binBytes: Uint8Array | null = null;
    if (binChunkOffset < glbBytes.byteLength) {
        const binLength = view.getUint32(binChunkOffset, true);
        binBytes = new Uint8Array(glbBytes.buffer, glbBytes.byteOffset + binChunkOffset + 8, binLength);
    }

    if (!binBytes) {
        throw new Error('GLB has no BIN chunk');
    }

    const mesh = gltf.meshes?.[0];
    const prim = mesh?.primitives?.[0];
    const attrs = prim?.attributes || {};

    const posAccessor = gltf.accessors[attrs.POSITION];
    const normAccessor = gltf.accessors[attrs.NORMAL];
    const colorAccessor = attrs.COLOR_0 !== undefined ? gltf.accessors[attrs.COLOR_0] : undefined;
    const indexAccessor = prim?.indices !== undefined ? gltf.accessors[prim.indices] : undefined;

    const posView = gltf.bufferViews[posAccessor.bufferView];
    const normView = gltf.bufferViews[normAccessor.bufferView];

    const posOffset = (posView.byteOffset || 0) + (posAccessor.byteOffset || 0);
    const normOffset = (normView.byteOffset || 0) + (normAccessor.byteOffset || 0);

    const positions = new Float32Array(binBytes.buffer, binBytes.byteOffset + posOffset, posAccessor.count * 3);
    const normals = new Float32Array(binBytes.buffer, binBytes.byteOffset + normOffset, normAccessor.count * 3);

    let colors: Float32Array | undefined;
    if (colorAccessor) {
        const colorView = gltf.bufferViews[colorAccessor.bufferView];
        const colorOffset = (colorView.byteOffset || 0) + (colorAccessor.byteOffset || 0);
        colors = new Float32Array(binBytes.buffer, binBytes.byteOffset + colorOffset, colorAccessor.count * 4);
    }

    const material = gltf.materials?.[0];
    const pbr = material?.pbrMetallicRoughness;

    return {
        vertexCount: posAccessor.count,
        indexCount: indexAccessor ? indexAccessor.count : 0,
        positions,
        normals,
        colors,
        materialName: material?.name,
        metallicFactor: pbr?.metallicFactor,
        roughnessFactor: pbr?.roughnessFactor,
        emissiveFactor: material?.emissiveFactor
    };
}

import {
    StyleConformalQualityEvaluator,
    StyleConformalMetricReport,
    StyleQualityEvaluationOptions,
    Target3DStyle
} from './style-conformal-quality-evaluator';

export {
    StyleConformalQualityEvaluator,
    StyleConformalMetricReport,
    StyleQualityEvaluationOptions,
    Target3DStyle
};

/**
 * Photorealism Evaluator: Grades procedural 3D models against physical optical and geometric criteria.
 * Now powered by StyleConformalQualityEvaluator targeting 'photoreal' style.
 */
export class PhotorealismEvaluator {
    private readonly styleEvaluator = new StyleConformalQualityEvaluator();

    /**
     * Evaluates a generated 3D asset from its binary GLB container.
     */
    public evaluateGlb(
        exerciseName: string,
        glbBytes: Uint8Array,
        options?: StyleQualityEvaluationOptions
    ): PhotorealismMetricReport {
        return this.styleEvaluator.evaluateGlb(exerciseName, glbBytes, {
            targetStyle: 'photoreal',
            ...options
        });
    }
}

