/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * De-lights the raw Google tile photo that "as-scanned" / "as-scanned:unsure" residual clusters render with
 * (massing-glb.ts's tileMaterial path: the mesh's own native UV straight into this one shared image, no UV atlas, no
 * tile-transfer or Street View fusion). Every other texel in the scene is de-lit on its way in (tile-texture-transfer.ts's
 * TileTextureSurface.sample, texture-pass.ts's tile-transfer rung), so a residual cluster left at Google's raw, undelit
 * exposure was the only thing in the scene still carrying a baked cast shadow, which against blue sky skews dark
 * surfaces blue-purple (live, Haughwout: the left wall's residual clusters, scene-stg-d9660711).
 *
 * This is a whole-image transform of the shared tile photo, not a per-cluster bake: residual clusters already share a
 * handful of these images across the whole isolate, and de-lighting the image once benefits every cluster that samples
 * it, with no new UV atlas or geometry work.
 */

import { decodeImageInMemory } from '../tile-texture-transfer';
import { encodePng } from '../png-encode';
import { delightLinearPlane, linearToSrgb255, PHOTOGRAMMETRIC_DELIGHT, SRGB8_TO_LINEAR, TEXTURE_LIFT_CAP } from '../../../../common/spatial/photogrammetric-delight';

/** Google's documented ~0.154 m/texel tile resolution (tile-texture-transfer.ts), to put TEXTURE_LIFT_CAP's metre radius in texels. */
export const TILE_METERS_PER_TEXEL = 0.154;
/** TEXTURE_LIFT_CAP.radiusM (1.5 m) in texels of a raw Google tile photo. */
export const RESIDUAL_DELIGHT_RADIUS_TEXELS = Math.max(1, Math.round(TEXTURE_LIFT_CAP.radiusM / TILE_METERS_PER_TEXEL));

/** De-lights one Google tile photo (PNG or JPEG in; PNG out, so the embedded texture is never re-compressed twice). */
export function delightTileImageBytes(bytes: Uint8Array): Uint8Array {
    const { width, height, rgba } = decodeImageInMemory(bytes);
    const n = width * height;
    const plane = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
        plane[i * 3] = SRGB8_TO_LINEAR[rgba[i * 4]];
        plane[i * 3 + 1] = SRGB8_TO_LINEAR[rgba[i * 4 + 1]];
        plane[i * 3 + 2] = SRGB8_TO_LINEAR[rgba[i * 4 + 2]];
    }
    delightLinearPlane(plane, new Uint8Array(n).fill(1), width, height, PHOTOGRAMMETRIC_DELIGHT.defaults, { radiusTexels: RESIDUAL_DELIGHT_RADIUS_TEXELS, contrastGain: TEXTURE_LIFT_CAP.contrastGain });
    const out = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
        out[i * 4] = Math.round(linearToSrgb255(plane[i * 3]));
        out[i * 4 + 1] = Math.round(linearToSrgb255(plane[i * 3 + 1]));
        out[i * 4 + 2] = Math.round(linearToSrgb255(plane[i * 3 + 2]));
        out[i * 4 + 3] = rgba[i * 4 + 3];
    }
    return new Uint8Array(encodePng(width, height, Buffer.from(out), 4));
}
