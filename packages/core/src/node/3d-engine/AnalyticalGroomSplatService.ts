/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs';
import * as path from 'path';
import { NativeCppCompilerService } from './native-compiler-service';
import { MissingInputError } from '../../common/errors/pipeline-errors';
import type {
    AnalyticalGroomContract,
    AnalyticalGroomExecutionResult,
    ContinuousSurfaceDescriptor,
    ContinuousGroomDescriptor,
    ContinuousSplatOptions
} from '../../common/spatial/analytical-groom-types';

/** The descriptors {@link AnalyticalGroomSplatService.buildContract} turns into a contract. */
export interface AnalyticalGroomDescriptors {
    id?: string;
    surface?: ContinuousSurfaceDescriptor;
    groom?: ContinuousGroomDescriptor;
    splat?: ContinuousSplatOptions;
}

/**
 * Analytical Groom & 3D Gaussian Splatting Service.
 *
 * Strict ADA Invariants:
 * - Zero Closed Taxonomies: No static shape enums; parameterized exclusively via continuous
 *   physical descriptors (radius, harmonic frequencies, amplitudes, curl, clumping, melanin).
 * - Forward Problem Formulation: Directly projects geometric hair strands into oriented 3D Gaussians.
 *   Eliminates the circular 3D -> 2D -> 3D inverse photogrammetry anti-pattern.
 * - Ephemeral Compilation: Synthesizes generator C++ on the fly, compiles via Clang (-std=c++20 -O3 -lz),
 *   and serializes directly to Niantic SPZ v2 / PLY / GLB in milliseconds with zero repo clutter.
 */
export class AnalyticalGroomSplatService {
    private static instance?: AnalyticalGroomSplatService;
    private compiler: NativeCppCompilerService;

    public static getInstance(compiler?: NativeCppCompilerService): AnalyticalGroomSplatService {
        if (!AnalyticalGroomSplatService.instance || compiler) {
            AnalyticalGroomSplatService.instance = new AnalyticalGroomSplatService(compiler);
        }
        return AnalyticalGroomSplatService.instance;
    }

    constructor(compiler?: NativeCppCompilerService) {
        this.compiler = compiler || NativeCppCompilerService.getInstance();
    }

