/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Skeletal Linear Blend Skinning for the 22-joint SB-Human body used by 4DAnyone avatars.
 *
 * Joint positions in motion.json are absolute (world, Y-up, metres). Each joint j owns the
 * segment that starts at j; its rotation maps the canonical segment frame onto the posed one.
 * Torso joints use a two-axis frame (segment + lateral hip/shoulder line) so spine twist is
 * recovered; limbs apply the shortest-arc swing of their segment on top of the parent rotation.
 *
 * public/video_to_4d_performer_studio.html mirrors computeBoneRotations between the
 * `@sbx-skinning-begin` / `@sbx-skinning-end` markers; the parity test keeps them identical.
 */

export type Vec3 = [number, number, number];
export type Mat3 = [Vec3, Vec3, Vec3];

export const SBHUMAN22_PARENTS: number[] = [-1, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 12, 13, 14, 16, 17, 18, 19];

/** Child joint defining each joint's own segment direction (-1: leaf, inherits its parent's rotation). */
export const SBHUMAN22_SEGMENT_CHILD: number[] = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, -1, -1, 15, 16, 17, -1, 18, 19, 20, 21, -1, -1];

/** Lateral (right -> left) reference used to recover twist for torso joints, or null for swing-only. */
export const SBHUMAN22_LATERAL_REF: Array<[number, number] | null> = [
    [2, 1], null, null, [2, 1], null, null, [17, 16], null, null, [17, 16], null, null,
    [17, 16], null, null, null, null, null, null, null, null, null
];

// Backward compatibility aliases
export const SMPLX22_PARENTS = SBHUMAN22_PARENTS;
export const SMPLX22_SEGMENT_CHILD = SBHUMAN22_SEGMENT_CHILD;
export const SMPLX22_LATERAL_REF = SBHUMAN22_LATERAL_REF;

const IDENTITY: Mat3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

function sub(a: Vec3, b: Vec3): Vec3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function dot(a: Vec3, b: Vec3): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a: Vec3, b: Vec3): Vec3 { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function normalize(v: Vec3): Vec3 | null {
    const l = Math.hypot(v[0], v[1], v[2]);
    return l > 1e-9 ? [v[0] / l, v[1] / l, v[2] / l] : null;
}

export function transposeMat3(m: Mat3): Mat3 {
    return [[m[0][0], m[1][0], m[2][0]], [m[0][1], m[1][1], m[2][1]], [m[0][2], m[1][2], m[2][2]]];
}

/** Shortest-arc rotation taking direction `from` onto direction `to`. */
export function rotationBetween(from: Vec3, to: Vec3): Mat3 {
    return swingRotation(from, to);
}

function swingRotation(from: Vec3, to: Vec3): Mat3 {
    const a = normalize(from);
    const b = normalize(to);
    if (!a || !b) return IDENTITY;
    const axis = cross(a, b);
    const s = Math.hypot(axis[0], axis[1], axis[2]);
    const c = Math.max(-1, Math.min(1, dot(a, b)));
    if (s < 1e-6) {
        if (c > 0) return IDENTITY;
        // 180 degree flip about any axis perpendicular to a
        const p = normalize(Math.abs(a[0]) < 0.9 ? cross(a, [1, 0, 0]) : cross(a, [0, 1, 0]))!;
        return [
            [2 * p[0] * p[0] - 1, 2 * p[0] * p[1], 2 * p[0] * p[2]],
            [2 * p[1] * p[0], 2 * p[1] * p[1] - 1, 2 * p[1] * p[2]],
            [2 * p[2] * p[0], 2 * p[2] * p[1], 2 * p[2] * p[2] - 1]
        ];
    }
    const u: Vec3 = [axis[0] / s, axis[1] / s, axis[2] / s];
    const t = 1 - c;
    return [
        [c + u[0] * u[0] * t, u[0] * u[1] * t - u[2] * s, u[0] * u[2] * t + u[1] * s],
        [u[1] * u[0] * t + u[2] * s, c + u[1] * u[1] * t, u[1] * u[2] * t - u[0] * s],
        [u[2] * u[0] * t - u[1] * s, u[2] * u[1] * t + u[0] * s, c + u[2] * u[2] * t]
    ];
}

/** Orthonormal frame [e1, e2, e3] as matrix columns; null if the axes are degenerate. */
function segmentFrame(primary: Vec3, lateral: Vec3): Mat3 | null {
    const e1 = normalize(primary);
    if (!e1) return null;
    const lat = sub(lateral, [e1[0] * dot(lateral, e1), e1[1] * dot(lateral, e1), e1[2] * dot(lateral, e1)]);
    const e2 = normalize(lat);
    if (!e2 || Math.hypot(lat[0], lat[1], lat[2]) < 0.2 * Math.hypot(lateral[0], lateral[1], lateral[2])) return null;
    const e3 = cross(e1, e2);
    return [
        [e1[0], e2[0], e3[0]],
        [e1[1], e2[1], e3[1]],
        [e1[2], e2[2], e3[2]]
    ];
}

function mulAB(a: Mat3, b: Mat3): Mat3 {
    const r: Mat3 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
            r[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
        }
    }
    return r;
}

function mulABt(a: Mat3, b: Mat3): Mat3 {
    const r: Mat3 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
            r[i][j] = a[i][0] * b[j][0] + a[i][1] * b[j][1] + a[i][2] * b[j][2];
        }
    }
    return r;
}

