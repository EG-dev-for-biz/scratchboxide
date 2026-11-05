/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The footprint model: the outline of the building at a point, read from the photo tiles alone by a small U-Net
 * (tools/footprint/footprint_model.py) on a 64 m top-down window of the tiles' height and photo colour rasterised by
 * the native engine (scripts/topdown_window.cpp). Measured on unseen buildings against city surveys
 * (docs/processes/nyc_truth_benchmark_2026-10-31.md): 84% median overlap in New York's SoHo (Google's vector outlines:
 * 76%), 86% on the Upper West Side, 67% in Amsterdam (Google: 46%). Weights of 2026-11-02: 11,102 NYC buildings from 20
 * neighbourhoods and 1,340 Amsterdam ones. Its outline is photo-inferred: a learned reading of measured tiles.
 *
 * Used where Google's vector footprint is missing, partial or merges the neighbours (decideFootprint): those are the cases
 * the benchmark found the vector data wrong on (28% of SoHo buildings start from a merged or partial outline). It also
 * judges, per building, whether the tiles confirm Google's outline (kFootprint, pipeline K's footprint). The model reads
 * a 64 m window (the one it was trained on) at the seed the structure was picked at; a building larger than that is read
 * window by window and the outlines joined (growFootprintModel).
 * SCRATCHBOX_FOOTPRINT_MODEL=0 turns it off; SCRATCHBOX_FOOTPRINT_MODEL_WEIGHTS points at other weights. Without its
 * weights (the gitignored .model-cache/) or its Python environment it is unavailable and says why; the build then keeps
 * what it had.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { Vec2 } from '../../../common/spatial/staged-location-contracts';
import { compileNativeCached, defaultNativeFlags, NativeBuildError, placeCachedBinary } from '../native-build-cache';
import { getPythonWorkerPool } from '../../process/persistent-python-worker';
import { repoPath, resolveRepoPython } from '../../process/repo-python';
import { findTileRefineRepoRoot } from '../tile-refine-service';
import { cellsFootprint } from './pipeline-e/massing-spec';

const execFileAsync = promisify(execFile);

/** The token buildMassing / massingProvenance read on parts extruded from the model's outline (label photo-inferred). */
export const FOOTPRINT_MODEL_TOKEN = 'footprint-model-photo-inferred';
export const FOOTPRINT_MODEL_VERSION = 'unet-footprint/2026-11-02-nyc+ams';
const WEIGHTS_FILE = path.join('.model-cache', 'footprint', 'unet_footprint_2026-11-02.pt');
const CLI_SOURCE = path.join('scripts', 'topdown_window.cpp');
const INCLUDE_DIR = path.join('packages', 'core', 'src', 'native', '3d-engine', 'include');
const BINARY = path.join('build', '3d-native', 'topdown_window');
/** Half the window rasterised around the point (the model reads the central 64 m; the rest sets the ground level). */
const WINDOW_HALF_M = 40;
const CELL_M = 0.25;
/** Radius around the point whose vertical faces give the walls' direction. */
const WALL_RADIUS_M = 25;

export interface FootprintModelResult {
    ok: boolean;
    model: string;
    /** Outline in the tile frame (x east, z south), counter-clockwise or clockwise as traced. */
    ring?: Vec2[];
    areaM2?: number;
    /** Mean model probability over the outlined cells (0-1): the outline's confidence. */
    meanProbInside?: number;
    probAtPoint: number;
    wallAngleDeg: number;
    groundY: number;
    reason?: string;
}

export function footprintModelEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.SCRATCHBOX_FOOTPRINT_MODEL !== '0';
}

export function footprintModelWeights(env: NodeJS.ProcessEnv = process.env): string {
    return env.SCRATCHBOX_FOOTPRINT_MODEL_WEIGHTS?.trim() || repoPath(WEIGHTS_FILE);
}

