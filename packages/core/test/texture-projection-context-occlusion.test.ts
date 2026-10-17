/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Visibility from the true geometry: a fitted face spans an opening, and a statue stands in front of the wall. Against the
 * fitted face alone the projection paints the building seen through the opening and the statue onto the wall; with the full
 * scan as context neither leaks, and the report counts what the context caught.
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../src/common/spatial/staged-location-contracts';
import type { DepthMap, PinholeCamera, ProjectionView } from '../src/common/spatial/texture-pass-contracts';
import { bakeStreetViewProjection, type ProjectionBakeResult } from '../src/node/3d-engine/staged-location/texture-projection';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';
import { FACADE, facadeAtlas, lookAtCamera } from './helpers/texture-pass-fixtures';

interface Rect { origin: Vec3; w: number; h: number; color: (a: number, b: number) => Vec3 }
const stone = (u: number, v: number): Vec3 => [168 + 3 * u, 160 + 2 * v, 148 + u];
const OPENING = { u0: 4, u1: 6, v1: 4 };
const STATUE = { u0: 1.5, u1: 2.6, v1: 3.5, standoff: 1.5 };

/** Rectangles parallel to the facade (normal -z) at depth z = origin[2]. */
function cast(cam: PinholeCamera, rects: Rect[], px: number, py: number): { rgb: Vec3; depth: number } {
    const sx = (px - cam.cx) / cam.fx, sy = (py - cam.cy) / cam.fy;
    const dir: Vec3 = [cam.fwd[0] + sx * cam.right[0] - sy * cam.up[0], cam.fwd[1] + sx * cam.right[1] - sy * cam.up[1], cam.fwd[2] + sx * cam.right[2] - sy * cam.up[2]];
    let best = Infinity, rgb: Vec3 = [120, 150, 210];
    for (const r of rects) {
        if (Math.abs(dir[2]) < 1e-9) continue;
        const t = (r.origin[2] - cam.eye[2]) / dir[2];
        if (!(t > 0) || t >= best) continue;
        const a = cam.eye[0] + t * dir[0] - r.origin[0], b = cam.eye[1] + t * dir[1] - r.origin[1];
        if (a < 0 || a > r.w || b < 0 || b > r.h) continue;
        best = t; rgb = r.color(a + r.origin[0], b + r.origin[1]);
    }
    return { rgb, depth: best };
}

function render(cam: PinholeCamera, rects: Rect[]): { image: { width: number; height: number; rgba: Uint8Array }; depth: DepthMap } {
    const rgba = new Uint8Array(cam.width * cam.height * 4), depthM = new Float32Array(cam.width * cam.height);
    for (let y = 0; y < cam.height; y++) for (let x = 0; x < cam.width; x++) {
        const i = y * cam.width + x, c = cast(cam, rects, x + 0.5, y + 0.5);
        rgba.set([c.rgb[0], c.rgb[1], c.rgb[2], 255], i * 4);
        depthM[i] = Number.isFinite(c.depth) ? c.depth : Infinity;
    }
    return { image: { width: cam.width, height: cam.height, rgba }, depth: { width: cam.width, height: cam.height, depthM } };
}

// the scan as it is: the wall around the opening, a red building behind it, a blue statue in front
const SCAN: Rect[] = [
    { origin: [0, 0, 0], w: OPENING.u0, h: FACADE.heightM, color: stone },
    { origin: [OPENING.u1, 0, 0], w: FACADE.widthM - OPENING.u1, h: FACADE.heightM, color: stone },
    { origin: [OPENING.u0, OPENING.v1, 0], w: OPENING.u1 - OPENING.u0, h: FACADE.heightM - OPENING.v1, color: stone },
    { origin: [-6, 0, 7], w: 22, h: 14, color: () => [215, 35, 30] },
    { origin: [STATUE.u0, 0, -STATUE.standoff], w: STATUE.u1 - STATUE.u0, h: STATUE.v1, color: () => [30, 45, 225] }
];
// the occluder the projection had: the fitted face, closed over the opening, and no statue
const FITTED: Rect[] = [{ origin: [0, 0, 0], w: FACADE.widthM, h: FACADE.heightM, color: stone }];
const EYES: Record<string, Vec3> = { front: [5, 1.7, -14], left: [-3, 1.7, -12], right: [13, 1.7, -12] };

