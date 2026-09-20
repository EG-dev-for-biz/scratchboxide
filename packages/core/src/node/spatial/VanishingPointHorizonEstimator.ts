/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { Point2D, CameraIntrinsics } from './SpatialPoseEstimatorService';

export interface LineSegment2D {
    p1: Point2D; // [x, y]
    p2: Point2D; // [x, y]
    lengthPx: number;
    angleDeg: number; // angle in degrees from horizontal (-90 to +90)
    weight: number;
}

export type CameraTiltClassification = 'looking-upward' | 'looking-downward' | 'horizontal-nadir-level';

export interface VanishingPointResult {
    /** Zenith vanishing point [u, v] in pixels (intersection of vertical architectural lines) */
    zenithVp: Point2D | null;
    /** Horizontal vanishing point 1 [u, v] (along first orthogonal facade direction) */
    horizontalVp1: Point2D | null;
    /** Horizontal vanishing point 2 [u, v] (along second orthogonal facade direction) */
    horizontalVp2: Point2D | null;
    /** True camera optical pitch angle in degrees (positive = looking UP, negative = looking DOWN) */
    pitchDeg: number;
    /** Roll angle in degrees */
    rollDeg: number;
    /** Camera optical horizon line represented as [slope, yIntercept] or null if vertical */
    horizonLine: {
        slope: number;
        yIntercept: number;
        horizonYAtCenter: number;
    } | null;
    /** Qualitative camera tilt classification */
    classification: CameraTiltClassification;
    /** Metric altitude bounding range estimate relative to visible landmark elevation */
    altitudeBounds?: {
        minAltitudeMeters: number;
        maxAltitudeMeters: number;
        estimatedAltitudeMeters: number;
    };
    /** Diagnostic metrics */
    metrics: {
        verticalLineCount: number;
        horizontalLineCount: number;
        confidence: number;
    };
}

/**
 * Analytical 3-Point Vanishing Point & Optical Horizon Solver.
 * Solves absolute camera pitch sign and optical horizon directly from image geometry,
 * preventing pitch inversion and altitude overshoot across arbitrary video plates.
 */
export class VanishingPointHorizonEstimator {
    /**
     * Extracts 2D line segments from a luminance gradient / edge field.
     */
    public static extractLineSegments(
        grayscale: Uint8Array | Uint8ClampedArray | Float32Array,
        width: number,
        height: number,
        options: {
            minLineLengthPx?: number;
            gradientThreshold?: number;
            maxLines?: number;
        } = {}
    ): LineSegment2D[] {
        const minLength = options.minLineLengthPx ?? Math.min(width, height) * 0.04;
        const gradThreshold = options.gradientThreshold ?? 25.0;
        const maxLines = options.maxLines ?? 150;

        const lines: LineSegment2D[] = [];
        const step = Math.max(2, Math.floor(Math.min(width, height) / 120));

        // Sample horizontal scans
        for (let y = step; y < height - step; y += step * 3) {
            let segStart: Point2D | null = null;
            for (let x = step; x < width - step; x += step) {
                const idx = y * width + x;
                const gx = Number(grayscale[idx + 1]) - Number(grayscale[idx - 1]);
                const gy = Number(grayscale[idx + width]) - Number(grayscale[idx - width]);
                const mag = Math.sqrt(gx * gx + gy * gy);

                if (mag > gradThreshold) {
                    if (!segStart) segStart = [x, y];
                } else if (segStart) {
                    const len = Math.hypot(x - segStart[0], y - segStart[1]);
                    if (len >= minLength) {
                        const angle = Math.atan2(y - segStart[1], x - segStart[0]) * (180.0 / Math.PI);
                        lines.push({
                            p1: segStart,
                            p2: [x, y],
                            lengthPx: len,
                            angleDeg: angle,
                            weight: len * (mag / 255.0)
                        });
                    }
                    segStart = null;
                }
            }
        }

        // Sample vertical scans
        for (let x = step; x < width - step; x += step * 3) {
            let segStart: Point2D | null = null;
            for (let y = step; y < height - step; y += step) {
                const idx = y * width + x;
                const gx = Number(grayscale[idx + 1]) - Number(grayscale[idx - 1]);
                const gy = Number(grayscale[idx + width]) - Number(grayscale[idx - width]);
                const mag = Math.sqrt(gx * gx + gy * gy);

                if (mag > gradThreshold) {
                    if (!segStart) segStart = [x, y];
                } else if (segStart) {
                    const len = Math.hypot(x - segStart[0], y - segStart[1]);
                    if (len >= minLength) {
                        const angle = Math.atan2(y - segStart[1], x - segStart[0]) * (180.0 / Math.PI);
                        lines.push({
                            p1: segStart,
                            p2: [x, y],
                            lengthPx: len,
                            angleDeg: angle,
                            weight: len * (mag / 255.0)
                        });
                    }
                    segStart = null;
                }
            }
        }

        // Sort by weight descending and truncate
        lines.sort((a, b) => b.weight - a.weight);
        return lines.slice(0, maxLines);
    }

