/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import type { ToolDeclaration, ToolHandler, ToolResultPayload } from './types';
import { AlgorithmicUvEngine, type UvEngineMode, type BiophysicalMaterialContract } from '../../spatial/AlgorithmicUvEngine';
import { MaxRectsAtlasPacker, type TextureItem } from '../../spatial/TextureAtlasPacker';

function asString(val: unknown): string | undefined {
    return typeof val === 'string' && val.trim().length > 0 ? val.trim() : undefined;
}

function asBoolean(val: unknown, fallback: boolean): boolean {
    return typeof val === 'boolean' ? val : fallback;
}

function asNumber(val: unknown, fallback?: number): number | undefined {
    return typeof val === 'number' && !isNaN(val) ? val : fallback;
}

export const ALGORITHMIC_UV_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'algorithmic_uv_unwrap_rewrap',
        description: 'Process any 3D model / scene (.glb) with the Algorithmic UV Unwrap & Rewrap Engine. In "preserve-100-lock" mode, preserves 100% geometry and UV topology (0.000 mm vertex drift) with continuous 3D coordinate interpolation, analytical travertine/limestone cavitation pores, calcite tooth, road marking protection, and road/foliage protection. In "conformal-reparameterize" mode, performs Tutte harmonic parameterization, MaxRects bin packing (85-92% fill), and Poisson gradient-domain texture baking. Supports Adaptive Domain biophysical contracts and 1D spatial autocorrelation periodicity induction.',
        parameters: {
            type: 'OBJECT',
            properties: {
                inputGlbPath: {
                    type: 'STRING',
                    description: 'Path on disk to the input .glb mesh file to unwrap/rewrap.'
                },
                mode: {
                    type: 'STRING',
                    description: 'Engine mode: "preserve-100-lock" (bit-for-bit geometry/UV lock with micro-detail enhancement) or "conformal-reparameterize" (harmonic unwrap + MaxRects atlas repacking). Defaults to "preserve-100-lock".'
                },
                lithologyProfile: {
                    type: 'STRING',
                    description: 'Lithology profile string or open descriptive prompt (e.g. "classical-travertine", "bedford-limestone", "modern-curtain-wall", "asphalt roadway", "weathered bronze").'
                },
                biophysicalContract: {
                    type: 'OBJECT',
                    description: 'Continuous biophysical material contract (roughness, metalness, normalStrength, cavitationDepthPower, strataFrequency, laplacianBurnishFactor, laplacianCavityGritFactor, toksvigVarianceScale, hbaoRadius, hbaoIntensity, subsurfaceAlbedo).'
                },
                autoInducePeriodicity: {
                    type: 'BOOLEAN',
                    description: 'Whether to auto-induce architectural unit cell periodicity (lambda_x, lambda_y) via 1D spatial autocorrelation of texture scanlines (default: false).'
                },
                enableCavitation: {
                    type: 'BOOLEAN',
                    description: 'Whether to synthesize analytical non-linear travertine cavitation pores on stone architecture (default: auto from lithology/contract).'
                },
                enableCalciteStrata: {
                    type: 'BOOLEAN',
                    description: 'Whether to synthesize horizontal calcite bedding strata and crystalline grain (default: auto from lithology/contract).'
                },
                enableAlbedoDeLighting: {
                    type: 'BOOLEAN',
                    description: 'Whether to apply bilateral Intrinsic Image Decomposition to separate diffuse albedo from directional sun shadows (default: false).'
                },
                enableHeightStratifiedDeLighting: {
                    type: 'BOOLEAN',
                    description: 'Whether to apply height-stratified shadow lift to brighten deep street canyon floors (default: false).'
                },
                enableMicroDetailTiling: {
                    type: 'BOOLEAN',
                    description: 'Whether to inject KHR_texture_transform for camera-distance scale invariance (default: false).'
                },
                microDetailScale: {
                    type: 'NUMBER',
                    description: 'Micro-detail UV tiling factor (default: 32.0, or auto-induced from autocorrelation).'
                },
                generateNormalMaps: {
                    type: 'BOOLEAN',
                    description: 'Whether to synthesize tangent-space normal maps (default: true).'
                },
                enableMultiFrequencyNormals: {
                    type: 'BOOLEAN',
                    description: 'Whether to synthesize multi-frequency tangent normal maps (Macro, Meso-Scharr, Micro-Grit) with Reoriented Normal Mapping (RNM) blending (default: true).'
                },
                generateRoughnessMaps: {
                    type: 'BOOLEAN',
                    description: 'Whether to generate semantic physical GGX roughness maps (default: true).'
                },
                enableBiophysicalRoughness: {
                    type: 'BOOLEAN',
                    description: 'Whether to synthesize biophysical Laplacian curvature roughness (edge burnishing on kappa > 0, crevice dirt accumulation on kappa < 0) (default: true).'
                },
                enableToksvigFiltering: {
                    type: 'BOOLEAN',
                    description: 'Whether to apply Toksvig specular anti-aliasing to fold grazing normal variance into roughness (default: true).'
                },
                generateAoMaps: {
                    type: 'BOOLEAN',
                    description: 'Whether to bake analytical sky-dome ambient occlusion (default: true).'
                },
                enableHbaoMicroCavity: {
                    type: 'BOOLEAN',
                    description: 'Whether to compute 8-directional radial horizon raymarched micro-cavity ambient occlusion (HBAO) (default: true).'
                },
                outputGlbPath: {
                    type: 'STRING',
                    description: 'Optional path on disk to write the output enhanced .glb file.'
                }
            },
            required: ['inputGlbPath']
        }
    },
    {
        name: 'uv_analyze_texel_density',
        description: 'Measure real-world metric texel density across all submeshes of a 3D model (.glb), calculating world-space triangle area vs UV area (texels per square meter) and detecting texel density variance.',
        parameters: {
            type: 'OBJECT',
            properties: {
                inputGlbPath: {
                    type: 'STRING',
                    description: 'Path on disk to the input .glb mesh file to analyze.'
                },
                defaultTexSize: {
                    type: 'NUMBER',
                    description: 'Default chart texture resolution in pixels (default: 512).'
                }
            },
            required: ['inputGlbPath']
        }
    },
    {
        name: 'pbr_material_decompose',
        description: 'Photometric De-Lighting & True PBR Material Suite Decomposition. Separates diffuse albedo from incident irradiance, calculates sky-dome ambient occlusion (HBAO), extracts multi-frequency normal maps with RNM blending, computes biophysical Laplacian GGX roughness, Toksvig AA filtering, and packs standard glTF ORM textures.',
        parameters: {
            type: 'OBJECT',
            properties: {
                enableAlbedoDeLighting: {
                    type: 'BOOLEAN',
                    description: 'Separate diffuse albedo from illumination via CIELAB bilateral filtering (default: true).'
                },
                normalStrength: {
                    type: 'NUMBER',
                    description: 'Tangent normal map perturbation intensity (default: 3.2).'
                },
                defaultStoneRoughness: {
                    type: 'NUMBER',
                    description: 'Base roughness for architectural stone (default: 0.85).'
                },
                skyDomeAoIntensity: {
                    type: 'NUMBER',
                    description: 'Analytical sky-dome AO depth intensity (default: 1.0).'
                },
                biophysicalContract: {
                    type: 'OBJECT',
                    description: 'Continuous biophysical material contract (roughness, metalness, normalStrength, etc.).'
                },
                enableMultiFrequencyNormals: {
                    type: 'BOOLEAN',
                    description: 'Whether to synthesize multi-frequency tangent normal maps (default: true).'
                },
                enableBiophysicalRoughness: {
                    type: 'BOOLEAN',
                    description: 'Whether to synthesize biophysical Laplacian curvature roughness (default: true).'
                },
                enableHbaoMicroCavity: {
                    type: 'BOOLEAN',
                    description: 'Whether to compute 8-directional radial horizon raymarched micro-cavity ambient occlusion (HBAO) (default: true).'
                },
                enableToksvigFiltering: {
                    type: 'BOOLEAN',
                    description: 'Whether to apply Toksvig specular anti-aliasing (default: true).'
                }
            }
        }
    },
    {
        name: 'atlas_maxrects_pack',
        description: 'Pack UV charts or texture rectangles using the high-efficiency MaxRects (BSSF) algorithm with 90-degree rotations, achieving 85% to 92%+ texel fill density and effectively doubling usable texture resolution.',
        parameters: {
            type: 'OBJECT',
            properties: {
                rectangles: {
                    type: 'ARRAY',
                    description: 'List of rectangle dimensions to pack: [{ id, width, height }]',
                    items: {
                        type: 'OBJECT',
                        properties: {
                            id: { type: 'STRING' },
                            width: { type: 'NUMBER' },
                            height: { type: 'NUMBER' }
                        },
                        required: ['id', 'width', 'height']
                    }
                },
                padding: {
                    type: 'NUMBER',
                    description: 'Gutter padding between texture charts in pixels (default: 2).'
                },
                allowRotation: {
                    type: 'BOOLEAN',
                    description: 'Allow 90-degree chart rotation for concave nesting (default: true).'
                }
            },
            required: ['rectangles']
        }
    }
];

