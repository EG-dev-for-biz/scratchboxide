/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * StreetViewCrossViewRefiner on a synthetic textured corner building photographed from three panos with known
 * poses. The GPS-like eyes share a 1.1 m datum offset plus individual errors up to 0.5 m. The cross-view pass must
 * make the photos agree through the mesh (median residual < 0.5 px), which by itself does not fix where they land
 * on the mesh; the texture anchor (the scan's own texture, here the true facade texture) must then bring the texture
 * placement on cross-view-supported pixels under 0.2 m while keeping the photos consistent.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
    frameCamera, renderTexturedView, sceneToRenderMesh, projectToFrame, ZERO_CORRECTION, type TexturedPrimitive, type PoseCorrection
} from '../src/node/spatial/StreetViewPoseRegistrar';
import { StreetViewCrossViewRefiner, warpLuminanceAtoB, solveSymmetric, estimateGlobalTileOffset, refineWithTileAnchor, type CrossViewFrame } from '../src/node/spatial/StreetViewCrossViewRefiner';
import { encodePng } from '../src/node/texture-processing';

const SHOTS = path.resolve(process.cwd(), 'test-results/screenshots');

/** Facade texture: window grid + random blobs (structure at several scales, no long periodicity). */
function facadeTexture(size: number, seed: number): Buffer {
    const rgba = Buffer.alloc(size * size * 4);
    let s = seed;
    const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    const blobs = Array.from({ length: 220 }, () => ({ x: rnd() * size, y: rnd() * size, r: 4 + rnd() * 26, v: (rnd() - 0.5) * 110 }));
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        let v = 150 + 25 * Math.sin(x / 37) * Math.cos(y / 53);
        const wx = x % 48, wy = y % 64;
        if (wx > 10 && wx < 34 && wy > 12 && wy < 46) v -= 70; // windows
        for (const b of blobs) { const d2 = (x - b.x) ** 2 + (y - b.y) ** 2; if (d2 < b.r * b.r) v += b.v * (1 - d2 / (b.r * b.r)); }
        const i = (y * size + x) * 4;
        rgba[i] = Math.max(0, Math.min(255, v + 12)); rgba[i + 1] = Math.max(0, Math.min(255, v)); rgba[i + 2] = Math.max(0, Math.min(255, v - 15)); rgba[i + 3] = 255;
    }
    return rgba;
}

/** A wall quad from p0 (bottom-left) along `along` (width) and up (height), subdivided n x n. */
function wall(p0: [number, number, number], along: [number, number, number], width: number, height: number, tex: Buffer, size: number): TexturedPrimitive {
    const n = 8;
    const pos: number[] = [], uv: number[] = [], idx: number[] = [];
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
        const u = i / n, v = j / n;
        pos.push(p0[0] + along[0] * width * u, p0[1] + height * v, p0[2] + along[2] * width * u);
        uv.push(u, 1 - v);
    }
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
        idx.push(a, b, d, a, d, c);
    }
    return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx), uvs: Float32Array.from(uv), image: null, imageSize: { width: size, height: size }, materialIndex: 0, rgba: { width: size, height: size, rgba: tex } };
}

