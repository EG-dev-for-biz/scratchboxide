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
import { describeSymmetry, detectSymmetry, mirrorFillOrthos, mirrorWindows, stampSymmetryGlb, SYMMETRY_PARAMS, type SymmetryReport } from '../src/node/3d-engine/staged-location/pipeline-k/symmetry';
import { decodePng } from '../src/node/texture-processing';
import type { WindowFitFile, WindowRect } from '../src/node/3d-engine/staged-location/window-fit';

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
function facade(dir: string, id: number, centroid: number[], normal: number[], axisS: number[], lum: (s: number, t: number) => number, occluded?: (s: number, t: number) => boolean, uncovered?: (s: number, t: number) => boolean) {
    const W = 2 * HALF_W / PIXEL, H = 2 * HALF_H / PIXEL;
    const rgba = new Uint8Array(W * H * 4), occ = new Uint8Array(W * H), unc = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const s = -HALF_W + (x + 0.5) * PIXEL, t = HALF_H - (y + 0.5) * PIXEL, k = y * W + x;
        // a texel the photo never reached is the rectifier's repeat fill: here a flat grey that is not the wall
        const v = uncovered?.(s, t) ? 90 : Math.round(lum(s, t));
        rgba.set([v, v, v, 255], k * 4);
        if (occluded?.(s, t)) occ[k] = 255;
        if (uncovered?.(s, t)) unc[k] = 255;
    }
    fs.writeFileSync(path.join(dir, `facade_${id}.png`), encodePng(W, H, rgba, 4));
    if (occluded) fs.writeFileSync(path.join(dir, `facade_${id}_occluded.png`), encodePng(W, H, occ, 1));
    if (uncovered) fs.writeFileSync(path.join(dir, `facade_${id}_uncovered.png`), encodePng(W, H, unc, 1));
    return {
        facadeId: id, image: `facade_${id}.png`, centroid, normal, axisS, axisT: [0, 1, 0], sMin: -HALF_W, sMax: HALF_W, tMin: -HALF_H, tMax: HALF_H,
        pixel: PIXEL, width: W, height: H, orthoSMin: -HALF_W, orthoTMax: HALF_H, coverage: 1, ...(occluded ? { occludedMask: `facade_${id}_occluded.png` } : {}), ...(uncovered ? { uncoveredMask: `facade_${id}_uncovered.png` } : {})
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
    it('fills unread texels from the mirror only where the photo around them agrees, never writing a read texel; the reader\'s windows fill their unread mirror sites and flag a phase error', async () => {
        const orthos = path.join(dir, 'fill');
        fs.mkdirSync(orthos, { recursive: true });
        const glb = path.join(dir, 'fill.glb');
        roofsGlb(glb, [{ x0: -20, x1: 20, z0: -10, z1: 10, top: 10 }]);
        const sym = (s: number, t: number) => noise(Math.abs(s), t, 7);
        // facade 5: symmetric, a 3 x 3 m patch right of the axis never reached; facade 6: symmetric except a 6.5 x 6.5 m door
        // left of the axis (other noise), with the door's mirror site never reached: the ring there breaks the symmetry
        const hole = (s: number, t: number) => s > 4 && s < 7 && t > -1 && t < 2;
        const door = (s: number, t: number) => s > -8.5 && s < -2 && t > -5 && t < 1.5;
        const doorHole = (s: number, t: number) => s > 3.5 && s < 6.5 && t > -3.5 && t < -0.5;
        const doorWall = (s: number, t: number) => (door(s, t) ? noise(s, t, 55) : sym(s, t));
        const facades = [
            facade(orthos, 5, [0, 5, 10], [0, 0, 1], [1, 0, 0], sym, undefined, hole),
            facade(orthos, 6, [0, 5, -10], [0, 0, -1], [-1, 0, 0], doorWall, undefined, doorHole)
        ];
        fs.writeFileSync(path.join(orthos, 'facades.json'), JSON.stringify({ schema: 'test', facades }));
        const before = decodePng(fs.readFileSync(path.join(orthos, 'facade_5.png')));
        const r = await mirrorFillOrthos(orthos, 'test', { scanGlb: glb, groundY: 0, footprint: [] });
        expect(r.cached).toBe(false);
        const f5 = r.report.fills!.find(x => x.facadeId === 5)!;
        expect(f5.fromMirror).toBeGreaterThan(0.95 * 30 * 30);
        const after = decodePng(fs.readFileSync(path.join(r.orthosDir, 'facade_5.png')));
        const W = after.width;
        let readChanged = 0, filledOff = 0, filled = 0;
        for (let y = 0; y < after.height; y++) for (let x = 0; x < W; x++) {
            const k = y * W + x, s = -HALF_W + (x + 0.5) * PIXEL, t = HALF_H - (y + 0.5) * PIXEL;
            if (!hole(s, t)) { if (after.rgba[k * 4] !== before.rgba[k * 4]) readChanged++; continue; }
            filled++;
            if (Math.abs(after.rgba[k * 4] - Math.round(sym(s, t))) > 3) filledOff++;
        }
        expect(readChanged).toBe(0);
        expect(filledOff / filled).toBeLessThan(0.05);
        const meta = JSON.parse(fs.readFileSync(path.join(r.orthosDir, 'facades.json'), 'utf8')).facades.find((f: { facadeId: number }) => f.facadeId === 5);
        expect(meta.mirrorMask).toBe('facade_5_mirror.png');
        expect(meta.mirrorFill.label).toBe('generated');
        expect(meta.textureFill.method).toMatch(/own mirror/);
        // the door's mirror site: the photo around it disagrees with its image (the door), so it is refused
        const f6 = r.report.fills!.find(x => x.facadeId === 6)!;
        expect(f6.fromMirror).toBe(0);
        expect(f6.regionsRefused).toBeGreaterThan(0);
        // the source folder is untouched, and a second call is served from the keyed clone
        expect(fs.existsSync(path.join(orthos, 'facade_5_mirror.png'))).toBe(false);
        expect((await mirrorFillOrthos(orthos, 'test', { scanGlb: glb, groundY: 0, footprint: [] })).cached).toBe(true);

        // windows on facade 5 (axis at s = 0, x = 100 px): the reader read two windows left of the axis; one mirror site is
        // the unread patch (filled, generated), the other read and holding the fit's box 4 px off (a pair); with four
        // more reader windows whose read mirror sites hold boxes 8 px off, the facade is flagged for a reader phase error
        const px = (s: number) => (s + HALF_W) / PIXEL, py = (t: number) => (HALF_H - t) / PIXEL;
        const win = (s0: number, s1: number, t0: number, t1: number): WindowRect => [px(s0), py(t1), px(s1), py(t0)];
        const readerBoxes: WindowRect[] = [win(-6.5, -4.5, -0.5, 1.5), win(-3, -2, 3, 4), win(-5, -4, 3, 4), win(-7, -6, 3, 4), win(-9, -8, 3, 4)];
        const shifted = (r0: WindowRect, d: number): WindowRect => [2 * 100 - r0[2] + d, r0[1], 2 * 100 - r0[0] + d, r0[3]];
        const structural = [shifted(readerBoxes[1], 8), shifted(readerBoxes[2], 8), shifted(readerBoxes[3], 8), shifted(readerBoxes[4], 8)];
        const fit = { version: 'test', params: {}, ms: 0, facades: [{ facadeId: 5, width: 200, height: 100, rects: [...readerBoxes, ...structural], bands: [], reader: 'test', readerWindows: readerBoxes.length, structural: { rects: structural }, ms: 0 }] } as unknown as WindowFitFile;
        const mw = mirrorWindows(r.orthosDir, fit, r.report);
        const rec = mw.facades.find(x => x.facadeId === 5)!;
        expect(rec.added).toBe(1);
        expect(rec.paired).toBe(4);
        expect(rec.flag?.kind).toBe('phase');
        expect(rec.flag!.offsetM).toBeCloseTo(0.8, 1);
        expect(rec.axisHoldsForWindows).toBe(true);
        const e = fit.facades[0] as { rects: WindowRect[]; generated?: WindowRect[] };
        expect(e.generated!.length).toBe(1);
        expect(e.rects.length).toBe(readerBoxes.length + structural.length + 1);
        // nothing on read photo moved
        for (const b of structural) expect(e.rects.some(x => x.join() === b.join())).toBe(true);
        // where the boxes on the far half hold nothing at the reader's mirror sites, the axis is the texture's, not the
        // windows': nothing is added and nothing flagged
        const fit2 = { version: 'test', params: {}, ms: 0, facades: [{ facadeId: 5, width: 200, height: 100, rects: [...readerBoxes], bands: [], reader: 'test', readerWindows: readerBoxes.length, structural: { rects: [] }, ms: 0 }] } as unknown as WindowFitFile;
        const rec2 = mirrorWindows(r.orthosDir, fit2, r.report).facades[0];
        expect(rec2.axisHoldsForWindows).toBe(false);
        expect(rec2.added).toBe(0);
        expect(rec2.flag).toBeUndefined();
        expect((fit2.facades[0] as { rects: WindowRect[] }).rects.length).toBe(readerBoxes.length);
    }, 300_000);
});
