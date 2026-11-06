/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K's facade ortho rectifier (pipeline-k/ortho-rectify.ts): a synthetic facade ortho (stone piers every 3 m,
 * dark window bays with sills every 3.5 m) whose pier edges are bent along their height by a known wobble, as a
 * photogrammetric texture bends them. The rectifier must trace the bent piers, warp them back close to the straight
 * facade, keep the uncovered grey uncovered, and level a smear (one bay darkened over several storeys) against the
 * facade's own repeats without touching the bays around it. Then the cached folder pipeline-k.ts writes for the polish.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';
import { fillHoles, horizontalPeriod, levelSmears, ORTHO_RECTIFY_PARAMS, rectifyOrtho, traceLines, type Rgba } from '../src/node/3d-engine/staged-location/pipeline-k/ortho-rectify';
import { rectifyReliefOrthos } from '../src/node/3d-engine/staged-location/pipeline-k/pipeline-k';
import { rectifyOverlayName, renderRectifyOverlay } from '../src/node/3d-engine/staged-location/pipeline-k/rectify-overlay';
import { decodePng } from '../src/node/texture-processing';

const PX = 0.075, W = 240, H = 480;
const PITCH = 3 / PX, STOREY = 3.5 / PX;

/** The straight facade with every column shifted by wobble(y) px: luma per pixel. */
function facade(wobble: (y: number) => number): Rgba {
    const rgba = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const xs = x - wobble(y), u = ((xs % PITCH) + PITCH) % PITCH, v = y % STOREY;
        // a pier 0.9 m wide, then the bay: dark glass with a lighter sill band and a mullion
        let L = u < 0.9 / PX ? 200 : v < 0.4 / PX ? 150 : Math.abs(u - (0.9 + 1.05) / PX) < 1 ? 110 : 60;
        L += 6 * Math.sin(xs * 0.37 + y * 0.9);
        const i = (y * W + x) * 4;
        rgba[i] = Math.round(L * 1.05); rgba[i + 1] = Math.round(L); rgba[i + 2] = Math.round(L * 0.92); rgba[i + 3] = 255;
    }
    return { width: W, height: H, rgba };
}

/** Mean distance (px) of every pier's left edge (the dark-to-bright crossing of luma 130, sub-pixel) from where it stands in `ref`, over rows y0..y1. */
function edgeError(img: Rgba, ref: Rgba, y0: number, y1: number): number {
    const crossing = (m: Rgba, y: number, x0: number) => {
        for (let x = Math.max(1, x0 - 7); x < Math.min(W - 1, x0 + 7); x++) {
            const a = m.rgba[(y * W + x) * 4 + 1], b = m.rgba[(y * W + x + 1) * 4 + 1];
            if (a < 130 && b >= 130) return x + (130 - a) / (b - a);
        }
        return NaN;
    };
    const d: number[] = [];
    for (let y = y0; y < y1; y++) for (let k = 1; k * PITCH < W - 8; k++) {
        const a = crossing(img, y, Math.round(k * PITCH)), b = crossing(ref, y, Math.round(k * PITCH));
        if (Number.isFinite(a) && Number.isFinite(b)) d.push(a - b);
    }
    // a shift of the whole facade is not a bend: measured about the median offset
    const m = [...d].sort((x, y) => x - y)[d.length >> 1];
    return d.reduce((acc, x) => acc + Math.abs(x - m), 0) / Math.max(1, d.length);
}

const lumaDiff = (a: Rgba, b: Rgba, x0 = 0, x1 = W, y0 = 0, y1 = H) => {
    let s = 0, n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * W + x) * 4; if (a.rgba[i] === 128 && a.rgba[i + 1] === 128) continue; s += Math.abs(a.rgba[i + 1] - b.rgba[i + 1]); n++; }
    return s / Math.max(1, n);
};

