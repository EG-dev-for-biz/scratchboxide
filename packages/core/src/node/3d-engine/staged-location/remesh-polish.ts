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
import { FACADE_LATTICE_PARAMS, FACADE_LATTICE_VERSION, PHOTO_RECESS, rebuildFacadesOnLattice, type TearReport } from './facade-lattice';
import { BASE_CLEANUP_VERSION, cleanBase, type BaseCleanupReport } from './pipeline-k/base-cleanup';
import { fillOpenLoops, LATTICE_STITCH_VERSION, type FillReport } from './pipeline-k/lattice-stitch';
import type { Vec2 } from '../../../common/spatial/staged-location-contracts';

export const REMESH_POLISH_VERSION = `remesh-polish/1(${REMESH_CLEANUP_VERSION},${FACADE_LATTICE_VERSION})`;

/** On unless SCRATCHBOX_STAGED_FACADE_LATTICE=0. */
export function facadeLatticeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.SCRATCHBOX_STAGED_FACADE_LATTICE?.trim() !== '0';
}

export interface RemeshPolishStats {
    cleanup?: RemeshCleanupStats;
    base?: BaseCleanupReport;
    seal?: FillReport;
    lattice?: { facades: number; rebuilt: number; cells: number; removedTriangles: number; tears?: TearReport; perFacade: Array<{ id: number; cells: number; measuredShare: number; lines: [number, number] }> };
}

export interface PolishedRemesh { clayGlb: string; texturedGlb?: string; cacheKey: string; stats: RemeshPolishStats }

export function polishRemesh(input: { clayGlb: string; texturedGlb?: string; cacheKey: string; orthosDir?: string; /** Names the orthos when they are not tile_refine's own (pipeline K's rectified set), so the cache tells them apart. */ orthosKey?: string; skipFacades?: number[]; cleanup?: boolean; lattice?: boolean; /** Pipeline K: the base cleaned by the structure's footprint (pipeline-k/base-cleanup.ts), last. */ base?: { loops: Vec2[][]; groundY: number }; /** Pipeline K: the facades cut and stitched watertight, and the shell's open loops closed last (pipeline-k/lattice-stitch.ts). */ seal?: boolean; /** Pipeline K: the lattice recesses its windows as the straightened photo shows them (facade-lattice.ts PHOTO_RECESS), tile_refine having carved nothing. */ photoRecess?: boolean }): PolishedRemesh {
    const cleanup = input.cleanup ?? remeshCleanupEnabled(), lattice = (input.lattice ?? facadeLatticeEnabled()) && !!input.orthosDir && fs.existsSync(path.join(input.orthosDir, 'facades.json'));
    if (!cleanup && !lattice && !input.base && !input.seal) return { clayGlb: input.clayGlb, ...(input.texturedGlb ? { texturedGlb: input.texturedGlb } : {}), cacheKey: input.cacheKey, stats: {} };
    const opts = JSON.stringify({ v: REMESH_POLISH_VERSION, cleanup, lattice, skip: [...(input.skipFacades ?? [])].sort((a, b) => a - b), ...(input.orthosKey ? { orthos: input.orthosKey } : {}), ...(input.base ? { base: BASE_CLEANUP_VERSION, loops: input.base.loops, groundY: input.base.groundY } : {}), ...(input.seal ? { seal: LATTICE_STITCH_VERSION } : {}), ...(input.photoRecess ? { photoRecess: PHOTO_RECESS } : {}) });
    const tag = crypto.createHash('sha256').update(opts).digest('hex').slice(0, 16);
    const dir = path.join(path.dirname(input.clayGlb), 'polish', tag);
    const clayOut = path.join(dir, 'clay.glb'), texOut = input.texturedGlb ? path.join(dir, 'textured.glb') : undefined, statsFile = path.join(dir, 'stats.json');
    if (!fs.existsSync(statsFile)) {
        let clay: Uint8Array = fs.readFileSync(input.clayGlb), tex: Uint8Array | undefined = input.texturedGlb ? fs.readFileSync(input.texturedGlb) : undefined;
        const stats: RemeshPolishStats = {};
        if (cleanup) { const c = cleanRemesh(clay, tex ? [tex] : []); clay = c.clay; tex = tex ? c.others[0] : undefined; stats.cleanup = c.stats; }
        if (lattice) {
            const skip = new Set(input.skipFacades ?? []);
            const l = rebuildFacadesOnLattice(clay, tex, input.orthosDir!, FACADE_LATTICE_PARAMS, skip, { stitch: input.seal === true, photoRecess: input.photoRecess === true });
            clay = l.clay; tex = l.textured ?? tex; stats.lattice = l.stats;
        }
        if (input.base) {
            const b = cleanBase(clay, tex ? [tex] : [], input.base.loops, input.base.groundY);
            clay = b.clay; tex = tex ? b.others[0] : undefined; stats.base = b.report;
        }
        if (input.seal) {
            const sl = fillOpenLoops(clay, tex ? [tex] : [], input.base ? { footprint: input.base.loops } : {});
            clay = sl.clay; tex = tex ? sl.others[0] : undefined; stats.seal = sl.report;
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
    if (s.lattice) {
        const t = s.lattice.tears;
        parts.push(`${s.lattice.rebuilt} of ${s.lattice.facades} rectified facades rebuilt on the lines their photo shows (${s.lattice.cells} cells; lines photo-inferred, depths measured and averaged along each storey's repeats)` +
            (t ? `; tear audit: ${t.found ? `${t.found} torn pixels found, ${t.restoredTriangles} scan triangles put back${t.droppedFacades.length ? `, ${t.droppedFacades.length} facades left as scanned because a tear stayed` : ''}` : 'no tear'}${t.left ? `, ${t.left} torn pixels left` : ''}` : ''));
    }
    if (s.base) {
        const b = s.base;
        parts.push(`base cleaned by the footprint: ${b.strayPieces} stray pieces removed (${b.strayAreaM2} m², ${b.strayTriangles} triangles)${b.apronSkipped ? `; apron not trimmed (${b.apronSkipped})` : `, ${b.apronTriangles} apron triangles below ${'3'} m outside the footprint trimmed (${b.apronAreaM2} m²)`}${b.skirt.segments ? `; base closed along ${b.skirt.edgesClosed} footprint edges (${b.skirt.areaM2} m², generated)` : ''}`);
    }
    if (s.seal) {
        const q = s.seal;
        parts.push(`shell closed: ${q.filled + q.clipped3d} holes filled (the bottom capped; ${q.addedAreaM2} m² generated)${q.openAfter ? `; ${q.openAfter} open edges left (${q.skippedWallOnly} wall outlines not filled, ${q.unclosedLoops} loops with no fill inside the building)` : '; watertight: no open edge left'}`);
    }
    return parts.join('; ');
}
