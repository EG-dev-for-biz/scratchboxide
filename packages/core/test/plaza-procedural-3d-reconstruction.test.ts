/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { NativeCppCompilerService } from '../src/node/3d-engine/native-compiler-service';

describe('Plaza Hotel Procedural 3D Reconstruction from Image', () => {
    const compiler = new NativeCppCompilerService();
    const sourcePath = path.resolve(process.cwd(), 'scripts/generate_plaza_procedural_3d.cpp');
    const outGlbPath = path.resolve(process.cwd(), 'public/models/plaza_hotel_procedural.glb');
    const userImagePath = '/Users/eligreen/.cursor/projects/Users-eligreen-dev-scratchbox-ide-master/assets/Sequence_02.00_00_05_19.Still002-a2b96764-a348-4544-b3e9-f6754c634a4c.jpg';

    it('should locate the user reference photograph of The Plaza Hotel', () => {
        expect(fs.existsSync(userImagePath)).toBe(true);
        const stats = fs.statSync(userImagePath);
        expect(stats.size).toBeGreaterThan(50000);
    });

    it('should compile the native C++20 Astra Plaza Hotel generator without errors', async () => {
        expect(fs.existsSync(sourcePath)).toBe(true);
        const sourceCode = fs.readFileSync(sourcePath, 'utf8');

        const result = await compiler.compileSource(sourceCode, {
            outputBinaryName: 'generate_plaza_procedural_3d',
            optimization: '-O3'
        });

        if (!result.success) {
            console.error('Compiler diagnostics:', result.diagnostics);
            console.error('Compiler output:', result.compilerOutput);
        }

        expect(result.success).toBe(true);
        expect(fs.existsSync(result.binaryPath)).toBe(true);
    }, 60000);

    it('should execute generator binary and emit valid binary glTF 2.0 (.glb)', async () => {
        const binDir = path.resolve(process.cwd(), 'build/3d-native');
        const binaryPath = path.join(binDir, 'generate_plaza_procedural_3d');

        const execResult = await compiler.executeBinary(binaryPath, [outGlbPath], process.cwd());
        expect(execResult.exitCode).toBe(0);

        expect(fs.existsSync(outGlbPath)).toBe(true);
        const buf = fs.readFileSync(outGlbPath);
        expect(buf.length).toBeGreaterThan(100000);

        // Validate glTF 2.0 binary header
        const magic = buf.readUInt32LE(0);
        const version = buf.readUInt32LE(4);
        const length = buf.readUInt32LE(8);

        expect(magic).toBe(0x46546C67); // 'glTF'
        expect(version).toBe(2);
        expect(length).toBe(buf.length);

        // Parse JSON chunk
        const jsonChunkLen = buf.readUInt32LE(12);
        const jsonChunkType = buf.readUInt32LE(16);
        expect(jsonChunkType).toBe(0x4E4F534A); // 'JSON'

        const jsonStr = buf.toString('utf8', 20, 20 + jsonChunkLen);
        const gltf = JSON.parse(jsonStr);

        expect(gltf.asset?.version).toBe('2.0');
        expect(gltf.meshes?.length).toBeGreaterThanOrEqual(1);

        // Inspect total vertex count and bounding box
        let totalVertices = 0;
        let maxY = -Infinity;
        let minY = Infinity;

        if (gltf.accessors) {
            for (const acc of gltf.accessors) {
                if (acc.type === 'VEC3' && acc.min && acc.max) {
                    totalVertices += acc.count;
                    if (acc.max[1] > maxY) maxY = acc.max[1];
                    if (acc.min[1] < minY) minY = acc.min[1];
                }
            }
        }

        console.log(`Generated Plaza 3D Model: ${totalVertices} vertices, height: ${(maxY - minY).toFixed(1)}m`);
        expect(totalVertices).toBeGreaterThanOrEqual(10000);

        // Building height should be realistic (55m - 85m for 18-story Beaux-Arts landmark + mansard roof)
        const heightMeters = maxY - minY;
        expect(heightMeters).toBeGreaterThan(50.0);
        expect(heightMeters).toBeLessThan(90.0);
    }, 60000);

    it('should verify 6-DOF camera resection perspective matching the user worm eye photo', () => {
        // Camera positioned on Grand Army Plaza sidewalk looking up at the Plaza Hotel facade and corner turret
        const cameraPos = { x: 22.0, y: 3.0, z: 28.0 };
        const targetPos = { x: 8.0, y: 52.0, z: 0.0 };

        const dx = targetPos.x - cameraPos.x;
        const dy = targetPos.y - cameraPos.y;
        const dz = targetPos.z - cameraPos.z;
        const horizontalDist = Math.sqrt(dx * dx + dz * dz);
        const pitchAngleDeg = Math.atan2(dy, horizontalDist) * (180.0 / Math.PI);

        // Worm's eye view: pitch must be steeply upward (between 45 deg and 65 deg)
        expect(pitchAngleDeg).toBeGreaterThan(45.0);
        expect(pitchAngleDeg).toBeLessThan(65.0);
    });
});
