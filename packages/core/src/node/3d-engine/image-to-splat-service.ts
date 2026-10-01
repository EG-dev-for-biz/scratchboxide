/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { SplatService, SplatPoint } from './splat-service';
import type { SceneDepthAnnotation } from '../../common/scene-depth-protocol';

export interface CameraIntrinsics {
    width: number;
    height: number;
    fovDegrees?: number;
    fx?: number;
    fy?: number;
    cx?: number;
    cy?: number;
}

export interface CameraPose3D {
    position?: [number, number, number];
    // Quaternion [x, y, z, w] representing camera orientation in world space
    rotation?: [number, number, number, number];
}

export interface SingleImageConversionOptions {
    rgbPixels: Uint8Array | Buffer;
    width: number;
    height: number;
    channels?: number; // 3 = RGB, 4 = RGBA
    metricDepths?: Float32Array | number[];
    sceneDepthAnnotation?: SceneDepthAnnotation;
    fovDegrees?: number;
    stride?: number;
    edgeTau?: number;
    minDepth?: number;
    maxDepth?: number;
    splatScaleMultiplier?: number;
    splatThicknessRatio?: number;
    pose?: CameraPose3D;
}

export interface BoxCollider3D {
    name: string;
    center: [number, number, number];
    extents: [number, number, number]; // half-widths along x, y, z
}

export interface PhysicsColliderMesh {
    groundElevation: number;
    positions: Float32Array;
    normals: Float32Array;
    indices: Uint32Array;
    boundingBoxes: BoxCollider3D[];
}

export type AtmospherePreset = 'noon' | 'golden' | 'sunset' | 'midnight';

export interface AtmosphereEnvironment {
    preset: AtmospherePreset;
    sunDirection: [number, number, number];
    sunColor: [number, number, number];
    sunIntensity: number;
    skyAmbient: [number, number, number];
    groundAmbient: [number, number, number];
    fogColor: [number, number, number];
    fogDensity: number;
}

export interface MultiViewImageInput {
    rgbPixels: Uint8Array | Buffer;
    width: number;
    height: number;
    channels?: number;
    metricDepths?: Float32Array | number[];
    fovDegrees?: number;
    pose?: CameraPose3D;
}

export interface MultiViewConversionOptions {
    views: MultiViewImageInput[];
    voxelSize?: number;
    densifyMaxScale?: number;
    stride?: number;
    edgeTau?: number;
    minDepth?: number;
    maxDepth?: number;
}

export type VideoTrajectoryType = 'orbit' | 'dolly' | 'pan' | 'solve';

export interface VideoKeyframeInput {
    frameIndex: number;
    timestampSeconds?: number;
    rgbPixels: Uint8Array | Buffer;
    width: number;
    height: number;
    channels?: number;
    metricDepths?: Float32Array | number[];
    fovDegrees?: number;
    pose?: CameraPose3D;
}

export interface VideoKeyframeConversionOptions {
    keyframes: VideoKeyframeInput[];
    trajectoryType?: VideoTrajectoryType;
    orbitRadius?: number;
    orbitSweepDegrees?: number;
    dollyDistance?: number;
    panDistance?: number;
    voxelSize?: number;
    densifyMaxScale?: number;
    stride?: number;
    edgeTau?: number;
    minDepth?: number;
    maxDepth?: number;
}

export interface PublicSourceItem {
    id: string;
    title: string;
    subtitle: string;
    type: 'single_image' | 'image_group' | 'video';
    path?: string;
    paths?: string[];
    thumbnailUrl?: string;
    frameCount?: number;
    suggestedTrajectory?: VideoTrajectoryType;
    suggestedFov?: number;
    nearDepth?: number;
    farDepth?: number;
}

export interface PublicSourceCatalog {
    singleImages: PublicSourceItem[];
    imageGroups: PublicSourceItem[];
    videos: PublicSourceItem[];
}

export interface EquirectangularConversionOptions {
    rgbPixels: Uint8Array | Buffer;
    width: number;
    height: number;
    channels?: number;
    metricDepths?: Float32Array | number[];
    stride?: number;
    eyeHeight?: number;
    maxRadius?: number;
}

export interface SpatialMeasurementResult {
    meters: number;
    feet: number;
    deltaX: number;
    deltaY: number;
    deltaZ: number;
}


export class ImageToSplatService {
    /**
     * Computes unit pinhole ray field for an image given resolution and field of view.
     */
    static computePinholeRayField(width: number, height: number, fovDegrees = 65.0): Float32Array {
        const rayMap = new Float32Array(width * height * 3);
        const fovRad = (fovDegrees * Math.PI) / 180.0;
        const f = 0.5 * height / Math.tan(0.5 * fovRad);
        const cx = width * 0.5;
        const cy = height * 0.5;

        for (let y = 0; y < height; ++y) {
            for (let x = 0; x < width; ++x) {
                const idx = (y * width + x) * 3;
                const rx = (x - cx) / f;
                const ry = -(y - cy) / f; // Invert y for standard 3D camera coordinates (+Y up)
                const rz = -1.0;          // Looking down -Z axis
                const invLen = 1.0 / Math.hypot(rx, ry, rz);

                rayMap[idx + 0] = rx * invLen;
                rayMap[idx + 1] = ry * invLen;
                rayMap[idx + 2] = rz * invLen;
            }
        }
        return rayMap;
    }

    /**
     * Synthesizes a plausible metric depth map from RGB luminance and vertical perspective priors
     * when a pre-inferred DepthBox depth map is not directly supplied.
     */
    static synthesizeMetricDepthsFromLuminance(
        rgbPixels: Uint8Array | Buffer,
        width: number,
        height: number,
        channels = 3,
        nearDepth = 1.5,
        farDepth = 60.0
    ): Float32Array {
        const depths = new Float32Array(width * height);

        for (let y = 0; y < height; ++y) {
            const ny = y / height;
            for (let x = 0; x < width; ++x) {
                const idx = y * width + x;
                const cIdx = idx * channels;
                const r = rgbPixels[cIdx + 0] / 255.0;
                const g = rgbPixels[cIdx + 1] / 255.0;
                const b = rgbPixels[cIdx + 2] / 255.0;
                const lum = 0.299 * r + 0.587 * g + 0.114 * b;

                let d: number;
                if (ny >= 0.70) {
                    // Ground plane receding towards horizon
                    const t = (ny - 0.70) / 0.30;
                    d = nearDepth + (1.0 - t) * (nearDepth * 4.0);
                } else if (ny >= 0.35) {
                    // Midground architectural/terrain structures
                    const t = (0.70 - ny) / 0.35;
                    d = nearDepth * 4.0 + t * (farDepth * 0.45);
                    // Dark recesses indicate deeper depth
                    if (lum < 0.25) d += 1.5;
                } else {
                    // Sky or distant mountains
                    const isSky = (b > r + 0.12 && b > 0.45) || lum > 0.82;
                    if (isSky) {
                        d = farDepth * 1.5;
                    } else {
                        const t = (0.35 - ny) / 0.35;
                        d = farDepth * 0.45 + t * (farDepth * 0.55);
                    }
                }

                depths[idx] = Math.max(0.1, d);
            }
        }

        return depths;
    }

