/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * An image model's answer is not pixel-registered to the image it was given: Gemini image models (gemini-3.1-flash-image
 * at 1K, the district aerial paint at Penn Station, 2026-11-02, run f3f527eb) hand back the picture moved and rescaled as
 * a whole, by a median of 4.1 px and up to 11.1 px, scale 0.985 to 1.011, turned under 0.6 degrees. Anything that bakes an
 * answer back onto geometry (a station texture or splat bake, a facade enhance) must measure that warp and undo it first;
 * an outline check at a few percent does not see it.
 *
 *   matchBlocks       the given image's edges (luma, blurred, Sobel) in blockPx blocks; each block with enough edge is
 *                     matched against the answer's over shifts up to searchPx: first on heavily blurred edges (so a
 *                     repeating window grid cannot pull it one bay over), then on the sharp edges within refinePx of
 *                     that, then to a fraction of a pixel by a parabola through the NCC either side; it counts as matched
 *                     at its best shift when the sharp-edge NCC there is at least minNcc, placed at its edge-weighted
 *                     centre;
 *   fitAnswerWarp     one affine from the given image's pixels to the answer's, fitted to the matched blocks
 *                     (Huber-reweighted least squares), refused with its reason when too few blocks matched (the model
 *                     redrew the image), when no one warp places them (it moved parts of the image apart), or when the
 *                     warp is far from the identity (it reframed the image);
 *   warpAnswerToView  the answer resampled into the given image's frame through that warp.
 *
 * Over all 129 answers of that run (78 views, up to two answers each), 43 passed: the fit placed their blocks to a median
 * residual of 0.5 px (at most 0.9 px), and undone, their median block shift was 0.1 to 0.9 px and the share of blocks in
 * place rose from 7% to 92% (medians); 39 of the 78 views had a passing answer. 44 had no one warp that placed them
 * (answer_parts_moved) and 42 matched too few blocks (answer_redrawn): the model redrew those, it did not move them.
 */

import { blur1 } from './StreetViewStage3Metrics';

/** An RGBA8 image (row-major, 4 bytes a pixel). */
export interface AnswerImage { width: number; height: number; rgba: Uint8Array }

export const ANSWER_WARP_PARAMS = {
    /** Block size and the farthest shift searched (px): 96 and 24 at a 1344 x 768 frame; answerWarpParamsForWidth scales them to another. */
    blockPx: 96, searchPx: 24,
    /**
     * Edges: luma blurred edgeSigmaPx before Sobel; a block is matched only when its mean edge is at least minEdge. Each
     * block is first matched on edges blurred coarseSigmaPx, where a window grid's pitch (6 to 14 px at these frames)
     * smears out and only building-scale structure is left, so a repeating facade cannot pull a block one bay over; then
     * refined on the fine edges within refinePx of that.
     */
    edgeSigmaPx: 1.5, coarseSigmaPx: 5, refinePx: 3, minEdge: 4,
    /** A block matches at its best shift when the edge NCC there is at least this. */
    minNcc: 0.45,

    /** A block is in place when it matched within this many px. */
    inPlacePx: 2,
    /** The fit: at least minMatchedShare of the textured blocks matched; median residual at most maxResidualPx with at least minInlierShare within inlierPx. */
    minMatchedShare: 0.5, maxResidualPx: 1.0, inlierPx: 2, minInlierShare: 0.75,
    /** The warp near the identity: scale within maxScaleChange of 1, turn within maxTurnDeg. */
    maxScaleChange: 0.03, maxTurnDeg: 1
};
export type AnswerWarpParams = typeof ANSWER_WARP_PARAMS;

/** The frame width ANSWER_WARP_PARAMS' blockPx and searchPx are set for (px). */
export const ANSWER_WARP_FRAME_WIDTH_PX = 1344;

/** `P` with blockPx and searchPx scaled from the 1344 px frame to a frame `width` px wide (the answer moves in proportion to the frame). */
export function answerWarpParamsForWidth(width: number, P: AnswerWarpParams = ANSWER_WARP_PARAMS): AnswerWarpParams {
    const k = width / ANSWER_WARP_FRAME_WIDTH_PX;
    return { ...P, blockPx: Math.max(16, Math.round(P.blockPx * k)), searchPx: Math.max(4, Math.round(P.searchPx * k)) };
}

export interface BlockMatch {
    /** The block's edge-weighted centre in the given image (px, pixel centres at +0.5) and where it lies in the answer, relative to that (px). */
    x: number; y: number; dx: number; dy: number;
    ncc: number;
}

export interface BlockMatches {
    /** Blocks with enough edge to be matched, those that matched somewhere, and those that matched in place. */
    textured: number; matched: number; inPlace: number;
    /** Median shift (px) of the matched blocks. */
    medianShiftPx: number;
    matches: BlockMatch[];
}

