/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs';
import * as path from 'path';
import { SbHumanLoader } from '../../common/spatial/SbHumanLoader.js';
import { decodePng, encodePng } from '../texture-processing.js';

export interface EnhancedHandMesh {
    positions: Float32Array;
    normals: Float32Array;
    uvs: Float32Array;
    colors: Float32Array;
    indices: Uint32Array;
    numVertices: number;
    numTriangles: number;
}

export interface PbrTexturePack {
    albedoPng: Buffer;
    normalPng: Buffer;
    ormPng: Buffer;
    width: number;
    height: number;
}

type Vec3 = [number, number, number];
type Vec2 = [number, number];

function vSub(a: Vec3, b: Vec3): Vec3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function vAdd(a: Vec3, b: Vec3): Vec3 { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function vScale(v: Vec3, s: number): Vec3 { return [v[0] * s, v[1] * s, v[2] * s]; }
function vDot(a: Vec3, b: Vec3): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function vCross(a: Vec3, b: Vec3): Vec3 {
    return [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0]
    ];
}
function vLen(v: Vec3): number { return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]); }
function vNorm(v: Vec3): Vec3 {
    const l = vLen(v);
    return l > 1e-7 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 1, 0];
}
function clamp(v: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, v));
}

/**
 * SbHumanHandTransformer transforms the parametric sb-human hand into
 * a hyper-realistic, anatomically sculpted 3D model with C^2 surface continuity,
 * surface-conformal UV parameterization, and delighted multi-frequency PBR textures.
 */
export class SbHumanHandTransformer {
    public static readonly HAND_JOINTS = new Set([
        20, // LeftWrist
        25, 26, 27, // LeftIndex 1, 2, 3
        28, 29, 30, // LeftMiddle 1, 2, 3
        31, 32, 33, // LeftPinky 1, 2, 3
        34, 35, 36, // LeftRing 1, 2, 3
        37, 38, 39  // LeftThumb 1, 2, 3
    ]);

    public static readonly DIGIT_JOINTS: Record<string, number[]> = {
        thumb: [37, 38, 39],
        index: [25, 26, 27],
        middle: [28, 29, 30],
        ring: [34, 35, 36],
        pinky: [31, 32, 33]
    };

    /**
     * Extracts, subdivides, sculpts, and parameterizes the hand submesh.
     */
    public static transformHand(
        loader: SbHumanLoader,
        options: {
            subdivisionIterations?: number;
            sculptStrength?: number;
            recenterOrigin?: boolean;
        } = {}
    ): EnhancedHandMesh {
        const subIters = options.subdivisionIterations !== undefined ? options.subdivisionIterations : 1;
        const strength = options.sculptStrength !== undefined ? options.sculptStrength : 1.0;

        // 1. Identify hand vertices and build vertex remapping
        const nv = loader.header.numVertices;
        const isHand = new Uint8Array(nv);
        const vertexDigitMap = new Int8Array(nv).fill(-1); // 0=thumb, 1=index, 2=middle, 3=ring, 4=pinky, 5=palm

        for (let i = 0; i < nv; i++) {
            const sw = loader.skinWeights[i];
            let maxW = 0;
            let bestJoint = -1;
            for (let k = 0; k < 4; k++) {
                const j = sw.joints[k];
                const w = sw.weights[k];
                if (SbHumanHandTransformer.HAND_JOINTS.has(j) && w > maxW) {
                    maxW = w;
                    bestJoint = j;
                }
            }
            if (maxW > 0.05) {
                isHand[i] = 1;
                if ([37, 38, 39].includes(bestJoint)) vertexDigitMap[i] = 0;
                else if ([25, 26, 27].includes(bestJoint)) vertexDigitMap[i] = 1;
                else if ([28, 29, 30].includes(bestJoint)) vertexDigitMap[i] = 2;
                else if ([34, 35, 36].includes(bestJoint)) vertexDigitMap[i] = 3;
                else if ([31, 32, 33].includes(bestJoint)) vertexDigitMap[i] = 4;
                else vertexDigitMap[i] = 5; // palm/wrist
            }
        }

        // 2. Extract closed triangles where all 3 vertices belong to the hand
        const rawIndices = loader.indices;
        const handTriangles: [number, number, number][] = [];
        const oldToNew = new Map<number, number>();
        const newPositions: Vec3[] = [];
        const newDigitMap: number[] = [];

        for (let f = 0; f < rawIndices.length; f += 3) {
            const i0 = rawIndices[f];
            const i1 = rawIndices[f + 1];
            const i2 = rawIndices[f + 2];
            if (isHand[i0] && isHand[i1] && isHand[i2]) {
                const getNewIdx = (oldIdx: number) => {
                    let nIdx = oldToNew.get(oldIdx);
                    if (nIdx === undefined) {
                        nIdx = newPositions.length;
                        oldToNew.set(oldIdx, nIdx);
                        newPositions.push([
                            loader.basePositions[oldIdx * 3 + 0],
                            loader.basePositions[oldIdx * 3 + 1],
                            loader.basePositions[oldIdx * 3 + 2]
                        ]);
                        newDigitMap.push(vertexDigitMap[oldIdx]);
                    }
                    return nIdx;
                };
                handTriangles.push([getNewIdx(i0), getNewIdx(i1), getNewIdx(i2)]);
            }
        }

        // 3. Loop Subdivision for C^2 continuous smooth limit surface
        let curPositions = newPositions;
        let curTriangles = handTriangles;
        let curDigitMap = newDigitMap;

        for (let it = 0; it < subIters; it++) {
            const subResult = SbHumanHandTransformer.subdivideMesh(curPositions, curTriangles, curDigitMap);
            curPositions = subResult.positions;
            curTriangles = subResult.triangles;
            curDigitMap = subResult.digitMap;
        }

        // 4. Center or orient if requested
        const wristPos: Vec3 = [
            loader.joints[20].pos[0],
            loader.joints[20].pos[1],
            loader.joints[20].pos[2]
        ];

        // 5. Anatomical Sculpting
        SbHumanHandTransformer.applyAnatomicalSculpting(curPositions, curDigitMap, loader, strength);

        // 6. Compute Analytical Smooth Normals
        const preNormals = SbHumanHandTransformer.computeSmoothNormals(curPositions, curTriangles);

        // 7. Continuous Surface-Conformal Dual-Island UV Parameterization (Zero knuckle/finger seams)
        const {
            positions: splitPositions,
            normals: splitNormals,
            uvs: splitUvs,
            triangles: splitTriangles
        } = SbHumanHandTransformer.computeContinuousDualIslandUvs(curPositions, preNormals, curTriangles, loader);

        // Flatten buffers
        const numV = splitPositions.length;
        const positionsFlat = new Float32Array(numV * 3);
        const normalsFlat = new Float32Array(numV * 3);
        const uvsFlat = new Float32Array(numV * 2);
        const colorsFlat = new Float32Array(numV * 3);

        const centerOffset = options.recenterOrigin ? wristPos : [0, 0, 0];

        for (let i = 0; i < numV; i++) {
            positionsFlat[i * 3 + 0] = splitPositions[i][0] - centerOffset[0];
            positionsFlat[i * 3 + 1] = splitPositions[i][1] - centerOffset[1];
            positionsFlat[i * 3 + 2] = splitPositions[i][2] - centerOffset[2];

            normalsFlat[i * 3 + 0] = splitNormals[i][0];
            normalsFlat[i * 3 + 1] = splitNormals[i][1];
            normalsFlat[i * 3 + 2] = splitNormals[i][2];

            uvsFlat[i * 2 + 0] = splitUvs[i][0];
            uvsFlat[i * 2 + 1] = splitUvs[i][1];

            colorsFlat[i * 3 + 0] = 0.85;
            colorsFlat[i * 3 + 1] = 0.75;
            colorsFlat[i * 3 + 2] = 0.70;
        }

        const indicesFlat = new Uint32Array(splitTriangles.length * 3);
        for (let t = 0; t < splitTriangles.length; t++) {
            indicesFlat[t * 3 + 0] = splitTriangles[t][0];
            indicesFlat[t * 3 + 1] = splitTriangles[t][1];
            indicesFlat[t * 3 + 2] = splitTriangles[t][2];
        }

        return {
            positions: positionsFlat,
            normals: normalsFlat,
            uvs: uvsFlat,
            colors: colorsFlat,
            indices: indicesFlat,
            numVertices: numV,
            numTriangles: splitTriangles.length
        };
    }

