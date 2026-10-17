/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The per-chart alignment searches a view posed against the scan's edges only within its own residual (one pose sigma), not
 * two: the search cannot reach the next course of a repeating wall. A view posed from the box pairs keeps the wider search.
 */

import { describe, expect, it } from 'vitest';
import { bakeStreetViewProjection } from '../src/node/3d-engine/staged-location/texture-projection';
import { EDGE_POSE_ALIGN_SIGMAS, projectionViewFromRegistered } from '../src/node/3d-engine/staged-location/texture-projection-views';
import type { Registration } from '../src/node/3d-engine/staged-location/pano-registration';
import type { DepthMap, ProjectionView } from '../src/common/spatial/texture-pass-contracts';
import { facadeAtlas, facadeViews, FACADE } from './helpers/texture-pass-fixtures';
import { bandJpeg, GREY, SKY, STONE } from './helpers/photo-ornament-fixtures';

/** The facade's depth from a view (camera z), Infinity off it. */
function depth(view: ProjectionView): DepthMap {
    const cam = view.camera, d = new Float32Array(cam.width * cam.height).fill(Infinity);
    for (let y = 0; y < cam.height; y++) for (let x = 0; x < cam.width; x++) {
        const sx = (x + 0.5 - cam.cx) / cam.fx, sy = (y + 0.5 - cam.cy) / cam.fy;
        const dir = [0, 1, 2].map(k => cam.fwd[k] + sx * cam.right[k] - sy * cam.up[k]);
        const t = (FACADE.origin[2] - cam.eye[2]) / dir[2];
        const hit = [cam.eye[0] + t * dir[0], cam.eye[1] + t * dir[1]];
        if (t > 0 && hit[0] >= 0 && hit[0] <= FACADE.widthM && hit[1] >= 0 && hit[1] <= FACADE.heightM) d[y * cam.width + x] = t;
    }
    return { width: cam.width, height: cam.height, depthM: d };
}

describe('alignment search width from the pose source', () => {
    it('a view posed against the edges is searched within one sigma, a box-posed view within two', async () => {
        const base = facadeViews().map(v => ({ panoId: v.panoId, camera: v.camera, image: v.image, poseQuality: 1, poseSigmaPx: 600 } as ProjectionView));
        const views = base.map((v, k) => (k === 1 ? { ...v, alignSigmas: EDGE_POSE_ALIGN_SIGMAS } : v));
        const res = await bakeStreetViewProjection({ atlas: facadeAtlas(48), views, depthFor: depth, options: {} });
        const w = res.report.alignment!.perView.map(p => p.windowPx!);
        // same sigma and nearly the same depth: the edge-posed view's window is half the others'
        expect(w[1]).toBeLessThan(0.65 * w[0]);
        expect(w[1]).toBeGreaterThan(0.35 * w[0]);
    });

    it('a registered view takes the narrower search when its pano was posed by its edges', () => {
        const jpeg = bandJpeg([SKY, STONE, GREY], 320, 240);
        const view = { panoId: 'P1', eye: [0, 2, 20] as [number, number, number], headingDeg: 0, pitchDeg: 5, fovDeg: 60, widthPx: 320, heightPx: 240 };
        const reg = (method?: 'edges'): Registration => ({
            corrections: new Map(), setAside: [], pairs: [], beforeRmsM: 1.8, afterRmsM: 1.3, used: 4, rejected: 0,
            perPano: [{ panoId: 'P1', dxM: 0, dzM: 0, dyawDeg: 0, dpitchDeg: 0, pairs: 4, beforeRmsM: 1.8, afterRmsM: 1.3, ...(method ? { method, edgeResidualM: 0.25 } : {}) }]
        });
        const boxed = projectionViewFromRegistered({ view, jpeg, registration: reg() });
        const edged = projectionViewFromRegistered({ view, jpeg, registration: reg('edges') });
        expect(boxed.alignSigmas).toBeUndefined();
        expect(edged.alignSigmas).toBe(EDGE_POSE_ALIGN_SIGMAS);
        // and its pose sigma is the edge residual's, not the box pairs'
        expect(edged.poseSigmaPx).toBeCloseTo(edged.camera.fx * 0.25, 6);
        expect(boxed.poseSigmaPx).toBeCloseTo(boxed.camera.fx * 1.3, 6);
    });
});