/** Why the model cannot run here, or undefined when it can (weights present). */
export function footprintModelUnavailable(env: NodeJS.ProcessEnv = process.env): string | undefined {
    if (!footprintModelEnabled(env)) return 'the footprint model is off (SCRATCHBOX_FOOTPRINT_MODEL=0)';
    const w = footprintModelWeights(env);
    return fs.existsSync(w) ? undefined : `the footprint model's weights are not at ${w} (copy them into .model-cache/footprint/, or set SCRATCHBOX_FOOTPRINT_MODEL_WEIGHTS)`;
}

let building: Promise<string> | undefined;
function ensureTopdownBinary(repoRoot = findTileRefineRepoRoot()): Promise<string> {
    if (process.env.SCRATCHBOX_TOPDOWN_WINDOW_BIN) return Promise.resolve(process.env.SCRATCHBOX_TOPDOWN_WINDOW_BIN);
    building ??= (async () => {
        const bin = path.join(repoRoot, BINARY);
        try {
            const built = await compileNativeCached({ sourcePath: path.join(repoRoot, CLI_SOURCE), includeDirs: [path.join(repoRoot, INCLUDE_DIR)], flags: defaultNativeFlags(['-pthread']), libs: ['-lz'], name: 'topdown_window', timeoutMs: 600_000 });
            placeCachedBinary(built.binaryPath, bin);
            return bin;
        } catch (err) {
            throw new Error(`could not build topdown_window: ${err instanceof NativeBuildError ? err.compilerOutput.slice(-1500) : String(err)}`);
        }
    })().finally(() => { building = undefined; });
    return building;
}

/**
 * The model's outline of the building at (x, z) of the textured tile (its own frame). Throws with the tool's or the
 * model's own error; check footprintModelUnavailable first.
 */
export async function runFootprintModel(opts: { texturedGlb: string; x: number; z: number; workDir: string; signal?: AbortSignal; timeoutMs?: number }): Promise<FootprintModelResult> {
    const why = footprintModelUnavailable();
    if (why) throw new Error(why);
    fs.mkdirSync(opts.workDir, { recursive: true });
    const bin = await ensureTopdownBinary();
    const { stdout } = await execFileAsync(bin, [opts.texturedGlb, String(opts.x), String(opts.z), String(WINDOW_HALF_M), String(CELL_M), String(WALL_RADIUS_M), opts.workDir],
        { timeout: 120_000, maxBuffer: 1 << 20, ...(opts.signal ? { signal: opts.signal } : {}) });
    const native = JSON.parse(stdout.trim().split('\n').pop() || '{}') as { ok?: boolean; error?: string };
    if (!native.ok) throw new Error(`topdown_window: ${native.error ?? stdout}`);
    const python = resolveRepoPython({ overrideVars: ['SCRATCHBOX_FOOTPRINT_PYTHON'], modules: ['numpy', 'torch', 'cv2'], purpose: 'The footprint model (tools/footprint/footprint_model.py)' });
    const out = path.join(opts.workDir, 'footprint_model.json');
    const pool = getPythonWorkerPool({ pythonBinary: python, scriptPath: repoPath('tools', 'footprint', 'footprint_model.py'), label: 'the footprint model', cwd: process.cwd() });
    const res = await pool.run({ argv: ['--window', opts.workDir, '--x', String(opts.x), '--z', String(opts.z), '--weights', footprintModelWeights(), '--out', out], timeoutMs: opts.timeoutMs ?? 120_000, ...(opts.signal ? { signal: opts.signal } : {}) });
    if (res.exitCode !== 0) throw new Error(`footprint model: ${res.stderr.trim().slice(-800) || `exit ${res.exitCode}`}`);
    const r = JSON.parse(fs.readFileSync(out, 'utf8')) as FootprintModelResult;
    if (r.ring) r.ring = r.ring.map(p => [p[0], p[1]] as Vec2);
    return r;
}

// ---------------------------------------------------------------------------------------------------------------
// a building larger than one window: the reading grown window by window

