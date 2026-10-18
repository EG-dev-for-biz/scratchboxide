/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Continuous-Time SE(3) Spline Bundle Adjustment with Persistent Video Track Fusion.
 * Parameterizes the camera trajectory as a continuous C2 Catmull-Rom spline with M
 * control knots, regularized by persistent multi-frame 2D tracks, 3D boundary anchors,
 * and kinematic smoothness constraints (preventing floor-hopping and sudden teleports).
 ********************************************************************************/

import type { CameraSolveTrack, CameraSolveFrame } from '../../common/vfx-plate-protocol';
import type { CameraPathData, CameraPoseFrame, GeoAnchor } from './Google3DTileBlockoutPipelineService';
import type { CameraPose6DOF } from './SubPixelEdgeAlignmentOptimizer';

export interface TrajectoryBoundaryPose {
    timeSec: number;
    position: [number, number, number];
    target: [number, number, number];
    fov: number;
    up?: [number, number, number];
    rollDeg?: number;
}

export interface DynamicTrajectoryOptions {
    fps?: number;
    durationSec?: number;
    totalFrames?: number;
    geoAnchor?: GeoAnchor;
    intermediateKeyframeAnchors?: TrajectoryBoundaryPose[];
    minClearanceMeters?: number;
    tension?: number; // Catmull-Rom tension parameter (default: 0.5)
}

export interface SplineKnot {
    timeSec: number;
    position: [number, number, number];
    target: [number, number, number];
    up: [number, number, number];
    fovYDeg: number;
    k1?: number; // Brown-Conrady radial distortion coefficient
}

export interface EvaluatedPose {
    timeSec: number;
    position: [number, number, number];
    target: [number, number, number];
    up: [number, number, number];
    fovYDeg: number;
    k1: number;
    pitchDeg: number;
    headingDeg: number;
    rotationQuaternion: [number, number, number, number]; // Three.js unit quaternion [qx, qy, qz, qw]
}

export interface PersistentTrack3D2D {
    trackId: string;
    worldPoint3D: [number, number, number];
    observations: {
        frameNumber: number;
        timeSec: number;
        pixel2D: [number, number]; // [u, v] in pixel space
        confidence: number;
    }[];
}

export interface SplineAnchorConstraint {
    timeSec: number;
    position: [number, number, number];
    target?: [number, number, number];
    up?: [number, number, number];
    weight?: number; // default: 50.0
}

export interface ContinuousSplineSolveOptions {
    maxIterations?: number;
    tolerancePx?: number;
    kinematicSmoothnessWeight?: number;
    anchorWeight?: number;
    huberLossThresholdPx?: number;
    enforceMonotonicDescent?: boolean;
    monotonicDescentWeight?: number;
    initialLambda?: number;
    stepSizeLimitMeters?: number;
}

export interface SplineOptimizationResult {
    success: boolean;
    initialRmsPx: number;
    finalRmsPx: number;
    iterations: number;
    optimizedKnots: SplineKnot[];
}

export interface DenseTrajectoryFrame {
    frame: number;
    timeSec: number;
    position: [number, number, number];
    target: [number, number, number];
    up: [number, number, number];
    rotationQuaternion: [number, number, number, number]; // [qx, qy, qz, qw]
    pitchDeg: number;
    headingDeg?: number;
    fovYDeg: number;
    k1: number;
    standoffMeters: number;
    velocityMps: number;
    accelerationMps2: number;
    jerkMps3?: number;
}

export class ContinuousSplineMatchmoveService {
    /**
     * Catmull-Rom cubic spline interpolation for 1D value.
     */
    private catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
        const t2 = t * t;
        const t3 = t2 * t;
        return 0.5 * (
            (2.0 * p1) +
            (-p0 + p2) * t +
            (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t2 +
            (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * t3
        );
    }

    /**
     * Catmull-Rom interpolation for 3D vector.
     */
    private interpolateVector3(
        p0: [number, number, number],
        p1: [number, number, number],
        p2: [number, number, number],
        p3: [number, number, number],
        t: number
    ): [number, number, number] {
        return [
            this.catmullRom(p0[0], p1[0], p2[0], p3[0], t),
            this.catmullRom(p0[1], p1[1], p2[1], p3[1], t),
            this.catmullRom(p0[2], p1[2], p2[2], p3[2], t)
        ];
    }

    private normalize(v: [number, number, number]): [number, number, number] {
        const len = Math.hypot(v[0], v[1], v[2]);
        if (len < 1e-9) return [0, 1, 0];
        return [v[0] / len, v[1] / len, v[2] / len];
    }

    private cross(a: [number, number, number], b: [number, number, number]): [number, number, number] {
        return [
            a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0]
        ];
    }

    private dot(a: [number, number, number], b: [number, number, number]): number {
        return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    }

