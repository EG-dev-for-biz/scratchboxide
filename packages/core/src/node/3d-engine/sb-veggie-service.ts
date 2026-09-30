/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * SB-Veggie (Scratchbox Vegetation) Native C++20 Parametric Engine Service.
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
import {
    SbVeggieSynthesizeOptions,
    SbVeggieInversionOptions,
    SbVeggieResult,
    SbVeggieTelemetry,
    SbVeggieArchetype
} from '../../common/botanical/sb-veggie-protocol';

const execAsync = promisify(exec);

/**
 * Service orchestrating the native C++20 SB-Veggie (Scratchbox Vegetation)
 * Parametric Botanical Model and Scan Inversion Engine.
 */
export class SbVeggieService {
    private compiler: NativeCppCompilerService;
    private binaryPath: string;

    constructor(compiler?: NativeCppCompilerService) {
        this.compiler = compiler || new NativeCppCompilerService();
        const candidateBinaries = [
            path.resolve(process.cwd(), 'build/run_sb_veggie'),
            path.resolve(process.cwd(), 'scripts/run_sb_veggie'),
            path.resolve(__dirname, '../../../../scripts/run_sb_veggie'),
            path.resolve(process.cwd(), 'build/3d-native/run_sb_veggie'),
            path.resolve(process.cwd(), 'build/run_smpl_tree'),
            path.resolve(process.cwd(), 'scripts/run_smpl_tree')
        ];
        this.binaryPath = candidateBinaries.find(p => fs.existsSync(p)) || candidateBinaries[0];
    }

    /**
     * Ensures the native C++20 SB-Veggie synthesis & inversion binary is compiled.
     */
    async ensureBinary(): Promise<string> {
        if (fs.existsSync(this.binaryPath)) {
            return this.binaryPath;
        }

        const candidateSources = [
            path.resolve(process.cwd(), 'scripts/run_sb_veggie.cpp'),
            path.resolve(__dirname, '../../../../scripts/run_sb_veggie.cpp'),
            path.resolve(process.cwd(), 'scripts/run_smpl_tree.cpp'),
            path.resolve(__dirname, '../../../../scripts/run_smpl_tree.cpp')
        ];
        const sourcePath = candidateSources.find(p => fs.existsSync(p)) || candidateSources[0];

        const includePath = this.compiler.getSdkIncludePath();
        const outputDir = path.dirname(this.binaryPath);

        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        const cxx = process.env.CXX || 'clang++';
        const archFlag = process.env.SCRATCHBOX_NATIVE_ARCH === '1' ? '-march=native' : '';
        const compileCmd = `${cxx} -std=c++20 -O3 ${archFlag} -I "${includePath}" "${sourcePath}" -o "${this.binaryPath}"`;
        await execAsync(compileCmd);
        return this.binaryPath;
    }

