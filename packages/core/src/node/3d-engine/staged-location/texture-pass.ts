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

/** Part of every texture cache key: a change to the pass's maths is a new version. */
export const TEXTURE_PASS_VERSION = 'texture-pass/4';
export const RUNG_PALETTE = 3;
export const RUNG_GENERATED_PBR = 4;
/** The enhancement rung's own time budget per layer (the stage's whole budget is 300 s for every layer). */
export const ENHANCE_BUDGET_MS = 75_000;
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
    projection?: Pick<ProjectionBakeReport, 'bakedTexels' | 'multiViewTexels' | 'maxSeamDeltaE' | 'p95SeamDeltaE' | 'delight'> & { views: number; paletteDeltaE?: number };
    tileMethod?: string;
    enhance?: { charts: number; accepted: number; rejected: number; failed: number; timedOut?: number; modelsUsed: string[] };
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

    // C: Street View projection (rungs 0 and 1)
    t = Date.now();
    if (src.views.length && src.occluder) {
        progress(`projecting ${src.views.length} Street View views`);
        try {
            const res = await bakeStreetViewProjection({
                atlas, views: src.views, depthFor: depthForMesh(src.occluder), paletteLab: src.palette.length ? paletteLab(src.palette) : undefined,
                signal: src.signal, options: {
                    // the tile photo is registered to the geometry, so the per-chart alignment uses it as its reference
                    ...(src.tile ? { alignReference: (P: Vec3, N: Vec3) => {
                        const c = src.tile!.sample(P, N, Math.max(0.25, 2 * (src.registrationResidualM ?? 0)))?.rgb; // sRGB 0..255
                        return c && [0, 1, 2].map(i => SRGB8_TO_LINEAR[Math.max(0, Math.min(255, Math.round(c[i])))]) as Vec3;
                    } } : {}),
                    ...(src.delight ? { delight: src.delight } : {}), ...(src.observedSurface ? { observedSurface: src.observedSurface } : {}), ...(src.poseEdgeGuardShare ? { poseEdgeGuardShare: src.poseEdgeGuardShare } : {}) }
            });
            planes = res;
            degradations.push(...res.degradations);
            projection = {
                views: src.views.length, bakedTexels: res.report.bakedTexels, multiViewTexels: res.report.multiViewTexels,
                maxSeamDeltaE: res.report.maxSeamDeltaE, p95SeamDeltaE: res.report.p95SeamDeltaE,
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
            layerKey: layer.layerKey, uv: twin.uv, provenance: m.provenance, ladderRung: worst,
            rungReason: `${Math.round(m.rungShares[worst] * 100)} percent of the texels are at '${TEXTURE_LADDER_RUNGS[worst]}' (the worst rung above 10 percent)`
        },
        rungShares: m.rungShares, rungTexels: m.rungTexels, atlasTexels: m.total,
        atlas: { width: atlas.width, height: atlas.height, texelsPerMeter: atlas.layout.stats.texelsPerMeter, charts: atlas.layout.stats.charts, islands: atlas.layout.stats.islands },
        degradations: unique, ...(projection ? { projection } : {}), ...(tileMethod ? { tileMethod } : {}), ...(enhance ? { enhance } : {}),
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
