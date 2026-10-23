/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The photo-match rasterizer under an orthographic camera: a known box rendered top-down at a given ground sample distance
 * covers exactly its footprint in pixels, whatever the eye height (no perspective), reads its roof texture, and the clay
 * variant works unchanged. Screenshots under test-results/screenshots/photo_match/.
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { SRGB8_TO_LINEAR } from '../src/common/spatial/photogrammetric-delight';
import { composeGrid, renderTriangles, PHOTO_MATCH_BACKGROUND, PHOTO_MATCH_CLAY } from '../src/node/3d-engine/staged-location/photo-match-eval';
import { orthoReferenceCamera, orthoReferenceRecord } from '../src/node/3d-engine/staged-location/ortho-reference';
import type { TileTriangles } from '../src/node/3d-engine/staged-location/tile-texture-transfer';

const SHOTS = path.resolve(__dirname, '../../../test-results/screenshots/photo_match');

/** A flat texture (linear RGB from sRGB8). */
function flat(size: number, c: [number, number, number]): TileTriangles['textures'][number] {
    const linear = new Float32Array(size * size * 3);
    for (let i = 0; i < size * size; i++) for (let k = 0; k < 3; k++) linear[i * 3 + k] = SRGB8_TO_LINEAR[c[k]];
    return { width: size, height: size, linear, repeatS: false, repeatT: false };
}

/** A box on the ground (y = 0) in the tile frame: x in [x0, x1], z in [z0, z1], h tall; the roof textured with `roof`, the walls with `wall`. */
function box(x0: number, x1: number, z0: number, z1: number, h: number, roof: TileTriangles['textures'][number], wall: TileTriangles['textures'][number]): TileTriangles {
    const P: number[] = [], N: number[] = [], UV: number[] = [], T: number[] = [];
    const quad = (a: number[], b: number[], c: number[], d: number[], n: number[], tex: number) => {
        P.push(...a, ...b, ...c, ...a, ...c, ...d);
        N.push(...n, ...n);
        UV.push(0, 1, 1, 1, 1, 0, 0, 1, 1, 0, 0, 0);
        T.push(tex, tex);
    };
    quad([x0, h, z0], [x1, h, z0], [x1, h, z1], [x0, h, z1], [0, 1, 0], 0);
    quad([x0, 0, z0], [x1, 0, z0], [x1, h, z0], [x0, h, z0], [0, 0, -1], 1);
    quad([x1, 0, z1], [x0, 0, z1], [x0, h, z1], [x1, h, z1], [0, 0, 1], 1);
    quad([x1, 0, z0], [x1, 0, z1], [x1, h, z1], [x1, h, z0], [1, 0, 0], 1);
    quad([x0, 0, z1], [x0, 0, z0], [x0, h, z0], [x0, h, z1], [-1, 0, 0], 1);
    return { positions: Float32Array.from(P), uvs: Float32Array.from(UV), normals: Float32Array.from(N), texture: Int32Array.from(T), flatLinear: new Float32Array(T.length * 3), textures: [roof, wall] };
}

const px = (r: { width: number; rgba: Uint8Array }, x: number, y: number) => Array.from(r.rgba.subarray((y * r.width + x) * 4, (y * r.width + x) * 4 + 3));

