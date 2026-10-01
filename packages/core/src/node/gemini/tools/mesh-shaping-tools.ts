/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { NativeMeshReshaperService, MeshDeformationOp } from '../../3d-engine/native-mesh-reshaper-service';
import {
    NativeTileRestructurerService,
    type TerraformingOp,
    type PrimitiveGraft,
    type TileStyle,
    type RestructureMaterialMode
} from '../../3d-engine/native-tile-restructurer-service';
import type { ToolDeclaration, ToolHandler } from './types';

function asString(val: unknown): string {
    return typeof val === 'string' ? val : '';
}

export const MESH_SHAPING_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'mesh_reshape_via_prompt',
        description: 'Reshape, sculpt, and deform a 3D mesh (.glb) from a natural language prompt using the native Scratchbox C++20 Astra 3D engine (taper, twist, bend, bulge, FFD Bernstein lattice, digital sculpt strokes, and subdivision).',
        parameters: {
            type: 'OBJECT',
            properties: {
                prompt: {
                    type: 'STRING',
                    description: 'Natural language description of desired deformations (e.g., "taper top by 40% and twist 45 degrees along Y", "bend 30 degrees towards X", "sculpt clay stroke along spine", "smooth surface").'
                },
                inputGlbPath: {
                    type: 'STRING',
                    description: 'Optional path to input binary glTF 2.0 (.glb) mesh. If omitted, uses specified benchmark.'
                },
                outputGlbPath: {
                    type: 'STRING',
                    description: 'Optional path where reshaped binary glTF 2.0 (.glb) will be written. Defaults to reshaped_<timestamp>.glb.'
                },
                benchmark: {
                    type: 'STRING',
                    description: 'Synthetic benchmark mesh to use if inputGlbPath is not supplied: "cylinder", "cube", or "sculpture". Defaults to "cylinder".'
                }
            },
            required: ['prompt']
        }
    },
    {
        name: 'mesh_apply_deformers',
        description: 'Apply an explicit parametric sequence of 3D deformations (taper, twist, bend, bulge, shear, FFD lattice, sculpt brushes, loop subdivision) via native C++20 engine.',
        parameters: {
            type: 'OBJECT',
            properties: {
                operations: {
                    type: 'ARRAY',
                    description: 'Array of parametric deformation operations to execute in order on the mesh.',
                    items: {
                        type: 'OBJECT',
                        properties: {
                            type: {
                                type: 'STRING',
                                description: 'Deformation type: "taper", "twist", "bend", "bulge", "shear", "lattice", "sculpt", "subdivide", "repair", or "weathering".'
                            },
                            axis: {
                                type: 'STRING',
                                description: 'Primary axis: "X", "Y", or "Z".'
                            },
                            secondaryAxis: {
                                type: 'STRING',
                                description: 'Secondary axis for bend/shear: "X", "Y", or "Z".'
                            },
                            factor: {
                                type: 'NUMBER',
                                description: 'Scale factor for taper or shear.'
                            },
                            angleDeg: {
                                type: 'NUMBER',
                                description: 'Deformation angle in degrees for twist or bend.'
                            },
                            radius: {
                                type: 'NUMBER',
                                description: 'Effect radius for bulge, bend, or sculpt.'
                            },
                            strength: {
                                type: 'NUMBER',
                                description: 'Deformation magnitude for bulge or sculpt strokes.'
                            },
                            sculptBrush: {
                                type: 'STRING',
                                description: 'Sculpt brush: "grab", "clay", "inflate", "flatten", "pinch", "crease", or "smooth".'
                            }
                        }
                    }
                },
                inputGlbPath: {
                    type: 'STRING',
                    description: 'Optional path to input binary glTF 2.0 (.glb) mesh.'
                },
                outputGlbPath: {
                    type: 'STRING',
                    description: 'Optional path where reshaped binary glTF 2.0 (.glb) will be written.'
                },
                benchmark: {
                    type: 'STRING',
                    description: 'Synthetic benchmark mesh: "cylinder", "cube", or "sculpture".'
                }
            },
            required: ['operations']
        }
    },
    {
        name: 'tile_restructure_via_prompt',
        description: 'Restructure, terraform, and graft architectural primitives onto a 3D tile (.glb) from a natural language prompt using native C++20 Astra 3D engine.',
        parameters: {
            type: 'OBJECT',
            properties: {
                prompt: {
                    type: 'STRING',
                    description: 'Natural language instruction (e.g. "Terrace the hillside into 3 steps, level a central sun plaza, and place 4 solar obelisks at the corners and a bio-dome at the apex").'
                },
                inputGlbPath: {
                    type: 'STRING',
                    description: 'Optional path to input 3D tile binary glTF 2.0 (.glb) mesh.'
                },
                outputGlbPath: {
                    type: 'STRING',
                    description: 'Optional path where restructured binary glTF 2.0 (.glb) will be written.'
                },
                benchmark: {
                    type: 'STRING',
                    description: 'Synthetic benchmark tile to use if inputGlbPath is not supplied: "hillside_monument" or "city_district".'
                },
                materialMode: {
                    type: 'STRING',
                    description: 'Material pipeline mode: "stylized_pbr", "studio_clay", or "hybrid_photogrammetric".'
                },
                clayPreset: {
                    type: 'STRING',
                    description: 'Clay shading preset if studio_clay mode: "ArchitecturalWhite", "Sandstone", "WarmTerracotta", "ConcreteBrutalist", or "SlateGrey".'
                }
            },
            required: ['prompt']
        }
    },
    {
        name: 'tile_apply_terraforming_and_primitives',
        description: 'Apply explicit parametric terraforming operations (terrace, plateau_level, crater_basin, trench_moat, ridge_ramp) and graft primitives (obelisk, column_colonnade, dome, stepped_pyramid, gothic_portal, pylon_gate) onto a 3D tile.',
        parameters: {
            type: 'OBJECT',
            properties: {
                style: {
                    type: 'STRING',
                    description: 'Architectural theme: "SolarpunkCitadel", "NeoclassicalMonument", "BrutalistFortress", "GothicCathedral", or "SciFiOutpost".'
                },
                materialMode: {
                    type: 'STRING',
                    description: 'Material mode: "stylized_pbr", "studio_clay", or "hybrid_photogrammetric".'
                },
                clayPreset: {
                    type: 'STRING',
                    description: 'Clay preset: "ArchitecturalWhite", "Sandstone", "WarmTerracotta", "ConcreteBrutalist", "SlateGrey".'
                },
                terraforming: {
                    type: 'ARRAY',
                    description: 'List of terraforming operations to execute.',
                    items: {
                        type: 'OBJECT',
                        properties: {
                            type: { type: 'STRING' },
                            center: { type: 'ARRAY', items: { type: 'NUMBER' } },
                            radius: { type: 'NUMBER' },
                            targetElevation: { type: 'NUMBER' },
                            stepHeight: { type: 'NUMBER' },
                            stepCount: { type: 'NUMBER' },
                            depth: { type: 'NUMBER' }
                        }
                    }
                },
                primitives: {
                    type: 'ARRAY',
                    description: 'List of primitives to graft into the mesh.',
                    items: {
                        type: 'OBJECT',
                        properties: {
                            type: { type: 'STRING' },
                            position: { type: 'ARRAY', items: { type: 'NUMBER' } },
                            scale: { type: 'ARRAY', items: { type: 'NUMBER' } },
                            count: { type: 'NUMBER' },
                            radius: { type: 'NUMBER' },
                            anchor: { type: 'STRING' },
                            adaptToTerrain: { type: 'BOOLEAN' }
                        }
                    }
                },
                inputGlbPath: { type: 'STRING' },
                outputGlbPath: { type: 'STRING' },
                benchmark: { type: 'STRING' }
            }
        }
    }
];

