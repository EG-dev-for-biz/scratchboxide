/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Joint registration (pano-joint-registration.ts) on a synthetic facade of repeated coursing: five panos whose stated poses are
 * off by up to a metre and a degree, and a scan that is itself slightly wrong (the parapet 0.2 m too high, the opening 0.15 m too
 * narrow). Posed one pano at a time (box or edge, pano-edge-registration.ts) the views disagree where the scan is wrong; posed
 * together, with the cross-view consistency of the photos through the scan, they agree. The held-out fit (scan points the fit
 * never used) and the true reprojection error both prefer the joint poses.
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { renderFrameDepth, ZERO_CORRECTION, type FrameCamera, type PoseCorrection, type RgbaImage } from '../src/node/spatial/StreetViewPoseRegistrar';
import type { RenderMesh3D } from '../src/node/spatial/HeadlessMeshSilhouetteRenderer';
import { castCamera } from '../src/node/3d-engine/staged-location/survey-casting';
import { registerPanosByEdges, type EdgeRegFrame } from '../src/node/3d-engine/staged-location/pano-edge-registration';
import { faceSlabMesh, heldOutFitOfFrames, indexMeshByPlan, meshNearCamera, registerPanosJointly, trainCell } from '../src/node/3d-engine/staged-location/pano-joint-registration';
import { faceOutlineSamples } from '../src/node/spatial/StreetViewCrossViewRefiner';
import type { SurfaceChart } from '../src/common/spatial/staged-location-contracts';
import type { Registration, RegView } from '../src/node/3d-engine/staged-location/pano-registration';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';

const COURSE = 0.5, BLOCK = 1.0;
const W = 640, H = 480;

function addBox(v: number[], ix: number[], lo: [number, number, number], hi: [number, number, number]): void {
    const b = v.length / 3;
    for (let k = 0; k < 8; k++) v.push(k & 1 ? hi[0] : lo[0], k & 2 ? hi[1] : lo[1], k & 4 ? hi[2] : lo[2]);
    const quads = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
    for (const [a, c, d, e] of quads) ix.push(b + a, b + c, b + d, b + a, b + d, b + e);
}

/** A 14 m wall with an opening and a parapet; `err` moves the parapet up and narrows the opening (the scan's own error). */
function facade(err: { parapetUp: number; openingIn: number }, tree = false): RenderMesh3D {
    const v: number[] = [], ix: number[] = [];
    const o = 2 - err.openingIn;
    addBox(v, ix, [-60, -0.3, -60], [60, 0, 60]);
    addBox(v, ix, [-7, 0, -1], [-o, 10, 0]);
    addBox(v, ix, [o, 0, -1], [7, 10, 0]);
    addBox(v, ix, [-o, 6, -1], [o, 10, 0]);
    addBox(v, ix, [-3.5, 10 + err.parapetUp, -0.8], [3.5, 11.5 + err.parapetUp, -0.2]);
    addBox(v, ix, [-7.5, 10, -1.3], [7.5, 10.4, 0.3]); // cornice
    addBox(v, ix, [-30, 0, -25], [30, 18, -20]); // a building behind
    if (tree) addBox(v, ix, [-6.5, 0, 2.5], [-4.5, 7, 4.5]); // a tree in front of the left pier (the scan has it; the photos do not)
    return { vertices: new Float32Array(v), indices: new Uint32Array(ix) };
}

const hash = (a: number, b: number) => { const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return s - Math.floor(s); };
/** Repeated coursing whose blocks vary a little in tone (real stone is never the same block twice). */
function stone(p: [number, number, number]): number {
    if (p[1] < 0.001) return 120 + 30 * hash(Math.floor(p[0] * 2), Math.floor(p[2] * 2));
    if (p[2] < -15) return 150 + 40 * hash(Math.floor(p[0] / 3), Math.floor(p[1] / 3)); // the building behind
    const k = Math.floor(p[1] / COURSE);
    const along = Math.abs(p[2]) < 0.01 || Math.abs(p[2] + 1) < 0.01 ? p[0] : p[2];
    const off = (((k % 2) + 2) % 2) * BLOCK / 2;
    const jy = ((p[1] % COURSE) + COURSE) % COURSE, jx = (((along + off) % BLOCK) + BLOCK) % BLOCK;
    if (jy < 0.05 || jx < 0.05) return 90;
    return 165 + 35 * hash(Math.floor((along + off) / BLOCK), k) + (Math.abs(p[2]) < 0.01 ? 0 : -25);
}

