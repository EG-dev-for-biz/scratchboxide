/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import {
    bestRotation, matMul, transpose, matVec, rotationAngleDeg, viewRotation, yawTurn, quatToMat, similarityScale2d,
    rigConsensus, placeRig, shiftSearch, registerRigOnScan, headingPitchRoll, RigRegistrationRefused,
    type M3, type V3, type RigDepthView, type StatedPano
} from '../src/node/spatial/rig-depth-registration';

const near = (a: number[], b: number[], tol: number) => a.forEach((v, i) => expect(Math.abs(v - b[i])).toBeLessThan(tol));

/**
 * A street canyon of the scan frame (x east, y up, z south): ground at y = 0, walls at x = -8 and x = +8 between
 * y = 0 and 20, a box (a kiosk) at x in [2, 4], z in [-3, -1], y in [0, 3]. Ray-cast exactly.
 */
function rayDepth(eye: V3, dir: V3): number {
    let best = Infinity;
    const planes: Array<{ axis: 0 | 1 | 2; at: number; lo: V3; hi: V3 }> = [
        { axis: 1, at: 0, lo: [-8, 0, -60], hi: [8, 0, 60] },
        { axis: 0, at: -8, lo: [-8, 0, -60], hi: [-8, 20, 60] },
        { axis: 0, at: 8, lo: [8, 0, -60], hi: [8, 20, 60] },
        { axis: 0, at: 2, lo: [2, 0, -3], hi: [2, 3, -1] }, { axis: 0, at: 4, lo: [4, 0, -3], hi: [4, 3, -1] },
        { axis: 2, at: -3, lo: [2, 0, -3], hi: [4, 3, -3] }, { axis: 2, at: -1, lo: [2, 0, -1], hi: [4, 3, -1] },
        { axis: 1, at: 3, lo: [2, 3, -3], hi: [4, 3, -1] }
    ];
    for (const p of planes) {
        if (Math.abs(dir[p.axis]) < 1e-9) continue;
        const t = (p.at - eye[p.axis]) / dir[p.axis];
        if (t <= 1e-6 || t >= best) continue;
        const h: V3 = [eye[0] + dir[0] * t, eye[1] + dir[1] * t, eye[2] + dir[2] * t];
        if ([0, 1, 2].every(k => h[k] >= p.lo[k] - 1e-6 && h[k] <= p.hi[k] + 1e-6)) best = t;
    }
    return best;
}

function scanPoints(): Float32Array {
    const out: number[] = [];
    for (let x = -8; x <= 8; x += 0.1) for (let z = -40; z <= 40; z += 0.1) out.push(x, 0, z);
    for (const wx of [-8, 8]) for (let y = 0; y <= 20; y += 0.1) for (let z = -40; z <= 40; z += 0.1) out.push(wx, y, z);
    for (let y = 0; y <= 3; y += 0.1) for (let z = -3; z <= -1; z += 0.1) { out.push(2, y, z); out.push(4, y, z); }
    for (let x = 2; x <= 4; x += 0.1) for (let y = 0; y <= 3; y += 0.1) { out.push(x, y, -3); out.push(x, y, -1); }
    return Float32Array.from(out);
}

/** The estimate's frame: world = scale * R * estimate + t (so estimate = R^T (world - t) / scale). */
const EST_R = quatToMat([0.9, 0.2, -0.3, 0.25]);
const EST_S = 1 / 1.4, EST_T: V3 = [3, -2, 5];
const toEst = (p: V3): V3 => matVec(transpose(EST_R), [(p[0] - EST_T[0]) / EST_S, (p[1] - EST_T[1]) / EST_S, (p[2] - EST_T[2]) / EST_S]);

/** Twelve views per pano rendered as an ideal depth model would return them, in the estimate's frame and units. */
function rigViews(truth: Array<{ id: string; eye: V3 }>, badView?: { pano: string; yaw: number }): RigDepthView[] {
    const W = 48, H = 48, f = W / 2;
    const views: RigDepthView[] = [];
    for (const p of truth) {
        for (let yaw = 0; yaw < 360; yaw += 30) {
            const rWorld = viewRotation(yaw);                       // world -> camera
            let rEst = matMul(rWorld, EST_R);                       // estimate -> camera (estimate = R^T world-ish)
            const cEst = toEst(p.eye);
            if (badView && badView.pano === p.id && badView.yaw === yaw) rEst = matMul(quatToMat([0.99, 0.1, 0, 0]), rEst);
            const t = matVec(rEst, cEst).map(v => -v) as V3;
            const depth = new Float32Array(W * H), conf = new Float32Array(W * H).fill(2);
            for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
                const dc: V3 = [(x + 0.5 - W / 2) / f, (y + 0.5 - H / 2) / f, 1];
                const dw = matVec(transpose(rWorld), dc);
                const n = Math.hypot(...dw);
                const r = rayDepth(p.eye, [dw[0] / n, dw[1] / n, dw[2] / n]);
                depth[y * W + x] = Number.isFinite(r) && r < 60 ? (r / n) / EST_S : 0;
            }
            views.push({
                panoId: p.id, yawDeg: yaw, w2c: [...rEst[0], t[0], ...rEst[1], t[1], ...rEst[2], t[2]],
                fx: f, fy: f, cx: W / 2, cy: H / 2, width: W, height: H, depth, conf
            });
        }
    }
    return views;
}

