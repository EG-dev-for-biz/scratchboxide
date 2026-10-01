/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Extract and synthesize authentic PBR texture maps from forest_reference.png
 * using the zero-dependency texture processing pipeline.
 ********************************************************************************/

import * as fs from 'fs';
import * as path from 'path';
import {
    decodePng,
    encodePng,
    makeToroidalSeamless,
    decomposeRgbaToPbr
} from '../packages/core/src/node/texture-processing';

function cropRgba(
    srcRgba: Buffer,
    srcW: number,
    srcH: number,
    cropX: number,
    cropY: number,
    cropW: number,
    cropH: number
): Buffer {
    const dst = Buffer.alloc(cropW * cropH * 4);
    for (let y = 0; y < cropH; y++) {
        const sy = Math.min(srcH - 1, Math.max(0, cropY + y));
        for (let x = 0; x < cropW; x++) {
            const sx = Math.min(srcW - 1, Math.max(0, cropX + x));
            const srcIdx = (sy * srcW + sx) * 4;
            const dstIdx = (y * cropW + x) * 4;
            dst[dstIdx + 0] = srcRgba[srcIdx + 0];
            dst[dstIdx + 1] = srcRgba[srcIdx + 1];
            dst[dstIdx + 2] = srcRgba[srcIdx + 2];
            dst[dstIdx + 3] = srcRgba[srcIdx + 3];
        }
    }
    return dst;
}

async function main() {
    console.log('🌲 Extracting authentic photo-derived PBR textures from public/forest_reference.png...');

    const refPath = path.resolve(__dirname, '../public/forest_reference.png');
    const outDir = path.resolve(__dirname, '../public/textures');
    if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
    }

    const imgBuf = fs.readFileSync(refPath);
    const img = decodePng(imgBuf);
    console.log(`📸 Loaded reference photo (${img.width}x${img.height})`);

    const crops = [
        {
            name: 'photo_redwood_bark',
            x: 120,
            y: 200,
            w: 256,
            h: 256,
            bumpStrength: 2.8,
            feather: 0.18
        },
        {
            name: 'photo_forest_floor',
            x: 520,
            y: 440,
            w: 256,
            h: 256,
            bumpStrength: 1.8,
            feather: 0.20
        },
        {
            name: 'photo_moss',
            x: 340,
            y: 380,
            w: 256,
            h: 256,
            bumpStrength: 2.2,
            feather: 0.18
        },
        {
            name: 'photo_fern',
            x: 180,
            y: 480,
            w: 256,
            h: 256,
            bumpStrength: 1.5,
            feather: 0.15
        },
        {
            name: 'photo_canopy',
            x: 420,
            y: 40,
            w: 256,
            h: 256,
            bumpStrength: 1.6,
            feather: 0.18
        }
    ];

    for (const c of crops) {
        console.log(`\n🔨 Processing ${c.name} at (${c.x}, ${c.y}, ${c.w}x${c.h})...`);
        const rawCrop = cropRgba(img.rgba, img.width, img.height, c.x, c.y, c.w, c.h);
        const seamlessRgba = makeToroidalSeamless(rawCrop, c.w, c.h, c.feather);

        const pbr = decomposeRgbaToPbr(seamlessRgba, c.w, c.h, {
            bumpStrength: c.bumpStrength,
            isMetallic: false
        });

        const albedoPath = path.join(outDir, `${c.name}_albedo.png`);
        const normalPath = path.join(outDir, `${c.name}_normal.png`);
        const ormPath = path.join(outDir, `${c.name}_orm.png`);

        fs.writeFileSync(albedoPath, pbr.albedoPng);
        fs.writeFileSync(normalPath, pbr.normalPng);
        fs.writeFileSync(ormPath, pbr.ormPng);

        console.log(`   Saved ${c.name}_albedo.png (${pbr.albedoPng.length} bytes)`);
        console.log(`   Saved ${c.name}_normal.png (${pbr.normalPng.length} bytes)`);
        console.log(`   Saved ${c.name}_orm.png    (${pbr.ormPng.length} bytes)`);
    }

    console.log('\n✅ All 15 photo-derived PBR maps synthesized successfully in public/textures/');
}

main().catch(err => {
    console.error('Fatal error in texture extraction:', err);
    process.exit(1);
});
