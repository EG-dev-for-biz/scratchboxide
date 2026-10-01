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
            expect(chunk.vertexCount).toBeGreaterThan(100);
            expect(chunk.indexCount).toBeGreaterThan(100);
            expect(chunk.glbBase64.length).toBeGreaterThan(500);

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