    /**
     * Synthesizes a continuous metric depth buffer from Gemini multimodal scene depth parts.
     */
    static synthesizeMetricDepthsFromSceneDepth(
        annotation: SceneDepthAnnotation,
        width: number,
        height: number,
        nearDepth = 1.0,
        farDepth = 25.0
    ): Float32Array {
        const depths = new Float32Array(width * height);
        const partsList = Object.values(annotation.parts || {});
        const horizonY = 0.5;

        const partDistances = partsList.map(p => ({
            u: p.imageX,
            v: p.imageY,
            dist: Math.max(nearDepth, Math.min(farDepth, 5.0 - p.z)),
            radius: Math.max(p.width ?? 0.15, p.height ?? 0.15, 0.1)
        }));

        for (let y = 0; y < height; y++) {
            const v = (y + 0.5) / height;
            let baseDist: number;
            if (v >= horizonY) {
                const groundT = (v - horizonY) / Math.max(1.0 - horizonY, 0.001);
                baseDist = nearDepth + (farDepth * 0.4 - nearDepth) * Math.pow(1.0 - groundT, 1.8);
            } else {
                const skyT = v / Math.max(horizonY, 0.001);
                baseDist = farDepth * 0.6 + (farDepth - farDepth * 0.6) * (1.0 - skyT);
            }

            for (let x = 0; x < width; x++) {
                const u = (x + 0.5) / width;
                const idx = y * width + x;

                if (partDistances.length === 0) {
                    depths[idx] = baseDist;
                    continue;
                }

                let weightSum = 0;
                let weightedDistSum = 0;

                for (const p of partDistances) {
                    const du = u - p.u;
                    const dv = v - p.v;
                    const distSq = du * du + dv * dv;
                    const rSq = p.radius * p.radius;
                    const weight = Math.exp(-distSq / (2.0 * rSq));
                    if (weight > 1e-4) {
                        weightSum += weight;
                        weightedDistSum += weight * p.dist;
                    }
                }

                if (weightSum > 1e-4) {
                    const partBlend = weightedDistSum / weightSum;
                    const alpha = Math.min(weightSum, 1.0);
                    depths[idx] = Math.max(nearDepth, Math.min(farDepth, partBlend * alpha + baseDist * (1.0 - alpha)));
                } else {
                    depths[idx] = Math.max(nearDepth, Math.min(farDepth, baseDist));
                }
            }
        }

        return depths;
    }

    /**
     * Converts a single 2D image into an array of 3D Gaussian Splats.
     */
    static convertSingleImageToSplat(options: SingleImageConversionOptions): SplatPoint[] {
        const {
            rgbPixels,
            width: W,
            height: H,
            channels = 3,
            fovDegrees = 65.0,
            stride = 1,
            edgeTau = 0.08,
            minDepth = 0.2,
            maxDepth = 200.0,
            splatScaleMultiplier = 2.10,
            splatThicknessRatio = 0.22,
            pose
        } = options;

        const metricDepths = options.metricDepths || (options.sceneDepthAnnotation
            ? ImageToSplatService.synthesizeMetricDepthsFromSceneDepth(options.sceneDepthAnnotation, W, H, minDepth, maxDepth)
            : ImageToSplatService.synthesizeMetricDepthsFromLuminance(rgbPixels, W, H, channels, minDepth, maxDepth));
        const rayMap = ImageToSplatService.computePinholeRayField(W, H, fovDegrees);
        const fovRad = (fovDegrees * Math.PI) / 180.0;
        const f = 0.5 * H / Math.tan(0.5 * fovRad);

        const splats: SplatPoint[] = [];
        const step = Math.max(1, stride);

        // Precompute camera pose rotation helpers
        const posW: [number, number, number] = pose?.position ?? [0, 0, 0];
        const rotW: [number, number, number, number] = pose?.rotation ?? [0, 0, 0, 1];

        for (let y = 0; y < H; y += step) {
            for (let x = 0; x < W; x += step) {
                const idx = y * W + x;
                const d = metricDepths[idx];
                if (d < minDepth || d > maxDepth || isNaN(d)) continue;

                const rx = rayMap[idx * 3 + 0];
                const ry = rayMap[idx * 3 + 1];
                const rz = rayMap[idx * 3 + 2];

                // Local position
                let px = d * rx;
                let py = d * ry;
                let pz = d * rz;

                // Color extraction
                const cIdx = idx * channels;
                const r = rgbPixels[cIdx + 0] / 255.0;
                const g = rgbPixels[cIdx + 1] / 255.0;
                const b = rgbPixels[cIdx + 2] / 255.0;
                let alpha = channels >= 4 ? rgbPixels[cIdx + 3] / 255.0 : 0.98;
                if (alpha < 0.05) continue;

                // 4-connected spatial neighbor sampling for surface normal estimation
                const xNext = Math.min(W - 1, x + step);
                const xPrev = Math.max(0, x - step);
                const yNext = Math.min(H - 1, y + step);
                const yPrev = Math.max(0, y - step);

                const dRight = metricDepths[y * W + xNext];
                const dLeft = metricDepths[y * W + xPrev];
                const dDown = metricDepths[yNext * W + x];
                const dUp = metricDepths[yPrev * W + x];

                // Relative depth step check for edge severance
                const deltaX = Math.abs(dRight - dLeft) / Math.max(1e-4, Math.max(dRight, dLeft));
                const deltaY = Math.abs(dDown - dUp) / Math.max(1e-4, Math.max(dDown, dUp));
                const isEdge = deltaX > edgeTau || deltaY > edgeTau;

                // 3D neighbor positions
                const pR: [number, number, number] = [dRight * rayMap[(y * W + xNext) * 3 + 0], dRight * rayMap[(y * W + xNext) * 3 + 1], dRight * rayMap[(y * W + xNext) * 3 + 2]];
                const pL: [number, number, number] = [dLeft * rayMap[(y * W + xPrev) * 3 + 0], dLeft * rayMap[(y * W + xPrev) * 3 + 1], dLeft * rayMap[(y * W + xPrev) * 3 + 2]];
                const pD: [number, number, number] = [dDown * rayMap[(yNext * W + x) * 3 + 0], dDown * rayMap[(yNext * W + x) * 3 + 1], dDown * rayMap[(yNext * W + x) * 3 + 2]];
                const pU: [number, number, number] = [dUp * rayMap[(yPrev * W + x) * 3 + 0], dUp * rayMap[(yPrev * W + x) * 3 + 1], dUp * rayMap[(yPrev * W + x) * 3 + 2]];

                const tx = [pR[0] - pL[0], pR[1] - pL[1], pR[2] - pL[2]];
                const ty = [pD[0] - pU[0], pD[1] - pU[1], pD[2] - pU[2]];

                // Cross product for analytical surface normal: N = tx x ty
                let nx = tx[1] * ty[2] - tx[2] * ty[1];
                let ny = tx[2] * ty[0] - tx[0] * ty[2];
                let nz = tx[0] * ty[1] - tx[1] * ty[0];
                const nLen = Math.hypot(nx, ny, nz);

                if (nLen > 1e-6) {
                    nx /= nLen;
                    ny /= nLen;
                    nz /= nLen;
                } else {
                    nx = -rx;
                    ny = -ry;
                    nz = -rz;
                }

                // Inward camera-facing alignment: dot(n, ray) < 0
                if (nx * rx + ny * ry + nz * rz > 0) {
                    nx = -nx;
                    ny = -ny;
                    nz = -nz;
                }

                // Orientation quaternion from (0, 0, 1) to normal vector
                let qLocal = ImageToSplatService.quaternionFromUnitVectors([0, 0, 1], [nx, ny, nz]);

                // Anisotropic scale calculation
                const pixelFootprint = (step * d / f) * splatScaleMultiplier;
                let sx = pixelFootprint;
                let sy = pixelFootprint;
                let sz = pixelFootprint * splatThicknessRatio;

                // Sever edges to eliminate stretching artifacts
                if (isEdge) {
                    sx *= 0.40;
                    sy *= 0.40;
                    alpha *= 0.85;
                }

                // Transform to world coordinates if camera pose is provided
                if (pose) {
                    const pw = ImageToSplatService.transformPointByPose([px, py, pz], posW, rotW);
                    px = pw[0];
                    py = pw[1];
                    pz = pw[2];
                    qLocal = ImageToSplatService.multiplyQuaternions(rotW, qLocal);
                }

                splats.push({
                    position: [px, py, pz],
                    scale: [sx, sy, sz],
                    colorRgb: [r, g, b],
                    opacity: alpha,
                    quaternion: qLocal
                });
            }
        }

        return splats;
    }

