/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs';
import * as path from 'path';
import {
    synthesizeBiophysicalSkinPbr,
    synthesizeBiophysicalNailPbr
} from '../packages/core/src/node/texture-processing';

const OUTPUT_DIR = path.resolve(__dirname, '../public/textures/humanoid');

async function main() {
    console.log('🔬 [PBR Pipeline] Synthesizing biophysical humanoid skin and nail textures...');
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    // 1. Synthesize Skin PBR Set (512x512 with micro-sulci & pores)
    console.log('  -> Generating Skin PBR Maps (512x512)...');
    const skinSet = synthesizeBiophysicalSkinPbr(512, 512, {
        melaninFraction: 0.35,
        pheomelaninRatio: 0.20,
        poreDensity: 48.0,
        sulciScale: 36.0,
        vascularity: 0.35,
        roughnessBaseline: 0.48,
        normalStrength: 2.5,
        seed: 1337
    });

    fs.writeFileSync(path.join(OUTPUT_DIR, 'skin_albedo.png'), skinSet.albedoPng);
    fs.writeFileSync(path.join(OUTPUT_DIR, 'skin_normal.png'), skinSet.normalPng);
    fs.writeFileSync(path.join(OUTPUT_DIR, 'skin_orm.png'), skinSet.ormPng);
    fs.writeFileSync(path.join(OUTPUT_DIR, 'skin_height.png'), skinSet.heightPng);
    console.log('     ✓ Saved skin_albedo.png, skin_normal.png, skin_orm.png, skin_height.png');

    // 2. Synthesize Fingernail PBR Set (512x512 with 4-zone morphology & anisotropic striations)
    console.log('  -> Generating Fingernail PBR Maps (512x512)...');
    const nailSet = synthesizeBiophysicalNailPbr(512, 512, {
        lunulaWidth: 0.22,
        bedPinkFlush: 0.65,
        freeEdgeWidth: 0.12,
        striationDensity: 64.0,
        roughnessBaseline: 0.14,
        normalStrength: 1.8,
        seed: 2026
    });

    fs.writeFileSync(path.join(OUTPUT_DIR, 'nail_albedo.png'), nailSet.albedoPng);
    fs.writeFileSync(path.join(OUTPUT_DIR, 'nail_normal.png'), nailSet.normalPng);
    fs.writeFileSync(path.join(OUTPUT_DIR, 'nail_orm.png'), nailSet.ormPng);
    fs.writeFileSync(path.join(OUTPUT_DIR, 'nail_height.png'), nailSet.heightPng);
    console.log('     ✓ Saved nail_albedo.png, nail_normal.png, nail_orm.png, nail_height.png');

    console.log('✨ [PBR Pipeline] All biophysical humanoid textures successfully generated at:', OUTPUT_DIR);
}

main().catch(err => {
    console.error('❌ [PBR Pipeline Error]:', err);
    process.exit(1);
});
