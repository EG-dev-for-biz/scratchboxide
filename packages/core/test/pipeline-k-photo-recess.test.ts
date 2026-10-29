/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K's window recesses, moved after the geometry and texture fixes: tile_refine's photometric relief analyses and
 * exports the facade orthos but carves nothing (--relief-no-carve), and the facade lattice recesses the windows it reads
 * on the straightened photo (facade-lattice.ts PHOTO_RECESS, the relief's own contrast rule), never shallower than the
 * scan measures them.
 */

import { describe, expect, it, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { facadeSamples, latticeFacade, PHOTO_RECESS, photoRecessDepth, type ReliefFacade } from '../src/node/3d-engine/staged-location/facade-lattice';
import { parseGlbBytes, readAccessor } from '../src/node/3d-engine/staged-location/glb-bytes';

// a facade in the plane z = 0 facing +z (as facade-lattice.test.ts): windows 1.2 m wide every 3 m, 1.6 m tall on 3 storeys
const PX = 0.1, W = 120, H = 90;
const f: ReliefFacade = { facadeId: 7, image: 'f.png', centroid: [0, 0, 0], normal: [0, 0, 1], axisS: [1, 0, 0], axisT: [0, 1, 0], sMin: 0, sMax: 12, tMin: 0, tMax: 9, pixel: PX, width: W, height: H, orthoSMin: 0, orthoTMax: 9, coverage: 1 };
const isWindow = (s: number, t: number) => { const ss = s % 3, tt = t % 3; return ss > 0.9 && ss < 2.1 && tt > 0.7 && tt < 2.3; };

function photo(windowGrey: number): { rgba: Uint8Array; width: number; height: number } {
    const rgba = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const s = (x + 0.5) * PX, t = 9 - (y + 0.5) * PX, v = isWindow(s, t) ? windowGrey : 200;
        rgba.set([v, v, v, 255], (y * W + x) * 4);
    }
    return { rgba, width: W, height: H };
}

/** An uncarved scan: a flat 0.25 m grid at depth `windowDepth` in the windows and 0 elsewhere. */
function scan(windowDepth = 0): Float32Array {
    const out: number[] = [];
    const z = (s: number, t: number) => (isWindow(s, t) ? windowDepth : 0);
    for (let s = 0; s < 12; s += 0.25) for (let t = 0; t < 9; t += 0.25) {
        const a = [s, t, z(s, t)], b = [s + 0.25, t, z(s + 0.25, t)], c = [s + 0.25, t + 0.25, z(s + 0.25, t + 0.25)], d = [s, t + 0.25, z(s, t + 0.25)];
        out.push(...a, ...b, ...c, ...a, ...c, ...d);
    }
    return Float32Array.from(out);
}

const cellOf = (r: { s: number[]; t: number[]; depth: number[][] }, sv: number, tv: number) => r.depth[r.t.findIndex((x, i) => tv >= x && tv < r.t[i + 1])][r.s.findIndex((x, i) => sv >= x && sv < r.s[i + 1])];

describe('pipeline K: window recesses read from the straightened photo', () => {
    it('follows the photometric relief rule: no recess below contrastLo, recessMin..recessMax between', () => {
        expect(photoRecessDepth(0.05)).toBeUndefined();
        expect(photoRecessDepth(PHOTO_RECESS.contrastLo)).toBeCloseTo(PHOTO_RECESS.recessMin, 6);
        expect(photoRecessDepth(0.9)).toBeCloseTo(PHOTO_RECESS.recessMax, 6);
    });

    it('recesses the repeated windows on an uncarved scan, keeps the wall on the plane, only when asked', () => {
        const flat = latticeFacade(f, photo(40), facadeSamples(scan(), f))!;
        expect(Math.abs(cellOf(flat, 1.5, 1.5))).toBeLessThan(0.02);
        expect(flat.photoRecessCells).toBeUndefined();
        const r = latticeFacade(f, photo(40), facadeSamples(scan(), f), undefined, undefined, true)!;
        // contrast 1 - 40/200 = 0.8: the full recess
        expect(cellOf(r, 1.5, 1.5)).toBeCloseTo(-PHOTO_RECESS.recessMax, 3);
        expect(cellOf(r, 10.5, 7.5)).toBeCloseTo(-PHOTO_RECESS.recessMax, 3);
        expect(Math.abs(cellOf(r, 0.4, 2.8))).toBeLessThan(0.02);
        expect(r.photoRecessCells).toBeGreaterThanOrEqual(12);
    });

    it('does not recess windows barely darker than the wall, and keeps a recess the scan measures deeper', () => {
        const faint = latticeFacade(f, photo(190), facadeSamples(scan(), f), undefined, undefined, true)!;
        expect(Math.abs(cellOf(faint, 1.5, 1.5))).toBeLessThan(0.02);
        const deep = latticeFacade(f, photo(40), facadeSamples(scan(-0.6), f), undefined, undefined, true)!;
        expect(cellOf(deep, 1.5, 1.5)).toBeCloseTo(-0.6, 2);
    });
});

const REPO = path.resolve(__dirname, '../../..');
const TILE = path.join(REPO, 'public/tiles/scan_studio_tile_esb_77197_98526.glb');
const WORK = path.join(REPO, 'test-results/tile-refine-no-carve');
const BIN = path.join(WORK, 'tile_refine');

/** Every _RELIEF_HEIGHT value of a GLB (none when it carries no relief attribute). */
function reliefHeights(file: string): number[] {
    const g = parseGlbBytes(fs.readFileSync(file));
    const out: number[] = [];
    for (const m of (g.json as any).meshes ?? []) for (const p of m.primitives ?? []) if (p.attributes?._RELIEF_HEIGHT !== undefined) out.push(...readAccessor(g, p.attributes._RELIEF_HEIGHT).data);
    return out;
}

describe.skipIf(!fs.existsSync(TILE))('tile_refine --relief-no-carve on the photogrammetric test tile', () => {
    const run = (tag: string, extra: string[]) => {
        const orthos = path.join(WORK, `${tag}_orthos`), stats = path.join(WORK, `${tag}_stats.json`), textured = path.join(WORK, `${tag}_textured.glb`);
        fs.rmSync(orthos, { recursive: true, force: true });
        execFileSync(BIN, ['--input', TILE, '--isolate', '--out-textured', textured, '--out-clay', path.join(WORK, `${tag}_clay.glb`), '--stats', stats, '--relief-orthos', orthos, ...extra], { stdio: 'pipe', timeout: 300_000 });
        return { orthos, stats: JSON.parse(fs.readFileSync(stats, 'utf8')), textured };
    };
    let carved: ReturnType<typeof run>, uncarved: ReturnType<typeof run>;

    beforeAll(() => {
        fs.mkdirSync(WORK, { recursive: true });
        const include = path.join(REPO, 'packages/core/src/native/3d-engine/include');
        const sources = [path.join(REPO, 'scripts/tile_refine.cpp'), ...fs.readdirSync(include).map(x => path.join(include, x))];
        if (!fs.existsSync(BIN) || fs.statSync(BIN).mtimeMs < Math.max(...sources.map(x => fs.statSync(x).mtimeMs))) {
            execFileSync(process.env.CXX || 'clang++', ['-std=c++20', '-O3', '-pthread', '-I', include, path.join(REPO, 'scripts/tile_refine.cpp'), '-o', BIN, '-lz'], { stdio: 'pipe', timeout: 900_000 });
        }
        carved = run('carved', []);
        uncarved = run('uncarved', ['--relief-no-carve']);
    }, 1_500_000);

    it('exports the same facade orthos as the carving run', () => {
        const ids = (dir: string) => (JSON.parse(fs.readFileSync(path.join(dir, 'facades.json'), 'utf8')).facades as Array<{ facadeId: number }>).map(x => x.facadeId).sort((a, b) => a - b);
        expect(ids(uncarved.orthos).length).toBeGreaterThan(0);
        expect(ids(uncarved.orthos)).toEqual(ids(carved.orthos));
        for (const id of ids(uncarved.orthos).slice(0, 5)) expect(fs.existsSync(path.join(uncarved.orthos, `facade_${id}.png`))).toBe(true);
    });

    it('carves nothing: no facade treated, no recess in the written scan', () => {
        expect(carved.stats.relief.regionsTreated).toBeGreaterThan(0);
        expect(uncarved.stats.relief.regionsTreated).toBe(0);
        expect(reliefHeights(carved.textured).some(v => v < -0.05)).toBe(true);
        expect(reliefHeights(uncarved.textured).every(v => v === 0)).toBe(true);
    });
});
