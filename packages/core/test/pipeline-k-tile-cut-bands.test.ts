/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K reads past the Google tile cuts (pipeline-k.ts markTileCutBands): in a facade ortho, the photographed texels
 * within the band of a cut crossing the facade are marked as the photo not reaching them (the exact uncovered grey), and
 * nothing else is: not a cut lying in the facade's own plane, not one whose rectangle ends short of the facade, not a texel
 * the photo already missed.
 */

import { describe, it, expect } from 'vitest';
import { markTileCutBands, TILE_CUT_BAND, type TileCut } from '../src/node/3d-engine/staged-location/pipeline-k/pipeline-k';
import type { ReliefFacade } from '../src/node/3d-engine/staged-location/facade-lattice';

// a wall in the plane z = 5 facing +z, s along x from -10 to 10, t up from 0 to 20 m, 0.1 m texels (200 x 200)
const facade = (): ReliefFacade => ({
    facadeId: 1, image: 'facade_1.png', centroid: [0, 10, 5], normal: [0, 0, 1], axisS: [1, 0, 0], axisT: [0, 1, 0],
    sMin: -10, sMax: 10, tMin: -10, tMax: 10, pixel: 0.1, width: 200, height: 200, orthoSMin: -10, orthoTMax: 10, coverage: 1
});
const photo = () => {
    const rgba = new Uint8Array(200 * 200 * 4);
    for (let k = 0; k < rgba.length; k += 4) { rgba[k] = 90; rgba[k + 1] = 80; rgba[k + 2] = 70; rgba[k + 3] = 255; }
    return { width: 200, height: 200, rgba };
};
// a horizontal cut at y = 12 (2 m above the wall's middle), its rectangle covering the wall
const horizontal: TileCut = { u: [0, 1, 0], o: 12, c: [0, 12, 0], a: [1, 0, 0], b: [0, 0, 1], ha: 20, hb: 20 };
const grey = (img: { rgba: Uint8Array }, x: number, y: number) => { const k = (y * 200 + x) * 4; return img.rgba[k] === 128 && img.rgba[k + 1] === 128 && img.rgba[k + 2] === 128; };

describe('markTileCutBands', () => {
    it('marks the rows within the band of a cut crossing the facade, all along it, and nothing else', () => {
        const img = photo();
        const n = markTileCutBands(img, facade(), [horizontal]);
        // y = 12 is t = 2: rows whose centre lies within 0.2 m: t in (1.8, 2.2) -> rows 78..81 (t = 10 - (y + 0.5) 0.1)
        const rows = [...new Set(Array.from({ length: 200 * 200 }, (_, i) => i).filter(i => grey(img, i % 200, Math.floor(i / 200))).map(i => Math.floor(i / 200)))].sort((a, b) => a - b);
        expect(rows).toEqual([78, 79, 80, 81]);
        expect(n).toBe(4 * 200);
        expect(grey(img, 0, 50)).toBe(false);
        expect(TILE_CUT_BAND.bandM).toBe(0.2);
    });

    it('leaves a cut in the facade\'s own plane, a cut whose rectangle ends short of the facade, and texels already missed', () => {
        const inPlane: TileCut = { u: [0, 0, 1], o: 5, c: [0, 10, 5], a: [1, 0, 0], b: [0, 1, 0], ha: 20, hb: 20 };
        const elsewhere: TileCut = { ...horizontal, c: [100, 12, 0] };
        const img = photo();
        expect(markTileCutBands(img, facade(), [inPlane, elsewhere])).toBe(0);
        // a texel the photo never reached (already the uncovered grey) is not counted again, nor a transparent one
        const k = (80 * 200 + 5) * 4, t = (80 * 200 + 6) * 4;
        img.rgba[k] = img.rgba[k + 1] = img.rgba[k + 2] = 128;
        img.rgba[t + 3] = 0;
        expect(markTileCutBands(img, facade(), [horizontal])).toBe(4 * 200 - 2);
        // a vertical cut through x = 3 crossing the wall: columns within 0.2 m of s = 3
        const vertical: TileCut = { u: [1, 0, 0], o: 3, c: [3, 10, 0], a: [0, 1, 0], b: [0, 0, 1], ha: 20, hb: 20 };
        const v = photo();
        expect(markTileCutBands(v, facade(), [vertical])).toBe(4 * 200);
        expect(grey(v, 129, 10) && grey(v, 130, 10) && !grey(v, 127, 10)).toBe(true);
    });
});
