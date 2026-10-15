/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { NativeMeshReshaperService, MeshDeformationOp } from '../../3d-engine/native-mesh-reshaper-service';
import * as path from 'path';
import { TileRestyleService, type TileRestyleField, type TileRestyleForm, type TileRestyleSurface } from '../../3d-engine/tile-restyle-service';
import { resolveWithinRoot } from '../../security/path-guard';
import type { CanvasArtifact, Scene3DData } from '../../../browser/generative-canvas/canvas-types';
import type { ToolDeclaration, ToolHandler } from './types';

function asString(val: unknown): string {
    return typeof val === 'string' ? val : '';
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
        name: 'tile_restyle',
        description: 'Restyle the real 3D tile (Google Photorealistic 3D Tiles GLB) open in the active 3D scene, keeping its photo textures. ' +
            'There are no style names: translate the requested look (e.g. "brutalist fortress", "overgrown ruin", "terraced citadel") into continuous quantities. ' +
            'fields edit the tile\'s own surface inside a radius (raise/sink, level, terrace, wave relief); forms add new geometry built from a revolve ' +
            '(radial profile with harmonic lobes and helical twist) or a sweep (tube along a path with taper and twist), each optionally replicated around a ring or along a row; ' +
            'surface regrades the photo textures toward a colour palette. Placement uses tile-normalised [u, v] in [-1, 1] across the tile; heights are metres above the local surface. ' +
            'The result replaces the tile in the open scene.',
        parameters: {
            type: 'OBJECT',
            properties: {
                objectId: { type: 'STRING', description: 'id of the tile object in the scene; defaults to the first object with a .glb.' },
                fields: {
                    type: 'ARRAY',
                    description: 'Edits to the tile surface, applied in order.',
                    items: {
                        type: 'OBJECT',
                        properties: {
                            center: { type: 'ARRAY', items: { type: 'NUMBER' }, description: '[u, v] in [-1, 1].' },
                            radiusMeters: { type: 'NUMBER' },
                            blendMeters: { type: 'NUMBER', description: 'Smooth falloff width outside the radius.' },
                            offsetMeters: { type: 'NUMBER', description: 'Raise (+) or sink (-).' },
                            levelMeters: { type: 'NUMBER', description: 'Height above the tile datum to flatten toward.' },
                            levelWeight: { type: 'NUMBER', description: '0..1 strength of the levelling.' },
                            terraceStepMeters: { type: 'NUMBER', description: 'Quantise heights into steps of this size (0 = off).' },
                            reliefAmplitudeMeters: { type: 'NUMBER', description: 'Normal-direction wave relief amplitude (0 = off).' },
                            reliefWavelengthMeters: { type: 'NUMBER' },
                            reliefHeadingDeg: { type: 'NUMBER' }
                        },
                        required: ['center', 'radiusMeters']
                    }
                },
                forms: {
                    type: 'ARRAY',
                    description: 'New geometry. A form with a path of 2+ points is a sweep; otherwise its profile is revolved.',
                    items: {
                        type: 'OBJECT',
                        properties: {
                            center: { type: 'ARRAY', items: { type: 'NUMBER' }, description: '[u, v] in [-1, 1].' },
                            baseOffsetMeters: { type: 'NUMBER' },
                            groundSnap: { type: 'BOOLEAN', description: 'Sit on the tile surface (default true).' },
                            rotationYDeg: { type: 'NUMBER' },
                            profile: { type: 'ARRAY', items: { type: 'ARRAY', items: { type: 'NUMBER' } }, description: 'Revolve: [radiusMeters, heightMeters] pairs, bottom to top.' },
                            segments: { type: 'NUMBER' },
                            lobes: { type: 'NUMBER', description: 'Harmonic lobe count K (0 smooth, 2-6 fluted/auger, 12+ ribbed).' },
                            lobeAmplitude: { type: 'NUMBER', description: 'Relative radius modulation of the lobes.' },
                            helixTurns: { type: 'NUMBER' },
                            path: { type: 'ARRAY', items: { type: 'ARRAY', items: { type: 'NUMBER' } }, description: 'Sweep: [x, y, z] metres relative to the form origin, y up.' },
                            radiusStartMeters: { type: 'NUMBER' },
                            radiusEndMeters: { type: 'NUMBER' },
                            sides: { type: 'NUMBER' },
                            twistTurns: { type: 'NUMBER' },
                            replicate: {
                                type: 'OBJECT',
                                properties: {
                                    count: { type: 'NUMBER' },
                                    ringRadiusMeters: { type: 'NUMBER', description: '> 0 places copies around a ring.' },
                                    stepMeters: { type: 'ARRAY', items: { type: 'NUMBER' }, description: 'Otherwise [dx, dz] between copies in a row.' }
                                }
                            },
                            material: {
                                type: 'OBJECT',
                                properties: {
                                    albedo: { type: 'ARRAY', items: { type: 'NUMBER' }, description: 'Linear RGB 0..1.' },
                                    roughness: { type: 'NUMBER' },
                                    metalness: { type: 'NUMBER' },
                                    emissive: { type: 'ARRAY', items: { type: 'NUMBER' } }
                                }
                            }
                        },
                        required: ['center']
                    }
                },
                surface: {
                    type: 'OBJECT',
                    description: 'Regrade the photo textures toward a palette (hex colours) with tone controls.',
                    properties: {
                        shadowHex: { type: 'STRING' },
                        midtoneHex: { type: 'STRING' },
                        highlightHex: { type: 'STRING' },
                        accentHex: { type: 'STRING' },
                        shadowLift: { type: 'NUMBER' },
                        highlightCompress: { type: 'NUMBER' },
                        protectFoliage: { type: 'BOOLEAN' },
                        protectAsphalt: { type: 'BOOLEAN' }
                    }
                }
            }
        }
    }
];

