/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * How well a model's own relief agrees with Street View (© Google): from each photo's camera, the model's contours and creases
 * (meshEdgeSamples on its depth render) against the photo's structural edges, inside the model's silhouette. Two chamfers, in
 * pixels, truncated at FIT_CHAMFER_TRUNCATION_PX: model to photo (are the model's edges in the photo: false relief raises it)
 * and photo to model (are the photo's edges in the model: missing relief raises it). Lower is better. Compared on one
 * build before and after a geometry step, the poses' error is common to both.
 */

import type { RenderMesh3D } from '../../spatial/HeadlessMeshSilhouetteRenderer';
import { meshEdgeSamples } from '../../spatial/StreetViewCrossViewRefiner';
import { distanceTransform, PLATE_EMPTY_DEPTH, projectToFrame, renderFrameDepth, type FrameCamera } from '../../spatial/StreetViewPoseRegistrar';
import { chamferMean, erode, FIT_CHAMFER_TRUNCATION_PX, structuralEdges } from './texture-fit-metric';

export interface ClayScoreView { id: string; camera: FrameCamera; rgba: ArrayLike<number>; width: number; height: number }
export interface ClayScore {
    /** Pixel-weighted over the views that had enough edges. */
    modelToPhotoPx: number | null; photoToModelPx: number | null;
    views: Array<{ id: string; pixels: number; modelEdges: number; photoEdges: number; modelToPhotoPx: number | null; photoToModelPx: number | null }>;
}

export function streetViewClayScore(mesh: RenderMesh3D, views: ClayScoreView[]): ClayScore {
    const out: ClayScore['views'] = [];
    for (const v of views) {
        const cam = v.camera, W = cam.width, H = cam.height;
        if (v.width !== W || v.height !== H) continue;
        const D = renderFrameDepth(mesh, cam), seen = new Uint8Array(W * H), lum = new Float32Array(W * H);
        for (let i = 0; i < W * H; i++) { if (D[i] < PLATE_EMPTY_DEPTH * 0.5) seen[i] = 1; lum[i] = 0.2126 * v.rgba[i * 4] + 0.7152 * v.rgba[i * 4 + 1] + 0.0722 * v.rgba[i * 4 + 2]; }
        // inside the silhouette, off its rim (the outline is the registration's business, not the relief's)
        const region = erode(seen, W, H, 4);
        let pixels = 0; for (let i = 0; i < region.length; i++) pixels += region[i];
        const all = new Uint8Array(W * H).fill(1), model = new Uint8Array(W * H);
        for (const X of meshEdgeSamples(D, cam, all)) {
            const q = projectToFrame(cam, X);
            if (!q) continue;
            const ix = Math.floor(q[0]), iy = Math.floor(q[1]);
            if (ix >= 0 && iy >= 0 && ix < W && iy < H) model[iy * W + ix] = 1;
        }
        const photo = structuralEdges(lum, W, H, region);
        const count = (m: Uint8Array) => { let n = 0; for (let i = 0; i < m.length; i++) if (m[i] && region[i]) n++; return n; };
        const dtPhoto = distanceTransform(photo, W, H, FIT_CHAMFER_TRUNCATION_PX + 1), dtModel = distanceTransform(model, W, H, FIT_CHAMFER_TRUNCATION_PX + 1);
        const m2p = chamferMean(model, dtPhoto, region), p2m = chamferMean(photo, dtModel, region);
        out.push({ id: v.id, pixels, modelEdges: count(model), photoEdges: count(photo), modelToPhotoPx: m2p === null ? null : r3(m2p), photoToModelPx: p2m === null ? null : r3(p2m) });
    }
    const wmean = (pick: (x: ClayScore['views'][number]) => number | null) => {
        let s = 0, n = 0;
        for (const x of out) { const val = pick(x); if (val === null) continue; s += val * x.pixels; n += x.pixels; }
        return n ? r3(s / n) : null;
    };
    return { modelToPhotoPx: wmean(x => x.modelToPhotoPx), photoToModelPx: wmean(x => x.photoToModelPx), views: out };
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;