function views(): Array<{ view: ProjectionView; fitted: DepthMap; scan: DepthMap }> {
    return Object.entries(EYES).map(([panoId, eye]) => {
        const camera = lookAtCamera(eye, [5, 3, 0], 240, 144, 70);
        const photo = render(camera, SCAN);
        return { view: { panoId, camera, image: photo.image, poseQuality: 1, poseSigmaPx: 0 }, fitted: render(camera, FITTED).depth, scan: photo.depth };
    });
}

/** Baked texels whose colour is not the wall's (the building or the statue painted on it), and all baked texels. */
function leaks(res: ProjectionBakeResult): { leaked: number; baked: number; inOpening: number } {
    const atlas = facadeAtlas(48);
    let leaked = 0, baked = 0, inOpening = 0;
    for (let t = 0; t < atlas.width * atlas.height; t++) {
        if (res.albedo[t * 4 + 3] !== 255) continue;
        baked++;
        const u = atlas.texels.position[t * 3], v = atlas.texels.position[t * 3 + 1];
        if (u > OPENING.u0 && u < OPENING.u1 && v < OPENING.v1) inOpening++;
        const g = stone(u, v);
        if (Math.max(...[0, 1, 2].map(k => Math.abs(res.albedo[t * 4 + k] - g[k]))) > 40) leaked++;
    }
    return { leaked, baked, inOpening };
}

describe('Street View projection: visibility from the full scan (contextDepthFor)', () => {
    it('paints neither the background through an opening nor a statue onto the wall, and counts the leaks it caught', async () => {
        const rig = views();
        const atlas = facadeAtlas(48);
        const depthOf = new Map(rig.map(r => [r.view, r]));
        const options = { align: false as const };
        const without = await bakeStreetViewProjection({ atlas, views: rig.map(r => r.view), depthFor: v => depthOf.get(v)!.fitted, options });
        const withScan = await bakeStreetViewProjection({ atlas, views: rig.map(r => r.view), depthFor: v => depthOf.get(v)!.fitted, contextDepthFor: v => depthOf.get(v)!.scan, options });

        const a = leaks(without), b = leaks(withScan);
        // against the fitted face alone: the building in the opening and the statue land on the wall
        expect(a.inOpening).toBeGreaterThan(20);
        expect(a.leaked / a.baked).toBeGreaterThan(0.05);
        // with the scan: nothing in the opening, and (almost) no texel of another colour
        expect(b.inOpening).toBe(0);
        expect(b.leaked / Math.max(1, b.baked)).toBeLessThan(0.005);
        // the wall that is seen is still painted
        expect(b.baked).toBeGreaterThan(0.6 * a.baked);
        // and the report says what the scan caught: seen past (the opening) and hidden (the statue)
        const c = withScan.report.context!;
        expect(c.caughtSeenPast).toBeGreaterThan(0);
        expect(c.caughtOccluded).toBeGreaterThan(0);
        expect(c.leakShare).toBeGreaterThan(0.02);
        expect(without.report.context).toBeUndefined();

        const out = path.resolve(__dirname, '../../../test-results/screenshots');
        fs.mkdirSync(out, { recursive: true });
        const W = atlas.width, side = new Uint8Array(W * 2 * atlas.height * 4);
        for (let y = 0; y < atlas.height; y++) for (let x = 0; x < W; x++) {
            side.set(without.albedo.subarray((y * W + x) * 4, (y * W + x) * 4 + 4), (y * 2 * W + x) * 4);
            side.set(withScan.albedo.subarray((y * W + x) * 4, (y * W + x) * 4 + 4), (y * 2 * W + W + x) * 4);
        }
        fs.writeFileSync(path.join(out, 'texture_projection_context_occlusion.png'), encodePng(2 * W, atlas.height, side, 4));
    });
});
