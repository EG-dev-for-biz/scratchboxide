/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The twin's texel passes (tile-refine-twin.ts), as two calls the twin makes in order: prepareTwinPhotos (decode every
 * embedded photo, the surface class masks, the de-light) and finishTwinPhotos (the roof-shadow lift and its QA, the sky
 * de-light, harmonising). Both are per-texel work over every photo of the building, so twin-photo-thread.ts runs them on a
 * thread of their own (the same code), and the build's thread stays free between them for its model calls and the stages
 * running beside it. Between the two calls the twin does the passes that need a model client (recreate, view relight).
 */

import { delightLinearRgb, linearToSrgb255, PHOTOGRAMMETRIC_DELIGHT, SRGB8_TO_LINEAR } from '../../../../common/spatial/photogrammetric-delight';
import type { ParsedGlb } from '../glb-bytes';
import { decodeImageInMemory, type RgbaImage8 } from '../tile-texture-transfer';
import { districtBuildingIndex, type DistrictFootprint } from './district-buildings';
import { roofShadowLift, type RoofShadowReport } from './roof-shadow';
import { evaluateShadowLift, type ShadowLiftQaReport } from './shadow-lift-qa';
import { skyDelight, type SkyDelightReport } from './sky-delight';
import { harmonizeTextures, surfaceClassMasks, TEXEL_ROOF, type TextureHarmonizeReport } from './texture-harmonize';

/** Roof texels (pipeline K): highlights compressed, no shadow lift (a roof photographed from the air is lit; a dark one is a dark material). */
const ROOF_DELIGHT = { shadowLift: 0, highlightCompress: PHOTOGRAMMETRIC_DELIGHT.defaults.highlightCompress };

/**
 * `upward` (pipeline K-D): the upward surfaces seen from above (roofs, terraces, streets, plazas; a texel any of them draws)
 * and the shadow lift they take, in place of ROOF_DELIGHT's none: a district's ground is mostly in its buildings' baked
 * shadows. It is the same brightness curve as the walls', so it lifts a dark material as much as a shadow; hence gentler.
 */
export function delightImage(decoded: RgbaImage8, surface?: Uint8Array, upward?: { mask: Uint8Array; shadowLift: number }): RgbaImage8 {
    const out = new Uint8Array(decoded.rgba.length);
    const upParams = upward ? { shadowLift: upward.shadowLift, highlightCompress: PHOTOGRAMMETRIC_DELIGHT.defaults.highlightCompress } : undefined;
    for (let p = 0; p < decoded.rgba.length; p += 4) {
        const params = upParams && upward!.mask[p >> 2] === TEXEL_ROOF ? upParams : surface?.[p >> 2] === TEXEL_ROOF ? ROOF_DELIGHT : PHOTOGRAMMETRIC_DELIGHT.defaults;
        const [lr, lg, lb] = delightLinearRgb(SRGB8_TO_LINEAR[decoded.rgba[p]], SRGB8_TO_LINEAR[decoded.rgba[p + 1]], SRGB8_TO_LINEAR[decoded.rgba[p + 2]], params);
        out[p] = Math.round(linearToSrgb255(lr)); out[p + 1] = Math.round(linearToSrgb255(lg)); out[p + 2] = Math.round(linearToSrgb255(lb)); out[p + 3] = decoded.rgba[p + 3];
    }
    return { width: decoded.width, height: decoded.height, rgba: out };
}

export interface TwinPrepareOptions {
    /** false: the photos are already de-lit (a chunked district's joined twins): decoded only. */
    delight: boolean;
    /** The surface class masks wanted (pipeline K's harmonising or roof-shadow lift). */
    surfaces: boolean;
    /** Pipeline K-D: the shadow lift of the upward surfaces seen from above (0: none). */
    upLift: number;
}

/** One embedded photo, decoded and de-lit: its image index, name and type, and its pixels. */
export interface TwinPhoto { i: number; name: string; mimeType: string; delit: RgbaImage8 }

export interface TwinPrepared {
    photos: TwinPhoto[];
    /** Per photo, its texels' surface class (texture-harmonize.ts surfaceClassMasks), when asked for. */
    surfaces?: Map<number, Uint8Array>;
    /** Texels classed as roof seen from above, over every photo. */
    roofTexels: number;
}

