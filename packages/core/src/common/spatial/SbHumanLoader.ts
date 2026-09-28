/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { CanonicalShapeBetas } from '../character-morph-protocol';

export interface SbHumanHeader {
    magic: number;
    version: number;
    numVertices: number;
    numIndices: number;
    numJoints: number;
    numShapeModes: number;
    numExpressionModes: number;
    numPoseCorrectives: number;
    numRegressorEntries: number;
    flags: number;
}

export interface SbHumanJoint {
    id: number;
    name: string;
    parent: number;
    pos: [number, number, number];
}

export interface SbHumanSkinWeight {
    joints: [number, number, number, number];
    weights: [number, number, number, number];
}

export interface SampledHumanoidSurface {
    count: number;
    positions: Float32Array;
    normals: Float32Array;
    uvs: Float32Array;
    boneIndices: Uint8Array;
    boneWeights: Float32Array;
    totalSurfaceArea: number;
}

export class SbHumanLoader {
    public header!: SbHumanHeader;
    public basePositions!: Float32Array; // [numVertices * 3]
    public baseNormals!: Float32Array;   // [numVertices * 3]
    public baseUvs!: Float32Array;       // [numVertices * 2]
    public indices!: Uint32Array;        // [numIndices]
    public joints: SbHumanJoint[] = [];
    public skinWeights: SbHumanSkinWeight[] = [];
    public shapeDirs!: Float32Array;     // [numShapeModes * numVertices * 3]

    /**
     * Parses .sbhuman (v2) binary container from an ArrayBuffer or Node Buffer.
     */
    public static parse(data: ArrayBuffer | Uint8Array): SbHumanLoader {
        const loader = new SbHumanLoader();
        loader.load(data);
        return loader;
    }

