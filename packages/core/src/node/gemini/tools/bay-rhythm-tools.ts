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
 * Facade bay-rhythm & elevation-profile analysis tools.
 * Drives `scratchbox_tectonic_analyzer.hpp` (ElevationHistogram's vertical density histogram with
 * derivative-based datum detection, and BayRhythmAutocorrelation's discrete spatial autocorrelation
 * for horizontal bay/intercolumniation spacing) against any GLB mesh, read natively via
 * `scratchbox_gltf_scene.hpp`'s GlbSceneReader. Measurements only — no structure-type labels, per
 * the header's own comment: naming what a building "is" is left to the caller.
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

export const BAY_RHYTHM_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'facade_analyze_bay_rhythm',
        description:
            "Analyzes a facade mesh's vertical elevation profile and horizontal periodicity (window/column \"bay\" " +
            'spacing) via autocorrelation (scratchbox_tectonic_analyzer.hpp: ElevationHistogram + ' +
            'BayRhythmAutocorrelation) — useful for validating that a generated or reconstructed facade reads as ' +
            'architecturally rhythmic/real, or for measuring real building proportions from a scan.',
        parameters: {
            type: 'OBJECT',
            properties: {
                glbPath: {
                    type: 'STRING',
                    description: 'Path to the .glb facade/building mesh to analyze'
                },
                elevationBinSizeMeters: {
                    type: 'NUMBER',
                    description: 'Bin size in meters for the vertical elevation density histogram (default 0.20)'
                },
                bayStepSizeMeters: {
                    type: 'NUMBER',
                    description: 'Sample step size in meters for the horizontal autocorrelation scan (default 0.10, matching the header\'s own default)'
                }
            },
            required: ['glbPath']
        }
    }
];

// Loads the mesh, runs ElevationHistogram::analyze for the vertical profile, then scans a 3m
// elevation band at 45% of the measured height for BayRhythmAutocorrelation::analyze (the same
// slice convention TectonicMeasurementAnalyzer::analyze uses in the header), with the horizontal
// scan bounds taken from the mesh's own X extent. Prints both results as one combined JSON object.
const BAY_RHYTHM_ANALYZE_SOURCE = `
#include "scratchbox_gltf_scene.hpp"
#include "scratchbox_tectonic_analyzer.hpp"
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <vector>

using namespace scratchbox;
using namespace scratchbox::tectonics;
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
    if (argc < 4) { std::fprintf(stderr, "usage: glb elevationBinSize bayStepSize\\n"); return 1; }
    gltf::GltfScene scene = loadSceneOrDie(argv[1]);
    float binSize = static_cast<float>(std::atof(argv[2]));
    float stepSize = static_cast<float>(std::atof(argv[3]));

    std::vector<Vec3> points;
    points.reserve(scene.mesh.vertices.size());
    for (const auto& v : scene.mesh.vertices) points.push_back(v.position);

    TectonicElevationProfile profile = ElevationHistogram::analyzePoints(points, binSize);

    float minX = std::numeric_limits<float>::max();
    float maxX = std::numeric_limits<float>::lowest();
    for (const auto& p : points) {
        minX = std::min(minX, p.x);
        maxX = std::max(maxX, p.x);
    }
    if (points.empty()) { minX = 0.0f; maxX = 0.0f; }

    float midY = profile.groundElevation + profile.totalHeight * 0.45f;
    float sliceMinY = midY - 1.5f;
    float sliceMaxY = midY + 1.5f;
    BayRhythmAnalysis bayRhythm = BayRhythmAutocorrelation::analyze(points, minX, maxX, sliceMinY, sliceMaxY, stepSize);

    std::printf(
        "{\\"elevationProfile\\":{\\"groundElevation\\":%.6f,\\"topElevation\\":%.6f,\\"totalHeight\\":%.6f,\\"storyElevations\\":[",
        profile.groundElevation, profile.topElevation, profile.totalHeight);
    for (size_t i = 0; i < profile.storyElevations.size(); ++i) {
        if (i > 0) std::printf(",");
        std::printf("%.6f", profile.storyElevations[i]);
    }
    std::printf("],\\"springlines\\":[");
    for (size_t i = 0; i < profile.springlines.size(); ++i) {
        if (i > 0) std::printf(",");
        std::printf("%.6f", profile.springlines[i]);
    }
    std::printf("],\\"entablatures\\":[");
    for (size_t i = 0; i < profile.entablatures.size(); ++i) {
        if (i > 0) std::printf(",");
        std::printf("%.6f", profile.entablatures[i]);
    }
    std::printf("],\\"detectedDatums\\":[");
    for (size_t i = 0; i < profile.detectedDatums.size(); ++i) {
        if (i > 0) std::printf(",");
        std::printf("{\\"y\\":%.6f,\\"label\\":\\"%s\\",\\"density\\":%.6f}",
            profile.detectedDatums[i].y, profile.detectedDatums[i].label.c_str(), profile.detectedDatums[i].density);
    }
    std::printf(
        "]},\\"bayRhythm\\":{\\"fundamentalBayWidth\\":%.6f,\\"pierWidth\\":%.6f,\\"clearOpeningWidth\\":%.6f,"
        "\\"autocorrelationScore\\":%.6f,\\"estimatedBayCount\\":%d},"
        "\\"scanBounds\\":{\\"minX\\":%.6f,\\"maxX\\":%.6f,\\"sliceMinY\\":%.6f,\\"sliceMaxY\\":%.6f,\\"stepSize\\":%.6f}}\\n",
        bayRhythm.fundamentalBayWidth, bayRhythm.pierWidth, bayRhythm.clearOpeningWidth,
        bayRhythm.autocorrelationScore, bayRhythm.estimatedBayCount,
        minX, maxX, sliceMinY, sliceMaxY, stepSize);
    return 0;
}
`;

