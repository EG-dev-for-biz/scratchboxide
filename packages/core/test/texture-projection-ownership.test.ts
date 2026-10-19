/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pixel ownership in the Street View projection (streetview-ownership.ts): a photo pixel textures the structure only if the
 * photo shows the structure there. Two failures the photo-match bake-off found, in analytic form: one view's photo shows a
 * neighbour's facade where its pose puts the structure (St. Mark's), and another photo has a billboard in front of the
 * facade that no mesh holds (Haughwout). Without ownership both are painted on the wall; with it neither is, the other views
 * colour those texels, and the bake says how many samples it refused. The ownership step itself is checked with stand-in
 * segmenters: a mask that matches the structure's projection stands, one elsewhere and a "not in this photo" answer refuse
 * the whole view. No network, no model, no Python.
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../src/common/spatial/staged-location-contracts';
import type { DepthMap, PinholeCamera, ProjectionView } from '../src/common/spatial/texture-pass-contracts';
import { bakeStreetViewProjection, type ProjectionBakeResult } from '../src/node/3d-engine/staged-location/texture-projection';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';
import { maskIou, ownershipPrompts, OwnershipTargetNotFound, ownViews, OWNERSHIP_MIN_IOU, type OwnershipSegmenter } from '../src/node/3d-engine/staged-location/streetview-ownership';
import { renderFrameDepth } from '../src/node/spatial/StreetViewPoseRegistrar';
import { FACADE, facadeAtlas, lookAtCamera } from './helpers/texture-pass-fixtures';

const stone = (u: number, v: number): Vec3 => [168 + 3 * u, 160 + 2 * v, 148 + u];
const NEIGHBOUR: Vec3 = [40, 150, 60];
const BILLBOARD: Vec3 = [230, 30, 200];
const EYES: Record<string, Vec3> = { front: [5, 1.7, -14], left: [-3, 1.7, -12], right: [13, 1.7, -12] };

/** Ray-casts the facade plane (z = 0); `paint` decides the photo's colour at a facade point (u, v). */
function shoot(cam: PinholeCamera, paint: (u: number, v: number) => Vec3 | undefined): { image: { width: number; height: number; rgba: Uint8Array }; depth: DepthMap } {
    const rgba = new Uint8Array(cam.width * cam.height * 4), depthM = new Float32Array(cam.width * cam.height).fill(Infinity);
    for (let y = 0; y < cam.height; y++) for (let x = 0; x < cam.width; x++) {
        const i = y * cam.width + x;
        const sx = (x + 0.5 - cam.cx) / cam.fx, sy = (y + 0.5 - cam.cy) / cam.fy;
        const d = [cam.fwd[0] + sx * cam.right[0] - sy * cam.up[0], cam.fwd[1] + sx * cam.right[1] - sy * cam.up[1], cam.fwd[2] + sx * cam.right[2] - sy * cam.up[2]];
        const t = -cam.eye[2] / d[2];
        const u = cam.eye[0] + t * d[0], v = cam.eye[1] + t * d[1];
        let c: Vec3 = [120, 150, 210];
        if (t > 0 && u >= 0 && u <= FACADE.widthM && v >= 0 && v <= FACADE.heightM) {
            depthM[i] = t * (d[0] * cam.fwd[0] + d[1] * cam.fwd[1] + d[2] * cam.fwd[2]);
            c = paint(u, v) ?? stone(u, v);
        }
        rgba.set([c[0], c[1], c[2], 255], i * 4);
    }
    return { image: { width: cam.width, height: cam.height, rgba }, depth: { width: cam.width, height: cam.height, depthM } };
}

const inBillboard = (u: number, v: number) => u > 6 && u < 9 && v > 2 && v < 4.5;

