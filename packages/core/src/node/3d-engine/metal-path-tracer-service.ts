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

import { ChildProcess, execFile, spawn } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
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
    /** One uniform material (linear RGB albedo); default is the studio clay. Ignored when `materials` is given. */
    material?: { albedo?: [number, number, number]; roughness?: number; metallic?: number };
    /** Shade with the materials and textures of the GLB the .sbvg (version 3) was built from, by the material ids it carries. */
    materials?: { glbPath: string };
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
    materials: {
        source: 'glb' | 'uniform';
        glbPath: string;
        count: number;
        images: number;
        imagesDecoded: number;
        /** Decoded images uploaded to the GPU (0 on the cpu backend). */
        texturesUploaded: number;
        loadMs: number;
    };
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

export interface MetalPathTraceSessionOpen {
    sbvgPath: string;
    /** The GLB the .sbvg was built from, for its materials and textures; without it every triangle is `material`. */
    glbPath?: string;
    lighting?: MetalPathTraceSunLighting | MetalPathTraceStudioLighting;
    material?: { albedo?: [number, number, number]; roughness?: number; metallic?: number };
}

export interface MetalPathTraceView {
    width: number;
    height: number;
    camera: MetalPathTraceCamera;
    lod?: { thresholdPx?: number; near?: number; finestLevel?: number };
    maxBounces?: number;
    clampIndirect?: number;
    seed?: number;
    /** Samples per pixel the frame accumulates to (default 256). */
    targetSpp?: number;
    /** Fixed exposure; by default the first frame's auto exposure is kept for the view. */
    exposureEv?: number;
}

export interface MetalPathTraceOpened {
    device: string;
    file: { clusters: number; levels: number; vertices: number; leafTriangles: number; materialCount: number; aabbMin: [number, number, number]; aabbMax: [number, number, number] };
    materials: { source: 'glb' | 'uniform'; count: number; images: number; imagesDecoded: number; texturesUploaded: number };
    openMs: number;
}

export interface MetalPathTraceViewStarted {
    seq: number;
    width: number;
    height: number;
    cut: { clusters: number; triangles: number; thresholdPx: number; rebuilt: boolean; cutMs: number; accelerationBuildMs: number };
    lighting: 'sky' | 'studio';
    targetSpp: number;
}

export interface MetalPathTraceFrame {
    seq: number;
    spp: number;
    rays: number;
    gpuMs: number;
    width: number;
    height: number;
    coverage: number;
    exposureEv: number;
    /** 8-bit RGBA, width * height * 4 bytes, display-ready. */
    path: string;
    done: boolean;
}

/**
 * A resident tracer process (sbvg_pathtracer --serve). Events from the helper arrive as 'frame',
 * 'view', 'error' and 'exit' on the emitter; the latest frame's metadata is kept for polling.
 */
export class MetalPathTraceSession extends EventEmitter {
    private child: ChildProcess | null = null;
    private pending: Array<{ event: string; resolve: (v: any) => void; reject: (e: Error) => void }> = [];
    private latest: MetalPathTraceFrame | null = null;
    private view: MetalPathTraceViewStarted | null = null;
    private exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    private stderr = '';
    readonly openedAt = Date.now();
    lastUsed = Date.now();
    opened: MetalPathTraceOpened | null = null;

    constructor(private readonly binary: string, readonly dir: string) {
        super();
    }

    get alive(): boolean {
        return this.child !== null && this.exited === null;
    }

    /** Metadata of the newest frame the helper wrote (its bytes are at `path`). */
    latestFrame(): MetalPathTraceFrame | null {
        return this.latest;
    }

    currentView(): MetalPathTraceViewStarted | null {
        return this.view;
    }

    /** The newest frame's pixels, re-read from the frame file; null before the first frame. */
    readFrame(): { meta: MetalPathTraceFrame; rgba: Buffer } | null {
        const meta = this.latest;
        if (!meta) return null;
        let rgba: Buffer;
        try {
            rgba = fs.readFileSync(meta.path);
        } catch {
            return null;
        }
        if (rgba.length !== meta.width * meta.height * 4) return null;
        return { meta, rgba };
    }

