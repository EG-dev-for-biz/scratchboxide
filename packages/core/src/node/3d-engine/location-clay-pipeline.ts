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
 * Any stage that fails fails the whole request with a TileExtractionError naming the stage; nothing is mounted and
 * nothing is substituted. A tile with no measurable canopy is a valid result with zero trees, and says so.
 */

import * as fs from 'fs';
import { getTileRefineService, summarizeTileRefineStats, type TileRefineRequest, type TileRefineResult } from './tile-refine-service';
import {
    getTileVegetationService,
    type TileVegetationPlantRequest,
    type TileVegetationPlantResult,
    type TileVegetationStripRequest,
    type TileVegetationStripResult
} from './tile-vegetation-service';

export type TileExtractionStage = 'crawl' | 'download' | 'parse' | 'remesh' | 'vegetation' | 'planting';

/** A location request that could not be completed, with the stage that failed. */
export class TileExtractionError extends Error {
    constructor(readonly stage: TileExtractionStage, message: string, readonly cause?: unknown) {
        super(message);
        this.name = 'TileExtractionError';
    }
}

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
    /** Base name for public/models. */
    publishBase: string;
    /** Share of the remeshed tile's triangle count all trees together may use (default 0.5). */
    treeTriangleShare?: number;
    signal?: AbortSignal;
    reportProgress?: (message: string) => void;
}

export interface LocationClayTrees {
    /** Mounted trees model (absent when no tree was planted). */
    url?: string;
    glbPath?: string;
    count: number;
    triangles: number;
    triangleBudget: number;
    /** Canopy measured in the photo tiles (all vegetation above the canopy height), and the part that became trees. */
    canopyAreaM2: number;
    treeCanopyAreaM2: number;
    /** Crowns touching the extraction boundary: kept as scanned, not planted. */
    cutAtBoundary: number;
    /** Roof or ground vegetation lower than the minimum tree height: kept as scanned. */
    belowMinHeight: number;
    /** Isolate requests: measured trees that do not stand on the isolated structure. */
    notOnStructure: number;
    crownsJson: string;
    /** Not observed by a scan, so set by ratios and reported as inferred. */
    inferred: Record<string, number>;
    strip: { removedTriangles?: number; capTriangles?: number; skirtTriangles?: number; openEdges?: { before: number; after: number } };
    ms: { strip: number; plant: number };
}

export interface LocationClayResult {
    url: string;
    glbPath: string;
    isolate: boolean;
    remesh: { triangles?: number; inputTriangles?: number; ms: number; cached: boolean; stats: Record<string, unknown>; binaryWarning?: string };
    trees?: LocationClayTrees;
    timingsMs: { vegetation?: number; remesh: number; planting?: number; total: number };
}

function message(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
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
        throw new TileExtractionError(name, `${name} failed: ${message(err)}`, err);
    }
}

