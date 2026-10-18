/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as path from 'path';
import * as fs from 'fs';
import { Universal3DStructureFoundation } from '../../spatial/Universal3DStructureFoundation';
import {
    toTimelineElement,
    fromVideoDiffusionCameraBlockout,
    type UniversalAnimationClip
} from '../../../common/spatial/universal-animation-types';
import type {
    Target3DFormat
} from '../../../common/spatial/universal-3d-structure-types';
import type { CollisionEnvelopeOptions } from '../../../common/spatial/universal-3d-structure-types';
import type { ToolDeclaration, ToolHandler } from './types';

/** Analytic primitives the foundation can mesh and sample; anything else comes in through inputGlbPath. */
const PROCEDURAL_SHAPES = ['box', 'sphere', 'cylinder', 'torus'] as const;
type ProceduralShape = typeof PROCEDURAL_SHAPES[number];
const PROCEDURAL_TYPE_VALUES = [...PROCEDURAL_SHAPES, 'alpine_matterhorn'];
const COLLISION_MODES: NonNullable<CollisionEnvelopeOptions['mode']>[] = ['aabb', 'obb', 'convex_hull', 'inflated_bumper'];

/** No cached structure by that name and no source (proceduralType or inputGlbPath) to build one from. */
export class UnknownUniversalStructureError extends Error {
    readonly code = 'UNIVERSAL_STRUCTURE_NOT_FOUND';
    constructor(name: string, cached: string[]) {
        super(
            `No Universal 3D Structure named "${name}" exists in this session` +
            (cached.length ? ` (cached: ${cached.join(', ')})` : ' (none cached yet)') +
            '. Create it first with universal_3d_structure_create, or pass proceduralType or inputGlbPath to build it.'
        );
        this.name = 'UnknownUniversalStructureError';
    }
}

/** A tool argument outside what the foundation actually implements. */
export class UniversalStructureArgumentError extends Error {
    readonly code = 'UNIVERSAL_STRUCTURE_BAD_ARGUMENT';
    constructor(message: string) {
        super(message);
        this.name = 'UniversalStructureArgumentError';
    }
}

interface StructureSource {
    proceduralType?: string;
    inputGlbPath?: string;
    scale?: number;
    center?: [number, number, number];
    numViews?: number;
    pointDensity?: number;
    seed?: number;
    anchor?: { lat: number; lng: number; elevationMeters: number };
}

interface GlbScope {
    path: string;
    meshesInFile: number;
    primitivesInFile: number;
    ingested: string;
}
const glbScopeCache = new Map<string, GlbScope>();

function asString(val: unknown, fallback = ''): string {
    return typeof val === 'string' ? val : fallback;
}

function asNumber(val: unknown, fallback = 0): number {
    return typeof val === 'number' && !Number.isNaN(val) ? val : fallback;
}

// In-memory cache of active structures so multi-turn agent calls can reference them by name
const activeStructureCache = new Map<string, Universal3DStructureFoundation>();