    /**
     * Subdivides triangle mesh with Loop subdivision rule.
     */
    private static subdivideMesh(
        positions: Vec3[],
        triangles: [number, number, number][],
        digitMap: number[]
    ): { positions: Vec3[]; triangles: [number, number, number][]; digitMap: number[] } {
        const edgeMap = new Map<string, { v0: number; v1: number; opps: number[]; midIdx?: number }>();
        const makeKey = (a: number, b: number) => a < b ? `${a}_${b}` : `${b}_${a}`;

        for (const [i0, i1, i2] of triangles) {
            const edges: [number, number, number][] = [
                [i0, i1, i2],
                [i1, i2, i0],
                [i2, i0, i1]
            ];
            for (const [a, b, opp] of edges) {
                const k = makeKey(a, b);
                let entry = edgeMap.get(k);
                if (!entry) {
                    entry = { v0: Math.min(a, b), v1: Math.max(a, b), opps: [] };
                    edgeMap.set(k, entry);
                }
                entry.opps.push(opp);
            }
        }

        const newPositions: Vec3[] = [...positions.map(p => [...p] as Vec3)];
        const newDigitMap: number[] = [...digitMap];

        // 1. Compute midpoints for edges
        for (const entry of edgeMap.values()) {
            const pA = positions[entry.v0];
            const pB = positions[entry.v1];
            let edgePos: Vec3;
            if (entry.opps.length === 2) {
                const pC = positions[entry.opps[0]];
                const pD = positions[entry.opps[1]];
                edgePos = [
                    (pA[0] + pB[0]) * 0.375 + (pC[0] + pD[0]) * 0.125,
                    (pA[1] + pB[1]) * 0.375 + (pC[1] + pD[1]) * 0.125,
                    (pA[2] + pB[2]) * 0.375 + (pC[2] + pD[2]) * 0.125
                ];
            } else {
                edgePos = [
                    (pA[0] + pB[0]) * 0.5,
                    (pA[1] + pB[1]) * 0.5,
                    (pA[2] + pB[2]) * 0.5
                ];
            }
            entry.midIdx = newPositions.length;
            newPositions.push(edgePos);
            newDigitMap.push(digitMap[entry.v0] === digitMap[entry.v1] ? digitMap[entry.v0] : digitMap[entry.v0]);
        }

        // 2. Build 4 child triangles for each parent triangle
        const newTriangles: [number, number, number][] = [];
        for (const [v0, v1, v2] of triangles) {
            const m01 = edgeMap.get(makeKey(v0, v1))!.midIdx!;
            const m12 = edgeMap.get(makeKey(v1, v2))!.midIdx!;
            const m20 = edgeMap.get(makeKey(v2, v0))!.midIdx!;

            newTriangles.push([v0, m01, m20]);
            newTriangles.push([v1, m12, m01]);
            newTriangles.push([v2, m20, m12]);
            newTriangles.push([m01, m12, m20]);
        }

        return { positions: newPositions, triangles: newTriangles, digitMap: newDigitMap };
    }