    /**
     * Merges multiple 2D views into a single, cohesive 3DGS space with 3D voxel grid decimation.
     */
    static convertMultiViewImagesToSplat(options: MultiViewConversionOptions): SplatPoint[] {
        const {
            views,
            voxelSize = 0.04,
            densifyMaxScale = 0,
            stride = 1,
            edgeTau = 0.08,
            minDepth = 0.2,
            maxDepth = 200.0
        } = options;

        if (!views || views.length === 0) return [];

        const allViewSplats: SplatPoint[][] = [];

        for (const view of views) {
            const splats = ImageToSplatService.convertSingleImageToSplat({
                rgbPixels: view.rgbPixels,
                width: view.width,
                height: view.height,
                channels: view.channels ?? 3,
                metricDepths: view.metricDepths,
                fovDegrees: view.fovDegrees ?? 65.0,
                stride,
                edgeTau,
                minDepth,
                maxDepth,
                pose: view.pose
            });
            allViewSplats.push(splats);
        }

        return SplatService.fuseMultiViewSplats(allViewSplats, { voxelSize, densifyMaxScale });
    }

    /**
     * Converts a sequential group of video keyframes into a unified 3DGS environment
     * by solving or interpolating camera trajectory poses and fusing splats with 3D voxel decimation.
     */
    static convertVideoKeyframesToSplat(options: VideoKeyframeConversionOptions): SplatPoint[] {
        const {
            keyframes,
            trajectoryType = 'orbit',
            orbitRadius = 12.0,
            orbitSweepDegrees = 90.0,
            dollyDistance = 8.0,
            panDistance = 6.0,
            voxelSize = 0.04,
            densifyMaxScale = 0,
            stride = 1,
            edgeTau = 0.08,
            minDepth = 0.2,
            maxDepth = 200.0
        } = options;

        if (!keyframes || keyframes.length === 0) return [];

        const N = keyframes.length;
        const allKeyframeSplats: SplatPoint[][] = [];

        for (let i = 0; i < N; ++i) {
            const kf = keyframes[i];
            let pose = kf.pose;

            // Synthesize trajectory pose if not explicitly specified
            if (!pose) {
                const progress = N > 1 ? i / (N - 1) : 0;
                let px = 0, py = 1.7, pz = 0;
                let qx = 0, qy = 0, qz = 0, qw = 1;

                if (trajectoryType === 'orbit') {
                    // Turntable / Arc orbit around origin
                    const sweepRad = (orbitSweepDegrees * Math.PI) / 180.0;
                    const angle = (progress - 0.5) * sweepRad;
                    px = Math.sin(angle) * orbitRadius;
                    py = 1.7; // Standard observation eye height
                    pz = (Math.cos(angle) - 1.0) * orbitRadius;

                    // Camera yaw pointing inward toward focus
                    const yaw = -angle;
                    qy = Math.sin(yaw * 0.5);
                    qw = Math.cos(yaw * 0.5);
                } else if (trajectoryType === 'dolly') {
                    // Forward dolly in-depth along -Z axis
                    px = 0;
                    py = 1.7;
                    pz = -progress * dollyDistance;
                    qw = 1.0;
                } else if (trajectoryType === 'pan') {
                    // Lateral horizontal pan along X axis
                    px = (progress - 0.5) * panDistance;
                    py = 1.7;
                    pz = 0;
                    qw = 1.0;
                }

                pose = {
                    position: [px, py, pz],
                    rotation: [qx, qy, qz, qw]
                };
            }

            const splats = ImageToSplatService.convertSingleImageToSplat({
                rgbPixels: kf.rgbPixels,
                width: kf.width,
                height: kf.height,
                channels: kf.channels ?? 3,
                metricDepths: kf.metricDepths,
                fovDegrees: kf.fovDegrees ?? 65.0,
                stride,
                edgeTau,
                minDepth,
                maxDepth,
                pose
            });

            allKeyframeSplats.push(splats);
        }

        return SplatService.fuseMultiViewSplats(allKeyframeSplats, { voxelSize, densifyMaxScale });
    }