/** Half the model's crop (m): it reads 256 cells of CELL_M around its point. */
export const CROP_HALF_M = 32;
/** A ring vertex within this of its crop's edge (m) runs on past what that window saw. */
const CROP_EDGE_M = 1;
/** A new window is centred this far inside the building from where the last one's outline met its edge (m). */
const GROW_INSET_M = 6;
/** No two windows closer than this (m): a window that close sees little the other did not. */
const GROW_MIN_SPACING_M = 16;
/** At most this many windows for one building (a 150 m tower block takes about a dozen). */
export const GROW_MAX_WINDOWS = 16;

export interface GrownFootprintResult extends FootprintModelResult {
    /** The windows read, their centres in the tile frame, each with its own result. */
    windows: Array<{ at: Vec2; result: FootprintModelResult }>;
    /** The outline still meets the edge of a window read last: the building runs on past GROW_MAX_WINDOWS windows. */
    truncated: boolean;
}

/** The place stands at least this far inside Google's outline (m) for the model to be asked there. */
export const SEED_INSIDE_M = 3;

/**
 * Where the model is asked: at the place, as it was measured (the structure picker's seed, up to 30 m off, outlined a
 * neighbour in SoHo), when the place stands at least SEED_INSIDE_M inside Google's outline of the structure or there is
 * none; else at the point of that outline farthest from its edges (a geocode on the kerb, as 2 Penn Plaza's on its
 * neighbour, would read the neighbour).
 */
export function modelSeed(place: Vec2, vectorLoops: Vec2[][]): Vec2 {
    const loops = vectorLoops.filter(l => l.length >= 3);
    if (!loops.length) return place;
    const edgeDistance = (x: number, z: number) => {
        let d = Infinity;
        for (const r of loops) for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
            const [ax, az] = r[j], [bx, bz] = r[i], ex = bx - ax, ez = bz - az, l2 = ex * ex + ez * ez;
            const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / l2)) : 0;
            d = Math.min(d, Math.hypot(x - ax - t * ex, z - az - t * ez));
        }
        return d;
    };
    if (inLoops(loops, place[0], place[1]) && edgeDistance(place[0], place[1]) >= SEED_INSIDE_M) return place;
    const pts = loops.flat(), x0 = Math.min(...pts.map(p => p[0])), x1 = Math.max(...pts.map(p => p[0])), z0 = Math.min(...pts.map(p => p[1])), z1 = Math.max(...pts.map(p => p[1]));
    const step = Math.max(0.5, Math.max(x1 - x0, z1 - z0) / 150);
    let best: Vec2 = place, bestD = -1;
    for (let x = x0 + step / 2; x < x1; x += step) for (let z = z0 + step / 2; z < z1; z += step) {
        if (!inLoops(loops, x, z)) continue;
        const d = edgeDistance(x, z);
        if (d > bestD) { bestD = d; best = [x, z]; }
    }
    return best;
}

/** Whether a ring read in the crop centred at `at` reaches that crop's edge, and the vertices that do. */
export function cropEdgeVertices(ring: Vec2[], at: Vec2, halfM = CROP_HALF_M, tolM = CROP_EDGE_M): Vec2[] {
    return ring.filter(([x, z]) => Math.abs(x - at[0]) >= halfM - tolM || Math.abs(z - at[1]) >= halfM - tolM);
}

/**
 * The model's outline of the building at `seed`, grown past its 64 m crop: where the outline of a window meets that
 * window's edge, the building runs on, so another window is read GROW_INSET_M inside the outline from there; the model
 * outlines the building holding each window's centre, which lies inside the building already read, so every window reads
 * the same building. The outlines are joined on CELL_M cells into one ring (the largest piece). The confidence is the
 * windows' mean probability, weighted by their cells. One window when the building fits in it, as the model was measured.
 */
