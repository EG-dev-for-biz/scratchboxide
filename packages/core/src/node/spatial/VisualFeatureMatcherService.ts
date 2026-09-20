/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { Point2D, Point3D, CameraIntrinsics } from './SpatialPoseEstimatorService';

export interface VisualKeypoint {
    x: number;
    y: number;
    response: number;
    scale: number;
    angleRad: number;
    descriptor: Float32Array; // 128-D normalized gradient descriptor
}

export interface FeatureMatch2D {
    index1: number;
    index2: number;
    point1: Point2D;
    point2: Point2D;
    distance: number;
    confidence: number;
}

export interface FeatureMatch2D3D {
    point2D: Point2D;     // Pixel coordinate in photograph [u, v]
    point3D: Point3D;     // Real-world 3D coordinate in tile / ENU frame [X, Y, Z]
    depthMeters: number;  // Depth from camera
    confidence: number;   // 0.0 - 1.0
}

export interface KeypointDetectionOptions {
    maxKeypoints?: number;
    qualityThreshold?: number;
    minDistancePx?: number;
    fastCornerThreshold?: number;
}

export interface MatchingOptions {
    maxDistance?: number;
    loweRatio?: number;        // Lowe's ratio test threshold (default: 0.75)
    crossCheck?: boolean;       // Mutual nearest neighbor check (default: true)
}

export interface DepthBuffer3D {
    width: number;
    height: number;
    /** Depth values in meters (Float32Array of length width * height) */
    depthMap: Float32Array;
    /** Camera extrinsics used when rendering this depth map */
    cameraMatrixWorld: number[][]; // 4x4 matrix
    intrinsics: CameraIntrinsics;
}

export class VisualFeatureMatcherService {
    /**
     * Extracts salient 2D keypoints and 128-D normalized gradient descriptors
     * from a grayscale image buffer.
     */
    public static extractKeypoints(
        imageData: Uint8ClampedArray | Uint8Array | Float32Array,
        width: number,
        height: number,
        options: KeypointDetectionOptions = {}
    ): VisualKeypoint[] {
        const maxKeypoints = options.maxKeypoints ?? 500;
        const qualityThreshold = options.qualityThreshold ?? 0.01;
        const minDistancePx = options.minDistancePx ?? 6;

        // 1. Convert to grayscale float array if necessary
        const gray = this.toGrayscale(imageData, width, height);

        // 2. Compute spatial image gradients Ix and Iy using 3x3 Sobel
        const { Ix, Iy } = this.computeSobelGradients(gray, width, height);

        // 3. Compute Harris Corner Response: R = det(M) - k * trace(M)^2
        const k = 0.04;
        const response = new Float32Array(width * height);
        let maxResponse = 0;

        // Gaussian blur window size = 5 (radius 2)
        const radius = 2;
        for (let y = radius; y < height - radius; y++) {
            for (let x = radius; x < width - radius; x++) {
                let sxx = 0;
                let syy = 0;
                let sxy = 0;

                for (let dy = -radius; dy <= radius; dy++) {
                    const row = (y + dy) * width;
                    for (let dx = -radius; dx <= radius; dx++) {
                        const idx = row + (x + dx);
                        const ix = Ix[idx];
                        const iy = Iy[idx];
                        sxx += ix * ix;
                        syy += iy * iy;
                        sxy += ix * iy;
                    }
                }

                const det = sxx * syy - sxy * sxy;
                const trace = sxx + syy;
                const r = det - k * trace * trace;

                if (r > 0) {
                    const idx = y * width + x;
                    response[idx] = r;
                    if (r > maxResponse) maxResponse = r;
                }
            }
        }

        const minResponse = maxResponse * qualityThreshold;

        // 4. Non-Maximum Suppression (3x3 grid) and candidate collection
        interface Candidate {
            x: number;
            y: number;
            r: number;
        }
        const candidates: Candidate[] = [];

        for (let y = radius + 1; y < height - radius - 1; y++) {
            for (let x = radius + 1; x < width - radius - 1; x++) {
                const idx = y * width + x;
                const r = response[idx];
                if (r < minResponse) continue;

                // 3x3 local maximum test
                let isMax = true;
                for (let dy = -1; dy <= 1 && isMax; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        if (dx === 0 && dy === 0) continue;
                        if (response[(y + dy) * width + (x + dx)] >= r) {
                            isMax = false;
                            break;
                        }
                    }
                }

                if (isMax) {
                    candidates.push({ x, y, r });
                }
            }
        }

