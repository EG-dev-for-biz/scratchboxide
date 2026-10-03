/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { inspectGlbBuffer, GlbInspectionData } from './photorealism-evaluator';
import {
    AdaptiveWorldStyleContract,
    DEFAULT_ADAPTIVE_STYLE_CONTRACT
} from '../../common/spatial/adaptive-style-contract';

export type Target3DStyle =
    | 'photoreal'
    | 'low-poly'
    | 'cel-shaded'
    | 'clay-miniature'
    | 'architectural-diagrammatic'
    | 'custom';

export interface StyleQualityEvaluationOptions {
    targetStyle?: Target3DStyle | string;
    styleContract?: Partial<AdaptiveWorldStyleContract>;
    expectedScale?: { minHeight?: number; maxHeight?: number };
    requireGroundPlaneSnap?: boolean;
    maxVerticesBudget?: number;
}

export interface InvariantValidationReport {
    passed: boolean;
    noNaNOrInf: boolean;
    nonZeroVolume: boolean;
    validUnitNormals: boolean;
    consistentWinding: boolean;
    groundPlaneAligned: boolean;
    score: number; // 0 - 50
    diagnostics: string[];
}

export interface StyleConformalAuditReport {
    targetStyle: string;
    passed: boolean;
    conformsToBudget: boolean;
    conformsToShading: boolean;
    conformsToMaterial: boolean;
    score: number; // 0 - 50
    diagnostics: string[];
}

export interface StyleConformalMetricReport {
    assetName: string;
    exerciseName: string; // compatibility alias
    targetStyle: Target3DStyle | string;
    vertexCount: number;
    triangleCount: number;

    // Component Scores
    densityScore: number;          // 0 - 25 (style-contextualized)
    normalSmoothnessScore: number; // 0 - 25 (smooth for photoreal, planar for low-poly)
    aoWeatheringScore: number;     // 0 - 25 (crevice weathering or flat tonal flats)
    pbrMaterialScore: number;      // 0 - 25 (PBR compliance or stylized palette)

    // Summary Scores
    totalScore: number;            // 0 - 100
    passed: boolean;               // >= 80 for style conformance
    isPhotorealistic: boolean;     // >= 90 and targetStyle === 'photoreal'

    // Detailed Invariant & Style Sub-reports
    invariantChecks: InvariantValidationReport;
    styleAudit: StyleConformalAuditReport;

    diagnostics: string[];
    materialSummary: {
        name: string;
        metallic: number;
        roughness: number;
        hasVertexColors: boolean;
        hasEmissive: boolean;
    };
    boundingDimensions: { x: number; y: number; z: number };
    boundingBox: {
        min: [number, number, number];
        max: [number, number, number];
    };
}

/**
 * Universal 3D Quality Evaluator:
 * Evaluates procedural, photogrammetric, or generative 3D assets against both:
 * 1. Layer A: Invariant Physical/Topological Laws (non-degenerate geometry, manifold winding, no NaN/Infs, valid AABB).
 * 2. Layer B: Style-Conformal Aesthetic Goals (photorealism, low-poly retro, anime cel-shading, claymation).
 */
export class StyleConformalQualityEvaluator {
    /**
     * Evaluates a generated 3D asset from its binary GLB container against a specified style intent.
     */
    public evaluateGlb(
        assetName: string,
        glbBytes: Uint8Array,
        options: StyleQualityEvaluationOptions = {}
    ): StyleConformalMetricReport {
        const data = inspectGlbBuffer(glbBytes);
        const targetStyle: Target3DStyle | string = options.targetStyle || 'photoreal';
        const diagnostics: string[] = [];

        // 1. Compute Exact Bounding Box
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        let hasNanOrInf = false;

        const posCount = data.positions.length / 3;
        for (let i = 0; i < posCount; i++) {
            const x = data.positions[i * 3];
            const y = data.positions[i * 3 + 1];
            const z = data.positions[i * 3 + 2];

            if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
                hasNanOrInf = true;
                continue;
            }

            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            minZ = Math.min(minZ, z);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
            maxZ = Math.max(maxZ, z);
        }

