import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NativePythonRunnerService } from '../src/node/3d-engine/native-python-runner-service';
import { analyzePartConnectivity, describeFloatingParts, glbToTriangleSoup } from '../src/node/3d-engine/part-connectivity';

// Real engine geometry, not hand-built triangles: the stool mistakes came from how scripts place engine meshes.
async function buildGlb(body: string): Promise<Buffer> {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'part-connectivity-'));
    try {
        const res = await NativePythonRunnerService.getInstance().runScript(`import scratchbox as sb\n${body}\nsb.io.write_glb(OUTPUT_GLB_PATH, scene)\n`, { outputDir });
        expect(res.exitCode, res.stderr).toBe(0);
        return Buffer.from(res.glbBase64!, 'base64');
    } finally {
        fs.rmSync(outputDir, { recursive: true, force: true });
    }
}

const stool = (rungOffset: number) => `
TOP_R, FOOT_R, SEAT_Y = 0.11, 0.17, 0.46
corners = [(1, 1), (1, -1), (-1, -1), (-1, 1)]
lerp = lambda a, b, t: tuple(a[i] + (b[i] - a[i]) * t for i in range(3))
tops = [(sx * TOP_R * 0.7071, SEAT_Y + 0.015, sz * TOP_R * 0.7071) for sx, sz in corners]
feet = [(sx * FOOT_R * 0.7071, 0.0, sz * FOOT_R * 0.7071) for sx, sz in corners]
scene = sb.Scene()
seat = sb.create_cylinder(radius=0.17, height=0.04, segments=48)
seat.translate(0.0, SEAT_Y + 0.02, 0.0)
scene.add_mesh(seat)
for top, foot in zip(tops, feet):
    scene.add_mesh(sb.sweep_curve_profile(path=[top, foot], profile_dimensions=(0.018, 0.018)))
a, b = lerp(tops[0], feet[0], 0.65), lerp(tops[1], feet[1], 0.65)
# A rung pushed sideways by rungOffset misses the legs, like the generated stool's stretchers.
a, b = (a[0] + ${rungOffset}, a[1], a[2]), (b[0] + ${rungOffset}, b[1], b[2])
scene.add_mesh(sb.sweep_curve_profile(path=[a, b], profile_dimensions=(0.011, 0.011)))
`;

describe('part connectivity check', () => {
    it('passes a stool whose rung is built between points on the legs', async () => {
        const report = analyzePartConnectivity(glbToTriangleSoup(await buildGlb(stool(0)))!);
        expect(report.passed, describeFloatingParts(report)).toBe(true);
        expect(report.partCount).toBe(6);
    }, 180_000);

    it('reports a rung that misses the legs, with its real gap', async () => {
        const report = analyzePartConnectivity(glbToTriangleSoup(await buildGlb(stool(0.06)))!);
        expect(report.passed).toBe(false);
        expect(report.floatingParts).toHaveLength(1);
        const rung = report.floatingParts[0];
        expect(rung.size[2]).toBeGreaterThan(0.1);                 // the long, rung-shaped piece
        expect(rung.gapMeters).toBeGreaterThan(0.01);
        expect(rung.gapMeters).toBeLessThan(0.06);
        expect(describeFloatingParts(report)).toMatch(/1 group of parts does not touch/);
    }, 180_000);

    it('keeps a subdivided welded box as one part instead of six faces', async () => {
        const report = analyzePartConnectivity(glbToTriangleSoup(await buildGlb(`
scene = sb.Scene()
box = sb.create_box(width=1.6, height=0.55, depth=4.2)
box.weld_vertices()
box.subdivide(3)
scene.add_mesh(box)
`))!);
        expect(report.partCount).toBe(1);
        expect(report.passed).toBe(true);
    }, 180_000);

    it('builds replicate_metric_array fasteners at their requested height (not 2 m rods)', async () => {
        const res = await NativePythonRunnerService.getInstance().runScript(`
import json, scratchbox as sb
bolts = sb.replicate_metric_array(distribution_mode="CURVE_1D", guide_points=[(0, 0, 0), (0.5, 0, 0)], pitch_meters=0.1,
                                  seed_geometry={"shape": "CYLINDRICAL_FASTENER", "dimensions": (0.012, 0.03)})
b = bolts.bounds
print(json.dumps({"height": b.max.y - b.min.y}))
`);
        expect(res.exitCode, res.stderr).toBe(0);
        const { height } = JSON.parse(res.stdout.trim().split('\n').pop()!);
        expect(height).toBeCloseTo(0.03, 3);
    }, 180_000);
});
