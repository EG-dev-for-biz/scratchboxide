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
 * library set nearest its colour and its wanted finish (REGION_FINISH; searchTextureLibrary for the wall, among the sets whose colour has been
 * measured and whose publisher gives a real size and a normal and roughness map), fetched from the library bucket (fetchLibrarySets) and prepared
 * small by the engine (surface.prepare_material_maps), cached beside the set for later builds.
 */

import * as fs from 'fs';
import * as path from 'path';
import { searchTextureLibrary, type TextureLibraryEntry } from '../../../../common/spatial/texture-library-index';
import { fetchLibrarySets, loadTextureLibraryIndex, measureLibraryEntries } from '../../texture-library';
import { NativePythonRunnerService } from '../../native-python-runner-service';
import { decodeImageInMemory } from '../tile-texture-transfer';
import type { RegionClass, RegionSet } from './material-regions';

/** Prepared map size: a facade texel is several centimetres, so a tile of a metre or two needs few texels. */
const PREPARED_SIZE = 256;

/**
 * The finish each class is ranked toward, against the sets' measured roughness and metalness: the wall class is matte
 * and not metal (whatever its colour, a wall is never drawn as metal), ranked by its colour as well. The darker classes
 * are drawn only in openings, where metal is allowed: they take a bare metal (measured metalness at least bareMetallic;
 * a set whose mean lands between is a mix of metal and dirt, or a misread map), ranked by hue, hue spread and a flat
 * sheet's normal relief, never by lightness (the photo, not the set, gives the colour). Its metalness is drawn scaled to
 * `metallic`: the photo stays the colour, so a fully metal bay would show only the scene's reflection; part metal keeps
 * the photo's darkness with some sheen.
 */
export const REGION_FINISH = { wall: { roughness: 0.8, metallic: 0, normalTiltDeg: 3 }, opening: { metallic: 0.2, bareMetallic: 0.9, normalTiltDeg: 2 } } as const;

/**
 * The wall is ranked in two passes: a shortlist by colour and finish, measured (normal relief among the statistics), then
 * ranked again with the relief. A wall's grain is the tile-scale relief of dressed masonry or render, a few degrees of
 * normal tilt; a rough rock of the same colour (15 degrees and more) reads as rubble or granite under a low sun.
 */
const WALL_SHORTLIST = 24;

const isBareMetal = (e: TextureLibraryEntry) => !!e.colour && e.metallic !== undefined && e.metallic >= REGION_FINISH.opening.bareMetallic;

/**
 * The bare metals nearest an opening class by hue and hue spread (the library search's units), never by lightness, plus,
 * when `withRelief`, the normal relief toward a flat sheet's (the search's units; unmeasured counts one unit). Best first.
 */
function rankBareMetals(pool: TextureLibraryEntry[], c: RegionClass, withRelief: boolean): Array<{ entry: TextureLibraryEntry; distance: number }> {
    const chroma = (v: readonly number[]) => Math.hypot(v[1], v[2]);
    const want = REGION_FINISH.opening.normalTiltDeg;
    return pool.filter(isBareMetal).map(e => {
        const L = e.colour!.meanLab, S = e.colour!.spreadLab;
        let d = Math.hypot(L[1] - c.meanLab[1], L[2] - c.meanLab[2]) / 10 + Math.abs(chroma(S) - chroma(c.spreadLab)) / 6;
        if (withRelief) d += e.normalTiltRmsDeg === undefined ? 1 : Math.abs(Math.log((e.normalTiltRmsDeg + 1) / (want + 1))) / Math.log(1.3);
        return { entry: e, distance: d };
    }).sort((a, b) => a.distance - b.distance || a.entry.id.localeCompare(b.entry.id));
}

const linearToSrgb = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

/** The repository root (the library index and cache live under it). */
export function libraryRepoRoot(): string {
    return process.env.SCRATCHBOX_ROOT || (fs.existsSync(path.resolve(process.cwd(), 'packages')) ? process.cwd() : path.resolve(process.cwd(), '..'));
}

