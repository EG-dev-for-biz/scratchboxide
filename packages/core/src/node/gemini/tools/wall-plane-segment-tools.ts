/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { execFile } from 'child_process';
import * as fs from 'fs';
import { compileNativeCached, defaultNativeFlags } from '../../3d-engine/native-build-cache';
import { NativeCppCompilerService } from '../../3d-engine/native-compiler-service';
import type { ToolContext, ToolDeclaration, ToolHandler, ToolHandlerOutcome } from './types';

/**
 * Blind wall-plane segmentation: clusters a mesh's near-vertical, coplanar triangles into
 * candidate flat wall planes, with no prior knowledge of the building's footprint (unlike
 * runMassing/fitWallPlane, which both require an already-known vector edge). Each candidate's
 * origin/normal/axisS/bounds are in exactly the shape facade_analyze_bay_rhythm's wallOrigin/
 * wallNormal/wallAxisS/wallSMin/wallSMax parameters expect, so the two tools compose directly:
 * segment this mesh's walls, then analyze bay rhythm on whichever one the caller cares about.
 */

export const WALL_PLANE_SEGMENT_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'mesh_segment_wall_planes',
        description:
            "Finds candidate flat wall planes on a 3D mesh (building, scan, any GLB) by clustering its near-vertical, " +
            'coplanar triangles — with no prior knowledge of the building\'s footprint or orientation. Each result gives ' +
            "a wall's origin/normal/axisS (its own local horizontal direction) and local bounds (sMin/sMax along axisS, " +
            'tMin/tMax vertically), ranked by area. Use this BEFORE facade_analyze_bay_rhythm or mesh_generate_wall_with_apertures ' +
            'on a multi-wall or oddly-oriented building (a non-rectangular footprint, an angled facade): pass one result\'s ' +
            'origin/normal/axisS/sMin/sMax straight into facade_analyze_bay_rhythm\'s wallOrigin*/wallNormal*/wallAxisS*/wallSMin/wallSMax ' +
            "to analyze that one wall correctly instead of the whole mesh's global-X extent.",
        parameters: {
            type: 'OBJECT',
            properties: {
                glbPath: { type: 'STRING', description: 'Path to the .glb mesh to segment' },
                minWallAreaM2: {
                    type: 'NUMBER',
                    description: 'Minimum total triangle area (square meters) for a cluster to be reported as a wall (default 2.0, filters small fragments/noise)'
                },
                maxNormalYForWall: {
                    type: 'NUMBER',
                    description: 'A triangle counts as wall-like only if |normal.y| is below this (default 0.75 — excludes near-horizontal roof/floor surfaces, matching this codebase\'s existing wall-fit convention)'
                },
                clusterMergeAngleDeg: {
                    type: 'NUMBER',
                    description: 'Two triangles merge into the same wall cluster only if their normals are within this many degrees of each other (default 8)'
                },
                planeToleranceMeters: {
                    type: 'NUMBER',
                    description: 'Two triangles merge only if their planes (offset along the shared normal) are within this distance (default 0.3m) — keeps e.g. two parallel walls on opposite sides of a building from merging into one'
                },
                searchRadiusMeters: {
                    type: 'NUMBER',
                    description: 'How far apart two triangle centroids may be and still be considered for merging (default 2.0m); raise it for a coarsely tessellated mesh with few, large triangles'
                },
                maxResults: {
                    type: 'NUMBER',
                    description: 'Report at most this many wall candidates, largest area first (default 20)'
                }
            },
            required: ['glbPath']
        }
    }
];

