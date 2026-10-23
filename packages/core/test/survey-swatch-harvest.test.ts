/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * survey_harvest_swatches: where the texture stations stand, which swatches count as the subject, the PBR library match
 * (a local two-material library, a scripted vision answer) and the tool's wiring (injected harvest and match). Nothing
 * here calls a model or downloads tiles.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { describe, expect, it } from 'vitest';
import { onSubject, planTextureStations, TEXTURE_AERIALS, TEXTURE_STATION_STANDOFF_M } from '../src/node/spatial/survey-swatch-harvest';
import { mapFilesOf, matchSwatchToLibrary, openPbrLibrary, publishPbrLibraryIndex } from '../src/node/spatial/pbr-library-match';
import { createSurveySwatchesHandler, SURFACE_MATERIALS_TOOL_DECLARATIONS, SURVEY_SWATCHES_TOOL_NAME } from '../src/node/gemini/tools/surface-material-tools';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'swatch-'));
const HERO = { centroid: { x: 10, z: -5 }, groundY: 2, gridYawDeg: 30, heightMeters: 40 };

describe('texture survey stations', () => {
    it('stand around the subject square-on and off-axis at street and mid height, then framed aerials, all looking at it', () => {
        const st = planTextureStations(HERO);
        expect(st.length).toBe(4 * 3 * 2 + TEXTURE_AERIALS);
        for (const s of st.filter(x => !x.key.startsWith('aerial'))) {
            expect(Math.hypot(s.eye[0] - 10, s.eye[2] + 5)).toBeCloseTo(TEXTURE_STATION_STANDOFF_M, 6);
            expect(s.target[0]).toBe(10); expect(s.target[2]).toBe(-5);
        }
        expect(st.find(s => s.key === 'f0_0_street')!.eye[1]).toBe(4);
        expect(st.find(s => s.key === 'f0_0_mid')!.eye[1]).toBe(22);
        // square-on to the first facade normal (30 deg)
        const sq = st.find(s => s.key === 'f0_0_street')!;
        expect(Math.atan2(sq.eye[2] + 5, sq.eye[0] - 10) * 180 / Math.PI).toBeCloseTo(30, 6);
        for (const a of st.filter(x => x.key.startsWith('aerial'))) expect(a.eye[1]).toBeGreaterThan(2 + 40);
    });

    it('count a swatch as the subject when its centre is on the footprint or within the margin', () => {
        const ground = { cellMeters: 1, cellIndex: (x: number, z: number) => (x >= 0 && x < 10 && z >= 0 && z < 10 ? Math.floor(z) * 10 + Math.floor(x) : -1) };
        const footprint = new Uint8Array(100);
        for (let z = 3; z < 6; z++) for (let x = 3; x < 6; x++) footprint[z * 10 + x] = 1;
        expect(onSubject({ footprint }, ground, 4.5, 4.5)).toBe(true);
        expect(onSubject({ footprint }, ground, 7.5, 4.5)).toBe(true);
        expect(onSubject({ footprint }, ground, 9.5, 9.5)).toBe(false);
    });
});