/** Why an answer cannot be warped back (open strings; reasons may be added). */
export type AnswerWarpRefusal = 'answer_redrawn' | 'answer_parts_moved' | 'answer_reframed' | (string & {});

export interface AnswerWarp {
    /** The answer's position of a given-image pixel: (a0 x + a1 y + a2, a3 x + a4 y + a5). */
    affine: [number, number, number, number, number, number];
    scale: number; turnDeg: number;
    /** How far the matched blocks' centre moved (px). */
    shiftPx: number;
    residualMedianPx: number; inlierShare: number; matchedShare: number;
    pass: boolean;
    refusal?: AnswerWarpRefusal;
    reason: string;
}

const lumaOf = (img: AnswerImage): Float32Array => {
    const n = img.width * img.height, out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = 0.2126 * img.rgba[i * 4] + 0.7152 * img.rgba[i * 4 + 1] + 0.0722 * img.rgba[i * 4 + 2];
    return out;
};

function sobel(L: Float32Array, W: number, H: number): Float32Array {
    const out = new Float32Array(W * H);
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        const gx = L[i - W + 1] + 2 * L[i + 1] + L[i + W + 1] - L[i - W - 1] - 2 * L[i - 1] - L[i + W - 1];
        const gy = L[i + W - 1] + 2 * L[i + W] + L[i + W + 1] - L[i - W - 1] - 2 * L[i - W] - L[i - W + 1];
        out[i] = Math.hypot(gx, gy);
    }
    return out;
}

/**
 * The given image's edge blocks matched against the answer's (see the file comment). `mask` (1 = judge this pixel, e.g.
 * not a region the model was asked to repaint) defaults to every pixel. The answer must be the given image's size.
 */
export function matchBlocks(given: AnswerImage, answer: AnswerImage, mask?: Uint8Array, P: AnswerWarpParams = ANSWER_WARP_PARAMS): BlockMatches {
    const W = given.width, H = given.height;
    if (answer.width !== W || answer.height !== H) throw new Error(`matchBlocks: the answer is ${answer.width} x ${answer.height}, the given image ${W} x ${H}; resize it first`);
    const M = mask ?? new Uint8Array(W * H).fill(1);
    const Lg = lumaOf(given), La = lumaOf(answer);
    const Eg = sobel(blur1(Lg, W, H, P.edgeSigmaPx), W, H), Ea = sobel(blur1(La, W, H, P.edgeSigmaPx), W, H);
    const Cg = sobel(blur1(Lg, W, H, P.coarseSigmaPx), W, H), Ca = sobel(blur1(La, W, H, P.coarseSigmaPx), W, H);
    const B = P.blockPx, S = P.searchPx;
    const nccOf = (Fg: Float32Array, Fa: Float32Array) => (x0: number, y0: number, dx: number, dy: number, step: number): number => {
        let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, n = 0;
        for (let y = y0; y < y0 + B; y += step) {
            const yy = y + dy;
            if (yy < 0 || yy >= H) continue;
            for (let x = x0; x < x0 + B; x += step) {
                const xx = x + dx;
                if (xx < 0 || xx >= W || !M[y * W + x]) continue;
                const a = Fg[y * W + x], b = Fa[yy * W + xx];
                sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b; n++;
            }
        }
        if (n < 16) return -1;
        const va = saa - (sa * sa) / n, vb = sbb - (sb * sb) / n;
        return va > 1e-9 && vb > 1e-9 ? (sab - (sa * sb) / n) / Math.sqrt(va * vb) : -1;
    };
    const coarse = nccOf(Cg, Ca), ncc = nccOf(Eg, Ea);
    let textured = 0, inPlace = 0;
    const matches: BlockMatch[] = [];
    for (let y0 = S; y0 + B + S <= H; y0 += B) for (let x0 = S; x0 + B + S <= W; x0 += B) {
        // the block's mean edge, and its edge-weighted centre: the NCC peak is the shift there, not at the block's middle
        // (with the answer rescaled, the shift varies across a block)
        let m = 0, e = 0, ex = 0, ey = 0;
        for (let y = y0; y < y0 + B; y++) for (let x = x0; x < x0 + B; x++) if (M[y * W + x]) { const g = Eg[y * W + x]; m++; e += g; ex += g * (x + 0.5); ey += g * (y + 0.5); }
        if (m < 0.7 * B * B || e / m < P.minEdge) continue;
        textured++;
        // coarse: on the blurred edges, every second shift at every second pixel; fine: on the sharp edges, around it
        let cbest = -2, cx = 0, cy = 0;
        for (let dy = -S; dy <= S; dy += 2) for (let dx = -S; dx <= S; dx += 2) { const c = coarse(x0, y0, dx, dy, 2); if (c > cbest) { cbest = c; cx = dx; cy = dy; } }
        let best = -2, bx = cx, by = cy;
        const R = P.refinePx;
        for (let dy = Math.max(-S, cy - R); dy <= Math.min(S, cy + R); dy++) for (let dx = Math.max(-S, cx - R); dx <= Math.min(S, cx + R); dx++) { const c = ncc(x0, y0, dx, dy, 1); if (c > best) { best = c; bx = dx; by = dy; } }
        if (best < P.minNcc) continue;
        // sub-pixel: a parabola through the NCC one pixel either side, on each axis
        const sub = (lo: number, hi: number) => { const den = lo - 2 * best + hi; return den < -1e-9 ? Math.max(-0.5, Math.min(0.5, (lo - hi) / (2 * den))) : 0; };
        const fx = sub(ncc(x0, y0, bx - 1, by, 1), ncc(x0, y0, bx + 1, by, 1)), fy = sub(ncc(x0, y0, bx, by - 1, 1), ncc(x0, y0, bx, by + 1, 1));
        matches.push({ x: ex / e, y: ey / e, dx: bx + fx, dy: by + fy, ncc: Math.round(best * 1000) / 1000 });
        if (Math.hypot(bx, by) <= P.inPlacePx) inPlace++;
    }
    const shifts = matches.map(m => Math.hypot(m.dx, m.dy)).sort((a, b) => a - b);
    return { textured, matched: matches.length, inPlace, medianShiftPx: shifts.length ? Math.round(shifts[shifts.length >> 1] * 10) / 10 : 0, matches };
}

