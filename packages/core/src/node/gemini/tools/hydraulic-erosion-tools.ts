/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Exposes the native engine's particle-based hydraulic droplet erosion and thermal (talus/scree) weathering
 * simulator (`HydraulicErosionSimulator`, `scratchbox_infiniti.hpp`) as a standalone callable tool. Until now the
 * only call site was inline inside `Adaptive3DSceneSynthesizer`'s generated terrain, with no way to ask for an
 * eroded terrain patch on its own. This generates a `WarpedTerrainConfig` heightfield, erodes it, and streams the
 * resulting mesh as a binary glTF (.glb), following the same generate-source / compile / execute / read-glb pattern
 * as the rest of the C++20 generator tools: no JavaScript stand-in geometry.
 */

import * as fs from 'fs';
import * as path from 'path';
import { NativeCppCompilerService } from '../../3d-engine/native-compiler-service';
import type { ToolDeclaration, ToolHandler, ToolHandlerOutcome, ToolResultPayload } from './types';

const compiler = new NativeCppCompilerService();

/** A finite number for C++ source; throws on anything else (model-authored values end up inert, never injected). */
function cppFloat(value: unknown, fallback: number, field: string): string {
    const n = value === undefined || value === null ? fallback : value;
    if (typeof n !== 'number' || !Number.isFinite(n)) throw new Error(`${field} must be a finite number`);
    const s = String(n);
    return `${s.includes('.') || s.includes('e') || s.includes('E') ? s : `${s}.0`}f`;
}
function cppInt(value: unknown, fallback: number, field: string): string {
    const n = value === undefined || value === null ? fallback : value;
    if (typeof n !== 'number' || !Number.isFinite(n)) throw new Error(`${field} must be a finite number`);
    return String(Math.round(n));
}
function cppUint(value: unknown, fallback: number, field: string): string {
    return `${cppInt(value, fallback, field)}u`;
}
function cppBool(value: unknown, fallback: boolean): string {
    return (value === undefined || value === null ? fallback : Boolean(value)) ? 'true' : 'false';
}

export interface HydraulicErosionParams {
    /** Heightfield grid resolution per side (33..1025). Default 129. */
    gridResolution?: number;
    /** Physical size of the terrain patch in metres, square. Default 200. */
    extentMeters?: number;
    terrain?: {
        macroSlopeX?: number; macroSlopeZ?: number;
        warpScale?: number; warpFreq?: number; warpOctaves?: number;
        contentScale?: number; contentFreq?: number; contentOctaves?: number;
        strataDuneScale?: number; strataDuneFreq?: number;
        slopeScale?: number; slopeFreq?: number;
        seed?: number;
    };
    erosion?: {
        /** Water droplets simulated; drives both erosion strength and compute time. Default 2000. */
        iterations?: number;
        maxDropletLifetime?: number;
        inertia?: number;
        sedimentCapacityFactor?: number;
        depositSpeed?: number;
        erodeSpeed?: number;
        evaporateSpeed?: number;
        /** Talus/scree settling pass after the droplet pass. Default true. */
        enableThermalWeathering?: boolean;
        thermalIterations?: number;
        talusAngleThresholdDeg?: number;
        thermalTalusRate?: number;
        seed?: number;
    };
    outputGlbPath?: string;
}

export interface HydraulicErosionResult {
    outputGlbPath: string;
    vertexCount: number;
    triangleCount: number;
    compilationTimeMs: number;
    executionTimeMs: number;
}

