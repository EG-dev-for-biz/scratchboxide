/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * SB-Veggie (Scratchbox Vegetation) Native C++20 Parametric Engine Service.

 ********************************************************************************/

import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { NativeCppCompilerService } from './native-compiler-service';
import { MissingInputError } from '../../common/errors/pipeline-errors';
import {
    SbVeggieSynthesizeOptions,
    SbVeggieInversionOptions,
    SbVeggieResult,
    SbVeggieTelemetry,
    SbVeggieArchetype
} from '../../common/botanical/sb-veggie-protocol';

const execFileAsync = promisify(execFile);
const RUN_OPTIONS = { maxBuffer: 64 * 1024 * 1024 };
/** Builds in flight per binary path, so concurrent callers in one process share one compile. */
const building = new Map<string, Promise<string>>();

/** The checkout holding scripts/run_sb_veggie.cpp: walks up from this file, then from cwd. */
function findSbVeggieRepoRoot(): string {
    for (const start of [__dirname, process.cwd()]) {
        let dir = path.resolve(start);
        while (true) {
            if (fs.existsSync(path.join(dir, 'scripts', 'run_sb_veggie.cpp'))) return dir;
            const parent = path.dirname(dir);
            if (parent === dir) break;
            dir = parent;
        }
    }
    return process.cwd();
}

/**
 * Service orchestrating the native C++20 SB-Veggie (Scratchbox Vegetation)
 * Parametric Botanical Model and Scan Inversion Engine.
 */
export class SbVeggieService {
    private compiler: NativeCppCompilerService;
    private binaryPath: string;

    private readonly sourcePath: string;

    constructor(compiler?: NativeCppCompilerService) {
        this.compiler = compiler || new NativeCppCompilerService();
        const root = findSbVeggieRepoRoot();
        this.sourcePath = path.join(root, 'scripts', 'run_sb_veggie.cpp');
        this.binaryPath = path.join(root, 'build', 'run_sb_veggie');
    }

    /**
     * Builds build/run_sb_veggie from scripts/run_sb_veggie.cpp when it is missing or older than the source or any
     * engine header, so a binary built from older sources is never run.
     */
    ensureBinary(): Promise<string> {
        let pending = building.get(this.binaryPath);
        if (!pending) {
            pending = this.buildIfStale().finally(() => building.delete(this.binaryPath));
            building.set(this.binaryPath, pending);
        }
        return pending;
    }

    private async buildIfStale(): Promise<string> {
        if (!fs.existsSync(this.sourcePath)) throw new Error(`run_sb_veggie source not found: ${this.sourcePath}`);
        const includePath = this.compiler.getSdkIncludePath();
        const binTime = fs.existsSync(this.binaryPath) ? fs.statSync(this.binaryPath).mtimeMs : -1;
        const sources = [this.sourcePath, ...fs.readdirSync(includePath).filter(f => f.endsWith('.hpp') || f.endsWith('.h')).map(f => path.join(includePath, f))];
        if (binTime >= 0 && sources.every(f => fs.statSync(f).mtimeMs <= binTime)) return this.binaryPath;

        fs.mkdirSync(path.dirname(this.binaryPath), { recursive: true });
        const tmp = `${this.binaryPath}.tmp-${process.pid}-${Date.now()}`;
        const args = ['-std=c++20', '-O3', ...(process.env.SCRATCHBOX_NATIVE_ARCH === '1' ? ['-march=native'] : []), '-I', includePath, this.sourcePath, '-o', tmp];
        try {
            await execFileAsync(process.env.CXX || 'clang++', args, RUN_OPTIONS);
        } catch (err: any) {
            fs.rmSync(tmp, { force: true });
            throw new Error(`could not build run_sb_veggie: ${String(err?.stderr || err?.message || err).slice(-2000)}`);
        }
        fs.renameSync(tmp, this.binaryPath);
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

        const args: string[] = ['--output', tmpOutput, '--archetype', archetype];

        // Morphological Shape (beta)
        if (options.shape) {
            const { shape } = options;
            if (shape.beta && Array.isArray(shape.beta)) {
                for (let i = 0; i < Math.min(shape.beta.length, 16); ++i) {
                    args.push(`--beta${i}`, String(shape.beta[i]));
                }
            }
            if (shape.dbhCaliper !== undefined) args.push('--beta0', String(shape.dbhCaliper));
            if (shape.treeHeight !== undefined) args.push('--beta1', String(shape.treeHeight));
            if (shape.crownSpread !== undefined) args.push('--beta2', String(shape.crownSpread));
            if (shape.crownBaseHeight !== undefined) args.push('--beta3', String(shape.crownBaseHeight));
            if (shape.branchDroop !== undefined) args.push('--beta4', String(shape.branchDroop));
            if (shape.buttressFlare !== undefined) args.push('--beta5', String(shape.buttressFlare));
            if (shape.taperExponent !== undefined) args.push('--beta6', String(shape.taperExponent));
            if (shape.apicalDominance !== undefined) args.push('--beta7', String(shape.apicalDominance));
        }

        // Phenology (psi)
        if (options.phenology) {
            const { phenology } = options;
            if (phenology.season !== undefined) args.push('--season', String(phenology.season));
            if (phenology.leafDensity !== undefined) args.push('--leaf-density', String(phenology.leafDensity));
            if (phenology.generateLeaves !== undefined) args.push('--generate-leaves', String(phenology.generateLeaves ? 1 : 0));
        }

        // Branch and Leaf Shaping
        if (options.shaping) {
            const { shaping } = options;
            if (shaping.branchCurvature !== undefined) args.push('--branch-curvature', String(shaping.branchCurvature));
            if (shaping.collarFlare !== undefined) args.push('--collar-flare', String(shaping.collarFlare));
            if (shaping.reactionWood !== undefined) args.push('--reaction-wood', String(shaping.reactionWood));
            if (shaping.leafMorphology !== undefined) args.push('--leaf-morphology', String(shaping.leafMorphology));
            if (shaping.leafCupping !== undefined) args.push('--leaf-cupping', String(shaping.leafCupping));
            if (shaping.transferEnvelopeNormals !== undefined) {
                args.push('--envelope-normals', String(shaping.transferEnvelopeNormals ? 1 : 0));
            }
        }

        // Kinematic Wind Pose
        if (options.pose) {
            const { pose } = options;
            if (pose.windVector) {
                args.push('--wind-x', String(pose.windVector.x), '--wind-y', String(pose.windVector.y), '--wind-z', String(pose.windVector.z));
            }
            if (pose.windTimeSeconds !== undefined) {
                args.push('--wind-time', String(pose.windTimeSeconds));
            }
        }

        return this.run(bin, args, tmpOutput, archetype);
    }

