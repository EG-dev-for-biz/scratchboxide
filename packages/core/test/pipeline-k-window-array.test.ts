/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The window array (pipeline-k/window-array.ts) on synthetic facades drawn with a known grid: dark 1.2 x 2 m windows every
 * 3 m along the wall and every 4 m up it on a light wall. The boxes given are the window fit's as a dim lower half would
 * leave them (off the grid, oversized), as two genuine tiers, with a span nothing was read on, and with no grid at all.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';
import { consensusPitch, describeWindowArrays, inferWindowArray, inferWindowArrays, SITE_KIND, WINDOW_ARRAY_PARAMS, WINDOW_ARRAY_VERSION, type ArrayRecord } from '../src/node/3d-engine/staged-location/pipeline-k/window-array';
import { WINDOW_FIT_PARAMS, WINDOW_FIT_VERSION, type WindowFitFile, type WindowRect } from '../src/node/3d-engine/staged-location/window-fit';
import { BUILD_STEPS, TOGGLEABLE_STEPS } from '../src/common/staged-build-steps';

const PX = 0.1, W = 300, H = 600; // a 30 x 60 m facade, y down
const COL = 3 / PX, ROW = 4 / PX, BW = 1.2 / PX, BH = 2 / PX;
/** Site (i, j): column i of 10, row j of 15 from the top. */
const site = (i: number, j: number, bw = BW, bh = BH, rowPitch = ROW, rowPhase = ROW / 2): WindowRect => {
    const cx = COL / 2 + i * COL, cy = rowPhase + j * rowPitch;
    return [Math.round(cx - bw / 2), Math.round(cy - bh / 2), Math.round(cx + bw / 2), Math.round(cy + bh / 2)];
};