    public load(data: ArrayBuffer | Uint8Array): void {
        const buffer = data instanceof Uint8Array ? data.buffer : data;
        const byteOffset = data instanceof Uint8Array ? data.byteOffset : 0;
        const byteLength = data instanceof Uint8Array ? data.byteLength : data.byteLength;
        const view = new DataView(buffer, byteOffset, byteLength);

        let offset = 0;

        // 1. Header (40 bytes)
        const magic = view.getUint32(offset, true); offset += 4;
        const version = view.getUint32(offset, true); offset += 4;
        if (magic !== 0x4E4D4853) {
            throw new Error(`Invalid .sbhuman magic: 0x${magic.toString(16)}. Expected 0x4E4D4853 ('SBHM')`);
        }
        if (version !== 2) {
            throw new Error(`Unsupported .sbhuman version: ${version}. Expected version 2`);
        }

        const numVertices = view.getUint32(offset, true); offset += 4;
        const numIndices = view.getUint32(offset, true); offset += 4;
        const numJoints = view.getUint32(offset, true); offset += 4;
        const numShapeModes = view.getUint32(offset, true); offset += 4;
        const numExpressionModes = view.getUint32(offset, true); offset += 4;
        const numPoseCorrectives = view.getUint32(offset, true); offset += 4;
        const numRegressorEntries = view.getUint32(offset, true); offset += 4;
        const flags = view.getUint32(offset, true); offset += 4;

        this.header = {
            magic,
            version,
            numVertices,
            numIndices,
            numJoints,
            numShapeModes,
            numExpressionModes,
            numPoseCorrectives,
            numRegressorEntries,
            flags
        };

        // 2. Vertices (40-byte stride: 16 bytes pos [Vec3 alignas(16)], 16 bytes norm [Vec3 alignas(16)], 8 bytes uv [Vec2])
        this.basePositions = new Float32Array(numVertices * 3);
        this.baseNormals = new Float32Array(numVertices * 3);
        this.baseUvs = new Float32Array(numVertices * 2);

        for (let i = 0; i < numVertices; i++) {
            const vBase = i * 3;
            const uvBase = i * 2;

            // Position (3 floats + 1 float pad)
            this.basePositions[vBase]     = view.getFloat32(offset, true);
            this.basePositions[vBase + 1] = view.getFloat32(offset + 4, true);
            this.basePositions[vBase + 2] = view.getFloat32(offset + 8, true);
            offset += 16;

            // Normal (3 floats + 1 float pad)
            this.baseNormals[vBase]     = view.getFloat32(offset, true);
            this.baseNormals[vBase + 1] = view.getFloat32(offset + 4, true);
            this.baseNormals[vBase + 2] = view.getFloat32(offset + 8, true);
            offset += 16;

            // UV (2 floats)
            this.baseUvs[uvBase]     = view.getFloat32(offset, true);
            this.baseUvs[uvBase + 1] = view.getFloat32(offset + 4, true);
            offset += 8;
        }

        // 3. Indices (numIndices * 4 bytes)
        this.indices = new Uint32Array(numIndices);
        for (let i = 0; i < numIndices; i++) {
            this.indices[i] = view.getUint32(offset, true);
            offset += 4;
        }

        // 4. Joints (numJoints entries)
        this.joints = [];
        const decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;
        for (let j = 0; j < numJoints; j++) {
            const nameLen = view.getUint32(offset, true); offset += 4;
            let name: string;
            if (decoder) {
                const nameBytes = new Uint8Array(buffer, byteOffset + offset, nameLen);
                name = decoder.decode(nameBytes);
            } else {
                let s = '';
                for (let k = 0; k < nameLen; k++) {
                    s += String.fromCharCode(view.getUint8(offset + k));
                }
                name = s;
            }
            offset += nameLen;

            const parent = view.getInt32(offset, true); offset += 4;
            const jx = view.getFloat32(offset, true);
            const jy = view.getFloat32(offset + 4, true);
            const jz = view.getFloat32(offset + 8, true);
            offset += 16; // alignas(16) Vec3 stride

            this.joints.push({ id: j, name, parent, pos: [jx, jy, jz] });
        }

        // 5. Skin Weights (numVertices * 24 bytes: 4 uint16 = 8 bytes, 4 float32 = 16 bytes)
        this.skinWeights = [];
        for (let i = 0; i < numVertices; i++) {
            const j0 = view.getUint16(offset, true);
            const j1 = view.getUint16(offset + 2, true);
            const j2 = view.getUint16(offset + 4, true);
            const j3 = view.getUint16(offset + 6, true);
            offset += 8;

            const w0 = view.getFloat32(offset, true);
            const w1 = view.getFloat32(offset + 4, true);
            const w2 = view.getFloat32(offset + 8, true);
            const w3 = view.getFloat32(offset + 12, true);
            offset += 16;

            this.skinWeights.push({
                joints: [j0, j1, j2, j3],
                weights: [w0, w1, w2, w3]
            });
        }

        // 6. Shape PCA Directions (numShapeModes * numVertices * 3 floats)
        const totalShapeFloats = numShapeModes * numVertices * 3;
        this.shapeDirs = new Float32Array(totalShapeFloats);
        for (let k = 0; k < totalShapeFloats; k++) {
            this.shapeDirs[k] = view.getFloat32(offset, true);
            offset += 4;
        }
    }

    /**
     * Evaluates deformed mesh vertices using 8-mode PCA blendshapes:
     *   v'_i = v_i + sum_m (beta_m * S_{m, i})
     */
    public evaluatePosed(betas: number[] | CanonicalShapeBetas): {
        positions: Float32Array;
        normals: Float32Array;
    } {
        const numVerts = this.header.numVertices;
        const numModes = Math.min(this.header.numShapeModes, betas.length);
        const positions = new Float32Array(numVerts * 3);
        positions.set(this.basePositions);

        const normals = new Float32Array(numVerts * 3);
        normals.set(this.baseNormals);

        for (let m = 0; m < numModes; m++) {
            const beta = betas[m];
            if (Math.abs(beta) < 1e-5) continue;

            const modeOffset = m * numVerts * 3;
            for (let i = 0; i < numVerts * 3; i++) {
                positions[i] += beta * this.shapeDirs[modeOffset + i];
            }
        }

        return { positions, normals };
    }