export async function growFootprintModel(opts: { texturedGlb: string; seed: Vec2; workDir: string; signal?: AbortSignal; maxWindows?: number; run?: typeof runFootprintModel }): Promise<GrownFootprintResult> {
    const runOne = opts.run ?? runFootprintModel;
    const maxWindows = opts.maxWindows ?? GROW_MAX_WINDOWS;
    const windows: GrownFootprintResult['windows'] = [];
    const queue: Vec2[] = [opts.seed];
    let truncated = false;
    while (queue.length) {
        const at = queue.shift()!;
        if (windows.length >= maxWindows) { truncated = true; break; }
        const result = await runOne({ texturedGlb: opts.texturedGlb, x: at[0], z: at[1], workDir: path.join(opts.workDir, `w${windows.length}`), ...(opts.signal ? { signal: opts.signal } : {}) });
        windows.push({ at, result });
        // the first window decides whether there is a building at all; later ones only add to it
        if (!result.ok || !result.ring || result.ring.length < 3) { if (windows.length === 1) break; continue; }
        const ring = result.ring;
        const seeds = () => [...windows.map(w => w.at), ...queue];
        for (const v of cropEdgeVertices(ring, at)) {
            const dx = at[0] - v[0], dz = at[1] - v[1], d = Math.hypot(dx, dz) || 1;
            const c: Vec2 = [v[0] + (dx / d) * GROW_INSET_M, v[1] + (dz / d) * GROW_INSET_M];
            if (!inLoops([ring], c[0], c[1])) continue;
            if (seeds().some(s => Math.hypot(s[0] - c[0], s[1] - c[1]) < GROW_MIN_SPACING_M)) continue;
            queue.push(c);
        }
    }
    const first = windows[0]?.result;
    const read = windows.filter(w => w.result.ok && w.result.ring && w.result.ring.length >= 3);
    if (!first?.ok || !read.length) return { ...(first ?? { ok: false, model: FOOTPRINT_MODEL_VERSION, probAtPoint: 0, wallAngleDeg: 0, groundY: 0 }), windows, truncated: false };
    if (read.length === 1) return { ...first, windows, truncated };
    // the outlines joined on the model's own cells
    const cells = new Set<string>();
    for (const w of read) {
        const r = w.result.ring!;
        const xs = r.map(p => p[0]), zs = r.map(p => p[1]);
        for (let i = Math.floor(Math.min(...xs) / CELL_M); i <= Math.floor(Math.max(...xs) / CELL_M); i++) {
            for (let j = Math.floor(Math.min(...zs) / CELL_M); j <= Math.floor(Math.max(...zs) / CELL_M); j++) {
                if (inLoops([r], (i + 0.5) * CELL_M, (j + 0.5) * CELL_M)) cells.add(`${i},${j}`);
            }
        }
    }
    const traced = cellsFootprint(cells);
    if (!traced) return { ...first, windows, truncated };
    const joined = traced.map(([i, j]) => [i * CELL_M, j * CELL_M] as Vec2);
    const weight = read.reduce((a, w) => a + (w.result.areaM2 ?? 0), 0);
    const meanProbInside = weight > 0 ? read.reduce((a, w) => a + (w.result.meanProbInside ?? 0) * (w.result.areaM2 ?? 0), 0) / weight : first.meanProbInside;
    return { ...first, ring: joined, areaM2: Math.abs(ringArea(joined)), ...(meanProbInside !== undefined ? { meanProbInside } : {}), windows, truncated };
}

// ---------------------------------------------------------------------------------------------------------------
// when the model's outline replaces the vector footprint

export interface FootprintDecision {
    use: 'model' | 'vector';
    reason: string;
    /** Overlap (IoU) of the model's outline with the vector footprint, when both exist. */
    iouWithVector?: number;
    vectorAreaM2?: number;
    modelAreaM2?: number;
}

