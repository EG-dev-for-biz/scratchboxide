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

export type TileStyle =
    | 'SolarpunkCitadel'
    | 'NeoclassicalMonument'
    | 'BrutalistFortress'
    | 'GothicCathedral'
    | 'SciFiOutpost'
    | 'Custom';

export type RestructureMaterialMode =
    | 'stylized_pbr'
    | 'studio_clay'
    | 'hybrid_photogrammetric';

export interface TerraformingOp {
    type: 'terrace' | 'plateau_level' | 'crater_basin' | 'trench_moat' | 'ridge_ramp';
    center?: [number, number, number];
    radius?: number;
    targetElevation?: number;
    stepHeight?: number;
    stepCount?: number;
    depth?: number;
    blendRadius?: number;
}

export interface PrimitiveGraft {
    type: 'obelisk' | 'column_colonnade' | 'dome' | 'gothic_portal' | 'stepped_pyramid' | 'pylon_gate' | 'buttress';
    position?: [number, number, number];
    scale?: [number, number, number];
    rotationYDeg?: number;
    count?: number;
    radius?: number;
    anchor?: 'custom' | 'corners' | 'apex' | 'plaza' | 'center' | 'perimeter' | 'entrance';
    adaptToTerrain?: boolean;
}

export interface TileRestructureConfig {
    style?: TileStyle;
    materialMode?: RestructureMaterialMode;
    clayPreset?: string;
    terraforming: TerraformingOp[];
    primitives: PrimitiveGraft[];
    weldEpsilon?: number;
    computeCurvature?: boolean;
}

export interface TileRestructureTelemetry {
    status: string;
    inputVertices: number;
    outputVertices: number;
    inputTriangles: number;
    outputTriangles: number;
    inputVertexCount: number;
    outputVertexCount: number;
    inputTriangleCount: number;
    outputTriangleCount: number;
    terraformingOpsApplied: number;
    primitivesGrafted: number;
    reliefDeltaY: number;
    processingTimeMs: number;
    executionTimeMs: number;
    cleanManifold: boolean;
    style: string;
}

export interface TileRestructureOptions {
    inputGlbPath?: string;
    inputGlbBuffer?: Buffer;
    outputGlbPath?: string;
    benchmark?: 'hillside_monument' | 'city_district';
    prompt?: string;
    config?: TileRestructureConfig;
    materialMode?: RestructureMaterialMode;
    clayPreset?: string;
    streamStdout?: boolean;
}

export interface TileRestructureResult {
    success: boolean;
    outputGlbPath: string;
    glbPath: string;
    glbBuffer?: Buffer;
    glbBase64?: string;
    telemetry: TileRestructureTelemetry;
    configApplied: TileRestructureConfig;
    stdout: string;
    stderr?: string;
}

/**
 * Service exposing Tier 1 Native C++20 3D Tile Terraforming & Primitive Restructuring.
 *
 * Core Capabilities:
 * - Natural language prompt parsing into architectural terraforming & primitive placement AST
 * - Topographical macro-feature analysis (Apex, Center Plaza, Basins, Perimeter Corners)
 * - Analytical terraforming (Terracing, Plateau leveling, Crater excavation, Moat carving)
 * - Foundation-conformal primitive grafting (Obelisks, Colonnades, Domes, Pyramids, Portals)
 * - Material pipeline (Stylized PBR, Studio Grey Clay, Hybrid photogrammetric)
 * - Fast zero-dependency binary glTF 2.0 (.glb) streaming
 */
export class NativeTileRestructurerService {
    private static defaultInstance?: NativeTileRestructurerService;
    static getDefault(): NativeTileRestructurerService {
        if (!NativeTileRestructurerService.defaultInstance) {
            NativeTileRestructurerService.defaultInstance = new NativeTileRestructurerService();
        }
        return NativeTileRestructurerService.defaultInstance;
    }

    static parsePromptToConfig(prompt: string): TileRestructureConfig {
        return NativeTileRestructurerService.getDefault().parsePromptToConfig(prompt);
    }

    static async restructureTile(options: TileRestructureOptions): Promise<TileRestructureResult> {
        return NativeTileRestructurerService.getDefault().restructureTile(options);
    }

    private compiler: NativeCppCompilerService;
    private binaryPath: string;

    constructor(compiler?: NativeCppCompilerService) {
        this.compiler = compiler || new NativeCppCompilerService();
        const candidateBinaries = [
            path.resolve(process.cwd(), 'build/3d-native/run_tile_restructuring_pipeline'),
            path.resolve(process.cwd(), 'build/run_tile_restructuring_pipeline'),
            path.resolve(__dirname, '../../../../build/3d-native/run_tile_restructuring_pipeline')
        ];
        this.binaryPath = candidateBinaries.find(p => fs.existsSync(p)) || candidateBinaries[0];
    }

