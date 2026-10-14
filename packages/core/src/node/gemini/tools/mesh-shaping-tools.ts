/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs-extra';
import { NativeMeshReshaperService, MeshDeformationOp } from '../../3d-engine/native-mesh-reshaper-service';
import {
    NativeTileRestructurerService,
    type TerraformingOp,
    type PrimitiveGraft,
    type TileStyle,
    type RestructureMaterialMode
} from '../../3d-engine/native-tile-restructurer-service';
import { GeneratorFailedError, MissingInputError } from '../../../common/errors/pipeline-errors';
import type { ToolDeclaration, ToolHandler, ToolParameterSchema } from './types';

function asString(val: unknown): string {
    return typeof val === 'string' ? val : '';
}

const INPUT_GLB_PARAMETER: ToolParameterSchema = {
    type: 'STRING',
    description: 'Path to the input binary glTF 2.0 (.glb) mesh (required; the tool fails rather than deform a stand-in mesh).'
};

/** The mesh to process must exist on disk; the native binaries would otherwise build a benchmark mesh instead. */
async function requireInputGlb(tool: string, value: unknown): Promise<string> {
    const inputGlbPath = asString(value);
    if (!inputGlbPath) {
        throw new MissingInputError(tool, 'inputGlbPath', 'give the path of the .glb to process; no benchmark mesh is substituted');
    }
    if (!(await fs.pathExists(inputGlbPath))) {
        throw new MissingInputError(tool, 'inputGlbPath', `${inputGlbPath} does not exist`);
    }
    return inputGlbPath;
}

/** A native run that read no vertices, reported failure, or wrote no GLB did not do what was asked. */
function requireNativeOutput(tool: string, inputGlbPath: string, result: {
    success: boolean; outputGlbPath: string; glbBuffer?: Buffer; stdout: string; stderr?: string;
    telemetry: { inputVertices?: number; status?: string };
}): void {
    const detail = (result.stderr || result.stdout || '').trim().slice(-1500);
    if (!/\[TELEMETRY\]/.test(result.stdout || '')) {
        throw new GeneratorFailedError('cpp', `${tool}: the native pipeline reported no telemetry for ${inputGlbPath}. ${detail}`);
    }
    if (!result.success || (result.telemetry.status && result.telemetry.status !== 'success')) {
        throw new GeneratorFailedError('cpp', `${tool}: the native pipeline reported status ${result.telemetry.status || 'failed'} for ${inputGlbPath}. ${detail}`);
    }
    if (!((result.telemetry.inputVertices ?? 0) > 0)) {
        throw new GeneratorFailedError('cpp', `${tool}: the native pipeline read no vertices from ${inputGlbPath}. ${detail}`);
    }
    if (!result.glbBuffer) {
        throw new GeneratorFailedError('cpp', `${tool}: the native pipeline wrote no GLB to ${result.outputGlbPath}. ${detail}`);
    }
}

export const MESH_SHAPING_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'mesh_reshape_via_prompt',
        description: 'Reshape, sculpt, and deform a 3D mesh (.glb) from a natural language prompt using the native Scratchbox C++20 Astro 3D engine (taper, twist, bend, bulge, FFD Bernstein lattice, digital sculpt strokes, and subdivision).',
        parameters: {
            type: 'OBJECT',
            properties: {
                prompt: {
                    type: 'STRING',
                    description: 'Natural language description of desired deformations (e.g., "taper top by 40% and twist 45 degrees along Y", "bend 30 degrees towards X", "sculpt clay stroke along spine", "smooth surface").'
                },
                inputGlbPath: INPUT_GLB_PARAMETER,
                outputGlbPath: {
                    type: 'STRING',
                    description: 'Optional path where reshaped binary glTF 2.0 (.glb) will be written. Defaults to reshaped_<timestamp>.glb.'
                }
            },
            required: ['prompt', 'inputGlbPath']
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
                inputGlbPath: INPUT_GLB_PARAMETER,
                outputGlbPath: {
                    type: 'STRING',
                    description: 'Optional path where reshaped binary glTF 2.0 (.glb) will be written.'
                }
            },
            required: ['operations', 'inputGlbPath']
        }
    },
    {
        name: 'tile_restructure_via_prompt',
        description: 'Restructure, terraform, and graft architectural primitives onto a 3D tile (.glb) from a natural language prompt using native C++20 Astro 3D engine.',
        parameters: {
            type: 'OBJECT',
            properties: {
                prompt: {
                    type: 'STRING',
                    description: 'Natural language instruction (e.g. "Terrace the hillside into 3 steps, level a central sun plaza, and place 4 solar obelisks at the corners and a bio-dome at the apex").'
                },
                inputGlbPath: INPUT_GLB_PARAMETER,
                outputGlbPath: {
                    type: 'STRING',
                    description: 'Optional path where restructured binary glTF 2.0 (.glb) will be written.'
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
            required: ['prompt', 'inputGlbPath']
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
                inputGlbPath: INPUT_GLB_PARAMETER,
                outputGlbPath: { type: 'STRING' }
            },
            required: ['inputGlbPath']
        }
    }
];

