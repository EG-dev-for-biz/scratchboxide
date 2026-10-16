/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A real-world location as remeshed studio clay with its trees rebuilt.
 *
 * From the photo-textured extraction (already on disk):
 *   1. vegetation: tile_vegetation strip measures the tree crowns in the photo tiles, regrows each as an SB-Veggie
 *      tree meshed within its own budget, and removes the ones whose delivered leaves fill their measured crown,
 *      closing the ground under them; a tree the regrown tree does not fill stays in the scan as it was
 *      (not_regrowable, with the reason, reported per crown, with the side the removal closed beside it);
 *   2. remesh: tile_refine (its public refine()) remeshes the devegetated tile (or the raw one without trees);
 *   3. planting: tile_vegetation plant grows the same SB-Veggie trees (space colonisation) in studio clay, within the
 *      request's treeTriangleBudget or, without one, each tree's own budget within SCENE_TREE_TRIANGLE_CAP for all of
 *      them; isolate requests plant only crowns that stand on the isolated structure. Every tree's delivered leaves are
 *      measured against its crown and every trunk base against the mounted model: a tree whose leaves do not fill its
 *      crown within its budget, or whose trunk does not meet the mounted ground, is reported by crown, never moved.
 * The remeshed tile and the trees share the extraction's frame, so both mount at the same origin.
 *
 * Any stage that fails fails the whole request with a TileExtractionError (common/errors/pipeline-errors) naming the
 * stage ('vegetation', 'remesh' or 'planting'); nothing is mounted and nothing is substituted. One tree that cannot be
 * regrown faithfully does not fail it: that tree stays as scanned and is reported. A tile with no measurable canopy,
 * or whose trees all stay as scanned, is a valid result that says so. The request's AbortSignal kills a running native
 * stage.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import { TileExtractionError, type TileExtractionStage } from '../../common/errors/pipeline-errors';
import type { StripRoi } from '../../common/spatial/staged-location-contracts';
import { getTileRefineService, summarizeTileRefineStats, type TileRefineRequest, type TileRefineResult } from './tile-refine-service';
import {
    getTileVegetationService,
    SCENE_TREE_TRIANGLE_CAP,
    TileVegetationError,
    type TileVegetationPlantRequest,
    type TileVegetationPlantResult,
    type TileVegetationStripRequest,
    type TileVegetationStripResult
} from './tile-vegetation-service';

export interface LocationClayDeps {
    /** strip takes `roi` where the engine supports it (tile_vegetation --roi-json); without that support it is not sent. */
    vegetation: { strip(req: TileVegetationStripRequest & { roi?: StripRoi }): Promise<TileVegetationStripResult>; plant(req: TileVegetationPlantRequest): Promise<TileVegetationPlantResult> };
    refine: { refine(req: TileRefineRequest): Promise<TileRefineResult> };
}

export interface LocationClayRequest {
    /** The photo-textured extraction GLB (inside the workspace root). */
    rawTilePath: string;
    /** Root every path is confined to; the tile_refine and tile_vegetation services run on it. */
    workspaceRoot: string;
    /** Keep only the structure at the anchor (tile_refine isolate). */
    isolate: boolean;
    /** Rebuild the measured trees (strip before remeshing, plant after). */
    trees: boolean;
    /** Which remeshed model is mounted. */
    flavour: 'clay' | 'textured';
    /** Base name for public/models (any text: it is made into a name tile_refine accepts, see locationPublishBase). */
    publishBase: string;
    /**
     * Total triangles all trees together may use (the user's own budget). Without it the budget comes from the measured
     * trees: a target per tree that grows with its crown, all within SCENE_TREE_TRIANGLE_CAP.
     */
    treeTriangleBudget?: number;
    /**
     * 0 bare .. 1 full summer (default 1): scales the leaf density of the trees at every level of detail (0 gives the
     * wood alone). Trees are written at three levels (near: instanced leaf clusters, mid: fewer larger leaves, far: blob
     * masses) and a viewport draws one per tree by its distance.
     */
    treeSeason?: number;
    /** tile_refine's photometric relief (default on: gated and labelled inferred); false passes --no-relief. */
    relief?: boolean;
    /** Where strip may measure and regrow trees (an isolated structure's outline grown by the crown reach). */
    roi?: StripRoi;
    /** The structure's seed in the tile frame, given to tile_refine as its anchor (isolate). */
    anchor?: { x: number; z: number };
    signal?: AbortSignal;
    reportProgress?: (message: string) => void;
}

/** A measured tree left in the scan as it was, because the regrown SB-Veggie tree does not fill its crown. */
export interface KeptAsScannedTree {
    crownId: number;
    /** Diagnostic label (an open string, e.g. crown_not_reached); nothing branches on it. */
    reasonCode: string;
    reason: string;
    /** How growing it went (attractors reached, iterations, why colonisation stopped). */
    colonisation?: string;
    areaM2: number;
    heightM: number;
    /**
     * Where trees beside it were removed, its side over their rebuilt ground was closed straight down to it: a clay wall
     * that is not in the scan (area, and the heights it spans).
     */
    closedSide?: { areaM2: number; topY: number; bottomY: number };
}

