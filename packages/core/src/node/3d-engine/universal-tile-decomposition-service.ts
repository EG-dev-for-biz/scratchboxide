/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * U.S. PATENT APPLICATION NO. 64/168,583 (PATENT PENDING)
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC and Elias John Green. Unauthorized copying, modification,
 * distribution, or use of this file, via any medium, is strictly prohibited
 * without explicit written permission.
 ********************************************************************************/

import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { NativeCppCompilerService } from './native-compiler-service';

const execAsync = promisify(exec);

export type GeographicDomain =
    | 'UrbanHighRiseCore'
    | 'SuburbanResidential'
    | 'IndustrialLogisticsPort'
    | 'CivilInfrastructure'
    | 'MountainAlpineCanyon'
    | 'ForestWoodlandCanopy'
    | 'AquaticCoastalFluvial'
    | 'AridDesertBadlands'
    | 'HybridInterface';

export type UtdraPipelineMode = 'full' | 'probe' | 'slicer' | 'bridge' | 'terrain';
export type UtdraBenchmarkType = 'urban' | 'suburban' | 'bridge' | 'mountain' | 'forest' | 'slicer' | 'hybrid';

export interface UtdraServiceOptions {
    inputGlbPath?: string;
    outputGlbPath?: string;
    mode?: UtdraPipelineMode;
    benchmark?: UtdraBenchmarkType;
    anchorCoord?: {
        latitude: number;
        longitude: number;
        altitudeMeters?: number;
    };
    sliceElevationCutoff?: number;
    minVoidHeightMeters?: number;
    streamStdout?: boolean;
}

export interface UtdraTelemetry {
    dominantDomain: GeographicDomain;
    confidence: number;
    totalReliefDeltaY: number;
    planarityScore: number;
    verticalityScore: number;
    vegetationIndexNdvi: number;
    pitchedRoofRatio: number;
    waterSurfaceRatio: number;
    underpassVoidRatio: number;
    dominantStreetYawDeg: number;
    inputTriangles: number;
    outputTriangles: number;
    processingTimeMs: number;
}

export interface UtdraResult {
    success: boolean;
    mode: UtdraPipelineMode;
    outputGlbPath: string;
    glbBuffer?: Buffer;
    glbBase64?: string;
    telemetry: UtdraTelemetry;
    stdout: string;
    stderr?: string;
}

/**
 * Service exposing the Universal Tile Decomposition & Rectification Algorithm (UTDRA / ULDRA).
 *
 * Core Capabilities:
 * - Macro-Domain Telemetry & Ingestion Classification across 9 Canonical Geographic Domains
 * - Sutherland-Hodgman Non-Destructive Triangle-Plane Elevation Slicing
 * - Multi-Level Bridge, Viaduct, & Flyover Void Underpass Clearance
 * - Slope-Stratified Natural Biomes (Bedrock Triplanar, Talus Scree, Alpine Turf)
 * - Cohesive Hybrid Decomposition: Rectified Extruded Shafts & Preserved Sculptural Crowns
 */
export class UniversalTileDecompositionService {
    private compiler: NativeCppCompilerService;
    private binaryPath: string;

    constructor(compiler?: NativeCppCompilerService) {
        this.compiler = compiler || new NativeCppCompilerService();
        const candidateBinaries = [
            path.resolve(process.cwd(), 'build/run_utdra_pipeline'),
            path.resolve(__dirname, '../../../../build/run_utdra_pipeline'),
            path.resolve(process.cwd(), 'scripts/run_utdra_pipeline'),
            path.resolve(__dirname, '../../../../scripts/run_utdra_pipeline'),
            path.resolve(process.cwd(), 'build/3d-native/run_utdra_pipeline'),
            path.resolve(__dirname, '../../../../build/3d-native/run_utdra_pipeline')
        ];
        this.binaryPath = candidateBinaries.find(p => fs.existsSync(p)) || candidateBinaries[0];
    }

