/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
    PhotorealTileCleanupService,
    NativeCppCompilerService
} from '../src/node';

describe('3D Photogrammetry & Tile Cleanup Pipeline (In-App / Cloud Run)', () => {
    const service = new PhotorealTileCleanupService();

    it('1. should verify native C++20 tile cleanup headers are accessible', () => {
        const compiler = new NativeCppCompilerService();
        const sdkInclude = compiler.getSdkIncludePath();
        expect(fs.existsSync(sdkInclude)).toBe(true);

        const headerPath = path.join(sdkInclude, 'scratchbox_tile_cleanup.hpp');
        expect(fs.existsSync(headerPath)).toBe(true);

        const headerContent = fs.readFileSync(headerPath, 'utf8');
        expect(headerContent).toContain('namespace cleanup');
        expect(headerContent).toContain('class PlanarDecimator');
        expect(headerContent).toContain('class CornerStraightener');
        expect(headerContent).toContain('class TileTextureDeLighter');
        expect(headerContent).toContain('class SemanticMeshSeparator');
        expect(headerContent).toContain('class ElevationConformer');
    });

    it('2. should verify standalone C++ CLI pipeline compiles and runs with high performance', async () => {
        const binPath = await service.ensureBinary();
        expect(fs.existsSync(binPath)).toBe(true);

        const result = await service.cleanPhotogrammetryTile({
            angleThresholdDegrees: 4.0,
            snapToleranceMeters: 0.85,
            roadWidthMeters: 8.0
        });

        expect(result.success).toBe(true);
        expect(result.metrics.rawTriangles).toBeGreaterThan(5000);
        expect(result.metrics.decimatedTriangles).toBeLessThan(result.metrics.rawTriangles);
        // Verify >60% polygon reduction via planar limited dissolve
        expect(result.metrics.polygonReductionPercent).toBeGreaterThan(60.0);
        
        // Verify semantic separation
        expect(result.metrics.facadeTriangles).toBeGreaterThan(0);
        expect(result.metrics.rooftopTriangles).toBeGreaterThan(0);
        expect(result.metrics.groundTriangles).toBeGreaterThan(0);
        expect(result.metrics.roadTriangles).toBeGreaterThan(0);

        // Verify greebles and vegetation blob detection
        expect(result.metrics.treeAnchorsCount).toBeGreaterThanOrEqual(1);
        expect(result.metrics.rooftopGreeblesCount).toBeGreaterThanOrEqual(1);

        // Verify performance (under 3000ms for full multi-material PBR synthesis)
        expect(result.metrics.processingTimeMs).toBeLessThan(3000);

        // Verify valid glTF 2.0 binary output
        expect(result.glbBuffer).toBeDefined();
        expect(result.glbBuffer!.length).toBeGreaterThan(1000);
        const magic = result.glbBuffer!.toString('utf8', 0, 4);
        expect(magic).toBe('glTF');

        expect(result.glbBase64).toBeDefined();
        expect(result.glbBase64!.length).toBeGreaterThan(1000);
    });

    it('3. should support custom threshold parameters for architectural decimation', async () => {
        const resultStrict = await service.cleanPhotogrammetryTile({
            angleThresholdDegrees: 2.0,
            snapToleranceMeters: 0.40
        });

        expect(resultStrict.success).toBe(true);
        expect(resultStrict.metrics.polygonReductionPercent).toBeGreaterThan(25.0);
    });

    it('4. should extract texture-informed cues (albedo, glazing, fenestration) and embed PBR texture maps', async () => {
        const result = await service.cleanPhotogrammetryTile({
            angleThresholdDegrees: 4.0,
            snapToleranceMeters: 0.85
        });

        expect(result.success).toBe(true);
        expect(result.metrics.textureInformedCues).toBeDefined();

        const cues = result.metrics.textureInformedCues!;
        // Verify extracted facade albedo and glazing tone
        expect(cues.facadeAlbedoRgb).toBeDefined();
        expect(cues.facadeAlbedoRgb!.length).toBe(3);
        expect(cues.facadeAlbedoRgb![0]).toBeGreaterThan(0.0);
        expect(cues.facadeAlbedoRgb![0]).toBeLessThanOrEqual(1.0);

        expect(cues.glazingToneRgb).toBeDefined();
        expect(cues.glazingToneRgb!.length).toBe(3);
        expect(cues.windowToWallRatioPercent).toBeGreaterThan(15.0);
        expect(cues.detectedFloorHeightMeters).toBeCloseTo(3.6, 1);
        expect(cues.detectedBayWidthMeters).toBeCloseTo(2.5, 1);

        // Verify 24 PBR texture maps (6 materials x 4 maps) are embedded
        expect(cues.embeddedPbrTextureCount).toBe(24);
        expect(result.glbBuffer).toBeDefined();
        // Since GLB embeds 24 PNGs (each 1024x1024), buffer size should exceed 10 MB
        expect(result.glbBuffer!.length).toBeGreaterThan(10 * 1024 * 1024);
    });

    it('5. should synthesize multi-layer biophysical patina (cavity soot, rain streaks, verdigris, RNM, Toksvig AA)', async () => {
        const result = await service.cleanPhotogrammetryTile({
            angleThresholdDegrees: 4.0,
            snapToleranceMeters: 0.85,
            patina: {
                buildingAgeYears: 90,
                sootCavityIntensity: 0.85,
                rainStreakIntensity: 0.78,
                copperVerdigrisIntensity: 0.65,
                edgeAbrasionFactor: 0.55
            }
        });

        expect(result.success).toBe(true);
        expect(result.metrics.biophysicalPatina).toBeDefined();
        expect(result.glbBuffer).toBeDefined();
        expect(result.glbBuffer!.length).toBeGreaterThan(10 * 1024 * 1024);
    });

    it('6. should synthesize multi-material architectural submeshes and rich micro-textures', async () => {
        const result = await service.cleanPhotogrammetryTile({
            angleThresholdDegrees: 4.0,
            snapToleranceMeters: 0.85,
            textureResolution: 1024
        });

        expect(result.success).toBe(true);
        const cues = result.metrics.textureInformedCues;
        expect(cues).toBeDefined();

        // Verify 6 semantic architectural submeshes partitioned
        expect(cues!.partitionedSubmeshCount).toBe(6);
        expect(cues!.submeshDetails).toBeDefined();
        expect(cues!.submeshDetails!.length).toBe(6);

        const submeshNames = cues!.submeshDetails!.map(s => s.name);
        expect(submeshNames).toContain('submesh_limestone_facade');
        expect(submeshNames).toContain('submesh_bronze_spandrels');
        expect(submeshNames).toContain('submesh_stainless_steel');
        expect(submeshNames).toContain('submesh_granite_plinth');
        expect(submeshNames).toContain('submesh_terrace_bitumen');
        expect(submeshNames).toContain('submesh_streetscape');

        // Verify all 24 PBR texture maps (6 materials x 4 maps)
        expect(cues!.totalEmbeddedMapsCount).toBe(24);
        expect(result.glbBuffer).toBeDefined();
        expect(result.glbBuffer!.length).toBeGreaterThan(10 * 1024 * 1024);
    });
});
