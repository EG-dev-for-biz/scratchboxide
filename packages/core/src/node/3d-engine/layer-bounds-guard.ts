/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Physical plausibility of a staged layer's bounds. Every staged layer is in the place's local frame (metres from its
 * anchor, y up), so no vertex can lie further from the anchor than the place itself reaches: a layer outside these
 * bounds is broken (a mis-read quantised accessor, a bad instance transform, a non-finite vertex) and must not be
 * staged or stood on. The limits are physical, not taxonomic: no point on Earth is more than about 8.85 km above or
 * 11 km below sea level, so 9 km of height difference from the anchor is generous on land, and no staged place
 * reaches 50 km from its anchor (placement already refuses spots more than 5 km out).
 */

/** Largest |y| (metres from the anchor) any vertex of a staged layer may have. */
export const LAYER_MAX_ABS_HEIGHT_M = 9_000;
/** Largest |x| or |z| (metres from the anchor) any vertex of a staged layer may have. */
export const LAYER_MAX_ABS_HORIZONTAL_M = 50_000;

export interface LayerBounds { min: [number, number, number]; max: [number, number, number] }

/** Why `bounds` cannot belong to a staged layer, or undefined when they can. */
export function implausibleLayerBounds(bounds: LayerBounds): string | undefined {
    const all = [...bounds.min, ...bounds.max];
    if (!all.every(Number.isFinite)) return 'it has vertices that are not finite numbers (NaN or infinity)';
    const fmt = (v: number) => `${Math.round(v).toLocaleString('en-US')} m`;
    const yHigh = Math.max(Math.abs(bounds.min[1]), Math.abs(bounds.max[1]));
    if (yHigh > LAYER_MAX_ABS_HEIGHT_M) {
        return `its vertices reach from ${fmt(bounds.min[1])} to ${fmt(bounds.max[1])} in height about the place's anchor, beyond the ${fmt(LAYER_MAX_ABS_HEIGHT_M)} any real surface can be`;
    }
    const xzHigh = Math.max(Math.abs(bounds.min[0]), Math.abs(bounds.max[0]), Math.abs(bounds.min[2]), Math.abs(bounds.max[2]));
    if (xzHigh > LAYER_MAX_ABS_HORIZONTAL_M) {
        return `its vertices reach ${fmt(xzHigh)} from the place's anchor, beyond the ${fmt(LAYER_MAX_ABS_HORIZONTAL_M)} any staged place covers`;
    }
    return undefined;
}
