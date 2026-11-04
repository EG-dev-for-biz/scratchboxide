/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Featureless photo (the grey smear a tile photo leaves on a wall it did not see) found, refilled like a hole from the
 * facade's repeats but never smeared on from the nearest texel, and what is left continued from the nearest facade facing
 * the same way.
 */

import { describe, expect, it } from 'vitest';
import { featurelessMask, fillHoles, ORTHO_RECTIFY_PARAMS } from '../src/node/3d-engine/staged-location/pipeline-k/ortho-rectify';
import { continueFeatureless } from '../src/node/3d-engine/staged-location/pipeline-k/pipeline-k';
import type { ReliefFacade } from '../src/node/3d-engine/staged-location/facade-lattice';

const PX = 0.1;

/** A W x H ortho of textured stone (fine noise), with a smooth grey block and a smooth narrow pier. */
function ortho(W: number, H: number, smooth: (x: number, y: number) => boolean): Uint8Array {
    const rgba = new Uint8Array(W * H * 4);
    let seed = 3;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 50;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const v = smooth(x, y) ? 150 : Math.round(170 + rnd());
        rgba.set([v, v, v - 5, 255], (y * W + x) * 4);
    }
    return rgba;
}

describe('featureless photo', () => {
    it('finds a large smooth region and leaves a narrow smooth pier and the textured wall', () => {
        const W = 200, H = 150;
        // a 6 x 6 m smear, and a 1 m wide pier the full height (plain stone, not a smear)
        const block = (x: number, y: number) => x >= 40 && x < 100 && y >= 40 && y < 100;
        const pier = (x: number) => x >= 150 && x < 160;
        const m = featurelessMask({ width: W, height: H, rgba: ortho(W, H, (x, y) => block(x, y) || pier(x)) }, PX);
        let inBlock = 0, onPier = 0, elsewhere = 0;
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            if (!m[y * W + x]) continue;
            if (block(x, y)) inBlock++; else if (pier(x)) onPier++; else elsewhere++;
        }
        // the block's middle at least (its rim mixes with the texture around it)
        expect(inBlock).toBeGreaterThan(0.6 * 60 * 60);
        expect(onPier).toBe(0);
        expect(elsewhere).toBeLessThan(0.05 * W * H);
    });

    it('is refilled from the repeats where they reach, and never smeared on from the nearest texel', () => {
        const W = 120, H = 60;
        const rgba = ortho(W, H, () => false);
        // a grey hole marked featureless, too wide for the (absent) repeats
        const flat = new Uint8Array(W * H);
        for (let y = 10; y < 50; y++) for (let x = 30; x < 90; x++) { flat[y * W + x] = 1; rgba.set([128, 128, 128, 255], (y * W + x) * 4); }
        const r = fillHoles({ width: W, height: H, rgba }, PX, ORTHO_RECTIFY_PARAMS, { noNearest: flat });
        expect(r.fill.fromNearest).toBe(0);
        expect((r.fill.featurelessLeft ?? 0) + r.fill.fromRepeats + r.fill.fromStoreys).toBe(40 * 60);
    });
});

