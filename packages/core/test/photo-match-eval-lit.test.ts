/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The lit mode of photo-match-eval's renderer (renderTriangles `lit`): a wall with a proud pilaster of the wall's own colour,
 * seen straight on. Under the headlight the pilaster is invisible (its face has the wall's normal and colour); under the
 * sun it casts a shadow onto the wall beside it, a measurable luminance step. Also: the sun direction maths, open ground
 * stays unshadowed and unoccluded, and the clay arm is lit by the same sun. No network, no billed call.
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { defaultSunForLatitude, renderPng, renderTriangles, sunDirection } from '../src/node/3d-engine/staged-location/photo-match-eval';
import { replicaCamera } from '../src/node/3d-engine/staged-location/replica-scorecard';
import type { TileTriangles } from '../src/node/3d-engine/staged-location/tile-texture-transfer';

const SHOTS = path.resolve(__dirname, '../../../test-results/screenshots/photo_match_lit');

/** Quads (4 corners each, counter-clockwise seen from outside) in one flat linear colour. */
function soup(quads: number[][][], flat = [0.45, 0.42, 0.38]): TileTriangles {
    const P: number[] = [], N: number[] = [], T: number[] = [], F: number[] = [];
    for (const q of quads) {
        const e1 = q[1].map((v, i) => v - q[0][i]), e2 = q[3].map((v, i) => v - q[0][i]);
        const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        const l = Math.hypot(n[0], n[1], n[2]);
        for (const tri of [[0, 1, 2], [0, 2, 3]]) { for (const k of tri) P.push(...q[k]); N.push(n[0] / l, n[1] / l, n[2] / l); T.push(-1); F.push(...flat); }
    }
    return { positions: Float32Array.from(P), uvs: new Float32Array((P.length / 9) * 6), normals: Float32Array.from(N), texture: Int32Array.from(T), flatLinear: Float32Array.from(F), textures: [] };
}

/** A 20 x 10 m wall in the plane z = 0 facing +z (south), a 0.8 m wide pilaster standing 0.4 m proud at its centre, and the ground. */
function wallWithPilaster(): TileTriangles {
    const h = 10, d = 0.4, w = 0.4;
    return soup([
        [[-10, 0, 0], [-w, 0, 0], [-w, h, 0], [-10, h, 0]], [[w, 0, 0], [10, 0, 0], [10, h, 0], [w, h, 0]],
        [[-w, 0, d], [w, 0, d], [w, h, d], [-w, h, d]], // the pilaster's face
        [[-w, 0, 0], [-w, 0, d], [-w, h, d], [-w, h, 0]], [[w, 0, d], [w, 0, 0], [w, h, 0], [w, h, d]], // its sides
        [[-w, h, d], [w, h, d], [w, h, 0], [-w, h, 0]] // its top
    ]);
}
const ground = soup([[[-30, 0, 30], [30, 0, 30], [30, 0, -10], [-30, 0, -10]]], [0.3, 0.3, 0.3]);

const lum = (r: { width: number; rgba: Uint8Array }, x: number, y: number, rad = 3) => {
    let s = 0, n = 0;
    for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) {
        const o = ((y + dy) * r.width + x + dx) * 4;
        s += 0.2126 * r.rgba[o] + 0.7152 * r.rgba[o + 1] + 0.0722 * r.rgba[o + 2]; n++;
    }
    return s / n;
};

describe('photo-match lit mode', () => {
    const camera = replicaCamera({ eye: [0, 5, 20], target: [0, 5, 0], hfovDeg: 60 }, 320, 200);
    // the wall point at world x, height 5 m, as a pixel
    const px = (x: number) => Math.round(camera.cx + (camera.fx * x) / 20);
    const py = Math.round(camera.cy);
    // the sun from the east-south-east, 30 degrees up: the pilaster's shadow falls west of it, about d / tan(az) wide
    const sunDir = sunDirection(110, 30);

    it('the sun direction: azimuth clockwise from north, tile frame x east, y up, z south', () => {
        const n = sunDirection(0, 0), e = sunDirection(90, 0), up = sunDirection(0, 90);
        expect(n[2]).toBeCloseTo(-1, 6); expect(e[0]).toBeCloseTo(1, 6); expect(up[1]).toBeCloseTo(1, 6);
        expect(defaultSunForLatitude(-37.8).azimuthDeg).toBeLessThan(90); // southern hemisphere: a northern sun
        expect(defaultSunForLatitude(40.7).azimuthDeg).toBeGreaterThan(90);
    });

    it('a proud pilaster of the wall colour casts a measurable shadow only when lit', () => {
        const head = renderTriangles([wallWithPilaster()], camera, { context: [ground], supersample: 2 });
        const lit = renderTriangles([wallWithPilaster()], camera, { context: [ground], supersample: 2, lit: { sunDir } });
        fs.mkdirSync(SHOTS, { recursive: true });
        fs.writeFileSync(path.join(SHOTS, 'pilaster_headlight.png'), renderPng(head));
        fs.writeFileSync(path.join(SHOTS, 'pilaster_lit.png'), renderPng(lit));
        // the shadow lies west of the pilaster: x in about [-0.4 - 0.4 / tan(20 deg) .. -0.4] = [-1.5, -0.4]
        const inShadow = px(-0.9), open = px(-4);
        const headStep = Math.abs(lum(head, inShadow, py) - lum(head, open, py)) / lum(head, open, py);
        const litStep = (lum(lit, open, py) - lum(lit, inShadow, py)) / lum(lit, open, py);
        expect(headStep).toBeLessThan(0.02);
        expect(litStep).toBeGreaterThanOrEqual(0.1);
        // the east side of the pilaster is not shadowed by it
        expect(Math.abs(lum(lit, px(1.2), py) - lum(lit, px(4), py)) / lum(lit, px(4), py)).toBeLessThan(0.05);
    });

    it('open ground far from the wall is neither shadowed nor occluded; a wall facing away from the sun is darker', () => {
        const cam2 = replicaCamera({ eye: [0, 12, 28], target: [0, 0, 12], hfovDeg: 60 }, 320, 200);
        const lit = renderTriangles([wallWithPilaster()], cam2, { context: [ground], supersample: 2, lit: { sunDir, ao: false } });
        const litAo = renderTriangles([wallWithPilaster()], cam2, { context: [ground], supersample: 2, lit: { sunDir } });
        const c = Math.round(cam2.cx), r = Math.round(cam2.cy);
        expect(Math.abs(lum(lit, c, r) - lum(litAo, c, r))).toBeLessThan(2);
        // the sun from behind the wall: its face is lit by the sky alone
        const behind = renderTriangles([wallWithPilaster()], camera, { context: [ground], supersample: 2, lit: { sunDir: sunDirection(0, 30) } });
        const front = renderTriangles([wallWithPilaster()], camera, { context: [ground], supersample: 2, lit: { sunDir: sunDirection(180, 30) } });
        expect(lum(behind, px(-4), py)).toBeLessThan(lum(front, px(-4), py) * 0.8);
    });

    it('the clay arm is lit by the same sun and shows the same shadow', () => {
        const clay = renderTriangles([wallWithPilaster()], camera, { context: [ground], supersample: 2, clay: true, lit: { sunDir } });
        fs.mkdirSync(SHOTS, { recursive: true });
        fs.writeFileSync(path.join(SHOTS, 'pilaster_clay_lit.png'), renderPng(clay));
        const step = (lum(clay, px(-4), py) - lum(clay, px(-0.9), py)) / lum(clay, px(-4), py);
        expect(step).toBeGreaterThanOrEqual(0.1);
    });
});
