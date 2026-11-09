/**
 * How long a district already in the place store takes to open with no rebuild: the place's manifest, its objects into an
 * object store and its model readings, pulled as a district run's first step pulls them (place-store-district.ts
 * pullPlaceForRun), into empty folders under --root. Prints the pull report and the wall time as JSON.
 *
 *   node -r ts-node/register scripts/kd_place_open_timing.ts --lat 40.75082 --lng -73.99047 --root /tmp/place-open [--concurrency 32]
 *
 * --concurrency sets how many objects are read at once (default the store's, PLACE_STORE_PARAMS.pullConcurrency).
 */
import * as fs from 'fs';
import * as path from 'path';

function arg(name: string, fallback?: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

async function main(): Promise<void> {
    const lat = Number(arg('lat')), lng = Number(arg('lng'));
    const root = path.resolve(arg('root') ?? '');
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !arg('root')) throw new Error('--lat, --lng and --root are required');
    fs.mkdirSync(root, { recursive: true });
    const { DurableAssetStore } = await import('../packages/core/src/node/asset-store/durable-asset-store');
    const { SceneObjectStore } = await import('../packages/core/src/node/asset-store/scene-object-store');
    const { openPlaceStore, placeKey, pullPlace, PLACE_STORE_PARAMS } = await import('../packages/core/src/node/3d-engine/staged-location/place-store');
    const concurrency = Number(arg('concurrency', String(PLACE_STORE_PARAMS.pullConcurrency)));
    const t0 = Date.now();
    const store = await openPlaceStore({ key: placeKey({ lat, lng }) });
    const report = await pullPlace(store, { objects: new SceneObjectStore(new DurableAssetStore(path.join(root, 'home'))), readingsDir: path.join(root, 'model_readings'), workspace: root }, { ...PLACE_STORE_PARAMS, pullConcurrency: concurrency });
    console.log(JSON.stringify({ key: placeKey({ lat, lng }), concurrency, wallMs: Date.now() - t0, report }, null, 1));
}

main().then(() => process.exit(0), err => { console.error(err); process.exit(1); });
