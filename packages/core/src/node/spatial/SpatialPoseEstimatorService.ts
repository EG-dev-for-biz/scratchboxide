/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

export type Point2D = [number, number];
export type Point3D = [number, number, number];

export interface CameraIntrinsics {
    fx: number;
    fy: number;
    cx: number;
    cy: number;
    width?: number;
    height?: number;
}

export interface SolvedCameraPose {
    /** 3x3 orthonormal rotation matrix in camera-from-world coordinates (v_cam = R * v_world + t) */
    rotationMatrix: number[][];
    /** Rotation quaternion [qx, qy, qz, qw] */
    quaternion: [number, number, number, number];
    /** Camera optical center position in world / ENU coordinates [X, Y, Z] */
    cameraCenterWorld: Point3D;
    /** Camera translation vector t in camera frame (v_cam = R * v_world + t) */
    translationCamera: Point3D;
    /** Camera attitude Euler angles (degrees) */
    attitude: {
        headingDeg: number; // clockwise from North (yaw)
        pitchDeg: number;   // pitch up/down (-90 to +90)
        rollDeg: number;    // roll angle
    };
    /** Camera focal length in pixels */
    focalLengthPx: number;
    /** Vertical Field of View in degrees */
    fovYDeg: number;
    /** Horizontal Field of View in degrees */
    fovXDeg: number;
    /** Reprojection error per point in pixels */
    reprojectionErrorsPx: number[];
    /** Mean reprojection error in pixels */
    meanReprojectionErrorPx: number;
    /** Maximum reprojection error in pixels */
    maxReprojectionErrorPx: number;
    /** Number of iterations used in Levenberg-Marquardt optimization */
    iterations: number;
    /** Did the solver converge */
    converged: boolean;
}

export interface PnPOptions {
    /** Refine pose with Levenberg-Marquardt non-linear optimization (default: true) */
    refineLevenbergMarquardt?: boolean;
    /** Maximum LM iterations (default: 30) */
    maxIterations?: number;
    /** Convergence tolerance on error delta (default: 1e-6) */
    tolerance?: number;
}

export interface PnPRansacOptions extends PnPOptions {
    /** Inlier reprojection error threshold in pixels (default: 2.5) */
    inlierThresholdPx?: number;
    /** Maximum RANSAC hypothesis iterations (default: 200) */
    maxRansacIterations?: number;
    /** Desired probability of finding an all-inlier sample (default: 0.99) */
    confidence?: number;
}

export interface PnPRansacResult {
    pose: SolvedCameraPose;
    inlierIndices: number[];
    inlierCount: number;
    totalCount: number;
    inlierRatio: number;
    /**
     * True when RANSAC found a hypothesis supported by >= PNP_RANSAC_SAMPLE_SIZE inliers. False means
     * no consensus was reached: `pose` is the all-points estimate and the inlier fields report the
     * correspondences actually within the threshold for that pose.
     */
    consensus: boolean;
}

// ============================================================================
// Core Linear Algebra Utilities (SVD, Procrustes, Inversion)
// ============================================================================

/**
 * Multiplies two matrices A (m x k) and B (k x n) -> (m x n)
 */
export function matrixMultiply(A: number[][], B: number[][]): number[][] {
    const m = A.length;
    const k = A[0].length;
    const n = B[0].length;
    const C: number[][] = Array.from({ length: m }, () => new Array(n).fill(0));
    for (let i = 0; i < m; i++) {
        for (let p = 0; p < k; p++) {
            const a = A[i][p];
            if (a === 0) continue;
            for (let j = 0; j < n; j++) {
                C[i][j] += a * B[p][j];
            }
        }
    }
    return C;
}

/**
 * Transposes an m x n matrix
 */
export function matrixTranspose(A: number[][]): number[][] {
    const m = A.length;
    const n = A[0].length;
    const T: number[][] = Array.from({ length: n }, () => new Array(m).fill(0));
    for (let i = 0; i < m; i++) {
        for (let j = 0; j < n; j++) {
            T[j][i] = A[i][j];
        }
    }
    return T;
}

/**
 * Multiplies 3x3 matrix by 3D vector
 */
export function transformVec3(M: number[][], v: Point3D): Point3D {
    return [
        M[0][0] * v[0] + M[0][1] * v[1] + M[0][2] * v[2],
        M[1][0] * v[0] + M[1][1] * v[1] + M[1][2] * v[2],
        M[2][0] * v[0] + M[2][1] * v[1] + M[2][2] * v[2]
    ];
}

/**
 * Inverts a 3x3 matrix. Returns null if singular.
 */
export function invert3x3(A: number[][]): number[][] | null {
    const det =
        A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1]) -
        A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0]) +
        A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0]);

    if (Math.abs(det) < 1e-12) return null;
    const invDet = 1.0 / det;

    return [
        [
            (A[1][1] * A[2][2] - A[1][2] * A[2][1]) * invDet,
            (A[0][2] * A[2][1] - A[0][1] * A[2][2]) * invDet,
            (A[0][1] * A[1][2] - A[0][2] * A[1][1]) * invDet
        ],
        [
            (A[1][2] * A[2][0] - A[1][0] * A[2][2]) * invDet,
            (A[0][0] * A[2][2] - A[0][2] * A[2][0]) * invDet,
            (A[0][2] * A[1][0] - A[0][0] * A[1][2]) * invDet
        ],
        [
            (A[1][0] * A[2][1] - A[1][1] * A[2][0]) * invDet,
            (A[0][1] * A[2][0] - A[0][0] * A[2][1]) * invDet,
            (A[0][0] * A[1][1] - A[0][1] * A[1][0]) * invDet
        ]
    ];
}

/**
 * Computes SVD of a general matrix A (m x n) using one-sided Jacobi orthogonalization.
 * A = U * S * V^T, where U is m x n, S is n, V is n x n.
 * Returns { U, S, V } where V is the right singular vectors matrix (columns of V).
 */
export function svdJacobi(A: number[][], maxSweeps: number = 40): { U: number[][]; S: number[]; V: number[][] } {
    const m = A.length;
    const n = A[0].length;

    // Work on copy of A, which becomes U * S
    const B: number[][] = A.map(row => [...row]);
    // Initialize V to n x n identity
    const V: number[][] = Array.from({ length: n }, (_, i) => {
        const row = new Array(n).fill(0);
        row[i] = 1.0;
        return row;
    });

    const eps = 1e-12;
    // Columns whose energy has collapsed to round-off (null-space directions, e.g. when m < n) must
    // not keep being rotated: they never satisfy the relative orthogonality test, prevent
    // convergence, and decay into slow subnormal arithmetic.
    let frobSq = 0;
    for (let k = 0; k < m; k++) {
        for (let j = 0; j < n; j++) frobSq += A[k][j] * A[k][j];
    }
    const negligibleColumnSq = 1e-28 * frobSq;

    for (let sweep = 0; sweep < maxSweeps; sweep++) {
        let converged = true;

        for (let i = 0; i < n - 1; i++) {
            for (let j = i + 1; j < n; j++) {
                // Compute column inner products: b_i . b_i, b_j . b_j, b_i . b_j
                let alpha = 0;
                let beta = 0;
                let gamma = 0;

                for (let k = 0; k < m; k++) {
                    alpha += B[k][i] * B[k][i];
                    beta += B[k][j] * B[k][j];
                    gamma += B[k][i] * B[k][j];
                }

                if (alpha <= negligibleColumnSq || beta <= negligibleColumnSq || Math.abs(gamma) <= eps * Math.sqrt(alpha * beta)) {
                    continue;
                }
                converged = false;

                // Jacobi rotation angle
                const zeta = (beta - alpha) / (2.0 * gamma);
                const t = (zeta >= 0 ? 1.0 : -1.0) / (Math.abs(zeta) + Math.sqrt(1.0 + zeta * zeta));
                const c = 1.0 / Math.sqrt(1.0 + t * t);
                const s = t * c;

                // Rotate columns i and j of B
                for (let k = 0; k < m; k++) {
                    const bi = B[k][i];
                    const bj = B[k][j];
                    B[k][i] = c * bi - s * bj;
                    B[k][j] = s * bi + c * bj;
                }

                // Accumulate into V
                for (let k = 0; k < n; k++) {
                    const vi = V[k][i];
                    const vj = V[k][j];
                    V[k][i] = c * vi - s * vj;
                    V[k][j] = s * vi + c * vj;
                }
            }
        }

        if (converged) break;
    }

    // Singular values are column norms of B
    const S: number[] = new Array(n).fill(0);
    const U: number[][] = Array.from({ length: m }, () => new Array(n).fill(0));

    for (let j = 0; j < n; j++) {
        let norm = 0;
        for (let i = 0; i < m; i++) {
            norm += B[i][j] * B[i][j];
        }
        norm = Math.sqrt(norm);
        S[j] = norm;

        if (norm > eps) {
            for (let i = 0; i < m; i++) {
                U[i][j] = B[i][j] / norm;
            }
        }
    }

    return { U, S, V };
}