export const UNIVERSAL_3D_STRUCTURE_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'universal_3d_structure_create',
        description:
            'Synthesizes or initializes a canonical Universal 3D Structure Foundation (Universal3DStructureFoundation) maintaining synchronized solid mesh geometry, surface point clouds for 3DGS, calibrated 6-DoF camera rigs, physics collision envelope (AABB, bounding sphere, PCA-oriented OBB; exact convex hull via universal_3d_structure_get_collision_hull), and WGS-84 real-world anchors. Build from an analytic primitive (proceduralType) or ingest an existing .glb (inputGlbPath).',
        parameters: {
            type: 'OBJECT',
            properties: {
                name: {
                    type: 'STRING',
                    description: 'Descriptive identifier for the 3D entity (e.g. "Matterhorn_Complex", "City_District_Block").'
                },
                proceduralType: {
                    type: 'STRING',
                    enum: PROCEDURAL_TYPE_VALUES,
                    description: 'Analytic primitive to synthesize (box, sphere, cylinder, torus) or the alpine_matterhorn complex. Default is "box" when inputGlbPath is not given.'
                },
                scale: {
                    type: 'NUMBER',
                    description: 'Uniform metric scale factor (in meters). Default is 10.0.'
                },
                center: {
                    type: 'ARRAY',
                    items: { type: 'NUMBER' },
                    description: '3D spatial center coordinates [x, y, z] in meters. Default is [0, 0, 0].'
                },
                numViews: {
                    type: 'NUMBER',
                    description: 'Number of calibrated 6-DoF camera viewpoints to generate on the observation rig. Default is 24.'
                },
                pointDensity: {
                    type: 'NUMBER',
                    description: 'Number of surface points to sample into the point cloud constellation for 3DGS seeds. Default is 2000.'
                },
                seed: {
                    type: 'NUMBER',
                    description: 'Seed for surface point sampling. Equal seeds give identical point sets. Default 1.'
                },
                inputGlbPath: {
                    type: 'STRING',
                    description: 'Path to a binary glTF 2.0 (.glb) to ingest as the structure (workspace-relative or absolute). Reads the first primitive of the first mesh; the result reports how much of the file that covers.'
                },
                anchor: {
                    type: 'OBJECT',
                    properties: {
                        lat: { type: 'NUMBER', description: 'WGS-84 Latitude (-90 to +90).' },
                        lng: { type: 'NUMBER', description: 'WGS-84 Longitude (-180 to +180).' },
                        elevationMeters: { type: 'NUMBER', description: 'WGS-84 Elevation above sea level in meters.' }
                    },
                    description: 'Real-world geographic anchor coordinates.'
                }
            }
        }
    },
    {
        name: 'universal_3d_structure_export',
        description:
            'Exports a Universal 3D Structure Foundation deterministically outward to any supported target format: binary glTF 2.0 (.glb), COLMAP (cameras/images/points3D), Nerfstudio (transforms.json + sparse_pcd.ply for 3DGS), video camera blockout (<VIDEO_REF_0>), physics collision hull, GeoJSON, or animation tracks.',
        parameters: {
            type: 'OBJECT',
            properties: {
                name: {
                    type: 'STRING',
                    description: 'Name of the cached structure or new structure to export. Default is "default_structure".'
                },
                proceduralType: {
                    type: 'STRING',
                    enum: PROCEDURAL_TYPE_VALUES,
                    description: 'Primitive to synthesize if no structure with this name is cached. Without it (or inputGlbPath) an unknown name is an error.'
                },
                inputGlbPath: {
                    type: 'STRING',
                    description: 'Path to a binary glTF 2.0 (.glb) to ingest as the structure (workspace-relative or absolute). Reads the first primitive of the first mesh; the result reports how much of the file that covers.'
                },
                format: {
                    type: 'STRING',
                    enum: ['glb', 'colmap', 'nerfstudio', 'video_blockout', 'collision_hull', 'geojson', 'animation_track', 'all'],
                    description: 'Target export format. Use "all" to generate all formats concurrently.'
                },
                outputDir: {
                    type: 'STRING',
                    description: 'Optional path on disk to write the exported file(s). If omitted, returns in-memory serialized data.'
                },
                includeAnimations: {
                    type: 'BOOLEAN',
                    description: 'Whether to compile glTF 2.0 binary animation samplers and channels into the .glb export.'
                }
            },
            required: ['format']
        }
    },
    {
        name: 'universal_3d_structure_animate',
        description:
            'Adds continuous-time animation tracks/clips (time in seconds, sub-frame LERP/SLERP) to a Universal 3D Structure, compiles binary glTF 2.0 animation samplers, and bridges directly to the Video Timeline NLE primitive with interactive keyframe diamond markers.',
        parameters: {
            type: 'OBJECT',
            properties: {
                name: {
                    type: 'STRING',
                    description: 'Name of a structure created earlier with universal_3d_structure_create. The clip follows that structure\'s calibrated camera rig in order.'
                },
                clipName: {
                    type: 'STRING',
                    description: 'Descriptive title for the animation clip (e.g. "Hero Camera Arc", "Orbital Survey").'
                },
                durationSeconds: {
                    type: 'NUMBER',
                    description: 'Duration of the animation clip in continuous seconds. Default is 4.0.'
                },
                fps: {
                    type: 'NUMBER',
                    description: 'Target frame rate for discrete display rendering. Default is 24.'
                },
                mountToVideoTimeline: {
                    type: 'BOOLEAN',
                    description: 'If true, automatically formats and returns an NLE TimelineElement with keyframe diamond offsets for the Video Timeline primitive.'
                },
                timelineStartTime: {
                    type: 'NUMBER',
                    description: 'In-point timestamp (in seconds) on the master Video Timeline. Default is 0.0.'
                }
            }
        }
    },
    {
        name: 'universal_3d_structure_get_collision_hull',
        description:
            'Extracts the metric collision envelope from a Universal 3D Structure: axis-aligned bounding box (AABB), bounding sphere, and the chosen envelope polyhedron (PCA-oriented OBB by default, exact Quickhull convex hull, or margin-inflated bumper) as vertices and triangular faces for physics simulation or drone obstacle avoidance.',
        parameters: {
            type: 'OBJECT',
            properties: {
                name: {
                    type: 'STRING',
                    description: 'Name of the structure to inspect.'
                },
                proceduralType: {
                    type: 'STRING',
                    enum: PROCEDURAL_TYPE_VALUES,
                    description: 'Primitive to synthesize if no structure with this name is cached. Without it (or inputGlbPath) an unknown name is an error.'
                },
                inputGlbPath: {
                    type: 'STRING',
                    description: 'Path to a .glb to ingest if no structure with this name is cached.'
                },
                scale: {
                    type: 'NUMBER',
                    description: 'Metric scale factor. Default is 10.0.'
                },
                mode: {
                    type: 'STRING',
                    enum: COLLISION_MODES,
                    description: 'Envelope to compute: "aabb", "obb" (PCA-oriented box, default), "convex_hull" (exact Quickhull of the mesh vertices), or "inflated_bumper" (OBB grown by safetyMarginMeters).'
                },
                safetyMarginMeters: {
                    type: 'NUMBER',
                    description: 'Margin added to aabb / inflated_bumper envelopes. Not supported for convex_hull.'
                }
            }
        }
    }
];

