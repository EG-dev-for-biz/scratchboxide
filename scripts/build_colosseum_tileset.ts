import { Splat3DTilesService } from '../packages/core/src/node/spatial/Splat3DTilesService';
import fs from 'fs-extra';
import path from 'path';

async function main() {
    const outDir = path.resolve('public/tilesets/colosseum');
    const treePath = path.join(outDir, 'tree.json');
    const tilesetPath = path.join(outDir, 'tileset.json');
    const metaPath = path.join(outDir, 'tileset.meta.json');

    const tree = await fs.readJson(treePath);
    const origin = { lat: 41.8902, lng: 12.4922, alt: 22.0 };
    const rootTransform = Splat3DTilesService.computeRootTransform(origin, 0);
    const tileset = Splat3DTilesService.buildTileset(tree.root, rootTransform, tree.totalSplats);
    await fs.writeJson(tilesetPath, tileset, { spaces: 2 });
    console.log(`Wrote ${tilesetPath} with root geometricError: ${tileset.root.geometricError}, splats: ${tree.totalSplats}`);

    // Update metadata
    if (await fs.pathExists(metaPath)) {
        const meta = await fs.readJson(metaPath);
        meta.fusedSplatCount = tree.totalSplats;
        meta.tiles = {
            tileCount: tree.nodeCount,
            levels: 5,
            totalSplats: tree.totalSplats
        };
        await fs.writeJson(metaPath, meta, { spaces: 2 });
        console.log(`Updated ${metaPath}`);
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
