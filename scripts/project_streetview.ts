/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Dedicated CLI & Helper for Street View Ingestion and ERP Projection
 * Ported from spce (https://github.com/EG-dev-for-biz/spce).
 ********************************************************************************/

import fs from 'fs';
import path from 'path';
import {
    fetchStreetViewPanoMetadata,
    fetchStreetViewCubicFaces,
    projectCubicFacesToErpBuffer
} from '../packages/core/src/node/spatial/StreetViewPanoramaProjectionService';

async function main() {
    const args = process.argv.slice(2);
    let panoId = '';
    let lat = NaN;
    let lng = NaN;
    let outPath = '';
    let size = 640;
    let fov = 100;
    let fillMode: 'seamless' | 'green' | 'black' = 'seamless';
    let apiKey = process.env.GOOGLE_MAPS_API_KEY || 'AIzaSyCSHRfQGTmZykmM4LA6mI7avjEQEkQive4';

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--panoId' || args[i] === '--panoid') panoId = args[++i];
        else if (args[i] === '--lat') lat = parseFloat(args[++i]);
        else if (args[i] === '--lng') lng = parseFloat(args[++i]);
        else if (args[i] === '--out') outPath = args[++i];
        else if (args[i] === '--size') size = parseInt(args[++i], 10);
        else if (args[i] === '--fov') fov = parseFloat(args[++i]);
        else if (args[i] === '--fill') fillMode = args[++i] as any;
        else if (args[i] === '--apiKey') apiKey = args[++i];
    }

    if (!panoId && (isNaN(lat) || isNaN(lng))) {
        console.error('Error: Either --panoId or --lat and --lng must be provided.');
        process.exit(1);
    }

    const fetchOpts: any = {
        apiKey,
        faceSize: size,
        fovDegrees: fov
    };
    if (panoId) fetchOpts.panoId = panoId;
    else { fetchOpts.lat = lat; fetchOpts.lng = lng; }

    const { metadata, faces } = await fetchStreetViewCubicFaces(fetchOpts);

    if (!outPath) {
        const cleanId = metadata.panoId.replace(/[^a-zA-Z0-9_-]/g, '_');
        outPath = path.resolve(__dirname, '../public/panoramas', `sv_${cleanId}.png`);
    }

    const erp = projectCubicFacesToErpBuffer(faces, {
        canvasWidth: 2048,
        canvasHeight: 1024,
        fovDegrees: fov,
        fillMode
    });

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, erp.png);

    console.log(JSON.stringify({
        success: true,
        panoId: metadata.panoId,
        date: metadata.date,
        year: metadata.year,
        month: metadata.month,
        lat: metadata.lat,
        lng: metadata.lng,
        copyright: metadata.copyright,
        outPath,
        bytes: erp.png.length
    }));
}

main().catch(err => {
    console.error(JSON.stringify({
        success: false,
        error: err?.message || String(err)
    }));
    process.exit(1);
});
