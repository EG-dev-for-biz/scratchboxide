/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

export interface CppCompilerDiagnostic {
    file: string;
    line: number;
    column: number;
    severity: 'error' | 'fatal error' | 'warning' | 'note';
    message: string;
    snippet?: string;
}

export interface CompilationAsset {
    name: string;
    content: string | Uint8Array;
    encoding?: 'utf8' | 'base64' | 'binary';
}

export interface CppCompilationResult {
    success: boolean;
    binaryPath?: string;
    diagnostics: CppCompilerDiagnostic[];
    compilerOutput: string;
    compilationTimeMs: number;
}

export interface CppExecutionResult {
    success: boolean;
    exitCode: number;
    stdout: string;
    stderr: string;
    executionTimeMs: number;
    glbPath?: string;
    glbBase64?: string;
    chunks: Streamed3DChunk[];
}

export interface Streamed3DChunk {
    id: string;
    name: string;
    vertexCount: number;
    indexCount: number;
    glbBase64: string;
    bounds?: {
        min: [number, number, number];
        max: [number, number, number];
    };
}

export interface SpatialBiome {
    id: string;
    name: string;
    theme: 'urban' | 'cyberpunk' | 'alpine' | 'desert' | 'space' | 'volcanic' | 'oceanic';
    elevationRange: [number, number];
    roughness: number;
    vegetationDensity: number;
    colorPalette: string[];
}

export interface SpatialLandmark {
    id: string;
    name: string;
    generatorCppFile: string;
    position: [number, number, number];
    scale: [number, number, number];
    rotation: [number, number, number];
    description: string;
    polygonBudget: number;
}

export interface SpatialWorldBlueprint {
    id: string;
    title: string;
    goal: string;
    worldDimensions: [number, number, number]; // width, height, depth in meters
    targetPolygonBudget: number;
    biomes: SpatialBiome[];
    landmarks: SpatialLandmark[];
    environmentalLighting: {
        skyPreset: string;
        sunElevation: number;
        sunAzimuth: number;
        fogDensity: number;
        volumetricScattering: boolean;
    };
    cppModules: Array<{
        name: string;
        filename: string;
        purpose: string;
        status: 'pending' | 'authoring' | 'compiled' | 'executed' | 'failed';
    }>;
}

export type LongRunning3DPhase =
    | 'blueprint_planning'
    | 'cpp_authoring'
    | 'sandboxed_compilation'
    | 'progressive_streaming'
    | 'viewport_vision_qa'
    | 'completed'
    | 'failed';

export interface LongRunning3DProgressEvent {
    sessionId: string;
    phase: LongRunning3DPhase;
    moduleName?: string;
    progressPercent: number;
    message: string;
    diagnosticErrors?: CppCompilerDiagnostic[];
    latestChunk?: Streamed3DChunk;
    totalVertices?: number;
    totalTriangles?: number;
    visualFidelityScore?: number;
    visualAudit?: {
        passed: boolean;
        overallScore: number;
        dimensionScores?: Record<string, number>;
        remediationRecipe?: string[];
    };
    elapsedTimeMs: number;
}