function photo(windows: WindowRect[], dark = 40, wall = 200): { rgba: Uint8Array; width: number; height: number } {
    const rgba = new Uint8Array(W * H * 4).fill(255);
    for (let k = 0; k < W * H; k++) rgba.set([wall, wall, wall], k * 4);
    for (const [x0, y0, x1, y1] of windows) for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) rgba.set([dark, dark, dark], (y * W + x) * 4);
    return { rgba, width: W, height: H };
}
const allValid = () => new Uint8Array(W * H).fill(1);
/** A deterministic noise source. */
function lcg(seed: number): () => number { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
const centre = (r: WindowRect) => [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2];
/** The distance of each box's centre to the nearest true site, in pitches, as an RMS. */
function rmsToGrid(rects: WindowRect[]): number {
    let s = 0;
    for (const r of rects) { const [cx, cy] = centre(r); const dx = ((cx - COL / 2) / COL) % 1, dy = ((cy - ROW / 2) / ROW) % 1; const ex = Math.min(Math.abs(dx), 1 - Math.abs(dx)), ey = Math.min(Math.abs(dy), 1 - Math.abs(dy)); s += ex * ex + ey * ey; }
    return Math.sqrt(s / Math.max(1, rects.length));
}

describe('the window array', () => {
    it('finds a pitch by consensus: the pitch itself, not its half or double, against a noisy minority', () => {
        const rnd = lcg(7);
        const pos = Array.from({ length: 20 }, (_, k) => 15 + k * 30 + (rnd() - 0.5) * 2), noise = Array.from({ length: 8 }, () => rnd() * 600);
        const l = consensusPitch([...pos, ...noise], [...pos, ...noise].map(() => 1), 8, 120, 0.5, 3)!;
        expect(l.pitch).toBeGreaterThan(29); expect(l.pitch).toBeLessThan(31);
        const off = ((l.phase - 15) % 30 + 30) % 30;
        expect(Math.min(off, 30 - off)).toBeLessThan(1.5);
    });

    it('brings a drifting, oversized lower half onto the upper half\'s array, and fills the empty sites the photo shows', () => {
        const truth: WindowRect[] = [];
        for (let j = 0; j < 15; j++) for (let i = 0; i < 10; i++) truth.push(site(i, j));
        const img = photo(truth);
        const rnd = lcg(3);
        // the upper 8 rows as read (two sites left unread), the lower 7 rows off the grid and oversized, as a dim photo leaves them
        const given: WindowRect[] = [];
        for (let j = 0; j < 15; j++) for (let i = 0; i < 10; i++) {
            if (j < 8) { if (!(j === 3 && (i === 4 || i === 5))) given.push(site(i, j)); continue; }
            const [cx, cy] = centre(site(i, j));
            const ox = (rnd() - 0.5) * 0.9 * COL, oy = (rnd() - 0.5) * 0.9 * ROW, bw = BW * 1.7, bh = BH * 1.5;
            if (rnd() < 0.7) given.push([Math.round(cx + ox - bw / 2), Math.round(cy + oy - bh / 2), Math.round(cx + ox + bw / 2), Math.round(cy + oy + bh / 2)]);
        }
        const before = rmsToGrid(given);
        const out = inferWindowArray({ rects: given, panes: given.map(r => [r[0] + 2, r[1] + 2, r[2] - 2, r[3] - 2] as WindowRect) }, img, allValid(), undefined, PX);
        expect(out.report.reason).toBeUndefined();
        expect(Math.abs(out.report.colPitchM! - 3)).toBeLessThan(0.1); expect(Math.abs(out.report.tiers![0].rowPitchM - 4)).toBeLessThan(0.1);
        expect(out.report.tiers).toHaveLength(1);
        expect(out.report.tiers![0].boxM[0]).toBeCloseTo(1.2, 1); expect(out.report.tiers![0].boxM[1]).toBeCloseTo(2, 1);
        // every box now on a site, one a site, the lattice's size, the grid complete
        const after = rmsToGrid(out.rects);
        expect(before).toBeGreaterThan(0.15); expect(after).toBeLessThan(0.03);
        expect(out.rects).toHaveLength(150);
        for (const r of out.rects) { expect(r[2] - r[0]).toBeCloseTo(BW, 0); expect(r[3] - r[1]).toBeCloseTo(BH, 0); }
        expect(out.report.on).toBe(78); expect(out.report.snapped + out.report.replaced).toBeGreaterThan(30);
        expect(out.report.added).toBeGreaterThanOrEqual(2); expect(out.report.rmsOut).toBeLessThan(out.report.rmsIn!);
        // the added are generated, with the pane layout of a box on the lattice; the moved keep a pane each
        expect(out.generated!.length).toBe(out.report.added);
        expect(out.panes!.length).toBe(150);
        const kinds = new Set<number>(); for (let k = 4; k < out.sites.length; k += 7) kinds.add(out.sites[k]);
        expect(kinds.has(SITE_KIND.added)).toBe(true); expect(kinds.has(SITE_KIND.on)).toBe(true);
    });

    it('keeps two row pitches where the facade\'s tiers genuinely differ, read from the residuals and the photo', () => {
        // a base of 3 storeys at 6 m with 3 m tall windows under 9 storeys at 4 m
        const base: WindowRect[] = [], shaft: WindowRect[] = [];
        for (let j = 0; j < 9; j++) for (let i = 0; i < 10; i++) shaft.push(site(i, j));
        const baseTop = 9 * ROW;
        for (let j = 0; j < 3; j++) for (let i = 0; i < 10; i++) base.push(site(i, j, BW, 3 / PX, 6 / PX, baseTop + 3 / PX));
        const img = photo([...shaft, ...base]);
        const out = inferWindowArray({ rects: [...shaft, ...base] }, img, allValid(), undefined, PX);
        expect(out.report.reason).toBeUndefined();
        expect(out.report.tiers).toHaveLength(2);
        const pitches = out.report.tiers!.map(t => t.rowPitchM).sort((a, b) => a - b);
        expect(pitches[0]).toBeCloseTo(4, 1); expect(pitches[1]).toBeCloseTo(6, 1);
        const tier = out.report.tiers!.find(t => t.from === 'residual-tier')!;
        expect(tier.photoScore!.tier).toBeGreaterThan(tier.photoScore!.facade);
        expect(out.report.on).toBe(120); expect(out.report.snapped + out.report.replaced + out.report.rejected).toBe(0);
        expect(out.rects).toHaveLength(120);
    });

    it('adds nothing in an occluded span, nor where the photo never reached, nor past the rows the boxes established', () => {
        const truth: WindowRect[] = [];
        for (let j = 0; j < 15; j++) for (let i = 0; i < 10; i++) truth.push(site(i, j));
        const img = photo(truth);
        // the right three columns stood behind something: no boxes read there; the top two rows unread, uncovered
        const occluded = new Uint8Array(W * H), valid = allValid();
        for (let y = 0; y < H; y++) for (let x = 7 * COL; x < W; x++) { occluded[y * W + x] = 1; valid[y * W + x] = 0; }
        for (let y = 0; y < 2 * ROW; y++) for (let x = 0; x < W; x++) valid[y * W + x] = 0;
        const given = truth.filter(r => r[2] <= 7 * COL && r[1] >= 2 * ROW && !(r[1] > 6 * ROW && r[1] < 7 * ROW && r[0] < 3 * COL));
        const out = inferWindowArray({ rects: given }, img, valid, occluded, PX);
        expect(out.report.reason).toBeUndefined();
        for (const r of out.rects) { expect(r[2]).toBeLessThanOrEqual(7 * COL); expect(r[1]).toBeGreaterThanOrEqual(2 * ROW); }
        // only the three sites left out of row 6 are filled (covered, clear, flanked)
        expect(out.report.added).toBe(3);
        expect(out.rects).toHaveLength(given.length + 3);
    });

    it('folds a strip on a lattice column into the array\'s cells, and fills a dim row from the rows around it', () => {
        const truth: WindowRect[] = [];
        for (let j = 0; j < 15; j++) for (let i = 0; i < 10; i++) truth.push(site(i, j));
        // the photo: the grid everywhere, rows 9 and 10 drawn faint (a dim part of the photo)
        const img = photo(truth.filter(r => r[1] < site(0, 9)[1]), 40, 200);
        for (const r of truth.filter(r => r[1] >= site(0, 9)[1] && r[1] <= site(0, 10)[1])) for (let y = r[1]; y < r[3]; y++) for (let x = r[0]; x < r[2]; x++) img.rgba.set([150, 150, 150], (y * W + x) * 4);
        for (const r of truth.filter(r => r[1] > site(0, 10)[1])) for (let y = r[1]; y < r[3]; y++) for (let x = r[0]; x < r[2]; x++) img.rgba.set([40, 40, 40], (y * W + x) * 4);
        // read: cells in columns 0-5 except rows 9 and 10 (read as nothing), the right four columns as full-height strips
        const cells = truth.filter(r => r[2] <= 6 * COL && !(r[1] >= site(0, 9)[1] && r[1] <= site(0, 10)[1]));
        const strips: WindowRect[] = [6, 7, 8, 9].map(i => [site(i, 0)[0], site(i, 0)[1], site(i, 0)[2], site(i, 14)[3]]);
        const out = inferWindowArray({ rects: [...cells, ...strips] }, img, allValid(), undefined, PX);
        expect(out.report.reason).toBeUndefined();
        expect(out.report.folded).toBe(4);
        expect(out.rects).toHaveLength(150);
        for (const r of out.rects) expect(r[3] - r[1]).toBeCloseTo(BH, 0);
        // the dim rows: filled from the rows around them (the row holds no box, but its sites show the faint window contrast)
        expect(out.report.added).toBe(12);
        expect(out.report.rowsIn).toBe(15); expect(out.report.colsIn).toBe(10);
        const kinds = new Set<number>(); for (let k = 4; k < out.sites.length; k += 7) kinds.add(out.sites[k]);
        expect(kinds.has(SITE_KIND.folded)).toBe(true); expect(kinds.has(SITE_KIND.span)).toBe(false);
    });

    it('keeps a box far from the array\'s size as read, fills a site that is merely wall, and withholds one that reads the opposite of a window', () => {
        const truth: WindowRect[] = [];
        for (let j = 0; j < 15; j++) for (let i = 0; i < 10; i++) truth.push(site(i, j));
        // the photo: the grid, except site (4, 7) drawn as plain wall and site (8, 7) drawn brighter than the wall (the
        // opposite of these dark windows), and a small vent beside site (2, 3)
        const skip = (i: number, j: number) => (r: WindowRect) => !(r[0] === site(i, j)[0] && r[1] === site(i, j)[1]);
        const drawn = truth.filter(skip(4, 7)).filter(skip(8, 7));
        const vent: WindowRect = [site(2, 3)[2] + 2, site(2, 3)[1], site(2, 3)[2] + 6, site(2, 3)[1] + 4];
        const img = photo([...drawn, vent]);
        for (let y = site(8, 7)[1]; y < site(8, 7)[3]; y++) for (let x = site(8, 7)[0]; x < site(8, 7)[2]; x++) img.rgba.set([255, 255, 255], (y * W + x) * 4);
        const given = [...drawn.filter(skip(6, 7)), vent];
        const out = inferWindowArray({ rects: given }, img, allValid(), undefined, PX);
        expect(out.report.reason).toBeUndefined();
        expect(out.report.kept).toBe(1);
        expect(out.rects).toContainEqual(vent);
        // (6, 7) and (4, 7) are filled (the array holds the row; plain wall is no contradiction), (8, 7) is withheld
        expect(out.report.added).toBe(2);
        expect(out.rects).toContainEqual(site(6, 7));
        expect(out.rects).toContainEqual(site(4, 7));
        expect(out.rects).not.toContainEqual(site(8, 7));
        expect(out.report.empty!.wall).toBe(1);
    });

    it('steps on into a featureless band, and into an unreached band at the top only below the roof line', () => {
        const truth: WindowRect[] = [];
        for (let j = 0; j < 15; j++) for (let i = 0; i < 10; i++) truth.push(site(i, j));
        // the top 3 rows a smear (drawn plain, marked featureless), rows 3 and 4 unreached, boxes read below
        const smearBottom = site(0, 2)[3] + 4, unreachedBottom = site(0, 4)[3] + 4;
        const img = photo(truth.filter(r => r[1] > unreachedBottom));
        const featureless = new Uint8Array(W * H), valid = allValid();
        for (let y = 0; y < smearBottom; y++) for (let x = 0; x < W; x++) featureless[y * W + x] = 1;
        for (let y = smearBottom; y < unreachedBottom; y++) for (let x = 0; x < W; x++) valid[y * W + x] = 0;
        const given = truth.filter(r => r[1] > unreachedBottom);
        // without an envelope: the unreached band at the edge is not entered, so neither is the smear beyond it
        const out = inferWindowArray({ rects: given }, img, valid, undefined, PX, undefined, { featureless });
        expect(out.report.reason).toBeUndefined();
        expect(out.report.continued).toBeUndefined();
        expect(out.rects).toHaveLength(given.length);
        // with the roof line above the smear: both bands are stepped into, 5 rows of 10
        const withRoof = inferWindowArray({ rects: given }, img, valid, undefined, PX, undefined, { featureless, minRowPx: 0 });
        expect(withRoof.report.continued).toMatchObject({ rows: 5, sites: 50 });
        expect(withRoof.rects).toHaveLength(150);
        expect(withRoof.generated!.length).toBe(50);
        // with the roof line inside the smear (above row 1): rows 1 to 4 only
        const lowRoof = inferWindowArray({ rects: given }, img, valid, undefined, PX, undefined, { featureless, minRowPx: site(0, 1)[1] - 1 });
        expect(lowRoof.report.continued).toMatchObject({ rows: 4, sites: 40 });
        for (const r of lowRoof.rects) expect(r[1]).toBeGreaterThanOrEqual(site(0, 1)[1] - 1);
        // a featureless band at the side is not entered: sideways there is no envelope (a blank column counts only between holding columns)
        const sideFeatureless = new Uint8Array(W * H);
        for (let y = 0; y < H; y++) for (let x = 7 * COL; x < W; x++) sideFeatureless[y * W + x] = 1;
        const sideGiven = truth.filter(r => r[2] <= 7 * COL), sideImg = photo(sideGiven);
        const sideOut = inferWindowArray({ rects: sideGiven }, sideImg, allValid(), undefined, PX, undefined, { featureless: sideFeatureless, minRowPx: 0 });
        expect(sideOut.report.continued).toBeUndefined();
        expect(sideOut.rects).toHaveLength(sideGiven.length);
        // a smear in the middle of the facade, between read rows, needs no envelope
        const midFeatureless = new Uint8Array(W * H);
        for (let y = site(0, 6)[1] - 4; y < site(0, 8)[3] + 4; y++) for (let x = 0; x < W; x++) midFeatureless[y * W + x] = 1;
        const midImg = photo(truth.filter(r => r[1] < site(0, 6)[1] - 4 || r[1] > site(0, 8)[3]));
        const midOut = inferWindowArray({ rects: truth.filter(r => r[1] < site(0, 6)[1] - 4 || r[1] > site(0, 8)[3]) }, midImg, allValid(), undefined, PX, undefined, { featureless: midFeatureless });
        expect(midOut.report.continued).toMatchObject({ rows: 3, sites: 30 });
        expect(midOut.rects).toHaveLength(150);
    });

    it('does not carry a lattice read at the crown down a facade it never read, however window-like the surface', () => {
        const truth: WindowRect[] = [];
        for (let j = 0; j < 15; j++) for (let i = 0; i < 10; i++) truth.push(site(i, j));
        // the whole grid drawn, boxes read on the top three rows only (with one site missing)
        const given = truth.filter(r => r[1] < site(0, 3)[1] && !(r[0] === site(5, 1)[0] && r[1] === site(5, 1)[1]));
        const out = inferWindowArray({ rects: given }, photo(truth), allValid(), undefined, PX);
        expect(out.report.reason).toBeUndefined();
        // the missing site and at most two rows below the read ones
        expect(out.report.added).toBeLessThanOrEqual(21);
        expect(out.report.added).toBeGreaterThanOrEqual(1);
        for (const r of out.rects) expect(r[1]).toBeLessThan(site(0, 5)[1] + 1);
    });

    it('leaves a facade alone when its lattice would drop many boxes as second boxes on taken sites', () => {
        const truth: WindowRect[] = [];
        for (let j = 0; j < 15; j++) for (let i = 0; i < 10; i++) truth.push(site(i, j));
        // every window read twice, the second reading a third of a column pitch to the right
        const given = [...truth, ...truth.map(r => [r[0] + Math.round(COL / 3), r[1], r[2] + Math.round(COL / 3), r[3]] as WindowRect)];
        const out = inferWindowArray({ rects: given }, photo(truth), allValid(), undefined, PX);
        expect(out.report.reason).toContain('second box on a taken site');
        expect(out.rects).toBe(given);
    });

    it('reads boxes given at fractional pixels as whole texels (the facade reader\'s come so)', () => {
        const truth: WindowRect[] = [];
        for (let j = 0; j < 15; j++) for (let i = 0; i < 10; i++) truth.push(site(i, j));
        const given = truth.filter((_, k) => k !== 73).map(r => [r[0] + 0.4, r[1] - 0.3, r[2] + 0.4, r[3] - 0.3] as WindowRect);
        const out = inferWindowArray({ rects: given }, photo(truth), allValid(), undefined, PX);
        expect(out.report.reason).toBeUndefined();
        expect(out.rects).toHaveLength(150);
        for (const r of out.rects) for (const v of r) expect(Number.isInteger(v)).toBe(true);
        // the members' contrast was read (the missing site is filled on it, not on the row's occupancy alone)
        expect(out.report.added).toBe(1);
        expect(out.report.empty!.byRow + out.report.empty!.uncovered).toBe(0);
    });

    it('leaves a facade with no majority grid as it was', () => {
        const rnd = lcg(11);
        const given: WindowRect[] = Array.from({ length: 40 }, () => { const x = Math.round(rnd() * (W - 20)), y = Math.round(rnd() * (H - 30)); return [x, y, x + 10 + Math.round(rnd() * 10), y + 15 + Math.round(rnd() * 15)] as WindowRect; });
        const out = inferWindowArray({ rects: given }, photo(given), allValid(), undefined, PX);
        expect(out.report.reason).toBeDefined();
        expect(out.rects).toBe(given);
        expect(out.report.added + out.report.snapped + out.report.replaced).toBe(0);
    });

    it('rewrites window_fit.json once, keeps the boxes before the step, and does not infer an entry twice', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'window-array-'));
        const truth: WindowRect[] = [];
        for (let j = 0; j < 15; j++) for (let i = 0; i < 10; i++) truth.push(site(i, j));
        const img = photo(truth);
        fs.writeFileSync(path.join(dir, 'facade_1.png'), encodePng(W, H, img.rgba, 4));
        fs.writeFileSync(path.join(dir, 'facades.json'), JSON.stringify({ facades: [{ facadeId: 1, image: 'facade_1.png', width: W, height: H, pixel: PX, coverage: 1, orthoSMin: 0, orthoTMax: H * PX, texel: PX }] }));
        const given = truth.filter((_, k) => k % 7 !== 3).map((r, k) => (k % 5 === 0 ? [r[0] + 5, r[1] + 8, r[2] + 5, r[3] + 8] as WindowRect : r));
        const fit: WindowFitFile = { version: WINDOW_FIT_VERSION, params: WINDOW_FIT_PARAMS, ms: 0, facades: [{ facadeId: 1, width: W, height: H, rects: given, panes: [], bands: [], ms: 0 }, { facadeId: 2, error: 'not fitted' }] };
        fs.writeFileSync(path.join(dir, 'window_fit.json'), JSON.stringify(fit));
        const rep = inferWindowArrays(dir, fit);
        expect(rep.facades).toHaveLength(1);
        expect(rep.facades[0].reason).toBeUndefined();
        expect(rep.facades[0].added).toBeGreaterThan(0);
        const written = JSON.parse(fs.readFileSync(path.join(dir, 'window_fit.json'), 'utf8')) as WindowFitFile & { array?: string };
        expect(written.array).toBe(WINDOW_ARRAY_VERSION);
        const e = written.facades[0] as Extract<WindowFitFile['facades'][number], { rects: WindowRect[] }> & { array: ArrayRecord };
        expect(e.array.in.rects).toEqual(given);
        expect(e.rects).toHaveLength(150);
        expect(e.array.sites.length).toBe(150 * 7);
        expect(e.array.version).toBe(WINDOW_ARRAY_VERSION);
        // again: the same result, not inferred twice
        const again = inferWindowArrays(dir, written);
        expect(again.facades[0]).toEqual(rep.facades[0]);
        expect((JSON.parse(fs.readFileSync(path.join(dir, 'window_fit.json'), 'utf8')) as WindowFitFile).facades[0]).toEqual(e);
        expect(describeWindowArrays(rep)).toContain('1 of 1 facades brought onto their array');
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('is a step of the build graph, with a switch', () => {
        expect(BUILD_STEPS.find(s => s.key === 'remesh.windowArray')?.stage).toBe('remesh');
        expect(TOGGLEABLE_STEPS.has('remesh.windowArray')).toBe(true);
        expect(WINDOW_ARRAY_PARAMS.majority).toBeGreaterThan(0);
    });
});
