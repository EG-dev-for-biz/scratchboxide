/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { NativeCppCompilerService } from './native-compiler-service';

const execFileAsync = promisify(execFile);

export type TileShadingMode = 'relit' | 'baked';
export type TileViewLook = 'base' | 'punchy';

export type TileSunSpec =
    | { latitude: number; longitude: number; isoDate: string }
    | { elevationDeg: number; azimuthDeg: number };

export interface TileCameraSpec {
    position: [number, number, number];
    target: [number, number, number];
    /** Screen-up hint; needed when looking straight down and to reproduce camera roll. Defaults to +Y. */
    up?: [number, number, number];
    verticalFovDeg?: number;
    apertureRadius?: number;
    focusDistance?: number;
}

export interface TileAutoCameraSpec {
    auto: {
        /** Downward tilt of the view in degrees. */
        pitchDeg?: number;
        /** Compass direction the camera looks toward, clockwise from true north. */
        headingDeg?: number;
        verticalFovDeg?: number;
        /** Multiplier on the distance that fits the scene's bounding sphere in view. */
        distanceScale?: number;
    };
}

export interface TileAtmosphereSpec {
    siteElevationMeters?: number;
    airDensity?: number;
    dustDensity?: number;
    ozoneDensity?: number;
    sunAngularDiameterDeg?: number;
    sunIntensity?: number;
}

export interface TileDisplacementSpec {
    tessellationFactor?: number;
    displacementScale?: number;
    midpoint?: number;
    sampleTextureHeight?: boolean;
    textureHeightWeight?: number;
    enableProceduralNoise?: boolean;
    proceduralNoiseScale?: number;
    proceduralNoiseFrequency?: number;
    recomputeSmoothNormals?: boolean;
    exportDisplacedGlb?: string;
}

export interface TilePathTraceRequest {
    glbPath: string;
    outputDir: string;
    sun: TileSunSpec;
    width?: number;
    height?: number;
    samplesPerPixel?: number;
    maxBounces?: number;
    threads?: number;
    shadingMode?: TileShadingMode;
    denoise?: boolean;
    groundPlane?: boolean;
    camera?: TileCameraSpec | TileAutoCameraSpec;
    atmosphere?: TileAtmosphereSpec;
    exposureEv?: number | 'auto';
    look?: TileViewLook;
    clampIndirect?: number;
    seed?: number;
    timeoutMs?: number;
    /** Geometry-only blockout: one matte material (linear RGB albedo) replaces every captured texture. */
    clay?: boolean | { albedo?: [number, number, number]; roughness?: number; metallic?: number };
    /** Physical micro-polygon tessellation and surface displacement options */
    displacement?: TileDisplacementSpec;
}

export interface TilePathTraceStats {
    width: number;
    height: number;
    samplesPerPixel: number;
    shadingMode: TileShadingMode;
    triangles: number;
    primitives: number;
    images: number;
    imagesDecoded: number;
    imageErrors: string[];
    bvhNodes: number;
    geometryCoverage: number;
    nanSamples: number;
    renderMs: number;
    denoiseMs: number;
    totalMs: number;
    exposureEv: number;
    meanDisplayLuminance: number;
    sun: {
        elevationDeg: number;
        azimuthDeg: number;
        direction: [number, number, number];
        irradiance: [number, number, number];
    };
    camera: {
        position: [number, number, number];
        target: [number, number, number];
        verticalFovDeg: number;
    };
    groundHeight: number;
    groundAlbedo: [number, number, number];
}

export interface TilePathTraceResult {
    success: boolean;
    beautyPngPath: string;
    noisyPngPath: string;
    albedoPngPath: string;
    normalPngPath: string;
    depthPngPath: string;
    /** float32 distance along each pixel-centre ray, row-major, 0 where there is no geometry. */
    depthF32Path: string;
    statsJsonPath: string;
    stats: TilePathTraceStats;
    compileMs: number;
    executionMs: number;
}

const CLI_SOURCE_NAME = 'render_tile_pathtraced.cpp';

/**
 * Offline physically based renderer for photogrammetric tiles, implemented natively in the
 * Scratchbox C++20 engine (the role Blender Cycles would otherwise play).
 */
export class NativeTilePathTracerService {
    private readonly compiler: NativeCppCompilerService;
    private readonly buildDir: string;

    constructor(compiler?: NativeCppCompilerService, buildDir?: string) {
        this.compiler = compiler ?? new NativeCppCompilerService();
        this.buildDir = buildDir ?? path.resolve(process.cwd(), 'build/3d-native');
    }

