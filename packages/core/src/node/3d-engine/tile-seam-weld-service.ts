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
 *
 * Then, by source tile (each glTF node's: its leaf id, else the node; carried through every pass), when asked (adaptive):
 *  4. adaptive close: a border position and the nearest open border of another tile close up to the smaller of the two
 *     tiles' stated geometric errors (the crawler writes each leaf's into its node, extras.sb.tile), capped at 30 cm, only
 *     where the two surfaces agree there (normals within 8°, borders parallel within 20°, no step: each surface carried
 *     across the seam meets the other within 3 cm); a close that would turn a triangle by more than 25° is taken back;
 *  5. strip fill: agreed gaps a close would have distorted are bridged by thin triangles, drawn with a copy of the tile's
 *     material labelled generated (extras.scratchbox.provenance, photoInferredFill).
 *  0. cap trim (first, when asked, where the extraction gives each leaf's box): a leaf arrives cut along its box and capped, so two
 *     leaves carry strips back to back in their shared cut plane; both go. Inside the surface on the raw scan, they stand
 *     out as a slot across every recessed bay of a rebuilt facade at each cut's height.
 *  0b. step blend (when asked, after the caps): each tile's wall moves toward the other's by half the step measured at
 *     its rim, faded out over 1.5 m, within the smaller of the two tiles' stated errors capped at 50 cm.
 *  6. tone feather (when asked, where the extraction gives each leaf's box): on the surfaces crossing every cut two leaves'
 *     boxes share, the two photos' colour is levelled toward each other, half the step each, faded out over 2.5 m, and the
 *     photos written back in their own format; labelled generated (extras.scratchbox.method).
 * The seam audit (always) measures the open border inside the extraction's cut border by its gap to the nearest other tile's,
 * before, after the fixed passes (1-3) and after all of them.
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { parseGlb, serializeGlb } from './glb-geometry-patcher';
import { compileNativeCached, defaultNativeFlags, NativeBuildError, placeCachedBinary } from './native-build-cache';
import { findTileRefineRepoRoot } from './tile-refine-service';

/** The seam stage's version: names its cached outputs beside the extraction, so a change to any pass rebuilds them. */
export const TILE_SEAMS_VERSION = 'tile-seams/6';

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
    /** Close, tile by tile, the gaps the fixed passes leave, up to the pair's stated geometric error where the surfaces agree (default false). */
    adaptive?: boolean;
    /** The adaptive close goes no further than this (default 0.30 m; (0, 1]). */
    adaptiveCapM?: number;
    /** An adaptive close turning a triangle by more than this (degrees) is taken back and left to the strip fill (default 25). */
    maxTurnDeg?: number;
    /** With the adaptive close: bridge the agreed gaps it could not move without distortion (generated triangles; default true). */
    stripFill?: boolean;
    /** Level the tiles' photos' colour toward each other across every cut their boxes share (default false; needs boxes). */
    tone?: boolean;
    /** Remove the caps two tiles carry back to back in a shared cut plane (default false; needs boxes). */
    caps?: boolean;
    /** Fade the step between the two tiles' walls out either side of each cut (default false; needs boxes and stated errors). */
    blend?: boolean;
    /** A leaf's geometric error (m) when its node states none (e.g. the extraction's largest); none: such tiles pair at toleranceM. */
    defaultGeometricErrorM?: number;
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

/**
 * The seam audit (TileSeamWeld::auditSeams): open edge length (m) inside the extraction's cut border by the gap from its
 * midpoint to the nearest open edge of a different tile: [0, 3 cm), [3, 10 cm), [10, 30 cm), [30 cm, 1 m), none within 1 m.
 */
export interface TileSeamAudit { bandEdgesM: number[]; bandLengthM: number[]; bandEdges: number[]; atCutM: number; openEdges: number; tiles: number }
/** The adaptive close's counts (TileSeamAdaptiveStats). */
export interface TileSeamAdaptiveStats {
    capM: number;
    /** Border positions with another tile's open border within their pair's tolerance (first round), and how they were judged. */
    candidates: number; agreed: number; refusedNormal: number; refusedParallel: number; refusedStep: number; refusedNoSurface: number;
    /** The candidates by the angle between the two surfaces (normalAngleEdgesDeg), and the agreed ones by gap ([0, 3, 10, 30 cm, more)). */
    normalAngleEdgesDeg: number[]; normalAngleHist: number[]; agreedByGap: number[];
    splitsClosed: number; edgesSplit: number; trianglesAdded: number; vertexMoves: number; trianglesCollapsed: number; guardRefused: number;
    roundsRun: number; maxMoveM: number; meanMoveM: number; pairsWithStatedError: number; maxToleranceM: number;
}
/** The strip fill's counts (TileSeamFillStats): its triangles are generated. */
export interface TileSeamFillStats { edgesFilled: number; triangles: number; areaM2: number; refused: number }
/**
 * The tone feather's counts (TileSeamToneStats): the cuts two leaves' boxes share, the bins along them both sides read, the
 * photos and texels changed, the largest gain, and the CIELAB step between the two sides per bin (p50, p90) before and after.
 */
/** The cap trim's counts (TileCapStats): box faces two leaves share, triangles lying on one, those removed (backed by the neighbour's) and their area. */
export interface TileSeamCapStats { sharedFaces: number; candidates: number; trianglesDropped: number; areaM2: number }
/** The step blend's counts (TileSeamBlendStats). */
export interface TileSeamBlendStats { cuts: number; cutsMatched: number; positionsMoved: number; reverted: number; maxMoveM: number }
/** One cut's score (TileSeamCutScore): its two tiles, its plane, the open rim along it, how much found the other rim, the step and the gap. */
export interface TileSeamCutScore { tiles: number[]; u: number[]; o: number; rimLengthM: number; matchedLengthM: number; stepP50M: number; stepP90M: number; gapP50M: number }
/** The scores of every cut together (length-weighted means). */
export interface TileSeamCutTotals { cuts: number; rimLengthM: number; matchedLengthM: number; meanStepM: number; meanGapM: number; worstStepP90M: number }
/** A cut two leaves' boxes share, in the scan's frame: the plane u . x = o and the lower tile's face rectangle on it. */
export interface TileSeamCut { tiles: number[]; u: number[]; o: number; c: number[]; a: number[]; b: number[]; ha: number; hb: number }
export interface TileSeamToneStats { tilesBoxed: number; cuts: number; binsMatched: number; imagesChanged: number; texelsChanged: number; maxGain: number; dEBefore: number[]; dEAfter: number[] }

export interface TileSeamWeldResult {
    inputTriangles: number;
    outputTriangles: number;
    toleranceM: number;
    dropSlivers: boolean;
    seamWeld: TileSeamWeldStats;
    /** Present when the pass ran. */
    overlapTrim?: TileSeamTrimStats;
    tJunctions?: TileSeamTJunctionStats;
    adaptive?: TileSeamAdaptiveStats;
    stripFill?: TileSeamFillStats;
    tone?: TileSeamToneStats;
    capTrim?: TileSeamCapStats;
    stepBlend?: TileSeamBlendStats;
    /** The per-cut scores: as the scan came, after the caps went, after the step blend, at the end; and cut by cut. */
    cutScores?: { raw: TileSeamCutTotals; afterCaps: TileSeamCutTotals; afterBlend?: TileSeamCutTotals; final: TileSeamCutTotals; perCutAfterCaps: TileSeamCutScore[]; perCutFinal: TileSeamCutScore[] };
    /** The cuts two leaves' boxes share (when the extraction gives boxes): what the stages after read as the tiles' seams. */
    cuts?: TileSeamCut[];
    /** The source tiles: how many, how many nodes the stage named, how many state a geometric error. */
    tiles?: { count: number; nodesNamed: number; withStatedError: number };
    /** Before any pass, after the fixed passes (overlap trim, weld, T-junctions), and after all of them. */
    seamAudit?: { before: TileSeamAudit; afterFixed: TileSeamAudit; after: TileSeamAudit };
    ms: { load: number; weld: number; write: number; fixed?: number; adaptive?: number; fill?: number; tone?: number };
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

const isAudit = (a: any): a is TileSeamAudit => !!a && Array.isArray(a.bandLengthM) && a.bandLengthM.length === 5 && a.bandLengthM.every(Number.isFinite);

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
        ...(raw.adaptive && Number.isFinite(raw.adaptive.candidates) ? { adaptive: raw.adaptive as TileSeamAdaptiveStats } : {}),
        ...(raw.stripFill && Number.isFinite(raw.stripFill.triangles) ? { stripFill: raw.stripFill as TileSeamFillStats } : {}),
        ...(raw.tone && Number.isFinite(raw.tone.cuts) && Array.isArray(raw.tone.dEBefore) ? { tone: raw.tone as TileSeamToneStats } : {}),
        ...(raw.capTrim && Number.isFinite(raw.capTrim.trianglesDropped) ? { capTrim: raw.capTrim as TileSeamCapStats } : {}),
        ...(raw.stepBlend && Number.isFinite(raw.stepBlend.positionsMoved) ? { stepBlend: raw.stepBlend as TileSeamBlendStats } : {}),
        ...(raw.cutScores && Number.isFinite(raw.cutScores.final?.rimLengthM) && Array.isArray(raw.cutScores.perCutFinal) ? { cutScores: raw.cutScores } : {}),
        ...(Array.isArray(raw.cuts) ? { cuts: (raw.cuts as TileSeamCut[]).filter(c => Number.isFinite(c?.o) && Array.isArray(c.u) && c.u.length === 3) } : {}),
        ...(raw.tiles && Number.isFinite(raw.tiles.count) ? { tiles: raw.tiles } : {}),
        ...(isAudit(raw.seamAudit?.before) && isAudit(raw.seamAudit?.afterFixed) && isAudit(raw.seamAudit?.after) ? { seamAudit: raw.seamAudit } : {}),
        ms: { load: Number(raw.ms?.load) || 0, weld: Number(raw.ms?.weld) || 0, write: Number(raw.ms?.write) || 0, fixed: Number(raw.ms?.fixed) || 0, adaptive: Number(raw.ms?.adaptive) || 0, fill: Number(raw.ms?.fill) || 0, tone: Number(raw.ms?.tone) || 0 }
    };
}

/**
 * Copies the scan's document extras (its frame: localToEcef, anchor) onto a welded output, which the native writer
 * leaves without them; members the output already has are kept. Without the frame, later stages (tile_vegetation, the
 * site guides) cannot place the welded scan on the earth.
 */
function carryRootExtras(glbPath: string, extras: unknown): void {
    if (!extras || typeof extras !== 'object') return;
    const doc = parseGlb(fs.readFileSync(glbPath));
    const own = doc.json.extras && typeof doc.json.extras === 'object' ? doc.json.extras : {};
    doc.json.extras = { ...(extras as object), ...own };
    fs.writeFileSync(glbPath, serializeGlb(doc));
}

/** The JSON chunk of a binary glTF, read without its binary chunk (a district's textured scan runs to hundreds of MB). */
function readGlbJson(file: string): any {
    const fd = fs.openSync(file, 'r');
    try {
        const head = Buffer.alloc(20);
        fs.readSync(fd, head, 0, 20, 0);
        if (head.toString('utf8', 0, 4) !== 'glTF' || head.toString('utf8', 16, 20) !== 'JSON') throw new TileSeamWeldError('bad_request', `${file} is not a binary glTF`);
        const json = Buffer.alloc(head.readUInt32LE(12));
        fs.readSync(fd, json, 0, json.length, 20);
        return JSON.parse(json.toString('utf8'));
    } finally {
        fs.closeSync(fd);
    }
}

/**
 * Each node's source tile, stated geometric error and box, as the CLI reads them (--tiles): a line with the node count,
 * then "<tile> <errorM>[ <box>]" per node. A node's tile is its leaf (extras.sb.ids.leafId; the crawler writes one node per
 * leaf primitive), else the node itself; its error extras.sb.tile.geometricErrorM, else the fallback, else 0 (none stated);
 * its box extras.sb.tile.box (ECEF) taken into the scan's frame by the document's localToEcef (12 numbers: centre, three
 * half-axes), left out when either is missing.
 */
export function tileSeamTilesFile(json: any, fallbackErrorM?: number): string {
    const nodes: any[] = Array.isArray(json?.nodes) ? json.nodes : [];
    const l2e: unknown = json?.extras?.localToEcef;
    // the frame is a rotation and a translation (column-major): ECEF -> local is R^T (x - t)
    const frame = Array.isArray(l2e) && l2e.length === 16 && l2e.every(Number.isFinite) ? (l2e as number[]) : undefined;
    const toLocal = (v: number[], point: boolean) => {
        const d = point ? [v[0] - frame![12], v[1] - frame![13], v[2] - frame![14]] : v;
        return [0, 1, 2].map(c => frame![c * 4] * d[0] + frame![c * 4 + 1] * d[1] + frame![c * 4 + 2] * d[2]);
    };
    const tileOf = new Map<string, number>();
    const lines = [String(nodes.length)];
    nodes.forEach((n, i) => {
        const sb = n?.extras?.sb;
        const key = typeof sb?.ids?.leafId === 'string' ? `leaf:${sb.ids.leafId}` : `node:${i}`;
        if (!tileOf.has(key)) tileOf.set(key, tileOf.size);
        const stated = Number(sb?.tile?.geometricErrorM);
        const err = Number.isFinite(stated) && stated > 0 ? stated : fallbackErrorM !== undefined && Number.isFinite(fallbackErrorM) && fallbackErrorM > 0 ? fallbackErrorM : 0;
        const box: unknown = sb?.tile?.box;
        const local = frame && Array.isArray(box) && box.length >= 12 && box.slice(0, 12).every(Number.isFinite)
            ? [...toLocal(box.slice(0, 3), true), ...toLocal(box.slice(3, 6), false), ...toLocal(box.slice(6, 9), false), ...toLocal(box.slice(9, 12), false)]
            : undefined;
        lines.push(`${tileOf.get(key)} ${err}${local ? ' ' + local.map(v => v.toFixed(4)).join(' ') : ''}`);
    });
    return lines.join('\n') + '\n';
}

/** Runs the seam weld on a scan. The outputs named in the request are written; the report is returned. */
export async function runTileSeamWeld(req: TileSeamWeldRequest): Promise<TileSeamWeldResult> {
    if (!req.inputGlb || !fs.existsSync(req.inputGlb)) throw new TileSeamWeldError('bad_request', `inputGlb must be an existing file (${req.inputGlb})`);
    const tolerance = req.toleranceM ?? 0.03;
    if (!Number.isFinite(tolerance) || tolerance <= 0 || tolerance > 1) throw new TileSeamWeldError('bad_request', 'toleranceM must be a number of metres in (0, 1]');
    if (req.threads !== undefined && (!Number.isInteger(req.threads) || req.threads < 0 || req.threads > 1024)) throw new TileSeamWeldError('bad_request', 'threads must be an integer in 0..1024');
    if (req.adaptiveCapM !== undefined && (!Number.isFinite(req.adaptiveCapM) || req.adaptiveCapM <= 0 || req.adaptiveCapM > 1)) throw new TileSeamWeldError('bad_request', 'adaptiveCapM must be a number of metres in (0, 1]');
    if (req.maxTurnDeg !== undefined && (!Number.isFinite(req.maxTurnDeg) || req.maxTurnDeg < 0 || req.maxTurnDeg > 180)) throw new TileSeamWeldError('bad_request', 'maxTurnDeg must be a number of degrees in [0, 180]');
    const bin = await ensureTileSeamWeldBinary(req.repoRoot);
    const stem = path.join(path.dirname(req.outputGlb ?? req.outputClayGlb ?? req.inputGlb), `.tile_seam_weld_${process.pid}_${Date.now()}`);
    const statsPath = `${stem}.json`, tilesPath = `${stem}.tiles.txt`;
    const inputJson = readGlbJson(req.inputGlb);
    fs.writeFileSync(tilesPath, tileSeamTilesFile(inputJson, req.defaultGeometricErrorM));
    const args = ['--input', req.inputGlb, '--stats', statsPath, '--tolerance', String(tolerance), '--tiles', tilesPath];
    if (req.outputGlb) args.push('--out', req.outputGlb);
    if (req.outputClayGlb) args.push('--out-clay', req.outputClayGlb);
    if (req.dropSlivers === false) args.push('--no-drop');
    if (req.overlapTrim === false) args.push('--no-overlap-trim');
    if (req.tJunctions === false) args.push('--no-tjunctions');
    if (req.adaptive !== true) args.push('--no-adaptive');
    if (req.stripFill === false) args.push('--no-fill');
    if (req.tone !== true) args.push('--no-tone');
    if (req.caps !== true) args.push('--no-caps');
    if (req.blend !== true) args.push('--no-blend');
    if (req.adaptiveCapM !== undefined) args.push('--adaptive-cap', String(req.adaptiveCapM));
    if (req.maxTurnDeg !== undefined) args.push('--max-turn-deg', String(req.maxTurnDeg));
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
        for (const out of [req.outputGlb, req.outputClayGlb]) if (out) carryRootExtras(out, inputJson.extras);
        return { ...report, binaryPath: bin };
    } finally {
        fs.rmSync(statsPath, { force: true });
        fs.rmSync(tilesPath, { force: true });
    }
}
