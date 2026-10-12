import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import { synthesizeContextual3DScene } from '../src/browser/generative-canvas/procedural-3d-synthesizer';
import { GeometricComplexityGate } from '../src/common/spatial/GeometricComplexityGate';
import { compileAndRunEmittedGenerator, maxIndex, NATIVE_GENERATOR_TEST_TIMEOUT_MS } from './helpers/native-generator-harness';

const EPS = 1e-3;
const PIER_Z = [-48, -20, 20, 48];
const COLUMN_X = [-4.2, 4.2];
const COLUMN_RADIUS = 1.2;
const COLUMN_SEGMENTS = 48;

/** ScratchboxMesh::createSubdividedBox emits a (u + 1) x (v + 1) vertex grid and 2uv triangles on each of its 6 faces. */
function subdividedBoxCounts(sx: number, sy: number, sz: number): { vertices: number; triangles: number } {
    return {
        vertices: 2 * ((sx + 1) * (sy + 1) + (sz + 1) * (sy + 1) + (sx + 1) * (sz + 1)),
        triangles: 4 * (sx * sy + sz * sy + sx * sz)
    };
}

describe('Highway overpass C++20 viaduct generator', () => {
    it('compiles and executes the emitted deck, pier columns and crossheads', async () => {
        // "viaduct" selects the highway_overpass theme; "highway" or "bridge" would be recast to a worldbuilder location scene.
        const scene = synthesizeContextual3DScene('Model a concrete viaduct on reinforced pier bents');
        expect(scene.sceneType).toBe('highway_overpass');
        expect(scene.cppGenerator?.enabled).toBe(true);
        const sourceCode = scene.cppGenerator?.sourceCode;
        if (!sourceCode) {
            throw new Error('highway_overpass scene emitted no cppGenerator.sourceCode');
        }

        const run = await compileAndRunEmittedGenerator(sourceCode, 'highway_overpass');
        expect(run.chunk.name).toBe('Highway_Overpass_Viaduct');
        expect(run.glb.vertexCount).toBe(run.chunk.vertexCount);
        expect(run.glb.indexCount).toBe(run.chunk.indexCount);
        expect(run.chunk.indexCount % 3).toBe(0);
        expect(maxIndex(run.glb)).toBeLessThan(run.chunk.vertexCount);

        // One 30 x 4 x 280 deck box, four 32 x 4 x 8 crosshead boxes and eight 48-segment column shells
        const deck = subdividedBoxCounts(30, 4, 280);
        const crosshead = subdividedBoxCounts(32, 4, 8);
        const column = { vertices: 2 * (COLUMN_SEGMENTS + 1), triangles: 2 * COLUMN_SEGMENTS };
        expect(run.chunk.vertexCount).toBe(deck.vertices + 4 * crosshead.vertices + 8 * column.vertices);
        expect(run.triangleCount).toBe(deck.triangles + 4 * crosshead.triangles + 8 * column.triangles);
        expect(run.chunk.vertexCount).toBeGreaterThanOrEqual(GeometricComplexityGate.DEFAULT_SCENE_MIN_VERTICES);
        expect(run.triangleCount).toBeGreaterThanOrEqual(GeometricComplexityGate.DEFAULT_SCENE_MIN_TRIANGLES);

        // Whole structure: piers stand on y = 0, deck top at y = 11.2 spanning z = +-70,
        // and the 16.2 m crossheads are the only parts reaching past the 15 m deck in x.
        const { min, max } = run.bounds;
        expect(min[0]).toBeCloseTo(-8.1, 3);
        expect(max[0]).toBeCloseTo(8.1, 3);
        expect(min[1]).toBeCloseTo(0, 3);
        expect(max[1]).toBeCloseTo(11.2, 3);
        expect(min[2]).toBeCloseTo(-70, 3);
        expect(max[2]).toBeCloseTo(70, 3);

        const positions = run.glb.positions;
        const normals = run.glb.normals;
        const vertexCount = run.glb.vertexCount;
        const nearPier = (z: number, halfDepth: number) => PIER_Z.some(pz => Math.abs(z - pz) <= halfDepth + EPS);

        // Deck: above the crosshead tops (y > 10.1) only deck vertices remain. They span x = +-7.5 and z = +-70
        // and stay inside the box-girder webs, which run from 7.5 m off-centre at y = 11.2 to 6.5 m at y = 9.8.
        const deckX: number[] = [];
        const deckZ: number[] = [];
        let topVertices = 0;
        let soffitHalfWidth = 0;
        for (let v = 0; v < vertexCount; v++) {
            const [x, y, z] = [positions[3 * v], positions[3 * v + 1], positions[3 * v + 2]];
            if (y > 10.1 + EPS) {
                deckX.push(x);
                deckZ.push(z);
                expect(Math.abs(x)).toBeLessThanOrEqual(6.5 + (y - 9.8) / 1.4 + EPS);
            }
            if (Math.abs(y - 11.2) < EPS) {
                topVertices++;
                // Inside the top slab the smoothed normal is straight up, so the deck faces are wound outward
                if (Math.abs(x) < 7.5 - 0.5 && Math.abs(z) < 70 - 0.5) {
                    expect(normals[3 * v + 1]).toBeGreaterThan(0.999);
                }
            }
            if (Math.abs(y - 9.8) < EPS) {
                soffitHalfWidth = Math.max(soffitHalfWidth, Math.abs(x));
                if (Math.abs(x) < 6.5 - 0.5 && Math.abs(z) < 70 - 0.5 && !nearPier(z, COLUMN_RADIUS)) {
                    expect(normals[3 * v + 1]).toBeLessThan(-0.999);
                }
            }
        }
        expect(Math.min(...deckX)).toBeCloseTo(-7.5, 3);
        expect(Math.max(...deckX)).toBeCloseTo(7.5, 3);
        expect(Math.min(...deckZ)).toBeCloseTo(-70, 3);
        expect(Math.max(...deckZ)).toBeCloseTo(70, 3);
        expect(soffitHalfWidth).toBeCloseTo(6.5, 3);
        // Top face grid (31 x 281) plus the top rows of both webs and both end caps
        expect(topVertices).toBe(31 * 281 + 2 * 281 + 2 * 31);

        // Piers: the only vertices on the ground are the column footings, 49 per column, each 1.2 m from its axis.
        const footings = new Map<string, number>();
        for (let v = 0; v < vertexCount; v++) {
            const [x, y, z] = [positions[3 * v], positions[3 * v + 1], positions[3 * v + 2]];
            if (Math.abs(y) >= EPS) continue;
            const axis = PIER_Z.flatMap(pz => COLUMN_X.map(cx => ({ cx, pz })))
                .find(({ cx, pz }) => Math.abs(Math.hypot(x - cx, z - pz) - COLUMN_RADIUS) < EPS);
            expect(axis, `ground vertex (${x}, ${y}, ${z}) is not on a column footing`).toBeDefined();
            const key = `${axis!.cx},${axis!.pz}`;
            footings.set(key, (footings.get(key) ?? 0) + 1);
        }
        expect(footings.size).toBe(8);
        for (const count of footings.values()) {
            expect(count).toBe(COLUMN_SEGMENTS + 1);
        }

        // Crossheads: everything outboard of the deck edge is crosshead, 1.4 m deep about y = 9.4 and 2.8 m long about each pier.
        const crossheadY: number[] = [];
        const crossheadPiers = new Set<number>();
        for (let v = 0; v < vertexCount; v++) {
            const [x, y, z] = [positions[3 * v], positions[3 * v + 1], positions[3 * v + 2]];
            if (Math.abs(x) <= 7.5 + EPS) continue;
            crossheadY.push(y);
            const pz = PIER_Z.find(p => Math.abs(z - p) <= 1.4 + EPS);
            expect(pz, `outboard vertex (${x}, ${y}, ${z}) is not on a crosshead`).toBeDefined();
            crossheadPiers.add(pz!);
        }
        expect(Math.min(...crossheadY)).toBeCloseTo(8.7, 3);
        expect(Math.max(...crossheadY)).toBeCloseTo(10.1, 3);
        expect(crossheadPiers.size).toBe(4);

        expect(fs.statSync(run.screenshotPath).size).toBeGreaterThan(0);
    }, NATIVE_GENERATOR_TEST_TIMEOUT_MS);
});
