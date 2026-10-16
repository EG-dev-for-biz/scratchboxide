/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Real Google 3D Tiles data for the staged-location tests, offline: extractions under public/models and the native
 * stages' cache entries (.scratchbox/cache/tile_vegetation, tile_refine) written by earlier real runs. They are
 * gitignored, so they are looked for in SCRATCHBOX_STAGED_REAL_DATA, this checkout, and the sibling
 * integration-behaviour worktree, and copied into the test's own directory before use (never edited in place).
 * Suites skip with a reason through requirements.ts when a file is absent.
 */

import * as fs from 'fs';
import * as path from 'path';
import { REPO_ROOT, type Requirement } from './requirements';

const ROOTS = [process.env.SCRATCHBOX_STAGED_REAL_DATA, REPO_ROOT, path.resolve(REPO_ROOT, '..', 'integration-behaviour')]
    .filter((r): r is string => !!r && fs.existsSync(r));

function firstExisting(rel: string): string | undefined {
    for (const root of ROOTS) {
        const p = path.join(root, rel);
        if (fs.existsSync(p)) return p;
    }
    return undefined;
}

/** The cache entries of one native stage (tile_vegetation, tile_refine) whose files satisfy `match`. */
function cacheEntries(stage: string, match: (dir: string) => boolean): string[] {
    const out: string[] = [];
    for (const root of ROOTS) {
        const dir = path.join(root, '.scratchbox', 'cache', stage);
        if (!fs.existsSync(dir)) continue;
        for (const e of fs.readdirSync(dir)) {
            const full = path.join(dir, e);
            if (fs.existsSync(path.join(full, 'done.json')) && match(full)) out.push(full);
        }
    }
    return out;
}

export interface CentralParkRealData {
    textured: string;
    strip: { devegetated: string; crowns: string; stats: string; cacheKey: string };
    remesh: { clay: string; stats: string; cacheKey: string; runMs: number };
    /** The plant entry of that strip's crowns (trees-fix: 1,043 trees within the 1.5M cap), when an earlier real run left one. */
    plant?: { trees: string; stats: string; cacheKey: string };
}

const CP_TEXTURED = 'public/models/central_park_40.78256_-73.96558_r250_textured.glb';

/** Central Park r250 on trees-fix: the extraction, its strip and the remesh of the devegetated tile. */
export function centralParkRealData(): { data?: CentralParkRealData; requirement: Requirement } {
    const textured = firstExisting(CP_TEXTURED);
    const missing = (what: string): { requirement: Requirement } => ({ requirement: { ok: false, reason: `missing ${what} (gitignored real data from a Central Park r250 run on trees-fix; set SCRATCHBOX_STAGED_REAL_DATA to a checkout that has it)` } });
    if (!textured) return missing(CP_TEXTURED);
    // the strip whose input had 683,128 triangles (that extraction)
    const strip = cacheEntries('tile_vegetation', d => {
        if (!fs.existsSync(path.join(d, 'crowns.json')) || !fs.existsSync(path.join(d, 'devegetated.glb'))) return false;
        try { return JSON.parse(fs.readFileSync(path.join(d, 'stats.json'), 'utf8')).triangles?.input === 683_128; } catch { return false; }
    }).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
    if (!strip) return missing('a tile_vegetation strip entry of the Central Park extraction');
    const remesh = cacheEntries('tile_refine', d => {
        try { return String(JSON.parse(fs.readFileSync(path.join(d, 'done.json'), 'utf8')).input).endsWith(path.join(path.basename(strip), 'devegetated.glb')); } catch { return false; }
    })[0];
    if (!remesh) return missing('the tile_refine entry of the devegetated Central Park tile');
    const treeCrowns = (readJson(path.join(strip, 'crowns.json'))?.crowns ?? []).filter((c: { status: string }) => c.status === 'tree').length;
    const plant = cacheEntries('tile_vegetation', d => fs.existsSync(path.join(d, 'trees.glb')) && readJson(path.join(d, 'stats.json'))?.trees === treeCrowns)[0];
    return {
        data: {
            textured,
            strip: { devegetated: path.join(strip, 'devegetated.glb'), crowns: path.join(strip, 'crowns.json'), stats: path.join(strip, 'stats.json'), cacheKey: path.basename(strip) },
            remesh: { clay: path.join(remesh, 'clay.glb'), stats: path.join(remesh, 'stats.json'), cacheKey: path.basename(remesh), runMs: readJson(path.join(remesh, 'done.json'))?.runMs ?? 0 },
            ...(plant ? { plant: { trees: path.join(plant, 'trees.glb'), stats: path.join(plant, 'stats.json'), cacheKey: path.basename(plant) } } : {})
        },
        requirement: { ok: true, reason: '' }
    };
}