    /**
     * Computes surface area for all 20,908 triangles and total surface area.
     */
    public computeTriangleAreas(positions: Float32Array): {
        triAreas: Float64Array;
        totalArea: number;
    } {
        const numTris = this.indices.length / 3;
        const triAreas = new Float64Array(numTris);
        let totalArea = 0;

        for (let t = 0; t < numTris; t++) {
            const i0 = this.indices[t * 3] * 3;
            const i1 = this.indices[t * 3 + 1] * 3;
            const i2 = this.indices[t * 3 + 2] * 3;

            const v0x = positions[i0],     v0y = positions[i0 + 1],     v0z = positions[i0 + 2];
            const v1x = positions[i1],     v1y = positions[i1 + 1],     v1z = positions[i1 + 2];
            const v2x = positions[i2],     v2y = positions[i2 + 1],     v2z = positions[i2 + 2];

            const e1x = v1x - v0x, e1y = v1y - v0y, e1z = v1z - v0z;
            const e2x = v2x - v0x, e2y = v2y - v0y, e2z = v2z - v0z;

            const cx = e1y * e2z - e1z * e2y;
            const cy = e1z * e2x - e1x * e2z;
            const cz = e1x * e2y - e1y * e2x;

            const area = 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
            triAreas[t] = area;
            totalArea += area;
        }

        return { triAreas, totalArea };
    }

