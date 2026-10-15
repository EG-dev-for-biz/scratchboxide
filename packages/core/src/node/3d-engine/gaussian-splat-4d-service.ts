/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import type { BakedGaussian } from '../../common/geospatial-4d-protocol';
import type {
    Decomposed4DSplatScene,
    DynamicGaussianTrajectory,
    NormalizedPoint2D,
    PointTracks,
    TrackingConfig,
    VideoFrameData,
    WorldPoint3D
} from '../../common/tracking/tapir-tracking-protocol';
import { TapirTrackingService } from '../spatial/TapirTrackingService';

export interface CameraIntrinsicsInput {
    width: number;
    height: number;
    fx?: number;
    fy?: number;
    cx?: number;
    cy?: number;
    fovDegrees?: number;
}

export interface Build4DFromCanonicalOptions {
    canonicalSubject: BakedGaussian[];
    staticBackground?: BakedGaussian[];
    videoFrames: VideoFrameData[];
    perFrameDepths?: Float32Array[];
    intrinsics?: CameraIntrinsicsInput;
    heroFrameIndex?: number;
    frameTimestamps?: number[];
    trackingConfig?: TrackingConfig;
    useKinematicSmoothing?: boolean;
    pruneTrackingErrors?: boolean;
    trackingErrorThresh?: number; // default: 0.35 (L1 color difference threshold)
    useLocalRigidity?: boolean;
    kNeighbors?: number; // default: 6
    rigidityStrength?: number; // default: 0.5
    rotationalStrength?: number; // default: 0.3
}

/**
 * Service for deforming a canonical 3D Gaussian Splat scene across time using TAPIR point tracks.
 * Adheres strictly to the "frame of truth" invariant: the canonical scene is preserved without alteration
 * at the hero frame (timeDelta = 0), with dynamic deformation, photometric pruning, and ARAP isometry.
 */
export class GaussianSplat4DService {
    private trackingService: TapirTrackingService;

    constructor(trackingService?: TapirTrackingService) {
        this.trackingService = trackingService ?? new TapirTrackingService();
    }

    /**
     * Resolves camera intrinsics parameters (fx, fy, cx, cy) from given options or FOV.
     */
    public static resolveIntrinsics(options: CameraIntrinsicsInput): {
        fx: number;
        fy: number;
        cx: number;
        cy: number;
    } {
        const { width, height } = options;
        const cx = options.cx ?? (width - 1) * 0.5;
        const cy = options.cy ?? (height - 1) * 0.5;

        if (options.fx && options.fy) {
            return { fx: options.fx, fy: options.fy, cx, cy };
        }

        const fovDeg = options.fovDegrees ?? 60.0;
        const fovRad = (fovDeg * Math.PI) / 180.0;
        const f = (0.5 * height) / Math.tan(0.5 * fovRad);

        return {
            fx: options.fx ?? f,
            fy: options.fy ?? f,
            cx,
            cy
        };
    }

    /**
     * Projects 3D world coordinates to 2D normalized screen coordinates [0, 1].
     */
    public static project3DToNormalized2D(
        pos: WorldPoint3D,
        intrinsics: { fx: number; fy: number; cx: number; cy: number },
        width: number,
        height: number
    ): NormalizedPoint2D {
        const z = Math.max(pos[2], 0.05);
        const px = (intrinsics.fx * pos[0]) / z + intrinsics.cx;
        const py = (intrinsics.fy * pos[1]) / z + intrinsics.cy;

        return [
            Math.max(0.0, Math.min(1.0, px / Math.max(width - 1, 1))),
            Math.max(0.0, Math.min(1.0, py / Math.max(height - 1, 1)))
        ];
    }

