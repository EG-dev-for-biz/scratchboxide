/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The ownership vote's facade reuse (pipeline-k/facade-reuse.ts): the orthos compared on one grid across a frame shift
 * (formula), and on the cached 30 Rockefeller Plaza build (run afe47fc1's first isolate and voted remesh): which facades
 * the vote left unchanged, the composed orthos, and the straightening that takes the kept facades whole from the first
 * pass's set, byte for byte, while it straightens the changed ones.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ownershipChange } from '../src/node/3d-engine/staged-location/ownership-change';
import { compareOrthos, composeReusedOrthos, planFacadeReuse, type FacadeReusePlan } from '../src/node/3d-engine/staged-location/pipeline-k/facade-reuse';
import { rectifyReliefOrthos } from '../src/node/3d-engine/staged-location/pipeline-k/pipeline-k';

const BENCH = '/Volumes/3DTESTING/scratchbox-ide/benchmarks/2026-11-08-texture-expert/expert/30-rock/cache/tile_refine';
const FIRST = path.join(BENCH, 'bad7bcc1ddfee8272ddede214f3966420373ec9d6c769871246de1029272c37c');
const VOTED = path.join(BENCH, 'b447c6802d3457186a4e44624debf7173f463181a3e8fecce68414679529a35b');
const real = fs.existsSync(path.join(FIRST, 'relief_orthos/facades.json')) && fs.existsSync(path.join(VOTED, 'relief_orthos/facades.json'));

describe('compareOrthos', () => {
    const img = (w: number, h: number, at: (x: number, y: number) => [number, number, number, number]) => {
        const rgba = new Uint8Array(w * h * 4);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgba.set(at(x, y), (y * w + x) * 4);
        return { rgba, width: w, height: h };
    };
    // a facade's photo: stripes, grey 128 (uncovered) right of x = 30 in the first and right of x = 28 in the second
    const stripe = (x: number): [number, number, number, number] => (x % 4 < 2 ? [200, 180, 160, 255] : [40, 50, 60, 255]);
    it('aligns the first ortho onto the second by the frames\' offset and counts the texels covered in one only', () => {
        const a = img(40, 20, x => (x < 30 ? stripe(x) : [128, 128, 128, 255]));
        // the same wall two texels to the right on the second grid
        const b = img(42, 20, x => (x < 2 ? [128, 128, 128, 255] : x - 2 < 30 ? stripe(x - 2) : [128, 128, 128, 255]));
        expect(compareOrthos(a, b, 2, 0)).toEqual({ coverageDiff: 0, colourMean: 0 });
        // unaligned, every stripe lands on its opposite (half a period off)
        expect(compareOrthos(a, b, 0, 0).colourMean).toBeGreaterThan(100);
        // two columns fewer covered: 2 of 30 columns covered in one only
        const c = img(40, 20, x => (x < 28 ? stripe(x) : [128, 128, 128, 255]));
        expect(compareOrthos(a, c, 0, 0).coverageDiff).toBeCloseTo(2 / 30, 6);
    });
});

describe.skipIf(!real)('facade reuse on the cached 30 Rockefeller Plaza build', () => {
    const change = real ? ownershipChange(path.join(FIRST, 'raw_clay.glb'), path.join(VOTED, 'raw_clay.glb')) : undefined;

    it('keeps the facades the vote left unchanged and says why each other one changed', () => {
        const plan = planFacadeReuse(path.join(FIRST, 'relief_orthos'), path.join(VOTED, 'relief_orthos'), change!.moved, change!.movedAreas);
        expect(change!.material).toBe(true);
        expect(change!.moved.length / 3).toBe(change!.movedAreas.length);
        expect(plan.kept.length + plan.changed.length).toBe(68);
        expect(plan.kept.length).toBe(21);
        // the second tower face: the same plane, no scan moved near it, a 0.68 texel shift of its frame
        expect(plan.kept.find(k => k.votedId === 21)).toMatchObject({ firstId: 21, metrics: { movedM2: 0 } });
        // the main slab: no scan moved near it, but tile_refine regrew its region (coverage 0.71 -> 0.80): only the photo shows it
        expect(plan.changed.find(c => c.votedId === 15)).toMatchObject({ metrics: { firstId: 16, movedM2: 0 } });
        expect(plan.changed.find(c => c.votedId === 15)!.reason).toMatch(/covers other texels/);
        // the scan the vote took away (a neighbour's wall on facade 2's plane)
        expect(plan.changed.find(c => c.votedId === 2)!.reason).toMatch(/the vote moved 472\.1 m²/);
        for (const k of plan.kept) expect(k.metrics.coverageDiff!).toBeLessThanOrEqual(plan.params.coverageDiff);
        // a changed facade never takes an id the first pass gave any facade
        const firstIds = new Set((JSON.parse(fs.readFileSync(path.join(FIRST, 'relief_orthos/facades.json'), 'utf8')).facades as Array<{ facadeId: number }>).map(f => f.facadeId));
        for (const c of plan.changed) expect(firstIds.has(c.id)).toBe(false);
        expect(new Set(plan.changed.map(c => c.id)).size).toBe(plan.changed.length);
    });

    it('straightens only the changed facades and takes the kept ones whole from the first pass\'s set', async () => {
        // a few facades of each pass, real orthos (the whole building takes half a minute to straighten)
        const work = fs.mkdtempSync(path.join(os.tmpdir(), 'facade-reuse-'));
        try {
            const subset = (from: string, to: string, ids: number[]) => {
                fs.mkdirSync(to, { recursive: true });
                const j = JSON.parse(fs.readFileSync(path.join(from, 'facades.json'), 'utf8'));
                j.facades = j.facades.filter((f: { facadeId: number }) => ids.includes(f.facadeId));
                for (const f of j.facades) for (const n of [f.image, f.occludedMask]) if (n && fs.existsSync(path.join(from, n))) fs.copyFileSync(path.join(from, n), path.join(to, n));
                fs.writeFileSync(path.join(to, 'facades.json'), JSON.stringify(j));
            };
            // first 26, 28 and 60 kept as voted 26, 28 and 60; voted 7 and 63 changed (their photos cover other texels)
            subset(path.join(FIRST, 'relief_orthos'), path.join(work, 'first/relief_orthos'), [26, 28, 60, 5, 63]);
            subset(path.join(VOTED, 'relief_orthos'), path.join(work, 'voted/relief_orthos'), [26, 28, 60, 7, 63]);
            const firstRaw = path.join(work, 'first/relief_orthos'), votedRaw = path.join(work, 'voted/relief_orthos');
            const first = await rectifyReliefOrthos(firstRaw, { inlineTail: true, threads: 2 });
            const plan: FacadeReusePlan = planFacadeReuse(firstRaw, votedRaw, change!.moved, change!.movedAreas);
            expect(plan.kept.map(k => k.firstId)).toEqual([26, 28, 60]);
            expect(plan.changed.map(c => c.votedId)).toEqual([7, 63]);
            const composed = composeReusedOrthos(firstRaw, votedRaw, plan);
            expect(composeReusedOrthos(firstRaw, votedRaw, plan)).toBe(composed);
            const facades = JSON.parse(fs.readFileSync(path.join(composed, 'facades.json'), 'utf8')).facades as Array<{ facadeId: number; image: string; area_m2: number }>;
            expect(facades.map(f => f.facadeId).sort((a, b) => a - b)).toEqual([26, 28, 60, ...plan.changed.map(c => c.id)].sort((a, b) => a - b));
            for (let k = 1; k < facades.length; k++) expect(facades[k - 1].area_m2).toBeGreaterThanOrEqual(facades[k].area_m2);
            const reused = await rectifyReliefOrthos(composed, { inlineTail: true, threads: 2, reuse: { fromDir: first.orthosDir, ids: [26, 28, 60], key: 'first' } });
            expect(reused.orthosDir).not.toBe(first.orthosDir);
            const read = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, 'facades.json'), 'utf8')).facades as Array<{ facadeId: number; image: string; uncoveredMask?: string }>;
            for (const id of [26, 28, 60]) {
                const a = read(first.orthosDir).find(f => f.facadeId === id)!, b = read(reused.orthosDir).find(f => f.facadeId === id)!;
                expect(b).toEqual(a);
                for (const n of fs.readdirSync(first.orthosDir).filter(n => n === a.image || n.startsWith(a.image.replace(/\.png$/, '_')))) {
                    expect(Buffer.compare(fs.readFileSync(path.join(first.orthosDir, n)), fs.readFileSync(path.join(reused.orthosDir, n))), n).toBe(0);
                }
                // as the first pass recorded it (rectify.json: a NaN there reads back as null)
                expect(reused.reports.find(r => r.facadeId === id)).toEqual(JSON.parse(JSON.stringify(first.reports.find(r => r.facadeId === id))));
            }
            // the changed ones straightened here, under their new ids
            for (const c of plan.changed) {
                const f = read(reused.orthosDir).find(x => x.facadeId === c.id)!;
                expect(f.image).toBe(`facade_${c.id}.png`);
                expect(fs.existsSync(path.join(reused.orthosDir, f.image))).toBe(true);
                expect(reused.reports.some(r => r.facadeId === c.id)).toBe(true);
            }
        } finally {
            fs.rmSync(work, { recursive: true, force: true });
        }
    }, 240_000);
});
