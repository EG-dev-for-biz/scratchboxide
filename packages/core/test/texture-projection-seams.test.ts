/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Seams of the one-view-per-region bake (texture-seams.ts) on an analytic carved facade seen by exactly registered
 * cameras whose photos differ the way real captures do:
 *  - a lighting gradient across one photo that a per-chart gain cannot undo: the gradient-domain (Poisson) blend spreads
 *    the step between regions instead of showing it, where the band blend leaves a patch;
 *  - a cast shadow on part of the facade in the frontal (best-weighted) photo: the shadow-aware data cost takes the
 *    other view there.
 * Screenshots: test-results/screenshots/texture_bake/seams_*.png (gitignored).
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../src/common/spatial/staged-location-contracts';
import type { DecodedImage, DepthMap, PinholeCamera, ProjectionView, UvAtlas } from '../src/common/spatial/texture-pass-contracts';
import { bakeStreetViewProjection, type ProjectionBakeOptions } from '../src/node/3d-engine/staged-location/texture-projection';
import { encodePng } from '../src/node/texture-processing';
import { facadeAtlas, lookAtCamera } from './helpers/texture-pass-fixtures';

const SHOTS = path.resolve(__dirname, '../../../test-results/screenshots/texture_bake');
const W = 10, H = 6;

function carved(u: number, v: number): number {
    const course = Math.floor(v / 0.55), off = course % 2 ? 0.45 : 0;
    const jx = ((u + off) % 0.9 + 0.9) % 0.9, jy = v - course * 0.55;
    let l = 185 + 25 * Math.sin(u * 0.7) * Math.cos(v * 0.9);
    if (jx < 0.05 || jy < 0.05) l = 70;
    return l;
}

/** The facade as a camera sees it, with a per-point multiplier on the albedo (lighting) of that photo. */
function render(cam: PinholeCamera, light: (u: number, v: number) => number): DecodedImage {
    const rgba = new Uint8Array(cam.width * cam.height * 4);
    for (let py = 0; py < cam.height; py++) for (let px = 0; px < cam.width; px++) {
        const sx = (px + 0.5 - cam.cx) / cam.fx, sy = (py + 0.5 - cam.cy) / cam.fy;
        const d: Vec3 = [cam.fwd[0] + sx * cam.right[0] - sy * cam.up[0], cam.fwd[1] + sx * cam.right[1] - sy * cam.up[1], cam.fwd[2] + sx * cam.right[2] - sy * cam.up[2]];
        const t = -cam.eye[2] / d[2];
        const o = (py * cam.width + px) * 4;
        let l = 128;
        if (t > 0) { const u = cam.eye[0] + t * d[0], v = cam.eye[1] + t * d[1]; if (u >= 0 && u <= W && v >= 0 && v <= H) l = Math.min(255, carved(u, v) * light(u, v)); }
        rgba[o] = rgba[o + 1] = rgba[o + 2] = Math.round(l); rgba[o + 3] = 255;
    }
    return { width: cam.width, height: cam.height, rgba };
}

function depthOf(cam: PinholeCamera): DepthMap {
    const depthM = new Float32Array(cam.width * cam.height).fill(Infinity);
    for (let py = 0; py < cam.height; py++) for (let px = 0; px < cam.width; px++) {
        const sx = (px + 0.5 - cam.cx) / cam.fx, sy = (py + 0.5 - cam.cy) / cam.fy;
        const dz = cam.fwd[2] + sx * cam.right[2] - sy * cam.up[2], dx = cam.fwd[0] + sx * cam.right[0] - sy * cam.up[0], dy = cam.fwd[1] + sx * cam.right[1] - sy * cam.up[1];
        const t = -cam.eye[2] / dz;
        if (!(t > 0)) continue;
        const u = cam.eye[0] + t * dx, v = cam.eye[1] + t * dy;
        if (u >= 0 && u <= W && v >= 0 && v <= H) depthM[py * cam.width + px] = t;
    }
    return { width: cam.width, height: cam.height, depthM };
}

const EYES: Record<string, Vec3> = { front: [5, 1.7, -13], left: [-2, 1.7, -11], right: [12, 1.7, -11] };
function views(spec: Array<[string, (u: number, v: number) => number]>): ProjectionView[] {
    return spec.map(([panoId, light]) => {
        const cam = lookAtCamera(EYES[panoId], [5, 3, 0], 480, 288, 60);
        return { panoId, camera: cam, image: render(cam, light), poseQuality: 1, poseSigmaPx: 20 };
    });
}

async function bake(atlas: UvAtlas, v: ProjectionView[], options: ProjectionBakeOptions) {
    return bakeStreetViewProjection({ atlas, views: v, depthFor: view => depthOf(view.camera), options: { align: false, ...options } });
}

const lum = (albedo: Uint8Array, i: number) => albedo[i * 4];

