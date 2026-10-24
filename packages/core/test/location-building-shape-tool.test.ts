/**
 * location_building_shape through the tool registry, against recorded-shape synthetic Google responses (Places,
 * vector feature tiles, Solar dataLayers + DSM GeoTIFF, Solar buildingInsights). No network, no credentials.
 */
import { afterEach, beforeEach, test, vi } from 'vitest';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createDefaultToolRegistry } from '../src/node/gemini/tool-registry';
import { GoogleVectorTileService, VectorTileUnavailableError } from '../src/node/spatial/GoogleVectorTileService';
import { gridUnitMeters, TILE_GRID } from '../src/node/spatial/google-feature-tile-decoder';
import { latLngToUtm } from '../src/node/spatial/solar-dsm';
import type { ToolContext } from '../src/node/gemini/tools/types';

const LAT0 = 40.72425, LNG0 = -73.99512; // a point well inside its zoom-17 tile
const Z = 17;
const K = 111_320 * Math.cos((LAT0 * Math.PI) / 180);
const at = (east: number, north: number): [number, number] => [LNG0 + east / K, LAT0 + north / 111_320];

function tileXY(lng: number, lat: number): { x: number; y: number; gx: number; gy: number } {
    const n = 2 ** Z, r = (lat * Math.PI) / 180;
    const fx = ((lng + 180) / 360) * n, fy = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
    return { x: Math.floor(fx), y: Math.floor(fy), gx: (fx - Math.floor(fx)) * TILE_GRID, gy: (fy - Math.floor(fy)) * TILE_GRID };
}
const HOME = tileXY(LNG0, LAT0);
const UNIT = gridUnitMeters(LAT0, Z);

/** Delta-encoded offsets of a loop of [east, north] metres, in the grid of tile (tx, ty); grid may run past the tile. */
function offsets(loop: Array<[number, number]>, tx = HOME.x, ty = HOME.y): { xOffsets: number[]; yOffsets: number[] } {
    const pts = loop.map(([e, n]) => { const t = tileXY(...at(e, n)); return [(t.x - tx) * TILE_GRID + t.gx, (t.y - ty) * TILE_GRID + t.gy]; });
    const xs: number[] = [], ys: number[] = [];
    let px = 0, py = 0;
    for (const [x, y] of pts) { xs.push(x - px); ys.push(y - py); px = x; py = y; }
    return { xOffsets: xs, yOffsets: ys };
}
const rect = (e0: number, n0: number, e1: number, n1: number): Array<[number, number]> => [[e0, n0], [e1, n0], [e1, n1], [e0, n1]];
const extruded = (loop: Array<[number, number]>, heightM: number, tx?: number, ty?: number) => ({
    types: ['FEATURE_TYPE_BUILDING'],
    geometry: { extrudedAreas: [{ minZ: 0, maxZ: heightM / UNIT, area: { type: 'INDEXED_TRIANGLES', vertexOffsets: offsets(loop, tx, ty) } }] }
});
const road = (line: Array<[number, number]>) => ({ types: ['FEATURE_TYPE_ROAD'], geometry: { lines: [{ vertexOffsets: offsets(line) }] } });