/** Bounding box of the pixels the arm covers (coverage > 0.5). */
function footprint(r: { width: number; height: number; coverage: Float32Array }): { x0: number; x1: number; y0: number; y1: number; n: number } {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, n = 0;
    for (let y = 0; y < r.height; y++) for (let x = 0; x < r.width; x++) {
        if (r.coverage[y * r.width + x] <= 0.5) continue;
        n++; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    return { x0, x1, y0, y1, n };
}

describe('photo-match evaluator: orthographic (top-down) camera', () => {
    const red: [number, number, number] = [200, 40, 40], cream: [number, number, number] = [230, 220, 200];
    // a 10 x 6 m box, 8 m tall, from x = 0 to 10 (east) and z = -6 to 0 (north of the origin)
    const target = box(0, 10, -6, 0, 8, flat(16, red), flat(16, cream));
    // 0.25 m per pixel, a 200 x 200 image centred on the origin
    const cam = orthoReferenceCamera({ pixelM: 0.25, widthPx: 200, heightPx: 200 });

    it('covers exactly the footprint at the ground sample distance: 10 m x 6 m at 0.25 m/px is 40 x 24 px, east right and north up', () => {
        const r = renderTriangles([target], cam);
        expect(r.width).toBe(200);
        const f = footprint(r);
        // x: 100 .. 139 (10 m / 0.25), y: 76 .. 99 (6 m north of the centre is above it)
        expect([f.x0, f.x1, f.y0, f.y1]).toEqual([100, 139, 76, 99]);
        expect(f.n).toBe(40 * 24);
        // the walls are vertical: top-down they add no pixels, so only the roof texture shows
        expect(px(r, 120, 88)).toEqual(px(r, 101, 77));
        const roof = px(r, 120, 88);
        expect(roof[0]).toBeGreaterThan(roof[1] + 60);
        // the background where nothing stands
        expect(px(r, 20, 150)).toEqual([...PHOTO_MATCH_BACKGROUND]);
        expect(r.triangles).toBe(10);
    });

    it('has no perspective: the eye height changes nothing but the depth, and a taller box covers the same pixels', () => {
        const low = renderTriangles([target], orthoReferenceCamera({ pixelM: 0.25, widthPx: 200, heightPx: 200 }, { eyeHeightM: 50 }));
        const high = renderTriangles([target], orthoReferenceCamera({ pixelM: 0.25, widthPx: 200, heightPx: 200 }, { eyeHeightM: 5000 }));
        expect(footprint(low)).toEqual(footprint(high));
        expect(Buffer.from(low.rgba).equals(Buffer.from(high.rgba))).toBe(true);
        const tall = renderTriangles([box(0, 10, -6, 0, 60, flat(16, red), flat(16, cream))], cam);
        expect(footprint(tall)).toEqual(footprint(low));
        // a finer GSD scales the footprint, not the geometry: at 0.1 m/px the same box is 100 x 60 px
        const fine = footprint(renderTriangles([target], orthoReferenceCamera({ pixelM: 0.1, widthPx: 300, heightPx: 300 })));
        expect([fine.x1 - fine.x0 + 1, fine.y1 - fine.y0 + 1]).toEqual([100, 60]);
    });

    it('hides a roof under a higher one (depth along the view) and draws the context in the same frame', () => {
        const over = box(4, 8, -4, -2, 12, flat(16, [40, 40, 200]), flat(16, cream));
        const r = renderTriangles([target], cam, { context: [over] });
        // the higher context roof wins the depth test where it overlaps; the arm's coverage counts only the arm
        const c = px(r, 124, 88);
        expect(c[2]).toBeGreaterThan(c[0] + 60);
        expect(r.coverage[88 * 200 + 124]).toBe(0);
        expect(r.coverage[88 * 200 + 104]).toBe(1);
        const nearer = renderTriangles([over, target], cam);
        expect(px(nearer, 124, 88)).toEqual(c);
    });

    it('renders the clay variant unchanged: one flat tone on the roof, the clay sky elsewhere, textures not shown', () => {
        const a = renderTriangles([target], cam, { clay: true });
        const b = renderTriangles([box(0, 10, -6, 0, 8, flat(16, [20, 200, 20]), flat(16, [0, 0, 0]))], cam, { clay: true });
        expect(Buffer.from(a.rgba).equals(Buffer.from(b.rgba))).toBe(true);
        expect(footprint(a)).toEqual(footprint(renderTriangles([target], cam)));
        const roof = new Set<string>();
        for (let y = 77; y < 99; y++) for (let x = 101; x < 139; x++) roof.add(px(a, x, y).join(','));
        expect(roof.size).toBe(1);
        px(a, 20, 150).forEach((c, k) => expect(Math.abs(c - PHOTO_MATCH_CLAY.background[k])).toBeLessThanOrEqual(1));
        fs.mkdirSync(SHOTS, { recursive: true });
        const tex = renderTriangles([target], cam);
        fs.writeFileSync(path.join(SHOTS, 'photo_match_ortho_box.png'), composeGrid([{ image: tex, label: 'ORTHO 0.25 M/PX' }, { image: a, label: 'ORTHO CLAY' }], { tileWidth: 400, columns: 2 }));
    });
});
