/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The native wall grammar (scratchbox_wall_grammar.hpp, SCRATCHBOX_K_NATIVE's `wall-grammar`) against wall-grammar.ts
 * on a small synthetic building: a front wall of two overlapping facades (bays across mullions broken by a stone band,
 * a stack of punched windows, a span the photo never reached by its mask and one by its grey, an occluded patch), a
 * plain side wall and a set-back upper tier, with the window fit's windows at fractional texels. Both write the same
 * wall_grammar.json, byte for byte. The binary is compiled with the real clang++; nothing here reaches a network or a
 * credential.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readWallGrammar, WALL_GRAMMAR_FILE, type GrammarFacade } from '../src/node/3d-engine/staged-location/wall-grammar';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';
import { ensureRemeshPolishBinary } from '../src/node/3d-engine/staged-location/remesh-polish-native';
import { decodePng } from '../src/node/texture-processing';

const PX = 0.1;
type V3 = [number, number, number];
const facadeOf = (facadeId: number, centroid: V3, normal: V3, axisS: V3, width: number, height: number): GrammarFacade => ({
    facadeId, image: `f${facadeId}.png`, centroid, normal, axisS, axisT: [0, 1, 0], sMin: -width / 2, sMax: width / 2, tMin: -height / 2, tMax: height / 2,
    pixel: PX, width: Math.round(width / PX), height: Math.round(height / PX), orthoSMin: -width / 2, orthoTMax: height / 2
});

/** Paints a facade from (u, v) along and up it (m from its lower left), and gives its windows in texels at fractional edges. */
function paint(dir: string, f: GrammarFacade, look: (u: number, v: number) => number[], windows: Array<[number, number, number, number]>, masks: { uncovered?: (u: number, v: number) => boolean; occluded?: (u: number, v: number) => boolean } = {}) {
    const { width: W, height: H } = f, rgba = new Uint8Array(W * H * 4), unc = new Uint8Array(W * H), occ = new Uint8Array(W * H);
    let seed = f.facadeId * 7919 + 1;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const u = (x + 0.5) * PX, v = (H - y - 0.5) * PX, k = y * W + x, n = Math.floor(rnd() * 10);
        const c = look(u, v);
        rgba.set(c.length === 4 ? c : [c[0] + n, c[1] + n, c[2] + n, 255], k * 4);
        if (masks.uncovered?.(u, v)) unc[k] = 255;
        // either side of the threshold (OCCLUSION_PARAMS.minBlocked, 166 of 255)
        occ[k] = masks.occluded?.(u, v) ? 166 + (n % 3) : 165 - n * 10;
    }
    fs.writeFileSync(path.join(dir, f.image), encodePng(W, H, rgba, 4));
    if (masks.uncovered) { f.uncoveredMask = `f${f.facadeId}_uncovered.png`; fs.writeFileSync(path.join(dir, f.uncoveredMask), encodePng(W, H, unc, 1)); }
    if (masks.occluded) { f.occludedMask = `f${f.facadeId}_occluded.png`; fs.writeFileSync(path.join(dir, f.occludedMask), encodePng(W, H, occ, 1)); }
    // (u0, v0, u1, v1) in metres to texels, nudged off the grid
    return { facadeId: f.facadeId, width: W, height: H, rects: windows.map(([u0, v0, u1, v1]) => [u0 / PX + 0.3, H - v1 / PX + 0.6, u1 / PX - 0.2, H - v0 / PX - 0.45] as [number, number, number, number]), bands: [], ms: 0 };
}

const STONE = [196, 184, 166], BAND = [188, 176, 160], GLASS = [46, 58, 80], SPANDREL = [70, 64, 60];

