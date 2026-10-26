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

/** Edges not shared by exactly two triangles (open or non-manifold), welding vertices by position. */
function badEdgeCount(p: Primitive): number {
    const key = (i: number) => [0, 1, 2].map(k => Math.round(p.positions[i * 3 + k] * 1e5)).join(',');
    const edges = new Map<string, number>();
    for (let t = 0; t < p.indices.length; t += 3) {
        for (let e = 0; e < 3; e++) {
            const a = key(p.indices[t + e]);
            const b = key(p.indices[t + ((e + 1) % 3)]);
            const k = a < b ? `${a}|${b}` : `${b}|${a}`;
            edges.set(k, (edges.get(k) || 0) + 1);
        }
    }
    return [...edges.values()].filter(c => c !== 2).length;
}

/** Signed volume by the divergence theorem: positive when faces wind outward. */
function signedVolume(p: Primitive): number {
    let v = 0;
    const P = (i: number) => [p.positions[i * 3], p.positions[i * 3 + 1], p.positions[i * 3 + 2]];
    for (let t = 0; t < p.indices.length; t += 3) {
        const [a, b, c] = [P(p.indices[t]), P(p.indices[t + 1]), P(p.indices[t + 2])];
        v += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
    }
    return v;
}

async function meshField(fieldExpr: string, lo: string, hi: string, resolution: number): Promise<Primitive> {
    const runner = NativePythonRunnerService.getInstance();
    const result = await runner.runScript(`
import scratchbox as sb
field = ${fieldExpr}
mesh = field.to_mesh(${lo}, ${hi}, resolution=${resolution})
sb.io.write_glb(sb.constants.OUTPUT_GLB_PATH, [mesh])
`);
    expect(result.success, result.stderr).toBe(true);
    expect(result.glbPath && fs.existsSync(result.glbPath)).toBeTruthy();
    const prims = readPrimitives(result.glbPath!);
    expect(prims.length).toBe(1);
    return prims[0];
}

describe('SDF field meshing (sb.sdf ... .to_mesh)', () => {
    it('meshes a sphere closed, outward and on the true surface', async () => {
        const p = await meshField('sb.sdf.sphere(1.0)', '(-1, -1, -1)', '(1, 1, 1)', 64);
        expect(p.indices.length / 3).toBeGreaterThan(10000);
        expect(badEdgeCount(p)).toBe(0);
        let maxRadiusError = 0;
        for (let i = 0; i < p.positions.length; i += 3) {
            const r = Math.hypot(p.positions[i], p.positions[i + 1], p.positions[i + 2]);
            maxRadiusError = Math.max(maxRadiusError, Math.abs(r - 1));
        }
        expect(maxRadiusError).toBeLessThan(0.005);
        expect(signedVolume(p)).toBeGreaterThan(0);
        expect(Math.abs(signedVolume(p) - (4 / 3) * Math.PI) / ((4 / 3) * Math.PI)).toBeLessThan(0.01);
    }, 600000);

    it('subtracts exactly: a 2 m cube minus a 0.5 m radius bore through it', async () => {
        const p = await meshField('sb.sdf.box((2, 2, 2)) - sb.sdf.cylinder(0.5, 3.0)', '(-1.1, -1.1, -1.1)', '(1.1, 1.1, 1.1)', 128);
        expect(badEdgeCount(p)).toBe(0);
        const expected = 8 - Math.PI * 0.25 * 2;
        expect(Math.abs(signedVolume(p) - expected) / expected).toBeLessThan(0.015);
    }, 600000);

    it('keeps blended, transformed and displaced compositions closed and manifold', async () => {
        const p = await meshField(
            'sb.sdf.round_box((2.0, 1.0, 1.2), 0.15).union(sb.sdf.torus(0.45, 0.09).rotate((1, 0, 0), 90).translate((1.15, 0.05, 0)), k=0.12)' +
            '.subtract(sb.sdf.cylinder(0.25, 3.0), k=0.05).displace(0.01, 6.0)',
            '(-1.2, -0.7, -0.8)', '(1.7, 0.7, 0.8)', 160);
        expect(badEdgeCount(p)).toBe(0);
        expect(signedVolume(p)).toBeGreaterThan(1.5);
    }, 600000);

    it('caps a shape the bounds cut, so the result is still closed', async () => {
        const p = await meshField('sb.sdf.sphere(1.0)', '(-1, -1, 0)', '(1, 1, 1)', 64);
        expect(badEdgeCount(p)).toBe(0);
        const half = (2 / 3) * Math.PI;
        expect(signedVolume(p)).toBeGreaterThan(half * 0.9);
        expect(signedVolume(p)).toBeLessThan(half * 1.1);
    }, 600000);
});