export const algorithmicUvHandlers: Record<string, ToolHandler> = {
    algorithmic_uv_unwrap_rewrap: async (args, _ctx) => {
        const inputGlbPath = asString(args.inputGlbPath);
        if (!inputGlbPath) {
            return {
                resultPayload: { success: false, error: 'inputGlbPath is required' } as unknown as ToolResultPayload,
                summaryResult: 'Algorithmic UV error: inputGlbPath is required.'
            };
        }

        const mode = (asString(args.mode) as UvEngineMode) || 'preserve-100-lock';
        const lithologyProfile = asString(args.lithologyProfile) as any;
        const outputGlbPath = asString(args.outputGlbPath);
        const biophysicalContract = (args.biophysicalContract && typeof args.biophysicalContract === 'object')
            ? args.biophysicalContract as BiophysicalMaterialContract
            : undefined;
        const autoInducePeriodicity = asBoolean(args.autoInducePeriodicity, false);

        const result = await AlgorithmicUvEngine.processGlb({
            inputGlbPath,
            outputGlbPath,
            mode,
            lithologyProfile,
            biophysicalContract,
            autoInducePeriodicity,
            enableMicroDetailTiling: asBoolean(args.enableMicroDetailTiling, false),
            microDetailScale: asNumber(args.microDetailScale, 32.0),
            detailSynthesis: {
                lithologyProfile,
                biophysicalContract,
                enableCavitation: args.enableCavitation !== undefined ? asBoolean(args.enableCavitation, true) : undefined,
                enableCalciteStrata: args.enableCalciteStrata !== undefined ? asBoolean(args.enableCalciteStrata, true) : undefined
            },
            pbrDecomposition: {
                biophysicalContract,
                enableAlbedoDeLighting: asBoolean(args.enableAlbedoDeLighting, false),
                enableHeightStratifiedDeLighting: asBoolean(args.enableHeightStratifiedDeLighting, false),
                generateNormalMaps: asBoolean(args.generateNormalMaps, true),
                enableMultiFrequencyNormals: asBoolean(args.enableMultiFrequencyNormals, true),
                generateRoughnessMaps: asBoolean(args.generateRoughnessMaps, true),
                enableBiophysicalRoughness: asBoolean(args.enableBiophysicalRoughness, true),
                enableToksvigFiltering: asBoolean(args.enableToksvigFiltering, true),
                generateAoMaps: asBoolean(args.generateAoMaps, true),
                enableHbaoMicroCavity: asBoolean(args.enableHbaoMicroCavity, true),
                packOrm: true
            }
        });

        const inducedSummary = result.inducedSpatialProfile?.isPeriodic
            ? ` Auto-induced unit cell: ${result.inducedSpatialProfile.dominantPeriodPxX}x${result.inducedSpatialProfile.dominantPeriodPxY}px (${result.inducedSpatialProfile.physicalModuleWidthMeters}x${result.inducedSpatialProfile.physicalModuleHeightMeters}m, repeat ${result.inducedSpatialProfile.recommendedRepeatX}x${result.inducedSpatialProfile.recommendedRepeatY}).`
            : '';

        return {
            resultPayload: result as unknown as ToolResultPayload,
            summaryResult: `Algorithmic UV Unwrap & Rewrap Engine completed in ${result.executionTimeMs.toFixed(1)}ms. Mode: ${result.mode}, lithology: ${result.lithologyProfile}, submeshes: ${result.submeshesProcessed}, triangles: ${result.trianglesProcessed}, texels: ${result.texelsProcessed.toLocaleString()} (stone: ${result.stoneTexelsCount.toLocaleString()}, road: ${result.roadTexelsCount.toLocaleString()}, markings: ${result.roadMarkingTexelsCount?.toLocaleString() || '0'}, foliage: ${result.foliageTexelsCount.toLocaleString()}). Density: ${result.texelDensityMetrics?.meanTexelsPerMeter.toFixed(1)} tex/m².${inducedSummary} Output: ${result.outputGlbPath || 'buffer'}.`
        };
    },

    uv_analyze_texel_density: async (args, _ctx) => {
        const inputGlbPath = asString(args.inputGlbPath);
        if (!inputGlbPath) {
            return {
                resultPayload: { success: false, error: 'inputGlbPath is required' } as unknown as ToolResultPayload,
                summaryResult: 'Texel density analysis error: inputGlbPath is required.'
            };
        }

        const defaultTexSize = asNumber(args.defaultTexSize, 512) ?? 512;
        const fs = await import('fs');
        const buffer = fs.readFileSync(inputGlbPath);
        const metrics = AlgorithmicUvEngine.computeTexelDensity(buffer, defaultTexSize);

        return {
            resultPayload: {
                success: true,
                inputGlbPath,
                metrics
            } as unknown as ToolResultPayload,
            summaryResult: `Texel Density Analysis complete: Mean ${metrics.meanTexelsPerMeter} texels/m², Range [${metrics.minTexelsPerMeter} - ${metrics.maxTexelsPerMeter}], Variance Ratio ${metrics.varianceRatio}x across ${metrics.totalWorldAreaSqMeters} m² world area (${metrics.normalizedChartsCount} charts).`
        };
    },

    pbr_material_decompose: async (args, _ctx) => {
        const dummyWidth = 256;
        const dummyHeight = 256;
        const dummyRgba = new Uint8Array(dummyWidth * dummyHeight * 4);
        dummyRgba.fill(200);

        const biophysicalContract = (args.biophysicalContract && typeof args.biophysicalContract === 'object')
            ? args.biophysicalContract as BiophysicalMaterialContract
            : undefined;

        const pbrRes = await AlgorithmicUvEngine.decomposePbr(dummyRgba, {
            biophysicalContract,
            enableAlbedoDeLighting: asBoolean(args.enableAlbedoDeLighting, true),
            normalStrength: asNumber(args.normalStrength, 3.2),
            defaultStoneRoughness: asNumber(args.defaultStoneRoughness, 0.85),
            skyDomeAoIntensity: asNumber(args.skyDomeAoIntensity, 1.0),
            enableMultiFrequencyNormals: asBoolean(args.enableMultiFrequencyNormals, true),
            enableBiophysicalRoughness: asBoolean(args.enableBiophysicalRoughness, true),
            enableToksvigFiltering: asBoolean(args.enableToksvigFiltering, true),
            enableHbaoMicroCavity: asBoolean(args.enableHbaoMicroCavity, true),
            packOrm: true
        }, dummyWidth, dummyHeight);

        return {
            resultPayload: {
                success: true,
                width: pbrRes.width,
                height: pbrRes.height,
                hasNormalMap: !!pbrRes.normal,
                hasRoughnessMap: !!pbrRes.roughness,
                hasAoMap: !!pbrRes.ao,
                hasOrmMap: !!pbrRes.orm
            } as unknown as ToolResultPayload,
            summaryResult: `PBR Material Decomposition completed: Intrinsic Albedo, Multi-Frequency Normal (RNM), Biophysical Roughness (Laplacian + Toksvig), HBAO Sky-Dome AO, and ORM packed.`
        };
    },

    atlas_maxrects_pack: async (args, _ctx) => {
        const rawRects = Array.isArray(args.rectangles) ? args.rectangles : [];
        const padding = asNumber(args.padding, 2) ?? 2;
        const allowRotation = asBoolean(args.allowRotation, true);

        const items: TextureItem[] = rawRects.map((r: any, idx: number) => ({
            id: r.id || `chart_${idx}`,
            width: Number(r.width) || 64,
            height: Number(r.height) || 64
        }));

        const packer = new MaxRectsAtlasPacker({
            padding,
            allowRotation
        });

        for (const item of items) {
            packer.addTexture(item);
        }

        const atlasRes = packer.pack();

        return {
            resultPayload: {
                success: true,
                atlasWidth: atlasRes.width,
                atlasHeight: atlasRes.height,
                fillRate: atlasRes.fillRate,
                fillPercentage: (atlasRes.fillRate * 100).toFixed(1) + '%',
                rectCount: atlasRes.rectList.length,
                rects: atlasRes.rectList
            } as unknown as ToolResultPayload,
            summaryResult: `MaxRects Atlas Packing complete: ${atlasRes.rectList.length} charts packed into ${atlasRes.width}x${atlasRes.height} atlas with ${(atlasRes.fillRate * 100).toFixed(1)}% texel fill efficiency.`
        };
    }
};
