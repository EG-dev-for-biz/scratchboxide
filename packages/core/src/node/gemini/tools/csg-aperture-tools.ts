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
 * Architectural aperture (window/door) wall generator, driving `scratchbox_csg.hpp` (exact planar
 * half-edge CSG cutter — analytical aperture cutting with reveal jambs, sills and lintels, not a
 * mesh boolean) and writing the result through `scratchbox_io.hpp`'s GlbWriter, following the same
 * compile-once/execFile pattern as the BVH query tools.
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

function tempPath(prefix: string, ext: string): string {
    return path.join(os.tmpdir(), `${prefix}-${process.pid}-${crypto.randomBytes(6).toString('hex')}.${ext}`);
}

export const CSG_APERTURE_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'mesh_generate_wall_with_apertures',
        description:
            'Generates an exact architectural wall plane (as a GLB) with one or more precisely cut window/door apertures ' +
            '(recessed reveal jambs + lintel + sill reveals), using analytical half-edge CSG (scratchbox_csg.hpp) rather than ' +
            'a mesh boolean. The wall lies on the standard XY plane (origin at the wall center, +X is width, +Y is height, ' +
            'normal is +Z). Useful for adding or editing windows and doors on a facade with correct real-world clearance math. ' +
            'Multiple apertures are automatically partitioned into non-overlapping wall columns.',
        parameters: {
            type: 'OBJECT',
            properties: {
                outputGlbPath: { type: 'STRING', description: 'Path to write the output .glb wall mesh' },
                wallWidth: { type: 'NUMBER', description: 'Total wall width in meters (along +X)' },
                wallHeight: { type: 'NUMBER', description: 'Total wall height in meters (along +Y)' },
                apertures: {
                    type: 'ARRAY',
                    description: 'One or more window/door apertures to cut into the wall.',
                    items: {
                        type: 'OBJECT',
                        properties: {
                            centerOffsetU: {
                                type: 'NUMBER',
                                description: 'Horizontal offset of the aperture center from the wall center, in meters (default 0)'
                            },
                            centerOffsetV: {
                                type: 'NUMBER',
                                description: 'Vertical offset of the aperture center from the wall center, in meters (default 0)'
                            },
                            width: { type: 'NUMBER', description: 'Aperture width in meters' },
                            height: { type: 'NUMBER', description: 'Aperture height in meters' },
                            recessDepth: {
                                type: 'NUMBER',
                                description: 'Depth of the window/door reveal jamb in meters (default 0.25)'
                            },
                            sillHeight: { type: 'NUMBER', description: 'Height of the sill projection in meters (default 0.08)' },
                            sillDepth: { type: 'NUMBER', description: 'Forward projection of the sill in meters (default 0.12)' },
                            isDoor: {
                                type: 'BOOLEAN',
                                description: 'If true, the aperture extends to the base of the wall like a door (default false)'
                            }
                        },
                        required: ['width', 'height']
                    }
                }
            },
            required: ['outputGlbPath', 'wallWidth', 'wallHeight', 'apertures']
        }
    }
];

