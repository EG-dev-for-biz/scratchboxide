/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline E inference (d): averaged bays. A facade's grammar lattice says where its openings repeat; the tile photo of each
 * repeat is noisy (photogrammetric blur, baked shadows, a tree or a van in front). The repeats of one tier that share a size
 * are cut out as bay cells, co-registered to their median by a small shift search (normalised cross-correlation of luma),
 * and averaged robustly (per-texel median over the instances whose texel is clean). The clean exemplar is put back on each
 * instance, carrying that instance's own low-frequency colour (exemplar - blur(exemplar) + blur(instance)), so weathering
 * and light differences stay. Real pixels only: nothing is drawn, every exemplar texel is a median of photo texels.
 *
 * Verified: a group is used only when its instances agree with each other held out (each instance against the median of the
 * others, NCC at least GROUP_MIN_LOO_NCC in median); an instance that differs (a door among windows) keeps its own pixels.
 */

import { blurRgb, crop, cropMask, lumaPlane, medianOf, ncc } from './image-ops';
import type { FaceTexture } from './massing-glb';

export const GROUP_MIN_INSTANCES = 3;
export const GROUP_MIN_LOO_NCC = 0.4;
export const INSTANCE_MIN_LOO_NCC = 0.25;
/** Openings of a tier within this relative size of the tier's median one form a group. */
export const SIZE_TOLERANCE = 0.15;

/** A rectangle in texture pixels (x right, y down). */
export interface PixRect { x0: number; y0: number; w: number; h: number }

export interface BayGroupReport {
    instances: number;
    replaced: number;
    rejectedInstances: number;
    looNccMedian: number | null;
    accepted: boolean;
    why: string;
}

export interface BayAverageResult { groups: BayGroupReport[]; texelsReplaced: number }

/**
 * Bay cells of a lattice: per group (a tier's openings of one size), each opening grown by a margin into its bay, as pixel
 * rectangles of one common size centred on the openings.
 */
export function bayGroups(openings: Array<Array<{ x0: number; x1: number; y0: number; y1: number }>>): PixRect[][] {
    const groups: PixRect[][] = [];
    for (const tier of openings) {
        if (tier.length < GROUP_MIN_INSTANCES) continue;
        const ws = tier.map(o => o.x1 - o.x0), hs = tier.map(o => o.y1 - o.y0);
        const mw = medianOf(ws), mh = medianOf(hs);
        const members = tier.filter(o => Math.abs(o.x1 - o.x0 - mw) <= SIZE_TOLERANCE * mw && Math.abs(o.y1 - o.y0 - mh) <= SIZE_TOLERANCE * mh).sort((a, b) => a.x0 - b.x0);
        if (members.length < GROUP_MIN_INSTANCES) continue;
        // the margin: half the smallest gap between neighbours (the pier between bays), at most half the opening's width
        let gap = Infinity;
        for (let i = 1; i < members.length; i++) gap = Math.min(gap, members[i].x0 - members[i - 1].x1);
        const mx = Math.max(1, Math.min(Number.isFinite(gap) ? gap / 2 : mw / 2, mw / 2)), my = Math.max(1, 0.3 * mh);
        const w = Math.round(mw + 2 * mx), h = Math.round(mh + 2 * my);
        groups.push(members.map(o => ({ x0: Math.round((o.x0 + o.x1) / 2 - w / 2), y0: Math.round((o.y0 + o.y1) / 2 - h / 2), w, h })));
    }
    return groups;
}

/** Per-texel median of the instances (each a crop list per channel) over their clean texels; NaN with fewer than 2. */
function medianStack(stack: Float32Array[], masks: Uint8Array[], skip = -1): Float32Array {
    const n = stack[0].length, out = new Float32Array(n);
    const buf: number[] = [];
    for (let i = 0; i < n; i++) {
        buf.length = 0;
        for (let k = 0; k < stack.length; k++) if (k !== skip && masks[k][i] && Number.isFinite(stack[k][i])) buf.push(stack[k][i]);
        out[i] = buf.length >= 2 ? medianOf(buf) : NaN;
    }
    return out;
}

/**
 * Averages the bays of `groups` on texture `t` in place. `clean` marks texels that are real photo (not occluded, covered);
 * replaced texels get `source` (the legend index of the averaged bays). Returns the per-group record.
 */
