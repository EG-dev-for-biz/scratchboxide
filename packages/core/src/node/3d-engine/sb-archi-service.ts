/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * SB-Archi (Scratchbox Classical Architecture) Service.
 *
 * Orchestrates native C++20 Classical Roman amphitheater arcade synthesis,
 * scan inversion, and binary glTF 2.0 streaming.
 ********************************************************************************/

import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { NativeCppCompilerService } from './native-compiler-service';
import { buildNativeIfStale } from './native-build';
import {
    SbArchiInversionOptions,
    SbArchiInversionResult,
    SbArchiTelemetry,
    ArchConstantineOptions,
    ArchConstantineResult,
    TectonicAnalysisReport
} from '../../common/spatial/sb-archi-protocol';

export {
    type SbArchiInversionOptions,
    type SbArchiInversionResult,
    type SbArchiTelemetry,
    type ArchConstantineOptions,
    type ArchConstantineResult,
    type TectonicAnalysisReport
};

const execAsync = promisify(exec);

/** The native SB-Archi binary's telemetry banner was missing a measured line. */
export class SbArchiTelemetryParseError extends Error {
    readonly code = 'SB_ARCHI_TELEMETRY_FIELD_MISSING';
    constructor(field: string) {
        super(`run_sb_archi output has no "${field}" line; refusing to substitute a default. Rebuild the binary and check its stdout.`);
        this.name = 'SbArchiTelemetryParseError';
    }
}

/** The native arch binary's report was missing a measured field (the binary changed or failed part-way). */
export class TectonicReportParseError extends Error {
    readonly code = 'TECTONIC_REPORT_FIELD_MISSING';
    constructor(field: string) {
        super(`run_arch_constantine output has no "${field}" line; refusing to substitute a default. Rebuild the binary and check its stdout.`);
        this.name = 'TectonicReportParseError';
    }
}

export class SbArchiService {
    private compiler: NativeCppCompilerService;
    private binaryPath: string;
    private archConstantineBinaryPath: string;

    constructor(compiler?: NativeCppCompilerService) {
        this.compiler = compiler || new NativeCppCompilerService();
        const candidateBinaries = [
            path.resolve(process.cwd(), 'build/run_sb_archi'),
            path.resolve(process.cwd(), 'scripts/run_sb_archi'),
            path.resolve(__dirname, '../../../../build/run_sb_archi'),
            path.resolve(__dirname, '../../../../scripts/run_sb_archi')
        ];
        this.binaryPath = candidateBinaries.find(p => fs.existsSync(p)) || candidateBinaries[0];

        const candidateArchBinaries = [
            path.resolve(process.cwd(), 'build/run_arch_constantine'),
            path.resolve(process.cwd(), 'scripts/run_arch_constantine'),
            path.resolve(__dirname, '../../../../build/run_arch_constantine'),
            path.resolve(__dirname, '../../../../scripts/run_arch_constantine')
        ];
        this.archConstantineBinaryPath = candidateArchBinaries.find(p => fs.existsSync(p)) || candidateArchBinaries[0];
    }

    /**
     * Ensures the native C++20 SB-Archi synthesis & inversion binary is compiled.
     */
    async ensureBinary(): Promise<string> {
        const candidateSources = [
            path.resolve(process.cwd(), 'scripts/run_sb_archi.cpp'),
            path.resolve(__dirname, '../../../../scripts/run_sb_archi.cpp')
        ];
        const sourcePath = candidateSources.find(p => fs.existsSync(p)) || candidateSources[0];
        return buildNativeIfStale({ source: sourcePath, binary: this.binaryPath, includeDir: this.compiler.getSdkIncludePath() });
    }

    /**
     * Synthesizes and inverts the Roman Colosseum facade into a watertight, hollow arcade.
     */
    async invertColosseumFacade(options: SbArchiInversionOptions = {}): Promise<SbArchiInversionResult> {
        const bin = await this.ensureBinary();

        const defaultInput = path.resolve(process.cwd(), 'public/models/colosseum_clay.glb');
        const inputGlb = options.inputGlbPath || (fs.existsSync(defaultInput) ? defaultInput : '');

        const artifactsDir = path.resolve(process.cwd(), '.scratchbox', 'artifacts');
        if (!fs.existsSync(artifactsDir)) {
            fs.mkdirSync(artifactsDir, { recursive: true });
        }

        const outputGlb = options.outputGlbPath || path.resolve(process.cwd(), 'public/models/colosseum_sb_archi_inverted.glb');
        const section = options.section || 'north_facade';
        const pbrMode = options.pbrMode || 'travertine';

        const args: string[] = [
            `--output-glb "${outputGlb}"`,
            `--section ${section}`,
            `--pbr-mode ${pbrMode}`
        ];

        if (inputGlb && fs.existsSync(inputGlb)) {
            args.push(`--input-glb "${inputGlb}"`);
        }

        if (options.runInversion === false) {
            args.push('--no-invert');
        } else {
            args.push('--invert');
        }

        const cmd = `"${bin}" ${args.join(' ')}`;
        const { stdout, stderr } = await execAsync(cmd);

        const telemetry = this.parseTelemetry(stdout);

        return {
            success: true,
            glbPath: outputGlb,
            glbDownloadUrl: `/colosseum_sb_archi_inverted.glb`,
            telemetry,
            worldPosition: [-43.42, 42.5, 62.54],
            worldRotationYawRad: 0.6273,
            nominalDimensions: [188.0, 48.5, 156.0],
            entityId: 'det-colosseum-facade'
        };
    }

