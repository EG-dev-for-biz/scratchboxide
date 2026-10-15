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
 *   1. vegetation: tile_vegetation strip measures the tree crowns in the photo tiles and removes them, closing the
 *      ground under them (trees only);
 *   2. remesh: tile_refine (its public refine()) remeshes the devegetated tile (or the raw one without trees);
 *   3. planting: tile_vegetation plant grows one SB-Veggie tree per measured crown (space colonisation) in studio clay,
 *      within a share of the remeshed tile's triangle count; isolate requests plant only crowns that stand on the
 *      isolated structure.
 * The remeshed tile and the trees share the extraction's frame, so both mount at the same origin.
 *
 * Any stage that fails fails the whole request with a TileExtractionError (common/errors/pipeline-errors) naming the
 * stage ('vegetation', 'remesh' or 'planting'); nothing is mounted and nothing is substituted. A tile with no measurable
 * canopy is a valid result with zero trees, and says so. The request's AbortSignal kills a running native stage.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import { TileExtractionError, type TileExtractionStage } from '../../common/errors/pipeline-errors';
import { getTileRefineService, summarizeTileRefineStats, type TileRefineRequest, type TileRefineResult } from './tile-refine-service';
import {
    getTileVegetationService,
    TileVegetationError,
    type TileVegetationPlantRequest,
    type TileVegetationPlantResult,
    type TileVegetationStripRequest,
    type TileVegetationStripResult
} from './tile-vegetation-service';

export interface LocationClayDeps {
    vegetation: { strip(req: TileVegetationStripRequest): Promise<TileVegetationStripResult>; plant(req: TileVegetationPlantRequest): Promise<TileVegetationPlantResult> };
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
    /** Share of the remeshed tile's triangle count all trees together may use (default 0.5). */
    treeTriangleShare?: number;
    /** Total triangles all trees together may use, instead of the share of the remeshed tile (the user's own budget). */
    treeTriangleBudget?: number;
    signal?: AbortSignal;
    reportProgress?: (message: string) => void;
}

export interface LocationClayTrees {
    /** Mounted trees model (absent when no tree was planted). */
    url?: string;
    glbPath?: string;
    /** Crowns measured as trees in the photo tiles, and how many of them were planted. */
    measured: number;
    count: number;
    triangles: number;
    triangleBudget: number;
    /** All vegetation measured in the photo tiles above the canopy height (m²). */
    canopyAreaM2: number;
    /** Crown area of every crown measured as a tree in the photo tiles (m²). */
    measuredTreeCanopyAreaM2: number;
    /** Crown area of the trees actually planted (m²): the measured crowns they were grown into. */
    treeCanopyAreaM2: number;
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
    /** Isolate requests: measured trees that do not stand on the isolated structure. */
    notOnStructure: number;
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
         * planting kept as scanned), it is continued straight down to that ground: area (m²) and tallest (m), by what
         * it continues.
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
    const share = req.treeTriangleShare ?? 0.5;
    if (!(share > 0 && share <= 1)) throw new TileExtractionError('planting', new Error('treeTriangleShare must be in (0, 1]'));
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
                return await d.vegetation.strip({ tilePath: req.rawTilePath, signal: req.signal });
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
        const r = await d.refine.refine({ tilePath: strip ? strip.devegetatedGlb : req.rawTilePath, isolate: req.isolate || undefined, publishAs: base });
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
        const crownsDoc = JSON.parse(fs.readFileSync(strip.crownsJson, 'utf8'));
        const crowns: Array<{ id: number; status: string; areaM2?: number; reachesBoundary?: boolean }> = Array.isArray(crownsDoc.crowns) ? crownsDoc.crowns : [];
        const measuredTrees = crowns.filter(c => c.status === 'tree');
        const count = (s: string) => crowns.filter(c => c.status === s).length;
        const st = strip.stats;
        trees = {
            measured: measuredTrees.length,
            count: 0,
            triangles: 0,
            triangleBudget: 0,
            canopyAreaM2: Number(st.canopyAreaM2 ?? 0),
            measuredTreeCanopyAreaM2: Number(st.treeCanopyAreaM2 ?? 0),
            treeCanopyAreaM2: 0,
            reachingBoundary: 0,
            cutAtBoundary: count('cut_at_boundary'),
            cutRemoved: count('cut_at_boundary_removed'),
            cutCanopyRemovedM2: Number(st.cutCanopyRemovedM2 ?? 0),
            belowMinHeight: count('below_min_height'),
            noMeasuredGround: count('no_measured_ground'),
            notOnStructure: 0,
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
            ms: { strip: timings.vegetation ?? 0, plant: 0 }
        };
        if (measuredTrees.length > 0) {
            req.reportProgress?.(`Growing ${measuredTrees.length} SB-Veggie trees from the measured crowns`);
            const tp = Date.now();
            const planted = await stage('planting', req.signal, async () => {
                let budget: number;
                if (req.treeTriangleBudget !== undefined) budget = Math.floor(req.treeTriangleBudget);
                else if (typeof outputTriangles === 'number' && outputTriangles > 0) budget = Math.floor(outputTriangles * share);
                else throw new Error('the remeshed tile reports no triangle count to size the tree budget from');
                try {
                    return await d.vegetation.plant({
                        crownsPath: strip!.crownsJson,
                        triangleBudget: budget,
                        seed: strip!.tileSha256.slice(0, 16),
                        supportMeshPath: req.isolate ? refined.r.clayGlb : undefined,
                        publishAs: `${base}_trees.glb`,
                        signal: req.signal
                    });
                } catch (err) {
                    if (err instanceof TileVegetationError && err.code === 'budget_too_small') {
                        const whose = req.treeTriangleBudget !== undefined ? 'the treeTriangleBudget asked for' : `half the remeshed tile's ${outputTriangles!.toLocaleString()} triangles`;
                        throw new TileVegetationError(err.code, `${err.message}; the budget was ${whose}. Ask again with treeTriangleBudget set to at least that many triangles, or with trees false.`, err.detail);
                    }
                    throw err;
                }
            });
            timings.planting = Date.now() - tp;
            trees.ms.plant = timings.planting;
            trees.count = Number(planted.stats.trees ?? 0);
            trees.triangles = Number(planted.stats.triangles ?? 0);
            trees.triangleBudget = Number(planted.stats.triangleBudget ?? 0);
            trees.notOnStructure = Array.isArray(planted.stats.skipped) ? planted.stats.skipped.length : 0;
            trees.inferred = planted.stats.inferred ?? {};
            // what the planted trees were grown into: their own measured crowns (an isolate request plants a subset)
            const byId = new Map(crowns.map(c => [c.id, c]));
            for (const t of Array.isArray(planted.stats.perTree) ? planted.stats.perTree : []) {
                const crown = byId.get(Number(t.crownId));
                if (!crown) throw new TileExtractionError('planting', new Error(`the trees model names crown ${t.crownId}, which the measurement does not list`));
                trees.treeCanopyAreaM2 += Number(crown.areaM2 ?? 0);
                if (crown.reachesBoundary) trees.reachingBoundary++;
            }
            if (trees.count > 0) {
                if (!planted.published?.url) throw new TileExtractionError('planting', new Error('the trees model was not published'));
                trees.url = planted.published.url;
                trees.glbPath = planted.treesGlb;
            }
        }
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

