import fs from 'fs';
import path from 'path';
import { SbHumanLoader } from '../packages/core/dist/common/spatial/SbHumanLoader.js';
import { SbHumanHandTransformer } from '../packages/core/dist/node/spatial/SbHumanHandTransformer.js';

async function main() {
    console.log('--- SB-Human Hand Hyper-Real Transformation ---');
    const sbHumanPath = path.resolve('public/models/sbhuman_neutral.sbhuman');
    const buf = fs.readFileSync(sbHumanPath);
    const loader = SbHumanLoader.parse(buf);

    console.log('[1/4] Loaded sbhuman model. Total vertices in full body:', loader.header.numVertices);

    // Transform Hand with C^2 Loop subdivision + anatomical sculpting
    console.log('[2/4] Transforming hand geometry (subdivision, anatomical sculpting, conformal UVs)...');
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

    // Bake Delighted PBR Texture Atlas (2048 x 2048)
    console.log('[3/4] Baking delighted photographic PBR texture atlas (Albedo, Normal, ORM)...');
    const palmRef = path.resolve('public/textures/humanoid/hand_palm_macro_ref.png');
    const dorsalRef = path.resolve('public/textures/humanoid/hand_dorsal_macro_ref.png');
    const nailRef = path.resolve('public/textures/humanoid/hand_nail_macro_ref.png');
    const texOutDir = path.resolve('public/textures/humanoid');

    const texturePack = SbHumanHandTransformer.bakePbrTextures(
        palmRef,
        dorsalRef,
        nailRef,
        texOutDir,
        2048,
        2048,
        {
            hydrationLevel: 0.68,
            capillaryBloodVolume: 0.52,
            dermalAgeFactor: 0.18
        }
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
    console.log('[4/4] Packaging binary glTF 2.0 (.glb) with embedded PBR textures...');
    const outGlbPath = path.resolve('public/models/sbhuman_hand_hyperreal.glb');
    const glbBuf = SbHumanHandTransformer.exportGlb(transformed, texturePack, outGlbPath);

    console.log('  -> Exported GLB size:', glbBuf.length, 'bytes to:', outGlbPath);
    console.log('Done!');
}

main().catch(err => {
    console.error('Hand transformation failed:', err);
    process.exit(1);
});
