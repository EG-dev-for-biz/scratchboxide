/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Service wrapper for the native tile vegetation pipeline (scratchbox_tile_vegetation.hpp + scripts/tile_vegetation.cpp):
 *
 * - strip: a photo-textured tile GLB in; the devegetated tile GLB (measured tree crowns removed, holes closed), the
 *   crown list (crowns.json) and stats out. Every tree crown is regrown first (seeded with the tile's sha256 unless the
 *   request gives a seed) and meshed within its own budget; a crown whose regrown tree's delivered leaves do not fill it
 *   stays as scanned (status not_regrowable, with the reason in crowns.json and stats.notRegrowable), and only the
 *   others are removed. A trunk stands on what the scan shows under its crown's footprint and stem (supportEvidence in
 *   crowns.json: the share of the footprint's vertical lines that meet each surface): the surface around it where the
 *   footprint shows it continuing under the crown (supportSource under_footprint), else the one under the stem
 *   (under_stem; the surface around it was canopy tops, a path below a mound), else the surface around it. Once the ground
 *   under the removed trees is rebuilt, every trunk base is measured against it: a trunk off it by more than
 *   groundTolerance is stood on it when the scan shows that surface under the crown (and it still regrows there:
 *   supportMovedM), else the tree is kept as scanned with its support undecided (no_measured_ground, support_undecided).
 *   With a region of interest (roi), trees whose stem lies outside it are neither regrown nor removed (outside_roi).
 * - canopy: the cells strip's own classifier calls canopy (CanopyMask), with nothing regrown or removed.
 * - plant: crowns.json in; one SB-Veggie tree per measured crown (space colonisation, studio clay), the same trees
 *   strip grew, within the caller's triangle budget or, without one, each tree's own budget within a scene cap
 *   (SCENE_TREE_TRIANGLE_CAP), as one GLB in the tile frame. Every tree's delivered leaves are measured against its
 *   crown (stats.shortOfCrown lists those that do not fill it within their budget), and with a ground mesh every trunk
 *   base is measured against the model the trees are mounted on (stats.offGround). The GLB is a staged-build layer: each
 *   tree's vertices carry `_REVEAL` (x its plant rank, y when it grew: node creation order) and its node extras.sb
 *   (provenance "grown to the measured crown"); crowns kept as scanned get an as-scanned LINES ring at their measured
 *   footprint; it is written with KHR_mesh_quantization (stats.glb: size, measured error, unquantised size).
 *
 * Paths are confined to the workspace root. The binary is built with clang++ on first use and rebuilt when one of
 * its sources (clang's -MMD list) is newer, once across processes (native-build); a failed build is an error, never an
 * older binary. It runs through execFile (no shell) with a timeout. Results are cached under
 * <root>/.scratchbox/cache/tile_vegetation/<sha256(binary + inputs + params)>/.
 */

import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { validateContract, type CanopyMask, type StripRoi } from '../../common/spatial/staged-location-contracts';
import { resolveWithinRoot } from '../security/path-guard';
import { buildNativeIfStale } from './native-build';
import { implausibleLayerBounds } from './layer-bounds-guard';
import { glbWorldBounds } from './part-connectivity';

/** Continuous strip parameters (metres, ratios); every one maps to a CLI flag of the same name in kebab case. */
export interface TileVegetationStripParams {
    cell?: number;
    terrainCell?: number;
    terrainRadius?: number;
    exgMin?: number;
    exgrMin?: number;
    darkGuard?: number;
    roughnessRadius?: number;
    roughnessMin?: number;
    planarAngle?: number;
    planarOffset?: number;
    planarArea?: number;
    canopyMinHeight?: number;
    minTreeHeight?: number;
    minCrownArea?: number;
    windowBase?: number;
    windowSlope?: number;
    windowMin?: number;
    windowMax?: number;
    climbLimit?: number;
    minTopProminence?: number;
    supportStep?: number;
    supportSearch?: number;
    footprintDilation?: number;
    drapeReach?: number;
    clearance?: number;
    supportBand?: number;
    skirtMin?: number;
    fragmentMaxArea?: number;
    capGrid?: number;
    seamGap?: number;
    sampleSpacing?: number;
    /**
     * The fill of the caps and skirts the strip builds where trees stood (1, default): each carries photo-inferred texels
     * sampled from the kept scan's own photo of the surface around it and carried across it from the nearest real texel
     * (confidence exp(-d / fillConfidenceScale)); a piece with no real neighbour takes the tile's mean colour of such
     * surfaces and is labelled generated. 0: the legacy flat clay primitives.
     */
    fill?: number;
    /** Texel of the fill (0.1 m; coarser only to keep the atlas within fillAtlasMaxPx, the atlas's longest side, 4096). */
    fillTexel?: number;
    fillAtlasMaxPx?: number;
    /** How far beyond a piece the real scan is read (2 m). */
    fillContext?: number;
    /** A kept surface within this of a texel's place (0.35 m), facing the way the piece does (|cos| at least fillNormalCos, 0.6), is the real surface there. */
    fillSurfaceTol?: number;
    fillNormalCos?: number;
    /** Carried this far from a real texel, a fill texel's confidence is 1/e (3 m). */
    fillConfidenceScale?: number;
    /**
     * A skirt on architecture (a wall, a roof edge) is kept off the real wall (1, default): where the scan has a surface
     * behind it within skirtBackedReach (0.4 m) rising from the skirt's foot, the skirt is cut down to the part above it;
     * backed to within skirtMin of its top, or over skirtBackedShare (0.5) of its face with no such band, it is not built.
     * 0: every skirt is built whole.
     */
    skirtDropBacked?: number;
    skirtBackedReach?: number;
    skirtBackedShare?: number;
    /**
     * Buildings win over trees: a triangle the removal would take that lies on a kept wall it touches (within facadeGuard
     * (0.15 m) of the wall's plane, facing like it, |cos| at least facadeGuardCos (0.9)) is facade whatever the classifier
     * called it and stays; the cut stops at the facade (stats.buildingGuard). 0: off.
     */
    facadeGuard?: number;
    facadeGuardCos?: number;
    /** How each tree crown is regrown before anything is removed (plant grows them again with the same). */
    crownBaseRatio?: number;
    trunkRadiusPerHeight?: number;
    /** This build's own |latitude| (0..90): costs a species entry whose own latAbsRangeDeg does not reach it (scratchbox_tree_species.hpp), so a crown's shape alone cannot match a climate-limited species (a palm) outside where it grows. Omitted: uncosted. */
    latAbsDeg?: number;
    shellDepth?: number;
    /** Seeded per crown: its crown base ratio varies by +/- this (0.10), the scaffold limbs' mean angle by +/- branchAngleSpread (0.20 rad), and the trunk leans trunkLean (0.45) of the way to the measured apex's offset. */
    crownBaseSpread?: number;
    branchAngleSpread?: number;
    trunkLean?: number;
    /** Share of a crown's measured surface the regrown leaves must reach for it to be removed and rebuilt (0.9). */
    minSurfaceReached?: number;
    /**
     * Buildings win over trees: the regrown crown is kept this far (1 m: a leaf cluster's reach) off the scanned walls the crown met (crowns.json
     * `walls`, measured by strip): attractors and surface samples behind a wall or within the clearance are left out of
     * the growth (stats.keptOffWalls, per tree keptOffWalls). 0: no clipping.
     */
    wallClearance?: number;
    /** Share of a crown's measured surface that may hang more than supportStep below its support before that support is not its ground (0.1). */
    maxCrownBelowSupport?: number;
    /**
     * A surface the scan shows under a crown (facing up, not canopy) is what its trunk stands on only when at least this
     * share of the vertical lines through its footprint meet it, one of them in its inner half (0.2).
     */
    minSupportEvidence?: number;
    /**
     * After the ground under the removed trees is rebuilt, a trunk base further than this from the surface under its stem
     * is stood on that surface when the scan shows it under the crown (re-checked to regrow), else the tree is kept as
     * scanned with its support undecided (0.5 m).
     */
    groundTolerance?: number;
    /** Removal passes at most while trees are kept as scanned between them (6). */
    groundPasses?: number;
}

/**
 * Continuous plant parameters. crownBaseRatio and trunkRadiusPerHeight are not observed by a scan: inferred. For crowns
 * a strip measured, the growth ratios default to the ones it regrew them with (crowns.json "growth"); another value is
 * refused (bad_request), since it decided which crowns were removed.
 */
export interface TileVegetationPlantParams {
    minTrianglesPerTree?: number;
    /** A tree's triangle target per m² of its crown envelope (footprint plus side), when no budget is given (4). */
    trianglesPerCrownM2?: number;
    crownBaseRatio?: number;
    trunkRadiusPerHeight?: number;
    /** This build's own |latitude| (0..90): costs a species entry whose own latAbsRangeDeg does not reach it (scratchbox_tree_species.hpp), so a crown's shape alone cannot match a climate-limited species (a palm) outside where it grows. Omitted: uncosted. Must be the same value strip was given, since it decided which crowns regrow with which species. */
    latAbsDeg?: number;
    woodShare?: number;
    shellDepth?: number;
    crownBaseSpread?: number;
    branchAngleSpread?: number;
    trunkLean?: number;
    minSurfaceReached?: number;
    /** 1 (default): every tree is written at three levels (near: instanced leaf clusters, mid: fewer larger leaves, far: blob masses); 0: the far level alone. */
    lod?: number;
    /** Buildings win over trees: the regrown crown is kept this far (1 m) off the scanned walls the crown met (crowns.json `walls`); 0: no clipping. */
    wallClearance?: number;
    /** 0 bare .. 1 full summer (default 1): scales leaf density at every level. */
    psiSeason?: number;
    /** Blade length = clamp(leafSizeRatio x crown height, leafMin, leafMax) metres (0.0065, 0.08, 0.14). */
    leafSizeRatio?: number;
    leafMin?: number;
    leafMax?: number;
    /** Leaves in the densest cluster (160) and the cluster's reach in blade lengths (7). */
    leavesPerCluster?: number;
    clusterRadiusPerLeaf?: number;
    /** Leaf density falls as exp(-d / (shellDepthPerHeight x crown height)) with d the depth below the measured canopy surface (0.10). */
    shellDepthPerHeight?: number;
    /** Distance between leaf clusters / cluster reach (0.5). */
    stationSpacing?: number;
    /**
     * Distances (m from the camera) at which a viewport changes a tree's level: near up to lodNearPerHeight x its height
     * (1.3, 15-40 m, at most lodNearMax), near-mid up to lodNearMidPerHeight x its height (7.5, 35-150 m, at most
     * lodNearMidMax), mid up to lodFarPerHeight x its height (10, 130-260 m, at most lodFarMax), far beyond, dithered over
     * lodFade (8 m) or more. These defaults match scratchbox_tile_vegetation.hpp's PlantParams (2026-10-21).
     */
    lodNearPerHeight?: number;
    /** The far level's wood (trunk and main limbs): clamp(farWoodTrianglesPerHeight x tree height, farWoodMinTriangles, farWoodMaxTriangles) triangles (24, 160, 600). */
    farWoodTrianglesPerHeight?: number;
    farWoodMinTriangles?: number;
    farWoodMaxTriangles?: number;
    lodNearMidPerHeight?: number;
    lodFarPerHeight?: number;
    lodNearMax?: number;
    lodNearMidMax?: number;
    lodFarMax?: number;
    lodFade?: number;
    /** How far (m) a hero-area tree (see TileVegetationPlantRequest.heroRoi) holds full quality at (3000). */
    heroFullQualityM?: number;
    supportTolerance?: number;
    /** With groundMeshPath: a trunk base further than this from the mounted model at its stem is reported (0.5 m). */
    groundTolerance?: number;
    /** The largest position error KHR_mesh_quantization may introduce in the trees GLB, measured on the file (0.01 m). */
    maxQuantizationError?: number;
}

/**
 * The most triangles the trees of one location may use together when the request gives no budget of its own: each
 * tree's own budget grows with its crown (and is never less than its leaf masses on the measured surface need), and the
 * budgets are scaled down to fit under this cap, what the leaf masses need first (never below the per-tree minimum of
 * 120). 1.5 million triangles: the trees model is written as positions, normals and 32-bit indices, about 33 bytes a
 * triangle (Central Park at a 250 m radius: 1,043 trees, 1.43 million budgeted triangles, 47 MB for the budgeted blob
 * trees; the written far level, the trunk and main limbs under the leaf masses of the blob trees, holds less, and
 * the near levels instance their leaves, so the file is larger than that figure), so at the cap the budgeted trees stay near
 * 50 MB, about the size of the photo-textured extraction of a 250 m radius it was measured in (41 MB there); with the
 * remeshed tile (0.1-1 million triangles) the scene stays under about 2.5 million triangles, which a WebGL viewport draws
 * at interactive rates on integrated GPUs. At 120 triangles a tree the cap holds 12,500 trees, over ten times what a
 * 250 m radius of dense park holds (1,043 in Central Park).
 */
export const SCENE_TREE_TRIANGLE_CAP = 1_500_000;

/**
 * What the trees would draw in a park view with no budget, as opposed to what they store (SCENE_TREE_TRIANGLE_CAP above, which
 * bounds each tree's wood, shared by every level, and the blob tree the far masses are fitted to). Trees are written at four
 * levels and a viewport draws one per tree by its distance; stats.lodFrames measures that frame on the written trees (camera
 * poses on a grid over the location, an 80 degree view, metre bands, no budget). This is a ceiling on that estimate, so a
 * level that grows or a band that reaches farther shows up here.
 *
 * It is not what a frame draws: the viewport's triangle budget (DEFAULT_TREE_TRIANGLE_BUDGET in common/spatial/tree-lod-math.ts,
 * shared with the buildings) caps the frame, and trees give up levels, least important first, to fit. Measured with the
 * near-mid band at 6 x tree height (25-100 m) and the mid band at 8 x (60-140 m), Washington Square (591 trees): median
 * 1.66 M, p95 10.5 M, max 16.7 M; the synthetic park of location-clay-pipeline.test.ts (372 trees): median 9.8 M, p95
 * 12.9 M, max 14.4 M, and a max of 44 M with both bands twice as long.
 *
 * Since the near-mid level is drawn as leaf cards (2026-11-05, scratchbox_tree_lod.hpp nearMidCards*: about 1,500 triangles
 * a tree where its leaf clusters took about 80,000), the same measures are: Washington Square Park (610 trees) median
 * 0.25 M, p95 3.0 M, max 8.6 M (with leaf clusters 1.1 M, 10.4 M, 20.3 M); the synthetic park median 1.7 M, p95 3.1 M, max
 * 4.5 M (with leaf clusters 8.0 M, 11.2 M, 12.5 M, and a max of 29.6 M with both bands twice as long).
 */
export const SCENE_TREE_DRAWN_TRIANGLES_PER_FRAME = 20_000_000;
export const SCENE_TREE_DRAWN_TRIANGLES_PER_LEVEL = { level0: 5_000_000, level1: 4_000_000, level2: 3_000_000 } as const;

export interface TileVegetationStripRequest {
    /** Photo-textured tile GLB, relative to the workspace root or absolute inside it. */
    tilePath: string;
    params?: TileVegetationStripParams;
    /**
     * Where trees may be measured and regrown (tile frame polygon). A tree whose stem lies outside it is neither regrown
     * nor removed: its canopy stays as scanned (status outside_roi, stats.crowns.outsideRoi).
     */
    roi?: StripRoi;
    /** Also write a top-down PNG of the measurement. */
    topDown?: boolean;
    /** Regrow each crown with the tree species library (assets/vegetation/species/index.json; default true; ignored when the checkout has none). */
    species?: boolean;
    /** Hex seed (1-16 digits) the trees are regrown with to decide which to remove; default the tile's sha256 (16 hex digits), as plant is seeded by the pipeline. */
    seed?: string;
    threads?: number;
    timeoutMs?: number;
    /** Stops this request (it rejects with an AbortError); the native run is killed once no request waits on it. */
    signal?: AbortSignal;
}

export interface TileVegetationStripResult {
    devegetatedGlb: string;
    /**
     * What the removal took, as scanned (one node per crown, provenance as-scanned; the staged trees layer l5x): mounted
     * when the tree stage fails, so the scanned trees are put back rather than leaving their ground empty.
     */
    removedTreesGlb: string;
    crownsJson: string;
    topDownPng?: string;
    stats: Record<string, any>;
    /** sha256 of the input tile (hex), used to seed planting deterministically. */
    tileSha256: string;
    cached: boolean;
    ms: number;
    cacheKey: string;
}

export interface TileVegetationPlantRequest {
    crownsPath: string;
    /** Total triangles all trees may use (> 0): the caller's own budget. Give this or sceneTriangleCap. */
    triangleBudget?: number;
    /** No budget of the caller's own: each tree gets a target from its crown's size, all within this cap (> 0). */
    sceneTriangleCap?: number;
    /** Hex seed (1-16 digits), mixed with each crown id. */
    seed: string;
    /** Isolate requests: plant only crowns whose trunk base lies on this mesh. */
    supportMeshPath?: string;
    /** The model the trees are mounted on: every trunk base is measured against it at its stem (stats.offGround). */
    groundMeshPath?: string;
    /**
     * A tree whose stem lies inside this polygon (tile frame) holds full (near) quality at any distance a staged scene's
     * camera realistically reaches, instead of its own height-scaled distance bands; a tree outside it (or, with no
     * heroRoi, every tree) keeps the normal bands. The viewport's GPU-adaptive triangle budget is unaffected and stays
     * free to demote a hero tree under real load, same as any other tree.
     */
    heroRoi?: StripRoi;
    params?: TileVegetationPlantParams;
    /**
     * Write the trees GLB with KHR_mesh_quantization (default true; three's GLTFLoader reads it natively). stats.glb gives
     * its size, the largest position and normal error measured on the file, and the size the same trees take unquantised.
     */
    quantize?: boolean;
    /** Write each tree's growth order on its vertices as `_REVEAL` (default true); off, the same meshes without it. */
    reveal?: boolean;
    /**
     * Choose each tree's leaf set and bark from the tree texture library (assets/textures/trees/index.json) by appearance,
     * give its wood UVs in the bark's tiles and record the choice in its extras (default true; ignored when the checkout has
     * no library).
     */
    textures?: boolean;
    /**
     * Grow each crown with the proportions of the tree species library entry nearest its measurements
     * (assets/vegetation/species/index.json; default true; ignored when the checkout has no library). Must match the
     * strip that measured the crowns: plant refuses a crowns.json measured with another library (bad_request).
     */
    species?: boolean;
    /** Copy the trees GLB to public/models/<publishAs> (a plain *.glb name). */
    publishAs?: string;
    /**
     * Regions the ground program (procedural-ground.ts groundCoverRegions) asks for low vegetation in: boundary loops in
     * the tile frame (empty: the whole ground) and a density 0..1. tile_vegetation (scripts/tile_vegetation.cpp) grows
     * measured crowns only and has no understorey grammar yet, so nothing is planted from them: the request is validated
     * and recorded in the result's `groundCover` with that reason, never silently dropped and never faked.
     */
    groundCover?: Array<{ loops: Array<Array<[number, number]>>; density: number; areaM2: number; labels: string[] }>;
    /**
     * Photo-inferred crown corrections (scratchbox.crown-correction/1, tree-crown-photo-check.ts): each crown's width and
     * base, applied before it is grown. Absent: the correction recorded for these crowns (by the sha256 of crowns.json, under
     * .scratchbox/cache/crown_correction/) when there is one; false: none.
     */
    crownCorrectionPath?: string | false;
    threads?: number;
    timeoutMs?: number;
    /** Stops this request (it rejects with an AbortError); the native run is killed once no request waits on it. */
    signal?: AbortSignal;
}

export interface TileVegetationCanopyRequest {
    /** Photo-textured tile GLB, relative to the workspace root or absolute inside it. */
    tilePath: string;
    /** Surface model cell (m), strip's own by default (0.5). */
    cellM?: number;
    /** strip's classifier parameters (exgMin, roughnessMin, canopyMinHeight, ...). */
    params?: TileVegetationStripParams;
    timeoutMs?: number;
    signal?: AbortSignal;
}

export interface TileVegetationCanopyResult {
    /** Cell (i, k) covers [x0 + i cellM, x0 + (i + 1) cellM) x [z0 + k cellM, z0 + (k + 1) cellM); runs over k * nx + i, first run not canopy. */
    mask: CanopyMask;
    cached: boolean;
    ms: number;
    cacheKey: string;
}

/** Decodes a CanopyMask's runs into one 0/1 value per cell (k * nx + i). */
export function decodeCanopyMask(mask: CanopyMask): Uint8Array {
    const out = new Uint8Array(mask.nx * mask.nz);
    let at = 0;
    mask.runs.forEach((run, i) => {
        if (i % 2 === 1) out.fill(1, at, Math.min(out.length, at + run));
        at += run;
    });
    if (at !== out.length) throw new TileVegetationError('failed', `canopy mask runs cover ${at} cells, not ${out.length}`);
    return out;
}

function checkRoi(roi: StripRoi): StripRoi {
    const problems = validateContract('StripRoi', roi);
    if (problems.length) throw new TileVegetationError('bad_request', `roi is not a StripRoi: ${problems.slice(0, 3).join('; ')}`);
    if (roi.polygon.some(p => !p.every(Number.isFinite))) throw new TileVegetationError('bad_request', 'roi points must be finite metres');
    let keep: StripRoi['keep'];
    if (roi.keep) {
        const k = roi.keep;
        const cells = k.runs.reduce((n, r) => n + r, 0);
        if (![k.cellM, k.x0, k.z0].every(Number.isFinite)) throw new TileVegetationError('bad_request', 'roi keep cells must be on a finite grid');
        if (cells > k.nx * k.nz) throw new TileVegetationError('bad_request', `roi keep runs cover ${cells} cells, more than the ${k.nx} x ${k.nz} grid`);
        keep = { cellM: k.cellM, x0: k.x0, z0: k.z0, nx: k.nx, nz: k.nz, runs: [...k.runs] };
    }
    return { schema: roi.schema, polygon: roi.polygon.map(p => [p[0], p[1]] as [number, number]), ...(keep ? { keep } : {}) };
}

export interface TileVegetationPlantResult {
    treesGlb: string;
    stats: Record<string, any>;
    cached: boolean;
    ms: number;
    cacheKey: string;
    published?: { path: string; url: string; backup?: string };
    /** Set when the cached entry under this key was refused (its bounds are physically impossible) and rebuilt: why. */
    rebuiltStaleCache?: string;
    /** The photo-inferred crown correction the trees were grown with (absent: none). */
    crownCorrection?: { path: string; provenance: 'photo-inferred'; trees: number; fromPhotos: number; median?: { widthScale: number; crownBaseRatio: number } };
    /** What became of the `groundCover` regions asked for (absent: none asked): how many, their area, and that none was planted, with the reason. */
    groundCover?: { regions: number; areaM2: number; planted: 0; reason: string };
}

export const GROUND_COVER_UNSUPPORTED = 'tile_vegetation (scripts/tile_vegetation.cpp) grows measured crowns only and has no understorey grammar yet: the regions are recorded, nothing is planted in them';

/**
 * One tree described by measurements (scratchbox.sb-veggie-trees/1, scratchbox_sb_veggie_grove.hpp): for scenes with no
 * scan behind them. Grown by `grow` with the same planting a staged location's trees get (space colonisation, SB-Veggie
 * leaf clusters, the species and texture libraries, the viewport's levels of detail), each tree labelled generated.
 */
export interface DescribedTreeSpec {
    /** Trunk base [x, y, z], metres (y up). Default the origin. */
    position?: [number, number, number];
    /** Trunk base to crown top, metres. */
    heightM: number;
    /** Crown half-spread, metres (round crown), or crownRadiiM for [along x, along z]. */
    crownRadiusM?: number;
    crownRadiiM?: [number, number];
    /** Lowest crown above the base, metres (omitted: the species entry nearest the crown's measurements gives it). */
    crownBaseHeightM?: number;
    /** Share of the crown's depth where it is widest: 0 a cone widest at its base, 0.5 a round crown (default), 0.8 an umbrella. */
    crownWidestAt?: number;
    /** The crown top's profile (1 - u^n)^(1/n): 1 a cone, 2 a dome (default), 4 a flat top. */
    crownTopExponent?: number;
    /** Trunk radius above the flare, metres (omitted: the species entry's ratio). */
    trunkRadiusM?: number;
    /** Leaf colour, linear RGB 0..1 (the species and leaf textures are chosen by it). */
    leafLinearRgb?: [number, number, number];
    /** Free text carried into the tree's extras; never changes the geometry. */
    label?: string;
}

export interface TileVegetationGrowRequest {
    trees: DescribedTreeSpec[];
    /** Free text for the trees GLB's root extras. */
    label?: string;
    /** Total triangles all trees may use; omitted: each tree's own budget within SCENE_TREE_TRIANGLE_CAP. */
    triangleBudget?: number;
    /** Hex seed (1-16 digits); default the sha256 of the descriptions. */
    seed?: string;
    /** Write with KHR_mesh_quantization (default true). */
    quantize?: boolean;
    lod?: boolean;
    psiSeason?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
}

export interface TileVegetationGrowResult {
    treesGlb: string;
    crownsJson: string;
    stats: Record<string, any>;
    seed: string;
    cached: boolean;
    ms: number;
    cacheKey: string;
}

/** Where the crown correction measured for a crowns.json (by its sha256) is kept in a workspace. */
export function crownCorrectionPathFor(workspaceRoot: string, crownsSha256: string): string {
    return path.join(workspaceRoot, '.scratchbox', 'cache', 'crown_correction', `${crownsSha256}.json`);
}

export type TileVegetationErrorCode =
    | 'bad_request' | 'not_found' | 'timeout' | 'failed' | 'build_failed'
    | 'bad_input' | 'texture_decode' | 'no_photo_texture' | 'budget_too_small' | 'budget_exceeded' | 'plant_failed' | 'io';

export class TileVegetationError extends Error {
    constructor(readonly code: TileVegetationErrorCode, message: string, readonly detail?: string) {
        super(message);
        this.name = 'TileVegetationError';
    }
}

export interface TileVegetationServiceOptions {
    workspaceRoot: string;
    /** Where scripts/tile_vegetation.cpp and the engine headers live (default: discovered from this file, else cwd). */
    repoRoot?: string;
    /** A prebuilt binary to run instead of building one. */
    binaryPath?: string;
    cacheDir?: string;
    defaultTimeoutMs?: number;
}

const CLI_SOURCE = path.join('scripts', 'tile_vegetation.cpp');
const INCLUDE_DIR = path.join('packages', 'core', 'src', 'native', '3d-engine', 'include');
const BINARY = path.join('build', '3d-native', 'tile_vegetation');
const CACHE_VERSION = 'tile_vegetation/v5';
const PUBLISH_FILE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}\.glb$/;
const KNOWN_CODES = new Set<TileVegetationErrorCode>(['bad_request', 'not_found', 'timeout', 'failed', 'build_failed', 'bad_input', 'texture_decode', 'no_photo_texture', 'budget_too_small', 'budget_exceeded', 'plant_failed', 'io']);