const TRUTH = [
    { id: 'a', eye: [0, 2.5, 10] as V3 }, { id: 'b', eye: [0.5, 2.5, 0] as V3 }, { id: 'c', eye: [-0.5, 2.5, -10] as V3 }
];

describe('rig-depth-registration formulas', () => {
    it('finds the rotation maximising trace(R^T M) for a known rotation', () => {
        const r = quatToMat([0.7, 0.1, 0.6, -0.2]);
        expect(rotationAngleDeg(matMul(transpose(bestRotation(r)), r))).toBeLessThan(1e-6);
    });

    it('measures the scale of a 2-D similarity', () => {
        const src: Array<[number, number]> = [[0, 0], [1, 0], [0, 2], [3, 1]];
        const a = 0.6, s = 2.5;
        const dst = src.map(([x, y]) => [s * (Math.cos(a) * x - Math.sin(a) * y) + 4, s * (Math.sin(a) * x + Math.cos(a) * y) - 1] as [number, number]);
        expect(similarityScale2d(src, dst)).toBeCloseTo(s, 9);
    });

    it('reads heading, pitch and roll back from a view rotation', () => {
        const h = headingPitchRoll(viewRotation(119, -4));
        near([h.headingDeg, h.pitchDeg, h.rollDeg], [119, -4, 0], 1e-9);
    });

    it('turns a yaw-30 view into the pano frame: yawTurn(30) * viewRotation(0) = viewRotation(30)', () => {
        const a = matMul(yawTurn(30), viewRotation(0)), b = viewRotation(30);
        expect(rotationAngleDeg(matMul(a, transpose(b)))).toBeLessThan(1e-9);
    });

    it('drops a view that disagrees with its pano and keeps the rest', () => {
        const c = rigConsensus(rigViews(TRUTH, { pano: 'b', yaw: 90 }));
        expect(c.map(x => [x.panoId, x.kept, x.total])).toEqual([['a', 12, 12], ['b', 11, 12], ['c', 12, 12]]);
        near(c[1].centre, toEst(TRUTH[1].eye), 1e-6);
    });

    it('puts the estimate on the stated cameras: scale, and each camera back on its point', () => {
        const stated: StatedPano[] = TRUTH.map(t => ({ panoId: t.id, eye: t.eye, referenceHeadingDeg: 0 }));
        const p = placeRig(rigConsensus(rigViews(TRUTH)), stated);
        expect(p.scale).toBeCloseTo(EST_S, 6);
        Object.values(p.cameraOffsetM).forEach(o => expect(o).toBeLessThan(1e-6));
        expect(p.worstTurnDeg).toBeLessThan(1e-4);
    });

    it('slides the scan onto the estimate by the cameras\' stated error (0.7 m east, 0.4 m south)', () => {
        const offset: V3 = [0.7, 0, 0.4];
        const stated: StatedPano[] = TRUTH.map(t => ({ panoId: t.id, eye: [t.eye[0] + offset[0], t.eye[1], t.eye[2] + offset[2]], referenceHeadingDeg: 0 }));
        const r = registerRigOnScan(rigViews(TRUTH), stated, scanPoints(), { fitSamples: 20_000 });
        near(r.refined.move, offset, 0.05);
        expect(r.shift.hitsAfter).toBeGreaterThan(r.shift.hitsBefore);
        for (const c of r.corrected) near(c.eye, TRUTH.find(t => t.id === c.panoId)!.eye, 0.05);
        expect(r.sightApartM.after).toBeLessThan(r.sightApartM.before);
    });

    it('refuses, leaving the stated poses, when the views of the panoramas do not agree on their own pose', () => {
        const views = rigViews(TRUTH).map((v, i) => {
            const e = v.w2c, r = [[e[0], e[1], e[2]], [e[4], e[5], e[6]], [e[8], e[9], e[10]]] as M3;
            const turned = matMul(quatToMat([1, 0.05 * ((i % 5) - 2), 0.04 * ((i % 3) - 1), 0]), r);   // each view turned a few degrees its own way
            return { ...v, w2c: [...turned[0], e[3], ...turned[1], e[7], ...turned[2], e[11]] };
        });
        const stated: StatedPano[] = TRUTH.map(t => ({ panoId: t.id, eye: t.eye, referenceHeadingDeg: 0 }));
        expect(() => registerRigOnScan(views, stated, scanPoints())).toThrow(RigRegistrationRefused);
    });

    it('leaves a scan that already fits where it is', () => {
        const samples = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 0, 1, 5, 2, 5]);
        expect(shiftSearch(samples, samples).move).toEqual([0, 0, 0]);
    });
});