    async start(): Promise<void> {
        fs.mkdirSync(this.dir, { recursive: true });
        const child = spawn(this.binary, ['--serve', this.dir], { stdio: ['pipe', 'pipe', 'pipe'] });
        this.child = child;
        child.stderr!.on('data', (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString()).slice(-4000); });
        const lines = readline.createInterface({ input: child.stdout! });
        lines.on('line', line => this.onLine(line));
        child.on('exit', (code, signal) => {
            this.exited = { code, signal };
            const err = new MetalPathTracerError(`path tracer process exited (${signal ?? code})`, this.stderr.trim());
            for (const p of this.pending.splice(0)) p.reject(err);
            this.emit('exit', this.exited);
        });
        child.on('error', err => {
            for (const p of this.pending.splice(0)) p.reject(new MetalPathTracerError('path tracer process failed', err.message));
        });
        await this.expect('ready');
    }

    async open(request: MetalPathTraceSessionOpen): Promise<MetalPathTraceOpened> {
        const opened = await this.command({
            op: 'open',
            sbvgPath: path.resolve(request.sbvgPath),
            ...(request.glbPath ? { glbPath: path.resolve(request.glbPath) } : {}),
            ...(request.lighting ? { lighting: request.lighting } : {}),
            ...(request.material ? { material: request.material } : {})
        }, 'opened');
        this.opened = opened;
        return opened;
    }

    /** Starts a progressive frame for the view; earlier frames of this session are superseded. */
    async setView(view: MetalPathTraceView): Promise<MetalPathTraceViewStarted> {
        this.lastUsed = Date.now();
        return this.command({ op: 'view', ...view }, 'view');
    }

    close(): void {
        if (!this.child || this.exited) return;
        try {
            this.child.stdin!.write('{"op":"close"}\n');
            this.child.stdin!.end();
        } catch { /* already gone */ }
        const child = this.child;
        setTimeout(() => { if (!this.exited) child.kill('SIGKILL'); }, 2000).unref();
    }

    private onLine(line: string) {
        let msg: any;
        try {
            msg = JSON.parse(line);
        } catch {
            return;
        }
        const event = msg?.event;
        if (event === 'frame') {
            if (this.view && msg.seq === this.view.seq) {
                this.latest = msg as MetalPathTraceFrame;
                this.emit('frame', this.latest);
            }
            return;
        }
        if (event === 'error') {
            const err = new MetalPathTracerError(String(msg.message ?? 'path tracer error'));
            const p = this.pending.shift();
            if (p) p.reject(err);
            else this.emit('error', err);
            if (msg.fatal) this.close();
            return;
        }
        // Recorded here, before any await: a small frame's events can share the stdout chunk with the reply.
        if (event === 'view') {
            this.view = msg as MetalPathTraceViewStarted;
            this.latest = null;
        } else if (event === 'opened') {
            this.opened = msg as MetalPathTraceOpened;
        }
        const p = this.pending.shift();
        if (p) {
            if (p.event === event) p.resolve(msg);
            else p.reject(new MetalPathTracerError(`expected ${p.event} from the path tracer, got ${event}`));
        }
    }

    private expect(event: string): Promise<any> {
        return new Promise((resolve, reject) => this.pending.push({ event, resolve, reject }));
    }

    private command(cmd: Record<string, unknown>, reply: string): Promise<any> {
        if (!this.alive) return Promise.reject(new MetalPathTracerError('path tracer process is not running', this.stderr.trim()));
        const result = this.expect(reply);
        this.child!.stdin!.write(JSON.stringify(cmd) + '\n');
        return result;
    }
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
        if (request.materials) {
            if (!fs.existsSync(request.materials.glbPath)) throw new MetalPathTracerError(`materials GLB not found: ${request.materials.glbPath}`);
            config.materials = { glbPath: path.resolve(request.materials.glbPath) };
        }
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

    /**
     * Starts a resident tracer process for progressive rendering: open a file once, then set views as the
     * camera moves and read the latest frame. Frames are written by the helper to a file in `dir`
     * (default: a fresh temp dir) and read back here.
     */
    async openSession(request: MetalPathTraceSessionOpen, options: { dir?: string } = {}): Promise<MetalPathTraceSession> {
        if (process.platform !== 'darwin') throw new MetalPathTracerError('Metal path tracing runs on macOS only');
        if (!request.sbvgPath || !fs.existsSync(request.sbvgPath)) throw new MetalPathTracerError(`sbvg file not found: ${request.sbvgPath}`);
        if (request.glbPath && !fs.existsSync(request.glbPath)) throw new MetalPathTracerError(`materials GLB not found: ${request.glbPath}`);
        const binary = await this.ensureBinary();
        const dir = options.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'sb-pathtrace-'));
        const session = new MetalPathTraceSession(binary, dir);
        await session.start();
        await session.open(request);
        return session;
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
