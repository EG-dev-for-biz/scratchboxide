/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The staged-location texture pass for one layer (docs/processes/staged_location_texture_pass_design.md): the degrade
 * ladder end to end, from a clay GLB to its textured twin.
 *
 *   B  buildUvAtlas (fitted charts / native island atlas)
 *   C  bakeStreetViewProjection from the registered grounding views (rungs 0 and 1)
 *   D  transferTilePhoto from the photo-textured tile, fused under C's texels (rung 2), then the optional model
 *      enhancement of the transferred texels behind its edge gate (still rung 2, source 'tile-photo-enhanced')
 *   A  photo tier A (photo-tier-rectify.ts): real Street View pixels rectified onto the fitted planar faces (rung 0, or 1
 *      where one view covers a texel), over C and D's texels where it has them; relief the faces do not carry is left
 *   -  flat measured-palette colour for texels nothing real covers (rung 3)
 *   -  generated tileable PBR (rung 4) is NOT available: recorded as a degradation, those texels stay at the palette
 *      rung; pbr_synthesize_material is never called
 *   -  clay (rung 5) for texels with no palette either
 *   B  writeTexturedTwinGlb
 *
 * Each failing source moves its texels one rung down with a degradation entry carrying the real reason. Nothing is
 * invented: every texel is labelled (provenance coverage is recomputed from the confidence plane and sums to 1).
 * Images are decoded in memory; the only file is the twin the caller publishes.
 */

import type { Vec3 } from '../../../common/spatial/staged-location-contracts';
import {
    packConfidenceTexel, TEXTURE_LADDER_RUNGS, TEXTURE_RUNG_CLAY, unpackConfidenceTexel,
    type BakedTexturePlanes, type ConfidencePlane, type ProjectionView, type TexelProvenance, type TextureLayerBundle, type TexturePassDegradation
} from '../../../common/spatial/texture-pass-contracts';
import { linearToSrgb255, SRGB8_TO_LINEAR } from '../../../common/spatial/photogrammetric-delight';
import type { RenderMesh3D } from '../../spatial/HeadlessMeshSilhouetteRenderer';
import { CONFIDENCE_CHANNELS, writeTexturedTwinGlb } from './staged-glb-writer';
import { linearToLab } from './texel-exposure';
import { enhanceTransferredAtlas, type EnhanceModelClient, type EnhanceReferenceView } from './texture-enhance';
import { bakeStreetViewProjection, type ProjectionBakeReport, type ProjectionDelightOptions } from './texture-projection';
import { depthForMesh, projectionViewFromRegistered } from './texture-projection-views';
import type { Registration } from './pano-registration';
import type { EvidenceImage } from './streetview-evidence';
import { buildUvAtlas, type LaidOutUvAtlas } from './texture-uv';
import { mergeBakedPlanes, transferTilePhoto, type TileTextureSurface } from './tile-texture-transfer';
import { createPhotoTierCache, mergePhotoTier, rectifyPhotoTier } from './photo-tier-rectify';
import type { PhotoTierLayerRecord } from '../../../common/spatial/texture-pass-contracts';
import { describeLayerFit, leaveOnePanoOut, measureLayerFit, type LayerFit, type LooFit } from './texture-fit-metric';
import { measureScanDeviation, type ScanDeviation } from './scan-deviation';
import { round5Enabled } from './round5-switch';

/** Part of every texture cache key: a change to the pass's maths is a new version. */
export const TEXTURE_PASS_VERSION = `texture-pass/9${process.env.SCRATCHBOX_PHOTO_TIER_OFF === '1' ? '+tier-off' : ''}`;
export const RUNG_PALETTE = 3;
export const RUNG_GENERATED_PBR = 4;
/** The enhancement rung's own time budget per layer (layers run in parallel inside the stage's 600 s). */
export const ENHANCE_BUDGET_MS = 150_000;
/** View selection: incidence floor (cos 68 degrees: grazing views smear the stone), resolution floor (view GSD at most ~7 texels), photo-consistency outlier distance (CIE76). */
export const VIEW_MIN_COS_INCIDENCE = 0.375;
export const VIEW_MIN_RESOLUTION = 0.15;
export const VIEW_OUTLIER_DELTA_E = 14;
/** 18% studio grey clay (sb.PbrMaterial.clay()), linear. */
const CLAY_LINEAR: Vec3 = [0.55, 0.57, 0.60];

/** One face's measured palette (the survey's FacePalette, top colours first). */
export interface PaletteFace { headingDeg: number; colours: Array<{ srgb: Vec3; share: number }> }

export interface TextureLayerInput {
    layerKey: string;
    clayGlb: Uint8Array;
    /** Fitted surfaces with analytic charts (fitted layers); absent for the scan. */
    surfaces?: Parameters<typeof buildUvAtlas>[0]['surfaces'];
}