    /**
     * Converts Euler heading (azimuth) and pitch angles into a normalized Three.js orientation quaternion [qx, qy, qz, qw]
     * (Three.js camera convention: Euler YXZ, local forward = [0, 0, -1], local up = [0, 1, 0]).
     */
    public static eulerToQuaternion(headingDeg: number, pitchDeg: number, rollDeg: number = 0): [number, number, number, number] {
        const headingRad = (headingDeg * Math.PI) / 180.0;
        const pitchRad = (pitchDeg * Math.PI) / 180.0;
        const rollRad = (rollDeg * Math.PI) / 180.0;

        const c1 = Math.cos(headingRad / 2.0);
        const s1 = Math.sin(headingRad / 2.0);
        const c2 = Math.cos(pitchRad / 2.0);
        const s2 = Math.sin(pitchRad / 2.0);
        const c3 = Math.cos(rollRad / 2.0);
        const s3 = Math.sin(rollRad / 2.0);

        const qx = s2 * c1 * c3 + c2 * s1 * s3;
        const qy = c2 * s1 * c3 - s2 * c1 * s3;
        const qz = c2 * c1 * s3 - s2 * s1 * c3;
        const qw = c2 * c1 * c3 + s2 * s1 * s3;

        const mag = Math.hypot(qx, qy, qz, qw) || 1.0;
        return [qx / mag, qy / mag, qz / mag, qw / mag];
    }

    /**
     * Evaluates continuous 6-DOF camera pose at any arbitrary time t along the spline knots.
     */
    public evaluateAt(knots: SplineKnot[], timeSec: number): EvaluatedPose {
        if (!knots || knots.length === 0) {
            throw new Error('ContinuousSplineMatchmoveService: knots array is empty.');
        }

        return this.evaluateSorted([...knots].sort((a, b) => a.timeSec - b.timeSec), timeSec);
    }

    /** Knot segment holding `timeSec` in time-sorted knots (the one `evaluateSorted` interpolates). */
    private static segmentIndex(sorted: SplineKnot[], timeSec: number): number {
        let segIdx = 0;
        while (segIdx < sorted.length - 2 && sorted[segIdx + 1].timeSec < timeSec) segIdx++;
        return segIdx;
    }

    /** Knots whose positions move the pose at `timeSec` (Catmull-Rom: the segment's two knots and one either side). */
    private static positionSupport(sorted: SplineKnot[], timeSec: number): number[] {
        const M = sorted.length;
        if (M === 1 || timeSec <= sorted[0].timeSec) return [0];
        if (timeSec >= sorted[M - 1].timeSec) return [M - 1];
        const seg = ContinuousSplineMatchmoveService.segmentIndex(sorted, timeSec);
        return [...new Set([seg > 0 ? seg - 1 : seg, seg, seg + 1, seg < M - 2 ? seg + 2 : seg + 1])];
    }

    /** `evaluateAt` on knots already sorted by time; `segIdx` skips the segment search when the caller knows it. */
    private evaluateSorted(sorted: SplineKnot[], timeSec: number, segIdxHint?: number): EvaluatedPose {
        const M = sorted.length;

        if (M === 1 || timeSec <= sorted[0].timeSec) {
            const k0 = sorted[0];
            const dx = k0.target[0] - k0.position[0];
            const dy = k0.target[1] - k0.position[1];
            const dz = k0.target[2] - k0.position[2];
            const dist = Math.hypot(dx, dy, dz) || 1.0;
            const pitchDeg = Math.asin(Math.max(-1.0, Math.min(1.0, dy / dist))) * (180.0 / Math.PI);
            const headingDeg = Math.atan2(dx, -dz) * (180.0 / Math.PI);
            const rotationQuaternion = ContinuousSplineMatchmoveService.eulerToQuaternion(headingDeg, pitchDeg, 0.0);
            return {
                timeSec,
                position: [...k0.position],
                target: [...k0.target],
                up: this.normalize(k0.up),
                fovYDeg: k0.fovYDeg,
                k1: k0.k1 ?? 0,
                pitchDeg,
                headingDeg,
                rotationQuaternion
            };
        }

        if (timeSec >= sorted[M - 1].timeSec) {
            const kLast = sorted[M - 1];
            const dx = kLast.target[0] - kLast.position[0];
            const dy = kLast.target[1] - kLast.position[1];
            const dz = kLast.target[2] - kLast.position[2];
            const dist = Math.hypot(dx, dy, dz) || 1.0;
            const pitchDeg = Math.asin(Math.max(-1.0, Math.min(1.0, dy / dist))) * (180.0 / Math.PI);
            const headingDeg = Math.atan2(dx, -dz) * (180.0 / Math.PI);
            const rotationQuaternion = ContinuousSplineMatchmoveService.eulerToQuaternion(headingDeg, pitchDeg, 0.0);
            return {
                timeSec,
                position: [...kLast.position],
                target: [...kLast.target],
                up: this.normalize(kLast.up),
                fovYDeg: kLast.fovYDeg,
                k1: kLast.k1 ?? 0,
                pitchDeg,
                headingDeg,
                rotationQuaternion
            };
        }

        // Find enclosing knot segment
        const segIdx = segIdxHint ?? ContinuousSplineMatchmoveService.segmentIndex(sorted, timeSec);

        const k1 = sorted[segIdx];
        const k2 = sorted[segIdx + 1];

        // Clamped boundary knots preserve stable sightline orientation
        const k0 = segIdx > 0 ? sorted[segIdx - 1] : k1;
        const k3 = segIdx < M - 2 ? sorted[segIdx + 2] : k2;

        const dt = k2.timeSec - k1.timeSec;
        const u = dt > 1e-6 ? (timeSec - k1.timeSec) / dt : 0.0;
        const clampedU = Math.max(0.0, Math.min(1.0, u));

        const position = this.interpolateVector3(k0.position, k1.position, k2.position, k3.position, clampedU);
        const target = this.interpolateVector3(k0.target, k1.target, k2.target, k3.target, clampedU);

        // Linear interpolation for up vector with normalization
        const rawUp: [number, number, number] = [
            k1.up[0] * (1.0 - clampedU) + k2.up[0] * clampedU,
            k1.up[1] * (1.0 - clampedU) + k2.up[1] * clampedU,
            k1.up[2] * (1.0 - clampedU) + k2.up[2] * clampedU
        ];
        const up = this.normalize(rawUp);

        const fovYDeg = k1.fovYDeg * (1.0 - clampedU) + k2.fovYDeg * clampedU;
        // No k1 on a knot means no distortion measured: a pinhole, not an invented barrel term.
        const k1Val = (k1.k1 ?? 0) * (1.0 - clampedU) + (k2.k1 ?? 0) * clampedU;

        const dx = target[0] - position[0];
        const dy = target[1] - position[1];
        const dz = target[2] - position[2];
        const dist = Math.hypot(dx, dy, dz) || 1.0;
        const pitchDeg = Math.asin(Math.max(-1.0, Math.min(1.0, dy / dist))) * (180.0 / Math.PI);
        const headingDeg = Math.atan2(dx, -dz) * (180.0 / Math.PI);
        const rotationQuaternion = ContinuousSplineMatchmoveService.eulerToQuaternion(headingDeg, pitchDeg, 0.0);

        return {
            timeSec,
            position,
            target,
            up,
            fovYDeg,
            k1: k1Val,
            pitchDeg,
            headingDeg,
            rotationQuaternion
        };
    }

