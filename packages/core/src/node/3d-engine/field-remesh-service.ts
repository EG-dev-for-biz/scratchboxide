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
import { exec } from 'child_process';
import { promisify } from 'util';
import { NativeCppCompilerService } from './native-compiler-service';

const execAsync = promisify(exec);

export interface QuadRemeshServiceOptions {
    inputGlbPath?: string;
    outputGlbPath?: string;
    targetQuadCount?: number;
    creaseAngleDegrees?: number;
    alignToManhattanAxes?: boolean;
    dominantYawDegrees?: number;
    includeWireframe?: boolean;
    streamStdout?: boolean;
}

export interface QuadRemeshMetrics {
    inputTriangles: number;
    outputQuads: number;
    outputTriangles: number;
    pureQuadRatio: number;
    pureQuadPercent: number;
    singularitiesCount: number;
    meanQuadAspect: number;
    meanCornerOrthogonalityDeg: number;
    maxAngleDeviationDeg: number;
    meanSurfaceDeviationMm: number;
    sharpCreaseEdges: number;
    processingTimeMs: number;
}

export interface QuadRemeshResult {
    success: boolean;
    glbBuffer?: Buffer;
    glbBase64?: string;
    outputGlbPath: string;
    metrics: QuadRemeshMetrics;
    stdout: string;
    stderr?: string;
}

/**
 * Service exposing the Instant Meshes Field-Aligned Quad Remeshing pipeline.
 *
 * Provides C++20 accelerated 4-RoSy orientation field optimization, Manhattan
 * orthogonal priors, integer-grid quad extraction, and surface projection.
 */
export class FieldAlignedQuadRemeshService {
    private compiler: NativeCppCompilerService;
    private binaryPath: string;

    constructor(compiler?: NativeCppCompilerService) {
        this.compiler = compiler || new NativeCppCompilerService();
        const candidateBinaries = [
            path.resolve(process.cwd(), 'build/run_field_remesh_pipeline'),
            path.resolve(process.cwd(), 'scripts/run_field_remesh_pipeline'),
            path.resolve(__dirname, '../../../../scripts/run_field_remesh_pipeline'),
            path.resolve(process.cwd(), 'build/3d-native/run_field_remesh_pipeline')
        ];
        this.binaryPath = candidateBinaries.find(p => fs.existsSync(p)) || candidateBinaries[0];
    }

    /**
     * Ensures the native C++20 quad remesher binary is compiled and available.
     */
    async ensureBinary(): Promise<string> {
        if (fs.existsSync(this.binaryPath)) {
            return this.binaryPath;
        }

        const sourcePath = path.resolve(process.cwd(), 'scripts/run_field_remesh_pipeline.cpp');
        const includePath = this.compiler.getSdkIncludePath();
        const outputDir = path.dirname(this.binaryPath);

        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        const compileCmd = `clang++ -std=c++20 -O3 -march=native -I "${includePath}" "${sourcePath}" -o "${this.binaryPath}"`;
        await execAsync(compileCmd);
        return this.binaryPath;
    }

    /**
     * Remeshes a geometry or benchmark scan into clean, field-aligned quads.
     */
    async remeshMesh(options: QuadRemeshServiceOptions = {}): Promise<QuadRemeshResult> {
        const bin = await this.ensureBinary();
        const artifactsDir = path.resolve(process.cwd(), '.scratchbox', 'artifacts');
        if (!fs.existsSync(artifactsDir)) {
            fs.mkdirSync(artifactsDir, { recursive: true });
        }
        const tmpOutput = options.outputGlbPath || path.join(artifactsDir, `field_remeshed_${Date.now()}.glb`);
        const targetQuads = options.targetQuadCount ?? 2000;
        const crease = options.creaseAngleDegrees ?? 35.0;
        const manhattan = (options.alignToManhattanAxes ?? true) ? 1 : 0;
        const yaw = options.dominantYawDegrees ?? 0.0;
        const wireframe = (options.includeWireframe ?? true) ? 1 : 0;

        const args = [
            `--output "${tmpOutput}"`,
            `--quads ${targetQuads}`,
            `--crease ${crease}`,
            `--manhattan ${manhattan}`,
            `--yaw ${yaw}`,
            `--wireframe ${wireframe}`
        ];

        if (options.inputGlbPath) {
            args.push(`--input "${options.inputGlbPath}"`);
        }

        const cmd = `"${bin}" ${args.join(' ')}`;
        const { stdout, stderr } = await execAsync(cmd, { maxBuffer: 1024 * 1024 * 64 });

        // Parse structured telemetry lines
        const getNum = (pattern: RegExp, defaultVal = 0): number => {
            const m = stdout.match(pattern);
            return m ? parseFloat(m[1]) : defaultVal;
        };

        const inputTriangles = getNum(/Input Triangles:\s*([0-9]+)/, 0);
        const outputQuads = getNum(/Output Quads:\s*([0-9]+)/, 0);
        const outputTriangles = getNum(/Output Triangles:\s*([0-9]+)/, 0);
        const pureQuadPercent = getNum(/Pure Quad Ratio:\s*([0-9.]+)%/, 0);
        const singularitiesCount = getNum(/Singularities(?:\s*\(val 3\/5\))?:\s*([0-9]+)/, 0);
        const meanQuadAspect = getNum(/Mean (?:Aspect Ratio|Quad Aspect Ratio):\s*([0-9.]+)/, 1.0);
        const meanCornerOrthogonalityDeg = getNum(/Mean Corner (?:Orthogonality|Angle):\s*([0-9.]+)/, 90.0);
        const maxAngleDeviationDeg = getNum(/Max Angle Deviation:\s*([0-9.]+)/, 0);
        const meanSurfaceDeviationMm = getNum(/Mean Surface Deviation:\s*([0-9.]+)/, 0);
        const sharpCreaseEdges = getNum(/Sharp Crease Edges:\s*([0-9]+)/, 0);
        const processingTimeMs = getNum(/Remesh (?:Processing Time|Runtime):\s*([0-9.]+)/, 0);

        const metrics: QuadRemeshMetrics = {
            inputTriangles,
            outputQuads,
            outputTriangles,
            pureQuadRatio: pureQuadPercent / 100.0,
            pureQuadPercent,
            singularitiesCount,
            meanQuadAspect,
            meanCornerOrthogonalityDeg,
            maxAngleDeviationDeg,
            meanSurfaceDeviationMm,
            sharpCreaseEdges,
            processingTimeMs
        };

        let glbBuffer: Buffer | undefined;
        let glbBase64: string | undefined;

        if (fs.existsSync(tmpOutput)) {
            glbBuffer = fs.readFileSync(tmpOutput);
            glbBase64 = glbBuffer.toString('base64');
        }

        return {
            success: stdout.includes('STATUS: SUCCESS') || outputQuads > 0,
            glbBuffer,
            glbBase64,
            outputGlbPath: tmpOutput,
            metrics,
            stdout,
            stderr
        };
    }

    /**
     * Convenience method to remesh an existing GLB file on disk.
     */
    async remeshGlbFile(inputGlbPath: string, options: QuadRemeshServiceOptions = {}): Promise<QuadRemeshResult> {
        return this.remeshMesh({
            ...options,
            inputGlbPath
        });
    }
}
