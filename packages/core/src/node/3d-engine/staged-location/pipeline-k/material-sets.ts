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
 * has been measured, whose publisher gives a real size and a normal and roughness map, and that are not metal), fetched
 * from the library bucket (fetchLibrarySets) and prepared small by the engine (surface.prepare_material_maps), cached
 * beside the set for later builds.
 */

import * as fs from 'fs';
import * as path from 'path';
import { searchTextureLibrary, type TextureLibraryEntry } from '../../../../common/spatial/texture-library-index';
import { fetchLibrarySets, libraryColourPreview, loadTextureLibraryIndex, measureLibraryEntries } from '../../texture-library';
import { libraryTextureEnergy, textureDistance } from './material-harvest';
import { NativePythonRunnerService } from '../../native-python-runner-service';
import { decodeImageInMemory } from '../tile-texture-transfer';
import type { RegionClass, RegionSet } from './material-regions';

/** Prepared map size: a facade texel is several centimetres, so a tile of a metre or two needs few texels. */
const PREPARED_SIZE = 256;

/**
 * The finish every class is ranked toward, against the sets' measured roughness and metalness: matte and not metal,
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
    const notMetal = (e: TextureLibraryEntry) => !(e.metallic !== undefined && e.metallic >= REGION_FINISH.maxMetallic);
    const pool = mapped.filter(e => e.realSizeM && notMetal(e));
    if (!pool.length) throw new Error('no texture library set that is not metal has a measured colour, a real size and normal and roughness maps');
    const query = (c: RegionClass) => ({ colorSrgb: c.meanLinear.map(linearToSrgb) as [number, number, number], colorSpreadLab: c.spreadLab, roughness: REGION_FINISH.roughness, metallic: REGION_FINISH.metallic });
    // every class's shortlist measured first, so its normal relief can be ranked (and a set measured as metal left out)
    const own = classes.map(c => new Set(searchTextureLibrary({ ...index, sets: pool }, { ...query(c), limit: SHORTLIST }).hits.map(h => h.entry.id)));
    const shortlist = new Set(own.flatMap(o => [...o]));
    if (shortlist.size) {
        opts.progress?.(`material regions: measuring ${shortlist.size} candidates`);
        await measureLibraryEntries(pool.filter(e => shortlist.has(e.id)), { repoRoot, ...(opts.signal ? { signal: opts.signal } : {}) });
    }
    const reloaded = (loadTextureLibraryIndex(repoRoot) ?? index).sets;
    const measured = reloaded.filter(e => shortlist.has(e.id) && e.colour && notMetal(e));
    const textured = new Map<number, { colourDistance: number; textureDistance: number; setEnergy: number[]; candidates: number }>();
    const chosen = await Promise.all(classes.map(async (c, k) => {
        const mine = measured.filter(e => own[k].has(e.id));
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
                const best = scored.reduce((a, b) => (b.hit.distance / dc + TEXTURE_WEIGHT * b.tex / dt < a.hit.distance / dc + TEXTURE_WEIGHT * a.tex / dt ? b : a));
                textured.set(k, { colourDistance: best.hit.distance, textureDistance: Math.round(best.tex * 1000) / 1000, setEnergy: best.energy.map(v => Math.round(v * 1e6) / 1e6), candidates: scored.length });
                return best.hit;
            }
        }
        const hit = searchTextureLibrary({ ...index, sets: mine }, { ...query(c), normalTiltDeg: REGION_FINISH.normalTiltDeg, limit: 1 }).hits[0];
        if (!hit) throw new Error(`no texture library set for appearance class ${c.index}`);
        return hit;
    }));
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
            name: hit.entry.id, realSizeM: hit.entry.realSizeM!, distance: hit.distance,
            ...(textured.has(k) ? { harvest: { ...textured.get(k)!, classEnergy: classes[k].texture!.energy, texelM: classes[k].texture!.texelM, grain: `generated: the set's detail finer than the tile's ${Math.round(classes[k].texture!.texelM * 100)} cm texel is its own, below the tile's resolution` } } : {}),
            normal: decodeImageInMemory(fs.readFileSync(files.normal)), orm: decodeImageInMemory(fs.readFileSync(files.orm))
        };
    });
}
