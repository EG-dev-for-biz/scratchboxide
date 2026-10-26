/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NativeCppCompilerService } from './native-compiler-service';
import { carryOverInputMaterial, ensurePipelineBinary, parseTelemetryLine, rawMeshReadIssues, runPipelineBinary } from './native-pipeline-binary';
import { GeneratorFailedError, MissingInputError } from '../../common/errors/pipeline-errors';
import { repoPath } from '../process/repo-python';

export type MeshDeformationAxis = 'X' | 'Y' | 'Z';
export type SculptBrushType = 'grab' | 'clay' | 'inflate' | 'flatten' | 'pinch' | 'crease' | 'smooth';

export interface LatticeOffset {
    i: number;
    j: number;
    k: number;
    /** Offset of the control point as fractions of the mesh's bounding-box size along X, Y, Z. */
    offset: [number, number, number];
}

/**
 * One explicit deformation. Positions and magnitudes are relative to the mesh's measured bounding box (as it stands
 * before the operation), so an operation means the same on any mesh size. Every parameter a type uses is required
 * (power is the only optional one); the native pipeline rejects a missing or out-of-range value and an unknown type.
 *
 * - taper: axis, factor (cross-section scale reached at the range end, > 0), range, power? (curve exponent, default 1)
 * - twist: axis, angleDeg (total twist across the range), range
 * - bend: axis (the length direction), secondaryAxis (direction the far end curves toward), angleDeg (total bend
 *   over the extent along axis; the min end stays fixed)
 * - shear: axis, secondaryAxis, factor (slope: the far end moves factor x the extent along axis)
 * - bulge: center, radius, strength (negative pinches), power? (falloff exponent, default 2)
 * - sculpt: sculptBrush, center, radius, strength, direction (grab, clay and flatten)
 * - lattice: latticeDimensions [2..8 each], latticeOffsets
 * - subdivide: subdivideIterations (1..3); repair: no parameters
 * - weathering: weatheringIntensity (vertex colour variation), weatheringScale (noise cycles across the mesh)
 *
 * range: [start, end] fractions of the extent along axis (0 = min, 1 = max). center: [u, v, w] fractions of the box.
 * radius and strength: fractions of the box diagonal (strength is a 0..1 blend for the smooth and flatten brushes).
 */
export type MeshDeformationOp = {
    type: 'taper' | 'twist' | 'bend' | 'bulge' | 'shear' | 'lattice' | 'sculpt' | 'subdivide' | 'repair' | 'weathering' | (string & {});
    axis?: MeshDeformationAxis;
    secondaryAxis?: MeshDeformationAxis;
    factor?: number;
    angleDeg?: number;
    range?: [number, number];
    power?: number;
    radius?: number;
    strength?: number;
    center?: [number, number, number];
    direction?: [number, number, number];
    sculptBrush?: SculptBrushType;
    latticeDimensions?: [number, number, number];
    latticeOffsets?: LatticeOffset[];
    subdivideIterations?: number;
    weatheringIntensity?: number;
    weatheringScale?: number;
};

export type MeshDeformOperation = MeshDeformationOp;

export interface MeshReshapingOptions {
    /** The mesh to reshape (or inputGlbBuffer). Required: no stand-in mesh is built. */
    inputGlbPath?: string;
    inputGlbBuffer?: Buffer;
    outputGlbPath?: string;
    /** Required and non-empty: no operation is chosen for the caller. */
    operations: MeshDeformationOp[];
    streamStdout?: boolean;
}

export interface MeshReshapingTelemetry {
    status: string;
    inputVertices: number;
    outputVertices: number;
    inputTriangles: number;
    outputTriangles: number;
    reliefDeltaY: number;
    /** The input mesh's measured bounds, which the operations' relative parameters refer to (first operation). */
    inputBoundsMin: [number, number, number];
    inputBoundsMax: [number, number, number];
    boundsMin: [number, number, number];
    boundsMax: [number, number, number];
    processingTimeMs: number;
    operationsCount: number;
}

export interface MeshReshapingResult {
    success: boolean;
    outputGlbPath: string;
    glbPath?: string;
    glbBuffer?: Buffer;
    glbBase64?: string;
    telemetry: MeshReshapingTelemetry;
    operationsApplied: MeshDeformationOp[];
    stdout: string;
    stderr?: string;
}

