/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The Washington Square Arch as tile_refine isolates it, from real Google Photorealistic 3D Tiles (Maps Platform content: not in
 * the repository). The suites read it, without modifying it, from SCRATCHBOX_ARCH_DIR (a directory holding raw_clay.glb,
 * clay.glb and textured.glb), else from a tile_refine cache entry or public/models in this checkout, the main checkout this
 * worktree belongs to, or a sibling worktree; they skip, with a reason, when none has it.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { REPO_ROOT } from './requirements';

export interface ArchData { rawClay: string; remeshClay: string; texturedIsolated: string; from: string }

/** The main checkout of this repository and every worktree beside it. */
function roots(): string[] {
    const out = [REPO_ROOT];
    try {
        const common = execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim();
        const main = path.dirname(common);
        out.push(main);
        const wt = path.join(main, '.claude', 'worktrees');
        if (fs.existsSync(wt)) for (const d of fs.readdirSync(wt)) out.push(path.join(wt, d));
    } catch { /* not a git checkout */ }
    return out;
}

export function findArchData(): ArchData | undefined {
    const env = process.env.SCRATCHBOX_ARCH_DIR;
    if (env && ['raw_clay.glb', 'clay.glb', 'textured.glb'].every(f => fs.existsSync(path.join(env, f)))) {
        return { rawClay: path.join(env, 'raw_clay.glb'), remeshClay: path.join(env, 'clay.glb'), texturedIsolated: path.join(env, 'textured.glb'), from: env };
    }
    for (const root of roots()) {
        const cache = path.join(root, '.scratchbox/cache/tile_refine');
        if (fs.existsSync(cache)) {
            for (const d of fs.readdirSync(cache)) {
                const dir = path.join(cache, d);
                const stats = path.join(dir, 'stats.json');
                if (!fs.existsSync(stats) || !['raw_clay.glb', 'clay.glb', 'textured.glb'].every(f => fs.existsSync(path.join(dir, f)))) continue;
                try {
                    const s = JSON.parse(fs.readFileSync(stats, 'utf8'));
                    // the arch as isolated for the r250 tile (22.26 m tall; the 25 m sized isolate, 22.53 m, is findSizedArchData's)
                    if (s.isolate?.enabled && Math.abs(s.isolate.footprintArea_m2 - 158) < 5 && Math.abs(s.isolate.height_m - 22.26) < 0.05) {
                        return { rawClay: path.join(dir, 'raw_clay.glb'), remeshClay: path.join(dir, 'clay.glb'), texturedIsolated: path.join(dir, 'textured.glb'), from: dir };
                    }
                } catch { /* not a tile_refine entry */ }
            }
        }
        const models = path.join(root, 'public/models');
        if (fs.existsSync(models)) {
            const names = fs.readdirSync(models).filter(n => n.startsWith('washington_square_arch_') && n.includes('_isolated_'));
            const raw = names.find(n => n.endsWith('_raw_clay.glb')), clay = names.find(n => n.endsWith('_refined_clay.glb')), tex = names.find(n => n.endsWith('_refined.glb'));
            if (raw && clay && tex) return { rawClay: path.join(models, raw), remeshClay: path.join(models, clay), texturedIsolated: path.join(models, tex), from: models };
        }
    }
    return undefined;
}

/** A tile_refine cache entry (raw_clay.glb and its stats.json) whose isolate satisfies `pred`, from this checkout, the main one or a sibling worktree. */
export function findTileRefineEntry(pred: (isolate: any) => boolean): { rawClay: string; isolate: any; from: string } | undefined {
    for (const root of roots()) {
        const cache = path.join(root, '.scratchbox/cache/tile_refine');
        if (!fs.existsSync(cache)) continue;
        for (const d of fs.readdirSync(cache)) {
            const dir = path.join(cache, d);
            const stats = path.join(dir, 'stats.json');
            if (!fs.existsSync(stats) || !fs.existsSync(path.join(dir, 'raw_clay.glb'))) continue;
            try {
                const s = JSON.parse(fs.readFileSync(stats, 'utf8'));
                if (s.isolate?.enabled && pred(s.isolate)) return { rawClay: path.join(dir, 'raw_clay.glb'), isolate: s.isolate, from: dir };
            } catch { /* not a tile_refine entry */ }
        }
    }
    return undefined;
}

/** A scan from public/models (this checkout, the main one or a sibling worktree) whose file name contains `part` and ends in `suffix`. */
export function findPublicModel(part: string, suffix: string): string | undefined {
    for (const root of roots()) {
        const models = path.join(root, 'public/models');
        if (!fs.existsSync(models)) continue;
        const hit = fs.readdirSync(models).find(n => n.includes(part) && n.endsWith(suffix));
        if (hit) return path.join(models, hit);
    }
    return undefined;
}

/**
 * The Washington Square Arch as the staged pipeline isolates it at 25 m (tile_refine's isolate: 158 m2 footprint, ground at
 * -0.54 m, 22.53 m tall), the scan the fitter rejected for a shard 4.2 m from the fit. SCRATCHBOX_ARCH_SIZED_DIR (raw_clay.glb and
 * clay.glb) names it directly; else the tile_refine cache entry is looked for in this checkout, the main one and its worktrees.
 */
export function findSizedArchData(): { rawClay: string; remeshClay: string; from: string } | undefined {
    const env = process.env.SCRATCHBOX_ARCH_SIZED_DIR;
    if (env && ['raw_clay.glb', 'clay.glb'].every(f => fs.existsSync(path.join(env, f)))) return { rawClay: path.join(env, 'raw_clay.glb'), remeshClay: path.join(env, 'clay.glb'), from: env };
    for (const root of roots()) {
        const cache = path.join(root, '.scratchbox/cache/tile_refine');
        if (!fs.existsSync(cache)) continue;
        for (const d of fs.readdirSync(cache)) {
            const dir = path.join(cache, d);
            const stats = path.join(dir, 'stats.json');
            if (!fs.existsSync(stats) || !['raw_clay.glb', 'clay.glb'].every(f => fs.existsSync(path.join(dir, f)))) continue;
            try {
                const i = JSON.parse(fs.readFileSync(stats, 'utf8')).isolate;
                if (i?.enabled && Math.abs(i.footprintArea_m2 - 158) < 5 && Math.abs(i.height_m - 22.534) < 0.01 && Math.abs(i.groundY + 0.5417) < 0.01) return { rawClay: path.join(dir, 'raw_clay.glb'), remeshClay: path.join(dir, 'clay.glb'), from: dir };
            } catch { /* not a tile_refine entry */ }
        }
    }
    return undefined;
}

/** A real fit of the arch (scan_fit's structure_fit.json with its fitted and pass-through GLBs) from a scan_fit cache of this checkout or a sibling worktree. */
export function findArchFit(): { fitPath: string; dir: string } | undefined {
    for (const root of roots()) {
        const cache = path.join(root, '.scratchbox/cache/scan_fit');
        if (!fs.existsSync(cache)) continue;
        for (const d of fs.readdirSync(cache)) {
            const dir = path.join(cache, d), fitPath = path.join(dir, 'structure_fit.json');
            if (!fs.existsSync(fitPath) || !fs.existsSync(path.join(dir, 'fitted.glb')) || !fs.existsSync(path.join(dir, 'passthrough.glb'))) continue;
            try {
                const j = JSON.parse(fs.readFileSync(fitPath, 'utf8'));
                if (j.accepted && j.primitives?.length === 11 && j.slots?.length > 40 && Math.abs(j.footprint.areaM2 - 150) < 30) return { fitPath, dir };
            } catch { /* not a fit */ }
        }
    }
    return undefined;
}
