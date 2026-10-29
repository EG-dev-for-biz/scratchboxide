/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The tile seam stage: the native seam passes (scratchbox_tile_seam_weld.hpp) behind their CLI driver
 * (scripts/tile_seam_weld.cpp), built through the native build cache. A staged location runs it on the tile
 * extraction as it arrives, and every later stage reads the welded scan (the raw extraction stays as it came).
 *
 * Three passes, each bounded by `toleranceM`:
 *  1. overlap trim: where two tiles cover the same surface, the border triangles of one lying wholly over the other go;
 *  2. weld: border positions of different tiles snap onto each other (the 1-3 cm gaps between chunks), and the triangles
 *     the weld collapses into slivers are dropped;
 *  3. T-junctions: a border position lying on another tile's edge moves onto it and the edge is split there.
 * UVs are carried (interpolated along a split edge); materials and images pass through.
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { compileNativeCached, defaultNativeFlags, NativeBuildError, placeCachedBinary } from './native-build-cache';
import { findTileRefineRepoRoot } from './tile-refine-service';

/** The seam stage's version: names its cached outputs beside the extraction, so a change to any pass rebuilds them. */
export const TILE_SEAMS_VERSION = 'tile-seams/2';

export type TileSeamWeldErrorCode = 'bad_request' | 'build_failed' | 'run_failed' | 'invalid_output';

export class TileSeamWeldError extends Error {
    constructor(public readonly code: TileSeamWeldErrorCode, message: string) {
        super(message);
        this.name = 'TileSeamWeldError';
    }
}

export interface TileSeamWeldRequest {
    /** The scan (binary glTF). */
    inputGlb: string;
    /** Where the welded scan goes (textured: materials, UVs and images pass through). */
    outputGlb?: string;
    /** Also a studio clay version of the welded scan. */
    outputClayGlb?: string;
    /** Boundary positions of different pieces at most this far apart are welded (default 0.03 m; (0, 1]). */
    toleranceM?: number;
    /** Drop the triangles the weld collapses into slivers (default true). */
    dropSlivers?: boolean;
    /** Trim the border triangles of a tile lying wholly over another tile's surface (default true). */
    overlapTrim?: boolean;
    /** Close T-junctions: a border position on another tile's edge moved onto it and the edge split there (default true). */
    tJunctions?: boolean;
    /** Worker threads (default: all cores). */
    threads?: number;
    /** Longest the run may take, not counting a first-use build (default 120 s). */
    timeoutMs?: number;
    /** Where scripts/tile_seam_weld.cpp and the engine headers live (default: discovered). */
    repoRoot?: string;
}

/** The kernel's own counts (scratchbox_tile_seam_weld.hpp TileSeamWeldStats). */
export interface TileSeamWeldStats {
    vertices: number;
    triangles: number;
    /** Distinct positions. */
    groups: number;
    /** Connected pieces through shared positions (tile chunks, plus floating bits). */
    pieces: number;
    boundaryGroups: number;
    boundaryEdges: number;
    /** Boundary positions with another piece's boundary position within the tolerance plus the search pad. */
    contactsFound: number;
    /** Boundary positions moved. */
    groupsWelded: number;
    /** Vertices moved (members of the welded positions). */
    vertsWelded: number;
    /** Moves taken back because they would have turned a kept triangle inside out. */
    groupsReverted: number;
    /** Moves resolved through a chain of targets (three or more pieces at one point). */
    chainedWelds: number;
    /** Pieces dropped whole because every triangle of them is a sliver (strips lying in a seam). */
    stripPiecesDropped: number;
    stripTrianglesDropped: number;
    /** Triangles dropped in all: the strip pieces plus the triangles the weld collapsed. */
    trianglesDropped: number;
    /** Of the dropped triangles, those the weld itself collapsed (not slivers before). */
    trianglesCollapsed: number;
    meanWeldDisplacementM: number;
    maxWeldDisplacementM: number;
    /** Bucket edges in metres of gapHistogram: [0, 1 mm, 5 mm, 1 cm, 3 cm, 10 cm). */
    gapHistogramEdges_m: number[];
    gapHistogram: number[];
}

