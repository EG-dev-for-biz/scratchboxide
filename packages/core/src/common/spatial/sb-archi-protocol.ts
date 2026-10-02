/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * SB-Archi (Scratchbox Classical Architecture) Parametric Protocol.
 *
 * Defines parameters, configuration interfaces, and telemetry structures for
 * C++20 Classical Roman amphitheater arcade synthesis and scan inversion.
 ********************************************************************************/

export type RomanOrderType = 'tuscan' | 'doric' | 'ionic' | 'corinthian' | 'attic_pilaster';
export type ArchiSectionMode = 'north_facade' | 'full';
export type ArchiPbrMode = 'travertine' | 'clay';

export interface SbArchiParams {
    /** Elliptical semi-major axis (meters, nominally 94.0m for Colosseum) */
    semiMajorAxisA?: number;
    /** Elliptical semi-minor axis (meters, nominally 78.0m for Colosseum) */
    semiMinorAxisB?: number;
    /** Total height of 4 tiers (meters, nominally 48.5m) */
    totalHeightMeters?: number;
    /** Radial pier depth / barrel vault thickness (meters, nominally 5.2m) */
    wallDepthMeters?: number;
    /** World centroid in metric coordinates [x, y, z] */
    worldCenter?: [number, number, number];
    /** Geodetic orientation yaw angle in radians (nominally 0.6273 rad / 35.94 deg) */
    worldYawRad?: number;
    /** Section mode: 'north_facade' (intact 4-tier arcade) or 'full' (360-degree ellipse) */
    section?: ArchiSectionMode;
    /** PBR material mode: 'travertine' (rusticated ashlar) or 'clay' (studio grey massing) */
    pbrMode?: ArchiPbrMode;
    /** Total radial bays around 360-degree ellipse (nominally 80) */
    totalBays360?: number;
}

export interface SbArchiInversionOptions {
    /** Path to raw photogrammetry input GLB (e.g. colosseum_clay.glb) */
    inputGlbPath?: string;
    /** Target destination path for synthesized watertight GLB */
    outputGlbPath?: string;
    /** Section mode (default: 'north_facade') */
    section?: ArchiSectionMode;
    /** PBR material mode (default: 'travertine') */
    pbrMode?: ArchiPbrMode;
    /** Whether to run coordinate descent Chamfer inversion solver */
    runInversion?: boolean;
}

export interface SbArchiTelemetry {
    targetStructure?: string;
    sectionMode?: string;
    pbrMode?: string;
    initialChamferMeters: number;
    fittedChamferMeters: number;
    chamferReductionPct: number;
    voidRestorationRatioPct: number;
    synthesizedVertices: number;
    synthesizedTriangles: number;
    optimizerRuntimeMs: number;
    modelSynthesisRuntimeMs: number;
}

export interface SbArchiInversionResult {
    success: boolean;
    glbPath: string;
    glbDownloadUrl?: string;
    telemetry: SbArchiTelemetry;
    worldPosition: [number, number, number];
    worldRotationYawRad: number;
    nominalDimensions: [number, number, number];
    entityId: string;
    error?: string;
}

// ============================================================================
// UNIVERSAL TECTONIC PROTOCOL & GEOMETRIC INTERFACES
// ============================================================================

export type ArchCurveType =
    | 'semicircular'
    | 'segmental'
    | 'pointed_equilateral'
    | 'pointed_lancet'
    | 'basket_handle'
    | 'parabolic'
    | 'catenary'
    | 'horseshoe';

export type ClassicalOrder =
    | 'tuscan'
    | 'doric'
    | 'ionic'
    | 'corinthian'
    | 'composite'
    | 'mixed_superimposed';

export type StructuralFramingSystem =
    | 'load_bearing_masonry'
    | 'frame_and_slab'
    | 'curtain_wall_core'
    | 'steel_portal_frame'
    | 'infrastructure_pavement'
    | (string & {});

export interface CofferConfig {
    rows: number;
    columns: number;
    recessDepth: number;
    borderWidth: number;
    tierCount: number;
    hasRosette?: boolean;
}

export interface ColumnEngineConfig {
    order: ClassicalOrder;
    shaftHeight: number;
    baseRadius: number;
    topRadius: number;
    entasisInflection?: number;
    fluteCount?: number;
    fluteDepth?: number;
    hasPedestal?: boolean;
    pedestalHeight?: number;
    pedestalWidth?: number;
}

export type TectonicStructureClass =
    | 'Amphitheater'
    | 'TriumphalArch'
    | 'PeripteralTemple'
    | 'BasilicaHall'
    | 'AqueductArcade'
    | 'Rotunda'
    | 'Colonnade'
    | 'CampanileTower'
    | 'SkyscraperTower'
    | 'CommercialPodium'
    | 'MultiFamilyResidential'
    | 'BrownstoneRow'
    | 'IndustrialWarehouse'
    | 'StreetCorridor'
    | 'Unknown'
    | (string & {});

export interface TectonicAnalysisReport {
    classification: string;
    confidencePct: number;
    footprintCenter: [number, number, number];
    footprintDimensions: [number, number, number];
    totalHeight: number;
    detectedDatumsCount: number;
    primaryBaySpacingMeters?: number;
    synthesizedVertices: number;
    synthesizedTriangles: number;
    runtimeMs: number;
}

export interface ArchConstantineOptions {
    outputGlbPath?: string;
    includeAtticStatues?: boolean;
    includeCoffers?: boolean;
    pbrMode?: ArchiPbrMode;
}

export interface ArchConstantineResult {
    success: boolean;
    glbPath: string;
    glbDownloadUrl?: string;
    worldPosition: [number, number, number];
    worldRotationYawRad: number;
    nominalDimensions: [number, number, number];
    report: TectonicAnalysisReport;
    error?: string;
}