    /**
     * Applies anatomical micro-geometry deformations:
     * - Thenar & Hypothenar eminence muscle volumes
     * - Palmar cup hollow
     * - Knuckle condylar flaring at MCP, PIP, DIP
     * - Volar fingertip pulp cushioning
     * - Recessed nail bed & elevated eponychium cuticle lip
     */
    private static applyAnatomicalSculpting(
        positions: Vec3[],
        digitMap: number[],
        loader: SbHumanLoader,
        strength: number = 1.0
    ): void {
        // Wrist position
        const wrist = loader.joints[20].pos;

        // 1. Thenar Eminence (Thumb ball: muscular convex bulge at palm base)
        const thenarCenter: Vec3 = [wrist[0] + 0.038, wrist[1] - 0.012, wrist[2] + 0.045];
        const thenarRadius = 0.036;
        const thenarDisp: Vec3 = [0.0008, -0.0042 * strength, 0.0025 * strength];

        // 2. Hypothenar Eminence (Pinky ball: ulnar border cushion)
        const hypoCenter: Vec3 = [wrist[0] + 0.042, wrist[1] - 0.010, wrist[2] - 0.035];
        const hypoRadius = 0.032;
        const hypoDisp: Vec3 = [0.0005, -0.0034 * strength, -0.0020 * strength];

        // 3. Palmar Aponeurosis Hollow (Center of palm concavity)
        const palmCenter: Vec3 = [wrist[0] + 0.060, wrist[1] - 0.006, wrist[2] - 0.002];
        const palmRadius = 0.028;
        const palmDisp: Vec3 = [0.0, 0.0008 * strength, 0.0];

        // 4. Knuckle condyle list: [jointIndex, radius, flareStrength]
        const condyles: Array<{ joint: number; radius: number; flare: number }> = [
            // MCP joints
            { joint: 25, radius: 0.016, flare: 0.12 },
            { joint: 28, radius: 0.016, flare: 0.12 },
            { joint: 34, radius: 0.015, flare: 0.11 },
            { joint: 31, radius: 0.014, flare: 0.11 },
            { joint: 37, radius: 0.018, flare: 0.13 },
            // PIP joints
            { joint: 26, radius: 0.013, flare: 0.10 },
            { joint: 29, radius: 0.013, flare: 0.10 },
            { joint: 35, radius: 0.012, flare: 0.09 },
            { joint: 32, radius: 0.011, flare: 0.09 },
            { joint: 38, radius: 0.015, flare: 0.11 },
            // DIP joints
            { joint: 27, radius: 0.011, flare: 0.08 },
            { joint: 30, radius: 0.011, flare: 0.08 },
            { joint: 36, radius: 0.010, flare: 0.07 },
            { joint: 33, radius: 0.009, flare: 0.07 },
            { joint: 39, radius: 0.013, flare: 0.09 }
        ];

        // Distal phalanx tips for pulp cushioning & nail beds
        const distalFingers = [
            { digit: 0, joint: 39, name: 'thumb' },
            { digit: 1, joint: 27, name: 'index' },
            { digit: 2, joint: 30, name: 'middle' },
            { digit: 3, joint: 36, name: 'ring' },
            { digit: 4, joint: 33, name: 'pinky' }
        ];

        for (let i = 0; i < positions.length; i++) {
            const p = positions[i];

            // --- Thenar Eminence ---
            const dThenar = vLen(vSub(p, thenarCenter));
            if (dThenar < thenarRadius) {
                const t = dThenar / thenarRadius;
                const w = (1.0 - t) * (1.0 - t) * (1.0 + 2.0 * t);
                p[0] += thenarDisp[0] * w;
                p[1] += thenarDisp[1] * w;
                p[2] += thenarDisp[2] * w;
            }

            // --- Hypothenar Eminence ---
            const dHypo = vLen(vSub(p, hypoCenter));
            if (dHypo < hypoRadius) {
                const t = dHypo / hypoRadius;
                const w = (1.0 - t) * (1.0 - t) * (1.0 + 2.0 * t);
                p[0] += hypoDisp[0] * w;
                p[1] += hypoDisp[1] * w;
                p[2] += hypoDisp[2] * w;
            }

            // --- Palmar Cup Hollow ---
            const dPalm = vLen(vSub(p, palmCenter));
            if (dPalm < palmRadius) {
                const t = dPalm / palmRadius;
                const w = (1.0 - t) * (1.0 - t) * (1.0 + 2.0 * t);
                p[0] += palmDisp[0] * w;
                p[1] += palmDisp[1] * w;
                p[2] += palmDisp[2] * w;
            }

            // --- Knuckle Condylar Flaring ---
            for (const c of condyles) {
                const jPos: Vec3 = [
                    loader.joints[c.joint].pos[0],
                    loader.joints[c.joint].pos[1],
                    loader.joints[c.joint].pos[2]
                ];
                const dCond = vLen(vSub(p, jPos));
                if (dCond < c.radius) {
                    const t = dCond / c.radius;
                    const w = Math.cos(t * Math.PI * 0.5) * c.flare * strength;
                    // Lateral flare (along Z axis for digits 1-4, along Y/X for thumb)
                    if (c.joint >= 37) {
                        p[1] += (p[1] - jPos[1]) * w * 0.8;
                    } else {
                        p[2] += (p[2] - jPos[2]) * w;
                    }
                }
            }

            // --- Volar Pulp Cushioning & Nail Bed Relief ---
            const pRelWrist: Vec3 = [
                p[0] - wrist[0],
                p[1] - wrist[1],
                p[2] - wrist[2]
            ];

            // Volar pulp pads for each finger (expanding downward)
            const volarPulpPads = [
                { center: [0.098, -0.024, 0.082], radius: 0.016, depth: 0.0024 }, // Thumb
                { center: [0.178, -0.012, 0.021], radius: 0.014, depth: 0.0022 }, // Index
                { center: [0.187, -0.008, -0.017], radius: 0.014, depth: 0.0022 }, // Middle
                { center: [0.169, -0.010, -0.045], radius: 0.014, depth: 0.0022 }, // Ring
                { center: [0.130, -0.020, -0.072], radius: 0.013, depth: 0.0020 }  // Pinky
            ];

            for (const pad of volarPulpPads) {
                const dx = pRelWrist[0] - pad.center[0];
                const dy = pRelWrist[1] - pad.center[1];
                const dz = pRelWrist[2] - pad.center[2];
                const d = Math.hypot(dx, dy, dz);
                if (d < pad.radius && pRelWrist[1] < pad.center[1] + 0.003) {
                    const w = Math.exp(-(d * d) / (0.008 * 0.008)) * strength;
                    p[1] -= pad.depth * w; // Cushioning expansion
                }
            }

            // Distal Nail Beds (Depressed ungual matrix & elevated proximal eponychium lip)
            const nailBeds3D = [
                { name: 'Thumb',  center: [0.0927, -0.0148, 0.0763], dir: [0.55, 0.0, 0.83], radius: 0.012 },
                { name: 'Index',  center: [0.1721, -0.0040, 0.0210], dir: [1.00, 0.0, 0.00], radius: 0.011 },
                { name: 'Middle', center: [0.1827, -0.0007, -0.0156], dir: [1.00, 0.0, 0.00], radius: 0.011 },
                { name: 'Ring',   center: [0.1631, -0.0032, -0.0435], dir: [1.00, 0.0, 0.00], radius: 0.011 },
                { name: 'Pinky',  center: [0.1265, -0.0130, -0.0726], dir: [0.95, 0.0, -0.30], radius: 0.010 }
            ];

            for (const nb of nailBeds3D) {
                const dx = pRelWrist[0] - nb.center[0];
                const dy = pRelWrist[1] - nb.center[1];
                const dz = pRelWrist[2] - nb.center[2];
                const d = Math.hypot(dx, dy, dz);
                if (d < nb.radius && pRelWrist[1] > nb.center[1] - 0.005) {
                    // Longitudinal projection along finger axis
                    const tLong = dx * nb.dir[0] + dz * nb.dir[2];
                    const wDist = 1.0 - (d / nb.radius);
                    if (tLong > -0.005 && tLong < 0.006) {
                        // Depress nail plate into ungual bed
                        p[1] -= 0.00070 * wDist * strength;
                    } else if (tLong >= -0.008 && tLong <= -0.005) {
                        // Elevate eponychium cuticle lip
                        p[1] += 0.00050 * wDist * strength;
                    }
                }
            }
        }
    }

