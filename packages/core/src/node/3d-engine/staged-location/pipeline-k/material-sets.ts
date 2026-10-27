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
 * library set nearest its colour (searchTextureLibrary, among the sets whose colour has been measured and whose publisher
 * gives a real size and a normal and roughness map), fetched from the library bucket (fetchLibrarySets) and prepared
 * small by the engine (surface.prepare_material_maps), cached beside the set for later builds.
 */

import * as fs from 'fs';
import * as path from 'path';
import { searchTextureLibrary } from '../../../../common/spatial/texture-library-index';
import { fetchLibrarySets, loadTextureLibraryIndex } from '../../texture-library';
import { NativePythonRunnerService } from '../../native-python-runner-service';
import { decodeImageInMemory } from '../tile-texture-transfer';
import type { RegionClass, RegionSet } from './material-regions';

/** Prepared map size: a facade texel is several centimetres, so a tile of a metre or two needs few texels. */
const PREPARED_SIZE = 256;

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
    const pool = index.sets.filter(e => e.colour && e.realSizeM && e.maps.color && e.maps.normal && (e.maps.roughness || e.maps.arm));
    if (!pool.length) throw new Error('no texture library set has a measured colour, a real size and normal and roughness maps');
    const chosen = classes.map(c => {
        const hit = searchTextureLibrary({ ...index, sets: pool }, { colorSrgb: c.meanLinear.map(linearToSrgb) as [number, number, number], colorSpreadLab: c.spreadLab, limit: 1 }).hits[0];
        if (!hit) throw new Error(`no texture library set for appearance class ${c.index}`);
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
    return chosen.map(hit => {
        const files = prepared.get(hit.entry.id)!;
        return {
            name: hit.entry.id, realSizeM: hit.entry.realSizeM!, distance: hit.distance,
            normal: decodeImageInMemory(fs.readFileSync(files.normal)), orm: decodeImageInMemory(fs.readFileSync(files.orm))
        };
    });
}
