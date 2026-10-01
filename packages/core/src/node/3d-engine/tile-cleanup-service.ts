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

export interface PatinaOptions {
    buildingAgeYears?: number;
    sootCavityIntensity?: number;
    rainStreakIntensity?: number;
    copperVerdigrisIntensity?: number;
    edgeAbrasionFactor?: number;
    groundSplashHeightMeters?: number;
    macroQuarryVariance?: number;
    enableRnmBlending?: boolean;
    enableToksvigFiltering?: boolean;
}

export interface BiophysicalPatinaMetrics {
    buildingAgeYears?: number;
    sootCoveragePercent?: number;
    streakDensityPercent?: number;
    verdigrisIntensity?: number;
    rnmBlendingEnabled?: boolean;
    toksvigFilteringEnabled?: boolean;
}

export interface TileCleanupOptions {
    angleThresholdDegrees?: number;
    snapToleranceMeters?: number;
    roadWidthMeters?: number;
    outputGlbPath?: string;
    streamStdout?: boolean;
    textureResolution?: 1024 | 2048;
    patina?: PatinaOptions;
}

export interface SubmeshDetail {
    name: string;
    triangles: number;
}

export interface TextureInformedCues {
    facadeAlbedoRgb?: [number, number, number];
    glazingToneRgb?: [number, number, number];
    windowToWallRatioPercent?: number;
    detectedFloorHeightMeters?: number;
    detectedBayWidthMeters?: number;
    embeddedPbrTextureCount?: number;
    partitionedSubmeshCount?: number;
    totalEmbeddedMapsCount?: number;
    submeshDetails?: SubmeshDetail[];
}

export interface TileCleanupMetrics {
    rawTriangles: number;
    rawVertices: number;
    decimatedTriangles: number;
    polygonReductionPercent: number;
    facadeTriangles: number;
    rooftopTriangles: number;
    groundTriangles: number;
    treeAnchorsCount: number;
    rooftopGreeblesCount: number;
    roadTriangles: number;
    processingTimeMs: number;
    textureInformedCues?: TextureInformedCues;
    biophysicalPatina?: BiophysicalPatinaMetrics;
}

export interface TileCleanupResult {
    success: boolean;
    glbBuffer?: Buffer;
    glbBase64?: string;
    metrics: TileCleanupMetrics;
    stdout: string;
    stderr?: string;
}

export class PhotorealTileCleanupService {
    private compiler: NativeCppCompilerService;
    private binaryPath: string;

    constructor(compiler?: NativeCppCompilerService) {
        this.compiler = compiler || new NativeCppCompilerService();
        // Look for compiled binary in scripts or build directory
        const candidateBinaries = [
            path.resolve(process.cwd(), 'scripts/run_tile_cleanup_pipeline'),
            path.resolve(process.cwd(), '../scripts/run_tile_cleanup_pipeline'),
            path.resolve(__dirname, '../../../../../scripts/run_tile_cleanup_pipeline'),
            path.resolve(__dirname, '../../../../scripts/run_tile_cleanup_pipeline'),
            path.resolve(process.cwd(), 'build/3d-native/run_tile_cleanup_pipeline'),
            path.resolve(process.cwd(), '../build/3d-native/run_tile_cleanup_pipeline')
        ];
        this.binaryPath = candidateBinaries.find(p => fs.existsSync(p)) || candidateBinaries[0];
    }

    /**
     * Ensures the native C++20 tile cleanup binary is compiled and up-to-date.
     */
    async ensureBinary(): Promise<string> {
        if (fs.existsSync(this.binaryPath)) {
            return this.binaryPath;
        }

        const candidateSources = [
            path.resolve(process.cwd(), 'scripts/run_tile_cleanup_pipeline.cpp'),
            path.resolve(process.cwd(), '../scripts/run_tile_cleanup_pipeline.cpp'),
            path.resolve(__dirname, '../../../../../scripts/run_tile_cleanup_pipeline.cpp'),
            path.resolve(__dirname, '../../../../scripts/run_tile_cleanup_pipeline.cpp')
        ];
        const sourcePath = candidateSources.find(p => fs.existsSync(p)) || candidateSources[0];
        const includePath = this.compiler.getSdkIncludePath();
        const outputDir = path.dirname(this.binaryPath);

        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        const compileCmd = `clang++ -std=c++20 -O3 -I "${includePath}" "${sourcePath}" -o "${this.binaryPath}"`;
        await execAsync(compileCmd);
        return this.binaryPath;
    }

