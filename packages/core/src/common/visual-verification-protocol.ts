/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { CanvasArtifact, Scene3DData } from '../browser/generative-canvas/canvas-types';

export type ViewportCameraAngle =
    | 'perspective'
    | 'front'
    | 'top'
    | 'isometric'
    | 'side'
    | 'back'
    | 'bottom'
    | string;

export const DEFAULT_VIEWPORT_ANGLES: ViewportCameraAngle[] = [
    'perspective',
    'front',
    'top',
    'isometric'
];

export interface ViewportAngleSpec {
    angle: ViewportCameraAngle;
    cameraPosition?: [number, number, number];
    cameraTarget?: [number, number, number];
    fov?: number;
    orthographic?: boolean;
}

export type VisualAudit3DDefectType =
    | 'unlit'
    | 'void'
    | 'missing_lighting'
    | 'off_center_camera'
    | 'framing_offset'
    | 'missing_material'
    | 'missing_pbr'
    | 'missing_skybox'
    | 'unsubdivided_mesh'
    | 'low_poly_artifact'
    | 'scale_distortion'
    | 'missing_ground'
    | 'clipping'
    | string;

export interface VisualAudit3DDefect {
    defectType: VisualAudit3DDefectType;
    severity: 'fatal' | 'critical' | 'warning' | 'info';
    description: string;
    targetObjectId?: string;
    suggestedOperator?: string;
    suggestedParams?: any;
}

export interface VisualVerificationRequest {
    image: string; // Base64 data URL or raw base64 PNG string
    prompt: string; // Target prompt, expected scene description, or user criteria
    artifactType?: '3d-scene' | 'live-code-sandbox' | 'interactive-browser' | string;
    context?: {
        title?: string;
        code?: string;
        sceneData?: Partial<Scene3DData>;
        viewport?: string;
        angle?: ViewportCameraAngle;
        features?: Record<string, any>;
        iteration?: number;
        artifactId?: string;
        [key: string]: any;
    };
    model?: string;
    maxAutoRepairIterations?: number;
}

export interface VisualCorrectionFixes {
    lighting?: {
        ambientIntensity?: number;
        directionalIntensity?: number;
        color?: string;
        skyColor?: string;
        groundColor?: string;
    };
    shaders?: Record<string, any>;
    camera?: {
        position?: [number, number, number];
        target?: [number, number, number];
        fov?: number;
    };
    environment?: {
        skybox?: string;
        lighting?: string;
        ground?: boolean;
    };
    features?: {
        godRays?: boolean | Record<string, any>;
        atmosphericScattering?: boolean | Record<string, any>;
        contrails?: boolean | Record<string, any>;
        terrainBiomes?: boolean | Record<string, any>;
        [key: string]: any;
    };
    scriptPatches?: string[];
    codePatches?: Array<{
        file?: string;
        search?: string;
        replace?: string;
        fullCode?: string;
    }>;
    scenePatches?: Partial<Scene3DData>;
    cssFixes?: string;
    operatorDispatches?: Array<{ operator: string; params?: any }>;
}

export interface VisualAuditResult {
    pass: boolean; // True if fidelityScore >= 80 and no fatal visual bugs
    fidelityScore: number; // 0 to 100
    critique: string; // Concise multimodal AI critique of visual rendering
    issues: string[]; // List of detected visual bugs (e.g. monochromatic void, missing textures, unlit models)
    strengths: string[]; // List of positive visual aspects
    visualFixes?: VisualCorrectionFixes; // Structured correction directives to auto-repair visual flaws
    operatorDispatches?: Array<{ operator: string; params?: any }>; // Concrete 3D operators to dispatch directly
    defects3D?: VisualAudit3DDefect[]; // Granular 3D defect diagnoses
    angle?: ViewportCameraAngle; // Evaluated camera perspective angle
    thumbnail?: string; // Captured frame data URL (for UI rendering and audit logging)
    timestamp?: string;
    iteration?: number;
    autoRepaired?: boolean;
    modelUsed?: string;
    targetArtifactId?: string;
}

export interface MultiAngleVisualAuditResult {
    overallPass: boolean;
    averageFidelityScore: number;
    angleResults: Record<string, VisualAuditResult>;
    combinedOperatorDispatches: Array<{ operator: string; params?: any }>;
    summaryCritique: string;
    detectedDefects: VisualAudit3DDefect[];
    timestamp?: string;
}

export interface MultiAngleAuditOptions {
    sceneData: Scene3DData;
    prompt: string;
    angles?: ViewportCameraAngle[];
    captureAngleFrame?: (angle: ViewportCameraAngle, sceneData: Scene3DData) => string;
    model?: string;
    context?: Record<string, any>;
}

export interface VisualSelfCorrectionOptions {
    artifact: CanvasArtifact;
    targetPrompt: string;
    captureFrame: () => string;
    maxIterations?: number;
    minPassingScore?: number;
}

export interface VisualSelfCorrectionLoopResult {
    artifact: CanvasArtifact;
    audit: VisualAuditResult;
    iterations: number;
    history: VisualAuditResult[];
    repaired: boolean;
}

export interface VisualSelfCorrection3DOptions {
    sceneData: Scene3DData;
    targetPrompt: string;
    angles?: ViewportCameraAngle[];
    captureAngleFrame?: (angle: ViewportCameraAngle, sceneData: Scene3DData) => string;
    maxIterations?: number;
    minPassingScore?: number;
    engine?: any;
    autoDispatch?: boolean;
    model?: string;
}

