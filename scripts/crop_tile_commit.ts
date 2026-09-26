/**
 * Derives a smaller tile commit from a parent commit: the parent's leaf tiles whose footprint centre lies within
 * --radius of a local-frame point, rebuilt from the leaf cache in the parent's exact frame (same localToEcef).
 *
 * Usage:
 *   npx vite-node scripts/crop_tile_commit.ts -- --commit public/world/plaza-hotel/base/commit.json \
 *     --center 30,30 --radius 85 --out public/world/plaza-hotel/eloise-crop --commit-id plaza-hotel-eloise-crop
 * --center is local x (east), z (south) in metres.
 */
import * as fs from 'fs';
import * as path from 'path';
import { GoogleTileDistrictCrawler } from '../packages/core/src/node/spatial/GoogleTileDistrictCrawler';

function arg(name: string, fallback?: string): string {
    const i = process.argv.indexOf(`--${name}`);
    if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
    if (fallback === undefined) throw new Error(`--${name} is required`);
    return fallback;
}

function main() {
    const commitPath = path.resolve(arg('commit'));
    const commit = JSON.parse(fs.readFileSync(commitPath, 'utf8'));
    const [cx, cz] = arg('center').split(',').map(Number);
    const radius = Number(arg('radius'));
    const outDir = path.resolve(arg('out'));
    const commitId = arg('commit-id');
    const cacheDir = path.resolve(arg('cache', '.scratchbox/tiles_cache/leaves'));

    // localToEcef is column-major: columns are east, up, south, origin.
    const m: number[] = commit.frame.localToEcef;
    const axes = [[m[0], m[1], m[2]], [m[4], m[5], m[6]], [m[8], m[9], m[10]]];
    const origin = [m[12], m[13], m[14]];
    const toLocal = (e: number[]) => axes.map(a => a.reduce((s, v, k) => s + v * (e[k] - origin[k]), 0));

    const selected = (commit.source.tiles as Array<{ id: string; geometricError: number; box: number[] }>).filter(tile => {
        const [x, , z] = toLocal(tile.box.slice(0, 3));
        const halfExtent = Math.max(...[3, 6, 9].map(o => Math.hypot(tile.box[o], tile.box[o + 1], tile.box[o + 2])));
        return Math.hypot(x - cx, z - cz) <= radius + halfExtent;
    });
    const missing = selected.filter(t => !fs.existsSync(path.join(cacheDir, `${t.id}.glb`)));
    if (missing.length) {
        throw new Error(`${missing.length} selected tiles are not in the leaf cache (${cacheDir}); re-run the parent pull first.`);
    }
    const parsed = selected.flatMap(t => GoogleTileDistrictCrawler.parseLeafGlbPrimitives(fs.readFileSync(path.join(cacheDir, `${t.id}.glb`))));
    const district = GoogleTileDistrictCrawler.buildDistrictGlb(parsed, { lat: commit.frame.anchor.lat, lng: commit.frame.anchor.lng }, {
        name: commitId,
        originEllipsoidalHeightM: commit.frame.originEllipsoidalHeightM
    });
    const sameFrame = district.localToEcef.every((v, i) => Math.abs(v - m[i]) < 1e-6);
    if (!sameFrame) throw new Error('Cropped commit frame differs from the parent frame.');

    const { glbPath, manifestPath, manifest } = GoogleTileDistrictCrawler.writeCommit(district, {
        outDir,
        commitId,
        glbFileName: `${commitId}.glb`,
        location: commit.location,
        radiusMeters: radius,
        dilateMeters: 0,
        leaves: selected,
        fetchedAt: commit.createdAt,
        parent: commit.id
    });
    console.log(JSON.stringify({
        glbPath, manifestPath, parent: commit.id, tiles: district.tileCount, triangles: district.triangleCount,
        textures: district.textureCount, megabytes: +(district.glb.length / 1e6).toFixed(1), sha256: manifest.glb.sha256
    }, null, 2));
}

main();
