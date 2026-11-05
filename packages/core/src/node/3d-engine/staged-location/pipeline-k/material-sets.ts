/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The library sets of pipeline K's material regions (material-regions.ts): the shared material path's resolver
 * (3d-engine/material-path/class-sets.ts) at a facade's tile scale.
 */

import { resolveClassSets, type TileScale } from '../../material-path/class-sets';
import type { RegionClass, RegionSet } from '../../material-path/surface-classes';

export { libraryRepoRoot, PREPARED_VERSION, preparedKey, REGION_FINISH } from '../../material-path/class-sets';

/**
 * The real size a facade's set is ranked toward, and the largest it may have: a wall's surface is dressed at the scale of
 * its units, a metre or two a tile (the library's median tile is 1.8 m), while a set whose one tile spans more than
 * maxM was photographed from far above as ground (a beach, a field from the air), its grain the wrong size on a wall.
 */
export const FACADE_TILE: TileScale = { wantM: 2, maxM: 8 };


/** One set per class, in class order, at a facade's scale (resolveClassSets). */
export function resolveRegionSets(classes: RegionClass[], opts: Parameters<typeof resolveClassSets>[2] = {}): Promise<RegionSet[]> {
    return resolveClassSets(classes, FACADE_TILE, opts);
}
