/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { LatLngAlt, Vec3 } from './coordinate/LocalTangentPlane';
import type { SolarPosition } from './coordinate/solarPosition';

/**
 * Single frame 6-DOF camera pose solve extracted from matchmoving software or photogrammetry.
 */
export interface CameraSolveFrame {
    frameNumber: number;
    timeSeconds: number;
    position: Vec3;                                      // Camera position [X, Y, Z] in meters
    rotationQuaternion: [number, number, number, number]; // [qx, qy, qz, qw]
    fovDegrees: number;                                  // Vertical FOV in degrees
    focalLengthMm?: number;                              // Optical focal length in mm
    principalPoint?: [number, number];                   // Optical center [cx, cy] in normalized (0-1) or pixel coords
    reprojectionErrorPx?: number;                        // Sub-pixel tracking error for this frame
}

/**
 * Coordinate convention for camera solve orientation.
 */
export type CameraCoordinateSystem = 'threejs' | 'blender' | 'nuke' | 'alembic' | 'opencv';

/**
 * Complete continuous or keyframed camera solve track across a live-action shot.
 */
export interface CameraSolveTrack {
    id: string;
    name?: string;
    coordinateSystem: CameraCoordinateSystem;
    fps: number;
    totalFrames: number;
    durationSeconds?: number;
    meanReprojectionErrorPx?: number; // Root-Mean-Square Error (RMSE) of the solve track
    sensorWidthMm?: number;           // Standard sensor physical width (e.g. 36mm for Full Frame, 24.89mm for S35)
    sensorHeightMm?: number;          // Standard sensor physical height (e.g. 24mm for Full Frame, 18.66mm for S35)
    focalLengthMm?: number;           // Reference focal length in mm
    frames: CameraSolveFrame[];
    isSolved?: boolean;
    sourceSoftware?: string;          // e.g. "Syntheyes", "Nuke CameraTracker", "Blender Motion Track", "COLMAP"
}

/**
 * Real-world physical filming location and astronomical timestamp.
 * Coordinates with LocalTangentPlane and NOAA solar position algorithms.
 */
export interface GeodeticEphemerisAnchor extends LatLngAlt {
    headingDegrees?: number;         // True North azimuth compass heading of the set (0 = North, 90 = East)
    pitchDegrees?: number;           // Camera rig tilt / inclination
    rollDegrees?: number;            // Camera rig roll
    utcTimestampIso?: string;        // Exact filming date/time in UTC (e.g. "2026-06-21T14:30:00Z")
    calculatedSolar?: Partial<SolarPosition>; // Solar altitude and azimuth
    solarDirectionVector?: Vec3;     // Three.js-friendly direction vector pointing toward the scene origin
    sunLockActive?: boolean;         // When true, scene directional light is locked to the solarDirectionVector
}

/**
 * Optical lens distortion parameters supporting Brown-Conrady, Kannala-Brandt Fisheye,
 * and 3DEqualizer Anamorphic Degree 4/6 models according to VFX industry standards.
 */
export interface LensDistortionParams {
    k1: number;                      // Radial distortion coefficient 1 (barrel < 0, pincushion > 0)
    k2: number;                      // Radial distortion coefficient 2
    k3?: number;                     // Radial distortion coefficient 3 (high-order / mustache curve)
    k4?: number;                     // Radial distortion coefficient 4
    p1?: number;                     // Tangential (decentering) distortion coefficient 1
    p2?: number;                     // Tangential (decentering) distortion coefficient 2
    opticalCenter?: [number, number];// Normalized principal point [cx, cy], default [0.5, 0.5]
    anamorphicSqueeze?: number;      // 1.0 = spherical, 1.33 / 1.5 / 2.0 = anamorphic
    squeezeFactor?: number;          // Ergonomic alias for anamorphicSqueeze
    chromaticAberrationPx?: number;  // Optical chromatic fringing offset in pixels
    chromaticAberration?: number;    // Normalized transverse chromatic dispersion coefficient
    aspectRatio?: number;            // Film back / sensor aspect ratio (width / height)
    model?: 'brown_conrady' | 'kannala_brandt_fisheye' | 'anamorphic_deg4' | 'opencv_rational';
    // 3DEqualizer 4 Anamorphic Standard Degree 4 coefficients
    c20?: number;                    // 3DE4 anamorphic term c20
    c02?: number;                    // 3DE4 anamorphic term c02
    c40?: number;                    // 3DE4 anamorphic term c40
    c22?: number;                    // 3DE4 anamorphic term c22
    c04?: number;                    // 3DE4 anamorphic term c04
    // Kannala-Brandt Fisheye coefficients: d(theta) = theta + k1*theta^3 + k2*theta^5 + k3*theta^7 + k4*theta^9
    fisheyeK1?: number;
    fisheyeK2?: number;
    fisheyeK3?: number;
    fisheyeK4?: number;
    focalLengthMm?: number;          // Physical or 35mm equivalent focal length
    sensorWidthMm?: number;          // Sensor width in millimeters (default 36.0 for full-frame 35mm)
    sensorHeightMm?: number;         // Sensor height in millimeters (default 24.0 for full-frame 35mm)
}

