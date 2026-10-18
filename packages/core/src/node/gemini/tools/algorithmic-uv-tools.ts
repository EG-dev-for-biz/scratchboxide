/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs';
import * as path from 'path';
import type { ToolDeclaration, ToolHandler, ToolHandlerOutcome, ToolResultPayload } from './types';
import { AlgorithmicUvEngine, type UvEngineMode, type BiophysicalMaterialContract, type PbrDecompositionResult } from '../../spatial/AlgorithmicUvEngine';
import { MaxRectsAtlasPacker, type TextureItem } from '../../spatial/TextureAtlasPacker';
import { decodeImageToRgba, sniffImageFormat, type RgbaImage } from '../../image-codec-ffmpeg';
import { encodePng } from '../../texture-processing';

function asString(val: unknown): string | undefined {
    return typeof val === 'string' && val.trim().length > 0 ? val.trim() : undefined;
}

function asBoolean(val: unknown, fallback: boolean): boolean {
    return typeof val === 'boolean' ? val : fallback;
}

function asNumber(val: unknown, fallback?: number): number | undefined {
    return typeof val === 'number' && !isNaN(val) ? val : fallback;
}

/** decodePng handles only 8-bit, non-interlaced grey / RGB / RGBA; names the PNG variants it would mis-decode. */
function unsupportedPngVariant(buf: Buffer): string | undefined {
    if (buf.length < 29 || buf.toString('ascii', 12, 16) !== 'IHDR') return 'PNG has no IHDR chunk';
    const bitDepth = buf[24];
    const colorType = buf[25];
    const interlace = buf[28];
    if (bitDepth !== 8 || ![0, 2, 6].includes(colorType) || interlace !== 0) {
        return `unsupported PNG variant (bit depth ${bitDepth}, colour type ${colorType}, interlace ${interlace}); only 8-bit non-interlaced grey / RGB / RGBA PNGs decode`;
    }
    return undefined;
}

