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
import * as os from 'os';
import type { ToolDeclaration, ToolHandler, ToolResultPayload } from './types';
import {
    NativeMaterialPbrService,
    PBR_50_ARCHETYPE_CATALOG,
    PBR_DESCRIPTOR_REQUIRED_FIELDS,
    completeMaterialDescriptor,
    type NativePbrTextureSet
} from '../../3d-engine/native-material-pbr-service';
import { AdaptiveMaterialPbrService } from '../../3d-engine/adaptive-material-pbr-service';
import { AdaptiveUvOrchestrator, type PartMaterialAssignment } from '../../3d-engine/adaptive-uv-orchestrator';
import { AdaptivePbrMaterialSpecError } from '../../3d-engine/adaptive-pbr-errors';
import { GltfBinaryPacker } from '../../3d-engine/gltf-binary-packer';
import { MaterialXService } from '../../3d-engine/materialx-service';
import { UsdzPacker } from '../../3d-engine/usdz-packer';
import type { ContinuousMaterialDescriptor } from '../../../common/adaptive-material-types';

function asString(val: unknown): string | undefined {
    return typeof val === 'string' && val.trim().length > 0 ? val.trim() : undefined;
}

function asNumber(val: unknown, fallback?: number): number | undefined {
    return typeof val === 'number' && !isNaN(val) ? val : fallback;
}

function parseResolution(res: unknown, defaultDim = 2048): { width: number; height: number } {
    if (typeof res === 'number' && res > 0) {
        return { width: Math.round(res), height: Math.round(res) };
    }
    if (typeof res === 'string') {
        const norm = res.trim().toUpperCase();
        switch (norm) {
            case '1K':
                return { width: 1024, height: 1024 };
            case '2K':
                return { width: 2048, height: 2048 };
            case '4K':
                return { width: 4096, height: 4096 };
            case '8K':
                return { width: 8192, height: 8192 };
            case '12K':
                return { width: 12288, height: 12288 };
            default: {
                const match = norm.match(/^(\d+)(?:X(\d+))?$/);
                if (match) {
                    const w = parseInt(match[1], 10);
                    const h = match[2] ? parseInt(match[2], 10) : w;
                    return { width: w, height: h };
                }
            }
        }
    }
    return { width: defaultDim, height: defaultDim };
}

/**
 * The base for a descriptor given without a named example: its own required fields, the rest neutral texture
 * parameters (`completeMaterialDescriptor`). Throws AdaptivePbrMaterialSpecError naming what is missing.
 */
function descriptorWithoutExample(raw: any, where: string): ContinuousMaterialDescriptor {
    const r = raw && typeof raw === 'object' ? raw : {};
    const albedo = Array.isArray(r.albedoLinear) && r.albedoLinear.length >= 3 ? [Number(r.albedoLinear[0]), Number(r.albedoLinear[1]), Number(r.albedoLinear[2])] as [number, number, number] : undefined;
    return completeMaterialDescriptor({
        albedoLinear: albedo,
        conduction: typeof r.conduction === 'number' ? r.conduction : undefined,
        roughnessBaseline: typeof r.roughnessBaseline === 'number' ? r.roughnessBaseline : undefined
    }, where);
}

function sanitizeDescriptor(raw: any, fallback: ContinuousMaterialDescriptor): ContinuousMaterialDescriptor {
    if (!raw || typeof raw !== 'object') return fallback;

    const albedoLinear: [number, number, number] = Array.isArray(raw.albedoLinear) && raw.albedoLinear.length >= 3
        ? [Number(raw.albedoLinear[0]), Number(raw.albedoLinear[1]), Number(raw.albedoLinear[2])]
        : fallback.albedoLinear;

    const secondaryAlbedo: [number, number, number] = Array.isArray(raw.secondaryAlbedo) && raw.secondaryAlbedo.length >= 3
        ? [Number(raw.secondaryAlbedo[0]), Number(raw.secondaryAlbedo[1]), Number(raw.secondaryAlbedo[2])]
        : (fallback.secondaryAlbedo ?? [albedoLinear[0] * 0.72, albedoLinear[1] * 0.72, albedoLinear[2] * 0.72]);

    return {
        albedoLinear,
        secondaryAlbedo,
        secondaryWeight: typeof raw.secondaryWeight === 'number' ? raw.secondaryWeight : (fallback.secondaryWeight ?? 0.25),
        conduction: typeof raw.conduction === 'number' ? raw.conduction : fallback.conduction,
        roughnessBaseline: typeof raw.roughnessBaseline === 'number' ? raw.roughnessBaseline : fallback.roughnessBaseline,
        microPorosity: typeof raw.microPorosity === 'number' ? raw.microPorosity : (fallback.microPorosity ?? 0.20),
        normalStrength: typeof raw.normalStrength === 'number' ? raw.normalStrength : (fallback.normalStrength ?? 1.50),
        fissureScale: typeof raw.fissureScale === 'number' ? raw.fissureScale : (fallback.fissureScale ?? 8.0),
        fissureDepth: typeof raw.fissureDepth === 'number' ? raw.fissureDepth : (fallback.fissureDepth ?? 0.25),
        fbmOctaves: typeof raw.fbmOctaves === 'number' ? raw.fbmOctaves : (fallback.fbmOctaves ?? 4.0),
        fbmGain: typeof raw.fbmGain === 'number' ? raw.fbmGain : (fallback.fbmGain ?? 0.50),
        cellularWeight: typeof raw.cellularWeight === 'number' ? raw.cellularWeight : (fallback.cellularWeight ?? 0.30),
        graininess: typeof raw.graininess === 'number' ? raw.graininess : (fallback.graininess ?? 0.15),
        anisotropyStrength: typeof raw.anisotropyStrength === 'number' ? raw.anisotropyStrength : (fallback.anisotropyStrength ?? 0.0),
        anisotropyAngleRad: typeof raw.anisotropyAngleRad === 'number' ? raw.anisotropyAngleRad : (fallback.anisotropyAngleRad ?? 0.0),
        aoStrength: typeof raw.aoStrength === 'number' ? raw.aoStrength : (fallback.aoStrength ?? 1.0)
    };
}