    /**
     * Executes the Photogrammetry & Tile Cleanup Pipeline.
     * Can run in-app or inside Google Cloud Run instances.
     */
    async cleanPhotogrammetryTile(options: TileCleanupOptions = {}): Promise<TileCleanupResult> {
        const bin = await this.ensureBinary();
        const artifactsDir = path.resolve(process.cwd(), '.scratchbox', 'artifacts');
        if (!fs.existsSync(artifactsDir)) {
            fs.mkdirSync(artifactsDir, { recursive: true });
        }
        const tmpOutput = options.outputGlbPath || path.join(artifactsDir, `cleaned_tile_${Date.now()}.glb`);
        const angle = options.angleThresholdDegrees ?? 4.0;
        const snap = options.snapToleranceMeters ?? 0.85;

        const args = [
            `--output "${tmpOutput}"`,
            `--angle ${angle}`,
            `--snap ${snap}`
        ];

        if (options.textureResolution !== undefined) {
            args.push(`--res ${options.textureResolution}`);
        }
        if (options.patina?.buildingAgeYears !== undefined) {
            args.push(`--age ${options.patina.buildingAgeYears}`);
        }
        if (options.patina?.sootCavityIntensity !== undefined) {
            args.push(`--soot ${options.patina.sootCavityIntensity}`);
        }
        if (options.patina?.rainStreakIntensity !== undefined) {
            args.push(`--streaks ${options.patina.rainStreakIntensity}`);
        }
        if (options.patina?.copperVerdigrisIntensity !== undefined) {
            args.push(`--verdigris ${options.patina.copperVerdigrisIntensity}`);
        }
        if (options.patina?.edgeAbrasionFactor !== undefined) {
            args.push(`--abrasion ${options.patina.edgeAbrasionFactor}`);
        }

        const cmd = `"${bin}" ${args.join(' ')}`;
        const startTime = Date.now();
        const { stdout, stderr } = await execAsync(cmd, {
            maxBuffer: 50 * 1024 * 1024
        });

        // Parse metrics from stdout
        const rawTriMatch = stdout.match(/Raw Triangles:\s+(\d+)/);
        const rawVertMatch = stdout.match(/Raw Vertices:\s+(\d+)/);
        const decTriMatch = stdout.match(/Decimated Triangles:\s+(\d+)/);
        const redPercentMatch = stdout.match(/Polygon Reduction:\s+([\d.]+)%/);
        const facadeTriMatch = stdout.match(/Facade Triangles:\s+(\d+)/);
        const roofTriMatch = stdout.match(/Rooftop Triangles:\s+(\d+)/);
        const groundTriMatch = stdout.match(/Ground Triangles:\s+(\d+)/);
        const treeMatch = stdout.match(/Tree Anchors:\s+(\d+)/);
        const greebleMatch = stdout.match(/Rooftop Greebles:\s+(\d+)/);
        const roadTriMatch = stdout.match(/Road Triangles:\s+(\d+)/);
        const timeMatch = stdout.match(/Processing Time:\s+([\d.]+)\s+ms/);

        // Parse Texture-Informed PBR Cues & Multi-Material Architecture
        const albedoMatch = stdout.match(/Extracted Facade Albedo:\s+RGB\(([\d.]+),\s*([\d.]+),\s*([\d.]+)\)/);
        const glazingMatch = stdout.match(/Extracted Glazing Tone:\s+RGB\(([\d.]+),\s*([\d.]+),\s*([\d.]+)\)/);
        const wwrMatch = stdout.match(/Window-to-Wall Ratio:\s+([\d.]+)%/);
        const floorMatch = stdout.match(/Detected Floor Spacing:\s+([\d.]+)\s+m/);
        const bayMatch = stdout.match(/Detected Bay Spacing:\s+([\d.]+)\s+m/);
        const pbrMapsMatch = stdout.match(/(?:Embedded PBR Textures|Total Embedded Maps):\s+(\d+)\s+(?:maps|PBR texture maps)/);
        const submeshCountMatch = stdout.match(/Partitioned Submeshes:\s+(\d+)\s+semantic submeshes/);

        // Parse submesh items
        const submeshDetails: SubmeshDetail[] = [];
        const submeshRegex = /\[\d+\]\s+([^\s]+)\s+\((\d+)\s+tris\)/g;
        let match: RegExpExecArray | null;
        while ((match = submeshRegex.exec(stdout)) !== null) {
            submeshDetails.push({
                name: match[1],
                triangles: parseInt(match[2], 10)
            });
        }

        const textureInformedCues: TextureInformedCues | undefined = albedoMatch ? {
            facadeAlbedoRgb: [parseFloat(albedoMatch[1]), parseFloat(albedoMatch[2]), parseFloat(albedoMatch[3])],
            glazingToneRgb: glazingMatch ? [parseFloat(glazingMatch[1]), parseFloat(glazingMatch[2]), parseFloat(glazingMatch[3])] : undefined,
            windowToWallRatioPercent: wwrMatch ? parseFloat(wwrMatch[1]) : undefined,
            detectedFloorHeightMeters: floorMatch ? parseFloat(floorMatch[1]) : undefined,
            detectedBayWidthMeters: bayMatch ? parseFloat(bayMatch[1]) : undefined,
            embeddedPbrTextureCount: pbrMapsMatch ? parseInt(pbrMapsMatch[1], 10) : undefined,
            partitionedSubmeshCount: submeshCountMatch ? parseInt(submeshCountMatch[1], 10) : submeshDetails.length,
            totalEmbeddedMapsCount: pbrMapsMatch ? parseInt(pbrMapsMatch[1], 10) : undefined,
            submeshDetails: submeshDetails.length > 0 ? submeshDetails : undefined
        } : undefined;

        // Parse Biophysical Patina & Weathering Telemetry
        const ageMatch = stdout.match(/Building Historical Age:\s+([\d.]+)\s+years/);
        const sootMatch = stdout.match(/Active Cavity Soot:\s+([\d.]+)%\s+coverage/);
        const streakMatch = stdout.match(/Rain Runoff Streaks:\s+([\d.]+)%\s+coverage/);
        const verdigrisMatch = stdout.match(/Bronze Verdigris Index:\s+([\d.]+)/);
        const rnmMatch = stdout.match(/Reoriented Normal \(RNM\):\s+(Enabled|Disabled)/);
        const toksvigMatch = stdout.match(/Toksvig Specular AA:\s+(Enabled|Disabled)/);

        const biophysicalPatina: BiophysicalPatinaMetrics | undefined = sootMatch ? {
            buildingAgeYears: ageMatch ? parseFloat(ageMatch[1]) : undefined,
            sootCoveragePercent: sootMatch ? parseFloat(sootMatch[1]) : undefined,
            streakDensityPercent: streakMatch ? parseFloat(streakMatch[1]) : undefined,
            verdigrisIntensity: verdigrisMatch ? parseFloat(verdigrisMatch[1]) : undefined,
            rnmBlendingEnabled: rnmMatch ? rnmMatch[1] === 'Enabled' : undefined,
            toksvigFilteringEnabled: toksvigMatch ? toksvigMatch[1] === 'Enabled' : undefined
        } : undefined;

        const metrics: TileCleanupMetrics = {
            rawTriangles: rawTriMatch ? parseInt(rawTriMatch[1], 10) : 0,
            rawVertices: rawVertMatch ? parseInt(rawVertMatch[1], 10) : 0,
            decimatedTriangles: decTriMatch ? parseInt(decTriMatch[1], 10) : 0,
            polygonReductionPercent: redPercentMatch ? parseFloat(redPercentMatch[1]) : 0,
            facadeTriangles: facadeTriMatch ? parseInt(facadeTriMatch[1], 10) : 0,
            rooftopTriangles: roofTriMatch ? parseInt(roofTriMatch[1], 10) : 0,
            groundTriangles: groundTriMatch ? parseInt(groundTriMatch[1], 10) : 0,
            treeAnchorsCount: treeMatch ? parseInt(treeMatch[1], 10) : 0,
            rooftopGreeblesCount: greebleMatch ? parseInt(greebleMatch[1], 10) : 0,
            roadTriangles: roadTriMatch ? parseInt(roadTriMatch[1], 10) : 0,
            processingTimeMs: timeMatch ? parseFloat(timeMatch[1]) : (Date.now() - startTime),
            textureInformedCues,
            biophysicalPatina
        };

        let glbBuffer: Buffer | undefined;
        let glbBase64: string | undefined;

        if (fs.existsSync(tmpOutput)) {
            glbBuffer = fs.readFileSync(tmpOutput);
            glbBase64 = glbBuffer.toString('base64');
            // Clean up temporary file if caller did not request a custom output path
            if (!options.outputGlbPath) {
                try { fs.unlinkSync(tmpOutput); } catch {}
            }
        }

        return {
            success: true,
            glbBuffer,
            glbBase64,
            metrics,
            stdout,
            stderr
        };
    }
}
