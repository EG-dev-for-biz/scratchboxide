import * as path from 'path';
import * as fs from 'fs';
import { Universal3DObjectSeparationService } from '../packages/core/src/node/spatial/Universal3DObjectSeparationService';

async function main() {
    const glbPath = path.resolve(__dirname, '../public/models/washington_arch_hq.glb');
    console.log(`Starting semantic separation on High-Quality Washington Square Arch tile: ${glbPath}`);
    const stat = fs.statSync(glbPath);
    console.log(`File size: ${(stat.size / (1024 * 1024)).toFixed(2)} MB`);

    const t0 = performance.now();
    const scene = await Universal3DObjectSeparationService.separate3DMesh(glbPath, {
        granularity: 'detailed',
        enableVertexClustering: true
    });
    const duration = performance.now() - t0;

    console.log(`\n=== EMPIRICAL SEPARATION RESULTS ===`);
    console.log(`Execution Time: ${duration.toFixed(2)} ms`);
    console.log(`Total Vertices: ${scene.totalVertices.toLocaleString()}`);
    console.log(`Total Submeshes: ${scene.totalSubmeshes}`);
    console.log(`Total Discrete Entities: ${scene.totalEntities}`);
    console.log(`Object Counts:`, scene.objectCounts);

    const trees = scene.objects.filter(o => o.category === 'foliage_trees');
    console.log(`\nFound ${trees.length} discrete trees:`);
    const speciesCounts: Record<string, number> = {};
    for (const tree of trees) {
        const sp = tree.treeMetadata?.species || 'unknown';
        speciesCounts[sp] = (speciesCounts[sp] || 0) + 1;
    }
    console.log(`Tree Taxonomy Breakdown:`, speciesCounts);

    const sampleTree = trees[0];
    if (sampleTree) {
        console.log(`\nSample Tree 3D Spec:`, {
            name: sampleTree.name,
            species: sampleTree.treeMetadata?.species,
            canopyHeight: sampleTree.treeMetadata?.canopyHeightMeters,
            crownDiameter: sampleTree.treeMetadata?.crownDiameterMeters,
            crownVolume: sampleTree.treeMetadata?.crownVolumeM3,
            obbDimensions: sampleTree.orientedBoundingBox?.dimensions,
            tightnessGain: sampleTree.tightnessGainPercent
        });
    }

    const monuments = scene.objects.filter(o => o.category === 'monument');
    console.log(`\nMonuments (${monuments.length}):`, monuments.map(m => m.name));

    // Save into semantic_separation_data.json
    const cachePath = path.resolve(__dirname, '../public/data/semantic_separation_data.json');
    let cache: any = {};
    if (fs.existsSync(cachePath)) {
        cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    }
    cache.washington_arch_hq = {
        detailed: scene
    };
    fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
    console.log(`\nUpdated public/data/semantic_separation_data.json with HQ tile data.`);
}

main().catch(err => {
    console.error('Separation failed:', err);
    process.exit(1);
});