const view = (panoId: string, eye: [number, number, number], headingDeg: number): RegView => ({ panoId, eye, headingDeg, pitchDeg: 16, fovDeg: 64, widthPx: W, heightPx: H });

function photo(mesh: RenderMesh3D, v: RegView, truth: PoseCorrection): RgbaImage {
    const cam = castCamera({ ...v, correction: truth });
    const depth = renderFrameDepth(mesh, cam);
    const rgba = Buffer.alloc(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x, d = depth[i];
        let r: number, g: number, b: number;
        if (d < 1e8) {
            const u = (x + 0.5 - cam.cx) / cam.fx, w = (y + 0.5 - cam.cy) / cam.fy;
            const p: [number, number, number] = [0, 1, 2].map(k => cam.eye[k] + d * (cam.fwd[k] + u * cam.right[k] - w * cam.up[k])) as [number, number, number];
            r = g = b = stone(p);
        } else { r = 105 + y / 12; g = 155 + y / 14; b = 225; }
        rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = 255;
    }
    return { width: W, height: H, rgba };
}

/** Median reprojection error (px) of held-out scan points of the true mesh between a registered camera and the true one. */
function trueError(mesh: RenderMesh3D, reg: FrameCamera, truth: FrameCamera): number {
    const depth = renderFrameDepth(mesh, truth);
    const errs: number[] = [];
    for (let y = 10; y < H - 10; y += 8) for (let x = 10; x < W - 10; x += 8) {
        const d = depth[y * W + x];
        if (!(d < 1e8) || d > 60) continue;
        const u = (x + 0.5 - truth.cx) / truth.fx, w = (y + 0.5 - truth.cy) / truth.fy;
        const p = [0, 1, 2].map(k => truth.eye[k] + d * (truth.fwd[k] + u * truth.right[k] - w * truth.up[k]));
        if (trainCell(p)) continue;
        const q = [p[0] - reg.eye[0], p[1] - reg.eye[1], p[2] - reg.eye[2]];
        const z = q[0] * reg.fwd[0] + q[1] * reg.fwd[1] + q[2] * reg.fwd[2];
        const px = reg.cx + reg.fx * (q[0] * reg.right[0] + q[1] * reg.right[1] + q[2] * reg.right[2]) / z;
        const py = reg.cy - reg.fy * (q[0] * reg.up[0] + q[1] * reg.up[1] + q[2] * reg.up[2]) / z;
        errs.push(Math.hypot(px - x - 0.5, py - y - 0.5));
    }
    errs.sort((a, b) => a - b);
    return errs[errs.length >> 1];
}

