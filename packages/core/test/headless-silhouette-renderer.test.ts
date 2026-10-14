/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import { HeadlessMeshSilhouetteRenderer } from '../src/node/spatial/HeadlessMeshSilhouetteRenderer';
import {
    SubPixelEdgeAlignmentOptimizer,
    evaluateEdgeOverlap,
    type CameraPose6DOF
} from '../src/node/spatial/SubPixelEdgeAlignmentOptimizer';

describe('HeadlessMeshSilhouetteRenderer & Closed-Loop Optimizer', () => {
    // Create a 3D building proxy (10m x 20m x 15m) centered at [0, 10, 0]
    const buildingMesh = HeadlessMeshSilhouetteRenderer.createBoxMesh([0, 10, 0], [10, 20, 15]);

    const groundTruthPose: CameraPose6DOF = {
        x: 0,
        y: 10,
        z: -40,
        targetX: 0,
        targetY: 10,
        targetZ: 0,
        fov: 45
    };

    it('renders a 3D mesh into depth and silhouette buffers', () => {
        const render = HeadlessMeshSilhouetteRenderer.renderMesh(buildingMesh, groundTruthPose, 160, 120);

        expect(render.width).toBe(160);
        expect(render.height).toBe(120);

        // Count silhouette pixels
        let foregroundPixels = 0;
        for (let i = 0; i < render.silhouetteBuffer.length; i++) {
            if (render.silhouetteBuffer[i] > 0) {
                foregroundPixels++;
                // Depth must be ~40 meters
                expect(render.depthBuffer[i]).toBeGreaterThan(25.0);
                expect(render.depthBuffer[i]).toBeLessThan(55.0);
            }
        }

        expect(foregroundPixels).toBeGreaterThan(500);
    });

    it('computes edge field and evaluates 100% overlap on identical pose', () => {
        const field1 = HeadlessMeshSilhouetteRenderer.renderEdgeField(buildingMesh, groundTruthPose, 160, 120);
        const field2 = HeadlessMeshSilhouetteRenderer.renderEdgeField(buildingMesh, groundTruthPose, 160, 120);

        expect(field1.meanMagnitude).toBeGreaterThan(0.5);

        const evalResult = evaluateEdgeOverlap(field1, field2);
        expect(evalResult.overlapScorePercent).toBeCloseTo(100.0, 1);
        expect(evalResult.residualPx).toBeLessThan(0.05);
    });

    it('optimizes a perturbed camera pose towards ground-truth in a closed loop', () => {
        // Render target image (ground truth)
        const targetField = HeadlessMeshSilhouetteRenderer.renderEdgeField(buildingMesh, groundTruthPose, 160, 120);

        // Perturbed camera pose (shifted in X, Y, and FOV)
        const perturbedPose: CameraPose6DOF = {
            x: 2.5,
            y: 11.5,
            z: -38.0,
            targetX: 0.5,
            targetY: 9.5,
            targetZ: 0.0,
            fov: 47.0
        };

        const initialField = HeadlessMeshSilhouetteRenderer.renderEdgeField(buildingMesh, perturbedPose, 160, 120);
        const initialEval = evaluateEdgeOverlap(targetField, initialField);

        // Closed-loop optimizer: dynamically renders at each coordinate perturbation
        const optimization = SubPixelEdgeAlignmentOptimizer.optimizePoseTo100Percent(
            perturbedPose,
            targetField,
            (pose) => HeadlessMeshSilhouetteRenderer.renderEdgeField(buildingMesh, pose, 160, 120),
            {
                maxIterations: 15,
                targetOverlapScore: 98.0,
                subpixelTolerancePx: 0.2
            }
        );
        // Verify optimizer significantly improved overlap score
        expect(optimization.overlapScorePercent).toBeGreaterThan(initialEval.overlapScorePercent);
        expect(optimization.subpixelResidualPx).toBeLessThan(initialEval.residualPx);

        // Camera position converged closer to ground truth
        expect(Math.abs(optimization.finalPose.x - groundTruthPose.x)).toBeLessThan(Math.abs(perturbedPose.x - groundTruthPose.x));
    });
});

