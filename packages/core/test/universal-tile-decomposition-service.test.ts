/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * UTDRA works on a given tile and reports what it measured: no domain is inferred, no confidence is invented, and
 * the bridge carver removes walls only inside a span box the caller gives (a tower with no bridge is left whole).
 */

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
    UniversalTileDecompositionService,
    UtdraService,
    UldraService,
    NativeCppCompilerService
} from '../src/node';
import { MissingInputError } from '../src/common/errors/pipeline-errors';
import {
    bridgeWithCurtainMesh,
    readGlbJson,
    readGlbPositions,
    rewriteGlbJson,
    skyscraperMesh,
    suburbanHouseMesh,
    writeFixtureGlb
} from './helpers/mesh-glb-fixtures';

// Every run takes a tile GLB; these synthetic tiles are written by the test (the pipeline builds none of its own).
const TILES = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-utdra-tiles-'));
const tile = {
    urban: writeFixtureGlb(path.join(TILES, 'urban.glb'), skyscraperMesh()),
    suburban: writeFixtureGlb(path.join(TILES, 'suburban.glb'), suburbanHouseMesh()),
    bridge: writeFixtureGlb(path.join(TILES, 'bridge.glb'), bridgeWithCurtainMesh())
};
const CLAY = { name: 'studio_clay', pbrMetallicRoughness: { baseColorFactor: [0.55, 0.57, 0.6, 1], metallicFactor: 0, roughnessFactor: 0.85 } };