export interface TexturePassSources {
    /** Registered grounding views (C); empty when there are none, with the reason. */
    views: ProjectionView[];
    viewsUnavailable?: string;
    /** Occluder for C's depth test: the scan (the remeshed layer). */
    occluder?: RenderMesh3D;
    /**
     * The full photogrammetric tile mesh (real openings, statues, trees, the buildings behind): C's visibility also against
     * it, so what stands in front of a wall or behind an opening is never painted on the wall (contextDepthFor).
     */
    context?: RenderMesh3D;
    /** C's observed-surface check against the occluder (texture-projection.ts ProjectionBakeOptions.observedSurface). */
    observedSurface?: { baseM: number; perMeter: number };
    /** C's pose-aware depth-edge guard (texture-projection.ts ProjectionBakeOptions.poseEdgeGuardShare). */
    poseEdgeGuardShare?: number;
    /** De-light options for C (place; solar per view when its capture time is known). */
    delight?: ProjectionDelightOptions;
    /** The photo-textured tile surface (D); absent with the reason. */
    tile?: TileTextureSurface;
    tileUnavailable?: string;
    /** Registration residual (m) for D's distance gate max(0.25, 2 * residual). */
    registrationResidualM?: number;
    /** Optional model enhancement of D's texels; absent = the rung is not attempted, with the reason. */
    enhance?: { client: EnhanceModelClient; models?: string[]; budgetMs?: number };
    enhanceUnavailable?: string;
    /**
     * Photo tier A (photo-tier-rectify.ts): rectified Street View pixels on the fitted planar faces, above the projection.
     * Runs when there are views, fitted surfaces and the tile mesh (`context`); `false` turns it off (with the reason).
     */
    photoTier?: false | { pythonExecutable?: string; timeoutMs?: number; heldOut?: boolean };
    photoTierUnavailable?: string;
    /** More registered views for photo tier A only (whole-face survey and ring views: its outline anchors). */
    photoTierViews?: ProjectionView[];
    /** The survey's measured palettes. */
    palette: PaletteFace[];
    /** Texel density and atlas size. */
    densityTexelsPerMeter: number;
    maxSide: number;
    islandNormalToleranceDeg?: number;
    signal?: AbortSignal;
    onProgress?: (message: string) => void;
}

export interface TextureLayerOutcome {
    layerKey: string;
    glb: Buffer;
    bundle: Omit<TextureLayerBundle, 'maps' | 'confidence'>;
    /** Share of the layer's atlas texels per rung (TEXTURE_LADDER_RUNGS order). */
    rungShares: number[];
    /** Texel counts per rung, the same order. */
    rungTexels: number[];
    atlasTexels: number;
    atlas: { width: number; height: number; texelsPerMeter: number; charts: number; islands: number };
    degradations: TexturePassDegradation[];
    projection?: Pick<ProjectionBakeReport, 'bakedTexels' | 'multiViewTexels' | 'maxSeamDeltaE' | 'p95SeamDeltaE' | 'delight' | 'outputSeam' | 'regions' | 'poisson' | 'context' | 'timingsMs'> & {
        views: number; paletteDeltaE?: number;
        /** The alignment's inter-view gradient NCC before and after, kept shifts and whether it ran out of time. */
        alignment?: { nccBefore: number; nccAfter: number; kept: Record<string, number>; timedOut?: boolean; ms: number; /** Per view, the median search half-width (px). */ windowsPx?: number[] };
        /** The second pose registration: correspondence RMS before/after, panos applied, whether kept and why not. */
        poseRefine?: { rmsBeforeM: number; rmsAfterM: number; applied: number; kept?: boolean; reason?: string };
    };
    tileMethod?: string;
    /** Photo tier A on this layer (also in bundle.photoTier). */
    photoTier?: PhotoTierLayerRecord;
    enhance?: { charts: number; accepted: number; rejected: number; failed: number; timedOut?: number; modelsUsed: string[] };
    /** Held-out fit of the final textured layer against the Street View photos (texture-fit-metric.ts). */
    fit?: LayerFit;
    /** The leave-one-pano-out fit, to run once all layers are textured (texture-fit-metric.ts leaveOnePanoOut); not cached. */
    measureLoo?: (budgetMs?: number) => Promise<LooFit>;
    modelsUsed: string[];
    timingsMs: Record<string, number>;
}

function aborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : Object.assign(new Error('the texture pass was stopped'), { name: 'AbortError' });
}

function emptyPlanes(atlas: LaidOutUvAtlas): BakedTexturePlanes {
    const n = atlas.width * atlas.height;
    return {
        layerKey: atlas.layerKey, width: atlas.width, height: atlas.height, albedo: new Uint8Array(n * 4),
        confidence: { width: atlas.width, height: atlas.height, data: new Uint8Array(n * 4) }, provenance: [], degradations: []
    };
}

/** Texels the ladder must colour: covered and not gutter (gutters are bled by the writer). */
function targets(atlas: LaidOutUvAtlas): number[] {
    const out: number[] = [];
    for (let i = 0; i < atlas.width * atlas.height; i++) if (atlas.texels.covered[i] && !atlas.texels.gutter[i]) out.push(i);
    return out;
}

