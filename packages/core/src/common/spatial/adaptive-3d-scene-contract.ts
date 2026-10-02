/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Adaptive Domain Architecture 3D Scene Contract.
 * In strict alignment with Scratchbox IDE Adaptive Domain Architecture:
 * - Zero closed taxonomy enums or static preset dictionaries.
 * - Continuous parametric terrain, Archie architecture, SB-Veggie botany,
 *   and radiometric atmospheric fields.
 ********************************************************************************/

export interface AdaptiveTerrainField {
    topology?: string;
    peakHeight: number;
    peakPosition: [number, number];
    sharpnessExponent: number;
    ridgeCount: number;
    valleyFloorElevation: number;
    screeNoiseAmplitude: number;
    gridSize: number;
    gridSpacing: number;
    snowLineElevation: number;
    rockColor: [number, number, number];
    snowColor: [number, number, number];
}

export interface AdaptiveArchitecturalStructure {
    id: string;
    name: string;
    position: [number, number, number];
    rotationYDeg: number;
    dimensions: {
        width: number;
        depth: number;
        floorCount: number;
        floorHeight: number;
    };
    fenestration: {
        bayWidth: number;
        windowRecess: number;
        sillHeight: number;
        headerHeight: number;
        mullionProfile: boolean;
    };
    glazing: {
        color: [number, number, number];
        roughness: number;
        metalness: number;
        emissiveColor: [number, number, number];
        emissiveIntensity: number;
    };
    parapet: {
        height: number;
        copingWidth: number;
    };
    rooftopMechanicals?: boolean;
    features?: Array<{
        type?: string;
        position: [number, number, number];
        scale: [number, number, number];
        rotationYDeg?: number;
    }>;
}

export interface AdaptiveBotanyField {
    species: string;
    archetype?: string;
    density: number;
    elevationMin: number;
    elevationMax: number;
    maxSlopeDeg: number;
    exclusionRadius: number;
    exclusionCenter: [number, number];
    envelopeNormalFactor: number;
    foliageColor?: [number, number, number];
    biomeStratification?: {
        canopyRatio: number;
        understoryRatio: number;
        groundShrubRatio: number;
    };
}

export interface AdaptiveAtmosphereEphemeris {
    sunAzimuthDeg: number;
    sunElevationDeg: number;
    fogDensity: number;
    skyColor: [number, number, number];
}

export interface Adaptive3DSceneContract {
    id: string;
    subject: string;
    narrativeContext: string;
    terrain: AdaptiveTerrainField;
    architecture: {
        structures: AdaptiveArchitecturalStructure[];
    };
    botany: {
        forestPatches: AdaptiveBotanyField[];
    };
    atmosphere?: AdaptiveAtmosphereEphemeris;
}
