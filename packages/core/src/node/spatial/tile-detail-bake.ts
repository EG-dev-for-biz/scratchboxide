/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Tile detail bake: finer surface detail on a scan's photo atlases, from the building's own survey swatches.
 *   1. Swatches: survey_harvest_swatches' harvest (survey-swatch-harvest.ts) of the place's tiles: survey stations through
 *      AI Beautify, rectified into tileable swatches at a measured metres-per-pixel, kept only on the building itself. A
 *      harvest already in the work folder is reused (keyed by the tiles GLB's bytes).
 *   2. Bake: MaterialDetailBaker on the target GLB (the tiles, or pipeline K's twin): its plane clusters matched to the
 *      swatches by measured colour, tilt and height, each atlas upscaled 2x or 4x and given only the band of detail the
 *      tile cannot carry, at the swatch's real size; the tile's own detail and colour kept, a block that would lose
 *      sharpness reverted, an atlas without a measurable gain kept as it was.
 *   3. Labels: every replaced image says it is `generated` (images[i].extras.sbDetailBake), the scene says how much it
 *      covers (asset.extras.sbDetailBake), and a staged twin's texture provenance gains the entry.
 * Nothing moves geometry or UVs. A place with no usable swatch, or an atlas the swatches do not sharpen, is left as it was
 * and the report says why.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import {
    bakeMaterialDetail, buildPlaneClusters, classifyClusters, describeClusters, loadBaseScan, LinearImageCache, mergeCoplanarClusters,
    type BakeOptions, type PrimitiveBakeReport
} from './MaterialDetailBaker';
import { cachedGeminiSegmenter, type MaterialLibrary, type MaterialSegmenter } from './StreetViewMaterialHarvester';
import { SurveyStationRenderService } from './SurveyStationRenderService';
import { BeautifyStationService, createDefaultStationImageGenerator } from './BeautifyStationService';
import { GoogleMediaCredentialsService } from '../google-media-credentials-service';
import { harvestSurveySwatches, type StationBeautifier, type SurveySwatchHarvestResult } from './survey-swatch-harvest';
import { buildGroundModel, loadScanMesh } from './StreetViewSurveyPlanner';

export const TILE_DETAIL_BAKE_VERSION = 'tile-detail-bake/1';
/** The swatch library kept to the building (survey swatches on its own footprint), beside the harvest's library.json. */
export const SUBJECT_LIBRARY_FILE = 'subject_library.json';
/** The harvest's station plan; a harvest from an older plan is not reused (stations/2: the standoff from the wall, not the centroid). */
export const SWATCH_STATIONS_VERSION = 'stations/2';
/**
 * A photo scan's own high band is mostly compression noise, so a confident swatch match keeps its detail there (BakeOptions
 * confidenceGate); and an atlas whose detail would cover less than this share of it is kept, not doubled in size for it.
 */
export const DETAIL_CONFIDENCE_GATE = 1;
export const DETAIL_MIN_COVERAGE = 0.02;
/** Bytes the bake may add to the scan (the larger atlases), unless the caller sets its own budget. */
export const DETAIL_BUDGET_BYTES = 45 * 1024 * 1024;

export interface TileDetailImageReport {
    image: number;
    replaced: boolean;
    reason?: string;
    scale: number;
    size: [number, number];
    /** Share of the atlas's chart texels that received swatch detail (alpha-weighted). */
    coverage: number;
    /** Laplacian variance of the result over its detail texels, against the bicubic upscale of the tile. */
    sharpnessRatio: number | null;
    materials: Array<{ label: string; sample: string; areaM2: number }>;
}

export interface TileDetailBakeReport {
    version: string;
    label: 'generated';
    library: string;
    swatches: number;
    images: number;
    replaced: number;
    /** Surface of the target (m^2) and the part that received detail (alpha-weighted, replaced atlases only). */
    areaM2: number;
    coveredAreaM2: number;
    /** Share of the textured surface given detail (the twin's provenance coverage). */
    coverage: number;
    bytesIn: number;
    bytesOut: number;
    perImage: TileDetailImageReport[];
    /** Set when nothing could be baked: no swatch, no cluster matched, or no atlas gained. */
    skipped?: string;
}

const imageReport = (r: PrimitiveBakeReport): TileDetailImageReport => ({
    image: r.imageIndex, replaced: r.replaced, ...(r.reason ? { reason: r.reason } : {}), scale: r.scale, size: r.outputSize,
    coverage: r.coverageFraction, sharpnessRatio: r.sharpness?.ratio ?? null, materials: r.materials
});

/** The provenance entry a staged twin lists for the bake (asset.extras.sbTexture.provenance and the layer's provenance). */
export const detailBakeProvenance = (report: Pick<TileDetailBakeReport, 'library' | 'coverage'>) => ({ source: 'tile-detail-bake', label: 'generated' as const, method: method(report.library), coverage: report.coverage });

const method = (lib: string) => `survey swatches (AI Beautify images of the tiles, ${path.basename(path.dirname(lib))}) baked as the detail band the tile cannot carry, at their real size; the tile's own colour and detail kept`;

/**
 * Bakes a swatch library's detail into a GLB's photo atlases and labels what changed (see the file comment). `ground` (a
 * tiles GLB) gives each surface its height above the terrain, which the swatch match weighs; without it height is ignored.
 */
export async function bakeTileDetail(input: {
    glb: string | Uint8Array; libraryPath: string; ground?: string; workDir?: string; bake?: BakeOptions; log?: (m: string) => void;
}): Promise<{ glb: Buffer; report: TileDetailBakeReport }> {
    const log = input.log ?? (() => undefined);
    let glbPath = typeof input.glb === 'string' ? input.glb : '';
    if (!glbPath) {
        const dir = input.workDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'sb-detail-bake-'));
        fs.mkdirSync(dir, { recursive: true });
        glbPath = path.join(dir, 'detail_bake_input.glb');
        fs.writeFileSync(glbPath, input.glb as Uint8Array);
    }
    const library: MaterialLibrary = JSON.parse(fs.readFileSync(input.libraryPath, 'utf8'));
    const scan = loadBaseScan(glbPath);
    const base: Omit<TileDetailBakeReport, 'replaced' | 'coveredAreaM2' | 'coverage' | 'bytesOut' | 'perImage'> = {
        version: TILE_DETAIL_BAKE_VERSION, label: 'generated', library: input.libraryPath, swatches: library.samples.length,
        images: scan.imageBytes.filter(Boolean).length, areaM2: 0, bytesIn: fs.statSync(glbPath).size
    };
    const unchanged = (skipped: string) => {
        log(`detail bake: nothing baked (${skipped})`);
        return { glb: fs.readFileSync(glbPath), report: { ...base, replaced: 0, coveredAreaM2: 0, coverage: 0, bytesOut: base.bytesIn, perImage: [], skipped } };
    };
    if (!library.samples.length) return unchanged('the place gave no usable swatch');
    // whole planes: the scan's fragments of one wall joined, so a swatch is matched and projected across the wall at once
    const grown = buildPlaneClusters(scan);
    const { triCluster, clusters, merged } = mergeCoplanarClusters(grown.triCluster, grown.clusters);
    const images = new LinearImageCache(scan);
    const ground = input.ground ? buildGroundModel(loadScanMesh(input.ground)) : undefined;
    await describeClusters(scan, triCluster, clusters, images, ground ? (x, z) => ground.groundAt(x, z) : undefined);
    const assignments = classifyClusters(clusters, library);
    log(`detail bake: ${grown.clusters.length} plane fragments joined into ${clusters.length} planes (${merged} joined), ${assignments.length} matched to ${library.samples.length} swatches`);
    if (!assignments.length) return unchanged('no surface matched a swatch by colour, tilt and height');
    const libDir = path.dirname(input.libraryPath);
    // the textured surface (m^2): the share of it given detail is the twin's provenance coverage
    let total = 0;
    for (const p of scan.prims) {
        if (p.imageIndex === null || !p.uvs) continue;
        const P = p.positions, I = p.indices;
        for (let t = 0; t < I.length; t += 3) {
            const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
            const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
            total += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
        }
    }
    const r = await bakeMaterialDetail(scan, triCluster, clusters, assignments, library, libDir, images, {
        // room for the added detail on top of what the scan already weighs (the baker's own default is 45 MB in all)
        budgetBytes: base.bytesIn + DETAIL_BUDGET_BYTES, confidenceGate: DETAIL_CONFIDENCE_GATE, minCoverageFraction: DETAIL_MIN_COVERAGE, ...input.bake, log,
        annotate: (json, replaced) => {
            let covered = 0;
            for (const [ii, rep] of replaced) {
                const img = json.images[ii];
                img.extras = {
                    ...(img.extras ?? {}),
                    sbDetailBake: {
                        version: TILE_DETAIL_BAKE_VERSION, label: 'generated', source: method(input.libraryPath), scale: rep.scale,
                        coverage: rep.coverageFraction, sharpnessRatio: rep.sharpness?.ratio ?? null, materials: rep.materials.map(m => m.label)
                    }
                };
                covered += rep.coveredAreaM2;
            }
            json.asset = json.asset ?? { version: '2.0' };
            const extras = json.asset.extras = json.asset.extras ?? {};
            extras.sbDetailBake = { version: TILE_DETAIL_BAKE_VERSION, label: 'generated', source: method(input.libraryPath), images: [...replaced.keys()], coveredAreaM2: +covered.toFixed(1) };
            // a staged twin lists its texture sources: the detail joins them, by the share of the surface it covers
            const prov = extras.sbTexture?.provenance;
            if (Array.isArray(prov) && replaced.size) prov.push(detailBakeProvenance({ library: input.libraryPath, coverage: total > 0 ? +Math.min(1, covered / total).toFixed(4) : 0 }));
        }
    });
    const perImage = r.reports.map(imageReport);
    const report: TileDetailBakeReport = { ...base, areaM2: r.totals.areaM2, replaced: r.totals.replaced, coveredAreaM2: r.totals.coveredAreaM2, coverage: total > 0 ? +Math.min(1, r.totals.coveredAreaM2 / total).toFixed(4) : 0, bytesOut: r.glb.length, perImage };
    if (!r.totals.replaced) {
        // nothing replaced: the scan as it came, byte for byte (not a repack of it)
        report.skipped = 'no atlas gained measurable sharpness from the swatches';
        log('detail bake: no atlas replaced');
        return { glb: fs.readFileSync(glbPath), report: { ...report, bytesOut: base.bytesIn } };
    }
    log(`detail bake: ${r.totals.replaced} of ${r.totals.images} atlases replaced, ${r.totals.coveredAreaM2} of ${r.totals.areaM2} m2 given detail`);
    return { glb: r.glb, report };
}

