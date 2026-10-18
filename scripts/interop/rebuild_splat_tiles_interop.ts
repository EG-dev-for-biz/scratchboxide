/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Rebuilds the content of public/splat_tiles_interop.html locally, with no billed calls:
 *   panorama_to_3dgs (local Depth Anything V2 Small depth, skipOffsets: no inpainting model) -> splat_to_3dtiles.
 * The tile GLBs are gitignored; tileset.json, tree.json and tileset.meta.json (provenance) are written beside them.
 *
 *   npx tsx scripts/interop/rebuild_splat_tiles_interop.ts [--input <panorama>] [--eye-height <m>] [--out <dir>]
 *
 * The default input, public/images/pantheon_atrium_360_4k.png, is an AI-generated panorama made with the structured
 * 360 prompt, which asks for a level camera 1.7 m above the floor; that requested height is the default eye height.
 * The tileset stays in local metres: the panorama is not a capture of a real place, so it gets no geodetic origin.
 */

import * as fs from 'fs-extra';
import * as path from 'path';
import { spatialHandlers } from '../../packages/core/src/node/gemini/tools/spatial-tools';
import { shutdownAllPythonWorkerPools } from '../../packages/core/src/node/process/persistent-python-worker';

function arg(name: string, fallback: string): string {
    const i = process.argv.indexOf(name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main(): Promise<void> {
    const input = path.resolve(arg('--input', 'public/images/pantheon_atrium_360_4k.png'));
    const eyeHeight = Number(arg('--eye-height', '1.7'));
    const outDir = path.resolve(arg('--out', 'public/tilesets/pantheon'));
    const t0 = Date.now();

    const world = await spatialHandlers.panorama_to_3dgs({ inputImagePath: input, eyeHeight, skipOffsets: true }, {} as any);
    const w = world.resultPayload as any;
    console.log(world.summaryResult);

    await fs.emptyDir(outDir);
    const tiles = await spatialHandlers.splat_to_3dtiles({ inputPath: w.fusedSpzPath, outDir }, {} as any);
    const t = tiles.resultPayload as any;
    console.log(tiles.summaryResult);

    await fs.writeJson(path.join(outDir, 'tileset.meta.json'), {
        eyeHeight,
        walkRadius: 0,
        source: path.relative(process.cwd(), input),
        sourceKind: 'AI-generated 360 panorama (structured 360 prompt, level camera at 1.7 m)',
        steps: [
            { tool: 'panorama_to_3dgs', skipOffsets: true, depthModel: w.depthModel, eyeHeight, depthScaleMetresPerUnit: w.depthScaleCorrection, farPlanePixels: w.farPlanePixels, splats: w.numFusedSplats },
            { tool: 'splat_to_3dtiles', tiles: t.tileCount, levels: t.levels, splats: t.numSplats, geodeticallyPlaced: t.geodeticallyPlaced }
        ],
        builtAt: new Date().toISOString(),
        durationMs: Date.now() - t0
    }, { spaces: 2 });
    console.log(`Wrote ${outDir}/tileset.meta.json`);
}

main().then(() => shutdownAllPythonWorkerPools()).catch((err) => {
    console.error(err);
    shutdownAllPythonWorkerPools();
    process.exit(1);
});
