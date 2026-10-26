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
 * Camera-trajectory collision / clearance auditing tools.
 * Drives `scratchbox_trajectory_collision.hpp` (TrajectoryCollisionAuditor, backed by the same
 * SAH-binned BvhTree as bvh-query-tools.ts) against any GLB mesh — a building, scan, or 3D-tiles
 * scene, read natively via `scratchbox_gltf_scene.hpp`'s GlbSceneReader — to check a planned
 * camera flight path for geometry penetration and insufficient surface clearance before it is
 * rendered.
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

function tempPath(prefix: string, ext: string): string {
    return path.join(os.tmpdir(), `${prefix}-${process.pid}-${crypto.randomBytes(6).toString('hex')}.${ext}`);
}

export const TRAJECTORY_COLLISION_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'mesh_audit_camera_trajectory',
        description:
            "Audits a camera flight path's waypoints against a scene mesh (building, scan, 3D tiles) for geometry " +
            'penetration and insufficient clearance, using the mesh\'s native BVH (scratchbox_trajectory_collision.hpp, ' +
            'scratchbox_bvh.hpp). Useful for validating a planned camera move won\'t clip through a building or fly too ' +
            'close to a surface before rendering it.',
        parameters: {
            type: 'OBJECT',
            properties: {
                glbPath: {
                    type: 'STRING',
                    description: 'Path to the .glb scene/building mesh to check the trajectory against'
                },
                waypoints: {
                    type: 'ARRAY',
                    items: {
                        type: 'OBJECT',
                        properties: {
                            frameIndex: { type: 'NUMBER', description: 'Frame index of this waypoint' },
                            timeSec: { type: 'NUMBER', description: 'Time in seconds of this waypoint' },
                            posX: { type: 'NUMBER', description: 'Camera position X (world space)' },
                            posY: { type: 'NUMBER', description: 'Camera position Y (world space, up)' },
                            posZ: { type: 'NUMBER', description: 'Camera position Z (world space)' },
                            targetX: { type: 'NUMBER', description: 'Camera look-at target X (world space)' },
                            targetY: { type: 'NUMBER', description: 'Camera look-at target Y (world space)' },
                            targetZ: { type: 'NUMBER', description: 'Camera look-at target Z (world space)' },
                            fov: { type: 'NUMBER', description: 'Vertical field of view in degrees (default 65)' },
                            rollDeg: { type: 'NUMBER', description: 'Camera roll in degrees (default 0)' }
                        },
                        required: ['frameIndex', 'timeSec', 'posX', 'posY', 'posZ', 'targetX', 'targetY', 'targetZ']
                    },
                    description: 'Camera waypoints forming the trajectory to audit, in order'
                },
                minClearanceMeters: {
                    type: 'NUMBER',
                    description: 'Minimum required clearance from any surface, in meters (default 5.0)'
                },
                skyProbeAltitudeMeters: {
                    type: 'NUMBER',
                    description: 'Altitude a downward probe ray is cast from to find the surface/ground elevation under each waypoint (default 600.0)'
                }
            },
            required: ['glbPath', 'waypoints']
        }
    }
];

