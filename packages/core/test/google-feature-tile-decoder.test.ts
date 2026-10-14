import { test } from 'vitest';
import * as assert from 'node:assert';
import { areaBoundaryLoops, decodeFeatureTile, gridToLngLat, gridUnitMeters, stripsToTriangles } from '../src/node/spatial/google-feature-tile-decoder';

test('delta-encoded offsets decode to absolute grid points at the right lat/lng', () => {
    const tile = { x: 38598, y: 49263, zoom: 17 };
    const nw = gridToLngLat(tile, 0, 0), se = gridToLngLat(tile, 4096, 4096);
    const next = gridToLngLat({ ...tile, x: tile.x + 1, y: tile.y + 1 }, 0, 0);
    assert.ok(Math.abs(se[0] - next[0]) < 1e-12 && Math.abs(se[1] - next[1]) < 1e-12, 'grid 4096 is the next tile corner');
    assert.ok(nw[1] > se[1], 'y grows southward');
    const t = decodeFeatureTile({ ...tile, features: [{ types: ['FEATURE_TYPE_BUILDING'], geometry: { extrudedAreas: [{ minZ: 0, maxZ: 4096, area: { type: 'TRIANGLE_FAN', vertexOffsets: { xOffsets: [100, 10, 10, 0, -20], yOffsets: [100, 0, 0, 10, 0] } } }] } }] });
    const b = t.buildings[0];
    assert.deepStrictEqual(b.ring, [[110, 100], [120, 100], [120, 110], [100, 110]].map(([x, y]) => gridToLngLat(tile, x, y)), 'fan centre (100,100) excluded, offsets summed');
    const width = gridUnitMeters(gridToLngLat(tile, 2048, 2048)[1], 17) * 4096;
    assert.ok(Math.abs(b.properties.heightMeters - width) < 1e-6, 'maxZ 4096 is as tall as the tile is wide');
});

test('boundary loops follow each area encoding', () => {
    const v = (n: number) => ({ xOffsets: Array(n).fill(1), yOffsets: Array(n).fill(1) });
    assert.deepStrictEqual(areaBoundaryLoops({ type: 'TRIANGLE_FAN', vertexOffsets: v(5) }), [[1, 2, 3, 4]]);
    assert.deepStrictEqual(areaBoundaryLoops({ type: 'TRIANGLE_STRIP', vertexOffsets: v(6) }), [[0, 2, 4, 5, 3, 1]]);
    assert.deepStrictEqual(areaBoundaryLoops({ type: 'INDEXED_TRIANGLES', vertexOffsets: v(9), loopBreaks: [4] }), [[0, 1, 2, 3], [4, 5, 6, 7, 8]]);
    assert.deepStrictEqual(areaBoundaryLoops({ type: 'INDEXED_TRIANGLES', vertexOffsets: v(4) }), [[0, 1, 2, 3]]);
});

test('modeled volumes become triangle meshes with heights in meters, in the tile datum', () => {
    assert.deepStrictEqual(stripsToTriangles([{ vertexIndices: [0, 1, 2, 3] }]), [0, 1, 2, 2, 1, 3]);
    const tile = { x: 0, y: 0, zoom: 17 };
    const t = decodeFeatureTile({ ...tile, features: [{ types: ['FEATURE_TYPE_BUILDING'], geometry: { modeledVolumes: [{ vertexOffsets: { xOffsets: [10, 5, 0], yOffsets: [10, 0, 5], zOffsets: [50, 0, 100] }, strips: [{ vertexIndices: [0, 1, 2] }] }] } }] });
    const mv = t.modeledVolumes[0];
    assert.deepStrictEqual(mv.indices, [0, 1, 2]);
    const unit = gridUnitMeters(gridToLngLat(tile, 2048, 2048)[1], 17);
    // zOffsets are deltas: 50, 50, 150. The datum is kept (not shifted to the piece's own minimum) so pieces of one
    // building in neighbouring tiles stay level with each other.
    assert.deepStrictEqual(mv.vertices.map(v => Number((v[2] / unit).toFixed(6))), [50, 50, 150]);
    assert.ok(Math.abs(mv.minZMeters - 50 * unit) < 1e-9 && Math.abs(mv.maxZMeters - 150 * unit) < 1e-9);
    assert.ok(Math.abs(mv.heightMeters - 100 * unit) < 1e-9);
});

test('flat building areas are footprints, not extruded buildings', () => {
    const t = decodeFeatureTile({ x: 0, y: 0, zoom: 17, features: [{ types: ['FEATURE_TYPE_BUILDING'], geometry: { areas: [{ type: 'TRIANGLE_FAN', vertexOffsets: { xOffsets: [5, -5, 10, 0, -10], yOffsets: [5, -5, 0, 10, 0] } }] } }] });
    assert.strictEqual(t.buildings.length, 0);
    assert.strictEqual(t.buildingFootprints2D.length, 1);
    assert.strictEqual(t.buildingFootprints2D[0].ring.length, 4);
});
