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
 * Ballistic glass-fracture VFX tool, driving `scratchbox_fracture.hpp` (physically-simulated
 * Voronoi glass-pane fracture: frame, intact perimeter, shards with momentum/rotation integrated
 * to a chosen simulation time, bullet projectile and supersonic Mach shockwave cone) and writing
 * the assembled scene through `scratchbox_io.hpp`'s GlbWriter, following the same
 * compile-once/execFile pattern as the BVH query tools. All pane/bullet parameters that the
 * previous keyword-triggered caller hardcoded (pane size, impact speed, caliber, Mach number,
 * simulation time) are exposed here as real numeric arguments.
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

export const GLASS_FRACTURE_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'vfx_fracture_glass_pane',
        description:
            'Generates a physically-simulated Voronoi glass-pane fracture (bullet/ballistic impact) as a GLB — a framed ' +
            'pane, intact outer perimeter, shattered shards with momentum/rotation already integrated to a chosen ' +
            'simulation time, the projectile, and a supersonic Mach shockwave cone — via the native analytical fracture ' +
            'generator (scratchbox_fracture.hpp). Useful for VFX shots of glass breaking, bullet penetration, impact ' +
            'damage. Every pane and bullet parameter is continuous and freely variable (pane size, impact velocity, ' +
            'caliber, simulation time) — there is no fixed "style" preset.',
        parameters: {
            type: 'OBJECT',
            properties: {
                outputGlbPath: { type: 'STRING', description: 'Path to write the output .glb fracture scene' },
                paneWidth: { type: 'NUMBER', description: 'Total glass pane width in meters (default 4.0)' },
                paneHeight: { type: 'NUMBER', description: 'Total glass pane height in meters (default 3.0)' },
                paneThickness: { type: 'NUMBER', description: 'Glass plate thickness in meters (default 0.06)' },
                frameThickness: { type: 'NUMBER', description: 'Perimeter frame border thickness in meters (default 0.18)' },
                frameDepth: { type: 'NUMBER', description: 'Perimeter frame border depth in meters (default 0.22)' },
                radialCrackCount: { type: 'NUMBER', description: 'Number of radial fracture rays (default 28)' },
                concentricRings: { type: 'NUMBER', description: 'Number of concentric fracture rings (default 5)' },
                innerCoreRadius: { type: 'NUMBER', description: 'Radius of the pulverized impact core hole in meters (default 0.14)' },
                outerFractureRadius: {
                    type: 'NUMBER',
                    description: 'Radius beyond which glass remains anchored/intact, in meters (default 1.45)'
                },
                bulletCaliber: { type: 'NUMBER', description: 'Projectile diameter in meters, cinematic scale (default 0.12)' },
                bulletLength: { type: 'NUMBER', description: 'Projectile length tip-to-base in meters (default 0.46)' },
                bulletSpeed: { type: 'NUMBER', description: 'Muzzle/impact velocity in m/s (default 820)' },
                bulletMachNumber: { type: 'NUMBER', description: 'Supersonic Mach number, drives the shockwave cone angle (default 2.4)' },
                simulationTimeSec: {
                    type: 'NUMBER',
                    description: 'Seconds into the fracture to render; larger values mean shards have traveled further (default 0.08)'
                }
            },
            required: ['outputGlbPath']
        }
    }
];

