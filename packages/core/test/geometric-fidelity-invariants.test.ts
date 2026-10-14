import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { GeometricComplexityGate, GeometricSceneMetrics } from '../src/common/spatial/GeometricComplexityGate';
import { findBinary, REPO_ROOT, withReason, type Requirement } from './helpers/requirements';

/**
 * Same interpreter order as NativePythonRunnerService.resolvePythonExecutable: SCRATCHBOX_PYTHON, the repo
 * .venv (where the nanobind module in build_py is built), Homebrew/usr-local python3, then python3 on PATH.
 */
function resolveScratchboxPython(): string | null {
    const candidates = [
        process.env.SCRATCHBOX_PYTHON,
        path.join(REPO_ROOT, '.venv/bin/python'),
        path.join(REPO_ROOT, '.venv/bin/python3'),
        '/opt/homebrew/bin/python3',
        '/usr/local/bin/python3'
    ];
    for (const p of candidates) if (p && fs.existsSync(p)) return p;
    return findBinary('python3');
}

const scratchboxPython = resolveScratchboxPython();
const pythonReq: Requirement = scratchboxPython
    ? { ok: true, reason: '' }
    : { ok: false, reason: 'no python3 found (set SCRATCHBOX_PYTHON or create the repo .venv)' };

describe('Geometric Fidelity & Kinematic Invariants Gate', () => {
    it('detects pancake flat wheels lying horizontally on the ground', () => {
        const metrics: GeometricSceneMetrics = {
            totalVertices: 30000,
            totalTriangles: 18000,
            engineKernel: 'scratchbox-nanobind-c++20',
            submeshes: [
                {
                    name: 'MainBody',
                    vertexCount: 20000,
                    triangleCount: 12000,
                    bounds: {
                        min: [-0.8, 0.1, -2.0],
                        max: [0.8, 0.7, 2.0],
                        dimensions: [1.6, 0.6, 4.0]
                    }
                },
                {
                    name: 'FrontLeftWheel',
                    vertexCount: 2500,
                    triangleCount: 1500,
                    bounds: {
                        min: [-0.9, 0.0, 1.2],
                        max: [-0.6, 0.25, 1.8], // dy = 0.25m, dx = 0.3m, dz = 0.6m -> flat pancake!
                        dimensions: [0.3, 0.25, 0.6]
                    }
                }
            ]
        };

        const report = GeometricComplexityGate.evaluate(metrics, {
            enforceKinematicOrientation: true
        });

        expect(report.passed).toBe(false);
        expect(report.violations.some(v => v.includes('Kinematic Orientation Violation'))).toBe(true);
        expect(report.violations.some(v => v.includes('FrontLeftWheel'))).toBe(true);
    });

    it('passes upright rolling wheels oriented along the transverse lateral axis', () => {
        const metrics: GeometricSceneMetrics = {
            totalVertices: 30000,
            totalTriangles: 18000,
            engineKernel: 'scratchbox-nanobind-c++20',
            submeshes: [
                {
                    name: 'MainBody',
                    vertexCount: 20000,
                    triangleCount: 12000,
                    bounds: {
                        min: [-0.8, 0.1, -2.0],
                        max: [0.8, 0.7, 2.0],
                        dimensions: [1.6, 0.6, 4.0]
                    }
                },
                {
                    name: 'FrontLeftWheel',
                    vertexCount: 2500,
                    triangleCount: 1500,
                    bounds: {
                        min: [-0.95, 0.0, 1.15],
                        max: [-0.65, 0.70, 1.85], // dx = 0.30m (tire width), dy = 0.70m, dz = 0.70m (diameter) -> upright!
                        dimensions: [0.30, 0.70, 0.70]
                    }
                }
            ]
        };

        const report = GeometricComplexityGate.evaluate(metrics, {
            enforceKinematicOrientation: true
        });

        expect(report.violations.filter(v => v.includes('Kinematic Orientation Violation'))).toHaveLength(0);
    });

    it('detects stacked box primitives via cardinal normal ratio on primary massing', () => {
        const metrics: GeometricSceneMetrics = {
            totalVertices: 26000,
            totalTriangles: 16000,
            engineKernel: 'scratchbox-nanobind-c++20',
            submeshes: [
                {
                    name: 'ChassisBlock',
                    vertexCount: 24, // Raw cube box vertices
                    triangleCount: 12,
                    cardinalNormalRatio: 1.0, // 100% axis-aligned flat normals
                    bounds: {
                        min: [-1.0, 0.0, -2.0],
                        max: [1.0, 1.0, 2.0],
                        dimensions: [2.0, 1.0, 4.0]
                    }
                },
                {
                    name: 'DetailTrim',
                    vertexCount: 25976,
                    triangleCount: 15988,
                    bounds: {
                        min: [-0.5, 1.0, -0.5],
                        max: [0.5, 1.5, 0.5],
                        dimensions: [1.0, 0.5, 1.0]
                    }
                }
            ]
        };

        const report = GeometricComplexityGate.evaluate(metrics, {
            enforceCompoundCurvature: true
        });

        expect(report.passed).toBe(false);
        expect(report.violations.some(v => v.includes('Curvature Fidelity Violation'))).toBe(true);
    });
});

