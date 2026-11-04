/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The wall grammar (wall-grammar.ts): facades of one plane grouped into a wall; a wall's bays read from its evidence
 * (columns where windows stand, joined across mullions; heights from the photo's luminance; an unread span continuing the
 * wall's rhythm, generated); and the lattice drawing the grammar's bays as its strips.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { groupWalls, readWallBays, type GrammarFacade, type WallEvidence } from '../src/node/3d-engine/staged-location/wall-grammar';
import { facadeSamples, latticeFacade, type ReliefFacade } from '../src/node/3d-engine/staged-location/facade-lattice';
import { buildWallSheets, SHEET_ID_BASE } from '../src/node/3d-engine/staged-location/wall-sheets';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';
import { decodePng } from '../src/node/texture-processing';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ensureRemeshPolishBinary } from '../src/node/3d-engine/staged-location/remesh-polish-native';

// the wall sheets run natively by default (SCRATCHBOX_K_NATIVE): their binary built once for the file
beforeAll(async () => { await ensureRemeshPolishBinary(); }, 900_000);

const facade = (facadeId: number, cx: number, z: number, width: number, y0: number, y1: number): GrammarFacade => ({
    facadeId, image: `f${facadeId}.png`, centroid: [cx, (y0 + y1) / 2, z], normal: [0, 0, 1], axisS: [1, 0, 0], axisT: [0, 1, 0],
    sMin: -width / 2, sMax: width / 2, tMin: -(y1 - y0) / 2, tMax: (y1 - y0) / 2, pixel: 0.1, width: width * 10, height: (y1 - y0) * 10, orthoSMin: -width / 2, orthoTMax: (y1 - y0) / 2
});