interface BayRhythmAnalyzeRequest {
    glbPath: string;
    elevationBinSizeMeters?: number;
    bayStepSizeMeters?: number;
}

interface TectonicElevationProfileResult {
    groundElevation: number;
    topElevation: number;
    totalHeight: number;
    storyElevations: number[];
    springlines: number[];
    entablatures: number[];
    detectedDatums: Array<{ y: number; label: string; density: number }>;
}

interface BayRhythmAnalysisResult {
    fundamentalBayWidth: number;
    pierWidth: number;
    clearOpeningWidth: number;
    autocorrelationScore: number;
    estimatedBayCount: number;
}

interface BayRhythmAnalyzeReport {
    elevationProfile: TectonicElevationProfileResult;
    bayRhythm: BayRhythmAnalysisResult;
    scanBounds: { minX: number; maxX: number; sliceMinY: number; sliceMaxY: number; stepSize: number };
}

async function analyzeBayRhythmHandler(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolHandlerOutcome> {
    const request = args as unknown as BayRhythmAnalyzeRequest;
    try {
        const { glbPath, elevationBinSizeMeters = 0.2, bayStepSizeMeters = 0.1 } = request;
        if (!fs.existsSync(glbPath)) {
            return { status: 'failed', resultPayload: { error: `GLB file not found: ${glbPath}` } };
        }

        const stdout = await compileAndRun('bay_rhythm_analyze', BAY_RHYTHM_ANALYZE_SOURCE, [
            glbPath,
            String(elevationBinSizeMeters),
            String(bayStepSizeMeters)
        ]);
        const report = JSON.parse(stdout.trim()) as BayRhythmAnalyzeReport;

        const { fundamentalBayWidth, estimatedBayCount, autocorrelationScore } = report.bayRhythm;
        const { totalHeight } = report.elevationProfile;
        const summaryResult =
            fundamentalBayWidth > 0
                ? `Bay rhythm: fundamental bay width ${fundamentalBayWidth.toFixed(2)}m (~${estimatedBayCount} bays, autocorrelation ${autocorrelationScore.toFixed(2)}); total height ${totalHeight.toFixed(2)}m`
                : `No clear bay rhythm detected; total height ${totalHeight.toFixed(2)}m`;

        return {
            status: 'completed',
            resultPayload: { glbPath, ...report },
            summaryResult
        };
    } catch (e) {
        const stderr = (e as Error & { stderr?: string }).stderr;
        return { status: 'failed', resultPayload: { error: `Bay rhythm analysis failed: ${stderr || String(e)}` } };
    }
}

export const bayRhythmHandlers: Array<[ToolDeclaration, ToolHandler]> = [
    [BAY_RHYTHM_TOOL_DECLARATIONS[0], analyzeBayRhythmHandler]
];
