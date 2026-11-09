/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The native facade ortho straightening (pipeline-k/native/ortho-rectify-native.ts over scratchbox_ortho_rectify.hpp)
 * against the TypeScript it translates (pipeline-k/ortho-rectify.ts rectifyOrtho), on synthetic facade orthos: piers and
 * storey lines bent and skewed so the warp is solved and kept, uncovered holes so the fill runs from bay and storey repeats
 * (what they leave stays grey for pipeline K's later rungs, never the nearest texel), a bay darkened over several storeys so the smear levelling runs, a large smooth patch so the
 * featureless mask is drawn, transparent texels, and an occlusion mask carried through the warp. Parity is exact: every
 * image byte, every mask and every report field but `ms`. Then the two timed on a full-size ortho.
 */

import { describe, expect, it } from 'vitest';
import { ORTHO_RECTIFY_PARAMS, rectifyOrtho, type OrthoRectifyParams, type OrthoRectifyResult, type Rgba } from '../src/node/3d-engine/staged-location/pipeline-k/ortho-rectify';
import { rectifyOrthoNative } from '../src/node/3d-engine/staged-location/pipeline-k/native/ortho-rectify-native';

interface FacadeSpec {
    W: number; H: number; px: number;
    /** Pier and storey pitch (m). */
    pitchM: number; storeyM: number;
    /** Column shift per row (px) and row shift per column (px): the photogrammetric bend. */
    wobbleX: (y: number) => number; wobbleY: (x: number) => number;
}

/** A facade ortho: piers, dark bays with a sill band and a mullion, a little texture; deterministic. */
function facade(s: FacadeSpec): Rgba {
    const { W, H, px } = s, pitch = s.pitchM / px, storey = s.storeyM / px;
    const rgba = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const xs = x - s.wobbleX(y), ys = y - s.wobbleY(x);
        const u = ((xs % pitch) + pitch) % pitch, v = ((ys % storey) + storey) % storey;
        let L = u < 0.9 / px ? 200 : v < 0.4 / px ? 150 : Math.abs(u - (0.9 + 1.05) / px) < 1 ? 110 : 60;
        L += 6 * Math.sin(xs * 0.37 + ys * 0.9) + 3 * Math.sin(xs * 1.7 - ys * 0.3);
        const i = (y * W + x) * 4;
        rgba[i] = Math.max(0, Math.min(255, Math.round(L * 1.05))); rgba[i + 1] = Math.max(0, Math.min(255, Math.round(L))); rgba[i + 2] = Math.max(0, Math.min(255, Math.round(L * 0.92))); rgba[i + 3] = 255;
    }
    return { width: W, height: H, rgba };
}

/** Exact uncovered grey over a box. */
function hole(img: Rgba, x0: number, y0: number, x1: number, y1: number): void {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * img.width + x) * 4; img.rgba[i] = img.rgba[i + 1] = img.rgba[i + 2] = 128; }
}
/** A box darkened (a smear) by `gain`. */
function smear(img: Rgba, x0: number, y0: number, x1: number, y1: number, gain: number): void {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * img.width + x) * 4; for (let c = 0; c < 3; c++) img.rgba[i + c] = Math.round(img.rgba[i + c] * gain); }
}
/** A box of one flat colour (a wall a neighbour hid: featureless photo). */
function flat(img: Rgba, x0: number, y0: number, x1: number, y1: number, v: number): void {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * img.width + x) * 4; img.rgba[i] = img.rgba[i + 1] = v; img.rgba[i + 2] = v - 3; }
}
/** A box with alpha 0 (outside the facade). */
function transparent(img: Rgba, x0: number, y0: number, x1: number, y1: number): void {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) img.rgba[(y * img.width + x) * 4 + 3] = 0;
}
/** An occlusion mask: a blocked band down one side plus a ramp, deterministic. */
function occlusion(W: number, H: number): Uint8Array {
    const m = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) m[y * W + x] = x < W * 0.15 ? 230 : (x * 7 + y * 3) % 256;
    return m;
}