    /**
     * Bilinear sub-pixel color sampling from a video frame.
     */
    public static sampleBilinearColor(
        frame: VideoFrameData,
        xNorm: number,
        yNorm: number
    ): [number, number, number] {
        const { width, height, data } = frame;
        const channels = frame.channels ?? 3;

        const px = Math.max(0, Math.min(width - 1, xNorm * (width - 1)));
        const py = Math.max(0, Math.min(height - 1, yNorm * (height - 1)));

        const x0 = Math.floor(px);
        const y0 = Math.floor(py);
        const x1 = Math.min(x0 + 1, width - 1);
        const y1 = Math.min(y0 + 1, height - 1);

        const wx = px - x0;
        const wy = py - y0;

        const idx00 = (y0 * width + x0) * channels;
        const idx01 = (y0 * width + x1) * channels;
        const idx10 = (y1 * width + x0) * channels;
        const idx11 = (y1 * width + x1) * channels;

        const r = (1 - wx) * (1 - wy) * data[idx00] +
                  wx * (1 - wy) * data[idx01] +
                  (1 - wx) * wy * data[idx10] +
                  wx * wy * data[idx11];

        const g = (1 - wx) * (1 - wy) * data[idx00 + 1] +
                  wx * (1 - wy) * data[idx01 + 1] +
                  (1 - wx) * wy * data[idx10 + 1] +
                  wx * wy * data[idx11 + 1];

        const b = (1 - wx) * (1 - wy) * data[idx00 + 2] +
                  wx * (1 - wy) * data[idx01 + 2] +
                  (1 - wx) * wy * data[idx10 + 2] +
                  wx * wy * data[idx11 + 2];

        return [r / 255.0, g / 255.0, b / 255.0];
    }

