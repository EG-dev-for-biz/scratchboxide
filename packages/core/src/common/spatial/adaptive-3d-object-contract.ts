/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Adaptive Domain Architecture 3D Object Contract.
 * In strict alignment with Scratchbox IDE Adaptive Domain Architecture:
 * - Zero closed taxonomies or noun-dictionary categorizations.
 * - Pillar 11: Differential Geometric Primitives over Mechanical Taxonomies:
 *   1. SE(3) Lie Group Curve Sweeps
 *   2. Harmonic Solids of Revolution
 *   3. Affine Metric Replicators
 *   4. Isoparametric Normal Relief Fields
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

// ============================================================================
// THE 4 UNIVERSAL DIFFERENTIAL GEOMETRIC OPERATOR CONTRACTS (PILLAR 11)
// ============================================================================

/**
 * Operator 1: SE(3) Lie Group Curve Sweep
 * Sweeps a 2D profile P(u, v) along a 3D carrier curve C(t) with continuous
 * scaling, twist, and radial modulation. Generates limbs, hoses, claw prongs,
 * tentacles, coils, and structural truss members.
 */
export interface AdaptiveCurveSweepFeature {
    id: string;
    path: Array<[number, number, number]>;
    profile: 'CIRCULAR' | 'BEVELED_RECT' | 'I_BEAM' | 'HOLLOW_RING' | (string & {});
    profileDimensions: [number, number]; // [width, height]
    scaleTaper?: [number, number];       // [startScale, endScale] (default [1.0, 1.0])
    twistDeg?: number;                   // Axial rotation accumulated along curve
    radialModulation?: {
        amplitude: number;               // Sinusoidal amplitude for peristaltic / bellows
        frequency: number;               // Cycles along curve length
    };
    colorRgba?: [number, number, number, number];
}

/**
 * Operator 2: Harmonic Solid of Revolution
 * Revolves a 2D meridian curve r(z) around an arbitrary axis, with optional
 * radial harmonic lobes and helical twist. Generates smooth flanges, nozzles,
 * and lenses (lobeCount = 0), fluted drills and augers (lobeCount in [2, 6]),
 * or cooling fins, cogwheels, and heat sinks (lobeCount >= 12).
 */
export interface AdaptiveRevolvedHarmonicFeature {
    id: string;
    anchorPoint: [number, number, number];
    axis: [number, number, number];       // Direction vector of rotation axis
    profileCurve: Array<[number, number]>;// [(z, radius)] along axis
    harmonicLobeCount: number;            // 0 = smooth, 2-6 = flutes, 12-48 = fins/teeth
    harmonicDepthRatio?: number;          // Depth of lobe indentation (0.0 to 0.5)
    helixPitchMeters?: number;            // Longitudinal lead per 360 deg twist (0 = straight)
    colorRgba?: [number, number, number, number];
}

/**
 * Operator 3: Affine Metric Replicator
 * Periodic affine distribution of a seed micro-geometry along a 1D curve or
 * 2D manifold patch at continuous metric pitch p. Generates fastener circles,
 * louver vanes, debris screens, gripper teeth, and treads.
 */
export interface AdaptiveMetricReplicatorFeature {
    id: string;
    distributionMode: 'CURVE_1D' | 'SURFACE_GRID_2D' | 'POLAR_RING' | (string & {});
    guidePoints: Array<[number, number, number]>;
    pitchMeters: number;                  // Spacing between repeated instances
    seedGeometry: {
        shape: 'CYLINDRICAL_FASTENER' | 'ANGLED_LOUVER_VANE' | 'PERFORATION_HOLE' | 'TRIANGULAR_TOOTH' | (string & {});
        dimensions: [number, number, number]; // [width, height, depth]
        tiltAngleDeg?: number;
    };
    colorRgba?: [number, number, number, number];
}

/**
 * Operator 4: Isoparametric Normal Relief Field
 * Displaces surface vertices along their continuous normals to create panel
 * shut-line grooves, weld seams, expansion joints, or knurling.
 */
export interface AdaptiveNormalReliefFeature {
    panelSeamFrequency: number;           // Recessed seams per meter
    grooveDimensions: [number, number];   // [width, depth] in meters
    fastenerPitchMeters?: number;         // Metric spacing for fastener circles along seams
    reliefPaths?: Array<Array<[number, number, number]>>;
}

// ============================================================================
// CONVENIENCE PROJECTIONS (MACRO INTERFACES MAPPED TO CONTINUOUS OPERATORS)
// ============================================================================

export interface AdaptiveKinematicLink {
    id: string;
    name?: string;
    parentLinkId?: string;
    anchorPoint: [number, number, number];
    endPoint: [number, number, number];
    crossSectionThickness: [number, number];
    driveType: ActuatorDriveType;
    hasHydraulicRamPair?: boolean;
    lighteningPocketRatio?: number;
    bevelRadius?: number;
}

export interface AdaptivePropulsionThruster {
    id: string;
    mountPosition: [number, number, number];
    thrustVector: [number, number, number];
    nozzleLength: number;
    throatRadius: number;
    exitRadius: number;
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
    endplateDimensions?: [number, number];
}

export interface AdaptiveSurfaceTopologyMicroDetail {
    panelSeamFrequency: number;
    grooveDimensions: [number, number];
    fastenerPitchMeters: number;
    fastenerDiameterMeters: number;
    conduitGuideSplines?: Array<{
        path: Array<[number, number, number]>;
        radiusMeters: number;
        pClampSpacingMeters?: number;
    }>;
    louverBays?: Array<{
        center: [number, number, number];
        dimensions: [number, number, number];
        bladeCount: number;
        angleDeg: number;
    }>;
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

    // 20% Secondary Articulated Assemblies (Convenience mappings)
    kinematics?: AdaptiveKinematicLink[];
    propulsion?: AdaptivePropulsionThruster[];
    grounding?: AdaptiveGroundingInterface[];
    aerodynamics?: AdaptiveAerodynamicSurface[];

    // 10% Tertiary Micro-Detail (Convenience mappings)
    microDetail?: AdaptiveSurfaceTopologyMicroDetail;

    // Pillar 11: The 4 Pure Differential Geometric Operators
    curveSweeps?: AdaptiveCurveSweepFeature[];
    revolvedHarmonics?: AdaptiveRevolvedHarmonicFeature[];
    metricReplications?: AdaptiveMetricReplicatorFeature[];
    normalRelief?: AdaptiveNormalReliefFeature;

    /** Material tuning attributes */
    materialAttributes?: {
        baseColorRgba?: [number, number, number, number];
        roughness?: number;
        metalness?: number;
        renderMode?: 'clay' | 'pbr' | 'wireframe';
    };
}