/** A rebuilt tree whose delivered leaves do not fill its measured crown within the budget it was given. */
export interface TreeShortOfCrown {
    crownId: number;
    /** Share of its measured crown surface its leaf masses reach. */
    crownSurfaceReached: number;
    budget: number;
    reason: string;
}

/** A rebuilt tree whose trunk base is not on the mounted model at its stem (beyond the tolerance). */
export interface TreeOffGround {
    crownId: number;
    /** Trunk base minus the nearest mounted surface at its stem (m): above it when positive; null when none is there. */
    gapM: number | null;
}

export interface LocationClayTrees {
    /** Mounted trees model (absent when no tree was planted). */
    url?: string;
    glbPath?: string;
    /** Crowns measured as trees in the photo tiles (rebuilt or left as scanned), and how many of them were planted. */
    measured: number;
    count: number;
    /** Measured trees left as scanned because the regrown tree does not fill their crown, each with its reason. */
    notRegrowable: number;
    keptAsScanned: KeptAsScannedTree[];
    /** Rebuilt trees whose delivered leaves do not fill their measured crown within their budget, each with why. */
    shortOfCrown: TreeShortOfCrown[];
    /** Rebuilt trees whose trunk base is more than groundToleranceM from the mounted model at its stem. */
    offGround: TreeOffGround[];
    groundToleranceM?: number;
    /** Lowest share of its measured crown surface a rebuilt tree's delivered leaves reach. */
    lowestCrownSurfaceReached?: number;
    /**
     * "N of M trees rebuilt as SB-Veggie; K left as scanned: <reasons>", then any rebuilt tree that falls short of its
     * crown or of the mounted ground, by crown (the summary says it too).
     */
    outcome: string;
    triangles: number;
    triangleBudget: number;
    /** Where the budget came from: the request's treeTriangleBudget, or the measured crowns' targets (within the cap). */
    triangleBudgetSource?: string;
    /** The triangles the measured crowns' sizes ask for together, and the scene's cap on trees (when it applied). */
    targetTriangles?: number;
    sceneTriangleCap?: number;
    /** What a viewport draws of the trees in a park view (camera poses on a grid, an 80 degree view), from the written trees: stats.lodFrames. */
    drawnPerFrame?: { medianTriangles: number; p95Triangles: number; maxTriangles: number; poses: number };
    /** Triangles the three levels draw when every tree is at that level, and the leaves' season (0 bare .. 1). */
    levelTriangles?: { level0: number; level1: number; level2: number };
    psiSeason?: number;
    /** All vegetation measured in the photo tiles above the canopy height (m²). */
    canopyAreaM2: number;
    /** Crown area of every crown measured as a tree in the photo tiles (m²). */
    measuredTreeCanopyAreaM2: number;
    /** Crown area of the trees actually planted (m²): the measured crowns they were grown into. */
    treeCanopyAreaM2: number;
    /** ... of those whose delivered leaves fill their crown (m²). */
    filledCanopyAreaM2: number;
    /** Planted trees whose crown runs to the extraction's edge: measured and rebuilt up to it (their tops are inside). */
    reachingBoundary: number;
    /** Crowns cut by the extraction's edge (their tops lie outside it), joined to nothing removed: kept as scanned. */
    cutAtBoundary: number;
    /** Cut crowns joined to a removed tree: taken with it (not replanted, their trunks lie outside the extraction). */
    cutRemoved: number;
    cutCanopyRemovedM2: number;
    /** Roof or ground vegetation lower than the minimum tree height: kept as scanned. */
    belowMinHeight: number;
    /** Crowns with no standable surface around them (ground too steep, or all canopy): their ground is not measured, so they are kept as scanned. */
    noMeasuredGround: number;
    /** ... of them, crowns hanging below the surface measured around them with nothing standable under their stem. */
    hangingBelowSupport: number;
    /**
     * Trees standing on what the scan has under their stem, not on the level surfaces measured around them (canopy tops:
     * their crown hung below them, or nothing standable lay between the crown and the ground).
     */
    supportedUnderStem: number;
    /** Isolate requests: measured trees that do not stand on the isolated structure. */
    notOnStructure: number;
    /** An isolate request: measured, counts and kept trees are those standing on the isolated structure. */
    onIsolatedStructure: boolean;
    /** Canopy patches smaller than a crown can be measured from: they stay as scanned unless they hung on a removed tree. */
    smallCanopyPatches: number;
    /** Canopy outside the measured crowns that went with the trees it hung on (not replanted). */
    canopyTakenWithTreesM2: number;
    crownsJson: string;
    /** Not observed by a scan, so set by ratios and reported as inferred. */
    inferred: Record<string, number>;
    strip: {
        removedTriangles?: number;
        capTriangles?: number;
        skirtTriangles?: number;
        openEdges?: { before: number; after: number };
        /**
         * Where the removal left something standing over the rebuilt ground (a wall the tree hid, the side of a low
         * planting or a tree kept as scanned), it is continued straight down to that ground: area (m²) and tallest (m),
         * by what it continues.
         */
        skirtAreaM2?: Record<string, number>;
        skirtMaxHeightM?: Record<string, number>;
        /** Largest height difference across one cap face (m). */
        capMaxRiseM?: number;
    };
    ms: { strip: number; plant: number };
}