describe('joint pano registration (pano-joint-registration)', () => {
    it('poses all panos together and beats the per-pano choice on the held-out fit, with a scan that is slightly wrong', () => {
        const truthMesh = facade({ parapetUp: 0, openingIn: 0 });
        const scan = facade({ parapetUp: 0.2, openingIn: 0.15 });
        const truths: Record<string, PoseCorrection> = {
            p1: { ...ZERO_CORRECTION, dx: 0.6, dy: 0.2, dz: -0.4, dyawDeg: 0.6 },
            p2: { ...ZERO_CORRECTION, dx: -0.7, dz: 0.5, dpitchDeg: -0.5 },
            p3: { ...ZERO_CORRECTION, dx: 0.4, dy: -0.15, dyawDeg: -0.8 },
            p4: { ...ZERO_CORRECTION, dx: -0.5, dz: -0.6, dyawDeg: 0.5, dpitchDeg: 0.4 },
            p5: { ...ZERO_CORRECTION, dx: 0.8, dz: 0.3, dyawDeg: -0.4 }
        };
        const views = [view('p1', [-6, 1.7, 18], 12), view('p2', [-1, 1.7, 21], 2), view('p3', [4, 1.7, 19], -10), view('p4', [8, 1.7, 15], -26), view('p5', [-10, 1.7, 14], 28)];
        const frames: EdgeRegFrame[] = views.map(v => ({ key: v.panoId, view: v, image: photo(truthMesh, v, truths[v.panoId]) }));
        const prior: Registration = {
            corrections: new Map(views.map(v => [v.panoId, ZERO_CORRECTION])),
            perPano: views.map(v => ({ panoId: v.panoId, dxM: 0, dzM: 0, dyawDeg: 0, dpitchDeg: 0, pairs: 1, beforeRmsM: 1.3, afterRmsM: 1.3 })),
            setAside: [], pairs: [], beforeRmsM: 1.3, afterRmsM: 1.3, used: 1, rejected: 0
        };
        // the per-pano choice (round 4)
        const edge = registerPanosByEdges({ frames, mesh: scan, prior, budgetMs: 120_000 });
        const candidates = new Map(edge.panos.map(p => [p.panoId, { box: p.prior, ...(p.edge ? { edge: p.edge } : {}), edgeLocked: p.edgeResidualPx.edge !== null && p.edgeResidualPx.edge <= 5 && (p.edgeResidualPx.prior === null || p.edgeResidualPx.edge < p.edgeResidualPx.prior) }]));
        const joint = registerPanosJointly({ frames, mesh: scan, current: edge.registration, candidates, budgetMs: 240_000 });

        // the held-out fit prefers the joint poses, and they are kept
        expect(joint.fit.joint!.chamferPx!).toBeLessThan(joint.fit.current.chamferPx!);
        expect(['joint', 'joint+warp']).toContain(joint.chosen);
        expect(joint.matches.medianPxAfter!).toBeLessThanOrEqual(joint.matches.medianPxBefore!);
        // and against the truth: the held-out points reproject closer with the joint poses than with the per-pano choice
        const errOf = (reg: Registration) => {
            const e = views.map(v => trueError(truthMesh, castCamera({ ...v, correction: reg.corrections.get(v.panoId) }), castCamera({ ...v, correction: truths[v.panoId] })));
            return e.reduce((s, x) => s + x, 0) / e.length;
        };
        const perPano = errOf(edge.registration), together = errOf(joint.registration);
        expect(together).toBeLessThan(perPano);
        for (const p of joint.registration.perPano) expect(p.method).toBe('joint');

        const out = path.resolve(__dirname, '../../../test-results/screenshots');
        fs.mkdirSync(out, { recursive: true });
        // the per-pano and joint poses' scan depth against the photo of pano p2 (red: per-pano silhouette, green: joint)
        const f = frames[1];
        const a = renderFrameDepth(scan, castCamera({ ...f.view, correction: edge.registration.corrections.get('p2') }));
        const b = renderFrameDepth(scan, castCamera({ ...f.view, correction: joint.registration.corrections.get('p2') }));
        const px = Buffer.from(f.image.rgba);
        for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
            const i = y * W + x;
            const edgeOf = (d: Float32Array) => (d[i] < 1e8) !== (d[i + 1] < 1e8) || (d[i] < 1e8) !== (d[i + W] < 1e8) || Math.abs(d[i] - d[i + 1]) > 0.5 || Math.abs(d[i] - d[i + W]) > 0.5;
            if (edgeOf(a)) px.set([255, 0, 0], i * 4);
            if (edgeOf(b)) px.set([0, 255, 0], i * 4);
        }
        fs.writeFileSync(path.join(out, 'staged_location_joint_registration_p2.png'), encodePng(W, H, px, 4));
        fs.writeFileSync(path.join(out, 'staged_location_joint_registration_report.json'), JSON.stringify({ perPanoErrPx: perPano, jointErrPx: together, chosen: joint.chosen, reason: joint.reason, fit: { current: { c: joint.fit.current.chamferPx, n: joint.fit.current.gradNcc }, joint: { c: joint.fit.joint?.chamferPx, n: joint.fit.joint?.gradNcc }, warped: { c: joint.fit.warped?.chamferPx, n: joint.fit.warped?.gradNcc } }, panos: joint.panos, edge: edge.panos.map(p => ({ id: p.panoId, chosen: p.chosen, res: p.edgeResidualPx })) }, null, 1));
    }, 600_000);

    it('scores each view on the mesh near it only: in front of it and within range, the same fit as the whole mesh', () => {
        // a quad as two triangles at plan (x, z), 1 m across
        const quad = (x: number, z: number): number[] => [x, 0, z, x + 1, 0, z, x + 1, 1, z, x, 0, z, x + 1, 1, z, x, 1, z];
        const v = [...quad(0, -20), ...quad(0, 40), ...quad(0, -400)];
        const mesh: RenderMesh3D = { vertices: Float32Array.from(v), indices: Uint32Array.from({ length: v.length / 3 }, (_, i) => i) };
        const cam = castCamera({ eye: [0.5, 1.7, 0], headingDeg: 0, pitchDeg: 0, fovDeg: 60, widthPx: 320, heightPx: 240 });
        const near = meshNearCamera(indexMeshByPlan(mesh), cam);
        // heading 0 looks toward -z: the quad 20 m ahead is kept, the one behind and the one 400 m ahead are not
        expect(near.indices.length / 3).toBe(2);
        expect(Math.max(...Array.from(near.vertices).filter((_, i) => i % 3 === 2))).toBeCloseTo(-20, 5);

        // the facade scene lies within the range: the cropped scoring is the whole mesh's, exactly
        const truthMesh = facade({ parapetUp: 0, openingIn: 0 });
        const scan = facade({ parapetUp: 0.2, openingIn: 0.15 });
        const truths: Record<string, PoseCorrection> = { p1: { ...ZERO_CORRECTION, dx: 0.6, dyawDeg: 0.6 }, p2: { ...ZERO_CORRECTION, dx: -0.7, dpitchDeg: -0.5 } };
        const views = [view('p1', [-6, 1.7, 18], 12), view('p2', [-1, 1.7, 21], 2)];
        const frames: EdgeRegFrame[] = views.map(vw => ({ key: vw.panoId, view: vw, image: photo(truthMesh, vw, truths[vw.panoId]) }));
        const corrs = new Map(views.map(vw => [vw.panoId, ZERO_CORRECTION]));
        const whole = heldOutFitOfFrames(frames, scan, corrs), cropped = heldOutFitOfFrames(frames, indexMeshByPlan(scan), corrs);
        expect(cropped.chamferPx).toBe(whole.chamferPx);
        expect(cropped.gradNcc).toBe(whole.gradNcc);
        expect(cropped.views.map(x => x.pixels)).toEqual(whole.views.map(x => x.pixels));
    }, 300_000);

    it('keeps the coarse fit for the held-out test when the budget ends before the fine scale', () => {
        const truthMesh = facade({ parapetUp: 0, openingIn: 0 });
        const scan = facade({ parapetUp: 0.2, openingIn: 0.15 });
        const truths: Record<string, PoseCorrection> = {
            p1: { ...ZERO_CORRECTION, dx: 0.6, dy: 0.2, dz: -0.4, dyawDeg: 0.6 },
            p2: { ...ZERO_CORRECTION, dx: -0.7, dz: 0.5, dpitchDeg: -0.5 },
            p3: { ...ZERO_CORRECTION, dx: 0.4, dy: -0.15, dyawDeg: -0.8 }
        };
        const views = [view('p1', [-6, 1.7, 18], 12), view('p2', [-1, 1.7, 21], 2), view('p3', [4, 1.7, 19], -10)];
        const frames: EdgeRegFrame[] = views.map(v => ({ key: v.panoId, view: v, image: photo(truthMesh, v, truths[v.panoId]) }));
        const current: Registration = {
            corrections: new Map(views.map(v => [v.panoId, ZERO_CORRECTION])),
            perPano: views.map(v => ({ panoId: v.panoId, dxM: 0, dzM: 0, dyawDeg: 0, dpitchDeg: 0, pairs: 1, beforeRmsM: 1.3, afterRmsM: 1.3 })),
            setAside: [], pairs: [], beforeRmsM: 1.3, afterRmsM: 1.3, used: 1, rejected: 0
        };
        const candidates = new Map(views.map(v => [v.panoId, { box: ZERO_CORRECTION, edgeLocked: false }]));
        // the clock runs normally until the coarse scale's refiner has finished, then jumps past the budget
        let spent = false;
        const logs: string[] = [];
        const joint = registerPanosJointly({
            frames, mesh: scan, current, candidates, budgetMs: 240_000,
            now: () => Date.now() + (spent ? 1e9 : 0),
            log: m => { logs.push(m); if (m.startsWith('[cross-view] final')) spent = true; }
        });
        expect(logs.some(m => m.includes('budget spent before the 640 px scale'))).toBe(true);
        expect(joint.timingsMs.scale360).toBeGreaterThan(0);
        expect(joint.timingsMs.scale640).toBeUndefined();
        // the coarse fit was scored on the held-out cells, not thrown away (until 2026-11-08: "did not run in its budget")
        expect(joint.reason).not.toBe('the joint fit did not run in its budget');
        expect(joint.fit.joint).not.toBeNull();
        expect(joint.matches.medianPxBefore).not.toBeNull();
        // and the held-out test still decides: kept only when it fits the held-out cells better than the current poses
        if (joint.chosen !== 'current') expect(joint.fit.joint!.chamferPx!).toBeLessThan(joint.fit.current.chamferPx!);
    }, 600_000);

    it('holds the outline of the structure\'s own faces: the tile near the fitted faces, a tree in front and a building behind left out', () => {
        const scan = facade({ parapetUp: 0, openingIn: 0 }, true);
        const front: SurfaceChart = { plane: { origin: [-7, 0, 0], u: [1, 0, 0], v: [0, 1, 0], normal: [0, 0, 1], extentUv: [[0, 0], [14, 0], [14, 11.5], [0, 11.5]] } };
        const faces = faceSlabMesh(scan, [front]);
        // the structure's triangles stay (the facade, cornice and parapet), the tree 2.5 m in front, the building 20 m behind and the
        // ground's far corners go
        const kept = new Set<number>();
        for (let t = 0; t < faces.indices.length; t++) kept.add(faces.indices[t]);
        const box = (k: number) => [...Array(8).keys()].map(j => k * 8 + j);
        expect(box(1).every(i => kept.has(i))).toBe(true);
        expect(box(4).every(i => kept.has(i))).toBe(true);
        expect(box(6).some(i => kept.has(i))).toBe(false); // building behind
        expect(box(7).some(i => kept.has(i))).toBe(false); // tree in front
        // seen from a pano, the face outline samples lie on the outline of the structure and never where the tree hides it
        const v = view('p2', [-1, 1.7, 21], 2);
        const cam = castCamera(v);
        const pts = faceOutlineSamples(renderFrameDepth(faces, cam), renderFrameDepth(scan, cam), cam, new Uint8Array(cam.width * cam.height).fill(1));
        expect(pts.length).toBeGreaterThan(200);
        let hidden = 0, onOutline = 0;
        for (const X of pts) {
            // the ray from the eye to the sample does not pass through the tree (slab test against its box)
            let t0 = 0, t1 = 0.999;
            for (let k = 0; k < 3; k++) {
                const lo = [-6.5, 0, 2.5][k], hi = [-4.5, 7, 4.5][k], o = cam.eye[k], d = X[k] - o;
                if (Math.abs(d) < 1e-9) { if (o < lo || o > hi) { t0 = 1; break; } continue; }
                const ta = (lo - o) / d, tb = (hi - o) / d;
                t0 = Math.max(t0, Math.min(ta, tb)); t1 = Math.min(t1, Math.max(ta, tb));
            }
            if (t0 < t1) hidden++;
            // on the structure's outer outline, the opening's outline, the cornice or the parapet
            const outer = Math.abs(Math.abs(X[0]) - 7) < 0.15 || Math.abs(Math.abs(X[0]) - 2) < 0.15 || Math.abs(Math.abs(X[0]) - 3.5) < 0.15 || Math.abs(Math.abs(X[0]) - 7.5) < 0.15
                || Math.abs(X[1] - 6) < 0.15 || Math.abs(X[1] - 10) < 0.15 || Math.abs(X[1] - 10.4) < 0.15 || Math.abs(X[1] - 11.5) < 0.15 || X[1] < 0.15;
            if (outer) onOutline++;
        }
        expect(hidden).toBe(0);
        expect(onOutline / pts.length).toBeGreaterThan(0.95);
    });

    it('with the fitted faces, the joint fit holds each view\'s face outline, and poses better than without where a tree in the scan is not in the photos', () => {
        const truthMesh = facade({ parapetUp: 0, openingIn: 0 });
        const scan = facade({ parapetUp: 0.2, openingIn: 0.15 }, true);
        const truths: Record<string, PoseCorrection> = {
            p1: { ...ZERO_CORRECTION, dx: 0.6, dy: 0.2, dz: -0.4, dyawDeg: 0.6 },
            p2: { ...ZERO_CORRECTION, dx: -0.7, dz: 0.5, dpitchDeg: -0.5 },
            p3: { ...ZERO_CORRECTION, dx: 0.4, dy: -0.15, dyawDeg: -0.8 },
            p4: { ...ZERO_CORRECTION, dx: -0.5, dz: -0.6, dyawDeg: 0.5, dpitchDeg: 0.4 }
        };
        const views = [view('p1', [-6, 1.7, 18], 12), view('p2', [-1, 1.7, 21], 2), view('p3', [4, 1.7, 19], -10), view('p4', [8, 1.7, 15], -26)];
        const frames: EdgeRegFrame[] = views.map(v => ({ key: v.panoId, view: v, image: photo(truthMesh, v, truths[v.panoId]) }));
        const current: Registration = {
            corrections: new Map(views.map(v => [v.panoId, ZERO_CORRECTION])),
            perPano: views.map(v => ({ panoId: v.panoId, dxM: 0, dzM: 0, dyawDeg: 0, dpitchDeg: 0, pairs: 1, beforeRmsM: 1.3, afterRmsM: 1.3 })),
            setAside: [], pairs: [], beforeRmsM: 1.3, afterRmsM: 1.3, used: 1, rejected: 0
        };
        const candidates = new Map(views.map(v => [v.panoId, { box: ZERO_CORRECTION, edgeLocked: false }]));
        const front: SurfaceChart = { plane: { origin: [-7, 0, 0], u: [1, 0, 0], v: [0, 1, 0], normal: [0, 0, 1], extentUv: [[0, 0], [14, 0], [14, 11.5], [0, 11.5]] } };
        const without = registerPanosJointly({ frames, mesh: scan, current, candidates, budgetMs: 240_000 });
        const withOutline = registerPanosJointly({ frames, mesh: scan, current, candidates, faces: [{ chart: front }], budgetMs: 240_000 });
        expect(without.outlineTerm.used).toBe(false);
        expect(withOutline.outlineTerm.used).toBe(true);
        // the held-out face outline (scan points the fit never used) sits closer to the photo's colour edges after the joint fit
        expect(withOutline.fit.joint!.outlinePx!).toBeLessThan(withOutline.fit.start.outlinePx!);
        const errOf = (reg: Registration) => {
            const e = views.map(v => trueError(truthMesh, castCamera({ ...v, correction: reg.corrections.get(v.panoId) }), castCamera({ ...v, correction: truths[v.panoId] })));
            return e.reduce((s, x) => s + x, 0) / e.length;
        };
        const a = errOf(without.chosen === 'current' ? current : without.registration), b = errOf(withOutline.chosen === 'current' ? current : withOutline.registration);
        const out = path.resolve(__dirname, '../../../test-results/screenshots');
        fs.mkdirSync(out, { recursive: true });
        fs.writeFileSync(path.join(out, 'staged_location_joint_registration_outline_report.json'), JSON.stringify({ withoutErrPx: a, withOutlineErrPx: b, startErrPx: errOf(current), without: without.fit, withOutline: withOutline.fit, chosen: [without.chosen, withOutline.chosen] }, (k, x) => (k === 'views' ? undefined : x), 1));
        // red: the face outline at the start, green: after the joint fit with the outline term, over the photo of pano p2
        const f = frames[1], slab = faceSlabMesh(scan, [front]);
        const px = Buffer.from(f.image.rgba);
        for (const [corr, col] of [[ZERO_CORRECTION, [255, 0, 0]], [withOutline.registration.corrections.get('p2')!, [0, 255, 0]]] as const) {
            const c = castCamera({ ...f.view, correction: corr });
            for (const X of faceOutlineSamples(renderFrameDepth(slab, c), renderFrameDepth(scan, c), c, new Uint8Array(W * H).fill(1))) {
                const q = [X[0] - c.eye[0], X[1] - c.eye[1], X[2] - c.eye[2]];
                const z = q[0] * c.fwd[0] + q[1] * c.fwd[1] + q[2] * c.fwd[2];
                const x = Math.floor(c.cx + c.fx * (q[0] * c.right[0] + q[1] * c.right[1] + q[2] * c.right[2]) / z), y = Math.floor(c.cy - c.fy * (q[0] * c.up[0] + q[1] * c.up[1] + q[2] * c.up[2]) / z);
                if (x >= 0 && y >= 0 && x < W && y < H) px.set(col, (y * W + x) * 4);
            }
        }
        fs.writeFileSync(path.join(out, 'staged_location_joint_registration_outline_p2.png'), encodePng(W, H, px, 4));
        expect(b).toBeLessThan(a);
        expect(b).toBeLessThan(errOf(current));
    }, 600_000);
});
