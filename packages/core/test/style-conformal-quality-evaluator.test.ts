/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import { StyleConformalQualityEvaluator } from '../src/node/3d-engine/style-conformal-quality-evaluator';
import { rasterizeGlbToTestScreenshot } from './helpers/test-screenshot-helper';

/**
 * Helper to build a valid minimal binary GLB buffer in memory for testing.
 */
function createTestGlb(options: {
    positions: number[];
    normals: number[];
    colors?: number[];
    indices?: number[];
    metallic?: number;
    roughness?: number;
    materialName?: string;
}): Uint8Array {
    const posArray = new Float32Array(options.positions);
    const normArray = new Float32Array(options.normals);
    const colorArray = options.colors ? new Float32Array(options.colors) : undefined;
    const indexArray = options.indices ? new Uint16Array(options.indices) : undefined;

    const posBytes = new Uint8Array(posArray.buffer);
    const normBytes = new Uint8Array(normArray.buffer);
    const colorBytes = colorArray ? new Uint8Array(colorArray.buffer) : new Uint8Array(0);
    const indexBytes = indexArray ? new Uint8Array(indexArray.buffer) : new Uint8Array(0);

    // Align each buffer view or chunk to 4-byte boundary
    function padTo4(bytes: Uint8Array, padByte = 0): Uint8Array {
        const remainder = bytes.byteLength % 4;
        if (remainder === 0) return bytes;
        const padded = new Uint8Array(bytes.byteLength + (4 - remainder));
        padded.set(bytes);
        if (padByte !== 0) {
            for (let i = bytes.byteLength; i < padded.byteLength; i++) {
                padded[i] = padByte;
            }
        }
        return padded;
    }

    const paddedPos = padTo4(posBytes);
    const paddedNorm = padTo4(normBytes);
    const paddedColor = colorArray ? padTo4(colorBytes) : new Uint8Array(0);
    const paddedIndex = indexArray ? padTo4(indexBytes) : new Uint8Array(0);

    const totalBinLength = paddedPos.byteLength + paddedNorm.byteLength + paddedColor.byteLength + paddedIndex.byteLength;
    const binBuffer = new Uint8Array(totalBinLength);

    let offset = 0;
    binBuffer.set(paddedPos, offset);
    const posViewOffset = offset;
    offset += paddedPos.byteLength;

    binBuffer.set(paddedNorm, offset);
    const normViewOffset = offset;
    offset += paddedNorm.byteLength;

    let colorViewOffset = 0;
    if (colorArray) {
        binBuffer.set(paddedColor, offset);
        colorViewOffset = offset;
        offset += paddedColor.byteLength;
    }

    let indexViewOffset = 0;
    if (indexArray) {
        binBuffer.set(paddedIndex, offset);
        indexViewOffset = offset;
        offset += paddedIndex.byteLength;
    }

    const bufferViews: any[] = [
        { buffer: 0, byteOffset: posViewOffset, byteLength: posBytes.byteLength },
        { buffer: 0, byteOffset: normViewOffset, byteLength: normBytes.byteLength }
    ];

    const accessors: any[] = [
        { bufferView: 0, componentType: 5126, count: posArray.length / 3, type: 'VEC3' },
        { bufferView: 1, componentType: 5126, count: normArray.length / 3, type: 'VEC3' }
    ];

    const attributes: Record<string, number> = {
        POSITION: 0,
        NORMAL: 1
    };

    if (colorArray) {
        bufferViews.push({ buffer: 0, byteOffset: colorViewOffset, byteLength: colorBytes.byteLength });
        accessors.push({ bufferView: bufferViews.length - 1, componentType: 5126, count: colorArray.length / 4, type: 'VEC4' });
        attributes.COLOR_0 = accessors.length - 1;
    }

    let indicesAccessorIndex: number | undefined;
    if (indexArray) {
        bufferViews.push({ buffer: 0, byteOffset: indexViewOffset, byteLength: indexBytes.byteLength });
        accessors.push({ bufferView: bufferViews.length - 1, componentType: 5123, count: indexArray.length, type: 'SCALAR' });
        indicesAccessorIndex = accessors.length - 1;
    }

    const gltfJson = {
        asset: { version: '2.0', generator: 'Scratchbox-Test' },
        buffers: [{ byteLength: totalBinLength }],
        bufferViews,
        accessors,
        materials: [
            {
                name: options.materialName || 'DefaultMaterial',
                pbrMetallicRoughness: {
                    metallicFactor: options.metallic ?? 0.0,
                    roughnessFactor: options.roughness ?? 0.8
                }
            }
        ],
        meshes: [
            {
                primitives: [
                    {
                        attributes,
                        indices: indicesAccessorIndex,
                        material: 0
                    }
                ]
            }
        ],
        nodes: [{ mesh: 0 }],
        scenes: [{ nodes: [0] }],
        scene: 0
    };

    const jsonText = JSON.stringify(gltfJson);
    const jsonBytes = new TextEncoder().encode(jsonText);
    const paddedJsonBytes = padTo4(jsonBytes, 0x20);

    const totalGlbLength = 12 + 8 + paddedJsonBytes.byteLength + 8 + binBuffer.byteLength;
    const glbBuffer = new Uint8Array(totalGlbLength);
    const view = new DataView(glbBuffer.buffer);

    // GLB Header
    view.setUint32(0, 0x46546C67, true); // 'glTF'
    view.setUint32(4, 2, true);          // Version 2
    view.setUint32(8, totalGlbLength, true);

    // JSON Chunk
    view.setUint32(12, paddedJsonBytes.byteLength, true);
    view.setUint32(16, 0x4E4F534A, true); // 'JSON'
    glbBuffer.set(paddedJsonBytes, 20);

    // BIN Chunk
    const binOffset = 20 + paddedJsonBytes.byteLength;
    view.setUint32(binOffset, binBuffer.byteLength, true);
    view.setUint32(binOffset + 4, 0x004E4942, true); // 'BIN\0'
    glbBuffer.set(binBuffer, binOffset + 8);

    return glbBuffer;
}