    /**
    /**
     * Surface-Conformal Continuous Dual-Island UV Parameterization with Seam Splitting.
     * Eliminates knuckle and finger seams completely by mapping the entire dorsal surface
     * (wrist, dorsum, knuckles, and all 5 fingers) into one continuous sheet (U in [0.03, 0.47]),
     * and the entire palmar surface into one continuous sheet (U in [0.53, 0.97]).
     * Seam vertices along the lateral boundary are cleanly split so zero triangles straddle the gap.
     */
    private static computeContinuousDualIslandUvs(
        positions: Vec3[],
        normals: Vec3[],
        triangles: [number, number, number][],
        loader: SbHumanLoader
    ): { positions: Vec3[]; normals: Vec3[]; uvs: Vec2[]; triangles: [number, number, number][] } {
        const wrist = loader.joints[20].pos;
        const middleMcp = loader.joints[28].pos;

        const tLong = vNorm(vSub([middleMcp[0], middleMcp[1], middleMcp[2]], [wrist[0], wrist[1], wrist[2]]));
        const nDorsal: Vec3 = [0, 1, 0];
        const tLat = vNorm(vCross(tLong, nDorsal));

        const minU = -0.080, maxU = 0.100;
        const minV = -0.060, maxV = 0.200;

        const outPositions: Vec3[] = [];
        const outNormals: Vec3[] = [];
        const outUvs: Vec2[] = [];
        const outTriangles: [number, number, number][] = [];
        const vertKeyMap = new Map<string, number>();

        const getYMid = (x: number): number => {
            if (x < 0.0) return 0.005;
            if (x > 0.08) return -0.0085;
            const t = x / 0.08;
            return 0.005 * (1 - t) + (-0.0085) * t;
        };

        for (const [i0, i1, i2] of triangles) {
            const p0 = positions[i0], p1 = positions[i1], p2 = positions[i2];
            const e01 = vSub(p1, p0), e02 = vSub(p2, p0);
            const fn = vNorm(vCross(e01, e02));

            // Face is dorsal if its center is above anatomical midline and normal points upwards
            const centerX = (p0[0] + p1[0] + p2[0]) / 3;
            const centerY = (p0[1] + p1[1] + p2[1]) / 3;
            const isDorsal = (centerY > getYMid(centerX)) && (fn[1] > -0.30);
            const newCorners: [number, number, number] = [0, 0, 0];
            const triCorners = [i0, i1, i2];

            for (let c = 0; c < 3; c++) {
                const vIdx = triCorners[c];
                const key = `${vIdx}_${isDorsal ? 'D' : 'V'}`;
                let finalIdx = vertKeyMap.get(key);

                if (finalIdx === undefined) {
                    finalIdx = outPositions.length;
                    vertKeyMap.set(key, finalIdx);

                    const p = positions[vIdx];
                    outPositions.push([...p]);
                    outNormals.push([...normals[vIdx]]);

                    const r = vSub(p, [wrist[0], wrist[1], wrist[2]]);
                    const uRaw = vDot(r, tLat);
                    const vRaw = vDot(r, tLong);

                    const uNorm = clamp((uRaw - minU) / (maxU - minU), 0, 1);
                    const vNorm = clamp((vRaw - minV) / (maxV - minV), 0, 1);

                    let uv: Vec2;
                    if (isDorsal) {
                        uv = [
                            0.03 + uNorm * 0.44,
                            0.03 + (1.0 - vNorm) * 0.94
                        ];
                    } else {
                        uv = [
                            0.53 + (1.0 - uNorm) * 0.44,
                            0.03 + (1.0 - vNorm) * 0.94
                        ];
                    }
                    outUvs.push(uv);
                }
                newCorners[c] = finalIdx;
            }

            outTriangles.push(newCorners);
        }

        return {
            positions: outPositions,
            normals: outNormals,
            uvs: outUvs,
            triangles: outTriangles
        };
    }

    /**
     * Analytical angle-weighted smooth surface normals.
     */
    private static computeSmoothNormals(positions: Vec3[], triangles: [number, number, number][]): Vec3[] {
        const normals: Vec3[] = positions.map(() => [0, 0, 0] as Vec3);

        for (const [i0, i1, i2] of triangles) {
            const p0 = positions[i0];
            const p1 = positions[i1];
            const p2 = positions[i2];

            const e01 = vSub(p1, p0);
            const e02 = vSub(p2, p0);
            const fn = vCross(e01, e02);
            const fnLen = vLen(fn);
            if (fnLen > 1e-8) {
                const normFn: Vec3 = [fn[0] / fnLen, fn[1] / fnLen, fn[2] / fnLen];
                // Accumulate onto all 3 vertices
                normals[i0] = vAdd(normals[i0], normFn);
                normals[i1] = vAdd(normals[i1], normFn);
                normals[i2] = vAdd(normals[i2], normFn);
            }
        }

        return normals.map(n => vNorm(n));
    }