export interface LocationClayResult {
    url: string;
    glbPath: string;
    isolate: boolean;
    /** The mounted remeshed model as written (read from its GLB). */
    mounted: GlbMeshCounts;
    remesh: { publishAs: string; triangles?: number; inputTriangles?: number; ms: number; cached: boolean; stats: Record<string, unknown>; binaryWarning?: string };
    trees?: LocationClayTrees;
    timingsMs: { vegetation?: number; remesh: number; planting?: number; total: number };
}

/** tile_refine's rule for a publish base name: [A-Za-z0-9_-], starting with a letter or digit, at most 64 characters. */
const PUBLISH_BASE_MAX = 64;

/**
 * The public/models base name for a location's remeshed models: the extraction's own base name plus what was done
 * (_isolated, _sbveggie), kept within tile_refine's naming rule. A name that had to change (other characters, such as
 * the '.' of a lat/lng, or too long) keeps a readable prefix and gains a short hash of the original, so distinct
 * extractions never share a published name.
 */
export function locationPublishBase(extractionBase: string, isolate: boolean, trees: boolean): string {
    const suffix = `${isolate ? '_isolated' : ''}${trees ? '_sbveggie' : ''}`;
    const cleaned = extractionBase.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/_{2,}/g, '_').replace(/^[^A-Za-z0-9]+/, '').replace(/[_-]+$/, '');
    const room = PUBLISH_BASE_MAX - suffix.length;
    if (cleaned && cleaned === extractionBase && cleaned.length <= room) return cleaned + suffix;
    const hash = crypto.createHash('sha256').update(extractionBase).digest('hex').slice(0, 8);
    const prefix = cleaned.slice(0, room - hash.length - 1).replace(/[_-]+$/, '');
    return `${prefix || 'location'}_${hash}${suffix}`;
}

export interface GlbMeshCounts { vertices: number; triangles: number }

/** Vertex and triangle counts of a GLB as written (its accessors), without reading the binary chunk. */
export function glbMeshCounts(file: string): GlbMeshCounts {
    const fd = fs.openSync(file, 'r');
    try {
        const head = Buffer.alloc(20);
        if (fs.readSync(fd, head, 0, 20, 0) !== 20 || head.toString('latin1', 0, 4) !== 'glTF') throw new Error(`${file} is not a binary glTF`);
        const jsonLength = head.readUInt32LE(12);
        const text = Buffer.alloc(jsonLength);
        fs.readSync(fd, text, 0, jsonLength, 20);
        const json = JSON.parse(text.toString('utf8'));
        let vertices = 0, triangles = 0;
        for (const mesh of json.meshes ?? []) {
            for (const prim of mesh.primitives ?? []) {
                if ((prim.mode ?? 4) !== 4) continue;
                const count = json.accessors?.[prim.attributes?.POSITION]?.count ?? 0;
                vertices += count;
                triangles += Math.floor((prim.indices !== undefined ? json.accessors?.[prim.indices]?.count ?? 0 : count) / 3);
            }
        }
        return { vertices, triangles };
    } finally {
        fs.closeSync(fd);
    }
}

function checkAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) throw Object.assign(new Error('Stopped by the chat before it finished'), { name: 'AbortError' });
}

async function stage<T>(name: TileExtractionStage, signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
    checkAborted(signal);
    try {
        return await run();
    } catch (err) {
        if ((err as Error)?.name === 'AbortError') throw err;
        throw new TileExtractionError(name, err);
    }
}