/** The tree texture library's descriptor index, relative to the checkout (see scratchbox_tree_textures.hpp). */
export const TREE_TEXTURE_INDEX = path.join('assets', 'textures', 'trees', 'index.json');

/** The tree texture library's index in a checkout, or undefined when it has none. */
export function treeTextureIndexPath(repoRoot: string): string | undefined {
    const file = path.join(repoRoot, TREE_TEXTURE_INDEX);
    return fs.existsSync(file) ? file : undefined;
}

/** The tree species library's index, relative to the checkout (see scratchbox_tree_species.hpp). */
export const TREE_SPECIES_INDEX = path.join('assets', 'vegetation', 'species', 'index.json');

/** The tree species library's index in a checkout, or undefined when it has none. */
export function treeSpeciesIndexPath(repoRoot: string): string | undefined {
    const file = path.join(repoRoot, TREE_SPECIES_INDEX);
    return fs.existsSync(file) ? file : undefined;
}

/** The checkout that holds scripts/tile_vegetation.cpp: walks up from this file, then from cwd. */
export function findTileVegetationRepoRoot(): string {
    for (const start of [__dirname, process.cwd()]) {
        let dir = path.resolve(start);
        while (true) {
            if (fs.existsSync(path.join(dir, CLI_SOURCE))) return dir;
            const parent = path.dirname(dir);
            if (parent === dir) break;
            dir = parent;
        }
    }
    return process.cwd();
}