describe('StreetViewCrossViewRefiner (synthetic corner building)', () => {
    it('makes three mis-posed panos consistent through the mesh and places them on it with the texture anchor', () => {
        const T = 512;
        // Corner building: a south wall (z = 0, x 0..40) and an east wall (x = 40, z 0..-40), 30 m high
        const prims = [
            wall([0, 0, 0], [1, 0, 0], 40, 30, facadeTexture(T, 7), T),
            wall([40, 0, 0], [0, 0, -1], 40, 30, facadeTexture(T, 99), T)
        ];
        const mesh = sceneToRenderMesh(prims);
        const W = 320, H = 320;
        // Ground-truth panos (eye, frames) on the streets south and east of the corner
        const truth = [
            // P1 sees the south wall, P3 the east wall, P2 (at the corner) both: the corner ties the two facades together
            { id: 'P1', eye: [12, 2.5, 26] as [number, number, number], frames: [{ h: 25, p: 25 }, { h: 350, p: 25 }] },
            { id: 'P2', eye: [56, 2.5, 16] as [number, number, number], frames: [{ h: 305, p: 20 }, { h: 285, p: 25 }] },
            { id: 'P3', eye: [64, 2.5, -24] as [number, number, number], frames: [{ h: 270, p: 25 }, { h: 240, p: 20 }] }
        ];
        // GPS-like nominal eyes: a common datum offset (0.9, 0, -0.7) m plus individual errors up to 0.5 m; heading
        // errors of 0.2-0.25 deg that the sky-silhouette registration recovers (rotation prior centred on them)
        const common: [number, number, number] = [0.9, 0, -0.7];
        const indiv: Record<string, [number, number, number]> = { P1: [0.3, 0.1, -0.2], P2: [-0.4, -0.1, 0.3], P3: [0.2, 0.15, 0.4] };
        const offsets: Record<string, [number, number, number]> = Object.fromEntries(Object.entries(indiv).map(([k, v]) => [k, [v[0] + common[0], v[1] + common[1], v[2] + common[2]]]));
        const rotErr: Record<string, number> = { P1: 0.25, P2: -0.25, P3: 0.2 };
        const frames: CrossViewFrame[] = [];
        for (const p of truth) {
            const nominal: [number, number, number] = [p.eye[0] + offsets[p.id][0], p.eye[1] + offsets[p.id][1], p.eye[2] + offsets[p.id][2]];
            for (const [k, f] of p.frames.entries()) {
                // Photo from the true pose; the frame claims a heading off by rotErr (as a pano yaw error would)
                const cam = frameCamera(p.eye, f.h, f.p, 60, W, H, ZERO_CORRECTION, p.frames[0].h);
                const photo = renderTexturedView(prims, cam, [120, 170, 235]);
                frames.push({ key: `${p.id}_${k}`, panoId: p.id, nominalEye: nominal, headingDeg: f.h - rotErr[p.id], pitchDeg: f.p, fovDeg: 60, referenceHeadingDeg: p.frames[0].h - rotErr[p.id], image: { width: W, height: H, rgba: photo.rgba }, valid: new Uint8Array(W * H).fill(1) });
            }
        }
        const refiner = new StreetViewCrossViewRefiner(mesh, frames, { patchPx: 32, stridePx: 20, initialSearchPx: 24, minDepthMeters: 2 });
        const start = new Map<string, PoseCorrection>(truth.map(p => [p.id, { ...ZERO_CORRECTION, dyawDeg: rotErr[p.id] }]));
        const prior = new Map(start);
        const anchoredRun = refineWithTileAnchor(refiner, prims, start, prior, { anchor: { minDepthMeters: 2 } });
        const res = anchoredRun.first;
        const first = res.history[0], last = res.history[res.history.length - 1];
        console.log(`[cross-view test] history ${JSON.stringify(res.history.map(h => [h.matches, h.medianPx?.toFixed(2)]))}`);
        expect(first.medianPx!).toBeGreaterThan(3);              // the start poses are visibly inconsistent
        expect(last.matches).toBeGreaterThan(100);
        expect(last.medianPx!).toBeLessThan(0.5);                // consistent after refinement
        expect(last.fractionWithin3Px!).toBeGreaterThan(0.95);

        // Texture placement: where a frame's pixels land on the walls. For sampled wall points X seen by a frame, the
        // true camera sees X at pixel q; the estimated camera sends q back onto the wall at X'. |X' - X| is the
        // misplacement of the photo's texture on the surface (what ghosting and seams are made of).
        const walls = [{ n: [0, 0, 1], d: 0 }, { n: [1, 0, 0], d: 40 }]; // n . X = d
        // Only where a frame will be projected: its support mask (cross-view-verified pixels) at the final pose
        const placement = (corrs: Map<string, PoseCorrection>, masks: Uint8Array[]) => {
            const errs: number[] = [];
            frames.forEach((f, fi) => {
                const p = truth.find(t => t.id === f.panoId)!, k = Number(f.key.split('_')[1]);
                const camT = frameCamera(p.eye, p.frames[k].h, p.frames[k].p, 60, W, H, ZERO_CORRECTION, p.frames[0].h);
                const camE = refiner.camera(fi, corrs.get(f.panoId)!);
                for (let s = 0; s < 400; s++) {
                    const w = walls[s % 2], t = (s * 0.6180339887) % 1, h = ((s * 0.7548776662) % 1) * 28 + 1;
                    const X = w.n[2] === 1 ? [t * 40, h, 0] : [40, h, -t * 40];
                    const q = projectToFrame(camT, X), qf = projectToFrame(refiner.camera(fi, anchoredRun.final.corrections.get(f.panoId)!), X);
                    if (!q || q[0] < 0 || q[1] < 0 || q[0] >= W || q[1] >= H) continue;
                    if (!qf || qf[0] < 0 || qf[1] < 0 || qf[0] >= W || qf[1] >= H || !masks[fi][Math.floor(qf[1]) * W + Math.floor(qf[0])]) continue;
                    const u = (q[0] - camE.cx) / camE.fx, v = (q[1] - camE.cy) / camE.fy;
                    const d = [0, 1, 2].map(c => camE.fwd[c] + u * camE.right[c] - v * camE.up[c]);
                    const den = w.n[0] * d[0] + w.n[1] * d[1] + w.n[2] * d[2];
                    const tt = (w.d - (w.n[0] * camE.eye[0] + w.n[1] * camE.eye[1] + w.n[2] * camE.eye[2])) / den;
                    const Xe = [0, 1, 2].map(c => camE.eye[c] + tt * d[c]);
                    errs.push(Math.hypot(Xe[0] - X[0], Xe[1] - X[1], Xe[2] - X[2]));
                }
            });
            errs.sort((x, y) => x - y);
            return { median: errs[errs.length >> 1], p90: errs[Math.floor(errs.length * 0.9)] };
        };
        const placeStart = placement(start, anchoredRun.final.supportMasks), placeEnd = placement(res.corrections, anchoredRun.final.supportMasks);
        // Absolute anchor against the scan texture (here the true facade texture): the global aggregate measures the
        // common datum offset, the per-pano anchors feed the second, anchored cross-view pass
        const anchor = estimateGlobalTileOffset(prims, frames.map((f, i) => ({ key: f.key, cam: res.cameras[i], image: f.image, valid: f.valid })), { minDepthMeters: 2 });
        const placeAnchored = placement(anchoredRun.final.corrections, anchoredRun.final.supportMasks);
        const fin = anchoredRun.final.history[anchoredRun.final.history.length - 1];
        console.log(`[cross-view test] texture placement median ${placeStart.median.toFixed(3)} -> ${placeEnd.median.toFixed(3)} -> anchored ${placeAnchored.median.toFixed(3)} m; anchor offset ${JSON.stringify(anchor.offset)}`);
        // Cross-view consistency alone leaves the photos mutually consistent but misplaced on the mesh: a translation
        // parallel to a facade, shared by the frames that see it, keeps them consistent (first pass ~ start placement)
        // ... which the texture anchor measures and the anchored second pass removes, keeping the photos consistent
        expect(anchor.ringContrast).toBeGreaterThan(0.05);
        expect(anchoredRun.panos.every(p => p.used)).toBe(true);
        expect(placeAnchored.median).toBeLessThan(0.2);
        expect(placeAnchored.median).toBeLessThan(0.25 * placeEnd.median);
        expect(placeAnchored.p90).toBeLessThan(0.4);
        expect(fin.medianPx!).toBeLessThan(0.5);
        // Per-frame statistics and support masks
        // Frames with enough cross-view matches are consistent and supported; a frame with no partner gets no support
        // (it would be rejected as unverified and never projected)
        const verified = anchoredRun.final.frames.filter(f => f.matches >= 15);
        expect(verified.length).toBeGreaterThanOrEqual(3);
        for (const f of verified) {
            expect(f.medianPx!).toBeLessThan(1);
            expect(f.supportedPixels).toBeGreaterThan(W * H * 0.02);
        }
        for (const f of anchoredRun.final.frames.filter(fr => fr.matches === 0)) expect(f.supportedPixels).toBe(0);
        // Visual record: frame P2_0 photo | P1_0 warped into it before / after
        fs.mkdirSync(SHOTS, { recursive: true });
        const b = frames.findIndex(f => f.key === 'P2_0'), a = frames.findIndex(f => f.key === 'P1_0');
        const panel = (corrs: Map<string, PoseCorrection>) => {
            const ca = refiner.camera(a, corrs.get('P1')!), cb = refiner.camera(b, corrs.get('P2')!);
            const da = renderTexturedView(prims, ca).depth, db = renderTexturedView(prims, cb).depth;
            const lum = new Float32Array(W * H);
            for (let i = 0; i < W * H; i++) lum[i] = 0.299 * frames[a].image.rgba[i * 4] + 0.587 * frames[a].image.rgba[i * 4 + 1] + 0.114 * frames[a].image.rgba[i * 4 + 2];
            const wp = warpLuminanceAtoB(ca, da, lum, frames[a].valid, cb, db, frames[b].valid);
            const out = Buffer.alloc(W * H * 4);
            for (let i = 0; i < W * H; i++) {
                // red = photo B, green = warped A: aligned structure looks grey/yellow, misalignment shows colour fringes
                const pb = 0.299 * frames[b].image.rgba[i * 4] + 0.587 * frames[b].image.rgba[i * 4 + 1] + 0.114 * frames[b].image.rgba[i * 4 + 2];
                out[i * 4] = pb; out[i * 4 + 1] = wp.mask[i] ? wp.lum[i] : pb; out[i * 4 + 2] = wp.mask[i] ? 0 : pb; out[i * 4 + 3] = 255;
            }
            return out;
        };
        const before = panel(start), after = panel(anchoredRun.final.corrections);
        const strip = Buffer.alloc(W * 2 * H * 4);
        for (let y = 0; y < H; y++) { before.copy(strip, y * W * 8, y * W * 4, (y + 1) * W * 4); after.copy(strip, y * W * 8 + W * 4, y * W * 4, (y + 1) * W * 4); }
        fs.writeFileSync(path.join(SHOTS, 'streetview_cross_view_refiner_synthetic_before_after.png'), encodePng(W * 2, H, strip));
    }, 300000);

    it('solveSymmetric solves an SPD system and rejects an indefinite one', () => {
        const A = Float64Array.from([4, 1, 0, 1, 3, 1, 0, 1, 2]);
        const x = solveSymmetric(A, Float64Array.from([1, 2, 3]), 3)!;
        const r = [4 * x[0] + x[1] - 1, x[0] + 3 * x[1] + x[2] - 2, x[1] + 2 * x[2] - 3];
        for (const v of r) expect(Math.abs(v)).toBeLessThan(1e-12);
        expect(solveSymmetric(Float64Array.from([1, 2, 2, 1]), Float64Array.from([1, 1]), 2)).toBeNull();
    });
});