export async function runLocationClayPipeline(req: LocationClayRequest, deps?: LocationClayDeps): Promise<LocationClayResult> {
    const t0 = Date.now();
    const d: LocationClayDeps = deps ?? { vegetation: getTileVegetationService(req.workspaceRoot), refine: getTileRefineService(req.workspaceRoot) };
    if (req.treeTriangleBudget !== undefined && !(Number.isFinite(req.treeTriangleBudget) && req.treeTriangleBudget >= 1)) {
        throw new TileExtractionError('planting', new Error('treeTriangleBudget must be a number of triangles of at least 1'));
    }
    const timings: LocationClayResult['timingsMs'] = { remesh: 0, total: 0 };

    let strip: TileVegetationStripResult | undefined;
    if (req.trees) {
        req.reportProgress?.('Measuring the trees in the photo tiles');
        const ts = Date.now();
        strip = await stage('vegetation', req.signal, async () => {
            try {
                return await d.vegetation.strip({ tilePath: req.rawTilePath, signal: req.signal, ...(req.roi ? { roi: req.roi } : {}) });
            } catch (err) {
                if (err instanceof TileVegetationError) {
                    throw new TileVegetationError(err.code, `${err.message}. The trees could not be measured, so nothing was remeshed or mounted; ask again with trees false for the remeshed tiles without rebuilt trees.`, err.detail);
                }
                throw err;
            }
        });
        timings.vegetation = Date.now() - ts;
    }

    req.reportProgress?.(req.isolate ? 'Remeshing the structure at the anchor' : 'Remeshing the district geometry');
    const tr = Date.now();
    const base = locationPublishBase(req.publishBase, req.isolate, req.trees);
    const refined = await stage('remesh', req.signal, async () => {
        const r = await d.refine.refine({
            tilePath: strip ? strip.devegetatedGlb : req.rawTilePath, isolate: req.isolate || undefined, publishAs: base,
            ...(req.relief === false ? { relief: false } : {}), ...(req.anchor ? { anchor: req.anchor } : {})
        });
        const url = req.flavour === 'clay' ? r.published?.urls.clay : r.published?.urls.textured;
        if (!url) throw new Error('tile_refine did not publish a model');
        const file = req.flavour === 'clay' ? r.clayGlb : r.texturedGlb;
        return { r, url, file, mounted: glbMeshCounts(file) };
    });
    timings.remesh = Date.now() - tr;
    const remeshedPath = refined.file;
    const outputTriangles = refined.r.stats?.outputs?.triangles;
    // tile_refine reports its input as { input, hidden, droppedDegenerate, kept }
    const refineInput = refined.r.stats?.triangles;
    const inputTriangles = typeof refineInput === 'number' ? refineInput : typeof refineInput?.input === 'number' ? refineInput.input : undefined;

    let trees: LocationClayTrees | undefined;
    if (strip) {
        const crowns = readCrowns(strip.crownsJson);
        const measuredTrees = crowns.filter(c => c.status === 'tree');
        const kept = crowns.filter(c => c.status === 'not_regrowable');
        let planted: TileVegetationPlantResult | undefined;
        // an isolate request with trees kept as scanned asks plant which of them stand on the structure, even with no
        // tree to plant
        if (measuredTrees.length > 0 || (req.isolate && kept.length > 0)) {
            if (measuredTrees.length > 0) req.reportProgress?.(`Growing ${measuredTrees.length} SB-Veggie trees from the measured crowns`);
            const tp = Date.now();
            planted = await stage('planting', req.signal, () => plantTrees(d, strip!, {
                treeTriangleBudget: req.treeTriangleBudget,
                treeSeason: req.treeSeason,
                supportMeshPath: req.isolate ? refined.r.clayGlb : undefined,
                groundMeshPath: refined.file,
                publishAs: measuredTrees.length > 0 ? `${base}_trees.glb` : undefined,
                signal: req.signal
            }));
            timings.planting = Date.now() - tp;
        }
        trees = summarizeTrees(strip, planted, { isolate: req.isolate, stripMs: timings.vegetation ?? 0, plantMs: timings.planting ?? 0, treeTriangleBudget: req.treeTriangleBudget });
    }

    timings.total = Date.now() - t0;
    return {
        url: refined.url,
        glbPath: remeshedPath,
        isolate: req.isolate,
        mounted: refined.mounted,
        remesh: {
            publishAs: base,
            triangles: outputTriangles,
            inputTriangles,
            ms: refined.r.ms,
            cached: refined.r.cached,
            stats: summarizeTileRefineStats(refined.r.stats ?? {}),
            ...(refined.r.binary?.warning ? { binaryWarning: refined.r.binary.warning } : {})
        },
        ...(trees ? { trees } : {}),
        timingsMs: timings
    };
}

interface CrownRecord {
    id: number; status: string; areaM2?: number; reachesBoundary?: boolean; apexAboveSupport?: number;
    regrowth?: { reason?: string; reasonCode?: string; colonisation?: string }; keptSkirt?: { areaM2: number; topY: number; bottomY: number };
}

function readCrowns(crownsJson: string): CrownRecord[] {
    const doc = JSON.parse(fs.readFileSync(crownsJson, 'utf8'));
    return Array.isArray(doc.crowns) ? doc.crowns : [];
}

/**
 * plant with the budget rule (the user's own treeTriangleBudget, or one sized from the measured trees within the
 * scene's cap) and the strip's seed; a budget too small says how to ask again.
 */
export async function plantTrees(
    d: Pick<LocationClayDeps, 'vegetation'>,
    strip: TileVegetationStripResult,
    opts: { treeTriangleBudget?: number; treeSeason?: number; supportMeshPath?: string; groundMeshPath?: string; publishAs?: string; signal?: AbortSignal }
): Promise<TileVegetationPlantResult> {
    // never from the buildings: a park has many trees and few triangles of building
    const budget = opts.treeTriangleBudget !== undefined ? { triangleBudget: Math.floor(opts.treeTriangleBudget) } : { sceneTriangleCap: SCENE_TREE_TRIANGLE_CAP };
    try {
        return await d.vegetation.plant({
            crownsPath: strip.crownsJson,
            ...budget,
            // the seed the strip regrew the trees with to decide which to remove (its default)
            seed: strip.tileSha256.slice(0, 16),
            supportMeshPath: opts.supportMeshPath,
            // every trunk base is measured against the model the trees are mounted on
            groundMeshPath: opts.groundMeshPath,
            publishAs: opts.publishAs,
            ...(opts.treeSeason !== undefined ? { params: { psiSeason: opts.treeSeason } } : {}),
            signal: opts.signal
        });
    } catch (err) {
        if (err instanceof TileVegetationError && err.code === 'budget_too_small') {
            if (opts.treeTriangleBudget !== undefined) {
                throw new TileVegetationError(err.code, `${err.message}; the budget was the treeTriangleBudget asked for. Ask again with treeTriangleBudget set to at least that many triangles, or with trees false.`, err.detail);
            }
            throw new TileVegetationError(err.code, `${err.message}. Ask again with a smaller radiusMeters (fewer trees), or with treeTriangleBudget set to at least that many triangles to go over the cap, or with trees false.`, err.detail);
        }
        throw err;
    }
}

