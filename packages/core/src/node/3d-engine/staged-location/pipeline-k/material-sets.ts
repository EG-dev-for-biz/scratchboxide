/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The library sets of pipeline K's material regions (material-regions.ts): for each appearance class, the texture
 * library set nearest its colour as a dielectric surface (REGION_FINISH; searchTextureLibrary among the sets whose colour
 * has been measured, whose publisher gives a real size of a facade's scale (FACADE_TILE) and a normal and roughness map,
 * and that are not metal, unless the vision model read the class confidently as metal, material-finish.ts; ranked toward the
 * finish it read, else matte; with a chooser, the one among its nearest that looks most like it, material-choice.ts), fetched
 * from the library bucket (fetchLibrarySets) and prepared small by the engine (surface.prepare_material_maps), cached
 * beside the set for later builds.
 */

import * as fs from 'fs';
import * as path from 'path';
import { searchTextureLibrary, type TextureLibraryEntry } from '../../../../common/spatial/texture-library-index';
import { fetchLibrarySets, libraryColourPreview, libraryEntryMeasured, loadTextureLibraryIndex, measureLibraryEntries } from '../../texture-library';
import { libraryTextureEnergy, textureDistance } from './material-harvest';
import { NativePythonRunnerService } from '../../native-python-runner-service';
import { decodeImageInMemory } from '../tile-texture-transfer';
import type { RegionClass, RegionSet } from './material-regions';
import { CHOICE_CANDIDATES, type ChoiceCandidate, type ChoiceRow, type SetChoice } from './material-choice';
import { finishTarget, type ClassFinish } from './material-finish';
import { readingKey, type ModelReadingStore } from './model-readings';

/** Prepared map size: a facade texel is several centimetres, so a tile of a metre or two needs few texels. */
const PREPARED_SIZE = 256;

/**
 * A set's prepared maps kept in the model readings store (`library-prepared/<sha256>` of this version, the set and the
 * size: PNG bytes, base64), which goes to the cache mirror and the place store with the readings: a set is fetched from
 * the library bucket (up to 8K maps, gigabytes a district) and prepared once, and every later build, cloud chunk and
 * machine takes its few hundred kilobytes from the store.
 */
export const PREPARED_VERSION = 'library-prepared/1';
interface PreparedRecord { normal: string; orm: string }
export const preparedKey = (id: string) => readingKey('library-prepared', [PREPARED_VERSION, id, PREPARED_SIZE]);

/**
 * The finish a class is ranked toward when the vision model gives no confident reading (material-finish.ts), against the
 * sets' measured roughness and metalness: matte and not metal,
 * whatever its colour (a dark class is weathered or shaded stone as often as anything; a colour never makes a metal). A
 * set measured at maxMetallic or more is left out.
 */
export const REGION_FINISH = { roughness: 0.8, metallic: 0, normalTiltDeg: 3, maxMetallic: 0.5 } as const;

/**
 * Each class is ranked in two passes: a shortlist by colour and finish, measured (normal relief among the statistics), then
 * ranked again with the relief. A wall's grain is the tile-scale relief of dressed masonry or render, a few degrees of
 * normal tilt; a rough rock of the same colour (15 degrees and more) reads as rubble or granite under a low sun.
 */
const SHORTLIST = 24;

/**
 * The tile-only harvest's pick (material-harvest.ts), for a class with a measured texture: its own colour shortlist (the
 * library search's nearest TEXTURE_SHORTLIST among the sets on that class's SHORTLIST; never another class's, whose
 * nearer colours would crowd out the sets of the right grain) ranked again by colour and texture together, each measured as the tiles would
 * show the set (its preview at the class's texel and the set's real size), each distance over its median on the shortlist.
 */
const TEXTURE_SHORTLIST = 12, TEXTURE_WEIGHT = 1;

/**
 * The real size a facade's set is ranked toward, and the largest it may have: a wall's surface is dressed at the scale of
 * its units, a metre or two a tile (the library's median tile is 1.8 m), while a set whose one tile spans more than
 * maxM was photographed from far above as ground (a beach, a field from the air), its grain the wrong size on a wall.
 */
export const FACADE_TILE = { wantM: 2, maxM: 8 } as const;

const linearToSrgb = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

/** A class's plain finish (a smooth dielectric read by the vision model): its read roughness, a flat normal, no library grain. */
function plainSet(roughness: number, read: ClassFinish): RegionSet {
    const flat = (rgba: number[]) => ({ width: 4, height: 4, rgba: Uint8Array.from({ length: 64 }, (_, i) => rgba[i % 4]) });
    return {
        name: 'plain (read finish)', realSizeM: [1, 1], distance: 0,
        normal: flat([128, 128, 255, 255]), orm: flat([255, Math.round(roughness * 255), 0, 255]),
        finish: { read, roughness, metallic: 0, label: 'photo-inferred' }
    };
}

