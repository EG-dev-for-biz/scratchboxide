/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Compiles and runs an emitted C++20 generator source the same way the app does
 * (NativeCppCompilerService -> clang++ -std=c++20 -O3 -> execute -> streamed GLB chunk),
 * so tests can assert on the geometry the generator actually produces instead of on
 * the text of its source.
 */
import * as fs from 'fs';
import * as path from 'path';
import { NativeCppCompilerService } from '../../src/node/3d-engine/native-compiler-service';
import { inspectGlbBuffer, GlbInspectionData } from '../../src/node/3d-engine/photorealism-evaluator';
import type { Streamed3DChunk } from '../../src/common/3d-engine-protocol';
import { rasterizeGlbToTestScreenshot } from './test-screenshot-helper';

/** Compile + execute budget: a cold -O3 build of scratchbox_engine.hpp alone can take minutes on a busy machine. */
export const NATIVE_GENERATOR_TEST_TIMEOUT_MS = 600_000;

export interface EmittedGeneratorRun {
    chunk: Streamed3DChunk;
    glb: GlbInspectionData;
    triangleCount: number;
    bounds: { min: [number, number, number]; max: [number, number, number] };
    screenshotPath: string;
}

export async function compileAndRunEmittedGenerator(sourceCode: string, label: string): Promise<EmittedGeneratorRun> {
    const compiler = new NativeCppCompilerService();
    const outputDir = path.resolve(process.cwd(), 'build/3d-native');
    const binName = `${label}_${Date.now()}`;

    const compileRes = await compiler.compileSource(sourceCode, { outputDir, outputBinaryName: binName });
    try {
        if (!compileRes.success || !compileRes.binaryPath) {
            throw new Error(`clang++ rejected the emitted "${label}" generator:\n${compileRes.compilerOutput}`);
        }

        const execRes = await compiler.executeBinary(compileRes.binaryPath);
        if (!execRes.success) {
            throw new Error(`Emitted "${label}" generator exited with ${execRes.exitCode}:\n${execRes.stderr}`);
        }
        if (execRes.chunks.length !== 1) {
            throw new Error(`Emitted "${label}" generator streamed ${execRes.chunks.length} GLB chunks, expected 1`);
        }

        const chunk = execRes.chunks[0];
        // Fresh copy so the Float32Array views inside inspectGlbBuffer start 4-byte aligned
        const glbBytes = new Uint8Array(Buffer.from(chunk.glbBase64, 'base64'));
        const glb = inspectGlbBuffer(glbBytes);

        const min: [number, number, number] = [Infinity, Infinity, Infinity];
        const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < glb.positions.length; i += 3) {
            for (let axis = 0; axis < 3; axis++) {
                min[axis] = Math.min(min[axis], glb.positions[i + axis]);
                max[axis] = Math.max(max[axis], glb.positions[i + axis]);
            }
        }

        return {
            chunk,
            glb,
            triangleCount: chunk.indexCount / 3,
            bounds: { min, max },
            screenshotPath: rasterizeGlbToTestScreenshot(`native_generator_${label}`, glbBytes)
        };
    } finally {
        // The staged source and fresh binary are throwaway; a cache-hit binary lives in .cache and is kept.
        fs.rmSync(path.join(outputDir, `${binName}.cpp`), { force: true });
        if (compileRes.binaryPath && path.dirname(compileRes.binaryPath) === outputDir) {
            fs.rmSync(compileRes.binaryPath, { force: true });
        }
    }
}

/** Largest index referenced by the primitive; must be < vertexCount for a well-formed GLB. */
export function maxIndex(glb: GlbInspectionData): number {
    let m = -1;
    for (const i of glb.indices ?? []) {
        if (i > m) m = i;
    }
    return m;
}