/**
 * The trees of a location, from strip's measurement and, when trees were planted, plant's stats: what was measured,
 * rebuilt, kept as scanned (each with why), short of its crown or off the mounted ground, and what closing the ground
 * added. `url` is where the trees model is served (plant's own publish by default).
 */
export function summarizeTrees(
    strip: TileVegetationStripResult,
    planted: TileVegetationPlantResult | undefined,
    opts: { isolate: boolean; stripMs: number; plantMs?: number; treeTriangleBudget?: number; url?: string }
): LocationClayTrees {
    const crowns = readCrowns(strip.crownsJson);
    const measuredTrees = crowns.filter(c => c.status === 'tree');
    const count = (s: string) => crowns.filter(c => c.status === s).length;
    const st = strip.stats;
    // trees the regrown SB-Veggie tree does not fill: the strip left them in the scan, each with its reason
    const keptAsScanned: KeptAsScannedTree[] = crowns.filter(c => c.status === 'not_regrowable').map(c => {
        if (!c.regrowth?.reason) throw new TileExtractionError('vegetation', new Error(`crown ${c.id} was kept as scanned without a reason`));
        return {
            crownId: c.id, reasonCode: String(c.regrowth.reasonCode ?? ''), reason: c.regrowth.reason,
            ...(c.regrowth.colonisation ? { colonisation: String(c.regrowth.colonisation) } : {}),
            areaM2: Number(c.areaM2 ?? 0), heightM: Number(c.apexAboveSupport ?? 0),
            ...(c.keptSkirt && c.keptSkirt.areaM2 > 0 ? { closedSide: { areaM2: Number(c.keptSkirt.areaM2), topY: Number(c.keptSkirt.topY), bottomY: Number(c.keptSkirt.bottomY) } } : {})
        };
    });
    const trees: LocationClayTrees = {
        measured: measuredTrees.length + keptAsScanned.length,
        count: 0,
        notRegrowable: keptAsScanned.length,
        keptAsScanned,
        shortOfCrown: [],
        offGround: [],
        outcome: '',
        triangles: 0,
        triangleBudget: 0,
        canopyAreaM2: Number(st.canopyAreaM2 ?? 0),
        measuredTreeCanopyAreaM2: Number(st.treeCanopyAreaM2 ?? 0),
        treeCanopyAreaM2: 0,
        filledCanopyAreaM2: 0,
        reachingBoundary: 0,
        cutAtBoundary: count('cut_at_boundary'),
        cutRemoved: count('cut_at_boundary_removed'),
        cutCanopyRemovedM2: Number(st.cutCanopyRemovedM2 ?? 0),
        belowMinHeight: count('below_min_height'),
        noMeasuredGround: count('no_measured_ground'),
        hangingBelowSupport: Number(st.crowns?.hangingBelowSupport ?? 0),
        supportedUnderStem: Number(st.crowns?.supportedUnderStem ?? 0),
        notOnStructure: 0,
        onIsolatedStructure: opts.isolate,
        smallCanopyPatches: Number(st.crowns?.tooSmall ?? 0),
        canopyTakenWithTreesM2: Number(st.drape?.canopyTakenWithTreesM2 ?? 0),
        crownsJson: strip.crownsJson,
        inferred: {},
        strip: {
            removedTriangles: st.triangles?.removed,
            capTriangles: st.triangles?.cap,
            skirtTriangles: st.triangles?.skirt,
            openEdges: st.openEdges,
            skirtAreaM2: st.skirts?.areaM2,
            skirtMaxHeightM: st.skirts?.maxHeightByHangM,
            capMaxRiseM: st.holes?.capMaxRiseM
        },
        ms: { strip: opts.stripMs, plant: opts.plantMs ?? 0 }
    };
    if (planted) {
        trees.count = Number(planted.stats.trees ?? 0);
        trees.triangles = Number(planted.stats.triangles ?? 0);
        trees.triangleBudget = Number(planted.stats.triangleBudget ?? 0);
        if (typeof planted.stats.triangleBudgetSource === 'string') trees.triangleBudgetSource = planted.stats.triangleBudgetSource;
        if (typeof planted.stats.targetTriangles === 'number') trees.targetTriangles = planted.stats.targetTriangles;
        if (planted.stats.lodFrames) {
            const f = planted.stats.lodFrames;
            trees.drawnPerFrame = { medianTriangles: Number(f.median), p95Triangles: Number(f.p95), maxTriangles: Number(f.max), poses: Number(f.poses) };
            trees.levelTriangles = { level0: Number(f.allLevel0), level1: Number(f.allLevel1), level2: Number(f.allLevel2) };
            if (typeof planted.stats.psiSeason === 'number') trees.psiSeason = planted.stats.psiSeason;
        }
        if (opts.treeTriangleBudget === undefined) trees.sceneTriangleCap = SCENE_TREE_TRIANGLE_CAP;
        trees.notOnStructure = Array.isArray(planted.stats.skipped) ? planted.stats.skipped.length : 0;
        if (opts.isolate) {
            // an isolated structure: the trees kept as scanned it names are those standing on it; the others stand
            // elsewhere in the extracted district, as the trees not planted on it do
            const keptOff = new Set<number>((Array.isArray(planted.stats.keptNotOnSupportMesh) ? planted.stats.keptNotOnSupportMesh : []).map(Number));
            trees.keptAsScanned = trees.keptAsScanned.filter(k => !keptOff.has(k.crownId));
            trees.notRegrowable = trees.keptAsScanned.length;
            trees.notOnStructure += keptOff.size;
            trees.measured -= trees.notOnStructure;
        }
        trees.inferred = planted.stats.inferred ?? {};
        trees.shortOfCrown = (Array.isArray(planted.stats.shortOfCrown) ? planted.stats.shortOfCrown : []).map((t: any) => ({
            crownId: Number(t.crownId), crownSurfaceReached: Number(t.crownSurfaceReached), budget: Number(t.budget), reason: String(t.reason)
        }));
        trees.groundToleranceM = typeof planted.stats.groundTolerance === 'number' ? planted.stats.groundTolerance : undefined;
        trees.offGround = (Array.isArray(planted.stats.offGround) ? planted.stats.offGround : []).map((t: any) => ({
            crownId: Number(t.crownId), gapM: typeof t.gapM === 'number' ? t.gapM : null
        }));
        // what the planted trees were grown into: their own measured crowns (an isolate request plants a subset)
        const byId = new Map(crowns.map(c => [c.id, c]));
        const short = new Set(trees.shortOfCrown.map(t => t.crownId));
        for (const t of Array.isArray(planted.stats.perTree) ? planted.stats.perTree : []) {
            const crown = byId.get(Number(t.crownId));
            if (!crown) throw new TileExtractionError('planting', new Error(`the trees model names crown ${t.crownId}, which the measurement does not list`));
            trees.treeCanopyAreaM2 += Number(crown.areaM2 ?? 0);
            if (!short.has(Number(t.crownId))) trees.filledCanopyAreaM2 += Number(crown.areaM2 ?? 0);
            if (crown.reachesBoundary) trees.reachingBoundary++;
            const reached = Number(t.crownSurfaceReached);
            if (Number.isFinite(reached)) trees.lowestCrownSurfaceReached = Math.min(trees.lowestCrownSurfaceReached ?? 1, reached);
        }
        if (trees.count > 0) {
            const url = opts.url ?? planted.published?.url;
            if (!url) throw new TileExtractionError('planting', new Error('the trees model was not published'));
            trees.url = url;
            trees.glbPath = planted.treesGlb;
        }
    }
    trees.outcome = describeTreeOutcome(trees);
    return trees;
}

