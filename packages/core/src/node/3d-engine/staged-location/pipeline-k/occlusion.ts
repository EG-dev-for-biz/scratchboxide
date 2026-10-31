/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * What stood in front of a facade when it was photographed: tile_refine's occlusion mask beside each ortho
 * (scratchbox_photometric_relief.hpp writeOcclusionMask; carried through the straightening warp by ortho-rectify.ts), one
 * channel, 255 x the share of a fan of rays from the facade toward where the capture stood that a surface blocked: a crown,
 * an awning, a neighbour. Measured geometry, no class of thing named.
 *
 * A texel at least OCCLUSION_PARAMS.minBlocked blocked may carry the colour of whatever stood in front, so the readers of
 * the photo (window-fit.ts, wall-grammar.ts, facade-reader.ts) treat it as unread, like a texel the photo never reached:
 * the window lattice and the wall's rhythm are completed over it from the facade's own repeats (labelled as they are over
 * an uncovered span). The facade is still rebuilt there and keeps its photo as the colour; only the reading skips it.
 */

import * as fs from 'fs';
import * as path from 'path';
import { decodePng } from '../../../texture-processing';
import { occludedMaskName } from './ortho-rectify';

export { occludedMaskName };

export const OCCLUSION_PARAMS = {
    /** A texel at least this share of the capture's rays blocked is not read. */
    minBlocked: 0.65
} as const;

/** 1 where the facade's occlusion mask (`f.occludedMask` beside its image in `dir`) is at least minBlocked; undefined without a mask of the photo's size. */
export function readOccluded(dir: string, f: { occludedMask?: string }, width: number, height: number, decode: (b: Buffer) => { rgba: ArrayLike<number>; width: number; height: number } = decodePng, P = OCCLUSION_PARAMS): Uint8Array | undefined {
    if (!f.occludedMask) return undefined;
    const file = path.join(dir, f.occludedMask);
    if (!fs.existsSync(file)) return undefined;
    const m = decode(fs.readFileSync(file));
    if (m.width !== width || m.height !== height) return undefined;
    const at = Math.round(P.minBlocked * 255);
    return Uint8Array.from({ length: width * height }, (_, k) => (m.rgba[k * 4] >= at ? 1 : 0));
}

/** The texels a reader skips: uncovered or occluded (a new array; `uncovered` absent reads as all covered). */
export function unreadMask(uncovered: ArrayLike<number> | undefined, occluded: ArrayLike<number> | undefined, n: number): Uint8Array {
    const out = new Uint8Array(n);
    for (let k = 0; k < n; k++) out[k] = (uncovered && uncovered[k]) || (occluded && occluded[k]) ? 1 : 0;
    return out;
}

/** How many texels of a mask are set. */
export const countSet = (m: ArrayLike<number>): number => { let n = 0; for (let k = 0; k < m.length; k++) n += m[k] ? 1 : 0; return n; };