/** One or two sentences for a tool summary, so the model tells the user exactly what it got. */
export function describeLocationClay(result: LocationClayResult | undefined, flavour: 'clay' | 'textured'): string {
    if (!result) return ' Returned as raw tiles (not remeshed), as asked.';
    const r = result.remesh;
    const counts = r.inputTriangles !== undefined ? `${r.inputTriangles.toLocaleString()} -> ${result.mounted.triangles.toLocaleString()} triangles` : `${result.mounted.triangles.toLocaleString()} triangles`;
    let s = ` Remeshed${result.isolate ? ' the structure at the anchor' : ''} (${counts}) in ${(r.ms / 1000).toFixed(1)} s${r.cached ? ' (cached)' : ''}; the mounted ${flavour === 'clay' ? 'clay ' : ''}model is ${result.url}.`;
    if (r.binaryWarning) s += ` Note: tile_refine ${r.binaryWarning}.`;
    const t = result.trees;
    if (t) {
        const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
        const kept: string[] = [];
        if (t.cutAtBoundary) kept.push(`${plural(t.cutAtBoundary, 'crown')} cut by the extraction boundary (${t.cutAtBoundary === 1 ? 'its top lies' : 'their tops lie'} outside it)`);
        if (t.belowMinHeight) kept.push(`${plural(t.belowMinHeight, 'low planting')} (under the minimum tree height)`);
        if (t.noMeasuredGround) kept.push(`${plural(t.noMeasuredGround, 'crown')} with no ground measurable around ${t.noMeasuredGround === 1 ? 'it' : 'them'} (no surface gentle enough to stand on, such as a steep slope)`);
        if (t.smallCanopyPatches) kept.push(`${plural(t.smallCanopyPatches, 'canopy patch', 'canopy patches')} too small to measure as a crown`);
        let notes = kept.length ? ` Kept as scanned: ${kept.join(', ')}.` : '';
        if (t.cutRemoved) notes += ` Taken out with the trees ${t.cutRemoved === 1 ? 'it was' : 'they were'} joined to, and not rebuilt (${t.cutRemoved === 1 ? 'its trunk lies' : 'their trunks lie'} outside the extraction): ${plural(t.cutRemoved, 'cut crown')}, ${Math.round(t.cutCanopyRemovedM2)} m² of canopy.`;
        if (t.canopyTakenWithTreesM2 >= 1) notes += ` ${Math.round(t.canopyTakenWithTreesM2)} m² of canopy outside the measured crowns hung on the removed trees and went with them.`;
        notes += describeGroundClosing(t);
        // the trees are measured, and the ground closed, over the whole extraction; an isolated structure is part of it
        if (notes && result.isolate) notes = ` In the extracted district around it:${notes}`;
        if (t.count > 0) {
            s += ` Rebuilt ${plural(t.count, 'measured tree')} as SB-Veggie trees (space colonisation, studio clay) from ${Math.round(t.treeCanopyAreaM2)} m² of measured crown`;
            if (t.reachingBoundary) s += ` (${t.reachingBoundary} of them ${t.reachingBoundary === 1 ? 'runs' : 'run'} to the extraction's edge and ${t.reachingBoundary === 1 ? 'was' : 'were'} rebuilt up to it)`;
            s += `, ${t.triangles.toLocaleString()} triangles within a budget of ${t.triangleBudget.toLocaleString()}; the trees model is ${t.url}.`;
            if (t.notOnStructure) s += ` Left out: ${plural(t.notOnStructure, 'measured tree')} not standing on the isolated structure.`;
        } else if (t.measured > 0 && t.notOnStructure === t.measured) {
            s += ` The photo tiles show ${plural(t.measured, 'measured tree')}, none standing on the isolated structure, so no trees were added to it.`;
        } else if (t.canopyAreaM2 > 0) {
            s += ` The photo tiles show ${Math.round(t.canopyAreaM2)} m² of vegetation but no crown that measures as a tree, so no trees were added.`;
        } else {
            s += ' No tree canopy was measured in the photo tiles, so no trees were added.';
        }
        s += notes;
    }
    return s;
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
        ['onKeptCanopy', 'the sides of plantings kept as scanned were closed down to it'],
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
