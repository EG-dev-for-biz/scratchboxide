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
 * One material path (user decision, 2026-11-05): every class takes a library set, all its maps, ranked toward its read
 * finish (else matte); no plain finish, no metal gate; a pick that confirms nothing keeps the ranking's nearest. A set not
 * yet measured is left out, never measured here.
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
    it("ranks every class toward its read finish, else matte, and draws the set it takes with all its maps", async () => {
        const { root, store } = library();
        const progress: string[] = [];
        const unread = await resolveRegionSets([dark], { repoRoot: root, store, progress: m => progress.push(m) });
        expect(unread[0].name).toBe('Concrete');
        const unsure = await resolveRegionSets([dark], { repoRoot: root, store, finish: async () => [{ roughness: 0.3, metalness: 0.9, conf: 40 }] });
        expect(unsure[0].name).toBe('Concrete');
        expect(unsure[0].finish).toMatchObject({ roughness: 0.8, metallic: 0, label: 'photo-inferred' });
        const metal = await resolveRegionSets([dark], { repoRoot: root, store, finish: async () => [{ roughness: 0.35, metalness: 0.95, conf: 60, seen: 'anodized aluminium panel' }] });
        expect(metal[0].name).toBe('Panel');
        expect(metal[0].finish?.read?.seen).toBe('anodized aluminium panel');
        // the set's own maps, from the store: the panel's metalness (blue) drawn as read (0.95), its roughness read 0.35
        // drawn smoother (0.245: material-finish.ts drawnRoughness)
        expect(Array.from(metal[0].orm.rgba.subarray(0, 3))).toEqual([255, 62, 242]);
        // read as smooth glass: a library set all the same, never a plain finish
        const glass = await resolveRegionSets([dark], { repoRoot: root, store, finish: async () => [{ roughness: 0.05, metalness: 0, conf: 80, seen: 'dark tinted glass' }] });
        expect(['Concrete', 'Panel']).toContain(glass[0].name);
        expect(glass[0].finish).toMatchObject({ roughness: 0.05, metallic: 0 });
        // the unmeasured set is counted and left out, never measured in the build
        expect(progress.some(m => /1 library sets .* not measured yet/.test(m))).toBe(true);
        expect(fs.existsSync(path.join(root, 'build', 'texture-library', 'stats'))).toBe(false);
    });

    it("keeps the ranking's nearest, a full set, when the pick by appearance confirms none or gives no answer", async () => {
        const { root, store } = library();
        const none = async (rows: unknown[]) => rows.map(() => ({ pick: 0, conf: 70, seen: 'painted metal panel' }));
        const read = async () => [{ roughness: 0.4, metalness: 0.9, conf: 70 }];
        const unconfirmed = await resolveRegionSets([dark], { repoRoot: root, store, choose: none, finish: read });
        expect(unconfirmed[0].name).toBe('Panel');
        expect(unconfirmed[0].choice).toMatchObject({ by: 'ranking', why: expect.stringMatching(/none of the candidates looked like the class/) });
        const failed = await resolveRegionSets([dark], { repoRoot: root, store, choose: async () => { throw new Error('no answer within 90 s'); }, finish: read });
        expect(failed[0].name).toBe('Panel');
        expect(failed[0].choice?.why).toMatch(/no answer within 90 s/);
    });

    it('asks a text model once for the sets that are what each confident finish read saw, keeps the answer in the store, and records it on the choice', async () => {
        const { root, store } = library();
        const prompts: string[] = [], progress: string[] = [];
        const ask = async (prompt: string) => { prompts.push(prompt); return '{"classes":[{"class":1,"sets":["Panel","Nowhere"]}]}'; };
        const read = async () => [{ roughness: 0.8, metalness: 0, conf: 80, seen: 'limestone cladding' }];
        const choose = async (rows: Array<{ candidates: Array<{ id: string }> }>) => rows.map(() => ({ pick: 0, conf: 50 }));
        const first = await resolveRegionSets([dark], { repoRoot: root, store, finish: read, choose, words: { ask, model: 'm1', building: 'Empire State Building' }, progress: m => progress.push(m) });
        expect(prompts).toHaveLength(1);
        expect(prompts[0]).toContain('- class 1: limestone cladding');
        expect(prompts[0]).toContain('Empire State Building');
        expect(prompts[0]).toMatch(/\nConcrete \(2 m\): /);
        expect(prompts[0]).not.toContain('NotMeasured (');
        expect(first[0].choice?.words).toEqual({ seen: 'limestone cladding', sets: [] });
        // the same classes again: the kept answer, no second call
        await resolveRegionSets([dark], { repoRoot: root, store, finish: read, choose, words: { ask, model: 'm1' } });
        expect(prompts).toHaveLength(1);
        // an unsure finish read is not asked; a failed ask degrades to the colour shortlist with its reason
        await resolveRegionSets([dark], { repoRoot: root, store, finish: async () => [{ roughness: 0.8, metalness: 0, conf: 30, seen: 'limestone cladding' }], choose, words: { ask, model: 'm1' } });
        expect(prompts).toHaveLength(1);
        const broken = await resolveRegionSets([dark], { repoRoot: root, store, finish: async () => [{ roughness: 0.8, metalness: 0, conf: 80, seen: 'dressed limestone' }], choose, words: { ask: async () => { throw new Error('no answer within 90 s'); }, model: 'm1' }, progress: m => progress.push(m) });
        expect(broken[0].name).toBe('Concrete');
        expect(broken[0].choice?.words).toBeUndefined();
        expect(progress.some(m => /naming the sets by words failed: no answer within 90 s/.test(m))).toBe(true);
    });
});