    /**
     * Enumerates canonical sample sources available in the /public/ directory
     * for instant single-image, multi-view group, and video-to-splat demos.
     */
    static getPublicSourceCatalog(): PublicSourceCatalog {
        return {
            singleImages: [
                {
                    id: 'manhattan_skyline',
                    title: 'Manhattan Skyline',
                    subtitle: 'Midtown Urban Canyons',
                    type: 'single_image',
                    path: 'images/manhattan_ai.png',
                    thumbnailUrl: 'images/manhattan_ai.png',
                    suggestedFov: 65,
                    nearDepth: 3.0,
                    farDepth: 75.0
                },
                {
                    id: 'shibuya_cyber',
                    title: 'Shibuya Cyber Crossing',
                    subtitle: 'Tokyo Holographic Transit',
                    type: 'single_image',
                    path: 'images/shibuya_ai.png',
                    thumbnailUrl: 'images/shibuya_ai.png',
                    suggestedFov: 70,
                    nearDepth: 2.0,
                    farDepth: 60.0
                },
                {
                    id: 'alpine_glacier',
                    title: 'Alpine Glacier Basin',
                    subtitle: 'Swiss Granite Peaks',
                    type: 'single_image',
                    path: 'images/alpine_ai.png',
                    thumbnailUrl: 'images/alpine_ai.png',
                    suggestedFov: 60,
                    nearDepth: 4.0,
                    farDepth: 120.0
                },
                {
                    id: 'dubai_marina',
                    title: 'Dubai Marina',
                    subtitle: 'Glass Towers & Waterfront',
                    type: 'single_image',
                    path: 'images/dubai_ai.png',
                    thumbnailUrl: 'images/dubai_ai.png',
                    suggestedFov: 65,
                    nearDepth: 3.5,
                    farDepth: 90.0
                },
                {
                    id: 'plaza_colonnade',
                    title: 'Plaza Colonnade',
                    subtitle: 'Classical Architecture Facade',
                    type: 'single_image',
                    path: 'images/plaza_hotel_frame_00.png',
                    thumbnailUrl: 'images/plaza_hotel_frame_00.png',
                    suggestedFov: 65,
                    nearDepth: 2.5,
                    farDepth: 45.0
                },
                {
                    id: 'interaction_input_photo',
                    title: 'Drone Survey Photo',
                    subtitle: 'High-Altitude Oblique View',
                    type: 'single_image',
                    path: 'images/interaction_input_image.png',
                    thumbnailUrl: 'images/interaction_input_image.png',
                    suggestedFov: 65,
                    nearDepth: 5.0,
                    farDepth: 150.0
                }
            ],
            imageGroups: [
                {
                    id: 'alpine_orbit_group',
                    title: 'Alpine Glacier Orbit (6 Angles)',
                    subtitle: 'Multi-view sequential mountain orbit',
                    type: 'image_group',
                    paths: [
                        'videos/frames_alpine/frame_0000.jpg',
                        'videos/frames_alpine/frame_0012.jpg',
                        'videos/frames_alpine/frame_0024.jpg',
                        'videos/frames_alpine/frame_0036.jpg',
                        'videos/frames_alpine/frame_0048.jpg',
                        'videos/frames_alpine/frame_0060.jpg'
                    ],
                    thumbnailUrl: 'videos/frames_alpine/frame_0000.jpg',
                    frameCount: 6,
                    suggestedTrajectory: 'orbit',
                    suggestedFov: 60
                },
                {
                    id: 'plaza_colonnade_group',
                    title: 'Plaza Colonnade Multi-Angle (6 Angles)',
                    subtitle: 'Sequential 4K facade inspection keyframes',
                    type: 'image_group',
                    paths: [
                        'images/plaza_blockout_4k_keyframe_01_f1.png',
                        'images/plaza_blockout_4k_keyframe_02_f15.png',
                        'images/plaza_blockout_4k_keyframe_03_f30.png',
                        'images/plaza_blockout_4k_keyframe_04_f45.png',
                        'images/plaza_blockout_4k_keyframe_05_f60.png',
                        'images/plaza_blockout_4k_keyframe_06_f72.png'
                    ],
                    thumbnailUrl: 'images/plaza_blockout_4k_keyframe_01_f1.png',
                    frameCount: 6,
                    suggestedTrajectory: 'pan',
                    suggestedFov: 65
                },
                {
                    id: 'manhattan_skyline_group',
                    title: 'Manhattan Skyline Multi-View (6 Angles)',
                    subtitle: 'Multi-angle aerial skyscraper pass',
                    type: 'image_group',
                    paths: [
                        'images/blockout_4k_keyframe_01_f1.png',
                        'images/blockout_4k_keyframe_02_f15.png',
                        'images/blockout_4k_keyframe_03_f30.png',
                        'images/blockout_4k_keyframe_04_f45.png',
                        'images/blockout_4k_keyframe_05_f60.png',
                        'images/blockout_4k_keyframe_06_f72.png'
                    ],
                    thumbnailUrl: 'images/blockout_4k_keyframe_01_f1.png',
                    frameCount: 6,
                    suggestedTrajectory: 'orbit',
                    suggestedFov: 65
                },
                {
                    id: 'shibuya_transit_group',
                    title: 'Shibuya Crossing Multi-Angle (5 Angles)',
                    subtitle: 'Sequential pedestrian level capture',
                    type: 'image_group',
                    paths: [
                        'videos/frames_shibuya/frame_0000.jpg',
                        'videos/frames_shibuya/frame_0015.jpg',
                        'videos/frames_shibuya/frame_0030.jpg',
                        'videos/frames_shibuya/frame_0045.jpg',
                        'videos/frames_shibuya/frame_0060.jpg'
                    ],
                    thumbnailUrl: 'videos/frames_shibuya/frame_0000.jpg',
                    frameCount: 5,
                    suggestedTrajectory: 'pan',
                    suggestedFov: 70
                }
            ],
            videos: [
                {
                    id: 'drone_survey_video',
                    title: 'Drone Survey Video',
                    subtitle: 'Smooth forward aerial inspection pass',
                    type: 'video',
                    path: 'videos/interaction_input_video.mp4',
                    thumbnailUrl: 'images/interaction_input_video_f0.png',
                    suggestedTrajectory: 'dolly',
                    suggestedFov: 65
                },
                {
                    id: 'alpine_orbit_video',
                    title: 'Alpine Glacial Orbit Video',
                    subtitle: '6-DOF circular camera orbit trajectory',
                    type: 'video',
                    path: 'videos/s4d_alpine_blockout_ref.mp4',
                    thumbnailUrl: 'videos/frames_alpine/frame_0000.jpg',
                    suggestedTrajectory: 'orbit',
                    suggestedFov: 60
                },
                {
                    id: 'manhattan_orbit_video',
                    title: 'Manhattan Skyline Orbit Video',
                    subtitle: 'Aerial building sweep around Midtown',
                    type: 'video',
                    path: 'videos/s4d_manhattan_blockout_ref.mp4',
                    thumbnailUrl: 'images/blockout_4k_keyframe_01_f1.png',
                    suggestedTrajectory: 'orbit',
                    suggestedFov: 65
                },
                {
                    id: 'shibuya_transit_video',
                    title: 'Shibuya Cyber Transit Video',
                    subtitle: 'Dynamic street-level urban camera transit',
                    type: 'video',
                    path: 'videos/s4d_shibuya_blockout_ref.mp4',
                    thumbnailUrl: 'videos/frames_shibuya/frame_0000.jpg',
                    suggestedTrajectory: 'pan',
                    suggestedFov: 70
                },
                {
                    id: 'plaza_colonnade_video',
                    title: 'Plaza Hotel Grand Orbit Video',
                    subtitle: 'Photogrammetric precision camera path',
                    type: 'video',
                    path: 'videos/plaza_hotel_blockout_camera.mp4',
                    thumbnailUrl: 'images/plaza_hotel_frame_00.png',
                    suggestedTrajectory: 'orbit',
                    suggestedFov: 65
                }
            ]
        };
    }

