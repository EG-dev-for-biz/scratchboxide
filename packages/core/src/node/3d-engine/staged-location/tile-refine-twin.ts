/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The textured twin of a remesh whose texture pass would have to unwrap a whole district (a million triangles): the
 * photo-textured GLB tile_refine already writes beside its clay output (the same triangles, each primitive's UVs into the
 * leaf tile's own photo), made into a twin the viewport crossfades to.
 *
 *   - Every material gets the texture-pass extras (extras.sbTexture.confidenceTexture) so the viewport keeps the photo under
 *     its clay pass and shades its rung: a 1 x 1 confidence texel, R = provenance index, G = 255, B = rung, A = 255.
 *   - A primitive with a photo is rung 'tile photo transfer' (labelled photo-inferred, source 'tile-photo'); one without
 *     a photo is rung 'clay'. The shares are measured by triangle area, so the labels say what the twin holds.
 *   - Materials are drawn from both sides, like the clay they swap with.
 *
 * Nothing is re-projected or invented; the geometry bytes are tile_refine's.
 *
 * Every embedded leaf-tile photo is de-lit (the same analytic lift/compress curve every other texture source in the
 * app already applies, photogrammetric-delight.ts) and, when a model client is given (`opts.recreate`), further
 * recreated by an image model: the same `recreate` mode and structural gate texture-enhance.ts already built for the
 * richer texture-pass.ts pipeline (RECREATE_GATE - edges and openings stay put, the material's hue/chroma stays put,
 * only its lighting and fine surface detail change), run per leaf-tile image rather than per UV-atlas chart, with no
 * grounding reference needed (recreate mode never required one - see texture-enhance.ts). A rejected or failed
 * recreate keeps the de-lit image, never the raw one: each image degrades one rung at a time, the same shape every
 * other stage in this app degrades (user decision, 2026-10-21 - "do this" - converting this from a pure, synchronous
 * function into an async one that calls an image model, staged: Stage 1 shipped the analytic de-light on its own
 * first, verified live; this stage adds the model recreate on top of it, same append-only GLB shape, same fallback
 * ladder, bounded concurrency and a time budget so a district with hundreds of leaf photos still finishes).
 */

import type { FittedPlane } from './window-fit';
import * as jpegJs from 'jpeg-js';
import { TEXTURE_LADDER_RUNGS, TEXTURE_RUNG_CLAY } from '../../../common/spatial/texture-pass-contracts';
import { delightLinearRgb, linearToSrgb255, PHOTOGRAMMETRIC_DELIGHT, SRGB8_TO_LINEAR } from '../../../common/spatial/photogrammetric-delight';
import { IMAGE_MODEL_PRIORITY } from '../../../common/media-generation-protocol';
import { MediaModelUnavailableError } from '../../../common/errors/pipeline-errors';
import { assembleGlb, parseGlbBytes, readAccessor } from './glb-bytes';
import { encodePng } from './png-encode';
import { CONFIDENCE_CHANNELS } from './staged-glb-writer';
import { decodeImageInMemory, type RgbaImage8 } from './tile-texture-transfer';
import { harmonizeTextures, surfaceClassMasks, TEXEL_ROOF, type TextureHarmonizeReport } from './pipeline-k/texture-harmonize';
import { viewRelight, type ViewRelightParams, type ViewRelightReport } from './pipeline-k/view-relight';
import { roofShadowLift, type RoofShadowReport } from './pipeline-k/roof-shadow';
import { evaluateShadowLift, type ShadowLiftQaReport } from './pipeline-k/shadow-lift-qa';
import { skyDelight, type SkyDelightReport } from './pipeline-k/sky-delight';
import { describeMaterialRegions, readRegionClasses, writeMaterialRegions, type MaterialRegionsPlan, type MaterialRegionsReport, type RegionClass, type RegionSet } from './pipeline-k/material-regions';
import { planMaterialRegionsOnThreads } from './pipeline-k/material-regions-pool';
import {
    boxDownsample, cropImage, enhancementGate, padToModelAspect, RECREATE_GATE, recreatePrompt,
    type EnhanceModelClient, type EnhanceModelRequest
} from './texture-enhance';

export const TILE_REFINE_TWIN_VERSION = 'tile-refine-twin/v2';
/** The rung of a photo texel from the tile (TEXTURE_LADDER_RUNGS). */
export const RUNG_TILE_PHOTO = TEXTURE_LADDER_RUNGS.indexOf('tile photo transfer');

export interface TileRefineRecreateOptions {
    client: EnhanceModelClient;
    /** Models to try in order; default IMAGE_MODEL_PRIORITY. */
    models?: string[];
    /** Images in flight at once. Default 12 (a call takes 10 to 20 s; the wall clock, not the cost, is the limit). */
    concurrency?: number;
    /** Largest side of an image sent to the model. Default 1536. */
    maxModelSide?: number;
    /** Past this many ms from the call, no new image starts; images already running finish, the rest keep their de-lit version. */
    budgetMs?: number;
    signal?: AbortSignal;
}

export interface TileRefineRecreateReport {
    attempted: number; accepted: number; rejected: number; failed: number; timedOut: number;
    modelsUsed: string[];
}

export interface TileRefineTwin {
    glb: Buffer;
    /** Share per rung by triangle area (TEXTURE_LADDER_RUNGS order). */
    rungShares: number[];
    provenance: Array<{ source: string; label: string; method: string; coverage: number }>;
    ladderRung: number;
    triangles: number;
    recreate?: TileRefineRecreateReport;
    harmonize?: TextureHarmonizeReport;
    /** Pipeline K: the walls' sky-visibility darkening taken out before harmonising (pipeline-k/sky-delight.ts), or why not. */
    skyDelight?: SkyDelightReport;
    /** Pipeline K: the photos evened out from image-model relights of rendered views (pipeline-k/view-relight.ts), or why not. */
    viewRelight?: ViewRelightReport;
    /** Pipeline K: the cast shadow the mesh throws on its roof decks lifted, a sun fitted per deck (pipeline-k/roof-shadow.ts), or why not. */
    roofShadow?: RoofShadowReport;
    /** The roof shadow lift judged on the surfaces seen from above, photos before against after (pipeline-k/shadow-lift-qa.ts). */
    roofShadowQa?: ShadowLiftQaReport;
    /** Pipeline K's material regions (pipeline-k/material-regions.ts), or why they were not drawn. */
    materialRegions?: MaterialRegionsReport | { skipped: string };
}

function triArea(p: Float64Array, a: number, b: number, c: number): number {
    const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2];
    const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2];
    return 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
}