function readStructureSource(args: Record<string, unknown>): StructureSource {
    const center = (Array.isArray(args.center) && args.center.length === 3 && args.center.every(c => typeof c === 'number'))
        ? (args.center as [number, number, number])
        : undefined;
    const anchor = (typeof args.anchor === 'object' && args.anchor !== null)
        ? (args.anchor as { lat: number; lng: number; elevationMeters: number })
        : undefined;
    return {
        proceduralType: asString(args.proceduralType) || undefined,
        inputGlbPath: asString(args.inputGlbPath) || undefined,
        scale: typeof args.scale === 'number' ? args.scale : undefined,
        center,
        numViews: typeof args.numViews === 'number' ? args.numViews : undefined,
        pointDensity: typeof args.pointDensity === 'number' ? args.pointDensity : undefined,
        seed: typeof args.seed === 'number' ? args.seed : undefined,
        anchor
    };
}

function countGlbPrimitives(glb: Buffer): { meshes: number; primitives: number } {
    if (glb.length < 20 || glb.readUInt32LE(0) !== 0x46546C67) {
        return { meshes: 0, primitives: 0 };
    }
    const jsonLength = glb.readUInt32LE(12);
    const gltf = JSON.parse(glb.subarray(20, 20 + jsonLength).toString('utf8'));
    const meshes: Array<{ primitives?: unknown[] }> = Array.isArray(gltf.meshes) ? gltf.meshes : [];
    return { meshes: meshes.length, primitives: meshes.reduce((n, m) => n + (m.primitives?.length ?? 0), 0) };
}