    /**
     * Ensures the native C++20 UTDRA pipeline binary is compiled and available.
     */
    async ensureBinary(): Promise<string> {
        if (fs.existsSync(this.binaryPath)) {
            return this.binaryPath;
        }

        const candidateSources = [
            path.resolve(process.cwd(), 'scripts/run_utdra_pipeline.cpp'),
            path.resolve(__dirname, '../../../../scripts/run_utdra_pipeline.cpp'),
            path.resolve(__dirname, '../../../scripts/run_utdra_pipeline.cpp'),
            path.resolve(process.cwd(), 'packages/core/scripts/run_utdra_pipeline.cpp')
        ];
        const sourcePath = candidateSources.find(p => fs.existsSync(p)) || candidateSources[0];
        const includePath = this.compiler.getSdkIncludePath();
        const outputDir = path.dirname(this.binaryPath);

        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        const cxx = process.env.CXX || 'clang++';
        const archFlag = process.env.SCRATCHBOX_NATIVE_ARCH === '1' ? '-march=native' : '';
        const compileCmd = `${cxx} -std=c++20 -O3 ${archFlag} -I "${includePath}" "${sourcePath}" -o "${this.binaryPath}"`.replace(/\s+/g, ' ');
        await execAsync(compileCmd);
        return this.binaryPath;
    }

    /**
     * Decomposes and rectifies a 3D geographic tile or synthetic benchmark.
     */
    async decomposeTile(options: UtdraServiceOptions = {}): Promise<UtdraResult> {
        const bin = await this.ensureBinary();
        const artifactsDir = path.resolve(process.cwd(), '.scratchbox', 'artifacts');
        if (!fs.existsSync(artifactsDir)) {
            fs.mkdirSync(artifactsDir, { recursive: true });
        }
        const tmpOutput = options.outputGlbPath || path.join(artifactsDir, `utdra_${Date.now()}.glb`);
        const mode = options.mode ?? 'full';

        const args: string[] = [
            `--output "${tmpOutput}"`,
            `--mode ${mode}`
        ];

        if (options.inputGlbPath) {
            args.push(`--input "${options.inputGlbPath}"`);
        }
        if (options.benchmark) {
            args.push(`--benchmark ${options.benchmark}`);
        }
        if (options.sliceElevationCutoff !== undefined) {
            args.push(`--sliceY ${options.sliceElevationCutoff}`);
        }
        if (options.minVoidHeightMeters !== undefined) {
            args.push(`--minVoidHeight ${options.minVoidHeightMeters}`);
        }
        if (options.anchorCoord) {
            args.push(`--lat ${options.anchorCoord.latitude}`);
            args.push(`--lon ${options.anchorCoord.longitude}`);
        }

        const cmd = `"${bin}" ${args.join(' ')}`;
        const { stdout, stderr } = await execAsync(cmd, { maxBuffer: 1024 * 1024 * 64 });

        // Parse structured [TELEMETRY] tag
        const telemetryMatch = stdout.match(/\[TELEMETRY\]\s+(.+)/);
        const parseTag = (key: string, defaultVal: string): string => {
            if (!telemetryMatch) return defaultVal;
            const reg = new RegExp(`${key}=([^\\s]+)`);
            const m = telemetryMatch[1].match(reg);
            return m ? m[1] : defaultVal;
        };

        const dominantDomain = parseTag('DOMAIN', 'HybridInterface') as GeographicDomain;
        const confidence = parseFloat(parseTag('CONFIDENCE', '1.0'));
        const totalReliefDeltaY = parseFloat(parseTag('RELIEF', '0.0'));
        const planarityScore = parseFloat(parseTag('PLANARITY', '1.0'));
        const verticalityScore = parseFloat(parseTag('VERTICALITY', '0.0'));
        const vegetationIndexNdvi = parseFloat(parseTag('VEG_NDVI', '0.0'));
        const pitchedRoofRatio = parseFloat(parseTag('PITCHED_ROOF', '0.0'));
        const waterSurfaceRatio = parseFloat(parseTag('WATER', '0.0'));
        const underpassVoidRatio = parseFloat(parseTag('VOID', '0.0'));
        const dominantStreetYawDeg = parseFloat(parseTag('YAW', '0.0'));
        const inputTriangles = parseInt(parseTag('INPUT_TRIS', '0'), 10);
        const outputTriangles = parseInt(parseTag('OUTPUT_TRIS', '0'), 10);
        const processingTimeMs = parseFloat(parseTag('RUNTIME_MS', '0.0'));

        const telemetry: UtdraTelemetry = {
            dominantDomain,
            confidence,
            totalReliefDeltaY,
            planarityScore,
            verticalityScore,
            vegetationIndexNdvi,
            pitchedRoofRatio,
            waterSurfaceRatio,
            underpassVoidRatio,
            dominantStreetYawDeg,
            inputTriangles,
            outputTriangles,
            processingTimeMs
        };

        let glbBuffer: Buffer | undefined;
        let glbBase64: string | undefined;

        if (fs.existsSync(tmpOutput)) {
            glbBuffer = fs.readFileSync(tmpOutput);
            glbBase64 = glbBuffer.toString('base64');
        }

        return {
            success: true,
            mode,
            outputGlbPath: tmpOutput,
            glbBuffer,
            glbBase64,
            telemetry,
            stdout,
            stderr
        };
    }