function generateCppSource(p: HydraulicErosionParams): string {
    const grid = Math.max(33, Math.min(1025, Math.round(p.gridResolution ?? 129)));
    const extent = Math.max(1, p.extentMeters ?? 200);
    const t = p.terrain ?? {};
    const e = p.erosion ?? {};
    return `// Generated on demand: hydraulic erosion / thermal weathering of a procedural terrain patch.
// Zero hardcoded scene files; the heightfield and its erosion are both evaluated in C++20.
#include "scratchbox_infiniti.hpp"
#include "scratchbox_io.hpp"

#include <iostream>
#include <fstream>
#include <vector>
#include <string>

using namespace scratchbox;
using namespace scratchbox::math;
using namespace scratchbox::geometry;
using namespace scratchbox::infiniti;

int main(int argc, char** argv) {
    if (argc < 2) { std::cerr << "ERROR: output path required as argv[1]" << std::endl; return 1; }
    const std::string outGlbPath = argv[1];

    const int cols = ${cppInt(grid, 129, 'gridResolution')};
    const int rows = cols;
    const float extent = ${cppFloat(extent, 200, 'extentMeters')};
    const float step = extent / static_cast<float>(cols - 1);
    const float minX = -extent * 0.5f;
    const float minZ = -extent * 0.5f;

    WarpedTerrainConfig terrainCfg;
    terrainCfg.macroSlopeX = ${cppFloat(t.macroSlopeX, -0.016, 'terrain.macroSlopeX')};
    terrainCfg.macroSlopeZ = ${cppFloat(t.macroSlopeZ, -0.024, 'terrain.macroSlopeZ')};
    terrainCfg.warpScale = ${cppFloat(t.warpScale, 1.85, 'terrain.warpScale')};
    terrainCfg.warpFreq = ${cppFloat(t.warpFreq, 0.075, 'terrain.warpFreq')};
    terrainCfg.warpOctaves = ${cppInt(t.warpOctaves, 3, 'terrain.warpOctaves')};
    terrainCfg.contentScale = ${cppFloat(t.contentScale, 0.68, 'terrain.contentScale')};
    terrainCfg.contentFreq = ${cppFloat(t.contentFreq, 0.14, 'terrain.contentFreq')};
    terrainCfg.contentOctaves = ${cppInt(t.contentOctaves, 4, 'terrain.contentOctaves')};
    terrainCfg.strataDuneScale = ${cppFloat(t.strataDuneScale, 0.22, 'terrain.strataDuneScale')};
    terrainCfg.strataDuneFreq = ${cppFloat(t.strataDuneFreq, 0.38, 'terrain.strataDuneFreq')};
    terrainCfg.slopeScale = ${cppFloat(t.slopeScale, 0.45, 'terrain.slopeScale')};
    terrainCfg.slopeFreq = ${cppFloat(t.slopeFreq, 0.06, 'terrain.slopeFreq')};
    terrainCfg.seed = ${cppUint(t.seed, 1337, 'terrain.seed')};

    HydraulicErosionConfig erosionCfg;
    erosionCfg.iterations = ${cppInt(e.iterations, 2000, 'erosion.iterations')};
    erosionCfg.maxDropletLifetime = ${cppInt(e.maxDropletLifetime, 35, 'erosion.maxDropletLifetime')};
    erosionCfg.inertia = ${cppFloat(e.inertia, 0.15, 'erosion.inertia')};
    erosionCfg.sedimentCapacityFactor = ${cppFloat(e.sedimentCapacityFactor, 4.0, 'erosion.sedimentCapacityFactor')};
    erosionCfg.depositSpeed = ${cppFloat(e.depositSpeed, 0.3, 'erosion.depositSpeed')};
    erosionCfg.erodeSpeed = ${cppFloat(e.erodeSpeed, 0.3, 'erosion.erodeSpeed')};
    erosionCfg.evaporateSpeed = ${cppFloat(e.evaporateSpeed, 0.02, 'erosion.evaporateSpeed')};
    erosionCfg.enableThermalWeathering = ${cppBool(e.enableThermalWeathering, true)};
    erosionCfg.thermalIterations = ${cppInt(e.thermalIterations, 4, 'erosion.thermalIterations')};
    erosionCfg.talusAngleThresholdDeg = ${cppFloat(e.talusAngleThresholdDeg, 33.0, 'erosion.talusAngleThresholdDeg')};
    erosionCfg.thermalTalusRate = ${cppFloat(e.thermalTalusRate, 0.35, 'erosion.thermalTalusRate')};
    erosionCfg.seed = ${cppUint(e.seed, 4242, 'erosion.seed')};

    ScratchboxMesh mesh = HydraulicErosionSimulator::generateErodedTerrainMesh(
        cols, rows, minX, minZ, step, terrainCfg, erosionCfg, "ErodedTerrain"
    );

    std::vector<uint8_t> glbData = io::GlbWriter::writeGlb(mesh);
    if (glbData.empty()) { std::cerr << "ERROR: erosion produced an empty mesh" << std::endl; return 1; }

    std::ofstream glbFile(outGlbPath, std::ios::binary);
    if (!glbFile.is_open()) { std::cerr << "ERROR: failed to open output path: " << outGlbPath << std::endl; return 1; }
    glbFile.write(reinterpret_cast<const char*>(glbData.data()), static_cast<std::streamsize>(glbData.size()));
    glbFile.close();

    std::cout << "TOTAL_VERTS:" << mesh.vertices.size() << std::endl;
    std::cout << "TOTAL_TRIS:" << (mesh.indices.size() / 3) << std::endl;
    return 0;
}
`;
}

