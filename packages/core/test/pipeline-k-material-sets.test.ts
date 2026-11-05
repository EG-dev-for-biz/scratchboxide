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
 * takes the panel, marked metal; read as a smooth dielectric (glass) it takes a plain finish, no set; and a set not yet
 * measured is left out, never measured here. A class read confidently whose set the pick by appearance did not confirm
 * (none looked like it, or no answer) is drawn plain at its read finish (metal when read as metal), never the ranking's
 * nearest of another kind.
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
        // read as dark glass (smooth, not metal): a plain finish at its roughness, flat, no library set
        const glass = await resolveRegionSets([dark], { repoRoot: root, store, finish: async () => [{ roughness: 0.1, metalness: 0.05, conf: 80, seen: 'dark tinted glass' }] });
        expect(glass[0].name).toBe('plain (read finish)');
        expect(glass[0].metal).toBeUndefined();
        expect(glass[0].orm.rgba[1]).toBe(26);
        expect(Array.from(glass[0].normal.rgba.subarray(0, 3))).toEqual([128, 128, 255]);
        // the unmeasured set is counted and left out, never measured in the build
        expect(progress.some(m => /1 library sets .* not measured yet/.test(m))).toBe(true);
        expect(fs.existsSync(path.join(root, 'build', 'texture-library', 'stats'))).toBe(false);
    });

    it('draws a confidently read class plain at its read finish when the pick by appearance does not confirm its set', async () => {
        const { root, store } = library();
        // read as painted metal, and no candidate looked like it (Penn 2's spandrel class, whose nearest by numbers was a wood)
        const none = async (rows: unknown[]) => rows.map(() => ({ pick: 0, conf: 70, seen: 'painted metal panel' }));
        const metal = await resolveRegionSets([dark], { repoRoot: root, store, choose: none, finish: async () => [{ roughness: 0.45, metalness: 0.6, conf: 70, seen: 'dark painted metal spandrel' }] });
        expect(metal[0].name).toBe('plain (read finish)');
        expect(metal[0].metal).toBe(true);
        expect(Array.from(metal[0].orm.rgba.subarray(0, 3))).toEqual([255, 115, 153]);
        expect(Array.from(metal[0].normal.rgba.subarray(0, 3))).toEqual([128, 128, 255]);
        expect(metal[0].choice).toMatchObject({ by: 'ranking', why: expect.stringMatching(/read finish drawn plain/) });
        // read as matte stone, no candidate like it: plain at its roughness, no metalness
        const stone = await resolveRegionSets([dark], { repoRoot: root, store, choose: none, finish: async () => [{ roughness: 0.8, metalness: 0, conf: 80 }] });
        expect(stone[0].name).toBe('plain (read finish)');
        expect(stone[0].metal).toBeUndefined();
        expect(stone[0].orm.rgba[2]).toBe(0);
        // an unsure reading keeps the ranking's nearest, as does a class with no reading
        const unsure = await resolveRegionSets([dark], { repoRoot: root, store, choose: none, finish: async () => [{ roughness: 0.8, metalness: 0, conf: 40 }] });
        expect(unsure[0].name).toBe('Concrete');
        const unread = await resolveRegionSets([dark], { repoRoot: root, store, choose: none });
        expect(unread[0].name).toBe('Concrete');
        // the pick gave no answer (Penn 2's timed out under load): the confident reading is drawn plain too
        const failed = await resolveRegionSets([dark], { repoRoot: root, store, choose: async () => { throw new Error('no answer within 90 s'); }, finish: async () => [{ roughness: 0.5, metalness: 0.3, conf: 65 }] });
        expect(failed[0].name).toBe('plain (read finish)');
        expect(failed[0].choice?.why).toMatch(/no answer within 90 s.*read finish drawn plain/);
        // a confirmed pick keeps its set
        const picked = await resolveRegionSets([dark], { repoRoot: root, store, choose: async (rows: unknown[]) => rows.map(() => ({ pick: 1, conf: 80 })), finish: async () => [{ roughness: 0.8, metalness: 0, conf: 80 }] });
        expect(picked[0].name).toBe('Concrete');
    });
});
