/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Semantic depth part identified by the Gemini Multimodal Depth Analyst.
 */
export interface SceneDepthPart {
    label?: string;
    /**
     * Metric Z depth following Three.js reference camera convention:
     * - Reference camera sits at Z = +5 and looks toward origin (negative Z).
     * - Closer parts (near camera): +1 to +4m.
     * - Midground parts (near origin): ~0m.
     * - Background / far parts (behind origin): -1m to -50m.
     */
    z: number;
    /** Normalized horizontal center coordinate [0.0 = left, 1.0 = right] */
    imageX: number;
    /** Normalized vertical center coordinate [0.0 = top, 1.0 = bottom] */
    imageY: number;
    /** Optional bounding box width and height in normalized coordinates */
    width?: number;
    height?: number;
    /** Monocular depth estimation rationale (occlusion, shadow, scale, haze) */
    reason?: string;
}

/**
 * Enriched depth part with unprojected 3D coordinates in Three.js world space.
 */
export interface EnrichedSceneDepthPart extends SceneDepthPart {
    worldX: number;
    worldY: number;
    worldZ: number;
}

/**
 * Raw depth annotation returned from the Gemini Multimodal Depth Analyst.
 */
export interface SceneDepthAnnotation {
    parts: Record<string, SceneDepthPart>;
    z_ranges: {
        near: [number, number];
        mid: [number, number];
        far: [number, number];
    };
    sceneType?: 'desktop' | 'vehicle' | 'street' | 'interior' | 'landscape' | 'macro' | 'general';
}

/**
 * Enriched depth annotation with world coordinates computed via camera intrinsics.
 */
export interface EnrichedDepthAnnotation {
    parts: Record<string, EnrichedSceneDepthPart>;
    z_ranges: {
        near: [number, number];
        mid: [number, number];
        far: [number, number];
    };
    aspectRatio: number;
    cameraFovDegrees: number;
    sceneWidthUnits: number;
}

/**
 * Configuration options for synthesizing a continuous metric depth buffer.
 */
export interface DepthMapSynthesisOptions {
    width: number;
    height: number;
    nearDepth?: number;
    farDepth?: number;
    fovDegrees?: number;
    /** Default ground plane horizon height fraction [0.0 = top, 1.0 = bottom], defaults to 0.5 */
    horizonY?: number;
}

/**
 * Continuous 2D metric depth buffer ready for 3D Gaussian Splats or mesh polygonization.
 */
export interface DenseDepthMapResult {
    width: number;
    height: number;
    /** Flat Float32Array of metric distances in meters, length = width * height */
    metricDepths: Float32Array;
    minDepth: number;
    maxDepth: number;
}

/**
 * Request payload for Gemini Scene Depth analysis.
 */
export interface SceneDepthRequest {
    /** Image path, data URL, base64 string, or Buffer */
    image: string | Buffer;
    fovDegrees?: number;
    aspectRatio?: number;
    generateDepthMap?: boolean;
    depthMapResolution?: { width: number; height: number };
}

/**
 * Complete response returned by GeminiSceneDepthService.
 */
export interface SceneDepthResponse {
    success: boolean;
    annotation?: SceneDepthAnnotation;
    enriched?: EnrichedDepthAnnotation;
    depthMap?: DenseDepthMapResult;
    confidence: number;
    explanation?: string;
    error?: string;
}