        const sizeX = maxX - minX;
        const sizeY = maxY - minY;
        const sizeZ = maxZ - minZ;
        const nonZeroVolume = sizeX > 1e-4 && sizeY > 1e-4 && sizeZ > 1e-4;

        // 2. LAYER A: Style-Invariant Geometric & Topological Invariants
        const invariantDiagnostics: string[] = [];
        let invariantScore = 50;

        if (hasNanOrInf) {
            invariantScore -= 30;
            invariantDiagnostics.push('Defect: NaN or Infinite values detected in vertex position buffer.');
        }

        if (!nonZeroVolume) {
            invariantScore -= 25;
            invariantDiagnostics.push('Defect: Asset collapsed to zero or near-zero volume.');
        }

        // Normal Vector Validation & Curvature Continuity
        let validNormals = 0;
        let totalNormalVar = 0;
        let outwardWindingSum = 0;
        const normalCount = data.normals.length / 3;
        const centerX = (minX + maxX) * 0.5;
        const centerY = (minY + maxY) * 0.5;
        const centerZ = (minZ + maxZ) * 0.5;

        for (let i = 0; i < normalCount; i++) {
            const nx = data.normals[i * 3];
            const ny = data.normals[i * 3 + 1];
            const nz = data.normals[i * 3 + 2];

            if (!Number.isFinite(nx) || !Number.isFinite(ny) || !Number.isFinite(nz)) {
                continue;
            }

            const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
            if (len >= 0.85 && len <= 1.15) {
                validNormals++;
            }

            if (i > 0) {
                const pnx = data.normals[(i - 1) * 3];
                const pny = data.normals[(i - 1) * 3 + 1];
                const pnz = data.normals[(i - 1) * 3 + 2];
                totalNormalVar += Math.abs(nx - pnx) + Math.abs(ny - pny) + Math.abs(nz - pnz);
            }

            // Test Outward Facing Winding Relative to Centroid
            if (i < posCount) {
                const px = data.positions[i * 3];
                const py = data.positions[i * 3 + 1];
                const pz = data.positions[i * 3 + 2];
                const toCentroidX = px - centerX;
                const toCentroidY = py - centerY;
                const toCentroidZ = pz - centerZ;
                outwardWindingSum += (toCentroidX * nx + toCentroidY * ny + toCentroidZ * nz);
            }
        }

        const validNormalRatio = normalCount > 0 ? validNormals / normalCount : 0;
        const avgNormalVar = normalCount > 1 ? totalNormalVar / (normalCount - 1) : 0;
        const consistentWinding = outwardWindingSum >= 0; // Positive dot product indicates outward-pointing normals

        if (validNormalRatio < 0.85) {
            invariantScore -= 15;
            invariantDiagnostics.push(`Defect: Only ${Math.round(validNormalRatio * 100)}% of normals are valid unit vectors.`);
        }

        if (!consistentWinding) {
            invariantScore -= 10;
            invariantDiagnostics.push('Warning: Potential inverted face normal winding detected (normals point predominantly inward).');
        }

        // Ground Plane Alignment (Checks if lowest point touches or rests near Y = 0)
        const groundPlaneAligned = Math.abs(minY) <= 0.25 || minY >= -0.05;
        if (options.requireGroundPlaneSnap && !groundPlaneAligned) {
            invariantScore -= 10;
            invariantDiagnostics.push(`Warning: Model base rests at Y=${minY.toFixed(2)}, not grounded to ground plane Y=0.`);
        }

        const invariantChecks: InvariantValidationReport = {
            passed: invariantScore >= 35 && !hasNanOrInf && nonZeroVolume,
            noNaNOrInf: !hasNanOrInf,
            nonZeroVolume,
            validUnitNormals: validNormalRatio >= 0.85,
            consistentWinding,
            groundPlaneAligned,
            score: Math.max(0, invariantScore),
            diagnostics: invariantDiagnostics
        };