/** One set per class, in class order. Throws with the reason when the library cannot give one. */
export async function resolveRegionSets(classes: RegionClass[], opts: { repoRoot?: string; signal?: AbortSignal; progress?: (m: string) => void } = {}): Promise<RegionSet[]> {
    const repoRoot = opts.repoRoot ?? libraryRepoRoot();
    const index = loadTextureLibraryIndex(repoRoot);
    if (!index) throw new Error(`the texture library index has not been built (assets/textures/library/index.json under ${repoRoot})`);
    const mapped = index.sets.filter(e => e.colour && e.maps.color && e.maps.normal && (e.maps.roughness || e.maps.arm));
    const pool = mapped.filter(e => e.realSizeM);
    if (!pool.length) throw new Error('no texture library set has a measured colour, a real size and normal and roughness maps');
    // the opening classes may also take a set without a publisher size (most bare-metal sets have none), tiled at
    // the median size of the library's sized bare metals (metalness at least bareMetallic; part-metal sets such as whole
    // curtain-wall facades tile at a building's scale, not a sheet's): an estimate, labelled generated with its reason
    const sizedMetals = pool.filter(e => e.metallic !== undefined && e.metallic >= REGION_FINISH.opening.bareMetallic).map(e => e.realSizeM!).sort((a, b) => Math.max(...a) - Math.max(...b));
    const metalSize = sizedMetals.length ? sizedMetals[Math.floor(sizedMetals.length / 2)] : undefined;
    const wallQuery = (c: RegionClass) => ({ colorSrgb: c.meanLinear.map(linearToSrgb) as [number, number, number], colorSpreadLab: c.spreadLab, roughness: REGION_FINISH.wall.roughness, metallic: REGION_FINISH.wall.metallic });
    // the wall's shortlist measured first, so its normal relief can be ranked
    const shortlist = new Set<string>();
    for (const c of classes.filter(c => c.wall)) for (const h of searchTextureLibrary({ ...index, sets: pool }, { ...wallQuery(c), limit: WALL_SHORTLIST }).hits) shortlist.add(h.entry.id);
    if (shortlist.size) {
        opts.progress?.(`material regions: measuring ${shortlist.size} wall candidates`);
        await measureLibraryEntries(pool.filter(e => shortlist.has(e.id)), { repoRoot, ...(opts.signal ? { signal: opts.signal } : {}) });
    }
    // the opening classes' bare metals: a shortlist by hue, measured for their relief, then ranked with it
    const metalPool = metalSize ? mapped : pool;
    const metalShortlist = new Set<string>();
    for (const c of classes.filter(c => !c.wall)) for (const h of rankBareMetals(metalPool, c, false).slice(0, WALL_SHORTLIST)) metalShortlist.add(h.entry.id);
    if (metalShortlist.size) {
        opts.progress?.(`material regions: measuring ${metalShortlist.size} metal candidates`);
        await measureLibraryEntries(metalPool.filter(e => metalShortlist.has(e.id)), { repoRoot, ...(opts.signal ? { signal: opts.signal } : {}) });
    }
    const reloaded = (loadTextureLibraryIndex(repoRoot) ?? index).sets;
    const measured = reloaded.filter(e => shortlist.has(e.id) && e.colour);
    const metals = reloaded.filter(e => metalShortlist.has(e.id) && (e.realSizeM || metalSize) && e.maps.normal && (e.maps.roughness || e.maps.arm));
    const chosen = classes.map(c => {
        const hit = c.wall
            ? searchTextureLibrary({ ...index, sets: measured }, { ...wallQuery(c), normalTiltDeg: REGION_FINISH.wall.normalTiltDeg, limit: 1 }).hits[0]
            : rankBareMetals(metals, c, true)[0];
        if (!hit) throw new Error(c.wall ? `no texture library set for appearance class ${c.index}` : `no bare metal set (measured metalness at least ${REGION_FINISH.opening.bareMetallic}) for opening class ${c.index}`);
        return hit;
    });
    const fetched = await fetchLibrarySets([...new Set(chosen.map(h => h.entry.id))], { repoRoot, ...(opts.signal ? { signal: opts.signal } : {}), ...(opts.progress ? { progress: opts.progress } : {}) });
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
    return chosen.map((hit, k) => {
        const files = prepared.get(hit.entry.id)!;
        return {
            name: hit.entry.id, realSizeM: hit.entry.realSizeM ?? metalSize!, distance: hit.distance,
            ...(!classes[k].wall && hit.entry.metallic ? { metalnessScale: REGION_FINISH.opening.metallic / hit.entry.metallic } : {}),
            ...(hit.entry.realSizeM ? {} : { realSizeEstimate: `its publisher gives no real size; tiled at ${metalSize!.join(' x ')} m, the median size of the library's ${sizedMetals.length} sized bare-metal sets` }),
            normal: decodeImageInMemory(fs.readFileSync(files.normal)), orm: decodeImageInMemory(fs.readFileSync(files.orm))
        };
    });
}