const APERTURE_WALL_SOURCE = `
#include "scratchbox_csg.hpp"
#include "scratchbox_io.hpp"
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <vector>

using namespace scratchbox;
using scratchbox::math::Vec2;
using scratchbox::math::Vec3;
using scratchbox::geometry::ScratchboxMesh;
using scratchbox::csg::ApertureSpec;

int main(int argc, char** argv) {
    if (argc < 5) { std::fprintf(stderr, "usage: outGlb apertureFile wallWidth wallHeight\\n"); return 1; }
    const char* outputPath = argv[1];
    const char* apertureFilePath = argv[2];
    float wallWidth = static_cast<float>(std::atof(argv[3]));
    float wallHeight = static_cast<float>(std::atof(argv[4]));

    std::ifstream af(apertureFilePath);
    int count = 0;
    af >> count;
    std::vector<ApertureSpec> apertures;
    apertures.reserve(static_cast<size_t>(count));
    for (int i = 0; i < count; ++i) {
        float u, v, w, h, recess, sillH, sillD;
        int isDoorFlag;
        af >> u >> v >> w >> h >> recess >> sillH >> sillD >> isDoorFlag;

        ApertureSpec ap;
        ap.centerOffset = Vec2(u, v);
        ap.size = Vec2(w, h);
        ap.recessDepth = recess;
        ap.sillHeight = sillH;
        ap.sillDepth = sillD;
        ap.isDoor = isDoorFlag != 0;
        apertures.push_back(ap);
    }

    ScratchboxMesh mesh;
    Vec3 origin(0.0f, 0.0f, 0.0f);
    Vec3 uDir(1.0f, 0.0f, 0.0f);
    Vec3 vDir(0.0f, 1.0f, 0.0f);

    csg::generateFacadeWithApertures(mesh, origin, uDir, vDir, wallWidth, wallHeight, apertures);
    mesh.recomputeBounds();

    if (!io::GlbWriter::writeToFile(mesh, outputPath)) {
        std::fprintf(stderr, "Failed to write output GLB: %s\\n", outputPath);
        return 1;
    }

    std::printf("{\\"vertices\\":%zu,\\"triangles\\":%zu,\\"apertureCount\\":%d}\\n",
        mesh.vertices.size(), mesh.indices.size() / 3, count);
    return 0;
}
`;

interface ApertureInput {
    centerOffsetU?: number;
    centerOffsetV?: number;
    width: number;
    height: number;
    recessDepth?: number;
    sillHeight?: number;
    sillDepth?: number;
    isDoor?: boolean;
}

interface WallWithAperturesRequest {
    outputGlbPath: string;
    wallWidth: number;
    wallHeight: number;
    apertures: ApertureInput[];
}

async function generateWallWithAperturesHandler(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolHandlerOutcome> {
    const request = args as unknown as WallWithAperturesRequest;
    try {
        const { outputGlbPath, wallWidth, wallHeight, apertures } = request;
        if (!outputGlbPath || !wallWidth || !wallHeight || !apertures) {
            return { status: 'failed', resultPayload: { error: 'outputGlbPath, wallWidth, wallHeight and apertures are required' } };
        }
        fs.mkdirSync(path.dirname(outputGlbPath), { recursive: true });

        const apertureFile = tempPath('csg-apertures', 'txt');
        const lines = [String(apertures.length)];
        for (const ap of apertures) {
            const centerOffsetU = ap.centerOffsetU ?? 0;
            const centerOffsetV = ap.centerOffsetV ?? 0;
            const recessDepth = ap.recessDepth ?? 0.25;
            const sillHeight = ap.sillHeight ?? 0.08;
            const sillDepth = ap.sillDepth ?? 0.12;
            const isDoor = ap.isDoor ?? false;
            lines.push(
                `${centerOffsetU} ${centerOffsetV} ${ap.width} ${ap.height} ${recessDepth} ${sillHeight} ${sillDepth} ${isDoor ? 1 : 0}`
            );
        }
        fs.writeFileSync(apertureFile, lines.join('\n'));

        try {
            const stdout = await compileAndRun(
                'csg_wall_with_apertures',
                APERTURE_WALL_SOURCE,
                [outputGlbPath, apertureFile, String(wallWidth), String(wallHeight)],
                5 * 60_000
            );
            const stats = lastJsonLine(stdout) as Record<string, unknown>;

            return {
                status: 'completed',
                resultPayload: { outputGlbPath, ...stats },
                summaryResult: `Wall with ${apertures.length} aperture(s) generated -> ${outputGlbPath}`
            };
        } finally {
            fs.rmSync(apertureFile, { force: true });
        }
    } catch (e) {
        const stderr = (e as Error & { stderr?: string }).stderr;
        return { status: 'failed', resultPayload: { error: `Wall aperture generation failed: ${stderr || String(e)}` } };
    }
}

export const csgApertureHandlers: Array<[ToolDeclaration, ToolHandler]> = [
    [CSG_APERTURE_TOOL_DECLARATIONS[0], generateWallWithAperturesHandler]
];