function parseVec3(value: string | undefined, key: string): [number, number, number] {
    const parts = (value || '').replace(/[[\]]/g, '').split(',').map(Number);
    if (parts.length !== 3 || parts.some(n => !Number.isFinite(n))) {
        throw new GeneratorFailedError('cpp', `the mesh reshaping pipeline reported no valid ${key}`);
    }
    return parts as [number, number, number];
}

function requireTelemetryNumber(values: Map<string, string>, key: string): number {
    const n = Number(values.get(key));
    if (!values.has(key) || !Number.isFinite(n)) {
        throw new GeneratorFailedError('cpp', `the mesh reshaping pipeline reported no ${key}`);
    }
    return n;
}

/**
 * Native C++20 mesh reshaping: applies an explicit list of deformations (taper, twist, bend, shear, bulge, FFD
 * lattice, sculpt strokes, subdivision, repair, weathering) to a given GLB and writes the result. The caller supplies
 * the mesh and every operation; nothing is read from prose and nothing is applied by default.
 */
export class NativeMeshReshaperService {
    private static defaultInstance?: NativeMeshReshaperService;
    static getDefault(): NativeMeshReshaperService {
        if (!NativeMeshReshaperService.defaultInstance) {
            NativeMeshReshaperService.defaultInstance = new NativeMeshReshaperService();
        }
        return NativeMeshReshaperService.defaultInstance;
    }

    static async reshapeMesh(options: MeshReshapingOptions): Promise<MeshReshapingResult> {
        return NativeMeshReshaperService.getDefault().reshapeMesh(options);
    }

    private compiler: NativeCppCompilerService;
    private binaryPath: string;

    constructor(compiler?: NativeCppCompilerService) {
        this.compiler = compiler || new NativeCppCompilerService();
        const candidateBinaries = [
            repoPath('build/3d-native/run_mesh_reshaping_pipeline'),
            path.resolve(process.cwd(), 'build/3d-native/run_mesh_reshaping_pipeline'),
            path.resolve(process.cwd(), 'build/run_mesh_reshaping_pipeline'),
            path.resolve(__dirname, '../../../../build/3d-native/run_mesh_reshaping_pipeline')
        ];
        this.binaryPath = candidateBinaries.find(p => fs.existsSync(p)) || candidateBinaries[0];
    }

    /** The native binary, rebuilt when it is missing or older than its source. */
    async ensureBinary(): Promise<string> {
        return ensurePipelineBinary({
            binaryPath: this.binaryPath,
            sourcePath: repoPath('scripts/run_mesh_reshaping_pipeline.cpp'),
            includeDir: this.compiler.getSdkIncludePath()
        });
    }