    /**
     * Serializes splats to standard binary .splat buffer.
     */
    static serializeToSplatBuffer(splats: SplatPoint[]): Buffer {
        return SplatService.serializeSplatBuffer(splats as any);
    }

    /**
     * Serializes splats to compressed .spz buffer.
     */
    static serializeToSpzBuffer(splats: SplatPoint[], fractionalBits = 12): Buffer {
        return SplatService.serializeSpzBuffer(splats as any, fractionalBits);
    }

    // --- Helper Math Methods ---

    private static quaternionFromUnitVectors(
        from: [number, number, number],
        to: [number, number, number]
    ): [number, number, number, number] {
        const dot = from[0] * to[0] + from[1] * to[1] + from[2] * to[2];
        if (dot >= 0.999999) return [0, 0, 0, 1];
        if (dot <= -0.999999) {
            let axis: [number, number, number] = [1, 0, 0];
            const crossX = from[1] * axis[2] - from[2] * axis[1];
            const crossY = from[2] * axis[0] - from[0] * axis[2];
            const crossZ = from[0] * axis[1] - from[1] * axis[0];
            if (Math.hypot(crossX, crossY, crossZ) < 0.01) {
                axis = [0, 1, 0];
            }
            return [axis[0], axis[1], axis[2], 0];
        }

        const cx = from[1] * to[2] - from[2] * to[1];
        const cy = from[2] * to[0] - from[0] * to[2];
        const cz = from[0] * to[1] - from[1] * to[0];
        const qw = 1.0 + dot;
        const invLen = 1.0 / Math.hypot(cx, cy, cz, qw);

        return [cx * invLen, cy * invLen, cz * invLen, qw * invLen];
    }

    private static transformPointByPose(
        p: [number, number, number],
        pos: [number, number, number],
        q: [number, number, number, number]
    ): [number, number, number] {
        // v' = p + 2.0 * cross(q.xyz, cross(q.xyz, p) + q.w * p)
        const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
        const px = p[0], py = p[1], pz = p[2];

        const uvx = qy * pz - qz * py;
        const uvy = qz * px - qx * pz;
        const uvz = qx * py - qy * px;

        const uuvx = qy * uvz - qz * uvy;
        const uuvy = qz * uvx - qx * uvz;
        const uuvz = qx * uvy - qy * uvx;

        const rx = px + (uvx * qw + uuvx) * 2.0 + pos[0];
        const ry = py + (uvy * qw + uuvy) * 2.0 + pos[1];
        const rz = pz + (uvz * qw + uuvz) * 2.0 + pos[2];

        return [rx, ry, rz];
    }

    private static multiplyQuaternions(
        a: [number, number, number, number],
        b: [number, number, number, number]
    ): [number, number, number, number] {
        const ax = a[0], ay = a[1], az = a[2], aw = a[3];
        const bx = b[0], by = b[1], bz = b[2], bw = b[3];

        return [
            aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw,
            aw * bw - ax * bx - ay * by - az * bz
        ];
    }

    /**
     * Converts a single 2D image into 3D Gaussian Splats with multi-layer occlusion inpainting.
     * Prevents hollow black silhouette voids when orbiting around foreground objects.
     */
    static convertSingleImageWithInpainting(options: SingleImageConversionOptions): SplatPoint[] {
        // 1. Primary foreground and visible surface splats
        const splats = ImageToSplatService.convertSingleImageToSplat(options);

        const {
            rgbPixels,
            width: W,
            height: H,
            channels = 3,
            fovDegrees = 65.0,
            stride = 1,
            edgeTau = 0.08,
            minDepth = 0.2,
            maxDepth = 200.0,
            splatScaleMultiplier = 1.35,
            splatThicknessRatio = 0.22,
            pose
        } = options;

        const metricDepths = options.metricDepths || ImageToSplatService.synthesizeMetricDepthsFromLuminance(rgbPixels, W, H, channels);
        const rayMap = ImageToSplatService.computePinholeRayField(W, H, fovDegrees);
        const fovRad = (fovDegrees * Math.PI) / 180.0;
        const f = 0.5 * H / Math.tan(0.5 * fovRad);
        const step = Math.max(1, stride);

        const posW: [number, number, number] = pose?.position ?? [0, 0, 0];
        const rotW: [number, number, number, number] = pose?.rotation ?? [0, 0, 0, 1];

        // 2. Scan silhouette boundary pixels and synthesize secondary background layer
        const inpaintSplats: SplatPoint[] = [];

        for (let y = 0; y < H; y += step) {
            for (let x = 0; x < W; x += step) {
                const idx = y * W + x;
                const d = metricDepths[idx];
                if (d < minDepth || d > maxDepth || isNaN(d)) continue;

                const xNext = Math.min(W - 1, x + step);
                const xPrev = Math.max(0, x - step);
                const yNext = Math.min(H - 1, y + step);
                const yPrev = Math.max(0, y - step);

                const dRight = metricDepths[y * W + xNext];
                const dLeft  = metricDepths[y * W + xPrev];
                const dDown  = metricDepths[yNext * W + x];
                const dUp    = metricDepths[yPrev * W + x];

                const fgBgRatio = 1.0 + edgeTau * 1.5;
                let bgDepthSum = 0;
                let bgCount = 0;
                let rBgSum = 0, gBgSum = 0, bBgSum = 0;

                const sampleNeighbor = (nx: number, ny: number, nd: number) => {
                    if (!isNaN(nd) && nd > d * fgBgRatio) {
                        bgDepthSum += nd;
                        const nIdx = (ny * W + nx) * channels;
                        rBgSum += rgbPixels[nIdx + 0] / 255.0;
                        gBgSum += rgbPixels[nIdx + 1] / 255.0;
                        bBgSum += rgbPixels[nIdx + 2] / 255.0;
                        bgCount++;
                    }
                };

                sampleNeighbor(xNext, y, dRight);
                sampleNeighbor(xPrev, y, dLeft);
                sampleNeighbor(x, yNext, dDown);
                sampleNeighbor(x, yPrev, dUp);

                if (bgCount > 0) {
                    const avgBgDepth = (bgDepthSum / bgCount) * 1.04;
                    const r = rBgSum / bgCount;
                    const g = gBgSum / bgCount;
                    const b = bBgSum / bgCount;

                    const rx = rayMap[idx * 3 + 0];
                    const ry = rayMap[idx * 3 + 1];
                    const rz = rayMap[idx * 3 + 2];

                    let px = avgBgDepth * rx;
                    let py = avgBgDepth * ry;
                    let pz = avgBgDepth * rz;

                    const normal: [number, number, number] = [-rx, -ry, -rz];
                    const localQuat = ImageToSplatService.quaternionFromUnitVectors([0, 0, 1], normal);

                    const pixelFootprint = (step * avgBgDepth / f) * splatScaleMultiplier * 1.4;
                    const sx = pixelFootprint;
                    const sy = pixelFootprint;
                    const sz = pixelFootprint * splatThicknessRatio;

                    let finalPos: [number, number, number] = [px, py, pz];
                    let finalQuat: [number, number, number, number] = localQuat;

                    if (pose) {
                        finalPos = ImageToSplatService.transformPointByPose(finalPos, posW, rotW);
                        finalQuat = ImageToSplatService.multiplyQuaternions(rotW, localQuat);
                    }

                    inpaintSplats.push({
                        position: finalPos,
                        scale: [sx, sy, sz],
                        quaternion: finalQuat,
                        colorRgb: [r, g, b],
                        opacity: 0.88
                    });
                }
            }
        }

        return splats.concat(inpaintSplats);
    }

