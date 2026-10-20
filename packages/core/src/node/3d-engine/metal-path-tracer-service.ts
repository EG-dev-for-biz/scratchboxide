/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * GPU path tracing of .sbvg cluster LOD files on Metal's hardware ray intersector, through the
 * native helper scripts/sbvg_pathtracer.mm (scratchbox_metal_pathtracer.hpp). The helper's "cpu"
 * backend traces the same LOD cut with render::PathTracer, the reference the GPU kernels are
 * checked against.
 *
 * macOS only. There is no fallback: a machine without a ray tracing Metal device fails with
 * MetalPathTracerError, and probe() says why.
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { NativeCppCompilerService } from './native-compiler-service';
import { compileNativeCached, defaultNativeFlags } from './native-build-cache';

export interface MetalDeviceInfo {
    device: string | null;
    raytracing: boolean;
    /** Apple GPU family generation (7 = M1, 8 = M2, 9 = M3 and later with the dedicated ray tracing unit); 0 when unknown. */
    appleFamily: number;
    recommendedWorkingSetBytes: number;
    error?: string;
}

export interface MetalPathTraceCamera {
    /** In the file's coordinates (its vertices are relative to the stored origin). */
    position: [number, number, number];
    target: [number, number, number];
    up?: [number, number, number];
    verticalFovDeg?: number;
    apertureRadius?: number;
    focusDistance?: number;
}

export interface MetalPathTraceAutoCamera {
    auto: { verticalFovDeg?: number; pitchDeg?: number; headingDeg?: number; distanceScale?: number };
}

export interface MetalPathTraceSunLighting {
    sun: { elevationDeg: number; azimuthDeg: number };
    atmosphere?: {
        siteElevationMeters?: number;
        airDensity?: number;
        dustDensity?: number;
        ozoneDensity?: number;
        sunAngularDiameterDeg?: number;
        sunIntensity?: number;
    };
}

export interface MetalPathTraceStudioLighting {
    /** Uniform environment dome; radiance defaults to [1, 1, 1]. */
    studio: { radiance?: [number, number, number] };
}

export interface MetalPathTraceRequest {
    sbvgPath: string;
    outputDir: string;
    /** "metal" (default) traces on the GPU; "cpu" traces the same cut with render::PathTracer (sun lighting only). */
    backend?: 'metal' | 'cpu';
    width?: number;
    height?: number;
    samplesPerPixel?: number;
    maxBounces?: number;
    clampIndirect?: number;
    seed?: number;
    /** CPU backend thread count; 0 uses every hardware thread. */
    threads?: number;
    lod?: { thresholdPx?: number; near?: number; finestLevel?: number };
    /** Default: the neutral studio dome. */
    lighting?: MetalPathTraceSunLighting | MetalPathTraceStudioLighting;
    /** One uniform material (linear RGB albedo); default is the studio clay. */
    material?: { albedo?: [number, number, number]; roughness?: number; metallic?: number };
    denoise?: boolean;
    exposureEv?: number;
    camera?: MetalPathTraceCamera | MetalPathTraceAutoCamera;
    timeoutMs?: number;
}

export interface MetalPathTraceStats {
    backend: 'metal' | 'cpu';
    device: string;
    width: number;
    height: number;
    samplesPerPixel: number;
    maxBounces: number;
    lighting: 'sky' | 'studio';
    file: { clusters: number; levels: number; vertices: number; leafTriangles: number };
    cut: { clusters: number; triangles: number; thresholdPx: number; finestLevel: number };
    /** Closest-hit and shadow rays traced, counted by the kernels. */
    rays: number;
    raysPerSecond: number;
    /** GPU time for the metal backend, wall time for the cpu backend. */
    renderMs: number;
    accelerationBuildMs: number;
    loadMs: number;
    cutMs: number;
    totalMs: number;
    geometryCoverage: number;
    nanSamples: number;
    meanLinearLuminance: number;
    exposureEv: number;
    denoised: boolean;
    material: { albedo: [number, number, number]; roughness: number; metallic: number };
    sun: { elevationDeg: number; azimuthDeg: number };
    camera: { position: [number, number, number]; target: [number, number, number]; up: [number, number, number]; verticalFovDeg: number };
}

export interface MetalPathTraceResult {
    beautyPngPath: string;
    /** float32 scene-linear RGB per pixel, row-major (readLinearColor). */
    colorF32Path: string;
    statsJsonPath: string;
    stats: MetalPathTraceStats;
    compileMs: number;
    executionMs: number;
}

export class MetalPathTracerError extends Error {
    constructor(message: string, public readonly detail: string = '') {
        super(detail ? `${message}: ${detail}` : message);
        this.name = 'MetalPathTracerError';
    }
}

const HELPER_SOURCE_NAME = 'sbvg_pathtracer.mm';

function helperSourcePath(): string {
    const candidates = [
        path.resolve(process.cwd(), 'scripts', HELPER_SOURCE_NAME),
        path.resolve(__dirname, '../../../../../scripts', HELPER_SOURCE_NAME),
        path.resolve(__dirname, '../../../../scripts', HELPER_SOURCE_NAME)
    ];
    const found = candidates.find(p => fs.existsSync(p));
    if (!found) throw new MetalPathTracerError(`Cannot find ${HELPER_SOURCE_NAME}`, `looked in ${candidates.join(', ')}`);
    return found;
}

