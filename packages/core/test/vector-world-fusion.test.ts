import { test, afterEach } from 'vitest';
import * as assert from 'node:assert';
import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import { GoogleVectorTileService } from '../src/node/spatial/GoogleVectorTileService';
import { latLngToUtm, type DsmRaster } from '../src/node/spatial/solar-dsm';
import { glbToTriangleSoup } from '../src/node/3d-engine/part-connectivity';
import { TileMeshRaycaster } from '../src/node/spatial/tile-mesh-raycast';
import { geoidUndulation } from '../src/node/spatial/egm96-geoid';

const origAuth = GoogleVectorTileService.authProvider;
afterEach(() => { GoogleVectorTileService.authProvider = origAuth; (GoogleVectorTileService as any).tileCache.clear(); });

async function stageScenario(tileStreetMsl?: number) {
    const lat = 40.75, lng = -73.98, zoom = 17;
    const n = 2 ** zoom, tx = Math.floor(((lng + 180) / 360) * n);
    const ty = Math.floor(((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * n);
    // Grid position of the anchor inside its tile, so the test building and road sit right around it.
    const wx = ((lng + 180) / 360) * n - tx, wy = ((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * n - ty;
    const gx = Math.round(wx * 4096), gy = Math.round(wy * 4096);
    const tile = {
        x: tx, y: ty, zoom,
        features: [
            { types: ['FEATURE_TYPE_BUILDING'], geometry: { extrudedAreas: [{ maxZ: 530 /* ~30 m at z17 */, area: { type: 'TRIANGLE_FAN', vertexOffsets: { xOffsets: [gx, -200, 400, 0, -400], yOffsets: [gy, -200, 0, 400, 0] } } }] } },
            { types: ['FEATURE_TYPE_ROAD'], geometry: { lines: [{ vertexOffsets: { xOffsets: [gx - 1500, 3000], yOffsets: [gy + 500, 0] } }] } }
        ]
    };
    GoogleVectorTileService.authProvider = async () => ({ token: 't', project: 'p' });
    const fetchImpl: any = async (url: string) => {
        const m = /featuretiles\/(\d+)\/(\d+)\/(\d+)/.exec(String(url));
        const body = m && Number(m[2]) === tx && Number(m[3]) === ty ? tile : { x: 0, y: 0, zoom, features: [] };
        return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body, text: async () => JSON.stringify(body) };
    };
    // DSM: street at 12 m above sea level, the building's roof at 52 m (40 m tall), 0.5 m pixels.
    const { easting, northing } = latLngToUtm(lat, lng, 18, false);
    const dsm: DsmRaster = { width: 600, height: 600, data: new Float32Array(600 * 600).fill(12), affine: { a0: easting - 150, a1: 0.5, a2: 0, b0: northing + 150, b1: 0, b2: -0.5 }, epsg: 32618 };
    const unit = (2 * Math.PI * 6378137 * Math.cos((lat * Math.PI) / 180)) / n / 4096;
    for (let r = 0; r < 600; r++) for (let c = 0; c < 600; c++) {
        const x = (c + 0.5) * 0.5 - 150, y = 150 - (r + 0.5) * 0.5;
        if (Math.abs(x) < 200 * unit - 1 && Math.abs(y) < 200 * unit - 1) dsm.data[r * 600 + c] = 52;
    }
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-fusion-')), 'w.glb');
    let tileMesh: TileMeshRaycaster | undefined;
    if (tileStreetMsl !== undefined) {
        // A flat tile street plane (y = 0) whose ellipsoid height puts it at tileStreetMsl above sea level.
        const soup = { positions: Float32Array.from([-300, 0, -300, 300, 0, -300, 300, 0, 300, -300, 0, 300]), indices: Uint32Array.from([0, 1, 2, 0, 2, 3]) };
        tileMesh = new TileMeshRaycaster({ soup, anchorLat: lat, anchorLng: lng, originEllipsoidalHeightM: tileStreetMsl + geoidUndulation(lat, lng) });
    }
    const res = await GoogleVectorTileService.stage3DVectorWorld({ latitude: lat, longitude: lng, zoom, radiusTiles: 0, includePlinth: false, outputGlbPath: out, fetchImpl, solarDsm: dsm, tileMesh });
    const soup = glbToTriangleSoup(fs.readFileSync(out))!;
    let minY = Infinity, maxY = -Infinity;
    for (let i = 1; i < soup.positions.length; i += 3) { minY = Math.min(minY, soup.positions[i]); maxY = Math.max(maxY, soup.positions[i]); }
    return { res, minY, maxY };
}

test('staging seats buildings on the measured street level and sizes them from the DSM roof', async () => {
    const { res, maxY } = await stageScenario();
    const f = res.stats.fusion!;
    assert.strictEqual(f.skipped, undefined);
    assert.strictEqual(f.buildingsFused, 1);
    assert.strictEqual(f.heightFromDsm, 1);
    assert.ok(Math.abs(f.anchorElevationMsl - 12) < 0.01, 'anchor = measured street level');
    assert.ok(Math.abs(f.geoidUndulationMeters + 32.66) < 0.2);
    assert.ok(Math.abs(maxY - 40) < 0.6, `roof from the DSM (40 m), not the vector (30 m): ${maxY}`);
});

test('with a 3D tile mesh, buildings sit on the tile street and the residual against the DSM is reported', async () => {
    const same = await stageScenario(12);
    assert.strictEqual(same.res.stats.tileAlignment!.buildingsSnapped, 1);
    assert.ok(same.res.stats.tileAlignment!.groundVsDsm!.median < 0.05);
    const higher = await stageScenario(14);
    assert.ok(Math.abs(higher.res.stats.tileAlignment!.groundVsDsm!.median - 2) < 0.05, 'tiles 2 m above the DSM street');
    assert.ok(Math.abs(higher.maxY - same.maxY - 2) < 0.05, 'the building follows the tile surface up by 2 m');
});