export const PBR_MATERIAL_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'pbr_synthesize_material',
        description: 'Synthesizes procedural PBR texture maps (albedo, tangent normal, packed ORM, height; plus separate roughness / metallic / AO for MaterialX and USDZ) from a continuous 20-float material descriptor, in the native C++20 kernel (scratchbox_pbr_manifold.hpp) compiled with clang++. There is no fallback synthesizer: if the kernel cannot compile or run, the call fails with that error. Timings in the result are measured. With targetMeshPath the maps are applied to the mesh by per-triangle box projection and the textured GLB is written.',
        parameters: {
            type: 'OBJECT',
            properties: {
                resolution: {
                    type: 'STRING',
                    description: 'Target texture resolution. Supported standard tiers: "1K" (1024), "2K" (2048), "4K" (4096), "8K" (8192), "12K" (12288x12288). Default: "2K". With targetMeshPath each set is capped at 4096 px and must be square; a larger request fails rather than being reduced.',
                    enum: ['1K', '2K', '4K', '8K', '12K']
                },
                width: {
                    type: 'NUMBER',
                    description: 'Optional custom horizontal pixel dimension override (e.g. 2048, 4096, 12288).'
                },
                height: {
                    type: 'NUMBER',
                    description: 'Optional custom vertical pixel dimension override (e.g. 2048, 4096, 12288).'
                },
                archetype: {
                    type: 'STRING',
                    description: 'Optional baseline biophysical archetype: a catalog key or display name, exactly (e.g. "carrara_marble", "weathered_concrete", "brushed_titanium", "corten_steel", "solar_low_e_glass", "indiana_limestone", "polished_brass", "quartersawn_walnut", "wrought_iron"; pbr_get_material_catalog lists all 50). An unknown name fails with the key list (a fragment of exactly one key, e.g. "titanium", resolves to it); no other material is substituted. It is only a shortcut to the descriptor of that example; with neither archetype nor descriptor the call fails (no material is assumed).'
                },
                descriptor: {
                    type: 'OBJECT',
                    description: 'The material, as continuous parameters in R^20: fill them from the user\'s description of the surface (any material, including ones no example covers). Without an archetype it must give albedoLinear, conduction and roughnessBaseline; over an archetype it overrides that example\'s fields. Includes albedoLinear ([r,g,b] 0..1), conduction (0.0 dielectric vs 1.0 metallic), roughnessBaseline (0.02..0.98), microPorosity, normalStrength, fissureScale, fissureDepth, fbmOctaves, fbmGain, cellularWeight, graininess, anisotropyStrength, anisotropyAngleRad, aoStrength.'
                },
                format: {
                    type: 'STRING',
                    description: 'Output format: "png_pack" (saves standalone PNG texture maps), "glb" (packs standard binary glTF 2.0 with displaced plane mesh), "raw_buffer" (saves raw uncompressed binaries), "materialx" (outputs OpenPBR v1.38 .mtlx document + PNG textures for VFX/Houdini/Maya/UE5), or "usdz" (packs Pixar/Apple 64-byte aligned USDZ archive). Default: "png_pack".',
                    enum: ['png_pack', 'glb', 'raw_buffer', 'materialx', 'usdz']
                },
                uvTilingX: {
                    type: 'NUMBER',
                    description: 'Horizontal UV texture coordinate repetition/tiling multiplier (default: 1.0).'
                },
                uvTilingY: {
                    type: 'NUMBER',
                    description: 'Vertical UV texture coordinate repetition/tiling multiplier (default: 1.0).'
                },
                outputDir: {
                    type: 'STRING',
                    description: 'Destination directory on disk to save the synthesized assets. Defaults to system temporary directory if omitted.'
                },
                outputFileName: {
                    type: 'STRING',
                    description: 'Base file name prefix for generated texture maps or GLB file (default: "pbr_material").'
                },
                seed: {
                    type: 'NUMBER',
                    description: 'Procedural noise RNG seed (default: 42).'
                },
                planeWidthMeters: {
                    type: 'NUMBER',
                    description: 'Metric plane width in meters when format is "glb" or "usdz" (default: 2.0).'
                },
                displacementScaleMeters: {
                    type: 'NUMBER',
                    description: 'Surface metric relief displacement amplitude in meters when format is "glb" (default: 0.04).'
                },
                targetMeshPath: {
                    type: 'STRING',
                    description: 'Optional absolute or relative path to a target 3D model (.glb) to texture. The synthesized maps are written into a new GLB (outputDir / outputFileName, default <mesh>_adaptive_pbr.glb) as embedded PNG images with a REPEAT sampler and one material per distinct assignment. For "height_blended_triplanar" and "carrier_conformal_sheet" the maps are applied by per-triangle dominant-axis box projection in world metres (UV = metres along the two non-dominant world axes / tile size; vertices are split where the axis changes): the result names this as appliedMethod, because a triplanar shader blend or a conformal sheet is not what runs. Existing materials of the mesh are replaced, TANGENT is removed (it belongs to the old UVs), COLOR_n is removed unless preserveVertexColors, and TEXCOORD_0 is replaced unless preserveExistingUvs.'
                },
                partMaterials: {
                    type: 'ARRAY',
                    description: 'With targetMeshPath: give different parts different materials. Each entry names parts and their material; parts no entry names take the request-level archetype/descriptor (or indiana_limestone if none is given, which the result states). Names are matched exactly, never loosely: a string is the exact name of a glTF node or of a glTF mesh as the scene lists them (every node with that name or that mesh), a number is a node index, and naming a group node names everything below it (a more specific entry wins over a group entry). A name that is not in the scene fails with the list of real names, so look at the scene first. One texture set is synthesized per distinct (archetype, descriptor) and shared by every part using it; at most 12 distinct sets, 4096 px per set and 64 Mtexels over all sets per call.',
                    items: {
                        type: 'OBJECT',
                        properties: {
                            nodes: {
                                type: 'ARRAY',
                                description: 'Exact node names, exact mesh names, or node indices (numbers) of the parts this entry covers.',
                                items: { type: 'STRING', description: 'A node name or mesh name exactly as listed in the scene (a decimal index such as "7" is read as node 7 only when no node or mesh has that exact name).' }
                            },
                            materialArchetype: {
                                type: 'STRING',
                                description: 'Catalog archetype key or display name for these parts, exact (e.g. "polished_brass", "quartersawn_walnut", "wrought_iron"). Omit to use the request-level material.'
                            },
                            descriptor: {
                                type: 'OBJECT',
                                description: 'Continuous descriptor fields for these parts. Over materialArchetype they override its fields; without materialArchetype they must give albedoLinear ([r,g,b]), conduction and roughnessBaseline.'
                            },
                            tileSizeMeters: {
                                type: 'NUMBER',
                                description: 'Edge length of one texture tile on these parts, in metres. Omit and a size is derived from the parts and the descriptor, and reported as derived.'
                            }
                        },
                        required: ['nodes']
                    }
                },
                tileSizeMeters: {
                    type: 'NUMBER',
                    description: 'With targetMeshPath: edge length of one texture tile in metres, for every part whose partMaterials entry gives none. Omit and a size is derived per material group from the median part size and the descriptor\'s fissureScale, and reported as derived.'
                },
                preserveExistingUvs: {
                    type: 'BOOLEAN',
                    description: 'With targetMeshPath: keep each primitive\'s own TEXCOORD_0 and write the box-projection UVs to the next free TEXCOORD_n (the material then reads that set). Default false: TEXCOORD_0 is replaced.'
                },
                preserveVertexColors: {
                    type: 'BOOLEAN',
                    description: 'With targetMeshPath: keep COLOR_n vertex colours on the textured primitives. Default false: they are removed, because glTF multiplies them into the base colour and would tint the new material.'
                },
                domain: {
                    type: 'STRING',
                    description: 'High-level semantic domain classification: "organic" (living anatomy, skin, digits, characters) or "nonorganic" (hard-surface CAD, stone architecture, vehicles).',
                    enum: ['organic', 'nonorganic']
                },
                uvStrategy: {
                    type: 'STRING',
                    description: 'Strategy override, default "auto" (the topology probe recommends one). What each really does with targetMeshPath: "height_blended_triplanar" and "carrier_conformal_sheet" synthesize the material and apply it by per-triangle box projection (the result names method box_projection_uv; the triplanar blend / conformal sheet themselves are not run). "recipe_hybrid" keeps the mesh\'s own UVs and textures and adds per-vertex recipe attributes (one primitive per mesh, TEXCOORD_0 required). "elevation_stratified_conformal" decomposes the mesh\'s embedded baseColor images into albedo / normal / ORM. The last two do not synthesize a material, so archetype, descriptor, partMaterials, tileSizeMeters and the preserve flags are refused for them rather than ignored.',
                    enum: ['auto', 'carrier_conformal_sheet', 'elevation_stratified_conformal', 'height_blended_triplanar', 'recipe_hybrid']
                },
                solarCoordinates: {
                    type: 'OBJECT',
                    description: 'For solar inverse de-lighting, used only by "elevation_stratified_conformal" (others list it under ignoredOptions): { latitude: number, longitude: number, timestampIso: string }, the place and capture instant (date, time of day and UTC offset) whose sun lit the source imagery (all three are required; no date or time is assumed). The sky-to-sun light ratio is measured from the texture itself; when the texture cannot pin it down the pass changes nothing and reports why.'
                },
                carrierSpinePoints: {
                    type: 'ARRAY',
                    description: 'Ordered 3D skeletal spine points [[x, y, z], ...] for a carrier-frame conformal unfolding. No strategy implements that unfolding, so the result lists this under ignoredOptions when given.'
                },
                seamPaddingPx: {
                    type: 'NUMBER',
                    description: 'Gutter dilation padding in pixels around UV island borders. Box projection has no UV islands, so it does not use this; the result lists it under ignoredOptions when given.'
                }
            }
        }
    },
    {
        name: 'pbr_probe_mesh_topology',
        description: 'Measures a .glb (mesh / primitive / triangle counts, world bounds, embedded images) and reports which uvStrategy pbr_synthesize_material would pick for it, the threshold rule that picked it with the measured values, the method that really runs for that strategy, and what it does about UV seams. The classification is a rule outcome, not a shape analysis.',
        parameters: {
            type: 'OBJECT',
            properties: {
                meshPath: {
                    type: 'STRING',
                    description: 'Absolute or relative path to the .glb mesh file to inspect.'
                },
                domain: {
                    type: 'STRING',
                    description: 'Optional domain hint: "organic" or "nonorganic".',
                    enum: ['organic', 'nonorganic']
                }
            },
            required: ['meshPath']
        }
    },
    {
        name: 'pbr_get_material_catalog',
        description: 'Lists 50 named example material descriptors (reference points in the continuous 20-float material space, with their full descriptor). They are examples, not a closed list: any surface is described by filling a descriptor from the user\'s words, optionally starting from the nearest example.',
        parameters: {
            type: 'OBJECT',
            properties: {
                query: {
                    type: 'STRING',
                    description: 'Optional free text that narrows the list to examples whose key, name, description or display group contains it (e.g. "marble", "rust").'
                },
                category: {
                    type: 'STRING',
                    description: 'Older name for query.'
                }
            }
        }
    },
    {
        name: 'pbr_interpolate_materials',
        description: 'Linearly interpolates (lerp) two continuous material descriptors in the continuous parameter space R^20 with parameter alpha in [0, 1]. Passes the Alien Planet Test by creating continuous gradations between arbitrary earthly or extraterrestrial metamaterials.',
        parameters: {
            type: 'OBJECT',
            properties: {
                materialA: {
                    type: 'STRING',
                    description: 'First material archetype key, name, or JSON continuous descriptor.'
                },
                materialB: {
                    type: 'STRING',
                    description: 'Second material archetype key, name, or JSON continuous descriptor.'
                },
                alpha: {
                    type: 'NUMBER',
                    description: 'Continuous blend ratio [0.0..1.0] between materialA (0.0) and materialB (1.0).'
                },
                synthesize: {
                    type: 'BOOLEAN',
                    description: 'Whether to synthesize the interpolated material immediately into texture maps (default: false).'
                },
                resolution: {
                    type: 'STRING',
                    description: 'Target texture resolution if synthesize is true ("1K", "2K", "4K", "8K", "12K").',
                    enum: ['1K', '2K', '4K', '8K', '12K']
                },
                outputDir: {
                    type: 'STRING',
                    description: 'Destination directory on disk if synthesize is true.'
                }
            },
            required: ['materialA', 'materialB', 'alpha']
        }
    }
];

