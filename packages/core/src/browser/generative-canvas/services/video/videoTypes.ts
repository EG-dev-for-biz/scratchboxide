/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type {
    GenerativePatchConfig,
    GenerativePatchMode,
    ApiAspectRatio,
    ApiResolutionTier,
    AspectRatioDecision,
    ResolutionDecision
} from '../../../../common/video-generative-patch';
import type {
    CameraSolveFrame,
    CameraCoordinateSystem,
    CameraSolveTrack,
    GeodeticEphemerisAnchor,
    LensDistortionParams,
    TrackingMarker2D3D,
    AntiDriftHoldoutConfig,
    VfxPlateConfig
} from '../../../../common/vfx-plate-protocol';
import type { PhysicalCameraConfig } from '../../../../common/optics/physical-camera-protocol';

export type {
    GenerativePatchConfig,
    GenerativePatchMode,
    ApiAspectRatio,
    ApiResolutionTier,
    AspectRatioDecision,
    ResolutionDecision,
    CameraSolveFrame,
    CameraCoordinateSystem,
    CameraSolveTrack,
    GeodeticEphemerisAnchor,
    LensDistortionParams,
    TrackingMarker2D3D,
    AntiDriftHoldoutConfig,
    VfxPlateConfig,
    PhysicalCameraConfig
};

export type VideoAspectRatio = '16:9' | '9:16' | '1:1' | '4:3' | '2.39:1';

export enum BlendMode {
    Normal = 0,
    Multiply = 1,
    Screen = 2,
    Overlay = 3,
    Add = 4,
    Difference = 5,
    Lighten = 6,
    Darken = 7
}

export const BLEND_MODE_LABELS: Record<BlendMode, string> = {
    [BlendMode.Normal]: 'Normal',
    [BlendMode.Multiply]: 'Multiply',
    [BlendMode.Screen]: 'Screen',
    [BlendMode.Overlay]: 'Overlay',
    [BlendMode.Add]: 'Add',
    [BlendMode.Difference]: 'Difference',
    [BlendMode.Lighten]: 'Lighten',
    [BlendMode.Darken]: 'Darken'
};

export type KeyframeEasing = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'cubicBezier' | 'stepped' | 'bounce';

export interface PropertyKeyframe {
    id: string;
    time: number; // Offset relative to clip startTime (in seconds)
    value: number;
    vector?: number[];
    easing?: KeyframeEasing;
    controlPoints?: [number, number, number, number]; // [x1, y1, x2, y2]
}

export interface ColorWheelOffset {
    x: number; // -1 to 1 chroma X (Red/Cyan)
    y: number; // -1 to 1 chroma Y (Green/Magenta)
    luma?: number; // -100 to 100 brightness offset
}

export interface GradeParams {
    exposure: number; // -100 to 100
    contrast: number; // -100 to 100
    saturation: number; // 0 to 200
    colorTemp: number; // Kelvin (2000 to 10000, 6500 neutral)
    colorTint: number; // -100 to 100 (green/magenta)
    lift?: ColorWheelOffset; // Shadows
    gamma?: ColorWheelOffset; // Midtones
    gain?: ColorWheelOffset; // Highlights
    offset?: ColorWheelOffset; // Master Offset
    lutId?: string; // 3D LUT preset or custom ID
}

export interface VfxParams {
    blur: number; // 0 to 100
    oldFilm: number; // 0 to 100
    chromatic: number; // 0 to 100
    vignette: number; // 0 to 100
    bokehBlur: number; // 0 to 100
    bokehFocusDepth: number; // 0.1 to 15.0 meters
    motionBlur: number; // 0 to 100
}

export interface KeyingParams {
    enabled: boolean;
    keyColor: string; // hex (e.g. '#00ff00') or CSS color
    tolerance: number; // 0 to 100 (inner threshold for keying)
    softness: number; // 0 to 100 (falloff edge feather)
    despill: number; // 0 to 100 (green/blue bounce removal)
    invert?: boolean; // Invert matte
}

export interface LayerTransform {
    x?: number; // -1.0 to 1.0 normalized position offset
    y?: number; // -1.0 to 1.0 normalized position offset
    scaleX?: number; // 1.0 = 100%
    scaleY?: number; // 1.0 = 100%
    rotation?: number; // in degrees
    anchorX?: number; // 0.0 to 1.0 (default 0.5)
    anchorY?: number; // 0.0 to 1.0 (default 0.5)
}

export interface LightWrapParams {
    intensity: number; // 0 to 100
    spread: number; // 0 to 100
}

export interface VideoMediaAsset {
    id: string;
    name: string;
    type: 'video' | 'audio' | 'image' | '3d';
    url?: string;
    storagePath?: string;
    duration?: number;
    width?: number;
    height?: number;
    thumbnailUrl?: string;
    fps?: number;
    codec?: string;
    colorSpace?: string;
    sampleRate?: number;
    channels?: number;
    // 3D Asset metadata
    meshCount?: number;
    hasAnimations?: boolean;
    animationClips?: string[];
    sceneArtifactId?: string;
    // VFX Plate metadata
    isVfxPlate?: boolean;
    vfxPlateConfig?: VfxPlateConfig;
}

