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
import { NativePythonRunnerService } from '../src/node/3d-engine/native-python-runner-service';

interface Primitive { positions: number[]; indices: number[] }

function readPrimitives(file: string): Primitive[] {
    const buf = fs.readFileSync(file);
    expect(buf.subarray(0, 4).toString('ascii')).toBe('glTF');
    const jsonLen = buf.readUInt32LE(12);
    const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
    const bin = buf.subarray(20 + jsonLen + 8);
    const read = (accessorIdx: number): number[] => {
        const acc = json.accessors[accessorIdx];
        const view = json.bufferViews[acc.bufferView];
        const comps = ({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 } as Record<string, number>)[acc.type];
        const base = (view.byteOffset || 0) + (acc.byteOffset || 0);
        const out: number[] = [];
        for (let i = 0; i < acc.count * comps; i++) {
            if (acc.componentType === 5126) out.push(bin.readFloatLE(base + i * 4));
            else if (acc.componentType === 5125) out.push(bin.readUInt32LE(base + i * 4));
            else out.push(bin.readUInt16LE(base + i * 2));
        }
        return out;
    };
    return json.meshes.flatMap((m: any) => m.primitives.map((p: any) => ({
        positions: read(p.attributes.POSITION),
        indices: read(p.indices)
    })));
}

/**
 * Edges not shared by exactly two triangles, welding vertices by exact position (outputs split normals at
 * hard edges, but a shared point has identical coordinates in every face; rounding would merge distinct
 * vertices a grid step apart).
 */
function badEdgeCount(p: Primitive): number {
    const key = (i: number) => [0, 1, 2].map(k => p.positions[i * 3 + k]).join(',');
    const edges = new Map<string, number>();
    for (let t = 0; t < p.indices.length; t += 3) {
        for (let e = 0; e < 3; e++) {
            const a = key(p.indices[t + e]);
            const b = key(p.indices[t + ((e + 1) % 3)]);
            if (a === b) continue;
            const k = a < b ? `${a}|${b}` : `${b}|${a}`;
            edges.set(k, (edges.get(k) || 0) + 1);
        }
    }
    return [...edges.values()].filter(c => c !== 2).length;
}

function signedVolume(p: Primitive): number {
    let v = 0;
    const P = (i: number) => [p.positions[i * 3], p.positions[i * 3 + 1], p.positions[i * 3 + 2]];
    for (let t = 0; t < p.indices.length; t += 3) {
        const [a, b, c] = [P(p.indices[t]), P(p.indices[t + 1]), P(p.indices[t + 2])];
        v += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
    }
    return v;
}

// An exact cube built from triangles, so expected volumes are closed-form.
const CUBE = `
def cube(cx, cy, cz, h):
    m = sb.geometry.Mesh("cube")
    for i in range(8):
        m.add_vertex(sb.math.Vec3(cx + (h if i & 1 else -h), cy + (h if i & 2 else -h), cz + (h if i & 4 else -h)))
    for a, b, c, d in ((0, 2, 3, 1), (4, 5, 7, 6), (0, 1, 5, 4), (2, 6, 7, 3), (0, 4, 6, 2), (1, 3, 7, 5)):
        m.add_triangle(a, b, c)
        m.add_triangle(a, c, d)
    return m
`;

async function run(body: string): Promise<Primitive> {
    const runner = NativePythonRunnerService.getInstance();
    const result = await runner.runScript(`
import scratchbox as sb
${CUBE}
${body}
sb.io.write_glb(sb.constants.OUTPUT_GLB_PATH, [out])
`);
    expect(result.success, result.stderr).toBe(true);
    const prims = readPrimitives(result.glbPath!);
    expect(prims.length).toBe(1);
    return prims[0];
}

