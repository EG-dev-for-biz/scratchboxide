/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The symmetry reading (pipeline-k/symmetry.ts over scratchbox_symmetry.hpp) on synthetic shapes whose answers are known
 * by construction: a formula test of the scores, the axes and the gates. The real-data proof (cached benchmark buildings,
 * with plan controls) is the step-1 proof sheet; nothing here stands in for it.
 *
 *  - a 40 x 20 m block turned 30 degrees: mirror axes at 30 and 120 degrees, 2-fold, not 4-fold;
 *  - a square podium with a tower on its diagonal: two tiers, each 4-fold; the massing mirror-symmetric only about that diagonal;
 *  - facades: one mirror-symmetric (its axis found), one random (no axis), its mirror image across the plan's axis (a
 *    twin, accepted), and a symmetric wall with a patch of one half spoiled: detected only when the patch is masked occluded.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assembleGlb, parseGlbBytes } from '../src/node/3d-engine/staged-location/glb-bytes';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';
import { describeSymmetry, detectSymmetry, stampSymmetryGlb, SYMMETRY_PARAMS, type SymmetryReport } from '../src/node/3d-engine/staged-location/pipeline-k/symmetry';

type Box = { x0: number; x1: number; z0: number; z1: number; top: number };

/** A GLB of each box's roof (a quad at its top), its corners turned by `turnDeg` about the origin in plan. */
function roofsGlb(file: string, boxes: Box[], turnDeg = 0): void {
    const c = Math.cos(turnDeg * Math.PI / 180), s = Math.sin(turnDeg * Math.PI / 180);
    const pos: number[] = [], idx: number[] = [];
    for (const b of boxes) {
        const base = pos.length / 3;
        for (const [x, z] of [[b.x0, b.z0], [b.x1, b.z0], [b.x1, b.z1], [b.x0, b.z1]]) pos.push(c * x - s * z, b.top, s * x + c * z);
        idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
    }
    const p = Float32Array.from(pos), q = Uint32Array.from(idx);
    const bin = new Uint8Array(p.byteLength + q.byteLength);
    bin.set(new Uint8Array(p.buffer), 0);
    bin.set(new Uint8Array(q.buffer), p.byteLength);
    const min = [0, 1, 2].map(k => Math.min(...pos.filter((_, i) => i % 3 === k))), max = [0, 1, 2].map(k => Math.max(...pos.filter((_, i) => i % 3 === k)));
    const json = {
        asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
        buffers: [{ byteLength: bin.byteLength }],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: p.byteLength }, { buffer: 0, byteOffset: p.byteLength, byteLength: q.byteLength }],
        accessors: [{ bufferView: 0, componentType: 5126, count: pos.length / 3, type: 'VEC3', min, max }, { bufferView: 1, componentType: 5125, count: idx.length, type: 'SCALAR' }]
    };
    fs.writeFileSync(file, assembleGlb(json, bin));
}

/** Value noise with 0.6 m cells (deterministic), 40..215. */
function noise(sM: number, tM: number, seed: number): number {
    const h = (i: number, j: number) => { let v = (i * 374761393 + j * 668265263 + seed * 2147483647) | 0; v = Math.imul(v ^ (v >>> 13), 1274126177); return ((v ^ (v >>> 16)) >>> 0) / 4294967295; };
    const fi = sM / 0.6, fj = tM / 0.6, i = Math.floor(fi), j = Math.floor(fj), a = fi - i, b = fj - j;
    const v = (h(i, j) * (1 - a) + h(i + 1, j) * a) * (1 - b) + (h(i, j + 1) * (1 - a) + h(i + 1, j + 1) * a) * b;
    return 40 + 175 * v;
}

const PIXEL = 0.1, HALF_W = 10, HALF_H = 5;

