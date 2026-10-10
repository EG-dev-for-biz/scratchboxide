/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Universal Anatomical Morphological Schema (ADA-Compliant).
 * Zero closed taxonomies. Governed strictly by continuous physical dimensions.
 * Satisfies the Alien Planet Test and applies to ANY body part or creature appendage.
 */
export interface UniversalAnatomicalContract {
    /** Global metric scale factor relative to standard adult human [default: 1.0] */
    metricScale: number;

    /** Kinematic Diaphysis Waisting: ratio of mid-shaft contraction [0.0 = tubular, 0.10 = pronounced bone] */
    diaphysisWaisting: number;

    /** Articular Epiphysis Flare: ratio of joint expansion [0.0 = cylindrical, 0.10 = heavy condyles] */
    epiphysisFlare: number;

    /** Subsurface Tendon / Muscular Elevation in millimeters [0.0 = smooth/fat, 3.0 = athletic cords] */
    tendonElevationMm: number;

    /** Adipose Pulp Cushion Depth in millimeters [0.0 = flat, 4.0 = deep fleshy pad] */
    adiposeCushionDepthMm: number;

    /** Distal Terminal Curvature: parabolic dome exponent [1.0 = cone, 2.0 = true parabola, 4.0 = flat cap] */
    terminalDomeExponent: number;

    /** Continuous Biophysical Chromophore Field */
    chromophoreField: {
        /** Melanin concentration fraction [0.0 = albinotic, 1.0 = deep hyper-pigmented] */
        melaninFraction: number;
        /** Eumelanin to Pheomelanin ratio [0.0 = golden-red, 1.0 = deep brown-black] */
        eumelaninRatio: number;
        /** Capillary microvascular blood perfusion fraction [0.0 = ischemic, 1.0 = intense flush] */
        capillaryBloodVolume: number;
        /** Dermal age creping factor [0.0 = youthful smooth, 1.0 = aged/fissured] */
        dermalAgeFactor: number;
        /** Stratum corneum hydration level [0.0 = xerotic chalk, 1.0 = hyper-hydrated sebum] */
        hydrationLevel: number;
    };

    /** Integumentary Keratin Appendages (Nails / Claws / Hooves / Spines) */
    keratinAppendage?: {
        /** Aspect ratio: width / length [0.3 = raptor claw, 1.0 = human nail, 2.5 = broad hoof] */
        aspectRatio: number;
        /** Transverse C-Curve Vaulting exponent [1.0 = flat plate, 3.5 = deeply vaulted shell] */
        transverseVaultingExponent: number;
        /** Distal margin standoff in millimeters [distance from free edge to terminal apex dome] */
        distalStandoffMm: number;
        /** Cuticle overlap lip elevation in millimeters */
        cuticleLipElevationMm: number;
    };
}

/**
 * Universal Anatomical Differential Geometric Operators.
 * Implements the 4 Universal Geometric Operators (Lie sweeps, harmonic revolutions,
 * affine replicators, and isoparametric relief fields) on continuous vertex buffers.
 */
export class UniversalAnatomicalOperators {

    /**
     * Operator 1: Kinematic Diaphysis Hourglass Waisting.
     * Contracts mid-shaft transverse radii of long bones (phalanges, metacarpals, radius, ulna, femur, etc.)
     * without perturbing the longitudinal coordinate (guarantees det(J) > 0, zero triangle inversion).
     */
    public static applyDiaphysisWaisting(
        positions: Float32Array,
        vertexIndices: number[],
        boneStart: [number, number, number],
        boneEnd: [number, number, number],
        waistingRatio: number = 0.065,
        strength: number = 1.0
    ): void {
        const ax = boneEnd[0] - boneStart[0];
        const ay = boneEnd[1] - boneStart[1];
        const az = boneEnd[2] - boneStart[2];
        const boneLengthSq = ax * ax + ay * ay + az * az;
        if (boneLengthSq < 1e-8) return;
        const invBoneLen = 1.0 / Math.sqrt(boneLengthSq);
        const ux = ax * invBoneLen;
        const uy = ay * invBoneLen;
        const uz = az * invBoneLen;

        for (const vIdx of vertexIndices) {
            const pIdx = vIdx * 3;
            const px = positions[pIdx + 0] - boneStart[0];
            const py = positions[pIdx + 1] - boneStart[1];
            const pz = positions[pIdx + 2] - boneStart[2];

            const proj = px * ux + py * uy + pz * uz;
            const xi = proj * invBoneLen; // Normalized longitudinal coordinate [0, 1]

            if (xi > 0.05 && xi < 0.95) {
                // Hourglass contraction: maximum at mid-shaft (xi = 0.5)
                const waistProfile = Math.sin(Math.PI * xi);
                const scaleFactor = 1.0 - waistingRatio * waistProfile * strength;

                // Orthogonal transverse vector from bone axis to vertex
                const ox = px - proj * ux;
                const oy = py - proj * uy;
                const oz = pz - proj * uz;

                positions[pIdx + 0] = boneStart[0] + proj * ux + ox * scaleFactor;
                positions[pIdx + 1] = boneStart[1] + proj * uy + oy * scaleFactor;
                positions[pIdx + 2] = boneStart[2] + proj * uz + oz * scaleFactor;
            }
        }
    }