/**
 * 2D-3D correspondence tracking marker used to evaluate real-time reprojection drift.
 */
export interface TrackingMarker2D3D {
    id: string;
    name?: string;
    worldPoint3D: Vec3;              // Rigid 3D coordinate in local scene space [x, y, z]
    platePoint2D: [number, number];  // Measured pixel position on live-action plate [u, v]
    weight?: number;                 // Tracking confidence weight (0.0 to 1.0)
}

/**
 * Anti-drift generative media constraints and depth holdout configuration.
 */
export interface AntiDriftHoldoutConfig {
    enabled?: boolean;
    // Depth Holdout Matte (foreground occlusion by live actors/vehicles)
    depthHoldoutEnabled?: boolean;
    holdoutThresholdMeters?: number;  // Distance cut-off for foreground holdout
    depthThresholdMeters?: number;    // Ergonomic alias for holdoutThresholdMeters
    edgeFeatherRadiusPx?: number;     // Soft feathering around occlusion silhouettes
    edgeFeatherPx?: number;           // Ergonomic alias for edgeFeatherRadiusPx
    occlusionBiasMeters?: number;     // Bias to eliminate edge haloing and z-fighting
    holdoutMatteUrl?: string;        // Pre-rendered rotoscope alpha or depth holdout asset path
    
    // Spatiotemporal Drift Suppression
    rigidProxyConstraint?: boolean;   // Lock generative inpainting to rigid 3D proxy surface
    rigidProxyLocked?: boolean;       // Ergonomic alias for rigidProxyConstraint
    rigidProxyMeshLocked?: boolean;   // Ergonomic alias for rigidProxyLocked
    maxPermittedDriftPx?: number;     // Threshold in pixels before triggering stabilization warp (default 2.0px)
    driftCorrectionMode?: 'rigid_lock' | 'optical_flow_warp' | 'reproject_clean';
    
    // Optical & Sensor Harmonization
    matchSensorGrain?: boolean;       // Synthesize film grain matching the camera sensor
    grainIntensity?: number;          // 0 to 100
    noiseFrequency?: number;          // Grain particle size / frequency (1.0 = fine 35mm, 2.5 = 16mm)
    applyLensDistortion?: boolean;    // Apply matching radial distortion to 3D/generative layers
}

/**
 * Comprehensive VFX Plate configuration attached to a video timeline clip or 3D layer.
 */
export interface VfxPlateConfig {
    id?: string;                     // General ID
    plateClipId?: string;            // ID of the live-action video clip serving as the plate
    plateId?: string;                // Ergonomic alias for plateClipId
    plateName?: string;              // Human readable name
    sourceVideoUri?: string;         // Video URI
    sourceResolution?: [number, number]; // Source resolution [width, height]
    frameRate?: number;              // Frame rate
    durationSeconds?: number;        // Duration in seconds
    cameraSolve?: CameraSolveTrack;  // 6-DOF camera track
    cameraSolveTrack?: CameraSolveTrack; // Ergonomic alias
    geodeticAnchor?: GeodeticEphemerisAnchor; // Real-world geodetic and solar lock
    ephemerisAnchor?: GeodeticEphemerisAnchor; // Ergonomic alias
    lensDistortion?: LensDistortionParams;   // Optical characteristics
    lensDistortionMode?: 'undistort' | 'redistort' | 'passthrough'; // Pipeline directionality
    overscanMargin?: number;                 // Bounding box overscan padding factor (e.g. 0.12 = 12% overscan)
    antiDrift?: AntiDriftHoldoutConfig;      // Anti-drift holdout and stabilization
    holdoutConfig?: AntiDriftHoldoutConfig;  // Ergonomic alias for antiDrift
    trackingMarkers?: TrackingMarker2D3D[];  // Ground-truth 2D-3D markers for drift measurement
    driftMetrics?: {
        currentDriftPx: number;      // Instantaneous reprojection error at playhead time
        maxDriftPx: number;          // Peak drift across shot
        status: 'locked' | 'drifting' | 'uncalibrated';
    };
    [key: string]: any;
}