/**
 * Determinant of a 3x3 matrix.
 */
export function determinant3x3(M: number[][]): number {
    return (
        M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) -
        M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) +
        M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0])
    );
}

/**
 * Recovers closest orthonormal rotation matrix R from general 3x3 matrix M using SVD Procrustes.
 * Ensures det(R) = +1 (proper rotation in SO(3)): R = U * diag(1, 1, det(U V^T)) * V^T, where the
 * sign correction is applied to the singular direction with the SMALLEST singular value.
 * Rank-2 inputs (e.g. Kabsch cross-covariance of coplanar points) are supported by completing
 * the degenerate left singular vector with a cross product.
 */
export function orthonormalizeRotation3x3(M: number[][]): number[][] {
    const { U, S, V } = svdJacobi(M, 30);
    // svdJacobi does not sort singular values: locate the weakest direction explicitly.
    const order = [0, 1, 2].sort((a, b) => S[b] - S[a]);
    const [a, b, k] = order;
    const Uc = U.map(row => [...row]);

    if (S[k] <= 1e-12 * Math.max(S[a], 1e-300)) {
        // Degenerate (rank-2) input: U[:, k] is zero, so complete it as u_a x u_b.
        const ua = [Uc[0][a], Uc[1][a], Uc[2][a]];
        const ub = [Uc[0][b], Uc[1][b], Uc[2][b]];
        Uc[0][k] = ua[1] * ub[2] - ua[2] * ub[1];
        Uc[1][k] = ua[2] * ub[0] - ua[0] * ub[2];
        Uc[2][k] = ua[0] * ub[1] - ua[1] * ub[0];
    }

    const VT = matrixTranspose(V);
    let R = matrixMultiply(Uc, VT);

    if (determinant3x3(R) < 0) {
        // det(U V^T) = -1: flip the weakest singular direction, i.e. R = U diag(..,-1,..) V^T
        for (let r = 0; r < 3; r++) {
            Uc[r][k] = -Uc[r][k];
        }
        R = matrixMultiply(Uc, VT);
    }

    return R;
}

/**
 * Converts 3x3 rotation matrix to quaternion [qx, qy, qz, qw]
 */
export function rotationMatrixToQuaternion(R: number[][]): [number, number, number, number] {
    const trace = R[0][0] + R[1][1] + R[2][2];
    let qx: number, qy: number, qz: number, qw: number;

    if (trace > 0) {
        const s = 0.5 / Math.sqrt(trace + 1.0);
        qw = 0.25 / s;
        qx = (R[2][1] - R[1][2]) * s;
        qy = (R[0][2] - R[2][0]) * s;
        qz = (R[1][0] - R[0][1]) * s;
    } else if (R[0][0] > R[1][1] && R[0][0] > R[2][2]) {
        const s = 2.0 * Math.sqrt(1.0 + R[0][0] - R[1][1] - R[2][2]);
        qw = (R[2][1] - R[1][2]) / s;
        qx = 0.25 * s;
        qy = (R[0][1] + R[1][0]) / s;
        qz = (R[0][2] + R[2][0]) / s;
    } else if (R[1][1] > R[2][2]) {
        const s = 2.0 * Math.sqrt(1.0 + R[1][1] - R[0][0] - R[2][2]);
        qw = (R[0][2] - R[2][0]) / s;
        qx = (R[0][1] + R[1][0]) / s;
        qy = 0.25 * s;
        qz = (R[1][2] + R[2][1]) / s;
    } else {
        const s = 2.0 * Math.sqrt(1.0 + R[2][2] - R[0][0] - R[1][1]);
        qw = (R[1][0] - R[0][1]) / s;
        qx = (R[0][2] + R[2][0]) / s;
        qy = (R[1][2] + R[2][1]) / s;
        qz = 0.25 * s;
    }

    const len = Math.hypot(qx, qy, qz, qw);
    return [qx / len, qy / len, qz / len, qw / len];
}

/**
 * Converts 3x3 rotation matrix to attitude Euler angles (heading, pitch, roll) in degrees.
 * World convention: +Y is Up, +X is East, -Z is North.
 */
export function rotationMatrixToAttitude(R: number[][]): { headingDeg: number; pitchDeg: number; rollDeg: number } {
    const pitchRad = Math.asin(Math.max(-1.0, Math.min(1.0, -R[1][2])));
    let rollRad = 0;
    let headingRad = 0;

    if (Math.abs(Math.cos(pitchRad)) > 1e-4) {
        rollRad = Math.atan2(R[1][0], R[1][1]);
        headingRad = Math.atan2(R[0][2], R[2][2]);
    } else {
        rollRad = Math.atan2(-R[0][1], R[0][0]);
    }

    let headingDeg = (headingRad * 180.0) / Math.PI;
    if (headingDeg < 0) headingDeg += 360.0;

    return {
        headingDeg,
        pitchDeg: (pitchRad * 180.0) / Math.PI,
        rollDeg: (rollRad * 180.0) / Math.PI
    };
}

/**
 * Converts axis-angle rotation vector [wx, wy, wz] to 3x3 rotation matrix via Rodrigues' formula
 */
export function rodriguesToRotationMatrix(w: [number, number, number]): number[][] {
    const theta = Math.hypot(w[0], w[1], w[2]);
    if (theta < 1e-8) {
        return [
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, 1]
        ];
    }

    const kx = w[0] / theta;
    const ky = w[1] / theta;
    const kz = w[2] / theta;

    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);
    const oneMinusCos = 1.0 - cosT;

    return [
        [
            cosT + kx * kx * oneMinusCos,
            kx * ky * oneMinusCos - kz * sinT,
            kx * kz * oneMinusCos + ky * sinT
        ],
        [
            ky * kx * oneMinusCos + kz * sinT,
            cosT + ky * ky * oneMinusCos,
            ky * kz * oneMinusCos - kx * sinT
        ],
        [
            kz * kx * oneMinusCos - ky * sinT,
            kz * ky * oneMinusCos + kx * sinT,
            cosT + kz * kz * oneMinusCos
        ]
    ];
}

/**
 * Converts 3x3 rotation matrix to axis-angle rotation vector [wx, wy, wz]
 */
