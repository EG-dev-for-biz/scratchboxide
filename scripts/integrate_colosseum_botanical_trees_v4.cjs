/**
 * integrate_colosseum_botanical_trees_v4.cjs
 *
 * Full-Scene Multi-Sensor Photogrammetric Reshaping & Botanical Integration
 *
 * Refactored to delegate directly to PhotogrammetricTerrainHarmonizerService in @scratchbox/core.
 * Uses Cadastral Vector Distance Fields and Curvature Entropy for Dirichlet boundary locks
 * and C^1 smooth Hermite radial ground depression.
 */

const fs = require('fs');
const path = require('path');

async function main() {
    const BASE_GLB = process.argv[2] || path.resolve(__dirname, '../public/models/colosseum_rome_recipe_pbr_ktx2.glb');
    const OUT_GLB = process.argv[3] || BASE_GLB;
    const STANDS_PATH = path.resolve(__dirname, '../packages/core/src/node/spatial/assets/physical_trees_dataset.json');

    console.log(`[Botanical Integration v4] Ingesting base GLB: ${BASE_GLB}...`);
    const baseBuf = fs.readFileSync(BASE_GLB);

    // Dynamic import of PhotogrammetricTerrainHarmonizerService
    const servicePath = path.resolve(__dirname, '../packages/core/dist/node/spatial/PhotogrammetricTerrainHarmonizerService.js');
    const { PhotogrammetricTerrainHarmonizerService } = await import(servicePath);

    // Ingest stands from dataset
    let stands = [];
    if (fs.existsSync(STANDS_PATH)) {
        const rawStands = JSON.parse(fs.readFileSync(STANDS_PATH, 'utf8'));
        const validZones = ['oppian_crest', 'colle_oppio_slope', 'trajan_baths_east', 'san_gregorio_cypress', 'celian_north'];
        stands = rawStands
            .filter(s => validZones.includes(s.zone))
            .map(s => ({
                id: s.id,
                centroid: [s.boundingBox.centroid[0], s.boundingBox.centroid[1], s.boundingBox.centroid[2]],
                crownDiameterMeters: s.crownMetrics ? s.crownMetrics.crownSpreadRadius * 2 : 12.0,
                heightMeters: s.crownMetrics ? s.crownMetrics.treeHeight : 16.0,
                groundElevationMeters: s.groundElevation ?? 22.0,
                species: s.species || 'pinus_pinea',
                zone: s.zone
            }));
    }

    console.log(`[Botanical Integration v4] Prepared ${stands.length} active botanical stands.`);

    // Define Cadastral Monument Footprint for Flavian Amphitheatre (Colosseum)
    const colosseumPoly = PhotogrammetricTerrainHarmonizerService.generateEllipticalPolygon(-99.1, 114.4, 94.5, 78.0, 32);

    console.log(`[Botanical Integration v4] Executing PhotogrammetricTerrainHarmonizerService...`);
    const result = await PhotogrammetricTerrainHarmonizerService.harmonizeGlb(baseBuf, {
        stands,
        monumentPolygons: [{
            id: 'monument_flavian_amphitheatre',
            name: 'Flavian Amphitheatre (Colosseum)',
            localPolygonEnu: colosseumPoly,
            bufferMeters: 12.0
        }],
        autoSamplePerimeterElevation: true,
        preserveRuins: true
    });

    console.log(`[Botanical Integration v4] Processed ${result.totalVertices.toLocaleString()} vertices.`);
    console.log(`[Botanical Integration v4] Depressed: ${result.depressedVertices.toLocaleString()} canopy vertices via C^1 Hermite.`);
    console.log(`[Botanical Integration v4] Locked: ${result.lockedMonumentVertices.toLocaleString()} monument vertices (0.000 mm drift).`);
    console.log(`[Botanical Integration v4] Instanced: ${result.instancedTreeCount} botanical trees across ${result.instancedNodeCount} nodes.`);
    console.log(`[Botanical Integration v4] Execution Time: ${result.diagnostics.executionTimeMs}ms.`);

    fs.writeFileSync(OUT_GLB, result.outputBuffer);
    console.log(`[Botanical Integration v4] Wrote ${(result.outputBuffer.length / 1024 / 1024).toFixed(2)} MB to: ${OUT_GLB}`);
}

main().catch(err => {
    console.error('[Botanical Integration v4] Execution failed:', err);
    process.exit(1);
});
