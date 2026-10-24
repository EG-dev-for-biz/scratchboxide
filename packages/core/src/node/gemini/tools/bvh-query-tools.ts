/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { compileNativeCached, defaultNativeFlags } from '../../3d-engine/native-build-cache';
import { NativeCppCompilerService } from '../../3d-engine/native-compiler-service';
import type { ToolContext, ToolDeclaration, ToolHandler, ToolHandlerOutcome } from './types';

/**
 * BVH (Bounding Volume Hierarchy) query tools for spatial analysis on individual 3D objects.
 * Drives `scratchbox_bvh.hpp` (SAH-binned BVH: ray casting, closest-point, RTAO) against any GLB
 * mesh — a building, prop, scan, or scene — read natively via `scratchbox_gltf_scene.hpp`'s
 * GlbSceneReader, following the same compile-once/execFile pattern as the virtual geometry builder.
 */

const FLAGS = defaultNativeFlags();
const compiler = NativeCppCompilerService.getInstance();

function sdkIncludeDir(): string {
    return compiler.getSdkIncludePath();
}

async function compileAndRun(name: string, source: string, args: string[], timeoutMs = 2 * 60_000): Promise<string> {
    const result = await compileNativeCached({
        sourceCode: source,
        includeDirs: [sdkIncludeDir()],
        flags: FLAGS,
        // scratchbox_gltf_scene.hpp pulls in scratchbox_png.hpp's embedded-texture decode, which needs zlib.
        libs: ['-lz'],
        name
    });
    return new Promise<string>((resolve, reject) => {
        execFile(result.binaryPath, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) {
                (err as Error & { stderr?: string }).stderr = stderr;
                reject(err);
            } else {
                resolve(stdout);
            }
        });
    });
}

function lastJsonLine(stdout: string): unknown {
    const lines = stdout.trim().split('\n');
    return JSON.parse(lines[lines.length - 1] || '{}');
}

function tempPath(prefix: string, ext: string): string {
    return path.join(os.tmpdir(), `${prefix}-${process.pid}-${crypto.randomBytes(6).toString('hex')}.${ext}`);
}

