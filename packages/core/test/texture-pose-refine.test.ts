/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The second pose registration from the per-chart alignment (texture-pose-refine.ts): a carved facade split into four
 * charts, seen by three cameras whose stated poses are off by a fraction of a degree. The alignment's correspondences
 * over several charts pin each view's pose; the refined poses are kept only because the views then agree better, and
 * they are closer to the true cameras. Screenshot: test-results/screenshots/texture_bake/pose_refine.png (gitignored).
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../src/common/spatial/staged-location-contracts';
import type { DecodedImage, DepthMap, PinholeCamera, ProjectionView, UvAtlas } from '../src/common/spatial/texture-pass-contracts';
import { bakeStreetViewProjection } from '../src/node/3d-engine/staged-location/texture-projection';
import { perturbCamera } from '../src/node/3d-engine/staged-location/texture-pose-refine';
import { encodePng } from '../src/node/texture-processing';
import { facadeAtlas, lookAtCamera } from './helpers/texture-pass-fixtures';

const SHOTS = path.resolve(__dirname, '../../../test-results/screenshots/texture_bake');
const W = 10, H = 6;

/** Non-periodic carved relief: random-phase ripples and scattered rosettes (a periodic course pattern lets a chart shift by
 * a whole course and still match, which says nothing about the pose). */
function carved(u: number, v: number): number {
    let l = 150 + 30 * Math.sin(u * 2.3 + 1.1 * Math.sin(v * 1.7)) + 20 * Math.cos(v * 3.1 + 0.7 * u) + 12 * Math.sin((u + v) * 5.3);
    for (let q = 0; q < 40; q++) {
        const cu = (q * 2.399) % 10, cv = (q * 1.618 * 3.7) % 6, r = 0.15 + 0.1 * ((q * 7) % 3);
        if (Math.hypot(u - cu, v - cv) < r) l = 50 + 80 * (Math.hypot(u - cu, v - cv) / r);
    }
    return Math.max(0, Math.min(255, l));
}

function render(cam: PinholeCamera): DecodedImage {
    const rgba = new Uint8Array(cam.width * cam.height * 4);
    for (let py = 0; py < cam.height; py++) for (let px = 0; px < cam.width; px++) {
        const sx = (px + 0.5 - cam.cx) / cam.fx, sy = (py + 0.5 - cam.cy) / cam.fy;
        const d: Vec3 = [cam.fwd[0] + sx * cam.right[0] - sy * cam.up[0], cam.fwd[1] + sx * cam.right[1] - sy * cam.up[1], cam.fwd[2] + sx * cam.right[2] - sy * cam.up[2]];
        const t = -cam.eye[2] / d[2];
        const o = (py * cam.width + px) * 4;
        let l = 128;
        if (t > 0) { const u = cam.eye[0] + t * d[0], v = cam.eye[1] + t * d[1]; if (u >= 0 && u <= W && v >= 0 && v <= H) l = carved(u, v); }
        rgba[o] = rgba[o + 1] = rgba[o + 2] = Math.round(l); rgba[o + 3] = 255;
    }
    return { width: cam.width, height: cam.height, rgba };
}

/** The camera turned by `yawDeg` about its up axis and `pitchDeg` about its right axis (a registration error). */
function turned(cam: PinholeCamera, yawDeg: number, pitchDeg: number): PinholeCamera {
    const rot = (v: Vec3, k: Vec3, a: number): Vec3 => {
        const c = Math.cos(a), s = Math.sin(a), d = v[0] * k[0] + v[1] * k[1] + v[2] * k[2];
        const x: Vec3 = [k[1] * v[2] - k[2] * v[1], k[2] * v[0] - k[0] * v[2], k[0] * v[1] - k[1] * v[0]];
        return [v[0] * c + x[0] * s + k[0] * d * (1 - c), v[1] * c + x[1] * s + k[1] * d * (1 - c), v[2] * c + x[2] * s + k[2] * d * (1 - c)];
    };
    const y = (yawDeg * Math.PI) / 180, p = (pitchDeg * Math.PI) / 180;
    let { fwd, right, up } = cam;
    fwd = rot(fwd, up, y); right = rot(right, up, y);
    fwd = rot(fwd, right, p); up = rot(up, right, p);
    return { ...cam, fwd, right, up };
}

