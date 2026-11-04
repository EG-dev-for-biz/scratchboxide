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
import { compileNativeCached, defaultNativeFlags, type NativeCompileResult } from './native-build-cache';
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
 * The groom generator: one binary for every groom. argv: spz ply glb('' for none) guideCount strandCount
 * segmentsPerStrand length rootWidth tipWidth clumping curlRadius curlFrequency waveFrequency waveAmplitude eumelanin
 * pheomelanin centerX centerY centerZ baseRadius harmonicFrequency harmonicAmplitude axialTaper baseR baseG baseB
 * tipR tipG tipB scaleMultiplier opacity [bodyGlb bodyR bodyG bodyB] (a colour of -1 -1 -1 means none; the body is
 * written only when a path is given).
 */
const GROOM_GENERATOR_SOURCE = `#include <cstdlib>
#include <iostream>
#include <fstream>
#include <vector>
#include <string>
#include "scratchbox_hair.hpp"
#include "scratchbox_spz.hpp"
#include "scratchbox_io.hpp"

using namespace scratchbox;

int main(int argc, char** argv) {
    if (argc < 32) {
        std::cerr << "analytical_groom: expected 31 arguments, got " << (argc - 1) << std::endl;
        return 2;
    }
    auto f = [&](int i) { return std::strtof(argv[i], nullptr); };
    auto n = [&](int i) { return std::atoi(argv[i]); };
    const std::string spzPath = argv[1];
    const std::string plyPath = argv[2];
    const std::string glbPath = argv[3];
    std::cout << "[AnalyticalGroomSplat] Initializing biophysical hair grooming..." << std::endl;

    hair::HairGroomConfig config;
    config.guideCount = n(4);
    config.strandCount = n(5);
    config.segmentsPerStrand = n(6);
    config.length = f(7);
    config.rootWidth = f(8);
    config.tipWidth = f(9);
    config.clumping = f(10);
    config.curlRadius = f(11);
    config.curlFrequency = f(12);
    config.waveFrequency = f(13);
    config.waveAmplitude = f(14);
    config.eumelanin = f(15);
    config.pheomelanin = f(16);

    math::Vec3 center(f(17), f(18), f(19));
    float baseRadius = f(20);
    int harmonicFrequency = n(21);
    float harmonicAmplitude = f(22);
    float axialTaper = f(23);

    auto guides = hair::HairGroomer::generateHarmonicGuides(
        center, baseRadius, harmonicFrequency, harmonicAmplitude, config, axialTaper
    );

    auto strands = hair::HairGroomer::synthesizeDenseStrands(guides, config);

    math::Vec3 customBaseColor(f(24), f(25), f(26));
    math::Vec3 customTipColor(f(27), f(28), f(29));

    float scaleMultiplier = f(30);
    float baseOpacity = f(31);

    auto splats = hair::HairSplatBuilder::buildStrandSplats(
        strands, scaleMultiplier, baseOpacity, customBaseColor, customTipColor
    );

    hair::HairSplatBuilder::saveToSpzFile(spzPath, splats);
    hair::HairSplatBuilder::saveToPlyFile(plyPath, splats);

    if (!glbPath.empty()) {
        // Also build surfel mesh glb
        auto surfelMesh = spz::SplatMeshBuilder::buildSurfelMesh(splats, 1.25f, 0.05f);
        if (!io::GlbWriter::writeToFile(surfelMesh, glbPath)) {
            std::cerr << "analytical_groom: could not write " << glbPath << std::endl;
            return 1;
        }
    }

    // The body the coat grows from: the same harmonic surface the roots sit on, 1.5 % inside it, in the undercoat
    // colour, so the gaps between strands show skin, not the background.
    const std::string bodyPath = argc > 32 ? argv[32] : "";
    if (!bodyPath.empty()) {
        math::Vec3 bodyColor(f(33), f(34), f(35));
        geometry::ScratchboxMesh body("groom_body");
        const int rings = 96, sectors = 192;
        auto surfacePoint = [&](float th, float ph) {
            float hf = (harmonicFrequency > 0 && std::abs(harmonicAmplitude) > 1e-5f)
                ? harmonicAmplitude * std::cos(static_cast<float>(harmonicFrequency) * ph) * std::sin(th) : 0.0f;
            float r = baseRadius * (1.0f + hf) * (1.0f - axialTaper * std::cos(th)) * 0.985f;
            return center + math::Vec3(std::sin(th) * std::cos(ph), std::cos(th), std::sin(th) * std::sin(ph)) * r;
        };
        for (int i = 0; i <= rings; ++i) {
            for (int j = 0; j <= sectors; ++j) {
                float th = 3.14159265f * i / rings, ph = 6.2831853f * j / sectors;
                math::Vec3 p = surfacePoint(th, ph);
                body.addVertex(geometry::Vertex(p, (p - center).normalized(), math::Vec2(static_cast<float>(j) / sectors, static_cast<float>(i) / rings)));
            }
        }
        for (int i = 0; i < rings; ++i) {
            for (int j = 0; j < sectors; ++j) {
                uint32_t a = i * (sectors + 1) + j, b = a + sectors + 1;
                body.addTriangle(a, b, a + 1);
                body.addTriangle(a + 1, b, b + 1);
            }
        }
        body.recomputeSmoothNormals();
        body.material.baseColorFactor = math::Vec4(bodyColor.x, bodyColor.y, bodyColor.z, 1.0f);
        body.material.roughnessFactor = 0.9f;
        body.material.metallicFactor = 0.0f;
        if (!io::GlbWriter::writeToFile(body, bodyPath)) {
            std::cerr << "analytical_groom: could not write " << bodyPath << std::endl;
            return 1;
        }
    }

    std::cout << "__SPLATS_DONE__ count=" << splats.size() << " strands=" << strands.size() << std::endl;
    return 0;
}
`;