    /**
     * Finds the intersection point of two 2D line segments represented in homogeneous coordinates.
     */
    public static intersectLines(lineA: LineSegment2D, lineB: LineSegment2D): Point2D | null {
        const x1 = lineA.p1[0], y1 = lineA.p1[1];
        const x2 = lineA.p2[0], y2 = lineA.p2[1];
        const x3 = lineB.p1[0], y3 = lineB.p1[1];
        const x4 = lineB.p2[0], y4 = lineB.p2[1];

        const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
        if (Math.abs(denom) < 1e-6) {
            return null; // Parallel lines
        }

        const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
        const ix = x1 + t * (x2 - x1);
        const iy = y1 + t * (y2 - y1);

        return [ix, iy];
    }

    /**
     * Solves camera pitch, roll, zenith vanishing point and horizon line directly
     * from a set of 2D architectural line segments and camera intrinsics.
     */
    public static solveFromLines(
        lines: LineSegment2D[],
        intrinsics: CameraIntrinsics,
        options: {
            landmarkBaseElevationMeters?: number;
            landmarkHeightMeters?: number;
        } = {}
    ): VanishingPointResult {
        const { fx, fy, cx, cy } = intrinsics;

        // 1. Separate lines into Vertical candidates (|angle| > 55°) and Horizontal candidates (|angle| < 45°)
        const verticalLines: LineSegment2D[] = [];
        const horizontalLines: LineSegment2D[] = [];

        for (const line of lines) {
            const absAngle = Math.abs(line.angleDeg);
            if (absAngle >= 55.0 && absAngle <= 125.0) {
                verticalLines.push(line);
            } else if (absAngle <= 45.0 || absAngle >= 135.0) {
                horizontalLines.push(line);
            }
        }

        // 2. Solve Zenith Vanishing Point (Vz) from vertical line intersections via RANSAC
        let zenithVp: Point2D | null = null;
        let bestVzInliers = 0;

        if (verticalLines.length >= 2) {
            const candidates: Point2D[] = [];
            for (let i = 0; i < verticalLines.length; i++) {
                for (let j = i + 1; j < Math.min(verticalLines.length, i + 8); j++) {
                    const pt = this.intersectLines(verticalLines[i], verticalLines[j]);
                    if (pt) candidates.push(pt);
                }
            }

            if (candidates.length > 0) {
                for (const cand of candidates) {
                    let inliers = 0;
                    for (const vline of verticalLines) {
                        const midX = (vline.p1[0] + vline.p2[0]) * 0.5;
                        const midY = (vline.p1[1] + vline.p2[1]) * 0.5;
                        const lineVec = [vline.p2[0] - vline.p1[0], vline.p2[1] - vline.p1[1]];
                        const toCand = [cand[0] - midX, cand[1] - midY];

                        const lenA = Math.hypot(lineVec[0], lineVec[1]);
                        const lenB = Math.hypot(toCand[0], toCand[1]);
                        if (lenA > 0 && lenB > 0) {
                            const cosTheta = Math.abs((lineVec[0] * toCand[0] + lineVec[1] * toCand[1]) / (lenA * lenB));
                            if (cosTheta > 0.985) inliers++;
                        }
                    }

                    if (inliers > bestVzInliers) {
                        bestVzInliers = inliers;
                        zenithVp = cand;
                    }
                }
            }
        }

        // 3. Solve Horizontal Vanishing Point 1 (Vx) from horizontal line intersections
        let horizontalVp1: Point2D | null = null;
        let horizontalVp2: Point2D | null = null;

        if (horizontalLines.length >= 2) {
            const candidates: Point2D[] = [];
            for (let i = 0; i < horizontalLines.length; i++) {
                for (let j = i + 1; j < Math.min(horizontalLines.length, i + 8); j++) {
                    const pt = this.intersectLines(horizontalLines[i], horizontalLines[j]);
                    if (pt) candidates.push(pt);
                }
            }
            if (candidates.length > 0) {
                candidates.sort((a, b) => a[0] - b[0]);
                horizontalVp1 = candidates[Math.floor(candidates.length / 2)];
            }
        }

        // 4. Calculate Pitch Angle (theta_pitch) from Zenith VP displacement
        let pitchDeg = 0.0;
        let rollDeg = 0.0;
        let classification: CameraTiltClassification = 'horizontal-nadir-level';

        if (zenithVp) {
            const deltaY = cy - zenithVp[1];
            const deltaX = zenithVp[0] - cx;

            // Roll angle
            rollDeg = Math.atan2(deltaX, Math.abs(deltaY) > 1e-4 ? deltaY : 1e-4) * (180.0 / Math.PI);
            if (Math.abs(rollDeg) > 45.0) rollDeg = 0.0;

            // If vz is ABOVE principal point cy (in standard screen coords where y=0 is top):
            // vz < cy -> deltaY = cy - vz > 0 -> camera is looking UPWARD!
            // tan(pitch) = deltaY / fy
            const tanPitch = deltaY / fy;
            pitchDeg = Math.atan(tanPitch) * (180.0 / Math.PI);

            if (pitchDeg > 3.0) {
                classification = 'looking-upward';
            } else if (pitchDeg < -3.0) {
                classification = 'looking-downward';
            } else {
                classification = 'horizontal-nadir-level';
            }
        }

        // 5. Calculate Horizon Line
        let horizonLine: { slope: number; yIntercept: number; horizonYAtCenter: number } | null = null;
        const horizonY = cy + Math.tan(pitchDeg * (Math.PI / 180.0)) * fy;
        if (horizontalVp1) {
            const slope = -Math.tan(rollDeg * (Math.PI / 180.0));
            const yIntercept = horizonY - slope * cx;
            horizonLine = {
                slope,
                yIntercept,
                horizonYAtCenter: horizonY
            };
        } else {
            horizonLine = {
                slope: 0.0,
                yIntercept: horizonY,
                horizonYAtCenter: horizonY
            };
        }

        // 6. Estimate Altitude Bounds based on horizon line position relative to landmark
        let altitudeBounds: VanishingPointResult['altitudeBounds'] = undefined;
        const baseAlt = options.landmarkBaseElevationMeters ?? 0.0;
        const heightMeters = options.landmarkHeightMeters ?? 70.0;

        if (classification === 'looking-upward') {
            const roofAlt = baseAlt + heightMeters;
            altitudeBounds = {
                minAltitudeMeters: baseAlt + 2.0,
                maxAltitudeMeters: roofAlt - heightMeters * 0.15,
                estimatedAltitudeMeters: baseAlt + heightMeters * 0.70 // ~15th floor
            };
        } else if (classification === 'looking-downward') {
            const roofAlt = baseAlt + heightMeters;
            altitudeBounds = {
                minAltitudeMeters: roofAlt - 5.0,
                maxAltitudeMeters: roofAlt + 150.0,
                estimatedAltitudeMeters: roofAlt + 15.0
            };
        } else {
            altitudeBounds = {
                minAltitudeMeters: baseAlt,
                maxAltitudeMeters: baseAlt + heightMeters,
                estimatedAltitudeMeters: baseAlt + heightMeters * 0.5
            };
        }

        const confidence = Math.min(1.0, (bestVzInliers + verticalLines.length) / Math.max(10, lines.length));

        return {
            zenithVp,
            horizontalVp1,
            horizontalVp2,
            pitchDeg: Number(pitchDeg.toFixed(2)),
            rollDeg: Number(rollDeg.toFixed(2)),
            horizonLine,
            classification,
            altitudeBounds,
            metrics: {
                verticalLineCount: verticalLines.length,
                horizontalLineCount: horizontalLines.length,
                confidence: Number(confidence.toFixed(3))
            }
        };
    }