    /**
     * Synthesizes a parametric 3D tree mesh from morphological shape (beta),
     * kinematic pose (theta), and phenology (psi).
     */
    async synthesizeTree(options: SbVeggieSynthesizeOptions = {}): Promise<SbVeggieResult> {
        const bin = await this.ensureBinary();
        const artifactsDir = path.resolve(process.cwd(), '.scratchbox', 'artifacts');
        if (!fs.existsSync(artifactsDir)) {
            fs.mkdirSync(artifactsDir, { recursive: true });
        }

        const tmpOutput = options.outputGlbPath || path.join(artifactsDir, `sb_veggie_${Date.now()}.glb`);
        const archetype = options.archetype ?? 'decurrent';

        const args: string[] = [
            `--output "${tmpOutput}"`,
            `--archetype ${archetype}`
        ];

        // Morphological Shape (beta)
        if (options.shape) {
            const { shape } = options;
            if (shape.beta && Array.isArray(shape.beta)) {
                for (let i = 0; i < Math.min(shape.beta.length, 16); ++i) {
                    args.push(`--beta${i} ${shape.beta[i]}`);
                }
            }
            if (shape.dbhCaliper !== undefined) args.push(`--beta0 ${shape.dbhCaliper}`);
            if (shape.treeHeight !== undefined) args.push(`--beta1 ${shape.treeHeight}`);
            if (shape.crownSpread !== undefined) args.push(`--beta2 ${shape.crownSpread}`);
            if (shape.crownBaseHeight !== undefined) args.push(`--beta3 ${shape.crownBaseHeight}`);
            if (shape.branchDroop !== undefined) args.push(`--beta4 ${shape.branchDroop}`);
            if (shape.buttressFlare !== undefined) args.push(`--beta5 ${shape.buttressFlare}`);
            if (shape.taperExponent !== undefined) args.push(`--beta6 ${shape.taperExponent}`);
            if (shape.apicalDominance !== undefined) args.push(`--beta7 ${shape.apicalDominance}`);
        }

        // Phenology (psi)
        if (options.phenology) {
            const { phenology } = options;
            if (phenology.season !== undefined) args.push(`--season ${phenology.season}`);
            if (phenology.leafDensity !== undefined) args.push(`--leaf-density ${phenology.leafDensity}`);
            if (phenology.generateLeaves !== undefined) args.push(`--generate-leaves ${phenology.generateLeaves ? 1 : 0}`);
        }

        // Branch and Leaf Shaping
        if (options.shaping) {
            const { shaping } = options;
            if (shaping.branchCurvature !== undefined) args.push(`--branch-curvature ${shaping.branchCurvature}`);
            if (shaping.collarFlare !== undefined) args.push(`--collar-flare ${shaping.collarFlare}`);
            if (shaping.reactionWood !== undefined) args.push(`--reaction-wood ${shaping.reactionWood}`);
            if (shaping.leafMorphology !== undefined) args.push(`--leaf-morphology ${shaping.leafMorphology}`);
            if (shaping.leafCupping !== undefined) args.push(`--leaf-cupping ${shaping.leafCupping}`);
            if (shaping.transferEnvelopeNormals !== undefined) {
                args.push(`--envelope-normals ${shaping.transferEnvelopeNormals ? 1 : 0}`);
            }
        }

        // Kinematic Wind Pose
        if (options.pose) {
            const { pose } = options;
            if (pose.windVector) {
                args.push(`--wind-x ${pose.windVector.x} --wind-y ${pose.windVector.y} --wind-z ${pose.windVector.z}`);
            }
            if (pose.windTimeSeconds !== undefined) {
                args.push(`--wind-time ${pose.windTimeSeconds}`);
            }
        }

        const cmd = `"${bin}" ${args.join(' ')}`;
        try {
            const { stdout, stderr } = await execAsync(cmd);
            return this.parseStdoutTelemetry(stdout, stderr, tmpOutput, archetype);
        } catch (err: any) {
            return {
                success: false,
                outputGlbPath: tmpOutput,
                telemetry: {
                    archetype,
                    canonicalTemplate: archetype,
                    templateVertices: 0,
                    templateJoints: 0,
                    outputVertices: 0,
                    outputTriangles: 0,
                    buildTimeMs: 0,
                    evalTimeMs: 0
                },
                stdout: err.stdout || '',
                stderr: err.stderr || err.message
            };
        }
    }

    /**
     * Executes Inversion Fitting (fitting the parametric SB-Veggie model
     * to a noisy 3D tile / photogrammetric point cloud or submesh).
     */
    async fitScanToTree(options: SbVeggieInversionOptions = {}): Promise<SbVeggieResult> {
        const bin = await this.ensureBinary();
        const artifactsDir = path.resolve(process.cwd(), '.scratchbox', 'artifacts');
        if (!fs.existsSync(artifactsDir)) {
            fs.mkdirSync(artifactsDir, { recursive: true });
        }

        const tmpOutput = options.outputGlbPath || path.join(artifactsDir, `sb_veggie_fitted_${Date.now()}.glb`);
        const archetype = options.archetype ?? 'decurrent';

        const args: string[] = [
            `--output "${tmpOutput}"`,
            `--archetype ${archetype}`,
            '--fit-scan 1'
        ];

        if (options.inputScanPath) {
            args.push(`--input-scan "${options.inputScanPath}"`);
        }
        if (options.maxIterations !== undefined) {
            args.push(`--max-iterations ${options.maxIterations}`);
        }
        if (options.phenology?.season !== undefined) {
            args.push(`--season ${options.phenology.season}`);
        }
        if (options.shaping?.leafMorphology !== undefined) {
            args.push(`--leaf-morphology ${options.shaping.leafMorphology}`);
        }
        if (options.shaping?.leafCupping !== undefined) {
            args.push(`--leaf-cupping ${options.shaping.leafCupping}`);
        }
        if (options.shaping?.branchCurvature !== undefined) {
            args.push(`--branch-curvature ${options.shaping.branchCurvature}`);
        }
        if (options.shaping?.collarFlare !== undefined) {
            args.push(`--collar-flare ${options.shaping.collarFlare}`);
        }
        if (options.colorInfluenceWeight !== undefined) {
            args.push(`--color-influence ${options.colorInfluenceWeight}`);
        }
        if (options.colorInfluenceMode !== undefined) {
            args.push(`--color-mode ${options.colorInfluenceMode}`);
        }

        const cmd = `"${bin}" ${args.join(' ')}`;
        try {
            const { stdout, stderr } = await execAsync(cmd);
            return this.parseStdoutTelemetry(stdout, stderr, tmpOutput, archetype);
        } catch (err: any) {
            return {
                success: false,
                outputGlbPath: tmpOutput,
                telemetry: {
                    archetype,
                    canonicalTemplate: archetype,
                    templateVertices: 0,
                    templateJoints: 0,
                    outputVertices: 0,
                    outputTriangles: 0,
                    buildTimeMs: 0,
                    evalTimeMs: 0
                },
                stdout: err.stdout || '',
                stderr: err.stderr || err.message
            };
        }
    }