/**
 * The undercoat a groom's body is drawn in (linear RGB): its root colour, given or from its melanin as the native
 * groomer computes it, darkened to 60 % (skin and the shadowed base of a coat read darker than its strands).
 */
export function undercoatColor(groom: { baseColorRgb?: [number, number, number]; eumelanin?: number; pheomelanin?: number }): [number, number, number] {
    const root = groom.baseColorRgb ?? (() => {
        const eum = groom.eumelanin ?? 0.6, pheo = groom.pheomelanin ?? 0.2;
        const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
        return [
            clamp(Math.exp(-(0.419 * eum + 0.187 * pheo) * 4), 0.05, 0.95),
            clamp(Math.exp(-(0.697 * eum + 0.403 * pheo) * 4), 0.04, 0.9),
            clamp(Math.exp(-(1.37 * eum + 1.049 * pheo) * 4), 0.02, 0.85)
        ] as [number, number, number];
    })();
    return root.map(c => +(c * 0.6).toFixed(4)) as [number, number, number];
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

        // A full coat by default: strands in proportion to the surface's area (about 400,000 per square metre, clamped
        // to 20,000..120,000), and a guide for every hundred strands (clamped to 64..1,200).
        const radius = (surface.baseRadius ?? 0.1) * (1 + Math.abs(surface.harmonicAmplitude ?? 0));
        const strands = Math.round(Math.min(120000, Math.max(20000, 400000 * 4 * Math.PI * radius * radius)));
        return {
            id: descriptors.id ?? `groom_splat_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            surface: {
                center: [0, 0, 0],
                axialTaper: 0,
                ...surface
            },
            groom: {
                guideCount: Math.round(Math.min(1200, Math.max(64, strands / 100))),
                strandCount: strands,
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

    /**
     * The command line of the groom generator for a contract: output paths, then every descriptor as decimal text
     * (the generator parses floats with strtof, the same float a C++ literal of that text is). Descriptors the
     * contract leaves out take the generator's defaults.
     */
    public generatorArgs(contract: AnalyticalGroomContract, spzPath: string, plyPath: string, glbPath?: string, bodyGlbPath?: string): string[] {
        const s = contract.surface;
        const g = contract.groom;
        const splat = contract.splat || {};
        const f = (val: number | undefined, defaultVal: number) => String(typeof val === 'number' && !isNaN(val) ? val : defaultVal);
        const i = (val: number | undefined, defaultVal: number) => String(Math.trunc(val ?? defaultVal));
        const center = s.center || [0, 0, 0];
        const rgb = (c?: [number, number, number]) => c ? [f(c[0], 0), f(c[1], 0), f(c[2], 0)] : ['-1', '-1', '-1'];
        const shouldBuildGlb = Boolean(glbPath && (splat.exportFormat === 'glb' || splat.exportFormat === 'all'));
        return [
            spzPath, plyPath, shouldBuildGlb ? glbPath! : '',
            i(g.guideCount, 64), i(g.strandCount, 4096), i(g.segmentsPerStrand, 12),
            f(g.length, 0.25), f(g.rootWidth, 0.003), f(g.tipWidth, 0.0006), f(g.clumping, 0.75),
            f(g.curlRadius, 0.012), f(g.curlFrequency, 3.5), f(g.waveFrequency, 2.0), f(g.waveAmplitude, 0.008),
            f(g.eumelanin, 0.6), f(g.pheomelanin, 0.2),
            f(center[0], 0), f(center[1], 0), f(center[2], 0),
            f(s.baseRadius, 1.0), i(s.harmonicFrequency, 0), f(s.harmonicAmplitude, 0.0), f(s.axialTaper, 0.0),
            ...rgb(g.baseColorRgb), ...rgb(g.tipColorRgb),
            f(splat.scaleMultiplier, 1.0), f(splat.opacity, 0.92),
            ...(bodyGlbPath ? [bodyGlbPath, ...undercoatColor(g).map(c => String(c))] : [])
        ];
    }

    /**
     * Execute an AnalyticalGroomContract and write the requested SPZ/PLY/GLB files. The generator binary is built
     * once (native build cache) and takes the contract on its command line, so a second groom compiles nothing and
     * leaves no binary or source in outputDir.
     */
    public async executeGroomSplat(
        contract: AnalyticalGroomContract,
        options: {
            outputDir?: string;
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
        const bodyGlbPath = path.join(outputDir, `${contract.id}_body.glb`);

        // 1. One generator binary for every groom, built once through the native build cache.
        let compiled: NativeCompileResult;
        try {
            compiled = await compileNativeCached({
                sourceCode: GROOM_GENERATOR_SOURCE,
                includeDirs: [this.compiler.getSdkIncludePath()],
                flags: defaultNativeFlags(),
                libs: ['-lz'],
                name: 'analytical_groom'
            });
        } catch (err: any) {
            return {
                success: false,
                contract,
                splatCount: 0,
                strandCount: 0,
                executionTimeMs: 0,
                compilationTimeMs: Date.now() - startTime,
                error: `Compilation failed: ${err?.compilerOutput || err?.message || err}`
            };
        }
        const compilationTimeMs = compiled.cacheHit ? 0 : compiled.compileMs;

        // 2. Binary Execution
        const execResult = await this.compiler.executeBinary(compiled.binaryPath, this.generatorArgs(contract, spzPath, plyPath, glbPath, bodyGlbPath), outputDir);

        if (!execResult.success || execResult.exitCode !== 0) {
            return {
                success: false,
                contract,
                splatCount: 0,
                strandCount: 0,
                executionTimeMs: execResult.executionTimeMs,
                compilationTimeMs,
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

        return {
            success: true,
            contract,
            splatCount,
            strandCount,
            spzPath: finalSpzPath,
            spzBuffer,
            plyPath: finalPlyPath,
            glbPath: finalGlbPath,
            ...(fs.existsSync(bodyGlbPath) ? { bodyGlbPath } : {}),
            executionTimeMs: execResult.executionTimeMs,
            compilationTimeMs
        };
    }
}
