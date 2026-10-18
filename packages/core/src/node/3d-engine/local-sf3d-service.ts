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
import { NativePythonRunnerService } from './native-python-runner-service';

export interface LocalSf3DOptions {
    /** Path to input photograph or 2D image file */
    imagePath: string;
    /** Optional destination file path for generated .glb */
    outputGlbPath?: string;
    /**
     * Keeps SF3D's geometry only and repacks it in 18% Studio Grey Clay (SF3D's baked texture is dropped).
     * Default: true
     */
    noPbr?: boolean;
    /** Metric scale of the major bounding axis in meters (default: 0.35m / 35cm) */
    targetScaleMeters?: number;
    /** Snaps the base vertices to Y=0 to create a flat, stable contact plane (default: true) */
    groundCut?: boolean;
    /** Topology remeshing optimization: 'none' | 'triangle' | 'quad' (default: 'none') */
    remeshOption?: 'none' | 'triangle' | 'quad';
    /** Device target: 'auto' | 'mps' | 'cuda' | 'cpu' (default: 'auto') */
    device?: 'auto' | 'mps' | 'cuda' | 'cpu';
    /** Optional semantic hint or label (e.g. "chanterelle mushroom", "rough quartz crystal") */
    promptHint?: string;
    /** Studio clay base color RGB in [0..1] range (default: [0.55, 0.57, 0.60]) */
    clayColor?: [number, number, number];
}

export interface LocalSf3DBounds {
    min: [number, number, number];
    max: [number, number, number];
    center: [number, number, number];
    dimensions: [number, number, number];
    radius: number;
}

export interface LocalSf3DResult {
    success: boolean;
    glbPath: string;
    glbBuffer?: Buffer;
    mode: 'no_pbr_clay' | 'pbr';
    device: string;
    vertexCount: number;
    triangleCount: number;
    executionTimeMs: number;
    targetScaleMeters: number;
    overallBoundingBox: LocalSf3DBounds;
    telemetry?: Record<string, any>;
    error?: string;
}

/**
 * LocalSf3DService
 *
 * Manages local, high-speed 3D organic prop and small object reconstruction
 * via Stable Fast 3D (SF3D) running directly on local hardware (Apple Silicon MPS, CUDA, or CPU).
 * no_pbr mode keeps SF3D's geometry in 18% Studio Grey Clay. If SF3D is not installed or fails,
 * generateOrganicProp throws LocalSf3DError; it never substitutes geometry.
 */
export class LocalSf3DService {
    private static instance?: LocalSf3DService;
    private pythonRunner: NativePythonRunnerService;

    public static getInstance(): LocalSf3DService {
        if (!LocalSf3DService.instance) {
            LocalSf3DService.instance = new LocalSf3DService();
        }
        return LocalSf3DService.instance;
    }

    constructor(pythonRunner?: NativePythonRunnerService) {
        this.pythonRunner = pythonRunner || NativePythonRunnerService.getInstance();
    }

    /**
     * Resolves the absolute path to the local SF3D python runner script.
     */
    public resolveScriptPath(): string {
        const repoRoot = this.findRepoRoot();
        const candidate = path.resolve(repoRoot, 'packages/core/src/python/scratchbox/sf3d/run_local_sf3d.py');
        if (fs.existsSync(candidate)) {
            return candidate;
        }
        // Fallback relative to __dirname
        const alt = path.resolve(__dirname, '../../python/scratchbox/sf3d/run_local_sf3d.py');
        if (fs.existsSync(alt)) {
            return alt;
        }
        return candidate;
    }

    private findRepoRoot(): string {
        let cur = typeof __dirname !== 'undefined' ? __dirname : process.cwd();
        while (cur && cur !== path.dirname(cur)) {
            if (fs.existsSync(path.join(cur, 'packages/core')) && fs.existsSync(path.join(cur, 'package.json'))) {
                return cur;
            }
            cur = path.dirname(cur);
        }
        return process.cwd();
    }