describe('featureless photo continued from another facade', () => {
    const facade = (facadeId: number, centroid: number[], normal: number[], axisS: number[]): ReliefFacade => ({
        facadeId, image: `f${facadeId}.png`, centroid, normal, axisS, axisT: [0, 1, 0], sMin: 0, sMax: 10, tMin: 0, tMax: 10, pixel: 1,
        width: 10, height: 10, orthoSMin: 0, orthoTMax: 10, coverage: 1
    });
    const solid = (v: number) => { const a = new Uint8Array(400); for (let i = 0; i < 100; i++) a.set([v, v + 1, v + 2, 255], i * 4); return a; };
    const all = () => new Uint8Array(100).fill(1);

    it('takes the nearest facade facing the same way at that height, its photo repeating along the wall, before one facing the other way', () => {
        // F: facing +z, its photo a smear (90); G: facing +z, 20 m along x at the same height (its photo repeats over F);
        // B: facing -z right behind F (nearer, but its photo would be seen mirrored)
        const F = facade(1, [0, 0, 0], [0, 0, 1], [1, 0, 0]), G = facade(2, [20, 0, 0], [0, 0, 1], [1, 0, 0]), B = facade(3, [0, 0, -1], [0, 0, -1], [-1, 0, 0]);
        const smear = solid(90);
        const images = new Map([[1, { f: F, rgba: smear, width: 10, height: 10, featureless: all() }], [2, { f: G, rgba: solid(60), width: 10, height: 10 }], [3, { f: B, rgba: solid(200), width: 10, height: 10 }]]);
        const rep = continueFeatureless(images).get(1)!;
        expect(rep.texels).toBe(100);
        expect(rep.regions).toBe(1);
        expect(rep.fromFacades).toEqual({ 2: 100 });
        for (let i = 0; i < 100; i++) expect(Array.from(smear.slice(i * 4, i * 4 + 3))).toEqual([60, 61, 62]);
    });

    it('fills a region whole from one source shifted so its piers run on from the photo around the region', () => {
        // 0.5 m texels, a 20 m x 5 m wall: piers 1 m wide every 4 m (light), the bays between dark; the middle 10 m is a smear
        const pier = (s: number) => (((s % 4) + 4) % 4 < 1 ? 200 : 60);
        const fac = (facadeId: number, cx: number): ReliefFacade => ({ facadeId, image: `f${facadeId}.png`, centroid: [cx, 0, 0], normal: [0, 0, 1], axisS: [1, 0, 0], axisT: [0, 1, 0], sMin: 0, sMax: 20, tMin: 0, tMax: 5, pixel: 0.5, width: 40, height: 10, orthoSMin: 0, orthoTMax: 5, coverage: 1 });
        const paint = (f: ReliefFacade, offset: number) => { const a = new Uint8Array(40 * 10 * 4); for (let y = 0; y < 10; y++) for (let x = 0; x < 40; x++) { const v = pier(f.centroid[0] + (x + 0.5) * 0.5 + offset); a.set([v, v, v, 255], (y * 40 + x) * 4); } return a; };
        const F = fac(1, 0), G = fac(2, 101.5);
        const rgbaF = paint(F, 0), mask = new Uint8Array(400);
        for (let y = 0; y < 10; y++) for (let x = 10; x < 30; x++) { mask[y * 40 + x] = 1; rgbaF.set([128, 128, 128, 255], (y * 40 + x) * 4); }
        // G's piers stand 1.5 m off F's rhythm in the world: copied straight across they would break the piers
        const rep = continueFeatureless(new Map([[1, { f: F, rgba: rgbaF, width: 40, height: 10, featureless: mask }], [2, { f: G, rgba: paint(G, 0), width: 40, height: 10 }]])).get(1)!;
        expect(rep.regions).toBe(1);
        expect(rep.filled).toBe(1);
        expect(rep.sources).toHaveLength(1);
        for (let y = 0; y < 10; y++) for (let x = 10; x < 30; x++) expect(rgbaF[(y * 40 + x) * 4]).toBe(pier((x + 0.5) * 0.5));
    });

    it('refills a large dark region from a facade facing the same way, and keeps a window-sized dark patch', () => {
        // F: facing +z, 10 x 10 m at 1 m texels, light stone (150): its left 5 m dark (a neighbour's shade: 20), and a 2 x 2 m dark window
        const F = facade(1, [0, 0, 0], [0, 0, 1], [1, 0, 0]), G = facade(2, [20, 0, 0], [0, 0, 1], [1, 0, 0]);
        const rgba = solid(150);
        for (let y = 0; y < 10; y++) for (let x = 0; x < 5; x++) rgba.set([20, 20, 20, 255], (y * 10 + x) * 4);
        for (const [x, y] of [[7, 7], [8, 7], [7, 8], [8, 8]]) rgba.set([20, 20, 20, 255], (y * 10 + x) * 4);
        const rep = continueFeatureless(new Map([[1, { f: F, rgba, width: 10, height: 10 }], [2, { f: G, rgba: solid(160), width: 10, height: 10 }]])).get(1)!;
        expect(rep.dark).toBe(50);
        expect(rep.regions).toBe(1);
        expect(rep.fromFacades).toEqual({ 2: 50 });
        expect(rep.fromOpposite).toBeUndefined();
        for (let y = 0; y < 10; y++) for (let c = 0; c < 5; c++) expect(rgba[(y * 10 + c) * 4]).toBe(160);
        // the window keeps its photo
        expect(rgba[(7 * 10 + 7) * 4]).toBe(20);
    });

    it('keeps a dark feature inside the wall (an entrance bay with wall each side) as photographed', () => {
        // a 4 m wide dark bay the full height, in the middle of a light 10 m wall
        const F = facade(1, [0, 0, 0], [0, 0, 1], [1, 0, 0]), G = facade(2, [20, 0, 0], [0, 0, 1], [1, 0, 0]);
        const rgba = solid(150);
        for (let y = 0; y < 10; y++) for (let x = 3; x < 7; x++) rgba.set([20, 20, 20, 255], (y * 10 + x) * 4);
        expect(continueFeatureless(new Map([[1, { f: F, rgba, width: 10, height: 10 }], [2, { f: G, rgba: solid(160), width: 10, height: 10 }]])).get(1)).toBeUndefined();
        expect(rgba[(5 * 10 + 5) * 4]).toBe(20);
    });

    it('leaves a facade dark all over (a dark material) as photographed', () => {
        const F = facade(1, [0, 0, 0], [0, 0, 1], [1, 0, 0]), G = facade(2, [20, 0, 0], [0, 0, 1], [1, 0, 0]);
        const rgba = solid(20);
        expect(continueFeatureless(new Map([[1, { f: F, rgba, width: 10, height: 10 }], [2, { f: G, rgba: solid(160), width: 10, height: 10 }]])).get(1)).toBeUndefined();
        expect(rgba[0]).toBe(20);
    });

    it('carries over the side facing the other way where nothing facing this way covers the region, read as seen from outside (not mirrored)', () => {
        // F: facing +z, its left 7 m dark, the rest light; B: behind it facing -z (its axisS -x: left to right as seen from
        // its own outside), its photo a ramp, darkest at its own left; no other facade facing +z to take from
        const F = facade(1, [0, 0, 0], [0, 0, 1], [1, 0, 0]), B = facade(3, [0, 0, -30], [0, 0, -1], [-1, 0, 0]);
        const rgba = solid(150), ramp = new Uint8Array(400);
        for (let y = 0; y < 10; y++) for (let c = 0; c < 7; c++) rgba.set([20, 20, 20, 255], (y * 10 + c) * 4);
        for (let y = 0; y < 10; y++) for (let c = 0; c < 10; c++) ramp.set([10 + 20 * c, 10 + 20 * c, 10 + 20 * c, 255], (y * 10 + c) * 4);
        const rep = continueFeatureless(new Map([[1, { f: F, rgba, width: 10, height: 10 }], [3, { f: B, rgba: ramp, width: 10, height: 10 }]])).get(1)!;
        expect(rep.dark).toBe(70);
        expect(rep.fromFacades).toEqual({ 3: 70 });
        expect(rep.fromOpposite).toBe(70);
        expect(rep.sources[0].opposite).toBe(true);
        // F reads left to right as B does from its own outside, aligned on the light photo beside the region: B's column c at F's column c
        for (let y = 0; y < 10; y++) for (let c = 0; c < 7; c++) expect(rgba[(y * 10 + c) * 4]).toBe(10 + 20 * c);
    });

    it("takes nothing from a donor at another height, from the donor's own holes or smear, and keeps the photo then", () => {
        const F = facade(1, [0, 0, 0], [0, 0, 1], [1, 0, 0]);
        // up the wall: G stands 50 m above F (its photo never reaches F's storeys); H beside F, but its photo is all smear
        const G = facade(2, [20, 50, 0], [0, 0, 1], [1, 0, 0]), Hf = facade(4, [20, 0, 0], [0, 0, 1], [1, 0, 0]);
        const smear = solid(90);
        const rep = continueFeatureless(new Map([
            [1, { f: F, rgba: smear, width: 10, height: 10, featureless: all() }],
            [2, { f: G, rgba: solid(60), width: 10, height: 10 }],
            [4, { f: Hf, rgba: solid(70), width: 10, height: 10, featureless: all() }]
        ])).get(1)!;
        expect(rep.fromFacades).toEqual({});
        expect(rep.kept).toBe(100);
        expect(Array.from(smear.slice(0, 3))).toEqual([90, 91, 92]);
    });
});
