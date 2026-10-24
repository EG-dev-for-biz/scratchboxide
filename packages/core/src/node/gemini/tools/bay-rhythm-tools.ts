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
            'architecturally rhythmic/real, or for measuring real building proportions from a scan. ' +
            'IMPORTANT: the underlying autocorrelation bins strictly on global X/Y, so by default this only gives a ' +
            "correct bay width when the mesh IS a single flat wall already facing global north/south (or when it's " +
            'a small building whose footprint happens to align with X). For a building with multiple walls at ' +
            'different orientations (an angled facade, a non-rectangular footprint, a full building rather than one ' +
            'isolated wall), pass wallOrigin/wallNormal/wallAxisS — a point on the wall\'s plane, its outward normal, ' +
            'and its horizontal in-plane direction (e.g. from a massing/facade-decomposition step that already ' +
            'identified this wall) — to restrict the scan to points near that one plane and measure periodicity ' +
            'along the wall\'s own direction instead of raw global X. Omitting them analyzes the whole mesh\'s global-X ' +
            'extent, which silently produces a meaningless "bay width" (often tens of meters) on anything but a ' +
            'single axis-aligned wall.',
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
                },
                wallOriginX: { type: 'NUMBER', description: 'A point on the target wall\'s plane, X (world space). Provide all of wallOrigin/wallNormal/wallAxisS together, or omit all of them.' },
                wallOriginY: { type: 'NUMBER', description: 'Wall plane point, Y' },
                wallOriginZ: { type: 'NUMBER', description: 'Wall plane point, Z' },
                wallNormalX: { type: 'NUMBER', description: 'The wall\'s outward normal, X (need not be pre-normalized)' },
                wallNormalY: { type: 'NUMBER', description: 'Wall normal, Y' },
                wallNormalZ: { type: 'NUMBER', description: 'Wall normal, Z' },
                wallAxisSX: { type: 'NUMBER', description: 'The wall\'s horizontal in-plane axis ("along the wall"), X (need not be pre-normalized; must be roughly perpendicular to the normal)' },
                wallAxisSY: { type: 'NUMBER', description: 'Wall horizontal axis, Y' },
                wallAxisSZ: { type: 'NUMBER', description: 'Wall horizontal axis, Z' },
                planeToleranceMeters: {
                    type: 'NUMBER',
                    description: 'Only used with a wall frame: how far from the wall plane (along its normal) a vertex may be and still count as part of this wall (default 0.5m)'
                },
                wallSMin: {
                    type: 'NUMBER',
                    description: 'Only used with a wall frame: the wall\'s known local horizontal extent along wallAxisS, start (e.g. from a massing face\'s sMin). If omitted, computed from whichever points fall within planeToleranceMeters of the plane.'
                },
                wallSMax: {
                    type: 'NUMBER',
                    description: 'Only used with a wall frame: the wall\'s known local horizontal extent along wallAxisS, end (e.g. sMax). Provide both wallSMin and wallSMax together, or omit both.'
                }
            },
            required: ['glbPath']
        }
    }
];