/** A 1 m cube with no vertex colours. */
function writeUnitCube(file: string): string {
    const p = (x: number, y: number, z: number) => [x, y, z];
    const positions: number[] = [];
    const indices: number[] = [];
    const face = (a: number[], b: number[], c: number[], d: number[]) => {
        const base = positions.length / 3;
        positions.push(...a, ...b, ...c, ...d);
        indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    face(p(0, 0, 0), p(1, 0, 0), p(1, 1, 0), p(0, 1, 0));
    face(p(1, 0, 1), p(0, 0, 1), p(0, 1, 1), p(1, 1, 1));
    face(p(0, 0, 1), p(0, 0, 0), p(0, 1, 0), p(0, 1, 1));
    face(p(1, 0, 0), p(1, 0, 1), p(1, 1, 1), p(1, 1, 0));
    face(p(0, 1, 0), p(1, 1, 0), p(1, 1, 1), p(0, 1, 1));
    face(p(0, 0, 1), p(1, 0, 1), p(1, 0, 0), p(0, 0, 0));
    return writeFixtureGlb(file, { positions, indices });
}

describe('UTDRA / ULDRA: measurements, elevation slicing and span carving on a given tile', () => {
    const service = new UniversalTileDecompositionService();

    it('1. the native header measures and edits; it has no domain classifier or confidence table', () => {
        const header = fs.readFileSync(path.join(new NativeCppCompilerService().getSdkIncludePath(), 'scratchbox_utdra.hpp'), 'utf8');
        expect(header).toContain('namespace utdra');
        expect(header).toContain('class TileMeasurer');
        expect(header).toContain('class SutherlandHodgmanSlicer');
        expect(header).toContain('class SpanCurtainCarver');
        expect(header).not.toMatch(/GeographicDomain|DomainClassifier|float confidence|UniversalTilePipeline/);
    });

    it('2. every run needs a tile and a mode; the native runner refuses to build a stand-in mesh', async () => {
        await expect(service.run({ mode: 'probe' } as any)).rejects.toBeInstanceOf(MissingInputError);
        await expect(service.run({ inputGlbPath: path.join(TILES, 'missing.glb'), mode: 'probe' })).rejects.toThrow('does not exist');
        await expect(service.run({ inputGlbPath: tile.urban } as any)).rejects.toThrow('must be probe, slicer or bridge');
        await expect(service.run({ inputGlbPath: tile.urban, mode: 'full' as any })).rejects.toThrow('must be probe, slicer or bridge');
        await expect(service.run({ inputGlbPath: tile.urban, mode: 'slicer' })).rejects.toThrow('sliceElevationCutoff');
        const bin = await service.ensureBinary();
        const noInput = await promisify(execFile)(bin, ['--mode', 'probe']).catch(e => e);
        expect(noInput.code).toBe(2);
        expect(String(noInput.stderr)).toContain('--input <tile.glb> is required');
    }, 600000);

    it('3. a probe reports measurements only, matching the tile\'s own geometry, and writes no GLB', async () => {
        const urban = await service.probeTile(tile.urban);
        expect(urban).not.toHaveProperty('dominantDomain');
        expect(urban).not.toHaveProperty('confidence');
        expect(urban.reliefMeters).toBeCloseTo(180, 3);
        expect(urban.boundsMin).toEqual([-20, 0, -30]);
        expect(urban.boundsMax).toEqual([20, 180, 30]);
        // Walls 27,900 m² and roofs 4,350 m² of the three-tier tower.
        expect(urban.surfaceAreaM2).toBeCloseTo(32250, 0);
        expect(urban.slopeAreaFractions.vertical).toBeCloseTo(27900 / 32250, 4);
        expect(urban.slopeAreaFractions.horizontal).toBeCloseTo(4350 / 32250, 4);
        expect(urban.slopeAreaFractions.inclined).toBe(0);
        expect(urban.dominantWallYawDeg).toBeCloseTo(0.5, 3);

        // The gabled house's roof is inclined and its lawn is green in the vertex colours.
        const suburban = await service.probeTile(tile.suburban);
        expect(suburban.slopeAreaFractions.inclined).toBeGreaterThan(0.1);
        expect(suburban.vertexGreenIndex).toBeGreaterThan(0.1);

        // A 1 m cube with no vertex colours: measured as such, with no green index and no invented domain.
        const cube = await service.probeTile(writeUnitCube(path.join(TILES, 'cube.glb')));
        expect(cube.reliefMeters).toBeCloseTo(1, 5);
        expect(cube.surfaceAreaM2).toBeCloseTo(6, 4);
        expect(cube.slopeAreaFractions.vertical).toBeCloseTo(4 / 6, 4);
        expect(cube.vertexGreenIndex).toBeUndefined();
        const result = await service.run({ inputGlbPath: tile.urban, mode: 'probe' });
        expect(result.outputGlbPath).toBeUndefined();
        expect(result.glbBuffer).toBeUndefined();
    }, 600000);

    it('4. the slicer keeps what lies above the cut, clipping straddling walls, and keeps the clay material', async () => {
        const clayTower = rewriteGlbJson(writeFixtureGlb(path.join(TILES, 'clay_tower.glb'), skyscraperMesh()), g => {
            g.materials = [CLAY];
            g.meshes[0].primitives[0].material = 0;
        });
        const outputGlbPath = path.join(TILES, 'sliced.glb');
        const result = await service.sliceElevation(clayTower, 50, { outputGlbPath });
        expect(result.glbBuffer!.toString('utf8', 0, 4)).toBe('glTF');
        const { min, max } = readGlbPositions(outputGlbPath);
        expect(min[1]).toBeCloseTo(50, 3);
        expect(max[1]).toBeCloseTo(180, 3);
        expect(result.telemetry.reliefMeters).toBeCloseTo(130, 3);
        expect(readGlbJson(outputGlbPath).materials).toEqual([CLAY]);
    }, 600000);

    it('5. the carver needs a span box, removes only the near-vertical triangles inside it, and leaves a tower with no bridge whole', async () => {
        await expect(service.run({ inputGlbPath: tile.bridge, mode: 'bridge' })).rejects.toThrow(/span/);

        const carved = await service.carveBridgeUnderpass(tile.bridge,
            { minX: -10, maxX: 10, minZ: -2, maxZ: 2, groundY: 0, deckY: 12 },
            { minVoidHeightMeters: 3.5, outputGlbPath: path.join(TILES, 'carved_bridge.glb') });
        expect(carved.telemetry.inputTriangles).toBe(2);
        expect(carved.telemetry.removedTriangles).toBe(1);
        expect(carved.telemetry.outputTriangles).toBe(1);
        // The deck stays.
        expect(readGlbPositions(carved.outputGlbPath!).min[1]).toBeCloseTo(12, 4);

        // The review's tower: a span box beside it removes nothing, and the 30 triangles stay.
        const tower = await service.carveBridgeUnderpass(tile.urban,
            { minX: 100, maxX: 140, minZ: -10, maxZ: 10, groundY: 0, deckY: 12 },
            { outputGlbPath: path.join(TILES, 'carved_tower.glb') });
        expect(tower.telemetry.inputTriangles).toBe(30);
        expect(tower.telemetry.removedTriangles).toBe(0);
        expect(tower.telemetry.outputTriangles).toBe(30);

        // A span lower than the asked clearance is refused.
        await expect(service.carveBridgeUnderpass(tile.bridge, { minX: -10, maxX: 10, minZ: -2, maxZ: 2, groundY: 0, deckY: 2 }, { minVoidHeightMeters: 3.5 }))
            .rejects.toThrow(/clearance/);
    }, 600000);

    it('6. the UtdraService and UldraService aliases are the same service', async () => {
        expect(new UtdraService()).toBeInstanceOf(UniversalTileDecompositionService);
        expect(new UldraService()).toBeInstanceOf(UniversalTileDecompositionService);
        const probe = await new UldraService().probeTile(tile.suburban);
        expect(probe.inputTriangles).toBeGreaterThan(0);
    }, 600000);
});

afterAll(() => fs.rmSync(TILES, { recursive: true, force: true }));