    /**
     * Generate an organic prop from an input image using local SF3D with no_pbr support.
     */
    public async generateOrganicProp(options: LocalSf3DOptions): Promise<LocalSf3DResult> {
        const startTime = Date.now();
        const repoRoot = this.findRepoRoot();
        const outputDir = path.resolve(repoRoot, 'build/local-sf3d');
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        const scriptPath = this.resolveScriptPath();
        const randId = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const targetGlbPath = options.outputGlbPath || path.join(outputDir, `organic_prop_${randId}.glb`);

        const noPbr = options.noPbr !== false; // default true
        const targetScale = options.targetScaleMeters ?? 0.35;
        const groundCut = options.groundCut !== false; // default true
        const remeshOption = options.remeshOption || 'none';
        const device = options.device || 'auto';

        const args = [
            scriptPath,
            options.imagePath,
            targetGlbPath,
            noPbr ? '--no_pbr' : '--with_pbr',
            `--target_scale_meters=${targetScale}`,
            groundCut ? '--ground_cut' : '--no_ground_cut',
            `--remesh_option=${remeshOption}`,
            `--device=${device}`
        ];

        // The scratchbox package degrades gracefully without the native module, so a failed build isn't fatal here.
        await this.pythonRunner.ensureNativeModule();
        const pythonExec = this.pythonRunner.getPythonExecutable();
        const { execFile } = await import('child_process');
        const { promisify } = await import('util');
        const execFileAsync = promisify(execFile);

        let stdout = '';
        let stderr = '';

        try {
            const res = await execFileAsync(pythonExec, args, {
                cwd: outputDir,
                timeout: 600000,
                maxBuffer: 64 * 1024 * 1024,
                env: {
                    ...process.env,
                    PYTHONPATH: [
                        path.resolve(repoRoot, 'packages/core/src/python'),
                        this.pythonRunner.getModuleDirectory(),
                        process.env.PYTHONPATH || ''
                    ].filter(Boolean).join(':')
                }
            });
            stdout = res.stdout;
            stderr = res.stderr;
        } catch (err: any) {
            // A non-zero exit is always a failure, even if a GLB from an earlier run sits at the target path.
            const scriptError = parseMarkedJson(err.stdout || '', '__LOCAL_SF3D_ERROR_START__', '__LOCAL_SF3D_ERROR_END__');
            if (scriptError && typeof scriptError.code === 'string') {
                throw new LocalSf3DError(scriptError.code, String(scriptError.error || err.message));
            }
            const detail = (err.stderr || err.message || '').toString().trim();
            throw new LocalSf3DError('SF3D_RUN_FAILED', `SF3D runner exited with ${err.code ?? err.signal ?? 'an error'}: ${detail}`);
        }

        const parsedResult = parseMarkedJson(stdout, '__LOCAL_SF3D_RESULT_START__', '__LOCAL_SF3D_RESULT_END__');
        if (!parsedResult || parsedResult.success !== true) {
            throw new LocalSf3DError('SF3D_OUTPUT_INVALID', `SF3D runner exited 0 without a result record. Stderr: ${stderr.trim()}`);
        }
        if (!fs.existsSync(targetGlbPath)) {
            throw new LocalSf3DError('SF3D_OUTPUT_INVALID', `Output GLB file was not created at: ${targetGlbPath}. Stderr: ${stderr.trim()}`);
        }

        const glbBuffer = fs.readFileSync(targetGlbPath);
        // Counts and bounds come from the GLB that was written, not from defaults.
        const stats = readGlbMeshStats(glbBuffer, targetGlbPath);
        const bounds = stats.bounds ?? boundsFromScript(parsedResult.bounds);
        if (!bounds) {
            throw new LocalSf3DError('SF3D_OUTPUT_INVALID', `Output GLB at ${targetGlbPath} has no POSITION min/max and the runner reported no bounds.`);
        }

        return {
            success: true,
            glbPath: targetGlbPath,
            glbBuffer,
            mode: noPbr ? 'no_pbr_clay' : 'pbr',
            device: typeof parsedResult.device === 'string' ? parsedResult.device : device,
            vertexCount: stats.vertexCount,
            triangleCount: stats.triangleCount,
            executionTimeMs: Date.now() - startTime,
            targetScaleMeters: targetScale,
            overallBoundingBox: bounds,
            telemetry: {
                modelExecutionMs: typeof parsedResult.execution_time_ms === 'number' ? parsedResult.execution_time_ms : undefined,
                remeshOption,
                groundCut,
                promptHint: options.promptHint
            }
        };
    }
}

