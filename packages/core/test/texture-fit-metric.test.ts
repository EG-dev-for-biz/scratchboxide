/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The held-out fit metric (texture-fit-metric.ts) on a facade with windows seen by three panos. A texture painted where the
 * photos have it scores a small edge chamfer and a high gradient NCC; the same texture shifted by 0.4 m scores worse on both.
 * The score is held out: a texture that is right only on the texels a view's own pano made scores badly from that view.
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../src/common/spatial/staged-location-contracts';
import type { BakedTexturePlanes, DecodedImage, DepthMap, PinholeCamera, TexelProvenance } from '../src/common/spatial/texture-pass-contracts';
import { measureLayerFit, type FitScoreView } from '../src/node/3d-engine/staged-location/texture-fit-metric';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';
import { FACADE, facadeAtlas, lookAtCamera } from './helpers/texture-pass-fixtures';

const SIDE = 200;
/** Light stone with dark window openings (structural edges a pose error moves). */
function pattern(u: number, v: number): number {
    const a = ((u % 2.5) + 2.5) % 2.5, b = ((v % 3) + 3) % 3;
    return a > 0.6 && a < 1.6 && b > 0.8 && b < 2.2 ? 60 : 200;
}

function hitFacade(cam: PinholeCamera, px: number, py: number): { u: number; v: number; z: number } | null {
    const sx = (px - cam.cx) / cam.fx, sy = (py - cam.cy) / cam.fy;
    const dir: Vec3 = [cam.fwd[0] + sx * cam.right[0] - sy * cam.up[0], cam.fwd[1] + sx * cam.right[1] - sy * cam.up[1], cam.fwd[2] + sx * cam.right[2] - sy * cam.up[2]];
    if (Math.abs(dir[2]) < 1e-9) return null;
    const t = (FACADE.origin[2] - cam.eye[2]) / dir[2];
    if (!(t > 0)) return null;
    const u = cam.eye[0] + t * dir[0], v = cam.eye[1] + t * dir[1];
    if (u < 0 || u > FACADE.widthM || v < 0 || v > FACADE.heightM) return null;
    return { u, v, z: t };
}

function photo(cam: PinholeCamera): { image: DecodedImage; depth: DepthMap } {
    const rgba = new Uint8Array(cam.width * cam.height * 4), depthM = new Float32Array(cam.width * cam.height);
    for (let y = 0; y < cam.height; y++) for (let x = 0; x < cam.width; x++) {
        const i = y * cam.width + x, h = hitFacade(cam, x + 0.5, y + 0.5);
        const L = h ? pattern(h.u, h.v) : 140;
        rgba.set(h ? [L, L - 8, L - 16, 255] : [110, 150, 220, 255], i * 4);
        depthM[i] = h ? h.z : Infinity;
    }
    return { image: { width: cam.width, height: cam.height, rgba }, depth: { width: cam.width, height: cam.height, depthM } };
}

const PANOS = ['A', 'B', 'C'];
const EYES: Vec3[] = [[1.5, 1.7, -13], [5, 1.7, -12], [8.5, 1.7, -13]];

function scene() {
    const atlas = facadeAtlas(SIDE);
    const views: Array<FitScoreView & { depth: DepthMap }> = PANOS.map((panoId, k) => {
        const camera = lookAtCamera(EYES[k], [5, 3, 0], 480, 320, 62);
        const p = photo(camera);
        return { panoId, camera, image: p.image, depth: p.depth };
    });
    return { atlas, views };
}

/** Planes whose texel colour is pattern(u + shift(u)) and whose provenance names the pano of the facade third it lies in. */
function planes(atlas: ReturnType<typeof facadeAtlas>, shift: (u: number) => number): Pick<BakedTexturePlanes, 'albedo' | 'confidence' | 'provenance'> {
    const n = atlas.width * atlas.height;
    const albedo = new Uint8Array(n * 4), conf = new Uint8Array(n * 4);
    for (let t = 0; t < n; t++) {
        const u = atlas.texels.position[t * 3], v = atlas.texels.position[t * 3 + 1];
        const L = pattern(u + shift(u), v);
        albedo.set([L, L - 8, L - 16, 255], t * 4);
        const third = Math.min(2, Math.floor((u / FACADE.widthM) * 3));
        conf.set([third, 255, 0, 255], t * 4);
    }
    const provenance: TexelProvenance[] = PANOS.map(p => ({ source: 'street-view-projection', label: 'photo-inferred', method: 'test', panoIds: [p], coverage: 1 / 3 }));
    return { albedo, confidence: { width: atlas.width, height: atlas.height, data: conf }, provenance };
}