export const pbrMaterialHandlers: Record<string, ToolHandler> = {
    pbr_probe_mesh_topology: async (args, _ctx) => {
        const meshPath = asString(args.meshPath);
        if (!meshPath) {
            throw new Error('pbr_probe_mesh_topology requires meshPath argument.');
        }
        const domain = asString(args.domain) as any;
        const probeResult = AdaptiveUvOrchestrator.probeTopology(meshPath, domain);
        return {
            resultPayload: probeResult as unknown as ToolResultPayload,
            summaryResult: `Probed ${meshPath}: ${probeResult.rationale} Seams: ${probeResult.seams}`
        };
    },

    pbr_synthesize_material: async (args, _ctx) => {
        const startTime = performance.now();
        const service = new NativeMaterialPbrService();

        // 1. Resolve dimensions
        const resParsed = parseResolution(args.resolution, 2048);
        const width = asNumber(args.width, resParsed.width)!;
        const height = asNumber(args.height, resParsed.height)!;
        const seed = asNumber(args.seed, 42)!;
        const format = (asString(args.format) || 'png_pack').toLowerCase();

        // Target mesh adaptive routing
        if (args.targetMeshPath) {
            const meshPath = asString(args.targetMeshPath)!;
            const domain = asString(args.domain) as any;
            const uvStrategy = asString(args.uvStrategy) as any;
            const outDir = asString(args.outputDir) || path.dirname(meshPath);
            fs.mkdirSync(outDir, { recursive: true });
            const filePrefix = asString(args.outputFileName) || `${path.basename(meshPath, path.extname(meshPath))}_adaptive_pbr`;
            const outPath = path.join(outDir, `${filePrefix}.glb`);
            if (width !== height) {
                throw new AdaptivePbrMaterialSpecError(`With targetMeshPath the texture is applied as a square tile; width ${width} and height ${height} differ. Give one resolution.`, { width, height });
            }
            const archetype = args.archetype === undefined || args.archetype === null || args.archetype === ''
                ? undefined
                : (typeof args.archetype === 'number' ? args.archetype : asString(args.archetype));

            const adaptiveResult = await AdaptiveUvOrchestrator.applyAdaptivePbr({
                inputGlbPath: meshPath,
                domain,
                strategy: uvStrategy,
                outputPath: outPath,
                resolutionPx: args.resolution !== undefined || args.width !== undefined || args.height !== undefined ? width : undefined,
                seed: asNumber(args.seed),
                materialArchetype: archetype,
                continuousDescriptor: args.descriptor as any,
                tileSizeMeters: asNumber(args.tileSizeMeters),
                partMaterials: args.partMaterials as PartMaterialAssignment[] | undefined,
                preserveExistingUvs: args.preserveExistingUvs === true,
                preserveVertexColors: args.preserveVertexColors === true,
                formats: format === 'materialx' ? ['glb', 'materialx'] : format === 'usdz' ? ['glb', 'usdz'] : ['glb'],
                solarDelighting: args.solarCoordinates ? {
                    latitude: (args.solarCoordinates as any).latitude,
                    longitude: (args.solarCoordinates as any).longitude,
                    timestampIso: (args.solarCoordinates as any).timestampIso
                } : undefined,
                carrierSpinePoints: Array.isArray(args.carrierSpinePoints) ? args.carrierSpinePoints as [number, number, number][] : undefined,
                gutterPaddingPx: asNumber(args.seamPaddingPx, undefined)
            });

            const toolIgnored = ['uvTilingX', 'uvTilingY', 'planeWidthMeters', 'displacementScaleMeters']
                .filter(k => args[k] !== undefined);
            if (format === 'raw_buffer') toolIgnored.push('format=raw_buffer');
            const ignoredOptions = [...adaptiveResult.ignoredOptions, ...toolIgnored];
            const method = adaptiveResult.appliedMethod;
            const box = adaptiveResult.boxProjection;
            const elapsedMs = Math.round(performance.now() - startTime);
            const outputBytes = adaptiveResult.glbBuffer?.length ?? 0;

            const seams = AdaptiveUvOrchestrator.describeMethod(adaptiveResult.appliedStrategy).seams;
            const strategySentence = method.differsFromStrategy
                ? `Method run: ${method.method}. Strategy ${adaptiveResult.appliedStrategy} (${args.uvStrategy && args.uvStrategy !== 'auto' ? 'requested' : `picked by the routing rule: ${adaptiveResult.topology.routingRule}`}) was NOT run as such: ${method.note}`
                : `Applied ${method.method} for strategy ${adaptiveResult.appliedStrategy}: ${method.note} Seams: ${seams}`;
            let detail = '';
            if (box) {
                const r = box.report;
                detail = ` Textured ${r.projectedNodes} parts / ${r.projectedPrimitives} primitives / ${r.triangles} triangles with ${box.textureSets.length} texture set(s) [${box.textureSets.map(t => `${t.label}: ${t.archetypeKey ?? 'custom'} ${t.resolutionPx}px via ${t.synthesizer}`).join('; ')}]; ${r.verticesBefore} -> ${r.verticesAfter} vertices (split per projection axis); ${r.materialsCreated} material(s), ${r.imagesEmbedded} embedded PNG(s). Groups: ${box.groups.map(g => `${g.name} -> ${g.textureSet}, tile ${g.tileSize.meters.toPrecision(3)} m (${g.tileSize.source})`).join('; ')}.`
                    + (box.inferred.length ? ` Inferred or defaulted (${box.inferred.length}, listed in the result): ${box.inferred.slice(0, 3).join(' | ')}${box.inferred.length > 3 ? ' | ...' : ''}.` : '')
                    + (r.skippedNonTrianglePrimitives.length ? ` Left untouched, not triangle lists: ${r.skippedNonTrianglePrimitives.length} primitive(s).` : '');
            }
            if (ignoredOptions.length) detail += ` Not used by this method: ${ignoredOptions.join(', ')}.`;

            return {
                resultPayload: {
                    appliedStrategy: adaptiveResult.appliedStrategy,
                    appliedMethod: method,
                    ignoredOptions,
                    domainClassification: adaptiveResult.domainClassification,
                    topology: adaptiveResult.topology,
                    seams,
                    boxProjection: box,
                    outputFiles: adaptiveResult.outputFiles,
                    outputBytes,
                    executionTimeMs: elapsedMs
                } as unknown as ToolResultPayload,
                summaryResult: `${strategySentence}${detail} Output: ${outPath} (${(outputBytes / 1048576).toFixed(2)} MB, ${elapsedMs}ms).`
            };
        }

        // 2. Resolve continuous descriptor
        const archetypeInput = args.archetype !== undefined && args.archetype !== null && args.archetype !== ''
            ? (typeof args.archetype === 'number' ? args.archetype : asString(args.archetype))
            : undefined;
        let baseDesc: ContinuousMaterialDescriptor;
        let archetypeKey = 'custom_manifold';
        let materialSource: 'archetype' | 'archetype_with_descriptor_overrides' | 'descriptor';

        if (archetypeInput !== undefined) {
            // A named example is a convenience lookup for a descriptor. Unknown names throw PbrUnknownArchetypeError
            // listing the valid keys; nothing is substituted.
            const resolved = service.resolveArchetype(archetypeInput);
            baseDesc = service.getAnchorDescriptor(resolved.archetypeId);
            archetypeKey = resolved.key;
            materialSource = args.descriptor ? 'archetype_with_descriptor_overrides' : 'archetype';
        } else {
            // No material is assumed: the descriptor's required fields come from the caller (read from the user's words).
            baseDesc = descriptorWithoutExample(args.descriptor, 'pbr_synthesize_material');
            materialSource = 'descriptor';
        }

        const descriptor = sanitizeDescriptor(args.descriptor, baseDesc);

        // 3. Resolve target directory
        const outDir = asString(args.outputDir) || fs.mkdtempSync(path.join(os.tmpdir(), 'sbox_pbr_synth_'));
        fs.mkdirSync(outDir, { recursive: true });
        const filePrefix = asString(args.outputFileName) || `${archetypeKey}_${width}x${height}`;

        // 4. Native C++20 synthesis (a compile or run failure throws NativePbrSynthesisError; there is no substitute)
        const pbrResult: NativePbrTextureSet = await service.synthesizeContinuousManifoldPbr(descriptor, {
            width,
            height,
            seed,
            outputDir: outDir,
            saveRawBuffers: format === 'raw_buffer'
        });

        const writtenFiles: Record<string, string> = {};
        let encodeMs = 0;

        // 5. Handle output formats
        if (format === 'png_pack' || format === 'glb' || format === 'materialx' || format === 'usdz') {
            // Only the maps that are written are encoded; the deflate runs off the main thread (encodePngAsync)
            const separateChannels = format === 'materialx' || format === 'usdz';
            const greyToRgba = (rgb: Buffer): Buffer => {
                const out = Buffer.alloc(width * height * 4);
                for (let i = 0; i < width * height; i++) {
                    const v = rgb[i * 3];
                    out[i * 4] = v; out[i * 4 + 1] = v; out[i * 4 + 2] = v; out[i * 4 + 3] = 255;
                }
                return out;
            };
            const encodeStart = performance.now();
            const png = (rgba: Buffer) => AdaptiveMaterialPbrService.encodePngAsync(rgba, width, height);
            const [albedoPng, normalPng, ormPng, heightPng] = await Promise.all([
                png(pbrResult.albedoRgba), png(pbrResult.normalRgba), png(pbrResult.ormRgba), png(greyToRgba(pbrResult.heightRgb))
            ]);
            const [roughnessPng, metallicPng, aoPng] = separateChannels
                ? await Promise.all([png(greyToRgba(pbrResult.roughnessRgb)), png(greyToRgba(pbrResult.metallicRgb)), png(greyToRgba(pbrResult.aoRgb))])
                : [undefined, undefined, undefined];
            encodeMs = Math.round(performance.now() - encodeStart);

            const albedoPath = path.join(outDir, `${filePrefix}_albedo.png`);
            const normalPath = path.join(outDir, `${filePrefix}_normal.png`);
            const ormPath = path.join(outDir, `${filePrefix}_orm.png`);
            const heightPath = path.join(outDir, `${filePrefix}_height.png`);

            fs.writeFileSync(albedoPath, albedoPng);
            fs.writeFileSync(normalPath, normalPng);
            fs.writeFileSync(ormPath, ormPng);
            fs.writeFileSync(heightPath, heightPng);

            writtenFiles.albedo = albedoPath;
            writtenFiles.normal = normalPath;
            writtenFiles.orm = ormPath;
            writtenFiles.height = heightPath;

            if (roughnessPng && metallicPng && aoPng) {
                const roughnessPath = path.join(outDir, `${filePrefix}_roughness.png`);
                const metallicPath = path.join(outDir, `${filePrefix}_metallic.png`);
                const aoPath = path.join(outDir, `${filePrefix}_ao.png`);
                fs.writeFileSync(roughnessPath, roughnessPng);
                fs.writeFileSync(metallicPath, metallicPng);
                fs.writeFileSync(aoPath, aoPng);
                writtenFiles.roughness = roughnessPath;
                writtenFiles.metallic = metallicPath;
                writtenFiles.ao = aoPath;
            }

            if (format === 'materialx') {
                const mtlxPath = path.join(outDir, `${filePrefix}.mtlx`);
                MaterialXService.exportMaterialX({
                    materialName: `${archetypeKey}_PBR_Material`,
                    descriptor,
                    outputPath: mtlxPath,
                    uvTiling: {
                        u: asNumber(args.uvTilingX, 1.0)!,
                        v: asNumber(args.uvTilingY, 1.0)!
                    },
                    textures: {
                        albedoFileName: `${filePrefix}_albedo.png`,
                        normalFileName: `${filePrefix}_normal.png`,
                        ormFileName: `${filePrefix}_orm.png`,
                        roughnessFileName: `${filePrefix}_roughness.png`,
                        metallicFileName: `${filePrefix}_metallic.png`,
                        aoFileName: `${filePrefix}_ao.png`,
                        heightFileName: `${filePrefix}_height.png`
                    }
                });
                writtenFiles.materialx = mtlxPath;
            } else if (format === 'usdz') {
                const usdzPath = path.join(outDir, `${filePrefix}.usdz`);
                UsdzPacker.packMaterialUsdz({
                    materialName: `${archetypeKey}_PBR_Material`,
                    descriptor,
                    albedoPng,
                    normalPng,
                    roughnessPng: roughnessPng!,
                    metallicPng: metallicPng!,
                    aoPng: aoPng!,
                    ormPng,
                    heightPng,
                    outputPath: usdzPath,
                    planeWidthMeters: asNumber(args.planeWidthMeters, 2.0),
                    uvTiling: {
                        u: asNumber(args.uvTilingX, 1.0)!,
                        v: asNumber(args.uvTilingY, 1.0)!
                    }
                });
                writtenFiles.usdz = usdzPath;
            } else if (format === 'glb') {
                const planeWidth = asNumber(args.planeWidthMeters, 2.0)!;
                const planeHeight = planeWidth; // 1:1 aspect square
                const dispScale = asNumber(args.displacementScaleMeters, 0.04)!;
                const subX = Math.min(128, Math.max(32, Math.round(width / 32)));
                const subY = subX;
                const vertexCount = (subX + 1) * (subY + 1);
                const triangleCount = subX * subY * 2;
                const indexCount = triangleCount * 3;

                const positions = new Float32Array(vertexCount * 3);
                const normals = new Float32Array(vertexCount * 3);
                const uvs = new Float32Array(vertexCount * 2);
                const tangents = new Float32Array(vertexCount * 4);
                const indices = new Uint32Array(indexCount);

                for (let j = 0; j <= subY; j++) {
                    const v = j / subY;
                    const y = (0.5 - v) * planeHeight;
                    for (let i = 0; i <= subX; i++) {
                        const u = i / subX;
                        const x = (u - 0.5) * planeWidth;
                        const vIdx = j * (subX + 1) + i;

                        const px = Math.min(width - 1, Math.floor(u * (width - 1)));
                        const py = Math.min(height - 1, Math.floor(v * (height - 1)));
                        const hNorm = pbrResult.heightRgb[(py * width + px) * 3] / 255.0;
                        const z = dispScale > 0 ? (hNorm - 0.5) * dispScale : 0.0;

                        positions[vIdx * 3 + 0] = x;
                        positions[vIdx * 3 + 1] = y;
                        positions[vIdx * 3 + 2] = z;

                        normals[vIdx * 3 + 0] = 0;
                        normals[vIdx * 3 + 1] = 0;
                        normals[vIdx * 3 + 2] = 1;

                        uvs[vIdx * 2 + 0] = u;
                        uvs[vIdx * 2 + 1] = v;

                        tangents[vIdx * 4 + 0] = 1;
                        tangents[vIdx * 4 + 1] = 0;
                        tangents[vIdx * 4 + 2] = 0;
                        tangents[vIdx * 4 + 3] = 1;
                    }
                }

                let idxPtr = 0;
                for (let j = 0; j < subY; j++) {
                    const row1 = j * (subX + 1);
                    const row2 = (j + 1) * (subX + 1);
                    for (let i = 0; i < subX; i++) {
                        const p00 = row1 + i;
                        const p10 = row1 + i + 1;
                        const p01 = row2 + i;
                        const p11 = row2 + i + 1;

                        indices[idxPtr++] = p00;
                        indices[idxPtr++] = p01;
                        indices[idxPtr++] = p10;

                        indices[idxPtr++] = p10;
                        indices[idxPtr++] = p01;
                        indices[idxPtr++] = p11;
                    }
                }

                const indicesBuffer = Buffer.from(indices.buffer);
                const positionsBuffer = Buffer.from(positions.buffer);
                const normalsBuffer = Buffer.from(normals.buffer);
                const uvsBuffer = Buffer.from(uvs.buffer);
                const tangentsBuffer = Buffer.from(tangents.buffer);

                const rawBufferViews = [
                    indicesBuffer,
                    positionsBuffer,
                    normalsBuffer,
                    uvsBuffer,
                    tangentsBuffer,
                    albedoPng,
                    ormPng,
                    normalPng
                ];

                const gltf = {
                    asset: { version: '2.0', generator: 'Scratchbox Native C++20 PBR Manifold' },
                    scene: 0,
                    scenes: [{ nodes: [0] }],
                    nodes: [{ mesh: 0, name: 'PBR_Manifold_Plane' }],
                    meshes: [{
                        name: 'PBR_Manifold_Plane_Mesh',
                        primitives: [{
                            attributes: { POSITION: 1, NORMAL: 2, TEXCOORD_0: 3, TANGENT: 4 },
                            indices: 0,
                            material: 0
                        }]
                    }],
                    materials: [{
                        name: `${archetypeKey}_PBR_Material`,
                        pbrMetallicRoughness: {
                            baseColorTexture: { index: 0 },
                            metallicRoughnessTexture: { index: 1 },
                            baseColorFactor: [1.0, 1.0, 1.0, 1.0],
                            roughnessFactor: 1.0,
                            metallicFactor: 1.0
                        },
                        normalTexture: { index: 2, scale: descriptor.normalStrength ?? 1.5 },
                        occlusionTexture: { index: 1, strength: descriptor.aoStrength ?? 1.0 },
                        doubleSided: true
                    }],
                    textures: [
                        { source: 0, sampler: 0 },
                        { source: 1, sampler: 0 },
                        { source: 2, sampler: 0 }
                    ],
                    images: [
                        { bufferView: 5, mimeType: 'image/png', name: 'albedo' },
                        { bufferView: 6, mimeType: 'image/png', name: 'orm' },
                        { bufferView: 7, mimeType: 'image/png', name: 'normal' }
                    ],
                    samplers: [{
                        magFilter: 9729,
                        minFilter: 9987,
                        wrapS: 10497,
                        wrapT: 10497
                    }],
                    accessors: [
                        { bufferView: 0, componentType: 5125, count: indexCount, type: 'SCALAR', byteOffset: 0 },
                        { bufferView: 1, componentType: 5126, count: vertexCount, type: 'VEC3', byteOffset: 0 },
                        { bufferView: 2, componentType: 5126, count: vertexCount, type: 'VEC3', byteOffset: 0 },
                        { bufferView: 3, componentType: 5126, count: vertexCount, type: 'VEC2', byteOffset: 0 },
                        { bufferView: 4, componentType: 5126, count: vertexCount, type: 'VEC4', byteOffset: 0 }
                    ]
                };

                const packed = GltfBinaryPacker.packGlb(gltf, rawBufferViews);
                const glbPath = path.join(outDir, `${filePrefix}.glb`);
                fs.writeFileSync(glbPath, packed.glbBuffer);
                writtenFiles.glb = glbPath;
            }
        } else {
            writtenFiles.albedoRaw = path.join(outDir, `${filePrefix}_albedo.raw`);
            writtenFiles.normalRaw = path.join(outDir, `${filePrefix}_normal.raw`);
            writtenFiles.ormRaw = path.join(outDir, `${filePrefix}_orm.raw`);
            writtenFiles.heightRaw = path.join(outDir, `${filePrefix}_height.raw`);
            fs.writeFileSync(writtenFiles.albedoRaw, pbrResult.albedoRgb);
            fs.writeFileSync(writtenFiles.normalRaw, pbrResult.normalRgb);
            fs.writeFileSync(writtenFiles.ormRaw, pbrResult.ormRgb);
            fs.writeFileSync(writtenFiles.heightRaw, pbrResult.heightRgb);
        }

        const elapsedMs = Math.round(performance.now() - startTime);

        const payload: ToolResultPayload = {
            success: true,
            resolution: `${width}x${height}`,
            resolutionTier: args.resolution ?? `${width}x${height}`,
            archetype: archetypeKey,
            descriptor,
            format,
            executionTimeMs: elapsedMs,
            materialSource,
            synthesizer: pbrResult.synthesizer,
            nativeTimingsMs: {
                total: Math.round(pbrResult.executionTimeMs),
                compile: Math.round(pbrResult.timings.compileMs),
                compileCacheHit: pbrResult.timings.compileCacheHit,
                kernel: Math.round(pbrResult.timings.kernelMs),
                readback: Math.round(pbrResult.timings.readbackMs)
            },
            pngEncodeMs: encodeMs,
            outputDirectory: outDir,
            files: writtenFiles
        };

        const tierName = args.resolution || `${width}x${height}`;
        const t = pbrResult.timings;
        const materialNote = materialSource === 'descriptor' ? ' (from the given descriptor)' : '';
        const summary = `Synthesized ${tierName} (${width}x${height}) PBR material [${archetypeKey}]${materialNote} in ${elapsedMs}ms: native C++20 kernel ${Math.round(t.kernelMs)}ms, compile ${t.compileCacheHit ? 'cached' : `${Math.round(t.compileMs)}ms`}, PNG encode ${encodeMs}ms. Format: ${format}. Conduction: ${descriptor.conduction.toFixed(2)}, Roughness: ${descriptor.roughnessBaseline.toFixed(2)}, Fissure: ${descriptor.fissureScale?.toFixed(1) ?? '8.0'}. Files: ${Object.values(writtenFiles).map(f => path.basename(f)).join(', ')} in ${outDir}.`;

        return {
            resultPayload: payload,
            summaryResult: summary
        };
    },

    pbr_get_material_catalog: async (args, _ctx) => {
        const service = new NativeMaterialPbrService();
        let catalog = service.get50Catalog();
        // Free-text search over the examples' text (key, name, description, display group); it only narrows the list.
        const query = asString(args.query) ?? asString(args.category);
        if (query) {
            const norm = query.toLowerCase();
            catalog = catalog.filter(c => [c.key, c.displayName, c.description, c.category].some(t => t.toLowerCase().includes(norm)));
        }

        return {
            resultPayload: {
                totalCount: catalog.length,
                groups: Array.from(new Set(catalog.map(c => c.category))),
                examples: catalog.map(c => ({ archetypeId: c.archetypeId, key: c.key, displayName: c.displayName, group: c.category, description: c.description, descriptor: c.descriptor })),
                requiredDescriptorFields: [...PBR_DESCRIPTOR_REQUIRED_FIELDS]
            } as unknown as ToolResultPayload,
            summaryResult: `Listed ${catalog.length} example material descriptors${query ? ` matching "${query}"` : ''}. They are reference points in the continuous 20-float space, not a closed list: for any surface, fill a descriptor (${PBR_DESCRIPTOR_REQUIRED_FIELDS.join(', ')} required) from the user's description, optionally starting from the nearest example.`
        };
    },

    pbr_interpolate_materials: async (args, _ctx) => {
        const service = new NativeMaterialPbrService();
        const alpha = Math.max(0.0, Math.min(1.0, asNumber(args.alpha, 0.5)!));

        // Each side is a named example (a key or name) or a descriptor; a descriptor gives its required fields itself.
        const resolveDescriptor = (input: unknown, which: string): ContinuousMaterialDescriptor => {
            let parsed: unknown = input;
            if (typeof input === 'string') {
                try {
                    parsed = JSON.parse(input);
                } catch {
                    const entry = service.resolveArchetype(input);
                    return service.getAnchorDescriptor(entry.archetypeId);
                }
            }
            if (typeof parsed === 'object' && parsed !== null) {
                return sanitizeDescriptor(parsed, descriptorWithoutExample(parsed, `pbr_interpolate_materials.${which}`));
            }
            return descriptorWithoutExample(undefined, `pbr_interpolate_materials.${which}`);
        };

        const descA = resolveDescriptor(args.materialA, 'materialA');
        const descB = resolveDescriptor(args.materialB, 'materialB');

        const lerpVal = (a: number, b: number, t: number) => a + (b - a) * t;
        const lerpVec3 = (a: [number, number, number], b: [number, number, number], t: number): [number, number, number] => [
            lerpVal(a[0], b[0], t),
            lerpVal(a[1], b[1], t),
            lerpVal(a[2], b[2], t)
        ];

        const secA = descA.secondaryAlbedo ?? [descA.albedoLinear[0] * 0.72, descA.albedoLinear[1] * 0.72, descA.albedoLinear[2] * 0.72];
        const secB = descB.secondaryAlbedo ?? [descB.albedoLinear[0] * 0.72, descB.albedoLinear[1] * 0.72, descB.albedoLinear[2] * 0.72];

        const interpolated: ContinuousMaterialDescriptor = {
            albedoLinear: lerpVec3(descA.albedoLinear, descB.albedoLinear, alpha),
            secondaryAlbedo: lerpVec3(secA, secB, alpha),
            secondaryWeight: lerpVal(descA.secondaryWeight ?? 0.25, descB.secondaryWeight ?? 0.25, alpha),
            conduction: lerpVal(descA.conduction, descB.conduction, alpha),
            roughnessBaseline: lerpVal(descA.roughnessBaseline, descB.roughnessBaseline, alpha),
            microPorosity: lerpVal(descA.microPorosity ?? 0.2, descB.microPorosity ?? 0.2, alpha),
            normalStrength: lerpVal(descA.normalStrength ?? 1.5, descB.normalStrength ?? 1.5, alpha),
            fissureScale: lerpVal(descA.fissureScale ?? 8.0, descB.fissureScale ?? 8.0, alpha),
            fissureDepth: lerpVal(descA.fissureDepth ?? 0.25, descB.fissureDepth ?? 0.25, alpha),
            fbmOctaves: lerpVal(descA.fbmOctaves ?? 4.0, descB.fbmOctaves ?? 4.0, alpha),
            fbmGain: lerpVal(descA.fbmGain ?? 0.5, descB.fbmGain ?? 0.5, alpha),
            cellularWeight: lerpVal(descA.cellularWeight ?? 0.3, descB.cellularWeight ?? 0.3, alpha),
            graininess: lerpVal(descA.graininess ?? 0.15, descB.graininess ?? 0.15, alpha),
            anisotropyStrength: lerpVal(descA.anisotropyStrength ?? 0.0, descB.anisotropyStrength ?? 0.0, alpha),
            anisotropyAngleRad: lerpVal(descA.anisotropyAngleRad ?? 0.0, descB.anisotropyAngleRad ?? 0.0, alpha),
            aoStrength: lerpVal(descA.aoStrength ?? 1.0, descB.aoStrength ?? 1.0, alpha)
        };

        let synthResult: any = undefined;
        if (args.synthesize) {
            synthResult = await pbrMaterialHandlers.pbr_synthesize_material({
                descriptor: interpolated,
                resolution: args.resolution ?? '2K',
                outputDir: args.outputDir,
                format: 'png_pack'
            }, _ctx);
        }

        return {
            resultPayload: {
                alpha,
                descriptor: interpolated,
                synthesis: synthResult ? synthResult.resultPayload : null
            } as unknown as ToolResultPayload,
            summaryResult: `Interpolated continuous material manifold at alpha=${alpha.toFixed(2)}. Conduction: ${interpolated.conduction.toFixed(2)}, Roughness: ${interpolated.roughnessBaseline.toFixed(2)}, Normal: ${interpolated.normalStrength?.toFixed(2)}.${synthResult ? ' Synthesized texture pack.' : ''}`
        };
    }
};
