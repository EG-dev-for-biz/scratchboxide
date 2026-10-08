/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { MapsImageryGroundingService } from '../packages/core/src/node/spatial/MapsImageryGroundingService';

async function main() {
    const args = process.argv.slice(2);
    let prompt = '';
    let panoId = '';
    let lat: number | undefined;
    let lng: number | undefined;
    let out = '';
    let apiKey = '';

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--prompt' && args[i + 1]) prompt = args[++i];
        if (args[i] === '--panoId' && args[i + 1]) panoId = args[++i];
        if (args[i] === '--lat' && args[i + 1]) lat = parseFloat(args[++i]);
        if (args[i] === '--lng' && args[i + 1]) lng = parseFloat(args[++i]);
        if (args[i] === '--out' && args[i + 1]) out = args[++i];
        if (args[i] === '--apiKey' && args[i + 1]) apiKey = args[++i];
    }

    const result = await MapsImageryGroundingService.groundAndProjectStreetViewPanorama({
        prompt: prompt || undefined,
        panoId: panoId || undefined,
        lat,
        lng,
        outputPath: out || undefined,
        apiKey: apiKey || undefined
    });

    console.log(JSON.stringify(result, null, 2));
}

main().catch(err => {
    console.error('MIG StreetView failed:', err);
    process.exit(1);
});