/** One or two sentences for a tool summary, so the model tells the user exactly what it got. */
export function describeLocationClay(result: LocationClayResult | undefined, flavour: 'clay' | 'textured'): string {
    if (!result) return ' Returned as raw tiles (not remeshed), as asked.';
    const r = result.remesh;
    const counts = r.inputTriangles !== undefined ? `${r.inputTriangles.toLocaleString()} -> ${result.mounted.triangles.toLocaleString()} triangles` : `${result.mounted.triangles.toLocaleString()} triangles`;
    let s = ` Remeshed${result.isolate ? ' the structure at the anchor' : ''} (${counts}) in ${(r.ms / 1000).toFixed(1)} s${r.cached ? ' (cached)' : ''}; the mounted ${flavour === 'clay' ? 'clay ' : ''}model is ${result.url}.`;
    if (r.binaryWarning) s += ` Note: tile_refine ${r.binaryWarning}.`;
    const t = result.trees;
    if (t) s += describeTrees(t, result.isolate);
    return s;
}

/**
 * What the trees stage did, in sentences for a tool summary: the outcome (rebuilt, kept as scanned, with why), the budget,
 * the crowns kept as scanned and taken out, and what closing the ground under the removed trees added (not in the
 * scan). Leads with a space. `isolate`: the structure at the anchor was asked for alone.
 */