describe('Hard-surface mesh operations (sb.meshops)', () => {
    it('booleans of overlapping cubes are exact and closed', async () => {
        for (const [op, expected] of [['union', 15], ['subtract', 7], ['intersect', 1]] as const) {
            const p = await run(`out = sb.meshops.${op}(cube(0, 0, 0, 1), cube(1, 1, 1, 1))`);
            expect(badEdgeCount(p), op).toBe(0);
            expect(signedVolume(p), op).toBeCloseTo(expected, 4);
        }
    }, 600000);

    it('bores a 48-sided cylinder through a cube with no cracks, to the exact prism volume', async () => {
        const p = await run(`out = sb.meshops.subtract(cube(0, 0, 0, 1), sb.create_cylinder(radius=0.5, height=3.0, segments=48))`);
        expect(badEdgeCount(p)).toBe(0);
        const prismArea = 0.5 * 48 * 0.25 * Math.sin((2 * Math.PI) / 48);
        expect(signedVolume(p)).toBeCloseTo(8 - prismArea * 2, 4);
    }, 600000);

    it('chains five coaxial counterbores exactly, in either order, and bevels the result', async () => {
        const steps: Array<[number, number]> = [[0.8, 0.3], [0.65, 0.6], [0.5, 0.9], [0.35, 1.2], [0.2, 2.4]];
        const prism = (r: number) => 0.5 * 64 * r * r * Math.sin((2 * Math.PI) / 64);
        let removed = 0;
        steps.forEach(([r, depth], i) => { removed += (prism(r) - (i + 1 < steps.length ? prism(steps[i + 1][0]) : 0)) * Math.min(depth, 2); });
        for (const order of ['steps', 'list(reversed(steps))']) {
            const p = await run(`
steps = ${JSON.stringify(steps)}
out = sb.create_box(width=2.0, height=2.0, depth=2.0)
for r, depth in ${order}:
    c = sb.create_cylinder(radius=r, height=depth * 2, segments=64)
    c.translate(0.0, 1.0, 0.0)
    out = sb.meshops.subtract(out, c)
out = sb.meshops.bevel(out, 0.01, segments=2)`);
            expect(badEdgeCount(p), order).toBe(0);
            // The bevel removes a little material at every edge; the unbevelled volume is exact.
            expect(signedVolume(p), order).toBeLessThan(8 - removed);
            expect(signedVolume(p), order).toBeGreaterThan((8 - removed) * 0.995);
        }
    }, 600000);

    it('applies the same cut twice and a union then a coaxial bore without drift', async () => {
        const prism = (r: number, n: number) => 0.5 * n * r * r * Math.sin((2 * Math.PI) / n);
        const twice = await run(`
block = sb.create_box(width=2.0, height=2.0, depth=2.0)
c = sb.create_cylinder(radius=0.5, height=3.0, segments=48)
out = sb.meshops.subtract(sb.meshops.subtract(block, c), c)`);
        expect(badEdgeCount(twice)).toBe(0);
        expect(signedVolume(twice)).toBeCloseTo(8 - prism(0.5, 48) * 2, 4);
        const mixed = await run(`
block = sb.create_box(width=2.0, height=2.0, depth=2.0)
shaft = sb.create_cylinder(radius=0.17, height=3.0, segments=64)
shaft.rotate_x(90.0)
boss = sb.create_cylinder(radius=0.3, height=0.4, segments=64)
boss.rotate_x(90.0)
boss.translate(0.0, 0.0, 1.1)
out = sb.meshops.subtract(sb.meshops.union(block, boss), shaft)`);
        expect(badEdgeCount(mixed)).toBe(0);
        expect(signedVolume(mixed)).toBeCloseTo(8 + prism(0.3, 64) * 0.3 - prism(0.17, 64) * 2.3, 4);
    }, 600000);

    it('subtracts a dense isosurface mesh and stays closed', async () => {
        const p = await run(`
bore = sb.sdf.cylinder(0.5, 3.0).to_mesh((-0.6, -1.6, -0.6), (0.6, 1.6, 0.6), resolution=48)
out = sb.meshops.subtract(cube(0, 0, 0, 1), bore)`);
        expect(badEdgeCount(p)).toBe(0);
        const expected = 8 - Math.PI * 0.25 * 2;
        expect(Math.abs(signedVolume(p) - expected) / expected).toBeLessThan(0.01);
    }, 600000);

    it('chamfers a cube to the exact closed-form volume and rounds it closed', async () => {
        const chamfer = await run('out = sb.meshops.bevel(cube(0, 0, 0, 1), 0.1, segments=1)');
        expect(badEdgeCount(chamfer)).toBe(0);
        // 12 edge wedges (0.5 w^2 (2 - 2w)) and 8 corner pieces (5/6 w^3) removed.
        expect(signedVolume(chamfer)).toBeCloseTo(8 - 12 * 0.5 * 0.01 * 1.8 - 8 * (5 / 6) * 0.001, 3);
        const rounded = await run('out = sb.meshops.bevel(cube(0, 0, 0, 1), 0.1, segments=4)');
        expect(badEdgeCount(rounded)).toBe(0);
        expect(signedVolume(rounded)).toBeGreaterThan(signedVolume(chamfer));
        expect(signedVolume(rounded)).toBeLessThan(8);
    }, 600000);

    it('bevels the edges a boolean cut leaves, staying closed', async () => {
        const p = await run(`
cut = sb.meshops.subtract(cube(0, 0, 0, 1), sb.create_cylinder(radius=0.5, height=3.0, segments=48))
out = sb.meshops.bevel(cut, 0.04, segments=2)`);
        expect(badEdgeCount(p)).toBe(0);
        const bored = 8 - 0.5 * 48 * 0.25 * Math.sin((2 * Math.PI) / 48) * 2;
        expect(signedVolume(p)).toBeLessThan(bored * 1.005);
        expect(signedVolume(p)).toBeGreaterThan(bored * 0.97);
    }, 600000);

    it('raises and recesses panels by exact frustum volumes', async () => {
        const raised = await run('out = sb.meshops.inset_extrude(cube(0, 0, 0, 1), (0, 1, 0), inset=0.2, depth=0.5)');
        expect(badEdgeCount(raised)).toBe(0);
        expect(signedVolume(raised)).toBeCloseTo(8 + (0.5 / 3) * (4 + 2.56 + 3.2), 4);
        const recessed = await run('out = sb.meshops.inset_extrude(cube(0, 0, 0, 1), (0, 0, 1), inset=0.3, depth=-0.1)');
        expect(badEdgeCount(recessed)).toBe(0);
        expect(signedVolume(recessed)).toBeCloseTo(8 - (0.1 / 3) * (4 + 1.96 + 2.8), 4);
    }, 600000);

    it('solidifies an open plane into a closed slab', async () => {
        const p = await run(`
plane = sb.geometry.Mesh("plane")
for x, z in ((-1, -1), (1, -1), (-1, 1), (1, 1)):
    plane.add_vertex(sb.math.Vec3(x, 0, z))
plane.add_triangle(0, 2, 3)
plane.add_triangle(0, 3, 1)
out = sb.meshops.solidify(plane, 0.1)`);
        expect(badEdgeCount(p)).toBe(0);
        expect(signedVolume(p)).toBeCloseTo(0.4, 5);
    }, 600000);
});
