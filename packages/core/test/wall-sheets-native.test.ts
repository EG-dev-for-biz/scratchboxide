/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The native wall sheets (scratchbox_wall_sheets.hpp, SCRATCHBOX_K_NATIVE's `wall-sheets`) against wall-sheets.ts on two
 * synthetic walls: one of three facades (a file mask, a grey-filled span, an occluded patch where another member saw the
 * wall clear, an occlusion mask of the wrong size ignored, a gap no member saw that the repeats and the smooth fill close)
 * and one of two at a different texel. Both write the same files byte for byte (the photo, its uncovered and occluded
 * masks, walls.json) and return the same sheets. The binary is compiled with the real clang++; nothing here reaches a
 * network or a credential.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildWallSheets, WALLS_FILE } from '../src/node/3d-engine/staged-location/wall-sheets';
import type { ReliefFacade } from '../src/node/3d-engine/staged-location/facade-lattice';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';
import { ensureRemeshPolishBinary } from '../src/node/3d-engine/staged-location/remesh-polish-native';
import { decodePng } from '../src/node/texture-processing';

type V3 = [number, number, number];
const facadeOf = (facadeId: number, centroid: V3, width: number, height: number, pixel: number, coverage: number): ReliefFacade => ({
    facadeId, image: `f${facadeId}.png`, centroid, normal: [0, 0, 1], axisS: [1, 0, 0], axisT: [0, 1, 0], sMin: -width / 2, sMax: width / 2, tMin: -height / 2, tMax: height / 2,
    pixel, width: Math.round(width / pixel), height: Math.round(height / pixel), orthoSMin: -width / 2, orthoTMax: height / 2, coverage
});

/** A facade photo of a wall with windows every 3 m along it (world x) and up it: `hole` grey, `transparent` alpha 0. */
function paint(dir: string, f: ReliefFacade, opts: { hole?: (x: number, y: number) => boolean; transparent?: (x: number, y: number) => boolean; mask?: (x: number, y: number) => boolean; occluded?: (x: number, y: number) => boolean; occludedSize?: number } = {}) {
    const { width: W, height: H, pixel } = f, rgba = new Uint8Array(W * H * 4), unc = new Uint8Array(W * H);
    let seed = f.facadeId * 101 + 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const wx = f.centroid[0] + f.sMin + (x + 0.5) * pixel, wy = f.centroid[1] + f.tMax - (y + 0.5) * pixel, k = y * W + x, n = Math.floor(rnd() * 14);
        const glass = ((wx % 3) + 3) % 3 > 1 && ((wx % 3) + 3) % 3 < 2.2 && wy % 3 > 0.8 && wy % 3 < 2.4;
        rgba.set(glass ? [40 + n, 52 + n, 75 + n, 255] : [190 + n - f.facadeId * 6, 176 + n, 150 + n, 255], k * 4);
        if (opts.hole?.(wx, wy)) rgba.set([128, 128, 128, 255], k * 4);
        if (opts.transparent?.(wx, wy)) rgba[k * 4 + 3] = 0;
        if (opts.mask?.(wx, wy)) { unc[k] = 255; rgba.set([150, 140, 130, 255], k * 4); }
    }
    fs.writeFileSync(path.join(dir, f.image), encodePng(W, H, rgba, 4));
    if (opts.mask) { f.uncoveredMask = `f${f.facadeId}_uncovered.png`; fs.writeFileSync(path.join(dir, f.uncoveredMask), encodePng(W, H, unc, 1)); }
    if (opts.occluded) {
        const Wo = opts.occludedSize ?? W, Ho = opts.occludedSize ?? H, occ = new Uint8Array(Wo * Ho);
        for (let y = 0; y < Ho; y++) for (let x = 0; x < Wo; x++) {
            const wx = f.centroid[0] + f.sMin + (x + 0.5) * pixel, wy = f.centroid[1] + f.tMax - (y + 0.5) * pixel;
            // either side of the threshold (OCCLUSION_PARAMS.minBlocked, 166 of 255)
            occ[y * Wo + x] = opts.occluded(wx, wy) ? 166 + ((x + y) % 3) : 165 - ((x * 7 + y) % 90);
        }
        f.occludedMask = `f${f.facadeId}_occluded.png`;
        fs.writeFileSync(path.join(dir, f.occludedMask), encodePng(Wo, Ho, occ, 1));
    }
}

