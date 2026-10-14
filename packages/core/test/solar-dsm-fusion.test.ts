import { test } from 'vitest';
import * as assert from 'node:assert';
import { zlibSync } from 'fflate';
import { latLngToUtm, parseDsmGeoTiff, sampleDsm, type DsmRaster } from '../src/node/spatial/solar-dsm';
import { densifyRoads, fuseBuilding, type LngLat } from '../src/node/spatial/building-shape-fusion';

/** A big-endian, tiled, deflate-compressed float32 GeoTIFF like the Solar API serves. */
function makeGeoTiff(width: number, height: number, tile: number, value: (x: number, y: number) => number, origin: [number, number], pixel: number, epsg: number): Buffer {
    const across = Math.ceil(width / tile), down = Math.ceil(height / tile);
    const tiles: Uint8Array[] = [];
    for (let ty = 0; ty < down; ty++) for (let tx = 0; tx < across; tx++) {
        const raw = Buffer.alloc(tile * tile * 4);
        for (let y = 0; y < tile; y++) for (let x = 0; x < tile; x++) raw.writeFloatBE(value(tx * tile + x, ty * tile + y), 4 * (y * tile + x));
        tiles.push(zlibSync(raw));
    }
    const entries: Array<[number, number, number[]]> = [
        [256, 3, [width]], [257, 3, [height]], [258, 3, [32]], [259, 3, [32946]], [277, 3, [1]],
        [322, 3, [tile]], [323, 3, [tile]], [324, 4, []], [325, 4, tiles.map(t => t.length)], [339, 3, [3]],
        [34264, 12, [pixel, 0, 0, origin[0], 0, -pixel, 0, origin[1], 0, 0, 0, 0, 0, 0, 0, 1]],
        [34735, 3, [1, 1, 0, 1, 3072, 0, 1, epsg]]
    ];
    const ifdSize = 2 + entries.length * 12 + 4;
    let extra = 8 + ifdSize;
    const extraParts: Buffer[] = [];
    const placed = entries.map(([tag, type, vals]) => {
        const size = ({ 3: 2, 4: 4, 12: 8 } as Record<number, number>)[type] * Math.max(vals.length, tag === 324 ? tiles.length : 0);
        if (size <= 4) return { tag, type, vals, at: -1 };
        const at = extra; extra += size; extraParts.push(Buffer.alloc(size));
        return { tag, type, vals, at };
    });
    let dataAt = extra;
    const tileOffsets = tiles.map(t => { const o = dataAt; dataAt += t.length; return o; });
    const out = Buffer.alloc(dataAt);
    out.write('MM', 0, 'latin1'); out.writeUInt16BE(42, 2); out.writeUInt32BE(8, 4);
    out.writeUInt16BE(entries.length, 8);
    placed.forEach((p, i) => {
        const vals = p.tag === 324 ? tileOffsets : p.vals;
        const e = 10 + i * 12;
        out.writeUInt16BE(p.tag, e); out.writeUInt16BE(p.type, e + 2); out.writeUInt32BE(vals.length, e + 4);
        const write = (base: number) => vals.forEach((v, k) => p.type === 3 ? out.writeUInt16BE(v, base + 2 * k) : p.type === 4 ? out.writeUInt32BE(v, base + 4 * k) : out.writeDoubleBE(v, base + 8 * k));
        if (p.at < 0) write(e + 8); else { out.writeUInt32BE(p.at, e + 8); write(p.at); }
    });
    let o = extra; tiles.forEach(t => { Buffer.from(t).copy(out, o); o += t.length; });
    return out;
}

test('UTM projection matches a reference point', () => {
    // Empire State Building, zone 18N (reference: 585631.4 E, 4511327.0 N)
    const { easting, northing } = latLngToUtm(40.7484405, -73.9856644, 18, false);
    assert.ok(Math.abs(easting - 585631.36) < 0.5 && Math.abs(northing - 4511326.98) < 0.5, `${easting}, ${northing}`);
});

test('reads a tiled, deflated, big-endian float32 GeoTIFF and samples it by lat/lng', () => {
    const { easting, northing } = latLngToUtm(40.7484, -73.9857, 18, false);
    const origin: [number, number] = [Math.floor(easting) - 50, Math.floor(northing) + 50];
    const tif = makeGeoTiff(300, 300, 256, (x, y) => 10 + x * 0.1 + y * 0.01, origin, 0.5, 32618);
    const dsm = parseDsmGeoTiff(tif);
    assert.strictEqual(dsm.width, 300); assert.strictEqual(dsm.epsg, 32618);
    assert.strictEqual(dsm.data[299 * 300 + 299], Math.fround(10 + 29.9 + 2.99), 'second tile row/column placed correctly');
    const col = (easting - origin[0]) / 0.5 - 0.5, row = (origin[1] - northing) / 0.5 - 0.5;
    assert.ok(Math.abs(sampleDsm(dsm, 40.7484, -73.9857) - (10 + col * 0.1 + row * 0.01)) < 1e-3);
    assert.ok(Number.isNaN(sampleDsm(dsm, 40.8, -73.9857)), 'outside the raster');
});

test('fusion measures street level on roads and the roof inside the footprint, and compares with the vector height', () => {
    const lat0 = 40.75, lng0 = -73.98, k = 111_320 * Math.cos((lat0 * Math.PI) / 180);
    const at = (x: number, y: number): LngLat => [lng0 + x / k, lat0 + y / 111_320];
    // 20 m square building, roof at 60 m above a 15 m street, a 6 m water tank on top; a road 15 m south.
    const height = (x: number, y: number) => (Math.abs(x) <= 10 && Math.abs(y) <= 10 ? (Math.hypot(x - 4, y - 4) < 1.5 ? 81 : 75) : 15);
    const { easting, northing } = latLngToUtm(lat0, lng0, 18, false);
    const dsm: DsmRaster = { width: 200, height: 200, data: new Float32Array(200 * 200), affine: { a0: easting - 50, a1: 0.5, a2: 0, b0: northing + 50, b1: 0, b2: -0.5 }, epsg: 32618 };
    for (let r = 0; r < 200; r++) for (let c = 0; c < 200; c++) dsm.data[r * 200 + c] = height((c + 0.5) * 0.5 - 50, 50 - (r + 0.5) * 0.5);
    const fused = fuseBuilding(
        { id: 'b', ring: [at(-10, -10), at(10, -10), at(10, 10), at(-10, 10)], vectorHeightMeters: 59, source: 'extruded' },
        dsm, [],
        { roadPoints: densifyRoads([[at(-40, -15), at(40, -15)]]), sampleSpacingMeters: 0.5 }
    );
    assert.strictEqual(fused.groundSource, 'roads');
    assert.ok(Math.abs(fused.groundMsl! - 15) < 0.01);
    assert.ok(Math.abs(fused.dsmRoofHeightMeters! - 60) < 0.01, 'main roof ignores the small tank');
    assert.ok(Math.abs(fused.dsmPeakHeightMeters! - 66) < 0.6, 'peak finds the tank');
    assert.strictEqual(fused.heightSource, 'dsm');
    assert.ok(Math.abs(fused.disagreementMeters! - 1) < 0.01);
    assert.strictEqual(fused.confidence, 'high');
});