export function rotationMatrixToRodrigues(R: number[][]): [number, number, number] {
    const trace = R[0][0] + R[1][1] + R[2][2];
    const cosTheta = Math.max(-1.0, Math.min(1.0, (trace - 1.0) * 0.5));
    const theta = Math.acos(cosTheta);

    if (theta < 1e-7) {
        return [0, 0, 0];
    }

    if (Math.PI - theta < 1e-3) {
        // Near theta = pi the antisymmetric part vanishes; recover the axis from the symmetric part:
        // (R + I) / 2 = cos^2-weighted k k^T  ->  pick the best-conditioned column.
        const B = [
            [(R[0][0] + 1) * 0.5, (R[0][1] + R[1][0]) * 0.25, (R[0][2] + R[2][0]) * 0.25],
            [(R[0][1] + R[1][0]) * 0.25, (R[1][1] + 1) * 0.5, (R[1][2] + R[2][1]) * 0.25],
            [(R[0][2] + R[2][0]) * 0.25, (R[1][2] + R[2][1]) * 0.25, (R[2][2] + 1) * 0.5]
        ];
        let col = 0;
        if (B[1][1] > B[col][col]) col = 1;
        if (B[2][2] > B[col][col]) col = 2;
        const norm = Math.hypot(B[0][col], B[1][col], B[2][col]) || 1;
        let k: [number, number, number] = [B[0][col] / norm, B[1][col] / norm, B[2][col] / norm];
        // Resolve the axis sign from the (small) antisymmetric part: it equals 2 sin(theta) k.
        const skew = [R[2][1] - R[1][2], R[0][2] - R[2][0], R[1][0] - R[0][1]];
        if (skew[0] * k[0] + skew[1] * k[1] + skew[2] * k[2] < 0) {
            k = [-k[0], -k[1], -k[2]];
        }
        return [k[0] * theta, k[1] * theta, k[2] * theta];
    }

    const factor = theta / (2.0 * Math.sin(theta));
    return [
        (R[2][1] - R[1][2]) * factor,
        (R[0][2] - R[2][0]) * factor,
        (R[1][0] - R[0][1]) * factor
    ];
}

// ============================================================================
// Perspective-n-Point Closed-Form Initializers (EPnP & DLT)
// ============================================================================

/**
 * Minimum number of 2D-3D correspondences accepted by solvePnP. EPnP is well-posed for 4 generic
 * (non-collinear) points, both coplanar and non-coplanar.
 */
export const PNP_MIN_CORRESPONDENCES = 4;

/**
 * Minimum number of NON-COPLANAR correspondences for the 12-unknown (11 DOF) projective DLT, which
 * contributes 2 equations per point. Below this the DLT null space is multi-dimensional and the
 * solution is arbitrary, so DLT is only used as an additional candidate from 6 points upward.
 */
export const PNP_DLT_MIN_CORRESPONDENCES = 6;

/** RANSAC minimal sample size (EPnP minimal configuration). */
export const PNP_RANSAC_SAMPLE_SIZE = PNP_MIN_CORRESPONDENCES;

/**
 * Relative variance of the weakest PCA axis below which a 3D point configuration is treated as
 * coplanar by EPnP (thickness < 1% of the in-plane spread).
 */
const PNP_PLANAR_EIGEN_RATIO = 1e-4;

interface PoseCandidate {
    R: number[][];
    t: Point3D;
}

/** Gaussian elimination with partial pivoting for a small dense k x k system. */
function solveDenseLinearSystem(A: number[][], b: number[]): number[] | null {
    const n = b.length;
    const M = A.map((row, i) => [...row, b[i]]);
    for (let i = 0; i < n; i++) {
        let maxRow = i;
        for (let r = i + 1; r < n; r++) {
            if (Math.abs(M[r][i]) > Math.abs(M[maxRow][i])) maxRow = r;
        }
        if (Math.abs(M[maxRow][i]) < 1e-14) return null;
        if (maxRow !== i) {
            const tmp = M[i];
            M[i] = M[maxRow];
            M[maxRow] = tmp;
        }
        for (let r = i + 1; r < n; r++) {
            const f = M[r][i] / M[i][i];
            for (let c = i; c <= n; c++) M[r][c] -= f * M[i][c];
        }
    }
    const x = new Array(n).fill(0);
    for (let i = n - 1; i >= 0; i--) {
        let sum = M[i][n];
        for (let c = i + 1; c < n; c++) sum -= M[i][c] * x[c];
        x[i] = sum / M[i][i];
    }
    return x.every(Number.isFinite) ? x : null;
}

/** Least squares solve of an overdetermined (or square) system via regularized normal equations. */
function solveLeastSquares(A: number[][], b: number[]): number[] | null {
    const k = A[0].length;
    const AtA: number[][] = Array.from({ length: k }, () => new Array(k).fill(0));
    const Atb: number[] = new Array(k).fill(0);
    for (let r = 0; r < A.length; r++) {
        for (let i = 0; i < k; i++) {
            Atb[i] += A[r][i] * b[r];
            for (let j = 0; j < k; j++) AtA[i][j] += A[r][i] * A[r][j];
        }
    }
    let trace = 0;
    for (let i = 0; i < k; i++) trace += AtA[i][i];
    const damping = 1e-12 * (trace / k + 1e-300);
    for (let i = 0; i < k; i++) AtA[i][i] += damping;
    return solveDenseLinearSystem(AtA, Atb);
}

/** Right singular vectors of A sorted by ascending singular value. */
function rightSingularVectorsAscending(A: number[][], maxSweeps: number): { values: number[]; vectors: number[][] } {
    const { S, V } = svdJacobi(A, maxSweeps);
    const order = S.map((_, i) => i).sort((a, b) => S[a] - S[b]);
    return {
        values: order.map(i => S[i]),
        vectors: order.map(i => V.map(row => row[i]))
    };
}

/** RMS pixel reprojection error of a pose candidate (points behind the camera are heavily penalized). */
function poseReprojectionRmsPx(
    points3D: Point3D[],
    points2D: Point2D[],
    intrinsics: CameraIntrinsics,
    R: number[][],
    t: Point3D
): number {
    const { fx, fy, cx, cy } = intrinsics;
    let sum = 0;
    for (let i = 0; i < points3D.length; i++) {
        const [X, Y, Z] = points3D[i];
        const zc = R[2][0] * X + R[2][1] * Y + R[2][2] * Z + t[2];
        if (!(zc > 1e-9)) {
            sum += 1e12;
            continue;
        }
        const xc = R[0][0] * X + R[0][1] * Y + R[0][2] * Z + t[0];
        const yc = R[1][0] * X + R[1][1] * Y + R[1][2] * Z + t[1];
        const du = fx * (xc / zc) + cx - points2D[i][0];
        const dv = fy * (yc / zc) + cy - points2D[i][1];
        sum += du * du + dv * dv;
    }
    return Math.sqrt(sum / points3D.length);
}

/** Multiplies two polynomials given as coefficient arrays (lowest degree first). */
function polyMul(a: number[], b: number[]): number[] {
    const out = new Array(a.length + b.length - 1).fill(0);
    for (let i = 0; i < a.length; i++) {
        for (let j = 0; j < b.length; j++) out[i + j] += a[i] * b[j];
    }
    return out;
}

function polyAdd(...polys: number[][]): number[] {
    const len = Math.max(...polys.map(p => p.length));
    const out = new Array(len).fill(0);
    for (const p of polys) {
        for (let i = 0; i < p.length; i++) out[i] += p[i];
    }
    return out;
}

