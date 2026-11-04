/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The answer warp (answer-warp.ts) on a synthetic aerial-like image (blocks of facade grids and paving, seeded): an
 * answer that is the image itself is in place; one moved 5.2 / -3.1 px, rescaled 0.6% and turned 0.3 degrees (the size
 * of what Gemini returned at Penn, 2026-11-02) has that warp recovered to a fraction of a pixel and, warped back, matches
 * the image; one whose two halves moved apart has no one warp ("answer_parts_moved"); a different picture matches too
 * few blocks ("answer_redrawn"); one rescaled 3.5% is reframed ("answer_reframed"); and blocks under a mask are not
 * judged; the image's window grids repeat every 6 to 14 px, so a block matched on sharp edges alone could lock one bay
 * over. The frame is half the real one (672 x 384), so the blocks and the search are halved too (answerWarpParamsForWidth).
 */

import { describe, expect, it } from 'vitest';
import { answerWarpParamsForWidth, fitAnswerWarp, matchBlocks, registerAnswer, warpAnswerToView, type AnswerImage } from '../src/node/spatial/answer-warp';

const W = 672, H = 384;
const P = answerWarpParamsForWidth(W);

/** A seeded city-like picture: rectangles of facade window grids and paving joints in varied greys and tints. */
function cityImage(seed: number): AnswerImage {
    let s = seed >>> 0;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    const rgba = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) rgba.set([92, 92, 88, 255], i * 4);
    for (let r = 0; r < 70; r++) {
        const x0 = Math.floor(rnd() * W), y0 = Math.floor(rnd() * H), w = 30 + Math.floor(rnd() * 130), h = 30 + Math.floor(rnd() * 110);
        const base = [90 + rnd() * 120, 80 + rnd() * 110, 70 + rnd() * 100], pitchX = 6 + Math.floor(rnd() * 8), pitchY = 7 + Math.floor(rnd() * 9);
        for (let y = y0; y < Math.min(H, y0 + h); y++) for (let x = x0; x < Math.min(W, x0 + w); x++) {
            const win = (x - x0) % pitchX < pitchX * 0.5 && (y - y0) % pitchY < pitchY * 0.55;
            const k = win ? 0.45 : 1;
            rgba.set([base[0] * k, base[1] * k, base[2] * k, 255], (y * W + x) * 4);
        }
    }
    return { width: W, height: H, rgba };
}

/** The answer an image model would return: `given` seen through the affine A (given pixel -> answer pixel), resampled. */
function through(given: AnswerImage, A: [number, number, number, number, number, number]): AnswerImage {
    const det = A[0] * A[4] - A[1] * A[3];
    const inv = [A[4] / det, -A[1] / det, (A[1] * A[5] - A[4] * A[2]) / det, -A[3] / det, A[0] / det, (A[3] * A[2] - A[0] * A[5]) / det];
    return warpAnswerToView(given, given, inv as typeof A);
}

/** The affine for a move (tx, ty), a scale and a turn about the frame's centre. */
function affine(tx: number, ty: number, scale: number, turnDeg: number): [number, number, number, number, number, number] {
    const c = Math.cos((turnDeg * Math.PI) / 180) * scale, s = Math.sin((turnDeg * Math.PI) / 180) * scale, cx = W / 2, cy = H / 2;
    return [c, -s, cx - c * cx + s * cy + tx, s, c, cy - s * cx - c * cy + ty];
}

const meanAbsDiff = (a: AnswerImage, b: AnswerImage, border = 20) => {
    let d = 0, n = 0;
    for (let y = border; y < H - border; y++) for (let x = border; x < W - border; x++) { const i = (y * W + x) * 4; d += Math.abs(a.rgba[i] - b.rgba[i]); n++; }
    return d / n;
};