/** A 20 x 10 m facade photo drawn by `lum(s, t)` (s along, t up, both from the centre), with its frame and an optional occluded mask. */
function facade(dir: string, id: number, centroid: number[], normal: number[], axisS: number[], lum: (s: number, t: number) => number, occluded?: (s: number, t: number) => boolean) {
    const W = 2 * HALF_W / PIXEL, H = 2 * HALF_H / PIXEL;
    const rgba = new Uint8Array(W * H * 4), occ = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const s = -HALF_W + (x + 0.5) * PIXEL, t = HALF_H - (y + 0.5) * PIXEL, v = Math.round(lum(s, t)), k = y * W + x;
        rgba.set([v, v, v, 255], k * 4);
        if (occluded?.(s, t)) occ[k] = 255;
    }
    fs.writeFileSync(path.join(dir, `facade_${id}.png`), encodePng(W, H, rgba, 4));
    if (occluded) fs.writeFileSync(path.join(dir, `facade_${id}_occluded.png`), encodePng(W, H, occ, 1));
    return {
        facadeId: id, image: `facade_${id}.png`, centroid, normal, axisS, axisT: [0, 1, 0], sMin: -HALF_W, sMax: HALF_W, tMin: -HALF_H, tMax: HALF_H,
        pixel: PIXEL, width: W, height: H, orthoSMin: -HALF_W, orthoTMax: HALF_H, coverage: 1, ...(occluded ? { occludedMask: `facade_${id}_occluded.png` } : {})
    };
}

const near = (deg: number, want: number, tol: number) => { const d = Math.abs(((deg - want) % 180 + 180) % 180); return Math.min(d, 180 - d) <= tol; };

