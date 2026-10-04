/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import { ProceduralAstGuard } from '../src/node/3d-engine/ProceduralAstGuard';
import { Procedural3DEngineService } from '../src/node/3d-engine/Procedural3DEngineService';
import { HeadlessSnapshotCriticService } from '../src/node/3d-engine/HeadlessSnapshotCriticService';
import * as path from 'path';

describe('5-Layer Autonomous AI-Native 3D Engine & Procedural DSL', () => {

    describe('Layer 1: Static AST Guard & Physical Parameter Audits', () => {
        it('should allow valid canonical procedural DSL scripts', () => {
            const canonicalScript = `
import scratchbox as sb

world = sb.World(seed=1337, units="meters")
terrain = world.add_terrain(
    extents=(250.0, 250.0),
    archetype="alpine_karst",
    domain_warp_scale=1.85,
    hydraulic_erosion_steps=35
)
temple = world.add_structure(
    archetype="roman_peripteral",
    order=sb.RomanOrder.Corinthian,
    footprint_length=42.0,
    footprint_width=24.0,
    column_count_x=8,
    column_count_y=14
).align_to_terrain(terrain, offset_z=0.2)
redwoods = sb.nature.PlantPreset.create_hero_redwood(height=28.0)
world.scatter(
    asset=redwoods,
    surface=terrain,
    count=60,
    cluster_radius=12.0,
    slope_limit_degrees=28.0,
    avoid_structures=[temple]
)
glb_bytes = world.compile_to_glb(pbr_quality="high")
`;
            const result = ProceduralAstGuard.auditScript(canonicalScript);
            expect(result.valid).toBe(true);
            expect(result.violations).toHaveLength(0);
        });

        it('should block dangerous operations and forbidden modules', () => {
            const maliciousScript = `
import scratchbox as sb
import os
os.system("rm -rf /")
world = sb.World()
`;
            const result = ProceduralAstGuard.auditScript(maliciousScript);
            expect(result.valid).toBe(false);
            expect(result.violations.some(v => v.includes('Forbidden operation') || v.includes('Forbidden import'))).toBe(true);
        });

        it('should reject physical scale violations (excessive terrain extent > 5000m)', () => {
            const invalidScript = `
import scratchbox as sb
world = sb.World()
terrain = world.add_terrain(extents=(6000.0, 6000.0))
`;
            const result = ProceduralAstGuard.auditScript(invalidScript);
            expect(result.valid).toBe(false);
            expect(result.violations.some(v => v.includes('Terrain extent'))).toBe(true);
        });

        it('should reject building height violations (< 3m or > 800m)', () => {
            const invalidScript = `
import scratchbox as sb
world = sb.World()
temple = world.add_structure(column_height=950.0)
`;
            const result = ProceduralAstGuard.auditScript(invalidScript);
            expect(result.valid).toBe(false);
            expect(result.violations.some(v => v.includes('exceeds maximum'))).toBe(true);
        });

        it('should extract dynamic UI slider parameters for Layer 5 Generative Canvas', () => {
            const script = `
import scratchbox as sb
world = sb.World(seed=1337)
terrain = world.add_terrain(extents=(250.0, 250.0), domain_warp_scale=1.85, hydraulic_erosion_steps=35)
temple = world.add_structure(footprint_length=42.0, column_count_x=8)
`;
            const result = ProceduralAstGuard.auditScript(script);
            expect(result.valid).toBe(true);
            expect(result.parameters.length).toBeGreaterThanOrEqual(4);
            const paramNames = result.parameters.map(p => p.name);
            expect(paramNames).toContain('seed');
            expect(paramNames).toContain('domain_warp_scale');
            expect(paramNames).toContain('hydraulic_erosion_steps');
            expect(paramNames).toContain('footprint_length');
        });
    });

    describe('Layer 2 & 3: High-Level Python DSL Execution & Pre-compiled C++20 Invariant Kernel', () => {
        const engineService = new Procedural3DEngineService();

        it('should execute canonical procedural DSL and stream valid glTF 2.0 binary chunk directly into RAM', async () => {
            const testScript = `
import scratchbox as sb

world = sb.World(seed=1337, units="meters")

terrain = world.add_terrain(
    extents=(120.0, 120.0),
    archetype="alpine_karst",
    domain_warp_scale=1.85,
    hydraulic_erosion_steps=20
)

temple = world.add_structure(
    archetype="roman_peripteral",
    order=sb.RomanOrder.Corinthian,
    footprint_length=36.0,
    footprint_width=20.0,
    column_count_x=6,
    column_count_y=10
).align_to_terrain(terrain, offset_z=0.2)

redwoods = sb.nature.PlantPreset.create_hero_redwood(height=24.0)
world.scatter(
    asset=redwoods,
    surface=terrain,
    count=25,
    cluster_radius=10.0,
    slope_limit_degrees=28.0,
    avoid_structures=[temple]
)

glb_bytes = world.compile_to_glb(pbr_quality="high")
`;

            const result = await engineService.executeScript(testScript, { timeoutMs: 30000 });

            expect(result.success, `Execution failed with error: ${result.error} | stderr: ${result.stderr} | stdout: ${result.stdout}`).toBe(true);
            expect(result.glbBuffer).toBeDefined();
            expect(result.glbBuffer.length).toBeGreaterThan(10000);

            // Verify glTF 2.0 Binary Header: Magic 0x46546C67 ('glTF') and Version 2
            const magic = result.glbBuffer.readUInt32LE(0);
            const version = result.glbBuffer.readUInt32LE(4);
            const totalLength = result.glbBuffer.readUInt32LE(8);

            expect(magic).toBe(0x46546c67);
            expect(version).toBe(2);
            expect(totalLength).toBe(result.glbBuffer.length);

            // Verify Mandatory Geometric Complexity Floor (>= 25,000 vertices for compound scene)
            expect(result.meshStats.vertexCount).toBeGreaterThanOrEqual(25000);
            expect(result.meshStats.triangleCount).toBeGreaterThanOrEqual(15000);

            // Verify Bounding Box matches physical dimensions
            const spanX = result.meshStats.bounds.max[0] - result.meshStats.bounds.min[0];
            const spanZ = result.meshStats.bounds.max[2] - result.meshStats.bounds.min[2];
            expect(spanX).toBeGreaterThanOrEqual(100.0);
            expect(spanZ).toBeGreaterThanOrEqual(100.0);
        }, 40000);
    });

    describe('Layer 4: Headless Multimodal Sensor Passes & Visual Critic Loop', () => {
        const criticService = new HeadlessSnapshotCriticService();

        it('should audit sensor validation passes and confirm ground contact alignment with zero floating assets', () => {
            const width = 64;
            const height = 64;
            const totalPixels = width * height;

            // Mock ground-aligned scene sensor passes
            const mockRgb = new Float32Array(totalPixels * 3).fill(0.6);
            const mockDepth = new Float32Array(totalPixels).fill(25.0);
            const mockNormals = new Float32Array(totalPixels * 3);
            for (let i = 0; i < totalPixels; ++i) {
                mockNormals[i * 3 + 0] = 0.0;
                mockNormals[i * 3 + 1] = 1.0; // Upward facing normal
                mockNormals[i * 3 + 2] = 0.0;
            }

            const audit = criticService.auditSensorPasses({
                width,
                height,
                rgbBeauty: mockRgb,
                linearDepth: mockDepth,
                surfaceNormals: mockNormals,
                vertexCount: 32000,
                triangleCount: 22000,
                groundElevationContactMin: -0.1,
                groundElevationContactMax: 0.1,
                cameraFramingCoverage: 0.72
            });

            expect(audit.passed).toBe(true);
            expect(audit.groundContactGap).toBeCloseTo(0.1, 1);
            expect(audit.floatingAssetsDetected).toBe(false);
            expect(audit.normalCoherenceScore).toBeGreaterThan(0.9);
            expect(audit.anomalies).toHaveLength(0);
        });

        it('should detect and flag floating assets when ground contact gap exceeds tolerance', () => {
            const width = 64;
            const height = 64;
            const totalPixels = width * height;

            const mockRgb = new Float32Array(totalPixels * 3).fill(0.5);
            const mockDepth = new Float32Array(totalPixels).fill(30.0);
            const mockNormals = new Float32Array(totalPixels * 3).fill(0.0);

            // Simulating an asset floating at y = 5.0m above ground y = 0.0m
            const audit = criticService.auditSensorPasses({
                width,
                height,
                rgbBeauty: mockRgb,
                linearDepth: mockDepth,
                surfaceNormals: mockNormals,
                vertexCount: 28000,
                triangleCount: 18000,
                groundElevationContactMin: 4.8,
                groundElevationContactMax: 12.0,
                cameraFramingCoverage: 0.65
            });

            expect(audit.passed).toBe(false);
            expect(audit.floatingAssetsDetected).toBe(true);
            expect(audit.anomalies.some(a => a.type === 'floating_asset')).toBe(true);
            expect(audit.recommendedCorrections.some(c => c.includes('align_to_terrain'))).toBe(true);
        });
    });
});
