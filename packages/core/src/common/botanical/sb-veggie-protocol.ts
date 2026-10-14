/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * SB-Veggie (Scratchbox Vegetation) Parametric Botanical Model & Inversion Protocol.

 ********************************************************************************/

export type SbVeggieArchetype = 'decurrent' | 'conifer' | 'palmate' | 'columnar';

export interface SbVeggieShapeParams {
    /** 16 Morphological Shape Coefficients (beta) */
    beta?: number[];
    /** DBH / Base Girth Caliper (maps to beta[0]) */
    dbhCaliper?: number;
    /** Total Tree Height Scale (maps to beta[1]) */
    treeHeight?: number;
    /** Crown Spread / Aspect Ratio (maps to beta[2]) */
    crownSpread?: number;
    /** Crown Base Height (maps to beta[3]) */
    crownBaseHeight?: number;
    /** Cantilever Branch Droop (maps to beta[4]) */
    branchDroop?: number;
    /** Basal Buttress Flare (maps to beta[5]) */
    buttressFlare?: number;
    /** Trunk Taper Exponent (maps to beta[6]) */
    taperExponent?: number;
    /** Apical Dominance (maps to beta[7]) */
    apicalDominance?: number;
}

export interface SbVeggiePoseParams {
    /** Kinematic joint rotations in Euler radians */
    jointRotations?: Array<{ jointId: number; rx: number; ry: number; rz: number }>;
    /** Wind force vector in metric space */
    windVector?: { x: number; y: number; z: number };
    /** Wind animation elapsed time */
    windTimeSeconds?: number;
}

export interface SbVeggiePhenologyParams {
    /** Phenological Season (1.0 = Summer Green, 0.5 = Autumn Gold, 0.0 = Winter Bare) */
    season?: number;
    /** Foliage cluster density multiplier */
    leafDensity?: number;
    /** Whether to synthesize anatomical leaf cards */
    generateLeaves?: boolean;
}

export interface SbVeggieShapingParams {
    /** Catenary & phototropic bough curvature strength (default 1.0) */
    branchCurvature?: number;
    /** Swelling branch collar flare multiplier (default 1.0) */
    collarFlare?: number;
    /** Stress-adapted elliptical cross section multiplier (default 1.0) */
    reactionWood?: number;
    /** 0 = Lobed Oak 3D blade, 1 = Serrated Birch, 2 = Conifer Needles, 3 = Cypress Scale Cards, 4 = Lanceolate Olive */
    leafMorphology?: number;
    /** Parabolic 3D lamina cupping and sunken midrib strength (default 1.0) */
    leafCupping?: number;
    /** Transfer smooth envelope normals from cluster centroid with upward sky bias */
    transferEnvelopeNormals?: boolean;
}

export interface SbVeggieSynthesizeOptions {
    archetype?: SbVeggieArchetype;
    shape?: SbVeggieShapeParams;
    pose?: SbVeggiePoseParams;
    phenology?: SbVeggiePhenologyParams;
    shaping?: SbVeggieShapingParams;
    outputGlbPath?: string;
}

export interface SbVeggieInversionOptions {
    /** The scan to fit (.glb with vertex-coloured vegetation); required, never replaced by a synthetic stand-in */
    inputScanPath: string;
    archetype?: SbVeggieArchetype;
    maxIterations?: number;
    phenology?: SbVeggiePhenologyParams;
    shaping?: SbVeggieShapingParams;
    outputGlbPath?: string;
    /** Weight of photogrammetric scan color influence on foliage and bark (0.0 to 1.0, default 0.85 when fitting) */
    colorInfluenceWeight?: number;
    /** 0 = Luminance-preserving chrominance transfer, 1 = Direct RGB lerp */
    colorInfluenceMode?: number;
}

export interface SbVeggieInversionTelemetry {
    initialChamferMeters: number;
    finalChamferMeters: number;
    errorReductionPercent: number;
    iterationsRun: number;
    solverRuntimeMs: number;
    fittedBeta: number[];
}

export interface SbVeggieTelemetry {
    archetype: SbVeggieArchetype;
    canonicalTemplate: string;
    templateVertices: number;
    templateJoints: number;
    outputVertices: number;
    outputTriangles: number;
    buildTimeMs: number;
    evalTimeMs: number;
    inversion?: SbVeggieInversionTelemetry;
}

export interface SbVeggieResult {
    success: boolean;
    glbBuffer?: Buffer;
    glbBase64?: string;
    outputGlbPath: string;
    telemetry: SbVeggieTelemetry;
    stdout: string;
    stderr?: string;
}

// Backward-compatible type aliases for legacy SMPL-Tree nomenclature
export type SmplTreeArchetype = SbVeggieArchetype;
export type SmplTreeShapeParams = SbVeggieShapeParams;
export type SmplTreePoseParams = SbVeggiePoseParams;
export type SmplTreePhenologyParams = SbVeggiePhenologyParams;
export type SmplTreeShapingParams = SbVeggieShapingParams;
export type SmplTreeSynthesizeOptions = SbVeggieSynthesizeOptions;
export type SmplTreeInversionOptions = SbVeggieInversionOptions;
export type SmplInversionTelemetry = SbVeggieInversionTelemetry;
export type SmplTreeTelemetry = SbVeggieTelemetry;
export type SmplTreeResult = SbVeggieResult;
