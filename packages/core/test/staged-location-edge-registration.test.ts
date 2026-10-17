/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Geometric pano registration on a synthetic facade of repeated coursing: two panos whose stated eyes are off by exactly one
 * course and one half block (the period of the stone), so the stone's texture looks the same at the stated and the true pose.
 * The edge registration recovers the true poses from the silhouette and the opening, and the held-out inter-view agreement
 * keeps them.
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { renderFrameDepth, renderRegistrationOverlay, ZERO_CORRECTION, type FrameCamera, type PoseCorrection, type RgbaImage } from '../src/node/spatial/StreetViewPoseRegistrar';
import type { RenderMesh3D } from '../src/node/spatial/HeadlessMeshSilhouetteRenderer';
import { castCamera } from '../src/node/3d-engine/staged-location/survey-casting';
import { registerPanosByEdges, type EdgeRegFrame } from '../src/node/3d-engine/staged-location/pano-edge-registration';
import type { Registration, RegView } from '../src/node/3d-engine/staged-location/pano-registration';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';

const COURSE = 0.5, BLOCK = 1.0;
const W = 640, H = 480;

/** An axis-aligned box as 12 triangles. */
function addBox(v: number[], ix: number[], lo: [number, number, number], hi: [number, number, number]): void {
    const b = v.length / 3;
    for (let k = 0; k < 8; k++) v.push(k & 1 ? hi[0] : lo[0], k & 2 ? hi[1] : lo[1], k & 4 ? hi[2] : lo[2]);
    const quads = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
    for (const [a, c, d, e] of quads) ix.push(b + a, b + c, b + d, b + a, b + d, b + e);
}

/** A 12 m by 10 m wall, 1 m deep, front face at z = 0 facing south (+z), with a 4 m by 6 m opening and a parapet block, on the ground. */
function facade(): RenderMesh3D {
    const v: number[] = [], ix: number[] = [];
    addBox(v, ix, [-60, -0.3, -60], [60, 0, 60]);
    addBox(v, ix, [-6, 0, -1], [-2, 10, 0]);
    addBox(v, ix, [2, 0, -1], [6, 10, 0]);
    addBox(v, ix, [-2, 6, -1], [2, 10, 0]);
    addBox(v, ix, [-3, 10, -0.8], [3, 11.5, -0.2]);
    return { vertices: new Float32Array(v), indices: new Uint32Array(ix) };
}

/** Stone of repeated coursing: courses of 0.5 m, blocks of 1 m staggered by half a block, dark joints. */
function stone(p: [number, number, number]): number {
    if (p[1] < 0.001) return 120 + ((Math.floor(p[0] * 3) * 7 + Math.floor(p[2] * 3) * 13) % 9); // the paving
    const k = Math.floor(p[1] / COURSE);
    const along = Math.abs(p[2]) < 0.01 || Math.abs(p[2] + 1) < 0.01 ? p[0] : p[2];
    const off = (((k % 2) + 2) % 2) * BLOCK / 2;
    const jy = ((p[1] % COURSE) + COURSE) % COURSE, jx = (((along + off) % BLOCK) + BLOCK) % BLOCK;
    if (jy < 0.05 || jx < 0.05) return 95;
    const face = Math.abs(p[2]) < 0.01 ? 0 : -25;
    return 190 + face;
}

const view = (panoId: string, eye: [number, number, number], headingDeg: number): RegView => ({ panoId, eye, headingDeg, pitchDeg: 14, fovDeg: 60, widthPx: W, heightPx: H });

/** The photo a camera at `truth` takes of the facade: the stone where the wall is, a blue sky elsewhere. */
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

/** NCC of the photo's facade pixels against the stone texture rendered through a camera (what a texture registration scores). */
function textureNcc(mesh: RenderMesh3D, img: RgbaImage, cam: FrameCamera): number {
    const depth = renderFrameDepth(mesh, cam);
    const a: number[] = [], b: number[] = [];
    for (let y = 40; y < H - 40; y += 2) for (let x = 40; x < W - 40; x += 2) {
        const d = depth[y * W + x];
        if (!(d < 1e8)) continue;
        const u = (x + 0.5 - cam.cx) / cam.fx, w = (y + 0.5 - cam.cy) / cam.fy;
        const p = [0, 1, 2].map(k => cam.eye[k] + d * (cam.fwd[k] + u * cam.right[k] - w * cam.up[k])) as [number, number, number];
        const lum = img.rgba[(y * W + x) * 4];
        if (img.rgba[(y * W + x) * 4 + 2] - lum > 40) continue; // the photo's sky
        a.push(lum); b.push(stone(p));
    }
    const n = a.length, ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n;
    let sab = 0, saa = 0, sbb = 0;
    for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
    return sab / Math.sqrt(saa * sbb);
}