// Fitted on the benchmark's 100 SoHo buildings the model trained on and measured on the 100 it never saw
// (scripts/benchmarks/nyc-truth/gate_footprint_model.py): Google's outlines alone 76% median overlap with the survey;
// with this rule 81%, the model taken on 15, better on 12, worse on 1. The looser first rule (0.6, 1.5x, 0.7) took it
// on 35 and was worse on 10: it read a building the model split in two as Google merging the neighbours.
/** Below this mean probability inside its outline the model's reading is not used at all (where no vector footprint exists). */
export const MODEL_MIN_CONFIDENCE = 0.6;
/** Replacing a vector footprint needs a model this sure. */
export const MERGED_MIN_CONFIDENCE = 0.95;
/** A vector footprint at least this many times the model's outline merges the neighbours (the benchmark's merged class). */
export const MERGED_AREA_RATIO = 2;
/** Model and vector footprint overlapping at or above this are read as the same building: the vector footprint stays. */
export const AGREE_IOU = 0.5;

// A partial vector footprint: Google's outline covers only part of the building the tiles show. Fitted the same way
// (scripts/benchmarks/nyc-truth/gate_footprint_model.py, partial rule, on top of the merged rule): of the 200 SoHo
// buildings it takes the model on 8, better on all 8 (by 0.2 to 0.4 overlap with the survey), worse on none; 3 of 3 on
// the unseen half. Looser settings tie it on the trained half but replaced a right vector footprint (1008237) on the
// unseen one. The model winning wherever the two disagree helped as often as it hurt: not used.
/** Replacing a partial vector footprint needs a model this sure. */
export const PARTIAL_MIN_CONFIDENCE = 0.9;
/** A vector footprint at most this share of the model's outline covers only part of the building... */
export const PARTIAL_AREA_RATIO = 0.8;
/** ...when at least this share of it lies inside the model's outline (it is a piece of the same building, not another). */
export const PARTIAL_CONTAINED = 0.8;

/**
 * Which footprint a build should stand on: the model's outline where Google's vector footprint is missing, where it
 * merges the neighbours (at least MERGED_AREA_RATIO times the model's outline and not agreeing with it, the model at
 * least MERGED_MIN_CONFIDENCE sure), or where it covers only part of the building (at most PARTIAL_AREA_RATIO of the
 * model's outline and lying at least PARTIAL_CONTAINED inside it, the model at least PARTIAL_MIN_CONFIDENCE sure); else
 * the vector footprint. A model outline under MODEL_MIN_CONFIDENCE is never used.
 */