        // Sort descending by response
        candidates.sort((a, b) => b.r - a.r);

        // 5. Spatial suppression by minDistancePx
        const selected: Candidate[] = [];
        const minDistanceSq = minDistancePx * minDistancePx;

        for (const cand of candidates) {
            let tooClose = false;
            for (const s of selected) {
                const dx = cand.x - s.x;
                const dy = cand.y - s.y;
                if (dx * dx + dy * dy < minDistanceSq) {
                    tooClose = true;
                    break;
                }
            }
            if (!tooClose) {
                selected.push(cand);
                if (selected.length >= maxKeypoints) break;
            }
        }

        // 6. Extract 128-D SIFT-style Gradient Histogram Descriptors for each keypoint
        const keypoints: VisualKeypoint[] = [];
        for (const cand of selected) {
            const descriptor = this.extractPatchDescriptor(Ix, Iy, width, height, cand.x, cand.y);
            const angleRad = Math.atan2(Iy[cand.y * width + cand.x], Ix[cand.y * width + cand.x]);

            keypoints.push({
                x: cand.x,
                y: cand.y,
                response: cand.r,
                scale: 1.0,
                angleRad,
                descriptor
            });
        }

        return keypoints;
    }

    /**
     * Matches keypoints between two sets using Lowe's ratio test and optional mutual cross-check.
     */
    public static matchKeypoints(
        keypoints1: VisualKeypoint[],
        keypoints2: VisualKeypoint[],
        options: MatchingOptions = {}
    ): FeatureMatch2D[] {
        const loweRatio = options.loweRatio ?? 0.75;
        const crossCheck = options.crossCheck !== false;
        const maxDist = options.maxDistance ?? 0.65;

        if (keypoints1.length === 0 || keypoints2.length === 0) {
            return [];
        }

        // Forward match: for each k1, find closest and 2nd closest in k2
        const forwardMatches: { index2: number; dist: number }[] = [];

        for (let i = 0; i < keypoints1.length; i++) {
            const desc1 = keypoints1[i].descriptor;
            let bestDist = Infinity;
            let secondBestDist = Infinity;
            let bestIdx = -1;

            for (let j = 0; j < keypoints2.length; j++) {
                const dist = this.euclideanDistance(desc1, keypoints2[j].descriptor);
                if (dist < bestDist) {
                    secondBestDist = bestDist;
                    bestDist = dist;
                    bestIdx = j;
                } else if (dist < secondBestDist) {
                    secondBestDist = dist;
                }
            }

            // Lowe's ratio test: best / secondBest <= ratio
            if (bestIdx >= 0 && bestDist / (secondBestDist + 1e-7) <= loweRatio && bestDist <= maxDist) {
                forwardMatches[i] = { index2: bestIdx, dist: bestDist };
            } else {
                forwardMatches[i] = { index2: -1, dist: Infinity };
            }
        }

        // Reverse match if crossCheck is true
        let backwardMatches: number[] | null = null;
        if (crossCheck) {
            backwardMatches = new Array(keypoints2.length).fill(-1);
            for (let j = 0; j < keypoints2.length; j++) {
                const desc2 = keypoints2[j].descriptor;
                let bestDist = Infinity;
                let secondBestDist = Infinity;
                let bestIdx = -1;

                for (let i = 0; i < keypoints1.length; i++) {
                    const dist = this.euclideanDistance(desc2, keypoints1[i].descriptor);
                    if (dist < bestDist) {
                        secondBestDist = bestDist;
                        bestDist = dist;
                        bestIdx = i;
                    } else if (dist < secondBestDist) {
                        secondBestDist = dist;
                    }
                }

                if (bestIdx >= 0 && bestDist / (secondBestDist + 1e-7) <= loweRatio) {
                    backwardMatches[j] = bestIdx;
                }
            }
        }

        // Collect matches
        const matches: FeatureMatch2D[] = [];
        for (let i = 0; i < keypoints1.length; i++) {
            const match = forwardMatches[i];
            if (match.index2 < 0) continue;

            if (crossCheck && backwardMatches && backwardMatches[match.index2] !== i) {
                continue; // Failed mutual consistency
            }

            const k1 = keypoints1[i];
            const k2 = keypoints2[match.index2];

            matches.push({
                index1: i,
                index2: match.index2,
                point1: [k1.x, k1.y],
                point2: [k2.x, k2.y],
                distance: match.dist,
                confidence: Math.max(0, 1.0 - match.dist)
            });
        }

        return matches;
    }

    /**
     * Lifts 2D matched points into metric 3D world space using a 3D depth map
     * and camera projection parameters.
     */
    public static lift2DMatchesTo3D(
        matches: FeatureMatch2D[],
        depthBuffer: DepthBuffer3D
    ): FeatureMatch2D3D[] {
        const { width, height, depthMap, cameraMatrixWorld, intrinsics } = depthBuffer;
        const { fx, fy, cx, cy } = intrinsics;

        const results: FeatureMatch2D3D[] = [];

        for (const m of matches) {
            // point2 is in the rendered 3D view
            const u = Math.round(m.point2[0]);
            const v = Math.round(m.point2[1]);

            if (u < 0 || u >= width || v < 0 || v >= height) continue;

            let depth = depthMap[v * width + u];
            if (depth <= 0.1 || !isFinite(depth) || depth > 10000.0) {
                // Keypoints on silhouette corners may land on boundary background pixels;
                // search 2-pixel neighborhood for nearest valid surface depth
                let foundValid = false;
                for (let r = 1; r <= 2 && !foundValid; r++) {
                    for (let dy = -r; dy <= r && !foundValid; dy++) {
                        for (let dx = -r; dx <= r && !foundValid; dx++) {
                            const nu = u + dx;
                            const nv = v + dy;
                            if (nu >= 0 && nu < width && nv >= 0 && nv < height) {
                                const d = depthMap[nv * width + nu];
                                if (d > 0.1 && isFinite(d) && d <= 10000.0) {
                                    depth = d;
                                    foundValid = true;
                                }
                            }
                        }
                    }
                }
                if (!foundValid) continue;
            }

            // 1. Backproject (u, v, depth) to camera space [x_cam, y_cam, z_cam]
            const x_cam = ((u - cx) / fx) * depth;
            const y_cam = ((v - cy) / fy) * depth;
            const z_cam = depth;

            // 2. Transform camera space point to world space using cameraMatrixWorld (4x4)
            // p_world = cameraMatrixWorld * [x_cam, y_cam, z_cam, 1]^T
            const M = cameraMatrixWorld;
            const x_world = M[0][0] * x_cam + M[0][1] * y_cam + M[0][2] * z_cam + M[0][3];
            const y_world = M[1][0] * x_cam + M[1][1] * y_cam + M[1][2] * z_cam + M[1][3];
            const z_world = M[2][0] * x_cam + M[2][1] * y_cam + M[2][2] * z_cam + M[2][3];

            results.push({
                point2D: m.point1, // Photograph 2D coordinate
                point3D: [x_world, y_world, z_world],
                depthMeters: depth,
                confidence: m.confidence
            });
        }

        return results;
    }

    // ========================================================================
    // Internal Feature Representation Helpers
    // ========================================================================

    private static toGrayscale(data: Uint8ClampedArray | Uint8Array | Float32Array, width: number, height: number): Float32Array {
        const size = width * height;
        if (data instanceof Float32Array && data.length === size) {
            return data;
        }
        const gray = new Float32Array(size);

        if (data.length === size) {
            // Already grayscale
            for (let i = 0; i < size; i++) gray[i] = data[i];
            return gray;
        }

        // RGBA input
        for (let i = 0; i < size; i++) {
            const r = data[i * 4];
            const g = data[i * 4 + 1];
            const b = data[i * 4 + 2];
            // Rec. 709 luma coefficients
            gray[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        }

        return gray;
    }

    private static computeSobelGradients(
        gray: Float32Array,
        width: number,
        height: number
    ): { Ix: Float32Array; Iy: Float32Array } {
        const Ix = new Float32Array(width * height);
        const Iy = new Float32Array(width * height);

        for (let y = 1; y < height - 1; y++) {
            const rowPrev = (y - 1) * width;
            const rowCurr = y * width;
            const rowNext = (y + 1) * width;

            for (let x = 1; x < width - 1; x++) {
                // Sobel X kernel:
                // [-1  0  1]
                // [-2  0  2]
                // [-1  0  1]
                const gx =
                    -gray[rowPrev + (x - 1)] + gray[rowPrev + (x + 1)] -
                    2 * gray[rowCurr + (x - 1)] + 2 * gray[rowCurr + (x + 1)] -
                    gray[rowNext + (x - 1)] + gray[rowNext + (x + 1)];

                // Sobel Y kernel:
                // [-1 -2 -1]
                // [ 0  0  0]
                // [ 1  2  1]
                const gy =
                    -gray[rowPrev + (x - 1)] - 2 * gray[rowPrev + x] - gray[rowPrev + (x + 1)] +
                    gray[rowNext + (x - 1)] + 2 * gray[rowNext + x] + gray[rowNext + (x + 1)];

                const idx = rowCurr + x;
                Ix[idx] = gx * 0.125;
                Iy[idx] = gy * 0.125;
            }
        }

        return { Ix, Iy };
    }

    /**
     * Extracts a 128-dimensional normalized descriptor around (cx, cy)
     * (4x4 spatial sub-regions, 8 orientation bins each = 128 values).
     */
    private static extractPatchDescriptor(
        Ix: Float32Array,
        Iy: Float32Array,
        width: number,
        height: number,
        cx: number,
        cy: number
    ): Float32Array {
        const desc = new Float32Array(128);
        const patchRadius = 8; // 16x16 patch around keypoint

        for (let dy = -patchRadius; dy < patchRadius; dy++) {
            const y = cy + dy;
            if (y < 0 || y >= height) continue;

            const subY = Math.floor((dy + patchRadius) / 4); // 0..3

            for (let dx = -patchRadius; dx < patchRadius; dx++) {
                const x = cx + dx;
                if (x < 0 || x >= width) continue;

                const subX = Math.floor((dx + patchRadius) / 4); // 0..3
                const subRegionIdx = (subY * 4 + subX) * 8;

                const idx = y * width + x;
                const gx = Ix[idx];
                const gy = Iy[idx];
                const mag = Math.hypot(gx, gy);
                if (mag < 1e-5) continue;

                let angle = Math.atan2(gy, gx); // -PI..PI
                if (angle < 0) angle += 2 * Math.PI;

                // 8 orientation bins [0..7]
                const bin = Math.floor((angle / (2 * Math.PI)) * 8) % 8;
                desc[subRegionIdx + bin] += mag;
            }
        }

        // L2 normalize descriptor
        let sumSq = 0;
        for (let i = 0; i < 128; i++) sumSq += desc[i] * desc[i];
        const norm = Math.sqrt(sumSq);

        if (norm > 1e-6) {
            for (let i = 0; i < 128; i++) {
                // Clamp large values to 0.2 to reduce illumination sensitivity (SIFT convention)
                desc[i] = Math.min(0.2, desc[i] / norm);
            }
            // Re-normalize
            let sumSq2 = 0;
            for (let i = 0; i < 128; i++) sumSq2 += desc[i] * desc[i];
            const norm2 = Math.sqrt(sumSq2);
            if (norm2 > 1e-6) {
                for (let i = 0; i < 128; i++) desc[i] /= norm2;
            }
        }

        return desc;
    }

    private static euclideanDistance(a: Float32Array, b: Float32Array): number {
        let sum = 0;
        const len = a.length;
        for (let i = 0; i < len; i++) {
            const d = a[i] - b[i];
            sum += d * d;
        }
        return Math.sqrt(sum);
    }
}
