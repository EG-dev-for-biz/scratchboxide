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

describe('Native C++20 Fire Explosion Simulation Engine', () => {

    it('compiles and executes native C++20 fire explosion pipeline with Stokes drag, vorticity, Planckian radiation, and binary glTF export', async () => {
        const compiler = new NativeCppCompilerService();

        // Ensure include directory exists
        const sdkInclude = compiler.getSdkIncludePath();
        expect(fs.existsSync(sdkInclude)).toBe(true);

        const runnerPath = path.resolve(process.cwd(), 'scripts/run_fire_explosion_pipeline.cpp');
        expect(fs.existsSync(runnerPath)).toBe(true);

        // Compile C++20 pipeline binary
        const compileResult = await compiler.compileSource(fs.readFileSync(runnerPath, 'utf8'), {
            optimization: '-O3',
            outputBinaryName: 'run_fire_explosion_pipeline_test'
        });

        expect(compileResult.success).toBe(true);
        expect(compileResult.binaryPath).toBeDefined();
        expect(fs.existsSync(compileResult.binaryPath!)).toBe(true);

        // Execute binary with arguments: --frames 5 --output /tmp/fire_sim_test.glb
        const execResult = await compiler.executeBinary(compileResult.binaryPath!, [
            '--benchmark',
            '--output', '/tmp/fire_sim_test.glb'
        ]);

        expect(execResult.exitCode).toBe(0);
        expect(execResult.chunks.length).toBeGreaterThan(0);

        const chunk = execResult.chunks[0];
        expect(chunk.name).toBe('fire_explosion_mesh');
        expect(chunk.vertexCount).toBeGreaterThan(1000);
        expect(chunk.indexCount).toBeGreaterThan(1500);

        // Verify binary glTF 2.0 header (0x46546C67 = "glTF")
        const glbBuffer = Buffer.from(chunk.glbBase64, 'base64');
        const magic = glbBuffer.readUInt32LE(0);
        expect(magic).toBe(0x46546c67);
        const version = glbBuffer.readUInt32LE(4);
        expect(version).toBe(2);

        // Verify output file written to disk
        expect(fs.existsSync('/tmp/fire_sim_test.glb')).toBe(true);
        const diskFile = fs.readFileSync('/tmp/fire_sim_test.glb');
        expect(diskFile.readUInt32LE(0)).toBe(0x46546c67);
    }, 45000);

    it('verifies C++ header scratchbox_fire_simulation.hpp is properly integrated into scratchbox_engine.hpp', () => {
        const headerPath = path.resolve(process.cwd(), 'packages/core/src/native/3d-engine/include/scratchbox_fire_simulation.hpp');
        expect(fs.existsSync(headerPath)).toBe(true);

        const engineHeaderPath = path.resolve(process.cwd(), 'packages/core/src/native/3d-engine/include/scratchbox_engine.hpp');
        const engineHeader = fs.readFileSync(engineHeaderPath, 'utf8');
        expect(engineHeader).toContain('scratchbox_fire_simulation.hpp');

        const fireHeader = fs.readFileSync(headerPath, 'utf8');
        expect(fireHeader).toContain('class FireExplosionSimulation');
        expect(fireHeader).toContain('blackbody');
        expect(fireHeader).toContain('stokesDrag');
        expect(fireHeader).toContain('asymmetricHarmonicLobe');
        expect(fireHeader).toContain('toMesh');
    });
});
