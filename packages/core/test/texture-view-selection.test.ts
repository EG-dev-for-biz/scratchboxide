/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * View selection in the projection bake (round 5):
 *  - photo-consistency outlier rejection (texture-seams.ts outlierDeltaE): of four views of a wall, the best weighted shows a red
 *    fence the scan does not hold. Without the rejection that view is chosen; with it the three views that agree are, and the
 *    fence view's weight leaves the blend;
 *  - incidence and resolution floors: a grazing view contributes no texel;
 *  - texels a fitted surface holds off the scan (scan-deviation.ts) are not projected.
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../src/common/spatial/staged-location-contracts';
import type { DecodedImage, DepthMap, PinholeCamera, ProjectionView } from '../src/common/spatial/texture-pass-contracts';
import { bakeStreetViewProjection } from '../src/node/3d-engine/staged-location/texture-projection';
import { selectViewsPerRegion } from '../src/node/3d-engine/staged-location/texture-seams';
import { measureScanDeviation } from '../src/node/3d-engine/staged-location/scan-deviation';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';
import { FACADE, facadeAtlas, lookAtCamera } from './helpers/texture-pass-fixtures';

const stone = (u: number, v: number): number => 170 + 20 * Math.sin(u * 1.3) * Math.cos(v * 1.1);
/** The fence one view sees in front of the wall: a box in u (2..5), v below 2.5, painted red in that view's photo. */
const FENCE = { u0: 2, u1: 5, v1: 2.5 };

function render(cam: PinholeCamera, fence: boolean): { image: DecodedImage; depth: DepthMap } {
    const rgba = new Uint8Array(cam.width * cam.height * 4), depthM = new Float32Array(cam.width * cam.height).fill(Infinity);
    for (let py = 0; py < cam.height; py++) for (let px = 0; px < cam.width; px++) {
        const sx = (px + 0.5 - cam.cx) / cam.fx, sy = (py + 0.5 - cam.cy) / cam.fy;
        const d: Vec3 = [cam.fwd[0] + sx * cam.right[0] - sy * cam.up[0], cam.fwd[1] + sx * cam.right[1] - sy * cam.up[1], cam.fwd[2] + sx * cam.right[2] - sy * cam.up[2]];
        const t = -cam.eye[2] / d[2];
        const o = (py * cam.width + px) * 4;
        let c: Vec3 = [120, 150, 210];
        if (t > 0) {
            const u = cam.eye[0] + t * d[0], v = cam.eye[1] + t * d[1];
            if (u >= 0 && u <= FACADE.widthM && v >= 0 && v <= FACADE.heightM) {
                const l = stone(u, v);
                c = fence && u > FENCE.u0 && u < FENCE.u1 && v < FENCE.v1 ? [200, 40, 35] : [l, l - 6, l - 14];
                depthM[py * cam.width + px] = t * (d[0] * cam.fwd[0] + d[1] * cam.fwd[1] + d[2] * cam.fwd[2]);
            }
        }
        rgba.set([c[0], c[1], c[2], 255], o);
    }
    return { image: { width: cam.width, height: cam.height, rgba }, depth: { width: cam.width, height: cam.height, depthM } };
}

const EYES: Array<[string, Vec3, boolean]> = [['fence', [3.5, 1.7, -7], true], ['a', [1, 1.7, -12], false], ['b', [6, 1.7, -13], false], ['c', [9, 1.7, -11], false]];

function setup() {
    const atlas = facadeAtlas(80);
    const rendered = EYES.map(([panoId, eye, fence]) => {
        const camera = lookAtCamera(eye, [5, 3, 0], 320, 200, 80);
        const r = render(camera, fence);
        // the view that sees the fence is the nearest and the best posed, so it wins where it sees the wall
        const view: ProjectionView = { panoId, camera, image: r.image, poseQuality: fence ? 1 : 0.5, poseSigmaPx: 0 };
        return { view, depth: r.depth };
    });
    const depthFor = (v: ProjectionView) => rendered.find(r => r.view === v)!.depth;
    return { atlas, views: rendered.map(r => r.view), depthFor };
}