async function erodeTerrain(params: HydraulicErosionParams): Promise<ToolResultPayload> {
    try {
        const sourceCode = generateCppSource(params);
        const outputDir = path.resolve(process.cwd(), '.scratchbox', 'artifacts');
        fs.mkdirSync(outputDir, { recursive: true });
        const outGlbPath = params.outputGlbPath || path.join(outputDir, `eroded_terrain_${Date.now()}.glb`);
        fs.mkdirSync(path.dirname(outGlbPath), { recursive: true });

        const compileResult = await compiler.compileSource(sourceCode, {
            outputDir: path.resolve(process.cwd(), 'build/3d-native'),
            outputBinaryName: 'hydraulic_erosion_terrain',
            optimization: '-O3'
        });
        if (!compileResult.success || !compileResult.binaryPath) {
            const errorMsg = compileResult.diagnostics.map(d => `${d.file}:${d.line} - ${d.message}`).join('\n') || compileResult.compilerOutput;
            return { success: false, error: `Compilation failed: ${errorMsg}` };
        }

        const execResult = await compiler.executeBinary(compileResult.binaryPath, [outGlbPath], path.dirname(outGlbPath));
        if (!execResult.success) {
            return { success: false, error: `Execution failed (exit code ${execResult.exitCode}): ${execResult.stderr || execResult.stdout}` };
        }
        if (!fs.existsSync(outGlbPath)) {
            return { success: false, error: `the erosion binary reported success but wrote no GLB at ${outGlbPath}` };
        }

        const vertMatch = execResult.stdout.match(/TOTAL_VERTS:(\d+)/);
        const triMatch = execResult.stdout.match(/TOTAL_TRIS:(\d+)/);

        const result: HydraulicErosionResult = {
            outputGlbPath: outGlbPath,
            vertexCount: vertMatch ? parseInt(vertMatch[1], 10) : 0,
            triangleCount: triMatch ? parseInt(triMatch[1], 10) : 0,
            compilationTimeMs: compileResult.compilationTimeMs,
            executionTimeMs: execResult.executionTimeMs
        };

        return {
            success: true,
            ...result,
            provenance: 'generated',
            message: `Eroded a ${params.extentMeters ?? 200}m terrain patch (${result.vertexCount} vertices, ${result.triangleCount} triangles) with ${params.erosion?.iterations ?? 2000} droplet iterations${(params.erosion?.enableThermalWeathering ?? true) ? ' and thermal talus settling' : ''}. Vertex colors encode sediment deposition (R), carved erosion (G) and elevation (B). Written to ${outGlbPath}.`
        };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, error: msg };
    }
}