const reshaperService = new NativeMeshReshaperService();
const tileRestyleService = new TileRestyleService();

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

    tile_restyle: async (args, ctx) => {
        const artifact = ctx.request.activeArtifact as CanvasArtifact | undefined;
        if (!artifact || artifact.type !== '3d-scene' || !artifact.data) {
            return { status: 'failed', resultPayload: { success: false, error: 'tile_restyle needs an open 3D scene with a tile in it.' } };
        }
        const scene = artifact.data as Scene3DData;
        const objects = scene.objects || [];
        const objectId = asString(args.objectId);
        const isGlb = (o: (typeof objects)[number]) => /\.glb$/i.test(o.content?.durableUri || '');
        const target = objectId ? objects.find(o => o.id === objectId) : objects.find(isGlb);
        if (!target || !isGlb(target)) {
            return { status: 'failed', resultPayload: { success: false, error: objectId ? `No .glb object "${objectId}" in the scene.` : 'The open scene has no .glb tile object.' } };
        }

        const publicRoot = path.join(process.cwd(), 'public');
        const uri = target.content!.durableUri!;
        const inputGlbPath = resolveWithinRoot(publicRoot, uri.replace(/^\/+/, ''));
        const stem = path.basename(inputGlbPath, '.glb').replace(/_restyled_\d+$/, '');
        const outputGlbPath = path.join(path.dirname(inputGlbPath), `${stem}_restyled_${Date.now()}.glb`);

        try {
            ctx.reportProgress?.('Restyling the tile with the native engine');
            const result = await tileRestyleService.restyle({
                inputGlbPath,
                outputGlbPath,
                fields: Array.isArray(args.fields) ? (args.fields as TileRestyleField[]) : [],
                forms: Array.isArray(args.forms) ? (args.forms as TileRestyleForm[]) : [],
                surface: args.surface && typeof args.surface === 'object' ? (args.surface as TileRestyleSurface) : undefined
            });
            const outputUri = '/' + path.relative(publicRoot, outputGlbPath).split(path.sep).join('/');
            const restyledObject = {
                ...target,
                content: {
                    ...target.content!,
                    durableUri: outputUri,
                    metadata: {
                        ...(target.content!.metadata || {}),
                        restyledFrom: (target.content!.metadata as any)?.restyledFrom || uri,
                        restyle: { fields: args.fields, forms: args.forms, surface: args.surface }
                    }
                },
                lineage: { ...(target.lineage || {}), version: ((target.lineage as any)?.version || 1) + 1 }
            };
            const updated: CanvasArtifact = {
                ...artifact,
                version: (artifact.version || 1) + 1,
                data: { ...scene, objects: objects.map(o => (o === target ? restyledObject : o)) } as Scene3DData
            };
            const summary = `Restyled ${path.basename(inputGlbPath)}: ${result.movedVertices.toLocaleString()} of ${result.vertexCount.toLocaleString()} tile vertices moved ` +
                `(max ${result.maxDisplacementMeters.toFixed(2)} m), ${result.formMeshes} new form${result.formMeshes === 1 ? '' : 's'} ` +
                `(${result.formVertices.toLocaleString()} vertices)` + (result.texturesRegraded ? `, ${result.texturesRegraded} textures regraded` : '') +
                ` in ${(result.durationMs / 1000).toFixed(1)} s.`;
            return {
                status: 'completed',
                resultPayload: { success: true, ...result, durableUri: outputUri, artifact: updated },
                summaryResult: summary
            };
        } catch (err: any) {
            return { status: 'failed', resultPayload: { success: false, error: err?.message || String(err) } };
        }
    },
};
