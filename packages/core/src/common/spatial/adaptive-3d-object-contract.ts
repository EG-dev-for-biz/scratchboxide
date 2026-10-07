/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Adaptive Domain Architecture 3D Object Contract.
 * In strict alignment with Scratchbox IDE Adaptive Domain Architecture:
 * - Zero closed taxonomies or noun-dictionary categorizations.
 * - Continuous dimensional parameters governing the 70-20-10 Form Hierarchy:
 *   - 70% Primary Edifice (Compound Curvature Lofts & Rotational Solids)
 *   - 20% Secondary Articulated Assemblies (Kinematics, Thrusters, Skids, Wings)
 *   - 10% Tertiary Micro-Detail (Panel Shut Lines, Fasteners, Conduits, Louvers)
 * - Open-domain universality passing the Alien Planet Test.
 ********************************************************************************/

export type ObjectSymmetryMode =
    | 'BILATERAL_X'
    | 'BILATERAL_Y'
    | 'RADIAL_N'
    | 'ASYMMETRIC'
    | (string & {});

export type CapCurvatureProfile =
    | 'CONICAL'
    | 'HEMISPHERICAL'
    | 'SUPER_ELLIPTIC'
    | 'FLAT_BEVELED'
    | 'DIFFUSER'
    | (string & {});

export type ActuatorDriveType =
    | 'HYDRAULIC_RAM'
    | 'PNEUMATIC_CYLINDER'
    | 'ROTARY_SLEWING'
    | 'PRISMATIC_SLIDE'
    | 'TORSION_BAR'
    | (string & {});

export interface CrossSectionStation {
    /** Longitudinal station coordinate along primary axis (typically Z in meters) */
    position: number;
    /** Center offset in orthogonal transverse plane [X, Y] */
    center: [number, number];
    /** Half-radii [radiusX, radiusY] */
    radii: [number, number];
    /** Super-elliptic exponent m: 2.0 = ellipse, 1.0 = diamond, 4.0 = rounded squircle */
    superellipseExponent: number;
    /** Optional roll rotation angle in degrees around the longitudinal axis */
    rollDeg?: number;
}

export interface AdaptivePrimaryHull {
    /** Longitudinal cross-section stations along the primary axis */
    stations: CrossSectionStation[];
    /** Symmetry of the primary massing */
    symmetry: ObjectSymmetryMode;
    /** Number of radial lobes if symmetry is RADIAL_N */
    radialFoldCount?: number;
    /** Forward cap curvature profile */
    bowCap: CapCurvatureProfile;
    /** Aft cap curvature profile */
    sternCap: CapCurvatureProfile;
    /** Transverse wall thickness ratio (for hollow/cockpit cavities, 0.0 = solid) */
    wallThicknessRatio?: number;
}

export interface AdaptiveKinematicLink {
    id: string;
    name?: string;
    parentLinkId?: string;
    anchorPoint: [number, number, number];
    endPoint: [number, number, number];
    crossSectionThickness: [number, number];
    driveType: ActuatorDriveType;
    /** Whether parallel dual-acting hydraulic rams are modeled alongside the link */
    hasHydraulicRamPair?: boolean;
    /** Machined lightening pocket depth ratio (0.0 = solid, 0.5 = 50% pocket) */
    lighteningPocketRatio?: number;
    bevelRadius?: number;
}

export interface AdaptivePropulsionThruster {
    id: string;
    mountPosition: [number, number, number];
    thrustVector: [number, number, number]; // Unit vector
    nozzleLength: number;
    throatRadius: number;
    exitRadius: number;
    /** Venturi / Kort hydrofoil profile curvature */
    nozzleCurvatureExponent: number;
    bladeCount: number;
    hasDebrisIntakeGrille?: boolean;
    hasStatorVanes?: boolean;
    gimbalDegreesOfFreedom?: number;
}

export interface AdaptiveGroundingInterface {
    id: string;
    type: 'RUNNER_SKID' | 'MULTILINK_WHEEL' | 'CRAWLER_TRACK' | 'LANDING_PAD' | (string & {});
    stanceWidthMeters: number;
    wheelbaseMeters: number;
    groundClearanceMeters: number;
    tubularRadiusMeters?: number;
    upsweptBowRadiusMeters?: number;
    stanchionCount?: number;
    camberAngleDeg?: number;
    toeAngleDeg?: number;
}

export interface AdaptiveAerodynamicSurface {
    id: string;
    mountPosition: [number, number, number];
    chordRootMeters: number;
    chordTipMeters: number;
    spanMeters: number;
    sweepAngleDeg: number;
    dihedralAngleDeg: number;
    incidenceAngleDeg: number;
    endplateDimensions?: [number, number]; // [height, thickness]
}

export interface AdaptiveSurfaceTopologyMicroDetail {
    /** Frequency of recessed panel shut-line grooves (seams per meter) */
    panelSeamFrequency: number;
    /** Recessed groove width and depth in meters [width, depth] */
    grooveDimensions: [number, number];
    /** Spacing between counterbored bolt/fastener centers in meters */
    fastenerPitchMeters: number;
    /** Diameter of counterbored fastener recess in meters */
    fastenerDiameterMeters: number;
    /** 3D guide-spline paths for hydraulic hoses, electrical harnesses, and conduits */
    conduitGuideSplines?: Array<{
        path: Array<[number, number, number]>;
        radiusMeters: number;
        pClampSpacingMeters?: number;
    }>;
    /** Directional venting louver bays */
    louverBays?: Array<{
        center: [number, number, number];
        dimensions: [number, number, number]; // [width, height, depth]
        bladeCount: number;
        angleDeg: number;
    }>;
    /** Concentric/radial debris screens for fluid ports */
    intakeScreens?: Array<{
        center: [number, number, number];
        normal: [number, number, number];
        outerRadiusMeters: number;
        ringCount: number;
        spokeCount: number;
    }>;
}

/**
 * The Canonical Adaptive 3D Object Contract.
 * Unifies vehicles, submersibles, spacecraft, rovers, industrial robotics,
 * and speculative extraterrestrial artifacts under a single dimensional schema.
 */
export interface Adaptive3DObjectContract {
    id: string;
    name: string;
    description?: string;
    boundingScaleMeters: [number, number, number]; // [X, Y, Z]

    // 70% Primary Edifice
    primaryHull: AdaptivePrimaryHull;
    secondaryHulls?: AdaptivePrimaryHull[];

    // 20% Secondary Articulated Assemblies
    kinematics?: AdaptiveKinematicLink[];
    propulsion?: AdaptivePropulsionThruster[];
    grounding?: AdaptiveGroundingInterface[];
    aerodynamics?: AdaptiveAerodynamicSurface[];

    // 10% Tertiary Micro-Detail
    microDetail: AdaptiveSurfaceTopologyMicroDetail;

    /** Material tuning attributes */
    materialAttributes?: {
        baseColorRgba?: [number, number, number, number];
        roughness?: number;
        metalness?: number;
        renderMode?: 'clay' | 'pbr' | 'wireframe';
    };
}