    /**
     * Metric altitude bounding range estimate relative to visible landmark elevation.
     */
    public static estimateAltitudeBounds(
        pitchDeg: number,
        standoffDistMeters: number,
        landmarkApexAltMeters: number
    ): { minAltitudeMeters: number; maxAltitudeMeters: number; estimatedAltitudeMeters: number; isUpwardGated: boolean } {
        const pitchRad = pitchDeg * (Math.PI / 180.0);
        const deltaH = standoffDistMeters * Math.sin(pitchRad);
        const estimatedAlt = landmarkApexAltMeters - deltaH;
        return {
            minAltitudeMeters: Math.max(0.0, estimatedAlt - 35.0),
            maxAltitudeMeters: landmarkApexAltMeters,
            estimatedAltitudeMeters: Math.max(0.0, Number(estimatedAlt.toFixed(2))),
            isUpwardGated: pitchDeg > 0
        };
    }

    /**
     * Direct estimation of pitch angle from synthetic or measured 2D line endpoints.
     */
    public static estimatePitchFromVerticalLines(
        verticalLines: (LineSegment2D | { x1: number; y1: number; x2: number; y2: number })[],
        intrinsicsOrWidth?: Partial<CameraIntrinsics> | number,
        height?: number,
        fovYDeg?: number
    ): VanishingPointResult {
        let intrinsics: CameraIntrinsics;
        if (typeof intrinsicsOrWidth === 'number') {
            const w = intrinsicsOrWidth;
            const h = height ?? 1080;
            const fov = fovYDeg ?? 40.0;
            const fy = (h / 2.0) / Math.tan((fov / 2.0) * (Math.PI / 180.0));
            intrinsics = {
                fx: fy,
                fy: fy,
                cx: w / 2.0,
                cy: h / 2.0,
                width: w,
                height: h
            };
        } else if (intrinsicsOrWidth && 'fx' in intrinsicsOrWidth && intrinsicsOrWidth.fx) {
            intrinsics = {
                fx: intrinsicsOrWidth.fx ?? 1483.5,
                fy: intrinsicsOrWidth.fy ?? 1483.5,
                cx: intrinsicsOrWidth.cx ?? 960,
                cy: intrinsicsOrWidth.cy ?? 540,
                width: intrinsicsOrWidth.width ?? 1920,
                height: intrinsicsOrWidth.height ?? 1080
            };
        } else {
            intrinsics = {
                fx: 1483.5,
                fy: 1483.5,
                cx: 960.0,
                cy: 540.0,
                width: 1920,
                height: 1080
            };
        }

        const segments: LineSegment2D[] = verticalLines.map(v => {
            if ('p1' in v && 'p2' in v) {
                return v;
            }
            const dx = v.x2 - v.x1;
            const dy = v.y2 - v.y1;
            const len = Math.hypot(dx, dy);
            return {
                p1: [v.x1, v.y1],
                p2: [v.x2, v.y2],
                lengthPx: len,
                angleDeg: Math.atan2(dy, dx) * (180.0 / Math.PI),
                weight: len
            };
        });

        return this.solveFromLines(segments, intrinsics);
    }
}