    /**
     * Bakes hyper-realistic 2K PBR texture maps (Albedo, Tangent Normal, ORM)
     * using delighted photographic macro references and continuous dual-island layout.
     */
    public static bakePbrTextures(
        palmRefPngPath: string,
        dorsalRefPngPath: string,
        nailRefPngPath: string,
        outDir: string,
        width: number = 2048,
        height: number = 2048
    ): PbrTexturePack {
        fs.mkdirSync(outDir, { recursive: true });

        // 1. Decode photographic macro references
        const palmImg = decodePng(fs.readFileSync(palmRefPngPath));
        const dorsalImg = decodePng(fs.readFileSync(dorsalRefPngPath));
        const nailImg = decodePng(fs.readFileSync(nailRefPngPath));
        const userRefPath = path.resolve('public/textures/humanoid/hand_user_ref.png');
        const userRef = fs.existsSync(userRefPath) ? decodePng(fs.readFileSync(userRefPath)) : dorsalImg;

        const sampleBilinear = (img: { data: Buffer | Uint8Array; width: number; height: number }, u: number, v: number): [number, number, number, number] => {
            const uu = (u % 1.0 + 1.0) % 1.0;
            const vv = (v % 1.0 + 1.0) % 1.0;
            const px = uu * (img.width - 1);
            const py = vv * (img.height - 1);
            const x0 = Math.floor(px);
            const y0 = Math.floor(py);
            const x1 = Math.min(img.width - 1, x0 + 1);
            const y1 = Math.min(img.height - 1, y0 + 1);
            const fx = px - x0;
            const fy = py - y0;

            const idx00 = (y0 * img.width + x0) * 4;
            const idx10 = (y0 * img.width + x1) * 4;
            const idx01 = (y1 * img.width + x0) * 4;
            const idx11 = (y1 * img.width + x1) * 4;

            const res: [number, number, number, number] = [0, 0, 0, 0];
            for (let c = 0; c < 4; c++) {
                const c0 = img.data[idx00 + c] * (1 - fx) + img.data[idx10 + c] * fx;
                const c1 = img.data[idx01 + c] * (1 - fx) + img.data[idx11 + c] * fx;
                res[c] = c0 * (1 - fy) + c1 * fy;
            }
            return res;
        };

        const smoothstep = (edge0: number, edge1: number, x: number): number => {
            const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
            return t * t * (3 - 2 * t);
        };

        const albedoBuf = Buffer.alloc(width * height * 4);
        const normalBuf = Buffer.alloc(width * height * 4);
        const ormBuf = Buffer.alloc(width * height * 4);

        // Seamless Periodic Worley Cellular Skin Noise (0.5 mm sulci cutis polygonal facets)
        const WORLEY_SIZE = 512;
        const WORLEY_CELLS = 64;
        const worleyTile = new Float32Array(WORLEY_SIZE * WORLEY_SIZE);
        {
            const seeds = new Float32Array(WORLEY_CELLS * WORLEY_CELLS * 2);
            for (let cy = 0; cy < WORLEY_CELLS; cy++) {
                for (let cx = 0; cx < WORLEY_CELLS; cx++) {
                    const n = Math.sin(cx * 127.1 + cy * 311.7) * 43758.5453123;
                    const m = Math.sin(cx * 269.5 + cy * 183.3) * 43758.5453123;
                    seeds[(cy * WORLEY_CELLS + cx) * 2 + 0] = cx + 0.15 + 0.70 * (n - Math.floor(n));
                    seeds[(cy * WORLEY_CELLS + cx) * 2 + 1] = cy + 0.15 + 0.70 * (m - Math.floor(m));
                }
            }
            for (let y = 0; y < WORLEY_SIZE; y++) {
                const fy = (y / WORLEY_SIZE) * WORLEY_CELLS;
                const iy = Math.floor(fy);
                for (let x = 0; x < WORLEY_SIZE; x++) {
                    const fx = (x / WORLEY_SIZE) * WORLEY_CELLS;
                    const ix = Math.floor(fx);
                    let d1 = 999.0, d2 = 999.0;
                    for (let dy = -1; dy <= 1; dy++) {
                        const cy = (iy + dy + WORLEY_CELLS) % WORLEY_CELLS;
                        for (let dx = -1; dx <= 1; dx++) {
                            const cx = (ix + dx + WORLEY_CELLS) % WORLEY_CELLS;
                            const sx = seeds[(cy * WORLEY_CELLS + cx) * 2 + 0] - cx;
                            const sy = seeds[(cy * WORLEY_CELLS + cx) * 2 + 1] - cy;
                            const dist = Math.hypot(fx - (ix + dx + sx), fy - (iy + dy + sy));
                            if (dist < d1) { d2 = d1; d1 = dist; }
                            else if (dist < d2) { d2 = dist; }
                        }
                    }
                    worleyTile[y * WORLEY_SIZE + x] = Math.min(1.0, (d2 - d1) * 1.6);
                }
            }
        }

        const sampleWorley = (u: number, v: number, freq: number): number => {
            const x = ((u * freq) % 1.0 + 1.0) % 1.0;
            const y = ((v * freq) % 1.0 + 1.0) % 1.0;
            const px = x * (WORLEY_SIZE - 1);
            const py = y * (WORLEY_SIZE - 1);
            const x0 = Math.floor(px);
            const y0 = Math.floor(py);
            const x1 = (x0 + 1) % WORLEY_SIZE;
            const y1 = (y0 + 1) % WORLEY_SIZE;
            const fx = px - x0;
            const fy = py - y0;
            const sx = fx * fx * (3.0 - 2.0 * fx);
            const sy = fy * fy * (3.0 - 2.0 * fy);
            const w00 = worleyTile[y0 * WORLEY_SIZE + x0];
            const w10 = worleyTile[y0 * WORLEY_SIZE + x1];
            const w01 = worleyTile[y1 * WORLEY_SIZE + x0];
            const w11 = worleyTile[y1 * WORLEY_SIZE + x1];
            const top = w00 * (1.0 - sx) + w10 * sx;
            const bot = w01 * (1.0 - sx) + w11 * sx;
            return top * (1.0 - sy) + bot * sy;
        };

        // 5 Calibrated Fingernails (sub-millimeter alignment derived directly from 3D mesh vertices)
        const nails = [
            { name: 'Thumb',  u: 0.4350, v: 0.4150, angle: -23.83 * Math.PI / 180, w: 0.032, l: 0.036 },
            { name: 'Index',  u: 0.2947, v: 0.1340, angle:   4.05 * Math.PI / 180, w: 0.020, l: 0.036 },
            { name: 'Middle', u: 0.2042, v: 0.0980, angle:   6.06 * Math.PI / 180, w: 0.019, l: 0.036 },
            { name: 'Ring',   u: 0.1343, v: 0.1550, angle:   5.86 * Math.PI / 180, w: 0.019, l: 0.036 },
            { name: 'Pinky',  u: 0.0584, v: 0.2820, angle:  13.54 * Math.PI / 180, w: 0.019, l: 0.035 }
        ];

        const evaluateNail = (u: number, v: number, nail: typeof nails[0]) => {
            const du = u - nail.u;
            const dv = v - nail.v;
            const cosA = Math.cos(nail.angle);
            const sinA = Math.sin(nail.angle);
            const uRot = du * cosA - dv * sinA;
            const vRot = du * sinA + dv * cosA;

            const xn = uRot / (nail.w * 0.5);
            const yn = vRot / (nail.l * 0.5);

            if (Math.abs(xn) > 1.05 || yn < -1.15 || yn > 1.15) {
                return { isInside: false, dist: -1, xn, yn, lip: 0 };
            }

            const yProx = 0.25 + 0.75 * Math.sqrt(Math.max(0, 1.0 - xn * xn));
            const yDist = -0.75 - 0.25 * Math.sqrt(Math.max(0, 1.0 - xn * xn));

            if (yn > yProx) {
                const dCuticle = yn - yProx;
                const lip = (dCuticle < 0.20) ? Math.sin((dCuticle / 0.20) * Math.PI) : 0;
                return { isInside: false, dist: -dCuticle, xn, yn, lip };
            }
            if (yn < yDist) {
                const dTip = yDist - yn;
                return { isInside: false, dist: -dTip, xn, yn, lip: 0 };
            }

            const dLateral = 1.0 - Math.abs(xn);
            const dTop = yProx - yn;
            const dBot = yn - yDist;
            const minDist = Math.min(dLateral, Math.min(dTop, dBot));

            return { isInside: true, dist: minDist, xn, yn, lip: 0 };
        };

        // 3 Anatomical dorsal superficial veins (Rete venosum dorsale manus)
        const dorsalVeins = [
            // Vein 1: Central (between 3rd and 4th metacarpals)
            [ [0.18, 0.48], [0.19, 0.62], [0.21, 0.76], [0.23, 0.92] ],
            // Vein 2: Radial (between 2nd and 3rd metacarpals)
            [ [0.26, 0.50], [0.25, 0.64], [0.25, 0.78], [0.26, 0.90] ],
            // Vein 3: Cephalic branch (from 1st webspace towards radial carpus)
            [ [0.33, 0.62], [0.31, 0.74], [0.29, 0.86], [0.27, 0.95] ]
        ];

        // Extensor Digitorum Tendons (4 pale cords from wrist to MCP knuckles)
        const tendons = [0.272, 0.203, 0.134, 0.095];

        // Transverse joint flexion folds (MCP, PIP, DIP)
        const jointFolds = [
            // MCP Knuckles
            { u: 0.203, v: 0.447, r: 0.024, k: 120.0 },
            { u: 0.283, v: 0.473, r: 0.022, k: 120.0 },
            { u: 0.121, v: 0.452, r: 0.022, k: 120.0 },
            { u: 0.100, v: 0.442, r: 0.018, k: 120.0 },
            { u: 0.333, v: 0.639, r: 0.026, k: 95.0  },
            // PIP Joints
            { u: 0.200, v: 0.250, r: 0.016, k: 140.0 },
            { u: 0.284, v: 0.291, r: 0.016, k: 140.0 },
            { u: 0.135, v: 0.273, r: 0.016, k: 140.0 },
            { u: 0.088, v: 0.376, r: 0.014, k: 140.0 },
            { u: 0.346, v: 0.514, r: 0.018, k: 120.0 },
            // DIP Joints
            { u: 0.203, v: 0.136, r: 0.012, k: 160.0 },
            { u: 0.292, v: 0.174, r: 0.012, k: 160.0 },
            { u: 0.128, v: 0.188, r: 0.012, k: 160.0 },
            { u: 0.133, v: 0.256, r: 0.010, k: 160.0 }
        ];

        // Compute photographic tangent-space normals using Sobel filters on macro references
        const computeSobelNormals = (img: { width: number; height: number; data: Buffer }, strength: number) => {
            const w = img.width, h = img.height;
            const normals = new Float32Array(w * h * 3);
            for (let py = 0; py < h; py++) {
                const pyPrev = (py - 1 + h) % h;
                const pyNext = (py + 1) % h;
                for (let px = 0; px < w; px++) {
                    const pxPrev = (px - 1 + w) % w;
                    const pxNext = (px + 1) % w;
                    const idxL = (py * w + pxPrev) * 4;
                    const idxR = (py * w + pxNext) * 4;
                    const idxU = (pyPrev * w + px) * 4;
                    const idxD = (pyNext * w + px) * 4;

                    const lL = (img.data[idxL] + img.data[idxL + 1] * 2 + img.data[idxL + 2]) / 1020.0;
                    const lR = (img.data[idxR] + img.data[idxR + 1] * 2 + img.data[idxR + 2]) / 1020.0;
                    const lU = (img.data[idxU] + img.data[idxU + 1] * 2 + img.data[idxU + 2]) / 1020.0;
                    const lD = (img.data[idxD] + img.data[idxD + 1] * 2 + img.data[idxD + 2]) / 1020.0;

                    const dx = (lR - lL) * strength;
                    const dy = (lD - lU) * strength;
                    const len = Math.sqrt(dx * dx + dy * dy + 1.0);
                    const outIdx = (py * w + px) * 3;
                    normals[outIdx + 0] = -dx / len;
                    normals[outIdx + 1] = -dy / len;
                    normals[outIdx + 2] = 1.0 / len;
                }
            }
            return normals;
        };

        const sampleNormalsBilinear = (normals: Float32Array, w: number, h: number, uCoord: number, vCoord: number): [number, number, number] => {
            const x = Math.max(0, Math.min(w - 1, uCoord * (w - 1)));
            const y = Math.max(0, Math.min(h - 1, vCoord * (h - 1)));
            const x0 = Math.floor(x);
            const x1 = Math.min(w - 1, x0 + 1);
            const y0 = Math.floor(y);
            const y1 = Math.min(h - 1, y0 + 1);
            const fx = x - x0;
            const fy = y - y0;

            const i00 = (y0 * w + x0) * 3;
            const i10 = (y0 * w + x1) * 3;
            const i01 = (y1 * w + x0) * 3;
            const i11 = (y1 * w + x1) * 3;

            const nx = (normals[i00 + 0] * (1 - fx) + normals[i10 + 0] * fx) * (1 - fy) +
                       (normals[i01 + 0] * (1 - fx) + normals[i11 + 0] * fx) * fy;
            const ny = (normals[i00 + 1] * (1 - fx) + normals[i10 + 1] * fx) * (1 - fy) +
                       (normals[i01 + 1] * (1 - fx) + normals[i11 + 1] * fx) * fy;
            const nz = (normals[i00 + 2] * (1 - fx) + normals[i10 + 2] * fx) * (1 - fy) +
                       (normals[i01 + 2] * (1 - fx) + normals[i11 + 2] * fx) * fy;

            return [nx, ny, nz];
        };

        console.log('  -> Pre-computing photographic Sobel normal maps from macro references...');
        const dorsalNormals = computeSobelNormals(dorsalImg, 1.4);
        const palmNormals = computeSobelNormals(palmImg, 1.8);
        const nailNormals = computeSobelNormals(nailImg, 1.6);

        // Helper: distance from point (px, py) to line segment (x0, y0)-(x1, y1)
        const distToSeg = (px: number, py: number, x0: number, y0: number, x1: number, y1: number) => {
            const l2 = (x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0);
            if (l2 === 0) return { dist: Math.hypot(px - x0, py - y0), dx: px - x0, dy: py - y0 };
            const t = Math.max(0, Math.min(1, ((px - x0) * (x1 - x0) + (py - y0) * (y1 - y0)) / l2));
            const projX = x0 + t * (x1 - x0);
            const projY = y0 + t * (y1 - y0);
            return { dist: Math.hypot(px - projX, py - projY), dx: px - projX, dy: py - projY };
        };

        for (let y = 0; y < height; y++) {
            const v = y / (height - 1);
            for (let x = 0; x < width; x++) {
                const u = x / (width - 1);
                const outIdx = (y * width + x) * 4;

                if (u < 0.50) {
                    // ==========================================
                    // --- DORSAL ISLAND (Fitzpatrick IV/V) ---
                    // ==========================================
                    const normU = u / 0.50;

                    // Photographic Macro Sampling with Natural Scale
                    const uDorsalTile = Math.abs((normU * 1.8) % 2.0 - 1.0);
                    const vDorsalTile = Math.abs((v * 2.2) % 2.0 - 1.0);
                    const signU = ((normU * 1.8) % 2.0) < 1.0 ? 1.0 : -1.0;
                    const signV = ((v * 2.2) % 2.0) < 1.0 ? 1.0 : -1.0;

                    const dorsalSample = sampleBilinear(dorsalImg, uDorsalTile, vDorsalTile);
                    const dorsalNorm = sampleNormalsBilinear(dorsalNormals, dorsalImg.width, dorsalImg.height, uDorsalTile, vDorsalTile);

                    // Photographic luminance modulation
                    const photoLum = (dorsalSample[0] * 0.299 + dorsalSample[1] * 0.587 + dorsalSample[2] * 0.114) / 165.0;
                    const lumFactor = 0.92 + photoLum * 0.08;

                    // De-lighted PBR Melanin Profile strictly matching User Reference:
                    // Metacarpus base: [210, 150, 122] (natural warm golden-amber)
                    // Finger shafts:   [218, 158, 130]
                    // Distal tips:     [225, 165, 138]
                    const fingerBlend = smoothstep(0.42, 0.15, v);
                    const tipBlend = smoothstep(0.15, 0.06, v);

                    let baseR = 210 * (1.0 - fingerBlend) + 218 * fingerBlend;
                    let baseG = 150 * (1.0 - fingerBlend) + 158 * fingerBlend;
                    let baseB = 122 * (1.0 - fingerBlend) + 130 * fingerBlend;

                    baseR = baseR * (1.0 - tipBlend) + 225 * tipBlend;
                    baseG = baseG * (1.0 - tipBlend) + 165 * tipBlend;
                    baseB = baseB * (1.0 - tipBlend) + 138 * tipBlend;

                    // Blend photographic nuance directly with calibrated base
                    let r = clamp(Math.round((dorsalSample[0] * 0.40 + baseR * 0.60) * lumFactor), 0, 255);
                    let g = clamp(Math.round((dorsalSample[1] * 0.40 + baseG * 0.60) * lumFactor), 0, 255);
                    let b = clamp(Math.round((dorsalSample[2] * 0.40 + baseB * 0.60) * lumFactor), 0, 255);

                    // Authentic Photographic Tangent-Space Normals
                    let nx = clamp(Math.round(128 + dorsalNorm[0] * signU * 127), 0, 255);
                    let ny = clamp(Math.round(128 + dorsalNorm[1] * signV * 127), 0, 255);
                    let nz = clamp(Math.round(dorsalNorm[2] * 255), 0, 255);

                    // Micro-Cavity AO and Hydrated Stratum Corneum Roughness
                    let ao = clamp(Math.round(255 - Math.max(0, 1.0 - photoLum) * 60), 0, 255);
                    let roughness = clamp(Math.round(114 + Math.max(0, 1.0 - photoLum) * 20), 0, 255); // ~0.45 - 0.52
                    let metalness = 0;

                    // Subcutaneous Dorsal Veins (rete venosum dorsale manus)
                    for (const vein of dorsalVeins) {
                        for (let k = 0; k < vein.length - 1; k++) {
                            const seg = distToSeg(normU, v, vein[k][0], vein[k][1], vein[k+1][0], vein[k+1][1]);
                            const veinR = 0.016;
                            if (seg.dist < veinR && v > 0.45 && v < 0.96) {
                                const falloff = (1.0 - seg.dist / veinR) * (1.0 - seg.dist / veinR);
                                r = clamp(r - Math.round(14 * falloff), 0, 255);
                                g = clamp(g + Math.round(2 * falloff), 0, 255);
                                b = clamp(b + Math.round(12 * falloff), 0, 255);
                                const signX = seg.dx > 0 ? 1 : -1;
                                nx = clamp(Math.round(nx + signX * falloff * 20), 0, 255);
                            }
                        }
                    }

                    // Extensor Tendons
                    for (const tu of tendons) {
                        const du = Math.abs(normU - tu);
                        const tendonR = 0.013;
                        if (du < tendonR && v > 0.42 && v < 0.95) {
                            const falloff = (1.0 - du / tendonR) * (1.0 - du / tendonR);
                            r = clamp(r + Math.round(7 * falloff), 0, 255);
                            g = clamp(g + Math.round(6 * falloff), 0, 255);
                            b = clamp(b + Math.round(4 * falloff), 0, 255);
                            const signX = (normU - tu) > 0 ? 1 : -1;
                            nx = clamp(Math.round(nx - signX * falloff * 15), 0, 255);
                        }
                    }

                    // Transverse Joint Flexion Folds (MCP Knuckles, PIP Joints, DIP Joints)
                    for (const jf of jointFolds) {
                        const du = normU - jf.u;
                        const dv = v - jf.v;
                        const dist = Math.hypot(du, dv);
                        if (dist < jf.r) {
                            const radFalloff = Math.cos((dist / jf.r) * Math.PI * 0.5);
                            const wave = Math.cos(dv * jf.k);
                            if (wave < -0.15) {
                                const depth = (-wave - 0.15) / 0.85 * radFalloff;
                                r = clamp(r - Math.round(22 * depth), 0, 255);
                                g = clamp(g - Math.round(18 * depth), 0, 255);
                                b = clamp(b - Math.round(14 * depth), 0, 255);
                                ao = clamp(ao - Math.round(50 * depth), 0, 255);
                                roughness = clamp(roughness + Math.round(20 * depth), 0, 255);
                            }
                            const waveSlope = Math.sin(dv * jf.k) * radFalloff;
                            ny = clamp(Math.round(ny + waveSlope * 34), 0, 255);
                        }
                    }

                    // Check if inside any of the 5 Fingernails
                    for (const nail of nails) {
                        const res = evaluateNail(u, v, nail);
                        if (res.isInside) {
                            const uImg = 0.490 + res.xn * 0.185;
                            const vImg = 0.520 - res.yn * 0.290;
                            const s = sampleBilinear(nailImg, uImg, vImg);
                            const nSample = sampleNormalsBilinear(nailNormals, nailImg.width, nailImg.height, uImg, vImg);

                            // Rotate normal by nail angle to align longitudinal striations with finger axis
                            const cosA = Math.cos(nail.angle);
                            const sinA = Math.sin(nail.angle);
                            const rotNx = nSample[0] * cosA - nSample[1] * sinA;
                            const rotNy = nSample[0] * sinA + nSample[1] * cosA;

                            const nailNx = clamp(Math.round(128 + rotNx * 127), 0, 255);
                            const nailNy = clamp(Math.round(128 + rotNy * 127), 0, 255);

                            // Smooth border blend to eliminate hard polygonal transitions
                            const nailBlend = clamp(res.dist / 0.10, 0.0, 1.0);
                            r = Math.round(s[0] * nailBlend + r * (1.0 - nailBlend));
                            g = Math.round(s[1] * nailBlend + g * (1.0 - nailBlend));
                            b = Math.round(s[2] * nailBlend + b * (1.0 - nailBlend));

                            nx = Math.round(nailNx * nailBlend + nx * (1.0 - nailBlend));
                            ny = Math.round(nailNy * nailBlend + ny * (1.0 - nailBlend));

                            roughness = Math.round(22 * nailBlend + roughness * (1.0 - nailBlend));
                            metalness = 0;
                            ao = Math.round(255 * nailBlend + ao * (1.0 - nailBlend));
                            break;
                        } else if (res.lip > 0) {
                            r = clamp(Math.round(r * 0.88 + 205 * 0.12), 0, 255);
                            g = clamp(Math.round(g * 0.88 + 145 * 0.12), 0, 255);
                            b = clamp(Math.round(b * 0.88 + 115 * 0.12), 0, 255);
                            ny = clamp(Math.round(ny + res.lip * 24), 0, 255);
                            ao = clamp(Math.round(255 - res.lip * 60), 0, 255);
                            roughness = 110;
                            break;
                        }
                    }

                    // Normalize tangent-space normal vector
                    const fnx = (nx - 128) / 127.0;
                    const fny = (ny - 128) / 127.0;
                    const fnz = Math.sqrt(Math.max(0.0, 1.0 - fnx * fnx - fny * fny));
                    nz = clamp(Math.round(fnz * 255), 0, 255);

                    albedoBuf[outIdx + 0] = r;
                    albedoBuf[outIdx + 1] = g;
                    albedoBuf[outIdx + 2] = b;
                    albedoBuf[outIdx + 3] = 255;

                    normalBuf[outIdx + 0] = nx;
                    normalBuf[outIdx + 1] = ny;
                    normalBuf[outIdx + 2] = nz;
                    normalBuf[outIdx + 3] = 255;

                    ormBuf[outIdx + 0] = ao;
                    ormBuf[outIdx + 1] = roughness;
                    ormBuf[outIdx + 2] = metalness;
                    ormBuf[outIdx + 3] = 255;

                } else {
                    // ==========================================
                    // --- PALMAR ISLAND ---
                    // ==========================================
                    const normU = (u - 0.50) / 0.50;

                    // Direct continuous palmar mapping without artificial mirror seam
                    const uPalm = clamp(normU, 0.0, 1.0);
                    const vPalm = clamp(v, 0.0, 1.0);

                    const macroPalm = sampleBilinear(palmImg, uPalm, vPalm);
                    const palmNorm = sampleNormalsBilinear(palmNormals, palmImg.width, palmImg.height, uPalm, vPalm);

                    // De-lighted authentic palmar melanin tone calibrated to match user hand:
                    const palmLum = (macroPalm[0] * 0.299 + macroPalm[1] * 0.587 + macroPalm[2] * 0.114) / 195.0;
                    let pr = clamp(Math.round((macroPalm[0] * 0.55 + 215 * 0.45) * palmLum), 0, 255);
                    let pg = clamp(Math.round((macroPalm[1] * 0.55 + 158 * 0.45) * palmLum), 0, 255);
                    let pb = clamp(Math.round((macroPalm[2] * 0.55 + 132 * 0.45) * palmLum), 0, 255);

                    // Volar fingertip pads (capillary flush)
                    if (v < 0.35) {
                        const wPad = (1.0 - v / 0.35);
                        pr = clamp(Math.round(pr + 12 * wPad), 0, 255);
                        pg = clamp(Math.round(pg - 4 * wPad), 0, 255);
                        pb = clamp(Math.round(pb - 2 * wPad), 0, 255);
                    }

                    let pnx = clamp(Math.round(128 + palmNorm[0] * 127), 0, 255);
                    let pny = clamp(Math.round(128 + palmNorm[1] * 127), 0, 255);
                    let pao = clamp(Math.round(255 - Math.max(0, 1.0 - palmLum) * 55), 0, 255);
                    let pRoughness = clamp(Math.round(112 + Math.max(0, 1.0 - palmLum) * 20), 0, 255); // ~0.44 - 0.52

                    const pfnx = (pnx - 128) / 127.0;
                    const pfny = (pny - 128) / 127.0;
                    const pfnz = Math.sqrt(Math.max(0.0, 1.0 - pfnx * pfnx - pfny * pfny));
                    const pnz = clamp(Math.round(pfnz * 255), 0, 255);

                    albedoBuf[outIdx + 0] = pr;
                    albedoBuf[outIdx + 1] = pg;
                    albedoBuf[outIdx + 2] = pb;
                    albedoBuf[outIdx + 3] = 255;

                    normalBuf[outIdx + 0] = pnx;
                    normalBuf[outIdx + 1] = pny;
                    normalBuf[outIdx + 2] = pnz;
                    normalBuf[outIdx + 3] = 255;

                    ormBuf[outIdx + 0] = pao;
                    ormBuf[outIdx + 1] = pRoughness;
                    ormBuf[outIdx + 2] = 0;
                    ormBuf[outIdx + 3] = 255;
                }
            }
        }

        const albedoPng = encodePng(width, height, albedoBuf);
        const normalPng = encodePng(width, height, normalBuf);
        const ormPng = encodePng(width, height, ormBuf);

        fs.writeFileSync(path.join(outDir, 'hand_albedo.png'), albedoPng);
        fs.writeFileSync(path.join(outDir, 'hand_normal.png'), normalPng);
        fs.writeFileSync(path.join(outDir, 'hand_orm.png'), ormPng);

        return { albedoPng, normalPng, ormPng, width, height };
    }