/** Typed failure from the SF3D runner. `code` is the runner's reason (e.g. SF3D_NOT_INSTALLED, SF3D_RUN_FAILED). */
export class LocalSf3DError extends Error {
    public override readonly name = 'LocalSf3DError';
    constructor(public readonly code: string, message: string) {
        super(`[LocalSf3DService] ${code}: ${message}`);
    }
}

function parseMarkedJson(text: string, startMarker: string, endMarker: string): any | null {
    const start = text.indexOf(startMarker);
    const end = text.indexOf(endMarker);
    if (start === -1 || end === -1 || end < start) return null;
    try {
        return JSON.parse(text.substring(start + startMarker.length, end).trim());
    } catch {
        return null;
    }
}

function makeBounds(min: [number, number, number], max: [number, number, number]): LocalSf3DBounds {
    const dimensions: [number, number, number] = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    return {
        min,
        max,
        center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
        dimensions,
        radius: Math.hypot(dimensions[0], dimensions[1], dimensions[2]) / 2
    };
}

function isVec3(v: unknown): v is [number, number, number] {
    return Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number' && Number.isFinite(n));
}

function boundsFromScript(b: any): LocalSf3DBounds | undefined {
    return b && isVec3(b.min) && isVec3(b.max) ? makeBounds(b.min, b.max) : undefined;
}

/**
 * Reads vertex/triangle counts and the POSITION bounds out of a binary glTF 2.0 file.
 * Bounds are the union of the POSITION accessors' min/max (node transforms are not applied); undefined if any is missing.
 */
export function readGlbMeshStats(glb: Buffer, label = 'GLB'): { vertexCount: number; triangleCount: number; bounds?: LocalSf3DBounds } {
    if (glb.length < 20 || glb.toString('utf8', 0, 4) !== 'glTF') {
        throw new LocalSf3DError('SF3D_OUTPUT_INVALID', `${label} is not a valid binary glTF 2.0 (magic header missing).`);
    }
    const jsonLength = glb.readUInt32LE(12);
    if (glb.readUInt32LE(16) !== 0x4e4f534a || 20 + jsonLength > glb.length) {
        throw new LocalSf3DError('SF3D_OUTPUT_INVALID', `${label} has no JSON chunk.`);
    }
    let gltf: any;
    try {
        gltf = JSON.parse(glb.toString('utf8', 20, 20 + jsonLength));
    } catch (e: any) {
        throw new LocalSf3DError('SF3D_OUTPUT_INVALID', `${label} JSON chunk does not parse: ${e.message}`);
    }
    const accessors: any[] = gltf.accessors || [];
    let vertexCount = 0;
    let triangleCount = 0;
    let min: [number, number, number] | undefined = [Infinity, Infinity, Infinity];
    let max: [number, number, number] | undefined = [-Infinity, -Infinity, -Infinity];
    for (const mesh of gltf.meshes || []) {
        for (const prim of mesh.primitives || []) {
            const pos = accessors[prim.attributes?.POSITION];
            if (!pos) continue;
            vertexCount += pos.count;
            const mode = prim.mode ?? 4;
            if (mode === 4) {
                triangleCount += Math.floor((prim.indices !== undefined ? accessors[prim.indices]?.count ?? 0 : pos.count) / 3);
            }
            if (min && max && isVec3(pos.min) && isVec3(pos.max)) {
                for (let i = 0; i < 3; i++) {
                    min[i] = Math.min(min[i], pos.min[i]);
                    max[i] = Math.max(max[i], pos.max[i]);
                }
            } else {
                min = undefined;
                max = undefined;
            }
        }
    }
    if (vertexCount === 0) {
        throw new LocalSf3DError('SF3D_EMPTY_MESH', `${label} contains no POSITION data.`);
    }
    return { vertexCount, triangleCount, bounds: min && max ? makeBounds(min, max) : undefined };
}
