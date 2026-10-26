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
 * XPBD cloth-drape simulation, driving `scratchbox_xpbd.hpp` (extended position-based dynamics:
 * distance stretch constraints + isometric dihedral bending constraints, sphere/ground obstacles)
 * against a flat cloth mesh GLB read natively via `scratchbox_gltf_scene.hpp`'s GlbSceneReader,
 * following the same compile-once/execFile pattern as the BVH query tools (bvh-query-tools.ts).
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

function lastJsonLine(stdout: string): unknown {
    const lines = stdout.trim().split('\n');
    return JSON.parse(lines[lines.length - 1] || '{}');
}

function tempPath(prefix: string, ext: string): string {
    return path.join(os.tmpdir(), `${prefix}-${process.pid}-${crypto.randomBytes(6).toString('hex')}.${ext}`);
}

export const XPBD_CLOTH_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'physics_simulate_cloth_drape',
        description:
            'Drapes a flat cloth/fabric mesh (flag, curtain, tablecloth, garment panel) over sphere and/or ' +
            'ground-plane obstacles using the native XPBD solver (scratchbox_xpbd.hpp: distance + isometric dihedral ' +
            'bending constraints, with optional pinned edge vertices). Returns the final draped mesh as a GLB. ' +
            'Useful for realistic fabric/flag/curtain poses without manual sculpting.',
        parameters: {
            type: 'OBJECT',
            properties: {
                clothGlbPath: {
                    type: 'STRING',
                    description: 'Path to a flat/undraped cloth mesh GLB (e.g. a simple grid plane).'
                },
                outputGlbPath: { type: 'STRING', description: 'Path to write the final draped mesh GLB.' },
                pinnedVertexIndices: {
                    type: 'ARRAY',
                    items: { type: 'NUMBER' },
                    description: 'Vertex indices to pin in place (zero mass, never move), e.g. a flag\'s pole edge.'
                },
                sphereObstacles: {
                    type: 'ARRAY',
                    items: {
                        type: 'OBJECT',
                        properties: {
                            x: { type: 'NUMBER' },
                            y: { type: 'NUMBER' },
                            z: { type: 'NUMBER' },
                            radius: { type: 'NUMBER' }
                        },
                        required: ['x', 'y', 'z', 'radius']
                    },
                    description: 'Sphere obstacles the cloth drapes over/around.'
                },
                groundY: {
                    type: 'NUMBER',
                    description: 'If provided, adds a ground-plane obstacle at this world Y. Omit entirely for no ground plane.'
                },
                particleMass: { type: 'NUMBER', description: 'Mass per cloth particle in kg (default 0.1, matching initFromMesh).' },
                stretchCompliance: { type: 'NUMBER', description: 'Stretch-constraint compliance, m/N (default 1e-6, matching initFromMesh).' },
                bendCompliance: { type: 'NUMBER', description: 'Bending-constraint compliance, rad/N (default 1e-4, matching initFromMesh).' },
                steps: { type: 'NUMBER', description: 'Number of outer simulation steps to run (default 200).' },
                dtSeconds: { type: 'NUMBER', description: 'Timestep per outer step in seconds (default 1/60).' },
                substeps: { type: 'NUMBER', description: 'XPBD substeps per step (default 10, matching the header default).' },
                gravityY: { type: 'NUMBER', description: 'Gravitational acceleration along Y (default -9.81).' }
            },
            required: ['clothGlbPath', 'outputGlbPath']
        }
    }
];

