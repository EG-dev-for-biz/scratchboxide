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
import { NativeMeshEditService, type MeshEditOperation } from '../../3d-engine/native-mesh-edit-service';
import * as path from 'path';
import { TileRestyleService, type TileRestyleField, type TileRestyleForm, type TileRestyleSurface } from '../../3d-engine/tile-restyle-service';
import { resolveWithinRoot } from '../../security/path-guard';
import { MissingInputError } from '../../../common/errors/pipeline-errors';
import type { CanvasArtifact, Scene3DData } from '../../../browser/generative-canvas/canvas-types';
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

const XYZ: ToolParameterSchema = { type: 'ARRAY', items: { type: 'NUMBER' }, description: '[x, y, z]' };

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
    },
    {
        name: 'mesh_edit',
        description: 'Model a given 3D mesh (.glb) with explicit edits in the native C++20 engine, in order: '
            + 'boolean {op: union | subtract | intersect, operand: one of {glbPath} (another closed mesh), {box: {center, size, rotationDeg?}}, {cylinder: {start, end, radius, segments?}}, {sphere: {center, radius, segments?}}} - cut holes, slots and pockets, merge parts, trim to a shape; the cut faces keep sharp edges and a hole gets walls; '
            + 'cut {point, normal} - removes everything on the side the normal points to and caps the section; '
            + 'extrude {select, distance?, inset?} - the selected faces pulled inward by inset (metres, in their own plane, leaving a ring) and then moved by distance along their normals (negative pushes in: a recess), joined by side walls. '
            + 'select = {direction?, coneDeg? (default 30), regionMin?, regionMax?}: faces whose normal is within coneDeg of direction AND whose centre lies in the box [regionMin, regionMax] given as fractions of the mesh\'s bounds (0 = min, 1 = max per axis); give both when a direction alone would also catch faces elsewhere (a hole\'s far wall faces the same way as the outer face). '
            + 'All lengths and positions are metres in the mesh\'s own space; read the mesh\'s bounds first if you do not know them. Booleans need closed solids. '
            + 'The result reports each edit\'s counts and openEdges (0 = still a closed solid). Normals are hard across edges sharper than creaseDeg (default 30). '
            + 'Works on an untextured mesh with one material and no node transforms; anything else is refused with the reason.',
        parameters: {
            type: 'OBJECT',
            properties: {
                operations: {
                    type: 'ARRAY',
                    description: 'Edits to apply, in order; see the tool description for what each type needs.',
                    items: {
                        type: 'OBJECT',
                        properties: {
                            type: { type: 'STRING', description: 'boolean, cut or extrude.' },
                            op: { type: 'STRING', description: 'boolean: union, subtract or intersect.' },
                            operand: {
                                type: 'OBJECT',
                                description: 'boolean: the other solid, exactly one of glbPath, box, cylinder, sphere.',
                                properties: {
                                    glbPath: { type: 'STRING', description: 'Another closed .glb mesh, in the same space.' },
                                    box: { type: 'OBJECT', properties: { center: XYZ, size: XYZ, rotationDeg: XYZ } },
                                    cylinder: { type: 'OBJECT', properties: { start: XYZ, end: XYZ, radius: { type: 'NUMBER' }, segments: { type: 'NUMBER' } } },
                                    sphere: { type: 'OBJECT', properties: { center: XYZ, radius: { type: 'NUMBER' }, segments: { type: 'NUMBER' } } }
                                }
                            },
                            point: { type: 'ARRAY', items: { type: 'NUMBER' }, description: 'cut: a point on the plane [x, y, z].' },
                            normal: { type: 'ARRAY', items: { type: 'NUMBER' }, description: 'cut: the side removed [x, y, z].' },
                            select: {
                                type: 'OBJECT',
                                description: 'extrude: which faces.',
                                properties: {
                                    direction: XYZ,
                                    coneDeg: { type: 'NUMBER' },
                                    regionMin: { type: 'ARRAY', items: { type: 'NUMBER' }, description: 'Fractions of the bounds [u, v, w].' },
                                    regionMax: { type: 'ARRAY', items: { type: 'NUMBER' }, description: 'Fractions of the bounds [u, v, w].' }
                                }
                            },
                            distance: { type: 'NUMBER', description: 'extrude: metres along the normals (negative = into the surface).' },
                            inset: { type: 'NUMBER', description: 'extrude: metres inward in the faces\' plane (>= 0).' }
                        },
                        required: ['type']
                    }
                },
                inputGlbPath: INPUT_GLB_PARAMETER,
                outputGlbPath: { type: 'STRING', description: 'Optional path where the edited binary glTF 2.0 (.glb) is written.' },
                creaseDeg: { type: 'NUMBER', description: 'Optional: normals are smooth across edges shallower than this, hard across sharper ones (default 30).' }
            },
            required: ['operations', 'inputGlbPath']
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
const meshEditService = new NativeMeshEditService();
const tileRestyleService = new TileRestyleService();

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
    },

    mesh_edit: async (args, _ctx) => {
        const operations = Array.isArray(args.operations) ? (args.operations as MeshEditOperation[]) : [];
        if (operations.length === 0) {
            throw new MissingInputError('mesh_edit', 'operations', 'give at least one edit; none is chosen for you');
        }
        const inputGlbPath = await requireInputGlb('mesh_edit', args.inputGlbPath);
        const r = await meshEditService.edit({
            inputGlbPath, operations,
            ...(asString(args.outputGlbPath) ? { outputGlbPath: asString(args.outputGlbPath) } : {}),
            ...(typeof args.creaseDeg === 'number' ? { creaseDeg: args.creaseDeg } : {})
        });
        const each = r.operations.map(o => o.type === 'extrude'
            ? `extrude: ${o.selectedFaces} faces selected, ${o.boundaryEdges} boundary edges`
            : `${o.type}: ${o.trianglesBefore} -> ${o.trianglesAfter} triangles`).join('; ');
        return {
            status: 'completed',
            resultPayload: { status: 'success', success: true, ...r },
            summaryResult: `Edited ${path.basename(inputGlbPath)} (${each}): ${r.outputTriangles} triangles, ${r.openEdges === 0 ? 'a closed solid' : `${r.openEdges} open edges`}, bounds ${fmt(r.boundsMin)} to ${fmt(r.boundsMax)}. Output: ${r.outputGlbPath}`
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