/** Heading (clockwise from north) of a horizontal-ish normal in the tile frame (x east, y up, z south). */
function headingOf(nx: number, nz: number): number {
    return ((Math.atan2(nx, -nz) * 180) / Math.PI + 360) % 360;
}

function angleBetween(a: number, b: number): number {
    const d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
}

/** The palette's colours as Lab with shares (for C's exposure gate). */
export function paletteLab(faces: PaletteFace[]): Array<{ lab: Vec3; share: number }> {
    const all = faces.flatMap(f => f.colours);
    const total = all.reduce((s, c) => s + c.share, 0) || 1;
    return all.map(c => ({
        lab: linearToLab(SRGB8_TO_LINEAR[Math.round(c.srgb[0])], SRGB8_TO_LINEAR[Math.round(c.srgb[1])], SRGB8_TO_LINEAR[Math.round(c.srgb[2])]),
        share: c.share / total
    }));
}

/**
 * Rung 3: the flat top colour of the measured palette of the face the texel faces (nearest face heading within 60
 * degrees for a wall-like normal), else the palette's overall dominant colour. Only texels `base` leaves uncovered.
 */
export function paletteFill(atlas: LaidOutUvAtlas, base: BakedTexturePlanes, faces: PaletteFace[]): BakedTexturePlanes {
    const out = emptyPlanes(atlas);
    const usable = faces.filter(f => f.colours.length);
    if (!usable.length) return out;
    const top = (f: PaletteFace) => [...f.colours].sort((a, b) => b.share - a.share)[0].srgb;
    // the overall dominant colour: weight each face's top colour by its share
    const overall = usable.map(f => ({ c: top(f), s: [...f.colours].sort((a, b) => b.share - a.share)[0].share })).sort((a, b) => b.s - a.s)[0].c;
    const N = atlas.texels.normal;
    let filled = 0, byFace = 0;
    for (const i of targets(atlas)) {
        if (base.albedo[i * 4 + 3]) continue;
        const nx = N[i * 3], ny = N[i * 3 + 1], nz = N[i * 3 + 2];
        let colour = overall;
        if (Math.abs(ny) < 0.7) {
            const h = headingOf(nx, nz);
            let best: PaletteFace | undefined, bestD = 60;
            for (const f of usable) { const d = angleBetween(h, f.headingDeg); if (d <= bestD) { bestD = d; best = f; } }
            if (best) { colour = top(best); byFace++; }
        }
        out.albedo.set([Math.round(colour[0]), Math.round(colour[1]), Math.round(colour[2]), 255], i * 4);
        packConfidenceTexel(out.confidence, i, 0, 0.05, RUNG_PALETTE);
        filled++;
    }
    const covered = countCovered(atlas);
    out.provenance = [{
        source: 'measured-palette', label: 'photo-inferred',
        method: `flat top colour of the survey's measured palette (Lab k-means, CIEDE2000), ${byFace} texels by the face they look toward, ${filled - byFace} by the dominant colour; texel-uniform`,
        coverage: covered ? filled / covered : 0
    }];
    return out;
}

function countCovered(atlas: LaidOutUvAtlas): number {
    let c = 0;
    for (let i = 0; i < atlas.width * atlas.height; i++) if (atlas.texels.covered[i] && !atlas.texels.gutter[i]) c++;
    return c;
}

/** Rung 5: studio grey clay for whatever is still uncovered. */
function clayFill(atlas: LaidOutUvAtlas, base: BakedTexturePlanes): BakedTexturePlanes {
    const out = emptyPlanes(atlas);
    const c = CLAY_LINEAR.map(v => Math.round(linearToSrgb255(v)));
    let filled = 0;
    for (const i of targets(atlas)) {
        if (base.albedo[i * 4 + 3]) continue;
        out.albedo.set([c[0], c[1], c[2], 255], i * 4);
        packConfidenceTexel(out.confidence, i, 0, 0, TEXTURE_RUNG_CLAY);
        filled++;
    }
    const covered = countCovered(atlas);
    out.provenance = [{ source: 'clay', label: 'clay', method: 'no real data reaches these texels: studio grey clay (18%)', coverage: covered ? filled / covered : 0 }];
    return out;
}

/** Recomputes every provenance entry's coverage, the rung counts and the layer rung from the confidence plane. */
export function measurePlanes(atlas: LaidOutUvAtlas, planes: BakedTexturePlanes): { provenance: TexelProvenance[]; rungTexels: number[]; rungShares: number[]; ladderRung: number; total: number } {
    const counts = new Array<number>(planes.provenance.length).fill(0);
    const rungTexels = new Array<number>(TEXTURE_LADDER_RUNGS.length).fill(0);
    let total = 0;
    for (const i of targets(atlas)) {
        total++;
        const c = unpackConfidenceTexel(planes.confidence, i);
        if (!c.covered || !planes.albedo[i * 4 + 3]) { rungTexels[TEXTURE_RUNG_CLAY]++; continue; }
        if (c.provenanceIndex < counts.length) counts[c.provenanceIndex]++;
        rungTexels[Math.min(TEXTURE_RUNG_CLAY, c.rung)]++;
    }
    const rungShares = rungTexels.map(t => (total ? t / total : 0));
    let ladderRung = 0;
    rungShares.forEach((s, r) => { if (s > 0.1) ladderRung = r; });
    return { provenance: planes.provenance.map((p, k) => ({ ...p, coverage: total ? counts[k] / total : 0 })), rungTexels, rungShares, ladderRung, total };
}