describe('wall sheets: native against TypeScript', () => {
    let dir = '';
    const grammar: any = { version: 'test', params: {}, tiers: [], facades: {}, walls: [] };
    const fit: any = { version: 'test', params: {}, ms: 0, facades: [] };
    beforeAll(async () => {
        await ensureRemeshPolishBinary();
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wall-sheets-native-'));
        // wall 3: x -12..12 seen by three facades 0.1 to 0.4 m apart; nothing saw x 1..3 above y 9 (a gap to fill)
        const a = facadeOf(1, [-6, 7.5, 0], 12, 15, 0.1, 0.9), b = facadeOf(2, [4, 7.5, 0.25], 12, 15, 0.1, 0.95), c = facadeOf(3, [7, 7.5, -0.15], 10, 15, 0.1, 0.6);
        paint(dir, a, { mask: (x, y) => x > -1 && y > 9, occluded: (x, y) => x > -6 && x < -3 && y > 3 && y < 7 });
        paint(dir, b, { hole: (x, y) => x < 3 && y > 9, transparent: (x, y) => x > 9 && y < 2 });
        paint(dir, c, { occluded: () => false, occludedSize: 40 });
        // wall 8: two facades at 0.08 and 0.12 m, the finer one's texel the sheet's
        const d = facadeOf(4, [30, 6, 5], 10, 12, 0.08, 0.8), e = facadeOf(5, [37, 6, 5.3], 8, 12, 0.12, 0.7);
        paint(dir, d, { occluded: (x, y) => x > 33 && y < 4 });
        paint(dir, e, { mask: (x, y) => x > 39 });
        // a lone facade's wall makes no sheet
        const g = facadeOf(6, [60, 6, 0], 8, 12, 0.1, 1);
        paint(dir, g);
        fs.writeFileSync(path.join(dir, 'facades.json'), JSON.stringify({ facades: [a, b, c, d, e, g] }));
        const bays = (u0: number, n: number) => Array.from({ length: n }, (_, i) => ({ u0: u0 + i * 3 + 1, u1: u0 + i * 3 + 2.2, y0: 0.8, y1: 13.4, from: i % 2 ? 'generated' : 'photo-inferred' }));
        grammar.walls = [
            { wallId: 3, facades: [1, 2, 3], normal: [0, 0, 1], axisU: [1, 0, 0], offset: 0, u0: -12, u1: 12, y0: 0, y1: 15, coverage: 0.9, tier: 0, bays: bays(-12, 8) },
            { wallId: 8, facades: [4, 5], normal: [0, 0, 1], axisU: [1, 0, 0], offset: 5, u0: 25, u1: 41, y0: 0, y1: 12, coverage: 0.8, tier: 1, bays: bays(25, 5) },
            { wallId: 9, facades: [6], normal: [0, 0, 1], axisU: [1, 0, 0], offset: 0, u0: 56, u1: 64, y0: 0, y1: 12, coverage: 1, tier: 1, bays: [] }
        ];
        const win = (f: ReliefFacade, i: number) => [i * 30 + 10.4, 20.2, i * 30 + 22.6, 60.7] as [number, number, number, number];
        fit.facades = [1, 2, 4].map(id => ({ facadeId: id, width: 120, height: 150, rects: [0, 1, 2].map(i => win(a, i)), panes: [0, 1].map(i => win(a, i)), bands: [], ms: 0 }));
    }, 900_000);

    it('lays the same sheets and writes the same files', () => {
        const dec = (bytes: Buffer) => { const d = decodePng(bytes); return { rgba: d.rgba, width: d.width, height: d.height }; };
        const run = (mode: '0' | '1') => {
            const was = process.env.SCRATCHBOX_K_NATIVE;
            process.env.SCRATCHBOX_K_NATIVE = mode;
            try {
                const t0 = performance.now();
                const r = buildWallSheets(dir, grammar, fit, dec);
                const ms = performance.now() - t0;
                const files = Object.fromEntries(fs.readdirSync(dir).filter(f => f.startsWith('wall_') || f === WALLS_FILE).sort().map(f => [f, fs.readFileSync(path.join(dir, f))]));
                for (const f of Object.keys(files)) fs.rmSync(path.join(dir, f));
                return { r, files, ms };
            } finally { if (was === undefined) delete process.env.SCRATCHBOX_K_NATIVE; else process.env.SCRATCHBOX_K_NATIVE = was; }
        };
        const ts = run('0'), nat = run('1');
        // the cases are there: two sheets, a fill from repeats or the smooth fill, an occluded mask, carried windows and bays
        expect(ts.r.sheets.map(s => s.wallId)).toEqual([3, 8]);
        expect(ts.r.sheets[0].facade.textureFill!.texels).toBeGreaterThan(0);
        expect(Object.keys(ts.files)).toContain('wall_3_occluded.png');
        expect(ts.r.sheets[0].windows.length).toBeGreaterThan(0);
        expect(ts.r.sheets[1].bays.length).toBeGreaterThan(0);
        expect(Object.keys(nat.files)).toEqual(Object.keys(ts.files));
        for (const f of Object.keys(ts.files)) expect(Buffer.compare(nat.files[f], ts.files[f]), f).toBe(0);
        expect(nat.r.sheets).toEqual(ts.r.sheets);
        const texels = ts.r.sheets.reduce((s, x) => s + x.facade.width * x.facade.height, 0);
        console.log(`wall sheets, ${ts.r.sheets.length} sheets (${texels} texels), ${Object.keys(ts.files).length} files: TypeScript ${ts.ms.toFixed(0)} ms, native ${nat.ms.toFixed(0)} ms`);
    }, 300_000);
});