/** The rig: 'left' and 'right' photograph a neighbour where their poses put the facade; 'front' has a billboard in front of part of it. */
function rig(): Array<{ view: ProjectionView; depth: DepthMap; truth: Uint8Array }> {
    return Object.entries(EYES).map(([panoId, eye]) => {
        const camera = lookAtCamera(eye, [5, 3, 0], 240, 144, 70);
        const shot = shoot(camera, (u, v) => (panoId !== 'front' ? NEIGHBOUR : panoId === 'front' && inBillboard(u, v) ? BILLBOARD : undefined));
        // what a segmenter that knows the structure would cut out: the facade's pixels, less the neighbour and the billboard
        const truth = new Uint8Array(camera.width * camera.height);
        const facadeOnly = shoot(camera, (u, v) => (panoId !== 'front' || inBillboard(u, v) ? [0, 0, 0] : [255, 255, 255]));
        for (let i = 0; i < truth.length; i++) truth[i] = Number.isFinite(facadeOnly.depth.depthM[i]) && facadeOnly.image.rgba[i * 4] === 255 ? 1 : 0;
        return { view: { panoId, camera, image: shot.image, poseQuality: 1, poseSigmaPx: 0 }, depth: shot.depth, truth };
    });
}

/** Baked texels painted with the neighbour or the billboard, and all baked texels. */
function wrong(res: ProjectionBakeResult): { neighbour: number; billboard: number; baked: number } {
    let neighbour = 0, billboard = 0, baked = 0;
    for (let t = 0; t < res.width * res.height; t++) {
        if (res.albedo[t * 4 + 3] !== 255) continue;
        baked++;
        const c = [res.albedo[t * 4], res.albedo[t * 4 + 1], res.albedo[t * 4 + 2]];
        if (c[1] > c[0] + 60) neighbour++;
        if (c[0] > 180 && c[2] > 150 && c[1] < 120) billboard++;
    }
    return { neighbour, billboard, baked };
}

const facadeMesh = () => ({ vertices: [0, 0, 0, FACADE.widthM, 0, 0, FACADE.widthM, FACADE.heightM, 0, 0, FACADE.heightM, 0], indices: [0, 1, 2, 0, 2, 3] });