describe('the wall grammar', () => {
    it('joins facades of one plane that overlap or touch into a wall, and keeps a parallel wall 3 m behind apart', () => {
        const walls = groupWalls([facade(1, 0, 0, 20, 0, 50), facade(2, 15, 0.3, 14, 20, 60), facade(3, 0, -3, 20, 0, 50), facade(4, 60, 0, 10, 0, 50)]);
        const sets = walls.map(w => w.sort()).sort((a, b) => a[0] - b[0]);
        expect(sets).toEqual([[0, 1], [2], [3]]);
    });

    it('reads bays from columns of windows across mullions, continues the rhythm over an unread span, and breaks a bay at a stone band', () => {
        // a 40 m x 30 m wall at 0.1 m: bays 4 m wide every 6 m (two window columns 1.6 m wide, a 0.8 m mullion... joined), piers 2 m;
        // a stone band at y 14-17 m; the photo never reached u 26-40 m
        const cellM = 0.1, nu = 400, ny = 300;
        const covered = new Uint8Array(nu * ny), window = new Uint8Array(nu * ny), lum = new Float32Array(nu * ny).fill(NaN);
        for (let y = 0; y < ny; y++) for (let x = 0; x < nu; x++) {
            const u = x * cellM, yy = y * cellM, k = y * nu + x;
            if (u >= 26) continue;
            covered[k] = 1;
            const inBay = u % 6 >= 1 && u % 6 < 5, band = yy >= 14 && yy < 17, mullion = u % 6 >= 2.7 && u % 6 < 3.3;
            lum[k] = inBay && !band ? 60 : 190;
            // the window fit reads each bay as one strip, spandrels and all (a stack of punched windows is the test below)
            if (inBay && !band && !mullion) window[k] = 1;
        }
        const e: WallEvidence = { u0: 0, y0: 0, nu, ny, cellM, covered, window, lum };
        const { bays } = readWallBays(e);
        const read = bays.filter(b => b.from === 'photo-inferred'), gen = bays.filter(b => b.from === 'generated');
        // bays at u 1-5, 7-11, 13-17, 19-23 (the one at 25 cut by the photo's edge), each split at the band into two runs
        const cols = [...new Set(read.map(b => Math.round(b.u0)))].sort((a, b) => a - b);
        expect(cols.slice(0, 4)).toEqual([1, 7, 13, 19]);
        for (const b of read.filter(x => x.u0 < 24)) {
            expect(b.u1 - b.u0).toBeGreaterThan(3.6);
            expect(b.u1 - b.u0).toBeLessThan(4.4);
            expect(b.y1 <= 14.1 || b.y0 >= 16.9).toBe(true);
        }
        // the unread span u 26-40: the rhythm continues (generated), in phase: the one whole bay it holds, u 31-35
        const gu = [...new Set(gen.map(b => Math.round(b.u0)))].sort((a, b) => a - b);
        expect(gu).toEqual([31]);
        expect(gen.every(b => b.u1 <= 40)).toBe(true);
    });

    it("draws the lattice on the grammar's bays, recessed, even where the facade's own windows were not fitted", () => {
        const PX = 0.1, W = 120, H = 90;
        const f: ReliefFacade = { facadeId: 7, image: 'f.png', centroid: [0, 0, 0], normal: [0, 0, 1], axisS: [1, 0, 0], axisT: [0, 1, 0], sMin: 0, sMax: 12, tMin: 0, tMax: 9, pixel: PX, width: W, height: H, orthoSMin: 0, orthoTMax: 9, coverage: 1 };
        const rgba = new Uint8Array(W * H * 4);
        for (let k = 0; k < W * H; k++) rgba.set([190, 180, 170, 255], k * 4);
        const soup: number[] = [];
        for (let s = 0; s < 12; s += 0.25) for (let t = 0; t < 9; t += 0.25) soup.push(s, t, 0, s + 0.25, t, 0, s + 0.25, t + 0.25, 0, s, t, 0, s + 0.25, t + 0.25, 0, s, t + 0.25, 0);
        const bays: Array<[number, number, number, number]> = [[1, 0.5, 4, 8.5], [7, 0.5, 10, 8.5]];
        const r = latticeFacade(f, { rgba, width: W, height: H }, facadeSamples(Float32Array.from(soup), f), undefined, undefined, true, [], undefined, bays)!;
        expect(r.strips).toEqual(bays);
        const cell = (sv: number, tv: number) => r.depth[r.t.findIndex((x, i) => tv >= x && tv < r.t[i + 1])][r.s.findIndex((x, i) => sv >= x && sv < r.s[i + 1])];
        expect(cell(2.5, 4)).toBeLessThan(-0.05);
        expect(Math.abs(cell(5.5, 4))).toBeLessThan(0.01);
        expect(r.structure!.reliefFrom).toBe('generated');
    });

    it("splits a run of bay columns at a pier the window fit read across, and not at a light patch inside one bay", () => {
        // bays 4 m wide every 6 m (piers 2 m); between the bays at u 13-17 and 19-23 the fit's windows bleed over the pier (u 17-19),
        // which the photo shows light; inside the bay at u 7-11 a light patch 0.6 m wide (a reflection)
        const cellM = 0.1, nu = 300, ny = 200;
        const covered = new Uint8Array(nu * ny).fill(1), window = new Uint8Array(nu * ny), lum = new Float32Array(nu * ny);
        for (let y = 0; y < ny; y++) for (let x = 0; x < nu; x++) {
            const u = x * cellM, k = y * nu + x, inBay = u % 6 >= 1 && u % 6 < 5;
            const bleed = u >= 17 && u < 19, patch = u >= 8.7 && u < 9.3;
            lum[k] = inBay && !patch ? 60 : 190;
            if (inBay || bleed) window[k] = 1;
        }
        const { bays } = readWallBays({ u0: 0, y0: 0, nu, ny, cellM, covered, window, lum });
        const cols = [...new Set(bays.map(b => `${Math.round(b.u0)}-${Math.round(b.u1)}`))];
        expect(cols).toContain('13-17');
        expect(cols).toContain('19-23');
        expect(cols).toContain('7-11');
        expect(bays.every(b => b.u1 - b.u0 < 6)).toBe(true);
    });

    it('draws no bay over a stack of punched windows in shaded stone, and keeps a strip whose spandrels hold no windows but are no stone', () => {
        // columns 2 m wide every 4 m, 30 m tall; storeys 3.5 m: windows 2 m tall. The wall is in shade, stone as dark as the
        // glass, so light cannot tell them apart; on the left (u < 20) the window fit leaves the 1.5 m of stone between
        // storeys empty (punched windows), on the right it reads each column as one strip
        const cellM = 0.1, nu = 400, ny = 300;
        const covered = new Uint8Array(nu * ny).fill(1), window = new Uint8Array(nu * ny), lum = new Float32Array(nu * ny);
        for (let y = 0; y < ny; y++) for (let x = 0; x < nu; x++) {
            const u = x * cellM, h = y * cellM, k = y * nu + x, inCol = u % 4 >= 1 && u % 4 < 3;
            lum[k] = inCol ? 70 : 180;
            if (inCol && (u >= 20 || h % 3.5 < 2)) window[k] = 1;
        }
        const { bays } = readWallBays({ u0: 0, y0: 0, nu, ny, cellM, covered, window, lum });
        expect(bays.filter(b => b.u0 < 20)).toHaveLength(0);
        const right = bays.filter(b => b.u0 >= 20);
        expect(right.length).toBe(5);
        expect(right.every(b => b.y1 - b.y0 > 25)).toBe(true);
    });

    it('lays a wall of two overlapping facades on one sheet: one photo from both, their windows carried, the gap filled and marked', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sheets-'));
        // facade 1: s -10..10, t 0..20 (photo covers its left half); facade 2: 0.3 m behind, s 0..20 (photo covers it all)
        const mk = (id: number, cx: number, z: number, coverTo: number): GrammarFacade => {
            const f = { ...facade(id, cx, z, 20, 0, 20), uncoveredMask: `f${id}_u.png` };
            const W = f.width, H = f.height, rgba = new Uint8Array(W * H * 4), unc = new Uint8Array(W * H);
            for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const k = y * W + x; rgba.set(x < coverTo ? [180 - id * 40, 120, 100, 255] : [128, 128, 128, 255], k * 4); unc[k] = x < coverTo ? 0 : 255; }
            fs.writeFileSync(path.join(dir, f.image), encodePng(W, H, Buffer.from(rgba), 4));
            fs.writeFileSync(path.join(dir, f.uncoveredMask!), encodePng(W, H, Buffer.from(unc), 1));
            return f;
        };
        const f1 = mk(1, 0, 0, 100), f2 = mk(2, 10, -0.3, 200);
        fs.writeFileSync(path.join(dir, 'facades.json'), JSON.stringify({ facades: [{ ...f1, coverage: 0.5 }, { ...f2, coverage: 1 }] }));
        const grammar = { version: 'v', params: {} as never, facades: {}, walls: [{ wallId: 3, facades: [1, 2], normal: [0, 0, 1], axisU: [1, 0, 0], offset: 0, u0: -10, u1: 20, y0: 0, y1: 20, coverage: 1, tier: 0, bays: [{ u0: 2, u1: 6, y0: 2, y1: 18, from: 'photo-inferred' as const }] }] };
        const fit = { version: 'v', params: {} as never, ms: 0, facades: [{ facadeId: 2, width: 200, height: 200, rects: [[20, 20, 60, 180]] as Array<[number, number, number, number]>, bands: [], ms: 0 }] };
        const dec = (b: Buffer) => { const d = decodePng(b); return { rgba: d.rgba, width: d.width, height: d.height }; };
        const { sheets } = buildWallSheets(dir, grammar as never, fit as never, dec);
        expect(sheets).toHaveLength(1);
        const sh = sheets[0];
        expect(sh.facade.facadeId).toBe(SHEET_ID_BASE + 3);
        expect(sh.members.sort()).toEqual([1, 2]);
        // 30 m along the wall: facade 1's photo on its half, facade 2's on the rest; nothing left uncovered
        expect(sh.facade.sMax - sh.facade.sMin).toBeCloseTo(30, 0);
        const unc = decodePng(fs.readFileSync(path.join(dir, sh.facade.uncoveredMask!)));
        let holes = 0; for (let k = 0; k < unc.width * unc.height; k++) if (unc.rgba[k * 4] > 127) holes++;
        expect(holes).toBe(0);
        // facade 2's window carried onto the sheet (s 2..6 of it is s 2..6 of the wall, 10..14 m from the sheet's left edge)
        expect(sh.windows).toHaveLength(1);
        expect(sh.windows[0][0] * 0.1).toBeCloseTo(12, 0);
        expect(sh.bays).toHaveLength(1);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('builds the whole wall where the scan has it, the photo or not, and nothing where the scan has no wall near the plane', () => {
        // a 12 x 9 m wall measured over s 0-8 (a recess beyond); the photo reached only s 0-4 but its rows span the whole width
        const PX = 0.1, W = 120, H = 90;
        const f: ReliefFacade = { facadeId: 7, image: 'f.png', centroid: [0, 0, 0], normal: [0, 0, 1], axisS: [1, 0, 0], axisT: [0, 1, 0], sMin: 0, sMax: 12, tMin: 0, tMax: 9, pixel: PX, width: W, height: H, orthoSMin: 0, orthoTMax: 9, coverage: 1 };
        const rgba = new Uint8Array(W * H * 4), unc = new Uint8Array(W * H);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { rgba.set([180, 170, 160, 255], (y * W + x) * 4); unc[y * W + x] = x >= 40 && x < 119 ? 1 : 0; }
        const soup: number[] = [];
        for (let s = 0; s < 8; s += 0.25) for (let t = 0; t < 9; t += 0.25) soup.push(s, t, 0, s + 0.25, t, 0, s + 0.25, t + 0.25, 0, s, t, 0, s + 0.25, t + 0.25, 0, s, t + 0.25, 0);
        const smp = facadeSamples(Float32Array.from(soup), f);
        const at = (r: NonNullable<ReturnType<typeof latticeFacade>>, sv: number, tv: number) => r.built[r.t.findIndex((x, i) => tv >= x && tv < r.t[i + 1]) * (r.s.length - 1) + r.s.findIndex((x, i) => sv >= x && sv < r.s[i + 1])];
        // a window every 3 m (fitted, in pixels), so the lattice has its lines across the whole wall
        const fitted: Array<[number, number, number, number]> = [];
        for (let x = 10; x < W; x += 30) for (let y = 10; y < H - 20; y += 30) {
            fitted.push([x, y, x + 10, y + 15]);
            for (let yy = y; yy < y + 15; yy++) for (let xx = x; xx < x + 10; xx++) rgba.set([60, 60, 70, 255], (yy * W + xx) * 4);
        }
        const photoOnly = latticeFacade(f, { rgba, width: W, height: H }, smp, undefined, unc, false, fitted, undefined, undefined, undefined, false)!;
        const whole = latticeFacade(f, { rgba, width: W, height: H }, smp, undefined, unc, false, fitted, undefined, undefined, undefined, true)!;
        expect(at(photoOnly, 6, 4)).toBe(0);
        expect(at(whole, 6, 4)).toBe(1);
        expect(at(whole, 2, 4)).toBe(1);
        expect(at(whole, 10, 4)).toBe(0);
    });
});
