/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The replica scorecard (replica-scorecard.ts) on a synthetic district: a striped block on a flat street, the "reference";
 * the same block (a perfect replica), the block moved 4 m (a wrong replica) and the block in clay. Checks the camera
 * maths, the structure split and mask, that the masked metrics rank the arms, the judges' protocol with a fake client
 * (shuffled order mapped back, replies parsed, defects kept) and the committed camera data. No network, no billed call.
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { SRGB8_TO_LINEAR } from '../src/common/spatial/photogrammetric-delight';
import { composeGrid, perceptualScores, renderPng, renderTriangles, type JudgeClient } from '../src/node/3d-engine/staged-location/photo-match-eval';
import {
    aggregateReplicaRuns, asImage, classifyStructure, judgeBelievability, judgeReplicaView, maskOverlay, parseBelievabilityReply, parseReplicaReply, replicaCamera,
    splitStructure, structureMask, validateCameraSet, type PlanGrids
} from '../src/node/3d-engine/staged-location/replica-scorecard';
import type { TileTriangles } from '../src/node/3d-engine/staged-location/tile-texture-transfer';

const SHOTS = path.resolve(__dirname, '../../../test-results/screenshots/replica_scorecard');

function stripes(size: number, a: number[], b: number[]): TileTriangles['textures'][number] {
    const linear = new Float32Array(size * size * 3);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const c = (Math.floor(x / 16) + Math.floor(y / 16)) % 2 ? a : b;
        for (let k = 0; k < 3; k++) linear[(y * size + x) * 3 + k] = SRGB8_TO_LINEAR[c[k]];
    }
    return { width: size, height: size, linear, repeatS: false, repeatT: false };
}

/** Quads (4 corners each) as a triangle soup on texture 0 (or flat colour with tex -1). */
function soup(quads: number[][][], tex: TileTriangles['textures'][number] | null, flat = [0.3, 0.3, 0.3]): TileTriangles {
    const P: number[] = [], UV: number[] = [], N: number[] = [], T: number[] = [], F: number[] = [];
    for (const q of quads) {
        const uv = [[0, 1], [1, 1], [1, 0], [0, 0]];
        const e1 = q[1].map((v, i) => v - q[0][i]), e2 = q[3].map((v, i) => v - q[0][i]);
        const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        const l = Math.hypot(n[0], n[1], n[2]);
        for (const tri of [[0, 1, 2], [0, 2, 3]]) {
            for (const k of tri) { P.push(...q[k]); UV.push(...uv[k]); }
            N.push(n[0] / l, n[1] / l, n[2] / l); T.push(tex ? 0 : -1); F.push(...flat);
        }
    }
    return { positions: Float32Array.from(P), uvs: Float32Array.from(UV), normals: Float32Array.from(N), texture: Int32Array.from(T), flatLinear: Float32Array.from(F), textures: tex ? [tex] : [] };
}

/** A 10 x 12 x 10 m block centred at (cx, cz), four walls and a roof. */
function block(cx: number, cz: number, tex: TileTriangles['textures'][number]): TileTriangles {
    const x0 = cx - 5, x1 = cx + 5, z0 = cz - 5, z1 = cz + 5, h = 12;
    return soup([
        [[x0, 0, z1], [x1, 0, z1], [x1, h, z1], [x0, h, z1]], [[x1, 0, z0], [x0, 0, z0], [x0, h, z0], [x1, h, z0]],
        [[x0, 0, z0], [x0, 0, z1], [x0, h, z1], [x0, h, z0]], [[x1, 0, z1], [x1, 0, z0], [x1, h, z0], [x1, h, z1]],
        [[x0, h, z1], [x1, h, z1], [x1, h, z0], [x0, h, z0]]
    ], tex);
}

const street = () => soup([[[-60, 0, 60], [60, 0, 60], [60, 0, -60], [-60, 0, -60]]], null, [0.18, 0.18, 0.2]);
const merge = (a: TileTriangles, b: TileTriangles): TileTriangles => {
    const cat = <A extends Float32Array | Int32Array>(x: A, y: A, C: new (n: number) => A) => { const o = new C(x.length + y.length); o.set(x); o.set(y, x.length); return o; };
    return { positions: cat(a.positions, b.positions, Float32Array), uvs: cat(a.uvs, b.uvs, Float32Array), normals: cat(a.normals, b.normals, Float32Array), texture: cat(a.texture, b.texture, Int32Array), flatLinear: cat(a.flatLinear, b.flatLinear, Float32Array), textures: [...a.textures, ...b.textures] };
};

/** Plan grids over [-60, 60]^2 at 1 m: ground 0, top 12 inside the block at (0, 0), else 0. */
function grids(): PlanGrids {
    const nx = 120, nz = 120, top = new Float32Array(nx * nz), ground = new Float32Array(nx * nz);
    for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) { const x = -60 + i + 0.5, z = -60 + k + 0.5; if (Math.abs(x) < 5 && Math.abs(z) < 5) top[k * nx + i] = 12; }
    return { cellMeters: 1, x0: -60, z0: -60, nx, nz, top, ground };
}