describe('Street View projection: pixel ownership', () => {
    it('paints neither a neighbour nor a billboard on the structure when the photo pixels are checked, and records the refusals', async () => {
        const r = rig();
        const atlas = facadeAtlas(48);
        const depthOf = new Map(r.map(x => [x.view, x.depth]));
        const options = { align: false as const, refinePose: false as const };
        const plain = await bakeStreetViewProjection({ atlas, views: r.map(x => x.view), depthFor: v => depthOf.get(v)!, options });
        // the side views vouch for nothing (their photos are not the structure); the front one for the facade less the billboard
        const owned = r.map(x => ({ ...x.view, ownerMask: x.truth }));
        const ownedDepth = new Map(owned.map((v, k) => [v, r[k].depth]));
        const checked = await bakeStreetViewProjection({ atlas, views: owned, depthFor: v => ownedDepth.get(v)!, options });
        const a = wrong(plain), b = wrong(checked);
        // unchecked, the two side photos outvote the front one: the neighbour is painted across the facade
        expect(a.neighbour).toBeGreaterThan(0.5 * a.baked);
        expect(b.neighbour).toBe(0);
        expect(b.billboard).toBe(0);
        // the front view still colours the facade; what no owned pixel reaches (behind the billboard) is left to the next rung
        expect(b.baked).toBeGreaterThan(0.5 * a.baked);
        expect(b.baked).toBeLessThan(a.baked);
        expect(checked.report.ownership).toMatchObject({ views: 3 });
        expect(checked.report.ownership!.refusedSamples).toBeGreaterThan(100);
        expect(plain.report.ownership).toBeUndefined();
        const d = checked.degradations.find(x => x.reasonCode === 'street_view_not_owned')!;
        expect(d.reason).toMatch(/Street View samples were refused because the photo pixel is not the structure's/);

        const out = path.resolve(__dirname, '../../../test-results/screenshots');
        fs.mkdirSync(out, { recursive: true });
        const W = atlas.width, side = new Uint8Array(W * 2 * atlas.height * 4);
        for (let y = 0; y < atlas.height; y++) for (let x = 0; x < W; x++) {
            side.set(plain.albedo.subarray((y * W + x) * 4, (y * W + x) * 4 + 4), (y * 2 * W + x) * 4);
            side.set(checked.albedo.subarray((y * W + x) * 4, (y * W + x) * 4 + 4), (y * 2 * W + W + x) * 4);
        }
        fs.writeFileSync(path.join(out, 'texture_projection_ownership.png'), encodePng(2 * W, atlas.height, side, 4));
    });

    it('prompts the segmenter from geometry: a box around the structure, points inside it, negatives on what stands nearer', () => {
        const cam = lookAtCamera(EYES.front, [5, 3, 0], 240, 144, 70);
        const target = renderFrameDepth(facadeMesh(), cam);
        // a post 4 m in front of the facade's left part
        const ctx = Float32Array.from(target);
        for (let y = 0; y < cam.height; y++) for (let x = 60; x < 80; x++) ctx[y * cam.width + x] = 10;
        const p = ownershipPrompts(target, ctx, cam.width, cam.height);
        expect(p.targetPixels).toBeGreaterThan(5000);
        expect(p.positive.length).toBeGreaterThanOrEqual(3);
        for (const [x, y] of p.positive) {
            const i = Math.floor(y * cam.height) * cam.width + Math.floor(x * cam.width);
            expect(p.target[i]).toBe(1);
        }
        expect(p.negative.length).toBeGreaterThan(0);
        for (const [x] of p.negative) expect(x * cam.width).toBeGreaterThanOrEqual(60), expect(x * cam.width).toBeLessThan(80);
        expect(p.box[0]).toBeLessThan(p.positive[0][0]);
        expect(p.box[2]).toBeGreaterThan(p.positive[0][0]);
    });

    it('keeps a cut-out that agrees with the structure, refuses a view whose cut-out is elsewhere or that does not show it', async () => {
        const r = rig();
        const views = r.map(x => x.view);
        const seen: Array<string | undefined> = [];
        const segment: OwnershipSegmenter = async (image, prompts) => {
            seen.push(prompts.target);
            const k = views.findIndex(v => v.image === image);
            if (views[k].panoId === 'left') throw new OwnershipTargetNotFound('the photo shows a green neighbour, not the structure');
            if (views[k].panoId === 'right') return new Uint8Array(image.width * image.height).map((_, i) => (i % image.width < 30 ? 1 : 0)); // a strip at the edge
            return r[k].truth;
        };
        const own = await ownViews({ views, structure: facadeMesh(), segment, target: 'the test facade' });
        const by = Object.fromEntries(own.records.map(x => [x.panoId, x]));
        expect(seen.every(t => t === 'the test facade')).toBe(true);
        expect(by.front).toMatchObject({ status: 'segmented', prompts: 'description+geometry' });
        expect(by.front.iou!).toBeGreaterThan(OWNERSHIP_MIN_IOU);
        expect(by.left).toMatchObject({ status: 'refused', maskPixels: 0 });
        expect(by.left.reason).toMatch(/not in this photo \(the photo shows a green neighbour/);
        expect(by.right.status).toBe('refused');
        expect(by.right.reason).toMatch(/intersection over union/);
        // refused views carry an all-zero mask (none of their pixels textures the structure); the kept one its cut-out, grown
        const left = own.views.find(v => v.panoId === 'left')!, front = own.views.find(v => v.panoId === 'front')!;
        expect(left.ownerMask!.every(v => v === 0)).toBe(true);
        expect(maskIou(front.ownerMask!, r[0].truth)).toBeGreaterThan(0.7);
        // a segmenter that cannot run refuses the view too, with its error
        const broken = await ownViews({ views: [views[0]], structure: facadeMesh(), segment: async () => { throw new Error('python is missing'); } });
        expect(broken.records[0]).toMatchObject({ status: 'refused', prompts: 'geometry' });
        expect(broken.records[0].reason).toMatch(/the segmenter failed \(python is missing\)/);
    });
});
