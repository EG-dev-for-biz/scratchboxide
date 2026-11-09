/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The twin's de-light of one photo (tile-refine-twin.ts), on its own so a worker thread runs the same function
 * (png-codec-pool.ts delightImageAsync): the same pixels on either thread.
 */

import { delightLinearRgb, linearToSrgb255, PHOTOGRAMMETRIC_DELIGHT, SRGB8_TO_LINEAR } from '../../../../common/spatial/photogrammetric-delight';
import { TEXEL_ROOF } from './texture-harmonize';

export interface DelightImage { width: number; height: number; rgba: Uint8Array }

/** Roof texels (pipeline K): highlights compressed, no shadow lift (a roof photographed from the air is lit; a dark one is a dark material). */
const ROOF_DELIGHT = { shadowLift: 0, highlightCompress: PHOTOGRAMMETRIC_DELIGHT.defaults.highlightCompress };

/**
 * `upward` (pipeline K-D): the upward surfaces seen from above (roofs, terraces, streets, plazas; a texel any of them draws)
 * and the shadow lift they take, in place of ROOF_DELIGHT's none: a district's ground is mostly in its buildings' baked
 * shadows. It is the same brightness curve as the walls', so it lifts a dark material as much as a shadow; hence gentler.
 */
export function delightImage(decoded: DelightImage, surface?: Uint8Array, upward?: { mask: Uint8Array; shadowLift: number }): DelightImage {
    const out = new Uint8Array(decoded.rgba.length);
    const upParams = upward ? { shadowLift: upward.shadowLift, highlightCompress: PHOTOGRAMMETRIC_DELIGHT.defaults.highlightCompress } : undefined;
    for (let p = 0; p < decoded.rgba.length; p += 4) {
        const params = upParams && upward!.mask[p >> 2] === TEXEL_ROOF ? upParams : surface?.[p >> 2] === TEXEL_ROOF ? ROOF_DELIGHT : PHOTOGRAMMETRIC_DELIGHT.defaults;
        const [lr, lg, lb] = delightLinearRgb(SRGB8_TO_LINEAR[decoded.rgba[p]], SRGB8_TO_LINEAR[decoded.rgba[p + 1]], SRGB8_TO_LINEAR[decoded.rgba[p + 2]], params);
        out[p] = Math.round(linearToSrgb255(lr)); out[p + 1] = Math.round(linearToSrgb255(lg)); out[p + 2] = Math.round(linearToSrgb255(lb)); out[p + 3] = decoded.rgba[p + 3];
    }
    return { width: decoded.width, height: decoded.height, rgba: out };
}
