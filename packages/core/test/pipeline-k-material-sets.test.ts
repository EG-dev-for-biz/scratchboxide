/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K's library sets for the material regions (pipeline-k/material-sets.ts), offline: a two-set library (a matte
 * concrete and a metal panel of the same dark grey) measured in the committed statistics bundle (no set is measured in the
 * build), and a readings store holding both sets' prepared maps (no set is fetched: the bucket is out of reach in tests).
 * A dark class with no finish reading, or an unsure one, takes the concrete, a dielectric; read confidently as metal it
 * takes the panel, marked metal; and a set not yet measured is left out, never measured here.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { preparedKey, resolveRegionSets } from '../src/node/3d-engine/staged-location/pipeline-k/material-sets';
import { memoryReadingStore } from '../src/node/3d-engine/staged-location/pipeline-k/model-readings';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';
import type { RegionClass } from '../src/node/3d-engine/staged-location/pipeline-k/material-regions';

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const GREY = 0.18;

function library(): { root: string; store: ReturnType<typeof memoryReadingStore> } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-library-'));
    const dir = path.join(root, 'assets', 'textures', 'library');
    fs.mkdirSync(dir, { recursive: true });
    const entry = (id: string) => ({ id, publisher: 'ambientCG', maps: { color: `${id}/c.png`, normal: `${id}/n.png`, roughness: `${id}/r.png`, ...(id === 'Panel' ? { metalness: `${id}/m.png` } : {}) }, realSizeM: [2, 2], provenance: 'library' });
    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ schema: 'scratchbox.texture-library/1', bucket: 'test', builtAt: '2026-11-04', sets: [entry('Concrete'), entry('Panel'), entry('NotMeasured')] }));
    const colour = { meanLinearRgb: [GREY, GREY, GREY], spreadLinearRgb: [0.01, 0.01, 0.01], meanLab: [49.5, 0, 0], spreadLab: [1, 0, 0] };
    const stats = (roughnessMean: number, metallic: number) => ({ colour, roughnessMean, roughnessSpread: 0.02, metallic, metalnessMeasured: true, metalShare: metallic > 0.5 ? 1 : 0, metalnessP95: metallic, normalTiltRmsDeg: 3, version: 2, statsSource: 'test', sourceSize: [1024, 1024] });
    fs.writeFileSync(path.join(dir, 'stats.json'), JSON.stringify({ version: 2, sets: { Concrete: stats(0.85, 0), Panel: stats(0.35, 0.95) } }));
    // both sets' prepared maps kept from an earlier build
    const store = memoryReadingStore();
    const png = (rgb: number[]) => { const px = new Uint8Array(4 * 4 * 3); for (let i = 0; i < 16; i++) px.set(rgb, i * 3); return Buffer.from(encodePng(4, 4, px, 3)).toString('base64'); };
    store.put(preparedKey('Concrete'), { normal: png([128, 128, 255]), orm: png([255, 217, 0]) });
    store.put(preparedKey('Panel'), { normal: png([128, 128, 255]), orm: png([255, 89, 242]) });
    return { root, store };
}

const dark: RegionClass = { index: 0, meanLab: [49.5, 0, 0], meanLinear: [GREY, GREY, GREY], spreadLab: [1, 0, 0], share: 1, wall: true };

describe('pipeline K library sets', () => {
    it('ranks a class with no confident reading toward a matte dielectric, and a confident metal reading toward the metal panel', async () => {
        const { root, store } = library();
        const progress: string[] = [];
        const plain = await resolveRegionSets([dark], { repoRoot: root, store, progress: m => progress.push(m) });
        expect(plain[0].name).toBe('Concrete');
        expect(plain[0].metal).toBeUndefined();
        const unsure = await resolveRegionSets([dark], { repoRoot: root, store, finish: async () => [{ roughness: 0.3, metalness: 0.9, conf: 60 }] });
        expect(unsure[0].name).toBe('Concrete');
        expect(unsure[0].finish).toMatchObject({ roughness: 0.3, metallic: 0, label: 'photo-inferred' });
        const metal = await resolveRegionSets([dark], { repoRoot: root, store, finish: async () => [{ roughness: 0.35, metalness: 0.95, conf: 85, seen: 'anodized aluminium panel' }] });
        expect(metal[0].name).toBe('Panel');
        expect(metal[0].metal).toBe(true);
        expect(metal[0].finish?.read?.seen).toBe('anodized aluminium panel');
        // the prepared maps came from the store: the panel's metalness (blue) is there to draw
        expect(metal[0].orm.rgba[2]).toBe(242);
        // the unmeasured set is counted and left out, never measured in the build
        expect(progress.some(m => /1 library sets .* not measured yet/.test(m))).toBe(true);
        expect(fs.existsSync(path.join(root, 'build', 'texture-library', 'stats'))).toBe(false);
    });
});