export const HYDRAULIC_EROSION_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'erode_terrain',
        description:
            'Generates a procedural terrain patch and runs the native engine\'s particle-based hydraulic droplet erosion plus thermal (talus/scree) weathering on it (HydraulicErosionSimulator, scratchbox_infiniti.hpp), returning a real eroded .glb mesh — never a flat heightmap or a JavaScript stand-in. Each simulated water droplet carves sediment downhill and deposits it where it slows; thermal settling then slides loose material down slopes steeper than the talus angle. Vertex colors on the output encode sediment deposition (R), carved erosion (G) and elevation (B) so the result can be inspected directly. Use this for raw ground terrain (mountainsides, gullies, scree slopes, riverbeds) — for pitting, corrosion or decay on a built object or structure, use mesh_edit\'s relief operation with no direction instead.',
        parameters: {
            type: 'OBJECT',
            properties: {
                gridResolution: { type: 'NUMBER', description: 'Heightfield grid resolution per side, 33-1025. Higher is slower but more detailed. Default 129.' },
                extentMeters: { type: 'NUMBER', description: 'Physical size of the square terrain patch in metres. Default 200.' },
                terrain: {
                    type: 'OBJECT',
                    description: 'Baseline warped-terrain heightfield parameters (WarpedTerrainConfig) evaluated before erosion. All optional; omitted fields use the engine\'s own defaults.',
                    properties: {
                        macroSlopeX: { type: 'NUMBER', description: 'Overall slope gradient along X. Default -0.016.' },
                        macroSlopeZ: { type: 'NUMBER', description: 'Overall slope gradient along Z. Default -0.024.' },
                        warpScale: { type: 'NUMBER', description: 'Domain-warp displacement magnitude. Default 1.85.' },
                        warpFreq: { type: 'NUMBER', description: 'Domain-warp noise frequency. Default 0.075.' },
                        warpOctaves: { type: 'NUMBER', description: 'Domain-warp noise octaves. Default 3.' },
                        contentScale: { type: 'NUMBER', description: 'Fine surface detail noise amplitude. Default 0.68.' },
                        contentFreq: { type: 'NUMBER', description: 'Fine surface detail noise frequency. Default 0.14.' },
                        contentOctaves: { type: 'NUMBER', description: 'Fine surface detail noise octaves. Default 4.' },
                        strataDuneScale: { type: 'NUMBER', description: 'Strata/dune banding amplitude. Default 0.22.' },
                        strataDuneFreq: { type: 'NUMBER', description: 'Strata/dune banding frequency. Default 0.38.' },
                        slopeScale: { type: 'NUMBER', description: 'Slope-aligned detail amplitude. Default 0.45.' },
                        slopeFreq: { type: 'NUMBER', description: 'Slope-aligned detail frequency. Default 0.06.' },
                        seed: { type: 'NUMBER', description: 'Noise seed for the baseline heightfield. Default 1337.' }
                    }
                },
                erosion: {
                    type: 'OBJECT',
                    description: 'Hydraulic droplet erosion and thermal weathering parameters (HydraulicErosionConfig). All optional; omitted fields use the engine\'s own defaults.',
                    properties: {
                        iterations: { type: 'NUMBER', description: 'Water droplets simulated. More carves deeper, more realistic channels but costs more compute. Default 2000.' },
                        maxDropletLifetime: { type: 'NUMBER', description: 'Max steps a single droplet flows before stopping. Default 35.' },
                        inertia: { type: 'NUMBER', description: 'How much a droplet keeps its previous direction (0..1). Default 0.15.' },
                        sedimentCapacityFactor: { type: 'NUMBER', description: 'How much sediment a droplet can carry relative to its speed. Default 4.0.' },
                        depositSpeed: { type: 'NUMBER', description: 'Deposition rate when a droplet is over capacity. Default 0.3.' },
                        erodeSpeed: { type: 'NUMBER', description: 'Erosion cutting rate when a droplet is under capacity. Default 0.3.' },
                        evaporateSpeed: { type: 'NUMBER', description: 'Droplet evaporation rate per step. Default 0.02.' },
                        enableThermalWeathering: { type: 'BOOLEAN', description: 'Run a talus/scree thermal settling pass after the droplet pass. Default true.' },
                        thermalIterations: { type: 'NUMBER', description: 'Thermal settling passes. Default 4.' },
                        talusAngleThresholdDeg: { type: 'NUMBER', description: 'Angle of repose above which material slides downhill. Default 33.' },
                        thermalTalusRate: { type: 'NUMBER', description: 'Fraction of excess material moved per thermal pass. Default 0.35.' },
                        seed: { type: 'NUMBER', description: 'Random seed for droplet placement. Default 4242.' }
                    }
                },
                outputGlbPath: { type: 'STRING', description: 'Where to write the eroded .glb. Defaults to a generated path under .scratchbox/artifacts.' }
            }
        }
    }
];

const toOutcome = (resultPayload: ToolResultPayload): ToolHandlerOutcome =>
    resultPayload.success === false ? { resultPayload, status: 'failed' } : { resultPayload };

export const HYDRAULIC_EROSION_TOOL_HANDLERS: Record<string, ToolHandler> = {
    erode_terrain: async (params: HydraulicErosionParams) => toOutcome(await erodeTerrain(params))
};
