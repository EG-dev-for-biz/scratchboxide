/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Renders every entry of the surface texture library as it would be seen in a scene, for judging by eye (and by the
 * visual critic): a ground plane receding 30 m from a 1.6 m eye height and a wall 4 m away seen at 35 degrees, both at the
 * entry's real-world size, under a low sun (GGX specular with the roughness map, the normal map, a sky ambient) with
 * mip-filtered sampling. Repetition, wrong scale, flat or noisy relief and a plastic sheen show here, not in a flat swatch.
 *
 *   tsx scripts/render_surface_swatches.ts [--index <index.json>] [--out <dir>] [--only id,id]
 *
 * Reads the index from the durable asset store (/models/surfaces/index.json) unless --index names a file (maps are then
 * read beside it). Writes <out>/<id>.png and <out>/contact.png. No model is called.
 */

import * as fs from 'fs';
import * as path from 'path';
import { decodeImageToRgbaSync } from '../packages/core/src/node/image-codec-ffmpeg';
import { encodePng } from '../packages/core/src/node/3d-engine/staged-location/png-encode';
import { defaultDurableAssetStore } from '../packages/core/src/node/asset-store/durable-asset-store';
import type { SurfaceTextureEntry, SurfaceTextureIndex } from '../packages/core/src/common/spatial/surface-texture-library';
import { renderSurfaceSwatch } from '../packages/core/src/node/3d-engine/surface-swatch-render';



function loadMap(file: string): { rgba: Uint8Array; w: number; h: number } {
    const d = decodeImageToRgbaSync(fs.readFileSync(file));
    return { rgba: new Uint8Array(d.rgba), w: d.width, h: d.height };
}

function main(): void {
    const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : undefined; };
    let indexFile = arg('index'), mapFile: (rel: string) => string;
    if (indexFile) {
        const dir = path.dirname(path.resolve(indexFile));
        mapFile = rel => path.join(dir, rel);
    } else {
        const store = defaultDurableAssetStore();
        const found = store?.lookup('/models/surfaces/index.json');
        if (!store || !found) throw new Error('No surface library in the asset store (/models/surfaces/index.json); run scripts/generate_surface_textures.ts or pass --index');
        indexFile = found.file;
        mapFile = rel => { const f = store.lookup(`/models/surfaces/${rel}`); if (!f) throw new Error(`missing map /models/surfaces/${rel}`); return f.file; };
    }
    const index = JSON.parse(fs.readFileSync(indexFile, 'utf8')) as SurfaceTextureIndex;
    const only = arg('only')?.split(',');
    const out = path.resolve(arg('out') ?? 'docs/screenshots/surface-swatches');
    fs.mkdirSync(out, { recursive: true });
    const files: string[] = [];
    for (const e of index.surfaces.filter((s: SurfaceTextureEntry) => !only || only.includes(s.id))) {
        const img = renderSurfaceSwatch({ color: loadMap(mapFile(e.maps.color)), normal: loadMap(mapFile(e.maps.normal)), roughness: loadMap(mapFile(e.maps.roughness)) }, e.realSizeM);
        const file = path.join(out, `${e.id}.png`);
        fs.writeFileSync(file, encodePng(img.width, img.height, img.rgba, 4));
        files.push(file);
        console.log(JSON.stringify({ id: e.id, sizeM: e.realSizeM, reliefM: e.surface.reliefM, roughness: e.surface.roughnessMean, file }));
    }
    fs.writeFileSync(path.join(out, 'files.txt'), files.join('\n'));
}

main();
