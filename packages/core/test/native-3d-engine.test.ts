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
import { NativeCppCompilerService } from '../src/node/3d-engine/native-compiler-service';

/**
 * Welds the first primitive of a GLB by exact position and measures its surface topology:
 * how many triangles use each undirected edge, connected components, and V - E + F.
 */
function auditGlbTopology(glb: Buffer) {
    const jsonLength = glb.readUInt32LE(12);
    const gltf = JSON.parse(glb.subarray(20, 20 + jsonLength).toString('utf8').replace(/[\0\s]+$/, ''));
    const binStart = 20 + jsonLength + 8;
    const prim = gltf.meshes[0].primitives[0];
    const accessorStart = (index: number) => {
        const accessor = gltf.accessors[index];
        const view = gltf.bufferViews[accessor.bufferView];
        return { count: accessor.count as number, offset: binStart + (view.byteOffset || 0) + (accessor.byteOffset || 0) };
    };

    const pos = accessorStart(prim.attributes.POSITION);
    const welded = new Map<string, number>();
    const remap: number[] = [];
    for (let v = 0; v < pos.count; v++) {
        const o = pos.offset + v * 12;
        const key = `${glb.readFloatLE(o)},${glb.readFloatLE(o + 4)},${glb.readFloatLE(o + 8)}`;
        if (!welded.has(key)) welded.set(key, welded.size);
        remap.push(welded.get(key)!);
    }

    const idx = accessorStart(prim.indices);
    const edgeUse = new Map<string, number>();
    const parent = Array.from({ length: welded.size }, (_, i) => i);
    const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
    for (let t = 0; t < idx.count; t += 3) {
        const tri = [0, 1, 2].map(k => remap[glb.readUInt32LE(idx.offset + (t + k) * 4)]);
        for (let e = 0; e < 3; e++) {
            const a = tri[e], b = tri[(e + 1) % 3];
            const key = a < b ? `${a}-${b}` : `${b}-${a}`;
            edgeUse.set(key, (edgeUse.get(key) || 0) + 1);
            parent[find(a)] = find(b);
        }
    }

    const histogram: Record<number, number> = {};
    for (const uses of edgeUse.values()) histogram[uses] = (histogram[uses] || 0) + 1;
    const components = parent.filter((p, i) => find(i) === i).length;
    return {
        weldedVertices: welded.size,
        triangles: idx.count / 3,
        edges: edgeUse.size,
        histogram,
        components,
        euler: welded.size - edgeUse.size + idx.count / 3
    };
}

describe('NativeCppCompilerService & C++20 3D Engine Core', () => {
    const compiler = new NativeCppCompilerService();

    it('should locate valid scratchbox_engine include directory', () => {
        const includePath = compiler.getSdkIncludePath();
        expect(fs.existsSync(includePath)).toBe(true);
        expect(fs.existsSync(path.join(includePath, 'scratchbox_engine.hpp'))).toBe(true);
        expect(fs.existsSync(path.join(includePath, 'scratchbox_math.hpp'))).toBe(true);
        expect(fs.existsSync(path.join(includePath, 'scratchbox_geometry.hpp'))).toBe(true);
        expect(fs.existsSync(path.join(includePath, 'scratchbox_sdf.hpp'))).toBe(true);
        expect(fs.existsSync(path.join(includePath, 'scratchbox_physics.hpp'))).toBe(true);
        expect(fs.existsSync(path.join(includePath, 'scratchbox_kinematics.hpp'))).toBe(true);
        expect(fs.existsSync(path.join(includePath, 'scratchbox_skinning.hpp'))).toBe(true);
        expect(fs.existsSync(path.join(includePath, 'scratchbox_io.hpp'))).toBe(true);
    });

    it('should parse Clang compiler diagnostic errors accurately', () => {
        const mockStderr = `/tmp/test.cpp:15:22: error: use of undeclared identifier 'foo'
/tmp/test.cpp:20:5: warning: unused variable 'bar' [-Wunused-variable]
/tmp/test.cpp:42:1: fatal error: 'missing.hpp' file not found`;

        const diagnostics = compiler.parseDiagnostics(mockStderr);
        expect(diagnostics.length).toBe(3);

        expect(diagnostics[0].severity).toBe('error');
        expect(diagnostics[0].line).toBe(15);
        expect(diagnostics[0].column).toBe(22);
        expect(diagnostics[0].message).toContain("undeclared identifier 'foo'");

        expect(diagnostics[1].severity).toBe('warning');
        expect(diagnostics[1].line).toBe(20);

        expect(diagnostics[2].severity).toBe('fatal error');
        expect(diagnostics[2].line).toBe(42);
    });

    it('should compile and execute native C++20 geometry generator with binary glTF 2.0 streaming', async () => {
        const source = `#include "scratchbox_engine.hpp"
#include <iostream>

int main() {
    using namespace scratchbox;

    // 1. Generate Marching Cubes SDF sphere
    auto mesh = geometry::MarchingCubes::extractIsosurface(
        [](const math::Vec3& p) { return sdf::sdSphere(p, 1.0f); },
        math::AABB({-1.2f, -1.2f, -1.2f}, {1.2f, 1.2f, 1.2f}),
        14,
        0.0f,
        math::Vec4(0.2f, 0.6f, 1.0f, 1.0f)
    );

    // 2. Stream chunk
    io::GlbWriter::streamChunk(mesh, "unit-sphere-test");
    return 0;
}
`;

        const compileRes = await compiler.compileSource(source, {
            outputBinaryName: `test_sphere_${Date.now()}`
        });

        expect(compileRes.success).toBe(true);
        expect(compileRes.binaryPath).toBeDefined();

        if (compileRes.binaryPath) {
            const execRes = await compiler.executeBinary(compileRes.binaryPath);
            expect(execRes.success).toBe(true);
            expect(execRes.chunks.length).toBe(1);

            const chunk = execRes.chunks[0];
            expect(chunk.name).toBe('unit-sphere-test');
            // Marching cubes on a 14^3 lattice: one vertex per sign-changing lattice edge,
            // closed genus-0 surface so F = 2V - 4.
            expect(chunk.vertexCount).toBe(654);
            expect(chunk.indexCount).toBe(1304 * 3);
            expect(chunk.glbBase64.length).toBeGreaterThan(500);

            // Vertices are shared, not duplicated: welding by position changes nothing,
            // every edge borders exactly two triangles, and the sphere is one closed shell.
            const topology = auditGlbTopology(Buffer.from(chunk.glbBase64, 'base64'));
            expect(topology.weldedVertices).toBe(654);
            expect(topology.triangles).toBe(1304);
            expect(topology.histogram).toEqual({ 2: 1956 });
            expect(topology.components).toBe(1);
            expect(topology.euler).toBe(2);

            // Clean up binary
            try {
                if (fs.existsSync(compileRes.binaryPath)) {
                    fs.unlinkSync(compileRes.binaryPath);
                }
            } catch {}
        }
    }, 45000);

    it('should report compilation failure on invalid C++ code with diagnostics', async () => {
        const brokenSource = `#include "scratchbox_engine.hpp"
int main() {
    this_is_a_syntax_error();
    return 0;
}
`;
        const res = await compiler.compileSource(brokenSource, {
            outputBinaryName: `test_broken_${Date.now()}`
        });

        expect(res.success).toBe(false);
        expect(res.diagnostics.length).toBeGreaterThan(0);
        expect(res.diagnostics.some(d => d.message.includes('this_is_a_syntax_error'))).toBe(true);
    });
});