const reshaperService = new NativeMeshReshaperService();
const tileRestructurerService = new NativeTileRestructurerService();

export const meshShapingHandlers: Record<string, ToolHandler> = {
    mesh_reshape_via_prompt: async (args, _ctx) => {
        const prompt = asString(args.prompt);
        const inputGlbPath = asString(args.inputGlbPath) || undefined;
        const outputGlbPath = asString(args.outputGlbPath) || undefined;
        const benchmark = (asString(args.benchmark) as 'cylinder' | 'cube' | 'sculpture') || 'cylinder';

        const result = await reshaperService.reshapeMesh({
            prompt,
            inputGlbPath,
            outputGlbPath,
            benchmark
        });

        return {
            status: result.success ? 'completed' : 'failed',
            resultPayload: {
                status: result.success ? 'success' : 'failed',
                success: result.success,
                outputGlbPath: result.outputGlbPath,
                telemetry: result.telemetry,
                operationsApplied: result.operationsApplied
            },
            summaryResult: `Successfully reshaped mesh via native C++20 engine in ${result.telemetry.processingTimeMs.toFixed(2)}ms (${result.telemetry.outputVertices} vertices, ${result.telemetry.outputTriangles} triangles, ${result.operationsApplied.length} operations applied). GLB written to: ${result.outputGlbPath}`
        };
    },

    mesh_apply_deformers: async (args, _ctx) => {
        const rawOps = Array.isArray(args.operations) ? (args.operations as MeshDeformationOp[]) : [];
        const inputGlbPath = asString(args.inputGlbPath) || undefined;
        const outputGlbPath = asString(args.outputGlbPath) || undefined;
        const benchmark = (asString(args.benchmark) as 'cylinder' | 'cube' | 'sculpture') || 'cylinder';

        const result = await reshaperService.reshapeMesh({
            operations: rawOps,
            inputGlbPath,
            outputGlbPath,
            benchmark
        });

        return {
            status: result.success ? 'completed' : 'failed',
            resultPayload: {
                status: result.success ? 'success' : 'failed',
                success: result.success,
                outputGlbPath: result.outputGlbPath,
                telemetry: result.telemetry,
                operationsApplied: result.operationsApplied
            },
            summaryResult: `Parametric mesh deformations executed in ${result.telemetry.processingTimeMs.toFixed(2)}ms (${result.telemetry.outputVertices} vertices, ${result.telemetry.outputTriangles} triangles, ${result.operationsApplied.length} operations applied). Output: ${result.outputGlbPath}`
        };
    },

    tile_restructure_via_prompt: async (args, _ctx) => {
        const prompt = asString(args.prompt);
        const inputGlbPath = asString(args.inputGlbPath) || undefined;
        const outputGlbPath = asString(args.outputGlbPath) || undefined;
        const benchmark = (asString(args.benchmark) as 'hillside_monument' | 'city_district') || 'hillside_monument';
        const materialMode = (asString(args.materialMode) as RestructureMaterialMode) || undefined;
        const clayPreset = asString(args.clayPreset) || undefined;

        const result = await tileRestructurerService.restructureTile({
            prompt,
            inputGlbPath,
            outputGlbPath,
            benchmark,
            materialMode,
            clayPreset
        });

        return {
            status: result.success ? 'completed' : 'failed',
            resultPayload: {
                status: result.success ? 'success' : 'failed',
                success: result.success,
                outputGlbPath: result.outputGlbPath,
                telemetry: result.telemetry,
                configApplied: result.configApplied
            },
            summaryResult: `Successfully restructured 3D tile via native C++20 engine in ${result.telemetry.processingTimeMs.toFixed(2)}ms (${result.telemetry.outputVertices} vertices, ${result.telemetry.outputTriangles} triangles, ${result.telemetry.terraformingOpsApplied} terraform ops, ${result.telemetry.primitivesGrafted} primitives grafted, style=${result.telemetry.style}). GLB written to: ${result.outputGlbPath}`
        };
    },

    tile_apply_terraforming_and_primitives: async (args, _ctx) => {
        const style = (asString(args.style) as TileStyle) || 'SolarpunkCitadel';
        const materialMode = (asString(args.materialMode) as RestructureMaterialMode) || 'stylized_pbr';
        const clayPreset = asString(args.clayPreset) || 'ArchitecturalWhite';
        const terraforming = Array.isArray(args.terraforming) ? (args.terraforming as TerraformingOp[]) : [];
        const primitives = Array.isArray(args.primitives) ? (args.primitives as PrimitiveGraft[]) : [];
        const inputGlbPath = asString(args.inputGlbPath) || undefined;
        const outputGlbPath = asString(args.outputGlbPath) || undefined;
        const benchmark = (asString(args.benchmark) as 'hillside_monument' | 'city_district') || 'hillside_monument';

        const result = await tileRestructurerService.restructureTile({
            config: {
                style,
                materialMode,
                clayPreset,
                terraforming,
                primitives
            },
            inputGlbPath,
            outputGlbPath,
            benchmark
        });

        return {
            status: result.success ? 'completed' : 'failed',
            resultPayload: {
                status: result.success ? 'success' : 'failed',
                success: result.success,
                outputGlbPath: result.outputGlbPath,
                telemetry: result.telemetry,
                configApplied: result.configApplied
            },
            summaryResult: `Parametric 3D tile restructuring completed in ${result.telemetry.processingTimeMs.toFixed(2)}ms (${result.telemetry.outputVertices} vertices, ${result.telemetry.primitivesGrafted} primitives grafted, style=${result.telemetry.style}). Output: ${result.outputGlbPath}`
        };
    }
};