describe('Street View projection: seams between regions', () => {
    const atlas = facadeAtlas(200);

    it('spreads a lighting step between views in the gradient domain instead of showing it as a patch', async () => {
        // the photos are lit differently across the facade (a side light on each oblique view): no single gain fits a chart
        const v = views([['left', (u) => 1 + 0.35 * Math.exp(-(((u - 5) / 1.2) ** 2))], ['right', () => 1]]);
        const band = await bake(atlas, v, { poisson: false });
        const pois = await bake(atlas, v, {});
        const sb = band.report.outputSeam, sp = pois.report.outputSeam;
        expect(pois.report.poisson, 'the gradient-domain blend ran').toBeDefined();
        expect(pois.report.poisson!.boundaryEdges).toBeGreaterThan(0);
        fs.mkdirSync(SHOTS, { recursive: true });
        fs.writeFileSync(path.join(SHOTS, 'seams_band_blend.png'), encodePng(atlas.width, atlas.height, Buffer.from(band.albedo)));
        fs.writeFileSync(path.join(SHOTS, 'seams_poisson.png'), encodePng(atlas.width, atlas.height, Buffer.from(pois.albedo)));
        fs.writeFileSync(path.join(SHOTS, 'seams_report.json'), JSON.stringify({ band: sb, poisson: sp, poissonReport: pois.report.poisson, regions: pois.report.regions }));
        // the step across region boundaries (5 x 5 means 6 texels apart): below the texture's own contrast and below the
        // band blend's; and no hard edge: the largest neighbour-to-neighbour jump across a boundary is no larger than inside
        expect(sp.p95DeltaE, JSON.stringify({ band: sb, poisson: sp })).toBeLessThan(sb.p95DeltaE);
        expect(sp.p95DeltaE).toBeLessThan(sp.interiorP95DeltaE);
        const jump = (albedo: Uint8Array, label: 'boundary' | 'interior'): number => {
            const S = atlas.width, steps: number[] = [];
            // boundary: where the left/right regions meet, on rows away from joints (the regions' boundary runs near u = 5)
            for (let y = 0; y < S; y++) for (let x = 0; x + 1 < S; x++) {
                const i = y * S + x, u = atlas.texels.position[i * 3];
                const near = Math.abs(u - 5) < 0.6;
                if ((label === 'boundary') !== near || !albedo[i * 4 + 3] || !albedo[(i + 1) * 4 + 3]) continue;
                steps.push(Math.abs(albedo[(i + 1) * 4] - albedo[i * 4]));
            }
            steps.sort((a, b) => a - b);
            return steps[Math.floor(steps.length * 0.5)];
        };
        expect(jump(pois.albedo, 'boundary'), 'median neighbour step near the boundary').toBeLessThanOrEqual(jump(pois.albedo, 'interior') + 1);
    }, 120_000);

    it('takes another view where the best-weighted photo has a cast shadow', async () => {
        const inShadow = (u: number, v: number) => u > 3 && u < 7 && v > 1.5 && v < 4.5;
        const v = views([['front', (u, w) => (inShadow(u, w) ? 0.4 : 1)], ['left', () => 1]]);
        const plain = await bake(atlas, v, { regionSelect: { shadowCost: 0 } });
        const aware = await bake(atlas, v, {});
        // mean output luminance inside the shadowed rectangle against the unshadowed truth
        const P = atlas.texels.position;
        const meanIn = (albedo: Uint8Array): { out: number; truth: number } => {
            let s = 0, t = 0, n = 0;
            for (let i = 0; i < atlas.width * atlas.height; i++) {
                if (!albedo[i * 4 + 3]) continue;
                const u = P[i * 3], w = P[i * 3 + 1];
                if (!(u > 3.3 && u < 6.7 && w > 1.8 && w < 4.2)) continue;
                s += lum(albedo, i); t += carved(u, w); n++;
            }
            return { out: s / n, truth: t / n };
        };
        const a = meanIn(plain.albedo), b = meanIn(aware.albedo);
        fs.mkdirSync(SHOTS, { recursive: true });
        fs.writeFileSync(path.join(SHOTS, 'seams_shadow_plain.png'), encodePng(atlas.width, atlas.height, Buffer.from(plain.albedo)));
        fs.writeFileSync(path.join(SHOTS, 'seams_shadow_aware.png'), encodePng(atlas.width, atlas.height, Buffer.from(aware.albedo)));
        expect(aware.report.regions!.shadowedBlocks, JSON.stringify({ plain: plain.report.regions, aware: aware.report.regions })).toBeLessThan(plain.report.regions!.shadowedBlocks);
        expect(aware.report.regions!.shadowedBlocks).toBeLessThan(0.25 * plain.report.regions!.shadowedBlocks);
        // the shadow is gone from the bake (within 10% of the lit albedo; the shadow-blind selection is 60% off)
        expect(Math.abs(b.out - b.truth) / b.truth, JSON.stringify({ plain: a, aware: b })).toBeLessThan(0.1);
        expect(Math.abs(a.out - a.truth)).toBeGreaterThan(2 * Math.abs(b.out - b.truth));
    }, 120_000);

    it('moves block boundaries onto image edges without raising the views\' disagreement there', async () => {
        const v = views([['left', (u) => 1.3 - 0.06 * u], ['right', (u) => 0.7 + 0.06 * u]]);
        const blocky = await bake(atlas, v, { poisson: false, regionSelect: { refineBandTexels: 0 } });
        const refined = await bake(atlas, v, { poisson: false });
        expect(refined.report.regions!.refinedTexels).toBeGreaterThan(0);
        expect(refined.report.p95SeamDeltaE, JSON.stringify([blocky.report.p95SeamDeltaE, refined.report.p95SeamDeltaE])).toBeLessThanOrEqual(blocky.report.p95SeamDeltaE + 0.5);
    }, 120_000);
});