/** The repository root (the library index and cache live under it). */
export function libraryRepoRoot(): string {
    return process.env.SCRATCHBOX_ROOT || (fs.existsSync(path.resolve(process.cwd(), 'packages')) ? process.cwd() : path.resolve(process.cwd(), '..'));
}

/** One set per class, in class order. Throws with the reason when the library cannot give one. */
export async function resolveRegionSets(classes: RegionClass[], opts: {
    repoRoot?: string; signal?: AbortSignal; progress?: (m: string) => void;
    /** The pick by appearance (material-choice.ts): given each class's nearest candidates with their previews, the 1-based one per class that looks like it (0 or none: the ranking's nearest; a pick kept for an earlier class that looked the same says so in `reused`). */
    choose?: (rows: ChoiceRow[]) => Promise<Array<SetChoice | undefined>>;
    /** Each class's finish read by the vision model (material-finish.ts), before the ranking: the roughness to rank toward and, read confidently as metal, metal sets allowed. */
    finish?: () => Promise<Array<ClassFinish | undefined>>;
    /** Where prepared maps are kept between builds (PREPARED_VERSION): a set found there is not fetched. */
    store?: ModelReadingStore;
} = {}): Promise<RegionSet[]> {
    const repoRoot = opts.repoRoot ?? libraryRepoRoot();
    const index = loadTextureLibraryIndex(repoRoot);
    if (!index) throw new Error(`the texture library index has not been built (assets/textures/library/index.json under ${repoRoot})`);
    const notMetal = (e: TextureLibraryEntry) => !(e.metallic !== undefined && e.metallic >= REGION_FINISH.maxMetallic);
    const isMetal = (e: TextureLibraryEntry) => !notMetal(e);
    const anyScale = (e: TextureLibraryEntry) => !!e.maps.color && !!e.maps.normal && !!(e.maps.roughness || e.maps.arm) && !!e.realSizeM && Math.max(...e.realSizeM) <= FACADE_TILE.maxM;
    const wallScale = (e: TextureLibraryEntry) => anyScale(e) && notMetal(e);
    // each class's finish: read by the vision model when there is a reading, else the matte dielectric finish; a class read
    // confidently as metal may take a metal set (user decision, 2026-11-04)
    let finishes: Array<ClassFinish | undefined> = classes.map(() => undefined), finishWhy: string | undefined;
    if (opts.finish) {
        try { finishes = await opts.finish(); } catch (err) { if (opts.signal?.aborted) throw err; finishWhy = `reading the classes' finish failed: ${err instanceof Error ? err.message : String(err)}`; opts.progress?.(`material regions: ${finishWhy}; every class ranked as matte, not metal`); }
    }
    const targets = classes.map((_, k) => finishTarget(finishes[k], REGION_FINISH));
    // every set of a facade's scale is ranked by its measured colour, measured ahead (the committed statistics,
    // `npm run library:stats`), never the whole library inside a build: a set not yet measured is left out and counted
    const unmeasured = index.sets.filter(e => anyScale(e) && !e.colour && !libraryEntryMeasured(repoRoot, e.id));
    if (unmeasured.length) opts.progress?.(`material regions: ${unmeasured.length} library sets of a facade's scale are not measured yet and are left out (npm run library:stats measures them ahead)`);
    const poolAny = index.sets.filter(e => e.colour && anyScale(e)), pool = poolAny.filter(notMetal);
    const poolOf = (k: number) => (targets[k].metal ? poolAny : pool), allowed = (k: number, e: TextureLibraryEntry) => targets[k].metal || notMetal(e);
    if (!pool.length) throw new Error(`no texture library set that is not metal has a measured colour, a real size of at most ${FACADE_TILE.maxM} m and normal and roughness maps`);
    const query = (c: RegionClass) => ({ colorSrgb: c.meanLinear.map(linearToSrgb) as [number, number, number], colorSpreadLab: c.spreadLab, roughness: targets[classes.indexOf(c)].roughness, metallic: targets[classes.indexOf(c)].metallic, tileSizeM: FACADE_TILE.wantM });
    // every class's shortlist measured first, so its normal relief can be ranked (and a set measured as metal left out)
    const own = classes.map((c, k) => new Set(searchTextureLibrary({ ...index, sets: poolOf(k) }, { ...query(c), limit: SHORTLIST }).hits.map(h => h.entry.id)));
    const shortlist = new Set(own.flatMap(o => [...o]));
    if (shortlist.size) {
        opts.progress?.(`material regions: measuring ${shortlist.size} candidates`);
        await measureLibraryEntries(poolAny.filter(e => shortlist.has(e.id)), { repoRoot, ...(opts.signal ? { signal: opts.signal } : {}) });
    }
    const reloaded = (loadTextureLibraryIndex(repoRoot) ?? index).sets;
    const measured = reloaded.filter(e => shortlist.has(e.id) && e.colour);
    const textured = new Map<number, { colourDistance: number; textureDistance: number; setEnergy: number[]; candidates: number }>();
    type Hit = ReturnType<typeof searchTextureLibrary>['hits'][number];
    const ranked = await Promise.all(classes.map(async (c, k): Promise<Hit[]> => {
        const mine = measured.filter(e => own[k].has(e.id) && allowed(k, e));
        const nearest = () => searchTextureLibrary({ ...index, sets: mine }, { ...query(c), normalTiltDeg: REGION_FINISH.normalTiltDeg, limit: Math.max(1, CHOICE_CANDIDATES) }).hits;
        if (c.texture) {
            const hits = searchTextureLibrary({ ...index, sets: mine }, { ...query(c), normalTiltDeg: REGION_FINISH.normalTiltDeg, limit: TEXTURE_SHORTLIST }).hits.filter(h => h.entry.realSizeM);
            const scored: Array<{ hit: (typeof hits)[number]; tex: number; energy: number[] }> = [];
            for (const hit of hits) {
                const bytes = await libraryColourPreview(hit.entry, repoRoot, opts.signal).catch(() => undefined);
                if (!bytes) continue;
                const e = libraryTextureEnergy(decodeImageInMemory(bytes), hit.entry.realSizeM!, c.texture.texelM);
                const tex = textureDistance(c.texture.energy, e.energy);
                if (Number.isFinite(tex)) scored.push({ hit, tex, energy: e.energy });
            }
            if (scored.length) {
                const med = (v: number[]) => { const q = [...v].sort((a, b) => a - b); return q[q.length >> 1] || 1; };
                const dc = med(scored.map(x => x.hit.distance)), dt = med(scored.map(x => x.tex));
                const score = (x: (typeof scored)[number]) => x.hit.distance / dc + TEXTURE_WEIGHT * x.tex / dt;
                scored.sort((a, b) => score(a) - score(b));
                const best = scored[0];
                textured.set(k, { colourDistance: best.hit.distance, textureDistance: Math.round(best.tex * 1000) / 1000, setEnergy: best.energy.map(v => Math.round(v * 1e6) / 1e6), candidates: scored.length });
                return scored.map(x => x.hit);
            }
        }
        const hits = nearest();
        if (!hits.length) throw new Error(`no texture library set for appearance class ${c.index}`);
        return hits;
    }));
    // the pick by appearance among each class's nearest; the ranking's nearest where it gives none
    const choices: Array<{ candidates: string[]; pick?: SetChoice; why?: string } | undefined> = classes.map(() => undefined);
    if (opts.choose) {
        const rows: ChoiceRow[] = [];
        for (const [k, hits] of ranked.entries()) {
            const candidates: ChoiceCandidate[] = [];
            for (const hit of hits.slice(0, CHOICE_CANDIDATES)) {
                const bytes = await libraryColourPreview(hit.entry, repoRoot, opts.signal).catch(() => undefined);
                if (bytes) candidates.push({ id: hit.entry.id, realSizeM: hit.entry.realSizeM!, preview: decodeImageInMemory(bytes) });
            }
            rows.push({ meanLinear: classes[k].meanLinear, candidates });
        }
        opts.progress?.(`material regions: choosing each class's set by its look among ${rows.reduce((a, r) => a + r.candidates.length, 0)} candidates`);
        let picks: Array<SetChoice | undefined> | undefined, why: string | undefined;
        try { picks = await opts.choose(rows); } catch (err) { if (opts.signal?.aborted) throw err; why = `the pick by appearance failed: ${err instanceof Error ? err.message : String(err)}`; }
        rows.forEach((row, k) => {
            const candidates = row.candidates.map(c => c.id), pick = picks?.[k];
            choices[k] = pick ? { candidates, pick, ...(pick.pick === 0 ? { why: 'none of the candidates looked like the class; the ranking\'s nearest kept' } : {}) } : { candidates, why: why ?? 'the reply gave this class no pick; the ranking\'s nearest kept' };
        });
    }
    const chosen = ranked.map((hits, k) => {
        const p = choices[k]?.pick?.pick, id = p ? choices[k]!.candidates[p - 1] : undefined;
        return (id && hits.find(h => h.entry.id === id)) || hits[0];
    });
    // the prepared maps kept from an earlier build, else the set fetched and prepared now (and kept)
    const kept = new Map<string, { normal: Uint8Array; orm: Uint8Array }>();
    // a class read as a smooth dielectric takes a plain finish (material-finish.ts plainBelowRoughness): its set is not used
    const used = new Set(chosen.filter((_, k) => !targets[k].plain).map(h => h.entry.id));
    for (const id of used) {
        const rec = opts.store ? await opts.store.get<PreparedRecord>(preparedKey(id)) : undefined;
        if (rec?.normal && rec.orm) kept.set(id, { normal: Buffer.from(rec.normal, 'base64'), orm: Buffer.from(rec.orm, 'base64') });
    }
    const toFetch = [...used].filter(id => !kept.has(id));
    if (kept.size) opts.progress?.(`material regions: ${kept.size} sets' prepared maps kept from earlier builds${toFetch.length ? `, ${toFetch.length} fetched` : ''}`);
    const fetched = !toFetch.length ? { sets: [], missing: [] } : await fetchLibrarySets(toFetch, { repoRoot, ...(opts.signal ? { signal: opts.signal } : {}), ...(opts.progress ? { progress: opts.progress } : {}) });
    if (fetched.missing.length) throw new Error(`texture library: ${fetched.missing.map(m => m.reason).join('; ')}`);
    const prepared = new Map<string, { normal: string; orm: string }>();
    const todo: Array<{ id: string; out: string; maps: Record<string, string> }> = [];
    for (const s of fetched.sets) {
        const out = path.join(s.dir, `prepared_k${PREPARED_SIZE}`);
        const files = { normal: path.join(out, 'normal.png'), orm: path.join(out, 'orm.png') };
        prepared.set(s.name, files);
        if (!fs.existsSync(files.normal) || !fs.existsSync(files.orm)) todo.push({ id: s.name, out, maps: { ...s.maps } as Record<string, string> });
    }
    if (todo.length) {
        for (const t of todo) fs.mkdirSync(t.out, { recursive: true });
        const jobs = path.join(todo[0].out, 'jobs.json');
        fs.writeFileSync(jobs, JSON.stringify(todo));
        const script = `
import json, scratchbox_native as n
for j in json.load(open(${JSON.stringify(jobs)})):
    m = j["maps"]
    r = n.surface.prepare_material_maps(m["color"], normal=m.get("normal", ""), roughness=m.get("roughness", ""), ao=m.get("ao", ""), metalness=m.get("metalness", ""), arm=m.get("arm", ""), max_size=${PREPARED_SIZE})
    open(j["out"] + "/normal.png", "wb").write(bytes(r["normal_png"]))
    open(j["out"] + "/orm.png", "wb").write(bytes(r["orm_png"]))
`;
        opts.progress?.(`material regions: preparing ${todo.map(t => t.id).join(', ')} with the engine`);
        const run = await NativePythonRunnerService.getInstance().runScript(script, { timeoutMs: 10 * 60 * 1000, ...(opts.signal ? { signal: opts.signal } : {}) });
        fs.rmSync(jobs, { force: true });
        if (!run.success) throw new Error(`preparing the library maps failed: ${run.stderr || run.errorDetails}`);
    }
    for (const [id, files] of prepared) {
        const maps = { normal: fs.readFileSync(files.normal), orm: fs.readFileSync(files.orm) };
        kept.set(id, maps);
        opts.store?.put(preparedKey(id), { normal: maps.normal.toString('base64'), orm: maps.orm.toString('base64') } satisfies PreparedRecord);
    }
    return chosen.map((hit, k): RegionSet => {
        if (targets[k].plain) return plainSet(targets[k].roughness, finishes[k]!);
        const maps = kept.get(hit.entry.id)!;
        return {
            name: hit.entry.id, realSizeM: hit.entry.realSizeM!, distance: hit.distance,
            ...(finishes[k] || finishWhy ? { finish: { ...(finishes[k] ? { read: finishes[k] } : { why: finishWhy }), roughness: targets[k].roughness, metallic: targets[k].metallic, label: 'photo-inferred' as const } } : {}),
            ...(targets[k].metal && isMetal(hit.entry) ? { metal: true } : {}),
            ...(choices[k] ? { choice: { candidates: choices[k]!.candidates, by: choices[k]!.pick?.pick ? 'appearance' as const : 'ranking' as const, ...(choices[k]!.pick?.seen ? { seen: choices[k]!.pick!.seen } : {}), ...(choices[k]!.pick ? { conf: choices[k]!.pick!.conf } : {}), ...(choices[k]!.pick?.reused ? { reused: choices[k]!.pick!.reused } : {}), ...(choices[k]!.why ? { why: choices[k]!.why } : {}) } } : {}),
            ...(textured.has(k) ? { harvest: { ...textured.get(k)!, classEnergy: classes[k].texture!.energy, texelM: classes[k].texture!.texelM, grain: `generated: the set's detail finer than the tile's ${Math.round(classes[k].texture!.texelM * 100)} cm texel is its own, below the tile's resolution` } } : {}),
            normal: decodeImageInMemory(maps.normal), orm: decodeImageInMemory(maps.orm)
        };
    });
}