const reshaperService = new NativeMeshReshaperService();
const tileRestructurerService = new NativeTileRestructurerService();

export const meshShapingHandlers: Record<string, ToolHandler> = {
    mesh_reshape_via_prompt: async (args, _ctx) => {
        const prompt = asString(args.prompt);
        if (!prompt.trim()) {
            throw new MissingInputError('mesh_reshape_via_prompt', 'prompt', 'describe the deformation to apply');
        }
        const inputGlbPath = await requireInputGlb('mesh_reshape_via_prompt', args.inputGlbPath);
        const outputGlbPath = asString(args.outputGlbPath) || undefined;
        // The service applies a stock taper and twist when it reads no operation from the prompt; refuse that instead.
        const operations = reshaperService.parsePromptToOperations(prompt);
        if (operations.length === 0) {
            throw new MissingInputError('mesh_reshape_via_prompt', 'prompt',
                `no deformation (taper, twist, bend, bulge, shear, lattice, sculpt, subdivide, repair, weathering) could be read from "${prompt}"; use mesh_apply_deformers with explicit operations`);
        }

        const result = await reshaperService.reshapeMesh({
            operations,
            inputGlbPath,
            outputGlbPath
        });
        requireNativeOutput('mesh_reshape_via_prompt', inputGlbPath, result);

        return {
            status: 'completed',
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
        if (rawOps.length === 0) {
            throw new MissingInputError('mesh_apply_deformers', 'operations', 'give at least one deformation operation; none is chosen for you');
        }
        const inputGlbPath = await requireInputGlb('mesh_apply_deformers', args.inputGlbPath);
        const outputGlbPath = asString(args.outputGlbPath) || undefined;

        const result = await reshaperService.reshapeMesh({
            operations: rawOps,
            inputGlbPath,
            outputGlbPath
        });
        requireNativeOutput('mesh_apply_deformers', inputGlbPath, result);

        return {
            status: 'completed',
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
        if (!prompt.trim()) {
            throw new MissingInputError('tile_restructure_via_prompt', 'prompt', 'describe the restructuring to apply');
        }
        const inputGlbPath = await requireInputGlb('tile_restructure_via_prompt', args.inputGlbPath);
        const outputGlbPath = asString(args.outputGlbPath) || undefined;
        const materialMode = (asString(args.materialMode) as RestructureMaterialMode) || undefined;
        const clayPreset = asString(args.clayPreset) || undefined;

        const result = await tileRestructurerService.restructureTile({
            prompt,
            inputGlbPath,
            outputGlbPath,
            materialMode,
            clayPreset
        });
        requireNativeOutput('tile_restructure_via_prompt', inputGlbPath, result);

        return {
            status: 'completed',
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
        const inputGlbPath = await requireInputGlb('tile_apply_terraforming_and_primitives', args.inputGlbPath);
        const outputGlbPath = asString(args.outputGlbPath) || undefined;

        const result = await tileRestructurerService.restructureTile({
            config: {
                style,
                materialMode,
                clayPreset,
                terraforming,
                primitives
            },
            inputGlbPath,
            outputGlbPath
        });
        requireNativeOutput('tile_apply_terraforming_and_primitives', inputGlbPath, result);

        return {
            status: 'completed',
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