function polyEval(p: number[], x: number): number {
    let y = 0;
    for (let i = p.length - 1; i >= 0; i--) y = y * x + p[i];
    return y;
}

/**
 * Real roots of a polynomial (coefficients lowest degree first) by recursive derivative bracketing:
 * the real roots of p' split the real line into monotone intervals of p, each holding at most one
 * root, which is isolated by bisection. Robust for the low degrees used here (<= 4).
 */
function polynomialRealRoots(coeffs: number[]): number[] {
    const p = [...coeffs];
    while (p.length > 1 && Math.abs(p[p.length - 1]) < 1e-14 * Math.max(...p.map(Math.abs), 1e-300)) p.pop();
    const deg = p.length - 1;
    if (deg < 1) return [];
    if (deg === 1) return [-p[0] / p[1]];

    const lead = p[deg];
    let bound = 0;
    for (let i = 0; i < deg; i++) bound = Math.max(bound, Math.abs(p[i] / lead));
    bound += 1; // Cauchy bound

    const derivative = p.slice(1).map((c, i) => c * (i + 1));
    const criticals = polynomialRealRoots(derivative).filter(x => x > -bound && x < bound).sort((x, y) => x - y);
    const knots = [-bound, ...criticals, bound];

    const roots: number[] = [];
    for (let k = 0; k < knots.length - 1; k++) {
        let lo = knots[k];
        let hi = knots[k + 1];
        let flo = polyEval(p, lo);
        const fhi = polyEval(p, hi);
        if (flo === 0) {
            roots.push(lo);
            continue;
        }
        if (flo * fhi > 0) continue;
        for (let it = 0; it < 200 && hi - lo > 1e-15 * Math.max(1, Math.abs(lo)); it++) {
            const mid = 0.5 * (lo + hi);
            const fm = polyEval(p, mid);
            if (fm === 0) {
                lo = hi = mid;
                break;
            }
            if (flo * fm < 0) {
                hi = mid;
            } else {
                lo = mid;
                flo = fm;
            }
        }
        roots.push(0.5 * (lo + hi));
    }
    if (polyEval(p, bound) === 0) roots.push(bound);
    return roots;
}

/**
 * Grunert's P3P (see Haralick et al. 1994): solves the three law-of-cosines constraints for the
 * distances s_i of three world points along their unit bearing rays, then aligns world and camera
 * triangles with a det(R) = +1 Procrustes fit. Returns up to 4 candidate poses.
 */
function solveP3P(world: Point3D[], normalized: Point2D[]): PoseCandidate[] {
    const bearings = normalized.map(([x, y]) => {
        const len = Math.hypot(x, y, 1);
        return [x / len, y / len, 1 / len];
    });
    const dot3 = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const dist2 = (a: Point3D, b: Point3D) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

    const a2 = dist2(world[1], world[2]);
    const b2 = dist2(world[0], world[2]);
    const c2 = dist2(world[0], world[1]);
    if (a2 < 1e-18 || b2 < 1e-18 || c2 < 1e-18) return [];
    const cosAlpha = dot3(bearings[1], bearings[2]);
    const cosBeta = dot3(bearings[0], bearings[2]);
    const cosGamma = dot3(bearings[0], bearings[1]);

    // s2 = u s1, s3 = v s1; q(v) = 1 + v^2 - 2 v cos(beta) so that s1^2 q(v) = b^2.
    const K1 = a2 / b2;
    const K2 = c2 / b2;
    const q = [1, -2 * cosBeta, 1];
    // u = N(v) / D(v),  N = (K1 - K2) q(v) + 1 - v^2,  D = 2 (cos(gamma) - v cos(alpha))
    const N = polyAdd(q.map(c => c * (K1 - K2)), [1, 0, -1]);
    const D = [2 * cosGamma, -2 * cosAlpha];
    // Substitute into 1 + u^2 - 2 u cos(gamma) = K2 q(v), multiplied through by D^2:
    // N^2 - 2 cos(gamma) N D + (1 - K2 q) D^2 = 0  (quartic in v)
    const quartic = polyAdd(
        polyMul(N, N),
        polyMul(N, D).map(c => -2 * cosGamma * c),
        polyMul(polyAdd([1], q.map(c => -K2 * c)), polyMul(D, D))
    );

    const candidates: PoseCandidate[] = [];
    for (const v of polynomialRealRoots(quartic)) {
        if (!(v > 0)) continue;
        const Dv = polyEval(D, v);
        if (Math.abs(Dv) < 1e-12) continue;
        const u = polyEval(N, v) / Dv;
        if (!(u > 0)) continue;
        const qv = polyEval(q, v);
        if (!(qv > 0)) continue;
        const s1 = Math.sqrt(b2 / qv);
        const s = [s1, u * s1, v * s1];
        const cam: Point3D[] = bearings.map((bv, i) => [bv[0] * s[i], bv[1] * s[i], bv[2] * s[i]] as Point3D);
        candidates.push(rigidAlign(world, cam));
    }
    return candidates;
}

/** Kabsch / Procrustes: rigid (R, t) with det(R) = +1 minimizing sum |R w_i + t - c_i|^2. */
function rigidAlign(world: Point3D[], cam: Point3D[]): PoseCandidate {
    const n = world.length;
    const wBar: Point3D = [0, 0, 0];
    const cBar: Point3D = [0, 0, 0];
    for (let i = 0; i < n; i++) {
        for (let r = 0; r < 3; r++) {
            wBar[r] += world[i][r] / n;
            cBar[r] += cam[i][r] / n;
        }
    }
    const H: number[][] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < n; i++) {
        for (let r = 0; r < 3; r++) {
            for (let c = 0; c < 3; c++) H[r][c] += (cam[i][r] - cBar[r]) * (world[i][c] - wBar[c]);
        }
    }
    const R = orthonormalizeRotation3x3(H);
    const t: Point3D = [
        cBar[0] - (R[0][0] * wBar[0] + R[0][1] * wBar[1] + R[0][2] * wBar[2]),
        cBar[1] - (R[1][0] * wBar[0] + R[1][1] * wBar[1] + R[1][2] * wBar[2]),
        cBar[2] - (R[2][0] * wBar[0] + R[2][1] * wBar[1] + R[2][2] * wBar[2])
    ];
    return { R, t };
}

/**
 * EPnP (Lepetit, Moreno-Noguer & Fua 2009) closed-form pose for n >= 4 correspondences.
 * Points are expressed as barycentric combinations of PCA control points (4 for general 3D
 * configurations, 3 for coplanar ones); the camera-frame control points lie in the null space of
 * the 2n x 3k projection system and are recovered by matching inter-control-point distances
 * (linearized beta initializations for N = 1..3 null vectors, then Gauss-Newton on all betas).
 * The final rotation comes from a det(R) = +1 Kabsch/Procrustes alignment.
 */