// Loads the mesh, runs ElevationHistogram::analyze for the vertical profile, then scans a 3m
// elevation band at 45% of the measured height for BayRhythmAutocorrelation::analyze (the same
// slice convention TectonicMeasurementAnalyzer::analyze uses in the header). BayRhythmAutocorrelation
// bins strictly on global p.x/p.y (read the header: it has no notion of a wall's own orientation), so
// with no wall frame given, the horizontal scan bounds are the mesh's own raw X extent — correct only
// for a single flat wall already facing global north/south. When a wall frame (origin/normal/axisS) is
// given, points are first filtered to within planeTolerance of that plane and remapped so x = the
// point's local distance along axisS from origin (y is left as elevation, unchanged) — then handed to
// the same unmodified analyze() calls, which now see "along this wall" instead of "along global X".
// Prints both results as one combined JSON object.
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
    if (argc < 18) { std::fprintf(stderr, "usage: glb elevationBinSize bayStepSize hasWallFrame ox oy oz nx ny nz sx sy sz planeTolerance hasSBounds sMin sMax\\n"); return 1; }
    gltf::GltfScene scene = loadSceneOrDie(argv[1]);
    float binSize = static_cast<float>(std::atof(argv[2]));
    float stepSize = static_cast<float>(std::atof(argv[3]));
    bool hasWallFrame = std::string(argv[4]) == "1";
    Vec3 origin(static_cast<float>(std::atof(argv[5])), static_cast<float>(std::atof(argv[6])), static_cast<float>(std::atof(argv[7])));
    Vec3 normal(static_cast<float>(std::atof(argv[8])), static_cast<float>(std::atof(argv[9])), static_cast<float>(std::atof(argv[10])));
    Vec3 axisS(static_cast<float>(std::atof(argv[11])), static_cast<float>(std::atof(argv[12])), static_cast<float>(std::atof(argv[13])));
    float planeTolerance = static_cast<float>(std::atof(argv[14]));
    bool hasSBounds = std::string(argv[15]) == "1";
    float givenSMin = static_cast<float>(std::atof(argv[16]));
    float givenSMax = static_cast<float>(std::atof(argv[17]));

    std::vector<Vec3> rawPoints;
    rawPoints.reserve(scene.mesh.vertices.size());
    for (const auto& v : scene.mesh.vertices) rawPoints.push_back(v.position);

    std::vector<Vec3> points;
    if (hasWallFrame) {
        normal = normal.normalized();
        axisS = axisS.normalized();
        points.reserve(rawPoints.size());
        for (const auto& p : rawPoints) {
            Vec3 rel = p - origin;
            float distFromPlane = rel.dot(normal);
            if (std::abs(distFromPlane) > planeTolerance) continue;
            float s = rel.dot(axisS);
            points.push_back(Vec3(s, p.y, 0.0f));
        }
    } else {
        points = rawPoints;
    }

    TectonicElevationProfile profile = ElevationHistogram::analyzePoints(points, binSize);

    float minX = std::numeric_limits<float>::max();
    float maxX = std::numeric_limits<float>::lowest();
    for (const auto& p : points) {
        minX = std::min(minX, p.x);
        maxX = std::max(maxX, p.x);
    }
    if (points.empty()) { minX = 0.0f; maxX = 0.0f; }
    if (hasWallFrame && hasSBounds) { minX = givenSMin; maxX = givenSMax; }

    float midY = profile.groundElevation + profile.totalHeight * 0.45f;
    float sliceMinY = midY - 1.5f;
    float sliceMaxY = midY + 1.5f;

    // BayRhythmAutocorrelation::analyze() builds its signal as a raw vertex COUNT per s-bucket
    // (signal[idx] += 1.0f), not an occupancy or area measure. A window jamb/sill is tessellated
    // with far more vertices per linear meter than a flat pier face of the same physical width, so
    // the raw count is skewed toward geometric detail rather than true solid/void structure. Fix
    // this at the input, not inside the shared header: keep at most one representative point per
    // s-bucket within the elevation slice, so each bucket contributes at most 1.0 regardless of
    // how densely that patch happens to be tessellated.
    std::vector<Vec3> dedupPoints;
    {
        int numBuckets = std::max(8, static_cast<int>(std::ceil((maxX - minX) / stepSize)));
        std::vector<bool> seen(static_cast<size_t>(numBuckets), false);
        dedupPoints.reserve(static_cast<size_t>(numBuckets));
        for (const auto& p : points) {
            if (p.y < sliceMinY || p.y > sliceMaxY || p.x < minX || p.x > maxX) continue;
            int idx = std::clamp(static_cast<int>((p.x - minX) / stepSize), 0, numBuckets - 1);
            if (seen[static_cast<size_t>(idx)]) continue;
            seen[static_cast<size_t>(idx)] = true;
            dedupPoints.push_back(p);
        }
    }
    BayRhythmAnalysis bayRhythm = BayRhythmAutocorrelation::analyze(dedupPoints, minX, maxX, sliceMinY, sliceMaxY, stepSize);

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
        "\\"scanBounds\\":{\\"minX\\":%.6f,\\"maxX\\":%.6f,\\"sliceMinY\\":%.6f,\\"sliceMaxY\\":%.6f,\\"stepSize\\":%.6f,\\"usedWallFrame\\":%s,\\"pointsInWall\\":%zu,\\"occupiedBuckets\\":%zu}}\\n",
        bayRhythm.fundamentalBayWidth, bayRhythm.pierWidth, bayRhythm.clearOpeningWidth,
        bayRhythm.autocorrelationScore, bayRhythm.estimatedBayCount,
        minX, maxX, sliceMinY, sliceMaxY, stepSize, hasWallFrame ? "true" : "false", points.size(), dedupPoints.size());
    return 0;
}
`;

interface BayRhythmAnalyzeRequest {
    glbPath: string;
    elevationBinSizeMeters?: number;
    bayStepSizeMeters?: number;
    wallOriginX?: number;
    wallOriginY?: number;
    wallOriginZ?: number;
    wallNormalX?: number;
    wallNormalY?: number;
    wallNormalZ?: number;
    wallAxisSX?: number;
    wallAxisSY?: number;
    wallAxisSZ?: number;
    planeToleranceMeters?: number;
    wallSMin?: number;
    wallSMax?: number;
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
    scanBounds: { minX: number; maxX: number; sliceMinY: number; sliceMaxY: number; stepSize: number; usedWallFrame: boolean; pointsInWall: number; occupiedBuckets: number };
}

function hasWallFrameParams(r: BayRhythmAnalyzeRequest): boolean {
    return (
        r.wallOriginX !== undefined && r.wallOriginY !== undefined && r.wallOriginZ !== undefined &&
        r.wallNormalX !== undefined && r.wallNormalY !== undefined && r.wallNormalZ !== undefined &&
        r.wallAxisSX !== undefined && r.wallAxisSY !== undefined && r.wallAxisSZ !== undefined
    );
}

async function analyzeBayRhythmHandler(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolHandlerOutcome> {
    const request = args as unknown as BayRhythmAnalyzeRequest;
    try {
        const { glbPath, elevationBinSizeMeters = 0.2, bayStepSizeMeters = 0.1, planeToleranceMeters = 0.5 } = request;
        if (!fs.existsSync(glbPath)) {
            return { status: 'failed', resultPayload: { error: `GLB file not found: ${glbPath}` } };
        }

        const hasWallFrame = hasWallFrameParams(request);
        const hasSBounds = request.wallSMin !== undefined && request.wallSMax !== undefined;

        const stdout = await compileAndRun('bay_rhythm_analyze', BAY_RHYTHM_ANALYZE_SOURCE, [
            glbPath,
            String(elevationBinSizeMeters),
            String(bayStepSizeMeters),
            hasWallFrame ? '1' : '0',
            String(request.wallOriginX ?? 0), String(request.wallOriginY ?? 0), String(request.wallOriginZ ?? 0),
            String(request.wallNormalX ?? 0), String(request.wallNormalY ?? 0), String(request.wallNormalZ ?? 0),
            String(request.wallAxisSX ?? 0), String(request.wallAxisSY ?? 0), String(request.wallAxisSZ ?? 0),
            String(planeToleranceMeters),
            hasSBounds ? '1' : '0',
            String(request.wallSMin ?? 0), String(request.wallSMax ?? 0)
        ]);
        const report = JSON.parse(stdout.trim()) as BayRhythmAnalyzeReport;

        const { fundamentalBayWidth, estimatedBayCount, autocorrelationScore } = report.bayRhythm;
        const { totalHeight } = report.elevationProfile;
        const frameNote = hasWallFrame
            ? ` (wall-local frame, ${report.scanBounds.pointsInWall} points within ${planeToleranceMeters}m of the plane)`
            : ' (global X — no wall frame given; only correct for a single axis-aligned wall)';
        const summaryResult =
            fundamentalBayWidth > 0
                ? `Bay rhythm: fundamental bay width ${fundamentalBayWidth.toFixed(2)}m (~${estimatedBayCount} bays, autocorrelation ${autocorrelationScore.toFixed(2)}); total height ${totalHeight.toFixed(2)}m${frameNote}`
                : `No clear bay rhythm detected; total height ${totalHeight.toFixed(2)}m${frameNote}`;

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