export function describeTrees(t: LocationClayTrees, isolate: boolean): string {
    let s = '';
    const kept: string[] = [];
    if (t.cutAtBoundary) kept.push(`${plural(t.cutAtBoundary, 'crown')} cut by the extraction boundary (${t.cutAtBoundary === 1 ? 'its top lies' : 'their tops lie'} outside it)`);
    if (t.belowMinHeight) kept.push(`${plural(t.belowMinHeight, 'low planting')} (under the minimum tree height)`);
    if (t.noMeasuredGround) {
        const hanging = Math.min(t.hangingBelowSupport ?? 0, t.noMeasuredGround), flat = t.noMeasuredGround - hanging;
        const them = (n: number) => (n === 1 ? 'it' : 'them');
        if (!hanging) {
            kept.push(`${plural(t.noMeasuredGround, 'crown')} with no ground measurable around ${them(t.noMeasuredGround)} (no surface gentle enough to stand on, such as a steep slope)`);
        } else {
            const why = [`${hanging.toLocaleString()} hanging below the level surfaces measured around ${them(hanging)} (canopy tops, not ground) with nothing standable under ${hanging === 1 ? 'its stem' : 'their stems'}`];
            if (flat) why.unshift(`${flat.toLocaleString()} with no surface gentle enough to stand on around ${them(flat)}, such as a steep slope`);
            kept.push(`${plural(t.noMeasuredGround, 'crown')} with no ground measurable for ${them(t.noMeasuredGround)}: ${why.join('; ')}`);
        }
    }
    if (t.smallCanopyPatches) kept.push(`${plural(t.smallCanopyPatches, 'canopy patch', 'canopy patches')} too small to measure as a crown`);
    let notes = kept.length ? ` Kept as scanned: ${kept.join(', ')}.` : '';
    if (t.supportedUnderStem) {
        const one = t.supportedUnderStem === 1;
        notes += ` ${plural(t.supportedUnderStem, 'crown')} ${one ? 'stands' : 'stand'} on the ground the scan has under ${one ? 'its stem' : 'their stems'}, not on the level surfaces measured around ${one ? 'it' : 'them'}: those were canopy tops (${one ? 'its crown hung' : 'their crowns hung'} below them, or nothing standable lay between ${one ? 'it' : 'them'} and the ground).`;
    }
    if (t.cutRemoved) notes += ` Taken out with the trees ${t.cutRemoved === 1 ? 'it was' : 'they were'} joined to, and not rebuilt (${t.cutRemoved === 1 ? 'its trunk lies' : 'their trunks lie'} outside the extraction): ${plural(t.cutRemoved, 'cut crown')}, ${Math.round(t.cutCanopyRemovedM2)} m² of canopy.`;
    if (t.canopyTakenWithTreesM2 >= 1) notes += ` ${Math.round(t.canopyTakenWithTreesM2)} m² of canopy outside the measured crowns hung on the removed trees and went with them.`;
    notes += describeGroundClosing(t);
    // the trees are measured, and the ground closed, over the whole extraction; an isolated structure is part of it
    if (notes && isolate) notes = ` In the extracted district around it:${notes}`;
    if (t.measured > 0) s += ` ${t.outcome || describeTreeOutcome(t)}.`;
    if (t.count > 0) {
        s += t.shortOfCrown?.length
            ? ` The rebuilt trees (space colonisation, studio clay) are grown into ${Math.round(t.treeCanopyAreaM2)} m² of measured crown, ${Math.round(t.filledCanopyAreaM2)} m² of it by trees whose leaves fill their crown`
            : ` The rebuilt trees (space colonisation, studio clay) fill ${Math.round(t.treeCanopyAreaM2)} m² of measured crown`;
        if (t.reachingBoundary) s += ` (${t.reachingBoundary} of them ${t.reachingBoundary === 1 ? 'runs' : 'run'} to the extraction's edge and ${t.reachingBoundary === 1 ? 'was' : 'were'} rebuilt up to it)`;
        s += `, ${t.triangles.toLocaleString()} triangles within a budget of ${t.triangleBudget.toLocaleString()}${describeTreeBudget(t)}; the trees model is ${t.url}.`;
    } else if (t.measured === 0 && t.notOnStructure > 0) {
        s += ` The photo tiles show ${plural(t.notOnStructure, 'measured tree')} in the extracted district, none standing on the isolated structure, so no trees were added to it.`;
    } else if (t.measured > 0) {
        s += ' No trees model was added.';
    } else if (t.canopyAreaM2 > 0) {
        s += ` The photo tiles show ${Math.round(t.canopyAreaM2)} m² of vegetation but no crown that measures as a tree, so no trees were added.`;
    } else {
        s += ' No tree canopy was measured in the photo tiles, so no trees were added.';
    }
    s += notes;
    return s;
}