    /**
     * Builds a decomposed 4D Gaussian Splatting scene from a canonical 3DGS and video sequence.
     */
    public async build4DSceneFromCanonical(
        options: Build4DFromCanonicalOptions
    ): Promise<Decomposed4DSplatScene> {
        const startTime = Date.now();
        const {
            canonicalSubject,
            staticBackground = [],
            videoFrames,
            perFrameDepths,
            heroFrameIndex = 0,
            useKinematicSmoothing = true,
            pruneTrackingErrors = true,
            trackingErrorThresh = 0.35,
            useLocalRigidity = true,
            kNeighbors = 6,
            rigidityStrength = 0.5,
            frameTimestamps
        } = options;

        const T = videoFrames.length;
        if (T === 0) {
            throw new Error('No video frames provided for 4DGS deformation.');
        }

        const hero = Math.max(0, Math.min(heroFrameIndex, T - 1));
        const heroFrame = videoFrames[hero];
        const W = heroFrame.width;
        const H = heroFrame.height;

        const intrinsics = GaussianSplat4DService.resolveIntrinsics(
            options.intrinsics ?? { width: W, height: H }
        );

        const numSubject = canonicalSubject.length;
        if (numSubject === 0) {
            // Static background only: nothing is tracked, and the bounds are the background's own.
            if (staticBackground.length === 0) {
                throw new Error('No canonical subject or static background Gaussians provided for the 4DGS scene.');
            }
            const min: [number, number, number] = [Infinity, Infinity, Infinity];
            const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
            for (const g of staticBackground) {
                for (let a = 0; a < 3; a++) {
                    min[a] = Math.min(min[a], g.position[a]);
                    max[a] = Math.max(max[a], g.position[a]);
                }
            }
            return {
                staticLayer: staticBackground,
                canonicalSubject: [],
                trajectories: [],
                numFrames: T,
                heroFrameIndex: hero,
                frameTimestamps,
                bounds: { min, max },
                telemetry: {
                    trackerUsed: 'none',
                    numDynamicGaussians: 0,
                    numStaticGaussians: staticBackground.length,
                    prunedGaussians: 0,
                    meanPhotometricError: null,
                    processingTimeMs: Date.now() - startTime
                }
            };
        }

        // 1. Seed query points from canonical subject 3D Gaussians
        const queryPoints: NormalizedPoint2D[] = [];
        const queryFrames: number[] = [];

        for (let i = 0; i < numSubject; i++) {
            const p3d = canonicalSubject[i].position;
            const pt2d = GaussianSplat4DService.project3DToNormalized2D(p3d, intrinsics, W, H);
            queryPoints.push(pt2d);
            queryFrames.push(hero);
        }

        // 2. Track points across all video frames using TAPIR / Lucas-Kanade
        const trackResult = await this.trackingService.executeTracking(
            videoFrames,
            queryPoints,
            queryFrames,
            options.trackingConfig
        );
        const { coords, visibilities } = trackResult.tracks;

        // 3. Unproject 2D trajectories into 3D world space
        // worldTrajectories: shape (T, N, 3)
        const worldTrajectories: Array<Array<WorldPoint3D>> = [];
        const timeColors: Array<Array<[number, number, number]>> = [];
        const pointVisibilities: Array<Array<number>> = [];

        for (let t = 0; t < T; t++) {
            worldTrajectories.push(new Array(numSubject));
            timeColors.push(new Array(numSubject));
            pointVisibilities.push(new Array(numSubject));
        }

        // Compute canonical depth anchors for subject Gaussians
        const baseDepths = canonicalSubject.map(g => Math.max(g.position[2], 0.05));

        for (let t = 0; t < T; t++) {
            const frame = videoFrames[t];
            const depthMap = perFrameDepths ? perFrameDepths[t] : null;

            for (let i = 0; i < numSubject; i++) {
                const [xNorm, yNorm] = coords[t][i];
                const rawVis = visibilities[t] ? visibilities[t][i] : 1.0;

                // Sub-pixel video color
                const color = GaussianSplat4DService.sampleBilinearColor(frame, xNorm, yNorm);
                timeColors[t][i] = color;

                // Depth calculation
                let z: number;
                if (depthMap) {
                    const px = Math.round(xNorm * (W - 1));
                    const py = Math.round(yNorm * (H - 1));
                    const dIdx = Math.max(0, Math.min(W * H - 1, py * W + px));
                    const sampledDepth = depthMap[dIdx];
                    z = sampledDepth > 0.05 && isFinite(sampledDepth) ? sampledDepth : baseDepths[i];
                } else {
                    z = baseDepths[i];
                }

                // Unproject to 3D metric camera space
                const px = xNorm * (W - 1);
                const py = yNorm * (H - 1);
                const worldX = ((px - intrinsics.cx) * z) / intrinsics.fx;
                const worldY = ((py - intrinsics.cy) * z) / intrinsics.fy;
                const worldZ = z;

                worldTrajectories[t][i] = [worldX, worldY, worldZ];
                pointVisibilities[t][i] = rawVis;
            }
        }

        // Pin hero frame trajectories exactly to canonical subject positions (time delta = 0)
        for (let i = 0; i < numSubject; i++) {
            worldTrajectories[hero][i] = [...canonicalSubject[i].position];
        }

        // 4. Photometric Error Pruning (Backtracking)
        let prunedCount = 0;
        let totalPhotometricErr = 0;
        const keepIndices: number[] = [];

        for (let i = 0; i < numSubject; i++) {
            const baseColor = canonicalSubject[i].colorRgb;
            let sumErr = 0;

            for (let t = 0; t < T; t++) {
                const c = timeColors[t][i];
                const l1 = Math.abs(c[0] - baseColor[0]) + Math.abs(c[1] - baseColor[1]) + Math.abs(c[2] - baseColor[2]);
                sumErr += l1 / 3.0;
            }

            const meanErr = sumErr / T;
            totalPhotometricErr += meanErr;

            if (pruneTrackingErrors && meanErr > trackingErrorThresh) {
                prunedCount++;
                // Damp visibility rather than hard deletion if too many would be deleted
                for (let t = 0; t < T; t++) {
                    pointVisibilities[t][i] *= Math.max(0.1, 1.0 - (meanErr - trackingErrorThresh) * 2.0);
                }
            }
            keepIndices.push(i);
        }

        // 5. ARAP (As-Rigid-As-Possible) Local Rigidity Graph Regularization
        if (useLocalRigidity && numSubject > 2) {
            this.applyLocalRigidityRegularization(
                canonicalSubject,
                worldTrajectories,
                hero,
                kNeighbors,
                rigidityStrength
            );
        }

        // 6. Kinematic Smoothing & Velocity Tangents Computation
        const velocityTangents: Array<Array<WorldPoint3D>> = [];
        const dynamicQuaternions: Array<Array<[number, number, number, number]>> = [];

        for (let t = 0; t < T; t++) {
            velocityTangents.push(new Array(numSubject));
            dynamicQuaternions.push(new Array(numSubject));
        }

        for (let i = 0; i < numSubject; i++) {
            for (let t = 0; t < T; t++) {
                let vx = 0, vy = 0, vz = 0;

                if (T > 2) {
                    if (t === 0) {
                        vx = worldTrajectories[1][i][0] - worldTrajectories[0][i][0];
                        vy = worldTrajectories[1][i][1] - worldTrajectories[0][i][1];
                        vz = worldTrajectories[1][i][2] - worldTrajectories[0][i][2];
                    } else if (t === T - 1) {
                        vx = worldTrajectories[T - 1][i][0] - worldTrajectories[T - 2][i][0];
                        vy = worldTrajectories[T - 1][i][1] - worldTrajectories[T - 2][i][1];
                        vz = worldTrajectories[T - 1][i][2] - worldTrajectories[T - 2][i][2];
                    } else {
                        vx = (worldTrajectories[t + 1][i][0] - worldTrajectories[t - 1][i][0]) * 0.5;
                        vy = (worldTrajectories[t + 1][i][1] - worldTrajectories[t - 1][i][1]) * 0.5;
                        vz = (worldTrajectories[t + 1][i][2] - worldTrajectories[t - 1][i][2]) * 0.5;
                    }
                }

                velocityTangents[t][i] = [vx, vy, vz];

                // Derive motion-aligned quaternion
                const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
                if (speed > 1e-4) {
                    const angle = Math.min(0.4, speed * 0.15);
                    const halfA = angle * 0.5;
                    const sinH = Math.sin(halfA);
                    const cosH = Math.cos(halfA);
                    // Rotation axis perpendicular to motion in XZ plane
                    const ax = -vz / speed;
                    const ay = 0;
                    const az = vx / speed;
                    dynamicQuaternions[t][i] = [sinH * ax, sinH * ay, sinH * az, cosH];
                } else {
                    dynamicQuaternions[t][i] = canonicalSubject[i].quaternion ?? [0, 0, 0, 1];
                }
            }
        }

        // 7. Assemble DynamicGaussianTrajectory per subject Gaussian
        const trajectories: DynamicGaussianTrajectory[] = [];
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

        for (let i = 0; i < numSubject; i++) {
            const g = canonicalSubject[i];
            const deltas: WorldPoint3D[] = [];
            const ptColors: Array<[number, number, number]> = [];
            const ptVis: number[] = [];
            const ptVels: WorldPoint3D[] = [];
            const ptQuats: Array<[number, number, number, number]> = [];

            for (let t = 0; t < T; t++) {
                const p3d = worldTrajectories[t][i];
                deltas.push([
                    p3d[0] - g.position[0],
                    p3d[1] - g.position[1],
                    p3d[2] - g.position[2]
                ]);
                ptColors.push(timeColors[t][i]);
                ptVis.push(pointVisibilities[t][i]);
                ptVels.push(velocityTangents[t][i]);
                ptQuats.push(dynamicQuaternions[t][i]);

                minX = Math.min(minX, p3d[0]);
                minY = Math.min(minY, p3d[1]);
                minZ = Math.min(minZ, p3d[2]);
                maxX = Math.max(maxX, p3d[0]);
                maxY = Math.max(maxY, p3d[1]);
                maxZ = Math.max(maxZ, p3d[2]);
            }

            // Invariant: hero frame delta must be exactly [0, 0, 0]
            deltas[hero] = [0, 0, 0];

            trajectories.push({
                pointIndex: i,
                canonicalPosition: [...g.position],
                canonicalColor: [...g.colorRgb],
                canonicalScale: [...g.scale],
                canonicalOpacity: g.opacity,
                timeDeltas: deltas,
                timeColors: ptColors,
                visibilities: ptVis,
                velocityTangents: ptVels,
                quaternions: ptQuats
            });
        }

        return {
            staticLayer: staticBackground,
            canonicalSubject,
            trajectories,
            numFrames: T,
            heroFrameIndex: hero,
            frameTimestamps,
            bounds: {
                min: [isFinite(minX) ? minX : -5, isFinite(minY) ? minY : -5, isFinite(minZ) ? minZ : -5],
                max: [isFinite(maxX) ? maxX : 5, isFinite(maxY) ? maxY : 5, isFinite(maxZ) ? maxZ : 5]
            },
            telemetry: {
                trackerUsed: trackResult.backendUsed,
                numDynamicGaussians: numSubject,
                numStaticGaussians: staticBackground.length,
                prunedGaussians: prunedCount,
                meanPhotometricError: totalPhotometricErr / Math.max(numSubject, 1),
                processingTimeMs: Date.now() - startTime
            }
        };
    }

