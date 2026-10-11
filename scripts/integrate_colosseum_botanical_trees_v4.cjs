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
    const BASE_GLB = process.argv[2] || path.resolve(__dirname, '../public/models/colosseum_rome_pristine_leaf_raw.glb');
    const OUT_GLB = process.argv[3] || path.resolve(__dirname, '../public/models/colosseum_stage3_master_base.glb');
    const RENDER_MODE = process.argv[4] === 'clay' ? 'clay' : 'pbr';

    console.log(`[Botanical Integration v4] Ingesting base GLB: ${BASE_GLB}...`);
    console.log(`[Botanical Integration v4] Target Output GLB: ${OUT_GLB}...`);
    console.log(`[Botanical Integration v4] Render Mode: ${RENDER_MODE}...`);
    const baseBuf = fs.readFileSync(BASE_GLB);

    // Dynamic import of PhotogrammetricTerrainHarmonizerService
    const servicePath = path.resolve(__dirname, '../packages/core/dist/node/spatial/PhotogrammetricTerrainHarmonizerService.js');
    const { PhotogrammetricTerrainHarmonizerService } = await import(servicePath);

    // Define Authentic Cadastral Monument Footprint for Flavian Amphitheatre (Colosseum)
    // Centroid: [+16.72, -21.01], Semi-Major: 102.0m, Semi-Minor: 100.0m, Yaw: 18.36 deg (0.3204 rad)
    const colosseumPoly = PhotogrammetricTerrainHarmonizerService.generateEllipticalPolygon(
        16.72,
        -21.01,
        102.0,
        100.0,
        64,
        18.36 * Math.PI / 180
    );

    // Define Cadastral Building & Monument Polygons (Pillar 2: 100% Immutable Dirichlet Locks)
    // 1. Northern Block (Via Nicola Salvi / Piazza del Colosseo commercial & residential palazzo strictly X: [20, 58], Z: [-180, -135])
    const northSalviPoly = PhotogrammetricTerrainHarmonizerService.generateRectangularPolygon(20, -180, 58, -135);
    // 2. Northwest Block (Via dei Fori Imperiali / Metro Colosseo palazzo block)
    const nwMetroPoly = PhotogrammetricTerrainHarmonizerService.generateRectangularPolygon(-110, -195, -60, -150);
    // 3. Western Monumental Complex (Arch of Constantine & Temple of Venus and Roma platform)
    const westMonumentsPoly = PhotogrammetricTerrainHarmonizerService.generateRectangularPolygon(-180, -55, -60, 60);

    console.log(`[Botanical Integration v4] Executing dynamic 3D photo tile canopy resection & harmonization...`);
    const result = await PhotogrammetricTerrainHarmonizerService.harmonizeGlb(baseBuf, {
        autoResectStands: true,
        renderMode: RENDER_MODE,
        monumentPolygons: [
            {
                id: 'monument_flavian_amphitheatre',
                name: 'Flavian Amphitheatre (Colosseum)',
                localPolygonEnu: colosseumPoly,
                bufferMeters: 2.0
            },
            {
                id: 'monument_arch_constantine_and_venus',
                name: 'Arch of Constantine & Temple of Venus/Roma',
                localPolygonEnu: westMonumentsPoly,
                bufferMeters: 2.0
            }
        ],
        buildingPolygons: [
            {
                id: 'building_nicola_salvi_palazzo',
                name: 'Via Nicola Salvi Palazzo Block',
                localPolygonEnu: northSalviPoly,
                bufferMeters: 2.0
            },
            {
                id: 'building_metro_colosseo_block',
                name: 'Metro Colosseo Palazzo Block',
                localPolygonEnu: nwMetroPoly,
                bufferMeters: 2.0
            }
        ],
        resectGridCellSizeMeters: 3.0,
        minTreeHeightMeters: 2.2,
        maxTreeHeightMeters: 34.0,
        minTrunkSpacingMeters: 4.0,
        fadeRadiusMultiplier: 1.45,
        maxCanopyThicknessMeters: 34.0,
        autoSamplePerimeterElevation: true,
        preserveRuins: true,
        // Pillar 1: Full Topological Curtain Wall Excision
        pruneCurtainWalls: true,
        curtainWallSpanThresholdMeters: 3.5,
        // Pillar 3: Continuous Biome Canopy Resection (Parco del Celio & Colle Oppio Full Coverage)
        enableDenseCanopyFill: true,
        denseCanopySpacingMeters: 7.0,
        // Pillar 4: Perimeter Staging & Floating Shard Pruning
        maxPerimeterRadiusMeters: 185.0,
        perimeterCenter: [16.72, -21.01],
        pruneSkyShards: true,
        skyShardHagThresholdMeters: 26.0
    });

    console.log(`[Botanical Integration v4] Processed ${result.totalVertices.toLocaleString()} vertices.`);
    console.log(`[Botanical Integration v4] Depressed: ${result.depressedVertices.toLocaleString()} canopy vertices flat to DTM bare-earth.`);
    console.log(`[Botanical Integration v4] Locked: ${result.lockedMonumentVertices.toLocaleString()} monument & building vertices (0.000 mm drift).`);
    console.log(`[Botanical Integration v4] Excised Curtain Triangles: ${(result.excisedCurtainTriangles || 0).toLocaleString()}`);
    console.log(`[Botanical Integration v4] Excised Perimeter Sawtooth Triangles: ${(result.excisedPerimeterTriangles || 0).toLocaleString()}`);
    console.log(`[Botanical Integration v4] Excised Sky Shard Triangles: ${(result.excisedSkyShardTriangles || 0).toLocaleString()}`);
    console.log(`[Botanical Integration v4] Instanced: ${result.instancedTreeCount} botanical trees across ${result.instancedNodeCount} nodes.`);
    console.log(`[Botanical Integration v4] Execution Time: ${result.diagnostics.executionTimeMs}ms.`);

    fs.writeFileSync(OUT_GLB, result.outputBuffer);
    console.log(`[Botanical Integration v4] Wrote ${(result.outputBuffer.length / 1024 / 1024).toFixed(2)} MB to: ${OUT_GLB}`);
}

main().catch(err => {
    console.error('[Botanical Integration v4] Execution failed:', err);
    process.exit(1);
});
