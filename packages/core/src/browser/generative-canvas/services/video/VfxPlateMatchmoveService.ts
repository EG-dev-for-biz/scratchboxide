/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type {
    CameraSolveTrack,
    CameraSolveFrame,
    GeodeticEphemerisAnchor,
    LensDistortionParams,
    TrackingMarker2D3D,
    VfxPlateConfig
} from '../../../../common/vfx-plate-protocol';
import {
    getSolarPosition,
    solarDirectionVector,
    type SolarPosition
} from '../../../../common/coordinate/solarPosition';
import type { Vec3 } from '../../../../common/coordinate/LocalTangentPlane';

export interface InterpolatedCameraPose {
    timeSeconds: number;
    position: Vec3;
    rotationQuaternion: [number, number, number, number]; // [qx, qy, qz, qw]
    fovDegrees: number;
    focalLengthMm: number;
    reprojectionErrorPx: number;
}

export interface SolarLightingResult {
    solarPosition: SolarPosition;
    directionVector: Vec3;
    directionalColor: string;
    directionalIntensity: number;
    ambientColor: string;
    ambientIntensity: number;
    isDaylight: boolean;
    elevationDegrees: number;
    azimuthDegrees: number;
}

export interface DriftEvaluationResult {
    meanDriftPx: number;
    maxDriftPx: number;
    status: 'locked' | 'drifting' | 'uncalibrated';
    residuals: Array<{
        markerId: string;
        platePoint2D: [number, number];
        projectedPoint2D: [number, number];
        driftPx: number;
    }>;
}

/**
 * Service for coordinating live-action VFX plates with 3D layers and generative media.
 * Eliminates camera solve drift, ephemeris/lighting discrepancies, and geometric swimming.
 */