function solveEPnP(
    points3D: Point3D[],
    points2D: Point2D[],
    normalized2D: Point2D[],
    intrinsics: CameraIntrinsics
): { candidate: PoseCandidate; planar: boolean } {
    const n = points3D.length;

    // 1. PCA of the world points -> control points
    const centroid: Point3D = [0, 0, 0];
    for (const p of points3D) {
        centroid[0] += p[0] / n;
        centroid[1] += p[1] / n;
        centroid[2] += p[2] / n;
    }
    const cov: number[][] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (const p of points3D) {
        const d = [p[0] - centroid[0], p[1] - centroid[1], p[2] - centroid[2]];
        for (let r = 0; r < 3; r++) {
            for (let c = 0; c < 3; c++) cov[r][c] += d[r] * d[c];
        }
    }
    const pca = rightSingularVectorsAscending(cov, 40); // symmetric PSD: singular values = eigenvalues
    const lambdaMax = pca.values[2];
    if (!(lambdaMax > 1e-18)) {
        throw new Error('solvePnP: degenerate 3D configuration (all points coincide); camera pose is unobservable.');
    }
    if (pca.values[1] < 1e-10 * lambdaMax) {
        throw new Error('solvePnP: degenerate 3D configuration (all points are collinear); camera pose is unobservable.');
    }
    const planar = pca.values[0] < PNP_PLANAR_EIGEN_RATIO * lambdaMax;
    const axisIdx = planar ? [2, 1] : [2, 1, 0];
    const axes = axisIdx.map(k => pca.vectors[k]);
    const axisScales = axisIdx.map(k => Math.sqrt(pca.values[k] / n));
    const nc = axes.length + 1;

    const controlsWorld: Point3D[] = [
        [...centroid] as Point3D,
        ...axes.map((v, k) => [
            centroid[0] + axisScales[k] * v[0],
            centroid[1] + axisScales[k] * v[1],
            centroid[2] + axisScales[k] * v[2]
        ] as Point3D)
    ];

    // 2. Barycentric coordinates (orthonormal PCA basis -> simple projections)
    const alphas: number[][] = points3D.map(p => {
        const d = [p[0] - centroid[0], p[1] - centroid[1], p[2] - centroid[2]];
        const a = axes.map((v, k) => (d[0] * v[0] + d[1] * v[1] + d[2] * v[2]) / axisScales[k]);
        return [1 - a.reduce((s, x) => s + x, 0), ...a];
    });

    // 3. Projection system M (2n x 3nc) on normalized image coordinates
    const M: number[][] = [];
    for (let i = 0; i < n; i++) {
        const [u, v] = normalized2D[i];
        const row1 = new Array(3 * nc).fill(0);
        const row2 = new Array(3 * nc).fill(0);
        for (let j = 0; j < nc; j++) {
            const a = alphas[i][j];
            row1[3 * j] = a;
            row1[3 * j + 2] = -a * u;
            row2[3 * j + 1] = a;
            row2[3 * j + 2] = -a * v;
        }
        M.push(row1, row2);
    }
    const nullVecs = rightSingularVectorsAscending(M, 60).vectors.slice(0, nc);

    // 4. Distance constraints between control point pairs
    const pairs: { dw: number; dv: number[][] }[] = [];
    for (let j = 0; j < nc; j++) {
        for (let k = j + 1; k < nc; k++) {
            const cj = controlsWorld[j];
            const ck = controlsWorld[k];
            const dw = (cj[0] - ck[0]) ** 2 + (cj[1] - ck[1]) ** 2 + (cj[2] - ck[2]) ** 2;
            const dv = nullVecs.map(vec => [
                vec[3 * j] - vec[3 * k],
                vec[3 * j + 1] - vec[3 * k + 1],
                vec[3 * j + 2] - vec[3 * k + 2]
            ]);
            pairs.push({ dw, dv });
        }
    }
    const dot3 = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

    // 5. Beta initializations
    const initialBetas: number[][] = [];
    {
        // N = 1: closed-form scale matching
        let num = 0;
        let den = 0;
        for (const pr of pairs) {
            const len = Math.sqrt(dot3(pr.dv[0], pr.dv[0]));
            num += len * Math.sqrt(pr.dw);
            den += len * len;
        }
        if (den > 0) {
            const b = new Array(nc).fill(0);
            b[0] = num / den;
            initialBetas.push(b);
        }
    }
    for (const N of [2, 3]) {
        if (N > nc) continue;
        const terms: [number, number][] = [];
        for (let a = 0; a < N; a++) {
            for (let b = a; b < N; b++) terms.push([a, b]);
        }
        if (pairs.length < terms.length) continue;
        const L = pairs.map(pr => terms.map(([a, b]) => (a === b ? 1 : 2) * dot3(pr.dv[a], pr.dv[b])));
        const x = solveLeastSquares(L, pairs.map(pr => pr.dw));
        if (!x) continue;
        const sign = x[0] < 0 ? -1 : 1;
        const beta0 = Math.sqrt(Math.abs(x[0]));
        if (beta0 < 1e-12) continue;
        const b = new Array(nc).fill(0);
        b[0] = beta0;
        for (let a = 1; a < N; a++) {
            const idx = terms.findIndex(([p, q]) => p === 0 && q === a);
            b[a] = (sign * x[idx]) / beta0;
        }
        initialBetas.push(b);
    }

    // 6. Gauss-Newton refinement of betas on all control-pair distance constraints
    const refineBetas = (init: number[]): number[] => {
        const betas = [...init];
        for (let iter = 0; iter < 10; iter++) {
            const J: number[][] = [];
            const r: number[] = [];
            for (const pr of pairs) {
                const d = [0, 0, 0];
                for (let a = 0; a < nc; a++) {
                    d[0] += betas[a] * pr.dv[a][0];
                    d[1] += betas[a] * pr.dv[a][1];
                    d[2] += betas[a] * pr.dv[a][2];
                }
                r.push(-(dot3(d, d) - pr.dw));
                J.push(pr.dv.map(dva => 2 * dot3(d, dva)));
            }
            const delta = solveLeastSquares(J, r);
            if (!delta) break;
            let stepNorm = 0;
            for (let a = 0; a < nc; a++) {
                betas[a] += delta[a];
                stepNorm += delta[a] * delta[a];
            }
            if (stepNorm < 1e-24) break;
        }
        return betas;
    };

    // 7. Pose from betas via Kabsch (det(R) = +1)
    const worldProjected: Point3D[] = alphas.map(al => {
        const p: Point3D = [0, 0, 0];
        for (let j = 0; j < nc; j++) {
            p[0] += al[j] * controlsWorld[j][0];
            p[1] += al[j] * controlsWorld[j][1];
            p[2] += al[j] * controlsWorld[j][2];
        }
        return p;
    });
    const poseFromBetas = (betas: number[]): PoseCandidate | null => {
        const controlsCam: Point3D[] = [];
        for (let j = 0; j < nc; j++) {
            const c: Point3D = [0, 0, 0];
            for (let a = 0; a < nc; a++) {
                c[0] += betas[a] * nullVecs[a][3 * j];
                c[1] += betas[a] * nullVecs[a][3 * j + 1];
                c[2] += betas[a] * nullVecs[a][3 * j + 2];
            }
            controlsCam.push(c);
        }
        let pc: Point3D[] = alphas.map(al => {
            const p: Point3D = [0, 0, 0];
            for (let j = 0; j < nc; j++) {
                p[0] += al[j] * controlsCam[j][0];
                p[1] += al[j] * controlsCam[j][1];
                p[2] += al[j] * controlsCam[j][2];
            }
            return p;
        });
        // Null-space solutions are defined up to sign: enforce cheirality (points in front of camera)
        // by negating the whole camera-frame structure before the rotation fit.
        const meanZ = pc.reduce((s, p) => s + p[2], 0) / n;
        if (meanZ < 0) pc = pc.map(p => [-p[0], -p[1], -p[2]] as Point3D);

        const cand = rigidAlign(worldProjected, pc);
        return cand.R.every(row => row.every(Number.isFinite)) ? cand : null;
    };

    let best: PoseCandidate | null = null;
    let bestErr = Infinity;
    for (const init of initialBetas) {
        const cand = poseFromBetas(refineBetas(init));
        if (!cand) continue;
        const err = poseReprojectionRmsPx(points3D, points2D, intrinsics, cand.R, cand.t);
        if (err < bestErr) {
            bestErr = err;
            best = cand;
        }
    }
    if (!best) {
        throw new Error('solvePnP: EPnP failed to recover a finite pose from the given correspondences.');
    }
    return { candidate: best, planar };
}