function depthOf(cam: PinholeCamera): DepthMap {
    const depthM = new Float32Array(cam.width * cam.height).fill(Infinity);
    for (let py = 0; py < cam.height; py++) for (let px = 0; px < cam.width; px++) {
        const sx = (px + 0.5 - cam.cx) / cam.fx, sy = (py + 0.5 - cam.cy) / cam.fy;
        const dz = cam.fwd[2] + sx * cam.right[2] - sy * cam.up[2], dx = cam.fwd[0] + sx * cam.right[0] - sy * cam.up[0], dy = cam.fwd[1] + sx * cam.right[1] - sy * cam.up[1];
        const t = -cam.eye[2] / dz;
        if (!(t > 0)) continue;
        const u = cam.eye[0] + t * dx, v = cam.eye[1] + t * dy;
        if (u >= 0 && u <= W && v >= 0 && v <= H) depthM[py * cam.width + px] = t; // t along a ray whose fwd component is 1
    }
    return { width: cam.width, height: cam.height, depthM };
}

/** Three views (true images); the poses handed to the bake carry the given errors (yaw, pitch degrees). */
function views(errors: Array<[number, number]>): ProjectionView[] {
    const eyes: Array<[string, Vec3]> = [['front', [5, 1.7, -13]], ['left', [-2, 1.7, -11]], ['right', [12, 1.7, -11]]];
    return eyes.map(([panoId, eye], k) => {
        const truth = lookAtCamera(eye, [5, 3, 0], 480, 288, 60);
        return { panoId, camera: turned(truth, errors[k][0], errors[k][1]), image: render(truth), poseQuality: 1, poseSigmaPx: 160, truth } as ProjectionView & { truth: PinholeCamera };
    });
}


/** The facade atlas as four charts (quadrants). */
function quadrantAtlas(side: number): UvAtlas {
    const a = facadeAtlas(side);
    const h = side / 2;
    for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) a.texels.mapIndex[y * side + x] = (y < h ? 0 : 2) + (x < h ? 0 : 1);
    a.maps = [0, 1, 2, 3].map(q => ({ ...a.maps[0], chartId: `q${q}`, atlasRect: [(q % 2) * 0.5, Math.floor(q / 2) * 0.5, (q % 2) * 0.5 + 0.5, Math.floor(q / 2) * 0.5 + 0.5] as [number, number, number, number] }));
    return a;
}

const angleDeg = (a: Vec3, b: Vec3) => (Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180) / Math.PI;

describe('Street View projection: pose refinement from the alignment', () => {
    it('refines misregistered views toward their true poses and keeps them only because the views agree better', async () => {
        const atlas = quadrantAtlas(160);
        const v = views([[0.6, -0.3], [-0.5, 0.4], [0.3, 0.5]]);
        const tile = (P: Vec3): Vec3 => {
            let l = 0;
            for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) l += carved(P[0] + a * 0.03, P[1] + b * 0.03) / 25;
            const lin = (l / 255) ** 2.2;
            return [lin, lin, lin];
        };
        const res = await bakeStreetViewProjection({ atlas, views: v, depthFor: view => depthOf(view.camera), options: { alignReference: tile } });
        const pr = res.report.poseRefine!;
        fs.mkdirSync(SHOTS, { recursive: true });
        fs.writeFileSync(path.join(SHOTS, 'pose_refine.png'), encodePng(atlas.width, atlas.height, Buffer.from(res.albedo)));
        fs.writeFileSync(path.join(SHOTS, 'pose_refine_report.json'), JSON.stringify(pr));
        expect(pr, 'the refinement ran').toBeDefined();
        expect(pr.applied).toBeGreaterThanOrEqual(2);
        expect(pr.rmsAfterM).toBeLessThan(0.3 * pr.rmsBeforeM);
        expect(pr.kept, pr.reason).toBe(true);
        // the refined poses alone make the views agree about as well as the per-chart shifts did
        expect(pr.secondPassGradNcc!.before).toBeGreaterThan(pr.firstPassGradNcc!.before + 0.2);
        expect(pr.secondPassGradNcc!.after).toBeGreaterThanOrEqual(pr.firstPassGradNcc!.after - 0.005);
        // each applied view's refined camera looks closer to where its true camera looks
        for (const p of pr.perPano.filter(q => q.applied)) {
            const k = Number(p.panoId.split('#')[1]);
            const view = v[k] as ProjectionView & { truth: PinholeCamera };
            const refined = perturbCamera(view.camera, [p.dxM, p.dzM, p.dyawDeg, p.dpitchDeg]);
            const before = angleDeg(view.camera.fwd, view.truth.fwd), after = angleDeg(refined.fwd, view.truth.fwd);
            expect(after, `${p.panoId}: ${before.toFixed(3)} -> ${after.toFixed(3)} deg`).toBeLessThan(0.6 * before);
        }
    }, 180_000);
});