const GLASS_FRACTURE_SOURCE = `
#include "scratchbox_fracture.hpp"
#include "scratchbox_io.hpp"
#include <cstdio>
#include <cstdlib>

using namespace scratchbox;
using scratchbox::math::Vec3;
using scratchbox::geometry::ScratchboxMesh;
using scratchbox::fracture::GlassPaneConfig;
using scratchbox::fracture::BulletConfig;
using scratchbox::fracture::GlassFractureGenerator;

int main(int argc, char** argv) {
    if (argc < 16) {
        std::fprintf(stderr,
            "usage: outGlb paneWidth paneHeight paneThickness frameThickness frameDepth "
            "radialCrackCount concentricRings innerCoreRadius outerFractureRadius "
            "bulletCaliber bulletLength bulletSpeed bulletMachNumber simulationTimeSec\\n");
        return 1;
    }

    const char* outputPath = argv[1];

    GlassPaneConfig pane;
    pane.width = static_cast<float>(std::atof(argv[2]));
    pane.height = static_cast<float>(std::atof(argv[3]));
    pane.thickness = static_cast<float>(std::atof(argv[4]));
    pane.frameThickness = static_cast<float>(std::atof(argv[5]));
    pane.frameDepth = static_cast<float>(std::atof(argv[6]));
    pane.radialCrackCount = std::atoi(argv[7]);
    pane.concentricRings = std::atoi(argv[8]);
    pane.innerCoreRadius = static_cast<float>(std::atof(argv[9]));
    pane.outerFractureRadius = static_cast<float>(std::atof(argv[10]));

    BulletConfig bullet;
    bullet.caliber = static_cast<float>(std::atof(argv[11]));
    bullet.length = static_cast<float>(std::atof(argv[12]));
    bullet.speed = static_cast<float>(std::atof(argv[13]));
    bullet.machNumber = static_cast<float>(std::atof(argv[14]));

    float simulationTime = static_cast<float>(std::atof(argv[15]));

    ScratchboxMesh scene = GlassFractureGenerator::buildCompleteScene(pane, bullet, simulationTime);

    if (!io::GlbWriter::writeToFile(scene, outputPath)) {
        std::fprintf(stderr, "Failed to write output GLB: %s\\n", outputPath);
        return 1;
    }

    int shardCount = 0;
    {
        int rings = pane.concentricRings;
        int sectors = pane.radialCrackCount;
        for (int r = 0; r < rings; ++r) {
            int currentSectors = sectors - r * 3;
            if (currentSectors < 8) currentSectors = 8;
            shardCount += currentSectors;
        }
    }

    std::printf("{\\"vertices\\":%zu,\\"triangles\\":%zu,\\"shardCount\\":%d,\\"simulationTimeSec\\":%.6f}\\n",
        scene.vertices.size(), scene.indices.size() / 3, shardCount, simulationTime);
    return 0;
}
`;

interface FractureGlassPaneRequest {
    outputGlbPath: string;
    paneWidth?: number;
    paneHeight?: number;
    paneThickness?: number;
    frameThickness?: number;
    frameDepth?: number;
    radialCrackCount?: number;
    concentricRings?: number;
    innerCoreRadius?: number;
    outerFractureRadius?: number;
    bulletCaliber?: number;
    bulletLength?: number;
    bulletSpeed?: number;
    bulletMachNumber?: number;
    simulationTimeSec?: number;
}

async function fractureGlassPaneHandler(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolHandlerOutcome> {
    const request = args as unknown as FractureGlassPaneRequest;
    try {
        const { outputGlbPath } = request;
        if (!outputGlbPath) {
            return { status: 'failed', resultPayload: { error: 'outputGlbPath is required' } };
        }
        fs.mkdirSync(path.dirname(outputGlbPath), { recursive: true });

        const paneWidth = request.paneWidth ?? 4.0;
        const paneHeight = request.paneHeight ?? 3.0;
        const paneThickness = request.paneThickness ?? 0.06;
        const frameThickness = request.frameThickness ?? 0.18;
        const frameDepth = request.frameDepth ?? 0.22;
        const radialCrackCount = request.radialCrackCount ?? 28;
        const concentricRings = request.concentricRings ?? 5;
        const innerCoreRadius = request.innerCoreRadius ?? 0.14;
        const outerFractureRadius = request.outerFractureRadius ?? 1.45;
        const bulletCaliber = request.bulletCaliber ?? 0.12;
        const bulletLength = request.bulletLength ?? 0.46;
        const bulletSpeed = request.bulletSpeed ?? 820;
        const bulletMachNumber = request.bulletMachNumber ?? 2.4;
        const simulationTimeSec = request.simulationTimeSec ?? 0.08;

        const stdout = await compileAndRun(
            'vfx_fracture_glass_pane',
            GLASS_FRACTURE_SOURCE,
            [
                outputGlbPath,
                String(paneWidth),
                String(paneHeight),
                String(paneThickness),
                String(frameThickness),
                String(frameDepth),
                String(radialCrackCount),
                String(concentricRings),
                String(innerCoreRadius),
                String(outerFractureRadius),
                String(bulletCaliber),
                String(bulletLength),
                String(bulletSpeed),
                String(bulletMachNumber),
                String(simulationTimeSec)
            ],
            5 * 60_000
        );
        const stats = lastJsonLine(stdout) as Record<string, unknown>;

        return {
            status: 'completed',
            resultPayload: { outputGlbPath, ...stats },
            summaryResult: `Glass fracture (${paneWidth}x${paneHeight}m pane, ${bulletSpeed}m/s impact, t=${simulationTimeSec}s) -> ${outputGlbPath}`
        };
    } catch (e) {
        const stderr = (e as Error & { stderr?: string }).stderr;
        return { status: 'failed', resultPayload: { error: `Glass fracture generation failed: ${stderr || String(e)}` } };
    }
}

export const glassFractureHandlers: Array<[ToolDeclaration, ToolHandler]> = [
    [GLASS_FRACTURE_TOOL_DECLARATIONS[0], fractureGlassPaneHandler]
];
