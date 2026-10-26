import { describe, it, expect, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const NATIVE_BUILD_DIR = path.join(REPO_ROOT, 'packages/core/src/native/3d-engine/build_py');
const PYTHON_DIR = path.join(REPO_ROOT, 'packages/core/src/python');
// Scratch scripts go to a temp dir, not the repo root.
const SCRATCH_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-bvh-ao-'));

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

${scriptBody}
`;
    const tempScript = path.join(SCRATCH_DIR, `scratch_bvh_ao_test_${Date.now()}_${Math.random().toString(36).substring(2, 7)}.py`);
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

describe('Scratchbox BVH Ray-Traced Ambient Occlusion (RTAO)', () => {
    afterAll(() => fs.rmSync(SCRATCH_DIR, { recursive: true, force: true }));

    it('an open, unoccluded box reports full AO (1.0) at every vertex', () => {
        const script = `
box = sb.create_box(size=(2.0, 2.0, 2.0))
ao = box.compute_rtao(samples_per_vertex=64, max_distance=5.0)
min_ao = min(ao)
print(f"{len(ao)},{min_ao:.4f}")
`;
        const output = runPythonScript(script);
        const [count, minAo] = output.split(',');
        expect(parseInt(count)).toBe(24);
        expect(parseFloat(minAo)).toBeGreaterThan(0.95);
    });

    it('a vertex inside a concave corner (a wall meeting a floor) is measurably more occluded than an open vertex on the same surface', () => {
        const script = `
# A floor slab and a wall meeting at a right angle along z = -3, y = 0: a concave inner corner.
floor = sb.create_subdivided_box(size=(8.0, 1.0, 8.0), subdivisions=6)
floor.translate(math.Vec3(0, -0.5, 0))
wall = sb.create_subdivided_box(size=(8.0, 6.0, 1.0), subdivisions=6)
wall.translate(math.Vec3(0, 3, -3.5))
scene = floor
scene.append(wall)

ao = scene.compute_rtao(samples_per_vertex=256, max_distance=10.0, seed=42)

def nearest(target, tol=0.02):
    best_i, best_d = None, 1e9
    for i, v in enumerate(scene.vertices):
        p = (v.position.x, v.position.y, v.position.z)
        if abs(p[1] - target[1]) < tol and abs(p[2] - target[2]) < tol and abs(p[0]) < tol:
            d = abs(p[0] - target[0])
            if d < best_d:
                best_d, best_i = d, i
    return best_i

corner_i = nearest((0.0, 0.0, -3.0))
open_i = nearest((0.0, 0.0, 4.0))
print(f"{ao[corner_i]:.4f},{ao[open_i]:.4f}")
`;
        const output = runPythonScript(script);
        const [cornerAo, openAo] = output.split(',');
        // the concave-corner vertex sees meaningfully less of the sky than the open floor vertex
        expect(parseFloat(cornerAo)).toBeLessThan(0.7);
        expect(parseFloat(openAo)).toBeGreaterThan(0.9);
        expect(parseFloat(cornerAo)).toBeLessThan(parseFloat(openAo) - 0.3);
    });

    it('bake_rtao multiplies vertex colour by the same occlusion compute_rtao reports, scaled by intensity', () => {
        const script = `
floor = sb.create_subdivided_box(size=(8.0, 1.0, 8.0), subdivisions=6)
floor.translate(math.Vec3(0, -0.5, 0))
wall = sb.create_subdivided_box(size=(8.0, 6.0, 1.0), subdivisions=6)
wall.translate(math.Vec3(0, 3, -3.5))
scene = floor
scene.append(wall)

ao = scene.compute_rtao(samples_per_vertex=256, max_distance=10.0, seed=42)
original_colors = [(v.color.x, v.color.y, v.color.z) for v in scene.vertices]
scene.bake_rtao(samples_per_vertex=256, max_distance=10.0, intensity=1.0, seed=42)

max_err = 0.0
for i, v in enumerate(scene.vertices):
    expected = original_colors[i][0] * ao[i]
    max_err = max(max_err, abs(v.color.x - expected))
print(f"{max_err:.5f}")
`;
        const output = runPythonScript(script);
        expect(parseFloat(output)).toBeLessThan(0.001);
    });
});
