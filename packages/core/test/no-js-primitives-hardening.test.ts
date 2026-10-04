import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
    GeometricComplexityGate,
    GeometricFidelityViolationError,
    GeometricSceneMetrics
} from '../src/common/spatial/GeometricComplexityGate';

describe('Anti-JS-Primitive Hardening & Geometric Complexity Gate', () => {
    it('should reject scenes with insufficient vertex density (<25,000 vertices)', () => {
        const degradedPrimitiveScene: GeometricSceneMetrics = {
            totalVertices: 1792,
            totalTriangles: 3648,
            engineKernel: 'ClientSideThreeJS',
            submeshes: [
                { name: 'Box_1', vertexCount: 24, triangleCount: 12, isPrimitive: true, generatorType: 'THREE.BoxGeometry' },
                { name: 'Cylinder_1', vertexCount: 64, triangleCount: 64, isPrimitive: true, generatorType: 'THREE.CylinderGeometry' }
            ]
        };

        const report = GeometricComplexityGate.evaluate(degradedPrimitiveScene);
        expect(report.passed).toBe(false);
        expect(report.violations.some(v => v.includes('Insufficient geometric density'))).toBe(true);
        expect(report.violations.some(v => v.includes('banned primitive'))).toBe(true);
        expect(report.violations.some(v => v.includes('Unsanctioned 3D engine kernel'))).toBe(true);

        expect(() => GeometricComplexityGate.assertFidelity(degradedPrimitiveScene)).toThrow(
            GeometricFidelityViolationError
        );
    });

    it('should approve high-density Native C++20 scenes exceeding the complexity floor', () => {
        const nativePalaisScene: GeometricSceneMetrics = {
            totalVertices: 71716,
            totalTriangles: 50488,
            engineKernel: 'Scratchbox C++20 nanobind',
            submeshes: [
                { name: 'Studio_Pedestal', vertexCount: 196, triangleCount: 128 },
                { name: 'PrimaryEdifice', vertexCount: 3272, triangleCount: 2180 },
                { name: 'EastWing', vertexCount: 1726, triangleCount: 1150 },
                { name: 'WestWing', vertexCount: 1726, triangleCount: 1150 },
                { name: 'BotanicalTree_1', vertexCount: 26744, triangleCount: 17820 },
                { name: 'BotanicalTree_2', vertexCount: 26744, triangleCount: 17820 },
                { name: 'ClingingIvy', vertexCount: 11308, triangleCount: 10240 }
            ]
        };

        const report = GeometricComplexityGate.evaluate(nativePalaisScene);
        expect(report.passed).toBe(true);
        expect(report.violations).toHaveLength(0);
        expect(report.isNativeKernel).toBe(true);

        expect(() => GeometricComplexityGate.assertFidelity(nativePalaisScene)).not.toThrow();
    });

    it('should verify that interactive_3d_prompting_studio.html contains ZERO JavaScript primitive scene generators', () => {
        const studioPath = path.resolve(__dirname, '../../../public/test_reports/interactive_3d_prompting_studio.html');
        expect(fs.existsSync(studioPath)).toBe(true);

        const content = fs.readFileSync(studioPath, 'utf8');

        // Verify that buildThreeMeshes primitive fallback is completely purged
        expect(content).not.toContain('function buildThreeMeshes');
        expect(content).not.toContain('buildThreeMeshes(');

        // Verify no BoxGeometry or CylinderGeometry instantiation in scene builder
        expect(content).not.toMatch(/new\s+THREE\.BoxGeometry/);
        expect(content).not.toMatch(/new\s+THREE\.CylinderGeometry/);
        expect(content).not.toMatch(/new\s+THREE\.ConeGeometry/);

        // Verify that synthesis relies on POST /api/synthesize-3d and GLTFLoader
        expect(content).toContain('/api/synthesize-3d');
        expect(content).toContain('THREE.GLTFLoader');
    });

    it('should verify that AGENTS.md mandates C++ first and prohibits client-side toy primitives', () => {
        const agentsMdPath = path.resolve(__dirname, '../../../AGENTS.md');
        expect(fs.existsSync(agentsMdPath)).toBe(true);

        const content = fs.readFileSync(agentsMdPath, 'utf8');
        expect(content).toContain('Lean on C/C++ First for 3D');
        expect(content).toContain('C++20 as Geometry Generator, Three.js as Pure Viewport');
    });
});
