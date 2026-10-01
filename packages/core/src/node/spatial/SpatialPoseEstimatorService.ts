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
    /** Also estimate unknown focal length (default: false) */
    estimateFocalLength?: boolean;
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

                if (Math.abs(gamma) <= eps * Math.sqrt(alpha * beta)) {
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
 * Recovers closest orthonormal rotation matrix R from general 3x3 matrix M using SVD Procrustes.
 * Ensures det(R) = +1 (proper rotation in SO(3)).
 */
export function orthonormalizeRotation3x3(M: number[][]): number[][] {
    const { U, V } = svdJacobi(M, 30);
    // R = U * V^T
    const VT = matrixTranspose(V);
    let R = matrixMultiply(U, VT);

    // Compute determinant of R
    let det =
        R[0][0] * (R[1][1] * R[2][2] - R[1][2] * R[2][1]) -
        R[0][1] * (R[1][0] * R[2][2] - R[1][2] * R[2][0]) +
        R[0][2] * (R[1][0] * R[2][1] - R[1][1] * R[2][0]);

    if (det < 0) {
        // Negate the last column of U (or last row of V^T) to enforce det(R) = +1
        const U_det = U.map(row => [row[0], row[1], -row[2]]);
        R = matrixMultiply(U_det, VT);
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

    if (Math.abs(theta - Math.PI) < 1e-4) {
        const s = Math.sqrt(Math.max(0, (R[0][0] + 1) * 0.5));
        return [s * theta, 0, 0];
    }

    const factor = theta / (2.0 * Math.sin(theta));
    return [
        (R[2][1] - R[1][2]) * factor,
        (R[0][2] - R[2][0]) * factor,
        (R[1][0] - R[0][1]) * factor
    ];
}

// ============================================================================
// Perspective-n-Point Core Algorithms (DLT & Levenberg-Marquardt)
// ============================================================================

export class SpatialPoseEstimatorService {
    /**
     * Solves camera pose (rotation R and translation t) given >= 4 3D-to-2D point correspondences
     * and camera intrinsics. Uses Direct Linear Transform (DLT) with SVD for closed-form
     * initial estimate, followed by Levenberg-Marquardt non-linear least squares optimization.
     */
    public static solvePnP(
        points3D: Point3D[],
        points2D: Point2D[],
        intrinsics: CameraIntrinsics,
        options: PnPOptions = {}
    ): SolvedCameraPose {
        const n = points3D.length;
        if (n < 4) {
            throw new Error(`solvePnP requires at least 4 point correspondences, received ${n}.`);
        }
        if (points2D.length !== n) {
            throw new Error(`solvePnP: 3D point count (${n}) does not match 2D point count (${points2D.length}).`);
        }

        const { fx, fy, cx, cy } = intrinsics;

        // 1. Setup normalized camera coordinates: x_n = (u - cx) / fx, y_n = (v - cy) / fy
        const normalized2D: Point2D[] = points2D.map(([u, v]) => [
            (u - cx) / fx,
            (v - cy) / fy
        ]);

        // 2. Build DLT matrix A (2N x 12)
        const A: number[][] = [];
        for (let i = 0; i < n; i++) {
            const [X, Y, Z] = points3D[i];
            const [u, v] = normalized2D[i];

            A.push([
                -X, -Y, -Z, -1,
                0, 0, 0, 0,
                u * X, u * Y, u * Z, u
            ]);
            A.push([
                0, 0, 0, 0,
                -X, -Y, -Z, -1,
                v * X, v * Y, v * Z, v
            ]);
        }

        // 3. Compute SVD of A: A = U * S * V^T
        const { S, V } = svdJacobi(A, 40);

        // Find smallest singular value index
        let minIdx = 0;
        let minVal = S[0];
        for (let i = 1; i < S.length; i++) {
            if (S[i] < minVal) {
                minVal = S[i];
                minIdx = i;
            }
        }

        const p = V.map(row => row[minIdx]);

        // 4. Extract 3x3 M and translation vector t_raw
        let M_raw: number[][] = [
            [p[0], p[1], p[2]],
            [p[4], p[5], p[6]],
            [p[8], p[9], p[10]]
        ];
        let t_raw: Point3D = [p[3], p[7], p[11]];

        // In homogeneous DLT (Ap = 0), p is determined up to an unknown sign.
        // True camera projection matrix has det(M) = gamma^3 * det(R) with gamma > 0 and det(R) = +1.
        // If det(M_raw) < 0, SVD picked -p, so flip the entire vector p to preserve orientation.
        const detM =
            M_raw[0][0] * (M_raw[1][1] * M_raw[2][2] - M_raw[1][2] * M_raw[2][1]) -
            M_raw[0][1] * (M_raw[1][0] * M_raw[2][2] - M_raw[1][2] * M_raw[2][0]) +
            M_raw[0][2] * (M_raw[1][0] * M_raw[2][1] - M_raw[1][1] * M_raw[2][0]);

        if (detM < 0) {
            M_raw = M_raw.map(row => row.map(val => -val));
            t_raw = [-t_raw[0], -t_raw[1], -t_raw[2]];
        }

        // Orthonormalize M to obtain rotation matrix R
        let R = orthonormalizeRotation3x3(M_raw);

        // Compute scale factor gamma = norm(M_raw) / sqrt(3)
        let normSq = 0;
        for (let r = 0; r < 3; r++) {
            for (let c = 0; c < 3; c++) {
                normSq += M_raw[r][c] * M_raw[r][c];
            }
        }
        const scale = Math.sqrt(normSq / 3.0);
        let t: Point3D = scale > 1e-8 ? [t_raw[0] / scale, t_raw[1] / scale, t_raw[2] / scale] : [...t_raw];

        // Ensure points project with positive depth in camera frame (Z_c > 0)
        let positiveZCount = 0;
        for (let i = 0; i < n; i++) {
            const z_c = R[2][0] * points3D[i][0] + R[2][1] * points3D[i][1] + R[2][2] * points3D[i][2] + t[2];
            if (z_c > 0) positiveZCount++;
        }

        if (positiveZCount < n / 2) {
            // Flip signs
            R = R.map(row => row.map(val => -val));
            t = [-t[0], -t[1], -t[2]];
            R = orthonormalizeRotation3x3(R);
        }

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
     */
    public static solvePnPRansac(
        points3D: Point3D[],
        points2D: Point2D[],
        intrinsics: CameraIntrinsics,
        options: PnPRansacOptions = {}
    ): PnPRansacResult {
        const n = points3D.length;
        if (n < 4) {
            throw new Error(`solvePnPRansac requires at least 4 correspondences, received ${n}.`);
        }

        const inlierThresholdPx = options.inlierThresholdPx ?? 2.5;
        const maxRansacIterations = Math.min(500, Math.max(50, options.maxRansacIterations ?? 200));

        let bestInliers: number[] = [];
        let bestPose: SolvedCameraPose | null = null;

        // If n is small (4 or 5), just run directly
        if (n <= 5) {
            const pose = this.solvePnP(points3D, points2D, intrinsics, options);
            const inliers = Array.from({ length: n }, (_, i) => i);
            return {
                pose,
                inlierIndices: inliers,
                inlierCount: inliers.length,
                totalCount: n,
                inlierRatio: 1.0
            };
        }

        for (let iter = 0; iter < maxRansacIterations; iter++) {
            // Sample 4 distinct random points
            const sampleIndices: number[] = [];
            while (sampleIndices.length < 4) {
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

                // Count inliers
                const currentInliers: number[] = [];
                const { fx, fy, cx, cy } = intrinsics;
                const R = candidatePose.rotationMatrix;
                const t = candidatePose.translationCamera;

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
                        currentInliers.push(i);
                    }
                }

                if (currentInliers.length > bestInliers.length) {
                    bestInliers = currentInliers;
                    bestPose = candidatePose;

                    // Early exit if consensus is overwhelming (> 90%)
                    if (bestInliers.length >= n * 0.9) {
                        break;
                    }
                }
            } catch {
                continue;
            }
        }

        if (!bestPose || bestInliers.length < 4) {
            const pose = this.solvePnP(points3D, points2D, intrinsics, options);
            return {
                pose,
                inlierIndices: Array.from({ length: n }, (_, i) => i),
                inlierCount: n,
                totalCount: n,
                inlierRatio: 1.0
            };
        }

        // Final refinement using ALL inliers with full Levenberg-Marquardt
        const inlier3D = bestInliers.map(i => points3D[i]);
        const inlier2D = bestInliers.map(i => points2D[i]);

        const refinedPose = this.solvePnP(inlier3D, inlier2D, intrinsics, {
            ...options,
            refineLevenbergMarquardt: true
        });

        // Re-evaluate inliers with final refined pose
        const finalInliers: number[] = [];
        const { fx, fy, cx, cy } = intrinsics;
        const R_fin = refinedPose.rotationMatrix;
        const t_fin = refinedPose.translationCamera;

        for (let i = 0; i < n; i++) {
            const [X, Y, Z] = points3D[i];
            const zc = R_fin[2][0] * X + R_fin[2][1] * Y + R_fin[2][2] * Z + t_fin[2];
            if (zc <= 0.01) continue;

            const xc = R_fin[0][0] * X + R_fin[0][1] * Y + R_fin[0][2] * Z + t_fin[0];
            const yc = R_fin[1][0] * X + R_fin[1][1] * Y + R_fin[1][2] * Z + t_fin[1];

            const projU = fx * (xc / zc) + cx;
            const projV = fy * (yc / zc) + cy;

            const err = Math.hypot(projU - points2D[i][0], projV - points2D[i][1]);
            if (err <= inlierThresholdPx) {
                finalInliers.push(i);
            }
        }

        return {
            pose: refinedPose,
            inlierIndices: finalInliers,
            inlierCount: finalInliers.length,
            totalCount: n,
            inlierRatio: finalInliers.length / n
        };
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