        // 3. LAYER B: Style-Conformal Aesthetic Auditing
        const vCount = data.vertexCount;
        const tCount = data.indexCount / 3;
        const metallic = data.metallicFactor ?? 0.5;
        const roughness = data.roughnessFactor ?? 0.5;
        const hasEmissive = !!(data.emissiveFactor && (data.emissiveFactor[0] > 0 || data.emissiveFactor[1] > 0 || data.emissiveFactor[2] > 0));

        let densityScore = 0;
        let normalScore = 0;
        let aoScore = 0;
        let pbrScore = 0;

        const styleDiagnostics: string[] = [];
        let conformsToBudget = true;
        let conformsToShading = true;
        let conformsToMaterial = true;

        switch (targetStyle) {
            case 'low-poly': {
                // In low-poly, small vertex counts are rewarded, excessive vertices are penalized
                const maxBudget = options.maxVerticesBudget || 3000;
                if (vCount <= maxBudget && vCount >= 4) {
                    densityScore = 25;
                    styleDiagnostics.push(`Low-Poly Budget: Optimal polygon economy (${vCount.toLocaleString()} vertices, budget: ${maxBudget})`);
                } else if (vCount > maxBudget && vCount <= maxBudget * 2) {
                    densityScore = 18;
                    conformsToBudget = false;
                    styleDiagnostics.push(`Low-Poly Budget: Vertex count exceeds low-poly target (${vCount.toLocaleString()} > ${maxBudget})`);
                } else if (vCount > maxBudget * 2) {
                    densityScore = 10;
                    conformsToBudget = false;
                    styleDiagnostics.push(`Low-Poly Budget: Far too dense for low-poly art style (${vCount.toLocaleString()} vertices)`);
                } else {
                    densityScore = 12;
                    styleDiagnostics.push(`Low-Poly Budget: Degenerate or trivial geometry (< 4 vertices)`);
                }

                // In low-poly, faceted step variation is normal and desired!
                if (avgNormalVar > 0.05 || validNormalRatio > 0.9) {
                    normalScore = 25;
                    styleDiagnostics.push('Shading: Crisp planar facets and readable faceted silhouette');
                } else {
                    normalScore = 18;
                    styleDiagnostics.push('Shading: Overly smoothed normals for low-poly styling');
                }

                // Low-poly favors flat palette color clusters over dense noisy weathering
                if (data.colors && data.colors.length > 0) {
                    aoScore = 25;
                    styleDiagnostics.push('Palette: Vertex palette styling present across faceted faces');
                } else {
                    aoScore = 20;
                    styleDiagnostics.push('Palette: Monochromatic low-poly shading');
                }

                // Low-poly favors clean matte or semi-rough materials (not extreme metallic chrome)
                if (roughness >= 0.3 && roughness <= 0.95 && metallic <= 0.5) {
                    pbrScore = 25;
                    styleDiagnostics.push(`Material: Stylized low-poly PBR (roughness: ${roughness.toFixed(2)}, metallic: ${metallic.toFixed(2)})`);
                } else {
                    pbrScore = 20;
                    conformsToMaterial = false;
                    styleDiagnostics.push(`Material: Atypical low-poly PBR (roughness: ${roughness}, metallic: ${metallic})`);
                }
                break;
            }

            case 'cel-shaded': {
                // Cel-shaded / Toon: Moderate polygon budget, clean stepped bands
                if (vCount >= 500 && vCount <= 25000) {
                    densityScore = 25;
                    styleDiagnostics.push(`Cel-Shaded Budget: Balanced silhouette resolution (${vCount.toLocaleString()} vertices)`);
                } else {
                    densityScore = 18;
                    conformsToBudget = false;
                    styleDiagnostics.push(`Cel-Shaded Budget: Density outside optimal cartoon range (${vCount.toLocaleString()})`);
                }

                // Stepped ramps & clean normals
                if (validNormalRatio > 0.9) {
                    normalScore = 25;
                    styleDiagnostics.push('Normals: Smooth continuous normals suitable for stepped cel-shading ramps');
                } else {
                    normalScore = 15;
                    conformsToShading = false;
                    styleDiagnostics.push('Normals: Inconsistent normals may cause broken cel-shading bands');
                }

                // Flat tones or stepped bands
                aoScore = 25;
                styleDiagnostics.push('Tonal Shading: Flat diffuse shading optimized for anime / cel-shaded light integration');

                // High roughness, low metallic
                if (roughness >= 0.5 && metallic <= 0.2) {
                    pbrScore = 25;
                    styleDiagnostics.push('Material: Non-specular matte finish ideal for anime cel-shading');
                } else {
                    pbrScore = 18;
                    conformsToMaterial = false;
                    styleDiagnostics.push('Material: High metallicity or low roughness can conflict with cel-shading');
                }
                break;
            }

            case 'clay-miniature': {
                // Soft rounded forms, matte clay feel
                if (vCount >= 1000) {
                    densityScore = 25;
                    styleDiagnostics.push(`Clay Miniature: Adequate density for rounded beveled contours (${vCount.toLocaleString()} vertices)`);
                } else {
                    densityScore = 18;
                    conformsToBudget = false;
                    styleDiagnostics.push(`Clay Miniature: Low density may cause sharp faceted edges instead of rounded clay`);
                }

                if (validNormalRatio > 0.92) {
                    normalScore = 25;
                    styleDiagnostics.push('Normals: Smooth continuous curvature supporting soft clay highlights');
                } else {
                    normalScore = 18;
                    conformsToShading = false;
                }

                aoScore = 25;
                styleDiagnostics.push('Cavity Occlusion: Soft diffuse crevice shading resembling miniature clay models');

                if (roughness >= 0.65 && metallic <= 0.15) {
                    pbrScore = 25;
                    styleDiagnostics.push(`Material: Authentic clay matte texture (roughness: ${roughness.toFixed(2)}, metallic: ${metallic.toFixed(2)})`);
                } else {
                    pbrScore = 18;
                    conformsToMaterial = false;
                    styleDiagnostics.push('Material: Excessively shiny or metallic for clay miniature aesthetic');
                }
                break;
            }

            case 'architectural-diagrammatic': {
                // Clean isometric massing / grey clay
                densityScore = vCount >= 800 ? 25 : 18;
                normalScore = validNormalRatio > 0.9 ? 25 : 18;
                aoScore = 25;
                pbrScore = (roughness >= 0.5 && metallic <= 0.2) ? 25 : 18;
                styleDiagnostics.push('Architectural Massing: Clean geometric silhouette evaluated for architectural diagram');
                break;
            }

            case 'photoreal':
            default: {
                // Default Photorealism Criteria (preserves 100% of PhotorealismEvaluator rules)
                if (vCount >= 5000) {
                    densityScore = 25;
                    styleDiagnostics.push(`High polygon density: ${vCount.toLocaleString()} vertices, ${tCount.toLocaleString()} triangles`);
                } else if (vCount >= 2000) {
                    densityScore = 22;
                    styleDiagnostics.push(`Good polygon density: ${vCount.toLocaleString()} vertices`);
                } else if (vCount >= 1000) {
                    densityScore = 18;
                    styleDiagnostics.push(`Moderate polygon density: ${vCount.toLocaleString()} vertices`);
                } else {
                    densityScore = Math.max(5, Math.floor((vCount / 1000) * 15));
                    conformsToBudget = false;
                    styleDiagnostics.push(`Low polygon density: only ${vCount} vertices`);
                }

                if (validNormalRatio > 0.98 && avgNormalVar > 0.01) {
                    normalScore = 25;
                    styleDiagnostics.push(`Normals: ${Math.round(validNormalRatio * 100)}% valid unit vectors, smooth continuous curvature`);
                } else if (validNormalRatio > 0.9) {
                    normalScore = 20;
                    styleDiagnostics.push('Normals: Mostly valid with moderate curvature');
                } else {
                    normalScore = 10;
                    conformsToShading = false;
                    styleDiagnostics.push('Normals: Defective or degenerate normal vectors detected');
                }

                // Ambient Occlusion & Procedural Weathering
                if (data.colors && data.colors.length > 0) {
                    const colorCount = data.colors.length / 4;
                    let sumLuminance = 0;
                    let minLuminance = 1.0;
                    let maxLuminance = 0.0;

                    for (let i = 0; i < colorCount; i++) {
                        const r = data.colors[i * 4];
                        const g = data.colors[i * 4 + 1];
                        const b = data.colors[i * 4 + 2];
                        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
                        sumLuminance += lum;
                        minLuminance = Math.min(minLuminance, lum);
                        maxLuminance = Math.max(maxLuminance, lum);
                    }

                    const avgLuminance = sumLuminance / colorCount;
                    let varSum = 0;
                    for (let i = 0; i < colorCount; i++) {
                        const r = data.colors[i * 4];
                        const g = data.colors[i * 4 + 1];
                        const b = data.colors[i * 4 + 2];
                        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
                        varSum += (lum - avgLuminance) * (lum - avgLuminance);
                    }
                    const stdDev = Math.sqrt(varSum / colorCount);

                    if (stdDev >= 0.04 && minLuminance < 0.85) {
                        aoScore = 25;
                        styleDiagnostics.push(`AO & Shading: High dynamic crevice contrast (min: ${minLuminance.toFixed(2)}, stdDev: ${stdDev.toFixed(3)})`);
                    } else if (stdDev > 0.01) {
                        aoScore = 21;
                        styleDiagnostics.push(`AO & Shading: Subtle surface variations present (stdDev: ${stdDev.toFixed(3)})`);
                    } else {
                        aoScore = 15;
                        styleDiagnostics.push('AO & Shading: Uniform vertex coloring without pronounced crevice occlusion');
                    }
                } else {
                    aoScore = 10;
                    styleDiagnostics.push('AO & Shading: No vertex color/AO channel present in container');
                }

                // PBR Material Score
                const roughnessPlausible = roughness >= 0.04 && roughness <= 0.95;
                const metallicPlausible = metallic >= 0.0 && metallic <= 1.0;

                if (roughnessPlausible && metallicPlausible) {
                    pbrScore = 25;
                    styleDiagnostics.push(`PBR Material: Physically accurate parameters (metallic: ${metallic.toFixed(2)}, roughness: ${roughness.toFixed(2)})`);
                } else {
                    pbrScore = 15;
                    conformsToMaterial = false;
                    styleDiagnostics.push(`PBR Material: Non-standard parameters (metallic: ${metallic}, roughness: ${roughness})`);
                }
                break;
            }
        }