    /**
     * Probes the macro-domain metrics of a geographic tile without mesh decomposition.
     */
    async probeTile(
        inputGlbPath?: string,
        optionsOrAnchor?: { latitude: number; longitude: number } | Partial<UtdraServiceOptions>
    ): Promise<UtdraTelemetry> {
        let opts: UtdraServiceOptions = {
            ...(inputGlbPath ? { inputGlbPath } : {}),
            mode: 'probe'
        };
        if (optionsOrAnchor) {
            if ('latitude' in optionsOrAnchor && 'longitude' in optionsOrAnchor) {
                opts.anchorCoord = optionsOrAnchor as { latitude: number; longitude: number };
            } else {
                opts = {
                    ...opts,
                    ...(optionsOrAnchor as Partial<UtdraServiceOptions>)
                };
            }
        }
        const result = await this.decomposeTile(opts);
        return result.telemetry;
    }

    /**
     * Carves out false photogrammetric underpass curtain walls beneath bridges, viaducts, and flyovers.
     */
    async carveBridgeUnderpass(
        inputGlbPath?: string,
        options: Partial<UtdraServiceOptions> = {}
    ): Promise<UtdraResult> {
        return this.decomposeTile({
            ...options,
            ...(inputGlbPath ? { inputGlbPath } : {}),
            mode: 'bridge'
        });
    }

    /**
     * Applies non-destructive Sutherland-Hodgman clipping across an elevation plane threshold.
     */
    async sliceElevation(
        inputGlbPath: string | undefined,
        sliceElevationCutoff: number,
        options: Partial<UtdraServiceOptions> = {}
    ): Promise<UtdraResult> {
        return this.decomposeTile({
            ...options,
            ...(inputGlbPath ? { inputGlbPath } : {}),
            mode: 'slicer',
            sliceElevationCutoff
        });
    }

    /**
     * Convenience method to decompose an existing on-disk GLB file.
     */
    async decomposeGlbFile(
        inputGlbPath: string,
        options: Partial<UtdraServiceOptions> = {}
    ): Promise<UtdraResult> {
        return this.decomposeTile({
            ...options,
            inputGlbPath,
            mode: options.mode ?? 'full'
        });
    }
}

/**
 * UTDRA Service alias for UniversalTileDecompositionService.
 */
export const UtdraService = UniversalTileDecompositionService;
export type UtdraService = UniversalTileDecompositionService;

/**
 * ULDRA Service alias for UniversalTileDecompositionService (supporting user request naming).
 */
export const UldraService = UniversalTileDecompositionService;
export type UldraService = UniversalTileDecompositionService;