const SEGMENT_SOURCE = `
#include "scratchbox_gltf_scene.hpp"
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <unordered_map>
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

struct DisjointSet {
    std::vector<int> parent;
    explicit DisjointSet(size_t n) : parent(n) { for (size_t i = 0; i < n; ++i) parent[i] = static_cast<int>(i); }
    int find(int x) { while (parent[x] != x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
    void merge(int a, int b) { a = find(a); b = find(b); if (a != b) parent[a] = b; }
};

struct TriCandidate {
    Vec3 normal;
    Vec3 centroid;
    float area;
    float planeOffset; // dot(centroid, normal)
};

static int64_t cellKey(int cx, int cy, int cz) {
    // Pack three 20-bit signed-ish coordinates into one key (plenty for any real building's extent).
    return (static_cast<int64_t>(cx + 1000000) << 42) | (static_cast<int64_t>(cy + 1000000) << 21) | static_cast<int64_t>(cz + 1000000);
}

int main(int argc, char** argv) {
    if (argc < 8) { std::fprintf(stderr, "usage: glb minWallAreaM2 maxNormalYForWall clusterMergeAngleDeg planeTolerance searchRadius maxResults\\n"); return 1; }
    gltf::GltfScene scene = loadSceneOrDie(argv[1]);
    float minWallAreaM2 = static_cast<float>(std::atof(argv[2]));
    float maxNormalYForWall = static_cast<float>(std::atof(argv[3]));
    float clusterMergeAngleDeg = static_cast<float>(std::atof(argv[4]));
    float planeTolerance = static_cast<float>(std::atof(argv[5]));
    float searchRadius = static_cast<float>(std::atof(argv[6]));
    int maxResults = std::atoi(argv[7]);

    const float cosMergeAngle = std::cos(clusterMergeAngleDeg * 3.14159265358979323846f / 180.0f);
    const auto& mesh = scene.mesh;
    size_t triCount = mesh.indices.size() / 3;

    std::vector<TriCandidate> cand;
    std::vector<size_t> candTriIndex; // index into the original triangle list, for later vertex collection
    cand.reserve(triCount);
    candTriIndex.reserve(triCount);

    for (size_t t = 0; t < triCount; ++t) {
        const auto& v0 = mesh.vertices[mesh.indices[t * 3]].position;
        const auto& v1 = mesh.vertices[mesh.indices[t * 3 + 1]].position;
        const auto& v2 = mesh.vertices[mesh.indices[t * 3 + 2]].position;
        Vec3 e1 = v1 - v0;
        Vec3 e2 = v2 - v0;
        Vec3 cross = e1.cross(e2);
        float len = cross.length();
        if (len < 1e-8f) continue; // degenerate
        Vec3 normal = cross * (1.0f / len);
        float area = len * 0.5f;
        if (std::abs(normal.y) > maxNormalYForWall) continue; // roof/floor-like, not a wall
        Vec3 centroid = (v0 + v1 + v2) * (1.0f / 3.0f);
        TriCandidate c;
        c.normal = normal;
        c.centroid = centroid;
        c.area = area;
        c.planeOffset = centroid.dot(normal);
        candTriIndex.push_back(t);
        cand.push_back(c);
    }

    // Spatial hash of candidate centroids, cell = searchRadius, for neighbor lookup.
    std::unordered_map<int64_t, std::vector<int>> grid;
    for (size_t i = 0; i < cand.size(); ++i) {
        int cx = static_cast<int>(std::floor(cand[i].centroid.x / searchRadius));
        int cy = static_cast<int>(std::floor(cand[i].centroid.y / searchRadius));
        int cz = static_cast<int>(std::floor(cand[i].centroid.z / searchRadius));
        grid[cellKey(cx, cy, cz)].push_back(static_cast<int>(i));
    }

    DisjointSet ds(cand.size());
    for (size_t i = 0; i < cand.size(); ++i) {
        int cx = static_cast<int>(std::floor(cand[i].centroid.x / searchRadius));
        int cy = static_cast<int>(std::floor(cand[i].centroid.y / searchRadius));
        int cz = static_cast<int>(std::floor(cand[i].centroid.z / searchRadius));
        for (int dx = -1; dx <= 1; ++dx) {
            for (int dy = -1; dy <= 1; ++dy) {
                for (int dz = -1; dz <= 1; ++dz) {
                    auto it = grid.find(cellKey(cx + dx, cy + dy, cz + dz));
                    if (it == grid.end()) continue;
                    for (int j : it->second) {
                        if (static_cast<size_t>(j) <= i) continue;
                        if ((cand[i].centroid - cand[j].centroid).length() > searchRadius) continue;
                        if (cand[i].normal.dot(cand[j].normal) < cosMergeAngle) continue;
                        // Compare plane offsets along a shared reference normal (i's normal).
                        float offJ = cand[j].centroid.dot(cand[i].normal);
                        if (std::abs(cand[i].planeOffset - offJ) > planeTolerance) continue;
                        ds.merge(static_cast<int>(i), j);
                    }
                }
            }
        }
    }

    struct Cluster {
        Vec3 normalSum{0, 0, 0};
        Vec3 centroidSum{0, 0, 0};
        float areaSum{0};
        float minS{1e30f}, maxS{-1e30f}, minT{1e30f}, maxT{-1e30f};
        int triCount{0};
    };
    std::unordered_map<int, Cluster> clusters;
    for (size_t i = 0; i < cand.size(); ++i) {
        int root = ds.find(static_cast<int>(i));
        auto& c = clusters[root];
        c.normalSum = c.normalSum + cand[i].normal * cand[i].area;
        c.centroidSum = c.centroidSum + cand[i].centroid * cand[i].area;
        c.areaSum += cand[i].area;
        c.triCount++;
    }

    // Second pass: with each cluster's area-weighted normal/origin known, project every candidate
    // triangle's vertices onto that wall's local frame (axisS = normal x worldUp, axisT = worldUp)
    // to get real sMin/sMax/tMin/tMax bounds.
    struct WallResult { Vec3 origin, normal, axisS; float sMin, sMax, tMin, tMax, areaM2; int triCount; };
    std::vector<WallResult> results;
    const Vec3 worldUp(0.0f, 1.0f, 0.0f);

    for (auto& kv : clusters) {
        Cluster& c = kv.second;
        if (c.areaSum < minWallAreaM2) continue;
        Vec3 normal = c.normalSum.normalized();
        Vec3 origin = c.centroidSum * (1.0f / c.areaSum);
        Vec3 axisS = normal.cross(worldUp);
        if (axisS.length() < 1e-4f) continue; // normal parallel to worldUp: not actually a wall
        axisS = axisS.normalized();

        float minS = 1e30f, maxS = -1e30f, minT = 1e30f, maxT = -1e30f;
        for (size_t i = 0; i < cand.size(); ++i) {
            if (ds.find(static_cast<int>(i)) != kv.first) continue;
            size_t t = candTriIndex[i];
            for (int k = 0; k < 3; ++k) {
                const auto& p = mesh.vertices[mesh.indices[t * 3 + k]].position;
                Vec3 rel = p - origin;
                float s = rel.dot(axisS);
                float tt = rel.dot(worldUp);
                minS = std::min(minS, s); maxS = std::max(maxS, s);
                minT = std::min(minT, tt); maxT = std::max(maxT, tt);
            }
        }

        WallResult r;
        r.origin = origin; r.normal = normal; r.axisS = axisS;
        r.sMin = minS; r.sMax = maxS; r.tMin = minT; r.tMax = maxT;
        r.areaM2 = c.areaSum; r.triCount = c.triCount;
        results.push_back(r);
    }

    std::sort(results.begin(), results.end(), [](const WallResult& a, const WallResult& b) { return a.areaM2 > b.areaM2; });
    if (static_cast<int>(results.size()) > maxResults) results.resize(static_cast<size_t>(maxResults));

    std::printf("[");
    for (size_t i = 0; i < results.size(); ++i) {
        const auto& r = results[i];
        if (i > 0) std::printf(",");
        std::printf(
            "{\\"originX\\":%.6f,\\"originY\\":%.6f,\\"originZ\\":%.6f,"
            "\\"normalX\\":%.6f,\\"normalY\\":%.6f,\\"normalZ\\":%.6f,"
            "\\"axisSX\\":%.6f,\\"axisSY\\":%.6f,\\"axisSZ\\":%.6f,"
            "\\"sMin\\":%.6f,\\"sMax\\":%.6f,\\"tMin\\":%.6f,\\"tMax\\":%.6f,"
            "\\"widthM\\":%.6f,\\"heightM\\":%.6f,\\"areaM2\\":%.6f,\\"triangleCount\\":%d}",
            r.origin.x, r.origin.y, r.origin.z,
            r.normal.x, r.normal.y, r.normal.z,
            r.axisS.x, r.axisS.y, r.axisS.z,
            r.sMin, r.sMax, r.tMin, r.tMax,
            r.sMax - r.sMin, r.tMax - r.tMin, r.areaM2, r.triCount);
    }
    std::printf("]\\n");
    return 0;
}
`;