    /**
     * Projects a 3D world coordinate into 2D image coordinates with Brown-Conrady radial lens distortion.
     */
    public projectPoint(
        point3D: [number, number, number],
        cameraPos: [number, number, number],
        targetPos: [number, number, number],
        upVec: [number, number, number],
        fovYDeg: number,
        k1: number,
        width: number,
        height: number
    ): [number, number] | null {
        // Forward line of sight
        let fx = targetPos[0] - cameraPos[0];
        let fy = targetPos[1] - cameraPos[1];
        let fz = targetPos[2] - cameraPos[2];
        const fLen = Math.hypot(fx, fy, fz);
        if (fLen < 1e-4) {
            fx = 0.0; fy = 0.0; fz = -1.0;
        } else {
            fx /= fLen; fy /= fLen; fz /= fLen;
        }
        const forward: [number, number, number] = [fx, fy, fz];

        // Right vector
        let right = this.cross(forward, upVec);
        let rLen = Math.hypot(right[0], right[1], right[2]);
        if (rLen < 1e-4) {
            right = [1.0, 0.0, 0.0];
        } else {
            right = [right[0] / rLen, right[1] / rLen, right[2] / rLen];
        }

        // Orthogonal up vector in camera frame
        const upCam = this.cross(right, forward);

        // Vector from camera to 3D point
        const dx = point3D[0] - cameraPos[0];
        const dy = point3D[1] - cameraPos[1];
        const dz = point3D[2] - cameraPos[2];

        // Camera frame coordinates
        const xc = this.dot(right, [dx, dy, dz]);
        const yc = this.dot(upCam, [dx, dy, dz]);
        const zc = this.dot(forward, [dx, dy, dz]);

        // Point is behind or at the near plane of camera
        if (zc <= 0.05) {
            return null;
        }

        const halfFovRad = (fovYDeg * Math.PI) / 360.0;
        const fyPx = (height / 2.0) / Math.tan(halfFovRad);
        const fxPx = fyPx; // Square pixel aspect ratio
        const cx = width / 2.0;
        const cy = height / 2.0;

        const xn = xc / zc;
        const yn = yc / zc;

        // Radial lens distortion
        const r2 = xn * xn + yn * yn;
        const radial = 1.0 + k1 * r2;
        const xd = xn * radial;
        const yd = yn * radial;

        const u = cx + fxPx * xd;
        const v = cy - fyPx * yd; // Image Y points downwards

        return [u, v];
    }

    /**
     * Computes the total reprojection error across all persistent video tracks.
     */
    public computeTotalReprojectionError(
        knots: SplineKnot[],
        tracks: PersistentTrack3D2D[],
        width: number,
        height: number
    ): { rmsPx: number; meanResidualPx: number; maxResidualPx: number; count: number } {
        let totalSq = 0.0;
        let totalAbs = 0.0;
        let maxErr = 0.0;
        let count = 0;
        if (!knots || knots.length === 0) throw new Error('ContinuousSplineMatchmoveService: knots array is empty.');
        const sorted = [...knots].sort((a, b) => a.timeSec - b.timeSec);

        for (const track of tracks) {
            for (const obs of track.observations) {
                const pose = this.evaluateSorted(sorted, obs.timeSec);
                const proj = this.projectPoint(
                    track.worldPoint3D,
                    pose.position,
                    pose.target,
                    pose.up,
                    pose.fovYDeg,
                    pose.k1,
                    width,
                    height
                );

                if (proj) {
                    const du = proj[0] - obs.pixel2D[0];
                    const dv = proj[1] - obs.pixel2D[1];
                    const err = Math.hypot(du, dv);
                    totalSq += err * err;
                    totalAbs += err;
                    if (err > maxErr) maxErr = err;
                    count++;
                } else {
                    // Penalty for throwing points behind camera
                    totalSq += 10000.0;
                    totalAbs += 100.0;
                    count++;
                }
            }
        }

        const rmsPx = count > 0 ? Math.sqrt(totalSq / count) : 0.0;
        const meanResidualPx = count > 0 ? totalAbs / count : 0.0;

        return { rmsPx, meanResidualPx, maxResidualPx: maxErr, count };
    }