describe('Python 3D Engine Universal Geometric Operators & Auto-Healing', () => {
    it.skipIf(!pythonReq.ok)(withReason('executes python verification script for wheel, hull, foil, and auto-healing', pythonReq), () => {
        const pythonScript = `
import sys
import scratchbox as sb

# 1. create_wheel verification
wheel = sb.geometry.create_wheel(radius=0.35, width=0.30, rim_radius=0.22, ground=True, axis="lateral")
wb = wheel.bounds
assert abs(wb.min.y) < 1e-3, f"Wheel must be grounded at y=0, got {wb.min.y}"
assert abs(wb.size.y - 0.70) < 0.05, f"Wheel height should be ~0.70m, got {wb.size.y}"
assert abs(wb.size.x - 0.30) < 0.05, f"Wheel width should be ~0.30m, got {wb.size.x}"
assert wheel.get_tag() == "wheel", f"Wheel tag mismatch: {wheel.get_tag()}"

# 2. create_wheel_assembly verification
assembly = sb.geometry.create_wheel_assembly(track_width=1.6, wheelbase=3.2, wheel_radius=0.35, tire_width=0.30)
ab = assembly.bounds
assert abs(ab.size.x - (1.6 + 0.30)) < 0.05, f"Assembly track width check failed: {ab.size.x}"
assert abs(ab.size.z - (3.2 + 2 * 0.35)) < 0.05, f"Assembly wheelbase check failed: {ab.size.z}"
assert abs(ab.min.y) < 1e-3, f"Assembly must be grounded at y=0, got {ab.min.y}"

# 3. create_lofted_hull verification
stations = [
    {"z":  2.0, "width": 0.4, "height": 0.3, "y": 0.2, "m": 2.4},
    {"z":  0.0, "width": 1.2, "height": 0.5, "y": 0.3, "m": 2.8},
    {"z": -2.0, "width": 0.6, "height": 0.3, "y": 0.2, "m": 2.4},
]
hull = sb.geometry.create_lofted_hull(stations, close_ends=True)
hb = hull.bounds
assert hb.size.z > 3.8, f"Hull length should be ~4.0m, got {hb.size.z}"
assert hb.size.x > 1.1, f"Hull max width should be ~1.2m, got {hb.size.x}"

# 4. create_cambered_foil verification
foil = sb.geometry.create_cambered_foil(span=1.5, chord=0.4, camber=0.04, endplates=True)
fb = foil.bounds
assert abs(fb.size.x - 1.5) < 0.05, f"Foil span should be 1.5m, got {fb.size.x}"

# 5. validate_scene and auto-heal verification
scene = sb.geometry.Mesh("TestCar")
scene.merge(hull)

# Add an un-rotated cylinder wheel (pancake flat bug)
flat_wheel = sb.create_cylinder(radius=0.35, height=0.30, segments=24)
flat_wheel.tag("wheel")
scene.merge(flat_wheel)

report = sb.validation.validate_scene(scene, auto_heal=True)
assert len(report["violations"]) > 0, "validate_scene should have detected the flat pancake wheel"
assert len(report["autoHealed"]) > 0, "validate_scene should have auto-healed the flat wheel"
print("PYTHON_TESTS_PASSED")
`;

        const pythonPath = scratchboxPython!;
        const projectRoot = path.resolve(__dirname, '..');
        const env = {
            ...process.env,
            PYTHONPATH: `${path.join(projectRoot, 'src', 'python')}:${path.join(projectRoot, 'src', 'native', '3d-engine', 'build_py')}`
        };

        const stdout = execFileSync(pythonPath, ['-c', pythonScript], {
            env,
            encoding: 'utf8'
        });

        expect(stdout).toContain('PYTHON_TESTS_PASSED');
    });
});
