/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
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
    const gltf = JSON.parse(jsonText.trim());

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

/**
 * Photorealism Evaluator: Grades procedural 3D models against physical optical and geometric criteria.
 */
export class PhotorealismEvaluator {
    /**
     * Evaluates a generated 3D asset from its binary GLB container.
     */
    public evaluateGlb(exerciseName: string, glbBytes: Uint8Array): PhotorealismMetricReport {
        const data = inspectGlbBuffer(glbBytes);
        const diagnostics: string[] = [];

        // 1. Geometric Density & Tessellation Resolution (0 - 25)
        // High fidelity procedural models require adequate density to avoid low-poly faceting.
        let densityScore = 0;
        const vCount = data.vertexCount;
        const tCount = data.indexCount / 3;

        if (vCount >= 5000) {
            densityScore = 25;
            diagnostics.push(`High polygon density: ${vCount.toLocaleString()} vertices, ${tCount.toLocaleString()} triangles`);
        } else if (vCount >= 2000) {
            densityScore = 22;
            diagnostics.push(`Good polygon density: ${vCount.toLocaleString()} vertices`);
        } else if (vCount >= 1000) {
            densityScore = 18;
            diagnostics.push(`Moderate polygon density: ${vCount.toLocaleString()} vertices`);
        } else {
            densityScore = Math.max(5, Math.floor((vCount / 1000) * 15));
            diagnostics.push(`Low polygon density: only ${vCount} vertices`);
        }

        // 2. Normal Smoothness & Curvature Continuity (0 - 25)
        // Checks that normals are normalized, continuous, and have spatial variance.
        let normalScore = 0;
        let validNormals = 0;
        let totalNormalVar = 0;
        const normalCount = data.normals.length / 3;

        for (let i = 0; i < normalCount; i++) {
            const nx = data.normals[i * 3];
            const ny = data.normals[i * 3 + 1];
            const nz = data.normals[i * 3 + 2];
            const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
            if (len >= 0.95 && len <= 1.05) {
                validNormals++;
            }
            if (i > 0) {
                const pnx = data.normals[(i - 1) * 3];
                const pny = data.normals[(i - 1) * 3 + 1];
                const pnz = data.normals[(i - 1) * 3 + 2];
                totalNormalVar += Math.abs(nx - pnx) + Math.abs(ny - pny) + Math.abs(nz - pnz);
            }
        }

        const validNormalRatio = normalCount > 0 ? validNormals / normalCount : 0;
        const avgNormalVar = normalCount > 1 ? totalNormalVar / (normalCount - 1) : 0;

        if (validNormalRatio > 0.98 && avgNormalVar > 0.01) {
            normalScore = 25;
            diagnostics.push(`Normals: ${Math.round(validNormalRatio * 100)}% valid unit vectors, smooth continuous curvature`);
        } else if (validNormalRatio > 0.9) {
            normalScore = 20;
            diagnostics.push('Normals: Mostly valid with moderate curvature');
        } else {
            normalScore = 10;
            diagnostics.push('Normals: Defective or degenerate normal vectors detected');
        }

        // 3. Ambient Occlusion & Procedural Weathering Variation (0 - 25)
        // Realistic surfaces are never completely flat in color; they exhibit crevice occlusion & weathering.
        let aoScore = 0;
        if (data.colors && data.colors.length > 0) {
            const colorCount = data.colors.length / 4;
            let sumLuminance = 0;
            let minLuminance = 1.0;
            let maxLuminance = 0.0;

            for (let i = 0; i < colorCount; i++) {
                const r = data.colors[i * 4];
                const g = data.colors[i * 4 + 1];
                const b = data.colors[i * 4 + 2];
                const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
                sumLuminance += lum;
                minLuminance = Math.min(minLuminance, lum);
                maxLuminance = Math.max(maxLuminance, lum);
            }

            const avgLuminance = sumLuminance / colorCount;
            let varSum = 0;
            for (let i = 0; i < colorCount; i++) {
                const r = data.colors[i * 4];
                const g = data.colors[i * 4 + 1];
                const b = data.colors[i * 4 + 2];
                const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
                varSum += (lum - avgLuminance) * (lum - avgLuminance);
            }
            const stdDev = Math.sqrt(varSum / colorCount);

            if (stdDev >= 0.04 && minLuminance < 0.85) {
                aoScore = 25;
                diagnostics.push(`AO & Shading: High dynamic crevice contrast (min: ${minLuminance.toFixed(2)}, stdDev: ${stdDev.toFixed(3)})`);
            } else if (stdDev > 0.01) {
                aoScore = 21;
                diagnostics.push(`AO & Shading: Subtle surface variations present (stdDev: ${stdDev.toFixed(3)})`);
            } else {
                aoScore = 15;
                diagnostics.push('AO & Shading: Uniform vertex coloring without pronounced crevice occlusion');
            }
        } else {
            aoScore = 10;
            diagnostics.push('AO & Shading: No vertex color/AO channel present in container');
        }

        // 4. Physical PBR Material Definition (0 - 25)
        let pbrScore = 0;
        const metallic = data.metallicFactor ?? 0.5;
        const roughness = data.roughnessFactor ?? 0.5;
        const hasEmissive = !!(data.emissiveFactor && (data.emissiveFactor[0] > 0 || data.emissiveFactor[1] > 0 || data.emissiveFactor[2] > 0));

        // Physically plausible roughness is rarely exactly 0.0 or 1.0 (micro-facets)
        const roughnessPlausible = roughness >= 0.04 && roughness <= 0.95;
        const metallicPlausible = metallic >= 0.0 && metallic <= 1.0;

        if (roughnessPlausible && metallicPlausible) {
            pbrScore = 25;
            diagnostics.push(`PBR Material: Physically accurate parameters (metallic: ${metallic.toFixed(2)}, roughness: ${roughness.toFixed(2)})`);
        } else {
            pbrScore = 15;
            diagnostics.push(`PBR Material: Non-standard parameters (metallic: ${metallic}, roughness: ${roughness})`);
        }

        // Calculate bounding box dimensions
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (let i = 0; i < data.positions.length; i += 3) {
            const x = data.positions[i];
            const y = data.positions[i + 1];
            const z = data.positions[i + 2];
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            minZ = Math.min(minZ, z);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
            maxZ = Math.max(maxZ, z);
        }

        const totalScore = densityScore + normalScore + aoScore + pbrScore;
        const isPhotorealistic = totalScore >= 90;

        return {
            exerciseName,
            vertexCount: vCount,
            triangleCount: tCount,
            densityScore,
            normalSmoothnessScore: normalScore,
            aoWeatheringScore: aoScore,
            pbrMaterialScore: pbrScore,
            totalScore,
            isPhotorealistic,
            diagnostics,
            materialSummary: {
                name: data.materialName || 'PBR',
                metallic,
                roughness,
                hasVertexColors: !!(data.colors && data.colors.length > 0),
                hasEmissive
            },
            boundingDimensions: {
                x: maxX - minX,
                y: maxY - minY,
                z: maxZ - minZ
            }
        };
    }
}