/** A fake judge: replies in the format the prompt asks for, scoring each image by its mean red level (a pixel rule, no model). */
function fakeJudge(): { client: JudgeClient; prompts: string[] } {
    const prompts: string[] = [];
    const client: JudgeClient = {
        async generate(params) {
            const parts = params.contents[0].parts;
            prompts.push(parts.filter(p => p.text).map(p => p.text).join('\n'));
            const images = parts.filter(p => p.inlineData).map(p => Buffer.from(p.inlineData!.data, 'base64'));
            const text = parts.some(p => p.text?.includes('believability'))
                ? JSON.stringify({ believability: 4, defects: [{ what: 'flat grey block', where: 'centre', severity: 0.7 }, { what: 'no windows', where: 'centre', severity: 2 }], note: 'synthetic' })
                : JSON.stringify({ renders: images.slice(1).map((png, k) => ({ image: k + 1, shape: 5, materials: 1 + (png.length % 9), detail: 4, errors: 6, overall: 1 + (k % 10), defects: [{ what: `defect of image ${k + 1}`, where: 'left', severity: 0.4 }], note: '' })) });
            return { response: { candidates: [{ content: { parts: [{ text }] } }] }, model: 'fake-judge' };
        }
    };
    return { client, prompts };
}

describe('replica scorecard', () => {
    const red = [190, 60, 40], cream = [230, 220, 190];
    const view = { eye: [0, 1.6, 40] as [number, number, number], target: [0, 6, 0] as [number, number, number], hfovDeg: 60 };

    it('builds the pinhole camera of a view: the target projects to the image centre, image y down, world up', () => {
        const cam = replicaCamera(view, 320, 200);
        const d = [view.target[0] - cam.eye[0], view.target[1] - cam.eye[1], view.target[2] - cam.eye[2]];
        const z = d[0] * cam.fwd[0] + d[1] * cam.fwd[1] + d[2] * cam.fwd[2];
        const x = cam.cx + (cam.fx * (d[0] * cam.right[0] + d[1] * cam.right[1] + d[2] * cam.right[2])) / z;
        const y = cam.cy - (cam.fy * (d[0] * cam.up[0] + d[1] * cam.up[1] + d[2] * cam.up[2])) / z;
        expect(x).toBeCloseTo(160, 6);
        expect(y).toBeCloseTo(100, 6);
        expect(cam.up[1]).toBeGreaterThan(0.9);
        // looking down -z: right = fwd x up = (0, 0, -1) x (0, 1, 0) = (1, 0, 0)
        expect(cam.right[0]).toBeCloseTo(1, 6);
        expect(cam.fx).toBeCloseTo(160 / Math.tan(Math.PI / 6), 6);
    });

    it('splits raised structure from the street, masks it per view, and ranks a moved or clay replica below a perfect one', () => {
        const tex = stripes(64, red, cream);
        const reference = merge(block(0, 0, tex), street());
        const flags = classifyStructure(reference, grids());
        // 10 block triangles (4 walls + roof), 2 street triangles
        expect(Array.from(flags)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0]);
        const split = splitStructure(reference, flags);
        expect(split.structure.texture.length).toBe(10);
        expect(split.rest.texture.length).toBe(2);
        const cam = replicaCamera(view, 640, 400);
        const mask = structureMask(split, cam);
        const share = mask.reduce((s, x) => s + x, 0) / mask.length;
        // the block's front face spans 10 x 12 m at 35 m: about 0.287 x 0.343 of the frame's tangent half-widths
        expect(share).toBeGreaterThan(0.05);
        expect(share).toBeLessThan(0.3);
        expect(mask[200 * 640 + 320]).toBe(1);          // the centre is the block
        expect(mask[395 * 640 + 320]).toBe(0);          // the street at the bottom edge
        expect(mask[5 * 640 + 5]).toBe(0);              // the background

        const rRef = renderTriangles([reference], cam);
        const rSame = renderTriangles([block(0, 0, tex), street()], cam);
        const rMoved = renderTriangles([block(4, 0, tex), street()], cam);
        const rClay = renderTriangles([block(0, 0, tex)], cam, { clay: true, context: [street()] });
        const same = perceptualScores(asImage(rRef), rSame, mask), moved = perceptualScores(asImage(rRef), rMoved, mask), clay = perceptualScores(asImage(rRef), rClay, mask);
        expect(same.ssim).toBeCloseTo(1, 3);
        expect(same.colourDeltaE).toBeCloseTo(0, 3);
        expect(same.edgeChamferPx).not.toBeNull();
        expect(same.edgeChamferPx!).toBeCloseTo(0, 3);
        expect(same.coverage).toBe(1);
        expect(moved.ssim!).toBeLessThan(same.ssim! - 0.1);
        expect(moved.edgeChamferPx).not.toBeNull();
        expect(moved.edgeChamferPx!).toBeGreaterThan(1);
        expect(clay.colourDeltaE!).toBeGreaterThan(10);

        const overlay = maskOverlay(rRef, mask);
        expect(overlay.rgba.length).toBe(rRef.rgba.length);
        const png = composeGrid([{ image: rRef, label: 'REFERENCE' }, { image: rSame, label: 'SAME' }, { image: rMoved, label: 'MOVED 4 M' }, { image: rClay, label: 'CLAY' }, { image: overlay, label: 'MASK' }], { tileWidth: 400, columns: 3 });
        expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
        fs.mkdirSync(SHOTS, { recursive: true });
        fs.writeFileSync(path.join(SHOTS, 'replica_synthetic.png'), png);
    });

    it('judges blind: shuffled renders mapped back to their arms, every repeat; believability alone; defects kept and clamped', async () => {
        const cam = replicaCamera(view, 96, 64);
        const tex = stripes(32, red, cream);
        const pngs = [block(0, 0, tex), block(4, 0, tex)].map(b => renderPng(renderTriangles([b, street()], cam)));
        const ref = renderPng(renderTriangles([merge(block(0, 0, tex), street())], cam));
        const { client, prompts } = fakeJudge();
        const runs = await judgeReplicaView({ client, place: 'Synthetic Square', reference: ref, renders: [{ armId: 'b', png: pngs[0] }, { armId: 'c', png: pngs[1] }], repeats: 3, seed: 's' });
        expect(runs).toHaveLength(3);
        for (const r of runs) {
            expect(r.order.slice().sort()).toEqual(['b', 'c']);
            // overall = 1 + position: the arm shown first got 1
            expect(r.scores[r.order[0]].overall).toBe(1);
            expect(r.scores[r.order[1]].overall).toBe(2);
            expect(r.scores[r.order[0]].defects[0].what).toBe('defect of image 1');
        }
        const agg = aggregateReplicaRuns(runs, ['b', 'c']);
        expect(agg.b.overall.n).toBe(3);
        expect(agg.b.overall.mean + agg.c.overall.mean).toBeCloseTo(3, 6);
        expect(prompts[0]).toContain('Synthetic Square');
        expect(prompts[0]).toContain('Image 0: the reference');
        const bel = await judgeBelievability({ client, png: pngs[0], repeats: 2 });
        expect(bel.map(b => b.believability)).toEqual([4, 4]);
        expect(bel[0].defects[1].severity).toBe(1);   // 2 clamped to 1
    });

    it('reads judge replies strictly', () => {
        expect(parseReplicaReply('not json', 1).problems).toEqual(['the reply is not JSON']);
        expect(parseReplicaReply('{"renders":[{"image":1,"shape":11,"materials":1,"detail":1,"errors":1,"overall":1}]}', 1).problems[0]).toContain('shape is 11');
        expect(parseReplicaReply('```json\n{"renders":[{"image":1,"shape":3,"materials":2,"detail":2,"errors":4,"overall":3,"defects":[{"what":"x"}]}]}\n```', 2).problems).toEqual(['no entry for image 2']);
        const ok = parseReplicaReply('{"renders":[{"image":1,"shape":3,"materials":2,"detail":2,"errors":4,"overall":3,"defects":[{"what":"bridge missing","where":"centre","severity":0.9},{"nope":1}]}]}', 1);
        expect(ok.scores[0].defects).toEqual([{ what: 'bridge missing', where: 'centre', severity: 0.9 }]);
        expect(parseBelievabilityReply('{"believability":0}').problems[0]).toContain('believability is 0');
        expect(parseBelievabilityReply('{"believability":7,"defects":[]}').score?.believability).toBe(7);
    });

    it('the committed Federation Square camera set is valid: 4 street, 2 aerial, 2 facade views in the tile frame', () => {
        const file = path.resolve(__dirname, '../../../scripts/replica-scorecard/federation-square.cameras.json');
        const set = validateCameraSet(JSON.parse(fs.readFileSync(file, 'utf8')));
        const kinds = set.views.reduce<Record<string, number>>((m, v) => ({ ...m, [v.kind]: (m[v.kind] ?? 0) + 1 }), {});
        expect(kinds).toEqual({ street: 4, aerial: 2, facade: 2 });
        for (const v of set.views.filter(x => x.kind === 'aerial')) {
            const c = replicaCamera(v, set.width, set.height);
            expect(Math.asin(-c.fwd[1]) * 180 / Math.PI).toBeGreaterThan(30);   // looking down
            expect(v.eye[1] - v.target[1]).toBeGreaterThan(45);                // about 60 m up
        }
        expect(() => validateCameraSet({ ...set, views: [{ ...set.views[0], eye: [0, 0, 0], target: [0, 5, 0] }] })).toThrow(/straight up or down/);
    });
});