/** Little-endian single-strip float32 GeoTIFF in UTM 18N, 0.5 m pixels, like the Solar DSM. */
function geoTiff(heightAt: (east: number, north: number) => number, halfM = 90): Buffer {
    const px = 0.5, size = Math.round((2 * halfM) / px);
    const { easting, northing } = latLngToUtm(LAT0, LNG0, 18, false);
    const ox = easting - halfM, oy = northing + halfM;
    const pixels = Buffer.alloc(size * size * 4);
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
        // UTM and the local east/north frame agree to well under a pixel over this small area (grid convergence ~0.7 deg)
        pixels.writeFloatLE(heightAt(ox + (c + 0.5) * px - easting, oy - (r + 0.5) * px - northing), 4 * (r * size + c));
    }
    const matrix = [px, 0, 0, ox, 0, -px, 0, oy, 0, 0, 0, 0, 0, 0, 0, 1];
    const geokeys = [1, 1, 0, 1, 3072, 0, 1, 32618];
    const entries: Array<[number, number, number[]]> = [
        [256, 4, [size]], [257, 4, [size]], [258, 3, [32]], [259, 3, [1]], [273, 4, [0]], [278, 4, [size]],
        [279, 4, [pixels.length]], [339, 3, [3]], [34264, 12, matrix], [34735, 3, geokeys]
    ];
    const ifdAt = 8, ifdLen = 2 + entries.length * 12 + 4;
    let extraAt = ifdAt + ifdLen;
    const sizeOf = (t: number) => (t === 3 ? 2 : t === 4 ? 4 : 8);
    const extras = entries.map(([, t, v]) => { const len = sizeOf(t) * v.length; if (len <= 4) return -1; const o = extraAt; extraAt += len; return o; });
    const dataAt = extraAt;
    entries[4][2] = [dataAt];
    const out = Buffer.alloc(dataAt + pixels.length);
    out.write('II', 0, 'latin1'); out.writeUInt16LE(42, 2); out.writeUInt32LE(ifdAt, 4); out.writeUInt16LE(entries.length, ifdAt);
    entries.forEach(([tag, t, v], i) => {
        const e = ifdAt + 2 + i * 12;
        out.writeUInt16LE(tag, e); out.writeUInt16LE(t, e + 2); out.writeUInt32LE(v.length, e + 4);
        const base = extras[i] < 0 ? e + 8 : extras[i];
        if (extras[i] >= 0) out.writeUInt32LE(extras[i], e + 8);
        v.forEach((val, k) => t === 3 ? out.writeUInt16LE(val, base + 2 * k) : t === 4 ? out.writeUInt32LE(val, base + 4 * k) : out.writeDoubleLE(val, base + 8 * k));
    });
    pixels.copy(out, dataAt);
    return out;
}

interface World {
    places?: unknown;
    tiles: Record<string, unknown[]>;
    dsm?: (east: number, north: number) => number;
    insights?: (lat: number, lng: number) => unknown;
}

const calls: string[] = [];
function serve(world: World): typeof fetch {
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    return (async (input: string | URL | Request) => {
        const url = String(input instanceof Request ? input.url : input);
        calls.push(url.replace(/key=[^&]+/, 'key=…'));
        if (url.startsWith('https://places.googleapis.com/')) return json(200, world.places ?? { places: [] });
        const m = /featuretiles\/(\d+)\/(\d+)\/(\d+)/.exec(url);
        if (m) return json(200, { zoom: +m[1], x: +m[2], y: +m[3], features: world.tiles[`${m[2]}/${m[3]}`] ?? [] });
        if (url.includes('dataLayers:get')) return world.dsm ? json(200, { dsmUrl: 'https://solar.test/dsm?id=1', imageryDate: { year: 2024, month: 5, day: 2 } }) : json(404, { error: { message: 'Requested entity was not found.' } });
        if (url.startsWith('https://solar.test/dsm')) return new Response(geoTiff(world.dsm!), { status: 200 });
        if (url.includes('buildingInsights:findClosest')) {
            const q = new URL(url).searchParams;
            const body = world.insights?.(Number(q.get('location.latitude')), Number(q.get('location.longitude')));
            return body ? json(200, body) : json(404, { error: { message: 'Requested entity was not found.' } });
        }
        throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
}

let workspace: string;
const realAuth = GoogleVectorTileService.authProvider;
beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bshape-'));
    (GoogleVectorTileService as unknown as { tileCache: Map<string, unknown> }).tileCache.clear();
    GoogleVectorTileService.authProvider = async () => ({ token: 'test-token', project: 'test-project' });
    vi.stubEnv('GOOGLE_MAPS_API_KEY', 'test-maps-key');
    calls.length = 0;
});
afterEach(() => {
    GoogleVectorTileService.authProvider = realAuth;
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    fs.rmSync(workspace, { recursive: true, force: true });
});

async function run(args: Record<string, unknown>, world: World) {
    vi.stubGlobal('fetch', serve(world));
    const registry = createDefaultToolRegistry();
    const out = await registry.dispatch('location_building_shape', args, { workspaceRoot: workspace } as unknown as ToolContext);
    return { exec: out.exec, payload: out.resultPayload as Record<string, any> };
}

