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
import { MissingInputError } from '../../../common/errors/pipeline-errors';
import type { ToolDeclaration, ToolHandler, ToolParameterSchema } from './types';

function asString(val: unknown): string {
    return typeof val === 'string' ? val : '';
}

const INPUT_GLB_PARAMETER: ToolParameterSchema = {
    type: 'STRING',
    description: 'Path to the input binary glTF 2.0 (.glb) mesh (required; the tool fails rather than deform a stand-in mesh).'
};

/** The mesh to process must exist on disk; nothing is substituted for a missing one. */
async function requireInputGlb(tool: string, value: unknown): Promise<string> {
    const inputGlbPath = asString(value);
    if (!inputGlbPath) {
        throw new MissingInputError(tool, 'inputGlbPath', 'give the path of the .glb to process; no stand-in mesh is used');
    }
    if (!(await fs.pathExists(inputGlbPath))) {
        throw new MissingInputError(tool, 'inputGlbPath', `${inputGlbPath} does not exist`);
    }
    return inputGlbPath;
}

const fmt = (v: [number, number, number]) => `[${v.map(n => Number(n.toFixed(3))).join(', ')}]`;

export const MESH_SHAPING_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'mesh_apply_deformers',
        description: 'Deform a given 3D mesh (.glb) with an explicit, ordered list of operations in the native C++20 engine. You choose every operation and value from what the user asked for; nothing is inferred or applied by default, and an operation with a missing or out-of-range parameter fails the call. Positions and sizes are fractions of the mesh\'s measured bounding box (as it stands before each operation), so they mean the same on a small prop and a 60 m tower: range [start, end] = fractions of the extent along axis (0 = min, 1 = max); center [u, v, w] = fractions of the box along X, Y, Z; radius and strength = fractions of the box diagonal. '
            + 'Per type: taper {axis, factor (cross-section scale at the range end, >0), range, power? (default 1)}; twist {axis, angleDeg, range}; bend {axis (length direction), secondaryAxis (direction the far end curves toward), angleDeg (total over the extent; the min end stays fixed)}; shear {axis, secondaryAxis, factor (the far end moves factor x the extent along axis)}; bulge {center, radius, strength (negative pinches), power? (default 2)}; sculpt {sculptBrush, center, radius, strength (a 0..1 blend for smooth and flatten), direction (grab, clay, flatten)}; lattice {latticeDimensions [2..8 each], latticeOffsets [{i, j, k, offset: fractions of the box size}]}; subdivide {subdivideIterations 1..3}; repair {}; weathering {weatheringIntensity (vertex colour variation), weatheringScale (noise cycles across the mesh)}. The result reports the measured input bounds.',
        parameters: {
            type: 'OBJECT',
            properties: {
                operations: {
                    type: 'ARRAY',
                    description: 'Deformations to apply, in order. Each one is explicit; see the tool description for the parameters each type needs.',
                    items: {
                        type: 'OBJECT',
                        properties: {
                            type: { type: 'STRING', description: 'taper, twist, bend, shear, bulge, sculpt, lattice, subdivide, repair or weathering.' },
                            axis: { type: 'STRING', description: '"X", "Y" or "Z".' },
                            secondaryAxis: { type: 'STRING', description: '"X", "Y" or "Z", different from axis (bend, shear).' },
                            factor: { type: 'NUMBER', description: 'Taper: cross-section scale at the range end (>0). Shear: slope.' },
                            angleDeg: { type: 'NUMBER', description: 'Twist or bend angle in degrees.' },
                            range: { type: 'ARRAY', items: { type: 'NUMBER' }, description: '[start, end], fractions of the extent along axis, 0 <= start < end <= 1 (taper, twist).' },
                            power: { type: 'NUMBER', description: 'Optional curve exponent (taper, default 1; bulge falloff, default 2).' },
                            center: { type: 'ARRAY', items: { type: 'NUMBER' }, description: '[u, v, w], fractions of the bounding box along X, Y, Z (bulge, sculpt).' },
                            radius: { type: 'NUMBER', description: 'Fraction of the bounding-box diagonal (bulge, sculpt).' },
                            strength: { type: 'NUMBER', description: 'Displacement as a fraction of the bounding-box diagonal; a 0..1 blend for the smooth and flatten brushes.' },
                            direction: { type: 'ARRAY', items: { type: 'NUMBER' }, description: 'Stroke direction [x, y, z] (sculpt grab, clay, flatten).' },
                            sculptBrush: { type: 'STRING', description: 'grab, clay, inflate, flatten, pinch, crease or smooth.' },
                            latticeDimensions: { type: 'ARRAY', items: { type: 'NUMBER' }, description: '[nx, ny, nz], each 2..8.' },
                            latticeOffsets: {
                                type: 'ARRAY',
                                description: 'Control point moves: { i, j, k, offset: [dx, dy, dz] as fractions of the box size }.',
                                items: {
                                    type: 'OBJECT',
                                    properties: {
                                        i: { type: 'NUMBER' },
                                        j: { type: 'NUMBER' },
                                        k: { type: 'NUMBER' },
                                        offset: { type: 'ARRAY', items: { type: 'NUMBER' } }
                                    }
                                }
                            },
                            subdivideIterations: { type: 'NUMBER', description: '1, 2 or 3.' },
                            weatheringIntensity: { type: 'NUMBER', description: 'Vertex colour variation amplitude.' },
                            weatheringScale: { type: 'NUMBER', description: 'Noise cycles across the mesh (> 0).' }
                        },
                        required: ['type']
                    }
                },
                inputGlbPath: INPUT_GLB_PARAMETER,
                outputGlbPath: {
                    type: 'STRING',
                    description: 'Optional path where the deformed binary glTF 2.0 (.glb) is written.'
                }
            },
            required: ['operations', 'inputGlbPath']
        }
    }
];

const reshaperService = new NativeMeshReshaperService();

export const meshShapingHandlers: Record<string, ToolHandler> = {
    mesh_apply_deformers: async (args, _ctx) => {
        const operations = Array.isArray(args.operations) ? (args.operations as MeshDeformationOp[]) : [];
        if (operations.length === 0) {
            throw new MissingInputError('mesh_apply_deformers', 'operations', 'give at least one deformation operation; none is chosen for you');
        }
        const inputGlbPath = await requireInputGlb('mesh_apply_deformers', args.inputGlbPath);
        const outputGlbPath = asString(args.outputGlbPath) || undefined;

        // Invalid operations, a failed native run, or a run that reports no output all throw (typed errors).
        const result = await reshaperService.reshapeMesh({ operations, inputGlbPath, outputGlbPath });
        const t = result.telemetry;

        return {
            status: 'completed',
            resultPayload: {
                status: 'success',
                success: true,
                outputGlbPath: result.outputGlbPath,
                telemetry: t,
                operationsApplied: result.operationsApplied
            },
            summaryResult: `Applied ${t.operationsCount} deformation(s) to ${inputGlbPath} (measured bounds ${fmt(t.inputBoundsMin)} to ${fmt(t.inputBoundsMax)}) in ${t.processingTimeMs.toFixed(1)} ms: ${t.outputVertices} vertices, ${t.outputTriangles} triangles. Output: ${result.outputGlbPath}`
        };
    }
};
