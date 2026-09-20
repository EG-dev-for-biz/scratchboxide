/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { NativeMeshReshaperService, MeshDeformationOp } from '../../3d-engine/native-mesh-reshaper-service';
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
    }
];

const reshaperService = new NativeMeshReshaperService();

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
    }
};