function readJson(file: string): any {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
}

export interface ArchRealData {
    /** The r250 extraction of the Washington Square Arch (1.59M triangles). */
    textured: string;
    strip: { devegetated: string; crowns: string; cacheKey: string };
    /** tile_refine's isolated outputs on that tile's devegetated copy. */
    refine: { clay: string; rawClay: string; textured: string; stats: string; cacheKey: string; runMs: number };
}

const ARCH_TEXTURED = 'public/models/washington_square_arch_40.73122_-73.99709_r250_textured.glb';

/** The arch: its r250 extraction, strip's entry, and tile_refine's isolated outputs, from earlier real runs. */
export function archRealData(): { data?: ArchRealData; requirement: Requirement } {
    const missing = (what: string): { requirement: Requirement } => ({ requirement: { ok: false, reason: `missing ${what} (gitignored real data from a Washington Square Arch r250 run; set SCRATCHBOX_STAGED_REAL_DATA to a checkout that has it)` } });
    const textured = firstExisting(ARCH_TEXTURED);
    if (!textured) return missing(ARCH_TEXTURED);
    const strip = cacheEntries('tile_vegetation', d => fs.existsSync(path.join(d, 'crowns.json')) && readJson(path.join(d, 'stats.json'))?.triangles?.input === 1_592_881)[0];
    if (!strip) return missing('a tile_vegetation strip entry of the arch extraction');
    const refine = cacheEntries('tile_refine', d => {
        const input = String(readJson(path.join(d, 'done.json'))?.input ?? '');
        return input.endsWith(path.join(path.basename(strip), 'devegetated.glb')) && fs.existsSync(path.join(d, 'raw_clay.glb'));
    })[0];
    if (!refine) return missing('the isolated tile_refine entry of the arch');
    return {
        data: {
            textured,
            strip: { devegetated: path.join(strip, 'devegetated.glb'), crowns: path.join(strip, 'crowns.json'), cacheKey: path.basename(strip) },
            refine: {
                clay: path.join(refine, 'clay.glb'), rawClay: path.join(refine, 'raw_clay.glb'), textured: path.join(refine, 'textured.glb'), stats: path.join(refine, 'stats.json'),
                cacheKey: path.basename(refine), runMs: readJson(path.join(refine, 'done.json'))?.runMs ?? 0
            }
        },
        requirement: { ok: true, reason: '' }
    };
}

/** Copies files into `dir` (created), keeping their base names unless a name is given; returns the copies. */
export function copyInto(dir: string, files: Record<string, string>): Record<string, string> {
    fs.mkdirSync(dir, { recursive: true });
    const out: Record<string, string> = {};
    for (const [name, src] of Object.entries(files)) {
        const dest = path.join(dir, name);
        fs.copyFileSync(src, dest);
        out[name] = dest;
    }
    return out;
}

export const STAGED_SCREENSHOT_DIR = path.join(REPO_ROOT, 'test-results', 'screenshots', 'staged');
export const STAGED_RESULTS_DIR = path.join(REPO_ROOT, 'test-results', 'staged_location');