/**
 * Projective DLT on normalized coordinates (12 unknowns, 2 equations per point). Requires
 * >= PNP_DLT_MIN_CORRESPONDENCES non-coplanar points. The homogeneous solution p is defined up to
 * sign, so the WHOLE projection [M | t] is negated when the majority of points would lie behind the
 * camera; the rotation is then the det = +1 SVD projection of M and t is rescaled by M's mean
 * singular value. Returns null when the solution is not a proper (det > 0) camera.
 */
function solveDLT(points3D: Point3D[], normalized2D: Point2D[]): PoseCandidate | null {
    const n = points3D.length;
    if (n < PNP_DLT_MIN_CORRESPONDENCES) return null;

    const A: number[][] = [];
    for (let i = 0; i < n; i++) {
        const [X, Y, Z] = points3D[i];
        const [u, v] = normalized2D[i];
        A.push([-X, -Y, -Z, -1, 0, 0, 0, 0, u * X, u * Y, u * Z, u]);
        A.push([0, 0, 0, 0, -X, -Y, -Z, -1, v * X, v * Y, v * Z, v]);
    }
    const p = rightSingularVectorsAscending(A, 40).vectors[0];

    let M_raw: number[][] = [
        [p[0], p[1], p[2]],
        [p[4], p[5], p[6]],
        [p[8], p[9], p[10]]
    ];
    let t_raw: Point3D = [p[3], p[7], p[11]];

    let positiveDepth = 0;
    for (const [X, Y, Z] of points3D) {
        if (M_raw[2][0] * X + M_raw[2][1] * Y + M_raw[2][2] * Z + t_raw[2] > 0) positiveDepth++;
    }
    if (positiveDepth < n / 2) {
        M_raw = M_raw.map(row => row.map(val => -val));
        t_raw = [-t_raw[0], -t_raw[1], -t_raw[2]];
    }
    if (!(determinant3x3(M_raw) > 0)) return null;

    const { S } = svdJacobi(M_raw, 30);
    const scale = (S[0] + S[1] + S[2]) / 3;
    if (!(scale > 1e-12)) return null;

    const R = orthonormalizeRotation3x3(M_raw);
    return { R, t: [t_raw[0] / scale, t_raw[1] / scale, t_raw[2] / scale] };
}

// ============================================================================
// Perspective-n-Point Core Algorithms (EPnP/DLT & Levenberg-Marquardt)
// ============================================================================

export class SpatialPoseEstimatorService {
    /**
     * Solves camera pose (rotation R and translation t) given >= PNP_MIN_CORRESPONDENCES (4)
     * non-collinear 3D-to-2D point correspondences and camera intrinsics.
     *
     * Closed-form initialization uses EPnP (valid for 4+ coplanar or non-coplanar points). With 4-5
     * points, Grunert P3P on every triplet (verified against the remaining points) is evaluated as
     * well; with >= PNP_DLT_MIN_CORRESPONDENCES (6) non-coplanar points the projective DLT is. The
     * lowest-reprojection-error candidate is kept and refined with Levenberg-Marquardt.
     *
     * @throws if fewer than 4 correspondences are supplied, counts mismatch, or the 3D points are
     *         coincident / collinear (pose unobservable).
     */
    public static solvePnP(
        points3D: Point3D[],
        points2D: Point2D[],
        intrinsics: CameraIntrinsics,
        options: PnPOptions = {}
    ): SolvedCameraPose {
        const n = points3D.length;
        if (n < PNP_MIN_CORRESPONDENCES) {
            throw new Error(
                `solvePnP requires at least ${PNP_MIN_CORRESPONDENCES} non-collinear point correspondences, received ${n}.`
            );
        }
        if (points2D.length !== n) {
            throw new Error(`solvePnP: 3D point count (${n}) does not match 2D point count (${points2D.length}).`);
        }

        const { fx, fy, cx, cy } = intrinsics;

        // 1. Normalized camera coordinates: x_n = (u - cx) / fx, y_n = (v - cy) / fy
        const normalized2D: Point2D[] = points2D.map(([u, v]) => [
            (u - cx) / fx,
            (v - cy) / fy
        ]);

        // 2-4. Closed-form candidates (EPnP always; DLT only when it is well-posed) -> keep the best
        const epnp = solveEPnP(points3D, points2D, normalized2D, intrinsics);
        let best: PoseCandidate = epnp.candidate;
        let bestErr = poseReprojectionRmsPx(points3D, points2D, intrinsics, best.R, best.t);
        if (!epnp.planar && n >= PNP_DLT_MIN_CORRESPONDENCES) {
            const dlt = solveDLT(points3D, normalized2D);
            if (dlt) {
                const dltErr = poseReprojectionRmsPx(points3D, points2D, intrinsics, dlt.R, dlt.t);
                if (dltErr < bestErr) {
                    best = dlt;
                    bestErr = dltErr;
                }
            }
        }
        if (n < PNP_DLT_MIN_CORRESPONDENCES) {
            // Few points: EPnP's distance-matching on a 3-4 dimensional null space can settle in a
            // spurious minimum, so also evaluate Grunert P3P on every point triplet and let the
            // remaining correspondences disambiguate (P3P + 1 verification).
            for (let i = 0; i < n; i++) {
                for (let j = i + 1; j < n; j++) {
                    for (let k = j + 1; k < n; k++) {
                        const triplet = [i, j, k];
                        for (const cand of solveP3P(triplet.map(x => points3D[x]), triplet.map(x => normalized2D[x]))) {
                            const err = poseReprojectionRmsPx(points3D, points2D, intrinsics, cand.R, cand.t);
                            if (err < bestErr) {
                                best = cand;
                                bestErr = err;
                            }
                        }
                    }
                }
            }
        }
        let R = best.R;
        let t: Point3D = [...best.t];

        // 5. Levenberg-Marquardt Non-linear Refinement
        let iterations = 0;
        let converged = true;

        if (options.refineLevenbergMarquardt !== false) {
            const refined = this.refineWithLevenbergMarquardt(
                points3D,
                points2D,
                intrinsics,
                R,
                t,
                options.maxIterations ?? 30,
                options.tolerance ?? 1e-6
            );
            R = refined.R;
            t = refined.t;
            iterations = refined.iterations;
            converged = refined.converged;
        }

        // 6. Camera Optical Center in World Coordinates: C = -R^T * t
        const RT = matrixTranspose(R);
        const cameraCenterWorld: Point3D = [
            -(RT[0][0] * t[0] + RT[0][1] * t[1] + RT[0][2] * t[2]),
            -(RT[1][0] * t[0] + RT[1][1] * t[1] + RT[1][2] * t[2]),
            -(RT[2][0] * t[0] + RT[2][1] * t[1] + RT[2][2] * t[2])
        ];

        // 7. Calculate reprojection errors
        const reprojectionErrorsPx: number[] = [];
        let totalErr = 0;
        let maxErr = 0;

        for (let i = 0; i < n; i++) {
            const [X, Y, Z] = points3D[i];
            const xc = R[0][0] * X + R[0][1] * Y + R[0][2] * Z + t[0];
            const yc = R[1][0] * X + R[1][1] * Y + R[1][2] * Z + t[1];
            const zc = Math.max(0.01, R[2][0] * X + R[2][1] * Y + R[2][2] * Z + t[2]);

            const projU = fx * (xc / zc) + cx;
            const projV = fy * (yc / zc) + cy;

            const err = Math.hypot(projU - points2D[i][0], projV - points2D[i][1]);
            reprojectionErrorsPx.push(err);
            totalErr += err;
            if (err > maxErr) maxErr = err;
        }

        const meanReprojectionErrorPx = totalErr / n;
        const maxReprojectionErrorPx = maxErr;
        if (meanReprojectionErrorPx < 0.05) {
            converged = true;
        }
        const quaternion = rotationMatrixToQuaternion(R);
        const attitude = rotationMatrixToAttitude(R);

        const imgHeight = intrinsics.height ?? cy * 2;
        const imgWidth = intrinsics.width ?? cx * 2;
        const fovYDeg = 2.0 * Math.atan(imgHeight / (2.0 * fy)) * (180.0 / Math.PI);
        const fovXDeg = 2.0 * Math.atan(imgWidth / (2.0 * fx)) * (180.0 / Math.PI);

        return {
            rotationMatrix: R,
            quaternion,
            cameraCenterWorld,
            translationCamera: t,
            attitude,
            focalLengthPx: fy,
            fovYDeg,
            fovXDeg,
            reprojectionErrorsPx,
            meanReprojectionErrorPx,
            maxReprojectionErrorPx,
            iterations,
            converged
        };
    }

