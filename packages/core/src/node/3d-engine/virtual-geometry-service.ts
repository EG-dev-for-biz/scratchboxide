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
import * as path from 'path';
import { promisify } from 'util';
import { NativeCppCompilerService } from './native-compiler-service';

const execFileAsync = promisify(execFile);

/**
 * Driver for `scratchbox_virtual_geometry.hpp`: GLB in, streamable cluster LOD DAG (.sbvg) out,
 * build statistics as one JSON line on stdout.
 */
const BUILDER_SOURCE = `
#include "scratchbox_virtual_geometry.hpp"
#include <chrono>
#include <cstdio>
using namespace scratchbox::vgeo;

int main(int argc, char** argv) {
    if (argc < 3) { std::fprintf(stderr, "usage: sbvg_builder <input.glb> <output.sbvg>\\n"); return 2; }
    try {
        auto t0 = std::chrono::steady_clock::now();
        SourceMesh src = GlbSceneLoader::loadFile(argv[1]);
        WeldedMesh mesh = weld(src);
        auto t1 = std::chrono::steady_clock::now();
        ClusterDag dag = buildClusterDag(std::move(mesh));
        auto t2 = std::chrono::steady_clock::now();
        SbvgSummary s = writeSbvg(dag, argv[2]);
        auto ms = [](auto a, auto b) { return std::chrono::duration<double, std::milli>(b - a).count(); };
        std::printf("{\\"sourceTriangles\\":%u,\\"weldedVertices\\":%zu,\\"droppedDegenerate\\":%u,\\"skippedPrimitives\\":%u,"
                    "\\"vertexCount\\":%u,\\"clusterCount\\":%u,\\"triangleCount\\":%u,\\"leafTriangleCount\\":%u,\\"levelCount\\":%u,"
                    "\\"fileBytes\\":%llu,\\"loadMs\\":%.1f,\\"dagMs\\":%.1f,\\"levels\\":[",
                    dag.mesh.sourceTriangles, dag.mesh.positions.size(), dag.mesh.droppedDegenerate, src.skippedPrimitives,
                    s.vertexCount, s.clusterCount, s.triangleCount, s.leafTriangleCount, s.levelCount,
                    (unsigned long long)s.fileBytes, ms(t0, t1), ms(t1, t2));
        for (size_t i = 0; i < dag.levels.size(); ++i) {
            const auto& l = dag.levels[i];
            std::printf("%s{\\"level\\":%u,\\"clusters\\":%u,\\"triangles\\":%u,\\"groups\\":%u,\\"stuckGroups\\":%u,\\"maxError\\":%g}",
                        i ? "," : "", l.level, l.clusters, l.triangles, l.groups, l.stuckGroups, l.maxError);
        }
        std::printf("]}\\n");
        return 0;
    } catch (const std::exception& e) {
        std::fprintf(stderr, "sbvg_builder: %s\\n", e.what());
        return 1;
    }
}
`;

export interface VirtualGeometryLevelStats {
    level: number;
    clusters: number;
    triangles: number;
    groups: number;
    /** Groups whose locked borders left too little to simplify; carried up unchanged. */
    stuckGroups: number;
    maxError: number;
}

export interface VirtualGeometryBuildStats {
    sourceTriangles: number;
    weldedVertices: number;
    droppedDegenerate: number;
    skippedPrimitives: number;
    vertexCount: number;
    clusterCount: number;
    triangleCount: number;
    leafTriangleCount: number;
    levelCount: number;
    fileBytes: number;
    loadMs: number;
    dagMs: number;
    levels: VirtualGeometryLevelStats[];
}

export interface VirtualGeometryBuildResult {
    sbvgPath: string;
    stats: VirtualGeometryBuildStats;
    compileMs: number;
    buildMs: number;
}

export class VirtualGeometryBuildError extends Error {
    constructor(message: string, readonly output?: string) {
        super(message);
    }
}

/**
 * Builds `.sbvg` virtual geometry (cluster LOD DAG) files from GLB scenes with the native C++20
 * builder. The builder binary is compiled on first use and reused through the native build cache.
 */
export class VirtualGeometryBuildService {
    private binary: Promise<string> | null = null;
    private compileMs = 0;

    constructor(private readonly compiler: NativeCppCompilerService = NativeCppCompilerService.getInstance()) {}

    private ensureBinary(): Promise<string> {
        if (!this.binary) {
            this.binary = (async () => {
                const result = await this.compiler.compileSource(BUILDER_SOURCE, {
                    outputDir: path.resolve(process.cwd(), 'build', '3d-native'),
                    outputBinaryName: 'sbvg_builder',
                    optimization: '-O3'
                });
                this.compileMs = result.compilationTimeMs;
                if (!result.success || !result.binaryPath) {
                    throw new VirtualGeometryBuildError('Compiling the virtual geometry builder failed', result.compilerOutput);
                }
                return result.binaryPath;
            })();
            this.binary.catch(() => { this.binary = null; });
        }
        return this.binary;
    }

    /** Builds `outputSbvgPath` from `inputGlbPath`. Throws VirtualGeometryBuildError with the builder's message on failure. */
    async build(inputGlbPath: string, outputSbvgPath: string, timeoutMs = 10 * 60_000): Promise<VirtualGeometryBuildResult> {
        if (!fs.existsSync(inputGlbPath)) throw new VirtualGeometryBuildError(`Input GLB not found: ${inputGlbPath}`);
        const binary = await this.ensureBinary();
        fs.mkdirSync(path.dirname(outputSbvgPath), { recursive: true });
        const tmp = `${outputSbvgPath}.tmp-${process.pid}-${Date.now()}`;
        const start = Date.now();
        try {
            const { stdout } = await execFileAsync(binary, [inputGlbPath, tmp], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
            const stats = JSON.parse(stdout.trim().split('\n').pop() || '{}') as VirtualGeometryBuildStats;
            fs.renameSync(tmp, outputSbvgPath);
            return { sbvgPath: outputSbvgPath, stats, compileMs: this.compileMs, buildMs: Date.now() - start };
        } catch (err: any) {
            fs.rmSync(tmp, { force: true });
            if (err instanceof VirtualGeometryBuildError) throw err;
            const detail = (err?.stderr || err?.message || String(err)).toString().trim();
            throw new VirtualGeometryBuildError(`Virtual geometry build failed: ${detail}`, err?.stderr);
        }
    }
}
