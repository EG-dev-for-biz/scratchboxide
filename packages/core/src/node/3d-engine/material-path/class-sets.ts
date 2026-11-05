/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A library set for each appearance class of a surface (surface-classes.ts), whatever the surface is: the texture library
 * set nearest the class's colour and finish (searchTextureLibrary among the sets whose colour has been measured, whose
 * real size suits the surface (`tile`: a facade's scale for a building, an object's from its own size) and that have a
 * normal and a roughness map; ranked toward the finish read for the class, material-finish.ts, else matte, REGION_FINISH;
 * with a chooser, the one among its nearest that looks most like it, material-choice.ts). Every class takes its set whole,
 * all its maps drawn (user decision, 2026-11-05), fetched from the library bucket (fetchLibrarySets) and prepared small by
 * the engine (surface.prepare_material_maps), cached beside the set for later builds; and its height (material-height.ts),
 * from its publisher's preview, at its real depth. A facade's priors (a class inside the window openings, the size of the
 * element a class repeats on) ride on the classes and are optional: an object's classes carry none.
 */

import * as fs from 'fs';
import * as path from 'path';
import { searchTextureLibrary, type TextureLibraryEntry } from '../../../common/spatial/texture-library-index';
import { fetchLibrarySets, libraryColourPreview, libraryEntryMeasured, libraryPreview, loadTextureLibraryIndex, measureLibraryEntries } from '../texture-library';
import { libraryTextureEnergy, textureDistance } from './material-harvest';
import { NativePythonRunnerService } from '../native-python-runner-service';
import { decodeImageInMemory } from '../staged-location/tile-texture-transfer';
import type { RegionClass, RegionSet } from './surface-classes';
import { CHOICE_CANDIDATES, type ChoiceCandidate, type ChoiceRow, type SetChoice } from './material-choice';
import { drawFinish, energyFit, finishMaps, finishTarget, grainOf, OPENING_FINISH, patternFit, settleFinishes, type ClassFinish } from './material-finish';
import { loadSetFitModel, setFitGrain } from './material-set-fit';
import { HEIGHT_RELIEF, heightRecessMap } from './material-height';
import { readingKey, type ModelReadingStore } from '../staged-location/pipeline-k/model-readings';

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
 * sets' measured roughness and metalness: matte and not metal, whatever its colour (a colour never makes a metal).
 */
export const REGION_FINISH = { roughness: 0.8, metallic: 0, normalTiltDeg: 3 } as const;

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

/** The real tile size a surface's sets are ranked toward, and the largest one may have, metres. */
export interface TileScale { wantM: number; maxM: number }

const linearToSrgb = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

/** Said of a class inside the window openings drawn at the opening prior (material-finish.ts OPENING_FINISH). */
const PRIOR_WHY = 'no confident reading of a class inside the window openings: drawn as the pane that closes them, a smooth dielectric (generated)';

/** The repository root (the library index and cache live under it). */
export function libraryRepoRoot(): string {
    return process.env.SCRATCHBOX_ROOT || (fs.existsSync(path.resolve(process.cwd(), 'packages')) ? process.cwd() : path.resolve(process.cwd(), '..'));
}

