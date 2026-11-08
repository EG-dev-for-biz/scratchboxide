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
 * library set nearest its colour and finish (searchTextureLibrary among the sets whose colour has been measured, whose
 * publisher gives a real size of a facade's scale (FACADE_TILE) and a normal and roughness map; ranked toward the finish the
 * vision model read, material-finish.ts, else matte, REGION_FINISH; with a words reader, the sets a text model names for
 * what the finish read saw of the class joining that shortlist, material-words.ts; with a chooser, the one among its
 * nearest and those that looks most like it, material-choice.ts). Every set's maps lose their tile-scale modes before they
 * are drawn (material-tile-filter.ts), and a class for which the text model named no set at all (the library holds
 * nothing of its kind: window glazing) is drawn without the set's grain, its maps flat at the read finish. Every class takes its set whole, all its maps drawn (user decision, 2026-11-05), fetched
 * from the library bucket (fetchLibrarySets) and prepared small by the engine (surface.prepare_material_maps), cached
 * beside the set for later builds; and its height (material-height.ts), from its publisher's preview, at its real depth.
 */

import * as fs from 'fs';
import * as path from 'path';
import { searchTextureLibrary, type TextureLibraryEntry } from '../../../../common/spatial/texture-library-index';
import { fetchLibrarySets, libraryColourPreview, libraryEntryMeasured, libraryPreview, loadTextureLibraryIndex, measureLibraryEntries } from '../../texture-library';
import { libraryTextureEnergy, textureDistance } from './material-harvest';
import { NativePythonRunnerService } from '../../native-python-runner-service';
import { decodeImageInMemory } from '../tile-texture-transfer';
import type { RegionClass, RegionSet } from './material-regions';
import { CHOICE_CANDIDATES, type ChoiceCandidate, type ChoiceRow, type SetChoice } from './material-choice';
import { drawFinish, energyFit, finishMaps, finishTarget, grainOf, OPENING_FINISH, patternFit, settleFinishes, type ClassFinish } from './material-finish';
import { loadSetFitModel, setFitGrain } from './material-set-fit';
import { heightRecessMap } from './material-height';
import { filterHeight, filterNormal, filterOrm } from './material-tile-filter';
import { readingKey, type ModelReadingStore } from './model-readings';
import { parseWordCandidates, poolLines, WORD_CANDIDATES, WORDS_MIN_CONF, wordsKey, wordsPrompt } from './material-words';

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

/**
 * The real size a facade's set is ranked toward, and the largest it may have: a wall's surface is dressed at the scale of
 * its units, a metre or two a tile (the library's median tile is 1.8 m), while a set whose one tile spans more than
 * maxM was photographed from far above as ground (a beach, a field from the air), its grain the wrong size on a wall.
 */
export const FACADE_TILE = { wantM: 2, maxM: 8 } as const;

const linearToSrgb = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

/**
 * A set's grain capped by what the photo shows (MAIN's verdict on PR #191, 2026-11-08: Travertine007's high-contrast
 * roughness map, drawn at the set-fit regressor's 0.85 on a base the photo shows plain, repeated as a checker). The
 * regressor's grain is held to energyFit (material-finish.ts: the square root of the photo's texture energy over the set's
 * on the bands both resolve, at most 1), so a set is never drawn with more pattern than the photo bears out, whatever the
 * regressor thinks of it; a class whose photo texture or set energy was not measured takes the median cap of the classes
 * that were, else GRAIN_CAP_UNMEASURED. The cap and where it came from are recorded on the finish.
 */
export const GRAIN_CAP_UNMEASURED = 0.5;
export function capGrain(grain: number, photo: number[] | undefined, set: number[] | undefined, others: number[]): { grain: number; cap: number; by: 'photo' | 'other classes' | 'none measured' } {
    if (photo && set) { const cap = energyFit(photo, set); return { grain: Math.min(grain, cap), cap, by: 'photo' }; }
    const measured = others.filter(v => Number.isFinite(v)).sort((a, b) => a - b);
    const cap = measured.length ? measured[measured.length >> 1] : GRAIN_CAP_UNMEASURED;
    return { grain: Math.min(grain, cap), cap, by: measured.length ? 'other classes' : 'none measured' };
}