/** A top-down SVG of what the tool returned (footprints, the place point, roof segment centres), for review. */
function saveSvg(name: string, payload: Record<string, any>): void {
    const dir = path.resolve(__dirname, '../../../test-results/screenshots/tool_building_shape');
    fs.mkdirSync(dir, { recursive: true });
    const s = 4, c = 300;
    const pt = ([e, n]: number[]) => `${(c + e * s).toFixed(1)},${(c - n * s).toFixed(1)}`;
    const shapes = [payload.target, ...(payload.neighbours || [])].filter(Boolean).flatMap((b: any) => [
        ...b.footprint.parts.map((p: any) => `<polygon points="${p.ringLocalMeters.map(pt).join(' ')}" fill="${b.role === 'target' ? '#e8a33a55' : '#5b8def44'}" stroke="${b.role === 'target' ? '#c46f00' : '#2457c5'}" stroke-width="2"/>`),
        `<text x="${pt(b.footprint.centroidLocalMeters).split(',')[0]}" y="${pt(b.footprint.centroidLocalMeters).split(',')[1]}" font-size="11" font-family="sans-serif">${b.role} ${b.comparison.verdict}</text>`,
        ...b.roofSegments.map((r: any) => `<circle cx="${pt(r.centerLocalMeters).split(',')[0]}" cy="${pt(r.centerLocalMeters).split(',')[1]}" r="3" fill="#2a9d55"/>`)
    ]);
    fs.writeFileSync(path.join(dir, `${name}.svg`), `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" style="background:#f4f2ee">${shapes.join('')}<circle cx="${c}" cy="${c}" r="4" fill="#d62828"/><text x="8" y="16" font-size="12" font-family="sans-serif">${name}: place point red, target orange, neighbours blue, Solar segment centres green (1 m = ${s} px)</text></svg>`);
}

function glbJson(file: string): any {
    const b = fs.readFileSync(file);
    assert.strictEqual(b.readUInt32LE(0), 0x46546c67, 'glTF magic');
    const len = b.readUInt32LE(12);
    return JSON.parse(b.subarray(20, 20 + len).toString('utf8'));
}

test('extruded target and a neighbour: footprints, vector vs DSM side by side, roof segments, massing GLB', async () => {
    const roofAt = (e: number, n: number) => (Math.abs(e) <= 10 && Math.abs(n) <= 10 ? 40 : e >= 20 && e <= 35 && Math.abs(n) <= 8 ? 30 : 10);
    const { payload, exec } = await run({ location: 'Puck Building', neighbourRadiusMeters: 40, writeMassingGlb: true }, {
        places: { places: [{ id: 'p1', displayName: { text: 'Puck Building' }, formattedAddress: '295 Lafayette St, New York, NY 10012, USA', location: { latitude: LAT0, longitude: LNG0 } }] },
        tiles: { [`${HOME.x}/${HOME.y}`]: [extruded(rect(-10, -10, 10, 10), 31), extruded(rect(20, -8, 35, 8), 35), road([[-60, -25], [60, -25]])] },
        dsm: roofAt,
        insights: () => ({
            name: 'buildings/ChIJ-target', center: { latitude: LAT0, longitude: LNG0 }, imageryDate: { year: 2024, month: 5, day: 2 },
            solarPotential: { roofSegmentStats: [{ pitchDegrees: 2, azimuthDegrees: 180, planeHeightAtCenterMeters: 40.2, center: { latitude: at(3, 3)[1], longitude: at(3, 3)[0] }, stats: { areaMeters2: 150 } }] }
        })
    });
    assert.strictEqual(exec.status, 'completed', JSON.stringify(payload).slice(0, 400));
    assert.strictEqual(exec.humanFriendlyOutput?.title, 'Location Evidence: Building Shape');
    const t = payload.target;
    assert.strictEqual(payload.place.source, 'geocoded');
    assert.strictEqual(t.containsPlacePoint, true);
    assert.strictEqual(t.footprint.chosen, 'extruded_area');
    assert.match(t.footprint.why, /inside this footprint/);
    assert.strictEqual(t.footprint.parts.length, 1);
    for (const [e, n] of t.footprint.parts[0].ringLocalMeters) assert.ok(Math.abs(Math.abs(e) - 10) < 0.15 && Math.abs(Math.abs(n) - 10) < 0.15, `${e},${n}`);
    assert.ok(Math.abs(t.footprint.areaM2 - 400) < 5);
    assert.ok(Math.abs(t.vector.heightMeters - 31) < 0.01);
    assert.strictEqual(t.solarDsm.status, 'measured');
    assert.strictEqual(t.solarDsm.streetLevelSource, 'roads');
    assert.ok(Math.abs(t.solarDsm.streetLevelMsl - 10) < 0.01);
    assert.ok(Math.abs(t.solarDsm.roofAboveStreetMeters - 30) < 0.01);
    assert.strictEqual(t.comparison.verdict, 'agree');
    assert.ok(Math.abs(t.comparison.vectorVsDsmMeters - 1) < 0.01, 'vector 31 vs DSM 30: stated, not averaged');
    assert.strictEqual(t.roofSegments.length, 1);
    assert.ok(Math.abs(t.roofSegments[0].planeHeightAboveStreetMeters - 30.2) < 0.01);
    assert.strictEqual(t.solarInsights.status, 'found');

    assert.strictEqual(payload.neighbours.length, 1);
    const nb = payload.neighbours[0];
    assert.ok(Math.abs(nb.distanceFromPlaceMeters - 20) < 0.2);
    assert.ok(Math.abs(nb.distanceFromTargetMeters - 10) < 0.2, "gap between the two footprints");
    assert.strictEqual(nb.comparison.verdict, 'disagree');
    assert.ok(Math.abs(nb.comparison.vectorVsDsmMeters - 15) < 0.01, 'vector 35 vs DSM 20');
    assert.match(nb.comparison.statement, /DISAGREE by 15 m/);
    assert.strictEqual(nb.solarInsights.status, 'other_building', 'the Solar API answered with the target, whose segment is not in this footprint');
    assert.strictEqual(nb.roofSegments.length, 0);

    const gltf = glbJson(payload.massingGlbPath);
    assert.strictEqual(gltf.asset.extras.source, 'from Google vector data');
    assert.strictEqual(gltf.nodes.length, 2);
    const posMax = gltf.accessors[0].max;
    assert.ok(Math.abs(posMax[1] - 31) < 0.01, 'target extruded to its vector height');
    assert.ok(calls.some(u => u.includes('featuretiles/17/') && u.includes('languageCode=en-US') && u.includes('regionCode=US')));
    saveSvg('synthetic_extruded_target_and_neighbour', payload);
});

