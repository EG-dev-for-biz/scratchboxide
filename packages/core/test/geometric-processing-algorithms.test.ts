import { describe, it, expect, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { NativePythonRunnerService } from '../src/node/3d-engine/native-python-runner-service';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const NATIVE_BUILD_DIR = path.join(REPO_ROOT, 'packages/core/src/native/3d-engine/build_py');
const PYTHON_DIR = path.join(REPO_ROOT, 'packages/core/src/python');
// Scratch scripts go to a temp dir, not the repo root.
const SCRATCH_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-geom-proc-'));

function getPythonCmd(): string {
    const candidatePaths = [
        process.env.SCRATCHBOX_PYTHON,
        '/opt/homebrew/bin/python3.14',
        '/opt/homebrew/bin/python3',
        path.resolve(REPO_ROOT, '.venv/bin/python'),
        path.resolve(REPO_ROOT, '.venv/bin/python3'),
        'python3'
    ];
    for (const p of candidatePaths) {
        if (p && p.includes('/') && fs.existsSync(p)) return p;
    }
    return 'python3';
}

function runPythonScript(scriptBody: string): string {
    const fullScript = `
import sys, os
sys.path.insert(0, '${NATIVE_BUILD_DIR}')
sys.path.insert(0, '${PYTHON_DIR}')
import scratchbox as sb
geometry = sb.geometry
math = sb.math
processing = sb.processing
topology = sb.topology

${scriptBody}
`;
    const tempScript = path.join(SCRATCH_DIR, `scratch_proc_test_${Date.now()}_${Math.random().toString(36).substring(2, 7)}.py`);
    fs.writeFileSync(tempScript, fullScript, 'utf8');
    const pyExe = getPythonCmd();
    try {
        const out = execSync(`"${pyExe}" "${tempScript}"`, {
            cwd: REPO_ROOT,
            encoding: 'utf8',
            env: {
                ...process.env,
                PYTHONPATH: `${NATIVE_BUILD_DIR}:${PYTHON_DIR}`
            }
        });
        return out.trim();
    } finally {
        if (fs.existsSync(tempScript)) {
            fs.unlinkSync(tempScript);
        }
    }
}

describe('Scratchbox Geometric Processing & Topology Engine (C++20 SIMD)', () => {
    afterAll(() => fs.rmSync(SCRATCH_DIR, { recursive: true, force: true }));

    it('1. Garland-Heckbert QEM Decimation: Simplifies mesh while preserving geometry and bounds', () => {
        const script = `
sphere = sb.create_sphere(radius=2.0, segments=32)
initial_tris = len(sphere.indices) // 3
initial_verts = len(sphere.vertices)

# Decimate to 40% ratio
sphere.decimate(ratio=0.4)
final_tris = len(sphere.indices) // 3
final_verts = len(sphere.vertices)

print(f"{initial_tris},{initial_verts},{final_tris},{final_verts},{sphere.bounds.min.x:.2f},{sphere.bounds.max.x:.2f}")
`;
        const output = runPythonScript(script);
        const [initTris, initVerts, finalTris, finalVerts, minX, maxX] = output.split(',');
        
        expect(parseInt(finalTris)).toBeLessThan(parseInt(initTris));
        expect(parseInt(finalTris)).toBeGreaterThan(50);
        // Bounds should stay close to radius 2.0 (-2.0 to 2.0)
        expect(parseFloat(minX)).toBeCloseTo(-2.0, 0.5);
        expect(parseFloat(maxX)).toBeCloseTo(2.0, 0.5);
    });

    it('2. Taubin Non-Shrinking Smoothing: Filters noise without volume collapse', () => {
        const script = `
sphere = sb.create_sphere(radius=3.0, segments=24)
sphere.displace(freq=12.0, amp=0.15) # Add noisy bumpiness

# Apply Taubin non-shrinking smoothing
sphere.taubin_smooth(iterations=8, lambda_val=0.5, mu_val=-0.53)

# Check radius of smoothed vertices stays near 3.0
rad_sum = sum(v.position.length() for v in sphere.vertices)
avg_rad = rad_sum / len(sphere.vertices)

print(f"{avg_rad:.3f},{len(sphere.vertices)}")
`;
        const output = runPythonScript(script);
        const [avgRad, vertCount] = output.split(',');
        expect(parseFloat(avgRad)).toBeCloseTo(3.0, 0.15); // Stays at ~3.0m without shrinking to 0
        expect(parseInt(vertCount)).toBeGreaterThan(100);
    });

    it('3. Discrete Differential Geometry & Koenderink Shape Index', () => {
        const script = `
sphere = sb.create_sphere(radius=2.0, segments=20)
curvs = sb.processing.analyze_curvature(sphere)

# For a sphere of radius R=2, Mean curvature H > 0, Shape Index ≈ 1.0 (spherical cap)
avg_H = sum(curvs.mean_curvature) / len(curvs.mean_curvature)
avg_K = sum(curvs.gaussian_curvature) / len(curvs.gaussian_curvature)
avg_S = sum(curvs.shape_index) / len(curvs.shape_index)

# Bake cavity AO into vertex colors
sphere.bake_cavity_ao(intensity=0.8)

print(f"{avg_H:.2f},{avg_K:.2f},{avg_S:.2f},{len(curvs.cavity_occlusion)}")
`;
        const output = runPythonScript(script);
        const [avgH, avgK, avgS, count] = output.split(',');
        expect(parseFloat(avgH)).toBeGreaterThan(0.2); // Convex curvature H > 0
        expect(parseFloat(avgS)).toBeGreaterThan(0.5); // Spherical cap shape index > 0.5
        expect(parseInt(count)).toBeGreaterThan(50);
    });

    it('4. Poisson-Disk Blue Noise Point Sampling on Surfaces', () => {
        const script = `
box = sb.create_box(width=10.0, height=2.0, depth=10.0)
samples = box.poisson_sample(count=50, min_distance=0.5, seed=123)

# Verify samples exist and have valid positions and unit normals
valid = all(s.position.x >= -5.1 and s.position.x <= 5.1 and abs(s.normal.length() - 1.0) < 0.01 for s in samples)
print(f"{len(samples)},{valid}")
`;
        const output = runPythonScript(script);
        const [sampleCount, valid] = output.split(',');
        expect(parseInt(sampleCount)).toBeGreaterThan(20);
        expect(valid).toBe('True');
    });

    it('5. Sutherland-Hodgman Planar Mesh Slicing & Capping', () => {
        const script = `
cube = sb.create_box(width=4.0, height=4.0, depth=4.0)

# Slice horizontally at y=0, keep top half and cap cross-section
cube.slice_by_plane(plane_point=(0, 0, 0), plane_normal=(0, 1, 0), keep_positive=True, cap_cut=True)

print(f"{cube.bounds.min.y:.2f},{cube.bounds.max.y:.2f},{len(cube.indices)//3}")
`;
        const output = runPythonScript(script);
        const [minY, maxY, triCount] = output.split(',');
        expect(parseFloat(minY)).toBeCloseTo(0.0, 0.1); // Sliced at y=0
        expect(parseFloat(maxY)).toBeCloseTo(2.0, 0.1); // Top kept at y=2
        expect(parseInt(triCount)).toBeGreaterThan(6);
    });

    it('6. Boundary Loop Hole Filling', () => {
        const script = `
# Create a plane (which has an open boundary loop around perimeter)
plane = sb.create_plane(width=4.0, height=4.0, seg_x=4, seg_y=4)
initial_tris = len(plane.indices) // 3

# Fill holes / boundary loop
plane.fill_holes(max_hole_edges=32)
final_tris = len(plane.indices) // 3

print(f"{initial_tris},{final_tris}")
`;
        const output = runPythonScript(script);
        const [initTris, finalTris] = output.split(',');
        expect(parseInt(finalTris)).toBeGreaterThanOrEqual(parseInt(initTris));
    });

    it('7. Hausdorff Distance & Metro Metric Error Verification', () => {
        const script = `
sphere_orig = sb.create_sphere(radius=2.0, segments=32)
sphere_dec = sb.create_sphere(radius=2.0, segments=32)
sphere_dec.decimate(ratio=0.5)

res = sphere_orig.hausdorff_distance(sphere_dec, samples=150)
print(f"{res.max_distance:.4f},{res.mean_distance:.4f}")
`;
        const output = runPythonScript(script);
        const [maxDist, meanDist] = output.split(',');
        expect(parseFloat(maxDist)).toBeLessThan(0.6); // Error is small
        expect(parseFloat(meanDist)).toBeLessThan(0.15);
    });

    it('8. Crease-Preserving QEM Decimation: a locked box keeps its true shape where plain QEM distorts or stalls', () => {
        const script = `
def make_box():
    return sb.create_subdivided_box(size=(4.0, 4.0, 4.0), subdivisions=8)

reference = make_box()

no_crease = make_box()
no_crease.decimate_qem(target_triangles=48, preserve_creases=False)

with_crease = make_box()
with_crease.decimate_qem(target_triangles=48, preserve_creases=True, crease_angle_deg=45.0)

h_nc = reference.hausdorff_distance(no_crease, samples=4000)
h_wc = reference.hausdorff_distance(with_crease, samples=4000)

print(f"{len(no_crease.indices)//3},{len(with_crease.indices)//3},{h_nc.max_distance:.4f},{h_wc.max_distance:.4f}")
`;
        const output = runPythonScript(script);
        const [, withCreaseTris, maxDistNoCrease, maxDistWithCrease] = output.split(',');
        // crease preservation reaches the requested triangle budget with the box's true shape intact
        expect(parseInt(withCreaseTris)).toBe(48);
        expect(parseFloat(maxDistWithCrease)).toBeLessThan(0.01);
        // plain QEM on the same mesh and target measurably distorts the shape more
        expect(parseFloat(maxDistNoCrease)).toBeGreaterThan(parseFloat(maxDistWithCrease) * 10);
    });
});