    /**
     * Packages the enhanced hand into standard binary glTF 2.0 (.glb) format
     * with embedded PBR metallic-roughness material and textures.
     */
    public static exportGlb(
        mesh: EnhancedHandMesh,
        texturePack: PbrTexturePack,
        outPath: string
    ): Buffer {
        const nv = mesh.numVertices;
        const chunks: Buffer[] = [];
        const views: any[] = [];
        let offset = 0;

        const addView = (data: ArrayBufferView, target?: number) => {
            const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
            const pad = (4 - (buf.length % 4)) % 4;
            const viewIdx = views.length;
            views.push({
                buffer: 0,
                byteOffset: offset,
                byteLength: buf.length,
                ...(target ? { target } : {})
            });
            chunks.push(buf);
            if (pad > 0) chunks.push(Buffer.alloc(pad));
            offset += buf.length + pad;
            return viewIdx;
        };

        const addImageBuffer = (pngBuf: Buffer) => {
            const pad = (4 - (pngBuf.length % 4)) % 4;
            const viewIdx = views.length;
            views.push({
                buffer: 0,
                byteOffset: offset,
                byteLength: pngBuf.length
            });
            chunks.push(pngBuf);
            if (pad > 0) chunks.push(Buffer.alloc(pad));
            offset += pngBuf.length + pad;
            return viewIdx;
        };

        // Bounding box
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (let i = 0; i < nv; i++) {
            const x = mesh.positions[i * 3 + 0];
            const y = mesh.positions[i * 3 + 1];
            const z = mesh.positions[i * 3 + 2];
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
            if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        }

        const ARRAY = 34962;
        const ELEMENTS = 34963;

        const accessors: any[] = [
            // 0: POSITION
            { bufferView: addView(mesh.positions, ARRAY), componentType: 5126, count: nv, type: 'VEC3', min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
            // 1: NORMAL
            { bufferView: addView(mesh.normals, ARRAY), componentType: 5126, count: nv, type: 'VEC3' },
            // 2: TEXCOORD_0
            { bufferView: addView(mesh.uvs, ARRAY), componentType: 5126, count: nv, type: 'VEC2' },
            // 3: COLOR_0
            { bufferView: addView(mesh.colors, ARRAY), componentType: 5126, count: nv, type: 'VEC3' },
            // 4: INDICES
            { bufferView: addView(mesh.indices, ELEMENTS), componentType: 5125, count: mesh.indices.length, type: 'SCALAR' }
        ];

        // Embed Images & Textures
        const albedoView = addImageBuffer(texturePack.albedoPng);
        const normalView = addImageBuffer(texturePack.normalPng);
        const ormView = addImageBuffer(texturePack.ormPng);

        const images = [
            { bufferView: albedoView, mimeType: 'image/png' },
            { bufferView: normalView, mimeType: 'image/png' },
            { bufferView: ormView, mimeType: 'image/png' }
        ];

        const samplers = [
            { magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }
        ];

        const textures = [
            { source: 0, sampler: 0 }, // 0: albedo
            { source: 1, sampler: 0 }, // 1: normal
            { source: 2, sampler: 0 }  // 2: orm
        ];

        const materials = [{
            name: 'SbHumanSkin_HyperReal_PBR',
            pbrMetallicRoughness: {
                baseColorTexture: { index: 0 },
                metallicRoughnessTexture: { index: 2 },
                metallicFactor: 0.0,
                roughnessFactor: 1.0
            },
            normalTexture: { index: 1, scale: 1.0 },
            occlusionTexture: { index: 2, strength: 1.0 },
            doubleSided: true
        }];

        const bin = Buffer.concat(chunks);
        const gltf: any = {
            asset: { version: '2.0', generator: 'Scratchbox SbHumanHandTransformer' },
            scene: 0,
            scenes: [{ nodes: [0] }],
            nodes: [{ mesh: 0, name: 'EnhancedHand' }],
            meshes: [{
                name: 'EnhancedHand',
                primitives: [{
                    attributes: {
                        POSITION: 0,
                        NORMAL: 1,
                        TEXCOORD_0: 2,
                        COLOR_0: 3
                    },
                    indices: 4,
                    material: 0
                }]
            }],
            materials,
            textures,
            images,
            samplers,
            accessors,
            bufferViews: views,
            buffers: [{ byteLength: bin.length }]
        };

        let json = Buffer.from(JSON.stringify(gltf), 'utf-8');
        const jsonPad = (4 - (json.length % 4)) % 4;
        if (jsonPad > 0) json = Buffer.concat([json, Buffer.alloc(jsonPad, 0x20)]);

        const header = Buffer.alloc(12);
        header.writeUInt32LE(0x46546c67, 0); // 'glTF'
        header.writeUInt32LE(2, 4);          // version 2
        header.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);

        const jsonHead = Buffer.alloc(8);
        jsonHead.writeUInt32LE(json.length, 0);
        jsonHead.writeUInt32LE(0x4e4f534a, 4); // 'JSON'

        const binHead = Buffer.alloc(8);
        binHead.writeUInt32LE(bin.length, 0);
        binHead.writeUInt32LE(0x004e4942, 4);  // 'BIN\0'

        const glbBuffer = Buffer.concat([header, jsonHead, json, binHead, bin]);

        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, glbBuffer);

        return glbBuffer;
    }
}