function solve3(N: number[][], b: number[]): number[] {
    for (let i = 0; i < 3; i++) {
        let piv = i;
        for (let r = i + 1; r < 3; r++) if (Math.abs(N[r][i]) > Math.abs(N[piv][i])) piv = r;
        [N[i], N[piv]] = [N[piv], N[i]]; [b[i], b[piv]] = [b[piv], b[i]];
        for (let r = i + 1; r < 3; r++) { const f = N[r][i] / N[i][i]; for (let c = i; c < 3; c++) N[r][c] -= f * N[i][c]; b[r] -= f * b[i]; }
    }
    const x = [0, 0, 0];
    for (let i = 2; i >= 0; i--) { let v = b[i]; for (let c = i + 1; c < 3; c++) v -= N[i][c] * x[c]; x[i] = v / N[i][i]; }
    return x;
}

/** The affine taking given-image pixels to answer pixels, fitted to the matched blocks (Huber-reweighted least squares). */
export function fitAnswerWarp(blocks: BlockMatches, P: AnswerWarpParams = ANSWER_WARP_PARAMS): AnswerWarp {
    const m = blocks.matches;
    const matchedShare = blocks.textured ? blocks.matched / blocks.textured : 0;
    if (m.length < 6 || matchedShare < P.minMatchedShare) {
        return {
            affine: [1, 0, 0, 0, 1, 0], scale: 1, turnDeg: 0, shiftPx: 0, residualMedianPx: Infinity, inlierShare: 0, matchedShare: Math.round(matchedShare * 1000) / 1000,
            pass: false, refusal: 'answer_redrawn',
            reason: `only ${blocks.matched} of ${blocks.textured} textured blocks match the answer anywhere (at least ${Math.round(P.minMatchedShare * 100)}% and 6 blocks): the answer redrew the image`
        };
    }
    const fit = (w: number[]): AnswerWarp['affine'] => {
        const N = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], bx = [0, 0, 0], by = [0, 0, 0];
        m.forEach((p, i) => {
            const v = [p.x, p.y, 1];
            for (let r = 0; r < 3; r++) { bx[r] += w[i] * v[r] * (p.x + p.dx); by[r] += w[i] * v[r] * (p.y + p.dy); for (let c = 0; c < 3; c++) N[r][c] += w[i] * v[r] * v[c]; }
        });
        return [...solve3(N.map(r => [...r]), bx), ...solve3(N.map(r => [...r]), by)] as AnswerWarp['affine'];
    };
    const resid = (A: AnswerWarp['affine'], p: BlockMatch) => Math.hypot(A[0] * p.x + A[1] * p.y + A[2] - p.x - p.dx, A[3] * p.x + A[4] * p.y + A[5] - p.y - p.dy);
    const k = P.inlierPx * 0.75;
    let w = m.map(() => 1), A = fit(w);
    for (let it = 0; it < 6; it++) { w = m.map(p => { const e = resid(A, p); return e <= k ? 1 : k / e; }); A = fit(w); }
    const res = m.map(p => resid(A, p)).sort((a, b) => a - b);
    const residualMedianPx = res[res.length >> 1], inlierShare = res.filter(e => e <= P.inlierPx).length / res.length;
    const scale = Math.sqrt(Math.abs(A[0] * A[4] - A[1] * A[3])), turnDeg = (Math.atan2(A[3], A[0]) * 180) / Math.PI;
    const xs = m.map(p => p.x), ys = m.map(p => p.y);
    const cx = 0.5 * (Math.max(...xs) + Math.min(...xs)), cy = 0.5 * (Math.max(...ys) + Math.min(...ys));
    const shiftPx = Math.hypot(A[0] * cx + A[1] * cy + A[2] - cx, A[3] * cx + A[4] * cy + A[5] - cy);
    const out = {
        affine: A, scale: Math.round(scale * 1e4) / 1e4, turnDeg: Math.round(turnDeg * 100) / 100, shiftPx: Math.round(shiftPx * 10) / 10,
        residualMedianPx: Math.round(residualMedianPx * 100) / 100, inlierShare: Math.round(inlierShare * 1000) / 1000, matchedShare: Math.round(matchedShare * 1000) / 1000
    };
    if (residualMedianPx > P.maxResidualPx || inlierShare < P.minInlierShare) {
        return { ...out, pass: false, refusal: 'answer_parts_moved', reason: `no one warp places the answer on the image (median block residual ${residualMedianPx.toFixed(2)} px, at most ${P.maxResidualPx}; ${Math.round(inlierShare * 100)}% within ${P.inlierPx} px, at least ${Math.round(P.minInlierShare * 100)}%): the answer moved its parts apart` };
    }
    if (Math.abs(scale - 1) > P.maxScaleChange || Math.abs(turnDeg) > P.maxTurnDeg) {
        return { ...out, pass: false, refusal: 'answer_reframed', reason: `the answer is the image rescaled by ${((scale - 1) * 100).toFixed(1)}% and turned ${turnDeg.toFixed(2)} degrees (at most ${P.maxScaleChange * 100}% and ${P.maxTurnDeg} degrees): it reframed the image` };
    }
    return { ...out, pass: true, reason: `the answer is the image moved ${shiftPx.toFixed(1)} px, rescaled ${((scale - 1) * 100).toFixed(2)}% and turned ${turnDeg.toFixed(2)} degrees; warped back, its blocks sit within ${residualMedianPx.toFixed(2)} px (median)` };
}