/** Runs the ladder for one layer and writes its textured twin. */
export async function textureLayer(layer: TextureLayerInput, src: TexturePassSources): Promise<TextureLayerOutcome> {
    const timingsMs: Record<string, number> = {};
    const degradations: TexturePassDegradation[] = [];
    const modelsUsed: string[] = [];
    const progress = (m: string) => src.onProgress?.(`${layer.layerKey}: ${m}`);
    let t = Date.now();

    // B: the atlas
    progress('laying out the UV atlas');
    const atlas = await buildUvAtlas({
        layerKey: layer.layerKey, clayGlb: layer.clayGlb, densityTexelsPerMeter: src.densityTexelsPerMeter, maxSide: src.maxSide,
        islandNormalToleranceDeg: src.islandNormalToleranceDeg ?? 30, ...(layer.surfaces ? { surfaces: layer.surfaces } : {})
    });
    timingsMs.uv = Date.now() - t;
    aborted(src.signal);
    let planes = emptyPlanes(atlas);
    let projection: TextureLayerOutcome['projection'];

    // where a fitted surface stands off the scan the photos show, they are not projected onto it (the scan carries them there)
    let offScan: ScanDeviation | undefined;
    if (layer.surfaces?.length && src.occluder && src.views.length && round5Enabled('offScan')) {
        t = Date.now();
        offScan = measureScanDeviation(atlas, src.occluder);
        timingsMs.scanDeviation = Date.now() - t;
        if (offScan.offTexels) {
            const share = offScan.offTexels / Math.max(1, countCovered(atlas));
            const noShare = offScan.noScanTexels / Math.max(1, countCovered(atlas));
            degradations.push({ stage: 'bake-projection', reasonCode: 'fitted_off_scan', layerKey: layer.layerKey, texelShare: share,
                reason: `${(100 * share).toFixed(1)} percent of the fitted surface stands more than ${Math.round(offScan.tolM * 100)} cm from the scan (median ${offScan.offMedianM !== null ? (offScan.offMedianM * 100).toFixed(0) : 'n/a'} cm, 95th percentile ${offScan.offP95M !== null ? (offScan.offP95M * 100).toFixed(0) : 'n/a'} cm). The photos show the scanned surface, so there they were sampled at the scan's surface under the texel (nearest scan point within ${Math.round(offScan.snapM * 100)} cm) and carried to the fitted surface, not projected onto it (the views would disagree by parallax).` });
            if (offScan.noScanTexels) degradations.push({ stage: 'bake-projection', reasonCode: 'fitted_without_scan', layerKey: layer.layerKey, fromRung: 0, toRung: 2, texelShare: noShare,
                reason: `${(100 * noShare).toFixed(1)} percent of the fitted surface has no scan within ${Math.round(offScan.snapM * 100)} cm (the fit closes or extends what the scan does not show), so no photo was projected there; those texels keep the tile photo or clay.` });
            progress(`${offScan.offTexels} of ${offScan.checked} fitted texels stand off the scan by more than ${Math.round(offScan.tolM * 100)} cm (median ${offScan.offMedianM} m): photos sampled at the scan under them; ${offScan.noScanTexels} with no scan near are not projected`);
        }
    }

    // C: Street View projection (rungs 0 and 1)
    t = Date.now();
    /** The same bake with another set of views (the leave-one-pano-out fit below). */
    let looBake: ((views: ProjectionView[]) => Promise<BakedTexturePlanes>) | undefined;
    if (src.views.length && src.occluder) {
        progress(`projecting ${src.views.length} Street View views`);
        try {
            // off-scan texels are projected from the scan's surface under them (same layout, positions moved)
            const projAtlas = offScan?.offTexels ? { ...atlas, texels: { ...atlas.texels, position: (() => { const pos = Float32Array.from(atlas.texels.position); for (let i = 0; i < offScan!.off.length; i++) if (offScan!.off[i] && !offScan!.noScan[i]) { pos[i * 3] = offScan!.onScan[i * 3]; pos[i * 3 + 1] = offScan!.onScan[i * 3 + 1]; pos[i * 3 + 2] = offScan!.onScan[i * 3 + 2]; } return pos; })() } } : atlas;
            looBake = views => bakeStreetViewProjection({ ...request, views });
            const request = {
                atlas: projAtlas, views: src.views, depthFor: depthForMesh(src.occluder), ...(src.context ? { contextDepthFor: depthForMesh(src.context) } : {}), paletteLab: src.palette.length ? paletteLab(src.palette) : undefined,
                signal: src.signal, options: {
                    // the tile photo is registered to the geometry, so the per-chart alignment uses it as its reference
                    ...(src.tile ? { alignReference: (P: Vec3, N: Vec3) => {
                        const c = src.tile!.sample(P, N, Math.max(0.25, 2 * (src.registrationResidualM ?? 0)))?.rgb; // sRGB 0..255
                        return c && [0, 1, 2].map(i => SRGB8_TO_LINEAR[Math.max(0, Math.min(255, Math.round(c[i])))]) as Vec3;
                    } } : {}),
                    ...(src.delight ? { delight: src.delight } : {}), ...(src.observedSurface ? { observedSurface: src.observedSurface } : {}), ...(src.poseEdgeGuardShare ? { poseEdgeGuardShare: src.poseEdgeGuardShare } : {}),
                    // view selection: no grazing or coarse views, photo-inconsistent views rejected per region (round 5)
                    ...(!round5Enabled('viewSelection') ? {} : { minCosIncidence: VIEW_MIN_COS_INCIDENCE, minResolution: VIEW_MIN_RESOLUTION, regionSelect: { outlierDeltaE: VIEW_OUTLIER_DELTA_E } }),
                    ...(offScan?.noScanTexels ? { excludeTexels: offScan.noScan } : {}) }
            };
            const res = await bakeStreetViewProjection(request);
            planes = res;
            degradations.push(...res.degradations);
            projection = {
                views: src.views.length, bakedTexels: res.report.bakedTexels, multiViewTexels: res.report.multiViewTexels,
                maxSeamDeltaE: res.report.maxSeamDeltaE, p95SeamDeltaE: res.report.p95SeamDeltaE, outputSeam: res.report.outputSeam, timingsMs: res.report.timingsMs,
                ...(res.report.regions ? { regions: res.report.regions } : {}), ...(res.report.poisson ? { poisson: res.report.poisson } : {}), ...(res.report.context ? { context: res.report.context } : {}),
                ...(res.report.alignment ? { alignment: { nccBefore: res.report.alignment.interViewGradNccBefore, nccAfter: res.report.alignment.interViewGradNccAfter, kept: res.report.alignment.kept, ms: res.report.alignment.ms, windowsPx: res.report.alignment.perView.map(v => v.windowPx ?? 0), ...(res.report.alignment.timedOut ? { timedOut: true } : {}) } } : {}),
                ...(res.report.poseRefine ? { poseRefine: { rmsBeforeM: res.report.poseRefine.rmsBeforeM, rmsAfterM: res.report.poseRefine.rmsAfterM, applied: res.report.poseRefine.applied, ...(res.report.poseRefine.kept !== undefined ? { kept: res.report.poseRefine.kept } : {}), ...(res.report.poseRefine.reason ? { reason: res.report.poseRefine.reason } : {}) } } : {}),
                ...(res.report.delight ? { delight: res.report.delight } : {}),
                ...(res.paletteDeltaE !== undefined ? { paletteDeltaE: res.paletteDeltaE } : {})
            };
        } catch (err) {
            if ((err as Error)?.name === 'AbortError' || src.signal?.aborted) throw err;
            degradations.push({ stage: 'bake-projection', reasonCode: 'projection_failed', layerKey: layer.layerKey, fromRung: 0, toRung: 2,
                reason: `The Street View projection failed (${(err as Error)?.message ?? String(err)}), so the tile photo colours this layer.` });
        }
    } else {
        degradations.push({ stage: 'bake-projection', reasonCode: src.views.length ? 'no_occluder' : 'no_street_view', layerKey: layer.layerKey, fromRung: 0, toRung: 2,
            reason: src.views.length ? 'There is no occluder mesh to depth-test the Street View views against, so they were not projected.'
                : `No registered Street View view is available (${src.viewsUnavailable ?? 'none was fetched'}), so the tile photo colours this layer.` });
    }
    timingsMs.projection = Date.now() - t;
    aborted(src.signal);

    // D: tile photo transfer under C, then the optional enhancement
    t = Date.now();
    let tileMethod: string | undefined;
    let enhance: TextureLayerOutcome['enhance'];
    if (src.tile) {
        progress('transferring the tile photo');
        try {
            const maxDistanceM = Math.max(0.25, 2 * (src.registrationResidualM ?? 0));
            let transfer = await transferTilePhoto({ atlas, tileSample: src.tile.sample, surface: src.tile, maxDistanceM, existing: planes, signal: src.signal } as Parameters<typeof transferTilePhoto>[0]);
            tileMethod = transfer.provenance[0]?.method;
            degradations.push(...transfer.degradations);
            timingsMs.tileTransfer = Date.now() - t;
            if (src.enhance) {
                const te = Date.now();
                progress('enhancing the transferred tile texels with an image model (edge-gated)');
                // the enhancement has its own time budget inside the stage's: past it the unenhanced transfer stands
                const budgetMs = src.enhance.budgetMs ?? ENHANCE_BUDGET_MS;
                // past the budget the charts already accepted stand and the rest keep the unenhanced transfer (enhanceTransferredAtlas)
                const budget = new AbortController();
                const timer = setTimeout(() => budget.abort(Object.assign(new Error(`the enhancement passed its ${Math.round(budgetMs / 1000)} s budget`), { name: 'TimeoutError' })), budgetMs);
                try {
                    const refs: EnhanceReferenceView[] = src.views.map(v => ({ panoId: v.panoId, camera: v.camera, image: v.image }));
                    const res = await enhanceTransferredAtlas({ atlas, transfer, views: refs, client: src.enhance.client, ...(src.enhance.models ? { models: src.enhance.models } : {}), signal: src.signal, budgetSignal: budget.signal });
                    const before = new Set(transfer.degradations);
                    degradations.push(...res.planes.degradations.filter(d => !before.has(d)));
                    transfer = res.planes;
                    modelsUsed.push(...res.modelsUsed);
                    enhance = {
                        charts: res.charts.length, accepted: res.charts.filter(c => c.decision === 'accepted').length, rejected: res.charts.filter(c => c.decision === 'rejected').length,
                        failed: res.charts.filter(c => c.decision === 'model_failed').length, timedOut: res.charts.filter(c => c.decision === 'timeout').length, modelsUsed: res.modelsUsed
                    };
                } catch (err) {
                    if (src.signal?.aborted) throw err;
                    degradations.push({ stage: 'enhance', reasonCode: 'enhance_failed', layerKey: layer.layerKey, reason: `The model enhancement failed (${(err as Error)?.message ?? String(err)}); the de-lit tile transfer stands unenhanced.` });
                } finally {
                    clearTimeout(timer);
                }
                timingsMs.enhance = Date.now() - te;
            } else if (src.enhanceUnavailable) {
                degradations.push({ stage: 'enhance', reasonCode: 'enhance_not_run', layerKey: layer.layerKey, reason: `The model enhancement was not run: ${src.enhanceUnavailable}.` });
            }
            planes = mergeBakedPlanes(planes, transfer);
        } catch (err) {
            if ((err as Error)?.name === 'AbortError' || src.signal?.aborted) throw err;
            degradations.push({ stage: 'tile-transfer', reasonCode: 'tile_transfer_failed', layerKey: layer.layerKey, fromRung: 2, toRung: RUNG_PALETTE,
                reason: `The tile photo transfer failed (${(err as Error)?.message ?? String(err)}), so the measured palette colours what Street View does not.` });
        }
    } else {
        degradations.push({ stage: 'tile-transfer', reasonCode: 'no_tile_photo', layerKey: layer.layerKey, fromRung: 2, toRung: RUNG_PALETTE,
            reason: `No photo-textured tile is available (${src.tileUnavailable ?? 'not fetched'}), so the measured palette colours what Street View does not.` });
    }
    timingsMs.tile = Date.now() - t;
    aborted(src.signal);

    // rung 0 above the projection: photo tier A, real Street View pixels rectified onto the fitted planar faces. It runs after
    // C and D so the held-out score can compare it with them and its exposure can be matched to them. Where at least two panos
    // agree its texels replace theirs; its single-pano texels only fill what the tile would colour (mergePhotoTier).
    t = Date.now();
    let photoTier: PhotoTierLayerRecord | undefined;
    /** Photo tier A again with a subset of the panos (the leave-one-pano-out fit). */
    let photoTierLoo: ((views: ProjectionView[], below: BakedTexturePlanes) => Promise<BakedTexturePlanes>) | undefined;
    let photoTierCacheDispose: (() => void) | undefined;
    if (src.photoTier === false) {
        if (src.photoTierUnavailable) degradations.push({ stage: 'photo-tier', reasonCode: 'photo_tier_not_run', layerKey: layer.layerKey, reason: `The rectified photo tier was not run: ${src.photoTierUnavailable}.` });
    } else if (src.views.length && src.context && layer.surfaces?.length) {
        progress('rectifying Street View photos onto the fitted faces');
        const tierCache = createPhotoTierCache();
        let keepCache = false;
        try {
            const res = await rectifyPhotoTier({ cache: tierCache,
                atlas, surfaces: layer.surfaces, views: [...src.views, ...(src.photoTierViews ?? [])], context: src.context, previous: planes,
                ...(src.tile ? { tile: src.tile, tileMaxDistanceM: Math.max(0.25, 2 * (src.registrationResidualM ?? 0)) } : {}),
                densityTexelsPerMeter: atlas.layout.stats.texelsPerMeter || src.densityTexelsPerMeter, signal: src.signal, onProgress: progress,
                ...(src.photoTier?.pythonExecutable ? { pythonExecutable: src.photoTier.pythonExecutable } : {}),
                ...(src.photoTier?.timeoutMs ? { timeoutMs: src.photoTier.timeoutMs } : {}),
                ...(src.photoTier?.heldOut === false ? { heldOut: false } : {})
            });
            degradations.push(...res.degradations);
            photoTier = res.record;
            if (countAlpha(res.planes)) {
                const merged = mergePhotoTier(planes, res.planes);
                planes = merged.planes;
                photoTier = { ...photoTier, merged: { rung0Texels: merged.rung0Texels, rung1Texels: merged.rung1Texels, rung1KeptBelowTexels: merged.rung1KeptBelowTexels, texelShare: (merged.rung0Texels + merged.rung1Texels) / Math.max(1, countCovered(atlas)) } };
                const all = src.views, extra = src.photoTierViews ?? [], surfaces = layer.surfaces, context = src.context, python = src.photoTier ? src.photoTier.pythonExecutable : undefined;
                const tile = src.tile, tileMaxDistanceM = Math.max(0.25, 2 * (src.registrationResidualM ?? 0));
                keepCache = true;
                photoTierLoo = async (views, below) => {
                    const kept = new Set(views.map(v => v.panoId));
                    const left = new Set(all.map(v => v.panoId).filter(p => !kept.has(p)));
                    const r = await rectifyPhotoTier({
                        atlas, surfaces, views: [...views, ...extra.filter(v => !left.has(v.panoId))], context, heldOut: false, cache: tierCache, previous: below,
                        ...(tile ? { tile, tileMaxDistanceM } : {}),
                        densityTexelsPerMeter: atlas.layout.stats.texelsPerMeter || src.densityTexelsPerMeter, signal: src.signal,
                        ...(python ? { pythonExecutable: python } : {})
                    });
                    return countAlpha(r.planes) ? mergePhotoTier(below, r.planes).planes : below;
                };
            }
        } catch (err) {
            if ((err as Error)?.name === 'AbortError' || src.signal?.aborted) throw err;
            degradations.push({ stage: 'photo-tier', reasonCode: 'photo_tier_failed', layerKey: layer.layerKey,
                reason: `The rectified photo tier failed (${(err as Error)?.message ?? String(err)}); the projection and the rungs below colour the layer.` });
        } finally {
            if (!keepCache) tierCache.dispose();
            else photoTierCacheDispose = tierCache.dispose;
        }
    }
    timingsMs.photoTier = Date.now() - t;
    aborted(src.signal);

    // rung 3: measured palette; rung 4 (generated PBR) is not available; rung 5: clay
    t = Date.now();
    const pal = paletteFill(atlas, planes, src.palette);
    const palTexels = countAlpha(pal);
    if (palTexels) {
        planes = mergeBakedPlanes(planes, pal);
        degradations.push({ stage: 'pbr-fill', reasonCode: 'generated_pbr_not_available', layerKey: layer.layerKey, fromRung: RUNG_GENERATED_PBR, toRung: RUNG_PALETTE,
            texelShare: palTexels / Math.max(1, countCovered(atlas)),
            reason: `Generated PBR is not available (the texture-set generator is not built and pbr_synthesize_material is not used), so ${palTexels} texels no photo reaches keep the flat measured-palette colour.` });
    }
    const clay = clayFill(atlas, planes);
    const clayTexels = countAlpha(clay);
    if (clayTexels) {
        planes = mergeBakedPlanes(planes, clay);
        degradations.push({ stage: 'pbr-fill', reasonCode: src.palette.some(f => f.colours.length) ? 'no_texture_source' : 'no_palette', layerKey: layer.layerKey, fromRung: RUNG_PALETTE, toRung: TEXTURE_RUNG_CLAY,
            texelShare: clayTexels / Math.max(1, countCovered(atlas)),
            reason: `${clayTexels} texels have no photo and no measured palette, so they stay studio grey clay.` });
    }
    timingsMs.fill = Date.now() - t;

    // measured provenance and rungs, then the twin
    const m = measurePlanes(atlas, planes);
    planes = { ...planes, provenance: m.provenance };
    // the held-out fit: the final layer rendered from every view's pose against that photo, on what the view's pano did not make
    let fit: LayerFit | undefined;
    let measureLoo: ((budgetMs?: number) => Promise<LooFit>) | undefined;
    const judge = src.context ?? src.occluder;
    if (src.views.length && judge) {
        t = Date.now();
        try {
            fit = measureLayerFit({ atlas, planes, views: src.views.filter(v => v.poseQuality > 0), depthFor: depthForMesh(judge), ...(src.signal ? { signal: src.signal } : {}) });
            progress(describeLayerFit(fit));
        } catch (err) {
            if (src.signal?.aborted) throw err;
            progress(`the held-out fit could not be measured (${(err as Error)?.message ?? String(err)})`);
        }
        timingsMs.fit = Date.now() - t;
        // leave one pano out, for real: the projection baked again without each pano's views, and that pano's photos judge it.
        // Handed back as a job the caller runs once every layer is textured (it is long, synchronous work: run beside the
        // other layers' native unwrappers it starved them past their time limits)
        if (looBake && fit) {
            // with photo tier A on the layer, the judged texture is the projection with the tier's texels over it, both made
            // without the judging pano
            const projBake = looBake, tierBake = photoTierLoo;
            const bake = tierBake ? async (vs: ProjectionView[]) => tierBake(vs, await projBake(vs)) : projBake;
            const depth = depthForMesh(judge), views = src.views.filter(v => v.poseQuality > 0);
            const dispose = photoTierCacheDispose;
            measureLoo = dispose ? async (budgetMs?: number) => { try { return await leaveOnePanoOut(atlas, views, bake, depth, src.signal, budgetMs); } finally { dispose(); } }
                : (budgetMs?: number) => leaveOnePanoOut(atlas, views, bake, depth, src.signal, budgetMs);
            photoTierCacheDispose = undefined;
        }
    }
    // no leave-one-pano-out job holds the photo tier's worker cache: remove it now
    photoTierCacheDispose?.();
    t = Date.now();
    const twin = writeTexturedTwinGlb({ clayGlb: layer.clayGlb, atlas, planes });
    timingsMs.write = Date.now() - t;
    const worst = m.ladderRung;
    // one entry per distinct cause (a pano seen in several close-ups reports the same cause once per image)
    const seen = new Set<string>();
    const unique = degradations.filter(d => { const k = `${d.stage}|${d.reasonCode}|${d.reason}`; if (seen.has(k)) return false; seen.add(k); return true; });
    return {
        layerKey: layer.layerKey, glb: twin.glb,
        bundle: {
            layerKey: layer.layerKey, uv: twin.uv, ...(photoTier ? { photoTier } : {}), provenance: m.provenance, ladderRung: worst,
            ...(fit && fit.scoredViews ? { fit: { chamferPx: fit.chamferPx, clayChamferPx: fit.clayChamferPx, gradNcc: fit.gradNcc, scoredViews: fit.scoredViews, heldOutShare: fit.heldOutShare, widthPx: fit.widthPx, photo: fit.photo, ...(fit.loo ? { loo: fit.loo } : {}), views: fit.views } } : {}),
            rungReason: `${Math.round(m.rungShares[worst] * 100)} percent of the texels are at '${TEXTURE_LADDER_RUNGS[worst]}' (the worst rung above 10 percent)`
        },
        rungShares: m.rungShares, rungTexels: m.rungTexels, atlasTexels: m.total,
        atlas: { width: atlas.width, height: atlas.height, texelsPerMeter: atlas.layout.stats.texelsPerMeter, charts: atlas.layout.stats.charts, islands: atlas.layout.stats.islands },
        degradations: unique, ...(projection ? { projection } : {}), ...(tileMethod ? { tileMethod } : {}), ...(photoTier ? { photoTier } : {}), ...(enhance ? { enhance } : {}), ...(fit ? { fit } : {}), ...(measureLoo ? { measureLoo } : {}),
        modelsUsed: [...new Set(modelsUsed)], timingsMs
    };
}