    /**
     * Reshapes the given mesh with the given operations. Throws MissingInputError when the mesh or the operations are
     * missing or an operation is invalid (the pipeline names which and why), and GeneratorFailedError when the
     * native run fails or reports no telemetry or no output.
     */
    async reshapeMesh(options: MeshReshapingOptions): Promise<MeshReshapingResult> {
        const operations = Array.isArray(options?.operations) ? options.operations : [];
        if (operations.length === 0) {
            throw new MissingInputError('mesh reshaping', 'operations', 'give at least one deformation; none is applied by default');
        }
        if (!options.inputGlbPath && !options.inputGlbBuffer) {
            throw new MissingInputError('mesh reshaping', 'inputGlbPath', 'give the mesh to reshape; no stand-in mesh is built');
        }
        if (options.inputGlbPath && !fs.existsSync(options.inputGlbPath)) {
            throw new MissingInputError('mesh reshaping', 'inputGlbPath', `${options.inputGlbPath} does not exist`);
        }
        // The native reader ignores node transforms (and misreads some encodings) and the writer writes one material
        // and no textures: refuse such a GLB rather than return it moved, scrambled or stripped with "completed".
        const glbBytes = options.inputGlbBuffer || fs.readFileSync(options.inputGlbPath!);
        const issues = rawMeshReadIssues(glbBytes);
        if (issues.geometry.length || issues.content.length) {
            throw new MissingInputError('mesh reshaping', 'inputGlbPath',
                `${options.inputGlbPath || 'the given GLB'} cannot be reshaped faithfully: ${[...issues.geometry, ...issues.content].join('; ')}. `
                + 'Bake node transforms into the vertices and use an untextured (clay) mesh with one material.');
        }

        const bin = await this.ensureBinary();
        const artifactsDir = path.resolve(process.cwd(), '.scratchbox', 'artifacts');
        fs.mkdirSync(artifactsDir, { recursive: true });
        const outputGlbPath = options.outputGlbPath || path.join(artifactsDir, `reshaped_${Date.now()}.glb`);

        const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-reshape-'));
        try {
            let inputGlbPath = options.inputGlbPath;
            if (!inputGlbPath) {
                inputGlbPath = path.join(scratch, 'input.glb');
                fs.writeFileSync(inputGlbPath, options.inputGlbBuffer!);
            }
            const operationsFile = path.join(scratch, 'operations.json');
            fs.writeFileSync(operationsFile, JSON.stringify(operations));
            const args = ['--input', inputGlbPath, '--output', outputGlbPath, '--operationsFile', operationsFile];
            if (options.streamStdout) args.push('--stream');

            let run: { stdout: string; stderr: string };
            try {
                run = await runPipelineBinary(bin, args);
            } catch (err: any) {
                const detail = String(err?.stderr || err?.message || err).trim();
                if (err?.code === 2) {
                    throw new MissingInputError('mesh reshaping', 'valid operations', detail.replace(/^Error:\s*/, ''));
                }
                throw new GeneratorFailedError('cpp', `mesh reshaping failed: ${detail}`);
            }

            const values = parseTelemetryLine(run.stdout, 'the mesh reshaping pipeline');
            const status = values.get('status');
            if (status !== 'success') {
                throw new GeneratorFailedError('cpp', `the mesh reshaping pipeline reported status ${status || '(none)'}. ${run.stderr}`);
            }
            if (!fs.existsSync(outputGlbPath)) {
                throw new GeneratorFailedError('cpp', `the mesh reshaping pipeline wrote no GLB to ${outputGlbPath}`);
            }
            const telemetry: MeshReshapingTelemetry = {
                status,
                inputVertices: requireTelemetryNumber(values, 'inputVertices'),
                outputVertices: requireTelemetryNumber(values, 'outputVertices'),
                inputTriangles: requireTelemetryNumber(values, 'inputTriangles'),
                outputTriangles: requireTelemetryNumber(values, 'outputTriangles'),
                reliefDeltaY: requireTelemetryNumber(values, 'reliefDeltaY'),
                inputBoundsMin: parseVec3(values.get('inputBoundsMin'), 'inputBoundsMin'),
                inputBoundsMax: parseVec3(values.get('inputBoundsMax'), 'inputBoundsMax'),
                boundsMin: parseVec3(values.get('boundsMin'), 'boundsMin'),
                boundsMax: parseVec3(values.get('boundsMax'), 'boundsMax'),
                processingTimeMs: requireTelemetryNumber(values, 'processingTimeMs'),
                operationsCount: requireTelemetryNumber(values, 'operationsCount')
            };
            // The writer's stock material is replaced with the input's own (clay stays clay).
            const glbBuffer = carryOverInputMaterial(glbBytes, outputGlbPath);
            return {
                success: true,
                outputGlbPath,
                glbPath: outputGlbPath,
                glbBuffer,
                glbBase64: glbBuffer.toString('base64'),
                telemetry,
                operationsApplied: operations,
                stdout: run.stdout,
                stderr: run.stderr
            };
        } finally {
            fs.rmSync(scratch, { recursive: true, force: true });
        }
    }
}

// Canonical Service Aliases
export const MeshReshapingService = NativeMeshReshaperService;
export type MeshReshapingService = NativeMeshReshaperService;

/**
 * Standalone convenience API to reshape a given mesh with explicit deformation operations.
 */
export async function reshapeMesh(options: MeshReshapingOptions): Promise<MeshReshapingResult> {
    return NativeMeshReshaperService.getDefault().reshapeMesh(options);
}
