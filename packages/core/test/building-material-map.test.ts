/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { buildingMaterialMap, BUILDING_MATERIAL_MAP_PARAMS } from '../src/node/3d-engine/staged-location/building-material-map';
import type { TileTriangles } from '../src/node/3d-engine/staged-location/tile-texture-transfer';

/**
 * A 20 x 10 m wall (x 0..20, y 0..10, facing +z) textured by one 400 x 200 image: grey stone over x 0..14 lit by a
 * gradient (brighter to the right) with a cast shadow across x 4..8 (half as bright, a little bluer: skylight), and a
 * red material over x 14..20. A roof (y = 10, facing up) of the same stone, lit 1.6 times brighter.
 */
function wall(): TileTriangles {
    const W = 400, H = 200, lin = new Float32Array(W * H * 3);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const xm = (x + 0.5) / 20, o = (y * W + x) * 3, grain = (((x * 73856093) ^ (y * 19349663)) >>> 0) % 7 / 400;
        if (xm >= 14) { lin.set([0.32 + grain, 0.08 + grain, 0.06 + grain], o); continue; }
        let k = 0.6 + 0.4 * (xm / 14);
        let blue = 1;
        if (xm >= 4 && xm < 8) { k *= 0.5; blue = 1.12; }
        lin.set([0.22 * k + grain, 0.2 * k + grain, 0.18 * k * blue + grain], o);
    }
    const roof = new Float32Array(64 * 64 * 3);
    for (let i = 0; i < 64 * 64; i++) roof.set([0.22 * 1.6, 0.2 * 1.6, 0.18 * 1.6], 3 * i);
    // two triangles of wall (uv 0..1 over the image), two of roof (its own image)
    const positions = Float32Array.from([0, 0, 0, 20, 0, 0, 20, 10, 0, 0, 0, 0, 20, 10, 0, 0, 10, 0, 0, 10, 0, 14, 10, 0, 14, 10, -6, 0, 10, 0, 14, 10, -6, 0, 10, -6]);
    const uvs = Float32Array.from([0, 1, 1, 1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]);
    const normals = Float32Array.from([0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0]);
    return { positions, uvs, normals, texture: Int32Array.from([0, 0, 1, 1]), flatLinear: new Float32Array(12), textures: [{ width: W, height: H, linear: lin, repeatS: false, repeatT: false }, { width: 64, height: 64, linear: roof, repeatS: false, repeatT: false }] } as unknown as TileTriangles;
}

describe('building material map: continuous materials, the light told apart', () => {
    it('reads one stone through a gradient, a cast shadow and a brighter roof, and the red beside it as another', () => {
        const m = buildingMaterialMap(wall(), { ...BUILDING_MATERIAL_MAP_PARAMS, spacingM: 0.25, neighbourM: 0.4 });
        expect(m.stats.samples).toBeGreaterThan(3000);
        expect(m.materials).toHaveLength(2);
        const idAt = (x: number, y: number, z = 0.0) => { let best = -1, bd = Infinity; for (let i = 0; i < m.material.length; i++) { const d = (m.p[3 * i] - x) ** 2 + (m.p[3 * i + 1] - y) ** 2 + (m.p[3 * i + 2] - z) ** 2; if (d < bd) { bd = d; best = i; } } return m.material[best]; };
        const stone = idAt(2, 5), shadow = idAt(6, 5), bright = idAt(12, 5), red = idAt(17, 5), roof = idAt(7, 10, -3);
        expect([shadow, bright, roof]).toEqual([stone, stone, stone]);
        expect(red).not.toBe(stone);
        // the shadow shift was measured on the wall itself: darker reads bluer (b over g rises as light falls)
        expect(m.shadowSlope[1]).toBeLessThan(0);
    });

    it('tells dark glass from shaded stone of the same colour by the structure\'s openings, not by colour', () => {
        // a 20 x 10 m wall of stone, a row of windows (dark neutral glass) and a cast shadow on the stone that is the same colour as the glass
        const W = 400, H = 200, lin = new Float32Array(W * H * 3);
        const win = (x: number, y: number) => [2, 6, 10, 14].some(c => x >= c && x < c + 2) && y >= 3 && y < 7;
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const xm = (x + 0.5) / 20, ym = 10 - (y + 0.5) / 20, o = (y * W + x) * 3;
            const shade = xm >= 17 ? 0.45 : 1, glass = win(xm, ym);
            const k = glass ? 0.45 : shade;
            lin.set([0.22 * k, 0.2 * k, 0.18 * k * (glass || shade < 1 ? 1.06 : 1)], o);
        }
        const t = { positions: Float32Array.from([0, 0, 0, 20, 0, 0, 20, 10, 0, 0, 0, 0, 20, 10, 0, 0, 10, 0]), uvs: Float32Array.from([0, 1, 1, 1, 1, 0, 0, 1, 1, 0, 0, 0]), normals: Float32Array.from([0, 0, 1, 0, 0, 1]), texture: Int32Array.from([0, 0]), flatLinear: new Float32Array(6), textures: [{ width: W, height: H, linear: lin, repeatS: false, repeatT: false }] } as unknown as TileTriangles;
        const P = { ...BUILDING_MATERIAL_MAP_PARAMS, spacingM: 0.25, neighbourM: 0.4, minRegionM2: 0.5 };
        // the openings as the structure intent gives them: the facade photo at 0.1 m a pixel, its top at y = 10
        const frame = { centroid: [10, 5, 0], normal: [0, 0, 1], axisS: [1, 0, 0], axisT: [0, 1, 0], orthoSMin: -10, orthoTMax: 5, pixel: 0.1, width: 200, height: 100 };
        const rects = [2, 6, 10, 14].map(c => [c * 10, 30, (c + 2) * 10, 70]);
        const at = (m: ReturnType<typeof buildingMaterialMap>, x: number, y: number) => { let best = -1, bd = Infinity; for (let i = 0; i < m.material.length; i++) { const d = (m.p[3 * i] - x) ** 2 + (m.p[3 * i + 1] - y) ** 2; if (d < bd) { bd = d; best = i; } } return m.material[best]; };
        const without = buildingMaterialMap(t, P), withOpenings = buildingMaterialMap(t, P, { openings: [{ frame, rects }] });
        // colour alone: the glass is read as stone in shade
        expect(at(without, 3, 5)).toBe(at(without, 18.5, 5));
        // with the structure: glass and shaded stone apart, shaded and lit stone one
        expect(at(withOpenings, 3, 5)).not.toBe(at(withOpenings, 18.5, 5));
        expect(at(withOpenings, 18.5, 5)).toBe(at(withOpenings, 1, 1));
        expect(withOpenings.materials.find(m => m.id === at(withOpenings, 3, 5))!.role).toBe('opening');
    });
});