function buildStructure(key: string, source: StructureSource, workspaceRoot: string): Universal3DStructureFoundation {
    if (source.inputGlbPath && source.proceduralType) {
        throw new UniversalStructureArgumentError('Pass either inputGlbPath or proceduralType, not both.');
    }
    if (source.inputGlbPath) {
        const resolved = path.isAbsolute(source.inputGlbPath) ? source.inputGlbPath : path.join(workspaceRoot, source.inputGlbPath);
        if (!fs.existsSync(resolved)) {
            throw new UniversalStructureArgumentError(`inputGlbPath does not exist: ${resolved}`);
        }
        const glb = fs.readFileSync(resolved);
        const structure = Universal3DStructureFoundation.createFromGlb(glb, {
            name: key,
            anchor: source.anchor,
            numViews: source.numViews,
            pointDensity: source.pointDensity,
            seed: source.seed
        });
        const counts = countGlbPrimitives(glb);
        glbScopeCache.set(key, {
            path: resolved,
            meshesInFile: counts.meshes,
            primitivesInFile: counts.primitives,
            ingested: counts.primitives > 1
                ? `first primitive of the first mesh only (1 of ${counts.primitives} primitives); node transforms are not applied`
                : 'whole file (single primitive); node transforms are not applied'
        });
        return structure;
    }
    const proceduralType = source.proceduralType ?? 'box';
    if (proceduralType === 'alpine_matterhorn') {
        return Universal3DStructureFoundation.createAlpineMatterhornComplex();
    }
    if (!(PROCEDURAL_SHAPES as readonly string[]).includes(proceduralType)) {
        throw new UniversalStructureArgumentError(
            `proceduralType "${proceduralType}" is not implemented. Supported: ${PROCEDURAL_TYPE_VALUES.join(', ')}. For any other shape, build it as a .glb and pass inputGlbPath.`
        );
    }
    return Universal3DStructureFoundation.createFromProcedural(proceduralType as ProceduralShape, {
        name: key,
        scale: source.scale ?? 10.0,
        center: source.center ?? [0, 0, 0],
        numViews: source.numViews ?? 24,
        pointDensity: source.pointDensity ?? 2000,
        seed: source.seed,
        anchor: source.anchor
    });
}

/**
 * Returns the cached structure, or builds it when the caller names a source.
 * An unknown name with no source is an error: there is no default shape.
 */
function resolveStructure(name: string, source: StructureSource, workspaceRoot: string): Universal3DStructureFoundation {
    const cached = activeStructureCache.get(name);
    if (cached) return cached;
    if (!source.proceduralType && !source.inputGlbPath) {
        throw new UnknownUniversalStructureError(name, [...activeStructureCache.keys()]);
    }
    const structure = buildStructure(name, source, workspaceRoot);
    activeStructureCache.set(name, structure);
    return structure;
}

