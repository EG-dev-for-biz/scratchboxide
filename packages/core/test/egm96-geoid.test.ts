import { test } from 'vitest';
import * as assert from 'node:assert';
import { geoidUndulation, mslToEllipsoid, ellipsoidToMsl, parseGeoidPgm } from '../src/node/spatial/egm96-geoid';

test('parses GeographicLib PGM headers and interpolates bilinearly with longitude wrap', () => {
    // 4 x 3 grid (90N, 0, 90S at 90-degree steps), Offset -10, Scale 0.5
    const vals = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22];
    const header = Buffer.from('P5\n# Offset -10\n# Scale 0.5\n4 3\n65535\n', 'latin1');
    const body = Buffer.alloc(vals.length * 2); vals.forEach((v, i) => body.writeUInt16BE(v, 2 * i));
    const g = parseGeoidPgm(Buffer.concat([header, body]));
    assert.strictEqual(geoidUndulation(0, 0, g), -10 + 0.5 * 8);
    assert.strictEqual(geoidUndulation(45, 45, g), -10 + 0.5 * (0 + 2 + 8 + 10) / 4);
    assert.strictEqual(geoidUndulation(0, -45, g), geoidUndulation(0, 315, g), 'negative longitudes wrap');
    assert.strictEqual(geoidUndulation(0, 315, g), -10 + 0.5 * (14 + 8) / 2, 'interpolates across the 360/0 seam');
});

test('the bundled EGM96 grid matches published undulations', () => {
    const cases: Array<[string, number, number, number]> = [
        ['New York (ESB)', 40.7484, -73.9857, -32.7],
        ['Rome', 41.8902, 12.4922, 48.5],
        ['Indian Ocean low', 4.7, 78.8, -107.0],
        ['New Guinea high', -8.4, 147.4, 84.7]
    ];
    for (const [name, lat, lng, n] of cases) assert.ok(Math.abs(geoidUndulation(lat, lng) - n) < 0.5, `${name}: ${geoidUndulation(lat, lng)}`);
    const h = mslToEllipsoid(13.8, 40.7484, -73.9857);
    assert.ok(Math.abs(h - (13.8 - 32.66)) < 0.05);
    assert.ok(Math.abs(ellipsoidToMsl(h, 40.7484, -73.9857) - 13.8) < 1e-9);
});
