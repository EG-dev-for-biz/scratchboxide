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
        subdivisionIterations: 1,
        sculptStrength: 1.0,
        recenterOrigin: true
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
        2048
    );

    console.log('  -> Albedo PNG size:', texturePack.albedoPng.length, 'bytes');
    console.log('  -> Normal PNG size:', texturePack.normalPng.length, 'bytes');
    console.log('  -> ORM PNG size:', texturePack.ormPng.length, 'bytes');

    // Export GLB 2.0 Binary Model
    console.log('[4/4] Packaging binary glTF 2.0 (.glb) with embedded PBR textures...');
    const outGlbPath = path.resolve('public/models/sbhuman_hand_hyperreal.glb');
    const glbBuf = SbHumanHandTransformer.exportGlb(transformed, texturePack, outGlbPath);

    console.log('  -> Exported GLB size:', glbBuf.length, 'bytes to:', outGlbPath);
    console.log('--- Transformation Successfully Completed ---');
}

main().catch(err => {
    console.error('Error running hand transformation:', err);
    process.exit(1);
});
