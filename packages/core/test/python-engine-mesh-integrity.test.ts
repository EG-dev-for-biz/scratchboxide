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

interface GlbPrimitive { positions: number[]; indices: number[]; material: number }

function readGlb(file: string): { json: any; primitives: GlbPrimitive[] } {
    const buf = fs.readFileSync(file);
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
    const primitives = json.meshes.flatMap((m: any) => m.primitives.map((p: any) => ({
        positions: read(p.attributes.POSITION),
        indices: read(p.indices),
        material: p.material
    })));
    return { json, primitives };
}

function openEdgeCount(p: GlbPrimitive): number {
    const key = (i: number) => [0, 1, 2].map(k => Math.round(p.positions[i * 3 + k] * 1000)).join(',');
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

describe('Python engine mesh & material integrity', () => {
    it('exports watertight cylinders with outward caps and one shared clay material across merged parts', async () => {
        const runner = NativePythonRunnerService.getInstance();
        const result = await runner.runScript(`
import scratchbox as sb
scene = sb.geometry.Mesh("Integrity")
scene.merge(sb.create_cylinder(radius_top=1.0, radius_bottom=2.0, height=3.0, segments=16))
scene.merge(sb.create_cylinder(radius=0.5, height=1.0, segments=12))
scene.apply_material(sb.PbrMaterial.clay())
sb.io.write_glb(OUTPUT_GLB_PATH, scene)
`, { timeoutMs: 60000 });

        expect(result.success, result.errorDetails || result.stderr).toBe(true);
        const { json, primitives } = readGlb(result.glbPath!);

        expect(primitives.length).toBe(2);
        for (const p of primitives) {
            expect(openEdgeCount(p)).toBe(0);
        }

        // Cap triangles (flat in Y) must face away from the mesh: up on the top cap, down on the bottom cap.
        const frustum = primitives[0];
        let capTris = 0;
        for (let t = 0; t < frustum.indices.length; t += 3) {
            const v = [0, 1, 2].map(k => frustum.indices[t + k]).map(i => frustum.positions.slice(i * 3, i * 3 + 3));
            if (Math.abs(v[0][1] - v[1][1]) > 1e-4 || Math.abs(v[0][1] - v[2][1]) > 1e-4) continue;
            const u = [v[1][0] - v[0][0], v[1][2] - v[0][2]];
            const w = [v[2][0] - v[0][0], v[2][2] - v[0][2]];
            const normalY = u[1] * w[0] - u[0] * w[1];
            expect(Math.sign(normalY)).toBe(Math.sign(v[0][1]));
            capTris++;
        }
        expect(capTris).toBe(32);

        expect(json.materials).toHaveLength(1);
        expect(json.materials[0].name).toBe('clay');
        expect(json.materials[0].pbrMetallicRoughness.roughnessFactor).toBeCloseTo(0.85, 2);
        expect(new Set(primitives.map(p => p.material))).toEqual(new Set([0]));
    }, 120000);
});