/** Decodes and de-lights every embedded JPEG or PNG photo of the textured GLB `g` (its JSON `json`); one that does not decode is left out. */
export function prepareTwinPhotos(g: ParsedGlb, json: any, o: TwinPrepareOptions): TwinPrepared {
    const decoded: Array<{ i: number; im: any; decoded: RgbaImage8 }> = [];
    (json.images ?? []).forEach((im: any, i: number) => {
        if (im.bufferView === undefined || (im.mimeType !== 'image/jpeg' && im.mimeType !== 'image/png')) return;
        const view = json.bufferViews[im.bufferView];
        const at = g.bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
        // on the photo thread the binary chunk is shared memory, which not every decoder takes: the photo's bytes copied out
        const raw = at.buffer instanceof SharedArrayBuffer ? at.slice() : at;
        try { decoded.push({ i, im, decoded: decodeImageInMemory(raw) }); } catch { /* not decodable: left as it is */ }
    });
    const sizes = new Map(decoded.map(d => [d.i, d.decoded]));
    // pipeline K: which texels are roof, seen from above (their de-light and colour match differ from the walls')
    const surfaces = o.surfaces ? surfaceClassMasks(g, json, sizes) : undefined;
    let roofTexels = 0;
    if (surfaces) for (const m of surfaces.values()) for (let k = 0; k < m.length; k++) if (m[k] === TEXEL_ROOF) roofTexels++;
    // the upward surfaces' own mask (a texel any upward surface draws), for their shadow lift
    const upMasks = o.upLift ? surfaceClassMasks(g, json, sizes, undefined, { sharedTexel: 'up' }) : undefined;
    const photos = decoded.map(({ i, im, decoded: d }): TwinPhoto => {
        const up = upMasks?.get(i);
        return { i, name: im.name ?? `image_${i}`, mimeType: im.mimeType, delit: o.delight ? delightImage(d, surfaces?.get(i), up ? { mask: up, shadowLift: o.upLift } : undefined) : d };
    });
    return { photos, ...(surfaces ? { surfaces } : {}), roofTexels };
}

export interface TwinFinishOptions {
    /** The mesh's cast shadow on its roofs and terraces lifted (roof-shadow.ts); `context`: the extraction with its neighbours. */
    roofShadow?: { context?: { vertices: ArrayLike<number>; indices: ArrayLike<number> } };
    /** The walls' sky-visibility darkening taken out (sky-delight.ts); `context`: its occluders. */
    sky?: { context?: { vertices: ArrayLike<number>; indices: ArrayLike<number> } };
    /** Harmonised (texture-harmonize.ts) from this ground; a district's `buildings` (their footprints) keep each one's colours its own. */
    harmonize?: { groundY: number; buildings?: DistrictFootprint[] };
}

export interface TwinFinished {
    roofShadow?: RoofShadowReport;
    roofShadowQa?: ShadowLiftQaReport;
    sky?: SkyDelightReport;
    harmonize?: TextureHarmonizeReport;
}

export interface TwinPassHooks {
    /** Each step as it starts and finishes (the run's step log). */
    onStep?: (step: string, state: 'running' | 'done' | 'failed') => void;
    /** The roof-shadow lift's progress lines. */
    progress?: (message: string) => void;
}

/**
 * The passes after the de-light, in order, on `images` (image index -> photo) in place: the roof-shadow lift and its QA,
 * the sky de-light, harmonising. `surfaces` are prepareTwinPhotos' masks (the roof-shadow lift needs them).
 */
export async function finishTwinPhotos(g: ParsedGlb, json: any, images: Map<number, RgbaImage8>, surfaces: Map<number, Uint8Array> | undefined, o: TwinFinishOptions, hooks: TwinPassHooks = {}): Promise<TwinFinished> {
    const out: TwinFinished = {};
    if (o.roofShadow && surfaces && images.size) {
        hooks.onStep?.('roofShadow', 'running');
        const beforeLift = new Map(images);
        out.roofShadow = await roofShadowLift(g, json, images, surfaces, { ...(o.roofShadow.context ? { context: o.roofShadow.context } : {}), ...(hooks.progress ? { progress: hooks.progress } : {}) });
        hooks.onStep?.('roofShadow', 'done');
        if (out.roofShadow.applied) {
            hooks.onStep?.('roofShadowQa', 'running');
            out.roofShadowQa = evaluateShadowLift(g, json, beforeLift, images, { surfaces });
            hooks.onStep?.('roofShadowQa', 'done');
        }
    }
    if (o.sky && images.size) { hooks.onStep?.('sky de-light', 'running'); out.sky = skyDelight(g, json, images, surfaces, o.sky.context); hooks.onStep?.('sky de-light', 'done'); }
    if (o.harmonize && images.size) {
        hooks.onStep?.('harmonize', 'running');
        const buildingOf = o.harmonize.buildings ? districtBuildingIndex(o.harmonize.buildings) : undefined;
        out.harmonize = harmonizeTextures(g, json, images, o.harmonize.groundY, undefined, surfaces, buildingOf ? { buildingOf } : {});
        hooks.onStep?.('harmonize', 'done');
    }
    return out;
}