const png = (img: RgbaImage8): Uint8Array => encodePng(img.width, img.height, Buffer.from(img.rgba.buffer, img.rgba.byteOffset, img.rgba.byteLength), 4);

/** One embedded photo, decoded and de-lit, ready to encode or to try recreating. */
interface ImageJob { originalIndex: number; name: string; mimeType: string; delit: RgbaImage8; }

/** Roof texels (pipeline K): highlights compressed, no shadow lift (a roof photographed from the air is lit; a dark one is a dark material). */
const ROOF_DELIGHT = { shadowLift: 0, highlightCompress: PHOTOGRAMMETRIC_DELIGHT.defaults.highlightCompress };

function delightImage(decoded: RgbaImage8, surface?: Uint8Array): RgbaImage8 {
    const out = new Uint8Array(decoded.rgba.length);
    for (let p = 0; p < decoded.rgba.length; p += 4) {
        const params = surface?.[p >> 2] === TEXEL_ROOF ? ROOF_DELIGHT : PHOTOGRAMMETRIC_DELIGHT.defaults;
        const [lr, lg, lb] = delightLinearRgb(SRGB8_TO_LINEAR[decoded.rgba[p]], SRGB8_TO_LINEAR[decoded.rgba[p + 1]], SRGB8_TO_LINEAR[decoded.rgba[p + 2]], params);
        out[p] = Math.round(linearToSrgb255(lr)); out[p + 1] = Math.round(linearToSrgb255(lg)); out[p + 2] = Math.round(linearToSrgb255(lb)); out[p + 3] = decoded.rgba[p + 3];
    }
    return { width: decoded.width, height: decoded.height, rgba: out };
}

function encodeAs(img: RgbaImage8, mimeType: string): Uint8Array {
    const rgbaBuf = Buffer.from(img.rgba.buffer, img.rgba.byteOffset, img.rgba.byteLength);
    return mimeType === 'image/jpeg' ? new Uint8Array(jpegJs.encode({ data: rgbaBuf, width: img.width, height: img.height }, 90).data) : encodePng(img.width, img.height, rgbaBuf, 4);
}