export const BVH_QUERY_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'mesh_bvh_raycast',
        description: 'Cast rays through a 3D mesh (building, object, prop) using the native SAH-binned BVH (scratchbox_bvh.hpp). Detects intersections, surface normals, triangle data, and the mesh\'s own texture UV at the hit (barycentric-interpolated from the hit triangle\'s vertices, not the barycentric u/v also returned). Useful for collision detection, line-of-sight/occlusion tests, gap detection, surface point queries, and projecting a 2D image or mask (any camera, posed or not) onto a mesh\'s texture space one ray per pixel. Works on any GLB: geographic tiles, photogrammetry, procedural builds.',
        parameters: {
            type: 'OBJECT',
            properties: {
                glbPath: {
                    type: 'STRING',
                    description: 'Path to the .glb file (building, object, tile, or scene mesh)'
                },
                rays: {
                    type: 'ARRAY',
                    items: {
                        type: 'OBJECT',
                        properties: {
                            originX: { type: 'NUMBER', description: 'Ray origin X (world space)' },
                            originY: { type: 'NUMBER', description: 'Ray origin Y (world space)' },
                            originZ: { type: 'NUMBER', description: 'Ray origin Z (world space)' },
                            dirX: { type: 'NUMBER', description: 'Ray direction X (normalized)' },
                            dirY: { type: 'NUMBER', description: 'Ray direction Y (normalized)' },
                            dirZ: { type: 'NUMBER', description: 'Ray direction Z (normalized)' },
                            maxDistance: {
                                type: 'NUMBER',
                                description: 'Maximum distance to search (default: 1e9, effectively infinite). Set finite for occlusion tests.'
                            }
                        },
                        required: ['originX', 'originY', 'originZ', 'dirX', 'dirY', 'dirZ']
                    },
                    description: 'Array of rays to cast through the mesh. Origin + normalized direction.'
                },
                anyHit: {
                    type: 'BOOLEAN',
                    description: 'If true, return immediately on first hit per ray (fast occlusion/shadow test, no normal/triangle data). If false (default), return closest intersection with full triangle/normal data.'
                }
            },
            required: ['glbPath', 'rays']
        }
    },
    {
        name: 'mesh_bvh_closest_point',
        description: 'Find the closest point on a 3D mesh surface to query point(s), using the native BVH (scratchbox_bvh.hpp closestPoint). Useful for surface snapping, proximity measurement, and anchor placement on geometry.',
        parameters: {
            type: 'OBJECT',
            properties: {
                glbPath: { type: 'STRING', description: 'Path to the .glb file' },
                points: {
                    type: 'ARRAY',
                    items: {
                        type: 'OBJECT',
                        properties: {
                            x: { type: 'NUMBER', description: 'Query point X coordinate' },
                            y: { type: 'NUMBER', description: 'Query point Y coordinate' },
                            z: { type: 'NUMBER', description: 'Query point Z coordinate' }
                        },
                        required: ['x', 'y', 'z']
                    },
                    description: 'Array of 3D points in world space to project onto the mesh surface'
                }
            },
            required: ['glbPath', 'points']
        }
    },
    {
        name: 'mesh_bvh_bake_rtao',
        description: 'Bake ray-traced ambient occlusion (RTAO) into a mesh via BVH ray-casting (scratchbox_bvh.hpp bakeMeshRTAO). Cosine-weighted hemisphere sampling per vertex, baked into vertex colors. Useful for cavity detection, recessed features, self-shadowing in corners and seams.',
        parameters: {
            type: 'OBJECT',
            properties: {
                glbPath: { type: 'STRING', description: 'Path to the input .glb file' },
                outputGlbPath: { type: 'STRING', description: 'Path to write the output .glb with RTAO baked into vertex colors' },
                samplesPerVertex: { type: 'NUMBER', description: 'Hemisphere samples per vertex (default 16, range 4-64)' },
                maxDistance: { type: 'NUMBER', description: 'Maximum occlusion distance in mesh units (default 1.5)' },
                intensity: { type: 'NUMBER', description: 'AO blend intensity 0-1 (default 1.0)' }
            },
            required: ['glbPath', 'outputGlbPath']
        }
    }
];

const COMMON_HEADER = `
#include "scratchbox_gltf_scene.hpp"
#include "scratchbox_bvh.hpp"
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

using namespace scratchbox;
using scratchbox::math::Vec3;

static gltf::GltfScene loadSceneOrDie(const char* path) {
    gltf::GltfScene scene = gltf::GlbSceneReader::readFile(path);
    if (!scene.ok) {
        std::fprintf(stderr, "GLB load failed: %s\\n", scene.error.c_str());
        std::exit(1);
    }
    return scene;
}
`;

const RAYCAST_SOURCE = `${COMMON_HEADER}
int main(int argc, char** argv) {
    if (argc < 4) { std::fprintf(stderr, "usage: glb rayFile anyHit\\n"); return 1; }
    gltf::GltfScene scene = loadSceneOrDie(argv[1]);
    bvh::BvhTree tree;
    if (!tree.build(scene.mesh)) { std::fprintf(stderr, "BVH build failed (empty mesh)\\n"); return 1; }
    bool anyHit = std::string(argv[3]) == "1";

    std::ifstream rf(argv[2]);
    int count = 0;
    rf >> count;
    std::printf("[");
    for (int i = 0; i < count; ++i) {
        float ox, oy, oz, dx, dy, dz, maxDist;
        rf >> ox >> oy >> oz >> dx >> dy >> dz >> maxDist;
        math::Ray ray(Vec3(ox, oy, oz), Vec3(dx, dy, dz));
        if (i > 0) std::printf(",");
        if (anyHit) {
            bool hit = tree.raycastAny(ray, maxDist);
            std::printf("{\\"rayIndex\\":%d,\\"hit\\":%s}", i, hit ? "true" : "false");
        } else {
            bvh::RayHit hit;
            bool found = tree.raycast(ray, hit);
            if (found) {
                std::printf("{\\"rayIndex\\":%d,\\"hit\\":true,\\"distance\\":%.6f,\\"position\\":[%.6f,%.6f,%.6f],\\"normal\\":[%.6f,%.6f,%.6f],\\"triangleIndex\\":%u,\\"u\\":%.6f,\\"v\\":%.6f,\\"texCoord\\":[%.6f,%.6f]}",
                    i, hit.t, hit.position.x, hit.position.y, hit.position.z, hit.normal.x, hit.normal.y, hit.normal.z, hit.triangleIndex, hit.u, hit.v, hit.texCoord.x, hit.texCoord.y);
            } else {
                std::printf("{\\"rayIndex\\":%d,\\"hit\\":false}", i);
            }
        }
    }
    std::printf("]\\n");
    return 0;
}
`;