    /**
     * Solves (A) x = b for a symmetric positive-definite A whose nonzeros lie within `bw` of the diagonal (banded
     * Cholesky, O(n bw^2)). Returns null when A is not positive definite.
     */
    private solveBandedSpd(A: Float64Array, b: Float64Array, n: number, bw: number): Float64Array | null {
        const L = new Float64Array(n * n);
        for (let j = 0; j < n; j++) {
            let sum = A[j * n + j];
            for (let k = Math.max(0, j - bw); k < j; k++) sum -= L[j * n + k] * L[j * n + k];
            if (!(sum > 1e-12)) return null;
            const d = Math.sqrt(sum);
            L[j * n + j] = d;
            for (let i = j + 1; i <= Math.min(n - 1, j + bw); i++) {
                let v = A[i * n + j];
                for (let k = Math.max(0, i - bw); k < j; k++) v -= L[i * n + k] * L[j * n + k];
                L[i * n + j] = v / d;
            }
        }
        const y = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            let v = b[i];
            for (let k = Math.max(0, i - bw); k < i; k++) v -= L[i * n + k] * y[k];
            y[i] = v / L[i * n + i];
        }
        const x = new Float64Array(n);
        for (let i = n - 1; i >= 0; i--) {
            let v = y[i];
            for (let k = i + 1; k <= Math.min(n - 1, i + bw); k++) v -= L[k * n + i] * x[k];
            x[i] = v / L[i * n + i];
        }
        return x;
    }

    /**
     * Optimizes spline knots using Levenberg-Marquardt with multi-frame track reprojection,
     * anchor lock constraints, and kinematic smoothness regularization.
     *
     * Knot times never change during the solve, so the knots are sorted once (and returned in time order). A
     * Catmull-Rom pose reads four knots, so each residual depends on at most four knots: the Jacobian is built
     * from those alone and the normal equations are banded (solved by banded Cholesky).
     */
    public optimizeSplineTrajectory(
        initialKnots: SplineKnot[],
        tracks: PersistentTrack3D2D[],
        anchors: SplineAnchorConstraint[] = [],
        width: number,
        height: number,
        options: ContinuousSplineSolveOptions = {}
    ): SplineOptimizationResult {
        const maxIters = options.maxIterations ?? 25;
        const tolerancePx = options.tolerancePx ?? 0.05;
        const lambdaInit = options.initialLambda ?? 1e-3;
        const huberThresh = options.huberLossThresholdPx ?? 4.0;
        const smoothWeight = options.kinematicSmoothnessWeight ?? 1.0;
        const enforceMono = options.enforceMonotonicDescent ?? false;
        const stepLimit = options.stepSizeLimitMeters ?? 2.0;
        const defaultAnchorWeight = options.anchorWeight ?? 50.0;
        const defaultMonoWeight = options.monotonicDescentWeight ?? 500.0;
        const S = ContinuousSplineMatchmoveService;

        let knots: SplineKnot[] = (JSON.parse(JSON.stringify(initialKnots)) as SplineKnot[]).sort((a, b) => a.timeSec - b.timeSec);
        const numKnots = knots.length;
        const numParams = numKnots * 3; // 3 spatial parameters (x, y, z) per knot
        if (numKnots === 0) throw new Error('ContinuousSplineMatchmoveService: knots array is empty.');

        // Residual blocks, in a fixed order and of fixed length: 2 per observation, 3 per anchor, 3 per interior
        // knot (acceleration), and with descent on 1 per knot gap (zero when the gap does not climb, so the vector
        // keeps its length and the Jacobian rows line up). `support` lists the knots a block reads.
        type Block = { kind: 0 | 1 | 2 | 3; timeSec: number; seg: number; support: number[]; offset: number; size: number; point?: [number, number, number]; obs?: PersistentTrack3D2D['observations'][number]; anchor?: SplineAnchorConstraint; knot?: number };
        const blocks: Block[] = [];
        let numResiduals = 0;
        const push = (b: Omit<Block, 'offset'>) => { blocks.push({ ...b, offset: numResiduals }); numResiduals += b.size; };
        for (const track of tracks) {
            for (const obs of track.observations) {
                push({ kind: 0, timeSec: obs.timeSec, seg: S.segmentIndex(knots, obs.timeSec), support: S.positionSupport(knots, obs.timeSec), size: 2, point: track.worldPoint3D, obs });
            }
        }
        for (const anchor of anchors) {
            push({ kind: 1, timeSec: anchor.timeSec, seg: S.segmentIndex(knots, anchor.timeSec), support: S.positionSupport(knots, anchor.timeSec), size: 3, anchor });
        }
        for (let i = 1; i < numKnots - 1; i++) push({ kind: 2, timeSec: 0, seg: 0, support: [i - 1, i, i + 1], size: 3, knot: i });
        if (enforceMono) for (let i = 0; i < numKnots - 1; i++) push({ kind: 3, timeSec: 0, seg: 0, support: [i, i + 1], size: 1, knot: i });

        const wSmooth = Math.sqrt(smoothWeight);
        const wMono = Math.sqrt(defaultMonoWeight);
        /** Writes block `b`'s residuals at out[at..]; returns its squared pixel error (observations) or -1. */
        const evalBlock = (b: Block, ks: SplineKnot[], out: Float64Array, at: number): number => {
            if (b.kind === 0) {
                const obs = b.obs!;
                const pose = this.evaluateSorted(ks, b.timeSec, b.seg);
                const proj = this.projectPoint(b.point!, pose.position, pose.target, pose.up, pose.fovYDeg, pose.k1, width, height);
                if (!proj) { out[at] = 100.0; out[at + 1] = 100.0; return 10000.0; }
                const du = (proj[0] - obs.pixel2D[0]) * obs.confidence;
                const dv = (proj[1] - obs.pixel2D[1]) * obs.confidence;
                const err = Math.hypot(du, dv);
                const w = err <= huberThresh ? 1.0 : Math.sqrt(huberThresh / err);
                out[at] = w * du;
                out[at + 1] = w * dv;
                return err * err;
            }
            if (b.kind === 1) {
                const anchor = b.anchor!;
                const pose = this.evaluateSorted(ks, b.timeSec, b.seg);
                const w = Math.sqrt(anchor.weight ?? defaultAnchorWeight);
                out[at] = w * (pose.position[0] - anchor.position[0]);
                out[at + 1] = w * (pose.position[1] - anchor.position[1]);
                out[at + 2] = w * (pose.position[2] - anchor.position[2]);
                return -1;
            }
            const i = b.knot!;
            if (b.kind === 2) {
                for (let c = 0; c < 3; c++) out[at + c] = wSmooth * (ks[i - 1].position[c] - 2.0 * ks[i].position[c] + ks[i + 1].position[c]);
                return -1;
            }
            const dy = ks[i + 1].position[1] - ks[i].position[1];
            out[at] = dy > 0.0 ? wMono * dy : 0.0;
            return -1;
        };

        const computeResiduals = (currentKnots: SplineKnot[]): { residuals: Float64Array; rmsPx: number } => {
            const residuals = new Float64Array(numResiduals);
            let totalSq = 0.0;
            let trackObsCount = 0;
            for (const b of blocks) {
                const sq = evalBlock(b, currentKnots, residuals, b.offset);
                if (b.kind === 0) { totalSq += sq; trackObsCount++; }
            }
            return { residuals, rmsPx: trackObsCount > 0 ? Math.sqrt(totalSq / trackObsCount) : 0.0 };
        };

        // Blocks each knot moves, and the half-bandwidth of J^T J in parameters.
        const affects: number[][] = Array.from({ length: numKnots }, () => []);
        let bandwidth = 2;
        blocks.forEach((b, bi) => {
            for (const k of b.support) affects[k].push(bi);
            bandwidth = Math.max(bandwidth, (Math.max(...b.support) - Math.min(...b.support)) * 3 + 2);
        });
        const blockJ = blocks.map(b => new Float64Array(b.size * b.support.length * 3));
        const scratch = new Float64Array(3);

        const initialEval = computeResiduals(knots);
        let currentEval = initialEval;
        let lambda = lambdaInit;
        let iters = 0;

        const eps = 1e-4; // 0.1mm finite difference perturbation

        for (iters = 0; iters < maxIters; iters++) {
            if (tracks.length > 0 && currentEval.rmsPx < tolerancePx) {
                break;
            }

            const r0 = currentEval.residuals;
            if (numResiduals === 0) {
                break;
            }

            // Jacobian by forward differences, re-evaluating only the blocks each knot moves.
            for (let k = 0; k < numKnots; k++) {
                for (let coord = 0; coord < 3; coord++) {
                    knots[k].position[coord] += eps;
                    for (const bi of affects[k]) {
                        const b = blocks[bi];
                        evalBlock(b, knots, scratch, 0);
                        const cols = b.support.length * 3;
                        const col = b.support.indexOf(k) * 3 + coord;
                        for (let r = 0; r < b.size; r++) blockJ[bi][r * cols + col] = (scratch[r] - r0[b.offset + r]) / eps;
                    }
                    knots[k].position[coord] -= eps; // Restore
                }
            }

            // Normal equations H = J^T J, g = J^T r, accumulated block by block (H is banded).
            const H = new Float64Array(numParams * numParams);
            const g = new Float64Array(numParams);
            blocks.forEach((b, bi) => {
                const Jb = blockJ[bi];
                const cols = b.support.length * 3;
                const gc = (j: number) => b.support[Math.floor(j / 3)] * 3 + (j % 3);
                for (let r = 0; r < b.size; r++) {
                    const ri = r0[b.offset + r];
                    for (let j = 0; j < cols; j++) {
                        const Jj = Jb[r * cols + j];
                        if (Jj === 0) continue;
                        const p = gc(j);
                        g[p] += Jj * ri;
                        for (let l = 0; l < cols; l++) H[p * numParams + gc(l)] += Jj * Jb[r * cols + l];
                    }
                }
            });

            // Add Levenberg-Marquardt damping: (H + lambda * diag(H))
            for (let p = 0; p < numParams; p++) {
                const diag = H[p * numParams + p];
                H[p * numParams + p] += lambda * Math.max(1e-3, diag);
            }

            // Solve H * delta = -g
            const negG = new Float64Array(numParams);
            for (let p = 0; p < numParams; p++) negG[p] = -g[p];
            const delta = this.solveBandedSpd(H, negG, numParams, bandwidth);

            if (!delta) {
                lambda *= 4.0;
                continue;
            }

            // Form trial update with step limit
            const trialKnots: SplineKnot[] = JSON.parse(JSON.stringify(knots));
            for (let k = 0; k < numKnots; k++) {
                for (let coord = 0; coord < 3; coord++) {
                    const step = Math.max(-stepLimit, Math.min(stepLimit, delta[k * 3 + coord]));
                    trialKnots[k].position[coord] += step;
                }
            }

            const trialEval = computeResiduals(trialKnots);

            // Compute sum of squared residuals
            let currentSq = 0.0;
            for (let i = 0; i < numResiduals; i++) currentSq += r0[i] * r0[i];

            let trialSq = 0.0;
            const rTrial = trialEval.residuals;
            for (let i = 0; i < rTrial.length; i++) trialSq += rTrial[i] * rTrial[i];

            if (trialSq < currentSq) {
                knots = trialKnots;
                currentEval = trialEval;
                lambda = Math.max(1e-7, lambda * 0.33);
            } else {
                lambda *= 3.0;
            }
        }

        return {
            success: iters > 0,
            initialRmsPx: initialEval.rmsPx,
            finalRmsPx: currentEval.rmsPx,
            iterations: iters,
            optimizedKnots: knots
        };
    }

    /**
     * Synthesizes dense per-frame trajectory table with full 6-DOF velocity, acceleration, and jerk telemetry.
     */
    public synthesizeDenseTrajectory(
        knots: SplineKnot[],
        fps: number = 24,
        durationSec: number = 10.0
    ): DenseTrajectoryFrame[] {
        const totalFrames = Math.round(fps * durationSec) + 1;
        const frames: DenseTrajectoryFrame[] = [];
        const dt = 1.0 / fps;

        const rawPoses: EvaluatedPose[] = [];
        for (let i = 0; i < totalFrames; i++) {
            const t = (i / (totalFrames - 1)) * durationSec;
            rawPoses.push(this.evaluateAt(knots, t));
        }

        // Compute velocities with accurate one-sided boundary differencing (not halved)
        const velocities: [number, number, number][] = [];
        for (let i = 0; i < totalFrames; i++) {
            let vx: number, vy: number, vz: number;
            if (i === 0) {
                vx = (rawPoses[1].position[0] - rawPoses[0].position[0]) / dt;
                vy = (rawPoses[1].position[1] - rawPoses[0].position[1]) / dt;
                vz = (rawPoses[1].position[2] - rawPoses[0].position[2]) / dt;
            } else if (i === totalFrames - 1) {
                vx = (rawPoses[totalFrames - 1].position[0] - rawPoses[totalFrames - 2].position[0]) / dt;
                vy = (rawPoses[totalFrames - 1].position[1] - rawPoses[totalFrames - 2].position[1]) / dt;
                vz = (rawPoses[totalFrames - 1].position[2] - rawPoses[totalFrames - 2].position[2]) / dt;
            } else {
                vx = (rawPoses[i + 1].position[0] - rawPoses[i - 1].position[0]) / (2.0 * dt);
                vy = (rawPoses[i + 1].position[1] - rawPoses[i - 1].position[1]) / (2.0 * dt);
                vz = (rawPoses[i + 1].position[2] - rawPoses[i - 1].position[2]) / (2.0 * dt);
            }
            velocities.push([vx, vy, vz]);
        }

        // Compute accelerations
        const accelerations: [number, number, number][] = [];
        for (let i = 0; i < totalFrames; i++) {
            let ax: number, ay: number, az: number;
            if (i === 0) {
                ax = (velocities[1][0] - velocities[0][0]) / dt;
                ay = (velocities[1][1] - velocities[0][1]) / dt;
                az = (velocities[1][2] - velocities[0][2]) / dt;
            } else if (i === totalFrames - 1) {
                ax = (velocities[totalFrames - 1][0] - velocities[totalFrames - 2][0]) / dt;
                ay = (velocities[totalFrames - 1][1] - velocities[totalFrames - 2][1]) / dt;
                az = (velocities[totalFrames - 1][2] - velocities[totalFrames - 2][2]) / dt;
            } else {
                ax = (velocities[i + 1][0] - velocities[i - 1][0]) / (2.0 * dt);
                ay = (velocities[i + 1][1] - velocities[i - 1][1]) / (2.0 * dt);
                az = (velocities[i + 1][2] - velocities[i - 1][2]) / (2.0 * dt);
            }
            accelerations.push([ax, ay, az]);
        }

        // Compute jerks and build final frames
        for (let i = 0; i < totalFrames; i++) {
            const pose = rawPoses[i];
            const v = velocities[i];
            const a = accelerations[i];
            const velocityMps = Math.hypot(v[0], v[1], v[2]);
            const accelerationMps2 = Math.hypot(a[0], a[1], a[2]);

            let jx: number, jy: number, jz: number;
            if (i < totalFrames - 1) {
                jx = (accelerations[i + 1][0] - accelerations[i][0]) / dt;
                jy = (accelerations[i + 1][1] - accelerations[i][1]) / dt;
                jz = (accelerations[i + 1][2] - accelerations[i][2]) / dt;
            } else {
                jx = (accelerations[totalFrames - 1][0] - accelerations[totalFrames - 2][0]) / dt;
                jy = (accelerations[totalFrames - 1][1] - accelerations[totalFrames - 2][1]) / dt;
                jz = (accelerations[totalFrames - 1][2] - accelerations[totalFrames - 2][2]) / dt;
            }
            const jerkMps3 = Math.hypot(jx, jy, jz);

            const standoffMeters = Math.hypot(
                pose.target[0] - pose.position[0],
                pose.target[1] - pose.position[1],
                pose.target[2] - pose.position[2]
            );

            frames.push({
                frame: i + 1,
                timeSec: Number(pose.timeSec.toFixed(4)),
                position: [Number(pose.position[0].toFixed(3)), Number(pose.position[1].toFixed(3)), Number(pose.position[2].toFixed(3))],
                target: [Number(pose.target[0].toFixed(3)), Number(pose.target[1].toFixed(3)), Number(pose.target[2].toFixed(3))],
                up: [Number(pose.up[0].toFixed(4)), Number(pose.up[1].toFixed(4)), Number(pose.up[2].toFixed(4))],
                rotationQuaternion: pose.rotationQuaternion,
                pitchDeg: Number(pose.pitchDeg.toFixed(1)),
                headingDeg: Number(pose.headingDeg.toFixed(1)),
                fovYDeg: Number(pose.fovYDeg.toFixed(2)),
                k1: Number(pose.k1.toFixed(4)),
                standoffMeters: Number(standoffMeters.toFixed(2)),
                velocityMps: Number(velocityMps.toFixed(2)),
                accelerationMps2: Number(accelerationMps2.toFixed(2)),
                jerkMps3: Number(jerkMps3.toFixed(2))
            });
        }

        return frames;
    }

    /**
     * Converts a set of spline knots into a canonical CameraSolveTrack.
     */
    public toCameraSolveTrack(
        knots: SplineKnot[],
        fps: number = 24,
        durationSec: number = 10.0,
        trackId: string = `spline_solve_${Date.now()}`,
        trackName: string = 'Continuous Spline Camera Solve'
    ): CameraSolveTrack {
        const dense = this.synthesizeDenseTrajectory(knots, fps, durationSec);
        const solveFrames: CameraSolveFrame[] = dense.map(d => ({
            frameNumber: d.frame,
            timeSeconds: d.timeSec,
            position: d.position,
            rotationQuaternion: d.rotationQuaternion,
            fovDegrees: d.fovYDeg,
            focalLengthMm: Number((36.0 / (2.0 * Math.tan((d.fovYDeg * Math.PI) / 360.0))).toFixed(2))
        }));

        return {
            id: trackId,
            name: trackName,
            coordinateSystem: 'threejs',
            fps,
            totalFrames: solveFrames.length,
            durationSeconds: durationSec,
            focalLengthMm: solveFrames[0]?.focalLengthMm,
            frames: solveFrames,
            isSolved: true,
            sourceSoftware: 'ContinuousSplineMatchmoveService'
        };
    }

    /**
     * Reconstructs initial spline knots from a CameraSolveTrack.
     */
    public fromCameraSolveTrack(
        track: CameraSolveTrack,
        numKnots: number = 7
    ): SplineKnot[] {
        if (!track.frames || track.frames.length === 0) {
            throw new Error('fromCameraSolveTrack: track has no frames.');
        }

        const sorted = [...track.frames].sort((a, b) => a.timeSeconds - b.timeSeconds);
        const total = sorted.length;
        const M = Math.min(numKnots, total);
        const knotIndices = Array.from({ length: M }, (_, i) => Math.min(total - 1, Math.round((i / (M - 1)) * (total - 1))));

        return knotIndices.map(idx => {
            const f = sorted[idx];
            // Compute target from rotation quaternion forward line of sight
            const [qx, qy, qz, qw] = f.rotationQuaternion;
            const fx = -2.0 * (qx * qz + qw * qy);
            const fy = -2.0 * (qy * qz - qw * qx);
            const fz = -(1.0 - 2.0 * (qx * qx + qy * qy));
            const fMag = Math.hypot(fx, fy, fz) || 1.0;
            const forward: [number, number, number] = [fx / fMag, fy / fMag, fz / fMag];

            // Up vector from quaternion
            const ux = 2.0 * (qx * qy - qw * qz);
            const uy = 1.0 - 2.0 * (qx * qx + qz * qz);
            const uz = 2.0 * (qy * qz + qw * qx);
            const uMag = Math.hypot(ux, uy, uz) || 1.0;
            const up: [number, number, number] = [ux / uMag, uy / uMag, uz / uMag];

            const standoff = 20.0;
            const target: [number, number, number] = [
                f.position[0] + forward[0] * standoff,
                f.position[1] + forward[1] * standoff,
                f.position[2] + forward[2] * standoff
            ];

            return {
                timeSec: f.timeSeconds,
                position: [f.position[0], f.position[1], f.position[2]],
                target,
                up,
                fovYDeg: f.fovDegrees
            };
        });
    }

    /**
     * Catmull-Rom cubic spline interpolation for 1D scalar value.
     */
    public static catmullRomScalar(p0: number, p1: number, p2: number, p3: number, t: number): number {
        const t2 = t * t;
        const t3 = t2 * t;
        return 0.5 * (
            (2.0 * p1) +
            (-p0 + p2) * t +
            (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t2 +
            (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * t3
        );
    }

    /**
     * Catmull-Rom interpolation for 3D point.
     */
    public static interpolatePoint(
        p0: [number, number, number],
        p1: [number, number, number],
        p2: [number, number, number],
        p3: [number, number, number],
        t: number
    ): [number, number, number] {
        return [
            ContinuousSplineMatchmoveService.catmullRomScalar(p0[0], p1[0], p2[0], p3[0], t),
            ContinuousSplineMatchmoveService.catmullRomScalar(p0[1], p1[1], p2[1], p3[1], t),
            ContinuousSplineMatchmoveService.catmullRomScalar(p0[2], p1[2], p2[2], p3[2], t)
        ];
    }

    /**
     * Synthesizes a full multi-frame camera path from solved boundary frames (t=0 and t=final)
     * and optional intermediate visual-odometry anchors.
     */
    public static synthesizeTrajectory(
        startPose: TrajectoryBoundaryPose | CameraPose6DOF,
        finalPose: TrajectoryBoundaryPose | CameraPose6DOF,
        options: DynamicTrajectoryOptions = {}
    ): CameraPathData {
        const fps = options.fps ?? 24;
        const durationSec = options.durationSec ?? 15.0;
        const totalFrames = options.totalFrames ?? Math.round(fps * durationSec);

        // Normalize start & final poses
        const start: TrajectoryBoundaryPose = 'x' in startPose ? {
            timeSec: 0.0,
            position: [startPose.x, startPose.y, startPose.z],
            target: [startPose.targetX, startPose.targetY, startPose.targetZ],
            fov: startPose.fov
        } : startPose;

        const end: TrajectoryBoundaryPose = 'x' in finalPose ? {
            timeSec: durationSec,
            position: [finalPose.x, finalPose.y, finalPose.z],
            target: [finalPose.targetX, finalPose.targetY, finalPose.targetZ],
            fov: finalPose.fov
        } : finalPose;

        // Build milestone control points across duration
        const controlPoints: TrajectoryBoundaryPose[] = [];
        controlPoints.push(start);

        if (options.intermediateKeyframeAnchors && options.intermediateKeyframeAnchors.length > 0) {
            controlPoints.push(...options.intermediateKeyframeAnchors);
        } else {
            // Synthesize intermediate smooth kinematic transitions
            const p1Pos: [number, number, number] = [
                start.position[0] * 0.85 + end.position[0] * 0.15,
                start.position[1] * 0.70 + end.position[1] * 0.30,
                start.position[2] * 0.85 + end.position[2] * 0.15
            ];
            const p1Tgt: [number, number, number] = [
                start.target[0] * 0.75 + end.target[0] * 0.25,
                start.target[1] * 0.65 + end.target[1] * 0.35,
                start.target[2] * 0.75 + end.target[2] * 0.25
            ];
            controlPoints.push({
                timeSec: durationSec * 0.25,
                position: p1Pos,
                target: p1Tgt,
                fov: start.fov * 0.8 + end.fov * 0.2
            });

            const p2Pos: [number, number, number] = [
                start.position[0] * 0.40 + end.position[0] * 0.60,
                start.position[1] * 0.25 + end.position[1] * 0.75,
                start.position[2] * 0.40 + end.position[2] * 0.60
            ];
            const p2Tgt: [number, number, number] = [
                start.target[0] * 0.30 + end.target[0] * 0.70,
                start.target[1] * 0.20 + end.target[1] * 0.80,
                start.target[2] * 0.30 + end.target[2] * 0.70
            ];
            controlPoints.push({
                timeSec: durationSec * 0.60,
                position: p2Pos,
                target: p2Tgt,
                fov: start.fov * 0.4 + end.fov * 0.6
            });
        }

        controlPoints.push(end);
        controlPoints.sort((a, b) => a.timeSec - b.timeSec);

        // Generate dense per-frame positions using Catmull-Rom spline
        const frames: CameraPoseFrame[] = [];
        const nControls = controlPoints.length;

        for (let frameIdx = 0; frameIdx < totalFrames; frameIdx++) {
            const timeSec = (frameIdx / Math.max(1, totalFrames - 1)) * durationSec;

            let segIdx = 0;
            while (segIdx < nControls - 2 && controlPoints[segIdx + 1].timeSec <= timeSec) {
                segIdx++;
            }

            const cp1 = controlPoints[segIdx];
            const cp2 = controlPoints[segIdx + 1];
            const cp0 = segIdx > 0 ? controlPoints[segIdx - 1] : cp1;
            const cp3 = segIdx + 2 < nControls ? controlPoints[segIdx + 2] : cp2;

            const segDuration = cp2.timeSec - cp1.timeSec;
            const u = segDuration > 1e-4 ? Math.max(0.0, Math.min(1.0, (timeSec - cp1.timeSec) / segDuration)) : 0.0;

            const easeU = u * u * (3.0 - 2.0 * u);

            const pos = ContinuousSplineMatchmoveService.interpolatePoint(cp0.position, cp1.position, cp2.position, cp3.position, easeU);
            const tgt = ContinuousSplineMatchmoveService.interpolatePoint(cp0.target, cp1.target, cp2.target, cp3.target, easeU);
            const fov = cp1.fov + (cp2.fov - cp1.fov) * easeU;

            frames.push({
                frame: frameIdx,
                timeSec: Number(timeSec.toFixed(4)),
                position: [Number(pos[0].toFixed(3)), Number(pos[1].toFixed(3)), Number(pos[2].toFixed(3))],
                target: [Number(tgt[0].toFixed(3)), Number(tgt[1].toFixed(3)), Number(tgt[2].toFixed(3))],
                up: [0, 1, 0],
                fov: Number(fov.toFixed(2)),
                rollDeg: 0.0
            });
        }

        return {
            fps,
            durationSec,
            totalFrames,
            frames,
            origin: options.geoAnchor,
            environment: 'Google Photorealistic 3D Tiles'
        };
    }
}