    /**
     * Fits the parametric SB-Veggie model to the vertex-coloured vegetation of a real scan (.glb). The scan is
     * required; a scan that is missing, unreadable or carries no vertex-coloured vegetation fails (success false,
     * with the reason in stderr). Nothing is fitted to a synthetic stand-in.
     */
    async fitScanToTree(options: SbVeggieInversionOptions): Promise<SbVeggieResult> {
        if (!options?.inputScanPath) throw new MissingInputError('SbVeggieService.fitScanToTree', 'inputScanPath', 'a scan (.glb) with vertex-coloured vegetation');
        const bin = await this.ensureBinary();
        const artifactsDir = path.resolve(process.cwd(), '.scratchbox', 'artifacts');
        if (!fs.existsSync(artifactsDir)) {
            fs.mkdirSync(artifactsDir, { recursive: true });
        }

        const tmpOutput = options.outputGlbPath || path.join(artifactsDir, `sb_veggie_fitted_${Date.now()}.glb`);
        const archetype = options.archetype ?? 'decurrent';

        const args: string[] = ['--output', tmpOutput, '--archetype', archetype, '--fit-scan', path.resolve(options.inputScanPath)];
        if (options.maxIterations !== undefined) {
            args.push('--max-iterations', String(options.maxIterations));
        }
        if (options.phenology?.season !== undefined) {
            args.push('--season', String(options.phenology.season));
        }
        if (options.shaping?.leafMorphology !== undefined) {
            args.push('--leaf-morphology', String(options.shaping.leafMorphology));
        }
        if (options.shaping?.leafCupping !== undefined) {
            args.push('--leaf-cupping', String(options.shaping.leafCupping));
        }
        if (options.shaping?.branchCurvature !== undefined) {
            args.push('--branch-curvature', String(options.shaping.branchCurvature));
        }
        if (options.shaping?.collarFlare !== undefined) {
            args.push('--collar-flare', String(options.shaping.collarFlare));
        }
        if (options.colorInfluenceWeight !== undefined) {
            args.push('--color-influence', String(options.colorInfluenceWeight));
        }
        if (options.colorInfluenceMode !== undefined) {
            args.push('--color-mode', String(options.colorInfluenceMode));
        }

        return this.run(bin, args, tmpOutput, archetype);
    }

    private async run(bin: string, args: string[], tmpOutput: string, archetype: SbVeggieArchetype): Promise<SbVeggieResult> {
        try {
            const { stdout, stderr } = await execFileAsync(bin, args, RUN_OPTIONS);
            return this.parseStdoutTelemetry(String(stdout), String(stderr), tmpOutput, archetype);
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
