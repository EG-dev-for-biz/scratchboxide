const fs = require('fs');
const path = require('path');
const { SbHumanLoader } = require('../packages/core/dist/common/spatial/SbHumanLoader.js');
const { SbHumanHandTransformer } = require('../packages/core/dist/node/spatial/SbHumanHandTransformer.js');
const { AdaptiveUvOrchestrator } = require('../packages/core/dist/node/3d-engine/adaptive-uv-orchestrator.js');

async function main() {
    console.log('--- SB-Human Hand Hyper-Real Transformation ---');
    const sbHumanPath = path.resolve('public/models/sbhuman_neutral.sbhuman');
    const buf = fs.readFileSync(sbHumanPath);
    const loader = SbHumanLoader.parse(buf);

    console.log('[1/5] Loaded sbhuman model. Total vertices in full body:', loader.header.numVertices);

    // Transform Hand with C^2 Loop subdivision + anatomical sculpting
    console.log('[2/5] Transforming hand geometry (subdivision, anatomical sculpting, conformal UVs)...');
    const transformed = SbHumanHandTransformer.transformHand(loader, {
        subdivisionIterations: 2,
        sculptStrength: 1.0,
        recenterOrigin: true,
        tuftSquovalExponent: 3.2,
        phalangealWaisting: 0.015,
        jointCondylarFlare: 0.018,
        tendonElevationMm: 1.8,
        volarPulpBulgeMm: 1.8
    });

    console.log('  -> Hand Vertices:', transformed.numVertices);
    console.log('  -> Hand Triangles:', transformed.numTriangles);

    // Run Adaptive UV & PBR Orchestrator Topology Analysis
    console.log('[3/5] Executing Adaptive UV & PBR Orchestrator Topology Analysis (AdaptiveUvOrchestrator)...');
    const tempGlbPath = path.resolve('public/models/sbhuman_hand_hyperreal.glb');
    if (fs.existsSync(tempGlbPath)) {
        const probeResult = AdaptiveUvOrchestrator.probeTopology(tempGlbPath, 'organic');
        console.log('  -> Domain Classification:', probeResult.domainClassification, `(${probeResult.domainSource})`);
        console.log('  -> Recommended UV Strategy:', probeResult.recommendedStrategy, '-', probeResult.routingRule);
        console.log('  -> Method That Runs:', probeResult.methodThatRuns);
        console.log('  -> Seams:', probeResult.seams);
    }

    // Bake Delighted Photographic PBR Texture Atlas (2048 x 2048) from User Reference Photos
    console.log('[4/5] Baking photographic PBR texture atlas directly from user reference photos...');
    const dorsalRef = path.resolve('public/textures/reference_user/user_dorsal_raw.png');
    const palmarRef = path.resolve('public/textures/reference_user/user_palmar_raw.png');
    const texOutDir = path.resolve('public/textures/humanoid');

    const texturePack = SbHumanHandTransformer.bakePhotographicPbrTextures(
        dorsalRef,
        palmarRef,
        texOutDir,
        2048,
        2048
    );

    console.log('  -> Albedo PNG size:', texturePack.albedoPng.length, 'bytes');
    console.log('  -> Normal PNG size:', texturePack.normalPng.length, 'bytes');
    console.log('  -> ORM PNG size:', texturePack.ormPng.length, 'bytes');

    // Mechanical Mathematical Invariant Verification
    console.log('[*] Verifying mechanical invariants across mesh topology and PBR texture pack...');
    const invResult = SbHumanHandTransformer.assertInvariants(transformed, texturePack);
    for (const check of invResult.checks) {
        console.log(`  [${check.passed ? 'PASS' : 'FAIL'}] ${check.name}: ${check.details}`);
    }
    if (!invResult.valid) {
        throw new Error(`Mathematical invariant verification failed: ${invResult.errors.join('; ')}`);
    }

    // Export GLB 2.0 Binary Model
    console.log('[5/5] Packaging binary glTF 2.0 (.glb) with embedded PBR textures...');
    const outGlbPath = path.resolve('public/models/sbhuman_hand_hyperreal.glb');
    const glbBuf = SbHumanHandTransformer.exportGlb(transformed, texturePack, outGlbPath);

    console.log('  -> Exported GLB size:', glbBuf.length, 'bytes to:', outGlbPath);
    console.log('--- Transformation Successfully Completed ---');
}

main().catch(err => {
    console.error('Error running hand transformation:', err);
    process.exit(1);
});
