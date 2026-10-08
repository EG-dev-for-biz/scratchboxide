/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { GoogleVectorTileService } from '../packages/core/src/node/spatial/GoogleVectorTileService';
import { VectorWorldPopulatorService } from '../packages/core/src/node/spatial/VectorWorldPopulatorService';

async function main() {
    const args = process.argv.slice(2);
    let lat = 40.7484;
    let lng = -73.9857;
    let radiusTiles = 1;
    let zoom = 16;
    let style = 'studio_clay';
    let outputGlbPath = '';
    let populate = false;
    let graphOnly = false;
    let traffic = true;
    let trees = true;
    let streetlamps = true;
    let sidewalks = true;
    let heroLane: number | undefined;
    let heroDist: number | undefined;
    let heroType: 'lane' | 'sidewalk' | 'plaza' = 'lane';

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--lat' && args[i + 1]) lat = parseFloat(args[++i]);
        if (args[i] === '--lng' && args[i + 1]) lng = parseFloat(args[++i]);
        if (args[i] === '--radius' && args[i + 1]) radiusTiles = parseInt(args[++i], 10);
        if (args[i] === '--zoom' && args[i + 1]) zoom = parseInt(args[++i], 10);
        if (args[i] === '--style' && args[i + 1]) style = args[++i];
        if (args[i] === '--out' && args[i + 1]) outputGlbPath = args[++i];
        if (args[i] === '--populate') populate = true;
        if (args[i] === '--graph-only') graphOnly = true;
        if (args[i] === '--no-traffic') traffic = false;
        if (args[i] === '--no-trees') trees = false;
        if (args[i] === '--no-streetlamps') streetlamps = false;
        if (args[i] === '--no-sidewalks') sidewalks = false;
        if (args[i] === '--hero-lane' && args[i + 1]) {
            heroLane = parseInt(args[++i], 10);
            populate = true;
        }
        if (args[i] === '--hero-dist' && args[i + 1]) {
            heroDist = parseFloat(args[++i]);
            populate = true;
        }
        if (args[i] === '--hero-type' && args[i + 1]) {
            heroType = args[++i] as any;
            populate = true;
        }
    }

    if (graphOnly) {
        const graph = await GoogleVectorTileService.getVectorFeatureGraph({
            latitude: lat,
            longitude: lng,
            zoom,
            radiusTiles
        });
        console.log(JSON.stringify(graph, null, 2));
        return;
    }

    if (populate) {
        const result = await VectorWorldPopulatorService.generatePopulatedWorld({
            latitude: lat,
            longitude: lng,
            zoom,
            radiusTiles,
            style,
            outputGlbPath: outputGlbPath || undefined,
            includeTraffic: traffic,
            includeTrees: trees,
            includeStreetlamps: streetlamps,
            includeSidewalks: sidewalks,
            heroStaging: heroLane !== undefined || heroDist !== undefined ? {
                type: heroType,
                laneIndex: heroLane,
                distanceAlongM: heroDist
            } : undefined
        });
        console.log(JSON.stringify(result, null, 2));
    } else {
        const result = await GoogleVectorTileService.stage3DVectorWorld({
            latitude: lat,
            longitude: lng,
            zoom,
            radiusTiles,
            style,
            outputGlbPath: outputGlbPath || undefined
        });
        console.log(JSON.stringify(result, null, 2));
    }
}

main().catch(err => {
    console.error('Vector World Staging failed:', err);
    process.exit(1);
});
