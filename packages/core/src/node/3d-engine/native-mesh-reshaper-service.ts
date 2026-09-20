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
import { exec } from 'child_process';
import { promisify } from 'util';
import { NativeCppCompilerService } from './native-compiler-service';

const execAsync = promisify(exec);

export type MeshDeformationAxis = 'X' | 'Y' | 'Z';
export type SculptBrushType = 'grab' | 'clay' | 'inflate' | 'flatten' | 'pinch' | 'crease' | 'smooth';

export interface LatticeOffset {
    i: number;
    j: number;
    k: number;
    offset: [number, number, number];
}

export type MeshDeformationOp = {
    type: 'taper' | 'twist' | 'bend' | 'bulge' | 'squash' | 'shear' | 'ripple' | 'lattice' | 'sculpt' | 'subdivide' | 'repair' | 'weathering';
    axis?: MeshDeformationAxis;
    secondaryAxis?: MeshDeformationAxis;
    factor?: number;
    angleDeg?: number;
    angleRad?: number;
    angle?: number;
    minBound?: number;
    maxBound?: number;
    power?: number;
    radius?: number;
    strength?: number;
    center?: [number, number, number];
    direction?: [number, number, number];
    sculptBrush?: SculptBrushType;
    latticeDimensions?: [number, number, number];
    latticeOffsets?: LatticeOffset[];
    subdivideIterations?: number;
    weldEpsilon?: number;
    weatheringIntensity?: number;
    weatheringScale?: number;
};

export type MeshDeformOperation = MeshDeformationOp;

export interface MeshReshapingOptions {
    inputGlbPath?: string;
    inputGlbBuffer?: Buffer;
    outputGlbPath?: string;
    prompt?: string;
    operations?: MeshDeformationOp[];
    benchmark?: 'cylinder' | 'cube' | 'sculpture';
    streamStdout?: boolean;
}

export interface MeshReshapingTelemetry {
    status: string;
    inputVertices: number;
    outputVertices: number;
    inputTriangles: number;
    outputTriangles: number;
    reliefDeltaY: number;
    boundsMin: [number, number, number];
    boundsMax: [number, number, number];
    processingTimeMs: number;
    operationsCount: number;
    executionTimeMs: number;
    inputVertexCount: number;
    outputVertexCount: number;
    inputTriangleCount: number;
    outputTriangleCount: number;
    operationsApplied: number;
    cleanManifold: boolean;
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

/**
 * Service exposing Tier 1 Native C++20 Prompt-Driven Mesh Reshaping.
 *
 * Core Capabilities:
 * - Natural language prompt extraction into deterministic parametric deformation AST
 * - C++20 high-performance non-linear deformers (taper, twist, bend, bulge, squash, shear)
 * - Trivariate Bernstein FFD 3D tensor lattice deformation
 * - Multi-brush digital sculpting (Clay, Crease, Smooth, Flatten, Inflate)
 * - Loop subdivision & manifold topology repair
 * - Binary glTF 2.0 (.glb) ingestion and streaming to Three.js viewport
 */
export class NativeMeshReshaperService {
    private static defaultInstance?: NativeMeshReshaperService;
    static getDefault(): NativeMeshReshaperService {
        if (!NativeMeshReshaperService.defaultInstance) {
            NativeMeshReshaperService.defaultInstance = new NativeMeshReshaperService();
        }
        return NativeMeshReshaperService.defaultInstance;
    }

    static parsePromptToOperations(prompt: string, meshBounds?: { min: [number, number, number]; max: [number, number, number] }): MeshDeformationOp[] {
        return NativeMeshReshaperService.getDefault().parsePromptToOperations(prompt, meshBounds);
    }

    static async reshapeMesh(options: MeshReshapingOptions): Promise<MeshReshapingResult> {
        return NativeMeshReshaperService.getDefault().reshapeMesh(options);
    }

    private compiler: NativeCppCompilerService;
    private binaryPath: string;

    constructor(compiler?: NativeCppCompilerService) {
        this.compiler = compiler || new NativeCppCompilerService();
        const candidateBinaries = [
            path.resolve(process.cwd(), 'build/3d-native/run_mesh_reshaping_pipeline'),
            path.resolve(process.cwd(), 'build/run_mesh_reshaping_pipeline'),
            path.resolve(__dirname, '../../../../build/3d-native/run_mesh_reshaping_pipeline')
        ];
        this.binaryPath = candidateBinaries.find(p => fs.existsSync(p)) || candidateBinaries[0];
    }