    /**
     * RANSAC-wrapped Perspective-n-Point solver.
     * Robust to up to 50%+ outlier correspondences.
     *
     * Hypotheses are generated from PNP_RANSAC_SAMPLE_SIZE (4) point EPnP samples. If no hypothesis
     * reaches a consensus of at least PNP_RANSAC_SAMPLE_SIZE inliers, the pose is re-estimated on all
     * points and returned with `consensus: false` and the inliers ACTUALLY measured under the
     * threshold for that pose (never a fabricated 100% inlier set).
     */
    public static solvePnPRansac(
        points3D: Point3D[],
        points2D: Point2D[],
        intrinsics: CameraIntrinsics,
        options: PnPRansacOptions = {}
    ): PnPRansacResult {
        const n = points3D.length;
        if (n < PNP_RANSAC_SAMPLE_SIZE) {
            throw new Error(
                `solvePnPRansac requires at least ${PNP_RANSAC_SAMPLE_SIZE} non-collinear correspondences, received ${n}.`
            );
        }
        if (points2D.length !== n) {
            throw new Error(`solvePnPRansac: 3D point count (${n}) does not match 2D point count (${points2D.length}).`);
        }

        const inlierThresholdPx = options.inlierThresholdPx ?? 2.5;
        const maxRansacIterations = Math.min(500, Math.max(50, options.maxRansacIterations ?? 200));

        const measureInliers = (pose: SolvedCameraPose): number[] => {
            const inliers: number[] = [];
            const { fx, fy, cx, cy } = intrinsics;
            const R = pose.rotationMatrix;
            const t = pose.translationCamera;
            for (let i = 0; i < n; i++) {
                const [X, Y, Z] = points3D[i];
                const zc = R[2][0] * X + R[2][1] * Y + R[2][2] * Z + t[2];
                if (zc <= 0.01) continue; // Behind camera

                const xc = R[0][0] * X + R[0][1] * Y + R[0][2] * Z + t[0];
                const yc = R[1][0] * X + R[1][1] * Y + R[1][2] * Z + t[1];

                const projU = fx * (xc / zc) + cx;
                const projV = fy * (yc / zc) + cy;

                const err = Math.hypot(projU - points2D[i][0], projV - points2D[i][1]);
                if (err <= inlierThresholdPx) {
                    inliers.push(i);
                }
            }
            return inliers;
        };

        const buildResult = (pose: SolvedCameraPose, inliers: number[], consensus: boolean): PnPRansacResult => ({
            pose,
            inlierIndices: inliers,
            inlierCount: inliers.length,
            totalCount: n,
            inlierRatio: inliers.length / n,
            consensus
        });

        let bestInliers: number[] = [];
        let bestPose: SolvedCameraPose | null = null;

        // With exactly the minimal sample size every draw is the full set: evaluate it once.
        let iterations = n === PNP_RANSAC_SAMPLE_SIZE ? 1 : maxRansacIterations;
        const confidence = Math.min(0.999999, Math.max(0.5, options.confidence ?? 0.99));

        for (let iter = 0; iter < iterations; iter++) {
            // Sample distinct random points
            const sampleIndices: number[] = [];
            while (sampleIndices.length < PNP_RANSAC_SAMPLE_SIZE) {
                const idx = Math.floor(Math.random() * n);
                if (!sampleIndices.includes(idx)) {
                    sampleIndices.push(idx);
                }
            }

            const sample3D = sampleIndices.map(i => points3D[i]);
            const sample2D = sampleIndices.map(i => points2D[i]);

            try {
                // Refine candidate hypothesis with small number of LM iterations
                const candidatePose = this.solvePnP(sample3D, sample2D, intrinsics, {
                    refineLevenbergMarquardt: true,
                    maxIterations: 8
                });

                const currentInliers = measureInliers(candidatePose);

                if (currentInliers.length > bestInliers.length) {
                    bestInliers = currentInliers;
                    bestPose = candidatePose;

                    // Early exit if consensus is overwhelming (> 90%)
                    if (bestInliers.length >= n * 0.9) {
                        break;
                    }

                    // Adaptive termination: number of draws needed to sample at least one
                    // all-inlier minimal set with the requested confidence at the observed ratio.
                    const allInlierSampleProb = Math.pow(bestInliers.length / n, PNP_RANSAC_SAMPLE_SIZE);
                    if (allInlierSampleProb > 0 && allInlierSampleProb < 1) {
                        const required = Math.ceil(Math.log(1 - confidence) / Math.log(1 - allInlierSampleProb));
                        iterations = Math.min(iterations, Math.max(iter + 1, required));
                    }
                }
            } catch {
                // Degenerate sample (e.g. collinear points): draw again
                continue;
            }
        }

        if (!bestPose || bestInliers.length < PNP_RANSAC_SAMPLE_SIZE) {
            // No consensus: report the all-points estimate with its honest inlier set.
            const pose = this.solvePnP(points3D, points2D, intrinsics, options);
            return buildResult(pose, measureInliers(pose), false);
        }

        // Final refinement using ALL inliers with full Levenberg-Marquardt
        const inlier3D = bestInliers.map(i => points3D[i]);
        const inlier2D = bestInliers.map(i => points2D[i]);

        let refinedPose: SolvedCameraPose;
        try {
            refinedPose = this.solvePnP(inlier3D, inlier2D, intrinsics, {
                ...options,
                refineLevenbergMarquardt: true
            });
        } catch {
            refinedPose = bestPose;
        }

        // Re-evaluate inliers with final refined pose (keep the hypothesis if refinement regressed)
        let finalInliers = measureInliers(refinedPose);
        if (finalInliers.length < bestInliers.length) {
            refinedPose = bestPose;
            finalInliers = bestInliers;
        }

        return buildResult(refinedPose, finalInliers, finalInliers.length >= PNP_RANSAC_SAMPLE_SIZE);
    }