// Waypoint temp-file format (matches bvh-query-tools.ts's text-file convention):
//   line 1: waypoint count
//   lines 2..N+1: "frameIndex timeSec posX posY posZ targetX targetY targetZ fov rollDeg"
const TRAJECTORY_AUDIT_SOURCE = `
#include "scratchbox_gltf_scene.hpp"
#include "scratchbox_trajectory_collision.hpp"
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <limits>
#include <vector>

using namespace scratchbox;
using namespace scratchbox::collision;
using scratchbox::math::Vec3;

static gltf::GltfScene loadSceneOrDie(const char* path) {
    gltf::GltfScene scene = gltf::GlbSceneReader::readFile(path);
    if (!scene.ok) {
        std::fprintf(stderr, "GLB load failed: %s\\n", scene.error.c_str());
        std::exit(1);
    }
    return scene;
}

int main(int argc, char** argv) {
    if (argc < 5) { std::fprintf(stderr, "usage: glb waypointFile minClearance skyProbeAltitude\\n"); return 1; }
    gltf::GltfScene scene = loadSceneOrDie(argv[1]);
    float minClearance = static_cast<float>(std::atof(argv[3]));
    float skyProbeAltitude = static_cast<float>(std::atof(argv[4]));

    std::ifstream wf(argv[2]);
    int count = 0;
    wf >> count;
    std::vector<CameraWaypoint> trajectory;
    trajectory.reserve(static_cast<size_t>(count));
    for (int i = 0; i < count; ++i) {
        CameraWaypoint wp;
        float px, py, pz, tx, ty, tz;
        wf >> wp.frameIndex >> wp.timeSec >> px >> py >> pz >> tx >> ty >> tz >> wp.fov >> wp.rollDeg;
        wp.position = Vec3(px, py, pz);
        wp.target = Vec3(tx, ty, tz);
        trajectory.push_back(wp);
    }

    TrajectoryAuditReport report = TrajectoryCollisionAuditor::auditTrajectory(trajectory, scene.mesh, minClearance, skyProbeAltitude);
    float minClearanceEncountered = report.totalFramesAudited > 0 ? report.minClearanceEncountered : 0.0f;

    std::printf(
        "{\\"totalFramesAudited\\":%zu,\\"collidingFramesCount\\":%zu,\\"clearanceBreachesCount\\":%zu,"
        "\\"minClearanceEncountered\\":%.6f,\\"maxElevationAdjustment\\":%.6f,\\"isCleanAndClear\\":%s,\\"frameDetails\\":[",
        report.totalFramesAudited, report.collidingFramesCount, report.clearanceBreachesCount,
        minClearanceEncountered, report.maxElevationAdjustment, report.isCleanAndClear ? "true" : "false");

    bool first = true;
    for (const auto& f : report.frameDetails) {
        if (!f.isPenetrating && !f.breachesClearance) continue;
        if (!first) std::printf(",");
        first = false;
        std::printf(
            "{\\"frameIndex\\":%d,\\"timeSec\\":%.6f,\\"cameraPos\\":[%.6f,%.6f,%.6f],\\"isPenetrating\\":%s,"
            "\\"breachesClearance\\":%s,\\"distanceToSurface\\":%.6f,\\"surfaceElevationUnderCamera\\":%.6f,"
            "\\"requiredClearance\\":%.6f,\\"elevationDeltaNeeded\\":%.6f,\\"closestSurfacePoint\\":[%.6f,%.6f,%.6f]}",
            f.frameIndex, f.timeSec, f.cameraPos.x, f.cameraPos.y, f.cameraPos.z,
            f.isPenetrating ? "true" : "false", f.breachesClearance ? "true" : "false",
            f.distanceToSurface, f.surfaceElevationUnderCamera, f.requiredClearance, f.elevationDeltaNeeded,
            f.closestSurfacePoint.x, f.closestSurfacePoint.y, f.closestSurfacePoint.z);
    }
    std::printf("]}\\n");
    return 0;
}
`;

interface TrajectoryWaypointRequest {
    frameIndex: number;
    timeSec: number;
    posX: number;
    posY: number;
    posZ: number;
    targetX: number;
    targetY: number;
    targetZ: number;
    fov?: number;
    rollDeg?: number;
}

interface TrajectoryAuditRequest {
    glbPath: string;
    waypoints: TrajectoryWaypointRequest[];
    minClearanceMeters?: number;
    skyProbeAltitudeMeters?: number;
}

async function auditCameraTrajectoryHandler(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolHandlerOutcome> {
    const request = args as unknown as TrajectoryAuditRequest;
    try {
        const { glbPath, waypoints, minClearanceMeters = 5.0, skyProbeAltitudeMeters = 600.0 } = request;
        if (!fs.existsSync(glbPath)) {
            return { status: 'failed', resultPayload: { error: `GLB file not found: ${glbPath}` } };
        }
        if (!waypoints || waypoints.length === 0) {
            return { status: 'failed', resultPayload: { error: 'waypoints must contain at least one waypoint' } };
        }

        const waypointFile = tempPath('trajectory-waypoints', 'txt');
        const lines = [String(waypoints.length)];
        for (const w of waypoints) {
            lines.push(
                `${w.frameIndex} ${w.timeSec} ${w.posX} ${w.posY} ${w.posZ} ${w.targetX} ${w.targetY} ${w.targetZ} ${w.fov ?? 65} ${w.rollDeg ?? 0}`
            );
        }
        fs.writeFileSync(waypointFile, lines.join('\n'));

        try {
            const stdout = await compileAndRun('trajectory_audit', TRAJECTORY_AUDIT_SOURCE, [
                glbPath,
                waypointFile,
                String(minClearanceMeters),
                String(skyProbeAltitudeMeters)
            ]);
            const report = JSON.parse(stdout.trim()) as {
                totalFramesAudited: number;
                collidingFramesCount: number;
                clearanceBreachesCount: number;
                minClearanceEncountered: number;
                isCleanAndClear: boolean;
            };
            return {
                status: 'completed',
                resultPayload: { glbPath, ...report },
                summaryResult: `Audited ${report.totalFramesAudited} frames: isCleanAndClear=${report.isCleanAndClear}, ${report.collidingFramesCount} colliding, ${report.clearanceBreachesCount} clearance breaches, min clearance ${report.minClearanceEncountered.toFixed(2)}m`
            };
        } finally {
            fs.rmSync(waypointFile, { force: true });
        }
    } catch (e) {
        const stderr = (e as Error & { stderr?: string }).stderr;
        return { status: 'failed', resultPayload: { error: `Trajectory audit failed: ${stderr || String(e)}` } };
    }
}

export const trajectoryCollisionHandlers: Array<[ToolDeclaration, ToolHandler]> = [
    [TRAJECTORY_COLLISION_TOOL_DECLARATIONS[0], auditCameraTrajectoryHandler]
];