/**
 * Tries to recreate one de-lit leaf-tile image with the model: same RECREATE_GATE texture-enhance.ts already uses,
 * no grounding reference (recreate mode never needed one). Returns the de-lit image unchanged on a rejection, a model
 * failure, or a decode failure - never throws for those, so one bad leaf tile never costs the rest of the district.
 */
async function recreateOne(job: ImageJob, opts: TileRefineRecreateOptions, models: string[]): Promise<{ image: RgbaImage8; decision: 'accepted' | 'rejected' | 'model_failed'; modelUsed?: string }> {
    const { padded, offset } = padToModelAspect(job.delit);
    const sent = boxDownsample(padded, opts.maxModelSide ?? 1536);
    const request: EnhanceModelRequest = {
        label: job.name, models, prompt: recreatePrompt(sent.width, sent.height, 0),
        image: { mimeType: 'image/png', bytes: png(sent), width: sent.width, height: sent.height },
        references: [], signal: opts.signal
    };
    let answer;
    try {
        answer = await opts.client(request);
    } catch (error) {
        if (opts.signal?.aborted || !(error instanceof MediaModelUnavailableError)) throw error;
        return { image: job.delit, decision: 'model_failed' };
    }
    let decoded: RgbaImage8;
    try { decoded = decodeImageInMemory(answer.bytes); } catch { return { image: job.delit, decision: 'model_failed', modelUsed: answer.modelUsed }; }
    const resized = decoded.width === padded.width && decoded.height === padded.height ? decoded : resizeToExact(decoded, padded.width, padded.height);
    const candidate = cropImage(resized, offset[0], offset[1], job.delit.width, job.delit.height);
    const mask = new Uint8Array(job.delit.width * job.delit.height).fill(1);
    const verdict = enhancementGate(job.delit, candidate, mask, RECREATE_GATE);
    return verdict.pass ? { image: candidate, decision: 'accepted', modelUsed: answer.modelUsed } : { image: job.delit, decision: 'rejected', modelUsed: answer.modelUsed };
}

/** Bilinear resize to an exact size (the model's answer can come back at a slightly different size than asked). */
function resizeToExact(img: RgbaImage8, width: number, height: number): RgbaImage8 {
    const out = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const fx = ((x + 0.5) * img.width) / width - 0.5, fy = ((y + 0.5) * img.height) / height - 0.5;
        const x0 = Math.max(0, Math.min(img.width - 1, Math.floor(fx))), y0 = Math.max(0, Math.min(img.height - 1, Math.floor(fy)));
        const x1 = Math.min(img.width - 1, x0 + 1), y1 = Math.min(img.height - 1, y0 + 1);
        const tx = Math.max(0, Math.min(1, fx - x0)), ty = Math.max(0, Math.min(1, fy - y0));
        for (let k = 0; k < 4; k++) {
            const a = img.rgba[(y0 * img.width + x0) * 4 + k], b = img.rgba[(y0 * img.width + x1) * 4 + k];
            const c = img.rgba[(y1 * img.width + x0) * 4 + k], d = img.rgba[(y1 * img.width + x1) * 4 + k];
            out[(y * width + x) * 4 + k] = Math.round((a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty);
        }
    }
    return { width, height, rgba: out };
}