export async function runLocationClayPipeline(req: LocationClayRequest, deps?: LocationClayDeps): Promise<LocationClayResult> {
    const t0 = Date.now();
    const d: LocationClayDeps = deps ?? { vegetation: getTileVegetationService(req.workspaceRoot), refine: getTileRefineService(req.workspaceRoot) };
    const share = req.treeTriangleShare ?? 0.5;
    if (!(share > 0 && share <= 1)) throw new TileExtractionError('planting', 'planting failed: treeTriangleShare must be in (0, 1]');
    const timings: LocationClayResult['timingsMs'] = { remesh: 0, total: 0 };

    let strip: TileVegetationStripResult | undefined;
    if (req.trees) {
        req.reportProgress?.('Measuring the trees in the photo tiles');
        const ts = Date.now();
        strip = await stage('vegetation', req.signal, () => d.vegetation.strip({ tilePath: req.rawTilePath }));
        timings.vegetation = Date.now() - ts;
    }

    req.reportProgress?.(req.isolate ? 'Remeshing the structure at the anchor' : 'Remeshing the district geometry');
    const tr = Date.now();
    const base = `${req.publishBase}${req.isolate ? '_isolated' : ''}${req.trees ? '_sbveggie' : ''}`;
    const refined = await stage('remesh', req.signal, async () => {
        const r = await d.refine.refine({ tilePath: strip ? strip.devegetatedGlb : req.rawTilePath, isolate: req.isolate || undefined, publishAs: base });
        const url = req.flavour === 'clay' ? r.published?.urls.clay : r.published?.urls.textured;
        if (!url) throw new Error('tile_refine did not publish a model');
        return { r, url };
    });
    timings.remesh = Date.now() - tr;
    const remeshedPath = req.flavour === 'clay' ? refined.r.clayGlb : refined.r.texturedGlb;
    const outputTriangles = refined.r.stats?.outputs?.triangles;

    let trees: LocationClayTrees | undefined;
    if (strip) {
        const crownsDoc = JSON.parse(fs.readFileSync(strip.crownsJson, 'utf8'));
        const crowns: Array<{ status: string }> = Array.isArray(crownsDoc.crowns) ? crownsDoc.crowns : [];
        const measuredTrees = crowns.filter(c => c.status === 'tree').length;
        const count = (s: string) => crowns.filter(c => c.status === s).length;
        trees = {
            count: 0,
            triangles: 0,
            triangleBudget: 0,
            canopyAreaM2: Number(strip.stats.canopyAreaM2 ?? 0),
            treeCanopyAreaM2: Number(strip.stats.treeCanopyAreaM2 ?? 0),
            cutAtBoundary: count('cut_at_boundary'),
            belowMinHeight: count('below_min_height'),
            notOnStructure: 0,
            crownsJson: strip.crownsJson,
            inferred: {},
            strip: {
                removedTriangles: strip.stats.triangles?.removed,
                capTriangles: strip.stats.triangles?.cap,
                skirtTriangles: strip.stats.triangles?.skirt,
                openEdges: strip.stats.openEdges
            },
            ms: { strip: timings.vegetation ?? 0, plant: 0 }
        };
        if (measuredTrees > 0) {
            req.reportProgress?.(`Growing ${measuredTrees} SB-Veggie trees from the measured crowns`);
            const tp = Date.now();
            const planted = await stage('planting', req.signal, async () => {
                if (typeof outputTriangles !== 'number' || !(outputTriangles > 0)) throw new Error('the remeshed tile reports no triangle count to size the tree budget from');
                return d.vegetation.plant({
                    crownsPath: strip!.crownsJson,
                    triangleBudget: Math.floor(outputTriangles * share),
                    seed: strip!.tileSha256.slice(0, 16),
                    supportMeshPath: req.isolate ? refined.r.clayGlb : undefined,
                    publishAs: `${base}_trees.glb`
                });
            });
            timings.planting = Date.now() - tp;
            trees.ms.plant = timings.planting;
            trees.count = Number(planted.stats.trees ?? 0);
            trees.triangles = Number(planted.stats.triangles ?? 0);
            trees.triangleBudget = Number(planted.stats.triangleBudget ?? 0);
            trees.notOnStructure = Array.isArray(planted.stats.skipped) ? planted.stats.skipped.length : 0;
            trees.inferred = planted.stats.inferred ?? {};
            if (trees.count > 0) {
                if (!planted.published?.url) throw new TileExtractionError('planting', 'planting failed: the trees model was not published');
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
        remesh: {
            triangles: outputTriangles,
            inputTriangles: refined.r.stats?.triangles,
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
    const tris = r.triangles !== undefined ? ` (${r.inputTriangles?.toLocaleString() ?? '?'} -> ${r.triangles.toLocaleString()} triangles)` : '';
    let s = ` Remeshed${result.isolate ? ' the structure at the anchor' : ''}${tris} in ${(r.ms / 1000).toFixed(1)} s${r.cached ? ' (cached)' : ''}; the mounted ${flavour === 'clay' ? 'clay ' : ''}model is ${result.url}.`;
    if (r.binaryWarning) s += ` Note: tile_refine ${r.binaryWarning}.`;
    const t = result.trees;
    if (t) {
        const kept: string[] = [];
        if (t.cutAtBoundary) kept.push(`${t.cutAtBoundary} crown${t.cutAtBoundary === 1 ? '' : 's'} cut by the extraction boundary`);
        if (t.belowMinHeight) kept.push(`${t.belowMinHeight} low planting${t.belowMinHeight === 1 ? '' : 's'} (under the minimum tree height)`);
        if (t.notOnStructure) kept.push(`${t.notOnStructure} tree${t.notOnStructure === 1 ? '' : 's'} not standing on the isolated structure (left out)`);
        const keptText = kept.length ? ` Kept as scanned: ${kept.join(', ')}.` : '';
        if (t.count > 0) {
            s += ` Rebuilt ${t.count} measured tree${t.count === 1 ? '' : 's'} as SB-Veggie trees (space colonisation, studio clay) from ${Math.round(t.treeCanopyAreaM2)} m² of measured crown, ${t.triangles.toLocaleString()} triangles within a budget of ${t.triangleBudget.toLocaleString()}; the trees model is ${t.url}.${keptText}`;
        } else if (t.canopyAreaM2 > 0) {
            s += ` The photo tiles show ${Math.round(t.canopyAreaM2)} m² of vegetation but no crown that measures as a tree, so no trees were added.${keptText}`;
        } else {
            s += ' No tree canopy was measured in the photo tiles, so no trees were added.';
        }
    }
    return s;
}