describe('view selection (round 5)', () => {
    it('rejects the one view that shows something else where three others agree, in the choice and in the weights', () => {
        // one 16 x 16 texel chart; four views see all of it: three show the stone, the fourth (the best weighted) a red fence
        const atlas = facadeAtlas(16);
        const n = 16 * 16;
        const colours: Vec3[] = [[0.9, 0.3, 0.25], [0.4, 0.38, 0.34], [0.41, 0.39, 0.35], [0.39, 0.37, 0.33]];
        const samples = colours.map(c => ({ texel: Int32Array.from({ length: n }, (_, t) => t), rgb: Float32Array.from({ length: n * 3 }, (_, i) => c[i % 3]) }));
        const weights = [0.4, 0.2, 0.2, 0.2];
        const start = Int32Array.from({ length: n + 1 }, (_, t) => t * 4);
        const index = () => ({
            start, view: Int32Array.from({ length: n * 4 }, (_, p) => p % 4), sample: Int32Array.from({ length: n * 4 }, (_, p) => Math.floor(p / 4)),
            weight: Float64Array.from({ length: n * 4 }, (_, p) => weights[p % 4])
        });
        const plain = selectViewsPerRegion(atlas, samples, index());
        const idx = index();
        const robust = selectViewsPerRegion(atlas, samples, idx, { outlierDeltaE: 14 });
        const share = (l: Int32Array, k: number) => l.filter(x => x === k).length / n;
        expect(share(plain.label, 0)).toBeGreaterThan(0.9);
        expect(share(robust.label, 0)).toBe(0);
        expect(robust.outliers).toBeGreaterThan(0);
        // the fence view leaves the blend too: its weight is 0 and the others' sum to 1
        for (let t = 0; t < n; t++) {
            expect(idx.weight[t * 4]).toBe(0);
            expect(idx.weight[t * 4 + 1] + idx.weight[t * 4 + 2] + idx.weight[t * 4 + 3]).toBeCloseTo(1, 6);
        }
    });

    it('drops grazing views by the incidence floor and coarse views by the resolution floor', async () => {
        const atlas = facadeAtlas(80);
        // a view along the wall at about 80 degrees incidence, and a far one (coarse)
        const graze = lookAtCamera([-12, 1.7, -2.2], [5, 3, 0], 320, 200, 60);
        const far = lookAtCamera([5, 3, -40], [5, 3, 0], 160, 100, 60);
        const views: ProjectionView[] = [graze, far].map((camera, k) => ({ panoId: k ? 'far' : 'graze', camera, image: render(camera, false).image, poseQuality: 1, poseSigmaPx: 0 }));
        const depth = new Map(views.map(v => [v, render(v.camera, false).depth]));
        const opts = { align: false as const, refinePose: false as const, exposure: false, regionSelect: false as const };
        const loose = await bakeStreetViewProjection({ atlas, views, depthFor: v => depth.get(v)!, options: opts });
        const strict = await bakeStreetViewProjection({ atlas, views, depthFor: v => depth.get(v)!, options: { ...opts, minCosIncidence: 0.375, minResolution: 0.5 } });
        const by = (r: typeof loose, id: string) => r.report.views.find(v => v.panoId === id)!.samples;
        expect(by(loose, 'graze')).toBeGreaterThan(100);
        expect(by(loose, 'far')).toBeGreaterThan(100);
        expect(by(strict, 'graze')).toBe(0);
        expect(by(strict, 'far')).toBe(0);
    }, 60_000);

    it('measures where a fitted face stands off the scan and leaves those texels unprojected', async () => {
        const { atlas, views, depthFor } = setup();
        // the scan: the wall plane with a 0.3 m deep niche over u 6..8, v 1..4 (the fitted face spans it flat)
        const v: number[] = [], ix: number[] = [];
        const quad = (a: Vec3, b: Vec3, c: Vec3, d: Vec3) => { const k = v.length / 3; v.push(...a, ...b, ...c, ...d); ix.push(k, k + 1, k + 2, k, k + 2, k + 3); };
        const N = { u0: 6, u1: 8, v0: 1, v1: 4, depth: 0.3 };
        quad([0, 0, 0], [N.u0, 0, 0], [N.u0, 6, 0], [0, 6, 0]);
        quad([N.u1, 0, 0], [10, 0, 0], [10, 6, 0], [N.u1, 6, 0]);
        quad([N.u0, 0, 0], [N.u1, 0, 0], [N.u1, N.v0, 0], [N.u0, N.v0, 0]);
        quad([N.u0, N.v1, 0], [N.u1, N.v1, 0], [N.u1, 6, 0], [N.u0, 6, 0]);
        quad([N.u0, N.v0, N.depth], [N.u1, N.v0, N.depth], [N.u1, N.v1, N.depth], [N.u0, N.v1, N.depth]);
        const scan = { vertices: new Float32Array(v), indices: new Uint32Array(ix) };
        const dev = measureScanDeviation(atlas, scan);
        const area = ((N.u1 - N.u0) * (N.v1 - N.v0)) / (FACADE.widthM * FACADE.heightM);
        expect(dev.offTexels / dev.checked).toBeGreaterThan(area * 0.7);
        expect(dev.offTexels / dev.checked).toBeLessThan(area * 1.05);
        expect(dev.offMedianM!).toBeGreaterThan(0.2);
        const res = await bakeStreetViewProjection({ atlas, views, depthFor, options: { align: false, refinePose: false, excludeTexels: dev.off } });
        let projectedOff = 0;
        for (let t = 0; t < atlas.width * atlas.height; t++) if (dev.off[t] && res.albedo[t * 4 + 3]) projectedOff++;
        expect(projectedOff).toBe(0);
    }, 60_000);
});