describe('StyleConformalQualityEvaluator (Universal Multi-Style 3D Quality Control)', () => {
    const evaluator = new StyleConformalQualityEvaluator();

    // Pyramid test geometry (5 vertices, grounded at Y=0)
    const validPositions = [
        -1.0, 0.0, -1.0,
         1.0, 0.0, -1.0,
         1.0, 0.0,  1.0,
        -1.0, 0.0,  1.0,
         0.0, 1.5,  0.0
    ];

    const validNormals = [
        -0.577, 0.577, -0.577,
         0.577, 0.577, -0.577,
         0.577, 0.577,  0.577,
        -0.577, 0.577,  0.577,
         0.0,   1.0,    0.0
    ];

    const validColors = [
        0.8, 0.3, 0.2, 1.0,
        0.8, 0.3, 0.2, 1.0,
        0.8, 0.3, 0.2, 1.0,
        0.8, 0.3, 0.2, 1.0,
        0.9, 0.4, 0.2, 1.0
    ];

    const validIndices = [
        0, 1, 4,
        1, 2, 4,
        2, 3, 4,
        3, 0, 4,
        0, 3, 2,
        2, 1, 0
    ];

    it('validates Layer A invariant checks on sound geometry', () => {
        const glb = createTestGlb({
            positions: validPositions,
            normals: validNormals,
            colors: validColors,
            indices: validIndices,
            metallic: 0.1,
            roughness: 0.75
        });

        const report = evaluator.evaluateGlb('pyramid-asset', glb, { targetStyle: 'low-poly' });

        expect(report.invariantChecks.passed).toBe(true);
        expect(report.invariantChecks.noNaNOrInf).toBe(true);
        expect(report.invariantChecks.nonZeroVolume).toBe(true);
        expect(report.invariantChecks.validUnitNormals).toBe(true);
        expect(report.invariantChecks.consistentWinding).toBe(true);
        expect(report.boundingDimensions.x).toBeCloseTo(2.0, 1);
        expect(report.boundingDimensions.y).toBeCloseTo(1.5, 1);

        // Mandatory Visual Proof: Screenshot test result
        const shotPath = rasterizeGlbToTestScreenshot('style_conformal_sound_pyramid', glb);
        expect(fs.existsSync(shotPath)).toBe(true);
        expect(fs.statSync(shotPath).size).toBeGreaterThan(0);
    });

    it('rewards low-poly styling and does NOT penalize small vertex count', () => {
        const glb = createTestGlb({
            positions: validPositions,
            normals: validNormals,
            colors: validColors,
            indices: validIndices,
            metallic: 0.05,
            roughness: 0.85
        });

        const lowPolyReport = evaluator.evaluateGlb('low-poly-tree', glb, {
            targetStyle: 'low-poly',
            maxVerticesBudget: 2500
        });

        expect(lowPolyReport.targetStyle).toBe('low-poly');
        expect(lowPolyReport.styleAudit.conformsToBudget).toBe(true);
        expect(lowPolyReport.styleAudit.conformsToMaterial).toBe(true);
        expect(lowPolyReport.densityScore).toBe(25); // Rewarded for low vertex count!
        expect(lowPolyReport.passed).toBe(true);

        // Mandatory Visual Proof: Screenshot test result
        const shotPath = rasterizeGlbToTestScreenshot('style_conformal_low_poly_tree', glb);
        expect(fs.existsSync(shotPath)).toBe(true);
        expect(fs.statSync(shotPath).size).toBeGreaterThan(0);
    });

    it('evaluates anime / cel-shaded aesthetic criteria', () => {
        const glb = createTestGlb({
            positions: validPositions,
            normals: validNormals,
            colors: validColors,
            indices: validIndices,
            metallic: 0.0,
            roughness: 0.95
        });

        const celReport = evaluator.evaluateGlb('anime-character-prop', glb, {
            targetStyle: 'cel-shaded'
        });

        expect(celReport.targetStyle).toBe('cel-shaded');
        expect(celReport.styleAudit.conformsToMaterial).toBe(true);
        expect(celReport.pbrMaterialScore).toBe(25);
        expect(celReport.passed).toBe(true);

        // Mandatory Visual Proof: Screenshot test result
        const shotPath = rasterizeGlbToTestScreenshot('style_conformal_cel_shaded_prop', glb);
        expect(fs.existsSync(shotPath)).toBe(true);
        expect(fs.statSync(shotPath).size).toBeGreaterThan(0);
    });

    it('evaluates clay-miniature style with high diffuse roughness requirement', () => {
        const glb = createTestGlb({
            positions: validPositions,
            normals: validNormals,
            colors: validColors,
            indices: validIndices,
            metallic: 0.02,
            roughness: 0.88
        });

        const clayReport = evaluator.evaluateGlb('clay-pot', glb, {
            targetStyle: 'clay-miniature'
        });

        expect(clayReport.targetStyle).toBe('clay-miniature');
        expect(clayReport.styleAudit.conformsToMaterial).toBe(true);
        expect(clayReport.pbrMaterialScore).toBe(25);

        // Mandatory Visual Proof: Screenshot test result
        const shotPath = rasterizeGlbToTestScreenshot('style_conformal_clay_pot', glb);
        expect(fs.existsSync(shotPath)).toBe(true);
        expect(fs.statSync(shotPath).size).toBeGreaterThan(0);
    });

    it('catches and flags corrupted geometry containing NaN coordinates', () => {
        const corruptPositions = [...validPositions];
        corruptPositions[0] = NaN;

        const glb = createTestGlb({
            positions: corruptPositions,
            normals: validNormals,
            indices: validIndices
        });

        const report = evaluator.evaluateGlb('corrupt-asset', glb);

        expect(report.invariantChecks.passed).toBe(false);
        expect(report.invariantChecks.noNaNOrInf).toBe(false);
        expect(report.passed).toBe(false);
        expect(report.diagnostics.some(d => d.includes('NaN'))).toBe(true);

        // Mandatory Visual Proof: Screenshot test result (verifies safe rasterization even with NaN)
        const shotPath = rasterizeGlbToTestScreenshot('style_conformal_corrupt_asset', glb);
        expect(fs.existsSync(shotPath)).toBe(true);
        expect(fs.statSync(shotPath).size).toBeGreaterThan(0);
    });
});
