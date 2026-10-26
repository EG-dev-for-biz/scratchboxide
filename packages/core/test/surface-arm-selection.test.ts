/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Per-surface arm selection (surface-arm-selection.ts): a surface is found in an arm by node-name prefix or by an oriented
 * box; the crop that shows it is the union of the arms' coverage, padded; the blind judge's shuffled order is mapped back
 * and the grounded references are shown but never scored; and the rule keeps the base arm unless another raises realism
 * clearly without losing identity or inventing content. A fake judge stands in for the model. No network, no billed call.
 */

import { describe, expect, it } from 'vitest';
import { renderTriangles, type JudgeClient } from '../src/node/3d-engine/staged-location/photo-match-eval';
import { replicaCamera, stat, type Stat } from '../src/node/3d-engine/staged-location/replica-scorecard';
import {
    SURFACE_SELECTION_RULE, aggregateSurfaceRuns, cropImage, decideSurfaceArm, judgeSurfaceView, parseSurfaceReply, splitSurface, surfaceCrop,
    surfaceFlags, surfaceJudgePrompt, validateSurfaceArmManifest, type NamedTriangles
} from '../src/node/3d-engine/staged-location/surface-arm-selection';
import type { TileTriangles } from '../src/node/3d-engine/staged-location/tile-texture-transfer';

type Part = { text?: string; inlineData?: { mimeType: string; data: string } };

/** Quads (4 corners each, counter-clockwise seen from outside) in one flat linear colour, each quad its own node. */
function soup(quads: number[][][], names: string[], flat = [0.45, 0.42, 0.38]): NamedTriangles {
    const P: number[] = [], N: number[] = [], T: number[] = [], F: number[] = [], node: number[] = [];
    quads.forEach((q, qi) => {
        const e1 = q[1].map((v, i) => v - q[0][i]), e2 = q[3].map((v, i) => v - q[0][i]);
        const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        const l = Math.hypot(n[0], n[1], n[2]);
        for (const tri of [[0, 1, 2], [0, 2, 3]]) { for (const k of tri) P.push(...q[k]); N.push(n[0] / l, n[1] / l, n[2] / l); T.push(-1); F.push(...flat); node.push(qi); }
    });
    const tris: TileTriangles = { positions: Float32Array.from(P), uvs: new Float32Array((P.length / 9) * 6), normals: Float32Array.from(N), texture: Int32Array.from(T), flatLinear: Float32Array.from(F), textures: [] };
    return { tris, nodeName: t => names[node[t]] };
}

// two walls side by side facing +z: the west one 'w:a' (x -12..-2), the east one 'w:b' (x 2..12), each 8 m high
const walls = () => soup([
    [[-12, 0, 0], [-2, 0, 0], [-2, 8, 0], [-12, 8, 0]],
    [[2, 0, 0], [12, 0, 0], [12, 8, 0], [2, 8, 0]]
], ['w:a/0', 'w:b/0']);

describe('surface arm selection: finding a surface', () => {
    it('by node-name prefix when the arm names it, else by the box', () => {
        const layer = walls();
        const byName = surfaceFlags(layer, { id: 's', nodePrefixes: ['w:b'] });
        expect(Array.from(byName)).toEqual([0, 0, 1, 1]);
        // the box covers the west wall only: a prefix that matches nothing falls through to it
        const byBox = surfaceFlags(layer, { id: 's', nodePrefixes: ['w:zzz'], box: { center: [-7, 4, 0], halfSize: [6, 5, 1] } });
        expect(Array.from(byBox)).toEqual([1, 1, 0, 0]);
        // a rotated box (axes swapped) still tests the centroid along its own axes
        const rotated = surfaceFlags(layer, { id: 's', box: { center: [7, 4, 0], axes: [[0, 1, 0], [1, 0, 0], [0, 0, 1]], halfSize: [5, 6, 1] } });
        expect(Array.from(rotated)).toEqual([0, 0, 1, 1]);
        expect(Array.from(surfaceFlags(layer, { id: 's', nodePrefixes: ['none'] }))).toEqual([0, 0, 0, 0]);
        const split = splitSurface(layer, { id: 's', nodePrefixes: ['w:a'] });
        expect(split.count).toBe(2);
        expect(split.surface.texture.length).toBe(2);
        expect(split.rest.texture.length).toBe(2);
        expect(split.surface.positions[0]).toBe(-12);
    });

    it('the manifest is checked: a base among at least two arms, every surface locatable', () => {
        const ok = { schema: 'scratchbox.surface-arms/1', place: 'p', base: 'transfer', arms: { transfer: { glbs: ['a.glb'] }, paint: { glbs: ['b.glb'] } }, surfaces: [{ id: 's1', nodePrefixes: ['w:a'] }] };
        expect(validateSurfaceArmManifest(ok).base).toBe('transfer');
        expect(() => validateSurfaceArmManifest({ ...ok, base: 'x' })).toThrow(/base arm x/);
        expect(() => validateSurfaceArmManifest({ ...ok, arms: { transfer: { glbs: ['a.glb'] } } })).toThrow(/two arms/);
        expect(() => validateSurfaceArmManifest({ ...ok, surfaces: [{ id: 's1' }, { id: 's1', box: { center: [0, 0, 0], halfSize: [1, 1] } }] })).toThrow(/nodePrefixes, a box.*repeated|repeated.*nodePrefixes/s);
        expect(() => validateSurfaceArmManifest({ ...ok, schema: 'other' })).toThrow(/schema/);
    });
});

