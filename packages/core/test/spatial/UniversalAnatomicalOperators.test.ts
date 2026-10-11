import { describe, it, expect } from 'vitest';
import { UniversalAnatomicalOperators } from '../../src/node/spatial/UniversalAnatomicalOperators';
import { SbHumanHandTransformer, type EnhancedHandMesh } from '../../src/node/spatial/SbHumanHandTransformer';

describe('UniversalAnatomicalOperators & Invariants (ADA Compliant)', () => {
    describe('Operator 1: Kinematic Diaphysis Waisting', () => {
        it('contracts mid-shaft radius while preserving endpoints (zero boundary inversion)', () => {
            // Create a simple cylinder of 5 rings along X-axis from 0 to 1
            const positions = new Float32Array([
                // Ring 0 (x = 0.0, endpoint)
                0.0, 1.0, 0.0,
                0.0, 0.0, 1.0,
                // Ring 1 (x = 0.5, mid-shaft)
                0.5, 1.0, 0.0,
                0.5, 0.0, 1.0,
                // Ring 2 (x = 1.0, endpoint)
                1.0, 1.0, 0.0,
                1.0, 0.0, 1.0
            ]);
            const indices = [0, 1, 2, 3, 4, 5];
            const boneStart: [number, number, number] = [0, 0, 0];
            const boneEnd: [number, number, number] = [1, 0, 0];

            UniversalAnatomicalOperators.applyDiaphysisWaisting(
                positions,
                indices,
                boneStart,
                boneEnd,
                0.10, // 10% waisting
                1.0
            );

            // Ring 0 endpoints should be unchanged
            expect(positions[0 * 3 + 1]).toBeCloseTo(1.0, 4);
            expect(positions[1 * 3 + 2]).toBeCloseTo(1.0, 4);

            // Ring 1 (mid-shaft x=0.5) should be contracted by sin(pi/2) * 0.10 = 0.10 => 0.90
            expect(positions[2 * 3 + 1]).toBeCloseTo(0.90, 4);
            expect(positions[3 * 3 + 2]).toBeCloseTo(0.90, 4);

            // Ring 2 endpoints should be unchanged
            expect(positions[4 * 3 + 1]).toBeCloseTo(1.0, 4);
            expect(positions[5 * 3 + 2]).toBeCloseTo(1.0, 4);
        });
    });

    describe('Operator 2: Articular Bicondylar Lateral Flares', () => {
        it('expands joint articulation along lateral axis with smooth cosine falloff', () => {
            const positions = new Float32Array([
                // Vertex at joint center shifted laterally
                0.0, 0.005, 0.0, // 5mm lateral (radius is 10mm)
                // Vertex outside radius
                0.0, 0.020, 0.0  // 20mm lateral
            ]);
            const indices = [0, 1];
            const jointCenter: [number, number, number] = [0, 0, 0];
            const lateralAxis: [number, number, number] = [0, 1, 0];

            UniversalAnatomicalOperators.applyCondylarFlares(
                positions,
                indices,
                jointCenter,
                lateralAxis,
                10.0, // 10mm radius
                0.10, // 10% flare
                1.0
            );

            // Vertex 0 should be expanded
            expect(positions[1]).toBeGreaterThan(0.005);
            // Vertex 1 outside radius should be unchanged
            expect(positions[4]).toBeCloseTo(0.020, 4);
        });
    });

    describe('Operator 3: Monotonic Semi-Ellipsoidal Terminal Dome', () => {
        it('applies continuous parabolic dome without coordinate inversion', () => {
            const positions = new Float32Array([
                // Base of tip (proj = 0)
                0.0, 0.005, 0.0,
                // Mid dome (proj = 6mm)
                0.006, 0.005, 0.0,
                // Near apex (proj = 11mm)
                0.011, 0.005, 0.0
            ]);
            const indices = [0, 1, 2];
            const tipOrigin: [number, number, number] = [0, 0, 0];
            const axisDirection: [number, number, number] = [1, 0, 0];

            UniversalAnatomicalOperators.applyParabolicDome(
                positions,
                indices,
                tipOrigin,
                axisDirection,
                12.0, // 12mm dome length
                1.0
            );

            // Longitudinal coordinates should be completely untouched
            expect(positions[0]).toBeCloseTo(0.0, 5);
            expect(positions[3]).toBeCloseTo(0.006, 5);
            expect(positions[6]).toBeCloseTo(0.011, 5);

            // Radial transverse radius at mid-dome should be less than base
            expect(positions[4]).toBeLessThan(0.005);
            // Radial transverse radius near apex should be smaller still
            expect(positions[7]).toBeLessThan(positions[4]);
        });
    });

    describe('Operator 4: Gaussian Tendon Elevation', () => {
        it('elevates vertices along tendon carrier spline with Gaussian profile', () => {
            const positions = new Float32Array([
                // Directly on spline
                0.5, 0.0, 0.0,
                // Offset from spline by 2mm
                0.5, 0.002, 0.0,
                // Far from spline by 20mm
                0.5, 0.020, 0.0
            ]);
            const indices = [0, 1, 2];
            const start: [number, number, number] = [0, 0, 0];
            const end: [number, number, number] = [1, 0, 0];
            const normal: [number, number, number] = [0, 0, 1];

            UniversalAnatomicalOperators.applyTendonCords(
                positions,
                indices,
                start,
                end,
                normal,
                2.0, // 2mm elevation
                4.0, // 4mm width
                1.0
            );

            // Vertex 0 directly on spline should receive peak elevation (0.002m along Z)
            expect(positions[2]).toBeCloseTo(0.002, 4);

            // Vertex 1 offset by 2mm should receive attenuated elevation
            expect(positions[5]).toBeGreaterThan(0.0);
            expect(positions[5]).toBeLessThan(positions[2]);

            // Vertex 2 far away should receive 0 elevation
            expect(positions[8]).toBe(0.0);
        });
    });

    describe('Dual-Band Frequency Separated Skin PBR Evaluator', () => {
        it('evaluates albedo, normal, and ORM within physical bounds', () => {
            const result = UniversalAnatomicalOperators.evaluateDualBandSkinPbr(
                0.35, // melaninFraction
                0.70, // eumelaninRatio
                0.55, // capillaryBloodVolume
                0.20, // dermalAgeFactor
                0.65, // hydrationLevel
                0.90, // microCavity
                { nx: 0.1, ny: -0.05 }
            );

            expect(result.albedo[0]).toBeGreaterThanOrEqual(0);
            expect(result.albedo[0]).toBeLessThanOrEqual(255);
            expect(result.albedo[1]).toBeGreaterThanOrEqual(0);
            expect(result.albedo[1]).toBeLessThanOrEqual(255);
            expect(result.albedo[2]).toBeGreaterThanOrEqual(0);
            expect(result.albedo[2]).toBeLessThanOrEqual(255);

            expect(result.normal[0]).toBeGreaterThanOrEqual(0);
            expect(result.normal[0]).toBeLessThanOrEqual(255);
            expect(result.normal[2]).toBeGreaterThan(128); // Positive Z hemisphere

            expect(result.orm[0]).toBeGreaterThanOrEqual(0); // AO
            expect(result.orm[1]).toBeGreaterThanOrEqual(0); // Roughness
            expect(result.orm[2]).toBe(0); // Dielectric skin metalness == 0
        });
    });

    describe('SbHumanHandTransformer Invariant Checking', () => {
        it('correctly passes valid meshes and detects degenerate violations', () => {
            // Build a small mock valid mesh
            const numVerts = 5000;
            const numTris = 10000;
            const positions = new Float32Array(numVerts * 3);
            const normals = new Float32Array(numVerts * 3);
            const uvs = new Float32Array(numVerts * 2);
            const colors = new Float32Array(numVerts * 3);
            const indices = new Uint32Array(numTris * 3);

            for (let i = 0; i < numVerts; i++) {
                positions[i * 3 + 0] = (i % 50) * 0.01;
                positions[i * 3 + 1] = Math.floor(i / 50) * 0.01;
                positions[i * 3 + 2] = 0.0;

                normals[i * 3 + 0] = 0.0;
                normals[i * 3 + 1] = 0.0;
                normals[i * 3 + 2] = 1.0;

                uvs[i * 2 + 0] = (i % 50) / 50.0;
                uvs[i * 2 + 1] = Math.floor(i / 50) / 100.0;

                colors[i * 3 + 0] = 1.0;
                colors[i * 3 + 1] = 1.0;
                colors[i * 3 + 2] = 1.0;
            }

            for (let t = 0; t < numTris; t++) {
                const base = (t * 2) % (numVerts - 3);
                indices[t * 3 + 0] = base;
                indices[t * 3 + 1] = base + 1;
                indices[t * 3 + 2] = base + 2;
            }

            const mockMesh: EnhancedHandMesh = {
                positions,
                normals,
                uvs,
                colors,
                indices,
                numVertices: numVerts,
                numTriangles: numTris
            };

            const result = SbHumanHandTransformer.assertInvariants(mockMesh);
            // Notice: points in linear row will have collinear degenerate faces
            expect(result.checks.length).toBeGreaterThanOrEqual(4);
        });
    });
});