/** The overlap trim's counts (TileSeamTrimStats). */
export interface TileSeamTrimStats { trianglesDropped: number; areaM2: number; roundsRun: number }
/** The T-junction closure's counts (TileSeamTJunctionStats). */
export interface TileSeamTJunctionStats { borderEdges: number; found: number; closed: number; edgesSplit: number; trianglesAdded: number; reverted: number; deferred: number; roundsRun: number; maxMoveM: number }

export interface TileSeamWeldResult {
    inputTriangles: number;
    outputTriangles: number;
    toleranceM: number;
    dropSlivers: boolean;
    seamWeld: TileSeamWeldStats;
    /** Present when the pass ran. */
    overlapTrim?: TileSeamTrimStats;
    tJunctions?: TileSeamTJunctionStats;
    ms: { load: number; weld: number; write: number };
    binaryPath: string;
}

const CLI_SOURCE = path.join('scripts', 'tile_seam_weld.cpp');
const INCLUDE_DIR = path.join('packages', 'core', 'src', 'native', '3d-engine', 'include');
const BINARY = path.join('build', '3d-native', 'tile_seam_weld');
let building: Promise<string> | undefined;

/** Builds build/3d-native/tile_seam_weld through the native build cache when its sources changed. */
export function ensureTileSeamWeldBinary(repoRoot = findTileRefineRepoRoot()): Promise<string> {
    if (process.env.SCRATCHBOX_TILE_SEAM_WELD_BIN) return Promise.resolve(process.env.SCRATCHBOX_TILE_SEAM_WELD_BIN);
    if (building) return building;
    building = (async () => {
        const bin = path.join(repoRoot, BINARY);
        try {
            const built = await compileNativeCached({ sourcePath: path.join(repoRoot, CLI_SOURCE), includeDirs: [path.join(repoRoot, INCLUDE_DIR)], flags: defaultNativeFlags(), libs: ['-lz'], name: 'tile_seam_weld', timeoutMs: 300_000 });
            placeCachedBinary(built.binaryPath, bin);
            return bin;
        } catch (err) {
            throw new TileSeamWeldError('build_failed', `could not build tile_seam_weld: ${err instanceof NativeBuildError ? err.compilerOutput.slice(-1500) : String(err)}`);
        }
    })().finally(() => { building = undefined; });
    return building;
}

const NUMERIC_STATS: ReadonlyArray<keyof TileSeamWeldStats> = ['vertices', 'triangles', 'groups', 'pieces', 'boundaryGroups', 'boundaryEdges', 'contactsFound', 'groupsWelded', 'vertsWelded', 'groupsReverted', 'chainedWelds', 'stripPiecesDropped', 'stripTrianglesDropped', 'trianglesDropped', 'trianglesCollapsed', 'meanWeldDisplacementM', 'maxWeldDisplacementM'];

