/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../src/common/spatial/staged-location-contracts';
import { packConfidenceTexel, unpackConfidenceTexel, type BakedTexturePlanes } from '../src/common/spatial/texture-pass-contracts';
import { witnessSinglePano } from '../src/node/3d-engine/staged-location/single-pano-witness';
import { emptyConfidencePlane, FACADE, facadeAtlas } from './helpers/texture-pass-fixtures';
import { planePanel, saveStrip } from './helpers/texture-tile-shots';

const SIDE = 128; // 10 m x 6 m facade, 0.078 m texels
const stone = (u: number, v: number): Vec3 => {
    // coursed stone: 0.6 m courses with dark joints, a little texture
    const joint = (v % 0.6) < 0.05 || ((u + (Math.floor(v / 0.6) % 2) * 0.6) % 1.2) < 0.05;
    const g = joint ? 120 : 172 + 10 * Math.sin(u * 7.1) * Math.cos(v * 5.3);
    return [g, g - 4, g - 12];
};
const uvOf = (t: number): [number, number] => { const x = t % SIDE, y = (t / SIDE) | 0; return [((x + 0.5) / SIDE) * FACADE.widthM, (1 - (y + 0.5) / SIDE) * FACADE.heightM]; };
const inBird = (u: number, v: number) => Math.hypot(u - 7.5, v - 4.5) < 0.3;
const inSky = (u: number, v: number) => u > 2 && u < 4 && v > 1 && v < 1 + (u - 2) * 0.9; // a wedge
const inSquare = (u: number, v: number) => Math.abs(u - 5) < 0.35 && Math.abs(v - 3) < 0.35;

/** The projection: one pano (two crops) on the right half, two panos on the left; a pigeon, a sky wedge and a pale square. */
function bake(): BakedTexturePlanes {
    const n = SIDE * SIDE;
    const planes: BakedTexturePlanes = {
        layerKey: 'fit', width: SIDE, height: SIDE, albedo: new Uint8Array(n * 4), confidence: emptyConfidencePlane(SIDE, SIDE), degradations: [],
        provenance: [
            { source: 'street-view-projection', label: 'photo-inferred', method: 'two panos', panoIds: ['A', 'B'], coverage: 0.3 },
            { source: 'street-view-projection', label: 'photo-inferred', method: 'one view', panoIds: ['A'], coverage: 0.4 },
            { source: 'street-view-projection', label: 'photo-inferred', method: 'two crops of one pano', panoIds: ['A', 'A'], coverage: 0.3 }
        ]
    };
    for (let t = 0; t < n; t++) {
        const [u, v] = uvOf(t);
        let c = stone(u, v);
        // the photos are brighter than the tile (another day): 1.25x
        c = c.map(x => Math.min(255, x * 1.12)) as Vec3;
        if (inBird(u, v)) c = [38, 36, 40];
        if (inSky(u, v)) c = [140, 165, 205];
        if (inSquare(u, v)) c = [168, 190, 228]; // pale sky (the live square was sky-tinted: b* well below the stone)
        // a dark mark the two panos agree on (stays: the multi-pano texels are not checked here)
        if (Math.hypot(u - 1.5, v - 4.5) < 0.3) c = [40, 40, 40];
        planes.albedo.set([Math.round(c[0]), Math.round(c[1]), Math.round(c[2]), 255], t * 4);
        const entry = u < 1.5 + 1 ? 0 : u > 4.6 && u < 5.4 ? 2 : 1;
        packConfidenceTexel(planes.confidence, t, entry, 0.6, entry === 0 ? 0 : 1);
    }
    return planes;
}

/** The tile photo: the same stone, coarser (0.15 m blocks), with no pigeon, no sky and no square. */
const tile = (p: Vec3): { rgb: Vec3 } => {
    const u = Math.floor(p[0] / 0.15) * 0.15 + 0.075, v = Math.floor(p[1] / 0.15) * 0.15 + 0.075;
    return { rgb: stone(u, v) };
};

describe('single-pano texels witnessed by the tile photo', () => {
    it('drops a pigeon, a sky wedge and a pale square one pano saw, keeps the stone and what two panos agree on', () => {
        const atlas = facadeAtlas(SIDE);
        const planes = bake();
        const { planes: out, report } = witnessSinglePano(planes, atlas, (p) => tile(p));
        const n = SIDE * SIDE;
        const tally = { bird: [0, 0], sky: [0, 0], square: [0, 0], clean: [0, 0], multiMark: [0, 0] };
        for (let t = 0; t < n; t++) {
            const [u, v] = uvOf(t);
            const kept = unpackConfidenceTexel(out.confidence, t).covered ? 1 : 0;
            const k = inBird(u, v) ? 'bird' : inSky(u, v) ? 'sky' : inSquare(u, v) ? 'square' : Math.hypot(u - 1.5, v - 4.5) < 0.3 ? 'multiMark' : 'clean';
            tally[k][0]++; tally[k][1] += kept;
        }
        const keptShare = (k: keyof typeof tally) => tally[k][1] / tally[k][0];
        expect(keptShare('bird')).toBeLessThan(0.15);
        expect(keptShare('sky')).toBeLessThan(0.1);
        expect(keptShare('square')).toBeLessThan(0.15);
        expect(keptShare('clean')).toBeGreaterThan(0.97);
        expect(keptShare('multiMark')).toBe(1);
        expect(report.gain[0]).toBeGreaterThan(1.05);
        expect(report.rejected).toBeGreaterThan(0);
        // a dropped texel is uncovered for the next rung (alpha 0), never recoloured here
        for (let t = 0; t < n; t++) if (!unpackConfidenceTexel(out.confidence, t).covered) expect(out.albedo[t * 4 + 3]).toBe(0);
        saveStrip('single_pano_witness', [planePanel(SIDE, SIDE, planes.albedo), planePanel(SIDE, SIDE, out.albedo)]);
    });

    it('leaves texels with no tile surface near them as they are', () => {
        const planes = bake();
        const { planes: out, report } = witnessSinglePano(planes, facadeAtlas(SIDE), () => undefined);
        expect(out).toBe(planes);
        expect(report.checked).toBe(0);
        expect(report.noWitness).toBeGreaterThan(0);
    });
});
