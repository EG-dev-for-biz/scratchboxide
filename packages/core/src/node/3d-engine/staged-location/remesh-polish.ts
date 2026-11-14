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
 * accepted grammar facades keep the grammar's windows. Last, the result turned to face outward (remesh-orient.ts: pieces
 * seen only from behind from outside, and facing into the building, have their winding reversed), after the base cleanup has
 * read the shell's open sides. Pipeline K then closes the building from outside (pipeline-k/outside-closure.ts: the rebuilt
 * facades joined where they meet, an inner core behind every surface, and the holes still seen repaired by what they trace to).
 * The clay and tile_refine's textured twin get the same edits.
 * Results are kept beside the remesh, keyed by the pass's version and options, so a repeat build does not redo them.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { cleanRemesh, remeshCleanupEnabled, REMESH_CLEANUP_VERSION, type RemeshCleanupStats } from './remesh-cleanup';
import { orientRemesh, remeshOrientEnabled, REMESH_ORIENT_VERSION, type RemeshOrientStats } from './remesh-orient';
import { FACADE_LATTICE_PARAMS, FACADE_LATTICE_VERSION, LATTICE_CUT_VERSION, PHOTO_RECESS, rebuildFacadesOnLattice, type ProudReport, type TearReport } from './facade-lattice';
import { BASE_CLEANUP_PARAMS, BASE_CLEANUP_VERSION, cleanBase, type BaseCleanupReport } from './pipeline-k/base-cleanup';
import { clipToFootprint, fillOpenLoops, LATTICE_STITCH_VERSION, type ClipReport, type CutReport, type FillReport } from './pipeline-k/lattice-stitch';
import type { Vec2 } from '../../../common/spatial/staged-location-contracts';
import { closeOutside, describeOutsideClosure, OUTSIDE_CLOSURE_VERSION, type OutsideClosureReport } from './pipeline-k/outside-closure';
import { CORNER_JOIN_VERSION } from './pipeline-k/corner-join';
import { INNER_CORE_VERSION } from './pipeline-k/inner-core';
import { buildPartitionShell, partitionShellEnabled, partitionShellSettings, PARTITION_SHELL_VERSION, type PartitionShellReport } from './pipeline-k/partition-shell';

export const REMESH_POLISH_VERSION = `remesh-polish/1(${REMESH_CLEANUP_VERSION},${REMESH_ORIENT_VERSION},${FACADE_LATTICE_VERSION})`;

/** On unless SCRATCHBOX_STAGED_FACADE_LATTICE=0. */
export function facadeLatticeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.SCRATCHBOX_STAGED_FACADE_LATTICE?.trim() !== '0';
}

export interface RemeshPolishStats {
    cleanup?: RemeshCleanupStats;
    orient?: RemeshOrientStats;
    base?: BaseCleanupReport;
    seal?: FillReport;
    /** The building clipped to its footprint after the base cleanup; or why not. */
    clip?: { clay: ClipReport; textured?: ClipReport } | { skipped: string };
    /** The openings left closed by the fill (without the seal's cut and stitch). */
    infill?: FillReport;
    lattice?: { facades: number; rebuilt: number; cells: number; removedTriangles: number; tears?: TearReport; /** The proud audit: scan standing in front of the rebuilt facades (facade-lattice.ts ProudReport). */ proud?: ProudReport; cut?: CutReport; /** Cells left to the scan for measured relief the cells cannot draw (facade-lattice.ts KEEP_MEASURED), and their area. */ scanKeptCells?: number; scanKeptM2?: number; perFacade: Array<{ id: number; cells: number; measuredShare: number; lines: [number, number]; scanKeptCells?: number; scanKeptM2?: number }> };
    /** Pipeline K: the building closed from outside (joins, inner core) and its holes repaired (pipeline-k/outside-closure.ts). */
    closure?: OutsideClosureReport;
    /** Experiment (SCRATCHBOX_K_PARTITION_SHELL=1): the partition shell in place of every step after the lattice. */
    partition?: PartitionShellReport;
}

/** The polish's steps in the order they run. */
export const POLISH_STEPS = ['cleanup', 'lattice', 'partition', 'base', 'clip', 'infill', 'seal', 'orient', 'closure'] as const;

export interface PolishedRemesh { clayGlb: string; texturedGlb?: string; cacheKey: string; stats: RemeshPolishStats; /** The model after each step that ran (step_<name>.glb, textured where there is a textured copy), by step name. */ snapshots: Record<string, string> }

/**
 * A JSON input's hash without its timings (every `ms` and `...Ms` field): the window fit, wall grammar, wall sheets and
 * reveal depth record how long they took, which differs between two builds of the same scan, and a key over the bytes
 * then gave each build its own polish (the same geometry under another tag) and never a cache hit.
 */