export function decideFootprint(vectorLoops: Vec2[][] | undefined, model: Pick<FootprintModelResult, 'ok' | 'ring' | 'meanProbInside'> | undefined): FootprintDecision {
    if (!model?.ok || !model.ring || model.ring.length < 3) return { use: 'vector', reason: 'the footprint model found no building at the point' };
    const conf = model.meanProbInside ?? 0;
    const modelArea = Math.abs(ringArea(model.ring));
    if (conf < MODEL_MIN_CONFIDENCE) return { use: 'vector', reason: `the footprint model is unsure here (mean probability ${conf.toFixed(2)} < ${MODEL_MIN_CONFIDENCE})`, modelAreaM2: modelArea };
    if (!vectorLoops?.length) return { use: 'model', reason: 'Google\'s vector data has no footprint for this building', modelAreaM2: modelArea };
    // the vector parts' union: a building's parts at their own heights overlap in plan, and must not count twice
    const { areaA: vectorArea, inter, union } = rasterOverlap(vectorLoops, [model.ring]);
    const iou = union ? inter / union : 0;
    const contained = vectorArea ? inter / vectorArea : 0;
    // before the agreement test: a vector footprint that is part of the model's outline can overlap it up to its area ratio
    if (conf >= PARTIAL_MIN_CONFIDENCE && vectorArea <= PARTIAL_AREA_RATIO * modelArea && contained >= PARTIAL_CONTAINED) {
        return { use: 'model', reason: `the vector footprint (${Math.round(vectorArea)} m²) covers only part of the building the tiles show (${Math.round(modelArea)} m², ${Math.round(contained * 100)}% of it inside)`, iouWithVector: iou, vectorAreaM2: vectorArea, modelAreaM2: modelArea };
    }
    if (iou >= AGREE_IOU) return { use: 'vector', reason: `the vector footprint and the footprint model agree (overlap ${iou.toFixed(2)})`, iouWithVector: iou, vectorAreaM2: vectorArea, modelAreaM2: modelArea };
    if (conf < MERGED_MIN_CONFIDENCE) return { use: 'vector', reason: `the footprint model is not sure enough to replace the vector footprint (mean probability ${conf.toFixed(2)} < ${MERGED_MIN_CONFIDENCE}; overlap ${iou.toFixed(2)})`, iouWithVector: iou, vectorAreaM2: vectorArea, modelAreaM2: modelArea };
    if (vectorArea >= MERGED_AREA_RATIO * modelArea) {
        return { use: 'model', reason: `the vector footprint (${Math.round(vectorArea)} m²) merges the neighbours: ${(vectorArea / modelArea).toFixed(1)}x the building the tiles show (${Math.round(modelArea)} m², overlap ${iou.toFixed(2)})`, iouWithVector: iou, vectorAreaM2: vectorArea, modelAreaM2: modelArea };
    }
    return { use: 'vector', reason: `the vector footprint and the footprint model disagree (overlap ${iou.toFixed(2)}) but the vector one does not merge the neighbours; kept`, iouWithVector: iou, vectorAreaM2: vectorArea, modelAreaM2: modelArea };
}

/**
 * Model and vector footprint overlapping at least this much: the tiles confirm the vector footprint. On the benchmark's
 * 200 SoHo buildings, Google's outline was under 50% overlap with the survey on 2% of the 105 overlapping at least 0.7,
 * on none of the 16 between 0.6 and 0.7, on 25% between 0.5 and 0.6 and on 58% below. It was 0.7 until 2026-11-02;
 * live, four of the seven K builds left under 25% overlap stood on footprints between 0.6 and 0.7, unclipped.
 */
export const CONFIRM_IOU = 0.6;

/**
 * Whether the footprint a build stands on is confirmed by the tiles: the model's own outline (chosen by the gate), or
 * a vector footprint the model's outline overlaps at least CONFIRM_IOU. Pipeline K then cuts the scan to it even where
 * the isolate does not fit it: that misfit is the neighbours the isolate (or the district fallback) took in.
 */
export function footprintConfirmed(d: FootprintDecision | undefined): boolean {
    return !!d && (d.use === 'model' || (d.iouWithVector ?? 0) >= CONFIRM_IOU);
}

/** What pipeline K's base cleanup and clip stand on (kFootprint). */
export interface KFootprint {
    loops: Vec2[][];
    /** 'vector': Google's outline (traced from above for a modelled building); 'model': the footprint model's; 'scan': the scan's own outline. */
    from: 'vector' | 'model' | 'scan';
    /** The tiles confirm it (footprintConfirmed): the scan is cut to it even where it does not fit (that misfit is the neighbours the isolate took in). */
    trusted: boolean;
    reason: string;
}

/**
 * Pipeline K's footprint, judged per building against the tiles: Google's outline (traced from above for a modelled
 * building) where the footprint model's reading of the tiles confirms it (overlap at least CONFIRM_IOU), trusted; the
 * model's own outline where decideFootprint takes it (Google's missing, merging the neighbours or covering part of the
 * building), trusted; where the tiles do not confirm Google's outline, the scan's own outline, as K stood before Google's
 * modelled buildings were traced: an outline the tiles contradict can be older than the building they show (Penn 2's
 * rebuilt frontage stands past its Google outline). Without a sure model reading, Google's outline as it is, else the scan's.
 */