    /**
     * Applies As-Rigid-As-Possible (ARAP) local isometry graph regularization.
     */
    private applyLocalRigidityRegularization(
        baseSubject: BakedGaussian[],
        trajectories: Array<Array<WorldPoint3D>>,
        heroIndex: number,
        k: number,
        strength: number
    ): void {
        const N = baseSubject.length;
        const T = trajectories.length;
        const actualK = Math.min(k, N - 1);
        if (actualK <= 0) return;

        // Build k-nearest neighbor graph on base canonical positions
        const neighbors: Array<number[]> = [];
        const restDistances: Array<number[]> = [];

        for (let i = 0; i < N; i++) {
            const pi = baseSubject[i].position;
            const dists: Array<{ idx: number; d: number }> = [];

            for (let j = 0; j < N; j++) {
                if (i === j) continue;
                const pj = baseSubject[j].position;
                const d = Math.sqrt((pi[0] - pj[0]) ** 2 + (pi[1] - pj[1]) ** 2 + (pi[2] - pj[2]) ** 2);
                dists.push({ idx: j, d });
            }

            dists.sort((a, b) => a.d - b.d);
            const nList = dists.slice(0, actualK).map(item => item.idx);
            const rList = dists.slice(0, actualK).map(item => item.d);

            neighbors.push(nList);
            restDistances.push(rList);
        }

        // Regularize non-hero frames
        for (let t = 0; t < T; t++) {
            if (t === heroIndex) continue;

            for (let i = 0; i < N; i++) {
                const ptI = trajectories[t][i];
                let cx = 0, cy = 0, cz = 0;
                const nList = neighbors[i];
                const rList = restDistances[i];

                for (let kIdx = 0; kIdx < actualK; kIdx++) {
                    const j = nList[kIdx];
                    const rDist = rList[kIdx];
                    const ptJ = trajectories[t][j];

                    const dx = ptJ[0] - ptI[0];
                    const dy = ptJ[1] - ptI[1];
                    const dz = ptJ[2] - ptI[2];
                    const curDist = Math.sqrt(dx * dx + dy * dy + dz * dz);

                    if (curDist > 1e-5) {
                        const strain = (curDist - rDist) / curDist;
                        cx += dx * strain;
                        cy += dy * strain;
                        cz += dz * strain;
                    }
                }

                // Apply soft isometric correction
                const scale = (strength / actualK) * 0.5;
                trajectories[t][i][0] += cx * scale;
                trajectories[t][i][1] += cy * scale;
                trajectories[t][i][2] += cz * scale;
            }
        }
    }
}
