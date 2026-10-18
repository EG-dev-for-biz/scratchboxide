import { test, afterEach } from 'vitest';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GoogleVectorTileService } from '../src/node/spatial/GoogleVectorTileService';
import { SpatialVectorDataService } from '../src/node/spatial/SpatialVectorDataService';
import { latLngToUtm, type DsmRaster } from '../src/node/spatial/solar-dsm';
import { fuseBuilding, RoadPointIndex, streetLevelNear, type LngLat } from '../src/node/spatial/building-shape-fusion';
import { mapLimit } from '../src/common/map-limit';

const origAuth = GoogleVectorTileService.authProvider;
afterEach(() => { GoogleVectorTileService.authProvider = origAuth; (GoogleVectorTileService as any).tileCache.clear(); });

function rng(seed: number) {
    let s = seed >>> 0;
    return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

/** Mock fetch that answers every vector tile with an empty tile after `delayMs`, recording peak concurrency. */
function slowTiles(delayMs: number) {
    const stats = { inFlight: 0, peak: 0, calls: 0, auth: 0 };
    GoogleVectorTileService.authProvider = async () => { stats.auth++; await new Promise(r => setTimeout(r, 5)); return { token: 't', project: 'p' }; };
    const fetchImpl: any = async () => {
        stats.calls++; stats.inFlight++; stats.peak = Math.max(stats.peak, stats.inFlight);
        await new Promise(r => setTimeout(r, delayMs));
        stats.inFlight--;
        const body = { features: [] };
        return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body, text: async () => '{}' };
    };
    return { stats, fetchImpl };
}

test('stage3DVectorWorld fetches its 3x3 tile grid in parallel and asks for credentials once', async () => {
    const { stats, fetchImpl } = slowTiles(40);
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-vt-par-')), 'w.glb');
    const t0 = performance.now();
    const res = await GoogleVectorTileService.stage3DVectorWorld({ latitude: 40.75, longitude: -73.98, zoom: 17, radiusTiles: 1, includePlinth: false, outputGlbPath: out, fetchImpl, solarDsm: false });
    const ms = performance.now() - t0;
    assert.strictEqual(stats.calls, 9);
    assert.strictEqual(res.tilesCount, 9);
    assert.ok(stats.peak > 1, `tiles fetched one at a time (peak ${stats.peak})`);
    assert.ok(stats.peak <= 6, `concurrency bounded (peak ${stats.peak})`);
    assert.strictEqual(stats.auth, 1, 'one credential request shared by the parallel tiles');
    assert.ok(ms < 9 * 40, `9 x 40 ms tiles took ${ms.toFixed(0)} ms`);
});

test('SpatialVectorDataService fetches its tile grid in parallel', async () => {
    const { stats, fetchImpl } = slowTiles(30);
    await SpatialVectorDataService.querySpatialVectorData({ latitude: 40.75, longitude: -73.98, zoom: 17, radiusTiles: 1, fetchImpl } as any).catch(() => undefined);
    assert.strictEqual(stats.calls, 9);
    assert.ok(stats.peak > 1, `tiles fetched one at a time (peak ${stats.peak})`);
});

test('mapLimit keeps input order and bounds concurrency', async () => {
    let inFlight = 0, peak = 0;
    const out = await mapLimit([5, 1, 4, 2, 3], 2, async (v, i) => {
        inFlight++; peak = Math.max(peak, inFlight);
        await new Promise(r => setTimeout(r, v * 3));
        inFlight--;
        return v * 10 + i;
    });
    assert.deepStrictEqual(out, [50, 11, 42, 23, 34]);
    assert.strictEqual(peak, 2);
});

test('RoadPointIndex gives the same fusion and street level as scanning every road point', () => {
    const lat = 40.75, lng = -73.98, r = rng(7);
    const { easting, northing } = latLngToUtm(lat, lng, 18, false);
    const W = 1200;
    const dsm: DsmRaster = { width: W, height: W, data: new Float32Array(W * W), affine: { a0: easting - 300, a1: 0.5, a2: 0, b0: northing + 300, b1: 0, b2: -0.5 }, epsg: 32618 };
    for (let i = 0; i < dsm.data.length; i++) dsm.data[i] = 10 + r() * 3;
    const kx = 111_320 * Math.cos((lat * Math.PI) / 180);
    const pts: LngLat[] = [];
    for (let i = 0; i < 20_000; i++) pts.push([lng + ((r() - 0.5) * 560) / kx, lat + ((r() - 0.5) * 560) / 111_320]);
    const index = new RoadPointIndex(pts);
    const buildings: LngLat[][] = [];
    for (let b = 0; b < 60; b++) {
        const cx = lng + ((r() - 0.5) * 400) / kx, cy = lat + ((r() - 0.5) * 400) / 111_320, s = 4 + r() * 10;
        buildings.push([[cx - s / kx, cy - s / 111_320], [cx + s / kx, cy - s / 111_320], [cx + s / kx, cy + s / 111_320], [cx - s / kx, cy + s / 111_320]]);
    }
    let tList = 0, tIndex = 0;
    for (const [i, ring] of buildings.entries()) {
        let t = performance.now();
        const a = fuseBuilding({ id: `b${i}`, ring, vectorHeightMeters: 20, source: 'extruded' }, dsm, [], { roadPoints: pts, sampleSpacingMeters: 2 });
        tList += performance.now() - t; t = performance.now();
        const b = fuseBuilding({ id: `b${i}`, ring, vectorHeightMeters: 20, source: 'extruded' }, dsm, [], { roadPoints: index, sampleSpacingMeters: 2 });
        tIndex += performance.now() - t;
        assert.deepStrictEqual(b, a);
    }
    for (const rad of [30, 60, 80, 200]) {
        assert.strictEqual(streetLevelNear(dsm, lat, lng, index, rad), streetLevelNear(dsm, lat, lng, pts, rad));
    }
    // The index answers every in-radius point and no more than a few cells' worth of others.
    const near = index.near(lng, lat, 60);
    const exact = pts.filter(([x, y]) => Math.hypot((x - lng) * kx, (y - lat) * 111_320) <= 60);
    assert.ok(exact.every(p => near.includes(p)));
    assert.ok(near.length < pts.length / 5);
    console.log(`[road index] 60 buildings x 20k road points: list ${tList.toFixed(1)} ms, index ${tIndex.toFixed(1)} ms`);
});
