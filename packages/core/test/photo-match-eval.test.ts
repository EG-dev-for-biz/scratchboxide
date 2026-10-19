/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The photo-match evaluator (photo-match-eval.ts) on synthetic inputs: a textured wall rendered from a known pinhole pose, a
 * "photo" that is that render (and one that is shifted), and a fake judge that scores renders by their pixels. No network, no
 * billed call; screenshots under test-results/screenshots/photo_match/.
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import type { PinholeCamera } from '../src/common/spatial/texture-pass-contracts';
import { SRGB8_TO_LINEAR } from '../src/common/spatial/photogrammetric-delight';
import {
    aggregateRuns, composeGrid, coverageMask, judgePrompt, judgeView, parseJudgeReply, perceptualScores, PHOTO_MATCH_BACKGROUND, renderPng, renderTriangles, seededShuffle,
    type JudgeClient
} from '../src/node/3d-engine/staged-location/photo-match-eval';
import type { TileTriangles } from '../src/node/3d-engine/staged-location/tile-texture-transfer';

const SHOTS = path.resolve(__dirname, '../../../test-results/screenshots/photo_match');

/** A camera at the origin looking down +z, x right, y up. */
function camera(w = 160, h = 120, fovDeg = 60): PinholeCamera {
    const fx = w / 2 / Math.tan((fovDeg * Math.PI) / 360);
    return { eye: [0, 0, 0], right: [1, 0, 0], up: [0, 1, 0], fwd: [0, 0, 1], fx, fy: fx, cx: w / 2, cy: h / 2, width: w, height: h };
}

/** A texture of vertical stripes (period 8 texels) in two colours, linear RGB. */
function stripes(size: number, a: [number, number, number], b: [number, number, number]): TileTriangles['textures'][number] {
    const linear = new Float32Array(size * size * 3);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const c = Math.floor(x / 8) % 2 ? a : b;
        for (let k = 0; k < 3; k++) linear[(y * size + x) * 3 + k] = SRGB8_TO_LINEAR[c[k]];
    }
    return { width: size, height: size, linear, repeatS: false, repeatT: false };
}

/** A textured quad facing the camera at depth z, spanning [x0, x1] x [y0, y1]. */
function wall(z: number, x0: number, x1: number, y0: number, y1: number, tex: TileTriangles['textures'][number]): TileTriangles {
    const P = [x0, y0, z, x1, y0, z, x1, y1, z, x0, y0, z, x1, y1, z, x0, y1, z];
    // UV (0, 0) is the image's top-left: v grows downwards
    const UV = [0, 1, 1, 1, 1, 0, 0, 1, 1, 0, 0, 0];
    return { positions: Float32Array.from(P), uvs: Float32Array.from(UV), normals: Float32Array.from([0, 0, -1, 0, 0, -1]), texture: Int32Array.from([0, 0]), flatLinear: new Float32Array(6), textures: [tex] };
}

const px = (r: { width: number; rgba: Uint8Array }, x: number, y: number) => Array.from(r.rgba.subarray((y * r.width + x) * 4, (y * r.width + x) * 4 + 3));