describe('held-out texture fit metric', () => {
    it('scores a texture painted where the photos have it above one shifted by 0.4 m, on held-out texels only', () => {
        const { atlas, views } = scene();
        const depthFor = (v: FitScoreView) => (v as typeof views[number]).depth;
        const dbg: Array<Parameters<NonNullable<Parameters<typeof measureLayerFit>[0]['debug']>>[0]> = [];
        const good = measureLayerFit({ atlas, planes: planes(atlas, () => 0), views, depthFor, widthPx: 480, debug: d => dbg.push(d) });
        const bad = measureLayerFit({ atlas, planes: planes(atlas, () => 0.4), views, depthFor, widthPx: 480 });
        expect(good.scoredViews).toBe(3);
        expect(good.chamferPx!).toBeLessThan(1);
        expect(good.gradNcc!).toBeGreaterThan(0.9);
        expect(bad.chamferPx!).toBeGreaterThan(good.chamferPx! + 2);
        expect(bad.gradNcc!).toBeLessThan(good.gradNcc! - 0.3);
        // the geometry is the same in both: the clay score does not change with the texture
        expect(Math.abs(bad.clayChamferPx! - good.clayChamferPx!)).toBeLessThan(0.01);
        // every view scores only what the other two panos made (about two thirds of what it sees)
        for (const v of good.views) expect(v.ownPixels).toBeGreaterThan(0);
        expect(good.heldOutShare).toBeGreaterThan(0.5);
        expect(good.heldOutShare).toBeLessThan(0.8);

        // right only on A's own third, shifted elsewhere: A's own texels are not scored, so A's view sees the error
        const ownOnly = measureLayerFit({ atlas, planes: planes(atlas, u => (u < FACADE.widthM / 3 ? 0 : 0.4)), views, depthFor, widthPx: 480 });
        const a = ownOnly.views.find(v => v.panoId === 'A')!, aGood = good.views.find(v => v.panoId === 'A')!;
        expect(a.chamferPx!).toBeGreaterThan(aGood.chamferPx! + 2);

        const out = path.resolve(__dirname, '../../../test-results/screenshots');
        fs.mkdirSync(out, { recursive: true });
        for (const d of dbg) {
            const px = new Uint8Array(d.w * d.h * 4);
            for (let i = 0; i < d.w * d.h; i++) {
                const L = d.held[i] ? d.render[i] : d.photo[i] * 0.4;
                px.set(d.renderEdges[i] ? [255, 0, 0, 255] : d.photoEdges[i] ? [0, 255, 0, 255] : d.clayEdges[i] ? [0, 0, 255, 255] : [L, L, L, 255], i * 4);
            }
            fs.writeFileSync(path.join(out, `texture_fit_metric_edges_${d.panoId}.png`), encodePng(d.w, d.h, px, 4));
            const rr = new Uint8Array(d.w * d.h); for (let i = 0; i < rr.length; i++) rr[i] = Math.min(255, d.render[i]);
            fs.writeFileSync(path.join(out, `texture_fit_metric_render_${d.panoId}.png`), encodePng(d.w, d.h, rr, 1));
        }
        const v = views[0];
        fs.writeFileSync(path.join(out, 'texture_fit_metric_view_A.png'), encodePng(v.image.width, v.image.height, v.image.rgba, 4));
        const p = planes(atlas, u => (u < FACADE.widthM / 3 ? 0 : 0.4));
        fs.writeFileSync(path.join(out, 'texture_fit_metric_atlas_own_only.png'), encodePng(atlas.width, atlas.height, p.albedo, 4));
    }, 60_000);
});