export interface VisualSelfCorrection3DLoopResult {
    sceneData: Scene3DData;
    operatorEngine: any;
    iterations: number;
    converged: boolean;
    initialFidelityScore: number;
    finalFidelityScore: number;
    auditHistory: Array<{ iteration: number; multiAngleAudit: MultiAngleVisualAuditResult }>;
    executedOperators: Array<{ operator: string; params?: any; result?: any }>;
    repaired: boolean;
}

/**
 * Standard visual check criteria for multimodal vision critique.
 */
export const VISUAL_VERIFICATION_CRITERIA = [
    'Absence of monochromatic black/blank void frames',
    'Proper illumination and directional/ambient lighting balance',
    'Atmospheric sky shaders, environment maps, or background context',
    'Correct camera framing, target orientation, and field of view',
    'Complete geometry rendering without unhandled clipping or culling',
    'Physically-based rendering (PBR) materials with realistic roughness and metalness',
    'Sufficient mesh polygon resolution without jagged low-poly faceted distortion',
    'Semantic alignment with user prompt requirements'
];

/**
 * Computes canonical camera position, target, and field of view for a given viewport angle.
 */
export function computeCameraForViewportAngle(
    angle: ViewportCameraAngle,
    sceneData?: Partial<Scene3DData>
): { position: [number, number, number]; target: [number, number, number]; fov: number } {
    let cx = 0;
    let cy = 0;
    let cz = 0;
    let maxDimension = 10;

    if (sceneData?.customMeshes && sceneData.customMeshes.length > 0) {
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

        for (const m of sceneData.customMeshes) {
            const pos = m.position || [0, 0, 0];
            const scl = m.scale || [1, 1, 1];
            minX = Math.min(minX, pos[0] - scl[0] / 2);
            maxX = Math.max(maxX, pos[0] + scl[0] / 2);
            minY = Math.min(minY, pos[1] - scl[1] / 2);
            maxY = Math.max(maxY, pos[1] + scl[1] / 2);
            minZ = Math.min(minZ, pos[2] - scl[2] / 2);
            maxZ = Math.max(maxZ, pos[2] + scl[2] / 2);
        }

        if (minX !== Infinity) {
            cx = (minX + maxX) / 2;
            cy = (minY + maxY) / 2;
            cz = (minZ + maxZ) / 2;
            const sizeX = maxX - minX;
            const sizeY = maxY - minY;
            const sizeZ = maxZ - minZ;
            maxDimension = Math.max(sizeX, sizeY, sizeZ, 8);
        }
    }

    const dist = maxDimension * 1.5;

    switch (angle) {
        case 'perspective':
            return {
                position: [Number((cx + dist * 0.9).toFixed(2)), Number((cy + dist * 0.7).toFixed(2)), Number((cz + dist * 0.9).toFixed(2))],
                target: [cx, cy, cz],
                fov: 45
            };
        case 'front':
            return {
                position: [cx, Number((cy + dist * 0.2).toFixed(2)), Number((cz + dist * 1.4).toFixed(2))],
                target: [cx, cy, cz],
                fov: 45
            };
        case 'top':
            return {
                position: [cx, Number((cy + dist * 1.8).toFixed(2)), Number((cz + 0.001).toFixed(3))],
                target: [cx, cy, cz],
                fov: 45
            };
        case 'isometric':
            return {
                position: [Number((cx + dist * 1.1).toFixed(2)), Number((cy + dist * 1.1).toFixed(2)), Number((cz + dist * 1.1).toFixed(2))],
                target: [cx, cy, cz],
                fov: 35
            };
        case 'side':
            return {
                position: [Number((cx + dist * 1.4).toFixed(2)), Number((cy + dist * 0.2).toFixed(2)), cz],
                target: [cx, cy, cz],
                fov: 45
            };
        case 'back':
            return {
                position: [cx, Number((cy + dist * 0.2).toFixed(2)), Number((cz - dist * 1.4).toFixed(2))],
                target: [cx, cy, cz],
                fov: 45
            };
        case 'bottom':
            return {
                position: [cx, Number((cy - dist * 1.8).toFixed(2)), Number((cz + 0.001).toFixed(3))],
                target: [cx, cy, cz],
                fov: 45
            };
        default:
            return {
                position: [Number((cx + dist * 0.9).toFixed(2)), Number((cy + dist * 0.7).toFixed(2)), Number((cz + dist * 0.9).toFixed(2))],
                target: [cx, cy, cz],
                fov: 45
            };
    }
}

/**
 * Normalize an image string to clean base64 data and mimeType.
 */
export function parseImagePayload(rawImage: string): { base64Data: string; mimeType: string; dataUrl: string } {
    const clean = (rawImage || '').trim();
    let mimeType = 'image/png';
    let base64Data = clean;

    if (clean.startsWith('data:')) {
        const match = clean.match(/^data:([^;]+);base64,(.+)$/);
        if (match) {
            mimeType = match[1] || 'image/png';
            base64Data = match[2];
        } else {
            const commaIdx = clean.indexOf(',');
            if (commaIdx !== -1) {
                base64Data = clean.slice(commaIdx + 1);
            }
        }
    }

    const dataUrl = `data:${mimeType};base64,${base64Data}`;
    return { base64Data, mimeType, dataUrl };
}
