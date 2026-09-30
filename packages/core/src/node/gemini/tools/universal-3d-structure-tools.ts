/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
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
type ProceduralGeometryType = 'box' | 'sphere' | 'cylinder' | 'torus';
import type { ToolDeclaration, ToolHandler } from './types';

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
            'Synthesizes or initializes a canonical Universal 3D Structure Foundation (Universal3DStructureFoundation) maintaining synchronized solid mesh geometry, surface point clouds for 3DGS, calibrated 6-DoF camera rigs, physics collision envelope (AABB, sphere, convex bumper hull), and WGS-84 real-world anchors.',
        parameters: {
            type: 'OBJECT',
            properties: {
                name: {
                    type: 'STRING',
                    description: 'Descriptive identifier for the 3D entity (e.g. "Matterhorn_Complex", "City_District_Block").'
                },
                proceduralType: {
                    type: 'STRING',
                    enum: ['box', 'sphere', 'cylinder', 'plane', 'alpine_matterhorn'],
                    description: 'Procedural geometric type to synthesize. Default is "box".'
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
                    enum: ['box', 'sphere', 'cylinder', 'plane', 'alpine_matterhorn'],
                    description: 'Procedural geometric type to synthesize if not already in cache. Default is "box".'
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
                    description: 'Name of the structure to animate.'
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
                cameraTrajectory: {
                    type: 'STRING',
                    enum: ['arc', 'orbit', 'push_in'],
                    description: 'Standard camera motion trajectory to synthesize. Default is "arc".'
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
            'Extracts the metric collision envelope from a Universal 3D Structure, including axis-aligned bounding box (AABB), bounding sphere, and simplified convex bumper hull vertices and triangular faces for physics simulation or drone obstacle avoidance.',
        parameters: {
            type: 'OBJECT',
            properties: {
                name: {
                    type: 'STRING',
                    description: 'Name of the structure to inspect.'
                },
                proceduralType: {
                    type: 'STRING',
                    enum: ['box', 'sphere', 'cylinder', 'plane', 'alpine_matterhorn'],
                    description: 'Procedural type to synthesize if not cached. Default is "box".'
                },
                scale: {
                    type: 'NUMBER',
                    description: 'Metric scale factor. Default is 10.0.'
                }
            }
        }
    }
];

function getOrCreateStructure(
    name: string,
    proceduralType: string = 'box',
    scale: number = 10.0,
    center: [number, number, number] = [0, 0, 0],
    numViews: number = 24,
    pointDensity: number = 2000,
    anchor?: { lat: number; lng: number; elevationMeters: number }
): Universal3DStructureFoundation {
    const key = name || 'default_structure';
    let structure = activeStructureCache.get(key);
    if (!structure) {
        if (proceduralType === 'alpine_matterhorn') {
            structure = Universal3DStructureFoundation.createAlpineMatterhornComplex();
        } else {
            structure = Universal3DStructureFoundation.createFromProcedural(
                (proceduralType as ProceduralGeometryType) || 'box',
                {
                    name: key,
                    scale,
                    center,
                    numViews,
                    pointDensity,
                    anchor
                }
            );
        }
        activeStructureCache.set(key, structure);
    }
    return structure;
}

export const universal3DStructureHandlers: Record<string, ToolHandler> = {
    universal_3d_structure_create: async (args, _ctx) => {
        const name = asString(args.name) || 'structure_' + Date.now();
        const proceduralType = asString(args.proceduralType) || 'box';
        const scale = asNumber(args.scale, 10.0);
        const center = (Array.isArray(args.center) && args.center.length === 3)
            ? (args.center as [number, number, number])
            : [0, 0, 0] as [number, number, number];
        const numViews = asNumber(args.numViews, 24);
        const pointDensity = asNumber(args.pointDensity, 2000);
        const anchor = (typeof args.anchor === 'object' && args.anchor !== null)
            ? (args.anchor as { lat: number; lng: number; elevationMeters: number })
            : undefined;

        // Force recreation if explicitly requested
        activeStructureCache.delete(name);
        const structure = getOrCreateStructure(name, proceduralType, scale, center, numViews, pointDensity, anchor);

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
            anchor: structure.anchor
        };

        return {
            resultPayload: {
                success: true,
                structure: summary
            },
            summaryResult: `Created Universal 3D Structure Foundation "${structure.name}" (${proceduralType}): ${summary.vertexCount} vertices, ${summary.triangleCount} triangles, ${summary.pointCount} 3DGS point seeds, ${summary.cameraCount} calibrated cameras, collision hull (${summary.collisionHull.type}).`
        };
    },

    universal_3d_structure_export: async (args, ctx) => {
        const name = asString(args.name) || 'default_structure';
        const proceduralType = asString(args.proceduralType) || 'box';
        const format = asString(args.format) as Target3DFormat | 'all';
        const outputDir = asString(args.outputDir) || undefined;
        const includeAnimations = args.includeAnimations !== false;

        const structure = getOrCreateStructure(name, proceduralType);

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

    universal_3d_structure_animate: async (args, _ctx) => {
        const name = asString(args.name) || 'default_structure';
        const clipName = asString(args.clipName) || 'Hero Camera Arc';
        const durationSeconds = asNumber(args.durationSeconds, 4.0);
        const fps = asNumber(args.fps, 24);
        const cameraTrajectory = asString(args.cameraTrajectory) || 'arc';
        const mountToVideoTimeline = !!args.mountToVideoTimeline;
        const timelineStartTime = asNumber(args.timelineStartTime, 0.0);

        const structure = getOrCreateStructure(name);

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

    universal_3d_structure_get_collision_hull: async (args, _ctx) => {
        const name = asString(args.name) || 'default_structure';
        const proceduralType = asString(args.proceduralType) || 'box';
        const scale = asNumber(args.scale, 10.0);

        const structure = getOrCreateStructure(name, proceduralType, scale);
        const hull = structure.toCollisionHull();

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