const CLOTH_DRAPE_SOURCE = `
#include "scratchbox_gltf_scene.hpp"
#include "scratchbox_xpbd.hpp"
#include <cstdio>
#include <cstdlib>
#include <fstream>
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

int main(int argc, char** argv) {
    if (argc < 14) {
        std::fprintf(stderr,
            "usage: clothGlb outGlb pinnedFile sphereFile groundY hasGround particleMass "
            "stretchComp bendComp steps dtSeconds substeps gravityY\\n");
        return 1;
    }

    gltf::GltfScene scene = loadSceneOrDie(argv[1]);

    float particleMass = static_cast<float>(std::atof(argv[7]));
    float stretchComp = static_cast<float>(std::atof(argv[8]));
    float bendComp = static_cast<float>(std::atof(argv[9]));
    int steps = std::atoi(argv[10]);
    float dt = static_cast<float>(std::atof(argv[11]));
    int substeps = std::atoi(argv[12]);
    float gravityY = static_cast<float>(std::atof(argv[13]));

    xpbd::XpbdClothSimulator sim;
    sim.initFromMesh(scene.mesh, particleMass, stretchComp, bendComp);
    sim.gravity = Vec3(0.0f, gravityY, 0.0f);

    std::ifstream pinFile(argv[3]);
    int pinCount = 0;
    pinFile >> pinCount;
    for (int i = 0; i < pinCount; ++i) {
        size_t idx = 0;
        pinFile >> idx;
        sim.pinParticle(idx);
    }

    std::ifstream sphereFile(argv[4]);
    int sphereCount = 0;
    sphereFile >> sphereCount;
    for (int i = 0; i < sphereCount; ++i) {
        xpbd::SphereObstacle sphere;
        sphereFile >> sphere.center.x >> sphere.center.y >> sphere.center.z >> sphere.radius;
        sim.sphereObstacles.push_back(sphere);
    }

    bool hasGround = std::string(argv[6]) == "1";
    if (hasGround) {
        xpbd::GroundPlaneObstacle ground;
        ground.yLevel = static_cast<float>(std::atof(argv[5]));
        sim.groundObstacles.push_back(ground);
    }

    for (int i = 0; i < steps; ++i) {
        sim.step(dt, substeps);
    }

    sim.syncToMesh(scene.mesh);

    if (!io::GlbWriter::writeToFile(scene.mesh, argv[2])) {
        std::fprintf(stderr, "Failed to write output GLB: %s\\n", argv[2]);
        return 1;
    }

    math::AABB bounds;
    for (const auto& v : scene.mesh.vertices) bounds.expand(v.position);

    std::printf(
        "{\\"particleCount\\":%zu,\\"stretchConstraints\\":%zu,\\"bendingConstraints\\":%zu,"
        "\\"sphereObstacles\\":%d,\\"hasGroundObstacle\\":%s,\\"stepsRun\\":%d,"
        "\\"bounds\\":{\\"min\\":[%.6f,%.6f,%.6f],\\"max\\":[%.6f,%.6f,%.6f]}}\\n",
        sim.particles.size(), sim.stretchConstraints.size(), sim.bendingConstraints.size(),
        sphereCount, hasGround ? "true" : "false", steps,
        bounds.min.x, bounds.min.y, bounds.min.z, bounds.max.x, bounds.max.y, bounds.max.z
    );
    return 0;
}
`;

interface SphereObstacleRequest {
    x: number;
    y: number;
    z: number;
    radius: number;
}

interface ClothDrapeRequest {
    clothGlbPath: string;
    outputGlbPath: string;
    pinnedVertexIndices?: number[];
    sphereObstacles?: SphereObstacleRequest[];
    groundY?: number;
    particleMass?: number;
    stretchCompliance?: number;
    bendCompliance?: number;
    steps?: number;
    dtSeconds?: number;
    substeps?: number;
    gravityY?: number;
}

async function clothDrapeHandler(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolHandlerOutcome> {
    const request = args as unknown as ClothDrapeRequest;
    try {
        const {
            clothGlbPath,
            outputGlbPath,
            pinnedVertexIndices = [],
            sphereObstacles = [],
            groundY,
            particleMass = 0.1,
            stretchCompliance = 1e-6,
            bendCompliance = 1e-4,
            steps = 200,
            dtSeconds = 1 / 60,
            substeps = 10,
            gravityY = -9.81
        } = request;

        if (!fs.existsSync(clothGlbPath)) {
            return { status: 'failed', resultPayload: { error: `Cloth GLB file not found: ${clothGlbPath}` } };
        }
        fs.mkdirSync(path.dirname(outputGlbPath), { recursive: true });

        const pinFile = tempPath('xpbd-pins', 'txt');
        fs.writeFileSync(pinFile, [String(pinnedVertexIndices.length), ...pinnedVertexIndices.map(String)].join('\n'));

        const sphereFile = tempPath('xpbd-spheres', 'txt');
        const sphereLines = [String(sphereObstacles.length)];
        for (const s of sphereObstacles) sphereLines.push(`${s.x} ${s.y} ${s.z} ${s.radius}`);
        fs.writeFileSync(sphereFile, sphereLines.join('\n'));

        const hasGround = typeof groundY === 'number';

        try {
            const stdout = await compileAndRun(
                'xpbd_cloth_drape',
                CLOTH_DRAPE_SOURCE,
                [
                    clothGlbPath,
                    outputGlbPath,
                    pinFile,
                    sphereFile,
                    String(hasGround ? groundY : 0),
                    hasGround ? '1' : '0',
                    String(particleMass),
                    String(stretchCompliance),
                    String(bendCompliance),
                    String(steps),
                    String(dtSeconds),
                    String(substeps),
                    String(gravityY)
                ],
                5 * 60_000
            );
            const stats = lastJsonLine(stdout) as Record<string, unknown>;

            return {
                status: 'completed',
                resultPayload: { outputGlbPath, ...stats },
                summaryResult: `Draped cloth over ${steps} steps, ${sphereObstacles.length} sphere obstacle(s)${hasGround ? ', 1 ground plane' : ''} -> ${outputGlbPath}`
            };
        } finally {
            fs.rmSync(pinFile, { force: true });
            fs.rmSync(sphereFile, { force: true });
        }
    } catch (e) {
        const stderr = (e as Error & { stderr?: string }).stderr;
        return { status: 'failed', resultPayload: { error: `Cloth drape simulation failed: ${stderr || String(e)}` } };
    }
}

export const xpbdClothHandlers: Array<[ToolDeclaration, ToolHandler]> = [
    [XPBD_CLOTH_TOOL_DECLARATIONS[0], clothDrapeHandler]
];