const CLOSEST_POINT_SOURCE = `${COMMON_HEADER}
int main(int argc, char** argv) {
    if (argc < 3) { std::fprintf(stderr, "usage: glb pointFile\\n"); return 1; }
    gltf::GltfScene scene = loadSceneOrDie(argv[1]);
    bvh::BvhTree tree;
    if (!tree.build(scene.mesh)) { std::fprintf(stderr, "BVH build failed (empty mesh)\\n"); return 1; }

    std::ifstream pf(argv[2]);
    int count = 0;
    pf >> count;
    std::printf("[");
    for (int i = 0; i < count; ++i) {
        float x, y, z;
        pf >> x >> y >> z;
        Vec3 q(x, y, z);
        float distSq = 0.0f;
        Vec3 closest = tree.closestPoint(q, distSq);
        if (i > 0) std::printf(",");
        std::printf("{\\"pointIndex\\":%d,\\"queryPoint\\":[%.6f,%.6f,%.6f],\\"closestPoint\\":[%.6f,%.6f,%.6f],\\"distanceMeters\\":%.6f}",
            i, x, y, z, closest.x, closest.y, closest.z, std::sqrt(distSq));
    }
    std::printf("]\\n");
    return 0;
}
`;

const BAKE_RTAO_SOURCE = `${COMMON_HEADER}
int main(int argc, char** argv) {
    if (argc < 6) { std::fprintf(stderr, "usage: glb outGlb samples maxDist intensity\\n"); return 1; }
    gltf::GltfScene scene = loadSceneOrDie(argv[1]);
    int samples = std::atoi(argv[3]);
    float maxDist = static_cast<float>(std::atof(argv[4]));
    float intensity = static_cast<float>(std::atof(argv[5]));

    bvh::bakeMeshRTAO(scene.mesh, samples, maxDist, intensity);

    if (!io::GlbWriter::writeToFile(scene.mesh, argv[2])) {
        std::fprintf(stderr, "Failed to write output GLB: %s\\n", argv[2]);
        return 1;
    }

    std::printf("{\\"vertices\\":%zu,\\"triangles\\":%zu,\\"samplesPerVertex\\":%d,\\"maxDistance\\":%.4f,\\"intensity\\":%.4f}\\n",
        scene.mesh.vertices.size(), scene.mesh.indices.size() / 3, samples, maxDist, intensity);
    return 0;
}
`;

interface RaycastRequest {
    glbPath: string;
    rays: Array<{
        originX: number;
        originY: number;
        originZ: number;
        dirX: number;
        dirY: number;
        dirZ: number;
        maxDistance?: number;
    }>;
    anyHit?: boolean;
}

interface ClosestPointRequest {
    glbPath: string;
    points: Array<{ x: number; y: number; z: number }>;
}

interface BakeRTAORequest {
    glbPath: string;
    outputGlbPath: string;
    samplesPerVertex?: number;
    maxDistance?: number;
    intensity?: number;
}