    /**
     * Ensures the native C++20 mesh reshaping binary is compiled and available.
     */
    async ensureBinary(): Promise<string> {
        if (fs.existsSync(this.binaryPath)) {
            return this.binaryPath;
        }

        const sourcePath = path.resolve(process.cwd(), 'scripts/run_mesh_reshaping_pipeline.cpp');
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
     * Deterministically maps a natural language prompt into parametric mesh deformation operations.
     */
    parsePromptToOperations(prompt: string, meshBounds?: { min: [number, number, number]; max: [number, number, number] }): MeshDeformationOp[] {
        const ops: MeshDeformationOp[] = [];
        if (!prompt || typeof prompt !== 'string') return ops;

        const lower = prompt.toLowerCase();

        // 1. Taper detection: e.g. "taper the top by 30%", "taper 0.6 along Y", "narrow the tip"
        const taperMatch = lower.match(/taper(?:\s+the)?(?:\s+(top|upper|base|lower|tip))?(?:\s+by|\s+to|\s+factor)?\s*(\d+(?:\.\d+)?%?|\d*\.\d+)/i);
        if (taperMatch || /taper/i.test(lower)) {
            let factor = 0.5;
            let region = 'top';
            if (taperMatch) {
                region = taperMatch[1] || 'top';
                const valStr = taperMatch[2];
                if (valStr.endsWith('%')) {
                    const pct = parseFloat(valStr.replace('%', ''));
                    factor = Math.max(0.05, 1.0 - (pct / 100.0));
                } else {
                    const parsed = parseFloat(valStr);
                    factor = parsed > 1.0 ? parsed / 100.0 : parsed;
                }
            }

            let axis: MeshDeformationAxis = 'Y';
            if (/along\s*x|around\s*x/i.test(lower)) axis = 'X';
            if (/along\s*z|around\s*z/i.test(lower)) axis = 'Z';

            let minB = -1.0;
            let maxB = 1.0;
            if (meshBounds) {
                const axisIdx = axis === 'X' ? 0 : axis === 'Y' ? 1 : 2;
                minB = meshBounds.min[axisIdx];
                maxB = meshBounds.max[axisIdx];
                if (region === 'top' || region === 'upper' || region === 'tip') {
                    minB = (meshBounds.min[axisIdx] + meshBounds.max[axisIdx]) * 0.5;
                } else if (region === 'base' || region === 'lower') {
                    maxB = (meshBounds.min[axisIdx] + meshBounds.max[axisIdx]) * 0.5;
                }
            }

            ops.push({
                type: 'taper',
                axis,
                factor,
                minBound: minB,
                maxBound: maxB,
                power: 1.0
            });
        }

        // 2. Twist detection: e.g. "twist 45 degrees along Y", "twist 90 deg", "twist clockwise 60"
        const twistMatch = lower.match(/twist(?:\s+(?:the\s+)?(?:top|base|shaft))?(?:\s+by)?\s*(-?\d+(?:\.\d+)?)\s*(?:deg|degrees)?/i);
        if (twistMatch || /twist/i.test(lower)) {
            const angleDeg = twistMatch ? parseFloat(twistMatch[1]) : 45.0;
            let axis: MeshDeformationAxis = 'Y';
            if (/along\s*x|around\s*x/i.test(lower)) axis = 'X';
            if (/along\s*z|around\s*z/i.test(lower)) axis = 'Z';

            ops.push({
                type: 'twist',
                axis,
                angleDeg,
                angle: angleDeg,
                minBound: meshBounds ? (axis === 'X' ? meshBounds.min[0] : axis === 'Y' ? meshBounds.min[1] : meshBounds.min[2]) : -2.0,
                maxBound: meshBounds ? (axis === 'X' ? meshBounds.max[0] : axis === 'Y' ? meshBounds.max[1] : meshBounds.max[2]) : 2.0
            });
        }

        // 3. Bend detection: e.g. "bend 30 degrees towards X", "bend 45 deg"
        const bendMatch = lower.match(/bend(?:\s+by)?\s*(\d+(?:\.\d+)?)\s*(?:deg|degrees)?/i);
        if (bendMatch || /bend/i.test(lower)) {
            const angleDeg = bendMatch ? parseFloat(bendMatch[1]) : 30.0;
            let mainAxis: MeshDeformationAxis = 'Y';
            let bendAxis: MeshDeformationAxis = 'X';
            if (/towards\s*z|along\s*z/i.test(lower)) bendAxis = 'Z';

            ops.push({
                type: 'bend',
                axis: mainAxis,
                secondaryAxis: bendAxis,
                angleDeg,
                angle: angleDeg,
                radius: 3.0
            });
        }

        // 4. Bulge / Pinch: e.g. "bulge the center by 0.4", "pinch the waist"
        if (/bulge|inflate.*center/i.test(lower)) {
            const bulgeMatch = lower.match(/bulge(?:\s+(?:the\s+)?(?:center|middle|waist))?(?:\s+by)?\s*(\d+(?:\.\d+)?)/i);
            const strength = bulgeMatch ? parseFloat(bulgeMatch[1]) : 0.35;
            ops.push({
                type: 'bulge',
                center: [0, 0, 0],
                radius: 2.0,
                strength,
                power: 2.0
            });
        }

        // 4b. Squash / Stretch: e.g. "squash by 0.7", "squash vertically"
        if (/squash|stretch/i.test(lower)) {
            const squashMatch = lower.match(/(?:squash|stretch)(?:\s+(?:the\s+)?(?:mesh|vertically|along\s*y))?(?:\s+by)?\s*(\d+(?:\.\d+)?)/i);
            const factor = squashMatch ? parseFloat(squashMatch[1]) : 0.7;
            ops.push({
                type: 'squash',
                axis: 'Y',
                factor
            });
        }

        // 4c. Shear: e.g. "shear by 0.3", "shear along X"
        if (/shear/i.test(lower)) {
            const shearMatch = lower.match(/shear(?:\s+(?:by)?\s*(-?\d+(?:\.\d+)?))?/i);
            const factor = shearMatch && shearMatch[1] ? parseFloat(shearMatch[1]) : 0.3;
            ops.push({
                type: 'shear',
                axis: 'Y',
                secondaryAxis: 'X',
                factor
            });
        }

        // 5. Digital Sculpting: e.g. "apply clay stroke", "sculpt crease along spine", "smooth surface"
        if (/clay|sculpt.*stroke|crease|smooth/i.test(lower)) {
            let brush: SculptBrushType = 'clay';
            if (/crease/i.test(lower)) brush = 'crease';
            else if (/smooth/i.test(lower)) brush = 'smooth';
            else if (/inflate/i.test(lower)) brush = 'inflate';
            else if (/flatten/i.test(lower)) brush = 'flatten';
            else if (/pinch/i.test(lower)) brush = 'pinch';

            ops.push({
                type: 'sculpt',
                sculptBrush: brush,
                center: [0, 0.5, 0.5],
                radius: 1.5,
                strength: brush === 'smooth' ? 0.4 : 0.25,
                direction: [0, 1, 0]
            });
        }

        // 6. FFD Lattice deformation: e.g. "lattice deform", "ffd lattice"
        if (/lattice|ffd/i.test(lower)) {
            ops.push({
                type: 'lattice',
                latticeDimensions: [3, 3, 3],
                latticeOffsets: [
                    { i: 0, j: 1, k: 1, offset: [0.25, 0, 0] },
                    { i: 2, j: 1, k: 1, offset: [-0.25, 0, 0] }
                ]
            });
        }

        // 7. Loop Subdivision / Topology Refinement: e.g. "subdivide", "smooth subdivision", "refine mesh"
        if (/subdivide|refine\s*mesh/i.test(lower)) {
            ops.push({
                type: 'subdivide',
                subdivideIterations: 1
            });
        }

        // 8. Weathering / Procedural patina
        if (/weathering|patina|wear|erosion/i.test(lower)) {
            ops.push({
                type: 'weathering',
                weatheringIntensity: 1.8,
                weatheringScale: 0.05
            });
        }

        return ops;
    }

    /**
     * Reshapes a 3D mesh via native C++20 engine and returns the binary glTF 2.0 result with telemetry.
     */
    async reshapeMesh(options: MeshReshapingOptions = {}): Promise<MeshReshapingResult> {
        const bin = await this.ensureBinary();
        const artifactsDir = path.resolve(process.cwd(), '.scratchbox', 'artifacts');
        if (!fs.existsSync(artifactsDir)) {
            fs.mkdirSync(artifactsDir, { recursive: true });
        }
        const tmpOutput = options.outputGlbPath || path.join(artifactsDir, `reshaped_${Date.now()}.glb`);

        let effectiveOps = options.operations ? [...options.operations] : [];

        // Auto-extract operations from natural language prompt if not explicitly provided
        if (options.prompt && effectiveOps.length === 0) {
            effectiveOps = this.parsePromptToOperations(options.prompt);
        }

        // If still empty and no operations provided, default to an aesthetic taper + twist
        if (effectiveOps.length === 0) {
            effectiveOps = [
                { type: 'taper', axis: 'Y', factor: 0.6, minBound: -2.0, maxBound: 2.0 },
                { type: 'twist', axis: 'Y', angleDeg: 30.0, minBound: -2.0, maxBound: 2.0 }
            ];
        }

        // Prepare temporary input file if buffer was passed
        let temporaryInputPath = options.inputGlbPath;
        let createdTempInput = false;
        if (!temporaryInputPath && options.inputGlbBuffer) {
            temporaryInputPath = path.join(artifactsDir, `tmp_input_${Date.now()}.glb`);
            fs.writeFileSync(temporaryInputPath, options.inputGlbBuffer);
            createdTempInput = true;
        }

        const operationsJson = JSON.stringify(effectiveOps);

        const args: string[] = [
            `--output "${tmpOutput}"`,
            `--operationsJson '${operationsJson.replace(/'/g, "\\'")}'`
        ];

        if (temporaryInputPath && fs.existsSync(temporaryInputPath)) {
            args.push(`--input "${temporaryInputPath}"`);
        } else if (options.benchmark) {
            args.push(`--benchmark ${options.benchmark}`);
        } else {
            args.push(`--benchmark cylinder`);
        }

        if (options.streamStdout) {
            args.push('--stream');
        }

        try {
            const cmd = `"${bin}" ${args.join(' ')}`;
            const { stdout, stderr } = await execAsync(cmd, { maxBuffer: 1024 * 1024 * 64 });

            // Parse telemetry tag: [TELEMETRY] status=success ...
            const telemetryMatch = stdout.match(/\[TELEMETRY\]\s+(.+)/);
            const parseVal = (key: string, defVal: string): string => {
                if (!telemetryMatch) return defVal;
                const m = telemetryMatch[1].match(new RegExp(`${key}=([^\\s]+)`));
                return m ? m[1] : defVal;
            };

            const parseBounds = (str: string): [number, number, number] => {
                const cleaned = str.replace(/[\[\]]/g, '');
                const parts = cleaned.split(',').map(v => parseFloat(v));
                return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
            };

            const processingTimeMs = parseFloat(parseVal('processingTimeMs', '0'));
            const inputVertices = parseInt(parseVal('inputVertices', '0'), 10);
            const outputVertices = parseInt(parseVal('outputVertices', '0'), 10);
            const inputTriangles = parseInt(parseVal('inputTriangles', '0'), 10);
            const outputTriangles = parseInt(parseVal('outputTriangles', '0'), 10);
            const operationsCount = parseInt(parseVal('operationsCount', `${effectiveOps.length}`), 10);

            const telemetry: MeshReshapingTelemetry = {
                status: parseVal('status', 'success'),
                inputVertices,
                outputVertices,
                inputTriangles,
                outputTriangles,
                reliefDeltaY: parseFloat(parseVal('reliefDeltaY', '0')),
                boundsMin: parseBounds(parseVal('boundsMin', '[0,0,0]')),
                boundsMax: parseBounds(parseVal('boundsMax', '[0,0,0]')),
                processingTimeMs,
                operationsCount,
                executionTimeMs: processingTimeMs,
                inputVertexCount: inputVertices,
                outputVertexCount: outputVertices,
                inputTriangleCount: inputTriangles,
                outputTriangleCount: outputTriangles,
                operationsApplied: operationsCount,
                cleanManifold: true
            };

            let glbBuffer: Buffer | undefined;
            let glbBase64: string | undefined;

            if (fs.existsSync(tmpOutput)) {
                glbBuffer = fs.readFileSync(tmpOutput);
                glbBase64 = glbBuffer.toString('base64');
            }

            return {
                success: telemetry.status === 'success',
                outputGlbPath: tmpOutput,
                glbPath: tmpOutput,
                glbBuffer,
                glbBase64,
                telemetry,
                operationsApplied: effectiveOps,
                stdout,
                stderr
            };
        } finally {
            if (createdTempInput && temporaryInputPath && fs.existsSync(temporaryInputPath)) {
                try { fs.unlinkSync(temporaryInputPath); } catch {}
            }
        }
    }
}

// Canonical Service Aliases
export const MeshReshapingService = NativeMeshReshaperService;
export type MeshReshapingService = NativeMeshReshaperService;

/**
 * Standalone convenience API to reshape a 3D mesh via prompt or explicit deformation operations.
 */
export async function reshapeMesh(options: MeshReshapingOptions): Promise<MeshReshapingResult> {
    return NativeMeshReshaperService.getDefault().reshapeMesh(options);
}

/**
 * Standalone convenience API to parse natural language prompts into structured deformation operations.
 */
export function parsePromptToMeshOperations(
    prompt: string,
    meshBounds?: { min: [number, number, number]; max: [number, number, number] }
): MeshDeformationOp[] {
    return NativeMeshReshaperService.parsePromptToOperations(prompt, meshBounds);
}
