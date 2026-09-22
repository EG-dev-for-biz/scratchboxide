const path = require('path');
const fs = require('fs');

async function main() {
    console.log('========================================================================');
    console.log('=== RUNNING ZERO-PRESET ADAPTIVE MATERIAL PBR PIPELINE ===');
    console.log('=== Continuous Biophysical Estimation & High-Frequency Decomposition ===');
    console.log('========================================================================');

    // Dynamically import from @scratchbox/core/node
    const { AdaptiveMaterialPbrService } = require('../packages/core/dist/node.js');

    const inputGlbPath = path.resolve(__dirname, '../public/models/spce_esb_isolated_full_quality_raw.glb');
    const outputGlbPath = path.resolve(__dirname, '../public/models/spce_esb_adaptive_pbr.glb');

    console.log(`Input GLB: ${inputGlbPath}`);
    console.log(`Output GLB: ${outputGlbPath}`);

    if (!fs.existsSync(inputGlbPath)) {
        throw new Error(`Input GLB not found at ${inputGlbPath}`);
    }

    const startTime = Date.now();
    const result = await AdaptiveMaterialPbrService.decomposeToPbr(inputGlbPath, {
        outputGlbPath,
        reliefMultiplier: 1.6,
        edgeDampingFactor: 0.40,
        aoRadiusTexels: 10,
        saveDiagnosticMaps: true
    });

    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`\n>>> Pipeline Completed in ${elapsedSec}s!`);
    console.log(`- Success: ${result.success}`);
    console.log(`- Output File Size: ${(fs.statSync(outputGlbPath).size / 1024 / 1024).toFixed(2)} MB`);
    console.log(`- Total Texels Processed: ${result.totalTexelsProcessed.toLocaleString()}`);
    console.log(`- Total Atlases: ${result.atlases.length}`);

    result.atlases.forEach((atlas, i) => {
        const m = atlas.metrics;
        console.log(`  Atlas #${i} (${atlas.sourceResolution[0]}x${atlas.sourceResolution[1]}):`);
        console.log(`    * Micro-Porosity Energy: ${m.microPorosityEnergy.toFixed(4)}`);
        console.log(`    * Gradient Anisotropy:   ${m.gradientAnisotropy.toFixed(4)}`);
        console.log(`    * Conduction Index:      ${m.conductionIndex.toFixed(4)}`);
        console.log(`    * Specular F0:           ${m.specularF0.toFixed(4)}`);
        console.log(`    * Cavity Occlusion:      ${m.averageCavityDepth.toFixed(4)}`);
    });
}

main().catch(err => {
    console.error('Pipeline failed:', err);
    process.exit(1);
});
