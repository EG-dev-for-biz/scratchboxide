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
     * Operator 6: Transverse Carpal Arch Vaulting.
     * Deforms flat planar ray layouts into continuous transverse structural arches
     * (metacarpal carpal arch in hands, transverse tarsal arch in feet, aerodynamic camber in wings).
     */
    public static applyCarpalArchVaulting(
        positions: Float32Array,
        vertexIndices: number[],
        archOrigin: [number, number, number],
        apexAxisDirection: [number, number, number],
        transverseAxis: [number, number, number],
        normalAxis: [number, number, number],
        vaultDepthMm: number = 2.5,
        halfSpanMm: number = 30.0,
        strength: number = 1.0
    ): void {
        const vaultM = vaultDepthMm * 0.001 * strength;
        const halfSpanM = halfSpanMm * 0.001;

        for (const vIdx of vertexIndices) {
            const pIdx = vIdx * 3;
            const dx = positions[pIdx + 0] - archOrigin[0];
            const dy = positions[pIdx + 1] - archOrigin[1];
            const dz = positions[pIdx + 2] - archOrigin[2];

            const longProj = dx * apexAxisDirection[0] + dy * apexAxisDirection[1] + dz * apexAxisDirection[2];
            const transProj = dx * transverseAxis[0] + dy * transverseAxis[1] + dz * transverseAxis[2];

            if (longProj > 0) {
                const normTrans = Math.min(1.5, Math.abs(transProj) / halfSpanM);
                const drop = vaultM * (normTrans * normTrans);
                positions[pIdx + 0] += normalAxis[0] * drop;
                positions[pIdx + 1] += normalAxis[1] * drop;
                positions[pIdx + 2] += normalAxis[2] * drop;
            }
        }
    }

    /**
     * Operator 7: Subcutaneous Venous & Hydraulic Conduit Elevation.
     * Generates a network of branching fluid conduits (superficial veins or hydraulic pipes)
     * with soft cylindrical Gaussian cross-sections.
     */
    public static applyVenousConduitElevations(
        positions: Float32Array,
        vertexIndices: number[],
        conduits: { start: [number, number, number]; end: [number, number, number]; radiusMm: number; elevationMm: number }[],
        normalAxis: [number, number, number],
        strength: number = 1.0
    ): void {
        for (const conduit of conduits) {
            const ax = conduit.end[0] - conduit.start[0];
            const ay = conduit.end[1] - conduit.start[1];
            const az = conduit.end[2] - conduit.start[2];
            const segLenSq = ax * ax + ay * ay + az * az;
            if (segLenSq < 1e-8) continue;

            const radiusM = conduit.radiusMm * 0.001;
            const elevM = conduit.elevationMm * 0.001 * strength;
            const twoSigmaSq = 2.0 * Math.pow(radiusM * 0.55, 2.0);

            for (const vIdx of vertexIndices) {
                const pIdx = vIdx * 3;
                const px = positions[pIdx + 0] - conduit.start[0];
                const py = positions[pIdx + 1] - conduit.start[1];
                const pz = positions[pIdx + 2] - conduit.start[2];

                const t = Math.max(0, Math.min(1, (px * ax + py * ay + pz * az) / segLenSq));
                const projX = conduit.start[0] + t * ax;
                const projY = conduit.start[1] + t * ay;
                const projZ = conduit.start[2] + t * az;

                const dist = Math.hypot(positions[pIdx + 0] - projX, positions[pIdx + 1] - projY, positions[pIdx + 2] - projZ);
                if (dist < radiusM) {
                    const elevation = elevM * Math.exp(-(dist * dist) / twoSigmaSq);
                    positions[pIdx + 0] += normalAxis[0] * elevation;
                    positions[pIdx + 1] += normalAxis[1] * elevation;
                    positions[pIdx + 2] += normalAxis[2] * elevation;
                }
            }
        }
    }

    /**
     * Operator 8: Palmar & Retinacular Aponeurosis Crease Tethering.
     * Indents biological surfaces along continuous skin-ligament tethering lines
     * (palmar creases, plantar flexion lines, nasolabial folds, abdominal inscriptions).
     */
    public static applyPalmarCreaseTethering(
        positions: Float32Array,
        vertexIndices: number[],
        creaseCurves: [number, number, number][][],
        depthMm: number = 0.8,
        widthMm: number = 2.4,
        normalAxis: [number, number, number],
        strength: number = 1.0
    ): void {
        const depthM = depthMm * 0.001 * strength;
        const widthM = widthMm * 0.001;
        const twoSigmaSq = 2.0 * Math.pow(widthM * 0.45, 2.0);

        for (const curve of creaseCurves) {
            for (let k = 0; k < curve.length - 1; k++) {
                const p0 = curve[k];
                const p1 = curve[k + 1];
                const ax = p1[0] - p0[0];
                const ay = p1[1] - p0[1];
                const az = p1[2] - p0[2];
                const segLenSq = ax * ax + ay * ay + az * az;
                if (segLenSq < 1e-8) continue;

                for (const vIdx of vertexIndices) {
                    const pIdx = vIdx * 3;
                    const px = positions[pIdx + 0] - p0[0];
                    const py = positions[pIdx + 1] - p0[1];
                    const pz = positions[pIdx + 2] - p0[2];

                    const t = Math.max(0, Math.min(1, (px * ax + py * ay + pz * az) / segLenSq));
                    const projX = p0[0] + t * ax;
                    const projY = p0[1] + t * ay;
                    const projZ = p0[2] + t * az;

                    const dist = Math.hypot(positions[pIdx + 0] - projX, positions[pIdx + 1] - projY, positions[pIdx + 2] - projZ);
                    if (dist < widthM) {
                        const indentation = depthM * Math.exp(-(dist * dist) / twoSigmaSq);
                        positions[pIdx + 0] += normalAxis[0] * indentation;
                        positions[pIdx + 1] += normalAxis[1] * indentation;
                        positions[pIdx + 2] += normalAxis[2] * indentation;
                    }
                }
            }
        }
    }

    /**
     * Operator 9: Interphalangeal Articular Flexure Furrows.
     * Sculpt narrow transverse flexion skin grooves on the compression side of articulated joints.
     */
    public static applyInterphalangealFlexureFurrows(
        positions: Float32Array,
        vertexIndices: number[],
        jointCenter: [number, number, number],
        jointAxis: [number, number, number],
        normalAxis: [number, number, number],
        furrowOffsetsMm: number[] = [-1.5, 1.5],
        depthMm: number = 0.5,
        widthMm: number = 1.4,
        strength: number = 1.0
    ): void {
        const depthM = depthMm * 0.001 * strength;
        const widthM = widthMm * 0.001;
        const twoSigmaSq = 2.0 * Math.pow(widthM * 0.45, 2.0);

        for (const offsetMm of furrowOffsetsMm) {
            const offsetM = offsetMm * 0.001;
            for (const vIdx of vertexIndices) {
                const pIdx = vIdx * 3;
                const dx = positions[pIdx + 0] - jointCenter[0];
                const dy = positions[pIdx + 1] - jointCenter[1];
                const dz = positions[pIdx + 2] - jointCenter[2];

                const normalProj = dx * normalAxis[0] + dy * normalAxis[1] + dz * normalAxis[2];
                if (normalProj > 0) { // Only on flexor side
                    const axialProj = dx * jointAxis[0] + dy * jointAxis[1] + dz * jointAxis[2];
                    const distFromCenter = Math.hypot(dx, dy, dz);
                    if (distFromCenter < 0.015) {
                        const alongNormal = Math.abs(normalProj - offsetM);
                        if (alongNormal < widthM) {
                            const furrow = depthM * Math.exp(-(alongNormal * alongNormal) / twoSigmaSq);
                            positions[pIdx + 0] -= normalAxis[0] * furrow;
                            positions[pIdx + 1] -= normalAxis[1] * furrow;
                            positions[pIdx + 2] -= normalAxis[2] * furrow;
                        }
                    }
                }
            }
        }
    }

    /**
     * Dual-Band Frequency Separated Skin PBR Evaluator.
     * Computes biophysically calibrated Albedo, Tangent Normal, and ORM
     * for living human tissue, eliminating macro photographic creping while preserving microscopic pores.
     * Now supports capillary blanching at bony apexes and subcutaneous venous chromophore absorption.
     */
    public static evaluateDualBandSkinPbr(
        melaninFraction: number,
        eumelaninRatio: number,
        capillaryBloodVolume: number,
        dermalAgeFactor: number,
        hydrationLevel: number,
        microCavity: number,
        microNormal: { nx: number; ny: number },
        isArticulatingCrease: boolean = false,
        bonyApexBlanching: number = 0.0,
        venousAbsorption: number = 0.0
    ): { albedo: [number, number, number]; normal: [number, number, number]; orm: [number, number, number] } {
        // Band 1: Low-to-Mid Frequency Biophysical Melanin & Hemoglobin Chromophores
        const m = Math.max(0, Math.min(1, melaninFraction));
        const eu = Math.max(0, Math.min(1, eumelaninRatio));
        const blood = Math.max(0, Math.min(1, capillaryBloodVolume));

        // Melanin color target
        const rMel = 220 * (1 - m) + (140 * eu + 180 * (1 - eu)) * m;
        const gMel = 145 * (1 - m) + ( 72 * eu + 105 * (1 - eu)) * m;
        const bMel = 100 * (1 - m) + ( 42 * eu +  60 * (1 - eu)) * m;

        // Capillary hemoglobin perfusion & venous absorption
        let r = rMel + blood * 24 - venousAbsorption * 22 + bonyApexBlanching * 16;
        let g = gMel - blood * 8  - venousAbsorption * 6  + bonyApexBlanching * 10;
        let b = bMel - blood * 6  + venousAbsorption * 16 + bonyApexBlanching * 8;

        r = Math.round(Math.max(0, Math.min(255, r)));
        g = Math.round(Math.max(0, Math.min(255, g)));
        b = Math.round(Math.max(0, Math.min(255, b)));

        // Band 2: Mid-to-High Frequency Sulci Cutis Micro-Pore Relief
        const normalAmplitude = 0.12 + dermalAgeFactor * 0.35;
        const fnx = microNormal.nx * normalAmplitude;
        const fny = microNormal.ny * normalAmplitude;
        const fnz = Math.sqrt(Math.max(0.01, 1.0 - fnx * fnx - fny * fny));

        const nx = Math.round(Math.max(0, Math.min(255, 128 + fnx * 127)));
        const ny = Math.round(Math.max(0, Math.min(255, 128 + fny * 127)));
        const nz = Math.round(Math.max(0, Math.min(255, fnz * 255)));

        // Band 3: ORM Lipid Mantle Hydration & Dual-Lobe Micro-Roughness
        // Base stratum corneum: 0.44. Sebum micro-sheen on smooth ridge plateaus: 0.36
        const baseRoughness = 0.44 - hydrationLevel * 0.08 + (isArticulatingCrease ? 0.06 : 0.0);
        const sebumSheen = (microCavity > 0.85 ? 0.04 : 0.0);
        const effectiveRoughness = Math.max(0.15, baseRoughness - sebumSheen - (venousAbsorption > 0 ? 0.04 : 0.0));

        const roughnessU8 = Math.round(Math.max(0, Math.min(255, effectiveRoughness * 255 + (1.0 - microCavity) * 20)));
        const aoU8 = Math.round(Math.max(0, Math.min(255, microCavity * 255)));

        return {
            albedo: [r, g, b],
            normal: [nx, ny, nz],
            orm: [aoU8, roughnessU8, 0]
        };
    }
}