function plural(n: number, one: string, many = `${one}s`): string {
    return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/** Crown ids beyond the first `shown`, as "; and N more (crowns a, b, ...)". */
function andMore(ids: number[], shown: number): string {
    return ids.length > shown ? `; and ${(ids.length - shown).toLocaleString()} more (crowns ${ids.slice(shown).join(', ')})` : '';
}

/**
 * "N of M trees rebuilt as SB-Veggie; K left as scanned: <reasons>": M counts every crown measured as a tree (on the
 * isolated structure, for an isolate request), N the trees planted, K the trees left in the scan because the regrown
 * tree does not fill their crown (each named, with why, and the side the removal beside it closed). Then, by crown, any
 * rebuilt tree whose leaves do not fill its crown within its budget, and any whose trunk does not meet the mounted
 * ground. A scanned tree is never counted as rebuilt.
 */
export function describeTreeOutcome(t: Pick<LocationClayTrees, 'count' | 'measured' | 'keptAsScanned'> & Partial<Pick<LocationClayTrees, 'shortOfCrown' | 'offGround' | 'groundToleranceM' | 'notOnStructure' | 'onIsolatedStructure'>>): string {
    const SHOWN = 5;
    const kept = t.keptAsScanned ?? [];
    if (t.onIsolatedStructure && t.measured === 0 && t.notOnStructure) {
        return t.notOnStructure === 1
            ? 'the 1 measured tree in the extracted district does not stand on the isolated structure, so no tree was added to it'
            : `none of the ${t.notOnStructure.toLocaleString()} measured trees in the extracted district stands on the isolated structure, so no trees were added to it`;
    }
    let s = `${t.count.toLocaleString()} of ${t.measured.toLocaleString()} trees${t.onIsolatedStructure ? ' on the isolated structure' : ''} rebuilt as SB-Veggie; ${kept.length.toLocaleString()} left as scanned`;
    if (kept.length) {
        const named = kept.slice(0, SHOWN).map(k => {
            let one = `crown ${k.crownId} (${Math.round(k.areaM2).toLocaleString()} m², ${k.heightM.toFixed(1)} m tall), ${k.reason}`;
            if (k.closedSide) {
                one += `; where the trees beside it were taken out, its side was closed down to their ground with ${Math.round(k.closedSide.areaM2).toLocaleString()} m² of clay wall from ${k.closedSide.topY.toFixed(1)} m down to ${k.closedSide.bottomY.toFixed(1)} m (not in the scan)`;
            }
            return one;
        });
        s += `: ${named.join('; ')}${andMore(kept.map(k => k.crownId), SHOWN)}`;
    }
    if (t.onIsolatedStructure && t.notOnStructure) s += `; ${plural(t.notOnStructure, 'measured tree')} in the extracted district ${t.notOnStructure === 1 ? 'does' : 'do'} not stand on it`;
    const short = t.shortOfCrown ?? [];
    if (short.length) {
        s += `; ${plural(short.length, 'rebuilt tree')} ${short.length === 1 ? 'does' : 'do'} not fill ${short.length === 1 ? 'its' : 'their'} measured crown within ${short.length === 1 ? 'its' : 'their'} budget: `
            + short.slice(0, SHOWN).map(k => `crown ${k.crownId}, ${k.reason}`).join('; ') + andMore(short.map(k => k.crownId), SHOWN);
    }
    const off = t.offGround ?? [];
    if (off.length) {
        const tol = t.groundToleranceM ?? 0.5;
        const worst = [...off].sort((a, b) => (b.gapM === null ? Infinity : Math.abs(b.gapM)) - (a.gapM === null ? Infinity : Math.abs(a.gapM)));
        s += `; ${plural(off.length, 'rebuilt tree')} ${off.length === 1 ? 'stands' : 'stand'} more than ${tol} m off the mounted model at ${off.length === 1 ? 'its trunk base' : 'their trunk bases'}, measured under each stem: `
            + worst.slice(0, SHOWN).map(k => `crown ${k.crownId} (${k.gapM === null ? 'no mounted surface under its stem' : k.gapM > 0 ? `${k.gapM.toFixed(1)} m above it` : `${(-k.gapM).toFixed(1)} m under it`})`).join(', ')
            + andMore(worst.map(k => k.crownId), SHOWN);
    }
    return s;
}

/** Where the trees' triangle budget came from, when it was not the user's own. */
function describeTreeBudget(t: LocationClayTrees): string {
    if (t.sceneTriangleCap === undefined || t.targetTriangles === undefined) return '';
    return t.targetTriangles > t.sceneTriangleCap
        ? ` (sized from the measured crowns, which ask for ${t.targetTriangles.toLocaleString()}; held to the cap of ${t.sceneTriangleCap.toLocaleString()} triangles for the trees of a scene)`
        : ' (sized from the measured crowns)';
}

/**
 * What closing the ground under the removed trees added: the ground itself is rebuilt on the surface the trees stood
 * on; where a wall or the side of something kept stood over it, that surface was continued straight down to it.
 */
function describeGroundClosing(t: LocationClayTrees): string {
    const area = t.strip.skirtAreaM2 ?? {};
    const tallest = t.strip.skirtMaxHeightM ?? {};
    // Each kind of surface the closing hung a skirt on is named for what it is: only skirts on walls are walls.
    const kinds: Array<[keyof typeof area, string]> = [
        ['onWalls', 'walls and building sides the trees hid were continued straight down to that ground'],
        ['onLevelSurfaces', 'the edges of level surfaces left standing over it were closed down to it'],
        ['onKeptCanopy', 'the sides of plantings and trees kept as scanned were closed down to it'],
        ['onOther', 'the edges of other surfaces left standing over it were closed down to it']
    ];
    const parts: string[] = [];
    for (const [key, what] of kinds) {
        const m2 = Number(area[key] ?? 0);
        if (m2 >= 1) parts.push(`${what} (${Math.round(m2).toLocaleString()} m², up to ${Number(tallest[key] ?? 0).toFixed(1)} m tall; not in the scan)`);
    }
    if (!(t.strip.removedTriangles! > 0)) return '';
    return ` Where trees were taken out, the ground was rebuilt on the surface they stood on${parts.length ? `; ${parts.join('; ')}` : ''}.`;
}