    /**
     * Uniformly samples N dense points across the authentic shaped human mesh surface
     * using area-weighted cumulative distribution and barycentric interpolation.
     *
     * Every sampled point inherits exact anatomical coordinates, smooth normal vectors,
     * and blended 4-bone partition-of-unity skin weights (sum w_k = 1.000).
     */
    public sampleUniformSurface(
        numPoints: number,
        betas: number[] | CanonicalShapeBetas,
        seed: number = 42
    ): SampledHumanoidSurface {
        const { positions, normals } = this.evaluatePosed(betas);
        const { triAreas, totalArea } = this.computeTriangleAreas(positions);
        const numTris = this.indices.length / 3;

        // Cumulative distribution of triangle areas
        const cdf = new Float64Array(numTris);
        let runningSum = 0;
        for (let t = 0; t < numTris; t++) {
            runningSum += triAreas[t];
            cdf[t] = runningSum / totalArea;
        }

        const outPositions = new Float32Array(numPoints * 3);
        const outNormals = new Float32Array(numPoints * 3);
        const outUvs = new Float32Array(numPoints * 2);
        const outBoneIndices = new Uint8Array(numPoints * 4);
        const outBoneWeights = new Float32Array(numPoints * 4);

        // Deterministic pseudo-random number generator
        let s = seed;
        const rnd = () => {
            s = (s * 16807) % 2147483647;
            return (s - 1) / 2147483646;
        };

        for (let i = 0; i < numPoints; i++) {
            // 1. Pick triangle by area CDF via binary search
            const rTri = rnd();
            let low = 0, high = numTris - 1;
            while (low < high) {
                const mid = (low + high) >> 1;
                if (cdf[mid] < rTri) low = mid + 1;
                else high = mid;
            }
            const triIdx = low;

            const v0Idx = this.indices[triIdx * 3];
            const v1Idx = this.indices[triIdx * 3 + 1];
            const v2Idx = this.indices[triIdx * 3 + 2];

            // 2. Uniform barycentric coordinates inside triangle
            const r1 = rnd();
            const r2 = rnd();
            const sqrtR1 = Math.sqrt(r1);
            const u = 1 - sqrtR1;
            const v = r2 * sqrtR1;
            const w = 1 - u - v;

            // 3. Interpolate Position
            const p0x = positions[v0Idx * 3],     p0y = positions[v0Idx * 3 + 1],     p0z = positions[v0Idx * 3 + 2];
            const p1x = positions[v1Idx * 3],     p1y = positions[v1Idx * 3 + 1],     p1z = positions[v1Idx * 3 + 2];
            const p2x = positions[v2Idx * 3],     p2y = positions[v2Idx * 3 + 1],     p2z = positions[v2Idx * 3 + 2];

            const px = u * p0x + v * p1x + w * p2x;
            const py = u * p0y + v * p1y + w * p2y;
            const pz = u * p0z + v * p1z + w * p2z;

            outPositions[i * 3]     = px;
            outPositions[i * 3 + 1] = py;
            outPositions[i * 3 + 2] = pz;

            // 4. Interpolate Normal
            const n0x = normals[v0Idx * 3],     n0y = normals[v0Idx * 3 + 1],     n0z = normals[v0Idx * 3 + 2];
            const n1x = normals[v1Idx * 3],     n1y = normals[v1Idx * 3 + 1],     n1z = normals[v1Idx * 3 + 2];
            const n2x = normals[v2Idx * 3],     n2y = normals[v2Idx * 3 + 1],     n2z = normals[v2Idx * 3 + 2];

            let nx = u * n0x + v * n1x + w * n2x;
            let ny = u * n0y + v * n1y + w * n2y;
            let nz = u * n0z + v * n1z + w * n2z;
            const nLen = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1.0;
            nx /= nLen; ny /= nLen; nz /= nLen;

            outNormals[i * 3]     = nx;
            outNormals[i * 3 + 1] = ny;
            outNormals[i * 3 + 2] = nz;

            // 5. Interpolate UV
            const uv0u = this.baseUvs[v0Idx * 2], uv0v = this.baseUvs[v0Idx * 2 + 1];
            const uv1u = this.baseUvs[v1Idx * 2], uv1v = this.baseUvs[v1Idx * 2 + 1];
            const uv2u = this.baseUvs[v2Idx * 2], uv2v = this.baseUvs[v2Idx * 2 + 1];

            outUvs[i * 2]     = u * uv0u + v * uv1u + w * uv2u;
            outUvs[i * 2 + 1] = u * uv0v + v * uv1v + w * uv2v;

            // 6. Blend 4-Bone Partition-of-Unity Skinning Weights
            const sw0 = this.skinWeights[v0Idx];
            const sw1 = this.skinWeights[v1Idx];
            const sw2 = this.skinWeights[v2Idx];

            // Accumulate weights across all candidate bones
            const jointMap = new Map<number, number>();
            for (let k = 0; k < 4; k++) {
                if (sw0.weights[k] > 0) {
                    jointMap.set(sw0.joints[k], (jointMap.get(sw0.joints[k]) || 0) + u * sw0.weights[k]);
                }
                if (sw1.weights[k] > 0) {
                    jointMap.set(sw1.joints[k], (jointMap.get(sw1.joints[k]) || 0) + v * sw1.weights[k]);
                }
                if (sw2.weights[k] > 0) {
                    jointMap.set(sw2.joints[k], (jointMap.get(sw2.joints[k]) || 0) + w * sw2.weights[k]);
                }
            }

            // Select top 4 bone influences
            const sortedBones = Array.from(jointMap.entries()).sort((a, b) => b[1] - a[1]);
            let wSum = 0;
            for (let k = 0; k < 4; k++) {
                if (k < sortedBones.length) {
                    outBoneIndices[i * 4 + k] = sortedBones[k][0];
                    outBoneWeights[i * 4 + k] = sortedBones[k][1];
                    wSum += sortedBones[k][1];
                } else {
                    outBoneIndices[i * 4 + k] = 0;
                    outBoneWeights[i * 4 + k] = 0;
                }
            }

            // Enforce strict partition-of-unity (sum w_k = 1.000)
            if (wSum > 1e-6) {
                const invW = 1.0 / wSum;
                for (let k = 0; k < 4; k++) {
                    outBoneWeights[i * 4 + k] *= invW;
                }
            } else {
                outBoneWeights[i * 4] = 1.0;
            }
        }

        return {
            count: numPoints,
            positions: outPositions,
            normals: outNormals,
            uvs: outUvs,
            boneIndices: outBoneIndices,
            boneWeights: outBoneWeights,
            totalSurfaceArea: totalArea
        };
    }
}