    async render(request: TilePathTraceRequest): Promise<TilePathTraceResult> {
        const config = this.buildConfig(request);
        fs.mkdirSync(request.outputDir, { recursive: true });
        const configPath = path.join(request.outputDir, 'render_config.json');
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

        const compileStart = Date.now();
        const binaryPath = await this.ensureBinary();
        const compileMs = Date.now() - compileStart;

        const execStart = Date.now();
        try {
            await execFileAsync(binaryPath, [configPath], {
                timeout: request.timeoutMs ?? 15 * 60 * 1000,
                maxBuffer: 16 * 1024 * 1024
            });
        } catch (err: any) {
            const detail = [err.stderr, err.stdout, err.message].filter(Boolean).join('\n').trim();
            throw new Error(`Native tile path tracer failed: ${detail}`);
        }
        const executionMs = Date.now() - execStart;

        const out = (name: string) => path.join(request.outputDir, name);
        const statsJsonPath = out('stats.json');
        const stats = JSON.parse(fs.readFileSync(statsJsonPath, 'utf8')) as TilePathTraceStats;
        return {
            success: true,
            beautyPngPath: out('beauty.png'),
            noisyPngPath: out('noisy.png'),
            albedoPngPath: out('albedo.png'),
            normalPngPath: out('normal.png'),
            depthPngPath: out('depth.png'),
            depthF32Path: out('depth.f32'),
            statsJsonPath,
            stats,
            compileMs,
            executionMs
        };
    }

    private buildConfig(request: TilePathTraceRequest): Record<string, unknown> {
        if (!request.glbPath || !fs.existsSync(request.glbPath)) {
            throw new Error(`GLB not found: ${request.glbPath}`);
        }
        if (!request.outputDir) {
            throw new Error('outputDir is required');
        }
        const sun = this.resolveSun(request.sun);
        const config: Record<string, unknown> = {
            glbPath: path.resolve(request.glbPath),
            outputDir: path.resolve(request.outputDir),
            sun,
            width: request.width ?? 1280,
            height: request.height ?? 720,
            samplesPerPixel: request.samplesPerPixel ?? 64,
            maxBounces: request.maxBounces ?? 4,
            threads: request.threads ?? 0,
            shadingMode: request.shadingMode ?? 'relit',
            denoise: request.denoise ?? true,
            groundPlane: request.groundPlane ?? true,
            exposure: request.exposureEv ?? 'auto',
            look: request.look ?? 'base',
            clampIndirect: request.clampIndirect ?? 10,
            seed: request.seed ?? 1
        };
        if (request.atmosphere) {
            config.atmosphere = request.atmosphere;
        }
        if (request.clay) {
            const clay = request.clay === true ? {} : request.clay;
            config.clayAlbedo = clay.albedo ?? [0.716, 0.672, 0.61];
            config.clayRoughness = clay.roughness ?? 0.82;
            config.clayMetallic = clay.metallic ?? 0.02;
        }
        if (request.camera) {
            config.camera = request.camera;
        }
        if (request.displacement) {
            config.displacement = request.displacement;
        }
        return config;
    }

    private resolveSun(sun: TileSunSpec | undefined): Record<string, number> {
        if (sun && 'isoDate' in sun) {
            const millis = Date.parse(sun.isoDate);
            if (!Number.isFinite(millis) || !Number.isFinite(sun.latitude) || !Number.isFinite(sun.longitude)) {
                throw new Error(`Invalid sun specification: ${JSON.stringify(sun)}`);
            }
            return { latitude: sun.latitude, longitude: sun.longitude, unixSeconds: Math.floor(millis / 1000) };
        }
        if (sun && 'elevationDeg' in sun && Number.isFinite(sun.elevationDeg) && Number.isFinite(sun.azimuthDeg)) {
            return { elevationDeg: sun.elevationDeg, azimuthDeg: sun.azimuthDeg };
        }
        throw new Error('A sun specification is required: pass { latitude, longitude, isoDate } or { elevationDeg, azimuthDeg }.');
    }

    private async ensureBinary(): Promise<string> {
        const candidates = [
            path.resolve(process.cwd(), 'scripts', CLI_SOURCE_NAME),
            path.resolve(__dirname, '../../../../../scripts', CLI_SOURCE_NAME),
            path.resolve(__dirname, '../../../../scripts', CLI_SOURCE_NAME)
        ];
        const sourcePath = candidates.find(p => fs.existsSync(p));
        if (!sourcePath) {
            throw new Error(`Cannot find ${CLI_SOURCE_NAME} (looked in ${candidates.join(', ')})`);
        }
        const extraFlags = ['-pthread', '-lz'];
        if (process.env.SCRATCHBOX_NATIVE_ARCH === '1') {
            extraFlags.push('-march=native');
        }
        const compiled = await this.compiler.compileSource(fs.readFileSync(sourcePath, 'utf8'), {
            outputDir: this.buildDir,
            outputBinaryName: 'render_tile_pathtraced',
            optimization: '-O3',
            extraFlags
        });
        if (!compiled.success || !compiled.binaryPath) {
            throw new Error(`Failed to compile ${CLI_SOURCE_NAME}:\n${compiled.compilerOutput}`);
        }
        return compiled.binaryPath;
    }
}
