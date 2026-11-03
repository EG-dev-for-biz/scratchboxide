/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K's Street View clay score and visible-defects check on a remesh worker thread (remesh-scores.ts) give the very
 * numbers the inline calls give, on a small fixture: a box clay before and after a step, photographed from two street
 * cameras, and a textured cube with a hole in its front.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { streetViewClayScores, streetViewClayScoresInline, visibleDefects, visibleDefectsInline } from '../src/node/3d-engine/staged-location/remesh-scores';
import { writeStagedGlbFile } from '../src/node/3d-engine/staged-location/staged-glb-writer';
import { assembleGlb } from '../src/node/3d-engine/staged-location/glb-bytes';
import { frameCamera, ZERO_CORRECTION } from '../src/node/spatial/StreetViewPoseRegistrar';
import type { ClayScoreView } from '../src/node/3d-engine/staged-location/streetview-clay-score';

type V = [number, number, number];

/** A square as two triangles (corner o, edges a and b), counter-clockwise seen from the side a x b points to. */
const quad = (o: V, a: V, b: V): V[] => {
    const p = (i: number, j: number): V => [o[0] + a[0] * i + b[0] * j, o[1] + a[1] * i + b[1] * j, o[2] + a[2] * i + b[2] * j];
    return [p(0, 0), p(1, 0), p(1, 1), p(0, 0), p(1, 1), p(0, 1)];
};
/** A 1 m grid over a face (corner o, unit steps a and b, n x m), cells skipped by `hole`. */
const grid = (o: V, a: V, b: V, n = 10, m = 10, hole: (i: number, j: number) => boolean = () => false): V[] => {
    const out: V[] = [];
    for (let j = 0; j < m; j++) for (let i = 0; i < n; i++) if (!hole(i, j)) out.push(...quad([o[0] + a[0] * i + b[0] * j, o[1] + a[1] * i + b[1] * j, o[2] + a[2] * i + b[2] * j], a, b));
    return out;
};
/** A 10 x h x 10 m box, every face wound outward, the front (z = 10) optionally holed. */
const box = (h: number, hole?: (i: number, j: number) => boolean): V[] => [
    ...grid([0, 0, 10], [1, 0, 0], [0, 1, 0], 10, h, hole),
    ...grid([10, 0, 0], [-1, 0, 0], [0, 1, 0], 10, h),
    ...grid([0, 0, 0], [0, 0, 1], [0, 1, 0], 10, h),
    ...grid([10, 0, 10], [0, 0, -1], [0, 1, 0], 10, h),
    ...grid([0, h, 10], [1, 0, 0], [0, 0, -1]),
    ...grid([0, 0, 0], [1, 0, 0], [0, 0, 1])
];

function clayFile(dir: string, name: string, tris: V[]): string {
    const file = path.join(dir, name), soup = Float32Array.from(tris.flat());
    writeStagedGlbFile(file, [{ name: 'scan', positions: soup, indices: Uint32Array.from({ length: soup.length / 3 }, (_, i) => i) }], {});
    return file;
}

/** One textured building node, its texture coordinates planar with width on every face. */
function texturedFile(dir: string, tris: V[]): string {
    const pos = Float32Array.from(tris.flat()), uv = Float32Array.from(tris.flatMap(([x, y, z]) => [x + z, y + 0.5 * z]));
    const bp = Buffer.from(pos.buffer), bu = Buffer.from(uv.buffer);
    const json = {
        asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'Building', mesh: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, material: 0 }] }],
        materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }], textures: [{ source: 0 }], images: [{ uri: 'data:image/png;base64,' }],
        buffers: [{ byteLength: bp.length + bu.length }],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bp.length }, { buffer: 0, byteOffset: bp.length, byteLength: bu.length }],
        accessors: [{ bufferView: 0, componentType: 5126, count: tris.length, type: 'VEC3' }, { bufferView: 1, componentType: 5126, count: tris.length, type: 'VEC2' }]
    };
    const file = path.join(dir, 'textured.glb');
    fs.writeFileSync(file, assembleGlb(json, Buffer.concat([bp, bu])));
    return file;
}

/** A street camera looking at the box, its photo a facade of window bands and piers, so it has structural edges. */
function view(id: string, eye: V): ClayScoreView {
    const W = 640, H = 480;
    // the heading whose forward points at the box's centre
    let headingDeg = 0, best = -2;
    for (let h = 0; h < 360; h++) {
        const f = frameCamera(eye, h, 0, 70, 8, 8, ZERO_CORRECTION, h).fwd, dx = 5 - eye[0], dz = 5 - eye[2];
        const d = (f[0] * dx + f[2] * dz) / Math.hypot(dx, dz);
        if (d > best) { best = d; headingDeg = h; }
    }
    const camera = frameCamera(eye, headingDeg, 25, 70, W, H, ZERO_CORRECTION, headingDeg);
    const rgba = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const v = (x % 40 < 22 && y % 36 < 20) ? 60 : 190;
        rgba.set([v, v - 8, v - 16, 255], (y * W + x) * 4);
    }
    return { id, camera, rgba, width: W, height: H };
}

describe('pipeline K remesh scores on a worker thread', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remesh-scores-'));

    it('scores the clay against Street View to the same numbers as on this thread', async () => {
        const before = clayFile(dir, 'before.glb', box(30)), after = clayFile(dir, 'after.glb', box(26));
        const views = [view('a', [5, 1.8, 40]), view('b', [32, 1.8, 30])];
        const inline = streetViewClayScoresInline(before, after, views);
        const worker = await streetViewClayScores(before, after, views);
        expect(worker).toEqual(inline);
        // the fixture is scored at all, not two empty answers that agree
        expect(inline.before.views.length).toBe(2);
        expect(inline.before.modelToPhotoPx).not.toBeNull();
        expect(inline.before.photoToModelPx).not.toBeNull();
        expect(inline.after.views.some(v => v.modelEdges > 0)).toBe(true);
    }, 120_000);

    it('finds the same holes seen from outside as on this thread', async () => {
        const file = texturedFile(dir, box(10, (i, j) => i >= 3 && i < 7 && j >= 3 && j < 7));
        const inline = visibleDefectsInline(file);
        const worker = await visibleDefects(file);
        expect(worker).toEqual(inline);
        expect(inline.holeShare).toBeGreaterThan(0);
        expect(inline.views.length).toBeGreaterThan(0);
    }, 120_000);

    it('stops at once when the stage is stopped', async () => {
        const ctl = new AbortController();
        ctl.abort(new Error('stopped by the user'));
        await expect(visibleDefects(path.join(dir, 'nowhere.glb'), { signal: ctl.signal })).rejects.toThrow('stopped by the user');
    });
});