export function averageBays(t: FaceTexture, groups: PixRect[][], clean: Uint8Array, source: number, opts: { shiftPx?: number; lowFreqPx?: number } = {}): BayAverageResult {
    const W = t.width, H = t.height;
    const L = lumaPlane(t.rgba, W, H);
    const R = opts.shiftPx ?? 4;
    const reports: BayGroupReport[] = [];
    let texelsReplaced = 0;
    for (const g of groups) {
        const w = g[0].w, h = g[0].h;
        const inside = g.filter(r => r.x0 >= -R && r.y0 >= -R && r.x0 + w <= W + R && r.y0 + h <= H + R);
        if (inside.length < GROUP_MIN_INSTANCES) { reports.push({ instances: g.length, replaced: 0, rejectedInstances: 0, looNccMedian: null, accepted: false, why: 'fewer than 3 bays inside the texture' }); continue; }
        // co-registration: each instance shifted to best match the group's median (two rounds)
        const shift = inside.map(() => [0, 0]);
        const lumaOf = (k: number) => crop(L, W, H, inside[k].x0 + shift[k][0], inside[k].y0 + shift[k][1], w, h);
        const maskOf = (k: number) => cropMask(clean, W, H, inside[k].x0 + shift[k][0], inside[k].y0 + shift[k][1], w, h);
        for (let round = 0; round < 2; round++) {
            const ref = medianStack(inside.map((_, k) => lumaOf(k)), inside.map((_, k) => maskOf(k)));
            const refUse = new Uint8Array(ref.length);
            for (let i = 0; i < ref.length; i++) refUse[i] = Number.isFinite(ref[i]) ? 1 : 0;
            inside.forEach((r, k) => {
                let best = -2, bx = shift[k][0], by = shift[k][1];
                for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
                    const c = ncc(crop(L, W, H, r.x0 + dx, r.y0 + dy, w, h), ref, cropMask(clean, W, H, r.x0 + dx, r.y0 + dy, w, h), refUse);
                    if (c !== null && c > best + 1e-6) { best = c; bx = dx; by = dy; }
                }
                shift[k] = [bx, by];
            });
        }
        const lum = inside.map((_, k) => lumaOf(k)), msk = inside.map((_, k) => maskOf(k));
        // held out: each instance against the median of the others
        const loo = inside.map((_, k) => {
            const others = medianStack(lum, msk, k);
            const use = new Uint8Array(others.length);
            for (let i = 0; i < use.length; i++) use[i] = Number.isFinite(others[i]) ? 1 : 0;
            return ncc(lum[k], others, msk[k], use);
        });
        const looVals = loo.filter((v, k): v is number => v !== null && msk[k].reduce((a, b) => a + b, 0) >= 0.5 * msk[k].length);
        const looMed = looVals.length ? medianOf(looVals) : null;
        if (looMed === null || looMed < GROUP_MIN_LOO_NCC) {
            reports.push({ instances: inside.length, replaced: 0, rejectedInstances: inside.length, looNccMedian: looMed, accepted: false, why: `the bays do not repeat held out (median NCC ${looMed === null ? 'n/a' : looMed.toFixed(2)} < ${GROUP_MIN_LOO_NCC})` });
            continue;
        }
        // the exemplar: per channel, the median over clean instance texels
        const chans = [0, 1, 2].map(c => {
            const plane = new Float32Array(W * H);
            for (let i = 0; i < W * H; i++) plane[i] = t.rgba[i * 4 + c];
            return inside.map((r, k) => crop(plane, W, H, r.x0 + shift[k][0], r.y0 + shift[k][1], w, h));
        });
        const ex = chans.map(st => medianStack(st, msk));
        const exUse = new Uint8Array(w * h);
        const exRgba = new Uint8Array(w * h * 4);
        for (let i = 0; i < w * h; i++) {
            exUse[i] = Number.isFinite(ex[0][i]) && Number.isFinite(ex[1][i]) && Number.isFinite(ex[2][i]) ? 1 : 0;
            for (let c = 0; c < 3; c++) exRgba[i * 4 + c] = exUse[i] ? Math.round(ex[c][i]) : 0;
        }
        const lf = opts.lowFreqPx ?? Math.max(3, Math.round(Math.min(w, h) / 3));
        const exLow = blurRgb(exRgba, exUse, w, h, lf);
        let replaced = 0, rejected = 0;
        const cleanShare = msk.map(m => m.reduce((a, b) => a + b, 0) / m.length);
        inside.forEach((r, k) => {
            // a bay mostly hidden (an occluder over it) cannot disagree: it takes the exemplar; one whose visible part differs keeps its pixels
            const hidden = cleanShare[k] < 0.5;
            if (!hidden && (loo[k] === null || loo[k]! < INSTANCE_MIN_LOO_NCC)) { rejected++; return; }
            replaced++;
            const x0 = r.x0 + shift[k][0], y0 = r.y0 + shift[k][1];
            const instRgba = new Uint8Array(w * h * 4);
            for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
                const xx = x0 + x, yy = y0 + y;
                if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
                instRgba.set(t.rgba.subarray((yy * W + xx) * 4, (yy * W + xx) * 4 + 4), (y * w + x) * 4);
            }
            const instLow = hidden ? exLow : blurRgb(instRgba, msk[k], w, h, lf);
            const feather = Math.max(2, Math.round(Math.min(w, h) / 10));
            for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
                const i = y * w + x;
                const xx = x0 + x, yy = y0 + y;
                if (xx < 0 || yy < 0 || xx >= W || yy >= H || !exUse[i]) continue;
                const edge = Math.min(x + 1, y + 1, w - x, h - y);
                const a = Math.min(1, edge / feather);
                const j = yy * W + xx;
                // an occluded texel takes the exemplar fully; a clean one blends in towards the cell's centre
                const alpha = clean[j] ? a : 1;
                for (let c = 0; c < 3; c++) {
                    const low = Number.isFinite(instLow[c][i]) ? instLow[c][i] : exLow[c][i];
                    const v = ex[c][i] - exLow[c][i] + low;
                    t.rgba[j * 4 + c] = Math.max(0, Math.min(255, Math.round(alpha * v + (1 - alpha) * t.rgba[j * 4 + c])));
                }
                t.rgba[j * 4 + 3] = 255;
                if (alpha >= 0.5) { t.source[j] = source; texelsReplaced++; }
            }
        });
        reports.push({ instances: inside.length, replaced, rejectedInstances: rejected, looNccMedian: Math.round(looMed * 1000) / 1000, accepted: replaced > 0, why: `median held-out NCC ${looMed.toFixed(2)}; ${replaced} bays replaced, ${rejected} differ and keep their own pixels` });
    }
    return { groups: reports, texelsReplaced };
}
