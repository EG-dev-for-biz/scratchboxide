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
    // Major axis is aligned with North-South (Z-axis, radiusZ = 122.0m, fully enclosing northern attic to Z = -153.7m)
    // Minor axis is aligned with East-West (X-axis, radiusX = 98.0m, fully enclosing outer arcades)
    // Center: (12.58, -31.69), rotation = -5 deg
    // 1.0m buffer strictly protects the monument structure while allowing adjacent facade tree blobs to be detected and replaced
    const colosseumPoly = PhotogrammetricTerrainHarmonizerService.generateEllipticalPolygon(
        12.58,
        -31.69,
        98.0,
        122.0,
        64,
        -5.0 * Math.PI / 180
    );

    // Define Cadastral Building & Monument Polygons (Pillar 2: 100% Immutable Dirichlet Locks)
    // 1. Northern Block (Via Nicola Salvi / Piazza del Colosseo commercial & residential palazzo strictly X: [15, 65], Z: [-190, -130])
    const northSalviPoly = PhotogrammetricTerrainHarmonizerService.generateRectangularPolygon(15, -190, 65, -130);
    // 2. Northwest Block (Via dei Fori Imperiali / Metro Colosseo palazzo block)
    const nwMetroPoly = PhotogrammetricTerrainHarmonizerService.generateRectangularPolygon(-120, -200, -55, -145);
    // 3. Arch of Constantine (Strict metric footprint: X in [-150, -131], Z in [-62, -33])
    const archPoly = PhotogrammetricTerrainHarmonizerService.generateRectangularPolygon(-150, -62, -131, -33);
    // 4. Temple of Venus and Roma platform podium (Strict metric footprint: X in [-175, -105], Z in [12, 65])
    const venusPoly = PhotogrammetricTerrainHarmonizerService.generateRectangularPolygon(-175, 12, -105, 65);

    console.log(`[Botanical Integration v4] Executing dynamic 3D photo tile canopy resection & harmonization...`);
    const result = await PhotogrammetricTerrainHarmonizerService.harmonizeGlb(baseBuf, {
        autoResectStands: true,
        renderMode: RENDER_MODE,
        datumCutoffElevation: -15.0,
        monumentPolygons: [
            {
                id: 'monument_flavian_amphitheatre',
                name: 'Flavian Amphitheatre & Pedestrian Concourse',
                localPolygonEnu: colosseumPoly,
                bufferMeters: 1.0
            },
            {
                id: 'monument_arch_constantine',
                name: 'Arch of Constantine Footprint',
                localPolygonEnu: archPoly,
                bufferMeters: 2.0
            },
            {
                id: 'monument_temple_of_venus',
                name: 'Temple of Venus and Roma Platform',
                localPolygonEnu: venusPoly,
                bufferMeters: 2.0
            }
        ],
        buildingPolygons: [
            {
                id: 'building_nicola_salvi_palazzo',
                name: 'Via Nicola Salvi Palazzo Block',
                localPolygonEnu: northSalviPoly,
                bufferMeters: 3.0
            },
            {
                id: 'building_metro_colosseo_block',
                name: 'Metro Colosseo Palazzo Block',
                localPolygonEnu: nwMetroPoly,
                bufferMeters: 3.0
            }
        ],
        resectGridCellSizeMeters: 2.5,
        minTreeHeightMeters: 2.0,
        maxTreeHeightMeters: 80.0,
        minTrunkSpacingMeters: 6.5,
        fadeRadiusMultiplier: 1.8,
        maxCanopyThicknessMeters: 80.0,
        autoSamplePerimeterElevation: true,
        preserveRuins: true,
        pruneCurtainWalls: true,
        curtainWallSpanThresholdMeters: 3.5,
        enableDenseCanopyFill: true,
        denseCanopySpacingMeters: 8.0,
        pruneElevatedCanopyTriangles: true,
        pruneSkyShards: true,
        maxPerimeterRadiusMeters: 260.0,
        perimeterCenter: [12.58, -31.69]
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