    /**
     * Levenberg-Marquardt non-linear least squares refinement on SO(3) x R^3
     */
    private static refineWithLevenbergMarquardt(
        points3D: Point3D[],
        points2D: Point2D[],
        intrinsics: CameraIntrinsics,
        R_init: number[][],
        t_init: Point3D,
        maxIterations: number,
        tolerance: number
    ): { R: number[][]; t: Point3D; iterations: number; converged: boolean } {
        const { fx, fy, cx, cy } = intrinsics;
        const n = points3D.length;

        // Current parameters: w (3) + t (3)
        let w = rotationMatrixToRodrigues(R_init);
        let t: Point3D = [...t_init];

        let lambda = 1e-3;
        let lastError = this.computeTotalResidualNorm(points3D, points2D, fx, fy, cx, cy, rodriguesToRotationMatrix(w), t);
        if (lastError < tolerance) {
            return {
                R: rodriguesToRotationMatrix(w),
                t,
                iterations: 0,
                converged: true
            };
        }

        let iter = 0;
        let converged = false;

        for (iter = 0; iter < maxIterations; iter++) {
            const R = rodriguesToRotationMatrix(w);

            const r: number[] = [];
            for (let i = 0; i < n; i++) {
                const [X, Y, Z] = points3D[i];
                const xc = R[0][0] * X + R[0][1] * Y + R[0][2] * Z + t[0];
                const yc = R[1][0] * X + R[1][1] * Y + R[1][2] * Z + t[1];
                const zc = Math.max(0.01, R[2][0] * X + R[2][1] * Y + R[2][2] * Z + t[2]);

                const u_pred = fx * (xc / zc) + cx;
                const v_pred = fy * (yc / zc) + cy;

                r.push(points2D[i][0] - u_pred);
                r.push(points2D[i][1] - v_pred);
            }

            // Compute exact Jacobian using central finite differences (6 parameters: w[0..2], t[0..2])
            const eps = 1e-6;
            const twoEps = 2.0 * eps;
            const J: number[][] = Array.from({ length: 2 * n }, () => new Array(6).fill(0));

            const params: [number, number, number, number, number, number] = [w[0], w[1], w[2], t[0], t[1], t[2]];

            for (let pIdx = 0; pIdx < 6; pIdx++) {
                const paramsPlus = [...params];
                const paramsMinus = [...params];
                paramsPlus[pIdx] += eps;
                paramsMinus[pIdx] -= eps;

                const R_plus = rodriguesToRotationMatrix([paramsPlus[0], paramsPlus[1], paramsPlus[2]]);
                const t_plus: Point3D = [paramsPlus[3], paramsPlus[4], paramsPlus[5]];

                const R_minus = rodriguesToRotationMatrix([paramsMinus[0], paramsMinus[1], paramsMinus[2]]);
                const t_minus: Point3D = [paramsMinus[3], paramsMinus[4], paramsMinus[5]];

                for (let i = 0; i < n; i++) {
                    const [X, Y, Z] = points3D[i];

                    // Plus
                    const zc_p = Math.max(0.01, R_plus[2][0] * X + R_plus[2][1] * Y + R_plus[2][2] * Z + t_plus[2]);
                    const xc_p = R_plus[0][0] * X + R_plus[0][1] * Y + R_plus[0][2] * Z + t_plus[0];
                    const yc_p = R_plus[1][0] * X + R_plus[1][1] * Y + R_plus[1][2] * Z + t_plus[1];
                    const u_p = fx * (xc_p / zc_p) + cx;
                    const v_p = fy * (yc_p / zc_p) + cy;

                    // Minus
                    const zc_m = Math.max(0.01, R_minus[2][0] * X + R_minus[2][1] * Y + R_minus[2][2] * Z + t_minus[2]);
                    const xc_m = R_minus[0][0] * X + R_minus[0][1] * Y + R_minus[0][2] * Z + t_minus[0];
                    const yc_m = R_minus[1][0] * X + R_minus[1][1] * Y + R_minus[1][2] * Z + t_minus[1];
                    const u_m = fx * (xc_m / zc_m) + cx;
                    const v_m = fy * (yc_m / zc_m) + cy;

                    J[2 * i][pIdx] = (u_p - u_m) / twoEps;
                    J[2 * i + 1][pIdx] = (v_p - v_m) / twoEps;
                }
            }

            const JT = matrixTranspose(J);
            const JTJ = matrixMultiply(JT, J); // 6x6
            const JTr = JT.map(row => {
                let sum = 0;
                for (let k = 0; k < r.length; k++) {
                    sum += row[k] * r[k];
                }
                return sum;
            });

            const A = JTJ.map((row, i) =>
                row.map((val, j) => (i === j ? val * (1.0 + lambda) + 1e-6 : val))
            );

            const delta = this.solveLinear6x6(A, JTr);
            if (!delta) {
                lambda *= 10.0;
                continue;
            }

            const w_new: [number, number, number] = [
                w[0] + delta[0],
                w[1] + delta[1],
                w[2] + delta[2]
            ];
            const t_new: Point3D = [
                t[0] + delta[3],
                t[1] + delta[4],
                t[2] + delta[5]
            ];

            const newError = this.computeTotalResidualNorm(
                points3D,
                points2D,
                fx,
                fy,
                cx,
                cy,
                rodriguesToRotationMatrix(w_new),
                t_new
            );

            if (newError < lastError) {
                if (newError < tolerance || Math.abs(lastError - newError) < tolerance) {
                    converged = true;
                }
                w = w_new;
                t = t_new;
                lastError = newError;
                lambda = Math.max(1e-7, lambda * 0.2);
                if (converged) break;
            } else {
                if (lastError < tolerance) {
                    converged = true;
                    break;
                }
                lambda = Math.min(1e5, lambda * 10.0);
            }
        }

        if (lastError < tolerance) {
            converged = true;
        }

        return {
            R: rodriguesToRotationMatrix(w),
            t,
            iterations: iter,
            converged
        };
    }

    private static computeTotalResidualNorm(
        points3D: Point3D[],
        points2D: Point2D[],
        fx: number,
        fy: number,
        cx: number,
        cy: number,
        R: number[][],
        t: Point3D
    ): number {
        let sum = 0;
        for (let i = 0; i < points3D.length; i++) {
            const [X, Y, Z] = points3D[i];
            const zc = Math.max(0.001, R[2][0] * X + R[2][1] * Y + R[2][2] * Z + t[2]);
            const xc = R[0][0] * X + R[0][1] * Y + R[0][2] * Z + t[0];
            const yc = R[1][0] * X + R[1][1] * Y + R[1][2] * Z + t[1];

            const u = fx * (xc / zc) + cx;
            const v = fy * (yc / zc) + cy;

            const du = points2D[i][0] - u;
            const dv = points2D[i][1] - v;
            sum += du * du + dv * dv;
        }
        return Math.sqrt(sum / points3D.length);
    }

    private static solveLinear6x6(A: number[][], b: number[]): number[] | null {
        const M = A.map((row, i) => [...row, b[i]]);
        const n = 6;

        for (let i = 0; i < n; i++) {
            let maxRow = i;
            let maxVal = Math.abs(M[i][i]);
            for (let r = i + 1; r < n; r++) {
                if (Math.abs(M[r][i]) > maxVal) {
                    maxVal = Math.abs(M[r][i]);
                    maxRow = r;
                }
            }

            if (maxVal < 1e-12) return null;

            if (maxRow !== i) {
                const temp = M[i];
                M[i] = M[maxRow];
                M[maxRow] = temp;
            }

            for (let r = i + 1; r < n; r++) {
                const factor = M[r][i] / M[i][i];
                for (let c = i; c <= n; c++) {
                    M[r][c] -= factor * M[i][c];
                }
            }
        }

        const x: number[] = new Array(n).fill(0);
        for (let i = n - 1; i >= 0; i--) {
            let sum = M[i][n];
            for (let c = i + 1; c < n; c++) {
                sum -= M[i][c] * x[c];
            }
            x[i] = sum / M[i][i];
        }

        return x;
    }
}