describe('wall grammar: native against TypeScript', () => {
    let dir = '', fit: any;
    beforeAll(async () => {
        await ensureRemeshPolishBinary();
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wall-grammar-native-'));
        // the front, two facades 0.3 m apart along one wall: s -20..20 and 15..35 (world x), 30 m tall
        const f1 = facadeOf(1, [0, 15, 0], [0, 0, 1], [1, 0, 0], 40, 30), f2 = facadeOf(2, [25, 15, 0.3], [0, 0, 1], [1, 0, 0], 20, 30);
        // bays 4 m wide every 6 m, two window columns across a mullion, a stone band at 14-17 m; f1's photo never reached u > 34
        const bay = (u: number) => u % 6 >= 1 && u % 6 < 5, mullion = (u: number) => u % 6 >= 2.7 && u % 6 < 3.3, band = (v: number) => v >= 14 && v < 17;
        const bayWindows = (uMax: number) => {
            const out: Array<[number, number, number, number]> = [];
            for (let c = 0; c * 6 + 5 <= uMax; c++) for (const [a, b] of [[1, 2.7], [3.3, 5]]) for (const [v0, v1] of [[1, 14], [17, 29]]) out.push([c * 6 + a, v0, c * 6 + b, v1]);
            return out;
        };
        const w1 = paint(dir, f1, (u, v) => (bay(u) && !band(v) ? (mullion(u) ? SPANDREL : GLASS) : band(v) ? BAND : STONE), bayWindows(34), { uncovered: u => u > 34, occluded: (u, v) => u > 8 && u < 11 && v > 20 && v < 26 });
        // f2 (world x 15..35, its u 0..20; the pattern keeps the wall's 6 m pitch, bays at its u 2-6 and 8-12): the bays carried
        // on, then a stack of punched windows at its u 12-14 in stone, one a storey, and from u 14 the uncovered grey, wide
        // enough to hold the next bay whole (u 14-18, generated)
        const w2 = paint(dir, f2, (u, v) => {
            if (u > 14) return [128, 128, 128, 255];
            const x = u + 35;
            if (u >= 12 && u < 14) return v % 3 >= 0.8 && v % 3 < 2.4 ? GLASS : STONE;
            return bay(x) && !band(v) && x < 47 ? (mullion(x) ? SPANDREL : GLASS) : band(v) ? BAND : STONE;
        }, [...Array.from({ length: 9 }, (_, i) => [12, i * 3 + 0.8, 14, i * 3 + 2.4] as [number, number, number, number]), ...[[2, 3.7], [4.3, 6], [8, 9.7], [10.3, 12]].flatMap(([a, b]) => [[a, 1, b, 14], [a, 17, b, 29]] as Array<[number, number, number, number]>)]);
        // the side wall: plain stone with one small window, fully photographed
        const f3 = facadeOf(3, [35, 15, -6], [1, 0, 0], [0, 0, -1], 12, 30);
        const w3 = paint(dir, f3, (u, v) => (u > 5 && u < 6 && v > 10 && v < 11.5 ? GLASS : STONE), [[5, 10, 6, 11.5]]);
        // the upper tier, set back 5 m: bays 3 m wide every 5 m, an occluded patch over one
        const f4 = facadeOf(4, [0, 45, -5], [0, 0, 1], [1, 0, 0], 26, 30);
        const upper: Array<[number, number, number, number]> = [];
        for (let c = 0; c * 5 + 4 <= 26; c++) upper.push([c * 5 + 1, 1, c * 5 + 4, 28]);
        const w4 = paint(dir, f4, (u, v) => (u % 5 >= 1 && u % 5 < 4 && v >= 1 && v < 28 ? GLASS : STONE), upper, { occluded: (u, v) => u > 11 && u < 14 && v > 5 && v < 20 });
        fs.writeFileSync(path.join(dir, 'facades.json'), JSON.stringify({ facades: [f1, f2, f3, f4] }));
        fit = { version: 'test', params: {}, ms: 0, facades: [w1, w2, w3, w4, { facadeId: 9, error: 'no photo' }] };
    }, 900_000);

    it('reads the same walls, bays, columns and tier grammars, and writes the same file', () => {
        const dec = (b: Buffer) => { const d = decodePng(b); return { rgba: d.rgba, width: d.width, height: d.height }; };
        const run = (mode: '0' | '1') => {
            const was = process.env.SCRATCHBOX_K_NATIVE;
            process.env.SCRATCHBOX_K_NATIVE = mode;
            try { const t0 = performance.now(); const r = readWallGrammar(dir, fit, dec); return { r, file: fs.readFileSync(path.join(dir, WALL_GRAMMAR_FILE), 'utf8'), ms: performance.now() - t0 }; }
            finally { if (was === undefined) delete process.env.SCRATCHBOX_K_NATIVE; else process.env.SCRATCHBOX_K_NATIVE = was; }
        };
        const ts = run('0'), nat = run('1');
        // the cases are there: the front one wall of two facades, read and continued bays, two tiers with a grammar
        const g = ts.r.grammar;
        expect(g.walls.map(w => w.facades)).toEqual([[1, 2], [3], [4]]);
        const front = g.walls[0];
        expect(front.bays.some(b => b.from === 'photo-inferred')).toBe(true);
        expect(front.bays.some(b => b.from === 'generated')).toBe(true);
        expect((g.tiers ?? []).length).toBeGreaterThan(0);
        expect(nat.r.grammar).toEqual(g);
        expect(nat.file).toBe(ts.file);
        console.log(`wall grammar, 3 walls of 4 facades (400 x 300 texels the largest), ${g.walls.reduce((a, w) => a + w.bays.length, 0)} bays: TypeScript ${ts.ms.toFixed(0)} ms, native ${nat.ms.toFixed(0)} ms`);
    }, 300_000);
});
