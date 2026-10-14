import { test } from 'vitest';
import * as assert from 'node:assert';
import { TileMeshRaycaster } from '../src/node/spatial/tile-mesh-raycast';
import { geoidUndulation } from '../src/node/spatial/egm96-geoid';

/** A street plane at y = 0 with a 10 m cube building (top at y = 10) centred at the origin. */
function scene() {
    const pos: number[] = [], idx: number[] = [];
    const quad = (a: number[], b: number[], c: number[], d: number[]) => { const o = pos.length / 3; pos.push(...a, ...b, ...c, ...d); idx.push(o, o + 1, o + 2, o, o + 2, o + 3); };
    quad([-100, 0, -100], [100, 0, -100], [100, 0, 100], [-100, 0, 100]);
    quad([-5, 10, -5], [5, 10, -5], [5, 10, 5], [-5, 10, 5]);
    quad([-5, 0, 5], [5, 0, 5], [5, 10, 5], [-5, 10, 5]); // a wall: vertical, ignored by downward rays
    return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) };
}

test('downward rays return the highest surface and convert to height above sea level', () => {
    const lat = 40.75, lng = -73.98;
    const r = new TileMeshRaycaster({ soup: scene(), anchorLat: lat, anchorLng: lng, originEllipsoidalHeightM: -18.5 });
    assert.strictEqual(r.topHitLocal(0, 0), 10, 'roof over the street');
    assert.strictEqual(r.topHitLocal(50, 50), 0, 'street');
    assert.strictEqual(r.topHitLocal(500, 0), undefined, 'outside the mesh');
    const n = geoidUndulation(lat, lng);
    assert.ok(Math.abs(r.originMsl - (-18.5 - n)) < 1e-9);
    assert.ok(Math.abs(r.topHitMsl(lat, lng)! - (10 + r.originMsl)) < 1e-6);
    const east50 = lng + 50 / (111_320 * Math.cos((lat * Math.PI) / 180));
    assert.ok(Math.abs(r.topHitMsl(lat, east50)! - r.originMsl) < 1e-3, '50 m east lands on the street');
});