const countDiff = (a: Uint8Array, b: Uint8Array) => { let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++; return n; };

/** Every byte, mask and report field but `ms`, exactly. */
function expectParity(ts: OrthoRectifyResult, nat: OrthoRectifyResult): void {
    expect(nat.image.width).toBe(ts.image.width);
    expect(nat.image.height).toBe(ts.image.height);
    expect(countDiff(nat.image.rgba, ts.image.rgba)).toBe(0);
    expect(countDiff(nat.uncovered, ts.uncovered)).toBe(0);
    expect(countDiff(nat.featureless, ts.featureless)).toBe(0);
    expect(!!nat.occluded).toBe(!!ts.occluded);
    if (ts.occluded) expect(countDiff(nat.occluded!, ts.occluded)).toBe(0);
    const { ms: _a, ...rt } = ts.report, { ms: _b, ...rn } = nat.report;
    expect(rn).toEqual(rt);
    // what was traced (the straightening's overlay), when the native was asked for it: every line, sample and dropped peak
    if (nat.trace) expect(nat.trace).toEqual(ts.trace);
}

const P: OrthoRectifyParams = ORTHO_RECTIFY_PARAMS;

describe('native ortho rectify parity', () => {
    const bentSpec: FacadeSpec = {
        W: 240, H: 480, px: 0.075, pitchM: 3, storeyM: 3.5,
        wobbleX: y => 2.6 * Math.sin((2 * Math.PI * y) / 140) + 1.2 * Math.sin((2 * Math.PI * y) / 61 + 1) + 0.006 * y,
        wobbleY: x => 1.8 * Math.sin((2 * Math.PI * x) / 90 + 0.4)
    };

    it('a bent, skewed facade with holes, a smear and an occlusion mask: the warp kept, every stage run', async () => {
        const img = facade(bentSpec);
        hole(img, 20, 300, 60, 340);
        hole(img, 150, 40, 175, 120);
        smear(img, 120, 100, 160, 400, 0.55);
        const occ = occlusion(img.width, img.height);
        const ts = rectifyOrtho({ ...img, rgba: new Uint8Array(img.rgba) }, bentSpec.px, P, occ.slice());
        const nat = await rectifyOrthoNative(img, bentSpec.px, P, occ.slice(), { trace: true });
        // the case exercises what it should
        expect(ts.report.warp.kept).toBe(true);
        expect(ts.report.lines.vertical).toBeGreaterThan(0);
        expect(ts.report.lines.horizontal).toBeGreaterThan(0);
        expect(ts.report.smear.texels).toBeGreaterThan(0);
        expect(ts.report.holes.uncovered).toBeGreaterThan(0);
        expect(ts.report.holes.fromRepeats).toBeGreaterThan(0);
        expect(countDiff(ts.occluded!, occ)).toBeGreaterThan(0);
        expect(nat.trace?.lines.length).toBe(ts.report.lines.vertical + ts.report.lines.horizontal);
        expect(nat.trace?.after).toBeDefined();
        expectParity(ts, nat);
    }, 120_000);

    it('a straight facade with a smear, a featureless patch and transparent texels: the warp not kept', async () => {
        const spec: FacadeSpec = { ...bentSpec, W: 300, H: 420, wobbleX: () => 0, wobbleY: () => 0 };
        const img = facade(spec);
        smear(img, 40, 60, 80, 380, 0.6);
        flat(img, 170, 150, 270, 260, 140);
        transparent(img, 0, 400, 300, 420);
        hole(img, 200, 300, 230, 360);
        const ts = rectifyOrtho({ ...img, rgba: new Uint8Array(img.rgba) }, spec.px, P);
        const nat = await rectifyOrthoNative(img, spec.px, P, undefined, { trace: true });
        expect(nat.trace).toBeDefined();
        expect(ts.report.warp.kept).toBe(false);
        expect(ts.report.holes.featureless).toBeGreaterThan(0);
        expect(ts.occluded).toBeUndefined();
        expectParity(ts, nat);
    }, 120_000);

    it('a facade whose holes outrun its repeats (left grey for pipeline K\'s later rungs) and changed parameters', async () => {
        const spec: FacadeSpec = { ...bentSpec, W: 200, H: 360, px: 0.06, pitchM: 2.4, storeyM: 3.2, wobbleX: y => 3 * Math.sin(y / 30), wobbleY: x => 2 * Math.cos(x / 25) };
        const img = facade(spec);
        hole(img, 0, 0, 200, 70);
        hole(img, 60, 150, 140, 260);
        const params: OrthoRectifyParams = { ...P, gridM: 0.6, bendCost: 0.4, minGain: 0.05, smearK: 2, fillRepeats: 2, minFillRepeats: 2, traceHorizontal: false };
        const occ = occlusion(spec.W, spec.H);
        const ts = rectifyOrtho({ ...img, rgba: new Uint8Array(img.rgba) }, spec.px, params, occ.slice());
        const nat = await rectifyOrthoNative(img, spec.px, params, occ.slice(), { trace: true });
        expect(ts.report.lines.horizontal).toBe(0);
        expect(ts.report.holes.fromNearest).toBe(0);
        expect(ts.report.holes.uncovered).toBeGreaterThan(ts.report.holes.fromRepeats + ts.report.holes.fromStoreys);
        expectParity(ts, nat);
    }, 120_000);

    it('noise with no repeat: no period, no smear step', async () => {
        const W = 160, H = 160, rgba = new Uint8Array(W * H * 4);
        let s = 2463534242;
        for (let i = 0; i < W * H; i++) { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; const v = 40 + (s % 170); rgba.set([v, v, v, 255], i * 4); }
        const img = { width: W, height: H, rgba };
        const ts = rectifyOrtho({ ...img, rgba: new Uint8Array(rgba) }, 0.05, P);
        const nat = await rectifyOrthoNative(img, 0.05, P);
        expect(ts.report.periodM).toBeUndefined();
        expectParity(ts, nat);
    }, 120_000);

    it('a full-size ortho (1500 x 3000): parity, and the two timed', async () => {
        const spec: FacadeSpec = {
            W: 1500, H: 3000, px: 0.04, pitchM: 3.1, storeyM: 3.6,
            wobbleX: y => 4 * Math.sin((2 * Math.PI * y) / 700) + 2 * Math.sin((2 * Math.PI * y) / 230 + 1) + 0.002 * y,
            wobbleY: x => 2.5 * Math.sin((2 * Math.PI * x) / 500 + 0.4)
        };
        const img = facade(spec);
        hole(img, 100, 1800, 400, 2100);
        hole(img, 900, 200, 1100, 700);
        smear(img, 620, 600, 700, 2400, 0.6);
        flat(img, 1150, 2400, 1450, 2800, 150);
        const occ = occlusion(spec.W, spec.H);
        // the first native call may build the driver; not timed
        await rectifyOrthoNative({ width: 64, height: 64, rgba: new Uint8Array(64 * 64 * 4).fill(200) }, 0.05, P);
        const t0 = performance.now();
        const ts = rectifyOrtho({ ...img, rgba: new Uint8Array(img.rgba) }, spec.px, P, occ.slice());
        const tsMs = performance.now() - t0;
        const t1 = performance.now();
        const nat = await rectifyOrthoNative(img, spec.px, P, occ.slice());
        const natMs = performance.now() - t1;
        console.log(`[ortho-rectify-native] ${spec.W} x ${spec.H}: TypeScript ${tsMs.toFixed(0)} ms, native ${natMs.toFixed(0)} ms end to end (kernel ${nat.report.ms} ms), ${(tsMs / natMs).toFixed(1)}x; warp kept ${ts.report.warp.kept}, smear texels ${ts.report.smear.texels}, holes ${ts.report.holes.uncovered}`);
        expect(ts.report.warp.kept).toBe(true);
        expectParity(ts, nat);
    }, 600_000);
});