describe('surface arm selection: the crop', () => {
    const camera = replicaCamera({ eye: [0, 4, 24], target: [0, 4, 0], hfovDeg: 70 }, 320, 200);

    it('is the padded bounding box of the arms\' coverage, grown to a minimum side, inside the image', () => {
        const layer = walls();
        const west = splitSurface(layer, { id: 's', nodePrefixes: ['w:a'] }).surface;
        const r = renderTriangles([west], camera, { supersample: 1 });
        const crop = surfaceCrop([r], { pad: 0.1, minSide: 64 });
        expect(crop).toBeDefined();
        const { box, pixels } = crop!;
        expect(pixels).toBeGreaterThan(1500);
        // the west wall sits left of centre: the crop does too, and never leaves the image
        expect(box.x0).toBeGreaterThanOrEqual(0);
        expect(box.x1).toBeLessThan(camera.cx);
        expect(box.y0).toBeGreaterThanOrEqual(0);
        expect(box.y1).toBeLessThan(200);
        expect(box.x1 - box.x0 + 1).toBeGreaterThanOrEqual(64);
        // too small a surface gives no crop
        expect(surfaceCrop([r], { minPixels: 1e9 })).toBeUndefined();
        const img = cropImage(r, box, 128);
        expect(img.width).toBe(128);
        expect(img.height).toBe(Math.round(((box.y1 - box.y0 + 1) * 128) / (box.x1 - box.x0 + 1)));
        expect(img.rgba.length).toBe(img.width * img.height * 4);
        // the wall fills the middle of the crop: a lit pixel there, background at the padded edge
        const mid = ((img.height >> 1) * img.width + (img.width >> 1)) * 4;
        expect(img.rgba[mid + 3]).toBe(255);
        expect(img.rgba[mid]).toBeGreaterThan(40);
    });
});

/** A fake judge: scores each treatment by the first byte of its (fake) image, so the shuffled order must be mapped back. */
function fakeJudge(): { client: JudgeClient; calls: Part[][] } {
    const calls: Part[][] = [];
    return {
        calls,
        client: {
            async generate(params) {
                const parts = params.contents[0].parts as Part[];
                calls.push(parts);
                const images: Array<Record<string, unknown>> = [];
                let k = 0;
                for (let i = 0; i < parts.length; i++) {
                    if (!/^Image \d+: a treatment/.test(parts[i].text ?? '')) continue;
                    const v = Buffer.from(parts[i + 1].inlineData!.data, 'base64')[0];
                    k++;
                    images.push({ image: k, realism: v, identity: 10 - v, errors: 9, note: 'n' });
                }
                return { model: 'fake', response: { candidates: [{ content: { parts: [{ text: JSON.stringify({ images }) }] } }] } } as never;
            }
        } as JudgeClient
    };
}

