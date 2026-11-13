/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { buildingStorey, fitLattice, photoStorey, inferStructureIntent, mirrorShare, splitStrips, STRUCTURE_INTENT_PARAMS, type FacadeEvidence, type IntentFacadeInput } from '../src/node/3d-engine/staged-location/structure-intent';

type Rect = [number, number, number, number];
// a facade 400 x 300 px at 0.1 m a pixel, facing +z, its photo's top at t = 15 m (world y = 15 at row 0)
const frame = (id = 1): IntentFacadeInput['frame'] => ({ centroid: [20, 15, 0], normal: [0, 0, 1], axisS: [1, 0, 0], axisT: [0, 1, 0], orthoSMin: -20, orthoTMax: 0, pixel: 0.1, width: 400, height: 300 });
const grid = (xs: number[], ys: number[], w = 16, h = 20): Rect[] => xs.flatMap(x => ys.map(y => [x - w / 2, y - h / 2, x + w / 2, y + h / 2] as Rect));

describe('structure intent: what the design is, decided region by region', () => {
    it('fits a lattice to positions and says how many sit on it', () => {
        const l = fitLattice([40, 80, 120, 200, 240], 0.2, 3)!;
        expect(l.pitch).toBeCloseTo(40, 3);
        expect(l.share).toBe(1);
        expect([l.first, l.last]).toEqual([0, 5]);
        expect(fitLattice([40, 80], 0.2, 3)).toBeUndefined();
        expect(fitLattice([10, 33, 71, 90, 160], STRUCTURE_INTENT_PARAMS.latticeTol, 3)!.share).toBeLessThan(0.75);
    });

    it('fills the sites a repeating band\'s capture missed, every window at the module', () => {
        // 6 columns at 40 px pitch, 4 rows at 50 px; the photo missed four windows (a smear, an occlusion)
        const all = grid([60, 100, 140, 180, 220, 260], [50, 100, 150, 200]);
        const missed = new Set([3, 8, 13, 21]);
        const read = all.filter((_, i) => !missed.has(i)).map(r => [r[0] + (r[0] % 3) - 1, r[1], r[2], r[3] + (r[1] % 2)] as Rect);
        const it = inferStructureIntent([{ facadeId: 1, frame: frame(), rects: read }]);
        const f = it.facades[0];
        expect(f.regions).toHaveLength(1);
        expect(f.regions[0].decision).toBe('repeat');
        expect(f.regions[0].added).toBe(4);
        expect(f.windows.filter(w => w.source === 'repeat')).toHaveLength(4);
        expect(f.windows).toHaveLength(24);
        // one family, every window the same size: the module
        const ws = new Set(f.windows.map(w => (w.rect[2] - w.rect[0]).toFixed(3))), hs = new Set(f.windows.map(w => (w.rect[3] - w.rect[1]).toFixed(3)));
        expect(ws.size).toBe(1); expect(hs.size).toBe(1);
        for (const k of missed) expect(f.windows.some(w => Math.abs((w.rect[0] + w.rect[2]) / 2 - (all[k][0] + all[k][2]) / 2) < 2 && Math.abs((w.rect[1] + w.rect[3]) / 2 - (all[k][1] + all[k][3]) / 2) < 2)).toBe(true);
    });

    it('mirrors an irregular but symmetric band about its axis, and leaves a band with neither as read', () => {
        // a band of irregular spacing symmetric about x = 200 (one window's partner unread), and above it a band with neither
        const sym: Rect[] = [[40, 200, 60, 230], [95, 200, 120, 230], [190, 200, 210, 230], [340, 200, 360, 230]]; // 280-305 (the partner of 95-120) unread
        const odd: Rect[] = [[30, 40, 44, 60], [120, 40, 170, 90], [300, 40, 320, 52]];
        const f = inferStructureIntent([{ facadeId: 1, frame: frame(), rects: [...sym, ...odd] }]).facades[0];
        const decisions = f.regions.map(r => r.decision);
        expect(decisions).toContain('symmetric');
        expect(decisions).toContain('neither');
        const mirrored = f.windows.filter(w => w.source === 'mirror');
        expect(mirrored).toHaveLength(1);
        expect(mirrored[0].rect[0]).toBeCloseTo(280, 0);
        expect(mirrored[0].rect[2]).toBeCloseTo(305, 0);
        // the irregular band is untouched
        for (const r of odd) expect(f.windows.some(w => w.source === 'measured' && w.rect.every((v, i) => Math.abs(v - r[i]) < 1e-9))).toBe(true);
        expect(mirrorShare(sym, 200, STRUCTURE_INTENT_PARAMS.mirrorIoU)).toBe(0.75);
    });

    it('reads a strip of stacked panes as a column of windows, and a plain strip as one opening', () => {
        const strip: Rect = [100, 20, 120, 280], plain: Rect = [200, 20, 220, 280];
        const small = grid([300, 340], [50, 100]);
        const panes = [60, 110, 160, 210, 260].map(y => [100, y - 18, 120, y + 18] as Rect);
        const out = splitStrips([strip, plain, ...small], panes, STRUCTURE_INTENT_PARAMS);
        expect(out.filter(r => r[0] === 100)).toHaveLength(5);
        expect(out.filter(r => r[0] === 200)).toEqual([plain]);
    });

    it('finds the building\'s storey and puts every agreeing band on its floor lines', () => {
        const st = buildingStorey([{ pitchM: 3.5, phaseY: 1.0, rows: 10 }, { pitchM: 3.55, phaseY: 4.5, rows: 6 }, { pitchM: 7, phaseY: 0, rows: 4 }], 0.08)!;
        expect(st.pitchM).toBeCloseTo(3.52, 1);
        expect(st.bands).toBe(2);
        // two facades on a 50 px (5 m) storey; the second read 6 px off the first's floors: it lands on them
        const a = inferStructureIntent([
            { facadeId: 1, frame: frame(1), rects: grid([60, 100, 140, 180], [50, 100, 150, 200, 250]) },
            { facadeId: 2, frame: frame(2), rects: grid([60, 100, 140, 180], [56, 106, 156, 206, 256]) }
        ]);
        expect(a.storey?.pitchM).toBeCloseTo(5, 1);
        const rowsOf = (k: number) => [...new Set(a.facades[k].windows.map(w => Math.round((w.rect[1] + w.rect[3]) / 2)))].sort((x, y) => x - y);
        expect(rowsOf(0)).toEqual(rowsOf(1));
    });

    // a facade photo: wall at luma 0.6, a dark window (0.2) at each of `sites`; `uncovered` columns the photo never reached
    const photo = (sites: Rect[], uncovered: [number, number][] = []): FacadeEvidence => {
        const W = 400, H = 300, luma = new Float32Array(W * H).fill(0.6), valid = new Uint8Array(W * H).fill(1);
        for (const r of sites) for (let y = Math.round(r[1]); y < Math.round(r[3]); y++) for (let x = Math.round(r[0]); x < Math.round(r[2]); x++) luma[y * W + x] = 0.2;
        for (const [x0, x1] of uncovered) for (let y = 0; y < H; y++) for (let x = x0; x < x1; x++) valid[y * W + x] = 0;
        return { W, H, luma, valid };
    };

    it('carries a repeat on to the wall\'s ends where the photo shows windows or never looked, and stops where it reads wall', () => {
        const rows = [50, 100, 150, 200];
        // the photo shows windows in columns 60..300; column 340 is plain wall; columns 20-80 the photo never reached
        const shown = grid([60, 100, 140, 180, 220, 260, 300], rows);
        const read = grid([140, 180, 220, 260], rows);
        const f = inferStructureIntent([{ facadeId: 1, frame: frame(), rects: read, evidence: photo(shown, [[40, 80]]) }]).facades[0];
        expect(f.evidence?.used).toBe(true);
        const colsOut = [...new Set(f.windows.map(w => Math.round((w.rect[0] + w.rect[2]) / 2)))].sort((a, b) => a - b);
        // carried left to 100 (shown) and 60 (never reached: unread), right to 300 (shown); 340 reads as wall: not laid
        expect(colsOut).toEqual([60, 100, 140, 180, 220, 260, 300]);
        expect(f.evidence?.extended).toBe(3);
        expect(f.windows.filter(w => Math.round((w.rect[0] + w.rect[2]) / 2) === 60).every(w => w.evidence === 'unread')).toBe(true);
        expect(f.windows.filter(w => Math.round((w.rect[0] + w.rect[2]) / 2) === 100).every(w => w.evidence === 'window')).toBe(true);
    });

    it('withholds a repeat site the photo reads as wall, and fills one it never reached', () => {
        const all = grid([60, 100, 140, 180, 220], [50, 100, 150, 200]);
        // two sites the capture missed: (140, 100) the photo shows as plain wall; (180, 150) it never reached
        const read = all.filter(r => !((r[0] + 8 === 140 && r[1] + 10 === 100) || (r[0] + 8 === 180 && r[1] + 10 === 150)));
        const shown = all.filter(r => !(r[0] + 8 === 140 && r[1] + 10 === 100));
        const f = inferStructureIntent([{ facadeId: 1, frame: frame(), rects: read, evidence: photo(shown, [[170, 190]]) }]).facades[0];
        expect(f.regions[0].decision).toBe('repeat');
        expect(f.regions[0].withheld).toBe(1);
        expect(f.windows.some(w => Math.abs(w.rect[0] + 8 - 140) < 1 && Math.abs(w.rect[1] + 10 - 100) < 1)).toBe(false);
        const filled = f.windows.find(w => Math.abs(w.rect[0] + 8 - 180) < 1 && Math.abs(w.rect[1] + 10 - 150) < 1)!;
        expect(filled.source).toBe('repeat');
        expect(filled.evidence).toBe('unread');
    });

    it('lays a shaft through a gap between two matching bands, and draws its piers once down the whole shaft', () => {
        const cols = [60, 100, 140, 180, 220];
        const upper = grid(cols, [20, 70, 120]), lower = grid(cols, [270, 320]);
        // a band of a different pattern between them (two small windows off the columns), on rows 170 and 220 the capture missed the shaft
        const odd: Rect[] = [[300, 185, 312, 205], [360, 185, 372, 205]];
        const f = inferStructureIntent([{ facadeId: 1, frame: { ...frame(), height: 340 }, rects: [...upper, ...odd, ...lower] }]).facades[0];
        expect(f.regions.map(r => r.decision)).toEqual(['repeat', 'neither', 'repeat']);
        expect(f.evidence?.stacked).toBe(10);
        for (const cy of [170, 220]) expect(f.windows.filter(w => Math.abs((w.rect[1] + w.rect[3]) / 2 - cy) < 1)).toHaveLength(5);
        // four piers between five columns, each one piece from the top band to the bottom
        expect(f.structure?.piers).toHaveLength(4);
        for (const p of f.structure!.piers) { expect(p[1]).toBeLessThan(15); expect(p[3]).toBeGreaterThan(325); }
        expect(f.structure!.floors.length).toBeGreaterThanOrEqual(5);
    });

    it('lets a poorly read face take its setback tier\'s pattern when its few read windows sit on it', () => {
        const rows = [50, 100, 150, 200], cols = [60, 100, 140, 180, 220, 260, 300, 340];
        const rich: IntentFacadeInput = { facadeId: 1, frame: frame(1), rects: grid(cols, rows), tier: 0 };
        // the same tier's other face: three windows read, on the tier's columns; its photo shows every site but (340, 200), plain wall
        const shown = grid(cols, rows).filter(r => !(r[0] + 8 === 340 && r[1] + 10 === 200));
        const poor: IntentFacadeInput = { facadeId: 2, frame: frame(2), rects: grid([100, 220, 300], [100]), tier: 0, evidence: photo(shown) };
        const it = inferStructureIntent([rich, poor]);
        const t = it.tiers!.find(x => x.tier === 0)!;
        expect(t.pitchM).toBeCloseTo(4, 1);
        const f = it.facades[1], fromTier = f.windows.filter(w => w.source === 'tier');
        expect(fromTier.length).toBeGreaterThanOrEqual(25);
        expect(f.windows.some(w => Math.abs(w.rect[0] + 8 - 340) < 2 && Math.abs(w.rect[1] + 10 - 200) < 2)).toBe(false);
        expect(t.filled[0]).toMatchObject({ facadeId: 2 });
        expect(t.filled[0].withheld).toBeGreaterThanOrEqual(1);
    });

    it('fills a face the capture never read from its partner under the plan\'s mirror, and refuses a partner that does not coincide', () => {
        // two halves of one wall (x 0..20 and 20..40 m, facing +z); the plan mirrors about x = 20
        const half = (id: number, cx: number): IntentFacadeInput['frame'] => ({ ...frame(id), centroid: [cx, 15, 0], width: 200, orthoSMin: -10 });
        const B: IntentFacadeInput = { facadeId: 1, frame: half(1, 10), rects: grid([30, 70, 110, 150], [50, 100, 150, 200]) };
        const unread = photo([], [[0, 400]]);
        const A: IntentFacadeInput = { facadeId: 2, frame: half(2, 30), rects: [], evidence: { ...unread, W: 400 } };
        const sym = { transforms: [{ kind: 'mirror', angleDeg: 90, centre: [20, -5], from: 'massing', score: 0.97 }], facades: [], twins: [] } as unknown as Parameters<typeof inferStructureIntent>[1];
        const it = inferStructureIntent([B, A], sym);
        const plan = it.facades[1].windows.filter(w => w.source === 'plan');
        expect(plan).toHaveLength(16);
        // B's window at x 22..38 px lands at 200 - 38 .. 200 - 22 on A
        expect(plan.some(w => Math.abs(w.rect[0] - 162) < 0.01 && Math.abs(w.rect[2] - 178) < 0.01)).toBe(true);
        expect(it.planFills).toEqual([expect.objectContaining({ to: 2, from: 1, added: 16 })]);
        // the same partner a metre and a half out of the wall's plane is not the face's image
        const off: IntentFacadeInput = { ...A, frame: { ...A.frame, centroid: [30, 15, 2] } };
        expect(inferStructureIntent([B, off], sym).facades[1].windows).toHaveLength(0);
    });

    it('reads a face top-down as one lattice from its photo period: a coherent blank block is a detail, an isolated contradiction is noise', () => {
        const xs = Array.from({ length: 10 }, (_, k) => 20 + 40 * k), ys = [50, 100, 150, 200, 250];
        const key = (x: number, y: number) => `${x},${y}`;
        // a 3 x 3 block of wall (columns 260-340, rows 150-250) and one isolated site (100, 100) the photo shows as wall
        const block = new Set(xs.filter(x => x >= 260 && x <= 340).flatMap(x => ys.filter(y => y >= 150).map(y => key(x, y))));
        const wallAt = new Set([...block, key(100, 100)]);
        const shown = xs.flatMap(x => ys.filter(y => !wallAt.has(key(x, y))).map(y => [x - 8, y - 10, x + 8, y + 10] as Rect));
        // the capture read about half the windows, never the block or the isolated site
        const read = shown.filter((_, i) => i % 2 === 0 || i % 5 === 1);
        const f = inferStructureIntent([{ facadeId: 1, frame: frame(), rects: read, period: { m: 4, ncc: 0.9 }, evidence: photo(shown) }]).facades[0];
        expect(f.lattice?.accepted).toBe(true);
        expect(f.lattice?.bayM).toBeCloseTo(4, 1);
        expect(f.lattice?.detailSites).toBe(9);
        expect(f.lattice?.noiseOverridden).toBe(1);
        // every site but the block's holds a window; the isolated one is laid over its contradiction, and says so
        expect(f.windows).toHaveLength(50 - 9);
        expect(f.windows.find(w => Math.abs(w.rect[0] + 8 - 100) < 1 && Math.abs(w.rect[1] + 10 - 100) < 1)?.overridden).toBe(true);
        for (const k of block) { const [x, y] = k.split(',').map(Number); expect(f.windows.some(w => Math.abs(w.rect[0] + 8 - x) < 1 && Math.abs(w.rect[1] + 10 - y) < 1)).toBe(false); }
    });

    it('refuses the lattice where the windows read do not sit on the photo\'s period', () => {
        // three rows of windows 4.4 m apart, each row shifted 1.3 m: folded at the photo's 4 m they spread evenly, no column
        const irregular: Rect[] = [50, 100, 150].flatMap((y, r) => Array.from({ length: 8 }, (_, k) => 20 + 13 * r + 44 * k).filter(x => x + 8 <= 400).map(x => [x - 8, y - 10, x + 8, y + 10] as Rect));
        const f = inferStructureIntent([{ facadeId: 1, frame: frame(), rects: irregular, period: { m: 4, ncc: 0.9 } }]).facades[0];
        expect(f.lattice?.accepted ?? false).toBe(false);
        expect(f.windows.every(w => w.source !== 'pattern')).toBe(true);
    });

    it('gives overlapping readings of one wall one shared lattice, so they draw the same grid', () => {
        // two facades of one wall (x 0..40 m and 10..50 m, facing +z): each read the shared windows a little off, in its own frame
        const xsW = Array.from({ length: 12 }, (_, k) => 2 + 4 * k), ysW = [50, 100, 150, 200, 250];
        const mk = (id: number, x0: number, jitter: number): IntentFacadeInput => ({
            facadeId: id, wall: 7, period: { m: 4, ncc: 0.8 },
            frame: { ...frame(id), centroid: [x0 + 20, 15, 0] },
            rects: xsW.flatMap(x => ysW.map(y => { const px = (x - x0) * 10; return [px - 8 + jitter, y - 10, px + 8 + jitter, y + 10] as Rect; })).filter(r => r[0] >= 0 && r[2] <= 400)
        });
        const it = inferStructureIntent([mk(1, 0, 0), mk(2, 10, 3)]);
        const worldCols = (k: number, x0: number) => [...new Set(it.facades[k].windows.filter(w => w.source !== 'measured' || true).map(w => Math.round(((w.rect[0] + w.rect[2]) / 2 / 10 + x0) * 10) / 10))].sort((a, b) => a - b);
        expect(it.facades[0].lattice?.bayFrom).toBe('wall');
        expect(it.facades[1].lattice?.bayFrom).toBe('wall');
        const a = worldCols(0, 0), b = worldCols(1, 10);
        // where the two overlap (x 10..40 m) their columns are the same world positions
        const overlap = (v: number[]) => v.filter(x => x > 11 && x < 39);
        expect(overlap(a)).toEqual(overlap(b));
    });
    it('takes the storey from the photos\' row period when no repeating bands give one', () => {
        // two faces whose windows were read too sparsely to repeat (one row each), their photos carrying a 4 m row period; a third disagrees
        const sparse = (id: number, ys: number[], m: number, ncc: number): IntentFacadeInput => ({ facadeId: id, frame: frame(id), rects: grid([60, 140, 260], ys), rowPeriod: { m, ncc } });
        const faces = [sparse(1, [50], 4.0, 0.8), sparse(2, [90], 4.1, 0.7), sparse(3, [130], 6.5, 0.9)];
        const st = photoStorey(faces, STRUCTURE_INTENT_PARAMS)!;
        expect(st.from).toBe('photo');
        expect(st.bands).toBe(2);
        expect(st.pitchM).toBeGreaterThan(4.0); expect(st.pitchM).toBeLessThan(4.1);
        // rows at y = 50 and 90 px are world 10 m and 6 m: both on one 4 m datum
        expect(Math.min(Math.abs(st.datumY - 2), Math.abs(st.datumY - 2 + st.pitchM), Math.abs(st.datumY - 2 - st.pitchM))).toBeLessThan(0.3);
        const intent = inferStructureIntent(faces);
        expect(intent.storey?.from).toBe('photo');
        // one face alone, or a weak period, gives none
        expect(photoStorey(faces.slice(0, 1), STRUCTURE_INTENT_PARAMS)).toBeUndefined();
        expect(photoStorey([sparse(1, [50], 4, 0.3), sparse(2, [90], 4, 0.3)], STRUCTURE_INTENT_PARAMS)).toBeUndefined();
    });
});