test('a modeled volume with a plan area: plan area chosen over the hull, modeled GLB written', async () => {
    const tile = `${HOME.x}/${HOME.y}`;
    const l = offsets(rect(-6, -6, 6, 6));
    // An L-shaped plan and a modeled box over it (strips: two faces are enough for the decoder).
    const plan = offsets([[-6, -6], [6, -6], [6, 0], [0, 0], [0, 6], [-6, 6]]);
    const mvZ = [0, 0, 0, 0, 25 / UNIT, 0, 0, 0].map((z, i, a) => (i === 0 ? z : z - a[i - 1]));
    const box = { xOffsets: [...l.xOffsets, -l.xOffsets.reduce((a, b) => a + b, 0) + l.xOffsets[0], ...l.xOffsets.slice(1)], yOffsets: [...l.yOffsets, -l.yOffsets.reduce((a, b) => a + b, 0) + l.yOffsets[0], ...l.yOffsets.slice(1)], zOffsets: mvZ };
    const { payload, exec } = await run({ latitude: LAT0, longitude: LNG0 }, {
        tiles: { [tile]: [{ types: ['FEATURE_TYPE_BUILDING'], geometry: { areas: [{ type: 'INDEXED_TRIANGLES', vertexOffsets: plan }], modeledVolumes: [{ vertexOffsets: box, strips: [{ vertexIndices: [0, 1, 4, 5] }, { vertexIndices: [1, 2, 5, 6] }] }] } }] }
    });
    assert.strictEqual(exec.status, 'completed', JSON.stringify(payload).slice(0, 400));
    const t = payload.target;
    assert.strictEqual(payload.place.source, 'coordinates');
    assert.strictEqual(t.footprint.chosen, 'plan_area');
    assert.ok(t.footprint.alternatives.some((a: string) => /convex hull/.test(a)));
    assert.ok(Math.abs(t.footprint.areaM2 - 108) < 3, `L plan is 108 m2, got ${t.footprint.areaM2}`);
    assert.strictEqual(t.vector.kind, 'modeled');
    assert.ok(Math.abs(t.vector.heightMeters - 25) < 0.05);
    assert.ok(fs.existsSync(t.vector.modeledGlbPath));
    assert.match(glbJson(t.vector.modeledGlbPath).asset.extras.source, /Google vector data/);
    assert.strictEqual(t.solarDsm.status, 'unavailable');
    assert.match(t.solarDsm.reason, /404/);
    assert.strictEqual(t.comparison.verdict, 'cannot_compare');
});