    /**
     * Parses standard output telemetry from the C++20 engine.
     */
    private parseStdoutTelemetry(stdout: string, stderr: string, outputPath: string, defaultArchetype: SbVeggieArchetype): SbVeggieResult {
        let glbBuffer: Buffer | undefined;
        let glbBase64: string | undefined;

        if (fs.existsSync(outputPath)) {
            glbBuffer = fs.readFileSync(outputPath);
            glbBase64 = glbBuffer.toString('base64');
        }

        const extractFloat = (label: string): number => {
            const match = stdout.match(new RegExp(`${label}:\\s*([\\d.-]+)`));
            return match ? parseFloat(match[1]) : 0.0;
        };

        const extractInt = (label: string): number => {
            const match = stdout.match(new RegExp(`${label}:\\s*(\\d+)`));
            return match ? parseInt(match[1], 10) : 0;
        };

        const telemetry: SbVeggieTelemetry = {
            archetype: defaultArchetype,
            canonicalTemplate: defaultArchetype,
            templateVertices: extractInt('Template Vertices'),
            templateJoints: extractInt('Template Joints'),
            outputVertices: extractInt('Total Output Vertices') || extractInt('Output Vertices'),
            outputTriangles: extractInt('Total Output Triangles') || extractInt('Output Triangles'),
            buildTimeMs: extractFloat('Template Build Time'),
            evalTimeMs: extractFloat('Evaluator Render Time') || extractFloat('Mesh Eval Time')
        };

        if (stdout.includes('SB-Veggie Inversion Solver Results') || stdout.includes('Inversion Solver Results') || stdout.includes('SMPLify-Tree Inversion Solver Results') || stdout.includes('Inversion Optimization Results')) {
            const fittedBeta: number[] = new Array(16).fill(0.0);
            const b0 = stdout.match(/Fitted Beta\[0\] \(DBH\):\s*([\d.-]+)/);
            const b1 = stdout.match(/Fitted Beta\[1\] \(Height\):\s*([\d.-]+)/);
            const b2 = stdout.match(/Fitted Beta\[2\] \(Spread\):\s*([\d.-]+)/);
            if (b0) fittedBeta[0] = parseFloat(b0[1]);
            if (b1) fittedBeta[1] = parseFloat(b1[1]);
            if (b2) fittedBeta[2] = parseFloat(b2[1]);

            telemetry.inversion = {
                initialChamferMeters: extractFloat('Initial Chamfer Error'),
                finalChamferMeters: extractFloat('Final Chamfer Error'),
                errorReductionPercent: extractFloat('Error Reduction'),
                iterationsRun: Math.round(extractFloat('Iterations Run')),
                solverRuntimeMs: extractFloat('Solver Runtime'),
                fittedBeta
            };
        }

        const success = stdout.includes('STATUS: SUCCESS') && !!glbBuffer && glbBuffer.length > 0;

        return {
            success,
            glbBuffer,
            glbBase64,
            outputGlbPath: outputPath,
            telemetry,
            stdout,
            stderr
        };
    }
}

// Backward compatibility alias for legacy SMPL-Tree nomenclature
export { SbVeggieService as SmplTreeService };