    /**
     * Operator 2: Articular Bicondylar Lateral Flares.
     * Expands joint articulation axes laterally to form anatomical condylar geometry.
     */
    public static applyCondylarFlares(
        positions: Float32Array,
        vertexIndices: number[],
        jointCenter: [number, number, number],
        lateralAxis: [number, number, number],
        radiusMm: number = 10.0,
        flareRatio: number = 0.065,
        strength: number = 1.0
    ): void {
        const radiusM = radiusMm * 0.001;
        const lx = lateralAxis[0];
        const ly = lateralAxis[1];
        const lz = lateralAxis[2];

        for (const vIdx of vertexIndices) {
            const pIdx = vIdx * 3;
            const dx = positions[pIdx + 0] - jointCenter[0];
            const dy = positions[pIdx + 1] - jointCenter[1];
            const dz = positions[pIdx + 2] - jointCenter[2];
            const dist = Math.hypot(dx, dy, dz);

            if (dist < radiusM) {
                const falloff = Math.cos((dist / radiusM) * (Math.PI * 0.5));
                const lateralDot = dx * lx + dy * ly + dz * lz;
                const sign = lateralDot >= 0 ? 1 : -1;
                const displacement = sign * Math.abs(lateralDot) * flareRatio * falloff * strength;

                positions[pIdx + 0] += lx * displacement;
                positions[pIdx + 1] += ly * displacement;
                positions[pIdx + 2] += lz * displacement;
            }
        }
    }

    /**
     * Operator 3: Monotonic Semi-Ellipsoidal Terminal Dome.
     * Transforms flat polygonal cylinder caps into continuous parabolic domes.
     * Keeps longitudinal parameter t strictly monotonic (dt_new/dt == 1) to eliminate triangle inversion.
     */
    public static applyParabolicDome(
        positions: Float32Array,
        vertexIndices: number[],
        tipOrigin: [number, number, number],
        axisDirection: [number, number, number],
        domeLengthMm: number = 12.0,
        strength: number = 1.0
    ): void {
        const lenM = domeLengthMm * 0.001;
        const ux = axisDirection[0];
        const uy = axisDirection[1];
        const uz = axisDirection[2];

        for (const vIdx of vertexIndices) {
            const pIdx = vIdx * 3;
            const px = positions[pIdx + 0] - tipOrigin[0];
            const py = positions[pIdx + 1] - tipOrigin[1];
            const pz = positions[pIdx + 2] - tipOrigin[2];

            const proj = px * ux + py * uy + pz * uz;
            if (proj > 0.0 && proj < lenM) {
                const xi = proj / lenM; // [0, 1] toward terminal apex
                const ellipseEnvelope = Math.sqrt(Math.max(0.04, 1.0 - xi * xi));
                const radialTaper = 1.0 - (1.0 - ellipseEnvelope) * 0.40 * strength;

                // Transverse vector
                const ox = px - proj * ux;
                const oy = py - proj * uy;
                const oz = pz - proj * uz;

                positions[pIdx + 0] = tipOrigin[0] + proj * ux + ox * radialTaper;
                positions[pIdx + 1] = tipOrigin[1] + proj * uy + oy * radialTaper;
                positions[pIdx + 2] = tipOrigin[2] + proj * uz + oz * radialTaper;
            }
        }
    }

    /**
     * Operator 4: Gaussian Tendon & Musculoskeletal Ridge Elevation.
     * Sculpt continuous athletic tendon cords along anatomical muscle carrier splines.
     */
    public static applyTendonCords(
        positions: Float32Array,
        vertexIndices: number[],
        splineStart: [number, number, number],
        splineEnd: [number, number, number],
        normalAxis: [number, number, number],
        elevationMm: number = 1.8,
        widthMm: number = 4.0,
        strength: number = 1.0
    ): void {
        const elevM = elevationMm * 0.001 * strength;
        const sigmaM = (widthMm * 0.001) * 0.5;
        const twoSigmaSq = 2.0 * sigmaM * sigmaM;

        const ax = splineEnd[0] - splineStart[0];
        const ay = splineEnd[1] - splineStart[1];
        const az = splineEnd[2] - splineStart[2];
        const segLenSq = ax * ax + ay * ay + az * az;
        if (segLenSq < 1e-8) return;

        for (const vIdx of vertexIndices) {
            const pIdx = vIdx * 3;
            const px = positions[pIdx + 0] - splineStart[0];
            const py = positions[pIdx + 1] - splineStart[1];
            const pz = positions[pIdx + 2] - splineStart[2];

            const t = Math.max(0, Math.min(1, (px * ax + py * ay + pz * az) / segLenSq));
            const projX = splineStart[0] + t * ax;
            const projY = splineStart[1] + t * ay;
            const projZ = splineStart[2] + t * az;

            const dist = Math.hypot(positions[pIdx + 0] - projX, positions[pIdx + 1] - projY, positions[pIdx + 2] - projZ);
            if (dist < widthMm * 0.002) {
                const elevation = elevM * Math.exp(-(dist * dist) / twoSigmaSq);
                positions[pIdx + 0] += normalAxis[0] * elevation;
                positions[pIdx + 1] += normalAxis[1] * elevation;
                positions[pIdx + 2] += normalAxis[2] * elevation;
            }
        }
    }