test('a building cut by a tile edge is joined into one', async () => {
    // place 4 m west of the eastern edge of HOME
    const edgeLng = ((HOME.x + 1) / 2 ** Z) * 360 - 180;
    const lng = edgeLng - 4 / K;
    const eastOf = (e: number) => (edgeLng - LNG0) * K + e; // local east of the tile edge
    const west = rect(-10 + eastOf(0) - 4, -5, eastOf(0), 5), east = rect(eastOf(0), -5, eastOf(0) + 6, 5);
    const { payload, exec } = await run({ latitude: LAT0, longitude: lng }, {
        tiles: { [`${HOME.x}/${HOME.y}`]: [extruded(west, 12)], [`${HOME.x + 1}/${HOME.y}`]: [extruded(east, 12, HOME.x + 1, HOME.y)] }
    });
    assert.strictEqual(exec.status, 'completed', JSON.stringify(payload).slice(0, 400));
    assert.strictEqual(payload.target.footprint.joinedAcrossTiles, true);
    assert.strictEqual(payload.target.footprint.parts.length, 2);
    assert.ok(Math.abs(payload.target.footprint.areaM2 - 200) < 4);
});

test('no footprint at the place: typed failure listing the nearest, nothing invented', async () => {
    const { payload, exec } = await run({ location: 'Pulteney Bridge, Bath', neighbourRadiusMeters: 30 }, {
        places: { places: [{ id: 'p2', displayName: { text: 'Pulteney Bridge' }, formattedAddress: 'Bridge St, Bath BA2 4AT, UK', location: { latitude: LAT0, longitude: LNG0 } }] },
        tiles: { [`${HOME.x}/${HOME.y}`]: [extruded(rect(40, 40, 55, 60), 15)] }
    });
    assert.strictEqual(exec.status, 'failed');
    assert.strictEqual(payload.code, 'no_footprint');
    assert.match(payload.error, /No building footprint .* contains Pulteney Bridge/);
    assert.match(payload.error, /No footprint is invented/);
    assert.ok(payload.nearestFootprints[0].distanceMeters > 50);
    assert.ok(!fs.existsSync(path.join(workspace, 'public')), 'no GLB written');
});

test('no buildings at all is no_coverage', async () => {
    const { payload } = await run({ latitude: LAT0, longitude: LNG0 }, { tiles: {} });
    assert.strictEqual(payload.code, 'no_coverage');
});

test('missing vector credentials and a failed geocode are typed', async () => {
    GoogleVectorTileService.authProvider = async () => { throw new VectorTileUnavailableError('Google vector tiles need the Google Cloud service account (none is configured).'); };
    const a = await run({ latitude: LAT0, longitude: LNG0 }, { tiles: {} });
    assert.strictEqual(a.payload.code, 'missing_credentials');
    const b = await run({ location: 'Nowhere Placeholder Street 999' }, { places: { places: [] }, tiles: {} });
    assert.strictEqual(b.payload.code, 'geocode_failed');
    vi.stubEnv('GOOGLE_MAPS_API_KEY', '');
    vi.stubEnv('MAP_TILES_API_KEY', '');
    const c = await run({ location: 'Puck Building' }, { tiles: {} });
    assert.strictEqual(c.payload.code, 'missing_credentials');
});

/** A POI as the feature tiles label it: a point position in the tile grid and a text label. */
const poi = (east: number, north: number, name: string, types: string[]) => {
    const t = tileXY(...at(east, north));
    return { types: ['FEATURE_TYPE_POI', ...types], labels: [{ pointPosition: { point: { x: (t.x - HOME.x) * TILE_GRID + t.gx, y: (t.y - HOME.y) * TILE_GRID + t.gy } }, textComponents: [{ texts: [{ text: name }] }] }] };
};
const landuse = (loop: Array<[number, number]>, types: string[]) => ({ types, geometry: { areas: [{ type: 'INDEXED_TRIANGLES', vertexOffsets: offsets(loop) }] } });