describe('pipeline K ortho rectifier', () => {
    const wobble = (y: number) => 2.6 * Math.sin((2 * Math.PI * y) / 140) + 1.2 * Math.sin((2 * Math.PI * y) / 61 + 1);
    const truth = facade(() => 0), bent = facade(wobble);

    it('traces the bent pier edges and finds the bay pitch', () => {
        const lines = traceLines(bent, PX);
        const vertical = lines.filter(l => l.axis === 'v');
        // two edges per pier, five piers in 18 m less the ones at the search border
        expect(vertical.length).toBeGreaterThanOrEqual(6);
        // the trace follows the wobble: across minus its straight position correlates with the wobble at the sample
        const l = vertical[2], d: number[] = [], wv: number[] = [];
        for (let k = 0; k < l.across.length; k++) if (l.weight[k] > 0) { d.push(l.across[k] - l.straight[k]); wv.push(wobble(l.along[k])); }
        const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length, md = mean(d), mw = mean(wv);
        const r = d.reduce((a, x, k) => a + (x - md) * (wv[k] - mw), 0) / Math.sqrt(d.reduce((a, x) => a + (x - md) ** 2, 0) * wv.reduce((a, x) => a + (x - mw) ** 2, 0));
        expect(r).toBeGreaterThan(0.8);
        const p = horizontalPeriod(bent, PX)!;
        expect(Math.abs(p.periodPx - PITCH)).toBeLessThan(1);
    });

    it('warps the piers back close to the straight facade and keeps uncovered pixels uncovered', () => {
        const img = { ...bent, rgba: new Uint8Array(bent.rgba) };
        // an uncovered hole, exact grey
        for (let y = 300; y < 340; y++) for (let x = 20; x < 60; x++) { const i = (y * W + x) * 4; img.rgba[i] = img.rgba[i + 1] = img.rgba[i + 2] = 128; }
        const r = rectifyOrtho(img, PX, { ...ORTHO_RECTIFY_PARAMS, smearK: 1e9 });
        expect(r.report.warp.kept).toBe(true);
        expect(r.report.straightnessPx.gain).toBeGreaterThan(0.5);
        expect(r.report.warp.foldScale).toBeGreaterThan(0);
        // every pier edge, row by row, much closer to where it stands on the straight facade (away from the hole);
        const before = edgeError(bent, truth, 20, 280), after = edgeError(r.image, truth, 20, 280);
        expect(before).toBeGreaterThan(1.2);
        expect(after).toBeLessThan(0.45 * before);
        // the hole: marked uncovered in the mask (its middle), and filled in the image: no exact grey anywhere
        expect(r.uncovered[320 * W + 40]).toBe(1);
        expect(r.uncovered[100 * W + 100]).toBe(0);
        let grey = 0;
        for (let i = 0; i < W * H; i++) if (r.image.rgba[i * 4] === 128 && r.image.rgba[i * 4 + 1] === 128 && r.image.rgba[i * 4 + 2] === 128) grey++;
        expect(grey).toBe(0);
        expect(r.report.holes.uncovered).toBeGreaterThan(1000);
        expect(r.report.holes.fromRepeats).toBeGreaterThan(0.8 * r.report.holes.uncovered);
    });

    it('draws what the straightening read: traces on the input, a green frame round a kept warp, the dropped peaks', () => {
        const r = rectifyOrtho(bent, PX, { ...ORTHO_RECTIFY_PARAMS, smearK: 1e9 });
        expect(r.report.warp.kept).toBe(true);
        expect(r.trace.lines.length).toBe(r.report.lines.vertical + r.report.lines.horizontal);
        expect(r.trace.after).toHaveLength(r.trace.lines.length);
        expect(r.trace.rejected.every(p => ['border', 'no-edge', 'no-segment'].includes(p.why))).toBe(true);
        const o = renderRectifyOverlay(bent, r);
        expect(o.width).toBeGreaterThan(2 * W);
        expect(o.rgb.length).toBe(o.width * o.height * 3);
        const header = o.height - H, at = (x: number, y: number) => Array.from(o.rgb.subarray(((header + y) * o.width + x) * 3, ((header + y) * o.width + x) * 3 + 3));
        // a traced pier (yellow: red and green high, blue low) at its traced sample on the left panel
        const v = r.trace.lines.find(l => l.axis === 'v' && l.weight.some(w => w > 0.8))!;
        const k = v.weight.findIndex(w => w > 0.8);
        const [pr, pg, pb] = at(Math.round(v.across[k]), Math.round(v.along[k]));
        expect(pr).toBeGreaterThan(150); expect(pg).toBeGreaterThan(130); expect(pb).toBeLessThan(90);
        // the right panel framed green (kept)
        const right = o.width - W, [fr, fg, fb] = at(right + (W >> 1), 0);
        expect(fg).toBeGreaterThan(200); expect(fr).toBeLessThan(100); expect(fb).toBeLessThan(120);
        // a facade nothing straightened: framed red
        const plain = rectifyOrtho(truth, PX, { ...ORTHO_RECTIFY_PARAMS, smearK: 1e9 });
        const p = renderRectifyOverlay(truth, plain), ph = p.height - H, q = ((ph * p.width) + (p.width - W) + (W >> 1)) * 3;
        expect(plain.report.warp.kept).toBe(false);
        expect(p.rgb[q]).toBeGreaterThan(200); expect(p.rgb[q + 1]).toBeLessThan(100);
    });

    it('fills holes from the facade\'s own repeats, close to what the photo would have shown', () => {
        const img = { ...truth, rgba: new Uint8Array(truth.rgba) };
        // a wedge-shaped hole across two bays, exact grey
        for (let y = 120; y < 260; y++) for (let x = 60; x < 60 + Math.round((y - 120) * 0.7); x++) { const i = (y * W + x) * 4; img.rgba[i] = img.rgba[i + 1] = img.rgba[i + 2] = 128; }
        const r = fillHoles(img, PX);
        expect(r.fill.uncovered).toBeGreaterThan(5000);
        expect(r.fill.fromRepeats).toBe(r.fill.uncovered);
        // the filled wedge reads like the facade: within a few levels of the truth on average (the pitch is 40 px exactly here)
        expect(lumaDiff(r.image, truth, 60, 158, 120, 260)).toBeLessThan(6);
        // and the real texels are untouched
        expect(lumaDiff(r.image, truth, 170, W, 0, H)).toBe(0);
    });

    it('leaves a straight facade alone', () => {
        const r = rectifyOrtho(truth, PX, { ...ORTHO_RECTIFY_PARAMS, smearK: 1e9 });
        expect(r.report.warp.kept).toBe(false);
        expect(Buffer.from(r.image.rgba).equals(Buffer.from(truth.rgba))).toBe(true);
    });

    it('levels a smear against the repeats and leaves the other bays as they were', () => {
        const img = { ...truth, rgba: new Uint8Array(truth.rgba) };
        // bay 3 (x 120..160) darkened to 55% over rows 100..400
        const x0 = Math.round(3 * PITCH), x1 = Math.round(4 * PITCH);
        for (let y = 100; y < 400; y++) for (let x = x0; x < x1; x++) { const i = (y * W + x) * 4; for (let c = 0; c < 3; c++) img.rgba[i + c] = Math.round(img.rgba[i + c] * 0.55); }
        const s = levelSmears(img, PITCH, PX);
        expect(s.texels).toBeGreaterThan(0);
        const inside = [lumaDiff(img, truth, x0 + 4, x1 - 4, 160, 340), lumaDiff(s.image, truth, x0 + 4, x1 - 4, 160, 340)];
        expect(inside[1]).toBeLessThan(0.5 * inside[0]);
        // the bays two pitches away are untouched
        expect(lumaDiff(s.image, img, 0, Math.round(PITCH), 0, H)).toBe(0);
    });

    it('writes a cached rectified ortho set beside the originals for the polish', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-k-'));
        const src = path.join(dir, 'relief_orthos');
        fs.mkdirSync(src);
        fs.writeFileSync(path.join(src, 'facade_0.png'), encodePng(W, H, bent.rgba, 4));
        // facade 1: its photo covers every other column of its wall only (the rest the uncovered grey): too little to rectify
        const sparse = Uint8Array.from(bent.rgba);
        for (let y = 0; y < H; y++) for (let x = 1; x < W; x += 2) sparse.set([128, 128, 128, 255], (y * W + x) * 4);
        fs.writeFileSync(path.join(src, 'facade_1.png'), encodePng(W, H, sparse, 4));
        const base = { centroid: [0, 0, 0], normal: [0, 0, 1], axisS: [1, 0, 0], axisT: [0, 1, 0], sMin: 0, sMax: W * PX, tMin: 0, tMax: H * PX, pixel: PX, width: W, height: H, orthoSMin: 0, orthoTMax: H * PX };
        fs.writeFileSync(path.join(src, 'facades.json'), JSON.stringify({ schema: 'test', facades: [{ ...base, facadeId: 0, image: 'facade_0.png', coverage: 0.9 }, { ...base, facadeId: 1, image: 'facade_1.png', coverage: 0.2 }] }));
        const r = await rectifyReliefOrthos(src, { threads: 1 });
        expect(r.cached).toBe(false);
        expect(r.reports.map(x => x.facadeId)).toEqual([0]);
        expect(r.reports[0].report?.warp.kept).toBe(true);
        // the rectified facade names its uncovered mask (one channel PNG) in facades.json
        const written = JSON.parse(fs.readFileSync(path.join(r.orthosDir, 'facades.json'), 'utf8')).facades;
        expect(written[0].uncoveredMask).toBe('facade_0_uncovered.png');
        expect(fs.existsSync(path.join(r.orthosDir, 'facade_0_uncovered.png'))).toBe(true);
        expect(written[1].uncoveredMask).toBeUndefined();
        // the low-coverage facade is copied as it was; the rectified one differs
        expect(fs.readFileSync(path.join(r.orthosDir, 'facade_1.png')).equals(fs.readFileSync(path.join(src, 'facade_1.png')))).toBe(true);
        expect(fs.readFileSync(path.join(r.orthosDir, 'facade_0.png')).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
        expect(fs.readFileSync(path.join(r.orthosDir, 'facade_0.png')).equals(fs.readFileSync(path.join(src, 'facade_0.png')))).toBe(false);
        expect(JSON.parse(fs.readFileSync(path.join(r.orthosDir, 'facades.json'), 'utf8')).facades).toHaveLength(2);
        // the straightening's overlay beside the rectified ortho, input and result side by side under a header
        const overlay = decodePng(fs.readFileSync(path.join(r.orthosDir, rectifyOverlayName('facade_0.png'))));
        expect(overlay.width).toBeGreaterThan(2 * W);
        expect(overlay.height).toBeGreaterThan(H);
        expect(fs.existsSync(path.join(r.orthosDir, rectifyOverlayName('facade_1.png')))).toBe(false);
        const again = await rectifyReliefOrthos(src, { threads: 1 });
        expect(again.cached).toBe(true);
        expect(again.orthosDir).toBe(r.orthosDir);
        fs.rmSync(dir, { recursive: true, force: true });
    }, 60_000);
});