export function kFootprint(vectorLoops: Vec2[][], decision: FootprintDecision | undefined, modelRing: Vec2[] | undefined, modelConfidence: number | undefined, scanOutline: Vec2[]): KFootprint {
    const vector = vectorLoops.length > 0;
    const unread = !decision || !modelRing || modelRing.length < 3;
    if (unread || (modelConfidence ?? 0) < MODEL_MIN_CONFIDENCE) {
        const why = unread ? 'no footprint model reading' : `the footprint model is unsure here (mean probability ${(modelConfidence ?? 0).toFixed(2)})`;
        return vector ? { loops: vectorLoops, from: 'vector', trusted: false, reason: `${why}: Google's outline as it is` } : { loops: [scanOutline], from: 'scan', trusted: false, reason: `${why}: the scan's outline` };
    }
    if (decision!.use === 'model') return { loops: [modelRing!], from: 'model', trusted: true, reason: decision!.reason };
    if (footprintConfirmed(decision)) return { loops: vectorLoops, from: 'vector', trusted: true, reason: `the tiles confirm Google's outline (overlap ${(decision!.iouWithVector ?? 0).toFixed(2)})` };
    return { loops: [scanOutline], from: 'scan', trusted: false, reason: `the tiles do not confirm Google's outline (overlap ${(decision!.iouWithVector ?? 0).toFixed(2)} < ${CONFIRM_IOU}): the scan's outline` };
}

function ringArea(r: Vec2[]): number {
    let a = 0;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
    return a / 2;
}

/** Inside any of the loops (their union; each loop an outer ring). */
function inLoops(loops: Vec2[][], x: number, z: number): boolean {
    return loops.some(r => {
        let inside = false;
        for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
            if ((r[i][1] > z) !== (r[j][1] > z) && x < ((r[j][0] - r[i][0]) * (z - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) inside = !inside;
        }
        return inside;
    });
}

/** Area of the loops' union, on a 0.25 m grid. */
export function rasterArea(loops: Vec2[][], cell = 0.25): number {
    const pts = loops.flat();
    if (!pts.length) return 0;
    const x0 = Math.min(...pts.map(p => p[0])), x1 = Math.max(...pts.map(p => p[0]));
    const z0 = Math.min(...pts.map(p => p[1])), z1 = Math.max(...pts.map(p => p[1]));
    let n = 0;
    for (let x = x0 + cell / 2; x < x1; x += cell) for (let z = z0 + cell / 2; z < z1; z += cell) if (inLoops(loops, x, z)) n++;
    return n * cell * cell;
}

/** Overlap (intersection / union) of two sets of loops (each set taken as its loops' union), on a 0.25 m grid. */
export function rasterIoU(a: Vec2[][], b: Vec2[][], cell = 0.25): number {
    const o = rasterOverlap(a, b, cell);
    return o.union ? o.inter / o.union : 0;
}

/** Areas (m²) of a's union, of a and b's intersection and of their union, on a 0.25 m grid. */
function rasterOverlap(a: Vec2[][], b: Vec2[][], cell = 0.25): { areaA: number; inter: number; union: number } {
    const pts = [...a.flat(), ...b.flat()];
    if (!pts.length) return { areaA: 0, inter: 0, union: 0 };
    const x0 = Math.min(...pts.map(p => p[0])), x1 = Math.max(...pts.map(p => p[0]));
    const z0 = Math.min(...pts.map(p => p[1])), z1 = Math.max(...pts.map(p => p[1]));
    let na = 0, inter = 0, uni = 0;
    for (let x = x0 + cell / 2; x < x1; x += cell) for (let z = z0 + cell / 2; z < z1; z += cell) {
        const ia = inLoops(a, x, z), ib = inLoops(b, x, z);
        if (ia) na++;
        if (ia && ib) inter++;
        if (ia || ib) uni++;
    }
    const c2 = cell * cell;
    return { areaA: na * c2, inter: inter * c2, union: uni * c2 };
}