    /**
     * Extracts low-poly collision geometry (ground plane + obstacle bounding boxes)
     * matching the spatial bounds of the generated 3D world.
     */
    static extractPhysicsColliders(options: {
        width: number;
        height: number;
        metricDepths: Float32Array | number[];
        fovDegrees?: number;
        pose?: CameraPose3D;
        minDepth?: number;
        maxDepth?: number;
    }): PhysicsColliderMesh {
        const {
            width: W,
            height: H,
            metricDepths,
            fovDegrees = 65.0,
            pose,
            minDepth = 0.5,
            maxDepth = 150.0
        } = options;

        const rayMap = ImageToSplatService.computePinholeRayField(W, H, fovDegrees);
        const posW: [number, number, number] = pose?.position ?? [0, 0, 0];
        const rotW: [number, number, number, number] = pose?.rotation ?? [0, 0, 0, 1];

        // 1. Ground Elevation from bottom 25% of image
        let groundYSum = 0;
        let groundSamples = 0;
        let groundZMin = 1e6, groundZMax = -1e6;
        let groundXMin = 1e6, groundXMax = -1e6;

        for (let y = Math.floor(H * 0.75); y < H; y += 4) {
            for (let x = 0; x < W; x += 4) {
                const idx = y * W + x;
                const d = metricDepths[idx];
                if (isNaN(d) || d < minDepth || d > maxDepth) continue;

                let px = d * rayMap[idx * 3 + 0];
                let py = d * rayMap[idx * 3 + 1];
                let pz = d * rayMap[idx * 3 + 2];

                if (pose) {
                    [px, py, pz] = ImageToSplatService.transformPointByPose([px, py, pz], posW, rotW);
                }

                groundYSum += py;
                groundSamples++;
                groundXMin = Math.min(groundXMin, px);
                groundXMax = Math.max(groundXMax, px);
                groundZMin = Math.min(groundZMin, pz);
                groundZMax = Math.max(groundZMax, pz);
            }
        }

        const groundElevation = groundSamples > 0 ? groundYSum / groundSamples : -1.65;

        const positions: number[] = [];
        const normals: number[] = [];
        const indices: number[] = [];
        const boundingBoxes: BoxCollider3D[] = [];

        // Ground Quad
        const gWidth = Math.max(40.0, (groundXMax - groundXMin) * 1.5);
        const gDepth = Math.max(50.0, Math.abs(groundZMax - groundZMin) * 1.5);
        const gCenterX = (groundXMin + groundXMax) * 0.5;
        const gCenterZ = (groundZMin + groundZMax) * 0.5;

        const baseIdx = positions.length / 3;
        positions.push(
            gCenterX - gWidth * 0.5, groundElevation, gCenterZ - gDepth * 0.5,
            gCenterX + gWidth * 0.5, groundElevation, gCenterZ - gDepth * 0.5,
            gCenterX + gWidth * 0.5, groundElevation, gCenterZ + gDepth * 0.5,
            gCenterX - gWidth * 0.5, groundElevation, gCenterZ + gDepth * 0.5
        );
        for (let i = 0; i < 4; ++i) normals.push(0, 1, 0);

        indices.push(
            baseIdx + 0, baseIdx + 1, baseIdx + 2,
            baseIdx + 0, baseIdx + 2, baseIdx + 3
        );

        // 2. Segment Bounding Boxes for Obstacles
        const segmentBox = (xStart: number, xEnd: number, label: string) => {
            let minX = 1e6, maxX = -1e6;
            let minY = 1e6, maxY = -1e6;
            let minZ = 1e6, maxZ = -1e6;
            let count = 0;

            for (let y = Math.floor(H * 0.15); y < Math.floor(H * 0.85); y += 4) {
                for (let x = xStart; x < xEnd; x += 4) {
                    const idx = y * W + x;
                    const d = metricDepths[idx];
                    if (isNaN(d) || d < minDepth || d > maxDepth * 0.7) continue;

                    let px = d * rayMap[idx * 3 + 0];
                    let py = d * rayMap[idx * 3 + 1];
                    let pz = d * rayMap[idx * 3 + 2];

                    if (pose) {
                        [px, py, pz] = ImageToSplatService.transformPointByPose([px, py, pz], posW, rotW);
                    }

                    minX = Math.min(minX, px);
                    maxX = Math.max(maxX, px);
                    minY = Math.min(minY, py);
                    maxY = Math.max(maxY, py);
                    minZ = Math.min(minZ, pz);
                    maxZ = Math.max(maxZ, pz);
                    count++;
                }
            }

            if (count > 20 && maxX > minX && maxY > minY && maxZ > minZ) {
                const center: [number, number, number] = [
                    (minX + maxX) * 0.5,
                    (minY + maxY) * 0.5,
                    (minZ + maxZ) * 0.5
                ];
                const extents: [number, number, number] = [
                    (maxX - minX) * 0.5,
                    (maxY - minY) * 0.5,
                    (maxZ - minZ) * 0.5
                ];

                boundingBoxes.push({ name: label, center, extents });

                const bIdx = positions.length / 3;
                const c = center;
                const e = extents;

                positions.push(
                    c[0] - e[0], c[1] - e[1], c[2] - e[2],
                    c[0] + e[0], c[1] - e[1], c[2] - e[2],
                    c[0] + e[0], c[1] + e[1], c[2] - e[2],
                    c[0] - e[0], c[1] + e[1], c[2] - e[2],
                    c[0] - e[0], c[1] - e[1], c[2] + e[2],
                    c[0] + e[0], c[1] - e[1], c[2] + e[2],
                    c[0] + e[0], c[1] + e[1], c[2] + e[2],
                    c[0] - e[0], c[1] + e[1], c[2] + e[2]
                );

                for (let i = 0; i < 8; ++i) normals.push(0, 1, 0);

                const faceIndices = [
                    0, 2, 1, 0, 3, 2,
                    4, 5, 6, 4, 6, 7,
                    0, 1, 5, 0, 5, 4,
                    3, 6, 2, 3, 7, 6,
                    0, 4, 7, 0, 7, 3,
                    1, 2, 6, 1, 6, 5
                ];
                for (let i = 0; i < 36; ++i) {
                    indices.push(bIdx + faceIndices[i]);
                }
            }
        };

        segmentBox(0, Math.floor(W / 3), 'collider_left');
        segmentBox(Math.floor(W / 3), Math.floor((2 * W) / 3), 'collider_center');
        segmentBox(Math.floor((2 * W) / 3), W, 'collider_right');

        return {
            groundElevation,
            positions: new Float32Array(positions),
            normals: new Float32Array(normals),
            indices: new Uint32Array(indices),
            boundingBoxes
        };
    }