        const totalScore = densityScore + normalScore + aoScore + pbrScore;
        const isPhotorealistic = targetStyle === 'photoreal' && totalScore >= 90;
        const passed = totalScore >= 80 && invariantChecks.passed;

        const styleAudit: StyleConformalAuditReport = {
            targetStyle: String(targetStyle),
            passed: conformsToBudget && conformsToShading && conformsToMaterial,
            conformsToBudget,
            conformsToShading,
            conformsToMaterial,
            score: totalScore,
            diagnostics: styleDiagnostics
        };

        const allDiagnostics = [
            ...invariantDiagnostics,
            ...styleDiagnostics
        ];

        return {
            assetName,
            exerciseName: assetName,
            targetStyle,
            vertexCount: vCount,
            triangleCount: tCount,
            densityScore,
            normalSmoothnessScore: normalScore,
            aoWeatheringScore: aoScore,
            pbrMaterialScore: pbrScore,
            totalScore,
            passed,
            isPhotorealistic,
            invariantChecks,
            styleAudit,
            diagnostics: allDiagnostics,
            materialSummary: {
                name: data.materialName || (targetStyle === 'photoreal' ? 'PBR' : String(targetStyle)),
                metallic,
                roughness,
                hasVertexColors: !!(data.colors && data.colors.length > 0),
                hasEmissive
            },
            boundingDimensions: {
                x: sizeX,
                y: sizeY,
                z: sizeZ
            },
            boundingBox: {
                min: [minX, minY, minZ],
                max: [maxX, maxY, maxZ]
            }
        };
    }
}
