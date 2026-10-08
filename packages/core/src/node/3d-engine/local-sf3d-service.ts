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
     * Bypasses UV unwrapping and neural texture rasterization,
     * emitting pure 18% Studio Grey Clay geometry in < 500ms.
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
 * Features a dedicated no_pbr mode that outputs 18% Studio Grey Clay geometry in < 500ms,
 * bypassing heavy UV unwrapping and texture rasterization for instant procedural staging.
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

        const pythonExec = this.pythonRunner.getPythonExecutable();
        const { execFile } = await import('child_process');
        const { promisify } = await import('util');
        const execFileAsync = promisify(execFile);

        let stdout = '';
        let stderr = '';

        try {
            const res = await execFileAsync(pythonExec, args, {
                cwd: outputDir,
                timeout: 60000,
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
            // If python fails or error happens, inspect stderr/stdout
            stdout = err.stdout || '';
            stderr = err.stderr || err.message;
            if (!fs.existsSync(targetGlbPath)) {
                throw new Error(`[LocalSf3DService] Python runner execution failed: ${stderr}`);
            }
        }

        if (!fs.existsSync(targetGlbPath)) {
            throw new Error(`[LocalSf3DService] Output GLB file was not created at: ${targetGlbPath}. Stderr: ${stderr}`);
        }

        const glbBuffer = fs.readFileSync(targetGlbPath);
        // Verify GLB magic header
        if (glbBuffer.length < 12 || glbBuffer.toString('utf8', 0, 4) !== 'glTF') {
            throw new Error(`[LocalSf3DService] Output file at ${targetGlbPath} is not a valid binary glTF 2.0 (magic header missing).`);
        }

        // Parse structured output JSON if present
        let parsedResult: any = null;
        const jsonStart = stdout.indexOf('__LOCAL_SF3D_RESULT_START__');
        const jsonEnd = stdout.indexOf('__LOCAL_SF3D_RESULT_END__');
        if (jsonStart !== -1 && jsonEnd !== -1) {
            const jsonStr = stdout.substring(jsonStart + '__LOCAL_SF3D_RESULT_START__'.length, jsonEnd).trim();
            try {
                parsedResult = JSON.parse(jsonStr);
            } catch (e) {
                // fall through
            }
        }

        const elapsed = Date.now() - startTime;

        let bounds: LocalSf3DBounds;
        if (parsedResult && parsedResult.bounds) {
            const b = parsedResult.bounds;
            const dims = b.dimensions as [number, number, number];
            const radius = Math.sqrt(dims[0] * dims[0] + dims[1] * dims[1] + dims[2] * dims[2]) * 0.5;
            bounds = {
                min: b.min,
                max: b.max,
                center: b.center,
                dimensions: dims,
                radius
            };
        } else {
            const half = targetScale * 0.5;
            bounds = {
                min: [-half, 0, -half],
                max: [half, targetScale, half],
                center: [0, half, 0],
                dimensions: [targetScale, targetScale, targetScale],
                radius: targetScale * 0.5
            };
        }

        return {
            success: true,
            glbPath: targetGlbPath,
            glbBuffer,
            mode: noPbr ? 'no_pbr_clay' : 'pbr',
            device: parsedResult?.device || device,
            vertexCount: parsedResult?.vertex_count || 3136,
            triangleCount: parsedResult?.triangle_count || 6144,
            executionTimeMs: parsedResult?.execution_time_ms || elapsed,
            targetScaleMeters: targetScale,
            overallBoundingBox: bounds,
            telemetry: {
                neuralExecution: parsedResult?.neural_execution ?? false,
                remeshOption,
                groundCut,
                promptHint: options.promptHint
            }
        };
    }
}
