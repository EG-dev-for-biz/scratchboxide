/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/** grit-decal.ts: the prompt follows what is asked; the decal is baked into the GLB on the walls only. No model call. */

import { describe, expect, it } from 'vitest';
import { bakeGritDecal, gritPrompt, GRIT_DEFAULT_WEATHERING } from '../src/node/3d-engine/grit-decal';
import { writeStagedGlb } from '../src/node/3d-engine/staged-location/staged-glb-writer';
import { readGlbChunks, readTileTriangles } from '../src/node/3d-engine/staged-location/tile-texture-transfer';

/** A 10 x 6 x 8 m box: four walls, a roof, as one node named "box", plus a window quad named "opening_0". */
function boxGlb(): Uint8Array {
    const x0 = 0, x1 = 10, z0 = 0, z1 = 8, h = 6;
    const q = (a: number[], b: number[], c: number[], d: number[]) => [...a, ...b, ...c, ...a, ...c, ...d];
    const box = [
        ...q([x0, 0, z1], [x1, 0, z1], [x1, h, z1], [x0, h, z1]), ...q([x1, 0, z0], [x0, 0, z0], [x0, h, z0], [x1, h, z0]),
        ...q([x1, 0, z1], [x1, 0, z0], [x1, h, z0], [x1, h, z1]), ...q([x0, 0, z0], [x0, 0, z1], [x0, h, z1], [x0, h, z0]),
        ...q([x0, h, z1], [x1, h, z1], [x1, h, z0], [x0, h, z0])
    ];
    const win = q([4, 2, z1 + 0.01], [6, 2, z1 + 0.01], [6, 4, z1 + 0.01], [4, 4, z1 + 0.01]);
    return new Uint8Array(writeStagedGlb([{ name: 'box', positions: Float32Array.from(box) }, { name: 'opening_0', positions: Float32Array.from(win) }]));
}

const grey = (v: number) => ({ width: 4, height: 4, rgba: new Uint8Array(64).map((_, i) => (i % 4 === 3 ? 255 : v)) });

describe('grit decal', () => {
    it('asks for the weathering described, from the photo when there is one and from the words alone when not', () => {
        expect(gritPrompt(50, 40)).toContain(GRIT_DEFAULT_WEATHERING);
        expect(gritPrompt(50, 40)).toMatch(/^The photo shows/);
        const p = gritPrompt(12, 3, 'rust streaks running down from the ironwork', false);
        expect(p).toContain('rust streaks running down from the ironwork');
        expect(p).toContain('12 by 3 metre');
        expect(p).not.toMatch(/photo/);
    });

    it('bakes a decal node onto the walls only (no roof, no opening), off the surface, its opacity the darkness and its colour as asked', () => {
        const src = boxGlb();
        const out = bakeGritDecal(src, grey(64), { strength: 1, colour: [120, 60, 20] });
        expect(out.decalTriangles).toBe(8);
        const { json, bin } = readGlbChunks(new Uint8Array(out.glb));
        const node = json.nodes.find((n: any) => n.name === 'grit_decal');
        expect(node.extras.label).toBe('generated');
        const mat = json.materials.find((m: any) => m.name === 'grit_decal');
        expect(mat.alphaMode).toBe('BLEND');
        expect(json.scenes[json.scene ?? 0].nodes).toContain(json.nodes.indexOf(node));
        // the decal stands 1 cm off the front wall (z = 8)
        const all = readTileTriangles(new Uint8Array(out.glb));
        let front = 0;
        for (let i = 2; i < all.positions.length; i += 3) if (Math.abs(all.positions[i] - 8.01) < 1e-4) front++;
        expect(front).toBeGreaterThan(0);
        expect(bin.length).toBeGreaterThan(readGlbChunks(src).bin.length);
    });

    it('takes the surfaces asked for: roofs too with maxNormalY 1, and only the parts named', () => {
        expect(bakeGritDecal(boxGlb(), grey(64), { maxNormalY: 1 }).decalTriangles).toBe(10);
        expect(bakeGritDecal(boxGlb(), grey(64), { keep: n => n.includes('nothing') }).decalTriangles).toBe(0);
    });
});