async function raycastHandler(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolHandlerOutcome> {
    const request = args as unknown as RaycastRequest;
    try {
        const { glbPath, rays, anyHit = false } = request;
        if (!fs.existsSync(glbPath)) {
            return { status: 'failed', resultPayload: { error: `GLB file not found: ${glbPath}` } };
        }

        const rayFile = tempPath('bvh-rays', 'txt');
        const lines = [String(rays.length)];
        for (const r of rays) {
            lines.push(`${r.originX} ${r.originY} ${r.originZ} ${r.dirX} ${r.dirY} ${r.dirZ} ${r.maxDistance ?? 1e9}`);
        }
        fs.writeFileSync(rayFile, lines.join('\n'));

        try {
            const stdout = await compileAndRun('bvh_raycast', RAYCAST_SOURCE, [glbPath, rayFile, anyHit ? '1' : '0']);
            const hits = JSON.parse(stdout.trim()) as Array<{ hit: boolean }>;
            const hitCount = hits.filter(h => h.hit).length;
            return {
                status: 'completed',
                resultPayload: { glbPath, rayCount: rays.length, hitCount, hits },
                summaryResult: `BVH raycast: ${rays.length} rays, ${hitCount} hits`
            };
        } finally {
            fs.rmSync(rayFile, { force: true });
        }
    } catch (e) {
        const stderr = (e as Error & { stderr?: string }).stderr;
        return { status: 'failed', resultPayload: { error: `Raycast failed: ${stderr || String(e)}` } };
    }
}

async function closestPointHandler(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolHandlerOutcome> {
    const request = args as unknown as ClosestPointRequest;
    try {
        const { glbPath, points } = request;
        if (!fs.existsSync(glbPath)) {
            return { status: 'failed', resultPayload: { error: `GLB file not found: ${glbPath}` } };
        }

        const pointFile = tempPath('bvh-points', 'txt');
        const lines = [String(points.length)];
        for (const p of points) lines.push(`${p.x} ${p.y} ${p.z}`);
        fs.writeFileSync(pointFile, lines.join('\n'));

        try {
            const stdout = await compileAndRun('bvh_closest_point', CLOSEST_POINT_SOURCE, [glbPath, pointFile]);
            const results = JSON.parse(stdout.trim()) as Array<{ distanceMeters: number }>;
            const avgDist = results.reduce((s, p) => s + p.distanceMeters, 0) / Math.max(1, results.length);
            return {
                status: 'completed',
                resultPayload: { glbPath, pointCount: points.length, results },
                summaryResult: `BVH closest-point: ${points.length} points, avg distance ${avgDist.toFixed(3)}m`
            };
        } finally {
            fs.rmSync(pointFile, { force: true });
        }
    } catch (e) {
        const stderr = (e as Error & { stderr?: string }).stderr;
        return { status: 'failed', resultPayload: { error: `Closest point query failed: ${stderr || String(e)}` } };
    }
}

async function bakeRTAOHandler(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolHandlerOutcome> {
    const request = args as unknown as BakeRTAORequest;
    try {
        const { glbPath, outputGlbPath, samplesPerVertex = 16, maxDistance = 1.5, intensity = 1.0 } = request;
        if (!fs.existsSync(glbPath)) {
            return { status: 'failed', resultPayload: { error: `GLB file not found: ${glbPath}` } };
        }
        fs.mkdirSync(path.dirname(outputGlbPath), { recursive: true });

        const stdout = await compileAndRun(
            'bvh_bake_rtao',
            BAKE_RTAO_SOURCE,
            [glbPath, outputGlbPath, String(samplesPerVertex), String(maxDistance), String(intensity)],
            5 * 60_000
        );
        const stats = lastJsonLine(stdout) as Record<string, unknown>;

        return {
            status: 'completed',
            resultPayload: { outputGlbPath, ...stats },
            summaryResult: `RTAO baked (${samplesPerVertex} spp, max dist ${maxDistance}m) -> ${outputGlbPath}`
        };
    } catch (e) {
        const stderr = (e as Error & { stderr?: string }).stderr;
        return { status: 'failed', resultPayload: { error: `RTAO baking failed: ${stderr || String(e)}` } };
    }
}

export const bvhQueryHandlers: Array<[ToolDeclaration, ToolHandler]> = [
    [BVH_QUERY_TOOL_DECLARATIONS[0], raycastHandler],
    [BVH_QUERY_TOOL_DECLARATIONS[1], closestPointHandler],
    [BVH_QUERY_TOOL_DECLARATIONS[2], bakeRTAOHandler]
];