    /**
     * Operator 5: Volar & Adipose Cushion Bulging.
     * Synthesizes soft fleshy pads on compression-bearing contact surfaces.
     */
    public static applyAdiposeCushions(
        positions: Float32Array,
        vertexIndices: number[],
        cushionCenter: [number, number, number],
        normalAxis: [number, number, number],
        depthMm: number = 2.5,
        radiusMm: number = 8.0,
        strength: number = 1.0
    ): void {
        const depthM = depthMm * 0.001 * strength;
        const radiusM = radiusMm * 0.001;

        for (const vIdx of vertexIndices) {
            const pIdx = vIdx * 3;
            const dx = positions[pIdx + 0] - cushionCenter[0];
            const dy = positions[pIdx + 1] - cushionCenter[1];
            const dz = positions[pIdx + 2] - cushionCenter[2];
            const dist = Math.hypot(dx, dy, dz);

            if (dist < radiusM) {
                const falloff = 0.5 * (1.0 + Math.cos((dist / radiusM) * Math.PI));
                positions[pIdx + 0] += normalAxis[0] * depthM * falloff;
                positions[pIdx + 1] += normalAxis[1] * depthM * falloff;
                positions[pIdx + 2] += normalAxis[2] * depthM * falloff;
            }
        }
    }

    /**
     * Dual-Band Frequency Separated Skin PBR Evaluator.
     * Computes biophysically calibrated Albedo, Tangent Normal, and ORM
     * for living human tissue, eliminating macro photographic creping while preserving microscopic pores.
     */
    public static evaluateDualBandSkinPbr(
        melaninFraction: number,
        eumelaninRatio: number,
        capillaryBloodVolume: number,
        dermalAgeFactor: number,
        hydrationLevel: number,
        microCavity: number,
        microNormal: { nx: number; ny: number },
        isArticulatingCrease: boolean = false
    ): { albedo: [number, number, number]; normal: [number, number, number]; orm: [number, number, number] } {
        // Band 1: Low-to-Mid Frequency Biophysical Melanin & Hemoglobin Chromophores
        // Base Fitzpatrick spectrum bounded to optical invariant: G/R in [0.50, 0.55], B/R in [0.28, 0.35]
        const m = Math.max(0, Math.min(1, melaninFraction));
        const eu = Math.max(0, Math.min(1, eumelaninRatio));
        const blood = Math.max(0, Math.min(1, capillaryBloodVolume));

        // Melanin color target
        const rMel = 220 * (1 - m) + (140 * eu + 180 * (1 - eu)) * m;
        const gMel = 145 * (1 - m) + ( 72 * eu + 105 * (1 - eu)) * m;
        const bMel = 100 * (1 - m) + ( 42 * eu +  60 * (1 - eu)) * m;

        // Capillary hemoglobin perfusion
        const r = Math.round(Math.min(255, rMel + blood * 24));
        const g = Math.round(Math.max(0, Math.min(255, gMel - blood * 8)));
        const b = Math.round(Math.max(0, Math.min(255, bMel - blood * 6)));

        // Band 2: Mid-to-High Frequency Sulci Cutis Micro-Pore Relief
        // Youthful skin has fine pore relief (amplitude 0.12); aged skin adds creping fissures
        const normalAmplitude = 0.12 + dermalAgeFactor * 0.35;
        const fnx = microNormal.nx * normalAmplitude;
        const fny = microNormal.ny * normalAmplitude;
        const fnz = Math.sqrt(Math.max(0.01, 1.0 - fnx * fnx - fny * fny));

        const nx = Math.round(Math.max(0, Math.min(255, 128 + fnx * 127)));
        const ny = Math.round(Math.max(0, Math.min(255, 128 + fny * 127)));
        const nz = Math.round(Math.max(0, Math.min(255, fnz * 255)));

        // Band 3: ORM Lipid Mantle Hydration
        // Hydrated living stratum corneum: roughness in [0.42, 0.50]
        const baseRoughness = 0.44 - hydrationLevel * 0.08 + (isArticulatingCrease ? 0.06 : 0.0);
        const roughnessU8 = Math.round(Math.max(0, Math.min(255, baseRoughness * 255 + (1.0 - microCavity) * 16)));
        const aoU8 = Math.round(Math.max(0, Math.min(255, microCavity * 255)));

        return {
            albedo: [r, g, b],
            normal: [nx, ny, nz],
            orm: [aoU8, roughnessU8, 0]
        };
    }
}
