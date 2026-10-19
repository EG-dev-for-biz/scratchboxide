/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A simulated facade-grammar reader for tests (no model call): given the true openings of a facade (plane s, t metres),
 * it answers the facade-grammar prompt about an orthophoto image the way a careful reader would: the openings whose
 * centre and corners the image shows (never a greyed-out part), in the image's per-mille, a few per-mille off
 * (deterministic), optionally with every tier moved (a wrong reading). The image's place in the full ortho is found by
 * its pixels; the reader is told nothing else.
 */

import { decodeImageInMemory } from '../../src/node/3d-engine/staged-location/tile-texture-transfer';
import type { ReliefOrthoFacade } from '../../src/node/3d-engine/staged-location/facade-grammar';

export interface TrueOpening { s0: number; s1: number; t0: number; t1: number }

/** The reply text for one image (the PNG the reading was sent). */
export function simulatedReply(f: ReliefOrthoFacade, fullPng: Buffer, png: Buffer, truth: TrueOpening[], opts: { tierShiftM?: number } = {}): string {
    const full = decodeImageInMemory(fullPng), img = decodeImageInMemory(png);
    let x0 = -1, y0 = -1;
    const isGrey = (a: Uint8Array, i: number) => a[i] === 128 && a[i + 1] === 128 && a[i + 2] === 128;
    const same = (ox: number, oy: number) => {
        for (let y = 0; y < img.height; y += 7) for (let x = 0; x < img.width; x += 13) {
            const i = (y * img.width + x) * 4;
            if (isGrey(img.rgba, i)) continue;
            for (let c = 0; c < 3; c++) if (img.rgba[i + c] !== full.rgba[((y + oy) * full.width + x + ox) * 4 + c]) return false;
        }
        return true;
    };
    if (img.height === full.height) { for (let off = 0; off + img.width <= full.width && x0 < 0; off++) if (same(off, 0)) { x0 = off; y0 = 0; } }
    else if (img.width === full.width) { for (let off = 0; off + img.height <= full.height && y0 < 0; off++) if (same(0, off)) { x0 = 0; y0 = off; } }
    if (x0 < 0 || y0 < 0) throw new Error('the simulated reader could not place the image');
    const sMin = f.orthoSMin + x0 * f.pixel, sMax = sMin + img.width * f.pixel, tMax = f.orthoTMax - y0 * f.pixel, H = img.height * f.pixel;
    const greyAt = (s: number, t: number) => {
        const x = Math.min(img.width - 1, Math.max(0, Math.floor(((s - sMin) / (sMax - sMin)) * img.width))), y = Math.min(img.height - 1, Math.max(0, Math.floor(((tMax - t) / H) * img.height)));
        return isGrey(img.rgba, (y * img.width + x) * 4);
    };
    const tiers = new Map<number, Array<[number, number]>>(), bands = new Map<number, [number, number]>();
    let k = 0;
    for (const o of truth) {
        const s0 = o.s0, s1 = o.s1, t0 = o.t0 + (opts.tierShiftM ?? 0), t1 = o.t1 + (opts.tierShiftM ?? 0);
        const sc = 0.5 * (s0 + s1), tc = 0.5 * (t0 + t1);
        if (sc < sMin || sc > sMax || tc > tMax || tc < tMax - H) continue;
        if ([[sc, tc], [s0, t0], [s1, t0], [s0, t1], [s1, t1]].some(([a, b]) => greyAt(a, b))) continue;
        const j = ((k++ * 5) % 7) - 3;  // -3..3 per-mille
        const key = Math.round(t0 * 10);
        bands.set(key, [Math.max(0, ((tMax - t1) / H) * 1000 + j), Math.min(1000, ((tMax - t0) / H) * 1000 - j)]);
        const cols = tiers.get(key) ?? [];
        cols.push([Math.max(0, ((s0 - sMin) / (sMax - sMin)) * 1000 - j), Math.min(1000, ((s1 - sMin) / (sMax - sMin)) * 1000 + j)]);
        tiers.set(key, cols);
    }
    return JSON.stringify({ tiers: [...tiers.keys()].sort((a, b) => b - a).map(key => ({ y: bands.get(key)!.map(v => Math.round(v)), cols: tiers.get(key)!.map(c => c.map(v => Math.round(v))) })), conf: 80, notes: 'simulated' });
}

/** The image a facade-grammar call was sent. */
export const promptImage = (params: any): Buffer => Buffer.from(params.contents[0].parts.find((p: any) => p.inlineData).inlineData.data, 'base64');