test('a place point 100 m off its building: the footprint holding the POI named like the request is taken, and the context names it, with land use and roads', async () => {
    // the house 100 m east of the address point (Fallingwater: the geocode is the gate), a forest area over it, a road by the gate
    const house = rect(90, -12, 110, 12);
    const { payload, exec } = await run({ location: 'Fallingwater, Mill Run, Pennsylvania' }, {
        places: { places: [{ id: 'p1', displayName: { text: 'Fallingwater' }, formattedAddress: '1491 Mill Run Rd, Mill Run, PA 15464, USA', location: { latitude: LAT0, longitude: LNG0 } }] },
        tiles: { [`${HOME.x}/${HOME.y}`]: [
            extruded(house, 7),
            poi(100, 0, 'Fallingwater', ['FEATURE_TYPE_ENTERTAINMENT', 'FEATURE_TYPE_HISTORIC']),
            poi(-30, 20, 'Visitor Center Shop', ['FEATURE_TYPE_RETAIL']),
            landuse(rect(60, -60, 140, 60), ['FEATURE_TYPE_NATURAL', 'FEATURE_TYPE_LAND_COVER', 'FEATURE_TYPE_SOMETHING_NEW']),
            road([[-60, -30], [20, -30]]), road([[80, -40], [80, 40]])  // the gate road ends 72 m from the house, past the reach
        ] }
    });
    assert.strictEqual(exec.status, 'completed', JSON.stringify(payload).slice(0, 600));
    const t = payload.target;
    assert.strictEqual(t.containsPlacePoint, false);
    assert.ok(Math.abs(t.distanceFromPlaceMeters - 90) < 0.5, `distance ${t.distanceFromPlaceMeters}`);
    assert.match(t.footprint.why, /holds the POI named 'Fallingwater' \(fallingwater match the request\)/);
    assert.match(payload.summary, /holds the POI named 'Fallingwater'/);
    const c = payload.context;
    assert.strictEqual(c.names.primary, 'Fallingwater');
    assert.strictEqual(c.names.names[0].source, 'poi');
    assert.deepStrictEqual(c.names.names[0].types, ['FEATURE_TYPE_POI', 'FEATURE_TYPE_ENTERTAINMENT', 'FEATURE_TYPE_HISTORIC']);
    assert.strictEqual(c.nearbyPois.length, 1, 'the shop stands 120 m away, outside the reach');
    assert.strictEqual(c.nearbyPois[0].name, 'Fallingwater');
    assert.strictEqual(c.landuse.length, 1);
    assert.strictEqual(c.landuse[0].gapToTargetMeters, 0, 'the forest area covers the house');
    assert.ok(Math.abs(c.landuse[0].areaM2 - 9600) < 100);
    assert.ok(c.landuse[0].types.includes('FEATURE_TYPE_SOMETHING_NEW'), 'an unknown code is carried as given');
    assert.strictEqual(c.roads.withinReach, 1, 'the road by the house, not the one by the gate');
    assert.deepStrictEqual(c.roads.types, ['FEATURE_TYPE_ROAD']);
    assert.strictEqual(c.volumeRoofPrior, undefined, 'no modelled volume here');
    assert.match(c.note, /Named 'Fallingwater' \(a POI inside the footprint\)/);
});

test('with no named POI the typed no_footprint failure stands, and says the name search found nothing', async () => {
    const { payload, exec } = await run({ location: 'Some Place' }, {
        places: { places: [{ id: 'p1', displayName: { text: 'Some Place' }, formattedAddress: 'Somewhere', location: { latitude: LAT0, longitude: LNG0 } }] },
        tiles: { [`${HOME.x}/${HOME.y}`]: [extruded(rect(90, -12, 110, 12), 7), poi(100, 0, 'Another Thing', ['FEATURE_TYPE_RETAIL'])] }
    });
    assert.strictEqual(exec.status, 'failed');
    assert.strictEqual(payload.code, 'no_footprint');
    assert.match(payload.error, /No POI named like the request stands in a footprint within 150 m/);
    assert.strictEqual(payload.nearestFootprints[0].distanceMeters, 90);
});
