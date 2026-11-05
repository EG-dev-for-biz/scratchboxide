/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K reads past the Google tile cuts (pipeline-k.ts tileCutBandMask): in a facade ortho, the texels within the band
 * of a cut crossing the facade are marked (to be written into its occlusion mask as fully blocked), and nothing else is:
 * not a cut lying in the facade's own plane, nor one whose rectangle ends short of the facade.
 */

import { describe, it, expect } from 'vitest';
import { tileCutBandMask, TILE_CUT_BAND, type TileCut } from '../src/node/3d-engine/staged-location/pipeline-k/pipeline-k';
import type { ReliefFacade } from '../src/node/3d-engine/staged-location/facade-lattice';

// a wall in the plane z = 5 facing +z, s along x from -10 to 10, t up from 0 to 20 m, 0.1 m texels (200 x 200)
const facade = (): ReliefFacade => ({
    facadeId: 1, image: 'facade_1.png', centroid: [0, 10, 5], normal: [0, 0, 1], axisS: [1, 0, 0], axisT: [0, 1, 0],
    sMin: -10, sMax: 10, tMin: -10, tMax: 10, pixel: 0.1, width: 200, height: 200, orthoSMin: -10, orthoTMax: 10, coverage: 1
});
// a horizontal cut at y = 12 (2 m above the wall's middle), its rectangle covering the wall
const horizontal: TileCut = { u: [0, 1, 0], o: 12, c: [0, 12, 0], a: [1, 0, 0], b: [0, 0, 1], ha: 20, hb: 20 };
const rowsOf = (mask: Uint8Array) => [...new Set([...mask.keys()].filter(i => mask[i]).map(i => Math.floor(i / 200)))].sort((a, b) => a - b);
const colsOf = (mask: Uint8Array) => [...new Set([...mask.keys()].filter(i => mask[i]).map(i => i % 200))].sort((a, b) => a - b);

describe('tileCutBandMask', () => {
    it('marks the rows within the band of a cut crossing the facade, all along it, and nothing else', () => {
        const { mask, count } = tileCutBandMask(facade(), 200, 200, [horizontal]);
        // y = 12 is t = 2: rows whose centre lies within 0.2 m: t in (1.8, 2.2) -> rows 78..81 (t = 10 - (y + 0.5) 0.1)
        expect(rowsOf(mask)).toEqual([78, 79, 80, 81]);
        expect(count).toBe(4 * 200);
        expect(TILE_CUT_BAND.bandM).toBe(0.2);
        // a vertical cut through x = 3 crossing the wall: the columns within 0.2 m of s = 3; a texel two cuts share counts once
        const vertical: TileCut = { u: [1, 0, 0], o: 3, c: [3, 10, 0], a: [0, 1, 0], b: [0, 0, 1], ha: 20, hb: 20 };
        const v = tileCutBandMask(facade(), 200, 200, [vertical]);
        expect(colsOf(v.mask)).toEqual([128, 129, 130, 131]);
        expect(tileCutBandMask(facade(), 200, 200, [horizontal, vertical]).count).toBe(4 * 200 + 4 * 200 - 16);
    });

    it('leaves a cut in the facade\'s own plane and a cut whose rectangle ends short of the facade', () => {
        const inPlane: TileCut = { u: [0, 0, 1], o: 5, c: [0, 10, 5], a: [1, 0, 0], b: [0, 1, 0], ha: 20, hb: 20 };
        const elsewhere: TileCut = { ...horizontal, c: [100, 12, 0] };
        expect(tileCutBandMask(facade(), 200, 200, [inPlane, elsewhere]).count).toBe(0);
        // a cut whose rectangle covers only the wall's left half (x < 0, grown by the margin) marks only that half
        const half: TileCut = { ...horizontal, c: [-5, 12, 0], ha: 5 };
        expect(colsOf(tileCutBandMask(facade(), 200, 200, [half]).mask)).toEqual([...Array(105).keys()]);
    });
});