function sha256File(file: string, hash: crypto.Hash): void {
    const fd = fs.openSync(file, 'r');
    try {
        const buf = Buffer.allocUnsafe(1 << 20);
        let n: number;
        while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
    } finally {
        fs.closeSync(fd);
    }
}

function fileSha256(file: string): string {
    const h = crypto.createHash('sha256');
    sha256File(file, h);
    return h.digest('hex');
}

function kebab(name: string): string {
    return name.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`);
}

/** Flags from a parameter object: only finite numbers, in key order (part of the cache key). */
function paramFlags(params: object | undefined): { flags: string[]; key: Record<string, number> } {
    const flags: string[] = [];
    const key: Record<string, number> = {};
    for (const [k, v] of Object.entries(params ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
        if (v === undefined) continue;
        if (typeof v !== 'number' || !Number.isFinite(v)) throw new TileVegetationError('bad_request', `${k} must be a finite number`);
        flags.push(`--${kebab(k)}`, String(v));
        key[k] = v;
    }
    return { flags, key };
}

/** "ERROR <code>: <message>" from the CLI's stderr, as a typed error. */
function cliError(stderr: string, fallbackMessage: string): TileVegetationError {
    const line = stderr.split('\n').reverse().find(l => l.startsWith('ERROR '));
    const m = line?.match(/^ERROR ([a-z_]+): (.*)$/);
    if (m && KNOWN_CODES.has(m[1] as TileVegetationErrorCode)) return new TileVegetationError(m[1] as TileVegetationErrorCode, m[2], stderr.slice(-2000));
    return new TileVegetationError('failed', fallbackMessage, stderr.slice(-2000));
}

/** The error a stopped request rejects with (name 'AbortError', as the chat's own cancellation uses). */
function stoppedError(): Error {
    return Object.assign(new Error('Stopped by the chat before it finished'), { name: 'AbortError' });
}

/** Runs the binary; `signal` kills it (SIGKILL) and rejects with an AbortError when the request is stopped. */
function runFile(file: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(stoppedError());
            return;
        }
        const started = Date.now();
        execFile(file, args, { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 32 * 1024 * 1024, windowsHide: true, ...(signal ? { signal } : {}) }, (err, stdout, stderr) => {
            if (!err) {
                resolve({ stdout: String(stdout), stderr: String(stderr) });
                return;
            }
            if (signal?.aborted || (err as Error).name === 'AbortError') {
                reject(stoppedError());
                return;
            }
            const e = err as NodeJS.ErrnoException & { killed?: boolean };
            const tail = String(stderr || stdout || e.message);
            if (e.killed && Date.now() - started >= timeoutMs - 50) {
                reject(new TileVegetationError('timeout', `${path.basename(file)} timed out after ${timeoutMs} ms`, tail.slice(-2000)));
            } else {
                reject(cliError(tail, `${path.basename(file)} failed: ${tail.split('\n').filter(Boolean).pop() ?? e.message}`));
            }
        });
    });
}

export class TileVegetationService {
    readonly workspaceRoot: string;
    readonly repoRoot: string;
    readonly cacheDir: string;
    private readonly binaryOverride?: string;
    private readonly defaultTimeoutMs: number;
    private building?: Promise<string>;
    private binaryHash?: { key: string; hex: string };
    /**
     * Identical runs in progress, shared by every request that asks for them. A run has its own AbortController: it
     * is stopped only when every request waiting on it has been stopped, and each request rejects with its own stop.
     */
    private readonly inFlight = new Map<string, { promise: Promise<unknown>; controller: AbortController; waiters: number; settled: boolean }>();

    constructor(options: TileVegetationServiceOptions) {
        this.workspaceRoot = resolveWithinRoot(options.workspaceRoot, '.');
        this.repoRoot = path.resolve(options.repoRoot ?? findTileVegetationRepoRoot());
        this.cacheDir = options.cacheDir
            ? resolveWithinRoot(this.workspaceRoot, options.cacheDir)
            : resolveWithinRoot(this.workspaceRoot, path.join('.scratchbox', 'cache', 'tile_vegetation'));
        this.binaryOverride = options.binaryPath ? path.resolve(options.binaryPath) : undefined;
        this.defaultTimeoutMs = options.defaultTimeoutMs ?? 300_000;
    }

    /** Builds build/3d-native/tile_vegetation when it is missing or older than any of its sources. */
    ensureBinary(): Promise<string> {
        if (this.binaryOverride) {
            if (!fs.existsSync(this.binaryOverride)) return Promise.reject(new TileVegetationError('not_found', `tile_vegetation binary not found: ${this.binaryOverride}`));
            return Promise.resolve(this.binaryOverride);
        }
        if (!this.building) this.building = this.buildIfStale().finally(() => { this.building = undefined; });
        return this.building;
    }

    private async buildIfStale(): Promise<string> {
        const source = path.join(this.repoRoot, CLI_SOURCE);
        if (!fs.existsSync(source)) throw new TileVegetationError('not_found', `tile_vegetation source not found: ${source}`);
        try {
            return await buildNativeIfStale({
                source,
                binary: path.join(this.repoRoot, BINARY),
                includeDir: path.join(this.repoRoot, INCLUDE_DIR),
                flags: ['-pthread'],
                libs: ['-lz'],
                timeoutMs: 600_000
            });
        } catch (err) {
            throw new TileVegetationError('build_failed', 'could not build tile_vegetation', (err as Error).message);
        }
    }

    private hashBinary(bin: string): string {
        const st = fs.statSync(bin);
        const key = `${bin}:${st.size}:${st.mtimeMs}`;
        if (this.binaryHash?.key !== key) this.binaryHash = { key, hex: fileSha256(bin) };
        return this.binaryHash.hex;
    }

    private resolveInput(rel: string | undefined, what: string, ext: string): string {
        if (typeof rel !== 'string' || !rel.trim()) throw new TileVegetationError('bad_request', `${what} is required`);
        const file = resolveWithinRoot(this.workspaceRoot, rel.trim());
        if (!file.toLowerCase().endsWith(ext)) throw new TileVegetationError('bad_request', `${what} must be a ${ext} file`);
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new TileVegetationError('not_found', `${what} not found: ${rel}`);
        return file;
    }

    /**
     * Runs `produce` into a fresh temp dir and renames it into the cache entry, unless the entry exists. Concurrent
     * identical requests share one run; `signal` stops only this request's wait (and the run, once nobody waits).
     */
    private cached<T>(key: string, outputs: string[], produce: (dir: string, signal: AbortSignal) => Promise<void>, result: (dir: string, cached: boolean) => T, signal?: AbortSignal): Promise<T> {
        const dir = path.join(this.cacheDir, key);
        const done = path.join(dir, 'done.json');
        if (fs.existsSync(done)) return Promise.resolve(result(dir, true));
        if (signal?.aborted) return Promise.reject(stoppedError());
        let entry = this.inFlight.get(key);
        if (!entry) {
            const controller = new AbortController();
            const run = (async () => {
                fs.mkdirSync(this.cacheDir, { recursive: true });
                const tmp = path.join(this.cacheDir, `${key}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
                fs.mkdirSync(tmp);
                try {
                    await produce(tmp, controller.signal);
                    for (const f of outputs) {
                        if (!fs.existsSync(path.join(tmp, f))) throw new TileVegetationError('failed', `tile_vegetation did not write ${f}`);
                    }
                    fs.writeFileSync(path.join(tmp, 'done.json'), JSON.stringify({ at: new Date().toISOString() }));
                    fs.rmSync(dir, { recursive: true, force: true });
                    fs.renameSync(tmp, dir);
                } catch (err) {
                    fs.rmSync(tmp, { recursive: true, force: true });
                    if (fs.existsSync(done)) return result(dir, true);
                    throw err;
                }
                return result(dir, false);
            })();
            const created: { promise: Promise<unknown>; controller: AbortController; waiters: number; settled: boolean } = { promise: run, controller, waiters: 0, settled: false };
            entry = created;
            run.then(() => undefined, () => undefined).finally(() => {
                created.settled = true;
                if (this.inFlight.get(key) === created) this.inFlight.delete(key);
            });
            this.inFlight.set(key, created);
        }
        const shared = entry;
        shared.waiters++;
        return new Promise<T>((resolve, reject) => {
            let left = false;
            const leave = () => {
                if (left) return false;
                left = true;
                signal?.removeEventListener('abort', onAbort);
                shared.waiters--;
                return true;
            };
            const onAbort = () => {
                if (!leave()) return;
                if (shared.waiters === 0 && !shared.settled) {
                    // nobody waits any more: stop the run, and let the next identical request start its own
                    if (this.inFlight.get(key) === shared) this.inFlight.delete(key);
                    shared.controller.abort();
                }
                reject(stoppedError());
            };
            signal?.addEventListener('abort', onAbort, { once: true });
            (shared.promise as Promise<T>).then(
                v => { if (leave()) resolve(v); },
                e => { if (leave()) reject(e); }
            );
        });
    }

    async strip(req: TileVegetationStripRequest): Promise<TileVegetationStripResult> {
        const t0 = Date.now();
        const input = this.resolveInput(req.tilePath, 'tilePath', '.glb');
        const { flags, key: keyParams } = paramFlags(req.params);
        const timeoutMs = req.timeoutMs ?? this.defaultTimeoutMs;
        const bin = await this.ensureBinary();
        const tileSha256 = fileSha256(input);
        if (req.seed !== undefined && (typeof req.seed !== 'string' || !/^[0-9a-fA-F]{1,16}$/.test(req.seed))) throw new TileVegetationError('bad_request', 'seed must be 1-16 hex digits');
        const seed = (req.seed ?? tileSha256.slice(0, 16)).toLowerCase();
        const roi = req.roi === undefined ? undefined : checkRoi(req.roi);
        if (req.species !== undefined && typeof req.species !== 'boolean') throw new TileVegetationError('bad_request', 'species must be a boolean');
        const speciesIndex = req.species === false ? undefined : treeSpeciesIndexPath(this.repoRoot);
        const hash = crypto.createHash('sha256').update(CACHE_VERSION).update('\0strip\0').update(this.hashBinary(bin)).update('\0')
            .update(tileSha256).update('\0').update(JSON.stringify({ ...keyParams, topDown: !!req.topDown, seed, ...(roi ? { roi: roi.polygon, ...(roi.keep ? { keep: roi.keep } : {}) } : {}) }));
        hash.update('\0species\0');
        if (speciesIndex) sha256File(speciesIndex, hash);
        const key = hash.digest('hex');
        const outputs = ['devegetated.glb', 'removed_trees.glb', 'crowns.json', 'stats.json', ...(req.topDown ? ['topdown.png'] : [])];
        const res = await this.cached(key, outputs, async (dir, signal) => {
            const args = ['strip', '--input', input, '--out', path.join(dir, 'devegetated.glb'), '--removed-out', path.join(dir, 'removed_trees.glb'),
                '--crowns', path.join(dir, 'crowns.json'), '--stats', path.join(dir, 'stats.json'), '--seed', seed, ...flags];
            if (roi) {
                fs.writeFileSync(path.join(dir, 'roi.json'), JSON.stringify(roi));
                args.push('--roi-json', path.join(dir, 'roi.json'));
            }
            if (req.topDown) args.push('--topdown', path.join(dir, 'topdown.png'));
            if (speciesIndex) args.push('--species-index', speciesIndex, '--species-index-label', TREE_SPECIES_INDEX);
            if (req.threads !== undefined) args.push('--threads', String(req.threads));
            await runFile(bin, args, timeoutMs, signal);
        }, (dir, cached) => ({
            devegetatedGlb: path.join(dir, 'devegetated.glb'),
            removedTreesGlb: path.join(dir, 'removed_trees.glb'),
            crownsJson: path.join(dir, 'crowns.json'),
            topDownPng: req.topDown ? path.join(dir, 'topdown.png') : undefined,
            stats: JSON.parse(fs.readFileSync(path.join(dir, 'stats.json'), 'utf8')),
            tileSha256,
            cached,
            ms: 0,
            cacheKey: key
        }), req.signal);
        return { ...res, ms: Date.now() - t0 };
    }

    /**
     * The cells strip's own classifier calls canopy in a tile, without regrowing or removing anything (the same
     * classifier, so a structure picked on a canopy-masked surface model matches what strip later removes). The mask is
     * checked against the CanopyMask contract.
     */
    async canopy(req: TileVegetationCanopyRequest): Promise<TileVegetationCanopyResult> {
        const t0 = Date.now();
        const input = this.resolveInput(req.tilePath, 'tilePath', '.glb');
        if (req.cellM !== undefined && !(typeof req.cellM === 'number' && Number.isFinite(req.cellM) && req.cellM > 0 && req.cellM <= 10)) {
            throw new TileVegetationError('bad_request', 'cellM must be a number in (0, 10] metres');
        }
        const { flags, key: keyParams } = paramFlags(req.params);
        const timeoutMs = req.timeoutMs ?? this.defaultTimeoutMs;
        const bin = await this.ensureBinary();
        const tileSha256 = fileSha256(input);
        const cell = req.cellM ?? 0.5;
        const key = crypto.createHash('sha256').update(CACHE_VERSION).update('\0canopy\0').update(this.hashBinary(bin)).update('\0')
            .update(tileSha256).update('\0').update(JSON.stringify({ ...keyParams, cell })).digest('hex');
        const res = await this.cached(key, ['canopy.json'], async (dir, signal) => {
            const paramArgs = flags.filter((_, i, all) => !(all[i] === '--cell' || all[i - 1] === '--cell'));
            await runFile(bin, ['canopy', '--tile', input, '--out', path.join(dir, 'canopy.json'), '--cell', String(cell), ...paramArgs], timeoutMs, signal);
            const mask = JSON.parse(fs.readFileSync(path.join(dir, 'canopy.json'), 'utf8'));
            const problems = validateContract('CanopyMask', mask);
            if (problems.length) throw new TileVegetationError('failed', `tile_vegetation canopy wrote a mask that is not a CanopyMask: ${problems.slice(0, 5).join('; ')}`);
        }, (dir, cached) => ({
            mask: JSON.parse(fs.readFileSync(path.join(dir, 'canopy.json'), 'utf8')) as CanopyMask,
            cached,
            ms: 0,
            cacheKey: key
        }), req.signal);
        return { ...res, ms: Date.now() - t0 };
    }

    async plant(req: TileVegetationPlantRequest): Promise<TileVegetationPlantResult> {
        const t0 = Date.now();
        const crowns = this.resolveInput(req.crownsPath, 'crownsPath', '.json');
        const support = req.supportMeshPath !== undefined ? this.resolveInput(req.supportMeshPath, 'supportMeshPath', '.glb') : undefined;
        const ground = req.groundMeshPath !== undefined ? this.resolveInput(req.groundMeshPath, 'groundMeshPath', '.glb') : undefined;
        if ((req.triangleBudget === undefined) === (req.sceneTriangleCap === undefined)) throw new TileVegetationError('bad_request', 'give exactly one of triangleBudget (the caller\'s own) and sceneTriangleCap (size the trees from their crowns)');
        if (req.triangleBudget !== undefined && !(Number.isFinite(req.triangleBudget) && req.triangleBudget >= 1)) throw new TileVegetationError('bad_request', 'triangleBudget must be a number of at least 1');
        if (req.sceneTriangleCap !== undefined && !(Number.isFinite(req.sceneTriangleCap) && req.sceneTriangleCap >= 1)) throw new TileVegetationError('bad_request', 'sceneTriangleCap must be a number of at least 1');
        const budget = req.triangleBudget !== undefined ? { triangleBudget: Math.floor(req.triangleBudget) } : { sceneTriangleCap: Math.floor(req.sceneTriangleCap!) };
        if (typeof req.seed !== 'string' || !/^[0-9a-fA-F]{1,16}$/.test(req.seed)) throw new TileVegetationError('bad_request', 'seed must be 1-16 hex digits');
        const heroRoi = req.heroRoi === undefined ? undefined : checkRoi(req.heroRoi);
        if (req.groundCover !== undefined) {
            if (!Array.isArray(req.groundCover)) throw new TileVegetationError('bad_request', 'groundCover must be an array of regions');
            for (const r of req.groundCover) {
                if (!r || !Array.isArray(r.loops) || !(Number.isFinite(r.density) && r.density >= 0 && r.density <= 1) || !(Number.isFinite(r.areaM2) && r.areaM2 >= 0) || !Array.isArray(r.labels)) {
                    throw new TileVegetationError('bad_request', 'each groundCover region needs loops (arrays of [x, z]), a density 0..1, an areaM2 >= 0 and labels');
                }
            }
        }
        const publishTarget = req.publishAs === undefined ? undefined : this.resolvePublishTarget(req.publishAs);
        const { flags, key: keyParams } = paramFlags(req.params);
        const timeoutMs = req.timeoutMs ?? this.defaultTimeoutMs;
        const bin = await this.ensureBinary();
        const hash = crypto.createHash('sha256').update(CACHE_VERSION).update('\0plant\0').update(this.hashBinary(bin)).update('\0');
        sha256File(crowns, hash);
        let correction: string | undefined;
        if (typeof req.crownCorrectionPath === 'string') correction = this.resolveInput(req.crownCorrectionPath, 'crownCorrectionPath', '.json');
        else if (req.crownCorrectionPath !== false) {
            const recorded = crownCorrectionPathFor(this.workspaceRoot, fileSha256(crowns));
            if (fs.existsSync(recorded)) correction = recorded;
        }
        if (correction) { hash.update('\0correction\0'); sha256File(correction, hash); }
        hash.update('\0');
        if (support) sha256File(support, hash);
        hash.update('\0');
        if (ground) sha256File(ground, hash);
        if (req.quantize !== undefined && typeof req.quantize !== 'boolean') throw new TileVegetationError('bad_request', 'quantize must be a boolean');
        if (req.reveal !== undefined && typeof req.reveal !== 'boolean') throw new TileVegetationError('bad_request', 'reveal must be a boolean');
        const quantize = req.quantize ?? true;
        const reveal = req.reveal ?? true;
        if (req.textures !== undefined && typeof req.textures !== 'boolean') throw new TileVegetationError('bad_request', 'textures must be a boolean');
        const textureIndex = req.textures === false ? undefined : treeTextureIndexPath(this.repoRoot);
        hash.update('\0');
        if (textureIndex) sha256File(textureIndex, hash);
        if (req.species !== undefined && typeof req.species !== 'boolean') throw new TileVegetationError('bad_request', 'species must be a boolean');
        const speciesIndex = req.species === false ? undefined : treeSpeciesIndexPath(this.repoRoot);
        hash.update('\0species\0');
        if (speciesIndex) sha256File(speciesIndex, hash);
        hash.update('\0').update(JSON.stringify({ ...keyParams, ...budget, seed: req.seed.toLowerCase(), quantize, reveal, ...(heroRoi ? { heroRoi: heroRoi.polygon } : {}) }));
        const key = hash.digest('hex');
        const plantOnce = () => this.cached(key, ['trees.glb', 'stats.json'], async (dir, signal) => {
            // the stage key in the GLB's root extras is this cache key: the same bytes in every run that reuses them
            const args = ['plant', '--crowns', crowns, '--out', path.join(dir, 'trees.glb'), '--stats', path.join(dir, 'stats.json'),
                ...('triangleBudget' in budget ? ['--triangle-budget', String(budget.triangleBudget)] : ['--scene-triangle-cap', String(budget.sceneTriangleCap)]),
                '--seed', req.seed, '--quantize', quantize ? '1' : '0', '--reveal', reveal ? '1' : '0', '--stage-key', key, ...flags];
            if (support) args.push('--support-mesh', support);
            if (ground) args.push('--ground-mesh', ground);
            if (heroRoi) {
                fs.writeFileSync(path.join(dir, 'hero-roi.json'), JSON.stringify(heroRoi));
                args.push('--hero-roi-json', path.join(dir, 'hero-roi.json'));
            }
            if (correction) args.push('--crown-correction', correction);
            if (textureIndex) args.push('--texture-index', textureIndex, '--texture-index-label', TREE_TEXTURE_INDEX);
            if (speciesIndex) args.push('--species-index', speciesIndex, '--species-index-label', TREE_SPECIES_INDEX);
            if (req.threads !== undefined) args.push('--threads', String(req.threads));
            await runFile(bin, args, timeoutMs, signal);
        }, (dir, cached) => ({
            treesGlb: path.join(dir, 'trees.glb'),
            stats: JSON.parse(fs.readFileSync(path.join(dir, 'stats.json'), 'utf8')),
            cached,
            ms: 0,
            cacheKey: key
        }), req.signal);
        let res = await plantOnce();
        // a trees GLB whose bounds no real place can have would poison everything that stands on or near it (placement
        // reads it as covering every spot): a cached one is a stale or corrupt entry and is rebuilt once; a fresh one is refused
        let problem = treesGlbBoundsProblem(res.treesGlb);
        let rebuiltStaleCache: string | undefined;
        if (problem && res.cached) {
            rebuiltStaleCache = `the cached trees ${key.slice(0, 8)} were rebuilt because ${problem}`;
            fs.rmSync(path.join(this.cacheDir, key), { recursive: true, force: true });
            res = await plantOnce();
            problem = treesGlbBoundsProblem(res.treesGlb);
        }
        if (problem) throw new TileVegetationError('plant_failed', `the planted trees were refused because ${problem}${rebuiltStaleCache ? ' (also after rebuilding the cached entry)' : ''}`);
        const out: TileVegetationPlantResult = { ...res, ms: 0, ...(rebuiltStaleCache ? { rebuiltStaleCache } : {}) };
        if (correction) {
            const doc = JSON.parse(fs.readFileSync(correction, 'utf8')) as { median?: { widthScale: number; crownBaseRatio: number } };
            const per = Array.isArray(res.stats.perTree) ? res.stats.perTree as Array<{ crownCorrection?: { source?: string } }> : [];
            const applied = per.filter(t => t.crownCorrection);
            out.crownCorrection = {
                path: correction, provenance: 'photo-inferred', trees: applied.length, fromPhotos: applied.filter(t => t.crownCorrection!.source === 'photo').length,
                ...(doc.median ? { median: { widthScale: doc.median.widthScale, crownBaseRatio: doc.median.crownBaseRatio } } : {})
            };
        }
        if (req.groundCover !== undefined) out.groundCover = { regions: req.groundCover.length, areaM2: req.groundCover.reduce((a, r) => a + r.areaM2, 0), planted: 0, reason: GROUND_COVER_UNSUPPORTED };
        if (publishTarget) out.published = this.publish(res.treesGlb, publishTarget);
        out.ms = Date.now() - t0;
        return out;
    }

    /**
     * Grows trees described by measurements (an imagined scene's, a single requested tree) with the staged location's
     * planting: tile_vegetation grow (scratchbox_sb_veggie_grove.hpp), the species and texture libraries of this checkout.
     */
    async grow(req: TileVegetationGrowRequest): Promise<TileVegetationGrowResult> {
        const t0 = Date.now();
        if (!Array.isArray(req.trees) || req.trees.length === 0) throw new TileVegetationError('bad_request', 'grow needs at least one described tree');
        if (req.triangleBudget !== undefined && !(Number.isFinite(req.triangleBudget) && req.triangleBudget >= 1)) throw new TileVegetationError('bad_request', 'triangleBudget must be a number of at least 1');
        if (req.psiSeason !== undefined && !(req.psiSeason >= 0 && req.psiSeason <= 1)) throw new TileVegetationError('bad_request', 'psiSeason must be in [0, 1]');
        const doc = JSON.stringify({ schema: 'scratchbox.sb-veggie-trees/1', ...(req.label ? { label: String(req.label).slice(0, 200) } : {}), trees: req.trees });
        const seed = req.seed ?? crypto.createHash('sha256').update(doc).digest('hex').slice(0, 16);
        if (!/^[0-9a-fA-F]{1,16}$/.test(seed)) throw new TileVegetationError('bad_request', 'seed must be 1-16 hex digits');
        const quantize = req.quantize ?? true;
        const lod = req.lod ?? true;
        const timeoutMs = req.timeoutMs ?? this.defaultTimeoutMs;
        const bin = await this.ensureBinary();
        const textureIndex = treeTextureIndexPath(this.repoRoot);
        const speciesIndex = treeSpeciesIndexPath(this.repoRoot);
        const hash = crypto.createHash('sha256').update(CACHE_VERSION).update('\0grow\0').update(this.hashBinary(bin)).update('\0').update(doc);
        hash.update('\0');
        if (textureIndex) sha256File(textureIndex, hash);
        hash.update('\0species\0');
        if (speciesIndex) sha256File(speciesIndex, hash);
        hash.update('\0').update(JSON.stringify({ seed: seed.toLowerCase(), quantize, lod, budget: req.triangleBudget ?? null, psi: req.psiSeason ?? null }));
        const key = hash.digest('hex');
        const res = await this.cached(key, ['trees.glb', 'stats.json', 'crowns.json'], async (dir, signal) => {
            fs.writeFileSync(path.join(dir, 'trees.request.json'), doc);
            const args = ['grow', '--trees', path.join(dir, 'trees.request.json'), '--out', path.join(dir, 'trees.glb'), '--stats', path.join(dir, 'stats.json'),
                '--crowns-out', path.join(dir, 'crowns.json'), '--seed', seed, '--quantize', quantize ? '1' : '0', '--lod', lod ? '1' : '0', '--stage-key', key];
            if (req.triangleBudget !== undefined) args.push('--triangle-budget', String(Math.floor(req.triangleBudget)));
            if (req.psiSeason !== undefined) args.push('--psi-season', String(req.psiSeason));
            if (textureIndex) args.push('--texture-index', textureIndex, '--texture-index-label', TREE_TEXTURE_INDEX);
            if (speciesIndex) args.push('--species-index', speciesIndex, '--species-index-label', TREE_SPECIES_INDEX);
            await runFile(bin, args, timeoutMs, signal);
        }, (dir, cached) => ({
            treesGlb: path.join(dir, 'trees.glb'),
            crownsJson: path.join(dir, 'crowns.json'),
            stats: JSON.parse(fs.readFileSync(path.join(dir, 'stats.json'), 'utf8')),
            seed,
            cached,
            ms: 0,
            cacheKey: key
        }), req.signal);
        const problem = treesGlbBoundsProblem(res.treesGlb);
        if (problem) throw new TileVegetationError('plant_failed', `the grown trees were refused because ${problem}`);
        return { ...res, ms: Date.now() - t0 };
    }

    private resolvePublishTarget(name: string): string {
        if (typeof name !== 'string' || !PUBLISH_FILE.test(name)) throw new TileVegetationError('bad_request', 'publishAs must be a plain *.glb file name');
        return resolveWithinRoot(resolveWithinRoot(this.workspaceRoot, path.join('public', 'models')), name);
    }

    private publish(source: string, target: string): { path: string; url: string; backup?: string } {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        let backup: string | undefined;
        if (fs.existsSync(target) && fileSha256(target) !== fileSha256(source)) {
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const dest = resolveWithinRoot(this.workspaceRoot, path.join('.scratchbox', 'backup', 'pre_tile_vegetation', stamp, path.basename(target)));
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.copyFileSync(target, dest);
            backup = path.relative(this.workspaceRoot, dest);
        }
        const tmp = `${target}.tmp-${process.pid}`;
        fs.copyFileSync(source, tmp);
        fs.renameSync(tmp, target);
        const publicDir = resolveWithinRoot(this.workspaceRoot, 'public');
        return { path: path.relative(this.workspaceRoot, target), url: '/' + path.relative(publicDir, target).split(path.sep).join('/'), ...(backup ? { backup } : {}) };
    }
}

/**
 * Why a trees GLB cannot be staged (its world bounds, instances included, are physically impossible), or undefined. A
 * GLB with no triangles (every crown kept as scanned: only its LINES rings) has nothing to judge.
 */
export function treesGlbBoundsProblem(file: string): string | undefined {
    const bounds = glbWorldBounds(fs.readFileSync(file));
    return bounds ? implausibleLayerBounds(bounds) : undefined;
}

const services = new Map<string, TileVegetationService>();

/** One service per workspace root, so concurrent identical requests share a run and a build. */
export function getTileVegetationService(workspaceRoot: string): TileVegetationService {
    const root = resolveWithinRoot(workspaceRoot, '.');
    let svc = services.get(root);
    if (!svc) {
        svc = new TileVegetationService({ workspaceRoot: root });
        services.set(root, svc);
    }
    return svc;
}