interface WallSegmentRequest {
    glbPath: string;
    minWallAreaM2?: number;
    maxNormalYForWall?: number;
    clusterMergeAngleDeg?: number;
    planeToleranceMeters?: number;
    searchRadiusMeters?: number;
    maxResults?: number;
}

interface WallSegmentResult {
    originX: number; originY: number; originZ: number;
    normalX: number; normalY: number; normalZ: number;
    axisSX: number; axisSY: number; axisSZ: number;
    sMin: number; sMax: number; tMin: number; tMax: number;
    widthM: number; heightM: number; areaM2: number; triangleCount: number;
}

const FLAGS = defaultNativeFlags();
const compiler = NativeCppCompilerService.getInstance();

async function compileAndRun(name: string, source: string, args: string[], timeoutMs = 3 * 60_000): Promise<string> {
    const result = await compileNativeCached({
        sourceCode: source,
        includeDirs: [compiler.getSdkIncludePath()],
        flags: FLAGS,
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

async function segmentWallPlanesHandler(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolHandlerOutcome> {
    const request = args as unknown as WallSegmentRequest;
    try {
        const {
            glbPath,
            minWallAreaM2 = 2.0,
            maxNormalYForWall = 0.75,
            clusterMergeAngleDeg = 8,
            planeToleranceMeters = 0.3,
            searchRadiusMeters = 2.0,
            maxResults = 20
        } = request;
        if (!fs.existsSync(glbPath)) {
            return { status: 'failed', resultPayload: { error: `GLB file not found: ${glbPath}` } };
        }

        const stdout = await compileAndRun('wall_plane_segment', SEGMENT_SOURCE, [
            glbPath,
            String(minWallAreaM2),
            String(maxNormalYForWall),
            String(clusterMergeAngleDeg),
            String(planeToleranceMeters),
            String(searchRadiusMeters),
            String(maxResults)
        ]);
        const walls = JSON.parse(stdout.trim()) as WallSegmentResult[];

        return {
            status: 'completed',
            resultPayload: { glbPath, walls, wallCount: walls.length },
            summaryResult:
                walls.length > 0
                    ? `Found ${walls.length} wall candidate(s), largest ${walls[0].widthM.toFixed(1)}m x ${walls[0].heightM.toFixed(1)}m (${walls[0].areaM2.toFixed(1)}m^2)`
                    : 'No wall-like planes found above minWallAreaM2'
        };
    } catch (e) {
        const stderr = (e as Error & { stderr?: string }).stderr;
        return { status: 'failed', resultPayload: { error: `Wall plane segmentation failed: ${stderr || String(e)}` } };
    }
}

export const wallPlaneSegmentHandlers: Array<[ToolDeclaration, ToolHandler]> = [
    [WALL_PLANE_SEGMENT_TOOL_DECLARATIONS[0], segmentWallPlanesHandler]
];