/** Said of a class inside the window openings drawn at the opening prior (material-finish.ts OPENING_FINISH). */
const PRIOR_WHY = 'no confident reading of a class inside the window openings: drawn as the pane that closes them, a smooth dielectric (generated)';

/** The repository root (the library index and cache live under it). */
export function libraryRepoRoot(): string {
    return process.env.SCRATCHBOX_ROOT || (fs.existsSync(path.resolve(process.cwd(), 'packages')) ? process.cwd() : path.resolve(process.cwd(), '..'));
}

/** One set per class, in class order. Throws with the reason when the library cannot give one. */
export async function resolveRegionSets(classes: RegionClass[], opts: {
    repoRoot?: string; signal?: AbortSignal; progress?: (m: string) => void;
    /** The pick by appearance (material-choice.ts): given each class's nearest candidates with their previews, the 1-based one per class that looks like it (0 or none: the ranking's nearest; a pick kept for an earlier class that looked the same says so in `reused`). */
    choose?: (rows: ChoiceRow[]) => Promise<Array<SetChoice | undefined>>;
    /** Each class's finish read by the vision model (material-finish.ts), before the ranking: the roughness and metalness to rank toward. */
    finish?: () => Promise<Array<ClassFinish | undefined>>;
    /** A text model's reply to the words prompt (material-words.ts): the sets whose description is what each class was seen to be; the building for its prompt. */
    words?: { ask: (prompt: string) => Promise<string>; model: string; building?: string; brief?: string };
    /** Where prepared maps are kept between builds (PREPARED_VERSION): a set found there is not fetched. */
    store?: ModelReadingStore;
} = {}): Promise<RegionSet[]> {
    const repoRoot = opts.repoRoot ?? libraryRepoRoot();
    const index = loadTextureLibraryIndex(repoRoot);
    if (!index) throw new Error(`the texture library index has not been built (assets/textures/library/index.json under ${repoRoot})`);
    const anyScale = (e: TextureLibraryEntry) => !!e.maps.color && !!e.maps.normal && !!(e.maps.roughness || e.maps.arm) && !!e.realSizeM && Math.max(...e.realSizeM) <= FACADE_TILE.maxM;
    // each class's finish: read by the vision model when there is a reading, else the matte dielectric finish
    let finishes: Array<ClassFinish | undefined> = classes.map(() => undefined), finishWhy: string | undefined;
    if (opts.finish) {
        try { finishes = await opts.finish(); } catch (err) { if (opts.signal?.aborted) throw err; finishWhy = `reading the classes' finish failed: ${err instanceof Error ? err.message : String(err)}`; opts.progress?.(`material regions: ${finishWhy}; every class ranked toward the matte finish`); }
    }
    // a metal read on a class of the colour the building mostly reads dielectric is that material in shade (settleFinishes)
    finishes = settleFinishes(classes, finishes);
    // an opening class with no confident reading is ranked toward the opening prior (a smooth dielectric), any other toward matte
    const targets = classes.map((c, k) => finishTarget(finishes[k], c.openings ? { roughness: OPENING_FINISH.roughness, metallic: OPENING_FINISH.metalness } : REGION_FINISH));
    // every set of a facade's scale is ranked by its measured colour, measured ahead (the committed statistics,
    // `npm run library:stats`), never the whole library inside a build: a set not yet measured is left out and counted
    const unmeasured = index.sets.filter(e => anyScale(e) && !e.colour && !libraryEntryMeasured(repoRoot, e.id));
    if (unmeasured.length) opts.progress?.(`material regions: ${unmeasured.length} library sets of a facade's scale are not measured yet and are left out (npm run library:stats measures them ahead)`);
    const pool = index.sets.filter(e => e.colour && anyScale(e));
    if (!pool.length) throw new Error(`no texture library set has a measured colour, a real size of at most ${FACADE_TILE.maxM} m and normal and roughness maps`);
    const query = (c: RegionClass) => ({ colorSrgb: c.meanLinear.map(linearToSrgb) as [number, number, number], colorSpreadLab: c.spreadLab, roughness: targets[classes.indexOf(c)].roughness, metallic: targets[classes.indexOf(c)].metallic, tileSizeM: FACADE_TILE.wantM });
    // every class's shortlist measured first, so its normal relief can be ranked
    const own = classes.map(c => new Set(searchTextureLibrary({ ...index, sets: pool }, { ...query(c), limit: SHORTLIST }).hits.map(h => h.entry.id)));
    // the sets a text model names for what each class was seen to be (material-words.ts), joining its shortlist: asked once
    // a building for the classes with a confident finish read, the answer kept in the readings store
    const words: Array<{ seen: string; sets: string[] } | undefined> = classes.map(() => undefined);
    if (opts.words) {
        const asked = classes.map((_, k) => k).filter(k => finishes[k]?.seen && (finishes[k]!.conf ?? 0) >= WORDS_MIN_CONF);
        if (asked.length) {
            const seen = asked.map(k => finishes[k]!.seen!), poolIds = pool.map(e => e.id);
            const prompt = wordsPrompt(seen.map(x => ({ seen: x })), poolLines(pool), { ...(opts.words.building ? { building: opts.words.building } : {}), ...(opts.words.brief ? { brief: opts.words.brief } : {}) });
            const key = wordsKey(prompt, opts.words.model);
            const kept = opts.store ? await opts.store.get<Array<string[] | null>>(key) : undefined;
            let named: Array<string[] | undefined> | undefined = kept?.map(x => x ?? undefined);
            if (!named || named.length !== asked.length) {
                try {
                    opts.progress?.(`material regions: a text model naming the library sets that are what ${asked.length} classes were seen to be`);
                    const reply = await opts.words.ask(prompt);
                    named = parseWordCandidates(reply, asked.length, new Set(poolIds));
                    opts.store?.put(key, named.map(x => x ?? null));
                } catch (err) {
                    if (opts.signal?.aborted) throw err;
                    opts.progress?.(`material regions: naming the sets by words failed: ${err instanceof Error ? err.message : String(err)}; the colour shortlist alone`);
                    named = undefined;
                }
            }
            if (named) asked.forEach((k, i) => { const sets = (named![i] ?? []).slice(0, WORD_CANDIDATES); words[k] = { seen: seen[i], sets }; for (const id of sets) own[k].add(id); });
        }
    }
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
        const nearest = () => searchTextureLibrary({ ...index, sets: mine }, { ...query(c), normalTiltDeg: REGION_FINISH.normalTiltDeg, limit: Math.max(1, mine.length) }).hits;
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
    const choices: Array<{ candidates: string[]; pick?: SetChoice; why?: string; words?: { seen: string; sets: string[]; picked?: boolean; nothingOfItsKind?: boolean } } | undefined> = classes.map(() => undefined);
    if (opts.choose) {
        const rows: ChoiceRow[] = [];
        for (const [k, hits] of ranked.entries()) {
            const candidates: ChoiceCandidate[] = [];
            const named = words[k]?.sets ?? [];
            const shown = [...hits.slice(0, CHOICE_CANDIDATES), ...hits.filter((h, i) => i >= CHOICE_CANDIDATES && named.includes(h.entry.id))];
            for (const hit of shown) {
                const bytes = await libraryColourPreview(hit.entry, repoRoot, opts.signal).catch(() => undefined);
                if (bytes) candidates.push({ id: hit.entry.id, realSizeM: hit.entry.realSizeM!, preview: decodeImageInMemory(bytes) });
            }
            const indices = candidates.map((c, i) => (named.includes(c.id) ? i + 1 : 0)).filter(Boolean);
            rows.push({ meanLinear: classes[k].meanLinear, candidates, ...(words[k] && indices.length ? { named: { seen: words[k]!.seen, indices } } : {}) });
        }
        opts.progress?.(`material regions: choosing each class's set by its look among ${rows.reduce((a, r) => a + r.candidates.length, 0)} candidates`);
        let picks: Array<SetChoice | undefined> | undefined, why: string | undefined;
        try { picks = await opts.choose(rows); } catch (err) { if (opts.signal?.aborted) throw err; why = `the pick by appearance failed: ${err instanceof Error ? err.message : String(err)}`; }
        rows.forEach((row, k) => {
            const candidates = row.candidates.map(c => c.id), pick = picks?.[k];
            choices[k] = pick ? { candidates, pick, ...(pick.pick === 0 ? { why: 'none of the candidates looked like the class; the ranking\'s nearest kept' } : {}) } : { candidates, why: why ?? 'the reply gave this class no pick; the ranking\'s nearest kept' };
            const w = words[k];
            if (w) choices[k]!.words = { seen: w.seen, sets: w.sets.filter(id => candidates.includes(id)), ...(pick?.pick ? { picked: w.sets.includes(candidates[pick.pick - 1]) } : {}), ...(w.sets.length === 0 ? { nothingOfItsKind: true } : {}) };
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
    // the set's energy per band is the larger of its colour preview's and its roughness map's (the prepared ORM's green as a
    // grey image): a set whose finish varies more than its colour (travertine's pores, a smooth stone pitted rough) is held
    // by the photo the same way, since a finish that varied so would show in the photo as tone
    const setEnergy = await Promise.all(chosen.map(async (hit, k) => {
        const t = classes[k].photoTexture;
        if (!t || !hit.entry.realSizeM) return undefined;
        const bytes = await libraryColourPreview(hit.entry, repoRoot, opts.signal).catch(() => undefined);
        const colour = bytes ? libraryTextureEnergy(decodeImageInMemory(bytes), hit.entry.realSizeM, t.texelM).energy : undefined;
        const maps = kept.get(hit.entry.id);
        let rough: number[] | undefined;
        if (maps) {
            const orm = decodeImageInMemory(maps.orm), grey = { width: orm.width, height: orm.height, rgba: new Uint8Array(orm.rgba.length) };
            for (let i = 0; i < orm.width * orm.height; i++) { const g = orm.rgba[i * 4 + 1]; grey.rgba[i * 4] = g; grey.rgba[i * 4 + 1] = g; grey.rgba[i * 4 + 2] = g; grey.rgba[i * 4 + 3] = 255; }
            rough = libraryTextureEnergy(grey, hit.entry.realSizeM, t.texelM).energy;
        }
        if (!colour && !rough) return undefined;
        const n = Math.max(colour?.length ?? 0, rough?.length ?? 0);
        return Array.from({ length: n }, (_, b) => { const c = colour?.[b], r = rough?.[b]; const cv = Number.isFinite(c) ? c! : -Infinity, rv = Number.isFinite(r) ? r! : -Infinity; const m = Math.max(cv, rv); return Number.isFinite(m) ? m : NaN; });
    }));
    // the set-fit regressor learned from the finished buildings (material-set-fit.ts), when committed: the chosen set's
    // grain by its predicted fit, in place of the hand-set tile and energy caps
    const fitModel = loadSetFitModel(repoRoot);
    // every class's photo cap (capGrain): the measured ones first, so an unmeasured class can take their median
    const photoCaps = chosen.map((_, k) => (classes[k].photoTexture && setEnergy[k] ? energyFit(classes[k].photoTexture!.energy, setEnergy[k]) : NaN));
    const fitOf = (k: number, hit: (typeof chosen)[number]) => {
        if (!fitModel) return { grain: patternFit(classes[k].repeatM, hit.entry.realSizeM!) * energyFit(classes[k].photoTexture?.energy, setEnergy[k]) };
        const read = finishes[k] && finishes[k]!.conf >= 50 ? { roughness: finishes[k]!.roughness, metalness: finishes[k]!.metalness } : undefined;
        const g = setFitGrain(fitModel, { meanLab: classes[k].meanLab, openings: classes[k].openings, ...(classes[k].photoTexture ? { photoEnergy: classes[k].photoTexture!.energy } : {}), ...(classes[k].repeatM ? { repeatM: classes[k].repeatM } : {}), ...(read ? { read } : {}) },
            { rank: Math.max(0, ranked[k].indexOf(hit)), ...(hit.entry.colour?.meanLab ? { colourLab: hit.entry.colour.meanLab as [number, number, number] } : {}), ...(hit.entry.roughnessMean !== undefined ? { roughness: hit.entry.roughnessMean } : {}), ...(hit.entry.metallic !== undefined ? { metallic: hit.entry.metallic } : {}), ...(hit.entry.normalTiltRmsDeg !== undefined ? { normalTiltDeg: hit.entry.normalTiltRmsDeg } : {}), ...(hit.entry.realSizeM ? { tileM: hit.entry.realSizeM } : {}), ...(setEnergy[k] ? { energy: setEnergy[k] } : {}) });
        const capped = capGrain(g, classes[k].photoTexture?.energy, setEnergy[k], photoCaps.filter((_, j) => j !== k));
        return { grain: capped.grain, model: fitModel.version, cap: { grain: Math.round(capped.cap * 1000) / 1000, by: capped.by, regressor: Math.round(g * 1000) / 1000 } };
    };
    return chosen.map((hit, k): RegionSet => {
        const maps = kept.get(hit.entry.id)!;
        // the set drawn at the class's read finish (material-finish.ts finishMaps): smooth where it was read smooth, and its
        // grain only as far as the pick by appearance confirmed it
        const pick = choices[k] ? { by: choices[k]!.pick?.pick ? 'appearance' as const : 'ranking' as const, ...(choices[k]!.pick ? { conf: choices[k]!.pick!.conf } : {}) } : undefined;
        const df = drawFinish(finishes[k], classes[k].openings);
        // the library holds nothing of the class's kind (the text model named no set for it): the set carries the finish only
        const nothingOfItsKind = !!words[k] && words[k]!.sets.length === 0;
        const size = hit.entry.realSizeM!;
        const fit = fitOf(k, hit);
        // the roughness pattern held to the photo's tone deviation at the facade texel (finishMaps RoughnessHold): the
        // square root of the photo's relative energy on its finest band, over the tile's size in facade texels
        const pt = classes[k].photoTexture;
        const e0 = pt?.energy.find(v => Number.isFinite(v));
        const hold = pt && e0 !== undefined && pt.texelM > 0 ? { maxRelStd: Math.sqrt(Math.max(0, e0)), texels: [Math.max(2, Math.round(size[0] / pt.texelM)), Math.max(2, Math.round(size[1] / pt.texelM))] as [number, number] } : undefined;
        const drawn = finishMaps(filterOrm(decodeImageInMemory(maps.orm), size), filterNormal(decodeImageInMemory(maps.normal), size), df.finish, nothingOfItsKind ? 0 : grainOf(pick) * fit.grain, undefined, hold);
        // its height at its real depth, by the share of the normal relief drawn (material-height.ts)
        const hp = heightPreviews.get(hit.entry.id);
        const height = hp && hit.entry.heightDepthM && !nothingOfItsKind ? heightRecessMap(filterHeight(hp, size), hit.entry.heightDepthM, drawn.drawn?.relief ?? 1, hit.entry.heightDepthSource ?? 'unknown') : undefined;
        return {
            name: hit.entry.id, realSizeM: hit.entry.realSizeM!, distance: hit.distance,
            ...(finishes[k] || finishWhy ? { finish: { ...(finishes[k] ? { read: finishes[k] } : { why: finishWhy }), ...(df.prior ? { why: PRIOR_WHY } : {}), roughness: targets[k].roughness, metallic: targets[k].metallic, ...(drawn.drawn ? { drawn: drawn.drawn } : {}), ...('cap' in fit && fit.cap ? { cap: fit.cap } : {}), label: 'photo-inferred' as const } } : drawn.drawn ? { finish: { ...(df.prior ? { why: PRIOR_WHY } : {}), roughness: drawn.drawn.roughness, metallic: drawn.drawn.metallic, drawn: drawn.drawn, ...('cap' in fit && fit.cap ? { cap: fit.cap } : {}), label: 'photo-inferred' as const } } : {}),
            ...(choices[k] ? { choice: { candidates: choices[k]!.candidates, by: choices[k]!.pick?.pick ? 'appearance' as const : 'ranking' as const, ...(choices[k]!.pick?.seen ? { seen: choices[k]!.pick!.seen } : {}), ...(choices[k]!.pick ? { conf: choices[k]!.pick!.conf } : {}), ...(choices[k]!.pick?.reused ? { reused: choices[k]!.pick!.reused } : {}), ...(choices[k]!.why ? { why: choices[k]!.why } : {}), ...(choices[k]!.words ? { words: choices[k]!.words } : {}) } } : {}),
            ...(textured.has(k) ? { harvest: { ...textured.get(k)!, classEnergy: classes[k].texture!.energy, texelM: classes[k].texture!.texelM, grain: `generated: the set's detail finer than the tile's ${Math.round(classes[k].texture!.texelM * 100)} cm texel is its own, below the tile's resolution` } } : {}),
            normal: drawn.normal, orm: drawn.orm,
            ...(height ? { height: height.map, heightDrawn: height.drawn } : {})
        };
    });
}
