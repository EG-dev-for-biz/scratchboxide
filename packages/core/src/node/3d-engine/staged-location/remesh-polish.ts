/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * One pass over a tile_refine remesh before it is shown or textured (the default staged path): the cleanup
 * (remesh-cleanup.ts: scraps out, the surface smoothed with its edges kept), then the rectified facades rebuilt on the
 * lines their photo shows (facade-lattice.ts). Applied to the remesh (l2) and to the facade grammar's remesh (l2g), whose
 * accepted grammar facades keep the grammar's windows. The clay and tile_refine's textured twin get the same edits.
 * Results are kept beside the remesh, keyed by the pass's version and options, so a repeat build does not redo them.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { cleanRemesh, remeshCleanupEnabled, REMESH_CLEANUP_VERSION, type RemeshCleanupStats } from './remesh-cleanup';
import { FACADE_LATTICE_PARAMS, FACADE_LATTICE_VERSION, rebuildFacadesOnLattice } from './facade-lattice';

export const REMESH_POLISH_VERSION = `remesh-polish/1(${REMESH_CLEANUP_VERSION},${FACADE_LATTICE_VERSION})`;

/** On unless SCRATCHBOX_STAGED_FACADE_LATTICE=0. */
export function facadeLatticeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.SCRATCHBOX_STAGED_FACADE_LATTICE?.trim() !== '0';
}

export interface RemeshPolishStats {
    cleanup?: RemeshCleanupStats;
    lattice?: { facades: number; rebuilt: number; cells: number; removedTriangles: number; perFacade: Array<{ id: number; cells: number; measuredShare: number; lines: [number, number] }> };
}

export interface PolishedRemesh { clayGlb: string; texturedGlb?: string; cacheKey: string; stats: RemeshPolishStats }

export function polishRemesh(input: { clayGlb: string; texturedGlb?: string; cacheKey: string; orthosDir?: string; /** Names the orthos when they are not tile_refine's own (pipeline K's rectified set), so the cache tells them apart. */ orthosKey?: string; skipFacades?: number[]; cleanup?: boolean; lattice?: boolean }): PolishedRemesh {
    const cleanup = input.cleanup ?? remeshCleanupEnabled(), lattice = (input.lattice ?? facadeLatticeEnabled()) && !!input.orthosDir && fs.existsSync(path.join(input.orthosDir, 'facades.json'));
    if (!cleanup && !lattice) return { clayGlb: input.clayGlb, ...(input.texturedGlb ? { texturedGlb: input.texturedGlb } : {}), cacheKey: input.cacheKey, stats: {} };
    const opts = JSON.stringify({ v: REMESH_POLISH_VERSION, cleanup, lattice, skip: [...(input.skipFacades ?? [])].sort((a, b) => a - b), ...(input.orthosKey ? { orthos: input.orthosKey } : {}) });
    const tag = crypto.createHash('sha256').update(opts).digest('hex').slice(0, 16);
    const dir = path.join(path.dirname(input.clayGlb), 'polish', tag);
    const clayOut = path.join(dir, 'clay.glb'), texOut = input.texturedGlb ? path.join(dir, 'textured.glb') : undefined, statsFile = path.join(dir, 'stats.json');
    if (!fs.existsSync(statsFile)) {
        let clay: Uint8Array = fs.readFileSync(input.clayGlb), tex: Uint8Array | undefined = input.texturedGlb ? fs.readFileSync(input.texturedGlb) : undefined;
        const stats: RemeshPolishStats = {};
        if (cleanup) { const c = cleanRemesh(clay, tex ? [tex] : []); clay = c.clay; tex = tex ? c.others[0] : undefined; stats.cleanup = c.stats; }
        if (lattice) {
            const skip = new Set(input.skipFacades ?? []);
            const l = rebuildFacadesOnLattice(clay, tex, input.orthosDir!, FACADE_LATTICE_PARAMS, skip);
            clay = l.clay; tex = l.textured ?? tex; stats.lattice = l.stats;
        }
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(clayOut, clay);
        if (texOut && tex) fs.writeFileSync(texOut, tex);
        fs.writeFileSync(statsFile, JSON.stringify(stats));
    }
    return {
        clayGlb: clayOut, ...(texOut ? { texturedGlb: texOut } : {}), cacheKey: crypto.createHash('sha256').update(`${input.cacheKey}+${opts}`).digest('hex'),
        stats: JSON.parse(fs.readFileSync(statsFile, 'utf8')) as RemeshPolishStats
    };
}

/** One line for the build's notes. */
export function describePolish(s: RemeshPolishStats): string {
    const parts: string[] = [];
    if (s.cleanup) parts.push(`${s.cleanup.piecesRemoved} loose scan pieces removed (${s.cleanup.areaRemovedM2} m²), the surface smoothed with its edges kept (mean shift ${s.cleanup.meanShiftM} m, at most 0.3 m)`);
    if (s.lattice) parts.push(`${s.lattice.rebuilt} of ${s.lattice.facades} rectified facades rebuilt on the lines their photo shows (${s.lattice.cells} cells; lines photo-inferred, depths measured and averaged along each storey's repeats)`);
    return parts.join('; ');
}