describe('geometric pano registration (pano-edge-registration)', () => {
    it('recovers poses a whole course off on repeated coursing, where the texture cannot tell them apart', () => {
        const mesh = facade();
        // the stated poses are off by half a block across and one course up or down (the stone's own period)
        const truths: Record<string, PoseCorrection> = {
            panoA: { ...ZERO_CORRECTION, dx: BLOCK / 2, dy: COURSE },
            panoB: { ...ZERO_CORRECTION, dx: -BLOCK / 2, dy: -COURSE }
        };
        const views = [view('panoA', [-3, 1.7, 20], 8), view('panoB', [4, 1.7, 21], -10)];
        const frames: EdgeRegFrame[] = views.map(v => ({ key: v.panoId, view: v, image: photo(mesh, v, truths[v.panoId]) }));

        // the texture cannot tell the stated pose from the true one (the coursing repeats)
        for (const f of frames) {
            const atTruth = textureNcc(mesh, f.image, castCamera({ ...f.view, correction: truths[f.view.panoId] }));
            const atStated = textureNcc(mesh, f.image, castCamera(f.view));
            expect(atTruth).toBeGreaterThan(0.6);
            expect(atStated).toBeGreaterThan(atTruth - 0.15);
        }

        // the box registration left the stated poses (zero corrections)
        const prior: Registration = {
            corrections: new Map([['panoA', ZERO_CORRECTION], ['panoB', ZERO_CORRECTION]]),
            perPano: views.map(v => ({ panoId: v.panoId, dxM: 0, dzM: 0, dyawDeg: 0, dpitchDeg: 0, pairs: 1, beforeRmsM: 1.3, afterRmsM: 1.3 })),
            setAside: [], pairs: [], beforeRmsM: 1.3, afterRmsM: 1.3, used: 1, rejected: 0
        };
        const r = registerPanosByEdges({ frames, mesh, prior, budgetMs: 120_000 });
        expect(r.panos).toHaveLength(2);
        for (const p of r.panos) {
            const truth = truths[p.panoId];
            expect(p.chosen).toBe('edges');
            expect(p.edgeResidualPx.edge!).toBeLessThan(p.edgeResidualPx.prior!);
            // the eye and the pitch come back to within a fraction of the period
            expect(Math.abs(p.edge!.dx - truth.dx)).toBeLessThan(0.2);
            expect(Math.abs(p.edge!.dy - truth.dy)).toBeLessThan(0.2);
            expect(Math.abs(p.edge!.dz - truth.dz)).toBeLessThan(0.6);
            expect(Math.abs(p.edge!.dpitchDeg - truth.dpitchDeg)).toBeLessThan(0.3);
            expect(Math.abs(p.edge!.dyawDeg - truth.dyawDeg)).toBeLessThan(0.3);
            // the held-out agreement prefers it
            expect(p.heldOut.ncc.edges!).toBeGreaterThan(p.heldOut.ncc.boxes!);
            // and the merged registration carries it, labelled
            const pp = r.registration.perPano.find(x => x.panoId === p.panoId)!;
            expect(pp.method).toBe('edges');
            expect(r.registration.corrections.get(p.panoId)).toEqual(p.edge);
        }
        expect(r.ncc.chosen!).toBeGreaterThan(r.ncc.boxes!);

        // the registered pose renders the facade where the photo has it (pixels, the projection's own measure)
        for (const f of frames) {
            const reg = castCamera({ ...f.view, correction: r.registration.corrections.get(f.view.panoId) });
            const truth = castCamera({ ...f.view, correction: truths[f.view.panoId] });
            const corner: [number, number, number] = [6, 10, 0];
            const project = (c: FrameCamera) => {
                const d = [corner[0] - c.eye[0], corner[1] - c.eye[1], corner[2] - c.eye[2]];
                const z = d[0] * c.fwd[0] + d[1] * c.fwd[1] + d[2] * c.fwd[2];
                return [c.cx + c.fx * (d[0] * c.right[0] + d[1] * c.right[1] + d[2] * c.right[2]) / z, c.cy - c.fy * (d[0] * c.up[0] + d[1] * c.up[1] + d[2] * c.up[2]) / z];
            };
            const a = project(reg), b = project(truth), s = project(castCamera(f.view));
            expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThan(3);
            expect(Math.hypot(s[0] - b[0], s[1] - b[1])).toBeGreaterThan(12);
        }

        const out = path.resolve(__dirname, '../../../test-results/screenshots');
        fs.mkdirSync(out, { recursive: true });
        const f = frames[0];
        const overlay = renderRegistrationOverlay(f.image, renderFrameDepth(mesh, castCamera(f.view)), renderFrameDepth(mesh, castCamera({ ...f.view, correction: r.registration.corrections.get('panoA') })));
        fs.writeFileSync(path.join(out, 'staged_location_edge_registration_coursing.png'), encodePng(W, H, overlay, 4));
    }, 120_000);
});
