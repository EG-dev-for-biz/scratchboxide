/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * SB-Veggie (Scratchbox Vegetation) Parametric Botanical Model & Inversion Protocol.

 ********************************************************************************/

/**
 * How a tree grows and carries its leaves, in continuous quantities. There is no tree class to pick: a spreading, a
 * conical and a columnar crown differ in these numbers, and every value between them is as valid as the ends. Omitted
 * fields keep the engine's neutral values.
 */
export interface SbVeggieMorphologyParams {
    /** 0..1: how far the leader outgrows the laterals */
    apicalDominance?: number;
    /** Mean angle of laterals from the leader (radians) */
    branchAngleMeanRad?: number;
    /** Spread (standard deviation) of that angle (radians) */
    branchAngleSpreadRad?: number;
    /** Crown height / crown width (1 = the canonical template) */
    crownAspect?: number;
    /** Distance between successive nodes along a shoot (m) */
    internodeLengthM?: number;
    /** Along a shoot a leaf sits at ((i + 0.5) / n)^exponent of the reach: below 1 it crowds towards the tip */
    leafDistributionExponent?: number;
    /** Angle between successive leaves around the shoot (radians; the golden angle by default) */
    divergenceAngleRad?: number;
    blade?: SbVeggieBladeParams;
}

/** A leaf blade's outline, continuous. */
export interface SbVeggieBladeParams {
    /** Blade width / blade length */
    widthRatio?: number;
    /** Half-width profile t^a (1 - t)^b along the blade: a sets how far the widest point lies from the base */
    outlineA?: number;
    /** ... and b how it tapers to the tip */
    outlineB?: number;
    /** Lobes along the margin, and their depth as a share of the half-width (0 = entire margin) */
    lobeCount?: number;
    lobeDepth?: number;
    /** Teeth along the margin, and their depth as a share of the half-width (0 = entire margin) */
    serrationCount?: number;
    serrationDepth?: number;
    /** Interior rows of the outline (resolution; lobes and teeth need more rows than a plain blade) */
    rows?: number;
}

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
    /** Parabolic 3D lamina cupping and sunken midrib strength (default 1.0) */
    leafCupping?: number;
    /** Transfer smooth envelope normals from cluster centroid with upward sky bias */
    transferEnvelopeNormals?: boolean;
}

export interface SbVeggieSynthesizeOptions {
    morphology?: SbVeggieMorphologyParams;
    shape?: SbVeggieShapeParams;
    pose?: SbVeggiePoseParams;
    phenology?: SbVeggiePhenologyParams;
    shaping?: SbVeggieShapingParams;
    outputGlbPath?: string;
}

export interface SbVeggieInversionOptions {
    /** The scan to fit (.glb with vertex-coloured vegetation); required, never replaced by a synthetic stand-in */
    inputScanPath: string;
    morphology?: SbVeggieMorphologyParams;
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
export type SmplTreeShapeParams = SbVeggieShapeParams;
export type SmplTreePoseParams = SbVeggiePoseParams;
export type SmplTreePhenologyParams = SbVeggiePhenologyParams;
export type SmplTreeShapingParams = SbVeggieShapingParams;
export type SmplTreeSynthesizeOptions = SbVeggieSynthesizeOptions;
export type SmplTreeInversionOptions = SbVeggieInversionOptions;
export type SmplInversionTelemetry = SbVeggieInversionTelemetry;
export type SmplTreeTelemetry = SbVeggieTelemetry;
export type SmplTreeResult = SbVeggieResult;