describe('photo-match evaluator', () => {
    const red: [number, number, number] = [200, 40, 30], cream: [number, number, number] = [230, 220, 190];

    it('renders a textured wall from the pose: perspective-correct texture, background outside, nearest surface wins', () => {
        const cam = camera();
        const r = renderTriangles([wall(10, -3, 3, -2, 2, stripes(64, red, cream))], cam);
        expect(r.width).toBe(160);
        expect(r.height).toBe(120);
        // the wall spans x in [-3, 3] at 10 m: fx * 0.3 = 41.6 px each side of the centre
        expect(r.coverage[60 * 160 + 80]).toBe(1);
        expect(r.coverage[60 * 160 + 10]).toBe(0);
        expect(px(r, 5, 5)).toEqual([...PHOTO_MATCH_BACKGROUND]);
        // a stripe of each colour inside the wall (headlit square-on: shade 1)
        const row = Array.from({ length: 70 }, (_, k) => px(r, 45 + k, 60));
        expect(row.some(c => Math.abs(c[0] - red[0]) <= 3 && Math.abs(c[1] - red[1]) <= 3)).toBe(true);
        expect(row.some(c => Math.abs(c[0] - cream[0]) <= 3 && Math.abs(c[2] - cream[2]) <= 3)).toBe(true);
        // a nearer wall in front of the left half hides it
        const front = wall(5, -3, 0, -1, 1, stripes(16, [20, 160, 40], [20, 160, 40]));
        const r2 = renderTriangles([wall(10, -3, 3, -2, 2, stripes(64, red, cream)), front], cam);
        expect(px(r2, 60, 60)[1]).toBeGreaterThan(140);
        expect(px(r2, 100, 60)[1]).toBeLessThan(140);
    });

    it('hides what the real place hides: an occluder nearer than the arm masks it', () => {
        const cam = camera();
        const occ = new Float32Array(160 * 120).fill(Infinity);
        for (let y = 0; y < 120; y++) for (let x = 0; x < 80; x++) occ[y * 160 + x] = 5; // something at 5 m on the left half
        const r = renderTriangles([wall(10, -3, 3, -2, 2, stripes(64, red, cream))], cam, { occluderDepth: occ });
        expect(r.coverage[60 * 160 + 60]).toBe(0);
        expect(px(r, 60, 60)).toEqual([...PHOTO_MATCH_BACKGROUND]);
        expect(r.coverage[60 * 160 + 100]).toBe(1);
        // the arm's own surface in the occluder (the scan at the same depth) does not hide it
        const same = renderTriangles([wall(10, -3, 3, -2, 2, stripes(64, red, cream))], cam, { occluderDepth: new Float32Array(160 * 120).fill(9.9) });
        expect(same.coverage[60 * 160 + 80]).toBe(1);
    });

    it('draws the arm in its context: the same street around every arm, depth-tested with it, the coverage the arm\'s alone', () => {
        const cam = camera();
        const green: [number, number, number] = [20, 160, 40];
        // the street: a wall behind the target (12 m) spanning the whole view, and a post in front of its left part (6 m)
        const context = [wall(12, -20, 20, -20, 20, stripes(16, green, green)), wall(6, -2.2, -1.2, -1, 1, stripes(16, [10, 10, 10], [10, 10, 10]))];
        const r = renderTriangles([wall(10, -3, 3, -2, 2, stripes(64, red, cream))], cam, { context });
        // the target is drawn over the street behind it, and the post in front hides part of it
        expect(px(r, 5, 5)[1]).toBeGreaterThan(140);                 // the street, not the grey background
        expect(px(r, 100, 60)[1]).toBeLessThan(140);                 // the target in front of the street wall
        expect(px(r, 42, 60)[0]).toBeLessThan(40);                   // the post in front of the target
        // the coverage (the metrics' mask) is the target's: not the street, not where the post hides it
        expect(r.coverage[5 * 160 + 5]).toBe(0);
        expect(r.coverage[60 * 160 + 100]).toBe(1);
        expect(r.coverage[60 * 160 + 42]).toBe(0);
        expect(r.triangles).toBe(2);
        // every arm sees the same context: an empty arm renders the street exactly as a context-only render
        const bare = renderTriangles([], cam, { context });
        const bare2 = renderTriangles([], cam, { context });
        expect(Buffer.from(bare.rgba).equals(Buffer.from(bare2.rgba))).toBe(true);
        expect(bare.coverage.every(c => c === 0)).toBe(true);
        fs.mkdirSync(SHOTS, { recursive: true });
        fs.writeFileSync(path.join(SHOTS, 'photo_match_in_context.png'), composeGrid([{ image: bare, label: 'CONTEXT' }, { image: r, label: 'ARM IN CONTEXT' }], { tileWidth: 320, columns: 2 }));
    });

    it('clips a wall that passes behind the camera without smearing it across the image', () => {
        // a floor from 1 m behind the eye to 20 m ahead, 1.5 m below it
        const P = [-2, -1.5, -1, 2, -1.5, -1, 2, -1.5, 20, -2, -1.5, -1, 2, -1.5, 20, -2, -1.5, 20];
        const floor: TileTriangles = { positions: Float32Array.from(P), uvs: new Float32Array(12), normals: Float32Array.from([0, 1, 0, 0, 1, 0]), texture: Int32Array.from([-1, -1]), flatLinear: Float32Array.from([0.2, 0.2, 0.2, 0.2, 0.2, 0.2]), textures: [] };
        const r = renderTriangles([floor], camera());
        // nothing above the horizon; the bottom row is floor
        for (let x = 0; x < 160; x++) expect(r.coverage[30 * 160 + x]).toBe(0);
        expect(r.coverage[119 * 160 + 80]).toBe(1);
    });

    it('scores a render that matches the photo above one that is shifted, inside the building mask', () => {
        const cam = camera(320, 240);
        const tex = stripes(64, red, cream);
        const truth = renderTriangles([wall(10, -3, 3, -2, 2, tex)], cam);
        const photo = { width: truth.width, height: truth.height, rgba: truth.rgba };
        const mask = coverageMask(truth);
        const same = perceptualScores(photo, truth, mask);
        const shifted = perceptualScores(photo, renderTriangles([wall(10, -2.8, 3.2, -2, 2, tex)], cam), mask);
        const flat = perceptualScores(photo, renderTriangles([wall(10, -3, 3, -2, 2, stripes(64, [150, 150, 150], [150, 150, 150]))], cam), mask);
        expect(same.coverage).toBe(1);
        expect(same.ssim!).toBeGreaterThan(0.99);
        expect(same.colourDeltaE!).toBeLessThan(0.5);
        expect(same.edgeChamferPx!).toBeLessThan(0.5);
        expect(shifted.ssim!).toBeLessThan(same.ssim!);
        expect(shifted.edgeChamferPx!).toBeGreaterThan(same.edgeChamferPx!);
        expect(flat.colourDeltaE!).toBeGreaterThan(10);
    });

    it('judges blind: the order is reshuffled per repeat and the scores come back to the right arms', async () => {
        const cam = camera(96, 72);
        const good = renderTriangles([wall(10, -3, 3, -2, 2, stripes(32, red, cream))], cam);
        const bad = renderTriangles([wall(10, -3, 3, -2, 2, stripes(32, [40, 40, 200], [40, 40, 200]))], cam);
        const pngs: Record<string, string> = { good: renderPng(good).toString('base64'), bad: renderPng(bad).toString('base64') };
        const seenOrders: string[][] = [];
        // the fake judge tells the renders apart by their pixels only (it is never told which arm is which)
        const client: JudgeClient = {
            async generate(params) {
                const imgs = params.contents[0].parts.filter(p => p.inlineData).slice(1).map(p => p.inlineData!.data);
                const arms = imgs.map(d => (d === pngs.good ? 'good' : d === pngs.bad ? 'bad' : '?'));
                seenOrders.push(arms);
                const renders = arms.map((a, k) => ({ image: k + 1, shape: a === 'good' ? 9 : 4, materials: a === 'good' ? 8 + seenOrders.length % 2 : 2, detail: 7, errors: 6, overall: a === 'good' ? 9 : 3, note: a }));
                return { model: 'fake-judge', response: { candidates: [{ content: { parts: [{ text: JSON.stringify({ renders }) }] }, finishReason: 'STOP' }] } };
            }
        };
        const photo = { bytes: renderPng(good), mimeType: 'image/png' };
        const runs = await judgeView({ client, place: 'a test wall', photo, renders: [{ armId: 'good', png: renderPng(good) }, { armId: 'bad', png: renderPng(bad) }], repeats: 4, seed: 'wall' });
        expect(runs).toHaveLength(4);
        expect(seenOrders.every(o => !o.includes('?'))).toBe(true);
        expect(new Set(seenOrders.map(o => o.join(','))).size).toBe(2);
        for (const r of runs) { expect(r.scores.good.overall).toBe(9); expect(r.scores.bad.overall).toBe(3); expect(r.notes.good).toBe('good'); }
        const stats = aggregateRuns(runs, ['good', 'bad']);
        expect(stats.good.overall).toEqual({ mean: 9, sd: 0, min: 9, max: 9 });
        expect(stats.good.materials.mean).toBe(8.5);
        expect(stats.good.materials.sd).toBe(0.5);
        expect(stats.bad.shape.mean).toBe(4);

        fs.mkdirSync(SHOTS, { recursive: true });
        const grid = composeGrid([{ image: good, label: 'REAL PHOTO' }, { image: good, label: 'ARM GOOD', sublabel: `JUDGE ${stats.good.overall.mean}` }, { image: bad, label: 'ARM BAD', sublabel: `JUDGE ${stats.bad.overall.mean}` }], { tileWidth: 240, title: 'PHOTO MATCH TEST' });
        expect(Array.from(grid.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        fs.writeFileSync(path.join(SHOTS, 'photo_match_eval_grid.png'), grid);
    });

    it('reads the judge reply strictly and shuffles deterministically', () => {
        const ok = parseJudgeReply('```json\n{"renders":[{"image":1,"shape":5,"materials":6,"detail":7,"errors":8,"overall":9,"note":"x"}]}\n```', 1);
        expect(ok.problems).toEqual([]);
        expect(ok.scores[0].overall).toBe(9);
        expect(parseJudgeReply('{"renders":[{"image":1,"shape":11,"materials":6,"detail":7,"errors":8,"overall":9}]}', 1).problems.length).toBe(1);
        expect(parseJudgeReply('{"renders":[]}', 2).problems).toEqual(['no entry for image 1', 'no entry for image 2']);
        expect(parseJudgeReply('not json', 1).problems).toEqual(['the reply is not JSON']);
        // realism and identity are read when present, checked like the rest, and not required of older replies
        const both = parseJudgeReply('{"renders":[{"image":1,"shape":5,"materials":6,"detail":7,"errors":8,"overall":9,"realism":4,"identity":8}]}', 1);
        expect(both.problems).toEqual([]);
        expect([both.scores[0].realism, both.scores[0].identity]).toEqual([4, 8]);
        expect(ok.scores[0].realism).toBeUndefined();
        expect(parseJudgeReply('{"renders":[{"image":1,"shape":5,"materials":6,"detail":7,"errors":8,"overall":9,"realism":0,"identity":8}]}', 1).problems.length).toBe(1);
        expect(judgePrompt('X', 2).closing).toMatch(/- realism: [^\n]*real photograph/);
        expect(judgePrompt('X', 2).closing).toMatch(/- identity: would someone who knows this place recognise it/);
        expect(aggregateRuns([{ order: ['a'], scores: { a: { shape: 1, materials: 1, detail: 1, errors: 1, overall: 1 } }, notes: {}, model: 'm' }], ['a']).a.realism.mean).toBeNaN();
        const a = seededShuffle(['A', 'B', 'C', 'D'], 'x#0'), b = seededShuffle(['A', 'B', 'C', 'D'], 'x#0');
        expect(a).toEqual(b);
        expect([...a].sort()).toEqual(['A', 'B', 'C', 'D']);
    });
});
