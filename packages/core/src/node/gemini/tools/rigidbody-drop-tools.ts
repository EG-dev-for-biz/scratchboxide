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
 * Rigid-body drop-and-settle simulation, driving `scratchbox_rigidbody.hpp` (GJK/EPA narrowphase,
 * sequential-impulse solver) against any static scene GLB read natively via
 * `scratchbox_gltf_scene.hpp`'s GlsSceneReader, following the same compile-once/execFile pattern as
 * the BVH query tools (bvh-query-tools.ts).
 *
 * Collider shape is a free string the caller supplies per object (box/sphere/capsule/cylinder), mapped
 * to an integer code in TypeScript before being written to the objects temp file -- it is never a
 * closed enum gating which tool or code path runs; the C++ side always has all four factories compiled
 * in and simply dispatches on the per-object integer.
 */

const FLAGS = defaultNativeFlags();
const compiler = NativeCppCompilerService.getInstance();

function sdkIncludeDir(): string {
    return compiler.getSdkIncludePath();
}

async function compileAndRun(name: string, source: string, args: string[], timeoutMs = 4 * 60_000): Promise<string> {
    const result = await compileNativeCached({
        sourceCode: source,
        includeDirs: [sdkIncludeDir()],
        flags: FLAGS,
        // scratchbox_gltf_scene.hpp pulls in scratchbox_png.hpp (embedded-texture decode), which needs zlib.
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

/** Maps the caller's free-form collider-shape label to the integer code the compiled binary switches on. */
function colliderTypeCode(colliderType: string): number {
    switch (colliderType.toLowerCase()) {
        case 'sphere':
            return 1;
        case 'capsule':
            return 2;
        case 'cylinder':
            return 3;
        case 'box':
        default:
            return 0;
    }
}

export const RIGIDBODY_DROP_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'physics_simulate_rigid_drop',
        description:
            'Drops one or more rigid objects into a static scene mesh and simulates with the native GJK/EPA ' +
            'sequential-impulse solver (scratchbox_rigidbody.hpp) until every object settles or a step budget runs ' +
            'out, returning each object\'s final resting position and orientation. Useful for realistically placing ' +
            'debris, props, or loose objects onto a scan/building without manual placement, or for "what happens if ' +
            'this falls" previsualization. Collider shape is a free string per object ("box"|"sphere"|"capsule"|' +
            '"cylinder") -- not a closed taxonomy gate, just which shape-math factory the simulator calls for that object.',
        parameters: {
            type: 'OBJECT',
            properties: {
                sceneGlbPath: {
                    type: 'STRING',
                    description:
                        'Path to the static collision geometry (a scan or building GLB) the objects fall onto. ' +
                        'Loaded via Collider::fromMesh -- every vertex of this mesh becomes a convex-hull-style support ' +
                        'point (see colliderType description for what fromMesh actually does), set static.'
                },
                objects: {
                    type: 'ARRAY',
                    items: {
                        type: 'OBJECT',
                        properties: {
                            colliderType: {
                                type: 'STRING',
                                description:
                                    '"box" | "sphere" | "capsule" | "cylinder" (free string, matched case-insensitively; ' +
                                    'unrecognized values fall back to "box"). Picks which Collider factory runs for this ' +
                                    'object -- not a routing gate on the tool itself.'
                            },
                            sizeX: {
                                type: 'NUMBER',
                                description:
                                    'box: half-extent-equivalent full size along X (Collider::createBox halves it internally). ' +
                                    'sphere/capsule/cylinder: radius (sphere ignores sizeY/sizeZ; capsule/cylinder use sizeY as height).'
                            },
                            sizeY: {
                                type: 'NUMBER',
                                description:
                                    'box: full size along Y. capsule/cylinder: total height along the local Y axis (including ' +
                                    'capsule end caps). sphere: unused.'
                            },
                            sizeZ: {
                                type: 'NUMBER',
                                description: 'box: full size along Z. sphere/capsule/cylinder: unused.'
                            },
                            startX: { type: 'NUMBER', description: 'Initial world-space position X.' },
                            startY: { type: 'NUMBER', description: 'Initial world-space position Y.' },
                            startZ: { type: 'NUMBER', description: 'Initial world-space position Z.' },
                            mass: { type: 'NUMBER', description: 'Mass in kg (default 1.0).' },
                            restitution: { type: 'NUMBER', description: 'Bounciness 0-1 (default 0.3).' },
                            friction: { type: 'NUMBER', description: 'Surface friction coefficient (default 0.5).' }
                        },
                        required: ['colliderType', 'startX', 'startY', 'startZ']
                    },
                    description: 'One or more dynamic rigid bodies to drop.'
                },
                maxSteps: { type: 'NUMBER', description: 'Maximum simulation steps to run (default 300).' },
                dtSeconds: { type: 'NUMBER', description: 'Timestep per step in seconds (default 1/60).' },
                gravityY: { type: 'NUMBER', description: 'Gravitational acceleration along Y (default -9.81).' }
            },
            required: ['sceneGlbPath', 'objects']
        }
    }
];

const RIGID_DROP_SOURCE = `
#include "scratchbox_gltf_scene.hpp"
#include "scratchbox_rigidbody.hpp"
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <memory>
#include <string>
#include <vector>

using namespace scratchbox;
using namespace scratchbox::rigidbody;
using scratchbox::math::Vec3;

static gltf::GltfScene loadSceneOrDie(const char* path) {
    gltf::GltfScene scene = gltf::GlbSceneReader::readFile(path);
    if (!scene.ok) {
        std::fprintf(stderr, "GLB load failed: %s\\n", scene.error.c_str());
        std::exit(1);
    }
    return scene;
}

struct ObjectSpec {
    int colliderType{0};
    float sizeX{1}, sizeY{1}, sizeZ{1};
    float startX{0}, startY{0}, startZ{0};
    float mass{1.0f};
    float restitution{0.3f};
    float friction{0.5f};
};

int main(int argc, char** argv) {
    if (argc < 6) {
        std::fprintf(stderr, "usage: sceneGlb objectsFile maxSteps dtSeconds gravityY\\n");
        return 1;
    }

    gltf::GltfScene scene = loadSceneOrDie(argv[1]);
    int maxSteps = std::atoi(argv[3]);
    float dt = static_cast<float>(std::atof(argv[4]));
    float gravityY = static_cast<float>(std::atof(argv[5]));

    RigidBodyWorld world;
    world.gravity = Vec3(0.0f, gravityY, 0.0f);

    // Static scene collision mesh: a convex-hull-style support set over every vertex of the input mesh
    // (Collider::fromMesh keeps the raw vertex list and the GJK support function walks all of them --
    // this is a convex approximation of the scene, not an exact concave hull).
    auto sceneBody = std::make_shared<RigidBody>("scene");
    sceneBody->collider = Collider::fromMesh(scene.mesh);
    sceneBody->setStatic(true);
    world.addBody(sceneBody);

    std::ifstream objFile(argv[2]);
    int count = 0;
    objFile >> count;

    std::vector<std::shared_ptr<RigidBody>> dynamicBodies;
    std::vector<ObjectSpec> specs;
    for (int i = 0; i < count; ++i) {
        ObjectSpec spec;
        objFile >> spec.colliderType >> spec.sizeX >> spec.sizeY >> spec.sizeZ
                >> spec.startX >> spec.startY >> spec.startZ
                >> spec.mass >> spec.restitution >> spec.friction;
        specs.push_back(spec);

        auto body = std::make_shared<RigidBody>("object" + std::to_string(i));
        Mat3 inertiaBody;
        switch (spec.colliderType) {
            case 1: // sphere
                body->collider = Collider::createSphere(spec.sizeX);
                inertiaBody = InertiaTensor::createSphere(spec.mass, spec.sizeX);
                break;
            case 2: // capsule
                body->collider = Collider::createCapsule(spec.sizeX, spec.sizeY);
                inertiaBody = InertiaTensor::createCapsule(spec.mass, spec.sizeX, spec.sizeY);
                break;
            case 3: // cylinder
                body->collider = Collider::createCylinder(spec.sizeX, spec.sizeY);
                inertiaBody = InertiaTensor::createCylinder(spec.mass, spec.sizeX, spec.sizeY);
                break;
            default: // box
                body->collider = Collider::createBox(Vec3(spec.sizeX, spec.sizeY, spec.sizeZ));
                inertiaBody = InertiaTensor::createBox(spec.mass, Vec3(spec.sizeX, spec.sizeY, spec.sizeZ));
                break;
        }
        body->position = Vec3(spec.startX, spec.startY, spec.startZ);
        body->restitution = spec.restitution;
        body->friction = spec.friction;
        body->invInertiaBody = inertiaBody.inverse();
        body->setMass(spec.mass);
        body->updateInertiaWorld();

        world.addBody(body);
        dynamicBodies.push_back(body);
    }

    const float linearEpsilon = 0.01f;   // m/s
    const float angularEpsilon = 0.01f;  // rad/s
    int stepsRun = 0;
    bool allSettled = false;

    for (int step = 0; step < maxSteps; ++step) {
        world.step(dt, 10, 2);
        stepsRun = step + 1;

        allSettled = true;
        for (auto& body : dynamicBodies) {
            if (body->linearVelocity.length() > linearEpsilon || body->angularVelocity.length() > angularEpsilon) {
                allSettled = false;
            }
        }
        if (allSettled) break;
    }

    std::printf("[");
    for (size_t i = 0; i < dynamicBodies.size(); ++i) {
        auto& body = dynamicBodies[i];
        bool settled = body->linearVelocity.length() <= linearEpsilon && body->angularVelocity.length() <= angularEpsilon;
        if (i > 0) std::printf(",");
        std::printf(
            "{\\"index\\":%zu,\\"position\\":[%.6f,%.6f,%.6f],\\"orientation\\":[%.6f,%.6f,%.6f,%.6f],"
            "\\"linearSpeed\\":%.6f,\\"angularSpeed\\":%.6f,\\"settled\\":%s}",
            i, body->position.x, body->position.y, body->position.z,
            body->orientation.x, body->orientation.y, body->orientation.z, body->orientation.w,
            body->linearVelocity.length(), body->angularVelocity.length(),
            settled ? "true" : "false"
        );
    }
    std::printf("]\\n");
    std::printf("{\\"stepsRun\\":%d,\\"allSettled\\":%s,\\"objectCount\\":%zu}\\n",
        stepsRun, allSettled ? "true" : "false", dynamicBodies.size());
    return 0;
}
`;

interface RigidDropObjectRequest {
    colliderType: string;
    sizeX?: number;
    sizeY?: number;
    sizeZ?: number;
    startX: number;
    startY: number;
    startZ: number;
    mass?: number;
    restitution?: number;
    friction?: number;
}

interface RigidDropRequest {
    sceneGlbPath: string;
    objects: RigidDropObjectRequest[];
    maxSteps?: number;
    dtSeconds?: number;
    gravityY?: number;
}

interface RigidDropObjectResult {
    index: number;
    position: [number, number, number];
    orientation: [number, number, number, number];
    linearSpeed: number;
    angularSpeed: number;
    settled: boolean;
}

async function rigidDropHandler(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolHandlerOutcome> {
    const request = args as unknown as RigidDropRequest;
    try {
        const { sceneGlbPath, objects, maxSteps = 300, dtSeconds = 1 / 60, gravityY = -9.81 } = request;
        if (!fs.existsSync(sceneGlbPath)) {
            return { status: 'failed', resultPayload: { error: `Scene GLB file not found: ${sceneGlbPath}` } };
        }
        if (!objects || objects.length === 0) {
            return { status: 'failed', resultPayload: { error: 'At least one object is required' } };
        }

        const objectsFile = tempPath('rigidbody-objects', 'txt');
        const lines = [String(objects.length)];
        for (const o of objects) {
            const code = colliderTypeCode(o.colliderType);
            lines.push(
                `${code} ${o.sizeX ?? 1} ${o.sizeY ?? 1} ${o.sizeZ ?? 1} ` +
                `${o.startX} ${o.startY} ${o.startZ} ${o.mass ?? 1.0} ${o.restitution ?? 0.3} ${o.friction ?? 0.5}`
            );
        }
        fs.writeFileSync(objectsFile, lines.join('\n'));

        try {
            const stdout = await compileAndRun(
                'rigidbody_drop',
                RIGID_DROP_SOURCE,
                [sceneGlbPath, objectsFile, String(maxSteps), String(dtSeconds), String(gravityY)],
                5 * 60_000
            );
            const lines2 = stdout.trim().split('\n');
            const objectResults = JSON.parse(lines2[lines2.length - 2] || '[]') as RigidDropObjectResult[];
            const summary = JSON.parse(lines2[lines2.length - 1] || '{}') as {
                stepsRun: number;
                allSettled: boolean;
                objectCount: number;
            };
            const settledCount = objectResults.filter(o => o.settled).length;

            return {
                status: 'completed',
                resultPayload: {
                    sceneGlbPath,
                    objects: objectResults,
                    stepsRun: summary.stepsRun,
                    allSettled: summary.allSettled
                },
                summaryResult: summary.allSettled
                    ? `${objectResults.length} objects settled after ${summary.stepsRun} steps`
                    : `${objectResults.length} objects, ${settledCount} settled, ${objectResults.length - settledCount} still moving after step budget (${summary.stepsRun} steps)`
            };
        } finally {
            fs.rmSync(objectsFile, { force: true });
        }
    } catch (e) {
        const stderr = (e as Error & { stderr?: string }).stderr;
        return { status: 'failed', resultPayload: { error: `Rigid-body drop simulation failed: ${stderr || String(e)}` } };
    }
}

export const rigidbodyDropHandlers: Array<[ToolDeclaration, ToolHandler]> = [
    [RIGIDBODY_DROP_TOOL_DECLARATIONS[0], rigidDropHandler]
];