export const universal3DStructureHandlers: Record<string, ToolHandler> = {
    universal_3d_structure_create: async (args, ctx) => {
        const name = asString(args.name) || 'structure_' + Date.now();
        const source = readStructureSource(args);
        if (!source.inputGlbPath && !source.proceduralType) {
            source.proceduralType = 'box';
        }
        const sourceLabel = source.inputGlbPath ? `glb ${source.inputGlbPath}` : source.proceduralType!;

        // create always rebuilds
        activeStructureCache.delete(name);
        glbScopeCache.delete(name);
        const structure = resolveStructure(name, source, ctx.workspaceRoot || process.cwd());
        const glbScope = glbScopeCache.get(name);

        const summary = {
            name: structure.name,
            vertexCount: structure.mesh.vertices.length / 3,
            triangleCount: structure.mesh.indices ? structure.mesh.indices.length / 3 : 0,
            pointCount: structure.points.length,
            cameraCount: structure.cameras.length,
            boundingBox: structure.boundingBox,
            collisionHull: {
                type: structure.collisionHull.type,
                center: structure.collisionHull.center,
                dimensions: structure.collisionHull.dimensions,
                vertexCount: structure.collisionHull.convexVertices ? structure.collisionHull.convexVertices.length : 0,
                faceCount: structure.collisionHull.indices ? structure.collisionHull.indices.length / 3 : 0
            },
            anchor: structure.anchor,
            ...(glbScope ? { glbSource: glbScope } : {})
        };

        return {
            resultPayload: {
                success: true,
                structure: summary
            },
            summaryResult: `Created Universal 3D Structure Foundation "${structure.name}" (${sourceLabel}${glbScope ? `; ingested ${glbScope.ingested}` : ''}): ${summary.vertexCount} vertices, ${summary.triangleCount} triangles, ${summary.pointCount} 3DGS point seeds, ${summary.cameraCount} calibrated cameras, collision hull (${summary.collisionHull.type}).`
        };
    },

    universal_3d_structure_export: async (args, ctx) => {
        const name = asString(args.name) || 'default_structure';
        const format = asString(args.format) as Target3DFormat | 'all';
        const outputDir = asString(args.outputDir) || undefined;
        const includeAnimations = args.includeAnimations !== false;

        const structure = resolveStructure(name, readStructureSource(args), ctx.workspaceRoot || process.cwd());

        if (outputDir) {
            const resolvedDir = path.isAbsolute(outputDir) ? outputDir : path.join(ctx.workspaceRoot || process.cwd(), outputDir);
            const formatsToExport: Target3DFormat[] = format === 'all'
                ? ['glb', 'colmap', 'nerfstudio', 'video_blockout', 'collision_hull', 'geojson', 'animation_track']
                : [format as Target3DFormat];
            const diskResult = await structure.exportToDisk(resolvedDir, formatsToExport);
            const writtenCount = diskResult.filesWritten ? Object.keys(diskResult.filesWritten).length : 0;

            return {
                resultPayload: {
                    success: true,
                    outputDirectory: resolvedDir,
                    filesWritten: diskResult.filesWritten,
                    manifest: diskResult.manifestMarkdown
                },
                summaryResult: `Exported Universal 3D Structure "${structure.name}" to disk at ${resolvedDir} (${writtenCount} files written).`
            };
        }

        if (format === 'all') {
            const allExports = structure.exportAll();
            return {
                resultPayload: {
                    success: true,
                    glbBytes: allExports.glbBuffer ? allExports.glbBuffer.byteLength : 0,
                    colmapImagesCount: allExports.colmap ? allExports.colmap.imagesText.split('\n').filter(Boolean).length / 2 : 0,
                    nerfstudioTransformsFrames: allExports.nerfstudio ? JSON.parse(allExports.nerfstudio.transformsJson).frames.length : 0,
                    collisionHullVertices: allExports.collisionHull?.convexVertices ? allExports.collisionHull.convexVertices.length : 0,
                    geoJsonFeatures: allExports.geoJson ? (allExports.geoJson as any).features?.length || 0 : 0,
                    animationsCount: allExports.animations ? allExports.animations.length : 0
                },
                summaryResult: `Successfully generated all outward projections for Universal 3D Structure "${structure.name}".`
            };
        }

        let formatDetails: Record<string, unknown> = {};
        switch (format) {
            case 'glb': {
                const glbBuffer = structure.toGlbBuffer({ includeAnimations });
                formatDetails = { byteLength: glbBuffer.byteLength, isBinaryGlTF: glbBuffer.slice(0, 4).toString('ascii') === 'glTF' };
                break;
            }
            case 'colmap': {
                const colmap = structure.toColmap();
                formatDetails = {
                    camerasLineCount: colmap.camerasText.split('\n').length,
                    imagesLineCount: colmap.imagesText.split('\n').length,
                    points3DLineCount: colmap.points3DText.split('\n').length
                };
                break;
            }
            case 'nerfstudio': {
                const nerf = structure.toNerfstudio();
                const parsed = JSON.parse(nerf.transformsJson);
                formatDetails = {
                    cameraModel: parsed.camera_model,
                    frameCount: parsed.frames.length,
                    plyByteLength: Buffer.byteLength(nerf.sparsePcdPly, 'utf8')
                };
                break;
            }
            case 'video_blockout': {
                const blockout = structure.toVideoCameraBlockout();
                formatDetails = {
                    videoRef: blockout.videoRef,
                    frameCount: blockout.frameCount,
                    durationSeconds: blockout.durationSeconds,
                    fps: blockout.fps
                };
                break;
            }
            case 'collision_hull': {
                const hull = structure.toCollisionHull();
                formatDetails = {
                    type: hull.type,
                    center: hull.center,
                    dimensions: hull.dimensions,
                    vertexCount: hull.convexVertices ? hull.convexVertices.length : 0
                };
                break;
            }
            case 'geojson': {
                const geoJson = structure.toGeoJson();
                if (!geoJson) {
                    throw new Error('GeoJSON export needs the structure\'s geodetic anchor; this structure has none (no default place is used).');
                }
                formatDetails = {
                    featureCount: geoJson.features.length,
                    anchor: structure.anchor
                };
                break;
            }
            case 'animation_track': {
                const solveTrack = structure.toCameraSolveTrack();
                formatDetails = {
                    animationsCount: structure.animations.length,
                    cameraSolveTrack: solveTrack ? { id: solveTrack.id, frameCount: solveTrack.frames.length } : null
                };
                break;
            }
        }

        return {
            resultPayload: {
                success: true,
                format,
                details: formatDetails
            },
            summaryResult: `Exported Universal 3D Structure "${structure.name}" to format ${format}: ${JSON.stringify(formatDetails)}`
        };
    },

    universal_3d_structure_animate: async (args, ctx) => {
        const name = asString(args.name) || 'default_structure';
        const clipName = asString(args.clipName) || 'Hero Camera Arc';
        const durationSeconds = asNumber(args.durationSeconds, 4.0);
        const fps = asNumber(args.fps, 24);
        const mountToVideoTimeline = !!args.mountToVideoTimeline;
        const timelineStartTime = asNumber(args.timelineStartTime, 0.0);

        const structure = resolveStructure(name, readStructureSource(args), ctx.workspaceRoot || process.cwd());

        // Synthesize camera animation track
        const blockout = structure.toVideoCameraBlockout(fps);
        blockout.durationSeconds = durationSeconds;
        const clip = fromVideoDiffusionCameraBlockout(blockout, clipName);
        structure.addAnimation(clip);

        let timelineElement = null;
        if (mountToVideoTimeline) {
            timelineElement = toTimelineElement(clip, {
                startTime: timelineStartTime,
                trackId: 'track-3d-camera'
            });
        }

        return {
            resultPayload: {
                success: true,
                clipId: clip.id,
                clipName: clip.name,
                durationSeconds: clip.durationSeconds,
                tracksCount: clip.tracks.length,
                timelineElement
            },
            summaryResult: `Added continuous animation clip "${clip.name}" (${durationSeconds}s, ${fps} FPS, ${clip.tracks.length} tracks) to structure "${structure.name}".${timelineElement ? ' Mounted as NLE TimelineElement with keyframe diamonds.' : ''}`
        };
    },

    universal_3d_structure_get_collision_hull: async (args, ctx) => {
        const name = asString(args.name) || 'default_structure';
        const modeArg = asString(args.mode) || undefined;
        if (modeArg !== undefined && !(COLLISION_MODES as string[]).includes(modeArg)) {
            throw new UniversalStructureArgumentError(`mode "${modeArg}" is not implemented. Supported: ${COLLISION_MODES.join(', ')}.`);
        }
        const structure = resolveStructure(name, readStructureSource(args), ctx.workspaceRoot || process.cwd());
        const hull = modeArg || typeof args.safetyMarginMeters === 'number'
            ? structure.toCollisionHull({
                mode: (modeArg as CollisionEnvelopeOptions['mode']) ?? 'obb',
                safetyMarginMeters: typeof args.safetyMarginMeters === 'number' ? args.safetyMarginMeters : undefined
            })
            : structure.toCollisionHull();

        const payloadHull = {
            ...hull,
            aabb: {
                min: structure.boundingBox.min,
                max: structure.boundingBox.max,
                size: structure.boundingBox.extents
            },
            boundingSphere: {
                center: structure.boundingBox.center,
                radius: structure.boundingBox.boundingSphereRadius
            },
            vertices: hull.convexVertices || [],
            faces: hull.indices || []
        };

        return {
            resultPayload: {
                success: true,
                name: structure.name,
                collisionHull: payloadHull
            },
            summaryResult: `Collision Envelope for "${structure.name}": Type ${hull.type}, Center [${hull.center.map(v => v.toFixed(1)).join(', ')}], Dimensions [${hull.dimensions.map(v => v.toFixed(1)).join(', ')}].`
        };
    }
};
