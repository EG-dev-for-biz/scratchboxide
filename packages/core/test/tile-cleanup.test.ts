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
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
    PhotorealTileCleanupService,
    NativeCppCompilerService
} from '../src/node';
import { MissingInputError } from '../src/common/errors/pipeline-errors';
import { nativeBinaryIsFresh } from '../src/node/3d-engine/native-build';

// A real building GLB from the repo (an SB-Archi temple), used as the tile to clean.
const INPUT_GLB = path.resolve(__dirname, '../../../deploy/cloud-run/spatial-separator/assets/temple_venus_roma_sb_archi.glb');

/** Triangle count of a GLB, read from its own accessors (indexed or not). */
function glbTriangleCount(file: string): number {
    const buf = fs.readFileSync(file);
    const jsonLen = buf.readUInt32LE(12);
    const gltf = JSON.parse(buf.toString('utf8', 20, 20 + jsonLen));
    let tris = 0;
    for (const mesh of gltf.meshes ?? []) {
        for (const prim of mesh.primitives ?? []) {
            if (prim.mode !== undefined && prim.mode !== 4) continue;
            const acc = prim.indices !== undefined ? gltf.accessors[prim.indices] : gltf.accessors[prim.attributes.POSITION];
            tris += acc.count / 3;
        }
    }
    return tris;
}

describe('3D Photogrammetry & Tile Cleanup Pipeline (In-App / Cloud Run)', () => {
    const service = new PhotorealTileCleanupService();

    it('1. should verify native C++20 tile cleanup headers are accessible', () => {
        const compiler = new NativeCppCompilerService();
        const sdkInclude = compiler.getSdkIncludePath();
        expect(fs.existsSync(sdkInclude)).toBe(true);

        const headerPath = path.join(sdkInclude, 'scratchbox_tile_cleanup.hpp');
        expect(fs.existsSync(headerPath)).toBe(true);

        const headerContent = fs.readFileSync(headerPath, 'utf8');
        expect(headerContent).toContain('namespace cleanup');
        expect(headerContent).toContain('class PlanarDecimator');
        expect(headerContent).toContain('class CornerStraightener');
        expect(headerContent).toContain('class TileTextureDeLighter');
        expect(headerContent).toContain('class SemanticMeshSeparator');
        expect(headerContent).toContain('class ElevationConformer');
    });

    it('2. cleans the tile it is given (triangle counts come from the input GLB)', async () => {
        const binPath = await service.ensureBinary();
        expect(fs.existsSync(binPath)).toBe(true);
        // Built through native-build: the binary is the shared build cache's entry for its current sources.
        expect(nativeBinaryIsFresh({ source: path.resolve(process.cwd(), 'scripts/run_tile_cleanup_pipeline.cpp'), binary: binPath, includeDir: path.resolve(process.cwd(), 'packages/core/src/native/3d-engine/include'), libs: ['-lz'] })).toBe(true);

        const result = await service.cleanPhotogrammetryTile({
            inputGlbPath: INPUT_GLB,
            angleThresholdDegrees: 4.0,
            snapToleranceMeters: 0.85,
            roadWidthMeters: 8.0
        });

        expect(result.success).toBe(true);
        expect(result.stdout).toContain(INPUT_GLB);
        expect(result.metrics.rawTriangles).toBe(glbTriangleCount(INPUT_GLB));
        expect(result.metrics.decimatedTriangles).toBeLessThanOrEqual(result.metrics.rawTriangles);
        expect(result.metrics.facadeTriangles + result.metrics.rooftopTriangles).toBeGreaterThan(0);

        expect(result.glbBuffer).toBeDefined();
        expect(result.glbBuffer!.toString('utf8', 0, 4)).toBe('glTF');
        expect(result.glbBase64!.length).toBeGreaterThan(1000);

        const cues = result.metrics.textureInformedCues!;
        expect(cues.partitionedSubmeshCount).toBe(cues.submeshDetails!.length);
        expect(cues.submeshDetails!.reduce((a, s) => a + s.triangles, 0)).toBeGreaterThan(0);
    });

    it('3. passes paths as arguments, never through a shell', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-tile-cleanup-'));
        // A shell would expand $(...) and split on the quote and semicolon; as an argument the name is used literally.
        const tricky = path.join(dir, 'tile "$(id)" ; x.glb');
        fs.copyFileSync(INPUT_GLB, tricky);
        try {
            const result = await service.cleanPhotogrammetryTile({
                inputGlbPath: tricky,
                outputGlbPath: path.join(dir, 'out $(id).glb'),
                patina: { buildingAgeYears: 90, sootCavityIntensity: 0.85 }
            });
            expect(result.metrics.rawTriangles).toBe(glbTriangleCount(INPUT_GLB));
            expect(result.metrics.biophysicalPatina).toBeDefined();
            expect(fs.existsSync(path.join(dir, 'out $(id).glb'))).toBe(true);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('4. refuses without an input tile instead of cleaning a built-in model', async () => {
        await expect(service.cleanPhotogrammetryTile({})).rejects.toBeInstanceOf(MissingInputError);
        await expect(
            service.cleanPhotogrammetryTile({ inputGlbPath: path.join(os.tmpdir(), 'no_such_tile_8c1f.glb') })
        ).rejects.toBeInstanceOf(MissingInputError);

        const binPath = await service.ensureBinary();
        const err: any = await promisify(execFile)(binPath, ['--output', path.join(os.tmpdir(), 'unused.glb')]).catch(e => e);
        expect(err.code).toBe(2);
        expect(String(err.stderr)).toContain('--input');
    });
});