/** One set per class, in class order, of the surface's tile scale. Throws with the reason when the library cannot give one. */
export async function resolveClassSets(classes: RegionClass[], tile: TileScale, opts: {
    repoRoot?: string; signal?: AbortSignal; progress?: (m: string) => void;
    /** The pick by appearance (material-choice.ts): given each class's nearest candidates with their previews, the 1-based one per class that looks like it (0 or none: the ranking's nearest; a pick kept for an earlier class that looked the same says so in `reused`). */
    choose?: (rows: ChoiceRow[]) => Promise<Array<SetChoice | undefined>>;
    /** Each class's finish read by the vision model (material-finish.ts), before the ranking: the roughness and metalness to rank toward. */
    finish?: () => Promise<Array<ClassFinish | undefined>>;
    /** Where prepared maps are kept between builds (PREPARED_VERSION): a set found there is not fetched. */
    store?: ModelReadingStore;
    /** The deepest recess a set's height is drawn at, metres (default HEIGHT_RELIEF.capM: a facade's; a small object's is less). */
    heightCapM?: number;
} = {}): Promise<RegionSet[]> {
    const repoRoot = opts.repoRoot ?? libraryRepoRoot();
    const index = loadTextureLibraryIndex(repoRoot);
    if (!index) throw new Error(`the texture library index has not been built (assets/textures/library/index.json under ${repoRoot})`);
    const anyScale = (e: TextureLibraryEntry) => !!e.maps.color && !!e.maps.normal && !!(e.maps.roughness || e.maps.arm) && !!e.realSizeM && Math.max(...e.realSizeM) <= tile.maxM;
    // each class's finish: read by the vision model when there is a reading, else the matte dielectric finish
    let finishes: Array<ClassFinish | undefined> = classes.map(() => undefined), finishWhy: string | undefined;
    if (opts.finish) {
        try { finishes = await opts.finish(); } catch (err) { if (opts.signal?.aborted) throw err; finishWhy = `reading the classes' finish failed: ${err instanceof Error ? err.message : String(err)}`; opts.progress?.(`material regions: ${finishWhy}; every class ranked toward the matte finish`); }
    }
    // a metal read on a class of the colour the building mostly reads dielectric is that material in shade (settleFinishes)
    finishes = settleFinishes(classes, finishes);
    // an opening class with no confident reading is ranked toward the opening prior (a smooth dielectric), any other toward matte
    const targets = classes.map((c, k) => finishTarget(finishes[k], c.openings ? { roughness: OPENING_FINISH.roughness, metallic: OPENING_FINISH.metalness } : REGION_FINISH));
    // every set of the surface's scale is ranked by its measured colour, measured ahead (the committed statistics,
    // `npm run library:stats`), never the whole library inside a build: a set not yet measured is left out and counted
    const unmeasured = index.sets.filter(e => anyScale(e) && !e.colour && !libraryEntryMeasured(repoRoot, e.id));
    if (unmeasured.length) opts.progress?.(`material regions: ${unmeasured.length} library sets of the surface's scale are not measured yet and are left out (npm run library:stats measures them ahead)`);
    const pool = index.sets.filter(e => e.colour && anyScale(e));
    if (!pool.length) throw new Error(`no texture library set has a measured colour, a real size of at most ${tile.maxM} m and normal and roughness maps`);
    const query = (c: RegionClass) => ({ colorSrgb: c.meanLinear.map(linearToSrgb) as [number, number, number], colorSpreadLab: c.spreadLab, roughness: targets[classes.indexOf(c)].roughness, metallic: targets[classes.indexOf(c)].metallic, tileSizeM: tile.wantM });
    // every class's shortlist measured first, so its normal relief can be ranked
    const own = classes.map(c => new Set(searchTextureLibrary({ ...index, sets: pool }, { ...query(c), limit: SHORTLIST }).hits.map(h => h.entry.id)));
    const shortlist = new Set(own.flatMap(o => [...o]));
    if (shortlist.size) {
        opts.progress?.(`material regions: measuring ${shortlist.size} candidates`);
        await measureLibraryEntries(pool.filter(e => shortlist.has(e.id)), { repoRoot, ...(opts.signal ? { signal: opts.signal } : {}) });
    }
    const reloaded = (loadTextureLibraryIndex(repoRoot) ?? index).sets;
    const measured = reloaded.filter(e => shortlist.has(e.id) && e.colour);
    const textured = new Map<number, { colourDistance: number; textureDistance: number; setEnergy: number[]; candidates: number }>();
    type Hit = ReturnType<typeof searchTextureLibrary>['hits'][number];
    const ranked = await Promise.all(classes.map(async (c, k): Promise<Hit[]> => {
        const mine = measured.filter(e => own[k].has(e.id));
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
    const used = new Set(chosen.map(h => h.entry.id));
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
    // each chosen set's height map (its publisher's preview: the map its depth was estimated on), for the sets with a depth
    const heightPreviews = new Map<string, ReturnType<typeof decodeImageInMemory>>();
    for (const id of used) {
        const entry = chosen.find(h => h.entry.id === id)!.entry;
        if (!entry.maps.height || !entry.heightDepthM) continue;
        const bytes = await libraryPreview(entry, 'height', repoRoot, opts.signal).catch(() => undefined);
        if (bytes) heightPreviews.set(id, decodeImageInMemory(bytes));
    }
    // each chosen set's texture energy at its class's texel, against the photo's (material-finish.ts energyFit)
    const setEnergy = await Promise.all(chosen.map(async (hit, k) => {
        const t = classes[k].photoTexture;
        if (!t || !hit.entry.realSizeM) return undefined;
        const bytes = await libraryColourPreview(hit.entry, repoRoot, opts.signal).catch(() => undefined);
        return bytes ? libraryTextureEnergy(decodeImageInMemory(bytes), hit.entry.realSizeM, t.texelM).energy : undefined;
    }));
    // the set-fit regressor learned from the finished buildings (material-set-fit.ts), when committed: the chosen set's
    // grain by its predicted fit, in place of the hand-set tile and energy caps
    const fitModel = loadSetFitModel(repoRoot);
    const fitOf = (k: number, hit: (typeof chosen)[number]) => {
        if (!fitModel) return { grain: patternFit(classes[k].repeatM, hit.entry.realSizeM!) * energyFit(classes[k].photoTexture?.energy, setEnergy[k]) };
        const read = finishes[k] && finishes[k]!.conf >= 50 ? { roughness: finishes[k]!.roughness, metalness: finishes[k]!.metalness } : undefined;
        const g = setFitGrain(fitModel, { meanLab: classes[k].meanLab, openings: classes[k].openings, ...(classes[k].photoTexture ? { photoEnergy: classes[k].photoTexture!.energy } : {}), ...(classes[k].repeatM ? { repeatM: classes[k].repeatM } : {}), ...(read ? { read } : {}) },
            { rank: Math.max(0, ranked[k].indexOf(hit)), ...(hit.entry.colour?.meanLab ? { colourLab: hit.entry.colour.meanLab as [number, number, number] } : {}), ...(hit.entry.roughnessMean !== undefined ? { roughness: hit.entry.roughnessMean } : {}), ...(hit.entry.metallic !== undefined ? { metallic: hit.entry.metallic } : {}), ...(hit.entry.normalTiltRmsDeg !== undefined ? { normalTiltDeg: hit.entry.normalTiltRmsDeg } : {}), ...(hit.entry.realSizeM ? { tileM: hit.entry.realSizeM } : {}), ...(setEnergy[k] ? { energy: setEnergy[k] } : {}) });
        return { grain: g, model: fitModel.version };
    };
    return chosen.map((hit, k): RegionSet => {
        const maps = kept.get(hit.entry.id)!;
        // the set drawn at the class's read finish (material-finish.ts finishMaps): smooth where it was read smooth, and its
        // grain only as far as the pick by appearance confirmed it
        const pick = choices[k] ? { by: choices[k]!.pick?.pick ? 'appearance' as const : 'ranking' as const, ...(choices[k]!.pick ? { conf: choices[k]!.pick!.conf } : {}) } : undefined;
        const df = drawFinish(finishes[k], classes[k].openings);
        const drawn = finishMaps(decodeImageInMemory(maps.orm), decodeImageInMemory(maps.normal), df.finish, grainOf(pick) * fitOf(k, hit).grain);
        // its height at its real depth, by the share of the normal relief drawn (material-height.ts)
        const hp = heightPreviews.get(hit.entry.id);
        const height = hp && hit.entry.heightDepthM ? heightRecessMap(hp, hit.entry.heightDepthM, drawn.drawn?.relief ?? 1, hit.entry.heightDepthSource ?? 'unknown', opts.heightCapM ? { ...HEIGHT_RELIEF, capM: opts.heightCapM } : HEIGHT_RELIEF) : undefined;
        return {
            name: hit.entry.id, realSizeM: hit.entry.realSizeM!, distance: hit.distance,
            ...(finishes[k] || finishWhy ? { finish: { ...(finishes[k] ? { read: finishes[k] } : { why: finishWhy }), ...(df.prior ? { why: PRIOR_WHY } : {}), roughness: targets[k].roughness, metallic: targets[k].metallic, ...(drawn.drawn ? { drawn: drawn.drawn } : {}), label: 'photo-inferred' as const } } : drawn.drawn ? { finish: { ...(df.prior ? { why: PRIOR_WHY } : {}), roughness: drawn.drawn.roughness, metallic: drawn.drawn.metallic, drawn: drawn.drawn, label: 'photo-inferred' as const } } : {}),
            ...(choices[k] ? { choice: { candidates: choices[k]!.candidates, by: choices[k]!.pick?.pick ? 'appearance' as const : 'ranking' as const, ...(choices[k]!.pick?.seen ? { seen: choices[k]!.pick!.seen } : {}), ...(choices[k]!.pick ? { conf: choices[k]!.pick!.conf } : {}), ...(choices[k]!.pick?.reused ? { reused: choices[k]!.pick!.reused } : {}), ...(choices[k]!.why ? { why: choices[k]!.why } : {}) } } : {}),
            ...(textured.has(k) ? { harvest: { ...textured.get(k)!, classEnergy: classes[k].texture!.energy, texelM: classes[k].texture!.texelM, grain: `generated: the set's detail finer than the tile's ${Math.round(classes[k].texture!.texelM * 100)} cm texel is its own, below the tile's resolution` } } : {}),
            normal: drawn.normal, orm: drawn.orm,
            ...(height ? { height: height.map, heightDrawn: height.drawn } : {})
        };
    });
}
