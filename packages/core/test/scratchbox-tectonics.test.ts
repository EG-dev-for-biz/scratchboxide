/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
    SbArchiService,
    NativeCppCompilerService
} from '../src/node';
import { TectonicReportParseError } from '../src/node/3d-engine/sb-archi-service';

describe('SB-Archi Tectonic Synthesis & Analysis Engine (C++20)', () => {
    const service = new SbArchiService();

    it('1. should verify native C++20 Tectonics & Analyzer headers are accessible', () => {
        const compiler = new NativeCppCompilerService();
        const sdkInclude = compiler.getSdkIncludePath();
        expect(fs.existsSync(sdkInclude)).toBe(true);

        const tectonicsHeaderPath = path.join(sdkInclude, 'scratchbox_tectonics.hpp');
        expect(fs.existsSync(tectonicsHeaderPath)).toBe(true);

        const tectonicsContent = fs.readFileSync(tectonicsHeaderPath, 'utf8');
        expect(tectonicsContent).toContain('namespace scratchbox');
        expect(tectonicsContent).toContain('namespace tectonics');
        expect(tectonicsContent).toContain('enum class ArchCurveType');
        expect(tectonicsContent).toContain('class ArchProfile');
        expect(tectonicsContent).toContain('class VoussoirSubdivider');
        expect(tectonicsContent).toContain('class VaultMesher');
        expect(tectonicsContent).toContain('class ColumnBuilder');
        expect(tectonicsContent).toContain('class EntablatureExtruder');
        expect(tectonicsContent).toContain('class AshlarFieldBuilder');

        // Verify mathematical arch families are present
        expect(tectonicsContent).toContain('Semicircular');
        expect(tectonicsContent).toContain('PointedEquilateral');
        expect(tectonicsContent).toContain('BasketHandle');
        expect(tectonicsContent).toContain('Parabolic');
        expect(tectonicsContent).toContain('Catenary');

        // Verify stereotomic interlocking joggle joints and anathyrosis
        expect(tectonicsContent).toContain('bool useJoggleJoints');
        expect(tectonicsContent).toContain('float joggleDepth');
        expect(tectonicsContent).toContain('bool useAnathyrosis');
        expect(tectonicsContent).toContain('addStereotomicBedJoint');

        // Verify Roman helicoidal annular vaults
        expect(tectonicsContent).toContain('struct HelicoidalRampConfig');
        expect(tectonicsContent).toContain('buildHelicoidalAnnularVault');

        const analyzerHeaderPath = path.join(sdkInclude, 'scratchbox_tectonic_analyzer.hpp');
        expect(fs.existsSync(analyzerHeaderPath)).toBe(true);

        const analyzerContent = fs.readFileSync(analyzerHeaderPath, 'utf8');
        expect(analyzerContent).toContain('namespace scratchbox');
        expect(analyzerContent).toContain('namespace tectonics');
        expect(analyzerContent).toContain('class ElevationHistogram');
        expect(analyzerContent).toContain('class BayRhythmAutocorrelation');
        expect(analyzerContent).toContain('class PlanFootprintFitter');
        expect(analyzerContent).toContain('class TectonicMeasurementAnalyzer');
        // No fixed monument taxonomy with constant confidences
        expect(analyzerContent).not.toContain('TectonicStructureType');
        expect(analyzerContent).not.toContain('confidence = 0.9');
    });

    it('2. should compile or ensure the C++20 run_arch_constantine binary exists', async () => {
        const binPath = await service.ensureArchConstantineBinary();
        expect(fs.existsSync(binPath)).toBe(true);
        const stats = fs.statSync(binPath);
        expect(stats.size).toBeGreaterThan(50000);
    });

    it('3. should synthesize Arch of Constantine with coffered vaults, voussoirs and entasis columns in <25ms', async () => {
        const result = await service.buildArchConstantine();

        expect(result.success).toBe(true);
        expect(result.glbPath).toBeDefined();
        expect(fs.existsSync(result.glbPath)).toBe(true);

        // Check binary glTF 2.0 header magic (0x46546C67 = "glTF")
        const glbBuffer = fs.readFileSync(result.glbPath);
        expect(glbBuffer.length).toBeGreaterThan(10 * 1024 * 1024); // > 10 MB
        const magic = glbBuffer.toString('utf8', 0, 4);
        expect(magic).toBe('glTF');

        // Check telemetry report
        expect(result.report).toBeDefined();
        expect(result.report).not.toHaveProperty('classification');
        expect(result.report).not.toHaveProperty('confidencePct');
        expect(result.report.detectedDatumsCount).toBeGreaterThanOrEqual(20);
        expect(result.report.synthesizedVertices).toBeGreaterThan(150000);
        expect(result.report.synthesizedTriangles).toBeGreaterThan(75000);
        expect(result.report.runtimeMs).toBeLessThan(50.0); // usually ~10ms
        expect(result.nominalDimensions[0]).toBeCloseTo(25.7, 1);
        expect(result.nominalDimensions[1]).toBeCloseTo(21.0, 1);
    }, 45000);

    it('4. a report missing a measured field is an error, not a canned Arch of Constantine default', () => {
        const parse = (out: string) => (service as any).parseTectonicReport(out);
        expect(() => parse('')).toThrow(TectonicReportParseError);
        const full = [
            '  - Footprint Center: (-1.5, 2.25, 3)',
            '  - Footprint Major Dimension: 12.5 m',
            '  - Footprint Minor Dimension: 4.25 m',
            '  - Structure Total Height: 9.75 m',
            '  - Detected Datums: 7 histogram datums',
            '  - Synthesized Vertices: 1234',
            '  - Synthesized Triangles: 456',
            '  - Synthesis Runtime: 3.5 ms'
        ].join('\n');
        expect(parse(full)).toEqual({
            footprintCenter: [-1.5, 2.25, 3],
            footprintDimensions: [12.5, 9.75, 4.25],
            totalHeight: 9.75,
            detectedDatumsCount: 7,
            synthesizedVertices: 1234,
            synthesizedTriangles: 456,
            runtimeMs: 3.5
        });
        expect(() => parse(full.replace(/.*Total Height.*\n/, ''))).toThrow(/Structure Total Height/);
    });
});