/** Checks a stats report the CLI wrote; throws invalid_output when a count is missing. */
export function parseTileSeamWeldReport(text: string): Omit<TileSeamWeldResult, 'binaryPath'> {
    let raw: any;
    try { raw = JSON.parse(text); } catch (err) { throw new TileSeamWeldError('invalid_output', `tile_seam_weld wrote no JSON report: ${(err as Error).message}`); }
    if (!raw || raw.ok !== true || typeof raw.seamWeld !== 'object') throw new TileSeamWeldError('invalid_output', 'tile_seam_weld wrote a report without ok and seamWeld');
    const sw = raw.seamWeld;
    for (const k of NUMERIC_STATS) if (!Number.isFinite(sw[k])) throw new TileSeamWeldError('invalid_output', `tile_seam_weld report lacks seamWeld.${k}`);
    if (!Array.isArray(sw.gapHistogram) || sw.gapHistogram.length !== 6 || !Array.isArray(sw.gapHistogramEdges_m)) throw new TileSeamWeldError('invalid_output', 'tile_seam_weld report lacks the gap histogram');
    for (const k of ['inputTriangles', 'outputTriangles', 'toleranceM'] as const) if (!Number.isFinite(raw[k])) throw new TileSeamWeldError('invalid_output', `tile_seam_weld report lacks ${k}`);
    return {
        inputTriangles: raw.inputTriangles, outputTriangles: raw.outputTriangles, toleranceM: raw.toleranceM, dropSlivers: raw.dropSlivers === true,
        seamWeld: sw as TileSeamWeldStats,
        ...(raw.overlapTrim && Number.isFinite(raw.overlapTrim.trianglesDropped) ? { overlapTrim: raw.overlapTrim as TileSeamTrimStats } : {}),
        ...(raw.tJunctions && Number.isFinite(raw.tJunctions.closed) ? { tJunctions: raw.tJunctions as TileSeamTJunctionStats } : {}),
        ms: { load: Number(raw.ms?.load) || 0, weld: Number(raw.ms?.weld) || 0, write: Number(raw.ms?.write) || 0 }
    };
}

/** Runs the seam weld on a scan. The outputs named in the request are written; the report is returned. */
export async function runTileSeamWeld(req: TileSeamWeldRequest): Promise<TileSeamWeldResult> {
    if (!req.inputGlb || !fs.existsSync(req.inputGlb)) throw new TileSeamWeldError('bad_request', `inputGlb must be an existing file (${req.inputGlb})`);
    const tolerance = req.toleranceM ?? 0.03;
    if (!Number.isFinite(tolerance) || tolerance <= 0 || tolerance > 1) throw new TileSeamWeldError('bad_request', 'toleranceM must be a number of metres in (0, 1]');
    if (req.threads !== undefined && (!Number.isInteger(req.threads) || req.threads < 0 || req.threads > 1024)) throw new TileSeamWeldError('bad_request', 'threads must be an integer in 0..1024');
    const bin = await ensureTileSeamWeldBinary(req.repoRoot);
    const statsPath = path.join(path.dirname(req.outputGlb ?? req.outputClayGlb ?? req.inputGlb), `.tile_seam_weld_${process.pid}_${Date.now()}.json`);
    const args = ['--input', req.inputGlb, '--stats', statsPath, '--tolerance', String(tolerance)];
    if (req.outputGlb) args.push('--out', req.outputGlb);
    if (req.outputClayGlb) args.push('--out-clay', req.outputClayGlb);
    if (req.dropSlivers === false) args.push('--no-drop');
    if (req.overlapTrim === false) args.push('--no-overlap-trim');
    if (req.tJunctions === false) args.push('--no-tjunctions');
    if (req.threads !== undefined) args.push('--threads', String(req.threads));
    try {
        await new Promise<void>((resolve, reject) => {
            execFile(bin, args, { timeout: req.timeoutMs ?? 120_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, _stdout, stderr) => {
                if (err) reject(new TileSeamWeldError('run_failed', `tile_seam_weld failed: ${String(stderr || err.message).trim().slice(-1500)}`));
                else resolve();
            });
        });
        if (!fs.existsSync(statsPath)) throw new TileSeamWeldError('invalid_output', 'tile_seam_weld exited 0 but wrote no stats report');
        const report = parseTileSeamWeldReport(fs.readFileSync(statsPath, 'utf8'));
        for (const out of [req.outputGlb, req.outputClayGlb]) {
            if (out && !(fs.existsSync(out) && fs.statSync(out).size > 12)) throw new TileSeamWeldError('invalid_output', `tile_seam_weld exited 0 but did not write ${out}`);
        }
        return { ...report, binaryPath: bin };
    } finally {
        fs.rmSync(statsPath, { force: true });
    }
}