describe('surface arm selection: the judge', () => {
    it('maps the shuffled order back to the arms; grounded references are shown and not scored', async () => {
        const { client, calls } = fakeJudge();
        const runs = await judgeSurfaceView({
            client, place: 'p', view: 'v1', reference: Uint8Array.from([0]), repeats: 4, seed: 'x', lit: true,
            renders: [{ armId: 'transfer', png: Uint8Array.from([4]) }, { armId: 'paint', png: Uint8Array.from([8]) }, { armId: 'scan', png: Uint8Array.from([3]) }],
            grounded: [{ bytes: Uint8Array.from([200]), mimeType: 'image/jpeg' }, { bytes: Uint8Array.from([201]), mimeType: 'image/png' }]
        });
        expect(runs).toHaveLength(4);
        for (const r of runs) {
            expect(r.scores.transfer.realism).toBe(4); expect(r.scores.paint.realism).toBe(8); expect(r.scores.scan.realism).toBe(3);
            expect(r.scores.paint.identity).toBe(2);
            expect([...r.order].sort()).toEqual(['paint', 'scan', 'transfer']);
        }
        expect(new Set(runs.map(r => r.order.join(','))).size).toBeGreaterThan(1); // the order changes between repeats
        const texts = calls[0].map(p => p.text ?? '').join('\n');
        expect(texts).toMatch(/Image G1: a search-grounded reference \(generated; not scored\)/);
        expect(texts).toMatch(/Image G2/);
        expect(texts).toMatch(/one computed sun/);
        expect(texts).toMatch(/one entry for each of images 1 to 3/);
        expect(calls[0].filter(p => p.inlineData).length).toBe(6); // the reference, two grounded, three treatments
        const stats = aggregateSurfaceRuns(runs, ['transfer', 'paint', 'scan']);
        expect(stats.paint.realism).toEqual({ mean: 8, sd: 0, n: 4 });
        expect(stats.scan.identity.mean).toBe(7);
    });

    it('the prompt and the reply reader', () => {
        const p = surfaceJudgePrompt('p', 2, { grounded: 0 });
        expect(p.preamble).not.toMatch(/search-grounded/);
        expect(p.preamble).toMatch(/flat neutral light/);
        const good = parseSurfaceReply('```json\n{"images":[{"image":1,"realism":7,"identity":6,"errors":9,"note":"a"},{"image":2,"realism":3,"identity":5,"errors":8}]}\n```', 2);
        expect(good.problems).toEqual([]);
        expect(good.scores[1]).toEqual({ realism: 3, identity: 5, errors: 8, note: '' });
        expect(parseSurfaceReply('{"images":[{"image":1,"realism":11,"identity":6,"errors":9}]}', 2).problems).toEqual(['image 1: realism is 11', 'no entry for image 2']);
        expect(parseSurfaceReply('not json', 1).problems).toEqual(['the reply is not JSON']);
    });
});

describe('surface arm selection: the rule', () => {
    const s = (mean: number, sd = 0.5, n = 6): Stat => ({ mean, sd, n });
    const base = { realism: s(4), identity: s(7), errors: s(8) };

    it('keeps the base unless realism rises clearly with identity and errors held', () => {
        const d = decideSurfaceArm({
            transfer: base,
            paint: { realism: s(6.5), identity: s(6.9), errors: s(8) }, // clearly better, identity within tolerance
            invented: { realism: s(8), identity: s(7), errors: s(6) }, // most realistic, but invents content
            drifted: { realism: s(7), identity: s(5.5), errors: s(8) }, // loses the place
            noisy: { realism: s(4.6, 2.5, 3), identity: s(7), errors: s(8) }, // the rise is inside the judge's noise
            flat: { realism: s(4.2), identity: s(8), errors: s(9) } // better in every other way, but not more realistic
        }, 'transfer');
        expect(d.chosen).toBe('paint');
        const by = Object.fromEntries(d.verdicts.map(v => [v.arm, v]));
        expect(by.paint.accepted).toBe(true);
        expect(by.invented.accepted).toBe(false); expect(by.invented.reason).toMatch(/errors rose/);
        expect(by.drifted.accepted).toBe(false); expect(by.drifted.reason).toMatch(/identity fell 1.5/);
        expect(by.noisy.accepted).toBe(false); expect(by.noisy.reason).toMatch(/within the judge's noise/);
        expect(by.flat.accepted).toBe(false); expect(by.flat.reason).toMatch(/rose only 0.2/);
        expect(d.reason).toMatch(/^paint: realism \+2.5/);
    });

    it('of several that pass, the most realistic wins; with none, the base stays with every reason', () => {
        const two = decideSurfaceArm({ transfer: base, a: { realism: s(6), identity: s(7), errors: s(8) }, b: { realism: s(7), identity: s(7.2), errors: s(8) } }, 'transfer');
        expect(two.chosen).toBe('b');
        const none = decideSurfaceArm({ transfer: base, a: { realism: s(3), identity: s(7), errors: s(8) } }, 'transfer');
        expect(none.chosen).toBe('transfer');
        expect(none.reason).toMatch(/^kept transfer: a realism fell 1/);
        expect(decideSurfaceArm({ transfer: { realism: stat([]), identity: stat([]), errors: stat([]) }, a: base }, 'transfer').reason).toMatch(/not judged; kept by default/);
        expect(decideSurfaceArm({ transfer: base, a: { realism: stat([]), identity: stat([]), errors: stat([]) } }, 'transfer').verdicts[0].reason).toBe('not judged');
        expect(SURFACE_SELECTION_RULE.minRealismRise).toBe(0.5);
    });
});