    private parseTelemetry(stdout: string): SbArchiTelemetry {
        // Every number comes from the binary's banner; a missing line is an error, never a default.
        const need = (label: string, pattern: RegExp): RegExpMatchArray => {
            const match = stdout.match(pattern);
            if (!match) {
                throw new SbArchiTelemetryParseError(label);
            }
            return match;
        };
        const num = (label: string, pattern: RegExp) => parseFloat(need(label, pattern)[1]);
        const int = (label: string, pattern: RegExp) => parseInt(need(label, pattern)[1], 10);
        const str = (pattern: RegExp) => stdout.match(pattern)?.[1].trim();

        const inversion = need('Inversion', /Inversion:\s*(ran|not run: .+)/)[1].trim();
        const inversionRan = inversion === 'ran';
        const telemetry: SbArchiTelemetry = {
            targetStructure: str(/Target Structure:\s*(.+)/),
            sectionMode: str(/Section Mode:\s*(.+)/),
            pbrMode: str(/PBR Material:\s*(.+)/),
            inversionRan,
            synthesizedVertices: int('Manifold Vertices', /Manifold Vertices:\s*(\d+)/),
            synthesizedTriangles: int('Manifold Triangles', /Manifold Triangles:\s*(\d+)/),
            modelSynthesisRuntimeMs: num('Model Synthesis Runtime', /Model Synthesis Runtime:\s*([-\d.e]+)/)
        };
        if (inversionRan) {
            telemetry.scanPointsFitted = int('Scan Points Fitted', /Scan Points Fitted:\s*(\d+)/);
            telemetry.initialChamferMeters = num('Initial Scan Chamfer Distance', /Initial Scan Chamfer Distance:\s*([-\d.e]+)/);
            telemetry.fittedChamferMeters = num('Fitted Manifold Chamfer Distance', /Fitted Manifold Chamfer Distance:\s*([-\d.e]+)/);
            telemetry.chamferReductionPct = num('Chamfer Error Reduction', /Chamfer Error Reduction:\s*([-\d.e]+)/);
            telemetry.inversionConverged = need('Inversion Converged', /Inversion Converged:\s*(yes|no)/)[1] === 'yes';
            telemetry.optimizerRuntimeMs = num('Inversion Solver Runtime', /Inversion Solver Runtime:\s*([-\d.e]+)/);
        } else {
            telemetry.inversionSkipReason = inversion.replace(/^not run:\s*/, '');
        }
        return telemetry;
    }

    /**
     * Ensures the native C++20 Arch of Constantine tectonic synthesizer binary is compiled.
     */
    async ensureArchConstantineBinary(): Promise<string> {
        const candidateSources = [
            path.resolve(process.cwd(), 'scripts/run_arch_constantine.cpp'),
            path.resolve(__dirname, '../../../../scripts/run_arch_constantine.cpp')
        ];
        const sourcePath = candidateSources.find(p => fs.existsSync(p)) || candidateSources[0];
        return buildNativeIfStale({ source: sourcePath, binary: this.archConstantineBinaryPath, includeDir: this.compiler.getSdkIncludePath() });
    }

    /**
     * Synthesizes the monumental Arch of Constantine into a watertight, hollow classical monument.
     */
    async buildArchConstantine(options: ArchConstantineOptions = {}): Promise<ArchConstantineResult> {
        const bin = await this.ensureArchConstantineBinary();

        const defaultOutput = path.resolve(process.cwd(), 'public/models/arch_constantine_sb_archi.glb');
        const outputGlb = options.outputGlbPath || defaultOutput;

        const cmd = `"${bin}" --output-glb "${outputGlb}"`;
        const { stdout } = await execAsync(cmd);

        const report = this.parseTectonicReport(stdout);

        return {
            success: true,
            glbPath: outputGlb,
            glbDownloadUrl: `/arch_constantine_sb_archi.glb`,
            worldPosition: [-139.62, 31.5, -45.28],
            worldRotationYawRad: 0.29025, // 16.63 degrees
            nominalDimensions: [25.7, 21.0, 7.4],
            report
        };
    }

    private parseTectonicReport(stdout: string): TectonicAnalysisReport {
        // Every field comes from the binary's report; a missing one is an error, never a default.
        const need = (label: string, pattern: RegExp): RegExpMatchArray => {
            const match = stdout.match(pattern);
            if (!match) {
                throw new TectonicReportParseError(label);
            }
            return match;
        };
        const num = (label: string, pattern: RegExp) => parseFloat(need(label, pattern)[1]);
        const int = (label: string, pattern: RegExp) => parseInt(need(label, pattern)[1], 10);

        const center = need('Footprint Center', /Footprint Center:\s*\(([-\d.e]+),\s*([-\d.e]+),\s*([-\d.e]+)\)/);
        const footprintCenter: [number, number, number] = [parseFloat(center[1]), parseFloat(center[2]), parseFloat(center[3])];
        const majorDim = num('Footprint Major Dimension', /Footprint Major Dimension:\s*([\d.e]+)/);
        const minorDim = num('Footprint Minor Dimension', /Footprint Minor Dimension:\s*([\d.e]+)/);
        const totalHeight = num('Structure Total Height', /Structure Total Height:\s*([\d.e]+)/);

        return {
            footprintCenter,
            footprintDimensions: [majorDim, totalHeight, minorDim],
            totalHeight,
            detectedDatumsCount: int('Detected Datums', /Detected Datums:\s*(\d+)/),
            synthesizedVertices: int('Synthesized Vertices', /Synthesized Vertices:\s*(\d+)/),
            synthesizedTriangles: int('Synthesized Triangles', /Synthesized Triangles:\s*(\d+)/),
            runtimeMs: num('Synthesis Runtime', /Synthesis Runtime:\s*([\d.e]+)/)
        };
    }
}