describe('pipeline K symmetry reading', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-symmetry-'));

    it('finds the two mirror axes and the 2-fold rotation of a turned block, and no 4-fold', async () => {
        const glb = path.join(dir, 'block.glb');
        roofsGlb(glb, [{ x0: -20, x1: 20, z0: -10, z1: 10, top: 30 }], 30);
        const rep = await detectSymmetry({ scanGlb: glb, groundY: 0, footprint: [] });
        const m = rep.plan.massing;
        const axes = m.mirrors.filter(x => x.score >= SYMMETRY_PARAMS.planGate);
        expect(axes.length).toBe(2);
        expect(axes.some(x => near(x.angleDeg, 30, 0.6))).toBe(true);
        expect(axes.some(x => near(x.angleDeg, 120, 0.6))).toBe(true);
        expect(Math.min(...axes.map(x => x.score))).toBeGreaterThan(0.95);
        expect(m.centroid[0]).toBeCloseTo(0, 0);
        expect(m.rotation.order).toBe(2);
        expect(m.rotation.scores[2]).toBeLessThan(0.75);   // 4-fold: a 2:1 block turned a quarter overlaps half of itself
        expect(rep.plan.tiers.length).toBe(1);
    }, 300_000);

    it('reads a podium and an offset tower as two 4-fold tiers, the massing symmetric only about the diagonal they share', async () => {
        const glb = path.join(dir, 'tiers.glb');
        roofsGlb(glb, [
            { x0: -20, x1: 20, z0: -20, z1: 5, top: 10 }, { x0: -20, x1: 5, z0: 5, z1: 20, top: 10 }, { x0: 15, x1: 20, z0: 5, z1: 20, top: 10 },
            { x0: 5, x1: 15, z0: 5, z1: 15, top: 60 }, { x0: 5, x1: 15, z0: 15, z1: 20, top: 10 }
        ]);
        const rep = await detectSymmetry({ scanGlb: glb, groundY: 0, footprint: [[[-20, -20], [20, -20], [20, 20], [-20, 20]]] });
        const tiers = rep.plan.tiers;
        expect(tiers.length).toBe(2);
        expect(tiers[0].outline.rotation.order).toBe(4);
        expect(tiers[1].levelM).toBeGreaterThan(50);
        expect(tiers[1].outline.mass).toBeCloseTo(100, -1);
        expect(tiers[1].outline.rotation.order).toBe(4);
        const axes = rep.plan.massing.mirrors.filter(x => x.score >= SYMMETRY_PARAMS.planGate);
        expect(axes.length).toBe(1);
        expect(near(axes[0].angleDeg, 45, 0.6)).toBe(true);
        expect(rep.plan.massing.rotation.order).toBe(1);
        expect(rep.plan.footprint!.rotation.order).toBe(4);
    }, 300_000);

    it('finds a facade mirror axis, none on a random wall, its twin across the plan axis, and respects the occlusion mask', async () => {
        const orthos = path.join(dir, 'orthos');
        fs.mkdirSync(orthos, { recursive: true });
        // the block: 40 m along x, 20 m along z, 10 m tall (mirror axes at 0 and 90 degrees); facades on its four walls
        const glb = path.join(dir, 'facades.glb');
        roofsGlb(glb, [{ x0: -20, x1: 20, z0: -10, z1: 10, top: 10 }]);
        const sym = (s: number, t: number) => noise(Math.abs(s), t, 7);
        const rnd = (s: number, t: number) => noise(s, t, 11);
        // a 6 x 7 m patch of the right half spoilt (another wall's noise: what stood in front)
        const patch = (s: number, t: number) => s > 2 && s < 8 && t > -2;
        const spoilt = (s: number, t: number) => (patch(s, t) ? noise(s, t, 99) : sym(s, t));
        // east wall (x = 20, facing +x, s running -z) random; west wall (x = -20, facing -x, s running +z) its mirror image
        // through the plane x = 0: the point (20, t, z) of the east wall (s = -z) lands on (-20, t, z) of the west (s = z)
        const facades = [
            facade(orthos, 1, [20, 5, 0], [1, 0, 0], [0, 0, -1], rnd),
            facade(orthos, 2, [-20, 5, 0], [-1, 0, 0], [0, 0, 1], (s, t) => rnd(-s, t)),
            facade(orthos, 3, [0, 5, 10], [0, 0, 1], [1, 0, 0], sym),
            facade(orthos, 4, [0, 5, -10], [0, 0, -1], [-1, 0, 0], spoilt, patch)
        ];
        fs.writeFileSync(path.join(orthos, 'facades.json'), JSON.stringify({ schema: 'test', facades }));
        const rep = await detectSymmetry({ scanGlb: glb, groundY: 0, footprint: [], orthosDir: orthos });
        const f = (id: number) => rep.facades.find(x => x.facadeId === id)!;
        expect(f(3).detected).toBe(true);
        expect(Math.abs(f(3).axisS!)).toBeLessThan(0.25);
        expect(f(3).ncc!).toBeGreaterThan(0.9);
        expect(f(1).detected).toBe(false);
        expect(f(1).ncc!).toBeLessThan(0.4);
        // the spoilt patch masked as occluded: not read, so the mirror stands on the clean texels' pairs
        expect(f(4).detected).toBe(true);
        expect(Math.abs(f(4).axisS!)).toBeLessThan(0.25);
        const twin = rep.twins.find(t => (t.a === 1 && t.b === 2) || (t.a === 2 && t.b === 1));
        expect(twin?.accepted).toBe(true);
        expect(twin!.ncc).toBeGreaterThan(0.9);
        expect(twin!.transform.kind).toBe('mirror');
        expect(rep.twins.filter(t => t.accepted).every(t => [1, 2].includes(t.a) && [1, 2].includes(t.b) || [3, 4].includes(t.a) && [3, 4].includes(t.b))).toBe(true);
        // the same spoilt wall without its mask: the patch is read and the mirror weakens
        const unmasked = { ...facades[3] } as Record<string, unknown>;
        delete unmasked.occludedMask;
        fs.writeFileSync(path.join(orthos, 'facades.json'), JSON.stringify({ schema: 'test', facades: [unmasked] }));
        const rep2 = await detectSymmetry({ scanGlb: glb, groundY: 0, footprint: [], orthosDir: orthos });
        expect(rep2.facades[0].ncc!).toBeLessThan(f(4).ncc! - 0.2);

        // the report into the GLB's extras, on a copy; and the notes line
        const stamped = stampSymmetryGlb(glb, rep);
        expect(stamped).not.toBe(glb);
        const ex = parseGlbBytes(fs.readFileSync(stamped)).json.asset.extras.sbSymmetry;
        expect(ex.facades.find((x: { facadeId: number }) => x.facadeId === 3).detected).toBe(true);
        expect(ex.twins.length).toBe(rep.twins.length);
        expect(parseGlbBytes(fs.readFileSync(glb)).json.asset.extras).toBeUndefined();
        expect(describeSymmetry(rep as SymmetryReport)).toMatch(/twin facade pairs/);
    }, 300_000);
});
