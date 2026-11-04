#!/usr/bin/env node
/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Fetches the precomputed atmosphere tables three-geospatial ships (takram-design-engineering/three-geospatial,
 * packages/atmosphere/assets, MIT licence, copyright 2024 Shota Matsuda) into the gitignored model cache, as the
 * reference packages/core/test/atmosphere-lut.test.ts compares our Bruneton tables with. Pinned to the commit
 * three-geospatial's own loader names (DEFAULT_PRECOMPUTED_TEXTURES_URL); the files are Git LFS objects, fetched from
 * GitHub's media host. The licence is saved beside them.
 *
 * usage: node scripts/fetch_three_geospatial_atmosphere.mjs [--dest <dir>]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const REF = 'eac103980f20c0956f2d3215833e73514be08462';
const FILES = {
    'transmittance.bin': 256 * 64 * 4 * 2,
    'scattering.bin': 256 * 128 * 32 * 4 * 2,
    'single_mie_scattering.bin': 256 * 128 * 32 * 4 * 2,
    'higher_order_scattering.bin': 256 * 128 * 32 * 4 * 2,
    'irradiance.bin': 64 * 16 * 4 * 2
};
const MEDIA = `https://media.githubusercontent.com/media/takram-design-engineering/three-geospatial/${REF}/packages/atmosphere/assets`;
const LICENSE = `https://raw.githubusercontent.com/takram-design-engineering/three-geospatial/${REF}/packages/atmosphere/LICENSE`;

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destArg = process.argv.indexOf('--dest');
const dest = destArg > 0 ? path.resolve(process.argv[destArg + 1]) : path.join(repo, '.model-cache', 'three-geospatial-atmosphere', REF);
fs.mkdirSync(dest, { recursive: true });

async function get(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
}

for (const [name, size] of Object.entries(FILES)) {
    const file = path.join(dest, name);
    if (fs.existsSync(file) && fs.statSync(file).size === size) { console.log(`have ${name}`); continue; }
    const bytes = await get(`${MEDIA}/${name}`);
    if (bytes.length !== size) throw new Error(`${name}: ${bytes.length} bytes, expected ${size} (an LFS pointer instead of the object?)`);
    fs.writeFileSync(file, bytes);
    console.log(`fetched ${name} (${bytes.length} bytes)`);
}
fs.writeFileSync(path.join(dest, 'LICENSE'), await get(LICENSE));
fs.writeFileSync(path.join(dest, 'SOURCE.txt'), `takram-design-engineering/three-geospatial@${REF} packages/atmosphere/assets (MIT, see LICENSE).\n` +
    'Binary16 RGBA, Bruneton layout; three wavelengths 680/550/440 nm, radiance (identity luminanceFromRadiance), combined scattering (alpha = single Mie red).\n');
console.log(dest);
