/**
 * Blob graph prototype (dev tool, not shipped), step 1: the district's inputs.
 *
 * - the seam weld of the raw textured extraction (tile-seam-weld-service.ts), kept beside it;
 * - the tree strip's canopy cells (tile-vegetation-service.ts `canopy`: its classifier only, nothing regrown or removed);
 * - Google's vector evidence (building footprints, roads, water) around the extraction's origin (vector-footprints.ts).
 *
 *   node -r ts-node/register scripts/dev/blob-graph/prep.ts --raw <raw textured .glb> --out <dir> --lat <lat> --lng <lng> --radius <m>
 *
 * The vector tiles are fetched with the app's service account (needs the workspace .env); a few tiles, no model calls.
 */
import * as fs from 'fs';
import * as path from 'path';
import { runTileSeamWeld } from '../../../packages/core/src/node/3d-engine/tile-seam-weld-service';
import { TileVegetationService } from '../../../packages/core/src/node/3d-engine/tile-vegetation-service';
import { fetchVectorEvidence } from '../../../packages/core/src/node/3d-engine/staged-location/vector-footprints';
import { GoogleVectorTileService } from '../../../packages/core/src/node/spatial/GoogleVectorTileService';

function arg(name: string, fallback?: string): string {
    const i = process.argv.indexOf(`--${name}`);
    const v = i >= 0 ? process.argv[i + 1] : fallback;
    if (v === undefined) throw new Error(`--${name} is required`);
    return v;
}

async function main(): Promise<void> {
    const raw = path.resolve(arg('raw'));
    const out = path.resolve(arg('out'));
    const lat = Number(arg('lat')), lng = Number(arg('lng')), radiusM = Number(arg('radius'));
    const repoRoot = path.resolve(__dirname, '../../..');
    fs.mkdirSync(out, { recursive: true });
    const welded = path.join(out, 'welded.glb');
    if (!fs.existsSync(welded)) {
        const t0 = Date.now();
        const r = await runTileSeamWeld({ inputGlb: raw, outputGlb: welded, repoRoot, threads: 4, timeoutMs: 600_000 });
        fs.writeFileSync(path.join(out, 'weld.json'), JSON.stringify({ ...r, ms: Date.now() - t0 }, null, 1));
        console.log(`weld: ${r.inputTriangles} -> ${r.outputTriangles} triangles in ${Date.now() - t0} ms`);
    }
    const canopyFile = path.join(out, 'canopy.json');
    if (!fs.existsSync(canopyFile)) {
        const veg = new TileVegetationService({ workspaceRoot: path.dirname(out), repoRoot });
        const c = await veg.canopy({ tilePath: welded, cellM: 0.5, timeoutMs: 600_000 });
        fs.writeFileSync(canopyFile, JSON.stringify(c.mask));
        console.log(`canopy: ${c.mask.canopyCells} cells of ${c.mask.nx * c.mask.nz} in ${c.ms} ms`);
    }
    const vectorFile = path.join(out, 'vector.json');
    if (!fs.existsSync(vectorFile)) {
        const ev = await fetchVectorEvidence({ lat, lng, radiusM, fetchTile: (x, y, z) => GoogleVectorTileService.fetchVectorTile(x, y, z, '') as never });
        fs.writeFileSync(vectorFile, JSON.stringify({ origin: { lat, lng }, radiusM, ...ev }));
        console.log(`vector: ${ev.buildings.length} buildings, ${ev.roads.length} roads from ${ev.tiles} tiles`);
    }
}

main().catch(err => { console.error(err); process.exit(1); });