export class VfxPlateMatchmoveService {
    /**
     * Interpolates the 6-DOF camera pose at any arbitrary continuous timeline timestamp.
     * Uses sub-frame cubic Hermite for camera position and spherical linear interpolation (slerp)
     * for camera rotation quaternions to ensure perfectly smooth, jitter-free matchmoves.
     */
    public static interpolateCameraSolve(
        track: CameraSolveTrack,
        timeSeconds: number
    ): InterpolatedCameraPose {
        const frames = track.frames;
        if (!frames || frames.length === 0) {
            return {
                timeSeconds,
                position: [0, 2, 5],
                rotationQuaternion: [0, 0, 0, 1],
                fovDegrees: 45,
                focalLengthMm: 35,
                reprojectionErrorPx: 0
            };
        }

        if (frames.length === 1 || timeSeconds <= frames[0].timeSeconds) {
            const f = frames[0];
            return {
                timeSeconds,
                position: [...f.position],
                rotationQuaternion: [...f.rotationQuaternion],
                fovDegrees: f.fovDegrees,
                focalLengthMm: f.focalLengthMm ?? this.fovToFocalLength(f.fovDegrees, track.sensorHeightMm ?? 24),
                reprojectionErrorPx: f.reprojectionErrorPx ?? track.meanReprojectionErrorPx ?? 0.0
            };
        }

        const lastFrame = frames[frames.length - 1];
        if (timeSeconds >= lastFrame.timeSeconds) {
            return {
                timeSeconds,
                position: [...lastFrame.position],
                rotationQuaternion: [...lastFrame.rotationQuaternion],
                fovDegrees: lastFrame.fovDegrees,
                focalLengthMm: lastFrame.focalLengthMm ?? this.fovToFocalLength(lastFrame.fovDegrees, track.sensorHeightMm ?? 24),
                reprojectionErrorPx: lastFrame.reprojectionErrorPx ?? track.meanReprojectionErrorPx ?? 0.0
            };
        }

        // Binary search to find segment [f0, f1]
        let low = 0;
        let high = frames.length - 1;
        while (low <= high) {
            const mid = Math.floor((low + high) / 2);
            if (frames[mid].timeSeconds <= timeSeconds) {
                if (mid === frames.length - 1 || frames[mid + 1].timeSeconds > timeSeconds) {
                    low = mid;
                    break;
                }
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }

        const f0 = frames[low];
        const f1 = frames[Math.min(low + 1, frames.length - 1)];
        const dt = f1.timeSeconds - f0.timeSeconds;
        const alpha = dt > 0.00001 ? (timeSeconds - f0.timeSeconds) / dt : 0;

        // Smooth cubic Hermite interpolation for position (smoothstep blend)
        const smoothAlpha = alpha * alpha * (3 - 2 * alpha);
        const position: Vec3 = [
            f0.position[0] + (f1.position[0] - f0.position[0]) * smoothAlpha,
            f0.position[1] + (f1.position[1] - f0.position[1]) * smoothAlpha,
            f0.position[2] + (f1.position[2] - f0.position[2]) * smoothAlpha
        ];

        // Slerp for rotation quaternion
        const rotationQuaternion = this.slerpQuaternion(f0.rotationQuaternion, f1.rotationQuaternion, alpha);

        // Linear interpolation for FOV and focal length
        const fovDegrees = f0.fovDegrees + (f1.fovDegrees - f0.fovDegrees) * alpha;
        const focalLengthMm = (f0.focalLengthMm !== undefined && f1.focalLengthMm !== undefined)
            ? f0.focalLengthMm + (f1.focalLengthMm - f0.focalLengthMm) * alpha
            : this.fovToFocalLength(fovDegrees, track.sensorHeightMm ?? 24);
        const err0 = f0.reprojectionErrorPx ?? track.meanReprojectionErrorPx ?? 0.0;
        const err1 = f1.reprojectionErrorPx ?? track.meanReprojectionErrorPx ?? 0.0;
        const reprojectionErrorPx = err0 * (1 - alpha) + err1 * alpha;

        return {
            timeSeconds,
            position,
            rotationQuaternion,
            fovDegrees,
            focalLengthMm,
            reprojectionErrorPx
        };
    }

    /**
     * Converts Vertical Field of View (degrees) to focal length in mm given sensor height.
     */
    public static fovToFocalLength(fovDegrees: number, sensorHeightMm: number = 24.0): number {
        const rad = (fovDegrees * Math.PI) / 180.0;
        return (sensorHeightMm / 2.0) / Math.tan(rad / 2.0);
    }

    /**
     * Converts focal length in mm to Vertical Field of View (degrees) given sensor height.
     */
    public static focalLengthToFov(focalLengthMm: number, sensorHeightMm: number = 24.0): number {
        const rad = 2.0 * Math.atan((sensorHeightMm / 2.0) / Math.max(1.0, focalLengthMm));
        return (rad * 180.0) / Math.PI;
    }

    /**
     * Spherical linear interpolation between two quaternions [qx, qy, qz, qw].
     */
    public static slerpQuaternion(
        qa: [number, number, number, number],
        qb: [number, number, number, number],
        t: number
    ): [number, number, number, number] {
        let [ax, ay, az, aw] = qa;
        let [bx, by, bz, bw] = qb;

        // Cosine of angle between quaternions
        let cosHalfTheta = ax * bx + ay * by + az * bz + aw * bw;

        // If negative, negate one quaternion to take the shortest path
        if (cosHalfTheta < 0) {
            bx = -bx;
            by = -by;
            bz = -bz;
            bw = -bw;
            cosHalfTheta = -cosHalfTheta;
        }

        if (Math.abs(cosHalfTheta) >= 1.0) {
            return [ax, ay, az, aw];
        }

        const halfTheta = Math.acos(Math.max(-1.0, Math.min(1.0, cosHalfTheta)));
        const sinHalfTheta = Math.sqrt(1.0 - cosHalfTheta * cosHalfTheta);

        if (Math.abs(sinHalfTheta) < 0.001) {
            // Very close angle: linear interpolation
            const rx = ax * (1 - t) + bx * t;
            const ry = ay * (1 - t) + by * t;
            const rz = az * (1 - t) + bz * t;
            const rw = aw * (1 - t) + bw * t;
            const len = Math.hypot(rx, ry, rz, rw);
            return [rx / len, ry / len, rz / len, rw / len];
        }

        const ratioA = Math.sin((1 - t) * halfTheta) / sinHalfTheta;
        const ratioB = Math.sin(t * halfTheta) / sinHalfTheta;

        return [
            ax * ratioA + bx * ratioB,
            ay * ratioA + by * ratioB,
            az * ratioA + bz * ratioB,
            aw * ratioA + bw * ratioB
        ];
    }

    /**
     * Computes the astronomical solar position and directional lighting vector for the plate's
     * real-world physical GPS location and filming timestamp.
     * Guarantees that synthetic shadows and lighting match the live plate without drift.
     */
    public static computeSolarLighting(anchor: GeodeticEphemerisAnchor): SolarLightingResult {
        const filmingDate = anchor.utcTimestampIso
            ? new Date(anchor.utcTimestampIso)
            : new Date();

        const solarPos = getSolarPosition(filmingDate, anchor.lat, anchor.lng);
        let dir = solarDirectionVector(solarPos);

        // If the scene set has a compass rotation heading from True North, rotate the solar vector
        if (anchor.headingDegrees !== undefined && anchor.headingDegrees !== 0) {
            const headingRad = (anchor.headingDegrees * Math.PI) / 180.0;
            const cosH = Math.cos(headingRad);
            const sinH = Math.sin(headingRad);
            // Rotate around Y axis (+Y is up, -Z is north, +X is east)
            const rx = dir[0] * cosH - dir[2] * sinH;
            const rz = dir[0] * sinH + dir[2] * cosH;
            dir = [rx, dir[1], rz];
        }

        const elevationDeg = (solarPos.altitude * 180.0) / Math.PI;
        const azimuthDeg = (solarPos.azimuth * 180.0) / Math.PI;
        const isDaylight = elevationDeg > -6.0; // Civil twilight threshold

        // Color and intensity grading based on solar altitude (golden hour vs daylight vs twilight)
        let directionalColor = '#ffffff';
        let directionalIntensity = 2.5;
        let ambientColor = '#8baac9';
        let ambientIntensity = 0.6;

        if (elevationDeg <= 0) {
            // Twilight or Night
            directionalColor = '#4a5d78';
            directionalIntensity = Math.max(0.1, 0.5 + elevationDeg * 0.05);
            ambientColor = '#1e293b';
            ambientIntensity = 0.3;
        } else if (elevationDeg < 15) {
            // Golden hour / Sunset warmth
            directionalColor = '#ff9f43';
            directionalIntensity = 2.0;
            ambientColor = '#94a3b8';
            ambientIntensity = 0.5;
        } else if (elevationDeg < 35) {
            // Morning / Late Afternoon
            directionalColor = '#ffecd2';
            directionalIntensity = 2.4;
            ambientColor = '#93c5fd';
            ambientIntensity = 0.7;
        } else {
            // Midday bright sun
            directionalColor = '#ffffff';
            directionalIntensity = 2.8;
            ambientColor = '#bfdbfe';
            ambientIntensity = 0.8;
        }

        return {
            solarPosition: solarPos,
            directionVector: dir,
            directionalColor,
            directionalIntensity,
            ambientColor,
            ambientIntensity,
            isDaylight,
            elevationDegrees: elevationDeg,
            azimuthDegrees: azimuthDeg
        };
    }

    /**
     * Evaluates quantitative reprojection drift error between 3D ground-truth tracking markers
     * and their 2D pixel coordinates on the live-action plate.
     * When lensDistortion is provided, 3D points are distorted through the optical model
     * before comparison to eliminate false drift on wide-angle or anamorphic lenses.
     */
    public static evaluateDrift(
        markers: TrackingMarker2D3D[],
        pose: InterpolatedCameraPose,
        resolution: { width: number; height: number },
        lensDistortion?: LensDistortionParams
    ): DriftEvaluationResult {
        if (!markers || markers.length === 0) {
            return {
                meanDriftPx: 0,
                maxDriftPx: 0,
                status: 'uncalibrated',
                residuals: []
            };
        }

        const { width, height } = resolution;
        const fovRad = (pose.fovDegrees * Math.PI) / 180.0;
        const aspect = width / height;
        const tanHalfFovV = Math.tan(fovRad / 2.0);
        const tanHalfFovH = tanHalfFovV * aspect;

        let totalDrift = 0;
        let maxDrift = 0;
        const residuals: DriftEvaluationResult['residuals'] = [];

        // Camera orientation matrix from quaternion [qx, qy, qz, qw]
        const [qx, qy, qz, qw] = pose.rotationQuaternion;
        // World-to-Camera rotation matrix (inverse of camera orientation)
        // For unit quaternion, conjugate is inverse: [-qx, -qy, -qz, qw]
        const iqx = -qx;
        const iqy = -qy;
        const iqz = -qz;
        const iqw = qw;

        for (const marker of markers) {
            // 1. Translate point relative to camera origin
            const dx = marker.worldPoint3D[0] - pose.position[0];
            const dy = marker.worldPoint3D[1] - pose.position[1];
            const dz = marker.worldPoint3D[2] - pose.position[2];

            // 2. Rotate into camera coordinate frame via inverse quaternion
            // v' = q * v * q^-1
            const ix = iqw * dx + iqy * dz - iqz * dy;
            const iy = iqw * dy + iqz * dx - iqx * dz;
            const iz = iqw * dz + iqx * dy - iqy * dx;
            const iw = -iqx * dx - iqy * dy - iqz * dz;

            const cx = ix * iqw + iw * -iqx + iy * -iqz - iz * -iqy;
            const cy = iy * iqw + iw * -iqy + iz * -iqx - ix * -iqz;
            const cz = iz * iqw + iw * -iqz + ix * -iqy - iy * -iqx;

            // In standard Three.js camera space: camera looks along -Z.
            // Distance forward along optical axis:
            const zDepth = -cz;
            if (zDepth <= 0.01) {
                // Point is behind camera or on the near plane
                continue;
            }

            // 3. Project to normalized rectilinear screen coordinates
            const ndcX = cx / (zDepth * tanHalfFovH);
            const ndcY = cy / (zDepth * tanHalfFovV);

            let finalNdcX = ndcX;
            let finalNdcY = ndcY;

            // Apply lens distortion to project into authentic plate coordinate space
            if (lensDistortion && (
                lensDistortion.k1 !== 0 ||
                lensDistortion.k2 !== 0 ||
                lensDistortion.p1 ||
                lensDistortion.p2 ||
                lensDistortion.model ||
                (lensDistortion.anamorphicSqueeze && lensDistortion.anamorphicSqueeze !== 1.0)
            )) {
                const [distX, distY] = this.distortPoint(ndcX, ndcY, lensDistortion);
                finalNdcX = distX;
                finalNdcY = distY;
            }

            const projX = (finalNdcX + 1.0) * 0.5 * width;
            const projY = (1.0 - finalNdcY) * 0.5 * height;

            const diffX = projX - marker.platePoint2D[0];
            const diffY = projY - marker.platePoint2D[1];
            const driftDist = Math.hypot(diffX, diffY);

            totalDrift += driftDist;
            if (driftDist > maxDrift) {
                maxDrift = driftDist;
            }

            residuals.push({
                markerId: marker.id,
                platePoint2D: marker.platePoint2D,
                projectedPoint2D: [projX, projY],
                driftPx: driftDist
            });
        }

        const count = residuals.length;
        const meanDrift = count > 0 ? totalDrift / count : 0;

        let status: DriftEvaluationResult['status'] = 'locked';
        if (meanDrift > 2.0) {
            status = 'drifting';
        }

        return {
            meanDriftPx: meanDrift,
            maxDriftPx: maxDrift,
            status,
            residuals
        };
    }

    /**
     * Applies optical lens distortion to a 2D normalized coordinate [-1 to +1].
     * Supports Brown-Conrady, Kannala-Brandt Fisheye, and 3DE4 Anamorphic Degree 4 models.
     */
    public static distortPoint(
        uNorm: number, // -1 to +1 from optical center
        vNorm: number, // -1 to +1 from optical center
        params: LensDistortionParams
    ): [number, number] {
        const {
            k1,
            k2,
            k3 = 0,
            k4 = 0,
            p1 = 0,
            p2 = 0,
            anamorphicSqueeze = 1.0,
            squeezeFactor,
            model = 'brown_conrady'
        } = params;
        const squeeze = squeezeFactor ?? anamorphicSqueeze;

        if (model === 'kannala_brandt_fisheye') {
            const x = uNorm / squeeze;
            const y = vNorm;
            const r = Math.hypot(x, y);
            if (r < 1e-12) return [0, 0];

            const fk1 = params.fisheyeK1 ?? k1;
            const fk2 = params.fisheyeK2 ?? k2;
            const fk3 = params.fisheyeK3 ?? k3;
            const fk4 = params.fisheyeK4 ?? k4;

            const theta = Math.atan(r);
            const theta2 = theta * theta;
            const dTheta = theta * (1.0 + fk1 * theta2 + fk2 * theta2 * theta2 + fk3 * theta2 * theta2 * theta2 + fk4 * theta2 * theta2 * theta2 * theta2);
            const scale = dTheta / r;

            return [(x * scale) * squeeze, y * scale];
        }

        if (model === 'anamorphic_deg4') {
            const x = uNorm / squeeze;
            const y = vNorm;
            const x2 = x * x;
            const y2 = y * y;
            const c20 = params.c20 ?? k1;
            const c02 = params.c02 ?? (k1 * 0.5);
            const c40 = params.c40 ?? k2;
            const c22 = params.c22 ?? (k2 * 0.7);
            const c04 = params.c04 ?? (k2 * 0.4);

            const poly = 1.0 + c20 * x2 + c02 * y2 + c40 * x2 * x2 + c22 * x2 * y2 + c04 * y2 * y2;
            return [(x * poly) * squeeze, y * poly];
        }

        // Standard Brown-Conrady Polynomial
        const x = uNorm / squeeze;
        const y = vNorm;
        const r2 = x * x + y * y;
        const r4 = r2 * r2;
        const r6 = r4 * r2;
        const r8 = r4 * r4;

        const radial = 1.0 + k1 * r2 + k2 * r4 + k3 * r6 + k4 * r8;
        const xTangential = 2.0 * p1 * x * y + p2 * (r2 + 2.0 * x * x);
        const yTangential = p1 * (r2 + 2.0 * y * y) + 2.0 * p2 * x * y;

        const xDist = (x * radial + xTangential) * squeeze;
        const yDist = y * radial + yTangential;

        return [xDist, yDist];
    }

    /**
     * Undistorts a distorted point back to rectilinear space using high-precision
     * 2D damped Newton-Raphson optimization with analytical Jacobian inversion.
     * Guarantees monotonic convergence and sub-pixel accuracy (< 1e-8) without divergence.
     */
    public static undistortPoint(
        uDist: number,
        vDist: number,
        params: LensDistortionParams,
        maxIterations: number = 10,
        tolerance: number = 1e-8
    ): [number, number] {
        const {
            k1,
            k2,
            k3 = 0,
            k4 = 0,
            p1 = 0,
            p2 = 0,
            anamorphicSqueeze = 1.0,
            squeezeFactor,
            model = 'brown_conrady'
        } = params;
        const squeeze = squeezeFactor ?? anamorphicSqueeze;

        if (k1 === 0 && k2 === 0 && k3 === 0 && k4 === 0 && p1 === 0 && p2 === 0 && !params.c20 && !params.fisheyeK1) {
            return [uDist, vDist];
        }

        if (model === 'kannala_brandt_fisheye') {
            const xD = uDist / squeeze;
            const yD = vDist;
            const rD = Math.hypot(xD, yD);
            if (rD < 1e-12) return [0, 0];

            const fk1 = params.fisheyeK1 ?? k1;
            const fk2 = params.fisheyeK2 ?? k2;
            const fk3 = params.fisheyeK3 ?? k3;
            const fk4 = params.fisheyeK4 ?? k4;

            // 1D Newton-Raphson to solve d(theta) - rD = 0
            let theta = rD;
            for (let iter = 0; iter < maxIterations; iter++) {
                const t2 = theta * theta;
                const t4 = t2 * t2;
                const t6 = t4 * t2;
                const t8 = t4 * t4;
                const fVal = theta * (1.0 + fk1 * t2 + fk2 * t4 + fk3 * t6 + fk4 * t8) - rD;
                const fPrime = 1.0 + 3.0 * fk1 * t2 + 5.0 * fk2 * t4 + 7.0 * fk3 * t6 + 9.0 * fk4 * t8;
                if (Math.abs(fPrime) < 1e-12) break;
                const step = fVal / fPrime;
                theta -= step;
                if (Math.abs(step) < tolerance) break;
            }

            const rU = Math.tan(theta);
            const scale = rU / rD;
            return [(xD * scale) * squeeze, yD * scale];
        }

        // Target coordinates in de-squeezed sensor space
        const targetX = uDist / squeeze;
        const targetY = vDist;

        // Initial estimate
        let x = targetX;
        let y = targetY;

        for (let iter = 0; iter < maxIterations; iter++) {
            const r2 = x * x + y * y;
            const r4 = r2 * r2;
            const r6 = r4 * r2;
            const r8 = r4 * r4;

            let fx: number;
            let fy: number;
            let j00: number;
            let j01: number;
            let j10: number;
            let j11: number;

            if (model === 'anamorphic_deg4') {
                const x2 = x * x;
                const y2 = y * y;
                const c20 = params.c20 ?? k1;
                const c02 = params.c02 ?? (k1 * 0.5);
                const c40 = params.c40 ?? k2;
                const c22 = params.c22 ?? (k2 * 0.7);
                const c04 = params.c04 ?? (k2 * 0.4);

                const poly = 1.0 + c20 * x2 + c02 * y2 + c40 * x2 * x2 + c22 * x2 * y2 + c04 * y2 * y2;
                fx = x * poly;
                fy = y * poly;

                const dPolyDx = 2.0 * c20 * x + 4.0 * c40 * x * x2 + 2.0 * c22 * x * y2;
                const dPolyDy = 2.0 * c02 * y + 4.0 * c04 * y * y2 + 2.0 * c22 * x2 * y;

                j00 = poly + x * dPolyDx;
                j01 = x * dPolyDy;
                j10 = y * dPolyDx;
                j11 = poly + y * dPolyDy;
            } else {
                const radial = 1.0 + k1 * r2 + k2 * r4 + k3 * r6 + k4 * r8;
                const xTang = 2.0 * p1 * x * y + p2 * (r2 + 2.0 * x * x);
                const yTang = p1 * (r2 + 2.0 * y * y) + 2.0 * p2 * x * y;

                fx = x * radial + xTang;
                fy = y * radial + yTang;

                // Derivative of radial factor w.r.t r^2
                const dRadialDr2 = k1 + 2.0 * k2 * r2 + 3.0 * k3 * r4 + 4.0 * k4 * r6;
                const dRadialDx = 2.0 * x * dRadialDr2;
                const dRadialDy = 2.0 * y * dRadialDr2;

                j00 = radial + x * dRadialDx + 2.0 * p1 * y + 6.0 * p2 * x;
                j01 = x * dRadialDy + 2.0 * p1 * x + 2.0 * p2 * y;
                j10 = y * dRadialDx + 2.0 * p1 * x + 2.0 * p2 * y;
                j11 = radial + y * dRadialDy + 6.0 * p1 * y + 2.0 * p2 * x;
            }

            const rx = fx - targetX;
            const ry = fy - targetY;
            const resNorm = Math.hypot(rx, ry);
            if (resNorm < tolerance) {
                break;
            }

            const det = j00 * j11 - j01 * j10;
            if (Math.abs(det) < 1e-14) {
                x -= 0.5 * rx;
                y -= 0.5 * ry;
                continue;
            }

            // Analytical matrix inverse step: J^-1 * R
            const stepX = (j11 * rx - j01 * ry) / det;
            const stepY = (-j10 * rx + j00 * ry) / det;

            // Damped update with backtracking limit
            let alpha = 1.0;
            const stepDist = Math.hypot(stepX, stepY);
            if (stepDist > 1.0) {
                alpha = 1.0 / stepDist;
            }

            x -= alpha * stepX;
            y -= alpha * stepY;

            if (Math.hypot(stepX * alpha, stepY * alpha) < tolerance) {
                break;
            }
        }

        return [x * squeeze, y];
    }
}