export const ALGORITHMIC_UV_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'algorithmic_uv_unwrap_rewrap',
        description: 'Decode every embedded baseColor texture of a .glb (JPEG, PNG or WebP) and compute PBR maps from its pixels. Geometry and UVs are not modified. Writes a tangent-space normal map and an ORM texture (R = ambient occlusion, G = roughness, B = metalness) as PNG and attaches them to each material\'s empty normalTexture, metallicRoughnessTexture and occlusionTexture slots (KHR_materials_unlit is removed from those materials so the maps are shaded). Optional albedo de-lighting rewrites the baseColor image itself. Reports decoded image sizes and texel counts; any texture that cannot be decoded fails the call.',
        parameters: {
            type: 'OBJECT',
            properties: {
                inputGlbPath: {
                    type: 'STRING',
                    description: 'Path on disk to the input .glb mesh file to unwrap/rewrap.'
                },
                mode: {
                    type: 'STRING',
                    description: 'Engine mode. Only "preserve-100-lock" (geometry and UVs untouched) is implemented; "conformal-reparameterize" fails because no UV reparameterization exists. Defaults to "preserve-100-lock".'
                },
                lithologyProfile: {
                    type: 'STRING',
                    description: 'Lithology profile string or open descriptive prompt (e.g. "classical-travertine", "bedford-limestone", "modern-curtain-wall", "asphalt roadway", "weathered bronze").'
                },
                biophysicalContract: {
                    type: 'OBJECT',
                    description: 'Continuous material contract read by the passes: roughness, metalness, normalStrength, laplacianBurnishFactor, laplacianCavityGritFactor, toksvigVarianceScale, hbaoRadius, hbaoIntensity.'
                },
                autoInducePeriodicity: {
                    type: 'BOOLEAN',
                    description: 'Measure texture periodicity (in pixels) by 1D autocorrelation of the largest decoded baseColor image; when a period is found, KHR_texture_transform tiling is enabled at microDetailScale (default: false).'
                },
                enableAlbedoDeLighting: {
                    type: 'BOOLEAN',
                    description: 'Whether to divide each baseColor texel by a bilateral-filtered luminance shading estimate and write the result back as the baseColor image (default: false).'
                },
                enableHeightStratifiedDeLighting: {
                    type: 'BOOLEAN',
                    description: 'With enableAlbedoDeLighting, additionally lift shading in proportion to the configured canyon elevation (default: false; no effect without enableAlbedoDeLighting).'
                },
                enableMicroDetailTiling: {
                    type: 'BOOLEAN',
                    description: 'Whether to add KHR_texture_transform scale [microDetailScale, microDetailScale] to every texture slot of every material (default: false).'
                },
                microDetailScale: {
                    type: 'NUMBER',
                    description: 'UV tiling factor used by enableMicroDetailTiling / autoInducePeriodicity (default: 32.0).'
                },
                generateNormalMaps: {
                    type: 'BOOLEAN',
                    description: 'Whether to compute a tangent-space normal map from baseColor luminance and attach it as normalTexture (default: true).'
                },
                enableMultiFrequencyNormals: {
                    type: 'BOOLEAN',
                    description: 'Whether to synthesize multi-frequency tangent normal maps (Macro, Meso-Scharr, Micro-Grit) with Reoriented Normal Mapping (RNM) blending (default: true).'
                },
                generateRoughnessMaps: {
                    type: 'BOOLEAN',
                    description: 'Whether to compute a roughness map and attach the ORM texture as metallicRoughnessTexture (default: true).'
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
                    description: 'Whether to compute an ambient occlusion map and attach the ORM texture as occlusionTexture (default: true).'
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
        description: 'Measure real-world metric texel density across all submeshes of a 3D model (.glb), calculating world-space triangle area vs UV area at the real size of each primitive\'s baseColor image (texels per linear meter) and detecting texel density variance.',
        parameters: {
            type: 'OBJECT',
            properties: {
                inputGlbPath: {
                    type: 'STRING',
                    description: 'Path on disk to the input .glb mesh file to analyze.'
                },
                defaultTexSize: {
                    type: 'NUMBER',
                    description: 'Texture resolution in pixels assumed only for primitives without a readable embedded baseColor image (default: 512).'
                }
            },
            required: ['inputGlbPath']
        }
    },
    {
        name: 'pbr_material_decompose',
        description: 'Compute PBR maps from the pixels of one texture image on disk (JPEG, PNG or WebP) and write them as PNG at the image\'s own size: albedo (de-lit when enableAlbedoDeLighting is on, otherwise the decoded pixels), a tangent-space normal map from luminance gradients in the glTF convention (+Y toward the image top), and an ORM texture (R = ambient occlusion, G = roughness, B = the contract\'s constant metalness). Relief is inferred from luminance, so the normal and occlusion maps are estimates, not measured geometry. Returns the three file paths and the decoded width and height; an image that cannot be read or decoded fails the call.',
        parameters: {
            type: 'OBJECT',
            properties: {
                inputImagePath: {
                    type: 'STRING',
                    description: 'Path to the source image: JPEG, PNG (8-bit non-interlaced grey, RGB or RGBA) or WebP (needs ffmpeg). Relative paths resolve against the workspace root.'
                },
                outputDir: {
                    type: 'STRING',
                    description: 'Directory for <name>_albedo.png, <name>_normal.png and <name>_orm.png, created if missing (default: the input image\'s directory).'
                },
                enableAlbedoDeLighting: {
                    type: 'BOOLEAN',
                    description: 'Divide each texel by an edge-aware bilateral estimate of its luminance shading, relative to the mean shading, so shadows lift and highlights drop (default: true). When false the albedo PNG is the decoded image.'
                },
                normalStrength: {
                    type: 'NUMBER',
                    description: 'Gain on luminance gradients for the normal map (default: 3.2; overrides biophysicalContract.normalStrength).'
                },
                defaultStoneRoughness: {
                    type: 'NUMBER',
                    description: 'Base roughness before the variance and curvature terms (default: 0.85; overrides biophysicalContract.roughness). Green-dominant texels are set to 0.40 and dark neutral-grey texels to 0.55 regardless.'
                },
                skyDomeAoIntensity: {
                    type: 'NUMBER',
                    description: 'Ambient occlusion strength (default: 1.0; overrides biophysicalContract.hbaoIntensity).'
                },
                biophysicalContract: {
                    type: 'OBJECT',
                    description: 'Continuous material contract read by the passes: roughness, metalness (ORM blue channel), normalStrength, laplacianBurnishFactor, laplacianCavityGritFactor, toksvigVarianceScale, hbaoRadius, hbaoIntensity.'
                },
                enableMultiFrequencyNormals: {
                    type: 'BOOLEAN',
                    description: 'Blend luminance gradients at 3 px, 1 px (Scharr) and high-pass scales with reoriented normal mapping; false uses a single 3x3 Sobel (default: true).'
                },
                enableBiophysicalRoughness: {
                    type: 'BOOLEAN',
                    description: 'Add local luminance variance and discrete-Laplacian curvature to the base roughness (lower on convex texels, higher on concave); false uses the base roughness alone (default: true).'
                },
                enableHbaoMicroCavity: {
                    type: 'BOOLEAN',
                    description: 'Occlusion from an 8-direction image-space horizon search over a height proxy derived from the normal map; false uses a 4-neighbour luminance cavity term (default: true).'
                },
                enableToksvigFiltering: {
                    type: 'BOOLEAN',
                    description: 'Raise roughness where the 3x3 neighbourhood of normals varies (Toksvig) (default: true).'
                }
            },
            required: ['inputImagePath']
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

        const { outputGlbBuffer, ...payload } = result;
        const failed = result.images.filter(r => r.status === 'failed');
        const a = result.attachments;
        const parts: string[] = [];
        parts.push(failed.length > 0
            ? `Algorithmic UV engine FAILED on ${failed.length} of ${result.images.length} baseColor textures (${failed.slice(0, 5).map(r => `${r.imageIndex !== undefined ? `image ${r.imageIndex}` : `texture ${r.textureIndex}`}: ${r.error}`).join('; ')}${failed.length > 5 ? '; ...' : ''}).`
            : `Algorithmic UV engine completed in ${result.executionTimeMs.toFixed(0)} ms.`);
        parts.push(`Decoded ${result.imagesProcessed} baseColor images, ${result.texelsProcessed.toLocaleString()} texels.`);
        if (result.imagesProcessed > 0) {
            parts.push(`Attached ${a.normalTextures} normal, ${a.metallicRoughnessTextures} metallicRoughness and ${a.occlusionTextures} occlusion textures; baseColor rewritten (de-lit) on ${result.images.filter(r => r.albedoRewritten).length} images${a.unlitRemoved > 0 ? `; KHR_materials_unlit removed from ${a.unlitRemoved} materials` : ''}.`);
        }
        if (a.normalTextures + a.metallicRoughnessTextures + a.occlusionTextures > 0) {
            parts.push('The attached normal, roughness and AO maps are heuristics estimated from the texture\'s own brightness, not measurements.');
        }
        parts.push(`Geometry unchanged: ${result.submeshesProcessed} meshes, ${result.trianglesProcessed} triangles.`);
        if (result.texelDensityMetrics && result.texelDensityMetrics.meanTexelsPerMeter > 0) {
            parts.push(`Texel density: mean ${result.texelDensityMetrics.meanTexelsPerMeter} texels/m (range ${result.texelDensityMetrics.minTexelsPerMeter}-${result.texelDensityMetrics.maxTexelsPerMeter}).`);
        }
        if (result.inducedSpatialProfile) {
            const p = result.inducedSpatialProfile;
            parts.push(p.isPeriodic
                ? `Measured texture period ${p.dominantPeriodPxX}x${p.dominantPeriodPxY} px on image ${p.sourceImageIndex}.`
                : `No texture periodicity found on image ${p.sourceImageIndex}.`);
        }
        if (result.microDetailTilingInjected) parts.push(`KHR_texture_transform tiling x${asNumber(args.microDetailScale, 32.0)} applied.`);
        parts.push(`Output: ${result.outputGlbPath ?? 'buffer'} (${(outputGlbBuffer!.length / 1e6).toFixed(1)} MB).`);

        return {
            resultPayload: { ...payload, outputGlbBytes: outputGlbBuffer!.length } as unknown as ToolResultPayload,
            status: result.success ? 'completed' : 'failed',
            summaryResult: parts.join(' ')
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
            summaryResult: `Texel Density Analysis complete: Mean ${metrics.meanTexelsPerMeter} texels/m, Range [${metrics.minTexelsPerMeter} - ${metrics.maxTexelsPerMeter}], Variance Ratio ${metrics.varianceRatio}x across ${metrics.totalWorldAreaSqMeters} m² world area (${metrics.normalizedChartsCount} charts).`
        };
    },

    pbr_material_decompose: async (args, ctx) => {
        const startTime = performance.now();
        const requestedPath = asString(args.inputImagePath);
        const fail = (error: string): ToolHandlerOutcome => ({
            resultPayload: { success: false, inputImagePath: requestedPath, error },
            status: 'failed',
            summaryResult: `PBR material decomposition FAILED: ${error}`
        });
        if (!requestedPath) return fail('inputImagePath is required (a JPEG, PNG or WebP file).');

        const baseDir = ctx?.workspaceRoot || process.cwd();
        const inputImagePath = path.resolve(baseDir, requestedPath);
        let encoded: Buffer;
        try {
            encoded = await fs.promises.readFile(inputImagePath);
        } catch (e) {
            return fail(`could not read ${inputImagePath}: ${(e as Error).message}`);
        }
        const format = sniffImageFormat(encoded);
        if (format === 'unknown') return fail(`${inputImagePath} is not a JPEG, PNG or WebP image.`);
        const pngProblem = format === 'png' ? unsupportedPngVariant(encoded) : undefined;
        if (pngProblem) return fail(`${inputImagePath}: ${pngProblem}.`);

        let decoded: RgbaImage;
        try {
            decoded = await decodeImageToRgba(encoded);
        } catch (e) {
            return fail(`could not decode ${inputImagePath}: ${(e as Error).message}`);
        }
        const { width, height } = decoded;
        if (!(width > 0 && height > 0) || decoded.rgba.length !== width * height * 4) {
            return fail(`decoder returned ${decoded.rgba.length} bytes for a ${width}x${height} image.`);
        }

        // decomposePbr reads only the contract when one is given, so the explicit scalar arguments are folded into it.
        const contractArg = (args.biophysicalContract && typeof args.biophysicalContract === 'object')
            ? args.biophysicalContract as BiophysicalMaterialContract
            : {};
        const biophysicalContract: BiophysicalMaterialContract = {
            ...contractArg,
            roughness: asNumber(args.defaultStoneRoughness) ?? contractArg.roughness ?? 0.85,
            normalStrength: asNumber(args.normalStrength) ?? contractArg.normalStrength ?? 3.2,
            hbaoIntensity: asNumber(args.skyDomeAoIntensity) ?? contractArg.hbaoIntensity ?? 1.0
        };
        const enableAlbedoDeLighting = asBoolean(args.enableAlbedoDeLighting, true);

        let pbr: PbrDecompositionResult;
        try {
            pbr = await AlgorithmicUvEngine.decomposePbr(
                new Uint8Array(decoded.rgba.buffer, decoded.rgba.byteOffset, decoded.rgba.byteLength), {
                    biophysicalContract,
                    enableAlbedoDeLighting,
                    enableMultiFrequencyNormals: asBoolean(args.enableMultiFrequencyNormals, true),
                    enableBiophysicalRoughness: asBoolean(args.enableBiophysicalRoughness, true),
                    enableToksvigFiltering: asBoolean(args.enableToksvigFiltering, true),
                    enableHbaoMicroCavity: asBoolean(args.enableHbaoMicroCavity, true),
                    packOrm: true
                }, width, height);
        } catch (e) {
            return fail(`decomposition of ${inputImagePath} failed: ${(e as Error).message}`);
        }
        if (!pbr.normal || !pbr.orm) return fail('the decomposition returned no normal or ORM map.');

        // decomposePbr's normals point +Y toward the image bottom; glTF tangent space has +Y toward the image top.
        const normal = Buffer.from(pbr.normal);
        for (let i = 1; i < normal.length; i += 4) normal[i] = 255 - normal[i];
        const asBuffer = (u: Uint8Array) => Buffer.from(u.buffer, u.byteOffset, u.byteLength);

        const outputDir = path.resolve(baseDir, asString(args.outputDir) ?? path.dirname(inputImagePath));
        const stem = path.basename(inputImagePath, path.extname(inputImagePath));
        const albedoPath = path.join(outputDir, `${stem}_albedo.png`);
        const normalPath = path.join(outputDir, `${stem}_normal.png`);
        const ormPath = path.join(outputDir, `${stem}_orm.png`);
        try {
            await fs.promises.mkdir(outputDir, { recursive: true });
            await fs.promises.writeFile(albedoPath, encodePng(width, height, asBuffer(pbr.albedo)));
            await fs.promises.writeFile(normalPath, encodePng(width, height, normal));
            await fs.promises.writeFile(ormPath, encodePng(width, height, asBuffer(pbr.orm)));
        } catch (e) {
            return fail(`could not write the maps to ${outputDir}: ${(e as Error).message}`);
        }

        const executionTimeMs = Math.round(performance.now() - startTime);
        return {
            resultPayload: {
                success: true,
                inputImagePath,
                format,
                width,
                height,
                albedoDeLit: enableAlbedoDeLighting,
                albedoPath,
                normalPath,
                ormPath,
                mapProvenance: pbr.mapProvenance,
                executionTimeMs
            },
            status: 'completed',
            summaryResult: `Decomposed ${path.basename(inputImagePath)} (${width}x${height} ${format.toUpperCase()}) in ${executionTimeMs} ms. Wrote albedo ${enableAlbedoDeLighting ? '(de-lit)' : '(decoded pixels, de-lighting off)'} to ${albedoPath}, normal map (glTF, +Y up) to ${normalPath}, ORM (R = AO, G = roughness, B = metalness) to ${ormPath}. The normal, roughness and AO maps are heuristics estimated from the image's own brightness (gradients, curvature, colour thresholds), not measurements; metalness is the contract constant.`
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