function countAlpha(p: BakedTexturePlanes): number {
    let c = 0;
    for (let i = 3; i < p.albedo.length; i += 4) if (p.albedo[i]) c++;
    return c;
}

/** The registered grounding views of the evidence stage as projection views (decoded in memory). */
export function projectionViewsFromEvidence(images: EvidenceImage[], registration?: Registration): { views: ProjectionView[]; failures: string[] } {
    const views: ProjectionView[] = [];
    const failures: string[] = [];
    for (const img of images) {
        try {
            const correction = registration?.corrections.get(img.view.panoId);
            views.push(projectionViewFromRegistered({
                view: {
                    panoId: img.view.panoId, eye: img.view.eye, headingDeg: img.view.headingDeg, pitchDeg: img.view.pitchDeg, fovDeg: img.view.fovDeg,
                    widthPx: img.widthPx, heightPx: img.heightPx, ...(correction ? { correction } : {})
                },
                jpeg: img.bytes, ...(registration ? { registration } : {}), ...(img.view.date ? { captureDate: img.view.date } : {})
            }));
        } catch (err) {
            failures.push(`${img.view.panoId.slice(0, 6)}: ${(err as Error)?.message ?? String(err)}`);
        }
    }
    return { views, failures };
}

/** The survey's face palettes (MaterialHints.faces) in the pass's shape. */
export function palettesFromSurvey(faces: Array<{ headingDeg: number; palette?: { colours: Array<{ srgb: [number, number, number]; share: number }> } }> | undefined): PaletteFace[] {
    return (faces ?? []).filter(f => f.palette?.colours.length).map(f => ({ headingDeg: f.headingDeg, colours: f.palette!.colours.map(c => ({ srgb: [c.srgb[0], c.srgb[1], c.srgb[2]] as Vec3, share: c.share })) }));
}

export { CONFIDENCE_CHANNELS };
export type { ConfidencePlane };