export interface ThreeLightConfig {
    ambientColor?: string; // hex or CSS color
    ambientIntensity?: number;
    directionalColor?: string;
    directionalIntensity?: number;
    directionalPosition?: [number, number, number];
    sunHeading?: number;
    sunAltitude?: number;
}

export interface ThreeCameraConfig {
    fov?: number; // in degrees
    position: [number, number, number];
    target: [number, number, number];
    physicalCamera?: PhysicalCameraConfig;
}

export interface TimelineElement {
    id: string;
    name: string;
    trackId?: string;
    type: 'video' | 'audio' | 'image' | 'text' | '3d' | 'adjustment' | 'overlay';
    mediaId?: string;
    url?: string;
    startTime: number; // in seconds on timeline
    duration: number; // in seconds on timeline
    trimStart: number; // in seconds from source media
    trimEnd: number; // in seconds from source media
    // Transform & Compositing
    x?: number; // normalized or px offset
    y?: number;
    scale?: number; // 1.0 = 100%
    rotation?: number; // in degrees
    opacity?: number; // 0 to 1
    blendMode?: BlendMode | 'normal' | 'multiply' | 'screen' | 'overlay' | 'add' | 'difference' | 'lighten' | 'darken' | 'destination-out' | (string & {});
    layerTransform?: Partial<LayerTransform>;
    keying?: Partial<KeyingParams>;
    lightWrap?: Partial<LightWrapParams>;
    maskMediaId?: string;
    maskUrl?: string;
    generativePatch?: Partial<GenerativePatchConfig>;
    // 3D Object & Scene Compositing (from workspace project)
    sourceType?: 'glb' | 'scene3d' | 'cpp-mesh';
    sourcePath?: string; // Relative project file path e.g. "models/robot.glb" or "scenes/city.scene3d"
    sceneArtifactId?: string; // Project canvas artifact ID
    modelUrl?: string; // glTF / glB model URL or path
    useSceneLighting?: boolean; // If true, uses the Scene3DData's own environment lighting
    lightingConfig?: ThreeLightConfig; // Parametric custom lighting
    cameraConfig?: ThreeCameraConfig; // Parametric camera coordinates
    physicalCamera?: PhysicalCameraConfig; // Physical camera optics and DoF bokeh configuration
    animationClipName?: string; // Exact animation clip name from the 3D asset
    animationSpeed?: number; // Playback rate multiplier
    wireframe?: boolean;
    // Styling & Text
    color?: string; // UI clip block color
    textContent?: string;
    fontSize?: number;
    fontFamily?: string;
    textColor?: string;
    // Color Grading & VFX
    grade?: Partial<GradeParams>;
    vfx?: Partial<VfxParams>;
    speed?: number; // 1.0 = normal, 2.0 = 2x, etc.
    reverse?: boolean;
    // Keyframe Tracks
    keyframes?: Record<string, PropertyKeyframe[]>;
    // Audio specific
    volume?: number; // 0 to 2.0 (1.0 = 0dB)
    pan?: number; // -100 (Left) to +100 (Right)
    // VFX Plate & Anti-Drift Live Action Matching
    isVfxPlate?: boolean;
    vfxPlate?: Partial<VfxPlateConfig>;
}

export interface TimelineTrack {
    id: string;
    name: string;
    type: 'video' | 'audio' | 'overlay' | '3d';
    height?: number;
    muted?: boolean;
    locked: boolean;
    solo?: boolean;
    visible: boolean;
    color?: string; // Track UI accent color
    volume?: number; // 0 to 1.5, default 1.0
    pan?: number; // -100 to 100, default 0
    elements: TimelineElement[];
}

export interface TimelineMarker {
    id: string;
    time: number; // in seconds
    label: string;
    color: string;
}

export type NleTool = 'select' | 'cut' | 'ripple' | 'slip' | 'slide';

export interface VideoTimelineData {
    title: string;
    subtitle?: string;
    fps: number; // Default 30
    duration: number; // in seconds
    currentTime: number; // in seconds (playhead)
    tracks: TimelineTrack[];
    mediaAssets: VideoMediaAsset[];
    markers?: TimelineMarker[];
    selectedClipId?: string;
    selectedTrackId?: string;
    zoom: number; // pixels per second (e.g. 20 to 100)
    aspectRatio: VideoAspectRatio;
    isPlaying?: boolean;
    activeTool?: NleTool;
    snappingEnabled?: boolean;
    masterVolume?: number;
    globalGrade?: Partial<GradeParams>;
    activeVfxPlateId?: string; // ID of active reference VFX plate clip
}
