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
import { synthesizeContextual3DScene } from '../src/browser/generative-canvas/procedural-3d-synthesizer';

describe('Native C++20 Google 3D Tile Ingestion & Clay Rendering Pipeline', () => {
    const compiler = new NativeCppCompilerService();

    it('should verify scratchbox_tiles.hpp exists in SDK include directory', () => {
        const includePath = compiler.getSdkIncludePath();
        expect(fs.existsSync(path.join(includePath, 'scratchbox_tiles.hpp'))).toBe(true);
    });

    it('should compile and verify TileIngestor terrain generation, tile buffer ingestion, and GLB chunk streaming', async () => {
        const source = `#include "scratchbox_engine.hpp"
#include <iostream>
#include <cassert>

int main() {
    using namespace scratchbox::tiles;
    using namespace scratchbox::io;

    // 1. Create a TileRegionAnchor for San Francisco Ferry Building
    TileRegionAnchor anchor{
        .latDeg = 37.7955,
        .lngDeg = -122.3937,
        .altitudeMeters = 0.0,
        .landmarkName = "SFFerryBuilding",
        .groundRadiusMeters = 150.0f,
        .clayPreset = ClayPreset::ARCHITECTURAL_WHITE
    };

    // 2. Synthesize undulating terrain patch
    auto terrain = TileIngestor::createTerrainPatch(anchor, 120.0f, 20);
    assert(!terrain.vertices.empty());
    assert(!terrain.indices.empty());
    assert(terrain.vertices.size() == 21 * 21);
    assert(terrain.indices.size() == 20 * 20 * 6);

    // 3. Ingest simulated photorealistic tile vertex/index buffers
    std::vector<float> positions = {
        0.0f, 0.0f, 0.0f,
        10.0f, 0.0f, 0.0f,
        10.0f, 25.0f, 0.0f,
        0.0f, 25.0f, 0.0f
    };
    std::vector<uint32_t> indices = { 0, 1, 2, 0, 2, 3 };
    std::vector<float> normals = {
        0.0f, 0.0f, 1.0f,
        0.0f, 0.0f, 1.0f,
        0.0f, 0.0f, 1.0f,
        0.0f, 0.0f, 1.0f
    };
    std::vector<float> uvs = {
        0.0f, 0.0f,
        1.0f, 0.0f,
        1.0f, 1.0f,
        0.0f, 1.0f
    };

    auto building = TileIngestor::ingestTileBuffers(
        "FerryBuildingTower",
        positions,
        indices,
        normals,
        uvs,
        ClayPreset::SANDSTONE
    );
    assert(building.vertices.size() == 4);
    assert(building.indices.size() == 6);

    // 4. Merge terrain and architectural features into composite mesh
    auto composite = TileIngestor::mergeMeshes({ terrain, building }, "CompositeScene");
    assert(composite.vertices.size() == terrain.vertices.size() + building.vertices.size());
    assert(composite.indices.size() == terrain.indices.size() + building.indices.size());

    // 5. Generate geospatial solar lighting
    auto lights = TileIngestor::createGeospatialLighting(anchor.latDeg, anchor.lngDeg, 14.5f);
    assert(lights.size() == 2);
    assert(lights[0].name == "GeospatialSun");

    // 6. Stream binary glTF 2.0 chunk
    GlbWriter::streamChunk(composite, composite.name);

    std::cout << "TILE_INGESTION_OK: Vertices=" << composite.vertices.size()
              << " Indices=" << composite.indices.size() << std::endl;
    return 0;
}
`;
        const res = await compiler.compileSource(source, {
            name: 'test_tile_ingestor_' + Date.now(),
            optimization: '-O3'
        });

        expect(res.success).toBe(true);
        expect(res.binaryPath).toBeDefined();

        if (res.binaryPath) {
            const execRes = await compiler.executeBinary(res.binaryPath);
            expect(execRes.exitCode).toBe(0);
            expect(execRes.stdout).toContain('TILE_INGESTION_OK: Vertices=445 Indices=2406');
            expect(execRes.chunks.length).toBeGreaterThan(0);
            expect(execRes.glbBase64).toBeDefined();
            expect(execRes.chunks[0].glbBase64.length).toBeGreaterThan(100);
            fs.unlinkSync(res.binaryPath);
        }
    });

    it('never places a template scene on Earth from prompt words, and has no landmark tower generator', async () => {
        // A place named in a prompt is not looked up in a table: the template scene gets no anchor.
        expect(synthesizeContextual3DScene('Create a 3d model of Ferry Building San Francisco in warm terracotta').geoAnchor).toBeUndefined();
        // Every battle prompt used to be anchored at Lexington Battle Green, MA, at an invented 68 m.
        for (const prompt of ['build a 3d scene of the battle of gettysburg', 'build a 3d scene of the battle of waterloo', 'a siege in 1776']) {
            expect(synthesizeContextual3DScene(prompt).geoAnchor, prompt).toBeUndefined();
        }
        // The generator that wrote a 32 m stepped tower named after any landmark is gone.
        const synthesizer: Record<string, unknown> = await import('../src/browser/generative-canvas/procedural-3d-synthesizer');
        expect(synthesizer.generateGeospatialCpp3DSource).toBeUndefined();
    });
});