export function contentHash(file: string): string {
    const text = fs.readFileSync(file, 'utf8');
    let body = text;
    try { body = JSON.stringify(JSON.parse(text, (k, v) => (k === 'ms' || /[a-z]Ms$/.test(k) ? undefined : v))); } catch { /* not JSON: its bytes */ }
    return crypto.createHash('sha256').update(body).digest('hex').slice(0, 16);
}

export function polishRemesh(input: { clayGlb: string; texturedGlb?: string; cacheKey: string; orthosDir?: string; /** Names the orthos when they are not tile_refine's own (pipeline K's rectified set), so the cache tells them apart. */ orthosKey?: string; skipFacades?: number[]; cleanup?: boolean; /** The scan's inward-facing pieces turned outward (remesh-orient.ts); on unless SCRATCHBOX_STAGED_REMESH_ORIENT=0. */ orient?: boolean; lattice?: boolean; /** Pipeline K: the base cleaned by the structure's footprint (pipeline-k/base-cleanup.ts), last. */ base?: { loops: Vec2[][]; groundY: number; /** The loops are only the scan's own outline (no Google footprint): the clip leaves the rebuilt facades whole, fitted to the same scan more closely than its simplified outline. */ scanOutline?: boolean }; /** Pipeline K: the facades cut and stitched watertight, and the shell's open loops closed last (pipeline-k/lattice-stitch.ts). */ seal?: boolean; /** Pipeline K: the lattice recesses its windows as the straightened photo shows them (facade-lattice.ts PHOTO_RECESS), tile_refine having carved nothing. */ photoRecess?: boolean; /** Pipeline K: window_fit.json (window-fit.ts), whose windows the lattice writes into its extras. */ windowFit?: string; /** Pipeline K: wall_grammar.json (wall-grammar.ts), the bays the lattice recesses, read per wall. */ wallGrammar?: string; /** Pipeline K: the isolated scan before tile_refine flattened its walls, where the structure's relief is measured. */ rawScan?: string; /** Pipeline K: walls.json (wall-sheets.ts), each multi-facade wall rebuilt as one sheet, every facade whole where the scan has its wall. */ walls?: string; /** Pipeline K: reveal_depth.json (reveal-depth.ts), the windows' depth read from Street View. */ revealDepth?: string; /** Pipeline K, with base: every surface clipped to the footprint (plus BASE_CLEANUP_PARAMS.clipMarginM) after the base cleanup, where the footprint fits. */ clip?: boolean; /** Pipeline K: the shell's open loops closed by the fill (pipeline-k/lattice-stitch.ts fillOpenLoops) without the seal's cut and stitch. */ infill?: boolean; /** Pipeline K: the scan cut exactly to the rebuilt cells (facade-lattice.ts opts.cut) instead of whole triangles removed under the tear audit. */ latticeCut?: boolean; /** false: the lattice's proud audit measures only, removing no scan (SCRATCHBOX_K_PROUD_REMOVE=0). */ proudRemove?: boolean; /** Pipeline K, last: rebuilt facades joined where they meet, an inner core behind every surface, and the holes the outside check still sees repaired (pipeline-k/outside-closure.ts); each part on unless set false. */ closure?: { joins?: boolean; core?: boolean; repair?: boolean }; /** The native lattice's and infill's threads (remesh-polish-native.ts; every core when none): a chunked district's share. It changes how fast, not what, is built. */ threads?: number; /** Each polish step as it starts and finishes (the run's step log). */ onStep?: (step: string, state: 'running' | 'done' | 'failed') => void }): PolishedRemesh {
    const cleanup = input.cleanup ?? remeshCleanupEnabled(), orient = input.orient ?? remeshOrientEnabled(), lattice = (input.lattice ?? facadeLatticeEnabled()) && !!input.orthosDir && fs.existsSync(path.join(input.orthosDir, 'facades.json'));
    if (!cleanup && !orient && !lattice && !input.base && !input.seal && !input.infill && !input.closure) return { clayGlb: input.clayGlb, ...(input.texturedGlb ? { texturedGlb: input.texturedGlb } : {}), cacheKey: input.cacheKey, stats: {}, snapshots: {} };
    const opts = JSON.stringify({ v: REMESH_POLISH_VERSION, cleanup, orient, lattice, skip: [...(input.skipFacades ?? [])].sort((a, b) => a - b), ...(input.orthosKey ? { orthos: input.orthosKey } : {}), ...(input.base ? { base: BASE_CLEANUP_VERSION, loops: input.base.loops, groundY: input.base.groundY, ...(input.base.scanOutline ? { scanOutline: true } : {}) } : {}), ...(input.seal ? { seal: LATTICE_STITCH_VERSION } : {}), ...(input.clip && input.base ? { clip: LATTICE_STITCH_VERSION, clipMarginM: BASE_CLEANUP_PARAMS.clipMarginM } : {}), ...(input.infill && !input.seal ? { infill: LATTICE_STITCH_VERSION } : {}), ...(input.latticeCut && !input.seal ? { latticeCut: `${LATTICE_CUT_VERSION}+${LATTICE_STITCH_VERSION}` } : {}), ...(input.proudRemove === false ? { proudRemove: false } : {}), ...(input.closure ? { closure: `${OUTSIDE_CLOSURE_VERSION}+${CORNER_JOIN_VERSION}+${INNER_CORE_VERSION}`, joins: input.closure.joins !== false, core: input.closure.core !== false, repair: input.closure.repair !== false } : {}), ...(input.photoRecess ? { photoRecess: PHOTO_RECESS } : {}), ...(partitionShellEnabled() && lattice ? { partition: PARTITION_SHELL_VERSION, ...(partitionShellSettings().length ? { partitionSet: partitionShellSettings() } : {}) } : {}), ...(input.windowFit && fs.existsSync(input.windowFit) ? { windowFit: contentHash(input.windowFit) } : {}), ...(input.walls && fs.existsSync(input.walls) ? { walls: contentHash(input.walls) } : {}), ...(input.wallGrammar && fs.existsSync(input.wallGrammar) ? { wallGrammar: contentHash(input.wallGrammar) } : {}), ...(input.rawScan && fs.existsSync(input.rawScan) ? { rawScan: `${path.basename(path.dirname(input.rawScan))}:${fs.statSync(input.rawScan).size}` } : {}), ...(input.revealDepth && fs.existsSync(input.revealDepth) ? { revealDepth: contentHash(input.revealDepth) } : {}) });
    const tag = crypto.createHash('sha256').update(opts).digest('hex').slice(0, 16);
    const dir = path.join(path.dirname(input.clayGlb), 'polish', tag);
    const clayOut = path.join(dir, 'clay.glb'), texOut = input.texturedGlb ? path.join(dir, 'textured.glb') : undefined, statsFile = path.join(dir, 'stats.json');
    if (!fs.existsSync(statsFile)) {
        let clay: Uint8Array = fs.readFileSync(input.clayGlb), tex: Uint8Array | undefined = input.texturedGlb ? fs.readFileSync(input.texturedGlb) : undefined;
        const stats: RemeshPolishStats = {};
        fs.mkdirSync(dir, { recursive: true });
        // each step's result is kept beside the polish (step_<name>.glb) for the node graph's step snapshots
        const step = <R>(name: string, work: () => R): R => { input.onStep?.(name, 'running'); let ok = false; try { const v = work(); ok = true; return v; } finally { input.onStep?.(name, ok ? 'done' : 'failed'); } };
        const snapshot = (name: string) => { try { fs.writeFileSync(path.join(dir, `step_${name}.glb`), tex ?? clay); } catch { /* a snapshot is a view, never the build */ } };
        if (cleanup) { step('cleanup', () => { const c = cleanRemesh(clay, tex ? [tex] : []); clay = c.clay; tex = tex ? c.others[0] : undefined; stats.cleanup = c.stats; }); snapshot('cleanup'); }
        // the scan as cleaned, before anything was rebuilt over it: what the closure's repair may put back
        const cleaned = { clay, ...(tex ? { tex } : {}) };
        if (lattice) {
            const skip = new Set(input.skipFacades ?? []);
            const l = step('lattice', () => rebuildFacadesOnLattice(clay, tex, input.orthosDir!, FACADE_LATTICE_PARAMS, skip, { stitch: input.seal === true, photoRecess: input.photoRecess === true, ...(input.windowFit ? { windowFit: input.windowFit } : {}), ...(input.wallGrammar ? { wallGrammar: input.wallGrammar } : {}), ...(input.rawScan ? { rawScan: input.rawScan } : {}), ...(input.walls ? { walls: input.walls } : {}), ...(input.revealDepth ? { revealDepth: input.revealDepth } : {}), ...(input.latticeCut && input.seal !== true ? { cut: true } : {}), ...(input.proudRemove === false ? { proudRemove: false } : {}), ...(input.threads ? { threads: input.threads } : {}) }));
            clay = l.clay; tex = l.textured ?? tex; stats.lattice = l.stats; snapshot('lattice');
        }
        // experiment: one closed solid cut by K's planes, the lattice inset on its walls, the scan kept only off it; nothing after
        const partition = partitionShellEnabled() && lattice && !!tex && !!cleaned.tex;
        if (partition) {
            const ps = step('partition', () => buildPartitionShell(cleaned.tex!, tex!, input.orthosDir!, { ...(input.threads ? { threads: input.threads } : {}) }));
            clay = ps.clay; tex = ps.tex; stats.partition = ps.report; snapshot('partition');
        }
        if (input.base && !partition) {
            const b = step('base', () => cleanBase(clay, tex ? [tex] : [], input.base!.loops, input.base!.groundY));
            clay = b.clay; tex = tex ? b.others[0] : undefined; stats.base = b.report; snapshot('base');
        }
        // the clip: the building cut at its footprint (only where the footprint fits it: the base cleanup says when it does not),
        // the openings left for the fill
        if (input.clip && input.base && !partition) {
            const misfit = stats.base?.apronSkipped;
            if (misfit) stats.clip = { skipped: misfit };
            else {
                // with only the scan's outline for a footprint the rebuilt facades stand where the scan's walls do, and the
                // outline, simplified, cuts their corners (Penn 2: 3,500 m² of rebuilt wall up to 4.7 m outside it, each cut a hole
                // through the building), so they are left whole
                const clipOpts = { ...(input.threads ? { threads: input.threads } : {}), ...(input.base.scanOutline ? { keepNodes: { keep: (n: string) => n.startsWith('FacadeLattice_'), why: "the footprint is the scan's own outline: the rebuilt facades, fitted to the same scan, are not cut by it" } } : {}) };
                const c = step('clip', () => ({ clay: clipToFootprint(clay, input.base!.loops, BASE_CLEANUP_PARAMS.clipMarginM, clipOpts), tex: tex ? clipToFootprint(tex, input.base!.loops, BASE_CLEANUP_PARAMS.clipMarginM, clipOpts) : undefined }));
                clay = c.clay.glb; tex = c.tex?.glb ?? tex; stats.clip = { clay: c.clay.report, ...(c.tex ? { textured: c.tex.report } : {}) }; snapshot('clip');
            }
        }
        if (input.infill && !input.seal && !partition) {
            const fi = step('infill', () => fillOpenLoops(clay, tex ? [tex] : [], { ...(input.base ? { footprint: input.base.loops } : {}), ...(input.threads ? { threads: input.threads } : {}) }));
            clay = fi.clay; tex = tex ? fi.others[0] : undefined; stats.infill = fi.report; snapshot('infill');
        }
        if (input.seal && !partition) {
            const sl = step('seal', () => fillOpenLoops(clay, tex ? [tex] : [], { ...(input.base ? { footprint: input.base.loops } : {}), ...(input.threads ? { threads: input.threads } : {}) }));
            clay = sl.clay; tex = tex ? sl.others[0] : undefined; stats.seal = sl.report; snapshot('seal');
        }
        // last: the base cleanup reads the shell's inside seen along the footprint line as an open party wall, so the scan is
        // turned to face outward only once that wall is closed (and the rebuilt facades are in place)
        if (orient && !partition) { step('orient', () => { const o = orientRemesh(clay, tex ? [tex] : []); clay = o.clay; tex = tex ? o.others[0] : undefined; stats.orient = o.stats; }); snapshot('orient'); }
        // last, on the finished shell: joins, the inner core, then the holes still seen repaired by what they trace to; the
        // footprint limits the core only where it fits the building (not the scan's own simplified outline, which cuts corners)
        if (input.closure && !partition) {
            const fits = input.base && !input.base.scanOutline && !stats.base?.apronSkipped;
            const c = step('closure', () => closeOutside({ clay, ...(tex ? { tex } : {}), pre: cleaned, ...(fits ? { footprint: input.base!.loops } : {}), ...(input.base ? { groundY: input.base.groundY } : {}), ...(input.threads ? { threads: input.threads } : {}), ...input.closure }));
            clay = c.clay; tex = c.tex ?? tex; stats.closure = c.report; snapshot('closure');
        }
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(clayOut, clay);
        if (texOut && tex) fs.writeFileSync(texOut, tex);
        fs.writeFileSync(statsFile, JSON.stringify(stats));
    }
    return {
        clayGlb: clayOut, ...(texOut ? { texturedGlb: texOut } : {}), cacheKey: crypto.createHash('sha256').update(`${input.cacheKey}+${opts}`).digest('hex'),
        stats: JSON.parse(fs.readFileSync(statsFile, 'utf8')) as RemeshPolishStats,
        snapshots: Object.fromEntries(POLISH_STEPS.map(n => [n, path.join(dir, `step_${n}.glb`)] as const).filter(([, f]) => fs.existsSync(f)))
    };
}