/** Per-joint rotation (canonical -> posed) for all 22 joints. */
export function computeBoneRotations(canonical: Vec3[], posed: Vec3[]): Mat3[] {
    const n = Math.min(canonical.length, posed.length, SMPLX22_PARENTS.length);
    const rotations: Mat3[] = new Array(n);
    for (let j = 0; j < n; j++) {
        const child = SMPLX22_SEGMENT_CHILD[j];
        if (child < 0 || child >= n) {
            const parent = SMPLX22_PARENTS[j];
            rotations[j] = parent >= 0 ? rotations[parent] : IDENTITY;
            continue;
        }
        const segC = sub(canonical[child], canonical[j]);
        const segP = sub(posed[child], posed[j]);
        const lateral = SMPLX22_LATERAL_REF[j];
        let R: Mat3 | null = null;
        if (lateral) {
            const fC = segmentFrame(segC, sub(canonical[lateral[1]], canonical[lateral[0]]));
            const fP = segmentFrame(segP, sub(posed[lateral[1]], posed[lateral[0]]));
            if (fC && fP) R = mulABt(fP, fC);
        }
        if (!R) {
            // Swing relative to the parent so body/pelvis twist propagates down the limbs.
            const parent = SMPLX22_PARENTS[j];
            const Rp = parent >= 0 ? rotations[parent] : IDENTITY;
            R = mulAB(swingRotation(applyMat3(Rp, segC), segP), Rp);
        }
        rotations[j] = R;
    }
    return rotations;
}

export function applyMat3(R: Mat3, v: Vec3): Vec3 {
    return [
        R[0][0] * v[0] + R[0][1] * v[1] + R[0][2] * v[2],
        R[1][0] * v[0] + R[1][1] * v[1] + R[1][2] * v[2],
        R[2][0] * v[0] + R[2][1] * v[1] + R[2][2] * v[2]
    ];
}

/** LBS-deforms a canonical point: sum_k w_k * (posed[j_k] + R_jk (p - canonical[j_k])). */
export function skinPoint(
    p: Vec3,
    boneIndices: ArrayLike<number>,
    boneWeights: ArrayLike<number>,
    canonical: Vec3[],
    posed: Vec3[],
    rotations: Mat3[]
): Vec3 {
    let x = 0, y = 0, z = 0, wSum = 0;
    for (let k = 0; k < 4; k++) {
        const w = boneWeights[k];
        const j = boneIndices[k];
        if (!(w > 1e-6) || j >= rotations.length) continue;
        const r = applyMat3(rotations[j], sub(p, canonical[j]));
        x += w * (posed[j][0] + r[0]);
        y += w * (posed[j][1] + r[1]);
        z += w * (posed[j][2] + r[2]);
        wSum += w;
    }
    return wSum > 1e-6 ? [x / wSum, y / wSum, z / wSum] : [p[0], p[1], p[2]];
}

export function mat3ToQuat(m: Mat3): [number, number, number, number] {
    const tr = m[0][0] + m[1][1] + m[2][2];
    let qx: number, qy: number, qz: number, qw: number;
    if (tr > 0) {
        const s = 0.5 / Math.sqrt(tr + 1);
        qw = 0.25 / s; qx = (m[2][1] - m[1][2]) * s; qy = (m[0][2] - m[2][0]) * s; qz = (m[1][0] - m[0][1]) * s;
    } else if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) {
        const s = 2 * Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]);
        qw = (m[2][1] - m[1][2]) / s; qx = 0.25 * s; qy = (m[0][1] + m[1][0]) / s; qz = (m[0][2] + m[2][0]) / s;
    } else if (m[1][1] > m[2][2]) {
        const s = 2 * Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]);
        qw = (m[0][2] - m[2][0]) / s; qx = (m[0][1] + m[1][0]) / s; qy = 0.25 * s; qz = (m[1][2] + m[2][1]) / s;
    } else {
        const s = 2 * Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]);
        qw = (m[1][0] - m[0][1]) / s; qx = (m[0][2] + m[2][0]) / s; qy = (m[1][2] + m[2][1]) / s; qz = 0.25 * s;
    }
    return [qx, qy, qz, qw];
}

/** Hamilton product a * b, both (x, y, z, w). */
export function quatMultiply(a: [number, number, number, number], b: [number, number, number, number]): [number, number, number, number] {
    return [
        a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
        a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
        a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
        a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
    ];
}

/**
 * Re-poses the canonical skeleton so every segment points along the matching segment of a
 * tracked source skeleton while keeping the avatar's own bone lengths. The pelvis is placed at
 * `rootPosition` (defaults to the canonical pelvis).
 */
export function retargetSegmentDirections(canonical: Vec3[], source: Vec3[], rootPosition?: Vec3): Vec3[] {
    const out: Vec3[] = new Array(canonical.length);
    out[0] = rootPosition ? [rootPosition[0], rootPosition[1], rootPosition[2]] : [canonical[0][0], canonical[0][1], canonical[0][2]];
    for (let j = 1; j < canonical.length; j++) {
        const p = SMPLX22_PARENTS[j];
        const len = Math.hypot(...sub(canonical[j], canonical[p]));
        const dir = normalize(sub(source[j], source[p])) || normalize(sub(canonical[j], canonical[p])) || [0, 1, 0];
        out[j] = [out[p][0] + dir[0] * len, out[p][1] + dir[1] * len, out[p][2] + dir[2] * len];
    }
    return out;
}
