/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The measured masonry coursing (facade-materials.ts CourseReading) through the PBR kernel's structured pattern
 * (scratchbox_pbr_manifold.hpp: courseHeightAt / bakeCourseNormalProfile): one course's tangent-space normal profile per
 * reading, at its measured pitch and joint width. The driver is synthesized here and compiled ephemerally through
 * NativeCppCompilerService (cached by content); parameters go in as arguments, the profile comes back on stdout.
 *
 * The viewer samples the profile by world height (phase and pitch per reading), so the joints are drawn at their real
 * size whatever the atlas's texel density. A failed compile or run is thrown: the caller records it and leaves the walls
 * without relief (the next simpler real data), never with a made-up pattern.
 */

import { execFile } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { NativeCppCompilerService } from '../native-compiler-service';

export const COURSE_PROFILE_ROWS = 128;

const DRIVER = `
#include <iostream>
#include <string>
#include <vector>
#include "scratchbox_pbr_manifold.hpp"
using namespace scratchbox;
int main(int argc, char** argv) {
    if (argc < 5) { std::cout << "{\\"success\\":false}" << std::endl; return 2; }
    pbr_manifold::ContinuousMaterialDescriptor d;
    d.coursePitchM = std::stof(argv[1]);
    d.jointWidthM = std::stof(argv[2]);
    d.jointDepthM = std::stof(argv[3]);
    const int rows = std::stoi(argv[4]);
    std::vector<float> n, h;
    pbr_manifold::bakeCourseNormalProfile(d, rows, n, h);
    std::cout << "{\\"success\\":true,\\"normals\\":[";
    for (size_t i = 0; i < n.size(); ++i) std::cout << (i ? "," : "") << n[i];
    std::cout << "],\\"heights\\":[";
    for (size_t i = 0; i < h.size(); ++i) std::cout << (i ? "," : "") << h[i];
    std::cout << "]}" << std::endl;
    return 0;
}
`;

let compiled: Promise<string> | undefined;

async function driverBinary(): Promise<string> {
    compiled ??= (async () => {
        const res = await new NativeCppCompilerService().compileSource(DRIVER, {
            outputDir: path.join(os.tmpdir(), 'scratchbox_course_relief'), outputBinaryName: 'course_relief_profile', optimization: '-O2'
        });
        if (!res.success || !res.binaryPath) throw new Error(`the coursing kernel did not compile: ${String(res.compilerOutput ?? '').slice(0, 600)}`);
        return res.binaryPath;
    })();
    compiled.catch(() => { compiled = undefined; });
    return compiled;
}

export interface CourseProfile { pitchM: number; jointWidthM: number; jointDepthM: number; rows: number; normals: Float32Array; heights: Float32Array }

/** One reading's profile from the kernel. */
export async function bakeCourseProfile(pitchM: number, jointWidthM: number, jointDepthM: number, rows = COURSE_PROFILE_ROWS): Promise<CourseProfile> {
    const bin = await driverBinary();
    const stdout = await new Promise<string>((resolve, reject) => execFile(bin, [String(pitchM), String(jointWidthM), String(jointDepthM), String(rows)], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
        (err, out) => (err ? reject(err) : resolve(out))));
    const parsed = JSON.parse(stdout.trim()) as { success: boolean; normals: number[]; heights: number[] };
    if (!parsed.success || parsed.normals.length !== rows * 3) throw new Error('the coursing kernel returned no profile');
    return { pitchM, jointWidthM, jointDepthM, rows, normals: Float32Array.from(parsed.normals), heights: Float32Array.from(parsed.heights) };
}

/**
 * The profiles as one RGB image for the viewer: column k*4..k*4+3 is reading k, row r is the r-th sample over one pitch
 * (row 0 at a joint centre); the tangent-space normal encoded n * 0.5 + 0.5.
 */
export function courseProfilesImage(profiles: CourseProfile[]): { width: number; height: number; rgb: Uint8Array } {
    const rows = profiles[0]?.rows ?? COURSE_PROFILE_ROWS;
    const width = Math.max(4, profiles.length * 4), height = rows;
    const rgb = new Uint8Array(width * height * 3);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const p = profiles[Math.floor(x / 4)];
        const o = (y * width + x) * 3;
        const n = p ? [p.normals[y * 3], p.normals[y * 3 + 1], p.normals[y * 3 + 2]] : [0, 0, 1];
        for (let c = 0; c < 3; c++) rgb[o + c] = Math.round(Math.min(1, Math.max(0, n[c] * 0.5 + 0.5)) * 255);
    }
    return { width, height, rgb };
}
