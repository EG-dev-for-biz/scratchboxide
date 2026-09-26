/**
 * Pulls a district of Google Photorealistic 3D Tiles at leaf detail around a geocoded place and writes
 * a base commit (district GLB + commit.json).
 *
 *   npx vite-node scripts/pull_tile_district.ts --query "The Plaza Hotel, 768 5th Ave, New York, NY 10019" \
 *       --radius 250 --dilate 40 --out public/world/plaza-hotel/base --commit-id plaza-hotel-base
 */
import * as fs from 'fs';
import * as path from 'path';
import { GoogleTileDistrictCrawler } from '../packages/core/src/node/spatial/GoogleTileDistrictCrawler';

function arg(name: string, fallback?: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

function envKey(name: string): string | undefined {
    if (process.env[name]) return process.env[name];
    const envPath = path.resolve(process.cwd(), '.env');
    if (!fs.existsSync(envPath)) return undefined;
    const m = fs.readFileSync(envPath, 'utf8').match(new RegExp(`^${name}\\s*=\\s*"?([^"\\n]+)"?`, 'm'));
    return m?.[1]?.trim();
}

async function geocode(query: string, key: string) {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&key=${key}`;
    const body: any = await (await fetch(url)).json();
    if (body.status !== 'OK' || !body.results?.length) throw new Error(`Geocoding failed for "${query}": ${body.status} ${body.error_message ?? ''}`);
    const r = body.results[0];
    return {
        query,
        formattedAddress: r.formatted_address as string,
        placeId: r.place_id as string,
        lat: r.geometry.location.lat as number,
        lng: r.geometry.location.lng as number,
        precision: r.geometry.location_type as string
    };
}

async function main() {
    const key = envKey('GOOGLE_MAPS_API_KEY');
    if (!key) throw new Error('GOOGLE_MAPS_API_KEY is not set (environment or .env)');
    const query = arg('query');
    if (!query) throw new Error('--query is required');
    const radius = Number(arg('radius', '250'));
    const dilate = Number(arg('dilate', '40'));
    const outDir = path.resolve(arg('out', 'public/world/district/base')!);
    const commitId = arg('commit-id', path.basename(path.dirname(outDir)) + '-base')!;
    const cacheDir = path.resolve(arg('cache', '.scratchbox/tiles_cache/leaves')!);

    const location = await geocode(query, key);
    console.log(`Geocoded: ${location.formattedAddress} (${location.lat}, ${location.lng}) ${location.precision} ${location.placeId}`);

    const t0 = Date.now();
    let lastLog = 0;
    const crawler = new GoogleTileDistrictCrawler({
        apiKey: key,
        cacheDir,
        concurrency: 12,
        onProgress: (phase, done, total) => {
            if (Date.now() - lastLog > 3000) { lastLog = Date.now(); console.log(`  ${phase}: ${done}/${total}`); }
        }
    });
    const anchor = { lat: location.lat, lng: location.lng, heightGuessM: 0 };
    const { leaves, session, requests, excludedCoarseLeaves } = await crawler.collectLeafTiles(anchor, radius + dilate);
    console.log(`Traversal: ${requests} tileset requests, ${leaves.length} leaf tiles, ${excludedCoarseLeaves} coarse catch-all leaves skipped (${((Date.now() - t0) / 1000).toFixed(1)} s)`);

    const buffers = await crawler.downloadLeaves(leaves, session);
    const downloadedBytes = buffers.reduce((s, b) => s + b.length, 0);
    console.log(`Downloaded ${leaves.length} leaves, ${(downloadedBytes / 1e6).toFixed(1)} MB (${((Date.now() - t0) / 1000).toFixed(1)} s)`);

    const parsed = buffers.flatMap(b => GoogleTileDistrictCrawler.parseLeafGlbPrimitives(b));
    const district = GoogleTileDistrictCrawler.buildDistrictGlb(parsed, anchor, { name: commitId });
    const fetchedAt = new Date().toISOString();
    const { glbPath, manifestPath, manifest } = GoogleTileDistrictCrawler.writeCommit(district, {
        outDir,
        commitId,
        glbFileName: `${commitId}.glb`,
        location,
        radiusMeters: radius,
        dilateMeters: dilate,
        leaves: leaves.map(l => ({ id: l.id, geometricError: l.geometricError, box: l.box })),
        fetchedAt
    });

    console.log(JSON.stringify({
        glbPath,
        manifestPath,
        tiles: district.tileCount,
        vertices: district.vertexCount,
        triangles: district.triangleCount,
        textures: district.textureCount,
        megabytes: +(district.glb.length / 1e6).toFixed(1),
        groundEllipsoidalHeightM: +district.originEllipsoidalHeightM.toFixed(2),
        boundsLocal: district.boundsLocal,
        attribution: district.copyrights,
        leafGeometricErrorM: manifest.source.leafGeometricErrorM,
        sha256: manifest.glb.sha256,
        seconds: +((Date.now() - t0) / 1000).toFixed(1)
    }, null, 2));
}

main().catch(err => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});