/** Images in a GLB's JSON chunk (0 when it has none or is not a GLB). */
export function glbImageCount(glb: Uint8Array): number {
    const b = Buffer.from(glb.buffer, glb.byteOffset, glb.byteLength);
    if (b.length < 20 || b.readUInt32LE(0) !== 0x46546c67) return 0;
    try { return (JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString('utf8')).images ?? []).length; } catch { return 0; }
}

/** The services a harvest needs: the segmenter (vision model) and, for detail finer than the tile, AI Beautify. */
export interface SwatchServices { segmenter: (cacheDir: string) => MaterialSegmenter; beautifier?: (tilesGlb: string) => Promise<StationBeautifier> }

/**
 * The building's swatch library: harvested once per tiles extraction into `workDir/<hash>` and kept to the building's own
 * surfaces (SUBJECT_LIBRARY_FILE); a later call with the same tiles reuses it.
 */
export async function subjectSwatchLibrary(input: {
    tilesGlb: string; lat: number; lng: number; place: string; workDir: string; services: SwatchServices;
    log?: (m: string) => void; signal?: AbortSignal;
}): Promise<{ libraryPath: string; reused: boolean; harvest?: SurveySwatchHarvestResult }> {
    const tilesBytes = fs.readFileSync(input.tilesGlb);
    // the survey renders the tiles' photos: a clay layer (no images) renders grey, and AI Beautify then draws a whole
    // invented photo of the place instead of restyling the view, so nothing is spent on it
    if (!(glbImageCount(tilesBytes) > 0)) throw new Error(`${input.tilesGlb} has no photo textures (a clay layer?): the swatch harvest needs the place's textured tiles`);
    const hash = createHash('sha256').update(SWATCH_STATIONS_VERSION).update(tilesBytes).digest('hex').slice(0, 12);
    const outDir = path.join(input.workDir, `swatches_${hash}`);
    const subject = path.join(outDir, SUBJECT_LIBRARY_FILE);
    if (fs.existsSync(subject)) return { libraryPath: subject, reused: true };
    fs.mkdirSync(outDir, { recursive: true });
    const beautifier = input.services.beautifier ? await input.services.beautifier(input.tilesGlb) : undefined;
    const harvest = await harvestSurveySwatches({
        tileGlb: input.tilesGlb, anchor: { lat: input.lat, lng: input.lng, elevationMeters: 0 }, place: input.place, outDir,
        segmenter: input.services.segmenter(path.join(outDir, 'segmentation')), ...(beautifier ? { beautifier } : {}),
        subjectOnly: true, ...(input.log ? { log: input.log } : {}), ...(input.signal ? { signal: input.signal } : {})
    });
    const library: MaterialLibrary = JSON.parse(fs.readFileSync(harvest.libraryPath, 'utf8'));
    const keep = new Set(harvest.swatches.map(s => s.id));
    fs.writeFileSync(subject, JSON.stringify({ ...library, samples: library.samples.filter(s => keep.has(s.id)) }, null, 2));
    return { libraryPath: subject, reused: false, harvest };
}

/**
 * The app's services for a harvest: the Vertex vision model as the segmenter and, unless `beautify` is false, AI Beautify on
 * every survey station (one image call each; without it the swatches are tile renders, no finer than the tile).
 */
export async function defaultSwatchServices(workspaceRoot: string, opts: { beautify?: boolean } = {}): Promise<SwatchServices> {
    const vision = await new GoogleMediaCredentialsService().createVertexClient();
    return {
        segmenter: cacheDir => cachedGeminiSegmenter(vision as never, cacheDir, { allowNetwork: true }),
        ...(opts.beautify === false ? {} : {
            beautifier: async (tilesGlb: string) => {
                const renderer = new SurveyStationRenderService();
                await renderer.loadMesh(tilesGlb);
                return new BeautifyStationService(renderer, createDefaultStationImageGenerator({ workspaceRoot, imageSize: '2K' })) as unknown as StationBeautifier;
            }
        })
    };
}