describe('PBR library', () => {
    const lib = tmp();
    const make = (name: string, colour: string, files: string[]) => {
        fs.mkdirSync(path.join(lib, name));
        for (const f of files) execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=${colour}:s=64x64`, '-frames:v', '1', path.join(lib, name, f)]);
    };
    make('Bricks001', 'red', ['Bricks001.png', 'Bricks001_2K-JPG_Color.jpg', 'Bricks001_8K-JPG_Color.jpg', 'Bricks001_8K-JPG_NormalGL.jpg', 'Bricks001_8K-JPG_Roughness.jpg']);
    make('slate_roof', 'gray', ['slate_roof_diff_1k.jpg', 'slate_roof_nor_gl_1k.jpg']);
    fs.mkdirSync(path.join(lib, 'no_maps'));

    /** An object store in memory, as Cloud Storage would hold the library and its index. */
    const memoryStore = (seed: Record<string, Buffer> = {}) => {
        const objects = new Map(Object.entries(seed));
        const cache = tmp();
        return {
            objects,
            read: async (rel: string) => { const b = objects.get(rel); if (!b) throw new Error(`no object ${rel}`); return b; },
            write: async (rel: string, b: Buffer) => { objects.set(rel, b); },
            localCopy: async (rel: string) => { const f = path.join(cache, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, objects.get(rel)!); return f; }
        };
    };

    it('reads a material\'s maps by role from its file names, the largest JPG first', () => {
        expect(mapFilesOf('Bricks001', fs.readdirSync(path.join(lib, 'Bricks001')))).toEqual({ preview: 'Bricks001.png', color: 'Bricks001_8K-JPG_Color.jpg', normal: 'Bricks001_8K-JPG_NormalGL.jpg', roughness: 'Bricks001_8K-JPG_Roughness.jpg' });
        expect(mapFilesOf('slate_roof', ['slate_roof_diff_1k.jpg', 'slate_roof_nor_gl_1k.jpg'])).toEqual({ color: 'slate_roof_diff_1k.jpg', normal: 'slate_roof_nor_gl_1k.jpg' });
    });

    it('opens a local folder: materials with a preview or colour map, thumbnails on first use', async () => {
        const l = await openPbrLibrary(lib, { cacheDir: tmp() });
        expect(l.names).toEqual(['Bricks001', 'slate_roof']);
        expect(fs.existsSync(await l.thumb('slate_roof'))).toBe(true);
    });

    it('publishes the index and thumbnails beside a library, and opens it from the store without touching the large maps', async () => {
        const index = memoryStore();
        const published = await publishPbrLibraryIndex(lib, 'gs://b/PBR', index, { thumbsDir: tmp() });
        expect(published.materials.map(m => m.name)).toEqual(['Bricks001', 'slate_roof']);
        expect([...index.objects.keys()].sort()).toEqual(['index.json', 'thumbs/Bricks001.jpg', 'thumbs/slate_roof.jpg']);
        const library = memoryStore({ 'Bricks001/Bricks001_8K-JPG_NormalGL.jpg': Buffer.from('normal') });
        const l = await openPbrLibrary('gs://b/PBR', { store: library, indexStore: index });
        expect(l.names).toEqual(['Bricks001', 'slate_roof']);
        expect(l.uri('Bricks001', l.maps('Bricks001').normal!)).toBe('gs://b/PBR/Bricks001/Bricks001_8K-JPG_NormalGL.jpg');
        const got = await l.fetchMaps('Bricks001', ['normal']);
        expect(fs.readFileSync(got.normal!, 'utf8')).toBe('normal');
    });

    it('says what to run when a gs:// library has no published index', async () => {
        await expect(openPbrLibrary('gs://b/none', { store: memoryStore(), indexStore: memoryStore() })).rejects.toThrow(/publish_pbr_library_index/);
    });

    it('picks the material the model numbers in the shuffled contact image, from its shortlist', async () => {
        const l = await openPbrLibrary(lib, { cacheDir: tmp() });
        const swatch = path.join(tmp(), 'swatch.png');
        execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=gray:s=32x32', '-frames:v', '1', swatch]);
        const asked: string[] = [];
        const vision = async (parts: any[]) => {
            asked.push(parts[0].text);
            if (asked.length === 1) return { names: ['slate_roof', 'Bricks001', 'not_in_library'] };
            return { number: 2, confidence: 0.7, why: 'scripted' };
        };
        // rand 0 swaps the two: [slate, bricks] -> [bricks, slate], so number 2 is slate_roof
        const m = await matchSwatchToLibrary({ photo: swatch, description: 'grey slate', sizeMeters: { u: 1, v: 1 } }, l, vision, tmp(), { rand: () => 0, fetchMaps: true });
        expect(m.shortlist).toEqual(['Bricks001', 'slate_roof']);
        expect(m.name).toBe('slate_roof');
        expect(m.confidence).toBe(0.7);
        expect(m.maps.normal).toBe('slate_roof_nor_gl_1k.jpg');
        expect(fs.existsSync(m.localMaps!.color!)).toBe(true);
        expect(asked[0]).toContain('Bricks001, slate_roof');
    });
});

describe('survey_harvest_swatches tool', () => {
    it('is in the surface materials pack, and wires place -> tiles -> harvest -> library match into one payload', async () => {
        expect(SURFACE_MATERIALS_TOOL_DECLARATIONS.map(d => d.name)).toContain(SURVEY_SWATCHES_TOOL_NAME);
        const out = tmp();
        fs.mkdirSync(path.join(out, 'tiles'));
        fs.writeFileSync(path.join(out, 'tiles', 'textured.glb'), 'x');
        const calls: string[] = [];
        const handler = createSurveySwatchesHandler({
            staged: { geocode: async () => { calls.push('geocode'); return { lat: 40.7, lng: -73.9, formattedAddress: 'Somewhere, NY' }; }, extract: async () => { throw new Error('tiles are cached, never extracted'); } },
            vision: {}, beautifier: null,
            harvest: async input => {
                calls.push(`harvest ${path.basename(input.tileGlb)} subjectOnly=${input.subjectOnly}`);
                return { outDir: input.outDir, libraryPath: 'lib.json', hero: { centroid: { x: 0, z: 0 }, groundY: 0, gridYawDeg: 0, heightMeters: 30, areaM2: 400 }, stations: [{ key: 'f0_0_street', kept: true, beautified: false }, { key: 'f1_0_street', kept: false, reason: 'blocked by nearby geometry', beautified: false }], swatches: [{ id: 's0', label: 'red brick', description: 'red brick', sizeMeters: { u: 1, v: 2 }, metresPerPixel: { u: 0.01, v: 0.01 }, files: { photoSwatch: 'p.png' }, score: 0.3, onSubject: true }], rejected: 4, droppedOffSubject: 2 };
            },
            match: async s => ({ name: `match_for_${s.id}`, maps: {}, mapUris: {}, confidence: 0.9, why: 'w', shortlist: [] })
        });
        const r = await handler({ place: 'Somewhere', outputDir: out, beautify: false }, undefined as never) as any;
        expect(calls).toEqual(['geocode', 'harvest textured.glb subjectOnly=true']);
        expect(r.resultPayload.swatches[0].libraryMatch.name).toBe('match_for_s0');
        expect(r.resultPayload.provenance.label).toBe('generated');
        expect(r.summaryResult).toMatch(/1 swatches of Somewhere, NY from 1 of 2 survey stations, 2 off the building dropped, 4 proposals rejected/);
    });
});