describe('HeadlessMeshSilhouetteRenderer.loadMeshFromGlb reads every valid glTF index and vertex layout', () => {
    /** GLB with one buffer: prim A = quad with UNSIGNED_BYTE indices and interleaved POSITION+NORMAL (stride 24)
     *  at an odd-aligned BIN offset; prim B = triangle with UNSIGNED_SHORT indices and tightly packed positions. */
    function buildGlb(): Buffer {
        const parts: Buffer[] = [];
        let off = 0;
        const put = (b: Buffer, align = 4) => { const pad = (align - (off % align)) % align; if (pad) { parts.push(Buffer.alloc(pad)); off += pad; } const at = off; parts.push(b); off += b.length; return at; };
        const idxA = put(Buffer.from([0, 1, 2, 0, 2, 3]), 1);                       // 6 bytes; next view starts unaligned
        const inter = Buffer.alloc(4 * 24);
        [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]].forEach((p, i) => { p.forEach((c, k) => inter.writeFloatLE(c, i * 24 + k * 4)); inter.writeFloatLE(1, i * 24 + 20); });
        const posA = put(inter, 4);
        const idxB = put(Buffer.from(new Uint16Array([0, 1, 2]).buffer), 2);
        const posB = put(Buffer.from(new Float32Array([5, 5, 5, 6, 5, 5, 5, 6, 5]).buffer), 4);
        const bin = Buffer.concat(parts);
        const json = {
            asset: { version: '2.0' }, buffers: [{ byteLength: bin.length }],
            bufferViews: [
                { buffer: 0, byteOffset: idxA, byteLength: 6 },
                { buffer: 0, byteOffset: posA, byteLength: 96, byteStride: 24 },
                { buffer: 0, byteOffset: idxB, byteLength: 6 },
                { buffer: 0, byteOffset: posB, byteLength: 36 }
            ],
            accessors: [
                { bufferView: 0, componentType: 5121, count: 6, type: 'SCALAR' },
                { bufferView: 1, componentType: 5126, count: 4, type: 'VEC3' },
                { bufferView: 1, byteOffset: 12, componentType: 5126, count: 4, type: 'VEC3' },
                { bufferView: 2, componentType: 5123, count: 3, type: 'SCALAR' },
                { bufferView: 3, componentType: 5126, count: 3, type: 'VEC3' }
            ],
            meshes: [{ primitives: [{ attributes: { POSITION: 1, NORMAL: 2 }, indices: 0 }, { attributes: { POSITION: 4 }, indices: 3 }] }],
            nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0
        };
        let js = Buffer.from(JSON.stringify(json));
        js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
        const binPadded = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
        const header = Buffer.alloc(12); header.write('glTF', 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + js.length + 8 + binPadded.length, 8);
        const jh = Buffer.alloc(8); jh.writeUInt32LE(js.length, 0); jh.write('JSON', 4);
        const bh = Buffer.alloc(8); bh.writeUInt32LE(binPadded.length, 0); bh.write('BIN\0', 4);
        return Buffer.concat([header, jh, js, bh, binPadded]);
    }

    it('keeps UNSIGNED_BYTE primitives, honours byteStride and unaligned views, and offsets later primitives', () => {
        const mesh = HeadlessMeshSilhouetteRenderer.loadMeshFromGlb(buildGlb());
        expect(Array.from(mesh.indices)).toEqual([0, 1, 2, 0, 2, 3, 4, 5, 6]);
        expect(Array.from(mesh.vertices.slice(0, 12))).toEqual([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);  // not the interleaved normals
        expect(Array.from(mesh.vertices.slice(12))).toEqual([5, 5, 5, 6, 5, 5, 5, 6, 5]);
    });
});