describe('answer warp', () => {
    const given = cityImage(7);

    it('leaves an answer that is the image itself in place', () => {
        const r = registerAnswer(given, given, undefined, P);
        expect(r.warp.pass).toBe(true);
        expect(r.warp.shiftPx).toBeLessThan(0.5);
        expect(Math.abs(r.warp.scale - 1)).toBeLessThan(0.002);
        expect(r.blocks.inPlace).toBe(r.blocks.matched);
        expect(r.blocks.matched).toBeGreaterThan(0.8 * r.blocks.textured);
    });

    it('recovers a moved, rescaled and turned answer and warps it back onto the image', () => {
        const A = affine(5.2, -3.1, 1.006, 0.3);
        const answer = through(given, A);
        const before = matchBlocks(given, answer, undefined, P);
        expect(before.inPlace).toBeLessThan(0.2 * before.matched);           // as returned, almost no block is in place
        const r = registerAnswer(given, answer, undefined, P);
        expect(r.warp.pass).toBe(true);
        expect(Math.abs(r.warp.scale - 1.006)).toBeLessThan(0.0005);
        expect(r.warp.turnDeg).toBeCloseTo(0.3, 1);
        // the fitted warp places the frame's corners (outside every block, so extrapolated) within a quarter pixel of the true one
        for (const [x, y] of [[0, 0], [W, 0], [0, H], [W, H]]) {
            const fx = r.warp.affine[0] * x + r.warp.affine[1] * y + r.warp.affine[2], fy = r.warp.affine[3] * x + r.warp.affine[4] * y + r.warp.affine[5];
            const tx = A[0] * x + A[1] * y + A[2], ty = A[3] * x + A[4] * y + A[5];
            expect(Math.hypot(fx - tx, fy - ty)).toBeLessThan(0.25);
        }
        expect(r.after!.medianShiftPx).toBeLessThanOrEqual(1);
        expect(r.after!.inPlace).toBeGreaterThan(0.9 * r.after!.matched);
        expect(meanAbsDiff(given, answer)).toBeGreaterThan(15);
        expect(meanAbsDiff(given, r.aligned!)).toBeLessThan(6);
    });

    it('refuses an answer whose parts moved apart: no one warp places it', () => {
        const left = through(given, affine(8, 0, 1, 0)), right = through(given, affine(-8, 0, 1, 0));
        const split: AnswerImage = { width: W, height: H, rgba: new Uint8Array(W * H * 4) };
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) split.rgba.set((x < W / 2 ? left : right).rgba.subarray((y * W + x) * 4, (y * W + x) * 4 + 4), (y * W + x) * 4);
        const w = fitAnswerWarp(matchBlocks(given, split, undefined, P), P);
        expect(w.pass).toBe(false);
        expect(w.refusal).toBe('answer_parts_moved');
    });

    it('refuses a different picture: too few blocks match it', () => {
        const w = fitAnswerWarp(matchBlocks(given, cityImage(99), undefined, P), P);
        expect(w.pass).toBe(false);
        expect(w.refusal).toBe('answer_redrawn');
    });

    it('refuses a reframed answer: rescaled past the limit', () => {
        const w = fitAnswerWarp(matchBlocks(given, through(given, affine(0, 0, 1.035, 0)), undefined, P), P);
        expect(w.pass).toBe(false);
        expect(w.refusal).toBe('answer_reframed');
        expect(w.scale).toBeCloseTo(1.035, 2);
    });

    it('judges only the blocks under the mask', () => {
        const mask = new Uint8Array(W * H);
        for (let y = 0; y < H; y++) for (let x = 0; x < W / 2; x++) mask[y * W + x] = 1;
        const all = matchBlocks(given, given, undefined, P), half = matchBlocks(given, given, mask, P);
        expect(half.textured).toBeGreaterThan(0);
        expect(half.textured).toBeLessThan(0.6 * all.textured);
        expect(half.matches.every(m => m.x < W / 2)).toBe(true);
    });

    it('scales the blocks and the search with the frame', () => {
        expect([P.blockPx, P.searchPx]).toEqual([48, 12]);
        const full = answerWarpParamsForWidth(1344), tiny = answerWarpParamsForWidth(100);
        expect([full.blockPx, full.searchPx]).toEqual([96, 24]);
        expect([tiny.blockPx, tiny.searchPx]).toEqual([16, 4]);
        expect(full.minNcc).toBe(P.minNcc);
    });

    it('refuses an answer of another size, asking for a resize', () => {
        expect(() => matchBlocks(given, { width: W / 2, height: H / 2, rgba: new Uint8Array(W * H) }, undefined, P)).toThrow(/resize it first/);
    });
});