function run(binary: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise(resolve => {
        execFile(binary, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, killSignal: 'SIGKILL' }, (err: any, stdout, stderr) => {
            const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0;
            resolve({ stdout: String(stdout), stderr: String(stderr) + (err && typeof err.code !== 'number' ? `\n${err.message}` : ''), code });
        });
    });
}

/** The scene-linear RGB image a render wrote (stats.width x stats.height, 3 floats per pixel). */
export function readLinearColor(result: MetalPathTraceResult): Float32Array {
    const bytes = fs.readFileSync(result.colorF32Path);
    const expected = result.stats.width * result.stats.height * 3 * 4;
    if (bytes.length !== expected) throw new MetalPathTracerError('color.f32 has the wrong size', `${bytes.length} bytes, expected ${expected}`);
    return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
}

export class MetalPathTracerService {
    private binary: Promise<string> | null = null;
    private compileMs = 0;

    constructor(private readonly compiler: NativeCppCompilerService = NativeCppCompilerService.getInstance()) {}

    /** The default Metal device and whether it ray traces; never throws for a missing device. */
    async probe(): Promise<MetalDeviceInfo> {
        if (process.platform !== 'darwin') {
            return { device: null, raytracing: false, appleFamily: 0, recommendedWorkingSetBytes: 0, error: 'Metal path tracing runs on macOS only' };
        }
        let binary: string;
        try {
            binary = await this.ensureBinary();
        } catch (err: any) {
            return { device: null, raytracing: false, appleFamily: 0, recommendedWorkingSetBytes: 0, error: String(err?.message ?? err) };
        }
        const res = await run(binary, ['--probe'], 60_000);
        const line = res.stdout.split('\n').find(l => l.startsWith('{'));
        if (!line) return { device: null, raytracing: false, appleFamily: 0, recommendedWorkingSetBytes: 0, error: res.stderr.trim() || `probe exited with ${res.code}` };
        const parsed = JSON.parse(line);
        return {
            device: parsed.device ?? null,
            raytracing: parsed.raytracing === true,
            appleFamily: parsed.appleFamily ?? 0,
            recommendedWorkingSetBytes: parsed.recommendedWorkingSetBytes ?? 0,
            ...(parsed.error ? { error: parsed.error } : {})
        };
    }

    async render(request: MetalPathTraceRequest): Promise<MetalPathTraceResult> {
        if (process.platform !== 'darwin') throw new MetalPathTracerError('Metal path tracing runs on macOS only');
        if (!request.sbvgPath || !fs.existsSync(request.sbvgPath)) throw new MetalPathTracerError(`sbvg file not found: ${request.sbvgPath}`);
        if (!request.outputDir) throw new MetalPathTracerError('outputDir is required');
        fs.mkdirSync(request.outputDir, { recursive: true });
        const config: Record<string, unknown> = {
            sbvgPath: path.resolve(request.sbvgPath),
            outputDir: path.resolve(request.outputDir),
            backend: request.backend ?? 'metal',
            width: request.width ?? 1280,
            height: request.height ?? 720,
            samplesPerPixel: request.samplesPerPixel ?? 64,
            maxBounces: request.maxBounces ?? 4,
            clampIndirect: request.clampIndirect ?? 10,
            seed: request.seed ?? 1,
            threads: request.threads ?? 0,
            denoise: request.denoise ?? false
        };
        if (request.lod) config.lod = request.lod;
        if (request.lighting) config.lighting = request.lighting;
        if (request.material) config.material = request.material;
        if (request.camera) config.camera = request.camera;
        if (request.exposureEv !== undefined) config.exposure = request.exposureEv;
        const configPath = path.join(request.outputDir, 'render_config.json');
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

        const binary = await this.ensureBinary();
        const execStart = Date.now();
        const res = await run(binary, [configPath], request.timeoutMs ?? 15 * 60_000);
        const executionMs = Date.now() - execStart;
        if (res.code !== 0) {
            throw new MetalPathTracerError('sbvg path tracer failed', [res.stderr.trim(), res.stdout.trim()].filter(Boolean).join('\n'));
        }
        const statsJsonPath = path.join(request.outputDir, 'stats.json');
        const stats = JSON.parse(fs.readFileSync(statsJsonPath, 'utf8')) as MetalPathTraceStats;
        return {
            beautyPngPath: path.join(request.outputDir, 'beauty.png'),
            colorF32Path: path.join(request.outputDir, 'color.f32'),
            statsJsonPath,
            stats,
            compileMs: this.compileMs,
            executionMs
        };
    }

    private ensureBinary(): Promise<string> {
        if (!this.binary) {
            this.binary = (async () => {
                try {
                    const result = await compileNativeCached({
                        sourcePath: helperSourcePath(),
                        includeDirs: [this.compiler.getSdkIncludePath()],
                        flags: defaultNativeFlags(['-fobjc-arc']),
                        libs: ['-lz', '-framework', 'Metal', '-framework', 'Foundation'],
                        name: 'sbvg_pathtracer'
                    });
                    this.compileMs = result.cacheHit ? 0 : result.compileMs;
                    return result.binaryPath;
                } catch (err: any) {
                    throw new MetalPathTracerError('Compiling the Metal path tracer failed', err?.compilerOutput ?? String(err?.message ?? err));
                }
            })();
            this.binary.catch(() => { this.binary = null; });
        }
        return this.binary;
    }
}