    /**
     * Builds an AnalyticalGroomContract from explicit continuous descriptors (the caller, or the model reading the
     * user's request, fills them). Nothing is inferred from words: shape (baseRadius, harmonicFrequency,
     * harmonicAmplitude), strand length and pigment (eumelanin + pheomelanin, or baseColorRgb) are required and a
     * MissingInputError names whichever are absent. Strand morphology the caller leaves out is neutral (no curl,
     * wave, clumping or taper); density defaults to 64 guides / 4096 strands / 12 segments, and root/tip width to
     * 3 mm / 0.6 mm.
     */
    public buildContract(descriptors: AnalyticalGroomDescriptors, tool = 'AnalyticalGroomSplatService.buildContract'): AnalyticalGroomContract {
        // Undefined fields are dropped so they never mask a default below.
        const defined = <T extends object>(o: T | undefined): Partial<T> =>
            Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined)) as Partial<T>;
        const surface = defined(descriptors.surface);
        const groom = defined(descriptors.groom);
        const missing: string[] = [];
        if (surface.baseRadius === undefined) missing.push('baseRadius');
        if (surface.harmonicFrequency === undefined) missing.push('harmonicFrequency');
        if (surface.harmonicAmplitude === undefined) missing.push('harmonicAmplitude');
        if (groom.length === undefined) missing.push('length');
        const hasMelanin = groom.eumelanin !== undefined && groom.pheomelanin !== undefined;
        if (!hasMelanin && groom.baseColorRgb === undefined) missing.push('eumelanin and pheomelanin, or baseColorRgb');
        if (missing.length) {
            throw new MissingInputError(tool, missing.join(', '),
                'give the groom as continuous descriptors (shape harmonics, strand length, pigment); they are not inferred from a description');
        }

        const bad: string[] = [];
        const inRange = (name: string, v: number | undefined, lo: number, hi: number) => {
            if (v !== undefined && !(Number.isFinite(v) && v >= lo && v <= hi)) bad.push(`${name}=${v} (expected ${lo}..${hi})`);
        };
        if (!(surface.baseRadius! > 0)) bad.push(`baseRadius=${surface.baseRadius} (expected > 0)`);
        if (!Number.isInteger(surface.harmonicFrequency) || surface.harmonicFrequency! < 0) bad.push(`harmonicFrequency=${surface.harmonicFrequency} (expected an integer >= 0)`);
        inRange('harmonicAmplitude', surface.harmonicAmplitude, 0, 1);
        inRange('axialTaper', surface.axialTaper, -1, 1);
        if (!(groom.length! > 0)) bad.push(`length=${groom.length} (expected > 0)`);
        inRange('clumping', groom.clumping, 0, 1);
        inRange('eumelanin', groom.eumelanin, 0, 1);
        inRange('pheomelanin', groom.pheomelanin, 0, 1);
        for (const key of ['baseColorRgb', 'tipColorRgb'] as const) {
            const rgb = groom[key];
            if (rgb !== undefined && !(Array.isArray(rgb) && rgb.length === 3 && rgb.every(c => Number.isFinite(c) && c >= 0 && c <= 1))) {
                bad.push(`${key} (expected [r, g, b] in 0..1)`);
            }
        }
        if (groom.tipColorRgb !== undefined && groom.baseColorRgb === undefined) bad.push('tipColorRgb needs baseColorRgb');
        if (bad.length) throw new MissingInputError(tool, 'valid groom descriptors', bad.join('; '));

        return {
            id: descriptors.id ?? `groom_splat_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            surface: {
                center: [0, 0, 0],
                axialTaper: 0,
                ...surface
            },
            groom: {
                guideCount: 64,
                strandCount: 4096,
                segmentsPerStrand: 12,
                rootWidth: 0.003,
                tipWidth: 0.0006,
                clumping: 0,
                curlRadius: 0,
                curlFrequency: 0,
                waveFrequency: 0,
                waveAmplitude: 0,
                // Explicit colours override melanin; the generator still reads the melanin fields, so they are zeroed.
                ...(hasMelanin ? {} : { eumelanin: 0, pheomelanin: 0 }),
                ...groom,
                // The generator uses custom colour only with both ends: a root colour alone is uniform root to tip.
                ...(groom.baseColorRgb && !groom.tipColorRgb ? { tipColorRgb: groom.baseColorRgb } : {})
            },
            splat: {
                scaleMultiplier: 1.0,
                opacity: 0.92,
                exportFormat: 'spz',
                ...defined(descriptors.splat)
            }
        };
    }

    private toCppFloat(val: number | undefined, defaultVal: number): string {
        const v = typeof val === 'number' && !isNaN(val) ? val : defaultVal;
        return Number.isInteger(v) ? `${v}.0f` : `${v}f`;
    }

    /**
     * Programmatically generate standalone C++20 generator source code.
     */
    public generateCppSource(
        contract: AnalyticalGroomContract,
        spzPath: string,
        plyPath: string,
        glbPath?: string
    ): string {
        const s = contract.surface;
        const g = contract.groom;
        const splat = contract.splat || {};

        const center = s.center || [0, 0, 0];
        const baseColorStr = g.baseColorRgb
            ? `math::Vec3(${this.toCppFloat(g.baseColorRgb[0], 0)}, ${this.toCppFloat(g.baseColorRgb[1], 0)}, ${this.toCppFloat(g.baseColorRgb[2], 0)})`
            : `math::Vec3(-1.0f, -1.0f, -1.0f)`;
        const tipColorStr = g.tipColorRgb
            ? `math::Vec3(${this.toCppFloat(g.tipColorRgb[0], 0)}, ${this.toCppFloat(g.tipColorRgb[1], 0)}, ${this.toCppFloat(g.tipColorRgb[2], 0)})`
            : `math::Vec3(-1.0f, -1.0f, -1.0f)`;

        const shouldBuildGlb = Boolean(glbPath && (splat.exportFormat === 'glb' || splat.exportFormat === 'all'));

        return `#include <iostream>
#include <fstream>
#include <vector>
#include <string>
#include "scratchbox_hair.hpp"
#include "scratchbox_spz.hpp"
#include "scratchbox_io.hpp"

using namespace scratchbox;

int main(int argc, char** argv) {
    std::cout << "[AnalyticalGroomSplat] Initializing biophysical hair grooming..." << std::endl;

    hair::HairGroomConfig config;
    config.guideCount = ${g.guideCount ?? 64};
    config.strandCount = ${g.strandCount ?? 4096};
    config.segmentsPerStrand = ${g.segmentsPerStrand ?? 12};
    config.length = ${this.toCppFloat(g.length, 0.25)};
    config.rootWidth = ${this.toCppFloat(g.rootWidth, 0.003)};
    config.tipWidth = ${this.toCppFloat(g.tipWidth, 0.0006)};
    config.clumping = ${this.toCppFloat(g.clumping, 0.75)};
    config.curlRadius = ${this.toCppFloat(g.curlRadius, 0.012)};
    config.curlFrequency = ${this.toCppFloat(g.curlFrequency, 3.5)};
    config.waveFrequency = ${this.toCppFloat(g.waveFrequency, 2.0)};
    config.waveAmplitude = ${this.toCppFloat(g.waveAmplitude, 0.008)};
    config.eumelanin = ${this.toCppFloat(g.eumelanin, 0.6)};
    config.pheomelanin = ${this.toCppFloat(g.pheomelanin, 0.2)};

    math::Vec3 center(${this.toCppFloat(center[0], 0)}, ${this.toCppFloat(center[1], 0)}, ${this.toCppFloat(center[2], 0)});
    float baseRadius = ${this.toCppFloat(s.baseRadius, 1.0)};
    int harmonicFrequency = ${s.harmonicFrequency ?? 0};
    float harmonicAmplitude = ${this.toCppFloat(s.harmonicAmplitude, 0.0)};
    float axialTaper = ${this.toCppFloat(s.axialTaper, 0.0)};

    auto guides = hair::HairGroomer::generateHarmonicGuides(
        center, baseRadius, harmonicFrequency, harmonicAmplitude, config, axialTaper
    );

    auto strands = hair::HairGroomer::synthesizeDenseStrands(guides, config);

    math::Vec3 customBaseColor = ${baseColorStr};
    math::Vec3 customTipColor = ${tipColorStr};

    float scaleMultiplier = ${this.toCppFloat(splat.scaleMultiplier, 1.0)};
    float baseOpacity = ${this.toCppFloat(splat.opacity, 0.92)};

    auto splats = hair::HairSplatBuilder::buildStrandSplats(
        strands, scaleMultiplier, baseOpacity, customBaseColor, customTipColor
    );

    hair::HairSplatBuilder::saveToSpzFile("${spzPath}", splats);
    hair::HairSplatBuilder::saveToPlyFile("${plyPath}", splats);

    ${shouldBuildGlb ? `
    // Also build surfel mesh glb
    auto surfelMesh = spz::SplatMeshBuilder::buildSurfelMesh(splats, 1.25f, 0.05f);
    io::ScratchboxGlbWriter::saveToFile("${glbPath}", surfelMesh);
    ` : ''}

    std::cout << "__SPLATS_DONE__ count=" << splats.size() << " strands=" << strands.size() << std::endl;
    return 0;
}
`;
    }

    /**
     * Compile and execute an AnalyticalGroomContract.
     * Ephemerally builds via NativeCppCompilerService and outputs the requested SPZ/PLY/GLB files.
     */
    public async executeGroomSplat(
        contract: AnalyticalGroomContract,
        options: {
            outputDir?: string;
            keepIntermediateFiles?: boolean;
        } = {}
    ): Promise<AnalyticalGroomExecutionResult> {
        const startTime = Date.now();
        const outputDir = options.outputDir || path.resolve(process.cwd(), 'build/analytical-groom', contract.id);
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        const spzPath = path.join(outputDir, `${contract.id}.spz`);
        const plyPath = path.join(outputDir, `${contract.id}.ply`);
        const glbPath = path.join(outputDir, `${contract.id}.glb`);

        const sourceCode = this.generateCppSource(contract, spzPath, plyPath, glbPath);

        // 1. Ephemeral Compilation
        const compileResult = await this.compiler.compileSource(sourceCode, {
            outputDir,
            outputBinaryName: `groom_bin_${contract.id}`,
            optimization: '-O3',
            extraFlags: ['-lz']
        });

        if (!compileResult.success || !compileResult.binaryPath) {
            return {
                success: false,
                contract,
                splatCount: 0,
                strandCount: 0,
                executionTimeMs: 0,
                compilationTimeMs: compileResult.compilationTimeMs,
                error: `Compilation failed: ${compileResult.compilerOutput}`
            };
        }

        // 2. Binary Execution
        const execResult = await this.compiler.executeBinary(compileResult.binaryPath, [], outputDir);

        if (!execResult.success || execResult.exitCode !== 0) {
            return {
                success: false,
                contract,
                splatCount: 0,
                strandCount: 0,
                executionTimeMs: execResult.executionTimeMs,
                compilationTimeMs: compileResult.compilationTimeMs,
                error: `Execution failed (exit ${execResult.exitCode}): ${execResult.stderr || execResult.stdout}`
            };
        }

        // 3. Parse Output Statistics
        let splatCount = 0;
        let strandCount = 0;
        const match = execResult.stdout.match(/__SPLATS_DONE__ count=(\d+) strands=(\d+)/);
        if (match) {
            splatCount = parseInt(match[1], 10);
            strandCount = parseInt(match[2], 10);
        }

        let spzBuffer: Uint8Array | undefined;
        let finalSpzPath: string | undefined;
        if (fs.existsSync(spzPath)) {
            finalSpzPath = spzPath;
            spzBuffer = fs.readFileSync(spzPath);
        }

        const finalPlyPath = fs.existsSync(plyPath) ? plyPath : undefined;
        const finalGlbPath = fs.existsSync(glbPath) ? glbPath : undefined;

        // Clean up intermediate binary and .cpp generator if requested (zero repo proliferation)
        if (!options.keepIntermediateFiles) {
            try {
                if (fs.existsSync(compileResult.binaryPath)) {
                    fs.unlinkSync(compileResult.binaryPath);
                }
                const cppSource = path.join(outputDir, `groom_bin_${contract.id}.cpp`);
                if (fs.existsSync(cppSource)) {
                    fs.unlinkSync(cppSource);
                }
            } catch {
                // Non-fatal cleanup error
            }
        }

        return {
            success: true,
            contract,
            splatCount,
            strandCount,
            spzPath: finalSpzPath,
            spzBuffer,
            plyPath: finalPlyPath,
            glbPath: finalGlbPath,
            executionTimeMs: execResult.executionTimeMs,
            compilationTimeMs: compileResult.compilationTimeMs
        };
    }
}