    /**
     * Ensures the native C++20 tile restructuring binary is compiled and available.
     */
    async ensureBinary(): Promise<string> {
        if (fs.existsSync(this.binaryPath)) {
            return this.binaryPath;
        }

        const sourcePath = path.resolve(process.cwd(), 'scripts/run_tile_restructuring_pipeline.cpp');
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
     * Maps a natural language prompt into a structured TileRestructureConfig.
     */
    parsePromptToConfig(prompt: string): TileRestructureConfig {
        const lower = (prompt || '').toLowerCase();

        // 1. Detect Architectural / Thematic Style
        let style: TileStyle = 'SolarpunkCitadel';
        if (/brutalist|fortress|bunker|monolith/i.test(lower)) {
            style = 'BrutalistFortress';
        } else if (/neoclassical|roman|colonnade|temple|classical|marble|pantheon/i.test(lower)) {
            style = 'NeoclassicalMonument';
        } else if (/gothic|cathedral|pointed\s*arch|spire/i.test(lower)) {
            style = 'GothicCathedral';
        } else if (/scifi|sci-fi|cyberpunk|colony|outpost/i.test(lower)) {
            style = 'SciFiOutpost';
        }

        // 2. Detect Material Mode
        let materialMode: RestructureMaterialMode = 'stylized_pbr';
        if (/clay|studio\s*grey|massing/i.test(lower)) {
            materialMode = 'studio_clay';
        } else if (/hybrid/i.test(lower)) {
            materialMode = 'hybrid_photogrammetric';
        }

        // 3. Detect Clay Preset
        let clayPreset = 'ArchitecturalWhite';
        if (/sandstone/i.test(lower)) clayPreset = 'Sandstone';
        else if (/terracotta/i.test(lower)) clayPreset = 'WarmTerracotta';
        else if (/concrete|brutalist/i.test(lower)) clayPreset = 'ConcreteBrutalist';
        else if (/slate/i.test(lower)) clayPreset = 'SlateGrey';

        const terraforming: TerraformingOp[] = [];
        const primitives: PrimitiveGraft[] = [];

        // 4. Terraforming extraction
        // 4a. Terraces
        if (/terrace|stepped\s*tier/i.test(lower)) {
            const stepMatch = lower.match(/(\d+)\s*(?:steps|tiers|stepped\s*tiers)/i);
            const stepCount = stepMatch ? parseInt(stepMatch[1], 10) : 3;
            terraforming.push({
                type: 'terrace',
                stepHeight: 2.8,
                stepCount
            });
        }

        // 4b. Plateau leveling / plaza
        if (/level|flatten|plaza|courtyard/i.test(lower)) {
            const elevMatch = lower.match(/(?:at\s*elevation|height|elevation)\s*(\d+(?:\.\d+)?)\s*m?/i);
            const targetElevation = elevMatch ? parseFloat(elevMatch[1]) : 8.0;
            terraforming.push({
                type: 'plateau_level',
                radius: 14.0,
                targetElevation,
                blendRadius: 4.0
            });
        }

        // 4c. Trench / Moat
        if (/moat|trench|canal/i.test(lower)) {
            terraforming.push({
                type: 'trench_moat',
                radius: 20.0,
                depth: 4.0
            });
        }

        // 4d. Crater / Sunken Basin
        if (/crater|basin|sunken/i.test(lower)) {
            terraforming.push({
                type: 'crater_basin',
                radius: 16.0,
                depth: 5.0
            });
        }

        // 5. Primitive Placement extraction
        // 5a. Obelisks
        if (/obelisk|spire/i.test(lower)) {
            const countMatch = lower.match(/(\d+)\s*(?:solar\s*)?(?:obelisks|spires)/i);
            const count = countMatch ? parseInt(countMatch[1], 10) : 4;
            const anchor = /corner/i.test(lower) ? 'corners' : 'perimeter';
            primitives.push({
                type: 'obelisk',
                count,
                scale: [1, 1, 1],
                anchor,
                adaptToTerrain: true
            });
        }

        // 5b. Dome / Bio-dome
        if (/dome|bio-dome/i.test(lower)) {
            const anchor = /apex|peak|summit/i.test(lower) ? 'apex' : 'center';
            primitives.push({
                type: 'dome',
                radius: 6.0,
                scale: [1, 1, 1],
                anchor,
                adaptToTerrain: true
            });
        }

        // 5c. Colonnade / Columns / Pylons
        if (/column|colonnade|pillar|pylon/i.test(lower)) {
            const countMatch = lower.match(/(\d+)\s*(?:heavy\s*)?(?:monolith\s*)?(?:pylons|columns|pillars)/i);
            const count = countMatch ? parseInt(countMatch[1], 10) : 6;
            const isPylon = /pylon|monolith/i.test(lower);
            primitives.push({
                type: isPylon ? 'pylon_gate' : 'column_colonnade',
                count,
                radius: 5.0,
                scale: [1, 1, 1],
                anchor: 'plaza',
                adaptToTerrain: true
            });
        }

        // 5d. Stepped Pyramid / Ziggurat
        if (/pyramid|ziggurat/i.test(lower)) {
            primitives.push({
                type: 'stepped_pyramid',
                scale: [12, 3, 12],
                anchor: 'center',
                adaptToTerrain: true
            });
        }

        // 5e. Gothic Portal / Entrance Gate
        if (/portal|archway|gateway/i.test(lower)) {
            primitives.push({
                type: 'gothic_portal',
                scale: [1, 1, 1],
                anchor: 'entrance',
                adaptToTerrain: true
            });
        }

        return {
            style,
            materialMode,
            clayPreset,
            terraforming,
            primitives,
            computeCurvature: true
        };
    }

    /**
     * Executes tile restructuring pipeline via native C++20 binary.
     */
    async restructureTile(options: TileRestructureOptions): Promise<TileRestructureResult> {
        const bin = await this.ensureBinary();

        // Derive configuration
        let effectiveConfig: TileRestructureConfig;
        if (options.config) {
            effectiveConfig = { ...options.config };
        } else if (options.prompt) {
            effectiveConfig = this.parsePromptToConfig(options.prompt);
        } else {
            effectiveConfig = {
                style: 'SolarpunkCitadel',
                materialMode: options.materialMode || 'stylized_pbr',
                clayPreset: options.clayPreset || 'ArchitecturalWhite',
                terraforming: [{ type: 'terrace', stepHeight: 3.0, stepCount: 3 }],
                primitives: [{ type: 'obelisk', count: 4, anchor: 'corners' }]
            };
        }

        if (options.materialMode) {
            effectiveConfig.materialMode = options.materialMode;
        }
        if (options.clayPreset) {
            effectiveConfig.clayPreset = options.clayPreset;
        }

        // Prepare output path
        const artifactsDir = path.resolve(process.cwd(), 'build/3d-native');
        if (!fs.existsSync(artifactsDir)) {
            fs.mkdirSync(artifactsDir, { recursive: true });
        }

        const tmpOutput = options.outputGlbPath || path.join(artifactsDir, `restructured_tile_${Date.now()}.glb`);

        // Prepare temporary input file if buffer was passed
        let temporaryInputPath = options.inputGlbPath;
        let createdTempInput = false;
        if (!temporaryInputPath && options.inputGlbBuffer) {
            temporaryInputPath = path.join(artifactsDir, `tmp_tile_input_${Date.now()}.glb`);
            fs.writeFileSync(temporaryInputPath, options.inputGlbBuffer);
            createdTempInput = true;
        }

        const configJson = JSON.stringify(effectiveConfig);

        const args: string[] = [
            `--output "${tmpOutput}"`,
            `--configJson '${configJson.replace(/'/g, "\\'")}'`
        ];

        if (temporaryInputPath && fs.existsSync(temporaryInputPath)) {
            args.push(`--input "${temporaryInputPath}"`);
        } else if (options.benchmark) {
            args.push(`--benchmark ${options.benchmark}`);
        } else {
            args.push(`--benchmark hillside_monument`);
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

            const processingTimeMs = parseFloat(parseVal('processingTimeMs', '0'));
            const inputVertices = parseInt(parseVal('inputVertices', '0'), 10);
            const outputVertices = parseInt(parseVal('outputVertices', '0'), 10);
            const inputTriangles = parseInt(parseVal('inputTriangles', '0'), 10);
            const outputTriangles = parseInt(parseVal('outputTriangles', '0'), 10);
            const terraformingOpsApplied = parseInt(parseVal('terraformingOpsApplied', `${effectiveConfig.terraforming.length}`), 10);
            const primitivesGrafted = parseInt(parseVal('primitivesGrafted', '0'), 10);

            const telemetry: TileRestructureTelemetry = {
                status: parseVal('status', 'success'),
                inputVertices,
                outputVertices,
                inputTriangles,
                outputTriangles,
                inputVertexCount: inputVertices,
                outputVertexCount: outputVertices,
                inputTriangleCount: inputTriangles,
                outputTriangleCount: outputTriangles,
                terraformingOpsApplied,
                primitivesGrafted,
                reliefDeltaY: parseFloat(parseVal('reliefDeltaY', '0')),
                processingTimeMs,
                executionTimeMs: processingTimeMs,
                cleanManifold: parseVal('cleanManifold', 'true') === 'true',
                style: parseVal('style', effectiveConfig.style || 'SolarpunkCitadel')
            };

            let glbBuffer: Buffer | undefined;
            let glbBase64: string | undefined;

            if (fs.existsSync(tmpOutput)) {
                glbBuffer = fs.readFileSync(tmpOutput);
                glbBase64 = glbBuffer.toString('base64');
            }

            return {
                success: true,
                outputGlbPath: tmpOutput,
                glbPath: tmpOutput,
                glbBuffer,
                glbBase64,
                telemetry,
                configApplied: effectiveConfig,
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

export const TileRestructurerService = NativeTileRestructurerService;
export type TileRestructurerService = NativeTileRestructurerService;

export async function restructureTileMesh(options: TileRestructureOptions): Promise<TileRestructureResult> {
    return NativeTileRestructurerService.getDefault().restructureTile(options);
}