    /**
     * Serializes physics collider mesh to standard binary glTF 2.0 (.glb) container.
     */
    static generatePhysicsColliderGlb(collider: PhysicsColliderMesh): Uint8Array {
        const align4 = (n: number) => (n + 3) & ~3;

        const posBytes = collider.positions.byteLength;
        const normBytes = collider.normals.byteLength;
        const idxBytes = collider.indices.byteLength;

        const idxOffset = 0;
        const posOffset = align4(idxOffset + idxBytes);
        const normOffset = align4(posOffset + posBytes);
        const totalBinBytes = align4(normOffset + normBytes);

        const binBuffer = new Uint8Array(totalBinBytes);
        binBuffer.set(new Uint8Array(collider.indices.buffer, collider.indices.byteOffset, idxBytes), idxOffset);
        binBuffer.set(new Uint8Array(collider.positions.buffer, collider.positions.byteOffset, posBytes), posOffset);
        binBuffer.set(new Uint8Array(collider.normals.buffer, collider.normals.byteOffset, normBytes), normOffset);

        let minX = 1e9, minY = 1e9, minZ = 1e9;
        let maxX = -1e9, maxY = -1e9, maxZ = -1e9;
        for (let i = 0; i < collider.positions.length; i += 3) {
            const x = collider.positions[i + 0];
            const y = collider.positions[i + 1];
            const z = collider.positions[i + 2];
            minX = Math.min(minX, x); maxX = Math.max(maxX, x);
            minY = Math.min(minY, y); maxY = Math.max(maxY, y);
            minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
        }

        const gltfJson = {
            asset: { version: '2.0', generator: 'DepthBox TypeScript Physics Collider Baker' },
            scene: 0,
            scenes: [{ nodes: [0] }],
            nodes: [{ mesh: 0, name: 'Depthbox_Physics_Collider' }],
            meshes: [{
                name: 'PhysicsColliderMesh',
                primitives: [{
                    attributes: { POSITION: 1, NORMAL: 2 },
                    indices: 0,
                    material: 0
                }]
            }],
            materials: [{
                name: 'ColliderWireframeMat',
                pbrMetallicRoughness: {
                    baseColorFactor: [0.22, 0.74, 0.97, 0.65],
                    metallicFactor: 0.1,
                    roughnessFactor: 0.9
                }
            }],
            accessors: [
                { bufferView: 0, byteOffset: 0, componentType: 5125, count: collider.indices.length, type: 'SCALAR' },
                { bufferView: 1, byteOffset: 0, componentType: 5126, count: collider.positions.length / 3, type: 'VEC3', min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
                { bufferView: 2, byteOffset: 0, componentType: 5126, count: collider.normals.length / 3, type: 'VEC3' }
            ],
            bufferViews: [
                { buffer: 0, byteOffset: idxOffset, byteLength: idxBytes, target: 34963 },
                { buffer: 0, byteOffset: posOffset, byteLength: posBytes, target: 34962 },
                { buffer: 0, byteOffset: normOffset, byteLength: normBytes, target: 34962 }
            ],
            buffers: [{ byteLength: totalBinBytes }]
        };

        const jsonStr = JSON.stringify(gltfJson);
        const jsonEncoder = new TextEncoder();
        const jsonBytes = jsonEncoder.encode(jsonStr);
        const paddedJsonLen = align4(jsonBytes.length);

        const totalGlbLen = 12 + 8 + paddedJsonLen + 8 + totalBinBytes;
        const glb = new Uint8Array(totalGlbLen);
        const dv = new DataView(glb.buffer);

        // Header
        dv.setUint32(0, 0x46546C67, true); // 'glTF'
        dv.setUint32(4, 2, true);          // version 2
        dv.setUint32(8, totalGlbLen, true);

        // JSON Chunk
        dv.setUint32(12, paddedJsonLen, true);
        dv.setUint32(16, 0x4E4F534A, true); // 'JSON'
        glb.set(jsonBytes, 20);
        // Pad with space (0x20)
        for (let i = 20 + jsonBytes.length; i < 20 + paddedJsonLen; ++i) {
            glb[i] = 0x20;
        }

        // BIN Chunk
        const binHeaderOffset = 20 + paddedJsonLen;
        dv.setUint32(binHeaderOffset + 0, totalBinBytes, true);
        dv.setUint32(binHeaderOffset + 4, 0x004E4942, true); // 'BIN\0'
        glb.set(binBuffer, binHeaderOffset + 8);

        return glb;
    }

    /**
     * Retrieves an atmospheric and physical illumination environment preset.
     */
    static getAtmospherePreset(preset: AtmospherePreset): AtmosphereEnvironment {
        switch (preset) {
            case 'golden':
                return {
                    preset: 'golden',
                    sunDirection: [0.75, 0.28, -0.58],
                    sunColor: [1.0, 0.62, 0.25],
                    sunIntensity: 1.45,
                    skyAmbient: [0.28, 0.22, 0.35],
                    groundAmbient: [0.18, 0.10, 0.05],
                    fogColor: [0.92, 0.65, 0.38],
                    fogDensity: 0.022
                };
            case 'sunset':
                return {
                    preset: 'sunset',
                    sunDirection: [0.85, 0.08, -0.52],
                    sunColor: [0.98, 0.32, 0.18],
                    sunIntensity: 1.30,
                    skyAmbient: [0.20, 0.12, 0.28],
                    groundAmbient: [0.10, 0.06, 0.08],
                    fogColor: [0.68, 0.25, 0.32],
                    fogDensity: 0.028
                };
            case 'midnight':
                return {
                    preset: 'midnight',
                    sunDirection: [-0.4, 0.85, 0.35],
                    sunColor: [0.25, 0.55, 0.85],
                    sunIntensity: 0.65,
                    skyAmbient: [0.03, 0.05, 0.12],
                    groundAmbient: [0.01, 0.02, 0.04],
                    fogColor: [0.04, 0.06, 0.14],
                    fogDensity: 0.035
                };
            case 'noon':
            default:
                return {
                    preset: 'noon',
                    sunDirection: [0.3, 0.95, -0.2],
                    sunColor: [1.0, 0.98, 0.92],
                    sunIntensity: 1.25,
                    skyAmbient: [0.22, 0.38, 0.58],
                    groundAmbient: [0.12, 0.11, 0.10],
                    fogColor: [0.65, 0.78, 0.92],
                    fogDensity: 0.012
                };
        }
    }

    /**
     * Evaluates normal-based physical Gaussian relighting across a splat point array.
     */
    static relightSplatPoints(
        splats: SplatPoint[],
        env: AtmosphereEnvironment,
        mixFactor: number = 1.0
    ): SplatPoint[] {
        const [sx, sy, sz] = env.sunDirection;
        const sLen = Math.hypot(sx, sy, sz) || 1.0;
        const sunDir: [number, number, number] = [sx / sLen, sy / sLen, sz / sLen];

        return splats.map(s => {
            const [qx, qy, qz, qw] = s.quaternion || [0, 0, 0, 1];
            const nx = 2.0 * (qx * qz + qw * qy);
            const ny = 2.0 * (qy * qz - qw * qx);
            const nz = 1.0 - 2.0 * (qx * qx + qy * qy);
            const nLen = Math.hypot(nx, ny, nz) || 1.0;
            const normX = nx / nLen;
            const normY = ny / nLen;
            const normZ = nz / nLen;

            const nDotL = Math.max(0.0, normX * sunDir[0] + normY * sunDir[1] + normZ * sunDir[2]);
            const hemi = normY * 0.5 + 0.5;

            const ambR = env.groundAmbient[0] * (1.0 - hemi) + env.skyAmbient[0] * hemi;
            const ambG = env.groundAmbient[1] * (1.0 - hemi) + env.skyAmbient[1] * hemi;
            const ambB = env.groundAmbient[2] * (1.0 - hemi) + env.skyAmbient[2] * hemi;

            const albR = s.colorRgb[0];
            const albG = s.colorRgb[1];
            const albB = s.colorRgb[2];

            const litR = albR * (ambR + env.sunColor[0] * nDotL * env.sunIntensity);
            const litG = albG * (ambG + env.sunColor[1] * nDotL * env.sunIntensity);
            const litB = albB * (ambB + env.sunColor[2] * nDotL * env.sunIntensity);

            return {
                ...s,
                colorRgb: [
                    albR * (1.0 - mixFactor) + litR * mixFactor,
                    albG * (1.0 - mixFactor) + litG * mixFactor,
                    albB * (1.0 - mixFactor) + litB * mixFactor
                ]
            };
        });
    }

    /**
     * Converts a 360-degree Equirectangular Panoramic Image into a complete
     * omnidirectional 3D Gaussian Splatting radiance world.
     */
    static convertEquirectangularToSplats(options: EquirectangularConversionOptions): SplatPoint[] {
        const { rgbPixels, width, height, channels = 3, stride = 2, eyeHeight = 1.70, maxRadius = 80.0 } = options;
        const depths = options.metricDepths;
        const splats: SplatPoint[] = [];

        const step = Math.max(1, stride);
        const deltaYaw = (2.0 * Math.PI * step) / width;

        for (let y = 0; y < height; y += step) {
            const v = y / height;
            // pitch from +pi/2 (zenith) to -pi/2 (nadir)
            const pitch = (0.5 - v) * Math.PI;
            const cosPitch = Math.cos(pitch);
            const sinPitch = Math.sin(pitch);

            for (let x = 0; x < width; x += step) {
                const u = x / width;
                const yaw = (u * 2.0 - 1.0) * Math.PI;
                const sinYaw = Math.sin(yaw);
                const cosYaw = Math.cos(yaw);

                // Unit direction vector
                const rx = sinYaw * cosPitch;
                const ry = sinPitch;
                const rz = -cosYaw * cosPitch;

                const pIdx = y * width + x;
                const cIdx = pIdx * channels;

                const r = rgbPixels[cIdx];
                const g = rgbPixels[cIdx + 1];
                const b = rgbPixels[cIdx + 2];
                const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255.0;

                let depth = 0;
                if (depths && depths[pIdx] !== undefined) {
                    depth = depths[pIdx];
                } else {
                    if (ry < -0.04) {
                        const tFloor = -eyeHeight / ry;
                        depth = Math.min(tFloor, maxRadius);
                    } else {
                        const baseD = maxRadius * 0.65;
                        const relief = (1.0 - lum) * (maxRadius * 0.25);
                        depth = Math.min(maxRadius, baseD + relief);
                    }
                }

                if (depth < 0.2) depth = 0.2;

                const posX = rx * depth;
                const posY = eyeHeight + ry * depth;
                const posZ = rz * depth;

                // Inward normal: N = -ray
                const nx = -rx;
                const ny = -ry;
                const nz = -rz;

                // Quaternion aligning (0, 0, 1) with normal
                const dot = nz; // (0,0,1) . (nx, ny, nz)
                let qx = 0, qy = 0, qz = 0, qw = 1;
                if (dot < -0.9999) {
                    qx = 0; qy = 1; qz = 0; qw = 0;
                } else {
                    const ax = -ny;
                    const ay = nx;
                    const az = 0;
                    const aw = 1.0 + dot;
                    const invLen = 1.0 / Math.hypot(ax, ay, az, aw);
                    qx = ax * invLen;
                    qy = ay * invLen;
                    qz = az * invLen;
                    qw = aw * invLen;
                }

                let arc = depth * deltaYaw * Math.max(0.2, cosPitch) * 2.10;
                arc = Math.max(0.02, Math.min(arc, 4.0));

                splats.push({
                    position: [posX, posY, posZ],
                    scale: [arc, arc, arc * 0.2],
                    quaternion: [qx, qy, qz, qw],
                    colorRgb: [r / 255.0, g / 255.0, b / 255.0],
                    opacity: 1.0
                });
            }
        }

        return splats;
    }

    /**
     * Computes the real-world 3D Euclidean distance between two spatial points
     * with metric formatting in meters and feet.
     */
    static measureDistance(p1: [number, number, number], p2: [number, number, number]): SpatialMeasurementResult {
        const dx = p2[0] - p1[0];
        const dy = p2[1] - p1[1];
        const dz = p2[2] - p1[2];
        const meters = Math.hypot(dx, dy, dz);
        const feet = meters * 3.28084;
        return {
            meters,
            feet,
            deltaX: dx,
            deltaY: dy,
            deltaZ: dz
        };
    }
}