/** One line for the build's notes. */
export function describePolish(s: RemeshPolishStats): string {
    const parts: string[] = [];
    if (s.cleanup) parts.push(`${s.cleanup.piecesRemoved} loose scan pieces removed (${s.cleanup.areaRemovedM2} m²), the surface smoothed with its edges kept (mean shift ${s.cleanup.meanShiftM} m, at most 0.3 m)`);
    if (s.orient?.turned) parts.push(`${s.orient.turned} scan triangles seen only from behind turned to face outward (${s.orient.turnedAreaM2} m²)`);
    if (s.lattice) {
        const t = s.lattice.tears;
        parts.push(`${s.lattice.rebuilt} of ${s.lattice.facades} rectified facades rebuilt on the lines their photo shows (${s.lattice.cells} cells; lines photo-inferred, depths measured and averaged along each storey's repeats)` +
            (s.lattice.scanKeptCells ? `; ${s.lattice.scanKeptCells} cells (${s.lattice.scanKeptM2} m²) left to the scan for measured relief the cells cannot draw (fins, louvres, setback edges)` : '') +
            (s.lattice.cut ? `; the scan cut exactly at the rebuilt cells (${s.lattice.cut.cutTriangles} triangles cut, ${s.lattice.cut.removedPieces} pieces over the cells dropped)` : '') +
            (t ? `; tear audit: ${t.found ? `${t.found} torn pixels found, ${t.restoredTriangles} scan triangles put back${t.restoredInFront ? ` (${t.restoredInFront} over holes seen straight on, though they stand in front of the rebuild)` : ''}${t.keptInFront ? `, ${t.keptInFront} kept out because they would stand in front of the rebuild${t.obliqueLeft ? ` (${t.obliqueLeft} pixels seen only from an angle left open)` : ''}` : ''}${t.droppedFacades.length ? `, ${t.droppedFacades.length} facades left as scanned because a tear stayed` : ''}` : 'no tear'}${t.left ? `, ${t.left} torn pixels left` : ''}` : '') +
            (s.lattice.proud ? `; proud audit: ${s.lattice.proud.m2 ? `${s.lattice.proud.m2} m² of scan standing more than ${s.lattice.proud.tolM} m in front of the rebuilt facades (seen straight on; ${s.lattice.proud.obliqueM2} m² from the angles), ${s.lattice.proud.removedTriangles} triangles over the rebuilt cells removed${s.lattice.proud.restoredTriangles ? ` (${s.lattice.proud.restoredTriangles} put back where the removal opened a tear)` : ''}, ${s.lattice.proud.afterM2} m² left proud (reaching past the cells, or closing a hole the rebuild leaves)` : 'no scan stands proud of the rebuilt facades'}` : ''));
    }
    if (s.base) {
        const b = s.base;
        parts.push(`base cleaned by the footprint: ${b.strayPieces} stray pieces removed (${b.strayAreaM2} m², ${b.strayTriangles} triangles)${b.apronSkipped ? `; apron not trimmed (${b.apronSkipped})` : `, ${b.apronTriangles} apron triangles below ${'3'} m outside the footprint trimmed (${b.apronAreaM2} m²)`}${b.skirt.segments ? `; base closed along ${b.skirt.edgesClosed} footprint edges (${b.skirt.areaM2} m², generated)` : ''}`);
    }
    if (s.seal) {
        const q = s.seal;
        parts.push(`shell closed: ${q.filled + q.clipped3d} holes filled (the bottom capped; ${q.addedAreaM2} m² generated)${q.openAfter ? `; ${q.openAfter} open edges left (${q.skippedWallOnly} wall outlines not filled, ${q.unclosedLoops} loops with no fill inside the building)` : '; watertight: no open edge left'}`);
    }
    if (s.closure) parts.push(describeOutsideClosure(s.closure));
    if (s.partition) { const n = s.partition.native; parts.push(`partition shell (experiment): ${n.planes?.total} planes (${n.planes?.priorPlanesKept} of them K's facade planes), ${n.cells} cells labelled by winding number, a closed shell of ${n.shell?.triangles} triangles (${n.shell?.boundaryEdges} open edges); ${n.inset?.facesInset} facade faces inset with ${n.inset?.rimsKept} lattice relief pieces; residual scan ${Math.round(n.residual?.areaM2 ?? 0)} m², seam ${Math.round(n.residual?.seamJoinedM ?? 0)} m`); }
    return parts.join('; ');
}