/** The twin of tile_refine's photo-textured output `texturedGlb` (its bytes) for the layer `layerKey`. */
export async function tileRefineTwin(texturedGlb: Uint8Array, layerKey: string, opts?: { /** Each step as it starts and finishes (the run's step log). */ onStep?: (step: string, state: 'running' | 'done' | 'failed') => void; recreate?: TileRefineRecreateOptions; /** Pipeline K: the de-lit photos colour-matched per side and height band and their seams levelled (pipeline-k/texture-harmonize.ts), measured from this ground. */ harmonize?: { groundY: number; /** The tile extraction with its neighbours (same frame): the sky de-light's occluders. */ skyContext?: { vertices: ArrayLike<number>; indices: ArrayLike<number> } }; /** Pipeline K (with harmonize): the photos relit from rendered views of the building (pipeline-k/view-relight.ts) before harmonising. */ viewRelight?: { client: EnhanceModelClient; models: string[]; params?: Partial<ViewRelightParams>; signal?: AbortSignal; progress?: (message: string) => void }; /** The mesh's cast shadow on its roofs and terraces lifted (pipeline-k/roof-shadow.ts), before any harmonising: pipeline K or a district. */ roofShadow?: { /** The tile extraction with its neighbours (same frame): their shadows on the lower terraces. */ context?: { vertices: ArrayLike<number>; indices: ArrayLike<number> }; progress?: (message: string) => void }; /** Pipeline K: roughness, metalness and normal under the photos by appearance region (pipeline-k/material-regions.ts), one library set per class. */ materialRegions?: { sets: (classes: RegionClass[]) => Promise<RegionSet[]>; /** The tile-only harvest (material-harvest.ts): classes read from the wall alone, with their texture, for a pick by colour and texture. */ harvest?: boolean; /** The window fit's planes (window-fit.ts fittedPlanesOf): their windows drawn on the scan pieces lying on them. */ planes?: FittedPlane[] } }): Promise<TileRefineTwin> {
    const g = parseGlbBytes(texturedGlb);
    const json = JSON.parse(JSON.stringify(g.json));
    const materials: any[] = json.materials ?? (json.materials = []);
    const photo = (mi: number | undefined) => mi !== undefined && materials[mi]?.pbrMetallicRoughness?.baseColorTexture !== undefined;
    // measured shares: triangle area per primitive, photo or not
    let photoArea = 0, bareArea = 0, triangles = 0;
    for (const mesh of json.meshes ?? []) for (const prim of mesh.primitives ?? []) {
        if ((prim.mode ?? 4) !== 4 || prim.attributes?.POSITION === undefined) continue;
        const pos = readAccessor(g, prim.attributes.POSITION).data;
        const idx = prim.indices !== undefined ? readAccessor(g, prim.indices).data : undefined;
        const n = idx ? idx.length : pos.length / 3;
        let area = 0;
        for (let t = 0; t + 2 < n; t += 3) area += idx ? triArea(pos, idx[t], idx[t + 1], idx[t + 2]) : triArea(pos, t, t + 1, t + 2);
        triangles += Math.floor(n / 3);
        if (photo(prim.material)) photoArea += area; else bareArea += area;
        // a primitive with no material gets one that says it is clay
        if (prim.material === undefined) {
            materials.push({ name: 'TileRefineTwinClay', pbrMetallicRoughness: { baseColorFactor: [0.55, 0.57, 0.6, 1], metallicFactor: 0, roughnessFactor: 0.85 } });
            prim.material = materials.length - 1;
        }
    }
    const total = photoArea + bareArea;
    if (!(total > 0)) throw new Error('tile_refine wrote no triangles to texture');
    const rungShares = new Array<number>(TEXTURE_LADDER_RUNGS.length).fill(0);
    rungShares[RUNG_TILE_PHOTO] = photoArea / total;
    rungShares[TEXTURE_RUNG_CLAY] += bareArea / total;

    json.images = json.images ?? [];
    json.textures = json.textures ?? [];

    // Stage 1 (always): decode and de-light every embedded photo. Stage 2 (opts.recreate given): try an image-model
    // recreate on top of the de-lit baseline, gated, concurrency-bounded and time-budgeted.
    const decodedImages: Array<{ i: number; im: any; decoded: RgbaImage8 }> = [];
    json.images.forEach((im: any, i: number) => {
        if (im.bufferView === undefined || (im.mimeType !== 'image/jpeg' && im.mimeType !== 'image/png')) return;
        const view = json.bufferViews[im.bufferView];
        const raw = g.bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
        try { decodedImages.push({ i, im, decoded: decodeImageInMemory(raw) }); } catch { /* not decodable: left as it is */ }
    });
    // pipeline K: which texels are roof, seen from above (their de-light and colour match differ from the walls')
    const surfaces = opts?.harmonize || opts?.roofShadow ? surfaceClassMasks(g, json, new Map(decodedImages.map(d => [d.i, d.decoded]))) : undefined;
    let roofTexels = 0;
    if (surfaces) for (const m of surfaces.values()) for (let k = 0; k < m.length; k++) if (m[k] === TEXEL_ROOF) roofTexels++;
    const jobs: ImageJob[] = decodedImages.map(({ i, im, decoded }) => ({ originalIndex: i, name: im.name ?? `image_${i}`, mimeType: im.mimeType, delit: delightImage(decoded, surfaces?.get(i)) }));

    const finalImage = new Map<number, RgbaImage8>();
    for (const job of jobs) finalImage.set(job.originalIndex, job.delit);
    let recreate: TileRefineRecreateReport | undefined;
    if (opts?.recreate && jobs.length) {
        const ro = opts.recreate;
        const models = ro.models?.length ? ro.models : [...IMAGE_MODEL_PRIORITY];
        const deadline = ro.budgetMs !== undefined ? Date.now() + ro.budgetMs : undefined;
        let attempted = 0, accepted = 0, rejected = 0, failed = 0, timedOut = 0;
        const modelsUsed = new Set<string>();
        let next = 0;
        const worker = async () => {
            while (next < jobs.length) {
                const job = jobs[next++];
                if (ro.signal?.aborted) throw ro.signal.reason instanceof Error ? ro.signal.reason : new Error('tile-refine recreate aborted');
                if (deadline !== undefined && Date.now() >= deadline) { timedOut++; continue; }
                attempted++;
                const r = await recreateOne(job, ro, models);
                if (r.modelUsed) modelsUsed.add(r.modelUsed);
                if (r.decision === 'accepted') accepted++; else if (r.decision === 'rejected') rejected++; else failed++;
                finalImage.set(job.originalIndex, r.image);
            }
        };
        await Promise.all(Array.from({ length: Math.max(1, Math.min(ro.concurrency ?? 12, jobs.length)) }, worker));
        recreate = { attempted, accepted, rejected, failed, timedOut, modelsUsed: Array.from(modelsUsed) };
    }

    // pipeline K: one colour across the photos (after the de-light, on the pixels that will be shown)
    let harmonize: TextureHarmonizeReport | undefined;
    let relight: ViewRelightReport | undefined;
    if (opts?.harmonize && opts.viewRelight && finalImage.size) {
        const vr = opts.viewRelight;
        opts.onStep?.('viewRelight', 'running');
        relight = await viewRelight(g, json, finalImage, { client: vr.client, models: vr.models, groundY: opts.harmonize.groundY, ...(surfaces ? { surfaces } : {}), ...(vr.params ? { params: vr.params } : {}), ...(vr.signal ? { signal: vr.signal } : {}), ...(vr.progress ? { progress: vr.progress } : {}) });
        opts.onStep?.('viewRelight', 'done');
    }
    let roofShadow: RoofShadowReport | undefined, roofShadowQa: ShadowLiftQaReport | undefined;
    if (opts?.roofShadow && surfaces && finalImage.size) {
        opts.onStep?.('roofShadow', 'running');
        const beforeLift = new Map(finalImage);
        roofShadow = await roofShadowLift(g, json, finalImage, surfaces, { ...(opts.roofShadow.context ? { context: opts.roofShadow.context } : {}), ...(opts.roofShadow.progress ? { progress: opts.roofShadow.progress } : {}) });
        opts.onStep?.('roofShadow', 'done');
        if (roofShadow.applied) {
            opts.onStep?.('roofShadowQa', 'running');
            roofShadowQa = evaluateShadowLift(g, json, beforeLift, finalImage, { surfaces });
            opts.onStep?.('roofShadowQa', 'done');
        }
    }
    let sky: SkyDelightReport | undefined;
    if (opts?.harmonize && finalImage.size && process.env.SCRATCHBOX_K_SKY_DELIGHT === '1') { opts.onStep?.('sky de-light', 'running'); sky = skyDelight(g, json, finalImage, surfaces, opts.harmonize.skyContext); opts.onStep?.('sky de-light', 'done'); }
    if (opts?.harmonize && finalImage.size) { opts.onStep?.('harmonize', 'running'); harmonize = harmonizeTextures(g, json, finalImage, opts.harmonize.groundY, undefined, surfaces); opts.onStep?.('harmonize', 'done'); }

    // pipeline K: material regions on the harmonised photos (accepted glass edits them before they are encoded)
    let regionsPlan: MaterialRegionsPlan | undefined, regionsSkipped: string | undefined;
    if (opts?.materialRegions && finalImage.size) {
        opts.onStep?.('materials', 'running');
        const classes = readRegionClasses(json, finalImage, undefined, opts.materialRegions.harvest ? { g } : undefined);
        if (!classes) regionsSkipped = 'no rebuilt facade photo to read appearance classes from';
        else {
            let sets: RegionSet[] | undefined;
            try { sets = await opts.materialRegions.sets(classes); } catch (err) { regionsSkipped = `the library sets could not be resolved: ${err instanceof Error ? err.message : String(err)}`; }
            // each photo's maps planned on its own worker thread (material-regions-pool.ts), the same plan as on one
            if (sets) try { regionsPlan = await planMaterialRegionsOnThreads(g, json, finalImage, classes, sets, opts.materialRegions.planes ?? []); } catch (err) { regionsSkipped = `planning the maps failed: ${err instanceof Error ? err.message : String(err)}`; }
        }
        opts.onStep?.('materials', regionsSkipped ? 'failed' : 'done');
    }

    // the binary chunk: appended to below, both for the final (de-lit or recreated) photos and the confidence texels
    const bin: Uint8Array[] = [g.bin];
    let binLength = g.bin.byteLength;
    const pad = () => { const r = binLength % 4; if (r) { bin.push(new Uint8Array(4 - r)); binLength += 4 - r; } };
    const finalImageIndex = new Map<number, number>();
    for (const job of jobs) {
        const img = finalImage.get(job.originalIndex)!;
        const bytes = encodeAs(img, job.mimeType);
        pad();
        json.bufferViews.push({ buffer: 0, byteOffset: binLength, byteLength: bytes.length });
        bin.push(bytes);
        binLength += bytes.length;
        json.images.push({ name: job.name, mimeType: job.mimeType, bufferView: json.bufferViews.length - 1 });
        finalImageIndex.set(job.originalIndex, json.images.length - 1);
    }
    if (finalImageIndex.size) for (const t of json.textures) if (t.source !== undefined && finalImageIndex.has(t.source)) t.source = finalImageIndex.get(t.source);

    const delit = jobs.length;
    const method = () => {
        const roofs = roofTexels ? `; roofs seen from above (${roofTexels} texels) highlights only, no shadow lift` : '';
        const base = `tile_refine's remesh carries the leaf tiles' own photos (UVs into each leaf's image), de-lit (shadowLift ${PHOTOGRAMMETRIC_DELIGHT.defaults.shadowLift}, highlightCompress ${PHOTOGRAMMETRIC_DELIGHT.defaults.highlightCompress}${roofs}; ${delit} of ${delit} photos)`;
        const vr = relight?.applied ? `; evened out from image-model relights of rendered views, the model's pixels never used (pipeline K): ${relight.why}` : relight ? `; the view relight left them as they were (${relight.why})` : '';
        const rs = roofShadow?.applied ? `; the mesh's cast shadow on its roof decks lifted, a sun fitted per deck (pipeline K, photo-inferred): ${roofShadow.why}` : roofShadow ? `; roof shadows left as they were (${roofShadow.why})` : '';
        const sk = sky?.applied ? `; walls' sky-visibility darkening taken out (pipeline K): ${sky.why}` : sky ? `; the walls' sky-visibility darkening left in (${sky.why})` : '';
        const h = vr + rs + sk + (harmonize?.kept ? `; then harmonised (pipeline K): ${harmonize.why}` : harmonize ? `; harmonising left them as they were (${harmonize.why})` : '');
        if (!recreate) return base + h;
        return `${base}${h}, further recreated by ${recreate.modelsUsed.join(', ') || 'an image model'} removing the scan's own baked shadow/highlight and recovering the material's true colour (gated on structure and hue/chroma): ${recreate.accepted} of ${recreate.attempted} accepted (${recreate.rejected} rejected, ${recreate.failed} model failures${recreate.timedOut ? `, ${recreate.timedOut} ran out of time` : ''})`;
    };
    const provenance = [
        { source: 'tile-photo', label: 'photo-inferred', method: delit ? method() : "tile_refine's remesh carries the leaf tiles' own photos (UVs into each leaf's image), as captured: not de-lit", coverage: photoArea / total },
        { source: 'clay', label: 'clay', method: 'no photo on these triangles', coverage: bareArea / total }
    ].filter(p => p.coverage > 0);
    const indexOf = (source: string) => provenance.findIndex(p => p.source === source);
    json.samplers = json.samplers ?? [];
    json.bufferViews = json.bufferViews ?? [];
    json.samplers.push({ magFilter: 9728, minFilter: 9728, wrapS: 10497, wrapT: 10497 });
    const sampler = json.samplers.length - 1;
    const confTexture = (provIndex: number, rung: number): number => {
        const p = encodePng(1, 1, Uint8Array.from([provIndex, 255, rung, 255]), 4);
        pad();
        json.bufferViews.push({ buffer: 0, byteOffset: binLength, byteLength: p.length });
        bin.push(p);
        binLength += p.length;
        json.images.push({ name: `${layerKey}_confidence_${rung}`, mimeType: 'image/png', bufferView: json.bufferViews.length - 1 });
        json.textures.push({ sampler, source: json.images.length - 1, name: `${layerKey}_confidence_${rung}` });
        return json.textures.length - 1;
    };
    const photoConf = photoArea > 0 ? confTexture(indexOf('tile-photo'), RUNG_TILE_PHOTO) : -1;
    const bareConf = bareArea > 0 ? confTexture(indexOf('clay'), TEXTURE_RUNG_CLAY) : -1;
    if (regionsPlan) {
        const r = regionsPlan.report;
        provenance.push({ source: 'material-regions', label: 'generated', method: describeMaterialRegions(r), coverage: photoArea / total });
        const regionProvenance = [provenance.length - 1];
        if (r.texels.glass) {
            provenance.push({ source: 'facade-material-reading', label: 'photo-inferred', method: "glass on the window fit's panes (the viewer reads them as the facade material reading's glass): the photo kept as their colour, roughness of float glass, dielectric", coverage: (photoArea / total) * (r.texels.glass / Math.max(1, r.texels.total)) });
            regionProvenance.push(provenance.length - 1);
        }
        json.samplers.push({ magFilter: 9729, minFilter: 9729, wrapS: 10497, wrapT: 10497 });
        const linear = json.samplers.length - 1;
        writeMaterialRegions(json, regionsPlan, (img, mimeType, name) => {
            const bytes = encodeAs(img, mimeType);
            pad();
            json.bufferViews.push({ buffer: 0, byteOffset: binLength, byteLength: bytes.length });
            bin.push(bytes);
            binLength += bytes.length;
            json.images.push({ name, mimeType, bufferView: json.bufferViews.length - 1 });
            json.textures.push({ sampler: linear, source: json.images.length - 1, name });
            return json.textures.length - 1;
        }, regionProvenance);
    }
    materials.forEach((m, mi) => {
        const conf = photo(mi) ? photoConf : bareConf;
        if (conf < 0) return;
        m.doubleSided = true;
        m.extras = { ...(m.extras ?? {}), sbTexture: { confidenceTexture: conf, confidenceChannels: CONFIDENCE_CHANNELS } };
    });
    json.buffers = [{ byteLength: binLength }];
    json.asset = json.asset ?? { version: '2.0' };
    json.asset.extras = {
        ...(json.asset.extras ?? {}),
        sbTexture: {
            schema: 'scratchbox.staged-texture/1', layerKey, provenance, degradations: [], ladder: TEXTURE_LADDER_RUNGS,
            confidenceTexture: photoConf >= 0 ? photoConf : bareConf, confidenceChannels: CONFIDENCE_CHANNELS, source: TILE_REFINE_TWIN_VERSION
        }
    };
    pad();
    const out = new Uint8Array(binLength);
    let o = 0;
    for (const b of bin) { out.set(b, o); o += b.byteLength; }
    const ladderRung = rungShares.findIndex((_, k, a) => a.slice(k + 1).reduce((x, y) => x + y, 0) <= 0.1);
    return { glb: assembleGlb(json, out), rungShares, provenance, ladderRung, triangles, ...(recreate ? { recreate } : {}), ...(harmonize ? { harmonize } : {}), ...(sky ? { skyDelight: sky } : {}), ...(relight ? { viewRelight: relight } : {}), ...(roofShadow ? { roofShadow } : {}), ...(roofShadowQa ? { roofShadowQa } : {}), ...(regionsPlan ? { materialRegions: regionsPlan.report } : regionsSkipped ? { materialRegions: { skipped: regionsSkipped } } : {}) };
}