/** The answer resampled into the given image's frame through its warp (bilinear; outside the answer, the given image's own pixel). */
export function warpAnswerToView(answer: AnswerImage, given: AnswerImage, A: AnswerWarp['affine']): AnswerImage {
    const W = given.width, H = given.height, out = new Uint8Array(W * H * 4), S = answer.rgba, AW = answer.width, AH = answer.height;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const px = x + 0.5, py = y + 0.5, u = A[0] * px + A[1] * py + A[2] - 0.5, v = A[3] * px + A[4] * py + A[5] - 0.5, o = (y * W + x) * 4;
        if (u < 0 || v < 0 || u > AW - 1 || v > AH - 1) { out.set(given.rgba.subarray(o, o + 4), o); continue; }
        const ix = u | 0, iy = v | 0, fx = u - ix, fy = v - iy, ix1 = Math.min(AW - 1, ix + 1), iy1 = Math.min(AH - 1, iy + 1);
        for (let c = 0; c < 4; c++) out[o + c] = Math.round((S[(iy * AW + ix) * 4 + c] * (1 - fx) + S[(iy * AW + ix1) * 4 + c] * fx) * (1 - fy) + (S[(iy1 * AW + ix) * 4 + c] * (1 - fx) + S[(iy1 * AW + ix1) * 4 + c] * fx) * fy);
    }
    return { width: W, height: H, rgba: out };
}

/** The three steps together: the blocks, the warp, and (when the warp passes) the answer in the given image's frame with its blocks re-matched. */
export function registerAnswer(given: AnswerImage, answer: AnswerImage, mask?: Uint8Array, P: AnswerWarpParams = ANSWER_WARP_PARAMS): { blocks: BlockMatches; warp: AnswerWarp; aligned?: AnswerImage; after?: Omit<BlockMatches, 'matches'> } {
    const blocks = matchBlocks(given, answer, mask, P);
    const warp = fitAnswerWarp(blocks, P);
    if (!warp.pass) return { blocks, warp };
    const aligned = warpAnswerToView(answer, given, warp.affine);
    const { matches: _m, ...after } = matchBlocks(given, aligned, mask, P);
    return { blocks, warp, aligned, after };
}
