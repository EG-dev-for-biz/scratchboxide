/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { BakedGaussian } from '../geospatial-4d-protocol';

/**
 * 2D normalized coordinate in [0.0, 1.0] across image width and height.
 * [x_norm, y_norm] where (0, 0) is top-left and (1, 1) is bottom-right.
 */
export type NormalizedPoint2D = [number, number];

/**
 * 3D world coordinate in meters [x, y, z].
 */
export type WorldPoint3D = [number, number, number];

/**
 * Representation of point tracks across a sequence of video frames.
 */
export interface PointTracks {
    /**
     * Trajectory coordinates per frame.
     * Shape: (T, N, 2) where coords[t][n] is [x_norm, y_norm] in [0.0, 1.0].
     */
    coords: Array<Array<NormalizedPoint2D>>;

    /**
     * Visibility confidence score per point per frame.
     * Shape: (T, N) where visibilities[t][n] in [0.0, 1.0] (1.0 = fully visible, 0.0 = occluded/out of bounds).
     */
    visibilities: Array<Array<number>>;

    /**
     * Original query points in normalized coordinates [x, y].
     * Length: N.
     */
    queryPoints?: NormalizedPoint2D[];

    /**
     * Originating frame index for each query point.
     * Length: N. Default is frame 0.
     */
    queryFrames?: number[];
}

/**
 * Point sampling algorithms for seeding dense video tracking points.
 */
export type PointSamplerType = 'grid' | 'saliency' | 'hybrid';

export interface SamplingConfig {
    type: PointSamplerType;
    maxPoints?: number;
    // For grid / hybrid sampler
    stride?: number;
    margin?: number;
    cellSize?: number;
    // For saliency sampler
    qualityLevel?: number;
    minDistance?: number;
}

/**
 * Tracker backend engine selection.
 */
export type TrackerBackend = 'tapir' | 'lk_flow' | 'mock';

export interface TrackingConfig {
    backend?: TrackerBackend;
    useCausal?: boolean;
    checkpointPath?: string;
    maxTrackDim?: number;
    winSize?: [number, number];
    maxLevel?: number;
    fbThreshold?: number; // Forward-backward pixel error threshold (default: 2.5)
    maxLostFrames?: number;
}

/**
 * Video frame representation for point tracking.
 */
export interface VideoFrameData {
    width: number;
    height: number;
    // RGB buffer: length = width * height * 3 (or RGBA: length = width * height * 4)
    data: Uint8Array | Buffer;
    channels?: number; // 3 or 4
    timestampSeconds?: number;
    frameIndex?: number;
}

/**
 * 4D Gaussian Splatting Dynamic Particle Trajectory Track.
 */
export interface DynamicGaussianTrajectory {
    pointIndex: number;
    canonicalPosition: WorldPoint3D;
    canonicalColor: [number, number, number];
    canonicalScale: [number, number, number];
    canonicalOpacity: number;
    // Displacements relative to canonical position across time frames: shape (T, 3)
    timeDeltas: WorldPoint3D[];
    // Dynamic appearance across time frames: shape (T, 3)
    timeColors: Array<[number, number, number]>;
    // Visibility scalar across time frames: shape (T)
    visibilities: number[];
    // Velocity tangents [vx, vy, vz] for cubic Hermite interpolation: shape (T, 3)
    velocityTangents?: WorldPoint3D[];
    // Dynamic quaternions [x, y, z, w] for rotation along motion path: shape (T, 4)
    quaternions?: Array<[number, number, number, number]>;
}

/**
 * Decomposed 4D Gaussian Splatting Scene.
 * Guarantees that canonical 3DGS from the hero frame is the frame of truth:
 * - staticLayer: unmoving background Gaussians.
 * - dynamicLayer: canonical subject Gaussians deformed through time via TAPIR trajectories.
 */
export interface Decomposed4DSplatScene {
    /**
     * Static background layer (e.g., buildings, ground, sky, furniture).
     */
    staticLayer: BakedGaussian[];

    /**
     * Canonical subject Gaussians at the hero frame.
     */
    canonicalSubject: BakedGaussian[];

    /**
     * Dynamic trajectories for each subject Gaussian across time.
     */
    trajectories: DynamicGaussianTrajectory[];

    /**
     * Total number of video frames spanning the 4D timeline.
     */
    numFrames: number;

    /**
     * Index of the canonical hero frame (where timeDeltas are exactly [0, 0, 0]).
     */
    heroFrameIndex: number;

    /**
     * Timestamps in seconds for each frame.
     */
    frameTimestamps?: number[];

    /**
     * 3D Spatial bounds enclosing the entire 4D sequence.
     */
    bounds: {
        min: WorldPoint3D;
        max: WorldPoint3D;
    };

    /**
     * Pipeline processing telemetry.
     */
    telemetry: {
        trackerUsed: TrackerBackend;
        numDynamicGaussians: number;
        numStaticGaussians: number;
        prunedGaussians: number;
        meanPhotometricError: number;
        processingTimeMs: number;
    };
}
